import type { ChatDispatchNotice } from "../ipc/bridgeContract";
import { agentProfileArguments } from "./agentToolCatalog";
import { codexRunConfig } from "./codexRunConfig";
import {
  APP_QUIT_KILL_GRACE_MS,
  RUNNER_KILL_GRACE_MS,
  type RunnerProcess,
  type RunnerSpawnOptions,
  type SpawnRunner,
} from "./chatRunnerProcess";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import {
  CHATS_METHOD,
  type ChatDispatch,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import type {
  AgentDispatchClaim,
  ChatMessage,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchFrom, type AgentLaunchProfile } from "./agentToolCatalog";
import { testAgent } from "../testing/agentSettings";
import type { Agent } from "../settings/userSettings";

// The first agent's launch, switch and timeout, which a test changes in place.
type RunnerSettings = { command: string; profile?: AgentLaunchProfile; enabled: boolean; timeoutMinutes: number };
import type { PostNoticeInput } from "../notices/noticeStore";
import { createOwedRunNotices, type OwedRunNotices } from "./owedRunNotices";
import {
  EngineClientError,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import {
  APP_QUIT_EXIT_CODE,
  CHAT_DISPATCH_BUDGET_MAX,
  CHAT_DISPATCH_PUMP_MS,
  CHAT_DISPATCH_RECOVERY_BACKOFF_MS,
  RUNNER_SELF_TEST_TIMEOUT_MS,
  RUNNER_OUTLIVED_STOP,
  SELF_TEST_RESTRICTED_DETAIL,
  createChatDispatchService,
  type ChatDispatchPresenceInput,
  type ChatDispatchService,
  type ChatDispatchWorkspace,
} from "./chatDispatchService";
import {
  AGENT_DISPATCH_RPC_DEADLINE_MS,
  type AwaitableAgentDispatchStore,
} from "./awaitableAgentDispatchStore";
import { createLiveAgentDispatchStore } from "./liveAgentDispatchStore";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createChatWrites, deriveChatActorKey, type ChatWriteStore } from "../workspaces/chatWrites";
import { createActorIssuer, deriveMomentActor, parseActorKey } from "@dohc/workspace-contracts/actor-identity";
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
  readonly rawChild = undefined;
  // What the dispatch delivered on stdin. The prompt travels here rather than
  // in argv, so this is where a test must look to prove it was sent at all.
  stdinText: string | null = null;
  private exited = false;
  private readonly exitListeners: Array<
    (exitCode: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  constructor(readonly pid: number | undefined) {}

  writeStdin(text: string): void {
    this.stdinText = text;
  }

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
  // Agents after the default one, which `runner` sets up.
  agents?: Agent[];
  dispatchNoticeFailures?: Error[];
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
  notices: PostNoticeInput[];
  // Where the service keeps the runs whose notice is owed, and its own
  // view of them, which changes only once the file does.
  owedRunNoticesPath: string;
  owedRunNotices: OwedRunNotices;
  requeues: Array<{
    workspaceId: string;
    attachmentId?: symbol;
    triggerMessageId: string;
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
  const listRecoveriesRaw = liveDispatch.listAppQuitRecoveries;
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
    listAppQuitRecoveries: (dispatchWorkspace) =>
      listRecoveriesRaw(dispatchWorkspace.workspaceId),
    spawnRunner,
    killProcessGroup,
    platform: options.platform ?? "linux",
    arch: options.arch,
    // Never this computer's own Codex config.
    codexConfigFiles: () => ({ requirements: [], config: [] }),
    nowMs: () => now.value,
    createId: () => `self_test_id_${(nextSelfTestId += 1)}`,
    onError: (error) => errors.push(error),
    onDispatchNotice: (workspace, notice) => {
      const error = options.dispatchNoticeFailures?.shift();
      if (error) throw error;
      dispatchNotices.push({ workspace, notice });
    },
    runNotices: {
      // One notice per id, as the notice store keeps them.
      post: async (input) => {
        const failure = options.noticeFailures?.shift();
        if (failure) throw failure;
        if (!notices.some((notice) => notice.noticeId === input.noticeId)) notices.push(input);
      },
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
    ...(actor === "human" ? { namedAgentIds: ["default"] } : {}),
    body: `@Nova ${input.body}`,
  });
  return { threadId: started.thread.id, messageId: started.message.id };
}

function messageIds(messages: ChatMessage[]): Array<{ id: string; body: string }> {
  return messages.map((message) => ({ id: message.id, body: message.body }));
}

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
    namedAgentIds: ["default"],
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
async function restrictWorkspace(fixture: Fixture): Promise<void> {
  await fixture.trust.restrict(WORKSPACE_ID);
}

describe("chatDispatchService", () => {
  it("the connection test exposes the missing packaged runtime repair instruction", async () => {
    const fixture = await createFixture({ packaged: true, platform: bundledPlatform, arch: bundledArch, runner: { command: `"${process.execPath}"` } });
    const result = await fixture.service.runnerSelfTest(WORKSPACE_ID);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("dohc is missing a file it needs to run agents. Reinstall dohc, then try again.");
    expect(result.detail).not.toContain("runner failed to start: runner failed to start:");
    expect(fixture.spawnCalls).toHaveLength(0);
  });
  it.each([0, 7])("a packaged run with its own Node does not recommend installing Node, exit %s", async (exitCode) => {
    const fixture = await createFixture({ packaged: true, platform: bundledPlatform, arch: bundledArch, runner: { command: `"${process.execPath}"` } });
    const compiler = join(fixture.appRoot, "resources", "app-compiler");
    await mkdir(compiler, { recursive: true });
    await writeFile(join(compiler, nodeName), "runtime", { mode: 0o755 });
    vi.stubEnv("PATH", "");
    await createAgentThread(fixture, { body: "Run the request.", authorUserId: "user_local" });
    await activate(fixture);
    fixture.spawnCalls[0]!.process.emitExit(exitCode);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]!.body).toBe("");
  });

  it("shows the missing packaged runtime repair instruction in Notices", async () => {
    const fixture = await createFixture({ packaged: true, platform: bundledPlatform, arch: bundledArch, runner: { command: `"${process.execPath}"` } });
    await createAgentThread(fixture, { body: "Run the request.", authorUserId: "user_local" });
    await activate(fixture);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(fixture.notices).toEqual([expect.objectContaining({
      body: "dohc is missing a file it needs to run agents. Reinstall dohc, then try again.",
    })]);
  });
  it.each([
    { nodePresent: false, exitCode: 7, replied: false },
    { nodePresent: false, exitCode: 0, replied: false },
    { nodePresent: true, exitCode: 7, replied: false },
    { nodePresent: true, exitCode: 0, replied: false },
    { nodePresent: false, exitCode: 0, replied: true },
    { nodePresent: false, exitCode: 7, replied: true },
  ])("adds the Node.js notice only for a missing runtime and missing reply: %j", async ({ nodePresent, exitCode, replied }) => {
    const fixture = await createFixture();
    const bin = join(fixture.appRoot, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    if (nodePresent) await writeFile(join(bin, "node"), "not executed", { mode: 0o700 });
    vi.stubEnv("PATH", "");
    const trigger = await createAgentThread(fixture, { body: "Run the request.", authorUserId: "user_local" });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    if (replied) await linkAgentReply(fixture, trigger.threadId, claim.run.runId);

    fixture.spawnCalls[0]!.process.emitExit(exitCode);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]!.body).toBe(!nodePresent && !replied
      ? "Agent replies need Node.js. Install Node.js, restart dohc, then try again."
      : "");
  });

  it.each([0, 7])("recovers the saved Node.js notice after restart, exit %s", async (exitCode) => {
    const noticeFailures = Array.from({ length: 20 }, () => new Error("Notice unavailable"));
    const fixture = await createFixture({ noticeFailures });
    vi.stubEnv("PATH", "");
    await createAgentThread(fixture, { body: "Recover the notice.", authorUserId: "user_local" });
    await activate(fixture);
    fixture.spawnCalls[0]!.process.emitExit(exitCode);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    const runId = fixture.spawnCalls[0]!.options.env.DOHC_RUN_ID!;
    expect(fixture.notices).toEqual([]);
    expect(await fixture.owedRunNotices.list(WORKSPACE_ID)).toContain(runId);
    expect(await fixture.dispatch.getRunRecord(runId)).toMatchObject({ exitCode });
    await fixture.service.stop();
    fixture.service = createChatDispatchService({
      ...fixture.serviceOptions,
      runNotices: {
        post: async (notice) => { fixture.notices.push(notice); },
        owed: createOwedRunNotices(() => fixture.owedRunNoticesPath),
      },
    });
    vi.unstubAllEnvs();
    await activate(fixture);
    expect(fixture.notices).toEqual([expect.objectContaining({
      body: "Agent replies need Node.js. Install Node.js, restart dohc, then try again.",
    })]);
  });

  it("does not provision an agent channel before the runner is enabled", async () => {
    const fixture = await createFixture({ runner: { enabled: false } });

    fixture.service.setPaused(true);
    await activate(fixture);

    expect((await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID })).filter(
      (channel) => channel.kind === "agent",
    )).toHaveLength(0);
  });

  it("provisions the agent channel after the runner is enabled", async () => {
    const fixture = await createFixture({ runner: { enabled: false, command: "" } });

    fixture.service.setPaused(true);
    await activate(fixture);
    expect(await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID })).toEqual([]);

    fixture.runner.enabled = true;
    fixture.runner.command = "node agent.mjs";
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect((await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID })).filter(
      (channel) => channel.kind === "agent",
    )).toHaveLength(1);
    fixture.runner.enabled = false;
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect((await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID })).filter(
      (channel) => channel.kind === "agent",
    )).toHaveLength(1);
  });

  it("notifies the renderer when a recovery scan provisions the opted-in agent", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({ runner: { enabled: false, command: "" } });
    fixture.service.setPaused(true);
    await activate(fixture);
    fixture.runner.enabled = true;
    fixture.runner.command = "node agent.mjs";
    const failure = new Error("agent channel temporarily unavailable");
    vi.spyOn(fixture.chat, "ensureAgentChannel").mockRejectedValueOnce(failure);

    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.errors).toContain(failure);
    expect(fixture.runUpdatedWorkspaces).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);

    expect((await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID })).filter(
      (channel) => channel.kind === "agent",
    )).toHaveLength(1);
    expect(fixture.runUpdatedWorkspaces).toEqual([WORKSPACE_ID]);
  });

  it("gives each agent its chat when another agent's chat cannot be made", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({
      agents: [{ id: "codex", ...testAgent({ name: "Codex", launch: { command: "node codex.mjs" } }) }],
    });
    const failure = new Error("Nova's chat cannot be made");
    const ensureAgentChannel = fixture.chat.ensureAgentChannel.bind(fixture.chat);
    vi.spyOn(fixture.chat, "ensureAgentChannel").mockImplementation((input) =>
      input.agentId === "default" ? Promise.reject(failure) : ensureAgentChannel(input));

    await activate(fixture);

    expect(fixture.errors).toContain(failure);
    expect((await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID }))
      .filter((channel) => channel.kind === "agent")
      .map((channel) => channel.agentId)).toEqual(["codex"]);
  });

  it("writes a request for each agent a person asks, in the message's own write", async () => {
    const fixture = await createFixture({ runner: { enabled: false } });
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
    const localWithoutRelayIdentity = await createAgentThread(fixture, {
      body: "A solo/local send is allowed without authorUserId.",
    });
    const general = await fixture.chat.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const mention = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      namedAgentIds: ["default", "codex"],
      body: "Could @Nova and @Codex audit this plan?",
    });
    // Plain text naming no agent by id wakes nobody.
    await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      body: "Could @agent audit this plan?",
    });
    // Only a person's message names agents to wake.
    await expect(fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "agent", displayName: "Nova" },
      namedAgentIds: ["default"],
      body: "@Nova does not wake itself.",
    })).rejects.toThrow();

    const requests = async () => (await fixture.dispatch.listPending(WORKSPACE_ID))
      .map((record) => [record.triggerMessageId, record.agentId]);
    const expected = [
      [agentHuman.messageId, "default"],
      [localWithoutRelayIdentity.messageId, "default"],
      [mention.message.id, "codex"],
      [mention.message.id, "default"],
    ];
    expect(await requests()).toEqual(expected);

    fixture.service.setPaused(true);
    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(await requests()).toEqual(expected);
    expect(fixture.spawnCalls).toHaveLength(0);
  });

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
      namedAgentIds: ["default", "codex", "scout"],
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

  it("reports each pause and resume once, wherever it came from", async () => {
    const fixture = await createFixture();
    const onPausedChanged = vi.fn<(paused: boolean) => void>();
    const service = createChatDispatchService({ ...fixture.serviceOptions, onPausedChanged });

    service.setPaused(true);
    service.setPaused(true);
    service.setPaused(false);
    service.setPaused(false);

    expect(onPausedChanged.mock.calls).toEqual([[true], [false]]);
    expect(service.isPaused()).toBe(false);
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
    const fixture = await createFixture();
    const asked = await createAgentThread(fixture, { body: "Plan the trip.", authorUserId: "user_local" });
    await activate(fixture);
    const personRun = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    expect(personRun.chainDepth).toBe(0);
    expect(fixture.attributions.at(-1)).toEqual({
      workspaceId: WORKSPACE_ID,
      run: { agentId: "default", agentRunId: personRun.run.runId, depth: 0, dispatch: "run" },
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
    expect(fixture.attributions.at(-1)?.run).toEqual({
      agentId: "default", agentRunId: wokenRun.run.runId, depth: 3, dispatch: "run",
    });
    // The agent reads that an automation asked, not a person.
    expect(fixture.spawnCalls[1]!.process.stdinText).toContain("**Stamp the finish date** · automation ·");
  });

  it("records a run's file writes as the agent its replies are", async () => {
    const fixture = await createFixture();
    await createAgentThread(fixture, { body: "Plan the trip.", authorUserId: "user_local" });
    await activate(fixture);
    const run = fixture.attributions.at(-1)?.run;
    if (!run) throw new Error("Expected the run's attribution.");
    // History keys a file write by the run slot's agent. The runner replies
    // with `dohc chat reply --as-agent`, which main writes as the run's agent.
    const issuer = createActorIssuer("https://cloud.test");
    const fileWrite = deriveMomentActor(
      { kind: "agent", agentId: run.agentId, agentRunId: run.agentRunId, onBehalfOf: "user-1" },
      { source: "own-store", workspaceId: WORKSPACE_ID, identity: { installationId: "local-id", account: { issuer, userId: "user-1" } } },
      "Nova",
    );
    const reply = deriveChatActorKey({
      credentials: { serverUrl: "https://cloud.test", userId: "user-1" },
      installationId: "local-id",
      workspaceId: WORKSPACE_ID,
      writer: { via: "cli", actor: "agent", agentId: run.agentId },
      displayName: "Nova",
    });
    expect(parseActorKey(reply!)).toEqual(fileWrite.key);
  });

  it("releases temporary tray-only run activity after the owned child exits", async () => {
    const fixture = await createFixture({ temporaryRunActivity: true });
    const trigger = await createAgentThread(fixture, {
      body: "Run with temporary workspace activity.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");

    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 0 });
    expect(fixture.runUpdatedWorkspaces).toContain(WORKSPACE_ID);
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 1 });
  });

  it("preserves a surviving runner claim across a daemon lifecycle swap", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Keep this runner alive while the daemon restarts.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim || !fixture.restartDaemon) {
      throw new Error("Expected a live runner and restartable daemon.");
    }
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);

    fixture.restartDaemon();
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 0,
    });
    expect(
      fixture.readDispatch(trigger.messageId, trigger.threadId),
    ).toMatchObject({ state: "done", attemptCount: 1 });
    expect(fixture.spawnCalls).toHaveLength(1);
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
      "Your agent's run in \"Fail during runner setup while the daemon is unavailable.\" failed to start",
    ]);
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(
      second.threadId,
    );
  });

  it("says why a runner could not start in the run's notice and the self-test", async () => {
    const fixture = await createFixture({
      platform: "win32",
      runner: { command: "dohc-missing-runner -p" },
    });
    const reason = "Couldn't find dohc-missing-runner on PATH. Use its full path in the runner command.";
    await createAgentThread(fixture, { body: "Plan day 2", authorUserId: "user_local" });

    await activate(fixture);

    await vi.waitFor(() => {
      expect(fixture.notices).toEqual([expect.objectContaining({
        title: "Your agent's run in \"Plan day 2\" failed to start",
        body: reason,
      })]);
    });
    expect(fixture.spawnCalls).toEqual([]);
    await expect(fixture.service.runnerSelfTest(WORKSPACE_ID)).resolves.toEqual({
      ok: false,
      detail: expect.stringContaining(`Runner self-test could not start. ${reason} Log: `),
    });
  });

  it("releases the live slot when the final run-message lookup rejects", async () => {
    const fixture = await createFixture({
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
    const firstClaim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    const lookupError = new Error("daemon restarted during listRunMessages");
    if (!firstClaim || !fixture.rejectNextRunMessageLookup) {
      throw new Error("Expected a live runner and injectable daemon failure.");
    }

    fixture.rejectNextRunMessageLookup(lookupError);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.errors).toContain(lookupError);
    expect(await fixture.dispatch.getRunRecord(firstClaim.run.runId)).toMatchObject({
      exitCode: 0,
    });
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(next.threadId);
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 1 });
    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: first.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(await fixture.dispatch.getRunRecord(firstClaim.run.runId)).toMatchObject({
      failureHandled: true,
    });
    // A failed reply lookup never reads as a finished run.
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Your agent's run in \"Finish while the daemon read is unavailable.\" produced no reply",
    ]);
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
        namedAgentIds: ["default"],
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
      liveRunId: expect.any(String),
      pendingCount: 0,
      paused: false,
    });

    await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      namedAgentIds: ["default"],
      body: "@Nova Arrived after spawn.",
    });
    // The request is written with the message, so the thread's next read,
    // which a new message prompts, shows it.
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toMatchObject({
      liveRunId: expect.any(String),
      pendingCount: 1,
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
  it("keeps the prompt off argv so a cmd-shimmed runner can dispatch", async () => {
    const fixture = await createFixture();
    await activate(fixture);
    const trigger = await createAgentThread(fixture, {
      body: "Ship the release notes.",
    });
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const call = fixture.spawnCalls[0]!;
    const prompt = call.process.stdinText ?? "";
    expect(prompt).toContain(`--option "<choice>"`);
    expect(prompt).toContain("Ship the release notes.");
    // Nothing carrying a quote may reach the command line, because that is
    // exactly what cmd.exe cannot represent.
    for (const arg of call.args) expect(arg).not.toContain('"');
    expect(call.args.join(" ")).not.toContain("--as-agent");
    expect(call.args.join(" ")).not.toContain("Ship the release notes.");
    expect(trigger.threadId).toBeTruthy();
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
          agentId: "default",
          name: "Nova",
        });
        await chat.startChannelThread({
          authorActorKey: null,
          workspaceId: WORKSPACE_ID,
          channelId: channel.id,
          author: { kind: "human", displayName: "Sam" },
          authorUserId: "user_local",
          body: "Remote tray-only task.",
        });
      },
    });

    fixture.service.start();
    expect(fixture.spawnCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_PUMP_MS);
    await vi.waitFor(() => {
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.process.stdinText).toContain("Remote tray-only task.");
    }, { interval: 0 });

    expect(fixture.syncRequests).toEqual([WORKSPACE_ID]);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.process.stdinText).toContain(
      "Remote tray-only task.",
    );
  });

  it("carries the physical attachment token into asynchronous sync work", async () => {
    vi.useFakeTimers();
    const attachmentId = Symbol("attachment");
    const fixture = await createFixture({
      workspaceAttachmentId: attachmentId,
      pumpWorkspace: true,
      onQueueSync: () => false,
    });

    fixture.service.start();
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_PUMP_MS);

    expect(fixture.syncWorkspaces).toEqual([fixture.workspace]);
    expect(fixture.syncWorkspaces[0]?.attachmentId).toBe(attachmentId);
  });

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
    expect(starts).toEqual([WORKSPACE_ID, secondWorkspace.workspaceId]);

    releaseFirst?.();
  });

  it.each([
    { runner: { enabled: false }, reason: "disabled" },
    { runner: { enabled: true, command: "" }, reason: "unconfigured" },
  ] as const)("reports $reason dispatch without writing an agent message", async ({ runner, reason }) => {
    const fixture = await createFixture({ runner });
    const trigger = await createAgentThread(fixture, {
      body: "Needs a runner.",
      authorUserId: "user_local",
    });
    const original = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID, threadId: trigger.threadId,
    });

    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(await fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
    expect(fixture.readDispatch(trigger.messageId, trigger.threadId))
      .toMatchObject({ state: "failed", failureReason: "no-runner" });
    expect(messageIds(await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID, threadId: trigger.threadId,
    }))).toEqual(messageIds(original));
    expect(fixture.dispatchNotices).toEqual([{ workspace: fixture.workspace, notice: {
      reason: "no-runner", threadId: trigger.threadId,
      message: reason === "disabled"
        ? "Nova's chat runner is off. Turn it on in Settings → Agents."
        : "Nova has no chat runner set up. Set one up in Settings → Agents.",
    } }]);
    expect(fixture.postedWorkspaces).toEqual([]);
    expect(fixture.spawnCalls).toEqual([]);

    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.dispatchNotices).toHaveLength(1);
    const followUp = await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      namedAgentIds: ["default"],
      body: "@Nova Still needs the same missing runner.",
    });
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(fixture.dispatchNotices).toHaveLength(2);
    expect(messageIds(await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID, threadId: trigger.threadId,
    }))).toEqual(messageIds([...original, followUp]));
    expect(await fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([]);
  });

  it("loads pause state per pending thread and for the runner context", async () => {
    const fixture = await createFixture();
    const paused = await createAgentThread(fixture, {
      body: "Keep this thread paused.",
      authorUserId: "user_local",
    });
    const pausedFollowUp = await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: paused.threadId,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      body: "This second trigger is paused too.",
    });
    const runnable = await createAgentThread(fixture, {
      body: "Run after skipping the paused thread.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: paused.messageId,
      threadId: paused.threadId,
      agentId: "default",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: pausedFollowUp.id,
      threadId: paused.threadId,
      agentId: "default",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: runnable.messageId,
      threadId: runnable.threadId,
      agentId: "default",
    });
    await fixture.dispatch.setThreadDispatchPaused({
      workspaceId: WORKSPACE_ID,
      threadId: paused.threadId,
      paused: true,
    });

    await activate(fixture);

    const pauseRequests = fixture.dispatchRequests.filter(
      ({ method }) => method === "chats.dispatch.getThreadPauseState",
    );
    expect(pauseRequests).toHaveLength(3);
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

  it("reserves the workspace while the asynchronous claim is pending", async () => {
    const fixture = await createFixture({ deferClaim: true });
    await createAgentThread(fixture, {
      body: "Hold the claim while self-test checks the slot.",
      authorUserId: "user_local",
    });

    fixture.service.start();
    const scanning = fixture.service.scanWorkspace(WORKSPACE_ID);
    await fixture.claimStarted;

    const selfTest = fixture.service.runnerSelfTest(WORKSPACE_ID);
    let selfTestSettled = false;
    void selfTest.then(
      () => { selfTestSettled = true; },
      () => { selfTestSettled = true; },
    );
    try {
      await vi.waitFor(() => {
        expect(selfTestSettled || fixture.spawnCalls.length > 0).toBe(true);
      });
      const competingSpawnCount = fixture.spawnCalls.length;
      expect(competingSpawnCount).toBe(0);
      await expect(selfTest).resolves.toEqual({
        ok: false,
        detail: "A runner is already active in this workspace.",
      });
    } finally {
      if (fixture.spawnCalls.length > 0) {
        fixture.spawnCalls[0]!.process.emitExit(1);
      }
      fixture.releaseClaim?.();
    }

    await scanning;
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it.each([false, true])("keeps the budget pause without a chat message when notice reporting fails: %s", async (noticeFails) => {
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
      liveRunId: null,
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
      message: 'Your agent ran 10 times in 10 minutes in "This next run should pause once the bud…". Choose Resume there to continue.',
    } }]);
    expect(fixture.errors).toEqual(noticeFails ? [noticeError] : []);
    expect(fixture.postedWorkspaces).toEqual([]);

    await fixture.service.resumeThreadDispatch(WORKSPACE_ID, pending.threadId);
    expect(await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId)).toBe(false);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, pending.threadId)).toMatchObject({
      liveRunId: expect.any(String),
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
        const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { command: "seed-runner" });
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

    it("still pauses the person's quick replies in a post beside the conversation", async () => {
      const fixture = await createFixture();
      const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
      const wake = await fixture.chat.startChannelThread({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        channelId: channel.id,
        ownThread: true,
        title: "Stamp the finish date",
        author: { kind: "agent", displayName: "Nova" },
        origin: "cli",
        body: "Stamp today's tasks.",
      });
      const reply = async (index: number) => await fixture.chat.sendMessage({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        threadId: wake.thread.id,
        author: { kind: "human", displayName: "Sam" },
        authorUserId: "user_local",
        body: `Reply ${index}`,
      });
      for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
        const message = await reply(index);
        await fixture.dispatch.recordTrigger({ workspaceId: WORKSPACE_ID, triggerMessageId: message.id, threadId: wake.thread.id, agentId: "default" });
        const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { command: "seed-runner" });
        if (!claim) throw new Error("Expected a seeded claim.");
        await fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
      }
      await reply(CHAT_DISPATCH_BUDGET_MAX);

      await activate(fixture);
      await fixture.service.scanWorkspace(WORKSPACE_ID);

      expect(fixture.spawnCalls).toHaveLength(0);
      expect(await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, wake.thread.id)).toBe(true);
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
        message: 'Your agent ran 10 times in 10 minutes in "Nova". Choose Resume there to continue.',
      } }]);
    });

    it("cuts a long agent name so Choose Resume stays in view", async () => {
      const fixture = await createFixture({ agentName: "Nova the very thorough trip planning assistant" });
      await finishDmRuns(fixture, "agent", CHAT_DISPATCH_BUDGET_MAX);

      await askAgain(fixture);

      expect(fixture.dispatchNotices.map((entry) => entry.notice.message)).toEqual([
        'Your agent ran 10 times in 10 minutes in "Nova the very thorough trip planning as…". Choose Resume there to continue.',
      ]);
    });
  });

  it("names the group when its conversation pauses", async () => {
    const fixture = await createFixture();
    await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const group = await fixture.chat.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await fixture.chat.startChannelThread({
      authorActorKey: null, workspaceId: WORKSPACE_ID, channelId: group.id, lane: "chat",
      author: { kind: "human", displayName: "Sam" }, authorUserId: "user_local", body: "Planning the trip.",
    });
    for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
      await fixture.dispatch.recordTrigger({ workspaceId: WORKSPACE_ID, triggerMessageId: `seed_${index}`, threadId: thread.id, agentId: "default" });
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, { command: "seed-runner" });
      if (!claim) throw new Error("Expected a seeded budget claim.");
      await fixture.dispatch.completeRun({ runId: claim.run.runId, exitCode: 0 });
    }
    await askAgain(fixture, thread.id);

    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.dispatchNotices.map((entry) => entry.notice)).toEqual([{
      reason: "budget-paused", threadId: thread.id, channelId: group.id,
      message: "Your agent ran 10 times in 10 minutes in #general. Choose Resume there to continue.",
    }]);
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
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
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

  it("restores a Resume budget bypass when uncertain-claim preparation rejects", async () => {
    const preparationError = new Error("workspace hydration failed");
    const fixture = await createFixture({
      ambiguousClaimOnce: true,
      prepareRunWorkspaceFailures: [null, preparationError],
    });
    const pending = await createAgentThread(fixture, {
      body: "Resume through uncertain claim preparation.",
      origin: "cli",
    });
    for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: `uncertain_resume_seed_${index}`,
        threadId: pending.threadId,
        agentId: "default",
      });
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
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
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toBe(preparationError);

    const uncertain = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!uncertain) throw new Error("Expected the ambiguously committed claim.");
    await fixture.dispatch.failRun({
      runId: uncertain.run.runId,
      reason: "clear failed preparation",
    });
    const followUp = await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: pending.threadId,
      author: { kind: "human", displayName: "Sam" },
      authorUserId: "user_local",
      body: "Continue after workspace hydration recovers.",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: followUp.id,
      threadId: pending.threadId,
      agentId: "default",
    });

    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(
      await fixture.dispatch.threadDispatchPaused(WORKSPACE_ID, pending.threadId),
    ).toBe(false);
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("tells the request's group each time a request starts, fails or finishes", async () => {
    const fixture = await createFixture();
    const failing = await createAgentThread(fixture, { body: "Audit the files.", authorUserId: "user_local" });
    const finishing = await createAgentThread(fixture, { body: "Plan day 2.", authorUserId: "user_local" });
    const { channelId } = (await fixture.chat.getThread({
      workspaceId: WORKSPACE_ID, threadId: failing.threadId,
    })).thread;
    await activate(fixture);
    // Each change after the request was written names the thread's group.
    const groups = () => fixture.agentRequestGroups.filter((group) => group !== null);
    await vi.waitFor(() => expect(groups()).toEqual([channelId]));
    let seen = groups().length;
    // Each step adds at least one change, every one naming the thread's group.
    const changedAgain = async () => {
      await vi.waitFor(() => expect(groups().length).toBeGreaterThan(seen));
      expect(new Set(groups())).toEqual(new Set([channelId]));
      seen = groups().length;
    };

    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    const [asked] = await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: failing.threadId });
    expect(asked?.agentRequests).toEqual([expect.objectContaining({ state: "failed", exitCode: 7 })]);
    await changedAgain();
    // The next request started.
    expect(fixture.spawnCalls).toHaveLength(2);

    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    await linkAgentReply(fixture, finishing.threadId, claim.run.runId);
    fixture.spawnCalls[1]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    const [answered] = await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: finishing.threadId });
    expect(answered?.agentRequests).toBeUndefined();
    await changedAgain();
  });

  it("shows an automation's waiting wake in its group", async () => {
    const fixture = await createFixture();
    const channel = await fixture.chat.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const wake = await fixture.chat.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "automation", displayName: "Stamp the finish date" },
      authorOwnerDisplayName: "Sam",
      automation: { automationId: "collection:Tasks#stamp", chainDepth: 1 },
      body: "Stamp today's tasks.",
    });

    await expect(fixture.service.recordTrigger(fixture.workspace, {
      triggerMessageId: wake.message.id, threadId: wake.thread.id, agentId: "default",
    })).resolves.toBe(true);

    await vi.waitFor(() => expect(fixture.agentRequestGroups).toEqual([channel.id]));
  });

  it("tells the person once when a run finishes, naming its thread", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      title: "Plan day 2",
      body: "Plan the second day.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);

    fixture.spawnCalls[0]!.process.emitExit(0);
    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.notices).toEqual([{
      workspaceId: WORKSPACE_ID,
      noticeId: `agent-run:${WORKSPACE_ID}:${claim.run.runId}`,
      kind: "agent-run",
      title: "Your agent finished in \"Plan day 2\"",
      body: "",
      target: { thread: trigger.threadId, run: claim.run.runId },
    }]);
  });

  it("reads the thread's title from its own channel, and names no thread when that read fails", async () => {
    const fixture = await createFixture();
    await createAgentThread(fixture, { title: "Plan day 2", body: "Plan it.", authorUserId: "user_local" });
    await createAgentThread(fixture, { title: "Plan day 3", body: "Plan it.", authorUserId: "user_local" });
    await activate(fixture);
    const listThreads = vi.spyOn(fixture.chat, "listThreads");
    vi.spyOn(fixture.chat, "listChannelThreads").mockRejectedValueOnce(new Error("engine busy"));

    fixture.spawnCalls[0]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    fixture.spawnCalls[1]!.process.emitExit(0);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Your agent's run produced no reply",
      "Your agent's run in \"Plan day 3\" produced no reply",
    ]);
    expect(fixture.errors).toContainEqual(expect.objectContaining({ message: "engine busy" }));
    // Neither the runner's context nor the notice reads every thread.
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("tells the person when a run fails, shortening a long thread name", async () => {
    const fixture = await createFixture();
    await createAgentThread(fixture, {
      title: `Audit ${"every file in the workspace ".repeat(5)}`,
      body: "Run a failing audit.",
      authorUserId: "user_local",
    });
    await activate(fixture);

    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const [notice] = fixture.notices;
    expect(fixture.notices).toHaveLength(1);
    expect(notice!.title).toMatch(/^Your agent's run in "Audit every file in the workspace .*…" failed$/u);
    expect([...notice!.title]).toHaveLength(120);
  });

  it("keeps the agent's own reply when the run fails without adding dohc text", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, { body: "Try this task.", authorUserId: "user_local" });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!;
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);
    const original = await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: trigger.threadId });
    const links = await fixture.dispatch.listRunMessages(WORKSPACE_ID, claim.run.runId);
    expect(original.some((message) => message.author.kind === "agent")).toBe(true);
    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(messageIds(await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: trigger.threadId })))
      .toEqual(messageIds(original));
    expect(await fixture.dispatch.listRunMessages(WORKSPACE_ID, claim.run.runId)).toEqual(links);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(fixture.notices).toHaveLength(1);
  });

  it("reports a nonzero-exit failure notice exactly once", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Run a failing audit.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");

    fixture.spawnCalls[0]!.process.emitExit(7);
    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(fixture.notices).toEqual([expect.objectContaining({
      kind: "agent-run", title: 'Your agent\'s run in "Run a failing audit." failed',
      target: { thread: trigger.threadId, run: claim.run.runId },
    })]);
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 7,
      failureHandled: true,
    });
    expect(await fixture.dispatch.listRunMessages(WORKSPACE_ID, claim.run.runId)).toEqual([]);
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

  it("releases a pre-spawn reservation when attribution teardown keeps failing", async () => {
    const teardownError = new Error("pre-spawn author clear failed");
    const contextError = new Error("thread context failed");
    let clearFailures = 0;
    const fixture = await createFixture({
      setRunAttribution: (_workspaceId, run) => {
        if (run === null && clearFailures < 2) {
          clearFailures += 1;
          throw teardownError;
        }
      },
    });
    const first = await createAgentThread(fixture, {
      body: "Fail while preparing this run.",
      authorUserId: "user_local",
    });
    const second = await createAgentThread(fixture, {
      body: "Run after teardown failed.",
      authorUserId: "user_local",
    });
    vi.spyOn(fixture.chat, "listMessagesPage").mockRejectedValueOnce(contextError);

    const activation = await activate(fixture)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(activation).toBeNull();
    expect(fixture.errors).toContain(contextError);
    expect(fixture.errors.filter((error) => error === teardownError)).toHaveLength(2);
    expect(
      fixture.readDispatch(first.messageId, first.threadId).state,
    ).toBe("failed");
    expect(fixture.service.hasLiveRun(WORKSPACE_ID), "move reservation deletion back after failClaimBeforeRun. The persistent clear failure throws first, so this assertion sees a reservation instead of the second live child.").toBe(true);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(second.threadId);
  });

  it("deadlines every daemon RPC awaited before terminal persistence", async () => {
    const fixture = await createFixture();
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
      "chats.dispatch.markFailureHandled",
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

  it("finalizes a failed run and dispatches the next claim when its notice throws", async () => {
    const noticeFailures: Error[] = [];
    const fixture = await createFixture({ noticeFailures });
    const first = await createAgentThread(fixture, {
      body: "Fail this run.",
      authorUserId: "user_local",
    });
    const second = await createAgentThread(fixture, {
      body: "Run after the failed notice.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");
    const noticeError = new Error("dispatch notice failed");
    noticeFailures.push(noticeError);

    fixture.spawnCalls[0]!.process.emitExit(7);
    await fixture.service.scanWorkspace(WORKSPACE_ID);

    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: 7,
      failureHandled: true,
    });
    expect(
      fixture.readDispatch(first.messageId, first.threadId).state,
    ).toBe("done");
    expect(fixture.errors).toContain(noticeError);
    expect(fixture.spawnCalls).toHaveLength(2);
    expect(fixture.spawnCalls[1]!.options.env.DOHC_CHAT_THREAD).toBe(second.threadId);
  });

  it("reports a failure notice when an exit-zero run produces no linked reply", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Run silently.",
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
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      exitCode: 0,
      failureHandled: true,
    });
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Your agent's run in \"Run silently.\" produced no reply",
    ]);
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
    let messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(
      messages.some((message) => message.body.includes("produced no reply")),
    ).toBe(false);
    expect(fixture.notices).toEqual([]);

    linkPending = false;
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await vi.waitFor(async () => {
      messages = await fixture.chat.listMessages({
        workspaceId: WORKSPACE_ID,
        threadId: trigger.threadId,
      });
      expect(fixture.dispatchNotices).toEqual([]);
      expect(fixture.notices.map((notice) => notice.title)).toEqual([
        "Your agent's run in \"Wait for my CLI reply provenance.\" produced no reply",
      ]);
      expect(await owedRuns(fixture)).toEqual([]);
    }, { interval: 0 });
  });

  it("posts the notice owed for a run that dohc stopped before saving its end", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Crash before this run's end is saved.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");
    // The last process owed the notice and stopped before saving the end.
    await createOwedRunNotices(() => fixture.owedRunNoticesPath).add(WORKSPACE_ID, interrupted.run.runId);

    await activate(fixture);

    expect(fixture.notices).toEqual([expect.objectContaining({
      noticeId: `agent-run:${WORKSPACE_ID}:${interrupted.run.runId}`,
      title: "Your agent's run in \"Crash before this run's end is saved.\" stopped when dohc restarted",
    })]);
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
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!ended) throw new Error("Expected a run.");
    await linkAgentReply(fixture, trigger.threadId, ended.run.runId);
    await createOwedRunNotices(() => fixture.owedRunNoticesPath).add(WORKSPACE_ID, ended.run.runId);
    await fixture.dispatch.completeRun({ runId: ended.run.runId, exitCode: 0 });

    await activate(fixture);

    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Your agent finished in \"Plan day 2\"",
    ]);
    expect(await owedRuns(fixture)).toEqual([]);
  });

  it("marks a run that ended without a reply failed when dohc stopped before checking it", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Exit quietly, then crash.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const ended = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!ended) throw new Error("Expected a run.");
    await createOwedRunNotices(() => fixture.owedRunNoticesPath).add(WORKSPACE_ID, ended.run.runId);
    await fixture.dispatch.completeRun({ runId: ended.run.runId, exitCode: 0 });

    await activate(fixture);

    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Your agent's run in \"Exit quietly, then crash.\" produced no reply",
    ]);
    expect(await fixture.dispatch.getRunRecord(ended.run.runId)).toMatchObject({ failureHandled: true });
    const [asking] = await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId: trigger.threadId });
    expect(asking?.agentRequests).toEqual([expect.objectContaining({ state: "failed", runId: ended.run.runId })]);
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
        "Your agent finished in \"Plan day 2\"",
      ]);
      expect(await owedRuns(fixture)).toEqual([]);
    }, { interval: 0 });
  });

  it("tries a notice again when its post fails", async () => {
    vi.useFakeTimers();
    // The run's end tries once, and the scan right after tries again.
    const fixture = await createFixture({
      noticeFailures: [new Error("notice store unavailable"), new Error("notice store unavailable")],
    });
    const trigger = await createAgentThread(fixture, {
      title: "Plan day 2",
      body: "Finish while notices fail once.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");
    await linkAgentReply(fixture, trigger.threadId, claim.run.runId);

    fixture.spawnCalls[0]!.process.emitExit(0);
    await vi.waitFor(() => {
      expect(fixture.errors.filter((error) => (error as Error).message === "notice store unavailable")).toHaveLength(2);
    }, { interval: 0 });
    expect(fixture.notices).toEqual([]);
    expect(await owedRuns(fixture)).toEqual([claim.run.runId]);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await vi.waitFor(async () => {
      expect(fixture.notices.map((notice) => notice.title)).toEqual([
        "Your agent finished in \"Plan day 2\"",
      ]);
      expect(await owedRuns(fixture)).toEqual([]);
    }, { interval: 0 });
  });

  it("fails an interrupted startup run and re-dispatches its trigger once", async () => {
    const attachmentId = Symbol("startup attachment");
    const fixture = await createFixture({ workspaceAttachmentId: attachmentId });
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
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");

    await activate(fixture);

    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        attachmentId,
        triggerMessageId: trigger.messageId,
        agentId: "default",
        runId: interrupted.run.runId,
      },
    ]);
    expect(await fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureHandled: true,
    });
    const retried = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    expect(retried?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.notices).toEqual([expect.objectContaining({
      noticeId: `agent-run:${WORKSPACE_ID}:${interrupted.run.runId}`,
      title: "Your agent's run in \"Resume this after restart.\" stopped when dohc restarted",
    })]);
  });

  it("recovers a restart-failed row left behind before its requeue", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Recover the persisted half of restart recovery.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!interrupted) throw new Error("Expected an interrupted run.");
    await fixture.dispatch.markFailureHandled(interrupted.run.runId);
    await fixture.dispatch.failRun({
      runId: interrupted.run.runId,
      reason: "app restart during run",
    });

    await activate(fixture);

    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        agentId: "default",
        runId: interrupted.run.runId,
      },
    ]);
    expect((await fixture.dispatch.openRuns(WORKSPACE_ID))[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
    expect(await fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureHandled: true,
      failureReason: "app restart during run",
    });
  });

  it("retains an interrupted requeue intent until the ledger transition persists", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({
      requeueFailures: [new Error("daemon unavailable during requeue")],
    });
    const trigger = await createAgentThread(fixture, {
      body: "Retry this interrupted recovery.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!interrupted) throw new Error("Expected an interrupted run.");

    fixture.service.start();
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    expect(await fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureReason: "app restart during run",
    });
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.requeues).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await vi.waitFor(
      () => {
        expect(fixture.requeues).toHaveLength(2);
        expect(fixture.spawnCalls).toHaveLength(1);
      },
      { interval: 0 },
    );

    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        agentId: "default",
        runId: interrupted.run.runId,
      },
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        agentId: "default",
        runId: interrupted.run.runId,
      },
    ]);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect((await fixture.dispatch.openRuns(WORKSPACE_ID))[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
  });

  it("retries a failed local-only scan after the daemon recovers", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    await createAgentThread(fixture, {
      body: "Dispatch after the local scan recovers.",
      authorUserId: "user_local",
    });
    vi.spyOn(fixture.serviceOptions, "readDispatchAgents").mockRejectedValueOnce(new Error("daemon restarted during scan"));

    fixture.service.start();
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toThrow("daemon restarted during scan");
    expect(fixture.spawnCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await vi.waitFor(
      () => {
        expect(fixture.spawnCalls).toHaveLength(1);
      },
      { interval: 0 },
    );

    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("backs off repeated local-only recovery scan failures", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    await createAgentThread(fixture, {
      body: "Dispatch after escalating recovery backoff.",
      authorUserId: "user_local",
    });
    vi.spyOn(fixture.serviceOptions, "readDispatchAgents")
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockRejectedValueOnce(new Error("daemon still unavailable"));

    fixture.service.start();
    await expect(
      fixture.service.scanWorkspace(WORKSPACE_ID),
    ).rejects.toThrow("daemon unavailable");

    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);
    await vi.waitFor(
      () => {
        expect(fixture.errors).toContainEqual(
          expect.objectContaining({ message: "daemon still unavailable" }),
        );
      },
      { interval: 0 },
    );
    expect(fixture.spawnCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(
      CHAT_DISPATCH_RECOVERY_BACKOFF_MS * 2 - 1,
    );
    expect(fixture.spawnCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(
      () => {
        expect(fixture.spawnCalls).toHaveLength(1);
      },
      { interval: 0 },
    );
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it("surfaces and requeues an interrupted live-backend run on desktop restart", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Recover this live-backend crash.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!interrupted || !fixture.restartDaemon) {
      throw new Error("Expected an interrupted live run and restartable daemon.");
    }

    // Rebind after the running row exists. A real fresh actor defaults to
    // reclaiming it unless EngineWorkspaceSessions explicitly opts out.
    fixture.restartDaemon();
    await activate(fixture);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(await fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({
      failureReason: "app restart during run",
      failureHandled: true,
    });
    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        agentId: "default",
        runId: interrupted.run.runId,
      },
    ]);
    expect((await fixture.dispatch.openRuns(WORKSPACE_ID))[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
  });

  it("surfaces an exhausted live-backend run without a third attempt", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Surface the exhausted live-backend crash.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const first = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!first) throw new Error("Expected a first live-backend attempt.");
    await fixture.dispatch.failRun({
      runId: first.run.runId,
      reason: "seed first failure",
    });
    expect(
      await fixture.requeueRaw({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: first.run.runId,
      }),
    ).toBe(true);
    const exhausted = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!exhausted) throw new Error("Expected a second live-backend attempt.");
    expect(exhausted.dispatch.attemptCount).toBe(2);

    await activate(fixture);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(await fixture.dispatch.getRunRecord(exhausted.run.runId)).toMatchObject({
      failureReason: "app restart during run",
      failureHandled: true,
    });
    expect(fixture.requeues).toEqual([]);
    expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]);
    expect(fixture.spawnCalls).toEqual([]);
  });

  it("does not requeue a startup run that is already the second attempt", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Do not retry this a third time.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const first = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!first) throw new Error("Expected the first attempt.");
    await fixture.dispatch.failRun({
      runId: first.run.runId,
      reason: "seed restart",
    });
    expect(
      await fixture.requeueRaw({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        runId: first.run.runId,
      }),
    ).toBe(true);
    const second = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
    if (!second) throw new Error("Expected the second attempt.");
    expect(second.dispatch.attemptCount).toBe(2);

    await activate(fixture);

    expect(fixture.requeues).toHaveLength(0);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toHaveLength(0);
  });

  it("posts and requeues a flushed app-quit run on the next startup", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Recover this clean-shutdown interruption.",
      authorUserId: "user_local",
    });
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an app-quit run.");
    await fixture.dispatch.failRun({
      runId: interrupted.run.runId,
      exitCode: APP_QUIT_EXIT_CODE,
      reason: "app-quit",
    });

    await activate(fixture);

    const messages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(messages.filter((message) => message.author.kind === "agent")).toEqual([]);
    expect(fixture.dispatchNotices).toEqual([]);
    expect(fixture.requeues).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        triggerMessageId: trigger.messageId,
        agentId: "default",
        runId: interrupted.run.runId,
      },
    ]);
    expect((await fixture.dispatch.openRuns(WORKSPACE_ID))[0]?.dispatch).toMatchObject({
      triggerMessageId: trigger.messageId,
      attemptCount: 2,
    });
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      "Your agent's run in \"Recover this clean-shutdown interruption.\" stopped when dohc quit",
    ]);
  });

  it("tells the group when an app-quit run that replied reads as failed", async () => {
    const fixture = await createFixture();
    const trigger = await createAgentThread(fixture, {
      body: "Reply, then quit.",
      authorUserId: "user_local",
    });
    const { channelId } = (await fixture.chat.getThread({
      workspaceId: WORKSPACE_ID, threadId: trigger.threadId,
    })).thread;
    await fixture.dispatch.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: trigger.messageId,
      threadId: trigger.threadId,
      agentId: "default",
    });
    const interrupted = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
      logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
    });
    if (!interrupted) throw new Error("Expected an app-quit run.");
    await linkAgentReply(fixture, trigger.threadId, interrupted.run.runId);
    await fixture.dispatch.failRun({
      runId: interrupted.run.runId,
      exitCode: APP_QUIT_EXIT_CODE,
      reason: "app-quit",
    });

    await activate(fixture);

    expect(await fixture.dispatch.getRunRecord(interrupted.run.runId)).toMatchObject({ failureHandled: true });
    expect(fixture.agentRequestGroups).toContain(channelId);
  });

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

  it("terminates an app-quit runner when persisting its failure rejects", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
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

  it("admits no scan after stop and never looks up the workspace", async () => {
    const fixture = await createFixture();
    const workspaceFor = vi.fn(fixture.serviceOptions.workspaceFor);
    const service = createChatDispatchService({ ...fixture.serviceOptions, workspaceFor });
    service.start();
    await service.stop();
    await createAgentThread(fixture, { body: "Asked while dohc quits.", authorUserId: "user_local" });
    const requests = fixture.dispatchRequests.length;

    await service.scanWorkspace(WORKSPACE_ID);

    expect(workspaceFor).not.toHaveBeenCalled();
    expect(fixture.dispatchRequests).toHaveLength(requests);
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.errors).toEqual([]);
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
        agentIdsNamedIn: async () => [],
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
      const answering = writes.answer({ workspaceId: WORKSPACE_ID, store }, {
        writer: { via: "renderer" },
        threadId: poll.thread.id,
        body: "Monday",
        resolves: { messageId: poll.message.id, chosenOption: "Monday" },
        resolveAttachments: async () => [],
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
      "Your agent's run in \"This harness will hang.\" timed out",
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

  it("retries timeout persistence for a local-only live workspace", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture({
      runner: { timeoutMinutes: 1 },
    });
    await createAgentThread(fixture, {
      body: "Persist this timeout after the daemon recovers.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
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

    const timeoutReported = Promise.withResolvers<void>();
    vi.spyOn(fixture.errors, "push").mockImplementation((...errors) => {
      const length = Array.prototype.push.apply(fixture.errors, errors);
      if (errors.some(error => error instanceof Error && error.message === "sidecar unavailable during timeout persistence")) timeoutReported.resolve();
      return length;
    });
    await vi.advanceTimersByTimeAsync(60_000);

    // Notice-file I/O precedes failRun. Join the notification before advancing recovery time.
    await timeoutReported.promise;
    expect(fixture.failRunRequests).toBe(6);
    expect(fixture.errors).toContainEqual(
      expect.objectContaining({ message: "sidecar unavailable during timeout persistence" }),
    );
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).not.toHaveProperty(
      "endedAtMs",
    );

    const updatesBeforeRetry = fixture.runUpdatedWorkspaces.length;
    const retryReported = Promise.withResolvers<void>();
    vi.spyOn(fixture.runUpdatedWorkspaces, "push").mockImplementation((...workspaces) => {
      const length = Array.prototype.push.apply(fixture.runUpdatedWorkspaces, workspaces);
      if (length === updatesBeforeRetry + 2) retryReported.resolve();
      return length;
    });
    await vi.advanceTimersByTimeAsync(CHAT_DISPATCH_RECOVERY_BACKOFF_MS);

    await retryReported.promise;
    expect(fixture.failRunRequests).toBe(7);
    expect(fixture.runUpdatedWorkspaces).toHaveLength(updatesBeforeRetry + 2);
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
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
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");

    await expect(
      fixture.service.stopAgentRun(WORKSPACE_ID, claim.run.runId),
    ).resolves.toBe(true);
    expect(fixture.killCalls).toEqual([{ pid: -process.pid!, signal: "SIGTERM" }]);
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      endedAtMs: fixture.now.value,
      exitCode: APP_QUIT_EXIT_CODE,
      failureHandled: true,
    });
    expect(
      fixture.readDispatch(trigger.messageId, trigger.threadId).state,
    ).toBe("failed");
    const stoppedMessages = await fixture.chat.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: trigger.threadId,
    });
    expect(fixture.dispatchNotices).toEqual([]);
    expect(stoppedMessages.some((message) => message.body.includes("failed (exit 143)"))).toBe(
      false,
    );
    expect(fixture.notices.map((notice) => notice.title)).toEqual([
      'Stopped the run in "Stop this run."',
    ]);
    expect(await fixture.service.dispatchStateForThread(WORKSPACE_ID, trigger.threadId)).toMatchObject({
      liveRunId: null,
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
    ).toMatchObject({ liveRunId: expect.any(String) });
  });

  it("deadlines and transport-retries the stopped-run notice fallback", async () => {
    const noticeFailures: Error[] = [];
    const fixture = await createFixture({
      noticeFailures,
      markFailureHandledFailures: [
        new EngineClientError(
          "transport-error",
          "daemon restarted while marking the stopped run",
        ),
      ],
    });
    await createAgentThread(fixture, {
      body: "Stop after the notice store fails.",
      authorUserId: "user_local",
    });
    await activate(fixture);
    const claim = (await fixture.dispatch.openRuns(WORKSPACE_ID))[0];
    if (!claim) throw new Error("Expected a live run.");
    const noticeError = new Error("dispatch notice failed");
    noticeFailures.push(noticeError);

    await expect(
      fixture.service.stopAgentRun(WORKSPACE_ID, claim.run.runId),
    ).resolves.toBe(true);

    const marks = fixture.dispatchRequests.filter(
      ({ method }) => method === "chats.dispatch.markFailureHandled",
    );
    expect(marks).toHaveLength(2);
    expect(
      marks.every(
        ({ deadlineMs }) =>
          deadlineMs === AGENT_DISPATCH_RPC_DEADLINE_MS,
      ),
    ).toBe(true);
    expect(await fixture.dispatch.getRunRecord(claim.run.runId)).toMatchObject({
      failureHandled: true,
      failureReason: "user-stop",
    });
    expect(fixture.errors).toContain(noticeError);
  });

  // Each reply form as a runner's prompt shows it, with the reply's body in place.
  function expectedReply(form: "argument" | "mcp", threadId: string, runId: string, body: string): string {
    if (form === "mcp") return `the \`dohc_reply_to_chat\` tool of the \`dohc\` MCP server with \`threadId\` \`${threadId}\` and \`runId\` \`${runId}\``;
    return `dohc chat reply ${threadId} --as-agent "${body}"`;
  }

  it.each([
    [undefined, "argument"],
    ["claude", "mcp"],
    ["codex", "mcp"],
  ] as const)("uses the %s runner's reply form", async (tool, form) => {
    const profile = tool ? { tool, executable: resolve(`test-${tool}.exe`) } : undefined;
    const fixture = await createFixture({ runner: { command: "claude -p", profile } });
    const thread = await createAgentThread(fixture, { body: "Reply." });
    await activate(fixture);
    await fixture.service.scanWorkspace(WORKSPACE_ID);
    const call = fixture.spawnCalls[0]!;
    const prompt = call.process.stdinText;
    expect(prompt).toContain(expectedReply(form, thread.threadId, call.options.env.DOHC_RUN_ID!, "<report>"));
    if (form === "mcp") expect(prompt).not.toContain("dohc chat reply");
    const instructionsFile = {
      claude: "If the workspace has a CLAUDE.md or .claude/CLAUDE.md file, or an AGENTS.md file, at its root, read them first and follow them.",
      codex: "If the workspace has an AGENTS.override.md file at its root, read it first and follow it. If it has none, do the same with an AGENTS.md file there.",
    };
    if (tool) expect(prompt).toContain(instructionsFile[tool]);
    else expect(prompt).not.toContain("AGENTS");
    if (tool !== "claude") expect(prompt).not.toContain("CLAUDE.md");
  });

  it.each(["shutdown", "occupied"])("does not start a self-test after %s during its thread write", async (reason) => {
    const fixture = await createFixture();
    const writing = deferred<void>();
    const thread = deferred<string>();
    fixture.serviceOptions.startSelfTestThread = async () => { writing.resolve(); return thread.promise; };
    const result = fixture.service.runnerSelfTest(WORKSPACE_ID);
    await writing.promise;
    if (reason === "shutdown") await fixture.service.stop();
    else fixture.serviceOptions.runSlotOccupied = () => true;
    thread.resolve("test-thread");
    await expect(result).resolves.toEqual({ ok: false, detail: reason === "shutdown" ? "Agent dispatch is stopping." : "A runner became active before the self-test could start." });
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.attributions).toEqual([]);
  });

  it.each([
    [undefined, "linux", "argument"],
    ["claude", "linux", "mcp"],
    ["claude", "win32", "mcp"],
    ["codex", "linux", "mcp"],
    ["codex", "win32", "mcp"],
  ] as const)("passes the spawn contract in a %s runner self-test on %s", async (tool, platform, form) => {
    const profile = tool ? { tool, executable: resolve(`test-${tool}.exe`) } : undefined;
    const fixture = await createFixture({
      platform,
      runner: { command: profile ? "" : "claude -p", profile },
    });

    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID);
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
        "mcp_servers.dohc.enabled_tools=['dohc_reply_to_chat']",
        "mcp_servers.dohc.tools.dohc_reply_to_chat.approval_mode='approve'",
      ].flatMap((entry) => ["--config", entry]).concat(codexRunConfig({ rootPath: fixture.workspace.rootPath, runId, platform, files: { requirements: [], config: [] } })) : ["--mcp-config", configPath]));
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
    expect(fixture.attributions.at(-1)?.run).toEqual({ agentId: "default", agentRunId: runId, depth: 0, dispatch: "self-test" });

    expect(await fixture.chat.listMessages({ workspaceId: WORKSPACE_ID, threadId })).toEqual([
      expect.objectContaining({ author: expect.objectContaining({ kind: "human" }), body: "Reply here to check the agent connection." }),
    ]);
    await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId,
      author: { kind: "agent", displayName: "Sam" },
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

  it("refuses a runner self-test on a workspace without a capture before resolving a store", async () => {
    // The self-test writes a scratch thread, so resolving the chat store
    // would open the engine for a workspace whose capture never built.
    const fixture = await createFixture({
      prepareRunWorkspaceFailures: [
        new Error("dohc could not start Chats for this workspace. Restart dohc to try again."),
      ],
    });

    await expect(fixture.service.runnerSelfTest(WORKSPACE_ID)).resolves.toEqual({
      ok: false,
      detail: "dohc could not start Chats for this workspace. Restart dohc to try again.",
    });

    expect(fixture.storeResolves).toEqual({ chat: 0, dispatch: 0 });
    expect(fixture.spawnCalls).toEqual([]);
    expect(fixture.attributions).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  it("releases the self-test run lease on every exit path", async () => {
    const fixture = await createFixture({
      temporaryRunActivity: true,
      runner: { command: "" },
    });

    await expect(fixture.service.runnerSelfTest(WORKSPACE_ID)).resolves.toEqual({
      ok: false,
      detail: "Configure a runner command first.",
    });
    expect(fixture.runActivity).toEqual({ acquires: 0, releases: 0 });

    fixture.runner.command = 'claude -p "unterminated';
    await expect(
      fixture.service.runnerSelfTest(WORKSPACE_ID),
    ).resolves.toMatchObject({ ok: false });
    expect(fixture.runActivity).toEqual({ acquires: 1, releases: 1 });

    fixture.runner.command = "claude -p";
    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID);
    await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID });
    await vi.waitFor(() => {
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.process.stdinText).toEqual(expect.any(String));
    });
    const call = fixture.spawnCalls[0]!;
    await fixture.chat.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: call.options.env.DOHC_CHAT_THREAD!,
      author: { kind: "agent", displayName: "Sam" },
      origin: "cli",
      body: `dohc-runner-self-test:${call.options.env.DOHC_RUN_ID}`,
    });
    call.process.emitExit(0);

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(fixture.runActivity).toEqual({ acquires: 2, releases: 2 });
  });

  it("times out a runner self-test and escalates the same spawned group", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();

    const resultPromise = fixture.service.runnerSelfTest(WORKSPACE_ID);
    await fixture.chat.listChannels({ workspaceId: WORKSPACE_ID });
    await vi.waitFor(
      () => {
        expect(fixture.spawnCalls).toHaveLength(1);
        expect(fixture.spawnCalls[0]!.process.stdinText).toEqual(expect.any(String));
      },
      { interval: 0 },
    );
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

    it("tells the person again when the workspace is restricted again after trust", async () => {
      const fixture = await createFixture({ restricted: true, runner: { enabled: true } });
      await createAgentThread(fixture, { body: "First request.", authorUserId: "user_local" });
      await activate(fixture);
      await trustWorkspace(fixture);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      const run = fixture.spawnCalls[0]!;
      await linkAgentReply(fixture, (await fixture.dispatch.openRuns(WORKSPACE_ID))[0]!.run.threadId, run.options.env.DOHC_RUN_ID!);
      run.process.emitExit(0);
      await vi.waitFor(async () => expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]));

      await restrictWorkspace(fixture);
      const later = await createAgentThread(fixture, { body: "Second request.", authorUserId: "user_local" });
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.dispatchNotices.map(({ notice }) => notice.threadId).at(-1)).toBe(later.threadId);
      expect(fixture.dispatchNotices).toHaveLength(2);
    });

    it("lets a restart's requeue start no agent until the workspace is trusted", async () => {
      const fixture = await createFixture({ restricted: true });
      const interrupted = await createAgentThread(fixture, { body: "Resume after restart.", authorUserId: "user_local" });
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID, triggerMessageId: interrupted.messageId, threadId: interrupted.threadId,
        agentId: "default",
      });
      const claim = await fixture.dispatch.claimNextPending(WORKSPACE_ID, {
        command: "claude -p", logPath: join(fixture.stateRoot, "run-logs", "{runId}.log"),
      });
      if (!claim) throw new Error("Expected an interrupted run.");

      await activate(fixture);

      expect(fixture.requeues).toEqual([expect.objectContaining({ triggerMessageId: interrupted.messageId })]);
      expect(fixture.spawnCalls).toEqual([]);
      expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]);

      await fixture.trust.trust(fixture.workspace);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(interrupted.threadId);
    });

    it("lets Resume start no agent until the workspace is trusted, and keeps its budget bypass", async () => {
      const fixture = await createFixture({ restricted: true });
      const paused = await createAgentThread(fixture, { body: "Paused by budget.", origin: "cli" });
      for (let index = 0; index < CHAT_DISPATCH_BUDGET_MAX; index += 1) {
        await fixture.dispatch.recordTrigger({
          workspaceId: WORKSPACE_ID, triggerMessageId: `budget_seed_${index}`, threadId: paused.threadId, agentId: "default",
        });
        const seeded = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
        if (!seeded) throw new Error("Expected a seeded budget claim.");
        await fixture.dispatch.completeRun({ runId: seeded.run.runId, exitCode: 0 });
      }
      // The person asks after the seeded runs, so no seed's claim takes the request.
      await askAgain(fixture, paused.threadId);
      await fixture.dispatch.setThreadDispatchPaused({
        workspaceId: WORKSPACE_ID, threadId: paused.threadId, paused: true, reason: "re-dispatch budget exceeded",
      });

      fixture.service.start();
      await fixture.service.resumeThreadDispatch(WORKSPACE_ID, paused.threadId);
      expect(fixture.spawnCalls).toEqual([]);
      expect(await fixture.dispatch.openRuns(WORKSPACE_ID)).toEqual([]);

      await fixture.trust.trust(fixture.workspace);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(paused.threadId);
    });

    it("answers the runner self-test with how to trust the workspace, and spawns nothing", async () => {
      const fixture = await createFixture({ restricted: true, temporaryRunActivity: true });
      await expect(fixture.service.runnerSelfTest(WORKSPACE_ID)).resolves.toEqual({
        ok: false, detail: SELF_TEST_RESTRICTED_DETAIL,
      });
      expect(fixture.spawnCalls).toEqual([]);
      expect(fixture.runActivity).toEqual({ acquires: 0, releases: 0 });
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

    it("starts a request whose workspace was restricted and trusted again between the lookup and the spawn", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: async (trust) => {
          if ((lookups += 1) !== 1) return;
          trust.revoke(WORKSPACE_ID);
          await trust.trust({ workspaceId: WORKSPACE_ID, rootPath: fixture.workspace.rootPath });
        },
      });
      const trigger = await createAgentThread(fixture, { body: "Plan day 3", authorUserId: "user_local" });

      await activate(fixture);

      // The old grant no longer holds, so the first start stops; the request
      // goes back in line and the next drain, trusted, starts it.
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.spawnCalls[0]!.options.env.DOHC_CHAT_THREAD).toBe(trigger.threadId);
      expect(fixture.readDispatch(trigger.messageId, trigger.threadId)).toMatchObject({ state: "running", attemptCount: 2 });
      expect(fixture.notices).toEqual([]);
      expect(fixture.dispatchNotices).toEqual([]);
    });

    it("leaves a request on its last attempt failed when Restricted Mode stops its start, and says so", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
      });
      const trigger = await createAgentThread(fixture, { body: "Plan day 4", authorUserId: "user_local" });
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID, triggerMessageId: trigger.messageId, threadId: trigger.threadId,
        agentId: "default",
      });
      const first = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
      if (!first) throw new Error("Expected a first attempt.");
      await fixture.dispatch.failRun({ runId: first.run.runId, reason: "app restart during run" });
      await expect(fixture.requeueRaw({
        workspaceId: WORKSPACE_ID, triggerMessageId: trigger.messageId, runId: first.run.runId,
      })).resolves.toBe(true);

      fixture.service.start();
      await fixture.service.scanWorkspace(WORKSPACE_ID);

      expect(fixture.spawnCalls).toEqual([]);
      // dohc asks; the engine allows no third attempt, so it stays failed.
      expect(fixture.requeues).toEqual([expect.objectContaining({ triggerMessageId: trigger.messageId })]);
      expect(fixture.readDispatch(trigger.messageId, trigger.threadId).state).toBe("failed");
      await vi.waitFor(() => expect(fixture.notices).toEqual([expect.objectContaining({
        title: "Your agent's run in \"Plan day 4\" did not start in Restricted Mode",
      })]));
    });

    it("stops a self-test whose workspace was restricted after the trust lookup, before it spawns", async () => {
      const fixture = await createFixture({ afterTrustLookup: (trust) => trust.revoke(WORKSPACE_ID) });
      await expect(fixture.service.runnerSelfTest(WORKSPACE_ID)).resolves.toEqual({
        ok: false, detail: SELF_TEST_RESTRICTED_DETAIL,
      });
      expect(fixture.spawnCalls).toEqual([]);
    });

    it("asks for a person's held request until the dialog opens, never for a message that asked no agent, and again after a restrict", async () => {
      const fixture = await createFixture({ restricted: true });
      fixture.service.start();
      const ask = async (body: string, origin?: "cli") => {
        const message = await createAgentThread(fixture, { body, authorUserId: "user_local", ...(origin ? { origin } : {}) });
        void fixture.service.scanWorkspace(WORKSPACE_ID);
        return await fixture.service.waitsForTrust(WORKSPACE_ID, message.messageId);
      };
      await expect(ask("From the CLI.", "cli")).resolves.toBe(false);
      await expect(ask("Mine.")).resolves.toBe(true);
      // A window that dropped that answer showed no dialog, so the next send asks.
      await expect(ask("Mine again.")).resolves.toBe(true);
      fixture.service.trustAsked(WORKSPACE_ID);
      await expect(ask("After the dialog.")).resolves.toBe(false);

      await trustWorkspace(fixture);
      await expect(ask("Trusted now.")).resolves.toBe(false);
      await restrictWorkspace(fixture);
      await expect(ask("Restricted again.")).resolves.toBe(true);
    });

    it("tells the person again after a restrict-again that came while dispatch was paused", async () => {
      const fixture = await createFixture({ restricted: true });
      const first = await createAgentThread(fixture, { body: "Held first.", authorUserId: "user_local" });
      await activate(fixture);
      expect(fixture.dispatchNotices.map(({ notice }) => notice.threadId)).toEqual([first.threadId]);

      fixture.service.setPaused(true);
      await trustWorkspace(fixture);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      await restrictWorkspace(fixture);
      fixture.service.setPaused(false);
      await fixture.service.scanWorkspace(WORKSPACE_ID);

      expect(fixture.spawnCalls).toEqual([]);
      expect(fixture.dispatchNotices).toHaveLength(2);
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
      await vi.waitFor(() => expect(fixture.notices.map((notice) => notice.title)).toEqual(['Stopped the run in "Long task."']));

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

    it("stops a running self-test when the workspace is restricted", async () => {
      const fixture = await createFixture();
      const result = fixture.service.runnerSelfTest(WORKSPACE_ID);
      await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1));
      const process = fixture.spawnCalls[0]!.process;

      fixture.trust.revoke(WORKSPACE_ID);
      const stopping = fixture.service.stopForRestrictedMode(WORKSPACE_ID);
      await vi.waitFor(() => expect(fixture.killCalls).toEqual([{ pid: -process.pid!, signal: "SIGTERM" }]));
      process.emitExit(null, "SIGTERM");
      await expect(stopping).resolves.toBeUndefined();
      await expect(result).resolves.toEqual({ ok: false, detail: SELF_TEST_RESTRICTED_DETAIL });
    });

    it("finds a timed-out self-test's runner until it exits, so a restrict cannot miss it", async () => {
      vi.useFakeTimers();
      const fixture = await createFixture();
      const result = fixture.service.runnerSelfTest(WORKSPACE_ID);
      await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1), { interval: 0 });
      await vi.advanceTimersByTimeAsync(RUNNER_SELF_TEST_TIMEOUT_MS);
      await expect(result).resolves.toMatchObject({ ok: false, detail: expect.stringContaining("timed out") });

      // The runner has had its SIGTERM and is still exiting.
      fixture.trust.revoke(WORKSPACE_ID);
      let settled = false;
      const stopping = fixture.service.stopForRestrictedMode(WORKSPACE_ID).finally(() => { settled = true; });
      const outcome = expect(stopping).rejects.toThrow(RUNNER_OUTLIVED_STOP);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(RUNNER_KILL_GRACE_MS + 1_000);
      await outcome;
    });

    it("requeues a trust-blocked start whose end failed to save, once recovery saves it", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
      });
      const trigger = await createAgentThread(fixture, { body: "Plan day 5", authorUserId: "user_local" });
      fixture.rejectNextFailRun!(new Error("daemon unavailable"));

      await activate(fixture);

      await vi.waitFor(() => {
        expect(fixture.requeues).toEqual([expect.objectContaining({ triggerMessageId: trigger.messageId })]);
      }, { timeout: 10_000 });
      await vi.waitFor(() => expect(fixture.readDispatch(trigger.messageId, trigger.threadId).state).toBe("pending"));
      // The notice owed until the requeue landed goes unseen.
      await vi.waitFor(async () => expect(await owedRuns(fixture)).toEqual([]));
      expect(fixture.notices).toEqual([]);
      await trustWorkspace(fixture);
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
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
          title: "Your agent's run in \"Plan day 6\" did not start in Restricted Mode",
        })]);
      } finally {
        await restarted.stop();
      }
    });

    it("tells the person when the engine does not requeue a trust-blocked start, whatever its attempt", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
      });
      const service = createChatDispatchService({ ...fixture.serviceOptions, requeueFailedTrigger: async () => false });
      try {
        const trigger = await createAgentThread(fixture, { body: "Plan day 7", authorUserId: "user_local" });
        service.start();
        await service.scanWorkspace(WORKSPACE_ID);
        expect(fixture.spawnCalls).toEqual([]);
        expect(fixture.readDispatch(trigger.messageId, trigger.threadId)).toMatchObject({ state: "failed", attemptCount: 1 });
        await vi.waitFor(() => expect(fixture.notices).toEqual([expect.objectContaining({
          title: "Your agent's run in \"Plan day 7\" did not start in Restricted Mode",
        })]));
      } finally {
        await service.stop();
      }
    });

    it("tells the person about a trust-blocked start when another agent the message names still waits", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        agents: [{ id: "codex", ...testAgent({ name: "Codex", launch: { command: "node codex.mjs" } }) }],
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
      });
      const service = createChatDispatchService({ ...fixture.serviceOptions, requeueFailedTrigger: async () => false });
      try {
        const general = await fixture.chat.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
        const asked = await fixture.chat.startChannelThread({
          authorActorKey: null,
          workspaceId: WORKSPACE_ID,
          channelId: general.id,
          author: { kind: "human", displayName: "Sam" },
          authorUserId: "user_local",
          namedAgentIds: ["default", "codex"],
          body: "@Nova @Codex plan day 9.",
        });
        service.start();
        await service.scanWorkspace(WORKSPACE_ID);
        expect(fixture.spawnCalls).toEqual([]);
        // One agent's start failed; the other agent's request waits for trust.
        expect(await fixture.dispatch.listPending(WORKSPACE_ID)).toEqual([
          expect.objectContaining({ triggerMessageId: asked.message.id, agentId: "default" }),
        ]);
        await vi.waitFor(() => expect(fixture.notices).toEqual([expect.objectContaining({
          title: expect.stringContaining("did not start in Restricted Mode"),
        })]));
      } finally {
        await service.stop();
      }
    });

    it("looks for held requests when a self-test's runner exits after the kill grace", async () => {
      vi.useFakeTimers();
      const fixture = await createFixture();
      const result = fixture.service.runnerSelfTest(WORKSPACE_ID);
      await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(1), { interval: 0 });
      await vi.advanceTimersByTimeAsync(RUNNER_SELF_TEST_TIMEOUT_MS);
      await expect(result).resolves.toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(RUNNER_KILL_GRACE_MS + 1_000);

      // The runner is still alive, so a request waits behind it.
      await createAgentThread(fixture, { body: "After the self-test.", authorUserId: "user_local" });
      fixture.service.start();
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);

      fixture.spawnCalls[0]!.process.emitExit(null, "SIGKILL");
      await vi.waitFor(() => expect(fixture.spawnCalls).toHaveLength(2));
    });

    it("drops the owed notice of a requeued request unseen when dohc could not drop it at once", async () => {
      let lookups = 0;
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
      });
      const runNotices = fixture.serviceOptions.runNotices!;
      let failRemove = true;
      const service = createChatDispatchService({
        ...fixture.serviceOptions,
        runNotices: {
          ...runNotices,
          owed: {
            ...runNotices.owed,
            remove: async (workspaceId, runId) => {
              if (failRemove) {
                failRemove = false;
                throw new Error("dohc stopped before it dropped the notice");
              }
              await runNotices.owed.remove(workspaceId, runId);
            },
          },
        },
      });
      try {
        const trigger = await createAgentThread(fixture, { body: "Plan day 8", authorUserId: "user_local" });
        service.start();
        await service.scanWorkspace(WORKSPACE_ID);
        // The drop failed after the requeue landed; settling the owed
        // notice finds the request back in line and drops it unseen.
        expect(failRemove).toBe(false);
        expect(fixture.readDispatch(trigger.messageId, trigger.threadId).state).toBe("pending");
        expect(await owedRuns(fixture)).toEqual([]);
        expect(fixture.notices).toEqual([]);
      } finally {
        await service.stop();
      }
    });

    it("still shows the owed notice of a request that stayed failed when a later request in its thread runs", async () => {
      let lookups = 0;
      // Posting notices fails until request B has run.
      const noticeFailures = Array.from({ length: 20 }, () => new Error("notice store unavailable"));
      const fixture = await createFixture({
        afterTrustLookup: (trust) => { if ((lookups += 1) === 1) trust.revoke(WORKSPACE_ID); },
        noticeFailures,
      });
      // Request A is on its last attempt when Restricted Mode stops it.
      const first = await createAgentThread(fixture, { body: "Plan day 9", authorUserId: "user_local" });
      await fixture.dispatch.recordTrigger({
        workspaceId: WORKSPACE_ID, triggerMessageId: first.messageId, threadId: first.threadId,
        agentId: "default",
      });
      const earlier = await fixture.dispatch.claimNextPending(WORKSPACE_ID);
      if (!earlier) throw new Error("Expected a first attempt.");
      await fixture.dispatch.failRun({ runId: earlier.run.runId, reason: "app restart during run" });
      await fixture.requeueRaw({ workspaceId: WORKSPACE_ID, triggerMessageId: first.messageId, runId: earlier.run.runId });
      fixture.service.start();
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.readDispatch(first.messageId, first.threadId).state).toBe("failed");
      expect(await owedRuns(fixture)).toHaveLength(1);

      // Once trusted, request B in the same thread runs before A's notice posts.
      await fixture.trust.trust(fixture.workspace);
      await fixture.chat.sendMessage({
        authorActorKey: null, workspaceId: WORKSPACE_ID, threadId: first.threadId,
        author: { kind: "human", displayName: "Sam" }, authorUserId: "user_local", namedAgentIds: ["default"], body: "@Nova Book the hotel.",
      });
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.spawnCalls).toHaveLength(1);
      expect(fixture.notices).toEqual([]);

      noticeFailures.length = 0;
      await fixture.service.scanWorkspace(WORKSPACE_ID);
      expect(fixture.readDispatch(first.messageId, first.threadId).state).toBe("failed");
      expect(fixture.notices).toEqual([expect.objectContaining({
        title: "Your agent's run in \"Plan day 9\" did not start in Restricted Mode",
      })]);
    });
  });
});
