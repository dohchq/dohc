import { connect } from "node:net";
import { serveFetchHandler } from "@dohc/service-http";
import { getCookies } from "better-auth/cookies";
import { afterEach, expect, it, vi } from "vitest";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import { chatChannelCreate, chatMessageAppend, chatThreadCreate, testStorage, closeTestStorages, sequenced } from "../../sync-relay/src/testing";
import { createShareWebApplication } from "./server";
import { createNamedRecipientChatClient } from "./namedRecipientChat";

const origin = "https://share.example.test", exchangeKey = "named-chat-exchange-key-at-least-32-characters";
const cookieName = getCookies({baseURL: origin}).sessionToken.name;
const limits = {maxPendingRequests: 2, maxRequestBytes: 4096, maxResponseBytes: 16384, timeoutMs: 1000};
const history = "messages?shareId=share&channelWireId=wire";
function request(path = history, user = "alice", input?: unknown): Request {
  return new Request(`${origin}/api/named-chat/${path}`, {method: input === undefined ? "GET" : "POST",
    ...(input === undefined ? {} : {body: JSON.stringify(input)}),
    headers: {host: "share.example.test", origin, cookie: `${cookieName}=${user}`, "content-type": "application/json"}});
}
const message = {shareId: "share", channelWireId: "wire", id: "retry-id", body: "Browser message", authorKind: "human", authorDisplayName: "Alice"};

