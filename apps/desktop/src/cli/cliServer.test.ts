import { chatLinks as mcpChatLinks, listGroups as mcpListGroups } from "@dohc/mcp/tools";
import { accessCliQueries, createAccessAcquisition, createAccessOwner } from "../access/accessOwner";
import { createShareRosters } from "../automations/shareRoster";
import { stageDeleteRecovery } from "../workspaces/workspaceDeleteRecovery";
import { finishMoveRecovery } from "../workspaces/workspaceMoveRecovery";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation } from "../workspaces/workspaceHistoryOperations";
import { listChanges, readChange, readOperation, undoOperation } from "@dohc/mcp/tools";
import { deleteWorkspacePathByHand } from "../workspaces/workspaceFileMoves";
import { readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createApp, deleteWorkspacePath, importData, listFileChats, moveWorkspacePath, replyToChat, startFileChat, writeWorkspaceFile, type ToolContext } from "../../../../packages/mcp/src/tools";
import { createActorIssuer, deriveMomentActor, parseActorKey } from "@dohc/workspace-contracts/actor-identity";
import { executeCli } from "@dohc/cli";
import {
  CLI_PROTOCOL_VERSION,
  cliTransportResponseSchema,
  parseCliResult,
  type CliRequest,
  type CliResultByVerb,
  type CliTransportResponse,
  type CliVerb,
} from "@dohc/cli/protocol";
import type {
  LinkedChatStore,
  VersionedTextMoment,
  VersionedTextMomentSummary,
} from "@dohc/workspace-contracts/engine";
import {
  CHATS_METHOD,
  DaemonRefusalError,
  type Request,
} from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetSchemaChangeError } from "../workspaces/datasetSchemaChanges";
import { LiveDocumentEditAppliedError } from "../workspaces/engineYDocSessionIpc";
import type { AwaitableAgentDispatchStore } from "../agents/awaitableAgentDispatchStore";
import { createLiveAgentDispatchStore } from "../agents/liveAgentDispatchStore";
import { createChatWrites } from "../workspaces/chatWrites";
import { CredentialSessionCache } from "../workspaces/credentialSessionCache";
import { createLocalAuthorship } from "../workspaces/localAuthorship";
import { deferred } from "../testing/deferred";
import { createUsageStore } from "../usage/usageStore";
import { DESKTOP_USAGE_COVERAGE } from "../usage/cliUsage";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import {
  CLI_ENDPOINT_FILE,
  CLI_SOCKET_FILE,
  RUN_MESSAGE_LINK_RECOVERY_FILE,
  cliMessageId,
  cliThreadId,
  disposeCliServerRuntime,
  handleCliRequestLine,
  resolveCliWorkspace,
  restoreCliServerRuntime,
  startCliServer,
  type CliCollectionsPort,
  type CliCollectionWriteSeam,
  type CliDocumentsPort,
  type CliRegistryWorkspace,
  type CliServerHandle,
  type CliServerOptions,
  type CliWorkspaceContext,
} from "./cliServer";
import { agentWriteAuthor } from "./desktopCliServer";
import { openedLocalState } from "../testing/preparedLocalState";

