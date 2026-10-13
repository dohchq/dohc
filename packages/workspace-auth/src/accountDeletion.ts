import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export const ACCOUNT_DELETION_ADMISSION_LOCK = 1888001;
export const ACCOUNT_DELETION_PATH = "/internal/account-deletion";
export const ACCOUNT_DELETION_KEY_HEADER = "x-dohc-account-deletion-key";
export const ACCOUNT_DELETION_PREVIEW_TTL_MS = 5 * 60 * 1000;

export interface AccountDeletionScope {
  workspaceIds: string[];
  workspaceCount: number;
  ownedShareCount: number;
  heldGrantCount: number;
  storedBytes: number;
}
export interface AccountDeletionPreview extends AccountDeletionScope {
  email: string;
  serverOrigin: string;
}
export function accountDeletionKey(secret: string): string {
  return createHmac("sha256", secret).update("dohc account deletion internal v1").digest("base64url");
}
export function accountDeletionIdentity(key: string, userId: string): string {
  return createHmac("sha256", key).update(JSON.stringify(["account-fence", userId])).digest("hex");
}
export function deletionPreviewDigest(key: string, userId: string, preview: AccountDeletionPreview): string {
  return createHmac("sha256", key).update(JSON.stringify(["preview", userId, preview])).digest("base64url");
}
export function mintDeletionPreviewToken(key: string, userId: string, preview: AccountDeletionPreview, nowMs = Date.now()): string {
  const expiry = nowMs + ACCOUNT_DELETION_PREVIEW_TTL_MS;
  const digest = deletionPreviewDigest(key, userId, preview);
  const signature = createHmac("sha256", key).update(JSON.stringify(["preview-token", expiry, digest])).digest("base64url");
  return [expiry, digest, signature].join(".");
}
export function matchesDeletionPreviewToken(key: string, token: string, userId: string, preview: AccountDeletionPreview, nowMs = Date.now()): boolean {
  const [expiry, digest, signature, extra] = token.split(".");
  const expiresAtMs = Number(expiry);
  if (extra !== undefined || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + ACCOUNT_DELETION_PREVIEW_TTL_MS) return false;
  const expected = createHmac("sha256", key).update(JSON.stringify(["preview-token", expiresAtMs, deletionPreviewDigest(key, userId, preview)])).digest("base64url");
  const given = Buffer.from(signature ?? "");
  return digest === deletionPreviewDigest(key, userId, preview) && given.length === expected.length && timingSafeEqual(given, Buffer.from(expected));
}
export async function accountIsDeleting(pool: Pool, userId: string): Promise<boolean> {
  return (await pool.query('SELECT 1 FROM account_deletion_jobs WHERE user_id = $1', [userId])).rows.length > 0;
}
