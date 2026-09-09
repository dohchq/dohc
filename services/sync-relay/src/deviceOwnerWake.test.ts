import {beforeEach, expect, it, vi} from "vitest";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createDeviceLiveDelivery} from "./deviceLiveDelivery.js";

const state = vi.hoisted(() => ({
  event: undefined as undefined | ((event: {name: string; payload: unknown}) => void),
  dispose: vi.fn(), drain: vi.fn(), settle: vi.fn(), restore: vi.fn(), madeOwner: false,
  registration: undefined as unknown,
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
  documentForRestore() {return {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64)};}
  drain(...args: unknown[]) {return state.drain(...args);}
  settle(...args: unknown[]) {return state.settle(...args);}
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
});
async function fixture() {
  const lifetime = new AbortController(), notify = vi.fn(), stop = vi.fn();
  state.registration = {id: 9, binding, invalidated: lifetime.signal};
  const limits = {maxPayloadBytes: 4096, maxPendingBytes: 2_000_000};
  const delivery = createDeviceLiveDelivery({
    ws: {readyState: 1, bufferedAmount: 0, send(_bytes: unknown, options: unknown, done?: () => void) {if (typeof options === "function") options(); else done?.();}} as never,
    limits: limits as never, config: {version: 1, workspaceIds: ["workspace"], maxActiveDrains: 1, maxQueuedBytes: 2_000_000,
      client: {maxFrameBytes: 1_048_576, aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000}} as never,
    storage: {} as never, history: {namespace: "namespace", reconciled: true} as never,
    host: {hostId: "host", hostEpoch: parseHostEpoch(1), instanceId: "instance", connectionId: "connection", mode: "device"},
    ownerAdmission: {} as never, frameChanges: {notify, subscribe: () => () => {}}, isCurrent: () => true, stop,
  });
  delivery.receive(Buffer.from(JSON.stringify({type: "liveHost.transport", version: 1, receive: limits})), false);
  await expect.poll(() => state.madeOwner).toBe(true);
  return {delivery, lifetime, notify, stop, wake: (payload: unknown = {registrationId: 9, binding}) => state.event!({name: "liveApplication.ownerOutboxChanged", payload})};
}

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
