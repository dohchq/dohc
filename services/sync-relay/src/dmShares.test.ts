import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import {
  filterOpForShare,
  validateChatChannelShareSelector,
  validateChatShareAccess,
  type ChatChannelShareSelector,
  type ChatShareThreadResolver,
  type ShareFileChatResolver,
  type ShareSelector,
} from "./shareFilter";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

// A resolver that knows no file-linked thread and no object: a DM grant is a
// chat-channel selector, and the file half must never decide anything for it.
const NO_FILE_CHAT: ShareFileChatResolver = {
  threadFileBinding: () => undefined,
  objectCurrentPath: () => undefined,
  objectIdAtPath: () => undefined,
};

// WS-MU-C3 — DM / chat-channel grants over the relay, riding MU-C4's
// bidirectional shared-channel lane. A DM is a `kind:"dm"` channel + one
// email-addressed chat-channel grant per participant, so a DM op is a strict
// SUBSET of the already-merged shared-channel route: it serves byte-identically
// to a regular channel op, binds by THREAD (never a self-claimed
// channelWireId on the message payload), and every unauthorized probe is
// indistinguishable from a share that never existed. These tests are the
// BLOCKING adversarial isolation gate for that claim.

let roots: string[] = [];
let storages: SyncRelayStorage[] = [];

beforeEach(() => {
  roots = [];
  storages = [];
});

afterEach(async () => {
  for (const storage of storages) storage.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function testStorage(): Promise<SyncRelayStorage> {
  const root = await mkdtemp(join(tmpdir(), "dohc-sync-relay-dm-"));
  roots.push(root);
  const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
  storages.push(storage);
  return storage;
}

function handler(storage: SyncRelayStorage): SyncRelayHandler {
  const resolveActor: ResolveActor = (request, workspaceId) => {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
    return { userId: auth.slice("Bearer user:".length), workspaceId };
  };
  let nextShare = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor,
    nowMs: () => 7777,
    resolveUserIdByEmail: (email) =>
      email.endsWith("@dohc.test") ? email.slice(0, -"@dohc.test".length) : null,
    lookupUserEmail: (userId) => `${userId}@dohc.test`,
    newShareId: () => `dmshare-${nextShare++}`,
  });
}

function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const OWNER = "alice";
const MEMBER = "bob";
const STRANGER = "mallory";
const WORKSPACE = "workspace-dm";
const DM_WIRE = "channel_dm_wire_1";
const OTHER_WIRE = "channel_private_wire_2";

async function createWorkspace(h: SyncRelayHandler): Promise<void> {
  const response = await h(
    request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })),
  );
  expect(response.status).toBe(200);
}

let opSeq = 0;

function chatOp(
  opKind: string,
  payload: Record<string, unknown>,
): { originSeq: number; opKind: string; payload: Record<string, unknown>; recordedAtMs: number } {
  const originSeq = opSeq++;
  return { originSeq, opKind, payload, recordedAtMs: 1000 + originSeq };
}

// A DM channel.create carries `kind:"dm"` — the ONLY thing distinguishing it
// from a regular MU-C4 channel op. Everything downstream is identical.
function dmChannelCreate(wireId = DM_WIRE): ReturnType<typeof chatOp> {
  return chatOp("chat.channel.create", {
    channelId: `channel-${wireId}`,
    name: "bob@dohc.test",
    slug: "bob-dohc-test",
    kind: "dm",
    createdAtMs: 1,
    wireId,
  });
}

function dmThreadCreate(wireId = DM_WIRE, threadId = "thread-dm-1"): ReturnType<typeof chatOp> {
  return chatOp("chat.thread.create", {
    threadId,
    title: "",
    createdAtMs: 2,
    channelSlug: "bob-dohc-test",
    channelWireId: wireId,
  });
}

// A message binds ONLY by threadId — it never carries a channelWireId, exactly
// like a solo/MU-C4 message. The relay derives scope from the thread's create.
function dmMessage(
  body: string,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof chatOp> {
  const seq = opSeq;
  return chatOp("chat.message.append", {
    messageId: `message-${seq}`,
    threadId: "thread-dm-1",
    authorKind: "human",
    authorDisplayName: "Alice",
    authorUserId: OWNER,
    body,
    createdAtMs: 3 + seq,
    ...overrides,
  });
}

async function appendOwnerOps(h: SyncRelayHandler, ops: unknown[]): Promise<void> {
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })),
  );
  expect(response.status).toBe(200);
}

