import { DiscussionActivityHub } from "./discussionActivity";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError, type ResolveAccountSession, type ResolveActor } from "@dohc/workspace-auth/session";
import { ChatsLiveAdapter, VersionedLiveAdapter, type JsonValue } from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import {
  cliThreadId, listFileChats, listGroups, listGroupsWithThreads, listGroupThreads, readChat, readThreadDispatchState, showChat,
  type ChatsHost,
} from "@dohc/workspace-operations/chats";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import { phoneWriteIds } from "./accountChatWrites";
import { replicaChatStore } from "./automationChatWrites";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
  deriveAutomationReplicaBearer,
} from "./automationReplicaCredential";
import type { AutomationReplica } from "./automationReplicas";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { startServerCopies, type ServerCopies } from "./serverCopies";
import { createServiceHostReplication } from "./serviceHostReplication";
import { ServiceOrdinaryReplication, type ServiceOrdinaryReplicationConfig } from "./serviceOrdinaryReplication";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, tempRoot, testStorage } from "./testing";

// The owner's computer writes a page and chats and syncs. The phone then
// reads them through the relay's route from the server's copy of the
// workspace, the real engine in both, and gets what the owner's computer
// reads, and the change feed names them. A page read leaves the copy nothing
// to send. The phone's writes through the same route reach the relay as the
// copy's engine journaled them, and the owner's computer then reads them as
// the phone does.

const engine = requireEngineBinaryOrSkip();
const WORKSPACE = "workspace-trip";
const DEADLINE_MS = 30_000;
// This server's public origin, which issues the account's actor key.
const RELAY_ORIGIN = "https://relay.example.test";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeTestStorages();
});

// The relay's test seam: "Bearer test:<user>" is that user's computer, and
// "Bearer session:<user>" that user's phone.
const testActor: ResolveActor = (request, workspaceId) => {
  const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, workspaceId };
};
const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, sessionId: "phone", expiresAtMs: Number.MAX_SAFE_INTEGER };
};

/** One engine with the workspace open on the relay route and ordinary replication. */
async function computer(input: {
  root: string;
  relayUrl: string;
  bearerToken: string;
  identity: ServiceOrdinaryReplicationConfig["identity"];
}) {
  await mkdir(input.root, { recursive: true });
  const client = await createEngineClient({
    command: engine.require(), authToken: randomBytes(32).toString("base64url"),
    protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: DEADLINE_MS,
  });
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  const request = async (method: string, params: { [key: string]: JsonValue }, workspace?: string) =>
    (await client.sendRequest({ id: nextRequestId(), method, params, ...(workspace ? { workspace } : {}), deadlineMs: DEADLINE_MS }))
      .result as { [key: string]: JsonValue };
  const opened = await request("workspace.open", {
    rootDir: input.root, workspaceId: WORKSPACE, captureMode: "none", reconcileCollections: true,
    relay: { baseUrl: input.relayUrl, bearerToken: input.bearerToken, allowInsecureLoopbackForTests: true },
  });
  const workspace = opened.workspace as string;
  await request("versions.ensureMain", { workspaceId: WORKSPACE }, workspace);
  const lifetime = new AbortController();
  const replication = new ServiceOrdinaryReplication(
    { client, workspace, workspaceId: WORKSPACE, nextRequestId, deadlineMs: DEADLINE_MS, signal: lifetime.signal, assertCurrent: () => undefined },
    { relay: { baseUrl: "https://relay.example.test", bearerToken: input.bearerToken }, identity: input.identity, maxPagesPerPull: 8 },
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    await request("workspace.close", {}, workspace).catch(() => undefined);
    client.close();
    await client.waitForExit();
  };
  cleanup.push(close);
  return {
    client, workspace, lifetime: lifetime.signal, request, nextRequestId,
    /** Pushes what this engine has not sent, and answers how many changes went. */
    async push(): Promise<number> {
      let pushed = 0;
      for (let more = true; more;) {
        const page = await replication.push();
        pushed += page.pushed;
        more = page.hasMore;
      }
      return pushed;
    },
    async sync(): Promise<void> {
      await this.push();
      for (let more = true; more;) more = (await replication.pull()).hasMore;
    },
  };
}

