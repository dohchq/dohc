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
  AgentDispatchStore,
  AgentRunRecord,
  ChatChannelKind,
  ChatMessage,
  LinkedChatStore,
} from "@dohc/workspace-engine";
import type { RunnerSettings } from "../settings/userSettings";
import {
  killChildTreeWin32,
  resolveSpawnCommand,
} from "../process/windowsSpawn";
import { buildRunnerThreadContext } from "./runnerThreadContext";

export const CHAT_DISPATCH_PUMP_MS = 15_000;
export const CHAT_DISPATCH_BUDGET_WINDOW_MS = 10 * 60_000;
export const CHAT_DISPATCH_BUDGET_MAX = 10;
export const RUNNER_SELF_TEST_TIMEOUT_MS = 120_000;
export const RUNNER_KILL_GRACE_MS = 10_000;
export const APP_QUIT_KILL_GRACE_MS = 1_500;
export const RUN_ID_LOG_TOKEN = "{runId}";
export const APP_QUIT_EXIT_CODE = 143;

export const NO_RUNNER_NOTE =
  "No agent runner is configured — set one up in Settings → Agents & MCP to dispatch this.";

const PRESENCE_HEARTBEAT_MS = 10_000;
const SELF_TEST_POLL_MS = 250;

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
  hasExited(): boolean;
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface RunnerSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: true;
  stdio: ["ignore", number, number];
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
  dispatchStoreFor(workspace: ChatDispatchWorkspace): AgentDispatchStore;
  readRunnerSettings(): Promise<RunnerSettings>;
  identityFor(workspaceId: string): Promise<ChatDispatchIdentity>;
  stateDir(): string;
  appRoot(): string;
  isPackaged(): boolean;
  resourcesPath?: () => string | undefined;
  queueSync(workspaceId: string): void | boolean | Promise<void | boolean>;
  prepareRunWorkspace?(
    workspace: ChatDispatchWorkspace,
  ): Promise<void | (() => Promise<void>)>;
  authorizeServiceNote(
    workspace: ChatDispatchWorkspace,
    threadId: string,
  ): Promise<boolean>;
  onMessagePosted(workspaceId: string): void;
  onRunUpdated?(workspaceId: string): void;
  setRunAttribution(
    workspaceId: string,
    run: { agentId: string; onBehalfOf: string; agentRunId: string } | null,
  ): void;
  runSlotOccupied?(workspaceId: string): boolean;
  publishPresence?(input: ChatDispatchPresenceInput): Promise<void>;
  requeueFailedTrigger?(input: {
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  }): boolean;
  listAppQuitRecoveries?(workspaceId: string): ChatDispatchRecovery[];
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
}

interface SpawnedRun {
  child: RunnerProcess;
  logPath: string;
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
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let pumpInFlight: Promise<void> | null = null;
  let started = false;
  let stopped = true;
  let shuttingDown = false;
  let paused = false;

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

  function threadKey(workspaceId: string, threadId: string): string {
    return `${workspaceId}\u0000${threadId}`;
  }

