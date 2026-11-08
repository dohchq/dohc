import {beforeEach, expect, it, vi} from "vitest";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createDeviceLiveDelivery} from "./deviceLiveDelivery.js";
import {createNamedFrameChanges} from "./liveHostChanges.js";

const state = vi.hoisted(() => ({
  event: undefined as undefined | ((event: {name: string; payload: unknown}) => void),
  dispose: vi.fn(), drain: vi.fn(), settle: vi.fn(), settleWanted: vi.fn(), restore: vi.fn(), madeOwner: false,
  registration: undefined as unknown, seedApplied: vi.fn(),
}));
vi.mock("@dohc/workspace-engine-client/daemon", async importOriginal => ({
  ...await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>(),
  EngineClient: class {
    constructor(_connection: unknown, private options: {authToken: string}) {}
    onEvent(handler: typeof state.event) {state.event = handler; return state.dispose;}
    async ready() {}
    async sendRequest() {return {result: {relayNamespace: "namespace", host: {hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection"},
      workspaces: [{workspaceId: "workspace", workspaceHandle: "handle"}], ownerSessions: {maxBytes: 100, maxEvents: 1}}};}
    close() {}
  },
}));
vi.mock("./ownerCommittedDelivery.js", () => ({OwnerCommittedDelivery: class {
  workspace = "handle";
  constructor() {state.madeOwner = true;}
  captureRegistration() {return state.registration;}
  captureDocumentRegistration() {return state.registration;}
  adoptionSeedApplied(...args: unknown[]) {return state.seedApplied(...args);}
  documentForRestore() {return {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64)};}
  drain(...args: unknown[]) {return state.drain(...args);}
  settle(...args: unknown[]) {return state.settle(...args);}
  settleWanted(...args: unknown[]) {return state.settleWanted(...args);}
  stopRestore(...args: unknown[]) {return state.restore(...args);}
  prepareRestore(...args: unknown[]) {return state.restore(...args);}
  completeRestore(...args: unknown[]) {return state.restore(...args);}
}}));

const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const document = {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {promise: new Promise<T>(done => {resolve = done;}), resolve: (value: T) => resolve(value)};
}
beforeEach(() => {
  vi.clearAllMocks(); state.madeOwner = false;
  state.drain.mockReset().mockResolvedValue({kind: "done", terminalReceipt: null, continueDrain: false});
  state.settle.mockReset().mockResolvedValue({materialized: true});
  state.settleWanted.mockReset().mockResolvedValue({materialized: true});
  state.seedApplied.mockReset().mockReturnValue(true);
});
async function fixture(changes = createNamedFrameChanges(16)) {
  const lifetime = new AbortController(), notify = vi.spyOn(changes, "notify"), stop = vi.fn();
  state.registration = {id: 9, binding, invalidated: lifetime.signal};
  const limits = {maxPayloadBytes: 4096, maxPendingBytes: 2_000_000};
  const delivery = createDeviceLiveDelivery({
    ws: {readyState: 1, bufferedAmount: 0, send(_bytes: unknown, options: unknown, done?: () => void) {if (typeof options === "function") options(); else done?.();}} as never,
    limits: limits as never, config: {version: 1, workspaceIds: ["workspace"], maxActiveDrains: 1, maxQueuedBytes: 2_000_000,
      client: {maxFrameBytes: 1_048_576, aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000}} as never,
    storage: {} as never, history: {namespace: "namespace", reconciled: true} as never,
    host: {hostId: "host", hostEpoch: parseHostEpoch(1), instanceId: "instance", connectionId: "connection", mode: "device"},
    ownerAdmission: {} as never, frameChanges: changes, isCurrent: () => true, stop,
  });
  delivery.receive(Buffer.from(JSON.stringify({type: "liveHost.transport", version: 1, receive: limits})), false);
  await expect.poll(() => state.madeOwner).toBe(true);
  return {delivery, lifetime, notify, stop, wake: (payload: unknown = {registrationId: 9, binding}) => state.event!({name: "liveApplication.ownerOutboxChanged", payload})};
}

it("wakes document and desktop listeners when the device becomes ready and closes", async () => {
  const changes = createNamedFrameChanges(16), becameReady = deferred<void>();
  const documentWake = vi.fn(() => becameReady.resolve()), desktopWake = vi.fn();
  changes.subscribe(documentWake, document);
  changes.subscribe(desktopWake, {workspaceId: binding.workspaceId, objectId: "waiting-object"});
  const f = await fixture(changes);
  try {
    await becameReady.promise;
    expect(documentWake).toHaveBeenCalledOnce(); expect(desktopWake).toHaveBeenCalledOnce();
    expect(f.stop).not.toHaveBeenCalled();
    f.delivery.close();
    await new Promise<void>(queueMicrotask);
    expect(documentWake).toHaveBeenCalledTimes(2); expect(desktopWake).toHaveBeenCalledTimes(2);
  } finally {f.delivery.close();}
});

