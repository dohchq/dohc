import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type {
  AgentDispatchClaim,
  AgentRunRecord,
  ChatChannelKind,
  ChatMessage,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import type { RunnerSettings } from "../settings/userSettings";
import {
  killChildTreeWin32,
  resolveSpawnCommand,
} from "../process/windowsSpawn";
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AgentDispatchRequestOptions,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";
import { buildRunnerThreadContext } from "./runnerThreadContext";

export const CHAT_DISPATCH_PUMP_MS = 15_000;
export const CHAT_DISPATCH_BUDGET_WINDOW_MS = 10 * 60_000;
export const CHAT_DISPATCH_BUDGET_MAX = 10;
export const RUNNER_SELF_TEST_TIMEOUT_MS = 120_000;
export const RUNNER_KILL_GRACE_MS = 10_000;
export const APP_QUIT_KILL_GRACE_MS = 1_500;
export const CHAT_DISPATCH_RECOVERY_BACKOFF_MS = 1_000;
export const CHAT_DISPATCH_RECOVERY_MAX_BACKOFF_MS = 30_000;
export const RUN_ID_LOG_TOKEN = "{runId}";
export const APP_QUIT_EXIT_CODE = 143;

export const NO_RUNNER_NOTE =
  "No agent runner is configured — set one up in Settings → Agents & MCP to dispatch this.";

const PRESENCE_HEARTBEAT_MS = 10_000;
const SELF_TEST_POLL_MS = 250;
const SELF_TEST_THREAD_TITLE = "dohc runner self-test";
const SELF_TEST_SCRATCH_BODY =
  "Reserved runner self-test thread. Agent-authored messages here never trigger dispatch.";

export interface ChatDispatchWorkspace {
  workspaceId: string;
  rootPath: string;
}

export interface ChatDispatchIdentity {
  displayName: string;
  verifiedUserId?: string;
}

export interface RunnerProcess {
  readonly pid: number | undefined;
  readonly rawChild?: ChildProcess;
  // Deliver the prompt. It rides stdin rather than argv because it carries
  // the rendered thread — unbounded in length and content — and a cmd.exe
  // command line can carry neither (~8191 characters, and no safe
  // representation for a double quote).
  writeStdin(text: string): void;
  hasExited(): boolean;
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface RunnerSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: true;
  stdio: ["pipe", number, number];
  windowsHide: true;
  windowsVerbatimArguments?: boolean;
}

export type SpawnRunner = (
  command: string,
  args: string[],
  options: RunnerSpawnOptions,
) => RunnerProcess;

export interface ChatDispatchPresenceInput {
  workspaceId: string;
  threadId: string;
  clientId: string;
  state?: {
    displayName: string;
    agent: true;
    activity: "working" | "idle";
  };
  leave?: true;
}

export interface ChatDispatchRecovery {
  run: AgentRunRecord;
  attemptCount: number;
}

export interface ChatDispatchServiceOptions {
  workspaceFor(workspaceId: string): ChatDispatchWorkspace | null;
  listOpenWorkspaces(): ChatDispatchWorkspace[];
  listSyncWorkspaces(): ChatDispatchWorkspace[];
  chatStoreFor(workspace: ChatDispatchWorkspace): LinkedChatStore;
  dispatchStoreFor(
    workspace: ChatDispatchWorkspace,
  ): AwaitableAgentDispatchStore;
  readRunnerSettings(): Promise<RunnerSettings>;
  identityFor(
    workspaceId: string,
    target?: { channelId: string } | { threadId: string },
  ): Promise<ChatDispatchIdentity>;
  stateDir(): string;
  appRoot(): string;
  isPackaged(): boolean;
  resourcesPath?: () => string | undefined;
  queueSync(workspaceId: string): void | boolean | Promise<void | boolean>;
  // The engine opt-out gate: when it resolves false, a scan is a no-op.
  // Merely resolving the chat/dispatch stores opens the workspace in the
  // engine daemon, which would create an engine store for a workspace that
  // opted out of recording anything.
  scanEligible?(
    workspace: ChatDispatchWorkspace,
  ): boolean | Promise<boolean>;
  prepareRunWorkspace?(
    workspace: ChatDispatchWorkspace,
  ): Promise<void | (() => Promise<void>)>;
  authorizeServiceNote(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    verifiedUserId: string | undefined,
  ): Promise<boolean>;
  // The thread names the chat target, so a shared-channel push can cover the
  // channel this message landed in instead of waiting for the sync rotation.
  onMessagePosted(workspaceId: string, threadId: string): void;
  onRunUpdated?(workspaceId: string): void;
  setRunAttribution(
    workspaceId: string,
    run: { agentId: string; onBehalfOf: string; agentRunId: string } | null,
  ): void | Promise<void>;
  runSlotOccupied?(workspaceId: string): boolean;
  publishPresence?(input: ChatDispatchPresenceInput): Promise<void>;
  requeueFailedTrigger?(input: {
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  }): boolean | Promise<boolean>;
  hasPendingRunMessageLink?(workspaceId: string, runId: string): boolean;
  listAppQuitRecoveries?(
    workspaceId: string,
  ): ChatDispatchRecovery[] | Promise<ChatDispatchRecovery[]>;
  spawnRunner?: SpawnRunner;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
  nowMs?: () => number;
  createId?: () => string;
  onError?: (error: unknown) => void;
}

export interface ChatDispatchThreadState {
  liveRun: boolean;
  pendingCount: number;
  paused: boolean;
  pausedReason?: string;
}

interface LiveRun {
  workspace: ChatDispatchWorkspace;
  claim: AgentDispatchClaim;
  child: RunnerProcess;
  logPath: string;
  timeoutMinutes: number;
  timeout: ReturnType<typeof setTimeout>;
  presenceHeartbeat: ReturnType<typeof setInterval> | null;
  killEscalation: ReturnType<typeof setTimeout> | null;
  releaseWorkspace: (() => Promise<void>) | null;
  finalized: boolean;
  terminalIntent:
    | { kind: "complete"; exitCode: number }
    | { kind: "fail"; exitCode?: number; reason: string }
    | null;
  terminalDurable: boolean;
}

interface SpawnedRun {
  child: RunnerProcess;
  logPath: string;
}

interface PendingPreRunFailure {
  workspace: ChatDispatchWorkspace;
  claim: AgentDispatchClaim;
  reason: string;
  releaseWorkspace: (() => Promise<void>) | null;
}

interface PendingInterruptedRequeue {
  workspace: ChatDispatchWorkspace;
  input: {
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  };
}

interface SelfTestState {
  workspaceId: string;
  child: RunnerProcess;
  threadId: string;
  runId: string;
  settled: boolean;
  poll: ReturnType<typeof setTimeout> | null;
  timeout: ReturnType<typeof setTimeout>;
  killEscalation: ReturnType<typeof setTimeout> | null;
  resolve(result: { ok: boolean; detail: string }): void;
}

function defaultSpawnRunner(
  command: string,
  args: string[],
  options: RunnerSpawnOptions,
): RunnerProcess {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: options.windowsHide,
    ...(options.windowsVerbatimArguments
      ? { windowsVerbatimArguments: true }
      : {}),
  };
  const child = spawn(command, args, spawnOptions);
  return {
    get pid() {
      return child.pid;
    },
    rawChild: child,
    writeStdin: (text) => {
      // A runner that exits before reading its prompt breaks this pipe. That
      // is the runner's outcome, reported through its exit code and log, not
      // a dispatch-time crash.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text);
    },
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onError: (listener) => {
      child.once("error", listener);
    },
  };
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}

function runnerDisplayName(displayName: string): string {
  return `${displayName}'s agent`;
}

