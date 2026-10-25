// @vitest-environment node
import { EventEmitter, getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectAgentTools, runProbe } from "./agentToolDetection";
import * as toolProbe from "./agentToolProbe";
import type { ProbeOutput } from "./agentToolProbe";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolveSpawnCommand: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));
vi.mock("./agentToolProbe", async (importOriginal) => ({ ...await importOriginal<typeof import("./agentToolProbe")>() }));
// Detection has no tree-kill dependency: a Windows probe never kills by PID.
vi.mock("../process/windowsSpawn", () => ({ resolveSpawnCommand: mocks.resolveSpawnCommand }));

class FakeStream extends EventEmitter {
  readonly setEncoding = vi.fn((_encoding: BufferEncoding): FakeStream => this);
  readonly destroy = vi.fn();
}

class FakeStdin extends EventEmitter {
  readonly write = vi.fn((_chunk: Buffer): boolean => true);
  readonly destroy = vi.fn();
}

// Like Node's ChildProcess, this closes only after the process exits and both
// output pipes reach EOF. On Windows the process is the probe owner; anything
// in its job holds the pipes until the owner ends the job.
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly stdin: FakeStdin | null;
  readonly stdout: FakeStream | null;
  readonly stderr: FakeStream | null;
  private exited = false;
  private pipesOpen: boolean;
  private closesNeeded: number;

  constructor(readonly pid: number | undefined, { pipes = true } = {}) {
    super();
    this.stdin = pipes ? new FakeStdin() : null;
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

const resources = mkdtempSync(join(tmpdir(), "dohc-agent-probe-resources-"));
const NODE = join(resources, "app-compiler", "node.exe");
const OWNER_ROOT = join(resources, "agent-probe");
const OWNER = join(OWNER_ROOT, "agentProbeOwner.exe");
const RELAY = join(OWNER_ROOT, "agentProbeRelay.mjs");
for (const path of [NODE, OWNER, RELAY]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}
const EXECUTABLE = "C:\\Tools\\claude.EXE";
const reason = new Error("Agent detection was cancelled.");
const realPlatform = process.platform;
const realArch = process.arch;
let child = new FakeChild(4321);

function setPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture = "x64"): void {
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
}

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function start(signal: AbortSignal, resourcesRoot = resources) {
  const seen: { outcome?: { value: ProbeOutput } | { error: unknown } } = {};
  const done = runProbe(EXECUTABLE, ["--version"], signal, resourcesRoot).then(
    (value) => { seen.outcome = { value }; },
    (error: unknown) => { seen.outcome = { error }; },
  );
  return { seen, done };
}

function admitted(): unknown {
  return JSON.parse(child.stdin!.write.mock.calls[0]![0].toString("utf8"));
}

