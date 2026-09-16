import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createChatRunnerProcess,
  RUNNER_KILL_GRACE_MS,
  type RunnerProcess,
  type ChatRunnerProcessOptions,
} from "./chatRunnerProcess";
import type {
  AgentDispatchClaim,
  AgentRunRecord,
  ChatChannelKind,
  ChatMessage,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import type { RunnerSettings } from "../settings/userSettings";
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AgentDispatchRequestOptions,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";
import { buildRunnerThreadContext } from "./runnerThreadContext";

export const CHAT_DISPATCH_PUMP_MS = 15_000;
const CHAT_DISPATCH_BUDGET_WINDOW_MS = 10 * 60_000;
export const CHAT_DISPATCH_BUDGET_MAX = 10;
export const RUNNER_SELF_TEST_TIMEOUT_MS = 120_000;
export const CHAT_DISPATCH_RECOVERY_BACKOFF_MS = 1_000;
const CHAT_DISPATCH_RECOVERY_MAX_BACKOFF_MS = 30_000;
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
  attachmentId?: symbol;
}

export interface ChatDispatchIdentity {
  displayName: string;
  verifiedUserId?: string;
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
  listOpenWorkspaces(): ChatDispatchWorkspace[];
  listSyncWorkspaces(): ChatDispatchWorkspace[];
  chatStoreFor(workspace: ChatDispatchWorkspace): LinkedChatStore;
  dispatchStoreFor(
    workspace: ChatDispatchWorkspace,
  ): AwaitableAgentDispatchStore;
  readRunnerSettings(): Promise<RunnerSettings>;
  identityFor(
    workspace: ChatDispatchWorkspace,
    target?: { channelId: string } | { threadId: string },
  ): Promise<ChatDispatchIdentity>;
  queueSync(workspace: ChatDispatchWorkspace): void | boolean | Promise<void | boolean>;
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
  onMessagePosted(workspace: ChatDispatchWorkspace, threadId: string): void;
  onRunUpdated?(workspace: ChatDispatchWorkspace): void;
  setRunAttribution(
    workspace: ChatDispatchWorkspace,
    run: { agentId: string; onBehalfOf: string; agentRunId: string } | null,
  ): void | Promise<void>;
  runSlotOccupied?(workspace: ChatDispatchWorkspace): boolean;
  publishPresence?(input: ChatDispatchPresenceInput): Promise<void>;
  requeueFailedTrigger?(input: {
    workspaceId: string;
    attachmentId?: symbol;
    triggerMessageId: string;
    runId: string;
  }): boolean | Promise<boolean>;
  hasPendingRunMessageLink?(workspace: ChatDispatchWorkspace, runId: string): boolean;
  listAppQuitRecoveries?(
    workspace: ChatDispatchWorkspace,
  ): ChatDispatchRecovery[] | Promise<ChatDispatchRecovery[]>;
  nowMs?: () => number;
  createId?: () => string;
  onError?: (error: unknown) => void;
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
}

interface PendingInterruptedRequeue {
  workspace: ChatDispatchWorkspace;
  input: {
    workspaceId: string;
    attachmentId?: symbol;
    triggerMessageId: string;
    runId: string;
  };
}

interface SelfTestState {
  workspace: ChatDispatchWorkspace;
  child: RunnerProcess;
  threadId: string;
  runId: string;
  settled: boolean;
  poll: ReturnType<typeof setTimeout> | null;
  timeout: ReturnType<typeof setTimeout>;
  killEscalation: ReturnType<typeof setTimeout> | null;
  resolve(result: { ok: boolean; detail: string }): void;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}

function runnerDisplayName(displayName: string): string {
  return `${displayName}'s agent`;
}

