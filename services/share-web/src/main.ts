import { readFileSync, writeSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
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
  relayExchangeKey: config.relayExchangeKey,
  publicHosts: config.publicHosts,
  viewerAssetsDir,
});

const server = createServer((incoming, outgoing) => {
  const abortRelay = new AbortController();
  const chunks: Buffer[] = [];
  let received = 0;
  let oversized = false;
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) abortRelay.abort();
  });
  incoming.on("error", () => outgoing.destroy());
  incoming.on("data", (chunk: Buffer) => {
    if (oversized) return;
    received += chunk.length;
    if (received > 16 * 1024) {
      oversized = true;
      chunks.length = 0;
      outgoing.shouldKeepAlive = false;
      refuse(outgoing);
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  incoming.on("end", () => {
    if (oversized) return;
    let request: Request;
    try {
      const url = new URL(
        incoming.url ?? "/",
        `http://${incoming.headers.host ?? "localhost"}`,
      );
      const headers = new Headers(incoming.headers as Record<string, string>);
      headers.set(
        "x-dohc-share-web-client-ip",
        clientAddress(
          incoming.socket.remoteAddress,
          headers.get("x-forwarded-for"),
          config.trustedProxies,
        ),
      );
      const method = incoming.method ?? "GET";
      request = new Request(url, {
        method,
        headers,
        signal: abortRelay.signal,
        body:
          method === "GET" || method === "HEAD" || chunks.length === 0
            ? undefined
            : Buffer.concat(chunks),
      });
    } catch {
      outgoing.destroy();
      return;
    }
    void handler(request)
      .then((webResponse) => {
        if (outgoing.destroyed) {
          void webResponse.body?.cancel();
          return;
        }
        outgoing.statusCode = webResponse.status;
        for (const [key, value] of webResponse.headers) outgoing.setHeader(key, value);
        if (!webResponse.body) {
          outgoing.end();
          return;
        }
        void pipeResponseBody(webResponse.body, outgoing);
      })
      .catch(() => {
        if (!outgoing.destroyed) refuse(outgoing);
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

function refuse(outgoing: ServerResponse): void {
  outgoing.statusCode = 404;
  outgoing.setHeader("content-type", "application/json");
  outgoing.setHeader("content-security-policy", SHARE_WEB_CSP);
  outgoing.setHeader("referrer-policy", "no-referrer");
  outgoing.setHeader("x-content-type-options", "nosniff");
  outgoing.setHeader("cache-control", "private, no-store");
  outgoing.end(shareWebRefusalBody);
}

async function pipeResponseBody(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
): Promise<void> {
  const reader = body.getReader();
  const cancelOnClose = (): void => {
    if (!outgoing.writableFinished) void reader.cancel().catch(() => undefined);
  };
  outgoing.once("close", cancelOnClose);
  try {
    while (!outgoing.destroyed) {
      const read = await reader.read();
      if (read.done) {
        outgoing.end();
        return;
      }
      if (!outgoing.write(Buffer.from(read.value))) {
        const drained = await waitForDrain(outgoing);
        if (!drained) return;
      }
    }
  } catch {
    if (!outgoing.destroyed) outgoing.destroy();
  } finally {
    outgoing.off("close", cancelOnClose);
    if (!outgoing.writableFinished) await reader.cancel().catch(() => undefined);
  }
}

function waitForDrain(outgoing: ServerResponse): Promise<boolean> {
  if (outgoing.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = (): void => {
      outgoing.off("close", closed);
      outgoing.off("drain", drained);
    };
    const closed = (): void => {
      cleanup();
      resolve(false);
    };
    const drained = (): void => {
      cleanup();
      resolve(true);
    };
    outgoing.once("close", closed);
    outgoing.once("drain", drained);
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
