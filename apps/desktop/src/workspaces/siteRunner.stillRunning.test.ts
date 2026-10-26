import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCommandStillRunningError, buildSite, startSiteDevServer } from "./siteRunner";
import { createTestScratch } from "./testTemp";

// The tree kill misses the helpers: it reports nothing and kills none of
// them. The wrapper itself still ends, as its own signal ends it on Windows,
// so no stop waits out the kill grace.
vi.mock("../process/windowsSpawn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/windowsSpawn")>()),
  killChildTreeWin32: vi.fn(async () => false),
  killProcessTreeWin32: vi.fn(async () => false),
}));
vi.mock("../process/posixSpawn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/posixSpawn")>()),
  killProcessTreePosix: vi.fn(async (pid: number, signal: NodeJS.Signals) => {
    try { process.kill(pid, signal); } catch { /* already gone */ }
    return [];
  }),
}));

const started: ChildProcess[] = [];
afterEach(() => {
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

async function app(files: Record<string, string>) {
  const workspaceRoot = await realpath(await createTestScratch("site-runner-still-running-"));
  await mkdir(join(workspaceRoot, "portal"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(workspaceRoot, "portal", name), text);
  return workspaceRoot;
}

describe("an app command a failed tree kill leaves running", () => {
  it("says which processes outlived the stop of a running dev server", async () => {
    const left = orphan();
    const workspaceRoot = await app({
      "server.js": "require('node:http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port + '/'); });",
    });
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantsReader: async () => [left.pid!],
    });
    await handle.stop();
    expect(await handle.stillRunning!()).toContain(left.pid);
    left.kill("SIGKILL");
    await new Promise((resolve) => left.once("exit", resolve));
    expect(await handle.stillRunning!()).not.toContain(left.pid);
  });

  it("answers a dev server start cancelled before it was ready with a handle that can stop what is left", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "idle.js": "setInterval(() => {}, 1000);" });
    const controller = new AbortController();
    const starting = startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["idle.js"], signal: controller.signal,
      descendantsReader: async () => {
        queueMicrotask(() => controller.abort());
        return [left.pid!];
      },
    });
    const error = await starting.then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppCommandStillRunningError);
    expect((error as AppCommandStillRunningError).pids).toContain(left.pid);
    left.kill("SIGKILL");
    await new Promise((resolve) => left.once("exit", resolve));
    const handle = (error as AppCommandStillRunningError).handle;
    await handle.stop();
    expect(await handle.stillRunning!()).not.toContain(left.pid);
  });

  it("answers a build cancelled while it ran with what is left, not with a finished build", async () => {
    const left = orphan();
    const workspaceRoot = await app({ "build.js": "setInterval(() => {}, 1000);" });
    const controller = new AbortController();
    const building = buildSite({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["build.js"], signal: controller.signal,
      descendantsReader: async () => {
        queueMicrotask(() => controller.abort());
        return [left.pid!];
      },
    });
    await expect(building).rejects.toBeInstanceOf(AppCommandStillRunningError);
  });
});
