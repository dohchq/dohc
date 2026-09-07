import { createWorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import { createSessionActorResolver, UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fatal,
  installShutdown,
  jsonResponse,
  parseGracePeriodMs,
  serveFetchHandler,
} from "@dohc/service-http";
import { Pool } from "pg";
import { createVerifiedEmailLookups } from "./verifiedEmailLookups";
import { errorBody } from "./errors";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { PresenceHub } from "./presence";
import { MAX_BLOB_BYTES, createSyncRelayHandler } from "./server";
import { parseNamedLiveBrowserHttpLimits, type NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import { DEFAULT_WORKSPACE_QUOTA_BYTES, openSyncRelayStorage } from "./storage";
import { parseDeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { createDeviceControl } from "./deviceControl";

const SHUTDOWN_GRACE_PERIOD_MS = parseGracePeriodMs(
  process.env.NODE_ENV === "test" ? process.env.SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS : undefined,
  10_000,
);
const requestedPort = process.env.SYNC_RELAY_PORT === undefined ? 1788 : Number(process.env.SYNC_RELAY_PORT);
const workspaceQuotaBytes =
  process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES === undefined
    ? DEFAULT_WORKSPACE_QUOTA_BYTES
    : Number(process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES);
const defaultPostgresUrl = "postgres://dohc:dohc@localhost:54329/dohc";
const secret = process.env.BETTER_AUTH_SECRET ?? "";
const nodeEnv = process.env.NODE_ENV;
const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";
const testAuthSeam = process.env.SYNC_RELAY_TEST_AUTH === "1" && isDevOrTest;
const linkKey = process.env.DOHC_RELAY_LINK_KEY;
const relayExchangeKey = process.env.DOHC_RELAY_EXCHANGE_KEY;
const relayExchangeKeyHash =
  relayExchangeKey === undefined ? undefined : hashRelayExchangeKey(relayExchangeKey);

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]"
  );
}

function validateShareWebOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    if (!isDevOrTest) {
      fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be set outside development/test.");
    }
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an absolute HTTP(S) origin.");
  }
  if (
    value.trim() !== value ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    value.includes("@") ||
    parsed.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an origin without credentials, a path, a query, or a fragment.",
    );
  }
  if (!isDevOrTest && parsed.protocol !== "https:") {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS outside development/test.");
  }
  if (isDevOrTest && parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS unless its HTTP hostname is loopback in development/test.",
    );
  }
  return parsed.origin;
}

const shareWebOrigin = validateShareWebOrigin(process.env.DOHC_RELAY_SHARE_WEB_ORIGIN);

