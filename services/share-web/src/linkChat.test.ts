import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import {
  chatChannelCreate, chatMessageAppend, chatThreadCreate, closeTestStorages, jsonBody, linkSecret, RELAY_EXCHANGE_KEY,
  request, sequenced, testHandler, testStorage,
} from "../../sync-relay/src/testing";
import { createShareWebApplication } from "./server";

// A link on a Group share reads the Group's channel, and a read-write link
// posts there, through the real share-web and the real relay: a person in a
// browser through the viewer's routes, and their agent through the remote
// MCP. Neither has an account; the relay names the link as the author.

const ORIGIN = "https://share.example.test";
const HOST = "share.example.test";
const OWNER = "owner";
const WORKSPACE = "workspace-link-chat";
const CHANNEL = "wire-team";
// Public Edit, which a read-write Group link needs, needs share-web's live limits too.
const liveLimits = {
  requests: { maxPendingRequests: 4, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000 },
  editor: { provider: { frames: { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384 },
    maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384 },
    maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4 },
    maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10 },
};

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await closeTestStorages();
});

type LoggedOp = { originId: string; opKind: string; payload: Record<string, unknown> };

async function stack() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 });
  storage.appendLogBatch({ workspaceId: WORKSPACE, originId: "owner", ops: sequenced([
    chatChannelCreate(CHANNEL, { name: "Team", type: "both", folderPath: "team" }),
    chatThreadCreate("thread-team", CHANNEL),
    chatMessageAppend("owner-first", "thread-team", "Welcome", { authorUserId: OWNER, authorDisplayName: "Ada" }),
  ]).map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })) });
  const relay = testHandler(storage, {
    nowMs: () => Date.now(), publicEditRelease: { version: 1 }, relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: { maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000 },
  });
  const shared = await relay(request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({
    recipientUserId: "member", channelWireId: CHANNEL, paths: ["team"], access: "read-write", subjectName: "Team",
  })));
  expect(shared.status, await shared.clone().text()).toBe(200);
  const shareId = String(((await shared.json()) as { shareId: string }).shareId);
  const app = createShareWebApplication({
    relayUrl: "http://relay.test", publicRelayUrl: "https://relay.test", relayExchangeKey: RELAY_EXCHANGE_KEY,
    publicHosts: new Set([HOST]), publicEditRelease: { version: 1 }, linkLive: { publicOrigin: ORIGIN, ...liveLimits },
    fetchRelay: (incoming) => relay(incoming),
  });
  const send = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    return app.handle(new Request(ORIGIN + path, { ...init, headers }));
  };
  const link = async (access: "read-only" | "read-write") => {
    const created = await relay(request(OWNER, `/sync/${WORKSPACE}/shares/${shareId}/links`, jsonBody({ access })));
    expect(created.status, await created.clone().text()).toBe(200);
    const value = (await created.json()) as { grantId: string; url: string };
    return { grantId: value.grantId, secret: linkSecret(value.url) };
  };
  const revoke = async (grantId: string) => {
    const revoked = await relay(request(OWNER, `/sync/shares/${shareId}/revoke`, jsonBody({ workspaceId: WORKSPACE, grantId, expectedDependentGrantIds: [] })));
    expect(revoked.status, await revoked.clone().text()).toBe(200);
  };
  const linkPosts = async () => {
    const page = (await (await relay(request(OWNER, `/sync/${WORKSPACE}/log?since=0`))).json()) as { ops: LoggedOp[] };
    return page.ops.filter((op) => op.opKind === "chat.message.append" && op.originId.startsWith("relay:share-link:"));
  };
  return { send, link, revoke, linkPosts, handle: app.handle };
}

type Stack = Awaited<ReturnType<typeof stack>>;

/** A person opening the link in a browser. */
async function browser(s: Stack, secret: string) {
  const exchanged = await s.send("/api/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
  expect(exchanged.status).toBe(200);
  const { session } = (await exchanged.json()) as { session: string };
  const cookie = exchanged.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).join("; ");
  const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-dohc-link-session": session, cookie };
  return {
    read: (path: string) => s.send(`/api/view/chat/${path}`, { headers }),
    post: (body: Record<string, unknown>, changed: Record<string, string | null> = {}) => {
      const sent = new Headers({ ...headers, "content-type": "application/json" });
      for (const [name, value] of Object.entries(changed)) {
        if (value === null) sent.delete(name); else sent.set(name, value);
      }
      return s.send("/api/view/chat/messages", { method: "POST", headers: sent, body: JSON.stringify({ channelWireId: CHANNEL, ...body }) });
    },
  };
}

/** An agent given only the link. */
async function agent(s: Stack, secret: string): Promise<Client> {
  const exchanged = await s.send("/api/mcp/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
  expect(exchanged.status).toBe(200);
  const { bearer } = (await exchanged.json()) as { bearer: string };
  const client = new Client({ name: "link-agent", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: (input, init) => {
      const incoming = new Request(input, init);
      incoming.headers.set("host", HOST);
      return s.handle(incoming);
    },
  }));
  return client;
}

const history = `messages?channelWireId=${CHANNEL}`;

