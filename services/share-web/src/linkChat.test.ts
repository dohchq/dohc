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

async function stack(options: Parameters<typeof testStorage>[0] = {}) {
  const storage = await testStorage(options);
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
  const relayPaths: string[] = [];
  // "METHOD /path" of relay calls whose next answer is lost after the relay made it:
  // before its response arrives, with its body broken, or replaced by a JSON 429 whose body breaks.
  const lost = new Map<string, "connection" | "body" | "refusal">();
  const app = createShareWebApplication({
    relayUrl: "http://relay.test", publicRelayUrl: "https://relay.test", relayExchangeKey: RELAY_EXCHANGE_KEY,
    publicHosts: new Set([HOST]), publicEditRelease: { version: 1 }, linkLive: { publicOrigin: ORIGIN, ...liveLimits },
    fetchRelay: async (incoming) => {
      const path = new URL(incoming.url).pathname, call = `${incoming.method} ${path}`, loss = lost.get(call);
      relayPaths.push(path);
      lost.delete(call);
      const answered = await relay(incoming);
      if (!loss) return answered;
      await answered.body?.cancel();
      if (loss === "connection") throw new TypeError("connection reset");
      const broken = new ReadableStream({ start: (controller) => controller.error(new TypeError("connection reset")) });
      return loss === "body" ? new Response(broken, { status: answered.status, headers: answered.headers })
        : new Response(broken, { status: 429, headers: { "content-type": "application/json" } });
    },
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
  return { send, link, revoke, linkPosts, relayPaths, handle: app.handle, lost, storage, shareId };
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
    meta: () => s.send("/api/view/meta", { headers }),
    view: (path: string) => s.send(`/api/view/${path}`, { headers }),
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
  expect(await (await b.read("channels")).json())
    .toMatchObject({ profileName: null, channels: [{ channelWireId: CHANNEL, name: "Team", access: "read-write" }] });
  expect(((await (await b.read(history)).json()) as { messages: unknown[] }).messages)
    .toEqual([expect.objectContaining({ messageId: "owner-first", authorKind: "human", authorDisplayName: "Ada", body: "Welcome" })]);

  const posted = await b.post({ body: "Count me in", idempotencyKey: "post-1", claimedName: "Sam" });
  expect(posted.status, await posted.clone().text()).toBe(200);
  const { message } = (await posted.json()) as { message: Record<string, unknown> };
  expect(message).toMatchObject({ authorKind: "link", authorDisplayName: "Sam", authorOwnerDisplayName: null, body: "Count me in" });
  expect(message).not.toHaveProperty("authorUserId");
  // A retry with the same key answers the same post; another name for this browser is refused in words.
  expect(((await (await b.post({ body: "Count me in", idempotencyKey: "post-1", claimedName: "Sam" })).json()) as { message: { messageId: string } })
    .message.messageId).toBe(message.messageId);
  const renamed = await b.post({ body: "Again", idempotencyKey: "post-2", claimedName: "Other" });
  expect(renamed.status).toBe(409);
  expect(await renamed.json()).toEqual({ ok: false, code: "link_name_already_set",
    error: "This link holder already has a name. Post with that name, or with none." });
  // After a reload, the channel answer already knows this browser's name.
  expect(await (await b.read("channels")).json()).toMatchObject({ profileName: "Sam" });

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
  const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
  expect(tools).toEqual(expect.arrayContaining(["dohc_read_channel", "dohc_post_channel"]));
  // The conversation the viewer shows for this link: the channel, in place of the share discussion.
  expect(tools.filter((name) => name.includes("discussion"))).toEqual([]);
  // The share's own answer names its channel; listing tools asks the relay nothing more.
  expect(s.relayPaths).not.toContain("/sync/link/chat/channels");
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

  // A refusal reaches the agent as a sentence it can act on.
  const renamed = await mcp.callTool({ name: "dohc_post_channel", arguments: { body: "Again", idempotencyKey: "agent-2", claimedName: "Other" } });
  expect(renamed.isError).toBe(true);
  expect(renamed.structuredContent).toEqual({ ok: false, code: "link_name_already_set",
    error: "This link holder already has a name. Post with that name, or with none." });
});

it("answers a post whose answer was lost as retryable, and its retry with the same key posts once", async () => {
  const s = await stack();
  const b = await browser(s, (await s.link("read-write")).secret);
  s.lost.set("POST /sync/link/chat/messages", "body");
  const lost = await b.post({ body: "Count me in", idempotencyKey: "post-1" });
  expect(lost.status).toBe(503);
  expect(await lost.json()).toMatchObject({ ok: false, code: "link_unavailable" });
  expect(await s.linkPosts()).toHaveLength(1);
  const retried = await b.post({ body: "Count me in", idempotencyKey: "post-1" });
  expect(retried.status).toBe(200);
  const { message } = (await retried.json()) as { message: { messageId: string } };
  expect((await s.linkPosts()).map((op) => op.payload.messageId)).toEqual([message.messageId]);

  // An agent hears that the post may have landed, and that the same key is safe.
  const mcp = await agent(s, (await s.link("read-write")).secret);
  const post = { name: "dohc_post_channel", arguments: { body: "On it", idempotencyKey: "agent-1" } };
  s.lost.set("POST /sync/link/chat/messages", "connection");
  const unknown = await mcp.callTool(post);
  expect(unknown.isError).toBe(true);
  expect(unknown.structuredContent).toEqual({ ok: false, code: "link_unavailable",
    error: "dohc could not confirm this post, so it may have posted. Send it again with the same idempotencyKey and fields; it posts only once." });
  expect(await s.linkPosts()).toHaveLength(2);
  expect((await mcp.callTool(post)).isError).toBeFalsy();
  expect(await s.linkPosts()).toHaveLength(2);
});

it("answers a lost share answer as retryable, so neither a browser nor an agent loses the channel", async () => {
  const s = await stack();
  const link = await s.link("read-write");
  const b = await browser(s, link.secret);
  for (const loss of ["connection", "refusal"] as const) {
    s.lost.set("GET /sync/link/share", loss);
    const lost = await b.meta();
    expect(lost.status, loss).toBe(503);
    expect(await lost.json()).toMatchObject({ ok: false, code: "link_unavailable" });
    expect(await (await b.meta()).json()).toMatchObject({ channel: { channelWireId: CHANNEL, access: "read-write" } });
  }
  // A successful answer still streams, so its status arrives before its body breaks.
  s.lost.set("GET /sync/link/share", "body");
  const streamed = await b.meta();
  expect(streamed.status).toBe(200);
  await expect(streamed.text()).rejects.toThrow();

  // An agent's request fails as a whole instead of listing tools without the channel's,
  // whether the answer is lost before it arrives, partway through, or in a refusal's body.
  const mcp = await agent(s, link.secret);
  for (const loss of ["connection", "body", "refusal"] as const) {
    s.lost.set("GET /sync/link/share", loss);
    await expect(mcp.listTools(), loss).rejects.toThrow(/"code":"link_unavailable"/u);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["dohc_read_channel", "dohc_post_channel"]));
  }
});

