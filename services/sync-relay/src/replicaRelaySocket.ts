import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReplicaReadLease } from "./replicaReadPrincipal";

/** Each listener admits only its child's lease. The public relay never mounts this handler. */
export async function serveReplicaRelay(storeDir: string, lease: ReplicaReadLease,
  handle: (request: Request) => Promise<Response>) {
  const socketPath = join(storeDir, "relay.sock");
  const server = createServer({requestTimeout: 30_000, headersTimeout: 10_000}, async (incoming, outgoing) => {
    outgoing.setHeader("connection", "close");
    try {
      if (incoming.method !== "GET" || incoming.headers.authorization !== `Bearer ${lease.bearer}` ||
          incoming.headers["content-length"] || incoming.headers["transfer-encoding"]) {
        outgoing.writeHead(404); outgoing.end(); return;
      }
      const abort = new AbortController();
      outgoing.on("close", () => abort.abort());
      const response = await handle(new Request(new URL(incoming.url!, "http://localhost"), {
        headers: incoming.headers as Record<string, string>, signal: abort.signal }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.maxConnections = 4;
  server.setTimeout(10_000, socket => socket.destroy());
  const close = () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
  try { await chmod(socketPath, 0o600); } catch (error) { await close(); throw error; }
  return {socketPath, close};
}