// Reject an unparseable SYNC_RELAY_PORT up front: Number("abc") is NaN and
// server.listen(NaN) fails with an obscure downstream error. Port 0 is
// allowed (bind an ephemeral port, used by the integration harness).
if (
  process.env.SYNC_RELAY_PORT !== undefined &&
  (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
) {
  fatal(
    `FATAL: SYNC_RELAY_PORT must be an integer in 0-65535, got "${process.env.SYNC_RELAY_PORT}".`,
  );
}

if (
  process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES !== undefined &&
  (!Number.isInteger(workspaceQuotaBytes) || workspaceQuotaBytes <= 0)
) {
  fatal(
    `FATAL: SYNC_RELAY_WORKSPACE_QUOTA_BYTES must be a positive integer, got "${process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES}".`,
  );
}

// In production the relay reuses workspace-api's Postgres for session and
// share-account lookups. Falling back to a localhost default there would
// silently point auth at the wrong database; fail fast instead. The default
// stays available for dev/test convenience only.
if (!isDevOrTest && !testAuthSeam && process.env.POSTGRES_URL === undefined) {
  fatal(
    "FATAL: POSTGRES_URL must be set outside development/test (it must match workspace-api's database).",
  );
}

if (!isDevOrTest && !linkKey) {
  fatal("FATAL: DOHC_RELAY_LINK_KEY must be set outside development/test.");
}

if (!isDevOrTest && !relayExchangeKey) {
  fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be set outside development/test.");
}

if (relayExchangeKey !== undefined && relayExchangeKey.length < 32) {
  fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be at least 32 characters.");
}

if (process.env.SYNC_RELAY_TEST_AUTH === "1" && !isDevOrTest) {
  fatal(
    `FATAL: SYNC_RELAY_TEST_AUTH=1 requires NODE_ENV=development or test, got NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
      "This fake bearer seam is test-only — refusing to start.",
  );
}

if (!testAuthSeam && secret.length < 32) {
  fatal(
    "BETTER_AUTH_SECRET must be set (>=32 chars) and must match workspace-api's secret.",
  );
}

const namedBrowserSessionLimits = loadNamedBrowserSessionLimits();
const dbPath = process.env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite");
const storage = openSyncRelayStorage(dbPath, { workspaceQuotaBytes });

// Production auth intentionally reuses workspace-api's Better Auth database
// and BETTER_AUTH_SECRET. A bearer token minted by workspace-api's desktop
// device flow is valid here only when POSTGRES_URL and BETTER_AUTH_SECRET
// match that service exactly; the relay has no separate login system.
let pool: Pool | undefined;
// Share-grant account lookups: production resolves against Better
// Auth's user table on the same Postgres the session check uses; the test
// seam maps "<userId>@dohc.test" <-> "<userId>" so share E2E can address
// recipients by email without a user database.
const TEST_EMAIL_SUFFIX = "@dohc.test";
let resolveUserIdByEmail: (email: string) => Promise<string | null> | string | null;
let lookupUserEmail: (userId: string) => Promise<string | null> | string | null;
let lookupVerifiedUserEmail: (userId: string) => Promise<string | null> | string | null;
let lookupUserDisplayName: (
  userId: string,
) => Promise<string | null> | string | null;
const resolveActor: ResolveActor = testAuthSeam
  ? createTestActorResolver()
  : (() => {
      pool = new Pool({
        connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
      });
      // pg pools emit 'error' for idle-client failures (Postgres restart,
      // network partition). Without a listener that is an uncaught 'error'
      // event and takes the whole relay process down; with one, only the
      // in-flight requests fail (as a 5xx via the handler's error path).
      pool.on("error", (error) => {
        console.error("[sync-relay] postgres pool error", error);
      });
      const auth = createWorkspaceAuth({
        pool,
        baseURL: process.env.SYNC_RELAY_AUTH_BASE_URL ?? `http://localhost:${requestedPort || 1788}`,
        secret,
      });
      return createSessionActorResolver(auth);
    })();

function createTestActorResolver(): ResolveActor {
  return (request, workspaceId) => {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(authorization);
    if (!match) throw new UnauthorizedError();
    return { userId: match[1]!, workspaceId };
  };
}

if (testAuthSeam) {
  resolveUserIdByEmail = (email) =>
    email.endsWith(TEST_EMAIL_SUFFIX) && email.length > TEST_EMAIL_SUFFIX.length
      ? email.slice(0, -TEST_EMAIL_SUFFIX.length)
      : null;
  lookupUserEmail = (userId) => `${userId}${TEST_EMAIL_SUFFIX}`;
  lookupVerifiedUserEmail = lookupUserEmail;
  lookupUserDisplayName = (userId) => userId;
} else {
  // Better Auth's canonical table/column names on the shared Postgres.
  ({ resolveUserIdByEmail, lookupVerifiedUserEmail } = createVerifiedEmailLookups(pool!));
  lookupUserEmail = async (userId) => {
    const result = await pool!.query<{ email: string }>(
      'SELECT email FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.email ?? null;
  };
  lookupUserDisplayName = async (userId) => {
    const result = await pool!.query<{ name: string | null }>(
      'SELECT name FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.name ?? null;
  };
}

// One in-memory presence hub for the whole process: the ephemeral awareness
// transport is never persisted, so it lives only here and is lost on restart
// (by design — presence is not durable).
const presence = new PresenceHub();

const relayHandler = createSyncRelayHandler({
  storage,
  resolveActor,
  resolveUserIdByEmail: (email) => resolveUserIdByEmail(email),
  lookupUserEmail: (userId) => lookupUserEmail(userId),
  lookupVerifiedUserEmail: (userId) => lookupVerifiedUserEmail(userId),
  lookupUserDisplayName: (userId) => lookupUserDisplayName(userId),
  presence,
  linkKey,
  shareWebOrigin,
  relayExchangeKey,
  namedBrowserSessionLimits,
});
const fetchHandler = async (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname === "/health") {
    // The presence hub footprint is exposed only under the dev/test seam so
    // integration tests can assert parked waiters are released on disconnect;
    // production health stays a bare liveness probe.
    return Response.json({
      ok: true,
      service: "sync-relay",
      ...(testAuthSeam ? { presence: presence.stats() } : {}),
    });
  }
  return relayHandler(request);
};

// Headroom over the blob cap so a maximal valid blob PUT still passes; the
// adapter refuses anything larger as it arrives, before it is buffered.
const MAX_BODY_BYTES = MAX_BLOB_BYTES + 1024 * 1024;
const MAX_LINK_EXCHANGE_BODY_BYTES = 4096;

function loadNamedBrowserSessionLimits(): NamedLiveBrowserHttpLimits | undefined {
  const value = process.env.DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS;
  if (value === undefined) return undefined;
  if (!shareWebOrigin || !shareWebOrigin.startsWith("https://")) {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an HTTPS origin when named browser sessions are enabled.");
  }
  if (!relayExchangeKey) {
    fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be set when named browser sessions are enabled.");
  }
  try { return parseNamedLiveBrowserHttpLimits(JSON.parse(value)); }
  catch { fatal("FATAL: DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS must be valid JSON with all required positive limits within their supported bounds, a safe expiry timestamp, and capacity for the named session envelopes."); }
}

function isNamedBrowserSessionPath(pathname: string): boolean {
  return pathname === "/sync/live/named-sessions" || pathname === "/sync/live/named-sessions/resolve";
}

function isLinkExchangePath(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 2 && parts[0] === "sync" && parts[1] === "link-exchange";
  } catch {
    return false;
  }
}

