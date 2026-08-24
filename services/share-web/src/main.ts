import { readFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadShareWebConfig } from "./config";
import {
  createShareWebHandler,
  SHARE_WEB_CSP,
  shareWebRefusalBody,
} from "./server";

const config = loadConfig();
const viewerAssetsDir = fileURLToPath(new URL("../viewer/dist", import.meta.url));

if (!config.devMode) {
  try {
    readFileSync(new URL("../viewer/dist/index.html", import.meta.url));
  } catch {
    fatal("FATAL: share-web viewer build is missing. Run pnpm --filter @dohc/share-web build.");
  }
}

const handler = createShareWebHandler({
  relayUrl: config.relayUrl,
  publicHosts: config.publicHosts,
  viewerAssetsDir,
});

const server = createServer((incoming, outgoing) => {
  const chunks: Buffer[] = [];
  let received = 0;
  let oversized = false;
  incoming.on("error", () => outgoing.destroy());
  incoming.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > 16 * 1024) {
      oversized = true;
      chunks.length = 0;
      return;
    }
    if (!oversized) chunks.push(Buffer.from(chunk));
  });
  incoming.on("end", () => {
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
    const headers = new Headers(incoming.headers as Record<string, string>);
    headers.set(
      "x-dohc-share-web-client-ip",
      incoming.socket.remoteAddress ?? "unknown",
    );
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body:
        oversized || chunks.length === 0
          ? undefined
          : Buffer.concat(chunks),
    });
    void handler(request)
      .then(async (webResponse) => {
        outgoing.statusCode = webResponse.status;
        for (const [key, value] of webResponse.headers) outgoing.setHeader(key, value);
        outgoing.end(Buffer.from(await webResponse.arrayBuffer()));
      })
      .catch(() => {
        outgoing.statusCode = 404;
        outgoing.setHeader("content-type", "application/json");
        outgoing.setHeader("content-security-policy", SHARE_WEB_CSP);
        outgoing.setHeader("referrer-policy", "no-referrer");
        outgoing.setHeader("x-content-type-options", "nosniff");
        outgoing.setHeader("cache-control", "private, no-store");
        outgoing.end(shareWebRefusalBody);
      });
  });
});

server.listen(config.port, config.bind, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  console.log(`[share-web] listening on ${config.bind}:${actualPort}`);
  console.log(`SHARE_WEB_LISTENING host=${config.bind} port=${actualPort}`);
  if (config.devMode) console.log("[share-web] development mode enabled");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function loadConfig() {
  try {
    return loadShareWebConfig(process.env);
  } catch (error) {
    fatal(`FATAL: ${error instanceof Error ? error.message : "invalid share-web configuration"}`);
  }
}

function fatal(message: string): never {
  writeSync(2, `${message}\n`);
  process.exit(1);
}
