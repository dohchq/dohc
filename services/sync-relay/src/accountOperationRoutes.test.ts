import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { UnauthorizedError, type AccountSession, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { ChatsLiveAdapter, VersionedLiveAdapter, type EngineTransport, type JsonValue } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { cliThreadId } from "@dohc/workspace-operations/chats";
import { ChatsLoopbackEngine, VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { cleanupLiveDeliveryFixtures, registered } from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { ACCOUNT_FEED_WAITS_PER_ACCOUNT, createAccountFeedWaits } from "./accountFeed";
import { AUTOMATION_REPLICA_BEARER_PREFIX, authorizeAutomationReplication, deriveAutomationReplicaBearer } from "./automationReplicaCredential";
import { createServiceHostReplication } from "./serviceHostReplication";
import { createAccountDeletionRoute } from "./accountDeletionRoute";
import { DiscussionActivityHub } from "./discussionActivity";
import type { AutomationReplica } from "./automationReplicas";
import { ACCOUNT_VISITS_PER_CALLER, startServerCopies } from "./serverCopies";
import { streamsRequestBody } from "./server";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, denialBytes, json, testHandler, testStorage } from "./testing";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

// The reads run over the real server copies and operations, with each copy's
// engine an in-memory stand-in for its chats and files.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await closeTestStorages();
  cleanupLiveDeliveryFixtures();
});

// `Bearer session:<user>:<session>` is a valid sign-in; anything else is not.
const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, sessionId: match[2]!, expiresAtMs: Number.MAX_SAFE_INTEGER } satisfies AccountSession;
};
const signedIn = (userId: string, sessionId = "phone") => ({ authorization: `Bearer session:${userId}:${sessionId}` });