function expectReleased(signal: AbortSignal): void {
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  for (const emitter of [child, child.stdin, child.stdout, child.stderr]) expect(emitter?.eventNames() ?? []).toEqual([]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setPlatform("win32");
  child = new FakeChild(4321);
  mocks.resolveSpawnCommand.mockImplementation((command: string, args: string[]) => ({ command, args }));
  mocks.spawn.mockImplementation(() => child);
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  setPlatform(realPlatform, realArch);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterAll(() => { rmSync(resources, { recursive: true, force: true }); });

describe("agent detection filesystem", () => {
  it.each((["win32", "darwin", "linux"] as const).flatMap((platform) => ["native", "fallback", "unavailable"].map((resolution) => ({ platform, resolution }))))(
    "resolves installed names on $platform using $resolution", async ({ platform, resolution }) => {
      setPlatform(platform);
      const lookup = platform === "win32" ? "C:\\Tools\\claude.exe" : "/usr/local/bin/claude";
      const stored = platform === "win32" ? "C:\\Installed\\claude.exe" : "/opt/installed/claude";
      const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
        if (resolution !== "native") throw new Error("native resolution unavailable");
        return stored;
      });
      const fallbackSpy = vi.spyOn(fs, "realpathSync").mockImplementation(() => {
        if (resolution !== "fallback") throw new Error("resolution unavailable");
        return stored;
      });
      Object.defineProperty(fallbackSpy, "native", { value: nativeSpy, configurable: true });
      const probeSpy = vi.spyOn(toolProbe, "probeAgentTools").mockImplementation(async (deps) => {
        expect(deps.realPath(lookup)).toBe(resolution === "unavailable" ? null : stored);
        return [];
      });
      await detectAgentTools("workspace", new AbortController().signal, resources);
      expect(probeSpy).toHaveBeenCalledOnce();
      expect(nativeSpy).toHaveBeenCalledWith(lookup);
      expect(fallbackSpy).toHaveBeenCalledTimes(resolution === "native" ? 0 : 1);
    },
  );

  it("passes statSync directly to the probe", async () => {
    vi.spyOn(toolProbe, "probeAgentTools").mockImplementation(async (deps) => {
      expect(deps.stat).toBe(fs.statSync);
      return [];
    });
    await detectAgentTools("workspace", new AbortController().signal, resources);
  });

  it("unreadable and missing executable entries leave later entries available", async () => {
    const identity = fs.statSync(NODE);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {});
    vi.spyOn(fs, "statSync").mockImplementation((path) => {
      if (String(path) === "unreadable") throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      if (String(path) === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return identity;
    });
    vi.spyOn(toolProbe, "probeAgentTools").mockImplementation(async (deps) => {
      expect(deps.isExecutable("unreadable")).toBe(false);
      expect(deps.isExecutable("missing")).toBe(false);
      expect(deps.isExecutable("installed")).toBe(true);
      return [];
    });
    await detectAgentTools("workspace", new AbortController().signal, resources);
  });

  it("continues detection after unavailable install entries", async () => {
    const actualProbe = await vi.importActual<typeof import("./agentToolProbe")>("./agentToolProbe");
    vi.spyOn(toolProbe, "probeAgentTools").mockImplementation(actualProbe.probeAgentTools);
    const home = "C:\\Users\\me", windowsApps = `${home}\\AppData\\Local\\Microsoft\\WindowsApps`;
    const missing = `${home}\\missing`, unresolved = `${home}\\unresolved`, installed = `${home}\\AppData\\Roaming\\npm`;
    const candidate = `${installed}\\codex.cmd`, unresolvedCandidate = `${unresolved}\\codex.cmd`;
    vi.stubEnv("Path", [missing, windowsApps, unresolved, installed].join(";"));
    vi.stubEnv("PATHEXT", ".exe;.cmd");
    vi.stubEnv("APPDATA", `${home}\\AppData\\Roaming`);
    const identity = fs.statSync(NODE);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {});
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((path) => {
      const value = String(path);
      if (value.startsWith(windowsApps)) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      if (value === candidate || value === unresolvedCandidate || [NODE, OWNER, RELAY].includes(value)) return identity;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const nativeSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw new Error("native resolution unavailable"); });
    const fallbackSpy = vi.spyOn(fs, "realpathSync").mockImplementation((path) => {
      if (String(path) === unresolvedCandidate) throw new Error("resolution unavailable");
      return String(path);
    });
    Object.defineProperty(fallbackSpy, "native", { value: nativeSpy, configurable: true });
    mocks.spawn.mockImplementation(() => {
      const probeChild = new FakeChild(4321);
      queueMicrotask(() => { probeChild.stdout!.emit("data", "1.2.3"); probeChild.drain(0); });
      return probeChild;
    });
    const tools = await detectAgentTools("C:\\Projects\\Work", new AbortController().signal, resources);
    expect(tools.find((tool) => tool.tool === "codex")).toMatchObject({ executable: candidate, probe: "detected" });
    expect(statSpy).toHaveBeenCalledWith(`${windowsApps}\\codex.exe`);
    expect(statSpy).toHaveBeenCalledWith(`${missing}\\codex.exe`);
    expect(fallbackSpy).toHaveBeenCalledWith(unresolvedCandidate);
    expect(mocks.resolveSpawnCommand).toHaveBeenCalledTimes(2);
    expect(mocks.resolveSpawnCommand).toHaveBeenCalledWith(candidate, ["--version"], { cwd: homedir() });
  });
});