async function fixture(access: "read-only" | "read-write" = "read-write") {
  const storage = await testStorage(), activity = new DiscussionActivityHub();
  storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1});
  storage.appendLogBatch({workspaceId: "workspace", originId: "owner", ops: sequenced([
    chatChannelCreate("wire", {name: "Team", type: "both", folderPath: "team"}),
    chatThreadCreate("thread", "wire"),
    chatMessageAppend("welcome", "thread", "Welcome", {authorUserId: "owner"}),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: "owner", createdAtMs: 1,
    selectorJson: JSON.stringify({kind: "group", channelWireId: "wire", paths: ["team"], versionId: null}), labels: {subjectName: "Team"}},
    grant: {shareId: "share", grantId: "grant", principalKind: "user", principalUserId: "alice", principalEmail: null, access,
      generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  const resolveActor = vi.fn<ResolveActor>((incoming, workspaceId) => {
    expect([...incoming.headers.keys()]).toEqual(["cookie"]);
    const cookie = incoming.headers.get("cookie"), userId = cookie?.slice(cookieName.length + 1);
    if (!cookie?.startsWith(`${cookieName}=`) || !userId) throw new UnauthorizedError();
    return {userId, workspaceId};
  });
  const relay = createSyncRelayHandler({storage, resolveActor, discussionActivity: activity,
    shareWebOrigin: origin, relayExchangeKey: exchangeKey, namedBrowserSessionLimits: {...limits, maxSessions: 8, retentionMs: 60_000}});
  const forwarded: Request[] = [];
  const web = createShareWebApplication({relayUrl: "http://relay.invalid", publicRelayUrl: "https://relay.test", publicHosts: new Set(["share.example.test"]),
    accountAuth: {upstreamUrl: "http://auth.invalid", publicOrigin: origin}, relayExchangeKey: exchangeKey, namedBrowserSessionLimits: limits,
    fetchRelay: incoming => {forwarded.push(incoming.clone()); return relay(incoming);}});
  return {storage, relay, resolveActor, forwarded, web, activity};
}
afterEach(async () => {vi.useRealTimers(); await closeTestStorages();});

it("exposes channel metadata and plain message reads/posts through the named account session", async () => {
  const f = await fixture(), incoming = request("messages", "alice", message);
  incoming.headers.set("cookie", `${cookieName}=alice; dohc_link=secret; unrelated=secret`);
  incoming.headers.set("authorization", "Bearer forged"); incoming.headers.set("x-user-id", "owner");
  incoming.headers.set("x-dohc-relay-exchange-key", "forged");
  const channels = await f.web.handle(request("channels?grantId=grant"));
  expect(channels.status).toBe(200);
  expect(await channels.json()).toMatchObject({shareId: "share", userId: "alice", channels: [{channelWireId: "wire", name: "Team", access: "read-write"}]});
  const posted = await f.web.handle(incoming), result = await posted.json();
  expect(posted.status).toBe(200);
  expect(result).toMatchObject({message: {body: message.body, authorDisplayName: "Alice", authorUserId: "alice", authorKind: "human"}});
  expect(await (await f.web.handle(request("messages", "alice", message))).json()).toEqual(result);
  const read = await f.web.handle(request());
  expect(await read.json()).toMatchObject({messages: [expect.objectContaining({body: message.body}), expect.objectContaining({body: "Welcome"})]});
  expect(read.headers.get("cache-control")).toBe("private, no-store");
  expect(read.headers.get("set-cookie")).toBeNull();
  for (const forwarded of f.forwarded) {
    expect(forwarded.headers.get("cookie")).toBe(`${cookieName}=alice`);
    expect(forwarded.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
    expect(forwarded.headers.has("authorization")).toBe(false);
    expect(forwarded.headers.has("x-user-id")).toBe(false);
  }
});

it("preserves server refusals for read-only recipients, forged authors, removed access, and strangers", async () => {
  const f = await fixture("read-only");
  expect((await f.web.handle(request())).status).toBe(200);
  const denied = await f.web.handle(request("messages", "alice", message));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({code: "share_read_only"});
  expect((await f.web.handle(request(history, "bob"))).status).toBe(404);
  expect((await f.web.handle(request("messages", "bob", message))).status).toBe(404);
  f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 5});
  expect((await f.web.handle(request())).status).toBe(404);
  expect((await f.web.handle(request("messages", "alice", message))).status).toBe(404);
  const writable = await fixture();
  expect((await writable.web.handle(request("messages", "alice", {...message, authorUserId: "owner"}))).status).toBe(403);
  expect((await writable.web.handle(request("messages", "alice", {...message, ops: []}))).status).toBe(403);
});

it("enforces same-origin writes, account cookie selection, and request bounds before contacting the relay", async () => {
  const f = await fixture();
  for (const change of [
    (r: Request) => r.headers.delete("origin"),
    (r: Request) => r.headers.set("origin", "https://other.test"),
    (r: Request) => r.headers.set("host", "other.test"),
    (r: Request) => r.headers.set("sec-fetch-site", "cross-site"),
    (r: Request) => r.headers.set("content-type", "text/plain"),
    (r: Request) => r.headers.set("cookie", "dohc_link=secret"),
    (r: Request) => r.headers.set("cookie", `${cookieName}=alice; ${cookieName}=bob`),
  ]) {
    const incoming = request("messages", "alice", message); change(incoming);
    expect((await f.web.handle(incoming)).status).toBe(404);
  }
  expect((await f.web.handle(request("messages", "alice", {...message, body: "x".repeat(limits.maxRequestBytes)}))).status).toBe(404);
  expect(f.forwarded).toHaveLength(0);
  const foreignRead = request(); foreignRead.headers.set("origin", "https://other.test");
  expect((await f.web.handle(foreignRead)).status).toBe(404);
  expect(f.forwarded).toHaveLength(0);
  const agentRead = request(); agentRead.headers.delete("origin");
  expect((await f.web.handle(agentRead)).status).toBe(200);
});

it("follows new messages and propagates disconnect cancellation to release the relay waiter", async () => {
  const f = await fixture();
  let entered!: () => void;
  const parked = new Promise<void>(resolve => {entered = resolve;});
  const wait = f.activity.wait.bind(f.activity);
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    const pending = wait(group, actor, options); entered(); return pending;
  });
  const controller = new AbortController();
  const polling = f.web.handle(new Request(request(history + "&since=3&hold=30000"), {signal: controller.signal}));
  await parked;
  expect(f.activity.stats().waiters).toBe(1);
  const posted = await f.web.handle(request("messages", "alice", {...message, threadId: "thread"}));
  expect(posted.status).toBe(200);
  expect(await (await polling).json()).toMatchObject({messages: [expect.objectContaining({body: message.body})]});
  expect(f.activity.stats().waiters).toBe(0);
  const read = await (await f.web.handle(request())).json() as {nextCursor: number};
  const disconnected = f.web.handle(new Request(request(history + `&since=${read.nextCursor}&hold=30000`), {signal: controller.signal}));
  await vi.waitFor(() => expect(f.activity.stats().waiters).toBe(1));
  controller.abort(); await disconnected;
  expect(f.activity.stats().waiters).toBe(0);
});

it("keeps cancelled authentication in capacity until it settles", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void, count = 0;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const both = new Promise<void>(resolve => {entered = resolve;});
  f.resolveActor.mockImplementation(async (_incoming, workspaceId) => {
    if (++count === 2) entered(); await blocked; return {userId: "alice", workspaceId};
  });
  const controller = new AbortController();
  const first = f.web.handle(new Request(request(), {signal: controller.signal})), second = f.web.handle(request());
  await both; controller.abort();
  expect((await first).status).toBe(404);
  expect((await f.web.handle(request())).status).toBe(404);
  release(); expect((await second).status).toBe(200);
  expect((await f.web.handle(request())).status).toBe(200);
});

