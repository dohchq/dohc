import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINK_DISCUSSION_BODY_CODE_POINT_LIMIT,
  LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
  LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT,
  DISCUSSION_LIFETIME_MESSAGE_LIMIT,
  DISCUSSION_MESSAGE_RATE_LIMIT,
  DISCUSSION_MESSAGE_RATE_WINDOW_MS,
  LINK_DISCUSSION_NAME_BYTE_LIMIT,
  LINK_DISCUSSION_NAME_CODE_POINT_LIMIT,
  LINK_DISCUSSION_PAGE_LIMIT,
  LINK_DISCUSSION_PRINCIPAL_LIMIT,
  DISCUSSION_NON_OWNER_SHARE_ROW_LIMIT,
  type OpenSyncRelayStorageOptions,
  type SyncRelayLinkSessionRow,
  type SyncRelayStorage,
} from "./storage";
import {
  seedDependentGrant,
  linkWritesPausedAtMs,
  closeTestStorage,
  closeTestStorages,
  countRows,
  inspect,
  inspectDatabase,
  reopenTestStorage,
  seedLinkGrant,
  seedLinkSession,
  storagePath,
  testStorage,
} from "./testing";

const OWNER = "owner";
const RECIPIENT = "recipient";

afterEach(closeTestStorages);
async function openStorage(
  options: OpenSyncRelayStorageOptions = {},
): Promise<{ storage: SyncRelayStorage; dbPath: string }> {
  let id = 0;
  const storage = await testStorage({
    ...options,
    newDiscussionId: options.newDiscussionId ?? (() => `discussion-id-${++id}`),
  });
  return { storage, dbPath: storagePath(storage) };
}

function profileHash(profile: string): string {
  return createHash("sha256").update(`profile:${profile}`).digest("base64url");
}

function capabilityHash(capability: string): string {
  return createHash("sha256").update(`capability:${capability}`).digest("base64url");
}

