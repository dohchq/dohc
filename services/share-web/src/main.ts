import { createLiveBufferBudget } from "@dohc/live-session-contract/live-connection";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientAddress,
  fatal,
  installShutdown,
  parseGracePeriodMs,
  serveFetchHandler,
  waitsOnQuery,
  withConnectRetry,
} from "@dohc/service-http";
import { createServiceAnalyticsClient } from "@dohc/service-http/telemetry";
import { loadShareWebConfig } from "./config";
import { createDeviceControlBridge } from "./deviceControlBridge";
import { createLiveGateway, namedSessionCheckIntervalMs } from "./liveGateway";
import { createNamedLiveRelayRoute, namedLiveGatewayRequest } from "./namedLiveRelayRoute";
import { ownerLiveSession } from "./liveGatewayRequest";
import { NAMED_COLLECTIONS_API, NAMED_COLLECTIONS_REQUEST_BYTES } from "./namedCollections";
import {
  createShareWebApplication,
  SHARE_WEB_REQUEST_LOG,
  SHARE_WEB_SECURITY_HEADERS,
  shareWebRefusalBody,
  streamsRequestBody,
} from "./server";
import { isMcpCorsPath, MCP_CORS_HEADERS, signInBodyLimit } from "./mcpSignIn";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_PERIOD_MS = parseGracePeriodMs(
  process.env.NODE_ENV === "test"
    ? process.env.DOHC_SHARE_WEB_TEST_SHUTDOWN_GRACE_PERIOD_MS
    : undefined,
  10_000,
);

const config = loadConfig();
// An operator who never ran the upgrade that adds the key would otherwise see link holders signed out with no cause.
if (!config.sessionSealKey && !["development", "test"].includes(process.env.NODE_ENV ?? ""))
  console.warn(
    "[share-web] DOHC_SHARE_WEB_SESSION_SEAL_KEY is not set. Open share pages stop working when share-web restarts.",
  );
const viewerAssetsDir = viewerAssetsDirectory();

try {
  readFileSync(join(viewerAssetsDir, "index.html"));
} catch {
  fatal("share-web viewer assets are missing. Run: pnpm --filter @dohc/share-web build");
}

const analytics = config.analytics
  ? createServiceAnalyticsClient({ service: "share-web", config: config.analytics })
  : null;

const application = createShareWebApplication({
  ...(analytics ? { analytics } : {}),
  deleteAccountGateways(userId, workspaceIds) {
    namedGateway?.deleteAccount(userId, workspaceIds);
    ownerGateway?.deleteAccount(userId, workspaceIds);
    linkGateway?.deleteAccount(userId, workspaceIds);
  },
  appLaunch: config.appLaunch,
  relayUrl: config.relayUrl,
  publicRelayUrl: config.publicRelayUrl,
  relayExchangeKey: config.relayExchangeKey,
  sessionSealKey: config.sessionSealKey,
  publicHosts: config.publicHosts,
  internalHosts: config.internalHosts,
  viewerAssetsDir,
  fetchRelay: withConnectRetry(fetch, { retryRequestBody: true }),
  fetchAuth: withConnectRetry(fetch, { retryRequestBody: true }),
  accountAuth: config.accountAuth,
  namedBrowserSessionLimits: config.namedBrowserSessionLimits,
  namedSessionCheckIntervalMs:
    config.namedLiveGatewayLimits && namedSessionCheckIntervalMs(config.namedLiveGatewayLimits),
  namedLiveTickets: config.namedLiveGatewayLimits !== undefined,
  namedRecipientBrowserLimits: config.namedRecipientBrowserLimits,
  linkLive: config.linkLive,
  publicEditRelease: config.publicEditRelease,
});

