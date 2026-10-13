import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import { RELAY_EXCHANGE_KEY, SHARE_WEB_ORIGIN, chatChannelCreate, chatMessageAppend, chatThreadCreate,
  closeTestStorages, json, jsonBody, request, resolveTestActor, sequenced, testHandler, testStorage } from "./testing";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { inspectDatabase, storagePath } from "./testing";
import type { SyncRelayStorage, SyncRelayShareGrantRow } from "./storage";

const limits = {maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 8, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 1000};
const workspaceId = "workspace", channelWireId = "wire-team", shareId = "share-chat";
function deferred() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}

async function fixture(activity = new DiscussionActivityHub(), maxResponseBytes = limits.maxResponseBytes) {
  const storage = await testStorage();
  storage.claimWorkspace({workspaceId, ownerUserId: "owner", createdAtMs: 1});
  storage.appendLogBatch({workspaceId, originId: "owner", ops: sequenced([
    chatChannelCreate(channelWireId, {name: "Team", type: "both", folderPath: "team"}),
    chatThreadCreate("thread-team", channelWireId),
    chatMessageAppend("owner-first", "thread-team", "welcome", {authorUserId: "owner"}),
    chatChannelCreate("wire-private", {name: "Private"}),
    chatThreadCreate("thread-private", "wire-private"),
    chatMessageAppend("private", "thread-private", "SENTINEL", {authorUserId: "owner"}),
    chatMessageAppend("owner-second", "thread-team", "second", {authorUserId: "owner"}),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  storage.createShare({share: {shareId, workspaceId, granterUserId: "owner", createdAtMs: 1,
    selectorJson: JSON.stringify({kind: "chat", channelWireId}), labels: {subjectName: "Team"}},
    grant: grant("write", "alice", "read-write")});
  addGrant(storage, grant("read", "reader", "read-only"));
  let clock = 2000;
  const handler = testHandler(storage, {nowMs: () => ++clock, discussionActivity: activity, namedBrowserSessionLimits: {...limits, maxResponseBytes}, relayExchangeKey: RELAY_EXCHANGE_KEY,
    resolveActor: (incoming, workspaceId) => {
      if (incoming.headers.has("cookie")) {
        expect([...incoming.headers.keys()]).toEqual(["cookie"]);
        const match = /^session=(\w+)$/u.exec(incoming.headers.get("cookie") ?? "");
        if (!match) throw new UnauthorizedError();
        return {userId: match[1]!, workspaceId};
      }
      return resolveTestActor(incoming, workspaceId);
    }});
  const call = (path: string, user = "alice", init: RequestInit = {}) => handler(new Request(`http://relay.test/sync/named-chat/${path}`, {
    ...init, headers: {...Object.fromEntries(new Headers(init.headers)), cookie: `session=${user}`,
      origin: SHARE_WEB_ORIGIN, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY},
  }));
  const post = (changes: Record<string, unknown> = {}, user = "alice") => call("messages", user, jsonBody({
    shareId, channelWireId, id: "request-1", body: "hello from browser", authorKind: "human", authorDisplayName: "Alice", ...changes,
  }));
  return {storage, handler, call, post, activity};
}
function addGrant(storage: SyncRelayStorage, value: SyncRelayShareGrantRow) {
  const db = inspectDatabase(storagePath(storage));
  db.prepare(`INSERT INTO sync_relay_share_grants
    (grant_id, share_id, principal_kind, principal_user_id, principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.grantId, value.shareId, value.principalKind, value.principalUserId,
      value.principalEmail, value.access, value.generation, value.status, value.createdAtMs, value.revokedAtMs, value.parentGrantId);
  db.close();
}
function grant(grantId: string, userId: string, access: "read-only" | "read-write") {
  return {grantId, shareId, principalKind: "user" as const, principalUserId: userId, principalEmail: null, access, generation: 1,
    status: "active" as const, createdAtMs: 1, revokedAtMs: null, parentGrantId: null};
}
const history = `messages?shareId=${shareId}&channelWireId=${channelWireId}`;
afterEach(() => {vi.useRealTimers(); closeTestStorages();});

describe("named browser chat authorization and replication", () => {
  it("serves newest and older JSON pages, and accepts a message read identically by both desktop paths", async () => {
    const f = await fixture();
    expect(await json(await f.call("channels?grantId=write"))).toMatchObject({shareId, userId: "alice",
      channels: [{channelWireId, name: "Team", access: "read-write"}]});
    const page = await json(await f.call(history + "&limit=1"));
    expect(page.messages).toEqual([expect.objectContaining({messageId: "owner-second", body: "second"})]);
    const older = await json(await f.call(history + `&limit=1&before=${page.olderCursor}`));
    expect(older.messages).toEqual([expect.objectContaining({messageId: "owner-first", body: "welcome"})]);
    expect(JSON.stringify(page)).not.toContain("SENTINEL");
    const posted = await f.post();
    expect(posted.status).toBe(200);
    const body = await json(posted);
    const message = body.message as Record<string, unknown>;
    expect(message).toMatchObject({body: "hello from browser", authorKind: "human", authorDisplayName: "Alice", authorUserId: "alice"});
    for (const path of [`/sync/shares/${shareId}/log?since=0&limit=100&channelWireId=${channelWireId}`, `/sync/${workspaceId}/log?since=0&limit=100`]) {
      const log = await json(await f.handler(request(path.includes("/shares/") ? "alice" : "owner", path)));
      expect(log.ops).toContainEqual(expect.objectContaining({opKind: "chat.message.append", payload: expect.objectContaining({
        messageId: message.messageId, threadId: message.threadId, body: message.body, authorUserId: "alice", authorDisplayName: "Alice",
      })}));
    }
    const followed = await json(await f.call(history + `&since=${page.nextCursor}`));
    expect(followed.messages).toContainEqual(message);
  });

  it("lets read-only recipients read and refuses writes at both relay entry points", async () => {
    const f = await fixture();
    expect((await f.call(history, "reader")).status).toBe(200);
    expect(await json(await f.call("channels?grantId=read", "reader"))).toMatchObject({channels: [{access: "read-only"}]});
    expect((await f.post({}, "reader")).status).toBe(403);
    expect((await f.handler(request("reader", `/sync/shares/${shareId}/log`, jsonBody({originId: "reader", ops: []})))).status).toBe(403);
    for (const path of [history, "channels?grantId=write"]) expect((await f.call(path, "stranger")).status).toBe(404);
    expect((await f.post({}, "stranger")).status).toBe(404);
  });

  it("uses the same highest permitted grant as the recipient desktop", async () => {
    const f = await fixture();
    addGrant(f.storage, grant("reader-write", "reader", "read-write"));
    expect(await json(await f.call("channels?grantId=read", "reader"))).toMatchObject({channels: [{access: "read-write"}]});
    expect((await f.post({}, "reader")).status).toBe(200);
    expect((await f.handler(request("reader", `/sync/shares/${shareId}/log`, jsonBody({originId: "reader", ops: []})))).status).toBe(200);
  });

  it("refuses forged authors, foreign threads and channels, and every broader browser operation", async () => {
    const f = await fixture();
    for (const input of [
      {authorUserId: "owner"}, {threadId: "thread-private"}, {channelWireId: "wire-private"},
      {ops: []}, {reaction: "yes"}, {attachment: "object"}, {authorKind: "link"},
      {authorKind: "human", authorOwnerDisplayName: "Owner"},
    ]) expect((await f.post(input)).status).toBeGreaterThanOrEqual(400);
    expect((await f.call(history.replace(channelWireId, "wire-private"))).status).toBe(404);
    expect((await f.post({threadId: "thread-team", authorKind: "agent", authorDisplayName: "Agent", authorOwnerDisplayName: "Alice"})).status).toBe(200);
    const before = await json(await f.call(history));
    expect(JSON.stringify(before)).not.toContain("SENTINEL");
  });

  it("returns the original result on retries, conflicts on changed content, and appends one thread/message batch", async () => {
    const f = await fixture();
    const first = await json(await f.post());
    expect(await json(await f.post())).toEqual(first);
    expect((await f.post({body: "changed"})).status).toBe(409);
    const log = await json(await f.handler(request("owner", "/sync/workspace/log?since=0&limit=100")));
    const ops = log.ops as Array<{opKind: string; payload: {messageId?: string; threadId?: string}}>;
    expect(ops.filter(op => op.opKind === "chat.message.append" && op.payload.messageId === (first.message as Record<string, unknown>).messageId)).toHaveLength(1);
    expect(ops.filter(op => op.opKind === "chat.thread.create" && op.payload.threadId === (first.message as Record<string, unknown>).threadId)).toHaveLength(1);
    const replies = await Promise.all([f.post({id: "concurrent", threadId: "thread-team"}), f.post({id: "concurrent", threadId: "thread-team"})]);
    expect(await json(replies[0]!)).toEqual(await json(replies[1]!));
  });

  it("revocation stops reads and posts, including a post racing the transaction guard", async () => {
    const f = await fixture();
    const append = f.storage.appendLogBatch.bind(f.storage);
    vi.spyOn(f.storage, "appendLogBatch").mockImplementation(input => {
      f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5});
      return append(input);
    });
    expect((await f.post()).status).toBe(404);
    expect((await f.call(history)).status).toBe(404);
    expect((await f.post()).status).toBe(404);
    expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
  });

  it("rechecks access after assembling history and refuses an untrusted exchange", async () => {
    const f = await fixture(), read = f.storage.fetchLogPageDescending.bind(f.storage);
    vi.spyOn(f.storage, "fetchLogPageDescending").mockImplementation(input => {
      const page = read(input); f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5}); return page;
    });
    expect((await f.call(history)).status).toBe(404);
    expect((await f.handler(new Request("http://relay.test/sync/named-chat/channels?grantId=read",
      {headers: {cookie: "session=reader", origin: SHARE_WEB_ORIGIN}}))).status).toBe(404);
  });
});

describe("named log long polling", () => {
  async function parked(f: Awaited<ReturnType<typeof fixture>>, controller: AbortController, browser = false, hold = 30_000) {
    const entered = deferred(), wait = f.activity.wait.bind(f.activity);
    vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
      const pending = wait(group, actor, options); entered.resolve(); return pending;
    });
    const response = browser ? f.call(history + `&since=7&hold=${hold}`, "alice", {signal: controller.signal})
      : f.handler(request("alice", `/sync/shares/${shareId}/log?channelWireId=${channelWireId}&since=7&hold=${hold}`, {signal: controller.signal}));
    await entered.promise;
    expect(f.activity.stats().waiters).toBe(1);
    return {response};
  }

  it.each([false, true])("wakes on a new message through the %s browser adapter", async browser => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    expect((await f.post({threadId: "thread-team"})).status).toBe(200);
    const response = await poll.response;
    expect(response.status).toBe(200);
    expect(JSON.stringify(await json(response))).toContain("hello from browser");
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("times out cleanly and rejects invalid hold bounds", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const poll = await parked(f, new AbortController(), false, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await json(await poll.response)).toMatchObject({ops: [], nextCursor: 7, hasMore: false});
    expect(f.activity.stats().waiters).toBe(0);
    for (const hold of ["-1", "1.5", "30001"]) expect((await f.call(history + `&since=7&hold=${hold}`)).status).toBe(400);
  });

  it.each([false, true])("releases the waiter on cancellation through browser=%s", async browser => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    controller.abort();
    await poll.response;
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("refuses capacity overflow without displacing a parked reader", async () => {
    const f = await fixture(new DiscussionActivityHub({maxTotalWaiters: 1})), controller = new AbortController();
    const poll = await parked(f, controller);
    const overflow = await f.handler(request("reader", `/sync/shares/${shareId}/log?channelWireId=${channelWireId}&since=7&hold=30000`));
    expect(overflow.status).toBe(429);
    expect(f.activity.stats().waiters).toBe(1);
    controller.abort(); await poll.response;
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("refuses a parked read after revocation", async () => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller);
    f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5});
    f.activity.wakeLog(workspaceId);
    expect((await poll.response).status).toBe(404);
    expect(f.activity.stats().waiters).toBe(0);
  });
});

it("normalizes desktop message text and bounds malformed or oversized browser inputs at the relay", async () => {
  const f = await fixture();
  const result = await json(await f.post({body: "hello\r\nworld \r", authorDisplayName: " Alice "}));
  expect(result).toMatchObject({message: {body: "hello\nworld", authorDisplayName: "Alice"}});
  for (const input of [{body: ""}, {body: " "}, {body: "x".repeat(65537)}, {body: String.fromCharCode(0xd800)},
    {authorDisplayName: "x".repeat(201)}, {authorDisplayName: ""}, {id: String.fromCharCode(0xd800)}]) {
    expect((await f.post({...input, id: "invalid", ...input})).status).toBe(400);
  }
  expect((await f.call("messages", "alice", {method: "POST", headers: {"content-type": "application/json"}, body: "{"})).status).toBe(400);
  expect((await f.call("messages", "alice", {method: "POST", headers: {"content-type": "application/json"}, body: "x".repeat(limits.maxRequestBytes + 1)})).status).toBe(413);
});

it("claims a pending channel invitation only for the verified invited account", async () => {
  const f = await fixture();
  f.storage.createShare({share: {shareId: "share-pending", workspaceId, granterUserId: "owner", createdAtMs: 1,
    selectorJson: JSON.stringify({kind: "chat", channelWireId})}, grant: {...grant("pending", "invited", "read-only"),
      shareId: "share-pending", principalKind: "email", principalUserId: null, principalEmail: "invited@dohc.test"}});
  expect((await f.call("channels?grantId=pending", "stranger")).status).toBe(404);
  const response = await f.call("channels?grantId=pending", "invited");
  expect(response.status).toBe(200);
  expect(await json(response)).toMatchObject({shareId: "share-pending", userId: "invited", channels: [{access: "read-only"}]});
  expect(f.storage.getShareGrant("pending")).toMatchObject({principalKind: "user", principalUserId: "invited"});
});

it("observes a message appended between the initial read and waiter registration", async () => {
  const f = await fixture(), wait = f.activity.wait.bind(f.activity);
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    f.storage.appendLogBatch({workspaceId, originId: "race", ops: sequenced([
      chatMessageAppend("racing-message", "thread-team", "arrived before parking", {authorUserId: "owner"}),
    ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
    f.activity.wakeLog(workspaceId);
    return wait(group, actor, options);
  });
  const response = await f.handler(request("alice", `/sync/shares/${shareId}/log?channelWireId=${channelWireId}&since=7&hold=30000`));
  expect(response.status).toBe(200);
  expect(await json(response)).toMatchObject({ops: [expect.objectContaining({payload: {messageId: "racing-message", threadId: "thread-team",
    authorKind: "human", authorDisplayName: "Someone", authorUserId: "owner", body: "arrived before parking", createdAtMs: 3}})]});
  expect(f.activity.stats().waiters).toBe(0);
});

it("parks again after activity in a different channel", async () => {
  const f = await fixture(), first = deferred(), second = deferred(), wait = f.activity.wait.bind(f.activity);
  let count = 0, answered = false;
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    const pending = wait(group, actor, options);
    (++count === 1 ? first : second).resolve();
    return pending;
  });
  const controller = new AbortController();
  const poll = f.call(history + "&since=7&hold=30000", "alice", {signal: controller.signal}).finally(() => {answered = true;});
  try {
    await first.promise;
    f.storage.appendLogBatch({workspaceId, originId: "private-change", ops: sequenced([
      chatMessageAppend("private-change", "thread-private", "SENTINEL new activity", {authorUserId: "owner"}),
    ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
    f.activity.wakeLog(workspaceId);
    await second.promise;
    expect(answered).toBe(false);
    expect(f.activity.stats().waiters).toBe(1);
    expect((await f.post({threadId: "thread-team"})).status).toBe(200);
    const response = await poll;
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.messages).toEqual([expect.objectContaining({body: "hello from browser"})]);
    expect(JSON.stringify(body)).not.toContain("SENTINEL");
  } finally {controller.abort(); await poll;}
});

it("bounds history scans and keeps an older cursor across an empty page", async () => {
  const f = await fixture();
  f.storage.appendLogBatch({workspaceId, originId: "unrelated", ops: Array.from({length: 2100}, (_value, originSeq) =>
    ({originSeq, opKind: "workspace.init", payloadJson: "{}", recordedAtMs: originSeq}))});
  const recent = await json(await f.call(history));
  expect(recent.messages).toEqual([]);
  expect(recent.olderCursor).toEqual(expect.any(Number));
  const older = await json(await f.call(history + `&before=${recent.olderCursor}`));
  expect(older.messages).toEqual([
    expect.objectContaining({messageId: "owner-second"}), expect.objectContaining({messageId: "owner-first"}),
  ]);
  expect(older.olderCursor).toBeNull();
});

it("refuses a post before appending when its acknowledgment cannot fit the response budget", async () => {
  const f = await fixture(new DiscussionActivityHub(), 4152);
  expect((await f.post({body: "x".repeat(4100)})).status).toBe(413);
  expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
});

it("accepts the invitation identifier bounds used by named document navigation", async () => {
  const f = await fixture(), grantId = '"'.repeat(512);
  f.storage.createShare({share: {shareId: "share-long-invite", workspaceId, granterUserId: "owner", createdAtMs: 1,
    selectorJson: JSON.stringify({kind: "chat", channelWireId})}, grant: {...grant(grantId, "alice", "read-only"), shareId: "share-long-invite"}});
  expect((await f.call("channels?" + new URLSearchParams({grantId}))).status).toBe(200);
  expect((await f.call("channels?grantId=%00")).status).toBe(400);
});