const WORKSPACE_ID = "workspace-cli-server";
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
  let chatRow: Pick<RegistryEntry, "remote" | "shareView" | "sharedChannels">;
  let context: CliWorkspaceContext;
  let serverOptions: CliServerOptions;
  // The chain depth of the agent run in progress in each workspace, as main
  // reports it: this one for the fixture workspace, 0 for any other.
  let agentRunDepth: number;
  // Whether a run dohc dispatched holds the fixture workspace's run slot.
  let dispatchedRun: boolean;

  async function makeChannelReadOnly(channelId: string): Promise<void> {
    const channelWireId = await store!.getChannelWireId({ workspaceId: WORKSPACE_ID, channelId });
    if (!channelWireId) throw new Error("Channel has no wire id");
    chatRow.sharedChannels = [{
      shareId: "share", channelWireId, access: "read-only", granterEmail: null,
      relayUrl: "https://relay.test", recipientUserId: "verified-user-id",
    }];
  }

  async function invoke<Verb extends CliVerb>(
    verb: Verb,
    args: ArgsFor<Verb>,
  ): Promise<CliResultByVerb[Verb]> {
    const response = await rawRequest({
      token,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb,
      args,
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
    title: string;
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
      title: input.title,
      attachments: input.attachments ?? [],
      needsDecision: input.needsDecision ?? false,
      body: input.body,
    });
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
    dispatchedRun = false;
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
        agentDisplayName: async () => "Nova",
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
      dispatchedAgentRun: (workspaceId) => workspaceId === WORKSPACE_ID && dispatchedRun,
      agentRunWorkspace: () => undefined,
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

  it("uses the Access owner's paced window on read-only sockets and refuses caller scope", async () => {
    let now = 100_000;
    const workspace = { workspaceId: context.workspaceId, rootPath: workspaceRoot, remote: { ownerUserId: "owner", serverUrl: "server" } } as import("../workspaces/registryStore").RegistryEntry;
    const listRoster = vi.fn(async () => ({ kind: "answered" as const, listing: { grants: [], links: [], formerGrants: [], endedGrants: [] } }));
    const rosters = createShareRosters({ findWorkspace: id => id === workspace.workspaceId ? workspace : null,
      saveRoster: vi.fn(), markRosterPulled: vi.fn(), listRoster, localUserId: async () => "owner",
      localPersonId: async () => null, syncHistory: async () => "synced", logError: vi.fn(), nowMs: () => now });
    const acquisition = createAccessAcquisition({ roster: id => rosters.requestRefresh(id), received: async () => "paced" });
    const owner = createAccessOwner<string>({ resolve: async (_workspace, ref) => ({ ref, visibility: "visible" }),
      roster: () => rosters.observation(workspace.workspaceId), received: () => ({ inventory: null, checkedAtMs: null, freshness: "unknown" }),
      account: () => null, scope: id => id, assertCurrent: vi.fn(), permissions: vi.fn(), refresh: id => acquisition.request(id) });
    context.access = accessCliQueries(owner, work => Promise.resolve(work(context.workspaceId)));
    context.readOnly = true; registryWorkspace.readOnly = true;
    const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessRefresh", args: { cwd: workspaceRoot, actor: "agent" } };
    try {
      expect(await rawRequest(request)).toMatchObject({ ok: true, result: { status: "requested" } });
      expect(await rawRequest(request)).toMatchObject({ ok: true, result: { status: "paced" } });
      expect(await owner.refresh(context.workspaceId)).toEqual({ status: "paced" });
      expect(listRoster).toHaveBeenCalledExactlyOnceWith(workspace);
      for (const extra of [{ workspaceId: "other" }, { accountId: "other" }]) {
        expect(await rawRequest({ ...request, args: { ...request.args, ...extra } })).toMatchObject({ ok: false });
      }
      expect(await rawRequest({ ...request, args: { ...request.args, cwd: tempRoot } })).toMatchObject({ ok: false });
      expect(listRoster).toHaveBeenCalledOnce();
      now += 60_000;
      expect(await rawRequest(request)).toMatchObject({ ok: true, result: { status: "requested" } });
      expect(listRoster).toHaveBeenCalledTimes(2);
      context.access = undefined;
      for (const accessRequest of [request,
        { ...request, verb: "accessObject", args: { ...request.args, ref: { kind: "file", objectId: "file" } } },
        { ...request, verb: "accessSharing", args: { ...request.args, lane: "received" } },
      ]) expect(await rawRequest(accessRequest)).toMatchObject({ ok: false, error: "dohc: Access observations are unavailable." });
    } finally { rosters.close(workspace.workspaceId); }
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

  it("keeps CLI and MCP group listings available when one wire lookup rejects", async () => {
    const listed = await invoke("groups", { cwd: workspaceRoot, actor: "agent" });
    const original = store!.getChannelWireId.bind(store);
    const failedWire = listed.groups[0]!.channelWireId;
    vi.spyOn(store!, "getChannelWireId").mockImplementation(async input => {
      const wire = await original(input);
      if (wire === failedWire) throw Error("channel disappeared");
      return wire;
    });
    const groups = await invoke("groups", { cwd: workspaceRoot, actor: "agent" });
    expect(groups.groups[0]).toMatchObject({ channelWireId: null });
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: value => invoke(value.verb, value.args) };
    const full = await mcpListGroups(ctx);
    expect(full).toMatchObject({ ok: true });
    if (!full.ok) throw Error(full.reason);
    expect(full.groups.some(group => group.channelWireId === null)).toBe(true);
    const read = vi.fn<NonNullable<CliServerOptions["chatLinks"]>>(async () => null);
    serverOptions.chatLinks = read;
    expect(await invoke("chatLinks", { cwd: workspaceRoot, actor: "agent", group: listed.groups[0]!.name })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("syncs a joined shared channel before resolving the Links group operand", async () => {
    expect(await store!.findChannelBySlug({ workspaceId: WORKSPACE_ID, slug: "joined" })).toBeNull();
    let channelWireId: string | null = null;
    onReadEffect = async () => {
      const channel = await store!.createChannel({
        workspaceId: WORKSPACE_ID, name: "Joined",
      });
      channelWireId = await store!.getChannelWireId({ workspaceId: WORKSPACE_ID, channelId: channel.id });
      await makeChannelReadOnly(channel.id);
    };
    const read = vi.fn<NonNullable<CliServerOptions["chatLinks"]>>(async () => null);
    serverOptions.chatLinks = read;

    expect(await invoke("chatLinks", { cwd: workspaceRoot, actor: "agent", group: "joined" })).toBeNull();
    expect(channelWireId).toBeTruthy();
    expect(calls.reads).toBe(1);
    expect(readTargets).toEqual([{ channelId: "joined" }]);
    expect(read).toHaveBeenCalledExactlyOnceWith(registryWorkspace, { channelWireId, cursor: undefined });
  });

  it("discovers chat wire IDs through CLI and MCP before asking for Links", async () => {
    const groups = await invoke("groups", { cwd: workspaceRoot, actor: "agent" });
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: value => invoke(value.verb, value.args) };
    const full = await mcpListGroups(ctx);
    expect(full.ok).toBe(true);
    if (!full.ok) throw Error(full.reason);
    const channelWireId = groups.groups[0]!.channelWireId;
    expect(channelWireId).toBeTruthy();
    expect(full.groups.some(group => group.channelWireId === channelWireId)).toBe(true);
    const read = vi.fn<NonNullable<CliServerOptions["chatLinks"]>>(async () => null);
    serverOptions.chatLinks = read;
    const group = groups.groups[0]!;
    for (const target of [group.name, group.id, group.id.slice(0, -1)]) {
      const cli = await executeCli({
        argv: ["chat", "links", target], cwd: workspaceRoot, env: {},
        request: value => invoke(value.verb, value.args),
      });
      expect(cli.exitCode).toBe(0);
    }
    expect(await mcpChatLinks(ctx, { channelWireId: channelWireId! })).toBeNull();
    expect(read).toHaveBeenCalledTimes(4);
    for (const [, input] of read.mock.calls) expect(input.channelWireId).toBe(channelWireId);
  });

  it("labels success without changing token admission, read-only authority, actor gates or results", async () => {
    const recordSuccess = vi.fn();
    serverOptions.recordSuccess = recordSuccess;
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>(async files => ({ ok: true, written: files.map(file => file.path) }));
    context.writeFiles = writeFiles;
    context.documents = { read: async () => ({ path: "a.md", markdown: "" }), edit: async () => ({ path: "a.md", changed: true }), create: async () => ({ path: "a.md" }) };
    const args = { cwd: workspaceRoot, actor: "agent", requestId: "door", files: [{ path: "a.txt", contentBase64: "eA==" }] };
    const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite", args };
    const results = [];
    for (const door of ["cli", "mcp"] as const) {
      results.push(await rawRequest({ ...request, door }));
      expect(recordSuccess).toHaveBeenCalledTimes(1);
      expect(await rawRequest({ ...request, door, token: "0".repeat(64) })).toMatchObject({ ok: false, error: "dohc: CLI authentication failed" });
      registryWorkspace.readOnly = true;
      expect(await rawRequest({ ...request, door })).toMatchObject({ ok: false, error: "dohc: This workspace is read-only. Write in the owning workspace." });
      registryWorkspace.readOnly = false;
      expect(await rawRequest({ ...request, door, verb: "documentEdit", args: { cwd: workspaceRoot, actor: "human", path: "a.md", replacement: "x" } }))
        .toMatchObject({ ok: true, result: { ok: false } });
    }
    expect(results[0]).toEqual(results[1]);
    expect(writeFiles).toHaveBeenCalledTimes(2);
    expect(writeFiles.mock.calls[0]).toEqual(writeFiles.mock.calls[1]);
    expect(recordSuccess.mock.calls).toEqual([
      [{ capabilityId: "file.write", door: "cli" }],
    ]);
  });

  it("counts only validated successful commands, defaults missing labels to CLI and rejects unknown labels", async () => {
    const recordSuccess = vi.fn();
    serverOptions.recordSuccess = recordSuccess;
    context.keptCopies = { list: async () => ({ keptCopies: [], more: false }), save: vi.fn(async () => ({ status: "saved" as const, path: "kept.md" })) };
    const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "saveKeptCopy", args: { cwd: workspaceRoot, actor: "agent", id: 1 } };
    expect(await rawRequest(request)).toMatchObject({ ok: true, result: { status: "saved" } });
    expect(recordSuccess).toHaveBeenLastCalledWith({ capabilityId: "file.kept.save", door: "cli" });
    recordSuccess.mockClear();
    for (const door of ["unknown", "automation", "renderer"]) expect(await rawRequest({ ...request, door })).toMatchObject({ ok: false, error: "dohc: invalid CLI request" });
    for (const verb of ["usageRead", "usageQuery", "usageCopy"]) expect(await rawRequest({ ...request, verb })).toMatchObject({ ok: false });
    await invoke("groups", { cwd: workspaceRoot, actor: "agent" });
    await invoke("keptCopies", { cwd: workspaceRoot, actor: "agent" });
    vi.mocked(context.keptCopies.save).mockResolvedValueOnce({ status: "gone" });
    await rawRequest(request);
    vi.mocked(context.keptCopies.save).mockResolvedValueOnce({ status: "saved" } as Awaited<ReturnType<NonNullable<CliWorkspaceContext["keptCopies"]>["save"]>>);
    expect(await rawRequest(request)).toMatchObject({ ok: false });
    vi.mocked(context.keptCopies.save).mockRejectedValueOnce(new Error("failed"));
    await rawRequest(request);
    expect(recordSuccess).not.toHaveBeenCalled();
    recordSuccess.mockImplementationOnce(() => { throw new Error("measurement failed"); });
    expect(await rawRequest(request)).toMatchObject({ ok: true, result: { status: "saved" } });
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
      context.keptCopies = { list: async () => ({ keptCopies: [], more: false }), save: async () => ({ status: "saved", path: "kept.md" }) };
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

  it("receives a 10 MiB file through the socket and preserves partial batch results", async () => {
    if (!server) throw new Error("This test requires the CLI socket.");
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>(async files => ({ ok: true, written: files.map(file => file.path) }));
    context.writeFiles = writeFiles;
    const args = { cwd: workspaceRoot, actor: "agent" as const, requestId: "large", files: [{ path: "large.txt", contentBase64: Buffer.alloc(10 * 1024 * 1024, 97).toString("base64") }] };
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

  it("publishes the app created from a subfolder and returns caller-relative source paths", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    context.writeFiles = async files => {
      for (const file of files) {
        const absolute = join(workspaceRoot, file.path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, Buffer.from(file.contentBase64, "base64"));
      }
      return { ok: true, written: files.map(file => file.path) };
    };
    const ctx: ToolContext = { root: cwd, home: stateDir, request: request => invoke(request.verb, request.args) };
    expect(await createApp(ctx, { appRoot: "site" })).toMatchObject({ ok: true, appRoot: "site" });
    const publication = vi.fn<NonNullable<CliWorkspaceContext["appPublication"]>>(async request => {
      if (request.action !== "prepare") throw new Error("Expected prepare");
      await expect(readFile(join(workspaceRoot, request.appRoot, "index.html"), "utf8")).resolves.toContain("<!doctype html>");
      return { kind: "prepared", approvalId: "00000000-0000-4000-8000-000000000001",
        candidateDigest: "a".repeat(64), appRoot: request.appRoot, versionId: "version-site",
        sourceRevision: "b".repeat(64), sourcePaths: [request.appRoot + "/index.html", request.appRoot + "/styles.css"],
        capabilities: [], externalNetwork: true };
    });
    context.appPublication = publication;
    expect(await invoke("appPublication", { cwd, actor: "agent", request: {
      action: "prepare", workspaceId: WORKSPACE_ID, appRoot: "site", shareId: "share-site", grantId: "grant-site",
    } })).toMatchObject({ kind: "prepared", appRoot: "site", sourcePaths: ["site/index.html", "site/styles.css"] });
    expect(publication).toHaveBeenCalledWith(expect.objectContaining({ appRoot: "app/site" }), {kind:"agent",label:null,labelSource:"agent-declared"});
    publication.mockResolvedValueOnce({ kind: "published", publicationId: "c".repeat(64), authorityRevision: 1 });
    expect(await invoke("appPublication", { cwd, actor: "agent", request: {
      action: "approve", workspaceId: WORKSPACE_ID, approvalId: "00000000-0000-4000-8000-000000000001", candidateDigest: "a".repeat(64),
    } })).toEqual({ kind: "published", publicationId: "c".repeat(64), authorityRevision: 1 });
    publication.mockRejectedValueOnce(new Error("Cannot publish app/site/index.html"));
    await expect(invoke("appPublication", { cwd, actor: "agent", request: {
      action: "prepareLocal", workspaceId: WORKSPACE_ID, appRoot: "site",
    } })).rejects.toThrow("Cannot publish site/index.html");
    await expect(invoke("appPublication", { cwd, actor: "agent", request: {
      action: "listLocal", workspaceId: WORKSPACE_ID, appRoot: "../site",
    } })).rejects.toThrow("traversal");
    expect(publication).toHaveBeenCalledTimes(3);
  });

  it("refuses traversal in a fileWrite before cwd translation", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>();
    context.writeFiles = writeFiles;
    expect(await invoke("fileWrite", { cwd, actor: "agent", requestId: "traversal", files: [{ path: "../index.html", contentBase64: "" }] }))
      .toMatchObject({ ok: false, written: [], reason: expect.stringContaining("traversal") });
    expect(writeFiles).not.toHaveBeenCalled();
  });


  it("lists and reads changes at CLI and MCP after an Undo adds compensation moments", async () => {
    const operation = { workspace: { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot }, signal: new AbortController().signal, assertCurrent: vi.fn() };
    await openedLocalState(operation.workspace);
    await mkdir(join(workspaceRoot, "folder"));
    await writeFile(join(workspaceRoot, "folder/tracked.txt"), "original");
    const fixture = momentFixtures(WORKSPACE_ID, "tracked", SERVER_NOW_MS);
    fixture.summary.path = fixture.detail.path = "folder/tracked.txt";
    let changes = [fixture.summary];
    let details = [fixture.detail];
    const history = {readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),
      readHistoryPage: vi.fn(async () => ({ moments: [{ momentId: fixture.summary.id, operation: "delete", path: "folder/tracked.txt" }], nextCursor: null }) as never),
      undoHistoryOperation: vi.fn(async (input: { operationId: string }) => {
        const compensation = momentFixtures(WORKSPACE_ID, "undo", SERVER_NOW_MS + 1);
        compensation.summary.path = compensation.detail.path = "folder/tracked.txt";
        compensation.summary.metadata.correlationId = compensation.detail.metadata.correlationId = "dohc-operation:undo:hash";
        const malformed = momentFixtures(WORKSPACE_ID, "malformed", SERVER_NOW_MS - 1);
        malformed.summary.metadata.correlationId = malformed.detail.metadata.correlationId = "dohc-operation:bad";
        changes = [compensation.summary, ...changes, malformed.summary];
        details = [compensation.detail, ...details, malformed.detail];
        await mkdir(join(workspaceRoot, "folder"), { recursive: true });
        await writeFile(join(workspaceRoot, "folder/tracked.txt"), "original");
        return { operationId: input.operationId, versionId: "main", momentCount: 1, notRestored: [], compensationOperationId: "dohc-operation:undo:hash", materialized: true, deduped: false };
      }),
    };
    const removed = await deleteWorkspacePathByHand(operation, "folder", { kind: "human", humanId: "local:owner" }, {
      capture: { changePathsAs: async (_paths, _author, work) => work({
        policy: await readWorkspaceEnginePolicy(workspaceRoot), recordDisk: async () => ["folder/tracked.txt"], delete: async () => fixture.summary.id,
      } as never) }, requestId: "delete-for-list", trashItem: async () => { throw new Error("OS refused"); }, markDeleted: vi.fn(),
    });
    fixture.summary.metadata.correlationId = fixture.detail.metadata.correlationId = removed.operationId!;
    context.historyUndo = (input, origin) => undoWorkspaceHistoryOperation(operation, input, agentWriteAuthor(origin), { history, agent: true });
    context.historyOperation = input => readWorkspaceHistoryOperation(operation, input, history);
    context.listMoments = async () => changes;
    context.readMoment = async id => details.find(moment => moment.id === id) ?? null;
    const request = (request: import("@dohc/cli/protocol").CliRequestWithoutToken) => invoke(request.verb, request.args);
    expect(await executeCli({ argv: ["history", "undo", removed.operationId!], cwd: workspaceRoot, request })).toMatchObject({ exitCode: 0 });
    const listed = await executeCli({ argv: ["history", "list", "--json"], cwd: workspaceRoot, request });
    expect(listed.exitCode).toBe(0);
    const rows = JSON.parse(listed.stdout).changes;
    expect(rows).toHaveLength(3);
    expect(rows.find((row: { id: string }) => row.id === fixture.summary.id).operationId).toBe(removed.operationId);
    for (const id of ["moment_undo", "moment_malformed"]) expect(rows.find((row: { id: string }) => row.id === id)).not.toHaveProperty("operationId");
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request };
    expect(await listChanges(ctx)).toMatchObject({ changes: rows, count: 3 });
    for (const row of rows) {
      expect(await executeCli({ argv: ["history", "show", row.id, "--json"], cwd: workspaceRoot, request })).toMatchObject({ exitCode: 0 });
      const detail = await readChange(ctx, { id: row.id });
      expect(detail).toMatchObject({ ok: true, change: { id: row.id } });
      if (row.id !== fixture.summary.id && "change" in detail) expect(detail.change).not.toHaveProperty("operationId");
    }
    expect(history.undoHistoryOperation).toHaveBeenCalledOnce();
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
    const history = {readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),  readHistoryPage: vi.fn(async () => ({ moments: [{ momentId: "move", operation: "rename", path: "b.txt", beforePath: "a.txt" }], nextCursor: null }) as never),
      undoHistoryOperation: vi.fn(async () => { await rename(join(workspaceRoot, "b.txt"), join(workspaceRoot, "a.txt"));
        return { operationId, versionId: "main", deduped: false, materialized: true, momentCount: 1, notRestored: [], compensationOperationId: operationId }; }) };
    const operation = { workspace: { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot, get readOnly() { return context.readOnly; }, shareView: undefined as unknown }, signal: new AbortController().signal, assertCurrent: vi.fn() };
    context.historyOperation = input => readWorkspaceHistoryOperation(operation, input, history);
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
    expect(await invoke("historyUndo", { ...args, actor: "human" })).toMatchObject({ ok: false, reason: 'An Undo through the CLI socket is recorded as an agent\'s; send actor "agent".' });
    expect(context.historyUndo).not.toHaveBeenCalled();
    for (const verb of ["historyOperation", "historyUndo"] as const) {
      expect(await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { ...args, operationId: operationId.slice(15) } })).toMatchObject({ ok: false });
      context.readOnly = true;
      expect(await invoke(verb, args)).toMatchObject({ ok: false, reason: "History operations require the owning workspace. Open it to continue." });
      context.readOnly = false; operation.workspace.shareView = {};
      expect(await invoke(verb, args)).toMatchObject({ ok: false });
      operation.workspace.shareView = undefined;
      await mkdir(join(workspaceRoot, "shared-with-me"), { recursive: true });
      expect(await invoke(verb, { ...args, cwd: join(workspaceRoot, "shared-with-me") })).toMatchObject({ ok: false });
    }
  });

  it("returns missing-delete recovery words through the socket, CLI and MCP", async () => {
    const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
    const operation = { workspace: { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot }, signal: new AbortController().signal, assertCurrent: vi.fn() };
    const history = {readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),  readHistoryPage: vi.fn(async () => ({ moments: [{ operation: "delete", path: "a.txt" }], nextCursor: null }) as never), undoHistoryOperation: vi.fn() };
    context.historyOperation = input => readWorkspaceHistoryOperation(operation, input, history);
    context.historyUndo = (input, origin) => undoWorkspaceHistoryOperation(operation, input, agentWriteAuthor(origin), { history, agent: true });
    const refusal = { ok: false, reason: "Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash." };
    expect(await invoke("historyUndo", { cwd: workspaceRoot, actor: "agent", operationId })).toEqual(refusal);
    const request = (request: import("@dohc/cli/protocol").CliRequestWithoutToken) => invoke(request.verb, request.args);
    expect(await undoOperation({ root: workspaceRoot, home: stateDir, request }, { operationId })).toEqual(refusal);
    expect(await executeCli({ argv: ["history", "undo", operationId], cwd: workspaceRoot, request })).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: " + refusal.reason + "\n" });
    expect(history.undoHistoryOperation).not.toHaveBeenCalled();
  });

  it("keeps MCP moves and deletes relative to a subfolder cwd under the agent's name", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const movePath = vi.fn<NonNullable<CliWorkspaceContext["movePath"]>>(async input => ({ ok: true, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", undo: { available: true }, fromPath: input.fromPath, toPath: input.toPath }));
    const deletePath = vi.fn<NonNullable<CliWorkspaceContext["deletePath"]>>(async path => ({
      ok: false, deleted: [`${path}/a.txt`], path: `${path}/b.txt`, reason: `History could not record the delete of ${path}/b.txt.`,
    }));
    context.movePath = movePath;
    context.deletePath = deletePath;
    const ctx: ToolContext = { root: cwd, home: stateDir, request: request => invoke(request.verb, request.args) };
    expect(await moveWorkspacePath(ctx, { fromPath: "a.txt", toPath: "b.txt" }, "Client")).toEqual({ ok: true, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", undo: { available: true }, fromPath: "a.txt", toPath: "b.txt" });
    expect(await deleteWorkspacePath(ctx, { path: "notes" })).toEqual({
      ok: false, deleted: ["notes/a.txt"], path: "notes/b.txt", reason: "History could not record the delete of notes/b.txt.",
    });
    expect(movePath.mock.calls[0]?.slice(0, 2)).toEqual([{ fromPath: "app/a.txt", toPath: "app/b.txt" }, expect.objectContaining({ actorOriginId: "Client" })]);
    expect(deletePath.mock.calls[0]?.slice(0, 2)).toEqual(["app/notes", expect.objectContaining({ actorOriginId: "dohc-mcp" })]);
    // Every path a failure names reads as the caller spells it.
    movePath.mockResolvedValueOnce({ ok: false, path: "app/a.txt", deleted: ["app/dest/1.txt"],
      reason: "dohc could not move app/a.txt. It stays at app/dest, because something new is at app/a.txt." });
    expect(await moveWorkspacePath(ctx, { fromPath: "a.txt", toPath: "dest", overwrite: true })).toEqual({
      ok: false, path: "a.txt", deleted: ["dest/1.txt"],
      reason: "dohc could not move a.txt. It stays at dest, because something new is at a.txt.",
    });
  });

  it("rebases whole path tokens and descendants without rewriting ordinary words", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    context.deletePath = async path => ({ ok: true, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", undo: { available: true }, path, trashed: true });
    context.movePath = async () => ({ ok: false, path: "app/a",
      reason: "Cannot move app/a. app/apple and app/a.txt stay. app/a/child.txt stays too. It happened again. Choose app/a, then retry." });
    expect(await invoke("fileMove", { cwd, actor: "agent", requestId: "tokens", fromPath: "a", toPath: "b" })).toEqual({
      ok: false, path: "a", reason: "Cannot move a. apple and a.txt stay. a/child.txt stays too. It happened again. Choose a, then retry.",
    });
  });

  it.each(["fileMove", "fileDelete"] as const)("hides realpath host errors before %s dispatch", async verb => {
    context.rootPath = join(workspaceRoot, "missing-root");
    context.movePath = async input => ({ ok: true, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", undo: { available: true }, ...input });
    context.deletePath = async path => ({ ok: true, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111", undo: { available: true }, path, trashed: true });
    const args = { cwd: workspaceRoot, actor: "agent" as const, requestId: "realpath" };
    const result = verb === "fileMove" ? await invoke(verb, { ...args, fromPath: "a", toPath: "b" })
      : await invoke(verb, { ...args, path: "a" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("ENOENT") });
    expect(JSON.stringify(result)).not.toContain(workspaceRoot);
  });

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

  it("refuses a fileWrite envelope larger than 14 MiB before opening the workspace", async () => {
    if (!server) throw new Error("This test requires the CLI socket.");
    const opened = calls.openWorkspace;
    const response = await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite",
      args: { cwd: workspaceRoot, actor: "agent", requestId: "oversized", files: [{ path: "large.txt", contentBase64: "A".repeat(14 * 1024 * 1024) }] } });
    expect(response).toMatchObject({ ok: false, error: "dohc: CLI request exceeds 14 MiB. Split the files into smaller batches." });
    expect(calls.openWorkspace).toBe(opened);
  });

  it("routes app publication through the authenticated owning workspace without renderer access", async () => {
    let accepted: unknown;
    context.appPublication = async request => { accepted = request; return { kind: "cancelled" }; };
    const request = { action: "cancel" as const, workspaceId: WORKSPACE_ID, approvalId: "00000000-0000-4000-8000-000000000001" };
    expect(await invoke("appPublication", { cwd: workspaceRoot, actor: "agent", request })).toEqual({ kind: "cancelled" });
    expect(accepted).toEqual(request);
    accepted = undefined;
    await expect(invoke("appPublication", { cwd: workspaceRoot, actor: "agent", request: { ...request, workspaceId: "elsewhere" } })).rejects.toThrow("owning workspace");
    expect(accepted).toBeUndefined();
    context.readOnly = true;
    await expect(invoke("appPublication", { cwd: workspaceRoot, actor: "agent", request })).rejects.toThrow("owning workspace");
    expect(accepted).toBeUndefined();
  });


  it("routes response listing and undo through authenticated owner attachment", async () => {
    const calls:unknown[]=[];
    context.ownerAppResponses = async request => {
      calls.push(request);
      return request.action==="list"?{action:"list",acceptances:[],nextAcceptanceId:null}:{action:"undo",items:[],nextCursor:null};
    };
    const request={action:"list" as const,workspaceId:WORKSPACE_ID,grantId:"g",limit:100};
    expect(await invoke("ownerAppResponses",{cwd:workspaceRoot,actor:"agent",request})).toEqual({action:"list",acceptances:[],nextAcceptanceId:null});
    expect(await invoke("ownerAppResponses",{cwd:workspaceRoot,actor:"agent",request:{...request,action:"undo",operationId:"undo-a"}})).toEqual({action:"undo",items:[],nextCursor:null});
    await expect(invoke("ownerAppResponses",{cwd:workspaceRoot,actor:"agent",request:{...request,workspaceId:"elsewhere"}})).rejects.toThrow("owning workspace");
    context.readOnly=true;
    await expect(invoke("ownerAppResponses",{cwd:workspaceRoot,actor:"agent",request})).rejects.toThrow("owning workspace");
    expect(calls).toHaveLength(2);
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

  it.each(["approve", "approveMigration"] as const)("attributes owner-local dataset %s labels as agent-declared", async action => {
    context.dataset=vi.fn(async()=>({kind:"refused" as const,code:"expired",message:"expired"}));
    const request={...(action === "approveMigration" ? {action,approvalDigest:"b".repeat(64)} : {action}),workspaceId:WORKSPACE_ID,preparationId:"00000000-0000-4000-8000-000000000101",revisionSha256:"a".repeat(64),agentLabel:"Builder"};
    await invoke("dataset",{cwd:workspaceRoot,actor:"human",request});
    expect(context.dataset).toHaveBeenLastCalledWith(request,null);
    await invoke("dataset",{cwd:workspaceRoot,actor:"agent",request});
    expect(context.dataset).toHaveBeenLastCalledWith(request,{depth:0,approvalAgent:{kind:"agent",label:"Builder",labelSource:"agent-declared"}});
    await expect(invoke("dataset",{cwd:workspaceRoot,actor:"agent",request:{...request,workspaceId:"other"}})).rejects.toThrow("owning workspace");
    context.readOnly=true;
    await expect(invoke("dataset",{cwd:workspaceRoot,actor:"agent",request})).rejects.toThrow("owning workspace");
    expect(context.dataset).toHaveBeenCalledTimes(2);
    context.readOnly=false; agentRunDepth=2;
    await invoke("dataset",{cwd:workspaceRoot,actor:"human",request});
    expect(context.dataset).toHaveBeenLastCalledWith(request,{depth:2,approvalAgent:{kind:"agent",label:"Builder",labelSource:"agent-declared"}});
  });

  it("routes dataset actions through the same owner workspace attachment for humans and agents", async () => {
    context.dataset = vi.fn(async () => ({kind:"invoked" as const,result:{accepted:true},revision:1,replayed:false}));
    const request = {action:"invoke" as const,workspaceId:WORKSPACE_ID,datasetPath:"data/dataset.json",operationId:"00000000-0000-4000-8000-000000000002",revision:1,revisionSha256:"a".repeat(64),input:{name:"Equipment"},idempotencyKey:"create-1"};
    for (const actor of ["human","agent"] as const) expect(await invoke("dataset",{cwd:workspaceRoot,actor,request})).toEqual({kind:"invoked",result:{accepted:true},revision:1,replayed:false});
    // The person invokes as the owner; an agent that names itself is the agent, at 0 outside a chain.
    expect(vi.mocked(context.dataset).mock.calls.map(call => call[1])).toEqual([null,{depth:0}]);
    await expect(invoke("dataset",{cwd:workspaceRoot,actor:"agent",request:{...request,workspaceId:"elsewhere"}})).rejects.toThrow("owning workspace");
    context.readOnly = true;
    await expect(invoke("dataset",{cwd:workspaceRoot,actor:"agent",request})).rejects.toThrow("owning workspace");
    expect(context.dataset).toHaveBeenCalledTimes(2);
  });

  it("invokes a dataset action as the run's agent during a run an automation started, whoever the caller names", async () => {
    context.dataset = vi.fn(async () => ({kind:"invoked" as const,result:{accepted:true},revision:1,replayed:false}));
    const request = {action:"invoke" as const,workspaceId:WORKSPACE_ID,datasetPath:"data/dataset.json",operationId:"00000000-0000-4000-8000-000000000002",revision:1,revisionSha256:"a".repeat(64),input:{name:"Equipment"},idempotencyKey:"create-1"};
    agentRunDepth = 3;
    for (const actor of ["human","agent"] as const) await invoke("dataset",{cwd:workspaceRoot,actor,request});
    expect(vi.mocked(context.dataset).mock.calls.map(call => call[1])).toEqual([{depth:3},{depth:3}]);
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

  it("derives stop provenance for people, named agents, and agent runs", async () => {
    const stop = vi.fn<NonNullable<CliWorkspaceContext["stopSync"]>>(async () => ({ ok: true, workspaceId: WORKSPACE_ID, workspaceSynced: false }));
    context.stopSync = stop;
    await invoke("stopSync", { cwd: workspaceRoot, actor: "human" });
    expect(stop).toHaveBeenLastCalledWith(undefined);
    await invoke("stopSync", { cwd: workspaceRoot, actor: "agent", agent: "Claude" });
    expect(stop).toHaveBeenLastCalledWith({ kind: "agent", agentId: "Claude", onBehalfOf: "person-local", depth: 0 });
    agentRunDepth = 2;
    await invoke("stopSync", { cwd: workspaceRoot, actor: "human" });
    expect(stop).toHaveBeenLastCalledWith({ kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", depth: 2 });
    dispatchedRun = true;
    await invoke("stopSync", { cwd: workspaceRoot, actor: "agent", agent: "Claude" });
    expect(stop).toHaveBeenLastCalledWith({ kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", depth: 2 });
    context.readOnly = true;
    await expect(invoke("stopSync", { cwd: workspaceRoot, actor: "agent" })).rejects.toThrow("owning workspace");
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it("rejects older and newer CLIs before opening a workspace", async () => {
    for (const protocolVersion of [
      CLI_PROTOCOL_VERSION - 1,
      CLI_PROTOCOL_VERSION + 1,
    ]) {
      const response = await rawRequest({
        token,
        protocolVersion,
        verb: "groups",
        args: { cwd: workspaceRoot, actor: "human" },
      });

      expect(response).toEqual({
        protocolVersion: CLI_PROTOCOL_VERSION,
        ok: false,
        error: "dohc: CLI/app version mismatch — restart the app",
      });
    }
    expect(calls.openWorkspace).toBe(0);
  });

  it("rejects a cwd outside every registered workspace", async () => {
    const response = await rawRequest({
      token,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "groups",
      args: { cwd: stateDir, actor: "human" },
    });

    expect(response).toEqual({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: not inside a dohc workspace",
    });
    expect(calls.openWorkspace).toBe(0);
  });

  it("narrows history to one tracked file inside the workspace", async () => {
    const listed: Array<{ limit: number; objectId?: string }> = [];
    const moments = momentFixtures(WORKSPACE_ID, "primary", SERVER_NOW_MS);
    context.listMoments = async (input) => {
      listed.push(input);
      return [moments.summary];
    };
    await mkdir(join(workspaceRoot, "notes"), { recursive: true });

    await expect(invoke("moments", { cwd: workspaceRoot, actor: "human", path: "tracked.md" })).resolves.toMatchObject({
      changes: [{ id: "moment_primary" }],
    });
    await expect(invoke("moments", { cwd: join(workspaceRoot, "notes"), actor: "human", path: "../tracked.md" })).resolves.toMatchObject({
      count: 1,
    });
    expect(listed).toEqual([
      { limit: 500, objectId: "object_tracked" },
      { limit: 500, objectId: "object_tracked" },
    ]);

    await expect(invoke("moments", { cwd: workspaceRoot, actor: "human", path: "missing.md" })).rejects.toThrow(
      "file is not a tracked workspace file: missing.md",
    );
    await expect(invoke("moments", { cwd: workspaceRoot, actor: "human", path: "../outside.md" })).rejects.toThrow(
      "file is outside this workspace: ../outside.md",
    );
    expect(listed).toHaveLength(2);
  });

  it("returns MCP-shaped history and chats with engine ids that post and reply accept", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const linkedThread = await store.createThread({
      workspaceId: WORKSPACE_ID,
      title: "Tracked file discussion",
      linkedFile: {
        objectId: "object_tracked",
        pathHint: "before-rename.md",
      },
    });
    const linkedMessage = await store.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: linkedThread.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Read this linked chat",
    });
    context.filePathForObjectId = async (objectId) =>
      objectId === "object_tracked" ? "tracked.md" : null;

    const moments = await invoke("moments", {
      cwd: workspaceRoot,
      actor: "agent",
      includeFiles: true,
    });
    expect(moments).toMatchObject({
      count: 1,
      totalAvailable: 1,
      hasMore: false,
      cursorMs: SERVER_NOW_MS,
      changes: [{
        id: "moment_primary",
        path: "primary.md",
        files: [{ path: "primary.md", operation: "write" }],
      }],
    });
    expect("changes" in moments && moments.changes[0]).not.toHaveProperty("summary");
    const moment = await invoke("moment", {
      cwd: workspaceRoot,
      actor: "agent",
      id: "moment_primary",
    });
    expect(moment).toMatchObject({
      ok: true,
      change: {
        id: "moment_primary",
        before: null,
        after: { path: "primary.md", text: "# primary\n" },
      },
    });

    const fileChats = await invoke("fileChats", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "tracked.md",
    });
    expect(fileChats).toMatchObject({
      ok: true,
      path: "tracked.md",
      fileObjectId: "object_tracked",
      threads: [{
        id: linkedThread.id,
        title: "Tracked file discussion",
        linkedPathHint: "before-rename.md",
      }],
    });
    const chat = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: linkedThread.id,
    });
    expect(chat).toMatchObject({
      ok: true,
      thread: { id: linkedThread.id },
      messages: [{
        id: linkedMessage.id,
        threadId: linkedThread.id,
        authorKind: "human",
        authorDisplayName: "Sam",
      }],
      projection: {
        readOnly: true,
        text: expect.stringContaining("tracked.md"),
      },
    });

    const emptyChannels = await invoke("groupsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    expect(emptyChannels).toMatchObject({
      ok: true,
      groups: [{
        id: general.id,
        threadCount: 0,
        threads: [],
      }],
    });
    // The engine channel id from groupsFull opens a thread through the
    // canonical post verb: no MCP-only write path exists.
    const started = await invoke("post", {
      cwd: workspaceRoot,
      actor: "agent",
      group: general.id,
      title: "Raw id contract",
      attachments: [],
      needsDecision: false,
      body: "Opening through the engine channel id",
    });
    expect(started).toMatchObject({
      group: { name: "general", slug: "general", kind: "group" },
      title: "Raw id contract",
    });

    const listedChannels = await invoke("groupsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    if (!listedChannels.ok) throw new Error(listedChannels.reason);
    const startedThread = listedChannels.groups[0]?.threads[0];
    if (!startedThread) throw new Error("Posted thread is not listed");
    expect(startedThread).toMatchObject({ title: "Raw id contract", messageCount: 1 });
    expect(cliThreadId(startedThread.id)).toBe(started.threadId);

    const opening = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: startedThread.id,
    });
    if (!opening.ok) throw new Error(opening.reason);
    expect(opening.messages).toMatchObject([{
      threadId: startedThread.id,
      authorKind: "agent",
      authorDisplayName: "Nova",
      authorOwnerDisplayName: "Sam",
      body: "Opening through the engine channel id",
    }]);
    const openingMessageId = opening.messages[0]!.id;
    expect(cliMessageId(openingMessageId)).toBe(started.messageId);

    // The engine thread and message ids from chat drive the canonical reply.
    const replied = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: startedThread.id,
      to: openingMessageId,
      attachments: [],
      needsDecision: false,
      body: "Reply through the engine thread id",
    });
    expect(replied).toMatchObject({
      threadId: started.threadId,
      parentMessageId: started.messageId,
    });

    const reread = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: startedThread.id,
    });
    if (!reread.ok) throw new Error(reread.reason);
    expect(reread.messages[0]!.id).toBe(openingMessageId);
    expect(cliMessageId(reread.messages[1]!.id)).toBe(replied.messageId);
    expect(reread.messages[1]).toMatchObject({
      threadId: startedThread.id,
      authorKind: "human",
      authorDisplayName: "Sam",
      body: "Reply through the engine thread id",
    });
    // post provisions the default channels like the terminal CLI does, so
    // general is looked up by id rather than assumed to be the only channel.
    const relisted = await invoke("groupsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    if (!relisted.ok) throw new Error(relisted.reason);
    expect(relisted.groups.find((channel) => channel.id === general.id)).toMatchObject({
      threadCount: 1,
      threads: [{
        id: startedThread.id,
        title: "Raw id contract",
        messageCount: 2,
        updatedAtMs: reread.messages[1]!.createdAtMs,
      }],
    });

    expect(general.id).toMatch(/^channel-/u);
    expect(linkedThread.id).toMatch(/^thread-/u);
    expect(linkedMessage.id).toMatch(/^message-/u);
    expect(startedThread.id).toMatch(/^thread-/u);
    expect(openingMessageId).toMatch(/^message-/u);

    const persisted = await store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: startedThread.id,
    });
    expect(persisted.map((message) => ({
      kind: message.author.kind,
      displayName: message.author.displayName,
      authorUserId: message.authorUserId,
      origin: message.origin,
    }))).toEqual([
      {
        kind: "agent",
        displayName: "Nova",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
      {
        kind: "human",
        displayName: "Sam",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
    ]);
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

  // chatWrites.test.ts covers each gate. This proves post and reply hand
  // their resolved engine target to it, and that a refusal lands nothing.
  it("refuses post and reply by engine id in a read-only channel before any row", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    const existing = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Existing message",
    });
    await makeChannelReadOnly(general.id);

    await expect(invoke("post", {
      cwd: workspaceRoot,
      actor: "agent",
      group: general.id,
      attachments: [],
      needsDecision: false,
      body: "Must not land",
    })).rejects.toThrow("You can only read this.");
    await expect(invoke("reply", {
      cwd: workspaceRoot,
      actor: "agent",
      thread: existing.thread.id,
      attachments: [],
      needsDecision: false,
      body: "Must not land",
    })).rejects.toThrow("You can only read this.");
    expect(calls.writes).toBe(0);
    expect(writeTargets).toEqual([]);
    expect(await store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: existing.thread.id,
    })).toHaveLength(1);
  });

  it("keeps MCP chat reads available in read-only workspaces while refusing writes", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const channelChat = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      title: "Readable shared chat",
      author: { kind: "human", displayName: "Sam" },
      body: "Shared channel message",
    });
    const fileThread = await store.createThread({
      workspaceId: WORKSPACE_ID,
      title: "Readable shared file chat",
      linkedFile: {
        objectId: "object_tracked",
        pathHint: "tracked.md",
      },
    });
    await store.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: fileThread.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Shared file message",
    });
    registryWorkspace = { ...registryWorkspace, readOnly: true };
    context.readOnly = true;

    await expect(invoke("fileChats", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "tracked.md",
    })).resolves.toMatchObject({
      ok: true,
      threads: [{ id: fileThread.id }],
    });
    await expect(invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: fileThread.id,
    })).resolves.toMatchObject({
      ok: true,
      messages: [{ threadId: fileThread.id }],
    });
    await expect(invoke("groupsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    })).resolves.toMatchObject({
      ok: true,
      groups: [{
        id: general.id,
        threads: [{ id: channelChat.thread.id }],
      }],
    });

    const openCallsAfterReads = calls.openWorkspace;
    await expect(invoke("post", {
      cwd: workspaceRoot,
      actor: "agent",
      group: general.id,
      attachments: [],
      needsDecision: false,
      body: "Forbidden",
    })).rejects.toThrow("chats are not available in a read-only shared view");
    await expect(invoke("reply", {
      cwd: workspaceRoot,
      actor: "agent",
      thread: channelChat.thread.id,
      attachments: [],
      needsDecision: false,
      body: "Forbidden",
    })).rejects.toThrow("chats are not available in a read-only shared view");
    expect(calls.openWorkspace).toBe(openCallsAfterReads);
    expect(calls.identity).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it("does not provision or write chats in a read-only workspace", async () => {
    if (!store) throw new Error("Store is not available");
    await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    await rm(join(workspaceRoot, "AGENTS.md"));
    context.readOnly = true;
    chatRow.shareView = {
      shareId: "share", granterEmail: "owner@test.invalid", genericChatWritable: true,
      grantedSelector: { paths: ["notes"], versionId: null, access: "edit" },
    };

    const channels = await invoke("groups", {
      cwd: workspaceRoot,
      actor: "human",
    });
    expect(channels.groups.map((channel) => channel.slug)).toEqual(["general"]);
    await expect(post({
      actor: "human",
      title: "Forbidden",
      body: "Must not land",
    })).rejects.toThrow("Chats are read-only in this shared view.");
    expect(await store.listThreads({ workspaceId: WORKSPACE_ID })).toEqual([]);
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(invoke("export", {
      cwd: workspaceRoot,
      actor: "human",
      scope: { kind: "all" },
      outDir: "inside-export",
    })).rejects.toThrow("cannot export from a read-only shared view");
    await expect(stat(join(workspaceRoot, "inside-export"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(invoke("export", {
      cwd: workspaceRoot,
      actor: "human",
      scope: { kind: "all" },
      outDir: join(tempRoot, "outside-export"),
    })).rejects.toThrow("cannot export from a read-only shared view");
    await expect(stat(join(tempRoot, "outside-export"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(calls.identity).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it.each(["valid", "unsupported", "unbound"])("serves collection reads and diagnoses unsupported schemas: %s", async (state) => {
    const unsupported = state !== "valid";
    const recordId = "rec_abcdefghijklmnopqrstuvwxyz";
    const collection: Awaited<ReturnType<CliCollectionsPort["query"]>>["collection"] = unsupported
      ? { path: "tasks", objectId: "object-test", status: "degraded", reasons: [{ code: "unsupported-version", path: "/version" }] }
      : { path: "tasks", objectId: "object-test", status: "valid", reasons: [] };
    const queries: Array<Parameters<CliCollectionsPort["query"]>[0]> = [];
    const recordReads: Array<Parameters<CliCollectionsPort["getRecord"]>[0]> = [];
    context.collections = {
      writes: {
        async setFields() {
          throw new Error("unexpected collection write");
        },
        async createRecord() {
          throw new Error("unexpected collection write");
        },
      },
      async query(params) {
        queries.push(params);
        return {
          collection,
          records: [
            {
              id: recordId,
              path: "tasks/a.md",
              conflicted: false,
              values: [
                {
                  field: "estimate",
                  value: 9007199254740993n,
                  validation: { status: "untyped" },
                  resolvedRelations: [],
                },
              ],
            },
          ],
          groups: null,
          nextCursor: null,
        };
      },
      async getRecord(params) {
        recordReads.push(params);
        if (state === "unbound") throw new Error("collection-record-not-found");
        return {
          collection,
          record: {
            id: recordId,
            path: "tasks/a.md",
            conflicted: false,
            values: [],
          },
          history: [
            {
              historyId: 7,
              field: "estimate",
              previous: { present: false, value: null },
              next: { present: true, value: 9007199254740993n },
              authorOriginId: "origin_agent",
              actorKind: "agent" as const,
              onBehalfOf: "person-local",
              depth: 0,
              recordedAtMs: SERVER_NOW_MS,
              automationRun: null,
              linkAuthor: null,
            },
          ],
          nextBeforeHistoryId: null,
        };
      },
    };

    // The filter value arrives marker-encoded and reaches the engine port as
    // a real 64-bit integer; the result value leaves marker-encoded again.
    if (unsupported) {
      const expected = { ok: false, reason: "tasks/collection.yaml uses a newer version. Update dohc to read this file." };
      await expect(invoke("collectionQuery", { cwd: workspaceRoot, actor: "agent", collectionPath: "tasks" })).resolves.toEqual(expected);
      await expect(invoke("collectionRecord", { cwd: workspaceRoot, actor: "agent", collectionPath: "tasks", recordId, historyLimit: 25 })).resolves.toEqual(expected);
      return;
    }
    await expect(invoke("collectionQuery", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
      filter: {
        field: "estimate",
        operator: "equals",
        value: { $dohcInt64: "9007199254740993" },
      },
      limit: 10,
    })).resolves.toMatchObject({
      ok: true,
      records: [
        {
          id: recordId,
          values: [
            { field: "estimate", value: { $dohcInt64: "9007199254740993" } },
          ],
        },
      ],
    });
    expect(queries).toEqual([
      {
        collectionPath: "tasks",
        filter: {
          field: "estimate",
          operator: "equals",
          value: 9007199254740993n,
        },
        limit: 10,
      },
    ]);

    await expect(invoke("collectionRecord", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
      recordId,
      historyLimit: 25,
    })).resolves.toMatchObject({
      ok: true,
      history: [
        {
          historyId: 7,
          previous: { present: false, value: null },
          next: { present: true, value: { $dohcInt64: "9007199254740993" } },
          authorOriginId: "origin_agent",
        },
      ],
    });
    expect(recordReads).toEqual([
      { collectionPath: "tasks", recordId, historyLimit: 25 },
    ]);
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

    // A changed automation is refused until the caller confirms starting over.
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

  it("reads the runs of the workspace's server, including one its rebuilt copy says may not have been sent", async () => {
    const trigger = { kind: "added" as const, recordId: "rec_1", by: "human" as const, sharedAuthor: null, depth: 0 };
    const ran = { claimId: "atc_server", state: "done" as const, error: null, createdAtMs: 3, updatedAtMs: 4, trigger,
      definitionChanged: false, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false,
      writes: [{ kind: "field" as const, recordId: "rec_1", path: "tasks/one.md", field: "Status", before: "Open", after: "Paid" }] };
    // The server lost its copy after this run changed it; the rebuilt copy keeps only this mark of it.
    const lost = { ...ran, claimId: "atc_lost", state: "failed" as const, writes: [], unsentChangesLost: true as const,
      trigger: { kind: null, recordId: null, by: null, sharedAuthor: null, depth: 0 },
      error: "Your server lost its copy of this workspace and may not have sent this run's latest changes. Check the records it changed." };
    const pages = new Map([[undefined, { runs: [ran], next: "lost:2:1:atc_lost" }], ["lost:2:1:atc_lost", { runs: [lost], next: null }]]);
    context.automations = {
      automationIdAt: vi.fn(async (_collectionPath: string, id: string) => `collection:object-tasks#${id}`),
      runs: vi.fn(), run: vi.fn(), retry: vi.fn(),
      serverRuns: vi.fn(async (_automationId: string, before?: string) => pages.get(before) ?? null),
      serverRun: vi.fn(async (_automationId: string, claimId: string) => [ran, lost].find((run) => run.claimId === claimId) ?? null),
    };
    const args = { cwd: workspaceRoot, actor: "agent" as const, collectionPath: "tasks", automation: "stamp", server: true };
    const fields = { error: lost.error, createdAtMs: 3, updatedAtMs: 4, trigger: lost.trigger, definitionChanged: false, neverStarted: false,
      chainStopped: false, undone: false };
    await expect(invoke("automationRuns", args)).resolves.toMatchObject({ ok: true, runs: [{ run: "atc_server", changes: 1 }], next: "lost:2:1:atc_lost" });
    await expect(invoke("automationRuns", { ...args, page: "lost:2:1:atc_lost" })).resolves.toEqual({
      ok: true, runs: [{ run: "atc_lost", state: "failed", ...fields, unsentChangesLost: true, changes: 0 }], next: null,
    });
    expect(context.automations.serverRuns).toHaveBeenLastCalledWith("collection:object-tasks#stamp", "lost:2:1:atc_lost");
    await expect(invoke("automationRun", { ...args, run: "atc_lost" })).resolves.toEqual({
      ok: true, run: { run: "atc_lost", state: "failed", ...fields, unsentChangesLost: true, server: true, changes: [] },
    });
    await expect(invoke("automationRun", { ...args, run: "atc_server" })).resolves.toMatchObject({
      ok: true, run: { run: "atc_server", server: true, changes: ran.writes },
    });
    await expect(invoke("automationRun", { ...args, run: "atc_gone" })).resolves.toEqual({
      ok: false, reason: "Your server has no run atc_gone of this automation that this computer can read.",
    });
    expect(context.automations.runs).not.toHaveBeenCalled();
    expect(context.automations.run).not.toHaveBeenCalled();
    await expect(invoke("automationRuns", { ...args, page: "unknown" })).resolves.toEqual({
      ok: false, reason: "Your server has no runs in this workspace that this computer can read.",
    });
  });


  it("gives share agents the definition list and switch seam, including pending results", async () => {
    context.readOnly = true;
    const definitions = { file: { status: "read" as const, entries: [] }, contentHash: "a".repeat(64), canSwitch: true,
      sync: "pending" as const };
    const switched = { status: "written" as const, contentHash: "b".repeat(64), sync: "pending" as const };
    const list = vi.fn(async () => definitions), toggle = vi.fn(async () => switched);
    context.automations = { automationIdAt: vi.fn(), runs: vi.fn(), run: vi.fn(), serverRuns: vi.fn(), serverRun: vi.fn(), retry: vi.fn(), list, switch: toggle };
    const args = { cwd: workspaceRoot, actor: "agent" as const, collectionPath: "tasks" };
    await expect(invoke("automationList", args)).resolves.toEqual({ ok: true, definitions });
    await expect(invoke("automationSwitch", { ...args, automation: "stamp", enabled: false, expectedContentHash: "a".repeat(64), reformat: true, submitId: "switch-1" })).resolves.toEqual({ ok: true, result: switched });
    expect(toggle).toHaveBeenCalledWith("tasks", expect.objectContaining({ automation: "stamp", enabled: false, reformat: true, submitId: "switch-1" }));
  });

  it("returns partial record facts and passes the retry identity to the write seam", async () => {
    const partial = {
      kind: "partial" as const, created: ["tasks/retry.md"], failedStage: "settle" as const, reason: "settle failed",
      retry: { mode: "resume" as const, recordId: "rec_abcdefghijklmnopqrstuvwxyz", instruction: "Try again with this record ID." },
    };
    const createRecord = vi.fn<CliCollectionWriteSeam["createRecord"]>()
      .mockResolvedValueOnce(partial).mockResolvedValue({ path: "tasks/retry.md", recordId: partial.retry.recordId, kept: { status: "done" } });
    context.collections = { query: vi.fn(), getRecord: vi.fn(), writes: { setFields: vi.fn(), createRecord } };
    const args = { cwd: workspaceRoot, actor: "agent" as const, collectionPath: "tasks", name: "retry", fields: { status: "open" } };
    const result = await invoke("collectionCreateRecord", args);
    expect(result).toMatchObject({ ok: false, partial });
    expect(result).toHaveProperty("reason", expect.stringContaining("tasks/retry.md"));
    await expect(invoke("collectionCreateRecord", { ...args, recordId: partial.retry.recordId })).resolves.toMatchObject({ ok: true, recordId: partial.retry.recordId, kept: { status: "done" } });
    expect(createRecord.mock.calls[1]![0]).toMatchObject({ recordId: partial.retry.recordId, fields: args.fields });
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

    // The seam sees plain JSON fields and a main-derived author; the request
    // can claim only the behavior-bearing actor kind.
    expect(seamCalls).toEqual([
      {
        kind: "setFields",
        input: {
          recordPath: "tasks/a.md",
          fields: { status: "done", notes: null },
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

  it("lists kept copies and saves one for an agent, the step a person takes from Notices", async () => {
    let kept = [{ id: 3, path: "notes/plan.md", keptAtMs: 10 }];
    context.keptCopies = {
      async list() {
        return { keptCopies: kept, more: false, outsideWriteCopies: [["n.md", "n (kept copy).md", "copy-n-1"]] };
      },
      async save(id) {
        const found = kept.some((copy) => copy.id === id);
        kept = kept.filter((copy) => copy.id !== id);
        return found
          ? { status: "saved", path: "notes/plan (kept copy).md" }
          : { status: "gone" };
      },
    };

    await expect(invoke("keptCopies", { cwd: workspaceRoot, actor: "agent" })).resolves.toEqual({
      ok: true,
      keptCopies: [{ id: 3, path: "notes/plan.md", keptAtMs: 10 }],
      outsideWriteCopies: [["n.md", "n (kept copy).md", "copy-n-1"]],
      more: false,
    });
    await expect(invoke("saveKeptCopy", { cwd: workspaceRoot, actor: "agent", id: 3 }))
      .resolves.toEqual({ ok: true, status: "saved", path: "notes/plan (kept copy).md" });
    expect(calls.writes).toBe(1);
    await expect(invoke("saveKeptCopy", { cwd: workspaceRoot, actor: "agent", id: 3 }))
      .resolves.toEqual({ ok: true, status: "gone" });
    expect(calls.writes).toBe(1);
    await expect(invoke("keptCopies", { cwd: workspaceRoot, actor: "agent" }))
      .resolves.toEqual({ ok: true, keptCopies: [], more: false, outsideWriteCopies: [["n.md", "n (kept copy).md", "copy-n-1"]] });

    delete context.keptCopies;
    await expect(invoke("keptCopies", { cwd: workspaceRoot, actor: "agent" })).resolves.toEqual({
      ok: false,
      reason: "kept copies are not available in this workspace",
    });
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

  it("answers whether Collection updates wait with the engine's own answer", async () => {
    const answers = [true, false];
    context.daemonReads.collectionsWaiting = async () => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error("engine stopped");
      return answer;
    };
    for (const waiting of [true, false]) {
      await expect(invoke("collectionsWaiting", { cwd: workspaceRoot, actor: "agent" }))
        .resolves.toEqual({ ok: true, waiting });
    }
    await expect(invoke("collectionsWaiting", { cwd: workspaceRoot, actor: "agent" }))
      .resolves.toMatchObject({ ok: false });
  });

  it("reads and edits documents with provenance the door derives", async () => {
    const edits: Array<Parameters<CliDocumentsPort["edit"]>[0]> = [];
    context.documents = {
      async read(path) {
        return { path, markdown: "# Plan\n\nDraft." };
      },
      async edit(input) {
        edits.push(input);
        return { path: input.path, changed: true };
      },
      async create() {
        throw new Error("creates are not under test");
      },
    };

    await expect(invoke("documentRead", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "notes/plan.md",
    })).resolves.toEqual({ ok: true, path: "notes/plan.md", markdown: "# Plan\n\nDraft." });
    await expect(invoke("documentEdit", {
      cwd: workspaceRoot,
      actor: "agent",
      agent: "claude-code",
      path: "notes/plan.md",
      find: "Draft.",
      replacement: "Final.",
    })).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    await expect(invoke("documentEdit", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "notes/plan.md",
      replacement: "Appended.",
    })).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    // An agent that names itself is recorded under that name, and one that
    // does not uses the unnamed agent label.
    const agent = { actorKind: "agent", onBehalfOf: "person-local", depth: 0 };
    expect(edits).toEqual([
      {
        path: "notes/plan.md",
        edit: { find: "Draft.", replacement: "Final." },
        origin: { actorOriginId: "claude-code", attribution: agent },
      },
      {
        path: "notes/plan.md",
        edit: { find: undefined, replacement: "Appended." },
        origin: { actorOriginId: "dohc-mcp", attribution: agent },
      },
    ]);
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

  it("maps change-list paths and preserves root errors without any path mappings", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const moments = momentFixtures(WORKSPACE_ID, "primary", SERVER_NOW_MS);
    context.listMoments = async () => [{ ...moments.summary, path: "app/notes.md" }];
    await expect(invoke("moments", { cwd, actor: "agent" })).resolves.toMatchObject({ changes: [{ path: "notes.md" }] });
    context.dataset = vi.fn(async () => ({ kind: "refused" as const, code: "unavailable", message: "Cannot open (missing)" }));
    await expect(invoke("dataset", { cwd: workspaceRoot, actor: "agent", request: { action: "list", workspaceId: WORKSPACE_ID } })).resolves.toMatchObject({ message: "Cannot open (missing)" });
  });

  it("returns a change path relative to the caller at the root and in a subfolder", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const moments = momentFixtures(WORKSPACE_ID, "primary", SERVER_NOW_MS);
    context.readMoment = async () => ({ ...moments.detail, path: "app/notes.md", payload: { before: { ...moments.detail.payload.after!, path: "app/old.md" }, after: { ...moments.detail.payload.after!, path: "app/notes.md" } } });
    await expect(invoke("moment", { cwd, actor: "agent", id: moments.detail.id })).resolves.toMatchObject({ change: { path: "notes.md", before: { path: "old.md" }, after: { path: "notes.md" } } });
    await expect(invoke("moment", { cwd: workspaceRoot, actor: "agent", id: moments.detail.id })).resolves.toMatchObject({ change: { path: "app/notes.md", before: { path: "app/old.md" }, after: { path: "app/notes.md" } } });
  });

  it("rebases both file chat verbs from a subfolder", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    context.fileObjectIdForPath = vi.fn(async path => path === "app/notes.md" ? "object_subfolder" : null);
    context.filePathForObjectId = vi.fn(async objectId => objectId === "object_subfolder" ? "app/notes.md" : null);
    const started = await invoke("fileChatStart", { cwd, actor: "agent", path: "notes.md", title: "Subfolder", body: "Comment" });
    expect(started).toMatchObject({ ok: true, path: "notes.md" });
    await expect(invoke("fileChats", { cwd, actor: "agent", path: "notes.md" })).resolves.toMatchObject({ ok: true, path: "notes.md", fileObjectId: "object_subfolder", threads: [{ linkedPathHint: "notes.md" }] });
    expect(context.fileObjectIdForPath).toHaveBeenCalledWith("app/notes.md");
    await expect(invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path: "notes.md" })).resolves.toMatchObject({ ok: true, threads: [] });
    await expect(invoke("fileChatStart", { cwd, actor: "agent", path: "missing.md", title: "Missing", body: "Comment" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("does not track missing.md") });
  });

  it("preserves absolute recovery export destinations for writer validation", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const savePath = join(tempRoot, "backup.dohc-recovery");
    const dataset = vi.fn(async () => ({ kind: "exported" as const, savedPath: savePath }));
    context.dataset = dataset;
    for (const folder of [cwd, workspaceRoot]) {
      await expect(invoke("dataset", { cwd: folder, actor: "agent", request: { action: "export", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", savePath } })).resolves.toEqual({ kind: "exported", savedPath: savePath });
    }
    dataset.mockClear();
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "export", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", savePath: "backup.dohc-recovery" } })).resolves.toMatchObject({ kind: "refused", code: "path_rejected" });
    expect(dataset).not.toHaveBeenCalled();
    context.dataset = vi.fn(async () => ({ kind: "refused" as const, code: "unavailable", message: "Cannot open " + savePath }));
    for (const folder of [cwd, workspaceRoot]) {
      await expect(invoke("dataset", { cwd: folder, actor: "agent", request: { action: "describe", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json" } })).resolves.toMatchObject({ message: "Cannot open " + savePath });
    }
    const absoluteWorkspacePath = join(workspaceRoot, "data", "dataset.json");
    context.dataset = vi.fn(async () => ({ kind: "refused" as const, code: "unavailable", message: "Cannot open " + absoluteWorkspacePath }));
    await expect(invoke("dataset", { cwd: workspaceRoot, actor: "agent", request: { action: "describe", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json" } })).resolves.toMatchObject({ message: "Cannot open " + absoluteWorkspacePath });
  });

  it("refuses colon segments for read, write, materialize, and chat paths", async () => {
    for (const path of ["C:foo.md", "folder/C:foo.md", "foo:bar.md", ...(process.platform === "win32" ? [] : ["C:/foo.md"])]) {
      await expect(invoke("documentRead", { cwd: workspaceRoot, actor: "agent", path })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("colon") });
      await expect(invoke("documentEdit", { cwd: workspaceRoot, actor: "agent", path, replacement: "Wrong" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("colon") });
      await expect(invoke("documentCreate", { cwd: workspaceRoot, actor: "agent", path, markdown: "Wrong" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("colon") });
      await expect(invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("colon") });
      await expect(invoke("fileChatStart", { cwd: workspaceRoot, actor: "agent", path, title: "Wrong", body: "Wrong" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("colon") });
      await expect(invoke("moments", { cwd: workspaceRoot, actor: "agent", path })).rejects.toThrow("colon");
      await expect(invoke("export", { cwd: workspaceRoot, actor: "agent", scope: { kind: "all" }, outDir: path })).rejects.toThrow("colon");
      await expect(invoke("post", { cwd: workspaceRoot, actor: "agent", group: "general", body: "Wrong", attachments: [path], needsDecision: false })).rejects.toThrow("colon");
      await expect(invoke("reply", { cwd: workspaceRoot, actor: "agent", thread: "thread", body: "Wrong", attachments: [path], needsDecision: false })).rejects.toThrow("colon");
      await expect(invoke("appPublication", { cwd: workspaceRoot, actor: "agent", request: { action: "listLocal", workspaceId: WORKSPACE_ID, appRoot: path } })).rejects.toThrow("colon");
      for (const action of ["prepareRecovery", "export"] as const) {
        const request = action === "prepareRecovery" ? { action, workspaceId: WORKSPACE_ID, sourcePath: path } : { action, workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", savePath: path };
        await expect(invoke("dataset", { cwd: workspaceRoot, actor: "agent", request })).resolves.toMatchObject({ kind: "refused", code: "path_rejected", message: expect.stringContaining("colon") });
      }
    }
  });

  it("rebases automation paths while preserving planned, current, and undo JSON", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    const payload = { path: "app/notes.md", reason: "Keep app/notes.md" };
    const kept = { kind: "kept" as const, recordId: "rec_1", path: "app/tasks/a.md", field: "Data", planned: payload, current: payload };
    const action = { kind: "dataset-action" as const, rules: { datasetId: "dataset", revision: 1, revisionSha256: "hash" }, operationId: "operation", tableId: "table", name: "Save", revision: 1, undo: payload };
    context.automations = {
      automationIdAt: vi.fn(async () => "collection:app-tasks#stamp"),
      runs: vi.fn(),
      serverRuns: vi.fn(),
      serverRun: vi.fn(),
      retry: vi.fn(),
      run: vi.fn(async () => ({ claimId: "atc_1", state: "done" as const, error: null, createdAtMs: 1, updatedAtMs: 2, trigger: { kind: "changed" as const, recordId: "rec_1", by: "agent" as const, sharedAuthor: null, depth: 1 }, definitionChanged: false, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false, steps: [{ step: 1, writes: [kept, action] }], failedStep: null, startsOver: false })),
    };
    await expect(invoke("automationRun", { cwd, actor: "agent", collectionPath: "tasks", automation: "stamp", run: "atc_1" })).resolves.toMatchObject({ ok: true, run: { steps: [{ changes: [{ ...kept, path: "tasks/a.md" }, action] }] } });
    expect(context.automations.automationIdAt).toHaveBeenLastCalledWith("app/tasks", "stamp");
    context.buttons = { inspect: vi.fn(async () => []), press: vi.fn(async () => ({ result: { busy: false as const, relayed: true as const }, waiting: null })) };
    await expect(invoke("automationPress", { cwd, actor: "agent", collectionPath: "tasks", field: "Save", record: "rec_1", confirm: [] })).resolves.toEqual({ ok: true, relayed: true });
    expect(context.buttons.press).toHaveBeenLastCalledWith(expect.objectContaining({ collectionPath: "app/tasks" }), expect.anything());
  });

  it("rebases dataset descriptor, migration, export, and form paths", async () => {
    const cwd = join(workspaceRoot, "app");
    await mkdir(cwd);
    context.dataset = vi.fn(async request => request.action === "export"
      ? { kind: "exported" as const, savedPath: request.savePath ?? null }
      : { kind: "refused" as const, code: "unavailable", message: "Cannot open app/data/dataset.json" });
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "export", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", savePath: join(tempRoot, "backup.dohc-recovery") } })).resolves.toEqual({ kind: "exported", savedPath: join(tempRoot, "backup.dohc-recovery") });
    expect(context.dataset).toHaveBeenLastCalledWith(expect.objectContaining({ datasetPath: "app/data/dataset.json", savePath: join(tempRoot, "backup.dohc-recovery") }), { depth: 0 });
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "describe", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json" } })).resolves.toMatchObject({ kind: "refused", message: "Cannot open data/dataset.json" });
    context.dataset = vi.fn(async () => ({ kind: "refused" as const, code: "custom_rules", message: "Update app/data/operations.js to change a field." }));
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "describe", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json" } })).resolves.toMatchObject({ message: "Update data/operations.js to change a field." });
    context.dataset = vi.fn(async () => { throw new DatasetSchemaChangeError("notes.md uses custom rules. Update shared/my rules.js, then choose Review source change.", ["shared/my rules.js"]); });
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "describe", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json" } })).rejects.toThrow("notes.md uses custom rules. Update ../shared/my rules.js, then choose Review source change.");
    context.dataset = vi.fn(async () => ({ kind: "refused" as const, code: "unavailable", message: "Unavailable" }));
    await invoke("dataset", { cwd, actor: "agent", request: { action: "prepare", workspaceId: WORKSPACE_ID, descriptorPath: "data/dataset.json" } });
    expect(context.dataset).toHaveBeenLastCalledWith(expect.objectContaining({ descriptorPath: "app/data/dataset.json" }), { depth: 0 });
    await invoke("dataset", { cwd, actor: "agent", request: { action: "prepareMigration", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", migrationPath: "migration.sql" } });
    expect(context.dataset).toHaveBeenLastCalledWith(expect.objectContaining({ migrationPath: "app/migration.sql" }), { depth: 0 });
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "export", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", savePath: "../export.zip" } })).resolves.toMatchObject({ kind: "refused", message: expect.stringContaining("../export.zip") });
    await invoke("dataset", { cwd, actor: "agent", request: { action: "prepareRecovery", workspaceId: WORKSPACE_ID, sourcePath: "backup.dohc-recovery" } });
    expect(context.dataset).toHaveBeenLastCalledWith(expect.objectContaining({ sourcePath: join(cwd, "backup.dohc-recovery") }), { depth: 0 });
    context.dataset = vi.fn(async () => ({ kind: "form-created" as const, appRoot: "app/form", paths: ["app/form/index.html", "app/form/app.json"] }));
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "createForm", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", revision: 1, revisionSha256: "a".repeat(64), tableId: "00000000-0000-4000-8000-000000000001", createOperationId: "00000000-0000-4000-8000-000000000002", appRoot: "form", fieldIds: ["00000000-0000-4000-8000-000000000003"] } })).resolves.toEqual({ kind: "form-created", appRoot: "form", paths: ["form/index.html", "form/app.json"] });
    expect(context.dataset).toHaveBeenLastCalledWith(expect.objectContaining({ appRoot: "app/form" }), { depth: 0 });
    const payload = { path: "app/notes.md", reason: "Keep app/notes.md" };
    context.dataset = vi.fn(async () => ({ kind: "invoked" as const, result: payload, revision: 1, replayed: false }));
    await expect(invoke("dataset", { cwd, actor: "agent", request: { action: "invoke", workspaceId: WORKSPACE_ID, datasetPath: "data/dataset.json", operationId: "00000000-0000-4000-8000-000000000002", revision: 1, revisionSha256: "a".repeat(64), input: payload, idempotencyKey: "stable" } })).resolves.toMatchObject({ result: payload });

  });

  it("resolves document CLI paths from the caller's folder and refuses workspace escapes", async () => {
    const cwd = join(workspaceRoot, "notes");
    await mkdir(cwd);
    const paths: string[] = [];
    context.documents = {
      async read(path) { paths.push(path); return { path, markdown: "Live text" }; },
      async edit({ path }) { paths.push(path); return { path, changed: true }; },
      async create({ path }) { paths.push(path); return { path }; },
    };
    for (const verb of ["read", "edit", "create"]) {
      for (const path of ["plan.md", "../root.md", join(cwd, "absolute.md"), "../../outside.md", "../.dohc/private.md"]) {
        const result = await executeCli({
          argv: ["document", verb, path, ...(verb === "read" ? [] : ["--text", "Body"])], cwd,
          request: (request) => invoke(request.verb, request.args),
        });
        expect(result.exitCode, result.stderr).toBe(path === "plan.md" ? 0 : 1);
      }
    }
    expect(paths).toEqual(Array.from({ length: 3 }, () => ["notes/plan.md"]).flat());
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
    dispatchedRun = true;

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
    const woken = { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", depth: 3 };
    const attribution = { actorKind: "agent", onBehalfOf: "person-local", depth: 3 };
    expect(authors).toEqual([
      woken,
      woken,
      woken,
      woken,
      { actorOriginId: "dohc-mcp", attribution },
      { actorOriginId: "dohc-mcp", attribution },
    ]);
  });

  it("writes records for the settled account while a credential reload reads the store", async () => {
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
    // Main's wiring: the person is the account the credential cache last settled on.
    const authorship = createLocalAuthorship({ installationId: () => "local:installation", loadCredentials: async () => null });
    const credentials = new CredentialSessionCache<{ userId: string }>((snapshot, settled) => {
      if (settled) authorship.credentialsSettled(snapshot.credentials?.userId ?? null);
    });
    credentials.set({ userId: "account-alice" });
    serverOptions.localPersonId = () => authorship.personId();
    const reload = deferred<{ userId: string } | null>();
    const reloading = credentials.refresh(() => reload.promise);
    // The reload has published its placeholder null and is still reading.
    expect(credentials.snapshot().credentials).toBeNull();
    await invoke("collectionSetFields", { cwd: workspaceRoot, actor: "agent", recordPath: "tasks/a.md", fields: { status: "done" } });
    await invoke("collectionCreateRecord", { cwd: workspaceRoot, actor: "agent", collectionPath: "tasks", name: "b", fields: {} });
    reload.resolve({ userId: "account-alice" });
    await reloading;
    const agent = { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "account-alice", depth: 0 };
    expect(authors).toEqual([agent, agent]);
  });

  it("posts, replies, and reacts as the agent during a run an automation started, whatever actor the caller names", async () => {
    if (!store) throw new Error("Store is not available");
    agentRunDepth = 3;
    const posted = await post({ actor: "human", title: "Stamped", body: "Stamped the tasks." });
    await invoke("reply", {
      cwd: workspaceRoot, actor: "human", thread: posted.threadId, body: "Done.",
      attachments: [], needsDecision: false,
    });
    await invoke("react", { cwd: workspaceRoot, actor: "human", message: posted.messageId, emoji: "👍" });
    const threadId = `thread-${posted.threadId.slice("th_".length)}`;
    const messages = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId });
    expect(messages.map((message) => message.author.kind)).toEqual(["agent", "agent"]);
    const reactions = await store.listReactions({ workspaceId: WORKSPACE_ID, threadId });
    expect(reactions.map((reaction) => reaction.author.kind)).toEqual(["agent"]);

    // A person's run, or none, leaves the caller's actor as it is.
    agentRunDepth = 0;
    const own = await post({ actor: "human", title: "Mine", body: "My own post." });
    const [mine] = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId: `thread-${own.threadId.slice("th_".length)}` });
    expect(mine?.author.kind).toBe("human");
  });

  it("attributes a live run's reply to the agent and refuses its nested writable workspace", async () => {
    const posted = await post({ actor: "human", title: "Test", body: "Check." });
    serverOptions.agentRunWorkspace = (runId) => runId === "run_live" ? WORKSPACE_ID : undefined;
    const args = { cwd: workspaceRoot, actor: "human", thread: posted.threadId, body: "Done.", attachments: [], needsDecision: false, runId: "run_live" } as const;
    await invoke("reply", { ...args, attachments: [] });
    expect((await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: `thread-${posted.threadId.slice(3)}` })).at(-1)?.author.kind).toBe("agent");
    const nestedRoot = join(workspaceRoot, "notes");
    await mkdir(nestedRoot);
    serverOptions.listWorkspaces = () => [registryWorkspace, { workspaceId: "nested", rootPath: nestedRoot }];
    const opened = calls.openWorkspace;
    await expect(invoke("reply", { ...args, cwd: nestedRoot, attachments: [] })).rejects.toThrow("Agent runs cannot write in another workspace.");
    expect(calls.openWorkspace).toBe(opened);
  });

  it("records a named MCP client's file write and reply in a dispatched run as one agent", async () => {
    if (!store) throw new Error("Store is not available");
    const writeFiles = vi.fn<NonNullable<CliWorkspaceContext["writeFiles"]>>(async files => ({ ok: true, written: files.map(file => file.path) }));
    context.writeFiles = writeFiles;
    // Main's person is the account the chat writes are admitted under.
    serverOptions.localPersonId = () => "verified-user-id";
    const identity = { installationId: "install-local-user-id", account: { issuer: createActorIssuer("https://cloud.test"), userId: "verified-user-id" } };
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: request => invoke(request.verb, request.args) };
    const posted = await post({ actor: "human", title: "Trip", body: "Plan day 2." });
    const threadId = `thread-${posted.threadId.slice("th_".length)}`;
    // The client announced "Codex" in its MCP handshake, and the MCP server
    // names it on the file write. A reply names no agent.
    async function writeAndReply() {
      await writeWorkspaceFile(ctx, { path: "plan.txt", content: "Day 2" }, "Codex");
      const reply = await replyToChat(ctx, { threadId: posted.threadId, body: "Planned day 2." });
      if (!reply.ok) throw new Error(reply.reason);
      const message = (await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId })).find((row) => row.id === reply.messageId);
      const origin = writeFiles.mock.lastCall?.[1];
      if (!origin || !message?.authorActorKey) throw new Error("Expected the file write and the reply.");
      return {
        file: deriveMomentActor(agentWriteAuthor(origin), { source: "own-store", workspaceId: WORKSPACE_ID, identity }, "Codex").key,
        reply: parseActorKey(message.authorActorKey),
      };
    }

    dispatchedRun = true;
    const during = await writeAndReply();
    expect(during.reply).toEqual(during.file);

    // Outside a run, the client's writes keep the name it gave.
    dispatchedRun = false;
    expect((await writeAndReply()).file).toMatchObject({ kind: "agent", claimedName: "Codex" });
  });

  it("creates a Markdown document with provenance the door derives", async () => {
    const creates: Array<Parameters<CliDocumentsPort["create"]>[0]> = [];
    context.documents = {
      async read() {
        throw new Error("reads are not under test");
      },
      async edit() {
        throw new Error("edits are not under test");
      },
      async create(input) {
        creates.push(input);
        return { path: input.path };
      },
    };
    await expect(invoke("documentCreate", {
      cwd: workspaceRoot,
      actor: "agent",
      agent: "claude-code",
      path: "notes/new.md",
      markdown: "# New",
    })).resolves.toEqual({ ok: true, path: "notes/new.md" });
    await expect(invoke("documentCreate", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "notes/board.excalidraw",
      markdown: "",
    })).resolves.toEqual({
      ok: false,
      reason: "a document path ends in .md or .markdown: notes/board.excalidraw",
    });
    await expect(invoke("documentCreate", {
      cwd: workspaceRoot,
      actor: "human",
      path: "notes/other.md",
      markdown: "x",
    })).resolves.toEqual({
      ok: false,
      reason: "a document created through the CLI socket is recorded as an agent's; send actor \"agent\"",
    });
    expect(creates).toEqual([{
      path: "notes/new.md",
      markdown: "# New",
      origin: {
        actorOriginId: "claude-code",
        attribution: { actorKind: "agent", onBehalfOf: "person-local", depth: 0 },
      },
    }]);
  });

  it.each([false, true])("lists document chats over the desktop socket with MCP fields in a read-only view=%s", async readOnly => {
    const thread = await store!.createThread({
      workspaceId: WORKSPACE_ID, title: "File review",
      linkedFile: { objectId: "object_tracked", pathHint: "old-name.md" },
    });
    await store!.createThread({
      workspaceId: WORKSPACE_ID, title: "Other file",
      linkedFile: { objectId: "object_other", pathHint: "other.md" },
    });
    registryWorkspace.readOnly = readOnly;
    context.readOnly = readOnly;
    const mcp = await listFileChats({ root: workspaceRoot, home: stateDir, ...(readOnly ? { shareAccess: "view" as const } : {}) }, { path: "tracked.md" });
    expect(mcp).toEqual({
      ok: true, path: "tracked.md", fileObjectId: "object_tracked",
      threads: [{ id: thread.id, title: thread.title, createdAtMs: thread.createdAtMs, updatedAtMs: thread.updatedAtMs, linkedPathHint: "old-name.md" }],
    });
    const result = await executeCli({ argv: ["document", "chats", "tracked.md", "--json"], cwd: workspaceRoot, env: {}, client: { stateDir } });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 3, ...mcp });
    expect(calls.writes).toBe(0);
  });

  it("does not count a successful document chats list through either door in the usage record", async () => {
    const usage = createUsageStore({ stateDir: () => stateDir, appVersion: "0.1.0", coverage: DESKTOP_USAGE_COVERAGE });
    try {
      await usage.load();
      serverOptions.recordSuccess = invocation => usage.recordSuccess(invocation);
      const mcp = await listFileChats({ root: workspaceRoot, home: stateDir }, { path: "tracked.md" });
      expect(mcp).toEqual({ ok: true, path: "tracked.md", fileObjectId: "object_tracked", threads: [] });
      const result = await executeCli({ argv: ["document", "chats", "tracked.md", "--json"], cwd: workspaceRoot, env: {}, client: { stateDir } });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 3, ...mcp });
      expect((await usage.read()).counts).toEqual([]);
    } finally { await usage.close(); }
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
    // An agent that gave no name carries the agent name from the person's settings.
    await expect(store.listMessages({ workspaceId: WORKSPACE_ID, threadId: first.threadId }))
      .resolves.toMatchObject([{ author: { kind: "agent", displayName: "Nova" } }]);

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

  it("refuses a 90 KB CJK first message through MCP without creating a file chat", async () => {
    const create = vi.spyOn(store!, "createThread");
    const ctx: ToolContext = { root: workspaceRoot, home: stateDir, request: request => invoke(request.verb, request.args) };
    expect(await startFileChat(ctx, { path: "tracked.md", title: "Too large", body: "界".repeat(30_000) }, undefined))
      .toEqual({ ok: false, reason: "The message is longer than 64 KiB. Shorten it." });
    expect(create).not.toHaveBeenCalled();
    expect(await invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path: "tracked.md" }))
      .toMatchObject({ ok: true, threads: [] });
    expect(calls.writes).toBe(0);
  });

  it.each([
    ["x".repeat(65_537), "The message is longer than 64 KiB. Shorten it."],
    [" \r\n\t\uFEFF", "The message is empty. Enter a message."],
  ])("refuses an invalid raw socket first message before creating its chat", async (body, reason) => {
    const create = vi.spyOn(store!, "createThread");
    expect(await rawRequest({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileChatStart",
      args: { cwd: workspaceRoot, actor: "agent", path: "tracked.md", title: "Refused", body },
    })).toMatchObject({ ok: true, result: { ok: false, reason } });
    expect(create).not.toHaveBeenCalled();
    expect(await invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path: "tracked.md" }))
      .toMatchObject({ ok: true, threads: [] });
    expect(calls.writes).toBe(0);
  });

  it("lets a refused file-chat request id be retried and corrected before creating exactly one chat", async () => {
    const args = { cwd: workspaceRoot, actor: "agent" as const, path: "tracked.md", title: "Retry", body: "界".repeat(30_000), requestId: "refused-body" };
    const refusal = { ok: false, reason: "The message is longer than 64 KiB. Shorten it." };
    expect(await invoke("fileChatStart", args)).toEqual(refusal);
    expect(await invoke("fileChatStart", args)).toEqual(refusal);
    expect(await invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path: "tracked.md" }))
      .toMatchObject({ ok: true, threads: [] });
    const body = "界".repeat(21_844) + "\r\nx\r\ny\uFEFF ";
    const normalized = "界".repeat(21_844) + "\nx\ny";
    expect(Buffer.byteLength(normalized, "utf8")).toBe(65_536);
    const corrected = { ...args, body };
    const started = await invoke("fileChatStart", corrected);
    if (!started.ok) throw new Error(started.reason);
    expect(await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: started.threadId }))
      .toMatchObject([{ body: normalized }]);
    expect(await invoke("fileChatStart", corrected)).toEqual(started);
    expect(await invoke("fileChats", { cwd: workspaceRoot, actor: "agent", path: "tracked.md" }))
      .toMatchObject({ ok: true, threads: [{ title: "Retry" }] });
  });

  it("returns a pending document edit as success and replays it without another edit", async () => {
    const warning = "Saved locally. The shared file update is pending. Do not repeat this edit.";
    const edit = vi.fn(async (input: { path: string }) => ({ path: input.path, changed: true, warning }));
    context.documents = { read: async () => { throw new Error("unused"); }, edit,
      create: async () => { throw new Error("unused"); } };
    const args = { cwd: workspaceRoot, actor: "agent" as const, path: "notes/plan.md", replacement: "After.", requestId: "kept-edit" };
    const expected = { ok: true, path: "notes/plan.md", changed: true, warning };
    await expect(invoke("documentEdit", args)).resolves.toEqual(expected);
    await expect(invoke("documentEdit", args)).resolves.toEqual(expected);
    expect(edit).toHaveBeenCalledOnce();
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

  it("refuses document edits it cannot attribute or place", async () => {
    let touched = 0;
    context.documents = {
      async read() {
        touched += 1;
        throw new Error("must not be reached");
      },
      async edit() {
        touched += 1;
        throw new Error("must not be reached");
      },
      async create() {
        touched += 1;
        throw new Error("must not be reached");
      },
    };
    // A person types in the editor. A request claiming to be their edit could
    // come from any process holding the socket token.
    for (const agent of [undefined, "claude-code"]) {
      await expect(invoke("documentEdit", {
        cwd: workspaceRoot,
        actor: "human",
        ...(agent === undefined ? {} : { agent }),
        path: "notes/plan.md",
        replacement: "x",
      })).resolves.toEqual({
        ok: false,
        reason: "a document edit through the CLI socket is recorded as an agent's; send actor \"agent\"",
      });
    }
    await expect(invoke("documentRead", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "../outside.md",
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("path rejected") });
    await expect(invoke("documentEdit", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "../outside.md",
      replacement: "x",
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("path rejected") });
    expect(touched).toBe(0);

    registryWorkspace = { ...registryWorkspace, readOnly: true };
    context.readOnly = true;
    await expect(invoke("documentEdit", {
      cwd: workspaceRoot,
      actor: "agent",
      path: "notes/plan.md",
      replacement: "x",
    })).rejects.toThrow("document changes are not available in a read-only shared view");
    expect(touched).toBe(0);
  });

  it("answers collection verbs honestly when the port is absent", async () => {
    context.collections = undefined;
    await expect(invoke("collectionQuery", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
    })).resolves.toEqual({
      ok: false,
      reason: "collections are not available in this workspace",
    });

    await expect(invoke("collectionSetFields", {
      cwd: workspaceRoot,
      actor: "agent",
      recordPath: "tasks/a.md",
      fields: { status: "done" },
    })).resolves.toEqual({
      ok: false,
      reason: "collections are not available in this workspace",
    });
    await expect(invoke("collectionCreateRecord", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
      name: "task",
      fields: {},
    })).resolves.toEqual({
      ok: false,
      reason: "collections are not available in this workspace",
    });
  });

  it("refuses a traversal path on a collection verb before touching the port", async () => {
    let touched = 0;
    context.collections = {
      async query() {
        touched += 1;
        throw new Error("must not be reached");
      },
      async getRecord() {
        touched += 1;
        throw new Error("must not be reached");
      },
      writes: {
        async setFields() {
          touched += 1;
          throw new Error("must not be reached");
        },
        async createRecord() {
          touched += 1;
          throw new Error("must not be reached");
        },
      },
    };
    await expect(invoke("collectionQuery", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "../outside",
    })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("path rejected"),
    });
    await expect(invoke("collectionSetFields", {
      cwd: workspaceRoot,
      actor: "agent",
      recordPath: "../outside/a.md",
      fields: { status: "done" },
    })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("path rejected"),
    });
    expect(touched).toBe(0);
  });

  it("refuses collection writes in a read-only shared view while keeping collection reads", async () => {
    let seamTouched = 0;
    context.collections = {
      async query() {
        return {
          collection: { path: "tasks", objectId: "object-test", status: "valid", reasons: [] },
          records: [],
          groups: null,
          nextCursor: null,
        };
      },
      async getRecord() {
        throw new Error("reads are not under test");
      },
      writes: {
        async setFields() {
          seamTouched += 1;
          throw new Error("must not be reached");
        },
        async createRecord() {
          seamTouched += 1;
          throw new Error("must not be reached");
        },
      },
    };
    registryWorkspace = { ...registryWorkspace, readOnly: true };
    context.readOnly = true;

    await expect(invoke("collectionQuery", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
    })).resolves.toMatchObject({ ok: true, records: [] });
    await expect(invoke("collectionSetFields", {
      cwd: workspaceRoot,
      actor: "agent",
      recordPath: "tasks/a.md",
      fields: { status: "done" },
    })).rejects.toThrow(
      "collection writes are not available in a read-only shared view",
    );
    await expect(invoke("collectionCreateRecord", {
      cwd: workspaceRoot,
      actor: "agent",
      collectionPath: "tasks",
      name: "task",
      fields: {},
    })).rejects.toThrow(
      "collection writes are not available in a read-only shared view",
    );
    expect(seamTouched).toBe(0);
  });

  it("serves reads from a nested read-only workspace without escalating to its writable parent", async () => {
    if (!store) throw new Error("Store is not available");
    const sharedRoot = join(workspaceRoot, "shared-view");
    await mkdir(sharedRoot, { recursive: true });
    const sharedWorkspace: CliRegistryWorkspace = {
      workspaceId: "workspace-shared-view",
      rootPath: sharedRoot,
      readOnly: true,
    };
    const sharedStore = storeForWorkspace(
      sharedWorkspace.workspaceId,
      sharedRoot,
    );
    await sharedStore.ensureGeneralChannel({
      workspaceId: sharedWorkspace.workspaceId,
    });
    serverOptions.listWorkspaces = () => [registryWorkspace, sharedWorkspace];
    const openedWorkspaceIds: string[] = [];
    serverOptions.openWorkspace = async (workspace) => {
      calls.openWorkspace += 1;
      openedWorkspaceIds.push(workspace.workspaceId);
      return {
        ...context,
        ...sharedWorkspace,
        store: sharedStore,
        readOnly: true,
      };
    };
    const openCallsBefore = calls.openWorkspace;

    const response = await invoke("groups", {
      cwd: sharedRoot,
      actor: "human",
    });
    expect(response.groups.map((channel) => channel.slug)).toEqual(["general"]);
    expect(calls.openWorkspace).toBe(openCallsBefore + 1);
    expect(openedWorkspaceIds).toEqual([sharedWorkspace.workspaceId]);
    expect(await store.listThreads({ workspaceId: WORKSPACE_ID })).toEqual([]);
    await expect(stat(join(sharedRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // The shared-channel pass a write triggers must cover the channel that
  // was written, and it only can when the write names its own target. A CLI
  // send that reports a bare workspace leaves the message to the rotation.
  it("names the chat target of every message-bearing CLI write", async () => {
    const opened = await post({
      actor: "human",
      title: "Target-bearing thread",
      body: "First message from the terminal",
    });
    // The target must be the identity the registry lookup resolves — a CLI-facing
    // id would name nothing. Assert it by resolving it, not by its spelling.
    const postedTarget = writeTargets.at(-1);
    expect(postedTarget).toBeDefined();
    expect(
      await store!.getChannelWireId({
        workspaceId: WORKSPACE_ID,
        channelId: (postedTarget as { channelId: string }).channelId,
      }),
    ).toEqual(expect.any(String));

    writeTargets.length = 0;
    await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: opened.threadId,
      attachments: [],
      needsDecision: false,
      body: "Reply from the terminal",
    });
    const repliedTarget = writeTargets.at(-1);
    expect(repliedTarget).toBeDefined();
    expect(
      await store!.findThreadChannelId({
        workspaceId: WORKSPACE_ID,
        threadId: (repliedTarget as { threadId: string }).threadId,
      }),
    ).toEqual(expect.any(String));
  });

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

  it("triggers the sync pass for every chat read verb, not a fixed subset", async () => {
    const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store!.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Read-coverage message",
    });
    const chatReads: Array<[CliVerb, unknown]> = [
      ["groups", { cwd: workspaceRoot, actor: "agent" }],
      ["groupsFull", { cwd: workspaceRoot, actor: "agent" }],
      ["threads", { cwd: workspaceRoot, actor: "agent", group: general.id }],
      ["inbox", { cwd: workspaceRoot, actor: "agent" }],
      ["chat", { cwd: workspaceRoot, actor: "agent", threadId: thread.id }],
      ["fileChats", { cwd: workspaceRoot, actor: "agent", path: "tracked.md" }],
      [
        "show",
        { cwd: workspaceRoot, actor: "human", target: thread.id, peek: true },
      ],
      [
        "grep",
        {
          cwd: workspaceRoot,
          actor: "agent",
          pattern: "message",
          ignoreCase: false,
          filesWithMatches: false,
          context: 0,
          limit: 20,
          regex: false,
        },
      ],
      [
        "export",
        {
          cwd: workspaceRoot,
          actor: "agent",
          scope: { kind: "all" },
          outDir: "export-coverage",
        },
      ],
    ];
    for (const [verb, args] of chatReads) {
      calls.reads = 0;
      await invoke(verb, args as ArgsFor<typeof verb>);
      expect(calls.reads, verb).toBe(1);
    }

    // moments/moment read version history, not chat — they must not pay for a
    // sync pass they have no use for.
    calls.reads = 0;
    await invoke("moments", { cwd: workspaceRoot, actor: "agent", includeFiles: false });
    await invoke("moment", { cwd: workspaceRoot, actor: "agent", id: "moment_primary" });
    expect(calls.reads).toBe(0);
  });

  it("keeps serving local data when the sync pass itself fails", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Local-only message",
    });
    onReadEffect = () => {
      throw new Error("relay unreachable");
    };

    const chat = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: thread.id,
    });
    if (!chat.ok) throw new Error(chat.reason);

    expect(chat.messages.map((message) => message.body)).toEqual([
      "Local-only message",
    ]);
    expect(errors).toEqual([expect.objectContaining({ message: "relay unreachable" })]);
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
  it("coalesces concurrent chat reads for the same workspace onto one pass", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Local-only message",
    });
    // Never resolves within the test — the worst case for unbounded queueing.
    onReadEffect = () => new Promise<void>(() => {});
    serverOptions.chatReadSyncBudgetMs = 40;

    const [first, second] = await Promise.all([
      invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId: thread.id }),
      invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId: thread.id }),
    ]);
    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);

    // Two reads raced the budget, but only one of them actually started the
    // hook — the second joined its race instead of starting a second pass.
    expect(calls.reads).toBe(1);
  });

  it("starts a fresh pass once the prior one for that workspace has settled", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Local-only message",
    });
    const release: { firstPass: (() => void) | null } = { firstPass: null };
    let hookCalls = 0;
    onReadEffect = () => {
      hookCalls += 1;
      if (hookCalls > 1) return undefined;
      return new Promise<void>((resolveHang) => {
        release.firstPass = resolveHang;
      });
    };
    serverOptions.chatReadSyncBudgetMs = 40;

    const first = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: thread.id,
    });
    if (!first.ok) throw new Error(first.reason);
    expect(hookCalls).toBe(1);

    release.firstPass?.();
    // Let the settled pass's own `.finally` cleanup run before the next read.
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    const second = await invoke("chat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: thread.id,
    });
    if (!second.ok) throw new Error(second.reason);
    // Not stuck coalescing onto a pass that already finished.
    expect(hookCalls).toBe(2);
  });

  it("names the read's own channel or thread as the sync priority", async () => {
    const general = await store!.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const { thread } = await store!.startChannelThread({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Priority-target message",
    });

    readTargets.length = 0;
    await invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId: thread.id });
    expect(readTargets.at(-1)).toEqual({ threadId: thread.id });

    readTargets.length = 0;
    await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: thread.id,
      peek: true,
    });
    expect(readTargets.at(-1)).toEqual({ threadId: thread.id });

    readTargets.length = 0;
    await invoke("threads", {
      cwd: workspaceRoot,
      actor: "agent",
      group: general.id,
    });
    expect(readTargets.at(-1)).toEqual({ channelId: general.id });

    // A verb whose args carry no single channel or thread runs the plain
    // rotation instead of guessing one.
    readTargets.length = 0;
    await invoke("groupsFull", { cwd: workspaceRoot, actor: "agent" });
    expect(readTargets.at(-1)).toBeUndefined();
  });

  it("round-trips post, reply, and show with main-derived identity and CLI origin", async () => {
    const opened = await post({
      actor: "human",
      title: "CLI transport thread",
      body: "Opening from the terminal",
      attachments: ["tracked.md"],
      needsDecision: true,
    });
    expect(opened.threadId).toMatch(/^th_/u);
    expect(opened.messageId).toMatch(/^msg_/u);
    expect(opened.group.id).toMatch(/^ch_/u);
    const replied = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "agent",
      thread: "th_",
      to: "msg_",
      attachments: [],
      needsDecision: false,
      resolve: "msg_",
      body: "Agent response from the terminal",
    });
    const shown = await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: opened.threadId,
      peek: true,
    });

    expect(replied).toEqual({
      threadId: opened.threadId,
      messageId: replied.messageId,
      parentMessageId: opened.messageId,
      resolvedMessageId: opened.messageId,
    });
    expect(shown.thread).toMatchObject({
      id: opened.threadId,
      title: "CLI transport thread",
      commentCount: 1,
      openDecisionCount: 0,
    });
    expect(shown.messages.map((message) => ({
      id: message.id,
      kind: message.author.kind,
      displayName: message.author.displayName,
      body: message.body,
      parentMessageId: message.parentMessageId,
      decisionState: message.decisionState,
      attachments: message.attachments,
    }))).toEqual([
      {
        id: opened.messageId,
        kind: "human",
        displayName: "Sam",
        body: "Opening from the terminal",
        parentMessageId: undefined,
        decisionState: "resolved",
        attachments: [{ objectId: "object_tracked", pathHint: "tracked.md" }],
      },
      {
        id: replied.messageId,
        kind: "agent",
        displayName: "Nova",
        body: "Agent response from the terminal",
        parentMessageId: opened.messageId,
        decisionState: undefined,
        attachments: [],
      },
    ]);

    if (!store) throw new Error("Store is not available");
    const persistedThread = (await store.listThreads({ workspaceId: WORKSPACE_ID }))
      .find((thread) => cliThreadId(thread.id) === opened.threadId);
    if (!persistedThread) throw new Error("Persisted thread is not available");
    const persisted = await store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: persistedThread.id,
    });
    expect(persisted.map((message) => ({
      kind: message.author.kind,
      displayName: message.author.displayName,
      authorUserId: message.authorUserId,
      origin: message.origin,
    }))).toEqual([
      {
        kind: "human",
        displayName: "Sam",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
      {
        kind: "agent",
        displayName: "Nova",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("lists chat-only and mixed groups and posts into a chat-only lane", async () => {
    if (!store) throw new Error("Store is not available");
    const chat = await store.createChannel({ workspaceId: WORKSPACE_ID, name: "Chat group", kind: "channel", type: "chat", purpose: "Plan the launch" });
    await post({ actor: "human", group: chat.slug, title: "Hello", body: "In chat" });
    const chatThreads = await store.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: chat.id, lane: "chat" });
    expect(chatThreads).toHaveLength(1);
    expect(await store.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: chat.id, lane: "posts" })).toHaveLength(0);
    const listed = await invoke("threads", { cwd: workspaceRoot, actor: "human", group: chat.slug });
    expect(listed.group.purpose).toBe("Plan the launch");
    expect(listed.threads).toHaveLength(1);
    const both = await store.createChannel({ workspaceId: WORKSPACE_ID, name: "Mixed group", kind: "channel", type: "both" });
    for (const lane of ["posts", "chat"] as const) {
      await store.startChannelThread({ authorActorKey: null, workspaceId: WORKSPACE_ID, channelId: both.id, lane, author: { kind: "human", displayName: "Sam" }, body: lane });
    }
    const mixed = await invoke("threads", { cwd: workspaceRoot, actor: "human", group: both.slug });
    expect(mixed.threads.map(thread => thread.lane)).toEqual(["posts", "chat"]);
    const full = await invoke("groupsFull", { cwd: workspaceRoot, actor: "human" });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error(full.reason);
    expect(full.groups.find(channel => channel.id === chat.id)?.threads).toHaveLength(1);
    expect(full.groups.find(channel => channel.id === both.id)?.threads.map(thread => thread.lane)).toEqual(["posts", "chat"]);
  });

  it("posts to the agent channel using the name returned by MCP discovery", async () => {
    if (!store) throw new Error("Store is not available");
    const agent = await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    const listed = await invoke("groupsFull", { cwd: workspaceRoot, actor: "agent" });
    if (!listed.ok) throw new Error(listed.reason);
    const discovered = listed.groups.find((channel) => channel.id === agent.id);
    expect(discovered?.name).toBe("My agent");
    const started = await post({
      actor: "agent",
      group: discovered!.name,
      title: "Continue",
      body: "Continue this task.",
    });
    expect(started.group.kind).toBe("agent");
    const threads = await store.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: agent.id });
    expect(threads.map(({ thread }) => cliThreadId(thread.id))).toContain(started.threadId);
  });

  // Provisioning General writes outside chatWrites, so only onWrite tells
  // the desktop to notify the renderer and queue cloud sync for it.
  it("reports the write when listing groups provisions General, and only then", async () => {
    await invoke("groups", { cwd: workspaceRoot, actor: "human" });
    expect(calls.writes).toBe(1);
    await invoke("groups", { cwd: workspaceRoot, actor: "human" });
    await invoke("groupsFull", { cwd: workspaceRoot, actor: "agent" });
    expect(calls.writes).toBe(1);
  });

  it("does not provision an agent when listing groups", async () => {
    if (!store) throw new Error("Store is not available");
    const result = await invoke("groups", { cwd: workspaceRoot, actor: "agent" });
    expect(result.groups.map((channel) => channel.kind)).not.toContain("agent");
    expect((await store.listChannels({ workspaceId: WORKSPACE_ID })).map(
      (channel) => channel.kind,
    )).not.toContain("agent");
  });

  it("rejects post for DM streams while allowing agent-channel task posts", async () => {
    if (!store) throw new Error("Store is not available");
    await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    const dm = await store.createChannel({
      workspaceId: WORKSPACE_ID,
      name: "Alice",
      kind: "dm",
    });
    const identityBefore = calls.identity;

    await expect(post({
      actor: "human",
      group: dm.slug,
      title: "Must not become a DM thread",
      body: "DMs need replies.",
    })).rejects.toThrow(
      "dohc: DMs are streams — use 'dohc chat reply <thread>'",
    );
    expect(calls.identity).toBe(identityBefore);
    expect(await store.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: dm.id,
    })).toEqual([]);

    const agentPost = await post({
      actor: "human",
      group: "my-agent",
      title: "Agent task",
      body: "Agent channels still create task threads.",
    });
    expect(agentPost.group.kind).toBe("agent");
    expect(agentPost.title).toBe("Agent task");
  });

  it("exposes budget pauses in show and MCP chat reads without adding messages", async () => {
    await seedDispatchThread("thread-dispatch");
    const show = () => invoke("show", { cwd: workspaceRoot, actor: "agent", target: "th_dispatch", peek: true });
    const chat = () => invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId: "thread-dispatch" });
    const before = await show();
    expect(before.dispatch).toEqual({ paused: null, lastRun: null });
    expect(await chat()).toMatchObject({ ok: true, dispatch: { paused: null, lastRun: null } });
    await dispatchStore.setThreadDispatchPaused({ workspaceId: WORKSPACE_ID, threadId: "thread-dispatch", paused: true, reason: "re-dispatch budget exceeded" });
    expect(await show()).toMatchObject({ dispatch: { paused: "budget", lastRun: null }, messages: before.messages });
    expect(await chat()).toMatchObject({ ok: true, dispatch: { paused: "budget", lastRun: null } });
    await dispatchStore.setThreadDispatchPaused({ workspaceId: WORKSPACE_ID, threadId: "thread-dispatch", paused: false });
    expect(await show()).toMatchObject({ dispatch: { paused: null, lastRun: null }, messages: before.messages });
    expect(await chat()).toMatchObject({ ok: true, dispatch: { paused: null, lastRun: null } });
    await dispatchStore.recordTrigger({ workspaceId: WORKSPACE_ID, threadId: "thread-dispatch", triggerMessageId: "trigger" });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected run");
    expect((await show()).dispatch.lastRun).toEqual({ state: "running", failureReason: null, exitCode: null });
    await dispatchStore.failRun({ runId: claim.run.runId, reason: "runner failed to start", exitCode: 7 });
    const dispatch = { paused: null, lastRun: { state: "failed", failureReason: "runner failed to start", exitCode: 7 } };
    expect(await show()).toMatchObject({ dispatch, messages: before.messages });
    expect(await chat()).toMatchObject({ ok: true, dispatch });
    expect(await dispatchStore.listRunMessages(WORKSPACE_ID, claim.run.runId)).toEqual([]);
    await dispatchStore.recordTrigger({ workspaceId: WORKSPACE_ID, threadId: "thread-dispatch", triggerMessageId: "trigger-2" });
    const next = await dispatchStore.claimNextPending(WORKSPACE_ID);
    if (!next) throw new Error("Expected next run");
    await dispatchStore.completeRun({ runId: next.run.runId, exitCode: 0 });
    expect((await show()).dispatch.lastRun).toEqual({ state: "completed", failureReason: null, exitCode: 0 });
    await dispatchStore.markFailureHandled(next.run.runId);
    const noReply = { paused: null, lastRun: { state: "failed", failureReason: "no-reply", exitCode: 0 } };
    expect(await show()).toMatchObject({ dispatch: noReply, messages: before.messages });
    expect(await chat()).toMatchObject({ ok: true, dispatch: noReply });
    expect(await dispatchStore.listRunMessages(WORKSPACE_ID, next.run.runId)).toEqual([]);
  });

  it("links only agent-authored messages carrying a valid local run id", async () => {
    await seedDispatchThread("thread-dispatch");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-dispatch_trigger",
      threadId: "thread-dispatch",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for CLI linkage.");

    const opened = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Runner report",
      body: "Opening report",
    });
    const replied = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "agent",
      runId: claim.run.runId,
      thread: opened.threadId,
      attachments: [],
      needsDecision: false,
      body: "Final report",
    });
    const human = await post({
      actor: "human",
      runId: claim.run.runId,
      title: "Human terminal write",
      body: "Must not be linked",
    });
    const unknown = await post({
      actor: "agent",
      runId: "run_unknown",
      title: "Unknown run",
      body: "Still posts",
    });
    const invalid = await post({
      actor: "agent",
      runId: " ",
      title: "Invalid run",
      body: "Also still posts",
    });
    await invoke("react", {
      cwd: workspaceRoot,
      actor: "agent",
      runId: claim.run.runId,
      message: opened.messageId,
      emoji: "👍",
    });

    const engineMessageId = (id: string) =>
      id.startsWith("msg_") ? `message-${id.slice("msg_".length)}` : id;
    expect(
      await dispatchStore.listRunMessages(WORKSPACE_ID, claim.run.runId),
    ).toEqual([
      engineMessageId(opened.messageId),
      engineMessageId(replied.messageId),
    ]);
    expect(await dispatchStore.runIdForMessage(
      WORKSPACE_ID,
      engineMessageId(human.messageId),
    )).toBeNull();
    expect(await dispatchStore.runIdForMessage(
      WORKSPACE_ID,
      engineMessageId(unknown.messageId),
    )).toBeNull();
    expect(await dispatchStore.runIdForMessage(
      WORKSPACE_ID,
      engineMessageId(invalid.messageId),
    )).toBeNull();
    expect(errors).toEqual([]);
  });

  it("retries transient run-message provenance failures until the link persists", async () => {
    await seedDispatchThread("thread-retry");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-retry_trigger",
      threadId: "thread-retry",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for retry linkage.");
    let attempts = 0;
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage(input) {
          attempts += 1;
          if (attempts < 3) throw new Error("transient daemon restart");
          return originalDispatch.recordRunMessage(input);
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Retry provenance",
      body: "The message itself persists once.",
    });

    const engineMessageId = result.messageId.replace(/^msg_/u, "message-");
    expect(attempts).toBe(3);
    expect(result.warning).toBeUndefined();
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
    expect(errors).toEqual([]);
  });

  it("keeps retrying an exhausted provenance link until the posted reply is linked", async () => {
    await seedDispatchThread("thread-recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-recovery_trigger",
      threadId: "thread-recovery",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for recovery linkage.");
    let attempts = 0;
    const pending: string[] = [];
    const settled: string[] = [];
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage(input) {
          attempts += 1;
          if (attempts <= 3) throw new Error("daemon restart in progress");
          return originalDispatch.recordRunMessage(input);
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkRecoveryRetryMs = 0;
    serverOptions.onRunMessageLinkPending = (link) => pending.push(link.messageId);
    serverOptions.onRunMessageLinkSettled = (link) => settled.push(link.messageId);

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Recover provenance",
      body: "This posted reply must remain recoverable.",
    });
    for (let index = 0; index < 50 && attempts < 4; index += 1) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }

    const engineMessageId = result.messageId.replace(/^msg_/u, "message-");
    expect(result.warning).toContain("recovery will continue in the background");
    expect(attempts).toBe(4);
    expect(pending).toEqual([engineMessageId]);
    expect(settled).toEqual([engineMessageId]);
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
  });

  it("persists pending provenance across shutdown without reporting it settled", async () => {
    await seedDispatchThread("thread-restart_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-restart_recovery_trigger",
      threadId: "thread-restart_recovery",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected a dispatch run.");
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

  it("restores available provenance links past an unavailable workspace", async () => {
    const posted = await post({
      actor: "human",
      title: "Existing message",
      body: "This message will receive restored provenance.",
    });
    const engineMessageId = posted.messageId.replace(/^msg_/u, "message-");
    await seedDispatchThread("thread-mixed_restore");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-mixed_restore_trigger",
      threadId: "thread-mixed_restore",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected a run for mixed restore.");
    const unavailable = {
      workspaceId: "workspace-not-registered",
      runId: "run_deferred",
      messageId: "message-deferred",
      attempt: 0,
      createdAtMs: SERVER_NOW_MS,
    };
    const available = {
      workspaceId: WORKSPACE_ID,
      runId: claim.run.runId,
      messageId: engineMessageId,
      attempt: 0,
      createdAtMs: SERVER_NOW_MS,
    };

    disposeCliServerRuntime(serverOptions);
    await writeFile(
      join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE),
      `${JSON.stringify([unavailable, available])}\n`,
      "utf8",
    );
    const restoredOptions: CliServerOptions = {
      ...serverOptions,
      runMessageLinkRecoveryRetryMs: 0,
    };
    serverOptions = restoredOptions;
    await restoreCliServerRuntime(restoredOptions);
    for (let index = 0; index < 50; index += 1) {
      if (
        (await dispatchStore.runIdForMessage(
          WORKSPACE_ID,
          engineMessageId,
        )) !== null
      ) {
        break;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    for (let index = 0; index < 50; index += 1) {
      const stored = JSON.parse(
        await readFile(
          join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE),
          "utf8",
        ),
      ) as unknown[];
      if (stored.length === 1) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }

    expect(
      await dispatchStore.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
    expect(
      JSON.parse(
        await readFile(
          join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE),
          "utf8",
        ),
      ),
    ).toEqual([unavailable]);
    expect(
      errors.some(
        (error) =>
          error instanceof Error &&
          error.message.includes("workspace-not-registered"),
      ),
    ).toBe(true);
  });

  it("bounds the provenance recovery queue and abandons after its attempt cap", async () => {
    const originalDispatch = dispatchStore;
    const abandoned: string[] = [];
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage() {
          throw new Error("daemon remains unavailable");
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkRecoveryRetryMs = 60_000;
    serverOptions.runMessageLinkRecoveryMaxPending = 1;
    serverOptions.runMessageLinkRecoveryMaxAttempts = 1;
    serverOptions.onRunMessageLinkAbandoned = (link) =>
      abandoned.push(link.messageId);

    const runIds: string[] = [];
    for (const suffix of ["a", "b"]) {
      await seedDispatchThread(`thread-bounded_${suffix}`);
      await dispatchStore.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: `message-bounded_${suffix}`,
        threadId: `thread-bounded_${suffix}`,
      });
      const claim = await dispatchStore.claimNextPending(WORKSPACE_ID);
      if (!claim) throw new Error("Expected a bounded-queue run.");
      await dispatchStore.failRun({
        runId: claim.run.runId,
        reason: "seed next run",
      });
      runIds.push(claim.run.runId);
    }

    const first = await post({
      actor: "agent",
      runId: runIds[0],
      title: "First bounded recovery",
      body: "This occupies the one queue slot.",
    });
    const second = await post({
      actor: "agent",
      runId: runIds[1],
      title: "Second bounded recovery",
      body: "This cannot grow the queue.",
    });
    expect(first.warning).toContain("recovery will continue");
    expect(second.warning).toContain("bounded recovery queue is full");

    disposeCliServerRuntime(serverOptions);
    const restoredOptions: CliServerOptions = {
      ...serverOptions,
      runMessageLinkRecoveryRetryMs: 0,
    };
    serverOptions = restoredOptions;
    await restoreCliServerRuntime(restoredOptions);
    for (let index = 0; index < 50 && abandoned.length === 0; index += 1) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    expect(abandoned).toEqual([
      first.messageId.replace(/^msg_/u, "message-"),
    ]);
    await expect(
      stat(join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps all foreground provenance work with one wall-clock budget", async () => {
    await seedDispatchThread("thread-foreground_budget");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-foreground_budget_trigger",
      threadId: "thread-foreground_budget",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected a dispatch run.");
    const deadlines: number[] = [];
    context = {
      ...context,
      dispatchStore: {
        ...dispatchStore,
        async getRunRecord(_runId, requestOptions) {
          const deadline = requestOptions?.deadlineMs ?? 1_000;
          deadlines.push(deadline);
          await new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("request timed out")), deadline);
          });
          return null;
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkDeadlineMs = 20;
    serverOptions.runMessageLinkForegroundBudgetMs = 25;
    serverOptions.runMessageLinkRecoveryRetryMs = 60_000;

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Bound foreground provenance",
      body: "Return promptly while the daemon is silent.",
    });

    expect(result.warning).toContain("recovery will continue");
    expect(deadlines.length).toBeLessThan(3);
    expect(deadlines[0]).toBeLessThanOrEqual(20);
    expect(deadlines.reduce((sum, deadline) => sum + deadline, 0)).toBeLessThanOrEqual(25);
  });

  it("returns a visible warning when run-message provenance retries are exhausted", async () => {
    await seedDispatchThread("thread-permanent");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-permanent_trigger",
      threadId: "thread-permanent",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for failed linkage.");
    let attempts = 0;
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage() {
          attempts += 1;
          throw new Error("daemon remains unavailable");
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Visible provenance warning",
      body: "Posting succeeds even though linkage is degraded.",
    });

    expect(attempts).toBe(3);
    expect(result.warning).toContain(
      "agent-run provenance could not be recorded after 3 attempts",
    );
    expect(errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`runId=${claim.run.runId}`),
      }),
    ]);
    expect(
      await originalDispatch.listRunMessages(WORKSPACE_ID, claim.run.runId),
    ).toEqual([]);
  });

  it("gives up on the first permanently refused foreground provenance link", async () => {
    await seedDispatchThread("thread-terminal_foreground");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-terminal_foreground_trigger",
      threadId: "thread-terminal_foreground",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for terminal linkage.");
    let attempts = 0;
    const queued: string[] = [];
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage() {
          attempts += 1;
          throw new DaemonRefusalError(
            {
              code: "INVALID_PARAMS",
              message: "run-not-found",
              retry: "no",
            },
            null,
          );
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.onRunMessageLinkPending = (link) =>
      queued.push(link.messageId);

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Terminal provenance",
      body: "A refused link must not consume the foreground budget.",
    });

    expect(attempts).toBe(1);
    expect(result.warning).toBeUndefined();
    expect(queued).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("settles a background provenance link on the first permanent refusal", async () => {
    await seedDispatchThread("thread-terminal_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-terminal_recovery_trigger",
      threadId: "thread-terminal_recovery",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for terminal recovery.");
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
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for transient refusal.");
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

  it("reads a permanent code only from a daemon refusal, not any Error", async () => {
    await seedDispatchThread("thread-plain_error");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-plain_error_trigger",
      threadId: "thread-plain_error",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for plain-error linkage.");
    let attempts = 0;
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async recordRunMessage() {
          attempts += 1;
          throw new Error("run-not-found");
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkRecoveryRetryMs = 60_000;

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Plain error provenance",
      body: "A message string is not a refusal taxonomy.",
    });

    expect(attempts).toBe(3);
    expect(result.warning).toContain(
      "agent-run provenance could not be recorded after 3 attempts",
    );
  });

  it("forwards a deadline to every provenance RPC attempt", async () => {
    await seedDispatchThread("thread-deadline");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message-deadline_trigger",
      threadId: "thread-deadline",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID, {
      command: "claude -p",
    });
    if (!claim) throw new Error("Expected a dispatch run for deadline linkage.");
    const lookupDeadlines: Array<number | undefined> = [];
    const linkDeadlines: Array<number | undefined> = [];
    const originalDispatch = dispatchStore;
    context = {
      ...context,
      dispatchStore: {
        ...originalDispatch,
        async getRunRecord(runId, requestOptions) {
          lookupDeadlines.push(requestOptions?.deadlineMs);
          return originalDispatch.getRunRecord(runId);
        },
        async recordRunMessage(_input, requestOptions) {
          linkDeadlines.push(requestOptions?.deadlineMs);
          await new Promise<void>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("daemon request deadline exceeded")),
              requestOptions?.deadlineMs ?? 100,
            );
          });
          return true;
        },
      },
    };
    serverOptions.runMessageLinkRetryMs = 0;
    serverOptions.runMessageLinkDeadlineMs = 1;

    const result = await post({
      actor: "agent",
      runId: claim.run.runId,
      title: "Deadline provenance",
      body: "The post remains bounded when linkage does not respond.",
    });

    expect(lookupDeadlines).toEqual([1, 1, 1]);
    expect(linkDeadlines).toEqual([1, 1, 1]);
    expect(result.warning).toContain(
      "agent-run provenance could not be recorded after 3 attempts",
    );
  });

  it("shows a message branch and lists candidates for an ambiguous id prefix", async () => {
    const first = await post({
      actor: "human",
      title: "First branch",
      body: "First root",
    });
    const branchRoot = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: first.threadId,
      to: first.messageId,
      attachments: [],
      needsDecision: false,
      body: "Branch root",
    });
    const descendant = await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: first.threadId,
      to: branchRoot.messageId,
      attachments: [],
      needsDecision: false,
      body: "Branch descendant",
    });
    await invoke("reply", {
      cwd: workspaceRoot,
      actor: "human",
      thread: first.threadId,
      to: first.messageId,
      attachments: [],
      needsDecision: false,
      body: "Sibling branch",
    });
    const branch = await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: branchRoot.messageId,
      peek: true,
    });
    expect(branch.messages.map((message) => message.id)).toEqual([
      branchRoot.messageId,
      descendant.messageId,
    ]);

    const second = await post({
      actor: "human",
      title: "Second branch",
      body: "Second root",
    });
    const ambiguous = await rawRequest({
      token,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "show",
      args: { cwd: workspaceRoot, actor: "human", target: "th_", peek: true },
    });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error("Expected an ambiguous prefix error");
    expect(ambiguous.error).toContain("ambiguous thread or message prefix 'th_'");
    expect(ambiguous.error).toContain(first.threadId);
    expect(ambiguous.error).toContain(second.threadId);
  });

  it("reads attachment, parent, and decision metadata needed to continue a chat", async () => {
    await writeFile(join(workspaceRoot, "tracked.md"), "Agenda");
    const opened = await invoke("post", {
      cwd: workspaceRoot, actor: "human", group: "general", attachments: ["tracked.md"],
      needsDecision: true, options: ["Ship", "Hold"], body: "Choose a release date",
    });
    const threadId = opened.threadId.replace(/^th_/u, "thread-");
    const before = await invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId });
    if (!before.ok) throw new Error(before.reason);
    expect(before.messages[0]).toMatchObject({
      needsDecision: true, decisionState: "open", options: ["Ship", "Hold"],
      attachments: [{ objectId: "object_tracked", pathHint: "tracked.md" }],
    });
    const decisionId = before.messages[0]!.id;
    const replied = await invoke("reply", {
      cwd: workspaceRoot, actor: "agent", thread: threadId, to: decisionId,
      resolve: decisionId, choose: "Ship", attachments: [], needsDecision: false, body: "Ship it",
    });
    const after = await invoke("chat", { cwd: workspaceRoot, actor: "agent", threadId });
    if (!after.ok) throw new Error(after.reason);
    expect(after.messages[0]).toMatchObject({
      decisionState: "resolved", chosenOption: "Ship",
      resolvedByMessageId: replied.messageId.replace(/^msg_/u, "message-"),
    });
    expect(after.messages[1]).toMatchObject({ parentMessageId: decisionId, needsDecision: false, attachments: [] });
  });

  it("rejects invalid decision choices before posting a reply", async () => {
    const opened = await invoke("post", {
      cwd: workspaceRoot, actor: "human", group: "general", attachments: [],
      needsDecision: true, options: ["Ship", "Hold"], body: "Choose",
    });
    for (const choice of [
      { choose: "Ship" },
      { resolve: opened.messageId },
      { resolve: opened.messageId, choose: "Invalid" },
    ]) {
      await expect(invoke("reply", {
        cwd: workspaceRoot, actor: "agent", thread: opened.threadId,
        attachments: [], needsDecision: false, body: "Must not post", ...choice,
      })).rejects.toThrow(choice.resolve ? "Pick one of the poll's choices." : "--choose needs --resolve");
    }
    const bare = await post({ actor: "human", title: "Question", body: "Ready?", needsDecision: true });
    await expect(invoke("reply", {
      cwd: workspaceRoot, actor: "agent", thread: bare.threadId,
      resolve: bare.messageId, choose: "Ship", attachments: [], needsDecision: false, body: "Must not post",
    })).rejects.toThrow("This question has no choices to pick from.");
    for (const posted of [opened, bare]) {
      expect(await store!.listMessages({
        workspaceId: WORKSPACE_ID, threadId: posted.threadId.replace(/^th_/u, "thread-"),
      })).toHaveLength(1);
    }
  });

  it("replies by exact engine id without enumerating groups or threads", async () => {
    const opened = await post({ actor: "human", title: "Exact target", body: "Reply here" });
    const threadId = opened.threadId.replace(/^th_/u, "thread-");
    const spies = [
      vi.spyOn(store!, "listChannels"), vi.spyOn(store!, "listChannelThreads"), vi.spyOn(store!, "listThreads"),
    ];
    try {
      const result = await invoke("reply", {
        cwd: workspaceRoot, actor: "agent", thread: threadId,
        attachments: [], needsDecision: false, body: "Exact reply",
      });
      const messages = await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId });
      expect(result.messageId).toBe(cliMessageId(messages.at(-1)!.id));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
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

  it("resolves unique engine-id prefixes and reports ambiguous prefixes without posting", async () => {
    await seedDispatchThread("thread-prefix-first");
    const replied = await invoke("reply", {
      cwd: workspaceRoot, actor: "agent", thread: "thread-prefix",
      attachments: [], needsDecision: false, body: "Unique prefix reply",
    });
    const messages = await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: "thread-prefix-first" });
    expect(replied.threadId).toBe("th_prefix-first");
    expect(replied.messageId).toBe(cliMessageId(messages[0]!.id));

    await seedDispatchThread("thread-prefix-second");
    await expect(invoke("reply", {
      cwd: workspaceRoot, actor: "agent", thread: "thread-prefix",
      attachments: [], needsDecision: false, body: "Must not guess",
    })).rejects.toThrow("ambiguous thread prefix 'thread-prefix': th_prefix-first, th_prefix-second");
    expect(await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: "thread-prefix-first" })).toHaveLength(1);
    expect(await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: "thread-prefix-second" })).toHaveLength(0);
    const short = await invoke("reply", {
      cwd: workspaceRoot, actor: "agent", thread: "th_prefix-sec",
      attachments: [], needsDecision: false, body: "Short display prefix reply",
    });
    expect(short.threadId).toBe("th_prefix-second");
    expect(await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: "thread-prefix-second" })).toHaveLength(1);
  });

  it("reads exact persisted ids without requiring an engine-id spelling", async () => {
    await seedDispatchThread("custom-persisted-thread");
    const spies = [vi.spyOn(store!, "listChannels"), vi.spyOn(store!, "listThreads")];
    try {
      const replied = await invoke("reply", {
        cwd: workspaceRoot, actor: "agent", thread: "custom-persisted-thread",
        attachments: [], needsDecision: false, body: "Exact arbitrary id",
      });
      expect(replied.threadId).toBe("custom-persisted-thread");
      expect(await store!.listMessages({ workspaceId: WORKSPACE_ID, threadId: "custom-persisted-thread" })).toHaveLength(1);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("does not enumerate or post after an unrelated targeted-read failure", async () => {
    const read = vi.spyOn(store!, "listMessages").mockRejectedValue(new Error("workspace access revoked"));
    const listed = vi.spyOn(store!, "listThreads");
    const channels = vi.spyOn(store!, "listChannels");
    const send = vi.spyOn(store!, "sendMessage");
    try {
      await expect(invoke("reply", {
        cwd: workspaceRoot, actor: "agent", thread: "thread-target",
        attachments: [], needsDecision: false, body: "Must not post",
      })).rejects.toThrow("workspace access revoked");
      expect(listed).not.toHaveBeenCalled();
      expect(channels).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      for (const spy of [read, listed, channels, send]) spy.mockRestore();
    }
  });

  it("reports an honest partial success when another resolver wins", async () => {
    const opened = await post({
      actor: "human",
      title: "Resolution race",
      body: "Choose a path",
      needsDecision: true,
    });
    if (!store) throw new Error("Store is not available");
    const originalResolve = store.resolveChatDecision.bind(store);
    store.resolveChatDecision = (input) => originalResolve({
      ...input,
      resolvedByMessageId: input.messageId,
    });

    try {
      const reply = await invoke("reply", {
        cwd: workspaceRoot,
        actor: "human",
        thread: opened.threadId,
        attachments: [],
        needsDecision: false,
        resolve: opened.messageId,
        body: "My resolving reply",
      });
      expect(reply.warning).toContain("was posted, but decision");
      expect(reply.resolvedMessageId).toBeUndefined();
      const persisted = await store.listMessages({ workspaceId: WORKSPACE_ID, threadId: opened.threadId.replace(/^th_/u, "thread-") });
      expect(reply.messageId).toBe(cliMessageId(persisted.at(-1)!.id));
    } finally {
      store.resolveChatDecision = originalResolve;
    }

    const shown = await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: opened.threadId,
      peek: true,
    });
    expect(shown.messages).toHaveLength(2);
    expect(shown.messages[0]?.decisionState).toBe("resolved");
    expect(shown.messages[1]?.body).toBe("My resolving reply");
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

  it("returns unread agent DMs, agent mentions, and human unread threads", async () => {
    if (!store) throw new Error("Store is not available");
    await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    const agentDm = await post({
      actor: "human",
      group: "my-agent",
      title: "Work for my agent",
      body: "Please investigate this",
    });
    const mention = await post({
      actor: "human",
      title: "Mention in general",
      body: "Could @agent check the transport contract?",
    });
    const humanUnread = await post({
      actor: "agent",
      title: "News from the agent",
      body: "This should be unread by the human",
    });
    if (!store) throw new Error("Store is not available");
    const fileThread = await store.createThread({
      workspaceId: WORKSPACE_ID,
      title: "Unread file discussion",
      linkedFile: { objectId: "object_tracked", pathHint: "tracked.md" },
    });
    await store.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: fileThread.id,
      author: { kind: "agent", displayName: "Sam" },
      body: "This file-linked thread is unread too",
    });
    const fileThreadId = cliThreadId(fileThread.id);

    const agentInbox = await invoke("inbox", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    expect(agentInbox.threads.map((thread) => thread.id)).toContain(agentDm.threadId);
    expect(agentInbox.threads.every((thread) => thread.group.kind === "agent")).toBe(true);
    expect(agentInbox.mentions).toEqual([
      expect.objectContaining({
        threadId: mention.threadId,
        messageId: mention.messageId,
        text: "Could @agent check the transport contract?",
      }),
    ]);

    const humanInbox = await invoke("inbox", {
      cwd: workspaceRoot,
      actor: "human",
    });
    expect(humanInbox.threads.map((thread) => thread.id)).toContain(humanUnread.threadId);
    expect(humanInbox.threads).toContainEqual(
      expect.objectContaining({ id: fileThreadId, group: expect.objectContaining({ slug: "files" }) }),
    );
    expect(humanInbox.mentions).toEqual([]);

    await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: fileThreadId,
      peek: true,
    });
    expect((await invoke("inbox", {
      cwd: workspaceRoot,
      actor: "human",
    })).threads.map((thread) => thread.id)).toContain(fileThreadId);
    await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: fileThreadId,
      peek: false,
    });
    expect((await invoke("inbox", {
      cwd: workspaceRoot,
      actor: "human",
    })).threads.map((thread) => thread.id)).not.toContain(fileThreadId);
  });

  it("toggles reactions with main-derived actor identity", async () => {
    const opened = await post({
      actor: "human",
      title: "Reaction target",
      body: "React to this",
    });
    const added = await invoke("react", {
      cwd: workspaceRoot,
      actor: "agent",
      message: opened.messageId,
      emoji: "👍",
    });
    expect(added).toEqual({
      threadId: opened.threadId,
      messageId: opened.messageId,
      emoji: "👍",
      state: "added",
    });
    await expect(invoke("react", {
      cwd: workspaceRoot,
      actor: "agent",
      message: opened.messageId,
      emoji: "👍",
    })).resolves.toEqual({ ...added, state: "removed" });
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

  it("full-scans overlong daemon FTS queries without asking the daemon", async () => {
    const pattern = "z".repeat(4_097);
    const matching = await post({
      actor: "human",
      title: "Overlong daemon query",
      body: `before-${pattern}-after`,
    });
    await post({
      actor: "human",
      title: "Overlong daemon unrelated",
      body: "Nothing relevant in this thread",
    });
    let daemonCalls = 0;
    const defaultDaemonReads = context.daemonReads;
    context.daemonReads = {
      collectionsWaiting: defaultDaemonReads.collectionsWaiting,
      async queryChatMessagesGranular() {
        daemonCalls += 1;
        return { results: [], saturated: false };
      },
      async listUnreadFileThreads() {
        return [];
      },
    };
    try {
      const result = await invoke("grep", {
        cwd: workspaceRoot,
        actor: "human",
        pattern,
        ignoreCase: false,
        filesWithMatches: false,
        context: 0,
        limit: 20,
        regex: false,
      });
      expect("matches" in result && result.matches.map((row) => row.threadId))
        .toEqual([matching.threadId]);
      expect(daemonCalls).toBe(0);
    } finally {
      context.daemonReads = defaultDaemonReads;
    }
  });

  it("paginates the daemon unread-file aggregate for the human inbox", async () => {
    if (!store) throw new Error("Store is not available");
    const fileThread = await store.createThread({
      workspaceId: WORKSPACE_ID,
      title: "Daemon unread file discussion",
      linkedFile: { objectId: "object_tracked", pathHint: "tracked.md" },
    });
    await store.sendMessage({
      authorActorKey: null,
      workspaceId: WORKSPACE_ID,
      threadId: fileThread.id,
      author: { kind: "agent", displayName: "Sam" },
      body: "Unread through the daemon aggregate",
    });
    let unread = true;
    let unreadCalls = 0;
    const defaultDaemonReads = context.daemonReads;
    context.daemonReads = {
      collectionsWaiting: defaultDaemonReads.collectionsWaiting,
      async queryChatMessagesGranular() {
        return { results: [], saturated: false };
      },
      async listUnreadFileThreads(input) {
        unreadCalls += 1;
        if (!unread) return [];
        if (!input.afterThreadId) {
          return Array.from({ length: 500 }, (_, index) => ({
            threadId: `page-${index.toString().padStart(4, "0")}`,
            messageCount: 1,
            lastReadSequence: 0,
          }));
        }
        expect(input.afterThreadId).toBe("page-0499");
        return [{
              threadId: fileThread.id,
              messageCount: 1,
              lastReadSequence: 0,
        }];
      },
    };
    try {
      expect((await invoke("inbox", {
        cwd: workspaceRoot,
        actor: "human",
      })).threads.map((thread) => thread.id)).toContain(cliThreadId(fileThread.id));
      unread = false;
      expect((await invoke("inbox", {
        cwd: workspaceRoot,
        actor: "human",
      })).threads.map((thread) => thread.id)).not.toContain(cliThreadId(fileThread.id));
      expect(unreadCalls).toBe(3);
    } finally {
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

  it("matches thread titles independently of message author and time filters", async () => {
    const opened = await post({
      actor: "human",
      title: "Release readiness review",
      body: "This root message is deliberately outside both filters.",
    });

    const grep = await invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "Release readiness",
      from: "agent",
      since: "2030-01-01T00:00:00.000Z",
      ignoreCase: false,
      filesWithMatches: false,
      context: 0,
      limit: 20,
      regex: false,
    });

    if (!("matches" in grep)) throw new Error("Expected message grep results");
    expect(grep.matches).toHaveLength(1);
    expect(grep.matches[0]).toMatchObject({
      threadId: opened.threadId,
      messageId: opened.messageId,
      text: "Release readiness review",
    });
  });

  it("uses Unicode uppercase letters for grep smart-case", async () => {
    const uppercase = await post({
      actor: "human",
      title: "Δ roadmap",
      body: "Uppercase title fixture.",
    });
    await post({
      actor: "human",
      title: "δ backlog",
      body: "Lowercase title fixture.",
    });

    const smartCase = await invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "Δ",
      ignoreCase: false,
      filesWithMatches: false,
      context: 0,
      limit: 20,
      regex: false,
    });
    if (!("matches" in smartCase)) throw new Error("Expected message grep results");
    expect(smartCase.matches.map((match) => match.threadId)).toEqual([
      uppercase.threadId,
    ]);

    const ignoredCase = await invoke("grep", {
      cwd: workspaceRoot,
      actor: "human",
      pattern: "Δ",
      ignoreCase: true,
      filesWithMatches: false,
      context: 0,
      limit: 20,
      regex: false,
    });
    if (!("matches" in ignoredCase)) throw new Error("Expected message grep results");
    expect(ignoredCase.matches).toHaveLength(2);
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

  it("advances human and agent read cursors while show --peek leaves both untouched", async () => {
    const humanTarget = await post({
      actor: "agent",
      title: "Unread by human",
      body: "Agent-authored opening",
    });
    if (!store) throw new Error("Store is not available");
    const general = await store.findChannelBySlug({
      workspaceId: WORKSPACE_ID,
      slug: "general",
    });
    if (!general) throw new Error("General channel is missing");
    const humanUnreadCount = async () => {
      const summaries = await store!.listChannelThreads({
        workspaceId: WORKSPACE_ID,
        channelId: general.id,
      });
      return summaries.find(
        (summary) => cliThreadId(summary.thread.id) === humanTarget.threadId,
      )?.unreadCount;
    };

    expect(await humanUnreadCount()).toBe(1);
    await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: humanTarget.threadId,
      peek: true,
    });
    expect(await humanUnreadCount()).toBe(1);
    await invoke("show", {
      cwd: workspaceRoot,
      actor: "human",
      target: humanTarget.threadId,
      peek: false,
    });
    expect(await humanUnreadCount()).toBe(0);

    const agentTarget = await post({
      actor: "human",
      title: "Unread by agent",
      body: "Human-authored opening",
    });
    const agentUnreadIds = async () =>
      (await store!.listAgentUnreadThreads(WORKSPACE_ID))
        .map((thread) => cliThreadId(thread.id));

    expect(await agentUnreadIds()).toContain(agentTarget.threadId);
    await invoke("show", {
      cwd: workspaceRoot,
      actor: "agent",
      target: agentTarget.threadId,
      peek: true,
    });
    expect(await agentUnreadIds()).toContain(agentTarget.threadId);
    await invoke("show", {
      cwd: workspaceRoot,
      actor: "agent",
      target: agentTarget.threadId,
      peek: false,
    });
    expect(await agentUnreadIds()).not.toContain(agentTarget.threadId);
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
  it("resolves a cwd under a '..'-prefixed directory NAME inside the root", async () => {
    const scratch = await createTestScratch("dohc-cli-containment-");
    const workspace: CliRegistryWorkspace = {
      workspaceId: "ws-1",
      rootPath: join(scratch, "cli-root"),
    };
    const cwd = join(workspace.rootPath, "..cache", "deep");
    await mkdir(cwd, { recursive: true });
    try {
      await expect(resolveCliWorkspace(cwd, [workspace])).resolves.toBe(workspace);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("does not resolve a sibling that only shares the root as a name prefix", async () => {
    const scratch = await createTestScratch("dohc-cli-sibling-");
    const workspace: CliRegistryWorkspace = {
      workspaceId: "ws-1",
      rootPath: join(scratch, "cli-root"),
    };
    const sibling = `${workspace.rootPath}-sibling`;
    await Promise.all([
      mkdir(workspace.rootPath, { recursive: true }),
      mkdir(sibling, { recursive: true }),
    ]);
    try {
      await expect(resolveCliWorkspace(sibling, [workspace])).resolves.toBeNull();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
