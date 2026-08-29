import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINK_DISCUSSION_BODY_CODE_POINT_LIMIT,
  LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
  LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT,
  LINK_DISCUSSION_LIFETIME_MESSAGE_LIMIT,
  LINK_DISCUSSION_MESSAGE_RATE_LIMIT,
  LINK_DISCUSSION_MESSAGE_RATE_WINDOW_MS,
  LINK_DISCUSSION_NAME_BYTE_LIMIT,
  LINK_DISCUSSION_NAME_CODE_POINT_LIMIT,
  LINK_DISCUSSION_PAGE_LIMIT,
  LINK_DISCUSSION_PRINCIPAL_LIMIT,
  LINK_DISCUSSION_SHARE_ROW_LIMIT,
  openSyncRelayStorage,
  type OpenSyncRelayStorageOptions,
  type SyncRelayLinkSessionRow,
  type SyncRelayStorage,
} from "./storage";

const OWNER = "owner";
const RECIPIENT = "recipient";

interface InspectionStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint };
}

interface InspectionDatabase {
  prepare(sql: string): InspectionStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync: InspectionDatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => InspectionDatabase;
};

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openStorage(
  options: OpenSyncRelayStorageOptions = {},
): Promise<{ storage: SyncRelayStorage; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-discussion-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  let id = 0;
  const storage = openSyncRelayStorage(dbPath, {
    ...options,
    newDiscussionId: options.newDiscussionId ?? (() => `discussion-id-${++id}`),
  });
  storages.push(storage);
  return { storage, dbPath };
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
  expect(
    storage.claimWorkspace({ workspaceId, ownerUserId: OWNER, createdAtMs }),
  ).toBe("created");
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
  expect(
    storage.createLinkGrant({
      grant: {
        grantId,
        shareId,
        principalKind: "link",
        principalUserId: null,
        principalEmail: null,
        access: input.access ?? "comment",
        generation: 1,
        status: "active",
        createdAtMs: createdAtMs + 1,
        revokedAtMs: null,
        parentGrantId: null,
      },
      credential: {
        credentialId: `credential-${suffix}`,
        grantId,
        secretHash: `secret-hash-${suffix}`,
        generation: 1,
        mintedAtMs: createdAtMs + 1,
        retiredAtMs: null,
      },
    }),
  ).toBe(true);
  const hash = capabilityHash(`capability-${suffix}`);
  expect(
    storage.mintLinkSession({
      session: {
        sessionId: `session-${suffix}`,
        capabilityHash: hash,
        grantId,
        generation: 1,
        mintedAtMs: createdAtMs + 2,
        expiresAtMs: createdAtMs + 1_000_000,
      },
    }),
  ).toBe(true);
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

function countRows(dbPath: string, table: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
  } finally {
    db.close();
  }
}

function replaceTableSchemaFragment(
  dbPath: string,
  table: string,
  current: string,
  stale: string,
): void {
  const db = new InspectionDatabaseSync(dbPath);
  try {
    const schema = db
      .prepare(
        `SELECT type, sql
         FROM sqlite_schema
         WHERE (type = 'table' AND name = ?)
            OR (type = 'index' AND tbl_name = ? AND sql IS NOT NULL)
         ORDER BY type DESC, name`,
      )
      .all(table, table);
    const tableSql = String(schema.find((row) => row.type === "table")?.sql ?? "");
    const staleTableSql = tableSql.replace(current, stale);
    expect(staleTableSql).not.toBe(tableSql);
    const indexSql = schema
      .filter((row) => row.type === "index")
      .map((row) => String(row.sql));

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`DROP TABLE ${table}`);
    db.exec(staleTableSql);
    for (const sql of indexSql) db.exec(sql);
  } finally {
    db.close();
  }
}