/** The operations' host over one engine, as the server's copy reads it. */
function engineChats(client: AutomationReplica["client"], workspace: string): ChatsHost {
  const files = new VersionedLiveAdapter(client, workspace, { workspaceId: WORKSPACE });
  const resolved = async (target: { path: string } | { objectId: string }) =>
    (await files.resolveFiles({ workspaceId: WORKSPACE, targets: [target] })).results[0];
  return {
    workspaceId: WORKSPACE,
    store: replicaChatStore({ client, workspace, workspaceId: WORKSPACE }),
    fileObjectId: async (path) => { const found = await resolved({ path }); return found?.status === "found" ? found.objectId : null; },
    filePath: async (objectId) => { const found = await resolved({ objectId }); return found?.status === "found" ? found.path : null; },
    dispatch: (threadId) => readThreadDispatchState(new ChatsLiveAdapter(client, workspace, { workspaceId: WORKSPACE }), WORKSPACE, threadId),
    writable: false,
    provisioned: () => undefined,
    errorDetail: "full",
  };
}

// Where a person last read, and the wire IDs a computer gives its Groups, are each engine's own.
const shared = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, field: unknown) =>
  ["unread", "unreadCount", "lastReadSequence", "readPosition", "channelWireId"].includes(key) ? undefined : field));

/**
 * The relay as main.ts mounts it, with this server's public origin and the
 * accounts' names, its replication route on a loopback port, and the owner's
 * computer with the workspace open. Once the owner has synced, `openCopy`
 * joins the server for the account and opens its copy, which syncs before
 * each read and write. `route` asks the account operations route as the
 * owner's phone.
 */
