import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { createLiveHostReports } from "./namedLiveHostReports.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import { createLiveTickets } from "./liveTickets.js";
import { audience, binding, fixture, host, key, scope } from "./liveTickets.test-helper.js";
import type { LiveHostConnectionCoordinate } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import { registerLiveDeliveryBaseline } from "./storage/liveDeliveryReservations.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const allow = () => undefined;
const replacement = { ...host, connectionId: "connection-2" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** An authenticated native registration as service and device capture return it. Native sync is not exercised here. */
function nativeHost(change: Partial<Pick<NamedFrameNativeHost, "binding" | "coordinate" | "invalidated">> = {}): NamedFrameNativeHost {
  return { workspace: "native-handle", registrationId: 1, binding: { ...binding, selectorPaths: [binding.currentPath] },
    coordinate: { ...host }, invalidated: new AbortController().signal, changes: createNamedFrameChanges(1),
    deadlineMs: 1000, nextRequestId: () => 1, drain: async () => undefined,
    client: { openLiveAppliedSync: async () => { throw new Error("Native sync is not part of host report tests."); },
      readNextLiveApplied: async () => null, readLiveApplicationAck: async () => null },
    ...change };
}

async function setup() {
  const state = await fixture();
  cleanups.push(() => state.close());
  const captureNative = vi.fn<(binding: LiveObjectBinding, signal: AbortSignal) => Promise<NamedFrameNativeHost>>(async () => nativeHost());
  const reports = createLiveHostReports({ storage: state.storage, captureNative });
  return { ...state, captureNative, reports, tickets: createLiveTickets({ storage: state.storage, audience, key, hostReports: reports }) };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

function beginTransition(f: Fixture) {
  const begun = f.storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: "service-1",
    transitionId: "transition-1", startedAtMs: 3, guard: allow });
  if (!begun.ok || begun.snapshot.transition === null) throw new Error("fixture transition failed");
  return begun.snapshot.transition.transitionGeneration;
}

const ticketCount = (f: Fixture) => f.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_session_tickets").get();

const secondScope = { ...scope, grantId: "edit-2", userId: "reader-2" };
const secondBinding = { ...binding, objectId: "object-2", currentPath: "docs/b.md" };

/** Adds a second current document and a second named editor the way the shared fixture adds the first. */
function addSecondDocumentAndEditor(f: Fixture) {
  f.raw.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
    VALUES (?, ?, 1, 'moment-2', 'main', ?, ?, 'text', 1, 1)`).run(scope.workspaceId, secondBinding.objectId, secondBinding.currentPath, "b".repeat(64));
  const context = f.storage as StorageContext;
  context.tx(() => {
    context.db.prepare(`INSERT INTO sync_relay_live_documents VALUES (?, 'main', ?, ?, NULL, ?, 1, ?, 1, ?, ?, 'current', 'open', 7, 0, NULL)`)
      .run(scope.workspaceId, secondBinding.objectId, secondBinding.lineageClaimId, secondBinding.currentPath, "b".repeat(64),
        secondBinding.lineageClaimId, new Uint8Array([0, 0]));
    registerLiveDeliveryBaseline(context, secondBinding, host.hostId);
  });
  f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES (?, ?, 'user', ?, NULL, 'edit', 4, 'active', 0, NULL, NULL)`).run(secondScope.grantId, scope.shareId, secondScope.userId);
}

// Durable standing that refuses before the native port is asked for a capture.
const refusedBeforeCapture: Record<string, (f: Fixture) => void> = {
  "disconnected host": f => { expect(f.storage.disconnectLiveHost({ ...host, updatedAtMs: 3, guard: allow }).ok).toBe(true); },
  "draining host": f => { beginTransition(f); },
  "activating host": f => {
    const transitionGeneration = beginTransition(f);
    expect(f.storage.commitLiveHostTransitionEpoch({ transitionId: "transition-1", transitionGeneration, updatedAtMs: 4 }).ok).toBe(true);
  },
  "revoked grant": f => f.raw.exec("UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=3"),
  "narrowed grant": f => f.raw.exec("UPDATE sync_relay_share_grants SET access='view'"),
  "retired document": f => f.raw.exec("UPDATE sync_relay_live_documents SET lineage_state='retired', admission_state='closed', retired_at_ms=1000"),
};

const changedDuringCapture: Record<string, (f: Fixture) => void> = {
  ...refusedBeforeCapture,
  "same-epoch reconnect": f => { expect(f.storage.registerLiveHost({ ...replacement, updatedAtMs: 3, guard: allow }).ok).toBe(true); },
  "restore fence": f => f.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1"),
};

