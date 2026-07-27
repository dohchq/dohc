import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import {
  LINKED_CHAT_STORE_RELATIVE_PATH,
  createAgentDispatchStore,
  createLinkedChatStore,
  type AgentDispatchClaim,
  type AgentDispatchStore,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import type {
  JsonValue,
  Request,
  Response,
} from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerSettings } from "../settings/userSettings";
import { EngineWorkspaceSessions } from "../workspaces/engineWorkspaceSessions";
import { EngineClientError } from "../workspaces/engineClient";
import { nativeTmpdir } from "../workspaces/testTemp";
import {
  APP_QUIT_EXIT_CODE,
  APP_QUIT_KILL_GRACE_MS,
  CHAT_DISPATCH_BUDGET_MAX,
  CHAT_DISPATCH_PUMP_MS,
  CHAT_DISPATCH_RECOVERY_BACKOFF_MS,
  NO_RUNNER_NOTE,
  RUNNER_KILL_GRACE_MS,
  RUNNER_SELF_TEST_TIMEOUT_MS,
  createChatDispatchService,
  messageCanTrigger,
  tokenizeRunnerCommand,
  type ChatDispatchIdentity,
  type ChatDispatchPresenceInput,
  type ChatDispatchService,
  type ChatDispatchWorkspace,
  type RunnerProcess,
  type RunnerSpawnOptions,
  type SpawnRunner,
} from "./chatDispatchService";
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";
import { createLiveAgentDispatchStore } from "./liveAgentDispatchStore";

const WORKSPACE_ID = "workspace-chat-dispatch";
const CHAT_START_MS = Date.parse("2026-07-10T04:05:06.000Z");

const requireModule = createRequire(import.meta.url);
type DispatchDb = Parameters<typeof createAgentDispatchStore>[0];
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => DispatchDb;
};

interface SpawnCall {
  command: string;
  args: string[];
  options: RunnerSpawnOptions;
  process: FakeRunnerProcess;
}

class FakeRunnerProcess implements RunnerProcess {
  readonly rawChild = undefined;
  private exited = false;
  private readonly exitListeners: Array<
    (exitCode: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  constructor(readonly pid: number | undefined) {}

  hasExited(): boolean {
    return this.exited;
  }

  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  emitExit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.exited = true;
    for (const listener of this.exitListeners) listener(exitCode, signal);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  markExitedSilently(): void {
    this.exited = true;
  }
}

interface FixtureOptions {
  dispatchBackend?: "sqlite" | "live";
  runner?: Partial<RunnerSettings>;
  identity?: ChatDispatchIdentity;
  serviceNotesWritable?: boolean;
  pumpWorkspace?: boolean;
  pumpWorkspaces?: ChatDispatchWorkspace[];
  onQueueSync?: (
    workspaceId: string,
    chat: LinkedChatStore,
  ) => void | boolean | Promise<void | boolean>;
  temporaryRunActivity?: boolean;
  requeueFailures?: Error[];
  recordEligibleTriggerFailures?: Error[];
  claimFailures?: Error[];
  ambiguousClaimOnce?: boolean;
  deferClaim?: boolean;
  hasPendingRunMessageLink?: (workspaceId: string, runId: string) => boolean;
}

interface Fixture {
  root: string;
  stateRoot: string;
  appRoot: string;
  workspace: ChatDispatchWorkspace;
  chat: LinkedChatStore;
  dispatch: AgentDispatchStore;
  dispatchDb: DispatchDb;
  service: ChatDispatchService;
  runner: RunnerSettings;
  spawnCalls: SpawnCall[];
  killCalls: Array<{ pid: number; signal: NodeJS.Signals }>;
  postedWorkspaces: string[];
  runUpdatedWorkspaces: string[];
  syncRequests: string[];
  presence: ChatDispatchPresenceInput[];
  attributions: Array<{
    workspaceId: string;
    run: { agentId: string; onBehalfOf: string; agentRunId: string } | null;
  }>;
  errors: unknown[];
  requeues: Array<{
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  }>;
  runActivity: { acquires: number; releases: number };
  now: { value: number };
  requeueRaw(input: { workspaceId: string; triggerMessageId: string; runId: string }): boolean;
  restartDaemon?(): void;
  rejectNextRunMessageLookup?(error: Error): void;
  rejectNextFailRun?(error: Error): void;
  rejectFailRuns?(errors: Error[]): void;
  rejectCompleteRuns?(errors: Error[]): void;
  dispatchRequests: Request[];
  failRunRequests: number;
  completeRunRequests: number;
  claimStarted?: Promise<void>;
  releaseClaim?(): void;
  closeDispatch(): Promise<void>;
}

const fixtures: Fixture[] = [];

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-chat-dispatch-"));
  const stateRoot = join(root, "state");
  const appRoot = join(root, "app");
  const workspace = { workspaceId: WORKSPACE_ID, rootPath: root };
  const chatIds = { channel: 0, message: 0, thread: 0 };
  let chatNow = CHAT_START_MS;
  const chat = createLinkedChatStore(root, {
    nowMs: () => {
      const value = chatNow;
      chatNow += 1_000;
      return value;
    },
    createId: (kind) => {
      chatIds[kind] += 1;
      return `${kind}_${chatIds[kind]}`;
    },
  });
  await chat.listChannels({ workspaceId: WORKSPACE_ID });

  const dispatchDb = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
  const now = { value: 1_000_000 };
  let nextRunId = 0;
  let preparedRunId: string | null = null;
  let nextSelfTestId = 0;
  const dispatch = createAgentDispatchStore(dispatchDb, {
    nowMs: () => now.value,
    createRunId: () => preparedRunId ?? `run_${(nextRunId += 1)}`,
  });
  const runner: RunnerSettings = {
    command: "claude -p",
    enabled: true,
    timeoutMinutes: 30,
    ...options.runner,
  };
  const spawnCalls: SpawnCall[] = [];
  let nextPid = 4_100;
  const spawnRunner: SpawnRunner = (command, args, spawnOptions) => {
    const process = new FakeRunnerProcess(nextPid);
    nextPid += 1;
    spawnCalls.push({
      command,
      args: [...args],
      options: {
        ...spawnOptions,
        env: { ...spawnOptions.env },
        stdio: [...spawnOptions.stdio],
      },
      process,
    });
    return process;
  };
  const killCalls: Fixture["killCalls"] = [];
  const postedWorkspaces: string[] = [];
  const runUpdatedWorkspaces: string[] = [];
  const syncRequests: string[] = [];
  const presence: ChatDispatchPresenceInput[] = [];
  const attributions: Fixture["attributions"] = [];
  const errors: unknown[] = [];
  const requeues: Fixture["requeues"] = [];
  const runActivity = { acquires: 0, releases: 0 };

  const requeueRaw = (input: Fixture["requeues"][number]): boolean => {
    const updated = dispatchDb
      .prepare(
        `UPDATE chat_dispatch_ledger
         SET state = 'pending', run_id = NULL, failure_reason = NULL,
             updated_at_ms = ?
         WHERE workspace_id = ? AND trigger_message_id = ?
           AND state = 'failed' AND run_id = ? AND attempt_count < 2`,
      )
      .run(now.value, input.workspaceId, input.triggerMessageId, input.runId);
    return updated.changes === 1;
  };

  const listRecoveriesRaw = (workspaceId: string) =>
    dispatchDb
      .prepare(
        `SELECT r.run_id, l.attempt_count
         FROM agent_run_records r
         JOIN chat_dispatch_ledger l
           ON l.workspace_id = r.workspace_id
          AND l.trigger_message_id = r.trigger_message_id
          AND l.run_id = r.run_id
         WHERE r.workspace_id = ?
           AND ((r.exit_code = ? AND r.failure_reason = 'app-quit')
             OR r.failure_reason = 'app restart during run')
           AND r.failure_note_posted = 0
           AND l.state = 'failed'`,
      )
      .all(workspaceId, APP_QUIT_EXIT_CODE)
      .map((row) => {
        const runId = row.run_id;
        const attemptCount = row.attempt_count;
        if (
          typeof runId !== "string" ||
          typeof attemptCount !== "number" ||
          !Number.isSafeInteger(attemptCount)
        ) {
          throw new Error("Corrupt app-quit recovery fixture.");
        }
        const run = dispatch.getRunRecord(runId);
        if (!run) throw new Error("Missing app-quit recovery run.");
        return { run, attemptCount };
      });

