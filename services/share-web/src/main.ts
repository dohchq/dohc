import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fatal,
  installShutdown,
  parseGracePeriodMs,
  serveFetchHandler,
} from "@dohc/service-http";
import { loadShareWebConfig } from "./config";
import { createDeviceControlBridge } from "./deviceControlBridge";
import {createLiveGateway} from "./liveGateway";
import {createNamedLiveRelayRoute, namedLiveGatewayRequest} from "./namedLiveRelayRoute";
import { clientAddress } from "./clientAddress";
import {
  createShareWebApplication,
  SHARE_WEB_SECURITY_HEADERS,
  shareWebRefusalBody,
} from "./server";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_PERIOD_MS = parseGracePeriodMs(
  process.env.NODE_ENV === "test"
    ? process.env.DOHC_SHARE_WEB_TEST_SHUTDOWN_GRACE_PERIOD_MS
    : undefined,
  10_000,
);

const config = loadConfig();
const viewerAssetsDir = viewerAssetsDirectory();

try {
  readFileSync(join(viewerAssetsDir, "index.html"));
} catch {
  fatal(
    "share-web viewer assets are missing. Run: pnpm --filter @dohc/share-web build",
  );
}

const application = createShareWebApplication({
  relayUrl: config.relayUrl,
  publicRelayUrl: config.publicRelayUrl,
  relayExchangeKey: config.relayExchangeKey,
  publicHosts: config.publicHosts,
  viewerAssetsDir,
  accountAuth: config.accountAuth,
  namedBrowserSessionLimits: config.namedBrowserSessionLimits,
  namedLiveTickets: config.namedLiveGatewayLimits !== undefined,
  namedRecipientBrowserLimits: config.namedRecipientBrowserLimits,
});

const server = serveFetchHandler({
  handler: application.handle,
  maxBodyBytes: url => ["/api/live/named-session", "/api/live/named-ticket", "/api/live/named-documents"].includes(url.pathname) && config.namedBrowserSessionLimits
    ? config.namedBrowserSessionLimits.maxRequestBytes : MAX_REQUEST_BODY_BYTES,
  oversized: refusal,
  failure: refusal,
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
      publicHosts: config.publicHosts, relayUrl: config.relayUrl, relayExchangeKey: config.relayExchangeKey ?? "",
      limits: JSON.parse(process.env.DOHC_DEVICE_CONTROL_LIMITS),
      admission: JSON.parse(process.env.DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION ?? "null"), trustedProxies: config.trustedProxies,
    });
  } catch {
    fatal("FATAL: Invalid device control configuration. Check DOHC_DEVICE_CONTROL_LIMITS, DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION, and relay settings.");
  }
}
let namedGateway: ReturnType<typeof createLiveGateway> | undefined;
if (config.namedLiveGatewayLimits) {
  namedGateway = createLiveGateway({publicHosts: config.publicHosts, publicOrigin: config.accountAuth!.publicOrigin,
    limits: config.namedLiveGatewayLimits,
    resolveSession(request, discriminator, signal) {
      const authenticated = namedLiveGatewayRequest(request, config.accountAuth!.publicOrigin, signal);
      return authenticated ? application.resolveNamedBrowserSession(authenticated, discriminator) : Promise.resolve(null);
    },
    openHostRoute: createNamedLiveRelayRoute({relayUrl: config.relayUrl, publicOrigin: config.accountAuth!.publicOrigin,
      exchangeKey: config.relayExchangeKey!, handshakeTimeoutMs: config.namedLiveGatewayLimits.upgradeTimeoutMs}),
  });
  process.once("SIGINT", namedGateway.close);
  process.once("SIGTERM", namedGateway.close);
  server.once("close", namedGateway.close);
}
if (deviceControl || namedGateway) server.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/api/live?")) {
    if (namedGateway) void namedGateway.handleUpgrade(request, socket, head); else socket.destroy();
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
  onClosed: () => process.exit(0),
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
