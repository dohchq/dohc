import {decodeReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import { parseCanonicalAdmittedLiveUpdateMetadata } from "@dohc/live-session-contract";
import type { ReplicaLiveJournalPage } from "./storage/liveUpdateJournal";
import { replicaFrontiers, type ReplicaJournalRow, type ReplicaPageResult, EngineClient, DuplexEngineClientConnection } from "@dohc/workspace-engine-client/daemon";
import type { ReplicaChild, ReplicaChildInput } from "./replicaSupervisor";
import { serveReplicaRelay, readReplicaJournal } from "./replicaRelaySocket";

export interface ReplicaEngineOptions {
  readonly engineExecutable: string;
  readonly allowUnisolatedDevelopment?: boolean;
  readonly deadlineMs?: number;
}

/** The child receives only private paths, an RPC token, and its GET credential. PR 4b adds Linux isolation. */
export function createReplicaEngineStarter(options: ReplicaEngineOptions) {
  // PR 4 must replace this all-platform opt-in with Linux isolation.
  if (!options.allowUnisolatedDevelopment) {
    throw new Error("Relay replicas require explicit development permission until Linux isolation is available.");
  }
  if (!isAbsolute(options.engineExecutable)) throw new TypeError("Replica engine executable must be absolute.");
  const deadlineMs = options.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new TypeError("Invalid replica deadline.");
  return async ({ storeDir, lease, relayHandler }: ReplicaChildInput): Promise<ReplicaChild> => {
    if (!(await stat(options.engineExecutable)).isFile()) throw new TypeError("Replica engine executable must be a file.");
    const authToken = randomBytes(32).toString("hex");
    const relay = await serveReplicaRelay(storeDir, lease, relayHandler);
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(options.engineExecutable, ["--replica"], { cwd: storeDir, env: { DOHC_ENGINE_AUTH_TOKEN: authToken,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { await relay.close(); throw error; }
    const termination = new Promise<void>(resolve => child.once("close", () => resolve()));
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const client = new EngineClient(new DuplexEngineClientConnection(stream), { authToken, protocolVersion: 2,
      capabilities: ["blobs"], connectTimeoutMs: deadlineMs, privateLiveApplication: {aggregateBytes: 1024 * 1024 * 1024, maxUploads: 1} }, () => child.kill("SIGKILL"), termination);
    child.on("error", error => stream.destroy(error));
    child.on("close", (code, signal) => client.notifyProcessExit(code, signal));
    child.stderr.resume();
    let workspace: string | undefined, id = 1;
    let stopped = false;
    async function request(method: string, params: Record<string, unknown>) {
      if (stopped) throw new Error("Replica child is closed.");
      const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
      try {
        const response = await client.sendRequest({ id: id++, method, workspace, deadlineMs, params: params as never });
        return response.result as Record<string, unknown>;
      } finally { clearTimeout(timer); }
    }
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => { stopped = true; client.close(); child.kill("SIGKILL");
      await termination; await relay.close(); })();
    try {
      await client.ready();
      const ping = await request("engine.ping", {});
      if (ping.mode !== "replica" || ping.sandboxLevel !== "none") throw new Error("Replica engine mode is unavailable.");
      const opened = await request("workspace.open", { rootDir: storeDir, workspaceId: lease.workspaceId,
        storeMode: "passive", captureMode: "none", recoverRunningDispatches: false,
        relay: { socketPath: relay.socketPath, bearerToken: lease.bearer } });
      workspace = String(opened.workspace);
      await request("sync.adoptJoinIdentity", { workspaceId: lease.workspaceId,
        replicationEpoch: lease.replicationEpoch, streamIdentity: lease.streamIdentity });
      const pullOrdinary = async () => {
        let page: Record<string, unknown>;
        let previous: number | undefined;
        do {
          page = await request("sync.pull", { workspaceId: lease.workspaceId });
          if (page.status !== "complete" || !Number.isSafeInteger(page.nextCursor) || typeof page.nextCursor !== "number" ||
              !page.pendingCursor || (previous !== undefined && (page.nextCursor < previous || (page.hasMore && page.nextCursor === previous)))) {
            throw new Error("Replica pull did not produce a progressing cursor.");
          }
          await request("sync.commitCursor", { workspaceId: lease.workspaceId, pendingCursor: page.pendingCursor });
          previous = page.nextCursor;
        } while (page.hasMore);
      };
      return { pid: child.pid, exited: termination, close,
        async currentView(selectors,knownTextShas,position,cursor) {
          return decodeReplicaCurrentView(await request("replica.cut",{selectors,knownTextShas:knownTextShas.join(""),position:position??null,cursor:cursor??null}));
        }, async pull() {
        await pullOrdinary();
        const frontiers = replicaFrontiers(await request("replica.frontiers", {}));
        await drainReplicaJournal(frontiers.journalCursor, after => readReplicaJournal(relay.socketPath, lease, after, deadlineMs), async (after, page) => {
          const rows: ReplicaJournalRow[] = page.rows.map(r => ({...r,
            admitted: {metadata: parseCanonicalAdmittedLiveUpdateMetadata(r.admitted.metadata), updateBytes: decodeJournalBytes(r.admitted.updateBytes)},
            restore: r.restore ? {operationId: r.restore.operationId, checkpointDigest: r.restore.checkpoint.digest,
              checkpointBytes: decodeJournalBytes(r.restore.checkpoint.bytes), proof: r.restore.proof} : null}));
          return await client.applyReplicaJournalPage({id: id++, workspace: workspace!, deadlineMs}, after, lease.epochLogFloor, rows);
        }, pullOrdinary);
      } };
    } catch (error) { await close(); throw error; }
  };
}

function decodeJournalBytes(value: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError("Invalid journal bytes.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new TypeError("Invalid journal base64.");
  return bytes;
}

export async function drainReplicaJournal(after: number,
  read: (after: number) => Promise<ReplicaLiveJournalPage>,
  apply: (after: number, page: ReplicaLiveJournalPage) => Promise<ReplicaPageResult>,
  pullOrdinary: () => Promise<void>): Promise<void> {
  let retriedCursor: number | undefined;
  for (;;) {
    const page = await read(after);
    if (!Array.isArray(page.rows) || page.rows.length > 500 || typeof page.hasMore !== "boolean" ||
      !Number.isSafeInteger(page.nextCursor) || page.nextCursor < after ||
      (page.rows.length === 0 && (page.hasMore || page.nextCursor !== after)) ||
      page.rows.some((row, i) => !Number.isSafeInteger(row.journalCursor) || row.journalCursor <= (i ? page.rows[i-1]!.journalCursor : after)) ||
      (page.rows.length > 0 && page.rows.at(-1)!.journalCursor !== page.nextCursor)) throw new Error("Replica journal page did not progress.");
    if (page.rows.length === 0) return;
    const result = await apply(after, page);
    if (result.journalCursor < after || result.journalCursor > page.nextCursor) throw new Error("Replica journal apply did not produce a valid cursor.");
    after = result.journalCursor;
    if (result.blockedCursor !== null) {
      if (retriedCursor === result.blockedCursor) throw new Error(`Replica journal cursor ${result.blockedCursor} cannot apply after ordinary catch-up.`);
      retriedCursor = result.blockedCursor;
      await pullOrdinary();
      continue;
    }
    if (after !== page.nextCursor) throw new Error("Replica journal apply did not drain its page.");
    retriedCursor = undefined;
    if (!page.hasMore) return;
  }
}
