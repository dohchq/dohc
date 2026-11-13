import { getCookies } from "better-auth/cookies";
import { afterEach, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import type { SyncRelayHandler } from "../../sync-relay/src/server";
import type { SyncRelayStorage } from "../../sync-relay/src/storage";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import {
  RELAY_EXCHANGE_KEY, SHARE_WEB_ORIGIN, chatChannelCreate, chatMessageAppend, chatThreadCreate, closeTestStorages, json, jsonBody, logOp,
  putBlob, request, resetOpSeq, resolveTestActor, testHandler, testStorage,
} from "../../sync-relay/src/testing";
import { createShareWebApplication } from "./server";

// A workspace member reads the workspace in a browser through share-web's
// view routes and follows every Group it reaches in one request. The account
// cookie names the person; the page names only the grant.

const HOST = new URL(SHARE_WEB_ORIGIN).host;
const cookieName = getCookies({ baseURL: SHARE_WEB_ORIGIN }).sessionToken.name;
const WORKSPACE = "workspace-members-web";
const OWNER = "owner";
const limits = { maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 65536, timeoutMs: 1000 };
afterEach(async () => { vi.useRealTimers(); await closeTestStorages(); });

function resolveActor(incoming: Request, workspaceId: string) {
  const cookie = incoming.headers.get("cookie");
  if (cookie !== null) {
    const userId = cookie.startsWith(`${cookieName}=`) ? cookie.slice(cookieName.length + 1) : "";
    if (!/^\w+$/u.test(userId)) throw new UnauthorizedError();
    return { userId, workspaceId };
  }
  return resolveTestActor(incoming, workspaceId);
}

async function ownerAppend(h: SyncRelayHandler, ops: unknown[]) {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })));
  expect(response.status, await response.clone().text()).toBe(200);
}

let fileSeq = 0;
async function ownerWrite(h: SyncRelayHandler, path: string, text: string) {
  const sha = await putBlob(h, OWNER, WORKSPACE, text);
  const seq = fileSeq++;
  await ownerAppend(h, [logOp("moment.append", {
    momentId: `m-${seq}`, versionId: "main", objectId: `object-${path}`, path, recordedAtMs: 1000 + seq,
    operation: "write", payloadBeforeBlobSha256: null, payloadBeforePath: null,
    payloadAfterBlobSha256: sha, payloadAfterPath: path, metadata: { origin: "user" }, beforePresent: "null",
  })]);
  return sha;
}

const group = (wireId: string, name: string) => logOp("chat.channel.create", chatChannelCreate(wireId, {
  channelId: `chan-${wireId}`, name, slug: name, kind: "channel", type: "both", purpose: "", folderPath: name }).payload);

