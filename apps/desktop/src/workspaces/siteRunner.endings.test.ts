import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCommandStillRunningError, buildSite, startSiteDevServer } from "./siteRunner";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";

// Every tree kill misses the helpers: it records the pids it was asked to
// signal and kills none of the stand-in helpers. Any other root, the wrapper,
// still ends, as its own signal ends it on Windows, so no stop waits out the
// kill grace. `beforeTreeKill` runs first, to hold the stop at that point;
// `duringHelperKill` runs when a helper's own kill is asked for.
const signalled: number[] = [];
// The root pid of each POSIX round, and each Windows helper kill with what
// its own "already exited" check said at that moment.
const posixRoots: number[] = [];
const windowsHelperKills: Array<{ pid: number; exited: boolean }> = [];
const helpers = new Set<number>();
let beforeTreeKill: ((child: ChildProcess | undefined) => Promise<void>) | null = null;
let duringHelperKill: ((pids: number[]) => Promise<void>) | null = null;
vi.mock("../process/windowsSpawn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/windowsSpawn")>()),
  killChildTreeWin32: vi.fn(async (child: ChildProcess) => {
    await beforeTreeKill?.(child);
    return false;
  }),
  killProcessTreeWin32: vi.fn(async (pid: number, exited: () => boolean) => {
    windowsHelperKills.push({ pid, exited: exited() });
    signalled.push(pid);
    await duringHelperKill?.([pid]);
    return false;
  }),
}));
vi.mock("../process/posixSpawn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/posixSpawn")>()),
  killProcessTreePosix: vi.fn(async (pid: number, signal: NodeJS.Signals, options?: { alsoSignal?: number[] }) => {
    await beforeTreeKill?.(undefined);
    posixRoots.push(pid);
    signalled.push(...(options?.alsoSignal ?? []));
    await duringHelperKill?.([pid, ...(options?.alsoSignal ?? [])]);
    if (!helpers.has(pid)) endWrapper(pid, signal);
    return [pid, ...(options?.alsoSignal ?? [])];
  }),
}));

function endWrapper(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

const started: ChildProcess[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers();
  beforeTreeKill = null;
  duringHelperKill = null;
  signalled.length = 0;
  posixRoots.length = 0;
  windowsHelperKills.length = 0;
  helpers.clear();
  for (const each of started.splice(0)) {
    try { each.kill("SIGKILL"); } catch { /* gone */ }
  }
});

// Runs a stop on the other platform's path. Spawning stays on this one.
function onPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platform, value: name });
}

// A process the command left behind, which only its tree kill would reach.
function orphan(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  started.push(child);
  helpers.add(child.pid!);
  return child;
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));

