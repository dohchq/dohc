import { randomBytes } from "node:crypto";
import {
  isOwnAgentMessage,
  phoneCanShow,
  pushMessageAccess,
  readPushMessage,
  type ChatMessageReason,
  type PushMessage,
} from "../chatMessageInterest";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

export const PUSH_DELIVERY_EXPIRY_MS = 15 * 60_000;
export const PUSH_DELIVERY_LEASE_MS = 30_000;
export const PUSH_DELIVERY_ATTEMPTS = 5;
export const PUSH_RECIPIENT_PENDING_LIMIT = 100;
export const PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE = 30;
export const PUSH_SENDER_ATTEMPTS_PER_MINUTE = 6;
const TABLE = "sync_relay_push_deliveries";
const MARKER = "push-deliveries-v1";
const NATIVE_MARKER = "push-native-deliveries-v1";
// Mentions match account names (accountNames.ts), so the names each
// installation once kept are gone.
const DROP_INSTALLATION_NAMES = "push-deliveries-v2";
const schema = {
  sync_relay_push_rate: `CREATE TABLE sync_relay_push_rate (
    account_user_id TEXT NOT NULL, minute INTEGER NOT NULL, attempts INTEGER NOT NULL,
    PRIMARY KEY (account_user_id, minute)
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

const nativeSchema = {
  ...schema,
  [TABLE]: `CREATE TABLE sync_relay_push_deliveries (
    delivery_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, relay_seq INTEGER,
    account_user_id TEXT NOT NULL, installation_id TEXT,
    generation INTEGER NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('mention','dm','reply','agent')),
    state TEXT NOT NULL CHECK (state IN ('pending','sent','dropped')),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 5),
    created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
    available_at_ms INTEGER NOT NULL, last_attempt_at_ms INTEGER,
    lease_token TEXT, lease_until_ms INTEGER,
    sender_key TEXT NOT NULL DEFAULT '', notice_id TEXT,
    UNIQUE (workspace_id, thread_id, message_id, generation)
  ) STRICT`,
  sync_relay_push_sender_rate: `CREATE TABLE sync_relay_push_sender_rate (
    account_user_id TEXT NOT NULL, sender_key TEXT NOT NULL, minute INTEGER NOT NULL, attempts INTEGER NOT NULL,
    PRIMARY KEY (account_user_id, sender_key, minute)
  ) STRICT`,
  sync_relay_push_device_names: `CREATE TABLE sync_relay_push_device_names (
    generation INTEGER PRIMARY KEY REFERENCES sync_relay_push_subscriptions(generation) ON DELETE CASCADE,
    account_name TEXT NOT NULL CHECK (length(account_name) <= 1024)
  ) STRICT`,
  sync_relay_push_arrivals: `CREATE TABLE sync_relay_push_arrivals (
    workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
    relay_seq INTEGER NOT NULL, arrived_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, thread_id, message_id)
  ) STRICT`,
  idx_push_arrivals_time: `CREATE INDEX idx_push_arrivals_time ON sync_relay_push_arrivals(arrived_at_ms)`,
} as const;
const V1_COLUMNS = `delivery_id, workspace_id, thread_id, message_id, relay_seq, account_user_id,
  installation_id, generation, reason, state, attempts, created_at_ms, expires_at_ms, available_at_ms,
  last_attempt_at_ms, lease_token, lease_until_ms`;

const normalize = (sql: string) => sql.trim().replace(/\s+/gu, " ");
const marked = (db: SqliteDb, marker: string) =>
  Boolean(db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker));
function assertSchema(db: SqliteDb, expected: Record<string, string>): void {
  for (const [name, sql] of Object.entries(expected)) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
    if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(sql))
      throw Error("push delivery schema is missing or damaged");
  }
}
const mark = (db: SqliteDb, marker: string) =>
  db
    .prepare("INSERT INTO sync_relay_migrations(migration_id, completed_at_ms) VALUES (?, ?)")
    .run(marker, Date.now());

export function initializePushDeliveries(db: SqliteDb): void {
  if (marked(db, MARKER)) {
    if (!marked(db, DROP_INSTALLATION_NAMES)) {
      db.exec("DROP TABLE IF EXISTS sync_relay_push_installation_names");
      mark(db, DROP_INSTALLATION_NAMES);
    }
    if (!marked(db, NATIVE_MARKER)) assertSchema(db, schema);
    return;
  }
  for (const name of [...Object.keys(schema), "sync_relay_push_installation_names"]) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name))
      throw Error("unmarked push delivery schema already exists");
  }
  for (const sql of Object.values(schema)) db.exec(sql);
  assertSchema(db, schema);
  mark(db, MARKER);
  mark(db, DROP_INSTALLATION_NAMES);
}

export function initializeNativePushDeliveries(db: SqliteDb): void {
  if (!marked(db, NATIVE_MARKER)) {
    const added = Object.keys(nativeSchema).filter((name) => !(name in schema));
    for (const name of added) {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name))
        throw Error("unmarked push delivery schema already exists");
    }
    db.exec(`CREATE TEMP TABLE push_deliveries_previous AS SELECT * FROM main.${TABLE};
      DROP TABLE main.${TABLE};`);
    db.exec(nativeSchema[TABLE]);
    db.exec(nativeSchema.idx_push_deliveries_due);
    db.exec(nativeSchema.idx_push_deliveries_recipient);
    db.exec(`INSERT INTO main.${TABLE} (${V1_COLUMNS})
        SELECT ${V1_COLUMNS} FROM temp.push_deliveries_previous;
      DROP TABLE temp.push_deliveries_previous;`);
    for (const name of added) db.exec(nativeSchema[name as keyof typeof nativeSchema]);
    mark(db, NATIVE_MARKER);
  }
  assertSchema(db, nativeSchema);
}

const firstAppendSeq = (
  storage: StorageContext,
  workspaceId: string,
  threadId: string,
  messageId: string,
) =>
  storage.db
    .prepare(`SELECT relay_seq FROM sync_relay_log WHERE workspace_id = ?
    AND op_kind = 'chat.message.append' AND json_valid(payload_json)
    AND json_extract(payload_json, '$.threadId') = ? AND json_extract(payload_json, '$.messageId') = ?
    AND relay_admission IS NULL ORDER BY relay_seq LIMIT 1`)
    .get(workspaceId, threadId, messageId)?.relay_seq;

function senderKey(storage: StorageContext, message: PushMessage): string {
  if (message.authorUserId !== null) return `user:${message.authorUserId}`;
  const grant = storage.db
    .prepare("SELECT grant_id FROM sync_relay_link_principals WHERE principal_id = ?")
    .get(message.linkPrincipalId)?.grant_id;
  return `link:${String(grant ?? message.linkPrincipalId)}`;
}

function dropOlderPhoneAlerts(
  storage: StorageContext,
  row: { generation: number; workspaceId: string; threadId: string },
  nowMs: number,
): void {
  const thread = [row.generation, row.workspaceId, row.threadId] as const;
  storage.db
    .prepare(`UPDATE ${TABLE} SET state = 'dropped' WHERE generation = ? AND workspace_id = ?
      AND thread_id = ? AND state = 'pending' AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
      AND relay_seq < (SELECT max(relay_seq) FROM ${TABLE} WHERE generation = ? AND workspace_id = ?
        AND thread_id = ? AND state = 'pending' AND expires_at_ms > ?)`)
    .run(...thread, nowMs, ...thread, nowMs);
}

interface DeliveryRow {
  workspaceId: string;
  threadId: string;
  messageId: string;
  relaySeq: number | null;
  userId: string;
  installationId: string | null;
  generation: number;
  reason: ChatMessageReason;
  senderKey: string;
  noticeId: string | null;
  expiresAtMs: number;
}

function insertDelivery(storage: StorageContext, row: DeliveryRow, nowMs: number): void {
  const db = storage.db;
  db.prepare(`DELETE FROM ${TABLE} WHERE account_user_id = ? AND expires_at_ms <= ?
    AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`).run(
    row.userId,
    nowMs - PUSH_DELIVERY_EXPIRY_MS,
    nowMs,
  );
  const count = db
    .prepare(
      `SELECT count(*) AS n FROM ${TABLE} WHERE account_user_id = ? AND state = 'pending' AND expires_at_ms > ?`,
    )
    .get(row.userId, nowMs);
  if (Number(count?.n) >= PUSH_RECIPIENT_PENDING_LIMIT) return;
  const key = [row.workspaceId, row.threadId, row.messageId, row.generation] as const;
  const deliveryId = randomBytes(16).toString("base64url");
  const inserted = db
    .prepare(`INSERT OR IGNORE INTO ${TABLE} (delivery_id, workspace_id, thread_id, message_id, relay_seq,
      account_user_id, installation_id, generation, reason, state, attempts, created_at_ms, expires_at_ms,
      available_at_ms, sender_key, notice_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`)
    .run(
      deliveryId,
      ...key.slice(0, 3),
      row.relaySeq,
      row.userId,
      row.installationId,
      row.generation,
      row.reason,
      nowMs,
      row.expiresAtMs,
      nowMs,
      row.senderKey,
      row.noticeId,
    ).changes;
  if (!inserted) {
    if (row.noticeId !== null)
      db.prepare(`UPDATE ${TABLE} SET notice_id = ? WHERE workspace_id = ? AND thread_id = ?
        AND message_id = ? AND generation = ? AND notice_id IS NULL`).run(row.noticeId, ...key);
    return;
  }
  if (row.installationId === null && row.relaySeq !== null)
    dropOlderPhoneAlerts(storage, row, nowMs);
}

/**
 * Notes when a message arrived, so a phone alert an agent's Notice queued
 * before its message can follow it. Runs inside the message append
 * transaction, once per message. No network work may enter here.
 */
export function recordPushArrival(
  storage: StorageContext,
  message: PushMessage,
  nowMs: number,
): void {
  if (!storage.options.apnsConfigured) return;
  const { workspaceId, threadId, messageId, relaySeq } = message;
  storage.db
    .prepare("DELETE FROM sync_relay_push_arrivals WHERE arrived_at_ms <= ?")
    .run(nowMs - PUSH_DELIVERY_EXPIRY_MS);
  storage.db
    .prepare(`INSERT OR IGNORE INTO sync_relay_push_arrivals
      (workspace_id, thread_id, message_id, relay_seq, arrived_at_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(workspaceId, threadId, messageId, relaySeq, nowMs);
  for (const row of storage.db
    .prepare(`SELECT delivery_id, account_user_id, generation, expires_at_ms, state FROM ${TABLE}
      WHERE workspace_id = ? AND thread_id = ? AND message_id = ? AND relay_seq IS NULL`)
    .all(workspaceId, threadId, messageId)) {
    const userId = String(row.account_user_id);
    const deliveryId = String(row.delivery_id);
    if (
      row.state !== "pending" ||
      Number(row.expires_at_ms) <= nowMs ||
      !isOwnAgentMessage(message, userId) ||
      !pushMessageAccess(storage, message, userId) ||
      !phoneCanShow(storage, userId, workspaceId, threadId)
    ) {
      storage.db.prepare(`DELETE FROM ${TABLE} WHERE delivery_id = ?`).run(deliveryId);
      continue;
    }
    storage.db
      .prepare(`UPDATE ${TABLE} SET relay_seq = ?, expires_at_ms = ? WHERE delivery_id = ?`)
      .run(relaySeq, nowMs + PUSH_DELIVERY_EXPIRY_MS, deliveryId);
    dropOlderPhoneAlerts(
      storage,
      { generation: Number(row.generation), workspaceId, threadId },
      nowMs,
    );
  }
}

/**
 * Queues one recipient's alert on each of their devices: the browser for a
 * mention, a direct message or a reply, and the owner's phone when it may show
 * the thread. Runs inside the message append transaction. No network work may
 * enter here.
 */
export function recordPushDeliveries(
  storage: StorageContext,
  message: PushMessage,
  userId: string,
  reason: ChatMessageReason,
  nowMs: number,
): void {
  const { pushConfigured, apnsConfigured } = storage.options;
  const { workspaceId, threadId, messageId, relaySeq } = message;
  const native =
    apnsConfigured && phoneCanShow(storage, userId, workspaceId, threadId)
      ? storage.db
          .prepare(`SELECT generation FROM sync_relay_push_subscriptions
          WHERE kind = 'apns' AND account_user_id = ? AND expires_at_ms > ?`)
          .all(userId, nowMs)
      : [];
  const web =
    pushConfigured && reason !== "agent"
      ? storage.db
          .prepare(`SELECT installation_id, generation FROM sync_relay_push_subscriptions
          WHERE kind = 'web' AND account_user_id = ? AND expires_at_ms > ?`)
          .all(userId, nowMs)
      : [];
  if (native.length === 0 && web.length === 0) return;
  const sender = senderKey(storage, message);
  for (const device of [...web, ...native])
    insertDelivery(
      storage,
      {
        workspaceId,
        threadId,
        messageId,
        relaySeq,
        userId,
        installationId:
          device.installation_id === undefined ? null : String(device.installation_id),
        generation: Number(device.generation),
        reason,
        senderKey: sender,
        noticeId: null,
        expiresAtMs: nowMs + PUSH_DELIVERY_EXPIRY_MS,
      },
      nowMs,
    );
}

export function recordNoticePushDeliveries(
  storage: StorageContext,
  input: {
    userId: string;
    workspaceId: string;
    threadId: string;
    messageId: string;
    noticeId: string;
    nowMs: number;
  },
): void {
  const { userId, workspaceId, threadId, messageId, nowMs } = input;
  if (!storage.options.apnsConfigured || !phoneCanShow(storage, userId, workspaceId, threadId))
    return;
  const bindings = storage.db
    .prepare(`SELECT generation FROM sync_relay_push_subscriptions
      WHERE kind = 'apns' AND account_user_id = ? AND expires_at_ms > ?`)
    .all(userId, nowMs);
  if (!bindings.length) return;
  const arrival = storage.db
    .prepare(`SELECT relay_seq, arrived_at_ms FROM sync_relay_push_arrivals
      WHERE workspace_id = ? AND thread_id = ? AND message_id = ?`)
    .get(workspaceId, threadId, messageId);
  let relaySeq: number | null = null;
  let expiresAtMs = nowMs + PUSH_DELIVERY_EXPIRY_MS;
  if (arrival) {
    expiresAtMs = Number(arrival.arrived_at_ms) + PUSH_DELIVERY_EXPIRY_MS;
    const message = readPushMessage(storage, Number(arrival.relay_seq));
    if (
      expiresAtMs <= nowMs ||
      !message ||
      !isOwnAgentMessage(message, userId) ||
      !pushMessageAccess(storage, message, userId)
    )
      return;
    relaySeq = message.relaySeq;
  } else if (firstAppendSeq(storage, workspaceId, threadId, messageId) !== undefined) {
    return;
  }
  for (const binding of bindings)
    insertDelivery(
      storage,
      {
        workspaceId,
        threadId,
        messageId,
        relaySeq,
        userId,
        installationId: null,
        generation: Number(binding.generation),
        reason: "agent",
        senderKey: `user:${userId}`,
        noticeId: input.noticeId,
        expiresAtMs,
      },
      nowMs,
    );
}

export interface PushDelivery {
  deliveryId: string;
  relaySeq: number;
  userId: string;
  installationId: string | null;
  generation: number;
  reason: ChatMessageReason;
  attempts: number;
  expiresAtMs: number;
  leaseToken: string;
}

export function claimPushDelivery(
  storage: StorageContext,
  nowMs: number,
  options: { native?: boolean } = {},
): PushDelivery | null {
  return storage.quietTx(() => {
    const minute = Math.floor(nowMs / 60_000);
    storage.db.prepare("DELETE FROM sync_relay_push_rate WHERE minute < ?").run(minute - 1);
    storage.db.prepare("DELETE FROM sync_relay_push_sender_rate WHERE minute < ?").run(minute - 1);
    storage.db
      .prepare("DELETE FROM sync_relay_push_arrivals WHERE arrived_at_ms <= ?")
      .run(nowMs - PUSH_DELIVERY_EXPIRY_MS);
    storage.db
      .prepare(
        `DELETE FROM ${TABLE} WHERE expires_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
      )
      .run(nowMs - PUSH_DELIVERY_EXPIRY_MS, nowMs);
    storage.db
      .prepare(`UPDATE ${TABLE} SET state = 'dropped', lease_token = NULL, lease_until_ms = NULL
      WHERE state = 'pending' AND (expires_at_ms <= ? OR attempts >= ?) AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`)
      .run(nowMs, PUSH_DELIVERY_ATTEMPTS, nowMs);
    const row = storage.db
      .prepare(`SELECT d.* FROM ${TABLE} d WHERE state = 'pending' AND relay_seq IS NOT NULL
      AND available_at_ms <= ? AND expires_at_ms > ? AND attempts < ?
      AND (lease_until_ms IS NULL OR lease_until_ms <= ?) AND (? OR installation_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM ${TABLE} o WHERE o.account_user_id = d.account_user_id
        AND o.state = 'pending' AND o.lease_until_ms > ?)
      AND coalesce((SELECT attempts FROM sync_relay_push_rate r WHERE r.account_user_id = d.account_user_id AND r.minute = ?), 0) < ?
      AND (installation_id IS NOT NULL OR coalesce((SELECT attempts FROM sync_relay_push_sender_rate s
        WHERE s.account_user_id = d.account_user_id AND s.sender_key = d.sender_key AND s.minute = ?), 0) < ?)
      ORDER BY coalesce((SELECT max(o.last_attempt_at_ms) FROM ${TABLE} o WHERE o.account_user_id = d.account_user_id), 0),
        created_at_ms, rowid LIMIT 1`)
      .get(
        nowMs,
        nowMs,
        PUSH_DELIVERY_ATTEMPTS,
        nowMs,
        options.native === false ? 0 : 1,
        nowMs,
        minute,
        PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE,
        minute,
        PUSH_SENDER_ATTEMPTS_PER_MINUTE,
      );
    if (!row) return null;
    storage.db
      .prepare(`INSERT INTO sync_relay_push_rate (account_user_id, minute, attempts) VALUES (?, ?, 1)
      ON CONFLICT(account_user_id, minute) DO UPDATE SET attempts = attempts + 1`)
      .run(String(row.account_user_id), minute);
    if (row.installation_id === null)
      storage.db
        .prepare(`INSERT INTO sync_relay_push_sender_rate (account_user_id, sender_key, minute, attempts)
        VALUES (?, ?, ?, 1) ON CONFLICT(account_user_id, sender_key, minute) DO UPDATE SET attempts = attempts + 1`)
        .run(String(row.account_user_id), String(row.sender_key), minute);
    const leaseToken = randomBytes(16).toString("base64url");
    storage.db
      .prepare(
        `UPDATE ${TABLE} SET lease_token = ?, lease_until_ms = ?, attempts = attempts + 1, last_attempt_at_ms = ? WHERE delivery_id = ?`,
      )
      .run(leaseToken, nowMs + PUSH_DELIVERY_LEASE_MS, nowMs, String(row.delivery_id));
    return {
      deliveryId: String(row.delivery_id),
      relaySeq: Number(row.relay_seq),
      userId: String(row.account_user_id),
      installationId: row.installation_id === null ? null : String(row.installation_id),
      generation: Number(row.generation),
      reason: row.reason as ChatMessageReason,
      attempts: Number(row.attempts) + 1,
      expiresAtMs: Number(row.expires_at_ms),
      leaseToken,
    };
  });
}

export function finishPushDelivery(
  storage: StorageContext,
  delivery: PushDelivery,
  outcome: "sent" | "dropped" | "retry",
  nowMs: number,
): void {
  storage.quietTx(() => {
    const finished = storage.db
      .prepare(`UPDATE ${TABLE} SET state = ?, available_at_ms = ?, lease_token = NULL, lease_until_ms = NULL
    WHERE delivery_id = ? AND lease_token = ? AND state = 'pending'`)
      .run(
        outcome === "retry"
          ? delivery.attempts >= PUSH_DELIVERY_ATTEMPTS || delivery.expiresAtMs <= nowMs
            ? "dropped"
            : "pending"
          : outcome,
        nowMs + Math.min(120_000, 1000 * 2 ** delivery.attempts),
        delivery.deliveryId,
        delivery.leaseToken,
      ).changes;
    if (finished && outcome === "retry" && delivery.installationId === null)
      dropRetryBehindNewerPhoneAlert(storage, delivery.deliveryId);
  });
}

function dropRetryBehindNewerPhoneAlert(storage: StorageContext, deliveryId: string): void {
  storage.db
    .prepare(`UPDATE ${TABLE} SET state = 'dropped' WHERE delivery_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM ${TABLE} n WHERE n.installation_id IS NULL
        AND n.generation = ${TABLE}.generation AND n.workspace_id = ${TABLE}.workspace_id
        AND n.thread_id = ${TABLE}.thread_id AND n.relay_seq > ${TABLE}.relay_seq
        AND n.state IN ('pending', 'sent'))`)
    .run(deliveryId);
}

export function pausePushDelivery(
  storage: StorageContext,
  delivery: PushDelivery,
  untilMs: number,
): void {
  storage.quietTx(() =>
    storage.db
      .prepare(`UPDATE ${TABLE} SET available_at_ms = ?, attempts = max(attempts - 1, 0),
        lease_token = NULL, lease_until_ms = NULL WHERE delivery_id = ? AND lease_token = ? AND state = 'pending'`)
      .run(untilMs, delivery.deliveryId, delivery.leaseToken),
  );
}

/** Includes leases and rate limits so an unavailable row cannot cause a busy loop. */
export function nextPushDeliveryAt(
  storage: StorageContext,
  nowMs: number,
  nativeFromMs = 0,
): number | null {
  const minute = Math.floor(nowMs / 60_000);
  const nextMinute = (minute + 1) * 60_000;
  const row = storage.db
    .prepare(`SELECT min(
    CASE WHEN state <> 'pending' THEN expires_at_ms + ?
    WHEN relay_seq IS NULL THEN expires_at_ms
    ELSE max(coalesce(lease_until_ms, 0), min(expires_at_ms, max(available_at_ms,
      CASE WHEN installation_id IS NULL THEN ? ELSE 0 END,
      coalesce((SELECT max(o.lease_until_ms) FROM ${TABLE} o WHERE o.account_user_id = d.account_user_id
        AND o.state = 'pending' AND o.lease_until_ms > ?), 0),
      CASE WHEN coalesce((SELECT attempts FROM sync_relay_push_rate r
        WHERE r.account_user_id = d.account_user_id AND r.minute = ?), 0) >= ? THEN ? ELSE 0 END,
      CASE WHEN installation_id IS NULL AND coalesce((SELECT attempts FROM sync_relay_push_sender_rate s
        WHERE s.account_user_id = d.account_user_id AND s.sender_key = d.sender_key AND s.minute = ?), 0) >= ?
        THEN ? ELSE 0 END))) END) AS next_at
    FROM ${TABLE} d`)
    .get(
      PUSH_DELIVERY_EXPIRY_MS,
      nativeFromMs,
      nowMs,
      minute,
      PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE,
      nextMinute,
      minute,
      PUSH_SENDER_ATTEMPTS_PER_MINUTE,
      nextMinute,
    );
  return row?.next_at == null ? null : Math.max(nowMs, Number(row.next_at));
}

export function readPushLease(
  storage: StorageContext,
  delivery: PushDelivery,
  nowMs: number,
): { noticeId: string | null } | null {
  const row = storage.db
    .prepare(`SELECT notice_id FROM ${TABLE} WHERE delivery_id = ? AND lease_token = ?
    AND state = 'pending' AND lease_until_ms > ? AND expires_at_ms > ?`)
    .get(delivery.deliveryId, delivery.leaseToken, nowMs, nowMs);
  return row ? { noticeId: row.notice_id === null ? null : String(row.notice_id) } : null;
}
