import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCOUNT_DELETION_PATH = "/internal/account-deletion";
export const ACCOUNT_DELETION_KEY_HEADER = "x-dohc-account-deletion-key";
export function accountDeletionKey(secret: string): string {
  return createHmac("sha256", secret).update("dohc account deletion bearer v1").digest("base64url");
}
/** The relay tells share-web to end phone app sessions here, with a key derived from the exchange key. */
export const APP_LAUNCH_PURGE_PATH = "/internal/app-launch-purge";
export const APP_LAUNCH_PURGE_KEY_HEADER = "x-dohc-app-launch-purge-key";
/** One purge names at most this many launch IDs' sha256 hashes, as `{ launchHashes }`. */
export const APP_LAUNCH_PURGE_BATCH = 64;
export function appLaunchPurgeKey(exchangeKey: string): string {
  return createHmac("sha256", exchangeKey).update("dohc app launch purge v1").digest("base64url");
}
export function presentsAccountDeletionKey(presented: string | null, expected: string): boolean {
  const given = Buffer.from(presented ?? ""),
    key = Buffer.from(expected);
  return given.length === key.length && timingSafeEqual(given, key);
}
