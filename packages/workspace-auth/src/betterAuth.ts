import type { Actor } from "@dohc/workspace-contracts";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import type { Pool } from "pg";

// dohc Cloud auth: Better Auth mounted on the SAME Postgres the workspace
// backend uses (self-host = one database, no auth vendor). Email/password for
// accounts, the organization plugin for team workspaces, and the OAuth
// device-authorization grant for desktop login (the desktop shows a code, the
// browser approves, the desktop polls). WorkOS remains the deferred
// enterprise-SSO path BEHIND this surface (D-01).
//
// This package owns ONLY the auth surface. It has no edge into workspace-api's
// routes: the post-verification workspace-invitation claim is injected by the
// caller via `onEmailVerified` so nothing here imports application code.
export interface WorkspaceAuthOptions {
  pool: Pool;
  baseURL: string;
  secret: string;
  // The web client's origin (DOHC_WEB_ORIGIN) when browser cookie sessions
  // are enabled; unset means same-origin/Bearer only (desktop flow).
  // Session cookies keep Better Auth's SameSite=Lax default, so this origin
  // must be SAME-SITE with the API (shared registrable domain, or a reverse
  // proxy making them same-origin). A genuinely cross-site split — including
  // localhost web vs 127.0.0.1 API in dev — silently drops the cookie on
  // credentialed XHR and every authed call 401s.
  trustedOrigins?: string[];
  // Dev/self-host email delivery is console logging; production providers
  // plug in here later without touching callers.
  sendEmail?: (to: string, subject: string, body: string) => Promise<void>;
  // Invoked from the emailVerification.afterEmailVerification hook once a
  // signer has PROVEN control of the address. The relay wires today's
  // behavior by passing claimWorkspaceInvitations; unset means no claim step.
  // A rejected callback logs but never fails the auth flow (see below).
  onEmailVerified?: (user: { id: string; email: string }) => Promise<void>;
}

export function createWorkspaceAuth(options: WorkspaceAuthOptions) {
  const sendEmail =
    options.sendEmail ??
    (async (to: string, subject: string, body: string) => {
      console.log(`[workspace-auth] email to ${to}: ${subject}\n${body}`);
    });
  // A failed post-verification hook logs but never fails the auth flow itself.
  const onEmailVerified = async (user: { id: string; email: string }) => {
    if (!options.onEmailVerified) return;
    try {
      await options.onEmailVerified(user);
    } catch (error) {
      console.error("[workspace-auth] afterEmailVerification hook failed:", error);
    }
  };
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    basePath: "/api/auth",
    database: options.pool,
    emailAndPassword: { enabled: true },
    // Claim-on-VERIFICATION (security review P2): pending workspace
    // invitations become workspace_members rows only once the signer has
    // proven control of the invited address — claiming in user.create.after
    // let anyone who signed up with an invited-but-unregistered email hijack
    // the membership without ever receiving mail at that address.
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(user.email, "Verify your dohc email", url);
      },
      afterEmailVerification: async (user) => {
        await onEmailVerified(user);
      },
    },
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
    // Deliberately NO user.create.after auto-claim hook (security review P3):
    // none of the enabled providers (email/password, bearer, device,
    // organization) creates born-verified users, so a create-time claim is
    // unreachable today and a hazard tomorrow — a future provider that mints
    // emailVerified=true users (social login, magic link, email OTP, admin
    // import) would silently claim every pending invitation for that address.
    // Re-add ONLY behind an explicit allowlist of providers whose
    // verified-email semantics have been reviewed, with provider-specific
    // tests; until then afterEmailVerification above is the single claim path.
    plugins: [
      // The desktop authenticates API calls with `Authorization: Bearer
      // <session token>` (the device flow's access_token IS a session token).
      bearer(),
      organization(),
      deviceAuthorization({
        // Desktop polls every few seconds; keep the code lifetime short.
        expiresIn: "10m",
        interval: "3s",
        // better-auth 1.6.16 quirk: the options validator marks `schema` as
        // required (z.custom without .optional()); an empty object means
        // "no table overrides".
        schema: {},
      }),
    ],
  });
}

export type WorkspaceAuth = ReturnType<typeof createWorkspaceAuth>;

// Maps a validated Better Auth session to the Actor shape every downstream
// authz check (assertWorkspaceMember etc.) already consumes — identity is
// derived SERVER-side from the session token, never from client-supplied ids.
export function actorFromSession(
  session: { user: { id: string } },
  workspaceId: string,
): Actor {
  return { userId: session.user.id, workspaceId };
}
