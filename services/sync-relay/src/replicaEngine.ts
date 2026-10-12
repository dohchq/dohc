import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import { EngineClient, DuplexEngineClientConnection } from "@dohc/workspace-engine-client/daemon";
import type { ReplicaChild, ReplicaChildInput } from "./replicaSupervisor";

export interface ReplicaEngineOptions {
  readonly engineExecutable: string;
  readonly baseUrl: string;
  readonly allowUnisolatedDevelopment?: boolean;
  readonly allowInsecureLoopbackForTests?: boolean;
  readonly deadlineMs?: number;
}

/** The child receives only private paths, an RPC token, and its GET credential. PR 4 adds Linux isolation. */
export function createReplicaEngineStarter(options: ReplicaEngineOptions) {
  if (process.platform !== "linux" && !options.allowUnisolatedDevelopment) {
    throw new Error("Relay replicas require Linux; development must explicitly allow an unisolated child.");
  }
  if (!isAbsolute(options.engineExecutable)) throw new TypeError("Replica engine executable must be absolute.");
  const deadlineMs = options.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new TypeError("Invalid replica deadline.");
  return async ({ storeDir, lease }: ReplicaChildInput): Promise<ReplicaChild> => {
    if (!(await stat(options.engineExecutable)).isFile()) throw new TypeError("Replica engine executable must be a file.");
    const authToken = randomBytes(32).toString("hex");
    const child = spawn(options.engineExecutable, [], { cwd: storeDir, env: { DOHC_ENGINE_AUTH_TOKEN: authToken },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const termination = new Promise<void>(resolve => child.once("close", () => resolve()));
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const client = new EngineClient(new DuplexEngineClientConnection(stream), { authToken, protocolVersion: 2,
      capabilities: ["blobs"], connectTimeoutMs: deadlineMs }, () => child.kill("SIGKILL"), termination);
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
    const close = async () => { stopped = true; client.close(); child.kill("SIGKILL"); await termination; };
    try {
      await client.ready();
      const opened = await request("workspace.open", { rootDir: storeDir, workspaceId: lease.workspaceId,
        storeMode: "passive", captureMode: "none", recoverRunningDispatches: false,
        relay: { baseUrl: options.baseUrl, bearerToken: lease.bearer,
          ...(options.allowInsecureLoopbackForTests ? { allowInsecureLoopbackForTests: true } : {}) } });
      workspace = String(opened.workspace);
      await request("sync.adoptJoinIdentity", { workspaceId: lease.workspaceId,
        replicationEpoch: lease.replicationEpoch, streamIdentity: lease.streamIdentity });
      return { pid: child.pid, close, async pull() {
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
      } };
    } catch (error) { await close(); throw error; }
  };
}
