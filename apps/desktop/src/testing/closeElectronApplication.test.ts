import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { closeDebugApplication, closeElectronApplication } from "../../../../scripts/verification/close-electron.mjs";

const children: ChildProcess[] = [];
const descendantPids: number[] = [];

async function liveProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await once(child.stdout!, "data");
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

test("a rejected Electron close still stops the recorded live process", async () => {
  const child = await liveProcess();
  const failure = new Error("close rejected");
  await expect(closeElectronApplication({ close: async () => { throw failure; } }, child, 50)).rejects.toBe(failure);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("a hung Electron close is bounded and stops the recorded live process", async () => {
  const child = await liveProcess();
  await expect(closeElectronApplication({ close: () => new Promise(() => {}) }, child, 50)).rejects.toThrow("Electron close timed out");
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test.skipIf(process.platform !== "win32")("failed close stops Windows launcher descendants as well as the launcher", async () => {
  const child = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process');const nested=spawn(process.execPath,['-e','setInterval(() => {},1000)'],{stdio:'ignore'});console.log(nested.pid);setInterval(() => {},1000)"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const [output] = await once(child.stdout!, "data");
  const descendantPid = Number(String(output).trim());
  expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
  descendantPids.push(descendantPid);
  await expect(closeElectronApplication({ close: async () => { throw new Error("close rejected"); } }, child)).rejects.toThrow("close rejected");
  // taskkill /F starts termination and returns; a loaded host can finish it later.
  await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow());
  descendantPids.splice(descendantPids.indexOf(descendantPid), 1);
});

test("a completed close waits for process exit without reporting a failure", async () => {
  const child = await liveProcess();
  await closeElectronApplication({ close: async () => { child.kill(); await once(child, "exit"); } }, child);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  await closeElectronApplication({ close: async () => { throw new Error("already closed"); } }, child);
});

test("debug shutdown stops its process when screenshot recording rejects and tracing and close hang", async () => {
  const child = await liveProcess();
  let traceAttempted = false;
  let closeAttempted = false;
  const app = {
    windows: () => [{ screenshot: async () => { throw new Error("screenshot failed"); } }],
    context: () => ({ tracing: { stop: () => { traceAttempted = true; return new Promise(() => {}); } } }),
    close: () => { closeAttempted = true; return new Promise<void>(() => {}); },
  };
  await expect(closeDebugApplication(app, child, "unused-output", { artifactTimeoutMs: 25, closeTimeoutMs: 25 })).rejects.toThrow("Electron close timed out");
  expect(traceAttempted && closeAttempted).toBe(true);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("debug shutdown still closes its process when window enumeration fails", async () => {
  const child = await liveProcess();
  const failure = new Error("window enumeration failed");
  const app = {
    windows: () => { throw failure; },
    close: async () => { child.kill(); await once(child, "exit"); },
  };
  await expect(closeDebugApplication(app, child, "unused-output")).rejects.toBe(failure);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test.each([
  { contents: ["first window"], names: ["last-screen.png"] },
  { contents: ["first window", "second window"], names: ["last-screen-1.png", "last-screen-2.png"] },
])("debug shutdown retains each screenshot: $names", async ({ contents, names }) => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-debug-screenshots-"));
  try {
    const child = await liveProcess();
    const paths: string[] = [];
    const app = {
      windows: () => contents.map((content) => ({
        screenshot: async ({ path }: { path: string }) => {
          paths.push(path);
          await writeFile(path, content);
        },
      })),
      context: () => ({ tracing: { stop: async () => {} } }),
      close: async () => { child.kill(); await once(child, "exit"); },
    };
    await closeDebugApplication(app, child, directory);
    expect(paths).toEqual(names.map((name) => join(directory, name)));
    expect((await readdir(directory)).sort()).toEqual(names);
    expect(await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))).toEqual(contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
