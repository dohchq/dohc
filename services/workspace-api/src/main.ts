import { createWorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import {
  createSmtpSender,
  refuseEmail,
  type EmailMessage,
  type SendEmail,
} from "@dohc/workspace-auth/smtp";
import { toNodeHandler } from "better-auth/node";
import { createServer } from "node:http";
import { Pool } from "pg";
import { sanitizeAuthHeaders } from "./clientAddress";
import { ConfigError, readConfig, type WorkspaceApiConfig } from "./config";
import { createReadinessProbe } from "./readiness";
import { createRouter, type AuthGateway } from "./routes";

// The auth host: one Postgres, Better Auth on /api/auth/*, and the browser
// account pages that drive it. This file owns the process — env, database,
// sockets, shutdown — and routes.ts owns request handling.

let config: WorkspaceApiConfig;
try {
  config = readConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
}

// NODE_ENV=test may capture mail in memory so a test can read the link back.
// Every other environment sends over SMTP or refuses: a server with no
// transport must not pretend a verification email went out.
const captured: EmailMessage[] = [];
const sendEmail: SendEmail = config.smtp
  ? createSmtpSender(config.smtp)
  : config.emailTransport === "capture"
    ? async (message) => {
        captured.push(message);
      }
    : refuseEmail;

const pool = new Pool({ connectionString: config.postgresUrl, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000 });
pool.on("error", () => console.error("[workspace-api] An idle database connection failed."));
const auth = createWorkspaceAuth({
  pool,
  baseURL: config.baseURL,
  secret: config.secret,
  sendEmail,
  ...(config.trustedOrigins.length > 0 ? { trustedOrigins: config.trustedOrigins } : {}),
});

const gateway: AuthGateway = {
  handler: (request) => auth.handler(request),
  api: {
    getSession: ({ headers }) => auth.api.getSession({ headers }),
    deviceVerify: ({ query, headers }) => auth.api.deviceVerify({ query, headers }),
  },
};

// Test-only seam: approves a device code as a seeded test user so the desktop
// E2E can drive the real flow without a browser. Double-gated in readConfig by
// DOHC_TEST_AUTH and NODE_ENV, and the process binds loopback while it is on.
async function handleTestDeviceApprove(request: Request): Promise<Response> {
  const { userCode, email } = (await request.json()) as { userCode?: string; email?: string };
  if (!userCode) return Response.json({ ok: false, error: "userCode required" }, { status: 400 });
  const testEmail = email ?? "e2e-test-user@dohc.test";
  const password = "e2e-test-password-123";
  try {
    await auth.api.signUpEmail({ body: { email: testEmail, password, name: "E2E Test User" } });
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

const router = createRouter({
  auth: gateway,
  readiness: createReadinessProbe(pool, { emailConfigured: config.emailTransport !== "none" }),
  descriptor: config.descriptor,
  emailTransport: config.emailTransport,
  allowedOrigins: config.allowedOrigins,
  seams: {
    ...(config.testAuthSeam ? { deviceApprove: handleTestDeviceApprove } : {}),
    ...(config.emailTransport === "capture" ? { sentEmails: () => captured } : {}),
  },
});

// The client address is derived from the socket and this server's own trusted
// proxy list before Better Auth sees a single header, so no caller can choose
// the address its rate limit is counted against.
const handler = toNodeHandler(router);
const server = createServer((request, response) => {
  try {
    sanitizeAuthHeaders(request.headers, request.socket.remoteAddress, config.trustedProxies);
  } catch {
    // A connection with no address of its own cannot be rate limited; it has
    // usually already gone away by the time the request parses.
    response.writeHead(400).end();
    return;
  }
  return handler(request, response);
});
server.listen(config.port, config.bindHost, () => {
  console.log(`[workspace-api] listening on ${config.bindHost}:${config.port} (auth at /api/auth)`);
  console.log(`[workspace-api] email transport: ${config.emailTransport}`);
  if (config.testAuthSeam) console.log("[workspace-api] DOHC_TEST_AUTH seam ENABLED (dev/test only)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
