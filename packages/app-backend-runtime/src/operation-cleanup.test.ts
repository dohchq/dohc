import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRuntimeLaunchOptions, AppRuntimeLauncher } from "./protocol.ts";

const filesystem = vi.hoisted(() => ({ mkdtemp: vi.fn(), rm: vi.fn(), temporaryRoot: undefined as string | undefined }));
vi.mock("node:fs/promises", () => filesystem);
vi.mock("node:os", async importOriginal => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, tmpdir: () => filesystem.temporaryRoot ?? original.tmpdir() };
});

const cleanupError = Object.assign(new Error("directory is busy after eight retries"), { code: "EBUSY" });
const reply = { ok: true, database: new Uint8Array(100), changeset: new Uint8Array(), resultJson: '{"saved":true}', changed: true, attachedFileIds: [] };
const input = { tables: ["items"], database: new Uint8Array(100), source: "", operation: "save", caller: null, input: null, nowMs: 1, requestId: "request" };
const launch: AppRuntimeLauncher = options => ({
  postMessage() { options.onMessage(reply); options.onExit(0); },
  kill() { options.onExit(1); },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
beforeEach(() => {
  filesystem.temporaryRoot = undefined;
  vi.resetModules();
  vi.useFakeTimers();
  filesystem.mkdtemp.mockReset();
  filesystem.rm.mockReset().mockRejectedValue(cleanupError);
  let sequence = 0;
  filesystem.mkdtemp.mockImplementation(async () => join(tmpdir(), `dohc-app-operation-test-${++sequence}`));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("one-shot operation cleanup", () => {
  it("preserves a validated success after immediate removal retries exhaust, then removes the retained path", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    await expect(evaluateAppOperation(input, { launch })).resolves.toEqual({
      result: { saved: true }, database: reply.database, changeset: reply.changeset, changed: true, attachedFileIds: [],
    });
    expect(filesystem.rm).toHaveBeenCalledExactlyOnceWith(join(tmpdir(), "dohc-app-operation-test-1"), {
      recursive: true, force: true, maxRetries: 8, retryDelay: 25,
    });
    filesystem.rm.mockResolvedValue(undefined);
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(2);
    expect(filesystem.rm.mock.calls[1][0]).toBe(filesystem.rm.mock.calls[0][0]);
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the original failure by identity and waits for the killed child to exit before removal", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    const started = deferred<AppRuntimeLaunchOptions>();
    const original = new Error("operation failed");
    const kill = vi.fn();
    const pending = evaluateAppOperation(input, { launch(options) {
      started.resolve(options);
      return { postMessage() { options.onError(original); }, kill };
    } });
    const outcome = pending.catch(error => error);
    const child = await started.promise;
    expect(kill).toHaveBeenCalledOnce();
    expect(filesystem.rm).not.toHaveBeenCalled();
    child.onExit(1);
    expect(await outcome).toBe(original);
    filesystem.rm.mockResolvedValue(undefined);
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(2);
  });

  it("keeps result validation failures instead of replacing them with cleanup failures", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    await expect(evaluateAppOperation(input, { launch: options => ({
      postMessage() { options.onMessage({ ...reply, database: null }); options.onExit(0); }, kill() {},
    }) })).rejects.toThrow("Invalid app database result.");
    filesystem.rm.mockResolvedValue(undefined);
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(2);
  });

  it("releases all operation slots while deferred cleanup is still pending", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    await Promise.all(Array.from({ length: 8 }, () => evaluateAppOperation(input, { launch })));
    const started = deferred<void>();
    const children: AppRuntimeLaunchOptions[] = [];
    const pending = Array.from({ length: 8 }, () => evaluateAppOperation(input, { launch(options) {
      children.push(options);
      if (children.length === 8) started.resolve();
      return { postMessage() { options.onMessage(reply); }, kill() { options.onExit(1); } };
    } }));
    await started.promise;
    await expect(evaluateAppOperation(input, { launch })).rejects.toThrow("App runtime is busy.");
    for (const child of children) child.onExit(0);
    await Promise.all(pending);
    expect(filesystem.rm).toHaveBeenCalledTimes(16);
    filesystem.rm.mockResolvedValue(undefined);
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(32);
  });

  it("bounds repeated removal failure and reports the exhausted owned path without an unhandled rejection", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(evaluateAppOperation(input, { launch })).resolves.toMatchObject({ result: { saved: true } });
      await vi.runAllTimersAsync();
      expect(filesystem.rm).toHaveBeenCalledTimes(4);
      for (const [directory, options] of filesystem.rm.mock.calls) {
        expect(directory).toBe(join(tmpdir(), "dohc-app-operation-test-1"));
        expect(options).toEqual({ recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
      }
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("app_operation_cleanup_exhausted", {
        directory: join(tmpdir(), "dohc-app-operation-test-1"), error: cleanupError,
      });
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { process.removeListener("unhandledRejection", unhandled); }
  });

  it("rechecks ownership before every delayed removal attempt", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    await evaluateAppOperation(input, { launch });
    expect(filesystem.rm).toHaveBeenCalledTimes(1);
    filesystem.temporaryRoot = join(tmpdir(), "other-owner");
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not remove a successful child's directory until the child exits", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    filesystem.rm.mockResolvedValue(undefined);
    const started = deferred<AppRuntimeLaunchOptions>();
    const pending = evaluateAppOperation(input, { launch(options) {
      started.resolve(options);
      return { postMessage() { options.onMessage(reply); }, kill() { options.onExit(1); } };
    } });
    const child = await started.promise;
    expect(filesystem.rm).not.toHaveBeenCalled();
    child.onExit(0);
    await expect(pending).resolves.toMatchObject({ result: { saved: true } });
    expect(filesystem.rm).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves synchronous launch failures by identity", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    const original = new Error("launch failed");
    await expect(evaluateAppOperation(input, { launch() { throw original; } })).rejects.toBe(original);
    filesystem.rm.mockResolvedValue(undefined);
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(2);
  });

  it("contains diagnostic failures after the cleanup budget exhausts", async () => {
    const { evaluateAppOperation } = await import("./index.ts");
    vi.mocked(console.warn).mockImplementation(() => { throw new Error("diagnostics failed"); });
    await expect(evaluateAppOperation(input, { launch })).resolves.toMatchObject({ result: { saved: true } });
    await vi.runAllTimersAsync();
    expect(filesystem.rm).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    join(tmpdir(), "unrelated"),
    join(tmpdir(), "dohc-app-operation-test", "unrelated"),
    join(tmpdir(), "dohc-app-operation-"),
  ])("never removes an unowned path: %s", async directory => {
    filesystem.mkdtemp.mockResolvedValue(directory);
    const { evaluateAppOperation } = await import("./index.ts");
    await expect(evaluateAppOperation(input, { launch })).resolves.toMatchObject({ result: { saved: true } });
    await vi.runAllTimersAsync();
    expect(filesystem.rm).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