const server = serveFetchHandler({
  handler: application.handle,
  requestLog: SHARE_WEB_REQUEST_LOG,
  maxBodyBytes: (url) =>
    signInBodyLimit(url.pathname) ??
    (["/api/live/link-document", "/api/live/link-document-state", "/api/live/link-ticket"].includes(
      url.pathname,
    ) && config.linkLive
      ? config.linkLive.requests.maxRequestBytes
      : url.pathname === NAMED_COLLECTIONS_API && config.namedBrowserSessionLimits
        ? NAMED_COLLECTIONS_REQUEST_BYTES
        : [
              "/api/live/named-session",
              "/api/live/named-ticket",
              "/api/live/named-documents",
              "/api/named-chat/messages",
              "/api/members/join-preview",
              "/api/members/join",
            ].includes(url.pathname) && config.namedBrowserSessionLimits
          ? config.namedBrowserSessionLimits.maxRequestBytes
          : MAX_REQUEST_BODY_BYTES),
  streamBody: streamsRequestBody,
  // A page keeps a read open for up to 30 s to hear of a change: the log, chat, comment activity, and a shared app's
  // Collection.
  waits: (url, method) =>
    waitsOnQuery("hold")(url, method) || (method === "POST" && url.pathname === "/events"),
  oversized: (url) =>
    url.pathname === "/api/named-chat/messages"
      ? Response.json(
          { ok: false, error: "Post is too large.", code: "payload_too_large" },
          { status: 413, headers: { "cache-control": "private, no-store" } },
        )
      : isMcpCorsPath(url.pathname)
        ? mcpReadable(
            url,
            Response.json(
              { error: "invalid_request", error_description: "The request is too large." },
              { status: 413, headers: SHARE_WEB_SECURITY_HEADERS },
            ),
          )
        : refusal(),
  failure: (url) => mcpReadable(url, refusal()),
  timedOut: (url) =>
    mcpReadable(url, new Response(null, { status: 408, headers: SHARE_WEB_SECURITY_HEADERS })),
  prepareHeaders: (headers, incoming) => {
    headers.set(
      "x-dohc-share-web-client-ip",
      clientAddress(
        incoming.socket.remoteAddress,
        headers.get("x-forwarded-for"),
        config.trustedProxies,
      ),
    );
  },
});

let deviceControl: ReturnType<typeof createDeviceControlBridge> | undefined;
if (process.env.DOHC_DEVICE_CONTROL_LIMITS !== undefined) {
  try {
    deviceControl = createDeviceControlBridge({
      publicHosts: config.publicHosts,
      relayUrl: config.relayUrl,
      relayExchangeKey: config.relayExchangeKey ?? "",
      limits: JSON.parse(process.env.DOHC_DEVICE_CONTROL_LIMITS),
      admission: JSON.parse(process.env.DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION ?? "null"),
      trustedProxies: config.trustedProxies,
    });
  } catch {
    fatal(
      "FATAL: Invalid device control configuration. Check DOHC_DEVICE_CONTROL_LIMITS, DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION, and relay settings.",
    );
  }
}
const gatewayBufferMaximum =
  config.namedLiveGatewayLimits?.maxBufferedBytes ?? config.linkLive?.gateway.maxBufferedBytes;
const gatewayBuffers =
  gatewayBufferMaximum === undefined ? undefined : createLiveBufferBudget(gatewayBufferMaximum);
function accountGateway(limits: NonNullable<typeof config.namedLiveGatewayLimits>, owner: boolean) {
  const gateway = createLiveGateway({
    bufferBudget: gatewayBuffers,
    publicHosts: config.publicHosts,
    publicOrigin: config.accountAuth!.publicOrigin,
    ...(owner ? { path: "/api/live/owner" as const } : {}),
    limits,
    resolveSession(request, discriminator, signal) {
      const authenticated = namedLiveGatewayRequest(
        request,
        config.accountAuth!.publicOrigin,
        signal,
      );
      if (authenticated && owner) return Promise.resolve(ownerLiveSession(discriminator));
      return authenticated
        ? application.resolveNamedBrowserSession(authenticated, discriminator)
        : Promise.resolve(null);
    },
    openHostRoute: createNamedLiveRelayRoute({
      relayUrl: config.relayUrl,
      publicOrigin: config.accountAuth!.publicOrigin,
      exchangeKey: config.relayExchangeKey!,
      handshakeTimeoutMs: limits.upgradeTimeoutMs,
      owner,
    }),
  });
  process.once("SIGINT", gateway.close);
  process.once("SIGTERM", gateway.close);
  server.once("close", gateway.close);
  return gateway;
}
let namedGateway: ReturnType<typeof createLiveGateway> | undefined,
  ownerGateway: typeof namedGateway;
