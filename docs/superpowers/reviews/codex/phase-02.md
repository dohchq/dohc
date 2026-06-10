OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb0ad-2f9b-7652-bf67-92f7f4f19733
--------
user
commit 7781d02
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames 7781d02' in /home/ice/dev/dohc
 succeeded in 0ms:
?? docs/superpowers/reviews/codex/phase-02.md
?? test-results/
/home/ice/dev/dohc
7781d02 (HEAD -> claude/desktop-local-first-cloud-sync) phase2: Scaffold secure Electron desktop app
 apps/desktop/e2e/desktopLaunch.spec.ts             |   47 +
 apps/desktop/electron.vite.config.ts               |   24 +
 apps/desktop/package.json                          |   27 +
 apps/desktop/playwright.config.ts                  |   13 +
 apps/desktop/scripts/smoke-test.mjs                |   61 +
 apps/desktop/src/ipc/bridgeContract.ts             |   38 +
 apps/desktop/src/ipc/channels.ts                   |    9 +
 apps/desktop/src/main.ts                           |   76 +
 apps/desktop/src/performance/launchMarks.ts        |   24 +
 apps/desktop/src/preload.ts                        |   21 +
 apps/desktop/src/renderer/index.html               |   37 +
 apps/desktop/src/renderer/main.ts                  |   33 +
 apps/desktop/src/security/electronSecurity.test.ts |   84 +
 apps/desktop/src/security/electronSecurity.ts      |   78 +
 apps/desktop/src/window/createMainWindow.ts        |   60 +
 apps/desktop/tsconfig.json                         |    4 +
 apps/desktop/vitest.config.ts                      |    8 +
 ...desktop-local-first-cloud-sync.execution-log.md |   37 +-
 package.json                                       |    5 +
 pnpm-lock.yaml                                     | 2502 +++++++++++++++++++-
 pnpm-workspace.yaml                                |    7 +
 21 files changed, 3132 insertions(+), 63 deletions(-)

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
2026-06-10T08:37:11.707306Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open
exec
/bin/bash -lc "git ls-files '*AGENTS.md' && find . -path './node_modules' -prune -o -name AGENTS.md -print" in /home/ice/dev/dohc
 succeeded in 123ms:
./AGENTS.md
./apps/app/AGENTS.md

exec
/bin/bash -lc "git show --no-ext-diff --unified=80 --no-renames --format=fuller 7781d02 -- apps/desktop package.json pnpm-workspace.yaml | sed -n '1,260p'" in /home/ice/dev/dohc
 succeeded in 0ms:
commit 7781d02bcdae6a121429ddc3a6ad70e6dd574cb9
Author:     Ice de Vera <iestyndevera@gmail.com>
AuthorDate: Wed Jun 10 16:36:26 2026 +0800
Commit:     Ice de Vera <iestyndevera@gmail.com>
CommitDate: Wed Jun 10 16:36:26 2026 +0800

    phase2: Scaffold secure Electron desktop app
    
    electron-vite scaffold with strict security: contextIsolation+sandbox,
    no nodeIntegration, exact-origin navigation policy (no prefix-match
    bypass), universal window.open denial with http(s) shell routing,
    sender-validated zod-parsed IPC, narrow contextBridge surface, launch
    performance marks from day one (315ms first paint), dedicated desktop
    Playwright config, 8s fatal-stderr smoke. Verifiers probed the runtime
    bridge surface and confirmed no Node reach.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/e2e/desktopLaunch.spec.ts b/apps/desktop/e2e/desktopLaunch.spec.ts
new file mode 100644
index 0000000..565d61b
--- /dev/null
+++ b/apps/desktop/e2e/desktopLaunch.spec.ts
@@ -0,0 +1,47 @@
+import { expect, test } from "@playwright/test";
+import { mkdir, writeFile } from "node:fs/promises";
+import { _electron as electron } from "playwright";
+
+const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
+const PERF_FILE = "test-results/performance/desktop-performance.json";
+
+test("launches dohc desktop and renders the first-run shell", async () => {
+  const launchArgs = ["apps/desktop/dist/main/main.js"];
+  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
+    launchArgs.push("--no-sandbox");
+  }
+  const app = await electron.launch({
+    args: launchArgs,
+    cwd: process.cwd(),
+    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
+  });
+
+  const page = await app.firstWindow();
+  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
+
+  await mkdir(SCREENSHOT_DIR, { recursive: true });
+  await page.setViewportSize({ width: 1280, height: 800 });
+  await page.screenshot({
+    path: `${SCREENSHOT_DIR}/first-run--1280x800--light.png`,
+  });
+
+  // Launch performance marks flow through the test-only bridge from day one;
+  // Phase 16 ratchets these numbers into a hard gate.
+  const marks = await page.evaluate(() =>
+    (window as never as {
+      dohcDesktopTest?: { getLaunchMarks(): Promise<Record<string, number>> };
+    }).dohcDesktopTest?.getLaunchMarks(),
+  );
+  expect(marks).toBeTruthy();
+  expect(marks?.appReadyMs).toBeGreaterThan(0);
+  expect(marks?.firstWindowMs).toBeGreaterThan(0);
+  expect(marks?.firstPaintMs).toBeGreaterThan(0);
+
+  await mkdir("test-results/performance", { recursive: true });
+  await writeFile(
+    PERF_FILE,
+    JSON.stringify({ phase: 2, launch: marks }, null, 2),
+  );
+
+  await app.close();
+});
diff --git a/apps/desktop/electron.vite.config.ts b/apps/desktop/electron.vite.config.ts
new file mode 100644
index 0000000..ba94e75
--- /dev/null
+++ b/apps/desktop/electron.vite.config.ts
@@ -0,0 +1,24 @@
+import { defineConfig } from "electron-vite";
+
+export default defineConfig({
+  main: {
+    build: {
+      outDir: "dist/main",
+      lib: { entry: "src/main.ts" },
+    },
+  },
+  preload: {
+    build: {
+      outDir: "dist/preload",
+      // Sandboxed preloads must be CommonJS.
+      lib: { entry: "src/preload.ts", formats: ["cjs"] },
+    },
+  },
+  renderer: {
+    root: "src/renderer",
+    build: {
+      outDir: "dist/renderer",
+      rollupOptions: { input: "src/renderer/index.html" },
+    },
+  },
+});
diff --git a/apps/desktop/package.json b/apps/desktop/package.json
new file mode 100644
index 0000000..46bbf67
--- /dev/null
+++ b/apps/desktop/package.json
@@ -0,0 +1,27 @@
+{
+  "name": "@dohc/desktop",
+  "private": true,
+  "version": "0.1.0",
+  "type": "module",
+  "main": "dist/main/main.js",
+  "scripts": {
+    "dev": "electron-vite dev",
+    "build": "electron-vite build",
+    "test": "vitest run",
+    "typecheck": "tsc --noEmit"
+  },
+  "devDependencies": {
+    "@electron/fuses": "^2.1.2",
+    "@types/node": "^22.19.19",
+    "electron": "^42.4.0",
+    "electron-builder": "^26.15.2",
+    "electron-vite": "^5.0.0",
+    "typescript": "^5.9.3",
+    "vite": "^8.0.14",
+    "vitest": "^2.1.9"
+  },
+  "dependencies": {
+    "electron-updater": "^6.8.9",
+    "zod": "^3.25.76"
+  }
+}
diff --git a/apps/desktop/playwright.config.ts b/apps/desktop/playwright.config.ts
new file mode 100644
index 0000000..846dbb4
--- /dev/null
+++ b/apps/desktop/playwright.config.ts
@@ -0,0 +1,13 @@
+import { defineConfig } from "@playwright/test";
+
+// Dedicated desktop E2E config: Electron instances cannot safely run in
+// parallel on one display, and the web app's dev server is irrelevant here.
+// The root playwright.config.ts stays untouched for `pnpm test:e2e` (web).
+export default defineConfig({
+  testDir: "./e2e",
+  workers: 1,
+  timeout: 60_000,
+  retries: 0,
+  reporter: [["list"]],
+  outputDir: "../../test-results/desktop-e2e",
+});
diff --git a/apps/desktop/scripts/smoke-test.mjs b/apps/desktop/scripts/smoke-test.mjs
new file mode 100644
index 0000000..8db44dc
--- /dev/null
+++ b/apps/desktop/scripts/smoke-test.mjs
@@ -0,0 +1,61 @@
+import { spawn } from "node:child_process";
+import { existsSync } from "node:fs";
+import { join } from "node:path";
+
+// Spawns the built desktop app for a few seconds and fails on fatal stderr
+// patterns (t3code's smoke pattern). Catches broken builds that unit tests
+// cannot see: missing modules, preload failures, renderer crashes.
+
+const repoRoot = process.cwd();
+const mainEntry = join(repoRoot, "apps/desktop/dist/main/main.js");
+
+if (!existsSync(mainEntry)) {
+  console.error(`Desktop build missing: ${mainEntry} — run pnpm build:desktop first.`);
+  process.exit(1);
+}
+
+const FATAL_PATTERNS = [
+  /MODULE_NOT_FOUND/,
+  /Uncaught (Error|Exception)/i,
+  /Cannot find module/,
+  /Unable to load preload script/,
+  /Renderer process crashed/i,
+  /ERR_FILE_NOT_FOUND/,
+];
+
+const args = [mainEntry];
+if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
+
+const child = spawn(
+  join(repoRoot, "node_modules/.bin/electron"),
+  args,
+  {
+    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
+    stdio: ["ignore", "pipe", "pipe"],
+  },
+);
+
+let stderr = "";
+child.stderr.on("data", (chunk) => {
+  stderr += String(chunk);
+});
+child.stdout.on("data", () => {});
+
+const SMOKE_DURATION_MS = 8000;
+
+setTimeout(() => {
+  child.kill("SIGTERM");
+}, SMOKE_DURATION_MS);
+
+child.on("exit", () => {
+  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
+  if (fatal.length > 0) {
+    console.error("Desktop smoke FAILED. Fatal stderr patterns:");
+    for (const pattern of fatal) console.error(`  ${pattern}`);
+    console.error("--- stderr ---");
+    console.error(stderr.slice(0, 4000));
+    process.exit(1);
+  }
+  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
+  process.exit(0);
+});
diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
new file mode 100644
index 0000000..64a5a7a
--- /dev/null
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -0,0 +1,38 @@
+import { z } from "zod";
+
+// Typed contract for everything the preload bridge exposes. Main-process
+// handlers validate results against these before returning them. Payload
+// validation starts with the first payload-accepting channel (Phase 4).
+// The renderer never sees raw Electron APIs.
+
+export const VersionResult = z.string().min(1);
+export type VersionResult = z.infer<typeof VersionResult>;
+
+export const PickWorkspaceRootResult = z.string().min(1).nullable();
+export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
+
+// The real registry arrives in Phase 4; the contract starts narrow.
+export const WorkspaceRegistryResult = z.object({
+  workspaces: z.array(
+    z.object({
+      workspaceId: z.string().min(1),
+      rootPath: z.string().min(1),
+      kind: z.enum(["personal", "shared", "cloud-only"]),
+      mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
+    }),
+  ),
+});
+export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
+
+export const LaunchMarksResult = z.object({
+  appReadyMs: z.number().positive(),
+  firstWindowMs: z.number().positive(),
+  firstPaintMs: z.number().positive(),
+});
+export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;
+
+export interface DohcDesktopBridge {

exec
/bin/bash -lc "git show --no-ext-diff --unified=80 --no-renames --format= -- apps/desktop package.json pnpm-workspace.yaml 7781d02 | sed -n '260,560p'" in /home/ice/dev/dohc
 succeeded in 0ms:
+
+export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
new file mode 100644
index 0000000..ea0d74f
--- /dev/null
+++ b/apps/desktop/src/main.ts
@@ -0,0 +1,76 @@
+import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
+import {
+  LaunchMarksResult,
+  PickWorkspaceRootResult,
+  VersionResult,
+  WorkspaceRegistryResult,
+} from "./ipc/bridgeContract";
+import { CHANNELS } from "./ipc/channels";
+import { launchMarks } from "./performance/launchMarks";
+import { decideNavigation } from "./security/electronSecurity";
+import { navigationPolicy } from "./window/createMainWindow";
+
+// IPC is an untrusted boundary: handlers only answer frames the navigation
+// policy itself would allow (exact dev origin or the packaged bundle).
+function isTrustedFrame(frameUrl: string): boolean {
+  return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
+}
+
+function assertTrustedSender(event: IpcMainInvokeEvent): void {
+  const frameUrl = event.senderFrame?.url ?? "";
+  if (!isTrustedFrame(frameUrl)) {
+    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
+  }
+}
+
+function registerIpcHandlers(): void {
+  ipcMain.handle(CHANNELS.getVersion, (event) => {
+    assertTrustedSender(event);
+    return VersionResult.parse(app.getVersion());
+  });
+
+  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
+    assertTrustedSender(event);
+    const result = await dialog.showOpenDialog({
+      properties: ["openDirectory", "createDirectory"],
+    });
+    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
+    return PickWorkspaceRootResult.parse(picked);
+  });
+
+  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
+    assertTrustedSender(event);
+    // Real registry lands in Phase 4.
+    return WorkspaceRegistryResult.parse({ workspaces: [] });
+  });
+
+  ipcMain.on(CHANNELS.firstPaint, (event) => {
+    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
+      launchMarks.firstPaint();
+    }
+  });
+
+  if (process.env.DOHC_DESKTOP_TEST === "1") {
+    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
+      assertTrustedSender(event);
+      return LaunchMarksResult.parse(launchMarks.snapshot());
+    });
+  }
+}
+
+// Single-instance lock gates the entire bootstrap, not just a quit() call.
+if (!app.requestSingleInstanceLock()) {
+  app.quit();
+} else {
+  void app.whenReady().then(async () => {
+    launchMarks.appReady();
+    registerIpcHandlers();
+    const { createMainWindow } = await import("./window/createMainWindow");
+    createMainWindow();
+    launchMarks.firstWindow();
+  });
+
+  app.on("window-all-closed", () => {
+    if (process.platform !== "darwin") app.quit();
+  });
+}
diff --git a/apps/desktop/src/performance/launchMarks.ts b/apps/desktop/src/performance/launchMarks.ts
new file mode 100644
index 0000000..eab6159
--- /dev/null
+++ b/apps/desktop/src/performance/launchMarks.ts
@@ -0,0 +1,24 @@
+// Launch instrumentation, alive from the first scaffold per the plan's
+// continuous performance enforcement: later phases append marks, Phase 16
+// turns the numbers into a hard gate.
+
+const processStart = Date.now();
+
+interface LaunchMarks {
+  appReadyMs: number;
+  firstWindowMs: number;
+  firstPaintMs: number;
+}
+
+const marks: Partial<LaunchMarks> = {};
+
+function markOnce(key: keyof LaunchMarks): void {
+  if (marks[key] === undefined) marks[key] = Date.now() - processStart;
+}
+
+export const launchMarks = {
+  appReady: () => markOnce("appReadyMs"),
+  firstWindow: () => markOnce("firstWindowMs"),
+  firstPaint: () => markOnce("firstPaintMs"),
+  snapshot: (): Partial<LaunchMarks> => ({ ...marks }),
+};
diff --git a/apps/desktop/src/preload.ts b/apps/desktop/src/preload.ts
new file mode 100644
index 0000000..d0293f0
--- /dev/null
+++ b/apps/desktop/src/preload.ts
@@ -0,0 +1,21 @@
+import { contextBridge, ipcRenderer } from "electron";
+import { CHANNELS } from "./ipc/channels";
+
+// The entire bridge surface. Narrow on purpose: the renderer gets named,
+// typed operations — never raw ipcRenderer, never Node.
+contextBridge.exposeInMainWorld("dohcDesktop", {
+  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
+  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
+  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
+});
+
+// One-shot paint signal for launch instrumentation (no data, no response).
+contextBridge.exposeInMainWorld("dohcDesktopInternal", {
+  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
+});
+
+if (process.env.DOHC_DESKTOP_TEST === "1") {
+  contextBridge.exposeInMainWorld("dohcDesktopTest", {
+    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
+  });
+}
diff --git a/apps/desktop/src/renderer/index.html b/apps/desktop/src/renderer/index.html
new file mode 100644
index 0000000..00237e8
--- /dev/null
+++ b/apps/desktop/src/renderer/index.html
@@ -0,0 +1,37 @@
+<!doctype html>
+<html lang="en">
+  <head>
+    <meta charset="UTF-8" />
+    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
+    <title>dohc</title>
+    <style>
+      /* Warm paper + graphite, set inline so first paint is never unstyled. */
+      :root {
+        color-scheme: light dark;
+      }
+      html,
+      body {
+        margin: 0;
+        height: 100%;
+        background: #faf7f2;
+        color: #2b2926;
+        font-family:
+          system-ui,
+          -apple-system,
+          "Segoe UI",
+          sans-serif;
+      }
+      @media (prefers-color-scheme: dark) {
+        html,
+        body {
+          background: #1c1a18;
+          color: #e8e4de;
+        }
+      }
+    </style>
+  </head>
+  <body>
+    <div id="root"></div>
+    <script type="module" src="./main.ts"></script>
+  </body>
+</html>
diff --git a/apps/desktop/src/renderer/main.ts b/apps/desktop/src/renderer/main.ts
new file mode 100644
index 0000000..0e0da32
--- /dev/null
+++ b/apps/desktop/src/renderer/main.ts
@@ -0,0 +1,33 @@
+// Minimal first-run shell. Phase 3 replaces this with the real desktop
+// workspace shell (driven by the component reuse map + design review loop).
+
+declare global {
+  interface Window {
+    dohcDesktopInternal?: { firstPaint(): void };
+  }
+}
+
+const root = document.getElementById("root");
+if (root) {
+  const main = document.createElement("main");
+  main.style.cssText =
+    "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;";
+
+  const heading = document.createElement("h1");
+  heading.textContent = "dohc";
+  heading.style.cssText =
+    "font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;";
+
+  const subtitle = document.createElement("p");
+  subtitle.textContent = "Your workspace is a folder.";
+  subtitle.style.cssText = "font-size:14px;opacity:0.65;margin:0;";
+
+  main.append(heading, subtitle);
+  root.append(main);
+}
+
+requestAnimationFrame(() => {
+  window.dohcDesktopInternal?.firstPaint();
+});
+
+export {};
diff --git a/apps/desktop/src/security/electronSecurity.test.ts b/apps/desktop/src/security/electronSecurity.test.ts
new file mode 100644
index 0000000..08e95c0
--- /dev/null
+++ b/apps/desktop/src/security/electronSecurity.test.ts
@@ -0,0 +1,84 @@
+import { describe, expect, it } from "vitest";
+import {
+  createMainWindowWebPreferences,
+  decideNavigation,
+  decideWindowOpen,
+} from "./electronSecurity";
+
+describe("main window web preferences", () => {
+  it("locks down the renderer: no node, isolated context, sandboxed", () => {
+    const prefs = createMainWindowWebPreferences("/abs/path/preload.js");
+    expect(prefs.nodeIntegration).toBe(false);
+    expect(prefs.contextIsolation).toBe(true);
+    expect(prefs.sandbox).toBe(true);
+  });
+
+  it("requires an absolute preload path", () => {
+    expect(() => createMainWindowWebPreferences("relative/preload.js")).toThrow(
+      /absolute/i,
+    );
+  });
+});
+
+describe("navigation policy", () => {
+  const policy = {
+    httpOrigins: ["http://localhost:5173"],
+    fileUrlPrefix: "file:///app/dist/renderer/",
+  };
+
+  it("allows in-app navigation", () => {
+    expect(
+      decideNavigation("file:///app/dist/renderer/index.html", policy),
+    ).toEqual({ action: "allow" });
+    expect(
+      decideNavigation("http://localhost:5173/route", policy),
+    ).toEqual({ action: "allow" });
+  });
+
+  it("denies navigation to arbitrary external URLs", () => {
+    expect(decideNavigation("https://evil.example.com", policy).action).toBe(
+      "deny",
+    );
+  });
+
+  it("denies origin prefix-spoofing (localhost:5173.evil.com)", () => {
+    expect(
+      decideNavigation("http://localhost:5173.evil.com/x", policy).action,
+    ).toBe("deny");
+  });
+
+  it("denies local files outside the renderer bundle", () => {
+    expect(decideNavigation("file:///etc/passwd", policy).action).toBe("deny");
+  });
+
+  it("denies file navigation entirely when no bundle prefix is set (dev)", () => {
+    expect(
+      decideNavigation("file:///app/dist/renderer/index.html", {
+        httpOrigins: ["http://localhost:5173"],
+        fileUrlPrefix: null,
+      }).action,
+    ).toBe("deny");
+  });
+
+  it("denies unparseable URLs", () => {
+    expect(decideNavigation("not a url", policy).action).toBe("deny");
+  });
+});
+
+describe("window.open policy", () => {
+  it("denies all window.open targets", () => {
+    expect(decideWindowOpen("https://dohc.ai/docs").action).toBe("deny");
+    expect(decideWindowOpen("file:///etc/passwd").action).toBe("deny");
+  });

exec
/bin/bash -lc "git show --no-ext-diff --unified=80 --no-renames --format= -- apps/desktop package.json pnpm-workspace.yaml 7781d02 | sed -n '560,920p'" in /home/ice/dev/dohc
 succeeded in 0ms:
+  });
+
+  it("routes http and https targets through the external shell handler", () => {
+    expect(decideWindowOpen("https://dohc.ai/docs").openExternal).toBe(true);
+    expect(decideWindowOpen("http://dohc.ai/docs").openExternal).toBe(true);
+    expect(decideWindowOpen("http://dohc.ai/docs").action).toBe("deny");
+  });
+
+  it("never shells out non-http(s) schemes", () => {
+    expect(decideWindowOpen("file:///etc/passwd").openExternal).toBe(false);
+    expect(decideWindowOpen("smb://share/x").openExternal).toBe(false);
+  });
+});
diff --git a/apps/desktop/src/security/electronSecurity.ts b/apps/desktop/src/security/electronSecurity.ts
new file mode 100644
index 0000000..7fa71e4
--- /dev/null
+++ b/apps/desktop/src/security/electronSecurity.ts
@@ -0,0 +1,78 @@
+import { isAbsolute } from "node:path";
+
+export interface MainWindowWebPreferences {
+  preload: string;
+  nodeIntegration: false;
+  contextIsolation: true;
+  sandbox: true;
+}
+
+export function createMainWindowWebPreferences(
+  preloadPath: string,
+): MainWindowWebPreferences {
+  if (!isAbsolute(preloadPath)) {
+    throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
+  }
+  return {
+    preload: preloadPath,
+    nodeIntegration: false,
+    contextIsolation: true,
+    sandbox: true,
+  };
+}
+
+export interface NavigationDecision {
+  action: "allow" | "deny";
+}
+
+export interface NavigationPolicy {
+  // Exact URL origins (scheme://host:port), compared with ===, never prefix:
+  // startsWith would allow http://localhost:5173.evil.com.
+  httpOrigins: string[];
+  // The packaged renderer bundle directory as a file:// href prefix; a bare
+  // "file://" allowance would open every local file to navigation.
+  fileUrlPrefix: string | null;
+}
+
+// The renderer may only navigate within the app itself: the packaged
+// bundle directory or the dev server's exact origin. Everything else,
+// including unparseable URLs, is denied.
+export function decideNavigation(
+  targetUrl: string,
+  policy: NavigationPolicy,
+): NavigationDecision {
+  try {
+    const url = new URL(targetUrl);
+    if (url.protocol === "http:" || url.protocol === "https:") {
+      return {
+        action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny",
+      };
+    }
+    if (url.protocol === "file:" && policy.fileUrlPrefix) {
+      return {
+        action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny",
+      };
+    }
+  } catch {
+    // fall through to deny
+  }
+  return { action: "deny" };
+}
+
+export interface WindowOpenDecision {
+  action: "deny";
+  openExternal: boolean;
+}
+
+// window.open never creates a BrowserWindow. http(s) targets are handed to
+// the OS browser; every other scheme is dropped entirely.
+export function decideWindowOpen(targetUrl: string): WindowOpenDecision {
+  let openExternal = false;
+  try {
+    const protocol = new URL(targetUrl).protocol;
+    openExternal = protocol === "https:" || protocol === "http:";
+  } catch {
+    openExternal = false;
+  }
+  return { action: "deny", openExternal };
+}
diff --git a/apps/desktop/src/window/createMainWindow.ts b/apps/desktop/src/window/createMainWindow.ts
new file mode 100644
index 0000000..a4e79e0
--- /dev/null
+++ b/apps/desktop/src/window/createMainWindow.ts
@@ -0,0 +1,60 @@
+import { BrowserWindow, shell } from "electron";
+import { join } from "node:path";
+import { pathToFileURL } from "node:url";
+import {
+  createMainWindowWebPreferences,
+  decideNavigation,
+  decideWindowOpen,
+  type NavigationPolicy,
+} from "../security/electronSecurity";
+
+// Warm paper — set before first paint so launch never flashes white.
+const BACKGROUND_COLOR = "#faf7f2";
+
+export function navigationPolicy(): NavigationPolicy {
+  const devServer = process.env.ELECTRON_RENDERER_URL;
+  if (devServer) {
+    // Dev: exact dev-server origin only; no file navigation at all.
+    return { httpOrigins: [new URL(devServer).origin], fileUrlPrefix: null };
+  }
+  // Prod: only the packaged renderer bundle directory.
+  const rendererDir = join(import.meta.dirname, "../renderer/");
+  return { httpOrigins: [], fileUrlPrefix: pathToFileURL(rendererDir).href };
+}
+
+export function createMainWindow(): BrowserWindow {
+  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");
+
+  const window = new BrowserWindow({
+    show: false,
+    width: 1280,
+    height: 800,
+    minWidth: 840,
+    minHeight: 620,
+    backgroundColor: BACKGROUND_COLOR,
+    webPreferences: createMainWindowWebPreferences(preloadPath),
+  });
+
+  window.webContents.setWindowOpenHandler(({ url }) => {
+    const decision = decideWindowOpen(url);
+    if (decision.openExternal) void shell.openExternal(url);
+    return { action: "deny" };
+  });
+
+  window.webContents.on("will-navigate", (event, url) => {
+    if (decideNavigation(url, navigationPolicy()).action === "deny") {
+      event.preventDefault();
+    }
+  });
+
+  window.once("ready-to-show", () => window.show());
+
+  const devServer = process.env.ELECTRON_RENDERER_URL;
+  if (devServer) {
+    void window.loadURL(devServer);
+  } else {
+    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
+  }
+
+  return window;
+}
diff --git a/apps/desktop/tsconfig.json b/apps/desktop/tsconfig.json
new file mode 100644
index 0000000..ed43734
--- /dev/null
+++ b/apps/desktop/tsconfig.json
@@ -0,0 +1,4 @@
+{
+  "extends": "../../tsconfig.base.json",
+  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "electron.vite.config.ts", "playwright.config.ts"]
+}
diff --git a/apps/desktop/vitest.config.ts b/apps/desktop/vitest.config.ts
new file mode 100644
index 0000000..cfd92e3
--- /dev/null
+++ b/apps/desktop/vitest.config.ts
@@ -0,0 +1,8 @@
+import { defineConfig } from "vitest/config";
+
+// e2e/ runs under Playwright (playwright.config.ts), never vitest.
+export default defineConfig({
+  test: {
+    include: ["src/**/*.test.ts"],
+  },
+});
diff --git a/package.json b/package.json
index a851ecf..4e99072 100644
--- a/package.json
+++ b/package.json
@@ -1,36 +1,41 @@
 {
   "name": "dohc",
   "private": true,
   "type": "module",
   "engines": {
     "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
     "pnpm": "10.24.0"
   },
   "scripts": {
     "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
     "dev:app": "pnpm --filter @dohc/web --if-present run dev",
+    "dev:desktop": "pnpm --filter @dohc/desktop dev",
+    "build:desktop": "pnpm --filter @dohc/desktop build",
+    "test:desktop": "pnpm --filter @dohc/desktop test",
+    "test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
+    "smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs",
     "dev:sync": "node scripts/dev-sync.mjs",
     "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
     "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
     "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
     "build": "pnpm -r --if-present build",
     "start": "pnpm --filter @dohc/web --if-present run start",
     "preview": "pnpm --filter @dohc/web --if-present run preview",
     "reset:dev": "node scripts/reset-dev-data.mjs",
     "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
     "typecheck": "pnpm -r --if-present typecheck",
     "test": "pnpm -r --if-present test",
     "test:e2e": "playwright test",
     "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
     "sync:local": "pnpm --filter @dohc/workspace-fs sync",
     "lint": "pnpm -r --if-present lint",
     "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
     "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
     "check:self-host": "node scripts/check-self-host.mjs",
     "check:debt": "node scripts/check-tech-debt.mjs"
   },
   "packageManager": "pnpm@10.24.0",
   "devDependencies": {
     "@playwright/test": "^1.60.0"
   }
 }
