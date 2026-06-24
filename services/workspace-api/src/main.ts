import { createLocalBlobStore } from "@dohc/workspace-postgres/blobStore";
import { createPostgresWorkspaceBackend } from "@dohc/workspace-postgres/services/backend";
import { createPostgresWorkspaceProvisioner } from "@dohc/workspace-postgres/services/provisioning";
import { toNodeHandler } from "better-auth/node";
import { createServer } from "node:http";
import { Pool } from "pg";
import { createWorkspaceAuth } from "./auth/betterAuth";
import { createSessionActorResolver } from "./auth/session";
import { withCors } from "./cors";
import { createWorkspaceApiHandler } from "./server";
import type { HocuspocusAdminClient } from "./routes/shared";

// The dohc Cloud / self-host server process: ONE Postgres, Better Auth mounted
// on /api/auth/*, and the workspace API behind session-resolved actors.
// server.ts stays a pure, injectable fetch-handler factory; THIS file is the
// production wiring (and the only place that reads env).

const port = Number(process.env.WORKSPACE_API_PORT ?? 1786);
const baseURL = process.env.WORKSPACE_API_BASE_URL ?? `http://localhost:${port}`;
const secret = process.env.BETTER_AUTH_SECRET ?? "";
const defaultPostgresUrl = "postgres://dohc:dohc@localhost:54329/dohc_v2";

// The /test/device/approve impersonation seam is fail-CLOSED: it requires an
// explicit dev/test signal, never merely "not production". An operator who
// copies a dev .env (DOHC_TEST_AUTH=1) into a real deployment must crash the
// server, not silently expose a full-impersonation endpoint with a
// source-visible secret.
const nodeEnv = process.env.NODE_ENV;
const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";
const testAuthSeam = process.env.DOHC_TEST_AUTH === "1" && isDevOrTest;

if (process.env.DOHC_TEST_AUTH === "1" && !isDevOrTest) {
  console.error(
    `FATAL: DOHC_TEST_AUTH=1 requires NODE_ENV=development or test, got NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
      "This is a dangerous impersonation seam — refusing to start.",
  );
  process.exit(1);
}

if (!testAuthSeam && secret.length < 32) {
  console.error(
    "BETTER_AUTH_SECRET must be set (>=32 chars) — generate one with `openssl rand -base64 32`.",
  );
  process.exit(1);
}

// Browser web client (dohc Cloud): setting DOHC_WEB_ORIGIN enables CORS with
// credentials for that ONE origin plus Better Auth origin trust. Unset (the
// default) leaves the API same-origin/Bearer only.
const webOrigin = process.env.DOHC_WEB_ORIGIN;

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
});
const auth = createWorkspaceAuth({
  pool,
  baseURL,
  secret: secret || "dev-test-only-secret-0123456789abcdef",
  ...(webOrigin ? { trustedOrigins: [webOrigin] } : {}),
});
const backend = createPostgresWorkspaceBackend(pool, {
  blobStore: createLocalBlobStore(),
});

const HOCUSPOCUS_ADMIN_TIMEOUT_DEFAULT_MS = 2_000;
const HOCUSPOCUS_ADMIN_TIMEOUT_MAX_MS = 5_000;
const hocuspocusJwtSecret = process.env.HOCUSPOCUS_JWT_SECRET?.trim();

function createHocuspocusAdminClient(): HocuspocusAdminClient {
  if (!hocuspocusJwtSecret) {
    return {
      async disconnectWorkspaceUser() {
        // Collaboration token minting is disabled, so no Hocuspocus sessions
        // can be authenticated for this API process.
      },
    };
  }
  const baseUrl = process.env.HOCUSPOCUS_ADMIN_URL?.trim();
  const adminToken = process.env.HOCUSPOCUS_ADMIN_TOKEN?.trim();
  if (!baseUrl || !adminToken) {
    console.error(
      "HOCUSPOCUS_ADMIN_URL and HOCUSPOCUS_ADMIN_TOKEN are required when HOCUSPOCUS_JWT_SECRET enables collaboration.",
    );
    process.exit(1);
  }
  let adminBase: URL;
  try {
    adminBase = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    console.error("HOCUSPOCUS_ADMIN_URL must be a valid absolute URL.");
    process.exit(1);
  }
  if (
    adminBase.protocol !== "https:" &&
    !(adminBase.protocol === "http:" && isLocalHocuspocusAdminHost(adminBase.hostname))
  ) {
    console.error(
      "HOCUSPOCUS_ADMIN_URL must use https, or http only for localhost/loopback development endpoints.",
    );
    process.exit(1);
  }
  const configuredTimeoutMs = Number(
    process.env.HOCUSPOCUS_ADMIN_TIMEOUT_MS ??
      HOCUSPOCUS_ADMIN_TIMEOUT_DEFAULT_MS,
  );
  const timeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.min(configuredTimeoutMs, HOCUSPOCUS_ADMIN_TIMEOUT_MAX_MS)
      : HOCUSPOCUS_ADMIN_TIMEOUT_DEFAULT_MS;
  return {
    async disconnectWorkspaceUser({ workspaceId, userId, signal }) {
      const url = new URL("admin/disconnect-by-workspace-user", adminBase);
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal?.reason);
      if (signal?.aborted) {
        controller.abort(signal.reason);
      } else {
        signal?.addEventListener("abort", abortFromCaller, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ workspaceId, userId }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`hocuspocus disconnect timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortFromCaller);
      }
      try {
        if (!response.ok) {
          throw new Error(`hocuspocus disconnect failed with ${response.status}`);
        }
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    },
  };
}

function isLocalHocuspocusAdminHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv4Parts = normalized.split(".");
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === "127" &&
    ipv4Parts.every((part) => {
      if (!/^\d{1,3}$/u.test(part)) return false;
      return Number(part) <= 255;
    });
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isIpv4Loopback ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

const workspaceHandler = createWorkspaceApiHandler({
  backend,
  resolveActor: createSessionActorResolver(auth),
  createWorkspace: createPostgresWorkspaceProvisioner(pool),
  // Same secret hocuspocus verifies with; self-hosts without a collab server
  // leave it unset and POST /workspaces/:id/collab/token errors collab-disabled.
  collab: hocuspocusJwtSecret ? { pool, jwtSecret: hocuspocusJwtSecret } : undefined,
  shared: { pool, hocuspocusAdmin: createHocuspocusAdminClient() },
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

const fetchHandler = withCors(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, service: "workspace-api" });
  }
  // testAuthSeam already encodes the dev/test gate (fail-closed above).
  if (testAuthSeam && url.pathname === "/test/device/approve" && request.method === "POST") {
    return handleTestDeviceApprove(request);
  }
  return workspaceHandler(request);
}, webOrigin);

const server = createServer(toNodeHandler(fetchHandler));
// When the impersonation seam is on, bind loopback only so the dev-cloud
// test server is never reachable off-host.
const host = testAuthSeam ? "127.0.0.1" : "0.0.0.0";
server.listen(port, host, () => {
  console.log(`[workspace-api] listening on ${host}:${port} (auth at /api/auth)`);
  if (testAuthSeam) console.log("[workspace-api] DOHC_TEST_AUTH seam ENABLED (dev/test only)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
