import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  openSyncRelayStorage,
  type OpenSyncRelayStorageOptions,
  type SyncRelayLinkSessionRow,
  type SyncRelayStorage,
} from "./storage";
import type {
  RecipientBudgetRaceOperation,
  RecipientBudgetRaceWorkerData,
} from "./recipientBudgetRaceWorker.test-helper";

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
    guard: () => input.role ?? "recipient",
  });
}

async function raceDiscussionAppends(
  dbPath: string,
  options: RecipientBudgetRaceWorkerData["options"],
  operations: readonly [RecipientBudgetRaceOperation, RecipientBudgetRaceOperation],
): Promise<unknown[]> {
  const workers = operations.map((operation, index) =>
    new Worker(new URL("./recipientBudgetRaceWorker.test-helper.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      workerData: {
        dbPath,
        idPrefix: `race-${index + 1}`,
        options,
        operation,
      } satisfies RecipientBudgetRaceWorkerData,
    })
  );
  try {
    await Promise.all(workers.map((worker) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (message: { kind?: string }) => {
          if (message.kind !== "ready") return;
          worker.off("error", reject);
          worker.off("message", onMessage);
          resolve();
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
      })
    ));
    const results = workers.map((worker) =>
      new Promise<unknown>((resolve, reject) => {
        worker.once("message", (message: {
          kind?: string;
          result?: unknown;
          error?: string;
        }) => {
          if (message.kind === "result") resolve(message.result);
          else reject(new Error(message.error ?? "discussion race worker failed"));
        });
        worker.once("error", reject);
      })
    );
    for (const worker of workers) worker.postMessage("go");
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
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

function aggregateWorkspaceUsageBytes(dbPath: string, workspaceId: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
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
  } finally {
    db.close();
  }
}

function storedWorkspaceUsageBytes(dbPath: string, workspaceId: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          `SELECT usage_bytes
           FROM sync_relay_workspace_usage
           WHERE workspace_id = ?`,
        )
        .get(workspaceId)?.usage_bytes ?? -1,
    );
  } finally {
    db.close();
  }
}

function expectExactWorkspaceUsage(dbPath: string, workspaceId: string): number {
  const aggregate = aggregateWorkspaceUsageBytes(dbPath, workspaceId);
  expect(storedWorkspaceUsageBytes(dbPath, workspaceId)).toBe(aggregate);
  return aggregate;
}

function tracePreparedSql<T>(storage: SyncRelayStorage, action: () => T): {
  events: Array<{ kind: "exec" | "prepare"; sql: string }>;
  preparedSql: string[];
  result: T;
} {
  const db = (storage as unknown as { db: InspectionDatabase }).db;
  const events: Array<{ kind: "exec" | "prepare"; sql: string }> = [];
  const originalPrepare = db.prepare.bind(db);
  const originalExec = db.exec.bind(db);
  const prepare = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    events.push({ kind: "prepare", sql });
    return originalPrepare(sql);
  });
  const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
    events.push({ kind: "exec", sql });
    originalExec(sql);
  });
  try {
    const result = action();
    return {
      events,
      preparedSql: events
        .filter((event) => event.kind === "prepare")
        .map((event) => event.sql),
      result,
    };
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
  }
}

const QUOTA_AGGREGATE_TABLES = [
  "sync_relay_blobs",
  "sync_relay_log",
  "sync_relay_key_envelopes",
  "sync_relay_key_envelope_history",
  "sync_relay_epoch_supersessions",
  "sync_relay_share_discussion_messages AS message",
  "sync_relay_link_principals AS principal",
] as const;

