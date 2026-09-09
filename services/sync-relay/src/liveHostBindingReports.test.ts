import { expect, it, vi } from "vitest";
import { parseHostEpoch, type HostControlSnapshot } from "@dohc/live-session-contract/host-control";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { createLiveHostBindingReports, type HeldLiveHostConnection } from "./liveHostBindingReports.js";
import { createLiveTickets } from "./liveTickets.js";
import { audience, binding, fixture, host, key, scope } from "./liveTickets.test-helper.js";
import type { LiveBrowserContext } from "./liveBrowserContext.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const invalidation = new AbortController();
  const request = vi.fn<(context: LiveBrowserContext, objectId: string) => Promise<LiveObjectBinding | null>>(
    async () => structuredClone(binding),
  );
  const handle: HeldLiveHostConnection = { coordinate: { ...host }, invalidated: invalidation.signal, requestBinding: request };
  let current: HeldLiveHostConnection | null = handle;
  let durable: HostControlSnapshot | null = {
    configuredMode: host.mode, configuredHostId: host.hostId, hostEpoch: host.hostEpoch, admissionState: "open",
    registeredInstanceId: host.instanceId, registeredConnectionId: host.connectionId, updatedAtMs: 1,
    lastTransitionGeneration: null, lastCompletedTransitionId: null, transition: null,
  };
  const connections = { current: vi.fn(() => current) };
  const storage = { getLiveHostControl: vi.fn(() => durable) };
  return { invalidation, request, handle, connections, storage,
    adapter: createLiveHostBindingReports({ connections, storage }),
    get durable() { return durable; },
    setDurable(value: HostControlSnapshot | null) { durable = value; },
    setCurrent(value: HeldLiveHostConnection | null) { current = value; },
  };
}

it("returns an owned binding report stamped with the held authenticated connection", async () => {
  const state = setup();
  expect(await state.adapter.currentBinding(scope, binding.objectId)).toEqual({ connection: host, binding });
  expect(state.request).toHaveBeenCalledExactlyOnceWith(scope, binding.objectId);
  expect(state.storage.getLiveHostControl).toHaveBeenCalledTimes(2);
});

it("captures caller, coordinate, and dependency methods before awaiting", async () => {
  const state = setup();
  const pending = deferred<LiveObjectBinding | null>();
  state.request.mockImplementationOnce(async function (this: HeldLiveHostConnection, context) {
    expect(this).toBe(state.handle);
    (context as { userId: string }).userId = "changed-by-port";
    return pending.promise;
  });
  const context = { ...scope };
  const response = structuredClone(binding);
  const attempt = state.adapter.currentBinding(context, binding.objectId);
  context.workspaceId = "changed-by-caller";
  (state.handle.coordinate as { connectionId: string }).connectionId = "changed-coordinate";
  Object.assign(state.connections, { current: () => { throw new Error("changed dependency"); } });
  Object.assign(state.storage, { getLiveHostControl: () => { throw new Error("changed dependency"); } });
  pending.resolve(response);
  const result = await attempt;
  expect(result).toEqual({ connection: host, binding });
  response.selectorPaths.push("other");
  expect(result!.binding.selectorPaths).toEqual(["docs"]);
  (result!.binding.selectorPaths as string[]).push("result-change");
  expect(response.selectorPaths).toEqual(["docs", "other"]);
});

it.each(["missing handle", "invalidated", "missing durable", "closed", "draining", "activating", "null instance", "null connection"])(
  "refuses %s before requesting a binding", async reason => {
    const state = setup();
    if (reason === "missing handle") state.setCurrent(null);
    else if (reason === "invalidated") state.invalidation.abort();
    else if (reason === "missing durable") state.setDurable(null);
    else if (reason === "null instance") state.setDurable({ ...state.durable!, registeredInstanceId: null });
    else if (reason === "null connection") state.setDurable({ ...state.durable!, registeredConnectionId: null });
    else if (reason === "closed" || reason === "draining") state.setDurable({ ...state.durable!, admissionState: reason });
    else state.setDurable({ ...state.durable!, transition: { phase: "activating" } as NonNullable<HostControlSnapshot["transition"]> });
    expect(await state.adapter.currentBinding(scope, binding.objectId)).toBeNull();
    expect(state.request).not.toHaveBeenCalled();
  },
);