  let closeDispatch: () => Promise<void> = async () => undefined;
  let serviceDispatch: AwaitableAgentDispatchStore = dispatch;
  let liveRequeue:
    | ReturnType<typeof createLiveAgentDispatchStore>["requeueFailedTrigger"]
    | undefined;
  let liveRecoveries:
    | ReturnType<typeof createLiveAgentDispatchStore>["listAppQuitRecoveries"]
    | undefined;
  let restartDaemon: (() => void) | undefined;
  let rejectNextRunMessageLookup: ((error: Error) => void) | undefined;
  let rejectNextFailRun: ((error: Error) => void) | undefined;
  let rejectFailRuns: ((errors: Error[]) => void) | undefined;
  let rejectCompleteRuns: ((errors: Error[]) => void) | undefined;
  const dispatchRequests: Request[] = [];
  let failRunRequests = 0;
  let completeRunRequests = 0;
  let signalClaimStarted: (() => void) | undefined;
  let releaseClaim: (() => void) | undefined;
  const claimStarted = options.deferClaim
    ? new Promise<void>((resolveStarted) => {
        signalClaimStarted = resolveStarted;
      })
    : undefined;
  const claimGate = options.deferClaim
    ? new Promise<void>((resolveClaim) => {
        releaseClaim = resolveClaim;
      })
    : undefined;
  if (options.dispatchBackend === "live") {
    let daemonGeneration = 1;
    let nextRunMessageLookupError: Error | null = null;
    let nextFailRunError: Error | null = null;
    const failRunErrors: Error[] = [];
    const completeRunErrors: Error[] = [];
    let daemon: {
      close(): void;
      sendRequest(request: Request): Promise<Response>;
    };
    const sendRequest = async (request: Request): Promise<Response> => {
        dispatchRequests.push(request);
        const params = request.params as {
          [key: string]: JsonValue | undefined;
        };
        let result: unknown;
        switch (request.method) {
          case "workspace.open": {
            if (params.recoverRunningDispatches !== false) {
              const running = dispatchDb
                .prepare(
                  `SELECT trigger_message_id, run_id
                   FROM chat_dispatch_ledger
                   WHERE workspace_id = ? AND state = 'running'`,
                )
                .all(WORKSPACE_ID);
              for (const row of running) {
                dispatchDb
                  .prepare(
                    `UPDATE agent_run_records
                     SET ended_at_ms = ?, exit_code = -1,
                         failure_reason = 'reclaimed-crashed'
                     WHERE workspace_id = ? AND run_id = ? AND ended_at_ms IS NULL`,
                  )
                  .run(now.value, WORKSPACE_ID, row.run_id);
                dispatchDb
                  .prepare(
                    `UPDATE chat_dispatch_ledger
                     SET state = 'pending', run_id = NULL, failure_reason = NULL,
                         updated_at_ms = ?
                     WHERE workspace_id = ? AND trigger_message_id = ?
                       AND state = 'running'`,
                  )
                  .run(now.value, WORKSPACE_ID, row.trigger_message_id);
              }
            }
            result = { workspace: `service-live-handle-${daemonGeneration}` };
            break;
          }
          case "workspace.close":
            result = { closed: true };
            break;
          case "chats.dispatch.recordEligibleTriggers":
            result = dispatch.recordEligibleTriggers({
              workspaceId: WORKSPACE_ID,
              ...(typeof params.verifiedUserId === "string"
                ? { verifiedUserId: params.verifiedUserId }
                : {}),
            });
            break;
          case "chats.dispatch.listPending":
            result = {
              dispatches: dispatch.listPending(WORKSPACE_ID),
              nextCursor: null,
            };
            break;
          case "chats.dispatch.openRuns":
            result = {
              claims: dispatch.openRuns(WORKSPACE_ID),
              nextCursor: null,
            };
            break;
          case "chats.dispatch.isThreadPaused":
            result = dispatch.threadDispatchPaused(
              WORKSPACE_ID,
              String(params.threadId),
            );
            break;
          case "chats.dispatch.getThreadPauseState":
            result = dispatch.getThreadDispatchPauseState(
              WORKSPACE_ID,
              String(params.threadId),
            );
            break;
          case "chats.dispatch.recentCount":
            result = dispatch.recentDispatchCount({
              workspaceId: WORKSPACE_ID,
              threadId: String(params.threadId),
              sinceMs: Number(params.sinceMs),
            });
            break;
          case "chats.dispatch.claimNextPending":
            preparedRunId = String(params.runId);
            try {
              result = dispatch.claimNextPending(WORKSPACE_ID, {
                ...(typeof params.command === "string"
                  ? { command: params.command }
                  : {}),
                ...(typeof params.logPath === "string"
                  ? { logPath: params.logPath }
                  : {}),
              });
            } finally {
              preparedRunId = null;
            }
            break;
          case "chats.dispatch.listRunMessages":
            if (nextRunMessageLookupError) {
              const error = nextRunMessageLookupError;
              nextRunMessageLookupError = null;
              throw error;
            }
            result = {
              messageIds: dispatch.listRunMessages(
                WORKSPACE_ID,
                String(params.runId),
              ),
              nextCursor: null,
            };
            break;
          case "chats.dispatch.recordRunMessage":
            result = dispatch.recordRunMessage({
              workspaceId: WORKSPACE_ID,
              messageId: String(params.messageId),
              runId: String(params.runId),
            });
            break;
          case "chats.dispatch.markFailureNotePosted":
            result = dispatch.markFailureNotePosted(String(params.runId));
            break;
          case "chats.dispatch.complete":
            completeRunRequests += 1;
            if (completeRunErrors.length > 0) {
              const error = completeRunErrors.shift()!;
              daemonGeneration += 1;
              daemon = {
                close: () => undefined,
                sendRequest,
              };
              throw error;
            }
            dispatch.completeRun({
              runId: String(params.runId),
              exitCode: Number(params.exitCode),
            });
            result = { completed: true };
            break;
          case "chats.dispatch.fail":
            failRunRequests += 1;
            if (nextFailRunError) {
              const error = nextFailRunError;
              nextFailRunError = null;
              throw error;
            }
            if (failRunErrors.length > 0) {
              const error = failRunErrors.shift()!;
              daemonGeneration += 1;
              daemon = {
                close: () => undefined,
                sendRequest,
              };
              throw error;
            }
            dispatch.failRun({
              runId: String(params.runId),
              ...(typeof params.exitCode === "number"
                ? { exitCode: params.exitCode }
                : {}),
              reason: String(params.reason),
            });
            result = { failed: true };
            break;
          case "chats.dispatch.getRunRecord":
            result = dispatch.getRunRecord(String(params.runId));
            break;
          case "chats.dispatch.requeueFailedTrigger":
            result = requeueRaw({
              workspaceId: WORKSPACE_ID,
              triggerMessageId: String(params.triggerMessageId),
              runId: String(params.runId),
            });
            break;
          case "chats.dispatch.listAppQuitRecoveries":
            result = {
              recoveries: listRecoveriesRaw(WORKSPACE_ID),
              nextCursor: null,
            };
            break;
          default:
            throw new Error(
              `Unexpected live fixture request: ${request.method}`,
            );
        }
        return { id: request.id, result: result as JsonValue };
    };
    daemon = {
      close: () => undefined,
      sendRequest,
    };
    restartDaemon = () => {
      daemonGeneration += 1;
      daemon = {
        close: () => undefined,
        sendRequest,
      };
    };
    rejectNextRunMessageLookup = (error) => {
      nextRunMessageLookupError = error;
    };
    rejectNextFailRun = (error) => {
      nextFailRunError = error;
    };
    rejectFailRuns = (errors) => {
      failRunErrors.push(...errors);
    };
    rejectCompleteRuns = (errors) => {
      completeRunErrors.push(...errors);
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => daemon,
    }, {
      sleep: async () => undefined,
    });
    const live = createLiveAgentDispatchStore(workspace, sessions, {
      createRunId: () => `run_${(nextRunId += 1)}`,
    });
    serviceDispatch = live.store;
    liveRequeue = live.requeueFailedTrigger;
    liveRecoveries = live.listAppQuitRecoveries;
    closeDispatch = live.close;
  }
  if (
    options.claimFailures ||
    options.ambiguousClaimOnce ||
    options.deferClaim
  ) {
    const baseDispatch = serviceDispatch;
    let unresolvedClaim: AgentDispatchClaim | null = null;
    serviceDispatch = {
      ...baseDispatch,
      async claimNextPending(workspaceId, claimOptions) {
        signalClaimStarted?.();
        if (claimGate) await claimGate;
        const error = options.claimFailures?.shift();
        if (error) throw error;
        const claim = await baseDispatch.claimNextPending(
          workspaceId,
          claimOptions,
        );
        if (options.ambiguousClaimOnce && unresolvedClaim === null && claim) {
          unresolvedClaim = claim;
          throw new EngineClientError(
            "transport-error",
            "claim response was lost after commit",
          );
        }
        return claim;
      },
      async resolveUncertainClaim() {
        const claim = unresolvedClaim;
        unresolvedClaim = null;
        return claim;
      },
    };
  }
  if (options.recordEligibleTriggerFailures) {
    const baseDispatch = serviceDispatch;
    serviceDispatch = {
      ...baseDispatch,
      recordEligibleTriggers(input) {
        const error = options.recordEligibleTriggerFailures?.shift();
        if (error) throw error;
        return baseDispatch.recordEligibleTriggers(input);
      },
    };
  }

  const service = createChatDispatchService({
    workspaceFor: (workspaceId) => (workspaceId === WORKSPACE_ID ? workspace : null),
    listOpenWorkspaces: () => [],
    listSyncWorkspaces: () =>
      options.pumpWorkspaces ?? (options.pumpWorkspace ? [workspace] : []),
    chatStoreFor: () => chat,
    dispatchStoreFor: () => serviceDispatch,
    readRunnerSettings: async () => ({ ...runner }),
    identityFor: async () =>
      options.identity ?? {
        displayName: "Ice",
        verifiedUserId: "user_local",
      },
    stateDir: () => stateRoot,
    appRoot: () => appRoot,
    isPackaged: () => false,
    queueSync: async (workspaceId) => {
      syncRequests.push(workspaceId);
      return options.onQueueSync?.(workspaceId, chat);
    },
    ...(options.temporaryRunActivity
      ? {
          prepareRunWorkspace: async () => {
            runActivity.acquires += 1;
            let released = false;
            return async () => {
              if (released) return;
              released = true;
              runActivity.releases += 1;
            };
          },
        }
      : {}),
    authorizeServiceNote: async () => options.serviceNotesWritable !== false,
    onMessagePosted: (workspaceId) => postedWorkspaces.push(workspaceId),
    onRunUpdated: (workspaceId) => runUpdatedWorkspaces.push(workspaceId),
    setRunAttribution: (workspaceId, run) => {
      attributions.push({ workspaceId, run });
    },
    publishPresence: async (input) => {
      presence.push(input);
    },
    ...(options.hasPendingRunMessageLink
      ? { hasPendingRunMessageLink: options.hasPendingRunMessageLink }
      : {}),
    requeueFailedTrigger: (input) => {
      requeues.push(input);
      const error = options.requeueFailures?.shift();
      if (error) throw error;
      return liveRequeue?.(input) ?? requeueRaw(input);
    },
    listAppQuitRecoveries: (workspaceId) =>
      liveRecoveries?.(workspaceId) ?? listRecoveriesRaw(workspaceId),
    spawnRunner,
    killProcessGroup: (pid, signal) => {
      killCalls.push({ pid, signal });
    },
    platform: "linux",
    nowMs: () => now.value,
    createId: () => `self_test_id_${(nextSelfTestId += 1)}`,
    onError: (error) => errors.push(error),
  });

  const fixture: Fixture = {
    root,
    stateRoot,
    appRoot,
    workspace,
    chat,
    dispatch,
    dispatchDb,
    service,
    runner,
    spawnCalls,
    killCalls,
    postedWorkspaces,
    runUpdatedWorkspaces,
    syncRequests,
    presence,
    attributions,
    errors,
    requeues,
    runActivity,
    now,
    requeueRaw,
    ...(restartDaemon ? { restartDaemon } : {}),
    ...(rejectNextRunMessageLookup ? { rejectNextRunMessageLookup } : {}),
    ...(rejectNextFailRun ? { rejectNextFailRun } : {}),
    ...(rejectFailRuns ? { rejectFailRuns } : {}),
    ...(rejectCompleteRuns ? { rejectCompleteRuns } : {}),
    dispatchRequests,
    get failRunRequests() {
      return failRunRequests;
    },
    get completeRunRequests() {
      return completeRunRequests;
    },
    ...(claimStarted ? { claimStarted } : {}),
    ...(releaseClaim ? { releaseClaim } : {}),
    closeDispatch,
  };
  fixtures.push(fixture);
  return fixture;
}

