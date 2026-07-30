import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorFromSession, createWorkspaceAuth, type WorkspaceAuth } from "./betterAuth";
import { createSessionActorResolver, UnauthorizedError, type ResolveActor } from "./session";

// Runs against the live dev Postgres (same requirement as workspace-postgres
// conformance tests): pnpm dev:postgres first. The 0001_better_auth migration
// must be applied (test setup applies it idempotently).
const POSTGRES_URL =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";

let pool: Pool;
let auth: WorkspaceAuth;

async function postgresReachable(): Promise<boolean> {
  const probe = new Client({
    connectionString: POSTGRES_URL,
    connectionTimeoutMillis: 2000,
  });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await postgresReachable();

// Self-skipping is right for local dev, and WRONG anywhere this suite is the
// thing standing between a change and the collab surface's authorization
// behaviour. In CI a Postgres that failed to start would otherwise skip every
// test here and report green -- a hollow pass. DOHC_REQUIRE_POSTGRES turns an
// unreachable database into a failure instead.
if (!pgAvailable && process.env.DOHC_REQUIRE_POSTGRES === "1") {
  throw new Error(
    `DOHC_REQUIRE_POSTGRES=1 but no Postgres is reachable at ${POSTGRES_URL}. ` +
      "These tests apply the real 0001_better_auth.sql migration and exercise " +
      "session/authorization behaviour through it; skipping them here would " +
      "report green without checking anything.",
  );
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
    auth = createWorkspaceAuth({
      pool,
      baseURL: "http://localhost:1786",
      secret: "test-secret-0123456789abcdef0123456789abcdef",
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
    //    polls to one per `interval` measured from the LAST accepted poll's
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
    // token, so the SAME resolver serves the browser web client.
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