function seedShare(
  storage: SyncRelayStorage,
  input: {
    suffix?: string;
    access?: "view" | "comment" | "edit";
    createdAtMs?: number;
  } = {},
): { workspaceId: string; shareId: string; grantId: string; capabilityHash: string } {
  const suffix = input.suffix ?? "a";
  const workspaceId = `workspace-${suffix}`;
  const shareId = `share-${suffix}`;
  const grantId = `link-${suffix}`;
  const createdAtMs = input.createdAtMs ?? 1_000;
  expect(storage.claimWorkspace({ workspaceId, ownerUserId: OWNER, createdAtMs })).toBe("created");
  storage.createShare({
    share: {
      shareId,
      workspaceId,
      granterUserId: OWNER,
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
      createdAtMs,
    },
    grant: {
      grantId: `named-${suffix}`,
      shareId,
      principalKind: "user",
      principalUserId: RECIPIENT,
      principalEmail: null,
      access: "comment",
      generation: 1,
      status: "active",
      createdAtMs,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  seedLinkGrant(storage, {
    grantId,
    shareId,
    access: input.access ?? "comment",
    createdAtMs: createdAtMs + 1,
    credentialId: `credential-${suffix}`,
    secretSealed: null,
    secretHash: `secret-hash-${suffix}`,
  });
  const hash = capabilityHash(`capability-${suffix}`);
  seedLinkSession(storage, {
    grantId,
    capabilityHash: hash,
    sessionId: `session-${suffix}`,
    mintedAtMs: createdAtMs + 2,
    expiresAtMs: createdAtMs + 1_000_000,
  });
  return { workspaceId, shareId, grantId, capabilityHash: hash };
}

function append(
  storage: SyncRelayStorage,
  seeded: ReturnType<typeof seedShare>,
  input: {
    profile?: string;
    capabilityHash?: string;
    claimedName?: string | null;
    body?: string;
    idempotencyKey?: string;
    createdAtMs?: number;
  } = {},
) {
  return storage.appendLinkDiscussionMessage({
    capabilityHash: input.capabilityHash ?? seeded.capabilityHash,
    profileTokenHash: profileHash(input.profile ?? "profile-a"),
    claimedName: input.claimedName,
    body: input.body ?? "Hello",
    idempotencyKey: input.idempotencyKey ?? "append-1",
    createdAtMs: input.createdAtMs ?? 2_000,
  });
}

function appendAuthenticated(
  storage: SyncRelayStorage,
  seeded: ReturnType<typeof seedShare>,
  input: {
    authorUserId?: string;
    role?: "owner" | "recipient";
    displayName?: string;
    body?: string;
    idempotencyKey: string;
    createdAtMs: number;
  },
) {
  return storage.appendAuthenticatedDiscussionMessage({
    shareId: seeded.shareId,
    authorUserId: input.authorUserId ?? RECIPIENT,
    displayName: input.displayName ?? "Recipient",
    body: input.body ?? "Hello",
    idempotencyKey: input.idempotencyKey,
    createdAtMs: input.createdAtMs,
    readGuard: () => input.role ?? "recipient",
    appendGuard: () => input.role ?? "recipient",
  });
}

function discussionUsageBytes(dbPath: string): number {
  return inspect(dbPath, (db) => {
    const messageBytes = Number(
      db
        .prepare(
          "SELECT COALESCE(SUM(storage_bytes), 0) AS bytes FROM sync_relay_share_discussion_messages",
        )
        .get()?.bytes ?? 0,
    );
    const principalBytes = Number(
      db
        .prepare(
          `SELECT COALESCE(SUM(storage_bytes), 0) AS bytes
           FROM sync_relay_link_principals`,
        )
        .get()?.bytes ?? 0,
    );
    return messageBytes + principalBytes;
  });
}

function aggregateWorkspaceUsageBytes(dbPath: string, workspaceId: string): number {
  return inspect(dbPath, (db) => {
    return Number(
      db
        .prepare(
          `WITH usage_rows(workspace_id, bytes) AS (
             SELECT workspace_id, byte_length FROM sync_relay_blobs
             UNION ALL
             SELECT workspace_id, length(CAST(payload_json AS BLOB)) FROM sync_relay_log
             UNION ALL
             SELECT workspace_id, length(CAST(envelope_json AS BLOB))
             FROM sync_relay_key_envelopes
             UNION ALL
             SELECT workspace_id, length(CAST(envelope_json AS BLOB))
             FROM sync_relay_key_envelope_history
             UNION ALL
             SELECT workspace_id,
                    length(CAST(replication_epoch AS BLOB)) +
                    length(CAST(stream_identity AS BLOB))
             FROM sync_relay_epoch_supersessions
             UNION ALL
             SELECT share.workspace_id, message.storage_bytes
             FROM sync_relay_share_discussion_messages AS message
             JOIN sync_relay_shares AS share ON share.share_id = message.share_id
             UNION ALL
             SELECT share.workspace_id, principal.storage_bytes
             FROM sync_relay_link_principals AS principal
             JOIN sync_relay_share_grants AS grant ON grant.grant_id = principal.grant_id
             JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
           )
           SELECT COALESCE(SUM(bytes), 0) AS bytes
           FROM usage_rows
           WHERE workspace_id = ?`,
        )
        .get(workspaceId)?.bytes ?? 0,
    );
  });
}

function storedWorkspaceUsageBytes(dbPath: string, workspaceId: string): number {
  return inspect(dbPath, (db) => {
    return Number(
      db
        .prepare(
          `SELECT usage_bytes
           FROM sync_relay_workspace_usage
           WHERE workspace_id = ?`,
        )
        .get(workspaceId)?.usage_bytes ?? -1,
    );
  });
}

function expectExactWorkspaceUsage(dbPath: string, workspaceId: string): number {
  const aggregate = aggregateWorkspaceUsageBytes(dbPath, workspaceId);
  expect(storedWorkspaceUsageBytes(dbPath, workspaceId)).toBe(aggregate);
  return aggregate;
}

function replaceSession(
  storage: SyncRelayStorage,
  currentCapabilityHash: string,
  suffix: string,
  mintedAtMs: number,
): SyncRelayLinkSessionRow {
  const current = storage.findLinkSessionByCapabilityHash(currentCapabilityHash);
  expect(current).not.toBeNull();
  const replacement: SyncRelayLinkSessionRow = {
    sessionId: current!.sessionId,
    capabilityHash: capabilityHash(`replacement-${suffix}`),
    grantId: current!.grantId,
    generation: current!.generation,
    mintedAtMs,
    expiresAtMs: mintedAtMs + 1_000_000,
    principalId: null,
  };
  expect(
    storage.replaceLinkSession({
      currentSession: current!,
      session: replacement,
      guard: () => {},
    }),
  ).toBe(true);
  return storage.findLinkSessionByCapabilityHash(replacement.capabilityHash)!;
}

describe("durable link discussion storage", () => {
  it("stamps one durable revision per current-state change and pages newest-first toward older messages", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "activity" });

    const first = append(storage, seeded, {
      body: "first",
      idempotencyKey: "activity-first",
      createdAtMs: 2_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = storage.appendAuthenticatedDiscussionMessage({
      shareId: seeded.shareId,
      authorUserId: RECIPIENT,
      displayName: "Recipient",
      body: "second",
      idempotencyKey: "activity-second",
      createdAtMs: 2_001,
      readGuard: () => "recipient",
      appendGuard: () => "recipient",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const third = storage.appendAuthenticatedDiscussionMessage({
      shareId: seeded.shareId,
      authorUserId: OWNER,
      displayName: "Owner",
      body: "third",
      idempotencyKey: "activity-third",
      createdAtMs: 2_002,
      readGuard: () => "owner",
      appendGuard: () => "owner",
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;

    const newest = storage.listShareDiscussionMessages({
      shareId: seeded.shareId,
      direction: "newest-first",
      limit: 2,
    });
    expect(newest.activityRevision).toBe(3);
    expect(newest.messages.map((message) => message.body)).toEqual(["third", "second"]);
    expect(newest.nextCursor).toEqual({
      createdAtMs: second.message.createdAtMs,
      messageId: second.message.messageId,
    });
    expect(
      storage
        .listShareDiscussionMessages({
          shareId: seeded.shareId,
          direction: "newest-first",
          before: newest.nextCursor,
          limit: 2,
        })
        .messages.map((message) => message.body),
    ).toEqual(["first"]);

    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        principalId: first.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_100,
      }),
    ).toBe(true);
    expect(
      storage.setShareLinkWritesPaused({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        actorUserId: OWNER,
        pausedAtMs: 2_101,
      }),
    ).toBe(true);
    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        messageId: second.message.messageId,
        deletedAtMs: 2_102,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: second.message.messageId });

    const bounded = storage.listShareDiscussionActivity({
      shareId: seeded.shareId,
      sinceRevision: 3,
      limit: 1,
    });
    expect(bounded).toMatchObject({
      latestRevision: 6,
      cursorRevision: 4,
      hasMore: true,
      messages: [],
      linkCommentsPaused: true,
    });
    expect(bounded.principals).toEqual([
      expect.objectContaining({
        principalId: first.principal.principalId,
        blockedAtMs: 2_100,
        discussionRevision: 4,
      }),
    ]);
    expect(
      storage.listShareDiscussionActivity({
        shareId: seeded.shareId,
        sinceRevision: bounded.cursorRevision,
        limit: 1,
      }),
    ).toMatchObject({
      latestRevision: 6,
      cursorRevision: 6,
      hasMore: false,
      messages: [
        expect.objectContaining({
          messageId: second.message.messageId,
          discussionRevision: 6,
        }),
      ],
      principals: [],
    });

    const stateOnly = seedShare(storage, { suffix: "activity-state-only" });
    expect(
      storage.setShareLinkWritesPaused({
        shareId: stateOnly.shareId,
        workspaceId: stateOnly.workspaceId,
        actorUserId: OWNER,
        pausedAtMs: 2_200,
      }),
    ).toBe(true);
    expect(
      storage.listShareDiscussionActivity({
        shareId: stateOnly.shareId,
        sinceRevision: 0,
        limit: 1,
      }),
    ).toMatchObject({
      latestRevision: 1,
      cursorRevision: 1,
      hasMore: false,
      messages: [],
      principals: [],
      linkCommentsPaused: true,
    });

    const capped = seedShare(storage, { suffix: "activity-capped" });
    const writable = inspectDatabase(dbPath);
    try {
      writable
        .prepare("UPDATE sync_relay_shares SET discussion_revision = ? WHERE share_id = ?")
        .run(Number.MAX_SAFE_INTEGER, capped.shareId);
    } finally {
      writable.close();
    }
    expect(
      storage.setShareLinkWritesPaused({
        shareId: capped.shareId,
        workspaceId: capped.workspaceId,
        actorUserId: OWNER,
        pausedAtMs: 2_201,
      }),
    ).toBe(false);
    expect(storage.getShareDiscussionRevision(capped.shareId)).toBe(Number.MAX_SAFE_INTEGER);

    const delta = storage.listShareDiscussionActivity({
      shareId: seeded.shareId,
      sinceRevision: 3,
      limit: 100,
    });
    expect(delta).toMatchObject({
      latestRevision: 6,
      cursorRevision: 6,
      hasMore: false,
      linkCommentsPaused: true,
    });
    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0]).toMatchObject({
      messageId: second.message.messageId,
      deletedAtMs: 2_102,
      discussionRevision: 6,
    });
    expect(delta.principals).toEqual([
      expect.objectContaining({
        principalId: first.principal.principalId,
        blockedAtMs: 2_100,
        discussionRevision: 4,
      }),
    ]);

    const db = inspectDatabase(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT discussion_revision FROM sync_relay_shares WHERE share_id = ?")
          .get(seeded.shareId)?.discussion_revision,
      ).toBe(6);
      expect(
        db
          .prepare(
            "SELECT discussion_revision FROM sync_relay_share_discussion_messages WHERE message_id = ?",
          )
          .get(second.message.messageId)?.discussion_revision,
      ).toBe(6);
      expect(
        db
          .prepare(
            "SELECT discussion_revision FROM sync_relay_link_principals WHERE principal_id = ?",
          )
          .get(first.principal.principalId)?.discussion_revision,
      ).toBe(4);
    } finally {
      db.close();
    }

    closeTestStorage(storage);
    const reopened = reopenTestStorage(dbPath);
    expect(
      reopened.listShareDiscussionActivity({
        shareId: seeded.shareId,
        sinceRevision: 6,
        limit: 100,
      }),
    ).toMatchObject({
      latestRevision: 6,
      cursorRevision: 6,
      hasMore: false,
      messages: [],
      principals: [],
    });
  });

  it("mints only on a committed Comment append and preserves the binding on refresh", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage);

    expect(storage.listShareDiscussionMessages({ shareId: seeded.shareId, limit: 50 })).toEqual({
      messages: [],
      nextCursor: null,
      linkCommentsPaused: false,
      activityRevision: 0,
    });
    expect(append(storage, seeded, { body: "", idempotencyKey: "refused" })).toMatchObject({
      ok: false,
      reason: "invalid-input",
    });
    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(0);
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(0);
    expect(storage.findLinkSessionByCapabilityHash(seeded.capabilityHash)).toMatchObject({
      principalId: null,
    });

    const first = append(storage, seeded, {
      idempotencyKey: "first",
    });
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      principal: { displayName: null, mintGeneration: 1 },
      message: {
        authorKind: "link",
        linkGrantId: seeded.grantId,
        displayNameSnapshot: "Anonymous",
        body: "Hello",
      },
    });
    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(1);
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(1);
    const principalId = first.ok ? first.principal.principalId : "missing";
    expect(storage.findLinkSessionByCapabilityHash(seeded.capabilityHash)).toMatchObject({
      principalId,
    });

    const refreshed = replaceSession(storage, seeded.capabilityHash, "a", 2_100);
    expect(refreshed.principalId).toBe(principalId);
    const second = append(storage, seeded, {
      capabilityHash: refreshed.capabilityHash,
      profile: "profile-a",
      claimedName: "  A\u0000lice  ",
      idempotencyKey: "second",
      createdAtMs: 2_101,
    });
    expect(second).toMatchObject({
      ok: true,
      replayed: false,
      principal: { principalId, displayName: "Alice" },
      message: { linkPrincipalId: principalId, displayNameSnapshot: "Alice" },
    });
    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(1);
  });

  it("acknowledges a committed replay after a Comment link narrows to View", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage);
    const first = append(storage, seeded, {
      claimedName: "Alice",
      body: "Committed before narrowing",
      idempotencyKey: "lost-before-narrowing",
      createdAtMs: 2_000,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    if (!first.ok) throw new Error("discussion append did not commit");

    const sessionBeforeNarrowing = storage.findLinkSessionByCapabilityHash(seeded.capabilityHash);
    expect(sessionBeforeNarrowing).toMatchObject({
      grantId: seeded.grantId,
      generation: 1,
      principalId: first.principal.principalId,
    });
    expect(
      storage.retuneShareGrant({
        shareId: seeded.shareId,
        grantId: seeded.grantId,
        access: "view",
        changedAtMs: 2_100,
        expectedDependentGrantIds: [],
        guard: () => {},
      }),
    ).toMatchObject({ ok: true, grant: { access: "view", generation: 1 } });
    expect(storage.findLinkSessionByCapabilityHash(seeded.capabilityHash)).toEqual(
      sessionBeforeNarrowing,
    );

    const snapshot = {
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: aggregateWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    };
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Committed before narrowing",
        idempotencyKey: "lost-before-narrowing",
        createdAtMs: 2_101,
      }),
    ).toEqual({ ...first, replayed: true });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Conflicting retry",
        idempotencyKey: "lost-before-narrowing",
        createdAtMs: 2_102,
      }),
    ).toEqual({ ok: false, reason: "idempotency-conflict" });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Genuinely new",
        idempotencyKey: "new-after-narrowing",
        createdAtMs: 2_103,
      }),
    ).toEqual({ ok: false, reason: "not-authorized" });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: aggregateWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(snapshot);
  });

  it("acknowledges a committed replay through pause and block but keeps authority ahead of replay", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage);
    const first = append(storage, seeded, {
      claimedName: "Alice",
      body: "Committed before pause",
      idempotencyKey: "lost-response",
      createdAtMs: 2_000,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(
      storage.setShareLinkWritesPaused({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        actorUserId: OWNER,
        pausedAtMs: 2_100,
      }),
    ).toBe(true);

    const snapshot = {
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: aggregateWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    };
    const replay = append(storage, seeded, {
      claimedName: "Alice",
      body: "Committed before pause",
      idempotencyKey: "lost-response",
      createdAtMs: 2_101,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Conflicting retry",
        idempotencyKey: "lost-response",
        createdAtMs: 2_102,
      }),
    ).toEqual({ ok: false, reason: "idempotency-conflict" });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Genuinely new",
        idempotencyKey: "new-through-pause",
        createdAtMs: 2_103,
      }),
    ).toEqual({ ok: false, reason: "paused", activityRevision: 2 });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: aggregateWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(snapshot);

    if (!first.ok) return;
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        principalId: first.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_104,
      }),
    ).toBe(true);
    const blockedSnapshot = {
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: aggregateWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    };
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Committed before pause",
        idempotencyKey: "lost-response",
        createdAtMs: 2_105,
      }),
    ).toMatchObject({
      ok: true,
      replayed: true,
      principal: {
        principalId: first.principal.principalId,
        blockedAtMs: 2_104,
      },
      message: first.message,
    });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Conflicting after block",
        idempotencyKey: "lost-response",
        createdAtMs: 2_106,
      }),
    ).toEqual({ ok: false, reason: "idempotency-conflict" });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "New after block",
        idempotencyKey: "new-after-block",
        createdAtMs: 2_107,
      }),
    ).toEqual({ ok: false, reason: "blocked", activityRevision: 3 });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: aggregateWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(blockedSnapshot);

    for (const transition of ["revoke", "rotate", "expire"] as const) {
      const authority = seedShare(storage, { suffix: transition });
      const accepted = append(storage, authority, {
        profile: transition,
        body: `Before ${transition}`,
        idempotencyKey: `before-${transition}`,
        createdAtMs: 2_000,
      });
      expect(accepted).toMatchObject({ ok: true, replayed: false });
      if (transition === "revoke") {
        expect(
          storage.revokeShareGrant({
            shareId: authority.shareId,
            grantId: authority.grantId,
            revokedAtMs: 2_100,
            expectedDependentGrantIds: [],
          }),
        ).toMatchObject({ ok: true });
      } else if (transition === "rotate") {
        expect(
          storage.rotateLinkGrant({
            shareId: authority.shareId,
            grantId: authority.grantId,
            rotatedAtMs: 2_100,
            expectedDependentGrantIds: [],
            guard: () => {},
            mintCredential: () => ({
              credentialId: "rotated-replay-credential",
              secretSealed: null,
              secretHash: "rotated-replay-secret-hash",
            }),
          }),
        ).toMatchObject({ ok: true });
      }
      expect(
        append(storage, authority, {
          profile: transition,
          body: `Before ${transition}`,
          idempotencyKey: `before-${transition}`,
          createdAtMs: transition === "expire" ? 1_001_000 : 2_101,
        }),
      ).toEqual({ ok: false, reason: "not-authorized" });
    }
  });

  it("bounds authenticated recipients by stable author while owners remain usable", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 2,
      discussionLifetimeMessageLimit: 3,
      discussionNonOwnerShareRowLimit: 4,
    });
    const seeded = seedShare(storage, { suffix: "named-budget" });

    const first = appendAuthenticated(storage, seeded, {
      idempotencyKey: "recipient-1",
      createdAtMs: 2_000,
    });
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      message: { authorKind: "named" },
    });
    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "recipient-2",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true, replayed: false });

    const beforeRate = {
      rows: countRows(dbPath, "sync_relay_share_discussion_messages"),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
    };
    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "recipient-rate",
        createdAtMs: 2_002,
      }),
    ).toEqual({ ok: false, reason: "rate-limit" });
    expect({
      rows: countRows(dbPath, "sync_relay_share_discussion_messages"),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
    }).toEqual(beforeRate);

    expect(
      appendAuthenticated(storage, seeded, {
        body: "Hello",
        idempotencyKey: "recipient-1",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      appendAuthenticated(storage, seeded, {
        body: "Changed",
        idempotencyKey: "recipient-1",
        createdAtMs: 2_002,
      }),
    ).toEqual({ ok: false, reason: "idempotency-conflict" });

    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "recipient-3",
        createdAtMs: 62_001,
      }),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "recipient-lifetime",
        createdAtMs: 123_000,
      }),
    ).toEqual({ ok: false, reason: "lifetime-limit" });

    for (let index = 0; index < 6; index += 1) {
      expect(
        appendAuthenticated(storage, seeded, {
          authorUserId: OWNER,
          role: "owner",
          displayName: "Owner",
          idempotencyKey: `owner-${index}`,
          createdAtMs: 2_100 + index,
        }),
      ).toMatchObject({
        ok: true,
        replayed: false,
        message: { authorKind: "owner" },
      });
    }

    expect(
      append(storage, seeded, {
        idempotencyKey: "external-row-4",
        createdAtMs: 62_002,
      }),
    ).toMatchObject({ ok: true, replayed: false });
    const beforeShareLimit = {
      rows: countRows(dbPath, "sync_relay_share_discussion_messages"),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
    };
    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: "second-recipient",
        displayName: "Second Recipient",
        idempotencyKey: "external-row-5",
        createdAtMs: 62_003,
      }),
    ).toEqual({ ok: false, reason: "share-limit" });
    expect({
      rows: countRows(dbPath, "sync_relay_share_discussion_messages"),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
    }).toEqual(beforeShareLimit);
    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: OWNER,
        role: "owner",
        displayName: "Owner",
        idempotencyKey: "owner-after-share-limit",
        createdAtMs: 62_004,
      }),
    ).toMatchObject({ ok: true, message: { authorKind: "owner" } });

    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
  });

  it("isolates recipient rate debt by share and authenticated user", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 1,
      discussionLifetimeMessageLimit: 10,
      discussionNonOwnerShareRowLimit: 10,
    });
    const firstShare = seedShare(storage, { suffix: "rate-scope-first" });
    const secondShare = seedShare(storage, { suffix: "rate-scope-second" });
    expect(
      appendAuthenticated(storage, firstShare, {
        idempotencyKey: "rate-scope-first",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      appendAuthenticated(storage, firstShare, {
        idempotencyKey: "rate-scope-blocked",
        createdAtMs: 2_001,
      }),
    ).toEqual({ ok: false, reason: "rate-limit" });
    expect(
      appendAuthenticated(storage, firstShare, {
        authorUserId: "other-recipient",
        displayName: "Other Recipient",
        idempotencyKey: "rate-scope-other-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true, message: { authorUserId: "other-recipient" } });
    expect(
      appendAuthenticated(storage, secondShare, {
        idempotencyKey: "rate-scope-other-share",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true, message: { authorUserId: RECIPIENT } });
    expect(
      storage.listShareDiscussionMessages({ shareId: firstShare.shareId, limit: 10 }).messages,
    ).toHaveLength(2);
    expect(
      storage.listShareDiscussionMessages({ shareId: secondShare.shareId, limit: 10 }).messages,
    ).toHaveLength(1);
    expectExactWorkspaceUsage(dbPath, firstShare.workspaceId);
    expectExactWorkspaceUsage(dbPath, secondShare.workspaceId);
  });

  it("keeps the durable workspace total exact across every counted write lifecycle", async () => {
    const { storage, dbPath } = await openStorage({ blobGraceMs: 0 });
    const seeded = seedShare(storage, { suffix: "usage-lifecycle" });
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(0);

    const blob = Buffer.from("usage lifecycle blob");
    const blobSha = createHash("sha256").update(blob).digest("hex");
    expect(
      storage.putBlob({
        workspaceId: seeded.workspaceId,
        sha256: blobSha,
        content: blob,
        createdAtMs: 1_100,
      }),
    ).toMatchObject({ alreadyHad: false });
    const afterBlob = expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    expect(
      storage.putBlob({
        workspaceId: seeded.workspaceId,
        sha256: blobSha,
        content: blob,
        createdAtMs: 1_101,
      }),
    ).toMatchObject({ alreadyHad: true });
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(afterBlob);

    expect(
      storage.appendLogBatch({
        workspaceId: seeded.workspaceId,
        originId: "usage-lifecycle-origin",
        ops: [
          {
            originSeq: 0,
            opKind: "quota.lifecycle",
            payloadJson: JSON.stringify({ row: "log" }),
            recordedAtMs: 1_102,
          },
        ],
      }),
    ).toMatchObject({ inserted: 1 });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);

    const firstEnvelope = storage.putKeyEnvelope({
      workspaceId: seeded.workspaceId,
      envelopeJson: JSON.stringify({ generation: 1, payload: "first" }),
      updatedAtMs: 1_103,
      expectedSha256: null,
    });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    storage.putKeyEnvelope({
      workspaceId: seeded.workspaceId,
      envelopeJson: JSON.stringify({ generation: 2, payload: "replacement" }),
      updatedAtMs: 1_104,
      expectedSha256: firstEnvelope.sha256,
    });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);

    expect(
      storage.claimWorkspaceIdentity({
        workspaceId: seeded.workspaceId,
        replicationEpoch: "usage-epoch-1",
        streamIdentity: "usage-stream-1",
      }),
    ).toBe("claimed");
    expect(
      storage.rotateWorkspaceIdentity({
        workspaceId: seeded.workspaceId,
        ownerUserId: OWNER,
        replicationEpoch: "usage-epoch-2",
        streamIdentity: "usage-stream-2",
        rotatedAtMs: 1_105,
      }),
    ).toBe("rotated");
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);

    const linkMessage = append(storage, seeded, {
      profile: "usage-profile",
      claimedName: "Usage Link",
      body: "counted link comment",
      idempotencyKey: "usage-link",
      createdAtMs: 2_000,
    });
    expect(linkMessage).toMatchObject({ ok: true, replayed: false });
    if (!linkMessage.ok) return;
    const afterLink = expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    expect(
      append(storage, seeded, {
        profile: "usage-profile",
        claimedName: "Usage Link",
        body: "counted link comment",
        idempotencyKey: "usage-link",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true, replayed: true });
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(afterLink);

    const second = reopenTestStorage(dbPath, {
      blobGraceMs: 0,
      newDiscussionId: () => "usage-second-message",
    });
    expect(
      second.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Usage Named",
        body: "counted named comment",
        idempotencyKey: "usage-named",
        createdAtMs: 2_001,
        readGuard: () => "recipient",
        appendGuard: () => "recipient",
      }),
    ).toMatchObject({ ok: true, replayed: false });
    const afterNamed = expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    expect(
      second.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Usage Named",
        body: "counted named comment",
        idempotencyKey: "usage-named",
        createdAtMs: 2_001,
        readGuard: () => "recipient",
        appendGuard: () => "recipient",
      }),
    ).toMatchObject({ ok: true, replayed: true });
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(afterNamed);

    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        messageId: linkMessage.message.messageId,
        deletedAtMs: 2_002,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: linkMessage.message.messageId });
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(afterNamed);

    expect(
      await storage.collectUnreferencedBlobs(seeded.workspaceId, { nowMs: 1_101 }),
    ).toMatchObject({ removed: 1, removedSha256s: [blobSha] });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);

    closeTestStorage(storage);
    closeTestStorage(second);
    reopenTestStorage(dbPath, {
      blobGraceMs: 0,
      newDiscussionId: () => "usage-rejected-message",
    });
    const reopenedUsage = expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    const limited = reopenTestStorage(dbPath, {
      workspaceQuotaBytes: reopenedUsage,
      newDiscussionId: () => "usage-over-quota-message",
    });
    expect(
      append(limited, seeded, {
        profile: "usage-profile",
        body: "rejected quota comment",
        idempotencyKey: "usage-rejected",
        createdAtMs: 2_003,
      }),
    ).toEqual({ ok: false, reason: "workspace-quota" });
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(reopenedUsage);
  });

  it("preserves principals, budgets, provenance, pause, block, messages, and tombstones on reopen", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 2,
      discussionLifetimeMessageLimit: 2,
    });
    const seeded = seedShare(storage);
    const kept = append(storage, seeded, {
      profile: "kept",
      claimedName: "Kept",
      body: "kept body",
      idempotencyKey: "kept-1",
      createdAtMs: 2_000,
    });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    const blockedCapabilityHash = capabilityHash("blocked-reopen-capability");
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "blocked-reopen-session",
          capabilityHash: blockedCapabilityHash,
          grantId: seeded.grantId,
          generation: 1,
          mintedAtMs: 1_500,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    const blocked = append(storage, seeded, {
      profile: "blocked-reopen",
      capabilityHash: blockedCapabilityHash,
      claimedName: "Blocked",
      body: "remove body",
      idempotencyKey: "blocked-1",
      createdAtMs: 2_001,
    });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        messageId: blocked.message.messageId,
        deletedAtMs: 2_100,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: blocked.message.messageId });
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        principalId: blocked.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_200,
      }),
    ).toBe(true);
    expect(
      storage.setShareLinkWritesPaused({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        actorUserId: OWNER,
        pausedAtMs: 2_300,
      }),
    ).toBe(true);

    closeTestStorage(storage);
    const reopened = reopenTestStorage(dbPath, {
      discussionMessageRateLimit: 2,
      discussionLifetimeMessageLimit: 2,
    });
    expect(reopened.getLinkPrincipal(kept.principal.principalId)).toMatchObject({
      displayName: "Kept",
      blockedAtMs: null,
    });
    expect(reopened.getLinkPrincipal(blocked.principal.principalId)).toMatchObject({
      displayName: "Blocked",
      blockedAtMs: 2_200,
    });
    expect(reopened.findLinkSessionByCapabilityHash(seeded.capabilityHash)).toMatchObject({
      principalId: kept.principal.principalId,
    });
    expect(linkWritesPausedAtMs(storagePath(reopened), seeded.shareId)).toBe(2_300);
    expect(
      reopened.listShareDiscussionMessages({ shareId: seeded.shareId, limit: 50 }),
    ).toMatchObject({
      linkCommentsPaused: true,
      messages: [
        {
          messageId: kept.message.messageId,
          linkGrantId: seeded.grantId,
          linkPrincipalId: kept.principal.principalId,
          displayNameSnapshot: "Kept",
          body: "kept body",
          linkPrincipalBlocked: false,
        },
        {
          messageId: blocked.message.messageId,
          linkGrantId: seeded.grantId,
          linkPrincipalId: blocked.principal.principalId,
          body: null,
          linkPrincipalBlocked: true,
          deletedAtMs: 2_100,
          deletedByUserId: OWNER,
        },
      ],
    });
    expect(
      append(reopened, seeded, {
        profile: "kept",
        body: "blocked by pause",
        idempotencyKey: "kept-2",
        createdAtMs: 70_000,
      }),
    ).toMatchObject({ ok: false, reason: "paused" });
    expect(
      reopened.setShareLinkWritesPaused({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        actorUserId: OWNER,
        pausedAtMs: null,
      }),
    ).toBe(true);
    expect(
      append(reopened, seeded, {
        profile: "kept",
        body: "lifetime second",
        idempotencyKey: "kept-2",
        createdAtMs: 70_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      append(reopened, seeded, {
        profile: "kept",
        body: "lifetime debt stayed",
        idempotencyKey: "kept-3",
        createdAtMs: 140_000,
      }),
    ).toMatchObject({ ok: false, reason: "lifetime-limit" });
  });

  it("enforces each durable budget and validates normalized names, bodies, and keys", async () => {
    expect({
      bodyCodePoints: LINK_DISCUSSION_BODY_CODE_POINT_LIMIT,
      bodyBytes: LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
      nameCodePoints: LINK_DISCUSSION_NAME_CODE_POINT_LIMIT,
      nameBytes: LINK_DISCUSSION_NAME_BYTE_LIMIT,
      keyBytes: LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT,
      principals: LINK_DISCUSSION_PRINCIPAL_LIMIT,
      rollingMessages: DISCUSSION_MESSAGE_RATE_LIMIT,
      rollingWindowMs: DISCUSSION_MESSAGE_RATE_WINDOW_MS,
      lifetimeMessages: DISCUSSION_LIFETIME_MESSAGE_LIMIT,
      shareRows: DISCUSSION_NON_OWNER_SHARE_ROW_LIMIT,
      page: LINK_DISCUSSION_PAGE_LIMIT,
    }).toEqual({
      bodyCodePoints: 2_000,
      bodyBytes: 8_000,
      nameCodePoints: 40,
      nameBytes: 160,
      keyBytes: 64,
      principals: 100,
      rollingMessages: 10,
      rollingWindowMs: 60_000,
      lifetimeMessages: 500,
      shareRows: 5_000,
      page: 100,
    });

    const { storage, dbPath } = await openStorage({
      linkDiscussionPrincipalLimit: 2,
      discussionMessageRateLimit: 2,
      discussionLifetimeMessageLimit: 3,
      discussionNonOwnerShareRowLimit: 4,
    });
    const seeded = seedShare(storage);
    const normalized = append(storage, seeded, {
      profile: "one",
      claimedName: "  A\u0000\u202Eme\u0301   User  ",
      body: "e\u0301",
      idempotencyKey: "one-1",
      createdAtMs: 2_000,
    });
    expect(normalized).toMatchObject({
      ok: true,
      principal: { displayName: "Amé User" },
      message: { body: "é", displayNameSnapshot: "Amé User" },
    });
    expect(
      append(storage, seeded, {
        profile: "one",
        claimedName: "Different",
        idempotencyKey: "rename",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: false, reason: "name-already-set" });
    expect(
      append(storage, seeded, {
        profile: "one",
        body: "second",
        idempotencyKey: "one-2",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });
    expect(
      append(storage, seeded, {
        profile: "one",
        body: "rate",
        idempotencyKey: "one-rate",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: false, reason: "rate-limit" });
    expect(
      append(storage, seeded, {
        profile: "one",
        body: "lifetime third",
        idempotencyKey: "one-3",
        createdAtMs: 62_001,
      }),
    ).toMatchObject({ ok: true });
    expect(
      append(storage, seeded, {
        profile: "one",
        body: "lifetime fourth",
        idempotencyKey: "one-lifetime",
        createdAtMs: 123_000,
      }),
    ).toMatchObject({ ok: false, reason: "lifetime-limit" });

    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "session-two",
          capabilityHash: capabilityHash("capability-two"),
          grantId: seeded.grantId,
          generation: 1,
          mintedAtMs: 2_100,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    expect(
      append(storage, seeded, {
        profile: "two",
        capabilityHash: capabilityHash("capability-two"),
        body: "share row four",
        idempotencyKey: "two-1",
        createdAtMs: 62_002,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "session-three",
          capabilityHash: capabilityHash("capability-three"),
          grantId: seeded.grantId,
          generation: 1,
          mintedAtMs: 2_200,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    expect(
      append(storage, seeded, {
        profile: "three",
        capabilityHash: capabilityHash("capability-three"),
        idempotencyKey: "three-1",
        createdAtMs: 62_003,
      }),
    ).toMatchObject({ ok: false, reason: "principal-limit" });
    expect(
      append(storage, seeded, {
        profile: "two",
        capabilityHash: capabilityHash("capability-two"),
        idempotencyKey: "two-share-limit",
        createdAtMs: 123_001,
      }),
    ).toMatchObject({ ok: false, reason: "share-limit" });

    for (const [input, reason] of [
      [{ body: "", idempotencyKey: "empty-body" }, "invalid-input"],
      [{ body: "🙂".repeat(2_001), idempotencyKey: "large-body" }, "invalid-input"],
      [{ claimedName: "x".repeat(41), idempotencyKey: "large-name" }, "invalid-input"],
      [{ idempotencyKey: "\n" }, "invalid-input"],
      [{ idempotencyKey: "x".repeat(65) }, "invalid-input"],
    ] as const) {
      expect(append(storage, seeded, { profile: "invalid", ...input })).toMatchObject({
        ok: false,
        reason,
      });
    }
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(4);
    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(2);

    const boundsStore = await openStorage();
    const boundsSeed = seedShare(boundsStore.storage, { suffix: "bounds" });
    expect(
      append(boundsStore.storage, boundsSeed, {
        claimedName: "x".repeat(40),
        body: "🙂".repeat(2_000),
        idempotencyKey: "k".repeat(64),
      }),
    ).toMatchObject({
      ok: true,
      principal: { displayName: "x".repeat(40) },
      message: { body: "🙂".repeat(2_000) },
    });
    const cfCapability = capabilityHash("bounds-cf");
    expect(
      boundsStore.storage.mintLinkSession({
        session: {
          sessionId: "bounds-cf-session",
          capabilityHash: cfCapability,
          grantId: boundsSeed.grantId,
          generation: 1,
          mintedAtMs: 1_500,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    expect(
      append(boundsStore.storage, boundsSeed, {
        profile: "cf",
        capabilityHash: cfCapability,
        claimedName: "A\u200dB",
        idempotencyKey: "cf-name",
      }),
    ).toMatchObject({ ok: true, principal: { displayName: "A\u200dB" } });

    const populationStore = await openStorage({ linkDiscussionPrincipalLimit: 1 });
    const populationSeed = seedShare(populationStore.storage, { suffix: "population" });
    expect(append(populationStore.storage, populationSeed, { profile: "first" })).toMatchObject({
      ok: true,
    });
    const secondGenerationOneCapability = capabilityHash("population-second-one");
    expect(
      populationStore.storage.mintLinkSession({
        session: {
          sessionId: "population-second-one",
          capabilityHash: secondGenerationOneCapability,
          grantId: populationSeed.grantId,
          generation: 1,
          mintedAtMs: 2_100,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    expect(
      append(populationStore.storage, populationSeed, {
        profile: "second",
        capabilityHash: secondGenerationOneCapability,
        createdAtMs: 2_101,
      }),
    ).toMatchObject({ ok: false, reason: "principal-limit" });
    expect(
      populationStore.storage.rotateLinkGrant({
        shareId: populationSeed.shareId,
        grantId: populationSeed.grantId,
        rotatedAtMs: 3_000,
        expectedDependentGrantIds: [],
        guard: () => {},
        mintCredential: () => ({
          credentialId: "population-generation-two",
          secretSealed: null,
          secretHash: "population-generation-two-secret",
        }),
      }),
    ).toMatchObject({ ok: true, grant: { generation: 2 } });
    const secondGenerationTwoCapability = capabilityHash("population-second-two");
    expect(
      populationStore.storage.mintLinkSession({
        session: {
          sessionId: "population-second-two",
          capabilityHash: secondGenerationTwoCapability,
          grantId: populationSeed.grantId,
          generation: 2,
          mintedAtMs: 3_001,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    expect(
      append(populationStore.storage, populationSeed, {
        profile: "second",
        capabilityHash: secondGenerationTwoCapability,
        idempotencyKey: "generation-two",
        createdAtMs: 3_002,
      }),
    ).toMatchObject({ ok: true, principal: { mintGeneration: 2 } });

    const debtStore = await openStorage({ discussionLifetimeMessageLimit: 2 });
    const debtSeed = seedShare(debtStore.storage, { suffix: "debt" });
    const debtFirst = append(debtStore.storage, debtSeed, {
      body: "debt one",
      idempotencyKey: "debt-1",
      createdAtMs: 2_000,
    });
    expect(debtFirst.ok).toBe(true);
    expect(
      append(debtStore.storage, debtSeed, {
        body: "debt two",
        idempotencyKey: "debt-2",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });
    if (!debtFirst.ok) return;
    expect(
      debtStore.storage.deleteShareDiscussionMessage({
        shareId: debtSeed.shareId,
        workspaceId: debtSeed.workspaceId,
        messageId: debtFirst.message.messageId,
        deletedAtMs: 2_100,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: debtFirst.message.messageId });
    expect(
      debtStore.storage.rotateLinkGrant({
        shareId: debtSeed.shareId,
        grantId: debtSeed.grantId,
        rotatedAtMs: 3_000,
        expectedDependentGrantIds: [],
        guard: () => {},
        mintCredential: () => ({
          credentialId: "debt-generation-two",
          secretSealed: null,
          secretHash: "debt-generation-two-secret",
        }),
      }),
    ).toMatchObject({ ok: true, grant: { generation: 2 } });
    const debtGenerationTwoCapability = capabilityHash("debt-generation-two");
    expect(
      debtStore.storage.mintLinkSession({
        session: {
          sessionId: "debt-generation-two",
          capabilityHash: debtGenerationTwoCapability,
          grantId: debtSeed.grantId,
          generation: 2,
          mintedAtMs: 3_001,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    expect(
      append(debtStore.storage, debtSeed, {
        capabilityHash: debtGenerationTwoCapability,
        body: "debt survives rotation and delete",
        idempotencyKey: "debt-3",
        createdAtMs: 70_000,
      }),
    ).toMatchObject({ ok: false, reason: "lifetime-limit" });

    const quotaProbe = await openStorage();
    const quotaProbeSeed = seedShare(quotaProbe.storage, { suffix: "quota" });
    expect(
      append(quotaProbe.storage, quotaProbeSeed, {
        body: "quota body",
        idempotencyKey: "quota-a",
      }),
    ).toMatchObject({ ok: true });
    expect(
      append(quotaProbe.storage, quotaProbeSeed, {
        body: "quota body",
        idempotencyKey: "quota-b",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });
    const twoRowUsage = discussionUsageBytes(quotaProbe.dbPath);
    const quotaStore = await openStorage({ workspaceQuotaBytes: twoRowUsage - 1 });
    const quotaSeed = seedShare(quotaStore.storage, { suffix: "quota" });
    expect(
      append(quotaStore.storage, quotaSeed, {
        body: "quota body",
        idempotencyKey: "quota-a",
      }),
    ).toMatchObject({ ok: true });
    expect(
      append(quotaStore.storage, quotaSeed, {
        body: "quota body",
        idempotencyKey: "quota-b",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({
      ok: false,
      reason: "workspace-quota",
    });
    expect(countRows(quotaStore.dbPath, "sync_relay_link_principals")).toBe(1);
    expect(countRows(quotaStore.dbPath, "sync_relay_share_discussion_messages")).toBe(1);
  });

  it("keeps recipient debt through deletion, promotion, regrant, and reopen", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 2,
      discussionNonOwnerShareRowLimit: 10,
    });
    const seeded = seedShare(storage, { suffix: "named-debt" });
    expect(
      seedDependentGrant(storage, {
        shareId: seeded.shareId,
        parentGrantId: seeded.grantId,
        grantId: "named-debt-dependent",
        principalUserId: "promoted-recipient",
        createdAtMs: 1_100,
      }),
    ).toMatchObject({ ok: true });
    const first = appendAuthenticated(storage, seeded, {
      authorUserId: "promoted-recipient",
      displayName: "Promoted Recipient",
      idempotencyKey: "debt-first",
      createdAtMs: 2_000,
    });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(
      storage.promoteShareGrant({
        shareId: seeded.shareId,
        grantId: "named-debt-dependent",
        expectedParentGrantId: seeded.grantId,
        expectedParentGeneration: 1,
        guard: () => {},
      }),
    ).toMatchObject({ ok: true, grant: { parentGrantId: null } });

    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: "promoted-recipient",
        displayName: "Promoted Recipient",
        idempotencyKey: "debt-second",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        messageId: first.message.messageId,
        deletedAtMs: 2_100,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: first.message.messageId });
    expect(
      storage.revokeShareGrant({
        shareId: seeded.shareId,
        grantId: "named-debt-dependent",
        revokedAtMs: 2_200,
      }),
    ).toMatchObject({ ok: true });
    expect(
      seedDependentGrant(storage, {
        shareId: seeded.shareId,
        parentGrantId: seeded.grantId,
        grantId: "named-debt-regrant",
        principalUserId: "promoted-recipient",
        createdAtMs: 2_300,
      }),
    ).toMatchObject({ ok: true });

    closeTestStorage(storage);
    const reopened = reopenTestStorage(dbPath, {
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 2,
      discussionNonOwnerShareRowLimit: 10,
    });
    expect(
      appendAuthenticated(reopened, seeded, {
        authorUserId: "promoted-recipient",
        displayName: "Promoted Recipient",
        idempotencyKey: "debt-after-reopen",
        createdAtMs: 70_000,
      }),
    ).toEqual({ ok: false, reason: "lifetime-limit" });
    expect(
      appendAuthenticated(reopened, seeded, {
        authorUserId: OWNER,
        role: "owner",
        displayName: "Owner",
        idempotencyKey: "debt-owner",
        createdAtMs: 70_001,
      }),
    ).toMatchObject({ ok: true, message: { authorKind: "owner" } });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
  });

  it("pages by creation time and message id without gaps across tombstones", async () => {
    const { storage } = await openStorage();
    const seeded = seedShare(storage);
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = append(storage, seeded, {
        body: `message ${index}`,
        idempotencyKey: `page-${index}`,
        createdAtMs: index < 3 ? 2_000 : 2_001,
      });
      expect(result.ok).toBe(true);
      if (result.ok) ids.push(result.message.messageId);
    }
    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        messageId: ids[2]!,
        deletedAtMs: 3_000,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: ids[2] });

    const first = storage.listShareDiscussionMessages({ shareId: seeded.shareId, limit: 2 });
    expect(first.messages.map((row) => row.messageId)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toEqual({
      createdAtMs: first.messages[1]!.createdAtMs,
      messageId: ids[1],
    });
    const second = storage.listShareDiscussionMessages({
      shareId: seeded.shareId,
      after: first.nextCursor,
      limit: 2,
    });
    expect(second.messages.map((row) => row.messageId)).toEqual(ids.slice(2, 4));
    expect(second.messages[0]).toMatchObject({
      messageId: ids[2],
      body: null,
      deletedAtMs: 3_000,
      deletedByUserId: OWNER,
    });
    const third = storage.listShareDiscussionMessages({
      shareId: seeded.shareId,
      after: second.nextCursor,
      limit: 2,
    });
    expect(third.messages.map((row) => row.messageId)).toEqual(ids.slice(4));
    expect(third.nextCursor).toBeNull();
    expect(
      [...first.messages, ...second.messages, ...third.messages].map((row) => row.messageId),
    ).toEqual(ids);
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(() => storage.listShareDiscussionMessages({ shareId: seeded.shareId, limit })).toThrow(
        /limit/u,
      );
    }
  });
});
