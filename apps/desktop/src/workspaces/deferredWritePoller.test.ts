import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredWritePoller } from "./deferredWritePoller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe("deferred write polling", () => {
  it("notifies open sessions within 500 ms and does no work without a session", async () => {
    vi.useFakeTimers();
    let paths: string[] = [];
    const read = vi.fn(async () => paths);
    const changedOutside = vi.fn();
    const poller = createDeferredWritePoller({ read, changedOutside, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    paths = ["notes/open.md"];
    await vi.advanceTimersByTimeAsync(499);
    expect(changedOutside).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changedOutside).toHaveBeenCalledWith("notes/open.md");
    poller.setActive(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("coalesces slow reads, cancels on stop, and ignores their late responses", async () => {
    vi.useFakeTimers();
    const pending = deferred<string[]>();
    const read = vi.fn((_signal: AbortSignal) => pending.promise);
    const changedOutside = vi.fn();
    const poller = createDeferredWritePoller({ read, changedOutside, onError: vi.fn() });
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    poller.stop();
    expect(read.mock.calls[0]?.[0].aborted).toBe(true);
    pending.resolve(["old-workspace.md"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changedOutside).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    poller.setActive(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("ignores a previous session's response after close and reopen", async () => {
    vi.useFakeTimers();
    const pending = deferred<string[]>();
    const read = vi.fn((_signal: AbortSignal) => Promise.resolve(["current.md"]))
      .mockImplementationOnce(() => pending.promise);
    const changedOutside = vi.fn();
    const poller = createDeferredWritePoller({ read, changedOutside, onError: vi.fn() });
    poller.setActive(true);
    poller.setActive(false);
    expect(read.mock.calls[0]?.[0].aborted).toBe(true);
    poller.setActive(true);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(["closed.md"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(changedOutside.mock.calls).toEqual([["current.md"]]);
    poller.stop();
  });

  it("backs off on errors and resumes the normal interval after success", async () => {
    vi.useFakeTimers();
    const failure = new Error("daemon unavailable");
    const read = vi.fn(async () => ["recovered.md"])
      .mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const changedOutside = vi.fn();
    const onError = vi.fn();
    const poller = createDeferredWritePoller({ read, changedOutside, onError });
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(changedOutside).toHaveBeenCalledWith("recovered.md");
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(4);
    poller.stop();
  });

  it("clears a pending retry when the last session closes", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("offline"));
    const poller = createDeferredWritePoller({ read, changedOutside: vi.fn(), onError: vi.fn() });
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    poller.setActive(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});
