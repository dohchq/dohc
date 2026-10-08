// @vitest-environment node
import { EventEmitter, getEventListeners } from "node:events";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "../testing/deferred";
import { runProbe } from "./agentToolDetection";
import type { ProbeOutput } from "./agentToolProbe";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), killChildTreeWin32: vi.fn(), resolveSpawnCommand: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../process/windowsSpawn", () => ({
  killChildTreeWin32: mocks.killChildTreeWin32, resolveSpawnCommand: mocks.resolveSpawnCommand,
}));

class FakeStream extends EventEmitter {
  readonly setEncoding = vi.fn((_encoding: BufferEncoding): FakeStream => this);
  readonly destroy = vi.fn();
}

// Like Node's ChildProcess, this closes only after the process exits and both
// pipes reach EOF. A descendant that inherited the pipes holds them open after
// the process itself exits.
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly stdout: FakeStream | null;
  readonly stderr: FakeStream | null;
  private exited = false;
  private pipesOpen: boolean;
  private closesNeeded: number;

  constructor(readonly pid: number | undefined, { pipes = true } = {}) {
    super();
    this.stdout = pipes ? new FakeStream() : null;
    this.stderr = pipes ? new FakeStream() : null;
    this.pipesOpen = pipes;
    this.closesNeeded = pipes ? 3 : 1;
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.closeOne();
  }

  closePipes(): void {
    if (!this.pipesOpen) return;
    this.pipesOpen = false;
    this.closeOne();
    this.closeOne();
  }

  drain(code: number | null = null): void {
    this.exit(code);
    this.closePipes();
  }

  private closeOne(): void {
    this.closesNeeded -= 1;
    if (this.closesNeeded === 0) this.emit("close", this.exitCode, null);
  }
}

const EXECUTABLE = "C:\\Tools\\claude.EXE";
const reason = new Error("Agent detection was cancelled.");
const realPlatform = process.platform;
let child = new FakeChild(4321);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function start(signal: AbortSignal) {
  const seen: { outcome?: { value: ProbeOutput } | { error: unknown } } = {};
  const done = runProbe(EXECUTABLE, ["--version"], signal).then(
    (value) => { seen.outcome = { value }; },
    (error: unknown) => { seen.outcome = { error }; },
  );
  return { seen, done };
}

function gatedKill(): Deferred<boolean> {
  const killed = deferred<boolean>();
  mocks.killChildTreeWin32.mockReturnValue(killed.promise);
  return killed;
}

