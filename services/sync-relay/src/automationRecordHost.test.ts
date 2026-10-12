import {afterEach, expect, it, vi} from "vitest";
import {AutomationRunWait} from "@dohc/automation-executor/button-presser";
import {createAutomationRecordHost} from "./automationRecordHost";
import * as frameHosts from "./namedLiveFrameHost";
import {binding, fixture, host, scope} from "./liveTickets.test-helper";
import {selfHostLiveProfile} from "./selfHostLiveProfile";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
const signal = () => new AbortController().signal;
const input = {binding, shareId: scope.shareId, ownerUserId: "owner-1"};

async function setup() {
  const state = await fixture();
  cleanup.push(() => state.close());
  const changes = frameHosts.createNamedFrameChanges(4);
  const native: frameHosts.NamedFrameNativeHost = {
    client: {
      openLiveAppliedSync: vi.fn(async () => {throw new Error("Unexpected native read");}),
      readNextLiveApplied: vi.fn(async () => {throw new Error("Unexpected native read");}),
      readLiveApplicationAck: vi.fn(async () => {throw new Error("Unexpected native read");}),
    },
    workspace: "native-workspace", registrationId: 1, coordinate: host, binding,
    invalidated: signal(), changes, deadlineMs: 30_000, nextRequestId: () => 1, drain: vi.fn(async () => {}),
  };
  const device = {captureNative: vi.fn(async () => native)};
  const service = {captureNative: vi.fn(async () => native)};
  const serviceHost = vi.fn(() => service);
  const lookupUserDisplayName = vi.fn(async () => "Owner name");
  const options = {storage: state.storage, namespace: "deployment-namespace", deviceHost: device, serviceHost,
    lookupUserDisplayName, bounds: selfHostLiveProfile().namedLive.host,
    validate: vi.fn(() => ({kind: "refused" as const, reason: "invalid-update" as const, source: "candidate" as const}))};
  return {...state, native, device, service, serviceHost, lookupUserDisplayName, options};
}

it("captures the device native host under real owner authority without a recipient ticket", async () => {
  const f = await setup();
  const record = createAutomationRecordHost(f.options), abort = signal();
  expect(record.namespace).toBe("deployment-namespace");
  const captured = await record.capture(input, abort);
  cleanup.push(async () => captured.close());
  expect(captured.hostEpoch).toBe(host.hostEpoch);
  expect(captured).not.toHaveProperty("ticket");
  expect(f.device.captureNative).toHaveBeenCalledExactlyOnceWith(binding, abort);
  expect(f.serviceHost).not.toHaveBeenCalled();
  expect(f.lookupUserDisplayName).toHaveBeenCalledExactlyOnceWith("owner-1");
  expect(f.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_session_tickets").get()).toEqual({count: 0});
  await expect(record.capture({...input, ownerUserId: scope.userId}, abort)).rejects.toThrow("Owner live authority is unavailable");
});

it("selects the current service host and supplies only the trusted owner's account", async () => {
  const f = await setup();
  const captured = await createAutomationRecordHost(f.options).capture(input, signal());
  cleanup.push(async () => captured.close());
  vi.spyOn(f.storage, "getLiveHostControl").mockReturnValue({...f.storage.getLiveHostControl()!, configuredMode: "service"});
  const capture = vi.spyOn(frameHosts, "captureOwnerLiveFrameHost").mockReturnValue(captured);
  const abort = signal();
  await expect(createAutomationRecordHost(f.options).capture(input, abort)).resolves.toBe(captured);
  expect(f.service.captureNative).toHaveBeenCalledExactlyOnceWith(binding, abort);
  expect(f.device.captureNative).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledExactlyOnceWith({authenticatedUserId: "owner-1", shareId: scope.shareId,
    storage: f.storage, native: f.native, trustedAccount: {accountId: "owner-1", name: "Owner name"},
    bounds: f.options.bounds, validate: f.options.validate});
});

it("keeps an offline owner pending and retries the device after it reconnects", async () => {
  const f = await setup();
  f.device.captureNative.mockRejectedValueOnce(new Error("Device delivery is unavailable."));
  const record = createAutomationRecordHost(f.options);
  await expect(record.capture(input, signal())).rejects.toMatchObject({message: "Waiting for the owner's device", reason: "engine"});
  f.device.captureNative.mockRejectedValueOnce(new Error("Device delivery is unavailable."));
  await expect(record.capture(input, signal())).rejects.toBeInstanceOf(AutomationRunWait);
  const captured = await record.capture(input, signal());
  cleanup.push(async () => captured.close());
  expect(captured.hostEpoch).toBe(host.hostEpoch);
});

it("keeps a missing configured host pending without hiding a binding failure", async () => {
  const f = await setup();
  await expect(createAutomationRecordHost({...f.options, deviceHost: undefined}).capture(input, signal())).rejects.toBeInstanceOf(AutomationRunWait);
  const failure = new Error("Native registration binding changed.");
  f.device.captureNative.mockRejectedValueOnce(failure);
  await expect(createAutomationRecordHost(f.options).capture(input, signal())).rejects.toBe(failure);
});

it("preserves cancellation when the device is unavailable", async () => {
  const f = await setup(), abort = new AbortController();
  f.device.captureNative.mockImplementationOnce(async () => {abort.abort(new Error("Cancelled")); throw new Error("Device delivery is unavailable.");});
  await expect(createAutomationRecordHost(f.options).capture(input, abort.signal)).rejects.toThrow("Cancelled");
});