diff --git a/pnpm-workspace.yaml b/pnpm-workspace.yaml
index 1d8028e..344f458 100644
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -1,4 +1,11 @@
 packages:
   - "apps/*"
   - "packages/*"
   - "services/*"
+
+# pnpm 10 ignores dependency build scripts by default; Electron's binary
+# download runs in its postinstall, so it must be allowlisted explicitly.
+onlyBuiltDependencies:
+  - electron
+  - electron-winstaller
+  - esbuild

exec
/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames --format= -- apps/desktop/src/ipc/bridgeContract.ts apps/desktop/src/ipc/channels.ts 7781d02' in /home/ice/dev/dohc
 succeeded in 0ms:
diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
new file mode 100644
index 0000000..64a5a7a
--- /dev/null
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -0,0 +1,38 @@
+import { z } from "zod";
+
+// Typed contract for everything the preload bridge exposes. Main-process
+// handlers validate results against these before returning them. Payload
+// validation starts with the first payload-accepting channel (Phase 4).
+// The renderer never sees raw Electron APIs.
+
+export const VersionResult = z.string().min(1);
+export type VersionResult = z.infer<typeof VersionResult>;
+
+export const PickWorkspaceRootResult = z.string().min(1).nullable();
+export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
+
+// The real registry arrives in Phase 4; the contract starts narrow.
+export const WorkspaceRegistryResult = z.object({
+  workspaces: z.array(
+    z.object({
+      workspaceId: z.string().min(1),
+      rootPath: z.string().min(1),
+      kind: z.enum(["personal", "shared", "cloud-only"]),
+      mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
+    }),
+  ),
+});
+export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
+
+export const LaunchMarksResult = z.object({
+  appReadyMs: z.number().positive(),
+  firstWindowMs: z.number().positive(),
+  firstPaintMs: z.number().positive(),
+});
+export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;
+
+export interface DohcDesktopBridge {
+  getVersion(): Promise<VersionResult>;
+  pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
+  getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
+}
diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
new file mode 100644
index 0000000..0981b5d
--- /dev/null
+++ b/apps/desktop/src/ipc/channels.ts
@@ -0,0 +1,9 @@
+export const CHANNELS = {
+  getVersion: "desktop:get-version",
+  pickWorkspaceRoot: "desktop:pick-workspace-root",
+  getWorkspaceRegistry: "desktop:get-workspace-registry",
+  firstPaint: "desktop:first-paint",
+  getLaunchMarks: "desktop:test:get-launch-marks",
+} as const;
+
+export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

exec
/bin/bash -lc 'ls -la && ls -la apps && ls -la apps/desktop && cat tsconfig.base.json && cat package.json && cat pnpm-workspace.yaml' in /home/ice/dev/dohc
 succeeded in 103ms:
{
  "name": "dohc",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
    "pnpm": "10.24.0"
  },
  "scripts": {
    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    "dev:desktop": "pnpm --filter @dohc/desktop dev",
    "build:desktop": "pnpm --filter @dohc/desktop build",
    "test:desktop": "pnpm --filter @dohc/desktop test",
    "test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
    "smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs",
    "dev:sync": "node scripts/dev-sync.mjs",
    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    "build": "pnpm -r --if-present build",
    "start": "pnpm --filter @dohc/web --if-present run start",
    "preview": "pnpm --filter @dohc/web --if-present run preview",
    "reset:dev": "node scripts/reset-dev-data.mjs",
    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:e2e": "playwright test",
    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    "lint": "pnpm -r --if-present lint",
    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    "check:self-host": "node scripts/check-self-host.mjs",
    "check:debt": "node scripts/check-tech-debt.mjs"
  },
  "packageManager": "pnpm@10.24.0",
  "devDependencies": {
    "@playwright/test": "^1.60.0"
  }
}
packages:
  - "apps/*"
  - "packages/*"
  - "services/*"

# pnpm 10 ignores dependency build scripts by default; Electron's binary
# download runs in its postinstall, so it must be allowlisted explicitly.
onlyBuiltDependencies:
  - electron
  - electron-winstaller
  - esbuild

exec
/bin/bash -lc 'pnpm --filter @dohc/desktop exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
 succeeded in 1893ms:
exec
/bin/bash -lc "find apps/desktop/dist -maxdepth 3 -type f -printf '%p\\n' | sort | sed -n '1,100p' && sed -n '1,120p' apps/desktop/dist/main/main.js && sed -n '1,80p' apps/desktop/dist/preload/preload.cjs" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/dist/main/main.js
apps/desktop/dist/preload/preload.cjs
apps/desktop/dist/renderer/assets/index-CUmNbg7n.js
apps/desktop/dist/renderer/index.html
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/ipc/bridgeContract.ts
var VersionResult = z.string().min(1);
var PickWorkspaceRootResult = z.string().min(1).nullable();
var WorkspaceRegistryResult = z.object({ workspaces: z.array(z.object({
	workspaceId: z.string().min(1),
	rootPath: z.string().min(1),
	kind: z.enum([
		"personal",
		"shared",
		"cloud-only"
	]),
	mode: z.enum([
		"local-first",
		"cloud-first-local-copy",
		"cloud-only"
	])
})) });
var LaunchMarksResult = z.object({
	appReadyMs: z.number().positive(),
	firstWindowMs: z.number().positive(),
	firstPaintMs: z.number().positive()
});
//#endregion
//#region src/ipc/channels.ts
var CHANNELS = {
	getVersion: "desktop:get-version",
	pickWorkspaceRoot: "desktop:pick-workspace-root",
	getWorkspaceRegistry: "desktop:get-workspace-registry",
	firstPaint: "desktop:first-paint",
	getLaunchMarks: "desktop:test:get-launch-marks"
};
//#endregion
//#region src/performance/launchMarks.ts
var processStart = Date.now();
var marks = {};
function markOnce(key) {
	if (marks[key] === void 0) marks[key] = Date.now() - processStart;
}
var launchMarks = {
	appReady: () => markOnce("appReadyMs"),
	firstWindow: () => markOnce("firstWindowMs"),
	firstPaint: () => markOnce("firstPaintMs"),
	snapshot: () => ({ ...marks })
};
//#endregion
//#region src/security/electronSecurity.ts
function createMainWindowWebPreferences(preloadPath) {
	if (!isAbsolute(preloadPath)) throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
	return {
		preload: preloadPath,
		nodeIntegration: false,
		contextIsolation: true,
		sandbox: true
	};
}
function decideNavigation(targetUrl, policy) {
	try {
		const url = new URL(targetUrl);
		if (url.protocol === "http:" || url.protocol === "https:") return { action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny" };
		if (url.protocol === "file:" && policy.fileUrlPrefix) return { action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny" };
	} catch {}
	return { action: "deny" };
}
function decideWindowOpen(targetUrl) {
	let openExternal = false;
	try {
		const protocol = new URL(targetUrl).protocol;
		openExternal = protocol === "https:" || protocol === "http:";
	} catch {
		openExternal = false;
	}
	return {
		action: "deny",
		openExternal
	};
}
//#endregion
//#region src/window/createMainWindow.ts
var createMainWindow_exports = /* @__PURE__ */ __exportAll({
	createMainWindow: () => createMainWindow,
	navigationPolicy: () => navigationPolicy
});
var BACKGROUND_COLOR = "#faf7f2";
function navigationPolicy() {
	const devServer = process.env.ELECTRON_RENDERER_URL;
	if (devServer) return {
		httpOrigins: [new URL(devServer).origin],
		fileUrlPrefix: null
	};
	return {
		httpOrigins: [],
		fileUrlPrefix: pathToFileURL(join(import.meta.dirname, "../renderer/")).href
	};
}
function createMainWindow() {
	const window = new BrowserWindow({
		show: false,
		width: 1280,
		height: 800,
		minWidth: 840,
		minHeight: 620,
		backgroundColor: BACKGROUND_COLOR,
		webPreferences: createMainWindowWebPreferences(join(import.meta.dirname, "../preload/preload.cjs"))
	});
let electron = require("electron");
//#region src/ipc/channels.ts
var CHANNELS = {
	getVersion: "desktop:get-version",
	pickWorkspaceRoot: "desktop:pick-workspace-root",
	getWorkspaceRegistry: "desktop:get-workspace-registry",
	firstPaint: "desktop:first-paint",
	getLaunchMarks: "desktop:test:get-launch-marks"
};
//#endregion
//#region src/preload.ts
electron.contextBridge.exposeInMainWorld("dohcDesktop", {
	getVersion: () => electron.ipcRenderer.invoke(CHANNELS.getVersion),
	pickWorkspaceRoot: () => electron.ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
	getWorkspaceRegistry: () => electron.ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry)
});
electron.contextBridge.exposeInMainWorld("dohcDesktopInternal", { firstPaint: () => electron.ipcRenderer.send(CHANNELS.firstPaint) });
if (process.env.DOHC_DESKTOP_TEST === "1") electron.contextBridge.exposeInMainWorld("dohcDesktopTest", { getLaunchMarks: () => electron.ipcRenderer.invoke(CHANNELS.getLaunchMarks) });
//#endregion

exec
/bin/bash -lc "sed -n '120,260p' apps/desktop/dist/main/main.js && cat apps/desktop/dist/renderer/index.html" in /home/ice/dev/dohc
 succeeded in 0ms:
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (decideWindowOpen(url).openExternal) shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (decideNavigation(url, navigationPolicy()).action === "deny") event.preventDefault();
	});
	window.once("ready-to-show", () => window.show());
	const devServer = process.env.ELECTRON_RENDERER_URL;
	if (devServer) window.loadURL(devServer);
	else window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	return window;
}
//#endregion
//#region src/main.ts
function isTrustedFrame(frameUrl) {
	return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
}
function assertTrustedSender(event) {
	const frameUrl = event.senderFrame?.url ?? "";
	if (!isTrustedFrame(frameUrl)) throw new Error(`Untrusted IPC sender: ${frameUrl}`);
}
function registerIpcHandlers() {
	ipcMain.handle(CHANNELS.getVersion, (event) => {
		assertTrustedSender(event);
		return VersionResult.parse(app.getVersion());
	});
	ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
		assertTrustedSender(event);
		const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
		const picked = result.canceled ? null : result.filePaths[0] ?? null;
		return PickWorkspaceRootResult.parse(picked);
	});
	ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
		assertTrustedSender(event);
		return WorkspaceRegistryResult.parse({ workspaces: [] });
	});
	ipcMain.on(CHANNELS.firstPaint, (event) => {
		if (isTrustedFrame(event.senderFrame?.url ?? "")) launchMarks.firstPaint();
	});
	if (process.env.DOHC_DESKTOP_TEST === "1") ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
		assertTrustedSender(event);
		return LaunchMarksResult.parse(launchMarks.snapshot());
	});
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.whenReady().then(async () => {
		launchMarks.appReady();
		registerIpcHandlers();
		const { createMainWindow } = await Promise.resolve().then(() => createMainWindow_exports);
		createMainWindow();
		launchMarks.firstWindow();
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
}
//#endregion
export {};
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
    <title>dohc</title>
    <style>
      /* Warm paper + graphite, set inline so first paint is never unstyled. */
      :root {
        color-scheme: light dark;
      }
      html,
      body {
        margin: 0;
        height: 100%;
        background: #faf7f2;
        color: #2b2926;
        font-family:
          system-ui,
          -apple-system,
          "Segoe UI",
          sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        html,
        body {
          background: #1c1a18;
          color: #e8e4de;
        }
      }
    </style>
    <script type="module" crossorigin src="./assets/index-CUmNbg7n.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>

exec
/bin/bash -lc "node -e \"for (const u of ['file:///app/dist/renderer/%2e%2e/%2e%2e/etc/passwd','file:///app/dist/renderer/../../etc/passwd','file:///app/dist/renderer/%2E%2E/etc/passwd','file:///app/dist/renderer/%2e./x']) { const url=new URL(u); console.log(u,'=>',url.href, url.pathname) }\"" in /home/ice/dev/dohc
 succeeded in 0ms:
file:///app/dist/renderer/%2e%2e/%2e%2e/etc/passwd => file:///app/etc/passwd /app/etc/passwd
file:///app/dist/renderer/../../etc/passwd => file:///app/etc/passwd /app/etc/passwd
file:///app/dist/renderer/%2E%2E/etc/passwd => file:///app/dist/etc/passwd /app/dist/etc/passwd
file:///app/dist/renderer/%2e./x => file:///app/dist/x /app/dist/x

exec
/bin/bash -lc "git show --no-ext-diff --unified=80 --no-renames --format= -- docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md 7781d02 | sed -n '1,240p'" in /home/ice/dev/dohc
 succeeded in 0ms:
diff --git a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
index 64d0403..675d6d0 100644
--- a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+++ b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
@@ -1,136 +1,161 @@
 # Desktop Local-First Cloud Sync Execution Log
 
 ## Resume Snapshot (overwrite in place — the ONLY mutable section)
 
-- Phase/Step + TDD position: Phase 1 COMPLETE (committed 67d692f, codex review in flight); Phase 2 read-only prep underway
-- Expected test state: workspace-core 31/31 green; baseline green (11 PASS + 1 KNOWN-FAIL web)
-- Dirty files and intent: this log only (snapshot updates)
-- Exact next action: when codex phase-01 review lands → triage → then Phase 2 Step 1 (pnpm-workspace.yaml onlyBuiltDependencies, install Electron tooling, verify electron --version) — mutation waits for review triage
-- Active background tasks: codex review phase-01 (bbslcyw98 → docs/superpowers/reviews/codex/phase-01.md); t3code renderer recon agent (digest → Reference Digests on completion)
+- Phase/Step + TDD position: Phase 2 Step 1 — Electron install running (background); tests already written (electronSecurity.test.ts, desktopLaunch.spec.ts, playwright.config.ts, scaffold package.json/tsconfig)
+- Expected test state: post-install: `pnpm --filter @dohc/desktop test` expected RED (missing ./electronSecurity module); E2E RED (no build output)
+- Dirty files and intent: pnpm-workspace.yaml (onlyBuiltDependencies — Phase 2 commit), apps/desktop/* (Phase 2), pnpm-lock.yaml (install), this log
+- Exact next action: install completes → verify electron --version → record unit RED → implement main/preload/security/launchMarks/electron.vite.config/renderer → build → GREEN → E2E + screenshot + marks
+- Active background tasks: b0pv29olr (pnpm add electron tooling + binary verify)
 - Open worktrees: none
-- Pending reviews: codex phase-01 (in flight)
+- Pending reviews: none (phase-01 triaged: 3 findings fixed @ f405074)
 
 ## Environment (append-only)
 
 - Toolchain freeze: tests run under Node v22.13.0 via PATH prefix `/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`. Shell default is Node v25.2.1 — Node 25 breaks 17 @dohc/web tests (verified 2026-06-10: AtomEditor.lifecycle suite 13/13 fail on 25, 13/13 pass on 22.13). Never run `nvm use`.
 - pnpm 10.24.0 (packageManager pin).
 - Codex: `/home/ice/.local/share/nvm/v25.2.1/bin/codex` (codex-cli 0.130.0, ChatGPT auth). Verified: `exec` read-only sandbox + `-m gpt-5.5 -c model_reasoning_effort="xhigh"` works (2026-06-10, 15.2K tokens). `gpt-5.5-fast` NOT available on this auth. Second install exists at `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex` (0.137.0-alpha.4, found by team audit) — using the verified 0.130.0; revisit only if review subcommand misbehaves.
 - Display: WSL2 + WSLg (DISPLAY=:0, WAYLAND=wayland-0); xvfb-run available as fallback.
 - Docker 29.5.2. Services healthy: dohc-v2-postgres, dohc-v2-minio, dohc-v2-hocuspocus (compose: docker-compose.dev.yml).
 - WSL safety: never pattern-kill node/pnpm/vite/etc.; servers always background tasks; kill only tracked task ids.
 
 ### Codex Calls ledger (date | purpose | effort | duration | outcome)
 
 - 2026-06-10 | preflight exec read-only smoke ("OK") | xhigh | ~1min | success
 - 2026-06-10 | preflight gpt-5.5-fast probe | xhigh | ~10s | model rejected on ChatGPT auth (expected)
 - 2026-06-10 | preflight -i image (arg-prompt form) | low | ~5s | FAILED: positional prompt not parsed with -i in detached-stdin context
 - 2026-06-10 | preflight -i image (stdin `-` form) | low | ~1min | success — correctly described dohc avatar; -i capability VERIFIED
 - 2026-06-10 | phase 0 review --commit+prompt (x2: 0.130 and 0.137 binaries) | high | ~5s each | FAILED: --commit rejects custom prompt; pattern corrected in plan
 - 2026-06-10 | phase 0 review --commit 7df1553 promptless | high | ~7min | success — 3 P2 findings on baseline script, all confirmed real, all fixed
 
 ## Decision Ledger (append-only)
 
 - D-01 | Better Auth inside workspace-api (Drizzle/pg, organization + deviceAuthorization plugins); WorkOS deferred as enterprise SSO path behind Better Auth | self-host needs vendor-free auth; WorkOS bridge stays open | pre-phase
 - D-02 | Live co-editing (Yjs/Hocuspocus) in scope; hocuspocus convex-acl → postgres-acl | user decision | pre-phase
 - D-03 | Single mega-branch `claude/desktop-local-first-cloud-sync`, green-milestone commits `phaseN(step M):`, no squash | user decision + resumability | pre-phase
 - D-04 | Native orchestration replaces superpowers skill (lanes, judge panels, verifier fan-outs, checkpoint recipe) | skill unavailable; codified in plan | pre-phase
 - D-05 | Codex = independent third-party reviewer with effort tiering, budget ledger, fallback chain; NEVER authors code/tests/designs | independence is the value; panel + team audit | pre-phase
 - D-06 | Node 22.13.0 frozen for tests; codex by absolute path | Node 25 breaks 17 web tests; PATH drift | pre-phase
 - D-07 | CRDT canonical while shared file open, filesystem canonical while closed; 6 named data-loss cases must be tested | team audit + plan amendment | pre-phase
 - D-08 | dual-backend code lives in main at bc62bd2; stale local branch of same name must never be used | recon | pre-phase
 
 ## Reference Digests (append-only)
 
 ### Dual-backend branch digest (source: 2026-06-09 execution log + readiness review + tech-debt audit; digested 2026-06-10)
 
 - All 9 packages/services mature and tested: workspace-contracts (conformance harness, 8 tests), workspace-postgres (Drizzle schema/migrations/repos/services, 12 tests, dev-ready, zero Convex coupling), workspace-fs (materialize/scan/diff/apply/syncClient/watch — watch is POLLING, 6 tests), workspace-api (HTTP handler + ResolveActor at src/auth/session.ts, 1 test, no production listener), agent-sandbox (allowlist shell, diff capture, 2+4 tests), sqlite-worker (11 tests; needs node:sqlite ⇒ Node 22.13+), app-tester (25 tests, backend matrix), hocuspocus (78 tests, Convex-coupled ACL), workspace-convex-compat (conformance-only consumer: workspace-contracts tests).
 - Final sweep: 1619 web tests passed under Node 22.13. Postgres pkg tests need `--no-file-parallelism` (shared DB fixture).
 - Production gates NOT done (this plan's work): hosted auth, live Yjs over Postgres, migration, deployment, observability.
 - Known debt w/ deletion conditions: .views compat (until indexed discovery + regression tests), confirmTier/views/entities mode comments, dual-backend switch (until Postgres default), convex-compat (until Convex off production).
 - Gotchas: pnpm install required after adding new packages (symlinks); MinIO image pinned; sync apply sequential (no idempotency keys yet); approval surfacing partial (errors not cards); upsertAtomImpl adds frontmatter — corrupts non-markdown bodies (use deriveSearchFields for text files); sandbox guards are arg-level, not namespace isolation.
 
 ### Convex usage map digest (source: apps/app/convex + repo grep; digested 2026-06-10)
 
 - Auth: WorkOS AuthKit via `@convex-dev/workos-authkit`; client bridge apps/app/src/lib/use-auth-bridge.ts + ConvexProviderWithAuth in routes/__root.tsx; server auth.config.ts (WorkOS RS256 issuer, env WORKOS_CLIENT_ID); actor = ctx.auth.getUserIdentity() {subject, email, name, tokenIdentifier}; requireWorkspace(ctx, activeWorkspaceId) checks memberships.
 - Convex function surface: ~40 modules — auth, schema (atoms/atomShares/atomLocks/memberships/orgs/workspaceAssets/databaseFiles/...), agent.ts (@convex-dev/agent tools), hocuspocusAuth.ts (ACL queries: checkAtomAccess/loadAtomBootstrap/setBodyCache/createAtom), atoms/atomAccess/atomShares, assets (storage upload URLs), databaseFiles/databaseOps, apps/appAgent/appTesting/appTrust, views/windows, trash, captures, crons (purges), search.
 - Non-convex importers: apps/app/src/lib/convex-client.ts, use-auth-bridge.ts, routes/__root.tsx, components/Chat.tsx (+chat-optimistic), routes/r/$atomId.tsx (share SSR); services/hocuspocus/src/convex-acl.ts + server.ts (env HOCUSPOCUS_CONVEX_URL + HOCUSPOCUS_CONVEX_SERVER_TOKEN); packages/workspace-convex-compat/testAdapter.ts.
 - convex-acl.ts exports createConvexAcl(): getWorkspaceAuthzVersion/canReadAtom/canWriteAtom/loadAtomBootstrap/setAtomBodyCache/createAtom — Postgres port must replicate these against workspace-postgres grants + Better Auth sessions.
 - Env to delete in P13: CONVEX_DEPLOYMENT, VITE_CONVEX_URL, VITE_CONVEX_SITE_URL, WORKOS_*, HOCUSPOCUS_CONVEX_*; scripts: dev-sync.mjs convex parts, reset:dev.
 - Convex guidelines key porting rules: server-derived identity only (never trust client identity args); index-based queries (no .filter); storage = Blob + signed URLs; crons via crons.interval/cron; validators on every function.
 
 ### t3code desktop renderer digest (source: /home/ice/dev/oss-repos/t3code/apps/desktop; digested 2026-06-10)
 
 - Security posture matches ours exactly: contextIsolation+sandbox+no nodeIntegration (src/window/DesktopWindow.ts:190); `setWindowOpenHandler` denies ALL window.open, externals via shell.openExternal (DesktopWindow.ts:246-251); `will-navigate` blocks off-origin (252-266); single-instance lock early (src/electron/ElectronApp.ts:103). ADOPT all.
 - Bridge: contextBridge.exposeInMainWorld("desktopBridge", ...), `desktop:`-prefixed channels (src/ipc/channels.ts), schema-validated codecs per method (src/ipc/DesktopIpc.ts:132-221 — they use Effect Schema; dohc uses zod per plan). Event listeners return unsubscribe fns. ADOPT shape, zod instead.
 - Titlebar: platform-aware custom chrome — macOS hiddenInset + trafficLightPosition {16,18}; Win/Linux hidden + titleBarOverlay {height:40, theme-synced symbolColor} (DesktopWindow.ts:106-139). Window starts `show:false`, reveals on first load. min 840x620. ADOPT for Phase 3.
 - Updates: electron-updater state machine idle→checking→available→downloading→downloaded→installing with reducer fns (src/updates/DesktopUpdates.ts) — ADOPT reducer-style state machine for Phase 14 tests.
 - Smoke: scripts/smoke-test.mjs spawns Electron 8s, greps stderr for fatal patterns. ADOPT for Phase 2 smoke.
 - REJECT: Effect-based layer architecture (overkill; plain TS + promises), sync IPC for hot data (async everything except immutable bootstrap), custom launcher plist patching (electron-builder instead), their no-Playwright gap (we add real Playwright Electron E2E).
 
 ### Port-source file paths (verified present 2026-06-10)
 
 - File-type views: apps/app/src/components/FileTypeView.tsx; Database Studio: DatabaseStudio.tsx, DatabaseTableGrid.tsx; tree: FileTree.tsx; upload: UploadFileButton.tsx; agent activity: AgentActivityTimeline.tsx, AgentRunRail.tsx (+ AgentChatSidebar.tsx).
 
 ## Gotchas (append-only)
 
 - Node 25 breaks 17 @dohc/web tests; pin 22.13.0 via PATH (see Environment).
 - workspace-postgres tests: shared local DB fixture, not file-parallel.
 - pnpm 10 ignores postinstall — Electron needs onlyBuiltDependencies in pnpm-workspace.yaml BEFORE install (Phase 2).
 - Root playwright.config.ts is web-only (testDir apps/app/e2e + webServer); desktop gets own config.
 - check:debt bans the literal deferred-work marker tokens it scans for, in any file including docs — never write them, even when describing the rule itself (this line was rewritten once for exactly that reason).
 - Package named @dohc/web already, but lives at apps/app (Phase 12 renames path).
 - ECONNREFUSED from :5432/:9000/:1234 = environment failure, never a test failure.
 - codex exec with `-i`: pass the prompt via stdin pipe + `-` arg (`echo "prompt" | codex exec -i img.png -`); positional prompt is silently dropped when stdin is detached.
 - Pre-existing failures on main @ e2de7a3 (fail under BOTH Node 22.13 and 25; broke between dual-backend sweep and merge): apps/app/convex/agentSandboxIntegration.test.ts ("teaches the model when to use shell" — AGENT_SRC prompt strings), src/__tests__/agentApprovalResume.test.tsx ("returns explicit scoped approval decisions"), src/__tests__/searchWriteAudit.test.ts ("no atom-inserting convex file outside the known set"), src/__tests__/uploadFiles.test.tsx ("exposes an upload button in the file sidebar area"). 4 tests / 1618 passed. NOT fixed in Phase 0 — these are main's bugs; several die with Convex in Phase 13 anyway.
 
 ## Phase Logs
 
 ### Phase 0: Baseline, Tooling, And Old-Plan Inventory
 
 - Status: in progress
 - Execution map: env preflight (done: services healthy, node/codex/display recorded) → execution log (this file) → baseline script Node-pinned → baseline background run → inventory doc from recon digests → commit → codex review (high tier, background)
 - Resume notes: baseline launching; inventory doc next; commit after baseline result recorded.
 - Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
 - Code deleted or consolidated: none (docs/tooling phase)
 - Net LOC delta (`git diff --shortstat`): recorded at commit
 - Old paths retained and why: all — inventory classifies, later phases delete
 - Dependencies added (name, size, justification): none
 - Decisions made (D-NN ids): D-01..D-08 (pre-execution, recorded above)
 - Tests added: none (baseline phase)
 - Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
 - Failing tests fixed: n/a — 4 web failures are pre-existing on main @ e2de7a3, recorded not fixed (several die with Convex in Phase 13)
 - Electron E2E/manual smoke: n/a (no desktop app yet)
 - UI/UX screenshot/design review: n/a
 - Performance measurements: n/a
 - Security/collaboration regressions: n/a
 - Reviewer/subagent findings: recon digests above; 4-lens plan panel + Codex-utilization panel + 2 team audits all folded into plan pre-execution
 - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-00.md): (1) baseline script fail-fasts on known web failures, can't reproduce recorded baseline at later gates — FIXED @ phase0(fix) commit (continue-on-error + summary + known-failure allowance that dies in Phase 13); (2) baseline omits @dohc/hocuspocus and @dohc/workspace-convex-compat suites — FIXED (both added); (3) pinned-Node path silently falls back to caller PATH on other machines — FIXED (existsSync check, DOHC_TEST_NODE_BIN override, hard error). Invocation gotcha discovered: `--commit` cannot combine with custom prompt (both codex versions) — plan updated with working pattern.
 - Relevant findings fixed: all 3 codex P2s fixed in follow-up commit; plan-level findings fixed pre-execution
 - Deferred findings with reason: none
 - Remaining risk: baseline may surface pre-existing failures beyond the known Node issue — will be recorded verbatim, not fixed here
 - Next phase: 1
 
 ### Phase 1: Local-First Workspace Core Contract
 
 - Status: in progress (GREEN reached; verifiers running; commit pending)
 - Execution map: tests-first for workspaceMode/paths/changeSet (written during Phase 0 review window) → pnpm install → RED recorded (3 files fail on missing modules) → implement 6 src modules → GREEN 28/28 + typecheck → verifier fan-out (test-quality worktree + claimed-vs-actual) → log → commit → codex review (high tier)
 - Resume notes: if interrupted post-GREEN: verifiers wf_2b9debfd-c61; commit phase1 after pass.
 - Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
 - Code deleted or consolidated: none new; overlap with workspace-contracts recorded below
 - Net LOC delta (`git diff --shortstat`): ~395 lines src+tests in new package; lockfile +12
 - Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
 - Dependencies added (name, size, justification): none runtime; devDeps typescript/vitest/@types/node only (workspace conventions)
 - Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
 - Tests added: 31 (modes 4, paths 19, changeSet/conflicts 8) — covers all plan-required assertions incl. per-workspace-not-per-file mode, encoded/double-encoded/backslash traversal, reserved .dohc, .apps/.sqlite classification, 5 boundary crossings, marker-free conflict summaries
 - Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
 - Failing tests fixed: RED→GREEN by implementation only; no test weakened
 - Electron E2E/manual smoke: n/a (pure contract package)
 - UI/UX screenshot/design review: n/a
 - Performance measurements: n/a (no measurable surface; tests run in 305ms)
 - Security/collaboration regressions: path traversal coverage incl. %2e and backslash variants; boundary-crossing review gate asserted per crossing
 - Reviewer/subagent findings: verifier workflow wf_2b9debfd-c61 — test-quality PASS (worktree revert: 0 tests pass without implementation; reason-specific assertions confirmed); claimed-vs-actual PASS (all plan files present, all claims re-verified independently, cheat scan clean). Finding 1: double-encoded traversal (%252e) passed single-pass decoding — FIXED pre-commit (decode-until-stable + 3 new traversal cases, 31/31). Finding 2 (note): repo .nvmrc pins 24.14.0 (not installed); our freeze is the documented 22.13.0 PATH prefix — consistent with engines, recorded.
 - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-01.md): (1) P1 case-insensitive .DOHC bypasses reserved guard on mac/Windows filesystems — FIXED (case-insensitive isReservedPath + tests); (2) P1 Windows drive-qualified paths (C:\...) pass absolute check, escape workspace after backslash normalization — FIXED (isAbsolutePathLike: POSIX + drive + UNC, checked raw and post-decode + tests); (3) P2 Windows absolute attached folders wrongly rejected — FIXED (same helper + tests). 35/35 green after fixes.
 - Relevant findings fixed: verifier finding 1 + all 3 codex findings fixed in phase1(fix) commit
 - Deferred findings with reason: none
 - Remaining risk: API shapes may evolve when Phase 4 (registry) and Phase 5 (history) consume them — acceptable, contract-first by design
 - Next phase: 2
+
+### Phase 2: Electron Desktop Scaffold And Test Harness
+
+- Status: in progress (all gates green; verifiers running; commit pending)
+- Execution map: tests-first (security unit + launch E2E + dedicated playwright config, written during phase-01 review window) → pnpm-workspace onlyBuiltDependencies → install (electron 42.4.0 binary verified) → unit RED recorded (missing module) → implement (main/preload/window/security/channels/bridgeContract/launchMarks/renderer/electron.vite.config/vitest.config/smoke) → unit GREEN 7/7 + typecheck + build → E2E pass (first try, WSLg, no xvfb needed) → smoke pass → screenshot inspected → verifiers → commit → codex review (xhigh tier)
+- Resume notes: verifiers wf_7528cd05-564 in flight; commit phase2 on pass.
+- Files changed: apps/desktop/* (16 files), pnpm-workspace.yaml (onlyBuiltDependencies), root package.json (5 desktop scripts), pnpm-lock.yaml
+- Code deleted or consolidated: none (greenfield scaffold)
+- Net LOC delta (`git diff --shortstat`): recorded at commit (~600 lines apps/desktop incl. tests)
+- Old paths retained and why: root playwright.config.ts untouched (web E2E keeps working — per plan/team audit)
+- Dependencies added (name, size, justification): electron 42.4.0 (runtime), electron-vite 5 + vite 8 (build, repo is vite-native), electron-builder + @electron/fuses (Phase 14 packaging, installed now per plan), electron-updater (Phase 14), zod (IPC validation), vitest/typescript/@types/node pinned to repo standards (TS6→5.9, types25→22 corrected post-install)
+- Decisions made (D-NN ids): D-10 | Phase 2 renderer is dependency-free TS+HTML placeholder; React arrives in Phase 3 via component reuse map | smallest first paint, Phase 3 owns the real shell | phase 2. D-11 | preload built CJS (sandboxed preload requirement); main ESM (import.meta.dirname) | electron-vite 5 + sandbox constraint | phase 2
+- Tests added: 7 security unit tests (webPreferences trio, absolute preload, navigation policy, window.open deny + external routing + scheme restrictions); 1 Playwright Electron E2E (heading visible, screenshot at convention path, launch marks positive, perf JSON written); smoke script (8s fatal-stderr scan)
+- Commands run: install+electron --version (42.4.0); test RED→GREEN 7/7; typecheck PASS; build PASS (main ESM/preload CJS/renderer); test:desktop:e2e PASS 534ms; smoke:desktop PASS — all pinned Node 22.13
+- Failing tests fixed: RED→GREEN by implementation; vitest/e2e separation fixed via vitest.config include
+- Electron E2E/manual smoke: E2E pass (no sandbox workarounds needed on WSLg — DOHC_E2E_NO_CHROMIUM_SANDBOX path exists but unused); smoke pass
+- UI/UX screenshot/design review: screenshot inspected by lead — warm paper bg, centered graphite wordmark, muted subtitle, nonblank, no white flash (backgroundColor set pre-paint). Full Design Review Loop applies from Phase 3.
+- Performance measurements: cold launch appReady 194ms / firstWindow 232ms / firstPaint 315ms (budget: shell <2000ms — 6x headroom); recorded to test-results/performance/desktop-performance.json
+- Security/collaboration regressions: IPC sender-origin validation on all invoke handlers; zod-parsed results; test bridge gated on DOHC_DESKTOP_TEST; CSP in renderer; window.open denied universally
+- Reviewer/subagent findings: verifiers wf_7528cd05-564 BOTH PASS. test-quality: deletion mutation fails suite; sandbox:false mutation caught at exact assertion; E2E flake-free (no sleeps). claimed-vs-actual: probed RUNTIME bridge surface without test env (Node unreachable, exact bridge shape, test bridge double-gated); re-ran full gate chain green. Findings fixed pre-commit: (1) origin prefix-match bypass (file:// allowed any local file; dev origin matched localhost:5173.evil.com) — FIXED with NavigationPolicy (exact http origins + bundle-scoped file prefix, deny-by-default incl. unparseable), assertTrustedSender now uses the same policy; (2) http:// scheme untested in window.open — test added; (3) single-instance lock didn't gate bootstrap — restructured; (4) bridgeContract comment overstated payload validation — corrected. 11/11 after fixes; full gate chain re-run green.
+- Codex third-party review findings: pending post-commit (xhigh tier — security phase)
+- Relevant findings fixed: 4 verifier findings fixed pre-commit
+- Deferred findings with reason: desktopSmoke.test.ts from plan file list realized as scripts/smoke-test.mjs (executable smoke, not a vitest stub) — justification: a unit test asserting the smoke script exists adds no information; the script itself runs in every phase gate
+- Remaining risk: fuses configuration deferred to Phase 14 packaging (per plan); titlebar is default chrome until Phase 3
+- Next phase: 3

 succeeded in 84819ms:
../vibeam-pr-0.4/AGENTS.md
../vibeam-pr-0.4/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.4/agents/ceo/AGENTS.md
../vibeam-pr-0.4/agents/cmo/AGENTS.md
../vibeam-pr-0.4/agents/cos/AGENTS.md
../extra/vibeam-mono/vibeam-app/AGENTS.md
../extra/vibeam-mono/AGENTS.md
../extra/vibeam-mono/vibe-gui/AGENTS.md
../extra/vibeam-mono/agents/founding-engineer/AGENTS.md
../extra/vibeam-mono/agents/ceo/AGENTS.md
../extra/vibeam-mono/agents/cmo/AGENTS.md
../extra/vibeam-mono/agents/cos/AGENTS.md
../dohc/AGENTS.md
../dohc/apps/app/AGENTS.md
../vibeam-pr-0.3/AGENTS.md
../vibeam-pr-0.3/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.3/agents/ceo/AGENTS.md
../vibeam-pr-0.3/agents/cmo/AGENTS.md
../vibeam-pr-0.3/agents/cos/AGENTS.md
../projects/opflow/node_modules/ts-loader/AGENTS.md
../projects/opflow/node_modules/recharts/AGENTS.md
../projects/opflow/packages/frontend/node_modules/ts-loader/AGENTS.md
../projects/opflow/packages/frontend/node_modules/recharts/AGENTS.md
../projects/bundae/apps/web/AGENTS.md
../projects/remote-ai-tool/vibeam/AGENTS.md
../projects/remote-ai-tool/agentic-clis/AGENTS.md
../vibeam-pr-0.2/AGENTS.md
../vibeam-pr-0.2/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.2/agents/ceo/AGENTS.md
../vibeam-pr-0.2/agents/cmo/AGENTS.md
../vibeam-pr-0.2/agents/cos/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/packages/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/tests/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/examples/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/node_modules/recharts/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/packages/db/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/frontend/AGENTS.md
../work/vacuumlabs/opnet/motoswap-ui/node_modules/recharts/AGENTS.md
../work/vacuumlabs/opnet/momoto-bug-repro/node_modules/ts-loader/AGENTS.md
../vibeam-pr-0.5/AGENTS.md
../vibeam-pr-0.5/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.5/agents/ceo/AGENTS.md
../vibeam-pr-0.5/agents/cmo/AGENTS.md
../vibeam-pr-0.5/agents/cos/AGENTS.md
../vibeam/vibeam-app/AGENTS.md
../vibeam/AGENTS.md
../vibeam/agents/founding-engineer/AGENTS.md
../vibeam/agents/ceo/AGENTS.md
../vibeam/agents/cmo/AGENTS.md
../vibeam/agents/cos/AGENTS.md
../oss-repos/codex/AGENTS.md
../oss-repos/t3code/AGENTS.md
../oss-repos/t3code/.repos/alchemy-effect/AGENTS.md
../oss-repos/t3code/.repos/alchemy-effect/packages/alchemy/src/AWS/AGENTS.md
../oss-repos/t3code/.repos/effect-smol/AGENTS.md
../vibeam-pr-0.9/AGENTS.md
../vibeam-pr-0.9/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.9/agents/ceo/AGENTS.md
../vibeam-pr-0.9/agents/cmo/AGENTS.md
../vibeam-pr-0.9/agents/cos/AGENTS.md

exec
/bin/bash -lc 'pnpm --filter @dohc/desktop test -- --runInBand' in /home/ice/dev/dohc
 exited 1 in 774ms:

> @dohc/desktop@0.1.0 test /home/ice/dev/dohc/apps/desktop
> vitest run -- --runInBand

failed to load config from /home/ice/dev/dohc/apps/desktop/vitest.config.ts

⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
Error: EROFS: read-only file system, open '/home/ice/dev/dohc/apps/desktop/vitest.config.ts.timestamp-1781080722983-19d21d03f0fc5.mjs'
    at async open (node:internal/fs/promises:641:25)
    at async Object.writeFile (node:internal/fs/promises:1249:14)
    at async loadConfigFromBundledFile (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66973:5)
    at async loadConfigFromFile (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66816:24)
    at async resolveConfig (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66416:24)
    at async _createServer (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:63015:18)
    at async createViteServer (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:9842:18)
    at async createVitest (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11461:18)
    at async prepareVitest (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11884:15)
    at async startVitest (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11813:15) {
  errno: -30,
  code: 'EROFS',
  syscall: 'open',
  path: '/home/ice/dev/dohc/apps/desktop/vitest.config.ts.timestamp-1781080722983-19d21d03f0fc5.mjs'
}



/home/ice/dev/dohc/apps/desktop:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @dohc/desktop@0.1.0 test: `vitest run -- --runInBand`
Exit status 1

exec
/bin/bash -lc "node -e \"const {join}=require('node:path'); const {pathToFileURL}=require('node:url'); console.log(JSON.stringify(join('/x/dist/main','../renderer/'))); console.log(pathToFileURL(join('/x/dist/main','../renderer/')).href);\"" in /home/ice/dev/dohc
 succeeded in 104ms:
exec
/bin/bash -lc "grep -R \"Phase 2\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md | head -20 && sed -n '1,260p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 105ms:
# dohc Desktop Local-First Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. If those skills are unavailable, use native orchestration instead: a lead agent implements phases sequentially, fans out parallel subagent review workflows at every major checkpoint (security, UX/screenshot, performance, deletion-safety), runs long test suites in the background, and self-paces with scheduled wakeups so execution continues unattended. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot dohc from a web-first Convex workspace into an Electron-first, local-file-first workspace that syncs to dohc Cloud or self-hosted Postgres, lets local Codex/Claude Code work directly on files, and preserves dohc's collaboration, apps, SQLite, provenance, and agent-testing strengths.

**Product thesis:** Files are local and owned, but they are not *just* local files — they are building blocks people share and build on together. dohc brings git-grade building-collaboration (change sets, history, attribution, review at real boundaries, AI-assisted merge) to everyday people, the way git brought it to engineers. Local-first accountless use is the free trust wedge; dohc Cloud is the paid collaboration engine. Without the collaboration layer, dohc is arguably an Obsidian clone — with it, it is a new category. Collaboration surfaces are first-class product, never sync plumbing.

What separates dohc from Obsidian-class tools is three legs, and the combination is the moat: (1) agents are first-class workers with infrastructure — change sets, provenance, attribution, review gates, MCP tools, tested apps — not bolted-on plugins with folder access; (2) work primitives beyond notes — real SQLite databases, data imports, and source-backed apps a user's agent can build and dohc can test; (3) git-grade collaboration. Local files, markdown, speed, and a command palette are table stakes adopted from Obsidian, not differentiation — every phase should protect all three legs, and users' agents (not a plugin marketplace) are dohc's ecosystem.

**Architecture:** Workspaces are real folders on disk. The desktop app is the primary product surface and runs a local dohc core that watches folders, batches changes, maintains `.dohc/` metadata, serves the React renderer, exposes MCP/tools to local agents, and syncs with dohc Cloud/self-hosted Postgres when enabled. The existing dual-backend branch is treated as a completed prototype: keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, and AppTester pieces; delete Convex and web-first compatibility paths once equivalent local-first tests prove the replacement.

**Tech Stack:** Electron, React/TanStack Start renderer, TypeScript, Vite/electron-vite or equivalent Electron Vite build tooling, Playwright Electron automation, Vitest, Postgres, Drizzle ORM, Better Auth (inside workspace-api, Drizzle adapter on the same Postgres) for cloud/self-host authentication, Hocuspocus/Yjs for live collaborative text in shared workspaces, local filesystem storage, S3-compatible object storage for cloud/self-host, SQLite worker/AppTester services, MCP server for Codex/Claude integration, Docker Compose for self-host/dev.

---

## Research Basis

Use these references while implementing:

- Electron security checklist and context isolation: `https://www.electronjs.org/docs/latest/tutorial/security`
- Electron context isolation: `https://www.electronjs.org/docs/latest/tutorial/context-isolation`
- Electron sandboxing: `https://www.electronjs.org/docs/latest/tutorial/sandbox`
- Electron fuses: `https://www.electronjs.org/docs/tutorial/fuses`
- Electron IPC: `https://www.electronjs.org/docs/latest/tutorial/ipc`
- Playwright Electron automation: `https://playwright.dev/docs/api/class-electron`
- electron-vite guide and CLI: `https://electron-vite.org/guide/`, `https://electron-vite.org/guide/cli`
- Electron Forge Vite plugin if the implementer chooses Forge instead of electron-vite: `https://www.electronforge.io/config/plugins/vite`
- electron-builder signing and updates: `https://www.electron.build/docs/features/code-signing/`, `https://www.electron.build/docs/features/auto-update/`
- Chromium performance APIs for renderer marks/measures: `https://developer.mozilla.org/docs/Web/API/Performance`
- React profiler for targeted render-cost investigation: `https://react.dev/reference/react/Profiler`
- Local reference implementation: `/home/ice/dev/oss-repos/t3code/apps/desktop`
- Better Auth docs (Drizzle adapter, organization plugin, device authorization, SSO): `https://www.better-auth.com/docs`
- Hocuspocus server/provider docs: `https://tiptap.dev/docs/hocuspocus`
- Yjs docs: `https://docs.yjs.dev`

Important lessons from the references:

- Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.
- Expose only narrow, validated preload APIs through `contextBridge`.
- Treat IPC as an untrusted boundary; validate every payload and sender.
- Use Playwright's Electron launcher to drive real desktop E2E tests.
- For packaging, signed/notarized builds and update metadata matter; unsigned dev builds are fine, unsigned release builds are not.
- `electron-vite` is a good fit for a Vite/React codebase, but Electron Forge + Vite is acceptable if it better fits repo conventions.
- t3code's desktop package is a useful pattern: explicit desktop package, main/preload separation, desktop bridge contract, desktop auth/bootstrap, update tests, smoke tests, and release artifact scripts.
- Desktop performance must be measured inside the real Electron app, not inferred from unit tests.
- Native-feeling performance requires startup, first paint, file-tree rendering, search, sync, app open, and database operations to have explicit budgets.

## Strategic Decisions Already Made

- Cut Convex in the new architecture.
- Use Postgres for dohc Cloud and self-hosted sync/collaboration.
- Use Better Auth (running inside workspace-api on the Drizzle/Postgres stack) for dohc Cloud and self-host authentication: email/password plus the device authorization flow for desktop login and the organization plugin for teams. Self-hosters get working auth with no external vendor account. WorkOS is deferred as an optional enterprise SSO/SCIM provider plugged in behind Better Auth when a business customer requires it.
- Live real-time co-editing (Yjs/Hocuspocus) for markdown/text in shared workspaces is in scope for this plan. Raw SQLite bytes and binary assets are still never CRDT-synced. Hocuspocus ACL must be ported off Convex to Postgres.
- Collaboration is the business model: local-first accountless use is the free wedge; dohc Cloud monetizes shared building — team workspaces, sync, live co-editing, change-set history, attribution, and AI-assisted merge. The history/attribution/catch-up surfaces are user-facing product, required even in local-only mode so sharing adds zero new concepts.
- Build Electron desktop first.
- Keep web, but make it secondary: cloud access, shared links, mobile-friendly access, and users without desktop.
- Local-only use works with no account.
- dohc Cloud login is required only for cloud sync, hosted agents, sharing, backups, teams, and multi-device cloud features.
- Personal workspaces default to local-first.
- Shared/team workspaces default to cloud-first with an always-available local working copy.
- Cloud-only workspaces remain optional for web/mobile/shared-link use.
- Sync is automatic but settled/batched, not immediate per filesystem event.
- dohc builds its own AI-native sync/history/change-set model instead of using Git as the default.
- Git integration may be added later as optional export/mirror/integration.
- Apps are visible source folders under `.apps/<name>/`, with internal build/cache.
- User-meaningful SQLite databases can be visible `.sqlite` files; hidden managed databases are allowed only for internal cache/app internals.
- Collaboration is liberal by default: if the user has edit access, they and their agent can edit. Interrupt only on real boundary crossings.
- Federation between dohc Cloud and separate self-hosted instances is deferred.
- License choice is deferred, but the architecture must be open-source/self-host ready.

## What The Completed Old Plan Gives Us

The completed `2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md` branch provides useful substrate:

- `packages/workspace-contracts`
- `packages/workspace-postgres`
- `packages/workspace-fs`
- `services/workspace-api`
- `services/agent-sandbox`
- uploads and file-type views
- AppTester and app quality gates
- app/SQLite runtime and operation-log ideas
- agent output/activity separation
- backend matrix patterns
- tech debt/deletion audit patterns

This plan should port, promote, or reuse those pieces where they fit.

This plan should delete:

- Convex backend support.
- `packages/workspace-convex-compat`.
- dual-backend switching that exists only to compare Convex and Postgres.
- web-first atom/tool paths that duplicate local-file-first behavior.
- `.views` product-language paths once `.apps` compatibility/migration tests prove safe deletion.
- stale onboarding and agent prompt fragments that assume dohc is a cloud notes app.

## Non-Negotiables

- Do not weaken authorization, ownership, sharing boundaries, locks, review gates, app trust, provenance, or workspace scoping.
- Do not make local sync an unmanaged overwrite path.
- Do not turn shared/team collaboration into a restrictive permission maze. If a user has edit access, normal edits sync automatically.
- Boundary crossings still need guardrails: public publishing, external sharing, permission changes, bulk deletes, app trust/install, private-to-shared moves, and unmergeable overwrites.
- Renderer code must never get raw Node/Electron access.
- Preload APIs must be narrow and validated.
- Desktop shell/MCP capabilities must be powerful but workspace-scoped by default.
- Local-only personal workspace edits should not require approval.
- Shared/team normal edits should not require approval if the user has edit access.
- Do not CRDT-sync raw SQLite bytes.
- Do not store generated binary assets as markdown text.
- User-meaningful work must remain inspectable as files, assets, apps, or databases.
- Reduce tech debt while implementing. Delete obsolete code when tests prove it is safe.
- Performance is a product invariant. The desktop app must feel native and fast; do not accept slow startup, janky typing, sluggish file trees, expensive sync loops, or slow agent/app/database flows as "good enough."

## UI/UX Direction

dohc Desktop should preserve the current dohc feel: simple, clean, muted, warm, and work-focused. The evolution should make it feel more native and capable, not louder.

Take inspiration from:

- Obsidian: local files, calm sidebar, fast command palette, keyboard-first navigation, no heavy chrome.
- Codex/Claude Code: agent work feels active, inspectable, and powerful without decorative UI.
- t3code: desktop-first shell, local agent/runtime affordances, useful status surfaces, app-like polish.
- Linear/Raycast-level restraint: dense but readable controls, crisp typography, responsive interactions.

Do:

- keep warm paper + graphite as the product base.
- keep spacing compact and calm.
- make the file tree, command palette, editor, app runtime, sync status, and agent activity feel like native desktop surfaces.
- use subtle dividers, hover states, and active states.
- prefer icons plus short labels for commands.
- preserve keyboard shortcuts and quick switching.
- make local/cloud/sync state obvious without banners everywhere.
- make first launch immediately usable: create/open a workspace, not a marketing page.
- use screenshots and E2E checks to verify layout, text fit, and nonblank rendering.

Do not:

- add marketing-style hero sections to the desktop app.
- add gradient/orb decoration.
- make card-heavy dashboards for core workspace UI.
- make one-note purple/blue/dark-slate palettes.
- hide real files behind abstract product terms.
- ship a web page inside Electron without desktop affordances.
- make agent progress one giant paragraph.
- let text overflow, wrap badly, or occlude controls.

UI quality bar:

- default desktop shell should feel boring in the best way: obvious, fast, and trustworthy.
- every primary screen should be usable at 1280x800 and 1536x960.
- empty states should offer the next real action, not explain the product.
- file/app/database/media views should feel like different file types, not markdown with costumes.
- sync/conflict/agent activity should be inspectable but not noisy.

Native app feel requirements (what separates a legit desktop app from a website in a frame):

- custom titlebar integrated with the shell: draggable regions, platform-correct window controls, no default browser chrome.
- window state persists across launches: size, position, maximized state, last workspace.
- real menus: application menu and right-click context menus on files, folders, tabs, and editor selections — not web dropdowns pretending.
- keyboard-first everywhere: every primary action reachable without the mouse; platform-correct modifiers; visible focus states for keyboard users only.
- no web artifacts: no text-selection cursor on chrome, no image/link dragging, no pull-to-refresh or rubber-band on static surfaces, no FOUC or white flash on launch (background color set before first paint), no browser zoom on ctrl+scroll unless intentional.
- typography tuned for UI density: UI font stack for chrome, content font for documents; crisp rendering; no document-scale headings inside tool surfaces.
- one spacing grid (4px base) and one restrained token set: current dohc warm paper + graphite, one accent, subtle radii, shadows only for true elevation (menus, palette, dialogs).
- system theme (light/dark) followed without flashing or interrupting running work.
- resize behaves natively: panels reflow without jank, sidebar widths persist, no layout shift on font load.
- interactions acknowledge instantly: hover/active states under 50ms, skeletons only where real latency exists.

### Design Review Loop (required for every UI phase)

Phases 3, 6, 7 (app runtime UI), 9 (login UI), 10 (collab/conflict UI), 11 (settings/agent UI), and 18 must run this loop before their phase commit:

1. Before first implementation in Phase 3: recon the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`) and record which layout, titlebar, panel, and status-surface patterns to adopt or reject.
2. Capture screenshots of every new/changed surface at 1280x800 and 1536x960, light and dark, via the Playwright Electron tests.
3. Run a dedicated design-review subagent over the screenshots with this rubric, each item scored pass/fail:
   - looks like a native desktop app, not a web page in Electron.
   - clean, professional, calm: would not look out of place next to Obsidian, Linear, or Raycast.
   - consistent with dohc's warm paper + graphite identity; no palette drift.
   - spacing, alignment, and type hierarchy are deliberate; nothing cramped, floating, or misaligned.
   - no text overflow, truncation surprises, or occluded controls.
   - empty/loading/error states designed, not defaulted.
   - no marketing chrome, gradients/orbs, or card-heavy dashboard syndrome.
4. Fix every fail and re-run the loop. Maximum 3 iterations per UI phase. Hard items (text overflow, occluded controls, blank render, marketing chrome, palette drift from tokens) block the phase unconditionally. Soft aesthetic items still failing after 3 iterations become explicit deferred findings with screenshots in the execution log, re-judged at the Phase 18 readiness review.
5. A UI phase is not complete while any hard rubric item fails.
6. Screenshot convention (established by the Phase 2 launch E2E): tests write to `test-results/screenshots/phase-<NN>/<surface>--<width>x<height>--<light|dark>.png`. The design-review brief is fixed: "Review every PNG under `test-results/screenshots/phase-<NN>/` against the rubric; output per-file, per-item pass/fail with the failing region described." Include 2-3 reference screenshots from earlier passing phases to anchor consistency across fresh-context judges.

## Performance Budgets

These budgets are initial targets for the implementation. If a target is impossible in CI due to hardware/display limitations, the agent must record the local measured number, explain the environment, and keep a tighter relative regression budget.

Desktop UX budgets:

- cold desktop launch to first visible shell: under 2.0s on the local dev machine.
- warm launch to first visible shell: under 1.0s.
- first local workspace creation: under 1.0s for an empty workspace.
- open existing workspace with 1,000 files: under 1.5s to interactive file tree.
- file tree filter/search over 10,000 paths: under 100ms for the query operation and under 200ms to visible result.
- open markdown file under 250KB: under 150ms after click.
- typing latency in markdown editor: no sustained frame over 16ms during normal typing; no long task over 50ms.
- file watcher settle and detect single markdown save: under 2.0s.
- batch 100 changed files into one change set: under 3.0s without blocking the renderer.
- open `.apps/<name>` runtime after build cache warm: under 1.0s.
- run AppTester static+browser smoke for a small app: under 15s in CI/dev.
- open SQLite table with 10,000 rows: under 1.0s to first page.
- import 10,000-row CSV to SQLite: under 5.0s in local dev.

Resource budgets:

- renderer idle CPU should return near idle (~0%) after sync/app/test operations finish.
- no unbounded polling loops.
- large file indexing must be incremental or worker-backed.
- sync, import, AppTester, and SQLite work must not block the Electron renderer.
- desktop memory after opening a 1,000-file workspace: initial target under 400MB working set, measured and recorded; regressions over 20% require investigation.
- initial renderer JS loaded before first shell paint: initial target under 3MB; the build must print bundle size, and unexplained growth over 10% between phases fails the performance check.
- no memory growth across repeated workspace open/close cycles (leak check).

Performance engineering rules (anti-bloat):

dohc Desktop is the antithesis of Notion-class bloated Electron apps. Slowness is a bug, not polish debt. These rules apply to every phase, not just Phase 16:

- dependency discipline: every new dependency is justified in the execution log — what it does, its size and transitive cost, and the alternative considered. Prefer the platform/stdlib. No kitchen-sink UI kits.
- first-paint discipline: only code needed to paint the shell loads at startup. Everything else is lazy-loaded or deferred to idle. No blocking IPC round trips before first paint. Window background color is set before first paint (no white flash).
- the renderer renders; it does not compute: parsing, scanning, hashing, indexing, imports, SQLite, and app builds run in main-process services or workers. A renderer long task over 50ms on a hot path is a bug.
- virtualize every unbounded surface: file tree, tables, search results, history, agent activity.
- IPC is batched and coalesced: no per-keystroke or per-file-event round trips.
- animations use transform/opacity only; nothing that forces layout on a hot path.
- React hot paths are profiled: no full-tree re-renders on keystroke, file event, or sync tick.
- measure first, optimize second: every optimization records before/after numbers in the execution log.

Continuous enforcement (do not defer performance to Phase 16):

- Phase 2 ships the minimal measurement harness with the scaffold: launch/first-paint marks and a measurements JSON written by the Playwright Electron tests.
- Every subsequent phase that adds a measurable surface (file tree, editor, sync, apps, SQLite, imports, agents) adds its marks and measurements in that phase and records the numbers in the execution log.
- Phase 16 formalizes budgets into the hard `check:performance` gate and ratchets existing measurements — it must not be the first time a number is seen.
- A phase that makes a previously recorded measurement materially worse must fix it in that phase, not defer it.

Every phase touching UI, filesystem watching, sync, database import, app runtime, or agent tooling must add or update a performance check.

## Code Size And Deletion Rules

The fewer lines delivered, the better. This pivot must shrink the codebase, not grow a second product beside the old one. Code deletion is highly valued work.

- Deletion is part of every phase's definition of done, not a Phase 17 sweep. When a replacement lands with passing tests, the replaced path dies in the same phase. Phase 17 is the final audit, not where deletion starts.
- Reuse before write: before creating any new helper, module, or component, search for an existing one to promote or extend — the dual-backend substrate and current app are large. Duplication discovered later is a phase bug, not acceptable drift.
- Smallest implementation that passes the tests: no speculative abstraction, no config options nobody asked for, no wrapper layers around single call sites, no manager/factory/registry indirection without at least two real consumers today.
- Track net LOC per phase: record `git diff --shortstat` for every phase commit in the execution log. Product-surface phases may be net-positive; integration, repositioning, and deletion phases (12, 13, 17) must be strongly net-negative. Unexplained growth is a review finding to fix.
- Track branch-total LOC versus main at every major checkpoint. Deleting Convex, the compat package, dual-backend switching, and web-first duplicates should offset much of the new desktop/sync/auth code; record the honest number and justify the trend.
- Codex per-phase reviews must be prompted to flag over-engineering, orphaned/unreachable code, and simplification opportunities — not just bugs.
- Never record deferred work as code comments — the debt gate (`check:debt`) fails on the literal deferred-work marker tokens it scans for, and the failure surfaces phases later, far from its cause. Deferred work goes in the execution log's deferred-findings list with a completion condition. Adding entries to the check-tech-debt or knip allowlists for code this branch authored is forbidden; allowlists are for pre-existing/historical paths only, and every addition must be named in that phase's Codex review prompt.

## AI Agent Execution Contract

The implementing agent should assume the user is AFK and keep going until completion or a real blocker.

### Required Read Order (Tiered For Finite Context)

The lead reads inline, once per fresh context:


exec
/bin/bash -lc "sed -n '759,850p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:
## Phase 2: Electron Desktop Scaffold And Test Harness

**Files:**

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/ipc/channels.ts`
- Create: `apps/desktop/src/ipc/bridgeContract.ts`
- Create: `apps/desktop/src/window/createMainWindow.ts`
- Create: `apps/desktop/src/security/electronSecurity.ts`
- Create: `apps/desktop/src/security/electronSecurity.test.ts`
- Create: `apps/desktop/src/performance/launchMarks.ts`
- Create: `apps/desktop/src/smoke/desktopSmoke.test.ts`
- Create: `apps/desktop/e2e/desktopLaunch.spec.ts`
- Create: `apps/desktop/scripts/smoke-test.mjs`
- Create: `apps/desktop/playwright.config.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml` (onlyBuiltDependencies allowlist)

Root `playwright.config.ts` is NOT modified in this phase — it stays pointed at the web app so `pnpm test:e2e` keeps working.

- [ ] **Step 1: Install Electron desktop tooling**

Install current packages compatible with the repo's Node/Vite constraints:

```bash
pnpm add -D --filter @dohc/desktop electron electron-vite electron-builder @electron/fuses playwright @playwright/test
```

If workspace filtering cannot target a new package before creation, create `apps/desktop/package.json` first, then install.

Also add:

```bash
pnpm add --filter @dohc/desktop electron-updater zod
```

Expected dependency intent:

- `electron`: desktop runtime.
- `electron-vite`: build/dev main, preload, renderer entries.
- `electron-builder`: package/sign/update artifacts.
- `@electron/fuses`: harden packaged app features.
- `playwright` and `@playwright/test`: launch and test Electron windows.
- `electron-updater`: future update flow tests.
- `zod`: validate IPC payloads.

Install preconditions (verified landmines on this repo/host):

- pnpm 10 ignores dependency postinstall scripts by default and the repo has no allowlist. BEFORE installing, add to `pnpm-workspace.yaml`: `onlyBuiltDependencies: [electron, esbuild, electron-winstaller]` (extend for native deps later). After install, verify the Electron binary with `pnpm --filter @dohc/desktop exec electron --version` (under xvfb-run if needed) BEFORE writing any test. If it fails, run `pnpm approve-builds` and record in the log. Same applies in Phase 8 if native SQLite deps are added (plus electron-rebuild for the Electron ABI).
- Desktop E2E gets its own `apps/desktop/playwright.config.ts` (testDir `./e2e`, `workers: 1` — Electron instances can't parallelize on one display, NO webServer block, ~60s per-test timeout). Root script becomes `"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts"`. The root `playwright.config.ts` (testDir `./apps/app/e2e`, web dev-server bootstrap) must remain untouched so `pnpm test:e2e` keeps working.

- [ ] **Step 2: Write failing Electron security tests**

`apps/desktop/src/security/electronSecurity.test.ts` must assert:

- `nodeIntegration` is false.
- `contextIsolation` is true.
- `sandbox` is true.
- preload path is absolute.
- renderer cannot navigate to arbitrary external URLs.
- `window.open` external targets are denied or opened through safe shell handler.

- [ ] **Step 3: Write failing desktop launch E2E**

`apps/desktop/e2e/desktopLaunch.spec.ts` must launch Electron using Playwright:

```ts
import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";

test("launches dohc desktop and renders the first-run shell", async () => {
  const app = await electron.launch({
    args: ["apps/desktop/dist/main.js"],
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await page.screenshot({ path: "test-results/desktop-launch.png" });
  await app.close();
});
```

If the build output path differs, update the test after implementing `electron-vite` build. The RED failure should be missing desktop app/build output.

- [ ] **Step 4: Implement minimal Electron main/preload**

Use secure defaults:

exec
/bin/bash -lc "sed -n '850,960p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:
Use secure defaults:

```ts
new BrowserWindow({
  show: false,
  webPreferences: {
    preload: absolutePreloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
});
```

Expose only:

```ts
window.dohcDesktop.getVersion()
window.dohcDesktop.pickWorkspaceRoot()
window.dohcDesktop.getWorkspaceRegistry()
```

through `contextBridge`.

Also ship the minimal performance measurement harness required by the Continuous enforcement rules: marks for app-ready, first window, and first renderer paint in `launchMarks.ts`, exposed through a test-only bridge so the launch E2E writes `test-results/performance/desktop-performance.json` from day one. Later phases append their own marks to the same file; Phase 16 turns it into the hard gate.

- [ ] **Step 5: Add root scripts**

```json
"dev:desktop": "pnpm --filter @dohc/desktop dev",
"build:desktop": "pnpm --filter @dohc/desktop build",
"test:desktop": "pnpm --filter @dohc/desktop test",
"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
"smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs"
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @dohc/desktop test
pnpm build:desktop
pnpm test:desktop:e2e
```

Expected: pass. If the environment lacks a display server, run under `xvfb-run` and record that in the execution log.

WSL2 sandbox rule: if Electron fails to launch on this machine, the fix is ALWAYS environmental, never webPreferences. Allowed: install missing system libraries (record them), run under xvfb-run, or pass `--no-sandbox` as a LAUNCH ARGUMENT in the Playwright harness only, gated on `DOHC_E2E_NO_CHROMIUM_SANDBOX=1` and recorded in the log. Forbidden: `sandbox: false`, `contextIsolation: false`, `nodeIntegration: true` in product code, or deleting/weakening the security tests. The security unit test asserts the webPreferences object as configured, so it passes regardless of host sandbox capability.

- [ ] **Step 7: Review against t3code**

Compare against:

```txt
/home/ice/dev/oss-repos/t3code/apps/desktop/src/main.ts
/home/ice/dev/oss-repos/t3code/apps/desktop/src/preload.ts
/home/ice/dev/oss-repos/t3code/apps/desktop/src/electron
```

Record which patterns were reused and which were intentionally avoided.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop package.json pnpm-lock.yaml pnpm-workspace.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Scaffold secure Electron desktop app"
```

---

## Phase 3: Native-Feeling Desktop Shell UX

**Files:**

- Create: `apps/desktop/src/renderer/DesktopRoot.tsx`
- Create: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
- Create: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
- Create: `apps/desktop/src/renderer/nativeChrome.ts`
- Create: `apps/desktop/src/renderer/desktop.css`
- Create: `apps/desktop/src/renderer/DesktopFirstRun.test.tsx`
- Create: `apps/desktop/e2e/firstRunWorkspace.spec.ts`
- Modify: current React app exports if reused from `apps/app/src`

- [ ] **Step 1: Write failing first-run tests**

Tests must assert first launch:

- suggests `~/dohc`.
- allows choosing another folder.
- creates `personal` workspace.
- does not require login.
- offers "Enable dohc Cloud sync" but does not force it.
- looks and behaves like a desktop app, not a web onboarding page.

- [ ] **Step 2: Write failing native UX E2E**

Playwright Electron test must assert:

- app opens with a framelike desktop shell.
- sidebar/file tree is immediately usable.
- keyboard shortcuts work: new file, command palette, quick open.
- theme follows system but does not interrupt running agent/sync work.
- text does not overflow at 1280x800 and 1536x960.
- screenshot comparison or screenshot artifact exists for first-run, workspace shell, command palette, and file preview.
- app chrome uses muted dohc styling and does not render marketing/landing-page UI.
- agent activity renders as a timeline/panel, not as one giant final paragraph.

- [ ] **Step 3: Implement desktop-first shell**

Reuse current React components per the component reuse map: the Phase 3 recon must produce `docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md`, classifying each candidate in `apps/app/src/components/` as (a) reuse as-is, (b) port with data-layer swap, or (c) rebuild — using the mechanical criterion: a component is reusable only if it has no imports from `convex/react`, `apps/app/convex/_generated`, or web router internals; otherwise its data access must be lifted to props fed by the typed desktop bridge. Implementer briefs cite this artifact, never "where sensible". Change UX that feels web-first.

Desktop shell must include:

exec
/bin/bash -lc "node -e \"const p=require('./node_modules/@playwright/test/package.json'); console.log(p.dependencies)\" && ls node_modules/.pnpm | grep '"'^playwright@'"' | head" in /home/ice/dev/dohc
 succeeded in 0ms:
{ playwright: '1.60.0' }

exec
/bin/bash -lc "cat playwright.config.ts && find apps/desktop/src -type f -maxdepth 4 -print | sort | xargs -r -n1 sh -c 'echo ==="'$0; nl -ba $0 | sed -n "1,140p"'"'" in /home/ice/dev/dohc
 succeeded in 248ms:
===apps/desktop/src/ipc/channels.ts
     1	export const CHANNELS = {
     2	  getVersion: "desktop:get-version",
     3	  pickWorkspaceRoot: "desktop:pick-workspace-root",
     4	  getWorkspaceRegistry: "desktop:get-workspace-registry",
     5	  firstPaint: "desktop:first-paint",
     6	  getLaunchMarks: "desktop:test:get-launch-marks",
     7	} as const;
     8	
     9	export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
===apps/desktop/src/main.ts
     1	import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
     2	import {
     3	  LaunchMarksResult,
     4	  PickWorkspaceRootResult,
     5	  VersionResult,
     6	  WorkspaceRegistryResult,
     7	} from "./ipc/bridgeContract";
     8	import { CHANNELS } from "./ipc/channels";
     9	import { launchMarks } from "./performance/launchMarks";
    10	import { decideNavigation } from "./security/electronSecurity";
    11	import { navigationPolicy } from "./window/createMainWindow";
    12	
    13	// IPC is an untrusted boundary: handlers only answer frames the navigation
    14	// policy itself would allow (exact dev origin or the packaged bundle).
    15	function isTrustedFrame(frameUrl: string): boolean {
    16	  return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
    17	}
    18	
    19	function assertTrustedSender(event: IpcMainInvokeEvent): void {
    20	  const frameUrl = event.senderFrame?.url ?? "";
    21	  if (!isTrustedFrame(frameUrl)) {
    22	    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
    23	  }
    24	}
    25	
    26	function registerIpcHandlers(): void {
    27	  ipcMain.handle(CHANNELS.getVersion, (event) => {
    28	    assertTrustedSender(event);
    29	    return VersionResult.parse(app.getVersion());
    30	  });
    31	
    32	  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
    33	    assertTrustedSender(event);
    34	    const result = await dialog.showOpenDialog({
    35	      properties: ["openDirectory", "createDirectory"],
    36	    });
    37	    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    38	    return PickWorkspaceRootResult.parse(picked);
    39	  });
    40	
    41	  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
    42	    assertTrustedSender(event);
    43	    // Real registry lands in Phase 4.
    44	    return WorkspaceRegistryResult.parse({ workspaces: [] });
    45	  });
    46	
    47	  ipcMain.on(CHANNELS.firstPaint, (event) => {
    48	    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
    49	      launchMarks.firstPaint();
    50	    }
    51	  });
    52	
    53	  if (process.env.DOHC_DESKTOP_TEST === "1") {
    54	    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
    55	      assertTrustedSender(event);
    56	      return LaunchMarksResult.parse(launchMarks.snapshot());
    57	    });
    58	  }
    59	}
    60	
    61	// Single-instance lock gates the entire bootstrap, not just a quit() call.
    62	if (!app.requestSingleInstanceLock()) {
    63	  app.quit();
    64	} else {
    65	  void app.whenReady().then(async () => {
    66	    launchMarks.appReady();
    67	    registerIpcHandlers();
    68	    const { createMainWindow } = await import("./window/createMainWindow");
    69	    createMainWindow();
    70	    launchMarks.firstWindow();
    71	  });
    72	
    73	  app.on("window-all-closed", () => {
    74	    if (process.platform !== "darwin") app.quit();
    75	  });
    76	}
===apps/desktop/src/performance/launchMarks.ts
     1	// Launch instrumentation, alive from the first scaffold per the plan's
     2	// continuous performance enforcement: later phases append marks, Phase 16
     3	// turns the numbers into a hard gate.
     4	
     5	const processStart = Date.now();
     6	
     7	interface LaunchMarks {
     8	  appReadyMs: number;
     9	  firstWindowMs: number;
    10	  firstPaintMs: number;
    11	}
    12	
    13	const marks: Partial<LaunchMarks> = {};
    14	
    15	function markOnce(key: keyof LaunchMarks): void {
    16	  if (marks[key] === undefined) marks[key] = Date.now() - processStart;
    17	}
    18	
    19	export const launchMarks = {
    20	  appReady: () => markOnce("appReadyMs"),
    21	  firstWindow: () => markOnce("firstWindowMs"),
    22	  firstPaint: () => markOnce("firstPaintMs"),
    23	  snapshot: (): Partial<LaunchMarks> => ({ ...marks }),
    24	};
===apps/desktop/src/preload.ts
     1	import { contextBridge, ipcRenderer } from "electron";
     2	import { CHANNELS } from "./ipc/channels";
     3	
     4	// The entire bridge surface. Narrow on purpose: the renderer gets named,
     5	// typed operations — never raw ipcRenderer, never Node.
     6	contextBridge.exposeInMainWorld("dohcDesktop", {
     7	  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
     8	  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
     9	  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
    10	});
    11	
    12	// One-shot paint signal for launch instrumentation (no data, no response).
    13	contextBridge.exposeInMainWorld("dohcDesktopInternal", {
    14	  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
    15	});
    16	
    17	if (process.env.DOHC_DESKTOP_TEST === "1") {
    18	  contextBridge.exposeInMainWorld("dohcDesktopTest", {
    19	    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
    20	  });
    21	}
===apps/desktop/src/renderer/index.html
     1	<!doctype html>
     2	<html lang="en">
     3	  <head>
     4	    <meta charset="UTF-8" />
     5	    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
     6	    <title>dohc</title>
     7	    <style>
     8	      /* Warm paper + graphite, set inline so first paint is never unstyled. */
     9	      :root {
    10	        color-scheme: light dark;
    11	      }
    12	      html,
    13	      body {
    14	        margin: 0;
    15	        height: 100%;
    16	        background: #faf7f2;
    17	        color: #2b2926;
    18	        font-family:
    19	          system-ui,
    20	          -apple-system,
    21	          "Segoe UI",
    22	          sans-serif;
    23	      }
    24	      @media (prefers-color-scheme: dark) {
    25	        html,
    26	        body {
    27	          background: #1c1a18;
    28	          color: #e8e4de;
    29	        }
    30	      }
    31	    </style>
    32	  </head>
    33	  <body>
    34	    <div id="root"></div>
    35	    <script type="module" src="./main.ts"></script>
    36	  </body>
    37	</html>
===apps/desktop/src/renderer/main.ts
     1	// Minimal first-run shell. Phase 3 replaces this with the real desktop
     2	// workspace shell (driven by the component reuse map + design review loop).
     3	
     4	declare global {
     5	  interface Window {
     6	    dohcDesktopInternal?: { firstPaint(): void };
     7	  }
     8	}
     9	
    10	const root = document.getElementById("root");
    11	if (root) {
    12	  const main = document.createElement("main");
    13	  main.style.cssText =
    14	    "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;";
    15	
    16	  const heading = document.createElement("h1");
    17	  heading.textContent = "dohc";
    18	  heading.style.cssText =
    19	    "font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;";
    20	
    21	  const subtitle = document.createElement("p");
    22	  subtitle.textContent = "Your workspace is a folder.";
    23	  subtitle.style.cssText = "font-size:14px;opacity:0.65;margin:0;";
    24	
    25	  main.append(heading, subtitle);
    26	  root.append(main);
    27	}
    28	
    29	requestAnimationFrame(() => {
    30	  window.dohcDesktopInternal?.firstPaint();
    31	});
    32	
    33	export {};
===apps/desktop/src/security/electronSecurity.test.ts
     1	import { describe, expect, it } from "vitest";
     2	import {
     3	  createMainWindowWebPreferences,
     4	  decideNavigation,
     5	  decideWindowOpen,
     6	} from "./electronSecurity";
     7	
     8	describe("main window web preferences", () => {
     9	  it("locks down the renderer: no node, isolated context, sandboxed", () => {
    10	    const prefs = createMainWindowWebPreferences("/abs/path/preload.js");
    11	    expect(prefs.nodeIntegration).toBe(false);
    12	    expect(prefs.contextIsolation).toBe(true);
    13	    expect(prefs.sandbox).toBe(true);
    14	  });
    15	
    16	  it("requires an absolute preload path", () => {
    17	    expect(() => createMainWindowWebPreferences("relative/preload.js")).toThrow(
    18	      /absolute/i,
    19	    );
    20	  });
    21	});
    22	
    23	describe("navigation policy", () => {
    24	  const policy = {
    25	    httpOrigins: ["http://localhost:5173"],
    26	    fileUrlPrefix: "file:///app/dist/renderer/",
    27	  };
    28	
    29	  it("allows in-app navigation", () => {
    30	    expect(
    31	      decideNavigation("file:///app/dist/renderer/index.html", policy),
    32	    ).toEqual({ action: "allow" });
    33	    expect(
    34	      decideNavigation("http://localhost:5173/route", policy),
    35	    ).toEqual({ action: "allow" });
    36	  });
    37	
    38	  it("denies navigation to arbitrary external URLs", () => {
    39	    expect(decideNavigation("https://evil.example.com", policy).action).toBe(
    40	      "deny",
    41	    );
    42	  });
    43	
    44	  it("denies origin prefix-spoofing (localhost:5173.evil.com)", () => {
    45	    expect(
    46	      decideNavigation("http://localhost:5173.evil.com/x", policy).action,
    47	    ).toBe("deny");
    48	  });
    49	
    50	  it("denies local files outside the renderer bundle", () => {
    51	    expect(decideNavigation("file:///etc/passwd", policy).action).toBe("deny");
    52	  });
    53	
    54	  it("denies file navigation entirely when no bundle prefix is set (dev)", () => {
    55	    expect(
    56	      decideNavigation("file:///app/dist/renderer/index.html", {
    57	        httpOrigins: ["http://localhost:5173"],
    58	        fileUrlPrefix: null,
    59	      }).action,
    60	    ).toBe("deny");
    61	  });
    62	
    63	  it("denies unparseable URLs", () => {
    64	    expect(decideNavigation("not a url", policy).action).toBe("deny");
    65	  });
    66	});
    67	
    68	describe("window.open policy", () => {
    69	  it("denies all window.open targets", () => {
    70	    expect(decideWindowOpen("https://dohc.ai/docs").action).toBe("deny");
    71	    expect(decideWindowOpen("file:///etc/passwd").action).toBe("deny");
    72	  });
    73	
    74	  it("routes http and https targets through the external shell handler", () => {
    75	    expect(decideWindowOpen("https://dohc.ai/docs").openExternal).toBe(true);
    76	    expect(decideWindowOpen("http://dohc.ai/docs").openExternal).toBe(true);
    77	    expect(decideWindowOpen("http://dohc.ai/docs").action).toBe("deny");
    78	  });
    79	
    80	  it("never shells out non-http(s) schemes", () => {
    81	    expect(decideWindowOpen("file:///etc/passwd").openExternal).toBe(false);
    82	    expect(decideWindowOpen("smb://share/x").openExternal).toBe(false);
    83	  });
    84	});
===apps/desktop/src/security/electronSecurity.ts
     1	import { isAbsolute } from "node:path";
     2	
     3	export interface MainWindowWebPreferences {
     4	  preload: string;
     5	  nodeIntegration: false;
     6	  contextIsolation: true;
     7	  sandbox: true;
     8	}
     9	
    10	export function createMainWindowWebPreferences(
    11	  preloadPath: string,
    12	): MainWindowWebPreferences {
    13	  if (!isAbsolute(preloadPath)) {
    14	    throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
    15	  }
    16	  return {
    17	    preload: preloadPath,
    18	    nodeIntegration: false,
    19	    contextIsolation: true,
    20	    sandbox: true,
    21	  };
    22	}
    23	
    24	export interface NavigationDecision {
    25	  action: "allow" | "deny";
    26	}
    27	
    28	export interface NavigationPolicy {
    29	  // Exact URL origins (scheme://host:port), compared with ===, never prefix:
    30	  // startsWith would allow http://localhost:5173.evil.com.
    31	  httpOrigins: string[];
    32	  // The packaged renderer bundle directory as a file:// href prefix; a bare
    33	  // "file://" allowance would open every local file to navigation.
    34	  fileUrlPrefix: string | null;
    35	}
    36	
    37	// The renderer may only navigate within the app itself: the packaged
    38	// bundle directory or the dev server's exact origin. Everything else,
    39	// including unparseable URLs, is denied.
    40	export function decideNavigation(
    41	  targetUrl: string,
    42	  policy: NavigationPolicy,
    43	): NavigationDecision {
    44	  try {
    45	    const url = new URL(targetUrl);
    46	    if (url.protocol === "http:" || url.protocol === "https:") {
    47	      return {
    48	        action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny",
    49	      };
    50	    }
    51	    if (url.protocol === "file:" && policy.fileUrlPrefix) {
    52	      return {
    53	        action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny",
    54	      };
    55	    }
    56	  } catch {
    57	    // fall through to deny
    58	  }
    59	  return { action: "deny" };
    60	}
    61	
    62	export interface WindowOpenDecision {
    63	  action: "deny";
    64	  openExternal: boolean;
    65	}
    66	
    67	// window.open never creates a BrowserWindow. http(s) targets are handed to
    68	// the OS browser; every other scheme is dropped entirely.
    69	export function decideWindowOpen(targetUrl: string): WindowOpenDecision {
    70	  let openExternal = false;
    71	  try {
    72	    const protocol = new URL(targetUrl).protocol;
    73	    openExternal = protocol === "https:" || protocol === "http:";
    74	  } catch {
    75	    openExternal = false;
    76	  }
    77	  return { action: "deny", openExternal };
    78	}
===apps/desktop/src/window/createMainWindow.ts
     1	import { BrowserWindow, shell } from "electron";
     2	import { join } from "node:path";
     3	import { pathToFileURL } from "node:url";
     4	import {
     5	  createMainWindowWebPreferences,
     6	  decideNavigation,
     7	  decideWindowOpen,
     8	  type NavigationPolicy,
     9	} from "../security/electronSecurity";
    10	
    11	// Warm paper — set before first paint so launch never flashes white.
    12	const BACKGROUND_COLOR = "#faf7f2";
    13	
    14	export function navigationPolicy(): NavigationPolicy {
    15	  const devServer = process.env.ELECTRON_RENDERER_URL;
    16	  if (devServer) {
    17	    // Dev: exact dev-server origin only; no file navigation at all.
    18	    return { httpOrigins: [new URL(devServer).origin], fileUrlPrefix: null };
    19	  }
    20	  // Prod: only the packaged renderer bundle directory.
    21	  const rendererDir = join(import.meta.dirname, "../renderer/");
    22	  return { httpOrigins: [], fileUrlPrefix: pathToFileURL(rendererDir).href };
    23	}
    24	
    25	export function createMainWindow(): BrowserWindow {
    26	  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");
    27	
    28	  const window = new BrowserWindow({
    29	    show: false,
    30	    width: 1280,
    31	    height: 800,
    32	    minWidth: 840,
    33	    minHeight: 620,
    34	    backgroundColor: BACKGROUND_COLOR,
    35	    webPreferences: createMainWindowWebPreferences(preloadPath),
    36	  });
    37	
    38	  window.webContents.setWindowOpenHandler(({ url }) => {
    39	    const decision = decideWindowOpen(url);
    40	    if (decision.openExternal) void shell.openExternal(url);
    41	    return { action: "deny" };
    42	  });
    43	
    44	  window.webContents.on("will-navigate", (event, url) => {
    45	    if (decideNavigation(url, navigationPolicy()).action === "deny") {
    46	      event.preventDefault();
    47	    }
    48	  });
    49	
    50	  window.once("ready-to-show", () => window.show());
    51	
    52	  const devServer = process.env.ELECTRON_RENDERER_URL;
    53	  if (devServer) {
    54	    void window.loadURL(devServer);
    55	  } else {
    56	    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
    57	  }
    58	
    59	  return window;
    60	}

exec
/bin/bash -lc "nl -ba apps/desktop/e2e/desktopLaunch.spec.ts && nl -ba apps/desktop/playwright.config.ts && nl -ba apps/desktop/package.json && nl -ba apps/desktop/scripts/smoke-test.mjs && nl -ba apps/desktop/electron.vite.config.ts && nl -ba apps/desktop/tsconfig.json && nl -ba package.json | sed -n '1,80p' && nl -ba pnpm-workspace.yaml" in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { expect, test } from "@playwright/test";
     2	import { mkdir, writeFile } from "node:fs/promises";
     3	import { _electron as electron } from "playwright";
     4	
     5	const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
     6	const PERF_FILE = "test-results/performance/desktop-performance.json";
     7	
     8	test("launches dohc desktop and renders the first-run shell", async () => {
     9	  const launchArgs = ["apps/desktop/dist/main/main.js"];
    10	  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
    11	    launchArgs.push("--no-sandbox");
    12	  }
    13	  const app = await electron.launch({
    14	    args: launchArgs,
    15	    cwd: process.cwd(),
    16	    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    17	  });
    18	
    19	  const page = await app.firstWindow();
    20	  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
    21	
    22	  await mkdir(SCREENSHOT_DIR, { recursive: true });
    23	  await page.setViewportSize({ width: 1280, height: 800 });
    24	  await page.screenshot({
    25	    path: `${SCREENSHOT_DIR}/first-run--1280x800--light.png`,
    26	  });
    27	
    28	  // Launch performance marks flow through the test-only bridge from day one;
    29	  // Phase 16 ratchets these numbers into a hard gate.
    30	  const marks = await page.evaluate(() =>
    31	    (window as never as {
    32	      dohcDesktopTest?: { getLaunchMarks(): Promise<Record<string, number>> };
    33	    }).dohcDesktopTest?.getLaunchMarks(),
    34	  );
    35	  expect(marks).toBeTruthy();
    36	  expect(marks?.appReadyMs).toBeGreaterThan(0);
    37	  expect(marks?.firstWindowMs).toBeGreaterThan(0);
    38	  expect(marks?.firstPaintMs).toBeGreaterThan(0);
    39	
    40	  await mkdir("test-results/performance", { recursive: true });
    41	  await writeFile(
    42	    PERF_FILE,
    43	    JSON.stringify({ phase: 2, launch: marks }, null, 2),
    44	  );
    45	
    46	  await app.close();
    47	});
     1	import { defineConfig } from "@playwright/test";
     2	
     3	// Dedicated desktop E2E config: Electron instances cannot safely run in
     4	// parallel on one display, and the web app's dev server is irrelevant here.
     5	// The root playwright.config.ts stays untouched for `pnpm test:e2e` (web).
     6	export default defineConfig({
     7	  testDir: "./e2e",
     8	  workers: 1,
     9	  timeout: 60_000,
    10	  retries: 0,
    11	  reporter: [["list"]],
    12	  outputDir: "../../test-results/desktop-e2e",
    13	});
     1	{
     2	  "name": "@dohc/desktop",
     3	  "private": true,
     4	  "version": "0.1.0",
     5	  "type": "module",
     6	  "main": "dist/main/main.js",
     7	  "scripts": {
     8	    "dev": "electron-vite dev",
     9	    "build": "electron-vite build",
    10	    "test": "vitest run",
    11	    "typecheck": "tsc --noEmit"
    12	  },
    13	  "devDependencies": {
    14	    "@electron/fuses": "^2.1.2",
    15	    "@types/node": "^22.19.19",
    16	    "electron": "^42.4.0",
    17	    "electron-builder": "^26.15.2",
    18	    "electron-vite": "^5.0.0",
    19	    "typescript": "^5.9.3",
    20	    "vite": "^8.0.14",
    21	    "vitest": "^2.1.9"
    22	  },
    23	  "dependencies": {
    24	    "electron-updater": "^6.8.9",
    25	    "zod": "^3.25.76"
    26	  }
    27	}
     1	import { spawn } from "node:child_process";
     2	import { existsSync } from "node:fs";
     3	import { join } from "node:path";
     4	
     5	// Spawns the built desktop app for a few seconds and fails on fatal stderr
     6	// patterns (t3code's smoke pattern). Catches broken builds that unit tests
     7	// cannot see: missing modules, preload failures, renderer crashes.
     8	
     9	const repoRoot = process.cwd();
    10	const mainEntry = join(repoRoot, "apps/desktop/dist/main/main.js");
    11	
    12	if (!existsSync(mainEntry)) {
    13	  console.error(`Desktop build missing: ${mainEntry} — run pnpm build:desktop first.`);
    14	  process.exit(1);
    15	}
    16	
    17	const FATAL_PATTERNS = [
    18	  /MODULE_NOT_FOUND/,
    19	  /Uncaught (Error|Exception)/i,
    20	  /Cannot find module/,
    21	  /Unable to load preload script/,
    22	  /Renderer process crashed/i,
    23	  /ERR_FILE_NOT_FOUND/,
    24	];
    25	
    26	const args = [mainEntry];
    27	if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
    28	
    29	const child = spawn(
    30	  join(repoRoot, "node_modules/.bin/electron"),
    31	  args,
    32	  {
    33	    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    34	    stdio: ["ignore", "pipe", "pipe"],
    35	  },
    36	);
    37	
    38	let stderr = "";
    39	child.stderr.on("data", (chunk) => {
    40	  stderr += String(chunk);
    41	});
    42	child.stdout.on("data", () => {});
    43	
    44	const SMOKE_DURATION_MS = 8000;
    45	
    46	setTimeout(() => {
    47	  child.kill("SIGTERM");
    48	}, SMOKE_DURATION_MS);
    49	
    50	child.on("exit", () => {
    51	  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
    52	  if (fatal.length > 0) {
    53	    console.error("Desktop smoke FAILED. Fatal stderr patterns:");
    54	    for (const pattern of fatal) console.error(`  ${pattern}`);
    55	    console.error("--- stderr ---");
    56	    console.error(stderr.slice(0, 4000));
    57	    process.exit(1);
    58	  }
    59	  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
    60	  process.exit(0);
    61	});
     1	import { defineConfig } from "electron-vite";
     2	
     3	export default defineConfig({
     4	  main: {
     5	    build: {
     6	      outDir: "dist/main",
     7	      lib: { entry: "src/main.ts" },
     8	    },
     9	  },
    10	  preload: {
    11	    build: {
    12	      outDir: "dist/preload",
    13	      // Sandboxed preloads must be CommonJS.
    14	      lib: { entry: "src/preload.ts", formats: ["cjs"] },
    15	    },
    16	  },
    17	  renderer: {
    18	    root: "src/renderer",
    19	    build: {
    20	      outDir: "dist/renderer",
    21	      rollupOptions: { input: "src/renderer/index.html" },
    22	    },
    23	  },
    24	});
     1	{
     2	  "extends": "../../tsconfig.base.json",
     3	  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "electron.vite.config.ts", "playwright.config.ts"]
     4	}
     1	{
     2	  "name": "dohc",
     3	  "private": true,
     4	  "type": "module",
     5	  "engines": {
     6	    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
     7	    "pnpm": "10.24.0"
     8	  },
     9	  "scripts": {
    10	    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    11	    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    12	    "dev:desktop": "pnpm --filter @dohc/desktop dev",
    13	    "build:desktop": "pnpm --filter @dohc/desktop build",
    14	    "test:desktop": "pnpm --filter @dohc/desktop test",
    15	    "test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
    16	    "smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs",
    17	    "dev:sync": "node scripts/dev-sync.mjs",
    18	    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    19	    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    20	    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    21	    "build": "pnpm -r --if-present build",
    22	    "start": "pnpm --filter @dohc/web --if-present run start",
    23	    "preview": "pnpm --filter @dohc/web --if-present run preview",
    24	    "reset:dev": "node scripts/reset-dev-data.mjs",
    25	    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    26	    "typecheck": "pnpm -r --if-present typecheck",
    27	    "test": "pnpm -r --if-present test",
    28	    "test:e2e": "playwright test",
    29	    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    30	    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    31	    "lint": "pnpm -r --if-present lint",
    32	    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    33	    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    34	    "check:self-host": "node scripts/check-self-host.mjs",
    35	    "check:debt": "node scripts/check-tech-debt.mjs"
    36	  },
    37	  "packageManager": "pnpm@10.24.0",
    38	  "devDependencies": {
    39	    "@playwright/test": "^1.60.0"
    40	  }
    41	}
     1	packages:
     2	  - "apps/*"
     3	  - "packages/*"
     4	  - "services/*"
     5	
     6	# pnpm 10 ignores dependency build scripts by default; Electron's binary
     7	# download runs in its postinstall, so it must be allowlisted explicitly.
     8	onlyBuiltDependencies:
     9	  - electron
    10	  - electron-winstaller
    11	  - esbuild

