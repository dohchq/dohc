import type { StorageContext } from "./context";
import type { SqliteDb, SyncRelayStorage } from "./types";

const MARKER = "share-invitation-emails-v1";
export const SHARE_INVITATION_EMAILS = "sync_relay_share_invitation_emails";

const SCHEMA = [
  `CREATE TABLE ${SHARE_INVITATION_EMAILS} (
  inviter_user_id TEXT NOT NULL CHECK (length(inviter_user_id) BETWEEN 1 AND 1024),
  attempted_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE INDEX idx_${SHARE_INVITATION_EMAILS}_inviter ON ${SHARE_INVITATION_EMAILS}(inviter_user_id)`,
  `CREATE INDEX idx_${SHARE_INVITATION_EMAILS}_time ON ${SHARE_INVITATION_EMAILS}(attempted_at_ms)`,
];

export function initializeShareInvitationEmailSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) return;
  for (const sql of SCHEMA) db.exec(sql);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

export type ShareInvitationEmailAdmission = { admitted: true } | { admitted: false; sent: number };

export function admitShareInvitationEmail(
  storage: SyncRelayStorage,
  input: { inviterUserId: string; nowMs: number; limit: number; windowMs: number },
): ShareInvitationEmailAdmission {
  const context = storage as StorageContext;
  return context.tx(() => {
    context.db
      .prepare(`DELETE FROM ${SHARE_INVITATION_EMAILS} WHERE attempted_at_ms <= ?`)
      .run(input.nowMs - input.windowMs);
    const sent = Number(
      context.db
        .prepare(`SELECT count(*) AS n FROM ${SHARE_INVITATION_EMAILS} WHERE inviter_user_id = ?`)
        .get(input.inviterUserId)!.n,
    );
    if (sent >= input.limit) return { admitted: false, sent };
    context.db
      .prepare(
        `INSERT INTO ${SHARE_INVITATION_EMAILS} (inviter_user_id, attempted_at_ms) VALUES (?, ?)`,
      )
      .run(input.inviterUserId, Math.trunc(input.nowMs));
    return { admitted: true };
  });
}
