import { randomBytes } from "node:crypto";
import { chatMessageInterest, readPushMessage, type ChatMessageReason } from "../chatMessageInterest";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

export const PUSH_DELIVERY_EXPIRY_MS = 15 * 60_000;
export const PUSH_DELIVERY_LEASE_MS = 30_000;
export const PUSH_DELIVERY_ATTEMPTS = 5;
export const PUSH_RECIPIENT_PENDING_LIMIT = 100;
export const PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE = 30;
const TABLE = "sync_relay_push_deliveries";
const MARKER = "push-deliveries-v1";
const configuredStorages = new WeakSet<StorageContext>();

export function configurePushDeliveries(storage: StorageContext, enabled: boolean): void {
  if (enabled) configuredStorages.add(storage);
  else configuredStorages.delete(storage);
}

const schema = {
  sync_relay_push_rate: `CREATE TABLE sync_relay_push_rate (
    account_user_id TEXT NOT NULL, minute INTEGER NOT NULL, attempts INTEGER NOT NULL,
    PRIMARY KEY (account_user_id, minute)
  ) STRICT`,
  sync_relay_push_installation_names: `CREATE TABLE sync_relay_push_installation_names (
    installation_id TEXT PRIMARY KEY REFERENCES sync_relay_push_subscriptions(installation_id) ON DELETE CASCADE,
    account_name TEXT NOT NULL CHECK (length(account_name) <= 1024)
  ) STRICT`,
  [TABLE]: `CREATE TABLE sync_relay_push_deliveries (
    delivery_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, relay_seq INTEGER NOT NULL,
    account_user_id TEXT NOT NULL, installation_id TEXT NOT NULL,
    generation INTEGER NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('mention','dm','reply')),
    state TEXT NOT NULL CHECK (state IN ('pending','sent','dropped')),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 5),
    created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
    available_at_ms INTEGER NOT NULL, last_attempt_at_ms INTEGER,
    lease_token TEXT, lease_until_ms INTEGER,
    UNIQUE (workspace_id, thread_id, message_id, installation_id, generation)
  ) STRICT`,
  idx_push_deliveries_due: `CREATE INDEX idx_push_deliveries_due ON sync_relay_push_deliveries(state, available_at_ms)`,
  idx_push_deliveries_recipient: `CREATE INDEX idx_push_deliveries_recipient ON sync_relay_push_deliveries(account_user_id, state, last_attempt_at_ms)`,
  idx_push_message_identity: `CREATE INDEX idx_push_message_identity ON sync_relay_log(workspace_id,
    json_extract(payload_json, '$.threadId'), json_extract(payload_json, '$.messageId'), relay_seq)
    WHERE op_kind = 'chat.message.append' AND json_valid(payload_json)`,
  idx_push_thread_participation: `CREATE INDEX idx_push_thread_participation ON sync_relay_log(workspace_id,
    json_extract(payload_json, '$.threadId'), json_extract(payload_json, '$.authorUserId'),
    json_extract(payload_json, '$.authorKind'), relay_seq)
    WHERE op_kind = 'chat.message.append' AND json_valid(payload_json)`,
} as const;

export function initializePushDeliveries(db: SqliteDb): void {
  const normalize = (sql: string) => sql.trim().replace(/\s+/gu, " ");
  const assert = () => {
    for (const [name, sql] of Object.entries(schema)) {
      const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
      if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(sql)) throw Error("push delivery schema is missing or damaged");
    }
  };
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assert();
    return;
  }
  for (const name of Object.keys(schema)) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name)) throw Error("unmarked push delivery schema already exists");
  }
  for (const sql of Object.values(schema)) db.exec(sql);
  assert();
  db.prepare("INSERT INTO sync_relay_migrations(migration_id, completed_at_ms) VALUES (?, ?)").run(MARKER, Date.now());
}

