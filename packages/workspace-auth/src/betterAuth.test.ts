import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkspaceAuth, type WorkspaceAuth } from "./betterAuth";
import { actorFromSession, createSessionActorResolver, UnauthorizedError, type ResolveActor } from "./session";
import type { SignUpAdmission } from "./signUp";
import type { EmailMessage } from "./smtp";

// Runs against the live dev Postgres (same requirement as workspace-postgres
// conformance tests): pnpm dev:postgres first. The 0001_better_auth migration
// must be applied (test setup applies it idempotently).
const POSTGRES_URL =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";

let pool: Pool;
let auth: WorkspaceAuth;
// The transport under test is exercised in smtp.test.ts; here the sender only
// has to record what the auth surface asked to deliver.
const sent: EmailMessage[] = [];

function lastEmailTo(email: string): EmailMessage {
  const message = [...sent].reverse().find((entry) => entry.to === email);
  if (!message) throw new Error(`no email was sent to ${email}`);
  return message;
}

function linkIn(message: EmailMessage): URL {
  const match = /https?:\/\/\S+/.exec(message.text);
  if (!match) throw new Error(`no link in email: ${message.text}`);
  return new URL(match[0]);
}

// A refused connection fails at once, so a run without Postgres still skips
// immediately. The timeout covers only a slow answer: under the full JS gate a
// 2 s bound timed out against a healthy database.
const probe = new Client({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 30_000 });
let pgAvailable = false;
try {
  await probe.connect();
  await probe.end();
  pgAvailable = true;
} catch (error) {
  // Self-skipping is right for local dev, and wrong anywhere this suite is the
  // thing standing between a change and the collab surface's authorization
  // behaviour. In CI a Postgres that failed to start would otherwise skip every
  // test here and report green -- a hollow pass. DOHC_REQUIRE_POSTGRES turns an
  // unreachable database into a failure instead.
  if (process.env.DOHC_REQUIRE_POSTGRES === "1") {
    throw new Error(
      `DOHC_REQUIRE_POSTGRES=1 but no Postgres is reachable at ${POSTGRES_URL}. ` +
        "These tests apply the real 0001_better_auth.sql migration and exercise " +
        "session/authorization behaviour through it; skipping them here would " +
        "report green without checking anything.",
      { cause: error },
    );
  }
}

const describeWithPostgres = describe.skipIf(!pgAvailable);