async function createDmGrant(
  h: SyncRelayHandler,
  body: Record<string, unknown> = {
    recipientEmail: `${MEMBER}@dohc.test`,
    channelWireId: DM_WIRE,
    access: "read-write",
  },
): Promise<string> {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody(body)));
  expect(response.status).toBe(200);
  return (await json(response)).shareId as string;
}

// A member-append op: the client supplies its OWN originSeq (client-sequenced,
// unlike MU-C3's server-owned space). The relay namespaces the origin id.
function memberMessage(
  originSeq: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    originSeq,
    opKind: "chat.message.append",
    payload: {
      messageId: `member-message-${originSeq}`,
      threadId: "thread-dm-1",
      authorKind: "human",
      authorDisplayName: "Bob",
      authorUserId: MEMBER,
      body: "hi alice",
      createdAtMs: 5000,
      ...overrides,
    },
    recordedAtMs: 5000,
  };
}

async function memberAppend(
  h: SyncRelayHandler,
  shareId: string,
  ops: unknown[],
  originId = "origin-member",
): Promise<Response> {
  return h(request(MEMBER, `/sync/shares/${shareId}/log`, jsonBody({ originId, ops })));
}

async function fetchSharedOps(
  h: SyncRelayHandler,
  userId: string,
  shareId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await h(request(userId, `/sync/shares/${shareId}/log?since=0`));
  expect(response.status).toBe(200);
  return (await json(response)).ops as Array<Record<string, unknown>>;
}

// Captures a denial as comparable bytes: unauthorized probes of every kind must
// be indistinguishable from a share that never existed.
async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

