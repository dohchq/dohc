import { describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createOpenPathFailures } from "./openPathFailures";

function renderer(id: number, workspaceId: string | null = null) {
  const destroyedListeners: Array<() => void> = [];
  const value = {
    id,
    workspaceId,
    destroyed: false,
    isDestroyed: () => value.destroyed,
    once(_event: "destroyed", listener: () => void) {
      destroyedListeners.push(listener);
      return value;
    },
    destroy() {
      value.destroyed = true;
      for (const listener of destroyedListeners) listener();
    },
  };
  return value;
}
type Renderer = ReturnType<typeof renderer>;

function fixture(limit?: number) {
  const reopen = vi.fn(async (_path: string, _renderer: Renderer) => undefined);
  const dependencies = {
    workspaceIdOf: (target: Renderer) => target.workspaceId,
    notify: vi.fn((_renderer: Renderer) => undefined),
    reopen,
    record: vi.fn(),
    ...(limit === undefined ? {} : { limit }),
  };
  return { failures: createOpenPathFailures(dependencies), ...dependencies };
}

const refused = Object.assign(new Error("permission denied"), { code: "EACCES" });

describe("open path failures", () => {
  it("holds a failure until its window takes it, so a push it missed loses nothing", () => {
    const f = fixture();
    const window = renderer(7, "trips");
    f.failures.report("C:\\work\\Trips", refused, window);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(window);

    expect(f.failures.take(renderer(8))).toEqual([]);
    expect(f.failures.take(window)).toEqual([{
      attemptId: expect.any(String),
      path: "C:\\work\\Trips",
      cause: "Error [EACCES]: permission denied",
      workspaceId: "trips",
    }]);
    expect(f.failures.take(window)).toEqual([]);
  });

  it("opens an attempt again once, and only for the window it was held for", async () => {
    const f = fixture();
    const window = renderer(7);
    f.failures.report("C:\\work\\Trips", refused, window);
    const attemptId = f.failures.take(window)[0]!.attemptId;

    await expect(f.failures.retry(attemptId, renderer(8))).rejects.toThrow("Open the folder again.");
    await f.failures.retry(attemptId, window);
    expect(f.reopen).toHaveBeenCalledExactlyOnceWith("C:\\work\\Trips", window);
    await expect(f.failures.retry(attemptId, window)).rejects.toThrow("Open the folder again.");
  });

  it("holds a failed Try again as a new failure, for the workspace the window showed", async () => {
    const f = fixture();
    const window = renderer(7, "a");
    f.failures.report("C:\\work\\Trips", refused, window);
    const [first] = f.failures.take(window);
    const gone = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    f.reopen.mockRejectedValueOnce(gone);

    await f.failures.retry(first!.attemptId, window);
    expect(f.record).toHaveBeenCalledExactlyOnceWith("C:\\work\\Trips", gone);
    const [second] = f.failures.take(window);
    expect(second).toMatchObject({ path: "C:\\work\\Trips", workspaceId: "a", cause: "Error [ENOENT]: no such file or directory" });
    expect(second!.attemptId).not.toBe(first!.attemptId);
  });

  it("drops a failed Try again when the window moved to another workspace while it ran", async () => {
    const f = fixture();
    const window = renderer(7, "a");
    f.failures.report("C:\\work\\Trips", refused, window);
    const [failure] = f.failures.take(window);
    const registering = deferred<undefined>();
    f.reopen.mockReturnValueOnce(registering.promise);

    const retry = f.failures.retry(failure!.attemptId, window);
    window.workspaceId = "b";
    registering.reject(refused);
    await retry;
    expect(f.record).toHaveBeenCalledExactlyOnceWith("C:\\work\\Trips", refused);
    expect(f.failures.take(window)).toEqual([]);
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("forgets a closed window's failures and attempts", async () => {
    const f = fixture();
    const window = renderer(7);
    f.failures.report("C:\\work\\Trips", refused, window);
    f.failures.report("C:\\work\\Notes", refused, window);
    const [taken] = f.failures.take(window);
    f.failures.report("C:\\work\\Plans", refused, window);
    window.destroy();

    await expect(f.failures.retry(taken!.attemptId, window)).rejects.toThrow("Open the folder again.");
    expect(f.failures.take(window)).toEqual([]);
    f.failures.report("C:\\work\\Late", refused, window);
    expect(f.notify).toHaveBeenCalledTimes(3);
  });

  it("drops the oldest failure once it holds its limit", () => {
    const f = fixture(2);
    const window = renderer(7);
    for (const path of ["first", "second", "third"]) f.failures.report(path, refused, window);
    expect(f.failures.take(window).map((failure) => failure.path)).toEqual(["second", "third"]);
  });
});
