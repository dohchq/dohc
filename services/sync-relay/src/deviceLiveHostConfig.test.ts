import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readDeviceLiveHostConfig, readRelayDeviceDeliveryConfig } from "./deviceLiveHostConfig.js";
import { connectDeviceHost } from "./deviceHostConnect.js";
import { createDeviceHostCredential } from "./deviceHostCredential.js";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const limits = { maxConnections: 2, maxHeaderBytes: 8192, maxCredentialBytes: 4096, maxPayloadBytes: 4096,
  maxPendingBytes: 8192, maxFragments: 8, maxBufferedChunks: 8, handshakeTimeoutMs: 1000,
  heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 1000, closeTimeoutMs: 100 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-device-config-")); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const file = join(root, "config.json");
  const value = { version: 1, engineExecutable: resolve(process.execPath), hostId: "host", hostEpoch: 1, instanceId: "instance",
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 2 }], maxQueuedBytes: 4_000_000, shutdownGraceMs: 1000,
    ingress: { aggregateBytes: 400_000_000, applicationWorkingReserveBytes: 1_000_000, maxUploads: 2, uploadDeadlineMs: 1000 } };
  return { file, value, write(value: unknown) { writeFileSync(file, JSON.stringify(value)); return file; } };
}
it("validates the complete private device configuration before opening a connection", () => {
  const run = fixture();
  expect(readDeviceLiveHostConfig(run.write(run.value), limits)).toEqual(run.value);
  for (const value of [{ ...run.value, engineExecutable: "relative.exe" }, { ...run.value, workspaces: [] },
    { ...run.value, workspaces: [...run.value.workspaces, ...run.value.workspaces] }, { ...run.value, maxQueuedBytes: 10 },
    ...[undefined, 0, -1, 1.5, Infinity, 2_147_483_648].map(shutdownGraceMs => ({ ...run.value, shutdownGraceMs })),
    { ...run.value, ingress: { ...run.value.ingress, maxUploads: 0 } }, { ...run.value, command: "extra" }]) {
    expect(() => readDeviceLiveHostConfig(run.write(value), limits)).toThrow();
  }
  const credential = createDeviceHostCredential("different-host", parseHostEpoch(1));
  expect(() => connectDeviceHost({ url: "wss://unreachable.invalid/api/device-control", credential, limits,
    deliveryConfigPath: run.write(run.value), onRegistered() {} })).toThrow("does not match the credential");
});
it("requires explicit relay workspace routing and compatible upload and frame budgets", () => {
  const run = fixture();
  const value = { version: 1, workspaceIds: ["workspace"], maxQueuedBytes: 4_000_000, maxActiveDrains: 2,
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 1000, requestDeadlineMs: 1000, maxFrameBytes: 1_048_576 } };
  expect(readRelayDeviceDeliveryConfig(run.write(value), limits).workspaceIds).toEqual(["workspace"]);
  for (const bad of [{ ...value, workspaceIds: ["workspace", "workspace"] }, { ...value, maxActiveDrains: 0 },
    { ...value, maxQueuedBytes: 8192 }, { ...value, client: { ...value.client, aggregateBytes: 1 } },
    { ...value, client: { ...value.client, maxFrameBytes: 4096 } }, { ...value, root: "device-path" }]) {
    expect(() => readRelayDeviceDeliveryConfig(run.write(bad), limits)).toThrow();
  }
});

it("requires a positive application reserve only when settlement is configured", () => {
  const run = fixture();
  const value = { ...run.value, ingress: { ...run.value.ingress, applicationWorkingReserveBytes: 0 } };
  expect(readDeviceLiveHostConfig(run.write(value), limits).ingress.applicationWorkingReserveBytes).toBe(0);
  const settlement = { maxApplicationsPerSettlement: 8 };
  expect(() => readDeviceLiveHostConfig(run.write({ ...value, settlement }), limits)).toThrow("Settlement requires a positive applicationWorkingReserveBytes limit.");
  expect(readDeviceLiveHostConfig(run.write({ ...run.value, settlement }), limits).settlement).toEqual(settlement);
});

it("rejects relay queues smaller than an advertised payload before connecting", () => {
  const run = fixture();
  const wide = { ...limits, maxPayloadBytes: 4_194_304, maxPendingBytes: 4_194_320 };
  const value = { version: 1, workspaceIds: ["workspace"], maxQueuedBytes: wide.maxPayloadBytes + 15, maxActiveDrains: 2,
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 1000, requestDeadlineMs: 1000, maxFrameBytes: 1_048_576 } };
  expect(() => readRelayDeviceDeliveryConfig(run.write(value), wide)).toThrow("Invalid device delivery limit.");
  expect(readRelayDeviceDeliveryConfig(run.write({ ...value, maxQueuedBytes: wide.maxPayloadBytes + 16 }), wide).maxQueuedBytes)
    .toBe(wide.maxPayloadBytes + 16);
});

it("charges one retained input buffer when transport segments are small", () => {
  const run = fixture();
  const deviceBytes = 65_536 + 16;
  expect(readDeviceLiveHostConfig(run.write({ ...run.value, maxQueuedBytes: deviceBytes }), limits).maxQueuedBytes).toBe(deviceBytes);
  expect(() => readDeviceLiveHostConfig(run.write({ ...run.value, maxQueuedBytes: deviceBytes - 1 }), limits)).toThrow();
  const maxFrameBytes = 1_048_576, relayBytes = maxFrameBytes + 20 + 16;
  const relay = { version: 1, workspaceIds: ["workspace"], maxQueuedBytes: relayBytes, maxActiveDrains: 2,
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 1000, requestDeadlineMs: 1000, maxFrameBytes } };
  expect(readRelayDeviceDeliveryConfig(run.write(relay), limits).maxQueuedBytes).toBe(relayBytes);
  expect(() => readRelayDeviceDeliveryConfig(run.write({ ...relay, maxQueuedBytes: relayBytes - 1 }), limits)).toThrow();
});
