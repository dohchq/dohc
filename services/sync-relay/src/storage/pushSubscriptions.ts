import type { StorageContext } from "./context";
import { SyncRelayConflictError } from "./errors";
import { PUSH_GENERATIONS, PUSH_SUBSCRIPTIONS } from "./pushSchema";

// Installations with alerts on, per account. Bounds what one account can store.
export const PUSH_INSTALLATIONS_PER_ACCOUNT = 20;

export interface PushSubscriptionRow {
  installationId: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  vapidKeyId: string;
  generation: number;
  expiresAtMs: number;
}

export interface BindPushSubscriptionInput {
  installationId: string;
  userId: string;
  sessionId: string;
  sessionExpiresAtMs: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidKeyId: string;
  browserExpiresAtMs: number | null;
  nowMs: number;
}

function rowFrom(row: Record<string, unknown>): PushSubscriptionRow {
  return {
    installationId: String(row.installation_id), userId: String(row.account_user_id), sessionId: String(row.session_id),
    endpoint: String(row.endpoint), vapidKeyId: String(row.vapid_key_id),
    generation: Number(row.generation), expiresAtMs: Number(row.expires_at_ms),
  };
}

const COLUMNS = "installation_id, account_user_id, session_id, endpoint, p256dh, auth, vapid_key_id, generation, expires_at_ms";

export function readPushSubscription(storage: StorageContext, installationId: string): PushSubscriptionRow | null {
  const row = storage.db.prepare(`SELECT ${COLUMNS} FROM ${PUSH_SUBSCRIPTIONS} WHERE installation_id = ?`).get(installationId);
  return row ? rowFrom(row) : null;
}

function nextGeneration(storage: StorageContext): number {
  const row = storage.db.prepare(`UPDATE ${PUSH_GENERATIONS} SET last_generation = last_generation + 1
    WHERE singleton = 1 RETURNING last_generation`).get();
  return Number(row!.last_generation);
}

/**
 * Binds this installation's subscription to the caller's sign-in. Asking
 * again with the same binding changes nothing. Another account's
 * installation and another installation's endpoint are never taken over;
 * an expired binding no longer holds either.
 */
export function bindPushSubscription(storage: StorageContext, input: BindPushSubscriptionInput): PushSubscriptionRow {
  return storage.tx(() => {
    const db = storage.db;
    db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE expires_at_ms <= ? AND installation_id = ?`).run(input.nowMs, input.installationId);
    db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE expires_at_ms <= ? AND endpoint = ?`).run(input.nowMs, input.endpoint);
    db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE expires_at_ms <= ? AND account_user_id = ?`).run(input.nowMs, input.userId);
    const existing = db.prepare(`SELECT ${COLUMNS} FROM ${PUSH_SUBSCRIPTIONS} WHERE installation_id = ?`).get(input.installationId);
    if (existing && existing.account_user_id !== input.userId) {
      throw new SyncRelayConflictError("this browser's alerts belong to another account");
    }
    const owner = db.prepare(`SELECT installation_id FROM ${PUSH_SUBSCRIPTIONS} WHERE endpoint = ?`).get(input.endpoint);
    if (owner && owner.installation_id !== input.installationId) {
      throw new SyncRelayConflictError("this push endpoint belongs to another installation");
    }
    const expiresAtMs = Math.min(input.sessionExpiresAtMs, input.browserExpiresAtMs ?? Number.MAX_SAFE_INTEGER);
    if (existing) {
      const same = existing.session_id === input.sessionId && existing.endpoint === input.endpoint &&
        existing.p256dh === input.p256dh && existing.auth === input.auth && existing.vapid_key_id === input.vapidKeyId;
      if (same) {
        if (Number(existing.expires_at_ms) !== expiresAtMs) {
          db.prepare(`UPDATE ${PUSH_SUBSCRIPTIONS} SET expires_at_ms = ?, updated_at_ms = max(updated_at_ms, ?) WHERE installation_id = ?`)
            .run(expiresAtMs, input.nowMs, input.installationId);
        }
        return {...rowFrom(existing), expiresAtMs};
      }
      const generation = nextGeneration(storage);
      db.prepare(`UPDATE ${PUSH_SUBSCRIPTIONS} SET session_id = ?, endpoint = ?, p256dh = ?, auth = ?, vapid_key_id = ?,
        generation = ?, updated_at_ms = max(updated_at_ms, ?), expires_at_ms = ? WHERE installation_id = ?`)
        .run(input.sessionId, input.endpoint, input.p256dh, input.auth, input.vapidKeyId, generation, input.nowMs, expiresAtMs, input.installationId);
      return readPushSubscription(storage, input.installationId)!;
    }
    const held = Number(db.prepare(`SELECT count(*) AS n FROM ${PUSH_SUBSCRIPTIONS} WHERE account_user_id = ?`).get(input.userId)!.n);
    if (held >= PUSH_INSTALLATIONS_PER_ACCOUNT) {
      throw new SyncRelayConflictError("too many devices have alerts on for this account");
    }
    const generation = nextGeneration(storage);
    db.prepare(`INSERT INTO ${PUSH_SUBSCRIPTIONS} (installation_id, account_user_id, session_id, endpoint, p256dh, auth,
      vapid_key_id, generation, created_at_ms, updated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.installationId, input.userId, input.sessionId, input.endpoint, input.p256dh, input.auth,
        input.vapidKeyId, generation, input.nowMs, input.nowMs, expiresAtMs);
    return readPushSubscription(storage, input.installationId)!;
  });
}

/** Ends this installation's subscription when it is the caller's account's. Ending one that is gone succeeds. */
export function removePushSubscription(storage: StorageContext, input: {installationId: string; userId: string}): void {
  storage.tx(() => storage.db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE installation_id = ? AND account_user_id = ?`)
    .run(input.installationId, input.userId));
}
