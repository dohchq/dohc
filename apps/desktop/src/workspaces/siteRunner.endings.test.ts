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
// signal and kills none of them. The wrapper itself still ends, as its own
// signal ends it on Windows, so no stop waits out the kill grace.
// `beforeTreeKill` runs first, to hold the stop at that point.
const signalled: number[] = [];
let beforeTreeKill: ((child: ChildProcess | undefined) => Promise<void>) | null = null;
vi.mock("../process/windowsSpawn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/windowsSpawn")>()),
  killChildTreeWin32: vi.fn(async (child: ChildProcess) => {
    await beforeTreeKill?.(child);
    return false;
  }),
  killProcessTreeWin32: vi.fn(async (pid: number) => {
    signalled.push(pid);
    return false;
  }),
}));
vi.mock("../process/posixSpawn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/posixSpawn")>()),
  killProcessTreePosix: vi.fn(async (pid: number, signal: NodeJS.Signals, options?: { alsoSignal?: number[] }) => {
    await beforeTreeKill?.(undefined);
    signalled.push(...(options?.alsoSignal ?? []));
    endWrapper(pid, signal);
    return options?.alsoSignal ?? [];
  }),
}));

function endWrapper(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

const started: ChildProcess[] = [];
afterEach(() => {
  beforeTreeKill = null;
  signalled.length = 0;
  for (const each of started.splice(0)) {
    try { each.kill("SIGKILL"); } catch { /* gone */ }
  }
});

// A process the command left behind, which only its tree kill would reach.
function orphan(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  started.push(child);
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

  it("keeps process numbers out of the words a person reads", () => {
    const error = new AppCommandStillRunningError({
      url: "", command: "node", args: [], cwd: "/trip", logs: () => [], onExit: () => undefined, stop: async () => undefined,
    }, [43210]);
    expect(error.pids).toEqual([43210]);
    expect(error.message).not.toContain("43210");
    expect(error.message).toContain("app");
    expect(error.message).toContain("Try again");
  });
});
