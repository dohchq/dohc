import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import type { Pool } from "pg";
import type { SendEmail } from "./smtp";

// dohc server auth: Better Auth mounted on the same Postgres the workspace
// backend uses (self-host = one database, no auth vendor). Email/password for
// accounts, the organization plugin for team workspaces, and the OAuth
// device-authorization grant for desktop login (the desktop shows a code, the
// browser approves, and the desktop polls).
//
// This package owns only the auth surface and has no application callbacks.

/** Verification and reset links expire one hour after dohc sends them. */
export const EMAIL_LINK_TTL_SECONDS = 3600;

/**
 * The only address header this auth surface trusts. The host sets it from the
 * connecting socket and strips every client-supplied forwarding header first.
 */
export const CLIENT_IP_HEADER = "x-dohc-auth-client-ip";

interface WorkspaceAuthOptions {
  pool: Pool;
  baseURL: string;
  secret: string;
  // share-web forwards its validated viewer Origin when proxying browser auth.
  trustedOrigins?: string[];
  // Delivers account email. A caller with no
  // transport must refuse the request that would send mail (workspace-api
  // answers 503) rather than report a send that never happened.
  sendEmail?: SendEmail;
}

export function createWorkspaceAuth(options: WorkspaceAuthOptions) {
  // The browser account pages live at the auth origin, so every emailed link
  // points at a dohc page that then calls /api/auth itself.
  const page = (path: string): string => new URL(path, options.baseURL).toString();
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    basePath: "/api/auth",
    database: options.pool,
    emailAndPassword: {
      enabled: true,
      resetPasswordTokenExpiresIn: EMAIL_LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        const url = page(`/account/reset-password?token=${encodeURIComponent(token)}`);
        await (options.sendEmail ?? unavailableEmail)({
          to: user.email,
          subject: "Reset your dohc password",
          text: [
            "Choose a new password for your dohc account:",
            "",
            url,
            "",
            "The link works for one hour.",
            "If you did not ask for a new password, ignore this email. Your password stays as it is.",
            "",
          ].join("\n"),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: EMAIL_LINK_TTL_SECONDS,
      sendVerificationEmail: async ({ user, token, url: originalUrl }) => {
        const callback = new URL(originalUrl).searchParams.get("callbackURL");
        const next = callback && /^\/device\?user_code=[A-Za-z0-9%_-]+$/.test(callback) ? callback : "/account";
        const url = page(`/account/verify-email?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`);
        await (options.sendEmail ?? unavailableEmail)({
          to: user.email,
          subject: "Verify your dohc email",
          text: [
            "Verify this address to finish setting up your dohc account:",
            "",
            url,
            "",
            "The link works for one hour.",
            "Until you verify it, other people cannot share work with you at this address.",
            "",
          ].join("\n"),
        });
      },
    },
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
    // The host derives the client address from the socket and its own trusted
    // proxy list, then hands it over in this one header. Reading any other
    // forwarding header would let a caller pick its own rate-limit bucket.
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    // Guessing a password, farming accounts, and pumping out email are the
    // three ways a public sign-in page gets abused. The general budget stays
    // wide enough for a desktop polling the device endpoint every few seconds.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 600,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/forget-password": { window: 3600, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
        "/reset-password": { window: 3600, max: 10 },
      },
    },
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

async function unavailableEmail(_message: Parameters<SendEmail>[0]): Promise<void> {
  throw new Error("Account email delivery is not configured.");
}

export type WorkspaceAuth = ReturnType<typeof createWorkspaceAuth>;
