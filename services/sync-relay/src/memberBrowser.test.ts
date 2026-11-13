import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import { MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE } from "./namedRecipientChat";
import type { SyncRelayHandler } from "./server";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import type { SyncRelayStorage } from "./storage";
import {
  RELAY_EXCHANGE_KEY,
  SHARE_WEB_ORIGIN,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  json,
  jsonBody,
  logOp,
  putBlob,
  request,
  resetOpSeq,
  resolveTestActor,
  sha256,
  testHandler,
  testStorage,
} from "./testing";

// A member's workspace in a browser: share-web sends the account's cookie
// with its exchange key, and names the grant. The relay finds the person.

afterEach(() => { vi.useRealTimers(); closeTestStorages(); });

const OWNER = "owner";
const WORKSPACE = "workspace-browser";
const GROUP = "wire-team";
const LATER_GROUP = "wire-later";
const DM = "wire-dm";
const AGENT = "wire-agent";
const limits = { maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 8, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 1000 };

let ownerSeq = 0;
const channel = (wireId: string, name: string, kind: "channel" | "dm" | "agent" = "channel") =>
  logOp("chat.channel.create", chatChannelCreate(wireId, {
    channelId: `chan-${wireId}`, name, slug: name, kind, ...(kind === "channel" ? { type: "both", purpose: "", folderPath: name } : {}),
  }).payload);
const thread = (threadId: string, wireId: string) => logOp("chat.thread.create", chatThreadCreate(threadId, wireId, { slug: threadId }).payload);
const message = (messageId: string, threadId: string, body: string) =>
  logOp("chat.message.append", chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER }).payload);

async function ownerAppend(h: SyncRelayHandler, ops: unknown[]) {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })));
  expect(response.status, await response.clone().text()).toBe(200);
}

async function ownerWrite(h: SyncRelayHandler, path: string, text: string) {
  const sha = await putBlob(h, OWNER, WORKSPACE, text);
  const seq = ownerSeq++;
  await ownerAppend(h, [logOp("moment.append", {
    momentId: `m-${seq}`, versionId: "main", objectId: `object-${path}`, path, recordedAtMs: 1000 + seq,
    operation: "write", payloadBeforeBlobSha256: null, payloadBeforePath: null,
    payloadAfterBlobSha256: sha, payloadAfterPath: path, metadata: { origin: "user" }, beforePresent: "null",
  })]);
  return sha;
}

// The cookie names the person, as the account service would. Nothing else does.
function resolveActor(incoming: Request, workspaceId: string) {
  if (incoming.headers.has("cookie")) {
    const match = /^session=(\w+)$/u.exec(incoming.headers.get("cookie") ?? "");
    if (!match) throw new UnauthorizedError();
    return { userId: match[1]!, workspaceId };
  }
  return resolveTestActor(incoming, workspaceId);
}

async function seed(activity = new DiscussionActivityHub()) {
  resetOpSeq();
  ownerSeq = 0;
  const storage = await testStorage();
  const h = testHandler(storage, {
    lookupUserDisplayName: (userId: string) => `Name ${userId}`, discussionActivity: activity,
    namedBrowserSessionLimits: limits, relayExchangeKey: RELAY_EXCHANGE_KEY, resolveActor,
  });
  expect((await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status).toBe(200);
  await ownerAppend(h, [
    channel(GROUP, "team"), thread("t-team", GROUP), message("msg-team", "t-team", "welcome to the team"),
    channel(GENERAL_CHANNEL_WIRE_ID, "general"), thread("t-general", GENERAL_CHANNEL_WIRE_ID), message("msg-general", "t-general", "SENTINEL general"),
    channel(DM, "someone", "dm"), thread("t-dm", DM), message("msg-dm", "t-dm", "SENTINEL direct message"),
    channel(AGENT, "bot", "agent"), thread("t-agent", AGENT), message("msg-agent", "t-agent", "SENTINEL agent chat"),
  ]);
  const planSha = await ownerWrite(h, "docs/plan.md", "the plan");
  return { storage, h, planSha, activity };
}

function post(h: SyncRelayHandler, as: string, path: string, body: Record<string, unknown> = {}) {
  return h(request(as, path, jsonBody(body)));
}

async function member(h: SyncRelayHandler, storage: SyncRelayStorage, userId: string) {
  const invite = await post(h, OWNER, `/sync/${WORKSPACE}/members/invites`, { email: `${userId}@dohc.test`, workspaceName: "Community" });
  expect(invite.status, await invite.clone().text()).toBe(200);
  const memberId = (await json(invite)).memberId as string;
  const shares = await json(await h(request(userId, "/sync/shares")));
  const shareId = (shares.received as Array<Record<string, unknown>>)
    .find(row => (row.selector as { kind?: string }).kind === "workspace")!.shareId as string;
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, userId)[0]!.grantId;
  return { memberId, shareId, grantId };
}

