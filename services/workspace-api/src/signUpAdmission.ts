import {
  normalizeEmail,
  SIGN_UP_INVITE_KEY_HEADER,
  SIGN_UP_INVITE_PATH,
  type AdmitAccount,
} from "@dohc/workspace-auth/signUp";
import type { ClosedSignUp } from "./config";

const INVITE_CHECK_TIMEOUT_MS = 5000;

// A listed address never waits on the relay. Any other address needs the
// relay to confirm a pending invite, or a workspace invite link the sign-up
// presented; a relay that cannot answer refuses nothing for good, so the
// person can try again.
export function createSignUpAdmission(
  options: ClosedSignUp & { key: string; fetch?: typeof fetch },
): AdmitAccount {
  const send = options.fetch ?? fetch;
  const url = new URL(SIGN_UP_INVITE_PATH, options.relayUrl);
  return async (email, inviteToken) => {
    const address = normalizeEmail(email);
    if (options.emails.has(address)) return "admitted";
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGN_UP_INVITE_KEY_HEADER]: options.key },
        body: JSON.stringify(inviteToken === null ? { email: address } : { email: address, inviteToken }),
        signal: AbortSignal.timeout(INVITE_CHECK_TIMEOUT_MS),
      });
      const body = response.ok ? ((await response.json()) as { invited?: unknown }) : null;
      if (body?.invited === true) return "admitted";
      if (body?.invited === false) return "refused";
      console.error(`[workspace-api] The relay answered the sign-up invite check with ${response.status}.`);
    } catch {
      console.error("[workspace-api] The relay did not answer the sign-up invite check.");
    }
    return "unavailable";
  };
}