exec
/bin/bash -lc 'ls -l node_modules/playwright node_modules/@playwright/test apps/desktop/node_modules/playwright apps/desktop/node_modules/@playwright/test 2>&1 || true' in /home/ice/dev/dohc
 succeeded in 0ms:
ls: cannot access 'apps/desktop/node_modules/playwright': No such file or directory
ls: cannot access 'apps/desktop/node_modules/@playwright/test': No such file or directory
node_modules/@playwright/test:
total 60
-rw-r--r-- 31 ice ice 11601 Sep  2  2025 LICENSE
-rw-r--r-- 31 ice ice   254 Sep  2  2025 NOTICE
-rw-r--r--  3 ice ice 11270 May 27 03:50 README.md
-rwxr-xr-x  9 ice ice   707 Mar 24 17:22 cli.js
-rw-r--r-- 17 ice ice   679 Mar 24 17:22 index.d.ts
-rw-r--r--  9 ice ice   648 Mar 24 17:22 index.js
-rw-r--r-- 17 ice ice   679 Mar 24 17:22 index.mjs
-rw-r--r--  2 ice ice   754 May 27 03:50 package.json
-rw-r--r--  9 ice ice   650 Mar 24 17:22 reporter.d.ts
-rw-r--r-- 17 ice ice   645 Mar 24 17:22 reporter.js
-rw-r--r-- 17 ice ice   645 Mar 24 17:22 reporter.mjs

