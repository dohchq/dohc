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
    moveAgain: vi.fn(async (): Promise<void> => undefined),
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

  it("holds a failed move to Applications apart from folders, newest first, and moves again once on Try again", async () => {
    const f = fixture(1);
    const window = renderer(7, "a");
    f.failures.report("C:\\work\\Trips", refused, window);
    f.failures.reportMove(new Error("disk full"), window);
    f.failures.reportMove(new Error("Failed to copy dohc.app"), window);
    const taken = f.failures.take(window);
    expect(taken).toEqual([
      expect.objectContaining({ path: "C:\\work\\Trips" }),
      { attemptId: expect.any(String), moveToApplications: true, cause: "Error: Failed to copy dohc.app", workspaceId: "a" },
    ]);
    const move = taken[1]!;

    f.moveAgain.mockRejectedValueOnce(new Error("still full"));
    await f.failures.retry(move.attemptId, window);
    expect(f.moveAgain).toHaveBeenCalledOnce();
    expect(f.reopen).not.toHaveBeenCalled();
    expect(f.failures.take(window)).toEqual([expect.objectContaining({ moveToApplications: true, cause: "Error: still full" })]);
    await expect(f.failures.retry(move.attemptId, window)).rejects.toThrow("Open the folder again.");
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

  it("gives every failure a window has not taken, combining those past its limit", () => {
    const f = fixture(2);
    const window = renderer(7, "a");
    // One launch reports every folder before the window can take any.
    for (const path of ["first", "second", "third", "fourth", "fifth"]) f.failures.report(path, refused, window);

    expect(f.failures.take(window)).toEqual([
      expect.objectContaining({ path: "first", workspaceId: "a" }),
      expect.objectContaining({ path: "second", workspaceId: "a" }),
      { attemptId: expect.any(String), paths: ["third", "fourth", "fifth"], count: 3, workspaceId: "a" },
    ]);
    expect(f.failures.take(window)).toEqual([]);
    // The window took them, so the next ones are kept apart again.
    f.failures.report("sixth", refused, window);
    expect(f.failures.take(window)).toEqual([expect.objectContaining({ path: "sixth" })]);
  });

  it("keeps folders past the limit for another workspace apart", () => {
    const f = fixture(1);
    const window = renderer(7, "a");
    for (const path of ["first", "second"]) f.failures.report(path, refused, window);
    window.workspaceId = "b";
    f.failures.report("third", refused, window);
    expect(f.failures.take(window)).toEqual([
      expect.objectContaining({ path: "first", workspaceId: "a" }),
      expect.objectContaining({ paths: ["second"], workspaceId: "a" }),
      expect.objectContaining({ paths: ["third"], workspaceId: "b" }),
    ]);
  });

  it("lists a bounded number of combined folders and counts every one", () => {
    const f = fixture(1);
    const window = renderer(7);
    for (let index = 0; index < 301; index += 1) f.failures.report(`folder-${index}`, refused, window);
    const [, more] = f.failures.take(window);
    expect(more).toMatchObject({ count: 300 });
    expect(more && "paths" in more ? more.paths : []).toHaveLength(256);
  });

  it("makes room by dropping only Try again attempts a window already took", async () => {
    const f = fixture(2);
    const window = renderer(7);
    for (const path of ["first", "second"]) f.failures.report(path, refused, window);
    const [first, second] = f.failures.take(window);
    for (const path of ["third", "fourth"]) f.failures.report(path, refused, window);
    // Untaken failures stay whatever main holds.
    expect(f.failures.take(window).map((failure) => "path" in failure && failure.path)).toEqual(["third", "fourth"]);

    await expect(f.failures.retry(first!.attemptId, window)).rejects.toThrow("Open the folder again.");
    await expect(f.failures.retry(second!.attemptId, window)).rejects.toThrow("Open the folder again.");
    expect(f.reopen).not.toHaveBeenCalled();
  });

  it("offers no Try again for folders combined into one", async () => {
    const f = fixture(1);
    const window = renderer(7);
    for (const path of ["first", "second"]) f.failures.report(path, refused, window);
    const [, more] = f.failures.take(window);
    await expect(f.failures.retry(more!.attemptId, window)).rejects.toThrow("Open the folder again.");
  });
});