describe("chat-channel share selector (DM grants)", () => {
  it("validates grant-time chat selectors fail-closed", () => {
    expect(validateChatChannelShareSelector({ channelWireId: DM_WIRE }).ok).toBe(true);
    expect(validateChatShareAccess("read-only").ok).toBe(true);
    for (const bad of [
      { channelWireId: "" },
      { channelWireId: "  padded  " },
      { channelWireId: "x".repeat(300) },
    ]) {
      expect(validateChatChannelShareSelector(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateChatShareAccess("admin").ok).toBe(false);
  });

  it("admits ONLY thread-bound chat ops for the granted channel through the read filter", () => {
    const selector: ChatChannelShareSelector = {
      kind: "chat-channel",
      channelWireId: DM_WIRE,
      access: "read-write",
    };
    // The thread→channel resolver the chat branch scopes by. "t" belongs to the
    // granted DM; "t2" belongs to ANOTHER channel; "t3" is unbound.
    const chat: ChatShareThreadResolver = {
      channelKind: (wireId) =>
        wireId === DM_WIRE ? "dm" : wireId === OTHER_WIRE ? "channel" : undefined,
      ...NO_FILE_CHAT,
      threadChannelWireId: (threadId) =>
        threadId === "t" ? DM_WIRE : threadId === "t2" ? OTHER_WIRE : undefined,
    };
    const allow = (opKind: string, payload: Record<string, unknown>) =>
      filterOpForShare(selector, opKind, JSON.stringify(payload), chat).allowed;

    // Honest DM stream: channel + thread + message + reaction for THIS wire id.
    expect(allow("chat.channel.create", { wireId: DM_WIRE, kind: "dm", name: "x", slug: "x", channelId: "c", createdAtMs: 1 })).toBe(true);
    expect(allow("chat.thread.create", { threadId: "t", title: "", createdAtMs: 1, channelWireId: DM_WIRE })).toBe(true);
    expect(allow("chat.message.append", { messageId: "m", threadId: "t", body: "hi", authorKind: "human", authorDisplayName: "A", createdAtMs: 1 })).toBe(true);
    expect(allow("chat.reaction.set", { reactionId: "r", messageId: "m", threadId: "t", emoji: "👍", authorId: "u", authorKind: "human", authorDisplayName: "A", state: "added", atMs: 1 })).toBe(true);

    // Another channel's ops never cross — resolved by THREAD, so a hostile
    // channelWireId stapled onto the payload is irrelevant.
    expect(allow("chat.channel.create", { wireId: OTHER_WIRE, kind: "channel", name: "y", slug: "y", channelId: "c2", createdAtMs: 1 })).toBe(false);
    expect(allow("chat.thread.create", { threadId: "t2", title: "", createdAtMs: 1, channelWireId: OTHER_WIRE })).toBe(false);
    // A thread.create that FORGES the granted wire id for a thread already bound
    // elsewhere is excluded (earliest-binding wins).
    expect(allow("chat.thread.create", { threadId: "t2", title: "", createdAtMs: 1, channelWireId: DM_WIRE })).toBe(false);
    // A message into another channel's thread, even with a forged channelWireId.
    expect(allow("chat.message.append", { messageId: "m2", threadId: "t2", channelWireId: DM_WIRE, body: "leak", authorKind: "human", authorDisplayName: "A", createdAtMs: 1 })).toBe(false);
    // A message into an UNBOUND thread (no channel address at all).
    expect(allow("chat.message.append", { messageId: "m3", threadId: "t3", body: "leak", authorKind: "human", authorDisplayName: "A", createdAtMs: 1 })).toBe(false);
    expect(allow("chat.reaction.set", { reactionId: "r2", messageId: "m", threadId: "t2", emoji: "👍", authorId: "u", authorKind: "human", authorDisplayName: "A", state: "added", atMs: 1 })).toBe(false);

    // A file-linked thread never crosses a chat grant even if a hostile payload
    // staples the granted wire id next to a linked file.
    expect(allow("chat.thread.create", { threadId: "t4", title: "x", createdAtMs: 1, channelWireId: DM_WIRE, linkedObjectId: "object-1" })).toBe(false);

    // NOTHING non-chat crosses a chat grant.
    for (const opKind of [
      "workspace.init",
      "moment.append",
      "version.create",
      "secret.file.put",
      "ydoc.update",
      "chat.thread.update",
      "made.up.kind",
    ]) {
      expect(
        allow(opKind, { path: "docs/a.md", versionId: "main", threadId: "t", wireId: DM_WIRE }),
        opKind,
      ).toBe(false);
    }
  });

  it("keeps chat ops excluded from PATH shares (the PR-18 posture is unchanged)", () => {
    const pathSelector: ShareSelector = { paths: ["docs"], versionId: null, access: "view" };
    for (const opKind of [
      "chat.channel.create",
      "chat.thread.create",
      "chat.message.append",
      "chat.reaction.set",
    ]) {
      expect(
        filterOpForShare(
          pathSelector,
          opKind,
          JSON.stringify({ channelWireId: DM_WIRE, wireId: DM_WIRE, threadId: "t", path: "docs/a.md" }),
        ).allowed,
        opKind,
      ).toBe(false);
    }
  });
});

describe("DM grants over the relay", () => {
  beforeEach(() => {
    opSeq = 0;
  });

  it("creates an email-addressed chat-channel grant and lists it on both sides", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    const shareId = await createDmGrant(h);

    // Invalid selectors fail closed with the MU-C4 codes.
    const invalid = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: `${MEMBER}@dohc.test`, channelWireId: "" })),
    );
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).code).toBe("invalid_channel");
    const badAccess = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: `${MEMBER}@dohc.test`, channelWireId: DM_WIRE, access: "admin" })),
    );
    expect(badAccess.status).toBe(400);
    expect((await json(badAccess)).code).toBe("invalid_access");

    // Defense in depth: an AMBIGUOUS body carrying BOTH a chat-channel selector
    // (channelWireId) AND a path/version selector is a caller intent mismatch
    // (e.g. reused request plumbing leaving a stale `paths`). It fails closed
    // with 400 rather than silently dropping the paths and minting a full
    // chat-channel grant.
    const mixed = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: `${MEMBER}@dohc.test`, paths: ["docs"], channelWireId: DM_WIRE }),
      ),
    );
    expect(mixed.status).toBe(400);
    expect((await json(mixed)).code).toBe("ambiguous_selector");

    const granted = await json(await h(request(OWNER, "/sync/shares")));
    const grantedRow = (granted.granted as Array<Record<string, unknown>>).find(
      (row) => row.shareId === shareId,
    );
    expect(grantedRow?.selector).toEqual({
      kind: "chat-channel",
      channelWireId: DM_WIRE,
    });
    expect(grantedRow).toMatchObject({
      access: "read-write",
      grantId: expect.any(String),
      generation: 1,
    });

    const received = await json(await h(request(MEMBER, "/sync/shares")));
    const receivedRow = (received.received as Array<Record<string, unknown>>).find(
      (row) => row.shareId === shareId,
    );
    expect(receivedRow?.selector).toEqual({
      kind: "chat-channel",
      channelWireId: DM_WIRE,
    });
    expect(receivedRow).toMatchObject({
      access: "read-write",
      grantId: expect.any(String),
      generation: 1,
    });
    // The received summary must not expose the granter's workspace id.
    expect(receivedRow?.workspaceId).toBeUndefined();
  });

  it("serves a participant a DM stream BYTE-IDENTICALLY to a MU-C4 channel stream — no DM-only field", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    const ciphertext = "secret-ciphertext-bytes";
    const ciphertextSha = createHash("sha256").update(ciphertext).digest("hex");
    const blobPut = await h(
      request(OWNER, `/sync/${WORKSPACE}/blobs/${ciphertextSha}`, { method: "PUT", body: ciphertext }),
    );
    expect(blobPut.status).toBe(200);
    await appendOwnerOps(h, [
      chatOp("workspace.init", {}),
      dmChannelCreate(),
      dmThreadCreate(),
      dmMessage("hello bob"),
      // A PRIVATE channel + thread + message in the same bucket must never
      // cross the DM grant.
      chatOp("chat.channel.create", { channelId: "channel-private", name: "private", slug: "private", kind: "channel", createdAtMs: 1, wireId: OTHER_WIRE }),
      chatOp("chat.thread.create", { threadId: "thread-private", title: "", createdAtMs: 2, channelSlug: "private", channelWireId: OTHER_WIRE }),
      dmMessage("private secret", { threadId: "thread-private", messageId: "private-msg" }),
      chatOp("moment.append", { path: "docs/a.md", versionId: "main" }),
      chatOp("secret.file.put", { path: ".env", versionId: "main", ciphertextSha256: ciphertextSha, ivBase64: "aa", authTagBase64: "bb", byteLength: 2, metadata: {} }),
    ]);
    const shareId = await createDmGrant(h);

    const ops = await fetchSharedOps(h, MEMBER, shareId);
    expect(ops.map((op) => op.opKind)).toEqual([
      "chat.channel.create",
      "chat.thread.create",
      "chat.message.append",
    ]);
    // The served message payload carries NO channelWireId — the exact same
    // allowlisted shape a solo/MU-C4 message serves. Scope came from the thread.
    const served = ops.find((op) => op.opKind === "chat.message.append")!;
    expect(served.payload).toEqual({
      messageId: (served.payload as Record<string, unknown>).messageId,
      threadId: "thread-dm-1",
      authorKind: "human",
      authorDisplayName: "Alice",
      authorUserId: OWNER,
      body: "hello bob",
      createdAtMs: (served.payload as Record<string, unknown>).createdAtMs,
    });
    expect(Object.keys(served.payload as Record<string, unknown>)).not.toContain("channelWireId");
    const serialized = JSON.stringify(ops);
    expect(serialized).not.toContain("private secret");
    expect(serialized).not.toContain(OTHER_WIRE);
    expect(serialized).not.toContain(".env");
  });

  it("lets a participant append through the member route under a share-namespaced origin", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    await appendOwnerOps(h, [dmChannelCreate(), dmThreadCreate(), dmMessage("hello bob")]);
    const shareId = await createDmGrant(h);

    const post = await memberAppend(h, shareId, [memberMessage(0)]);
    expect(post.status).toBe(200);
    expect((await json(post)).inserted).toBe(1);

    const memberOps = await fetchSharedOps(h, MEMBER, shareId);
    const memberAuthored = memberOps.find(
      (op) => (op.payload as Record<string, unknown>).body === "hi alice",
    )!;
    // Client-sequenced, namespaced per share — NOT MU-C3's hashed origin.
    expect(memberAuthored.originId).toBe(`share:${shareId}:origin-member`);
    expect(memberAuthored.originSeq).toBe(0);

    // The OWNER's own bucket pull sees the member's op too (one log, many
    // authenticated readers/writers).
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0`)));
    const ownerBodies = (ownerLog.ops as Array<Record<string, unknown>>)
      .filter((op) => op.opKind === "chat.message.append")
      .map((op) => (op.payload as Record<string, unknown>).body);
    expect(ownerBodies).toContain("hi alice");
  });

  it("REJECTS a forged author on the member route — a member cannot speak as another participant", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    await appendOwnerOps(h, [dmChannelCreate(), dmThreadCreate()]);
    const shareId = await createDmGrant(h);

    const forged = await memberAppend(h, shareId, [
      memberMessage(0, { authorUserId: OWNER, body: "forged as alice" }),
    ]);
    expect(forged.status).toBe(403);
    expect((await json(forged)).code).toBe("authorship_mismatch");

    // Nothing from a rejected batch is admitted.
    const ops = await fetchSharedOps(h, MEMBER, shareId);
    expect(JSON.stringify(ops)).not.toContain("forged as alice");
  });

  it("REJECTS member ops outside the granted channel scope, atomically (thread-binding)", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    // Seed BOTH the DM thread AND a thread bound to ANOTHER channel: under
    // thread-binding, the rejection must be exercised against a thread that
    // resolves to OTHER_WIRE (or an unbound thread), not a self-claimed
    // channelWireId on the message.
    await appendOwnerOps(h, [
      dmChannelCreate(),
      dmThreadCreate(),
      chatOp("chat.channel.create", { channelId: "channel-other", name: "other", slug: "other", kind: "channel", createdAtMs: 1, wireId: OTHER_WIRE }),
      chatOp("chat.thread.create", { threadId: "thread-other", title: "", createdAtMs: 2, channelSlug: "other", channelWireId: OTHER_WIRE }),
    ]);
    const shareId = await createDmGrant(h);

    const cases: Array<Record<string, unknown>> = [
      // A message into a thread bound to a DIFFERENT channel.
      { originSeq: 1, opKind: "chat.message.append", payload: { messageId: "x1", threadId: "thread-other", authorKind: "human", authorDisplayName: "Bob", authorUserId: MEMBER, body: "cross-channel write", createdAtMs: 5000 }, recordedAtMs: 5000 },
      // A message into an UNBOUND thread (no channel address anywhere).
      { originSeq: 1, opKind: "chat.message.append", payload: { messageId: "x2", threadId: "thread-nowhere", authorKind: "human", authorDisplayName: "Bob", authorUserId: MEMBER, body: "unaddressed write", createdAtMs: 5000 }, recordedAtMs: 5000 },
      // A forged re-bind: thread.create claiming the GRANTED channel for the
      // owner's existing OTHER-channel thread (earliest-binding must win).
      { originSeq: 1, opKind: "chat.thread.create", payload: { threadId: "thread-other", title: "", createdAtMs: 1, channelWireId: DM_WIRE }, recordedAtMs: 5000 },
      // A member thread must be channel-owned, never file-linked.
      { originSeq: 1, opKind: "chat.thread.create", payload: { threadId: "evil-thread", title: "", createdAtMs: 1, channelWireId: DM_WIRE, linkedObjectId: "object-1" }, recordedAtMs: 5000 },
    ];
    for (const op of cases) {
      // Mix the hostile op with an honest one: the WHOLE batch must fail.
      const response = await memberAppend(h, shareId, [memberMessage(0), op]);
      expect(response.status, JSON.stringify(op)).toBe(403);
      expect((await json(response)).code).toBe("share_op_rejected");
    }
    // Nothing was admitted by any rejected batch.
    const ops = await fetchSharedOps(h, MEMBER, shareId);
    expect(ops.filter((op) => op.opKind === "chat.message.append")).toEqual([]);
  });

  it("denies every non-participant surface byte-identically to a share that never existed", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    await appendOwnerOps(h, [dmChannelCreate(), dmThreadCreate(), dmMessage("secret dm body")]);
    const shareId = await createDmGrant(h);

    // The baseline: a share id that has never existed.
    const absent = await denialBytes(await h(request(STRANGER, "/sync/shares/never-existed")));
    const absentLog = await denialBytes(
      await h(request(STRANGER, "/sync/shares/never-existed/log?since=0")),
    );
    const absentAppend = await denialBytes(
      await h(request(STRANGER, "/sync/shares/never-existed/log", jsonBody({ originId: "o", ops: [] }))),
    );

    // A REAL DM share probed by a non-participant: byte-identical denials on
    // metadata, read, and append — existence is unconfirmable.
    expect(await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}`)))).toBe(absent);
    expect(
      await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}/log?since=0`))),
    ).toBe(absentLog);
    expect(
      await denialBytes(
        await h(request(STRANGER, `/sync/shares/${shareId}/log`, jsonBody({ originId: "o", ops: [memberMessage(0)] }))),
      ),
    ).toBe(absentAppend);

    // The DM is invisible in the stranger's share listings.
    const listing = await json(await h(request(STRANGER, "/sync/shares")));
    expect(listing.granted).toEqual([]);
    expect(listing.received).toEqual([]);

    // And the OWNER's bucket itself stays owner-only.
    const bucketProbe = await h(request(STRANGER, `/sync/${WORKSPACE}/log?since=0`));
    expect(bucketProbe.status).toBe(404);
  });

  it("closes a revoked participant's access on the next fetch AND append, byte-identically to never-existed", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    await appendOwnerOps(h, [dmChannelCreate(), dmThreadCreate(), dmMessage("hello bob")]);
    const shareId = await createDmGrant(h);

    // The honest path works before revocation.
    expect((await fetchSharedOps(h, MEMBER, shareId)).length).toBe(3);
    expect((await memberAppend(h, shareId, [memberMessage(0)])).status).toBe(200);

    const revoke = await h(request(OWNER, `/sync/shares/${shareId}/revoke`, jsonBody({})));
    expect(revoke.status).toBe(200);

    const absent = await denialBytes(await h(request(MEMBER, "/sync/shares/never-existed")));
    const absentLog = await denialBytes(
      await h(request(MEMBER, "/sync/shares/never-existed/log?since=0")),
    );
    expect(await denialBytes(await h(request(MEMBER, `/sync/shares/${shareId}`)))).toBe(absent);
    expect(await denialBytes(await h(request(MEMBER, `/sync/shares/${shareId}/log?since=0`)))).toBe(
      absentLog,
    );
    expect((await memberAppend(h, shareId, [memberMessage(1)])).status).toBe(404);

    // The revoked DM disappears from the member's received listing.
    const listing = await json(await h(request(MEMBER, "/sync/shares")));
    expect(
      (listing.received as Array<Record<string, unknown>>).find((row) => row.shareId === shareId),
    ).toBeUndefined();
  });

  it("refuses appends through a read-only chat grant and through a PATH grant", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    await appendOwnerOps(h, [dmChannelCreate(), dmThreadCreate()]);
    const readOnlyShareId = await createDmGrant(h, {
      recipientEmail: `${MEMBER}@dohc.test`,
      channelWireId: DM_WIRE,
      access: "read-only",
    });
    const post = await memberAppend(h, readOnlyShareId, [memberMessage(0)]);
    expect(post.status).toBe(403);
    expect((await json(post)).code).toBe("share_read_only");
    // Reading still works for a read-only member.
    expect((await fetchSharedOps(h, MEMBER, readOnlyShareId)).length).toBe(2);

    // A PATH-share recipient cannot append through the chat route at all — and
    // learns nothing distinguishing (share_read_only, like any non-appendable).
    const pathShareId = (await json(
      await h(
        request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: `${MEMBER}@dohc.test`, paths: ["docs"], access: "view" })),
      ),
    )).shareId as string;
    const pathPost = await memberAppend(h, pathShareId, [memberMessage(0)]);
    expect(pathPost.status).toBe(403);
    expect((await json(pathPost)).code).toBe("share_read_only");
  });

  it("keeps the anti-enumeration posture for chat grants addressed by email", async () => {
    const h = handler(await testStorage());
    await createWorkspace(h);
    const known = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: `${MEMBER}@dohc.test`, channelWireId: DM_WIRE })),
    );
    const unknown = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: "nobody@example.com", channelWireId: DM_WIRE })),
    );
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const knownBody = await json(known);
    const unknownBody = await json(unknown);
    // Identical shape either way: no recipientUserId echo, no account oracle.
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
    expect(knownBody.recipientUserId).toBeUndefined();
    expect(unknownBody.recipientUserId).toBeUndefined();
  });
});
