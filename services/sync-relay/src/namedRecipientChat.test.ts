import { createShareSummaries } from "./shareSummaries";
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

async function fixture(activity = new DiscussionActivityHub(), maxResponseBytes = limits.maxResponseBytes, maxPendingRequests = limits.maxPendingRequests) {
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
  const lookupUserEmail = vi.fn((userId: string) => `${userId}@dohc.test`);
  const lookupUserDisplayName = vi.fn((userId: string): Promise<string | null> | string | null => userId === "alice" ? "Alice" : userId);
  const responseLimits = {...limits, maxResponseBytes, maxPendingRequests};
  const handler = testHandler(storage, {lookupUserDisplayName, lookupVerifiedUserEmail: lookupUserEmail, nowMs: () => ++clock, discussionActivity: activity, namedBrowserSessionLimits: responseLimits, relayExchangeKey: RELAY_EXCHANGE_KEY,
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
    shareId, channelWireId, id: "request-1", body: "hello from browser", authorKind: "human", ...changes,
  }));
  return {storage, handler, call, post, activity, lookupUserEmail, lookupUserDisplayName, responseLimits};
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

  it("refuses forged authors, foreign threads and channels, and every broader browser operation", async () => {
    const f = await fixture();
    for (const [input, status, code] of [
      [{authorUserId: "owner"}, 403, "authorship_mismatch"],
      [{threadId: "thread-private"}, 403, "share_op_rejected"],
      [{channelWireId: "wire-private"}, 404, "not_found"],
      [{ops: []}, 403, "share_op_rejected"], [{reaction: "yes"}, 403, "share_op_rejected"],
      [{attachment: "object"}, 403, "share_op_rejected"], [{authorKind: "link"}, 400, "bad_request"],
      [{linkGrantId: "grant-0"}, 403, "share_op_rejected"], [{linkPrincipalId: "principal"}, 403, "share_op_rejected"],
      [{authorKind: "human", authorDisplayName: "Owner"}, 403, "share_op_rejected"],
      [{authorKind: "human", authorOwnerDisplayName: "Owner"}, 403, "share_op_rejected"],
      [{authorKind: "agent", authorDisplayName: "Agent", authorOwnerDisplayName: "Owner"}, 403, "share_op_rejected"],
      [{authorKind: "automation", authorDisplayName: "Automation"}, 400, "bad_request"],
    ] as const) {
      const response = await f.post(input);
      expect(response.status).toBe(status);
      expect(await json(response)).toMatchObject({code});
      expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
    }
    expect((await f.call(history.replace(channelWireId, "wire-private"))).status).toBe(404);
    expect((await f.post({threadId: "thread-team", authorKind: "agent", authorDisplayName: "Agent"})).status).toBe(200);
    const before = await json(await f.call(history));
    expect(JSON.stringify(before)).not.toContain("SENTINEL");
  });

  it("returns the original result on retries, conflicts on changed content, and appends one thread/message batch", async () => {
    const f = await fixture();
    const first = await json(await f.post());
    expect(await json(await f.post())).toEqual(first);
    expect((await f.post({body: "changed"})).status).toBe(409);
    expect((await f.post({threadId: (first.message as Record<string, unknown>).threadId})).status).toBe(409);
    const log = await json(await f.handler(request("owner", "/sync/workspace/log?since=0&limit=100")));
    const ops = log.ops as Array<{opKind: string; payload: {messageId?: string; threadId?: string}}>;
    expect(ops.filter(op => op.opKind === "chat.message.append" && op.payload.messageId === (first.message as Record<string, unknown>).messageId)).toHaveLength(1);
    expect(ops.filter(op => op.opKind === "chat.thread.create" && op.payload.threadId === (first.message as Record<string, unknown>).threadId)).toHaveLength(1);
    const replies = await Promise.all([f.post({id: "concurrent", threadId: "thread-team"}), f.post({id: "concurrent", threadId: "thread-team"})]);
    expect(await json(replies[0]!)).toEqual(await json(replies[1]!));
  });

  it("revocation stops reads and posts, including a post racing the transaction guard", async () => {
    const f = await fixture();
    const append = f.storage.appendBrowserChatBatch.bind(f.storage);
    vi.spyOn(f.storage, "appendBrowserChatBatch").mockImplementation(input => {
      f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5});
      return append(input);
    });
    expect((await f.post()).status).toBe(404);
    expect((await f.call(history)).status).toBe(404);
    expect((await f.post()).status).toBe(404);
    expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
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

  it.each([true])("wakes on a new message through the %s browser adapter", async browser => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    expect((await f.post({threadId: "thread-team"})).status).toBe(200);
    const response = await poll.response;
    expect(response.status).toBe(200);
    expect(JSON.stringify(await json(response))).toContain("hello from browser");
    expect(f.activity.stats().waiters).toBe(0);
  });

  it.each([true])("releases the waiter on cancellation through browser=%s", async browser => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    controller.abort();
    await poll.response;
    expect(f.activity.stats().waiters).toBe(0);
  });

  it.each([true])("refuses a parked read after revocation, browser=%s", async browser => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5});
    f.activity.wakeLog(workspaceId);
    expect((await poll.response).status).toBe(404);
    expect(f.activity.stats().waiters).toBe(0);
  });
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