/** Runs inside the message append transaction. No network work may enter here. */
export function recordPushDeliveries(storage: StorageContext, relaySeq: number, nowMs = Date.now()): void {
  if (!configuredStorages.has(storage)) return;
  const message = readPushMessage(storage, relaySeq);
  if (!message) return;
  const first = storage.db.prepare(`SELECT relay_seq FROM sync_relay_log WHERE workspace_id = ?
    AND op_kind = 'chat.message.append' AND json_valid(payload_json)
    AND json_extract(payload_json, '$.threadId') = ? AND json_extract(payload_json, '$.messageId') = ?
    AND relay_admission IS NULL ORDER BY relay_seq LIMIT 1`).get(message.workspaceId, message.threadId, message.messageId);
  if (Number(first?.relay_seq) !== relaySeq) return;
  const recipients = storage.db.prepare(`SELECT p.installation_id, p.account_user_id, p.generation, n.account_name
    FROM sync_relay_push_subscriptions p LEFT JOIN sync_relay_push_installation_names n USING(installation_id)
    WHERE p.expires_at_ms > ? AND p.account_user_id IN (
      SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ? UNION
      SELECT g.principal_user_id FROM sync_relay_share_grants g JOIN sync_relay_shares s USING(share_id)
      WHERE s.workspace_id = ? AND g.status = 'active' AND g.principal_kind = 'user')`)
    .all(nowMs, message.workspaceId, message.workspaceId);
  const interests = new Map<string, ChatMessageReason | null>();
  for (const recipient of recipients) {
    const userId = String(recipient.account_user_id);
    if (!interests.has(userId)) interests.set(userId, chatMessageInterest(storage, message, {userId, accountName: String(recipient.account_name ?? "")}));
    const reason = interests.get(userId);
    if (!reason) continue;
    storage.db.prepare(`DELETE FROM ${TABLE} WHERE account_user_id = ? AND expires_at_ms <= ?
      AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`).run(userId, nowMs - PUSH_DELIVERY_EXPIRY_MS, nowMs);
    const count = storage.db.prepare(`SELECT count(*) AS n FROM ${TABLE} WHERE account_user_id = ? AND state = 'pending' AND expires_at_ms > ?`).get(userId, nowMs);
    if (Number(count?.n) >= PUSH_RECIPIENT_PENDING_LIMIT) continue;
    storage.db.prepare(`INSERT OR IGNORE INTO ${TABLE} (delivery_id, workspace_id, thread_id, message_id, relay_seq,
      account_user_id, installation_id, generation, reason, state, attempts, created_at_ms, expires_at_ms, available_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(randomBytes(16).toString("base64url"), message.workspaceId, message.threadId, message.messageId, relaySeq,
        userId, String(recipient.installation_id), Number(recipient.generation), reason, nowMs, nowMs + PUSH_DELIVERY_EXPIRY_MS, nowMs);
  }
}

export interface PushDelivery {
  deliveryId: string;
  relaySeq: number;
  userId: string;
  installationId: string;
  generation: number;
  reason: ChatMessageReason;
  attempts: number;
  expiresAtMs: number;
  leaseToken: string;
}

export function claimPushDelivery(storage: StorageContext, nowMs: number): PushDelivery | null {
  return storage.replicaViewTx(() => {
    const minute = Math.floor(nowMs / 60_000);
    storage.db.prepare("DELETE FROM sync_relay_push_rate WHERE minute < ?").run(minute - 1);
    storage.db.prepare(`DELETE FROM ${TABLE} WHERE expires_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`).run(nowMs - PUSH_DELIVERY_EXPIRY_MS, nowMs);
    storage.db.prepare(`UPDATE ${TABLE} SET state = 'dropped', lease_token = NULL, lease_until_ms = NULL
      WHERE state = 'pending' AND (expires_at_ms <= ? OR attempts >= ?) AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`)
      .run(nowMs, PUSH_DELIVERY_ATTEMPTS, nowMs);
    const row = storage.db.prepare(`SELECT d.* FROM ${TABLE} d WHERE state = 'pending' AND available_at_ms <= ?
      AND expires_at_ms > ? AND attempts < ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
      AND coalesce((SELECT attempts FROM sync_relay_push_rate r WHERE r.account_user_id = d.account_user_id AND r.minute = ?), 0) < ?
      ORDER BY created_at_ms, rowid LIMIT 1`).get(nowMs, nowMs, PUSH_DELIVERY_ATTEMPTS, nowMs, minute, PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE);
    if (!row) return null;
    storage.db.prepare(`INSERT INTO sync_relay_push_rate (account_user_id, minute, attempts) VALUES (?, ?, 1)
      ON CONFLICT(account_user_id, minute) DO UPDATE SET attempts = attempts + 1`).run(String(row.account_user_id), minute);
    const leaseToken = randomBytes(16).toString("base64url");
    storage.db.prepare(`UPDATE ${TABLE} SET lease_token = ?, lease_until_ms = ?, attempts = attempts + 1, last_attempt_at_ms = ? WHERE delivery_id = ?`)
      .run(leaseToken, nowMs + PUSH_DELIVERY_LEASE_MS, nowMs, String(row.delivery_id));
    return {
      deliveryId: String(row.delivery_id),
      relaySeq: Number(row.relay_seq),
      userId: String(row.account_user_id),
      installationId: String(row.installation_id),
      generation: Number(row.generation),
      reason: row.reason as ChatMessageReason,
      attempts: Number(row.attempts) + 1,
      expiresAtMs: Number(row.expires_at_ms),
      leaseToken,
    };
  });
}

export function finishPushDelivery(storage: StorageContext, delivery: PushDelivery, outcome: "sent" | "dropped" | "retry", nowMs: number): void {
  storage.replicaViewTx(() => storage.db.prepare(`UPDATE ${TABLE} SET state = ?, available_at_ms = ?, lease_token = NULL, lease_until_ms = NULL
    WHERE delivery_id = ? AND lease_token = ? AND state = 'pending'`).run(
      outcome === "retry" ? (delivery.attempts >= PUSH_DELIVERY_ATTEMPTS || delivery.expiresAtMs <= nowMs ? "dropped" : "pending") : outcome,
      nowMs + Math.min(120_000, 1000 * 2 ** delivery.attempts), delivery.deliveryId, delivery.leaseToken));
}

/** Includes leases and rate limits so an unavailable row cannot cause a busy loop. */
export function nextPushDeliveryAt(storage: StorageContext, nowMs: number): number | null {
  const minute = Math.floor(nowMs / 60_000);
  const row = storage.db.prepare(`SELECT min(
    CASE WHEN state <> 'pending' THEN expires_at_ms + ?
    ELSE max(coalesce(lease_until_ms, 0), min(expires_at_ms, max(available_at_ms,
      CASE WHEN coalesce((SELECT attempts FROM sync_relay_push_rate r
        WHERE r.account_user_id = d.account_user_id AND r.minute = ?), 0) >= ?
        THEN ? ELSE 0 END))) END) AS next_at
    FROM ${TABLE} d`).get(PUSH_DELIVERY_EXPIRY_MS, minute, PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE, (minute + 1) * 60_000);
  return row?.next_at == null ? null : Math.max(nowMs, Number(row.next_at));
}

export function ownsPushLease(storage: StorageContext, delivery: PushDelivery, nowMs: number): boolean {
  return Boolean(storage.db.prepare(`SELECT 1 FROM ${TABLE} WHERE delivery_id = ? AND lease_token = ?
    AND state = 'pending' AND lease_until_ms > ? AND expires_at_ms > ?`).get(delivery.deliveryId, delivery.leaseToken, nowMs, nowMs));
}
