// Attach one workspace to a real engine the way a self-hosted server's relay does, through the relay's request queue.
// Prints how long the attach took, how many progress reports arrived, and whether the queue retired the engine.
// Usage: tsx live-host-attach.mts <engine> <workspace root> <deadline ms> [--no-progress]
// `--no-progress` sends the attach as the relay did before it asked for progress.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineClient } from "../../packages/workspace-engine-client/src/daemon/index.ts";
import { queueLiveHostRequests } from "../../services/sync-relay/src/liveHostRequests.ts";

const [engine, root, deadline, mode] = process.argv.slice(2);
const deadlineMs = Number(deadline);
if (!engine || !root || !Number.isSafeInteger(deadlineMs))
  throw new Error(
    "usage: live-host-attach.mts <engine> <workspace root> <deadline ms> [--no-progress]",
  );

const MiB = 1024 * 1024;
const temporary = await mkdtemp(join(tmpdir(), "dohc-live-host-attach-"));
const config = join(temporary, "host.json");
await writeFile(
  config,
  JSON.stringify({
    version: 1,
    relayNamespace: "relay",
    host: { hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection" },
    workspaces: [],
    ingress: {
      aggregateBytes: 512 * MiB,
      applicationWorkingReserveBytes: 8 * MiB,
      maxUploads: 2,
      uploadDeadlineMs: 30_000,
    },
  }),
);
const lifetime = new AbortController();
let retiredFor: string | null = null;
const native = await createEngineClient({
  command: engine,
  authToken: randomBytes(32).toString("base64url"),
  protocolVersion: 2,
  capabilities: ["blobs", "progress"],
  privateLiveApplication: { aggregateBytes: 256 * MiB, maxUploads: 4 },
  connectTimeoutMs: 30_000,
  env: { DOHC_ENGINE_LIVE_HOST_CONFIG: config },
  signal: lifetime.signal,
});
const client = queueLiveHostRequests(native, {
  maxPendingReads: 4,
  maxPendingWrites: 4,
  maxRetainedInputBytes: MiB,
  deadlineMs,
  signal: lifetime.signal,
  retire(cause) {
    retiredFor = cause.method;
    lifetime.abort(cause);
  },
});
let reports = 0,
  outcome = "attached";
const started = performance.now();
try {
  await client.sendRequest(
    {
      id: 1,
      method: "liveApplication.attachWorkspace",
      params: { root, workspaceId: "measured", maxRegistrations: 4 },
      deadlineMs,
    },
    undefined,
    mode === "--no-progress"
      ? undefined
      : () => {
          reports++;
        },
  );
} catch (error) {
  outcome = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
console.log(
  `LIVE_HOST_ATTACH ${JSON.stringify({ asksProgress: mode !== "--no-progress", deadlineMs, attachMs: Math.round(performance.now() - started), reports, retiredFor, outcome })}`,
);
native.close();
await native.waitForExit();
await rm(temporary, { recursive: true, force: true });
