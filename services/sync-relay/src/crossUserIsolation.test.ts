import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/workspace-engine/linkedChatStore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresenceHub } from "./presence";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

// MU-C5 — the CONSOLIDATED cross-user isolation sweep. The per-lane suites
// (MU-C0 authorship, MU-C1 presence, MU-C2 reactions, MU-C3 DMs, MU-C4 shared
// channels) each proved one invariant against one surface. This file proves the
// cross-cutting invariants hold TOGETHER — across path shares AND chat-channel
// shares AND DMs at once — using planted SENTINEL values so a leak is a literal
// substring match, not an inference. It deliberately does NOT re-run the
// per-lane matrices; it is the sentinel proof that ties them together.
//
// The six invariants (one describe block each):
//   1. Byte-identical denial: every share-scoped route denies a non-recipient
//      IDENTICALLY to a share that never existed — same status, same body,
//      before parsing body/origin. A stale agent-channel grant does too.
//   2. No-forge (MU-C0): a member cannot append a chat op authored as another
//      user; the member-append gate rejects it 403 authorship_mismatch.
//   3. Revocation closes cleanly: after revoke, read AND append both fail
//      byte-identically to an absent share.
//   4. filterOpForShare leak sentinels: across EVERY served op kind, the served
//      payload excludes every planted internal SENTINEL-* value.
//   5. Presence never journaled: after presence traffic on a workspace scope
//      AND a share scope, no durable table holds a presence row.
//   6. In-request revoke race (closed): a revoke that lands between the
//      member-append route's entry and its transactional insert aborts the
//      write via the in-transaction guard.

let roots: string[] = [];
let storages: SyncRelayStorage[] = [];

beforeEach(() => {
  roots = [];
  storages = [];
});

