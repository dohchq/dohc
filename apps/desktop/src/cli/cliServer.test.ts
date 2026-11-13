import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { createRelaySyncEngine } from "../workspaces/relaySyncEngine";
import { stripTypeScriptTypes } from "node:module";
import { makeLink as mcpMakeLink } from "@dohc/mcp/tools";
import { stageDeleteRecovery } from "../workspaces/workspaceDeleteRecovery";
import { finishMoveRecovery } from "../workspaces/workspaceMoveRecovery";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation } from "../workspaces/workspaceHistoryOperations";
import { readOperation, undoOperation } from "@dohc/mcp/tools";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createApp, importData, replyToChat, startGroupChat, writeWorkspaceFile, type ToolContext } from "../../../../packages/mcp/src/tools";
import { createActorIssuer, deriveMomentActor, parseActorKey } from "@dohc/workspace-contracts/actor-identity";
import { executeCli } from "@dohc/cli";
import { CLI_PROTOCOL_VERSION, cliTransportResponseSchema, parseCliResult, type CliLinkTarget, type CliRequest, type CliResultByVerb, type CliTransportResponse, type CliVerb } from "@dohc/cli/protocol";
import type { LinkedChatStore, VersionedTextMoment, VersionedTextMomentSummary } from "@dohc/workspace-contracts/engine";
import { CHATS_METHOD, DaemonRefusalError, type Request } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveDocumentEditAppliedError } from "../workspaces/engineYDocSessionIpc";
import type { AwaitableAgentDispatchStore } from "../agents/awaitableAgentDispatchStore";
import type { QuietRunRefusal } from "../agents/chatDispatchService";
import { createLiveAgentDispatchStore } from "../agents/liveAgentDispatchStore";
import { createChatWrites } from "../workspaces/chatWrites";
import * as chatWriteSignals from "../workspaces/chatWriteSignals";
import { deferred } from "../testing/deferred";
import { createUsageStore } from "../usage/usageStore";
import { DESKTOP_USAGE_COVERAGE } from "../usage/cliUsage";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { CLI_ENDPOINT_FILE, CLI_SOCKET_FILE, RUN_MESSAGE_LINK_RECOVERY_FILE, WATCH_BATCH_MAX_BYTES, disposeCliServerRuntime, handleCliRequestLine, resolveCliWorkspace, restoreCliServerRuntime, startCliServer, type CliCollectionWriteSeam, type CliRegistryWorkspace, type CliServerHandle, type CliServerOptions, type CliWorkspaceContext } from "./cliServer";
import { agentWriteAuthor, workspaceRequesters } from "./desktopCliServer";
import { cliMessageId, cliThreadId } from "@dohc/workspace-operations/chats";
import { openedLocalState } from "../testing/preparedLocalState";
import { agentHandle, agentYouRun, listAgents, type DesktopUserSettings } from "../settings/userSettings";
import { testAgent } from "../testing/agentSettings";

// Another spelling of one real folder, as Linux keeps it for a folder that
// ignores capitals: a lookup through `spelled` reaches `stored`, stat gives
// the same folder, and realpath returns the capitals it was given. Without an
// alias every call passes straight through.
const folderAlias = vi.hoisted(() => ({ current: null as { spelled: string; stored: string } | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { sep } = await import("node:path");
  const under = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);
  const lookup = (path: unknown) => {
    const alias = folderAlias.current;
    return alias && typeof path === "string" && under(path, alias.spelled)
      ? alias.stored + path.slice(alias.spelled.length)
      : null;
  };
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const stored = lookup(args[0]);
      const alias = folderAlias.current;
      if (stored === null || alias === null) return actual.realpath(...args);
      const real = await actual.realpath(stored);
      return under(real, alias.stored) ? alias.spelled + real.slice(alias.stored.length) : real;
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      const stored = lookup(args[0]);
      return stored === null ? actual.stat(...args) : actual.stat(stored, args[1]);
    },
  };
});

const WORKSPACE_ID = "workspace-cli-server";
type AgentRequest = Awaited<ReturnType<LinkedChatStore["listAgentRequestsPage"]>>["requests"][number];
// The secret dohc gives the process of the run it dispatched.
const RUN_SECRET = "b".repeat(64);
const SERVER_NOW_MS = Date.parse("2026-07-10T04:05:06.000Z");

type ArgsFor<Verb extends CliVerb> = Extract<CliRequest, { verb: Verb }>["args"];

interface CallCounts {
  listWorkspaces: number;
  openWorkspace: number;
  identity: number;
  writes: number;
  reads: number;
}

function momentFixtures(
  workspaceId: string,
  suffix: string,
  recordedAtMs: number,
): {
  summary: VersionedTextMomentSummary;
  detail: VersionedTextMoment;
} {
  const summary: VersionedTextMomentSummary = {
    id: `moment_${suffix}`,
    workspaceId,
    versionId: `version_${suffix}`,
    objectId: `object_${suffix}`,
    path: `${suffix}.md`,
    recordedAtMs,
    operation: "write",
    contentKind: "text",
    byteLength: suffix.length,
    metadata: {
      origin: "local-file",
      summary: `Updated ${suffix}`,
    },
    authors: [{
      kind: "agent",
      agentId: `agent_${suffix}`,
      onBehalfOf: `user_${suffix}`,
      agentRunId: `run_${suffix}`,
    }],
    momentOrder: 1,
  };
  return {
    summary,
    detail: {
      id: summary.id,
      workspaceId,
      versionId: summary.versionId,
      objectId: summary.objectId,
      path: summary.path,
      recordedAtMs,
      operation: summary.operation,
      payload: {
        before: null,
        after: {
          path: summary.path,
          contentKind: "text",
          sha256: `sha256-${suffix}`,
          byteLength: suffix.length,
          text: `# ${suffix}\n`,
        },
      },
      metadata: summary.metadata,
      authors: summary.authors,
    },
  };
}

function readSocketResponse(
  socketPath: string,
  payload: unknown,
): Promise<CliTransportResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectResponse(error);
    };

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      settled = true;
      socket.destroy();
      try {
        resolveResponse(
          cliTransportResponseSchema.parse(
            JSON.parse(buffer.slice(0, newline)) as unknown,
          ),
        );
      } catch (error: unknown) {
        rejectResponse(error instanceof Error ? error : new Error("Invalid response"));
      }
    });
    socket.once("error", rejectOnce);
    socket.once("end", () => {
      if (!settled) rejectOnce(new Error("CLI server closed without a response"));
    });
  });
}

type ThreadResult<Verb extends CliVerb> = Verb extends "show" | "chat"
  ? Exclude<CliResultByVerb[Verb], { stream: unknown }>
  : CliResultByVerb[Verb];

