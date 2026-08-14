import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

// MU-C4 shared channels — the route-level adversarial suite for the
// BIDIRECTIONAL chat-channel grant: the member append route, the chat branch
// of the fail-closed share filter, read-write vs read-only enforcement, and
// revocation. PR-18 posture throughout: server-derived identity, fail-closed
// filters, byte-identical generic 404s for every unauthorized probe.

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
  const root = await mkdtemp(join(tmpdir(), "dohc-sync-relay-shared-channels-"));
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
    nowMs: () => 5555,
    resolveUserIdByEmail: (email) =>
      email.endsWith("@dohc.test") ? email.slice(0, -"@dohc.test".length) : null,
    lookupUserEmail: (userId) => `${userId}@dohc.test`,
    newShareId: () => `share-${nextShare++}`,
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

const OWNER = "owner";
const MEMBER_A = "member-a";
const MEMBER_B = "member-b";
const STRANGER = "stranger";
const WORKSPACE = "workspace-chat";
const SHARED_WIRE = "wire-shared-channel";
const PRIVATE_WIRE = "wire-private-channel";

async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

let ownerSeq = 0;

function chatOp(
  opKind: string,
  payload: Record<string, unknown>,
): { originSeq: number; opKind: string; payload: Record<string, unknown>; recordedAtMs: number } {
  const originSeq = ownerSeq++;
  return { originSeq, opKind, payload, recordedAtMs: 1000 + originSeq };
}

function channelCreate(wireId: string, name: string) {
  return chatOp("chat.channel.create", {
    channelId: `chan-${wireId}`,
    name,
    slug: name.toLowerCase(),
    kind: "channel",
    createdAtMs: 1,
    wireId,
  });
}

function threadCreate(threadId: string, wireId: string, slug: string) {
  return chatOp("chat.thread.create", {
    threadId,
    title: "",
    createdAtMs: 1,
    channelSlug: slug,
    channelWireId: wireId,
  });
}

function messageAppend(messageId: string, threadId: string, body: string, authorUserId?: string) {
  return chatOp("chat.message.append", {
    messageId,
    threadId,
    authorKind: "human",
    authorDisplayName: "Someone",
    ...(authorUserId !== undefined ? { authorUserId } : {}),
    body,
    createdAtMs: 1,
  });
}

// Seeds the owner bucket with a shared channel (one thread, one message), a
// PRIVATE channel with sentinel content, a sentinel file moment, and a secret
// op — everything a leaking filter would expose.
async function seedOwnerWorkspace(h: SyncRelayHandler): Promise<void> {
  ownerSeq = 0;
  const create = await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
  expect(create.status).toBe(200);
  const ops = [
    channelCreate(SHARED_WIRE, "team"),
    threadCreate("thread-shared-1", SHARED_WIRE, "team"),
    messageAppend("msg-owner-1", "thread-shared-1", "welcome to the shared channel", OWNER),
    channelCreate(PRIVATE_WIRE, "SENTINEL-private-channel"),
    threadCreate("thread-private-1", PRIVATE_WIRE, "sentinel-private-channel"),
    messageAppend("msg-private-1", "thread-private-1", "SENTINEL-private-message", OWNER),
    chatOp("chat.thread.create", {
      threadId: "thread-file-private",
      title: "",
      createdAtMs: 1,
      linkedObjectId: "object-file-private",
      linkedPathHint: "private/file.md",
      linkedAtMs: 1,
    }),
    {
      originSeq: ownerSeq++,
      opKind: "secret.file.put",
      payload: {
        versionId: "main",
        path: "notes/.env.local",
        metadata: { origin: "user" },
        ivBase64: "AA==",
        authTagBase64: "AA==",
        // No blob uploaded: referencedBlobShas requires stored blobs, so use a
        // moment-free secret marker instead? No — secret.file.put requires its
        // ciphertext blob. Upload below before appending.
        ciphertextSha256: null,
        byteLength: 0,
      },
      recordedAtMs: 2000,
    },
  ];
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })),
  );
  expect(response.status).toBe(200);
}

async function createChannelShare(
  h: SyncRelayHandler,
  recipient: string,
  access?: "read-write" | "read-only",
): Promise<string> {
  const response = await h(
    request(
      OWNER,
      `/sync/${WORKSPACE}/shares`,
      jsonBody({
        recipientUserId: recipient,
        channelWireId: SHARED_WIRE,
        ...(access ? { access } : {}),
      }),
    ),
  );
  expect(response.status).toBe(200);
  return (await json(response)).shareId as string;
}

