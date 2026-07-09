import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
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
import {
  LINKED_CHAT_STORE_RELATIVE_PATH,
  createAgentDispatchStore,
  createLinkedChatStore,
  type AgentDispatchStore,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "../workspaces/testTemp";
import {
  AGENTS_CHAT_BEGIN_MARKER,
  AGENTS_CHAT_END_MARKER,
  ensureAgentsChatBlock,
} from "./agentsChatBlock";
import {
  CLI_SOCKET_FILE,
  cliThreadId,
  handleCliRequestLine,
  startCliServer,
  type CliRegistryWorkspace,
  type CliServerHandle,
  type CliServerOptions,
  type CliWorkspaceContext,
} from "./cliServer";

const WORKSPACE_ID = "workspace-cli-server";
const SERVER_NOW_MS = Date.parse("2026-07-10T04:05:06.000Z");
const requireModule = createRequire(import.meta.url);
type DispatchDb = Parameters<typeof createAgentDispatchStore>[0];
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => DispatchDb;
};

type ArgsFor<Verb extends CliVerb> = Extract<CliRequest, { verb: Verb }>["args"];

interface CallCounts {
  listWorkspaces: number;
  openWorkspace: number;
  identity: number;
  writable: number;
  writes: number;
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
  let dispatchDb: DispatchDb | null;
  let dispatchStore: AgentDispatchStore;
  let server: CliServerHandle | null;
  let token: string;
  let calls: CallCounts;
  let errors: unknown[];
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
    await writeFile(join(stateDir, CLI_SOCKET_FILE), "stale socket marker", "utf8");
    await writeFile(
      join(workspaceRoot, "AGENTS.md"),
      "# Workspace instructions\n\nKeep this user-owned line.\n",
      "utf8",
    );

    const idCounters = { channel: 0, message: 0, thread: 0 };
    let storeNowMs = SERVER_NOW_MS;
    store = createLinkedChatStore(workspaceRoot, {
      nowMs: () => {
        storeNowMs += 1_000;
        return storeNowMs;
      },
      createId: (kind) => {
        idCounters[kind] += 1;
        return `${kind}_${idCounters[kind]}`;
      },
    });
    await store.listChannels({ workspaceId: WORKSPACE_ID });
    dispatchDb = new DatabaseSync(join(workspaceRoot, LINKED_CHAT_STORE_RELATIVE_PATH));
    dispatchStore = createAgentDispatchStore(dispatchDb);
    registryWorkspace = { workspaceId: WORKSPACE_ID, rootPath: workspaceRoot };
    calls = {
      listWorkspaces: 0,
      openWorkspace: 0,
      identity: 0,
      writable: 0,
      writes: 0,
    };
    errors = [];