async function activate(fixture: Fixture): Promise<void> {
  fixture.service.start();
  await fixture.service.scanWorkspace(WORKSPACE_ID);
}

async function createAgentThread(
  fixture: Fixture,
  input: {
    body: string;
    title?: string;
    actor?: "human" | "agent";
    authorUserId?: string;
    origin?: "cli";
  },
): Promise<{ threadId: string; messageId: string }> {
  const channel = await fixture.chat.ensureAgentChannel({
    workspaceId: WORKSPACE_ID,
  });
  const actor = input.actor ?? "human";
  const started = await fixture.chat.startChannelThread({
    workspaceId: WORKSPACE_ID,
    channelId: channel.id,
    ...(input.title === undefined ? {} : { title: input.title }),
    author:
      actor === "human"
        ? { kind: "human", displayName: "Ice" }
        : { kind: "agent", displayName: "Ice" },
    ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    body: input.body,
  });
  return { threadId: started.thread.id, messageId: started.message.id };
}

async function linkAgentReply(
  fixture: Fixture,
  threadId: string,
  runId: string,
  body = "Finished the work.",
): Promise<string> {
  const message = await fixture.chat.sendMessage({
    workspaceId: WORKSPACE_ID,
    threadId,
    author: { kind: "agent", displayName: "Ice" },
    origin: "cli",
    body,
  });
  fixture.dispatch.recordRunMessage({
    workspaceId: WORKSPACE_ID,
    messageId: message.id,
    runId,
  });
  return message.id;
}