async function fetchSharePage(
  h: SyncRelayHandler,
  userId: string,
  shareId: string,
): Promise<Array<{ opKind: string; payload: Record<string, unknown>; originId: string }>> {
  const response = await h(request(userId, `/sync/shares/${shareId}/log?since=0&limit=100`));
  expect(response.status).toBe(200);
  const page = await json(response);
  return page.ops as Array<{ opKind: string; payload: Record<string, unknown>; originId: string }>;
}

describe("shared channels (MU-C4)", () => {
  // A damaged row loses its selector, and with it the KIND that routes it to
  // the right manager. Without the kind surviving, a damaged chat-channel
  // grant surfaced in the path/version share lists as an unreadable path
  // share — the wrong manager, offering the wrong actions.
  it("still says a damaged row is a chat-channel grant", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    // A stored row damaged in every dimension EXCEPT its kind, written
    // through the same API the create route uses.
    storage.createShare({
      shareId: "share-damaged-channel",
      workspaceId: WORKSPACE,
      granterUserId: OWNER,
      recipientUserId: MEMBER_A,
      recipientEmail: null,
      selectorJson: JSON.stringify({
        kind: "chat-channel",
        channelWireId: "",
        access: "nonsense",
      }),
      createdAtMs: 1000,
    });

    const listing = await json(await h(request(OWNER, "/sync/shares")));
    const row = (listing.granted as Array<Record<string, unknown>>).find(
      (candidate) => candidate.shareId === "share-damaged-channel",
    );
    expect(row?.selector, "a damaged row carries no selector").toBeNull();
    expect(
      row?.selectorKind,
      "MUTATION: a damaged chat-channel grant surfaces in the path/version share lists",
    ).toBe("chat-channel");
  });

  it("creates a chat-channel grant (read-write default) and echoes the selector on both sides", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    const granted = (await json(await h(request(OWNER, "/sync/shares")))).granted as Array<
      Record<string, unknown>
    >;
    expect(granted[0]).toMatchObject({
      shareId,
      selector: { kind: "chat-channel", channelWireId: SHARED_WIRE, access: "read-write" },
    });

    const received = (await json(await h(request(MEMBER_A, "/sync/shares")))).received as Array<
      Record<string, unknown>
    >;
    expect(received[0]).toMatchObject({
      shareId,
      granterUserId: OWNER,
      selector: { kind: "chat-channel", channelWireId: SHARED_WIRE, access: "read-write" },
    });
    // The member never learns the owner's workspace id.
    expect(received[0]).not.toHaveProperty("workspaceId");
  });

  it("refuses invalid chat selectors at grant time", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const empty = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: MEMBER_A, channelWireId: "" })),
    );
    expect(empty.status).toBe(400);
    expect((await json(empty)).code).toBe("invalid_channel");
    const badAccess = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: MEMBER_A, channelWireId: SHARED_WIRE, access: "admin" }),
      ),
    );
    expect(badAccess.status).toBe(400);
    expect((await json(badAccess)).code).toBe("invalid_access");
  });

  it("serves a member ONLY the granted channel's ops — private channels, files, and secrets never leak", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    const response = await h(request(MEMBER_A, `/sync/shares/${shareId}/log?since=0&limit=100`));
    expect(response.status).toBe(200);
    const page = await json(response);
    const ops = page.ops as Array<{ opKind: string; payload: Record<string, unknown> }>;
    expect(ops.map((op) => op.opKind)).toEqual([
      "chat.channel.create",
      "chat.thread.create",
      "chat.message.append",
    ]);
    expect(ops[0]!.payload.wireId).toBe(SHARED_WIRE);
    expect(ops[2]!.payload.body).toBe("welcome to the shared channel");
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("SENTINEL-private-channel");
    expect(serialized).not.toContain("SENTINEL-private-message");
    expect(serialized).not.toContain("thread-private-1");
    expect(serialized).not.toContain(PRIVATE_WIRE);
    expect(serialized).not.toContain(".env");
  });

  it("denies non-members byte-identically to a share that never existed (read AND append)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    const missingRead = await denialBytes(
      await h(request(STRANGER, "/sync/shares/share-404/log?since=0")),
    );
    expect(
      await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}/log?since=0`))),
    ).toBe(missingRead);
    // The GRANTER is not a recipient either: the owner reads through their
    // own bucket, never through the share.
    expect(
      await denialBytes(await h(request(OWNER, `/sync/shares/${shareId}/log?since=0`))),
    ).toBe(missingRead);

    const appendBody = jsonBody({
      originId: "origin-x",
      ops: [messageAppend("msg-x", "thread-shared-1", "intrusion", STRANGER)],
    });
    const missingAppend = await denialBytes(
      await h(request(STRANGER, "/sync/shares/share-404/log", appendBody)),
    );
    expect(
      await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}/log`, appendBody))),
    ).toBe(missingAppend);
    // Nothing landed in the owner's bucket.
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    expect(JSON.stringify(ownerLog)).not.toContain("intrusion");
  });

  it("lets a read-write member append channel ops that then reach the owner and every other member", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareA = await createChannelShare(h, MEMBER_A);
    const shareB = await createChannelShare(h, MEMBER_B);

    // Member A starts a thread and posts into it in ONE batch (the composer
    // path): the intra-batch thread binding must hold.
    const append = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareA}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [
            { ...threadCreate("thread-by-a", SHARED_WIRE, "team"), originSeq: 0 },
            { ...messageAppend("msg-a-1", "thread-by-a", "hello from member A", MEMBER_A), originSeq: 1 },
            { ...messageAppend("msg-a-2", "thread-shared-1", "replying to the owner", MEMBER_A), originSeq: 2 },
          ],
        }),
      ),
    );
    expect(append.status).toBe(200);
    expect(await json(append)).toMatchObject({ ok: true, accepted: 3, inserted: 3 });

    // The owner sees member A's ops in their own bucket, under a
    // share-namespaced origin (a member can never extend an owner origin).
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    const ownerOps = ownerLog.ops as Array<{ originId: string; payload: Record<string, unknown> }>;
    const fromA = ownerOps.filter((op) => op.originId === `share:${shareA}:origin-member-a`);
    expect(fromA).toHaveLength(3);
    expect(JSON.stringify(ownerLog)).toContain("hello from member A");

    // Member B converges on the same ops through their own share.
    const opsForB = await fetchSharePage(h, MEMBER_B, shareB);
    const bodies = opsForB
      .filter((op) => op.opKind === "chat.message.append")
      .map((op) => op.payload.body);
    expect(bodies).toEqual([
      "welcome to the shared channel",
      "hello from member A",
      "replying to the owner",
    ]);
    // And member A sees their own echo plus the owner's history identically.
    const opsForA = await fetchSharePage(h, MEMBER_A, shareA);
    expect(opsForA.map((op) => op.opKind)).toEqual(opsForB.map((op) => op.opKind));
  });

  it("refuses a read-only member's append but keeps serving them reads", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A, "read-only");

    const ops = await fetchSharePage(h, MEMBER_A, shareId);
    expect(ops).toHaveLength(3);

    const append = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [messageAppend("msg-ro", "thread-shared-1", "broadcast reply", MEMBER_A)],
        }),
      ),
    );
    expect(append.status).toBe(403);
    expect((await json(append)).code).toBe("share_read_only");
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    expect(JSON.stringify(ownerLog)).not.toContain("broadcast reply");
  });

  it("refuses appends to a PR-18 path share with the same code (no new write surface on file shares)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const created = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: MEMBER_A, paths: ["docs"], access: "view" })),
    );
    expect(created.status).toBe(200);
    const shareId = (await json(created)).shareId as string;
    const append = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({ originId: "origin-member-a", ops: [] }),
      ),
    );
    expect(append.status).toBe(403);
    expect((await json(append)).code).toBe("share_read_only");
  });

  it("rejects a member's forged authorship — a message or reaction claiming another user (MU-C0 gate)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    const forgedMessage = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [messageAppend("msg-forged", "thread-shared-1", "forged as B", MEMBER_B)],
        }),
      ),
    );
    expect(forgedMessage.status).toBe(403);
    expect((await json(forgedMessage)).code).toBe("authorship_mismatch");

    const forgedReaction = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [
            chatOp("chat.reaction.set", {
              reactionId: "r-forged",
              messageId: "msg-owner-1",
              threadId: "thread-shared-1",
              emoji: "👍",
              authorId: OWNER,
              authorKind: "human",
              authorDisplayName: "Owner",
              state: "added",
              atMs: 1,
            }),
          ],
        }),
      ),
    );
    expect(forgedReaction.status).toBe(403);
    expect((await json(forgedReaction)).code).toBe("authorship_mismatch");

    // The member must send the authenticated user id in the replicated bytes.
    const missingAuthor = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [{ ...messageAppend("msg-anon", "thread-shared-1", "anonymous"), originSeq: 0 }],
        }),
      ),
    );
    expect(missingAuthor.status).toBe(403);
    expect((await json(missingAuthor)).code).toBe("authorship_mismatch");
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    const missingOp = (ownerLog.ops as Array<{ payload: Record<string, unknown> }>).find(
      (op) => op.payload.messageId === "msg-anon",
    );
    expect(missingOp).toBeUndefined();
  });

  it("rejects a batch containing ANY op outside the shared channel, atomically", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    const attempts: Array<Record<string, unknown>> = [
      // A message into the owner's PRIVATE channel thread.
      messageAppend("msg-leak-1", "thread-private-1", "SNEAK-private-post", MEMBER_A),
      // A thread.create for the private channel.
      threadCreate("thread-sneak", PRIVATE_WIRE, "sentinel-private-channel"),
      // A channel.create for a different wire id.
      channelCreate("wire-else", "SNEAK-new-channel"),
      // A file write into the owner's workspace.
      {
        originSeq: 0,
        opKind: "moment.append",
        payload: { versionId: "main", path: "docs/SNEAK.md", operation: "write", payloadAfterPath: "docs/SNEAK.md" },
        recordedAtMs: 1,
      },
      // A message into an unknown thread (no in-log binding).
      messageAppend("msg-leak-2", "thread-nowhere", "SNEAK-unknown", MEMBER_A),
      // A forged re-bind: thread.create claiming the GRANTED channel for the
      // owner's existing private thread (earliest-binding must win).
      chatOp("chat.thread.create", {
        threadId: "thread-private-1",
        title: "",
        createdAtMs: 1,
        channelSlug: "team",
        channelWireId: SHARED_WIRE,
      }),
    ];
    for (const op of attempts) {
      const response = await h(
        request(
          MEMBER_A,
          `/sync/shares/${shareId}/log`,
          jsonBody({
            originId: "origin-member-a",
            // A valid op FIRST: the invalid one must reject the whole batch.
            ops: [
              { ...messageAppend("msg-ok", "thread-shared-1", "fine", MEMBER_A), originSeq: 0 },
              { ...op, originSeq: 1 },
            ],
          }),
        ),
      );
      expect(response.status, JSON.stringify(op)).toBe(403);
      expect((await json(response)).code).toBe("share_op_rejected");
    }
    // NOTHING was admitted — not even the valid leading ops.
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    const serialized = JSON.stringify(ownerLog);
    expect(serialized).not.toContain("SNEAK");
    expect(serialized).not.toContain("msg-ok");

    // And after the forged re-bind ATTEMPT, the private thread's messages are
    // still invisible through the share (the attempt never persisted, and
    // earliest-binding would exclude them even if it had).
    const memberView = JSON.stringify(
      await json(await h(request(MEMBER_A, `/sync/shares/${shareId}/log?since=0&limit=100`))),
    );
    expect(memberView).not.toContain("SENTINEL-private-message");
  });

  it("rejects a same-batch re-bind of a file-linked thread before derived ops can target it", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    const response = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-file-rebind",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.thread.create",
              payload: {
                threadId: "thread-file-private",
                title: "",
                createdAtMs: 10,
                channelSlug: "team",
                channelWireId: SHARED_WIRE,
              },
              recordedAtMs: 10,
            },
            {
              originSeq: 1,
              opKind: "chat.decision.set",
              payload: {
                threadId: "thread-file-private",
                messageId: "SENTINEL-FILE-MESSAGE",
                state: "resolved",
                resolvedByMessageId: "SENTINEL-FILE-RESOLUTION",
                atMs: 11,
              },
              recordedAtMs: 11,
            },
            {
              originSeq: 2,
              opKind: "chat.attachment.add",
              payload: {
                attachmentId: "SENTINEL-FILE-ATTACHMENT",
                threadId: "thread-file-private",
                messageId: "SENTINEL-FILE-MESSAGE",
                targetKind: "file",
                objectId: "SENTINEL-FILE-OBJECT",
                pathHint: "private/SENTINEL-FILE-PATH.md",
                createdAtMs: 12,
              },
              recordedAtMs: 12,
            },
          ],
        }),
      ),
    );
    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe("share_op_rejected");
    const ownerLog = await json(
      await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)),
    );
    expect(JSON.stringify(ownerLog)).not.toContain("SENTINEL-FILE-");
  });

  it("accepts a member re-pushing a legitimate chat.channel.create for the SAME granted wire id", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareA = await createChannelShare(h, MEMBER_A);
    const shareB = await createChannelShare(h, MEMBER_B);

    // The member's own journal legitimately holds a channel.create for the
    // granted wire id (every joiner's local store mints one); re-pushing it
    // must be admitted, not rejected as out-of-scope.
    const append = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareA}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [
            { ...channelCreate(SHARED_WIRE, "team"), originSeq: 0 },
            { ...messageAppend("msg-after-cc", "thread-shared-1", "after re-create", MEMBER_A), originSeq: 1 },
          ],
        }),
      ),
    );
    expect(append.status).toBe(200);
    expect(await json(append)).toMatchObject({ ok: true, accepted: 2, inserted: 2 });

    // Every other member is served BOTH channel.creates, each carrying the
    // GRANTED wire id — the engine's wire-id identity (insert-if-absent)
    // makes them one channel, so the duplicate can never mint or corrupt a
    // channel row on any member's machine.
    const opsForB = await fetchSharePage(h, MEMBER_B, shareB);
    const creates = opsForB.filter((op) => op.opKind === "chat.channel.create");
    expect(creates).toHaveLength(2);
    for (const create of creates) expect(create.payload.wireId).toBe(SHARED_WIRE);
    const bodies = opsForB
      .filter((op) => op.opKind === "chat.message.append")
      .map((op) => op.payload.body);
    expect(bodies).toContain("after re-create");
  });

  it("serves chat ops rebuilt from an explicit allowlist — unexpected payload fields never leak", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    // A stored op that grew an internal-only field (audit metadata, device
    // id, ...): the share filter must rebuild the served payload from its
    // per-kind allowlist instead of passing the record through verbatim.
    const extra = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/log`,
        jsonBody({
          originId: "origin-owner",
          ops: [
            chatOp("chat.message.append", {
              messageId: "msg-extra",
              threadId: "thread-shared-1",
              authorKind: "human",
              authorDisplayName: "Owner",
              authorUserId: OWNER,
              body: "public body",
              createdAtMs: 9,
              SENTINELInternalDeviceId: "device-123",
            }),
          ],
        }),
      ),
    );
    expect(extra.status).toBe(200);
    const shareId = await createChannelShare(h, MEMBER_A);
    const served = JSON.stringify(await fetchSharePage(h, MEMBER_A, shareId));
    expect(served).toContain("public body");
    expect(served).not.toContain("SENTINELInternalDeviceId");
    expect(served).not.toContain("device-123");
  });

  it("never serves a blob through a chat-channel share (chat ops are blob-free)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    // Upload a real blob to the owner bucket and reference it from a file op
    // so a leaking chat share would have something to reach.
    const content = "file blob content";
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(content).digest("hex");
    const put = await h(
      request(OWNER, `/sync/${WORKSPACE}/blobs/${sha}`, { method: "PUT", body: content }),
    );
    expect(put.status).toBe(200);
    const shareId = await createChannelShare(h, MEMBER_A);

    const unknown = await denialBytes(
      await h(request(MEMBER_A, `/sync/shares/${shareId}/blobs/${"9".repeat(64)}`)),
    );
    expect(
      await denialBytes(await h(request(MEMBER_A, `/sync/shares/${shareId}/blobs/${sha}`))),
    ).toBe(unknown);
  });

  it("closes a revoked member's view on the next fetch AND next append, byte-identically to never-existed", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);
    expect((await h(request(MEMBER_A, `/sync/shares/${shareId}/log?since=0`))).status).toBe(200);

    const revoke = await h(request(OWNER, `/sync/shares/${shareId}/revoke`, { method: "POST" }));
    expect(revoke.status).toBe(200);

    const missing = await denialBytes(await h(request(MEMBER_A, "/sync/shares/share-404/log?since=0")));
    expect(await denialBytes(await h(request(MEMBER_A, `/sync/shares/${shareId}/log?since=0`)))).toBe(missing);
    const appendBody = jsonBody({
      originId: "origin-member-a",
      ops: [messageAppend("msg-late", "thread-shared-1", "after revoke", MEMBER_A)],
    });
    const missingAppend = await denialBytes(
      await h(request(MEMBER_A, "/sync/shares/share-404/log", appendBody)),
    );
    expect(await denialBytes(await h(request(MEMBER_A, `/sync/shares/${shareId}/log`, appendBody)))).toBe(
      missingAppend,
    );
    // Gone from the member's received list; stamped in the owner's.
    const received = (await json(await h(request(MEMBER_A, "/sync/shares")))).received as unknown[];
    expect(received).toEqual([]);
  });

  it("aborts an in-flight member append when the share is revoked mid-request (revocation race)", async () => {
    const storage = await testStorage();
    // The revoke fires DURING the append validation (on the thread-binding
    // lookup), after the entry check — the pre-append re-check must fail
    // closed and nothing may land.
    const racing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "findThreadCreateChannelWireId") {
          return (workspaceId: string, threadId: string) => {
            const result = target.findThreadCreateChannelWireId(workspaceId, threadId);
            target.revokeShare("share-0", 6000);
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = handler(racing);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);
    expect(shareId).toBe("share-0");

    const raced = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [messageAppend("msg-raced", "thread-shared-1", "raced append", MEMBER_A)],
        }),
      ),
    );
    expect(raced.status).toBe(404);
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    expect(JSON.stringify(ownerLog)).not.toContain("raced append");
  });

  it("rejects a member append when the revoke lands after every route-level check, inside the write transaction (TOCTOU)", async () => {
    const storage = await testStorage();
    // The revoke commits at the LAST possible instant: after the route's
    // final shareForRecipient re-check, immediately before the transactional
    // insert. Only the in-transaction guard (running under appendLogBatch's
    // BEGIN IMMEDIATE write lock) can still stop the write.
    const raced = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "appendLogBatch") {
          return (input: Parameters<SyncRelayStorage["appendLogBatch"]>[0]) => {
            target.revokeShare("share-0", 6000);
            return target.appendLogBatch(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = handler(raced);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);
    expect(shareId).toBe("share-0");

    const response = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-member-a",
          ops: [messageAppend("msg-toctou", "thread-shared-1", "toctou append", MEMBER_A)],
        }),
      ),
    );
    expect(response.status).toBe(404);
    // NOTHING landed in the owner's bucket — the transaction rolled back.
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    expect(JSON.stringify(ownerLog)).not.toContain("toctou append");

    // The guard is not a one-way trip: an honest member on an UNREVOKED share
    // still appends end-to-end through the same transactional path.
    const otherShare = await createChannelShare(h, MEMBER_B);
    const honest = await h(
      request(
        MEMBER_B,
        `/sync/shares/${otherShare}/log`,
        jsonBody({
          originId: "origin-member-b",
          ops: [{ ...messageAppend("msg-honest", "thread-shared-1", "honest append", MEMBER_B), originSeq: 0 }],
        }),
      ),
    );
    expect(honest.status).toBe(200);
    const afterLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    expect(JSON.stringify(afterLog)).toContain("honest append");
  });

  it("keeps member origins namespaced so a member can never extend or collide with an owner origin", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await seedOwnerWorkspace(h);
    const shareId = await createChannelShare(h, MEMBER_A);

    // The member deliberately claims the OWNER's origin id.
    const hijack = await h(
      request(
        MEMBER_A,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-owner",
          ops: [{ ...messageAppend("msg-hijack", "thread-shared-1", "hijack attempt", MEMBER_A), originSeq: 0 }],
        }),
      ),
    );
    // Accepted — but under `share:<shareId>:origin-owner`, NOT the owner's
    // real origin, whose sequence space stays untouched.
    expect(hijack.status).toBe(200);
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`)));
    const ops = ownerLog.ops as Array<{ originId: string; originSeq: number }>;
    const ownerOps = ops.filter((op) => op.originId === "origin-owner");
    const hijacked = ops.filter((op) => op.originId === `share:${shareId}:origin-owner`);
    expect(hijacked).toHaveLength(1);
    // The owner's own origin still appends contiguously where it left off.
    const nextSeq = Math.max(...ownerOps.map((op) => op.originSeq)) + 1;
    const ownerAppend = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/log`,
        jsonBody({
          originId: "origin-owner",
          ops: [{ ...messageAppend("msg-owner-2", "thread-shared-1", "owner continues", OWNER), originSeq: nextSeq }],
        }),
      ),
    );
    expect(ownerAppend.status).toBe(200);
  });
});