    context = {
      ...registryWorkspace,
      store,
      dispatchStore,
      readOnly: false,
      async fileObjectIdForPath(path) {
        return path === "tracked.md" ? "object_tracked" : null;
      },
      async assertWritable() {
        calls.writable += 1;
      },
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
      nowMs: () => SERVER_NOW_MS,
      platform: "linux",
    };
    try {
      server = await startCliServer(serverOptions);
      await server.ready;
      token = (await readFile(server.tokenPath, "utf8")).trim();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (process.env.CODEX_SANDBOX_NETWORK_DISABLED !== "1" || code !== "EPERM") {
        throw error;
      }
      // The managed test sandbox forbids every listener, including AF_UNIX.
      // startCliServer already exercised state/token setup and AGENTS.md
      // setup before listen failed. Maintain the same fixture instructions,
      // then run requests through the exact authenticated line handler so
      // command/store coverage remains live.
      server = null;
      await ensureAgentsChatBlock(workspaceRoot);
      token = "a".repeat(64);
    }
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    dispatchDb?.close();
    dispatchDb = null;
    await store?.close();
    store = null;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects authentication before workspace lookup or verb dispatch", async () => {
    calls.listWorkspaces = 0;
    const rejectedToken = `${token.startsWith("0") ? "1" : "0"}${token.slice(1)}`;
    const response = await rawRequest({
      token: rejectedToken,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "post",
      args: {
        cwd: workspaceRoot,
        actor: "human",
        channel: "general",
        attachments: [],
        needsDecision: false,
        body: "Must not be dispatched",
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

  it("returns the fixed version mismatch before opening a workspace", async () => {
    const response = await rawRequest({
      token,
      protocolVersion: CLI_PROTOCOL_VERSION + 1,
      verb: "channels",
      args: { cwd: workspaceRoot, actor: "human" },
    });

    expect(response).toEqual({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: CLI/app version mismatch — restart the app",
    });
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

  it("rejects a nested read-only workspace instead of resolving its writable parent", async () => {
    if (!store) throw new Error("Store is not available");
    const sharedRoot = join(workspaceRoot, "shared-view");
    await mkdir(sharedRoot, { recursive: true });
    const sharedWorkspace: CliRegistryWorkspace = {
      workspaceId: "workspace-shared-view",
      rootPath: sharedRoot,
      readOnly: true,
    };
    serverOptions.listWorkspaces = () => [registryWorkspace, sharedWorkspace];
    const openCallsBefore = calls.openWorkspace;

    const response = await rawRequest({
      token,
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "channels",
      args: { cwd: sharedRoot, actor: "human" },
    });
    expect(response).toEqual({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: chats are not available in a read-only shared view",
    });
    expect(calls.openWorkspace).toBe(openCallsBefore);
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
        displayName: "Ice's agent",
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
        displayName: "Ice's agent",
        authorUserId: "verified-user-id",
        origin: "cli",
      },
    ]);
    expect(calls.identity).toBe(2);
    expect(calls.writable).toBe(2);
    expect(errors).toEqual([]);
  });

  it("links only agent-authored messages carrying a valid local run id", async () => {
    dispatchStore.recordTrigger({
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "message_dispatch_trigger",
      threadId: "thread_dispatch",
    });
    const claim = dispatchStore.claimNextPending(WORKSPACE_ID, {
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
    expect(dispatchStore.listRunMessages(WORKSPACE_ID, claim.run.runId)).toEqual([
      engineMessageId(opened.messageId),
      engineMessageId(replied.messageId),
    ]);
    expect(dispatchStore.runIdForMessage(
      WORKSPACE_ID,
      engineMessageId(human.messageId),
    )).toBeNull();
    expect(dispatchStore.runIdForMessage(
      WORKSPACE_ID,
      engineMessageId(unknown.messageId),
    )).toBeNull();
    expect(dispatchStore.runIdForMessage(
      WORKSPACE_ID,
      engineMessageId(invalid.messageId),
    )).toBeNull();
    expect(errors).toEqual([]);
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

  it("returns unread agent DMs, agent mentions, and human unread threads", async () => {
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
      author: { kind: "agent", displayName: "Ice's agent" },
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

  it("installs the managed chat instructions in every registered workspace on boot", async () => {
    const agents = await readFile(join(workspaceRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Workspace instructions");
    expect(agents).toContain("Keep this user-owned line.");
    expect(agents).toContain(AGENTS_CHAT_BEGIN_MARKER);
    expect(agents).toContain(AGENTS_CHAT_END_MARKER);
    expect(agents).toContain("`dohc chat inbox`");
    expect(agents).toContain("Always pass `--as-agent` on every chat write");
    if (server) {
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(server.tokenPath)).mode & 0o777).toBe(0o600);
      expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    }
    expect(calls.openWorkspace).toBe(0);
    expect(errors).toEqual([]);
  });

  it("installs chat instructions when a workspace is registered after boot", async () => {
    const lateRoot = join(tempRoot, "late-workspace");
    await mkdir(lateRoot, { recursive: true });
    const lateWorkspace: CliRegistryWorkspace = {
      workspaceId: "workspace-cli-late",
      rootPath: lateRoot,
    };
    const lateStore = createLinkedChatStore(lateRoot);
    await lateStore.listChannels({ workspaceId: lateWorkspace.workspaceId });
    const lateDispatchDb = new DatabaseSync(
      join(lateRoot, LINKED_CHAT_STORE_RELATIVE_PATH),
    );
    const lateDispatchStore = createAgentDispatchStore(lateDispatchDb);
    const originalOpenWorkspace = serverOptions.openWorkspace;
    serverOptions.listWorkspaces = () => [registryWorkspace, lateWorkspace];
    serverOptions.openWorkspace = async (workspace) => {
      if (workspace.workspaceId !== lateWorkspace.workspaceId) {
        return originalOpenWorkspace(workspace);
      }
      return {
        ...lateWorkspace,
        store: lateStore,
        dispatchStore: lateDispatchStore,
        readOnly: false,
        async fileObjectIdForPath() {
          return null;
        },
        async assertWritable() {
          calls.writable += 1;
        },
      };
    };

    try {
      await invoke("channels", { cwd: lateRoot, actor: "human" });
      const agents = await readFile(join(lateRoot, "AGENTS.md"), "utf8");
      expect(agents).toContain(AGENTS_CHAT_BEGIN_MARKER);
      expect(agents).toContain("`dohc chat inbox`");
    } finally {
      lateDispatchDb.close();
      await lateStore.close();
    }
  });
});
