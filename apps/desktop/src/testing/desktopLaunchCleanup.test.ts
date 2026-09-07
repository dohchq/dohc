import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "", child: null as ChildProcess | null,
  launchError: new Error("first window unavailable"),
}));

vi.mock("@playwright/test", () => ({
  test: { info: () => ({ outputPath: (name: string) => join(state.root, name) }) },
}));
vi.mock("playwright", () => ({
  _electron: { launch: async () => ({
    process: () => state.child,
    firstWindow: async () => { throw state.launchError; },
    close: async () => { throw new Error("Electron close rejected"); },
  }) },
}));
vi.mock("../../../../scripts/verification/build.mjs", () => ({ assertPrepared: () => ({}) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (path: import("node:fs").PathLike) => {
    const name = String(path).replaceAll("\\", "/");
    return name.endsWith("dist/main/main.js") || name.endsWith("dist/renderer/index.html") || actual.existsSync(path);
  } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: (...args: Parameters<typeof actual.writeFile>) => {
    if (String(args[0]).endsWith("launch-error.txt")) return Promise.reject(new Error("artifact write rejected"));
    return actual.writeFile(...args);
  } };
});

import { launchDesktopApp } from "../../e2e/helpers/desktopApp";

afterEach(async () => {
  vi.restoreAllMocks();
  if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill("SIGKILL");
    await once(state.child, "exit");
  }
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});

test("a failed launch stops its process even when error recording and graceful close reject", async () => {
  state.root = mkdtempSync(join(tmpdir(), "dohc-launch-cleanup-"));
  state.child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  await once(state.child.stdout!, "data");
  const cleanupLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(launchDesktopApp({ workspace: {
    baseDir: state.root, homeDir: join(state.root, "home"), rootPath: join(state.root, "workspace"),
  } })).rejects.toBe(state.launchError);
  expect(state.child.exitCode !== null || state.child.signalCode !== null).toBe(true);
  expect(cleanupLog).toHaveBeenCalledWith("Failed-launch cleanup:", expect.any(Error));
});