it("answers a lost files, change history, file or discussion answer as retryable, not as an ended link", async () => {
  const s = await stack();
  const b = await browser(s, (await s.link("read-write")).secret);
  const blob = "a".repeat(64);
  for (const [call, path] of [
    ["GET /sync/link/current", "current"],
    ["GET /sync/link/log", "log?since=0&hold=0"],
    [`GET /sync/link/blobs/${blob}`, `blob/${blob}`],
    ["GET /sync/link/discussion", "discussion"],
  ] as const) {
    const answered = (await b.view(path)).status;
    for (const loss of ["connection", "refusal"] as const) {
      s.lost.set(call, loss);
      const lost = await b.view(path);
      expect(lost.status, `${path} ${loss}`).toBe(503);
      expect(await lost.json()).toMatchObject({ ok: false, code: "link_unavailable" });
      expect((await b.view(path)).status, `${path} ${loss}`).toBe(answered);
    }
  }
  // An agent hears to try again, not that the link ended.
  const mcp = await agent(s, (await s.link("read-write")).secret);
  for (const [call, tool] of [["GET /sync/link/current", "dohc_list_files"], ["GET /sync/link/log", "dohc_list_changes"]] as const) {
    s.lost.set(call, "refusal");
    const lost = await mcp.callTool({ name: tool, arguments: {} });
    expect(lost.isError, tool).toBe(true);
    expect(lost.content, tool).toEqual([{ type: "text", text: "This link can't be reached right now. Try again in a moment." }]);
    expect((await mcp.callTool({ name: tool, arguments: {} })).isError, tool).toBeFalsy();
  }
});

it("says what to do when the link's messages run out, or the owner blocks or pauses posts", async () => {
  const s = await stack({ discussionLifetimeMessageLimit: 1 });
  const refusal = async (response: Response) => ({ status: response.status, body: await response.json() });
  const link = await s.link("read-write");
  const first = await browser(s, link.secret), second = await browser(s, link.secret);
  expect((await first.post({ body: "One", idempotencyKey: "post-1" })).status).toBe(200);
  expect(await refusal(await first.post({ body: "Two", idempotencyKey: "post-2" }))).toEqual({ status: 413, body: { ok: false,
    code: "discussion_limit_reached", error: "This link has reached its message limit. Ask the owner if you need to post more." } });

  const other = await s.link("read-write");
  const blocked = await browser(s, other.secret);
  expect((await blocked.post({ body: "One", idempotencyKey: "post-1" })).status).toBe(200);
  const principalId = String((await s.linkPosts()).find((op) => op.payload.linkGrantId === other.grantId)?.payload.linkPrincipalId);
  expect(s.storage.setLinkPrincipalBlocked({ shareId: s.shareId, workspaceId: WORKSPACE, principalId, actorUserId: OWNER, blockedAtMs: Date.now() })).toBe(true);
  expect(await refusal(await blocked.post({ body: "Two", idempotencyKey: "post-2" }))).toEqual({ status: 403, body: { ok: false,
    code: "link_discussion_blocked", error: "The owner stopped this link holder from posting. Ask the owner to allow your posts again." } });

  // A pause reads as temporary.
  expect(s.storage.setShareLinkWritesPaused({ shareId: s.shareId, workspaceId: WORKSPACE, actorUserId: OWNER, pausedAtMs: Date.now() })).toBe(true);
  expect(await refusal(await second.post({ body: "Hi", idempotencyKey: "post-1" }))).toEqual({ status: 403, body: { ok: false,
    code: "link_discussion_paused", error: "The owner paused posts from share links. Try again later." } });
});

it("gives an agent with a read-only link the channel to read and no tool to post", async () => {
  const s = await stack();
  const mcp = await agent(s, (await s.link("read-only")).secret);
  const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("dohc_read_channel");
  expect(tools).not.toContain("dohc_post_channel");
  expect((await mcp.callTool({ name: "dohc_read_channel", arguments: {} })).isError).toBeFalsy();
  expect(await s.linkPosts()).toEqual([]);
});
