import type { Actor } from "@dohc/workspace-contracts";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import type { Pool } from "pg";

// dohc Cloud auth: Better Auth mounted on the SAME Postgres the workspace
// backend uses (self-host = one database, no auth vendor). Email/password for
// accounts, the organization plugin for team workspaces, and the OAuth
// device-authorization grant for desktop login (the desktop shows a code, the
// browser approves, and the desktop polls).
//
// This package owns only the auth surface and has no application callbacks.
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
}

export function createWorkspaceAuth(options: WorkspaceAuthOptions) {
  const sendEmail =
    options.sendEmail ??
    (async (to: string, subject: string, body: string) => {
      console.log(`[workspace-auth] email to ${to}: ${subject}\n${body}`);
    });
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    basePath: "/api/auth",
    database: options.pool,
    emailAndPassword: { enabled: true },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(user.email, "Verify your dohc email", url);
      },
    },
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
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