describe("CLI socket server", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let stateDir: string;
  let store: LinkedChatStore | null;
  let storeForWorkspace: (
    workspaceId: string,
    rootPath: string,
  ) => LinkedChatStore;
  let dispatchStore: AwaitableAgentDispatchStore;
  let sessions: EngineWorkspaceSessions | null;
  let seedDispatchThread: (threadId: string) => Promise<void>;
  let listUnreadFileThreads: NonNullable<
    CliWorkspaceContext["daemonReads"]
  >["listUnreadFileThreads"];
  let server: CliServerHandle | null;
  let token: string;
  let calls: CallCounts;
  let writeTargets: Array<{ channelId: string } | { threadId: string } | undefined>;
  let readTargets: Array<{ channelId: string } | { threadId: string } | undefined>;
  // Lets an individual test simulate what a real sync pass would have pulled,
  // or made unavailable, by the time it resolves.
  let onReadEffect: (() => Promise<void> | void) | null;
  let errors: unknown[];
  let debugLines: string[];
  let registryWorkspace: CliRegistryWorkspace;
  // The registry row the real chatWrites module reads its gates from.
  let chatRow: Pick<RegistryEntry, "remote" | "shareView" | "sharedChannels" | "shareRoster">;
  let context: CliWorkspaceContext;
  let serverOptions: CliServerOptions;
  // The chain depth of the agent run in progress in each workspace, as main
  // reports it: this one for the fixture workspace, 0 for any other.
  let agentRunDepth: number;
  // Whether a run dohc dispatched holds the fixture workspace's run slot.
  let dispatchedRun: string | null;
  // The engine's id for that run, when a test claimed one.
  let dispatchedRunId: string | null;
  // The run the fixture workspace's agent writes name, when a test set one.
  let agentWriteRunId: string | null;
  // This computer's agents: Nova and Codex, which dohc starts, and Terminal,
  // which you run.
  let agentSettings: Pick<DesktopUserSettings, "agents">;
  // The run secret each request carries: the run's, unless a test sends none
  // or another. With no run dispatched it proves nothing.
  let callerRunSecret: string | undefined;

  async function makeChannelReadOnly(channelId: string): Promise<void> {
    const channelWireId = await store!.getChannelWireId({ workspaceId: WORKSPACE_ID, channelId });
    if (!channelWireId) throw new Error("Channel has no wire id");
    chatRow.sharedChannels = [{
      shareId: "share", channelWireId, access: "read-only", granterEmail: null,
      relayUrl: "https://relay.test", recipientUserId: "verified-user-id",
    }];
  }

  // `show` and `chat` read a thread here; invokeAny also takes a group's stream.
  async function invoke<Verb extends CliVerb>(
    verb: Verb,
    args: ArgsFor<Verb>,
  ): Promise<ThreadResult<Verb>> {
    const result: unknown = await invokeAny(verb, args);
    if (typeof result === "object" && result !== null && Object.hasOwn(result, "stream")) throw new Error("expected a thread, not a stream");
    return result as ThreadResult<Verb>;
  }

  async function invokeAny<Verb extends CliVerb>(
    verb: Verb,
    args: ArgsFor<Verb>,
  ): Promise<CliResultByVerb[Verb]> {
    const response = await rawRequest({
      token,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb,
      args,
      ...(callerRunSecret === undefined ? {} : { runSecret: callerRunSecret }),
    });
    if (!response.ok) throw new Error(response.error);
    expect(response.ok).toBe(true);
    return parseCliResult(verb, response.result);
  }

  async function rawRequest(payload: unknown): Promise<CliTransportResponse> {
    if (server) return readSocketResponse(server.socketPath, payload);
    const line = await handleCliRequestLine(
      JSON.stringify(payload),
      token,
      serverOptions,
    );
    return cliTransportResponseSchema.parse(JSON.parse(line) as unknown);
  }

  async function post(input: {
    actor: "human" | "agent";
    group?: string;
    title?: string;
    body: string;
    attachments?: string[];
    needsDecision?: boolean;
    runId?: string;
  }): Promise<CliResultByVerb["post"]> {
    return invoke("post", {
      cwd: workspaceRoot,
      actor: input.actor,
      ...(input.runId ? { runId: input.runId } : {}),
      group: input.group ?? "general",
      ...(input.title ? { title: input.title } : {}),
      attachments: input.attachments ?? [],
      needsDecision: input.needsDecision ?? false,
      body: input.body,
    });
  }

  // The run dohc dispatched holds the fixture workspace's slot, and the test
  // caller is its process.
  function holdRun(runId: string, agentId = "default"): void {
    dispatchedRun = agentId;
    dispatchedRunId = runId;
  }

  beforeEach(async () => {
    tempRoot = await createTestScratch("dohc-cli-server-");
    workspaceRoot = join(tempRoot, "workspace");
    stateDir = join(tempRoot, "state");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
    ]);
    const staleEndpointArtifact = process.platform === "win32"
      ? CLI_ENDPOINT_FILE
      : CLI_SOCKET_FILE;
    await writeFile(join(stateDir, staleEndpointArtifact), "stale endpoint", "utf8");
    await writeFile(
      join(workspaceRoot, "AGENTS.md"),
      "# Workspace instructions\n\nKeep this user-owned line.\n",
      "utf8",
    );

    const idCounters = { channel: 0, message: 0, thread: 0 };
    let storeNowMs = SERVER_NOW_MS;
    let nextRunId = 0;
    let nextSeedRequestId = 1_000_000;
    const loopback = new ChatsLoopbackEngine();
    const client = {
      close: () => undefined,
      onEvent: () => () => undefined,
      async sendRequest(request: Request) {
        if (request.method === "workspace.open") {
          const params = request.params as { workspaceId?: unknown };
          return {
            id: request.id,
            result: {
              workspace: typeof params.workspaceId === "string"
                ? params.workspaceId
                : WORKSPACE_ID,
            },
          };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        const params = { ...(request.params as Record<string, unknown>) };
        if (
          request.method === CHATS_METHOD.channelCreate ||
          request.method === CHATS_METHOD.channelEnsureAgent ||
          request.method === CHATS_METHOD.channelEnsureGeneral
        ) {
          params.channelId = `channel-${++idCounters.channel}`;
          params.nowMs = (storeNowMs += 1_000);
        } else if (request.method === CHATS_METHOD.threadCreate) {
          params.threadId = `thread-${++idCounters.thread}`;
          params.nowMs = (storeNowMs += 1_000);
        } else if (request.method === CHATS_METHOD.threadStart) {
          params.threadId = `thread-${++idCounters.thread}`;
          params.messageId = `message-${++idCounters.message}`;
          params.nowMs = (storeNowMs += 1_000);
        } else if (request.method === CHATS_METHOD.messageSend) {
          params.messageId = `message-${++idCounters.message}`;
          params.nowMs = (storeNowMs += 1_000);
        }
        return await loopback.sendRequest({
          ...request,
          params: params as Request["params"],
        });
      },
    };
    sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    storeForWorkspace = (workspaceId, rootPath) =>
      createLiveLinkedChatStore({ workspaceId, rootPath }, sessions!);
    store = storeForWorkspace(WORKSPACE_ID, workspaceRoot);
    const wireRequest = async (
      workspace: string,
      method: string,
      params: Request["params"],
    ) => {
      const id = nextSeedRequestId++;
      return (await loopback.sendRequest({
        id,
        method,
        workspace,
        idempotencyKey: `cli-fixture-${id}`,
        params,
      })).result;
    };
    seedDispatchThread = async (threadId) => {
      await wireRequest(WORKSPACE_ID, CHATS_METHOD.threadCreate, {
        threadId,
        title: "Dispatch fixture thread",
        linkedFile: { objectId: `object_${threadId}` },
        nowMs: (storeNowMs += 1_000),
      });
    };
    listUnreadFileThreads = async (input) =>
      await wireRequest(
        WORKSPACE_ID,
        CHATS_METHOD.readStateListUnreadFileThreads,
        input,
      ) as Array<{
        threadId: string;
        messageCount: number;
        lastReadSequence: number;
      }>;
    dispatchStore = createLiveAgentDispatchStore(
      { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot },
      sessions,
      { createRunId: () => `run_${++nextRunId}` },
    ).store;
    await store.listChannels({ workspaceId: WORKSPACE_ID });
    registryWorkspace = { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot };
    calls = {
      listWorkspaces: 0,
      openWorkspace: 0,
      identity: 0,
      writes: 0,
      reads: 0,
    };
    chatRow = { remote: { serverUrl: "https://cloud.test", ownerUserId: "verified-user-id" } };
    writeTargets = [];
    readTargets = [];
    onReadEffect = null;
    errors = [];
    debugLines = [];
    const moments = momentFixtures(WORKSPACE_ID, "primary", SERVER_NOW_MS);

    context = {
      ...registryWorkspace,
      store,
      dispatchStore,
      readOnly: false,
      daemonReads: {
        async queryChatMessagesGranular() {
          return { results: [], saturated: true };
        },
        listUnreadFileThreads,
        collectionsWaiting: async () => false,
      },
      async fileObjectIdForPath(path) {
        return path === "tracked.md" ? "object_tracked" : null;
      },
      async filePathForObjectId(objectId) {
        return objectId === "object_tracked" ? "tracked.md" : null;
      },
      async listMoments() {
        return [moments.summary];
      },
      async readMoment(momentId) {
        return momentId === moments.detail.id ? moments.detail : null;
      },
    };
    agentRunDepth = 0;
    dispatchedRun = null;
    dispatchedRunId = null;
    agentWriteRunId = null;
    const { launch: _launch, ...terminal } = testAgent({ name: "Terminal" });
    agentSettings = { agents: { default: testAgent({ name: "Nova" }), codex: testAgent({ name: "Codex" }), terminal } };
    callerRunSecret = RUN_SECRET;
    serverOptions = {
      localPersonId: () => "person-local",
      stateDir,
      listWorkspaces() {
        calls.listWorkspaces += 1;
        return [registryWorkspace];
      },
      async openWorkspace(workspace) {
        calls.openWorkspace += 1;
        expect(workspace).toEqual(registryWorkspace);
        return context;
      },
      chatWrites: createChatWrites({
        findWorkspace: () => chatRow,
        async warmCredentials() {
          calls.identity += 1;
        },
        currentCredentials: () => ({
          serverUrl: "https://cloud.test", relayUrl: "https://relay.test",
          userId: "verified-user-id", email: "sam@test.invalid", token: "token",
        }),
        currentCredentialGeneration: () => 0,
        localUserDisplayName: () => "Sam",
        agentDisplayName: async (agentId) => listAgents(agentSettings).find(agent => agent.id === agentId)?.name ?? "Agent",
        agentIdsToWake: async (_body, dmAgentId) => dmAgentId === null ? [] : [dmAgentId],
        localInstallationId: () => "install-local-user-id",
        projectChatBookmarks: () => undefined,
        queueCloudSync: () => undefined,
        async syncSharedChannelsForChatTarget(_workspaceId, target) {
          writeTargets.push(target);
        },
        scanChatDispatch: async () => undefined,
        betweenDispatchScans: (_workspaceId, write) => write(),
        notifyRenderer: () => undefined,
      }),
      localUserDisplayName: () => "Sam",
      agentRunDepth: (workspaceId) => workspaceId === WORKSPACE_ID ? agentRunDepth : 0,
      dispatchedAgent: (workspaceId) => (workspaceId === WORKSPACE_ID ? dispatchedRun : null),
      dispatchedRunId: (workspaceId) => (workspaceId === WORKSPACE_ID ? dispatchedRunId : null),
      agentWriteRunId: (workspaceId) => (workspaceId === WORKSPACE_ID ? agentWriteRunId : null),
      dispatchedRunSecret: (workspaceId) => (workspaceId === WORKSPACE_ID && dispatchedRun !== null ? RUN_SECRET : null),
      agentRunWorkspace: (runId) => (dispatchedRun !== null && runId === dispatchedRunId ? WORKSPACE_ID : undefined),
      // As the desktop finds one: an agent you run in these settings, with
      // the accounts the fixture workspace records for its person.
      async connectedAgent(workspaceId, agentId) {
        const agent = workspaceId === WORKSPACE_ID ? agentYouRun(agentSettings, agentId) : null;
        return agent ? { agentId, name: agent.name, handle: agentHandle(agent.name), ...workspaceRequesters(chatRow) } : null;
      },
      async onWrite() {
        calls.writes += 1;
      },
      async onRead(_workspace, target) {
        calls.reads += 1;
        readTargets.push(target);
        await onReadEffect?.();
      },
      onError(error) {
        errors.push(error);
      },
      onDebug(message) {
        debugLines.push(message);
      },
      nowMs: () => SERVER_NOW_MS,
      platform: process.platform,
    };
    try {
      server = await startCliServer(serverOptions);
      token = (await readFile(server.tokenPath, "utf8")).trim();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      const sandboxDenied =
        process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" && code === "EPERM";
      if (!sandboxDenied) {
        throw error;
      }
      // The sandbox forbids every listener. Run requests through the exact
      // authenticated line handler so command/store coverage remains live.
      server = null;
      token = "a".repeat(64);
    }
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    disposeCliServerRuntime(serverOptions);
    await sessions?.closeAll();
    sessions = null;
    store = null;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("wakes for replies after the agent posts and preserves unread state", async () => {
    const root = await post({ group: "general", actor: "agent", body: "My discussion" });
    const queried = deferred<void>();
    const original = store!.listAgentRequestsPage.bind(store!);
    const spy = vi.spyOn(store!, "listAgentRequestsPage").mockImplementation(async (...args) => {
      const page = await original(...args); queried.resolve(); return page;
    });
    try {
      const pending = invoke("watch", { cwd: workspaceRoot, actor: "agent", group: "general", thread: root.threadId });
      await queried.promise;
      const reply = await invoke("reply", { cwd: workspaceRoot, actor: "human", thread: root.threadId, body: "A reply", attachments: [], needsDecision: false });
      const batch = await pending;
      expect(batch.messages.map(row => row.messageId)).toEqual([reply.messageId]);
      expect((await invoke("inbox", { cwd: workspaceRoot, actor: "agent" })).mentions.map(row => row.messageId)).toEqual([reply.messageId]);
      expect((await invoke("watch", { cwd: workspaceRoot, actor: "agent", group: "general", thread: root.threadId, cursor: batch.cursor, timeoutMs: 0 })).messages).toEqual([]);
      const later = await invoke("reply", { cwd: workspaceRoot, actor: "human", thread: root.threadId, body: "Another reply", attachments: [], needsDecision: false });
      expect((await invoke("watch", { cwd: workspaceRoot, actor: "agent", group: "general", thread: root.threadId, cursor: batch.cursor, timeoutMs: 0 })).messages.map(row => row.messageId)).toEqual([later.messageId]);
    } finally { spy.mockRestore(); }
  });

  it("narrows to a Group and thread without widening the inbox", async () => {
    const ordinary = await post({ group: "general", actor: "human", body: "An ordinary message" });
    const mentioned = await post({ group: "general", actor: "human", body: "@agent check this thread" });
    await store!.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "default", name: "Nova" });
    const dm = await post({ group: "my-agent", actor: "human", body: "Please check this DM" });
    const batch = await invoke("watch", { cwd: workspaceRoot, actor: "agent", group: "general", thread: mentioned.threadId, timeoutMs: 0 });
    expect(batch.messages.map(message => message.messageId)).toEqual([mentioned.messageId]);
    const other = await invoke("watch", { cwd: workspaceRoot, actor: "agent", thread: ordinary.threadId, timeoutMs: 0 });
    expect(other.messages).toEqual([]);
    // An agent's chat belongs to its agent, so an unnamed agent's wait skips it.
    expect((await invoke("watch", { cwd: workspaceRoot, actor: "agent", thread: dm.threadId, timeoutMs: 0 })).messages).toEqual([]);
    const changedScope = await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "watch", args: { cwd: workspaceRoot, actor: "agent", cursor: batch.cursor, timeoutMs: 0 } });
    expect(changedScope).toMatchObject({ ok: false, error: expect.stringContaining("cursor") });
  });

  it("leaves a reply for the next run when the watch times out before its read lands", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const asked = await store.startChannelThread({
      authorActorKey: null, workspaceId: WORKSPACE_ID, channelId: general.id, lane: "posts", author: { kind: "human", displayName: "Ice" }, body: "@agent pick up the card",
    });
    await dispatchStore.recordTrigger({ workspaceId: WORKSPACE_ID, threadId: asked.thread.id, triggerMessageId: asked.message.id, agentId: "default" });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, { agentId: "default" });
    if (!claim) throw new Error("Expected a run");
    holdRun(claim.run.runId);
    const blocker = await post({ group: "general", actor: "agent", runId: claim.run.runId, body: "Which date?", needsDecision: true });
    const threadId = blocker.threadId.replace(/^th_/u, "thread-");
    const [opening] = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId });
    const answer = await store.sendMessage({
      authorActorKey: null, workspaceId: WORKSPACE_ID, threadId, parentMessageId: opening!.id,
      author: { kind: "human", displayName: "Ice" }, body: "Friday",
    });
    await dispatchStore.recordTrigger({ workspaceId: WORKSPACE_ID, threadId: answer.threadId, triggerMessageId: answer.id, agentId: "default" });

    const gate = deferred<void>();
    const read = deferred<void>();
    const original = store.listAgentRequestsPage.bind(store);
    const spy = vi.spyOn(store, "listAgentRequestsPage").mockImplementation(async (...args) => {
      await gate.promise;
      const rows = await original(...args);
      read.resolve();
      return rows;
    });
    try {
      const watched = await invoke("watch", { cwd: workspaceRoot, actor: "agent", timeoutMs: 20 });
      expect(watched.messages).toEqual([]);
      gate.resolve();
      await read.promise;
      // Room for the stray read to finish whatever it would do with the reply.
      await new Promise(settle => setTimeout(settle, 100));
    } finally {
      spy.mockRestore();
    }
    await dispatchStore.completeRun({ runId: claim.run.runId, exitCode: 0 });
    expect(await dispatchStore.claimNextPending(WORKSPACE_ID, { agentId: "default" })).not.toBeNull();
  });


  it.each(["mention", "posted-thread reply"])("uses the cloud-pull wake mechanism for a %s that predates the cursor", async (kind) => {
    const first = await post({ group: "general", actor: "human", body: "@agent first" });
    // The request as the engine lists it, taken before a reply acknowledges it.
    const [current] = (await store!.listAgentRequestsPage({ workspaceId: WORKSPACE_ID, reader: { kind: "unnamed" } })).requests;
    expect(cliThreadId(current!.threadId)).toBe(first.threadId);
    if (kind === "posted-thread reply") await invoke("reply", { cwd: workspaceRoot, actor: "agent", thread: first.threadId, body: "Joining the thread", attachments: [], needsDecision: false });
    const batch = await invoke("watch", { cwd: workspaceRoot, actor: "agent", timeoutMs: 0 });
    const queried = deferred<void>();
    const original = store!.listAgentRequestsPage.bind(store!);
    const spy = vi.spyOn(store!, "listAgentRequestsPage").mockImplementation(async (...args) => {
      const page = await original(...args); queried.resolve(); return page;
    });
    try {
      const pending = invoke("watch", { cwd: workspaceRoot, actor: "agent", cursor: batch.cursor });
      await queried.promise;
      const older = { ...current!, messageId: "synced-message", createdAtMs: 0, body: kind === "mention" ? "@agent synced" : "A synced reply" };
      const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
      const start = source.indexOf("    afterSuccessfulPull: ({ recovered, applied }) => {");
      const end = source.indexOf("\n    // Recorded durably before each pull", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const dependencies = {
        workspace: { workspaceId: WORKSPACE_ID },
        signalChatWrite: chatWriteSignals.signalChatWrite,
        noticeStore: () => ({ sync: vi.fn() }),
        shareRosters: { pulled: vi.fn() }, refreshShareLabels: vi.fn(),
        automationHosts: { relayAnswered: vi.fn() }, collectionAutomationsOf: vi.fn(),
        withWorkspaceAttachment: vi.fn(),
        withWorkspaceAttachmentAsync: async (_workspace: unknown, work: () => Promise<void>) => work(),
        projectPendingChatBookmarks: vi.fn(async () => undefined),
        chatWakes: { pulled: vi.fn(async () => undefined) },
      };
      const callback = stripTypeScriptTypes(`({${source.slice(start, end)}})`);
      const afterSuccessfulPull = new Function("dependencies",
        `const { ${Object.keys(dependencies).join(", ")} } = dependencies; return ${callback}.afterSuccessfulPull;`,
      )(dependencies) as NonNullable<Parameters<typeof createRelaySyncEngine>[0]["afterSuccessfulPull"]>;
      const sync = createRelaySyncEngine({
        rootDir: workspaceRoot, relay: { baseUrl: "https://relay.test", token: "token" }, onChange: vi.fn(),
        capture: { runRelaySync: async task => task(async () => undefined), countOpenConflicts: async () => 0 } as WorkspaceEngineCapture,
        operations: {
          claim: async () => undefined,
          push: async () => ({ pushed: 0, hasMore: false, originsPushed: [], ownerAdmissionPending: [], sharingDeclined: [] }),
          recoverOrigin: async () => { throw new Error("Unexpected recovery"); },
          pull: async () => {
            spy.mockImplementation(async (...args) => {
              const page = await original(...args);
              return { ...page, requests: [older, ...page.requests] };
            });
            return { fetched: 1, applied: 1, skipped: 0, conflictsOpened: 0, fastForwardedPaths: [], nextCursor: 1, sharingDeclined: [] };
          },
        },
        afterSuccessfulPull,
      });
      try {
        await sync.start();
        expect(sync.snapshot().syncFailure).toBeNull();
        expect((await pending).messages.map(message => message.text)).toEqual([older.body]);
        // The whole hook ran: a missing dependency would throw before its last step.
        expect(dependencies.chatWakes.pulled).toHaveBeenCalledWith(expect.objectContaining({ applied: true }));
        expect(dependencies.projectPendingChatBookmarks).toHaveBeenCalledWith(WORKSPACE_ID);
      } finally { await sync.stop(); }
    } finally { spy.mockRestore(); }
  });

  describe("an agent you run", () => {
    const terminalArgs = () => ({ cwd: workspaceRoot, actor: "agent" as const, agentId: "terminal" });
    const cli = (...messages: Array<{ id: string }>) => messages.map(message => cliMessageId(message.id));
    const seenIn = (cursor: string): unknown => (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { seen: unknown }).seen;

    // A person's message from the app, stamped with the owner's account
    // unless another account, or none, is named.
    async function personPosts(channelId: string, body: string, authorUserId: string | null = "verified-user-id", wakeAgentIds?: string[]) {
      return await store!.startChannelThread({
        authorActorKey: null, workspaceId: WORKSPACE_ID, channelId, author: { kind: "human", displayName: "Sam" },
        ...(authorUserId === null ? {} : { authorUserId }), ...(wakeAgentIds ? { wakeAgentIds } : {}), body,
      });
    }

    async function personReplies(threadId: string, body: string, authorUserId: string | null = "verified-user-id") {
      return await store!.sendMessage({
        authorActorKey: null, workspaceId: WORKSPACE_ID, threadId, author: { kind: "human", displayName: "Sam" },
        ...(authorUserId === null ? {} : { authorUserId }), body,
      });
    }

    // One wait that returns at once: the agent you run with this id, or the
    // unnamed agents with null.
    async function waitFor(agentId: string | null, cursor?: string) {
      const batch = await invoke("watch", {
        cwd: workspaceRoot, actor: "agent", timeoutMs: 0,
        ...(agentId === null ? {} : { agentId }), ...(cursor === undefined ? {} : { cursor }),
      });
      return { ids: batch.messages.map(row => row.messageId), cursor: batch.cursor };
    }

    async function authorAgentIdOf(sent: { threadId: string; messageId: string }) {
      const thread = (await store!.listThreads({ workspaceId: WORKSPACE_ID })).find(row => cliThreadId(row.id) === sent.threadId)!;
      const messages = await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: thread.id });
      return messages.find(row => cliMessageId(row.id) === sent.messageId)?.authorAgentId;
    }

    // The author of each Collection write and the origin of each document
    // edit, in order.
    function recordWriteAuthors(): unknown[] {
      const authors: unknown[] = [];
      context.collections = {
        async query() {
          throw new Error("reads are not under test");
        },
        async getRecord() {
          throw new Error("reads are not under test");
        },
        writes: {
          async setFields(input) {
            authors.push(input.author);
            return { path: input.recordPath };
          },
          async createRecord(input) {
            authors.push(input.author);
            return { path: `${input.collectionPath}/${input.name}.md`, recordId: "rec_abcdefghijklmnopqrstuvwxyz" };
          },
        },
      };
      context.documents = {
        async read() {
          throw new Error("reads are not under test");
        },
        async edit(input) {
          authors.push(input.origin);
          return { path: input.path, changed: true };
        },
        async create(input) {
          authors.push(input.origin);
          return { path: input.path };
        },
      };
      return authors;
    }

    it("is named only by an agent, without a run, from this computer's agents you run", async () => {
      const send = (verb: "inbox" | "post", args: Record<string, unknown>) =>
        rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { cwd: workspaceRoot, ...args } });
      const posted = { actor: "agent", group: "general", attachments: [], needsDecision: false, body: "Hello" };
      await expect(send("inbox", { actor: "agent", agentId: "terminal" })).resolves.toMatchObject({ ok: true });
      // Nova and Codex are agents dohc starts. An id must match exactly.
      for (const agentId of ["codex", "default", "unknown", "p-terminal"]) {
        await expect(send("inbox", { actor: "agent", agentId }), agentId).resolves.toMatchObject({
          ok: false, error: expect.stringContaining("No agent you run has this id in Settings › Agents."),
        });
      }
      await expect(send("inbox", { actor: "human", agentId: "terminal" })).resolves.toMatchObject({
        ok: false, error: expect.stringContaining("Only an agent works as an agent you run."),
      });
      await expect(send("post", { ...posted, agentId: "terminal", runId: "run-elsewhere" })).resolves.toMatchObject({
        ok: false, error: expect.stringContaining("An agent you run is not a run."),
      });
      await expect(send("post", { ...posted, agentId: "terminal" })).resolves.toMatchObject({ ok: true });
      // A name with no letter or digit has no handle, so @ can't reach it.
      const { launch: _launch, ...blank } = testAgent({ name: "!!!" });
      agentSettings = { agents: { ...agentSettings.agents, blank } };
      await expect(send("inbox", { actor: "agent", agentId: "blank" })).resolves.toMatchObject({
        ok: false, error: expect.stringContaining("Give this agent a name with a letter or digit"),
      });
    });

    it("reads its chat, a mention of its name, and replies where it posted, from its person in the app", async () => {
      const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const chat = await store!.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "terminal", name: "Terminal" });
      const codexChat = await store!.ensureAgentChannel({ workspaceId: WORKSPACE_ID, agentId: "codex", name: "Codex" });
      const inChat = await personPosts(chat.id, "Hello");
      const mention = await personPosts(general.id, "Could @Terminal check this?");
      await post({ actor: "human", body: "@Terminal from the CLI" });
      await personPosts(codexChat.id, "Only for Codex");
      const codexMention = await personPosts(codexChat.id, "@Terminal, Codex is stuck");
      const own = await invoke("post", { ...terminalArgs(), group: "general", attachments: [], needsDecision: false, body: "My discussion" });
      expect(await authorAgentIdOf(own)).toBe("terminal");
      const ownThread = (await store!.listThreads({ workspaceId: WORKSPACE_ID })).find(row => cliThreadId(row.id) === own.threadId)!;
      const reply = await personReplies(ownThread.id, "A plain reply");
      await personReplies(ownThread.id, "From another account", "other-account");

      expect((await waitFor("terminal")).ids).toEqual(cli(inChat.message, mention.message, codexMention.message, reply));
      expect((await waitFor(null)).ids).toEqual([]);
      const inbox = await invoke("inbox", terminalArgs());
      expect(inbox.threads.map(thread => thread.id)).toEqual([cliThreadId(inChat.thread.id)]);
      expect(inbox.mentions.map(row => row.messageId).sort()).toEqual(cli(mention.message, codexMention.message, reply).sort());
    });

    it("counts a post with no account only in your own workspace", async () => {
      const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const yours = await personPosts(general.id, "@Terminal from you");
      const beforeSync = await personPosts(general.id, "@Terminal before sync", null);
      await personPosts(general.id, "@Terminal from another account", "other-account");
      expect((await waitFor("terminal")).ids).toEqual(cli(yours.message, beforeSync.message));

      // In a workspace shared with you, only your account's posts count.
      chatRow = { shareView: { recipientUserId: "verified-user-id" } as unknown as NonNullable<RegistryEntry["shareView"]> };
      expect((await waitFor("terminal")).ids).toEqual(cli(yours.message));
    });

    it("writes, reacts and comments as itself, in no run, while a run dohc dispatched holds the workspace", async () => {
      const authors = recordWriteAuthors();
      const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const asked = await personPosts(general.id, "Thanks, everyone");
      dispatchedRun = "codex";
      agentWriteRunId = "run-1";
      agentRunDepth = 2;

      await invoke("collectionSetFields", { ...terminalArgs(), recordPath: "tasks/a.md", fields: { status: "done" } });
      await invoke("documentEdit", { ...terminalArgs(), path: "notes/plan.md", replacement: "Done." });
      // The run's own write still names the run.
      await invoke("collectionSetFields", { cwd: workspaceRoot, actor: "agent", recordPath: "tasks/a.md", fields: { status: "parked" } });
      expect(authors).toEqual([
        { kind: "agent", agentId: "terminal", onBehalfOf: "person-local", depth: 2 },
        { actorOriginId: "terminal", attribution: { actorKind: "agent", onBehalfOf: "person-local", depth: 2 } },
        { kind: "agent", agentId: "codex", onBehalfOf: "person-local", depth: 2, agentRunId: "run-1" },
      ]);

      // A reaction carries its author's name, not an agent id.
      await invoke("react", { ...terminalArgs(), message: cliMessageId(asked.message.id), emoji: "👍" });
      expect((await store!.listReactions({ workspaceId: WORKSPACE_ID, threadId: asked.thread.id })).map(reaction => reaction.author))
        .toMatchObject([{ kind: "agent", displayName: "Terminal" }]);
      const commented = await invoke("fileChatStart", { ...terminalArgs(), path: "tracked.md", title: "Review", body: "Looks right" });
      if (!commented.ok) throw new Error(commented.reason);
      await expect(store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: commented.threadId }))
        .resolves.toMatchObject([{ authorAgentId: "terminal", author: { kind: "agent", displayName: "Terminal" } }]);
    });

    it("refuses a cursor from another reader", async () => {
      const unnamed = await waitFor(null);
      const own = await waitFor("terminal");
      expect((await waitFor("terminal", own.cursor)).ids).toEqual([]);
      expect((await waitFor(null, unnamed.cursor)).ids).toEqual([]);
      for (const args of [{ ...terminalArgs(), cursor: unnamed.cursor }, { cwd: workspaceRoot, actor: "agent", cursor: own.cursor }]) {
        expect(await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "watch", args: { ...args, timeoutMs: 0 } }))
          .toMatchObject({ ok: false, error: expect.stringContaining("This chat cursor is invalid for this agent") });
      }
    });

    it("cuts a batch at its size and keeps seen requests past the cut", async () => {
      await post({ actor: "human", body: "@agent template" });
      const [template] = (await store!.listAgentRequestsPage({ workspaceId: WORKSPACE_ID, reader: { kind: "unnamed" } })).requests;
      const request = (messageId: string, createdAtMs: number, bytes = 10): AgentRequest =>
        ({ ...template!, messageId, createdAtMs, body: "x".repeat(bytes) });
      let candidates = [request("a", 10), request("b", 11)];
      const spy = vi.spyOn(store!, "listAgentRequestsPage").mockImplementation(async () => ({ requests: candidates, more: false }));
      try {
        const first = await waitFor(null);
        expect(first.ids).toEqual([cliMessageId("a"), cliMessageId("b")]);
        // Two large requests arrive with older times. Together they pass the
        // size, so the second waits for the next call.
        const large = Math.ceil(WATCH_BATCH_MAX_BYTES * 0.6);
        candidates = [request("x", 1, large), request("y", 2, large), request("a", 10), request("b", 11)];
        const second = await waitFor(null, first.cursor);
        expect(second.ids).toEqual([cliMessageId("x")]);
        expect(seenIn(second.cursor)).toEqual([[10, "a"], [11, "b"], [1, "x"]]);
        const third = await waitFor(null, second.cursor);
        expect(third.ids).toEqual([cliMessageId("y")]);
        expect((await waitFor(null, third.cursor)).ids).toEqual([]);
      } finally { spy.mockRestore(); }
    });
  });

  it("confines Access to the registered workspace and schema-parses every answer without secret fields", async () => {
    const secret = { credentials: "secret", bearerUrl: "secret", invitationUrl: "secret", shareCode: "secret" };
    const answer = { ...secret, ref: { kind: "path", path: "Notes/a.md", versionId: null }, rows: [], visibility: "visible",
      unknownReason: null, coverage: { kind: "granted", complete: true, observation: "interval", ...secret }, checkedAtMs: 1, freshness: "stale", nextCursor: null };
    const object = vi.fn(async () => answer as never), sharing = vi.fn(async () => ({ ...answer, ref: null }) as never);
    context.access = { object, sharing, refresh: vi.fn() }; context.readOnly = true;
    const response = await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessObject",
      args: { cwd: workspaceRoot, actor: "agent", ref: { kind: "path", path: "Notes/a.md" } } });
    expect(response).toMatchObject({ ok: true, result: { freshness: "stale", coverage: { complete: true } } });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(object).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ref: { kind: "path", path: "Notes/a.md", versionId: null } }));
    for (const args of [
      { cwd: workspaceRoot, actor: "agent", lane: "received", workspaceId: "other" },
      { cwd: workspaceRoot, actor: "agent", ref: { kind: "path", path: "a.md", workspaceId: "other" } },
    ]) expect(await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessSharing", args })).toMatchObject({ ok: false });
    expect(sharing).not.toHaveBeenCalled();
    expect(await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessObject",
      args: { cwd: workspaceRoot, actor: "agent", ref: { kind: "path", path: "../outside.md" } } })).toMatchObject({ ok: false });
    expect(object).toHaveBeenCalledOnce();
  });


  it("links a Group, thread, message, and path through the CLI and MCP, and refuses a read-only workspace", async () => {
    const made: unknown[] = [];
    context.makeWorkReference = async target => {
      if (target.kind === "documentCollection") throw new Error("not a Collection");
      const path = target.kind === "file" && "path" in target ? target.path : undefined;
      if (path === "missing.md") throw new Error("work-target-not-found");
      if (path === "stopped.md") throw new Error("The workspace engine is not running.");
      made.push(target);
      return String(made.length).padStart(43, "R");
    };
    const started = await post({ actor: "agent", title: "Flights", body: "Book by Friday" });
    const general = (await invoke("groups", { cwd: workspaceRoot, actor: "agent" })).groups.find(group => group.slug === "general")!;
    const link = (target: CliLinkTarget) => invoke("link", { cwd: workspaceRoot, actor: "agent", target });
    await expect(link({ kind: "group", group: "general" })).resolves.toEqual({
      reference: "R".repeat(42) + "1", link: `@[work:${"R".repeat(42)}1]`, kind: "chat",
    });
    expect((await link({ kind: "thread", thread: started.threadId })).kind).toBe("thread");
    expect((await link({ kind: "message", message: started.messageId })).kind).toBe("message");
    await mkdir(join(workspaceRoot, "plans"), { recursive: true });
    await writeFile(join(workspaceRoot, "plans", "trip.md"), "# Trip");
    expect((await invoke("link", { cwd: join(workspaceRoot, "plans"), actor: "agent", target: { kind: "path", path: "trip.md" } })).kind).toBe("file");
    // The CLI names chats by short ids; links name them by their engine ids.
    expect(general.id).toBe("ch_1");
    expect(made).toEqual([
      { kind: "chat", channelId: expect.stringMatching(/^channel-/u) },
      { kind: "thread", threadId: expect.stringMatching(/^thread-/u) },
      { kind: "message", messageId: expect.stringMatching(/^message-/u) },
      { kind: "file", path: "plans/trip.md" },
    ]);
    await expect(link({ kind: "message", message: "no-such-message" })).rejects.toThrow();
    // Only a path the engine cannot find is missing; another failure says what it is.
    await expect(link({ kind: "path", path: "missing.md" })).rejects.toThrow("dohc could not find missing.md");
    await expect(link({ kind: "path", path: "stopped.md" })).rejects.toThrow("The workspace engine is not running.");
    await expect(link({ kind: "path", path: "../outside.md" })).rejects.toThrow("path rejected (traversal)");

    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: value => invoke(value.verb, value.args) };
    await expect(mcpMakeLink(ctx, { group: "general" })).resolves.toMatchObject({ kind: "chat", link: `@[work:${"R".repeat(42)}5]` });
    await expect(mcpMakeLink(ctx, { group: "general", thread: started.threadId })).resolves.toEqual({
      ok: false, reason: "Pass exactly one of group, thread, message, and path.",
    });

    context.readOnly = true; registryWorkspace.readOnly = true;
    await expect(link({ kind: "group", group: "general" })).rejects.toThrow("This workspace is read-only. Make links in the owning workspace.");
  });

  it("records once after a pending command settles and excludes concurrent and later request-id replays", async () => {
    const recordSuccess = vi.fn();
    serverOptions.recordSuccess = recordSuccess;
    const entered = deferred(); const release = deferred();
    const edit = vi.fn(async () => { entered.resolve(); await release.promise; return { path: "a.md", changed: true }; });
    context.documents = { edit, read: async () => ({ path: "a.md", markdown: "x" }), create: async () => ({ path: "a.md" }) };
    const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, door: "mcp", verb: "documentEdit",
      args: { cwd: workspaceRoot, actor: "agent", path: "a.md", replacement: "PRIVATE", requestId: "edit" } };
    const first = rawRequest(request); await entered.promise;
    const replay = rawRequest({ ...request, door: "cli" });
    expect(recordSuccess).not.toHaveBeenCalled();
    release.resolve();
    const results = await Promise.all([first, replay]);
    expect(results[0]).toEqual(results[1]);
    expect(await rawRequest(request)).toEqual(results[0]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(recordSuccess.mock.calls).toEqual([[{ capabilityId: "document.edit", door: "mcp" }]]);
  });

  it("stops both socket doors immediately when Off begins, including pending completions", async () => {
    const usage = createUsageStore({ stateDir: () => stateDir, appVersion: "0.1.0", coverage: DESKTOP_USAGE_COVERAGE });
    try {
      await usage.load();
      serverOptions.recordSuccess = invocation => usage.recordSuccess(invocation);
      const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "saveKeptCopy", args: { cwd: workspaceRoot, actor: "agent", id: 1 } };
      const entered = deferred(); const release = deferred();
      context.keptCopies = {
        list: async () => ({ keptCopies: [], more: false }),
        save: async () => ({ status: "saved", path: "kept.md" }),
        restoreProtected: async () => ({ path: ".env", status: "restored" }),
        discardProtected: async () => ({ path: ".env", status: "discarded" }),
      };
      await rawRequest({ ...request, door: "cli" });
      const save = context.keptCopies.save;
      context.keptCopies.save = async () => { entered.resolve(); await release.promise; return save(1); };
      const pending = rawRequest({ ...request, door: "mcp" }); await entered.promise;
      const off = usage.setEnabled(false);
      release.resolve(); await pending;
      await rawRequest({ ...request, door: "cli" });
      await rawRequest({ ...request, door: "mcp" });
      await off;
      expect((await usage.read()).counts.map(({ capabilityId, door, count }) => ({ capabilityId, door, count })))
        .toEqual([{ capabilityId: "file.kept.save", door: "cli", count: 1 }]);
    } finally { await usage.close(); }
  });

  it("rejects a wrong token over the live transport before request parsing", async (ctx) => {
    if (!server) ctx.skip();
    calls.listWorkspaces = 0;
    const rejectedToken = `${token.startsWith("0") ? "1" : "0"}${token.slice(1)}`;
    const response = await rawRequest({
      token: rejectedToken,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "post",
      args: {
        cwd: workspaceRoot,
        malformed: "Must not be parsed",
      },
    });

    expect(response).toEqual({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: CLI authentication failed",
    });
    expect(calls.listWorkspaces).toBe(0);
    expect(calls.openWorkspace).toBe(0);
    expect(calls.identity).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it("receives a 256 KiB file through the socket and preserves partial batch results", async () => {
    if (!server) throw new Error("This test requires the CLI socket.");
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>(async files => ({ ok: true, written: files.map(file => file.path) }));
    context.writeFiles = writeFiles;
    const args = { cwd: workspaceRoot, actor: "agent" as const, requestId: "large", files: [{ path: "large.txt", contentBase64: Buffer.alloc(256 * 1024, 97).toString("base64") }] };
    expect(await invoke("fileWrite", args)).toEqual({ ok: true, written: ["large.txt"] });
    expect(writeFiles.mock.calls[0]?.[0][0]?.contentBase64).toBe(args.files[0]!.contentBase64);
    const partial = { ok: false as const, written: ["1.txt", "2.txt"], path: "3.txt", reason: "Disk full. Free space and retry." };
    writeFiles.mockResolvedValueOnce(partial);
    expect(await invoke("fileWrite", { ...args, requestId: "batch", files: [1, 2, 3, 4, 5].map(n => ({ path: n + ".txt", contentBase64: "eA==" })) })).toEqual(partial);
  });

  it("keeps all MCP file writes relative to a subfolder cwd", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    await writeFile(join(workspaceRoot, "index.html"), "root file");
    await writeFile(join(cwd, "source.csv"), "name\nPat\n");
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>(async files => {
      for (const file of files) {
        const absolute = join(workspaceRoot, file.path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, Buffer.from(file.contentBase64, "base64"));
      }
      return { ok: true, written: files.map(file => file.path) };
    });
    context.writeFiles = writeFiles;
    const ctx: ToolContext = { root: cwd, home: stateDir, request: request => invoke(request.verb, request.args) };
    expect(await writeWorkspaceFile(ctx, { path: "index.html", content: "subfolder file" })).toMatchObject({ ok: true, path: "index.html" });
    expect(await createApp(ctx, { appRoot: "site" })).toMatchObject({ ok: true, appRoot: "site" });
    expect(await importData(ctx, { sourcePath: "source.csv", databasePath: "people.sqlite", tableName: "people" })).toMatchObject({ ok: true, path: "people.sqlite" });
    expect(await readFile(join(workspaceRoot, "index.html"), "utf8")).toBe("root file");
    expect(await readFile(join(cwd, "index.html"), "utf8")).toBe("subfolder file");
    expect(writeFiles.mock.calls.map(([files]) => files.map(file => file.path))).toEqual([
      ["app/index.html"], expect.arrayContaining(["app/site/index.html"]), ["app/people.sqlite"],
    ]);
    expect(writeFiles.mock.calls.flatMap(([files]) => files).every(file => file.path.startsWith("app/"))).toBe(true);
    await expect(stat(join(cwd, "site/index.html"))).resolves.toBeDefined();
    await expect(stat(join(cwd, "people.sqlite"))).resolves.toBeDefined();
    writeFiles.mockResolvedValueOnce({ ok: false, written: ["app/partial/index.html"], path: "app/partial/styles.css", reason: "Cannot write app/partial/styles.css: disk full. Free space." });
    expect(await createApp(ctx, { appRoot: "partial" })).toEqual({
      ok: false, written: ["partial/index.html"], path: "partial/styles.css", reason: "Cannot write partial/styles.css: disk full. Free space.",
    });
  });


  it("duplicates through CLI with agent authority, request replay, and path floors", async () => {
    const duplicateFile = vi.fn<NonNullable<CliWorkspaceContext["duplicateFile"]>>(async () => ({ok: true, path: "copy.md", materialized: true, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", undo: {available: true}}));
    context.duplicateFile = duplicateFile;
    const args = {cwd: workspaceRoot, actor: "agent" as const, path: "source.md", requestId: "duplicate-once"};
    expect(await invoke("fileDuplicate", args)).toMatchObject({ok: true});
    expect(await invoke("fileDuplicate", args)).toMatchObject({ok: true});
    expect(duplicateFile).toHaveBeenCalledOnce();
    expect(await executeCli({argv: ["file", "duplicate", "source.md", "--json"], cwd: workspaceRoot, request: request => invoke(request.verb, request.args)})).toMatchObject({exitCode: 0});
    duplicateFile.mockClear();
    expect(await invoke("fileDuplicate", {...args, actor: "human"})).toMatchObject({ok: false});
    for (const path of ["../escape.md", ".env", ".dohc/private.md"]) expect(await invoke("fileDuplicate", {...args, path, requestId: path})).toMatchObject({ok: false});
    context.readOnly = true;
    expect(await invoke("fileDuplicate", {...args, requestId: "readonly"})).toMatchObject({ok: false});
    expect(duplicateFile).not.toHaveBeenCalled();
  });

  it("undoes a move through socket, CLI and MCP with one compensation", async () => {
    const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
    await writeFile(join(workspaceRoot, "a.txt"), "move body");
    const plan = await stageDeleteRecovery(operationId, join(workspaceRoot, "a.txt"), "a.txt", ["a.txt"]);
    await rename(join(workspaceRoot, "a.txt"), join(workspaceRoot, "b.txt"));
    await openedLocalState({ workspaceId: WORKSPACE_ID, rootPath: workspaceRoot });
    await finishMoveRecovery({ workspaceId: WORKSPACE_ID, rootPath: workspaceRoot }, plan, "a.txt", "b.txt", false);
    const history = { resolveFiles: vi.fn(async () => ({versionId: "main", results: []})),readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),  readHistoryPage: vi.fn(async () => ({ moments: [{ momentId: "move", operation: "rename", path: "b.txt", beforePath: "a.txt" }], nextCursor: null }) as never),
      undoHistoryOperation: vi.fn(async () => { await rename(join(workspaceRoot, "b.txt"), join(workspaceRoot, "a.txt"));
        return { operationId, versionId: "main", deduped: false, materialized: true, momentCount: 1, notRestored: [], compensationOperationId: operationId }; }) };
    const operation = { workspace: { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot, get readOnly() { return context.readOnly; }, shareView: undefined as unknown }, signal: new AbortController().signal, assertCurrent: vi.fn() };
    context.historyOperation = input => readWorkspaceHistoryOperation(operation, input, history, {agent: true});
    context.historyUndo = (input, origin) => undoWorkspaceHistoryOperation(operation, input, agentWriteAuthor(origin), { history, agent: true });
    const args = { cwd: workspaceRoot, actor: "agent" as const, operationId };
    const restored = { ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [] };
    expect(await invoke("historyUndo", args)).toEqual(restored);
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: request => invoke(request.verb, request.args) };
    expect(await undoOperation(ctx, { operationId })).toEqual(restored);
    expect(await readOperation(ctx, { operationId })).toMatchObject({ ok: true, members: [{ operation: "rename" }] });
    expect(await executeCli({ argv: ["history", "undo", operationId], cwd: workspaceRoot, request: request => invoke(request.verb, request.args) }))
      .toEqual({ exitCode: 0, stdout: "History: restored\n", stderr: "" });
    expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("move body");
    expect(history.undoHistoryOperation).toHaveBeenCalledOnce();
    context.historyUndo = vi.fn(context.historyUndo);
    const unexplained = { refusal: { code: "unexplained" } };
    expect(await invoke("historyUndo", { ...args, actor: "human" }))
      .toEqual({ ok: false, reason: 'An Undo through the CLI socket is recorded as an agent\'s; send actor "agent".', ...unexplained });
    expect(context.historyUndo).not.toHaveBeenCalled();
    for (const verb of ["historyOperation", "historyUndo"] as const) {
      expect(await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { ...args, operationId: operationId.slice(15) } })).toMatchObject({ ok: false });
      context.readOnly = true;
      // Only an Undo's refusal names its cause.
      expect(await invoke(verb, args)).toEqual({ ok: false, reason: "History operations require the owning workspace. Open it to continue.",
        ...(verb === "historyUndo" ? unexplained : {}) });
      context.readOnly = false; operation.workspace.shareView = {};
      expect(await invoke(verb, args)).toMatchObject({ ok: false });
      operation.workspace.shareView = undefined;
      await mkdir(join(workspaceRoot, "shared-with-me"), { recursive: true });
      expect(await invoke(verb, { ...args, cwd: join(workspaceRoot, "shared-with-me") })).toMatchObject({ ok: false });
    }
  });

  // #3089: a move of a live page waits up to the guard's limit, well inside the request's deadline.

  it.each(["fileMove", "fileDelete"] as const)("keeps host paths out of %s failures", async verb => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const absolute = join(workspaceRoot, "private.txt");
    const error = Object.assign(new Error("EACCES: realpath '" + absolute + "'"), { code: "EACCES", syscall: "realpath" });
    context.movePath = async () => { throw error; };
    context.deletePath = async () => { throw error; };
    const args = { cwd, actor: "agent" as const, requestId: "private" };
    const result = verb === "fileMove" ? await invoke(verb, { ...args, fromPath: "a", toPath: "b" })
      : await invoke(verb, { ...args, path: "a" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("EACCES") });
    expect(JSON.stringify(result)).not.toContain(workspaceRoot);
    context.movePath = async () => { throw new Error("Failed at host=" + absolute + "."); };
    context.deletePath = async () => { throw new Error("Failed at host=" + absolute + "."); };
    const unstructured = verb === "fileMove" ? await invoke(verb, { ...args, fromPath: "a", toPath: "b" })
      : await invoke(verb, { ...args, path: "a" });
    expect(JSON.stringify(unstructured)).not.toContain(workspaceRoot);
  });

  it("refuses a raw move or delete from a person, through traversal, or in a read-only view", async () => {
    const movePath = vi.fn<NonNullable<CliWorkspaceContext["movePath"]>>();
    const deletePath = vi.fn<NonNullable<CliWorkspaceContext["deletePath"]>>();
    context.movePath = movePath;
    context.deletePath = deletePath;
    const base = { cwd: workspaceRoot, requestId: "raw" };
    expect(await invoke("fileMove", { ...base, actor: "human", fromPath: "a.txt", toPath: "b.txt" })).toMatchObject({ ok: false, reason: expect.stringContaining('send actor "agent"') });
    expect(await invoke("fileDelete", { ...base, actor: "human", path: "a.txt" })).toMatchObject({ ok: false, reason: expect.stringContaining('send actor "agent"') });
    expect(await invoke("fileMove", { ...base, actor: "agent", fromPath: "a.txt", toPath: "../b.txt" })).toMatchObject({ ok: false, reason: expect.stringContaining("traversal") });
    expect(await invoke("fileDelete", { ...base, actor: "agent", path: "../a.txt" })).toMatchObject({ ok: false, reason: expect.stringContaining("traversal") });
    registryWorkspace = { ...registryWorkspace, readOnly: true };
    context.readOnly = true;
    await expect(invoke("fileDelete", { ...base, actor: "agent", path: "a.txt" })).rejects.toThrow("read-only");
    expect(movePath).not.toHaveBeenCalled();
    expect(deletePath).not.toHaveBeenCalled();
  });

  // shared-with-me holds what others share with you, inside your own workspace.
  describe("from inside a folder others share with you", () => {
    const OWNER = "dohc: This command isn't available in a folder others share with you. Run it from your own workspace's folder.";
    const CHAT = "dohc: Chat isn't available from the command line in a folder others share with you. Run this command from your own workspace's folder.";
    let inShare: string;
    const send = (verb: CliVerb, args: Record<string, unknown>) =>
      rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { cwd: inShare, actor: "agent", ...args } });

    beforeEach(async () => {
      inShare = join(workspaceRoot, "shared-with-me", "received", "notes");
      await mkdir(inShare, { recursive: true });
    });

    it("refuses the commands for your workspace as its owner, before opening it", async () => {
      // Every port these commands use, so a command that got through would reach one.
      const reached = vi.fn(async () => { throw new Error("reached"); });
      const port = new Proxy({}, { get: () => reached });
      Object.assign(context, { stopSync: reached, shareCopy: reached, shareLinkAgents: port, keptCopies: port, retainedCopies: port,
        ownerAppResponses: reached, dataset: reached, appPublication: reached });
      const ownerCommands: Array<[CliVerb, Record<string, unknown>]> = [
        ["stopSync", { actor: "human" }],
        ["shareCopy", { shareId: "share", grantId: "grant" }],
        ["shareAgents", { shareId: "share", grantId: "grant" }],
        ["shareDisconnect", { shareId: "share", grantId: "grant", connectionId: "connection" }],
        ["keptCopies", {}],
        ["saveKeptCopy", { id: 1 }],
        ["retainedCopies", {}],
        ["deleteRetainedCopies", { copies: [{ id: 3, revision: 10 }], acceptLateWriteRisk: true }],
        ["ownerAppResponses", { request: { action: "list", workspaceId: WORKSPACE_ID, grantId: "g", limit: 100 } }],
        ["dataset", { request: { action: "list", workspaceId: WORKSPACE_ID } }],
        ["dataset", { request: { action: "prepareRecovery", workspaceId: WORKSPACE_ID, sourcePath: workspaceRoot } }],
        ["dataset", { request: { action: "cancelInvoke", workspaceId: WORKSPACE_ID, invocationId: "00000000-0000-4000-8000-000000000003" } }],
        ["appPublication", { request: { action: "cancel", workspaceId: WORKSPACE_ID, approvalId: "00000000-0000-4000-8000-000000000001" } }],
      ];
      for (const cwd of [inShare, join(workspaceRoot, "shared-with-me")]) {
        for (const [verb, args] of ownerCommands) {
          expect(await send(verb, { cwd, ...args }), verb).toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: OWNER });
        }
      }
      expect(reached).not.toHaveBeenCalled();
      expect(calls.openWorkspace).toBe(0);
    });

    it("refuses chat commands, and shows a Group with --peek", async () => {
      const chatCommands: Array<[CliVerb, Record<string, unknown>]> = [
        ["groupCreate", { name: "needs-ice" }],
        ["post", { actor: "human", group: "general", attachments: [], needsDecision: false, body: "hello" }],
        ["reply", { actor: "human", thread: "thread-1", body: "hello", attachments: [], needsDecision: false }],
        ["nothingToReport", { thread: "thread-1" }],
        ["react", { actor: "human", message: "message-1", emoji: "👍" }],
        ["chatRetry", { thread: "thread-1" }],
        ["fileChatStart", { path: "a.md", title: "About a", body: "hello" }],
        ["show", { target: "general", peek: false }],
        ["export", { actor: "human", scope: { kind: "all" }, outDir: "inside-export" }],
        ["watch", { timeoutMs: 0 }],
        ["link", { target: { kind: "group", group: "general" } }],
        ["link", { target: { kind: "path", path: "a.md" } }],
      ];
      for (const cwd of [inShare, join(workspaceRoot, "shared-with-me")]) {
        for (const [verb, args] of chatCommands) {
          expect(await send(verb, { cwd, ...args }), verb).toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: CHAT });
        }
      }
      expect(calls.openWorkspace).toBe(0);
      expect(await send("show", { target: "general", peek: true })).toMatchObject({ ok: true });
    });

    // The rule reads the folder a link leads to, as choosing the workspace does.
    it("refuses from a link outside shared-with-me that leads into a share's folder", async () => {
      const reached = vi.fn(async () => { throw new Error("reached"); });
      Object.assign(context, { stopSync: reached, dataset: reached });
      const outside = await mkdtemp(join(tmpdir(), "dohc-link-"));
      try {
        // Windows makes a junction without privilege; elsewhere it is a symlink.
        const links = [join(workspaceRoot, "into-share"), join(outside, "into-share")];
        for (const link of links) await symlink(inShare, link, "junction");
        const linked = join(outside, "linked-into-share");
        try { await symlink(inShare, linked, "dir"); links.push(linked); } catch (error) {
          // Windows makes a folder symlink only with Developer Mode or as an administrator.
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
        for (const cwd of links) {
          expect(await send("stopSync", { cwd, actor: "human" }), cwd).toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: OWNER });
          expect(await send("dataset", { cwd, request: { action: "list", workspaceId: WORKSPACE_ID } }), cwd)
            .toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: OWNER });
          expect(await send("post", { cwd, actor: "human", group: "general", attachments: [], needsDecision: false, body: "hello" }), cwd)
            .toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: CHAT });
          expect(await send("watch", { cwd, timeoutMs: 0 }), cwd).toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: CHAT });
        }
        expect(reached).not.toHaveBeenCalled();
        expect(calls.openWorkspace).toBe(0);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });


  it("refuses a fileWrite envelope larger than 14 MiB before opening the workspace", async () => {
    if (!server) throw new Error("This test requires the CLI socket.");
    const opened = calls.openWorkspace;
    const response = await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite",
      args: { cwd: workspaceRoot, actor: "agent", requestId: "oversized", files: [{ path: "large.txt", contentBase64: "A".repeat(14 * 1024 * 1024) }] } });
    expect(response).toMatchObject({ ok: false, error: "dohc: CLI request exceeds 14 MiB. Split the files into smaller batches." });
    expect(calls.openWorkspace).toBe(opened);
  });

  it("refuses owner and chat commands in a received share opened as its own workspace", async () => {
    registryWorkspace = { ...registryWorkspace, readOnly: true };
    context.readOnly = true;
    const reached = vi.fn(async () => { throw new Error("reached"); });
    Object.assign(context, { stopSync: reached, shareCopy: reached, shareLinkAgents: new Proxy({}, { get: () => reached }),
      ownerAppResponses: reached, dataset: reached, appPublication: reached });
    const folder = join(workspaceRoot, "notes", "deeper");
    await mkdir(folder, { recursive: true });
    const send = (cwd: string, verb: CliVerb, args: Record<string, unknown>) =>
      rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { cwd, actor: "agent", ...args } });
    const ownerCommands: Array<[CliVerb, Record<string, unknown>, string]> = [
      ["stopSync", { actor: "human" }, "Open the owning workspace to stop its sync."],
      ["shareCopy", { shareId: "share", grantId: "grant" }, "Share copy details require the owning workspace."],
      ["shareAgents", { shareId: "share", grantId: "grant" }, "Open the owning workspace to list a link's agents."],
      ["shareDisconnect", { shareId: "share", grantId: "grant", connectionId: "connection" }, "Open the owning workspace to disconnect a link's agent."],
      ["ownerAppResponses", { request: { action: "list", workspaceId: WORKSPACE_ID, grantId: "g", limit: 100 } }, "App responses require the owning workspace."],
      ["dataset", { request: { action: "list", workspaceId: WORKSPACE_ID } }, "Collections require the owning workspace."],
      ["dataset", { request: { action: "prepareRecovery", workspaceId: WORKSPACE_ID, sourcePath: workspaceRoot } }, "Collections require the owning workspace."],
      ["dataset", { request: { action: "describe", workspaceId: WORKSPACE_ID, datasetPath: "tasks/dataset.json" } }, "Collections require the owning workspace."],
      ["appPublication", { request: { action: "cancel", workspaceId: WORKSPACE_ID, approvalId: "00000000-0000-4000-8000-000000000001" } },
        "App publication requires the owning workspace."],
      ["appPublication", { request: { action: "createLink", workspaceId: WORKSPACE_ID, appRoot: "app", access: "view",
        operationId: "00000000-0000-4000-8000-000000000101", agentLabel: "Builder" } }, "App publication requires the owning workspace."],
    ];
    const chatCommands: Array<[CliVerb, Record<string, unknown>]> = [
      ["groupCreate", { name: "needs-ice" }],
      ["post", { actor: "human", group: "general", attachments: [], needsDecision: false, body: "hello" }],
      ["reply", { actor: "human", thread: "thread-1", body: "hello", attachments: [], needsDecision: false }],
      ["react", { actor: "human", message: "message-1", emoji: "👍" }],
      ["chatRetry", { thread: "thread-1" }],
      ["fileChatStart", { path: "a.md", title: "About a", body: "hello" }],
      ["show", { target: "general", peek: false }],
      ["export", { actor: "human", scope: { kind: "all" }, outDir: "inside-export" }],
      ["watch", { timeoutMs: 0 }],
    ];
    for (const cwd of [workspaceRoot, folder]) {
      for (const [verb, args, error] of ownerCommands) {
        expect(await send(cwd, verb, args), verb).toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: `dohc: ${error}` });
      }
      for (const [verb, args] of chatCommands) {
        expect(await send(cwd, verb, args), verb)
          .toEqual({ protocolVersion: CLI_PROTOCOL_VERSION, ok: false, error: "dohc: chats are not available in a read-only shared view" });
      }
    }
    expect(reached).not.toHaveBeenCalled();
  });

  it("requires owner-local authority and refuses all automation publication actions", async () => {
    context.appPublication=vi.fn(async()=>({kind:"cancelled" as const}));
    const request={action:"createLink" as const,workspaceId:WORKSPACE_ID,appRoot:"app",access:"view" as const,operationId:"00000000-0000-4000-8000-000000000101",agentLabel:"Builder"};
    await invoke("appPublication",{cwd:workspaceRoot,actor:"human",request});
    expect(context.appPublication).toHaveBeenLastCalledWith(request,null);
    await invoke("appPublication",{cwd:workspaceRoot,actor:"agent",request});
    expect(context.appPublication).toHaveBeenLastCalledWith(expect.objectContaining({agentLabel:"Builder"}),{kind:"agent",label:"Builder",labelSource:"agent-declared"});
    await expect(invoke("appPublication",{cwd:workspaceRoot,actor:"agent",request:{...request,workspaceId:"other"}})).rejects.toThrow("owning workspace");
    context.readOnly=true;
    await expect(invoke("appPublication",{cwd:workspaceRoot,actor:"agent",request})).rejects.toThrow("owning workspace");
    context.readOnly=false;agentRunDepth=1;
    for (const actor of ["human", "agent"] as const) {
      await expect(invoke("appPublication",{cwd:workspaceRoot,actor,request})).rejects.toThrow("Automations cannot use app publication");
      await expect(invoke("appPublication",{cwd:workspaceRoot,actor,request:{action:"cancel",workspaceId:WORKSPACE_ID,approvalId:request.operationId}})).rejects.toThrow("Automations cannot use app publication");
    }
    expect(context.appPublication).toHaveBeenCalledTimes(2);
  });

  it("writes a random capability endpoint descriptor for a Windows named pipe", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    if (!server) ctx.skip();

    const descriptorPath = join(stateDir, CLI_ENDPOINT_FILE);
    const describedEndpoint = (await readFile(descriptorPath, "utf8")).trim();

    expect(describedEndpoint).toBe(server!.socketPath);
    expect(describedEndpoint).toMatch(/^\\\\\.\\pipe\\dohc-cli-[a-f0-9]{32,}$/u);
    expect(describedEndpoint).not.toContain(stateDir);
    expect(describedEndpoint).not.toBe(join(stateDir, CLI_SOCKET_FILE));
  });

  it("scopes every MCP-shaped verb to the cwd workspace", async () => {
    if (!store) throw new Error("Store is not available");
    const scopedWorkspaceId = "workspace-cli-scoped";
    const scopedRoot = join(workspaceRoot, "scoped");
    await mkdir(scopedRoot, { recursive: true });
    const scopedWorkspace: CliRegistryWorkspace = {
      workspaceId: scopedWorkspaceId,
      rootPath: scopedRoot,
    };
    const primaryGeneral = await store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: primaryGeneral.id,
      title: "Primary-only channel chat",
      author: { kind: "human", displayName: "Primary" },
      body: "Must not leak",
    });
    const scopedStore = storeForWorkspace(scopedWorkspaceId, scopedRoot);
    const scopedGeneral = await scopedStore.ensureGeneralChannel({
      workspaceId: scopedWorkspaceId,
    });
    const scopedChannelChat = await scopedStore.startChannelThread({
      authorActorKey: null,
      workspaceId: scopedWorkspaceId,
      channelId: scopedGeneral.id,
      title: "Scoped channel chat",
      author: { kind: "human", displayName: "Scoped" },
      body: "Visible only in scoped workspace",
    });
    const scopedFileThread = await scopedStore.createThread({
      workspaceId: scopedWorkspaceId,
      title: "Scoped file chat",
      linkedFile: {
        objectId: "object_scoped",
        pathHint: "scoped.md",
      },
    });
    await scopedStore.sendMessage({
      authorActorKey: null,
      workspaceId: scopedWorkspaceId,
      threadId: scopedFileThread.id,
      author: { kind: "human", displayName: "Scoped" },
      body: "Scoped file message",
    });
    const scopedMoments = momentFixtures(
      scopedWorkspaceId,
      "scoped",
      SERVER_NOW_MS + 1,
    );
    const scopedContext: CliWorkspaceContext = {
      ...context,
      ...scopedWorkspace,
      store: scopedStore,
      dispatchStore: createLiveAgentDispatchStore(scopedWorkspace, sessions!).store,
      async fileObjectIdForPath(path) {
        return path === "scoped.md" ? "object_scoped" : null;
      },
      async filePathForObjectId(objectId) {
        return objectId === "object_scoped" ? "scoped.md" : null;
      },
      async listMoments() {
        return [scopedMoments.summary];
      },
      async readMoment(momentId) {
        return momentId === scopedMoments.detail.id
          ? scopedMoments.detail
          : null;
      },
    };
    serverOptions.listWorkspaces = () => [registryWorkspace, scopedWorkspace];
    serverOptions.openWorkspace = async (workspace) => {
      calls.openWorkspace += 1;
      return workspace.workspaceId === scopedWorkspaceId
        ? scopedContext
        : context;
    };

    const moments = await invoke("moments", {
      cwd: scopedRoot,
      actor: "agent",
    });
    expect("changes" in moments && moments.changes.map((change) => change.path)).toEqual(["scoped.md"]);
    await expect(invoke("moment", {
      cwd: scopedRoot,
      actor: "agent",
      id: scopedMoments.detail.id,
    })).resolves.toMatchObject({
      ok: true,
      change: { path: "scoped.md" },
    });
    await expect(invoke("fileChats", {
      cwd: scopedRoot,
      actor: "agent",
      path: "scoped.md",
    })).resolves.toMatchObject({
      ok: true,
      fileObjectId: "object_scoped",
      threads: [{ id: scopedFileThread.id }],
    });
    await expect(invoke("chat", {
      cwd: scopedRoot,
      actor: "agent",
      threadId: scopedFileThread.id,
    })).resolves.toMatchObject({
      ok: true,
      thread: { id: scopedFileThread.id },
      projection: { text: expect.stringContaining("scoped.md") },
    });
    const channels = await invoke("groupsFull", {
      cwd: scopedRoot,
      actor: "agent",
    });
    expect(channels).toMatchObject({
      ok: true,
      groups: [{
        id: scopedGeneral.id,
        threads: [{ id: scopedChannelChat.thread.id }],
      }],
    });
    expect(
      channels.ok
        ? channels.groups.flatMap((channel) =>
            channel.threads.map((thread) => thread.title)
          )
        : [],
    ).not.toContain("Primary-only channel chat");

    const started = await invoke("post", {
      cwd: scopedRoot,
      actor: "agent",
      group: scopedGeneral.id,
      attachments: [],
      needsDecision: false,
      body: "Scoped opening",
    });
    const startedThread = (await scopedStore.listChannelThreads({
      workspaceId: scopedWorkspaceId,
      channelId: scopedGeneral.id,
    })).find((summary) => cliThreadId(summary.thread.id) === started.threadId)?.thread;
    if (!startedThread) throw new Error("Scoped opening is not in the scoped store");
    const replied = await invoke("reply", {
      cwd: scopedRoot,
      actor: "agent",
      thread: startedThread.id,
      attachments: [],
      needsDecision: false,
      body: "Scoped reply",
    });
    expect(replied).toMatchObject({ threadId: started.threadId });
    expect(
      (await store.listThreads({ workspaceId: WORKSPACE_ID }))
        .map((thread) => thread.id),
    ).not.toContain(startedThread.id);
    expect(await scopedStore.listMessages({
      workspaceId: scopedWorkspaceId,
      threadId: startedThread.id,
    })).toHaveLength(2);
  });

  it("refuses an agent's post through the CLI and through MCP that links a file the Group's share does not cover", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const channelWireId = await store.getChannelWireId({ workspaceId: WORKSPACE_ID, channelId: general.id });
    if (!channelWireId) throw new Error("Channel has no wire id");
    chatRow.shareRoster = {
      grants: [{
        granterUserId: "verified-user-id", granterEmail: null, subjectName: null, sharerName: null,
        shareId: "share-general", grantId: "grant-general", generation: 1, status: "active",
        recipientUserId: "peer-user-id", recipientEmail: null,
        selector: { kind: "group", channelWireId, paths: ["team"], versionId: null },
        access: "read-write", fileScope: "served",
      }],
      links: [], formerGrants: [], endedGrants: [], version: 1, listedAtMs: SERVER_NOW_MS,
    };
    const refusal = "This Group's share doesn't include finance/budget.md. Remove the link or share the file first.";
    await expect(post({ actor: "agent", title: "Budget", body: "See @[finance/budget.md]" })).rejects.toThrow(refusal);
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: (value) => invoke(value.verb, value.args) };
    await expect(startGroupChat(ctx, { group: "general", title: "Budget", body: "See @[finance/budget.md]" }))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining(refusal) });
    expect(await store.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: general.id })).toEqual([]);
    const existing = await store.startChannelThread({
      authorActorKey: null, workspaceId: WORKSPACE_ID, channelId: general.id,
      author: { kind: "human", displayName: "Sam" }, body: "Plans",
    });
    await expect(replyToChat(ctx, { threadId: existing.thread.id, body: "And @[finance/budget.md]" }))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining(refusal) });
    expect(await store.listMessages({ workspaceId: WORKSPACE_ID, threadId: existing.thread.id })).toHaveLength(1);
  });

  // Only the run itself says it has nothing to report, and the chat's own
  // service decides whether it may.
  describe("nothing to report", () => {
    async function automationThread() {
      const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      return (await store!.startChannelThread({
        authorActorKey: null, workspaceId: WORKSPACE_ID, channelId: general.id,
        author: { kind: "automation", displayName: "Check overdue tasks" }, authorOwnerDisplayName: "Sam",
        automation: { automationId: "collection:Tasks#overdue", chainDepth: 1 }, body: "Tell the Group about overdue tasks.",
      })).thread.id;
    }

    function quietRuns(refusal: QuietRunRefusal | null = null): string[] {
      const asked: string[] = [];
      serverOptions.chatRuns = {
        dispatchStateForThread: async () => { throw new Error("Not read for nothing to report."); },
        retryStoppedRun: async () => false,
        endRunQuietly(workspaceId, runId, threadId) {
          asked.push(`${workspaceId}/${runId}/${threadId}`);
          return refusal;
        },
      };
      return asked;
    }

    it("refuses a caller that isn't the run, and says why the service refused", async () => {
      const asked = quietRuns();
      const threadId = await automationThread();
      holdRun("run-quiet");
      callerRunSecret = "c".repeat(64);
      await expect(invoke("nothingToReport", { cwd: workspaceRoot, actor: "agent", thread: cliThreadId(threadId), runId: "run-quiet" }))
        .rejects.toThrow("Only a running agent run that an automation started can end with nothing to report.");
      callerRunSecret = undefined;
      await expect(invoke("nothingToReport", { cwd: workspaceRoot, actor: "agent", thread: cliThreadId(threadId) }))
        .rejects.toThrow("Only a running agent run that an automation started can end with nothing to report.");
      expect(asked).toEqual([]);

      callerRunSecret = RUN_SECRET;
      quietRuns("person");
      await expect(invoke("nothingToReport", { cwd: workspaceRoot, actor: "agent", thread: cliThreadId(threadId) }))
        .rejects.toThrow("A person asked for this run. Reply to them.");
      quietRuns("other-thread");
      await expect(invoke("nothingToReport", { cwd: workspaceRoot, actor: "agent", thread: cliThreadId(threadId) }))
        .rejects.toThrow("Send nothingToReport in the thread this run was started for.");
    });
  });

  it("answers the automation verbs from the Automations panel's calls", async () => {
    const AUTOMATION = "collection:object-tasks#stamp";
    const trigger = { kind: "changed" as const, recordId: "rec_1", by: "agent" as const, sharedAuthor: null, depth: 1 };
    const field = { kind: "field" as const, recordId: "rec_1", path: "tasks/one.md", field: "Done", before: null, after: "2026-09-27" };
    const run = {
      claimId: "atc_1", state: "failed" as const, error: "The record is open elsewhere.", createdAtMs: 1, updatedAtMs: 2,
      trigger, definitionChanged: true, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false,
    };
    const retries: unknown[] = [];
    const answers: Array<Awaited<ReturnType<NonNullable<CliWorkspaceContext["automations"]>["retry"]>>> = [
      { status: "definition-changed", repeatsMessages: true },
      { status: "queued", press: false },
      {
        status: "refused",
        reason: "Only the computer this run failed on can try it again. The notice names that computer.",
        notice: { title: 'Automation "Stamp" failed', body: "The record is open elsewhere. It ran on Laptop." },
      },
    ];
    context.automations = {
      automationIdAt: vi.fn(async (collectionPath: string, id: string) => (collectionPath === "tasks" ? `collection:object-tasks#${id}` : null)),
      runs: vi.fn(async (_automationId: string, _before?: string) => ({
        runs: [{ ...run, writes: [field, { kind: "created" as const, recordId: "rec_2", path: "tasks/two.md" }] }],
        next: "1:atc_1",
      })),
      run: vi.fn(async (_automationId: string, claimId: string) =>
        claimId === "atc_1" ? { ...run, findMs: 12, planMs: 0, writeMs: 30, writeCount: 1,
          steps: [{ step: 2, writes: [field] }], failedStep: 3, startsOver: true } : null),
      serverRuns: vi.fn(), serverRun: vi.fn(),
      retry: vi.fn(async (input) => {
        retries.push(input);
        return answers.shift()!;
      }),
    };
    const args = { cwd: workspaceRoot, actor: "agent" as const, collectionPath: "tasks", automation: "stamp" };

    await expect(invoke("automationRuns", args)).resolves.toEqual({
      ok: true,
      runs: [{
        run: "atc_1", state: "failed", error: "The record is open elsewhere.", createdAtMs: 1, updatedAtMs: 2,
        trigger, definitionChanged: true, neverStarted: false, chainStopped: false, undone: false, changes: 2,
      }],
      next: "1:atc_1",
    });
    expect(context.automations!.runs).toHaveBeenCalledWith(AUTOMATION, undefined);
    // The next page names where the last one ended.
    await invoke("automationRuns", { ...args, page: "1:atc_1" });
    expect(context.automations!.runs).toHaveBeenLastCalledWith(AUTOMATION, "1:atc_1");
    await expect(invoke("automationRun", { ...args, run: "atc_1" })).resolves.toMatchObject({
      ok: true,
      run: { run: "atc_1", trigger, findMs: 12, planMs: 0, writeMs: 30, writeCount: 1,
        steps: [{ step: 2, changes: [field] }], failedStep: 3, startsOver: true },
    });
    await expect(invoke("automationRun", { ...args, run: "atc_9" })).resolves.toEqual({
      ok: false,
      reason: "This computer has no run atc_9 of this automation. Each computer keeps the runs of the automations it ran.",
    });

    const refused = await invoke("automationRetry", { ...args, run: "atc_1", startOver: false });
    expect(refused).toMatchObject({ ok: false, status: "definition-changed", repeatsMessages: true });
    expect("reason" in refused && refused.reason).toContain("This automation changed since the run failed.");
    expect("reason" in refused && refused.reason).toContain("Posts, direct messages, and notices it already sent may be sent again.");
    await expect(invoke("automationRetry", { ...args, run: "atc_1", startOver: true })).resolves.toEqual({ ok: true, status: "queued" });
    expect(retries).toEqual([
      { automationId: AUTOMATION, claimId: "atc_1", startOver: false },
      { automationId: AUTOMATION, claimId: "atc_1", startOver: true },
    ]);
    // Another computer's run is refused with the notice that names that computer.
    await expect(invoke("automationRetry", { ...args, run: "atc_1", startOver: false })).resolves.toEqual({
      ok: false,
      reason: "Only the computer this run failed on can try it again. The notice names that computer.",
      notice: { title: 'Automation "Stamp" failed', body: "The record is open elsewhere. It ran on Laptop." },
    });

    await expect(invoke("automationRuns", { ...args, collectionPath: "../tasks" })).resolves.toMatchObject({ ok: false });
    context.readOnly = true;
    await expect(invoke("automationRetry", { ...args, run: "atc_1", startOver: true })).resolves.toEqual({
      ok: false,
      reason: "Run history is unavailable through shares. Each host keeps the runs it made.",
    });
    expect(retries).toHaveLength(3);
  });




  it("presses a button through the press path and reports the run, asking before actions dohc cannot undo", async () => {
    const presses: Array<Parameters<NonNullable<CliWorkspaceContext["buttons"]>["press"]>[0]> = [];
    const actions = [{ name: "sendInvoice", label: "Send invoice" }];
    const pressedBy: unknown[] = [];
    context.buttons = { inspect: vi.fn(async () => []),
      press: vi.fn(async (input, by) => {
        presses.push(input);
        pressedBy.push(by);
        if (input.field === "Send" && !input.confirm.includes("sendInvoice")) return { result: { confirm: actions }, waiting: null };
        if (input.field === "Busy") return { result: { busy: true as const, reason: "Running for this record." }, waiting: null };
        if (input.collectionPath === "shared") return { result: { busy: false as const, relayed: true as const }, waiting: null };
        return { result: { busy: false as const, claimId: "atc_1", settled: null }, waiting: "roster" as const };
      }),
    };
    const args = { cwd: workspaceRoot, actor: "agent" as const, collectionPath: "tasks", field: "Mark paid", record: "rec_1", confirm: [] };
    await expect(invoke("automationButtons", { cwd: workspaceRoot, actor: "agent", collectionPath: "shared" })).resolves.toEqual({ ok: true, buttons: [] });
    expect(context.buttons.inspect).toHaveBeenCalledWith({ collectionPath: "shared" }, expect.objectContaining({ kind: "agent" }));

    await expect(invoke("automationPress", args)).resolves.toEqual({
      ok: true, run: "atc_1", outcome: null, error: null, waiting: "Waiting to check who can edit this Collection.",
    });
    await expect(invoke("automationPress", { ...args, field: "Send" })).resolves.toEqual({
      ok: false,
      reason: 'This press runs actions dohc cannot undo: "Send invoice" (--confirm sendInvoice). Confirm each by name to run them.',
      confirm: actions,
    });
    await expect(invoke("automationPress", { ...args, field: "Send", confirm: ["sendInvoice"] })).resolves.toMatchObject({ ok: true, run: "atc_1" });
    await expect(invoke("automationPress", { ...args, field: "Busy" })).resolves.toEqual({ ok: false, reason: "Running for this record." });

    // The same request id answers the same press without pressing again, and refuses another request.
    const pressed = presses.length;
    const first = await invoke("automationPress", { ...args, requestId: "press-1" });
    await expect(invoke("automationPress", { ...args, requestId: "press-1" })).resolves.toEqual(first);
    expect(presses).toHaveLength(pressed + 1);
    await expect(invoke("automationPress", { ...args, collectionPath: "billing", requestId: "press-1" })).resolves.toEqual({
      ok: false, reason: "request id press-1 was already used for a different request",
    });
    // After a restart forgets the request, the request id is still the press's key, which the executor's press id comes from.
    const restart = async () => {
      await server?.close();
      serverOptions = { ...serverOptions };
      if (server) {
        server = await startCliServer(serverOptions);
        token = (await readFile(server.tokenPath, "utf8")).trim();
      }
    };
    await restart();
    await invoke("automationPress", { ...args, requestId: "press-1" });
    await restart();
    await invoke("automationPress", { ...args, collectionPath: "billing", requestId: "press-1" });
    expect([presses[pressed]!, ...presses.slice(-2)].map((press) => [press.collectionPath, press.pressKey]))
      .toEqual([["tasks", "press-1"], ["tasks", "press-1"], ["billing", "press-1"]]);
    // A press with no request id gets a key of its own.
    await invoke("automationPress", args);
    await invoke("automationPress", args);
    const [one, two] = presses.slice(-2).map((press) => press.pressKey);
    expect(one).not.toBe(two);
    // A press refused for its question is not remembered, so the same id can confirm it.
    await expect(invoke("automationPress", { ...args, field: "Send", requestId: "press-3" })).resolves.toMatchObject({ ok: false });
    await expect(invoke("automationPress", { ...args, field: "Send", confirm: ["sendInvoice"], requestId: "press-3" }))
      .resolves.toMatchObject({ ok: true, run: "atc_1" });
    expect(presses[0]).toMatchObject({ collectionPath: "tasks", field: "Mark paid", recordId: "rec_1", confirm: [] });

    // The press is the agent's, as a collection write through the socket is: named as dohc-mcp, at its run's depth.
    expect(pressedBy[0]).toEqual({ kind: "agent", originId: "dohc-mcp", depth: 0 });
    await invoke("automationPress", { ...args, actor: "human" });
    expect(pressedBy.at(-1)).toEqual({ kind: "human" });
    // A run an automation started presses at its depth, whatever actor the caller names, so the chain cap counts it.
    agentRunDepth = 2;
    await invoke("automationPress", { ...args, actor: "human" });
    expect(pressedBy.at(-1)).toEqual({ kind: "agent", originId: "dohc-mcp", depth: 2 });
    agentRunDepth = 0;
    const count = presses.length;
    await expect(invoke("automationPress", { ...args, collectionPath: "shared-with-me/tasks" })).resolves.toMatchObject({ ok: false });
    expect(presses).toHaveLength(count);
    // A shared view's press goes the app's relayed way.
    context.readOnly = true;
    await expect(invoke("automationPress", { ...args, collectionPath: "shared" })).resolves.toEqual({ ok: true, relayed: true });
  });

  it("routes collection writes through the write seam with a server-derived author", async () => {
    const seamCalls: Array<
      | { kind: "setFields"; input: Parameters<CliCollectionWriteSeam["setFields"]>[0] }
      | { kind: "createRecord"; input: Parameters<CliCollectionWriteSeam["createRecord"]>[0] }
    > = [];
    context.collections = {
      async query() {
        throw new Error("reads are not under test");
      },
      async getRecord() {
        throw new Error("reads are not under test");
      },
      writes: {
        async setFields(input) {
          seamCalls.push({ kind: "setFields", input });
          return { path: input.recordPath };
        },
        async createRecord(input) {
          seamCalls.push({ kind: "createRecord", input });
          return {
            path: `${input.collectionPath}/${input.name}.md`,
            recordId: "rec_abcdefghijklmnopqrstuvwxyz",
          };
        },
      },
    };

    await expect(invoke("collectionSetFields", {
      cwd: workspaceRoot,
      actor: "agent",
      agent: "Codex",
      recordPath: "tasks/a.md",
      fields: { status: "done", notes: null },
    })).resolves.toEqual({ ok: true, recordPath: "tasks/a.md" });
    await expect(invoke("collectionCreateRecord", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
      name: "write-brief",
      fields: { status: "open" },
    })).resolves.toEqual({
      ok: true,
      recordId: "rec_abcdefghijklmnopqrstuvwxyz",
      recordPath: "tasks/write-brief.md",
    });
    // A person edits records in the app. Through the socket, a record write is
    // an agent's, refused as a document write is.
    await expect(invoke("collectionSetFields", {
      cwd: workspaceRoot,
      actor: "human",
      recordPath: "tasks/a.md",
      fields: { status: "parked" },
    })).resolves.toEqual({ ok: false, reason: "a document edit through the CLI socket is recorded as an agent's; send actor \"agent\"" });
    await expect(invoke("collectionCreateRecord", {
      cwd: workspaceRoot,
      actor: "human",
      collectionPath: "tasks",
      name: "by-hand",
      fields: {},
    })).resolves.toEqual({ ok: false, reason: "a document created through the CLI socket is recorded as an agent's; send actor \"agent\"" });

    expect(seamCalls).toEqual([
      {
        kind: "setFields",
        input: {
          recordPath: "tasks/a.md",
          fields: { status: "done", notes: null },
          // A Collection edit doesn't record the name yet.
          author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", depth: 0 },
        },
      },
      {
        kind: "createRecord",
        input: {
          collectionPath: "tasks",
          name: "write-brief",
          fields: { status: "open" },
          author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", depth: 0 },
        },
      },
    ]);
  });



  it("lists and deletes old file copies for an agent only with the late-write risk accepted", async () => {
    let copies = [{ id: 3, revision: 10 }, { id: 4, revision: 11 }];
    const deleted: { id: number; revision: number }[][] = [];
    context.retainedCopies = {
      async list() {
        return { copies, more: false, total: { count: copies.length, bytes: copies.length * 1024 } };
      },
      async delete(requested) {
        deleted.push([...requested]);
        copies = copies.filter(copy => !requested.some(gone => gone.id === copy.id));
        return { deleted: requested.length, skipped: 0, failed: 0, remaining: { count: copies.length, bytes: copies.length * 1024 } };
      },
    };

    await expect(invoke("retainedCopies", { cwd: workspaceRoot, actor: "agent" })).resolves.toEqual({
      ok: true,
      copies: [{ id: 3, revision: 10 }, { id: 4, revision: 11 }],
      more: false,
      total: { count: 2, bytes: 2048 },
    });
    for (const args of [
      { cwd: workspaceRoot, actor: "agent", copies: [{ id: 3, revision: 10 }] },
      { cwd: workspaceRoot, actor: "agent", copies: [{ id: 3, revision: 10 }], acceptLateWriteRisk: false },
      { cwd: workspaceRoot, actor: "agent", copies: Array.from({ length: 101 }, (_, id) => ({ id, revision: 0 })), acceptLateWriteRisk: true },
    ]) {
      const response = await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "deleteRetainedCopies", args });
      expect(response.ok, JSON.stringify(args).slice(0, 80)).toBe(false);
    }
    expect(deleted).toEqual([]);
    await expect(invoke("deleteRetainedCopies", {
      cwd: workspaceRoot, actor: "agent", copies: [{ id: 3, revision: 10 }], acceptLateWriteRisk: true,
    })).resolves.toEqual({ ok: true, deleted: 1, skipped: 0, failed: 0, remaining: { count: 1, bytes: 1024 } });
    expect(deleted).toEqual([[{ id: 3, revision: 10 }]]);

    delete context.retainedCopies;
    const unavailable = { ok: false, reason: "Old file copies are kept only in the owning workspace. Open it to continue." };
    await expect(invoke("retainedCopies", { cwd: workspaceRoot, actor: "agent" })).resolves.toEqual(unavailable);
    await expect(invoke("deleteRetainedCopies", {
      cwd: workspaceRoot, actor: "agent", copies: [{ id: 4, revision: 11 }], acceptLateWriteRisk: true,
    })).resolves.toEqual(unavailable);
  });


  it("says why sync stopped in the person's words, with the engine's detail", async () => {
    const sentences = "Changes from another computer are waiting on the conflict in plan.md. They reached a limit, so dohc stopped receiving changes. Resolve the conflict to receive changes again.";
    const detail = `DaemonRefusalError: conflict-wait-limit: ${sentences} (path plan.md, origin device-d seq 7, retained ops 1, retained bytes 536870912)`;
    const failures = [{ cause: "unknown" as const, detail, sinceMs: 1, attempts: 2 }, null];
    context.syncFailure = () => failures.shift() ?? null;
    await expect(invoke("syncFailure", { cwd: workspaceRoot, actor: "agent" }))
      .resolves.toEqual({ ok: true, syncFailure: { code: "conflict-wait-limit", message: sentences, detail } });
    await expect(invoke("syncFailure", { cwd: workspaceRoot, actor: "agent" }))
      .resolves.toEqual({ ok: true, syncFailure: null });
    // Only the original workspace reads its sync, as with kept edits and
    // History: a received share's folder, any folder in it, and a shared view.
    const refused = { ok: false, reason: "Sync status is kept only in the original workspace. Open it to continue." };
    const read = vi.fn(() => ({ cause: "unknown" as const, detail, sinceMs: 1, attempts: 2 }));
    context.syncFailure = read;
    await mkdir(join(workspaceRoot, "shared-with-me", "received", "notes"), { recursive: true });
    for (const cwd of [join(workspaceRoot, "shared-with-me"), join(workspaceRoot, "shared-with-me", "received", "notes")]) {
      await expect(invoke("syncFailure", { cwd, actor: "agent" })).resolves.toEqual(refused);
    }
    context.readOnly = true;
    await expect(invoke("syncFailure", { cwd: workspaceRoot, actor: "agent" })).resolves.toEqual(refused);
    context.readOnly = false;
    expect(read).not.toHaveBeenCalled();
    // The desktop's own check for a shared view's marker refuses too.
    context.syncFailure = () => { throw new Error("This is a shared view — only the original workspace can be shared."); };
    await expect(invoke("syncFailure", { cwd: workspaceRoot, actor: "agent" })).resolves.toMatchObject({ ok: false });
  });

  it("rebases MCP document and Collection paths from a subfolder and returns caller paths", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const documents = new Map([["notes.md", "Root"], ["app/notes.md", "Subfolder"]]);
    context.documents = {
      async read(path) { return { path, markdown: documents.get(path) ?? "Missing" }; },
      async edit({ path, edit }) { documents.set(path, edit.replacement); return { path, changed: true }; },
      async create({ path, markdown }) { documents.set(path, markdown); return { path }; },
    };
    await expect(invoke("documentRead", { cwd, actor: "agent", path: "notes.md" })).resolves.toEqual({ ok: true, path: "notes.md", markdown: "Subfolder" });
    await expect(invoke("documentEdit", { cwd, actor: "agent", path: "notes.md", replacement: "Edited" })).resolves.toEqual({ ok: true, path: "notes.md", changed: true });
    await expect(invoke("documentCreate", { cwd, actor: "agent", path: "new.md", markdown: "Created" })).resolves.toEqual({ ok: true, path: "new.md" });
    expect(documents.get("notes.md")).toBe("Root");
    expect(documents.get("app/notes.md")).toBe("Edited");
    expect(documents.get("app/new.md")).toBe("Created");
    const setFields = vi.fn(async (input: Parameters<CliCollectionWriteSeam["setFields"]>[0]) => ({ path: input.recordPath }));
    const createRecord = vi.fn(async (input: Parameters<CliCollectionWriteSeam["createRecord"]>[0]): Promise<Awaited<ReturnType<CliCollectionWriteSeam["createRecord"]>>> => ({ path: `${input.collectionPath}/${input.name}.md`, recordId: "rec_abcdefghijklmnopqrstuvwxyz" }));
    context.collections = { query: vi.fn(), getRecord: vi.fn(), writes: { setFields, createRecord } };
    await expect(invoke("collectionSetFields", { cwd, actor: "agent", recordPath: "tasks/a.md", fields: { status: "done" } })).resolves.toEqual({ ok: true, recordPath: "tasks/a.md" });
    expect(setFields).toHaveBeenCalledWith(expect.objectContaining({ recordPath: "app/tasks/a.md" }));
    await expect(invoke("collectionCreateRecord", { cwd, actor: "agent", collectionPath: "tasks", name: "b", fields: {} })).resolves.toMatchObject({ ok: true, recordPath: "tasks/b.md" });
    expect(createRecord).toHaveBeenCalledWith(expect.objectContaining({ collectionPath: "app/tasks" }));
    const record = { id: "rec_abcdefghijklmnopqrstuvwxyz", path: "app/tasks/a.md", conflicted: false, values: [] };
    context.collections.query = vi.fn(async () => ({ collection: { path: "app/tasks", objectId: "collection-app", status: "valid" as const, reasons: [] }, records: [record], groups: [{ value: "open", records: [record] }], nextCursor: { sortValues: [], recordPath: "app/tasks/a.md", recordId: record.id } }));
    await expect(invoke("collectionQuery", { cwd, actor: "agent", collectionPath: "tasks", cursor: { sortValues: [], recordPath: "tasks/a.md", recordId: record.id } })).resolves.toMatchObject({ collection: { path: "tasks" }, records: [{ path: "tasks/a.md" }], groups: [{ records: [{ path: "tasks/a.md" }] }], nextCursor: { recordPath: "tasks/a.md" } });
    expect(context.collections.query).toHaveBeenLastCalledWith(expect.objectContaining({ collectionPath: "app/tasks", cursor: expect.objectContaining({ recordPath: "app/tasks/a.md" }) }));
    context.collections.getRecord = vi.fn(async () => ({ collection: { path: "app/tasks", objectId: "collection-app", status: "valid" as const, reasons: [] }, record, history: [], nextBeforeHistoryId: null }));
    await expect(invoke("collectionRecord", { cwd, actor: "agent", collectionPath: "tasks", recordId: record.id, historyLimit: 25 })).resolves.toMatchObject({ collection: { path: "tasks" }, record: { path: "tasks/a.md" } });
    createRecord.mockResolvedValueOnce({ kind: "partial", created: ["app/tasks/b.md"], failedStage: "fields", reason: "Cannot set app/tasks/b.md", retry: { mode: "resume", instruction: "Retry app/tasks/b.md", recordId: record.id } });
    await expect(invoke("collectionCreateRecord", { cwd, actor: "agent", collectionPath: "tasks", name: "b", fields: {} })).resolves.toMatchObject({ ok: false, partial: { created: ["tasks/b.md"], reason: "Cannot set tasks/b.md", retry: { instruction: "Retry tasks/b.md" } } });
    setFields.mockRejectedValueOnce(new Error("Cannot edit app/tasks/a.md"));
    await expect(invoke("collectionSetFields", { cwd, actor: "agent", recordPath: "tasks/a.md", fields: { status: "done" } })).resolves.toMatchObject({ ok: false, reason: "Cannot edit tasks/a.md" });
    for (const path of ["../notes.md", "x/../notes.md", "../.dohc/private.md"]) {
      await expect(invoke("documentRead", { cwd, actor: "agent", path })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining(path) });
      await expect(invoke("documentEdit", { cwd, actor: "agent", path, replacement: "Wrong" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining(path) });
      await expect(invoke("documentCreate", { cwd, actor: "agent", path, markdown: "Wrong" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining(path) });
    }
    await expect(invoke("collectionSetFields", { cwd, actor: "agent", recordPath: "../tasks/a.md", fields: { status: "done" } })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("../tasks/a.md") });
    await expect(invoke("documentRead", { cwd: tempRoot, actor: "agent", path: "notes.md" })).rejects.toThrow("not inside a dohc workspace");
    await expect(invoke("documentRead", { cwd: workspaceRoot, actor: "agent", path: "notes.md" })).resolves.toEqual({ ok: true, path: "notes.md", markdown: "Root" });
  });

  it("writes an agent's collection and document changes at the depth of the run an automation started", async () => {
    const authors: unknown[] = [];
    context.collections = {
      async query() {
        throw new Error("reads are not under test");
      },
      async getRecord() {
        throw new Error("reads are not under test");
      },
      writes: {
        async setFields(input) {
          authors.push(input.author);
          return { path: input.recordPath };
        },
        async createRecord(input) {
          authors.push(input.author);
          return { path: `${input.collectionPath}/${input.name}.md`, recordId: "rec_abcdefghijklmnopqrstuvwxyz" };
        },
      },
    };
    context.documents = {
      async read() {
        throw new Error("reads are not under test");
      },
      async edit(input) {
        authors.push(input.origin);
        return { path: input.path, changed: true };
      },
      async create(input) {
        authors.push(input.origin);
        return { path: input.path };
      },
    };
    // An automation wakes an agent through dispatch.
    agentRunDepth = 3;
    dispatchedRun = "codex";

    await invoke("collectionSetFields", { cwd: workspaceRoot, actor: "agent", recordPath: "tasks/a.md", fields: { status: "done" } });
    await invoke("collectionCreateRecord", { cwd: workspaceRoot, actor: "agent", collectionPath: "tasks", name: "b", fields: {} });
    await invoke("collectionSetFields", { cwd: workspaceRoot, actor: "agent", agent: "Client", recordPath: "tasks/a.md", fields: { status: "done" } });
    await invoke("collectionCreateRecord", { cwd: workspaceRoot, actor: "agent", agent: "Client", collectionPath: "tasks", name: "c", fields: {} });
    await invoke("documentEdit", { cwd: workspaceRoot, actor: "agent", path: "notes/plan.md", replacement: "Done." });
    await invoke("documentCreate", { cwd: workspaceRoot, actor: "agent", agent: "claude-code", path: "notes/new.md", markdown: "# New" });
    // A write that names a person is refused, so the agent cannot start the
    // chain over by leaving out --as-agent.
    await expect(invoke("collectionSetFields", { cwd: workspaceRoot, actor: "human", recordPath: "tasks/a.md", fields: { status: "parked" } }))
      .resolves.toMatchObject({ ok: false });

    // A name the client gives, as "Client" and "claude-code" do, gives way to the run's.
    const woken = { kind: "agent", agentId: "codex", onBehalfOf: "person-local", depth: 3 };
    const attribution = { actorKind: "agent", onBehalfOf: "person-local", depth: 3 };
    expect(authors).toEqual([
      woken,
      woken,
      woken,
      woken,
      { actorOriginId: "codex", attribution },
      { actorOriginId: "codex", attribution },
    ]);
  });

  it("attributes a live run's reply to the agent and refuses its nested writable workspace", async () => {
    const posted = await post({ actor: "human", title: "Test", body: "Check." });
    const lastAuthor = async () =>
      (await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: `thread-${posted.threadId.slice(3)}` })).at(-1)?.author.kind;
    holdRun("run_live", "codex");
    const args = { cwd: workspaceRoot, actor: "human", thread: posted.threadId, body: "Done.", attachments: [], needsDecision: false, runId: "run_live" } as const;
    // Without the run's secret, or with another, the run id is only a claim.
    for (const secret of [undefined, "c".repeat(64)]) {
      callerRunSecret = secret;
      await invoke("reply", { ...args, attachments: [] });
      expect(await lastAuthor()).toBe("human");
    }
    // An answer never repeats the secret a request carried: the run's, another,
    // or a malformed one, whether the request worked or failed.
    for (const secret of [RUN_SECRET, "c".repeat(64), "C".repeat(64)]) {
      for (const thread of [posted.threadId, "th_missing"]) {
        const response = await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "reply", args: { ...args, thread }, runSecret: secret });
        expect(response.ok).toBe(thread === posted.threadId && secret !== "C".repeat(64));
        expect(JSON.stringify(response)).not.toContain(secret);
      }
    }
    callerRunSecret = RUN_SECRET;
    await invoke("reply", { ...args, attachments: [] });
    expect(await lastAuthor()).toBe("agent");
    const nestedRoot = join(workspaceRoot, "notes");
    await mkdir(nestedRoot);
    serverOptions.listWorkspaces = () => [registryWorkspace, { workspaceId: "nested", rootPath: nestedRoot }];
    const opened = calls.openWorkspace;
    await expect(invoke("reply", { ...args, cwd: nestedRoot, attachments: [] })).rejects.toThrow("Agent runs cannot write in another workspace.");
    expect(calls.openWorkspace).toBe(opened);
  });

  it("records a named MCP client's file write and reply as one agent: a dispatched run's, else the unnamed agent", async () => {
    if (!store) throw new Error("Store is not available");
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>(async files => ({ ok: true, written: files.map(file => file.path) }));
    context.writeFiles = writeFiles;
    // Main's person is the account the chat writes are admitted under.
    serverOptions.localPersonId = () => "verified-user-id";
    const identity = { installationId: "install-local-user-id", account: { issuer: createActorIssuer("https://cloud.test"), userId: "verified-user-id" } };
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: request => invoke(request.verb, request.args) };
    const posted = await post({ actor: "human", title: "Trip", body: "Plan day 2." });
    const threadId = `thread-${posted.threadId.slice("th_".length)}`;
    // The MCP server names the client on the file write and the reply: the
    // name from its handshake, or a claim to "default", the person's first agent's id.
    async function writeAndReply(name: string) {
      await writeWorkspaceFile(ctx, { path: "plan.txt", content: "Day 2" }, name);
      const reply = await replyToChat(ctx, { threadId: posted.threadId, body: "Planned day 2." }, name);
      if (!reply.ok) throw new Error(reply.reason);
      const message = (await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId })).find((row) => row.id === reply.messageId);
      const origin = writeFiles.mock.lastCall?.[1];
      if (!origin || !message?.authorActorKey) throw new Error("Expected the file write and the reply.");
      const author = agentWriteAuthor(origin);
      return {
        file: deriveMomentActor(author, { source: "own-store", workspaceId: WORKSPACE_ID, identity }, name).key,
        fileName: author.kind === "agent" ? author.agentName : undefined,
        reply: parseActorKey(message.authorActorKey),
        name: message.author.displayName,
      };
    }

    // In a run, both are the run's agent, whatever name the client gives.
    dispatchedRun = "codex";
    for (const name of ["Codex", "default"]) {
      const during = await writeAndReply(name);
      expect(during.file).toMatchObject({ kind: "agent", claimedName: "codex" });
      expect(during.fileName).toBeUndefined();
      expect(during.reply).toEqual(during.file);
    }

    // A caller in the workspace without the run's secret, or with another, is
    // not the run.
    for (const secret of [undefined, "c".repeat(64)]) {
      callerRunSecret = secret;
      const other = await writeAndReply("Codex");
      expect(other.file).toMatchObject({ kind: "agent", claimedName: "dohc-mcp" });
      expect(other.reply).toEqual(other.file);
    }
    callerRunSecret = RUN_SECRET;

    // Outside a run, both are the unnamed agent's, and the reply shows the name given.
    dispatchedRun = null;
    for (const name of ["Codex", "default"]) {
      const outside = await writeAndReply(name);
      expect(outside.file).toMatchObject({ kind: "agent", claimedName: "dohc-mcp" });
      expect(outside.fileName).toBe(name);
      expect(outside.reply).toEqual(outside.file);
      expect(outside.name).toBe(name);
    }
  });




  it("keeps what an agent reported on its posts and replies, beside its unchanged name", async () => {
    if (!store) throw new Error("Store is not available");
    const reported = { product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" };
    const started = await invoke("post", {
      cwd: workspaceRoot, actor: "agent", group: "general", attachments: [], needsDecision: false,
      body: "Opened a PR", reported,
    });
    const thread = started.threadId;
    await invoke("reply", {
      cwd: workspaceRoot, actor: "agent", thread, attachments: [], needsDecision: false,
      body: "Checks pass", reported: { product: "Claude Code" },
    });
    // A person's write carries no report, even when the caller sends one.
    await invoke("reply", {
      cwd: workspaceRoot, actor: "human", thread, attachments: [], needsDecision: false,
      body: "Thanks", reported,
    });
    const listed = await invoke("groupsFull", { cwd: workspaceRoot, actor: "agent" });
    if (!listed.ok) throw new Error(listed.reason);
    const engineThread = listed.groups.flatMap(group => group.threads).find(candidate => cliThreadId(candidate.id) === thread);
    if (!engineThread) throw new Error("Posted thread is not listed");
    const messages = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId: engineThread.id });
    expect(messages.map(message => [message.author.displayName, message.authorReported])).toEqual([
      ["Agent", reported],
      ["Agent", { product: "Claude Code" }],
      ["Sam", undefined],
    ]);

    // An agent reading the chat sees what a person sees, through MCP and the CLI.
    const expected = [reported, { product: "Claude Code" }, undefined];
    const read = await invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId: engineThread.id });
    if (!read.ok) throw new Error(read.reason);
    expect(read.messages.map(message => message.authorReported)).toEqual(expected);
    expect(read.messages[2]).not.toHaveProperty("authorReported");
    const shown = await invoke("show", { cwd: workspaceRoot, actor: "agent", target: thread, peek: true });
    expect(shown.messages.map(message => message.authorReported)).toEqual(expected);
  });



  it("comments on a file through the chat write path a person's comment takes", async () => {
    if (!store) throw new Error("Store is not available");
    const comment = (path: string, title: string, body: string, flags: string[] = []) => executeCli({
      argv: ["document", "comment", path, "--title", title, "--text", body, "--json", ...flags],
      cwd: workspaceRoot, env: {}, request: (request) => invoke(request.verb, request.args),
    });
    const output = await comment("tracked.md", "Budget", "Is 400 enough for food?", ["--agent", "claude-code"]);
    expect(output.exitCode, output.stderr).toBe(0);
    const { schemaVersion, ...startedResult } = JSON.parse(output.stdout);
    expect(schemaVersion).toBe(3);
    const started = parseCliResult("fileChatStart", startedResult);
    if (!started.ok) throw new Error(started.reason);
    expect(started.path).toBe("tracked.md");

    // The comment is the file's chat, authored as the agent under the name
    // it gave, on behalf of the person.
    await expect(invoke("fileChats", {
      cwd: workspaceRoot, actor: "agent", path: "tracked.md",
    })).resolves.toMatchObject({
      ok: true,
      threads: [{ id: started.threadId, title: "Budget", linkedPathHint: "tracked.md" }],
    });
    const messages = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId: started.threadId });
    expect(messages).toMatchObject([{
      id: started.messageId,
      body: "Is 400 enough for food?",
      author: { kind: "agent", displayName: "claude-code" },
      authorOwnerDisplayName: "Sam",
    }]);

    // A file dohc does not track has no chats to start.
    await expect(invoke("fileChatStart", {
      cwd: workspaceRoot, actor: "agent", path: "untracked.md", title: "T", body: "B",
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("does not track untracked.md") });

    // A comment through the socket is an agent's, whatever the caller claims.
    await expect(invoke("fileChatStart", {
      cwd: workspaceRoot, actor: "human", path: "tracked.md", title: "T", body: "B",
    })).resolves.toEqual({
      ok: false,
      reason: "a comment through the CLI socket is recorded as an agent's; send actor \"agent\"",
    });

    // A retry with the same request id returns the first chat instead of
    // starting a second; the id cannot be reused for a different comment.
    const once = { cwd: workspaceRoot, actor: "agent" as const, path: "tracked.md", title: "Once", body: "One chat.", requestId: "req-1" };
    const retryFlags = ["--request-id", once.requestId];
    const firstOutput = await comment(once.path, once.title, once.body, retryFlags);
    expect(firstOutput.exitCode, firstOutput.stderr).toBe(0);
    const { schemaVersion: retrySchemaVersion, ...firstResult } = JSON.parse(firstOutput.stdout);
    expect(retrySchemaVersion).toBe(3);
    const first = parseCliResult("fileChatStart", firstResult);
    if (!first.ok) throw new Error(first.reason);
    await expect(comment(once.path, once.title, once.body, retryFlags)).resolves.toEqual(firstOutput);
    await expect(comment(once.path, once.title, "Another.", retryFlags)).resolves.toEqual({
      exitCode: 1, stdout: "", stderr: "dohc: request id req-1 was already used for a different request\n",
    });
    await expect(invoke("fileChatStart", { ...once, body: "Another." })).resolves.toEqual({
      ok: false,
      reason: "request id req-1 was already used for a different request",
    });
    const chats = await invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path: "tracked.md" });
    if (!chats.ok) throw new Error(chats.reason);
    expect(chats.threads.filter((thread) => thread.title === "Once")).toHaveLength(1);
    // An agent that gave no name is "Agent".
    await expect(store.listMessages({ workspaceId: WORKSPACE_ID, threadId: first.threadId }))
      .resolves.toMatchObject([{ author: { kind: "agent", displayName: "Agent" } }]);

    for (const [path, reason] of [
      ["untracked.md", "dohc does not track untracked.md yet, so it cannot have chats. Only text files dohc tracks can. Try again once dohc lists the file."],
      ["../outside.md", "path rejected (traversal): ../outside.md"],
      [".dohc/private.md", "path rejected (reserved): .dohc/private.md"],
    ] as const) {
      const denied = await comment(path, "T", "B");
      expect(denied).toEqual({ exitCode: 1, stdout: "", stderr: `dohc: ${reason}\n` });
    }
    const beforeReadOnly = calls.writes;
    // A shared view refuses before the chat module is reached.
    registryWorkspace = { ...registryWorkspace, readOnly: true };
    context.readOnly = true;
    await expect(invoke("fileChatStart", {
      cwd: workspaceRoot, actor: "agent", path: "tracked.md", title: "T", body: "B",
    })).rejects.toThrow("chats are not available in a read-only shared view");
    await expect(comment("tracked.md", "T", "B")).resolves.toEqual({
      exitCode: 1, stdout: "", stderr: "dohc: chats are not available in a read-only shared view\n",
    });
    expect(calls.writes).toBe(beforeReadOnly);
  });


  it("lets a local agent review, drop, and undo through the shared held operation", async () => {
    const token = "a".repeat(64);
    let waiting = true;
    const calls: unknown[] = [];
    context.heldNoteChange = async input => {
      calls.push(input);
      if (input.action === "drop") waiting = false;
      if (input.action === "undo") waiting = true;
      return {path: input.path, token, authors: [], held: waiting, historyMomentId: "history"};
    };
    const args = {cwd: workspaceRoot, actor: "agent" as const, path: "tracked.md"};
    expect(await invoke("heldNoteChange", {...args, action: "review"})).toMatchObject({ok: true, held: true, token});
    expect(await invoke("heldNoteChange", {...args, action: "drop", token})).toMatchObject({ok: true, held: false});
    expect(await invoke("heldNoteChange", {...args, action: "undo", token})).toMatchObject({ok: true, held: true});
    expect(calls.slice(1)).toEqual(["drop", "undo"].map(action => ({path: "tracked.md", action, token,
      author: {kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local"}})));
    expect(await invoke("heldNoteChange", {...args, actor: "human", action: "drop", token})).toMatchObject({ok: false});
    expect(waiting).toBe(true);
    context.readOnly = true;
    registryWorkspace.readOnly = true;
    await expect(invoke("heldNoteChange", {...args, action: "drop", token})).rejects.toThrow("read-only shared view");
    expect(waiting).toBe(true);
  });

  it("answers a resent document edit with its first result", async () => {
    let applied = 0;
    const saving = { release: () => undefined as void };
    context.documents = {
      async read() {
        throw new Error("reads are not under test");
      },
      async edit(input) {
        if (input.edit.replacement === "Refused.") throw new Error("The text to replace is not in the document.");
        if (input.edit.replacement === "Unsaved.") {
          applied += 1;
          throw new LiveDocumentEditAppliedError("The edit is in notes/plan.md, but dohc has not saved it to the file yet.");
        }
        if (input.edit.replacement === "Lost.") {
          applied += 1;
          throw new LiveDocumentEditAppliedError("Someone changed the blocks this edit went into at the same moment, so some or all of its text is not in notes/plan.md.");
        }
        applied += 1;
        await new Promise<void>((resolve) => { saving.release = resolve; });
        return { path: input.path, changed: true };
      },
      async create() {
        throw new Error("creates are not under test");
      },
    };
    const append = { cwd: workspaceRoot, actor: "agent" as const, path: "notes/plan.md", replacement: "Appended.", requestId: "edit-1" };

    // The caller's first request is still saving when it gives up and sends
    // the edit again; both hear the one result.
    const first = invoke("documentEdit", append);
    await vi.waitFor(() => expect(applied).toBe(1));
    const resent = invoke("documentEdit", append);
    saving.release();
    await expect(first).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    await expect(resent).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    await expect(invoke("documentEdit", append)).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    expect(applied).toBe(1);
    await expect(invoke("documentEdit", { ...append, replacement: "Other." })).resolves.toEqual({
      ok: false,
      reason: "request id edit-1 was already used for a different request",
    });

    // An edit that changed nothing may be sent again under its id. One that
    // reached the document may not, whether it went unsaved or someone
    // removed the block it went into.
    const refused = { ...append, replacement: "Refused.", requestId: "edit-2" };
    await expect(invoke("documentEdit", refused)).resolves.toMatchObject({ ok: false });
    await expect(invoke("documentEdit", refused)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("not in the document") });
    const unsaved = { ...append, replacement: "Unsaved.", requestId: "edit-3" };
    const unsavedResult = await invoke("documentEdit", unsaved);
    expect(unsavedResult).toMatchObject({ ok: false, reason: expect.stringContaining("not saved it") });
    await expect(invoke("documentEdit", unsaved)).resolves.toEqual(unsavedResult);
    const lost = { ...append, replacement: "Lost.", requestId: "edit-4" };
    const lostResult = await invoke("documentEdit", lost);
    expect(lostResult).toMatchObject({ ok: false, reason: expect.stringContaining("is not in notes/plan.md") });
    await expect(invoke("documentEdit", lost)).resolves.toEqual(lostResult);
    expect(applied).toBe(3);
  });

  it("keeps a running request's id, and refuses a resend whose result it no longer holds", async () => {
    serverOptions.requestIdLimits = { results: 1, ids: 1 };
    let applied = 0;
    const slow = { release: () => undefined as void };
    context.documents = {
      async read() {
        throw new Error("reads are not under test");
      },
      async edit(input) {
        applied += 1;
        if (input.edit.replacement === "Slow.") {
          await new Promise<void>((resolve) => { slow.release = resolve; });
        }
        return { path: input.path, changed: true };
      },
      async create() {
        throw new Error("creates are not under test");
      },
    };
    const request = (replacement: string, requestId: string) => ({
      cwd: workspaceRoot, actor: "agent" as const, path: "notes/plan.md", replacement, requestId,
    });

    // Other requests finish while the first is still saving, past the limit.
    const running = invoke("documentEdit", request("Slow.", "slow"));
    await vi.waitFor(() => expect(applied).toBe(1));
    for (const id of ["a", "b", "c"]) await invoke("documentEdit", request(`Edit ${id}.`, id));
    const resent = invoke("documentEdit", request("Slow.", "slow"));
    slow.release();
    await expect(running).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    await expect(resent).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    expect(applied).toBe(4);

    // "slow" finished, and a later result pushes it out: its id is still
    // known, so a resend is refused rather than run again.
    await invoke("documentEdit", request("Edit d.", "d"));
    await expect(invoke("documentEdit", request("Slow.", "slow"))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("no longer holds the result of request id slow, so it did not run it again"),
    });
    expect(applied).toBe(5);
  });

  // The shared-channel pass a write triggers must cover the channel that
  // was written, and it only can when the write names its own target. A CLI
  // send that reports a bare workspace leaves the message to the rotation.

  // No renderer poll runs the sync pass behind the CLI or MCP, so a chat
  // read must await it itself. `onReadEffect` stands in for what a real pass
  // pulls from a peer — it lands in the store only if the read genuinely waits
  // on the hook before it serves results.
  it("awaits the sync pass before a chat read serves its result", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Local message",
    });
    onReadEffect = async () => {
      await store!.sendMessage({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        threadId: thread.id,
        author: { kind: "human", displayName: "Peer" },
        body: "Peer message synced in",
      });
    };

    const chat = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: thread.id,
    });
    if (!chat.ok) throw new Error(chat.reason);

    expect(calls.reads).toBe(1);
    expect(chat.messages.map((message) => message.body)).toEqual([
      "Local message",
      "Peer message synced in",
    ]);
  });

  // The CLI client itself gives up after its own 30 s response
  // timeout. An unbounded await of a hanging sync pass would exceed that and
  // kill the read entirely — worse than the stale read a bound leaves behind.
  it("serves local rows within budget when the sync pass hangs past it", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Local-only message",
    });
    // Never resolves within the test — a permanently hung pass is the exact
    // worst case the budget exists for. A real socket transport in play here
    // (server may be non-null) rules out fake timers, so a short override
    // proves the bound with real wall-clock time instead — the same knob
    // regexScanTimeoutMs and the runMessageLink*Ms options already are.
    onReadEffect = () => new Promise<void>(() => {});
    serverOptions.chatReadSyncBudgetMs = 40;

    const startedAtMs = Date.now();
    const chat = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: thread.id,
    });
    const elapsedMs = Date.now() - startedAtMs;
    if (!chat.ok) throw new Error(chat.reason);

    expect(chat.messages.map((message) => message.body)).toEqual([
      "Local-only message",
    ]);
    // Waited roughly the configured budget — not zero (skipping the pass
    // entirely) and not the unbounded hang the mutation this pins against
    // leaves behind.
    expect(elapsedMs).toBeGreaterThanOrEqual(35);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  // A detached pass past the budget stays running. Without
  // coalescing, a slow relay behind a stream of reads starts one detached
  // pass per read — main.ts's serializer only stops them running
  // concurrently, not from queueing up unboundedly.



  it("marks a person's show under the account main names, and never asks for an agent's", async () => {
    const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store!.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Read me",
    });
    const accountReadOwner = vi.fn(async (_threadId: string): Promise<string | undefined> => "verified-user-id");
    context = { ...context, accountReadOwner };
    const marks = vi.spyOn(store!, "markThreadRead");

    await invoke("show", { cwd: workspaceRoot, actor: "human", target: thread.id, peek: false });
    expect(accountReadOwner).toHaveBeenCalledExactlyOnceWith(thread.id);
    expect(marks).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: thread.id, replicationOwnerUserId: "verified-user-id",
    }));

    // A signed-out or joined target gets no owner, and the read stays here.
    accountReadOwner.mockResolvedValueOnce(undefined);
    await invoke("show", { cwd: workspaceRoot, actor: "human", target: thread.id, peek: false });
    expect(marks.mock.calls.at(-1)?.[0]).not.toHaveProperty("replicationOwnerUserId");

    accountReadOwner.mockClear();
    await invoke("show", { cwd: workspaceRoot, actor: "agent", target: thread.id, peek: false });
    expect(accountReadOwner).not.toHaveBeenCalled();
  });




  // Provisioning General writes outside chatWrites, so only onWrite tells
  // the desktop to notify the renderer and queue cloud sync for it.













  it("persists pending provenance across shutdown without reporting it settled", async () => {
    await seedDispatchThread("thread-restart_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-restart_recovery_trigger",
      threadId: "thread-restart_recovery",
      agentId: "default",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, { agentId: "default" });
    if (!claim) throw new Error("Expected a dispatch run.");
    holdRun(claim.run.runId);
    const originalDispatch = dispatchStore;
    const pending: string[] = [];
    const settled: string[] = [];
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage() {
          throw new Error("daemon unavailable until restart");
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkRecoveryRetryMs = 60_000;
    serverOptions.onRunMessageLinkPending = (link) =>
      pending.push(link.messageId);
    serverOptions.onRunMessageLinkSettled = (link) =>
      settled.push(link.messageId);

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Persist provenance recovery",
      body: "Recover this link after a desktop restart.",
    });
    const engineMessageId = result.messageId.replace(/^msg_/u, "message-");
    await server?.close();
    server = null;
    disposeCliServerRuntime(serverOptions);

    expect(settled).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE),
          "utf8",
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        runId: claim.run.runId,
        messageId: engineMessageId,
      }),
    ]);

    context = { ...context, dispatchStore: originalDispatch };
    const restoredOptions: CliServerOptions = {
      ...serverOptions,
      runMessageLinkRecoveryRetryMs: 0,
    };
    serverOptions = restoredOptions;
    await restoreCliServerRuntime(restoredOptions);
    for (let index = 0; index < 50; index += 1) {
      if (
        (await originalDispatch.runIdForMessage(
          WORKSPACE_ID,
          engineMessageId,
        )) !== null
      ) {
        break;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }

    expect(pending).toEqual([engineMessageId, engineMessageId]);
    expect(settled).toEqual([engineMessageId]);
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
    await expect(
      stat(join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles a background provenance link on the first permanent refusal", async () => {
    await seedDispatchThread("thread-terminal_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-terminal_recovery_trigger",
      threadId: "thread-terminal_recovery",
      agentId: "default",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      agentId: "default",
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for terminal recovery.");
    holdRun(claim.run.runId);
    let attempts = 0;
    const settled: string[] = [];
    const abandoned: string[] = [];
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage() {
          attempts += 1;
          // The first three attempts are the foreground loop; the daemon only
          // turns permanent once the link is already in background recovery.
          if (attempts <= 3) throw new Error("daemon restart in progress");
          throw new DaemonRefusalError(
            {
              code: "INVALID_PARAMS",
              message: "invalid-input",
              retry: "no",
            },
            null,
          );
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkRecoveryRetryMs = 0;
    serverOptions.onRunMessageLinkSettled = (link) =>
      settled.push(link.messageId);
    serverOptions.onRunMessageLinkAbandoned = (link) =>
      abandoned.push(link.messageId);

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Terminal recovery",
      body: "A refused link must leave the recovery queue at once.",
    });
    for (let index = 0; index < 100 && settled.length === 0; index += 1) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }

    const engineMessageId = result.messageId.replace(/^msg_/u, "message-");
    expect(settled).toEqual([engineMessageId]);
    expect(abandoned).toEqual([]);
    expect(attempts).toBe(4);
    await expect(
      stat(join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps retrying a terminal refusal the link taxonomy does not call permanent", async () => {
    await seedDispatchThread("thread-terminal_transient");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-terminal_transient_trigger",
      threadId: "thread-terminal_transient",
      agentId: "default",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      agentId: "default",
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for transient refusal.");
    holdRun(claim.run.runId);
    let attempts = 0;
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage(input) {
          attempts += 1;
          if (attempts < 3) {
            throw new DaemonRefusalError(
              {
                code: "INTERNAL",
                message: "persist-failed",
                retry: "no",
              },
              null,
            );
          }
          return originalDispatch.recordRunMessage(input);
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Recoverable refusal",
      body: "A retryable refusal must not be read as permanent.",
    });

    const engineMessageId = result.messageId.replace(/^msg_/u, "message-");
    expect(attempts).toBe(3);
    expect(result.warning).toBeUndefined();
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
    expect(errors).toEqual([]);
  });

  it("refuses missing and foreign engine thread ids without posting", async () => {
    const foreignRoot = join(tempRoot, "foreign");
    await mkdir(foreignRoot);
    const foreignStore = storeForWorkspace("foreign-workspace", foreignRoot);
    const channel = await foreignStore.ensureGeneralChannel({ workspaceId: "foreign-workspace" });
    const opened = await foreignStore.startChannelThread({
      authorActorKey: null,
      workspaceId: "foreign-workspace", channelId: channel.id,
      author: { kind: "human", displayName: "Other owner" }, body: "Other workspace",
    });
    for (const threadId of ["thread-missing", opened.thread.id]) {
      await expect(invoke("reply", {
        cwd: workspaceRoot, actor: "agent", thread: threadId,
        attachments: [], needsDecision: false, body: "Must not cross workspaces",
      })).rejects.toThrow();
    }
    expect(await foreignStore.listMessages({ workspaceId: "foreign-workspace", threadId: opened.thread.id })).toHaveLength(1);
  });

  it("posts the reply but keeps the decision open when access changes during send", async () => {
    const opened = await post({
      actor: "human",
      title: "Access race",
      body: "Choose a path",
      needsDecision: true,
    });
    if (!store) throw new Error("Store is not available");
    const originalSend = store.sendMessage.bind(store);
    store.sendMessage = async (input) => {
      const message = await originalSend(input);
      const channelId = await store!.findThreadChannelId({ workspaceId: WORKSPACE_ID, threadId: input.threadId });
      await makeChannelReadOnly(channelId!);
      return message;
    };

    try {
      const reply = await invoke("reply", {
        cwd: workspaceRoot,
        actor: "human",
        thread: opened.threadId,
        attachments: [],
        needsDecision: false,
        resolve: opened.messageId,
        body: "Reply before access changed",
      });
      expect(reply.warning).toContain("could not be resolved: You can only read this.");
      expect(reply.resolvedMessageId).toBeUndefined();
      const persisted = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId: opened.threadId.replace(/^th_/u, "thread-") });
      expect(reply.messageId).toBe(cliMessageId(persisted.at(-1)!.id));
    } finally {
      store.sendMessage = originalSend;
    }

    const shown = await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: opened.threadId,
      peek: true,
    });
    expect(shown.messages).toHaveLength(2);
    expect(shown.messages[0]?.decisionState).toBe("open");
    expect(shown.messages[1]?.body).toBe("Reply before access changed");
  });

  // The TypeScript-backend twin of this scenario was removed with the legacy
  // sqlite fallback in queryFtsCandidates. The daemon test below asserts the
  // same property -- that grep hydrates only the FTS candidate threads
  // (loadedThreadIds equals the matching thread alone) -- and additionally
  // covers the saturation fallback, so no coverage was lost.
  it("uses daemon candidates for substring grep and falls back when they saturate", async () => {
    const matching = await post({
      actor: "human",
      title: "Daemon candidate",
      body: "The daemon-prefilter-needle lives here",
    });
    await post({
      actor: "human",
      title: "Daemon unrelated",
      body: "Nothing relevant in this thread",
    });
    if (!store) throw new Error("Store is not available");
    const matchingThread = (await store.listThreads({ workspaceId: WORKSPACE_ID }))
      .find((thread) => cliThreadId(thread.id) === matching.threadId);
    if (!matchingThread) throw new Error("Matching thread is unavailable");
    const matchingMessage = (
      await store.listMessages({
        workspaceId: WORKSPACE_ID,
        threadId: matchingThread.id,
      })
    )[0];
    if (!matchingMessage) throw new Error("Matching message is unavailable");

    let saturated = false;
    let daemonCalls = 0;
    const defaultDaemonReads = context.daemonReads;
    context.daemonReads = {
      collectionsWaiting: defaultDaemonReads.collectionsWaiting,
      async queryChatMessagesGranular() {
        daemonCalls += 1;
        const row = {
          threadId: matchingThread.id,
          messageId: matchingMessage.id,
          text: matchingMessage.body,
        };
        return { results: [row], saturated };
      },
      async listUnreadFileThreads() {
        return [];
      },
    };

    const loadedThreadIds: string[] = [];
    const originalListMessages = store.listMessages;
    store.listMessages = async (input) => {
      loadedThreadIds.push(input.threadId);
      return originalListMessages(input);
    };
    try {
      const filtered = await invoke("grep", {
        cwd: workspaceRoot,
        actor: "human",
        pattern: "daemon-prefilter-needle",
        ignoreCase: true,
        filesWithMatches: false,
        context: 0,
        limit: 20,
        regex: false,
      });
      expect("matches" in filtered && filtered.matches).toHaveLength(1);
      expect(loadedThreadIds).toEqual([matchingThread.id]);

      loadedThreadIds.length = 0;
      saturated = true;
      const fallback = await invoke("grep", {
        cwd: workspaceRoot,
        actor: "human",
        pattern: "daemon-prefilter-needle",
        ignoreCase: true,
        filesWithMatches: false,
        context: 0,
        limit: 20,
        regex: false,
      });
      expect("matches" in fallback && fallback.matches).toHaveLength(1);
      expect(new Set(loadedThreadIds).size).toBe(2);
      expect(daemonCalls).toBe(2);

      loadedThreadIds.length = 0;
      context.daemonReads.queryChatMessagesGranular = async () => {
        throw new Error("workspace root is already open in a different mode");
      };
      const failedPrefilterFallback = await invoke("grep", {
        cwd: workspaceRoot,
        actor: "human",
        pattern: "daemon-prefilter-needle",
        ignoreCase: true,
        filesWithMatches: false,
        context: 0,
        limit: 20,
        regex: false,
      });
      expect(
        "matches" in failedPrefilterFallback &&
          failedPrefilterFallback.matches,
      ).toHaveLength(1);
      expect(new Set(loadedThreadIds).size).toBe(2);
      expect(debugLines).toEqual([
        "grep daemon prefilter failed; falling back to full scan: " +
          "workspace root is already open in a different mode",
      ]);
    } finally {
      store.listMessages = originalListMessages;
      context.daemonReads = defaultDaemonReads;
    }
  });

  it("searches with surrounding messages and exports canonical markdown", async () => {
    const opened = await post({
      actor: "human",
      title: "Search and export",
      body: "Context before the match",
    });
    const matched = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: opened.threadId,
      attachments: [],
      needsDecision: false,
      body: "The stable blockId is our unique Needle",
    });
    const after = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: opened.threadId,
      attachments: [],
      needsDecision: false,
      body: "Context after the match",
    });

    const grep = await invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "needle",
      ignoreCase: true,
      filesWithMatches: false,
      context: 1,
      limit: 20,
      regex: false,
    });
    if (!("matches" in grep)) throw new Error("Expected message grep results");
    expect(grep.matches).toHaveLength(1);
    expect(grep.matches[0]).toMatchObject({
      threadId: opened.threadId,
      messageId: matched.messageId,
      text: "The stable blockId is our unique Needle",
    });
    expect(grep.matches[0]?.contextBefore.map((message) => message.messageId)).toEqual([
      opened.messageId,
    ]);
    expect(grep.matches[0]?.contextAfter.map((message) => message.messageId)).toEqual([
      after.messageId,
    ]);

    const regex = await invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "stable\\s+blockId",
      ignoreCase: false,
      filesWithMatches: false,
      context: 0,
      limit: 20,
      regex: true,
    });
    if (!("matches" in regex)) throw new Error("Expected regex grep results");
    expect(regex.matches.map((match) => match.messageId)).toEqual([matched.messageId]);

    const threadOnly = await invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "needle",
      ignoreCase: true,
      filesWithMatches: true,
      context: 0,
      limit: 20,
      regex: false,
    });
    expect(threadOnly).toEqual({ threadIds: [opened.threadId] });

    const pauseRead = vi.spyOn(dispatchStore, "getThreadDispatchPauseState");
    const runRead = vi.spyOn(dispatchStore, "latestRunForThread");
    const exported = await invoke("export", {
      cwd: workspaceRoot,
      actor: "human",
      scope: { kind: "thread", thread: opened.threadId },
      outDir: "exports",
    });
    expect(pauseRead).not.toHaveBeenCalled();
    expect(runRead).not.toHaveBeenCalled();
    expect(exported.files).toHaveLength(1);
    expect(exported.files[0]?.threadId).toBe(opened.threadId);
    const markdown = await readFile(exported.files[0]!.path, "utf8");
    expect(markdown).toContain(
      `<!-- exported from dohc chat thread ${opened.threadId} at 2026-07-10T04:05:06.000Z -->`,
    );
    expect(markdown).not.toContain("dispatch:");
    expect(markdown).toContain("# Search and export");
    expect(markdown).toContain(`thread: ${opened.threadId} · #general`);
    expect(markdown).toContain("The stable blockId is our unique Needle");
  });

  it("times out pathological regex scans without blocking later requests", async () => {
    await post({
      actor: "human",
      title: "Regex timeout",
      body: `${"a".repeat(30_000)}!`,
    });
    serverOptions.regexScanTimeoutMs = 50;

    await expect(invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "^(a+)+$",
      ignoreCase: false,
      filesWithMatches: false,
      context: 0,
      limit: 20,
      regex: true,
    })).rejects.toThrow("regular expression scan timed out");
    await expect(invoke("groups", {
      cwd: workspaceRoot,
      actor: "human",
    })).resolves.toMatchObject({ groups: expect.any(Array) });
  });

  it("secures the CLI state directory, token, and socket", async (ctx) => {
    // Windows mode bits do not represent its inherited ACL or named-pipe DACL.
    if (process.platform === "win32") ctx.skip();
    // Without a live listener (sandbox) the mode assertions cannot run.
    if (!server) ctx.skip();
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(server!.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(server!.socketPath)).mode & 0o777).toBe(0o600);
    expect(calls.openWorkspace).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("resolveCliWorkspace", () => {
  it("does not find a workspace through a second folder entry in other capitals, as a mount of its folder is", async (ctx) => {
    const scratch = await realpath(await createTestScratch("dohc-cli-mounted-"));
    try {
      const notes: CliRegistryWorkspace = { workspaceId: "ws-notes", rootPath: join(scratch, "Notes") };
      await mkdir(join(notes.rootPath, "docs"), { recursive: true });
      const mounted = join(scratch, "notes");
      const second = await mkdir(mounted).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      });
      // A disk that ignores capitals has only one folder here.
      if (!second) ctx.skip();
      // notes is Notes on disk, but the scratch folder lists both names, and a
      // mount inside one of them may be missing in the other.
      folderAlias.current = { spelled: mounted, stored: notes.rootPath };
      await expect(resolveCliWorkspace(join(mounted, "docs"), [notes])).resolves.toBeNull();
    } finally {
      folderAlias.current = null;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
