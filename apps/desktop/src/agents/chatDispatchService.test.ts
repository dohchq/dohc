import type { ChatDispatchNotice } from "../ipc/bridgeContract";
import { agentProfileArguments } from "./agentToolCatalog";
import { codexRunConfig } from "./codexRunConfig";
import { APP_QUIT_KILL_GRACE_MS, RUNNER_KILL_GRACE_MS, type RunnerProcess, type RunnerSpawnOptions, type SpawnRunner } from "./chatRunnerProcess";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { CHATS_METHOD, type ChatDispatch, type JsonValue, type Request, type Response } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import type { AgentDispatchClaim, LinkedChatStore } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchFrom, type AgentLaunchProfile } from "./agentToolCatalog";
import { markRunLogEnded } from "./runLogRetention";
import { testAgent } from "../testing/agentSettings";
import type { Agent } from "../settings/userSettings";

// The first agent's launch, switch and timeout, which a test changes in place.
type RunnerSettings = { command: string; profile?: AgentLaunchProfile; enabled: boolean; timeoutMinutes: number };
import type { PostNoticeInput } from "../notices/noticeStore";
import { createOwedRunNotices, type OwedRunNotices } from "./owedRunNotices";
import { EngineClientError, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import { APP_QUIT_EXIT_CODE, CHAT_DISPATCH_BUDGET_MAX, CHAT_DISPATCH_PUMP_MS, CHAT_DISPATCH_RECOVERY_BACKOFF_MS, RUN_LOG_SWEEP_MS, RUNNER_OUTLIVED_STOP, createChatDispatchService, type ChatDispatchPresenceInput, type ChatDispatchService, type ChatDispatchWorkspace } from "./chatDispatchService";
import { type AwaitableAgentDispatchStore } from "./awaitableAgentDispatchStore";
import { createLiveAgentDispatchStore } from "./liveAgentDispatchStore";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createChatWrites, type ChatWriteStore } from "../workspaces/chatWrites";
import { answerDecision } from "@dohc/workspace-operations/chat-writes";
import { AGENTS_RESTRICTED_MESSAGE } from "./agentToolCatalog";
import { createWorkspaceTrust, type WorkspaceTrust } from "../workspaces/workspaceTrust";

const [bundledPlatform, bundledArch, nodeName] = process.platform === "win32"
  ? ["win32", "x64", "node.exe"] as const
  : ["darwin", "arm64", "node"] as const;

const WORKSPACE_ID = "workspace-chat-dispatch";
const CHAT_START_MS = Date.parse("2026-07-10T04:05:06.000Z");

type ChatDispatchServiceOptions = Parameters<typeof createChatDispatchService>[0];

interface SpawnCall {
  command: string;
  args: string[];
  options: RunnerSpawnOptions;
  process: FakeRunnerProcess;
}

class FakeRunnerProcess implements RunnerProcess {
  // What the dispatch delivered on stdin. The prompt travels here rather than
  // in argv, so this is where a test must look to prove it was sent at all.
  stdinText: string | null = null;
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
  packaged?: boolean;
  workspaceAttachmentId?: symbol;
  platform?: NodeJS.Platform;
  arch?: string;
  runner?: Partial<RunnerSettings>;
  // The default agent's name in Settings. Nova when absent.
  agentName?: string;
  // What the agent's Claude Code reports to --version. 2.1.317 when absent.
  claudeVersion?: string | null;
  // Agents after the default one, which `runner` sets up.
  agents?: Agent[];
  dispatchNoticeFailures?: Error[];
  // While set, the workspace's chat store throws, as a closed workspace's does.
  chatStoreClosed?: { closed: boolean };
  pumpWorkspace?: boolean;
  pumpWorkspaces?: ChatDispatchWorkspace[];
  onQueueSync?: (
    workspaceId: string,
    chat: LinkedChatStore,
  ) => void | boolean | Promise<void | boolean>;
  temporaryRunActivity?: boolean;
  setRunAttribution?: (
    workspaceId: string,
    run: { agentId: string; agentRunId: string; depth: number } | null,
  ) => void | Promise<void>;
  requeueFailures?: Error[];
  claimFailures?: Error[];
  prepareRunWorkspaceFailures?: Array<Error | null>;
  markFailureHandledFailures?: Error[];
  ambiguousClaimOnce?: boolean;
  deferClaim?: boolean;
  hasPendingRunMessageLink?: (workspaceId: string, runId: string) => boolean;
  // Each post of a run notice takes the next error, if any, and fails.
  noticeFailures?: Error[];
  // The workspace's sync is paused.
  syncPaused?: boolean;
  // Each record of an owed notice takes the next error, if any, and fails.
  owedAddFailures?: Error[];
  // The workspace starts in Restricted Mode.
  restricted?: boolean;
  // Runs after each trust lookup resolves, before its spawn check.
  afterTrustLookup?: (trust: WorkspaceTrust) => void | Promise<void>;
}

interface Fixture {
  root: string;
  stateRoot: string;
  appRoot: string;
  workspace: ChatDispatchWorkspace;
  chat: LinkedChatStore;
  dispatch: AwaitableAgentDispatchStore;
  service: ChatDispatchService;
  // What built the service, so a test can start another one on the same engine.
  serviceOptions: ChatDispatchServiceOptions;
  runner: RunnerSettings;
  spawnCalls: SpawnCall[];
  killCalls: Array<{ pid: number; signal: NodeJS.Signals }>;
  postedWorkspaces: string[];
  runUpdatedWorkspaces: string[];
  agentRequestGroups: Array<string | null>;
  syncRequests: string[];
  syncWorkspaces: ChatDispatchWorkspace[];
  presence: ChatDispatchPresenceInput[];
  attributions: Array<{
    workspaceId: string;
    run: { agentId: string; agentRunId: string; depth: number } | null;
  }>;
  errors: unknown[];
  dispatchNotices: Array<{ workspace: ChatDispatchWorkspace; notice: Omit<ChatDispatchNotice, "id"> }>;
  resumed: string[];
  notices: PostNoticeInput[];
  // Where the service keeps the runs whose notice is owed, and its own
  // view of them, which changes only once the file does.
  owedRunNoticesPath: string;
  owedRunNotices: OwedRunNotices;
  requeues: Array<{
    workspaceId: string;
    attachmentId?: symbol;
    triggerMessageId: string;
    agentId: string;
    runId: string;
  }>;
  runActivity: { acquires: number; releases: number };
  // How often a scan resolved the stores.
  storeResolves: { chat: number; dispatch: number };
  now: { value: number };
  readDispatch(triggerMessageId: string, threadId: string): ChatDispatch;
  setNextChatTimestamp(value: number): void;
  requeueRaw(input: {
    workspaceId: string;
    triggerMessageId: string;
    runId: string;
  }): Promise<boolean>;
  restartDaemon?(): void;
  rejectNextRunMessageLookup?(error: Error): void;
  rejectNextFailRun?(error: Error): void;
  rejectFailRuns?(errors: Error[]): void;
  rejectCompleteRuns?(errors: Error[]): void;
  dispatchRequests: Request[];
  failRunRequests: number;
  completeRunRequests: number;
  completeFailureAtMs: number | null;
  claimStarted?: Promise<void>;
  releaseClaim?(): void;
  closeDispatch(): Promise<void>;
  // This computer's workspace trust, kept in memory.
  trust: WorkspaceTrust;
}

const fixtures: Fixture[] = [];

