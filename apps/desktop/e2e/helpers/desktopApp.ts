import { type Page } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
} from "playwright";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  if (!existsSync(mainEntry) || !existsSync(rendererEntry)) {
    throw new Error(
      "Desktop E2E needs a built Electron app. Run `pnpm --filter @dohc/desktop build` first.",
    );
  }
}

function electronArgs(): string[] {
  return process.platform === "linux"
    ? ["--no-sandbox", mainEntry]
    : [mainEntry];
}

function launchEnv(input: {
  workspace: Pick<TempWorkspace, "homeDir" | "rootPath">;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const entries = Object.entries({
    ...process.env,
    CI: process.env.CI ?? "1",
    DOHC_DESKTOP_TEST: "1",
    DOHC_TEST_HOME: input.workspace.homeDir,
    DOHC_TEST_PICK_PATH: input.workspace.rootPath,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    ...input.env,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const env = Object.fromEntries(entries);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export async function launchDesktopApp(input: {
  workspace: Pick<TempWorkspace, "homeDir" | "rootPath">;
  env?: NodeJS.ProcessEnv;
}): Promise<LaunchedDesktopApp> {
  requireBuiltDesktopApp();

  const logs: DesktopLogEntry[] = [];
  const onStdoutData = (chunk: Buffer) => {
    logs.push({ source: "main", level: "stdout", text: chunk.toString() });
  };
  const onStderrData = (chunk: Buffer) => {
    logs.push({ source: "main", level: "stderr", text: chunk.toString() });
  };

  let app: ElectronApplication | null = null;
  let processHandle: ElectronProcess | null = null;
  try {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: electronArgs(),
      cwd: desktopRoot,
      env: launchEnv(input),
    });

    processHandle = app.process();
    processHandle.stdout?.on("data", onStdoutData);
    processHandle.stderr?.on("data", onStderrData);

    const page = await app.firstWindow();
    page.on("console", (message) => {
      logs.push({
        source: "renderer",
        level: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      logs.push({
        source: "renderer",
        level: "pageerror",
        text: error.message,
      });
    });

    const launchedApp = app;
    const launchedProcess = processHandle;
    return {
      app: launchedApp,
      page,
      logs,
      close: async () => {
        const abort = new AbortController();
        try {
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
        }
      },
    };
  } catch (error) {
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
  if (!(await waitForProcessExit(processHandle, 1_000)) && processIsRunning(processHandle)) {
    processHandle.kill("SIGKILL");
    await waitForProcessExit(processHandle, 1_000);
  }
}