async function fixture(level: "view" | "comment" | "edit" = "comment") {
  resetOpSeq(); fileSeq = 0;
  const storage: SyncRelayStorage = await testStorage();
  const relay = testHandler(storage, { resolveActor, lookupUserDisplayName: (userId: string) => `Name ${userId}`,
    discussionActivity: new DiscussionActivityHub(), namedBrowserSessionLimits: { ...limits, maxSessions: 8, retentionMs: 60_000 },
    relayExchangeKey: RELAY_EXCHANGE_KEY });
  expect((await relay(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status).toBe(200);
  await ownerAppend(relay, [
    group("wire-plans", "plans"), logOp("chat.thread.create", chatThreadCreate("t-plans", "wire-plans", { slug: "t-plans" }).payload),
    logOp("chat.message.append", chatMessageAppend("m-plans", "t-plans", "Plans start here", { authorUserId: OWNER }).payload),
    group("wire-food", "food"), logOp("chat.thread.create", chatThreadCreate("t-food", "wire-food", { slug: "t-food" }).payload),
    logOp("chat.message.append", chatMessageAppend("m-food", "t-food", "Bring snacks", { authorUserId: OWNER }).payload),
  ]);
  const planSha = await ownerWrite(relay, "trip/plan.md", "# Plan\n\nLeave at nine.");
  const invite = await relay(request(OWNER, `/sync/${WORKSPACE}/members/invites`, jsonBody({ email: "sam@dohc.test", workspaceName: "Trip" })));
  expect(invite.status, await invite.clone().text()).toBe(200);
  const memberId = (await json(invite)).memberId as string;
  if (level !== "comment") {
    const changed = await relay(request(OWNER, `/sync/${WORKSPACE}/members/level`, jsonBody({ level })));
    expect(changed.status, await changed.clone().text()).toBe(200);
  }
  const received = await json(await relay(request("sam", "/sync/shares")));
  const shareId = (received.received as Array<Record<string, unknown>>).find(row => (row.selector as { kind?: string }).kind === "workspace")!.shareId as string;
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, "sam")[0]!.grantId;
  const forwarded: Request[] = [];
  const web = createShareWebApplication({ relayUrl: "http://relay.invalid", publicRelayUrl: "https://relay.test", publicHosts: new Set([HOST]),
    accountAuth: { upstreamUrl: "http://auth.invalid", publicOrigin: SHARE_WEB_ORIGIN }, relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: limits, fetchRelay: incoming => { forwarded.push(incoming.clone()); return relay(incoming); } });
  const view = (path: string, user = "sam", token = `member.${grantId}`, headers: Record<string, string> = {}) =>
    web.handle(new Request(`${SHARE_WEB_ORIGIN}${path}`, { headers: { host: HOST, cookie: `${cookieName}=${user}`, "x-dohc-link-session": token, ...headers } }));
  const chat = (path: string, user = "sam", init: RequestInit = {}) =>
    web.handle(new Request(`${SHARE_WEB_ORIGIN}/api/named-chat/${path}`, { ...init,
      headers: { host: HOST, origin: SHARE_WEB_ORIGIN, cookie: `${cookieName}=${user}`, "content-type": "application/json", ...init.headers } }));
  return { storage, relay, web, view, chat, grantId, shareId, memberId, planSha, forwarded };
}

it("reads the workspace's files for a member, sending the grant, the account cookie and nothing the page could forge", async () => {
  const f = await fixture();
  const meta = await f.view("/api/view/meta");
  expect(meta.status, await meta.clone().text()).toBe(200);
  expect(await meta.json()).toMatchObject({ access: "comment" });
  const current = await (await f.view("/api/view/current")).json() as { files: Array<{ path: string; blobSha256: string }> };
  expect(current.files).toEqual([expect.objectContaining({ path: "trip/plan.md", blobSha256: f.planSha })]);
  expect((await f.view("/api/view/log?since=0&limit=500&current=true")).status).toBe(200);
  const blob = await f.web.handle(new Request(`${SHARE_WEB_ORIGIN}/api/view/blob/${f.planSha}?session=member.${f.grantId}`,
    { headers: { host: HOST, cookie: `${cookieName}=sam` } }));
  expect(await blob.text()).toBe("# Plan\n\nLeave at nine.");
  for (const sent of f.forwarded) {
    expect(sent.headers.get("authorization")).toBe(`DohcMember ${f.grantId}`);
    expect(sent.headers.get("cookie")).toBe(`${cookieName}=sam`);
    expect(sent.headers.get("origin")).toBe(SHARE_WEB_ORIGIN);
    expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(RELAY_EXCHANGE_KEY);
  }
});

it("refuses another account, a signed-out browser, another site, and a removed member, as it refuses an unknown grant", async () => {
  const f = await fixture();
  const unknown = await f.view("/api/view/meta", "sam", "member.no-such-grant");
  expect(unknown.status).toBe(404);
  const refusal = await unknown.text();
  for (const response of [
    await f.view("/api/view/meta", "someone"),
    await f.web.handle(new Request(`${SHARE_WEB_ORIGIN}/api/view/meta`, { headers: { host: HOST, "x-dohc-link-session": `member.${f.grantId}` } })),
    await f.view("/api/view/meta", "sam", `member.${f.grantId}`, { "sec-fetch-site": "cross-site" }),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(refusal);
  }
  expect((await f.relay(request(OWNER, `/sync/${WORKSPACE}/members/${f.memberId}/remove`, jsonBody({})))).status).toBe(200);
  const removed = await f.view("/api/view/current");
  expect(removed.status).toBe(404);
  expect(await removed.text()).toBe(refusal);
});

it("lists every Group and follows them all in one request, each message naming its Group", async () => {
  const f = await fixture();
  const channels = await f.chat(`channels?grantId=${f.grantId}`);
  expect(channels.status, await channels.clone().text()).toBe(200);
  expect((await channels.json() as { channels: unknown[] }).channels).toEqual([
    { channelWireId: "wire-plans", name: "plans", kind: "channel", access: "read-write" },
    { channelWireId: "wire-food", name: "food", kind: "channel", access: "read-write" },
  ]);
  const follow = await f.chat(`messages?shareId=${f.shareId}&since=0`);
  expect(follow.status, await follow.clone().text()).toBe(200);
  const page = await follow.json() as { messages: Array<{ body: string; channelWireId: string }>; channelWireId?: string };
  expect(page.channelWireId).toBeUndefined();
  expect(page.messages.map(({ body, channelWireId }) => ({ body, channelWireId }))).toEqual([
    { body: "Plans start here", channelWireId: "wire-plans" }, { body: "Bring snacks", channelWireId: "wire-food" },
  ]);
  const posted = await f.chat("messages", "sam", { method: "POST", body: JSON.stringify({ shareId: f.shareId, channelWireId: "wire-food", id: "post-1",
    body: "Count me in", authorKind: "human" }) });
  expect(posted.status, await posted.clone().text()).toBe(200);
});

it("reads one Group's history for a member, newest first, with the cursor that follows every Group", async () => {
  const f = await fixture();
  const history = await f.chat(`messages?shareId=${f.shareId}&channelWireId=wire-food&limit=50`);
  expect(history.status, await history.clone().text()).toBe(200);
  const page = await history.json() as { channelWireId: string; messages: Array<{ body: string }>; nextCursor: number; olderCursor: number | null };
  expect(page.channelWireId).toBe("wire-food");
  expect(page.messages.map(message => message.body)).toEqual(["Bring snacks"]);
  const follow = await (await f.chat(`messages?shareId=${f.shareId}&since=${page.nextCursor}`)).json() as { messages: unknown[] };
  expect(follow.messages).toEqual([]);
});

it("shows a View member every Group read-only and refuses a post", async () => {
  const f = await fixture("view");
  const channels = await (await f.chat(`channels?grantId=${f.grantId}`)).json() as { channels: Array<{ access: string }> };
  expect(channels.channels.map(channel => channel.access)).toEqual(["read-only", "read-only"]);
  const posted = await f.chat("messages", "sam", { method: "POST", body: JSON.stringify({ shareId: f.shareId, channelWireId: "wire-food", id: "post-1",
    body: "Count me in", authorKind: "human" }) });
  expect(posted.status).toBe(403);
});
