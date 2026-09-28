import {parsePublicEditRelease} from "@dohc/security-contract";
import { APP_PUBLICATION_MAX_FILES, APP_PUBLICATION_MAX_METADATA_BYTES, APP_PUBLICATION_MAX_BUNDLE_BYTES } from "@dohc/security-contract/app-publication";
import { createWorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import { createSessionActorResolver, UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fatal,
  installShutdown,
  jsonResponse,
  parseGracePeriodMs,
  serveFetchHandler,
} from "@dohc/service-http";
import { Pool } from "pg";
import { compileDatasetOperations } from "./datasetCompiler";
import { createVerifiedEmailLookups } from "./verifiedEmailLookups";
import { errorBody, errorResponse } from "./errors";
import { RELAY_API_VERSIONS, relayApiVersionRefusal } from "./apiVersion";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { PresenceHub } from "./presence";
import { MAX_BLOB_BYTES, createSyncRelayHandler, streamsRequestBody } from "./server";
import type { OwnerRestoreHost } from "./ownerRestoreRoutes";
import { automationHostMaxBodyBytes } from "./automationHostRoutes";
import { isAutomationPressPath, pruneAutomationPresses } from "./automationPressRoutes";
import { AUTOMATION_PRESS_MAX_BODY_BYTES } from "@dohc/workspace-contracts/relay";
import { parseNamedLiveBrowserHttpLimits, type NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import { DEFAULT_WORKSPACE_QUOTA_BYTES, openSyncRelayStorage } from "./storage";
import { createDeviceControl } from "./deviceControl";
import {readOwnerAdmissionConfig,startOwnerAdmission} from "./ownerAdmissionConfig";
import {liveValidation} from "./liveValidation.js";
import {readRelayDeviceDeliveryConfig} from "./deviceLiveHostConfig";
import {parseDeviceControlLimits} from "@dohc/live-session-contract/device-control";
import { openRelayDeployment } from "./relayDeployment";
import { guardRelayResponses } from "./relayResponseStanding";
import { startServiceLiveHost } from "./serviceLiveHost";
import { parseNamedLiveConfig } from "./namedLiveConfig";
import { readAppBackendParticipantLimit, readAppCollectionPolicy, readAppPublicationConfig } from "./appPublicationConfig";
import { createNamedFrameChanges } from "./liveHostChanges";
import { createOwnerLiveRoutes, createNamedLiveRoutes } from "./namedLiveRoutes";
import { createLiveTickets } from "./liveTickets";
import { createLiveHostReports } from "./namedLiveHostReports";
import {createLinkLiveBrowserResolver} from "./linkLiveBrowserAuth";
import {normalizeLinkRefusal, opaqueLinkRefusal} from "./linkRefusal";
import {createLinkLiveHttp} from "./linkLiveHttp";
import {createLiveMembershipRegistry} from "./liveMembership";
import {createLiveConnectionAdmission} from "./liveConnectionAdmission";
import {createNamedDesktopLive} from "./namedDesktopLive";
import {parseNamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import type { NamedFrameNativeHost } from "./namedLiveFrameHost";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import {createServiceHostEnrollmentRoutes} from "./serviceHostEnrollmentRoutes";
import {createServiceHostReplication} from "./serviceHostReplication";

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
const selfHostedLive = process.env.DOHC_SELF_HOST_LIVE === "1";
if (process.env.DOHC_SELF_HOST_LIVE !== undefined && !["0", "1"].includes(process.env.DOHC_SELF_HOST_LIVE)) fatal("FATAL: DOHC_SELF_HOST_LIVE must be 0 or 1.");
const liveProfile = selfHostedLive ? selfHostLiveProfile() : undefined;
if (selfHostedLive && (process.env.DOHC_RELAY_SERVICE_HOST_CONFIG || process.env.DOHC_RELAY_DEVICE_DELIVERY_CONFIG || process.env.DOHC_DEVICE_CONTROL_LIMITS)) {
  fatal("FATAL: The self-host live service cannot replace a manually configured service or device host.");
}

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

const publicEditRelease = parsePublicEditRelease(process.env.DOHC_PUBLIC_EDIT_RELEASE === undefined ? (selfHostedLive ? {version: 1} : undefined) : JSON.parse(process.env.DOHC_PUBLIC_EDIT_RELEASE));
const appPublicationLimits = (() => {
  try { return readAppPublicationConfig(process.env.DOHC_RELAY_APP_PUBLICATIONS); }
  catch { fatal("FATAL: DOHC_RELAY_APP_PUBLICATIONS must be 0 or 1."); }
})();
const appBackendMaxParticipantsPerGrant = (() => {
  try { return readAppBackendParticipantLimit(process.env.DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT); }
  catch (error) { fatal(`FATAL: ${error instanceof Error ? error.message : "invalid app backend participant limit"}`); }
})();
const appCollectionPolicy = (() => {
  try { return readAppCollectionPolicy(process.env.DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT); }
  catch (error) { fatal(`FATAL: ${error instanceof Error ? error.message : "invalid app collection policy"}`); }
})();
if (appCollectionPolicy && !appPublicationLimits) {
  fatal("FATAL: App collections require DOHC_RELAY_APP_PUBLICATIONS=1.");
}
const namedBrowserSessionLimits = loadNamedBrowserSessionLimits();
const namedLiveConfig = (() => {
  const value = process.env.DOHC_RELAY_NAMED_LIVE_CONFIG ?? (liveProfile && JSON.stringify(liveProfile.namedLive));
  if (value === undefined) return undefined;
  if (!namedBrowserSessionLimits || !shareWebOrigin || !relayExchangeKey || !linkKey || !process.env.DOHC_RELAY_NAMED_LIVE_HOSTS) {
    fatal("FATAL: Named live routes require browser sessions, viewer origin, relay exchange and link keys, and explicit relay Host values.");
  }
  try { return parseNamedLiveConfig(JSON.parse(value)); }
  catch { fatal("FATAL: DOHC_RELAY_NAMED_LIVE_CONFIG must provide every named live budget and validation policy."); }
})();
const frameChanges = namedLiveConfig ? createNamedFrameChanges(namedLiveConfig.maxListeners) : undefined;
const linkLiveEnabled = process.env.DOHC_RELAY_LINK_LIVE === "1" || (selfHostedLive && process.env.DOHC_RELAY_LINK_LIVE === undefined);
if (process.env.DOHC_RELAY_LINK_LIVE !== undefined && !["0", "1"].includes(process.env.DOHC_RELAY_LINK_LIVE)) fatal("FATAL: DOHC_RELAY_LINK_LIVE must be 0 or 1.");
if (linkLiveEnabled && !namedLiveConfig) fatal("FATAL: Link live routes require configured live admission limits.");
const desktopEditorLimits = (() => {
  const value = process.env.DOHC_RELAY_NAMED_EDITOR_LIMITS ?? (liveProfile && JSON.stringify(liveProfile.editor));
  if (value === undefined) return undefined;
  if (!namedLiveConfig || !namedBrowserSessionLimits) fatal("FATAL: Desktop live editing requires configured named live routes.");
  try {
    const limits = parseNamedLiveBrowserLimits(JSON.parse(value));
    if (limits.provider.frames.receive.maxFrameBytes > namedLiveConfig.frames.receive.maxFrameBytes) throw Error();
    return limits;
  } catch {fatal("FATAL: DOHC_RELAY_NAMED_EDITOR_LIMITS must provide bounded editor limits within relay frame capacity.");}
})();
const dbPath = process.env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite");
const deploymentConfig = process.env.DOHC_RELAY_DEPLOYMENT_CONFIG;
if (!isDevOrTest && !deploymentConfig) fatal("FATAL: DOHC_RELAY_DEPLOYMENT_CONFIG must name an initialized deployment outside development/test.");
if (deploymentConfig && process.env.SYNC_RELAY_DB_PATH !== undefined) fatal("FATAL: The deployment config owns the relay database path. Remove SYNC_RELAY_DB_PATH.");
const storageOptions = { workspaceQuotaBytes, ...(namedLiveConfig ? { liveTickets: { ...namedLiveConfig.tickets, now: Date.now } } : {}) };
const deployment = deploymentConfig ? openRelayDeployment(deploymentConfig, storageOptions) : undefined;
const storage = deployment?.storage ?? openSyncRelayStorage(dbPath, storageOptions);
// Worker files are disposable materializations. The relay database retains authority and recovery history.
const datasetDirectory = deployment?.datasetDirectory ?? await mkdtemp(join(tmpdir(), "dohc-relay-datasets-"));
const datasetHost = await storage.createDatasetHost({directory: datasetDirectory, limits: appPublicationLimits ?? {
  maxFiles: APP_PUBLICATION_MAX_FILES, maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES, maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
}, maxParticipantsPerGrant: appBackendMaxParticipantsPerGrant, compileOperations: compileDatasetOperations, startupExclusive: Boolean(deployment), onShutdownError(error) { console.error("[sync-relay] dataset shutdown failed", error); }});

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
const resolveAccountActor: ResolveActor = testAuthSeam
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

const resolveActor = resolveAccountActor;
const serviceReplication = selfHostedLive && deployment && linkKey
  ? createServiceHostReplication({storage, key: Buffer.from(linkKey), namespace: deployment.history.namespace}) : undefined;

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

let ownerRestoreHost: (() => OwnerRestoreHost | undefined) | undefined;
const relayApplication = createSyncRelayHandler({
  ownerRestoreHost: () => ownerRestoreHost?.(),
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
  publicEditRelease,
  appPublicationLimits,
  datasetHost,
  appCollectionPolicy,
});
let namedLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let linkLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let linkLiveHttp: ReturnType<typeof createLinkLiveHttp> | undefined;
let desktopLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let desktopAdmission: ReturnType<typeof createNamedDesktopLive> | undefined;
let serviceEnrollment: ReturnType<typeof createServiceHostEnrollmentRoutes> | undefined;
const linkLivePaths = new Set(["/sync/live/link-tickets", "/sync/live/link-session", "/sync/live/link-document"]);
const relayHandler = guardRelayResponses(storage, request => {
  const path = new URL(request.url).pathname;
  if (request.headers.get("authorization")?.startsWith("Bearer dohc-service-v1.")) return serviceReplication?.(request) ?? Promise.resolve(Response.json({ok: false, error: "not found"}, {status: 404}));
  if (/^\/sync\/[^/]+\/live-host$/.test(path)) return serviceEnrollment?.(request) ?? Promise.resolve(Response.json({ok: false, error: "not found"}, {status: 404}));
  if (path === "/sync/live/named-tickets") return namedLive?.handle(request) ?? Promise.resolve(Response.json({ok: false, error: "not found"}, {status: 404}));
  if (path === "/sync/live/desktop-open") return desktopAdmission?.handle(request) ?? Promise.resolve(Response.json({ok: false, error: "not found"}, {status: 404}));
  if (linkLivePaths.has(path)) return (path === "/sync/live/link-tickets" ? linkLive?.handle(request) : linkLiveHttp?.(request)) ?? Promise.resolve(Response.json({ok: false, error: "not found"}, {status: 404}));
  return relayApplication(request);
});
const fetchHandler = async (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname === "/ready") {
    const ready = !storage.unavailable.aborted && (!selfHostedLive || (!!selfHost && !selfHost.unavailable));
    return Response.json({ok: ready, service: "sync-relay", selfHostedLive: selfHostedLive && ready, apiVersions: RELAY_API_VERSIONS},
      {status: ready ? 200 : 503, headers: {"cache-control": "no-store"}});
  }
  if (new URL(request.url).pathname === "/health") {
    // The presence hub footprint is exposed only under the dev/test seam so
    // integration tests can assert parked waiters are released on disconnect;
    // production health stays a bare liveness probe.
    return Response.json({
      ok: !storage.unavailable.aborted,
      service: "sync-relay",
      ...(testAuthSeam ? { presence: presence.stats() } : {}),
    }, { status: storage.unavailable.aborted ? 503 : 200 });
  }
  const refusal = relayApiVersionRefusal(request.headers);
  const result = refusal ? errorResponse(refusal) : await relayHandler(request);
  const path = new URL(request.url).pathname;
  return /^\/sync\/link(?:[/-]|$)/.test(path) || linkLivePaths.has(path) ? normalizeLinkRefusal(result, linkLivePaths.has(path)) : result;
};

// Headroom over the blob cap so a maximal valid blob PUT still passes; the
// adapter refuses anything larger as it arrives, before it is buffered.
const MAX_BODY_BYTES = MAX_BLOB_BYTES + 1024 * 1024;
const MAX_LINK_EXCHANGE_BODY_BYTES = 4096;

function loadNamedBrowserSessionLimits(): NamedLiveBrowserHttpLimits | undefined {
  const value = process.env.DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS ?? (liveProfile && JSON.stringify(liveProfile.browserSessions));
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

// Presses from shared views go when their retention ends, whether or not
// more arrive or any host lists them.
const AUTOMATION_PRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  try {
    storage.purgeExpiredShareRemovals(Date.now());
  } catch (error) {
    console.error("[sync-relay] share removal prune failed:", error);
  }
  pruneAutomationPresses(storage, Date.now()).catch((error: unknown) => {
    console.error("[sync-relay] automation press prune failed:", error);
  });
}, AUTOMATION_PRESS_PRUNE_INTERVAL_MS).unref();

const server = serveFetchHandler({
  handler: fetchHandler,
  streamBody: streamsRequestBody,
  maxBodyBytes: (url) => automationHostMaxBodyBytes(url.pathname) ?? (
    /^\/sync\/[^/]+\/live-host$/.test(url.pathname) ? 16 * 1024 :
    isAutomationPressPath(url.pathname) ? AUTOMATION_PRESS_MAX_BODY_BYTES :
    url.pathname === "/sync/live/desktop-open" && namedBrowserSessionLimits ? namedBrowserSessionLimits.maxRequestBytes :
    (url.pathname === "/sync/live/named-tickets" || linkLivePaths.has(url.pathname)) && namedLiveConfig ? namedLiveConfig.transport.maxRequestBytes :
    isNamedBrowserSessionPath(url.pathname) && namedBrowserSessionLimits ? namedBrowserSessionLimits.maxRequestBytes :
    isLinkExchangePath(url.pathname) || isLinkRefreshPath(url.pathname)
      ? MAX_LINK_EXCHANGE_BODY_BYTES
      : MAX_BODY_BYTES),
  oversized: (url) =>
    /^\/sync\/link(?:[/-]|$)/.test(url.pathname) || linkLivePaths.has(url.pathname) ? opaqueLinkRefusal() :
    url.pathname === "/sync/live/desktop-open" || url.pathname === "/sync/live/named-tickets" || linkLivePaths.has(url.pathname) || isNamedBrowserSessionPath(url.pathname) || isLinkExchangePath(url.pathname) || isLinkRefreshPath(url.pathname)
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
const deviceDeliveryConfig = process.env.DOHC_RELAY_DEVICE_DELIVERY_CONFIG;
const ownerAdmissionPath = process.env.DOHC_RELAY_OWNER_ADMISSION_CONFIG;
if (ownerAdmissionPath && !deviceDeliveryConfig) fatal("FATAL: Private owner admission requires configured device delivery.");
let ownerAdmission: ReturnType<typeof readOwnerAdmissionConfig> | undefined;
if (deviceDeliveryConfig && (!deployment || process.env.DOHC_DEVICE_CONTROL_LIMITS === undefined)) fatal("FATAL: Device delivery requires an initialized deployment and device control limits.");
if (process.env.DOHC_DEVICE_CONTROL_LIMITS !== undefined) {
  try {
    const limits = parseDeviceControlLimits(JSON.parse(process.env.DOHC_DEVICE_CONTROL_LIMITS));
    const delivery = deviceDeliveryConfig ? readRelayDeviceDeliveryConfig(deviceDeliveryConfig,limits) : undefined;
    if (ownerAdmissionPath && delivery) ownerAdmission = readOwnerAdmissionConfig(ownerAdmissionPath,delivery.workspaceIds);
    deviceControl = createDeviceControl({
      storage, relayExchangeKey: relayExchangeKey ?? "",
      hosts: new Set((process.env.DOHC_RELAY_DEVICE_CONTROL_HOSTS ?? "").split(",")),
      limits,
      ...(delivery && deployment ? { delivery: { config: delivery, history: deployment.history,ownerAdmission: ownerAdmission?.admission, frameChanges } } : {}),
    });
  } catch (error) {
    fatal(`FATAL: Invalid device control configuration. ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (deviceControl) {
  server.on("upgrade", (request, socket, head) => {
    if (namedLiveConfig && (request.url?.startsWith("/sync/live/named?") || request.url?.startsWith("/sync/live/link?") || request.url?.startsWith("/sync/live/desktop?") || /^\/sync\/workspaces\/[^/]+\/live\/owner(?:\?|$)/.test(request.url ?? ""))) return;
    deviceControl!.handleUpgrade(request, socket, head);
  });
  process.once("SIGINT", deviceControl.close);
  process.once("SIGTERM", deviceControl.close);
  server.once("close", deviceControl.close);
}
const ownerAdmissionRun = ownerAdmission && deviceControl && deployment ? startOwnerAdmission({config: ownerAdmission,storage,history: deployment.history,control: deviceControl,
  onError: error => console.error("[sync-relay] private owner delivery:",error)}) : undefined;
server.once("close",() => ownerAdmissionRun?.close());
process.once("SIGINT",() => ownerAdmissionRun?.close());
process.once("SIGTERM",() => ownerAdmissionRun?.close());
const serviceHostConfig = process.env.DOHC_RELAY_SERVICE_HOST_CONFIG;
if (serviceHostConfig && !deployment) fatal("FATAL: A service host requires an initialized relay deployment.");
const configuredServiceHost = serviceHostConfig && deployment
  ? await startServiceLiveHost({ configPath: serviceHostConfig, storage, history: deployment.history, frameChanges })
  : undefined;
if (selfHostedLive && (!deployment || !frameChanges || !linkKey || !process.env.DOHC_RELAY_SERVICE_HOST_ROOT || !process.env.DOHC_RELAY_ENGINE_EXECUTABLE || !process.env.DOHC_RELAY_PUBLIC_ORIGIN)) {
  fatal("FATAL: Self-host live editing requires a deployment, a persistent host root, the native engine executable, and the public HTTPS relay origin.");
}
const selfHost = selfHostedLive ? await startSelfHostedLiveHost({storage, history: deployment!.history, frameChanges: frameChanges!,
  root: process.env.DOHC_RELAY_SERVICE_HOST_ROOT!, engineExecutable: process.env.DOHC_RELAY_ENGINE_EXECUTABLE!,
  relayOrigin: process.env.DOHC_RELAY_PUBLIC_ORIGIN!, key: Buffer.from(linkKey!),
  onError: error => console.error("[sync-relay] self-host live service:", error)}) : undefined;
const serviceHost = () => selfHost?.current() ?? configuredServiceHost;
if (selfHost && deployment) serviceEnrollment = createServiceHostEnrollmentRoutes({storage, history: deployment.history, host: selfHost, resolveActor: resolveAccountActor});
ownerRestoreHost = () => {
  const mode = storage.getLiveHostControl()?.configuredMode;
  return mode === "service" ? serviceHost() : mode === "device" ? deviceControl : undefined;
};
if (publicEditRelease) {
  const mode = storage.getLiveHostControl()?.configuredMode;
  if (!linkLiveEnabled || !namedLiveConfig || (mode === "service" ? (!configuredServiceHost && !selfHost) : mode === "device" ? (!deviceControl || !deviceDeliveryConfig || !ownerAdmission) : true)) {
    fatal("FATAL: Public Edit release requires link live routes and the configured service host or device delivery with owner admission.");
  }
}
if (namedLiveConfig) {
  if (!configuredServiceHost && !selfHost && !deviceControl) fatal("FATAL: Named live routes require an authenticated service or device host.");
  const captureNative = async (binding: LiveObjectBinding, signal: AbortSignal): Promise<NamedFrameNativeHost> => {
    const mode = storage.getLiveHostControl()?.configuredMode;
    const host = mode === "service" ? serviceHost() : mode === "device" ? deviceControl : undefined;
    if (!host) throw new Error("Named live host is unavailable.");
    return host.captureNative(binding, signal);
  };
  const tickets = createLiveTickets({ storage, audience: shareWebOrigin!, key: linkKey!, hostReports: createLiveHostReports({ storage, captureNative }) });
  const admission = createLiveConnectionAdmission();
  const membership = createLiveMembershipRegistry({maxSessions: namedLiveConfig.transport.maxConnections, maxMembers: namedLiveConfig.transport.maxConnections,
    maxSnapshotBytes: namedLiveConfig.frames.receive.maxFrameBytes}, storage.readLiveAuthority.bind(storage));
  namedLive = createNamedLiveRoutes({ kind: "named", storage, hosts: new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(",")),
    publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedLiveConfig.transport,
    frames: namedLiveConfig.frames, bounds: namedLiveConfig.host, validate: namedLiveConfig.validate,
    sessions: { resolve: relayApplication.resolveNamedBrowserSession }, tickets, captureNative, membership, admission });
  if (linkLiveEnabled && publicEditRelease) {
    const hosts = new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(","));
    linkLive = createNamedLiveRoutes({kind: "link", storage, hosts, publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedLiveConfig.transport,
      frames: namedLiveConfig.frames, bounds: namedLiveConfig.host, validate: namedLiveConfig.validate,
      sessions: createLinkLiveBrowserResolver({storage, linkKey: linkKey!}), tickets, captureNative, membership, admission});
    linkLiveHttp = createLinkLiveHttp({storage, hosts, publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedLiveConfig.transport, linkKey: linkKey!});
    server.once("close", linkLive.close); process.once("SIGINT", linkLive.close); process.once("SIGTERM", linkLive.close);
  }
  if (desktopEditorLimits) {
    const hosts = new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(","));
    desktopAdmission = createNamedDesktopLive({storage, resolveActor, publicOrigin: shareWebOrigin!, hosts,
      limits: namedBrowserSessionLimits!, editorLimits: desktopEditorLimits, tickets});
    desktopLive = createNamedLiveRoutes({kind: "named", desktopBearer: true, storage, hosts,
      publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedLiveConfig.transport,
      frames: namedLiveConfig.frames, bounds: namedLiveConfig.host, validate: namedLiveConfig.validate,
      sessions: desktopAdmission, tickets, captureNative, membership, admission});
    server.once("close", desktopLive.close); process.once("SIGINT", desktopLive.close); process.once("SIGTERM", desktopLive.close);
  }
  const ownerLive = createOwnerLiveRoutes({ storage, resolveActor, hosts: new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(",")),
    publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedLiveConfig.transport,
    frames: namedLiveConfig.frames, bounds: namedLiveConfig.host, validate: namedLiveConfig.validate, captureNative, admission });
  server.once("close", ownerLive.close);
  process.once("SIGINT", ownerLive.close); process.once("SIGTERM", ownerLive.close);
  server.on("upgrade", (request, socket, head) => {
    if (/^\/sync\/workspaces\/[^/]+\/live\/owner(?:\?|$)/.test(request.url ?? "")) void ownerLive.handleUpgrade(request, socket, head);
    else if (request.url?.startsWith("/sync/live/named?")) void namedLive!.handleUpgrade(request, socket, head);
    else if (request.url?.startsWith("/sync/live/link?")) {if (linkLive) void linkLive.handleUpgrade(request, socket, head); else socket.destroy();}
    else if (request.url?.startsWith("/sync/live/desktop?")) {if (desktopLive) void desktopLive.handleUpgrade(request, socket, head); else socket.destroy();}
    else if (!deviceControl) socket.destroy();
  });
  server.once("close", namedLive.close);
  process.once("SIGINT", namedLive.close); process.once("SIGTERM", namedLive.close);
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
    await selfHost?.close();
    await configuredServiceHost?.close();
    await liveValidation.close();
    await datasetHost?.close();
    if (!deployment) await rm(datasetDirectory, {recursive: true, force: true, maxRetries: 8, retryDelay: 25});
    storage.close();
    try {
      await pool?.end();
    } finally {
      process.exit(0);
    }
  },
});