function op(workspaceId: string, operation: string, args: unknown = {}, headers: Record<string, string> = signedIn("ana")): Request {
  return new Request(`http://relay.test/sync/${encodeURIComponent(workspaceId)}/ops/${operation}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: typeof args === "string" ? args : JSON.stringify(args),
  });
}

/**
 * One engine for chats and files, which fails a method on request. Its file
 * listing can also name `listedHidden`, as an engine that kept a secret file,
 * or a path it ignores, among the others would.
 */
class TestEngine implements EngineTransport {
  readonly chats = new ChatsLoopbackEngine();
  readonly files = new VersionedLoopbackEngine();
  readonly failing = new Map<string, Error>();
  readonly listedHidden: string[] = [];
  onEvent() { return () => undefined; }
  close() {}
  async sendRequest(request: Parameters<EngineTransport["sendRequest"]>[0]) {
    const failure = this.failing.get(request.method);
    if (failure) throw failure;
    if (request.method.startsWith("chats.")) return await this.chats.sendRequest(request);
    const response = await this.files.sendRequest(request);
    if (request.method !== "versionedText.list" || this.listedHidden.length === 0) return response;
    const page = response.result as { files: Array<Record<string, JsonValue>> };
    const listed = this.listedHidden.map((path) => ({ ...page.files[0]!, path, objectId: `object-${path}` }));
    return { ...response, result: { ...page, files: [...page.files, ...listed] } };
  }
  methods(): string[] {
    return [...this.chats.requests, ...this.files.requests].map((request) => request.method);
  }
}

async function serverCopies(storage: SyncRelayStorage, engine: TestEngine) {
  const syncs: string[] = [];
  let held: Promise<void> | null = null;
  let requestId = 0;
  const lifetime = new AbortController();
  const copies = await startServerCopies({
    storage, root: "unused", engineExecutable: "unused", relayOrigin: "https://relay.example.test", key: new Uint8Array(32), namespace: "test",
    startReplicas: async (hooks) => {
      const open = new Map<string, AutomationReplica>();
      const pass = () => {
        const wanted = hooks.wanted();
        for (const [workspaceId, reasons] of wanted) {
          const row = storage.joinAutomationWorkspace({ workspaceId, nowMs: 1, reasons });
          if (!row || open.has(workspaceId)) continue;
          open.set(workspaceId, {
            workspaceId, ownerUserId: row.ownerUserId, incarnation: row.incarnation, reasons: row.reasons, startedAtMs: 1, pulledHead: 0,
            root: "unused", metadataDir: "unused", client: engine as unknown as EngineClient, workspace: workspaceId, signal: lifetime.signal,
            nextRequestId: () => ++requestId, withRecordWork: (work) => work(),
            sync: async () => { syncs.push(workspaceId); await held; },
          });
          hooks.onChanged?.(workspaceId);
        }
        for (const workspaceId of [...open.keys()]) if (!wanted.has(workspaceId)) open.delete(workspaceId);
      };
      return { unavailable: false, replica: (id) => open.get(id), reconcile: () => queueMicrotask(pass), deleteWorkspaces: async () => undefined,
        failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined };
    },
  });
  cleanup.push(async () => { lifetime.abort(); await copies.close(); });
  return {
    copies, syncs,
    /** Holds every sync until the returned function is called. */
    holdSyncs() {
      let release!: () => void;
      held = new Promise((resolve) => { release = resolve; });
      return () => { held = null; release(); };
    },
  };
}

async function relay(options: { accountApi?: boolean; resolve?: ResolveAccountSession; limiter?: TokenBucketLimiter; activity?: DiscussionActivityHub } = {}) {
  const storage = await testStorage();
  for (const [workspaceId, ownerUserId] of [["trip", "ana"], ["notes", "ana"], ["budget", "ben"]] as const) {
    storage.claimWorkspace({ workspaceId, ownerUserId, createdAtMs: 1 });
    if (workspaceId !== "notes") storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
  }
  const engine = new TestEngine();
  const run = await serverCopies(storage, engine);
  const activity = options.activity ?? new DiscussionActivityHub();
  const h = testHandler(storage, {
    accountApi: options.accountApi ?? true, resolveAccountSession: options.resolve ?? resolveAccountSession, serverCopies: () => run.copies,
    ...(options.limiter ? { accountOperationRateLimiter: options.limiter } : {}),
    discussionActivity: activity,
  });
  return { storage, engine, h, activity, ...run };
}

/** A trip with a Group, a thread with two attachments, a page, and a thread on the page. */
async function seedTrip(engine: TestEngine) {
  const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
  engine.files.seedTextFile({ workspace: "trip", path: "docs/plan.md", text: "# Plan\n\nStay in Alfama.\n", objectId: "object-plan" });
  const planning = await chats.createChannel({ workspaceId: "trip", name: "Planning" });
  const author = { kind: "human" as const, displayName: "Ana" };
  const started = await chats.startChannelThread({
    workspaceId: "trip", channelId: planning.channelId, threadId: "thread-stay", messageId: "message-stay", author, authorActorKey: null,
    body: "Where do we stay?", attachments: [{ objectId: "object-plan", pathHint: "docs/plan.md" }, { objectId: "object-env", pathHint: ".env" }],
  });
  const onPage = await chats.createThread({ workspaceId: "trip", title: "Plan", linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" } });
  await chats.sendMessage({ workspaceId: "trip", threadId: onPage.id, messageId: "message-page", author, authorActorKey: null, body: "Looks good." });
  const onSecret = await chats.createThread({ workspaceId: "trip", title: "Keys", linkedFile: { objectId: "object-env", pathHint: ".env" } });
  return { planning, thread: started.thread, onPage, onSecret };
}

async function answer(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).result as Record<string, unknown>;
}

/**
 * Appends one row to a workspace's log and wakes its waits, as the relay's
 * log routes do. A moment also places its object at its path, or deletes it.
 * It calls wakeLog itself, so a test that needs a route to wake the feed
 * writes through that route instead.
 */
function logWriter(storage: SyncRelayStorage, activity: DiscussionActivityHub, workspaceId = "trip") {
  const context = storage as StorageContext;
  let originSeq = 0;
  const append = (opKind: string, payload: Record<string, unknown>) => context.tx(() => {
    const row = context.db.prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
      VALUES (?, 'origin-test', ?, ?, ?, 1) RETURNING relay_seq`).get(workspaceId, ++originSeq, opKind, JSON.stringify(payload))!;
    const relaySeq = Number(row.relay_seq);
    if (opKind === "moment.append") {
      context.db.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
        VALUES (?, ?, ?, ?, 'main', ?, 1)`).run(workspaceId, String(payload.objectId), relaySeq, `moment-${relaySeq}`, payload.path ?? null);
    }
    return relaySeq;
  });
  return (opKind: string, payload: Record<string, unknown>) => {
    const relaySeq = append(opKind, payload);
    activity.wakeLog(workspaceId);
    return relaySeq;
  };
}

function changes(since: string, options: { hold?: number; headers?: Record<string, string>; workspaceId?: string; signal?: AbortSignal } = {}): Request {
  const query = new URLSearchParams({ since, ...(options.hold === undefined ? {} : { hold: String(options.hold) }) });
  return new Request(`http://relay.test/sync/${options.workspaceId ?? "trip"}/ops/changes?${query}`, {
    headers: options.headers ?? signedIn("ana"), ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function feed(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return await json(response);
}

describe("an account's reads through the server's copy", () => {
  it("answers each read from the copy once it has synced, without creating General", async () => {
    const { engine, h, syncs } = await relay();
    const { planning, thread, onPage } = await seedTrip(engine);

    expect(await answer(await h(op("trip", "groups")))).toMatchObject({ groups: [{ name: "Planning", slug: "planning" }] });
    expect(syncs).toEqual(["trip"]);
    expect(await answer(await h(op("trip", "threads", { group: "planning" })))).toMatchObject({ threads: [{ title: "Where do we stay?" }] });
    expect(await answer(await h(op("trip", "groupsFull")))).toMatchObject({ ok: true, groups: [{ slug: "planning", threadCount: 1 }] });
    expect(await answer(await h(op("trip", "fileChats", { path: "docs/plan.md" }))))
      .toMatchObject({ ok: true, path: "docs/plan.md", fileObjectId: "object-plan", threads: [{ id: onPage.id }] });
    const onFile = await answer(await h(op("trip", "chat", { threadId: onPage.id })));
    expect(onFile).toMatchObject({ ok: true, thread: { id: onPage.id }, messages: [{ body: "Looks good." }] });
    expect(onFile.projection).toMatchObject({ text: expect.stringContaining("docs/plan.md") });
    expect(await answer(await h(op("trip", "chat", { group: "planning" }))))
      .toMatchObject({ ok: true, stream: { group: { id: planning.channelId }, items: [{ threadId: thread.id }] } });
    expect(await answer(await h(op("trip", "show", { target: "planning", peek: true }))))
      .toMatchObject({ stream: { group: { slug: "planning" } } });
    expect(await answer(await h(op("trip", "show", { target: "th_stay", peek: true }))))
      .toMatchObject({ thread: { title: "Where do we stay?" }, dispatch: { paused: null, lastRun: null } });
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/plan.md" }))))
      .toEqual({ ok: true, path: "docs/plan.md", markdown: "# Plan\n\nStay in Alfama." });

    expect(syncs).toHaveLength(9);
    expect(engine.methods()).not.toContain("chats.channels.ensureGeneral");
  });

  it("is not served while the account API is off", async () => {
    const { h, syncs } = await relay({ accountApi: false });
    await denialBytes(await h(op("trip", "groups")));
    expect(syncs).toEqual([]);
  });

  it("refuses a request without a Bearer session, one with a cookie, and a fenced account, before it opens a copy", async () => {
    const { storage, h, syncs } = await relay();
    const missing = await denialBytes(await h(op("trip", "groups", {}, {})));
    expect(await denialBytes(await h(op("trip", "groups", {}, { cookie: "session=ana" })))).toBe(missing);
    expect(await denialBytes(await h(op("trip", "groups", {}, { ...signedIn("ana"), cookie: "session=ana" })))).toBe(missing);
    expect((await h(op("trip", "groups", {}, { authorization: "Bearer user:ana" }))).status, "a sign-in it cannot validate").toBe(401);
    createAccountDeletionRoute({ storage: storage as StorageContext, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {} })
      .fence("ana", "ana@example.test");
    expect(await denialBytes(await h(op("trip", "groups")))).toBe(missing);
    expect(syncs).toEqual([]);
  });

  it("answers another account's workspace, a missing one and an impossible ID alike, without reading the arguments", async () => {
    const { h, syncs } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    let pulled = false;
    const unread = new Request("http://relay.test/sync/budget/ops/groups", {
      method: "POST", headers: { ...signedIn("ana"), "content-type": "application/json" }, duplex: "half",
      body: new ReadableStream({ pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } },
        { highWaterMark: 0 }),
    } as RequestInit & { duplex: "half" });
    expect(await denialBytes(await h(unread))).toBe(missing);
    expect(pulled, "the body of a request for another account's workspace").toBe(false);
    expect(await denialBytes(await h(op("link", "groups")))).toBe(missing);
    expect(await denialBytes(await h(op("account", "groups")))).toBe(missing);
    expect(await denialBytes(await h(op("trip/x", "groups")))).toBe(missing);
    expect(syncs).toEqual([]);
  });

  it("answers a workspace without a sync identity, and one hidden from the phone, as missing", async () => {
    const { storage, h, syncs } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    expect(await denialBytes(await h(op("notes", "groups")))).toBe(missing);
    storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
    expect(await denialBytes(await h(op("trip", "groups")))).toBe(missing);
    expect(syncs).toEqual([]);
  });

  it("answers an unknown operation, and the reserved `changes`, as missing", async () => {
    const { h, syncs } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    for (const name of ["changes", "groupCreate", "reply", "watch", "toString", "__proto__"]) {
      expect(await denialBytes(await h(op("trip", name))), name).toBe(missing);
    }
    expect(syncs).toEqual([]);
  });

  it("takes exactly each operation's server arguments", async () => {
    const { engine, h, syncs } = await relay();
    await seedTrip(engine);
    for (const [name, args] of [
      ["groups", { cwd: "/", actor: "human" }],
      ["groups", { agentId: "nova" }],
      ["groups", { token: "a".repeat(64) }],
      ["threads", { group: "planning", actor: "agent" }],
      ["show", { target: "planning", peek: false }],
      ["show", { target: "planning" }],
      ["show", { target: "planning", peek: true, runSecret: "a".repeat(64) }],
      ["documentRead", { path: "docs/plan.md", agent: "Nova" }],
      ["chat", { threadId: "thread-stay", group: "planning" }],
      ["groups", []],
      ["groups", "not json"],
    ] as const) {
      const response = await h(op("trip", name, args));
      expect(response.status, `${name} ${JSON.stringify(args)}`).toBe(400);
      expect((await json(response)).code).toBe("bad_request");
    }
    expect(syncs).toEqual([]);
  });

  it("refuses arguments over 256 KiB, and streams them so the owner is checked first", async () => {
    const { h, syncs } = await relay();
    const response = await h(op("trip", "documentRead", { path: "a".repeat(256 * 1024) }));
    expect(response.status).toBe(413);
    expect(streamsRequestBody(new URL("http://relay.test//sync/trip/%6Fps/groups"), "POST")).toBe(true);
    expect(syncs).toEqual([]);
  });

  it("answers only POST", async () => {
    const { h } = await relay();
    expect((await h(new Request("http://relay.test/sync/trip/ops/groups", { headers: signedIn("ana") }))).status).toBe(405);
  });

  it("answers as missing when the sign-in changes after the arguments arrive, after the copy opens, or after it syncs", async () => {
    for (const changedAt of [2, 3, 4, 5]) {
      let reads = 0;
      const { engine, h } = await relay({ resolve: async (request) => {
        const session = await resolveAccountSession(request);
        return ++reads >= changedAt ? { ...session, sessionId: "another" } : session;
      } });
      await seedTrip(engine);
      const response = await h(op("trip", "documentRead", { path: "docs/plan.md" }));
      expect(response.status, `changed at check ${changedAt}`).toBe(404);
      expect(await response.text()).not.toContain("Alfama");
    }
  });

  it("answers as missing, with no result, when access ends once the result is ready", async () => {
    let reads = 0;
    const { engine, h, syncs } = await relay({ resolve: async (request) => {
      const session = await resolveAccountSession(request);
      // Before the arguments, after them, once the copy opens, once it syncs, then once the result is ready.
      return ++reads === 5 ? { ...session, sessionId: "another" } : session;
    } });
    await seedTrip(engine);
    const response = await h(op("trip", "documentRead", { path: "docs/plan.md" }));
    expect(reads).toBe(5);
    expect(syncs).toEqual(["trip"]);
    expect(engine.files.requests.map((request) => request.method)).toContain("versionedText.read");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Alfama");
  });

  it("answers as missing when the workspace changes owner while the copy syncs", async () => {
    const { storage, engine, h, holdSyncs, syncs } = await relay();
    await seedTrip(engine);
    const release = holdSyncs();
    const pending = h(op("trip", "documentRead", { path: "docs/plan.md" }));
    await expect.poll(() => syncs.length).toBe(1);
    (storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'").run();
    release();
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Alfama");
  });
  it("answers as missing when the workspace stops showing on the phone while the copy syncs", async () => {
    const { storage, engine, h, holdSyncs, syncs } = await relay();
    await seedTrip(engine);
    const release = holdSyncs();
    const pending = h(op("trip", "documentRead", { path: "docs/plan.md" }));
    await expect.poll(() => syncs.length).toBe(1);
    storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
    release();
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Alfama");
  });

  it("answers an unknown operation without reading its arguments", async () => {
    const { h } = await relay();
    let pulled = false;
    const unread = new Request("http://relay.test/sync/trip/ops/changes", {
      method: "POST", headers: { ...signedIn("ana"), "content-type": "application/json" }, duplex: "half",
      body: new ReadableStream({ pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } },
        { highWaterMark: 0 }),
    } as RequestInit & { duplex: "half" });
    await denialBytes(await h(unread));
    expect(pulled).toBe(false);
  });
});

describe("an account's share of the server", () => {
  it("answers server_busy past one sign-in's open visits", async () => {
    const { h, holdSyncs, syncs } = await relay();
    const release = holdSyncs();
    const held = Array.from({ length: ACCOUNT_VISITS_PER_CALLER }, () => h(op("trip", "groups")));
    await expect.poll(() => syncs.length).toBe(ACCOUNT_VISITS_PER_CALLER);
    const busy = await h(op("trip", "groups"));
    expect(busy.status).toBe(503);
    expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    release();
    for (const response of await Promise.all(held)) expect(response.status).toBe(200);
    expect((await h(op("trip", "groups"))).status).toBe(200);
  });

  it("answers server_busy past one sign-in's rate, keyed by the sign-in", async () => {
    const { h } = await relay({ limiter: new TokenBucketLimiter(1, 0.001, 16) });
    expect((await h(op("trip", "groups"))).status).toBe(200);
    const limited = await h(op("trip", "groups"));
    expect(limited.status).toBe(503);
    expect(await json(limited)).toMatchObject({ ok: false, code: "server_busy" });
    expect((await h(op("trip", "groups", {}, signedIn("ana", "laptop")))).status).toBe(200);
  });
});

describe("failures through the server's copy", () => {
  const engineFailure = () => new Error("The engine could not open /srv/dohc/automations/trip/.dohc/engine/engine.db.");

  it("words an engine failure in an operation's result with the operation's own reason", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    engine.failing.set("chats.threads.listForChannel", engineFailure());
    expect(await answer(await h(op("trip", "groupsFull")))).toEqual({ ok: false, reason: "failed to list groups" });
  });

  it("answers an engine failure an operation throws without its detail", async () => {
    const { engine, h } = await relay();
    engine.failing.set("chats.channels.list", engineFailure());
    const response = await h(op("trip", "groups"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("/srv/");
  });

  it("words a rejected document read without the engine's detail, and keeps an operation's own refusal", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    engine.failing.set("versionedText.read", engineFailure());
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/plan.md" }))))
      .toEqual({ ok: false, reason: "failed to read document: docs/plan.md" });
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/plan.txt" }))))
      .toEqual({ ok: false, reason: "dohc: docs/plan.txt is not a Markdown document." });
    const refused = await h(op("trip", "show", { target: "th_nowhere", peek: true }));
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ ok: false, error: "dohc: no such thread or message: th_nowhere", code: "bad_request" });
  });
});

