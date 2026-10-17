import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCOUNT_DELETION_PATH = "/internal/account-deletion";
export const ACCOUNT_DELETION_KEY_HEADER = "x-dohc-account-deletion-key";
export function accountDeletionKey(secret: string): string {
  return createHmac("sha256", secret).update("dohc account deletion bearer v1").digest("base64url");
}
export function presentsAccountDeletionKey(presented: string | null, expected: string): boolean {
  const given = Buffer.from(presented ?? ""), key = Buffer.from(expected);
  return given.length === key.length && timingSafeEqual(given, key);
}
