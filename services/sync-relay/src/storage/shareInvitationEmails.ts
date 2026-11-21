import type { StorageContext } from "./context";
import type { SqliteDb, SyncRelayStorage } from "./types";

const MARKER = "share-invitation-emails-v1";
const GRANT_MARKER = "share-invitation-email-grants-v1";
export const SHARE_INVITATION_EMAILS = "sync_relay_share_invitation_emails";

const SCHEMA = [
  `CREATE TABLE ${SHARE_INVITATION_EMAILS} (
  inviter_user_id TEXT NOT NULL CHECK (length(inviter_user_id) BETWEEN 1 AND 1024),
  attempted_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE INDEX idx_${SHARE_INVITATION_EMAILS}_inviter ON ${SHARE_INVITATION_EMAILS}(inviter_user_id)`,
  `CREATE INDEX idx_${SHARE_INVITATION_EMAILS}_time ON ${SHARE_INVITATION_EMAILS}(attempted_at_ms)`,
];

function migrated(db: SqliteDb, marker: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker),
  );
}

function markMigrated(db: SqliteDb, marker: string): void {
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    marker,
    Date.now(),
  );
}

export function initializeShareInvitationEmailSchema(db: SqliteDb): void {
  if (!migrated(db, MARKER)) {
    for (const sql of SCHEMA) db.exec(sql);
    markMigrated(db, MARKER);
  }
  if (!migrated(db, GRANT_MARKER)) {
    const columns = db
      .prepare(`PRAGMA table_info(${SHARE_INVITATION_EMAILS})`)
      .all()
      .map((row) => String(row.name));
    if (!columns.includes("grant_id"))
      db.exec(`ALTER TABLE ${SHARE_INVITATION_EMAILS} ADD COLUMN grant_id TEXT`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${SHARE_INVITATION_EMAILS}_grant ON ${SHARE_INVITATION_EMAILS}(grant_id)`,
    );
    markMigrated(db, GRANT_MARKER);
  }
}

export type ShareInvitationEmailAdmission =
  | { admitted: true; attemptId: number }
  | { admitted: false; refused: "limit"; sent: number }
  | { admitted: false; refused: "recent" };

export function admitShareInvitationEmail(
  storage: SyncRelayStorage,
  input: {
    inviterUserId: string;
    grantId: string;
    nowMs: number;
    limit: number;
    windowMs: number;
    grantIntervalMs: number | null;
  },
): ShareInvitationEmailAdmission {
  const context = storage as StorageContext;
  return context.tx(() => {
    context.db
      .prepare(`DELETE FROM ${SHARE_INVITATION_EMAILS} WHERE attempted_at_ms <= ?`)
      .run(input.nowMs - input.windowMs);
    if (
      input.grantIntervalMs !== null &&
      context.db
        .prepare(
          `SELECT 1 FROM ${SHARE_INVITATION_EMAILS} WHERE grant_id = ? AND attempted_at_ms > ? LIMIT 1`,
        )
        .get(input.grantId, input.nowMs - input.grantIntervalMs)
    )
      return { admitted: false, refused: "recent" };
    const sent = Number(
      context.db
        .prepare(`SELECT count(*) AS n FROM ${SHARE_INVITATION_EMAILS} WHERE inviter_user_id = ?`)
        .get(input.inviterUserId)!.n,
    );
    if (sent >= input.limit) return { admitted: false, refused: "limit", sent };
    const inserted = context.db
      .prepare(
        `INSERT INTO ${SHARE_INVITATION_EMAILS} (inviter_user_id, attempted_at_ms, grant_id) VALUES (?, ?, ?)`,
      )
      .run(input.inviterUserId, Math.trunc(input.nowMs), input.grantId);
    return { admitted: true, attemptId: Number(inserted.lastInsertRowid) };
  });
}

export function forgetShareInvitationEmailGrant(
  storage: SyncRelayStorage,
  attempt: { attemptId: number; inviterUserId: string; grantId: string },
): void {
  const context = storage as StorageContext;
  context.tx(() => {
    context.db
      .prepare(
        `UPDATE ${SHARE_INVITATION_EMAILS} SET grant_id = NULL
           WHERE rowid = ? AND inviter_user_id = ? AND grant_id = ?`,
      )
      .run(attempt.attemptId, attempt.inviterUserId, attempt.grantId);
  });
}
