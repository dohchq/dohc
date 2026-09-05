import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { closeElectronApplication } from "./closeElectronApplication";

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
  expect(() => process.kill(descendantPid, 0)).toThrow();
  descendantPids.splice(descendantPids.indexOf(descendantPid), 1);
});

test("a completed close waits for process exit without reporting a failure", async () => {
  const child = await liveProcess();
  await closeElectronApplication({ close: async () => { child.kill(); await once(child, "exit"); } }, child);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  await closeElectronApplication({ close: async () => { throw new Error("already closed"); } }, child);
});
