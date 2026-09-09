import {afterEach, expect, it, vi} from "vitest";
import {EngineRequestDeadlineError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import {queueLiveHostRequests} from "./liveHostRequests.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {promise: new Promise<T>(done => {resolve = done;}), resolve: (value: T) => resolve(value)};
}
const request = (id: number) => ({id, method: "liveApplication.settle", params: {}, workspace: "workspace", registrationId: 7, deadlineMs: 1000});
const position = {eventCount: 0, journalCursor: 0, evidenceDigest: "a".repeat(64)};
function fixture(maxPending = 4, maxRetainedInputBytes = 1_000_000) {
  const lifetime = new AbortController(), seen: number[] = [];
  const invoke = vi.fn(async (input: {id: number}, _signal?: AbortSignal): Promise<unknown> => {seen.push(input.id); return {result: {}};});
  const native = {
    sendRequest: invoke,
    sendLiveOwnerAdoption: (input: {id: number}, _cut: unknown, _bounds: unknown, signal?: AbortSignal) => invoke(input, signal),
    readNextLiveApplied: (input: {id: number}, _position: unknown, _limit: number, signal?: AbortSignal) => invoke(input, signal),
    readLiveApplicationAck(input: {id: number}, _identity: unknown, signal?: AbortSignal) {return this.sendRequest(input, signal);},
  };
  const retire = vi.fn(() => lifetime.abort(new Error("retired")));
  const client = queueLiveHostRequests(native as unknown as EngineClient, {maxPendingReads: maxPending, maxPendingWrites: maxPending,
    maxRetainedInputBytes,
    deadlineMs: 1000, signal: lifetime.signal, retire});
  return {client, invoke, seen, lifetime, retire};
}
afterEach(() => vi.useRealTimers());

it("alternates bounded reader and writer queues while retaining FIFO order within each", async () => {
  const f = fixture(), release = deferred<unknown>();
  f.invoke.mockImplementationOnce(async input => {f.seen.push(input.id); return release.promise;});
  const first = f.client.sendRequest(request(1));
  const rest = [f.client.readNextLiveApplied(request(2), position, 100), f.client.readNextLiveApplied(request(4), position, 100),
    f.client.sendRequest(request(3)), f.client.sendRequest(request(5))];
  expect(f.seen).toEqual([1]); release.resolve({result: {}});
  await Promise.all([first, ...rest]); expect(f.seen).toEqual([1, 2, 3, 4, 5]); f.lifetime.abort();
});

it("removes cancelled queued requests without calling native or consuming a later slot", async () => {
  const f = fixture(1), release = deferred<unknown>(), cancelled = new AbortController();
  f.invoke.mockImplementationOnce(() => release.promise);
  const active = f.client.sendRequest(request(1));
  const queued = f.client.readNextLiveApplied(request(2), position, 100, cancelled.signal);
  const refused = expect(queued).rejects.toThrow("reader closed"); cancelled.abort(new Error("reader closed")); await refused;
  const replacement = f.client.readNextLiveApplied(request(3), position, 100);
  release.resolve({result: {}}); await Promise.all([active, replacement]);
  expect(f.invoke.mock.calls.map(([input]) => input.id)).toEqual([1, 3]); f.lifetime.abort();
});

it("holds active capacity after caller cancellation until native actually completes", async () => {
  const f = fixture(), release = deferred<unknown>(), caller = new AbortController();
  f.invoke.mockImplementationOnce(() => release.promise);
  const active = f.client.readNextLiveApplied(request(1), position, 100, caller.signal);
  const refused = expect(active).rejects.toThrow("reader closed");
  caller.abort(new Error("reader closed"));
  expect(f.invoke.mock.calls[0]![1]).toBe(f.lifetime.signal);
  expect(f.lifetime.signal.aborted).toBe(false);
  const next = f.client.sendRequest(request(2)); expect(f.invoke).toHaveBeenCalledTimes(1);
  release.resolve(null); await refused; await next;
  expect(f.invoke).toHaveBeenCalledTimes(2); f.lifetime.abort();
});

it("keeps a writer queue slot available when the reader queue is full", async () => {
  const f = fixture(1), release = deferred<unknown>();
  f.invoke.mockImplementationOnce(() => release.promise);
  const active = f.client.sendRequest(request(1));
  const read = f.client.readNextLiveApplied(request(2), position, 100);
  await expect(f.client.readNextLiveApplied(request(3), position, 100)).rejects.toThrow("queue capacity");
  const write = f.client.sendRequest(request(4));
  release.resolve({result: {}}); await Promise.all([active, read, write]);
  expect(f.invoke.mock.calls.map(([input]) => input.id)).toEqual([1, 2, 4]); f.lifetime.abort();
});

