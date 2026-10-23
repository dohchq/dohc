import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { DiscussionActivityHub } from "./discussionActivity";
import { MAX_LINK_CHAT_FOLLOWS_PER_GRANT } from "./linkChatRoutes";
import { MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE } from "./namedRecipientChat";
import { authorizeLinkChatAction, authorizeLinkShareAction } from "./shareAuthorization";
import { hashLinkProfileSecret } from "./linkSecurity";
import { LINK_CHAT_MESSAGE_ID_PREFIX, LINK_CHAT_ORIGIN_PREFIX, LINK_CHAT_THREAD_ID_PREFIX } from "./relayLogInputs";
import type { OpenSyncRelayStorageOptions, SyncRelayStorage } from "./storage";
import {
  LINK_KEY,
  RELAY_EXCHANGE_KEY,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  inspectDatabase,
  json,
  jsonBody,
  linkRequest,
  linkSecret,
  moment,
  putBlob,
  request,
  sequenced,
  storagePath,
  testHandler,
  testStorage,
  type ChatOp,
  type HandlerOverrides,
} from "./testing";

const OWNER = "acct-owner-7f3a";
const MEMBER = "acct-member-91c2";
const workspaceId = "workspace-link-chat";
const channelWireId = "wire-team";
const namedBrowserSessionLimits = {
  maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000,
};
const released: HandlerOverrides = { publicEditRelease: { version: 1 }, relayExchangeKey: RELAY_EXCHANGE_KEY, namedBrowserSessionLimits };

afterEach(() => {
  vi.restoreAllMocks();
  closeTestStorages();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function appendOwnerOps(storage: SyncRelayStorage, originId: string, ops: ChatOp[]) {
  storage.appendLogBatch({
    workspaceId, originId,
    ops: sequenced(ops).map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })),
  });
}

async function fixture(overrides: HandlerOverrides = released, activity = new DiscussionActivityHub(), options?: OpenSyncRelayStorageOptions) {
  const storage = await testStorage(options);
  storage.claimWorkspace({ workspaceId, ownerUserId: OWNER, createdAtMs: 1 });
  appendOwnerOps(storage, "owner", [
    chatChannelCreate(channelWireId, { name: "Team", type: "both", folderPath: "team" }),
    chatThreadCreate("thread-team", channelWireId),
    chatMessageAppend("owner-first", "thread-team", "welcome", { authorUserId: OWNER, authorDisplayName: "Ada" }),
    chatMessageAppend("agent-reply", "thread-team", "on it", {
      authorUserId: OWNER, authorKind: "agent", authorDisplayName: "Planner", authorOwnerDisplayName: "Ada",
    }),
    { opKind: "chat.reaction.set", payload: {
      reactionId: "reaction-1", messageId: "owner-first", threadId: "thread-team", emoji: "🎉",
      authorId: MEMBER, authorKind: "human", authorDisplayName: "Member", state: "set", atMs: 4,
    } },
    { opKind: "chat.attachment.add", payload: {
      attachmentId: "attachment-1", threadId: "thread-team", messageId: "owner-first", targetKind: "file", createdAtMs: 4,
    } },
    chatChannelCreate("wire-private", { name: "Private" }),
    chatThreadCreate("thread-private", "wire-private"),
    chatMessageAppend("private", "thread-private", "SENTINEL", { authorUserId: OWNER }),
  ]);
  const h = testHandler(storage, { discussionActivity: activity, ...overrides });
  const created = await h(request(OWNER, `/sync/${workspaceId}/shares`, jsonBody({
    recipientUserId: MEMBER, channelWireId, paths: ["team"], access: "read-write", subjectName: "Team",
  })));
  expect(created.status, await created.clone().text()).toBe(200);
  const shareId = String((await json(created)).shareId);
  return { storage, h, activity, shareId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function createLink(f: Fixture, access: string, shareId = f.shareId) {
  return f.h(request(OWNER, `/sync/${workspaceId}/shares/${shareId}/links`, jsonBody({ access })));
}

function exchange(f: Fixture, secret: string) {
  return f.h(request(null, "/sync/link-exchange", {
    ...jsonBody({ secret }),
    headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY },
  }));
}

async function groupLink(f: Fixture, access: "read-only" | "read-write" = "read-only") {
  const created = await createLink(f, access);
  expect(created.status, await created.clone().text()).toBe(200);
  const link = await json(created);
  const secret = linkSecret(link.url);
  const exchanged = await exchange(f, secret);
  expect(exchanged.status).toBe(200);
  return { grantId: String(link.grantId), secret, exchanged: await json(exchanged) };
}

function readChat(f: Fixture, capability: string, path: string, init: RequestInit = {}) {
  return f.h(linkRequest(capability, `/sync/link/chat/${path}`, init));
}

const history = `messages?channelWireId=${channelWireId}`;

function retune(f: Fixture, grantId: string, access: string, shareId = f.shareId) {
  return f.h(request(OWNER, `/sync/shares/${shareId}/links/${grantId}/retune`, jsonBody({
    workspaceId, access, expectedDependentGrantIds: [],
  })));
}

// A follow from the latest message, returned once it is waiting for the next.
async function parkFollow(f: Fixture, capability: string) {
  const latest = (await json(await readChat(f, capability, history))).nextCursor;
  const entered = deferred(), wait = f.activity.wait.bind(f.activity);
  const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    const pending = wait(group, actor, options);
    entered.resolve();
    return pending;
  });
  const poll = readChat(f, capability, `${history}&since=${String(latest)}&hold=30000`);
  await entered.promise;
  spy.mockRestore();
  expect(f.activity.stats().waiters).toBe(1);
  return { poll };
}

