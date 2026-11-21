import { createHash } from "node:crypto";
import { normalizeRuleEmail } from "@dohc/security-contract/access-rules";
import type { SqliteDb } from "./types";

/**
 * What the relay last learned of an account's email. Only a verified address
 * matches a person entry in a rule (decision 17A), so only that one is kept.
 * No row means the relay hasn't looked, and rules naming people fail closed.
 */
export interface AccountEmail {
  verifiedEmail: string | null;
}

export function initializeAccountEmails(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_account_emails (
    user_id TEXT PRIMARY KEY, verified_email TEXT, refreshed_at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_retired_rule_emails (email_sha256 TEXT PRIMARY KEY) STRICT`);
}

const emailDigest = (email: string) =>
  createHash("sha256").update(normalizeRuleEmail(email)).digest("hex");

/**
 * Records a deleted account's address. A person entry naming it named that
 * account, so no later account at the address matches it. Kept as a digest.
 */
export function retireRuleEmail(db: SqliteDb, email: string): void {
  db.prepare("INSERT OR IGNORE INTO sync_relay_retired_rule_emails VALUES (?)").run(
    emailDigest(email),
  );
}

export function ruleEmailRetired(db: SqliteDb, email: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sync_relay_retired_rule_emails WHERE email_sha256 = ?")
    .get(emailDigest(email));
}

export function accountEmail(db: SqliteDb, userId: string): AccountEmail | null {
  const row = db
    .prepare("SELECT verified_email FROM sync_relay_account_emails WHERE user_id = ?")
    .get(userId);
  return row
    ? { verifiedEmail: row.verified_email === null ? null : String(row.verified_email) }
    : null;
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
  db.prepare(`INSERT INTO sync_relay_account_emails(user_id, verified_email, refreshed_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET verified_email = excluded.verified_email, refreshed_at_ms = excluded.refreshed_at_ms
    WHERE verified_email IS NOT excluded.verified_email`).run(
    userId,
    email.verifiedEmail === null ? null : normalizeRuleEmail(email.verifiedEmail),
    nowMs,
  );
}
