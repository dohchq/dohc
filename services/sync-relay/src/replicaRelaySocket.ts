import { chmod } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import type { ReplicaReadLease } from "./replicaReadPrincipal";
import type { ReplicaLiveJournalPage } from "./storage/liveUpdateJournal";

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
      const bytes = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, {...Object.fromEntries(response.headers), "content-length": bytes.length});
      outgoing.end(bytes);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
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

export function readReplicaJournal(socketPath: string, lease: ReplicaReadLease, after: number, deadlineMs: number): Promise<ReplicaLiveJournalPage> {
  return new Promise((resolve, reject) => {
    const req = request({socketPath, path: `/sync/${encodeURIComponent(lease.workspaceId)}/live-journal?after=${after}&limit=500`,
      headers: {authorization: `Bearer ${lease.bearer}`}, signal: AbortSignal.timeout(deadlineMs)}, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Replica journal read failed (${response.statusCode}).`);
          resolve(JSON.parse(Buffer.concat(chunks).toString()) as ReplicaLiveJournalPage);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end();
  });
}
