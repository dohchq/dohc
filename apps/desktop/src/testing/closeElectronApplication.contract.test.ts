import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QUIT_ASK_TIMEOUT_MS, WILL_QUIT_BUDGET_MS } from "../shutdownBudgets";

const cleanup = vi.hoisted(() => ({ finish: () => {}, calls: 0 }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null) => void) => {
    cleanup.calls += 1;
    cleanup.finish();
    callback(null);
  },
}));

import { closeElectronApplication, PROCESS_EXIT_ALLOWANCE_MS } from "../../../../scripts/verification/close-electron.mjs";
import { DESKTOP_CLOSE_GRACE_MS } from "../../../../scripts/verification/desktop-close-policy.mjs";

function childProcess() {
  const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null as number | null, signalCode: null as string | null });
  const exit = (code: number) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  cleanup.finish = () => exit(1);
  return { child: child as unknown as ChildProcess, exit };
}

beforeEach(() => {
  vi.useFakeTimers();
  cleanup.calls = 0;
  if (process.platform !== "win32") vi.spyOn(process, "kill").mockImplementation(() => {
    cleanup.calls += 1;
    cleanup.finish();
    return true;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("desktop close allows renderer acknowledgement and teardown beyond the generic five seconds", async () => {
  const { child, exit } = childProcess();
  const app = { close: () => new Promise<void>((resolve) => {
    setTimeout(() => { exit(0); resolve(); }, QUIT_ASK_TIMEOUT_MS + WILL_QUIT_BUDGET_MS - 1);
  }) };
  const result = closeElectronApplication(app, child, DESKTOP_CLOSE_GRACE_MS);
  const settled = vi.fn();
  void result.then(settled, settled);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(settled).not.toHaveBeenCalled();
  expect(cleanup.calls).toBe(0);
  await vi.advanceTimersByTimeAsync(QUIT_ASK_TIMEOUT_MS + WILL_QUIT_BUDGET_MS - 1 - 5_000);
  await expect(result).resolves.toBeUndefined();
  expect(cleanup.calls).toBe(0);
});

test("a desktop shutdown deadline exit fails the proof even inside its longer close grace", async () => {
  const { child, exit } = childProcess();
  const app = { close: () => new Promise<void>((resolve) => {
    setTimeout(() => { exit(1); resolve(); }, WILL_QUIT_BUDGET_MS);
  }) };
  const result = expect(closeElectronApplication(app, child, DESKTOP_CLOSE_GRACE_MS)).rejects.toThrow("Electron exited with status 1");
  await vi.advanceTimersByTimeAsync(WILL_QUIT_BUDGET_MS);
  await result;
  expect(cleanup.calls).toBe(0);
});

test("a fulfilled close cannot pass when its live child needs forced cleanup", async () => {
  const { child } = childProcess();
  const result = expect(closeElectronApplication({ close: async () => {} }, child, DESKTOP_CLOSE_GRACE_MS))
    .rejects.toThrow("forced cleanup was required");
  await vi.advanceTimersByTimeAsync(PROCESS_EXIT_ALLOWANCE_MS);
  await result;
  expect(cleanup.calls).toBe(1);
  expect(child.exitCode).toBe(1);
});

test("an already exited desktop with nonzero status cannot pass a second close", async () => {
  const { child, exit } = childProcess();
  exit(1);
  const close = vi.fn();
  await expect(closeElectronApplication({ close }, child, DESKTOP_CLOSE_GRACE_MS)).rejects.toThrow("Electron exited with status 1");
  expect(close).not.toHaveBeenCalled();
});

test.each([false, true])("a signal exit cannot pass a desktop close (already exited: %s)", async (alreadyExited) => {
  const { child } = childProcess();
  const exit = () => {
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
  };
  const close = vi.fn(async () => { exit(); });
  if (alreadyExited) exit();
  await expect(closeElectronApplication({ close }, child, DESKTOP_CLOSE_GRACE_MS)).rejects.toThrow("Electron exited with signal SIGKILL");
  expect(close).toHaveBeenCalledTimes(alreadyExited ? 0 : 1);
  expect(cleanup.calls).toBe(0);
});
