import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import { MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE } from "./namedRecipientChat";
import { authorizeLinkChatAction, authorizeLinkShareAction } from "./shareAuthorization";
import type { SyncRelayStorage } from "./storage";
import {
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

async function fixture(overrides: HandlerOverrides = released, activity = new DiscussionActivityHub()) {
  const storage = await testStorage();
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
    expect(await json(channels)).toEqual({ shareId: f.shareId, channels: [{ channelWireId, name: "Team", access }] });

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
    const latest = (await json(await readChat(f, capability, history))).nextCursor;
    const entered = deferred(), wait = f.activity.wait.bind(f.activity);
    vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
      const pending = wait(group, actor, options);
      entered.resolve();
      return pending;
    });
    const poll = readChat(f, capability, `${history}&since=${String(latest)}&hold=30000`);
    await entered.promise;
    expect(f.activity.stats().waiters).toBe(1);

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

  it("caps link follows per workspace", async () => {
    const f = await fixture(released, new DiscussionActivityHub({ maxWaitersPerActor: MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE + 1 }));
    const capability = String((await groupLink(f)).exchanged.capabilityToken);
    const latest = String((await json(await readChat(f, capability, history))).nextCursor);
    const follow = `${history}&since=${latest}&hold=30000`;
    const controllers: AbortController[] = [], polls: Promise<Response>[] = [];
    try {
      for (let index = 0; index < MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE; index++) {
        const controller = new AbortController(), entered = deferred(), wait = f.activity.wait.bind(f.activity);
        controllers.push(controller);
        const spy = vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
          const pending = wait(group, actor, options);
          entered.resolve();
          return pending;
        });
        polls.push(readChat(f, capability, follow, { signal: controller.signal }));
        await entered.promise;
        spy.mockRestore();
      }
      const overflow = await readChat(f, capability, follow);
      expect(overflow.status).toBe(429);
      expect(await json(overflow)).toMatchObject({ code: "link_read_rate_limited" });
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(polls);
    }
    expect(f.activity.stats().waiters).toBe(0);
    expect((await readChat(f, capability, `${history}&since=${latest}`)).status).toBe(200);
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
    expect(authorizeLinkChatAction({ storage: f.storage, grantId: String(fileLink.grantId), action: "read" })).toEqual({ ok: false, reason: "gauntlet" });
  });
});
