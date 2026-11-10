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
// to send.

const engine = requireEngineBinaryOrSkip();
const WORKSPACE = "workspace-trip";
const DEADLINE_MS = 30_000;

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

it.skipIf(engine.missing)("answers the phone's reads from the server's copy as the owner's computer reads them, and a page read sends nothing", async () => {
  const root = await tempRoot("account-operations-e2e");
  const storage = await testStorage();
  const key = new Uint8Array(32).fill(7), namespace = "account-operations-e2e";
  let copies: ServerCopies | undefined;
  // The relay as main.ts mounts it.
  const relay = createSyncRelayHandler({ storage, resolveActor: testActor, resolveAccountSession, serverCopies: () => copies });
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

  // The owner's computer writes a page, a Group with a post, and a chat on the page, and syncs.
  const owner = await computer({ root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: { kind: "claim" } });
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
  };
  copies = await startServerCopies({
    storage, root: join(root, "server"), engineExecutable: engine.require(), relayOrigin: "https://relay.example.test", key, namespace,
    startReplicas: async () => ({ unavailable: false, replica: (id) => id === WORKSPACE ? replica : undefined, reconcile: () => undefined,
      deleteWorkspaces: async () => undefined, failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined }),
  });
  const started = copies;
  cleanup.push(() => started.close());

  const read = async (operation: string, args: Record<string, JsonValue> = {}) => {
    const response = await relay(new Request(`${relayUrl}/sync/${WORKSPACE}/ops/${operation}`, {
      method: "POST", headers: { authorization: "Bearer session:owner", "content-type": "application/json" }, body: JSON.stringify(args),
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { result: unknown }).result;
  };
  // Where a person last read, and the wire IDs a computer gives its Groups, are each engine's own.
  const shared = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, field: unknown) =>
    ["unread", "unreadCount", "lastReadSequence", "readPosition", "channelWireId"].includes(key) ? undefined : field));
  const same = async (operation: string, args: Record<string, JsonValue>, expected: unknown) =>
    expect(shared(await read(operation, args)), operation).toEqual(shared(expected));

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