afterEach(async () => {
  // Close sqlite handles before removing temp dirs (Windows EBUSY otherwise).
  for (const storage of storages) storage.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function testStorage(): Promise<{ storage: SyncRelayStorage; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "dohc-sync-relay-muc5-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  const storage = openSyncRelayStorage(dbPath);
  storages.push(storage);
  return { storage, dbPath };
}

// The relay's test-auth seam: identity from the bearer token, emails resolvable
// as "<userId>@dohc.test". A shared PresenceHub can be injected so a test can
// assert the hub holds the ephemeral state the durable tables never see.
function handler(storage: SyncRelayStorage, presence?: PresenceHub): SyncRelayHandler {
  const resolveActor: ResolveActor = (request, workspaceId) => {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
    return { userId: auth.slice("Bearer user:".length), workspaceId };
  };
  let nextShare = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor,
    presence,
    nowMs: () => 4242,
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

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A denial captured as comparable bytes: an unauthorized probe of ANY kind must
// be indistinguishable from a share that never existed. Diffing these strings is
// the whole proof of the byte-identical invariant.
async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

const OWNER = "owner";
const MEMBER = "member";
const STRANGER = "stranger";
const WORKSPACE = "workspace-x";
const GRANTED_WIRE = "channel_wire_granted";
const OTHER_WIRE = "channel_wire_other";
const AGENT_WIRE = AGENT_CHANNEL_WIRE_ID;

async function claimWorkspace(h: SyncRelayHandler): Promise<void> {
  const response = await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
  expect(response.status).toBe(200);
}

async function putBlob(h: SyncRelayHandler, content: string): Promise<string> {
  const sha = sha256(content);
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/blobs/${sha}`, { method: "PUT", body: content }),
  );
  expect(response.status).toBe(200);
  return sha;
}

interface RawOp {
  opKind: string;
  payload: Record<string, unknown>;
}

// Owner appends a contiguous batch (originSeq 0..N) under one origin. Every
// referenced blob must already be uploaded (the append validates it).
async function appendOwner(h: SyncRelayHandler, rawOps: RawOp[]): Promise<void> {
  const ops = rawOps.map((raw, index) => ({
    originSeq: index,
    opKind: raw.opKind,
    payload: raw.payload,
    recordedAtMs: 1000 + index,
  }));
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })),
  );
  expect(response.status).toBe(200);
}

async function createShare(h: SyncRelayHandler, body: Record<string, unknown>): Promise<string> {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody(body)));
  expect(response.status).toBe(200);
  return (await json(response)).shareId as string;
}

// A member-append op: client-sequenced originSeq, relay namespaces the origin.
function memberOp(
  originSeq: number,
  opKind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { originSeq, opKind, payload, recordedAtMs: 5000 + originSeq };
}

function memberAppend(
  h: SyncRelayHandler,
  shareId: string,
  ops: unknown[],
  originId = "origin-member",
): Promise<Response> {
  return h(request(MEMBER, `/sync/shares/${shareId}/log`, jsonBody({ originId, ops })));
}

// ---------------------------------------------------------------------------

describe("MU-C5 · byte-identical denial across every share-scoped route", () => {
  it("denies a non-recipient identically to an absent share, on path, chat-channel, AND DM shares", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const sharedSha = await putBlob(h, "shared body");
    await appendOwner(h, [
      {
        opKind: "moment.append",
        payload: {
          momentId: "m1",
          versionId: "main",
          objectId: "o1",
          path: "docs/shared.md",
          recordedAtMs: 1000,
          operation: "write",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: sharedSha,
          payloadAfterPath: "docs/shared.md",
          metadata: { origin: "user" },
          beforePresent: "null",
        },
      },
      chatChannelCreate(GRANTED_WIRE, "channel"),
      chatThreadCreate(GRANTED_WIRE, "thread-granted"),
      chatChannelCreate("channel_wire_dm", "dm"),
      chatThreadCreate("channel_wire_dm", "thread-dm"),
    ]);
    // Three real, live shares to the SAME member — one of each kind. The denial
    // must not vary by selector kind: it is emitted by shareForRecipient before
    // the selector is ever consulted.
    const pathShare = await createShare(h, { recipientUserId: MEMBER, paths: ["docs"] });
    const chatShare = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: GRANTED_WIRE,
      access: "read-write",
    });
    const dmShare = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: "channel_wire_dm",
      access: "read-write",
    });

    // The baseline: the SAME routes against a share id that never existed.
    const absentId = "never-existed";
    const absent = {
      read: await denialBytes(await h(request(STRANGER, `/sync/shares/${absentId}`))),
      log: await denialBytes(await h(request(STRANGER, `/sync/shares/${absentId}/log?since=0`))),
      // A member-append probe with a DELIBERATELY invalid body: shareForRecipient
      // runs before readJsonObject, so a non-recipient sees the generic 404
      // BEFORE any body/origin/originId parse — never a 400 for the bad body.
      append: await denialBytes(
        await h(
          request(STRANGER, `/sync/shares/${absentId}/log`, {
            method: "POST",
            body: "not-json",
          }),
        ),
      ),
      blob: await denialBytes(
        await h(request(STRANGER, `/sync/shares/${absentId}/blobs/${sharedSha}`)),
      ),
      presence: await denialBytes(
        await h(request(STRANGER, `/sync/shares/${absentId}/presence?topic=docs/shared.md`, jsonBody({ clientId: "x" }))),
      ),
    };

    for (const [kind, shareId] of [
      ["path", pathShare],
      ["chat-channel", chatShare],
      ["dm", dmShare],
    ] as const) {
      expect(
        await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}`))),
        `${kind}: share read`,
      ).toBe(absent.read);
      expect(
        await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}/log?since=0`))),
        `${kind}: share-log GET`,
      ).toBe(absent.log);
      // Invalid body again: proves the 404 precedes the body parse on a REAL
      // share exactly as it does on an absent one.
      expect(
        await denialBytes(
          await h(request(STRANGER, `/sync/shares/${shareId}/log`, { method: "POST", body: "not-json" })),
        ),
        `${kind}: member-append POST (pre-parse)`,
      ).toBe(absent.append);
      expect(
        await denialBytes(await h(request(STRANGER, `/sync/shares/${shareId}/blobs/${sharedSha}`))),
        `${kind}: share-blob`,
      ).toBe(absent.blob);
      expect(
        await denialBytes(
          await h(request(STRANGER, `/sync/shares/${shareId}/presence?topic=docs/shared.md`, jsonBody({ clientId: "x" }))),
        ),
        `${kind}: share presence`,
      ).toBe(absent.presence);
    }

    // The granter probing the recipient routes of their OWN share is a
    // non-recipient too — same generic 404, no self-leak.
    expect(await denialBytes(await h(request(OWNER, `/sync/shares/${chatShare}/log?since=0`)))).toBe(
      absent.log,
    );
    // Unauthenticated probes stay 401 (auth precedes the share lookup); the 404
    // invariant is specifically about AUTHENTICATED non-recipients.
    expect((await h(request(null, `/sync/shares/${chatShare}/log?since=0`))).status).toBe(401);
  });

  it("refuses new agent-channel grants and makes a poisoned legacy grant absent on every recipient route", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const privateBlobSha = await putBlob(h, "agent-private-blob");
    // Pre-provisioned/unknown wires remain grantable for the existing
    // grant-before-sync flow. Once the owner log identifies this wire as an
    // agent channel, the same row must dynamically become recipient-invisible.
    const poisonedShareId = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: AGENT_WIRE,
      access: "read-write",
    });
    await appendOwner(h, [
      chatChannelCreate(AGENT_WIRE, "agent"),
      chatThreadCreate(AGENT_WIRE, "thread-agent"),
      chatMessage("thread-agent", "m-agent", "agent private body", OWNER),
      {
        opKind: "chat.reaction.set",
        payload: {
          reactionId: "reaction-agent",
          messageId: "m-agent",
          threadId: "thread-agent",
          emoji: "x",
          authorId: OWNER,
          authorKind: "human",
          authorDisplayName: "Owner",
          state: "added",
          atMs: 4,
        },
      },
      {
        opKind: "chat.decision.set",
        payload: {
          threadId: "thread-agent",
          messageId: "m-agent",
          state: "resolved",
          resolvedByMessageId: "m-agent-resolution",
          atMs: 5,
        },
      },
      {
        opKind: "chat.attachment.add",
        payload: {
          attachmentId: "attachment-agent",
          threadId: "thread-agent",
          messageId: "m-agent",
          targetKind: "file",
          objectId: "object-agent-private",
          pathHint: "private/agent.md",
          createdAtMs: 6,
        },
      },
      // Earliest create is authoritative: a later forged human-kind recreate
      // must not make the owner-only agent wire shareable.
      chatChannelCreate(AGENT_WIRE, "channel"),
    ]);

    const refused = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({
          recipientUserId: MEMBER,
          channelWireId: AGENT_WIRE,
          access: "read-write",
        }),
      ),
    );
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ ok: false, code: "invalid_channel" });

    const absentId = "never-existed";
    const absent = {
      read: await denialBytes(await h(request(MEMBER, `/sync/shares/${absentId}`))),
      log: await denialBytes(await h(request(MEMBER, `/sync/shares/${absentId}/log?since=0`))),
      append: await denialBytes(
        await h(
          request(MEMBER, `/sync/shares/${absentId}/log`, {
            method: "POST",
            body: "not-json",
          }),
        ),
      ),
      blob: await denialBytes(
        await h(request(MEMBER, `/sync/shares/${absentId}/blobs/${privateBlobSha}`)),
      ),
      presence: await denialBytes(
        await h(
          request(
            MEMBER,
            `/sync/shares/${absentId}/presence?topic=${AGENT_WIRE}`,
            jsonBody({ clientId: "member-agent" }),
          ),
        ),
      ),
    };

    expect(
      await denialBytes(await h(request(MEMBER, `/sync/shares/${poisonedShareId}`))),
    ).toBe(absent.read);
    expect(
      await denialBytes(
        await h(request(MEMBER, `/sync/shares/${poisonedShareId}/log?since=0`)),
      ),
    ).toBe(absent.log);
    expect(
      await denialBytes(
        await h(
          request(MEMBER, `/sync/shares/${poisonedShareId}/log`, {
            method: "POST",
            body: "not-json",
          }),
        ),
      ),
    ).toBe(absent.append);
    expect(
      await denialBytes(
        await h(request(MEMBER, `/sync/shares/${poisonedShareId}/blobs/${privateBlobSha}`)),
      ),
    ).toBe(absent.blob);
    expect(
      await denialBytes(
        await h(
          request(
            MEMBER,
            `/sync/shares/${poisonedShareId}/presence?topic=${AGENT_WIRE}`,
            jsonBody({ clientId: "member-agent" }),
          ),
        ),
      ),
    ).toBe(absent.presence);
    const listed = await json(await h(request(MEMBER, "/sync/shares")));
    expect(listed.received).toEqual([]);
  });

  it("keeps a malformed earliest channel create permanently unshareable", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const malformedWire = "channel_wire_malformed_first";
    const shareId = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: malformedWire,
      access: "read-write",
    });
    await appendOwner(h, [
      {
        opKind: "chat.channel.create",
        // Missing the channelId/name/slug/createdAtMs replay shape: its claimed
        // human kind must never be trusted or skipped in favor of a later row.
        payload: { wireId: malformedWire, kind: "channel" },
      },
      chatChannelCreate(malformedWire, "agent"),
    ]);
    expect(storage.findChannelCreateKind(WORKSPACE, malformedWire)).toBeNull();

    const refused = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({
          recipientUserId: MEMBER,
          channelWireId: malformedWire,
          access: "read-write",
        }),
      ),
    );
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ ok: false, code: "invalid_channel" });

    const absent = await denialBytes(
      await h(request(MEMBER, "/sync/shares/never-existed/log?since=0")),
    );
    expect(
      await denialBytes(await h(request(MEMBER, `/sync/shares/${shareId}/log?since=0`))),
    ).toBe(absent);
    const listed = await json(await h(request(MEMBER, "/sync/shares")));
    expect(listed.received).toEqual([]);
  });
});

describe("MU-C5 · no-forge authorship at the member-append gate (MU-C0)", () => {
  it("rejects a member chat op authored as another participant, 403 authorship_mismatch", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    await appendOwner(h, [
      chatChannelCreate(GRANTED_WIRE, "dm"),
      chatThreadCreate(GRANTED_WIRE, "thread-granted"),
      chatMessage("thread-granted", "m-owner", "hello", OWNER),
    ]);
    const shareId = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: GRANTED_WIRE,
      access: "read-write",
    });

    // A message forged to speak as the OWNER: rejected at the authorship gate
    // (server-derived pusher is MEMBER, payload claims OWNER).
    const forgedMessage = await memberAppend(h, shareId, [
      memberOp(0, "chat.message.append", {
        messageId: "forge-1",
        threadId: "thread-granted",
        authorKind: "human",
        authorDisplayName: "Not Me",
        authorUserId: OWNER,
        body: "SENTINEL-FORGED-MESSAGE",
        createdAtMs: 5000,
      }),
    ]);
    expect(forgedMessage.status).toBe(403);
    expect((await json(forgedMessage)).code).toBe("authorship_mismatch");

    // A reaction forged to another author: authorId is REQUIRED and must equal
    // the pusher, so a forged (and a missing) author id both fail closed.
    const forgedReaction = await memberAppend(h, shareId, [
      memberOp(0, "chat.reaction.set", {
        reactionId: "forge-r",
        messageId: "m-owner",
        threadId: "thread-granted",
        emoji: "👍",
        authorId: OWNER,
        authorKind: "human",
        authorDisplayName: "Not Me",
        state: "added",
        atMs: 5000,
      }),
    ]);
    expect(forgedReaction.status).toBe(403);
    expect((await json(forgedReaction)).code).toBe("authorship_mismatch");

    // Nothing from either rejected batch was admitted.
    const page = await json(await h(request(MEMBER, `/sync/shares/${shareId}/log?since=0`)));
    expect(JSON.stringify(page)).not.toContain("SENTINEL-FORGED-MESSAGE");

    // The honest path (author == pusher) still lands, proving the gate rejects
    // ONLY the forgery, not the member's own authored writes.
    const honest = await memberAppend(h, shareId, [
      memberOp(0, "chat.message.append", {
        messageId: "honest-1",
        threadId: "thread-granted",
        authorKind: "human",
        authorDisplayName: "Member",
        authorUserId: MEMBER,
        body: "honest hello",
        createdAtMs: 5001,
      }),
    ]);
    expect(honest.status).toBe(200);
  });
});

describe("MU-C5 · revocation closes read AND append byte-identically", () => {
  it("after revoke, a chat-channel share read and member append both match an absent share", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    await appendOwner(h, [
      chatChannelCreate(GRANTED_WIRE, "channel"),
      chatThreadCreate(GRANTED_WIRE, "thread-granted"),
    ]);
    const shareId = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: GRANTED_WIRE,
      access: "read-write",
    });

    // Live: read and append both work.
    expect((await h(request(MEMBER, `/sync/shares/${shareId}/log?since=0`))).status).toBe(200);
    expect(
      (
        await memberAppend(h, shareId, [
          memberOp(0, "chat.message.append", {
            messageId: "pre-revoke",
            threadId: "thread-granted",
            authorKind: "human",
            authorDisplayName: "Member",
            authorUserId: MEMBER,
            body: "before revoke",
            createdAtMs: 5000,
          }),
        ])
      ).status,
    ).toBe(200);

    const revoke = await h(request(OWNER, `/sync/shares/${shareId}/revoke`, jsonBody({})));
    expect(revoke.status).toBe(200);

    const absentRead = await denialBytes(await h(request(MEMBER, "/sync/shares/never-existed")));
    const absentAppend = await denialBytes(
      await h(request(MEMBER, "/sync/shares/never-existed/log", jsonBody({ originId: "o", ops: [] }))),
    );
    // BOTH surfaces close, byte-identically to a share that never existed.
    expect(await denialBytes(await h(request(MEMBER, `/sync/shares/${shareId}`)))).toBe(absentRead);
    expect(
      await denialBytes(
        await h(
          request(MEMBER, `/sync/shares/${shareId}/log`, jsonBody({ originId: "origin-member", ops: [
            memberOp(1, "chat.message.append", {
              messageId: "post-revoke",
              threadId: "thread-granted",
              authorKind: "human",
              authorDisplayName: "Member",
              authorUserId: MEMBER,
              body: "after revoke",
              createdAtMs: 5001,
            }),
          ] })),
        ),
      ),
    ).toBe(absentAppend);
  });
});

describe("MU-C5 · served payloads leak no planted sentinel across every op kind", () => {
  it("excludes every internal SENTINEL-* value from path/version AND chat-channel served views", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);

    const keepSha = await putBlob(h, "kept snapshot");
    const dropSha = await putBlob(h, "dropped snapshot");
    const outSha = await putBlob(h, "out of share body");
    const cipherSha = await putBlob(h, "ciphertext-bytes");

    await appendOwner(h, [
      // A payload-free bootstrap op (served as {} to a version share).
      { opKind: "workspace.init", payload: { note: "SENTINEL-INIT-NOTE" } },
      // version.create: name + snapshot metadata + the out-of-selector snapshot
      // (private/secret.md) must all be redacted; only in-selector path + blob
      // survive.
      {
        opKind: "version.create",
        payload: {
          versionId: "version-1",
          name: "SENTINEL-VERSION-NAME",
          kind: "named",
          createdAtMs: 1,
          forkSnapshots: [
            {
              objectId: "SENTINEL-SNAP-OBJECT",
              path: "docs/a.md",
              blobSha256: keepSha,
              updatedAtMs: 1,
              latestMomentId: "SENTINEL-LATEST-MOMENT",
              metadata: { note: "SENTINEL-SNAP-META" },
            },
            {
              objectId: "o2",
              path: "private/secret.md",
              blobSha256: dropSha,
              updatedAtMs: 1,
              latestMomentId: "m2",
              metadata: {},
            },
          ],
        },
      },
      // moment.append in-selector: author/correlation/device/moment/object ids
      // are all dropped; only the change description survives.
      {
        opKind: "moment.append",
        payload: {
          momentId: "SENTINEL-MOMENT-ID",
          versionId: "version-1",
          objectId: "SENTINEL-OBJECT-ID",
          path: "docs/a.md",
          recordedAtMs: 1000,
          operation: "write",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: keepSha,
          payloadAfterPath: "docs/a.md",
          metadata: {
            origin: "user",
            correlationId: "SENTINEL-CORRELATION-ID",
            deviceId: "SENTINEL-DEVICE-ID",
          },
          authorUserId: "SENTINEL-MOMENT-AUTHOR",
          beforePresent: "null",
        },
      },
      // moment.append OUT of selector: the whole op (path, blob, summary) is
      // dropped from a docs-only version share.
      {
        opKind: "moment.append",
        payload: {
          momentId: "m-out",
          versionId: "version-1",
          objectId: "o-out",
          path: "private/secret.md",
          recordedAtMs: 1001,
          operation: "write",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: outSha,
          payloadAfterPath: "private/secret.md",
          metadata: { origin: "user", summary: "SENTINEL-OUT-OF-SHARE-MOMENT" },
          beforePresent: "null",
        },
      },
      // secret.file.put: never crosses any share; its ciphertext hash + path
      // must stay hidden.
      {
        opKind: "secret.file.put",
        payload: {
          versionId: "main",
          path: "docs/.env",
          metadata: { origin: "user" },
          ivBase64: "AA==",
          authTagBase64: "AA==",
          ciphertextSha256: cipherSha,
          byteLength: 16,
        },
      },
      // The granted channel's chat ops — each carries an internal field the
      // served allowlist must strip.
      chatChannelCreate(GRANTED_WIRE, "channel", { secretOwnerField: "SENTINEL-CHANNEL-INTERNAL" }),
      chatThreadCreate(GRANTED_WIRE, "thread-granted", { internalThreadMeta: "SENTINEL-THREAD-INTERNAL" }),
      chatMessage("thread-granted", "m-granted", "hello", OWNER, {
        internalCorrelation: "SENTINEL-MSG-CORRELATION",
        deviceId: "SENTINEL-MSG-DEVICE",
      }),
      {
        opKind: "chat.reaction.set",
        payload: {
          reactionId: "r-granted",
          messageId: "m-granted",
          threadId: "thread-granted",
          emoji: "👍",
          authorId: OWNER,
          authorKind: "human",
          authorDisplayName: "Owner",
          state: "added",
          atMs: 4,
          internalReactionMeta: "SENTINEL-REACTION-INTERNAL",
        },
      },
      // A DIFFERENT channel's ops — its wire id + body must never cross the
      // granted-channel share.
      chatChannelCreate(OTHER_WIRE, "channel"),
      chatThreadCreate(OTHER_WIRE, "thread-other"),
      chatMessage("thread-other", "m-other", "SENTINEL-OTHER-CHANNEL-BODY", OWNER, {
        parentMessageId: "SENTINEL-OTHER-PARENT",
      }),
      {
        opKind: "chat.decision.set",
        payload: {
          threadId: "thread-other",
          messageId: "m-other",
          state: "resolved",
          resolvedByMessageId: "SENTINEL-OTHER-RESOLVED-BY",
          atMs: 5,
        },
      },
      {
        opKind: "chat.attachment.add",
        payload: {
          attachmentId: "attachment-other",
          threadId: "thread-other",
          messageId: "m-other",
          targetKind: "file",
          objectId: "SENTINEL-OTHER-ATTACHMENT-OBJECT",
          pathHint: "private/SENTINEL-OTHER-ATTACHMENT-PATH.md",
          createdAtMs: 6,
        },
      },
      // Agent channels stay on the owner's own-device lane. These sentinels
      // must not cross even if another share row targets the same workspace.
      chatChannelCreate(AGENT_WIRE, "agent"),
      chatThreadCreate(AGENT_WIRE, "thread-agent"),
      chatMessage("thread-agent", "m-agent", "SENTINEL-AGENT-BODY", OWNER, {
        parentMessageId: "SENTINEL-AGENT-PARENT",
      }),
      {
        opKind: "chat.decision.set",
        payload: {
          threadId: "thread-agent",
          messageId: "m-agent",
          state: "resolved",
          resolvedByMessageId: "SENTINEL-AGENT-RESOLVED-BY",
          atMs: 7,
        },
      },
      {
        opKind: "chat.attachment.add",
        payload: {
          attachmentId: "attachment-agent",
          threadId: "thread-agent",
          messageId: "m-agent",
          targetKind: "file",
          objectId: "SENTINEL-AGENT-ATTACHMENT-OBJECT",
          pathHint: "private/SENTINEL-AGENT-ATTACHMENT-PATH.md",
          createdAtMs: 8,
        },
      },
    ]);

    // Two shares to the same member, covering ALL served op kinds:
    //   - a version share (workspace.init, version.create, moment.append)
    //   - a chat-channel share (channel/thread/message/reaction for one channel)
    const versionShare = await createShare(h, {
      recipientUserId: MEMBER,
      paths: ["docs"],
      versionId: "version-1",
    });
    const chatShare = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: GRANTED_WIRE,
      access: "read-write",
    });

    // Every planted internal value. NONE may appear in EITHER served view —
    // cross-checking the full set against both proves no kind of leak crosses
    // any share kind.
    const SENTINELS = [
      "SENTINEL-INIT-NOTE",
      "SENTINEL-VERSION-NAME",
      "SENTINEL-SNAP-OBJECT",
      "SENTINEL-LATEST-MOMENT",
      "SENTINEL-SNAP-META",
      "SENTINEL-MOMENT-ID",
      "SENTINEL-OBJECT-ID",
      "SENTINEL-CORRELATION-ID",
      "SENTINEL-DEVICE-ID",
      "SENTINEL-MOMENT-AUTHOR",
      "SENTINEL-OUT-OF-SHARE-MOMENT",
      "SENTINEL-CHANNEL-INTERNAL",
      "SENTINEL-THREAD-INTERNAL",
      "SENTINEL-MSG-CORRELATION",
      "SENTINEL-MSG-DEVICE",
      "SENTINEL-REACTION-INTERNAL",
      "SENTINEL-OTHER-CHANNEL-BODY",
      "SENTINEL-OTHER-PARENT",
      "SENTINEL-OTHER-RESOLVED-BY",
      "SENTINEL-OTHER-ATTACHMENT-OBJECT",
      "SENTINEL-OTHER-ATTACHMENT-PATH",
      "SENTINEL-AGENT-BODY",
      "SENTINEL-AGENT-PARENT",
      "SENTINEL-AGENT-RESOLVED-BY",
      "SENTINEL-AGENT-ATTACHMENT-OBJECT",
      "SENTINEL-AGENT-ATTACHMENT-PATH",
      "private/secret.md", // out-of-share path
      "docs/.env", // secret path
      OTHER_WIRE, // another channel's wire id
      AGENT_WIRE, // an owner-only agent channel's wire id
      dropSha, // out-of-selector snapshot blob
      outSha, // out-of-selector moment blob
      cipherSha, // a blob hash outside the share
    ];

    const versionView = JSON.stringify(
      await json(await h(request(MEMBER, `/sync/shares/${versionShare}/log?since=0&limit=500`))),
    );
    const chatView = JSON.stringify(
      await json(await h(request(MEMBER, `/sync/shares/${chatShare}/log?since=0&limit=500`))),
    );

    for (const sentinel of SENTINELS) {
      expect(versionView, `version share leaked ${sentinel}`).not.toContain(sentinel);
      expect(chatView, `chat share leaked ${sentinel}`).not.toContain(sentinel);
    }

    // Sanity: the shares DID serve their legitimate content, so the "no leak"
    // proof is against real, populated payloads — not an empty response.
    expect(versionView).toContain("docs/a.md");
    expect(versionView).toContain(keepSha);
    expect(chatView).toContain(GRANTED_WIRE);
    expect(chatView).toContain("hello");
  });
});

describe("MU-C5 · presence is never journaled to any durable table", () => {
  it("workspace-scope AND share-scope presence leave zero presence rows in every table", async () => {
    const { storage, dbPath } = await testStorage();
    const presence = new PresenceHub();
    const h = handler(storage, presence);
    await claimWorkspace(h);
    // A durable moment so the log genuinely holds rows — the point is that it
    // holds NO presence rows, not that the workspace is empty.
    const sha = await putBlob(h, "doc body");
    await appendOwner(h, [
      {
        opKind: "moment.append",
        payload: {
          momentId: "m1",
          versionId: "main",
          objectId: "o1",
          path: "notes/a.md",
          recordedAtMs: 1000,
          operation: "write",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: sha,
          payloadAfterPath: "notes/a.md",
          metadata: { origin: "user" },
          beforePresent: "null",
        },
      },
    ]);
    const shareId = await createShare(h, { recipientUserId: MEMBER, paths: ["notes/a.md"] });

    const PRESENCE_SENTINEL = "SENTINEL-PRESENCE-STATE";
    // Owner publishes + polls on the workspace scope.
    await h(
      request(OWNER, "/sync/workspace-x/presence?topic=notes/a.md", jsonBody({ clientId: "o", state: { note: PRESENCE_SENTINEL } })),
    );
    await h(request(OWNER, "/sync/workspace-x/presence?topic=notes/a.md&since=0&hold=0", { method: "GET" }));
    // Member publishes + polls on the SHARE scope (same underlying scope).
    const topic = encodeURIComponent("notes/a.md");
    await h(
      request(MEMBER, `/sync/shares/${shareId}/presence?topic=${topic}`, jsonBody({ clientId: "m", state: { note: PRESENCE_SENTINEL } })),
    );
    await h(request(MEMBER, `/sync/shares/${shareId}/presence?topic=${topic}&since=0&hold=0`, { method: "GET" }));

    // The state is live in-memory in the hub only.
    expect(presence.stats().entries).toBe(2);

    // The durable log holds the moment but NO presence op.
    const page = storage.fetchLogPage({ workspaceId: WORKSPACE, sinceRelaySeq: 0, limit: 500 });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.some((row) => row.opKind.startsWith("presence"))).toBe(false);

    // Exhaustive: scan EVERY durable table for the presence sentinel. Presence
    // is purely ephemeral, so it must appear in none of them.
    const requireModule = createRequire(import.meta.url);
    interface RawStatement {
      all(...params: unknown[]): Array<Record<string, unknown>>;
    }
    interface RawDb {
      prepare(sql: string): RawStatement;
      close(): void;
    }
    const { DatabaseSync } = requireModule("node:sqlite") as {
      DatabaseSync: new (path: string) => RawDb;
    };
    const raw = new DatabaseSync(dbPath);
    try {
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => String(row.name));
      // The relay's real schema must actually be present (guards against the
      // scan silently passing over an empty db).
      expect(tables).toContain("sync_relay_log");
      const tablesWithSentinel: string[] = [];
      for (const table of tables) {
        const rows = raw.prepare(`SELECT * FROM "${table}"`).all();
        const serialized = JSON.stringify(rows, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        if (serialized.includes(PRESENCE_SENTINEL)) tablesWithSentinel.push(table);
      }
      expect(tablesWithSentinel).toEqual([]);
    } finally {
      raw.close();
    }

    // Leaving drops the ephemeral state entirely — no residue anywhere.
    await h(request(OWNER, "/sync/workspace-x/presence?topic=notes/a.md", jsonBody({ clientId: "o", leave: true })));
    await h(request(MEMBER, `/sync/shares/${shareId}/presence?topic=${topic}`, jsonBody({ clientId: "m", leave: true })));
    expect(presence.stats().entries).toBe(0);
    presence.dispose();
  });
});

describe("MU-C5 · in-request revoke race is closed by the in-transaction guard", () => {
  it("a revoke landing between route entry and the transactional insert aborts the member append", async () => {
    const { storage } = await testStorage();
    // Reproduce the TOCTOU window: the revoke commits at the LAST instant —
    // after every route-level check, immediately before the transactional
    // insert. Only appendLogBatch's in-transaction guard (under BEGIN
    // IMMEDIATE, the same write lock revokeShare takes) can still stop it.
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
    await claimWorkspace(h);
    await appendOwner(h, [
      chatChannelCreate(GRANTED_WIRE, "dm"),
      chatThreadCreate(GRANTED_WIRE, "thread-granted"),
    ]);
    const shareId = await createShare(h, {
      recipientUserId: MEMBER,
      channelWireId: GRANTED_WIRE,
      access: "read-write",
    });
    expect(shareId).toBe("share-0");

    const response = await memberAppend(h, shareId, [
      memberOp(0, "chat.message.append", {
        messageId: "raced",
        threadId: "thread-granted",
        authorKind: "human",
        authorDisplayName: "Member",
        authorUserId: MEMBER,
        body: "SENTINEL-RACE-BODY",
        createdAtMs: 5000,
      }),
    ]);
    // The guard sees the revoke and rolls the whole batch back as the generic
    // 404 — the write never lands.
    expect(response.status).toBe(404);
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=500`)));
    expect(JSON.stringify(ownerLog)).not.toContain("SENTINEL-RACE-BODY");
  });
});

// --- chat op builders (shared across the sentinel + gate tests) --------------

function chatChannelCreate(
  wireId: string,
  kind: string,
  extra: Record<string, unknown> = {},
): RawOp {
  return {
    opKind: "chat.channel.create",
    payload: {
      channelId: `channel-${wireId}`,
      name: `name-${wireId}`,
      slug: `slug-${wireId}`,
      kind,
      createdAtMs: 1,
      wireId,
      ...extra,
    },
  };
}

function chatThreadCreate(
  wireId: string,
  threadId: string,
  extra: Record<string, unknown> = {},
): RawOp {
  return {
    opKind: "chat.thread.create",
    payload: {
      threadId,
      title: "",
      createdAtMs: 2,
      channelSlug: `slug-${wireId}`,
      channelWireId: wireId,
      ...extra,
    },
  };
}

function chatMessage(
  threadId: string,
  messageId: string,
  body: string,
  authorUserId: string,
  extra: Record<string, unknown> = {},
): RawOp {
  return {
    opKind: "chat.message.append",
    payload: {
      messageId,
      threadId,
      authorKind: "human",
      authorDisplayName: "Owner",
      authorUserId,
      body,
      createdAtMs: 3,
      ...extra,
    },
  };
}
