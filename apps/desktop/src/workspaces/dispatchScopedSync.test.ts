import { describe, expect, it, vi } from "vitest";
import { coalesceDispatchScopedSync } from "./dispatchScopedSync";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("coalesceDispatchScopedSync", () => {
  it("shares one scoped sync between concurrent dispatch scans", async () => {
    const syncs = new Map<string, Promise<boolean>>();
    const finishSync = deferred();
    const captureAndStart = vi.fn(async () => {
      await finishSync.promise;
      return true;
    });

    const first = coalesceDispatchScopedSync(
      syncs,
      "workspace-1",
      captureAndStart,
    );
    const second = coalesceDispatchScopedSync(
      syncs,
      "workspace-1",
      captureAndStart,
    );
    await vi.waitFor(() => {
      expect(captureAndStart).toHaveBeenCalledTimes(1);
    });
    finishSync.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(captureAndStart).toHaveBeenCalledTimes(1);
  });

  it("starts a new sync after the previous sync settles", async () => {
    const syncs = new Map<string, Promise<boolean>>();
    const captureAndStart = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      coalesceDispatchScopedSync(syncs, "workspace-1", captureAndStart),
    ).resolves.toBe(true);
    expect(syncs.has("workspace-1")).toBe(false);

    await expect(
      coalesceDispatchScopedSync(syncs, "workspace-1", captureAndStart),
    ).resolves.toBe(false);
    expect(captureAndStart).toHaveBeenCalledTimes(2);
  });

  it("shares a rejection and starts a new sync after it settles", async () => {
    const syncs = new Map<string, Promise<boolean>>();
    const finishSync = deferred();
    const failure = new Error("sync failed");
    let attempts = 0;
    const captureAndStart = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        await finishSync.promise;
        throw failure;
      }
      return true;
    });

    const first = coalesceDispatchScopedSync(
      syncs,
      "workspace-1",
      captureAndStart,
    );
    const second = coalesceDispatchScopedSync(
      syncs,
      "workspace-1",
      captureAndStart,
    );
    const firstRejection = expect(first).rejects.toBe(failure);
    const secondRejection = expect(second).rejects.toBe(failure);
    await vi.waitFor(() => {
      expect(captureAndStart).toHaveBeenCalledTimes(1);
    });
    finishSync.resolve();

    await Promise.all([firstRejection, secondRejection]);
    expect(syncs.has("workspace-1")).toBe(false);

    await expect(
      coalesceDispatchScopedSync(syncs, "workspace-1", captureAndStart),
    ).resolves.toBe(true);
    expect(captureAndStart).toHaveBeenCalledTimes(2);
  });
});