describe("secret files through the server's copy", () => {
  it("reads a secret file's page exactly as a missing one, without asking the engine", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    const missing = (path: string) => ({ ok: false, reason: `dohc: No document at ${path}.`, refusal: "missing" });
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/missing.md" })))).toEqual(missing("docs/missing.md"));
    const reads = engine.files.requests.length;
    for (const [path, normalized] of [
      [".env", ".env"], ["a/.env/b.md", "a/.env/b.md"], ["x.env", "x.env"], [".env.local", ".env.local"],
      ["%2Eenv", ".env"], ["notes/.ENV.md", "notes/.ENV.md"],
    ] as const) {
      expect(await answer(await h(op("trip", "documentRead", { path }))), path).toEqual(missing(normalized));
    }
    expect(engine.files.requests.slice(reads).map((request) => request.method)).toEqual([]);
  });

  it("answers a secret file's page with the same bytes as a missing one's, its path aside", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    const bytes = async (path: string) => {
      const response = await h(op("trip", "documentRead", { path }));
      return { status: response.status, type: response.headers.get("content-type"), body: (await response.text()).replaceAll(path, "<path>") };
    };
    const missing = await bytes("docs/missing.md");
    expect(missing.body).toContain('"refusal":"missing"');
    for (const path of [".env", "docs/.env.local", "a/.env/b.md"]) expect(await bytes(path), path).toEqual(missing);
  });

  it("lists a secret file's chats exactly as a missing file's, and reads its threads and attachments as missing", async () => {
    const { engine, h } = await relay();
    const { onSecret } = await seedTrip(engine);
    expect(await answer(await h(op("trip", "fileChats", { path: "%2Eenv" }))))
      .toEqual({ ok: true, path: ".env", fileObjectId: null, threads: [] });
    expect(await answer(await h(op("trip", "fileChats", { path: "docs/missing.md" }))))
      .toEqual({ ok: true, path: "docs/missing.md", fileObjectId: null, threads: [] });
    // The thread's file is nowhere in the copy, as a secret file never is.
    expect(await answer(await h(op("trip", "chat", { threadId: onSecret.id }))))
      .toEqual({ ok: false, reason: `chat thread not found: ${onSecret.id}` });
    expect(await answer(await h(op("trip", "chat", { threadId: "thread-nowhere" }))))
      .toEqual({ ok: false, reason: "chat thread not found: thread-nowhere" });
    for (const target of [onSecret.id, cliThreadId(onSecret.id)]) {
      expect(await json(await h(op("trip", "show", { target, peek: true })))).toMatchObject({ code: "bad_request", error: `dohc: no such thread or message: ${target}` });
    }
    const ambiguous = await json(await h(op("trip", "show", { target: "th_", peek: true })));
    expect(ambiguous).toMatchObject({ code: "bad_request", error: expect.stringContaining("ambiguous thread or message prefix") });
    expect(String(ambiguous.error)).not.toContain(cliThreadId(onSecret.id));
    expect(JSON.stringify(await answer(await h(op("trip", "groupsFull"))))).not.toContain(onSecret.id);

    const shown = await answer(await h(op("trip", "show", { target: "th_stay", peek: true })));
    expect(shown.messages).toMatchObject([{ attachments: [{ objectId: "object-plan", pathHint: "docs/plan.md" }] }]);
    const stream = await answer(await h(op("trip", "chat", { group: "planning" })));
    expect(JSON.stringify(stream)).not.toContain("object-env");
  });

  it("keeps a chat on a deleted file readable, and hides one on a file the relay last saw at a secret path", async () => {
    const { storage, engine, h } = await relay();
    const { planning } = await seedTrip(engine);
    // The relay's log puts each object somewhere, then deletes it; none is in the copy now.
    const moment = (objectId: string, relaySeq: number, path: string | null) => (storage as StorageContext).db.prepare(
      `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
       VALUES ('trip', ?, ?, ?, 'main', ?, 1)`).run(objectId, relaySeq, `moment-${relaySeq}`, path);
    moment("object-old", 1, "docs/old.md");
    moment("object-old", 2, null);
    moment("object-dotenv", 3, ".env");
    moment("object-dotenv", 4, null);
    moment("object-renamed", 5, "docs/keys.md");
    moment("object-renamed", 6, ".env.local");
    const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
    const author = { kind: "human" as const, displayName: "Ana" };
    const thread = async (objectId: string, pathHint: string) => {
      const created = await chats.createThread({ workspaceId: "trip", title: objectId, linkedFile: { objectId, pathHint } });
      await chats.sendMessage({ workspaceId: "trip", threadId: created.id, author, authorActorKey: null, body: `On ${objectId}` });
      return created;
    };
    const deleted = await thread("object-old", "docs/old.md");
    // Each hint names an ordinary file; the relay's own record decides.
    const dotenv = await thread("object-dotenv", "docs/notes.md");
    const renamed = await thread("object-renamed", "docs/keys.md");

    const read = await answer(await h(op("trip", "chat", { threadId: deleted.id })));
    expect(read).toMatchObject({ ok: true, thread: { title: "object-old" }, messages: [{ body: "On object-old" }] });
    expect((read.projection as { text: string }).text).toContain("Linked file: unavailable");
    expect(await answer(await h(op("trip", "show", { target: cliThreadId(deleted.id), peek: true }))))
      .toMatchObject({ thread: { title: "object-old" }, messages: [{ body: "On object-old" }] });
    for (const hidden of [dotenv, renamed]) {
      expect(await answer(await h(op("trip", "chat", { threadId: hidden.id }))), hidden.title)
        .toEqual({ ok: false, reason: `chat thread not found: ${hidden.id}` });
      expect(await json(await h(op("trip", "show", { target: cliThreadId(hidden.id), peek: true }))))
        .toMatchObject({ code: "bad_request", error: `dohc: no such thread or message: ${cliThreadId(hidden.id)}` });
    }

    await chats.startChannelThread({
      workspaceId: "trip", channelId: planning.channelId, threadId: "thread-files", messageId: "message-files", author, authorActorKey: null,
      body: "Files", attachments: [{ objectId: "object-old", pathHint: "docs/old.md" }, { objectId: "object-dotenv", pathHint: "docs/notes.md" }],
    });
    const shown = await answer(await h(op("trip", "show", { target: "th_files", peek: true })));
    expect(shown.messages).toMatchObject([{ body: "Files", attachments: [{ objectId: "object-old", pathHint: "docs/old.md" }] }]);
  });
});

