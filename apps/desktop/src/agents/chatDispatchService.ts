import type { ChatDispatchNotice } from "../ipc/bridgeContract";
import { AGENTS_RESTRICTED_MESSAGE, launchCommand, launchProfile, type AgentLaunchProfile } from "./agentToolCatalog";
import { NOTICE_BODY_MAX_CHARS, NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import type { PostNoticeInput } from "../notices/noticeStore";
import type { OwedRunNotices } from "./owedRunNotices";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createChatRunnerProcess,
  readRunnerNodeAvailable,
  RUNNER_KILL_GRACE_MS,
  type RunnerProcess,
  type ChatRunnerProcessOptions,
  type ReplyRuntimeAvailability,
} from "./chatRunnerProcess";
import type {
  AgentDispatchClaim,
  AgentRunRecord,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import type { Agent, AgentWithLaunch } from "../settings/userSettings";
import type { AgentRunDispatch } from "./activeAgentRun";
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AgentDispatchRequestOptions,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";
import { buildRunnerThreadContext } from "./runnerThreadContext";
import { WorkspaceRestrictedError } from "../workspaces/workspaceTrust";

// How a run ended, as its notice says it.
type RunOutcome =
  | "finished" | "no-reply" | "timed-out" | "failed" | "not-started" | "restarted" | "quit" | "stopped"
  | "restricted";

const RUNNER_START_FAILURE = "runner failed to start";
// A restrict that landed between the trust lookup and the spawn.
const RESTRICTED_AT_START = "restricted-mode";
const RUN_TIMEOUT = "timed out after";

// How a run ended, read from its saved record. A clean exit is "finished"
// only once the run's reply is known, so it stays "exited" here.
function savedRunOutcome(run: AgentRunRecord): Exclude<RunOutcome, "finished" | "no-reply"> | "exited" {
  switch (run.failureReason) {
    case undefined:
      return run.exitCode === 0 ? "exited" : "failed";
    case "app restart during run":
      return "restarted";
    case "app-quit":
      return "quit";
    case "user-stop":
      return "stopped";
    case RESTRICTED_AT_START:
      return "restricted";
    default:
      if (run.failureReason.startsWith(RUNNER_START_FAILURE)) return "not-started";
      return run.failureReason.startsWith(RUN_TIMEOUT) ? "timed-out" : "failed";
  }
}

const RUN_OUTCOME_ENDINGS: Record<Exclude<RunOutcome, "finished">, string> = {
  "no-reply": "produced no reply",
  "timed-out": "timed out",
  failed: "failed",
  "not-started": "failed to start",
  restarted: "stopped when dohc restarted",
  quit: "stopped when dohc quit",
  stopped: "stopped",
  restricted: "did not start in Restricted Mode",
};

// "Your agent finished in "Plan day 2"" or "Your agent's run in "Plan day
// 2" failed", shortening the thread's name to fit. Without a name, the
// sentence names no thread.
function runNoticeTitle(outcome: RunOutcome, thread: string): string {
  const sentence = (name: string | null) => {
    const where = name === null ? "" : ` in "${name}"`;
    if (outcome === "stopped") return `Stopped the run${where}`;
    return outcome === "finished"
      ? `Your agent finished${where}`
      : `Your agent's run${where} ${RUN_OUTCOME_ENDINGS[outcome]}`;
  };
  if (!thread) return sentence(null);
  const room = NOTICE_TITLE_MAX_CHARS - [...sentence("")].length;
  return sentence([...thread].length <= room ? thread : `${[...thread].slice(0, room - 1).join("")}…`);
}

// A run that failed to start says why and what to do next.
// Only a missing PATH runtime recommends installing Node.js.
// Other outcomes have no body. A body holds no control characters,
// or the notice store would refuse it.
function runNoticeBody(run: AgentRunRecord, outcome: RunOutcome, nodeAvailable?: ReplyRuntimeAvailability): string {
  if ((outcome === "failed" || outcome === "no-reply") && nodeAvailable?.source === "path" && !nodeAvailable.available) {
    return "Agent replies need Node.js. Install Node.js, restart dohc, then try again.";
  }
  if (outcome !== "not-started" || !run.failureReason) return "";
  const reason = [...run.failureReason
    .slice(`${RUNNER_START_FAILURE}: `.length)
    .replace(/[\s\u0000-\u001f\u007f]+/gu, " ")
    .trim()];
  return reason.length <= NOTICE_BODY_MAX_CHARS
    ? reason.join("")
    : `${reason.slice(0, NOTICE_BODY_MAX_CHARS - 1).join("")}…`;
}

export const CHAT_DISPATCH_PUMP_MS = 15_000;
const CHAT_DISPATCH_BUDGET_WINDOW_MS = 10 * 60_000;
export const CHAT_DISPATCH_BUDGET_MAX = 10;
export const RUNNER_SELF_TEST_TIMEOUT_MS = 120_000;
export const CHAT_DISPATCH_RECOVERY_BACKOFF_MS = 1_000;
const CHAT_DISPATCH_RECOVERY_MAX_BACKOFF_MS = 30_000;
export const RUN_ID_LOG_TOKEN = "{runId}";
export const APP_QUIT_EXIT_CODE = 143;

export const SELF_TEST_RESTRICTED_DETAIL =
  `${AGENTS_RESTRICTED_MESSAGE} Set Workspace trust to Trusted in Settings → Privacy. Then test again.`;
// For the log. The restrict that asked for the stop words what the person reads.
export const RUNNER_OUTLIVED_STOP = "The agent runner did not exit after dohc stopped it.";

const PRESENCE_HEARTBEAT_MS = 10_000;
const SELF_TEST_POLL_MS = 250;
const SELF_TEST_THREAD_TITLE = "dohc runner self-test";
const SELF_TEST_MARKER_PREFIX = "dohc-runner-self-test:";
const SELF_TEST_OPENING = "Reply here to check the agent connection.";

export interface ChatDispatchWorkspace {
  workspaceId: string;
  rootPath: string;
  attachmentId?: symbol;
}

export interface ChatDispatchPresenceInput {
  workspaceId: string;
  attachmentId?: symbol;
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

interface ChatDispatchServiceOptions extends ChatRunnerProcessOptions {
  workspaceFor(workspaceId: string): ChatDispatchWorkspace | null;
  // Main's workspace trust, the same check app commands pass. Rejects with
  // WorkspaceRestrictedError in Restricted Mode; the answer is a synchronous
  // check that trust still holds, for the spawn itself.
  assertMayStartAgent(workspace: ChatDispatchWorkspace): Promise<() => void>;
  listOpenWorkspaces(): ChatDispatchWorkspace[];
  listSyncWorkspaces(): ChatDispatchWorkspace[];
  chatStoreFor(workspace: ChatDispatchWorkspace): LinkedChatStore;
  startSelfTestThread(workspace: ChatDispatchWorkspace, input: { channelId: string; title: string; body: string }): Promise<string>;
  dispatchStoreFor(
    workspace: ChatDispatchWorkspace,
  ): AwaitableAgentDispatchStore;
  // The person's agents, in the order the settings file lists them.
  readDispatchAgents(): Promise<Agent[]>;
  queueSync(workspace: ChatDispatchWorkspace): void | boolean | Promise<void | boolean>;
  prepareRunWorkspace?(
    workspace: ChatDispatchWorkspace,
  ): Promise<void | (() => Promise<void>)>;
  // The thread names the chat target, so a shared-channel push can cover the
  // channel this message landed in instead of waiting for the sync rotation.
  onMessagePosted(workspace: ChatDispatchWorkspace, threadId: string): void;
  onRunUpdated?(workspace: ChatDispatchWorkspace): void;
  onPausedChanged?(paused: boolean): void;
  onDispatchNotice?(workspace: ChatDispatchWorkspace, notice: Omit<ChatDispatchNotice, "id">): void;
  // Every write the agent makes while the run holds the slot is the run's,
  // at the run's chain depth, for the person main names.
  setRunAttribution(
    workspace: ChatDispatchWorkspace,
    run: { agentId: string; agentRunId: string; depth: number; dispatch: AgentRunDispatch } | null,
  ): void | Promise<void>;
  runSlotOccupied?(workspace: ChatDispatchWorkspace): boolean;
  publishPresence?(input: ChatDispatchPresenceInput): Promise<void>;
  requeueFailedTrigger?(input: {
    workspaceId: string;
    attachmentId?: symbol;
    triggerMessageId: string;
    agentId: string;
    runId: string;
  }): boolean | Promise<boolean>;
  hasPendingRunMessageLink?(workspace: ChatDispatchWorkspace, runId: string): boolean;
  listAppQuitRecoveries?(
    workspace: ChatDispatchWorkspace,
  ): ChatDispatchRecovery[] | Promise<ChatDispatchRecovery[]>;
  nowMs?: () => number;
  createId?: () => string;
  onError?: (error: unknown) => void;
  // Tells this computer's person how each run ended. A run's notice is owed
  // from before its end is saved until the notice is posted.
  runNotices?: {
    post(input: PostNoticeInput): Promise<void>;
    owed: OwedRunNotices;
  };
}

interface ChatDispatchThreadState {
  liveRunId: string | null;
  pendingCount: number;
  paused: boolean;
  pausedReason?: string;
}

interface LiveRun {
  workspace: ChatDispatchWorkspace;
  claim: AgentDispatchClaim;
  agentName: string;
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

interface PendingPreRunFailure {
  workspace: ChatDispatchWorkspace;
  claim: AgentDispatchClaim;
  reason: string;
  releaseWorkspace: (() => Promise<void>) | null;
  // Restricted Mode stopped the start, so the request goes back in line.
  requeue: boolean;
  // The run's end is saved; a retry only requeues and settles its notice.
  failed: boolean;
}

interface PendingInterruptedRequeue {
  workspace: ChatDispatchWorkspace;
  input: {
    workspaceId: string;
    attachmentId?: symbol;
    triggerMessageId: string;
    agentId: string;
    runId: string;
  };
}

interface SelfTestState {
  workspace: ChatDispatchWorkspace;
  child: RunnerProcess;
  runId: string;
  settled: boolean;
  poll: ReturnType<typeof setTimeout> | null;
  timeout: ReturnType<typeof setTimeout>;
  killEscalation: ReturnType<typeof setTimeout> | null;
  resolve(result: { ok: boolean; detail: string }): void;
  // Ends the self-test with this answer and stops its runner.
  cancel(detail: string): Promise<void>;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}


// How a runner posts its reply. A tool profile's run replies through the dohc
// MCP server that its launch starts (chatRunnerProcess.ts replyServerArguments).
// A custom command replies through the dohc CLI.
type ReplyForm = "argument" | "mcp";

function replyFormFor(tool: AgentLaunchProfile["tool"] | undefined): ReplyForm {
  return tool ? "mcp" : "argument";
}

function replyCommand(threadId: string, body: string): string {
  return `dohc chat reply ${threadId} --as-agent "${body}"`;
}

function replyToolCall(threadId: string, runId: string): string {
  return `the \`dohc_reply_to_chat\` tool of the \`dohc\` MCP server with \`threadId\` \`${threadId}\` and \`runId\` \`${runId}\``;
}

// A Claude Code run loads only the person's own Claude Code settings
// (agentToolCatalog.ts), which leaves out the workspace's instruction files.
function buildRunnerPrompt(threadMarkdown: string, threadId: string, runId: string, tool: AgentLaunchProfile["tool"] | undefined): string {
  const form = replyFormFor(tool);
  const instructionsFile = tool === "claude" ? "If the workspace has a CLAUDE.md or .claude/CLAUDE.md file, or an AGENTS.md file, at its root, read them first and follow them. " : "";
  const replyInstruction = form === "mcp"
    ? `Reply in-thread by calling ${replyToolCall(threadId, runId)}, with your Markdown report as \`body\`.`
    : `Reply in-thread with \`${replyCommand(threadId, "<report>")}\`.`;
  const decisionInstruction = form === "mcp"
    ? "If blocked on the user, set `needsDecision`. To ask them to pick, list the choices in `options`; their answer arrives as the next message with the chosen option. Your final text is not shown anywhere; only messages you post through `dohc_reply_to_chat` are shown."
    : "If blocked on the user, reply with `--needs-decision`. To ask them to pick, add `--option \"<choice>\"` once per choice; their answer arrives as the next message with the chosen option. Your final text is not shown anywhere; only messages you post through `dohc chat` are shown.";
  return `${threadMarkdown.trimEnd()}

## Report contract

${instructionsFile}Work on the request represented by this thread. Report outcomes, not tool logs. ${replyInstruction} On long tasks, post progress the way a teammate would. ${decisionInstruction}`;
}

export function createChatDispatchService(options: ChatDispatchServiceOptions) {
  const nowMs = options.nowMs ?? (() => Date.now());
  const createId = options.createId ?? randomUUID;
  const {
    spawnConfiguredRunner,
    terminateWithEscalation,
    terminateForAppQuit,
  } = createChatRunnerProcess(options, reportError);
  const liveRuns = new Map<string, LiveRun>();
  const runReservations = new Set<string>();
  const selfTests = new Map<string, SelfTestState>();
  const selfTestReservations = new Set<string>();
  const budgetBypassThreads = new Set<string>();
  // What this run of dohc told each restricted workspace's person: the
  // notice that Restricted Mode holds a request, and main's dialog on their
  // own send. Each happens once, until the workspace's trust changes.
  const toldOfRestriction = new Map<string, { notice: boolean; asked: boolean }>();
  const told = (workspaceId: string) => {
    let state = toldOfRestriction.get(workspaceId);
    if (!state) toldOfRestriction.set(workspaceId, state = { notice: false, asked: false });
    return state;
  };
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
    } catch {
      // The reporter is the last resort; a throwing reporter has nowhere to report to.
    }
  }

  function notifyRunUpdated(workspace: ChatDispatchWorkspace): void {
    try {
      options.onRunUpdated?.(workspace);
    } catch (error) {
      reportError(error);
    }
  }

  function enqueue<Result>(
    workspaceId: string,
    task: () => Promise<Result>,
    onFailure: (error: unknown) => void = reportError,
  ): Promise<Result> {
    const prior = workspaceChains.get(workspaceId) ?? Promise.resolve();
    const run = prior.then(task, task);
    workspaceChains.set(workspaceId, run.then(() => undefined, onFailure));
    return run;
  }

  // Every scan, and so every claim and the prompt it builds, runs on the
  // workspace's queue. A write of several rows runs there too, so no scan
  // reads it half done. Its caller handles its errors.
  function betweenScans<Result>(workspaceId: string, write: () => Promise<Result>): Promise<Result> {
    return enqueue(workspaceId, write, () => undefined);
  }

  function runKey(workspaceId: string, runId: string): string {
    return `${workspaceId}\u0000${runId}`;
  }

  function scheduleRecoveryScan(workspace: ChatDispatchWorkspace): void {
    const workspaceId = workspace.workspaceId;
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
      void scanWorkspace(workspaceId, workspace.attachmentId).then(
        () => {
          notifyRunUpdated(workspace);
          if (!recoveryTimers.has(workspaceId)) {
            recoveryAttempts.delete(workspaceId);
          }
        },
        (error: unknown) => {
          reportError(error);
          scheduleRecoveryScan(workspace);
        },
      );
    }, delay);
    recoveryTimers.set(workspaceId, timer);
  }

  // The synchronous check for the spawn, or null in Restricted Mode. Any
  // other failure, such as an unreadable trust file, starts nothing either:
  // it throws, and the scan tries again later.
  async function agentStartCheck(workspace: ChatDispatchWorkspace): Promise<(() => void) | null> {
    try {
      return await options.assertMayStartAgent(workspace);
    } catch (error) {
      if (error instanceof WorkspaceRestrictedError) return null;
      throw error;
    }
  }

  // In Restricted Mode a request waits unclaimed, so it keeps its place and
  // its budget, and nothing fails. The person hears of it once per workspace
  // until the workspace is trusted.
  async function holdForTrust(
    workspace: ChatDispatchWorkspace,
    dispatch: AwaitableAgentDispatchStore,
  ): Promise<void> {
    if (told(workspace.workspaceId).notice) return;
    const [held] = await dispatch.listPending(workspace.workspaceId);
    if (!held) return;
    told(workspace.workspaceId).notice = true;
    try {
      options.onDispatchNotice?.(workspace, {
        reason: "restricted", threadId: held.threadId, message: AGENTS_RESTRICTED_MESSAGE,
      });
    } catch (error) {
      reportError(error);
    }
  }

  function threadKey(workspaceId: string, threadId: string): string {
    return `${workspaceId}\u0000${threadId}`;
  }

  function runMessageLinkPending(
    workspace: ChatDispatchWorkspace,
    runId: string,
  ): boolean {
    return options.hasPendingRunMessageLink?.(workspace, runId) === true;
  }

  function workspaceProcessReserved(workspace: ChatDispatchWorkspace): boolean {
    const workspaceId = workspace.workspaceId;
    return (
      liveRuns.has(workspaceId) ||
      pendingPreRunFailures.has(workspaceId) ||
      runReservations.has(workspaceId) ||
      selfTests.has(workspaceId) ||
      selfTestReservations.has(workspaceId) ||
      options.runSlotOccupied?.(workspace) === true
    );
  }

  async function presence(input: ChatDispatchPresenceInput): Promise<void> {
    try {
      await options.publishPresence?.(input);
    } catch {
      // Presence is cosmetic. The dispatch ledger and run records carry truth.
    }
  }

  function workingPresenceInput(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    displayName: string,
  ): ChatDispatchPresenceInput {
    return {
      workspaceId: workspace.workspaceId,
      ...(workspace.attachmentId
        ? { attachmentId: workspace.attachmentId }
        : {}),
      threadId,
      clientId: `agent:${workspace.workspaceId}`,
      state: {
        displayName: displayName,
        agent: true,
        activity: "working",
      },
    };
  }

  function finishPresence(live: LiveRun): void {
    if (live.presenceHeartbeat) clearInterval(live.presenceHeartbeat);
    live.presenceHeartbeat = null;
    const base = {
      workspaceId: live.workspace.workspaceId,
      ...(live.workspace.attachmentId
        ? { attachmentId: live.workspace.attachmentId }
        : {}),
      threadId: live.claim.run.threadId,
      clientId: `agent:${live.workspace.workspaceId}`,
    };
    void presence({
      ...base,
      state: { displayName: live.agentName, agent: true, activity: "idle" },
    }).then(() => presence({ ...base, leave: true }));
  }

  function actualLogPath(runId: string, storedPath?: string): string {
    const expected = join(options.stateDir(), "run-logs", `${runId}.log`);
    if (!storedPath) return expected;
    return storedPath.replaceAll(RUN_ID_LOG_TOKEN, runId);
  }

  function logPathTemplate(): string {
    return join(options.stateDir(), "run-logs", `${RUN_ID_LOG_TOKEN}.log`);
  }

  async function markRunFailureHandled(
    workspace: ChatDispatchWorkspace,
    run: AgentRunRecord,
  ): Promise<void> {
    const dispatch = options.dispatchStoreFor(workspace);
    const current = await dispatch.getRunRecord(
      run.runId,
      durableDispatchRequest,
    );
    if (current?.failureHandled) return;
    await dispatch.markFailureHandled(run.runId, durableDispatchRequest);
  }

  async function clearLiveAttribution(live: LiveRun): Promise<void> {
    await options.setRunAttribution(live.workspace, null);
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
            scheduleRecoveryScan(live.workspace);
          }
        }
        if (intent.exitCode !== 0) {
          await markRunFailureHandled(live.workspace, live.claim.run).catch(reportError);
        } else if (linkedMessages?.length === 0) {
          if (
            runMessageLinkPending(
              live.workspace,
              live.claim.run.runId,
            )
          ) {
            pendingNoReplyChecks.set(
              runKey(live.workspace.workspaceId, live.claim.run.runId),
              { workspace: live.workspace, run: live.claim.run },
            );
            scheduleRecoveryScan(live.workspace);
          } else {
            await markRunFailureHandled(live.workspace, live.claim.run).catch(reportError);
          }
        }
      }
      try {
        await oweRunNotice(live.workspace, live.claim.run.runId);
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
        notifyRunUpdated(live.workspace);
        await settleRunNotice(live.workspace, live.claim.run.runId);
      } catch (error) {
        reportError(error);
        scheduleRecoveryScan(live.workspace);
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
      reason: `${RUN_TIMEOUT} ${live.timeoutMinutes}m`,
    };
    live.killEscalation = terminateWithEscalation(
      live.child,
      live.killEscalation,
    );
    const dispatch = options.dispatchStoreFor(live.workspace);
    await markRunFailureHandled(live.workspace, live.claim.run).catch(reportError);
    try {
      await oweRunNotice(live.workspace, live.claim.run.runId);
      await dispatch.failRun({
        runId: live.claim.run.runId,
        exitCode: 124,
        reason: `${RUN_TIMEOUT} ${live.timeoutMinutes}m`,
      });
      live.terminalDurable = true;
      notifyRunUpdated(live.workspace);
      await settleRunNotice(live.workspace, live.claim.run.runId);
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(live.workspace);
    }
  }

  // Records that a run's notice is owed. Every run's end is saved only
  // after this succeeds, so a failure here holds the end back like a failed
  // save, and the recovery scan tries both again.
  async function oweRunNotice(workspace: ChatDispatchWorkspace, runId: string): Promise<void> {
    await options.runNotices?.owed.add(workspace.workspaceId, runId);
  }

  // Posts the notice for how an owed run ended, as its saved record says,
  // then drops it from the owed list. A run still open is left for the code
  // that ends it. A clean exit whose reply is not known yet, or a failed
  // read or post, stays owed for a later scan. The notice store ignores a
  // second post of the same id.
  async function settleRunNotice(workspace: ChatDispatchWorkspace, runId: string): Promise<void> {
    const notices = options.runNotices;
    if (!notices) return;
    const { workspaceId } = workspace;
    try {
      const dispatch = options.dispatchStoreFor(workspace);
      const run = await dispatch.getRunRecord(runId, durableDispatchRequest);
      if (run?.workspaceId === workspaceId) {
        if (run.endedAtMs === undefined) return;
        const saved = savedRunOutcome(run);
        let outcome: RunOutcome;
        if (saved !== "exited") {
          outcome = saved;
        } else if (run.failureHandled) {
          // The no-reply check already handled this run.
          outcome = "no-reply";
        } else if (runMessageLinkPending(workspace, runId)) {
          scheduleRecoveryScan(workspace);
          return;
        } else {
          const linked = await dispatch.listRunMessages(workspaceId, runId, durableDispatchRequest);
          outcome = linked.length === 0 ? "no-reply" : "finished";
        }
        // A request Restricted Mode stopped whose requeue landed before
        // dohc could drop the notice is back in line, so the notice is stale.
        if (outcome !== "restricted" || !(await backInLine(dispatch, run))) {
          await noticeRun(workspace, run, outcome);
        }
      }
      await notices.owed.remove(workspaceId, runId);
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(workspace);
    }
  }

  // Whether a run's own request is pending again. A later run in its
  // thread does not cover it: the engine coalesces only pending requests.
  async function backInLine(dispatch: AwaitableAgentDispatchStore, run: AgentRunRecord): Promise<boolean> {
    return (await dispatch.listPending(run.workspaceId))
      .some((each) => each.triggerMessageId === run.triggerMessageId);
  }

  // Posts every notice this workspace still owes, after a crash or a failed
  // post. A live run's notice waits for its end to be saved.
  async function recoverRunNotices(workspace: ChatDispatchWorkspace): Promise<void> {
    const notices = options.runNotices;
    if (!notices) return;
    let owed: string[];
    try {
      owed = await notices.owed.list(workspace.workspaceId);
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(workspace);
      return;
    }
    const live = liveRuns.get(workspace.workspaceId);
    for (const runId of owed) {
      if (live?.claim.run.runId === runId && !live.terminalDurable) continue;
      await settleRunNotice(workspace, runId);
    }
  }

  // Tells this computer's person how a run ended.
  async function noticeRun(
    workspace: ChatDispatchWorkspace,
    run: AgentRunRecord,
    outcome: RunOutcome,
  ): Promise<void> {
    if (!options.runNotices) return;
    const { workspaceId } = workspace;
    let nodeAvailable: ReplyRuntimeAvailability | undefined;
    if (outcome === "failed" || outcome === "no-reply") {
      nodeAvailable = await readRunnerNodeAvailable(actualLogPath(run.runId, run.logPath));
      if (nodeAvailable?.source === "path" && !nodeAvailable.available && outcome === "failed") {
        const replies = await options.dispatchStoreFor(workspace)
          .listRunMessages(workspaceId, run.runId, durableDispatchRequest);
        if (replies.length > 0) nodeAvailable = undefined;
      }
    }
    await options.runNotices.post({
      workspaceId,
      noticeId: `agent-run:${workspaceId}:${run.runId}`,
      kind: "agent-run",
      title: runNoticeTitle(outcome, await threadTitle(workspace, run.threadId)),
      body: runNoticeBody(run, outcome, nodeAvailable),
      target: { thread: run.threadId, run: run.runId },
    });
  }

  // The thread's title, read from its own channel's threads. An empty title
  // when that read fails or the thread has no channel: the notice still goes.
  async function threadTitle(workspace: ChatDispatchWorkspace, threadId: string): Promise<string> {
    try {
      const store = options.chatStoreFor(workspace);
      const { workspaceId } = workspace;
      const channelId = await store.findThreadChannelId({ workspaceId, threadId });
      if (!channelId) return "";
      const threads = await store.listChannelThreads({ workspaceId, channelId });
      return threads.find((summary) => summary.thread.id === threadId)?.thread.title.replace(/\s+/gu, " ").trim() ?? "";
    } catch (error) {
      reportError(error);
      return "";
    }
  }


  async function failClaimBeforeRun(failure: PendingPreRunFailure): Promise<void> {
    // A daemon restart can reject attribution teardown after the claim has
    // reserved this workspace but before a child exists. Retry once, then
    // finish the failed claim even if capture remains unavailable: the next
    // run overwrites attribution before it can spawn, while retaining the
    // in-memory reservation would deadlock dispatch until app quit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.setRunAttribution(failure.workspace, null);
        break;
      } catch (error) {
        reportError(error);
      }
    }
    await markRunFailureHandled(failure.workspace, failure.claim.run).catch(reportError);
    await endPreRunFailure(failure);
  }

  // Saves the run's end, then tells the person. A request Restricted Mode
  // stopped goes back in line when the engine still allows it an attempt;
  // its notice is owed from before the end is saved, so a crash before the
  // requeue still tells the person, and it is dropped unseen once the
  // requeue lands.
  async function endPreRunFailure(failure: PendingPreRunFailure): Promise<void> {
    const { workspace } = failure;
    const { runId, triggerMessageId, agentId } = failure.claim.run;
    if (!failure.failed) {
      await oweRunNotice(workspace, runId);
      await options.dispatchStoreFor(workspace).failRun({ runId, reason: failure.reason });
      failure.failed = true;
      notifyRunUpdated(workspace);
    }
    const requeued = failure.requeue && (await options.requeueFailedTrigger?.({
      workspaceId: workspace.workspaceId,
      ...(workspace.attachmentId ? { attachmentId: workspace.attachmentId } : {}),
      triggerMessageId,
      agentId,
      runId,
    })) === true;
    if (requeued) await options.runNotices?.owed.remove(workspace.workspaceId, runId).catch(reportError);
    else await settleRunNotice(workspace, runId);
  }

  async function recoverPreRunFailure(
    recovery: PendingPreRunFailure,
  ): Promise<boolean> {
    try {
      await endPreRunFailure(recovery);
      if (
        pendingPreRunFailures.get(recovery.workspace.workspaceId) === recovery
      ) {
        pendingPreRunFailures.delete(recovery.workspace.workspaceId);
      }
      await releaseWorkspaceLease(recovery.releaseWorkspace);
      recovery.releaseWorkspace = null;
      return true;
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(recovery.workspace);
      return false;
    }
  }

  async function startClaim(
    workspace: ChatDispatchWorkspace,
    claim: AgentDispatchClaim,
    agent: AgentWithLaunch | undefined,
    releaseWorkspace: (() => Promise<void>) | null,
    assertMayStart: () => void,
  ): Promise<void> {
    const dispatch = options.dispatchStoreFor(workspace);
    const logPath = actualLogPath(claim.run.runId, claim.run.logPath);
    runReservations.add(workspace.workspaceId);
    try {
      // A claim from before a lost response can name an agent turned off since.
      if (!agent) throw new Error("this agent is off or no longer set up");
      await options.setRunAttribution(workspace, {
        agentId: agent.id,
        agentRunId: claim.run.runId,
        depth: claim.chainDepth,
        dispatch: "run",
      });
      const markdown = await buildRunnerThreadContext({
        dispatchStore: dispatch,
        store: options.chatStoreFor(workspace),
        workspaceId: workspace.workspaceId,
        threadId: claim.run.threadId,
      });
      if (stopped) {
        throw new Error("dohc is quitting before the runner can start.");
      }
      const child = spawnConfiguredRunner({
        rootPath: workspace.rootPath,
        threadId: claim.run.threadId,
        runId: claim.run.runId,
        logPath,
        command: launchCommand(agent.launch),
        profile: launchProfile(agent.launch),
        prompt: buildRunnerPrompt(markdown, claim.run.threadId, claim.run.runId, launchProfile(agent.launch)?.tool),
        assertMayStart,
      });
      const timeout = setTimeout(() => {
        void enqueue(workspace.workspaceId, () => timeOutLiveRun(live));
      }, agent.timeoutMinutes * 60_000);
      const live: LiveRun = {
        workspace,
        claim,
        agentName: agent.name,
        child,
        logPath,
        timeoutMinutes: agent.timeoutMinutes,
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
      child.onExit((code, signal) => {
        void enqueue(workspace.workspaceId, async () => {
          if (await finishLiveRun(live, code, signal)) {
            await scanAndDrain(live.workspace);
          }
        });
      });
      child.onError((error) => {
        reportError(error);
        void enqueue(workspace.workspaceId, async () => {
          if (await finishLiveRun(live, 1, null)) {
            await scanAndDrain(live.workspace);
          }
        });
      });
      notifyRunUpdated(workspace);
      const publishWorking = () =>
        presence(
          workingPresenceInput(
            workspace,
            claim.run.threadId,
            agent.name,
          ),
        );
      void publishWorking();
      live.presenceHeartbeat = setInterval(() => {
        void publishWorking();
      }, PRESENCE_HEARTBEAT_MS);
    } catch (error) {
      runReservations.delete(workspace.workspaceId);
      reportError(error);
      // A restrict that landed while the run was starting stops it here. Its
      // request goes back in line, where the next drain holds it, or starts
      // it when the workspace is trusted again. That costs one attempt; when
      // the engine allows no more, it stays failed, and the person is told.
      const restricted = error instanceof WorkspaceRestrictedError;
      const detail =
        error instanceof Error && error.message ? error.message : "unknown error";
      const failure: PendingPreRunFailure = {
        workspace,
        claim,
        reason: restricted ? RESTRICTED_AT_START : `${RUNNER_START_FAILURE}: ${detail}`,
        releaseWorkspace,
        requeue: restricted,
        failed: false,
      };
      try {
        await failClaimBeforeRun(failure);
        await releaseWorkspaceLease(releaseWorkspace);
      } catch (persistenceError) {
        reportError(persistenceError);
        pendingPreRunFailures.set(workspace.workspaceId, failure);
        scheduleRecoveryScan(workspace);
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
      workspaceProcessReserved(workspace)
    ) {
      return;
    }
    const agents = await options.readDispatchAgents();
    const runnable = new Map<string, AgentWithLaunch>();
    for (const agent of agents) {
      if (agent.enabled && agent.launch) runnable.set(agent.id, { ...agent, launch: agent.launch });
    }
    const dispatch = options.dispatchStoreFor(workspace);
    // A request for an agent this computer cannot start fails here, so it
    // does not wait in line forever. Each agent's requests fail on their own.
    const listed = await dispatch.listPending(workspace.workspaceId);
    const unrunnable = new Map<string, { threadId: string; agentId: string }>();
    for (const pending of listed) {
      if (!runnable.has(pending.agentId)) {
        unrunnable.set(`${pending.threadId}\u0000${pending.agentId}`, pending);
      }
    }
    for (const { threadId, agentId } of unrunnable.values()) {
      const failedCount = await dispatch.failPendingForThread({
        workspaceId: workspace.workspaceId,
        threadId,
        agentId,
        reason: "no-runner",
      });
      if (failedCount === 0) continue;
      notifyRunUpdated(workspace);
      const agent = agents.find(({ id }) => id === agentId);
      const why = !agent
        ? "That agent is not set up on this computer."
        : agent.launch ? `${agent.name} is off.` : "No agent runner is configured.";
      try {
        options.onDispatchNotice?.(workspace, {
          reason: "no-runner", threadId,
          message: `No agent could take this request. ${why} Set up agent dispatch in Settings → Agents.`,
        });
      } catch (error) {
        reportError(error);
      }
    }
    if (runnable.size === 0) return;
    const assertMayStart = await agentStartCheck(workspace);
    if (!assertMayStart) {
      await holdForTrust(workspace, dispatch);
      return;
    }
    if (stopped || paused || workspaceProcessReserved(workspace)) {
      return;
    }
    const pending = listed.filter(({ agentId }) => runnable.has(agentId));
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
    // The engine claims the oldest request in a thread that is not paused,
    // so its agent's command is the one the claim records.
    const next = pending.find(({ threadId }) => pauseStates.get(threadId)?.paused !== true);
    const nextAgent = (next && runnable.get(next.agentId)) ?? [...runnable.values()][0]!;
    if (dispatch.resolveUncertainClaim) {
      runReservations.add(workspace.workspaceId);
      let uncertainClaim: AgentDispatchClaim | null;
      try {
        uncertainClaim = await dispatch.resolveUncertainClaim(
          workspace.workspaceId,
          {
            command: launchCommand(nextAgent.launch),
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
        await startClaim(workspace, uncertainClaim, runnable.get(uncertainClaim.run.agentId), releaseWorkspace, assertMayStart);
        return;
      }
      runReservations.delete(workspace.workspaceId);
    }
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
        notifyRunUpdated(workspace);
        try {
          options.onDispatchNotice?.(workspace, {
            reason: "budget-paused", threadId: candidate.threadId,
            message: `Agent dispatch paused after 10 runs in 10 minutes. Open "${await threadTitle(workspace, candidate.threadId) || candidate.threadId}" and choose Resume to continue.`,
          });
        } catch (error) {
          reportError(error);
        }
        continue;
      }
      if (stopped || paused || workspaceProcessReserved(workspace)) {
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
          command: launchCommand(runnable.get(candidate.agentId)!.launch),
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
      await startClaim(workspace, claim, runnable.get(claim.run.agentId), releaseWorkspace, assertMayStart);
      return;
    }
  }

  // Each agent dohc can start has its own chat. A background pass must not
  // create a chat for an agent that is off. One agent's chat that cannot be
  // made does not keep the others from theirs, and a later scan tries again.
  async function ensureAgentChats(workspace: ChatDispatchWorkspace): Promise<void> {
    for (const agent of await options.readDispatchAgents()) {
      if (!agent.enabled || !agent.launch) continue;
      try {
        await options.chatStoreFor(workspace).ensureAgentChannel({
          workspaceId: workspace.workspaceId,
          agentId: agent.id,
          name: agent.name,
        });
      } catch (error) {
        reportError(error);
        scheduleRecoveryScan(workspace);
      }
    }
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
      scheduleRecoveryScan(recovery.workspace);
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
      if (linked.length === 0 && !claim.run.failureHandled) {
        await markRunFailureHandled(workspace, claim.run).catch(reportError);
      }
      await oweRunNotice(workspace, claim.run.runId);
      await dispatch.failRun({
        runId: claim.run.runId,
        reason: "app restart during run",
      });
      notifyRunUpdated(workspace);
      await settleRunNotice(workspace, claim.run.runId);
      if (claim.dispatch.attemptCount < 2) {
        if (
          !(await requeueInterruptedRun(workspace, {
            workspaceId: workspace.workspaceId,
            ...(workspace.attachmentId
              ? { attachmentId: workspace.attachmentId }
              : {}),
            triggerMessageId: claim.run.triggerMessageId,
            agentId: claim.run.agentId,
            runId: claim.run.runId,
          }))
        ) {
          return false;
        }
      }
    }
    const recoveries =
      (await options.listAppQuitRecoveries?.(workspace)) ?? [];
    for (const recovery of recoveries) {
      await oweRunNotice(workspace, recovery.run.runId);
      await settleRunNotice(workspace, recovery.run.runId);
      const linked = await dispatch.listRunMessages(
        workspace.workspaceId,
        recovery.run.runId,
        durableDispatchRequest,
      );
      if (linked.length > 0) {
        if (!recovery.run.failureHandled) {
          await dispatch.markFailureHandled(
            recovery.run.runId,
            durableDispatchRequest,
          );
        }
        continue;
      }
      if (!recovery.run.failureHandled) {
        await markRunFailureHandled(workspace, recovery.run).catch(reportError);
      }
      if (recovery.attemptCount < 2) {
        if (
          !(await requeueInterruptedRun(workspace, {
            workspaceId: workspace.workspaceId,
            ...(workspace.attachmentId
              ? { attachmentId: workspace.attachmentId }
              : {}),
            triggerMessageId: recovery.run.triggerMessageId,
            agentId: recovery.run.agentId,
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
          recovery.workspace,
          recovery.run.runId,
        )
      ) {
        scheduleRecoveryScan(workspace);
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
          await markRunFailureHandled(workspace, recovery.run);
        }
        pendingNoReplyChecks.delete(key);
      } catch (error) {
        reportError(error);
        scheduleRecoveryScan(workspace);
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
    await recoverRunNotices(workspace);
    if (!(await startupSweep(workspace))) return;
    await ensureAgentChats(workspace);
    await drain(workspace);
  }

  function scanWorkspace(
    workspaceId: string,
    expectedAttachmentId?: symbol,
  ): Promise<void> {
    // After stop, a scan neither queues nor looks up its workspace: quit may
    // already be closing workspace authority.
    if (stopped) return Promise.resolve();
    let scannedWorkspace: ChatDispatchWorkspace | null = null;
    const scan = enqueue(workspaceId, async () => {
      if (stopped) return;
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace) return;
      if (
        expectedAttachmentId !== undefined &&
        workspace.attachmentId !== expectedAttachmentId
      ) {
        return;
      }
      scannedWorkspace = workspace;
      await scanAndDrain(workspace);
    });
    void scan.catch(() => {
      if (scannedWorkspace) scheduleRecoveryScan(scannedWorkspace);
    });
    return scan;
  }

  async function pump(): Promise<void> {
    const workspaces = options.listSyncWorkspaces();
    await Promise.allSettled(
      workspaces.map(async (workspace) => {
        try {
          const ready = await options.queueSync(workspace);
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
          await scanWorkspace(workspace.workspaceId, workspace.attachmentId);
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
    const changed = paused !== next;
    paused = next;
    if (changed) {
      try {
        options.onPausedChanged?.(paused);
      } catch (error) {
        reportError(error);
      }
    }
    if (!paused && !stopped) {
      for (const workspace of options.listOpenWorkspaces()) {
        void scanWorkspace(workspace.workspaceId).catch(reportError);
      }
    }
  }

  async function stopAgentRun(
    workspaceId: string,
    expectedRunId: string,
  ): Promise<boolean> {
    let stoppedRun = false;
    await enqueue(workspaceId, async () => {
      const live = liveRuns.get(workspaceId);
      if (
        !live ||
        live.finalized ||
        live.claim.run.runId !== expectedRunId
      ) {
        return;
      }
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
      await oweRunNotice(live.workspace, live.claim.run.runId);
      await dispatch.failRun({
        runId: live.claim.run.runId,
        exitCode: APP_QUIT_EXIT_CODE,
        reason: "user-stop",
      });
      live.terminalDurable = true;
      await settleRunNotice(live.workspace, live.claim.run.runId);
      try {
        await markRunFailureHandled(live.workspace, live.claim.run);
      } catch (error) {
        reportError(error);
        await dispatch.markFailureHandled(
          live.claim.run.runId,
          durableDispatchRequest,
        );
      }
      notifyRunUpdated(live.workspace);
    });
    return stoppedRun;
  }

  function exitWithin(child: RunnerProcess, ms: number): Promise<boolean> {
    if (child.hasExited()) return Promise.resolve(true);
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit(child.hasExited()), ms);
      child.onExit(() => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });
  }

  // Whether main should ask the person to trust the workspace for their own
  // message: the dispatch holds it in Restricted Mode, and main's dialog has
  // not opened for it since its trust last changed. A trusted workspace
  // answers at once; a restricted one answers behind the scan the message's
  // post queued.
  async function waitsForTrust(workspaceId: string, messageId: string): Promise<boolean> {
    const workspace = options.workspaceFor(workspaceId);
    if (stopped || !workspace || told(workspaceId).asked || (await agentStartCheck(workspace))) return false;
    let waits = false;
    await enqueue(workspaceId, async () => {
      const current = options.workspaceFor(workspaceId);
      if (stopped || !current || told(workspaceId).asked) return;
      const pending = await options.dispatchStoreFor(current).listPending(workspaceId);
      waits = pending.some((each) => each.triggerMessageId === messageId) &&
        (await agentStartCheck(current)) === null;
    });
    return waits;
  }

  // Main's trust dialog opened for the workspace, by any path. Sends stop
  // asking until its trust changes.
  function trustAsked(workspaceId: string): void {
    told(workspaceId).asked = true;
  }
  const trustWasAsked = (workspaceId: string): boolean => toldOfRestriction.get(workspaceId)?.asked === true;

  // The workspace was trusted or restricted: a later hold tells the person
  // again, and their next held message asks again.
  function trustChanged(workspaceId: string): void {
    toldOfRestriction.delete(workspaceId);
  }

  // Restricted Mode stops the workspace's agent: its run, through the
  // person's own Stop, and a self-test. Resolves once each runner exited;
  // rejects when one outlived its kill. The caller has already restricted
  // the workspace, so no runner starts after this looks.
  async function stopForRestrictedMode(workspaceId: string): Promise<void> {
    const live = liveRuns.get(workspaceId);
    const test = selfTests.get(workspaceId);
    if (live && !live.finalized) {
      // A failed save of the run's end is retried when the runner exits.
      await stopAgentRun(workspaceId, live.claim.run.runId).catch(reportError);
    }
    await test?.cancel(SELF_TEST_RESTRICTED_DETAIL);
    const exits = await Promise.all(
      [live?.child, test?.child].map((child) => child ? exitWithin(child, RUNNER_KILL_GRACE_MS + 1_000) : true),
    );
    if (exits.includes(false)) throw new Error(RUNNER_OUTLIVED_STOP);
  }

  async function resumeThreadDispatch(
    workspaceId: string,
    threadId: string,
  ): Promise<void> {
    await enqueue(workspaceId, async () => {
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace) throw new Error("This workspace is not open. Open it again.");
      await options.dispatchStoreFor(workspace).setThreadDispatchPaused({
        workspaceId,
        threadId,
        paused: false,
      });
      notifyRunUpdated(workspace);
      budgetBypassThreads.add(threadKey(workspaceId, threadId));
      await scanAndDrain(workspace);
    });
  }

  async function dispatchStateForThread(
    workspaceId: string,
    threadId: string,
  ): Promise<ChatDispatchThreadState> {
    const workspace = options.workspaceFor(workspaceId);
    if (!workspace) throw new Error("This workspace is not open. Open it again.");
    const dispatch = options.dispatchStoreFor(workspace);
    const [pauseState, pending] = await Promise.all([
      dispatch.getThreadDispatchPauseState(workspaceId, threadId),
      dispatch.listPending(workspaceId),
    ]);
    const live = liveRuns.get(workspaceId);
    return {
      liveRunId:
        live?.claim.run.threadId === threadId && live.finalized === false
          ? live.claim.run.runId
          : null,
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
      workspaceProcessReserved(workspace)
    ) {
      return { ok: false, detail: "A runner is already active in this workspace." };
    }
    selfTestReservations.add(workspaceId);
    let reservationHeldByProcess = false;
    let releaseWorkspace: (() => Promise<void>) | null = null;
    try {
      // The self-test checks the first agent dohc can start.
      const agent = (await options.readDispatchAgents()).find((candidate) => candidate.launch);
      if (!agent?.launch) return { ok: false, detail: "Configure a runner command first." };
      const command = launchCommand(agent.launch);
      const assertMayStart = await agentStartCheck(workspace);
      if (!assertMayStart) return { ok: false, detail: SELF_TEST_RESTRICTED_DETAIL };

      // A self-test spawns a real runner and writes a scratch thread, so it
      // takes the same run lease and engine gate as a claimed run. A workspace
      // without a capture refuses here, before chatStoreFor opens the engine.
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
      const agentChannel = await chat.ensureAgentChannel({ workspaceId, agentId: agent.id, name: agent.name });
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
          opening?.author.kind === "human" &&
          opening.body === SELF_TEST_OPENING
        ) {
          scratchThreadId = summary.thread.id;
          break;
        }
      }
      const runId = `run_self_test_${createId()}`;
      const marker = `${SELF_TEST_MARKER_PREFIX}${runId}`;
      const logPath = join(options.stateDir(), "run-logs", `${runId}.log`);
      try {
        if (
          shuttingDown ||
          liveRuns.has(workspaceId) ||
          runReservations.has(workspaceId) ||
          selfTests.has(workspaceId) ||
          options.runSlotOccupied?.(workspace) === true
        ) {
          return {
            ok: false,
            detail: shuttingDown
              ? "Agent dispatch is stopping."
              : "A runner became active before the self-test could start.",
          };
        }
        assertMayStart();
        const threadId = scratchThreadId ?? await options.startSelfTestThread(workspace, {
          channelId: agentChannel.id,
          title: SELF_TEST_THREAD_TITLE,
          body: SELF_TEST_OPENING,
        });
        if (shuttingDown) return { ok: false, detail: "Agent dispatch is stopping." };
        if (liveRuns.has(workspaceId) || runReservations.has(workspaceId) || selfTests.has(workspaceId) || options.runSlotOccupied?.(workspace) === true) {
          return { ok: false, detail: "A runner became active before the self-test could start." };
        }
        // The same reply form as a real run, so passing proves replies work.
        const prompt = replyFormFor(launchProfile(agent.launch)?.tool) === "mcp"
          ? `This is a dohc runner self-test. Call ${replyToolCall(threadId, runId)} once, with \`body\` \`${marker}\`, and do not post another message.`
          : `This is a dohc runner self-test. Run exactly this command and do not post another message:\n\n${replyCommand(threadId, marker)}`;
        await options.setRunAttribution(workspace, {
          agentId: agent.id,
          agentRunId: runId,
          depth: 0,
          dispatch: "self-test",
        });
        const child = spawnConfiguredRunner({
          rootPath: workspace.rootPath,
          threadId,
          runId,
          logPath,
          command,
          profile: launchProfile(agent.launch),
          prompt,
          assertMayStart,
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
            // A restrict finds the runner until it has exited. A runner that
            // outlived the kill grace has already given up its reservation,
            // so its exit is what lets held requests start.
            const forget = () => {
              if (selfTests.get(workspaceId) !== test) return;
              selfTests.delete(workspaceId);
              if (!selfTestReservations.has(workspaceId) && !stopped) {
                void scanWorkspace(workspaceId).catch(reportError);
              }
            };
            if (test.child.hasExited()) forget();
            else test.child.onExit(forget);
            try {
              await options.setRunAttribution(workspace, null);
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
              const messages = await chat.listMessages({ workspaceId, threadId });
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
            workspace,
            child,
            runId,
            settled: false,
            poll: null,
            timeout,
            killEscalation: null,
            resolve: resolveResult,
            cancel: (detail) => complete({ ok: false, detail }),
          };
          selfTests.set(workspaceId, state);
          child.onError((error) => {
            reportError(error);
            void complete({
              ok: false,
              detail: `Runner self-test failed to start. Log: ${logPath}`,
            });
          });
          child.onExit(() => {
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
          await options.setRunAttribution(workspace, null);
        } catch {
          // The self-test already failed; the caller reads that failure, not this one.
        }
        reportError(error);
        // A restrict that landed while the self-test was starting stops it here.
        if (error instanceof WorkspaceRestrictedError) return { ok: false, detail: SELF_TEST_RESTRICTED_DETAIL };
        return {
          ok: false,
          detail: `Runner self-test could not start. ${
            error instanceof Error && error.message ? `${error.message} ` : ""
          }Log: ${logPath}`,
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
        await options.setRunAttribution(test.workspace, null);
      } catch {
        // Ignore an attribution cleanup failure during quit; the next run
        // overwrites it.
      }
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
    betweenScans,
    stopAgentRun,
    stopForRestrictedMode,
    waitsForTrust,
    trustAsked,
    trustWasAsked,
    trustChanged,
    resumeThreadDispatch,
    dispatchStateForThread,
    runnerSelfTest,
    setPaused,
    isPaused: () => paused,
    hasLiveRun: (workspaceId: string) => {
      const workspace = options.workspaceFor(workspaceId);
      return workspace ? workspaceProcessReserved(workspace) : false;
    },
  };
}

export type ChatDispatchService = ReturnType<typeof createChatDispatchService>;