it.each(["redirect", "html", "oversized", "invalid-json", "invalid-schema"])("refuses an invalid upstream %s response", async mode => {
  const web = createNamedRecipientChatClient({relayUrl: "http://relay.test", publicOrigin: origin, exchangeKey, limits,
    fetchRelay: async () => mode === "redirect" ? new Response(null, {status: 302, headers: {location: "https://other.test"}}) :
      mode === "html" ? new Response("<html>") :
        mode === "invalid-schema" ? Response.json({shareId: "share", messages: []}) :
        new Response(mode === "invalid-json" ? "{" : JSON.stringify({messages: ["x".repeat(limits.maxResponseBytes)]}), {headers: {"content-type": "application/json"}})});
  expect((await web(request())).status).toBe(404);
});

it("releases a relay waiter after a real share-web socket disconnect", async () => {
  const f = await fixture();
  let entered!: () => void, released!: () => void;
  const parked = new Promise<void>(resolve => {entered = resolve;});
  const finished = new Promise<void>(resolve => {released = resolve;});
  const wait = f.activity.wait.bind(f.activity);
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    const pending = wait(group, actor, options); entered(); return pending.finally(released);
  });
  const server = serveFetchHandler({handler: incoming => f.web.handle(incoming), maxBodyBytes: () => limits.maxRequestBytes,
    oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
  await new Promise<void>(resolve => {server.listen(0, "127.0.0.1", resolve);});
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing test address");
  const socket = connect(address.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {socket.once("connect", resolve); socket.once("error", reject);});
    socket.write(`GET /api/named-chat/${history}&since=3&hold=30000 HTTP/1.1\r\nHost: share.example.test\r\nOrigin: ${origin}\r\nCookie: ${cookieName}=alice\r\n\r\n`);
    await parked;
    expect(f.activity.stats().waiters).toBe(1);
    socket.destroy();
    await finished;
    expect(f.activity.stats().waiters).toBe(0);
  } finally {
    socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve());});
  }
});

it("validates nullable desktop authors and oversized-body markers from the relay", async () => {
  const f = await fixture();
  f.storage.appendLogBatch({workspaceId: "workspace", originId: "desktop", ops: sequenced([
    chatMessageAppend("oversized", "thread", "x".repeat(limits.maxResponseBytes + 1)),
    chatMessageAppend("next", "thread", "readable"),
  ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  const followed = await f.web.handle(request(history + "&since=3&limit=1"));
  expect(followed.status).toBe(200);
  expect(await followed.json()).toMatchObject({messages: [{messageId: "oversized", authorUserId: null, body: null, bodyTooLarge: true}], nextCursor: 4, hasMore: true});
  const read = await f.web.handle(request(history + "&since=4&limit=1"));
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({messages: [{messageId: "next", body: "readable", bodyTooLarge: false}], nextCursor: 5});
});

it("isolates a full account follow pool from another account's lists, history and posts", async () => {
  const f = await fixture();
  f.storage.createShare({share: {shareId: "bob-share", workspaceId: "workspace", granterUserId: "owner", createdAtMs: 1,
    selectorJson: JSON.stringify({kind: "chat", channelWireId: "wire"})},
    grant: {shareId: "bob-share", grantId: "bob-grant", principalKind: "user", principalUserId: "bob", principalEmail: null,
      access: "read-write", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  const controllers = [new AbortController(), new AbortController()], polls: Promise<Response>[] = [];
  try {
    for (const controller of controllers) {
      let entered!: () => void;
      const parked = new Promise<void>(resolve => {entered = resolve;}), wait = f.activity.wait.bind(f.activity);
      const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
        const result = wait(group, actor, options); entered(); return result;
      });
      polls.push(f.web.handle(new Request(request(history + "&since=3&hold=30000"), {signal: controller.signal})));
      await parked; spy.mockRestore();
    }
    expect(f.activity.stats().waiters).toBe(2);
    const overflow = await f.web.handle(request(history + "&since=3&hold=30000"));
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toMatchObject({code: "share_access_rate_limited"});
    expect((await f.web.handle(request("channels?grantId=bob-grant", "bob"))).status).toBe(200);
    expect((await f.web.handle(request(history.replace("shareId=share", "shareId=bob-share"), "bob"))).status).toBe(200);
    expect((await f.web.handle(request("messages", "bob", {...message, shareId: "bob-share", threadId: "thread"}))).status).toBe(200);
    expect((await Promise.all(polls)).every(response => response.status === 200)).toBe(true);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.all(polls);
  }
  expect(f.activity.stats().waiters).toBe(0);
});