function expectReleased(signal: AbortSignal): void {
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  for (const emitter of [child, child.stdout, child.stderr]) expect(emitter?.eventNames() ?? []).toEqual([]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setPlatform("win32");
  child = new FakeChild(4321);
  mocks.resolveSpawnCommand.mockImplementation((command: string, args: string[]) => ({ command, args }));
  mocks.spawn.mockImplementation(() => child);
  mocks.killChildTreeWin32.mockResolvedValue(true);
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("agent probe subprocess", () => {
  it("resolves a closed probe's output from the home directory without terminating it", async () => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      child.stdout!.emit("data", "claude 2.1.300");
      child.stderr!.emit("data", "note");
      child.drain(0);
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: 0, stdout: "claude 2.1.300", stderr: "note" } });
    expect(mocks.resolveSpawnCommand).toHaveBeenCalledWith(EXECUTABLE, ["--version"], { cwd: homedir() });
    expect(mocks.spawn).toHaveBeenCalledWith(EXECUTABLE, ["--version"], expect.objectContaining({
      cwd: homedir(), windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"],
    }));
    expect(child.stdout!.setEncoding).toHaveBeenCalledWith("utf8");
    expect(mocks.killChildTreeWin32).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("rejects an already cancelled probe before resolving or spawning a command", async () => {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(runProbe(EXECUTABLE, ["--version"], controller.signal)).rejects.toBe(reason);
    expect(mocks.resolveSpawnCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it.each(["resolveSpawnCommand", "spawn"] as const)("rejects a synchronous %s failure without a timer or listener", async (step) => {
    const failure = new Error(`${step} failed`);
    mocks[step].mockImplementation(() => { throw failure; });
    const controller = new AbortController();
    await expect(runProbe(EXECUTABLE, ["--version"], controller.signal)).rejects.toBe(failure);
    expectReleased(controller.signal);
  });

  it("cancels once and settles only after the tree kill finishes and every pipe closes", async () => {
    const controller = new AbortController();
    const killed = gatedKill();
    const probe = start(controller.signal);
    try {
      controller.abort(reason);
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      expect(mocks.killChildTreeWin32).toHaveBeenCalledWith(child);
      killed.resolve(true);
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.exit(null);
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.closePipes();
      await probe.done;
    } finally {
      killed.resolve(false);
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
    expect(child.stdout!.destroy).not.toHaveBeenCalled();
    expect(child.stderr!.destroy).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("times out once and stays pending after close until the tree kill finishes", async () => {
    const controller = new AbortController();
    const killed = gatedKill();
    const probe = start(controller.signal);
    try {
      child.stdout!.emit("data", "partial");
      vi.advanceTimersByTime(4_999);
      expect(mocks.killChildTreeWin32).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      child.drain();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      killed.resolve(true);
      await probe.done;
    } finally {
      killed.resolve(false);
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: "partial", stderr: "" } });
    expectReleased(controller.signal);
  });

  it("stops collecting and terminates once when output exceeds the limit", async () => {
    const controller = new AbortController();
    const chunk = "x".repeat(64 * 1024);
    const probe = start(controller.signal);
    try {
      child.stdout!.emit("data", chunk);
      expect(mocks.killChildTreeWin32).not.toHaveBeenCalled();
      child.stderr!.emit("data", "y");
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      child.stdout!.emit("data", "late");
      child.stderr!.emit("data", "late");
      child.drain();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: chunk, stderr: "y" } });
    expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
    expect(child.stdout!.destroy).not.toHaveBeenCalled();
    expect(child.stderr!.destroy).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it.each([
    { result: "reports failure", finishKill: (killed: Deferred<boolean>) => { killed.resolve(false); } },
    { result: "rejects", finishKill: (killed: Deferred<boolean>) => { killed.reject(new Error("taskkill failed")); } },
  ])("keeps a cancelled probe pending after its tree kill $result until the child closes", async ({ finishKill }) => {
    const controller = new AbortController();
    const killed = gatedKill();
    const probe = start(controller.signal);
    try {
      controller.abort(reason);
      finishKill(killed);
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain();
      await probe.done;
    } finally {
      killed.resolve(false);
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
    expectReleased(controller.signal);
  });

  it("reports cancellation that arrives while a timed-out probe drains", async () => {
    const controller = new AbortController();
    const killed = gatedKill();
    const probe = start(controller.signal);
    try {
      vi.advanceTimersByTime(5_000);
      controller.abort(reason);
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      child.drain();
      killed.resolve(true);
      await probe.done;
    } finally {
      killed.resolve(false);
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expectReleased(controller.signal);
  });

  it.each([
    { source: "child", emitter: (): EventEmitter => child },
    { source: "stdout", emitter: (): EventEmitter => child.stdout! },
  ])("terminates a started child after a $source error and waits for it to close", async ({ emitter }) => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      emitter().emit("error", new Error("pipe failed"));
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain(1);
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: "", stderr: "" } });
    expectReleased(controller.signal);
  });

  it("waits for Node to close a child that never started without terminating it", async () => {
    child = new FakeChild(undefined);
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      child.exit(-4058);
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.closePipes();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: "", stderr: "" } });
    expect(mocks.killChildTreeWin32).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("handles a later spawn error from a child that has no pipes", async () => {
    child = new FakeChild(undefined, { pipes: false });
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      expect(() => child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }))).not.toThrow();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.exit(-4066);
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: "", stderr: "" } });
    expect(mocks.killChildTreeWin32).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("keeps a child whose output setup fails until it is terminated and closed", async () => {
    const failure = new Error("setEncoding failed");
    child.stdout!.setEncoding.mockImplementation(() => { throw failure; });
    const controller = new AbortController();
    const killed = gatedKill();
    const probe = start(controller.signal);
    try {
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      child.drain();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      killed.resolve(true);
      await probe.done;
    } finally {
      killed.resolve(false);
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: failure });
    expectReleased(controller.signal);
  });

  it("terminates a child when cancellation arrives during spawn", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementation(() => { controller.abort(reason); return child; });
    const probe = start(controller.signal);
    try {
      expect(mocks.killChildTreeWin32).toHaveBeenCalledOnce();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expectReleased(controller.signal);
  });

  it("kills the POSIX process group once on cancellation and waits for it to close", async () => {
    setPlatform("linux");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      expect(mocks.spawn).toHaveBeenCalledWith(EXECUTABLE, ["--version"], expect.objectContaining({ detached: true }));
      controller.abort(reason);
      vi.advanceTimersByTime(5_000);
      expect(kill).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(-4321, "SIGKILL");
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expect(mocks.killChildTreeWin32).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });
});
