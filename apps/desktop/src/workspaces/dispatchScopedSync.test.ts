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
});
