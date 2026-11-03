import {expect, it, vi} from "vitest";
import {OwnerOutboxWake} from "./ownerOutboxWake.js";
import type {LiveHostRegistration} from "./liveHostRegistration.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {promise: new Promise<T>(done => {resolve = done;}), resolve: (value: T) => resolve(value)};
}
function registration(id = 1) {
  const lifetime = new AbortController();
  return {lifetime, value: {id, invalidated: lifetime.signal, binding: {workspaceId: "w", mainVersionId: "m", objectId: `o${id}`,
    lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}} satisfies LiveHostRegistration};
}

it("coalesces edits during a bounded pass and continues only while the pass reports progress", async () => {
  const first = deferred<boolean>(), entered = deferred<void>(), second = deferred<void>(), r = registration();
  const run = vi.fn(async () => {entered.resolve(); return first.promise;});
  run.mockImplementationOnce(async () => {entered.resolve(); return first.promise;})
    .mockImplementationOnce(async () => {second.resolve(); return false;});
  const queue = new OwnerOutboxWake({canRun: () => true, run, onError: vi.fn()});
  queue.wake(r.value); await entered.promise;
  for (let i = 0; i < 100; i++) queue.wake(r.value);
  first.resolve(true); await second.promise;
  // A completed independent microtask chain lets the finalizer remove clean debt.
  await Promise.resolve(); await Promise.resolve(); queue.pump(); await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(2); queue.close();
});

it("retains dirty debt at capacity and releases the next document after a slot finishes", async () => {
  const a = registration(), b = registration(2), release = deferred<boolean>(), entered = deferred<void>(), next = deferred<void>();
  let active = 0;
  const run = vi.fn(async (r: LiveHostRegistration) => {
    active++;
    try {if (r.id === 1) {entered.resolve(); return await release.promise;} next.resolve(); return false;}
    finally {active--;}
  });
  const queue = new OwnerOutboxWake({canRun: () => active < 1, run, onError: vi.fn()});
  queue.wake(a.value); queue.wake(b.value); await entered.promise;
  expect(run).toHaveBeenCalledTimes(1);
  release.resolve(false); await next.promise; expect(run).toHaveBeenCalledTimes(2); queue.close();
});

it("drops invalidated debt and disposes listeners exactly once on close", async () => {
  const a = registration(), b = registration(2), run = vi.fn(async () => false);
  const removeA = vi.spyOn(a.lifetime.signal, "removeEventListener"), removeB = vi.spyOn(b.lifetime.signal, "removeEventListener");
  let allowed = false;
  const queue = new OwnerOutboxWake({canRun: () => allowed, run, onError: vi.fn()});
  queue.wake(a.value); queue.wake(b.value); a.lifetime.abort();
  queue.close(); queue.close(); allowed = true; queue.pump(); await Promise.resolve();
  expect(run).not.toHaveBeenCalled(); expect(removeA).toHaveBeenCalledTimes(1); expect(removeB).toHaveBeenCalledTimes(1);
});

it("does not retry a refused pass without a new durable change", async () => {
  const r = registration(), failed = deferred<void>();
  const run = vi.fn(async () => {throw new Error("refused");}), onError = vi.fn(() => failed.resolve());
  const queue = new OwnerOutboxWake({canRun: () => true, run, onError});
  queue.wake(r.value); await failed.promise; await Promise.resolve(); await Promise.resolve();
  queue.pump(); await Promise.resolve(); expect(run).toHaveBeenCalledTimes(1); queue.close();
});

it("retains a settle request beside changes before and during an outbox pass", async () => {
  const r = registration(), entered = deferred<void>(), release = deferred<boolean>(), settled = deferred<void>();
  const calls: string[] = [];
  const queue = new OwnerOutboxWake({canRun: () => true, onError: error => {throw error;},
    async run(_registration, kind) {
      calls.push(kind);
      if (calls.length === 1) {entered.resolve(); return release.promise;}
      if (kind === "settle") settled.resolve();
      return false;
    }});
  queue.wake(r.value);
  queue.wake(r.value, "settle");
  await entered.promise;
  queue.wake(r.value);
  queue.wake(r.value, "settle");
  release.resolve(false);
  await settled.promise;
  expect(calls).toEqual(["change", "change", "settle"]);
  queue.close();
});

it("runs settlement without another edit and retains both wakes received during that settlement", async () => {
  const r = registration(), entered = deferred<void>(), release = deferred<boolean>(), finished = deferred<void>();
  const calls: string[] = [], onError = vi.fn();
  const disposed = vi.spyOn(r.lifetime.signal, "removeEventListener");
  let allowed = false;
  const queue = new OwnerOutboxWake({canRun: () => allowed, onError,
    async run(_registration, kind) {
      calls.push(kind);
      if (calls.length === 1) { entered.resolve(); return release.promise; }
      if (calls.length === 3) finished.resolve();
      return false;
    }});
  try {
    queue.wake(r.value, "settle");
    await Promise.resolve();
    expect(calls).toEqual([]);
    allowed = true;
    queue.pump();
    await entered.promise;
    for (let i = 0; i < 20; i++) {
      queue.wake(r.value, "settle");
      queue.wake(r.value, "change");
    }
    release.resolve(false);
    await finished.promise;
    expect(calls).toEqual(["settle", "change", "settle"]);
    expect(onError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    queue.pump();
    await Promise.resolve();
    expect(calls).toHaveLength(3);
  } finally { release.resolve(false); queue.close(); }
});

it("does not pass an invalidated registration's settlement wake to its replacement", async () => {
  const old = registration(), replacement = registration(), entered = deferred<void>(), release = deferred<boolean>();
  const next = deferred<void>(), calls: {signal: AbortSignal; kind: string}[] = [];
  const queue = new OwnerOutboxWake({canRun: () => true, onError: vi.fn(),
    async run(value, kind) {
      calls.push({signal: value.invalidated, kind});
      if (value.invalidated === old.value.invalidated) { entered.resolve(); return release.promise; }
      next.resolve(); return false;
    }});
  try {
    queue.wake(old.value);
    await entered.promise;
    queue.wake(old.value, "settle");
    old.lifetime.abort();
    queue.wake(replacement.value);
    await next.promise;
    release.resolve(false);
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toEqual([{signal: old.value.invalidated, kind: "change"},
      {signal: replacement.value.invalidated, kind: "change"}]);
  } finally { release.resolve(false); queue.close(); }
});