const PASSWORD = "a-real-password-123";
const unique = () => `ba-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function signUp(email: string) {
  return auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: "Test User" },
  });
}

async function sessionCookieFor(email: string): Promise<string> {
  const signin = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return signin.headers.get("set-cookie")?.split(";")[0] ?? "";
}

// A minimal request handler standing in for the API layer: resolve the actor
// (401 on UnauthorizedError) and otherwise echo ok. This keeps the cookie
// path's request-handler coverage without workspace-auth depending on the
// application server it feeds.
function miniHandler(resolve: ResolveActor, workspaceId: string) {
  return async (request: Request): Promise<Response> => {
    try {
      const actor = await resolve(request, workspaceId);
      return Response.json({ ok: true, userId: actor.userId });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return Response.json({ ok: false }, { status: 401 });
      }
      throw error;
    }
  };
}

if (pgAvailable) {
  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(
      new URL(
        "../../workspace-postgres/src/db/migrations/0001_better_auth.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(await readFile(new URL("../../workspace-postgres/src/db/migrations/0004_account_deletion.sql", import.meta.url), "utf8"));
    auth = createWorkspaceAuth({
      pool,
      baseURL: "http://localhost:1786",
      secret: "test-secret-0123456789abcdef0123456789abcdef",
      sendEmail: async (message) => {
        sent.push(message);
      },
    });
  });

  afterAll(async () => {
    await pool.end();
  });
}

describeWithPostgres("email/password against Postgres", () => {
  it("signs up and signs in", async () => {
    const email = `${unique()}@dohc.test`;
    const signup = await signUp(email);
    expect(signup.user.email).toBe(email);

    const signin = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
    });
    expect(signin.user.id).toBe(signup.user.id);
  });

  it("rejects a wrong password", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);
    await expect(
      auth.api.signInEmail({ body: { email, password: "wrong-password-1" } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describeWithPostgres("closed sign-up", () => {
  function closedAuth(admission: SignUpAdmission, asked: string[] = []): WorkspaceAuth {
    return createWorkspaceAuth({
      pool,
      baseURL: "http://localhost:1786",
      secret: "test-secret-0123456789abcdef0123456789abcdef",
      sendEmail: async (message) => {
        sent.push(message);
      },
      admitAccount: async (email) => {
        asked.push(email);
        return admission;
      },
    });
  }

  async function accountExists(email: string): Promise<boolean> {
    return ((await pool.query('SELECT 1 FROM "user" WHERE email = $1', [email])).rowCount ?? 0) > 0;
  }

  it("refuses an address the server did not admit and creates no account", async () => {
    const email = `${unique()}@dohc.test`;
    const asked: string[] = [];
    await expect(
      closedAuth("refused", asked).api.signUpEmail({ body: { email, password: PASSWORD, name: "Test User" } }),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: "SIGN_UP_CLOSED" } });
    expect(asked).toEqual([email]);
    expect(await accountExists(email)).toBe(false);
    expect(sent.some((message) => message.to === email)).toBe(false);
  });

  function emailsTo(email: string): EmailMessage[] {
    return sent.filter((message) => message.to === email);
  }

  /** Opens the newest emailed link the way the reset page does. */
  async function choosePassword(closed: WorkspaceAuth, email: string, newPassword: string): Promise<void> {
    const message = lastEmailTo(email);
    expect(message.subject).toBe("Choose your dohc password");
    const link = linkIn(message);
    expect(link.pathname).toBe("/account/reset-password");
    await closed.api.resetPassword({ body: { newPassword, token: link.searchParams.get("token") ?? "" } });
  }

  /** Submits the set-password form over HTTP with the newest emailed link's token. */
  async function submitResetPage(closed: WorkspaceAuth, email: string, body: Record<string, string>): Promise<Response> {
    const token = linkIn(lastEmailTo(email)).searchParams.get("token") ?? "";
    return closed.handler(
      new Request("http://localhost:1786/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      }),
    );
  }

  async function nameOf(userId: string): Promise<string | undefined> {
    return (await pool.query<{ name: string }>('SELECT name FROM "user" WHERE id = $1', [userId])).rows[0]?.name;
  }

  it("creates an account the server admitted, with no session until its owner chooses a password from the emailed link", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    const response = await closed.handler(
      new Request("http://localhost:1786/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The closed sign-up page has no name field.
        body: JSON.stringify({ email, password: PASSWORD, name: "", callbackURL: "/device?user_code=ABCD-EFGH" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token: unknown }).token).toBeNull();
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await accountExists(email)).toBe(true);
    expect(linkIn(lastEmailTo(email)).searchParams.get("next")).toBe("/device?user_code=ABCD-EFGH");

    const emailsBeforeSignIn = emailsTo(email).length;
    await expect(closed.api.signInEmail({ body: { email, password: PASSWORD } })).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "EMAIL_NOT_VERIFIED" },
    });
    await expect(closed.api.signInEmail({ body: { email, password: "wrong-password-1" } })).rejects.toMatchObject({
      statusCode: 401,
      body: { code: "INVALID_EMAIL_OR_PASSWORD" },
    });
    expect(emailsTo(email)).toHaveLength(emailsBeforeSignIn);

    // Choosing the password proves the mailbox; then the desktop's device
    // sign-in completes as on an open server.
    const chosen = "chosen-from-the-link-123";
    await choosePassword(closed, email, chosen);
    const signin = await closed.api.signInEmail({ body: { email, password: chosen }, returnHeaders: true });
    const cookie = signin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const device = await closed.api.deviceCode({ body: { client_id: "dohc-desktop" } });
    await closed.api.deviceVerify({ query: { user_code: device.user_code }, headers: { cookie } });
    await closed.api.deviceApprove({ body: { userCode: device.user_code }, headers: { cookie } });
    const token = await closed.api.deviceToken({
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: "dohc-desktop",
      },
    });
    const session = await closed.api.getSession({ headers: { authorization: `Bearer ${token.access_token}` } });
    expect(session?.user.email).toBe(email);
  });

  it("never lets a password typed by someone else outlast the owner's emailed link", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    const attackerPassword = "attacker-password-aaa";
    const ownerPassword = "owner-password-bbb";

    await closed.api.signUpEmail({ body: { email, password: attackerPassword, name: "Attacker" } });
    // The owner's own sign-up gets the generic answer and a fresh link.
    const before = emailsTo(email).length;
    const duplicate = await closed.api.signUpEmail({ body: { email, password: ownerPassword, name: "Owner" } });
    expect(duplicate.token).toBeNull();
    expect(emailsTo(email).length).toBe(before + 1);
    // Asking for a new link sends the same kind of link, never a plain verification.
    await closed.api.sendVerificationEmail({ body: { email } });
    expect(emailsTo(email).length).toBe(before + 2);
    expect(emailsTo(email).every((message) => linkIn(message).pathname === "/account/reset-password")).toBe(true);

    await choosePassword(closed, email, ownerPassword);

    await expect(closed.api.signInEmail({ body: { email, password: attackerPassword } })).rejects.toMatchObject({
      statusCode: 401,
    });
    const signin = await closed.api.signInEmail({ body: { email, password: ownerPassword } });
    expect(signin.user.emailVerified).toBe(true);
  });

  it("takes the account's name from the owner's emailed link, never from an earlier sign-up", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    const { user } = await closed.api.signUpEmail({ body: { email, password: "attacker-password-aaa", name: "Mallory" } });
    await closed.api.signUpEmail({ body: { email, password: "owner-password-bbb", name: "Owner" } });
    expect(linkIn(lastEmailTo(email)).searchParams.get("setup")).toBe("1");

    const response = await submitResetPage(closed, email, { newPassword: "owner-password-bbb", name: "  Ada   Lovelace " });
    expect(response.status).toBe(200);
    expect(await nameOf(user.id)).toBe("Ada Lovelace");
  });

  it("leaves the account unnamed when the owner's link arrives without a name", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    const { user } = await closed.api.signUpEmail({ body: { email, password: "attacker-password-aaa", name: "Mallory" } });
    await choosePassword(closed, email, "owner-password-bbb");
    expect(await nameOf(user.id)).toBe("");
  });

  it("keeps each concurrent setup's name to its own account", async () => {
    const closed = closedAuth("admitted");
    const named = `${unique()}@dohc.test`;
    const unnamed = `${unique()}@dohc.test`;
    const first = await closed.api.signUpEmail({ body: { email: named, password: "attacker-password-aaa", name: "Mallory" } });
    const second = await closed.api.signUpEmail({ body: { email: unnamed, password: "attacker-password-aaa", name: "Trudy" } });

    const responses = await Promise.all([
      submitResetPage(closed, named, { newPassword: "owner-password-bbb", name: "Ada" }),
      submitResetPage(closed, unnamed, { newPassword: "owner-password-ccc" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await nameOf(first.user.id)).toBe("Ada");
    expect(await nameOf(second.user.id)).toBe("");
  });

  it("refuses an email address as a name and keeps the link usable", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    const { user } = await closed.api.signUpEmail({ body: { email, password: "attacker-password-aaa", name: "Mallory" } });

    const refused = await submitResetPage(closed, email, { newPassword: "owner-password-bbb", name: "ada@example.com" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe("INVALID_NAME");
    expect(await nameOf(user.id)).toBe("Mallory");

    const accepted = await submitResetPage(closed, email, { newPassword: "owner-password-bbb", name: "Ada" });
    expect(accepted.status).toBe(200);
    expect(await nameOf(user.id)).toBe("Ada");
  });

  it("never renames a verified account from a password reset, even with a name in the request", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    const { user } = await closed.api.signUpEmail({ body: { email, password: PASSWORD, name: "" } });
    await submitResetPage(closed, email, { newPassword: "owner-password-bbb", name: "Ada" });

    await closed.api.requestPasswordReset({ body: { email } });
    expect(linkIn(lastEmailTo(email)).searchParams.get("setup")).toBeNull();
    // A setup flag added to the page's address only makes the page send a name.
    const response = await submitResetPage(closed, email, { newPassword: "another-password-ddd", name: "Mallory" });
    expect(response.status).toBe(200);
    expect(await nameOf(user.id)).toBe("Ada");
  });

  it("signs out every session before it verifies the address, so a failure between the two leaves nobody signed in", async () => {
    const email = `${unique()}@dohc.test`;
    // A session from while sign-up was open.
    const { token, user } = await signUp(email);
    const bearer = { authorization: `Bearer ${token}` };
    expect(await auth.api.getSession({ headers: bearer })).not.toBeNull();

    const closed = closedAuth("admitted");
    await closed.api.requestPasswordReset({ body: { email } });
    const { internalAdapter } = await closed.$context;
    const verify = vi.spyOn(internalAdapter, "updateUser").mockRejectedValueOnce(new Error("The database went away."));
    try {
      await expect(choosePassword(closed, email, "owner-password-ccc")).rejects.toThrow("The database went away.");
      expect(verify).toHaveBeenCalledWith(user.id, { name: "", emailVerified: true });
    } finally {
      verify.mockRestore();
    }

    expect(await closed.api.getSession({ headers: bearer })).toBeNull();
    const state = await pool.query<{ emailVerified: boolean; sessions: number }>(
      'SELECT "emailVerified", (SELECT count(*) FROM "session" WHERE "userId" = $1)::int AS sessions FROM "user" WHERE id = $1',
      [user.id],
    );
    expect(state.rows).toEqual([{ emailVerified: false, sessions: 0 }]);
  });

  it("sends no link when someone signs up again with a verified address", async () => {
    const email = `${unique()}@dohc.test`;
    const closed = closedAuth("admitted");
    await closed.api.signUpEmail({ body: { email, password: PASSWORD, name: "Test User" } });
    await choosePassword(closed, email, PASSWORD);
    const before = emailsTo(email).length;
    const duplicate = await closed.api.signUpEmail({ body: { email, password: "another-password-1", name: "Test User" } });
    expect(duplicate.token).toBeNull();
    expect(emailsTo(email).length).toBe(before);
  });

  it("refuses a verification link sent while sign-up was open", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);
    const token = linkIn(lastEmailTo(email)).searchParams.get("token") ?? "";
    await expect(closedAuth("admitted").api.verifyEmail({ query: { token } })).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "PASSWORD_LINK_REQUIRED" },
    });
    await expect(auth.api.signInEmail({ body: { email, password: PASSWORD } })).resolves.toMatchObject({
      user: { emailVerified: false },
    });
  });

  it("asks the person to try again when the server cannot check invites", async () => {
    const email = `${unique()}@dohc.test`;
    await expect(
      closedAuth("unavailable").api.signUpEmail({ body: { email, password: PASSWORD, name: "Test User" } }),
    ).rejects.toMatchObject({ statusCode: 503, body: { code: "SIGN_UP_CHECK_UNAVAILABLE" } });
    expect(await accountExists(email)).toBe(false);
  });

  it("answers the sign-up page with the refusal it shows", async () => {
    const response = await closedAuth("refused").handler(
      new Request("http://localhost:1786/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `${unique()}@dohc.test`, password: PASSWORD, name: "Test User" }),
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("SIGN_UP_CLOSED");
    expect(body.message).toMatch(/^This server creates accounts only for approved or invited email addresses\./);
  });
});

describeWithPostgres("account email", () => {
  it("sends a verification link to a dohc page, and the link verifies the address", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);

    const message = lastEmailTo(email);
    expect(message.subject).toBe("Verify your dohc email");
    const link = linkIn(message);
    expect(link.pathname).toBe("/account/verify-email");
    const token = link.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(0);

    await auth.api.verifyEmail({ query: { token } });
    const signin = await auth.api.signInEmail({ body: { email, password: PASSWORD } });
    expect(signin.user.emailVerified).toBe(true);
  });

  it("sends a reset link that sets a new password", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);

    await auth.api.requestPasswordReset({ body: { email } });
    const link = linkIn(lastEmailTo(email));
    expect(link.pathname).toBe("/account/reset-password");
    expect(link.searchParams.get("setup")).toBeNull();

    const newPassword = "another-real-password-456";
    await auth.api.resetPassword({
      body: { newPassword, token: link.searchParams.get("token") ?? "" },
    });

    const signin = await auth.api.signInEmail({ body: { email, password: newPassword } });
    expect(signin.user.email).toBe(email);
    expect(signin.user.name).toBe("Test User");
    // An open server keeps verification a separate step.
    expect(signin.user.emailVerified).toBe(false);
    await expect(
      auth.api.signInEmail({ body: { email, password: PASSWORD } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("refuses a second sign-up for the same address and sends no mail", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);
    const before = sent.filter((message) => message.to === email).length;
    await expect(signUp(email)).rejects.toMatchObject({ statusCode: 422 });
    expect(sent.filter((message) => message.to === email).length).toBe(before);
  });

  it("answers a reset request for an unknown address without sending mail", async () => {
    const email = `${unique()}@dohc.test`;
    await auth.api.requestPasswordReset({ body: { email } });
    expect(sent.some((message) => message.to === email)).toBe(false);
  });
});

describeWithPostgres("device authorization flow (desktop login)", () => {
  it("issues a usable desktop session: request code, approve in browser session, poll succeeds, token authenticates", async () => {
    const email = `${unique()}@dohc.test`;
    const signup = await signUp(email);

    // 1. Desktop requests a device code.
    const device = await auth.api.deviceCode({ body: { client_id: "dohc-desktop" } });
    expect(device.user_code).toBeTruthy();
    expect(device.device_code).toBeTruthy();
    expect(device.verification_uri).toContain("/device");

    // 2. Polling before approval reports authorization_pending.
    await expect(
      auth.api.deviceToken({
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "dohc-desktop",
        },
      }),
    ).rejects.toMatchObject({
      body: { error: "authorization_pending" },
    });

    // 3. Browser-side: signed-in user claims the code, then approves.
    const cookie = await sessionCookieFor(email);
    await auth.api.deviceVerify({
      query: { user_code: device.user_code },
      headers: { cookie },
    });
    const approve = await auth.api.deviceApprove({
      body: { userCode: device.user_code },
      headers: { cookie },
    });
    expect(approve).toMatchObject({ success: true });

    // 4. Desktop polls and receives a session token. The server throttles
    //    polls to one per `interval` measured from the last accepted poll's
    //    server-side timestamp, so a single fixed sleep can still land in
    //    the window (observed flake). Loop until slow_down clears, waiting
    //    interval + margin each time; any other error is a real failure.
    const pollDelayMs = (device.interval ?? 3) * 1000 + 500;
    let token: { access_token?: string } | undefined;
    for (let attempt = 0; attempt < 5 && !token; attempt += 1) {
      try {
        token = await auth.api.deviceToken({
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
            client_id: "dohc-desktop",
          },
        });
      } catch (error) {
        const code = (error as { body?: { error?: string } }).body?.error;
        if (code !== "slow_down") throw error;
        await new Promise((r) => setTimeout(r, pollDelayMs));
      }
    }
    expect(token?.access_token).toBeTruthy();

    // 5. ...which authenticates API requests as a Bearer session.
    const session = await auth.api.getSession({
      headers: { authorization: `Bearer ${token!.access_token}` },
    });
    expect(session?.user.id).toBe(signup.user.id);

    // 6. And maps to the Actor shape downstream authz consumes.
    expect(actorFromSession(session!, "ws-1")).toEqual({
      userId: signup.user.id,
      workspaceId: "ws-1",
    });
  }, 30_000);

  it("denies the token when the user denies the code", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);
    const device = await auth.api.deviceCode({ body: { client_id: "dohc-desktop" } });

    const cookie = await sessionCookieFor(email);
    await auth.api.deviceVerify({
      query: { user_code: device.user_code },
      headers: { cookie },
    });
    await auth.api.deviceDeny({
      body: { userCode: device.user_code },
      headers: { cookie },
    });

    await expect(
      auth.api.deviceToken({
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: "dohc-desktop",
        },
      }),
    ).rejects.toMatchObject({ body: { error: "access_denied" } });
  });
});

describeWithPostgres("session validation middleware shape", () => {
  it("returns null for a missing or invalid bearer token", async () => {
    expect(
      await auth.api.getSession({ headers: { authorization: "Bearer not-a-token" } }),
    ).toBeNull();
    expect(await auth.api.getSession({ headers: {} })).toBeNull();
  });

  it("ResolveActor maps a Bearer session to the downstream Actor and 401s everything else", async () => {
    const email = `${unique()}@dohc.test`;
    const signup = await signUp(email);
    const signin = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
    });
    const resolve = createSessionActorResolver(auth);

    const actor = await resolve(
      new Request("http://localhost/workspaces/ws-1/files", {
        headers: { authorization: `Bearer ${signin.token}` },
      }),
      "ws-1",
    );
    expect(actor).toEqual({ userId: signup.user.id, workspaceId: "ws-1" });

    // Missing/expired/invalid tokens are rejected with the unauthorized shape
    // the API layer maps to a 401 — identity never falls back to client input.
    await expect(
      resolve(new Request("http://localhost/workspaces/ws-1/files"), "ws-1"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      resolve(
        new Request("http://localhost/x", { headers: { authorization: "Bearer bogus" } }),
        "ws-1",
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: "unauthorized" });
  });
});

describeWithPostgres("browser cookie sessions (web client)", () => {
  it("resolves the route-level actor from a signed-in cookie jar and 401s anonymous requests", async () => {
    const email = `${unique()}@dohc.test`;
    const signup = await signUp(email);
    const cookie = await sessionCookieFor(email);

    // getSession reads the session cookie the same way it reads a Bearer
    // token, so the same resolver serves the browser web client.
    const resolve = createSessionActorResolver(auth);
    const actor = await resolve(
      new Request("http://localhost:1786/workspaces/ws-cookie/files", { headers: { cookie } }),
      "ws-cookie",
    );
    expect(actor).toEqual({ userId: signup.user.id, workspaceId: "ws-cookie" });

    // Route-level: a request handler built on this resolver serves a
    // cookie-authenticated request and 401s an anonymous one (the same
    // resolver the API layer wires in).
    const handler = miniHandler(resolve, "ws-cookie");
    const response = await handler(
      new Request("http://localhost:1786/workspaces/ws-cookie/files", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, userId: signup.user.id });

    const anonymous = await handler(
      new Request("http://localhost:1786/workspaces/ws-cookie/files"),
    );
    expect(anonymous.status).toBe(401);
  });
});

describeWithPostgres("organization plugin (team workspaces)", () => {
  it("creates an organization and lists the creator as a member", async () => {
    const email = `${unique()}@dohc.test`;
    await signUp(email);
    const cookie = await sessionCookieFor(email);

    const org = await auth.api.createOrganization({
      body: { name: "Test Team", slug: unique() },
      headers: { cookie },
    });
    expect(org?.id).toBeTruthy();

    const full = await auth.api.getFullOrganization({
      query: { organizationId: org!.id },
      headers: { cookie },
    });
    expect(full?.members.some((m) => m.role === "owner")).toBe(true);
  });
});