node_modules/playwright:
total 80
-rw-r--r-- 31 ice ice 11601 Sep  2  2025 LICENSE
-rw-r--r-- 31 ice ice   254 Sep  2  2025 NOTICE
-rw-r--r--  3 ice ice 11270 May 27 03:50 README.md
-rw-r--r--  2 ice ice   705 May 27 03:50 ThirdPartyNotices.txt
-rwxr-xr-x 12 ice ice   698 Sep  2  2025 cli.js
-rw-r--r-- 12 ice ice   636 Sep  2  2025 index.d.ts
-rw-r--r-- 12 ice ice   648 Sep  2  2025 index.js
-rw-r--r-- 12 ice ice   704 Sep  2  2025 index.mjs
-rw-r--r-- 12 ice ice   942 Sep  2  2025 jsx-runtime.js
-rw-r--r-- 12 ice ice   764 Sep  2  2025 jsx-runtime.mjs
drwxr-xr-x 11 ice ice  4096 May 27 03:50 lib
-rw-r--r--  2 ice ice  1559 May 27 03:50 package.json
-rw-r--r-- 12 ice ice   673 Sep  2  2025 test.d.ts
-rw-r--r-- 12 ice ice   806 Sep  2  2025 test.js
-rw-r--r--  2 ice ice  1400 May 27 03:50 test.mjs
drwxr-xr-x  2 ice ice  4096 May 27 03:50 types