const durableChanges = [
  ["mode", { configuredMode: "service" }], ["host", { configuredHostId: "other" }],
  ["epoch", { hostEpoch: parseHostEpoch(2) }], ["instance", { registeredInstanceId: "other" }],
  ["connection", { registeredConnectionId: "other" }],
] as const;

it.each(durableChanges)("checks durable %s before the host request", async (_name, change) => {
  const state = setup();
  state.setDurable({ ...state.durable!, ...change });
  expect(await state.adapter.currentBinding(scope, binding.objectId)).toBeNull();
  expect(state.request).not.toHaveBeenCalled();
});

it.each(durableChanges)("checks durable %s after the host response", async (_name, change) => {
  const state = setup();
  const pending = deferred<LiveObjectBinding | null>();
  state.request.mockReturnValueOnce(pending.promise);
  const attempt = state.adapter.currentBinding(scope, binding.objectId);
  state.setDurable({ ...state.durable!, ...change });
  pending.resolve(binding);
  expect(await attempt).toBeNull();
  expect(state.request).toHaveBeenCalledOnce();
});

it.each(["missing durable", "closed", "draining", "activating", "null instance", "null connection"])(
  "refuses %s after the host response", async reason => {
    const state = setup();
    const pending = deferred<LiveObjectBinding | null>();
    state.request.mockReturnValueOnce(pending.promise);
    const attempt = state.adapter.currentBinding(scope, binding.objectId);
    if (reason === "missing durable") state.setDurable(null);
    else if (reason === "null instance") state.setDurable({ ...state.durable!, registeredInstanceId: null });
    else if (reason === "null connection") state.setDurable({ ...state.durable!, registeredConnectionId: null });
    else if (reason === "closed" || reason === "draining") state.setDurable({ ...state.durable!, admissionState: reason });
    else state.setDurable({ ...state.durable!, transition: { phase: "activating" } as NonNullable<HostControlSnapshot["transition"]> });
    pending.resolve(binding);
    expect(await attempt).toBeNull();
  },
);

it.each(["invalidate", "replace"])("rechecks handle after final durable read: %s", async change => {
  const state = setup();
  state.storage.getLiveHostControl.mockImplementationOnce(() => state.durable).mockImplementationOnce(() => {
    if (change === "invalidate") state.invalidation.abort();
    else state.setCurrent({ ...state.handle });
    return state.durable;
  });
  expect(await state.adapter.currentBinding(scope, binding.objectId)).toBeNull();
});

it("refuses malformed caller input before touching runtime or storage", async () => {
  const state = setup();
  const getter = vi.fn(() => scope.workspaceId);
  const malformed = Object.defineProperty({ ...scope }, "workspaceId", { get: getter });
  expect(await state.adapter.currentBinding(malformed, binding.objectId)).toBeNull();
  expect(await state.adapter.currentBinding(scope, "")).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(state.connections.current).not.toHaveBeenCalled();
  expect(state.storage.getLiveHostControl).not.toHaveBeenCalled();
});

it("rejects inherited, accessor, proxy, extra and hostile-array responses without invocation", async () => {
  const state = setup();
  const trap = vi.fn(() => "docs");
  const selectors = ["docs"];
  Object.defineProperty(selectors, "0", { get: trap });
  const responses = [
    Object.create(binding), { ...binding, connection: { ...host, connectionId: "forged" } },
    Object.defineProperty({ ...binding }, "objectId", { get: trap }),
    new Proxy(binding, { ownKeys() { trap(); return Reflect.ownKeys(binding); } }),
    { ...binding, selectorPaths: selectors }, { ...binding, currentPath: "docs//a.md" },
  ];
  for (const response of responses) {
    state.request.mockResolvedValueOnce(response);
    expect(await state.adapter.currentBinding(scope, binding.objectId)).toBeNull();
  }
  expect(trap).not.toHaveBeenCalled();
});