function appendPathPrefix(prefix: string, current: string | undefined): string {
  return current ? `${prefix}${delimiter}${current}` : prefix;
}

export function resolveDohcCliBinDirectory(input: {
  appRoot: string;
  isPackaged: boolean;
  resourcesPath?: string;
}): string {
  if (!input.isPackaged) {
    return resolve(input.appRoot, "node_modules", ".bin");
  }
  return resolve(input.resourcesPath ?? dirname(process.execPath), "cli-bin");
}

/** True when this process is genuinely running from inside an AppImage's
 * own mount -- electron-builder's AppImage target exports this at a real,
 * non-empty path. Some launchers otherwise inherit an EMPTY APPIMAGE from
 * a parent process, which must not be mistaken for one -- boot's
 * stable-copy refresh and this file's command resolver must agree on the
 * same test, or a packaged, non-AppImage install with an empty APPIMAGE in
 * its environment gets treated as an AppImage with no stable copy, and MCP
 * becomes wrongly unavailable even though its ordinary resources/cli-bin
 * is perfectly stable. */
export function isAppImageBoot(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.APPIMAGE);
}

/**
 * The dohc-mcp command a chat session config points the user's AI tool at.
 *
 * A packaged install ships the launcher in its cli-bin extraResource
 * (build-cli-bin.mjs stages it; scripts/package-smoke.mjs asserts it), so
 * the resolved command is that file's absolute path -- a bare `dohc-mcp`
 * exists on no user's PATH. Dev keeps the bare name: the workspace's
 * node_modules/.bin provides it. DOHC_MCP_COMMAND stays the explicit
 * override either way.
 *
 * A packaged Linux AppImage returns null when its persistent cli-bin copy
 * is unavailable. The caller must not write a command in that case: the
 * fallback resources path is inside the AppImage's temporary FUSE mount and
 * must never reach a config file or a spawned process's environment.
 */
export function resolveDohcMcpCommand(input: {
  isPackaged: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  linuxStableCliBinDir?: string;
}): string | null {
  const env = input.env ?? process.env;
  const override = env.DOHC_MCP_COMMAND?.trim();
  if (override) return override;
  if (!input.isPackaged) return "dohc-mcp";
  const platform = input.platform ?? process.platform;
  let cliBinDir: string;
  if (platform === "linux" && isAppImageBoot(env)) {
    if (!input.linuxStableCliBinDir) return null;
    cliBinDir = input.linuxStableCliBinDir;
  } else {
    cliBinDir = resolve(input.resourcesPath ?? dirname(process.execPath), "cli-bin");
  }
  return join(
    cliBinDir,
    platform === "win32" ? "dohc-mcp.cmd" : "dohc-mcp",
  );
}

/**
 * The plugin host's own env, layered onto the ambient process env: the
 * resolved dohc-mcp command when one exists, or an explicit "unavailable"
 * marker when it doesn't -- never both, and never a stale leftover of
 * whichever one applied on a previous call (a workspace's plugin host can
 * respawn after this install's launcher availability changes, e.g. once a
 * boot's stable-copy refresh finally succeeds).
 */
export function pluginHostEnvFor(
  dohcMcpCommand: string | null,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (dohcMcpCommand === null) {
    delete env.DOHC_MCP_COMMAND;
    env.DOHC_MCP_COMMAND_UNAVAILABLE = "1";
  } else {
    env.DOHC_MCP_COMMAND = dohcMcpCommand;
    delete env.DOHC_MCP_COMMAND_UNAVAILABLE;
  }
  return env;
}

export function tokenizeRunnerCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inDoubleQuotes = false;
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === '"' || next === "\\") {
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    if (/\s/u.test(character) && !inDoubleQuotes) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (inDoubleQuotes) {
    throw new Error("Runner command has an unterminated double quote.");
  }
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error("Configure a runner command before dispatching.");
  }
  return tokens;
}

export function buildRunnerPrompt(threadMarkdown: string, threadId: string): string {
  return `${threadMarkdown.trimEnd()}

## Report contract

Work on the request represented by this thread. Reply in-thread with \`dohc chat reply ${threadId} --as-agent "<report>"\`. Report outcomes, not tool logs. On long tasks, post progress the way a teammate would. If blocked on the user, reply with \`--needs-decision\`. Your final text is not shown anywhere; only messages you post through \`dohc chat\` are shown.`;
}

export function messageCanTrigger(
  message: ChatMessage,
  verifiedUserId: string | undefined,
  context: {
    channelKind: ChatChannelKind | undefined;
    mentionsAgent: boolean;
  },
): boolean {
  if (context.channelKind !== "agent" && !context.mentionsAgent) return false;
  if (message.author.kind !== "human" || message.origin === "cli") return false;
  if (message.authorUserId === undefined) return true;
  return verifiedUserId !== undefined && message.authorUserId === verifiedUserId;
}