it("expires a queued wait without cancelling another caller's active request", async () => {
  vi.useFakeTimers();
  const f = fixture(), release = deferred<unknown>();
  f.invoke.mockImplementationOnce(() => release.promise);
  const active = f.client.sendRequest(request(1));
  const pending = expect(f.client.readNextLiveApplied(request(2), position, 100)).rejects.toThrow("queue deadline");
  await vi.advanceTimersByTimeAsync(1000); await pending;
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.lifetime.signal.aborted).toBe(false);
  release.resolve({result: {}}); await active; f.lifetime.abort();
});

it("retires an ambiguous native deadline before starting another queued request", async () => {
  const f = fixture(), release = deferred<void>();
  f.invoke.mockImplementationOnce(async () => {await release.promise; throw new EngineRequestDeadlineError(1, "liveApplication.appliedRead", 1000);});
  const active = expect(f.client.readNextLiveApplied(request(1), position, 100)).rejects.toBeInstanceOf(EngineRequestDeadlineError);
  const pending = expect(f.client.sendRequest(request(2))).rejects.toThrow("retired");
  release.resolve(); await Promise.all([active, pending]);
  expect(f.retire).toHaveBeenCalledOnce(); expect(f.invoke).toHaveBeenCalledTimes(1);
});

it("does not enqueue the internal RPC of an already queued client method", async () => {
  const f = fixture(1);
  await f.client.readLiveApplicationAck(request(1), {deliveryId: "delivery", updateDigest: "b".repeat(64)});
  expect(f.invoke).toHaveBeenCalledTimes(1); f.lifetime.abort();
});

const adoptionCut = (baselineBytes: Uint8Array) => ({
  relayDatabaseNamespace: "namespace", adoptionId: "adoption", sourceMomentId: "source", sourceDigest: "a".repeat(64), sourceByteLength: 0,
  baselineMomentRelaySequence: 1, baselineRegisteredAtMs: 0, expectedLocalSequence: 0, terminalReceipt: null, baselineBytes, events: [],
});
it("bounds retained borrowed cuts and releases cancelled queued input without borrowing the native budget", async () => {
  const f = fixture(4, 32_000), release = deferred<unknown>(), caller = new AbortController();
  f.invoke.mockImplementationOnce(() => release.promise);
  const active = f.client.sendRequest(request(1));
  const cut = adoptionCut(new Uint8Array(20_000)), bounds = {maxBytes: 30_000, maxEvents: 1};
  const queued = f.client.sendLiveOwnerAdoption({...request(2), sessionId: "owner"}, cut, bounds, caller.signal);
  await expect(f.client.sendLiveOwnerAdoption({...request(3), sessionId: "owner"}, cut, bounds)).rejects.toThrow("retained input capacity");
  expect(f.invoke).toHaveBeenCalledTimes(1);
  const cancelled = expect(queued).rejects.toThrow("cancelled"); caller.abort(new Error("cancelled")); await cancelled;
  const replacement = f.client.sendLiveOwnerAdoption({...request(4), sessionId: "owner"}, cut, bounds);
  release.resolve({result: {}}); await Promise.all([active, replacement]);
  expect(f.invoke.mock.calls.map(([input]) => input.id)).toEqual([1, 4]); f.lifetime.abort();
});

it("holds an active envelope's input charge until native completes after cancellation", async () => {
  const f = fixture(4, 16_000), release = deferred<unknown>(), caller = new AbortController();
  f.invoke.mockImplementationOnce(() => release.promise);
  const envelope = {...request(1), params: {value: "x".repeat(1800)}};
  const active = f.client.sendRequest(envelope, caller.signal), cancelled = expect(active).rejects.toThrow("cancelled");
  caller.abort(new Error("cancelled"));
  await expect(f.client.sendRequest({...envelope, id: 2})).rejects.toThrow("retained input capacity");
  expect(f.invoke).toHaveBeenCalledTimes(1); release.resolve({result: {}}); await cancelled;
  await f.client.sendRequest({...envelope, id: 3}); expect(f.invoke).toHaveBeenCalledTimes(2); f.lifetime.abort();
});

it("refuses an oversized backing allocation before native and leaves no partial reservation", async () => {
  const f = fixture(4, 10_000), cut = adoptionCut(new Uint8Array(20_000).subarray(0, 1));
  await expect(f.client.sendLiveOwnerAdoption({...request(1), sessionId: "owner"}, cut, {maxBytes: 1000, maxEvents: 1})).rejects.toThrow("retained input capacity");
  expect(f.invoke).not.toHaveBeenCalled();
  await f.client.sendRequest(request(2)); expect(f.invoke).toHaveBeenCalledOnce(); f.lifetime.abort();
});
