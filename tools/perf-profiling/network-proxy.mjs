import { createServer, request } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

function forwardedHeaders(headers) {
  const forwarded = { ...headers };
  const hopHeaders = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
    ...String(headers.connection ?? "").split(","),
  ];
  for (const name of hopHeaders) delete forwarded[name.trim().toLowerCase()];
  return forwarded;
}

// Response shaping only: latency is one extra delay per response, bandwidth
// is one shared downstream budget. This does not emulate packet loss or RTT.
export async function openNetworkProxy(targetUrl) {
  const target = new URL(targetUrl);
  let settings = { latencyMs: 0, bytesPerSecond: 0, failBlobAt: 0 };
  let availableAt = 0;
  let counters;
  const sockets = new Set();
  const requests = new Set();
  const responses = new Set();
  const controller = new AbortController();
  const reset = () => {
    counters = { requests: 0, blobGets: 0, bytes: 0, failures: 0 };
    availableAt = performance.now();
  };
  reset();
  const server = createServer((incoming, outgoing) => {
    counters.requests++;
    const pathname = new URL(incoming.url, "http://127.0.0.1").pathname;
    const blob = incoming.method === "GET" && /\/blobs\/[0-9a-f]{64}$/u.test(pathname);
    if (blob) counters.blobGets++;
    if (blob && settings.failBlobAt === counters.blobGets) {
      counters.failures++;
      outgoing.writeHead(503);
      outgoing.end("Injected benchmark interruption");
      return;
    }
    const requestController = new AbortController();
    const signal = AbortSignal.any([controller.signal, requestController.signal]);
    const upstream = request({
      hostname: target.hostname, port: target.port,
      path: incoming.url, method: incoming.method,
      headers: { ...forwardedHeaders(incoming.headers), host: target.host },
    }, (response) => {
      const forwarding = (async () => {
        try {
          if (settings.latencyMs) await delay(settings.latencyMs, undefined, { signal });
          outgoing.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers));
          for await (const chunk of response) {
            if (settings.bytesPerSecond) {
              availableAt = Math.max(availableAt, performance.now()) + chunk.length * 1000 / settings.bytesPerSecond;
              await delay(Math.max(0, availableAt - performance.now()), undefined, { signal });
            }
            if (outgoing.destroyed) break;
            counters.bytes += chunk.length;
            if (!outgoing.write(chunk)) await once(outgoing, "drain", { signal });
          }
          outgoing.end();
        } catch (error) { outgoing.destroy(error); }
      })();
      responses.add(forwarding);
      void forwarding.finally(() => responses.delete(forwarding));
    });
    requests.add(upstream);
    upstream.once("close", () => requests.delete(upstream));
    upstream.on("error", (error) => outgoing.destroy(error));
    outgoing.on("close", () => {
      requestController.abort();
      upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    configure(value = {}) {
      settings = { latencyMs: 0, bytesPerSecond: 0, failBlobAt: 0, ...value };
      reset();
    },
    snapshot: () => ({ ...counters }),
    pendingResponses: () => responses.size,
    waitForResponses: () => Promise.allSettled([...responses]),
    async close() {
      controller.abort();
      for (const upstream of requests) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...responses]);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
