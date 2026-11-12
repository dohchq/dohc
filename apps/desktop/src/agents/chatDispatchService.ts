import { nextStepWords, type ChatDispatchFailedRun, type ChatDispatchNextStep, type ChatDispatchNotice, type RunnerSelfTestResult } from "../ipc/bridgeContract";
import { AGENTS_RESTRICTED_MESSAGE, CLAUDE_MIN_VERSION, launchCommand, launchProfile, supportsAgentProfile, type AgentLaunchProfile } from "./agentToolCatalog";
import { NOTICE_BODY_MAX_CHARS, NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import { cutText } from "@dohc/workspace-contracts/names";
import type { PostNoticeInput } from "../notices/noticeStore";
import type { OwedRunNotices } from "./owedRunNotices";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createChatRunnerProcess,
  readRunnerNodeAvailable,
  RUNNER_KILL_GRACE_MS,
  type RunnerProcess,
  type ChatRunnerProcessOptions,
  type ReplyRuntimeAvailability,
  type RunDohcTools,
} from "./chatRunnerProcess";
import type {
  AgentDispatchClaim,
  AgentDispatchRecord,
  AgentRunRecord,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import type { Agent, AgentRunLogsSettings, AgentWithLaunch } from "../settings/userSettings";
import { markRunLogEnded, removeExpiredRunLogs } from "./runLogRetention";
import type { AgentRunDispatch } from "./activeAgentRun";
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AgentDispatchRequestOptions,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";
import { buildRunnerThreadContext } from "./runnerThreadContext";
import { handleForName } from "@dohc/workspace-contracts/chat-mentions";
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

const NOTICE_AGENT_NAME_MAX_CHARS = 32;

// The ways a run can end without the agent's reply. The conversation, the
// toast and Notices all say "Nova didn't reply" and why.
type FailedOutcome = Extract<RunOutcome, "failed" | "no-reply" | "timed-out" | "not-started" | "restarted" | "quit">;
const FAILED_OUTCOMES: ReadonlySet<RunOutcome> = new Set<FailedOutcome>([
  "failed", "no-reply", "timed-out", "not-started", "restarted", "quit",
]);
const isFailedOutcome = (outcome: RunOutcome): outcome is FailedOutcome => FAILED_OUTCOMES.has(outcome);

// A reply already posted must not be posted again. Quit and restart keep
// their existing recovery path, including runs that posted before the stop.
function canRepeatFailedRun(outcome: FailedOutcome, posted: boolean): boolean {
  return !posted || outcome === "quit" || outcome === "restarted";
}

// The agent's Settings name at 32 characters. An agent no longer in
// Settings is "Your agent".
function noticeAgentName(agentName: string | undefined): string {
  return agentName === undefined ? "Your agent" : cutText(agentName, NOTICE_AGENT_NAME_MAX_CHARS);
}

// What a run that ended with its reply, or with no failure of its own, says.
// An agent no longer in Settings is "your agent".
function endedRunTitle(outcome: Exclude<RunOutcome, FailedOutcome>, agentName: string | undefined): string {
  const agent = agentName === undefined ? undefined : noticeAgentName(agentName);
  const whose = `${agent ?? "your agent"}'s run`;
  return {
    finished: `${agent ?? "Your agent"} replied`,
    stopped: `Stopped ${agent === undefined ? "the run" : whose}`,
    restricted: `Restricted Mode blocked ${whose}`,
  }[outcome];
}

// "Atlas didn't reply in "Plan day 2"". What happened comes first and the
// thread last, so a clamp cuts only the thread's name.
function runNoticeTitle(what: string, thread: string): string {
  if (!thread) return what;
  return `${what} in "${cutText(thread, NOTICE_TITLE_MAX_CHARS - [...`${what} in ""`].length)}"`;
}

// Why a run didn't reply, as one sentence: the notice's body and the second
// half of the line under the message. A missing PATH runtime says to install
// Node.js. A body holds no control characters, or the notice store would
// refuse it.
function runFailureReason(run: AgentRunRecord, outcome: FailedOutcome, nodeAvailable?: ReplyRuntimeAvailability): string {
  if (needsNodeJs(outcome, nodeAvailable)) {
    return "Agent replies need Node.js. Install Node.js, restart dohc, then try again.";
  }
  switch (outcome) {
    case "failed":
      return "Its run ended with an error.";
    case "no-reply":
      return "Its run ended without a reply.";
    case "timed-out": {
      const minutes = /^\d+/u.exec(run.failureReason?.slice(`${RUN_TIMEOUT} `.length) ?? "")?.[0];
      return minutes ? `It ran past its ${minutes}-minute limit.` : "It ran past its time limit.";
    }
    case "restarted":
      return "dohc restarted during its run.";
    case "quit":
      return "dohc quit during its run.";
    case "not-started": {
      const detail = (run.failureReason ?? "")
        .slice(`${RUNNER_START_FAILURE}: `.length)
        .replace(/[\s\u0000-\u001f\u007f]+/gu, " ")
        .trim();
      const lead = "It couldn't start: ";
      if (!detail) return "It couldn't start.";
      return lead + cutText(detail, NOTICE_BODY_MAX_CHARS - lead.length);
    }
  }
}

function needsNodeJs(outcome: FailedOutcome, nodeAvailable?: ReplyRuntimeAvailability): boolean {
  return (outcome === "failed" || outcome === "no-reply") && nodeAvailable?.source === "path" && !nodeAvailable.available;
}

export const CHAT_DISPATCH_PUMP_MS = 15_000;
const CHAT_DISPATCH_BUDGET_WINDOW_MS = 10 * 60_000;
export const CHAT_DISPATCH_BUDGET_MAX = 10;
// A long title or name can't push the next step out of a notice.
const NOTICE_NAME_MAX_CHARS = 40;
export const RUNNER_SELF_TEST_TIMEOUT_MS = 120_000;
export const CHAT_DISPATCH_RECOVERY_BACKOFF_MS = 1_000;
const CHAT_DISPATCH_RECOVERY_MAX_BACKOFF_MS = 30_000;
export const RUN_ID_LOG_TOKEN = "{runId}";
export const RUN_LOG_SWEEP_MS = 24 * 60 * 60 * 1000;
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

function clip(name: string): string {
  return cutText(name, NOTICE_NAME_MAX_CHARS);
}

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
  // The version an agent's tool reports to --version, or null.
  agentToolVersion(executable: string): Promise<string | null>;
  listOpenWorkspaces(): ChatDispatchWorkspace[];
  listSyncWorkspaces(): ChatDispatchWorkspace[];
  chatStoreFor(workspace: ChatDispatchWorkspace): LinkedChatStore;
  // Starts the self-test's own thread in the agent DM, apart from its conversation.
  startSelfTestThread(workspace: ChatDispatchWorkspace, input: { channelId: string; title: string; body: string }): Promise<string>;
  dispatchStoreFor(
    workspace: ChatDispatchWorkspace,
  ): AwaitableAgentDispatchStore;
  // The person's agents, in the order the settings file lists them.
  readDispatchAgents(): Promise<Agent[]>;
  // How long the settings file keeps a finished run's log.
  readRunLogKeepDays?(): Promise<AgentRunLogsSettings["keepDays"]>;
  queueSync(workspace: ChatDispatchWorkspace): void | boolean | Promise<void | boolean>;
  prepareRunWorkspace?(
    workspace: ChatDispatchWorkspace,
  ): Promise<void | (() => Promise<void>)>;
  // The thread names the chat target, so a shared-channel push can cover the
  // channel this message landed in instead of waiting for the sync rotation.
  onMessagePosted(workspace: ChatDispatchWorkspace, threadId: string): void;
  onRunUpdated?(workspace: ChatDispatchWorkspace): void;
  // A request to answer a message started waiting, started running, failed or
  // finished. The group is the thread's; null when the change spans groups.
  onAgentRequestsChanged?(workspace: ChatDispatchWorkspace, channelId: string | null): void;
  onPausedChanged?(paused: boolean): void;
  onDispatchNotice?(workspace: ChatDispatchWorkspace, notice: Omit<ChatDispatchNotice, "id">): void;
  // A paused thread resumed, so its pause notice is over.
  onThreadResumed?(workspace: ChatDispatchWorkspace, threadId: string): void;
  // Every write the agent makes while the run holds the slot is the run's,
  // at the run's chain depth, for the person main names.
  setRunAttribution(
    workspace: ChatDispatchWorkspace,
    run: { agentId: string; agentRunId: string; depth: number; dispatch: AgentRunDispatch; secret: string } | null,
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
  listFailedRunRecoveries?(
    workspace: ChatDispatchWorkspace,
    threadId?: string,
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

// A failed run shown under its request, with or without Try again.
interface StoppedRun {
  run: AgentRunRecord;
  outcome: FailedOutcome;
  attemptCount?: number;
  // Whether its attempts and posted replies allow the request to run again.
  retryable: boolean;
}

interface ChatDispatchThreadState {
  liveRunId: string | null;
  liveTriggerMessageId: string | null;
  pendingCount: number;
  paused: boolean;
  waiting?: { agentId: string; name: string; triggerMessageIds: string[] };
  failedRun?: ChatDispatchFailedRun;
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
  // The automation's run said it has nothing to report, so an end with no
  // reply is not a failure.
  quiet: boolean;
}

// Why an automation's run cannot end with nothing to report.
export type QuietRunRefusal = "not-running" | "other-thread" | "person";

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

interface SelfTestState {
  workspace: ChatDispatchWorkspace;
  child: RunnerProcess;
  runId: string;
  settled: boolean;
  poll: ReturnType<typeof setTimeout> | null;
  timeout: ReturnType<typeof setTimeout>;
  killEscalation: ReturnType<typeof setTimeout> | null;
  resolve(result: RunnerSelfTestResult): void;
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

// A new secret for each run. Only the run's process gets it, so only its
// requests are the run's.
function runSecret(): string {
  return randomBytes(32).toString("hex");
}

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
// (agentToolCatalog.ts), and a Codex run doesn't trust the workspace
// (codexRunConfig.ts). Both leave out the workspace's instruction files.
// Both tools' profiles refuse anything that needs approval, so the run hears
// it before a refusal turns its reply into an explanation. A file chip,
// `@[path]`, opens from chat, and a link from `dohc_link` opens a chat,
// thread, message, or Collection. Only a run with every dohc tool hears of
// them.
function buildRunnerPrompt(
  threadMarkdown: string,
  threadId: string,
  runId: string,
  tool: AgentLaunchProfile["tool"] | undefined,
  dohcTools: RunDohcTools,
): string {
  const form = replyFormFor(tool);
  const instructionsFile = tool === "claude"
    ? "If the workspace has a CLAUDE.md or .claude/CLAUDE.md file, or an AGENTS.md file, at its root, read them first and follow them. "
    : tool === "codex"
      ? "If the workspace has an AGENTS.override.md file at its root, read it first and follow it. If it has none, do the same with an AGENTS.md file there. "
      : "";
  const workspaceTools = form === "mcp" && dohcTools === "all"
    ? "To make and change things in this workspace, such as files, documents, Collections and their records, and chats, use the tools of the `dohc` MCP server. "
    : "";
  const approvals = form === "mcp"
    ? "Nobody can approve actions during this run, so anything that needs approval is refused. Do what you can without it. "
    : "";
  const report = form === "mcp"
    ? "When you finish, reply in two to four sentences. Say what you made or changed, by name, and write each file as `@[path]`, with its path from the workspace root, so a person can open it. Don't explain how you did it. For each thing you couldn't do, write one line: what you couldn't do, then dohc's reason. Don't ask the person to approve anything, change a setting, or share their screen. "
    : "Report outcomes, not tool logs. ";
  const links = form === "mcp" && dohcTools === "all"
    ? "To link a chat, thread, message, or Collection, call `dohc_link` and write the `link` it returns. "
    : "";
  const replyInstruction = form === "mcp"
    ? `Reply in-thread by calling ${replyToolCall(threadId, runId)}, with your Markdown report as \`body\`.`
    : `Reply in-thread with \`${replyCommand(threadId, "<report>")}\`.`;
  // Only an automation's run hears of it; a person who asked gets a reply.
  const quiet = form === "mcp" && dohcTools === "reply"
    ? " An automation started this run. If you have nothing to report, call the same tool with `nothingToReport: true` and no `body` instead of replying, and post nothing."
    : "";
  const decisionInstruction = form === "mcp"
    ? "If blocked on the user, set `needsDecision`. To ask them to pick, list the choices in `options`; their answer arrives as the next message with the chosen option. Your final text is not shown anywhere; only messages you post through `dohc_reply_to_chat` are shown."
    : "If blocked on the user, reply with `--needs-decision`. To ask them to pick, add `--option \"<choice>\"` once per choice; their answer arrives as the next message with the chosen option. Your final text is not shown anywhere; only messages you post through `dohc chat` are shown.";
  return `${threadMarkdown.trimEnd()}

## Report contract

${instructionsFile}Work on the request represented by this thread. ${workspaceTools}${approvals}${report}${links}${replyInstruction}${quiet} On long tasks, post progress the way a teammate would. ${decisionInstruction}`;
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
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let runLogSweepTimer: ReturnType<typeof setInterval> | null = null;
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

  function notifyRunUpdated(workspace: ChatDispatchWorkspace, threadId?: string): void {
    try {
      options.onRunUpdated?.(workspace);
    } catch (error) {
      reportError(error);
    }
    const onAgentRequestsChanged = options.onAgentRequestsChanged;
    if (!onAgentRequestsChanged) return;
    // A closed workspace's store throws before it returns a promise.
    void (threadId === undefined
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => options.chatStoreFor(workspace)
            .findThreadChannelId({ workspaceId: workspace.workspaceId, threadId }))
          .catch(() => null)
    ).then((channelId) => onAgentRequestsChanged(workspace, channelId)).catch(reportError);
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

  // A reply whose link is still being written counts as posted.
  async function runPosted(workspace: ChatDispatchWorkspace, runId: string): Promise<boolean> {
    return runMessageLinkPending(workspace, runId) || (await options.dispatchStoreFor(workspace)
      .listRunMessages(workspace.workspaceId, runId, durableDispatchRequest)).length > 0;
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
    // A completed run's request reads as failed from here.
    notifyRunUpdated(workspace, run.threadId);
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
      // A quiet run that posts nothing ends with no notice. Nothing is owed,
      // so recovery after a crash finds nothing to mark failed.
      let quietEnd = false;
      if (intent.kind === "complete") {
        try {
          linkedMessages = await dispatch.listRunMessages(
            live.workspace.workspaceId,
            live.claim.run.runId,
            durableDispatchRequest,
          );
        } catch (error) {
          reportError(error);
          // A quiet run is finished either way; an unread reply loses only
          // its notice.
          if (intent.exitCode === 0 && live.quiet) quietEnd = true;
          else if (intent.exitCode === 0) {
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
          } else if (live.quiet) {
            quietEnd = true;
          } else {
            await markRunFailureHandled(live.workspace, live.claim.run).catch(reportError);
          }
        }
      }
      try {
        if (!quietEnd) await oweRunNotice(live.workspace, live.claim.run.runId);
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
        notifyRunUpdated(live.workspace, live.claim.run.threadId);
        if (!quietEnd) await settleRunNotice(live.workspace, live.claim.run.runId);
      } catch (error) {
        reportError(error);
        scheduleRecoveryScan(live.workspace);
        return false;
      }
    }
    if (!live.child.hasExited()) return false;
    await markRunLogEnded(live.logPath, nowMs()).catch(reportError);
    await clearLiveAttribution(live);
    liveRuns.delete(live.workspace.workspaceId);
    // Try again waits for the process to exit, so read the run again.
    notifyRunUpdated(live.workspace, live.claim.run.threadId);
    await releaseLiveWorkspace(live);
    return true;
  }

  // An automation's run with nothing to report says so before it ends. A run
  // a person's message started owes them a reply.
  function endRunQuietly(workspaceId: string, runId: string, threadId: string): QuietRunRefusal | null {
    const live = liveRuns.get(workspaceId);
    if (!live || live.claim.run.runId !== runId || live.finalized) return "not-running";
    if (live.claim.run.threadId !== threadId) return "other-thread";
    if (live.claim.chainDepth === 0) return "person";
    live.quiet = true;
    return null;
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
      notifyRunUpdated(live.workspace, live.claim.run.threadId);
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
        let reply: string | undefined;
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
          reply = linked.at(-1);
          // After a restart, no in-memory check is left to mark it failed.
          if (outcome === "no-reply") await markRunFailureHandled(workspace, run);
        }
        // A request Restricted Mode stopped whose requeue landed before
        // dohc could drop the notice is back in line, so the notice is stale.
        if (outcome !== "restricted" || !(await backInLine(dispatch, run))) {
          await noticeRun(workspace, run, outcome, reply);
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
  // Another agent's request for the same message is not this run's.
  async function backInLine(dispatch: AwaitableAgentDispatchStore, run: AgentRunRecord): Promise<boolean> {
    return (await dispatch.listPending(run.workspaceId))
      .some((each) => each.triggerMessageId === run.triggerMessageId && each.agentId === run.agentId);
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

  // Tells this computer's person how a run ended. A finished run's notice
  // names one of the agent's replies, so a chat showing it can skip the notice.
  async function noticeRun(
    workspace: ChatDispatchWorkspace,
    run: AgentRunRecord,
    outcome: RunOutcome,
    reply?: string,
  ): Promise<void> {
    if (!options.runNotices) return;
    const { workspaceId } = workspace;
    const agent = (await options.readDispatchAgents()).find(({ id }) => id === run.agentId);
    const words: { lead: string; reason: string; nextStep?: ChatDispatchNextStep } = isFailedOutcome(outcome)
      ? await failureWords(workspace, run, outcome, agent)
      : { lead: endedRunTitle(outcome, agent?.name), reason: "" };
    // The toast and Notices row end with the step under the message, worded
    // for the chat it shows in. Only a very long agent name reaches the cut.
    let body = words.reason;
    if (words.nextStep) {
      try {
        const { channel } = await options.chatStoreFor(workspace).getThread({ workspaceId, threadId: run.threadId });
        const step = nextStepWords(words.nextStep, channel?.kind === "agent" ? channel.agentId : undefined);
        body = cutText(`${words.reason} ${step}`, NOTICE_BODY_MAX_CHARS);
      } catch (error) {
        reportError(error);
      }
    }
    await options.runNotices.post({
      workspaceId,
      noticeId: `agent-run:${workspaceId}:${run.runId}`,
      kind: "agent-run",
      title: runNoticeTitle(words.lead, await threadTitle(workspace, run.threadId)),
      body,
      target: { thread: run.threadId, run: run.runId, ...(reply !== undefined ? { message: reply } : {}) },
    });
  }

  // How a run without its reply reads: "Nova didn't reply", or "Nova
  // stopped before finishing" once it posted, and why. A missing Node.js is
  // the reason only for a run that posted nothing, since one that posted
  // found it.
  async function failureWords(
    workspace: ChatDispatchWorkspace,
    run: AgentRunRecord,
    outcome: FailedOutcome,
    agent: Agent | undefined,
    attemptCount?: number,
  ): Promise<{ lead: string; reason: string; nextStep?: ChatDispatchNextStep }> {
    const posted = outcome !== "no-reply" && outcome !== "not-started" && await runPosted(workspace, run.runId);
    const nodeAvailable = !posted && (outcome === "failed" || outcome === "no-reply")
      ? await readRunnerNodeAvailable(actualLogPath(run.runId, run.logPath))
      : undefined;
    const words = {
      lead: `${noticeAgentName(agent?.name)} ${posted ? "stopped before finishing" : "didn't reply"}`,
      reason: runFailureReason(run, outcome, nodeAvailable),
    };
    // A run that couldn't start or needs Node.js has its own next step.
    if (outcome === "not-started" || needsNodeJs(outcome, nodeAvailable)) return words;
    // Try again stays until the request has had two attempts, unless
    // running it again would repeat what it posted.
    if (canRepeatFailedRun(outcome, posted)) {
      let attempts = attemptCount;
      try {
        attempts ??= (await options.listFailedRunRecoveries?.(workspace, run.threadId))
          ?.find((each) => each.run.runId === run.runId)?.attemptCount;
      } catch (error) {
        reportError(error);
        return words;
      }
      if (attempts === undefined || attempts < 2) return words;
    }
    // Otherwise the person asks the agent again, in a message the chat
    // words, with the @handle the composer inserts. A message won't wake an
    // agent that's gone or an agent dohc starts that's off, so its step is in
    // Settings, in the order its DM checks them, by the full name its DM and
    // Settings show. An agent you run reads the message once it's connected.
    const handle = agent ? handleForName(agent.name) : "";
    const nextStep: ChatDispatchNextStep = !agent ? { kind: "add-agent" }
      : agent.launch && !agent.enabled ? { kind: "turn-on", name: agent.name }
      : { kind: "message", agentId: agent.id, name: agent.name, ...(handle ? { handle } : {}) };
    return { ...words, nextStep };
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

  // What the person opens to resume, named as chat names it and cut short: a
  // post by its title, a conversation by its place, the agent's current name
  // in its DM and #group elsewhere. Its group lets Open land on it.
  async function pausedThread(
    workspace: ChatDispatchWorkspace,
    threadId: string,
  ): Promise<{ place: string; channelId?: string }> {
    try {
      const { workspaceId } = workspace;
      const { thread, channel } = await options.chatStoreFor(workspace).getThread({ workspaceId, threadId });
      const agentName = async (agentId: string | undefined) =>
        (await options.readDispatchAgents()).find(({ id }) => id === agentId)?.name;
      const place = !channel || thread.lane !== "chat" ? `"${clip(thread.title.replace(/\s+/gu, " ").trim() || threadId)}"`
        : channel.kind === "agent" ? `"${clip(await agentName(channel.agentId) ?? channel.name)}"`
          : `#${clip(channel.name)}`;
      return { place, ...(channel ? { channelId: channel.id } : {}) };
    } catch (error) {
      reportError(error);
      return { place: `"${threadId}"` };
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
      // A launch that failed can leave its log or MCP config behind.
      await markRunLogEnded(actualLogPath(runId, failure.claim.run.logPath), nowMs()).catch(reportError);
      notifyRunUpdated(workspace, failure.claim.run.threadId);
    }
    const requeued = failure.requeue && (await options.requeueFailedTrigger?.({
      workspaceId: workspace.workspaceId,
      ...(workspace.attachmentId ? { attachmentId: workspace.attachmentId } : {}),
      triggerMessageId,
      agentId,
      runId,
    })) === true;
    if (requeued) {
      notifyRunUpdated(workspace, failure.claim.run.threadId);
      await options.runNotices?.owed.remove(workspace.workspaceId, runId).catch(reportError);
    } else await settleRunNotice(workspace, runId);
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
      const profile = launchProfile(agent.launch);
      // dohc can't hold a person's own command to the reply tool, so an
      // automation starts only Claude Code or Codex.
      if (!profile && claim.chainDepth > 0) throw new Error("an automation can start only an agent that uses Claude Code or Codex");
      if (profile?.tool === "claude" && !supportsAgentProfile("claude", await options.agentToolVersion(profile.executable))) {
        throw new Error(`update Claude Code to ${CLAUDE_MIN_VERSION} or later to use this agent`);
      }
      const secret = runSecret();
      await options.setRunAttribution(workspace, {
        agentId: agent.id,
        agentRunId: claim.run.runId,
        depth: claim.chainDepth,
        dispatch: "run",
        secret,
      });
      // Only people's own messages, which only the owner's send records,
      // start a run at depth 0. A run an automation started gets the reply
      // tool and can't write.
      const dohcTools: RunDohcTools = claim.chainDepth === 0 ? "all" : "reply";
      const markdown = await buildRunnerThreadContext({
        dispatchStore: dispatch,
        store: options.chatStoreFor(workspace),
        workspaceId: workspace.workspaceId,
        threadId: claim.run.threadId,
        askingMessageId: claim.run.triggerMessageId,
        ...(replyFormFor(profile?.tool) === "argument"
          ? { readEarlier: `dohc chat show ${claim.run.threadId} --peek` }
          : dohcTools === "all" ? { readEarlier: "dohc_read_chat" } : {}),
      });
      if (stopped) {
        throw new Error("dohc is quitting before the runner can start.");
      }
      const child = await spawnConfiguredRunner({
        rootPath: workspace.rootPath,
        threadId: claim.run.threadId,
        runId: claim.run.runId,
        agentName: agent.name,
        logPath,
        command: launchCommand(agent.launch),
        profile,
        dohcTools,
        prompt: buildRunnerPrompt(markdown, claim.run.threadId, claim.run.runId, profile?.tool, dohcTools),
        runSecret: secret,
        // A reply-only Codex run checks its servers first, and dohc can start
        // quitting meanwhile.
        assertMayStart: () => {
          if (stopped) throw new Error("dohc is quitting before the runner can start.");
          assertMayStart();
        },
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
        quiet: false,
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
      notifyRunUpdated(workspace, claim.run.threadId);
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
      notifyRunUpdated(workspace, threadId);
      const agent = agents.find(({ id }) => id === agentId);
      // An agent you run reads its requests itself, so nothing is wrong to tell.
      if (agent && !agent.launch) continue;
      const message = !agent
        ? "That agent isn't set up on this computer. Set it up in Settings → Agents."
        : `${clip(agent.name)}'s chat runner is off. Turn it on in Settings → Agents.`;
      try {
        options.onDispatchNotice?.(workspace, { reason: "no-runner", threadId, message });
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
    // Scope each claim to the agent whose command it records.
    const next = pending.find(({ threadId }) => pauseStates.get(threadId)?.paused !== true);
    const nextAgent = (next && runnable.get(next.agentId)) ?? [...runnable.values()][0]!;
    if (dispatch.resolveUncertainClaim) {
      runReservations.add(workspace.workspaceId);
      let uncertainClaim: AgentDispatchClaim | null;
      try {
        uncertainClaim = await dispatch.resolveUncertainClaim(
          workspace.workspaceId,
          {
            agentId: nextAgent.id,
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
        notifyRunUpdated(workspace, candidate.threadId);
        try {
          const { place, channelId } = await pausedThread(workspace, candidate.threadId);
          options.onDispatchNotice?.(workspace, {
            reason: "budget-paused", threadId: candidate.threadId,
            ...(channelId ? { channelId } : {}),
            message: `Agents ran ${CHAT_DISPATCH_BUDGET_MAX} times in ${CHAT_DISPATCH_BUDGET_WINDOW_MS / 60_000} minutes in ${place}. Choose Resume there to continue.`,
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
          agentId: candidate.agentId,
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
        continue;
      }
      await startClaim(workspace, claim, runnable.get(claim.run.agentId), releaseWorkspace, assertMayStart);
      return;
    }
  }

  // Each agent dohc starts and each agent you run has its own chat. A
  // background pass must not create a chat for an agent dohc starts that is
  // off. One agent's chat that cannot be made does not keep the others from
  // theirs, and a later scan tries again.
  async function ensureAgentChats(workspace: ChatDispatchWorkspace): Promise<void> {
    for (const agent of await options.readDispatchAgents()) {
      if (agent.launch && !agent.enabled) continue;
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
      // Its recorded end is now, so cleanup counts its log's age from now.
      await markRunLogEnded(actualLogPath(claim.run.runId, claim.run.logPath), nowMs()).catch(reportError);
      notifyRunUpdated(workspace, claim.run.threadId);
      await settleRunNotice(workspace, claim.run.runId);
    }
    const recoveries =
      (await options.listFailedRunRecoveries?.(workspace)) ?? [];
    for (const recovery of recoveries) {
      const outcome = savedRunOutcome(recovery.run);
      if (outcome !== "quit" && outcome !== "restarted") continue;
      // A handled run's notice is already owed, by this sweep or an earlier
      // one. A stopped run stays in this list until someone tries it again.
      if (recovery.run.failureHandled) continue;
      await oweRunNotice(workspace, recovery.run.runId);
      await settleRunNotice(workspace, recovery.run.runId);
      const linked = await dispatch.listRunMessages(
        workspace.workspaceId,
        recovery.run.runId,
        durableDispatchRequest,
      );
      if (linked.length > 0) {
        await markRunFailureHandled(workspace, recovery.run);
      } else {
        await markRunFailureHandled(workspace, recovery.run).catch(reportError);
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
    const scans = options.listOpenWorkspaces().map((workspace) =>
      scanWorkspace(workspace.workspaceId).catch(reportError));
    pumpTimer = setInterval(() => {
      schedulePump();
    }, CHAT_DISPATCH_PUMP_MS);
    // Cleanup keeps any log whose run has no recorded end, so this order is
    // only tidiness: recovery records interrupted runs' ends first, and this
    // pass already counts them.
    void Promise.all(scans).then(() => sweepRunLogs());
    runLogSweepTimer = setInterval(() => void sweepRunLogs(), RUN_LOG_SWEEP_MS);
  }

  // At start and once a day, removes the logs of runs that ended longer ago
  // than the settings file keeps them. A running agent's log stays.
  async function sweepRunLogs(): Promise<void> {
    if (!options.readRunLogKeepDays) return;
    try {
      await removeExpiredRunLogs({
        stateDir: options.stateDir(),
        keepDays: await options.readRunLogKeepDays(),
        nowMs: nowMs(),
        isRunning: (runId) =>
          [...liveRuns.values()].some((live) => live.claim.run.runId === runId) ||
          [...selfTests.values()].some((test) => test.runId === runId),
      });
    } catch (error) {
      reportError(error);
    }
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
      notifyRunUpdated(live.workspace, live.claim.run.threadId);
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
      notifyRunUpdated(workspace, threadId);
      try {
        options.onThreadResumed?.(workspace, threadId);
      } catch (error) {
        reportError(error);
      }
      budgetBypassThreads.add(threadKey(workspaceId, threadId));
      await scanAndDrain(workspace);
    });
  }

  async function dispatchStateForThread(
    workspaceId: string,
    threadId: string | null,
    postThreadIds: readonly string[] = [],
  ): Promise<ChatDispatchThreadState> {
    const workspace = options.workspaceFor(workspaceId);
    if (!workspace) throw new Error("This workspace is not open. Open it again.");
    const dispatch = options.dispatchStoreFor(workspace);
    const pendingRead = Promise.resolve(dispatch.listPending(workspaceId));
    const [pauseState, pending, failed] = await Promise.all([
      threadId === null ? null : dispatch.getThreadDispatchPauseState(workspaceId, threadId),
      pendingRead,
      threadId === null ? null : failedRunForThread(workspace, threadId, pendingRead),
    ]);
    const live = liveRuns.get(workspaceId);
    const running = live?.claim.run.threadId === threadId && live.finalized === false ? live.claim.run : null;
    const queued = pending.filter((pending) => pending.threadId === threadId);
    // A request to the agent at work waits while that run holds the
    // workspace, which a stopped or timed-out run does until its process
    // exits and its end is saved. A pause holds the request instead, so it
    // isn't waiting on the agent.
    const busy = paused ? undefined : live;
    // The conversation and the earlier posts its chat shows.
    const shown = new Set([threadId, ...postThreadIds]);
    const asked = busy ? pending.filter((each) => shown.has(each.threadId) && each.agentId === busy.claim.run.agentId) : [];
    const askedThreads = [...new Set(asked.map((each) => each.threadId))];
    const pauses = await Promise.all(askedThreads.map((id) =>
      id === threadId ? pauseState : dispatch.getThreadDispatchPauseState(workspaceId, id)));
    const held = new Set(askedThreads.filter((_, at) => pauses[at]?.paused === true));
    const waiting = asked.filter((each) => !held.has(each.threadId)).map((each) => each.triggerMessageId);
    return {
      liveRunId: running?.runId ?? null,
      liveTriggerMessageId: running?.triggerMessageId ?? null,
      pendingCount: queued.length,
      paused: pauseState?.paused ?? false,
      ...(busy && waiting.length > 0
        ? { waiting: { agentId: busy.claim.run.agentId, name: busy.agentName, triggerMessageIds: waiting } }
        : {}),
      ...(failed ? { failedRun: failed } : {}),
    };
  }

  // The failed run's words for the line under its message. The same lookup
  // decides whether Try again can put this request back in line.
  async function failedRunForThread(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    pending: Promise<readonly AgentDispatchRecord[]>,
  ): Promise<ChatDispatchFailedRun | null> {
    const dispatch = options.dispatchStoreFor(workspace);
    const [stopped, latest] = await Promise.all([
      stoppedRunForThread(workspace, threadId),
      dispatch.latestRunForThread(workspace.workspaceId, threadId),
    ]);
    let found = stopped;
    if (!found?.retryable && latest?.endedAtMs !== undefined) {
      const outcome = savedRunOutcome(latest);
      // Completed runs that posted are absent from the recovery list,
      // but their failure still belongs under the message they answered.
      if (outcome !== "exited" && isFailedOutcome(outcome) &&
          outcome !== "quit" && outcome !== "restarted" &&
          !(await pending).some((each) => each.triggerMessageId === latest.triggerMessageId && each.agentId === latest.agentId)) {
        if (!canRepeatFailedRun(outcome, await runPosted(workspace, latest.runId))) found = { run: latest, outcome, retryable: false };
      }
    }
    if (!found) return null;
    const { run, outcome, retryable } = found;
    const agent = (await options.readDispatchAgents()).find(({ id }) => id === run.agentId);
    const { lead, reason, nextStep } = await failureWords(workspace, run, outcome, agent, found.attemptCount);
    return {
      runId: run.runId,
      triggerMessageId: run.triggerMessageId,
      words: `${lead}. ${reason}`,
      ...(nextStep ? { nextStep } : {}),
      retryable,
    };
  }

  // The one place that decides which run Try again can run again: the
  // conversation's newest failed run, while it is still its agent's latest
  // run there and its request is still stopped. Posted replies prevent a
  // second run unless dohc's quit or restart stopped the first one.
  // Another agent's run in the conversation doesn't hide it, and neither
  // does a run that has used both its attempts. Once the request is back in
  // line, the conversation shows it waiting instead. Runs live in this
  // computer's engine, so another computer's runs never show here.
  async function stoppedRunForThread(
    workspace: ChatDispatchWorkspace,
    threadId: string,
  ): Promise<StoppedRun | null> {
    const recoveries = (await options.listFailedRunRecoveries?.(workspace, threadId)) ?? [];
    const dispatch = options.dispatchStoreFor(workspace);
    const checkedAgents = new Set<string>();
    let exhausted: StoppedRun | null = null;
    for (const { run, attemptCount } of recoveries.toReversed()) {
      if (checkedAgents.has(run.agentId)) continue;
      checkedAgents.add(run.agentId);
      const saved = savedRunOutcome(run);
      const outcome = saved === "exited" && run.failureHandled && !runMessageLinkPending(workspace, run.runId)
        ? "no-reply" : saved;
      if (outcome === "exited" || !isFailedOutcome(outcome)) continue;
      const latest = await dispatch.latestRunForThread(workspace.workspaceId, threadId, run.agentId);
      if (latest?.runId !== run.runId) continue;
      // A timed-out run's process can still post until it exits.
      const running = liveRuns.get(workspace.workspaceId)?.claim.run.runId === run.runId;
      const retryable = attemptCount < 2 && !running && canRepeatFailedRun(outcome, await runPosted(workspace, run.runId));
      const found: StoppedRun = { run, outcome, attemptCount, retryable };
      if (found.retryable) return found;
      exhausted ??= found;
    }
    return exhausted;
  }

  // Try again puts an eligible failed run's request back in line. False
  // when its attempts or posted replies prevent another run.
  async function retryStoppedRun(
    workspaceId: string,
    threadId: string,
    runId: string,
  ): Promise<boolean> {
    return await enqueue(workspaceId, async () => {
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace) throw new Error("This workspace is not open. Open it again.");
      const found = await stoppedRunForThread(workspace, threadId);
      if (found?.run.runId !== runId || !found.retryable) return false;
      // A request for an agent this computer can't start would fail as soon
      // as it was back in line, so it stays stopped and the person learns why.
      const agent = (await options.readDispatchAgents()).find(({ id }) => id === found.run.agentId);
      if (!agent?.enabled || !agent.launch) {
        const why = !agent
          ? "That agent is not set up on this computer."
          : agent.launch ? `${agent.name} is off.` : `${agent.name} has no command to start it.`;
        throw new Error(`${why} Check it in Settings → Agents, then try again.`);
      }
      const requeued = (await options.requeueFailedTrigger?.({
        workspaceId,
        ...(workspace.attachmentId ? { attachmentId: workspace.attachmentId } : {}),
        triggerMessageId: found.run.triggerMessageId,
        agentId: found.run.agentId,
        runId,
      })) === true;
      if (!requeued) return false;
      notifyRunUpdated(workspace, threadId);
      await scanAndDrain(workspace);
      return true;
    });
  }

  async function runnerSelfTest(
    workspaceId: string,
    agentId: string,
  ): Promise<RunnerSelfTestResult> {
    const workspace = options.workspaceFor(workspaceId);
    if (!workspace) return { ok: false, detail: "That workspace is not available." };
    if (shuttingDown) return { ok: false, detail: "dohc is quitting." };
    if (
      workspaceProcessReserved(workspace)
    ) {
      return { ok: false, detail: "A runner is already active in this workspace." };
    }
    selfTestReservations.add(workspaceId);
    let reservationHeldByProcess = false;
    let releaseWorkspace: (() => Promise<void>) | null = null;
    try {
      const agent = (await options.readDispatchAgents()).find((candidate) => candidate.id === agentId);
      if (!agent?.launch) return { ok: false, detail: "Configure a runner command first." };
      const command = launchCommand(agent.launch);
      const assertMayStart = await agentStartCheck(workspace);
      if (!assertMayStart) return { ok: false, detail: SELF_TEST_RESTRICTED_DETAIL };
      const profile = launchProfile(agent.launch);
      if (profile?.tool === "claude" && !supportsAgentProfile("claude", await options.agentToolVersion(profile.executable))) {
        return { ok: false, detail: `Update Claude Code to ${CLAUDE_MIN_VERSION} or later to use this agent.` };
      }

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
              ? "dohc is quitting."
              : "A runner became active before the self-test could start.",
          };
        }
        assertMayStart();
        const threadId = scratchThreadId ?? await options.startSelfTestThread(workspace, {
          channelId: agentChannel.id,
          title: SELF_TEST_THREAD_TITLE,
          body: SELF_TEST_OPENING,
        });
        if (shuttingDown) return { ok: false, detail: "dohc is quitting." };
        if (liveRuns.has(workspaceId) || runReservations.has(workspaceId) || selfTests.has(workspaceId) || options.runSlotOccupied?.(workspace) === true) {
          return { ok: false, detail: "A runner became active before the self-test could start." };
        }
        // The same reply form as a real run, so passing proves replies work.
        const prompt = replyFormFor(profile?.tool) === "mcp"
          ? `This is a dohc runner self-test. Call ${replyToolCall(threadId, runId)} once, with \`body\` \`${marker}\`, and do not post another message.`
          : `This is a dohc runner self-test. Run exactly this command and do not post another message:\n\n${replyCommand(threadId, marker)}`;
        const secret = runSecret();
        await options.setRunAttribution(workspace, {
          agentId: agent.id,
          agentRunId: runId,
          depth: 0,
          dispatch: "self-test",
          secret,
        });
        const child = await spawnConfiguredRunner({
          rootPath: workspace.rootPath,
          threadId,
          runId,
          agentName: agent.name,
          logPath,
          command,
          profile,
          // The self-test checks only that the reply arrives.
          dohcTools: "reply",
          prompt,
          runSecret: secret,
          assertMayStart: () => {
            if (shuttingDown) throw new Error("Agent dispatch is stopping.");
            assertMayStart();
          },
        });
        return await new Promise<RunnerSelfTestResult>((resolveResult) => {
          const complete = async (result: RunnerSelfTestResult) => {
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
              void markRunLogEnded(logPath, nowMs()).catch(reportError);
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
              const replies = messages.filter(
                (message) => message.author.kind === "agent" && message.body.trim() === marker,
              );
              // Only the run's own reply carries its agent. A reply that lost
              // the run's secret is the unnamed agent's, so the check ends there.
              if (replies.some((message) => message.authorAgentId === agent.id)) {
                await complete({
                  ok: true,
                  detail:
                    "Runner self-test passed. The harness reported through dohc chat.",
                });
                return;
              }
              if (replies.length > 0) {
                await complete({
                  ok: false,
                  unconfirmed: true,
                  detail: `${agent.name}'s Command started its tools without this check's credential, so its replies show as Agent. Edit the Command in ${agent.name}'s details.`,
                  logPath,
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
              detail: "Runner self-test timed out after 120 seconds.",
              logPath,
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
              detail: "Runner self-test failed to start.",
              logPath,
            });
          });
          child.onExit(() => {
            void (async () => {
              await check();
              const current = selfTests.get(workspaceId);
              if (current && !current.settled) {
                await complete({
                  ok: false,
                  detail: "Runner exited before reporting self-test success.",
                  logPath,
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
        // A launch that failed can leave its log behind.
        await markRunLogEnded(logPath, nowMs()).catch(reportError);
        // A restrict that landed while the self-test was starting stops it here.
        if (error instanceof WorkspaceRestrictedError) return { ok: false, detail: SELF_TEST_RESTRICTED_DETAIL };
        return {
          ok: false,
          detail: `Runner self-test could not start.${
            error instanceof Error && error.message ? ` ${error.message}` : ""
          }`,
          logPath,
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
    if (runLogSweepTimer) clearInterval(runLogSweepTimer);
    runLogSweepTimer = null;
    for (const timer of recoveryTimers.values()) clearTimeout(timer);
    recoveryTimers.clear();
    recoveryAttempts.clear();
    const pumpAtStop = pumpInFlight;
    const appQuitRuns: LiveRun[] = [];
    const runWorkspacesToRelease: LiveRun[] = [];
    const quitProcesses: RunnerProcess[] = [];
    const selfTestLogs: string[] = [];
    for (const test of selfTests.values()) {
      if (test.killEscalation) clearTimeout(test.killEscalation);
      test.killEscalation = null;
      quitProcesses.push(test.child);
      selfTestLogs.push(actualLogPath(test.runId));
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
    await Promise.all(quitTerminations);
    await Promise.all(selfTestLogs.map((log) => markRunLogEnded(log, nowMs()).catch(reportError)));
    await Promise.all(
      [
        ...runWorkspacesToRelease.map(async (live) => {
          try {
            await markRunLogEnded(live.logPath, nowMs()).catch(reportError);
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

  // Queues a message the scan does not find, such as an automation's wake, and
  // shows its waiting request.
  async function recordTrigger(
    workspace: ChatDispatchWorkspace,
    input: { triggerMessageId: string; threadId: string; agentId: string },
  ): Promise<boolean> {
    const queued = await options.dispatchStoreFor(workspace)
      .recordTrigger({ workspaceId: workspace.workspaceId, ...input });
    if (queued) notifyRunUpdated(workspace, input.threadId);
    return queued;
  }

  return {
    start,
    stop,
    scanWorkspace,
    recordTrigger,
    betweenScans,
    stopAgentRun,
    stopForRestrictedMode,
    waitsForTrust,
    trustAsked,
    trustWasAsked,
    trustChanged,
    resumeThreadDispatch,
    dispatchStateForThread,
    retryStoppedRun,
    endRunQuietly,
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
