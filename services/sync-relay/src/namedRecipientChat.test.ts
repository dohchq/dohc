import { createShareSummaries } from "./shareSummaries";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeShareAction } from "./shareAuthorization";
import { createNamedRecipientChat, MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE } from "./namedRecipientChat";
import type { StorageContext } from "./storage/context";
import { CHAT_HISTORY_SCAN_WINDOW } from "./storage/log";
import { linkLogWaitGroup, DiscussionActivityHub } from "./discussionActivity";
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

  it("serves link posts as link posts to the browser and with their link to the recipient's desktop", async () => {
    const f = await fixture();
    const payload = {messageId: "link-message:1", threadId: "thread-team", body: "from a link", authorKind: "link",
      authorDisplayName: "Owner", linkGrantId: "grant-link", linkPrincipalId: "principal", createdAtMs: 5};
    f.storage.appendLogBatch({workspaceId, originId: "relay:share-link:principal",
      ops: [{originSeq: 0, opKind: "chat.message.append", payloadJson: JSON.stringify(payload), recordedAtMs: 5}]});
    const page = await json(await f.call(history));
    // A link holder who chose the owner's name still reads as a link holder, with no account.
    expect(page.messages).toEqual([
      expect.objectContaining({messageId: "link-message:1", authorKind: "link", authorDisplayName: "Owner", authorUserId: null,
        authorOwnerDisplayName: null, body: "from a link"}),
      expect.objectContaining({messageId: "owner-second"}), expect.objectContaining({messageId: "owner-first"}),
    ]);
    const [served] = page.messages as Array<Record<string, unknown>>;
    expect(served).not.toHaveProperty("linkGrantId");
    expect(served).not.toHaveProperty("linkPrincipalId");
    const log = await json(await f.handler(request("alice", `/sync/shares/${shareId}/log?since=0&limit=100&channelWireId=${channelWireId}`)));
    expect((log.ops as Array<{payload: Record<string, unknown>}>).filter(op => op.payload.messageId === payload.messageId)
      .map(op => op.payload)).toEqual([payload]);
  });

  it("drops a link-shaped row the relay did not write under its link holder's origin", async () => {
    const f = await fixture();
    const link = {authorKind: "link", authorDisplayName: "Owner", linkGrantId: "grant-link", linkPrincipalId: "principal"};
    const rows: Array<[string, number, string, Record<string, unknown>]> = [
      ["relay:share-link:principal", 0, "link-message:real", link],
      ["owner", 7, "link-message:ordinary-origin", link],
      ["relay:share-link:someone-else", 0, "link-message:other-origin", link],
      ["relay:share-link:principal", 1, "link-message:with-account", {...link, authorOwnerDisplayName: "Owner"}],
    ];
    for (const [originId, originSeq, messageId, fields] of rows) {
      f.storage.appendLogBatch({workspaceId, originId, ops: [{originSeq, opKind: "chat.message.append", recordedAtMs: 5,
        payloadJson: JSON.stringify({messageId, threadId: "thread-team", body: "from a link", createdAtMs: 5, ...fields})}]});
    }
    const page = await json(await f.call(history));
    expect((page.messages as Array<{messageId: string}>).map(message => message.messageId)).toEqual(["link-message:real", "owner-second", "owner-first"]);
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

  it("rechecks access after assembling history and refuses an untrusted exchange", async () => {
    const f = await fixture(), read = f.storage.fetchChatMessages.bind(f.storage);
    vi.spyOn(f.storage, "fetchChatMessages").mockImplementation(input => {
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

  it.each([false, true])("times out cleanly and rejects invalid hold bounds, browser=%s", async browser => {
    const f = await fixture();
    vi.useFakeTimers();
    const poll = await parked(f, new AbortController(), browser, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await json(await poll.response)).toMatchObject(browser ? {messages: [], nextCursor: 7, hasMore: false} : {ops: [], nextCursor: 7, hasMore: false});
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

  it.each([false, true])("refuses hub capacity overflow without displacing a parked reader, browser=%s", async browser => {
    const f = await fixture(new DiscussionActivityHub({maxTotalWaiters: 1})), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    const overflow = browser ? await f.call(history + "&since=7&hold=30000", "reader") : await f.handler(request("reader", `/sync/shares/${shareId}/log?channelWireId=${channelWireId}&since=7&hold=30000`));
    expect(overflow.status).toBe(429);
    expect(f.activity.stats().waiters).toBe(1);
    controller.abort(); await poll.response;
    expect(f.activity.stats().waiters).toBe(0);
  });

  it.each([false, true])("refuses a parked read after revocation, browser=%s", async browser => {
    const f = await fixture(), controller = new AbortController();
    const poll = await parked(f, controller, browser);
    f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5});
    f.activity.wakeLog(workspaceId);
    expect((await poll.response).status).toBe(404);
    expect(f.activity.stats().waiters).toBe(0);
  });
});

it("normalizes desktop message text and bounds malformed or oversized browser inputs at the relay", async () => {
  const f = await fixture();
  const result = await json(await f.post({body: "hello\r\nworld \r"}));
  expect(result).toMatchObject({message: {body: "hello\nworld", authorDisplayName: "Alice"}});
  for (const input of [{body: ""}, {body: " "}, {body: "x".repeat(65537)}, {body: String.fromCharCode(0xd800)},
    {authorKind: "agent", authorDisplayName: "x".repeat(201)}, {authorKind: "agent", authorDisplayName: ""}, {id: String.fromCharCode(0xd800)}]) {
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

it.each([false, true])("observes a message appended between the initial read and waiter registration, browser=%s", async browser => {
  const f = await fixture(), wait = f.activity.wait.bind(f.activity);
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    f.storage.appendLogBatch({workspaceId, originId: "race", ops: sequenced([
      chatMessageAppend("racing-message", "thread-team", "arrived before parking", {authorUserId: "owner"}),
    ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
    f.activity.wakeLog(workspaceId);
    return wait(group, actor, options);
  });
  const response = browser ? await f.call(history + "&since=7&hold=30000") : await f.handler(request("alice", `/sync/shares/${shareId}/log?channelWireId=${channelWireId}&since=7&hold=30000`));
  expect(response.status).toBe(200);
  const result = await json(response);
  if (browser) expect(result).toMatchObject({messages: [{messageId: "racing-message", body: "arrived before parking"}], nextCursor: 8});
  else expect(result).toMatchObject({ops: [expect.objectContaining({payload: {messageId: "racing-message", threadId: "thread-team",
    authorKind: "human", authorDisplayName: "Someone", authorUserId: "owner", body: "arrived before parking", createdAtMs: 3}})]});
  expect(f.activity.stats().waiters).toBe(0);
});

it("advances past another channel on each wake without rescanning it", async () => {
  const f = await fixture(), read = vi.spyOn(f.storage, "fetchChatMessages");
  let since = 7;
  for (let index = 0; index < 3; index++) {
    const controller = new AbortController(), entered = deferred(), wait = f.activity.wait.bind(f.activity);
    const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
      const pending = wait(group, actor, options); entered.resolve(); return pending;
    });
    const poll = f.call(history + `&since=${since}&hold=30000`, "alice", {signal: controller.signal});
    try {
      await entered.promise;
      f.storage.appendLogBatch({workspaceId, originId: `private-change-${index}`, ops: sequenced([
        chatMessageAppend(`private-${index}`, "thread-private", "SENTINEL", {authorUserId: "owner"}),
      ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
      f.activity.wakeLog(workspaceId);
      const page = await json(await poll);
      expect(page).toMatchObject({messages: [], nextCursor: since + 1, hasMore: false});
      expect(read.mock.calls.slice(-3).map(([input]) => input.cursor)).toEqual([since, since, since]);
      since = Number(page.nextCursor);
      expect(f.activity.stats().waiters).toBe(0);
    } finally {controller.abort(); await poll; spy.mockRestore();}
  }
});

it("bounds quiet-channel history and follows in a workspace with 20k messages and 2k threads", async () => {
  const f = await fixture();
  const ops = [
    ...Array.from({length: 2000}, (_, index) => chatThreadCreate(`busy-thread-${index}`, "wire-private")),
    ...Array.from({length: 20_000}, (_, index) => chatMessageAppend(`busy-${index}`, `busy-thread-${index % 2000}`, "busy")),
  ];
  f.storage.appendLogBatch({workspaceId, originId: "busy", ops: sequenced(ops).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  const read = vi.spyOn(f.storage, "fetchChatMessages"), wait = vi.spyOn(f.activity, "wait");
  const recent = await json(await f.call(history));
  expect(recent).toMatchObject({messages: [], nextCursor: 22007, olderCursor: 22007 - CHAT_HISTORY_SCAN_WINDOW + 1});
  expect(read).toHaveBeenCalledTimes(1);
  let since = 7;
  while (since < 22007) {
    const page = await json(await f.call(history + `&since=${since}&hold=30000`));
    expect(page.messages).toEqual([]);
    expect(page.nextCursor).toBe(Math.min(22007, since + CHAT_HISTORY_SCAN_WINDOW));
    since = Number(page.nextCursor);
  }
  expect(wait).not.toHaveBeenCalled();
  const earlier = await json(await f.call(history + `&before=${recent.olderCursor}`));
  expect(earlier.olderCursor).toBe(Number(recent.olderCursor) - CHAT_HISTORY_SCAN_WINDOW);
  const db = inspectDatabase(storagePath(f.storage));
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT payload_json FROM sync_relay_log
    WHERE workspace_id = ? AND op_kind = 'chat.thread.create' AND json_valid(payload_json)
      AND json_extract(payload_json, '$.threadId') = ? ORDER BY relay_seq`).all(workspaceId, "thread-team");
  expect(JSON.stringify(plan)).toContain("idx_sync_relay_log_thread_id");
  db.close();
});

it("pages metadata that exceeds the response budget and preserves both continuation directions", async () => {
  const f = await fixture(new DiscussionActivityHub(), 4152);
  f.storage.appendLogBatch({workspaceId, originId: "long-names", ops: sequenced(Array.from({length: 50}, (_, index) =>
    chatMessageAppend(`named-${index}`, "thread-team", "", {authorKind: "agent", authorDisplayName: "名".repeat(200), authorOwnerDisplayName: "名".repeat(200)})))
    .map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  let since = 7, total = 0;
  while (since < 57) {
    const response = await f.call(history + `&since=${since}&limit=50`), page = await json(response);
    expect(response.status).toBe(200);
    const messages = page.messages as Array<{relaySeq: number}>;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(50);
    expect(page.nextCursor).toBe(messages[messages.length - 1]!.relaySeq);
    expect(page.hasMore).toBe(Number(page.nextCursor) < 57);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4152);
    since = Number(page.nextCursor); total += messages.length;
  }
  expect(total).toBe(50);
  const recent = await json(await f.call(history + "&limit=50"));
  const messages = recent.messages as Array<{relaySeq: number}>;
  expect(recent.olderCursor).toBe(messages[messages.length - 1]!.relaySeq);
  const older = await json(await f.call(history + `&before=${recent.olderCursor}&limit=50`));
  expect((older.messages as Array<{relaySeq: number}>)[0]!.relaySeq).toBe(Number(recent.olderCursor) - 1);
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

it("reserves browser-chat on the ordinary recipient log route without consuming its sequences", async () => {
  const f = await fixture();
  const response = await f.handler(request("alice", `/sync/shares/${shareId}/log`, jsonBody({originId: "browser-chat", ops: []})));
  expect(response.status).toBe(400);
  expect(await json(response)).toMatchObject({code: "bad_request"});
  expect((await f.post()).status).toBe(200);
});

it("caps browser follows per workspace while leaving capacity for ordinary log readers", async () => {
  const f = await fixture(), controllers: AbortController[] = [], polls: Promise<Response>[] = [];
  try {
    for (let index = 0; index < MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE; index++) {
      const user = `account${index}`, controller = new AbortController(), entered = deferred(), wait = f.activity.wait.bind(f.activity);
      addGrant(f.storage, grant(user, user, "read-only")); controllers.push(controller);
      const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
        const result = wait(group, actor, options); entered.resolve(); return result;
      });
      polls.push(f.call(history + "&since=7&hold=30000", user, {signal: controller.signal}));
      await entered.promise; spy.mockRestore();
    }
    expect(f.activity.stats().waiters).toBe(MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE);
    expect((await f.call(history + "&since=7&hold=30000")).status).toBe(429);
    const controller = new AbortController(); controllers.push(controller);
    const ordinary = f.activity.wait(linkLogWaitGroup(workspaceId), "desktop-reader", {holdMs: 30000, signal: controller.signal, shouldPark: () => true});
    expect(f.activity.stats().waiters).toBe(MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE + 1);
    controller.abort(); await ordinary;
  } finally {controllers.forEach(controller => controller.abort()); await Promise.all(polls);}
  expect(f.activity.stats().waiters).toBe(0);
  expect(await json(await f.call(history + "&since=7"))).toMatchObject({nextCursor: 7});
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

it("does not let a link grant identifier authenticate an account without a user grant", async () => {
  const f = await fixture();
  addGrant(f.storage, {...grant("link", "alice", "read-write"), principalKind: "link", principalUserId: null});
  const response = await f.call("channels?grantId=link", "stranger");
  expect(response.status).toBe(404);
  expect(await json(response)).toMatchObject({code: "not_found"});
});

it("scopes retry IDs to an account and keeps all browser posts in one origin per account and share", async () => {
  const f = await fixture();
  addGrant(f.storage, grant("bob", "bob", "read-write"));
  const alice = await json(await f.post()), bob = await json(await f.post({}, "bob"));
  expect(bob.message).toMatchObject({authorUserId: "bob"});
  expect(bob.message).not.toEqual(alice.message);
  expect(await json(await f.post({}, "bob"))).toEqual(bob);
  expect((await f.post({id: "second", threadId: "thread-team"})).status).toBe(200);
  const concurrent = await Promise.all([f.post({id: "third", threadId: "thread-team"}), f.post({id: "fourth", threadId: "thread-team"})]);
  expect(concurrent.every(response => response.status === 200)).toBe(true);
  const rows = f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows;
  const aliceRows = rows.filter(row => JSON.parse(row.payloadJson).authorUserId === "alice");
  expect(new Set(aliceRows.map(row => row.originId)).size).toBe(1);
  const aliceOrigin = aliceRows[0]!.originId;
  expect(rows.filter(row => row.originId === aliceOrigin).map(row => row.originSeq)).toEqual([0, 1, 2, 3, 4]);
});

it("shows desktop messages without an author user ID and omits oversized bodies while paging and following", async () => {
  const f = await fixture(new DiscussionActivityHub(), 4152);
  f.storage.appendLogBatch({workspaceId, originId: "desktop-large", ops: sequenced([
    chatMessageAppend("large", "thread-team", "x".repeat(5000)),
    chatMessageAppend("after-large", "thread-team", "after"),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  const recent = await json(await f.call(history + "&limit=1"));
  expect(recent.messages).toEqual([expect.objectContaining({messageId: "after-large", authorUserId: null, body: "after", bodyTooLarge: false})]);
  const older = await json(await f.call(history + `&limit=1&before=${recent.olderCursor}`));
  expect(older.messages).toEqual([expect.objectContaining({messageId: "large", authorUserId: null, body: null, bodyTooLarge: true})]);
  const followed = await json(await f.call(history + "&since=7&limit=1"));
  expect(followed).toMatchObject({messages: [expect.objectContaining({messageId: "large", body: null, bodyTooLarge: true})], nextCursor: 8, hasMore: true});
  expect(await json(await f.call(history + `&since=${followed.nextCursor}&limit=1`))).toMatchObject({
    messages: [expect.objectContaining({messageId: "after-large", body: "after"})], nextCursor: 9, hasMore: false,
  });
});

it("claims invitations on channels only, without email lookups for history, follows or posts", async () => {
  const f = await fixture();
  expect((await f.call("channels?grantId=write")).status).toBe(200);
  expect(f.lookupUserEmail).toHaveBeenCalledTimes(1);
  f.lookupUserEmail.mockClear();
  expect((await f.call(history)).status).toBe(200);
  expect((await f.call(history + "&since=7")).status).toBe(200);
  expect((await f.post()).status).toBe(200);
  expect(f.lookupUserEmail).not.toHaveBeenCalled();
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

it("releases the waiter when access changes before the registered park check", async () => {
  const f = await fixture(), wait = f.activity.wait.bind(f.activity);
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    f.storage.revokeShareGrant({shareId, grantId: "write", revokedAtMs: 5});
    return wait(group, actor, options);
  });
  expect((await f.call(history + "&since=7&hold=30000")).status).toBe(404);
  expect(f.activity.stats().waiters).toBe(0);
});

it("seeks only window thread bindings in a workspace with 20k single-message threads", async () => {
  const f = await fixture();
  f.storage.appendLogBatch({workspaceId, originId: "single-message-threads", ops: sequenced(
    Array.from({length: 20_000}, (_, index) => [chatThreadCreate(`single-${index}`, "wire-private"),
      chatMessageAppend(`single-message-${index}`, `single-${index}`, "private")]).flat(),
  ).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  const db = inspectDatabase(storagePath(f.storage));
  const context = f.storage as StorageContext, prepare = context.db.prepare.bind(context.db);
  const plans: Array<Array<Record<string, unknown>>> = [];
  const spy = vi.spyOn(context.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("channel_threads")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
        return all(...params);
      });
    }
    return statement;
  });
  try {
    for (const direction of ["older", "newer"] as const) {
      const page = f.storage.fetchChatMessages({workspaceId, channelWireId, cursor: direction === "older" ? null : 7, direction, limit: 100});
      expect(page.rows).toEqual([]);
      expect(page.nextCursor).toBe(direction === "older" ? 40007 - CHAT_HISTORY_SCAN_WINDOW + 1 : 7 + CHAT_HISTORY_SCAN_WINDOW);
      expect(page.hasMore).toBe(true);
    }
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.map(row => row.detail)).toContainEqual(expect.stringMatching(/SEARCH t USING INDEX idx_sync_relay_log_thread_id .*workspace_id=\? AND <expr>=\?/u));
      expect(plan.map(row => row.detail)).toContainEqual(expect.stringMatching(/SEARCH m USING INDEX idx_sync_relay_log_page .*relay_seq>\? AND relay_seq<\?/u));
      expect(plan.map(row => row.detail)).not.toContainEqual(expect.stringMatching(/^SCAN (?:sync_relay_log|t|m)\b/u));
    }
  } finally {spy.mockRestore(); db.close();}
});

it.each([["older", "wire-private"], ["newer", "wire-private"], ["older", channelWireId], ["newer", channelWireId]] as const)(
  "bounds payload bytes before JSON filtering, direction=%s, channel=%s", async (direction, targetChannel) => {
  const f = await fixture(), budget = 4 * 1024 * 1024;
  const ops = sequenced(Array.from({length: 40}, (_, index) =>
    chatMessageAppend(`large-private-${index}`, targetChannel === channelWireId ? "thread-team" : "thread-private", "名".repeat(87_000))))
    .map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}));
  f.storage.appendLogBatch({workspaceId, originId: "large-private", ops});
  const ordered = direction === "older" ? [...ops].reverse() : ops;
  let count = 0, bytes = 0;
  for (const op of ordered) {
    const length = Buffer.byteLength(op.payloadJson);
    if (bytes + length > budget) break;
    bytes += length; count++;
  }
  const page = f.storage.fetchChatMessages({workspaceId, channelWireId, cursor: direction === "older" ? null : 7, direction, limit: 100});
  expect(page.rows.map(row => JSON.parse(row.payloadJson).messageId as string)).toEqual(
    targetChannel === channelWireId ? ordered.slice(0, count).map(op => JSON.parse(op.payloadJson).messageId as string) : []);
  expect(page.nextCursor).toBe(direction === "older" ? 47 - count + 1 : 7 + count);
  expect(page.hasMore).toBe(true);
  const next = f.storage.fetchChatMessages({workspaceId, channelWireId, cursor: page.nextCursor, direction, limit: 100});
  expect(next.nextCursor).toBe(direction === "older" ? 47 - count * 2 + 1 : 7 + count * 2);
  expect(next.rows.map(row => JSON.parse(row.payloadJson).messageId as string)).toEqual(
    targetChannel === channelWireId ? ordered.slice(count, count * 2).map(op => JSON.parse(op.payloadJson).messageId as string) : []);
});

it.each([false, true])("falls back when the final envelope exceeds the exact byte boundary, following=%s", async following => {
  const seed = (storage: SyncRelayStorage) => storage.appendLogBatch({workspaceId, originId: "boundary", ops: sequenced([
    chatMessageAppend("boundary", "thread-team", "x".repeat(5000)),
    ...Array.from({length: 100}, (_, index) => chatMessageAppend(`tail-${index}`, "thread-private", "private")),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  const baseline = await fixture(); seed(baseline.storage);
  const path = history + (following ? "&since=0" : "");
  const full = await json(await baseline.call(path));
  const budget = Buffer.byteLength(JSON.stringify(full)) - 1;
  const f = await fixture(new DiscussionActivityHub(), budget); seed(f.storage);
  const response = await f.call(path), page = await json(response);
  expect(response.status).toBe(200);
  expect(page.messages).toEqual(full.messages);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(budget);
  expect(following ? page.hasMore : page.olderCursor).toBe(following ? true : 3);
  if (following) {
    expect(full.nextCursor).toBe(108);
    expect(page.nextCursor).toBe(8);
    const nextResponse = await f.call(path.replace("since=0", "since=8"));
    expect(nextResponse.status).toBe(200);
    expect(await json(nextResponse)).toMatchObject({messages: [], nextCursor: 108, hasMore: false});
  }
});

it.each([false, true])("advances an empty partial when a bare marker cannot fit, following=%s", async following => {
  const f = await fixture();
  f.responseLimits.maxResponseBytes = 160;
  const response = await f.call(history + (following ? "&since=0" : "")), page = await json(response);
  expect(response.status).toBe(200);
  expect(page.messages).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(160);
  expect(following ? page.nextCursor : page.olderCursor).toBe(following ? 3 : 7);
  const next = await json(await f.call(history + (following ? `&since=${page.nextCursor}` : `&before=${page.olderCursor}`)));
  expect(following ? next.nextCursor : next.olderCursor).toBe(following ? 7 : 3);
});

it.each(["older", "newer"] as const)("retains earliest thread bindings after a later re-create, direction=%s", async direction => {
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

it("stores account names for humans and agent owners, with the owner-live missing-name fallback", async () => {
  const f = await fixture();
  expect(await json(await f.post())).toMatchObject({message: {authorKind: "human", authorDisplayName: "Alice", authorOwnerDisplayName: null}});
  const agent = await f.post({id: "agent", authorKind: "agent", authorDisplayName: " Planner "});
  expect(await json(agent)).toMatchObject({message: {authorKind: "agent", authorDisplayName: "Planner", authorOwnerDisplayName: "Alice", authorUserId: "alice"}});
  const rows = f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows;
  expect(rows.filter(row => row.opKind === "chat.message.append").map(row => JSON.parse(row.payloadJson))).toEqual([
    expect.objectContaining({authorDisplayName: "Alice", authorKind: "human"}),
    expect.objectContaining({authorDisplayName: "Planner", authorOwnerDisplayName: "Alice", authorKind: "agent"}),
  ]);
  f.lookupUserDisplayName.mockReturnValue(null);
  expect(await json(await f.post({id: "unnamed"}))).toMatchObject({message: {authorDisplayName: "Unnamed"}});
});

it("uses append authorization when reading selects a newer dependent grant", async () => {
  const f = await fixture();
  const direct = authorizeShareAction({storage: f.storage, actorUserId: "alice", shareId, action: "append"});
  if (!direct.ok) throw Error("missing direct authority");
  const dependent = {...grant("dependent", "alice", "read-write"), createdAtMs: 2, parentGrantId: "parent"};
  const requireShareAction = vi.fn((_shareId: string, _userId: string, action: "read" | "append") =>
    action === "read" ? {...direct, grant: dependent} : direct);
  const chat = createNamedRecipientChat({storage: f.storage, resolveActor: (_request, workspaceId) => ({userId: "alice", workspaceId}),
    claimPendingShares: async () => {}, activity: f.activity, publicOrigin: SHARE_WEB_ORIGIN, exchangeKey: RELAY_EXCHANGE_KEY,
    limits, nowMs: () => 2000, requireShareAction, transport: async () => new Response(null), reads: {chatResolverFor: () => {throw Error("unexpected history read");}}});
  const response = await chat(new Request("http://relay.test/sync/named-chat/channels?grantId=write", {
    headers: {cookie: "session=alice", origin: SHARE_WEB_ORIGIN, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY},
  }));
  expect(await json(response)).toMatchObject({channels: [{access: "read-write"}]});
  expect(requireShareAction).toHaveBeenCalledWith(shareId, "alice", "append");
  expect((await f.post()).status).toBe(200);
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

it.each([
  ["human", "Alice"], ["human", null], ["agent", "Alice"], ["agent", null],
] as const)("replays the stored account name after a lookup changes, author=%s, original=%s", async (authorKind, originalName) => {
  const f = await fixture();
  f.lookupUserDisplayName.mockReturnValue(originalName);
  const input = {authorKind, ...(authorKind === "agent" ? {authorDisplayName: "Planner"} : {})};
  const posted = await f.post(input);
  expect(posted.status).toBe(200);
  const first = await json(posted);
  f.lookupUserDisplayName.mockReturnValue("Renamed Alice");
  const retry = await f.post(input);
  expect(retry.status).toBe(200);
  expect(await json(retry)).toEqual(first);
  expect((await f.post({...input, body: "changed"})).status).toBe(409);
  expect((await f.post({...input, threadId: "thread-team"})).status).toBe(409);
  expect((await f.post(authorKind === "human" ? {authorKind: "agent", authorDisplayName: "Planner"} : {authorKind: "human"})).status).toBe(409);
  if (authorKind === "agent") expect((await f.post({...input, authorDisplayName: "Changed agent"})).status).toBe(409);
  const rows = f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows;
  expect(rows.filter(row => row.opKind === "chat.message.append")).toHaveLength(1);
  expect(rows.filter(row => row.opKind === "chat.thread.create")).toHaveLength(1);
});

it("accepts a post at the request byte limit even when its stored payload is larger", async () => {
  const f = await fixture(), budget = 16_384;
  f.responseLimits.maxRequestBytes = budget;
  const input = {shareId, channelWireId, id: "request-1", body: "", authorKind: "human"};
  input.body = "x".repeat(budget - Buffer.byteLength(JSON.stringify(input)));
  expect(Buffer.byteLength(JSON.stringify(input))).toBe(budget);
  const response = await f.post({body: input.body});
  expect(response.status).toBe(200);
  const first = await json(response), retry = await f.post({body: input.body});
  expect(retry.status).toBe(200);
  expect(await json(retry)).toEqual(first);
  const rows = f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows.filter(row => row.opKind === "chat.message.append");
  expect(rows).toHaveLength(1);
  expect(Buffer.byteLength(rows[0]!.payloadJson)).toBeGreaterThan(budget);
});

it("refuses before appending when server-chosen names make the response exceed its budget", async () => {
  const f = await fixture();
  f.responseLimits.maxRequestBytes = 500;
  f.responseLimits.maxResponseBytes = 500;
  const input = {shareId, channelWireId, id: "request-1", body: "x".repeat(100), authorKind: "human"};
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(500);
  f.lookupUserDisplayName.mockReturnValue("名".repeat(40));
  const response = await f.post({body: input.body});
  expect(response.status).toBe(413);
  expect(await json(response)).toMatchObject({code: "payload_too_large"});
  expect(f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 7, limit: 100}).rows).toHaveLength(0);
});
