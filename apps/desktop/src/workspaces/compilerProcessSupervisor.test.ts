import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runOwnedCompilerProcess } from "./compilerProcessSupervisor";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

const bounds = { timeoutMs: 1_000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 4096, maxOutputBytes: 4096, maxErrorBytes: 8192 };
const runtime = { nodeExecutable: process.execPath, workerPath: `${process.cwd()}/worker.mjs` };
afterEach(() => { vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks(); });

function owner(spawned = true) {
  vi.useFakeTimers();
  vi.stubGlobal("process", Object.defineProperty(Object.create(process), "platform", { value: "win32" }));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123,
    kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL"));return true; }) });
  spawn.mockReturnValue(child);
  const running = runOwnedCompilerProcess(runtime, { input: Buffer.alloc(0), bounds });
  // Attach the rejection handler before advancing the deadline.
  const outcome = running.catch(error => error);
  if (spawned) child.emit("spawn");
  return { child, outcome };
}

it("keeps stage timings and a bounded, redacted stderr tail on a supervisor timeout", async () => {
  const { child, outcome } = owner();
  child.stderr.write("[dohc-com");
  await vi.advanceTimersByTimeAsync(10);
  child.stderr.write("piler] PowerShell running\r\n[dohc-compiler] Add-Type done\n");
  await vi.advanceTimersByTimeAsync(20);
  child.stderr.write("[dohc-compiler] job assigned\n[dohc-compiler] admitted\n[dohc-compiler] worker spawned\n[dohc-compiler] worker ready\n");
  child.stderr.write("private file contents and SECRET=value\n".repeat(150));
  child.stderr.write("ENOMEM: private source excerpt");
  await vi.advanceTimersByTimeAsync(970);
  const error = await outcome;
  expect(error).toMatchObject({ reason: "timeout", message: "Compiler timed out." });
  expect(error.details).toContain("Last stage: worker ready");
  expect(error.details).toContain("PowerShell running=10ms, Add-Type done=10ms, job assigned=30ms, admitted=30ms, worker spawned=30ms, worker ready=30ms");
  expect(error.details).toContain("elapsed=1000ms");
  expect(error.details).toContain("ENOMEM");
  expect(error.details).not.toMatch(/private|SECRET|value|worker\.mjs/);
  expect(Buffer.byteLength(error.details.split("stderr tail: ")[1])).toBeLessThanOrEqual(128);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(spawn.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive"]));
});

it("keeps diagnostics before startup records in a stalled compiler's tail", async () => {
  const { child, outcome } = owner();
  child.stderr.write("private file contents and SECRET=value\nENOMEM: private source excerpt\n");
  child.stderr.write("[dohc-compiler] PowerShell running\n[dohc-compiler] Add-Type done\n[dohc-compiler] job assigned\n[dohc-compiler] admitted\n[dohc-compiler] worker spawned\n[dohc-compiler] worker ready\n");
  await vi.advanceTimersByTimeAsync(bounds.timeoutMs);
  const error = await outcome;
  expect(error.details).toContain("Last stage: worker ready");
  expect(error.details.split("stderr tail: ")[1]).toBe("[redacted stderr]; ENOMEM");
});

it("keeps repeated and out-of-order startup records in the tail", async () => {
  const { child, outcome } = owner();
  child.stderr.write("[dohc-compiler] Add-Type done\n[dohc-compiler] Add-Type done\n[dohc-compiler] PowerShell running\n");
  await vi.advanceTimersByTimeAsync(bounds.timeoutMs);
  const error = await outcome;
  expect(error.details).toContain("Last stage: Add-Type done");
  expect(error.details.split("stderr tail: ")[1]).toBe("[dohc-compiler] Add-Type done; [dohc-compiler] PowerShell running");
});

it("reports an owner deadline, including startup that never reached PowerShell", async () => {
  const { child, outcome } = owner();
  child.emit("close", 124, null);
  expect(await outcome).toMatchObject({ reason: "timeout", message: "Compiler owner timed out.", details: expect.stringContaining("Last stage: owner spawned") });
});

it("reports a timeout before the owner starts without inventing a completed stage", async () => {
  const { outcome } = owner(false);
  await vi.advanceTimersByTimeAsync(bounds.timeoutMs);
  expect(await outcome).toMatchObject({ reason: "timeout", details: "Last stage: starting owner; elapsed=1000ms; stderr tail: (empty)" });
});

it("removes fragmented stage records from successful output without spending the stderr bound", async () => {
  const { child, outcome } = owner();
  child.stderr.write("[dohc-compiler] worker rea");
  child.stderr.write("dy\nordinary diagnostic");
  child.stdout.write("compiled");
  child.emit("close", 0, null);
  const result = await outcome;
  expect(Buffer.from(result.stderr).toString()).toBe("ordinary diagnostic");
  expect(Buffer.from(result.stdout).toString()).toBe("compiled");
});

it("still enforces the stderr bound for an unterminated line", async () => {
  const { child, outcome } = owner();
  child.stderr.write(Buffer.alloc(bounds.maxErrorBytes + 1, 120));
  expect(await outcome).toMatchObject({ reason: "stderr" });
});

it("counts repeated stage records against the stderr bound", async () => {
  const { child, outcome } = owner();
  child.stderr.write("[dohc-compiler] PowerShell running\n".repeat(300));
  expect(await outcome).toMatchObject({ reason: "stderr" });
});
