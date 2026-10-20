import { betterAuth } from "better-auth";
import {
  normalizeShareDiscussionDisplayName,
  SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT,
} from "@dohc/security-contract/share-discussion";
import { APIError, createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from "better-auth/api";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import type { Pool } from "pg";
import type { SignUpAdmission } from "./signUp";
import type { SendEmail } from "./smtp";

// dohc server auth: Better Auth mounted on the same Postgres the workspace
// backend uses (self-host = one database, no auth vendor). Email/password for
// accounts, the organization plugin for team workspaces, and the OAuth
// device-authorization grant for desktop login (the desktop shows a code, the
// browser approves, and the desktop polls).
//
// This package owns the auth surface. Its only application callbacks deliver
// email and decide whether a new account may exist.

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
  // Closed sign-up. Without it, anyone who reaches the server can create an
  // account. The hook runs on every user insert, so no route can skip it.
  // Admission trusts the typed address, and anyone could have typed the
  // sign-up password, so on a closed server no password works until someone
  // opens the emailed link and chooses one there.
  admitAccount?: (email: string) => Promise<SignUpAdmission>;
  accountDeletion?: {
    preview(user: { id: string; email: string }): Promise<Record<string, unknown>>;
    delete(user: { id: string; email: string }, token: string, confirmPassword: () => Promise<void>): Promise<Record<string, unknown>>;
  };
}