function isLinkRefreshPath(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 2 && parts[0] === "sync" && parts[1] === "link-refresh";
  } catch {
    return false;
  }
}

function presentsValidRelayExchangeKey(headers: Headers): boolean {
  const presented = headers.get("x-dohc-relay-exchange-key");
  return (
    relayExchangeKeyHash !== undefined &&
    verifyRelayExchangeKey(presented, relayExchangeKeyHash)
  );
}

const server = serveFetchHandler({
  handler: fetchHandler,
  maxBodyBytes: (url) =>
    isNamedBrowserSessionPath(url.pathname) && namedBrowserSessionLimits ? namedBrowserSessionLimits.maxRequestBytes :
    isLinkExchangePath(url.pathname) || isLinkRefreshPath(url.pathname)
      ? MAX_LINK_EXCHANGE_BODY_BYTES
      : MAX_BODY_BYTES,
  oversized: (url) =>
    isNamedBrowserSessionPath(url.pathname) || isLinkExchangePath(url.pathname) || isLinkRefreshPath(url.pathname)
      ? errorBody("not_found")
      : errorBody("payload_too_large"),
  // Never echo internal error details (or anything derived from the request)
  // back to the caller.
  failure: () => jsonResponse({ ok: false, error: "internal error" }, 500),
  prepareHeaders: (headers, incoming, url) => {
    // Only the keyed share-web exchange hop can select a forwarded bucket.
    if (
      !isLinkExchangePath(url.pathname) ||
      headers.get("x-dohc-relay-client-ip") === null ||
      !presentsValidRelayExchangeKey(headers)
    ) {
      headers.set("x-dohc-relay-client-ip", incoming.socket.remoteAddress ?? "unknown");
    }
  },
});

const host = testAuthSeam ? "127.0.0.1" : (process.env.SYNC_RELAY_BIND ?? "0.0.0.0");
let deviceControl: ReturnType<typeof createDeviceControl> | undefined;
if (process.env.DOHC_DEVICE_CONTROL_LIMITS !== undefined) {
  try {
    deviceControl = createDeviceControl({
      storage, relayExchangeKey: relayExchangeKey ?? "",
      hosts: new Set((process.env.DOHC_RELAY_DEVICE_CONTROL_HOSTS ?? "").split(",")),
      limits: parseDeviceControlLimits(JSON.parse(process.env.DOHC_DEVICE_CONTROL_LIMITS)),
    });
  } catch {
    fatal("FATAL: Invalid device control configuration. Check DOHC_DEVICE_CONTROL_LIMITS, DOHC_RELAY_DEVICE_CONTROL_HOSTS, and relay exchange key.");
  }
}
if (deviceControl) {
  server.on("upgrade", deviceControl.handleUpgrade);
  process.once("SIGINT", deviceControl.close);
  process.once("SIGTERM", deviceControl.close);
  server.once("close", deviceControl.close);
}
server.listen(requestedPort, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`[sync-relay] listening on ${host}:${actualPort}`);
  console.log(`SYNC_RELAY_LISTENING host=${host} port=${actualPort}`);
  if (testAuthSeam) console.log("[sync-relay] SYNC_RELAY_TEST_AUTH seam ENABLED (dev/test only)");
});

installShutdown(server, {
  gracePeriodMs: SHUTDOWN_GRACE_PERIOD_MS,
  onClosed: async () => {
    storage.close();
    try {
      await pool?.end();
    } finally {
      process.exit(0);
    }
  },
});