async function relayAndOwner(lookupUserDisplayName?: (userId: string) => string | null) {
  const root = await tempRoot("account-operations-e2e");
  const storage = await testStorage();
  const key = new Uint8Array(32).fill(7), namespace = "account-operations-e2e";
  let copies: ServerCopies | undefined;
  const relay = createSyncRelayHandler({
    storage, resolveActor: testActor, resolveAccountSession, serverCopies: () => copies, relayPublicOrigin: RELAY_ORIGIN,
    ...(lookupUserDisplayName ? { lookupUserDisplayName } : {}),
  });
  const replicas = createServiceHostReplication({activity: new DiscussionActivityHub(), 
    storage, prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: (credential) => authorizeAutomationReplication(storage, { key, namespace, ...credential }),
  });
  const http = serveFetchHandler({
    handler: (request) => request.headers.get("authorization")?.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`)
      ? replicas(request) : relay(request),
    streamBody: streamsRequestBody,
    maxBodyBytes: () => 21 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const owner = await computer({ root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: { kind: "claim" } });

  const openCopy = async () => {
    const row = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: Date.now(), reasons: ["account"] });
    if (row === null) throw new Error("The relay did not let the server join the workspace.");
    const copy = await computer({
      root: join(root, "server", "workspace"), relayUrl,
      bearerToken: deriveAutomationReplicaBearer(row, { key, namespace }),
      identity: { kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity },
    });
    const replica: AutomationReplica = {
      workspaceId: WORKSPACE, ownerUserId: "owner", incarnation: row.incarnation, reasons: row.reasons, startedAtMs: row.startedAtMs, pulledHead: 0,
      root: join(root, "server", "workspace"), metadataDir: join(root, "server", "metadata"), client: copy.client, workspace: copy.workspace,
      signal: copy.lifetime, nextRequestId: copy.nextRequestId, withRecordWork: (work) => work(), sync: () => copy.sync(),
      step: async () => { await copy.sync(); return true; },
    };
    const started = await startServerCopies({
      storage, root: join(root, "server"), engineExecutable: engine.require(), relayOrigin: RELAY_ORIGIN, key, namespace,
      startReplicas: async () => ({ unavailable: false, replica: (id) => id === WORKSPACE ? replica : undefined, reconcile: () => undefined,
        deleteWorkspaces: async () => undefined, failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined }),
    });
    copies = started;
    cleanup.push(() => started.close());
    return copy;
  };

  const route = async (operation: string, args: Record<string, JsonValue> = {}) => {
    const response = await relay(new Request(`${relayUrl}/sync/${WORKSPACE}/ops/${operation}`, {
      method: "POST", headers: { authorization: "Bearer session:owner", "content-type": "application/json" }, body: JSON.stringify(args),
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { result: unknown }).result;
  };
  const same = async (operation: string, args: Record<string, JsonValue>, expected: unknown) =>
    expect(shared(await route(operation, args)), operation).toEqual(shared(expected));
  return { storage, relay, relayUrl, owner, openCopy, route, same };
}

it.skipIf(engine.missing)("answers the phone's reads from the server's copy as the owner's computer reads them, and a page read sends nothing", async () => {
  const { storage, relay, relayUrl, owner, openCopy, route: read, same } = await relayAndOwner();

  // The owner's computer writes a page, a Group with a post, and a chat on the page, and syncs.
  const main = await owner.request("versions.ensureMain", {}, owner.workspace);
  await owner.request("versionedText.write", {
    versionId: main.id as string, path: "docs/plan.md", text: "# Plan\n\nStay in Alfama.\n", origin: "api", publish: true, createOnly: true,
  }, owner.workspace);
  const chats = new ChatsLiveAdapter(owner.client, owner.workspace, { workspaceId: WORKSPACE });
  const author = { kind: "human" as const, displayName: "Owner" };
  const planning = await chats.createChannel({ workspaceId: WORKSPACE, name: "Planning" });
  const post = await chats.startChannelThread({
    workspaceId: WORKSPACE, channelId: planning.channelId, author, authorUserId: "owner", authorActorKey: null, body: "Where do we stay?",
  });
  const ownerChats = engineChats(owner.client, owner.workspace);
  const plan = await ownerChats.fileObjectId("docs/plan.md");
  if (plan === null) throw new Error("The owner's computer does not track the page.");
  const onPage = await chats.createThread({ workspaceId: WORKSPACE, title: "Plan", linkedFile: { objectId: plan, pathHint: "docs/plan.md" } });
  await chats.sendMessage({ workspaceId: WORKSPACE, threadId: onPage.id, author, authorUserId: "owner", authorActorKey: null, body: "Looks good." });
  await owner.sync();

  // The server joins for the account and opens its copy, which syncs before each read.
  const copy = await openCopy();

  await same("groups", {}, await listGroups(ownerChats));
  await same("threads", { group: "planning" }, await listGroupThreads(ownerChats, { group: "planning", reader: null }));
  await same("groupsFull", {}, await listGroupsWithThreads(ownerChats));
  await same("fileChats", { path: "docs/plan.md" }, await listFileChats(ownerChats, "docs/plan.md", process.platform));
  await same("chat", { threadId: onPage.id }, await readChat(ownerChats, { threadId: onPage.id }));
  await same("chat", { group: "planning" }, await readChat(ownerChats, { group: "planning" }));
  const stream = await showChat(ownerChats, { target: "planning", peek: true });
  await same("show", { target: "planning", peek: true }, stream);
  const thread = await showChat(ownerChats, { target: cliThreadId(post.thread.id), peek: true });
  await same("show", { target: cliThreadId(post.thread.id), peek: true }, "stream" in thread ? thread : thread.thread);
  expect(JSON.stringify(await read("groupsFull"))).toContain("Where do we stay?");
  const listed = await read("listFiles") as { ok: true; files: Array<{ path: string; objectId: string }>; folders: string[] };
  expect(listed.files).toContainEqual(expect.objectContaining({ path: "docs/plan.md", objectId: plan, contentKind: "text" }));
  expect(listed.folders).toContain("docs");
  expect(await read("readText", { path: "docs/plan.md" })).toEqual({ ok: true, path: "docs/plan.md", text: "# Plan\n\nStay in Alfama.\n" });

  // The change feed reads the relay's log: the page, its file, and the chats the owner's computer wrote.
  const standing = storage.accountFeedStanding(WORKSPACE)!;
  const feed = await relay(new Request(`${relayUrl}/sync/${WORKSPACE}/ops/changes?since=${standing.floor}.0.0`, {
    headers: { authorization: "Bearer session:owner" },
  }));
  expect(feed.status, await feed.clone().text()).toBe(200);
  expect(await feed.json()).toMatchObject({
    ok: true, cursor: `${standing.floor}.${standing.log}.${standing.journal}`,
    changed: { files: expect.arrayContaining([plan]), pages: expect.arrayContaining([plan]), chats: expect.any(Array) },
  });

  // A page read writes nothing to the copy, so the copy has nothing to send and the relay's log stays as it was.
  const db = (storage as StorageContext).db;
  const logRows = () => Number(db.prepare("SELECT COUNT(*) AS n FROM sync_relay_log WHERE workspace_id = ?").get(WORKSPACE)!.n);
  const before = logRows();
  expect(await read("documentRead", { path: "docs/plan.md" })).toEqual({ ok: true, path: "docs/plan.md", markdown: "# Plan\n\nStay in Alfama.\n" });
  expect(await copy.push()).toBe(0);
  expect(logRows()).toBe(before);
}, 120_000);

it.skipIf(engine.missing)("saves the phone's writes through a copy that holds no file, as the relay accepts them and the owner's computer reads them", async () => {
  let name = "Ana";
  const { storage, owner, openCopy, route, same } = await relayAndOwner((userId) => userId === "owner" ? name : null);

  // The owner's computer writes Groups, DMs and chats, and no file: the copy holds only its main version.
  const chats = new ChatsLiveAdapter(owner.client, owner.workspace, { workspaceId: WORKSPACE });
  const said = { author: { kind: "human" as const, displayName: "Owner" }, authorUserId: "owner", authorActorKey: null };
  const planning = await chats.createChannel({ workspaceId: WORKSPACE, name: "Planning", type: "posts" });
  const lunch = await chats.createChannel({ workspaceId: WORKSPACE, name: "Lunch", type: "chat" });
  const ada = await chats.createChannel({ workspaceId: WORKSPACE, name: "Ada", kind: "dm" });
  const ben = await chats.createChannel({ workspaceId: WORKSPACE, name: "Ben", kind: "dm" });
  const running = await chats.startChannelThread({ workspaceId: WORKSPACE, channelId: ben.channelId, lane: "chat", ...said, body: "Hi Ben" });
  // A thread on a file the copy never held, and one on a secret file.
  const gone = await chats.createThread({ workspaceId: WORKSPACE, title: "Gone", linkedFile: { objectId: "object-gone", pathHint: "docs/gone.md" } });
  const onGone = await chats.sendMessage({ workspaceId: WORKSPACE, threadId: gone.id, ...said, body: "Where did it go?" });
  const keys = await chats.createThread({ workspaceId: WORKSPACE, title: "Keys", linkedFile: { objectId: "object-keys", pathHint: ".env" } });
  const onKeys = await chats.sendMessage({ workspaceId: WORKSPACE, threadId: keys.id, ...said, body: "Which key?" });
  await owner.sync();
  const copy = await openCopy();
  const ownerChats = engineChats(owner.client, owner.workspace);

  const db = (storage as StorageContext).db;
  // The payloads of the rows of one kind the relay accepted that hold these fields.
  const accepted = (kind: string, fields: Record<string, JsonValue>) => db.prepare(
    "SELECT payload_json FROM sync_relay_log WHERE workspace_id = ? AND op_kind = ? AND relay_admission IS NULL ORDER BY relay_seq",
  ).all(WORKSPACE, kind).map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>)
    .filter((payload) => Object.entries(fields).every(([field, value]) => JSON.stringify(payload[field]) === JSON.stringify(value)));
  const recorded = (operationId: string) => db.prepare(
    "SELECT stage, message_state FROM sync_relay_account_operations WHERE operation_id = ?").get(operationId);
  const logRows = () => Number(db.prepare("SELECT COUNT(*) AS n FROM sync_relay_log WHERE workspace_id = ?").get(WORKSPACE)!.n);
  type Saved = { ok: true; state: "saved"; threadId: string; messageId?: string };
  // A write the route saved, with its row settled, after which the owner's computer syncs.
  const saved = async (operation: string, args: Record<string, JsonValue>): Promise<Saved> => {
    const result = await route(operation, args);
    expect(result, operation).toMatchObject({ ok: true, state: "saved", threadId: expect.any(String) });
    expect(recorded(String(args.operationId)), operation).toMatchObject({ stage: "saved" });
    await owner.sync();
    return result as Saved;
  };
  const sameThread = async (threadId: string) => await same("chat", { threadId }, await readChat(ownerChats, { threadId }));
  const sameStream = async (group: string) => await same("chat", { group }, await readChat(ownerChats, { group }));

  // A post, by the account's name now.
  const post = { operationId: "op-post", groupId: planning.channelId, title: "Dinner", body: "Where do we eat?" };
  const posted = await saved("post", post);
  expect(posted).toEqual({ ok: true, state: "saved", threadId: phoneWriteIds("owner", WORKSPACE, "op-post").threadId,
    messageId: phoneWriteIds("owner", WORKSPACE, "op-post").messageId("post") });
  const postThread = posted.threadId, postMessage = posted.messageId!;
  expect(recorded("op-post")).toMatchObject({ message_state: "published" });
  expect(accepted("chat.message.append", { messageId: postMessage })).toMatchObject([{
    threadId: postThread, authorKind: "human", authorDisplayName: "Ana", authorUserId: "owner", body: "Where do we eat?",
  }]);
  await sameThread(postThread);
  await sameStream(planning.channelId);

  // A send into a Group's chat, and one into an empty DM, start their conversations. One into a DM with a running
  // conversation joins it, and answers with that thread.
  expect((await saved("send", { operationId: "op-lunch", streamId: lunch.channelId, body: "Lunch at one?" })).threadId)
    .toBe(phoneWriteIds("owner", WORKSPACE, "op-lunch").threadId);
  await sameStream(lunch.channelId);
  expect((await saved("send", { operationId: "op-ada", streamId: ada.channelId, body: "Are you coming?" })).threadId)
    .toBe(phoneWriteIds("owner", WORKSPACE, "op-ada").threadId);
  await sameStream(ada.channelId);
  const toBen = await saved("send", { operationId: "op-ben", streamId: ben.channelId, body: "On my way." });
  expect(toBen.threadId).toBe(running.thread.id);
  expect(accepted("chat.message.append", { messageId: toBen.messageId! })).toMatchObject([{ threadId: running.thread.id, body: "On my way." }]);
  await sameThread(running.thread.id);
  await sameStream(ben.channelId);

  // A reply, and one under the post's message.
  expect((await saved("reply", { operationId: "op-reply", threadId: postThread, body: "The place by the river." })).threadId).toBe(postThread);
  const under = await saved("reply", { operationId: "op-parent", threadId: postThread, parentMessageId: postMessage, body: "Agreed." });
  expect(accepted("chat.message.append", { messageId: under.messageId! })).toMatchObject([{ parentMessageId: postMessage }]);

  // A question whose choices the engine trims, then the answer that picks one.
  const question = await saved("reply", { operationId: "op-question", threadId: postThread, body: "Alfama or Baixa?", options: [" Alfama ", "Baixa "] });
  expect(accepted("chat.decision.set", { messageId: question.messageId!, state: "open" })).toMatchObject([{ options: ["Alfama", "Baixa"] }]);
  const answered = await saved("reply", {
    operationId: "op-answer", threadId: postThread, body: "Alfama, then.", resolves: { messageId: question.messageId!, chosenOption: " Alfama " },
  });
  expect(accepted("chat.decision.set", { messageId: question.messageId!, state: "resolved" }))
    .toMatchObject([{ resolvedByMessageId: answered.messageId, chosenOption: "Alfama" }]);
  await sameThread(postThread);

  // A reaction added, then removed.
  for (const state of ["added", "removed"] as const) {
    await saved("react", { operationId: `op-${state}`, messageId: postMessage, emoji: "👍", state });
    expect(accepted("chat.reaction.set", { messageId: postMessage, state }), state)
      .toMatchObject([{ emoji: "👍", authorId: "owner", authorDisplayName: "Ana" }]);
    await sameThread(postThread);
  }

  // A thread on a file the copy never held reads with its file unavailable, and takes a reply and a reaction.
  const onFile = await route("chat", { threadId: gone.id }) as { ok: boolean; projection: { text: string } };
  expect(onFile.ok).toBe(true);
  expect(onFile.projection.text).toContain("Linked file: unavailable");
  await saved("reply", { operationId: "op-gone", threadId: gone.id, body: "It moved." });
  await saved("react", { operationId: "op-gone-seen", messageId: onGone.id, emoji: "👀", state: "added" });
  await sameThread(gone.id);

  // One on a secret file reads, and takes writes, as a thread that isn't there, and no write is recorded.
  const hidden = { ok: false, reason: `chat thread not found: ${keys.id}`, refusal: "missing" };
  expect(await route("chat", { threadId: keys.id })).toEqual(hidden);
  expect(await route("reply", { operationId: "op-keys", threadId: keys.id, body: "This one." })).toEqual(hidden);
  expect(await route("react", { operationId: "op-keys-seen", messageId: onKeys.id, emoji: "👀", state: "added" }))
    .toEqual({ ok: false, reason: `dohc: no such message in this thread: ${onKeys.id}`, refusal: "missing" });
  expect(recorded("op-keys")).toBeUndefined();
  expect(recorded("op-keys-seen")).toBeUndefined();

  // A retry under the account's new name answers from the row: the copy sends nothing, and the post keeps its author.
  name = "Ana Maria";
  const before = logRows();
  expect(await route("post", post)).toEqual(posted);
  expect(await copy.push()).toBe(0);
  expect(logRows()).toBe(before);
  expect(accepted("chat.message.append", { messageId: postMessage })).toMatchObject([{ authorDisplayName: "Ana" }]);
}, 120_000);