async function flushMicrotasks(iterations = 20): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    for (const call of fixture.spawnCalls) call.process.markExitedSilently();
    await fixture.service.stop();
    await fixture.closeDispatch();
    fixture.dispatchDb.close();
    await fixture.chat.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("chatDispatchService", () => {
  it("allows ten dispatches per rolling budget window", () => {
    expect(CHAT_DISPATCH_BUDGET_MAX).toBe(10);
  });

  it("provisions the agent channel during the first trigger scan", async () => {
    const fixture = await createFixture({ runner: { enabled: false } });

    fixture.service.setPaused(true);
    await activate(fixture);

    expect(
      (await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID })).filter(
        (channel) => channel.kind === "agent",
      ),
    ).toHaveLength(1);
  });

  it("records only owner human UI triggers and deduplicates repeated scans", async () => {
    const fixture = await createFixture({
      runner: { enabled: false },
      identity: { displayName: "Ice", verifiedUserId: "user_local" },
    });
    const agentHuman = await createAgentThread(fixture, {
      body: "Please review the launch.",
      authorUserId: "user_local",
    });
    await createAgentThread(fixture, {
      body: "Agent-authored messages never dispatch.",
      actor: "agent",
    });
    await createAgentThread(fixture, {
      body: "CLI-origin human messages never dispatch.",
      authorUserId: "user_local",
      origin: "cli",
    });
    await createAgentThread(fixture, {
      body: "Another signed-in user cannot dispatch this agent.",
      authorUserId: "user_remote",
    });
    const localWithoutRelayIdentity = await createAgentThread(fixture, {
      body: "A solo/local send is allowed without authorUserId.",
    });
    const general = await fixture.chat.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const mention = await fixture.chat.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Ice" },
      authorUserId: "user_local",
      body: "Could @agent audit this plan?",
    });
    await fixture.chat.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "@agent does not recursively dispatch itself.",
    });

    fixture.service.setPaused(true);
    await activate(fixture);

    expect(
      fixture.dispatch.listPending(WORKSPACE_ID).map((record) => record.triggerMessageId),
    ).toEqual([agentHuman.messageId, localWithoutRelayIdentity.messageId, mention.message.id]);

    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(
      fixture.dispatch.listPending(WORKSPACE_ID).map((record) => record.triggerMessageId),
    ).toEqual([agentHuman.messageId, localWithoutRelayIdentity.messageId, mention.message.id]);
    expect(fixture.spawnCalls).toHaveLength(0);
  });

  it("keeps the SQL trigger predicate aligned with the service predicate matrix", async () => {
    const fixture = await createFixture();
    const agentChannel = await fixture.chat.ensureAgentChannel({
      workspaceId: WORKSPACE_ID,
    });
    const generalChannel = await fixture.chat.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const candidates: Array<{
      message: Awaited<ReturnType<LinkedChatStore["startChannelThread"]>>["message"];
      channelKind: "agent" | "channel";
      mentionsAgent: boolean;
    }> = [];
    let caseNumber = 0;
    for (const authorKind of ["human", "agent"] as const) {
      for (const cliOrigin of [false, true]) {
        for (const channelKind of ["agent", "channel"] as const) {
          for (const mentionsAgent of [false, true]) {
            caseNumber += 1;
            const started = await fixture.chat.startChannelThread({
              workspaceId: WORKSPACE_ID,
              channelId:
                channelKind === "agent" ? agentChannel.id : generalChannel.id,
              author: { kind: authorKind, displayName: "Ice" },
              authorUserId: "user_local",
              ...(cliOrigin ? { origin: "cli" as const } : {}),
              body: `Trigger predicate case ${caseNumber}${
                mentionsAgent ? " @agent" : ""
              }`,
            });
            candidates.push({
              message: started.message,
              channelKind,
              mentionsAgent,
            });
          }
        }
      }
    }

    const recordedCount = fixture.dispatch.recordEligibleTriggers({
      workspaceId: WORKSPACE_ID,
      verifiedUserId: "user_local",
    });
    const recordedIds = new Set(
      fixture.dispatch
        .listPending(WORKSPACE_ID)
        .map((record) => record.triggerMessageId),
    );
    const expected = candidates.filter(({ message, channelKind, mentionsAgent }) =>
      messageCanTrigger(message, "user_local", {
        channelKind,
        mentionsAgent,
      }),
    );

    expect(recordedCount).toBe(expected.length);
    for (const candidate of candidates) {
      expect(recordedIds.has(candidate.message.id)).toBe(
        messageCanTrigger(candidate.message, "user_local", {
          channelKind: candidate.channelKind,
          mentionsAgent: candidate.mentionsAgent,
        }),
      );
    }
  });

  it("advances across all scanned messages while overlapping cursor ties", async () => {
    const fixture = await createFixture();
    const generalChannel = await fixture.chat.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const unrelated = await fixture.chat.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: generalChannel.id,
      author: { kind: "human", displayName: "Ice" },
      authorUserId: "user_local",
      body: "A general message with no agent mention.",
    });
    expect(
      fixture.dispatch.recordEligibleTriggers({
        workspaceId: WORKSPACE_ID,
        verifiedUserId: "user_local",
      }),
    ).toBe(0);
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT max_created_at_ms
           FROM chat_dispatch_scan_cursor
           WHERE workspace_id = ?`,
        )
        .get(WORKSPACE_ID),
    ).toEqual({ max_created_at_ms: unrelated.message.createdAtMs });

    const tied = await createAgentThread(fixture, {
      body: "A trigger tied at the cursor timestamp.",
      authorUserId: "user_local",
    });
    fixture.dispatchDb
      .prepare(
        `UPDATE chat_messages
         SET created_at_ms = ?
         WHERE workspace_id = ? AND message_id = ?`,
      )
      .run(unrelated.message.createdAtMs, WORKSPACE_ID, tied.messageId);

    expect(
      fixture.dispatch.recordEligibleTriggers({
        workspaceId: WORKSPACE_ID,
        verifiedUserId: "user_local",
      }),
    ).toBe(1);
    expect(
      fixture.dispatch
        .listPending(WORKSPACE_ID)
        .map((record) => record.triggerMessageId),
    ).toEqual([tied.messageId]);
  });

  it.each(["sqlite", "live"] as const)(
    "keeps workspace FIFO and the spawn contract with the %s dispatch backend",
    async (dispatchBackend) => {
    // Pin command resolution to a no-op: with an empty host PATH the resolver
    // can never find a claude binary or .cmd shim on the machine running the
    // tests, so the spawn contract below (bare command, unwrapped args) is
    // asserted identically everywhere. The runner env still prepends the
    // fixture's CLI bin dir, which the PATH assertion below relies on.
    vi.stubEnv("PATH", "");
    vi.stubEnv("Path", "");
    const fixture = await createFixture({
      dispatchBackend,
      runner: {
        command: 'claude -p --allowedTools "Bash(dohc chat:*)"',
      },
    });
    const first = await createAgentThread(fixture, {
      title: "Launch review",
      body: "Audit the rollback plan.",
      authorUserId: "user_local",
    });
    const second = await createAgentThread(fixture, {
      title: "Export review",
      body: "Then audit exports.",
      authorUserId: "user_local",
    });

    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(1);
    const firstClaim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    expect(firstClaim?.run.threadId).toBe(first.threadId);
    expect(firstClaim?.run.command).toBe(fixture.runner.command);
    expect(fixture.dispatch.listPending(WORKSPACE_ID).map((record) => record.threadId)).toEqual([
      second.threadId,
    ]);

    const firstSpawn = fixture.spawnCalls[0]!;
    expect(firstSpawn.command).toMatch(/(?:^|[\\/])claude(?:\.exe)?$/iu);
    expect(firstSpawn.args.slice(0, -1)).toEqual(["-p", "--allowedTools", "Bash(dohc chat:*)"]);
    const prompt = firstSpawn.args.at(-1);
    expect(prompt).toContain("# Launch review");
    expect(prompt).toContain("Audit the rollback plan.");
    expect(prompt).toContain(`dohc chat reply ${first.threadId} --as-agent`);
    expect(prompt).toContain("Your final text is not shown anywhere");
    expect(firstSpawn.options).toMatchObject({
      cwd: fixture.root,
      detached: true,
      windowsHide: true,
    });
    expect(firstSpawn.options.stdio[0]).toBe("ignore");
    expect(typeof firstSpawn.options.stdio[1]).toBe("number");
    expect(firstSpawn.options.stdio[2]).toBe(firstSpawn.options.stdio[1]);
    expect(firstSpawn.options.env.DOHC_CHAT_THREAD).toBe(first.threadId);
    expect(firstSpawn.options.env.DOHC_CHAT_ACTOR).toBe("agent");
    expect(firstSpawn.options.env.DOHC_RUN_ID).toBe(firstClaim?.run.runId);
    expect(firstSpawn.options.env.PATH?.split(delimiter)[0]).toBe(
      resolve(fixture.appRoot, "node_modules", ".bin"),
    );

    if (!firstClaim) throw new Error("Expected the first run claim.");
    await linkAgentReply(fixture, first.threadId, firstClaim.run.runId);
    firstSpawn.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(second.threadId);
    expect(fixture.dispatch.getRunRecord(firstClaim.run.runId)).toMatchObject({
      exitCode: 0,
      failureNotePosted: false,
    });
    expect(fixture.runUpdatedWorkspaces).toContain(WORKSPACE_ID);
    const firstMessages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: first.threadId,
    });
    expect(firstMessages.some((message) => message.body.startsWith("⚠"))).toBe(false);
    },
  );

  it("releases temporary tray-only run activity after the owned child exits", async () => {
    const fixture = await createFixture({ temporaryRunActivity: true });
    const trigger = await createAgentThread(fixture, {
      body: "Run with temporary workspace activity.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 0 });
    expect(fixture.runUpdatedWorkspaces).toContain(WORKSPACE_ID);
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 1 });
  });

  it("preserves a surviving runner claim across a daemon lifecycle swap", async () => {
    const fixture = await createFixture({ dispatchBackend: "live" });
    const trigger = await createAgentThread(fixture, {
      body: "Keep this runner alive while the daemon restarts.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim || !fixture.restartDaemon) {
      throw new Error("Expected a live runner and restartable daemon.");
    }
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);

    fixture.restartDaemon();
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 0,
    });
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state, attempt_count
           FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(WORKSPACE_ID, trigger.messageId),
    ).toMatchObject({ state: "done", attempt_count: 1 });
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("keeps an exited live claim recoverable until daemon completion is durable", async () => {
    // MUTATION: remove the explicit recovery timer -> a local-only workspace
    // never makes the seventh repair attempt after the first six are exhausted.
    const fixture = await createFixture({
      dispatchBackend: "live",
      temporaryRunActivity: true,
    });
    const first = await createAgentThread(fixture, {
      body: "Finish while the sidecar repeatedly restarts.",
      authorUserId: "user_local",
    });
    const second = await createAgentThread(fixture, {
      body: "Run only after the first completion is durable.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim || !fixture.rejectCompleteRuns) {
      throw new Error("Expected a live run and injectable completion failures.");
    }
    await linkAgentReply(fixture, first.threadId, claim.run.runId);
    vi.useFakeTimers();
    fixture.rejectCompleteRuns(
      Array.from(
        { length: 6 },
        () => new EngineClientError(
          "transport-error",
          "sidecar exited during completion",
        ),
      ),
    );

    fixture.spawnCalls[0]!.process.emitExit(0);
    await flushMicrotasks(100);

    expect(fixture.completeRunRequests).toBe(6);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).not.toHaveProperty(
      "endedAtMs",
    );
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(WORKSPACE_ID, first.messageId),
    ).toEqual({ state: "running" });
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 0 });
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.syncRequests).toEqual([]);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS - 1);
    expect(fixture.completeRunRequests).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks(100);

    expect(fixture.completeRunRequests).toBe(7);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 0,
    });
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(
      second.threadId,
    );
    expect(fixture.syncRequests).toEqual([]);
  });

  it("keeps a pre-run claim and lease until failure persistence is durable", async () => {
    const fixture = await createFixture({
      dispatchBackend: "live",
      temporaryRunActivity: true,
      runner: { command: '"' },
    });
    const first = await createAgentThread(fixture, {
      body: "Fail during runner setup while the daemon is unavailable.",
      authorUserId: "user_local",
    });
    const second = await createAgentThread(fixture, {
      body: "Run after the startup failure becomes durable.",
      authorUserId: "user_local",
    });
    if (!fixture.rejectFailRuns) {
      throw new Error("Expected injectable failure persistence errors.");
    }
    vi.useFakeTimers();
    fixture.rejectFailRuns(
      Array.from(
        { length: 6 },
        () => new EngineClientError(
          "transport-error",
          "sidecar exited during startup failure persistence",
        ),
      ),
    );

    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected the pre-run claim to remain open.");

    expect(fixture.failRunRequests).toBe(6);
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 0 });
    expect(fixture.spawnCalls).toEqual([]);
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(WORKSPACE_ID, first.messageId),
    ).toEqual({ state: "running" });

    fixture.runner.command = "claude -p";
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await flushMicrotasks(100);

    expect(fixture.failRunRequests).toBe(7);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      failureReason: expect.stringContaining("runner failed to start"),
    });
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(
      second.threadId,
    );
  });

  it("releases the live slot when the final run-message lookup rejects", async () => {
    // MUTATION: await listRunMessages before terminal cleanup -> the second
    // trigger remains wedged behind the leaked finalized live slot.
    const fixture = await createFixture({
      dispatchBackend: "live",
      temporaryRunActivity: true,
    });
    const first = await createAgentThread(fixture, {
      body: "Finish while the daemon read is unavailable.",
      authorUserId: "user_local",
    });
    const next = await createAgentThread(fixture, {
      body: "Dispatch after the failed final lookup.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const firstClaim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    const lookupError = new Error("daemon restarted during listRunMessages");
    if (!firstClaim || !fixture.rejectNextRunMessageLookup) {
      throw new Error("Expected a live runner and injectable daemon failure.");
    }

    fixture.rejectNextRunMessageLookup(lookupError);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.errors).toContain(lookupError);
    expect(fixture.dispatch.getRunRecord(firstClaim.run.runId)).toMatchObject({
      exitCode: 0,
    });
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(next.threadId);
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: first.threadId,
    });
    expect(
      messages.filter(
        ({ body }) =>
          body ===
          "⚠ Agent run produced no reply. Open the run chip for details.",
      ),
    ).toHaveLength(1);
    expect(fixture.dispatch.getRunRecord(firstClaim.run.runId)).toMatchObject({
      failureNotePosted: true,
    });
  });

  it("coalesces pending triggers in one thread and dispatches a later message as a follow-up", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "First request.",
      authorUserId: "user_local",
    });
    for (const body of ["Second request.", "Third request."]) {
      await fixture.chat.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: trigger.threadId,
        author: { kind: "human", displayName: "Ice" },
        authorUserId: "user_local",
        body,
      });
    }

    await activate(fixture);

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND thread_id = ?
           ORDER BY trigger_message_id`,
        )
        .all(WORKSPACE_ID, trigger.threadId)
        .map((row) => row.state),
    ).toEqual(["running", "done", "done"]);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toEqual({
      liveRun: true,
      pendingCount: 0,
      paused: false,
    });

    await fixture.chat.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
      author: { kind: "human", displayName: "Ice" },
      authorUserId: "user_local",
      body: "Arrived after spawn.",
    });
    const updatesBeforeFollowUpScan = fixture.runUpdatedWorkspaces.length;
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.runUpdatedWorkspaces.length).toBeGreaterThan(updatesBeforeFollowUpScan);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toMatchObject({
      liveRun: true,
      pendingCount: 1,
    });

    const firstClaim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!firstClaim) throw new Error("Expected the coalesced run.");
    await linkAgentReply(fixture, trigger.threadId, firstClaim.run.runId);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(trigger.threadId);
  });

  it("pumps a sync-bound workspace that was never renderer-opened", async () => {
    vi.useFakeTimers();
    let inserted = false;
    const fixture = await createFixture({
      pumpWorkspace: true,
      onQueueSync: async (_workspaceId, chat) => {
        if (inserted) return;
        inserted = true;
        const channel = await chat.ensureAgentChannel({
          workspaceId: WORKSPACE_ID,
        });
        await chat.startChannelThread({
          workspaceId: WORKSPACE_ID,
          channelId: channel.id,
          author: { kind: "human", displayName: "Ice" },
          authorUserId: "user_local",
          body: "Remote tray-only task.",
        });
      },
    });

    fixture.service.start();
    expect(fixture.spawnCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_PUMP_MS);
    await flushMicrotasks(50);

    expect(fixture.syncRequests).toEqual([WORKSPACE_ID]);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.args.at(-1)).toContain("Remote tray-only task.");
  });

  it("starts workspace pump syncs concurrently", async () => {
    vi.useFakeTimers();
    const secondWorkspace = {
      workspaceId: "workspace-chat-dispatch-second",
      rootPath: "/unused/second-workspace",
    };
    let releaseFirst: (() => void) | undefined;
    const firstSync = new Promise<void>((resolveFirst) => {
      releaseFirst = resolveFirst;
    });
    const starts: string[] = [];
    const fixture = await createFixture({
      pumpWorkspaces: [
        { workspaceId: WORKSPACE_ID, rootPath: "/unused/first-workspace" },
        secondWorkspace,
      ],
      onQueueSync: async (workspaceId) => {
        starts.push(workspaceId);
        if (workspaceId === WORKSPACE_ID) await firstSync;
        return false;
      },
    });

    fixture.service.start();
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_PUMP_MS);
    await flushMicrotasks();
    expect(starts).toEqual([WORKSPACE_ID, secondWorkspace.workspaceId]);

    releaseFirst?.();
    await flushMicrotasks();
  });

  it("fails no-runner triggers and keeps one setup note per thread", async () => {
    const fixture = await createFixture({ runner: { enabled: false } });
    const trigger = await createAgentThread(fixture, {
      body: "Needs a runner.",
      authorUserId: "user_local",
    });

    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state, failure_reason FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(WORKSPACE_ID, trigger.messageId),
    ).toEqual({ state: "failed", failure_reason: "no-runner" });
    let messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    const setupNotes = messages.filter(
      (message) => message.body === NO_RUNNER_NOTE,
    );
    expect(setupNotes).toHaveLength(1);
    expect(setupNotes[0]?.author).toEqual({
      kind: "agent",
      displayName: "Ice",
    });

    await fixture.chat.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
      author: { kind: "human", displayName: "Ice" },
      authorUserId: "user_local",
      body: "Still needs the same missing runner.",
    });
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.body === NO_RUNNER_NOTE)).toHaveLength(1);
    expect(fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
  });

  it("loads pause state once per pending thread on the live backend", async () => {
    // MUTATION: restore the per-candidate pause query -> the two dispatches in
    // the paused thread produce a third daemon round-trip.
    const fixture = await createFixture({ dispatchBackend: "live" });
    const paused = await createAgentThread(fixture, {
      body: "Keep this thread paused.",
      authorUserId: "user_local",
    });
    const pausedFollowUp = await fixture.chat.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: paused.threadId,
      author: { kind: "human", displayName: "Ice" },
      authorUserId: "user_local",
      body: "This second trigger is paused too.",
    });
    const runnable = await createAgentThread(fixture, {
      body: "Run after skipping the paused thread.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: paused.messageId,
      threadId: paused.threadId,
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: pausedFollowUp.id,
      threadId: paused.threadId,
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: runnable.messageId,
      threadId: runnable.threadId,
    });
    fixture.dispatch.setThreadDispatchPaused({
      workspaceId: WORKSPACE_ID,
      threadId: paused.threadId,
      paused: true,
    });

    await activate(fixture);

    const pauseRequests = fixture.dispatchRequests.filter(
      ({ method }) => method === "chats.dispatch.getThreadPauseState",
    );
    expect(pauseRequests).toHaveLength(2);
    expect(
      new Set(
        pauseRequests.map(({ params }) =>
          String((params as { threadId: JsonValue }).threadId),
        ),
      ),
    ).toEqual(new Set([paused.threadId, runnable.threadId]));
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(
      runnable.threadId,
    );
  });

  it("re-resolves an ambiguously committed claim even when pending is empty", async () => {
    // MUTATION: consult the uncertain claim only from claimNextPending inside
    // the listPending loop -> the committed running row is invisible on retry.
    const fixture = await createFixture({ ambiguousClaimOnce: true });
    const trigger = await createAgentThread(fixture, {
      body: "Recover this lost claim response.",
      authorUserId: "user_local",
    });

    fixture.service.start();
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toMatchObject({ code: "transport-error" });
    expect(fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)).toHaveLength(1);
    expect(fixture.spawnCalls).toEqual([]);

    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(
      trigger.threadId,
    );
  });

  it("reserves the workspace while the asynchronous claim is pending", async () => {
    // MUTATION: add runReservations only inside startClaim -> runnerSelfTest
    // starts a competing process while the daemon claim is unresolved.
    const fixture = await createFixture({ deferClaim: true });
    await createAgentThread(fixture, {
      body: "Hold the claim while self-test checks the slot.",
      authorUserId: "user_local",
    });

    fixture.service.start();
    const scanning = fixture.service.scanWorkspace(WORKSPACE_ID);
    await fixture.claimStarted;

    const selfTest = fixture.service.runnerSelfTest(WORKSPACE_ID);
    void selfTest.catch(() => undefined);
    await flushMicrotasks();
    const competingSpawnCount = fixture.spawnCalls.length;
    if (competingSpawnCount > 0) {
      fixture.spawnCalls[0]!.process.emitExit(1);
    }
    fixture.releaseClaim?.();
    expect(competingSpawnCount).toBe(0);
    await expect(selfTest).resolves.toEqual({
      ok: false,
      detail: "A runner is already active in this workspace.",
    });

    await scanning;
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("pauses a thread at the ten-run rolling dispatch budget and posts one note", async () => {
    const fixture = await createFixture();
    const pending = await createAgentThread(fixture, {
      body: "This next dispatch should pause.",
      authorUserId: "user_local",
    });
    for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
      const triggerMessageId = `seed_message_${index}`;
      fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: pending.threadId,
      });
      const claim = fixture.dispatch.claimNextPending(WORKSPACE_ID, {
        command: "seed-runner",
      });
      if (!claim) throw new Error("Expected a seeded budget claim.");
      fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
    }

    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(0);
    expect(fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId)).toBe(true);
    const pauseRow = fixture.dispatchDb
      .prepare(
        `SELECT reason FROM chat_dispatch_pause
         WHERE workspace_id = ? AND thread_id = ?`,
      )
      .get(WORKSPACE_ID, pending.threadId);
    expect(pauseRow?.reason).toBe("re-dispatch budget exceeded");
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, pending.threadId)).toEqual({
      liveRun: false,
      pendingCount: 1,
      paused: true,
      pausedReason: "re-dispatch budget exceeded",
    });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: pending.threadId,
    });
    expect(messages.filter((message) => message.body.startsWith("⏸ Agent dispatch"))).toHaveLength(
      1,
    );
    expect(messages.at(-1)?.body).toContain("Resume in this thread");
    expect(fixture.postedWorkspaces).toEqual([WORKSPACE_ID]);

    await fixture.service.resumeThreadDispatch(WORKSPACE_ID, pending.threadId);
    expect(fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId)).toBe(false);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, pending.threadId)).toMatchObject({
      liveRun: true,
      pendingCount: 0,
      paused: false,
    });
  });

  it("restores a Resume budget bypass when the claim RPC rejects", async () => {
    // MUTATION: consume the bypass before claimNextPending without restoring it
    // in the error path -> the recovery scan immediately pauses this thread.
    const fixture = await createFixture({
      claimFailures: [
        new EngineClientError(
          "transport-error",
          "daemon disconnected during claim",
        ),
      ],
    });
    const pending = await createAgentThread(fixture, {
      body: "Resume through one failed claim.",
      authorUserId: "user_local",
    });
    for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
      const triggerMessageId = `resume_seed_${index}`;
      fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: pending.threadId,
      });
      const claim = fixture.dispatch.claimNextPending(WORKSPACE_ID);
      if (!claim) throw new Error("Expected a seeded budget claim.");
      fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
    }
    fixture.dispatch.setThreadDispatchPaused({
      workspaceId: WORKSPACE_ID,
      threadId: pending.threadId,
      paused: true,
      reason: "re-dispatch budget exceeded",
    });

    fixture.service.start();
    await expect(
      fixture.service.resumeThreadDispatch(WORKSPACE_ID, pending.threadId),
    ).rejects.toMatchObject({ code: "transport-error" });
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(
      fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId),
    ).toBe(false);
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("posts a nonzero-exit failure note exactly once", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Run a failing audit.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    fixture.spawnCalls[0]!.process.emitExit(7);
    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    const notes = messages.filter(
      (message) => message.body === "⚠ Agent run failed (exit 7). Open the run chip for details.",
    );
    expect(notes).toHaveLength(1);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 7,
      failureNotePosted: true,
    });
    expect(fixture.dispatch.listRunMessages(WORKSPACE_ID, claim.run.runId)).toEqual([notes[0]!.id]);
  });

  it("deadlines every daemon RPC awaited before terminal persistence", async () => {
    // MUTATION: omit the request options from any lookup/note call -> that
    // method appears below without a client deadline and can wedge the live slot.
    const fixture = await createFixture({ dispatchBackend: "live" });
    await createAgentThread(fixture, {
      body: "Fail after exercising every pre-terminal daemon call.",
      authorUserId: "user_local",
    });
    await activate(fixture);

    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const methods = new Set([
      "chats.dispatch.listRunMessages",
      "chats.dispatch.getRunRecord",
      "chats.dispatch.recordRunMessage",
      "chats.dispatch.markFailureNotePosted",
      "chats.dispatch.listAppQuitRecoveries",
    ]);
    const requests = fixture.dispatchRequests.filter(({ method }) =>
      methods.has(method),
    );
    expect(new Set(requests.map(({ method }) => method))).toEqual(methods);
    expect(requests.every(
      ({ deadlineMs }) => deadlineMs === AGENT_DISPATCH_RPC_DEADLINE_MS,
    )).toBe(true);
  });

  it("finalizes a failed run and dispatches the next claim when its failure note throws", async () => {
    const fixture = await createFixture();
    const first = await createAgentThread(fixture, {
      body: "Fail this run.",
      authorUserId: "user_local",
    });
    const second = await createAgentThread(fixture, {
      body: "Run after the failed note.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");
    const noteError = new Error("failure note write failed");
    vi.spyOn(fixture.chat, "listMessages").mockRejectedValueOnce(noteError);

    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 7,
      failureNotePosted: false,
    });
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(WORKSPACE_ID, first.messageId)?.state,
    ).toBe("done");
    expect(fixture.errors).toContain(noteError);
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(second.threadId);
  });

  it("skips service notes when the shared-channel write gate rejects", async () => {
    const fixture = await createFixture({ serviceNotesWritable: false });
    const trigger = await createAgentThread(fixture, {
      body: "This grant is revoked before the runner exits.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 7,
      failureNotePosted: true,
    });
    expect(fixture.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Skipped an agent service note"),
      }),
    ]);
  });

  it("posts a failure note when an exit-zero run produces no linked reply", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Run silently.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.filter(
        (message) =>
          message.body === "⚠ Agent run produced no reply. Open the run chip for details.",
      ),
    ).toHaveLength(1);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 0,
      failureNotePosted: true,
    });
  });

  it("does not report no reply while CLI provenance recovery is pending", async () => {
    vi.useFakeTimers();
    let linkPending = true;
    const fixture = await createFixture({
      hasPendingRunMessageLink: () => linkPending,
    });
    const trigger = await createAgentThread(fixture, {
      body: "Wait for my CLI reply provenance.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    let messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.some((message) => message.body.includes("produced no reply")),
    ).toBe(false);

    linkPending = false;
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await flushMicrotasks();
    messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.filter((message) => message.body.includes("produced no reply")),
    ).toHaveLength(1);
  });

  it("fails an interrupted startup run and re-dispatches its trigger once", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Resume this after restart.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const interrupted = fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");

    await activate(fixture);

    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: interrupted.run.runId,
      },
    ]);
    expect(fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureNotePosted: true,
    });
    const retried = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    expect(retried?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("recovers a restart-failed row left behind before its requeue", async () => {
    // MUTATION: query only exit-143 app-quit rows -> this durable restart
    // failure is invisible after a crash between failRun and requeue.
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Recover the persisted half of restart recovery.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const interrupted = fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!interrupted) throw new Error("Expected an interrupted run.");
    fixture.dispatch.failRun({
      runId: interrupted.run.runId,
      reason: "app restart during run",
    });

    await activate(fixture);

    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: interrupted.run.runId,
      },
    ]);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.some((message) =>
        message.body.startsWith(
          "⚠ Agent run failed (app restarted during run).",
        ),
      ),
    ).toBe(true);
  });

  it("retains an interrupted requeue intent until the ledger transition persists", async () => {
    // MUTATION: remove pendingInterruptedRequeues or mark the workspace swept
    // after the first failed requeue -> the terminal trigger is undiscoverable
    // and this test never observes the second attempt or a replacement runner.
    vi.useFakeTimers();
    const fixture = await createFixture({
      requeueFailures: [new Error("daemon unavailable during requeue")],
    });
    const trigger = await createAgentThread(fixture, {
      body: "Retry this interrupted recovery.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const interrupted = fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");

    fixture.service.start();
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureReason: "app restart during run",
    });
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.requeues).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await flushMicrotasks();

    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: interrupted.run.runId,
      },
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: interrupted.run.runId,
      },
    ]);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
  });

  it("retries a failed local-only trigger scan after the daemon recovers", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({
      recordEligibleTriggerFailures: [new Error("daemon restarted during scan")],
    });
    await createAgentThread(fixture, {
      body: "Dispatch after the local scan recovers.",
      authorUserId: "user_local",
    });

    fixture.service.start();
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toThrow("daemon restarted during scan");
    expect(fixture.spawnCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await flushMicrotasks();

    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("backs off repeated local-only recovery scan failures", async () => {
    // MUTATION: keep recovery retries at a flat delay -> the third scan runs
    // after one second instead of waiting for the doubled second delay.
    vi.useFakeTimers();
    const fixture = await createFixture({
      recordEligibleTriggerFailures: [
        new Error("daemon unavailable"),
        new Error("daemon still unavailable"),
      ],
    });
    await createAgentThread(fixture, {
      body: "Dispatch after escalating recovery backoff.",
      authorUserId: "user_local",
    });

    fixture.service.start();
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toThrow("daemon unavailable");

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await flushMicrotasks();
    expect(fixture.spawnCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(
      CHAT_DISPATCH_RECOVERY_BACKOFF_MS * 2 - 1,
    );
    expect(fixture.spawnCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("surfaces and requeues an interrupted live-backend run on desktop restart", async () => {
    // MUTATION: omit recoverRunningDispatches:false on the initial workspace
    // open -> the daemon reclaims this row before startupSweep can post its
    // recovery note, and the exhausted history becomes invisible.
    const fixture = await createFixture({ dispatchBackend: "live" });
    const trigger = await createAgentThread(fixture, {
      body: "Recover this live-backend crash.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const interrupted = fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!interrupted) throw new Error("Expected an interrupted live run.");

    await activate(fixture);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.filter((message) =>
        message.body.startsWith(
          "⚠ Agent run failed (app restarted during run).",
        ),
      ),
    ).toHaveLength(1);
    expect(fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureReason: "app restart during run",
      failureNotePosted: true,
    });
    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: interrupted.run.runId,
      },
    ]);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
  });

  it("surfaces an exhausted live-backend run without a third attempt", async () => {
    const fixture = await createFixture({ dispatchBackend: "live" });
    const trigger = await createAgentThread(fixture, {
      body: "Surface the exhausted live-backend crash.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const first = fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!first) throw new Error("Expected a first live-backend attempt.");
    fixture.dispatch.failRun({
      runId: first.run.runId,
      reason: "seed first failure",
    });
    expect(
      fixture.requeueRaw({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: first.run.runId,
      }),
    ).toBe(true);
    const exhausted = fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!exhausted) throw new Error("Expected a second live-backend attempt.");
    expect(exhausted.dispatch.attemptCount).toBe(2);

    await activate(fixture);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.filter((message) =>
        message.body.startsWith(
          "⚠ Agent run failed (app restarted during run).",
        ),
      ),
    ).toHaveLength(1);
    expect(fixture.dispatch.getRunRecord(exhausted.run.runId)).toMatchObject({
      failureReason: "app restart during run",
      failureNotePosted: true,
    });
    expect(fixture.requeues).toEqual([]);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]);
    expect(fixture.spawnCalls).toEqual([]);
  });

  it("does not requeue a startup run that is already the second attempt", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Do not retry this a third time.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const first = fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!first) throw new Error("Expected the first attempt.");
    fixture.dispatch.failRun({
      runId: first.run.runId,
      reason: "seed restart",
    });
    expect(
      fixture.requeueRaw({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: first.run.runId,
      }),
    ).toBe(true);
    const second = fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!second) throw new Error("Expected the second attempt.");
    expect(second.dispatch.attemptCount).toBe(2);

    await activate(fixture);

    expect(fixture.requeues).toHaveLength(0);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)).toHaveLength(0);
  });

  it("posts and requeues a flushed app-quit run on the next startup", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Recover this clean-shutdown interruption.",
      authorUserId: "user_local",
    });
    fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
    });
    const interrupted = fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an app-quit run.");
    fixture.dispatch.failRun({
      runId: interrupted.run.runId,
      exitCode: APP_QUIT_EXIT_CODE,
      reason: "app-quit",
    });

    await activate(fixture);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.filter((message) =>
        message.body.startsWith("⚠ Agent run failed (app quit during run)."),
      ),
    ).toHaveLength(1);
    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: interrupted.run.runId,
      },
    ]);
    expect(fixture.dispatch.openRuns(WORKSPACE_ID)[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
  });

  it("flushes a live run for next-boot recovery without posting during quit", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Quit while this is running.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    const stopping = fixture.service.stop();
    await flushMicrotasks();

    expect(fixture.killCalls).toContainEqual({
      pid: -fixture.spawnCalls[0]!.process.pid!,
      signal: "SIGTERM",
    });
    await vi.advanceTimersByTimeAsync(APP_QUIT_KILL_GRACE_MS - 1);
    expect(fixture.killCalls.some((call) => call.signal === "SIGKILL")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: APP_QUIT_EXIT_CODE,
      failureNotePosted: false,
    });
    expect(fixture.killCalls).toContainEqual({
      pid: -fixture.spawnCalls[0]!.process.pid!,
      signal: "SIGKILL",
    });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.some((message) => message.body.includes("app quit during run"))).toBe(false);
  });

  it("terminates an app-quit runner when persisting its failure rejects", async () => {
    // MUTATION: start quit termination after failRun -> this rejection leaves
    // the detached runner alive and neither signal is observed.
    vi.useFakeTimers();
    const fixture = await createFixture({ dispatchBackend: "live" });
    await createAgentThread(fixture, {
      body: "Quit while persistence is unavailable.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const persistenceError = new Error("daemon unavailable during app quit");
    if (!fixture.rejectNextFailRun) {
      throw new Error("Expected injectable daemon failure.");
    }
    fixture.rejectNextFailRun(persistenceError);

    const stopping = fixture.service.stop();
    await flushMicrotasks();

    expect(fixture.killCalls).toContainEqual({
      pid: -fixture.spawnCalls[0]!.process.pid!,
      signal: "SIGTERM",
    });
    await vi.advanceTimersByTimeAsync(APP_QUIT_KILL_GRACE_MS);
    await stopping;
    expect(fixture.killCalls).toContainEqual({
      pid: -fixture.spawnCalls[0]!.process.pid!,
      signal: "SIGKILL",
    });
    expect(fixture.errors).toContain(persistenceError);
  });

  it("times out a run, posts the timeout note, and escalates its process group", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({
      runner: { timeoutMinutes: 1 },
    });
    const trigger = await createAgentThread(fixture, {
      body: "This harness will hang.",
      authorUserId: "user_local",
    });
    const queued = await createAgentThread(fixture, {
      body: "This must wait for the timed-out process to exit.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
    expect(fixture.killCalls).toEqual([
      { pid: -fixture.spawnCalls[0]!.process.pid!, signal: "SIGTERM" },
    ]);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 124,
      failureNotePosted: true,
    });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.some((message) => message.body.includes("timed out after 1m"))).toBe(true);

    await vi.advanceTimersByTimeAsync(RUNNER_KILL_GRACE_MS);
    expect(fixture.killCalls.at(-1)).toEqual({
      pid: -fixture.spawnCalls[0]!.process.pid!,
      signal: "SIGKILL",
    });

    fixture.spawnCalls[0]!.process.emitExit(null, "SIGKILL");
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(queued.threadId);
  });

  it("retries timeout persistence for a local-only live workspace", async () => {
    // MUTATION: omit scheduleRecoveryScan from the timeout catch -> the open
    // claim remains running while the timed-out child is still unresponsive.
    vi.useFakeTimers();
    const fixture = await createFixture({
      dispatchBackend: "live",
      runner: { timeoutMinutes: 1 },
    });
    await createAgentThread(fixture, {
      body: "Persist this timeout after the daemon recovers.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim || !fixture.rejectFailRuns) {
      throw new Error("Expected a live run and injectable failure persistence errors.");
    }
    fixture.rejectFailRuns(
      Array.from(
        { length: 6 },
        () =>
          new EngineClientError(
            "transport-error",
            "sidecar unavailable during timeout persistence",
          ),
      ),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks(100);

    expect(fixture.failRunRequests).toBe(6);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).not.toHaveProperty(
      "endedAtMs",
    );

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await flushMicrotasks(100);

    expect(fixture.failRunRequests).toBe(7);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 124,
      failureReason: "timed out after 1m",
    });
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
  });

  it("finalizes a user-stopped run and dispatches queued work after that child exits", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Stop this run.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const process = fixture.spawnCalls[0]!.process;
    const claim = fixture.dispatch.openRuns(WORKSPACE_ID)[0];
    if (!claim) throw new Error("Expected a live run.");

    await expect(fixture.service.stopAgentRun(WORKSPACE_ID)).resolves.toBe(true);
    expect(fixture.killCalls).toEqual([{ pid: -process.pid!, signal: "SIGTERM" }]);
    expect(fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: APP_QUIT_EXIT_CODE,
      failureNotePosted: true,
    });
    expect(
      fixture.dispatchDb
        .prepare(
          `SELECT state FROM chat_dispatch_ledger
           WHERE workspace_id = ? AND trigger_message_id = ?`,
        )
        .get(WORKSPACE_ID, trigger.messageId)?.state,
    ).toBe("failed");
    const stoppedMessages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      stoppedMessages.filter((message) => message.body === "⏹ Agent run stopped."),
    ).toHaveLength(1);
    expect(stoppedMessages.some((message) => message.body.includes("failed (exit 143)"))).toBe(
      false,
    );
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toMatchObject({
      liveRun: false,
    });

    const followUp = await createAgentThread(fixture, {
      body: "Run after the stopped child is gone.",
      authorUserId: "user_local",
    });
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.spawnCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RUNNER_KILL_GRACE_MS);
    expect(fixture.killCalls).toEqual([
      { pid: -process.pid!, signal: "SIGTERM" },
      { pid: -process.pid!, signal: "SIGKILL" },
    ]);
    process.emitExit(null, "SIGKILL");
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(followUp.threadId);
  });

  it("passes the real spawn contract in a successful runner self-test", async () => {
    const fixture = await createFixture({
      runner: { command: "claude -p" },
    });

    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID);
    await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID });
    await flushMicrotasks();
    expect(fixture.spawnCalls).toHaveLength(1);
    const call = fixture.spawnCalls[0]!;
    const threadId = call.options.env.DOHC_CHAT_THREAD;
    const runId = call.options.env.DOHC_RUN_ID;
    if (!threadId || !runId) throw new Error("Expected self-test attribution.");
    const marker = `dohc-runner-self-test:${runId}`;
    expect(call.args.at(-1)).toContain(
      `dohc chat reply ${threadId} --as-agent "${marker}"`,
    );
    expect(runId).toBe("run_self_test_self_test_id_1");

    const openingMessages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId,
    });
    expect(openingMessages[0]).toMatchObject({
      author: { kind: "agent" },
      origin: "cli",
    });

    await fixture.chat.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId,
      author: { kind: "agent", displayName: "Ice" },
      origin: "cli",
      body: marker,
    });
    call.process.emitExit(0);

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      detail: "Runner self-test passed. The harness reported through dohc chat.",
    });
    expect(fixture.attributions.at(-1)).toEqual({
      workspaceId: WORKSPACE_ID,
      run: null,
    });

    const retryPromise = fixture.service.runnerSelfTest(WORKSPACE_ID);
    await flushMicrotasks();
    const retryCall = fixture.spawnCalls[1];
    if (!retryCall) throw new Error("Expected a self-test retry.");
    expect(retryCall.options.env.DOHC_CHAT_THREAD).toBe(threadId);
    const retryRunId = retryCall.options.env.DOHC_RUN_ID;
    if (!retryRunId) throw new Error("Expected retry attribution.");
    const retryMarker = `dohc-runner-self-test:${retryRunId}`;
    expect(retryMarker).not.toBe(marker);
    await fixture.chat.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId,
      author: { kind: "agent", displayName: "Ice" },
      origin: "cli",
      body: retryMarker,
    });
    retryCall.process.emitExit(0);
    await expect(retryPromise).resolves.toMatchObject({ ok: true });

    const agentChannel = await fixture.chat.ensureAgentChannel({
      workspaceId: WORKSPACE_ID,
    });
    const scratchThreads = await fixture.chat.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: agentChannel.id,
    });
    expect(
      scratchThreads.filter(
        (summary) => summary.thread.title === "dohc runner self-test",
      ),
    ).toHaveLength(1);
  });

  it("times out a runner self-test and escalates the same spawned group", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();

    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID);
    await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID });
    await flushMicrotasks();
    const process = fixture.spawnCalls[0]!.process;

    await vi.advanceTimersByTimeAsync(RUNNER_SELF_TEST_TIMEOUT_MS);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("timed out after 120 seconds"),
    });
    expect(fixture.killCalls).toEqual([{ pid: -process.pid!, signal: "SIGTERM" }]);

    await vi.advanceTimersByTimeAsync(RUNNER_KILL_GRACE_MS);
    expect(fixture.killCalls.at(-1)).toEqual({
      pid: -process.pid!,
      signal: "SIGKILL",
    });
  });

  it("tokenizes quoted runner arguments and rejects an unterminated command", () => {
    expect(
      tokenizeRunnerCommand('claude -p --allowedTools "Bash(dohc chat:*)" --label "two words"'),
    ).toEqual(["claude", "-p", "--allowedTools", "Bash(dohc chat:*)", "--label", "two words"]);
    expect(() => tokenizeRunnerCommand('claude -p "unterminated')).toThrow(
      "Runner command has an unterminated double quote.",
    );
  });
});
