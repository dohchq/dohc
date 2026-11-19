import type { ApnsEnvironment } from "@dohc/workspace-contracts/push-subscriptions";
import type { StorageContext } from "./context";
import { notFound } from "../errors";
import { accountIsFenced } from "./accountDeletion";
import { SyncRelayConflictError } from "./errors";
import { PUSH_REVOKED_SESSIONS, PUSH_SUBSCRIPTIONS } from "./pushSchema";
import { nextGeneration, PUSH_INSTALLATIONS_PER_ACCOUNT } from "./pushSubscriptions";

/** One phone sign-in's native binding. The session is its only key. */
export interface PushDeviceRow {
  userId: string;
  sessionId: string;
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  generation: number;
  expiresAtMs: number;
}

export interface BindPushDeviceInput {
  userId: string;
  sessionId: string;
  sessionExpiresAtMs: number;
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  accountName?: string;
  nowMs: number;
}

const COLUMNS =
  "account_user_id, session_id, apns_token, apns_environment, apns_topic, generation, expires_at_ms";

function rowFrom(row: Record<string, unknown>): PushDeviceRow {
  return {
    userId: String(row.account_user_id),
    sessionId: String(row.session_id),
    token: String(row.apns_token),
    environment: row.apns_environment as ApnsEnvironment,
    topic: String(row.apns_topic),
    generation: Number(row.generation),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

/** Ends the bindings `where` selects, with every delivery queued for them. */
function endBindings(storage: StorageContext, where: string, ...values: unknown[]): void {
  storage.db
    .prepare(`DELETE FROM sync_relay_push_deliveries WHERE generation IN
      (SELECT generation FROM ${PUSH_SUBSCRIPTIONS} WHERE ${where})`)
    .run(...values);
  storage.db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE ${where}`).run(...values);
}

export function readPushDevice(
  storage: StorageContext,
  input: { userId: string; sessionId: string; nowMs: number },
): PushDeviceRow | null {
  const row = storage.db
    .prepare(`SELECT ${COLUMNS} FROM ${PUSH_SUBSCRIPTIONS}
      WHERE kind = 'apns' AND session_id = ? AND account_user_id = ? AND expires_at_ms > ?`)
    .get(input.sessionId, input.userId, input.nowMs);
  return row ? rowFrom(row) : null;
}

/** Ends every phone binding whose sign-in has expired, and forgets revoked sign-ins that have too. */
export function sweepExpiredPushDevices(storage: StorageContext, nowMs: number): void {
  storage.tx(() => {
    endBindings(storage, "kind = 'apns' AND expires_at_ms <= ?", nowMs);
    storage.db.prepare(`DELETE FROM ${PUSH_REVOKED_SESSIONS} WHERE expires_at_ms <= ?`).run(nowMs);
  });
}

/**
 * Binds the caller's phone sign-in to its device token. Asking again with
 * the same token changes nothing. Any other binding that holds the token
 * ends first, so the caller learns nothing about who held it: either way
 * the result is a binding under a generation no binding had before.
 */
export function bindPushDevice(storage: StorageContext, input: BindPushDeviceInput): PushDeviceRow {
  const named = (row: PushDeviceRow): PushDeviceRow => {
    storage.db
      .prepare(`INSERT INTO sync_relay_push_device_names (generation, account_name) VALUES (?, ?)
        ON CONFLICT(generation) DO UPDATE SET account_name = excluded.account_name`)
      .run(row.generation, (input.accountName ?? "").slice(0, 1024));
    return row;
  };
  return storage.tx(() => {
    const db = storage.db;
    // Deletion fences the account in its own transaction; a bind that waited on it must not land after.
    if (accountIsFenced(storage, input.userId)) throw notFound();
    // A session the account is revoking, or has revoked, must not take a token back, even
    // when this request's lookup began first.
    if (
      db
        .prepare(`SELECT 1 FROM ${PUSH_REVOKED_SESSIONS}
          WHERE session_id = ? AND account_user_id = ? AND expires_at_ms > ?`)
        .get(input.sessionId, input.userId, input.nowMs)
    )
      throw notFound();
    const existing = readPushDevice(storage, input);
    if (
      existing &&
      existing.token === input.token &&
      existing.environment === input.environment &&
      existing.topic === input.topic
    ) {
      db.prepare(`UPDATE ${PUSH_SUBSCRIPTIONS} SET expires_at_ms = ?, updated_at_ms = max(updated_at_ms, ?)
          WHERE kind = 'apns' AND session_id = ?`).run(
        input.sessionExpiresAtMs,
        input.nowMs,
        input.sessionId,
      );
      return named({ ...existing, expiresAtMs: input.sessionExpiresAtMs });
    }
    endBindings(
      storage,
      "kind = 'apns' AND (session_id = ? OR (apns_topic = ? AND apns_environment = ? AND apns_token = ?))",
      input.sessionId,
      input.topic,
      input.environment,
      input.token,
    );
    const held = Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM ${PUSH_SUBSCRIPTIONS} WHERE account_user_id = ? AND expires_at_ms > ?`,
        )
        .get(input.userId, input.nowMs)!.n,
    );
    if (held >= PUSH_INSTALLATIONS_PER_ACCOUNT)
      throw new SyncRelayConflictError("too many devices have alerts on for this account");
    const generation = nextGeneration(storage);
    db.prepare(`INSERT INTO ${PUSH_SUBSCRIPTIONS} (kind, account_user_id, session_id, apns_token, apns_environment,
      apns_topic, generation, created_at_ms, updated_at_ms, expires_at_ms) VALUES ('apns', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.userId,
      input.sessionId,
      input.token,
      input.environment,
      input.topic,
      generation,
      input.nowMs,
      input.nowMs,
      input.sessionExpiresAtMs,
    );
    return named({
      userId: input.userId,
      sessionId: input.sessionId,
      token: input.token,
      environment: input.environment,
      topic: input.topic,
      generation,
      expiresAtMs: input.sessionExpiresAtMs,
    });
  });
}

export function readLivePushDevice(
  storage: StorageContext,
  generation: number,
  nowMs: number,
): PushDeviceRow | null {
  const row = storage.db
    .prepare(`SELECT ${COLUMNS} FROM ${PUSH_SUBSCRIPTIONS} s WHERE kind = 'apns' AND generation = ?
      AND expires_at_ms > ? AND NOT EXISTS (SELECT 1 FROM ${PUSH_REVOKED_SESSIONS} r
        WHERE r.session_id = s.session_id AND r.account_user_id = s.account_user_id AND r.expires_at_ms > ?)`)
    .get(generation, nowMs, nowMs);
  return row ? rowFrom(row) : null;
}

export function removeUnregisteredPushDevice(
  storage: StorageContext,
  generation: number,
  unregisteredAtMs: number,
): void {
  storage.tx(() =>
    endBindings(
      storage,
      "kind = 'apns' AND generation = ? AND updated_at_ms <= ?",
      generation,
      unregisteredAtMs,
    ),
  );
}

/** Ends the caller's phone binding only while it is still `generation`, so a late removal keeps a newer one. */
export function removePushDevice(
  storage: StorageContext,
  input: { userId: string; sessionId: string; generation: number },
): void {
  storage.tx(() =>
    endBindings(
      storage,
      "kind = 'apns' AND session_id = ? AND account_user_id = ? AND generation = ?",
      input.sessionId,
      input.userId,
      input.generation,
    ),
  );
}

export interface PushSessionFence {
  userId: string;
  sessionId: string;
  attemptId: string;
}

/** Refuses the sign-in's registrations until `expiresAtMs`, before its revoke is sent. */
export function fencePushSession(
  storage: StorageContext,
  input: PushSessionFence & { expiresAtMs: number },
): void {
  storage.tx(() =>
    storage.db
      .prepare(`INSERT INTO ${PUSH_REVOKED_SESSIONS} (session_id, attempt_id, account_user_id, expires_at_ms)
        VALUES (?, ?, ?, ?)`)
      .run(input.sessionId, input.attemptId, input.userId, input.expiresAtMs),
  );
}

/**
 * Settles one revoke attempt's fence in one transaction. A revoked sign-in
 * keeps the fence until it would have expired, and every binding it made, a
 * browser's or a phone's, ends. A failed attempt removes only its own fence.
 */
export function settlePushSessionFence(
  storage: StorageContext,
  input: PushSessionFence & { revokedExpiresAtMs: number | null },
): void {
  storage.tx(() => {
    const attempt = [input.sessionId, input.attemptId] as const;
    if (input.revokedExpiresAtMs === null) {
      storage.db
        .prepare(`DELETE FROM ${PUSH_REVOKED_SESSIONS} WHERE session_id = ? AND attempt_id = ?`)
        .run(...attempt);
      return;
    }
    storage.db
      .prepare(`INSERT INTO ${PUSH_REVOKED_SESSIONS} (session_id, attempt_id, account_user_id, expires_at_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id, attempt_id) DO UPDATE SET expires_at_ms = excluded.expires_at_ms`)
      .run(...attempt, input.userId, input.revokedExpiresAtMs);
    endBindings(storage, "session_id = ? AND account_user_id = ?", input.sessionId, input.userId);
  });
}