export function createWorkspaceAuth(options: WorkspaceAuthOptions) {
  const passwordAttemptLimit = { window: 60, max: 10 };
  // The browser account pages live at the auth origin, so every emailed link
  // points at a dohc page that then calls /api/auth itself.
  const page = (path: string): string => new URL(path, options.baseURL).toString();
  const send = options.sendEmail ?? unavailableEmail;
  const admitAccount = options.admitAccount;
  const closed = admitAccount !== undefined;
  // A closed server proves the mailbox with a password reset token: opening
  // the link sets the password, verifies the address, and signs out every
  // session, so a password typed by someone else never becomes usable.
  const sendPasswordLink = async (email: string, next: string | null): Promise<void> => {
    await auth.api.requestPasswordReset({ body: { email, ...(next ? { redirectTo: next } : {}) } });
  };
  // Better Auth commits each step of a reset on its own. Signing out first
  // means a failure in between leaves an unverified account nobody is in.
  // Anyone could have typed the sign-up name too, so the same write that
  // verifies the address replaces it with the name sent alongside the token,
  // or none.
  const verifyOnPasswordReset = async (userId: string, name: string): Promise<void> => {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.deleteUserSessions(userId);
    await internalAdapter.updateUser(userId, { name, emailVerified: true });
  };
  // Better Auth drops `name` from the reset body before onPasswordReset runs,
  // so a hook reads it first and hands it over through the request they share.
  const setupNames = new WeakMap<Request, string>();
  const auth = betterAuth({
    ...(admitAccount
      ? {
          hooks: {
            before: createAuthMiddleware(async (ctx) => {
              const body: unknown = ctx.body;
              if (ctx.path !== "/reset-password" || !ctx.request || !body || typeof body !== "object" || !("name" in body)) return;
              setupNames.set(ctx.request, chosenName(body.name));
            }),
          },
          databaseHooks: {
            user: {
              create: {
                before: async (user: { email: string }) => {
                  refuseUnadmitted(await admitAccount(user.email));
                },
              },
            },
          },
        }
      : {}),
    baseURL: options.baseURL,
    secret: options.secret,
    basePath: "/api/auth",
    database: options.pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: closed,
      resetPasswordTokenExpiresIn: EMAIL_LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token, url: originalUrl }) => {
        const next = nextPage(originalUrl);
        // Until the address is verified, nobody has chosen a password yet.
        const settingUp = closed && !user.emailVerified;
        // The flag only makes the page ask for a name; the server applies one
        // only while the account is unverified.
        const url = page(
          `/account/reset-password?token=${encodeURIComponent(token)}${settingUp ? "&setup=1" : ""}${next ? `&next=${encodeURIComponent(next)}` : ""}`,
        );
        await send({
          to: user.email,
          subject: settingUp ? "Choose your dohc password" : "Reset your dohc password",
          text: [
            settingUp
              ? "Choose a password to finish setting up your dohc account:"
              : "Choose a new password for your dohc account:",
            "",
            url,
            "",
            "The link works for one hour.",
            settingUp
              ? "If you did not create a dohc account, ignore this email. Nobody can sign in to it until you choose a password."
              : "If you did not ask for a new password, ignore this email. Your password stays as it is.",
            "",
          ].join("\n"),
        });
      },
      ...(closed
        ? {
            onExistingUserSignUp: async ({ user }: { user: { email: string; emailVerified: boolean } }) => {
              if (!user.emailVerified) await sendPasswordLink(user.email, null);
            },
            onPasswordReset: async ({ user }: { user: { id: string; emailVerified: boolean } }, request?: Request) => {
              if (!user.emailVerified) await verifyOnPasswordReset(user.id, (request && setupNames.get(request)) ?? "");
            },
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: EMAIL_LINK_TTL_SECONDS,
      sendVerificationEmail: async ({ user, token, url: originalUrl }) => {
        const next = nextPage(originalUrl);
        if (closed) return sendPasswordLink(user.email, next);
        const url = page(`/account/verify-email?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next ?? "/account")}`);
        await send({
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
      // A verification link sent while sign-up was open would keep whatever
      // password the account already has.
      ...(closed
        ? {
            beforeEmailVerification: async () => {
              throw new APIError("FORBIDDEN", {
                code: "PASSWORD_LINK_REQUIRED",
                message: "This server now asks you to choose a password from the emailed link.",
              });
            },
          }
        : {}),
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
        "/sign-in/email": passwordAttemptLimit,
        "/account/delete": passwordAttemptLimit,
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/forget-password": { window: 3600, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
        "/reset-password": { window: 3600, max: 10 },
      },
    },
    plugins: [
      ...(options.accountDeletion ? [{
        id: "dohc-account-deletion",
        endpoints: {
          accountDeletionPreview: createAuthEndpoint("/account/deletion-preview", {method: "POST", use: [sessionMiddleware], requireHeaders: true}, async ctx => {
            return ctx.json(await options.accountDeletion!.preview(ctx.context.session.user));
          }),
          deleteServerAccount: createAuthEndpoint("/account/delete", {method: "POST", use: [sessionMiddleware], requireHeaders: true}, async ctx => {
            const body: unknown = ctx.body;
            const token = body && typeof body === "object" && "previewToken" in body ? body.previewToken : undefined;
            if (typeof token !== "string" || token.length > 512) throw new APIError("BAD_REQUEST", {code: "PREVIEW_REQUIRED", message: "Review account deletion before continuing."});
            return ctx.json(await options.accountDeletion!.delete(ctx.context.session.user, token, async () => {
              const password = body && typeof body === "object" && "password" in body ? body.password : undefined;
              if (typeof password !== "string" || password.length === 0) throw new APIError("BAD_REQUEST", {code: "PASSWORD_REQUIRED", message: "Enter your server account password to delete this account."});
              try {
                await ctx.context.password.checkPassword(ctx.context.session.user.id, ctx);
              } catch (error) {
                if (error instanceof APIError && error.body?.code === "INVALID_PASSWORD") throw new APIError("BAD_REQUEST", {code: "INVALID_PASSWORD", message: "The password is incorrect. Enter your server account password."});
                throw error;
              }
            }));
          }),
        },
      }] : []),
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
  return auth;
}

/**
 * Signs out every account whose email is not verified, including desktop
 * sign-ins approved but not yet collected. A closed server runs this before it
 * serves requests: a session from while sign-up was open never proved its
 * mailbox, and closed sign-in refuses to create a new one.
 */
export async function signOutUnverifiedAccounts(pool: Pool): Promise<void> {
  await pool.query(`
    with unverified as (select "id" from "user" where not "emailVerified"),
      signed_out as (delete from "session" where "userId" in (select "id" from unverified))
    delete from "deviceCode" where "userId" in (select "id" from unverified)`);
}

/** The device sign-in an emailed link should continue, if Better Auth's link carries one. */
function nextPage(betterAuthUrl: string): string | null {
  const callback = new URL(betterAuthUrl).searchParams.get("callbackURL");
  return callback && /^\/device\?user_code=[A-Za-z0-9%_-]+$/.test(callback) ? callback : null;
}

/** The name other people see, normalized as the relay shows it. */
function chosenName(value: unknown): string {
  const invalid = (message: string) => new APIError("BAD_REQUEST", { code: "INVALID_NAME", message });
  const name = normalizeShareDiscussionDisplayName(value);
  if (!name.ok) {
    throw invalid(name.reason === "too-long" ? `Enter a name of ${SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT} characters or fewer.` : "Enter your name.");
  }
  // The relay hides any name that looks like an address.
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(name.value)) {
    throw invalid("Enter a name instead of an email address. Other people see it beside your work.");
  }
  return name.value;
}

function refuseUnadmitted(admission: SignUpAdmission): void {
  if (admission === "refused") {
    throw new APIError("FORBIDDEN", {
      code: "SIGN_UP_CLOSED",
      message:
        "This server creates accounts only for approved or invited email addresses. Ask the server owner to approve this address, or ask someone here to share work with it.",
    });
  }
  if (admission === "unavailable") {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "SIGN_UP_CHECK_UNAVAILABLE",
      message: "dohc could not check whether this address is invited. Try again in a minute.",
    });
  }
}

async function unavailableEmail(_message: Parameters<SendEmail>[0]): Promise<void> {
  throw new Error("Account email delivery is not configured.");
}

export type WorkspaceAuth = ReturnType<typeof createWorkspaceAuth>;