it("reports the durable binding stamped with the captured native coordinate", async () => {
  const f = await setup();
  expect(await f.reports.currentBinding(scope, binding.objectId)).toEqual({ connection: host, binding });
  expect(f.captureNative).toHaveBeenLastCalledWith(binding, f.storage.unavailable);
  const request = new AbortController();
  expect(await f.reports.currentBinding(scope, binding.objectId, request.signal)).toEqual({ connection: host, binding });
  expect(f.captureNative).toHaveBeenLastCalledWith(binding, request.signal);
});

it("keeps the reported binding separate from the native port's objects", async () => {
  const f = await setup();
  const native = nativeHost();
  f.captureNative.mockResolvedValueOnce(native);
  const report = await f.reports.currentBinding(scope, binding.objectId);
  (native.binding.selectorPaths as string[]).push("native-change");
  expect(report?.binding.selectorPaths).toEqual(["docs"]);

  f.captureNative.mockImplementationOnce(async received => {
    (received.selectorPaths as string[]).push("port-change");
    return nativeHost();
  });
  expect(await f.reports.currentBinding(scope, binding.objectId)).toBeNull();
});

it("refuses a caller scope changed during capture, while tickets keep their own snapshot", async () => {
  const f = await setup();
  const pending = deferred<NamedFrameNativeHost>();
  f.captureNative.mockReturnValueOnce(pending.promise);
  const context = { ...scope };
  const attempt = f.reports.currentBinding(context, binding.objectId);
  context.userId = "other-user";
  pending.resolve(nativeHost());
  expect(await attempt).toBeNull();

  const ticketPending = deferred<NamedFrameNativeHost>();
  f.captureNative.mockReturnValueOnce(ticketPending.promise);
  const ticketContext = { ...scope };
  const minted = f.tickets.mint({ objectId: binding.objectId }, ticketContext);
  ticketContext.userId = "other-user";
  ticketPending.resolve(nativeHost());
  expect(await minted).not.toBeNull();
});

it("keeps the configured report provider for a pending mint and later requests, under current durable authority", async () => {
  const f = await setup();
  const pending = deferred<NamedFrameNativeHost>();
  f.captureNative.mockReturnValueOnce(pending.promise);
  const minted = f.tickets.mint({ objectId: binding.objectId }, scope);
  expect(f.captureNative).toHaveBeenCalledOnce();
  const hostile = vi.fn<Fixture["reports"]["currentBinding"]>(async () => ({ connection: host, binding }));
  f.reports.currentBinding = hostile;
  pending.resolve(nativeHost());
  const first = await minted;
  expect(first).not.toBeNull();

  expect(await f.tickets.redeem(first!.token, scope)).toMatchObject({ binding });
  expect(f.captureNative).toHaveBeenCalledTimes(2);

  f.raw.exec("UPDATE sync_relay_share_grants SET access='view'");
  expect(await f.tickets.mint({ objectId: binding.objectId }, scope)).toBeNull();
  expect(f.captureNative).toHaveBeenCalledTimes(2);
  expect(hostile).not.toHaveBeenCalled();
  expect(ticketCount(f)).toEqual({ count: 1 });
});