describe("pages the relay hosts live", () => {
  async function livePage(seed: (engine: TestEngine) => void = (engine) =>
    engine.files.seedTextFile({ workspace: "workspace", path: "docs/a.md", text: "Hello\n", objectId: "object" })) {
    const f = registered({ deployment: true });
    cleanup.push(async () => f.close());
    f.storage.claimWorkspaceIdentity({ workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream" });
    const engine = new TestEngine();
    seed(engine);
    const run = await serverCopies(f.storage, engine);
    const h = testHandler(f.storage, { accountApi: true, resolveAccountSession, serverCopies: () => run.copies });
    const read = async () => await h(op("workspace", "documentRead", { path: "docs/a.md" }, signedIn("owner")));
    const edit = () => expect(f.storage.commitLiveUpdateJournal(f.capture(f.update("title", "Lisbon"))).result.kind).toBe("accepted");
    return { f, engine, read, edit };
  }
  const edited = { ok: true, path: "docs/a.md", markdown: "---\ntitle: Lisbon\n---\n\nHello" };

  it("reads an edit the relay accepted before it settles, and writes nothing", async () => {
    const { f, engine, read, edit } = await livePage();
    expect(await answer(await read())).toEqual({ ok: true, path: "docs/a.md", markdown: "Hello" });
    edit();
    const journal = f.journalRows().journal.length;
    expect(await answer(await read())).toEqual(edited);
    expect(f.journalRows().journal).toHaveLength(journal);
    expect(new Set(engine.methods())).toEqual(new Set(["versions.active", "versionedText.read"]));
  });

  it("reads the object now at the path when an older object kept it as its stored path", async () => {
    const { f, read, edit } = await livePage();
    // An older object, moved away or replaced, whose current lineage still names docs/a.md.
    f.write((db) => {
      const columns = (db.prepare("PRAGMA table_info(sync_relay_live_documents)").all() as Array<{ name: string }>).map(({ name }) => name);
      db.prepare(`INSERT INTO sync_relay_live_documents (${columns.join(",")}) SELECT ${columns.map((name) => name === "object_id" ? "'a-older-object'" : name).join(",")}
        FROM sync_relay_live_documents WHERE object_id = 'object'`).run();
    });
    edit();
    expect(await answer(await read())).toEqual(edited);
  });

  it("answers restore-in-progress, not the older file, while a restore keeps the relay from cutting the page", async () => {
    const { f, read, edit } = await livePage();
    edit();
    const document = f.input.evidence.document;
    const plan = f.storage.readStopRestorePlan({ operationId: "restore", ownerUserId: "owner", document, shareId: "share", grantId: "grant",
      restorePointCursor: 0, restorePointReceiptDigest: document.lineageClaimId, maxOutputBytes: MAX_PAYLOAD_JSON_BYTES });
    f.storage.beginStopRestore(plan.intent, 100);
    expect(f.storage.advanceStopRestoreFence({ workspaceId: "workspace", ownerUserId: "owner", operationId: "restore" }, 110).phase).toBe("fenced");
    const response = await read();
    expect(response.status).toBe(409);
    // This route's own words, not the code's default, which is live editing's.
    expect(await json(response)).toEqual({ ok: false, code: "restore-in-progress", error: "This page is being restored. Try again once it finishes." });
  });

  it("reads the active version's settled file when it isn't main, or the page as missing when the copy doesn't hold it", async () => {
    const named = await livePage();
    const files = new VersionedLiveAdapter(named.engine, "workspace", { workspaceId: "workspace" });
    const main = await files.getActiveVersion({ workspaceId: "workspace" });
    const draft = await files.createNamedVersion({ workspaceId: "workspace", name: "Draft", fromVersionId: main!.id });
    named.engine.files.seedTextFile({ workspace: "workspace", versionId: draft.id, path: "docs/a.md", text: "Draft\n", objectId: "object" });
    await files.setActiveVersion({ workspaceId: "workspace", versionId: draft.id });
    named.edit();
    expect(await answer(await named.read())).toEqual({ ok: true, path: "docs/a.md", markdown: "Draft" });

    const absent = await livePage(() => undefined);
    absent.edit();
    expect(await answer(await absent.read())).toEqual({ ok: false, reason: "dohc: No document at docs/a.md.", refusal: "missing" });
  });
});

describe("file reads through the server's copy", () => {
  function seedFiles(engine: TestEngine) {
    for (const [path, text] of [["docs/plan.md", "# Plan\n"], ["docs/trips/lisbon.md", "Alfama\n"], ["Docs/old.md", "Old\n"]] as const) {
      engine.files.seedTextFile({ workspace: "trip", path, text, objectId: `object-${path}` });
    }
    engine.listedHidden.push(".env", "docs/.env.local", "a/.env/b.md", "docs/.DS_Store.");
    engine.files.seedBinaryFile({ workspace: "trip", path: "photo.png", bytes: [1, 2, 3], objectId: "object-photo" });
  }
  const paths = (result: Record<string, unknown>) => ({
    files: (result.files as Array<{ path: string }>).map((file) => file.path), folders: result.folders,
  });

  it("lists the copy's files in lexical order without hidden ones, and reads a text file", async () => {
    const { engine, h, syncs } = await relay();
    seedFiles(engine);
    const listed = await answer(await h(op("trip", "listFiles")));
    expect(paths(listed)).toEqual({ files: ["Docs/old.md", "docs/plan.md", "docs/trips/lisbon.md", "photo.png"], folders: ["Docs", "docs", "docs/trips"] });
    expect((listed.files as unknown[])[3]).toEqual({ path: "photo.png", objectId: "object-photo", contentKind: "binary", byteLength: 3 });
    expect(paths(await answer(await h(op("trip", "listFiles", { path: "docs", recursive: false })))))
      .toEqual({ files: ["docs/plan.md"], folders: ["docs", "docs/trips"] });
    expect(await answer(await h(op("trip", "readText", { path: "./docs//plan.md" })))).toEqual({ ok: true, path: "docs/plan.md", text: "# Plan\n" });
    expect(await answer(await h(op("trip", "readText", { path: "photo.png" }))))
      .toEqual({ ok: false, reason: "dohc: photo.png is not a text file.", refusal: "binary" });
    expect(syncs).toEqual(["trip", "trip", "trip", "trip"]);
  });

  it("reads a secret file exactly as a missing one, without asking the engine", async () => {
    const { engine, h } = await relay();
    seedFiles(engine);
    const missing = (path: string) => ({ ok: false, reason: `dohc: No file at ${path}.` });
    expect(await answer(await h(op("trip", "readText", { path: "docs/missing.md" })))).toEqual(missing("docs/missing.md"));
    const reads = engine.files.requests.length;
    for (const [path, normalized] of [[".env", ".env"], ["%2Eenv", ".env"], ["docs/.env.local", "docs/.env.local"], ["a/.env/b.md", "a/.env/b.md"]] as const) {
      expect(await answer(await h(op("trip", "readText", { path }))), path).toEqual(missing(normalized));
    }
    expect(engine.files.requests.slice(reads).map((request) => request.method)).toEqual([]);
    expect(JSON.stringify(await answer(await h(op("trip", "listFiles", { path: "a" }))))).not.toContain(".env");
  });

  it("refuses a page over the desktop's editor limit without fetching its body", async () => {
    const { engine, h } = await relay();
    engine.files.seedTextFile({ workspace: "trip", path: "docs/big.md", text: "a".repeat(2 * 1024 * 1024 + 1) });
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/big.md" }))))
      .toEqual({ ok: false, reason: "dohc: This page is too large to open here.", refusal: "too-large" });
    expect(engine.methods()).toContain("versionedText.read");
    expect(engine.methods()).not.toContain("versionedText.readBlob");
  });

  it("refuses a text file over the desktop's editor limit without fetching its body", async () => {
    const { engine, h } = await relay();
    engine.files.seedTextFile({ workspace: "trip", path: "big.txt", text: "a".repeat(2 * 1024 * 1024 + 1) });
    expect(await answer(await h(op("trip", "readText", { path: "big.txt" }))))
      .toEqual({ ok: false, reason: "dohc: big.txt is larger than 2097152 bytes.", refusal: "too-large" });
    expect(engine.methods()).toContain("versionedText.read");
    expect(engine.methods()).not.toContain("versionedText.readBlob");
  });

  it("takes exactly the file reads' arguments, and words an engine failure without its detail", async () => {
    const { engine, h } = await relay();
    seedFiles(engine);
    for (const [name, args] of [["listFiles", { cwd: "/" }], ["listFiles", { path: 1 }], ["listFiles", { recursive: "no" }],
      ["readText", {}], ["readText", { path: "a.md", actor: "human" }]] as const) {
      const response = await h(op("trip", name, args));
      expect(response.status, `${name} ${JSON.stringify(args)}`).toBe(400);
    }
    engine.failing.set("versionedText.list", new Error("The engine could not open /srv/dohc/engine.db."));
    expect(await answer(await h(op("trip", "listFiles")))).toEqual({ ok: false, reason: "failed to list files" });
  });
});

describe("an account's change feed", () => {
  it("answers each read with the cursor of what its copy had synced", async () => {
    const { storage, activity, h } = await relay();
    expect((await json(await h(op("trip", "groups")))).cursor).toBe("0.0.0");
    const relaySeq = logWriter(storage, activity)("chat.channel.create", { channelId: "c" });
    expect((await json(await h(op("trip", "groups")))).cursor).toBe(`0.${relaySeq}.0`);
  });

  it("delivers a change made between a read and the feed's start, from the log alone", async () => {
    const { storage, activity, engine, h, syncs } = await relay();
    await seedTrip(engine);
    const { cursor } = await json(await h(op("trip", "groups")));
    const write = logWriter(storage, activity);
    write("moment.append", { objectId: "object-plan", path: "docs/plan.md", versionId: "main" });
    write("chat.message.append", { threadId: "thread-stay", messageId: "m" });
    write("chat.channel.create", { channelId: "c" });
    write("moment.append", { objectId: "object-photo", path: "photo.png", versionId: "main" });
    const last = write("moment.append", { objectId: "object-photo", path: null, versionId: "main" });
    const delivered = await feed(await h(changes(String(cursor))));
    expect(delivered).toEqual({ ok: true, cursor: `0.${last}.0`,
      changed: { files: ["object-plan", "object-photo"], pages: ["object-plan"], chats: ["thread-stay"] } });
    expect(await feed(await h(changes(String(delivered.cursor))))).toEqual({ ok: true, cursor: `0.${last}.0`, changed: {} });
    expect(syncs).toEqual(["trip"]);
  });

  it("leaves out changes on secret files, and keeps waiting through them", async () => {
    let checks = 0;
    const { storage, activity, h } = await relay({ resolve: async (request) => { checks += 1; return await resolveAccountSession(request); } });
    const write = logWriter(storage, activity);
    write("moment.append", { objectId: "object-keys", path: "docs/keys.md", versionId: "main" });
    // A thread made on .env whose object now sits at a public path stays hidden, as its reads hide it.
    write("moment.append", { objectId: "object-moved", path: "docs/moved.md", versionId: "main" });
    const start = write("chat.thread.create", { threadId: "thread-keys", linkedObjectId: "object-moved", linkedPathHint: ".env" });
    const held = h(changes(`0.${start}.0`, { hold: 30_000 }));
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const parked = checks;
    write("moment.append", { objectId: "object-env", path: ".env", versionId: "main" });
    write("moment.append", { objectId: "object-ignored", path: "docs/.DS_Store.", versionId: "main" });
    write("chat.message.append", { threadId: "thread-keys", messageId: "m" });
    // The wake checks the sign-in again, finds nothing it may answer, and waits on.
    await expect.poll(() => checks).toBeGreaterThan(parked);
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const last = write("moment.append", { objectId: "object-keys", path: ".env.local", versionId: "main" });
    // The page left for a secret path: the phone sees it go.
    expect(await feed(await held)).toEqual({ ok: true, cursor: `0.${last}.0`, changed: { files: ["object-keys"], pages: ["object-keys"] } });
  });

  it("brings a page's accepted live edit before it settles", async () => {
    const f = registered({ deployment: true });
    cleanup.push(async () => f.close());
    f.storage.claimWorkspaceIdentity({ workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream" });
    const engine = new TestEngine();
    engine.files.seedTextFile({ workspace: "workspace", path: "docs/a.md", text: "Hello\n", objectId: "object" });
    const run = await serverCopies(f.storage, engine);
    const h = testHandler(f.storage, { accountApi: true, resolveAccountSession, serverCopies: () => run.copies });
    const read = await json(await h(op("workspace", "documentRead", { path: "docs/a.md" }, signedIn("owner"))));
    const edit = (title: string) => expect(f.storage.commitLiveUpdateJournal(f.capture(f.update("title", title), `edit-${title}`)).result.kind).toBe("accepted");
    edit("Lisbon");
    const delivered = await feed(await h(changes(String(read.cursor), { workspaceId: "workspace", headers: signedIn("owner") })));
    expect(delivered.changed).toEqual({ pages: ["object"] });
    const held = h(changes(String(delivered.cursor), { workspaceId: "workspace", headers: signedIn("owner"), hold: 30_000 }));
    edit("Porto");
    expect((await feed(await held)).changed).toEqual({ pages: ["object"] });
    // The journal is read a part at a time, in cursor order.
    const rows = f.storage.accountFeedJournalRows({ workspaceId: "workspace", after: 0, through: Number.MAX_SAFE_INTEGER, limit: 1 });
    expect(rows).toEqual([{ journalCursor: expect.any(Number), objectId: "object", path: "docs/a.md" }]);
    expect(f.storage.accountFeedJournalRows({ workspaceId: "workspace", after: rows[0]!.journalCursor, through: Number.MAX_SAFE_INTEGER, limit: 5 }))
      .toHaveLength(1);
  });

  it("answers replace for a cursor from before a restore, or past what the workspace holds", async () => {
    const { storage, activity, h } = await relay();
    const relaySeq = logWriter(storage, activity)("chat.channel.create", { channelId: "c" });
    const current = `0.${relaySeq}.0`;
    for (const since of ["1.0.0", `0.${relaySeq + 1}.0`, `0.${relaySeq}.1`]) {
      expect(await feed(await h(changes(since))), since).toEqual({ ok: true, cursor: current, replace: true });
    }
    for (const since of ["", "x", "1.2", "01.0.0", "0.0.0.0", "0.-1.0", "0.99999999999999999.0"]) {
      const response = await h(changes(since));
      expect(response.status, since).toBe(400);
      expect(await json(response)).toMatchObject({ code: "bad_request" });
    }
    const response = await h(changes(current, { hold: 30_001 }));
    expect(response.status).toBe(400);

    // A restore set the log floor where the log stood.
    const context = storage as StorageContext;
    context.tx(() => context.db.prepare("UPDATE sync_relay_workspaces SET epoch_log_floor = ? WHERE workspace_id = 'trip'").run(relaySeq));
    const restored = `${relaySeq}.${relaySeq}.0`;
    for (const since of [current, `${relaySeq}.0.0`]) {
      expect(await feed(await h(changes(since))), since).toEqual({ ok: true, cursor: restored, replace: true });
    }
    expect(await feed(await h(changes(restored)))).toEqual({ ok: true, cursor: restored, changed: {} });
  });

  it("wakes an account's held feed when its credentials change", async () => {
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
    const activity = new DiscussionActivityHub();
    const waits = createAccountFeedWaits(storage, activity);
    const held = waits.wait({ workspaceId: "trip", userId: "ana", caller: "phone", holdMs: 30_000, signal: new AbortController().signal, shouldPark: () => true });
    expect(activity.stats().waiters).toBe(1);
    waits.wakeAccount("ben");
    expect(activity.stats().waiters).toBe(1);
    waits.wakeAccount("ana");
    await held;
    expect(activity.stats().waiters).toBe(0);
  });

  it("checks the owner before the cursor, and answers another account's, a hidden, and a missing workspace alike", async () => {
    const { storage, h, syncs } = await relay();
    const missing = await denialBytes(await h(changes("bad", { workspaceId: "nowhere" })));
    expect(await denialBytes(await h(changes("bad", { workspaceId: "budget" })))).toBe(missing);
    expect(await denialBytes(await h(changes("bad", { headers: {} })))).toBe(missing);
    expect(await denialBytes(await h(changes("bad", { headers: { ...signedIn("ana"), cookie: "session=ana" } })))).toBe(missing);
    storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
    expect(await denialBytes(await h(changes("bad")))).toBe(missing);
    expect(syncs).toEqual([]);
  });

  it("is not served while the account API is off", async () => {
    const { h } = await relay({ accountApi: false });
    await denialBytes(await h(changes("0.0.0")));
  });

  it("answers as missing, at the next check, when the sign-in, the owner, \"Show on phone\" or the fence changes during a wait", async () => {
    for (const change of ["sign-in", "show on phone", "owner", "fence"] as const) {
      let signedOut = false;
      const { storage, activity, h } = await relay({ resolve: async (request) => {
        const session = await resolveAccountSession(request);
        return signedOut ? { ...session, sessionId: "another" } : session;
      } });
      const write = logWriter(storage, activity);
      const held = h(changes("0.0.0", { hold: 30_000 }));
      await expect.poll(() => activity.stats().waiters).toBe(1);
      if (change === "sign-in") {
        signedOut = true;
      } else if (change === "show on phone") {
        storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
      } else if (change === "owner") {
        (storage as StorageContext).tx(() => (storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'").run());
      } else {
        createAccountDeletionRoute({ storage: storage as StorageContext, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {} })
          .fence("ana", "ana@example.test");
      }
      write("chat.channel.create", { channelId: "c" });
      const response = await held;
      expect(response.status, change).toBe(404);
      expect(await response.text()).not.toContain("changed");
    }
  });

  it("wakes a held feed when the server's copy publishes through its replication route", async () => {
    const { storage, activity, h } = await relay();
    const key = new Uint8Array(32).fill(7), namespace = "test";
    const row = storage.joinAutomationWorkspace({ workspaceId: "trip", nowMs: 0, reasons: ["account"] })!;
    const bearer = deriveAutomationReplicaBearer(row, { key, namespace });
    const replication = createServiceHostReplication({ storage, prefix: AUTOMATION_REPLICA_BEARER_PREFIX, activity,
      authorize: (input) => authorizeAutomationReplication(storage, { key, namespace, ...input }) });
    const held = h(changes("0.0.0", { hold: 30_000 }));
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const push = await replication(new Request("https://relay.test/sync/trip/log", {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ replicationEpoch: "epoch", streamIdentity: "stream", originId: "server-copy", ops: [{
        originSeq: 0, opKind: "moment.append", recordedAtMs: 10,
        payload: { operation: "write", objectId: "object-plan", momentId: "moment-plan", versionId: "main", path: "docs/plan.md", recordedAtMs: 10 },
      }] }),
    }));
    expect(push.status, await push.clone().text()).toBe(200);
    expect(await feed(await held)).toMatchObject({ ok: true, changed: { files: ["object-plan"], pages: ["object-plan"] } });
  });

  it("answers server_busy past one account's waits, across its sign-ins, while another account still waits", async () => {
    const { storage, activity, h } = await relay();
    const stop = new AbortController();
    const held = Array.from({ length: ACCOUNT_FEED_WAITS_PER_ACCOUNT }, (_, index) =>
      h(changes("0.0.0", { hold: 30_000, signal: stop.signal, headers: signedIn("ana", `phone-${index}`) })));
    await expect.poll(() => activity.stats().waiters).toBe(ACCOUNT_FEED_WAITS_PER_ACCOUNT);
    const busy = await h(changes("0.0.0", { hold: 30_000, headers: signedIn("ana", "another-phone") }));
    expect(busy.status).toBe(503);
    expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    const other = h(changes("0.0.0", { hold: 30_000, workspaceId: "budget", headers: signedIn("ben") }));
    await expect.poll(() => activity.stats().waiters).toBe(ACCOUNT_FEED_WAITS_PER_ACCOUNT + 1);
    const relaySeq = logWriter(storage, activity, "budget")("chat.channel.create", { channelId: "c" });
    expect(await feed(await other)).toEqual({ ok: true, cursor: `0.${relaySeq}.0`, changed: { chats: [] } });
    stop.abort();
    for (const response of await Promise.all(held)) expect(response.status).toBe(200);
  });

  it("answers server_busy past one sign-in's waits, and keeps no copy open while it waits", async () => {
    const activity = new DiscussionActivityHub({ maxWaitersPerActor: 1 });
    const { h, syncs } = await relay({ activity });
    const stop = new AbortController();
    const held = h(changes("0.0.0", { hold: 30_000, signal: stop.signal }));
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const busy = await h(changes("0.0.0", { hold: 30_000 }));
    expect(busy.status).toBe(503);
    expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    expect((await h(op("trip", "groups"))).status).toBe(200);
    stop.abort();
    expect(await feed(await held)).toEqual({ ok: true, cursor: "0.0.0", changed: {} });
    expect(syncs).toEqual(["trip"]);
  });
});
