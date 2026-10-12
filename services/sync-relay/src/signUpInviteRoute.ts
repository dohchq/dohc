import { normalizeEmail, presentsSignUpInviteKey, SIGN_UP_INVITE_KEY_HEADER } from "@dohc/workspace-auth/signUp";
import { guardRelayResponses } from "./relayResponseStanding";
import type { SyncRelayStorage } from "./storage";

const MAX_EMAIL_CHARS = 320;

// workspace-api asks whether an address outside its approved list holds a
// pending invite. A caller without the key gets the same 404 as an unknown route.
// Storage the relay has retired answers 503, so no account rests on its reads.
export function createSignUpInviteRoute(options: {
  storage: Pick<SyncRelayStorage, "hasPendingInvite" | "captureStanding" | "unavailable">;
  key: string;
}) {
  return guardRelayResponses(options.storage, async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || !presentsSignUpInviteKey(request.headers.get(SIGN_UP_INVITE_KEY_HEADER), options.key)) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const body: unknown = await request.json().catch(() => null);
    const email = body !== null && typeof body === "object" && "email" in body ? body.email : undefined;
    if (typeof email !== "string" || email.length > MAX_EMAIL_CHARS || !normalizeEmail(email)) {
      return Response.json({ ok: false, error: "email required" }, { status: 400 });
    }
    return Response.json(
      { invited: options.storage.hasPendingInvite(normalizeEmail(email)) },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
