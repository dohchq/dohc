import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { VersionedLiveAdapter, type JsonValue } from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
  deriveAutomationReplicaBearer,
} from "./automationReplicaCredential";
import type { AutomationReplica, startAutomationReplicas } from "./automationReplicas";
import { startAutomationServer } from "./automationServer";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { createServiceHostReplication } from "./serviceHostReplication";
import { ServiceOrdinaryReplication, type ServiceOrdinaryReplicationConfig } from "./serviceOrdinaryReplication";
import { closeTestStorages, jsonBody, tempRoot, testStorage } from "./testing";

// A schedule runs on the server while no computer of the owner's runs:
// the real engine in the server's copy of the workspace, the real executor
// and scheduler on a clock the test sets, the relay route, and a join as the
// owner. The owner's computer then receives the record the schedule added.
// The replica supervisor is stubbed; this does not exercise the self-host bundle.

const engine = requireEngineBinaryOrSkip();
const WORKSPACE = "workspace-trip";
const DEADLINE_MS = 30_000;
const HOUR = 3_600_000;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  closeTestStorages();
});

// The relay's test seam: "Bearer test:<user>" is that user.
const testActor: ResolveActor = (request, workspaceId) => {
  const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, workspaceId };
};

/** One engine with the workspace open on the relay route and ordinary replication. */
async function computer(input: {
  root: string;
  relayUrl: string;
  bearerToken: string;
  identity: ServiceOrdinaryReplicationConfig["identity"];
}) {
  await mkdir(input.root, { recursive: true });
  const client = await createEngineClient({
    command: engine.require(), authToken: randomBytes(32).toString("base64url"),
    protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: DEADLINE_MS,
  });
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  const request = async (method: string, params: { [key: string]: JsonValue }, workspace?: string) =>
    (await client.sendRequest({ id: nextRequestId(), method, params, ...(workspace ? { workspace } : {}), deadlineMs: DEADLINE_MS }))
      .result as { [key: string]: JsonValue };
  const opened = await request("workspace.open", {
    rootDir: input.root, workspaceId: WORKSPACE, captureMode: "none", reconcileCollections: true,
    relay: { baseUrl: input.relayUrl, bearerToken: input.bearerToken, allowInsecureLoopbackForTests: true },
  });
  const workspace = opened.workspace as string;
  // Pulled moments land in the main version, as the server's replica makes it at open.
  await request("versions.ensureMain", { workspaceId: WORKSPACE }, workspace);
  const lifetime = new AbortController();
  const replication = new ServiceOrdinaryReplication(
    { client, workspace, workspaceId: WORKSPACE, nextRequestId, deadlineMs: DEADLINE_MS, signal: lifetime.signal, assertCurrent: () => undefined },
    { relay: { baseUrl: "https://relay.example.test", bearerToken: input.bearerToken }, identity: input.identity, maxPagesPerPull: 8 },
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    await request("workspace.close", {}, workspace).catch(() => undefined);
    client.close();
    await client.waitForExit();
  };
  cleanup.push(close);
  return {
    close, client, workspace, lifetime: lifetime.signal, request, nextRequestId,
    async sync(): Promise<string[]> {
      const pulled: string[] = [];
      for (let more = true; more;) more = (await replication.push()).hasMore;
      for (let more = true; more;) {
        const result = await replication.pull();
        for (const page of result.pages) pulled.push(...page.changedPaths);
        more = result.hasMore;
      }
      return pulled;
    },
  };
}

