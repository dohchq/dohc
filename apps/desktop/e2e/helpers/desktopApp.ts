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
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: electronArgs(),
    cwd: desktopRoot,
    env: launchEnv(input),
  });

  const processHandle = app.process();
  processHandle.stdout?.on("data", (chunk: Buffer) => {
    logs.push({ source: "main", level: "stdout", text: chunk.toString() });
  });
  processHandle.stderr?.on("data", (chunk: Buffer) => {
    logs.push({ source: "main", level: "stderr", text: chunk.toString() });
  });

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

  return {
    app,
    page,
    logs,
    close: async () => {
      if (app.windows().length === 0) return;
      await Promise.race([
        app.close(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            processHandle.kill();
            resolve();
          }, 5_000);
        }),
      ]);
    },
  };
}