it.each([
  ["workspace", { workspaceId: "other" }], ["object", { objectId: "other" }],
  ["main", { mainVersionId: "other" }], ["zero fence", { restoreFenceGeneration: 0 }],
  ["lineage", { lineageClaimId: "invalid" }],
])("rejects wrong response %s", async (_name, change) => {
  const state = setup();
  state.request.mockResolvedValueOnce({ ...binding, ...change });
  expect(await state.adapter.currentBinding(scope, binding.objectId)).toBeNull();
});

it.each(["resolve", "reject"] as const)("invalidation completes a pending request before its late %s", async ending => {
  const state = setup();
  const pending = deferred<LiveObjectBinding | null>();
  state.request.mockReturnValueOnce(pending.promise);
  const add = vi.spyOn(state.invalidation.signal, "addEventListener");
  const remove = vi.spyOn(state.invalidation.signal, "removeEventListener");
  const attempt = state.adapter.currentBinding(scope, binding.objectId);
  state.invalidation.abort();
  expect(await attempt).toBeNull();
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
  if (ending === "resolve") pending.resolve(binding);
  else pending.reject(new Error("late transport failure"));
  await pending.promise.catch(() => undefined);
});

it("uses the fresh same-epoch incarnation after refusing the old pending request", async () => {
  const state = setup();
  const pending = deferred<LiveObjectBinding | null>();
  state.request.mockReturnValueOnce(pending.promise);
  const first = state.adapter.currentBinding(scope, binding.objectId);
  state.invalidation.abort();
  const replacement: HeldLiveHostConnection = { ...state.handle, coordinate: { ...host, connectionId: "connection-2" },
    invalidated: new AbortController().signal };
  expect(replacement.coordinate.connectionId).not.toBe(host.connectionId);
  state.setCurrent(replacement);
  state.setDurable({ ...state.durable!, registeredConnectionId: "connection-2" });
  expect(await first).toBeNull();
  pending.resolve(binding);
  expect(await state.adapter.currentBinding(scope, binding.objectId)).toEqual({ connection: replacement.coordinate, binding });
});

it.each(["different object", "reexposed old object"])("defensively rejects pending handle ABA: %s", async mode => {
  const state = setup();
  const pending = deferred<LiveObjectBinding | null>();
  state.request.mockReturnValueOnce(pending.promise);
  const attempt = state.adapter.currentBinding(scope, binding.objectId);
  // These deliberately broken runtime fixtures are not permitted reconnect identities.
  if (mode === "different object") state.setCurrent({ ...state.handle });
  else { state.invalidation.abort(); state.setCurrent({ ...state.handle }); state.setCurrent(state.handle); }
  pending.resolve(binding);
  expect(await attempt).toBeNull();
});

it.each([false, true])("correlates simultaneous reverse-order responses; swapped=%s", async swapped => {
  const state = setup();
  const first = deferred<LiveObjectBinding | null>();
  const second = deferred<LiveObjectBinding | null>();
  state.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const otherScope = { kind: "named" as const, workspaceId: "workspace-2", shareId: "share-2", grantId: "grant-2", userId: "user-2" };
  const other = { ...binding, workspaceId: otherScope.workspaceId, objectId: "object-2", currentPath: "docs/b.md" };
  const a = state.adapter.currentBinding(scope, binding.objectId);
  const b = state.adapter.currentBinding(otherScope, other.objectId);
  expect(state.request).toHaveBeenNthCalledWith(1, scope, binding.objectId);
  expect(state.request).toHaveBeenNthCalledWith(2, otherScope, other.objectId);
  second.resolve(swapped ? binding : other);
  first.resolve(swapped ? other : binding);
  expect(await a).toEqual(swapped ? null : { connection: host, binding });
  expect(await b).toEqual(swapped ? null : { connection: host, binding: other });
});

