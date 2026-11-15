import { normalizeRuleEmail } from "@dohc/security-contract/access-rules";
import type { SqliteDb } from "./types";

export interface AccountEmail {
  email: string;
  verified: boolean;
}

export function initializeAccountEmails(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_account_emails (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL, verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
    refreshed_at_ms INTEGER NOT NULL
  ) STRICT`);
}

export function accountEmail(db: SqliteDb, userId: string): AccountEmail | null {
  const row = db
    .prepare("SELECT email, verified FROM sync_relay_account_emails WHERE user_id = ?")
    .get(userId);
  return row ? { email: String(row.email), verified: row.verified === 1 } : null;
}

export function refreshAccountEmail(
  db: SqliteDb,
  userId: string,
  email: AccountEmail | null,
  nowMs: number,
): void {
  if (!email) {
    db.prepare("DELETE FROM sync_relay_account_emails WHERE user_id = ?").run(userId);
    return;
  }
  db.prepare(`INSERT INTO sync_relay_account_emails(user_id, email, verified, refreshed_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, verified = excluded.verified, refreshed_at_ms = excluded.refreshed_at_ms
    WHERE email != excluded.email OR verified != excluded.verified`).run(
    userId,
    normalizeRuleEmail(email.email),
    Number(email.verified),
    nowMs,
  );
}