const setLevel = async (h: SyncRelayHandler, level: "view" | "comment" | "edit") =>
  expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level })).status).toBe(200);

function memberRead(h: SyncRelayHandler, path: string, grantId: string, userId: string, init: RequestInit = {}) {
  return h(new Request(`http://relay.test${path}`, { ...init, headers: {
    authorization: `DohcMember ${grantId}`, cookie: `session=${userId}`, origin: SHARE_WEB_ORIGIN,
    "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, "x-dohc-relay-client-ip": "203.0.113.7",
    ...Object.fromEntries(new Headers(init.headers)),
  } }));
}

const refusalBytes = async (response: Response) => `${response.status}:${await response.text()}`;

describe("a member reads the workspace through the link read routes", () => {
  it("reads the workspace's name and files at View, Comment and Edit, and the history only at Edit", async () => {
    const { h, storage, planSha } = await seed();
    const ana = await member(h, storage, "ana");
    for (const level of ["view", "comment", "edit"] as const) {
      await setLevel(h, level);
      const share = await memberRead(h, "/sync/link/share", ana.grantId, "ana");
      expect(share.status, await share.clone().text()).toBe(200);
      expect(await json(share)).toMatchObject({ ok: true, access: level, subjectName: "Community" });
      const current = await memberRead(h, "/sync/link/current", ana.grantId, "ana");
      expect(current.status).toBe(200);
      const body = await json(current);
      expect(body).toMatchObject({ access: level, subjectName: "Community", files: [expect.objectContaining({ path: "docs/plan.md", blobSha256: planSha })] });
      expect(JSON.stringify(body)).not.toContain("SENTINEL");
      const blob = await memberRead(h, `/sync/link/blobs/${planSha}`, ana.grantId, "ana");
      expect(blob.status).toBe(200);
      expect(await blob.text()).toBe("the plan");
      const currentLog = await memberRead(h, "/sync/link/log?since=0&limit=500&current=true", ana.grantId, "ana");
      expect(currentLog.status).toBe(200);
      const log = await memberRead(h, "/sync/link/log?since=0&limit=500", ana.grantId, "ana");
      expect(log.status, level).toBe(level === "edit" ? 200 : 404);
    }
  });

  it("serves files the owner adds after the member joined", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    await ownerWrite(h, "later/new.md", "new work");
    const body = await json(await memberRead(h, "/sync/link/current", ana.grantId, "ana"));
    expect((body.files as Array<{ path: string }>).map(file => file.path)).toEqual(["docs/plan.md", "later/new.md"]);
  });

  it("refuses a removed member, an ended membership, a fenced owner and a forged person with the bytes of an unknown grant", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    const unknown = await refusalBytes(await memberRead(h, "/sync/link/current", "grant-never", "ana"));
    expect(unknown.startsWith("404:")).toBe(true);

    // Another member's cookie with Ana's grant: the person comes from the session.
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ben"))).toBe(unknown);
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "mallory"))).toBe(unknown);
    // A claimed person in the request changes nothing.
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "mallory",
      { headers: { "x-dohc-user-id": "ana", authorization: `DohcMember ${ana.grantId}` } }))).toBe(unknown);
    // No exchange key, no cookie, or a link capability with it.
    for (const headers of [{ "x-dohc-relay-exchange-key": "wrong-key-wrong-key-wrong-key-wrong" }, { cookie: "" }, { "x-dohc-link-profile-secret": "x" }] as Record<string, string>[]) {
      expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ana", { headers })), JSON.stringify(headers)).toBe(unknown);
    }
    // A workspace grant never reads as a link holder.
    expect(await refusalBytes(await h(request(null, "/sync/link/current", { headers: { authorization: `LinkCapability ${ana.grantId}` } })))).toBe(unknown);

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/remove`)).status).toBe(200);
    for (const route of ["/sync/link/share", "/sync/link/current", "/sync/link/log?since=0&limit=500&current=true"]) {
      expect(await refusalBytes(await memberRead(h, route, ben.grantId, "ben")), route).toBe(unknown);
    }

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/end`)).status).toBe(200);
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).toBe(unknown);
  });

  it("refuses a fenced owner's workspace and a fenced member like an unknown grant", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    const unknown = await refusalBytes(await memberRead(h, "/sync/link/current", "grant-never", "ana"));
    const key = "account-deletion-key-at-least-32-bytes";
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, key);
    fenceAccount(context, key, "ben", "ben@dohc.test");
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ben.grantId, "ben"))).toBe(unknown);
    expect((await memberRead(h, "/sync/link/current", ana.grantId, "ana")).status).toBe(200);
    fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).toBe(unknown);
  });

  it("refuses a blob outside the workspace's files", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const unknown = await refusalBytes(await memberRead(h, "/sync/link/current", "grant-never", "ana"));
    expect((await h(request("other", "/sync/workspaces", jsonBody({ workspaceId: "elsewhere" })))).status).toBe(200);
    const elsewhere = await putBlob(h, "other", "elsewhere", "another workspace");
    expect(await refusalBytes(await memberRead(h, `/sync/link/blobs/${elsewhere}`, ana.grantId, "ana"))).toBe(unknown);
    expect(await refusalBytes(await memberRead(h, `/sync/link/blobs/${sha256("never stored")}`, ana.grantId, "ana"))).toBe(unknown);
  });
});

