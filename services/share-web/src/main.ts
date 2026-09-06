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
import {
  createShareWebHandler,
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

const handler = createShareWebHandler({
  relayUrl: config.relayUrl,
  publicRelayUrl: config.publicRelayUrl,
  relayExchangeKey: config.relayExchangeKey,
  publicHosts: config.publicHosts,
  viewerAssetsDir,
  accountAuth: config.accountAuth,
});

const server = serveFetchHandler({
  handler,
  maxBodyBytes: () => MAX_REQUEST_BODY_BYTES,
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

function clientAddress(
  peerAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxies: ReadonlySet<string>,
): string {
  if (peerAddress === undefined || !trustedProxies.has(peerAddress)) {
    return peerAddress ?? "unknown";
  }

  const entries = forwardedFor?.split(",") ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]?.trim();
    if (entry && !trustedProxies.has(entry)) return entry;
  }
  return "unknown";
}
