import { normalizeEmail, presentsSignUpInviteKey, SIGN_UP_INVITE_KEY_HEADER } from "@dohc/workspace-auth/signUp";
import { guardRelayResponses } from "./relayResponseStanding";
import type { SyncRelayStorage } from "./storage";
import { hashWorkspaceInviteToken, isWorkspaceInviteToken } from "./workspaceMemberRoutes";

const MAX_EMAIL_CHARS = 320;

// workspace-api asks whether an address outside its approved list holds a
// pending invite, or whether the sign-up presented a workspace invite link
// that is turned on. A caller without the key gets the same 404 as an unknown
// route. Storage the relay has retired answers 503, so no account rests on
// its reads. `inviteLinkKey` is null when invite-link sign-up is turned off.
export function createSignUpInviteRoute(options: {
  storage: Pick<SyncRelayStorage, "hasPendingInvite" | "inviteLinkAdmitsSignUp" | "captureStanding" | "unavailable">;
  key: string;
  inviteLinkKey: string | null;
}) {
  return guardRelayResponses(options.storage, async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || !presentsSignUpInviteKey(request.headers.get(SIGN_UP_INVITE_KEY_HEADER), options.key)) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const body: unknown = await request.json().catch(() => null);
    const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const email = fields.email;
    if (typeof email !== "string" || email.length > MAX_EMAIL_CHARS || !normalizeEmail(email)) {
      return Response.json({ ok: false, error: "email required" }, { status: 400 });
    }
    const inviteToken = fields.inviteToken;
    if (inviteToken !== undefined && typeof inviteToken !== "string") {
      return Response.json({ ok: false, error: "invite token must be a string" }, { status: 400 });
    }
    const linkAdmits = (token: string) =>
      options.inviteLinkKey !== null &&
      isWorkspaceInviteToken(token) &&
      options.storage.inviteLinkAdmitsSignUp(hashWorkspaceInviteToken(token, options.inviteLinkKey));
    return Response.json(
      { invited: options.storage.hasPendingInvite(normalizeEmail(email)) || (inviteToken !== undefined && linkAdmits(inviteToken)) },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