  function workspaceProcessReserved(workspaceId: string): boolean {
    return (
      liveRuns.has(workspaceId) ||
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
    const args = [...commandParts.slice(1), input.prompt];
    const env = runnerEnvironment({
      workspaceId: input.workspace.workspaceId,
      threadId: input.threadId,
      runId: input.runId,
    });
    const resolved = resolveSpawnCommand(executable, args, {
      env,
      cwd: input.workspace.rootPath,
    });
    const logFd = prepareLog(input.logPath);
    try {
      const child = spawnRunner(resolved.command, resolved.args, {
        cwd: input.workspace.rootPath,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        ...(resolved.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      });
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
  ): Promise<string | null> {
    if (!(await options.authorizeServiceNote(workspace, threadId))) {
      reportError(
        new Error(
          `Skipped an agent service note in read-only thread ${threadId}.`,
        ),
      );
      return null;
    }
    const identity = await options.identityFor(workspace.workspaceId);
    const message = await options.chatStoreFor(workspace).sendMessage({
      workspaceId: workspace.workspaceId,
      threadId,
      author: {
        kind: "agent",
        displayName: identity.displayName,
      },
      body,
    });
    if (runId) {
      try {
        options.dispatchStoreFor(workspace).recordRunMessage({
          workspaceId: workspace.workspaceId,
          messageId: message.id,
          runId,
        });
      } catch {
        // The report itself is authoritative; a provenance chip is optional.
      }
    }
    options.onMessagePosted(workspace.workspaceId);
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
    const current = dispatch.getRunRecord(run.runId);
    if (current?.failureNotePosted) return;
    if (!(await agentNoteAlreadyExists(workspace, run.threadId, body))) {
      await sendAgentMessage(
        workspace,
        run.threadId,
        body,
        run.runId,
      );
    }
    dispatch.markFailureNotePosted(run.runId);
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

  function clearLiveAttribution(live: LiveRun): void {
    try {
      options.setRunAttribution(live.workspace.workspaceId, null);
    } catch (error) {
      reportError(error);
    }
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
  ): Promise<void> {
    if (live.finalized) {
      if (stopped) return;
      if (liveRuns.get(live.workspace.workspaceId) === live) {
        if (live.killEscalation) clearTimeout(live.killEscalation);
        live.killEscalation = null;
        clearLiveAttribution(live);
        liveRuns.delete(live.workspace.workspaceId);
        await releaseLiveWorkspace(live);
        await scanAndDrain(live.workspace);
      }
      return;
    }
    live.finalized = true;
    clearTimeout(live.timeout);
    if (live.killEscalation) clearTimeout(live.killEscalation);
    live.killEscalation = null;
    const code = exitCode ?? signalExitCode(signal);
    const dispatch = options.dispatchStoreFor(live.workspace);
    const linkedMessages = dispatch.listRunMessages(
      live.workspace.workspaceId,
      live.claim.run.runId,
    );
    try {
      if (code !== 0) {
        await postFailureNote(
          live.workspace,
          live.claim.run,
          `⚠ Agent run failed (exit ${code}). Open the run chip for details.`,
        );
      } else if (linkedMessages.length === 0) {
        await postFailureNote(
          live.workspace,
          live.claim.run,
          "⚠ Agent run produced no reply. Open the run chip for details.",
        );
      }
      dispatch.completeRun({ runId: live.claim.run.runId, exitCode: code });
      notifyRunUpdated(live.workspace.workspaceId);
    } catch (error) {
      liveRuns.delete(live.workspace.workspaceId);
      clearLiveAttribution(live);
      await releaseLiveWorkspace(live);
      throw error;
    }
    liveRuns.delete(live.workspace.workspaceId);
    clearLiveAttribution(live);
    await releaseLiveWorkspace(live);
    await scanAndDrain(live.workspace);
  }

  async function timeOutLiveRun(live: LiveRun): Promise<void> {
    if (live.finalized) return;
    live.finalized = true;
    live.killEscalation = terminateWithEscalation(
      live.child,
      live.killEscalation,
    );
    const dispatch = options.dispatchStoreFor(live.workspace);
    await postFailureNote(
      live.workspace,
      live.claim.run,
      `⚠ Agent run produced no reply (timed out after ${live.timeoutMinutes}m). Open the run chip for details.`,
    );
    dispatch.failRun({
      runId: live.claim.run.runId,
      exitCode: 124,
      reason: `timed out after ${live.timeoutMinutes}m`,
    });
    notifyRunUpdated(live.workspace.workspaceId);
  }

  async function failClaimBeforeRun(
    workspace: ChatDispatchWorkspace,
    claim: AgentDispatchClaim,
    cause: unknown,
  ): Promise<void> {
    try {
      options.setRunAttribution(workspace.workspaceId, null);
    } catch {}
    const detail = cause instanceof Error && cause.message ? cause.message : "unknown error";
    await postFailureNote(
      workspace,
      claim.run,
      "⚠ Agent run failed to start. Open the run chip for details.",
    );
    options.dispatchStoreFor(workspace).failRun({
      runId: claim.run.runId,
      reason: `runner failed to start: ${detail}`,
    });
    notifyRunUpdated(workspace.workspaceId);
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
      options.setRunAttribution(workspace.workspaceId, {
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
      };
      liveRuns.set(workspace.workspaceId, live);
      runReservations.delete(workspace.workspaceId);
      spawned.child.onExit((code, signal) => {
        void enqueue(workspace.workspaceId, () =>
          finishLiveRun(live, code, signal),
        );
      });
      spawned.child.onError((error) => {
        reportError(error);
        void enqueue(workspace.workspaceId, () =>
          finishLiveRun(live, 1, null),
        );
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
      try {
        await failClaimBeforeRun(workspace, claim, error);
      } finally {
        await releaseWorkspaceLease(releaseWorkspace);
      }
      if (dispatch.openRuns(workspace.workspaceId).length === 0) {
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
        dispatch
          .listPending(workspace.workspaceId)
          .map((pending) => pending.threadId),
      );
      for (const threadId of threadIds) {
        const failedCount = dispatch.failPendingForThread({
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
    const pending = dispatch.listPending(workspace.workspaceId);
    for (const candidate of pending) {
      if (dispatch.threadDispatchPaused(workspace.workspaceId, candidate.threadId)) {
        continue;
      }
      const bypassKey = threadKey(workspace.workspaceId, candidate.threadId);
      const bypassBudget = budgetBypassThreads.delete(bypassKey);
      if (
        !bypassBudget &&
        dispatch.recentDispatchCount({
          workspaceId: workspace.workspaceId,
          threadId: candidate.threadId,
          sinceMs: nowMs() - CHAT_DISPATCH_BUDGET_WINDOW_MS,
        }) >= CHAT_DISPATCH_BUDGET_MAX
      ) {
        dispatch.setThreadDispatchPaused({
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
          dispatch.setThreadDispatchPaused({
            workspaceId: workspace.workspaceId,
            threadId: candidate.threadId,
            paused: false,
          });
          throw error;
        }
        continue;
      }
      const releaseWorkspace =
        (await options.prepareRunWorkspace?.(workspace)) ?? null;
      if (stopped || paused || workspaceProcessReserved(workspace.workspaceId)) {
        await releaseWorkspaceLease(releaseWorkspace);
        return;
      }
      let claim: AgentDispatchClaim | null;
      try {
        claim = dispatch.claimNextPending(workspace.workspaceId, {
          command,
          logPath: logPathTemplate(),
        });
      } catch (error) {
        await releaseWorkspaceLease(releaseWorkspace);
        throw error;
      }
      if (!claim) {
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
    const recordedCount = options.dispatchStoreFor(workspace).recordEligibleTriggers({
      workspaceId: workspace.workspaceId,
      ...(identity.verifiedUserId
        ? { verifiedUserId: identity.verifiedUserId }
        : {}),
    });
    if (recordedCount > 0) notifyRunUpdated(workspace.workspaceId);
  }

  async function startupSweep(workspace: ChatDispatchWorkspace): Promise<void> {
    if (sweptWorkspaces.has(workspace.workspaceId)) return;
    const dispatch = options.dispatchStoreFor(workspace);
    const open = dispatch.openRuns(workspace.workspaceId);
    for (const claim of open) {
      const linked = dispatch.listRunMessages(
        workspace.workspaceId,
        claim.run.runId,
      );
      if (linked.length === 0 && !claim.run.failureNotePosted) {
        await postFailureNote(
          workspace,
          claim.run,
          "⚠ Agent run failed (app restarted during run). Open the run chip for details.",
        );
      }
      dispatch.failRun({
        runId: claim.run.runId,
        reason: "app restart during run",
      });
      notifyRunUpdated(workspace.workspaceId);
      if (claim.dispatch.attemptCount < 2) {
        options.requeueFailedTrigger?.({
          workspaceId: workspace.workspaceId,
          triggerMessageId: claim.run.triggerMessageId,
          runId: claim.run.runId,
        });
      }
    }
    for (const recovery of options.listAppQuitRecoveries?.(
      workspace.workspaceId,
    ) ?? []) {
      const linked = dispatch.listRunMessages(
        workspace.workspaceId,
        recovery.run.runId,
      );
      if (linked.length > 0) {
        if (!recovery.run.failureNotePosted) {
          dispatch.markFailureNotePosted(recovery.run.runId);
        }
        continue;
      }
      if (!recovery.run.failureNotePosted) {
        await postFailureNote(
          workspace,
          recovery.run,
          "⚠ Agent run failed (app quit during run). Open the run chip for details.",
        );
      }
      if (recovery.attemptCount < 2) {
        options.requeueFailedTrigger?.({
          workspaceId: workspace.workspaceId,
          triggerMessageId: recovery.run.triggerMessageId,
          runId: recovery.run.runId,
        });
      }
    }
    sweptWorkspaces.add(workspace.workspaceId);
  }

  async function scanAndDrain(workspace: ChatDispatchWorkspace): Promise<void> {
    await startupSweep(workspace);
    await scanTriggers(workspace);
    await drain(workspace);
  }

  function scanWorkspace(workspaceId: string): Promise<void> {
    return enqueue(workspaceId, async () => {
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace || stopped) return;
      await scanAndDrain(workspace);
    });
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
      clearTimeout(live.timeout);
      live.killEscalation = terminateWithEscalation(
        live.child,
        live.killEscalation,
      );
      const dispatch = options.dispatchStoreFor(live.workspace);
      dispatch.failRun({
        runId: live.claim.run.runId,
        exitCode: APP_QUIT_EXIT_CODE,
        reason: "user-stop",
      });
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
        dispatch.markFailureNotePosted(live.claim.run.runId);
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
      options.dispatchStoreFor(workspace).setThreadDispatchPaused({
        workspaceId,
        threadId,
        paused: false,
      });
      notifyRunUpdated(workspaceId);
      budgetBypassThreads.add(threadKey(workspaceId, threadId));
      await scanAndDrain(workspace);
    });
  }

  function dispatchStateForThread(
    workspaceId: string,
    threadId: string,
  ): ChatDispatchThreadState {
    const workspace = options.workspaceFor(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const dispatch = options.dispatchStoreFor(workspace);
    const pauseState = dispatch.getThreadDispatchPauseState(
      workspaceId,
      threadId,
    );
    const live = liveRuns.get(workspaceId);
    return {
      liveRun:
        live?.claim.run.threadId === threadId && live.finalized === false,
      pendingCount: dispatch
        .listPending(workspaceId)
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
    try {
      const runner = await options.readRunnerSettings();
      const command = runner.command.trim();
      if (!command) return { ok: false, detail: "Configure a runner command first." };

    const chat = options.chatStoreFor(workspace);
    const identity = await options.identityFor(workspaceId);
    const agentChannel = await chat.ensureAgentChannel({ workspaceId });
    const scratch = await chat.startChannelThread({
      workspaceId,
      channelId: agentChannel.id,
      author: { kind: "human", displayName: identity.displayName },
      authorUserId: identity.verifiedUserId,
      origin: "cli",
      body: "Runner self-test",
    });
    options.onMessagePosted(workspaceId);
    const runId = `run_self_test_${createId()}`;
    const logPath = join(options.stateDir(), "run-logs", `${runId}.log`);
    const prompt = `This is a dohc runner self-test. Run exactly this command and do not post another message:\n\ndohc chat reply ${scratch.thread.id} --as-agent "self-test ok"`;
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
      options.setRunAttribution(workspaceId, {
        agentId: "dohc-chat-runner-self-test",
        onBehalfOf: "local",
        agentRunId: runId,
      });
      const spawned = spawnConfiguredRunner({
        workspace,
        threadId: scratch.thread.id,
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
            options.setRunAttribution(workspaceId, null);
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
              threadId: scratch.thread.id,
            });
            if (
              messages.some(
                (message) =>
                  message.author.kind === "agent" &&
                  message.body.trim() === "self-test ok",
              )
            ) {
              await complete({
                ok: true,
                detail: "Runner self-test passed. The harness reported through dohc chat.",
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
          threadId: scratch.thread.id,
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
        options.setRunAttribution(workspaceId, null);
      } catch {}
      reportError(error);
      return {
        ok: false,
        detail: `Runner self-test could not start. Log: ${logPath}`,
      };
    }
    } finally {
      if (!reservationHeldByProcess) selfTestReservations.delete(workspaceId);
    }
  }

  async function stop(): Promise<void> {
    shuttingDown = true;
    stopped = true;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
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
      clearLiveAttribution(live);
      runWorkspacesToRelease.push(live);
      quitProcesses.push(live.child);
    }
    for (const live of appQuitRuns) {
      options.dispatchStoreFor(live.workspace).failRun({
        runId: live.claim.run.runId,
        exitCode: APP_QUIT_EXIT_CODE,
        reason: "app-quit",
      });
    }
    const quitTerminations = quitProcesses.map(terminateForAppQuit);
    await Promise.all([
      ...[...workspaceChains.values()].map((chain) =>
        chain.catch(() => undefined),
      ),
      pumpAtStop?.catch(() => undefined) ?? Promise.resolve(),
    ]);
    for (const test of selfTests.values()) {
      test.settled = true;
      if (test.poll) clearTimeout(test.poll);
      clearTimeout(test.timeout);
      if (test.killEscalation) clearTimeout(test.killEscalation);
      try {
        options.setRunAttribution(test.workspaceId, null);
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
    liveRuns.clear();
    await Promise.all([...workspaceChains.values()].map((chain) => chain.catch(() => undefined)));
    await Promise.all(quitTerminations);
    await Promise.all(
      runWorkspacesToRelease.map((live) => releaseLiveWorkspace(live)),
    );
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