function quotaAggregateSql(preparedSql: readonly string[]): string[] {
  return preparedSql.filter((sql) =>
    /\bSUM\s*\(/iu.test(sql) && QUOTA_AGGREGATE_TABLES.some((table) => sql.includes(table))
  );
}

function expectStoredUsageReadInsideTransaction(
  trace: ReturnType<typeof tracePreparedSql>,
): void {
  const begin = trace.events.findIndex((event) =>
    event.kind === "exec" && event.sql === "BEGIN IMMEDIATE"
  );
  const usageRead = trace.events.findIndex((event) =>
    event.kind === "prepare" && event.sql.includes("FROM sync_relay_workspace_usage")
  );
  const commit = trace.events.findIndex((event) =>
    event.kind === "exec" && event.sql === "COMMIT"
  );
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(usageRead).toBeGreaterThan(begin);
  expect(commit).toBeGreaterThan(usageRead);
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
  it("stores the normalized owner discussion body", async () => {
    const { storage } = await openStorage();
    const seeded = seedShare(storage, { suffix: "owner-body-normalization" });

    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: OWNER,
        role: "owner",
        displayName: "Owner",
        body: "e\u0301",
        idempotencyKey: "owner-body-normalization",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({
      ok: true,
      message: { body: "é" },
    });
  });

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
      guard: () => "recipient",
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
      guard: () => "owner",
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
        workspaceId: capped.workspaceId,
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
    ).toMatchObject({ ok: true, grant: { generation: 1, access: "view" } });
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
    ).toMatchObject({ ok: true, grant: { generation: 2, access: "comment" } });
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_400,
      }),
    ).toBe(true);
    expect(
      storage.setLinkPrincipalBlocked({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
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
    ).toMatchObject({ ok: true, grant: { generation: 3 } });

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
        workspaceId: paused.workspaceId,
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
        workspaceId: blocked.workspaceId,
        principalId: accepted.principal.principalId,
        actorUserId: OWNER,
        blockedAtMs: 2_100,
      }),
    ).toBe(true);
    const blockedRevision = storage.getShareDiscussionRevision(blocked.shareId);
    const blockedUsage = discussionUsageBytes(dbPath);
    const blockedPrincipalCount = countRows(dbPath, "sync_relay_link_principals");
    const blockedMessageCount = countRows(
      dbPath,
      "sync_relay_share_discussion_messages",
    );
    expect(
      append(storage, blocked, {
        profile: "blocked",
        idempotencyKey: "refused-on-existing-session-after-block",
        createdAtMs: 2_101,
      }),
    ).toMatchObject({ ok: false, reason: "blocked" });
    expect(
      append(storage, blocked, {
        profile: "substituted-profile",
        idempotencyKey: "refused-substituted-profile-on-blocked-session",
        createdAtMs: 2_102,
      }),
    ).toMatchObject({ ok: false, reason: "not-authorized" });
    expect(storage.findLinkSessionByCapabilityHash(blocked.capabilityHash)).toMatchObject({
      grantId: blocked.grantId,
      principalId: accepted.principal.principalId,
    });
    expect(countRows(dbPath, "sync_relay_link_principals")).toBe(blockedPrincipalCount);
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(
      blockedMessageCount,
    );
    expect(storage.getShareDiscussionRevision(blocked.shareId)).toBe(blockedRevision);
    expect(discussionUsageBytes(dbPath)).toBe(blockedUsage);
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

  it("makes the link path count a named-only combined ceiling", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 10,
      discussionNonOwnerShareRowLimit: 2,
    });
    const seeded = seedShare(storage, { suffix: "link-after-named-limit" });
    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "named-limit-one",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: "second-named-recipient",
        displayName: "Second Recipient",
        idempotencyKey: "named-limit-two",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });
    const before = {
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    };

    expect(
      append(storage, seeded, {
        profile: "link-after-named-limit",
        claimedName: "Link Visitor",
        idempotencyKey: "link-after-named-limit",
        createdAtMs: 2_002,
      }),
    ).toEqual({ ok: false, reason: "share-limit" });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      principals: countRows(dbPath, "sync_relay_link_principals"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(before);
  });

  it("keeps tombstones in recipient rate and combined share debt", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 1,
      discussionLifetimeMessageLimit: 10,
      discussionNonOwnerShareRowLimit: 1,
    });
    const seeded = seedShare(storage, { suffix: "named-tombstone-debt" });
    const first = appendAuthenticated(storage, seeded, {
      idempotencyKey: "tombstone-first",
      createdAtMs: 2_000,
    });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(
      storage.deleteShareDiscussionMessage({
        shareId: seeded.shareId,
        workspaceId: seeded.workspaceId,
        messageId: first.message.messageId,
        deletedAtMs: 2_001,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: first.message.messageId });

    const afterDelete = {
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    };
    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "tombstone-rate",
        createdAtMs: 2_002,
      }),
    ).toEqual({ ok: false, reason: "rate-limit" });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(afterDelete);

    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: "other-tombstone-recipient",
        displayName: "Other Recipient",
        idempotencyKey: "tombstone-share",
        createdAtMs: 62_001,
      }),
    ).toEqual({ ok: false, reason: "share-limit" });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(afterDelete);

    expect(
      appendAuthenticated(storage, seeded, {
        authorUserId: OWNER,
        role: "owner",
        displayName: "Owner",
        idempotencyKey: "owner-after-tombstone",
        createdAtMs: 62_002,
      }),
    ).toMatchObject({ ok: true, message: { authorKind: "owner" } });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
  });

  it("pins the rolling boundary and keeps debt across a backward clock", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 1,
      discussionLifetimeMessageLimit: 10,
      discussionNonOwnerShareRowLimit: 10,
    });
    const boundary = seedShare(storage, { suffix: "named-rate-boundary" });
    expect(
      appendAuthenticated(storage, boundary, {
        idempotencyKey: "boundary-first",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      appendAuthenticated(storage, boundary, {
        idempotencyKey: "boundary-exact",
        createdAtMs: 62_000,
      }),
    ).toMatchObject({ ok: true });

    const backward = seedShare(storage, { suffix: "named-rate-backward" });
    expect(
      appendAuthenticated(storage, backward, {
        idempotencyKey: "backward-first",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true });
    const beforeBackwardRefusal = {
      messages: storage.listShareDiscussionMessages({
        shareId: backward.shareId,
        limit: 10,
      }).messages,
      revision: storage.getShareDiscussionRevision(backward.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, backward.workspaceId),
    };
    expect(
      appendAuthenticated(storage, backward, {
        idempotencyKey: "backward-second",
        createdAtMs: 1_000,
      }),
    ).toEqual({ ok: false, reason: "rate-limit" });
    expect({
      messages: storage.listShareDiscussionMessages({
        shareId: backward.shareId,
        limit: 10,
      }).messages,
      revision: storage.getShareDiscussionRevision(backward.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, backward.workspaceId),
    }).toEqual(beforeBackwardRefusal);
  });

  it("keeps exact recipient replay free at lifetime, share, and workspace ceilings", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 1,
      discussionNonOwnerShareRowLimit: 1,
    });
    const seeded = seedShare(storage, { suffix: "named-replay-ceilings" });
    const first = appendAuthenticated(storage, seeded, {
      body: "Replay at every ceiling",
      idempotencyKey: "replay-ceilings",
      createdAtMs: 2_000,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    if (!first.ok) return;
    const fullUsage = storedWorkspaceUsageBytes(dbPath, seeded.workspaceId);
    const before = {
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: fullUsage,
    };
    expect(
      appendAuthenticated(storage, seeded, {
        body: "Replay at every ceiling",
        idempotencyKey: "replay-ceilings",
        createdAtMs: 70_000,
      }),
    ).toMatchObject({
      ok: true,
      replayed: true,
      message: { messageId: first.message.messageId },
    });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      revision: storage.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(before);

    const quotaLimited = openSyncRelayStorage(dbPath, {
      workspaceQuotaBytes: fullUsage,
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 1,
      discussionNonOwnerShareRowLimit: 1,
      newDiscussionId: () => "replay-ceilings-unexpected-id",
    });
    storages.push(quotaLimited);
    expect(
      quotaLimited.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Recipient",
        body: "Replay at every ceiling",
        idempotencyKey: "replay-ceilings",
        createdAtMs: 70_001,
        guard: () => "recipient",
      }),
    ).toMatchObject({
      ok: true,
      replayed: true,
      message: { messageId: first.message.messageId },
    });
    expect({
      messages: countRows(dbPath, "sync_relay_share_discussion_messages"),
      revision: quotaLimited.getShareDiscussionRevision(seeded.shareId),
      usage: storedWorkspaceUsageBytes(dbPath, seeded.workspaceId),
    }).toEqual(before);
  });

  it("keeps authenticated replay stable across owner and recipient role changes", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 1,
      discussionLifetimeMessageLimit: 1,
      discussionNonOwnerShareRowLimit: 1,
    });
    const authorUserId = "role-changing-user";
    const ownerFirst = seedShare(storage, { suffix: "role-replay-owner" });
    const ownerMessage = appendAuthenticated(storage, ownerFirst, {
      authorUserId,
      role: "owner",
      displayName: "Role Changer",
      body: "Written as owner",
      idempotencyKey: "role-replay",
      createdAtMs: 2_000,
    });
    expect(ownerMessage).toMatchObject({
      ok: true,
      replayed: false,
      message: { authorKind: "owner" },
    });
    if (!ownerMessage.ok) return;
    expect(
      append(storage, ownerFirst, {
        idempotencyKey: "fill-owner-first-budget",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true, replayed: false });
    const ownerFirstState = {
      rows: storage.listShareDiscussionMessages({
        shareId: ownerFirst.shareId,
        limit: 10,
      }).messages,
      usage: storedWorkspaceUsageBytes(dbPath, ownerFirst.workspaceId),
      revision: storage.getShareDiscussionRevision(ownerFirst.shareId),
    };
    expect(
      appendAuthenticated(storage, ownerFirst, {
        authorUserId,
        role: "recipient",
        displayName: "Role Changer",
        body: "Written as owner",
        idempotencyKey: "role-replay",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({
      ok: true,
      replayed: true,
      message: {
        messageId: ownerMessage.message.messageId,
        authorKind: "owner",
      },
    });
    expect(
      appendAuthenticated(storage, ownerFirst, {
        authorUserId,
        role: "recipient",
        displayName: "Role Changer",
        body: "Changed after becoming a recipient",
        idempotencyKey: "role-replay",
        createdAtMs: 2_002,
      }),
    ).toEqual({ ok: false, reason: "idempotency-conflict" });
    expect({
      rows: storage.listShareDiscussionMessages({
        shareId: ownerFirst.shareId,
        limit: 10,
      }).messages,
      usage: storedWorkspaceUsageBytes(dbPath, ownerFirst.workspaceId),
      revision: storage.getShareDiscussionRevision(ownerFirst.shareId),
    }).toEqual(ownerFirstState);

    const recipientFirst = seedShare(storage, { suffix: "role-replay-recipient" });
    const recipientMessage = appendAuthenticated(storage, recipientFirst, {
      authorUserId,
      role: "recipient",
      displayName: "Role Changer",
      body: "Written as recipient",
      idempotencyKey: "role-replay",
      createdAtMs: 3_000,
    });
    expect(recipientMessage).toMatchObject({
      ok: true,
      replayed: false,
      message: { authorKind: "named" },
    });
    if (!recipientMessage.ok) return;
    expect(
      appendAuthenticated(storage, recipientFirst, {
        authorUserId,
        role: "owner",
        displayName: "Role Changer",
        body: "Written as recipient",
        idempotencyKey: "role-replay",
        createdAtMs: 3_001,
      }),
    ).toMatchObject({
      ok: true,
      replayed: true,
      message: {
        messageId: recipientMessage.message.messageId,
        authorKind: "named",
      },
    });
    expect(
      appendAuthenticated(storage, recipientFirst, {
        authorUserId,
        role: "owner",
        displayName: "Role Changer",
        body: "Changed after becoming owner",
        idempotencyKey: "role-replay",
        createdAtMs: 3_001,
      }),
    ).toEqual({ ok: false, reason: "idempotency-conflict" });
    expect(
      storage.listShareDiscussionMessages({ shareId: recipientFirst.shareId, limit: 10 })
        .messages,
    ).toMatchObject([
      {
        messageId: recipientMessage.message.messageId,
        authorKind: "named",
        body: "Written as recipient",
      },
    ]);
    expectExactWorkspaceUsage(dbPath, ownerFirst.workspaceId);
    expectExactWorkspaceUsage(dbPath, recipientFirst.workspaceId);
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
      storage.listShareDiscussionMessages({ shareId: firstShare.shareId, limit: 10 })
        .messages,
    ).toHaveLength(2);
    expect(
      storage.listShareDiscussionMessages({ shareId: secondShare.shareId, limit: 10 })
        .messages,
    ).toHaveLength(1);
    expectExactWorkspaceUsage(dbPath, firstShare.workspaceId);
    expectExactWorkspaceUsage(dbPath, secondShare.workspaceId);
  });

  it.each([
    {
      label: "rolling rate",
      options: {
        discussionMessageRateLimit: 1,
        discussionLifetimeMessageLimit: 10,
        discussionNonOwnerShareRowLimit: 10,
      },
      rejected: "rate-limit",
    },
    {
      label: "lifetime",
      options: {
        discussionMessageRateLimit: 10,
        discussionLifetimeMessageLimit: 1,
        discussionNonOwnerShareRowLimit: 10,
      },
      rejected: "lifetime-limit",
    },
  ] as const)(
    "serializes two-handle recipient $label final-slot races",
    async ({ options, rejected }) => {
      const { storage, dbPath } = await openStorage(options);
      const seeded = seedShare(storage, { suffix: `named-race-${rejected}` });
      const operation = (idempotencyKey: string): RecipientBudgetRaceOperation => ({
        kind: "named",
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Recipient",
        body: "Concurrent recipient message",
        idempotencyKey,
        createdAtMs: 2_000,
      });

      const results = await raceDiscussionAppends(dbPath, options, [
        operation(`${rejected}-one`),
        operation(`${rejected}-two`),
      ]);

      expect(results).toHaveLength(2);
      expect(results.filter((result) =>
        (result as { ok?: boolean }).ok === true
      )).toHaveLength(1);
      expect(results.filter((result) =>
        (result as { reason?: string }).reason === rejected
      )).toHaveLength(1);
      expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(1);
      expect(storage.getShareDiscussionRevision(seeded.shareId)).toBe(1);
      expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    },
  );

  it("serializes a two-handle combined non-owner final-slot race", async () => {
    const options = {
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 10,
      discussionNonOwnerShareRowLimit: 1,
    };
    const { storage, dbPath } = await openStorage(options);
    const seeded = seedShare(storage, { suffix: "combined-race" });

    const results = await raceDiscussionAppends(dbPath, options, [
      {
        kind: "named",
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Recipient",
        body: "Named final slot",
        idempotencyKey: "combined-named",
        createdAtMs: 2_000,
      },
      {
        kind: "link",
        capabilityHash: seeded.capabilityHash,
        profileTokenHash: profileHash("combined-race"),
        claimedName: "Link visitor",
        body: "Link final slot",
        idempotencyKey: "combined-link",
        createdAtMs: 2_000,
      },
    ]);

    expect(results.filter((result) =>
      (result as { ok?: boolean }).ok === true
    )).toHaveLength(1);
    expect(results.filter((result) =>
      (result as { reason?: string }).reason === "share-limit"
    )).toHaveLength(1);
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sync_relay_share_discussion_messages
             WHERE share_id = ? AND author_kind IN ('named', 'link')`,
          )
          .get(seeded.shareId)?.count,
      ).toBe(1);
    } finally {
      inspection.close();
    }
    expect(storage.getShareDiscussionRevision(seeded.shareId)).toBe(1);
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
  });

  it("replays one exact recipient request across two concurrent handles", async () => {
    const options = {
      discussionMessageRateLimit: 1,
      discussionLifetimeMessageLimit: 1,
      discussionNonOwnerShareRowLimit: 1,
    };
    const { storage, dbPath } = await openStorage(options);
    const seeded = seedShare(storage, { suffix: "recipient-replay-race" });
    const operation: RecipientBudgetRaceOperation = {
      kind: "named",
      shareId: seeded.shareId,
      authorUserId: RECIPIENT,
      displayName: "Recipient",
      body: "Exact concurrent replay",
      idempotencyKey: "recipient-exact-replay",
      createdAtMs: 2_000,
    };

    const results = await raceDiscussionAppends(dbPath, options, [operation, operation]);
    expect(results.filter((result) =>
      (result as { ok?: boolean; replayed?: boolean }).ok === true &&
      (result as { replayed?: boolean }).replayed === false
    )).toHaveLength(1);
    expect(results.filter((result) =>
      (result as { ok?: boolean; replayed?: boolean }).ok === true &&
      (result as { replayed?: boolean }).replayed === true
    )).toHaveLength(1);
    const messageIds = results.map((result) =>
      (result as { message?: { messageId?: string } }).message?.messageId
    );
    expect(new Set(messageIds).size).toBe(1);
    expect(countRows(dbPath, "sync_relay_share_discussion_messages")).toBe(1);
    expect(storage.getShareDiscussionRevision(seeded.shareId)).toBe(1);
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
  });

  it("keeps recipient and combined budget reads indexed inside the write transaction", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "named-budget-plan" });
    expect(
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "plan-first",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      append(storage, seeded, {
        idempotencyKey: "plan-link",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });

    const trace = tracePreparedSql(storage, () =>
      appendAuthenticated(storage, seeded, {
        idempotencyKey: "plan-second",
        createdAtMs: 70_000,
      })
    );
    expect(trace.result).toMatchObject({ ok: true, replayed: false });
    const begin = trace.events.findIndex(
      (event) => event.kind === "exec" && event.sql === "BEGIN IMMEDIATE",
    );
    const rate = trace.events.findIndex(
      (event) =>
        event.kind === "prepare" &&
        event.sql.includes("author_kind = 'named'") &&
        event.sql.includes("created_at_ms >"),
    );
    const lifetime = trace.events.findIndex(
      (event) =>
        event.kind === "prepare" &&
        event.sql.includes("author_kind = 'named'") &&
        !event.sql.includes("created_at_ms >") &&
        event.sql.includes("COUNT(*)"),
    );
    const combined = trace.events.findIndex(
      (event) =>
        event.kind === "prepare" &&
        event.sql.includes("author_kind IN ('named', 'link')") &&
        event.sql.includes("COUNT(*)"),
    );
    const commit = trace.events.findIndex(
      (event) => event.kind === "exec" && event.sql === "COMMIT",
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(rate).toBeGreaterThan(begin);
    expect(lifetime).toBeGreaterThan(rate);
    expect(combined).toBeGreaterThan(lifetime);
    expect(commit).toBeGreaterThan(combined);

    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      const ratePlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*)
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_kind = 'named'
             AND author_user_id = ?
             AND created_at_ms > ?`,
        )
        .all(seeded.shareId, RECIPIENT, 0)
        .map((row) => String(row.detail));
      const lifetimePlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*)
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_kind = 'named'
             AND author_user_id = ?`,
        )
        .all(seeded.shareId, RECIPIENT)
        .map((row) => String(row.detail));
      const replayPlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT message_id
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_kind IN ('owner', 'named')
             AND author_user_id = ?
             AND idempotency_key = ?
           LIMIT 1`,
        )
        .all(seeded.shareId, RECIPIENT, "plan-first")
        .map((row) => String(row.detail));
      const combinedPlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*)
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ? AND author_kind IN ('named', 'link')`,
        )
        .all(seeded.shareId)
        .map((row) => String(row.detail));
      const linkRatePlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*)
           FROM sync_relay_share_discussion_messages
           WHERE author_kind = 'link'
             AND link_principal_id = ?
             AND created_at_ms > ?`,
        )
        .all("plan-principal", 0)
        .map((row) => String(row.detail));
      const linkLifetimePlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*)
           FROM sync_relay_share_discussion_messages
           WHERE author_kind = 'link' AND link_principal_id = ?`,
        )
        .all("plan-principal")
        .map((row) => String(row.detail));
      const linkReplayPlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT message_id
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_kind = 'link'
             AND link_principal_id = ?
             AND idempotency_key = ?
           LIMIT 1`,
        )
        .all(seeded.shareId, "plan-principal", "plan-link")
        .map((row) => String(row.detail));
      const workspaceUsagePlan = inspection
        .prepare(
          `EXPLAIN QUERY PLAN SELECT usage_bytes
           FROM sync_relay_workspace_usage
           WHERE workspace_id = ?`,
        )
        .all(seeded.workspaceId)
        .map((row) => String(row.detail));
      for (const [plan, index] of [
        [ratePlan, "idx_sync_relay_share_discussion_named_budget"],
        [lifetimePlan, "idx_sync_relay_share_discussion_named_budget"],
        [replayPlan, "idx_sync_relay_share_discussion_user_replay"],
        [combinedPlan, "idx_sync_relay_share_discussion_non_owner_budget"],
        [linkRatePlan, "idx_sync_relay_share_discussion_principal_budget"],
        [linkLifetimePlan, "idx_sync_relay_share_discussion_principal_budget"],
        [linkReplayPlan, "idx_sync_relay_share_discussion_link_replay"],
      ] as const) {
        const detail = plan.join("\n");
        expect(detail).toContain("SEARCH sync_relay_share_discussion_messages");
        expect(detail).toContain(index);
        expect(detail).not.toContain("SCAN sync_relay_share_discussion_messages");
      }
      expect(workspaceUsagePlan.join("\n")).toContain(
        "SEARCH sync_relay_workspace_usage USING INDEX " +
          "sqlite_autoindex_sync_relay_workspace_usage_1 (workspace_id=?)",
      );
      expect(workspaceUsagePlan.join("\n")).not.toContain(
        "SCAN sync_relay_workspace_usage",
      );
    } finally {
      inspection.close();
    }
  });

  it("keeps recipient debt through deletion, promotion, regrant, and reopen", async () => {
    const { storage, dbPath } = await openStorage({
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 2,
      discussionNonOwnerShareRowLimit: 10,
    });
    const seeded = seedShare(storage, { suffix: "named-debt" });
    expect(
      storage.convertLinkGrant({
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
      storage.convertLinkGrant({
        shareId: seeded.shareId,
        parentGrantId: seeded.grantId,
        grantId: "named-debt-regrant",
        principalUserId: "promoted-recipient",
        createdAtMs: 2_300,
      }),
    ).toMatchObject({ ok: true });

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const reopened = openSyncRelayStorage(dbPath, {
      discussionMessageRateLimit: 10,
      discussionLifetimeMessageLimit: 2,
      discussionNonOwnerShareRowLimit: 10,
    });
    storages.push(reopened);
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

  it("reads one stored workspace total instead of aggregating history during quota checks", async () => {
    const { storage } = await openStorage();
    const seeded = seedShare(storage, { suffix: "quota-trace" });
    const historicalBlob = Buffer.from("historical blob");
    const historicalBlobSha = createHash("sha256").update(historicalBlob).digest("hex");
    expect(
      storage.putBlob({
        workspaceId: seeded.workspaceId,
        sha256: historicalBlobSha,
        content: historicalBlob,
        createdAtMs: 1_100,
      }),
    ).toMatchObject({ alreadyHad: false });
    expect(
      storage.appendLogBatch({
        workspaceId: seeded.workspaceId,
        originId: "quota-trace-origin",
        ops: [{
          originSeq: 0,
          opKind: "quota.trace",
          payloadJson: JSON.stringify({ historical: true }),
          recordedAtMs: 1_101,
        }],
      }),
    ).toMatchObject({ inserted: 1 });
    const firstEnvelope = storage.putKeyEnvelope({
      workspaceId: seeded.workspaceId,
      envelopeJson: JSON.stringify({ generation: 1 }),
      updatedAtMs: 1_102,
      expectedSha256: null,
    });
    storage.putKeyEnvelope({
      workspaceId: seeded.workspaceId,
      envelopeJson: JSON.stringify({ generation: 2 }),
      updatedAtMs: 1_103,
      expectedSha256: firstEnvelope.sha256,
    });
    expect(
      storage.claimWorkspaceIdentity({
        workspaceId: seeded.workspaceId,
        replicationEpoch: "quota-trace-epoch-1",
        streamIdentity: "quota-trace-stream-1",
      }),
    ).toBe("claimed");
    expect(
      storage.rotateWorkspaceIdentity({
        workspaceId: seeded.workspaceId,
        ownerUserId: OWNER,
        replicationEpoch: "quota-trace-epoch-2",
        streamIdentity: "quota-trace-stream-2",
        rotatedAtMs: 1_104,
      }),
    ).toBe("rotated");
    expect(
      append(storage, seeded, {
        profile: "quota-trace-profile",
        claimedName: "Trace Link",
        body: "historical comment",
        idempotencyKey: "quota-trace-history",
        createdAtMs: 2_000,
      }),
    ).toMatchObject({ ok: true });

    const link = tracePreparedSql(storage, () =>
      append(storage, seeded, {
        profile: "quota-trace-profile",
        body: "traced link comment",
        idempotencyKey: "quota-trace-link",
        createdAtMs: 2_001,
      })
    );
    const named = tracePreparedSql(storage, () =>
      storage.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Trace Named",
        body: "traced named comment",
        idempotencyKey: "quota-trace-named",
        createdAtMs: 2_002,
        guard: () => "recipient",
      })
    );
    const asserted = tracePreparedSql(storage, () => {
      const content = Buffer.from("new quota probe");
      return storage.putBlob({
        workspaceId: seeded.workspaceId,
        sha256: createHash("sha256").update(content).digest("hex"),
        content,
        createdAtMs: 2_003,
      });
    });
    expect(link.result).toMatchObject({ ok: true });
    expect(named.result).toMatchObject({ ok: true });
    expect(asserted.result).toMatchObject({ alreadyHad: false });

    expect({
      link: quotaAggregateSql(link.preparedSql),
      named: quotaAggregateSql(named.preparedSql),
      asserted: quotaAggregateSql(asserted.preparedSql),
    }).toEqual({ link: [], named: [], asserted: [] });
    expect({
      link: link.preparedSql.filter((sql) => sql.includes("FROM sync_relay_workspace_usage")),
      named: named.preparedSql.filter((sql) => sql.includes("FROM sync_relay_workspace_usage")),
      asserted: asserted.preparedSql.filter((sql) =>
        sql.includes("FROM sync_relay_workspace_usage")
      ),
    }).toMatchObject({
      link: [expect.stringContaining("SELECT usage_bytes")],
      named: [expect.stringContaining("SELECT usage_bytes")],
      asserted: [expect.stringContaining("SELECT usage_bytes")],
    });
    expectStoredUsageReadInsideTransaction(link);
    expectStoredUsageReadInsideTransaction(named);
    expectStoredUsageReadInsideTransaction(asserted);
  });

  it("does not rebuild the durable workspace total on an ordinary reopen", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "usage-reopen" });
    expect(
      append(storage, seeded, {
        profile: "usage-reopen-profile",
        body: "survives an ordinary reopen",
        idempotencyKey: "usage-reopen",
      }),
    ).toMatchObject({ ok: true });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    storage.close();
    storages.splice(storages.indexOf(storage), 1);

    const audit = new InspectionDatabaseSync(dbPath);
    try {
      audit.exec(`
        CREATE TABLE sync_relay_workspace_usage_delete_audit (
          workspace_id TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER audit_sync_relay_workspace_usage_delete
        AFTER DELETE ON sync_relay_workspace_usage
        BEGIN
          INSERT INTO sync_relay_workspace_usage_delete_audit (workspace_id)
          VALUES (OLD.workspace_id);
        END;
      `);
    } finally {
      audit.close();
    }

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare("SELECT COUNT(*) AS count FROM sync_relay_workspace_usage_delete_audit")
          .get()?.count,
      ).toBe(0);
    } finally {
      inspection.close();
    }
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
  });

  it("backfills the durable workspace total when its migration marker is absent", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "usage-backfill" });
    expect(
      append(storage, seeded, {
        profile: "usage-backfill-profile",
        body: "restored by the one-time backfill",
        idempotencyKey: "usage-backfill",
      }),
    ).toMatchObject({ ok: true });
    const expectedUsage = expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    expect(expectedUsage).toBeGreaterThan(0);
    storage.close();
    storages.splice(storages.indexOf(storage), 1);

    const stale = new InspectionDatabaseSync(dbPath);
    try {
      stale
        .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes = 0 WHERE workspace_id = ?")
        .run(seeded.workspaceId);
      stale
        .prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?")
        .run("workspace-usage-backfill-v1");
    } finally {
      stale.close();
    }

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(expectedUsage);
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_migrations WHERE migration_id = ?",
          )
          .get("workspace-usage-backfill-v1")?.count,
      ).toBe(1);
    } finally {
      inspection.close();
    }
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
        ops: [{
          originSeq: 0,
          opKind: "quota.lifecycle",
          payloadJson: JSON.stringify({ row: "log" }),
          recordedAtMs: 1_102,
        }],
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

    const second = openSyncRelayStorage(dbPath, {
      blobGraceMs: 0,
      newDiscussionId: () => "usage-second-message",
    });
    storages.push(second);
    expect(
      second.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Usage Named",
        body: "counted named comment",
        idempotencyKey: "usage-named",
        createdAtMs: 2_001,
        guard: () => "recipient",
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
        guard: () => "recipient",
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

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    second.close();
    storages.splice(storages.indexOf(second), 1);
    const reopened = openSyncRelayStorage(dbPath, {
      blobGraceMs: 0,
      newDiscussionId: () => "usage-rejected-message",
    });
    storages.push(reopened);
    const reopenedUsage = expectExactWorkspaceUsage(dbPath, seeded.workspaceId);
    const limited = openSyncRelayStorage(dbPath, {
      workspaceQuotaBytes: reopenedUsage,
      newDiscussionId: () => "usage-over-quota-message",
    });
    storages.push(limited);
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

  it.each(["grant", "share"] as const)(
    "keeps the durable workspace total exact across a cascading %s delete",
    async (deletedModel) => {
      const { storage, dbPath } = await openStorage();
      const seeded = seedShare(storage, { suffix: `usage-cascade-${deletedModel}` });
      expect(
        append(storage, seeded, {
          profile: `usage-cascade-${deletedModel}`,
          claimedName: "Usage Cascade",
          body: "removed by cascade",
          idempotencyKey: `usage-cascade-${deletedModel}`,
        }),
      ).toMatchObject({ ok: true });
      expectExactWorkspaceUsage(dbPath, seeded.workspaceId);

      const inspection = new InspectionDatabaseSync(dbPath);
      try {
        inspection.exec("PRAGMA foreign_keys = ON");
        if (deletedModel === "grant") {
          inspection
            .prepare("DELETE FROM sync_relay_share_grants WHERE grant_id = ?")
            .run(seeded.grantId);
        } else {
          inspection
            .prepare("DELETE FROM sync_relay_shares WHERE share_id = ?")
            .run(seeded.shareId);
        }
      } finally {
        inspection.close();
      }

      expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(0);
    },
  );

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

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const reopened = openSyncRelayStorage(dbPath, {
      discussionMessageRateLimit: 2,
      discussionLifetimeMessageLimit: 2,
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
      expect(messageSql).toContain("author_kind IN ('owner', 'named', 'link')");
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
    {
      label: "message author roles",
      table: "sync_relay_share_discussion_messages",
      current: "author_kind IN ('owner', 'named', 'link')",
      stale: "author_kind IN ('named', 'link')",
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

  it("reconciles the stored workspace total after normalized-share replacement", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "usage-reconcile" });
    const blob = Buffer.from("usage survives share replacement");
    expect(
      storage.putBlob({
        workspaceId: seeded.workspaceId,
        sha256: createHash("sha256").update(blob).digest("hex"),
        content: blob,
        createdAtMs: 1_100,
      }),
    ).toMatchObject({ alreadyHad: false });
    expect(
      append(storage, seeded, {
        profile: "usage-reconcile-profile",
        claimedName: "Usage Reconcile",
        body: "removed with normalized share model",
        idempotencyKey: "usage-reconcile",
      }),
    ).toMatchObject({ ok: true });
    expectExactWorkspaceUsage(dbPath, seeded.workspaceId);

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    replaceTableSchemaFragment(
      dbPath,
      "sync_relay_link_principals",
      `length(display_name) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT}`,
      `length(display_name) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT - 1}`,
    );

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    expect(reopened.getShare(seeded.shareId)).toBeNull();
    expect(expectExactWorkspaceUsage(dbPath, seeded.workspaceId)).toBe(blob.byteLength);
  });

  it("keeps named display snapshots bounded across direct writes and restart", async () => {
    const { storage, dbPath } = await openStorage();
    const seeded = seedShare(storage, { suffix: "named-bound" });
    expect(
      storage.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "Stored Name",
        body: "bounded",
        idempotencyKey: "named-bounded",
        createdAtMs: 2_000,
        guard: () => "recipient",
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "x".repeat(LINK_DISCUSSION_NAME_CODE_POINT_LIMIT + 1),
        body: "overbound",
        idempotencyKey: "named-overbound",
        createdAtMs: 2_001,
        guard: () => "recipient",
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
      reopened.appendAuthenticatedDiscussionMessage({
        shareId: seeded.shareId,
        authorUserId: RECIPIENT,
        displayName: "😀".repeat(LINK_DISCUSSION_NAME_CODE_POINT_LIMIT + 1),
        body: "overbound after restart",
        idempotencyKey: "named-overbound-restart",
        createdAtMs: 2_002,
        guard: () => "recipient",
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
