import { createHmac, timingSafeEqual } from "node:crypto";

// Closed sign-up: a server with an approved list admits a new account only for
// a listed address or one with a pending invite. Pending invites live in the
// relay's database, so workspace-api asks the relay on this internal route.
// The gateway publishes only /sync/* from the relay, and the route answers
// only a caller holding the key both services derive from BETTER_AUTH_SECRET.

export const SIGN_UP_INVITE_PATH = "/internal/sign-up-invite";
export const SIGN_UP_INVITE_KEY_HEADER = "x-dohc-sign-up-key";

/** What the server decided about creating an account for one address. */
export type SignUpAdmission = "admitted" | "refused" | "unavailable";

/** The one form every approved-list and invite comparison uses. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function signUpInviteKey(secret: string): string {
  return createHmac("sha256", secret).update("dohc sign-up invite check v1").digest("base64url");
}

export function presentsSignUpInviteKey(presented: string | null, key: string): boolean {
  if (presented === null) return false;
  const given = Buffer.from(presented);
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
