import {
  createLocalBlobStore,
  createPostgresWorkspaceBackend,
  defaultPostgresUrl,
} from "@dohc/workspace-postgres";
import { toNodeHandler } from "better-auth/node";
import { createServer } from "node:http";
import { Pool } from "pg";
import { createWorkspaceAuth } from "./auth/betterAuth";
import { createSessionActorResolver } from "./auth/session";
import { createWorkspaceApiHandler } from "./server";

// The dohc Cloud / self-host server process: ONE Postgres, Better Auth mounted
// on /api/auth/*, and the workspace API behind session-resolved actors.
// server.ts stays a pure, injectable fetch-handler factory; THIS file is the
// production wiring (and the only place that reads env).

const port = Number(process.env.WORKSPACE_API_PORT ?? 1786);
const baseURL = process.env.WORKSPACE_API_BASE_URL ?? `http://localhost:${port}`;
const secret = process.env.BETTER_AUTH_SECRET ?? "";
const testAuthSeam = process.env.DOHC_TEST_AUTH === "1";

if (!testAuthSeam && secret.length < 32) {
  console.error(
    "BETTER_AUTH_SECRET must be set (>=32 chars) — generate one with `openssl rand -base64 32`.",
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
});
const auth = createWorkspaceAuth({
  pool,
  baseURL,
  secret: secret || "dev-test-only-secret-0123456789abcdef",
});
const backend = createPostgresWorkspaceBackend(pool, {
  blobStore: createLocalBlobStore(),
});
const workspaceHandler = createWorkspaceApiHandler({
  backend,
  resolveActor: createSessionActorResolver(auth),
});

// Test-only seam (plan Phase 9 Step 3): approves a device code as a seeded
// test user so the desktop E2E can drive the real flow without a browser.
// Double-gated: env flag AND never in production NODE_ENV.
async function handleTestDeviceApprove(request: Request): Promise<Response> {
  const { userCode, email } = (await request.json()) as {
    userCode?: string;
    email?: string;
  };
  if (!userCode) return Response.json({ ok: false, error: "userCode required" }, { status: 400 });
  const testEmail = email ?? "e2e-test-user@dohc.test";
  const password = "e2e-test-password-123";
  try {
    await auth.api.signUpEmail({
      body: { email: testEmail, password, name: "E2E Test User" },
    });
  } catch {
    // Already seeded — sign-in below is the real assertion.
  }
  const signin = await auth.api.signInEmail({
    body: { email: testEmail, password },
    returnHeaders: true,
  });
  const cookie = signin.headers.get("set-cookie")?.split(";")[0] ?? "";
  await auth.api.deviceVerify({ query: { user_code: userCode }, headers: { cookie } });
  await auth.api.deviceApprove({ body: { userCode }, headers: { cookie } });
  return Response.json({ ok: true, email: testEmail });
}

const fetchHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, service: "workspace-api" });
  }
  if (
    testAuthSeam &&
    process.env.NODE_ENV !== "production" &&
    url.pathname === "/test/device/approve" &&
    request.method === "POST"
  ) {
    return handleTestDeviceApprove(request);
  }
  return workspaceHandler(request);
};

const server = createServer(toNodeHandler(fetchHandler));
server.listen(port, () => {
  console.log(`[workspace-api] listening on :${port} (auth at /api/auth)`);
  if (testAuthSeam) console.log("[workspace-api] DOHC_TEST_AUTH seam ENABLED (dev/test only)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
