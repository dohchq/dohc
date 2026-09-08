import { expect, it } from "vitest";
import { parseDeviceControlLimits, parseDeviceControlRegistration, parseDeviceLiveHostStart, parseDeviceLiveHostTransport,
  parseDeviceLiveHostReceive, parseDeviceLiveHostCredit, deviceLiveHostReceive } from "./deviceControl.js";

const limits = { maxConnections: 4, maxHeaderBytes: 8192, maxCredentialBytes: 4096, maxPayloadBytes: 4096,
  maxPendingBytes: 8192, maxFragments: 8, maxBufferedChunks: 8, handshakeTimeoutMs: 1000,
  heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 1000, closeTimeoutMs: 1000 };
it("requires every explicit limit and prevents timer overflow", () => {
  expect(parseDeviceControlLimits(limits)).toEqual(limits);
  for (const name of Object.keys(limits)) {
    for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      expect(() => parseDeviceControlLimits({ ...limits, [name]: value })).toThrow();
    }
  }
  expect(() => parseDeviceControlLimits({ ...limits, heartbeatIntervalMs: 2_147_483_647 })).toThrow();
  expect(() => parseDeviceControlLimits({ ...limits, maxCredentialBytes: 8193 })).toThrow();
  expect(() => parseDeviceControlLimits({ ...limits, maxPendingBytes: 4095 })).toThrow();
  expect(() => parseDeviceControlLimits({ ...limits, extra: 1 })).toThrow();
});
it("accepts only the full device registration coordinate", () => {
  const notice = { type: "registered", mode: "device", hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection" };
  expect(parseDeviceControlRegistration(notice)).toEqual(notice);
  for (const name of Object.keys(notice)) expect(() => parseDeviceControlRegistration({ ...notice, [name]: undefined })).toThrow();
  expect(() => parseDeviceControlRegistration({ ...notice, mode: "service" })).toThrow();
  expect(() => parseDeviceControlRegistration({ ...notice, documentReady: true })).toThrow();
  expect(() => parseDeviceControlRegistration({ ...notice, hostEpoch: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
});

const start = { type: "liveHost.start", version: 1, relayNamespace: "relay", receive: { maxPayloadBytes: 4096, maxPendingBytes: 8192 }, authToken: "A".repeat(43),
  host: { hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection" } };
it("accepts only the bounded live transport startup controls", () => {
  expect(parseDeviceLiveHostStart(start)).toEqual(start);
  expect(parseDeviceLiveHostTransport({ type: "liveHost.transport", version: 1, receive: { maxPayloadBytes: 4096, maxPendingBytes: 8192 } })).toEqual({ type: "liveHost.transport", version: 1, receive: { maxPayloadBytes: 4096, maxPendingBytes: 8192 } });
  for (const value of [{ ...start, command: "run" }, { ...start, version: 2 }, { ...start, host: { ...start.host, root: "/" } },
    { ...start, authToken: "" }, { ...start, host: { ...start.host, hostEpoch: 0 } }, { ...start, relayNamespace: "" }]) {
    expect(() => parseDeviceLiveHostStart(value)).toThrow();
  }
  expect(() => parseDeviceLiveHostTransport({ type: "liveHost.transport", version: 1, ready: true })).toThrow();
  expect(() => parseDeviceLiveHostTransport({ type: "liveHost.start", version: 1 })).toThrow();
});

it("requires a bounded receive window and strictly shaped cumulative credits", () => {
  expect(deviceLiveHostReceive(limits, { maxPayloadBytes: 1024, maxPendingBytes: 2048 })).toEqual({ maxPayloadBytes: 1024, maxPendingBytes: 2048 });
  for (const value of [null, {}, { maxPayloadBytes: 4096, maxPendingBytes: 4096 }, { maxPayloadBytes: 0, maxPendingBytes: 8192 },
    { maxPayloadBytes: 4096, maxPendingBytes: Number.MAX_SAFE_INTEGER }, { maxPayloadBytes: 4096, maxPendingBytes: 8192, extra: 1 }]) {
    expect(() => parseDeviceLiveHostReceive(value)).toThrow();
  }
  const credit = { type: "liveHost.credit", version: 1, receivedBytes: 4112 };
  expect(parseDeviceLiveHostCredit(credit)).toBe(4112);
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseDeviceLiveHostCredit({ ...credit, receivedBytes: value })).toThrow();
  }
  expect(() => parseDeviceLiveHostCredit({ ...credit, command: "extra" })).toThrow();
});