export function createChatDispatchService(options: ChatDispatchServiceOptions) {
  const nowMs = options.nowMs ?? (() => Date.now());
  const createId = options.createId ?? randomUUID;
  const spawnRunner = options.spawnRunner ?? defaultSpawnRunner;
  const platform = options.platform ?? process.platform;
  const liveRuns = new Map<string, LiveRun>();
  const runReservations = new Set<string>();
  const selfTests = new Map<string, SelfTestState>();
  const selfTestReservations = new Set<string>();
  const budgetBypassThreads = new Set<string>();
  const workspaceChains = new Map<string, Promise<void>>();
  const sweptWorkspaces = new Set<string>();
  const recoveryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const recoveryAttempts = new Map<string, number>();
  const pendingNoReplyChecks = new Map<
    string,
    { workspace: ChatDispatchWorkspace; run: AgentRunRecord }
  >();
  const pendingPreRunFailures = new Map<string, PendingPreRunFailure>();
  const pendingInterruptedRequeues = new Map<
    string,
    PendingInterruptedRequeue
  >();
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let pumpInFlight: Promise<void> | null = null;
  let started = false;
  let stopped = true;
  let shuttingDown = false;
  let paused = false;
  const durableDispatchRequest: AgentDispatchRequestOptions = {
    deadlineMs: AGENT_DISPATCH_RPC_DEADLINE_MS,
    retryTransportErrors: true,
  };

  function reportError(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {}
  }

  function notifyRunUpdated(workspaceId: string): void {
    try {
      options.onRunUpdated?.(workspaceId);
    } catch (error) {
      reportError(error);
    }
  }

  function enqueue(workspaceId: string, task: () => Promise<void>): Promise<void> {
    const prior = workspaceChains.get(workspaceId) ?? Promise.resolve();
    const run = prior.then(task, task);
    workspaceChains.set(
      workspaceId,
      run.catch((error: unknown) => {
        reportError(error);
      }),
    );
    return run;
  }

  function runKey(workspaceId: string, runId: string): string {
    return `${workspaceId}\u0000${runId}`;
  }

  function scheduleRecoveryScan(workspaceId: string): void {
    if (stopped || recoveryTimers.has(workspaceId)) return;
    const attempt = (recoveryAttempts.get(workspaceId) ?? 0) + 1;
    recoveryAttempts.set(workspaceId, attempt);
    const delay = Math.min(
      CHAT_DISPATCH_RECOVERY_BACKOFF_MS * 2 ** (attempt - 1),
      CHAT_DISPATCH_RECOVERY_MAX_BACKOFF_MS,
    );
    const timer = setTimeout(() => {
      recoveryTimers.delete(workspaceId);
      if (stopped) return;
      void scanWorkspace(workspaceId).then(
        () => {
          if (!recoveryTimers.has(workspaceId)) {
            recoveryAttempts.delete(workspaceId);
          }
        },
        (error: unknown) => {
          reportError(error);
          scheduleRecoveryScan(workspaceId);
        },
      );
    }, delay);
    recoveryTimers.set(workspaceId, timer);
  }

  function threadKey(workspaceId: string, threadId: string): string {
    return `${workspaceId}\u0000${threadId}`;
  }

  function runMessageLinkPending(workspaceId: string, runId: string): boolean {
    return options.hasPendingRunMessageLink?.(workspaceId, runId) === true;
  }

  function workspaceProcessReserved(workspaceId: string): boolean {
    return (
      liveRuns.has(workspaceId) ||
      pendingPreRunFailures.has(workspaceId) ||
      runReservations.has(workspaceId) ||
      selfTests.has(workspaceId) ||
      selfTestReservations.has(workspaceId) ||
      options.runSlotOccupied?.(workspaceId) === true
    );
  }

  async function presence(input: ChatDispatchPresenceInput): Promise<void> {
    try {
      await options.publishPresence?.(input);
    } catch {
      // Presence is cosmetic. The dispatch ledger and failure notes carry truth.
    }
  }

  function workingPresenceInput(
    workspaceId: string,
    threadId: string,
    displayName: string,
  ): ChatDispatchPresenceInput {
    return {
      workspaceId,
      threadId,
      clientId: `agent:${workspaceId}`,
      state: {
        displayName: runnerDisplayName(displayName),
        agent: true,
        activity: "working",
      },
    };
  }

  function finishPresence(live: LiveRun): void {
    if (live.presenceHeartbeat) clearInterval(live.presenceHeartbeat);
    live.presenceHeartbeat = null;
    void options
      .identityFor(live.workspace.workspaceId)
      .then(async (identity) => {
        const base = {
          workspaceId: live.workspace.workspaceId,
          threadId: live.claim.run.threadId,
          clientId: `agent:${live.workspace.workspaceId}`,
        };
        await presence({
          ...base,
          state: {
            displayName: runnerDisplayName(identity.displayName),
            agent: true,
            activity: "idle",
          },
        });
        await presence({ ...base, leave: true });
      })
      .catch(() => undefined);
  }

  function actualLogPath(runId: string, storedPath?: string): string {
    const expected = join(options.stateDir(), "run-logs", `${runId}.log`);
    if (!storedPath) return expected;
    return storedPath.replaceAll(RUN_ID_LOG_TOKEN, runId);
  }

  function logPathTemplate(): string {
    return join(options.stateDir(), "run-logs", `${RUN_ID_LOG_TOKEN}.log`);
  }

  function prepareLog(logPath: string): number {
    const directory = dirname(logPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const fd = openSync(logPath, "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  function runnerEnvironment(input: {
    workspaceId: string;
    threadId: string;
    runId: string;
  }): NodeJS.ProcessEnv {
    const cliBin = resolveDohcCliBinDirectory({
      appRoot: options.appRoot(),
      isPackaged: options.isPackaged(),
      resourcesPath: options.resourcesPath?.(),
    });
    return {
      ...process.env,
      DOHC_CHAT_THREAD: input.threadId,
      DOHC_CHAT_ACTOR: "agent",
      DOHC_RUN_ID: input.runId,
      DOHC_STATE_DIR: options.stateDir(),
      PATH: appendPathPrefix(cliBin, process.env.PATH),
      ...(process.env.Path
        ? { Path: appendPathPrefix(cliBin, process.env.Path) }
        : {}),
    };
  }

  function spawnConfiguredRunner(input: {
    workspace: ChatDispatchWorkspace;
    threadId: string;
    runId: string;
    logPath: string;
    command: string;
    prompt: string;
  }): SpawnedRun {
    const commandParts = tokenizeRunnerCommand(input.command);
    const executable = commandParts[0]!;
    // The prompt is DATA and rides stdin, never argv. It carries the rendered
    // thread, so it is unbounded in both length and content, and a command
    // line can carry neither safely:
    //   - Length. A .cmd/.bat runner (the npm -g layout on Windows) must run
    //     behind cmd.exe, which hard-fails past ~8191 characters with "The
    //     command line is too long." Any thread of real size exceeds that, so
    //     no amount of quoting would have made argv work.
    //   - Content. quoteForCmd refuses a double quote outright, and the
    //     dispatch prompt always contains one (`--as-agent "<report>"`), so
    //     every dispatch through a shimmed runner threw before it spawned.
    // stdin has neither limit and needs no escaping at all.
    const args = commandParts.slice(1);
    const env = runnerEnvironment({
      workspaceId: input.workspace.workspaceId,
      threadId: input.threadId,
      runId: input.runId,
    });
    const logFd = prepareLog(input.logPath);
    try {
      // Inside the try: resolveSpawnCommand REFUSES some runner commands
      // (a double quote or percent sign in the configured command itself),
      // and it used to sit outside, so its throw escaped the spawn path
      // entirely instead of failing this one dispatch.
      const resolved = resolveSpawnCommand(executable, args, {
        env,
        cwd: input.workspace.rootPath,
      });
      const child = spawnRunner(resolved.command, resolved.args, {
        cwd: input.workspace.rootPath,
        env,
        detached: true,
        stdio: ["pipe", logFd, logFd],
        windowsHide: true,
        ...(resolved.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      });
      child.writeStdin(input.prompt);
      return { child, logPath: input.logPath };
    } finally {
      closeSync(logFd);
    }
  }

  async function sendAgentMessage(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    body: string,
    runId?: string,
    dispatchRequest?: AgentDispatchRequestOptions,
  ): Promise<string | null> {
    const identity = await options.identityFor(workspace.workspaceId, { threadId });
    if (
      !(await options.authorizeServiceNote(
        workspace,
        threadId,
        identity.verifiedUserId,
      ))
    ) {
      reportError(
        new Error(
          `Skipped an agent service note that cannot be shared from thread ${threadId}.`,
        ),
      );
      return null;
    }
    const message = await options.chatStoreFor(workspace).sendMessage({
      workspaceId: workspace.workspaceId,
      threadId,
      author: {
        kind: "agent",
        displayName: identity.displayName,
      },
      ...(identity.verifiedUserId
        ? { authorUserId: identity.verifiedUserId }
        : {}),
      body,
    });
    if (runId) {
      try {
        await options.dispatchStoreFor(workspace).recordRunMessage(
          {
            workspaceId: workspace.workspaceId,
            messageId: message.id,
            runId,
          },
          dispatchRequest,
        );
      } catch {
        // The report itself is authoritative; a provenance chip is optional.
      }
    }
    options.onMessagePosted(workspace.workspaceId, threadId);
    return message.id;
  }

  async function agentNoteAlreadyExists(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    body: string,
  ): Promise<boolean> {
    const messages = await options.chatStoreFor(workspace).listMessages({
      workspaceId: workspace.workspaceId,
      threadId,
    });
    return messages.some(
      (message) => message.author.kind === "agent" && message.body === body,
    );
  }

  async function postFailureNote(
    workspace: ChatDispatchWorkspace,
    run: AgentRunRecord,
    body: string,
  ): Promise<void> {
    const dispatch = options.dispatchStoreFor(workspace);
    const current = await dispatch.getRunRecord(
      run.runId,
      durableDispatchRequest,
    );
    if (current?.failureNotePosted) return;
    if (!(await agentNoteAlreadyExists(workspace, run.threadId, body))) {
      await sendAgentMessage(
        workspace,
        run.threadId,
        body,
        run.runId,
        durableDispatchRequest,
      );
    }
    await dispatch.markFailureNotePosted(run.runId, durableDispatchRequest);
  }

  async function mostRecentAgentNoteIs(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    body: string,
  ): Promise<boolean> {
    const messages = await options.chatStoreFor(workspace).listMessages({
      workspaceId: workspace.workspaceId,
      threadId,
    });
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.author.kind === "agent") return message.body === body;
    }
    return false;
  }

  function signalOwnedProcess(
    processHandle: RunnerProcess,
    signal: NodeJS.Signals,
  ): void {
    if (processHandle.hasExited() || !validPid(processHandle.pid)) return;
    if (platform === "win32" && processHandle.rawChild) {
      void killChildTreeWin32(processHandle.rawChild).catch(() => undefined);
      return;
    }
    try {
      (options.killProcessGroup ?? ((pid, nextSignal) => process.kill(pid, nextSignal)))(
        -processHandle.pid,
        signal,
      );
    } catch (error) {
      reportError(error);
    }
  }

  function terminateWithEscalation(
    processHandle: RunnerProcess,
    existing: ReturnType<typeof setTimeout> | null,
  ): ReturnType<typeof setTimeout> | null {
    if (existing || processHandle.hasExited()) return existing;
    signalOwnedProcess(processHandle, "SIGTERM");
    return setTimeout(() => {
      if (!processHandle.hasExited()) signalOwnedProcess(processHandle, "SIGKILL");
    }, RUNNER_KILL_GRACE_MS);
  }

  function terminateForAppQuit(processHandle: RunnerProcess): Promise<void> {
    if (processHandle.hasExited()) return Promise.resolve();
    signalOwnedProcess(processHandle, "SIGTERM");
    return new Promise<void>((resolveTermination) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(escalation);
        resolveTermination();
      };
      const escalation = setTimeout(() => {
        if (!processHandle.hasExited()) {
          signalOwnedProcess(processHandle, "SIGKILL");
        }
        finish();
      }, APP_QUIT_KILL_GRACE_MS);
      processHandle.onExit(() => finish());
    });
  }

  async function clearLiveAttribution(live: LiveRun): Promise<void> {
    await options.setRunAttribution(live.workspace.workspaceId, null);
    finishPresence(live);
  }

  async function releaseWorkspaceLease(
    release: (() => Promise<void>) | null,
  ): Promise<void> {
    if (!release) return;
    try {
      await release();
    } catch (error) {
      reportError(error);
    }
  }

  async function releaseLiveWorkspace(live: LiveRun): Promise<void> {
    const release = live.releaseWorkspace;
    live.releaseWorkspace = null;
    await releaseWorkspaceLease(release);
  }

  async function finishLiveRun(
    live: LiveRun,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<boolean> {
    if (stopped || liveRuns.get(live.workspace.workspaceId) !== live) {
      return false;
    }
    if (!live.finalized) {
      live.finalized = true;
      clearTimeout(live.timeout);
      if (live.killEscalation) clearTimeout(live.killEscalation);
      live.killEscalation = null;
      live.terminalIntent = {
        kind: "complete",
        exitCode: exitCode ?? signalExitCode(signal),
      };
    }
    const intent = live.terminalIntent;
    if (!intent) return false;
    const dispatch = options.dispatchStoreFor(live.workspace);
    if (!live.terminalDurable) {
      let linkedMessages: string[] | null = null;
      if (intent.kind === "complete") {
        try {
          linkedMessages = await dispatch.listRunMessages(
            live.workspace.workspaceId,
            live.claim.run.runId,
            durableDispatchRequest,
          );
        } catch (error) {
          reportError(error);
          if (intent.exitCode === 0) {
            pendingNoReplyChecks.set(
              runKey(live.workspace.workspaceId, live.claim.run.runId),
              { workspace: live.workspace, run: live.claim.run },
            );
            scheduleRecoveryScan(live.workspace.workspaceId);
          }
        }
        if (intent.exitCode !== 0) {
          await postFailureNote(
            live.workspace,
            live.claim.run,
            `⚠ Agent run failed (exit ${intent.exitCode}). Open the run chip for details.`,
          ).catch(reportError);
        } else if (linkedMessages?.length === 0) {
          if (
            runMessageLinkPending(
              live.workspace.workspaceId,
              live.claim.run.runId,
            )
          ) {
            pendingNoReplyChecks.set(
              runKey(live.workspace.workspaceId, live.claim.run.runId),
              { workspace: live.workspace, run: live.claim.run },
            );
            scheduleRecoveryScan(live.workspace.workspaceId);
          } else {
            await postFailureNote(
              live.workspace,
              live.claim.run,
              "⚠ Agent run produced no reply. Open the run chip for details.",
            ).catch(reportError);
          }
        }
      }
      try {
        if (intent.kind === "complete") {
          await dispatch.completeRun({
            runId: live.claim.run.runId,
            exitCode: intent.exitCode,
          });
        } else {
          await dispatch.failRun({
            runId: live.claim.run.runId,
            ...(intent.exitCode !== undefined
              ? { exitCode: intent.exitCode }
              : {}),
            reason: intent.reason,
          });
        }
        live.terminalDurable = true;
        notifyRunUpdated(live.workspace.workspaceId);
      } catch (error) {
        reportError(error);
        scheduleRecoveryScan(live.workspace.workspaceId);
        return false;
      }
    }
    if (!live.child.hasExited()) return false;
    await clearLiveAttribution(live);
    liveRuns.delete(live.workspace.workspaceId);
    await releaseLiveWorkspace(live);
    return true;
  }

  async function timeOutLiveRun(live: LiveRun): Promise<void> {
    if (live.finalized) return;
    live.finalized = true;
    live.terminalIntent = {
      kind: "fail",
      exitCode: 124,
      reason: `timed out after ${live.timeoutMinutes}m`,
    };
    live.killEscalation = terminateWithEscalation(
      live.child,
      live.killEscalation,
    );
    const dispatch = options.dispatchStoreFor(live.workspace);
    await postFailureNote(
      live.workspace,
      live.claim.run,
      `⚠ Agent run produced no reply (timed out after ${live.timeoutMinutes}m). Open the run chip for details.`,
    ).catch(reportError);
    try {
      await dispatch.failRun({
        runId: live.claim.run.runId,
        exitCode: 124,
        reason: `timed out after ${live.timeoutMinutes}m`,
      });
      live.terminalDurable = true;
      notifyRunUpdated(live.workspace.workspaceId);
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(live.workspace.workspaceId);
    }
  }

  async function failClaimBeforeRun(
    workspace: ChatDispatchWorkspace,
    claim: AgentDispatchClaim,
    reason: string,
  ): Promise<void> {
    // A daemon restart can reject attribution teardown after the claim has
    // reserved this workspace but before a child exists. Retry once, then
    // finish the failed claim even if capture remains unavailable: the next
    // run overwrites attribution before it can spawn, while retaining the
    // in-memory reservation would deadlock dispatch until app quit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.setRunAttribution(workspace.workspaceId, null);
        break;
      } catch (error) {
        reportError(error);
      }
    }
    await postFailureNote(
      workspace,
      claim.run,
      "⚠ Agent run failed to start. Open the run chip for details.",
    ).catch(reportError);
    await options.dispatchStoreFor(workspace).failRun({
      runId: claim.run.runId,
      reason,
    });
    notifyRunUpdated(workspace.workspaceId);
  }

  async function recoverPreRunFailure(
    recovery: PendingPreRunFailure,
  ): Promise<boolean> {
    try {
      await options.dispatchStoreFor(recovery.workspace).failRun({
        runId: recovery.claim.run.runId,
        reason: recovery.reason,
      });
      if (
        pendingPreRunFailures.get(recovery.workspace.workspaceId) === recovery
      ) {
        pendingPreRunFailures.delete(recovery.workspace.workspaceId);
      }
      notifyRunUpdated(recovery.workspace.workspaceId);
      await releaseWorkspaceLease(recovery.releaseWorkspace);
      recovery.releaseWorkspace = null;
      return true;
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(recovery.workspace.workspaceId);
      return false;
    }
  }

  async function startClaim(
    workspace: ChatDispatchWorkspace,
    claim: AgentDispatchClaim,
    runner: RunnerSettings,
    releaseWorkspace: (() => Promise<void>) | null,
  ): Promise<void> {
    const dispatch = options.dispatchStoreFor(workspace);
    const logPath = actualLogPath(claim.run.runId, claim.run.logPath);
    runReservations.add(workspace.workspaceId);
    try {
      const identity = await options.identityFor(workspace.workspaceId);
      await options.setRunAttribution(workspace.workspaceId, {
        agentId: "dohc-chat-runner",
        onBehalfOf: "local",
        agentRunId: claim.run.runId,
      });
      const markdown = await buildRunnerThreadContext({
        store: options.chatStoreFor(workspace),
        workspaceId: workspace.workspaceId,
        threadId: claim.run.threadId,
      });
      if (stopped) {
        throw new Error("dohc is quitting before the runner can start.");
      }
      const spawned = spawnConfiguredRunner({
        workspace,
        threadId: claim.run.threadId,
        runId: claim.run.runId,
        logPath,
        command: runner.command.trim(),
        prompt: buildRunnerPrompt(markdown, claim.run.threadId),
      });
      const timeout = setTimeout(() => {
        void enqueue(workspace.workspaceId, () => timeOutLiveRun(live));
      }, runner.timeoutMinutes * 60_000);
      const live: LiveRun = {
        workspace,
        claim,
        child: spawned.child,
        logPath: spawned.logPath,
        timeoutMinutes: runner.timeoutMinutes,
        timeout,
        presenceHeartbeat: null,
        killEscalation: null,
        releaseWorkspace,
        finalized: false,
        terminalIntent: null,
        terminalDurable: false,
      };
      liveRuns.set(workspace.workspaceId, live);
      runReservations.delete(workspace.workspaceId);
      spawned.child.onExit((code, signal) => {
        void enqueue(workspace.workspaceId, async () => {
          if (await finishLiveRun(live, code, signal)) {
            await scanAndDrain(live.workspace);
          }
        });
      });
      spawned.child.onError((error) => {
        reportError(error);
        void enqueue(workspace.workspaceId, async () => {
          if (await finishLiveRun(live, 1, null)) {
            await scanAndDrain(live.workspace);
          }
        });
      });
      notifyRunUpdated(workspace.workspaceId);
      const publishWorking = () =>
        presence(
          workingPresenceInput(
            workspace.workspaceId,
            claim.run.threadId,
            identity.displayName,
          ),
        );
      void publishWorking();
      live.presenceHeartbeat = setInterval(() => {
        void publishWorking();
      }, PRESENCE_HEARTBEAT_MS);
    } catch (error) {
      runReservations.delete(workspace.workspaceId);
      reportError(error);
      const detail =
        error instanceof Error && error.message ? error.message : "unknown error";
      const reason = `runner failed to start: ${detail}`;
      try {
        await failClaimBeforeRun(workspace, claim, reason);
        await releaseWorkspaceLease(releaseWorkspace);
      } catch (persistenceError) {
        reportError(persistenceError);
        pendingPreRunFailures.set(workspace.workspaceId, {
          workspace,
          claim,
          reason,
          releaseWorkspace,
        });
        scheduleRecoveryScan(workspace.workspaceId);
        return;
      }
      if ((await dispatch.openRuns(workspace.workspaceId)).length === 0) {
        await scanAndDrain(workspace);
      }
    }
  }

  async function drain(workspace: ChatDispatchWorkspace): Promise<void> {
    if (
      stopped ||
      paused ||
      workspaceProcessReserved(workspace.workspaceId)
    ) {
      return;
    }
    const runner = await options.readRunnerSettings();
    const command = runner.command.trim();
    const dispatch = options.dispatchStoreFor(workspace);
    if (!runner.enabled || !command) {
      const threadIds = new Set(
        (await dispatch.listPending(workspace.workspaceId))
          .map((pending) => pending.threadId),
      );
      for (const threadId of threadIds) {
        const failedCount = await dispatch.failPendingForThread({
          workspaceId: workspace.workspaceId,
          threadId,
          reason: "no-runner",
        });
        if (failedCount > 0) notifyRunUpdated(workspace.workspaceId);
        if (
          failedCount === 0 ||
          (await mostRecentAgentNoteIs(workspace, threadId, NO_RUNNER_NOTE))
        ) {
          continue;
        }
        try {
          await sendAgentMessage(workspace, threadId, NO_RUNNER_NOTE);
        } catch (error) {
          reportError(error);
        }
      }
      return;
    }
    if (stopped || paused || workspaceProcessReserved(workspace.workspaceId)) {
      return;
    }
    if (dispatch.resolveUncertainClaim) {
      runReservations.add(workspace.workspaceId);
      let uncertainClaim: AgentDispatchClaim | null;
      try {
        uncertainClaim = await dispatch.resolveUncertainClaim(
          workspace.workspaceId,
          {
            command,
            logPath: logPathTemplate(),
          },
        );
      } catch (error) {
        runReservations.delete(workspace.workspaceId);
        throw error;
      }
      if (uncertainClaim) {
        const bypassKey = threadKey(
          workspace.workspaceId,
          uncertainClaim.run.threadId,
        );
        const bypassBudget = budgetBypassThreads.delete(bypassKey);
        let releaseWorkspace: (() => Promise<void>) | null;
        try {
          releaseWorkspace =
            (await options.prepareRunWorkspace?.(workspace)) ?? null;
        } catch (error) {
          runReservations.delete(workspace.workspaceId);
          if (bypassBudget) budgetBypassThreads.add(bypassKey);
          throw error;
        }
        await startClaim(workspace, uncertainClaim, runner, releaseWorkspace);
        return;
      }
      runReservations.delete(workspace.workspaceId);
    }
    const pending = await dispatch.listPending(workspace.workspaceId);
    const pauseStates = new Map(
      await Promise.all(
        [...new Set(pending.map(({ threadId }) => threadId))].map(
          async (threadId) =>
            [
              threadId,
              await dispatch.getThreadDispatchPauseState(
                workspace.workspaceId,
                threadId,
              ),
            ] as const,
        ),
      ),
    );
    for (const candidate of pending) {
      if (pauseStates.get(candidate.threadId)?.paused === true) {
        continue;
      }
      const bypassKey = threadKey(workspace.workspaceId, candidate.threadId);
      const bypassBudget = budgetBypassThreads.delete(bypassKey);
      if (
        !bypassBudget &&
        (await dispatch.recentDispatchCount({
          workspaceId: workspace.workspaceId,
          threadId: candidate.threadId,
          sinceMs: nowMs() - CHAT_DISPATCH_BUDGET_WINDOW_MS,
        })) >= CHAT_DISPATCH_BUDGET_MAX
      ) {
        await dispatch.setThreadDispatchPaused({
          workspaceId: workspace.workspaceId,
          threadId: candidate.threadId,
          paused: true,
          reason: "re-dispatch budget exceeded",
        });
        notifyRunUpdated(workspace.workspaceId);
        try {
          await sendAgentMessage(
            workspace,
            candidate.threadId,
            "⏸ Agent dispatch paused for this thread (budget exceeded). Use Resume in this thread to continue.",
          );
        } catch (error) {
          await dispatch.setThreadDispatchPaused({
            workspaceId: workspace.workspaceId,
            threadId: candidate.threadId,
            paused: false,
          });
          throw error;
        }
        continue;
      }
      if (stopped || paused || workspaceProcessReserved(workspace.workspaceId)) {
        return;
      }
      runReservations.add(workspace.workspaceId);
      let releaseWorkspace: (() => Promise<void>) | null;
      try {
        releaseWorkspace =
          (await options.prepareRunWorkspace?.(workspace)) ?? null;
      } catch (error) {
        runReservations.delete(workspace.workspaceId);
        if (bypassBudget) budgetBypassThreads.add(bypassKey);
        throw error;
      }
      if (stopped || paused) {
        runReservations.delete(workspace.workspaceId);
        if (bypassBudget) budgetBypassThreads.add(bypassKey);
        await releaseWorkspaceLease(releaseWorkspace);
        return;
      }
      let claim: AgentDispatchClaim | null;
      try {
        claim = await dispatch.claimNextPending(workspace.workspaceId, {
          command,
          logPath: logPathTemplate(),
        });
      } catch (error) {
        runReservations.delete(workspace.workspaceId);
        if (bypassBudget) budgetBypassThreads.add(bypassKey);
        await releaseWorkspaceLease(releaseWorkspace);
        throw error;
      }
      if (!claim) {
        runReservations.delete(workspace.workspaceId);
        if (bypassBudget) budgetBypassThreads.add(bypassKey);
        await releaseWorkspaceLease(releaseWorkspace);
        return;
      }
      await startClaim(workspace, claim, runner, releaseWorkspace);
      return;
    }
  }

  async function scanTriggers(workspace: ChatDispatchWorkspace): Promise<void> {
    const [identity] = await Promise.all([
      options.identityFor(workspace.workspaceId),
      options.chatStoreFor(workspace).ensureAgentChannel({
        workspaceId: workspace.workspaceId,
      }),
    ]);
    const recordedCount = await options
      .dispatchStoreFor(workspace)
      .recordEligibleTriggers({
        workspaceId: workspace.workspaceId,
        ...(identity.verifiedUserId
          ? { verifiedUserId: identity.verifiedUserId }
          : {}),
      });
    if (recordedCount > 0) notifyRunUpdated(workspace.workspaceId);
  }

  async function persistInterruptedRequeue(
    recovery: PendingInterruptedRequeue,
  ): Promise<boolean> {
    const requeue = options.requeueFailedTrigger;
    if (!requeue) return true;
    const key = runKey(recovery.input.workspaceId, recovery.input.runId);
    try {
      const persisted = await requeue(recovery.input);
      if (!persisted) {
        throw new Error(
          `Interrupted agent run ${recovery.input.runId} was not requeued.`,
        );
      }
      if (pendingInterruptedRequeues.get(key) === recovery) {
        pendingInterruptedRequeues.delete(key);
      }
      return true;
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(recovery.workspace.workspaceId);
      return false;
    }
  }

  async function requeueInterruptedRun(
    workspace: ChatDispatchWorkspace,
    input: PendingInterruptedRequeue["input"],
  ): Promise<boolean> {
    if (!options.requeueFailedTrigger) return true;
    const recovery = { workspace, input };
    pendingInterruptedRequeues.set(
      runKey(input.workspaceId, input.runId),
      recovery,
    );
    return await persistInterruptedRequeue(recovery);
  }

  async function recoverInterruptedRequeues(
    workspace: ChatDispatchWorkspace,
  ): Promise<boolean> {
    const pending = [...pendingInterruptedRequeues.values()].filter(
      (recovery) =>
        recovery.workspace.workspaceId === workspace.workspaceId,
    );
    for (const recovery of pending) {
      if (!(await persistInterruptedRequeue(recovery))) return false;
    }
    return true;
  }

  async function startupSweep(workspace: ChatDispatchWorkspace): Promise<boolean> {
    if (sweptWorkspaces.has(workspace.workspaceId)) return true;
    const dispatch = options.dispatchStoreFor(workspace);
    const open = await dispatch.openRuns(workspace.workspaceId);
    for (const claim of open) {
      const linked = await dispatch.listRunMessages(
        workspace.workspaceId,
        claim.run.runId,
        durableDispatchRequest,
      );
      if (linked.length === 0 && !claim.run.failureNotePosted) {
        await postFailureNote(
          workspace,
          claim.run,
          "⚠ Agent run failed (app restarted during run). Open the run chip for details.",
        ).catch(reportError);
      }
      await dispatch.failRun({
        runId: claim.run.runId,
        reason: "app restart during run",
      });
      notifyRunUpdated(workspace.workspaceId);
      if (claim.dispatch.attemptCount < 2) {
        if (
          !(await requeueInterruptedRun(workspace, {
            workspaceId: workspace.workspaceId,
            triggerMessageId: claim.run.triggerMessageId,
            runId: claim.run.runId,
          }))
        ) {
          return false;
        }
      }
    }
    const recoveries =
      (await options.listAppQuitRecoveries?.(workspace.workspaceId)) ?? [];
    for (const recovery of recoveries) {
      const linked = await dispatch.listRunMessages(
        workspace.workspaceId,
        recovery.run.runId,
        durableDispatchRequest,
      );
      if (linked.length > 0) {
        if (!recovery.run.failureNotePosted) {
          await dispatch.markFailureNotePosted(
            recovery.run.runId,
            durableDispatchRequest,
          );
        }
        continue;
      }
      if (!recovery.run.failureNotePosted) {
        const restarted =
          recovery.run.failureReason === "app restart during run";
        await postFailureNote(
          workspace,
          recovery.run,
          restarted
            ? "⚠ Agent run failed (app restarted during run). Open the run chip for details."
            : "⚠ Agent run failed (app quit during run). Open the run chip for details.",
        ).catch(reportError);
      }
      if (recovery.attemptCount < 2) {
        if (
          !(await requeueInterruptedRun(workspace, {
            workspaceId: workspace.workspaceId,
            triggerMessageId: recovery.run.triggerMessageId,
            runId: recovery.run.runId,
          }))
        ) {
          return false;
        }
      }
    }
    sweptWorkspaces.add(workspace.workspaceId);
    return true;
  }

  async function recoverNoReplyChecks(
    workspace: ChatDispatchWorkspace,
  ): Promise<void> {
    const pending = [...pendingNoReplyChecks.entries()].filter(
      ([, recovery]) =>
        recovery.workspace.workspaceId === workspace.workspaceId,
    );
    for (const [key, recovery] of pending) {
      if (
        runMessageLinkPending(
          recovery.workspace.workspaceId,
          recovery.run.runId,
        )
      ) {
        scheduleRecoveryScan(workspace.workspaceId);
        continue;
      }
      try {
        const linked = await options
          .dispatchStoreFor(workspace)
          .listRunMessages(
            workspace.workspaceId,
            recovery.run.runId,
            durableDispatchRequest,
          );
        if (linked.length === 0) {
          await postFailureNote(
            workspace,
            recovery.run,
            "⚠ Agent run produced no reply. Open the run chip for details.",
          );
        }
        pendingNoReplyChecks.delete(key);
      } catch (error) {
        reportError(error);
        scheduleRecoveryScan(workspace.workspaceId);
      }
    }
  }

  async function scanAndDrain(workspace: ChatDispatchWorkspace): Promise<void> {
    const preRunFailure = pendingPreRunFailures.get(workspace.workspaceId);
    if (preRunFailure && !(await recoverPreRunFailure(preRunFailure))) return;
    const recovering = liveRuns.get(workspace.workspaceId);
    if (recovering?.finalized) {
      if (!(await finishLiveRun(recovering, null, null))) return;
    }
    if (!(await recoverInterruptedRequeues(workspace))) return;
    await recoverNoReplyChecks(workspace);
    if (!(await startupSweep(workspace))) return;
    await scanTriggers(workspace);
    await drain(workspace);
  }

  function scanWorkspace(workspaceId: string): Promise<void> {
    const scan = enqueue(workspaceId, async () => {
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace || stopped) return;
      if ((await options.scanEligible?.(workspace)) === false) return;
      await scanAndDrain(workspace);
    });
    void scan.catch(() => scheduleRecoveryScan(workspaceId));
    return scan;
  }

  async function pump(): Promise<void> {
    const workspaces = options.listSyncWorkspaces();
    await Promise.allSettled(
      workspaces.map(async (workspace) => {
        try {
          const ready = await options.queueSync(workspace.workspaceId);
          if (ready === false) return;
        } catch (cause) {
          // A transient pull failure must not prevent a scan of this
          // workspace's locally-cached triggers.
          const error = new Error(
            `Agent dispatch sync failed for workspace ${workspace.workspaceId}.`,
          );
          (error as Error & { cause?: unknown }).cause = cause;
          reportError(error);
        }
        try {
          await scanWorkspace(workspace.workspaceId);
        } catch (cause) {
          const error = new Error(
            `Agent dispatch scan failed for workspace ${workspace.workspaceId}.`,
          );
          (error as Error & { cause?: unknown }).cause = cause;
          reportError(error);
        }
      }),
    );
  }

  function schedulePump(): void {
    if (pumpInFlight) return;
    const running = pump().catch(reportError);
    pumpInFlight = running;
    void running.finally(() => {
      if (pumpInFlight === running) pumpInFlight = null;
    });
  }

  function start(): void {
    if (started) return;
    started = true;
    stopped = false;
    shuttingDown = false;
    for (const workspace of options.listOpenWorkspaces()) {
      void scanWorkspace(workspace.workspaceId).catch(reportError);
    }
    pumpTimer = setInterval(() => {
      schedulePump();
    }, CHAT_DISPATCH_PUMP_MS);
  }

  function setPaused(next: boolean): void {
    paused = next;
    if (!paused && !stopped) {
      for (const workspace of options.listOpenWorkspaces()) {
        void scanWorkspace(workspace.workspaceId).catch(reportError);
      }
    }
  }

  async function stopAgentRun(workspaceId: string): Promise<boolean> {
    let stoppedRun = false;
    await enqueue(workspaceId, async () => {
      const live = liveRuns.get(workspaceId);
      if (!live || live.finalized) return;
      stoppedRun = true;
      live.finalized = true;
      live.terminalIntent = {
        kind: "fail",
        exitCode: APP_QUIT_EXIT_CODE,
        reason: "user-stop",
      };
      clearTimeout(live.timeout);
      live.killEscalation = terminateWithEscalation(
        live.child,
        live.killEscalation,
      );
      const dispatch = options.dispatchStoreFor(live.workspace);
      await dispatch.failRun({
        runId: live.claim.run.runId,
        exitCode: APP_QUIT_EXIT_CODE,
        reason: "user-stop",
      });
      live.terminalDurable = true;
      try {
        await postFailureNote(
          live.workspace,
          live.claim.run,
          "⏹ Agent run stopped.",
        );
      } catch (error) {
        reportError(error);
        // A stopped run is terminal even when its cosmetic note cannot be
        // stored. Mark it handled so app-quit recovery never retries it.
        await dispatch.markFailureNotePosted(
          live.claim.run.runId,
          durableDispatchRequest,
        );
      }
      notifyRunUpdated(workspaceId);
    });
    return stoppedRun;
  }

  async function resumeThreadDispatch(
    workspaceId: string,
    threadId: string,
  ): Promise<void> {
    await enqueue(workspaceId, async () => {
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
      await options.dispatchStoreFor(workspace).setThreadDispatchPaused({
        workspaceId,
        threadId,
        paused: false,
      });
      notifyRunUpdated(workspaceId);
      budgetBypassThreads.add(threadKey(workspaceId, threadId));
      await scanAndDrain(workspace);
    });
  }

  async function dispatchStateForThread(
    workspaceId: string,
    threadId: string,
  ): Promise<ChatDispatchThreadState> {
    const workspace = options.workspaceFor(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const dispatch = options.dispatchStoreFor(workspace);
    const [pauseState, pending] = await Promise.all([
      dispatch.getThreadDispatchPauseState(workspaceId, threadId),
      dispatch.listPending(workspaceId),
    ]);
    const live = liveRuns.get(workspaceId);
    return {
      liveRun:
        live?.claim.run.threadId === threadId && live.finalized === false,
      pendingCount: pending
        .filter((pending) => pending.threadId === threadId).length,
      paused: pauseState?.paused ?? false,
      ...(pauseState?.paused && pauseState.reason
        ? { pausedReason: pauseState.reason }
        : {}),
    };
  }

  async function runnerSelfTest(
    workspaceId: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const workspace = options.workspaceFor(workspaceId);
    if (!workspace) return { ok: false, detail: "That workspace is not available." };
    if (shuttingDown) return { ok: false, detail: "Agent dispatch is stopping." };
    if (
      workspaceProcessReserved(workspaceId)
    ) {
      return { ok: false, detail: "A runner is already active in this workspace." };
    }
    selfTestReservations.add(workspaceId);
    let reservationHeldByProcess = false;
    let releaseWorkspace: (() => Promise<void>) | null = null;
    try {
      const runner = await options.readRunnerSettings();
      const command = runner.command.trim();
      if (!command) return { ok: false, detail: "Configure a runner command first." };

      // A self-test spawns a real runner and writes a scratch thread, so it
      // takes the same run lease and engine gate as a claimed run. An opted-out
      // workspace refuses here, before chatStoreFor creates an engine store.
      try {
        releaseWorkspace = (await options.prepareRunWorkspace?.(workspace)) ?? null;
      } catch (error) {
        return {
          ok: false,
          detail:
            error instanceof Error && error.message
              ? error.message
              : "This workspace cannot run agents.",
        };
      }

      const chat = options.chatStoreFor(workspace);
      const identity = await options.identityFor(workspaceId);
      const agentChannel = await chat.ensureAgentChannel({ workspaceId });
      const summaries = await chat.listChannelThreads({
        workspaceId,
        channelId: agentChannel.id,
      });
      let scratchThreadId: string | null = null;
      for (const summary of summaries) {
        if (summary.thread.title !== SELF_TEST_THREAD_TITLE) continue;
        const messages = await chat.listMessages({
          workspaceId,
          threadId: summary.thread.id,
        });
        const opening = messages[0];
        if (
          opening?.author.kind === "agent" &&
          opening.body === SELF_TEST_SCRATCH_BODY
        ) {
          scratchThreadId = summary.thread.id;
          break;
        }
      }
      if (!scratchThreadId) {
        const scratch = await chat.startChannelThread({
          workspaceId,
          channelId: agentChannel.id,
          title: SELF_TEST_THREAD_TITLE,
          author: { kind: "agent", displayName: identity.displayName },
          ...(identity.verifiedUserId
            ? { authorUserId: identity.verifiedUserId }
            : {}),
          origin: "cli",
          body: SELF_TEST_SCRATCH_BODY,
        });
        scratchThreadId = scratch.thread.id;
        options.onMessagePosted(workspaceId, scratchThreadId);
      }
      const runId = `run_self_test_${createId()}`;
      const marker = `dohc-runner-self-test:${runId}`;
      const logPath = join(options.stateDir(), "run-logs", `${runId}.log`);
      const prompt = `This is a dohc runner self-test. Run exactly this command and do not post another message:\n\ndohc chat reply ${scratchThreadId} --as-agent "${marker}"`;
      try {
        if (
          shuttingDown ||
          liveRuns.has(workspaceId) ||
          runReservations.has(workspaceId) ||
          selfTests.has(workspaceId) ||
          options.runSlotOccupied?.(workspaceId) === true
        ) {
          return {
            ok: false,
            detail: shuttingDown
              ? "Agent dispatch is stopping."
              : "A runner became active before the self-test could start.",
          };
        }
        await options.setRunAttribution(workspaceId, {
          agentId: "dohc-chat-runner-self-test",
          onBehalfOf: "local",
          agentRunId: runId,
        });
        const spawned = spawnConfiguredRunner({
          workspace,
          threadId: scratchThreadId,
          runId,
          logPath,
          command,
          prompt,
        });
        return await new Promise<{ ok: boolean; detail: string }>((resolveResult) => {
          const complete = async (result: { ok: boolean; detail: string }) => {
            const test = selfTests.get(workspaceId);
            if (!test || test.settled) return;
            test.settled = true;
            if (test.poll) clearTimeout(test.poll);
            clearTimeout(test.timeout);
            if (test.killEscalation && test.child.hasExited()) {
              clearTimeout(test.killEscalation);
              test.killEscalation = null;
            }
            selfTests.delete(workspaceId);
            try {
              await options.setRunAttribution(workspaceId, null);
            } catch (error) {
              reportError(error);
            }
            const releaseReservation = () => {
              if (!selfTestReservations.delete(workspaceId)) return;
              if (!stopped) void scanWorkspace(workspaceId).catch(reportError);
            };
            if (!test.child.hasExited()) {
              reservationHeldByProcess = true;
              test.killEscalation = terminateWithEscalation(
                test.child,
                test.killEscalation,
              );
              test.child.onExit(() => releaseReservation());
              setTimeout(releaseReservation, RUNNER_KILL_GRACE_MS + 1_000);
            } else {
              releaseReservation();
            }
            resolveResult(result);
          };
          const check = async () => {
            const test = selfTests.get(workspaceId);
            if (!test || test.settled) return;
            try {
              const messages = await chat.listMessages({
                workspaceId,
                threadId: scratchThreadId,
              });
              if (
                messages.some(
                  (message) =>
                    message.author.kind === "agent" &&
                    message.body.trim() === marker,
                )
              ) {
                await complete({
                  ok: true,
                  detail:
                    "Runner self-test passed. The harness reported through dohc chat.",
                });
                return;
              }
            } catch (error) {
              reportError(error);
            }
            const current = selfTests.get(workspaceId);
            if (current && !current.settled) {
              current.poll = setTimeout(() => {
                void check();
              }, SELF_TEST_POLL_MS);
            }
          };
          const timeout = setTimeout(() => {
            const test = selfTests.get(workspaceId);
            if (test) {
              test.killEscalation = terminateWithEscalation(
                test.child,
                test.killEscalation,
              );
            }
            void complete({
              ok: false,
              detail: `Runner self-test timed out after 120 seconds. Log: ${logPath}`,
            });
          }, RUNNER_SELF_TEST_TIMEOUT_MS);
          const state: SelfTestState = {
            workspaceId,
            child: spawned.child,
            threadId: scratchThreadId,
            runId,
            settled: false,
            poll: null,
            timeout,
            killEscalation: null,
            resolve: resolveResult,
          };
          selfTests.set(workspaceId, state);
          spawned.child.onError((error) => {
            reportError(error);
            void complete({
              ok: false,
              detail: `Runner self-test failed to start. Log: ${logPath}`,
            });
          });
          spawned.child.onExit(() => {
            void (async () => {
              await check();
              const current = selfTests.get(workspaceId);
              if (current && !current.settled) {
                await complete({
                  ok: false,
                  detail: `Runner exited before reporting self-test success. Log: ${logPath}`,
                });
              }
            })();
          });
          void check();
        });
      } catch (error) {
        try {
          await options.setRunAttribution(workspaceId, null);
        } catch {}
        reportError(error);
        return {
          ok: false,
          detail: `Runner self-test could not start. Log: ${logPath}`,
        };
      }
    } finally {
      if (!reservationHeldByProcess) selfTestReservations.delete(workspaceId);
      await releaseWorkspaceLease(releaseWorkspace);
    }
  }

  async function stop(): Promise<void> {
    shuttingDown = true;
    stopped = true;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
    for (const timer of recoveryTimers.values()) clearTimeout(timer);
    recoveryTimers.clear();
    recoveryAttempts.clear();
    const pumpAtStop = pumpInFlight;
    const appQuitRuns: LiveRun[] = [];
    const runWorkspacesToRelease: LiveRun[] = [];
    const quitProcesses: RunnerProcess[] = [];
    for (const test of selfTests.values()) {
      if (test.killEscalation) clearTimeout(test.killEscalation);
      test.killEscalation = null;
      quitProcesses.push(test.child);
    }
    for (const live of liveRuns.values()) {
      if (live.killEscalation) clearTimeout(live.killEscalation);
      live.killEscalation = null;
      if (!live.finalized) {
        live.finalized = true;
        clearTimeout(live.timeout);
        if (live.presenceHeartbeat) clearInterval(live.presenceHeartbeat);
        appQuitRuns.push(live);
      }
      runWorkspacesToRelease.push(live);
      quitProcesses.push(live.child);
    }
    const quitTerminations = quitProcesses.map(terminateForAppQuit);
    const persistedQuitRuns = await Promise.allSettled(
      appQuitRuns.map(async (live) => {
        await options.dispatchStoreFor(live.workspace).failRun({
          runId: live.claim.run.runId,
          exitCode: APP_QUIT_EXIT_CODE,
          reason: "app-quit",
        });
      }),
    );
    for (const result of persistedQuitRuns) {
      if (result.status === "rejected") reportError(result.reason);
    }
    await Promise.all([
      ...[...workspaceChains.values()].map((chain) =>
        chain.catch(() => undefined),
      ),
      pumpAtStop?.catch(() => undefined) ?? Promise.resolve(),
    ]);
    const preRunFailures = [...pendingPreRunFailures.values()];
    for (const test of selfTests.values()) {
      test.settled = true;
      if (test.poll) clearTimeout(test.poll);
      clearTimeout(test.timeout);
      if (test.killEscalation) clearTimeout(test.killEscalation);
      try {
        await options.setRunAttribution(test.workspaceId, null);
      } catch {}
      test.resolve({
        ok: false,
        detail: "Runner self-test stopped because dohc is quitting.",
      });
    }
    selfTests.clear();
    selfTestReservations.clear();
    runReservations.clear();
    budgetBypassThreads.clear();
    pendingNoReplyChecks.clear();
    pendingPreRunFailures.clear();
    pendingInterruptedRequeues.clear();
    await Promise.all(quitTerminations);
    await Promise.all(
      [
        ...runWorkspacesToRelease.map(async (live) => {
          try {
            await clearLiveAttribution(live);
          } catch (error) {
            reportError(error);
          } finally {
            if (liveRuns.get(live.workspace.workspaceId) === live) {
              liveRuns.delete(live.workspace.workspaceId);
            }
            await releaseLiveWorkspace(live);
          }
        }),
        ...preRunFailures.map(async (recovery) => {
          await releaseWorkspaceLease(recovery.releaseWorkspace);
          recovery.releaseWorkspace = null;
        }),
      ],
    );
    liveRuns.clear();
  }

  return {
    start,
    stop,
    scanWorkspace,
    stopAgentRun,
    resumeThreadDispatch,
    dispatchStateForThread,
    runnerSelfTest,
    setPaused,
    isPaused: () => paused,
    hasLiveRun: (workspaceId: string) =>
      workspaceProcessReserved(workspaceId),
  };
}

export type ChatDispatchService = ReturnType<typeof createChatDispatchService>;
