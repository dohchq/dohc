import { test, type Page } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
} from "playwright";
import { createRequire } from "node:module";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertPrepared } from "../../../../scripts/verification/build.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronLaunchArgs } from "../../src/testing/electronLaunchArgs";
import type { TempWorkspace } from "./workspace";

export interface DesktopLogEntry {
  source: "main" | "renderer";
  level: string;
  text: string;
}

export interface LaunchedDesktopApp {
  app: ElectronApplication;
  page: Page;
  logs: DesktopLogEntry[];
  close(): Promise<void>;
}

type ElectronProcess = ReturnType<ElectronApplication["process"]>;

const require = createRequire(import.meta.url);
const helpersDir = dirname(fileURLToPath(import.meta.url));
export const desktopRoot = resolve(helpersDir, "../..");
const mainEntry = join(desktopRoot, "dist/main/main.js");
const rendererEntry = join(desktopRoot, "dist/renderer/index.html");
const electronExecutable = require("electron") as string;

function requireBuiltDesktopApp(): void {
  assertPrepared();
  if (!existsSync(mainEntry) || !existsSync(rendererEntry)) {
    throw new Error(
      "Desktop E2E needs a built Electron app. Run `pnpm --filter @dohc/desktop build` first.",
    );
  }
}

// Each run gets its own Electron profile inside the temp workspace sandbox. A
// relaunch inside one spec reuses that spec's profile on purpose, exactly as a
// user relaunching the app keeps theirs.
//
// The sandbox is already unique per run under the test scratch root and
// its teardown already survives Windows' refusal to unlink an open file:
// removeTestScratch retries EBUSY/EPERM, and cleanupDesktopWorkspace logs a
// failure rather than failing the spec. A leaked profile under the scratch run
// root costs disk until the sweep; a shared one costs the run (#530).
async function createUserDataDir(
  workspace: Pick<TempWorkspace, "baseDir">,
): Promise<string> {
  const dir = join(workspace.baseDir, "electron-user-data");
  await mkdir(dir, { recursive: true });
  return dir;
}

function launchEnv(input: {
  workspace: Pick<TempWorkspace, "homeDir" | "rootPath">;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const entries = Object.entries({
    ...process.env,
    CI: process.env.CI ?? "0",
    DOHC_DESKTOP_TEST: "1",
    // The e2e relay is a local plain-http server; the daemon transport only
    // accepts it when this explicit flag is set (and the URL is loopback).
    DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "1",
    DOHC_TEST_HOME: input.workspace.homeDir,
    DOHC_TEST_PICK_PATH: input.workspace.rootPath,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    ...input.env,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const env = Object.fromEntries(entries);
  // Force Electron to launch the desktop UI instead of inheriting a parent test
  // env that makes it behave like plain Node.js.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export async function launchDesktopApp(input: {
  workspace: Pick<TempWorkspace, "baseDir" | "homeDir" | "rootPath">;
  env?: NodeJS.ProcessEnv;
}): Promise<LaunchedDesktopApp> {
  requireBuiltDesktopApp();
  const userDataDir = await createUserDataDir(input.workspace);
  const artifacts = test.info().outputPath(`electron-${randomUUID()}`);
  await mkdir(artifacts, { recursive: true });

  const logs: DesktopLogEntry[] = [];
  const logPath = join(artifacts, "desktop.jsonl");
  const record = (entry: DesktopLogEntry) => {
    logs.push(entry);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  };
  const onStdoutData = (chunk: Buffer) => {
    record({ source: "main", level: "stdout", text: chunk.toString() });
  };
  const onStderrData = (chunk: Buffer) => {
    record({ source: "main", level: "stderr", text: chunk.toString() });
  };

  let app: ElectronApplication | null = null;
  let processHandle: ElectronProcess | null = null;
  try {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: electronLaunchArgs({ mainEntry, userDataDir }),
      cwd: desktopRoot,
      env: launchEnv(input),
      artifactsDir: artifacts,
    });

    processHandle = app.process();
    processHandle.stdout?.on("data", onStdoutData);
    processHandle.stderr?.on("data", onStderrData);

    const page = await app.firstWindow({ timeout: 10_000 });
    page.on("console", (message) => {
      record({
        source: "renderer",
        level: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      record({
        source: "renderer",
        level: "pageerror",
        text: error.message,
      });
    });

    const launchedApp = app;
    const launchedProcess = processHandle;
    await writeFile(join(artifacts, "instance.json"), JSON.stringify({
      pid: launchedProcess.pid, root: desktopRoot, userDataDir,
      workspace: input.workspace.rootPath, build: assertPrepared(),
    }, null, 2));
    return {
      app: launchedApp,
      page,
      logs,
      close: async () => {
        const abort = new AbortController();
        try {
          if (!page.isClosed()) {
            await page.screenshot({ path: join(artifacts, "last-screen.png"), timeout: 5000 }).catch(() => undefined);
          }
          await Promise.race([
            (async () => {
              if (launchedApp.windows().length > 0) {
                await launchedApp.close();
              }
            })().finally(() => abort.abort()),
            forceCloseAfterTimeout(launchedProcess, abort.signal),
          ]);
        } finally {
          abort.abort();
          launchedProcess.stdout?.off("data", onStdoutData);
          launchedProcess.stderr?.off("data", onStderrData);
          const path = join(artifacts, "desktop.jsonl");
          await writeFile(path, logs.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
          await test.info().attach("desktop logs", { path, contentType: "application/x-ndjson" });
        }
      },
    };
  } catch (error) {
    await writeFile(join(artifacts, "launch-error.txt"), String(error));
    await writeFile(join(artifacts, "desktop.jsonl"), logs.map((entry) => JSON.stringify(entry)).join("\n"));
    processHandle?.stdout?.off("data", onStdoutData);
    processHandle?.stderr?.off("data", onStderrData);
    if (app) {
      await app.close().catch(() => undefined);
    }
    throw error;
  }
}

function processIsRunning(processHandle: ElectronProcess): boolean {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}

async function waitForProcessExit(
  processHandle: ElectronProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!processIsRunning(processHandle)) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      processHandle.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    processHandle.once("exit", onExit);
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      processHandle.off("exit", onExit);
      onExit();
    }
  });
}

async function forceCloseAfterTimeout(
  processHandle: ElectronProcess,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 5_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  if (signal.aborted) return;
  if (!processIsRunning(processHandle)) return;
  processHandle.kill("SIGTERM");
  if (!(await waitForProcessExit(processHandle, 1_000))) {
    processHandle.kill("SIGKILL");
    await waitForProcessExit(processHandle, 1_000);
  }
}