it("returns a minimal omission marker for metadata that cannot fit alone and advances past it", async () => {
  const f = await fixture(new DiscussionActivityHub(), 4152);
  f.storage.appendLogBatch({workspaceId, originId: "huge-metadata", ops: sequenced([
    chatMessageAppend("x".repeat(60_000), "thread-team", "body", {authorDisplayName: "x".repeat(60_000)}),
    chatMessageAppend("after", "thread-team", "readable"),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  expect(await json(await f.call(history + "&since=7&limit=1"))).toMatchObject({
    messages: [{messageId: "omitted:8", body: null, bodyTooLarge: true}], nextCursor: 8, hasMore: true,
  });
  expect(await json(await f.call(history + "&before=9&limit=1"))).toMatchObject({
    messages: [{messageId: "omitted:8", body: null, bodyTooLarge: true}], olderCursor: 8,
  });
  expect(await json(await f.call(history + "&since=8&limit=1"))).toMatchObject({messages: [{messageId: "after", body: "readable"}], nextCursor: 9});
});

it("authenticates before existence lookups and refuses a trusted key with missing or foreign Origin", async () => {
  const f = await fixture();
  for (const path of ["channels?grantId=write", "channels?grantId=missing", history, history.replace(shareId, "missing")]) {
    const response = await f.call(path, "");
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({code: "unauthorized"});
  }
  for (const origin of [null, "https://attacker.test"]) {
    const headers = new Headers({cookie: "session=alice", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY});
    if (origin !== null) headers.set("origin", origin);
    expect((await f.handler(new Request("http://relay.test/sync/named-chat/channels?grantId=write", {headers}))).status).toBe(404);
  }
});

it("keeps another account's lists, history and posts available when one account fills its follow cap", async () => {
  const f = await fixture(new DiscussionActivityHub(), limits.maxResponseBytes, 2);
  addGrant(f.storage, grant("bob", "bob", "read-write"));
  const controllers = [new AbortController(), new AbortController()];
  const polls: Promise<Response>[] = [];
  try {
    for (const controller of controllers) {
      const entered = deferred(), wait = f.activity.wait.bind(f.activity);
      const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
        const result = wait(group, actor, options); entered.resolve(); return result;
      });
      polls.push(f.call(history + "&since=7&hold=30000", "alice", {signal: controller.signal}));
      await entered.promise; spy.mockRestore();
    }
    expect(f.activity.stats().waiters).toBe(2);
    const overflow = await f.call(history + "&since=7&hold=30000");
    expect(overflow.status).toBe(429);
    expect(await json(overflow)).toMatchObject({code: "share_access_rate_limited"});
    expect((await f.call("channels?grantId=bob", "bob")).status).toBe(200);
    expect((await f.call(history, "bob")).status).toBe(200);
    expect((await f.post({threadId: "thread-team"}, "bob")).status).toBe(200);
    expect((await Promise.all(polls)).every(response => response.status === 200)).toBe(true);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.all(polls);
  }
  expect(f.activity.stats().waiters).toBe(0);
});

it("refuses writes to a read-only Group and removes invitations if its channel stops being ordinary", async () => {
  const f = await fixture(), selector = {kind: "group" as const, channelWireId, paths: ["team"], versionId: null};
  const db = inspectDatabase(storagePath(f.storage));
  db.prepare("UPDATE sync_relay_shares SET selector_json = ? WHERE share_id = ?").run(JSON.stringify(selector), shareId);
  const response = await f.post({}, "reader");
  expect(response.status).toBe(403);
  expect(await json(response)).toMatchObject({code: "share_read_only"});
  expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
  const summaries = createShareSummaries(f.storage, () => ({subjectName: "Team"}), undefined, SHARE_WEB_ORIGIN);
  expect(summaries.namedBrowserInvitation(workspaceId, "write", selector, "read-write")).toHaveProperty("browserInvitationUrl");
  db.prepare("UPDATE sync_relay_log SET payload_json = json_set(payload_json, '$.kind', 'dm') WHERE workspace_id = ? AND op_kind = 'chat.channel.create' AND json_extract(payload_json, '$.wireId') = ?")
    .run(workspaceId, channelWireId);
  db.close();
  expect(summaries.namedBrowserInvitation(workspaceId, "write", selector, "read-write")).toEqual({});
  expect((await f.call("channels?grantId=write")).status).toBe(404);
  expect((await f.call(history)).status).toBe(404);
});

it.each(["older"] as const)("retains earliest thread bindings after a later re-create, direction=%s", async direction => {
  const f = await fixture();
  f.storage.appendLogBatch({workspaceId, originId: "recreated", ops: sequenced([
    chatThreadCreate("thread-private", channelWireId), chatThreadCreate("thread-team", "wire-private"),
    chatMessageAppend("still-private", "thread-private", "SENTINEL"),
    chatMessageAppend("still-shared", "thread-team", "visible"),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  const page = f.storage.fetchChatMessages({workspaceId, channelWireId, cursor: direction === "older" ? 12 : 7, direction, limit: 100});
  expect(page.rows.map(row => JSON.parse(row.payloadJson).messageId as string)).toEqual(
    direction === "older" ? ["still-shared", "owner-second", "owner-first"] : ["still-shared"]);
});

it("answers a relay deadline with 503 and never appends after a stalled name lookup resumes", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.lookupUserDisplayName.mockImplementation(async () => {entered.resolve(); await release.promise; return "Alice";});
  vi.useFakeTimers();
  const pending = f.post();
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(limits.timeoutMs);
    expect((await pending).status).toBe(503);
  } finally {release.resolve(); await pending; await vi.advanceTimersByTimeAsync(0);}
  expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
});