function chat(h: SyncRelayHandler, path: string, userId: string, init: RequestInit = {}) {
  return h(new Request(`http://relay.test/sync/named-chat/${path}`, { ...init, headers: {
    ...Object.fromEntries(new Headers(init.headers)), cookie: `session=${userId}`, origin: SHARE_WEB_ORIGIN,
    "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
  } }));
}

describe("a member's Chats in a browser", () => {
  it("lists every Group the membership reaches, and never General, a direct message or an agent chat", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const listed = await chat(h, `channels?grantId=${ana.grantId}`, "ana");
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await json(listed)).toMatchObject({ shareId: ana.shareId, userId: "ana",
      channels: [{ channelWireId: GROUP, name: "team", kind: "channel", access: "read-write" }] });
    await setLevel(h, "view");
    expect(await json(await chat(h, `channels?grantId=${ana.grantId}`, "ana"))).toMatchObject({
      channels: [{ channelWireId: GROUP, access: "read-only" }] });
    expect((await chat(h, `channels?grantId=${ana.grantId}`, "ben")).status).toBe(404);
  });

  it("follows every reached Group in one request, tags each message with its channel, and picks up a Group created later", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const first = await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana");
    expect(first.status, await first.clone().text()).toBe(200);
    const page = await json(first);
    expect(page).toMatchObject({ shareId: ana.shareId, hasMore: false,
      messages: [expect.objectContaining({ messageId: "msg-team", channelWireId: GROUP })] });
    expect(JSON.stringify(page)).not.toContain("SENTINEL");

    const held = chat(h, `messages?shareId=${ana.shareId}&since=${page.nextCursor}&hold=30000&limit=50`, "ana");
    await ownerAppend(h, [channel(LATER_GROUP, "later"), thread("t-later", LATER_GROUP), message("msg-later", "t-later", "a new group"),
      message("msg-general-2", "t-general", "SENTINEL general again")]);
    const next = await json(await held);
    expect(next.messages).toEqual([expect.objectContaining({ messageId: "msg-later", channelWireId: LATER_GROUP, body: "a new group" })]);
    // One follow covers every Group: a workspace share never follows one by name.
    expect((await chat(h, `messages?shareId=${ana.shareId}&channelWireId=${GROUP}&since=0`, "ana")).status).toBe(404);
  });

  it("ends a held follow when the member is removed", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const page = await json(await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana"));
    const held = chat(h, `messages?shareId=${ana.shareId}&since=${page.nextCursor}&hold=30000&limit=50`, "ana");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/remove`)).status).toBe(200);
    expect((await held).status).toBe(404);
  });

  it("posts in a Group at Comment, and refuses a post at View", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const posted = await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, channelWireId: GROUP, id: "r-1", body: "hello team", authorKind: "human" }));
    expect(posted.status, await posted.clone().text()).toBe(200);
    expect(await json(posted)).toMatchObject({ shareId: ana.shareId, channelWireId: GROUP, message: { body: "hello team", authorUserId: "ana" } });
    for (const wireId of [GENERAL_CHANNEL_WIRE_ID, DM, AGENT]) {
      expect((await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, channelWireId: wireId, id: `r-${wireId}`, body: "x", authorKind: "human" }))).status, wireId).toBe(404);
    }
    await setLevel(h, "view");
    expect((await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, channelWireId: GROUP, id: "r-2", body: "x", authorKind: "human" }))).status).toBe(403);
  });

  it("caps browser follows at 512 per workspace", () => {
    expect(MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE).toBe(512);
  });
});

// A file's Comments are threads whose first create binds the file. The owner's
// desktop and every member read the same threads.
const commentThread = (threadId: string, path: string) => logOp("chat.thread.create", {
  threadId, title: "", createdAtMs: 2, linkedObjectId: `object-${path}`, linkedAtMs: 2, linkedPathHint: path,
});
const comments = (shareId: string, path: string, query: Record<string, string> = {}) =>
  `messages?${new URLSearchParams({ shareId, path, limit: "50", ...query })}`;

async function commented() {
  const seeded = await seed();
  await ownerWrite(seeded.h, "docs/other.md", "another file");
  await ownerAppend(seeded.h, [
    commentThread("c-plan", "docs/plan.md"), message("msg-plan", "c-plan", "Is the hotel near the river?"),
    commentThread("c-other", "docs/other.md"), message("msg-other", "c-other", "SENTINEL another file's comment"),
  ]);
  return seeded;
}

describe("a member's file Comments in a browser", () => {
  it("reads a file's Comments at View, Comment and Edit, and no other file's or Group's", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    for (const level of ["view", "comment", "edit"] as const) {
      await setLevel(h, level);
      const read = await chat(h, comments(ana.shareId, "docs/plan.md"), "ana");
      expect(read.status, await read.clone().text()).toBe(200);
      const page = await json(read);
      expect(page).toMatchObject({ shareId: ana.shareId, path: "docs/plan.md", olderCursor: null,
        messages: [expect.objectContaining({ messageId: "msg-plan", body: "Is the hotel near the river?" })] });
      expect(page.messages).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain("SENTINEL");
    }
  });

  it("follows a file's Comments and wakes for a new one on that file only", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const page = await json(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"));
    const held = chat(h, comments(ana.shareId, "docs/plan.md", { since: String(page.nextCursor), hold: "30000" }), "ana");
    await ownerAppend(h, [message("msg-other-2", "c-other", "SENTINEL still the other file"), message("msg-plan-2", "c-plan", "Yes, five minutes away.")]);
    const next = await held;
    expect(next.status, await next.clone().text()).toBe(200);
    expect(await json(next)).toMatchObject({ shareId: ana.shareId, path: "docs/plan.md", hasMore: false,
      messages: [expect.objectContaining({ messageId: "msg-plan-2", body: "Yes, five minutes away." })] });
  });

  it("posts a Comment on the file at Comment and Edit that the owner reads on the file, and refuses one at View", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    for (const level of ["comment", "edit"] as const) {
      await setLevel(h, level);
      const posted = await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, path: "docs/plan.md", id: `r-${level}`, body: `from ${level}`, authorKind: "human" }));
      expect(posted.status, await posted.clone().text()).toBe(200);
      expect(await json(posted)).toMatchObject({ shareId: ana.shareId, path: "docs/plan.md", message: { body: `from ${level}`, authorUserId: "ana", authorDisplayName: "Name ana" } });
    }
    // The owner's log binds each new thread to the file's object, as the desktop's own Comments do.
    const log = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=500`)));
    const ops = (log.ops as Array<{ opKind: string; payload?: Record<string, unknown>; payloadJson?: string }>)
      .map(op => ({ opKind: op.opKind, payload: op.payload ?? JSON.parse(op.payloadJson ?? "{}") as Record<string, unknown> }));
    const post = ops.find(op => op.opKind === "chat.message.append" && op.payload.body === "from comment")!;
    expect(ops.find(op => op.opKind === "chat.thread.create" && op.payload.threadId === post.payload.threadId)?.payload)
      .toMatchObject({ linkedObjectId: "object-docs/plan.md" });
    const read = await json(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"));
    expect((read.messages as Array<{ body: string }>).map(item => item.body)).toEqual(["from edit", "from comment", "Is the hotel near the river?"]);
    // A reply joins a thread on this file.
    const reply = await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, path: "docs/plan.md", id: "r-reply", threadId: "c-plan", body: "thanks", authorKind: "human" }));
    expect(reply.status, await reply.clone().text()).toBe(200);
    expect(await json(reply)).toMatchObject({ message: { threadId: "c-plan", body: "thanks" } });

    await setLevel(h, "view");
    const refused = await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, path: "docs/plan.md", id: "r-view", body: "x", authorKind: "human" }));
    expect(refused.status).toBe(403);
  });

  it("refuses a removed member, an ended membership, a fenced owner, a forged person and a path outside reach like an unknown share", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    const read = (shareId: string, userId: string, path = "docs/plan.md") => chat(h, comments(shareId, path), userId);
    const write = (shareId: string, userId: string, fields: Record<string, unknown> = {}) =>
      chat(h, "messages", userId, jsonBody({ shareId, path: "docs/plan.md", id: "r-refused", body: "x", authorKind: "human", ...fields }));
    const unknown = await refusalBytes(await read("share-never", "ana"));
    expect(unknown.startsWith("404:")).toBe(true);
    expect(await refusalBytes(await write("share-never", "ana"))).toBe(unknown);

    // The person comes from the session: a stranger's cookie with Ana's share, or a claimed author.
    expect(await refusalBytes(await read(ana.shareId, "mallory"))).toBe(unknown);
    expect(await refusalBytes(await write(ana.shareId, "mallory"))).toBe(unknown);
    expect((await write(ana.shareId, "ana", { authorUserId: "ben" })).status).not.toBe(200);
    // A path the workspace share does not reach: a missing file, a secret, another file's thread, a Group's thread.
    for (const path of ["docs/missing.md", ".env", "../docs/plan.md"]) {
      expect(await refusalBytes(await read(ana.shareId, "ana", path)), path).toBe(unknown);
      expect(await refusalBytes(await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, path, id: `r-${path}`, body: "x", authorKind: "human" }))), path).toBe(unknown);
    }
    for (const threadId of ["c-other", "t-team"]) {
      expect(await refusalBytes(await write(ana.shareId, "ana", { threadId })), threadId).toBe(unknown);
    }
    // A path and a Group together name nothing.
    expect(await refusalBytes(await chat(h, comments(ana.shareId, "docs/plan.md", { channelWireId: GROUP }), "ana"))).toBe(unknown);

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/remove`)).status).toBe(200);
    expect(await refusalBytes(await read(ben.shareId, "ben"))).toBe(unknown);
    expect(await refusalBytes(await write(ben.shareId, "ben"))).toBe(unknown);

    const key = "account-deletion-key-at-least-32-bytes";
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, key);
    fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    expect(await refusalBytes(await read(ana.shareId, "ana"))).toBe(unknown);
    expect(await refusalBytes(await write(ana.shareId, "ana"))).toBe(unknown);
  });

  it("refuses an ended membership like an unknown share", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const unknown = await refusalBytes(await chat(h, comments("share-never", "docs/plan.md"), "ana"));
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/end`)).status).toBe(200);
    expect(await refusalBytes(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"))).toBe(unknown);
    expect(await refusalBytes(await chat(h, "messages", "ana", jsonBody({ shareId: ana.shareId, path: "docs/plan.md", id: "r-ended", body: "x", authorKind: "human" })))).toBe(unknown);
  });

  it("ends a held Comments follow when the member is removed", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const page = await json(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"));
    const held = chat(h, comments(ana.shareId, "docs/plan.md", { since: String(page.nextCursor), hold: "30000" }), "ana");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/remove`)).status).toBe(200);
    expect((await held).status).toBe(404);
  });
});