function fakeRunner() {
  const spawnCalls: SpawnCall[] = [];
  let nextPid = 4_100;
  const spawnRunner: SpawnRunner = (command, args, spawnOptions) => {
    const process = new FakeRunnerProcess(nextPid);
    process.stdinText = spawnOptions.input;
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

  return {
    spawnRunner,
    spawnCalls,
    killCalls,
    killProcessGroup: (pid: number, signal: NodeJS.Signals) => {
      killCalls.push({ pid, signal });
    },
  };
}

async function fakeDispatchDaemon(
  workspace: ChatDispatchWorkspace,
  now: Fixture["now"],
  options: Pick<
    FixtureOptions,
    | "markFailureHandledFailures"
    | "deferClaim"
    | "claimFailures"
    | "ambiguousClaimOnce"
  >,
) {
  const chatIds = { channel: 0, message: 0, thread: 0 };
  let chatNow = CHAT_START_MS;
  let nextChatTimestamp: number | null = null;
  let nextRunId = 0;
  const engine = new ChatsLoopbackEngine();
  const dispatchRequests: Request[] = [];
  let failRunRequests = 0;
  let completeRunRequests = 0;
  let completeFailureAtMs: number | null = null;
  let nextRunMessageLookupError: Error | null = null;
  let nextFailRunError: Error | null = null;
  const failRunErrors: Error[] = [];
  const completeRunErrors: Error[] = [];
  let daemon: {
    close(): void;
    sendRequest(request: Request): Promise<Response>;
  };

  const takeChatTimestamp = (): number => {
    const value = chatNow;
    chatNow += 1_000;
    return value;
  };
  const sendRequest = async (request: Request): Promise<Response> => {
    dispatchRequests.push(request);
    const params = {
      ...(request.params as {
        [key: string]: JsonValue | undefined;
      }),
    };

    if (request.method === "workspace.open") {
      if (params.recoverRunningDispatches !== false) {
        engine.reclaimRunningDispatches(WORKSPACE_ID, now.value);
      }
      return { id: request.id, result: { workspace: WORKSPACE_ID } };
    }
    if (request.method === "workspace.close") {
      return { id: request.id, result: { closed: true } };
    }
    if (
      request.method === CHATS_METHOD.dispatchListRunMessages &&
      nextRunMessageLookupError
    ) {
      const error = nextRunMessageLookupError;
      nextRunMessageLookupError = null;
      throw error;
    }
    if (
      request.method === CHATS_METHOD.dispatchMarkFailureHandled &&
      options.markFailureHandledFailures?.length
    ) {
      daemon = { close: () => undefined, sendRequest };
      throw options.markFailureHandledFailures.shift()!;
    }
    if (request.method === CHATS_METHOD.dispatchComplete) {
      completeRunRequests += 1;
      const error = completeRunErrors.shift();
      if (error) {
        completeFailureAtMs = Date.now();
        daemon = { close: () => undefined, sendRequest };
        throw error;
      }
    }
    if (request.method === CHATS_METHOD.dispatchFail) {
      failRunRequests += 1;
      if (nextFailRunError) {
        const error = nextFailRunError;
        nextFailRunError = null;
        throw error;
      }
      const error = failRunErrors.shift();
      if (error) {
        daemon = { close: () => undefined, sendRequest };
        throw error;
      }
    }

    switch (request.method) {
      case CHATS_METHOD.channelCreate:
      case CHATS_METHOD.channelEnsureAgent:
      case CHATS_METHOD.channelEnsureGeneral:
        chatIds.channel += 1;
        params.channelId = `channel-${chatIds.channel}`;
        params.nowMs = takeChatTimestamp();
        break;
      case CHATS_METHOD.threadStart:
        chatIds.thread += 1;
        chatIds.message += 1;
        params.threadId = `thread-${chatIds.thread}`;
        params.messageId = `message-${chatIds.message}`;
        params.nowMs = nextChatTimestamp ?? takeChatTimestamp();
        nextChatTimestamp = null;
        break;
      case CHATS_METHOD.threadCreate:
        chatIds.thread += 1;
        params.threadId = `thread-${chatIds.thread}`;
        params.nowMs = takeChatTimestamp();
        break;
      case CHATS_METHOD.messageSend:
        chatIds.message += 1;
        params.messageId = `message-${chatIds.message}`;
        params.nowMs = nextChatTimestamp ?? takeChatTimestamp();
        nextChatTimestamp = null;
        break;
      case CHATS_METHOD.dispatchEnqueue:
      case CHATS_METHOD.dispatchClaimNextPending:
      case CHATS_METHOD.dispatchComplete:
      case CHATS_METHOD.dispatchFail:
        params.nowMs = now.value;
        break;
    }

    const response = await engine.sendRequest({
      ...request,
      params,
    });
    return response;
  };
  daemon = { close: () => undefined, sendRequest };
  const restartDaemon = () => {
    daemon = { close: () => undefined, sendRequest };
  };
  const rejectNextRunMessageLookup = (error: Error) => {
    nextRunMessageLookupError = error;
  };
  const rejectNextFailRun = (error: Error) => {
    nextFailRunError = error;
  };
  const rejectFailRuns = (errors: Error[]) => {
    failRunErrors.push(...errors);
  };
  const rejectCompleteRuns = (errors: Error[]) => {
    completeRunErrors.push(...errors);
  };
  const sessions = new EngineWorkspaceSessions(
    {
      currentClient: () => daemon,
    },
    {
      sleep: async () => undefined,
    },
  );
  const liveChat = createLiveLinkedChatStore(workspace, sessions);
  const chat = liveChat as unknown as LinkedChatStore;
  await liveChat.ensureOpen();
  const liveDispatch = createLiveAgentDispatchStore(workspace, sessions, {
    createRunId: () => `run_${(nextRunId += 1)}`,
  });
  const dispatch = liveDispatch.store;
  let serviceDispatch: AwaitableAgentDispatchStore = dispatch;
  const requeueRaw = liveDispatch.requeueFailedTrigger;
  const listRecoveriesRaw = liveDispatch.listFailedRunRecoveries;
  const closeDispatch = liveDispatch.close;
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
  if (
    options.claimFailures ||
    options.ambiguousClaimOnce ||
    options.deferClaim
  ) {
    const baseDispatch = serviceDispatch;
    let unresolvedClaim: AgentDispatchClaim | null = null;
    let ambiguousClaimInjected = false;
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
        if (
          options.ambiguousClaimOnce &&
          !ambiguousClaimInjected &&
          unresolvedClaim === null &&
          claim
        ) {
          ambiguousClaimInjected = true;
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
  return {
    chat,
    dispatch,
    serviceDispatch,
    listRecoveriesRaw,
    readDispatch: (triggerMessageId: string, threadId: string) => {
      const dispatch = engine.readDispatch(WORKSPACE_ID, triggerMessageId);
      if (dispatch === undefined || dispatch.threadId !== threadId) {
        throw new Error(`Expected dispatch ${triggerMessageId} for thread ${threadId}.`);
      }
      return dispatch;
    },
    setNextChatTimestamp: (value: number) => {
      nextChatTimestamp = value;
    },
    requeueRaw,
    restartDaemon,
    rejectNextRunMessageLookup,
    rejectNextFailRun,
    rejectFailRuns,
    rejectCompleteRuns,
    dispatchRequests,
    get failRunRequests() {
      return failRunRequests;
    },
    get completeRunRequests() {
      return completeRunRequests;
    },
    get completeFailureAtMs() {
      return completeFailureAtMs;
    },
    ...(claimStarted ? { claimStarted } : {}),
    ...(releaseClaim ? { releaseClaim } : {}),
    closeDispatch,
  };
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await createTestScratch("dohc-chat-dispatch-");
  const stateRoot = join(root, "state");
  const appRoot = join(root, "app");
  const workspace: ChatDispatchWorkspace = {
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    ...(options.workspaceAttachmentId
      ? { attachmentId: options.workspaceAttachmentId }
      : {}),
  };
  const now = { value: 1_000_000 };
  let nextSelfTestId = 0;
  const runner: RunnerSettings = {
    command: "claude -p",
    enabled: true,
    timeoutMinutes: 30,
    ...options.runner,
  };
  const { spawnRunner, spawnCalls, killCalls, killProcessGroup } = fakeRunner();
  const postedWorkspaces: string[] = [];
  const runUpdatedWorkspaces: string[] = [];
  const agentRequestGroups: Array<string | null> = [];
  const syncRequests: string[] = [];
  const syncWorkspaces: ChatDispatchWorkspace[] = [];
  const presence: ChatDispatchPresenceInput[] = [];
  const attributions: Fixture["attributions"] = [];
  const errors: unknown[] = [];
  const dispatchNotices: Fixture["dispatchNotices"] = [];
  const resumed: string[] = [];
  const notices: PostNoticeInput[] = [];
  const owedRunNoticesPath = join(stateRoot, "owed-run-notices.json");
  const owedRunNotices = createOwedRunNotices(() => owedRunNoticesPath);
  const requeues: Fixture["requeues"] = [];
  const runActivity = { acquires: 0, releases: 0 };
  const storeResolves = { chat: 0, dispatch: 0 };
  const dispatchDaemon = await fakeDispatchDaemon(workspace, now, options);
  let trustText: string | null = null;
  let changes: ChatDispatchService | null = null;
  const trust = createWorkspaceTrust({
    file: "workspace-trust.json",
    onChange: (workspaceId) => changes?.trustChanged(workspaceId),
    identify: async () => "1:1",
    readText: async () => {
      if (trustText === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return trustText;
    },
    writeText: async (_file, text) => { trustText = text; },
  });
  if (!options.restricted) await trust.trust(workspace);
  const {
    chat,
    dispatch,
    serviceDispatch,
    listRecoveriesRaw,
    readDispatch,
    setNextChatTimestamp,
    requeueRaw,
    restartDaemon,
    rejectNextRunMessageLookup,
    rejectNextFailRun,
    rejectFailRuns,
    rejectCompleteRuns,
    dispatchRequests,
    claimStarted,
    releaseClaim,
    closeDispatch,
  } = dispatchDaemon;

  const serviceOptions: ChatDispatchServiceOptions = {
    workspaceFor: (workspaceId) => (workspaceId === WORKSPACE_ID ? workspace : null),
    assertMayStartAgent: async (dispatchWorkspace) => {
      const check = await trust.assertTrusted(dispatchWorkspace);
      await options.afterTrustLookup?.(trust);
      return check;
    },
    listOpenWorkspaces: () => [],
    listSyncWorkspaces: () =>
      options.pumpWorkspaces ?? (options.pumpWorkspace ? [workspace] : []),
    chatStoreFor: () => {
      if (options.chatStoreClosed?.closed) throw new Error("This workspace is closed.");
      storeResolves.chat += 1;
      return chat;
    },
    startSelfTestThread: async (place, input) => (await chat.startChannelThread({
      workspaceId: place.workspaceId, ...input, ownThread: true,
      authorActorKey: null, author: { kind: "human", displayName: "Sam" }, origin: "cli",
    })).thread.id,
    dispatchStoreFor: () => {
      storeResolves.dispatch += 1;
      return serviceDispatch;
    },
    readDispatchAgents: async () => [
      {
        id: "default",
        ...testAgent({ name: options.agentName ?? "Nova", enabled: runner.enabled, timeoutMinutes: runner.timeoutMinutes }),
        launch: launchFrom(runner.profile, runner.command) ?? undefined,
      },
      ...(options.agents ?? []),
    ],
    agentToolVersion: async () => options.claudeVersion === undefined ? "2.1.317" : options.claudeVersion,
    stateDir: () => stateRoot,
    appRoot: () => appRoot,
    isPackaged: () => options.packaged ?? false,
    resourcesPath: () => join(appRoot, "resources"),
    queueSync: async (dispatchWorkspace) => {
      syncWorkspaces.push(dispatchWorkspace);
      syncRequests.push(dispatchWorkspace.workspaceId);
      return options.onQueueSync?.(dispatchWorkspace.workspaceId, chat);
    },
    ...(options.temporaryRunActivity || options.prepareRunWorkspaceFailures
      ? {
          prepareRunWorkspace: async () => {
            const failure = options.prepareRunWorkspaceFailures?.shift();
            if (failure) throw failure;
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
    onMessagePosted: (dispatchWorkspace) =>
      postedWorkspaces.push(dispatchWorkspace.workspaceId),
    onRunUpdated: (dispatchWorkspace) =>
      runUpdatedWorkspaces.push(dispatchWorkspace.workspaceId),
    onAgentRequestsChanged: (_dispatchWorkspace, channelId) =>
      agentRequestGroups.push(channelId),
    setRunAttribution: async (dispatchWorkspace, run) => {
      attributions.push({ workspaceId: dispatchWorkspace.workspaceId, run });
      await options.setRunAttribution?.(dispatchWorkspace.workspaceId, run);
    },
    publishPresence: async (input) => {
      presence.push(input);
    },
    ...(options.hasPendingRunMessageLink
      ? {
          hasPendingRunMessageLink: (dispatchWorkspace, runId) =>
            options.hasPendingRunMessageLink?.(
              dispatchWorkspace.workspaceId,
              runId,
            ) ?? false,
        }
      : {}),
    requeueFailedTrigger: (input) => {
      requeues.push(input);
      const error = options.requeueFailures?.shift();
      if (error) throw error;
      return requeueRaw(input);
    },
    listFailedRunRecoveries: (dispatchWorkspace, threadId) =>
      listRecoveriesRaw(dispatchWorkspace.workspaceId, threadId),
    spawnRunner,
    killProcessGroup,
    platform: options.platform ?? "linux",
    arch: options.arch,
    // Never this computer's own Codex config.
    codexConfigFiles: () => ({ requirements: [], config: [], managedPreferences: [] }),
    // Never this computer's own Codex either. Its check finds only dohc's server.
    runCodexCheck: async () => JSON.stringify([{ name: "dohc", enabled: true }]),
    nowMs: () => now.value,
    createId: () => `self_test_id_${(nextSelfTestId += 1)}`,
    onError: (error) => errors.push(error),
    onDispatchNotice: (workspace, notice) => {
      const error = options.dispatchNoticeFailures?.shift();
      if (error) throw error;
      dispatchNotices.push({ workspace, notice });
    },
    onThreadResumed: (_workspace, threadId) => resumed.push(threadId),
    runNotices: {
      // One notice per id, as the notice store keeps them.
      post: async (input) => {
        const failure = options.noticeFailures?.shift();
        if (failure) throw failure;
        if (!notices.some((notice) => notice.noticeId === input.noticeId)) notices.push(input);
      },
      syncing: () => options.syncPaused !== true,
      owed: {
        ...owedRunNotices,
        add: async (workspaceId, runId) => {
          const failure = options.owedAddFailures?.shift();
          if (failure) throw failure;
          await owedRunNotices.add(workspaceId, runId);
        },
      },
    },
  };
  const service = createChatDispatchService(serviceOptions);
  changes = service;

  const fixture: Fixture = {
    root,
    stateRoot,
    appRoot,
    workspace,
    chat,
    dispatch,
    service,
    serviceOptions,
    runner,
    spawnCalls,
    killCalls,
    postedWorkspaces,
    runUpdatedWorkspaces,
    agentRequestGroups,
    syncRequests,
    syncWorkspaces,
    presence,
    attributions,
    errors,
    dispatchNotices,
    resumed,
    notices,
    owedRunNoticesPath,
    owedRunNotices,
    requeues,
    runActivity,
    storeResolves,
    now,
    readDispatch,
    setNextChatTimestamp,
    requeueRaw,
    restartDaemon,
    rejectNextRunMessageLookup,
    rejectNextFailRun,
    rejectFailRuns,
    rejectCompleteRuns,
    dispatchRequests,
    get failRunRequests() {
      return dispatchDaemon.failRunRequests;
    },
    get completeRunRequests() {
      return dispatchDaemon.completeRunRequests;
    },
    get completeFailureAtMs() {
      return dispatchDaemon.completeFailureAtMs;
    },
    ...(claimStarted ? { claimStarted } : {}),
    ...(releaseClaim ? { releaseClaim } : {}),
    closeDispatch,
    trust,
  };
  fixtures.push(fixture);
  return fixture;
}

// The runs whose notice the service still owes.
async function owedRuns(fixture: Fixture): Promise<string[]> {
  return await fixture.owedRunNotices.list(WORKSPACE_ID);
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
  // An agent DM is one conversation, so each request here is its own post in
  // a group, naming the agent.
  await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
  const channel = await fixture.chat.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
  const actor = input.actor ?? "human";
  const started = await fixture.chat.startChannelThread({
    authorActorKey: null,
    workspaceId: WORKSPACE_ID,
    channelId: channel.id,
    title: input.title ?? input.body.split("\n")[0]!.slice(0, 80),
    author:
      actor === "human"
        ? { kind: "human", displayName: "Sam" }
        : { kind: "agent", displayName: "Sam" },
    ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(actor === "human" ? { wakeAgentIds: ["default"] } : {}),
    body: `@Nova ${input.body}`,
  });
  return { threadId: started.thread.id, messageId: started.message.id };
}

// The run's PATH is the fixture's CLI bin, so a failed run's words don't
// depend on whether the host has Node.js.

async function linkAgentReply(
  fixture: Fixture,
  threadId: string,
  runId: string,
  body = "Finished the work.",
): Promise<string> {
  const message = await fixture.chat.sendMessage({
    authorActorKey: null,
    workspaceId: WORKSPACE_ID,
    threadId,
    author: { kind: "agent", displayName: "Sam" },
    origin: "cli",
    body,
  });
  await fixture.dispatch.recordRunMessage({
    workspaceId: WORKSPACE_ID,
    messageId: message.id,
    runId,
  });
  return message.id;
}

// A person's message in an agent's chat, which requests that agent as it is written.
async function askAgain(fixture: Fixture, threadId: string): Promise<string> {
  const message = await fixture.chat.sendMessage({
    authorActorKey: null,
    workspaceId: WORKSPACE_ID,
    threadId,
    author: { kind: "human", displayName: "Sam" },
    authorUserId: "user_local",
    wakeAgentIds: ["default"],
    body: "@Nova Please go again.",
  });
  return message.id;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    for (const call of fixture.spawnCalls) call.process.markExitedSilently();
    await fixture.service.stop();
    await fixture.closeDispatch();
    await fixture.chat.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// As main's trust operations do: change the record, then tell dispatch.
async function trustWorkspace(fixture: Fixture): Promise<void> {
  await fixture.trust.trust(fixture.workspace);
}

describe("chatDispatchService", () => {

  it("runs each agent a message names in turn, with that agent's command and id", async () => {
    const fixture = await createFixture({
      agents: [
        { id: "codex", ...testAgent({ name: "Codex", launch: { command: "node codex.mjs" } }) },
        { id: "scout", ...testAgent({ name: "Scout", enabled: false }) },
      ],
    });
    const general = await fixture.chat.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const asked = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      wakeAgentIds: ["default", "codex", "scout"],
      body: "@Nova @Codex @Scout plan the trip.",
    });

    await activate(fixture);
    // Scout is off, so its request fails on its own. The others run one at a time.
    expect(fixture.dispatchNotices).toEqual([{ workspace: fixture.workspace, notice: {
      reason: "no-runner", threadId: asked.thread.id, message: "Scout's chat runner is off. Turn it on in Settings → Agents.",
    } }]);
    expect(fixture.spawnCalls).toHaveLength(1);
    const codexRun = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    expect(codexRun.run).toMatchObject({ agentId: "codex", command: "node codex.mjs" });
    expect(fixture.attributions.at(-1)?.run).toMatchObject({ agentId: "codex", agentRunId: codexRun.run.runId });
    // The message shows each agent's own request.
    const [askedMessage] = await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: asked.thread.id });
    expect(askedMessage?.agentRequests).toEqual([
      expect.objectContaining({ agentId: "codex", state: "running", runId: codexRun.run.runId }),
      { agentId: "default", state: "waiting" },
      expect.objectContaining({ agentId: "scout", state: "failed", failureReason: "no-runner" }),
    ]);

    await linkAgentReply(fixture, asked.thread.id, codexRun.run.runId);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(2));
    const novaRun = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    expect(novaRun.run).toMatchObject({ agentId: "default", command: fixture.runner.command });
    expect(await fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
  });

  it("keeps workspace FIFO and the spawn contract through the live dispatch adapter", async () => {
    // Pin command resolution to a no-op: with an empty host PATH the resolver
    // can never find a claude binary or .cmd shim on the machine running the
    // tests, so the spawn contract below (bare command, unwrapped args) is
    // asserted identically everywhere. The runner env still prepends the
    // fixture's CLI bin dir, which the PATH assertion below relies on.
    vi.stubEnv("PATH", "");
    vi.stubEnv("Path", "");
    const fixture = await createFixture({
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
    const firstClaim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    expect(firstClaim?.run.threadId).toBe(first.threadId);
    expect(firstClaim?.run.command).toBe(fixture.runner.command);
    expect((await fixture.dispatch.listPending(WORKSPACE_ID)).map((record) => record.threadId)).toEqual([
      second.threadId,
    ]);

    const firstSpawn = fixture.spawnCalls[0]!;
    expect(firstSpawn.command).toMatch(/(?:^|[\\/])claude(?:\.exe)?$/iu);
    // The prompt is not in argv — it rides stdin, so argv is exactly the
    // configured runner command. Asserting the full array (not a slice that
    // drops the last element) is what proves the prompt is absent from it.
    expect(firstSpawn.args).toEqual(["-p", "--allowedTools", "Bash(dohc chat:*)"]);
    const prompt = firstSpawn.process.stdinText;
    expect(prompt).toContain("# Launch review");
    expect(prompt).toContain("Audit the rollback plan.");
    expect(prompt).toContain(`dohc chat reply ${first.threadId} --as-agent "<report>"`);
    expect(prompt).toContain("Your final text is not shown anywhere");
    expect(firstSpawn.options).toMatchObject({
      cwd: fixture.root,
      detached: true,
      windowsHide: true,
    });
    // stdin is a pipe, not "ignore" — that is the channel the prompt arrives
    // on. An "ignore" here would mean the runner is spawned with no prompt at
    // all.
    expect(firstSpawn.options.stdio[0]).toBe("pipe");
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
    expect(await fixture.dispatch.getRunRecord(firstClaim.run.runId)).toMatchObject({
      exitCode: 0,
      failureHandled: false,
    });
    expect(fixture.runUpdatedWorkspaces).toContain(WORKSPACE_ID);
    const firstMessages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: first.threadId,
    });
    expect(firstMessages.some((message) => message.body.startsWith("⚠"))).toBe(false);
  });

  it("runs the agent a person asked at depth 0, and one an automation woke one deeper than its message", async () => {
    const fixture = await createFixture({ runner: { command: "", profile: { tool: "claude", executable: resolve("test-claude.exe") } } });
    const asked = await createAgentThread(fixture, { body: "Plan the trip.", authorUserId: "user_local" });
    await activate(fixture);
    const personRun = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    expect(personRun.chainDepth).toBe(0);
    // The run's slot and its process get the same secret.
    await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1));
    const personSecret = fixture.spawnCalls[0]!.options.env.DOHC_RUN_SECRET;
    expect(personSecret).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.attributions.at(-1)).toEqual({
      workspaceId: WORKSPACE_ID,
      run: { agentId: "default", agentRunId: personRun.run.runId, depth: 0, dispatch: "run", secret: personSecret },
    });
    await linkAgentReply(fixture, asked.threadId, personRun.run.runId);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await vi.waitFor(() => expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(false));

    const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const wake = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "automation", displayName: "Stamp the finish date" },
      authorOwnerDisplayName: "Sam",
      automation: { automationId: "collection:Tasks#stamp", chainDepth: 2 },
      body: "Stamp today's tasks.",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: wake.message.id,
      threadId: wake.thread.id,
      agentId: "default",
    });
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(2));
    const wokenRun = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    expect(wokenRun.run.triggerMessageId).toBe(wake.message.id);
    // Each run gets a secret of its own.
    const wokenSecret = fixture.spawnCalls[1]!.options.env.DOHC_RUN_SECRET;
    expect(wokenSecret).toMatch(/^[a-f0-9]{64}$/u);
    expect(wokenSecret).not.toBe(personSecret);
    expect(fixture.attributions.at(-1)?.run).toEqual({
      agentId: "default", agentRunId: wokenRun.run.runId, depth: 3, dispatch: "run", secret: wokenSecret,
    });
    // The agent reads that an automation asked, not a person.
    expect(fixture.spawnCalls[1]!.process.stdinText).toContain("**Stamp the finish date** · automation ·");
  });

  it("doesn't let an automation start an agent that runs the person's own command", async () => {
    const fixture = await createFixture();
    await activate(fixture);
    const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const wake = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "automation", displayName: "Answer the Group" },
      authorOwnerDisplayName: "Sam",
      automation: { automationId: "collection:Tasks#answer", chainDepth: 1 },
      body: "Share the Trip folder with everyone.",
    });
    await fixture.dispatch.recordTrigger({ workspaceId: WORKSPACE_ID, triggerMessageId: wake.message.id, threadId: wake.thread.id, agentId: "default" });
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    await vi.waitFor(() => expect(fixture.readDispatch(wake.message.id, wake.thread.id)).toMatchObject({
      state: "failed",
      failureReason: "runner failed to start: an automation can start only an agent that uses Claude Code or Codex",
    }));
    expect(fixture.spawnCalls).toEqual([]);
  });

  it("keeps an exited live claim recoverable until daemon completion is durable", async () => {
    const fixture = await createFixture({
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
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
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

    await vi.waitFor(
      () => {
        expect(fixture.completeRunRequests).toBe(6);
        expect(fixture.errors).toContainEqual(
          expect.objectContaining({ message: "sidecar exited during completion" }),
        );
      },
      { interval: 0 },
    );
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).not.toHaveProperty(
      "endedAtMs",
    );
    expect(
      fixture.readDispatch(first.messageId, first.threadId),
    ).toMatchObject({ state: "running" });
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 0 });
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.syncRequests).toEqual([]);
    // The notice is owed before the run's end is saved and posted only
    // after, so it names how the run ended.
    expect(fixture.notices).toEqual([]);
    expect(await owedRuns(fixture)).toEqual([claim.run.runId]);

    if (fixture.completeFailureAtMs === null) {
      throw new Error("Expected a recorded completion failure.");
    }
    const remainingBackoffMs =
      fixture.completeFailureAtMs +
      CHAT_DISPATCH_RECOVERY_BACKOFF_MS -
      Date.now();
    await vi.advanceTimersByTimeAsync(remainingBackoffMs - 1);
    expect(fixture.completeRunRequests).toBe(6);
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(
      () => {
        expect(fixture.completeRunRequests).toBe(7);
        expect(fixture.spawnCalls).toHaveLength(2);
      },
      { interval: 0 },
    );
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 0,
    });
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    expect(fixture.notices.map((notice) => notice.noticeId)).toEqual([
      `agent-run:${WORKSPACE_ID}:${claim.run.runId}`,
    ]);
    expect(await owedRuns(fixture)).toEqual([]);
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(
      second.threadId,
    );
    expect(fixture.syncRequests).toEqual([]);
  });

  it("keeps a pre-run claim and lease until failure persistence is durable", async () => {
    const fixture = await createFixture({
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
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected the pre-run claim to remain open.");

    expect(fixture.failRunRequests).toBe(6);
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 0 });
    expect(fixture.spawnCalls).toEqual([]);
    expect(
      fixture.readDispatch(first.messageId, first.threadId),
    ).toMatchObject({ state: "running" });

    fixture.runner.command = "claude -p";
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);

    await vi.waitFor(
      () => {
        expect(fixture.failRunRequests).toBe(7);
        expect(fixture.spawnCalls).toHaveLength(1);
      },
      { interval: 0 },
    );
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      failureReason: expect.stringContaining("runner failed to start"),
    });
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Nova didn't reply in \"Fail during runner setup while the daemon is unavailable.\"",
    ]);
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(
      second.threadId,
    );
  });

  it("coalesces pending triggers in one thread and dispatches a later message as a follow-up", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "First request.",
      authorUserId: "user_local",
    });
    for (const body of ["@Nova Second request.", "@Nova Third request."]) {
      await fixture.chat.sendMessage({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        threadId: trigger.threadId,
        author: { kind: "human", displayName: "Sam" },
        authorUserId: "user_local",
        wakeAgentIds: ["default"],
        body,
      });
    }

    await activate(fixture);

    expect(fixture.spawnCalls).toHaveLength(1);
    const dispatchedMessages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      dispatchedMessages.map(
        (message) =>
          fixture.readDispatch(message.id, trigger.threadId).state,
      ),
    ).toEqual(["running", "done", "done"]);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toEqual({
      liveRunId: expect.any(String), liveTriggerMessageId: expect.any(String),
      pendingCount: 0,
      paused: false,
    });

    const followUp = await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      wakeAgentIds: ["default"],
      body: "@Nova Arrived after spawn.",
    });
    // The request is written with the message, so the thread's next read,
    // which a new message prompts, shows it waiting for Nova's run to end.
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toMatchObject({
      liveRunId: expect.any(String), liveTriggerMessageId: expect.any(String),
      pendingCount: 1,
      waiting: { agentId: "default", name: "Nova", triggerMessageIds: [followUp.id] },
    });
    // An agent's chat with only earlier posts reads them with no conversation.
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, null, [trigger.threadId])).toEqual({
      liveRunId: null, liveTriggerMessageId: null,
      pendingCount: 0,
      paused: false,
      waiting: { agentId: "default", name: "Nova", triggerMessageIds: [followUp.id] },
    });

    const firstClaim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!firstClaim) throw new Error("Expected the coalesced run.");
    await linkAgentReply(fixture, trigger.threadId, firstClaim.run.runId);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(trigger.threadId);
  });

  // The dispatch prompt always contains a double quote (the
  // `--as-agent "<report>"` contract) and carries the whole rendered thread.
  // While it rode argv, a .cmd/.bat runner -- the npm -g layout on Windows --
  // had to go through cmd.exe, where quoteForCmd refuses a double quote
  // outright and the command line hard-fails past ~8191 characters. Dispatch
  // was impossible for those users; a native claude.exe earlier in PATHEXT
  // order was the only thing masking it.

  it("does not scan a replacement attachment after deferred pump sync", async () => {
    vi.useFakeTimers();
    const originalAttachmentId = Symbol("original attachment");
    const replacementAttachmentId = Symbol("replacement attachment");
    const syncStarted = Promise.withResolvers<void>();
    const allowSync = Promise.withResolvers<void>();
    let syncCalls = 0;
    const fixture = await createFixture({
      workspaceAttachmentId: replacementAttachmentId,
      pumpWorkspaces: [
        {
          workspaceId: WORKSPACE_ID,
          rootPath: "/unused/original-workspace",
          attachmentId: originalAttachmentId,
        },
      ],
      onQueueSync: async () => {
        syncCalls += 1;
        if (syncCalls > 1) return false;
        syncStarted.resolve();
        await allowSync.promise;
      },
    });

    fixture.service.start();
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_PUMP_MS);
    await syncStarted.promise;
    allowSync.resolve();
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_PUMP_MS);
    await vi.waitFor(
      () => {
        expect(fixture.syncRequests).toHaveLength(2);
      },
      { interval: 0 },
    );

    expect(fixture.syncWorkspaces[0]?.attachmentId).toBe(originalAttachmentId);
    expect(fixture.storeResolves).toEqual({ chat: 0, dispatch: 0 });
  });

  it("re-resolves an ambiguously committed claim even when pending is empty", async () => {
    const fixture = await createFixture({ ambiguousClaimOnce: true });
    const trigger = await createAgentThread(fixture, {
      body: "Recover this lost claim response.",
      authorUserId: "user_local",
    });

    fixture.service.start();
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toMatchObject({ code: "transport-error" });
    expect(await fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
    expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toHaveLength(1);
    expect(fixture.spawnCalls).toEqual([]);

    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(
      trigger.threadId,
    );
  });

  it.each([true])("keeps the budget pause without a chat message when notice reporting fails: %s", async (noticeFails) => {
    const noticeError = new Error("Notice delivery failed");
    const fixture = await createFixture({ dispatchNoticeFailures: noticeFails ? [noticeError] : [] });
    const pending = await createAgentThread(fixture, {
      body: "This next run should pause once the budget is spent today.",
      authorUserId: "user_local",
    });
    for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
      const triggerMessageId = `seed_message_${index}`;
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: pending.threadId,
        agentId: "default",
      });
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
        agentId: "default",
        command: "seed-runner",
      });
      if (!claim) throw new Error("Expected a seeded budget claim.");
      await fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
    }
    // The person asks after the seeded runs, so no seed's claim takes the request.
    await askAgain(fixture, pending.threadId);

    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(0);
    expect(await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId)).toBe(true);
    const pauseRow = await fixture.dispatch.getThreadDispatchPauseState(
      WORKSPACE_ID,
      pending.threadId,
    );
    expect(pauseRow?.reason).toBe("re-dispatch budget exceeded");
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, pending.threadId)).toEqual({
      liveRunId: null, liveTriggerMessageId: null,
      pendingCount: 1,
      paused: true,
    });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: pending.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual(noticeFails ? [] : [{ workspace: fixture.workspace, notice: {
      reason: "budget-paused", threadId: pending.threadId,
      channelId: (await fixture.chat.getThread({ workspaceId: WORKSPACE_ID, threadId: pending.threadId })).thread.channelId,
      message: 'Agents ran 10 times in 10 minutes in "This next run should pause once the bud…". Choose Resume there to continue.',
    } }]);
    expect(fixture.errors).toEqual(noticeFails ? [noticeError] : []);
    expect(fixture.postedWorkspaces).toEqual([]);

    await fixture.service.resumeThreadDispatch(WORKSPACE_ID, pending.threadId);
    expect(await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId)).toBe(false);
    // Main takes back this thread's pause notice.
    expect(fixture.resumed).toEqual([pending.threadId]);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, pending.threadId)).toMatchObject({
      liveRunId: expect.any(String), liveTriggerMessageId: expect.any(String),
      pendingCount: 0,
      paused: false,
    });
  });

  describe("in an agent DM", () => {
    // Finishes `count` runs in the DM's conversation, each started by a new
    // message from `author`, and returns the conversation.
    async function finishDmRuns(fixture: Fixture, author: "person" | "agent", count: number): Promise<string> {
      const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
      let threadId = "";
      for (let index = 0; index < count; index += 1) {
        const started = await fixture.chat.startChannelThread({
          authorActorKey: null,
          workspaceId: WORKSPACE_ID,
          channelId: channel.id,
          ...(author === "person"
            ? { author: { kind: "human", displayName: "Sam" }, authorUserId: "user_local" }
            : { author: { kind: "agent", displayName: "Nova" }, origin: "cli" }),
          body: `Message ${index}`,
        });
        threadId = started.thread.id;
        await fixture.dispatch.recordTrigger({ workspaceId: WORKSPACE_ID, triggerMessageId: started.message.id, threadId, agentId: "default" });
        const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { agentId: "default", command: "seed-runner" });
        if (!claim) throw new Error("Expected a seeded claim.");
        await fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
      }
      return threadId;
    }

    async function askAgain(fixture: Fixture): Promise<void> {
      const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
      await fixture.chat.startChannelThread({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        channelId: channel.id,
        author: { kind: "human", displayName: "Sam" },
        authorUserId: "user_local",
        wakeAgentIds: ["default"],
        body: "One more thing.",
      });
      await activate(fixture);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
    }

    it("runs the person's 11th quick message", async () => {
      const fixture = await createFixture();
      const conversation = await finishDmRuns(fixture, "person", CHAT_DISPATCH_BUDGET_MAX);

      await askAgain(fixture);

      expect(fixture.spawnCalls).toHaveLength(1);
      expect(await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, conversation)).toBe(false);
      expect(fixture.dispatchNotices).toEqual([]);
    });

    it("still pauses a loop of runs the agent started, naming the agent", async () => {
      const fixture = await createFixture();
      const conversation = await finishDmRuns(fixture, "agent", CHAT_DISPATCH_BUDGET_MAX);

      await askAgain(fixture);

      expect(fixture.spawnCalls).toHaveLength(0);
      expect(await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, conversation)).toBe(true);
      expect(fixture.dispatchNotices).toEqual([{ workspace: fixture.workspace, notice: {
        reason: "budget-paused", threadId: conversation,
        channelId: (await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" })).id,
        message: 'Agents ran 10 times in 10 minutes in "Nova". Choose Resume there to continue.',
      } }]);
    });

  });

  it("restores a Resume budget bypass when the claim RPC rejects", async () => {
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
      origin: "cli",
    });
    for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
      const triggerMessageId = `resume_seed_${index}`;
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId,
        threadId: pending.threadId,
        agentId: "default",
      });
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { agentId: "default" });
      if (!claim) throw new Error("Expected a seeded budget claim.");
      await fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
    }
    // The person asks after the seeded runs, so no seed's claim takes the request.
    await askAgain(fixture, pending.threadId);
    await fixture.dispatch.setThreadDispatchPaused({
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
      await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId),
    ).toBe(false);
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("mutation proof: retains a finalized run until attribution teardown succeeds", async () => {
    let clearAttempts = 0;
    const teardownError = new Error("capture author clear failed");
    const fixture = await createFixture({
      setRunAttribution: (_workspaceId, run) => {
        if (run === null && clearAttempts++ === 0) throw teardownError;
      },
    });
    await createAgentThread(fixture, {
      body: "Finish only after capture ownership clears.",
      authorUserId: "user_local",
    });
    await activate(fixture);

    fixture.spawnCalls[0]!.process.emitExit(0);
    await vi.waitFor(() => {
      expect(fixture.errors).toContain(teardownError);
    });

    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);

    // A recovery scan retries only the retained finalized run's teardown path;
    // no second runner is spawned.
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(false);
    expect(fixture.spawnCalls).toHaveLength(1);
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
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");

    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.some((message) => message.body.includes("produced no reply")),
    ).toBe(false);
    expect(fixture.notices).toEqual([]);

    expect((await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).failedRun).toBeUndefined();
    await expect(fixture.service.retryStoppedRun(WORKSPACE_ID, trigger.threadId, claim.run.runId)).resolves.toBe(false);

    linkPending = false;
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    // The backoff timer queued a recovery scan. Work on the workspace's
    // queue runs in order, so this empty step ends after that scan.
    await fixture.service.betweenScans(WORKSPACE_ID, async () => {});
    expect(fixture.dispatchNotices).toEqual([]);
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Nova didn't reply in \"Wait for my CLI reply provenance.\"",
    ]);
    expect(await owedRuns(fixture)).toEqual([]);
  });

  it("posts the notice owed for a run whose end was saved before dohc stopped", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      title: "Plan day 2",
      body: "Crash after this run's end is saved.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const ended = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      agentId: "default",
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!ended) throw new Error("Expected a run.");
    await linkAgentReply(fixture, trigger.threadId, ended.run.runId);
    await createOwedRunNotices(() => fixture.owedRunNoticesPath).add(WORKSPACE_ID, ended.run.runId);
    await fixture.dispatch.completeRun({ runId: ended.run.runId, exitCode: 0 });

    await activate(fixture);

    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Nova replied in \"Plan day 2\"",
    ]);
    expect(await owedRuns(fixture)).toEqual([]);
  });

  it("saves a run's end only once its notice is owed", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({ owedAddFailures: [new Error("owed file unavailable")] });
    const trigger = await createAgentThread(fixture, {
      title: "Plan day 2",
      body: "Finish while the owed file fails once.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);

    fixture.spawnCalls[0]!.process.emitExit(0);
    await vi.waitFor(() => {
      expect(fixture.errors).toContainEqual(expect.objectContaining({ message: "owed file unavailable" }));
    }, { interval: 0 });
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).not.toHaveProperty("endedAtMs");
    expect(fixture.notices).toEqual([]);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await vi.waitFor(async () => {
      expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({ exitCode: 0 });
      expect(fixture.notices.map((notice) => notice.title)).toEqual([
        "Nova replied in \"Plan day 2\"",
      ]);
      expect(await owedRuns(fixture)).toEqual([]);
    }, { interval: 0 });
  });

  it("fails an interrupted startup run without running its request again", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Resume this after restart.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      agentId: "default",
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");
    // Quiet for 40 days before dohc stopped; cleanup counts from the recorded end.
    const log = join(fixture.stateRoot, "run-logs", `${interrupted.run.runId}.log`);
    await mkdir(dirname(log), { recursive: true });
    await writeFile(log, "started");
    const restarted = Date.UTC(2026, 10, 11);
    const lastWrite = new Date(restarted - 40 * 24 * 60 * 60 * 1000);
    await utimes(log, lastWrite, lastWrite);
    fixture.now.value = restarted;

    await activate(fixture);

    expect(await readFile(`${log}.ended`, "utf8")).toBe(`${restarted}
`);
    expect(await fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureHandled: true,
      failureReason: "app restart during run",
    });
    expect(fixture.requeues).toEqual([]);
    expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]);
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.notices).toEqual([expect.objectContaining({
      noticeId: `agent-run:${WORKSPACE_ID}:${interrupted.run.runId}`,
      title: "Nova didn't reply in \"Resume this after restart.\"",
    })]);
  });

  it("keeps an interrupted run's old log through startup and daily cleanup when recovery fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, { body: "Keep my log.", authorUserId: "user_local" });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID, triggerMessageId: trigger.messageId, threadId: trigger.threadId, agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      agentId: "default", command: "claude -p", logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");
    const logs = join(fixture.stateRoot, "run-logs");
    const log = join(logs, `${interrupted.run.runId}.log`);
    await mkdir(logs, { recursive: true });
    const restarted = Date.UTC(2026, 10, 11);
    const lastWrite = new Date(restarted - 400 * 24 * 60 * 60 * 1000);
    await writeFile(log, "started");
    await utimes(log, lastWrite, lastWrite);
    // Runs that did end show each cleanup has run: one ended past the limit
    // at startup, the other only by the next day's cleanup.
    const day = 24 * 60 * 60 * 1000;
    for (const [runId, endedDaysAgo] of [["run-done", 31], ["run-done-later", 29.5]] as const) {
      await writeFile(join(logs, `${runId}.log`), "output");
      await markRunLogEnded(join(logs, `${runId}.log`), restarted - endedDaysAgo * day);
    }
    fixture.now.value = restarted;
    const dispatch = fixture.serviceOptions.dispatchStoreFor(fixture.workspace);
    vi.spyOn(dispatch, "openRuns").mockRejectedValue(new Error("engine unavailable"));
    const service = createChatDispatchService({
      ...fixture.serviceOptions,
      listOpenWorkspaces: () => [fixture.workspace],
      readRunLogKeepDays: async () => 30,
    });
    service.start();
    try {
      await vi.waitFor(async () => expect((await readdir(logs)).sort()).toEqual([
        "run-done-later.log", "run-done-later.log.ended", `${interrupted.run.runId}.log`,
      ]));
      fixture.now.value = restarted + RUN_LOG_SWEEP_MS;
      await vi.advanceTimersByTimeAsync(RUN_LOG_SWEEP_MS);
      await vi.waitFor(async () => expect(await readdir(logs)).toEqual([`${interrupted.run.runId}.log`]));
      expect((await fixture.dispatch.getRunRecord(interrupted.run.runId))?.endedAtMs).toBeUndefined();
    } finally {
      await service.stop();
    }
  });

  describe("Try again on a failed run", () => {
    // A run of the conversation's request that dohc stopped before the
    // next startup.
    async function stoppedRun(fixture: Fixture, ending: "restarted" | "quit", body = "Plan day 2.") {
      const trigger = await createAgentThread(fixture, { body, authorUserId: "user_local" });
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID, triggerMessageId: trigger.messageId, threadId: trigger.threadId,
        agentId: "default",
      });
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { agentId: "default", command: "claude -p" });
      if (!claim) throw new Error("Expected a run.");
      if (ending === "quit") {
        await fixture.dispatch.failRun({ runId: claim.run.runId, exitCode: APP_QUIT_EXIT_CODE, reason: "app-quit" });
      }
      return { ...trigger, runId: claim.run.runId };
    }
    const stateOf = async (fixture: Fixture, threadId: string) =>
      (await fixture.service.dispatchStateForThread(WORKSPACE_ID, threadId)).failedRun;
    const wordsFor = (ending: "restarted" | "quit") =>
      `Nova didn't reply. dohc ${ending} during its run.`;

    it.each(["quit"] as const)("runs the request of a run stopped when dohc %s once more", async (ending) => {
      const fixture = await createFixture();
      const run = await stoppedRun(fixture, ending);
      await activate(fixture);
      expect(fixture.spawnCalls).toEqual([]);
      expect(await stateOf(fixture, run.threadId)).toEqual({
        runId: run.runId, triggerMessageId: run.messageId, words: wordsFor(ending), retryable: true,
      });

      await expect(fixture.service.retryStoppedRun(WORKSPACE_ID, run.threadId, run.runId)).resolves.toBe(true);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(run.threadId);
      expect(await stateOf(fixture, run.threadId)).toBeUndefined();
      // A second press finds nothing to run again.
      await expect(fixture.service.retryStoppedRun(WORKSPACE_ID, run.threadId, run.runId)).resolves.toBe(false);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.requeues).toEqual([expect.objectContaining({
        triggerMessageId: run.messageId, agentId: "default", runId: run.runId,
      })]);
    });

    it("gives the next step instead of the button once the request has had its second attempt", async () => {
      const fixture = await createFixture({ restricted: true });
      const run = await stoppedRun(fixture, "restarted");
      await activate(fixture);
      await expect(fixture.service.retryStoppedRun(WORKSPACE_ID, run.threadId, run.runId)).resolves.toBe(true);
      const second = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { agentId: "default", command: "claude -p" });
      if (!second) throw new Error("Expected the second attempt.");
      await fixture.dispatch.failRun({ runId: second.run.runId, exitCode: APP_QUIT_EXIT_CODE, reason: "app-quit" });

      expect(await stateOf(fixture, run.threadId)).toEqual({
        runId: second.run.runId, triggerMessageId: run.messageId,
        words: wordsFor("quit"), nextStep: { kind: "message", agentId: "default", name: "Nova", handle: "Nova" }, retryable: false,
      });
      await expect(fixture.service.retryStoppedRun(WORKSPACE_ID, run.threadId, second.run.runId)).resolves.toBe(false);
      expect(fixture.requeues).toHaveLength(1);
    });

  });

  // The step carries the agent's id, so its own chat can say to message it,
  // and the @handle the composer inserts, which drops spaces and
  // punctuation. A name with no handle carries none: elsewhere the line and
  // notice say to message it in its own chat.

  // An agent the @ menu can't offer can't be mentioned, so the line gives
  // the step in Settings. A removed agent's name is gone with it, so the row
  // calls it your agent. An agent you run reads a mention once it connects.

  // While Try again can run the request, the line shows no step. A run that
  // needs Node.js says what to do in its words.

  it("flushes a live run for next-boot recovery without posting during quit", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Quit while this is running.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");

    const stopping = fixture.service.stop();

    expect(fixture.killCalls).toContainEqual({
      pid: -fixture.spawnCalls[0]!.process.pid!,
      signal: "SIGTERM",
    });
    await vi.advanceTimersByTimeAsync(APP_QUIT_KILL_GRACE_MS - 1);
    expect(fixture.killCalls.some((call) => call.signal === "SIGKILL")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: APP_QUIT_EXIT_CODE,
      failureHandled: false,
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
    expect(fixture.notices).toEqual([]);
  });

  it("skips a scan queued before stop without looking up the workspace", async () => {
    const fixture = await createFixture();
    const scanning = deferred();
    const held = deferred();
    let authorityClosing = false;
    const workspaceFor = vi.fn((workspaceId: string) => {
      if (authorityClosing) throw new Error("Workspace authority owner is closing.");
      return fixture.serviceOptions.workspaceFor(workspaceId);
    });
    const service = createChatDispatchService({
      ...fixture.serviceOptions,
      workspaceFor,
      readDispatchAgents: async () => {
        scanning.resolve();
        await held.promise;
        return await fixture.serviceOptions.readDispatchAgents();
      },
    });
    service.start();
    const running = service.scanWorkspace(WORKSPACE_ID);
    await scanning.promise;
    const queued = service.scanWorkspace(WORKSPACE_ID);
    const stopping = service.stop();
    // From here a workspace lookup would ask authority that quit is closing.
    authorityClosing = true;
    held.resolve();

    await Promise.all([running, queued, stopping]);
    expect(workspaceFor).toHaveBeenCalledOnce();
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  // The pump, a relay change, or any other write can start a scan while a
  // person answers a poll. The agent woken by the answer must not read its
  // poll as still open.
  it("builds an answer's prompt with its poll resolved when a scan was due mid-answer", async () => {
    const fixture = await createFixture();
    const scanning = deferred();
    const held = deferred();
    let holdNextScan = true;
    const service = createChatDispatchService({
      ...fixture.serviceOptions,
      readDispatchAgents: async () => {
        if (holdNextScan) {
          holdNextScan = false;
          scanning.resolve();
          await held.promise;
        }
        return await fixture.serviceOptions.readDispatchAgents();
      },
    });
    service.start();
    try {
      const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
      const poll = await fixture.chat.startChannelThread({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        channelId: channel.id,
        author: { kind: "agent", displayName: "Nova" },
        origin: "cli",
        body: "Ship on which day?",
        options: ["Friday", "Monday"],
      });
      const competingScan = service.scanWorkspace(WORKSPACE_ID);
      await scanning.promise;

      // The answer goes as far as it can while that scan is held: it writes
      // its reply, or waits for the scan to finish. Its resolution waits for
      // the scan either way, so a scan between the two writes would build its
      // prompt first.
      const replyLanded = deferred();
      const answerQueued = deferred();
      const store: ChatWriteStore = {
        ...fixture.chat,
        sendMessage: async (input) => {
          const message = await fixture.chat.sendMessage(input);
          replyLanded.resolve();
          return message;
        },
        resolveChatDecision: async (input) => {
          await competingScan;
          return await fixture.chat.resolveChatDecision(input);
        },
      };
      const writes = createChatWrites({
        findWorkspace: () => ({}),
        warmCredentials: async () => undefined,
        currentCredentials: () => null,
        currentCredentialGeneration: () => 0,
        localUserDisplayName: () => "Sam",
        agentDisplayName: async () => "Nova",
        agentIdsToWake: async (_body, dmAgentId) => dmAgentId === null ? [] : [dmAgentId],
        localInstallationId: () => "install-local",
        projectChatBookmarks: () => undefined,
        queueCloudSync: () => undefined,
        syncSharedChannelsForChatTarget: async () => undefined,
        scanChatDispatch: (workspaceId) => service.scanWorkspace(workspaceId),
        betweenDispatchScans: (workspaceId, write) => {
          answerQueued.resolve();
          return service.betweenScans(workspaceId, write);
        },
        notifyRenderer: () => undefined,
      });
      const answering = answerDecision(writes.host({ workspaceId: WORKSPACE_ID, store }, { writer: { via: "renderer" } }), {
        threadId: poll.thread.id,
        body: "Monday",
        resolves: { messageId: poll.message.id, chosenOption: "Monday" },
      });
      await Promise.race([replyLanded.promise, answerQueued.promise]);
      held.resolve();

      expect(await answering).toMatchObject({ decision: { state: "resolved", chosenOption: "Monday" } });
      await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1));
      const prompt = fixture.spawnCalls[0]!.process.stdinText ?? "";
      expect(prompt).toContain("- [x] Monday");
      expect(prompt).toContain("needs-decision(resolved)");
      expect(prompt).not.toContain("needs-decision(open)");
    } finally {
      for (const call of fixture.spawnCalls) call.process.markExitedSilently();
      held.resolve();
      await service.stop();
    }
  });

  it("keeps a trigger recorded after stop for the next start, which runs it once", async () => {
    const fixture = await createFixture();
    await activate(fixture);
    await fixture.service.stop();
    // An agent's own message requests no agent as it is written, so only the
    // explicit record can, as an automation wake's record does.
    const wake = await createAgentThread(fixture, { body: "Woken as dohc quits.", actor: "agent" });
    const trigger = { workspaceId: WORKSPACE_ID, triggerMessageId: wake.messageId, threadId: wake.threadId, agentId: "default" };
    await fixture.dispatch.recordTrigger(trigger);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.spawnCalls).toEqual([]);
    expect((await fixture.dispatch.listPending(WORKSPACE_ID)).map((pending) => pending.triggerMessageId))
      .toEqual([wake.messageId]);

    const restarted = createChatDispatchService(fixture.serviceOptions);
    restarted.start();
    try {
      await restarted.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect((await fixture.dispatch.openRuns(WORKSPACE_ID)).map((open) => open.run.triggerMessageId))
        .toEqual([wake.messageId]);
      // Recording the same wake again neither queues it again nor starts another run.
      await fixture.dispatch.recordTrigger(trigger);
      expect(await fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
      await restarted.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
    } finally {
      for (const call of fixture.spawnCalls) call.process.markExitedSilently();
      await restarted.stop();
    }
  });

  it("times out a run, posts the timeout notice, and escalates its process group", async () => {
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
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");

    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
    expect(fixture.killCalls).toEqual([
      { pid: -fixture.spawnCalls[0]!.process.pid!, signal: "SIGTERM" },
    ]);
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 124,
      failureHandled: true,
    });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Nova didn't reply in \"This harness will hang.\"",
    ]);

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

  it("does not let a queued stop for an exited run stop its successor", async () => {
    const fixture = await createFixture();
    const first = await createAgentThread(fixture, {
      body: "Finish this run before the stop is handled.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const firstClaim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!firstClaim) throw new Error("Expected the first live run.");
    await linkAgentReply(fixture, first.threadId, firstClaim.run.runId);

    const successor = await createAgentThread(fixture, {
      body: "Run after the first child exits.",
      authorUserId: "user_local",
    });
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.spawnCalls).toHaveLength(1);

    fixture.spawnCalls[0]!.process.emitExit(0);
    await expect(
      fixture.service.stopAgentRun(WORKSPACE_ID, firstClaim.run.runId),
    ).resolves.toBe(false);

    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(
      successor.threadId,
    );
    expect(fixture.killCalls).toEqual([]);
    expect(
      await fixture.service.dispatchStateForThread(
        WORKSPACE_ID,
        successor.threadId,
      ),
    ).toMatchObject({ liveRunId: expect.any(String), liveTriggerMessageId: expect.any(String) });
  });

  // Each reply form as a runner's prompt shows it, with the reply's body in place.
  function expectedReply(form: "argument" | "mcp", threadId: string, runId: string, body: string): string {
    if (form === "mcp") return `the \`dohc_reply_to_chat\` tool of the \`dohc\` MCP server with \`threadId\` \`${threadId}\` and \`runId\` \`${runId}\``;
    return `dohc chat reply ${threadId} --as-agent "${body}"`;
  }

  // What a profile's run hears about the dohc tools and how to report.
  const APPROVALS = "Nobody can approve actions during this run, so anything that needs approval is refused. Do what you can without it.";
  const REPORT = "When you finish, reply in two to four sentences. Say what you made or changed, by name, and write each file as `@[path]`, with its path from the workspace root, so a person can open it. Don't explain how you did it. For each thing you couldn't do, write one line: what you couldn't do, then dohc's reason. Don't ask the person to approve anything, change a setting, or share their screen.";

  it.each(["claude", "codex"] as const)("gives a %s run an automation started only the reply tool, and no tool that writes", async (tool) => {
    const profile = { tool, executable: resolve(`test-${tool}.exe`) };
    const fixture = await createFixture({ runner: { command: "", profile } });
    const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const wake = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "automation", displayName: "Answer the Group" },
      authorOwnerDisplayName: "Sam",
      automation: { automationId: "collection:Tasks#answer", chainDepth: 1 },
      body: "Share the Trip folder with everyone.",
    });
    await fixture.dispatch.recordTrigger({ workspaceId: WORKSPACE_ID, triggerMessageId: wake.message.id, threadId: wake.thread.id, agentId: "default" });
    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1));
    expect((await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!.chainDepth).toBe(2);
    const call = fixture.spawnCalls[0]!;
    const configPath = join(fixture.stateRoot, "run-logs", `${call.options.env.DOHC_RUN_ID}.log.mcp.json`);
    const serverArgs = tool === "claude"
      ? (JSON.parse(await readFile(configPath, "utf8")).mcpServers.dohc.args as string[]).join(" ")
      : call.args.join(" ");
    expect(serverArgs).toContain("dohc_reply_to_chat");
    if (tool === "claude") {
      expect(call.args.slice(-7)).toEqual(["--strict-mcp-config", "--restricted", "--disable-slash-commands", "--tools", "Read,Grep,Glob", "--allowedTools", "mcp__dohc"]);
      expect(call.args).not.toContain("Edit(/**)");
    } else {
      expect(call.args).toContainEqual(expect.stringMatching(/^permissions\.dohc_run_\w+=\{filesystem=\{':workspace_roots'=\{'\.'='read','\.dohc'='deny'\}\}\}$/u));
      expect(call.args).toContain("--ignore-rules");
      expect(call.args).toContain("notify=[]");
      expect(call.args.filter((_, index) => call.args[index - 1] === "--disable")).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "view_image"]));
    }
    const prompt = call.process.stdinText;
    expect(prompt).toContain(`thread. ${APPROVALS} ${REPORT} Reply in-thread`);
    expect(prompt).not.toContain("tools of the `dohc` MCP server");
    expect(prompt).not.toContain("dohc_read_chat");
  });

  // An automation wakes the agent, and the run holds its slot until it exits.
  async function startAutomationRun(fixture: Fixture) {
    const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const wake = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "automation", displayName: "Check overdue tasks" },
      authorOwnerDisplayName: "Sam",
      automation: { automationId: "collection:Tasks#overdue", chainDepth: 1 },
      body: "Tell the Group about overdue tasks.",
    });
    await fixture.dispatch.recordTrigger({ workspaceId: WORKSPACE_ID, triggerMessageId: wake.message.id, threadId: wake.thread.id, agentId: "default" });
    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1));
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    return { threadId: wake.thread.id, runId: claim.run.runId, process: fixture.spawnCalls[0]!.process };
  }

  const quietProfile = { tool: "claude" as const, executable: resolve("test-claude.exe") };

  it.each([true])("ends an automation's run with nothing to report as finished, after a restart too, when the reply read fails: %s", async (readFails) => {
    const fixture = await createFixture({ runner: { command: "", profile: quietProfile } });
    const { threadId, runId, process } = await startAutomationRun(fixture);

    expect(fixture.service.endRunQuietly(WORKSPACE_ID, runId, threadId)).toBeNull();
    if (readFails) {
      // A failed read holds the run's end, unsaved, until a recovery scan
      // reads again.
      vi.useFakeTimers();
      const lookupError = new Error("daemon restarted during listRunMessages");
      fixture.rejectNextRunMessageLookup!(lookupError);
      process.emitExit(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.errors).toContain(lookupError);
      expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(true);
      expect((await fixture.dispatch.getRunRecord(runId))?.endedAtMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
      vi.useRealTimers();
    } else {
      process.emitExit(0);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
    }
    await vi.waitFor(() => expect(fixture.service.hasLiveRun(WORKSPACE_ID)).toBe(false));

    expect(await fixture.dispatch.getRunRecord(runId)).toMatchObject({ exitCode: 0, failureHandled: false });
    expect(fixture.notices).toEqual([]);
    expect(await fixture.owedRunNotices.list(WORKSPACE_ID)).toEqual([]);
    expect((await fixture.service.dispatchStateForThread(WORKSPACE_ID, threadId)).failedRun).toBeUndefined();

    // Nothing is left for recovery to mark failed.
    await fixture.service.stop();
    fixture.service = createChatDispatchService(fixture.serviceOptions);
    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(await fixture.dispatch.getRunRecord(runId)).toMatchObject({ failureHandled: false });
    expect(fixture.notices).toEqual([]);
  });

  it.each(["link pending"] as const)("saves a quiet run's end when dohc quits before it reads again, reply: %s", async (posted: "none" | "linked" | "link pending") => {
    let linkPending = posted === "link pending";
    const fixture = await createFixture({ runner: { command: "", profile: quietProfile }, hasPendingRunMessageLink: () => linkPending });
    const { threadId, runId, process } = await startAutomationRun(fixture);
    expect(fixture.service.endRunQuietly(WORKSPACE_ID, runId, threadId)).toBeNull();
    let reply = posted === "linked" ? await linkAgentReply(fixture, threadId, runId) : undefined;
    vi.useFakeTimers();
    const lookupError = new Error("daemon restarted during listRunMessages");
    fixture.rejectNextRunMessageLookup!(lookupError);
    process.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.errors).toContain(lookupError);
    vi.useRealTimers();

    await fixture.service.stop();
    expect(await fixture.dispatch.getRunRecord(runId)).toMatchObject({ exitCode: 0, failureHandled: false, endedAtMs: expect.any(Number) });
    // A reply whose link was still being written lands after the restart.
    if (linkPending) {
      reply = await linkAgentReply(fixture, threadId, runId);
      linkPending = false;
    }

    // After the restart, only a run that posted gets its notice, and none is marked failed.
    fixture.service = createChatDispatchService(fixture.serviceOptions);
    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(await fixture.dispatch.getRunRecord(runId)).toMatchObject({ exitCode: 0, failureHandled: false });
    expect(fixture.notices).toEqual(posted !== "none"
      ? [expect.objectContaining({ body: "Finished the work.", target: expect.objectContaining({ message: reply }) })]
      : []);
  });

  it("refuses to end quietly a person's run, another thread's, or one that isn't running", async () => {
    const person = await createFixture({ runner: { command: "", profile: quietProfile } });
    const asked = await createAgentThread(person, { body: "Plan the trip.", authorUserId: "user_local" });
    await activate(person);
    await person.service.scanWorkspace(WORKSPACE_ID);
    await vi.waitFor(() => expect(person.spawnCalls).toHaveLength(1));
    const personRun = (await person.dispatch.openRuns(WORKSPACE_ID))[0]!.run.runId;
    expect(person.service.endRunQuietly(WORKSPACE_ID, personRun, asked.threadId)).toBe("person");

    const fixture = await createFixture({ runner: { command: "", profile: quietProfile } });
    const { threadId, runId, process } = await startAutomationRun(fixture);
    expect(fixture.service.endRunQuietly(WORKSPACE_ID, runId, "another-thread")).toBe("other-thread");
    expect(fixture.service.endRunQuietly(WORKSPACE_ID, "another-run", threadId)).toBe("not-running");
    process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.service.endRunQuietly(WORKSPACE_ID, runId, threadId)).toBe("not-running");
    // Refused, so the run still ended without its reply.
    expect(await fixture.dispatch.getRunRecord(runId)).toMatchObject({ failureHandled: true });
  });

  it.each([
    ["claude", "linux", "mcp"],
    ["codex", "win32", "mcp"],
  ] as const)("passes the spawn contract in a %s runner self-test on %s", async (tool, platform, form) => {
    const profile = tool ? { tool, executable: resolve(`test-${tool}.exe`) } : undefined;
    const fixture = await createFixture({
      platform,
      runner: { command: profile ? "" : "claude -p", profile },
    });

    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID, "default");
    await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID });
    await vi.waitFor(() => {
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.process.stdinText).toEqual(expect.any(String));
    });
    expect(fixture.spawnCalls).toHaveLength(1);
    const call = fixture.spawnCalls[0]!;
    const threadId = call.options.env.DOHC_CHAT_THREAD!;
    expect(threadId).toEqual(expect.any(String));
    const runId = call.options.env.DOHC_RUN_ID;
    if (!runId) throw new Error("Expected self-test attribution.");
    // The run's secret reaches only its environment: not its prompt or arguments.
    const secret = call.options.env.DOHC_RUN_SECRET;
    expect(secret).toMatch(/^[a-f0-9]{64}$/u);
    expect(call.process.stdinText).not.toContain(secret);
    expect(call.args.join(" ")).not.toContain(secret);
    if (profile) {
      expect(call.command).toBe(profile.executable);
      // The run starts the dohc MCP server it replies through.
      const cliBin = join(fixture.appRoot, "node_modules", ".bin");
      const server = join(cliBin, platform === "win32" ? "dohc-mcp.cmd" : "dohc-mcp");
      const configPath = join(fixture.stateRoot, "run-logs", `${runId}.log.mcp.json`);
      expect(call.args).toEqual(agentProfileArguments(profile, profile.tool === "codex" ? [
        `mcp_servers.dohc.command='${server}'`,
        `mcp_servers.dohc.args=['--workspace','${fixture.workspace.rootPath}','--home','${fixture.stateRoot}','--tool','dohc_reply_to_chat']`,
        `mcp_servers.dohc.cwd='${cliBin}'`,
        "mcp_servers.dohc.required=true",
        "mcp_servers.dohc.env_vars=['DOHC_RUN_SECRET']",
        "mcp_servers.dohc.default_tools_approval_mode='approve'",
      ].flatMap((entry) => ["--config", entry]).concat(codexRunConfig({ rootPath: fixture.workspace.rootPath, runId, platform, files: { requirements: [], config: [], managedPreferences: [] }, readOnly: true, replyOnly: true })) : ["--mcp-config", configPath], true));
      if (profile.tool === "claude") {
        expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
          mcpServers: { dohc: { type: "stdio", command: server, args: ["--workspace", fixture.workspace.rootPath, "--home", fixture.stateRoot, "--tool", "dohc_reply_to_chat"] } },
        });
      }
      expect(call.options.cwd).toBe(fixture.workspace.rootPath);
    }
    const marker = `dohc-runner-self-test:${runId}`;
    const agentChannel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    expect(call.process.stdinText).toContain(expectedReply(form, threadId, runId, marker));
    if (form === "mcp") expect(call.process.stdinText).toContain(`\`body\` \`${marker}\``);
    expect(runId).toBe("run_self_test_self_test_id_1");
    expect(fixture.attributions.at(-1)?.run).toEqual({ agentId: "default", agentRunId: runId, depth: 0, dispatch: "self-test", secret });

    expect(await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId })).toEqual([
      expect.objectContaining({ author: expect.objectContaining({ kind: "human" }), body: "Reply here to check the agent connection." }),
    ]);
    await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId,
      author: { kind: "agent", displayName: "Sam" },
      origin: "cli",
      authorAgentId: "default",
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

    const retryPromise = fixture.service.runnerSelfTest(WORKSPACE_ID, "default");
    await vi.waitFor(() => {
      expect(fixture.spawnCalls).toHaveLength(2);
      expect(fixture.spawnCalls[1]!.process.stdinText).toEqual(expect.any(String));
    });
    const retryCall = fixture.spawnCalls[1];
    if (!retryCall) throw new Error("Expected a self-test retry.");
    expect(retryCall.options.env.DOHC_CHAT_THREAD).toBe(threadId);
    const retryRunId = retryCall.options.env.DOHC_RUN_ID;
    if (!retryRunId) throw new Error("Expected retry attribution.");
    const retryMarker = `dohc-runner-self-test:${retryRunId}`;
    expect(retryMarker).not.toBe(marker);
    await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId,
      author: { kind: "agent", displayName: "Sam" },
      origin: "cli",
      authorAgentId: "default",
      body: retryMarker,
    });
    retryCall.process.emitExit(0);
    await expect(retryPromise).resolves.toMatchObject({ ok: true });

    // Both checks reuse one thread of their own, apart from the DM's conversation.
    const scratchThreads = await fixture.chat.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: agentChannel.id,
    });
    expect(
      scratchThreads.filter(
        (summary) => summary.thread.title === "dohc runner self-test",
      ),
    ).toHaveLength(1);
    expect((await fixture.chat.getThread({ workspaceId: WORKSPACE_ID, threadId })).thread.lane).toBe("posts");
  });

  it("ends a runner self-test as unconfirmed when its reply did not come from the run", async () => {
    const fixture = await createFixture({ runner: { command: "claude -p" } });

    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID, "default");
    await vi.waitFor(() => {
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.process.stdinText).toEqual(expect.any(String));
    });
    const call = fixture.spawnCalls[0]!;
    // A reply sent without the run's secret posts as the unnamed agent, with no agent id.
    await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: call.options.env.DOHC_CHAT_THREAD!,
      author: { kind: "agent", displayName: "Sam" },
      origin: "cli",
      body: `dohc-runner-self-test:${call.options.env.DOHC_RUN_ID}`,
    });

    // The check ends on that reply, without waiting for the runner to exit.
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      unconfirmed: true,
      detail: "Nova's Command started its tools without this check's credential, so its replies show as Agent. Edit the Command in Nova's details.",
      logPath: join(fixture.stateRoot, "run-logs", `${call.options.env.DOHC_RUN_ID}.log`),
    });
    expect(fixture.killCalls).toContainEqual({ pid: -call.process.pid!, signal: "SIGTERM" });
    call.process.emitExit(null, "SIGTERM");
  });

  describe("in a workspace in Restricted Mode", () => {
    it("holds each request unclaimed and unfailed, tells the person once, and starts it once trusted", async () => {
      const fixture = await createFixture({ restricted: true });
      const first = await createAgentThread(fixture, { body: "Plan the trip.", authorUserId: "user_local" });
      await activate(fixture);
      const second = await createAgentThread(fixture, { body: "Book the hotel.", authorUserId: "user_local" });
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      await fixture.service.scanWorkspace(WORKSPACE_ID);

      expect(fixture.spawnCalls).toEqual([]);
      expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]);
      expect((await fixture.dispatch.listPending(WORKSPACE_ID)).map((record) => record.triggerMessageId).sort())
        .toEqual([first.messageId, second.messageId].sort());
      // Holding claims nothing, so the thread's budget is untouched.
      expect(await fixture.dispatch.recentDispatchCount({ workspaceId: WORKSPACE_ID, threadId: first.threadId, sinceMs: 0 }))
        .toBe(0);
      expect(fixture.notices).toEqual([]);
      expect(await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: first.threadId }))
        .toEqual([expect.objectContaining({ id: first.messageId })]);
      expect(fixture.dispatchNotices.map(({ notice }) => notice)).toEqual([
        { reason: "restricted", threadId: first.threadId, message: AGENTS_RESTRICTED_MESSAGE },
      ]);

      await fixture.trust.trust(fixture.workspace);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect([first.threadId, second.threadId]).toContain(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD);
      expect(fixture.dispatchNotices).toHaveLength(1);
    });

    it("puts back a request whose workspace was restricted after the trust lookup, and starts it once trusted", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
      });
      const trigger = await createAgentThread(fixture, { body: "Plan day 2", authorUserId: "user_local" });

      await activate(fixture);

      expect(fixture.spawnCalls).toEqual([]);
      // The request is back in line, held, with one attempt spent on the start.
      expect(fixture.readDispatch(trigger.messageId, trigger.threadId)).toMatchObject({ state: "pending", attemptCount: 1 });
      expect(fixture.requeues).toEqual([expect.objectContaining({ triggerMessageId: trigger.messageId })]);
      expect(fixture.notices).toEqual([]);
      expect(fixture.dispatchNotices.map(({ notice }) => notice)).toEqual([
        { reason: "restricted", threadId: trigger.threadId, message: AGENTS_RESTRICTED_MESSAGE },
      ]);

      await trustWorkspace(fixture);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(trigger.threadId);
    });

    it("stops a live run when the workspace is restricted, and starts nothing after it exits", async () => {
      const fixture = await createFixture();
      const trigger = await createAgentThread(fixture, { body: "Long task.", authorUserId: "user_local" });
      await activate(fixture);
      const process = fixture.spawnCalls[0]!.process;

      fixture.trust.revoke(WORKSPACE_ID);
      const stopping = fixture.service.stopForRestrictedMode(WORKSPACE_ID);
      await vi.waitFor(() => expect(fixture.killCalls).toEqual([{ pid: -process.pid!, signal: "SIGTERM" }]));
      process.emitExit(null, "SIGTERM");
      await expect(stopping).resolves.toBeUndefined();
      expect(fixture.readDispatch(trigger.messageId, trigger.threadId).state).toBe("failed");
      await vi.waitFor(() => expect(fixture.notices.map((notice) => notice.title)).toEqual(["Stopped Nova's run in \"Long task.\""]));

      await createAgentThread(fixture, { body: "Next task.", authorUserId: "user_local" });
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
    });

    it("reports a runner that outlives its kill when the workspace is restricted", async () => {
      vi.useFakeTimers();
      const fixture = await createFixture();
      await createAgentThread(fixture, { body: "Stubborn task.", authorUserId: "user_local" });
      await activate(fixture);

      fixture.trust.revoke(WORKSPACE_ID);
      let settled = false;
      const stopping = fixture.service.stopForRestrictedMode(WORKSPACE_ID).finally(() => { settled = true; });
      const outcome = expect(stopping).rejects.toThrow(RUNNER_OUTLIVED_STOP);
      // The wait for the exit starts once the stop's end is saved, which
      // takes real file writes, so the clock moves on while they land.
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(RUNNER_KILL_GRACE_MS + 1_000);
        expect(settled).toBe(true);
      }, { timeout: 10_000, interval: 20 });
      await outcome;
      expect(fixture.killCalls.map((call) => call.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("owes the notice until the requeue lands, so a crash before it still tells the person", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
        requeueFailures: [new Error("dohc stopped before the requeue")],
      });
      const trigger = await createAgentThread(fixture, { body: "Plan day 6", authorUserId: "user_local" });
      await activate(fixture);
      const runId = fixture.requeues[0]!.runId;
      expect(await owedRuns(fixture)).toEqual([runId]);

      // Nothing this run of dohc held in memory survives.
      await fixture.service.stop();
      const restarted = createChatDispatchService(fixture.serviceOptions);
      try {
        restarted.start();
        await restarted.scanWorkspace(WORKSPACE_ID);
        expect(fixture.readDispatch(trigger.messageId, trigger.threadId).state).toBe("failed");
        expect(fixture.notices).toEqual([expect.objectContaining({
          title: "Restricted Mode blocked Nova's run in \"Plan day 6\"",
        })]);
      } finally {
        await restarted.stop();
      }
    });

  });
});