it.skipIf(engine.missing)("the server runs a schedule with the owner daemon stopped, then syncs its record when the owner returns", async () => {
  const root = await tempRoot("automation-server-e2e");
  const storage = await testStorage();
  const key = new Uint8Array(32).fill(7), namespace = "automation-server-e2e";
  const server = { label: "My dohc server" };
  // The relay as main.ts mounts it while it runs automations.
  const relay = createSyncRelayHandler({ storage, resolveActor: testActor, automationServer: server });
  const replicas = createServiceHostReplication({
    storage, prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: (credential) => authorizeAutomationReplication(storage, { key, namespace, ...credential }),
  });
  const http = serveFetchHandler({
    handler: (request) => request.headers.get("authorization")?.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`)
      ? replicas(request) : relay(request),
    streamBody: streamsRequestBody,
    maxBodyBytes: () => 21 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  // The owner's computer makes the Collection and its hourly schedule, and syncs.
  const owner = await computer({ root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: { kind: "claim" } });
  const main = await owner.request("versions.ensureMain", {}, owner.workspace);
  for (const [path, text] of [
    ["Tasks/collection.yaml", "name: Tasks\nfields:\n  Status:\n    type: text\n"],
    ["Tasks/automations.yaml", "version: 1\nautomations:\n  - id: sweep\n    name: Sweep\n    when: {schedule: hour, timezone: UTC}\n    do: [{add-record: {Status: Swept}}]\n"],
  ] as const) {
    await owner.request("versionedText.write", { versionId: main.id, path, text, origin: "api", publish: true, createOnly: true }, owner.workspace);
  }
  await owner.sync();
  // The owner's computer asks for a host: the relay records the server.
  const checkIn = await relay(new Request(`${relayUrl}/sync/${WORKSPACE}/automation-host/check-in`, {
    ...jsonBody({ installId: "laptop", label: "Laptop", claim: true }),
    headers: { authorization: "Bearer test:owner", "content-type": "application/json" },
  }));
  expect(((await checkIn.json()) as { host: { installId: string } }).host.installId).toBe("server");

  await owner.close();

  // The server joins as the owner and opens its copy.
  const row = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: Date.now() });
  if (row === null) throw new Error("The relay did not let the server join the workspace.");
  const copy = await computer({
    root: join(root, "server", "workspace"), relayUrl,
    bearerToken: deriveAutomationReplicaBearer(row, { key, namespace }),
    identity: { kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity },
  });
  // The replicas module pulls a copy when it opens it.
  await copy.sync();
  const metadataDir = join(root, "server", "metadata");
  await mkdir(metadataDir, { recursive: true });

  // The scheduler's clock starts two hours back, so its due times are past for the engine too.
  let clock = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const timers: Array<() => void> = [];
  let hooks: Parameters<typeof startAutomationReplicas>[0] | undefined;
  const errors: string[] = [];
  const replica: AutomationReplica = {
    pulledHead: 0,
    workspaceId: WORKSPACE, ownerUserId: "owner", incarnation: row.incarnation, startedAtMs: row.startedAtMs,
    root: join(root, "server", "workspace"), metadataDir, client: copy.client, workspace: copy.workspace, signal: copy.lifetime,
    nextRequestId: copy.nextRequestId,
    sync: async () => { hooks?.onPulled?.(WORKSPACE, await copy.sync()); },
  };
  const running = await startAutomationServer({
    storage, server,
    replicas: { root: join(root, "server"), engineExecutable: engine.require(), relayOrigin: "https://relay.example.test", key, namespace },
    readOwnerShares: (ownerUserId, path) => relay.readOwnerShares(ownerUserId, path),
    lookupUserDisplayName: () => "Owner",
    noticeLimiter: new TokenBucketLimiter(10, 1, 100),
    onError: (context, error) => errors.push(`${context}: ${String(error)}`),
    nowMs: () => clock,
    clock: { now: () => clock, monotonic: () => clock, setTimer: (wake) => { timers.push(wake); return wake; }, clearTimer: () => undefined },
    startReplicas: async (options) => {
      hooks = options;
      const stop = copy.client.onEvent((event) => options.onEngineEvent?.(event));
      return { unavailable: false, replica: () => replica, reconcile: () => undefined, failedSyncs: () => new Map(), settled: async () => undefined, close: async () => stop() };
    },
  });
  cleanup.push(() => running.close());
  hooks!.onChanged?.(WORKSPACE);
  // The first step marks the schedule at the server's start; nothing before it runs.
  await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0), { timeout: DEADLINE_MS });

  // An hour and a half later on the server's clock, its due time runs.
  clock += 90 * 60_000;
  timers.splice(0).forEach((wake) => wake());
  const serverAdapter = new VersionedLiveAdapter(copy.client, copy.workspace, { workspaceId: WORKSPACE });
  await vi.waitFor(async () => {
    const files = await serverAdapter.listTextFileMetadata({ workspaceId: WORKSPACE, versionId: main.id as string });
    const added = files.filter((file) => file.path.startsWith("Tasks/") && !["Tasks/collection.yaml", "Tasks/automations.yaml"].includes(file.path));
    expect(added).toHaveLength(1);
    const read = await serverAdapter.readTextFile({ workspaceId: WORKSPACE, versionId: main.id as string, path: added[0]!.path });
    expect(read?.text).toContain("Status: Swept");
  }, { timeout: DEADLINE_MS, interval: 200 });

  // No owner daemon existed while the schedule ran. Reopen it only after the server wrote the record.
  const returned = await computer({ root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: { kind: "claim" } });
  const adapter = new VersionedLiveAdapter(returned.client, returned.workspace, { workspaceId: WORKSPACE });
  await vi.waitFor(async () => {
    await returned.sync();
    const files = await adapter.listTextFileMetadata({ workspaceId: WORKSPACE, versionId: main.id as string });
    const added = files.filter((file) => file.path.startsWith("Tasks/") && !["Tasks/collection.yaml", "Tasks/automations.yaml"].includes(file.path));
    expect(added).toHaveLength(1);
    const read = await adapter.readTextFile({ workspaceId: WORKSPACE, versionId: main.id as string, path: added[0]!.path });
    expect(read?.text).toContain("Status: Swept");
  }, { timeout: DEADLINE_MS, interval: 200 });
  expect(errors).toEqual([]);
}, 120_000);