describe("Windows agent probe owner", () => {
  it("starts the installed owner without credentials and admits the exact command over stdin", async () => {
    process.env.DOHC_SYNTHETIC_SECRET = "credential";
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      child.stdout!.emit("data", "claude 2.1.300");
      child.stderr!.emit("data", "note");
      child.drain(0);
      await probe.done;
    } finally {
      delete process.env.DOHC_SYNTHETIC_SECRET;
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: 0, stdout: "claude 2.1.300", stderr: "note" } });
    expect(mocks.resolveSpawnCommand).toHaveBeenCalledWith(EXECUTABLE, ["--version"], { cwd: homedir() });
    const admission = child.stdin!.write.mock.calls[0]![0];
    expect(mocks.spawn).toHaveBeenCalledWith(OWNER, [NODE, RELAY, String(admission.byteLength)], {
      cwd: OWNER_ROOT, env: expect.any(Object), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const ownerEnvironment = mocks.spawn.mock.calls[0]![2].env as Record<string, string>;
    expect(Object.keys(ownerEnvironment).filter((name) => !["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(name))).toEqual([]);
    expect(admitted()).toEqual({
      command: EXECUTABLE, args: ["--version"], windowsVerbatimArguments: false, cwd: homedir(),
      env: { ...process.env, DOHC_SYNTHETIC_SECRET: "credential" },
    });
    expect(child.stdin!.write).toHaveBeenCalledOnce();
    expect(child.stdin!.destroy).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("admits a cmd wrapper's resolved verbatim arguments unchanged", async () => {
    const wrapper = { command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", "\"\"C:\\Tools\\codex.cmd\" \"--version\"\""], windowsVerbatimArguments: true };
    mocks.resolveSpawnCommand.mockReturnValue(wrapper);
    const controller = new AbortController();
    const probe = start(controller.signal);
    try { child.drain(0); await probe.done; } finally { child.drain(); await probe.done; }
    expect(admitted()).toMatchObject({ ...wrapper, cwd: homedir() });
    expectReleased(controller.signal);
  });

  it("rejects an already cancelled probe before resolving or spawning a command", async () => {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(runProbe(EXECUTABLE, ["--version"], controller.signal, resources)).rejects.toBe(reason);
    expect(mocks.resolveSpawnCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it.each(["resolveSpawnCommand", "spawn"] as const)("rejects a synchronous %s failure without a timer or listener", async (step) => {
    const failure = new Error(`${step} failed`);
    mocks[step].mockImplementation(() => { throw failure; });
    const controller = new AbortController();
    await expect(runProbe(EXECUTABLE, ["--version"], controller.signal, resources)).rejects.toBe(failure);
    expectReleased(controller.signal);
  });

  it.each([
    { name: "a missing installed asset", root: () => join(resources, "missing"), arch: "x64" as const, message: /missing/ },
    { name: "a relative resources path", root: () => "resources", arch: "x64" as const, message: /absolute/ },
    { name: "Windows on arm64", root: () => resources, arch: "arm64" as const, message: /x64/ },
  ])("fails closed without spawning for $name", async ({ root, arch, message }) => {
    setPlatform("win32", arch);
    const controller = new AbortController();
    await expect(runProbe(EXECUTABLE, ["--version"], controller.signal, root())).rejects.toThrow(message);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("stops a cancelled probe by closing the owner's stdin and settles only after every pipe closes", async () => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      controller.abort(reason);
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
      child.exit(null);
      vi.advanceTimersByTime(60_000);
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.closePipes();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expect(child.stdin!.destroy).toHaveBeenCalledOnce();
    expect(child.stdout!.destroy).not.toHaveBeenCalled();
    expect(child.stderr!.destroy).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("times out five seconds after spawn and keeps the partial output", async () => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      child.stdout!.emit("data", "partial");
      vi.advanceTimersByTime(4_999);
      expect(child.stdin!.destroy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain(1);
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: "partial", stderr: "" } });
    expectReleased(controller.signal);
  });

  it("stops collecting and stops the owner once when output exceeds the limit", async () => {
    const controller = new AbortController();
    const chunk = "x".repeat(64 * 1024);
    const probe = start(controller.signal);
    try {
      child.stdout!.emit("data", chunk);
      expect(child.stdin!.destroy).not.toHaveBeenCalled();
      child.stderr!.emit("data", "y");
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
      child.stdout!.emit("data", "late");
      child.stderr!.emit("data", "late");
      child.drain();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ value: { exitCode: null, stdout: chunk, stderr: "y" } });
    expect(child.stdin!.destroy).toHaveBeenCalledOnce();
    expectReleased(controller.signal);
  });

  it("treats a stdin failure as a stop and waits for the owner to close", async () => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      child.stdin!.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
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

  it("reports cancellation that arrives while a timed-out probe drains", async () => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      vi.advanceTimersByTime(5_000);
      controller.abort(reason);
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
      child.drain();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expectReleased(controller.signal);
  });

  it.each([
    { source: "child", emitter: (): EventEmitter => child },
    { source: "stdout", emitter: (): EventEmitter => child.stdout! },
  ])("stops a started owner after a $source error and waits for it to close", async ({ emitter }) => {
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      emitter().emit("error", new Error("pipe failed"));
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
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

  it("waits for Node to close an owner that never started", async () => {
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
    expect(process.kill).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });

  it("handles a later spawn error from an owner that has no pipes", async () => {
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
    expectReleased(controller.signal);
  });

  it("admits nothing when output setup fails and rejects once the owner closes", async () => {
    const failure = new Error("setEncoding failed");
    child.stdout!.setEncoding.mockImplementation(() => { throw failure; });
    const controller = new AbortController();
    const probe = start(controller.signal);
    try {
      expect(child.stdin!.write).not.toHaveBeenCalled();
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain(1);
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: failure });
    expectReleased(controller.signal);
  });

  it("admits nothing when cancellation arrives during spawn", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementation(() => { controller.abort(reason); return child; });
    const probe = start(controller.signal);
    try {
      expect(child.stdin!.write).not.toHaveBeenCalled();
      expect(child.stdin!.destroy).toHaveBeenCalledOnce();
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain(1);
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expectReleased(controller.signal);
  });
});

describe("POSIX agent probe", () => {
  it("kills the process group once on cancellation and waits for it to close", async () => {
    setPlatform("linux");
    const controller = new AbortController();
    const probe = start(controller.signal, join(resources, "missing"));
    try {
      expect(mocks.spawn).toHaveBeenCalledWith(EXECUTABLE, ["--version"], expect.objectContaining({
        cwd: homedir(), windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"],
      }));
      controller.abort(reason);
      vi.advanceTimersByTime(5_000);
      expect(process.kill).toHaveBeenCalledOnce();
      expect(process.kill).toHaveBeenCalledWith(-4321, "SIGKILL");
      await turn();
      expect(probe.seen.outcome).toBeUndefined();
      child.drain();
      await probe.done;
    } finally {
      child.drain();
      await probe.done;
    }
    expect(probe.seen.outcome).toEqual({ error: reason });
    expect(child.stdin!.write).not.toHaveBeenCalled();
    expect(child.stdin!.destroy).not.toHaveBeenCalled();
    expectReleased(controller.signal);
  });
});