function setChannelKind(storage: SyncRelayStorage, kind: string) {
  const db = inspectDatabase(storagePath(storage));
  try {
    db.prepare(`UPDATE sync_relay_log SET payload_json = json_set(payload_json, '$.kind', ?)
      WHERE workspace_id = ? AND op_kind = 'chat.channel.create' AND json_extract(payload_json, '$.wireId') = ?`)
      .run(kind, workspaceId, channelWireId);
  } finally {
    db.close();
  }
}

describe("link chat on a Group share", () => {
  it.each(["read-only", "read-write"] as const)("lets a %s link read the Group's channel", async (access) => {
    const f = await fixture();
    const link = await groupLink(f, access);
    expect(link.exchanged).toMatchObject({ shareId: f.shareId, access: access === "read-write" ? "edit" : "view" });
    const capability = String(link.exchanged.capabilityToken);

    const channels = await readChat(f, capability, "channels");
    expect(channels.status).toBe(200);
    expect(channels.headers.get("cache-control")).toBe("private, no-store");
    expect(await json(channels)).toEqual({ shareId: f.shareId, profileName: null, channels: [{ channelWireId, name: "Team", access }] });
    // A Group link's share answer names its channel, so an agent needs no second call to find it,
    // and so does its files' answer, which the viewer opens with.
    expect(await json(await f.h(linkRequest(capability, "/sync/link/share")))).toMatchObject({ channel: { channelWireId, access } });
    expect(await json(await f.h(linkRequest(capability, "/sync/link/current")))).toMatchObject({ channel: { channelWireId, access } });

    const page = await json(await readChat(f, capability, history));
    expect(page.messages).toEqual([
      expect.objectContaining({ messageId: "agent-reply", authorKind: "agent", authorDisplayName: "Planner", authorOwnerDisplayName: "Ada", body: "on it" }),
      expect.objectContaining({ messageId: "owner-first", authorKind: "human", authorDisplayName: "Ada", body: "welcome" }),
    ]);
    const followed = await json(await readChat(f, capability, `${history}&since=${String(page.nextCursor)}`));
    expect(followed).toMatchObject({ messages: [], nextCursor: page.nextCursor, hasMore: false });
  });

  it("projects no account ID, member, other channel, reaction, or attachment", async () => {
    const f = await fixture();
    const capability = String((await groupLink(f)).exchanged.capabilityToken);
    const channels = await (await readChat(f, capability, "channels")).text();
    const page = await (await readChat(f, capability, history)).text();
    const followed = await (await readChat(f, capability, `${history}&since=0`)).text();
    for (const body of [channels, page, followed]) {
      for (const secret of [OWNER, MEMBER, "authorUserId", "SENTINEL", "wire-private", "reaction-1", "🎉", "attachment-1"]) {
        expect(body).not.toContain(secret);
      }
    }
    for (const message of (JSON.parse(page) as { messages: Record<string, unknown>[] }).messages) {
      expect(Object.keys(message).sort()).toEqual([
        "authorDisplayName", "authorKind", "authorOwnerDisplayName", "body", "bodyTooLarge", "createdAtMs", "messageId", "relaySeq", "threadId",
      ]);
    }
    expect((await readChat(f, capability, history.replace(channelWireId, "wire-private"))).status).toBe(404);
    expect((await readChat(f, capability, `channels?shareId=${f.shareId}`)).status).toBe(400);
  });

  it("creates read-write Group links only where Edit links are released", async () => {
    const f = await fixture({ relayExchangeKey: RELAY_EXCHANGE_KEY });
    const refused = await createLink(f, "read-write");
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ code: "invalid_access" });
    expect((await createLink(f, "read-only")).status).toBe(200);
    for (const access of ["view", "comment", "edit", 42]) {
      expect((await createLink(f, access as string)).status, String(access)).toBe(400);
    }
    expect((await f.h(request(MEMBER, `/sync/${workspaceId}/shares/${f.shareId}/links`, jsonBody({ access: "read-only" })))).status).toBe(404);
  });

  it.each(["dm", "agent"])("refuses a Group link once its channel is a %s channel", async (kind) => {
    const f = await fixture();
    const link = await groupLink(f);
    const capability = String(link.exchanged.capabilityToken);
    setChannelKind(f.storage, kind);
    expect((await createLink(f, "read-only")).status).toBe(404);
    expect((await exchange(f, link.secret)).status).toBe(404);
    for (const path of ["channels", history]) expect((await readChat(f, capability, path)).status, path).toBe(404);
    expect((await f.h(linkRequest(capability, "/sync/link/share"))).status).toBe(404);
    expect(authorizeLinkChatAction({ storage: f.storage, grantId: link.grantId, action: "read" })).toEqual({ ok: false, reason: "gauntlet" });
  });

  it.each(["rotate", "revoke"] as const)("refuses a link after %s and ends its open long-poll", async (change) => {
    const f = await fixture();
    const link = await groupLink(f);
    const capability = String(link.exchanged.capabilityToken);
    const { poll } = await parkFollow(f, capability);

    const changed = await f.h(request(OWNER, change === "rotate"
      ? `/sync/shares/${f.shareId}/links/${link.grantId}/rotate`
      : `/sync/shares/${f.shareId}/revoke`, jsonBody({
      workspaceId, expectedDependentGrantIds: [], ...(change === "revoke" ? { grantId: link.grantId } : {}),
    })));
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect((await poll).status).toBe(404);
    expect(f.activity.stats().waiters).toBe(0);
    for (const path of ["channels", history]) expect((await readChat(f, capability, path)).status, path).toBe(404);
    expect((await exchange(f, link.secret)).status).toBe(404);
    if (change === "rotate") {
      const rotated = await exchange(f, linkSecret((await json(changed)).url));
      expect(rotated.status).toBe(200);
      const fresh = String((await json(rotated)).capabilityToken);
      expect((await readChat(f, fresh, "channels")).status).toBe(200);
    }
  });

  it("lowers a read-write link to read-only on the same credential, and its open long-poll still reads", async () => {
    const f = await fixture();
    const link = await groupLink(f, "read-write");
    const capability = String(link.exchanged.capabilityToken);
    const credential = f.storage.getCurrentLinkCredential(link.grantId);
    const { poll } = await parkFollow(f, capability);

    const lowered = await retune(f, link.grantId, "read-only");
    expect(lowered.status, await lowered.clone().text()).toBe(200);
    const body = await json(lowered);
    expect(body).toMatchObject({ grantId: link.grantId, access: "read-only", generation: 1 });
    expect(body).not.toHaveProperty("url");
    expect(f.storage.getCurrentLinkCredential(link.grantId)).toEqual(credential);

    appendOwnerOps(f.storage, "owner-later", [
      chatMessageAppend("owner-later", "thread-team", "still here", { authorUserId: OWNER, authorDisplayName: "Ada" }),
    ]);
    f.activity.wakeLog(workspaceId);
    const followed = await poll;
    expect(followed.status).toBe(200);
    expect((await json(followed)).messages).toEqual([expect.objectContaining({ messageId: "owner-later", body: "still here" })]);
    expect(await json(await readChat(f, capability, "channels"))).toMatchObject({ channels: [{ access: "read-only" }] });
    expect(authorizeLinkChatAction({ storage: f.storage, grantId: link.grantId, action: "append" })).toMatchObject({ ok: false });
    expect(authorizeLinkShareAction({ storage: f.storage, grantId: link.grantId, action: "direct-write" })).toMatchObject({ ok: false });
    expect(await json(await exchange(f, link.secret))).toMatchObject({ access: "view", generation: 1 });
  });

  it("raises a read-only link to read-write on a new credential and ends its open long-poll", async () => {
    const f = await fixture();
    const link = await groupLink(f);
    const capability = String(link.exchanged.capabilityToken);
    const { poll } = await parkFollow(f, capability);

    const raised = await retune(f, link.grantId, "read-write");
    expect(raised.status, await raised.clone().text()).toBe(200);
    const body = await json(raised);
    expect(body).toMatchObject({ grantId: link.grantId, access: "read-write", generation: 2 });
    expect((await poll).status).toBe(404);
    expect(f.activity.stats().waiters).toBe(0);
    for (const path of ["channels", history]) expect((await readChat(f, capability, path)).status, path).toBe(404);
    expect((await exchange(f, link.secret)).status).toBe(404);

    const rotated = await exchange(f, linkSecret(body.url));
    expect(rotated.status).toBe(200);
    const fresh = await json(rotated);
    expect(fresh).toMatchObject({ access: "edit", generation: 2 });
    expect(await json(await readChat(f, String(fresh.capabilityToken), "channels"))).toMatchObject({ channels: [{ access: "read-write" }] });
  });

  it("raises a link to read-write only where Edit links are released", async () => {
    const f = await fixture({ relayExchangeKey: RELAY_EXCHANGE_KEY });
    const link = await groupLink(f);
    const before = f.storage.getShareGrant(link.grantId);
    const refused = await retune(f, link.grantId, "read-write");
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ code: "invalid_access" });
    expect(f.storage.getShareGrant(link.grantId)).toEqual(before);
  });

  it("keeps Group and file levels apart", async () => {
    const f = await fixture();
    const link = await groupLink(f, "read-write");
    const fileCreated = await json(await f.h(request(OWNER, `/sync/${workspaceId}/shares/links`, jsonBody({ paths: ["team"], access: "comment" }))));
    const fileLink = { shareId: String(fileCreated.shareId), grantId: String(fileCreated.grantId) };
    const before = [f.storage.getShareGrant(link.grantId), f.storage.getShareGrant(fileLink.grantId)];

    for (const access of ["view", "comment", "edit"]) {
      const refused = await retune(f, link.grantId, access);
      expect(refused.status, access).toBe(400);
      expect(await json(refused)).toMatchObject({ code: "invalid_access" });
    }
    for (const access of ["read-only", "read-write"]) {
      expect((await retune(f, fileLink.grantId, access, fileLink.shareId)).status, access).toBe(400);
    }

    const mintCredential = vi.fn(() => ({ credentialId: "mixed-replacement", secretHash: "h".repeat(64) }));
    const input = { changedAtMs: 3000, expectedDependentGrantIds: [], guard: () => undefined };
    expect(f.storage.retuneShareGrant({ ...input, shareId: f.shareId, grantId: link.grantId, access: "view" })).toEqual({ ok: false });
    expect(f.storage.retuneShareGrant({ ...input, shareId: f.shareId, grantId: link.grantId, access: "edit", mintCredential })).toEqual({ ok: false });
    expect(f.storage.retuneShareGrant({ ...input, ...fileLink, access: "read-only" })).toEqual({ ok: false });
    expect(f.storage.retuneShareGrant({ ...input, ...fileLink, access: "read-write", mintCredential })).toEqual({ ok: false });
    expect(mintCredential).not.toHaveBeenCalled();
    expect([f.storage.getShareGrant(link.grantId), f.storage.getShareGrant(fileLink.grantId)]).toEqual(before);
  });

  it("refuses to retune a Group link holding a file level before storage runs", async () => {
    const f = await fixture();
    const grantId = "group-link-file-level";
    expect(f.storage.createLinkGrant({
      grant: { grantId, shareId: f.shareId, principalKind: "link", principalUserId: null, principalEmail: null,
        access: "view", generation: 1, status: "active", createdAtMs: 2, revokedAtMs: null, parentGrantId: null },
      credential: { credentialId: "group-link-file-level-credential", grantId, secretHash: "s".repeat(64),
        generation: 1, mintedAtMs: 2, retiredAtMs: null },
    })).toBe(true);
    const retuneShareGrant = vi.spyOn(f.storage, "retuneShareGrant");
    const refused = await retune(f, grantId, "read-only");
    expect(refused.status).toBe(404);
    expect(retuneShareGrant).not.toHaveBeenCalled();
    expect(f.storage.getShareGrant(grantId)).toMatchObject({ access: "view", generation: 1 });
  });

  it("caps link follows per link and per workspace", async () => {
    const f = await fixture();
    const linkCount = MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE / MAX_LINK_CHAT_FOLLOWS_PER_GRANT;
    const capabilities: string[] = [];
    for (let index = 0; index <= linkCount; index++) capabilities.push(String((await groupLink(f)).exchanged.capabilityToken));
    const latest = String((await json(await readChat(f, capabilities[0]!, history))).nextCursor);
    const follow = `${history}&since=${latest}&hold=30000`;
    const controllers: AbortController[] = [], polls: Promise<Response>[] = [];
    const park = async (capability: string) => {
      const controller = new AbortController(), entered = deferred(), wait = f.activity.wait.bind(f.activity);
      controllers.push(controller);
      const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
        const pending = wait(group, actor, options);
        entered.resolve();
        return pending;
      });
      const poll = readChat(f, capability, follow, { signal: controller.signal });
      polls.push(poll);
      const parked = await Promise.race([entered.promise.then(() => true), poll.then(() => false)]);
      spy.mockRestore();
      expect(parked).toBe(true);
    };
    const expectRefused = async (capability: string) => {
      // Without a hold, so a follow the cap missed answers at once.
      const overflow = await readChat(f, capability, `${history}&since=${latest}`);
      expect(overflow.status).toBe(429);
      expect(await json(overflow)).toMatchObject({ code: "link_read_rate_limited" });
    };
    try {
      for (let index = 0; index < MAX_LINK_CHAT_FOLLOWS_PER_GRANT; index++) await park(capabilities[0]!);
      await expectRefused(capabilities[0]!);
      // One link at its cap leaves the other links theirs, up to the workspace's.
      for (const capability of capabilities.slice(1, linkCount)) {
        for (let index = 0; index < MAX_LINK_CHAT_FOLLOWS_PER_GRANT; index++) await park(capability);
      }
      expect(f.activity.stats().waiters).toBe(MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE);
      await expectRefused(capabilities[linkCount]!);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(polls);
    }
    expect(f.activity.stats().waiters).toBe(0);
    expect((await readChat(f, capabilities[0]!, `${history}&since=${latest}`)).status).toBe(200);
  });

  it("keeps file-only callers on the Group's folder and away from its channel", async () => {
    const f = await fixture();
    for (const content of ["notes", "private"]) await putBlob(f.h, OWNER, workspaceId, content);
    appendOwnerOps(f.storage, "owner-files", [moment("team/notes.md", "notes"), moment("elsewhere.md", "private")]);
    const link = await groupLink(f, "read-write");
    const capability = String(link.exchanged.capabilityToken);
    const log = await json(await f.h(linkRequest(capability, "/sync/link/log?since=0&limit=100")));
    const kinds = (log.ops as Array<{ opKind: string }>).map((op) => op.opKind);
    expect(kinds).toContain("moment.append");
    expect(kinds.filter((kind) => kind.startsWith("chat."))).toEqual([]);
    expect(JSON.stringify(log)).not.toContain("elsewhere.md");
    expect((await f.h(linkRequest(capability, "/sync/link-handoff", { method: "POST", headers: { "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY } }))).status).toBe(404);

    const files = authorizeLinkShareAction({ storage: f.storage, grantId: link.grantId, action: "read" });
    expect(files).toMatchObject({ ok: true, effectiveSelector: { paths: ["team"], versionId: null, access: "edit" } });
    expect(authorizeLinkShareAction({ storage: f.storage, grantId: link.grantId, action: "live-edit" })).toEqual({ ok: false, reason: "gauntlet" });
    expect(authorizeLinkChatAction({ storage: f.storage, grantId: link.grantId, action: "append" })).toMatchObject({ ok: true });

    const fileShare = await f.h(request(OWNER, `/sync/${workspaceId}/shares/links`, jsonBody({ paths: ["team"], access: "view" })));
    expect(fileShare.status).toBe(200);
    const fileLink = await json(fileShare);
    const fileCapability = String((await json(await exchange(f, linkSecret(fileLink.url)))).capabilityToken);
    for (const path of ["channels", history]) expect((await readChat(f, fileCapability, path)).status, path).toBe(404);
    expect(await json(await f.h(linkRequest(fileCapability, "/sync/link/share")))).not.toHaveProperty("channel");
    expect(await json(await f.h(linkRequest(fileCapability, "/sync/link/current")))).not.toHaveProperty("channel");
    expect(authorizeLinkChatAction({ storage: f.storage, grantId: String(fileLink.grantId), action: "read" })).toEqual({ ok: false, reason: "gauntlet" });
  });
});

const PROFILE_A = "p".repeat(43);
const PROFILE_B = "q".repeat(43);
const PROFILE_C = "r".repeat(43);

function postChat(f: Fixture, capability: string, fields: Record<string, unknown> = {}, profile: string | null = PROFILE_A,
  headers: Record<string, string> = {}) {
  return f.h(linkRequest(capability, "/sync/link/chat/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...(profile === null ? {} : { "x-dohc-link-profile-secret": profile }), ...headers },
    body: JSON.stringify({ channelWireId, idempotencyKey: "post-1", body: "hello from a link", ...fields }),
  }));
}

type ServedOp = { originId: string; opKind: string; payload: Record<string, unknown> };

async function ownerLog(f: Fixture): Promise<ServedOp[]> {
  const page = await f.h(request(OWNER, `/sync/${workspaceId}/log?since=0`));
  expect(page.status).toBe(200);
  return (await json(page)).ops as ServedOp[];
}

const linkOps = (ops: ServedOp[]) => ops.filter((op) => op.originId.startsWith(LINK_CHAT_ORIGIN_PREFIX));

function principalOf(f: Fixture, grantId: string, profile = PROFILE_A) {
  return f.storage.getLinkPrincipalForGrantProfile(grantId, hashLinkProfileSecret(profile, LINK_KEY));
}

async function readWriteLink(f: Fixture) {
  const link = await groupLink(f, "read-write");
  return { ...link, capability: String(link.exchanged.capabilityToken) };
}

async function expectRefused(response: Response, status: number, code?: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  if (code !== undefined) expect(await json(response)).toMatchObject({ code });
}

describe("link posts in a Group's channel", () => {
  it("posts from a read-write link as its link principal, with no account", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    const posted = await postChat(f, link.capability, { body: "hello from a link\r\n", claimedName: "Sam" });
    expect(posted.status, await posted.clone().text()).toBe(200);
    expect(posted.headers.get("cache-control")).toBe("private, no-store");
    const { message } = await json(posted) as { message: Record<string, unknown> };
    expect(message).toMatchObject({ authorKind: "link", authorDisplayName: "Sam", authorOwnerDisplayName: null,
      body: "hello from a link", createdAtMs: 2_000 });
    expect(message).not.toHaveProperty("authorUserId");

    // The owner's device replays exactly this shape: the link, its
    // principal and the name it chose, and nothing that names an account.
    const principal = principalOf(f, link.grantId)!;
    expect(principal.displayName).toBe("Sam");
    const ops = linkOps(await ownerLog(f));
    expect(ops.map((op) => [op.originId, op.opKind])).toEqual([
      [`${LINK_CHAT_ORIGIN_PREFIX}${principal.principalId}`, "chat.thread.create"],
      [`${LINK_CHAT_ORIGIN_PREFIX}${principal.principalId}`, "chat.message.append"],
    ]);
    expect(ops[0]!.payload).toEqual({ threadId: message.threadId, title: "", channelWireId, lane: "chat", createdAtMs: 2_000 });
    expect(ops[1]!.payload).toEqual({
      messageId: message.messageId, threadId: message.threadId, body: "hello from a link", authorKind: "link",
      authorDisplayName: "Sam", linkGrantId: link.grantId, linkPrincipalId: principal.principalId, createdAtMs: 2_000,
    });

    // A retry answers the first post; the same key with another body conflicts.
    const retried = await postChat(f, link.capability, { body: "hello from a link", claimedName: "Sam" });
    expect(retried.status).toBe(200);
    expect((await json(retried)).message).toMatchObject({ messageId: message.messageId });
    await expectRefused(await postChat(f, link.capability, { body: "something else" }), 409, "conflict");

    // A reply in the thread keeps the name the link holder set once.
    const reply = await postChat(f, link.capability, { idempotencyKey: "post-2", threadId: message.threadId, body: "and again" });
    expect(reply.status).toBe(200);
    expect((await json(reply)).message).toMatchObject({ threadId: message.threadId, authorDisplayName: "Sam" });
    await expectRefused(await postChat(f, link.capability, { idempotencyKey: "post-3", claimedName: "Other" }), 409, "link_name_already_set");
    expect(linkOps(await ownerLog(f)).map((op) => op.opKind)).toEqual(["chat.thread.create", "chat.message.append", "chat.message.append"]);

    const page = await json(await readChat(f, link.capability, history));
    expect(page.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: message.messageId, authorKind: "link", authorDisplayName: "Sam", body: "hello from a link" }),
    ]));
  });

  it("names a link holder without a name Anonymous", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    expect((await json(await postChat(f, link.capability))).message).toMatchObject({ authorDisplayName: "Anonymous" });
    expect(principalOf(f, link.grantId)?.displayName).toBeNull();
  });

  it("reaches named recipients with its link, and starts nothing", async () => {
    const activity = new DiscussionActivityHub();
    const f = await fixture(released, activity);
    const link = await readWriteLink(f);
    const wakeLog = vi.spyOn(activity, "wakeLog");
    expect((await postChat(f, link.capability)).status).toBe(200);
    expect(wakeLog).toHaveBeenCalledWith(workspaceId);
    const stored = linkOps(await ownerLog(f))[1]!;

    // The named recipient's Group lane serves the post as the owner holds
    // it, so their desktop replays it as a link post.
    const pulled = await f.h(request(MEMBER, `/sync/shares/${f.shareId}/log?channelWireId=${channelWireId}&since=0`));
    expect(pulled.status, await pulled.clone().text()).toBe(200);
    const served = ((await json(pulled)).ops as ServedOp[]).filter((op) => op.payload.messageId === stored.payload.messageId);
    expect(served.map((op) => op.payload)).toEqual([stored.payload]);

    // Nothing on the relay wakes for it: no notice, no automation wake.
    expect(f.storage.readNoticeChanges({ recipientUserId: OWNER, cursor: null, limit: 200, nowMs: 2_000 }).notices).toEqual([]);
    expect(f.storage.readNoticeChanges({ recipientUserId: MEMBER, cursor: null, limit: 200, nowMs: 2_000 }).notices).toEqual([]);
  });

  it("refuses a read-only link, including a link lowered to read-only", async () => {
    const f = await fixture();
    const readOnly = await groupLink(f, "read-only");
    await expectRefused(await postChat(f, String(readOnly.exchanged.capabilityToken)), 403, "link_view_access");
    expect(principalOf(f, readOnly.grantId)).toBeNull();

    const link = await readWriteLink(f);
    expect((await retune(f, link.grantId, "read-only")).status).toBe(200);
    await expectRefused(await postChat(f, link.capability), 403, "link_view_access");
    expect(principalOf(f, link.grantId)).toBeNull();
    expect(linkOps(await ownerLog(f))).toEqual([]);
  });

  it("takes only a body, a thread of the channel, a name and a retry key", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    for (const [fields, status] of [
      [{ authorKind: "link" }, 400], [{ linkGrantId: link.grantId }, 400], [{ linkPrincipalId: "principal" }, 400],
      [{ authorUserId: OWNER }, 400], [{ authorDisplayName: "Ada" }, 400], [{ messageId: "message" }, 400],
      [{ createdAtMs: 1 }, 400], [{ shareId: f.shareId }, 400], [{ threadId: "thread-private" }, 400],
      [{ threadId: "thread-unknown" }, 400], [{ channelWireId: "wire-private" }, 404], [{ body: " \n" }, 400],
      [{ body: 42 }, 400], [{ idempotencyKey: "" }, 400], [{ claimedName: " " }, 400],
    ] as const) {
      expect((await postChat(f, link.capability, fields)).status, JSON.stringify(fields)).toBe(status);
    }
    expect((await postChat(f, link.capability, {}, null)).status).toBe(404);
    expect((await postChat(f, link.capability, {}, PROFILE_A, { cookie: "session=owner" })).status).toBe(404);
    expect(linkOps(await ownerLog(f))).toEqual([]);
    expect(principalOf(f, link.grantId)).toBeNull();
  });

  it("refuses a body over 8,000 bytes", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    expect((await postChat(f, link.capability, { body: "é".repeat(4_000) })).status).toBe(200);
    await expectRefused(await postChat(f, link.capability, { idempotencyKey: "post-2", body: `${"é".repeat(4_000)}a` }), 400);
    expect(linkOps(await ownerLog(f))).toHaveLength(2);
  });

  it("refuses a blocked link principal and a paused share", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    expect((await postChat(f, link.capability)).status).toBe(200);
    const principal = principalOf(f, link.grantId)!;
    expect(f.storage.setLinkPrincipalBlocked({
      shareId: f.shareId, workspaceId, principalId: principal.principalId, actorUserId: OWNER, blockedAtMs: 2_500,
    })).toBe(true);
    await expectRefused(await postChat(f, link.capability, { idempotencyKey: "post-2" }), 403, "link_discussion_blocked");

    // Another browser on the link posts until the owner pauses the share.
    const other = String((await json(await exchange(f, link.secret))).capabilityToken);
    expect((await postChat(f, other, {}, PROFILE_B)).status).toBe(200);
    expect(f.storage.setShareLinkWritesPaused({ shareId: f.shareId, workspaceId, actorUserId: OWNER, pausedAtMs: 2_500 })).toBe(true);
    await expectRefused(await postChat(f, other, { idempotencyKey: "post-2" }, PROFILE_B), 403, "link_discussion_paused");
    expect(linkOps(await ownerLog(f)).filter((op) => op.opKind === "chat.message.append")).toHaveLength(2);
  });

  it("refuses posts past each limit inside the write, and keeps nothing it refused", async () => {
    let clock = 2_000;
    const f = await fixture({ ...released, nowMs: () => clock }, new DiscussionActivityHub(), {
      discussionMessageRateLimit: 2, discussionLifetimeMessageLimit: 3, discussionNonOwnerShareRowLimit: 4, linkDiscussionPrincipalLimit: 2,
    });
    const link = await readWriteLink(f);
    const post = (capability: string, key: string, profile = PROFILE_A) => postChat(f, capability, { idempotencyKey: key }, profile);
    expect((await post(link.capability, "a-1")).status).toBe(200);
    expect((await post(link.capability, "a-2")).status).toBe(200);
    await expectRefused(await post(link.capability, "a-3"), 429, "link_read_rate_limited");
    clock += 60_001;
    expect((await post(link.capability, "a-3")).status).toBe(200);
    await expectRefused(await post(link.capability, "a-4"), 413, "discussion_limit_reached");

    const second = String((await json(await exchange(f, link.secret))).capabilityToken);
    expect((await post(second, "b-1", PROFILE_B)).status).toBe(200);
    await expectRefused(await post(second, "b-2", PROFILE_B), 413, "discussion_limit_reached");

    const third = String((await json(await exchange(f, link.secret))).capabilityToken);
    await expectRefused(await post(third, "c-1", PROFILE_C), 413, "discussion_limit_reached");
    expect(principalOf(f, link.grantId, PROFILE_C)).toBeNull();
    expect(linkOps(await ownerLog(f)).filter((op) => op.opKind === "chat.message.append")).toHaveLength(4);
  });

  it("refuses a post past the workspace quota and enrolls no principal", async () => {
    const quota = 1_000_000;
    const f = await fixture(released, undefined, { workspaceQuotaBytes: quota });
    const link = await readWriteLink(f);
    const db = inspectDatabase(storagePath(f.storage));
    try {
      db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes = ? WHERE workspace_id = ?").run(quota - 100, workspaceId);
    } finally {
      db.close();
    }
    await expectRefused(await postChat(f, link.capability), 413, "quota_exceeded");
    expect(principalOf(f, link.grantId)).toBeNull();
    expect(linkOps(await ownerLog(f))).toEqual([]);
  });

  it.each(["rotate", "revoke"] as const)("refuses posts after %s and keeps the earlier post with its link", async (change) => {
    const f = await fixture();
    const link = await readWriteLink(f);
    expect((await postChat(f, link.capability)).status).toBe(200);
    const before = linkOps(await ownerLog(f));
    const { poll } = await parkFollow(f, link.capability);

    const changed = await f.h(request(OWNER, change === "rotate"
      ? `/sync/shares/${f.shareId}/links/${link.grantId}/rotate`
      : `/sync/shares/${f.shareId}/revoke`, jsonBody({
      workspaceId, expectedDependentGrantIds: [], ...(change === "revoke" ? { grantId: link.grantId } : {}),
    })));
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect((await poll).status).toBe(404);
    expect((await postChat(f, link.capability, { idempotencyKey: "post-2" })).status).toBe(404);
    expect((await postChat(f, link.capability)).status).toBe(404);
    expect(linkOps(await ownerLog(f))).toEqual(before);
    expect(before[1]!.payload).toMatchObject({ authorKind: "link", linkGrantId: link.grantId });
  });

  it("refuses a post whose link is revoked after the request was admitted", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    const post = f.storage.appendLinkChatPost.bind(f.storage);
    const append = vi.spyOn(f.storage, "appendLinkChatPost").mockImplementation((input) => {
      expect(f.storage.revokeShareGrant({ shareId: f.shareId, grantId: link.grantId, revokedAtMs: 2_000 })).toMatchObject({ ok: true });
      return post(input);
    });
    expect((await postChat(f, link.capability)).status).toBe(404);
    expect(append).toHaveBeenCalledTimes(1);
    expect(linkOps(await ownerLog(f))).toEqual([]);
    expect(principalOf(f, link.grantId)).toBeNull();
  });

  it("tells each browser the name it already set, so it is not asked again", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    const channels = async (profile: string) =>
      json(await readChat(f, link.capability, "channels", { headers: { "x-dohc-link-profile-secret": profile } }));
    expect(await channels(PROFILE_A)).toMatchObject({ profileName: null });
    expect((await postChat(f, link.capability, { claimedName: "Sam" })).status).toBe(200);
    expect(await channels(PROFILE_A)).toMatchObject({ profileName: "Sam" });
    expect(await channels(PROFILE_B)).toMatchObject({ profileName: null });
    expect((await readChat(f, link.capability, "channels", { headers: { "x-dohc-link-profile-secret": "short" } })).status).toBe(404);
  });

  it("shows the owner's moderation feed each new link holder and its first name, from the revision the owner last read", async () => {
    const activity = new DiscussionActivityHub();
    const f = await fixture(released, activity);
    const link = await readWriteLink(f);
    const feed = (since: number, hold = 0) => f.h(request(OWNER,
      `/sync/shares/${f.shareId}/discussion/activity?workspaceId=${workspaceId}&since=${since}&hold=${hold}&limit=100`));
    const before = Number((await json(await feed(0))).latestRevision);

    // An owner caught up at `before` is woken by the first post and sees its new link holder.
    const entered = deferred(), wait = activity.wait.bind(activity);
    const spy = vi.spyOn(activity, "wait").mockImplementation((group, actor, options) => {
      const pending = wait(group, actor, options);
      entered.resolve();
      return pending;
    });
    const poll = feed(before, 30_000);
    await entered.promise;
    spy.mockRestore();
    expect((await postChat(f, link.capability)).status).toBe(200);
    const principal = principalOf(f, link.grantId)!;
    const woken = await json(await poll);
    expect(woken.principals).toEqual([{ principalId: principal.principalId, blocked: false }]);

    // Naming itself later is news again; a later post that changes nothing is not.
    const named = Number(woken.latestRevision);
    expect((await postChat(f, link.capability, { idempotencyKey: "post-2", claimedName: "Sam" })).status).toBe(200);
    const renamed = await json(await feed(named));
    expect(renamed.principals).toEqual([{ principalId: principal.principalId, blocked: false }]);
    expect((await postChat(f, link.capability, { idempotencyKey: "post-3" })).status).toBe(200);
    expect(await json(await feed(Number(renamed.latestRevision)))).toMatchObject({ latestRevision: renamed.latestRevision, principals: [] });
  });

  it("shows readers only link posts the relay wrote, under their link holder's origin", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    const { message } = await json(await postChat(f, link.capability, { claimedName: "Sam" })) as { message: { messageId: string } };
    const { principalId } = principalOf(f, link.grantId)!;
    const linkFields = { authorKind: "link", authorDisplayName: "Sam", linkGrantId: link.grantId, linkPrincipalId: principalId };
    const forge = (originId: string, originSeq: number, messageId: string, fields: Record<string, unknown>) => f.storage.appendLogBatch({
      workspaceId, originId, ops: [{ originSeq, opKind: "chat.message.append", recordedAtMs: 3_000, payloadJson: JSON.stringify({
        messageId, threadId: "thread-team", body: "forged", createdAtMs: 3_000, ...fields,
      }) }],
    });
    // Rows that reached storage without the relay writing them, as a relay
    // that refused none of these once might have admitted.
    const own = `${LINK_CHAT_ORIGIN_PREFIX}${principalId}`;
    forge("owner-device", 0, `${LINK_CHAT_MESSAGE_ID_PREFIX}ordinary-origin`, linkFields);
    forge(`${LINK_CHAT_ORIGIN_PREFIX}other-principal`, 0, `${LINK_CHAT_MESSAGE_ID_PREFIX}other-origin`, linkFields);
    forge(own, 2, `${LINK_CHAT_MESSAGE_ID_PREFIX}with-account`, { ...linkFields, authorUserId: OWNER });
    forge(own, 3, "unreserved-id", linkFields);
    forge("member-device", 0, "person-naming-a-link", { authorKind: "human", authorDisplayName: "Member", authorUserId: MEMBER, linkPrincipalId: principalId });
    expect(f.storage.fetchChatMessage({ workspaceId, originId: "owner-device", messageId: `${LINK_CHAT_MESSAGE_ID_PREFIX}ordinary-origin` })).not.toBeNull();

    const page = await json(await readChat(f, link.capability, history));
    expect((page.messages as Array<{ messageId: string }>).map((item) => item.messageId)).toEqual([message.messageId, "agent-reply", "owner-first"]);
    expect(JSON.stringify(page)).not.toContain("forged");
  });
});

