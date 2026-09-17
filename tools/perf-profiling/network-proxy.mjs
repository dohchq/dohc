import { createServer, request } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Response shaping only: latency is one extra delay per response, bandwidth
// is one shared downstream budget. This does not emulate packet loss or RTT.
export async function openNetworkProxy(targetUrl) {
  const target = new URL(targetUrl);
  let settings = { latencyMs: 0, bytesPerSecond: 0, failBlobAt: 0 };
  let availableAt = 0;
  let counters;
  const sockets = new Set();
  const requests = new Set();
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
    const upstream = request({
      hostname: target.hostname, port: target.port,
      path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: target.host },
    }, async (response) => {
      try {
        if (settings.latencyMs) await delay(settings.latencyMs, undefined, { signal: controller.signal });
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        for await (const chunk of response) {
          if (settings.bytesPerSecond) {
            availableAt = Math.max(availableAt, performance.now()) + chunk.length * 1000 / settings.bytesPerSecond;
            await delay(Math.max(0, availableAt - performance.now()), undefined, { signal: controller.signal });
          }
          if (outgoing.destroyed) break;
          counters.bytes += chunk.length;
          if (!outgoing.write(chunk)) await once(outgoing, "drain", { signal: controller.signal });
        }
        outgoing.end();
      } catch (error) { outgoing.destroy(error); }
    });
    requests.add(upstream);
    upstream.once("close", () => requests.delete(upstream));
    upstream.on("error", (error) => outgoing.destroy(error));
    outgoing.on("close", () => upstream.destroy());
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
    async close() {
      controller.abort();
      for (const upstream of requests) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