it("lets a browser with a read-write link read the Group's channel and post as the link", async () => {
  const s = await stack();
  const link = await s.link("read-write");
  const b = await browser(s, link.secret);
  expect(await (await b.read("channels")).json()).toMatchObject({ channels: [{ channelWireId: CHANNEL, name: "Team", access: "read-write" }] });
  expect(((await (await b.read(history)).json()) as { messages: unknown[] }).messages)
    .toEqual([expect.objectContaining({ messageId: "owner-first", authorKind: "human", authorDisplayName: "Ada", body: "Welcome" })]);

  const posted = await b.post({ body: "Count me in", idempotencyKey: "post-1", claimedName: "Sam" });
  expect(posted.status, await posted.clone().text()).toBe(200);
  const { message } = (await posted.json()) as { message: Record<string, unknown> };
  expect(message).toMatchObject({ authorKind: "link", authorDisplayName: "Sam", authorOwnerDisplayName: null, body: "Count me in" });
  expect(message).not.toHaveProperty("authorUserId");
  // A retry with the same key answers the same post; another name for this browser conflicts.
  expect(((await (await b.post({ body: "Count me in", idempotencyKey: "post-1", claimedName: "Sam" })).json()) as { message: { messageId: string } })
    .message.messageId).toBe(message.messageId);
  const renamed = await b.post({ body: "Again", idempotencyKey: "post-2", claimedName: "Other" });
  expect(renamed.status).toBe(409);
  expect(await renamed.json()).toEqual({ ok: false, code: "conflict" });

  const [stored] = await s.linkPosts();
  expect(stored?.payload).toMatchObject({ messageId: message.messageId, authorKind: "link", linkGrantId: link.grantId, authorDisplayName: "Sam" });
  expect(stored?.payload).not.toHaveProperty("authorUserId");
  expect(((await (await b.read(history)).json()) as { messages: Array<Record<string, unknown>> }).messages[0])
    .toMatchObject({ messageId: message.messageId, authorKind: "link" });
});

it("posts only from the viewer page with the link's session", async () => {
  const s = await stack();
  const b = await browser(s, (await s.link("read-write")).secret);
  for (const changed of [{ origin: "https://other.test" }, { origin: null }, { "sec-fetch-site": "cross-site" },
    { "x-dohc-link-session": null }, { "content-type": "text/plain" }] as Array<Record<string, string | null>>) {
    expect((await b.post({ body: "Hi", idempotencyKey: "post-1" }, changed)).status, JSON.stringify(changed)).toBe(404);
  }
  for (const extra of [{ authorKind: "human" }, { linkGrantId: "grant-0" }, { messageId: "link-message:taken" }]) {
    expect((await b.post({ body: "Hi", idempotencyKey: "post-1", ...extra })).status, JSON.stringify(extra)).toBe(404);
  }
  expect(await s.linkPosts()).toEqual([]);
});

it("lets a read-only link read the channel and refuses its post", async () => {
  const s = await stack();
  const b = await browser(s, (await s.link("read-only")).secret);
  expect(await (await b.read("channels")).json()).toMatchObject({ channels: [{ channelWireId: CHANNEL, access: "read-only" }] });
  expect((await b.read(history)).status).toBe(200);
  const refused = await b.post({ body: "Hi", idempotencyKey: "post-1" });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "link_view_access" });
  expect(await s.linkPosts()).toEqual([]);
});

it("refuses a revoked link's reads and posts", async () => {
  const s = await stack();
  const link = await s.link("read-write");
  const b = await browser(s, link.secret);
  expect((await b.read("channels")).status).toBe(200);
  await s.revoke(link.grantId);
  expect((await b.read("channels")).status).toBe(404);
  expect((await b.read(history)).status).toBe(404);
  expect((await b.post({ body: "Hi", idempotencyKey: "post-1" })).status).toBe(404);
  expect(await s.linkPosts()).toEqual([]);
});

it("lets an agent with only a read-write link read the channel and post, with the link as the author", async () => {
  const s = await stack();
  const link = await s.link("read-write");
  const mcp = await agent(s, link.secret);
  expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["dohc_read_channel", "dohc_post_channel"]));
  const read = (await mcp.callTool({ name: "dohc_read_channel", arguments: {} })).structuredContent as { messages: unknown[]; nextCursor: number };
  expect(read.messages).toEqual([expect.objectContaining({ messageId: "owner-first", body: "Welcome" })]);

  const posted = await mcp.callTool({ name: "dohc_post_channel", arguments: { body: "On it", idempotencyKey: "agent-1", claimedName: "Planner", threadId: "thread-team" } });
  expect(posted.isError).toBeFalsy();
  expect((posted.structuredContent as { message: Record<string, unknown> }).message)
    .toMatchObject({ threadId: "thread-team", authorKind: "link", authorDisplayName: "Planner", body: "On it" });
  const [stored] = await s.linkPosts();
  expect(stored?.payload).toMatchObject({ threadId: "thread-team", authorKind: "link", linkGrantId: link.grantId, body: "On it" });
  expect(stored?.payload).not.toHaveProperty("authorUserId");

  const followed = (await mcp.callTool({ name: "dohc_read_channel", arguments: { since: read.nextCursor } })).structuredContent as { messages: unknown[] };
  expect(followed.messages).toEqual([expect.objectContaining({ authorKind: "link", body: "On it" })]);
});

it("refuses a post from an agent with a read-only link", async () => {
  const s = await stack();
  const mcp = await agent(s, (await s.link("read-only")).secret);
  expect((await mcp.callTool({ name: "dohc_read_channel", arguments: {} })).isError).toBeFalsy();
  const refused = await mcp.callTool({ name: "dohc_post_channel", arguments: { body: "Hi", idempotencyKey: "agent-1" } });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("This link gives View access.");
  expect(await s.linkPosts()).toEqual([]);
});
