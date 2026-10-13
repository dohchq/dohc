import { createHmac, timingSafeEqual } from "node:crypto";

export { ACCOUNT_DELETION_PATH, ACCOUNT_DELETION_KEY_HEADER, accountDeletionKey } from "@dohc/security-contract/account-deletion";
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
export function accountDeletionPreviewKey(secret: string): string {
  return createHmac("sha256", secret).update("dohc account deletion preview v1").digest("base64url");
}
export function accountDeletionFenceKey(secret: string): string {
  return createHmac("sha256", secret).update("dohc account deletion fence v1").digest("base64url");
}
export function accountDeletionIdentity(key: string, userId: string): string {
  return createHmac("sha256", key).update(JSON.stringify(["account-fence", userId])).digest("hex");
}
export function deletionPreviewDigest(key: string, userId: string, preview: AccountDeletionPreview): string {
  return createHmac("sha256", key).update(JSON.stringify(["preview", userId, preview.email, preview.serverOrigin, [...preview.workspaceIds].sort(), preview.workspaceCount, preview.ownedShareCount, preview.heldGrantCount])).digest("base64url");
}
export function mintDeletionPreviewToken(key: string, userId: string, preview: AccountDeletionPreview, nowMs = Date.now()): string {
  const expiry = nowMs + ACCOUNT_DELETION_PREVIEW_TTL_MS;
  const digest = deletionPreviewDigest(key, userId, preview);
  const signature = createHmac("sha256", key).update(JSON.stringify(["preview-token", userId, expiry, digest])).digest("base64url");
  return [expiry, digest, signature].join(".");
}
export function verifiesDeletionPreviewToken(key: string, token: string, userId: string, nowMs = Date.now()): boolean {
  const [expiry, digest, signature, extra] = token.split(".");
  const expiresAtMs = Number(expiry);
  if (extra !== undefined || !digest || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + ACCOUNT_DELETION_PREVIEW_TTL_MS) return false;
  const expected = createHmac("sha256", key).update(JSON.stringify(["preview-token", userId, expiresAtMs, digest])).digest("base64url");
  const given = Buffer.from(signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, Buffer.from(expected));
}
export function matchesDeletionPreviewToken(key: string, token: string, userId: string, preview: AccountDeletionPreview, nowMs = Date.now()): boolean {
  if (!verifiesDeletionPreviewToken(key, token, userId, nowMs)) return false;
  const given = Buffer.from(token.split(".")[1]);
  const expected = Buffer.from(deletionPreviewDigest(key, userId, preview));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