function discussionUsageBytes(dbPath: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
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
  } finally {
    db.close();
  }
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
    sessionId: `replacement-${suffix}`,
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
    const second = storage.appendNamedDiscussionMessage({
      shareId: seeded.shareId,
      authorUserId: RECIPIENT,
      displayName: "Recipient",
      body: "second",
      idempotencyKey: "activity-second",
      createdAtMs: 2_001,
      guard: () => {},
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const third = storage.appendNamedDiscussionMessage({
      shareId: seeded.shareId,
      authorUserId: OWNER,
      displayName: "Owner",
      body: "third",
      idempotencyKey: "activity-third",
      createdAtMs: 2_002,
      guard: () => {},
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
      storage.listShareDiscussionMessages({
        shareId: seeded.shareId,
        direction: "newest-first",
        before: newest.nextCursor,
        limit: 2,
      }).messages.map((message) => message.body),
    ).toEqual(["first"]);

    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        principalId: first.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_100,
      }),
    ).toBe(true);
    expect(
      storage.setShareLinkWritesPaused({
        shareId: seeded.shareId,
        actorUserId: OWNER,
        pausedAtMs: 2_101,
      }),
    ).toBe(true);
    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
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
    const writable = new InspectionDatabaseSync(dbPath);
    try {
      writable
        .prepare(
          "UPDATE sync_relay_shares SET discussion_revision = ? WHERE share_id = ?",
        )
        .run(Number.MAX_SAFE_INTEGER, capped.shareId);
    } finally {
      writable.close();
    }
    expect(
      storage.setShareLinkWritesPaused({
        shareId: capped.shareId,
        actorUserId: OWNER,
        pausedAtMs: 2_201,
      }),
    ).toBe(false);
    expect(storage.getShareDiscussionRevision(capped.shareId)).toBe(
      Number.MAX_SAFE_INTEGER,
    );

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

    const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db.prepare(
          "SELECT discussion_revision FROM sync_relay_shares WHERE share_id = ?",
        ).get(seeded.shareId)?.discussion_revision,
      ).toBe(6);
      expect(
        db.prepare(
          "SELECT discussion_revision FROM sync_relay_share_discussion_messages WHERE message_id = ?",
        ).get(second.message.messageId)?.discussion_revision,
      ).toBe(6);
      expect(
        db.prepare(
          "SELECT discussion_revision FROM sync_relay_link_principals WHERE principal_id = ?",
        ).get(first.principal.principalId)?.discussion_revision,
      ).toBe(4);
    } finally {
      db.close();
    }

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
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
    expect(
      append(storage, seeded, { body: "", idempotencyKey: "refused" }),
    ).toMatchObject({ ok: false, reason: "invalid-input" });
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

  it("replays an exact append and rejects a conflicting idempotency key", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage);
    const first = append(storage, seeded, {
      claimedName: "Alice",
      body: "One",
      idempotencyKey: "retry-key",
    });
    const replay = append(storage, seeded, {
      claimedName: "Alice",
      body: "One",
      idempotencyKey: "retry-key",
      createdAtMs: 9_999,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      append(storage, seeded, {
        claimedName: "Alice",
        body: "Different",
        idempotencyKey: "retry-key",
      }),
    ).toMatchObject({ ok: false, reason: "idempotency-conflict" });
    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(1);
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(1);
  });

  it("keeps immutable provenance through refresh, retune, rotation, and block changes", async () => {
    const { storage } = await openStorage();
    const seeded = seedShare(storage);
    const first = append(storage, seeded, { idempotencyKey: "before-state-changes" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const principalId = first.principal.principalId;
    const messageId = first.message.messageId;

    const refreshed = replaceSession(storage, seeded.capabilityHash, "provenance", 2_100);
    expect(refreshed.principalId).toBe(principalId);
    expect(
      storage.retuneShareGrant({
        shareId: seeded.shareId,
        grantId: seeded.grantId,
        access: "view",
        changedAtMs: 2_200,
        expectedDependentGrantIds: [],
        guard: () => {},
      }),
    ).toMatchObject({ ok: true, grant: { generation: 2, access: "view" } });
    expect(
      storage.retuneShareGrant({
        shareId: seeded.shareId,
        grantId: seeded.grantId,
        access: "comment",
        changedAtMs: 2_300,
        expectedDependentGrantIds: [],
        guard: () => {},
        mintCredential: () => ({
          credentialId: "retuned-credential",
          secretHash: "retuned-secret-hash",
        }),
      }),
    ).toMatchObject({ ok: true, grant: { generation: 3, access: "comment" } });
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_400,
      }),
    ).toBe(true);
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        principalId,
        actorUserId: OWNER,
        blockedAtMs: null,
      }),
    ).toBe(true);
    expect(
      storage.rotateLinkGrant({
        shareId: seeded.shareId,
        grantId: seeded.grantId,
        rotatedAtMs: 2_500,
        expectedDependentGrantIds: [],
        guard: () => {},
        mintCredential: () => ({
          credentialId: "rotated-credential",
          secretHash: "rotated-secret-hash",
        }),
      }),
    ).toMatchObject({ ok: true, grant: { generation: 4 } });

    expect(
      storage.listShareDiscussionMessages({ shareId: seeded.shareId, limit: 50 }).messages,
    ).toContainEqual(
      expect.objectContaining({
        messageId,
        linkGrantId: seeded.grantId,
        linkPrincipalId: principalId,
      }),
    );
    expect(storage.getLinkPrincipal(principalId)).toMatchObject({
      grantId: seeded.grantId,
      mintGeneration: 1,
      blockedAtMs: null,
    });
  });

  it("refuses every stale authority state without partial writes", async () => {
    const { storage, dbPath } = await openStorage();
    const view = seedShare(storage, { suffix: "view", access: "view" });
    expect(append(storage, view, { profile: "view" })).toMatchObject({
      ok: false,
      reason: "not-authorized",
    });

    const stale = seedShare(storage, { suffix: "stale" });
    expect(
      storage.retuneShareGrant({
        shareId: stale.shareId,
        grantId: stale.grantId,
        access: "view",
        changedAtMs: 1_500,
        expectedDependentGrantIds: [],
        guard: () => {},
      }),
    ).toMatchObject({ ok: true });
    expect(append(storage, stale, { profile: "stale" })).toMatchObject({
      ok: false,
      reason: "not-authorized",
    });

    const revoked = seedShare(storage, { suffix: "revoked" });
    expect(
      storage.revokeShareGrant({
        shareId: revoked.shareId,
        grantId: revoked.grantId,
        revokedAtMs: 1_500,
        expectedDependentGrantIds: [],
      }),
    ).toMatchObject({ ok: true });
    expect(append(storage, revoked, { profile: "revoked" })).toMatchObject({
      ok: false,
      reason: "not-authorized",
    });

    const paused = seedShare(storage, { suffix: "paused" });
    expect(
      storage.setShareLinkWritesPaused({
        shareId: paused.shareId,
        actorUserId: OWNER,
        pausedAtMs: 1_500,
      }),
    ).toBe(true);
    expect(append(storage, paused, { profile: "paused" })).toMatchObject({
      ok: false,
      reason: "paused",
    });

    const blocked = seedShare(storage, { suffix: "blocked" });
    const accepted = append(storage, blocked, {
      profile: "blocked",
      idempotencyKey: "accepted-before-block",
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: blocked.shareId,
        principalId: accepted.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_100,
      }),
    ).toBe(true);
    expect(storage.findLinkSessionByCapabilityHash(blocked.capabilityHash)).toMatchObject({
      grantId: blocked.grantId,
      principalId: null,
    });
    expect(
      append(storage, blocked, {
        profile: "blocked",
        idempotencyKey: "refused-on-existing-session-after-block",
        createdAtMs: 2_101,
      }),
    ).toMatchObject({ ok: false, reason: "blocked" });
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "blocked-new-session",
          capabilityHash: capabilityHash("blocked-new-capability"),
          grantId: blocked.grantId,
          generation: 1,
          mintedAtMs: 2_200,
          expiresAtMs: 9_000,
        },
      }),
    ).toBe(true);
    expect(
      append(storage, blocked, {
        profile: "blocked",
        capabilityHash: capabilityHash("blocked-new-capability"),
        idempotencyKey: "refused-after-block",
        createdAtMs: 2_201,
      }),
    ).toMatchObject({ ok: false, reason: "blocked" });
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "fresh-profile-session",
          capabilityHash: capabilityHash("fresh-profile-capability"),
          grantId: blocked.grantId,
          generation: 1,
          mintedAtMs: 2_300,
          expiresAtMs: 9_000,
        },
      }),
    ).toBe(true);
    expect(
      append(storage, blocked, {
        profile: "fresh-profile",
        capabilityHash: capabilityHash("fresh-profile-capability"),
        idempotencyKey: "fresh-profile-accepted",
        createdAtMs: 2_301,
      }),
    ).toMatchObject({ ok: true, replayed: false });

    const lostOwner = seedShare(storage, { suffix: "lost-owner" });
    const inspection = new InspectionDatabaseSync(dbPath);
    try {
      inspection
        .prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?")
        .run("new-owner", lostOwner.workspaceId);
    } finally {
      inspection.close();
    }
    expect(append(storage, lostOwner, { profile: "lost-owner" })).toMatchObject({
      ok: false,
      reason: "not-authorized",
    });

    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(2);
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(2);
    for (const hash of [
      view.capabilityHash,
      stale.capabilityHash,
      revoked.capabilityHash,
      paused.capabilityHash,
      capabilityHash("blocked-new-capability"),
      lostOwner.capabilityHash,
    ]) {
      expect(storage.findLinkSessionByCapabilityHash(hash)?.principalId ?? null).toBeNull();
    }
  });

  it("enforces each durable budget and validates normalized names, bodies, and keys", async () => {
    expect({
      bodyCodePoints: LINK_DISCUSSION_BODY_CODE_POINT_LIMIT,
      bodyBytes: LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
      nameCodePoints: LINK_DISCUSSION_NAME_CODE_POINT_LIMIT,
      nameBytes: LINK_DISCUSSION_NAME_BYTE_LIMIT,
      keyBytes: LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT,
      principals: LINK_DISCUSSION_PRINCIPAL_LIMIT,
      rollingMessages: LINK_DISCUSSION_MESSAGE_RATE_LIMIT,
      rollingWindowMs: LINK_DISCUSSION_MESSAGE_RATE_WINDOW_MS,
      lifetimeMessages: LINK_DISCUSSION_LIFETIME_MESSAGE_LIMIT,
      shareRows: LINK_DISCUSSION_SHARE_ROW_LIMIT,
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
      linkDiscussionMessageRateLimit: 2,
      linkDiscussionLifetimeMessageLimit: 3,
      linkDiscussionShareRowLimit: 4,
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

    const debtStore = await openStorage({ linkDiscussionLifetimeMessageLimit: 2 });
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
    expect([...first.messages, ...second.messages, ...third.messages].map((row) => row.messageId)).toEqual(
      ids,
    );
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(() =>
        storage.listShareDiscussionMessages({ shareId: seeded.shareId, limit }),
      ).toThrow(/limit/u);
    }
  });

  it("preserves principals, budgets, provenance, pause, block, messages, and tombstones on reopen", async () => {
    const { storage, dbPath } = await openStorage({
      linkDiscussionMessageRateLimit: 2,
      linkDiscussionLifetimeMessageLimit: 2,
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
        messageId: blocked.message.messageId,
        deletedAtMs: 2_100,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: blocked.message.messageId });
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        principalId: blocked.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_200,
      }),
    ).toBe(true);
    expect(
      storage.setShareLinkWritesPaused({
        shareId: seeded.shareId,
        actorUserId: OWNER,
        pausedAtMs: 2_300,
      }),
    ).toBe(true);

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const reopened = openSyncRelayStorage(dbPath, {
      linkDiscussionMessageRateLimit: 2,
      linkDiscussionLifetimeMessageLimit: 2,
    });
    storages.push(reopened);
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
    expect(reopened.getShareLinkWritesPausedAtMs(seeded.shareId)).toBe(2_300);
    expect(reopened.listShareDiscussionMessages({ shareId: seeded.shareId, limit: 50 })).toMatchObject({
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

  it("replaces the pre-discussion normalized share schema as one authority model", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "pre-discussion" });
    storage.close();
    storages.splice(storages.indexOf(storage), 1);

    const oldSchema = new InspectionDatabaseSync(dbPath);
    try {
      oldSchema.exec(`
        PRAGMA foreign_keys = OFF;
        ALTER TABLE sync_relay_link_sessions RENAME TO old_link_sessions;
        CREATE TABLE sync_relay_link_sessions (
          session_id TEXT PRIMARY KEY,
          capability_hash TEXT NOT NULL UNIQUE,
          grant_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 1),
          minted_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          CHECK (expires_at_ms > minted_at_ms),
          FOREIGN KEY (grant_id)
            REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO sync_relay_link_sessions (
          session_id, capability_hash, grant_id, generation, minted_at_ms, expires_at_ms
        )
        SELECT session_id, capability_hash, grant_id, generation, minted_at_ms, expires_at_ms
        FROM old_link_sessions;
        DROP TABLE old_link_sessions;
      `);
    } finally {
      oldSchema.close();
    }

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    expect(reopened.getShare(seeded.shareId)).toBeNull();
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare("PRAGMA table_info(sync_relay_link_sessions)")
          .all()
          .map((row) => row.name),
      ).toContain("principal_id");
      expect(
        inspection
          .prepare("PRAGMA table_info(sync_relay_shares)")
          .all()
          .map((row) => row.name),
      ).toContain("link_writes_paused_at_ms");
      expect(
        inspection
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('sync_relay_link_principals', 'sync_relay_share_discussion_messages') ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        "sync_relay_link_principals",
        "sync_relay_share_discussion_messages",
      ]);
    } finally {
      inspection.close();
    }
  });

  it("creates principal and message CHECK clauses from the exported discussion bounds", async () => {
    const { dbPath } = await openStorage();
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      const principalSql = String(
        inspection
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_link_principals'",
          )
          .get()?.sql ?? "",
      );
      const messageSql = String(
        inspection
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_share_discussion_messages'",
          )
          .get()?.sql ?? "",
      );

      expect(principalSql).toContain(
        `length(display_name) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT}`,
      );
      expect(principalSql).toContain(
        `length(CAST(display_name AS BLOB)) <= ${LINK_DISCUSSION_NAME_BYTE_LIMIT}`,
      );
      expect(messageSql).toContain(
        `length(display_name_snapshot) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT}`,
      );
      expect(messageSql).toContain(
        `length(CAST(display_name_snapshot AS BLOB)) <= ${LINK_DISCUSSION_NAME_BYTE_LIMIT}`,
      );
      expect(messageSql).toContain(
        `length(body) BETWEEN 1 AND ${LINK_DISCUSSION_BODY_CODE_POINT_LIMIT}`,
      );
      expect(messageSql).toContain(
        `length(CAST(body AS BLOB)) <= ${LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT}`,
      );
    } finally {
      inspection.close();
    }
  });

  it.each([
    {
      label: "principal name",
      table: "sync_relay_link_principals",
      current: `length(display_name) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT}`,
      stale: `length(display_name) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT - 1}`,
    },
    {
      label: "message body",
      table: "sync_relay_share_discussion_messages",
      current: `length(body) BETWEEN 1 AND ${LINK_DISCUSSION_BODY_CODE_POINT_LIMIT}`,
      stale: `length(body) BETWEEN 1 AND ${LINK_DISCUSSION_BODY_CODE_POINT_LIMIT - 1}`,
    },
  ])("replaces the normalized share model when the $label CHECK is stale", async ({
    table,
    current,
    stale,
  }) => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "stale-schema" });
    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    replaceTableSchemaFragment(dbPath, table, current, stale);

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    expect(reopened.getShare(seeded.shareId)).toBeNull();

    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      const schemaSql = String(
        inspection
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)?.sql ?? "",
      );
      expect(schemaSql).toContain(current);
      expect(schemaSql).not.toContain(stale);
    } finally {
      inspection.close();
    }
  });

  it("keeps named display snapshots bounded across direct writes and restart", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "named-bound" });
    expect(
      storage.appendNamedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Stored Name",
        body: "bounded",
        idempotencyKey: "named-bounded",
        createdAtMs: 2_000,
        guard: () => {},
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.appendNamedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "x".repeat(LINK_DISCUSSION_NAME_CODE_POINT_LIMIT + 1),
        body: "overbound",
        idempotencyKey: "named-overbound",
        createdAtMs: 2_001,
        guard: () => {},
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    expect(
      reopened.listShareDiscussionMessages({ shareId: seeded.shareId, limit: 10 })
        .messages.map((message) => message.displayNameSnapshot),
    ).toEqual(["Stored Name"]);
    expect(
      reopened.appendNamedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "😀".repeat(LINK_DISCUSSION_NAME_CODE_POINT_LIMIT + 1),
        body: "overbound after restart",
        idempotencyKey: "named-overbound-restart",
        createdAtMs: 2_002,
        guard: () => {},
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("enforces the closed named and link author shapes in SQLite", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage);
    const accepted = append(storage, seeded);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const db = new InspectionDatabaseSync(dbPath);
    const insert = db.prepare(
      `INSERT INTO sync_relay_share_discussion_messages (
         message_id, share_id, idempotency_key, request_hash, author_kind,
         author_user_id, link_grant_id, link_principal_id, display_name_snapshot,
         body, created_at_ms, deleted_at_ms, deleted_by_user_id, storage_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );
    try {
      expect(() =>
        insert.run(
          "bad-incomplete",
          seeded.shareId,
          "bad-incomplete",
          "request-hash",
          "link",
          null,
          null,
          null,
          "Anonymous",
          "body",
          3_000,
          100,
        ),
      ).toThrow(/CHECK constraint/u);
      expect(() =>
        insert.run(
          "bad-mixed",
          seeded.shareId,
          "bad-mixed",
          "request-hash",
          "link",
          RECIPIENT,
          seeded.grantId,
          accepted.principal.principalId,
          "Anonymous",
          "body",
          3_001,
          100,
        ),
      ).toThrow(/CHECK constraint/u);
      expect(() =>
        insert.run(
          "bad-named",
          seeded.shareId,
          "bad-named",
          "request-hash",
          "named",
          null,
          seeded.grantId,
          accepted.principal.principalId,
          "Unnamed",
          "body",
          3_002,
          100,
        ),
      ).toThrow(/CHECK constraint/u);
      expect(() =>
        insert.run(
          "bad-name-code-points",
          seeded.shareId,
          "bad-name-code-points",
          "request-hash",
          "named",
          RECIPIENT,
          null,
          null,
          "x".repeat(LINK_DISCUSSION_NAME_CODE_POINT_LIMIT + 1),
          "body",
          3_003,
          100,
        ),
      ).toThrow(/CHECK constraint/u);
      expect(() =>
        insert.run(
          "bad-name-bytes",
          seeded.shareId,
          "bad-name-bytes",
          "request-hash",
          "named",
          RECIPIENT,
          null,
          null,
          "😀".repeat(LINK_DISCUSSION_NAME_CODE_POINT_LIMIT + 1),
          "body",
          3_004,
          100,
        ),
      ).toThrow(/CHECK constraint/u);
    } finally {
      db.close();
    }
  });
});