it("refuses a malformed ticket scope before reading it or capturing a native host", async () => {
  const f = await setup();
  const getter = vi.fn(() => scope.workspaceId);
  const malformed = Object.defineProperty({ ...scope }, "workspaceId", { get: getter });
  expect(await f.tickets.mint({ objectId: binding.objectId }, malformed)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(f.captureNative).not.toHaveBeenCalled();
});

it.each(Object.keys(refusedBeforeCapture))("refuses a %s before native capture", async name => {
  const f = await setup();
  refusedBeforeCapture[name]!(f);
  expect(await f.reports.currentBinding(scope, binding.objectId)).toBeNull();
  expect(f.captureNative).not.toHaveBeenCalled();
});

it("refuses a never-provisioned host before native capture while every other authority stays valid", async () => {
  const f = await setup();
  f.raw.exec("DELETE FROM sync_relay_session_host_control");
  expect(f.storage.getLiveHostControl()).toBeNull();
  expect(await f.reports.currentBinding(scope, binding.objectId)).toBeNull();
  expect(await f.tickets.mint({ objectId: binding.objectId }, scope)).toBeNull();
  expect(f.captureNative).not.toHaveBeenCalled();
  expect(f.storage.provisionLiveHostControl({ ...host, updatedAtMs: 3, guard: allow }).ok).toBe(true);
  expect(f.storage.registerLiveHost({ ...host, updatedAtMs: 4, guard: allow }).ok).toBe(true);
  expect(await f.reports.currentBinding(scope, binding.objectId)).toEqual({ connection: host, binding });
});

it.each(Object.keys(changedDuringCapture))("rechecks durable standing after capture: %s", async name => {
  const f = await setup();
  const pending = deferred<NamedFrameNativeHost>();
  f.captureNative.mockReturnValueOnce(pending.promise);
  const attempt = f.reports.currentBinding(scope, binding.objectId);
  changedDuringCapture[name]!(f);
  pending.resolve(nativeHost());
  expect(await attempt).toBeNull();
  expect(f.captureNative).toHaveBeenCalledOnce();
});

it.each<[string, Partial<LiveObjectBinding>]>([
  ["workspace", { workspaceId: "workspace-2" }], ["main version", { mainVersionId: "side" }],
  ["object", { objectId: "object-2" }], ["lineage", { lineageClaimId: "c".repeat(64) }],
  ["path", { currentPath: "docs/b.md" }], ["restore fence", { restoreFenceGeneration: 8 }],
])("refuses a native capture for a different %s", async (_name, change) => {
  const f = await setup();
  f.captureNative.mockResolvedValueOnce(nativeHost({ binding: { ...binding, ...change } }));
  expect(await f.reports.currentBinding(scope, binding.objectId)).toBeNull();
});

it.each<[string, Partial<LiveHostConnectionCoordinate>]>([
  ["mode", { mode: "service" }], ["host", { hostId: "other" }], ["epoch", { hostEpoch: parseHostEpoch(2) }],
  ["instance", { instanceId: "other" }], ["connection", { connectionId: "other" }],
])("refuses a native capture from a different %s", async (_name, change) => {
  const f = await setup();
  f.captureNative.mockResolvedValueOnce(nativeHost({ coordinate: { ...host, ...change } }));
  expect(await f.reports.currentBinding(scope, binding.objectId)).toBeNull();
});

it("refuses an invalidated native registration", async () => {
  const f = await setup();
  f.captureNative.mockResolvedValueOnce(nativeHost({ invalidated: AbortSignal.abort() }));
  expect(await f.reports.currentBinding(scope, binding.objectId)).toBeNull();
});

it.each(["old incarnation invalidated", "old incarnation still live", "new incarnation"])(
  "refuses a capture spanning a same-epoch reconnect, then reports the fresh incarnation: %s", async returned => {
    const f = await setup();
    const pending = deferred<NamedFrameNativeHost>();
    const oldIncarnation = new AbortController();
    f.captureNative.mockReturnValueOnce(pending.promise);
    const first = f.reports.currentBinding(scope, binding.objectId);
    if (returned === "old incarnation invalidated") oldIncarnation.abort();
    expect(f.storage.registerLiveHost({ ...replacement, updatedAtMs: 3, guard: allow }).ok).toBe(true);
    pending.resolve(returned === "new incarnation" ? nativeHost({ coordinate: replacement }) : nativeHost({ invalidated: oldIncarnation.signal }));
    expect(await first).toBeNull();
    f.captureNative.mockResolvedValueOnce(nativeHost({ coordinate: replacement }));
    expect(await f.reports.currentBinding(scope, binding.objectId)).toEqual({ connection: replacement, binding });
  },
);

it.each([false, true])("correlates two authorized documents whose captures finish in reverse order; swapped=%s", async swapped => {
  const f = await setup();
  addSecondDocumentAndEditor(f);
  const first = deferred<NamedFrameNativeHost>(), second = deferred<NamedFrameNativeHost>();
  f.captureNative.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a = new AbortController(), b = new AbortController();
  const reportA = f.reports.currentBinding(scope, binding.objectId, a.signal);
  const reportB = f.reports.currentBinding(secondScope, secondBinding.objectId, b.signal);
  expect(f.captureNative).toHaveBeenNthCalledWith(1, binding, a.signal);
  expect(f.captureNative).toHaveBeenNthCalledWith(2, secondBinding, b.signal);
  const nativeA = nativeHost(), nativeB = nativeHost({ binding: { ...secondBinding, selectorPaths: [secondBinding.currentPath] } });
  second.resolve(swapped ? nativeA : nativeB);
  first.resolve(swapped ? nativeB : nativeA);
  expect(await reportB).toEqual(swapped ? null : { connection: host, binding: secondBinding });
  expect(await reportA).toEqual(swapped ? null : { connection: host, binding });
});

it("holds no writer lock while native capture waits", async () => {
  const f = await setup();
  const pending = deferred<NamedFrameNativeHost>();
  f.captureNative.mockReturnValueOnce(pending.promise);
  const attempt = f.reports.currentBinding(scope, binding.objectId);
  f.raw.exec("PRAGMA busy_timeout=0");
  expect(() => f.raw.exec("BEGIN IMMEDIATE; UPDATE sync_relay_session_host_control SET admission_state='closed', registered_connection_id=NULL; COMMIT")).not.toThrow();
  pending.resolve(nativeHost());
  expect(await attempt).toBeNull();
});

it("cancels capture when relay storage retires and refuses the late native host", async () => {
  const state = await fixture();
  try {
    const pending = deferred<NamedFrameNativeHost>();
    let captureSignal: AbortSignal | undefined;
    const reports = createLiveHostReports({ storage: state.storage, captureNative: async (_binding, signal) => {
      captureSignal = signal;
      return pending.promise;
    } });
    const attempt = reports.currentBinding(scope, binding.objectId);
    state.storage.close();
    expect(captureSignal?.aborted).toBe(true);
    pending.resolve(nativeHost());
    await expect(attempt).rejects.toThrow();
  } finally {
    state.raw.close();
    await rm(dirname(state.path), { recursive: true, force: true });
  }
});

it("surfaces native capture failure as an error, kept internal at the ticket boundary", async () => {
  const f = await setup();
  const secret = "native-private-payload";
  f.captureNative.mockRejectedValueOnce(new Error(secret));
  await expect(f.reports.currentBinding(scope, binding.objectId)).rejects.toThrow(secret);
  f.captureNative.mockRejectedValueOnce(new Error(secret));
  const error = await f.tickets.mint({ objectId: binding.objectId }, scope).catch((value: unknown) => value);
  if (!(error instanceof Error)) throw new Error("Expected an internal failure");
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
  expect(error.cause).toBeUndefined();
  expect(ticketCount(f)).toEqual({ count: 0 });
});

it.each(["before capture", "during capture", "after an ignored abort"] as const)(
  "mints nothing when the ticket request is cancelled %s", async when => {
    const f = await setup();
    const request = new AbortController();
    if (when === "before capture") request.abort();
    if (when === "during capture") {
      f.captureNative.mockImplementationOnce((_binding, signal) => new Promise<NamedFrameNativeHost>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    }
    if (when === "after an ignored abort") {
      f.captureNative.mockImplementationOnce(async () => { request.abort(); return nativeHost(); });
    }
    const minted = f.tickets.mint({ objectId: binding.objectId }, scope, request.signal);
    if (when === "during capture") request.abort();
    await expect(minted).rejects.toThrow();
    expect(f.captureNative).toHaveBeenCalledTimes(when === "before capture" ? 0 : 1);
    expect(ticketCount(f)).toEqual({ count: 0 });
  },
);

it.each(["mint", "redeem"] as const)("ticket %s refuses a report whose host was replaced before commit", async operation => {
  const f = await setup();
  const existing = operation === "redeem" ? await f.tickets.mint({ objectId: binding.objectId }, scope) : null;
  const racing = createLiveTickets({ storage: f.storage, audience, key, hostReports: { currentBinding: async (context, objectId, signal) => {
    const report = await f.reports.currentBinding(context, objectId, signal);
    expect(report).not.toBeNull();
    expect(f.storage.registerLiveHost({ ...replacement, updatedAtMs: 3, guard: allow }).ok).toBe(true);
    return report;
  } } });
  const result = operation === "mint" ? await racing.mint({ objectId: binding.objectId }, scope) : await racing.redeem(existing!.token, scope);
  expect(result).toBeNull();
  f.captureNative.mockResolvedValue(nativeHost({ coordinate: replacement }));
  if (operation === "mint") expect(await f.tickets.mint({ objectId: binding.objectId }, scope)).not.toBeNull();
  else expect(await f.tickets.redeem(existing!.token, scope)).not.toBeNull();
});

it("ticket authority narrowed after report collection refuses at commit", async () => {
  const f = await setup();
  const service = createLiveTickets({ storage: f.storage, audience, key, hostReports: { currentBinding: async (context, objectId, signal) => {
    const report = await f.reports.currentBinding(context, objectId, signal);
    expect(report).not.toBeNull();
    f.raw.exec("UPDATE sync_relay_share_grants SET access='view'");
    return report;
  } } });
  expect(await service.mint({ objectId: binding.objectId }, scope)).toBeNull();
  expect(ticketCount(f)).toEqual({ count: 0 });
});
