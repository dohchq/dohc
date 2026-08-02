import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
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
  ChatsLoopbackEngine,
  DaemonRefusalError,
  type Request,
} from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AwaitableAgentDispatchStore } from "../agents/awaitableAgentDispatchStore";
import { createLiveAgentDispatchStore } from "../agents/liveAgentDispatchStore";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { nativeTmpdir } from "../workspaces/testTemp";
import {
  CLI_ENDPOINT_FILE,
  CLI_SOCKET_FILE,
  RUN_MESSAGE_LINK_RECOVERY_FILE,
  cliThreadId,
  disposeCliServerRuntime,
  handleCliRequestLine,
  restoreCliServerRuntime,
  startCliServer,
  type CliRegistryWorkspace,
  type CliServerHandle,
  type CliServerOptions,
  type CliWorkspaceContext,
} from "./cliServer";

const WORKSPACE_ID = "workspace-cli-server";
const SERVER_NOW_MS = Date.parse("2026-07-10T04:05:06.000Z");

type ArgsFor<Verb extends CliVerb> = Extract<CliRequest, { verb: Verb }>["args"];

interface CallCounts {
  listWorkspaces: number;
  openWorkspace: number;
  identity: number;
  writable: number;
  writes: number;
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
    author: {
      kind: "agent",
      agentId: `agent_${suffix}`,
      onBehalfOf: `user_${suffix}`,
      agentRunId: `run_${suffix}`,
    },
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
      author: summary.author,
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
  let errors: unknown[];
  let debugLines: string[];
  let registryWorkspace: CliRegistryWorkspace;
  let context: CliWorkspaceContext;
  let serverOptions: CliServerOptions;

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
    channel?: string;
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
      channel: input.channel ?? "general",
      title: input.title,
      attachments: input.attachments ?? [],
      needsDecision: input.needsDecision ?? false,
      body: input.body,
    });
  }

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(nativeTmpdir(), "dohc-cli-server-"));
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
          params.channelId = `channel_${++idCounters.channel}`;
          params.nowMs = (storeNowMs += 1_000);
        } else if (request.method === CHATS_METHOD.threadCreate) {
          params.threadId = `thread_${++idCounters.thread}`;
          params.nowMs = (storeNowMs += 1_000);
        } else if (request.method === CHATS_METHOD.threadStart) {
          params.threadId = `thread_${++idCounters.thread}`;
          params.messageId = `message_${++idCounters.message}`;
          params.nowMs = (storeNowMs += 1_000);
        } else if (request.method === CHATS_METHOD.messageSend) {
          params.messageId = `message_${++idCounters.message}`;
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
      writable: 0,
      writes: 0,
    };
    errors = [];
    debugLines = [];
    const moments = momentFixtures(WORKSPACE_ID, "primary", SERVER_NOW_MS);

    context = {
      ...registryWorkspace,
      store,
      dispatchStore,
      readOnly: false,
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
      async assertWritable() {
        calls.writable += 1;
      },
      async assertMessageWritable() {},
    };
    serverOptions = {
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
      async identity() {
        calls.identity += 1;
        return {
          displayName: "Ice",
          authorUserId: "verified-user-id",
          reactionAuthorId: "verified-user-id",
        };
      },
      async onWrite() {
        calls.writes += 1;
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
      await server.ready;
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
    expect(calls.writable).toBe(0);
    expect(calls.writes).toBe(0);
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

  it("rejects older and newer CLIs before opening a workspace", async () => {
    for (const protocolVersion of [
      CLI_PROTOCOL_VERSION - 1,
      CLI_PROTOCOL_VERSION + 1,
    ]) {
      const response = await rawRequest({
        token,
        protocolVersion,
        verb: "channels",
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
      verb: "channels",
      args: { cwd: stateDir, actor: "human" },
    });

    expect(response).toEqual({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: not inside a dohc workspace",
    });
    expect(calls.openWorkspace).toBe(0);
  });

  it("returns MCP-shaped history and chats with full engine ids and no CLI origin", async () => {
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
      workspaceId: WORKSPACE_ID,
      threadId: linkedThread.id,
      author: { kind: "human", displayName: "Ice" },
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
        summary: "Updated primary",
        files: [{ path: "primary.md", operation: "write" }],
      }],
    });
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
        authorDisplayName: "Ice",
      }],
      projection: {
        readOnly: true,
        text: expect.stringContaining("tracked.md"),
      },
    });

    const emptyChannels = await invoke("channelsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    expect(emptyChannels).toMatchObject({
      ok: true,
      channels: [{
        id: general.id,
        threadCount: 0,
        threads: [],
      }],
    });
    const started = await invoke("startChannelChat", {
      cwd: workspaceRoot,
      actor: "agent",
      channel: general.id,
      title: "Raw id contract",
      body: "Opening without a CLI origin",
    });
    expect(started).toMatchObject({
      ok: true,
      channel: { id: general.id, name: "general", slug: "general" },
      thread: { title: "Raw id contract" },
      message: {
        authorKind: "agent",
        authorDisplayName: "Ice",
        body: "Opening without a CLI origin",
      },
    });
    if (!started.ok) throw new Error(started.reason);
    const replied = await invoke("replyToChat", {
      cwd: workspaceRoot,
      actor: "human",
      threadId: started.thread.id,
      body: "Reply without a CLI origin",
    });
    expect(replied).toMatchObject({
      ok: true,
      message: {
        threadId: started.thread.id,
        authorKind: "human",
        authorDisplayName: "Ice",
        body: "Reply without a CLI origin",
      },
    });
    if (!replied.ok) throw new Error(replied.reason);

    const fullChannels = await invoke("channelsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    expect(fullChannels).toMatchObject({
      ok: true,
      channels: [{
        id: general.id,
        threadCount: 1,
        threads: [{
          id: started.thread.id,
          title: "Raw id contract",
          messageCount: 2,
          updatedAtMs: replied.message.createdAtMs,
        }],
      }],
    });

    expect(general.id).toMatch(/^channel_/u);
    expect(linkedThread.id).toMatch(/^thread_/u);
    expect(linkedMessage.id).toMatch(/^message_/u);
    expect(started.channel.id).toMatch(/^channel_/u);
    expect(started.thread.id).toMatch(/^thread_/u);
    expect(started.message.id).toMatch(/^message_/u);
    expect(replied.message.id).toMatch(/^message_/u);

    const persisted = await store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
    });
    expect(persisted.map((message) => ({
      kind: message.author.kind,
      displayName: message.author.displayName,
      authorUserId: message.authorUserId,
      origin: message.origin,
    }))).toEqual([
      {
        kind: "agent",
        displayName: "Ice",
        authorUserId: "verified-user-id",
        origin: undefined,
      },
      {
        kind: "human",
        displayName: "Ice",
        authorUserId: "verified-user-id",
        origin: undefined,
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
    expect(moments.changes.map((change) => change.path)).toEqual(["scoped.md"]);
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
    const channels = await invoke("channelsFull", {
      cwd: scopedRoot,
      actor: "agent",
    });
    expect(channels).toMatchObject({
      ok: true,
      channels: [{
        id: scopedGeneral.id,
        threads: [{ id: scopedChannelChat.thread.id }],
      }],
    });
    expect(
      channels.ok
        ? channels.channels.flatMap((channel) =>
            channel.threads.map((thread) => thread.title)
          )
        : [],
    ).not.toContain("Primary-only channel chat");

    const started = await invoke("startChannelChat", {
      cwd: scopedRoot,
      actor: "agent",
      channel: scopedGeneral.id,
      body: "Scoped opening",
    });
    if (!started.ok) throw new Error(started.reason);
    const replied = await invoke("replyToChat", {
      cwd: scopedRoot,
      actor: "agent",
      threadId: started.thread.id,
      body: "Scoped reply",
    });
    expect(replied).toMatchObject({
      ok: true,
      message: { threadId: started.thread.id },
    });
    expect(
      (await store.listThreads({ workspaceId: WORKSPACE_ID }))
        .map((thread) => thread.id),
    ).not.toContain(started.thread.id);
    expect(await scopedStore.listMessages({
      workspaceId: scopedWorkspaceId,
      threadId: started.thread.id,
    })).toHaveLength(2);
  });

  it("returns MCP write failures when assertWritable refuses the target", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const existing = await store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Existing message",
    });
    context.assertWritable = async () => {
      calls.writable += 1;
      throw new Error("This shared channel is read-only.");
    };

    await expect(invoke("startChannelChat", {
      cwd: workspaceRoot,
      actor: "agent",
      channel: general.id,
      body: "Must not land",
    })).resolves.toEqual({
      ok: false,
      reason: "This shared channel is read-only.",
    });
    await expect(invoke("replyToChat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: existing.thread.id,
      body: "Must not land",
    })).resolves.toEqual({
      ok: false,
      reason: "This shared channel is read-only.",
    });
    expect(calls.writable).toBe(2);
    expect(calls.identity).toBe(0);
    expect(calls.writes).toBe(0);
    expect(await store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: existing.thread.id,
    })).toHaveLength(1);
  });

  it("rejects every message command before the store write when message identity is unavailable", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    const existing = await store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Existing message",
    });
    const reason = "Sign in to dohc Cloud to send a message in this shared channel.";
    let messageGuardCalls = 0;
    const writesBefore = calls.writes;
    context.assertMessageWritable = async () => {
      messageGuardCalls += 1;
      throw new Error(reason);
    };

    await expect(invoke("startChannelChat", {
      cwd: workspaceRoot,
      actor: "agent",
      channel: general.id,
      body: "Blocked legacy opening",
    })).resolves.toEqual({ ok: false, reason });
    await expect(invoke("replyToChat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: existing.thread.id,
      body: "Blocked legacy reply",
    })).resolves.toEqual({ ok: false, reason });
    await expect(post({
      actor: "human",
      title: "Blocked modern opening",
      body: "Must not land",
    })).rejects.toThrow(reason);
    await expect(invoke("reply", {
      cwd: workspaceRoot,
      actor: "agent",
      thread: cliThreadId(existing.thread.id),
      attachments: [],
      needsDecision: false,
      body: "Blocked modern reply",
    })).rejects.toThrow(reason);

    expect(messageGuardCalls).toBe(4);
    expect(calls.identity).toBe(4);
    expect(calls.writes).toBe(writesBefore);
    expect(await store.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
    })).toHaveLength(1);
    expect(await store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: existing.thread.id,
    })).toHaveLength(1);
  });

  it("rejects legacy MCP messages when the account changes before mutation", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const existing = await store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Existing message",
    });
    let identityCalls = 0;
    serverOptions.identity = async () => {
      calls.identity += 1;
      identityCalls += 1;
      const userId = identityCalls % 2 === 1 ? "user-1" : "user-2";
      return {
        displayName: "Ice",
        authorUserId: userId,
        reactionAuthorId: "install-local-user-id",
      };
    };
    const reason = "dohc: Your dohc Cloud session changed. Try again.";

    await expect(
      invoke("startChannelChat", {
        cwd: workspaceRoot,
        actor: "agent",
        channel: general.id,
        body: "Blocked legacy opening",
      }),
    ).resolves.toEqual({ ok: false, reason });
    await expect(
      invoke("replyToChat", {
        cwd: workspaceRoot,
        actor: "agent",
        threadId: existing.thread.id,
        body: "Blocked legacy reply",
      }),
    ).resolves.toEqual({ ok: false, reason });

    expect(identityCalls).toBe(4);
    expect(
      await store.listChannelThreads({
        workspaceId: WORKSPACE_ID,
        channelId: general.id,
      }),
    ).toHaveLength(1);
    expect(
      await store.listMessages({
        workspaceId: WORKSPACE_ID,
        threadId: existing.thread.id,
      }),
    ).toHaveLength(1);
  });

  it("rechecks access after modern post attachments resolve", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    let writable = true;
    let attachmentResolutions = 0;
    const writesBefore = calls.writes;
    context.assertWritable = async () => {
      calls.writable += 1;
      if (!writable) throw new Error("This shared channel is read-only.");
    };
    context.fileObjectIdForPath = async () => {
      attachmentResolutions += 1;
      writable = false;
      return "object_tracked";
    };

    await expect(post({
      actor: "human",
      title: "Blocked after attachment",
      body: "Must not land",
      attachments: ["tracked.md"],
    })).rejects.toThrow("This shared channel is read-only.");

    expect(attachmentResolutions).toBe(1);
    expect(calls.identity).toBe(1);
    expect(calls.writable).toBe(2);
    expect(calls.writes).toBe(writesBefore);
    expect(await store.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
    })).toEqual([]);
  });

  it("rejects modern post when the resolved author changes", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });
    let identityCalls = 0;
    const writesBefore = calls.writes;
    serverOptions.identity = async () => {
      calls.identity += 1;
      identityCalls += 1;
      const userId = identityCalls === 1 ? "user-1" : "user-2";
      return {
        displayName: "Ice",
        authorUserId: userId,
        reactionAuthorId: userId,
      };
    };

    await expect(post({
      actor: "human",
      title: "Blocked account change",
      body: "Must not land",
      attachments: ["tracked.md"],
    })).rejects.toThrow("Your dohc Cloud session changed. Try again.");

    expect(identityCalls).toBe(2);
    expect(calls.writes).toBe(writesBefore);
    expect(await store.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
    })).toEqual([]);
  });

  it("keeps MCP chat reads available in read-only workspaces while refusing writes", async () => {
    if (!store) throw new Error("Store is not available");
    const general = await store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const channelChat = await store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: general.id,
      title: "Readable shared chat",
      author: { kind: "human", displayName: "Ice" },
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
      workspaceId: WORKSPACE_ID,
      threadId: fileThread.id,
      author: { kind: "human", displayName: "Ice" },
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
    await expect(invoke("channelsFull", {
      cwd: workspaceRoot,
      actor: "agent",
    })).resolves.toMatchObject({
      ok: true,
      channels: [{
        id: general.id,
        threads: [{ id: channelChat.thread.id }],
      }],
    });

    const openCallsAfterReads = calls.openWorkspace;
    await expect(invoke("startChannelChat", {
      cwd: workspaceRoot,
      actor: "agent",
      channel: general.id,
      body: "Forbidden",
    })).rejects.toThrow("chats are not available in a read-only shared view");
    await expect(invoke("replyToChat", {
      cwd: workspaceRoot,
      actor: "agent",
      threadId: channelChat.thread.id,
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
    context.assertWritable = async () => {
      calls.writable += 1;
      throw new Error("This is a shared view — ask its owner for changes.");
    };

    const channels = await invoke("channels", {
      cwd: workspaceRoot,
      actor: "human",
    });
    expect(channels.channels.map((channel) => channel.slug)).toEqual(["general"]);
    await expect(post({
      actor: "human",
      title: "Forbidden",
      body: "Must not land",
    })).rejects.toThrow("This is a shared view");
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
    expect(calls.writable).toBe(1);
    expect(calls.writes).toBe(0);
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

    const response = await invoke("channels", {
      cwd: sharedRoot,
      actor: "human",
    });
    expect(response.channels.map((channel) => channel.slug)).toEqual(["general"]);
    expect(calls.openWorkspace).toBe(openCallsBefore + 1);
    expect(openedWorkspaceIds).toEqual([sharedWorkspace.workspaceId]);
    expect(await store.listThreads({ workspaceId: WORKSPACE_ID })).toEqual([]);
    await expect(stat(join(sharedRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    expect(opened.channel.id).toMatch(/^ch_/u);
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
        displayName: "Ice",
        body: "Opening from the terminal",
        parentMessageId: undefined,
        decisionState: "resolved",
        attachments: [{ objectId: "object_tracked", pathHint: "tracked.md" }],
      },
      {
        id: replied.messageId,
        kind: "agent",
        displayName: "Ice",
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
        displayName: "Ice",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
      {
        kind: "agent",
        displayName: "Ice",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
    ]);
    expect(calls.identity).toBe(5);
    expect(calls.writable).toBe(5);
    expect(errors).toEqual([]);
  });

  it("rejects post for DM streams while allowing agent-channel task posts", async () => {
    if (!store) throw new Error("Store is not available");
    const dm = await store.createChannel({
      workspaceId: WORKSPACE_ID,
      name: "Alice",
      kind: "dm",
    });
    const writableBefore = calls.writable;

    await expect(post({
      actor: "human",
      channel: dm.slug,
      title: "Must not become a DM thread",
      body: "DMs need replies.",
    })).rejects.toThrow(
      "dohc: DMs are streams — use 'dohc chat reply <thread>'",
    );
    expect(calls.writable).toBe(writableBefore);
    expect(await store.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: dm.id,
    })).toEqual([]);

    const agentPost = await post({
      actor: "human",
      channel: "my-agent",
      title: "Agent task",
      body: "Agent channels still create task threads.",
    });
    expect(agentPost.channel.kind).toBe("agent");
    expect(agentPost.title).toBe("Agent task");
  });

  it("links only agent-authored messages carrying a valid local run id", async () => {
    await seedDispatchThread("thread_dispatch");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_dispatch_trigger",
      threadId: "thread_dispatch",
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
      id.startsWith("msg_") ? `message_${id.slice("msg_".length)}` : id;
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
    // MUTATION: restore the single best-effort attempt -> no provenance row is
    // stored after the first transient daemon failure.
    await seedDispatchThread("thread_retry");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_retry_trigger",
      threadId: "thread_retry",
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

    const engineMessageId = result.messageId.replace(/^msg_/u, "message_");
    expect(attempts).toBe(3);
    expect(result.warning).toBeUndefined();
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
    expect(errors).toEqual([]);
  });

  it("keeps retrying an exhausted provenance link until the posted reply is linked", async () => {
    // MUTATION: remove the recovery enqueue after the third foreground failure
    // -> the durable chat reply remains permanently absent from the run ledger.
    await seedDispatchThread("thread_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_recovery_trigger",
      threadId: "thread_recovery",
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

    const engineMessageId = result.messageId.replace(/^msg_/u, "message_");
    expect(result.warning).toContain("recovery will continue in the background");
    expect(attempts).toBe(4);
    expect(pending).toEqual([engineMessageId]);
    expect(settled).toEqual([engineMessageId]);
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
  });

  it("persists pending provenance across shutdown without reporting it settled", async () => {
    // MUTATION: clear the queue and call onRunMessageLinkSettled from close()
    // -> the durable file is absent and shutdown falsely reports recovery.
    await seedDispatchThread("thread_restart_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_restart_recovery_trigger",
      threadId: "thread_restart_recovery",
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
    const engineMessageId = result.messageId.replace(/^msg_/u, "message_");
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
    // MUTATION: return from restore when one workspace is absent -> the valid
    // link later in the file is never re-armed during this app session.
    const posted = await post({
      actor: "human",
      title: "Existing message",
      body: "This message will receive restored provenance.",
    });
    const engineMessageId = posted.messageId.replace(/^msg_/u, "message_");
    await seedDispatchThread("thread_mixed_restore");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_mixed_restore_trigger",
      threadId: "thread_mixed_restore",
    });
    const claim = await dispatchStore.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected a run for mixed restore.");
    const unavailable = {
      workspaceId: "workspace-not-registered",
      runId: "run_deferred",
      messageId: "message_deferred",
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
    // MUTATION: remove the size and attempt limits -> both links enter the
    // queue and the first continues retrying after the asserted cap.
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
      await seedDispatchThread(`thread_bounded_${suffix}`);
      await dispatchStore.recordTrigger({
        workspaceId: WORKSPACE_ID,
        triggerMessageId: `message_bounded_${suffix}`,
        threadId: `thread_bounded_${suffix}`,
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
      first.messageId.replace(/^msg_/u, "message_"),
    ]);
    await expect(
      stat(join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps all foreground provenance work with one wall-clock budget", async () => {
    // MUTATION: give every RPC its own full deadline -> all three attempts use
    // the same timeout instead of shrinking to the shared foreground budget.
    await seedDispatchThread("thread_foreground_budget");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_foreground_budget_trigger",
      threadId: "thread_foreground_budget",
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
    // MUTATION: swallow the final failure -> the successful CLI result has no
    // warning and the desktop error channel remains empty.
    await seedDispatchThread("thread_permanent");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_permanent_trigger",
      threadId: "thread_permanent",
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
    // MUTATION: treat the terminal refusal as retryable -> three attempts, a
    // degraded-provenance warning, and a background queue entry for a link the
    // daemon has already refused for good.
    await seedDispatchThread("thread_terminal_foreground");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_terminal_foreground_trigger",
      threadId: "thread_terminal_foreground",
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
    // MUTATION: treat the terminal refusal as retryable -> the recovery queue
    // burns all twelve attempts and reports the link abandoned instead of
    // settled.
    await seedDispatchThread("thread_terminal_recovery");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_terminal_recovery_trigger",
      threadId: "thread_terminal_recovery",
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

    const engineMessageId = result.messageId.replace(/^msg_/u, "message_");
    expect(settled).toEqual([engineMessageId]);
    expect(abandoned).toEqual([]);
    expect(attempts).toBe(4);
    await expect(
      stat(join(stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps retrying a terminal refusal the link taxonomy does not call permanent", async () => {
    // MUTATION: classify every terminal refusal as permanent -> a persist
    // failure the daemon can recover from drops the provenance link forever.
    await seedDispatchThread("thread_terminal_transient");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_terminal_transient_trigger",
      threadId: "thread_terminal_transient",
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

    const engineMessageId = result.messageId.replace(/^msg_/u, "message_");
    expect(attempts).toBe(3);
    expect(result.warning).toBeUndefined();
    expect(
      await originalDispatch.runIdForMessage(WORKSPACE_ID, engineMessageId),
    ).toBe(claim.run.runId);
    expect(errors).toEqual([]);
  });

  it("forwards a deadline to every provenance RPC attempt", async () => {
    await seedDispatchThread("thread_deadline");
    await dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_deadline_trigger",
      threadId: "thread_deadline",
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
      await expect(invoke("reply", {
        cwd: workspaceRoot,
        actor: "human",
        thread: opened.threadId,
        attachments: [],
        needsDecision: false,
        resolve: opened.messageId,
        body: "My resolving reply",
      })).rejects.toThrow("was posted, but decision");
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
    let writable = true;
    context.assertWritable = async () => {
      calls.writable += 1;
      if (!writable) throw new Error("This shared channel is read-only.");
    };
    const originalSend = store.sendMessage.bind(store);
    store.sendMessage = async (input) => {
      const message = await originalSend(input);
      writable = false;
      return message;
    };

    try {
      await expect(
        invoke("reply", {
          cwd: workspaceRoot,
          actor: "human",
          thread: opened.threadId,
          attachments: [],
          needsDecision: false,
          resolve: opened.messageId,
          body: "Reply before access changed",
        }),
      ).rejects.toThrow(
        "could not be resolved: This shared channel is read-only.",
      );
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
    context.daemonReads = {
      async queryChatMessagesGranular() {
        return { results: [], saturated: true };
      },
      listUnreadFileThreads,
    };
    const agentDm = await post({
      actor: "human",
      channel: "my-agent",
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
      workspaceId: WORKSPACE_ID,
      threadId: fileThread.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "This file-linked thread is unread too",
    });
    const fileThreadId = cliThreadId(fileThread.id);

    const agentInbox = await invoke("inbox", {
      cwd: workspaceRoot,
      actor: "agent",
    });
    expect(agentInbox.threads.map((thread) => thread.id)).toContain(agentDm.threadId);
    expect(agentInbox.threads.every((thread) => thread.channel.kind === "agent")).toBe(true);
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
      expect.objectContaining({ id: fileThreadId, channel: expect.objectContaining({ slug: "files" }) }),
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

  it("removes a signed-out reaction through its local alias after sign-in", async () => {
    const opened = await post({
      actor: "human",
      title: "Local reaction target",
      body: "React before signing in",
    });
    serverOptions.identity = async () => {
      calls.identity += 1;
      return {
        displayName: "Ice",
        reactionAuthorId: "install-local-user-id",
      };
    };
    const added = await invoke("react", {
      cwd: workspaceRoot,
      actor: "human",
      message: opened.messageId,
      emoji: "👍",
    });
    expect(added).toEqual({
      threadId: opened.threadId,
      messageId: opened.messageId,
      emoji: "👍",
      state: "added",
    });

    serverOptions.identity = async () => {
      calls.identity += 1;
      return {
        displayName: "Ice",
        authorUserId: "verified-user-id",
        reactionAuthorId: "install-local-user-id",
      };
    };
    await expect(
      invoke("react", {
        cwd: workspaceRoot,
        actor: "human",
        message: opened.messageId,
        emoji: "👍",
      }),
    ).resolves.toEqual({ ...added, state: "removed" });

    if (!store) throw new Error("Store is not available");
    const thread = (await store.listThreads({ workspaceId: WORKSPACE_ID })).find(
      (candidate) => cliThreadId(candidate.id) === opened.threadId,
    );
    if (!thread) throw new Error("Reaction thread is not available");
    expect(
      await store.listReactions({
        workspaceId: WORKSPACE_ID,
        threadId: thread.id,
      }),
    ).toEqual([]);
  });

  it("rejects a reaction when the resolved author changes before mutation", async () => {
    const opened = await post({
      actor: "human",
      title: "Reaction race target",
      body: "React to this",
    });
    let identityCalls = 0;
    serverOptions.identity = async () => {
      calls.identity += 1;
      identityCalls += 1;
      const userId = identityCalls === 1 ? "user-1" : "user-2";
      return {
        displayName: "Ice",
        authorUserId: userId,
        reactionAuthorId: userId,
      };
    };

    await expect(invoke("react", {
      cwd: workspaceRoot,
      actor: "agent",
      message: opened.messageId,
      emoji: "👍",
    })).rejects.toThrow("Your dohc Cloud session changed. Try again.");

    if (!store) throw new Error("Store is not available");
    const thread = (await store.listThreads({ workspaceId: WORKSPACE_ID }))
      .find((candidate) => cliThreadId(candidate.id) === opened.threadId);
    if (!thread) throw new Error("Reaction thread is not available");
    expect(await store.listReactions({
      workspaceId: WORKSPACE_ID,
      threadId: thread.id,
    })).toEqual([]);
  });

  // The TypeScript-backend twin of this scenario was removed with the legacy
  // sqlite fallback in queryFtsCandidates. The daemon test below asserts the
  // same property -- that grep hydrates ONLY the FTS candidate threads
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
    context.daemonReads = {
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
      delete context.daemonReads;
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
    context.daemonReads = {
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
      delete context.daemonReads;
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
      workspaceId: WORKSPACE_ID,
      threadId: fileThread.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "Unread through the daemon aggregate",
    });
    let unread = true;
    let unreadCalls = 0;
    context.daemonReads = {
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
      delete context.daemonReads;
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

    const exported = await invoke("export", {
      cwd: workspaceRoot,
      actor: "human",
      scope: { kind: "thread", thread: opened.threadId },
      outDir: "exports",
    });
    expect(exported.files).toHaveLength(1);
    expect(exported.files[0]?.threadId).toBe(opened.threadId);
    const markdown = await readFile(exported.files[0]!.path, "utf8");
    expect(markdown).toContain(
      `<!-- exported from dohc chat thread ${opened.threadId} at 2026-07-10T04:05:06.000Z -->`,
    );
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
    await expect(invoke("channels", {
      cwd: workspaceRoot,
      actor: "human",
    })).resolves.toMatchObject({ channels: expect.any(Array) });
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
