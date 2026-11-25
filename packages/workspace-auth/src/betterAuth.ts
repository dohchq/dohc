import { betterAuth, type BetterAuthPlugin } from "better-auth";
import {
  normalizeShareDiscussionDisplayName,
  SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT,
} from "@dohc/security-contract/share-discussion";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import type { Pool } from "pg";
import type { SessionKind } from "./session";
import { SIGN_UP_INVITE_LINK_HEADER, type AdmitAccount, type SignUpAdmission } from "./signUp";
import { accountEmail } from "./email";
import type { SendEmail } from "./smtp";

/** Verification and reset links expire one hour after dohc sends them. */
export const EMAIL_LINK_TTL_SECONDS = 3600;

/** The device sign-in clients this server accepts, and the kind of session each one gets. */
const DEVICE_CLIENT_KINDS: ReadonlyMap<string, "phone" | "desktop"> = new Map([
  ["dohc-phone", "phone"],
  ["dohc-desktop", "desktop"],
]);

/** The only Better Auth endpoints a phone session may use: reading its own session and ending it. */
const PHONE_AUTH_PATHS: ReadonlySet<string> = new Set(["/get-session", "/sign-out"]);

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
  admitAccount?: AdmitAccount;
  accountDeletion?: {
    preview(user: { id: string; email: string }): Promise<Record<string, unknown>>;
    delete(
      user: { id: string; email: string },
      token: string,
      confirmPassword: () => Promise<void>,
    ): Promise<Record<string, unknown>>;
  };
  onAuthEvent?: (
    event: { kind: "signup_completed" } | { kind: "signin_completed"; clientKind: SessionKind },
  ) => void;
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
    options.onAuthEvent?.({ kind: "signup_completed" });
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
              if (
                ctx.path !== "/reset-password" ||
                !ctx.request ||
                !body ||
                typeof body !== "object" ||
                !("name" in body)
              )
                return;
              setupNames.set(ctx.request, chosenName(body.name));
            }),
          },
        }
      : {}),
    databaseHooks: {
      ...(admitAccount || (!closed && options.onAuthEvent)
        ? {
            user: {
              create: {
                ...(admitAccount
                  ? {
                      before: async (
                        user: { email: string },
                        context: { headers?: Headers; request?: Request } | null,
                      ) => {
                        const headers = context?.headers ?? context?.request?.headers;
                        refuseUnadmitted(
                          await admitAccount(
                            user.email,
                            headers?.get(SIGN_UP_INVITE_LINK_HEADER) || null,
                          ),
                        );
                      },
                    }
                  : {}),
                ...(!closed && options.onAuthEvent
                  ? {
                      after: async () => {
                        options.onAuthEvent?.({ kind: "signup_completed" });
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      session: {
        // The kind goes into the same insert that creates the session, so no
        // token exists without one.
        create: {
          before: async (_session, context) => ({
            data: { clientKind: kindOfNewSession(context) },
          }),
          after: async (session) => {
            if (!options.onAuthEvent) return;
            const kind = (session as Record<string, unknown>).clientKind;
            const clientKind: SessionKind =
              kind === "desktop" || kind === "phone" ? kind : "browser";
            options.onAuthEvent({ kind: "signin_completed", clientKind });
          },
        },
        update: {
          before: async (session) => {
            if (Object.hasOwn(session, "clientKind"))
              throw new APIError("FORBIDDEN", {
                code: "SESSION_KIND_FIXED",
                message: "A sign-in keeps the kind it was created with.",
              });
          },
        },
      },
    },
    session: {
      additionalFields: { clientKind: { type: "string", required: true, input: false } },
    },
    baseURL: options.baseURL,
    secret: options.secret,
    basePath: "/api/auth",
    // Its answer carries every session's token. The relay lists sessions without them.
    disabledPaths: ["/list-sessions"],
    database: options.pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: closed,
      resetPasswordTokenExpiresIn: EMAIL_LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token, url: originalUrl }) => {
        const next = emailedLinkNextPage(originalUrl);
        // Until the address is verified, nobody has chosen a password yet.
        const settingUp = closed && !user.emailVerified;
        // The flag only makes the page ask for a name; the server applies one
        // only while the account is unverified.
        const url = page(
          `/account/reset-password?token=${encodeURIComponent(token)}${settingUp ? "&setup=1" : ""}${next ? `&next=${encodeURIComponent(next)}` : ""}`,
        );
        await send(
          accountEmail(
            settingUp
              ? {
                  to: user.email,
                  url,
                  subject: "Set your dohc password",
                  heading: "Set your password",
                  body: "Choose a password to finish setting up your account. This link works for 1 hour.",
                  action: "Choose a password",
                  note: "If you did not create an account, ignore this email. Nobody can sign in until a password is set.",
                }
              : {
                  to: user.email,
                  url,
                  subject: "Reset your dohc password",
                  heading: "Reset your password",
                  body: "Choose a new password for your account. This link works for 1 hour.",
                  action: "Choose a new password",
                  note: "If you did not ask for a new password, ignore this email. Your password stays as it is.",
                },
          ),
        );
      },
      ...(closed
        ? {
            onExistingUserSignUp: async ({
              user,
            }: {
              user: { email: string; emailVerified: boolean };
            }) => {
              if (!user.emailVerified) await sendPasswordLink(user.email, null);
            },
            onPasswordReset: async (
              { user }: { user: { id: string; emailVerified: boolean } },
              request?: Request,
            ) => {
              if (!user.emailVerified)
                await verifyOnPasswordReset(user.id, (request && setupNames.get(request)) ?? "");
            },
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: EMAIL_LINK_TTL_SECONDS,
      sendVerificationEmail: async ({ user, token, url: originalUrl }) => {
        const next = emailedLinkNextPage(originalUrl);
        if (closed) return sendPasswordLink(user.email, next);
        const url = page(
          `/account/verify-email?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next ?? "/account")}`,
        );
        await send(
          accountEmail({
            to: user.email,
            url,
            subject: "Verify your dohc email",
            heading: "Verify your email",
            body: "Verify this address to finish setting up your account. This link works for 1 hour.",
            action: "Verify email",
            note: "Until you verify your email, you cannot open work shared with this address.",
          }),
        );
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
      ...(options.accountDeletion
        ? [
            {
              id: "dohc-account-deletion",
              endpoints: {
                accountDeletionPreview: createAuthEndpoint(
                  "/account/deletion-preview",
                  { method: "POST", use: [sessionMiddleware], requireHeaders: true },
                  async (ctx) => {
                    return ctx.json(
                      await options.accountDeletion!.preview(ctx.context.session.user),
                    );
                  },
                ),
                deleteServerAccount: createAuthEndpoint(
                  "/account/delete",
                  { method: "POST", use: [sessionMiddleware], requireHeaders: true },
                  async (ctx) => {
                    const body: unknown = ctx.body;
                    const token =
                      body && typeof body === "object" && "previewToken" in body
                        ? body.previewToken
                        : undefined;
                    if (typeof token !== "string" || token.length > 512)
                      throw new APIError("BAD_REQUEST", {
                        code: "PREVIEW_REQUIRED",
                        message: "Review account deletion before continuing.",
                      });
                    return ctx.json(
                      await options.accountDeletion!.delete(
                        ctx.context.session.user,
                        token,
                        async () => {
                          const password =
                            body && typeof body === "object" && "password" in body
                              ? body.password
                              : undefined;
                          if (typeof password !== "string" || password.length === 0)
                            throw new APIError("BAD_REQUEST", {
                              code: "PASSWORD_REQUIRED",
                              message: "Enter your server account password to delete this account.",
                            });
                          try {
                            await ctx.context.password.checkPassword(
                              ctx.context.session.user.id,
                              ctx,
                            );
                          } catch (error) {
                            if (
                              error instanceof APIError &&
                              error.body?.code === "INVALID_PASSWORD"
                            )
                              throw new APIError("BAD_REQUEST", {
                                code: "INVALID_PASSWORD",
                                message:
                                  "The password is incorrect. Enter your server account password.",
                              });
                            throw error;
                          }
                        },
                      ),
                    );
                  },
                ),
              },
            },
          ]
        : []),
      // The desktop authenticates API calls with `Authorization: Bearer
      // <session token>` (the device flow's access_token IS a session token).
      bearer(),
      phoneSessionGuard(),
      organization(),
      deviceAuthorization({
        // Desktop polls every few seconds; keep the code lifetime short.
        expiresIn: "10m",
        interval: "3s",
        // Checked when a code is issued and again when it is exchanged, which
        // also requires the same ID the code was issued to.
        validateClient: (clientId) => DEVICE_CLIENT_KINDS.has(clientId),
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

/**
 * The kind of session a device code would create once approved, or null for a
 * code this server doesn't know. The approval page shows it before anyone approves.
 */
export async function deviceCodeKind(
  auth: WorkspaceAuth,
  userCode: string,
): Promise<"phone" | "desktop" | null> {
  const { adapter } = await auth.$context;
  const code = await adapter.findOne<{ clientId: string | null }>({
    model: "deviceCode",
    // Better Auth stores user codes without their dashes.
    where: [{ field: "userCode", value: userCode.replace(/-/g, "") }],
  });
  const clientId = code?.clientId;
  return (clientId ? DEVICE_CLIENT_KINDS.get(clientId) : undefined) ?? null;
}

/**
 * The kind of the session the current endpoint is creating. The device token
 * endpoint has already consumed the approved code and checked that the poll's
 * client ID is one of ours and the one the code was issued to. Every other way
 * of creating a session is refused.
 */
function kindOfNewSession(context: { path?: string; body?: unknown } | null): SessionKind {
  if (context?.path === "/device/token") {
    const body = context.body;
    const clientId =
      body && typeof body === "object" && "client_id" in body ? body.client_id : undefined;
    const kind = typeof clientId === "string" ? DEVICE_CLIENT_KINDS.get(clientId) : undefined;
    if (kind) return kind;
  } else if (context?.path === "/sign-in/email" || context?.path === "/sign-up/email") {
    return "browser";
  }
  throw new APIError("FORBIDDEN", {
    code: "SIGN_IN_KIND_UNKNOWN",
    message: "dohc can't start a sign-in this way.",
  });
}

/**
 * Refuses a phone session on every Better Auth endpoint except reading and
 * ending it, so a phone's token can't approve a device sign-in, change the
 * password, or reach any plugin added later. Before hooks all see the request
 * as it arrived, so this reads both credentials the endpoint could use: the
 * signed session cookie, and the Bearer token `bearer()` turns into one.
 * Either one being a phone session refuses the request.
 */
function phoneSessionGuard() {
  return {
    id: "dohc-phone-session-guard",
    hooks: {
      before: [
        {
          matcher: (context) => !PHONE_AUTH_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const tokens = new Set<string>();
            const cookie = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            if (cookie) tokens.add(cookie);
            for (const header of [
              ctx.request?.headers.get("authorization"),
              ctx.headers?.get("authorization"),
            ]) {
              if (!header || header.slice(0, 7).toLowerCase() !== "bearer ") continue;
              // A signed token is `<token>.<signature>`, possibly URL-encoded.
              const token = decoded(header.slice(7).trim()).split(".")[0];
              if (token) tokens.add(token);
            }
            for (const token of tokens) {
              const found = await ctx.context.internalAdapter.findSession(token);
              const kind: unknown = found?.session.clientKind;
              if (found && kind !== "desktop" && kind !== "browser")
                throw new APIError("FORBIDDEN", {
                  code: "PHONE_SESSION_REFUSED",
                  message: "A phone sign-in can't do this. Use dohc on a computer.",
                });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The page an emailed link should continue, if Better Auth's link carries one:
 * a device sign-in, or the join page. The invite token never rides in the
 * link; the join page asks for the invite link again when its tab lost it.
 */
export function emailedLinkNextPage(betterAuthUrl: string): string | null {
  const callback = new URL(betterAuthUrl).searchParams.get("callbackURL");
  return callback &&
    (callback === "/join" || /^\/device\?user_code=[A-Za-z0-9%_-]+$/.test(callback))
    ? callback
    : null;
}

/** The name other people see, normalized as the relay shows it. */
function chosenName(value: unknown): string {
  const invalid = (message: string) =>
    new APIError("BAD_REQUEST", { code: "INVALID_NAME", message });
  const name = normalizeShareDiscussionDisplayName(value);
  if (!name.ok) {
    throw invalid(
      name.reason === "too-long"
        ? `Enter a name of ${SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT} characters or fewer.`
        : "Enter your name.",
    );
  }
  // The relay hides any name that looks like an address.
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(name.value)) {
    throw invalid(
      "Enter a name instead of an email address. Other people see it beside your work.",
    );
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
