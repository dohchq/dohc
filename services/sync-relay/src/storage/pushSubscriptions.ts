import type { StorageContext } from "./context";
import { notFound } from "../errors";
import { accountIsFenced } from "./accountDeletion";
import { SyncRelayConflictError } from "./errors";
import { PUSH_GENERATIONS, PUSH_SUBSCRIPTIONS } from "./pushSchema";

// Installations with alerts on, per account. Bounds what one account can store.
export const PUSH_INSTALLATIONS_PER_ACCOUNT = 20;

export interface PushSubscriptionRow {
  installationId: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
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
  accountName?: string;
}

function rowFrom(row: Record<string, unknown>): PushSubscriptionRow {
  return {
    installationId: String(row.installation_id), userId: String(row.account_user_id), sessionId: String(row.session_id),
    endpoint: String(row.endpoint), vapidKeyId: String(row.vapid_key_id),
    p256dh: String(row.p256dh), auth: String(row.auth),
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
 * again with the same binding changes nothing. Another installation's
 * endpoint is never taken over. Another account's installation moves to the
 * caller only when the caller presents its endpoint too: the installation id
 * and the endpoint together prove the request comes from that browser. An
 * expired binding holds neither.
 */
export function bindPushSubscription(storage: StorageContext, input: BindPushSubscriptionInput): PushSubscriptionRow {
  return storage.tx(() => {
    const db = storage.db;
    // Deletion fences the account in its own transaction; a bind that waited on it must not land after.
    if (accountIsFenced(storage, input.userId)) throw notFound();
    db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE expires_at_ms <= ? AND installation_id = ?`).run(input.nowMs, input.installationId);
    db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE expires_at_ms <= ? AND endpoint = ?`).run(input.nowMs, input.endpoint);
    db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE expires_at_ms <= ? AND account_user_id = ?`).run(input.nowMs, input.userId);
    const existing = db.prepare(`SELECT ${COLUMNS} FROM ${PUSH_SUBSCRIPTIONS} WHERE installation_id = ?`).get(input.installationId);
    const owner = db.prepare(`SELECT installation_id FROM ${PUSH_SUBSCRIPTIONS} WHERE endpoint = ?`).get(input.endpoint);
    if (owner && owner.installation_id !== input.installationId) {
      throw new SyncRelayConflictError("this push endpoint belongs to another installation");
    }
    const changesAccount = existing !== undefined && existing.account_user_id !== input.userId;
    if (changesAccount && existing.endpoint !== input.endpoint) {
      throw new SyncRelayConflictError("this browser's alerts belong to another account");
    }
    const expiresAtMs = Math.min(input.sessionExpiresAtMs, input.browserExpiresAtMs ?? Number.MAX_SAFE_INTEGER);
    const setAccountName = () => db.prepare(`INSERT INTO sync_relay_push_installation_names (installation_id, account_name)
      VALUES (?, ?) ON CONFLICT(installation_id) DO UPDATE SET account_name = excluded.account_name`)
      .run(input.installationId, (input.accountName ?? "").slice(0, 1024));
    if (existing && !changesAccount && existing.session_id === input.sessionId && existing.endpoint === input.endpoint &&
        existing.p256dh === input.p256dh && existing.auth === input.auth && existing.vapid_key_id === input.vapidKeyId) {
      if (Number(existing.expires_at_ms) !== expiresAtMs) {
        db.prepare(`UPDATE ${PUSH_SUBSCRIPTIONS} SET expires_at_ms = ?, updated_at_ms = max(updated_at_ms, ?) WHERE installation_id = ?`)
          .run(expiresAtMs, input.nowMs, input.installationId);
      }
      setAccountName();
      return {...rowFrom(existing), expiresAtMs};
    }
    if (!existing || changesAccount) {
      const held = Number(db.prepare(`SELECT count(*) AS n FROM ${PUSH_SUBSCRIPTIONS} WHERE account_user_id = ?`).get(input.userId)!.n);
      if (held >= PUSH_INSTALLATIONS_PER_ACCOUNT) {
        throw new SyncRelayConflictError("too many devices have alerts on for this account");
      }
    }
    if (existing) {
      // A new sign-in, account, endpoint, or key is a new binding with a new generation.
      const generation = nextGeneration(storage);
      db.prepare(`UPDATE ${PUSH_SUBSCRIPTIONS} SET account_user_id = ?, session_id = ?, endpoint = ?, p256dh = ?, auth = ?,
        vapid_key_id = ?, generation = ?, updated_at_ms = max(updated_at_ms, ?), expires_at_ms = ? WHERE installation_id = ?`)
        .run(input.userId, input.sessionId, input.endpoint, input.p256dh, input.auth, input.vapidKeyId, generation,
          input.nowMs, expiresAtMs, input.installationId);
      setAccountName();
      return readPushSubscription(storage, input.installationId)!;
    }
    const generation = nextGeneration(storage);
    db.prepare(`INSERT INTO ${PUSH_SUBSCRIPTIONS} (installation_id, account_user_id, session_id, endpoint, p256dh, auth,
      vapid_key_id, generation, created_at_ms, updated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.installationId, input.userId, input.sessionId, input.endpoint, input.p256dh, input.auth,
        input.vapidKeyId, generation, input.nowMs, input.nowMs, expiresAtMs);
    setAccountName();
    return readPushSubscription(storage, input.installationId)!;
  });
}

/** Ends this installation's subscription when it is the caller's account's. Ending one that is gone succeeds. */
export function removePushSubscription(storage: StorageContext, input: {installationId: string; userId: string}): void {
  storage.tx(() => storage.db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS} WHERE installation_id = ? AND account_user_id = ?`)
    .run(input.installationId, input.userId));
}

/** A terminal provider response can remove only the binding that was sent. */
export function removePushSubscriptionGeneration(storage: StorageContext, input: {
  installationId: string;
  userId: string;
  generation: number;
}): void {
  storage.tx(() => storage.db.prepare(`DELETE FROM ${PUSH_SUBSCRIPTIONS}
    WHERE installation_id = ? AND account_user_id = ? AND generation = ?`)
    .run(input.installationId, input.userId, input.generation));
}