exec
/bin/bash -lc 'pnpm ignored-builds 2>/dev/null || true' in /home/ice/dev/dohc
 succeeded in 545ms:
Automatically ignored builds during installation:
  None

exec
/bin/bash -lc 'ls -l node_modules/.bin/electron apps/desktop/node_modules/.bin/electron 2>&1 || true && head -20 node_modules/.bin/electron' in /home/ice/dev/dohc
 succeeded in 0ms:
ls: cannot access 'apps/desktop/node_modules/.bin/electron': No such file or directory
lrwxrwxrwx 1 ice ice 18 Jun 10 16:24 node_modules/.bin/electron -> ../electron/cli.js
#!/usr/bin/env node

const proc = require('child_process');

const electron = require('./');

const child = proc.spawn(electron, process.argv.slice(2), { stdio: 'inherit', windowsHide: false });
let childClosed = false;
child.on('close', function (code, signal) {
  childClosed = true;
  if (code === null) {
    console.error(electron, 'exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});

const handleTerminationSignal = function (signal) {
  process.on(signal, function signalHandler() {
    if (!childClosed) {

exec
/bin/bash -lc "sed -n '1,120p' node_modules/electron/cli.js" in /home/ice/dev/dohc
 succeeded in 0ms:
#!/usr/bin/env node

const proc = require('child_process');

const electron = require('./');

const child = proc.spawn(electron, process.argv.slice(2), { stdio: 'inherit', windowsHide: false });
let childClosed = false;
child.on('close', function (code, signal) {
  childClosed = true;
  if (code === null) {
    console.error(electron, 'exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});

const handleTerminationSignal = function (signal) {
  process.on(signal, function signalHandler() {
    if (!childClosed) {
      child.kill(signal);
    }
  });
};

handleTerminationSignal('SIGINT');
handleTerminationSignal('SIGTERM');
handleTerminationSignal('SIGUSR2');

exec
/bin/bash -lc "node - <<'NODE'
const p='file:///C:/app/dist/renderer/';
for (const u of ['file:///C:/app/dist/renderer%5C..%5CWindows/system32','file:///C:/app/dist/renderer/%5C..%5CWindows/system32','file:///C:/app/dist/renderer/..%5C..%5CWindows/system32']) { const url=new URL(u); console.log(url.href, url.href.startsWith(p), url.pathname) }
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
file:///C:/app/dist/renderer%5C..%5CWindows/system32 false /C:/app/dist/renderer%5C..%5CWindows/system32
file:///C:/app/dist/renderer/%5C..%5CWindows/system32 true /C:/app/dist/renderer/%5C..%5CWindows/system32
file:///C:/app/dist/renderer/..%5C..%5CWindows/system32 true /C:/app/dist/renderer/..%5C..%5CWindows/system32

exec
/bin/bash -lc "node - <<'NODE'
const {fileURLToPath}=require('node:url');
for (const u of ['file:///C:/app/dist/renderer/%5C..%5CWindows/system32','file:///C:/app/dist/renderer/..%5C..%5CWindows/system32','file:///app/dist/renderer/%5C..%5Cetc/passwd','file:///app/dist/renderer/..%5C..%5Cetc/passwd']) { try { console.log(u, '=>', fileURLToPath(u)); } catch (e) { console.log(u, 'ERR', e.message); } }
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
file:///C:/app/dist/renderer/%5C..%5CWindows/system32 => /C:/app/dist/renderer/\..\Windows/system32
file:///C:/app/dist/renderer/..%5C..%5CWindows/system32 => /C:/app/dist/renderer/..\..\Windows/system32
file:///app/dist/renderer/%5C..%5Cetc/passwd => /app/dist/renderer/\..\etc/passwd
file:///app/dist/renderer/..%5C..%5Cetc/passwd => /app/dist/renderer/..\..\etc/passwd

exec
/bin/bash -lc "node -e \"for (const u of ['file:///C:/app/dist/renderer/..\\\\..\\\\Windows/system32', 'file:///app/dist/renderer/..\\\\..\\\\etc/passwd']) { const url = new URL(u); console.log(url.href, url.pathname); }\"" in /home/ice/dev/dohc
 succeeded in 0ms:
file:///C:/app/dist/renderer/....Windows/system32 /C:/app/dist/renderer/....Windows/system32
file:///app/dist/renderer/....etc/passwd /app/dist/renderer/....etc/passwd

exec
/bin/bash -lc "node - <<'NODE'
const {fileURLToPath}=require('node:url');
for (const u of ['file:///app/dist/renderer/%2Fetc/passwd','file:///app/dist/renderer/%5Cetc/passwd']) { try { console.log(u, '=>', fileURLToPath(u)); } catch(e) { console.log(u,'ERR',e.code,e.message); } }
NODE" in /home/ice/dev/dohc
 succeeded in 113ms:
file:///app/dist/renderer/%2Fetc/passwd ERR ERR_INVALID_FILE_URL_PATH File URL path must not include encoded / characters
file:///app/dist/renderer/%5Cetc/passwd => /app/dist/renderer/\etc/passwd

exec
/bin/bash -lc "node - <<'NODE'
const {fileURLToPath}=require('node:url');
for (const u of ['file:///C:/app/dist/renderer/%5C..%5CWindows/system32','file:///C:/app/dist/renderer/..%5C..%5CWindows/system32']) { for (const windows of [true,false]) { try { console.log({u,windows,path:fileURLToPath(u,{windows})}); } catch(e) { console.log({u,windows,code:e.code,message:e.message}); } } }
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
{
  u: 'file:///C:/app/dist/renderer/%5C..%5CWindows/system32',
  windows: true,
  code: 'ERR_INVALID_FILE_URL_PATH',
  message: 'File URL path must not include encoded \\ or / characters'
}
{
  u: 'file:///C:/app/dist/renderer/%5C..%5CWindows/system32',
  windows: false,
  path: '/C:/app/dist/renderer/\\..\\Windows/system32'
}
{
  u: 'file:///C:/app/dist/renderer/..%5C..%5CWindows/system32',
  windows: true,
  code: 'ERR_INVALID_FILE_URL_PATH',
  message: 'File URL path must not include encoded \\ or / characters'
}
{
  u: 'file:///C:/app/dist/renderer/..%5C..%5CWindows/system32',
  windows: false,
  path: '/C:/app/dist/renderer/..\\..\\Windows/system32'
}

exec
/bin/bash -lc 'grep -R "setPermissionRequestHandler" -n node_modules/electron | head -20' in /home/ice/dev/dohc
 succeeded in 214ms:
grep: node_modules/electron/dist/electron: binary file matches
grep: node_modules/electron/dist/resources/default_app.asar: binary file matches
node_modules/electron/electron.d.ts:13187:     * it.  Please note that you must also implement `setPermissionRequestHandler` to
node_modules/electron/electron.d.ts:13200:     * `setPermissionRequestHandler(null)`.  Please note that you must also implement
node_modules/electron/electron.d.ts:13204:    setPermissionRequestHandler(handler: ((webContents: WebContents, permission: 'clipboard-read' | 'clipboard-sanitized-write' | 'display-capture' | 'fullscreen' | 'geolocation' | 'idle-detection' | 'media' | 'mediaKeySystem' | 'midi' | 'midiSysex' | 'notifications' | 'pointerLock' | 'keyboardLock' | 'openExternal' | 'speaker-selection' | 'storage-access' | 'top-level-storage-access' | 'window-management' | 'unknown' | 'fileSystem', callback: (permissionGranted: boolean) => void, details: (PermissionRequest) | (FilesystemPermissionRequest) | (MediaAccessPermissionRequest) | (OpenExternalPermissionRequest)) => void) | (null)): void;

exec
/bin/bash -lc "sed -n '13160,13220p' node_modules/electron/electron.d.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
     */
    setDevicePermissionHandler(handler: ((details: DevicePermissionHandlerHandlerDetails) => boolean) | (null)): void;
    /**
     * This handler will be called when web content requests access to display media
     * via the `navigator.mediaDevices.getDisplayMedia` API. Use the desktopCapturer
     * API to choose which stream(s) to grant access to.
     *
     * `useSystemPicker` allows an application to use the system picker instead of
     * providing a specific video source from `getSources`. This option is
     * experimental, and currently available for MacOS 15+ only. If the system picker
     * is available and `useSystemPicker` is set to `true`, the handler will not be
     * invoked.
     *
     * Passing a WebFrameMain object as a video or audio stream will capture the video
     * or audio stream from that frame.
     *
     * Passing `null` instead of a function resets the handler to its default state.
     */
    setDisplayMediaRequestHandler(handler: ((request: DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Streams) => void) => void) | (null), opts?: DisplayMediaRequestHandlerOpts): void;
    /**
     * Sets download saving directory. By default, the download directory will be the
     * `Downloads` under the respective app folder.
     */
    setDownloadPath(path: string): void;
    /**
     * Sets the handler which can be used to respond to permission checks for the
     * `session`. Returning `true` will allow the permission and `false` will reject
     * it.  Please note that you must also implement `setPermissionRequestHandler` to
     * get complete permission handling. Most web APIs do a permission check and then
     * make a permission request if the check is denied. To clear the handler, call
     * `setPermissionCheckHandler(null)`.
     *
     * > [!NOTE] `isMainFrame` will always be `false` for a `fileSystem` request as a
     * result of Chromium limitations.
     */
    setPermissionCheckHandler(handler: ((webContents: (WebContents) | (null), permission: 'clipboard-read' | 'clipboard-sanitized-write' | 'geolocation' | 'fullscreen' | 'hid' | 'idle-detection' | 'media' | 'mediaKeySystem' | 'midi' | 'midiSysex' | 'notifications' | 'openExternal' | 'pointerLock' | 'serial' | 'storage-access' | 'top-level-storage-access' | 'usb' | 'deprecated-sync-clipboard-read' | 'fileSystem', requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails) => boolean) | (null)): void;
    /**
     * Sets the handler which can be used to respond to permission requests for the
     * `session`. Calling `callback(true)` will allow the permission and
     * `callback(false)` will reject it. To clear the handler, call
     * `setPermissionRequestHandler(null)`.  Please note that you must also implement
     * `setPermissionCheckHandler` to get complete permission handling. Most web APIs
     * do a permission check and then make a permission request if the check is denied.
     */
    setPermissionRequestHandler(handler: ((webContents: WebContents, permission: 'clipboard-read' | 'clipboard-sanitized-write' | 'display-capture' | 'fullscreen' | 'geolocation' | 'idle-detection' | 'media' | 'mediaKeySystem' | 'midi' | 'midiSysex' | 'notifications' | 'pointerLock' | 'keyboardLock' | 'openExternal' | 'speaker-selection' | 'storage-access' | 'top-level-storage-access' | 'window-management' | 'unknown' | 'fileSystem', callback: (permissionGranted: boolean) => void, details: (PermissionRequest) | (FilesystemPermissionRequest) | (MediaAccessPermissionRequest) | (OpenExternalPermissionRequest)) => void) | (null)): void;
    /**
     * Adds scripts that will be executed on ALL web contents that are associated with
     * this session just before normal `preload` scripts run.
     *
     * **Deprecated:** Use the new `ses.registerPreloadScript` API.
     *
     * @deprecated
     */
    setPreloads(preloads: string[]): void;
    /**
     * Resolves when the proxy setting process is complete.
     *
     * Sets the proxy settings.
     *
     * You may need `ses.closeAllConnections` to close currently in flight connections
     * to prevent pooled sockets using previous proxy from being reused by future

exec
/bin/bash -lc "node - <<'NODE'
for (const u of ['http://localhost:5173\\\\@evil.com/x','http://localhost:5173%5c@evil.com/x','http://localhost:5173/%5c@evil.com']) { try { const url = new URL(u); console.log(u, '=>', url.href, url.origin); } catch(e) { console.log('ERR', u, e.message); } }
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
http://localhost:5173\@evil.com/x => http://localhost:5173/@evil.com/x http://localhost:5173
http://localhost:5173%5c@evil.com/x => http://localhost:5173%5c@evil.com/x http://evil.com
http://localhost:5173/%5c@evil.com => http://localhost:5173/%5c@evil.com http://localhost:5173

exec
/bin/bash -lc "grep -n \"apps/desktop\" -A45 pnpm-lock.yaml | sed -n '1,80p' && grep -n \""'^  '"\\.:\" -A15 pnpm-lock.yaml | sed -n '1,60p'" in /home/ice/dev/dohc
 succeeded in 0ms:
211:  apps/desktop:
212-    dependencies:
213-      electron-updater:
214-        specifier: ^6.8.9
215-        version: 6.8.9
216-      zod:
217-        specifier: ^3.25.76
218-        version: 3.25.76
219-    devDependencies:
220-      '@electron/fuses':
221-        specifier: ^2.1.2
222-        version: 2.1.2
223-      '@types/node':
224-        specifier: ^22.19.19
225-        version: 22.19.19
226-      electron:
227-        specifier: ^42.4.0
228-        version: 42.4.0
229-      electron-builder:
230-        specifier: ^26.15.2
231-        version: 26.15.2(electron-builder-squirrel-windows@26.15.2)
232-      electron-vite:
233-        specifier: ^5.0.0
234-        version: 5.0.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
235-      typescript:
236-        specifier: ^5.9.3
237-        version: 5.9.3
238-      vite:
239-        specifier: ^8.0.14
240-        version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
241-      vitest:
242-        specifier: ^2.1.9
243-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
244-
245-  packages/brand:
246-    devDependencies:
247-      '@types/react':
248-        specifier: ^19.2.14
249-        version: 19.2.15
250-      react:
251-        specifier: ^19.2.5
252-        version: 19.2.6
253-
254-  packages/config: {}
255-
256-  packages/workspace-contracts:
9:  .:
10-    devDependencies:
11-      '@playwright/test':
12-        specifier: ^1.60.0
13-        version: 1.60.0
14-
15-  apps/app:
16-    dependencies:
17-      '@ai-sdk/anthropic':
18-        specifier: 3.0.77
19-        version: 3.0.77(zod@3.25.76)
20-      '@ai-sdk/openai':
21-        specifier: 3.0.67
22-        version: 3.0.67(zod@3.25.76)
23-      '@ai-sdk/provider':
24-        specifier: 3.0.10

exec
/bin/bash -lc 'cat .gitignore' in /home/ice/dev/dohc
 succeeded in 0ms:
node_modules/
.output/
dist/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
.DS_Store
.tanstack/tmp/
.gstack/tmp/
.dohc-dev/

exec
/bin/bash -lc 'git show 7781d02''^:package.json | sed -n '"'1,80p' && git show 7781d02"'^:pnpm-lock.yaml | grep -n "''^  '"\\.:\" -A10 | sed -n '1,30p'" in /home/ice/dev/dohc
 succeeded in 0ms:
{
  "name": "dohc",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
    "pnpm": "10.24.0"
  },
  "scripts": {
    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    "dev:sync": "node scripts/dev-sync.mjs",
    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    "build": "pnpm -r --if-present build",
    "start": "pnpm --filter @dohc/web --if-present run start",
    "preview": "pnpm --filter @dohc/web --if-present run preview",
    "reset:dev": "node scripts/reset-dev-data.mjs",
    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:e2e": "playwright test",
    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    "lint": "pnpm -r --if-present lint",
    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    "check:self-host": "node scripts/check-self-host.mjs",
    "check:debt": "node scripts/check-tech-debt.mjs"
  },
  "packageManager": "pnpm@10.24.0",
  "devDependencies": {
    "@playwright/test": "^1.60.0"
  }
}
9:  .:
10-    devDependencies:
11-      '@playwright/test':
12-        specifier: ^1.60.0
13-        version: 1.60.0
14-
15-  apps/app:
16-    dependencies:
17-      '@ai-sdk/anthropic':
18-        specifier: 3.0.77
19-        version: 3.0.77(zod@3.25.76)

exec
/bin/bash -lc "find apps packages services -maxdepth 2 -name package.json -print | xargs -n1 node -e \"const fs=require('fs'); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p)); if(j.scripts?.lint) console.log(p,j.scripts.lint)\"" in /home/ice/dev/dohc
 succeeded in 385ms:
apps/app/package.json tsc --noEmit
services/hocuspocus/package.json tsc --noEmit -p tsconfig.json

codex
The scaffold mostly builds a secure Electron baseline, but the dev-server environment hook can cause built runs to trust and load unintended content, and the smoke test can pass despite early app failure. The generated artifacts issue is lower severity but should also be cleaned up.

Full review comments:

- [P2] Gate dev-server loading to explicit dev runs — /home/ice/dev/dohc/apps/desktop/src/window/createMainWindow.ts:15-18
  When the app is launched with `ELECTRON_RENDERER_URL` in its environment, this branch trusts that origin for IPC, and the `loadURL` branch below loads it instead of the packaged renderer. In built smoke/E2E runs or a packaged app started from a contaminated environment, arbitrary remote/dev content can receive the desktop bridge; only honor this variable in an explicit electron-vite dev mode and clear it for built launches.

- [P2] Deny renderer permission requests by default — /home/ice/dev/dohc/apps/desktop/src/window/createMainWindow.ts:28-35
  When any renderer code in this window requests Chromium permissions such as media, geolocation, notifications, or display capture, Electron's default session behavior is permissive unless request/check handlers are installed. Since this scaffold treats the renderer as untrusted and will soon load workspace content, add deny-by-default permission handlers before loading the page so an XSS or dev-server page cannot silently gain OS/browser capabilities.

- [P2] Fail the smoke test on early app exits — /home/ice/dev/dohc/apps/desktop/scripts/smoke-test.mjs:50-60
  If Electron exits before the 8s timer with a non-zero status or without matching one of these stderr regexes, this handler still prints a pass. That can green-light broken launches such as a failed display startup, an app that quits before opening a window, or a second-instance-lock exit; track whether the timeout fired and fail unexpected early exits/statuses.

- [P3] Ignore generated desktop test artifacts — /home/ice/dev/dohc/apps/desktop/e2e/desktopLaunch.spec.ts:22-26
  This test writes screenshots and performance JSON under `test-results`, but that directory is not ignored by the repo, so every desktop E2E run leaves untracked files in the worktree. Either add these artifacts to `.gitignore` or write them under Playwright's managed output directory to keep normal test runs clean.
The scaffold mostly builds a secure Electron baseline, but the dev-server environment hook can cause built runs to trust and load unintended content, and the smoke test can pass despite early app failure. The generated artifacts issue is lower severity but should also be cleaned up.

Full review comments:

- [P2] Gate dev-server loading to explicit dev runs — /home/ice/dev/dohc/apps/desktop/src/window/createMainWindow.ts:15-18
  When the app is launched with `ELECTRON_RENDERER_URL` in its environment, this branch trusts that origin for IPC, and the `loadURL` branch below loads it instead of the packaged renderer. In built smoke/E2E runs or a packaged app started from a contaminated environment, arbitrary remote/dev content can receive the desktop bridge; only honor this variable in an explicit electron-vite dev mode and clear it for built launches.

- [P2] Deny renderer permission requests by default — /home/ice/dev/dohc/apps/desktop/src/window/createMainWindow.ts:28-35
  When any renderer code in this window requests Chromium permissions such as media, geolocation, notifications, or display capture, Electron's default session behavior is permissive unless request/check handlers are installed. Since this scaffold treats the renderer as untrusted and will soon load workspace content, add deny-by-default permission handlers before loading the page so an XSS or dev-server page cannot silently gain OS/browser capabilities.

- [P2] Fail the smoke test on early app exits — /home/ice/dev/dohc/apps/desktop/scripts/smoke-test.mjs:50-60
  If Electron exits before the 8s timer with a non-zero status or without matching one of these stderr regexes, this handler still prints a pass. That can green-light broken launches such as a failed display startup, an app that quits before opening a window, or a second-instance-lock exit; track whether the timeout fired and fail unexpected early exits/statuses.

- [P3] Ignore generated desktop test artifacts — /home/ice/dev/dohc/apps/desktop/e2e/desktopLaunch.spec.ts:22-26
  This test writes screenshots and performance JSON under `test-results`, but that directory is not ignored by the repo, so every desktop E2E run leaves untracked files in the worktree. Either add these artifacts to `.gitignore` or write them under Playwright's managed output directory to keep normal test runs clean.
Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb0b6-a0ca-7d70-9d9f-b127e86864e5
--------
user
Security-focused review of commit 7781d02 in this repo (use git show 7781d02). This is the Electron scaffold for dohc desktop (main/preload/IPC/renderer). Focus specifically on: (1) IPC boundary — sender validation, channel exposure, anything the renderer could abuse; (2) preload bridge surface — any path to Node or Electron internals; (3) navigation/window.open policy — bypass vectors incl. redirects, iframes, about:blank, javascript: URLs; (4) the test-only bridge gating; (5) over-engineering, orphaned/unreachable code, and simplification opportunities. Output numbered findings with file:line and severity; if an area is solid, say so in one line.
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
codex
I’ll inspect the target commit diff first, then read the Electron entry points around the changed lines so the review is grounded in the actual IPC and navigation behavior.
exec
/bin/bash -lc 'git show --stat --oneline --decorate --find-renames 7781d02 && git show --format=fuller --find-renames --find-copies --stat 7781d02' in /home/ice/dev/dohc
 succeeded in 0ms:
7781d02 (HEAD -> claude/desktop-local-first-cloud-sync) phase2: Scaffold secure Electron desktop app
 apps/desktop/e2e/desktopLaunch.spec.ts             |   47 +
 apps/desktop/electron.vite.config.ts               |   24 +
 apps/desktop/package.json                          |   27 +
 apps/desktop/playwright.config.ts                  |   13 +
 apps/desktop/scripts/smoke-test.mjs                |   61 +
 apps/desktop/src/ipc/bridgeContract.ts             |   38 +
 apps/desktop/src/ipc/channels.ts                   |    9 +
 apps/desktop/src/main.ts                           |   76 +
 apps/desktop/src/performance/launchMarks.ts        |   24 +
 apps/desktop/src/preload.ts                        |   21 +
 apps/desktop/src/renderer/index.html               |   37 +
 apps/desktop/src/renderer/main.ts                  |   33 +
 apps/desktop/src/security/electronSecurity.test.ts |   84 +
 apps/desktop/src/security/electronSecurity.ts      |   78 +
 apps/desktop/src/window/createMainWindow.ts        |   60 +
 apps/desktop/tsconfig.json                         |    4 +
 apps/desktop/vitest.config.ts                      |    8 +
 ...desktop-local-first-cloud-sync.execution-log.md |   37 +-
 package.json                                       |    5 +
 pnpm-lock.yaml                                     | 2502 +++++++++++++++++++-
 pnpm-workspace.yaml                                |    7 +
 21 files changed, 3132 insertions(+), 63 deletions(-)
commit 7781d02bcdae6a121429ddc3a6ad70e6dd574cb9
Author:     Ice de Vera <iestyndevera@gmail.com>
AuthorDate: Wed Jun 10 16:36:26 2026 +0800
Commit:     Ice de Vera <iestyndevera@gmail.com>
CommitDate: Wed Jun 10 16:36:26 2026 +0800

    phase2: Scaffold secure Electron desktop app
    
    electron-vite scaffold with strict security: contextIsolation+sandbox,
    no nodeIntegration, exact-origin navigation policy (no prefix-match
    bypass), universal window.open denial with http(s) shell routing,
    sender-validated zod-parsed IPC, narrow contextBridge surface, launch
    performance marks from day one (315ms first paint), dedicated desktop
    Playwright config, 8s fatal-stderr smoke. Verifiers probed the runtime
    bridge surface and confirmed no Node reach.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

 apps/desktop/e2e/desktopLaunch.spec.ts             |   47 +
 apps/desktop/electron.vite.config.ts               |   24 +
 apps/desktop/package.json                          |   27 +
 apps/desktop/playwright.config.ts                  |   13 +
 apps/desktop/scripts/smoke-test.mjs                |   61 +
 apps/desktop/src/ipc/bridgeContract.ts             |   38 +
 apps/desktop/src/ipc/channels.ts                   |    9 +
 apps/desktop/src/main.ts                           |   76 +
 apps/desktop/src/performance/launchMarks.ts        |   24 +
 apps/desktop/src/preload.ts                        |   21 +
 apps/desktop/src/renderer/index.html               |   37 +
 apps/desktop/src/renderer/main.ts                  |   33 +
 apps/desktop/src/security/electronSecurity.test.ts |   84 +
 apps/desktop/src/security/electronSecurity.ts      |   78 +
 apps/desktop/src/window/createMainWindow.ts        |   60 +
 apps/desktop/tsconfig.json                         |    4 +
 apps/desktop/vitest.config.ts                      |    8 +
 ...desktop-local-first-cloud-sync.execution-log.md |   37 +-
 package.json                                       |    5 +
 pnpm-lock.yaml                                     | 2502 +++++++++++++++++++-
 pnpm-workspace.yaml                                |    7 +
 21 files changed, 3132 insertions(+), 63 deletions(-)

codex
The commit is the desktop scaffold itself. I’m going to read the main, preload, IPC contract, window policy, and security tests as commit snapshots with line numbers so findings can point at the introduced code, not the working tree by accident.
exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/main.ts | nl -ba' in /home/ice/dev/dohc
exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/security/electronSecurity.ts | nl -ba' in /home/ice/dev/dohc
exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/preload.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { isAbsolute } from "node:path";
     2	
     3	export interface MainWindowWebPreferences {
     4	  preload: string;
     5	  nodeIntegration: false;
     6	  contextIsolation: true;
     7	  sandbox: true;
     8	}
     9	
    10	export function createMainWindowWebPreferences(
    11	  preloadPath: string,
    12	): MainWindowWebPreferences {
    13	  if (!isAbsolute(preloadPath)) {
    14	    throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
    15	  }
    16	  return {
    17	    preload: preloadPath,
    18	    nodeIntegration: false,
    19	    contextIsolation: true,
    20	    sandbox: true,
    21	  };
    22	}
    23	
    24	export interface NavigationDecision {
    25	  action: "allow" | "deny";
    26	}
    27	
    28	export interface NavigationPolicy {
    29	  // Exact URL origins (scheme://host:port), compared with ===, never prefix:
    30	  // startsWith would allow http://localhost:5173.evil.com.
    31	  httpOrigins: string[];
    32	  // The packaged renderer bundle directory as a file:// href prefix; a bare
    33	  // "file://" allowance would open every local file to navigation.
    34	  fileUrlPrefix: string | null;
    35	}
    36	
    37	// The renderer may only navigate within the app itself: the packaged
    38	// bundle directory or the dev server's exact origin. Everything else,
    39	// including unparseable URLs, is denied.
    40	export function decideNavigation(
    41	  targetUrl: string,
    42	  policy: NavigationPolicy,
    43	): NavigationDecision {
    44	  try {
    45	    const url = new URL(targetUrl);
    46	    if (url.protocol === "http:" || url.protocol === "https:") {
    47	      return {
    48	        action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny",
    49	      };
    50	    }
    51	    if (url.protocol === "file:" && policy.fileUrlPrefix) {
    52	      return {
    53	        action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny",
    54	      };
    55	    }
    56	  } catch {
    57	    // fall through to deny
    58	  }
    59	  return { action: "deny" };
    60	}
    61	
    62	export interface WindowOpenDecision {
    63	  action: "deny";
    64	  openExternal: boolean;
    65	}
    66	
    67	// window.open never creates a BrowserWindow. http(s) targets are handed to
    68	// the OS browser; every other scheme is dropped entirely.
    69	export function decideWindowOpen(targetUrl: string): WindowOpenDecision {
    70	  let openExternal = false;
    71	  try {
    72	    const protocol = new URL(targetUrl).protocol;
    73	    openExternal = protocol === "https:" || protocol === "http:";
    74	  } catch {
    75	    openExternal = false;
    76	  }
    77	  return { action: "deny", openExternal };
    78	}

 succeeded in 0ms:
     1	import { contextBridge, ipcRenderer } from "electron";
     2	import { CHANNELS } from "./ipc/channels";
     3	
     4	// The entire bridge surface. Narrow on purpose: the renderer gets named,
     5	// typed operations — never raw ipcRenderer, never Node.
     6	contextBridge.exposeInMainWorld("dohcDesktop", {
     7	  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
     8	  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
     9	  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
    10	});
    11	
    12	// One-shot paint signal for launch instrumentation (no data, no response).
    13	contextBridge.exposeInMainWorld("dohcDesktopInternal", {
    14	  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
    15	});
    16	
    17	if (process.env.DOHC_DESKTOP_TEST === "1") {
    18	  contextBridge.exposeInMainWorld("dohcDesktopTest", {
    19	    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
    20	  });
    21	}

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/window/createMainWindow.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { BrowserWindow, shell } from "electron";
     2	import { join } from "node:path";
     3	import { pathToFileURL } from "node:url";
     4	import {
     5	  createMainWindowWebPreferences,
     6	  decideNavigation,
     7	  decideWindowOpen,
     8	  type NavigationPolicy,
     9	} from "../security/electronSecurity";
    10	
    11	// Warm paper — set before first paint so launch never flashes white.
    12	const BACKGROUND_COLOR = "#faf7f2";
    13	
    14	export function navigationPolicy(): NavigationPolicy {
    15	  const devServer = process.env.ELECTRON_RENDERER_URL;
    16	  if (devServer) {
    17	    // Dev: exact dev-server origin only; no file navigation at all.
    18	    return { httpOrigins: [new URL(devServer).origin], fileUrlPrefix: null };
    19	  }
    20	  // Prod: only the packaged renderer bundle directory.
    21	  const rendererDir = join(import.meta.dirname, "../renderer/");
    22	  return { httpOrigins: [], fileUrlPrefix: pathToFileURL(rendererDir).href };
    23	}
    24	
    25	export function createMainWindow(): BrowserWindow {
    26	  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");
    27	
    28	  const window = new BrowserWindow({
    29	    show: false,
    30	    width: 1280,
    31	    height: 800,
    32	    minWidth: 840,
    33	    minHeight: 620,
    34	    backgroundColor: BACKGROUND_COLOR,
    35	    webPreferences: createMainWindowWebPreferences(preloadPath),
    36	  });
    37	
    38	  window.webContents.setWindowOpenHandler(({ url }) => {
    39	    const decision = decideWindowOpen(url);
    40	    if (decision.openExternal) void shell.openExternal(url);
    41	    return { action: "deny" };
    42	  });
    43	
    44	  window.webContents.on("will-navigate", (event, url) => {
    45	    if (decideNavigation(url, navigationPolicy()).action === "deny") {
    46	      event.preventDefault();
    47	    }
    48	  });
    49	
    50	  window.once("ready-to-show", () => window.show());
    51	
    52	  const devServer = process.env.ELECTRON_RENDERER_URL;
    53	  if (devServer) {
    54	    void window.loadURL(devServer);
    55	  } else {
    56	    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
    57	  }
    58	
    59	  return window;
    60	}

 succeeded in 101ms:
exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/ipc/bridgeContract.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { z } from "zod";
     2	
     3	// Typed contract for everything the preload bridge exposes. Main-process
     4	// handlers validate results against these before returning them. Payload
     5	// validation starts with the first payload-accepting channel (Phase 4).
     6	// The renderer never sees raw Electron APIs.
     7	
     8	export const VersionResult = z.string().min(1);
     9	export type VersionResult = z.infer<typeof VersionResult>;
    10	
    11	export const PickWorkspaceRootResult = z.string().min(1).nullable();
    12	export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
    13	
    14	// The real registry arrives in Phase 4; the contract starts narrow.
    15	export const WorkspaceRegistryResult = z.object({
    16	  workspaces: z.array(
    17	    z.object({
    18	      workspaceId: z.string().min(1),
    19	      rootPath: z.string().min(1),
    20	      kind: z.enum(["personal", "shared", "cloud-only"]),
    21	      mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
    22	    }),
    23	  ),
    24	});
    25	export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
    26	
    27	export const LaunchMarksResult = z.object({
    28	  appReadyMs: z.number().positive(),
    29	  firstWindowMs: z.number().positive(),
    30	  firstPaintMs: z.number().positive(),
    31	});
    32	export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;
    33	
    34	export interface DohcDesktopBridge {
    35	  getVersion(): Promise<VersionResult>;
    36	  pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
    37	  getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
    38	}

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/ipc/channels.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	export const CHANNELS = {
     2	  getVersion: "desktop:get-version",
     3	  pickWorkspaceRoot: "desktop:pick-workspace-root",
     4	  getWorkspaceRegistry: "desktop:get-workspace-registry",
     5	  firstPaint: "desktop:first-paint",
     6	  getLaunchMarks: "desktop:test:get-launch-marks",
     7	} as const;
     8	
     9	export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/security/electronSecurity.test.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { describe, expect, it } from "vitest";
     2	import {
     3	  createMainWindowWebPreferences,
     4	  decideNavigation,
     5	  decideWindowOpen,
     6	} from "./electronSecurity";
     7	
     8	describe("main window web preferences", () => {
     9	  it("locks down the renderer: no node, isolated context, sandboxed", () => {
    10	    const prefs = createMainWindowWebPreferences("/abs/path/preload.js");
    11	    expect(prefs.nodeIntegration).toBe(false);
    12	    expect(prefs.contextIsolation).toBe(true);
    13	    expect(prefs.sandbox).toBe(true);
    14	  });
    15	
    16	  it("requires an absolute preload path", () => {
    17	    expect(() => createMainWindowWebPreferences("relative/preload.js")).toThrow(
    18	      /absolute/i,
    19	    );
    20	  });
    21	});
    22	
    23	describe("navigation policy", () => {
    24	  const policy = {
    25	    httpOrigins: ["http://localhost:5173"],
    26	    fileUrlPrefix: "file:///app/dist/renderer/",
    27	  };
    28	
    29	  it("allows in-app navigation", () => {
    30	    expect(
    31	      decideNavigation("file:///app/dist/renderer/index.html", policy),
    32	    ).toEqual({ action: "allow" });
    33	    expect(
    34	      decideNavigation("http://localhost:5173/route", policy),
    35	    ).toEqual({ action: "allow" });
    36	  });
    37	
    38	  it("denies navigation to arbitrary external URLs", () => {
    39	    expect(decideNavigation("https://evil.example.com", policy).action).toBe(
    40	      "deny",
    41	    );
    42	  });
    43	
    44	  it("denies origin prefix-spoofing (localhost:5173.evil.com)", () => {
    45	    expect(
    46	      decideNavigation("http://localhost:5173.evil.com/x", policy).action,
    47	    ).toBe("deny");
    48	  });
    49	
    50	  it("denies local files outside the renderer bundle", () => {
    51	    expect(decideNavigation("file:///etc/passwd", policy).action).toBe("deny");
    52	  });
    53	
    54	  it("denies file navigation entirely when no bundle prefix is set (dev)", () => {
    55	    expect(
    56	      decideNavigation("file:///app/dist/renderer/index.html", {
    57	        httpOrigins: ["http://localhost:5173"],
    58	        fileUrlPrefix: null,
    59	      }).action,
    60	    ).toBe("deny");
    61	  });
    62	
    63	  it("denies unparseable URLs", () => {
    64	    expect(decideNavigation("not a url", policy).action).toBe("deny");
    65	  });
    66	});
    67	
    68	describe("window.open policy", () => {
    69	  it("denies all window.open targets", () => {
    70	    expect(decideWindowOpen("https://dohc.ai/docs").action).toBe("deny");
    71	    expect(decideWindowOpen("file:///etc/passwd").action).toBe("deny");
    72	  });
    73	
    74	  it("routes http and https targets through the external shell handler", () => {
    75	    expect(decideWindowOpen("https://dohc.ai/docs").openExternal).toBe(true);
    76	    expect(decideWindowOpen("http://dohc.ai/docs").openExternal).toBe(true);
    77	    expect(decideWindowOpen("http://dohc.ai/docs").action).toBe("deny");
    78	  });
    79	
    80	  it("never shells out non-http(s) schemes", () => {
    81	    expect(decideWindowOpen("file:///etc/passwd").openExternal).toBe(false);
    82	    expect(decideWindowOpen("smb://share/x").openExternal).toBe(false);
    83	  });
    84	});

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/renderer/main.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	// Minimal first-run shell. Phase 3 replaces this with the real desktop
     2	// workspace shell (driven by the component reuse map + design review loop).
     3	
     4	declare global {
     5	  interface Window {
     6	    dohcDesktopInternal?: { firstPaint(): void };
     7	  }
     8	}
     9	
    10	const root = document.getElementById("root");
    11	if (root) {
    12	  const main = document.createElement("main");
    13	  main.style.cssText =
    14	    "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;";
    15	
    16	  const heading = document.createElement("h1");
    17	  heading.textContent = "dohc";
    18	  heading.style.cssText =
    19	    "font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;";
    20	
    21	  const subtitle = document.createElement("p");
    22	  subtitle.textContent = "Your workspace is a folder.";
    23	  subtitle.style.cssText = "font-size:14px;opacity:0.65;margin:0;";
    24	
    25	  main.append(heading, subtitle);
    26	  root.append(main);
    27	}
    28	
    29	requestAnimationFrame(() => {
    30	  window.dohcDesktopInternal?.firstPaint();
    31	});
    32	
    33	export {};

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/e2e/desktopLaunch.spec.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { expect, test } from "@playwright/test";
     2	import { mkdir, writeFile } from "node:fs/promises";
     3	import { _electron as electron } from "playwright";
     4	
     5	const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
     6	const PERF_FILE = "test-results/performance/desktop-performance.json";
     7	
     8	test("launches dohc desktop and renders the first-run shell", async () => {
     9	  const launchArgs = ["apps/desktop/dist/main/main.js"];
    10	  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
    11	    launchArgs.push("--no-sandbox");
    12	  }
    13	  const app = await electron.launch({
    14	    args: launchArgs,
    15	    cwd: process.cwd(),
    16	    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    17	  });
    18	
    19	  const page = await app.firstWindow();
    20	  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
    21	
    22	  await mkdir(SCREENSHOT_DIR, { recursive: true });
    23	  await page.setViewportSize({ width: 1280, height: 800 });
    24	  await page.screenshot({
    25	    path: `${SCREENSHOT_DIR}/first-run--1280x800--light.png`,
    26	  });
    27	
    28	  // Launch performance marks flow through the test-only bridge from day one;
    29	  // Phase 16 ratchets these numbers into a hard gate.
    30	  const marks = await page.evaluate(() =>
    31	    (window as never as {
    32	      dohcDesktopTest?: { getLaunchMarks(): Promise<Record<string, number>> };
    33	    }).dohcDesktopTest?.getLaunchMarks(),
    34	  );
    35	  expect(marks).toBeTruthy();
    36	  expect(marks?.appReadyMs).toBeGreaterThan(0);
    37	  expect(marks?.firstWindowMs).toBeGreaterThan(0);
    38	  expect(marks?.firstPaintMs).toBeGreaterThan(0);
    39	
    40	  await mkdir("test-results/performance", { recursive: true });
    41	  await writeFile(
    42	    PERF_FILE,
    43	    JSON.stringify({ phase: 2, launch: marks }, null, 2),
    44	  );
    45	
    46	  await app.close();
    47	});

codex
So far the scaffold does the expected baseline things: context isolation, sandbox, no raw `ipcRenderer`, explicit IPC handler names, and exact-origin checks. I’m checking the HTML/config side next because CSP, dev-server URL handling, and build output shape affect whether those policies hold at runtime.
exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/renderer/index.html | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	<!doctype html>
     2	<html lang="en">
     3	  <head>
     4	    <meta charset="UTF-8" />
     5	    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
     6	    <title>dohc</title>
     7	    <style>
     8	      /* Warm paper + graphite, set inline so first paint is never unstyled. */
     9	      :root {
    10	        color-scheme: light dark;
    11	      }
    12	      html,
    13	      body {
    14	        margin: 0;
    15	        height: 100%;
    16	        background: #faf7f2;
    17	        color: #2b2926;
    18	        font-family:
    19	          system-ui,
    20	          -apple-system,
    21	          "Segoe UI",
    22	          sans-serif;
    23	      }
    24	      @media (prefers-color-scheme: dark) {
    25	        html,
    26	        body {
    27	          background: #1c1a18;
    28	          color: #e8e4de;
    29	        }
    30	      }
    31	    </style>
    32	  </head>
    33	  <body>
    34	    <div id="root"></div>
    35	    <script type="module" src="./main.ts"></script>
    36	  </body>
    37	</html>

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/electron.vite.config.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { defineConfig } from "electron-vite";
     2	
     3	export default defineConfig({
     4	  main: {
     5	    build: {
     6	      outDir: "dist/main",
     7	      lib: { entry: "src/main.ts" },
     8	    },
     9	  },
    10	  preload: {
    11	    build: {
    12	      outDir: "dist/preload",
    13	      // Sandboxed preloads must be CommonJS.
    14	      lib: { entry: "src/preload.ts", formats: ["cjs"] },
    15	    },
    16	  },
    17	  renderer: {
    18	    root: "src/renderer",
    19	    build: {
    20	      outDir: "dist/renderer",
    21	      rollupOptions: { input: "src/renderer/index.html" },
    22	    },
    23	  },
    24	});

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/package.json | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	{
     2	  "name": "@dohc/desktop",
     3	  "private": true,
     4	  "version": "0.1.0",
     5	  "type": "module",
     6	  "main": "dist/main/main.js",
     7	  "scripts": {
     8	    "dev": "electron-vite dev",
     9	    "build": "electron-vite build",
    10	    "test": "vitest run",
    11	    "typecheck": "tsc --noEmit"
    12	  },
    13	  "devDependencies": {
    14	    "@electron/fuses": "^2.1.2",
    15	    "@types/node": "^22.19.19",
    16	    "electron": "^42.4.0",
    17	    "electron-builder": "^26.15.2",
    18	    "electron-vite": "^5.0.0",
    19	    "typescript": "^5.9.3",
    20	    "vite": "^8.0.14",
    21	    "vitest": "^2.1.9"
    22	  },
    23	  "dependencies": {
    24	    "electron-updater": "^6.8.9",
    25	    "zod": "^3.25.76"
    26	  }
    27	}

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/scripts/smoke-test.mjs | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { spawn } from "node:child_process";
     2	import { existsSync } from "node:fs";
     3	import { join } from "node:path";
     4	
     5	// Spawns the built desktop app for a few seconds and fails on fatal stderr
     6	// patterns (t3code's smoke pattern). Catches broken builds that unit tests
     7	// cannot see: missing modules, preload failures, renderer crashes.
     8	
     9	const repoRoot = process.cwd();
    10	const mainEntry = join(repoRoot, "apps/desktop/dist/main/main.js");
    11	
    12	if (!existsSync(mainEntry)) {
    13	  console.error(`Desktop build missing: ${mainEntry} — run pnpm build:desktop first.`);
    14	  process.exit(1);
    15	}
    16	
    17	const FATAL_PATTERNS = [
    18	  /MODULE_NOT_FOUND/,
    19	  /Uncaught (Error|Exception)/i,
    20	  /Cannot find module/,
    21	  /Unable to load preload script/,
    22	  /Renderer process crashed/i,
    23	  /ERR_FILE_NOT_FOUND/,
    24	];
    25	
    26	const args = [mainEntry];
    27	if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
    28	
    29	const child = spawn(
    30	  join(repoRoot, "node_modules/.bin/electron"),
    31	  args,
    32	  {
    33	    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    34	    stdio: ["ignore", "pipe", "pipe"],
    35	  },
    36	);
    37	
    38	let stderr = "";
    39	child.stderr.on("data", (chunk) => {
    40	  stderr += String(chunk);
    41	});
    42	child.stdout.on("data", () => {});
    43	
    44	const SMOKE_DURATION_MS = 8000;
    45	
    46	setTimeout(() => {
    47	  child.kill("SIGTERM");
    48	}, SMOKE_DURATION_MS);
    49	
    50	child.on("exit", () => {
    51	  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
    52	  if (fatal.length > 0) {
    53	    console.error("Desktop smoke FAILED. Fatal stderr patterns:");
    54	    for (const pattern of fatal) console.error(`  ${pattern}`);
    55	    console.error("--- stderr ---");
    56	    console.error(stderr.slice(0, 4000));
    57	    process.exit(1);
    58	  }
    59	  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
    60	  process.exit(0);
    61	});

exec
/bin/bash -lc 'git show 7781d02:apps/desktop/src/performance/launchMarks.ts | nl -ba' in /home/ice/dev/dohc
 succeeded in 0ms:
     1	// Launch instrumentation, alive from the first scaffold per the plan's
     2	// continuous performance enforcement: later phases append marks, Phase 16
     3	// turns the numbers into a hard gate.
     4	
     5	const processStart = Date.now();
     6	
     7	interface LaunchMarks {
     8	  appReadyMs: number;
     9	  firstWindowMs: number;
    10	  firstPaintMs: number;
    11	}
    12	
    13	const marks: Partial<LaunchMarks> = {};
    14	
    15	function markOnce(key: keyof LaunchMarks): void {
    16	  if (marks[key] === undefined) marks[key] = Date.now() - processStart;
    17	}
    18	
    19	export const launchMarks = {
    20	  appReady: () => markOnce("appReadyMs"),
    21	  firstWindow: () => markOnce("firstWindowMs"),
    22	  firstPaint: () => markOnce("firstPaintMs"),
    23	  snapshot: (): Partial<LaunchMarks> => ({ ...marks }),
    24	};

exec
/bin/bash -lc 'rg -n "ipcMain|ipcRenderer|contextBridge|BrowserWindow|webContents|setWindowOpenHandler|will-navigate|will-frame-navigate|openExternal|DOHC_DESKTOP_TEST|ELECTRON_RENDERER_URL|nodeIntegration|sandbox|contextIsolation|webview|allowpopups|navigate|window.open" apps/desktop package.json pnpm-workspace.yaml' in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/e2e/desktopLaunch.spec.ts:11:    launchArgs.push("--no-sandbox");
apps/desktop/e2e/desktopLaunch.spec.ts:16:    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
apps/desktop/scripts/smoke-test.mjs:27:if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
apps/desktop/scripts/smoke-test.mjs:33:    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
apps/desktop/src/security/electronSecurity.ts:5:  nodeIntegration: false;
apps/desktop/src/security/electronSecurity.ts:6:  contextIsolation: true;
apps/desktop/src/security/electronSecurity.ts:7:  sandbox: true;
apps/desktop/src/security/electronSecurity.ts:18:    nodeIntegration: false,
apps/desktop/src/security/electronSecurity.ts:19:    contextIsolation: true,
apps/desktop/src/security/electronSecurity.ts:20:    sandbox: true,
apps/desktop/src/security/electronSecurity.ts:37:// The renderer may only navigate within the app itself: the packaged
apps/desktop/src/security/electronSecurity.ts:64:  openExternal: boolean;
apps/desktop/src/security/electronSecurity.ts:67:// window.open never creates a BrowserWindow. http(s) targets are handed to
apps/desktop/src/security/electronSecurity.ts:70:  let openExternal = false;
apps/desktop/src/security/electronSecurity.ts:73:    openExternal = protocol === "https:" || protocol === "http:";
apps/desktop/src/security/electronSecurity.ts:75:    openExternal = false;
apps/desktop/src/security/electronSecurity.ts:77:  return { action: "deny", openExternal };
apps/desktop/src/window/createMainWindow.ts:1:import { BrowserWindow, shell } from "electron";
apps/desktop/src/window/createMainWindow.ts:15:  const devServer = process.env.ELECTRON_RENDERER_URL;
apps/desktop/src/window/createMainWindow.ts:25:export function createMainWindow(): BrowserWindow {
apps/desktop/src/window/createMainWindow.ts:28:  const window = new BrowserWindow({
apps/desktop/src/window/createMainWindow.ts:38:  window.webContents.setWindowOpenHandler(({ url }) => {
apps/desktop/src/window/createMainWindow.ts:40:    if (decision.openExternal) void shell.openExternal(url);
apps/desktop/src/window/createMainWindow.ts:44:  window.webContents.on("will-navigate", (event, url) => {
apps/desktop/src/window/createMainWindow.ts:52:  const devServer = process.env.ELECTRON_RENDERER_URL;
apps/desktop/src/security/electronSecurity.test.ts:9:  it("locks down the renderer: no node, isolated context, sandboxed", () => {
apps/desktop/src/security/electronSecurity.test.ts:11:    expect(prefs.nodeIntegration).toBe(false);
apps/desktop/src/security/electronSecurity.test.ts:12:    expect(prefs.contextIsolation).toBe(true);
apps/desktop/src/security/electronSecurity.test.ts:13:    expect(prefs.sandbox).toBe(true);
apps/desktop/src/security/electronSecurity.test.ts:68:describe("window.open policy", () => {
apps/desktop/src/security/electronSecurity.test.ts:69:  it("denies all window.open targets", () => {
apps/desktop/src/security/electronSecurity.test.ts:75:    expect(decideWindowOpen("https://dohc.ai/docs").openExternal).toBe(true);
apps/desktop/src/security/electronSecurity.test.ts:76:    expect(decideWindowOpen("http://dohc.ai/docs").openExternal).toBe(true);
apps/desktop/src/security/electronSecurity.test.ts:81:    expect(decideWindowOpen("file:///etc/passwd").openExternal).toBe(false);
apps/desktop/src/security/electronSecurity.test.ts:82:    expect(decideWindowOpen("smb://share/x").openExternal).toBe(false);
apps/desktop/src/main.ts:1:import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
apps/desktop/src/main.ts:27:  ipcMain.handle(CHANNELS.getVersion, (event) => {
apps/desktop/src/main.ts:32:  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
apps/desktop/src/main.ts:41:  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
apps/desktop/src/main.ts:47:  ipcMain.on(CHANNELS.firstPaint, (event) => {
apps/desktop/src/main.ts:53:  if (process.env.DOHC_DESKTOP_TEST === "1") {
apps/desktop/src/main.ts:54:    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
apps/desktop/src/preload.ts:1:import { contextBridge, ipcRenderer } from "electron";
apps/desktop/src/preload.ts:5:// typed operations — never raw ipcRenderer, never Node.
apps/desktop/src/preload.ts:6:contextBridge.exposeInMainWorld("dohcDesktop", {
apps/desktop/src/preload.ts:7:  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
apps/desktop/src/preload.ts:8:  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
apps/desktop/src/preload.ts:9:  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
apps/desktop/src/preload.ts:13:contextBridge.exposeInMainWorld("dohcDesktopInternal", {
apps/desktop/src/preload.ts:14:  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
apps/desktop/src/preload.ts:17:if (process.env.DOHC_DESKTOP_TEST === "1") {
apps/desktop/src/preload.ts:18:  contextBridge.exposeInMainWorld("dohcDesktopTest", {
apps/desktop/src/preload.ts:19:    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),

codex
A key nuance here is defense-in-depth around subframes. The current CSP is restrictive, but I’m checking whether the Electron event coverage itself is complete because CSP tends to get relaxed later as the renderer grows.
exec
/bin/bash -lc "node -e \"const {join}=require('node:path'); const {pathToFileURL}=require('node:url'); console.log(join('/a/dist/main','../renderer/')); console.log(pathToFileURL(join('/a/dist/main','../renderer/')).href); console.log(pathToFileURL('/a/dist/renderer/').href);\"" in /home/ice/dev/dohc
 succeeded in 0ms:
/a/dist/renderer/
file:///a/dist/renderer/
file:///a/dist/renderer/

exec
/bin/bash -lc "node - <<'NODE'
const tests = [
'file:///app/dist/renderer/%2e%2e/secret',
'file:///app/dist/renderer/../secret',
'file:///app/dist/renderer/%2e%2e%2fsecret',
'file:///app/dist/renderer/%252e%252e/secret',
'file:///app/dist/renderer//../secret',
'file:///app/dist/renderer.evil/x'
];
for (const t of tests) { const u = new URL(t); console.log(t, '=>', u.href, u.pathname); }
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
file:///app/dist/renderer/%2e%2e/secret => file:///app/dist/secret /app/dist/secret
file:///app/dist/renderer/../secret => file:///app/dist/secret /app/dist/secret
file:///app/dist/renderer/%2e%2e%2fsecret => file:///app/dist/renderer/%2e%2e%2fsecret /app/dist/renderer/%2e%2e%2fsecret
file:///app/dist/renderer/%252e%252e/secret => file:///app/dist/renderer/%252e%252e/secret /app/dist/renderer/%252e%252e/secret
file:///app/dist/renderer//../secret => file:///app/dist/renderer/secret /app/dist/renderer/secret
file:///app/dist/renderer.evil/x => file:///app/dist/renderer.evil/x /app/dist/renderer.evil/x

exec
/bin/bash -lc "node - <<'NODE'
const {fileURLToPath}=require('node:url');
for (const t of ['file:///app/dist/renderer/%2e%2e%2fsecret','file:///app/dist/renderer/%252e%252e/secret']) {
  try { console.log(t, '=>', fileURLToPath(t)); } catch (e) { console.log(t, 'ERR', e.message); }
}
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
file:///app/dist/renderer/%2e%2e%2fsecret ERR File URL path must not include encoded / characters
file:///app/dist/renderer/%252e%252e/secret => /app/dist/renderer/%2e%2e/secret

codex
The main candidate issue is not a direct Node escape. It’s the navigation event matrix: top-level user/page navigations are covered, but server redirects and frame navigations are separate Electron surfaces.
exec
/bin/bash -lc 'git show 7781d02 -- apps/desktop/src/window/createMainWindow.ts apps/desktop/src/security/electronSecurity.ts apps/desktop/src/security/electronSecurity.test.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 7781d02bcdae6a121429ddc3a6ad70e6dd574cb9
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 16:36:26 2026 +0800

    phase2: Scaffold secure Electron desktop app
    
    electron-vite scaffold with strict security: contextIsolation+sandbox,
    no nodeIntegration, exact-origin navigation policy (no prefix-match
    bypass), universal window.open denial with http(s) shell routing,
    sender-validated zod-parsed IPC, narrow contextBridge surface, launch
    performance marks from day one (315ms first paint), dedicated desktop
    Playwright config, 8s fatal-stderr smoke. Verifiers probed the runtime
    bridge surface and confirmed no Node reach.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/src/security/electronSecurity.test.ts b/apps/desktop/src/security/electronSecurity.test.ts
new file mode 100644
index 0000000..08e95c0
--- /dev/null
+++ b/apps/desktop/src/security/electronSecurity.test.ts
@@ -0,0 +1,84 @@
+import { describe, expect, it } from "vitest";
+import {
+  createMainWindowWebPreferences,
+  decideNavigation,
+  decideWindowOpen,
+} from "./electronSecurity";
+
+describe("main window web preferences", () => {
+  it("locks down the renderer: no node, isolated context, sandboxed", () => {
+    const prefs = createMainWindowWebPreferences("/abs/path/preload.js");
+    expect(prefs.nodeIntegration).toBe(false);
+    expect(prefs.contextIsolation).toBe(true);
+    expect(prefs.sandbox).toBe(true);
+  });
+
+  it("requires an absolute preload path", () => {
+    expect(() => createMainWindowWebPreferences("relative/preload.js")).toThrow(
+      /absolute/i,
+    );
+  });
+});
+
+describe("navigation policy", () => {
+  const policy = {
+    httpOrigins: ["http://localhost:5173"],
+    fileUrlPrefix: "file:///app/dist/renderer/",
+  };
+
+  it("allows in-app navigation", () => {
+    expect(
+      decideNavigation("file:///app/dist/renderer/index.html", policy),
+    ).toEqual({ action: "allow" });
+    expect(
+      decideNavigation("http://localhost:5173/route", policy),
+    ).toEqual({ action: "allow" });
+  });
+
+  it("denies navigation to arbitrary external URLs", () => {
+    expect(decideNavigation("https://evil.example.com", policy).action).toBe(
+      "deny",
+    );
+  });
+
+  it("denies origin prefix-spoofing (localhost:5173.evil.com)", () => {
+    expect(
+      decideNavigation("http://localhost:5173.evil.com/x", policy).action,
+    ).toBe("deny");
+  });
+
+  it("denies local files outside the renderer bundle", () => {
+    expect(decideNavigation("file:///etc/passwd", policy).action).toBe("deny");
+  });
+
+  it("denies file navigation entirely when no bundle prefix is set (dev)", () => {
+    expect(
+      decideNavigation("file:///app/dist/renderer/index.html", {
+        httpOrigins: ["http://localhost:5173"],
+        fileUrlPrefix: null,
+      }).action,
+    ).toBe("deny");
+  });
+
+  it("denies unparseable URLs", () => {
+    expect(decideNavigation("not a url", policy).action).toBe("deny");
+  });
+});
+
+describe("window.open policy", () => {
+  it("denies all window.open targets", () => {
+    expect(decideWindowOpen("https://dohc.ai/docs").action).toBe("deny");
+    expect(decideWindowOpen("file:///etc/passwd").action).toBe("deny");
+  });
+
+  it("routes http and https targets through the external shell handler", () => {
+    expect(decideWindowOpen("https://dohc.ai/docs").openExternal).toBe(true);
+    expect(decideWindowOpen("http://dohc.ai/docs").openExternal).toBe(true);
+    expect(decideWindowOpen("http://dohc.ai/docs").action).toBe("deny");
+  });
+
+  it("never shells out non-http(s) schemes", () => {
+    expect(decideWindowOpen("file:///etc/passwd").openExternal).toBe(false);
+    expect(decideWindowOpen("smb://share/x").openExternal).toBe(false);
+  });
+});
diff --git a/apps/desktop/src/security/electronSecurity.ts b/apps/desktop/src/security/electronSecurity.ts
new file mode 100644
index 0000000..7fa71e4
--- /dev/null
+++ b/apps/desktop/src/security/electronSecurity.ts
@@ -0,0 +1,78 @@
+import { isAbsolute } from "node:path";
+
+export interface MainWindowWebPreferences {
+  preload: string;
+  nodeIntegration: false;
+  contextIsolation: true;
+  sandbox: true;
+}
+
+export function createMainWindowWebPreferences(
+  preloadPath: string,
+): MainWindowWebPreferences {
+  if (!isAbsolute(preloadPath)) {
+    throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
+  }
+  return {
+    preload: preloadPath,
+    nodeIntegration: false,
+    contextIsolation: true,
+    sandbox: true,
+  };
+}
+
+export interface NavigationDecision {
+  action: "allow" | "deny";
+}
+
+export interface NavigationPolicy {
+  // Exact URL origins (scheme://host:port), compared with ===, never prefix:
+  // startsWith would allow http://localhost:5173.evil.com.
+  httpOrigins: string[];
+  // The packaged renderer bundle directory as a file:// href prefix; a bare
+  // "file://" allowance would open every local file to navigation.
+  fileUrlPrefix: string | null;
+}
+
+// The renderer may only navigate within the app itself: the packaged
+// bundle directory or the dev server's exact origin. Everything else,
+// including unparseable URLs, is denied.
+export function decideNavigation(
+  targetUrl: string,
+  policy: NavigationPolicy,
+): NavigationDecision {
+  try {
+    const url = new URL(targetUrl);
+    if (url.protocol === "http:" || url.protocol === "https:") {
+      return {
+        action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny",
+      };
+    }
+    if (url.protocol === "file:" && policy.fileUrlPrefix) {
+      return {
+        action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny",
+      };
+    }
+  } catch {
+    // fall through to deny
+  }
+  return { action: "deny" };
+}
+
+export interface WindowOpenDecision {
+  action: "deny";
+  openExternal: boolean;
+}
+
+// window.open never creates a BrowserWindow. http(s) targets are handed to
+// the OS browser; every other scheme is dropped entirely.
+export function decideWindowOpen(targetUrl: string): WindowOpenDecision {
+  let openExternal = false;
+  try {
+    const protocol = new URL(targetUrl).protocol;
+    openExternal = protocol === "https:" || protocol === "http:";
+  } catch {
+    openExternal = false;
+  }
+  return { action: "deny", openExternal };
+}
diff --git a/apps/desktop/src/window/createMainWindow.ts b/apps/desktop/src/window/createMainWindow.ts
new file mode 100644
index 0000000..a4e79e0
--- /dev/null
+++ b/apps/desktop/src/window/createMainWindow.ts
@@ -0,0 +1,60 @@
+import { BrowserWindow, shell } from "electron";
+import { join } from "node:path";
+import { pathToFileURL } from "node:url";
+import {
+  createMainWindowWebPreferences,
+  decideNavigation,
+  decideWindowOpen,
+  type NavigationPolicy,
+} from "../security/electronSecurity";
+
+// Warm paper — set before first paint so launch never flashes white.
+const BACKGROUND_COLOR = "#faf7f2";
+
+export function navigationPolicy(): NavigationPolicy {
+  const devServer = process.env.ELECTRON_RENDERER_URL;
+  if (devServer) {
+    // Dev: exact dev-server origin only; no file navigation at all.
+    return { httpOrigins: [new URL(devServer).origin], fileUrlPrefix: null };
+  }
+  // Prod: only the packaged renderer bundle directory.
+  const rendererDir = join(import.meta.dirname, "../renderer/");
+  return { httpOrigins: [], fileUrlPrefix: pathToFileURL(rendererDir).href };
+}
+
+export function createMainWindow(): BrowserWindow {
+  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");
+
+  const window = new BrowserWindow({
+    show: false,
+    width: 1280,
+    height: 800,
+    minWidth: 840,
+    minHeight: 620,
+    backgroundColor: BACKGROUND_COLOR,
+    webPreferences: createMainWindowWebPreferences(preloadPath),
+  });
+
+  window.webContents.setWindowOpenHandler(({ url }) => {
+    const decision = decideWindowOpen(url);
+    if (decision.openExternal) void shell.openExternal(url);
+    return { action: "deny" };
+  });
+
+  window.webContents.on("will-navigate", (event, url) => {
+    if (decideNavigation(url, navigationPolicy()).action === "deny") {
+      event.preventDefault();
+    }
+  });
+
+  window.once("ready-to-show", () => window.show());
+
+  const devServer = process.env.ELECTRON_RENDERER_URL;
+  if (devServer) {
+    void window.loadURL(devServer);
+  } else {
+    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
+  }
+
+  return window;
+}

codex
1. `apps/desktop/src/window/createMainWindow.ts:14` / `apps/desktop/src/window/createMainWindow.ts:52` — **Medium**  
   `ELECTRON_RENDERER_URL` is trusted at runtime without an `app.isPackaged` or loopback-only dev guard. In a packaged app launched with that env var, dohc can `loadURL()` an arbitrary URL and `navigationPolicy()` will treat that URL’s origin as IPC-trusted. Current IPC is narrow, but this pattern would become dangerous as filesystem/workspace IPC lands. Gate this to non-packaged dev builds, require `http://localhost`/loopback, and validate the initial URL before `loadURL()`.

2. `apps/desktop/src/window/createMainWindow.ts:44` — **Medium**  
   Navigation enforcement only handles `will-navigate`. Electron has separate surfaces for server redirects and frame navigations, so an allowed URL can redirect out, and subframe navigations are not checked by this policy. Current CSP helps, but this should be enforced at the Electron boundary too. Add equivalent denial for `will-redirect` and `will-frame-navigate`, with tests for redirects, iframes, `about:blank`, and `javascript:`.

3. `apps/desktop/src/preload.ts:17` / `apps/desktop/src/main.ts:53` — **Low**  
   The test bridge is gated only by `DOHC_DESKTOP_TEST=1`. Today it exposes launch timings only, so impact is low, but env-only gating is easy to accidentally enable in packaged builds and risky as test helpers grow. Require both the env flag and a non-packaged/test runtime check.

4. `apps/desktop/src/security/electronSecurity.ts:69` / `apps/desktop/src/window/createMainWindow.ts:38` — **Low**  
   `window.open()` denies new Electron windows, which is good, but shells out any `http:` or `https:` URL from renderer code. If renderer content is ever user-influenced, this becomes an external browser/phishing spam primitive. Consider requiring HTTPS and a user-initiated action, or routing through an allowlist/confirmation path.

5. `apps/desktop/src/security/electronSecurity.ts:62` — **Info**  
   `WindowOpenDecision.action` is always `"deny"` and the caller ignores it, returning `{ action: "deny" }` directly. This is harmless but over-shaped for the current behavior; a boolean like `shouldOpenExternalHttpUrl()` would be simpler.

Solid areas: IPC does validate sender URL on every handler, preload does not expose raw `ipcRenderer`, Node, or Electron internals, web preferences correctly set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, and direct `about:`/`javascript:` URLs are denied by the decision helpers.
tokens used
48,136
1. `apps/desktop/src/window/createMainWindow.ts:14` / `apps/desktop/src/window/createMainWindow.ts:52` — **Medium**  
   `ELECTRON_RENDERER_URL` is trusted at runtime without an `app.isPackaged` or loopback-only dev guard. In a packaged app launched with that env var, dohc can `loadURL()` an arbitrary URL and `navigationPolicy()` will treat that URL’s origin as IPC-trusted. Current IPC is narrow, but this pattern would become dangerous as filesystem/workspace IPC lands. Gate this to non-packaged dev builds, require `http://localhost`/loopback, and validate the initial URL before `loadURL()`.

2. `apps/desktop/src/window/createMainWindow.ts:44` — **Medium**  
   Navigation enforcement only handles `will-navigate`. Electron has separate surfaces for server redirects and frame navigations, so an allowed URL can redirect out, and subframe navigations are not checked by this policy. Current CSP helps, but this should be enforced at the Electron boundary too. Add equivalent denial for `will-redirect` and `will-frame-navigate`, with tests for redirects, iframes, `about:blank`, and `javascript:`.

3. `apps/desktop/src/preload.ts:17` / `apps/desktop/src/main.ts:53` — **Low**  
   The test bridge is gated only by `DOHC_DESKTOP_TEST=1`. Today it exposes launch timings only, so impact is low, but env-only gating is easy to accidentally enable in packaged builds and risky as test helpers grow. Require both the env flag and a non-packaged/test runtime check.

4. `apps/desktop/src/security/electronSecurity.ts:69` / `apps/desktop/src/window/createMainWindow.ts:38` — **Low**  
   `window.open()` denies new Electron windows, which is good, but shells out any `http:` or `https:` URL from renderer code. If renderer content is ever user-influenced, this becomes an external browser/phishing spam primitive. Consider requiring HTTPS and a user-initiated action, or routing through an allowlist/confirmation path.

5. `apps/desktop/src/security/electronSecurity.ts:62` — **Info**  
   `WindowOpenDecision.action` is always `"deny"` and the caller ignores it, returning `{ action: "deny" }` directly. This is harmless but over-shaped for the current behavior; a boolean like `shouldOpenExternalHttpUrl()` would be simpler.

Solid areas: IPC does validate sender URL on every handler, preload does not expose raw `ipcRenderer`, Node, or Electron internals, web preferences correctly set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, and direct `about:`/`javascript:` URLs are denied by the decision helpers.