function buildRunnerPrompt(threadMarkdown: string, threadId: string): string {
  return `${threadMarkdown.trimEnd()}

## Report contract

Work on the request represented by this thread. Reply in-thread with \`dohc chat reply ${threadId} --as-agent "<report>"\`. Report outcomes, not tool logs. On long tasks, post progress the way a teammate would. If blocked on the user, reply with \`--needs-decision\`. To ask them to pick, add \`--option "<choice>"\` once per choice; their answer arrives as the next message with the chosen option. Your final text is not shown anywhere; only messages you post through \`dohc chat\` are shown.`;
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
      // Presence is cosmetic. The dispatch ledger and failure notes carry truth.
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
      .identityFor(live.workspace)
      .then(async (identity) => {
        const base = {
          workspaceId: live.workspace.workspaceId,
          ...(live.workspace.attachmentId
            ? { attachmentId: live.workspace.attachmentId }
            : {}),
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

  async function sendAgentMessage(
    workspace: ChatDispatchWorkspace,
    threadId: string,
    body: string,
    runId?: string,
    dispatchRequest?: AgentDispatchRequestOptions,
  ): Promise<string | null> {
    const identity = await options.identityFor(workspace, { threadId });
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
    options.onMessagePosted(workspace, threadId);
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
          await postFailureNote(
            live.workspace,
            live.claim.run,
            `⚠ Agent run failed (exit ${intent.exitCode}). Open the run chip for details.`,
          ).catch(reportError);
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
        notifyRunUpdated(live.workspace);
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
      notifyRunUpdated(live.workspace);
    } catch (error) {
      reportError(error);
      scheduleRecoveryScan(live.workspace);
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
        await options.setRunAttribution(workspace, null);
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
    notifyRunUpdated(workspace);
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
      notifyRunUpdated(recovery.workspace);
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
    runner: RunnerSettings,
    releaseWorkspace: (() => Promise<void>) | null,
  ): Promise<void> {
    const dispatch = options.dispatchStoreFor(workspace);
    const logPath = actualLogPath(claim.run.runId, claim.run.logPath);
    runReservations.add(workspace.workspaceId);
    try {
      const identity = await options.identityFor(workspace);
      await options.setRunAttribution(workspace, {
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
      const child = spawnConfiguredRunner({
        rootPath: workspace.rootPath,
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
        child,
        logPath,
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
        if (failedCount > 0) notifyRunUpdated(workspace);
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
    if (stopped || paused || workspaceProcessReserved(workspace)) {
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
        notifyRunUpdated(workspace);
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
      options.identityFor(workspace),
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
    if (recordedCount > 0) notifyRunUpdated(workspace);
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
      notifyRunUpdated(workspace);
      if (claim.dispatch.attemptCount < 2) {
        if (
          !(await requeueInterruptedRun(workspace, {
            workspaceId: workspace.workspaceId,
            ...(workspace.attachmentId
              ? { attachmentId: workspace.attachmentId }
              : {}),
            triggerMessageId: claim.run.triggerMessageId,
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
            ...(workspace.attachmentId
              ? { attachmentId: workspace.attachmentId }
              : {}),
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
          await postFailureNote(
            workspace,
            recovery.run,
            "⚠ Agent run produced no reply. Open the run chip for details.",
          );
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
    if (!(await startupSweep(workspace))) return;
    await scanTriggers(workspace);
    await drain(workspace);
  }

  function scanWorkspace(
    workspaceId: string,
    expectedAttachmentId?: symbol,
  ): Promise<void> {
    let scannedWorkspace: ChatDispatchWorkspace | null = null;
    const scan = enqueue(workspaceId, async () => {
      const workspace = options.workspaceFor(workspaceId);
      if (!workspace || stopped) return;
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
    paused = next;
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
      notifyRunUpdated(live.workspace);
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
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
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
      const runner = await options.readRunnerSettings();
      const command = runner.command.trim();
      if (!command) return { ok: false, detail: "Configure a runner command first." };

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
      const identity = await options.identityFor(workspace);
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
        options.onMessagePosted(workspace, scratchThreadId);
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
          options.runSlotOccupied?.(workspace) === true
        ) {
          return {
            ok: false,
            detail: shuttingDown
              ? "Agent dispatch is stopping."
              : "A runner became active before the self-test could start.",
          };
        }
        await options.setRunAttribution(workspace, {
          agentId: "dohc-chat-runner-self-test",
          onBehalfOf: "local",
          agentRunId: runId,
        });
        const child = spawnConfiguredRunner({
          rootPath: workspace.rootPath,
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
            workspace,
            child,
            threadId: scratchThreadId,
            runId,
            settled: false,
            poll: null,
            timeout,
            killEscalation: null,
            resolve: resolveResult,
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
    stopAgentRun,
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
