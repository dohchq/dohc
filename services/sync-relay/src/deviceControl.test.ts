import { DatabaseSync } from "node:sqlite";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { DEVICE_CONTROL_PROTOCOL, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { createDeviceHostCredential } from "./deviceHostCredential.js";
import { createDeviceControl } from "./deviceControl.js";
import { openSyncRelayStorage } from "./storage.js";

const limits: DeviceControlLimits = { maxConnections: 4, maxHeaderBytes: 8192, maxCredentialBytes: 4096,
  maxPayloadBytes: 4096, maxPendingBytes: 8192, maxFragments: 8, maxBufferedChunks: 8,
  handshakeTimeoutMs: 1000, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 500, closeTimeoutMs: 100 };
const exchangeKey = "device-control-test-exchange-key-32";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(overrides: Partial<DeviceControlLimits> = {}, deployment = false, delivery = false) {
  const directory = await mkdtemp(join(tmpdir(), "dohc-device-control-"));
  const configPath = join(directory, "deployment.json");
  if (deployment) initializeRelayDeployment({ configPath, relayPath: join(directory, "volume", "relay.sqlite"), continuityDirectory: join(directory, "continuity") });
  const owner = deployment ? openRelayDeployment(configPath) : undefined;
  const storage = owner?.storage ?? openSyncRelayStorage(join(directory, "relay.sqlite"));
  const deliveryConfig = join(directory, "delivery.json");
  if (delivery) await writeFile(deliveryConfig, JSON.stringify({ version: 1, workspaceIds: ["workspace"], maxQueuedBytes: 4_000_000, maxActiveDrains: 1,
    client: { aggregateBytes: 200_000_000, maxUploads: 1, connectTimeoutMs: 1000, requestDeadlineMs: 1000, maxFrameBytes: 1_048_576 } }));
  const credential = createDeviceHostCredential("device-test", parseHostEpoch(1));
  expect(storage.provisionDeviceHostCredential({ credential, updatedAtMs: Date.now() }).ok).toBe(true);
  const control = createDeviceControl({ storage, hosts: new Set(["relay.test"]), relayExchangeKey: exchangeKey,
    limits: { ...limits, ...overrides }, ...(delivery && owner ? { delivery: { configPath: deliveryConfig, history: owner.history } } : {}) });
  const server = createServer();
  server.on("upgrade", control.handleUpgrade);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const port = address.port;
  cleanups.push(async () => {
    control.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  function connect(input = credential, headers: Record<string, string> = {}, autoPong = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/device-control`, DEVICE_CONTROL_PROTOCOL, {
      perMessageDeflate: false, autoPong, headers: { host: "relay.test", "x-dohc-relay-exchange-key": exchangeKey,
        authorization: `Bearer ${Buffer.from(JSON.stringify(input)).toString("base64url")}`, ...headers },
    });
    ws.on("error", () => {});
    const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
    return { ws, closed };
  }
  async function registered() {
    const connection = connect();
    const [bytes] = await once(connection.ws, "message");
    return { ...connection, notice: JSON.parse(String(bytes)) };
  }
  return { storage, credential, control, directory, connect, registered };
}

describe("outbound device control authority", () => {
  it.each(["early-binary", "unknown-control", "malformed-native", "oversize"])("refuses invalid private delivery bytes: %s", async mode => {
    const fixture = await setup({}, true, true);
    const connection = fixture.connect();
    const notices: Record<string, unknown>[] = [];
    connection.ws.on("message", (bytes, binary) => { if (!binary) notices.push(JSON.parse(bytes.toString())); });
    await expect.poll(() => notices.length).toBe(2);
    expect(notices[1]).toMatchObject({ type: "liveHost.start", version: 1,
      host: { hostId: fixture.credential.hostId, instanceId: fixture.credential.instanceId } });
    await expect(fixture.control.drain({ workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64) })).rejects.toThrow("not ready");
    if (mode === "early-binary") connection.ws.send(Buffer.from("DOP1"));
    if (mode === "unknown-control") connection.ws.send(JSON.stringify({ type: "native.ready", version: 1 }));
    if (mode === "malformed-native") {
      connection.ws.send(JSON.stringify({ type: "liveHost.transport", version: 1 }));
      connection.ws.send(Buffer.alloc(12));
    }
    if (mode === "oversize") connection.ws.send(Buffer.alloc(limits.maxPayloadBytes + 1));
    await connection.closed;
    await expect.poll(() => fixture.storage.getLiveHostControl()?.admissionState).toBe("closed");
  });
  it("registers server coordinates, replaces the same instance, and ignores its stale disconnect", async () => {
    const fixture = await setup();
    const first = await fixture.registered();
    const second = await fixture.registered();
    await first.closed;
    expect(second.notice).toMatchObject({ type: "registered", mode: "device", hostId: fixture.credential.hostId,
      instanceId: fixture.credential.instanceId, hostEpoch: 1 });
    expect(second.notice.connectionId).not.toBe(first.notice.connectionId);
    fixture.storage.disconnectDeviceHost({ credential: fixture.credential, connectionId: first.notice.connectionId, updatedAtMs: Date.now() });
    expect(fixture.storage.getLiveHostControl()?.registeredConnectionId).toBe(second.notice.connectionId);
    second.ws.terminate();
    await second.closed;
    await expect.poll(() => fixture.storage.getLiveHostControl()?.admissionState).toBe("closed");
  });

  it("rejects malformed, wrong-scope, and unauthenticated candidates without replacing the current host", async () => {
    const fixture = await setup({ maxConnections: 8 });
    const current = await fixture.registered();
    const candidates = [
      fixture.connect({ ...fixture.credential, secret: "A".repeat(43) }),
      fixture.connect({ ...fixture.credential, hostId: "other-device" }),
      fixture.connect(fixture.credential, { authorization: "Bearer invalid" }),
      fixture.connect(fixture.credential, { "x-dohc-relay-exchange-key": "wrong" }),
      fixture.connect(fixture.credential, { authorization: `Bearer ${Buffer.from(JSON.stringify(fixture.credential).replace('"version":1', '"version":1,"version":1')).toString("base64url")}` }),
    ];
    await Promise.all(candidates.map(candidate => candidate.closed));
    expect(fixture.storage.getLiveHostControl()?.registeredConnectionId).toBe(current.notice.connectionId);
    expect(current.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("observes external SQLite revocation on liveness and refuses later registration", async () => {
    const fixture = await setup();
    const current = await fixture.registered();
    const external = openSyncRelayStorage(join(fixture.directory, "relay.sqlite"));
    try {
      expect(external.revokeDeviceHostCredential({ hostId: fixture.credential.hostId,
        instanceId: fixture.credential.instanceId, updatedAtMs: Date.now() }).ok).toBe(true);
    } finally { external.close(); }
    await current.closed;
    await fixture.connect().closed;
    expect(fixture.storage.getLiveHostControl()?.admissionState).toBe("closed");
  });

  it.each(["application", "oversized", "ping", "wrong-pong", "silent"] as const)("closes %s peers and their durable admission", async mode => {
    const fixture = await setup();
    const connection = fixture.connect(fixture.credential, {}, mode !== "silent");
    await once(connection.ws, "message");
    if (mode === "application") connection.ws.send("unsupported");
    if (mode === "oversized") connection.ws.send(Buffer.alloc(limits.maxPayloadBytes + 1));
    if (mode === "ping") connection.ws.ping("unsupported");
    if (mode === "wrong-pong") connection.ws.pong("unsolicited");
    await connection.closed;
    await expect.poll(() => fixture.storage.getLiveHostControl()?.admissionState).toBe("closed");
  });

  it("closes owned connections on shutdown", async () => {
    const fixture = await setup();
    const current = await fixture.registered();
    fixture.control.close();
    await current.closed;
    expect(fixture.storage.getLiveHostControl()?.admissionState).toBe("closed");
  });

  it("refuses a candidate over the connection bound without displacing the active connection", async () => {
    const fixture = await setup({ maxConnections: 1 });
    const current = await fixture.registered();
    await fixture.connect().closed;
    expect(current.ws.readyState).toBe(WebSocket.OPEN);
    expect(fixture.storage.getLiveHostControl()?.registeredConnectionId).toBe(current.notice.connectionId);
  });

  it("requires a configured exchange key even in development", async () => {
    const fixture = await setup();
    expect(() => createDeviceControl({ storage: fixture.storage, hosts: new Set(["relay.test"]), relayExchangeKey: "", limits })).toThrow();
  });
});

it("closes a live deployment socket immediately after an uncertain durable commit", async () => {
  const fixture = await setup({ heartbeatIntervalMs: 60_000 }, true);
  const current = await fixture.registered();
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql: string) {
    const relayCommit = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get();
    const result = exec.call(this, sql);
    if (relayCommit) throw new Error("lost COMMIT result");
    return result;
  };
  try {
    expect(() => fixture.storage.revokeDeviceHostCredential({ hostId: fixture.credential.hostId,
      instanceId: fixture.credential.instanceId, updatedAtMs: Date.now() })).toThrow("lost COMMIT result");
  } finally { DatabaseSync.prototype.exec = exec; }
  expect(fixture.storage.unavailable.aborted).toBe(true);
  await current.closed;
  await fixture.connect().closed;
});
