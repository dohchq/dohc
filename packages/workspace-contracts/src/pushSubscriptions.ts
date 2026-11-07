// Web push subscriptions for the browser chat page. A browser installation
// keeps one subscription per server, bound to the signed-in account and the
// browser session that turned it on.

export const PUSH_STATUS_PATH = "/push/status";
export const PUSH_SUBSCRIBE_PATH = "/push/subscribe";
const PUSH_UNSUBSCRIBE_PATH = "/push/unsubscribe";
export const PUSH_PATHS = [PUSH_STATUS_PATH, PUSH_SUBSCRIBE_PATH, PUSH_UNSUBSCRIBE_PATH] as const;

export const PUSH_MAX_REQUEST_BYTES = 4096;
export const PUSH_MAX_RESPONSE_BYTES = 1024;
const PUSH_ENDPOINT_MAX_CHARS = 2048;

const base64url = (length: number) => new RegExp(`^[A-Za-z0-9_-]{${length}}$`, "u");
// 16 random bytes the browser mints once and keeps.
const INSTALLATION_ID = base64url(22);
// An uncompressed P-256 point: 65 bytes.
const P256_POINT = base64url(87);
// The 16-byte authentication secret.
const AUTH_SECRET = base64url(22);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function isPushInstallationId(value: unknown): value is string {
  return typeof value === "string" && INSTALLATION_ID.test(value);
}

export function isPushKeyId(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function isPushP256Point(value: unknown): value is string {
  return typeof value === "string" && P256_POINT.test(value) && value.startsWith("B");
}

export function isPushAuthSecret(value: unknown): value is string {
  return typeof value === "string" && AUTH_SECRET.test(value);
}

/** An HTTPS endpoint in its canonical spelling, without credentials or fragment. */
export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > PUSH_ENDPOINT_MAX_CHARS) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.href === value;
  } catch {
    return false;
  }
}

/**
 * What the server holds for this installation. `fingerprint` is the
 * lowercase hex SHA-256 of the endpoint's UTF-8 bytes, so the page can match
 * it against its own browser subscription without the server sending one back.
 */
export type PushStatus =
  | { ok: true; available: false }
  | {
      ok: true;
      available: true;
      vapidPublicKey: string;
      vapidKeyId: string;
      enabled: false;
      generation: null;
      fingerprint: null;
    }
  | {
      ok: true;
      available: true;
      vapidPublicKey: string;
      vapidKeyId: string;
      enabled: true;
      generation: number;
      fingerprint: string;
    };

const STATUS_KEYS = "available,enabled,fingerprint,generation,ok,vapidKeyId,vapidPublicKey";

/** A status exactly as the server sends it; anything else is not one. */
export function isPushStatus(value: unknown): value is PushStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  const keys = Object.keys(status).sort().join();
  if (status.ok !== true) return false;
  if (status.available === false) return keys === "available,ok";
  if (status.available !== true || keys !== STATUS_KEYS) return false;
  if (!isPushP256Point(status.vapidPublicKey) || !isPushKeyId(status.vapidKeyId)) return false;
  if (status.enabled === false) return status.generation === null && status.fingerprint === null;
  return status.enabled === true && isPushKeyId(status.fingerprint) &&
    Number.isSafeInteger(status.generation) && Number(status.generation) > 0;
}