async function app(files: Record<string, string>) {
  const workspaceRoot = await realpath(await createTestScratch("site-runner-endings-"));
  await mkdir(join(workspaceRoot, "portal"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(workspaceRoot, "portal", name), text);
  return workspaceRoot;
}

const SERVER = "require('node:http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port + '/'); });";
const IDLE = "setInterval(() => {}, 1000);";
// A build that writes its output and exits 0.
const BUILT = "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', '<h1>ok</h1>');";

describe("each way an app command ends counts what it left running", () => {
  it("counts a helper that a capture still in flight finds after the stop", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "server.js": SERVER });
    const found = deferred<number[]>();
    const inFlight = deferred<void>();
    let reads = 0;
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantCaptureIntervalMs: 20,
      descendantsReader: async () => {
        reads += 1;
        if (reads === 1) return [];
        inFlight.resolve();
        return found.promise;
      },
    });
    await inFlight.promise;
    await handle.stop();
    const checking = handle.stillRunning!();
    found.resolve([left.pid!]);
    expect(await checking).toContain(left.pid);
  });

  it("answers a dev server that never gets ready with what it left running", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "idle.js": IDLE });
    const starting = startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["idle.js"], readyTimeoutMs: 300,
      descendantsReader: async () => [left.pid!],
    });
    const error = await starting.then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppCommandStillRunningError);
    expect((error as AppCommandStillRunningError).pids).toContain(left.pid);
  });

  it("answers a dev server that exits before it is ready with the helper it left running", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "quit.js": "setTimeout(() => process.exit(3), 200);" });
    const starting = startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["quit.js"],
      descendantsReader: async () => [left.pid!],
    });
    const error = await starting.then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppCommandStillRunningError);
  });

  it("keeps the survivor answer of a build whose timeout passes during its cancel", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "build.js": IDLE });
    const controller = new AbortController();
    const building = buildSite({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["build.js"], signal: controller.signal,
      timeoutMs: 100,
      descendantsReader: async () => {
        queueMicrotask(() => controller.abort());
        return [left.pid!];
      },
    });
    await expect(building).rejects.toBeInstanceOf(AppCommandStillRunningError);
  });

  it("fails a build that exits on its own but leaves a helper running", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "build.js": "setTimeout(() => process.exit(0), 200);" });
    const building = buildSite({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["build.js"],
      descendantsReader: async () => [left.pid!],
    });
    await expect(building).rejects.toBeInstanceOf(AppCommandStillRunningError);
  });

  it("gives no preview for a ready line that arrives during a cancel's cleanup", async () => {
    const workspaceRoot = await app({ "server.js": SERVER });
    const marker = join(workspaceRoot, "portal", "ready");
    // The tree kill waits until the server has printed its URL.
    beforeTreeKill = async (child) => {
      if (child) {
        await new Promise((resolve) => child.stdout?.once("data", resolve));
        return;
      }
      while (!existsSync(marker)) await delay(10);
    };
    await writeFile(join(workspaceRoot, "portal", "server.js"), [
      "const server = require('node:http').createServer((q, r) => r.end('ok'));",
      "server.listen(0, '127.0.0.1', () => {",
      "  console.log('http://127.0.0.1:' + server.address().port + '/');",
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');`,
      "});",
    ].join(String.fromCharCode(10)));
    const controller = new AbortController();
    const starting = startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"], signal: controller.signal,
      descendantsReader: async () => {
        queueMicrotask(() => controller.abort());
        return [];
      },
    });
    await expect(starting).rejects.toThrow();
  });

  it("signals no captured pid on a retry once that pid has died", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "server.js": SERVER });
    let reads = 0;
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantsReader: async () => (reads++ === 0 ? [left.pid!] : []),
    });
    await handle.stop();
    left.kill("SIGKILL");
    await exited(left);
    signalled.length = 0;
    await handle.stop();
    expect(signalled).not.toContain(left.pid);
  });

  it("lets a cancel during a finished build's own cleanup win over its exit", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "build.js": BUILT });
    const controller = new AbortController();
    // The exit's cleanup reaches the helper; the person cancels right then.
    duringHelperKill = async (pids) => {
      if (!pids.includes(left.pid!)) return;
      duringHelperKill = null;
      left.kill("SIGKILL");
      await exited(left);
      controller.abort();
    };
    const result = await buildSite({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["build.js"], output: "dist", signal: controller.signal,
      descendantsReader: async () => [left.pid!],
    });
    expect(result).toMatchObject({ ok: false, exitCode: null });
    expect(result.logs.map((log) => log.text)).toContain("Build cancelled.");
  });

  it("lets a timeout during a finished build's own cleanup win over its exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const left = orphan();
    const workspaceRoot = await app({ "build.js": BUILT });
    duringHelperKill = async (pids) => {
      if (!pids.includes(left.pid!)) return;
      duringHelperKill = null;
      left.kill("SIGKILL");
      await exited(left);
      vi.advanceTimersByTime(60_000);
    };
    const result = await buildSite({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["build.js"], output: "dist", timeoutMs: 60_000,
      descendantsReader: async () => [left.pid!],
    });
    expect(result).toMatchObject({ ok: false, exitCode: null });
    expect(result.logs.map((log) => log.text)).toContain("Build timed out after 60000ms.");
  });

  it("ends a stop whose capture read fails while it waits", async () => {
    const workspaceRoot = await app({ "server.js": SERVER });
    const failing = deferred<number[]>();
    const inFlight = deferred<void>();
    let reads = 0;
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantCaptureIntervalMs: 20,
      descendantsReader: async () => {
        reads += 1;
        if (reads === 1) return [];
        inFlight.resolve();
        return failing.promise;
      },
    });
    await inFlight.promise;
    await handle.stop();
    const checking = handle.stillRunning();
    failing.reject(new Error("PowerShell timed out"));
    await expect(checking).resolves.toEqual([]);
  });

  it("on POSIX, signals a wrapper only while it runs, never once dohc saw it exit", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "server.js": SERVER });
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantsReader: async () => [left.pid!],
    });
    onPlatform("linux");
    await handle.stop();
    const wrapperPid = posixRoots[0]!;
    // The SIGTERM round ends the wrapper; the SIGKILL round roots at the helper.
    expect(posixRoots).toEqual([wrapperPid, left.pid]);
    posixRoots.length = 0;
    await handle.stop();
    expect(posixRoots).toEqual([left.pid, left.pid]);
    expect(posixRoots).not.toContain(wrapperPid);
  });

  it("on Windows, checks each helper right before its own kill", async () => {
    const first = orphan();
    const second = orphan();
    const workspaceRoot = await app({ "server.js": SERVER });
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantsReader: async () => [first.pid!, second.pid!],
    });
    // The first helper's tree kill also ends the second.
    duringHelperKill = async (pids) => {
      if (!pids.includes(first.pid!)) return;
      second.kill("SIGKILL");
      await exited(second);
    };
    onPlatform("win32");
    await handle.stop();
    expect(windowsHelperKills).toContainEqual({ pid: first.pid, exited: false });
    expect(windowsHelperKills.find((kill) => kill.pid === second.pid)?.exited ?? true).toBe(true);
  });

  it("keeps process numbers out of the words a person reads", () => {
    const error = new AppCommandStillRunningError({
      url: "", command: "node", args: [], cwd: "/trip", logs: () => [], onExit: () => undefined, stop: async () => undefined, stillRunning: async () => [],
    }, [43210]);
    expect(error.pids).toEqual([43210]);
    expect(error.message).not.toContain("43210");
    expect(error.message).toContain("app");
    expect(error.message).toContain("Try again");
  });
});