it("keeps runtime/storage errors internal and null binding ordinary", async () => {
  const state = setup();
  state.request.mockResolvedValueOnce(null);
  expect(await state.adapter.currentBinding(scope, binding.objectId)).toBeNull();
  const secret = "transport-private-payload";
  for (const dependency of [state.request, state.storage.getLiveHostControl, state.connections.current]) {
    dependency.mockImplementationOnce(() => { throw new Error(secret); });
    const error = await state.adapter.currentBinding(scope, binding.objectId).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: Live host binding report failed.");
    expect(error.cause).toBeUndefined();
  }
});

it("removes invalidation listeners after success and request rejection", async () => {
  const state = setup();
  const add = vi.spyOn(state.invalidation.signal, "addEventListener");
  const remove = vi.spyOn(state.invalidation.signal, "removeEventListener");
  await state.adapter.currentBinding(scope, binding.objectId);
  state.request.mockRejectedValueOnce(new Error("request failed"));
  await expect(state.adapter.currentBinding(scope, binding.objectId)).rejects.toThrow("Live host binding report failed");
  expect(add).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledTimes(2);
  expect(remove.mock.calls.map(call => call[1])).toEqual(add.mock.calls.map(call => call[1]));
});

it.each(["mint", "redeem"] as const)("ticket %s refuses replacement after report return before ticket continuation", async operation => {
  const state = await fixture();
  try {
    const invalidation = new AbortController();
    let current: HeldLiveHostConnection = { coordinate: host, invalidated: invalidation.signal, requestBinding: async () => binding };
    const adapter = createLiveHostBindingReports({ storage: state.storage, connections: { current: () => current } });
    const direct = createLiveTickets({ storage: state.storage, audience, key, hostReports: adapter });
    const existing = operation === "redeem" ? await direct.mint({ objectId: binding.objectId }, scope) : null;
    const connection = { ...host, connectionId: "connection-2" };
    const racing = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: async (context, objectId) => {
      const oldReport = await adapter.currentBinding(context, objectId);
      expect(oldReport).not.toBeNull();
      invalidation.abort();
      expect(connection.connectionId).not.toBe(current.coordinate.connectionId);
      expect(state.storage.registerLiveHost({ ...connection, updatedAtMs: 3, guard: () => undefined }).ok).toBe(true);
      current = { coordinate: connection, invalidated: new AbortController().signal, requestBinding: async () => binding };
      return oldReport;
    } } });
    const result = operation === "mint" ? await racing.mint({ objectId: binding.objectId }, scope) : await racing.redeem(existing!.token, scope);
    expect(result).toBeNull();
    if (operation === "mint") expect(await direct.mint({ objectId: binding.objectId }, scope)).not.toBeNull();
    else expect(await direct.redeem(existing!.token, scope)).not.toBeNull();
  } finally { await state.close(); }
});

it("ticket authority changes after report collection still refuse at commit", async () => {
  const state = await fixture();
  try {
    const handle: HeldLiveHostConnection = { coordinate: host, invalidated: new AbortController().signal, requestBinding: async () => binding };
    const adapter = createLiveHostBindingReports({ storage: state.storage, connections: { current: () => handle } });
    const service = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: async (context, objectId) => {
      const report = await adapter.currentBinding(context, objectId);
      state.raw.exec("UPDATE sync_relay_share_grants SET access='view'");
      return report;
    } } });
    expect(await service.mint({ objectId: binding.objectId }, scope)).toBeNull();
  } finally { await state.close(); }
});

it("holds no writer lock while a host request waits", async () => {
  const state = await fixture();
  try {
    const pending = deferred<LiveObjectBinding | null>();
    const handle: HeldLiveHostConnection = { coordinate: host, invalidated: new AbortController().signal, requestBinding: () => pending.promise };
    const adapter = createLiveHostBindingReports({ storage: state.storage, connections: { current: () => handle } });
    const attempt = adapter.currentBinding(scope, binding.objectId);
    state.raw.exec("PRAGMA busy_timeout=0");
    expect(() => state.raw.exec("BEGIN IMMEDIATE; UPDATE sync_relay_session_host_control SET admission_state='closed', registered_connection_id=NULL; COMMIT")).not.toThrow();
    pending.resolve(binding);
    expect(await attempt).toBeNull();
  } finally { await state.close(); }
});