describe("client pushes of a link post", () => {
  const forgeries: Array<[string, Record<string, unknown>]> = [
    ["a link author", { authorKind: "link", linkGrantId: "grant-0", linkPrincipalId: "principal" }],
    ["a link author with no account", { authorKind: "link", authorUserId: undefined, linkGrantId: "grant-0", linkPrincipalId: "principal" }],
    ["a person naming a link grant", { linkGrantId: "grant-0" }],
    ["a person naming a link principal", { linkPrincipalId: "principal" }],
  ];

  it.each(forgeries)("refuses %s from an owner's device and from a recipient's", async (_, fields) => {
    const f = await fixture();
    const before = (await ownerLog(f)).length;
    const forged = (authorUserId: string) => sequenced([chatMessageAppend("forged", "thread-team", "forged", { authorUserId, ...fields })]);
    await expectRefused(await f.h(request(OWNER, `/sync/${workspaceId}/log`, jsonBody({ originId: "owner-device", ops: forged(OWNER) }))),
      403, "authorship_mismatch");
    await expectRefused(await f.h(request(MEMBER, `/sync/shares/${f.shareId}/log`, jsonBody({ originId: "member-device", ops: forged(MEMBER) }))),
      403, "authorship_mismatch");
    expect(await ownerLog(f)).toHaveLength(before);
  });

  it("reserves the link post origin for the relay", async () => {
    const f = await fixture();
    const ops = sequenced([chatMessageAppend("plain", "thread-team", "plain", { authorUserId: OWNER })]);
    for (const originId of [`${LINK_CHAT_ORIGIN_PREFIX}principal`, LINK_CHAT_ORIGIN_PREFIX]) {
      await expectRefused(await f.h(request(OWNER, `/sync/${workspaceId}/log`, jsonBody({ originId, ops }))), 400);
    }
    expect(linkOps(await ownerLog(f))).toEqual([]);
  });

  it("reserves link post message and thread IDs for the relay, and keeps replies in a link thread", async () => {
    const f = await fixture();
    const before = (await ownerLog(f)).length;
    for (const ops of [
      [chatMessageAppend(`${LINK_CHAT_MESSAGE_ID_PREFIX}taken`, "thread-team", "first", { authorUserId: OWNER })],
      [chatThreadCreate(`${LINK_CHAT_THREAD_ID_PREFIX}taken`, channelWireId)],
    ]) {
      await expectRefused(await f.h(request(OWNER, `/sync/${workspaceId}/log`, jsonBody({ originId: "owner-device", ops: sequenced(ops) }))),
        403, "authorship_mismatch");
    }
    expect(await ownerLog(f)).toHaveLength(before);

    const link = await readWriteLink(f);
    const { message } = await json(await postChat(f, link.capability)) as { message: { messageId: string; threadId: string } };
    expect(message.messageId.startsWith(LINK_CHAT_MESSAGE_ID_PREFIX)).toBe(true);
    expect(message.threadId.startsWith(LINK_CHAT_THREAD_ID_PREFIX)).toBe(true);
    const reply = sequenced([chatMessageAppend("owner-reply", message.threadId, "welcome", { authorUserId: OWNER })]);
    expect((await f.h(request(OWNER, `/sync/${workspaceId}/log`, jsonBody({ originId: "owner-device", ops: reply })))).status).toBe(200);
  });

  it("names a link post with IDs a member cannot predict, and the post reaches every desktop", async () => {
    const f = await fixture();
    const link = await readWriteLink(f);
    // A first post shows every reader of the channel the link holder's principal.
    expect((await postChat(f, link.capability)).status).toBe(200);
    const { principalId } = principalOf(f, link.grantId)!;
    // A member who guesses the next retry key, but holds no profile secret, names the post wrong.
    const guessed = sha256Hex(JSON.stringify([principalId, "post-2"]));
    const taken = sequenced([
      chatThreadCreate(`${LINK_CHAT_THREAD_ID_PREFIX}${guessed}`, channelWireId),
      chatMessageAppend(`${LINK_CHAT_MESSAGE_ID_PREFIX}${guessed}`, `${LINK_CHAT_THREAD_ID_PREFIX}${guessed}`, "first", { authorUserId: MEMBER }),
    ]);
    await expectRefused(await f.h(request(MEMBER, `/sync/shares/${f.shareId}/log`, jsonBody({ originId: "member-device", ops: taken }))),
      403, "authorship_mismatch");

    const posted = await postChat(f, link.capability, { idempotencyKey: "post-2", body: "second" });
    expect(posted.status).toBe(200);
    const { message } = await json(posted) as { message: { messageId: string; threadId: string } };
    expect(message.messageId).not.toBe(`${LINK_CHAT_MESSAGE_ID_PREFIX}${guessed}`);
    expect(message.threadId).not.toBe(`${LINK_CHAT_THREAD_ID_PREFIX}${guessed}`);
    // The owner's devices and the named recipient's desktop each pull the post.
    const lane = await json(await f.h(request(MEMBER, `/sync/shares/${f.shareId}/log?channelWireId=${channelWireId}&since=0`)));
    for (const ops of [await ownerLog(f), lane.ops as ServedOp[]]) {
      expect(ops.filter((op) => op.payload.messageId === message.messageId)).toEqual([
        expect.objectContaining({ opKind: "chat.message.append", payload: expect.objectContaining({ body: "second", authorKind: "link" }) }),
      ]);
    }
  });
});
