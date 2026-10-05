import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWorkspaceFiles, type WorkspaceObservationCallbacks } from "./workspaceFileObservation";
import type { FileObservationChanges } from "@dohc/workspace-engine-client/daemon";
import { deferred } from "../testing/deferred";

const answer = (revision: number, extra: Partial<FileObservationChanges> = {}): FileObservationChanges => ({
  cursor: { generation: "first", revision }, ready: true, resync: false, facts: [], ...extra,
});
function fixture(read: Parameters<typeof observeWorkspaceFiles>[0]["read"]) {
  let wake = () => {};
  let capture = () => {};
  const callbacks: WorkspaceObservationCallbacks = { facts: vi.fn(), resync: vi.fn(async () => {}), captured: vi.fn(), pulled: vi.fn(), degraded: vi.fn() };
  const onError = vi.fn();
  const handle = observeWorkspaceFiles({ read, callbacks, onError,
    subscribe(w, c) { wake = w; capture = c; return vi.fn(); } });
  return { handle, callbacks, onError, wake: () => wake(), capture: () => capture() };
}
afterEach(() => vi.useRealTimers());

describe("workspace file observation", () => {
  it("retries failed reads with backoff and stops retrying after success", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValue(answer(9, { resync: true, facts: [{ path: "fresh.md", kind: "appeared" }] }));
    const f = fixture(read);
    await f.handle.ready;
    f.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith(true);
    expect(read).toHaveBeenCalledTimes(2);
    f.wake();
    await vi.advanceTimersByTimeAsync(249);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.callbacks.resync).toHaveBeenCalledOnce();
    expect(f.callbacks.facts).toHaveBeenCalledWith([{ path: "fresh.md", kind: "appeared" }]);
    expect(read.mock.calls[1]?.[0]).toEqual({ generation: "first", revision: 1 });
    expect(f.callbacks.degraded).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(4);
    await f.handle.stop();
  });

  it("resolves startup when a read fails and cancels its retry on stop", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("file-observation-unavailable")).mockResolvedValue(answer(1));
    const f = fixture(read);
    await vi.advanceTimersByTimeAsync(0);
    await f.handle.ready;
    expect(f.callbacks.degraded).toHaveBeenCalledWith(true);
    await f.handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resolves readiness for a known degraded feed", async () => {
    const f = fixture(vi.fn().mockResolvedValue({ ...answer(0), ready: false, degraded: true }));
    await f.handle.ready;
    expect(f.callbacks.degraded).toHaveBeenCalledWith(true);
    await f.handle.stop();
  });

  it("resolves readiness on stop before a pending initial read finishes", async () => {
    const pending = deferred<FileObservationChanges>();
    const f = fixture(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(answer(1)));
    const stopped = f.handle.stop();
    await f.handle.ready;
    pending.resolve(answer(0, { ready: false }));
    await stopped;
  });

  it("fans a large revision out once", async () => {
    const facts = Array.from({ length: 2000 }, (_, n) => ({ path: `${n}.md`, kind: "changed" as const }));
    const f = fixture(vi.fn().mockResolvedValueOnce(answer(1, { facts })).mockResolvedValue(answer(1)));
    await f.handle.ready;
    expect(f.callbacks.facts).toHaveBeenCalledExactlyOnceWith(facts);
    await f.handle.stop();
  });

  it("retains a wake received during a read and keeps capture independent", async () => {
    const pending = deferred<FileObservationChanges>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(answer(2));
    const f = fixture(read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    f.capture(); f.wake();
    expect(f.callbacks.captured).toHaveBeenCalledOnce();
    pending.resolve(answer(1));
    await f.handle.ready;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await f.handle.stop();
  });

  it("routes pulled paths without draining and deduplicates already observed paths", async () => {
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockResolvedValueOnce(answer(2, {
      facts: [{ path: "a.md", kind: "changed" }],
    })).mockResolvedValue(answer(3));
    const f = fixture(read);
    await f.handle.ready;
    f.handle.pullStarting();
    f.wake();
    await vi.waitFor(() => expect(f.callbacks.facts).toHaveBeenCalledWith([{ path: "a.md", kind: "changed" }]));
    await f.handle.pulledPaths(["a.md", "b.md"]);
    expect(f.callbacks.pulled).toHaveBeenCalledExactlyOnceWith(["b.md"]);
    expect(read).toHaveBeenCalledTimes(2);
    f.handle.pullFinished();
    f.handle.pullStarting();
    read.mockResolvedValueOnce(answer(4, { facts: [{ path: "c.md", kind: "appeared" }] }));
    await f.handle.pulledPaths(["c.md"]);
    expect(f.callbacks.pulled).toHaveBeenLastCalledWith(["c.md"]);
    f.wake();
    await vi.waitFor(() => expect(f.callbacks.facts).toHaveBeenCalledWith([{ path: "c.md", kind: "appeared" }]));
    f.handle.pullFinished();
    await f.handle.stop();
  });

  it("routes every pulled path while observation is degraded", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn().mockRejectedValue(new Error("decode failed")));
    await vi.advanceTimersByTimeAsync(0);
    await f.handle.pulledPaths(["a.md", "b.md"]);
    expect(f.callbacks.pulled).toHaveBeenCalledExactlyOnceWith(["a.md", "b.md"]);
    await expect(f.handle.stop()).rejects.toThrow("decode failed");
  });

  it("does not make a pulled page wait for an in-flight observation read", async () => {
    const pending = deferred<FileObservationChanges>();
    const f = fixture(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(answer(1)));
    await f.handle.pulledPaths(["pulled.md"]);
    expect(f.callbacks.pulled).toHaveBeenCalledExactlyOnceWith(["pulled.md"]);
    pending.resolve(answer(1));
    await f.handle.stop();
  });

  it("reports a failed drain and never advances its cursor on that failure", async () => {
    const read = vi.fn().mockResolvedValueOnce(answer(1)).mockRejectedValue(new Error("drain unavailable"));
    const f = fixture(read);
    await f.handle.ready;
    await expect(f.handle.stop()).rejects.toThrow("drain unavailable");
    expect(read.mock.calls[1]).toEqual([{ generation: "first", revision: 1 }, true]);
    expect(f.onError).toHaveBeenCalledOnce();
  });
});