it("autonomously drains durable owner notices and wakes an already-open frame subscriber", async () => {
  const f = await fixture();
  try {
    const captured = await f.delivery.captureNative(binding);
    expect(captured.changes.notify).toBe(f.notify);
    state.drain.mockClear(); f.notify.mockClear();
    f.wake(); await expect.poll(() => state.drain.mock.calls.length).toBe(1);
    await expect.poll(() => f.notify.mock.calls.length).toBe(1);
    expect(state.drain.mock.calls[0]![0]).toEqual(document);
    f.wake({registrationId: 9, binding: {...binding, selectorPaths: ["a.md", "b.md"]}});
    f.wake({registrationId: 10, binding});
    await Promise.resolve(); expect(state.drain).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {f.delivery.close();}
  expect(state.dispose).toHaveBeenCalledTimes(1);
});

it("starts no frame stream before the adoption's seed applies, then starts one while later work is still pending", async () => {
  const f = await fixture();
  const pending = {kind: "pending", reason: "Owner delivery pass reached its work budget.", continueDrain: false};
  try {
    // The adoption's seed is still queued: validation asked to retry.
    state.drain.mockResolvedValueOnce(pending);
    state.seedApplied.mockReturnValueOnce(false);
    await expect(f.delivery.captureNative(binding)).rejects.toThrow("The host has not applied the owner's adopted document yet.");
    // The seed applied; later private work and the remote budget still leave the pass pending.
    state.drain.mockResolvedValueOnce(pending);
    const captured = await f.delivery.captureNative(binding);
    expect(captured).toMatchObject({registrationId: 9, binding, workspace: "handle"});
    expect(state.drain).toHaveBeenCalledTimes(2);
    expect(state.seedApplied.mock.calls).toEqual([[document], [document]]);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {f.delivery.close();}
});

it("asks for seed readiness only after the pass and recheck, and keeps their errors first", async () => {
  const f = await fixture();
  try {
    state.drain.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(f.delivery.captureNative(binding)).rejects.toThrow("native unavailable");
    expect(state.seedApplied).not.toHaveBeenCalled();
    const caller = new AbortController();
    state.drain.mockImplementationOnce(async () => {caller.abort(new Error("caller left")); throw caller.signal.reason;});
    await expect(f.delivery.captureNative(binding, caller.signal)).rejects.toThrow("caller left");
    expect(state.seedApplied).not.toHaveBeenCalled();
  } finally {f.delivery.close();}
});

it("waits for the owner pass before a named drain or settlement acquires the same document", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<unknown>();
  try {
    state.drain.mockImplementationOnce(async () => {entered.resolve(); return release.promise;});
    f.wake(); await entered.promise;
    const named = f.delivery.drain(document), settled = f.delivery.settle(document);
    expect(state.drain).toHaveBeenCalledTimes(1); expect(state.settle).not.toHaveBeenCalled();
    release.resolve({kind: "done", terminalReceipt: null, continueDrain: false});
    await named; await settled;
    expect(state.drain).toHaveBeenCalledTimes(2); expect(state.settle).toHaveBeenCalledTimes(1);
  } finally {release.resolve({kind: "done", continueDrain: false}); f.delivery.close();}
});

// Proves: the owner's settlement request, as after consenting to a held write,
// settles past the settlement an ordinary settle reuses.
it("settles an owner's settlement request through settleWanted", async () => {
  const f = await fixture();
  try {
    state.event!({name: "liveApplication.settlementWanted", payload: {registrationId: 9, binding}});
    await expect.poll(() => state.settleWanted.mock.calls.length).toBe(1);
    expect(state.settleWanted.mock.calls[0]![0]).toEqual(document);
    expect(state.settle).not.toHaveBeenCalled(); expect(state.drain).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  } finally {f.delivery.close();}
});

it("carries bounded continuation and drops a dirty registration invalidated before its next pass", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<unknown>();
  try {
    state.drain.mockResolvedValueOnce({kind: "pending", continueDrain: true})
      .mockImplementationOnce(async () => {entered.resolve(); return release.promise;});
    f.wake(); await entered.promise;
    expect(state.drain).toHaveBeenCalledTimes(2);
    f.wake(); f.lifetime.abort(); release.resolve({kind: "done", continueDrain: false});
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(state.drain).toHaveBeenCalledTimes(2);
  } finally {release.resolve({kind: "done", continueDrain: false}); f.delivery.close();}
});