if (config.namedLiveGatewayLimits) {
  ownerGateway = accountGateway(config.namedLiveGatewayLimits, true);
  namedGateway = accountGateway(config.namedLiveGatewayLimits, false);
}
const linkGateway =
  config.linkLive && application.linkLive
    ? createLiveGateway({
        bufferBudget: gatewayBuffers,
        publicHosts: config.publicHosts,
        publicOrigin: config.linkLive.publicOrigin,
        path: "/api/live/link",
        limits: config.linkLive.gateway,
        resolveSession: application.linkLive.resolveSession,
        openHostRoute: application.linkLive.openHostRoute,
      })
    : undefined;
if (linkGateway) {
  process.once("SIGINT", linkGateway.close);
  process.once("SIGTERM", linkGateway.close);
  server.once("close", linkGateway.close);
}
if (deviceControl || namedGateway || linkGateway)
  server.on("upgrade", (request, socket, head) => {
    if (request.url?.startsWith("/api/live/link?")) {
      if (linkGateway) void linkGateway.handleUpgrade(request, socket, head);
      else socket.destroy();
    } else if (request.url?.startsWith("/api/live/owner?")) {
      if (ownerGateway) void ownerGateway.handleUpgrade(request, socket, head);
      else socket.destroy();
    } else if (request.url?.startsWith("/api/live?")) {
      if (namedGateway) void namedGateway.handleUpgrade(request, socket, head);
      else socket.destroy();
    } else if (deviceControl) deviceControl.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
if (deviceControl) {
  process.once("SIGINT", deviceControl.close);
  process.once("SIGTERM", deviceControl.close);
  server.once("close", deviceControl.close);
}

server.listen(config.port, config.bind, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  console.log(`[share-web] listening on ${config.bind}:${actualPort}`);
  console.log(`SHARE_WEB_LISTENING host=${config.bind} port=${actualPort}`);
  if (config.devMode) console.log("[share-web] development mode enabled");
});

installShutdown(server, {
  gracePeriodMs: SHUTDOWN_GRACE_PERIOD_MS,
  onClosed: async () => {
    try {
      await analytics?.flush();
    } finally {
      process.exit(0);
    }
  },
});

function loadConfig() {
  try {
    return loadShareWebConfig(process.env);
  } catch (error) {
    fatal(`FATAL: ${error instanceof Error ? error.message : "invalid share-web configuration"}`);
  }
}

function viewerAssetsDirectory(): string {
  if (process.env.NODE_ENV === "test") {
    const testDirectory = process.env.DOHC_SHARE_WEB_TEST_VIEWER_ASSETS_DIR;
    if (testDirectory) return testDirectory;
  }
  return fileURLToPath(new URL("../viewer/dist", import.meta.url));
}

function refusal(): Response {
  return new Response(shareWebRefusalBody, {
    status: 404,
    headers: { "content-type": "application/json", ...SHARE_WEB_SECURITY_HEADERS },
  });
}

// A browser MCP client reads every answer on its paths, so this server's own
// answers carry CORS there too. A token answer is never cached.
function mcpReadable(url: URL, answer: Response): Response {
  if (!isMcpCorsPath(url.pathname)) return answer;
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) answer.headers.set(name, value);
  if (url.pathname === "/oauth/token") answer.headers.set("pragma", "no-cache");
  return answer;
}
