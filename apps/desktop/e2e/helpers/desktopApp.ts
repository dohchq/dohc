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
import { closeElectronApplication } from "../../../../scripts/verification/close-electron.mjs";
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

function requireBuiltDesktopApp() {
  const build = assertPrepared();
  if (!existsSync(mainEntry) || !existsSync(rendererEntry)) {
    throw new Error(
      "Desktop E2E needs a built Electron app. Run `pnpm --filter @dohc/desktop build` first.",
    );
  }
  return build;
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
  const build = requireBuiltDesktopApp();
  const userDataDir = await createUserDataDir(input.workspace);
  const artifacts = test.info().outputPath(`electron-${randomUUID()}`);
  await mkdir(artifacts, { recursive: true });

  const logs: DesktopLogEntry[] = [];
  const logPath = join(artifacts, "desktop.jsonl");
  await writeFile(logPath, "");
  let logFailure: unknown;
  const record = (entry: DesktopLogEntry) => {
    logs.push(entry);
    try { appendFileSync(logPath, JSON.stringify(entry) + "\n"); }
    catch (error) { logFailure ??= error; }
  };
  const onStdoutData = (chunk: string) => {
    record({ source: "main", level: "stdout", text: chunk });
  };
  const onStderrData = (chunk: string) => {
    record({ source: "main", level: "stderr", text: chunk });
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
    processHandle.stdout?.setEncoding("utf8").on("data", onStdoutData);
    processHandle.stderr?.setEncoding("utf8").on("data", onStderrData);

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
      launcherPid: launchedProcess.pid, electronPid: await launchedApp.evaluate(() => process.pid),
      root: desktopRoot, userDataDir,
      workspace: input.workspace.rootPath, build,
    }, null, 2));
    return {
      app: launchedApp,
      page,
      logs,
      close: async () => {
        try {
          if (!page.isClosed()) {
            await page.screenshot({ path: join(artifacts, "last-screen.png"), timeout: 5000 }).catch(() => undefined);
          }
        } finally {
          try {
            await closeElectronApplication(launchedApp, launchedProcess);
          } finally {
            launchedProcess.stdout?.off("data", onStdoutData);
            launchedProcess.stderr?.off("data", onStderrData);
            await test.info().attach("desktop logs", { path: logPath, contentType: "application/x-ndjson" });
            if (logFailure) throw new Error("Desktop log recording failed.", { cause: logFailure });
          }
        }
      },
    };
  } catch (error) {
    try {
      await writeFile(join(artifacts, "launch-error.txt"), String(error)).catch(() => undefined);
    } finally {
      try {
        if (app && processHandle) await closeElectronApplication(app, processHandle);
      } catch (cleanupError) {
        console.error("Failed-launch cleanup:", cleanupError);
      } finally {
        processHandle?.stdout?.off("data", onStdoutData);
        processHandle?.stderr?.off("data", onStderrData);
      }
    }
    throw error;
  }
}
