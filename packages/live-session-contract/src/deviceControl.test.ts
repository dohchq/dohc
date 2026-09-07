import { expect, it } from "vitest";
import { parseDeviceControlLimits, parseDeviceControlRegistration } from "./deviceControl.js";

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
