OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb13f-cc49-75d0-948c-1df91a852e2b
--------
user
commit b3dd383
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git rev-parse b3dd383''^ && git rev-parse b3dd383' in /home/ice/dev/dohc
 succeeded in 0ms:
 M docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
?? docs/superpowers/reviews/codex/phase-04-fix.md
/home/ice/dev/dohc
ce6910a523556d287882b9b6a5300ace79aa18c8
b3dd38339a6d04c543b82a71b358d8163eab6b48

exec
/bin/bash -lc "git show --stat --oneline --decorate --no-renames b3dd383 && git show --name-only --format='' b3dd383" in /home/ice/dev/dohc
 succeeded in 0ms:
b3dd383 (HEAD -> claude/desktop-local-first-cloud-sync) phase4(fix): close checkpoint-1 security and data-loss findings
 apps/desktop/e2e/desktopLaunch.spec.ts             |    12 +-
 apps/desktop/e2e/firstRunWorkspace.spec.ts         |    47 +-
 apps/desktop/e2e/launch.ts                         |    15 +
 apps/desktop/src/ipc/bridgeContract.ts             |    90 +-
 apps/desktop/src/ipc/channels.ts                   |     1 -
 apps/desktop/src/main.ts                           |    59 +-
 apps/desktop/src/preload.ts                        |    34 +-
 apps/desktop/src/renderer/CommandPalette.tsx       |    20 +-
 apps/desktop/src/renderer/DesktopFirstRun.test.tsx |     1 -
 apps/desktop/src/renderer/DesktopRoot.tsx          |     8 +
 .../desktop/src/renderer/DesktopWorkspaceShell.tsx |    69 +-
 apps/desktop/src/renderer/NewFileDialog.tsx        |    13 +-
 apps/desktop/src/renderer/Overlay.tsx              |    15 +
 apps/desktop/src/renderer/main.tsx                 |     7 +-
 .../src/workspaces/createWorkspaceFolder.ts        |    62 +-
 apps/desktop/src/workspaces/registryStore.test.ts  |    33 +-
 apps/desktop/src/workspaces/registryStore.ts       |    47 +-
 apps/desktop/src/workspaces/workspaceFiles.test.ts |    22 +-
 apps/desktop/src/workspaces/workspaceFiles.ts      |    52 +-
 ...desktop-local-first-cloud-sync.execution-log.md |    49 +-
 .../codex/adversarial-scenarios-phase-04.md        |  2705 ++++
 .../reviews/codex/checkpoint-phase-04.md           | 13749 +++++++++++++++++++
 docs/superpowers/reviews/codex/phase-04.md         |  5581 ++++++++
 packages/workspace-core/src/metadata.ts            |    48 +-
 packages/workspace-core/src/paths.test.ts          |    13 +
 packages/workspace-core/src/paths.ts               |    18 +-
 packages/workspace-core/src/workspaceMode.test.ts  |    40 +-
 packages/workspace-core/src/workspaceMode.ts       |    16 +-
 28 files changed, 22607 insertions(+), 219 deletions(-)
apps/desktop/e2e/desktopLaunch.spec.ts
apps/desktop/e2e/firstRunWorkspace.spec.ts
apps/desktop/e2e/launch.ts
apps/desktop/src/ipc/bridgeContract.ts
apps/desktop/src/ipc/channels.ts
apps/desktop/src/main.ts
apps/desktop/src/preload.ts
apps/desktop/src/renderer/CommandPalette.tsx
apps/desktop/src/renderer/DesktopFirstRun.test.tsx
apps/desktop/src/renderer/DesktopRoot.tsx
apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
apps/desktop/src/renderer/NewFileDialog.tsx
apps/desktop/src/renderer/Overlay.tsx
apps/desktop/src/renderer/main.tsx
apps/desktop/src/workspaces/createWorkspaceFolder.ts
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/registryStore.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/workspaceFiles.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md
docs/superpowers/reviews/codex/checkpoint-phase-04.md
docs/superpowers/reviews/codex/phase-04.md
packages/workspace-core/src/metadata.ts
packages/workspace-core/src/paths.test.ts
packages/workspace-core/src/paths.ts
packages/workspace-core/src/workspaceMode.test.ts
packages/workspace-core/src/workspaceMode.ts

exec
/bin/bash -lc "git diff --no-renames --find-renames=0 ce6910a..b3dd383 -- apps/desktop packages/workspace-core | sed -n '1,240p'" in /home/ice/dev/dohc
 succeeded in 0ms:
diff --git a/apps/desktop/e2e/desktopLaunch.spec.ts b/apps/desktop/e2e/desktopLaunch.spec.ts
index 565d61b..5c8f1ed 100644
--- a/apps/desktop/e2e/desktopLaunch.spec.ts
+++ b/apps/desktop/e2e/desktopLaunch.spec.ts
@@ -1,20 +1,12 @@
 import { expect, test } from "@playwright/test";
 import { mkdir, writeFile } from "node:fs/promises";
-import { _electron as electron } from "playwright";
+import { launchApp } from "./launch";
 
 const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
 const PERF_FILE = "test-results/performance/desktop-performance.json";
 
 test("launches dohc desktop and renders the first-run shell", async () => {
-  const launchArgs = ["apps/desktop/dist/main/main.js"];
-  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
-    launchArgs.push("--no-sandbox");
-  }
-  const app = await electron.launch({
-    args: launchArgs,
-    cwd: process.cwd(),
-    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
-  });
+  const app = await launchApp();
 
   const page = await app.firstWindow();
   await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
diff --git a/apps/desktop/e2e/firstRunWorkspace.spec.ts b/apps/desktop/e2e/firstRunWorkspace.spec.ts
index 4562932..ccd3da3 100644
--- a/apps/desktop/e2e/firstRunWorkspace.spec.ts
+++ b/apps/desktop/e2e/firstRunWorkspace.spec.ts
@@ -3,7 +3,8 @@ import { existsSync, readFileSync } from "node:fs";
 import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
-import { _electron as electron, type ElectronApplication, type Page } from "playwright";
+import { type ElectronApplication, type Page } from "playwright";
+import { launchApp } from "./launch";
 
 const SCREENSHOT_DIR = "test-results/screenshots/phase-03";
 
@@ -13,19 +14,7 @@ async function launchFirstRun(): Promise<{
   testHome: string;
 }> {
   const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
-  const launchArgs = ["apps/desktop/dist/main/main.js"];
-  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
-    launchArgs.push("--no-sandbox");
-  }
-  const app = await electron.launch({
-    args: launchArgs,
-    cwd: process.cwd(),
-    env: {
-      ...process.env,
-      DOHC_DESKTOP_TEST: "1",
-      DOHC_TEST_HOME: testHome,
-    },
-  });
+  const app = await launchApp({ DOHC_TEST_HOME: testHome });
   const page = await app.firstWindow();
   return { app, page, testHome };
 }
@@ -187,19 +176,9 @@ test("attaching an existing dohc workspace preserves its identity", async () =>
   await writeFile(join(existingRoot, "budget.md"), "# Budget");
 
   const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
-  const launchArgs = ["apps/desktop/dist/main/main.js"];
-  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
-    launchArgs.push("--no-sandbox");
-  }
-  const app = await electron.launch({
-    args: launchArgs,
-    cwd: process.cwd(),
-    env: {
-      ...process.env,
-      DOHC_DESKTOP_TEST: "1",
-      DOHC_TEST_HOME: testHome,
-      DOHC_TEST_PICK_PATH: existingRoot,
-    },
+  const app = await launchApp({
+    DOHC_TEST_HOME: testHome,
+    DOHC_TEST_PICK_PATH: existingRoot,
   });
   const page = await app.firstWindow();
 
@@ -225,19 +204,7 @@ test("returning user lands directly in the shell, not first-run", async () => {
   await app.close();
 
   // Relaunch with the same test home: registry remembers the workspace.
-  const relaunchArgs = ["apps/desktop/dist/main/main.js"];
-  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
-    relaunchArgs.push("--no-sandbox");
-  }
-  const second = await electron.launch({
-    args: relaunchArgs,
-    cwd: process.cwd(),
-    env: {
-      ...process.env,
-      DOHC_DESKTOP_TEST: "1",
-      DOHC_TEST_HOME: testHome,
-    },
-  });
+  const second = await launchApp({ DOHC_TEST_HOME: testHome });
   const page2 = await second.firstWindow();
   await expect(page2.getByTestId("workspace-shell")).toBeVisible();
   await expect(
diff --git a/apps/desktop/e2e/launch.ts b/apps/desktop/e2e/launch.ts
new file mode 100644
index 0000000..9d938a8
--- /dev/null
+++ b/apps/desktop/e2e/launch.ts
@@ -0,0 +1,15 @@
+import { _electron as electron, type ElectronApplication } from "playwright";
+
+// Single source for launching the built desktop app in E2E. Keeps the
+// dist path, the WSL --no-sandbox flag, and the test env in one place.
+export async function launchApp(
+  env: Record<string, string> = {},
+): Promise<ElectronApplication> {
+  const args = ["apps/desktop/dist/main/main.js"];
+  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
+  return electron.launch({
+    args,
+    cwd: process.cwd(),
+    env: { ...process.env, DOHC_DESKTOP_TEST: "1", ...env },
+  });
+}
diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
index e947526..3b4e3bd 100644
--- a/apps/desktop/src/ipc/bridgeContract.ts
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -1,21 +1,28 @@
+import { WORKSPACE_KINDS, WORKSPACE_MODES } from "@dohc/workspace-core";
 import { z } from "zod";
 
 // Typed contract for everything the preload bridge exposes. Main-process
-// handlers validate results against these before returning them. Payload
-// validation starts with the first payload-accepting channel (Phase 4).
+// handlers validate payloads on arrival and results before returning them.
 // The renderer never sees raw Electron APIs.
 
-export const VersionResult = z.string().min(1);
-export type VersionResult = z.infer<typeof VersionResult>;
+// Length caps: IPC payloads are untrusted; bound every renderer-supplied
+// string so a hostile/buggy caller cannot cause memory/latency pressure.
+const WORKSPACE_ID = z.string().min(1).max(200);
+const PATH_STRING = z.string().min(1).max(4096);
 
-export const PickWorkspaceRootResult = z.string().min(1).nullable();
+// Enums derive from the workspace-core tuples (single source of truth) so a
+// new kind/mode cannot make the type and the runtime validator disagree.
+const KIND_ENUM = z.enum(WORKSPACE_KINDS);
+const MODE_ENUM = z.enum(WORKSPACE_MODES);
+
+export const PickWorkspaceRootResult = PATH_STRING.nullable();
 export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
 
 export const WorkspaceSummary = z.object({
-  workspaceId: z.string().min(1),
-  rootPath: z.string().min(1),
-  kind: z.enum(["personal", "shared", "cloud-only"]),
-  mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
+  workspaceId: WORKSPACE_ID,
+  rootPath: PATH_STRING,
+  kind: KIND_ENUM,
+  mode: MODE_ENUM,
 });
 export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
 
@@ -24,10 +31,10 @@ export const WorkspaceRegistryResult = z.object({
 });
 export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
 
-export const DefaultWorkspaceRootResult = z.string().min(1);
+export const DefaultWorkspaceRootResult = PATH_STRING;
 
 export const CreateLocalWorkspacePayload = z.object({
-  rootPath: z.string().min(1),
+  rootPath: PATH_STRING,
   kind: z.enum(["personal", "shared"]),
 });
 export type CreateLocalWorkspacePayload = z.infer<
@@ -35,15 +42,21 @@ export type CreateLocalWorkspacePayload = z.infer<
 >;
 
 export const AttachWorkspaceFolderPayload = z.object({
-  rootPath: z.string().min(1),
+  rootPath: PATH_STRING,
 });
+export type AttachWorkspaceFolderPayload = z.infer<
+  typeof AttachWorkspaceFolderPayload
+>;
 
 export const ListWorkspaceFilesPayload = z.object({
-  workspaceId: z.string().min(1),
+  workspaceId: WORKSPACE_ID,
 });
+export type ListWorkspaceFilesPayload = z.infer<
+  typeof ListWorkspaceFilesPayload
+>;
 
 export const WorkspaceFileEntry = z.object({
-  path: z.string().min(1),
+  path: PATH_STRING,
   kind: z.enum(["file", "database", "app-source"]),
 });
 export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;
@@ -54,48 +67,59 @@ export const ListWorkspaceFilesResult = z.object({
 export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;
 
 export const CreateWorkspaceFilePayload = z.object({
-  workspaceId: z.string().min(1),
-  relativePath: z.string().min(1),
+  workspaceId: WORKSPACE_ID,
+  relativePath: PATH_STRING,
 });
+export type CreateWorkspaceFilePayload = z.infer<
+  typeof CreateWorkspaceFilePayload
+>;
 
 export const CreateWorkspaceFileResult = z.object({
-  path: z.string().min(1),
+  path: PATH_STRING,
 });
+export type CreateWorkspaceFileResult = z.infer<
+  typeof CreateWorkspaceFileResult
+>;
 
 export const ImportWorkspaceFilesPayload = z.object({
-  workspaceId: z.string().min(1),
+  workspaceId: WORKSPACE_ID,
 });
+export type ImportWorkspaceFilesPayload = z.infer<
+  typeof ImportWorkspaceFilesPayload
+>;
 
 export const ImportWorkspaceFilesResult = z.object({
-  imported: z.array(z.string().min(1)),
+  imported: z.array(PATH_STRING),
 });

exec
/bin/bash -lc "git diff --no-renames ce6910a..b3dd383 -- apps/desktop packages/workspace-core | sed -n '240,520p'" in /home/ice/dev/dohc
 succeeded in 0ms:
 });
+export type ImportWorkspaceFilesResult = z.infer<
+  typeof ImportWorkspaceFilesResult
+>;
 
 export const LaunchMarksResult = z.object({
   appReadyMs: z.number().positive(),
   firstWindowMs: z.number().positive(),
   firstPaintMs: z.number().positive(),
+  shellVisibleMs: z.number().positive().optional(),
 });
 export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;
 
 export interface DohcDesktopBridge {
-  getVersion(): Promise<VersionResult>;
   pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
   getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
   getDefaultWorkspaceRoot(): Promise<string>;
   createLocalWorkspace(
     payload: CreateLocalWorkspacePayload,
   ): Promise<WorkspaceSummary>;
-  attachWorkspaceFolder(payload: {
-    rootPath: string;
-  }): Promise<WorkspaceSummary>;
-  listWorkspaceFiles(payload: {
-    workspaceId: string;
-  }): Promise<ListWorkspaceFilesResult>;
-  createWorkspaceFile(payload: {
-    workspaceId: string;
-    relativePath: string;
-  }): Promise<{ path: string }>;
-  importWorkspaceFiles(payload: {
-    workspaceId: string;
-  }): Promise<{ imported: string[] }>;
+  attachWorkspaceFolder(
+    payload: AttachWorkspaceFolderPayload,
+  ): Promise<WorkspaceSummary>;
+  listWorkspaceFiles(
+    payload: ListWorkspaceFilesPayload,
+  ): Promise<ListWorkspaceFilesResult>;
+  createWorkspaceFile(
+    payload: CreateWorkspaceFilePayload,
+  ): Promise<CreateWorkspaceFileResult>;
+  importWorkspaceFiles(
+    payload: ImportWorkspaceFilesPayload,
+  ): Promise<ImportWorkspaceFilesResult>;
 }
diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
index 0de9127..e71df11 100644
--- a/apps/desktop/src/ipc/channels.ts
+++ b/apps/desktop/src/ipc/channels.ts
@@ -1,5 +1,4 @@
 export const CHANNELS = {
-  getVersion: "desktop:get-version",
   pickWorkspaceRoot: "desktop:pick-workspace-root",
   getWorkspaceRegistry: "desktop:get-workspace-registry",
   getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
index 499c3e1..af5ec45 100644
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -1,8 +1,10 @@
 import {
   defaultWorkspaceRoot,
+  normalizeAbsolutePath,
   validateWorkspaceRootChoice,
 } from "@dohc/workspace-core";
 import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
+import { relative, sep } from "node:path";
 import {
   AttachWorkspaceFolderPayload,
   CreateLocalWorkspacePayload,
@@ -15,7 +17,6 @@ import {
   ListWorkspaceFilesPayload,
   ListWorkspaceFilesResult,
   PickWorkspaceRootResult,
-  VersionResult,
   WorkspaceRegistryResult,
   WorkspaceSummary,
 } from "./ipc/bridgeContract";
@@ -42,10 +43,40 @@ function requireWorkspace(workspaceId: string) {
   return workspace;
 }
 
+// Workspace roots the main process itself produced — the default suggestion
+// and any folder the user chose through the real OS dialog. A renderer cannot
+// invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
+// be one of these or a descendant. Populated by getDefaultWorkspaceRoot and
+// pickWorkspaceRoot before the renderer can create/attach.
+const approvedRoots = new Set<string>();
+
+function approveRoot(rootPath: string): void {
+  approvedRoots.add(normalizeAbsolutePath(rootPath));
+}
+
+function isApprovedRoot(normalized: string): boolean {
+  for (const approved of approvedRoots) {
+    if (normalized === approved) return true;
+    const rel = relative(approved, normalized);
+    if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)) {
+      return true;
+    }
+  }
+  return false;
+}
+
+// The navigation policy is constant for the process lifetime (env var and
+// packaged bundle dir cannot change), so compute it once.
+let cachedPolicy: ReturnType<typeof navigationPolicy> | null = null;
+function policy() {
+  if (!cachedPolicy) cachedPolicy = navigationPolicy();
+  return cachedPolicy;
+}
+
 // IPC is an untrusted boundary: handlers only answer frames the navigation
 // policy itself would allow (exact dev origin or the packaged bundle).
 function isTrustedFrame(frameUrl: string): boolean {
-  return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
+  return decideNavigation(frameUrl, policy()).action === "allow";
 }
 
 function assertTrustedSender(event: IpcMainInvokeEvent): void {
@@ -56,22 +87,19 @@ function assertTrustedSender(event: IpcMainInvokeEvent): void {
 }
 
 function registerIpcHandlers(): void {
-  ipcMain.handle(CHANNELS.getVersion, (event) => {
-    assertTrustedSender(event);
-    return VersionResult.parse(app.getVersion());
-  });
-
   ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
     assertTrustedSender(event);
     // Test seam: native dialogs cannot be driven by Playwright.
     const testPick = process.env.DOHC_TEST_PICK_PATH;
     if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
+      approveRoot(testPick);
       return PickWorkspaceRootResult.parse(testPick);
     }
     const result = await dialog.showOpenDialog({
       properties: ["openDirectory", "createDirectory"],
     });
     const picked = result.canceled ? null : (result.filePaths[0] ?? null);
+    if (picked) approveRoot(picked);
     return PickWorkspaceRootResult.parse(picked);
   });
 
@@ -82,17 +110,22 @@ function registerIpcHandlers(): void {
 
   ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
     assertTrustedSender(event);
-    return DefaultWorkspaceRootResult.parse(
-      defaultWorkspaceRoot(effectiveHome()),
-    );
+    const root = defaultWorkspaceRoot(effectiveHome());
+    approveRoot(root);
+    return DefaultWorkspaceRootResult.parse(root);
   });
 
-  // Validates AND canonicalizes: all downstream fs/registry operations use
-  // the normalized root, so dot-segment or separator variants of the same
-  // folder cannot bypass guards or register twice.
+  // Validates, canonicalizes, AND confirms the root traces to a main-process
+  // suggestion or dialog pick — a renderer cannot scope fs ops to a path it
+  // invented. All downstream ops use the normalized root.
   function usableRoot(rootPath: string): string {
     const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
     if (!check.ok) throw new Error(check.reason);
+    if (!isApprovedRoot(check.normalized)) {
+      throw new Error(
+        "Workspace root must be chosen through dohc (the default location or the folder picker).",
+      );
+    }
     return check.normalized;
   }
 
diff --git a/apps/desktop/src/preload.ts b/apps/desktop/src/preload.ts
index 653795f..9be669c 100644
--- a/apps/desktop/src/preload.ts
+++ b/apps/desktop/src/preload.ts
@@ -1,33 +1,43 @@
 import { contextBridge, ipcRenderer } from "electron";
+import type {
+  CreateLocalWorkspacePayload,
+  DohcDesktopBridge,
+} from "./ipc/bridgeContract";
 import { CHANNELS } from "./ipc/channels";
 
 // The entire bridge surface. Narrow on purpose: the renderer gets named,
-// typed operations — never raw ipcRenderer, never Node.
-contextBridge.exposeInMainWorld("dohcDesktop", {
-  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
+// typed operations — never raw ipcRenderer, never Node. Typed as
+// DohcDesktopBridge so it cannot drift from the contract (a missing or
+// mistyped method fails the desktop typecheck).
+const bridge: DohcDesktopBridge = {
   pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
   getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
   getDefaultWorkspaceRoot: () =>
     ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
-  createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
+  createLocalWorkspace: (payload: CreateLocalWorkspacePayload) =>
     ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
-  attachWorkspaceFolder: (payload: { rootPath: string }) =>
+  attachWorkspaceFolder: (payload) =>
     ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
-  listWorkspaceFiles: (payload: { workspaceId: string }) =>
+  listWorkspaceFiles: (payload) =>
     ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
-  createWorkspaceFile: (payload: {
-    workspaceId: string;
-    relativePath: string;
-  }) => ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
-  importWorkspaceFiles: (payload: { workspaceId: string }) =>
+  createWorkspaceFile: (payload) =>
+    ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
+  importWorkspaceFiles: (payload) =>
     ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
-});
+};
+
+contextBridge.exposeInMainWorld("dohcDesktop", bridge);
 
 // One-shot paint signal for launch instrumentation (no data, no response).
 contextBridge.exposeInMainWorld("dohcDesktopInternal", {
   firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
 });
 
+// Test-only bridge. The authoritative gate is the main-process handler, which
+// is double-gated (env AND !app.isPackaged); the preload cannot read
+// isPackaged, so this env-only check is intentionally the weaker side — never
+// expose a data-returning test channel here without a matching double-gated
+// handler. Build-time stripping lands with Phase 14 packaging.
 if (process.env.DOHC_DESKTOP_TEST === "1") {
   contextBridge.exposeInMainWorld("dohcDesktopTest", {
     getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
diff --git a/apps/desktop/src/renderer/CommandPalette.tsx b/apps/desktop/src/renderer/CommandPalette.tsx
index 9226f56..029b5e0 100644
--- a/apps/desktop/src/renderer/CommandPalette.tsx
+++ b/apps/desktop/src/renderer/CommandPalette.tsx
@@ -1,4 +1,5 @@
 import { useEffect, useRef, useState } from "react";
+import { Overlay } from "./Overlay";
 
 export interface Command {
   id: string;
@@ -20,9 +21,14 @@ export function CommandPalette(props: {
     inputRef.current?.focus();
   }, []);
 
-  const matches = props.commands.filter((command) =>
-    command.label.toLowerCase().includes(query.toLowerCase()),
-  );
+  // Cap rendered rows: a workspace can have thousands of files (quick-open),
+  // and rendering them all per keystroke is wasted work.
+  const MAX_MATCHES = 50;
+  const matches = props.commands
+    .filter((command) =>
+      command.label.toLowerCase().includes(query.toLowerCase()),
+    )
+    .slice(0, MAX_MATCHES);
 
   function runCommand(command: Command | undefined) {
     if (!command) return;
@@ -31,14 +37,10 @@ export function CommandPalette(props: {
   }
 
   return (
-    <div
-      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
-      onClick={props.onClose}
-    >
+    <Overlay onClose={props.onClose}>
       <div
         data-testid={props.testId ?? "command-palette"}
         className="w-130 max-w-[80vw] overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
-        onClick={(event) => event.stopPropagation()}
       >
         <input
           ref={inputRef}
@@ -73,6 +75,6 @@ export function CommandPalette(props: {

exec
/bin/bash -lc "git diff --no-renames ce6910a..b3dd383 -- apps/desktop packages/workspace-core | sed -n '520,900p'" in /home/ice/dev/dohc
 succeeded in 150ms:
@@ -73,6 +75,6 @@ export function CommandPalette(props: {
           )}
         </ul>
       </div>
-    </div>
+    </Overlay>
   );
 }
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
index d9be7b3..37c39ca 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
@@ -5,7 +5,6 @@ import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
 import { DesktopFirstRun } from "./DesktopFirstRun";
 
 const bridge = {
-  getVersion: vi.fn(async () => "0.1.0"),
   getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
   pickWorkspaceRoot: vi.fn(async () => "/home/ice/projects/research"),
   createLocalWorkspace: vi.fn(async () => ({
diff --git a/apps/desktop/src/renderer/DesktopRoot.tsx b/apps/desktop/src/renderer/DesktopRoot.tsx
index 44197bb..19bd7cf 100644
--- a/apps/desktop/src/renderer/DesktopRoot.tsx
+++ b/apps/desktop/src/renderer/DesktopRoot.tsx
@@ -18,6 +18,14 @@ export function DesktopRoot() {
       });
   }, []);
 
+  // Signal first paint when real content is about to mount (not while the
+  // registry IPC is still pending and the root renders null).
+  useEffect(() => {
+    if (loaded) {
+      requestAnimationFrame(() => window.dohcDesktopInternal?.firstPaint());
+    }
+  }, [loaded]);
+
   if (!loaded) return null;
   if (!workspace) {
     return (
diff --git a/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
index f747851..2ca32e6 100644
--- a/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
+++ b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
@@ -9,11 +9,12 @@ import {
   Import,
   LayoutGrid,
 } from "lucide-react";
-import { useCallback, useEffect, useMemo, useState } from "react";
+import { memo, useCallback, useEffect, useMemo, useState } from "react";
 import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
 import { bridge } from "./bridge";
 import { CommandPalette, type Command } from "./CommandPalette";
 import { NewFileDialog } from "./NewFileDialog";
+import { Overlay } from "./Overlay";
 import { toggleTheme } from "./theme";
 
 export type Workspace = WorkspaceSummary;
@@ -28,6 +29,29 @@ function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
   return <FileText size={13} aria-hidden />;
 }
 
+// Memoized so selecting a file only re-renders the two rows whose selected
+// state changed, not the entire tree (onSelect takes the path, not a closure).
+const FileRow = memo(function FileRow(props: {
+  file: WorkspaceFileEntry;
+  selected: boolean;
+  onSelect: (path: string) => void;
+}) {
+  return (
+    <li>
+      <button
+        type="button"
+        onClick={() => props.onSelect(props.file.path)}
+        className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
+          props.selected ? "bg-panel text-ink" : "text-muted hover:text-ink"
+        }`}
+      >
+        <FileIcon kind={props.file.kind} />
+        <span className="truncate">{props.file.path}</span>
+      </button>
+    </li>
+  );
+});
+
 export function DesktopWorkspaceShell(props: {
   workspace: Workspace;
   workspaces: Workspace[];
@@ -41,22 +65,21 @@ export function DesktopWorkspaceShell(props: {
   const [switcherOpen, setSwitcherOpen] = useState(false);
   const [cloudOpen, setCloudOpen] = useState(false);
 
-  const importFiles = useCallback(async () => {
-    await bridge().importWorkspaceFiles({
-      workspaceId: props.workspace.workspaceId,
-    });
+  const refreshFiles = useCallback(async () => {
     const result = await bridge().listWorkspaceFiles({
       workspaceId: props.workspace.workspaceId,
     });
     setFiles(result.files);
   }, [props.workspace.workspaceId]);
 
-  const refreshFiles = useCallback(async () => {
-    const result = await bridge().listWorkspaceFiles({
+  const importFiles = useCallback(async () => {
+    await bridge().importWorkspaceFiles({
       workspaceId: props.workspace.workspaceId,
     });
-    setFiles(result.files);
-  }, [props.workspace.workspaceId]);
+    await refreshFiles();
+  }, [props.workspace.workspaceId, refreshFiles]);
+
+  const selectFile = useCallback((path: string) => setSelected(path), []);
 
   useEffect(() => {
     void refreshFiles();
@@ -183,20 +206,12 @@ export function DesktopWorkspaceShell(props: {
             ) : (
               <ul className="m-0 list-none p-0">
                 {files.map((file) => (
-                  <li key={file.path}>
-                    <button
-                      type="button"
-                      onClick={() => setSelected(file.path)}
-                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
-                        selected === file.path
-                          ? "bg-panel text-ink"
-                          : "text-muted hover:text-ink"
-                      }`}
-                    >
-                      <FileIcon kind={file.kind} />
-                      <span className="truncate">{file.path}</span>
-                    </button>
-                  </li>
+                  <FileRow
+                    key={file.path}
+                    file={file}
+                    selected={selected === file.path}
+                    onSelect={selectFile}
+                  />
                 ))}
               </ul>
             )}
@@ -338,14 +353,10 @@ export function DesktopWorkspaceShell(props: {
         />
       ) : null}
       {cloudOpen ? (
-        <div
-          className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
-          onClick={() => setCloudOpen(false)}
-        >
+        <Overlay onClose={() => setCloudOpen(false)}>
           <div
             data-testid="cloud-sync-panel"
             className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-4 shadow-lg"
-            onClick={(event) => event.stopPropagation()}
           >
             <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
               <Cloud size={14} aria-hidden />
@@ -358,7 +369,7 @@ export function DesktopWorkspaceShell(props: {
               anything.
             </p>
           </div>
-        </div>
+        </Overlay>
       ) : null}
     </div>
   );
diff --git a/apps/desktop/src/renderer/NewFileDialog.tsx b/apps/desktop/src/renderer/NewFileDialog.tsx
index 1c07920..d9a40a5 100644
--- a/apps/desktop/src/renderer/NewFileDialog.tsx
+++ b/apps/desktop/src/renderer/NewFileDialog.tsx
@@ -1,5 +1,6 @@
 import { useEffect, useRef, useState } from "react";
 import { bridge } from "./bridge";
+import { Overlay } from "./Overlay";
 
 export function NewFileDialog(props: {
   workspaceId: string;
@@ -28,14 +29,8 @@ export function NewFileDialog(props: {
   }
 
   return (
-    <div
-      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
-      onClick={props.onClose}
-    >
-      <div
-        className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-3 shadow-lg"
-        onClick={(event) => event.stopPropagation()}
-      >
+    <Overlay onClose={props.onClose}>
+      <div className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-3 shadow-lg">
         <input
           ref={inputRef}
           type="text"
@@ -51,6 +46,6 @@ export function NewFileDialog(props: {
         />
         {error ? <p className="mb-0 mt-2 text-xs text-danger">{error}</p> : null}
       </div>
-    </div>
+    </Overlay>
   );
 }
diff --git a/apps/desktop/src/renderer/Overlay.tsx b/apps/desktop/src/renderer/Overlay.tsx
new file mode 100644
index 0000000..ff46b4a
--- /dev/null
+++ b/apps/desktop/src/renderer/Overlay.tsx
@@ -0,0 +1,15 @@
+import type { ReactNode } from "react";
+
+// Shared modal scaffold: dimmed backdrop that closes on click, with an inner
+// panel that swallows clicks. Used by the command palette, quick-open, new
+// file dialog, and cloud panel so close/backdrop behavior stays identical.
+export function Overlay(props: { onClose: () => void; children: ReactNode }) {
+  return (
+    <div
+      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
+      onClick={props.onClose}
+    >
+      <div onClick={(event) => event.stopPropagation()}>{props.children}</div>
+    </div>
+  );
+}
diff --git a/apps/desktop/src/renderer/main.tsx b/apps/desktop/src/renderer/main.tsx
index 89b5151..2c36497 100644
--- a/apps/desktop/src/renderer/main.tsx
+++ b/apps/desktop/src/renderer/main.tsx
@@ -9,7 +9,6 @@ const container = document.getElementById("root");
 if (container) {
   createRoot(container).render(<DesktopRoot />);
 }
-
-requestAnimationFrame(() => {
-  window.dohcDesktopInternal?.firstPaint();
-});
+// firstPaint is signalled from DesktopRoot when real content (first-run or the
+// workspace shell) actually mounts — not here, where the root is still null
+// until the registry IPC resolves (that would mark a blank background frame).
diff --git a/apps/desktop/src/workspaces/createWorkspaceFolder.ts b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
index ebb2b2a..38a7b7a 100644
--- a/apps/desktop/src/workspaces/createWorkspaceFolder.ts
+++ b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
@@ -1,9 +1,9 @@
 import {
+  checkManifest,
   createWorkspaceManifest,
   defaultWorkspaceMode,
   validateAttachedFolder,
   type WorkspaceKind,
-  type WorkspaceManifest,
 } from "@dohc/workspace-core";
 import { randomUUID } from "node:crypto";
 import { mkdir, readFile, writeFile } from "node:fs/promises";
@@ -22,18 +22,44 @@ Tell your agents who you are and how you like to work.
 This file lives at .context/me.md inside your workspace folder.
 `;
 
-async function readExistingManifest(
-  rootPath: string,
-): Promise<WorkspaceManifest | null> {
+type ManifestState =
+  | { kind: "absent" }
+  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] }
+  | { kind: "blocked"; reason: string };
+
+async function inspectManifest(rootPath: string): Promise<ManifestState> {
+  let raw: string;
+  try {
+    raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
+  } catch {
+    return { kind: "absent" };
+  }
+  let parsed: unknown;
   try {
-    const raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
-    const parsed = JSON.parse(raw) as WorkspaceManifest;
-    return parsed.version === 1 && typeof parsed.workspaceId === "string"
-      ? parsed
-      : null;
+    parsed = JSON.parse(raw);
   } catch {
-    return null;
+    return { kind: "blocked", reason: "this folder has a corrupt .dohc/manifest.json" };
   }
+  const check = checkManifest(parsed);
+  if (check.status === "valid") {
+    return {
+      kind: "valid",
+      workspaceId: check.manifest.workspaceId,
+      workspaceKind: check.manifest.kind,
+      mode: check.manifest.mode,
+    };
+  }
+  if (check.status === "newer-version") {
+    return {
+      kind: "blocked",
+      reason: `this workspace was created by a newer version of dohc (manifest v${check.version})`,
+    };
+  }
+  // A present-but-broken manifest must never be silently overwritten (it may
+  // be the user's data). checkManifest never returns "absent" for a file that
+  // exists, but narrow defensively.
+  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
+  return { kind: "blocked", reason: `this folder has an invalid .dohc/manifest.json: ${reason}` };
 }
 
 export async function createWorkspaceFolder(input: {
@@ -45,15 +71,18 @@ export async function createWorkspaceFolder(input: {
     throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
   }
 
+  const state = await inspectManifest(input.rootPath);
+  if (state.kind === "blocked") {
+    throw new Error(state.reason);
+  }
   // A folder that is already a dohc workspace keeps its identity — sync and
   // history hang off workspaceId, so overwriting the manifest severs them.
-  const existing = await readExistingManifest(input.rootPath);
-  if (existing) {
+  if (state.kind === "valid") {
     return {
-      workspaceId: existing.workspaceId,
+      workspaceId: state.workspaceId,
       rootPath: input.rootPath,
-      kind: existing.kind === "cloud-only" ? input.kind : existing.kind,
-      mode: existing.mode,
+      kind: state.workspaceKind === "cloud-only" ? input.kind : state.workspaceKind,
+      mode: state.mode,
     };
   }
 
@@ -64,9 +93,12 @@ export async function createWorkspaceFolder(input: {
 
   await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
   await mkdir(join(input.rootPath, ".context"), { recursive: true });
+  // wx: manifest is absent (inspectManifest returned "absent"); never clobber
+  // an unexpected file that appeared between the check and the write.
   await writeFile(
     join(input.rootPath, ".dohc", "manifest.json"),
     `${JSON.stringify(manifest, null, 2)}\n`,
+    { flag: "wx" },
   );
   await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
     flag: "wx",
diff --git a/apps/desktop/src/workspaces/registryStore.test.ts b/apps/desktop/src/workspaces/registryStore.test.ts
index 3e62d41..2aaa74d 100644
--- a/apps/desktop/src/workspaces/registryStore.test.ts
+++ b/apps/desktop/src/workspaces/registryStore.test.ts
@@ -1,10 +1,11 @@
-import { mkdtemp } from "node:fs/promises";
+import { mkdtemp, readFile, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { beforeEach, describe, expect, it } from "vitest";
 import { createRegistryStore } from "./registryStore";
 
 let store: ReturnType<typeof createRegistryStore>;
+let registryPath: string;
 
 const personal = {
   workspaceId: "ws-1",
@@ -15,7 +16,8 @@ const personal = {
 
 beforeEach(async () => {
   const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
-  store = createRegistryStore(join(dir, "workspaces.json"));
+  registryPath = join(dir, "workspaces.json");
+  store = createRegistryStore(registryPath);
 });
 
 describe("registry store", () => {
@@ -70,4 +72,31 @@ describe("registry store", () => {
       remoteWorkspaceId: "rw-99",
     });
   });
+
+  it("refuses to wipe a future-version registry", async () => {
+    await writeFile(

exec
/bin/bash -lc "git diff --no-renames ce6910a..b3dd383 -- apps/desktop packages/workspace-core | sed -n '900,1280p'" in /home/ice/dev/dohc
 succeeded in 0ms:
+    await writeFile(
+      registryPath,
+      JSON.stringify({ version: 2, workspaces: [personal] }),
+    );
+    const future = createRegistryStore(registryPath);
+    expect(() => future.list()).toThrow(/newer than supported|refusing to overwrite/i);
+  });
+
+  it("refuses to overwrite a corrupt registry instead of collapsing it to empty", async () => {
+    await writeFile(registryPath, "{ this is not json");
+    const corrupt = createRegistryStore(registryPath);
+    expect(() => corrupt.list()).toThrow(/corrupt|refusing to overwrite/i);
+  });
+
+  it("writes atomically and leaves no temp file behind", async () => {
+    store.register(personal);
+    const onDisk = JSON.parse(await readFile(registryPath, "utf8"));
+    expect(onDisk.workspaces).toHaveLength(1);
+    // The temp file used during the atomic rename must not survive.
+    const { readdirSync } = await import("node:fs");
+    const leftovers = readdirSync(join(registryPath, "..")).filter((f) =>
+      f.includes(".tmp-"),
+    );
+    expect(leftovers).toEqual([]);
+  });
 });
diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
index 19b9714..5f0cefa 100644
--- a/apps/desktop/src/workspaces/registryStore.ts
+++ b/apps/desktop/src/workspaces/registryStore.ts
@@ -1,4 +1,4 @@
-import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
 import { dirname } from "node:path";
 import type { CreatedWorkspace } from "./createWorkspaceFolder";
 
@@ -22,18 +22,55 @@ interface RegistryFile {
 }
 
 export function createRegistryStore(registryFile: string) {
+  // The process exclusively owns this file (single-instance lock), so the
+  // parsed registry is cached after first read and refreshed on write.
+  let cache: RegistryFile | null = null;
+
   function read(): RegistryFile {
+    if (cache) return cache;
+    let text: string;
+    try {
+      text = readFileSync(registryFile, "utf8");
+    } catch {
+      // Genuinely absent: a fresh empty registry is correct.
+      cache = { version: 1, workspaces: [] };
+      return cache;
+    }
+    let parsed: unknown;
     try {
-      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
-      return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
+      parsed = JSON.parse(text);
     } catch {
-      return { version: 1, workspaces: [] };
+      // A present-but-corrupt file is NOT "no workspaces" — refuse rather
+      // than let the next write() collapse real data to empty.
+      throw new Error(
+        `Workspace registry is corrupt (${registryFile}); refusing to overwrite it.`,
+      );
+    }
+    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
+      throw new Error(`Workspace registry has an unexpected shape (${registryFile}).`);
+    }
+    const obj = parsed as Record<string, unknown>;
+    if (obj.version !== 1) {
+      // A future-version registry must be preserved, never silently wiped.
+      throw new Error(
+        `Workspace registry version ${String(obj.version)} is newer than supported; refusing to overwrite it.`,
+      );
+    }
+    if (!Array.isArray(obj.workspaces)) {
+      throw new Error(`Workspace registry "workspaces" is not an array (${registryFile}).`);
     }
+    cache = { version: 1, workspaces: obj.workspaces as RegistryEntry[] };
+    return cache;
   }
 
   function write(registry: RegistryFile): void {
     mkdirSync(dirname(registryFile), { recursive: true });
-    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
+    // Atomic: write a temp file then rename over the target so a crash or
+    // concurrent reader never sees a half-written registry.
+    const tmp = `${registryFile}.tmp-${process.pid}`;
+    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
+    renameSync(tmp, registryFile);
+    cache = registry;
   }
 
   return {
diff --git a/apps/desktop/src/workspaces/workspaceFiles.test.ts b/apps/desktop/src/workspaces/workspaceFiles.test.ts
index f749cfd..0fe55e4 100644
--- a/apps/desktop/src/workspaces/workspaceFiles.test.ts
+++ b/apps/desktop/src/workspaces/workspaceFiles.test.ts
@@ -1,4 +1,5 @@
-import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
+import { existsSync } from "node:fs";
+import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { beforeEach, describe, expect, it } from "vitest";
@@ -27,6 +28,13 @@ describe("createFile", () => {
     await createFile(root, "keep.md");
     expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
   });
+
+  it("refuses to write through a symlinked directory that escapes the workspace", async () => {
+    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
+    await symlink(outside, join(root, "link"), "dir");
+    await expect(createFile(root, "link/evil.md")).rejects.toThrow(/escapes workspace/);
+    expect(existsSync(join(outside, "evil.md"))).toBe(false);
+  });
 });
 
 describe("listFiles", () => {
@@ -42,6 +50,18 @@ describe("listFiles", () => {
       { path: "wallet.sqlite", kind: "database" },
     ]);
   });
+
+  it("does not follow symlinks (file or directory) out of the workspace", async () => {
+    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
+    await writeFile(join(outside, "secret.md"), "leak");
+    await mkdir(join(outside, "sub"), { recursive: true });
+    await writeFile(join(outside, "sub", "deep.md"), "leak");
+    await writeFile(join(root, "real.md"), "");
+    await symlink(join(outside, "secret.md"), join(root, "link.md"), "file");
+    await symlink(outside, join(root, "linkdir"), "dir");
+    const files = await listFiles(root);
+    expect(files).toEqual([{ path: "real.md", kind: "file" }]);
+  });
 });
 
 describe("copyIntoWorkspace", () => {
diff --git a/apps/desktop/src/workspaces/workspaceFiles.ts b/apps/desktop/src/workspaces/workspaceFiles.ts
index 2efe19b..2caa894 100644
--- a/apps/desktop/src/workspaces/workspaceFiles.ts
+++ b/apps/desktop/src/workspaces/workspaceFiles.ts
@@ -3,12 +3,34 @@ import {
   validateUserWritePath,
 } from "@dohc/workspace-core";
 import { constants } from "node:fs";
-import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
-import { basename, dirname, join } from "node:path";
+import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
+import { basename, dirname, join, relative, sep } from "node:path";
+
+// Deepest already-existing ancestor of a (possibly not-yet-created) path —
+// the part realpath can resolve, so we can check containment BEFORE mkdir.
+async function existingAncestor(path: string): Promise<string> {
+  let current = path;
+  for (;;) {
+    try {
+      return await realpath(current);
+    } catch {
+      const parent = dirname(current);
+      if (parent === current) return current;
+      current = parent;
+    }
+  }
+}
 import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
 
 const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
 
+// True iff `child` is the same as or nested under `parent` (both real paths).
+function isInside(parent: string, child: string): boolean {
+  if (child === parent) return true;
+  const rel = relative(parent, child);
+  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}`);
+}
+
 export async function listFiles(
   rootPath: string,
 ): Promise<WorkspaceFileEntry[]> {
@@ -18,16 +40,13 @@ export async function listFiles(
     const dirents = await readdir(dir, { withFileTypes: true });
     for (const dirent of dirents) {
       const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
+      // Never follow symlinks: a dir/file symlink could point outside the
+      // workspace and leak names or recurse into foreign trees.
+      if (dirent.isSymbolicLink()) continue;
       if (dirent.isDirectory()) {
         if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
-      } else {
-        const classified = classifyPath(rel);
-        entries.push({
-          path: rel,
-          kind: classified.kind === "database" ? "database"
-            : classified.kind === "app-source" ? "app-source"
-            : "file",
-        });
+      } else if (dirent.isFile()) {
+        entries.push({ path: rel, kind: classifyPath(rel).kind });
       }
     }
   }
@@ -46,7 +65,20 @@ export async function createFile(
     throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
   }
   const absolute = join(rootPath, validated.normalized);
+  // Lexical validation can't see symlinks: a workspace-internal symlinked
+  // ancestor ("link/evil.md") could resolve outside the root. Check the real
+  // deepest-existing ancestor BEFORE mkdir, so a symlinked ancestor can't even
+  // cause directories to be created outside the workspace.
+  const realRoot = await realpath(rootPath);
+  if (!isInside(realRoot, await existingAncestor(dirname(absolute)))) {
+    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
+  }
   await mkdir(dirname(absolute), { recursive: true });
+  // Re-check after mkdir (the resolved parent now exists) as belt-and-braces;
+  // wx + O_EXCL additionally prevents a final-segment symlink from escaping.
+  if (!isInside(realRoot, await realpath(dirname(absolute)))) {
+    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
+  }
   await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
     if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
   });
diff --git a/packages/workspace-core/src/metadata.ts b/packages/workspace-core/src/metadata.ts
index daf60cd..df2b99e 100644
--- a/packages/workspace-core/src/metadata.ts
+++ b/packages/workspace-core/src/metadata.ts
@@ -1,5 +1,7 @@
 import {
   defaultWorkspaceMode,
+  WORKSPACE_KINDS,
+  WORKSPACE_MODES,
   type WorkspaceKind,
   type WorkspaceMode,
 } from "./workspaceMode";
@@ -26,11 +28,45 @@ export function createWorkspaceManifest(input: {
   };
 }
 
-export interface FileRecord {
-  path: string;
-  contentHash: string;
-}
+export type ManifestCheck =
+  | { status: "valid"; manifest: WorkspaceManifest }
+  | { status: "absent" }
+  | { status: "invalid"; reason: string }
+  | { status: "newer-version"; version: number };
 
-export function createFileRecord(input: FileRecord): FileRecord {
-  return { path: input.path, contentHash: input.contentHash };
+// Fully validates a parsed manifest before it is trusted. A partial manifest
+// (missing/invalid kind or mode) is "invalid", never silently adopted; a
+// higher version is "newer-version" so callers refuse rather than overwrite.
+export function checkManifest(parsed: unknown): ManifestCheck {
+  if (parsed === null || typeof parsed !== "object") {
+    return { status: "invalid", reason: "manifest is not an object" };
+  }
+  const m = parsed as Record<string, unknown>;
+  if (typeof m.version !== "number") {
+    return { status: "invalid", reason: "manifest version is missing" };
+  }
+  if (m.version > 1) {
+    return { status: "newer-version", version: m.version };
+  }
+  if (m.version !== 1) {
+    return { status: "invalid", reason: `unsupported manifest version ${m.version}` };
+  }
+  if (typeof m.workspaceId !== "string" || m.workspaceId.length === 0) {
+    return { status: "invalid", reason: "manifest workspaceId is missing" };
+  }
+  if (!WORKSPACE_KINDS.includes(m.kind as WorkspaceKind)) {
+    return { status: "invalid", reason: "manifest kind is invalid" };
+  }
+  if (!WORKSPACE_MODES.includes(m.mode as WorkspaceMode)) {
+    return { status: "invalid", reason: "manifest mode is invalid" };
+  }
+  return {
+    status: "valid",
+    manifest: {
+      version: 1,
+      workspaceId: m.workspaceId,
+      kind: m.kind as WorkspaceKind,
+      mode: m.mode as WorkspaceMode,
+    },
+  };
 }
diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
index 41c0ffa..233f590 100644
--- a/packages/workspace-core/src/paths.test.ts
+++ b/packages/workspace-core/src/paths.test.ts
@@ -139,6 +139,19 @@ describe("workspace root choice", () => {
     }
   });
 
+  it("rejects leading-double-slash and UNC disguises of root and home", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    expect(validateWorkspaceRootChoice("//home/ice", "/home/ice").ok).toBe(false);
+    expect(validateWorkspaceRootChoice("///", "/home/ice").ok).toBe(false);
+    expect(validateWorkspaceRootChoice("//server", "/home/ice").ok).toBe(false);
+    expect(validateWorkspaceRootChoice("//server/share", "/home/ice").ok).toBe(false);
+  });
+
+  it("rejects case variants of the home directory (case-insensitive filesystems)", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    expect(validateWorkspaceRootChoice("/Home/Ice", "/home/ice").ok).toBe(false);
+  });
+
   it("returns the normalized root so equality checks are canonical", async () => {
     const { validateWorkspaceRootChoice } = await import("./paths");
     const result = validateWorkspaceRootChoice(
diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
index d9b976f..7fd3954 100644
--- a/packages/workspace-core/src/paths.ts
+++ b/packages/workspace-core/src/paths.ts
@@ -65,7 +65,11 @@ export function validateUserWritePath(relativePath: string): WritePathValidation
 export function normalizeAbsolutePath(path: string): string {
   const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
   const rest = drive ? path.slice(drive.length) : path;
-  const unc = rest.startsWith("\\\\") || rest.startsWith("//");
+  // A real UNC path needs a server segment after \\ or //; a bare POSIX
+  // leading // (or ///) is just the filesystem root and must collapse to /,
+  // otherwise "//home/ice" would dodge the home-directory guard.
+  const uncMatch = /^([\\/])\1+([^\\/])/.exec(rest);
+  const unc = drive === "" && uncMatch !== undefined && uncMatch !== null;
   const segments = rest.replaceAll("\\", "/").split("/");
   const out: string[] = [];
   for (const segment of segments) {
@@ -98,10 +102,18 @@ export function validateWorkspaceRootChoice(
   if (!attached.ok) return attached;
   const normalized = normalizeAbsolutePath(rootPath);
   const home = normalizeAbsolutePath(homeDir);
-  if (normalized === "/" || /^[A-Za-z]:$/.test(normalized) || normalized === "//") {
+  // Filesystem root, a drive root (C:), or a UNC server/share root (//server,
+  // //server/share) — never a workspace.
+  if (
+    normalized === "/" ||
+    /^[A-Za-z]:$/.test(normalized) ||
+    /^\/\/[^/]*(\/[^/]*)?$/.test(normalized)
+  ) {
     return { ok: false, reason: "workspace root cannot be the filesystem root" };
   }
-  if (normalized === home) {
+  // Case-insensitive compare: on macOS/Windows "/Home/Ice" aliases the home
+  // directory, so a case variant must not slip past this guard.
+  if (normalized.toLowerCase() === home.toLowerCase()) {
     return { ok: false, reason: "workspace root cannot be the home directory itself" };
   }
   return { ok: true, normalized };
diff --git a/packages/workspace-core/src/workspaceMode.test.ts b/packages/workspace-core/src/workspaceMode.test.ts
index a55e893..eaac933 100644
--- a/packages/workspace-core/src/workspaceMode.test.ts
+++ b/packages/workspace-core/src/workspaceMode.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "vitest";
-import { createFileRecord, createWorkspaceManifest } from "./metadata";
+import { checkManifest, createWorkspaceManifest } from "./metadata";
 import { defaultWorkspaceMode } from "./workspaceMode";
 
 describe("workspace modes", () => {
@@ -22,11 +22,41 @@ describe("workspace modes", () => {
     });
     expect(manifest.mode).toBe("cloud-first-local-copy");
     expect(manifest.version).toBe(1);
+  });
+});
 
-    const record = createFileRecord({
-      path: "notes/today.md",
-      contentHash: "abc123",
+describe("manifest validation", () => {
+  it("accepts a complete v1 manifest", () => {
+    const result = checkManifest({
+      version: 1,
+      workspaceId: "ws-1",
+      kind: "personal",
+      mode: "local-first",
     });
-    expect("mode" in record).toBe(false);
+    expect(result.status).toBe("valid");

exec
/bin/bash -lc "git diff --no-renames ce6910a..b3dd383 -- apps/desktop packages/workspace-core | sed -n '1280,1680p'" in /home/ice/dev/dohc
 succeeded in 0ms:
+    expect(result.status).toBe("valid");
+  });
+
+  it("rejects a partial manifest (missing kind/mode) instead of adopting it", () => {
+    const result = checkManifest({ version: 1, workspaceId: "ws-1" });
+    expect(result.status).toBe("invalid");
+  });
+
+  it("rejects an invalid kind or mode value", () => {
+    expect(
+      checkManifest({ version: 1, workspaceId: "ws-1", kind: "evil", mode: "local-first" }).status,
+    ).toBe("invalid");
+    expect(
+      checkManifest({ version: 1, workspaceId: "ws-1", kind: "personal", mode: "evil" }).status,
+    ).toBe("invalid");
+  });
+
+  it("flags a newer-version manifest so callers refuse to overwrite it", () => {
+    const result = checkManifest({ version: 2, workspaceId: "ws-1" });
+    expect(result.status).toBe("newer-version");
+  });
+
+  it("treats non-objects as invalid", () => {
+    expect(checkManifest(null).status).toBe("invalid");
+    expect(checkManifest("nope").status).toBe("invalid");
   });
 });
diff --git a/packages/workspace-core/src/workspaceMode.ts b/packages/workspace-core/src/workspaceMode.ts
index c686bc7..5a7b24c 100644
--- a/packages/workspace-core/src/workspaceMode.ts
+++ b/packages/workspace-core/src/workspaceMode.ts
@@ -1,9 +1,15 @@
-export type WorkspaceMode =
-  | "local-first"
-  | "cloud-first-local-copy"
-  | "cloud-only";
+// Single source of truth: TS types AND runtime validators (zod enums in the
+// desktop bridge) derive from these tuples, so adding a kind/mode can't drift
+// the type from the runtime check.
+export const WORKSPACE_MODES = [
+  "local-first",
+  "cloud-first-local-copy",
+  "cloud-only",
+] as const;
+export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
 
-export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+export const WORKSPACE_KINDS = ["personal", "shared", "cloud-only"] as const;
+export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
 
 const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
   personal: "local-first",

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/main.ts && sed -n '1,220p' apps/desktop/src/workspaces/createWorkspaceFolder.ts && sed -n '1,220p' apps/desktop/src/workspaces/workspaceFiles.ts && sed -n '1,220p' packages/workspace-core/src/paths.ts && sed -n '1,180p' packages/workspace-core/src/metadata.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import {
  defaultWorkspaceRoot,
  normalizeAbsolutePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { relative, sep } from "node:path";
import {
  AttachWorkspaceFolderPayload,
  CreateLocalWorkspacePayload,
  CreateWorkspaceFilePayload,
  CreateWorkspaceFileResult,
  DefaultWorkspaceRootResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  LaunchMarksResult,
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  PickWorkspaceRootResult,
  WorkspaceRegistryResult,
  WorkspaceSummary,
} from "./ipc/bridgeContract";
import { CHANNELS } from "./ipc/channels";
import { launchMarks } from "./performance/launchMarks";
import { decideNavigation } from "./security/electronSecurity";
import { navigationPolicy } from "./window/createMainWindow";
import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
import {
  effectiveHome,
  findWorkspace,
  listWorkspaces,
  registerWorkspace,
} from "./workspaces/WorkspaceRegistry";
import {
  copyIntoWorkspace,
  createFile,
  listFiles,
} from "./workspaces/workspaceFiles";

function requireWorkspace(workspaceId: string) {
  const workspace = findWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

// Workspace roots the main process itself produced — the default suggestion
// and any folder the user chose through the real OS dialog. A renderer cannot
// invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
// be one of these or a descendant. Populated by getDefaultWorkspaceRoot and
// pickWorkspaceRoot before the renderer can create/attach.
const approvedRoots = new Set<string>();

function approveRoot(rootPath: string): void {
  approvedRoots.add(normalizeAbsolutePath(rootPath));
}

function isApprovedRoot(normalized: string): boolean {
  for (const approved of approvedRoots) {
    if (normalized === approved) return true;
    const rel = relative(approved, normalized);
    if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)) {
      return true;
    }
  }
  return false;
}

// The navigation policy is constant for the process lifetime (env var and
// packaged bundle dir cannot change), so compute it once.
let cachedPolicy: ReturnType<typeof navigationPolicy> | null = null;
function policy() {
  if (!cachedPolicy) cachedPolicy = navigationPolicy();
  return cachedPolicy;
}

// IPC is an untrusted boundary: handlers only answer frames the navigation
// policy itself would allow (exact dev origin or the packaged bundle).
function isTrustedFrame(frameUrl: string): boolean {
  return decideNavigation(frameUrl, policy()).action === "allow";
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url ?? "";
  if (!isTrustedFrame(frameUrl)) {
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
    assertTrustedSender(event);
    // Test seam: native dialogs cannot be driven by Playwright.
    const testPick = process.env.DOHC_TEST_PICK_PATH;
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
      approveRoot(testPick);
      return PickWorkspaceRootResult.parse(testPick);
    }
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (picked) approveRoot(picked);
    return PickWorkspaceRootResult.parse(picked);
  });

  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
    assertTrustedSender(event);
    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
  });

  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
    assertTrustedSender(event);
    const root = defaultWorkspaceRoot(effectiveHome());
    approveRoot(root);
    return DefaultWorkspaceRootResult.parse(root);
  });

  // Validates, canonicalizes, AND confirms the root traces to a main-process
  // suggestion or dialog pick — a renderer cannot scope fs ops to a path it
  // invented. All downstream ops use the normalized root.
  function usableRoot(rootPath: string): string {
    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
    if (!check.ok) throw new Error(check.reason);
    if (!isApprovedRoot(check.normalized)) {
      throw new Error(
        "Workspace root must be chosen through dohc (the default location or the folder picker).",
      );
    }
    return check.normalized;
  }

  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateLocalWorkspacePayload.parse(payload);
    const created = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: input.kind,
    });
    registerWorkspace(created);
    return WorkspaceSummary.parse(created);
  });

  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
    assertTrustedSender(event);
    const input = AttachWorkspaceFolderPayload.parse(payload);
    // Adopts an existing dohc workspace (manifest identity preserved) or
    // turns the folder into a fresh personal workspace in place.
    const attached = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: "personal",
    });
    registerWorkspace(attached);
    return WorkspaceSummary.parse(attached);
  });

  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ListWorkspaceFilesResult.parse({
      files: await listFiles(workspace.rootPath),
    });
  });

  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceFilePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const path = await createFile(workspace.rootPath, input.relativePath);
    return CreateWorkspaceFileResult.parse({ path });
  });

  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      title: "Import files into workspace",
    });
    const imported = result.canceled
      ? []
      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
    return ImportWorkspaceFilesResult.parse({ imported });
  });

  ipcMain.on(CHANNELS.firstPaint, (event) => {
    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
      launchMarks.firstPaint();
    }
  });

  // Double-gated: env flag AND unpackaged build. A packaged app launched
  // with the env var set must never grow test surface.
  if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
      assertTrustedSender(event);
      return LaunchMarksResult.parse(launchMarks.snapshot());
    });
  }
}

// Single-instance lock gates the entire bootstrap, not just a quit() call.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    launchMarks.appReady();
    registerIpcHandlers();
    const { createMainWindow } = await import("./window/createMainWindow");
    createMainWindow();
    launchMarks.firstWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
import {
  checkManifest,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  validateAttachedFolder,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CreatedWorkspace {
  workspaceId: string;
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

const FIRST_CONTEXT = `# About me

Tell your agents who you are and how you like to work.
This file lives at .context/me.md inside your workspace folder.
`;

type ManifestState =
  | { kind: "absent" }
  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] }
  | { kind: "blocked"; reason: string };

async function inspectManifest(rootPath: string): Promise<ManifestState> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "blocked", reason: "this folder has a corrupt .dohc/manifest.json" };
  }
  const check = checkManifest(parsed);
  if (check.status === "valid") {
    return {
      kind: "valid",
      workspaceId: check.manifest.workspaceId,
      workspaceKind: check.manifest.kind,
      mode: check.manifest.mode,
    };
  }
  if (check.status === "newer-version") {
    return {
      kind: "blocked",
      reason: `this workspace was created by a newer version of dohc (manifest v${check.version})`,
    };
  }
  // A present-but-broken manifest must never be silently overwritten (it may
  // be the user's data). checkManifest never returns "absent" for a file that
  // exists, but narrow defensively.
  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
  return { kind: "blocked", reason: `this folder has an invalid .dohc/manifest.json: ${reason}` };
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
}): Promise<CreatedWorkspace> {
  const folderCheck = validateAttachedFolder(input.rootPath);
  if (!folderCheck.ok) {
    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
  }

  const state = await inspectManifest(input.rootPath);
  if (state.kind === "blocked") {
    throw new Error(state.reason);
  }
  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  if (state.kind === "valid") {
    return {
      workspaceId: state.workspaceId,
      rootPath: input.rootPath,
      kind: state.workspaceKind === "cloud-only" ? input.kind : state.workspaceKind,
      mode: state.mode,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: randomUUID(),
    kind: input.kind,
  });

  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
  await mkdir(join(input.rootPath, ".context"), { recursive: true });
  // wx: manifest is absent (inspectManifest returned "absent"); never clobber
  // an unexpected file that appeared between the check and the write.
  await writeFile(
    join(input.rootPath, ".dohc", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
    flag: "wx",
  }).catch((error: unknown) => {
    // An existing me.md is the user's; never overwrite it. Real failures
    // (permissions, disk) must still surface.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });

  return {
    workspaceId: manifest.workspaceId,
    rootPath: input.rootPath,
    kind: input.kind,
    mode: manifest.mode,
  };
}
import {
  classifyPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

// Deepest already-existing ancestor of a (possibly not-yet-created) path —
// the part realpath can resolve, so we can check containment BEFORE mkdir.
async function existingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);

// True iff `child` is the same as or nested under `parent` (both real paths).
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}`);
}

export async function listFiles(
  rootPath: string,
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      // Never follow symlinks: a dir/file symlink could point outside the
      // workspace and leak names or recurse into foreign trees.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        entries.push({ path: rel, kind: classifyPath(rel).kind });
      }
    }
  }

  await walk(rootPath, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export async function createFile(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
  }
  const absolute = join(rootPath, validated.normalized);
  // Lexical validation can't see symlinks: a workspace-internal symlinked
  // ancestor ("link/evil.md") could resolve outside the root. Check the real
  // deepest-existing ancestor BEFORE mkdir, so a symlinked ancestor can't even
  // cause directories to be created outside the workspace.
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(dirname(absolute)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  // Re-check after mkdir (the resolved parent now exists) as belt-and-braces;
  // wx + O_EXCL additionally prevents a final-segment symlink from escaping.
  if (!isInside(realRoot, await realpath(dirname(absolute)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return validated.normalized;
}

// Imports copy external files into the workspace root by basename; existing
// files are never overwritten (skipped, not errored — imports are additive).
export async function copyIntoWorkspace(
  rootPath: string,
  absolutePaths: string[],
): Promise<string[]> {
  const imported: string[] = [];
  for (const source of absolutePaths) {
    const name = basename(source);
    const validated = validateUserWritePath(name);
    if (!validated.ok) continue;
    try {
      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
      imported.push(validated.normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return imported;
}
export function defaultWorkspaceRoot(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, "")}/dohc`;
}

export type FolderValidation = { ok: true } | { ok: false; reason: string };

// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
function isAbsolutePathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

export function validateAttachedFolder(path: string): FolderValidation {
  if (!isAbsolutePathLike(path)) {
    return { ok: false, reason: "attached folders must be absolute paths" };
  }
  return { ok: true };
}

// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
// so a case-sensitive guard would let writes overwrite dohc metadata.
export function isReservedPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower === ".dohc" || lower.startsWith(".dohc/");
}

export type WritePathValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };

export function validateUserWritePath(relativePath: string): WritePathValidation {
  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
  if (isAbsolutePathLike(relativePath)) return { ok: false, reason: "absolute" };
  // Percent-encoded dots/separators are traversal in disguise; decode until
  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
  let decoded = relativePath;
  for (;;) {
    const next = decoded
      .replace(/%25/gi, "%")
      .replace(/%2e/gi, ".")
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\");
    if (next === decoded) break;
    decoded = next;
  }
  // Decoding may reveal an absolute path (%2fetc, C%3A is out of scope but
  // drive letters survive decoding as-is).
  if (isAbsolutePathLike(decoded)) return { ok: false, reason: "absolute" };
  const segments = decoded.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) return { ok: false, reason: "traversal" };
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized.length === 0) return { ok: false, reason: "invalid" };
  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
  return { ok: true, normalized };
}

// Lexical normalization: resolves "." and ".." segments and separator noise
// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
// cannot slip past string comparisons. Preserves drive and UNC prefixes.
export function normalizeAbsolutePath(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = drive ? path.slice(drive.length) : path;
  // A real UNC path needs a server segment after \\ or //; a bare POSIX
  // leading // (or ///) is just the filesystem root and must collapse to /,
  // otherwise "//home/ice" would dodge the home-directory guard.
  const uncMatch = /^([\\/])\1+([^\\/])/.exec(rest);
  const unc = drive === "" && uncMatch !== undefined && uncMatch !== null;
  const segments = rest.replaceAll("\\", "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const prefix = unc ? "//" : "/";
  const joined = `${drive}${prefix}${out.join("/")}`;
  const trimmed = joined.replace(/\/+$/, "");
  return trimmed || (drive ? drive : "/");
}

export type RootChoiceValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

// Registry policy: a workspace root must be a real folder choice — never the
// filesystem root or the home directory itself, which would hand workspace
// file operations the user's entire disk or home. Callers must use the
// returned normalized path so registry equality checks are canonical.
export function validateWorkspaceRootChoice(
  rootPath: string,
  homeDir: string,
): RootChoiceValidation {
  const attached = validateAttachedFolder(rootPath);
  if (!attached.ok) return attached;
  const normalized = normalizeAbsolutePath(rootPath);
  const home = normalizeAbsolutePath(homeDir);
  // Filesystem root, a drive root (C:), or a UNC server/share root (//server,
  // //server/share) — never a workspace.
  if (
    normalized === "/" ||
    /^[A-Za-z]:$/.test(normalized) ||
    /^\/\/[^/]*(\/[^/]*)?$/.test(normalized)
  ) {
    return { ok: false, reason: "workspace root cannot be the filesystem root" };
  }
  // Case-insensitive compare: on macOS/Windows "/Home/Ice" aliases the home
  // directory, so a case variant must not slip past this guard.
  if (normalized.toLowerCase() === home.toLowerCase()) {
    return { ok: false, reason: "workspace root cannot be the home directory itself" };
  }
  return { ok: true, normalized };
}

export type PathClassification =
  | { kind: "app-source"; appName: string }
  | { kind: "database" }
  | { kind: "file" };

const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];

export function classifyPath(relativePath: string): PathClassification {
  const segments = relativePath.split("/");
  const appsIndex = segments.indexOf(".apps");
  const appName = appsIndex === -1 ? undefined : segments[appsIndex + 1];
  if (appName) return { kind: "app-source", appName };
  const lower = relativePath.toLowerCase();
  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { kind: "database" };
  }
  return { kind: "file" };
}
import {
  defaultWorkspaceMode,
  WORKSPACE_KINDS,
  WORKSPACE_MODES,
  type WorkspaceKind,
  type WorkspaceMode,
} from "./workspaceMode";

// Mode lives on the workspace manifest and nowhere else: a workspace is
// local-first, cloud-first, or cloud-only as a whole, never per file.
export interface WorkspaceManifest {
  version: 1;
  workspaceId: string;
  mode: WorkspaceMode;
  kind: WorkspaceKind;
}

export function createWorkspaceManifest(input: {
  workspaceId: string;
  kind: WorkspaceKind;
  mode?: WorkspaceMode;
}): WorkspaceManifest {
  return {
    version: 1,
    workspaceId: input.workspaceId,
    kind: input.kind,
    mode: input.mode ?? defaultWorkspaceMode(input.kind),
  };
}

export type ManifestCheck =
  | { status: "valid"; manifest: WorkspaceManifest }
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "newer-version"; version: number };

// Fully validates a parsed manifest before it is trusted. A partial manifest
// (missing/invalid kind or mode) is "invalid", never silently adopted; a
// higher version is "newer-version" so callers refuse rather than overwrite.
export function checkManifest(parsed: unknown): ManifestCheck {
  if (parsed === null || typeof parsed !== "object") {
    return { status: "invalid", reason: "manifest is not an object" };
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.version !== "number") {
    return { status: "invalid", reason: "manifest version is missing" };
  }
  if (m.version > 1) {
    return { status: "newer-version", version: m.version };
  }
  if (m.version !== 1) {
    return { status: "invalid", reason: `unsupported manifest version ${m.version}` };
  }
  if (typeof m.workspaceId !== "string" || m.workspaceId.length === 0) {
    return { status: "invalid", reason: "manifest workspaceId is missing" };
  }
  if (!WORKSPACE_KINDS.includes(m.kind as WorkspaceKind)) {
    return { status: "invalid", reason: "manifest kind is invalid" };
  }
  if (!WORKSPACE_MODES.includes(m.mode as WorkspaceMode)) {
    return { status: "invalid", reason: "manifest mode is invalid" };
  }
  return {
    status: "valid",
    manifest: {
      version: 1,
      workspaceId: m.workspaceId,
      kind: m.kind as WorkspaceKind,
      mode: m.mode as WorkspaceMode,
    },
  };
}

exec
/bin/bash -lc "cat package.json | sed -n '1,220p'; cat apps/desktop/package.json | sed -n '1,220p'; cat packages/workspace-core/package.json | sed -n '1,160p'; grep -R \"\\\"zod\\\"\" -n package.json apps packages | head -20" in /home/ice/dev/dohc
 succeeded in 219ms:
apps/desktop/src/ipc/bridgeContract.ts:2:import { z } from "zod";
apps/desktop/dist/main/main.js:3:import { z } from "zod";
apps/desktop/package.json:39:    "zod": "^3.25.76"
apps/app/node_modules/.vite/deps/@convex-dev_agent_react.js:1123:		vendor: "zod",
apps/app/node_modules/.vite/deps/@convex-dev_agent_react.js:4543:			vendor: "zod",
apps/app/node_modules/.vite/deps/@convex-dev_agent_react.js:8769:	}) : isSchema(schema) ? schema : "~standard" in schema ? schema["~standard"].vendor === "zod" ? zodSchema(schema) : standardSchema(schema) : schema();
apps/app/package.json:73:    "zod": "^3.23.8"
apps/app/.output/server/_libs/@convex-dev/agent+[...].mjs:5244:		vendor: "zod",
apps/app/.output/server/_libs/ai-sdk__provider-utils+zod.mjs:1741:			vendor: "zod",
apps/app/.output/server/_libs/ai-sdk__provider-utils+zod.mjs:5796:	}) : isSchema(schema) ? schema : "~standard" in schema ? schema["~standard"].vendor === "zod" ? zodSchema(schema) : standardSchema(schema) : schema();
packages/workspace-convex-compat/node_modules/@dohc/workspace-contracts/src/domain.ts:1:import { z } from "zod";
packages/workspace-convex-compat/node_modules/@dohc/workspace-contracts/package.json:13:    "zod": "^3.23.8"
packages/workspace-fs/node_modules/@dohc/workspace-api/node_modules/@dohc/workspace-contracts/src/domain.ts:1:import { z } from "zod";
packages/workspace-fs/node_modules/@dohc/workspace-api/node_modules/@dohc/workspace-contracts/package.json:13:    "zod": "^3.23.8"
packages/workspace-fs/node_modules/@dohc/workspace-contracts/src/domain.ts:1:import { z } from "zod";
packages/workspace-fs/node_modules/@dohc/workspace-contracts/package.json:13:    "zod": "^3.23.8"
packages/workspace-contracts/src/domain.ts:1:import { z } from "zod";
packages/workspace-contracts/package.json:13:    "zod": "^3.23.8"
packages/workspace-postgres/node_modules/@dohc/workspace-contracts/src/domain.ts:1:import { z } from "zod";
packages/workspace-postgres/node_modules/@dohc/workspace-contracts/package.json:13:    "zod": "^3.23.8"

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/performance/launchMarks.ts && sed -n '1,220p' apps/desktop/e2e/desktopLaunch.spec.ts && sed -n '1,280p' apps/desktop/e2e/firstRunWorkspace.spec.ts && sed -n '1,220p' apps/desktop/src/renderer/DesktopRoot.tsx && sed -n '1,180p' apps/desktop/src/renderer/DesktopFirstRun.tsx" in /home/ice/dev/dohc
 succeeded in 0ms:
// Launch instrumentation, alive from the first scaffold per the plan's
// continuous performance enforcement: later phases append marks, Phase 16
// turns the numbers into a hard gate.

const processStart = Date.now();

interface LaunchMarks {
  appReadyMs: number;
  firstWindowMs: number;
  firstPaintMs: number;
}

const marks: Partial<LaunchMarks> = {};

function markOnce(key: keyof LaunchMarks): void {
  if (marks[key] === undefined) marks[key] = Date.now() - processStart;
}

export const launchMarks = {
  appReady: () => markOnce("appReadyMs"),
  firstWindow: () => markOnce("firstWindowMs"),
  firstPaint: () => markOnce("firstPaintMs"),
  snapshot: (): Partial<LaunchMarks> => ({ ...marks }),
};
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { launchApp } from "./launch";

const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
const PERF_FILE = "test-results/performance/desktop-performance.json";

test("launches dohc desktop and renders the first-run shell", async () => {
  const app = await launchApp();

  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/first-run--1280x800--light.png`,
  });

  // Launch performance marks flow through the test-only bridge from day one;
  // Phase 16 ratchets these numbers into a hard gate.
  const marks = await page.evaluate(() =>
    (window as never as {
      dohcDesktopTest?: { getLaunchMarks(): Promise<Record<string, number>> };
    }).dohcDesktopTest?.getLaunchMarks(),
  );
  expect(marks).toBeTruthy();
  expect(marks?.appReadyMs).toBeGreaterThan(0);
  expect(marks?.firstWindowMs).toBeGreaterThan(0);
  expect(marks?.firstPaintMs).toBeGreaterThan(0);

  await mkdir("test-results/performance", { recursive: true });
  await writeFile(
    PERF_FILE,
    JSON.stringify({ phase: 2, launch: marks }, null, 2),
  );

  await app.close();
});
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright";
import { launchApp } from "./launch";

const SCREENSHOT_DIR = "test-results/screenshots/phase-03";

async function launchFirstRun(): Promise<{
  app: ElectronApplication;
  page: Page;
  testHome: string;
}> {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();
  return { app, page, testHome };
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);
}

test("first run creates a real workspace folder and lands in a native shell", async () => {
  const { app, page, testHome } = await launchFirstRun();

  // --- First run: suggests <home>/dohc, no login, cloud sync optional ---
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await expect(page.getByText(join(testHome, "dohc"))).toBeVisible();
  await expect(page.getByText(/cloud sync is optional/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /enable dohc cloud sync/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /sign in|log in|sign up/i }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectNoOverflow(page);
  await shot(page, "first-run");

  // --- Create the workspace: a real folder must appear on disk ---
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  const workspaceRoot = join(testHome, "dohc", "personal");
  expect(existsSync(join(workspaceRoot, ".dohc", "manifest.json"))).toBe(true);
  const manifest = JSON.parse(
    readFileSync(join(workspaceRoot, ".dohc", "manifest.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    version: 1,
    kind: "personal",
    mode: "local-first",
  });

  // --- Shell surfaces: sidebar/file tree, status, agent panel ---
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("sync-status")).toBeVisible();
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  // Agent activity is a panel with an empty-state action, not a paragraph.
  await expect(page.getByTestId("agent-panel")).toContainText(/no agent runs/i);

  // --- Keyboard: new file ---
  await page.keyboard.press("ControlOrMeta+n");
  const nameInput = page.getByRole("textbox", { name: /file name/i });
  await expect(nameInput).toBeVisible();
  await nameInput.fill("notes/today.md");
  await nameInput.press("Enter");
  await expect(
    page.getByTestId("file-tree").getByText("today.md"),
  ).toBeVisible();
  expect(existsSync(join(workspaceRoot, "notes", "today.md"))).toBe(true);

  // --- Keyboard: command palette opens, filters, closes ---
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(5);
  await expect(palette).toContainText(/import files/i);
  await expect(palette).toContainText(/connect dohc cloud/i);
  await page.keyboard.type("new");
  await expect(palette.getByRole("option").first()).toContainText(/new/i);
  await shot(page, "command-palette");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // --- Keyboard: quick-open jumps to a file ---
  await page.keyboard.press("ControlOrMeta+p");
  const quickOpen = page.getByTestId("quick-open");
  await expect(quickOpen).toBeVisible();
  await page.keyboard.type("today");
  await expect(quickOpen.getByRole("option").first()).toContainText(
    "notes/today.md",
  );
  await page.keyboard.press("Enter");
  await expect(quickOpen).toHaveCount(0);
  await expect(page.getByTestId("workspace-shell")).toContainText(
    "notes/today.md",
  );
  await shot(page, "file-preview");

  // --- Workspace switcher lists the current workspace ---
  await page.getByTestId("workspace-switcher").click();
  const switcherList = page.getByRole("listbox", { name: /workspaces/i });
  await expect(switcherList.getByRole("option")).toHaveCount(1);
  await expect(switcherList).toContainText("personal");
  await page.getByTestId("workspace-switcher").click();

  // --- Cloud connect is an honest surface, not a gate ---
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await expect(page.getByTestId("cloud-sync-panel")).toContainText(
    /fully functional locally/i,
  );
  await page.mouse.click(10, 10); // backdrop click closes
  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);

  // --- Layout holds at both required sizes, light and dark ---
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await expectNoOverflow(page);
    await shot(page, "workspace-shell");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.dataset.theme),
    )
    .toBe("dark");
  await expectNoOverflow(page);
  await shot(page, "workspace-shell");
  await page.emulateMedia({ colorScheme: "light" });

  // --- No marketing chrome anywhere in the shell ---
  await expect(
    page.getByText(/get started free|pricing|trusted by/i),
  ).toHaveCount(0);

  await app.close();
});

test("attaching an existing dohc workspace preserves its identity", async () => {
  // Pre-create a workspace folder with a known manifest identity.
  const elsewhere = await mkdtemp(join(tmpdir(), "dohc-existing-"));
  const existingRoot = join(elsewhere, "finance");
  await mkdir(join(existingRoot, ".dohc"), { recursive: true });
  await writeFile(
    join(existingRoot, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId: "ws-keep-this-identity",
      kind: "personal",
      mode: "local-first",
    }),
  );
  await writeFile(join(existingRoot, "budget.md"), "# Budget");

  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({
    DOHC_TEST_HOME: testHome,
    DOHC_TEST_PICK_PATH: existingRoot,
  });
  const page = await app.firstWindow();

  await page
    .getByRole("button", { name: /open an existing folder/i })
    .click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.getByTestId("file-tree")).toContainText("budget.md");

  // Identity preserved: the manifest still carries the original workspaceId.
  const manifest = JSON.parse(
    readFileSync(join(existingRoot, ".dohc", "manifest.json"), "utf8"),
  );
  expect(manifest.workspaceId).toBe("ws-keep-this-identity");

  await app.close();
});

test("returning user lands directly in the shell, not first-run", async () => {
  const { app, page, testHome } = await launchFirstRun();
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await app.close();

  // Relaunch with the same test home: registry remembers the workspace.
  const second = await launchApp({ DOHC_TEST_HOME: testHome });
  const page2 = await second.firstWindow();
  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
  await expect(
    page2.getByRole("button", { name: /create workspace/i }),
  ).toHaveCount(0);
  await second.close();
});
import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import { DesktopFirstRun } from "./DesktopFirstRun";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";

export function DesktopRoot() {
  const [loaded, setLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    void bridge()
      .getWorkspaceRegistry()
      .then((registry) => {
        setWorkspaces(registry.workspaces);
        setWorkspace(registry.workspaces[0] ?? null);
        setLoaded(true);
      });
  }, []);

  // Signal first paint when real content is about to mount (not while the
  // registry IPC is still pending and the root renders null).
  useEffect(() => {
    if (loaded) {
      requestAnimationFrame(() => window.dohcDesktopInternal?.firstPaint());
    }
  }, [loaded]);

  if (!loaded) return null;
  if (!workspace) {
    return (
      <DesktopFirstRun
        onWorkspaceReady={(created) => {
          setWorkspaces([created]);
          setWorkspace(created);
        }}
      />
    );
  }
  return (
    <DesktopWorkspaceShell
      // Remount on switch: file list and selection are workspace-local and
      // must never leak from workspace A into workspace B.
      key={workspace.workspaceId}
      workspace={workspace}
      workspaces={workspaces}
      onSwitchWorkspace={setWorkspace}
    />
  );
}
import { Cloud, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";

// First launch is a working tool, not a marketing page: pick where your
// files live, create the folder, start working. No account exists here.
export function DesktopFirstRun(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudNote, setCloudNote] = useState(false);

  useEffect(() => {
    void bridge().getDefaultWorkspaceRoot().then(setRoot);
  }, []);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setRoot(picked);
  }

  async function createWorkspace() {
    if (!root || creating) return;
    setCreating(true);
    try {
      const workspace = await bridge().createLocalWorkspace({
        rootPath: `${root}/personal`,
        kind: "personal",
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  }

  async function openExisting() {
    const picked = await bridge().pickWorkspaceRoot();
    if (!picked) return;
    try {
      const workspace = await bridge().attachWorkspaceFolder({
        rootPath: picked,
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
      <div className="flex flex-col items-center gap-1">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">dohc</h1>
        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
      </div>

      <div className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
            Workspace location
          </span>
          <div className="flex items-start justify-between gap-2">
            {/* The whole point of this screen is where files live: never
                truncate the path. */}
            <code className="break-all font-mono text-[13px] leading-snug text-ink">
              {root ?? "…"}
            </code>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
            >
              <FolderOpen size={13} aria-hidden />
              Choose a different folder
            </button>
          </div>
        </div>

        <button
          type="button"
          disabled={!root || creating}
          onClick={() => void createWorkspace()}
          className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create workspace"}
        </button>

        <button
          type="button"
          onClick={() => void openExisting()}
          className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
        >
          Open an existing folder as a workspace
        </button>

        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}

        <div className="flex items-center justify-between gap-4">
          <p className="m-0 text-xs text-subtle">
            Works offline, no account needed. Cloud sync is optional.
          </p>
          <button
            type="button"
            onClick={() => setCloudNote((open) => !open)}
            className="flex shrink-0 items-center gap-1 text-xs text-subtle hover:text-ink"
          >
            <Cloud size={12} aria-hidden />
            Enable dohc Cloud sync
          </button>
        </div>
        {cloudNote ? (
          <p className="m-0 rounded bg-panel-2 px-2.5 py-2 text-xs leading-relaxed text-muted">
            Cloud sync arrives with dohc Cloud accounts — sharing, backup, and
            teams. Your workspace stays fully functional locally, and you can
            connect it later without moving anything.
          </p>
        ) : null}
      </div>
    </div>
  );
}

exec
/bin/bash -lc "grep -R \"getVersion\\|desktop:get-version\\|dohcDesktop\" -n apps/desktop/src packages | head -80 && sed -n '1,220p' apps/desktop/src/renderer/bridge.ts && sed -n '1,220p' apps/desktop/src/global.d.ts 2>/dev/null || true && find apps/desktop/src -maxdepth 2 -type f -name \"*.d.ts\" -print" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/src/preload.ts:29:contextBridge.exposeInMainWorld("dohcDesktop", bridge);
apps/desktop/src/preload.ts:32:contextBridge.exposeInMainWorld("dohcDesktopInternal", {
apps/desktop/src/preload.ts:42:  contextBridge.exposeInMainWorld("dohcDesktopTest", {
apps/desktop/src/renderer/bridge.ts:5:    dohcDesktop?: DohcDesktopBridge;
apps/desktop/src/renderer/bridge.ts:6:    dohcDesktopInternal?: { firstPaint(): void };
apps/desktop/src/renderer/bridge.ts:11:  const api = window.dohcDesktop;
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:29:  vi.stubGlobal("dohcDesktop", bridge);
apps/desktop/src/renderer/DesktopRoot.tsx:25:      requestAnimationFrame(() => window.dohcDesktopInternal?.firstPaint());
import type { DohcDesktopBridge } from "../ipc/bridgeContract";

declare global {
  interface Window {
    dohcDesktop?: DohcDesktopBridge;
    dohcDesktopInternal?: { firstPaint(): void };
  }
}

export function bridge(): DohcDesktopBridge {
  const api = window.dohcDesktop;
  if (!api) throw new Error("dohc desktop bridge is unavailable");
  return api;
}

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/WorkspaceRegistry.ts && git show ce6910a:apps/desktop/src/workspaces/WorkspaceRegistry.ts | sed -n '1,220p' && git show ce6910a:apps/desktop/src/workspaces/registryStore.ts | sed -n '1,220p'" in /home/ice/dev/dohc
 succeeded in 0ms:
import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createRegistryStore, type RegistryEntry } from "./registryStore";

// Electron wiring over the pure registry store. The registry lives in
// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
// hermetic (gated on test env AND unpackaged build).

function testHome(): string | null {
  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
    ? (process.env.DOHC_TEST_HOME ?? null)
    : null;
}

export function effectiveHome(): string {
  return testHome() ?? homedir();
}

let cachedStore: ReturnType<typeof createRegistryStore> | null = null;

function store() {
  if (!cachedStore) {
    const base = testHome() ?? app.getPath("userData");
    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
  }
  return cachedStore;
}

export function listWorkspaces(): RegistryEntry[] {
  return store().list();
}

export function registerWorkspace(workspace: CreatedWorkspace): void {
  store().register(workspace);
}

export function findWorkspace(workspaceId: string): RegistryEntry | null {
  return store().find(workspaceId);
}
import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createRegistryStore, type RegistryEntry } from "./registryStore";

// Electron wiring over the pure registry store. The registry lives in
// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
// hermetic (gated on test env AND unpackaged build).

function testHome(): string | null {
  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
    ? (process.env.DOHC_TEST_HOME ?? null)
    : null;
}

export function effectiveHome(): string {
  return testHome() ?? homedir();
}

let cachedStore: ReturnType<typeof createRegistryStore> | null = null;

function store() {
  if (!cachedStore) {
    const base = testHome() ?? app.getPath("userData");
    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
  }
  return cachedStore;
}

export function listWorkspaces(): RegistryEntry[] {
  return store().list();
}

export function registerWorkspace(workspace: CreatedWorkspace): void {
  store().register(workspace);
}

export function findWorkspace(workspaceId: string): RegistryEntry | null {
  return store().find(workspaceId);
}
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Pure registry persistence: a JSON file of known local workspaces. The
// electron wiring (userData path, test-home seam) lives in
// WorkspaceRegistry.ts; this module is unit-testable with a temp file.

export interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
}

export interface RegistryEntry extends CreatedWorkspace {
  // Present only after the user explicitly enables cloud sync (Phase 9).
  remote?: RemoteIdentity;
}

interface RegistryFile {
  version: 1;
  workspaces: RegistryEntry[];
}

export function createRegistryStore(registryFile: string) {
  function read(): RegistryFile {
    try {
      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
      return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
    } catch {
      return { version: 1, workspaces: [] };
    }
  }

  function write(registry: RegistryFile): void {
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  }

  return {
    registryFile,

    list(): RegistryEntry[] {
      return read().workspaces;
    },

    find(workspaceId: string): RegistryEntry | null {
      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
    },

    register(workspace: RegistryEntry): void {
      const registry = read();
      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
      }
      // Two roots with one workspaceId would make file operations silently
      // target whichever registered first (e.g., attaching a copied folder).
      if (
        registry.workspaces.some(
          (w) => w.workspaceId === workspace.workspaceId,
        )
      ) {
        throw new Error(
          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
        );
      }
      registry.workspaces.push(workspace);
      write(registry);
    },

    setRemote(workspaceId: string, remote: RemoteIdentity): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      entry.remote = remote;
      write(registry);
    },
  };
}

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/registryStore.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Pure registry persistence: a JSON file of known local workspaces. The
// electron wiring (userData path, test-home seam) lives in
// WorkspaceRegistry.ts; this module is unit-testable with a temp file.

export interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
}

export interface RegistryEntry extends CreatedWorkspace {
  // Present only after the user explicitly enables cloud sync (Phase 9).
  remote?: RemoteIdentity;
}

interface RegistryFile {
  version: 1;
  workspaces: RegistryEntry[];
}

export function createRegistryStore(registryFile: string) {
  // The process exclusively owns this file (single-instance lock), so the
  // parsed registry is cached after first read and refreshed on write.
  let cache: RegistryFile | null = null;

  function read(): RegistryFile {
    if (cache) return cache;
    let text: string;
    try {
      text = readFileSync(registryFile, "utf8");
    } catch {
      // Genuinely absent: a fresh empty registry is correct.
      cache = { version: 1, workspaces: [] };
      return cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A present-but-corrupt file is NOT "no workspaces" — refuse rather
      // than let the next write() collapse real data to empty.
      throw new Error(
        `Workspace registry is corrupt (${registryFile}); refusing to overwrite it.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Workspace registry has an unexpected shape (${registryFile}).`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== 1) {
      // A future-version registry must be preserved, never silently wiped.
      throw new Error(
        `Workspace registry version ${String(obj.version)} is newer than supported; refusing to overwrite it.`,
      );
    }
    if (!Array.isArray(obj.workspaces)) {
      throw new Error(`Workspace registry "workspaces" is not an array (${registryFile}).`);
    }
    cache = { version: 1, workspaces: obj.workspaces as RegistryEntry[] };
    return cache;
  }

  function write(registry: RegistryFile): void {
    mkdirSync(dirname(registryFile), { recursive: true });
    // Atomic: write a temp file then rename over the target so a crash or
    // concurrent reader never sees a half-written registry.
    const tmp = `${registryFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(tmp, registryFile);
    cache = registry;
  }

  return {
    registryFile,

    list(): RegistryEntry[] {
      return read().workspaces;
    },

    find(workspaceId: string): RegistryEntry | null {
      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
    },

    register(workspace: RegistryEntry): void {
      const registry = read();
      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
      }
      // Two roots with one workspaceId would make file operations silently
      // target whichever registered first (e.g., attaching a copied folder).
      if (
        registry.workspaces.some(
          (w) => w.workspaceId === workspace.workspaceId,
        )
      ) {
        throw new Error(
          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
        );
      }
      registry.workspaces.push(workspace);
      write(registry);
    },

    setRemote(workspaceId: string, remote: RemoteIdentity): void {
      const registry = read();
      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
      entry.remote = remote;
      write(registry);
    },
  };
}

exec
/bin/bash -lc 'git log --format=fuller -1 b3dd383 && git show --format=%B --no-patch b3dd383' in /home/ice/dev/dohc
 succeeded in 0ms:
commit b3dd38339a6d04c543b82a71b358d8163eab6b48
Author:     Ice de Vera <iestyndevera@gmail.com>
AuthorDate: Wed Jun 10 19:16:08 2026 +0800
Commit:     Ice de Vera <iestyndevera@gmail.com>
CommitDate: Wed Jun 10 19:16:08 2026 +0800

    phase4(fix): close checkpoint-1 security and data-loss findings
    
    First major security checkpoint over the whole branch (31-agent
    adversarial sweep + Codex xhigh + scenario consult). Confirmed fixes:
    - symlink write-escape in createFile (realpath containment before mkdir)
    - registry version-wipe + non-atomic write (throw-not-collapse; atomic
      temp+rename; parsed cache)
    - malformed/newer manifest adoption (checkManifest validation; never
      overwrite a present manifest)
    - renderer-controlled arbitrary workspace root (approvedRoots binding)
    - listFiles symlink-following; // home-guard bypass; UNC/case-variant home
    Lean wins: delete dead createFileRecord + consumer-less getVersion,
    single-source kind/mode enums, preload typed against contract, Overlay
    + launchApp dedup, IPC length caps. Perf-correctness: firstPaint on real
    content, registry parsed cache, memoized FileRow. All 3 HIGH fixes
    re-verified. workspace-core 47, desktop 42, E2E 4, smoke — green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
phase4(fix): close checkpoint-1 security and data-loss findings

First major security checkpoint over the whole branch (31-agent
adversarial sweep + Codex xhigh + scenario consult). Confirmed fixes:
- symlink write-escape in createFile (realpath containment before mkdir)
- registry version-wipe + non-atomic write (throw-not-collapse; atomic
  temp+rename; parsed cache)
- malformed/newer manifest adoption (checkManifest validation; never
  overwrite a present manifest)
- renderer-controlled arbitrary workspace root (approvedRoots binding)
- listFiles symlink-following; // home-guard bypass; UNC/case-variant home
Lean wins: delete dead createFileRecord + consumer-less getVersion,
single-source kind/mode enums, preload typed against contract, Overlay
+ launchApp dedup, IPC length caps. Perf-correctness: firstPaint on real
content, registry parsed cache, memoized FileRow. All 3 HIGH fixes
re-verified. workspace-core 47, desktop 42, E2E 4, smoke — green.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>


exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/security/electronSecurity.ts && sed -n '1,260p' apps/desktop/src/window/createMainWindow.ts && sed -n '1,220p' apps/desktop/src/ipc/channels.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { isAbsolute } from "node:path";

export interface MainWindowWebPreferences {
  preload: string;
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
}

export function createMainWindowWebPreferences(
  preloadPath: string,
): MainWindowWebPreferences {
  if (!isAbsolute(preloadPath)) {
    throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
  }
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  };
}

export interface NavigationDecision {
  action: "allow" | "deny";
}

export interface NavigationPolicy {
  // Exact URL origins (scheme://host:port), compared with ===, never prefix:
  // startsWith would allow http://localhost:5173.evil.com.
  httpOrigins: string[];
  // The packaged renderer bundle directory as a file:// href prefix; a bare
  // "file://" allowance would open every local file to navigation.
  fileUrlPrefix: string | null;
}

// The renderer may only navigate within the app itself: the packaged
// bundle directory or the dev server's exact origin. Everything else,
// including unparseable URLs, is denied.
export function decideNavigation(
  targetUrl: string,
  policy: NavigationPolicy,
): NavigationDecision {
  try {
    const url = new URL(targetUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return {
        action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny",
      };
    }
    if (url.protocol === "file:" && policy.fileUrlPrefix) {
      return {
        action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny",
      };
    }
  } catch {
    // fall through to deny
  }
  return { action: "deny" };
}

// window.open never creates a BrowserWindow (callers always deny). http(s)
// targets are handed to the OS browser; every other scheme is dropped.
export function shouldOpenExternally(targetUrl: string): boolean {
  try {
    const protocol = new URL(targetUrl).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// The dev-server URL is only honored in unpackaged dev builds and only when
// it points at loopback: a packaged app launched with ELECTRON_RENDERER_URL
// set must never load (or IPC-trust) an arbitrary origin.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function validateDevServerUrl(
  raw: string | undefined,
  isPackaged: boolean,
): string | null {
  if (!raw || isPackaged) return null;
  try {
    const url = new URL(raw);
    const httpLike = url.protocol === "http:" || url.protocol === "https:";
    return httpLike && LOOPBACK_HOSTS.has(url.hostname) ? raw : null;
  } catch {
    return null;
  }
}
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  shouldOpenExternally,
  validateDevServerUrl,
  type NavigationPolicy,
} from "../security/electronSecurity";

// Warm paper — set before first paint so launch never flashes white.
const BACKGROUND_COLOR = "#faf7f2";

function devServerUrl(): string | null {
  return validateDevServerUrl(
    process.env.ELECTRON_RENDERER_URL,
    app.isPackaged,
  );
}

export function navigationPolicy(): NavigationPolicy {
  const devServer = devServerUrl();
  if (devServer) {
    // Dev: exact loopback dev-server origin only; no file navigation at all.
    return { httpOrigins: [new URL(devServer).origin], fileUrlPrefix: null };
  }
  // Prod: only the packaged renderer bundle directory.
  const rendererDir = join(import.meta.dirname, "../renderer/");
  return { httpOrigins: [], fileUrlPrefix: pathToFileURL(rendererDir).href };
}

export function createMainWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: BACKGROUND_COLOR,
    webPreferences: createMainWindowWebPreferences(preloadPath),
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Top-frame navigations, server redirects, and subframe navigations all
  // go through the same policy: each is a separate Electron surface.
  const denyDisallowed = (event: { preventDefault(): void }, url: string) => {
    if (decideNavigation(url, navigationPolicy()).action === "deny") {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", denyDisallowed);
  window.webContents.on("will-redirect", denyDisallowed);
  window.webContents.on("will-frame-navigate", (event) => {
    denyDisallowed(event, event.url);
  });

  window.once("ready-to-show", () => window.show());

  const devServer = devServerUrl();
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}
export const CHANNELS = {
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
  createLocalWorkspace: "desktop:create-local-workspace",
  attachWorkspaceFolder: "desktop:attach-workspace-folder",
  listWorkspaceFiles: "desktop:list-workspace-files",
  createWorkspaceFile: "desktop:create-workspace-file",
  importWorkspaceFiles: "desktop:import-workspace-files",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

exec
/bin/bash -lc "node - <<'NODE'
const path=require('node:path');
for (const [p,c] of [['C:/ws','D:/outside'], ['C:\\\\ws','D:\\\\outside'], ['C:/ws','C:/outside'], ['//server/share/ws','//other/share/out']]) {
 const rel=path.win32.relative(p,c);
 console.log(p,'->',c,'=',JSON.stringify(rel), 'starts ..', rel.startsWith('..'), 'starts sep', rel.startsWith(path.win32.sep));
}
NODE" in /home/ice/dev/dohc
 succeeded in 129ms:
C:/ws -> D:/outside = "D:\\outside" starts .. false starts sep false
C:\ws -> D:\outside = "D:\\outside" starts .. false starts sep false
C:/ws -> C:/outside = "..\\outside" starts .. true starts sep false
//server/share/ws -> //other/share/out = "\\\\other\\share\\out" starts .. false starts sep true

exec
/bin/bash -lc "nl -ba apps/desktop/src/main.ts | sed -n '42,75p'; nl -ba apps/desktop/src/workspaces/workspaceFiles.ts | sed -n '1,40p'; nl -ba packages/workspace-core/src/paths.ts | sed -n '60,118p'; nl -ba apps/desktop/src/workspaces/registryStore.ts | sed -n '20,72p'; nl -ba apps/desktop/src/workspaces/createWorkspaceFolder.ts | sed -n '20,70p'" in /home/ice/dev/dohc
 succeeded in 0ms:
    42	  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    43	  return workspace;
    44	}
    45	
    46	// Workspace roots the main process itself produced — the default suggestion
    47	// and any folder the user chose through the real OS dialog. A renderer cannot
    48	// invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
    49	// be one of these or a descendant. Populated by getDefaultWorkspaceRoot and
    50	// pickWorkspaceRoot before the renderer can create/attach.
    51	const approvedRoots = new Set<string>();
    52	
    53	function approveRoot(rootPath: string): void {
    54	  approvedRoots.add(normalizeAbsolutePath(rootPath));
    55	}
    56	
    57	function isApprovedRoot(normalized: string): boolean {
    58	  for (const approved of approvedRoots) {
    59	    if (normalized === approved) return true;
    60	    const rel = relative(approved, normalized);
    61	    if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)) {
    62	      return true;
    63	    }
    64	  }
    65	  return false;
    66	}
    67	
    68	// The navigation policy is constant for the process lifetime (env var and
    69	// packaged bundle dir cannot change), so compute it once.
    70	let cachedPolicy: ReturnType<typeof navigationPolicy> | null = null;
    71	function policy() {
    72	  if (!cachedPolicy) cachedPolicy = navigationPolicy();
    73	  return cachedPolicy;
    74	}
    75	
     1	import {
     2	  classifyPath,
     3	  validateUserWritePath,
     4	} from "@dohc/workspace-core";
     5	import { constants } from "node:fs";
     6	import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
     7	import { basename, dirname, join, relative, sep } from "node:path";
     8	
     9	// Deepest already-existing ancestor of a (possibly not-yet-created) path —
    10	// the part realpath can resolve, so we can check containment BEFORE mkdir.
    11	async function existingAncestor(path: string): Promise<string> {
    12	  let current = path;
    13	  for (;;) {
    14	    try {
    15	      return await realpath(current);
    16	    } catch {
    17	      const parent = dirname(current);
    18	      if (parent === current) return current;
    19	      current = parent;
    20	    }
    21	  }
    22	}
    23	import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
    24	
    25	const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
    26	
    27	// True iff `child` is the same as or nested under `parent` (both real paths).
    28	function isInside(parent: string, child: string): boolean {
    29	  if (child === parent) return true;
    30	  const rel = relative(parent, child);
    31	  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}`);
    32	}
    33	
    34	export async function listFiles(
    35	  rootPath: string,
    36	): Promise<WorkspaceFileEntry[]> {
    37	  const entries: WorkspaceFileEntry[] = [];
    38	
    39	  async function walk(dir: string, prefix: string): Promise<void> {
    40	    const dirents = await readdir(dir, { withFileTypes: true });
    60	}
    61	
    62	// Lexical normalization: resolves "." and ".." segments and separator noise
    63	// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
    64	// cannot slip past string comparisons. Preserves drive and UNC prefixes.
    65	export function normalizeAbsolutePath(path: string): string {
    66	  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
    67	  const rest = drive ? path.slice(drive.length) : path;
    68	  // A real UNC path needs a server segment after \\ or //; a bare POSIX
    69	  // leading // (or ///) is just the filesystem root and must collapse to /,
    70	  // otherwise "//home/ice" would dodge the home-directory guard.
    71	  const uncMatch = /^([\\/])\1+([^\\/])/.exec(rest);
    72	  const unc = drive === "" && uncMatch !== undefined && uncMatch !== null;
    73	  const segments = rest.replaceAll("\\", "/").split("/");
    74	  const out: string[] = [];
    75	  for (const segment of segments) {
    76	    if (segment === "" || segment === ".") continue;
    77	    if (segment === "..") {
    78	      out.pop();
    79	      continue;
    80	    }
    81	    out.push(segment);
    82	  }
    83	  const prefix = unc ? "//" : "/";
    84	  const joined = `${drive}${prefix}${out.join("/")}`;
    85	  const trimmed = joined.replace(/\/+$/, "");
    86	  return trimmed || (drive ? drive : "/");
    87	}
    88	
    89	export type RootChoiceValidation =
    90	  | { ok: true; normalized: string }
    91	  | { ok: false; reason: string };
    92	
    93	// Registry policy: a workspace root must be a real folder choice — never the
    94	// filesystem root or the home directory itself, which would hand workspace
    95	// file operations the user's entire disk or home. Callers must use the
    96	// returned normalized path so registry equality checks are canonical.
    97	export function validateWorkspaceRootChoice(
    98	  rootPath: string,
    99	  homeDir: string,
   100	): RootChoiceValidation {
   101	  const attached = validateAttachedFolder(rootPath);
   102	  if (!attached.ok) return attached;
   103	  const normalized = normalizeAbsolutePath(rootPath);
   104	  const home = normalizeAbsolutePath(homeDir);
   105	  // Filesystem root, a drive root (C:), or a UNC server/share root (//server,
   106	  // //server/share) — never a workspace.
   107	  if (
   108	    normalized === "/" ||
   109	    /^[A-Za-z]:$/.test(normalized) ||
   110	    /^\/\/[^/]*(\/[^/]*)?$/.test(normalized)
   111	  ) {
   112	    return { ok: false, reason: "workspace root cannot be the filesystem root" };
   113	  }
   114	  // Case-insensitive compare: on macOS/Windows "/Home/Ice" aliases the home
   115	  // directory, so a case variant must not slip past this guard.
   116	  if (normalized.toLowerCase() === home.toLowerCase()) {
   117	    return { ok: false, reason: "workspace root cannot be the home directory itself" };
   118	  }
    20	  version: 1;
    21	  workspaces: RegistryEntry[];
    22	}
    23	
    24	export function createRegistryStore(registryFile: string) {
    25	  // The process exclusively owns this file (single-instance lock), so the
    26	  // parsed registry is cached after first read and refreshed on write.
    27	  let cache: RegistryFile | null = null;
    28	
    29	  function read(): RegistryFile {
    30	    if (cache) return cache;
    31	    let text: string;
    32	    try {
    33	      text = readFileSync(registryFile, "utf8");
    34	    } catch {
    35	      // Genuinely absent: a fresh empty registry is correct.
    36	      cache = { version: 1, workspaces: [] };
    37	      return cache;
    38	    }
    39	    let parsed: unknown;
    40	    try {
    41	      parsed = JSON.parse(text);
    42	    } catch {
    43	      // A present-but-corrupt file is NOT "no workspaces" — refuse rather
    44	      // than let the next write() collapse real data to empty.
    45	      throw new Error(
    46	        `Workspace registry is corrupt (${registryFile}); refusing to overwrite it.`,
    47	      );
    48	    }
    49	    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    50	      throw new Error(`Workspace registry has an unexpected shape (${registryFile}).`);
    51	    }
    52	    const obj = parsed as Record<string, unknown>;
    53	    if (obj.version !== 1) {
    54	      // A future-version registry must be preserved, never silently wiped.
    55	      throw new Error(
    56	        `Workspace registry version ${String(obj.version)} is newer than supported; refusing to overwrite it.`,
    57	      );
    58	    }
    59	    if (!Array.isArray(obj.workspaces)) {
    60	      throw new Error(`Workspace registry "workspaces" is not an array (${registryFile}).`);
    61	    }
    62	    cache = { version: 1, workspaces: obj.workspaces as RegistryEntry[] };
    63	    return cache;
    64	  }
    65	
    66	  function write(registry: RegistryFile): void {
    67	    mkdirSync(dirname(registryFile), { recursive: true });
    68	    // Atomic: write a temp file then rename over the target so a crash or
    69	    // concurrent reader never sees a half-written registry.
    70	    const tmp = `${registryFile}.tmp-${process.pid}`;
    71	    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    72	    renameSync(tmp, registryFile);
    20	
    21	Tell your agents who you are and how you like to work.
    22	This file lives at .context/me.md inside your workspace folder.
    23	`;
    24	
    25	type ManifestState =
    26	  | { kind: "absent" }
    27	  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] }
    28	  | { kind: "blocked"; reason: string };
    29	
    30	async function inspectManifest(rootPath: string): Promise<ManifestState> {
    31	  let raw: string;
    32	  try {
    33	    raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
    34	  } catch {
    35	    return { kind: "absent" };
    36	  }
    37	  let parsed: unknown;
    38	  try {
    39	    parsed = JSON.parse(raw);
    40	  } catch {
    41	    return { kind: "blocked", reason: "this folder has a corrupt .dohc/manifest.json" };
    42	  }
    43	  const check = checkManifest(parsed);
    44	  if (check.status === "valid") {
    45	    return {
    46	      kind: "valid",
    47	      workspaceId: check.manifest.workspaceId,
    48	      workspaceKind: check.manifest.kind,
    49	      mode: check.manifest.mode,
    50	    };
    51	  }
    52	  if (check.status === "newer-version") {
    53	    return {
    54	      kind: "blocked",
    55	      reason: `this workspace was created by a newer version of dohc (manifest v${check.version})`,
    56	    };
    57	  }
    58	  // A present-but-broken manifest must never be silently overwritten (it may
    59	  // be the user's data). checkManifest never returns "absent" for a file that
    60	  // exists, but narrow defensively.
    61	  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
    62	  return { kind: "blocked", reason: `this folder has an invalid .dohc/manifest.json: ${reason}` };
    63	}
    64	
    65	export async function createWorkspaceFolder(input: {
    66	  rootPath: string;
    67	  kind: Extract<WorkspaceKind, "personal" | "shared">;
    68	}): Promise<CreatedWorkspace> {
    69	  const folderCheck = validateAttachedFolder(input.rootPath);
    70	  if (!folderCheck.ok) {

exec
/bin/bash -lc "node - <<'NODE'
const path=require('node:path');
for (const [p,c] of [['/home/ice/dohc','//home/ice/dohc/personal'], ['/home/ice/dohc','//server/share/foo'], ['//server/share','//server/share/foo'], ['//server/share','//server2/share/foo']]) {
 const rel=path.posix.relative(p,c);
 console.log(p,'->',c,'=',JSON.stringify(rel), "'!rel.startsWith('"'..'), "'!rel.startsWith(path.posix.sep));
}
NODE' in /home/ice/dev/dohc
 succeeded in 0ms:
/home/ice/dohc -> //home/ice/dohc/personal = "personal" true true
/home/ice/dohc -> //server/share/foo = "../../../server/share/foo" false true
//server/share -> //server/share/foo = "foo" true true
//server/share -> //server2/share/foo = "../../server2/share/foo" false true

exec
/bin/bash -lc "grep -R \"listWorkspaces\\|\\.list()\\|createRegistryStore\" -n apps/desktop/src packages | head -100" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/src/main.ts:31:  listWorkspaces,
apps/desktop/src/main.ts:108:    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
apps/desktop/src/workspaces/registryStore.ts:24:export function createRegistryStore(registryFile: string) {
apps/desktop/src/workspaces/WorkspaceRegistry.ts:5:import { createRegistryStore, type RegistryEntry } from "./registryStore";
apps/desktop/src/workspaces/WorkspaceRegistry.ts:21:let cachedStore: ReturnType<typeof createRegistryStore> | null = null;
apps/desktop/src/workspaces/WorkspaceRegistry.ts:26:    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
apps/desktop/src/workspaces/WorkspaceRegistry.ts:31:export function listWorkspaces(): RegistryEntry[] {
apps/desktop/src/workspaces/WorkspaceRegistry.ts:32:  return store().list();
apps/desktop/src/workspaces/registryStore.test.ts:5:import { createRegistryStore } from "./registryStore";
apps/desktop/src/workspaces/registryStore.test.ts:7:let store: ReturnType<typeof createRegistryStore>;
apps/desktop/src/workspaces/registryStore.test.ts:20:  store = createRegistryStore(registryPath);
apps/desktop/src/workspaces/registryStore.test.ts:32:    expect(store.list()).toHaveLength(2);
apps/desktop/src/workspaces/registryStore.test.ts:51:    const reopened = createRegistryStore(store.registryFile);
apps/desktop/src/workspaces/registryStore.test.ts:81:    const future = createRegistryStore(registryPath);
apps/desktop/src/workspaces/registryStore.test.ts:82:    expect(() => future.list()).toThrow(/newer than supported|refusing to overwrite/i);
apps/desktop/src/workspaces/registryStore.test.ts:87:    const corrupt = createRegistryStore(registryPath);
apps/desktop/src/workspaces/registryStore.test.ts:88:    expect(() => corrupt.list()).toThrow(/corrupt|refusing to overwrite/i);

exec
/bin/bash -lc "sed -n '1,200p' packages/workspace-core/src/index.ts && git show ce6910a:packages/workspace-core/src/index.ts | sed -n '1,200p'" in /home/ice/dev/dohc
 succeeded in 0ms:
export * from "./workspaceMode";
export * from "./metadata";
export * from "./paths";
export * from "./changeSet";
export * from "./conflicts";
export * from "./watcher";
export * from "./syncStatus";
export * from "./workspaceMode";
export * from "./metadata";
export * from "./paths";
export * from "./changeSet";
export * from "./conflicts";

exec
/bin/bash -lc "grep -n \"function enum\\|ZodEnum\" apps/desktop/node_modules/zod/lib/types.d.ts 2>/dev/null | head -30 || grep -R \"readonly \\[string\" -n apps/desktop/node_modules/zod | head -20" in /home/ice/dev/dohc
 succeeded in 0ms:
exec
/bin/bash -lc "ls apps/desktop/node_modules/zod | head && grep -R \"readonly \\[string\" -n apps/desktop/node_modules/zod | head -20" in /home/ice/dev/dohc
 succeeded in 0ms:
ls: cannot access 'apps/desktop/node_modules/zod': No such file or directory
grep: apps/desktop/node_modules/zod: No such file or directory

exec
/bin/bash -lc "ls node_modules/.pnpm | grep '"'^zod'"' | head && grep -R \"readonly \\[string\" -n node_modules/.pnpm/zod@3.25.76*/node_modules/zod | head -20" in /home/ice/dev/dohc
 succeeded in 0ms:
grep: node_modules/.pnpm/zod@3.25.76*/node_modules/zod: No such file or directory

exec
/bin/bash -lc 'ls -la | head && ls node_modules 2>/dev/null | head || true && find . -maxdepth 3 -type l -name zod -o -type d -name zod | head -20' in /home/ice/dev/dohc
 succeeded in 0ms:
total 504
drwxr-xr-x  14 ice ice   4096 Jun 10 19:21 .
drwxr-xr-x  20 ice ice   4096 May 22 01:34 ..
-rw-r--r--   1 ice ice  14517 Jun  1 11:58 .coderabbit.yaml
-rw-r--r--   1 ice ice    138 May 28 18:20 .dockerignore
-rw-r--r--   1 ice ice    945 Jun 10 12:11 .env.self-host.example
drwxr-xr-x   9 ice ice   4096 Jun 10 19:16 .git
-rw-r--r--   1 ice ice    142 Jun 10 18:47 .gitignore
drwxr-xr-x   3 ice ice   4096 Jun  2 19:35 .gstack
-rw-r--r--   1 ice ice      8 May 28 18:20 .node-version
@ai-sdk
@asamuzakjp
@babel
@bramus
@codemirror
@convex-dev
@csstools
@edge-runtime
@electron
@electron-internal
./node_modules/zod

exec
/bin/bash -lc "grep -R \"readonly \\[string\" -n node_modules/zod | head -20 && grep -R \"enumType\" -n node_modules/zod/v3 | head -20" in /home/ice/dev/dohc
 succeeded in 215ms:
node_modules/zod/src/v3/tests/readonly.test.ts:54:  util.assertEqual<z.infer<(typeof schemas)[13]>, readonly [string, number]>(true);
node_modules/zod/src/v3/tests/readonly.test.ts:89://     readonly [string, number]
node_modules/zod/src/v3/tests/readonly.test.ts:123://       ReadonlySet<readonly [string, number]>,
node_modules/zod/src/v4/classic/tests/readonly.test.ts:43:  expectTypeOf<typeof readonlyTuple._output>().toEqualTypeOf<readonly [string, number]>();
node_modules/zod/src/v4/classic/tests/readonly.test.ts:75://   >().toEqualTypeOf<readonly [string, number]>();
node_modules/zod/src/v4/classic/tests/readonly.test.ts:101://     ReadonlySet<readonly [string, number]>,
node_modules/zod/src/v4/classic/tests/readonly.test.ts:184:  expectTypeOf<readonlyStringTuple>().toEqualTypeOf<readonly [string]>();
node_modules/zod/src/v4/classic/tests/readonly.test.ts:234:  expectTypeOf<z.infer<typeof readonlyTuple>>().toEqualTypeOf<readonly [string, number]>();
node_modules/zod/v3/types.d.cts:1012:declare const enumType: typeof createZodEnum;
node_modules/zod/v3/types.d.cts:1030:export { anyType as any, arrayType as array, bigIntType as bigint, booleanType as boolean, dateType as date, discriminatedUnionType as discriminatedUnion, effectsType as effect, enumType as enum, functionType as function, instanceOfType as instanceof, intersectionType as intersection, lazyType as lazy, literalType as literal, mapType as map, nanType as nan, nativeEnumType as nativeEnum, neverType as never, nullType as null, nullableType as nullable, numberType as number, objectType as object, oboolean, onumber, optionalType as optional, ostring, pipelineType as pipeline, preprocessType as preprocess, promiseType as promise, recordType as record, setType as set, strictObjectType as strictObject, stringType as string, symbolType as symbol, effectsType as transformer, tupleType as tuple, undefinedType as undefined, unionType as union, unknownType as unknown, voidType as void, };
node_modules/zod/v3/types.d.ts:1012:declare const enumType: typeof createZodEnum;
node_modules/zod/v3/types.d.ts:1030:export { anyType as any, arrayType as array, bigIntType as bigint, booleanType as boolean, dateType as date, discriminatedUnionType as discriminatedUnion, effectsType as effect, enumType as enum, functionType as function, instanceOfType as instanceof, intersectionType as intersection, lazyType as lazy, literalType as literal, mapType as map, nanType as nan, nativeEnumType as nativeEnum, neverType as never, nullType as null, nullableType as nullable, numberType as number, objectType as object, oboolean, onumber, optionalType as optional, ostring, pipelineType as pipeline, preprocessType as preprocess, promiseType as promise, recordType as record, setType as set, strictObjectType as strictObject, stringType as string, symbolType as symbol, effectsType as transformer, tupleType as tuple, undefinedType as undefined, unionType as union, unknownType as unknown, voidType as void, };
node_modules/zod/v3/types.cjs:3742:const enumType = ZodEnum.create;
node_modules/zod/v3/types.cjs:3743:exports.enum = enumType;
node_modules/zod/v3/types.js:3671:const enumType = ZodEnum.create;
node_modules/zod/v3/types.js:3692:export { anyType as any, arrayType as array, bigIntType as bigint, booleanType as boolean, dateType as date, discriminatedUnionType as discriminatedUnion, effectsType as effect, enumType as enum, functionType as function, instanceOfType as instanceof, intersectionType as intersection, lazyType as lazy, literalType as literal, mapType as map, nanType as nan, nativeEnumType as nativeEnum, neverType as never, nullType as null, nullableType as nullable, numberType as number, objectType as object, oboolean, onumber, optionalType as optional, ostring, pipelineType as pipeline, preprocessType as preprocess, promiseType as promise, recordType as record, setType as set, strictObjectType as strictObject, stringType as string, symbolType as symbol, effectsType as transformer, tupleType as tuple, undefinedType as undefined, unionType as union, unknownType as unknown, voidType as void, };

exec
/bin/bash -lc "sed -n '980,1020p' node_modules/zod/v3/types.d.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
    coerce?: boolean;
}) => ZodNumber;
declare const nanType: (params?: RawCreateParams) => ZodNaN;
declare const bigIntType: (params?: RawCreateParams & {
    coerce?: boolean;
}) => ZodBigInt;
declare const booleanType: (params?: RawCreateParams & {
    coerce?: boolean;
}) => ZodBoolean;
declare const dateType: (params?: RawCreateParams & {
    coerce?: boolean;
}) => ZodDate;
declare const symbolType: (params?: RawCreateParams) => ZodSymbol;
declare const undefinedType: (params?: RawCreateParams) => ZodUndefined;
declare const nullType: (params?: RawCreateParams) => ZodNull;
declare const anyType: (params?: RawCreateParams) => ZodAny;
declare const unknownType: (params?: RawCreateParams) => ZodUnknown;
declare const neverType: (params?: RawCreateParams) => ZodNever;
declare const voidType: (params?: RawCreateParams) => ZodVoid;
declare const arrayType: <El extends ZodTypeAny>(schema: El, params?: RawCreateParams) => ZodArray<El>;
declare const objectType: <Shape extends ZodRawShape>(shape: Shape, params?: RawCreateParams) => ZodObject<Shape, "strip", ZodTypeAny, objectOutputType<Shape, ZodTypeAny, "strip">, objectInputType<Shape, ZodTypeAny, "strip">>;
declare const strictObjectType: <Shape extends ZodRawShape>(shape: Shape, params?: RawCreateParams) => ZodObject<Shape, "strict">;
declare const unionType: <Options extends Readonly<[ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]>>(types: Options, params?: RawCreateParams) => ZodUnion<Options>;
declare const discriminatedUnionType: typeof ZodDiscriminatedUnion.create;
declare const intersectionType: <TSchema extends ZodTypeAny, USchema extends ZodTypeAny>(left: TSchema, right: USchema, params?: RawCreateParams) => ZodIntersection<TSchema, USchema>;
declare const tupleType: <Items extends [ZodTypeAny, ...ZodTypeAny[]] | []>(schemas: Items, params?: RawCreateParams) => ZodTuple<Items, null>;
declare const recordType: typeof ZodRecord.create;
declare const mapType: <KeySchema extends ZodTypeAny = ZodTypeAny, ValueSchema extends ZodTypeAny = ZodTypeAny>(keyType: KeySchema, valueType: ValueSchema, params?: RawCreateParams) => ZodMap<KeySchema, ValueSchema>;
declare const setType: <ValueSchema extends ZodTypeAny = ZodTypeAny>(valueType: ValueSchema, params?: RawCreateParams) => ZodSet<ValueSchema>;
declare const functionType: typeof ZodFunction.create;
declare const lazyType: <Inner extends ZodTypeAny>(getter: () => Inner, params?: RawCreateParams) => ZodLazy<Inner>;
declare const literalType: <Value extends Primitive>(value: Value, params?: RawCreateParams) => ZodLiteral<Value>;
declare const enumType: typeof createZodEnum;
declare const nativeEnumType: <Elements extends EnumLike>(values: Elements, params?: RawCreateParams) => ZodNativeEnum<Elements>;
declare const promiseType: <Inner extends ZodTypeAny>(schema: Inner, params?: RawCreateParams) => ZodPromise<Inner>;
declare const effectsType: <I extends ZodTypeAny>(schema: I, effect: Effect<I["_output"]>, params?: RawCreateParams) => ZodEffects<I, I["_output"]>;
declare const optionalType: <Inner extends ZodTypeAny>(type: Inner, params?: RawCreateParams) => ZodOptional<Inner>;
declare const nullableType: <Inner extends ZodTypeAny>(type: Inner, params?: RawCreateParams) => ZodNullable<Inner>;
declare const preprocessType: <I extends ZodTypeAny>(preprocess: (arg: unknown, ctx: RefinementCtx) => unknown, schema: I, params?: RawCreateParams) => ZodEffects<I, I["_output"], unknown>;
declare const pipelineType: typeof ZodPipeline.create;
declare const ostring: () => ZodOptional<ZodString>;

exec
/bin/bash -lc 'grep -n "createZodEnum" -n node_modules/zod/v3/types.d.ts | head -10' in /home/ice/dev/dohc
 succeeded in 0ms:
760:declare function createZodEnum<U extends string, T extends Readonly<[U, ...U[]]>>(values: T, params?: RawCreateParams): ZodEnum<Writeable<T>>;
761:declare function createZodEnum<U extends string, T extends [U, ...U[]]>(values: T, params?: RawCreateParams): ZodEnum<T>;
771:    static create: typeof createZodEnum;
1012:declare const enumType: typeof createZodEnum;

exec
/bin/bash -lc 'pnpm --filter @dohc/desktop typecheck' in /home/ice/dev/dohc
 exited 1 in 389ms:
 ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)

Your pnpm version is incompatible with "/home/ice/dev/dohc".

Expected version: 10.24.0
Got: 9.14.4

This is happening because the package's manifest has an engines.pnpm field specified.
To fix this issue, install the required pnpm version globally.

To install the latest version of pnpm, run "pnpm i -g pnpm".
To check your pnpm version, run "pnpm -v".

exec
/bin/bash -lc './node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit' in /home/ice/dev/dohc
 exited 2 in 1829ms:
error TS5033: Could not write file '/home/ice/dev/dohc/apps/desktop/tsconfig.tsbuildinfo': EROFS: read-only file system, open '/home/ice/dev/dohc/apps/desktop/tsconfig.tsbuildinfo'.

exec
/bin/bash -lc './node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit --incremental false' in /home/ice/dev/dohc
 succeeded in 1934ms:
exec
/bin/bash -lc "grep -R \"blank\\|corrupt registry\\|getWorkspaceRegistry\\|registry\" -n docs/superpowers/reviews/codex/phase-04.md docs/superpowers/reviews/codex/checkpoint-phase-04.md docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md | head -100" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/reviews/codex/phase-04.md:21:ce6910a (HEAD -> claude/desktop-local-first-cloud-sync) phase4: Add local workspace registry
docs/superpowers/reviews/codex/phase-04.md:31: apps/desktop/src/workspaces/registryStore.test.ts  | 73 ++++++++++++++++++++
docs/superpowers/reviews/codex/phase-04.md:32: apps/desktop/src/workspaces/registryStore.ts       | 79 ++++++++++++++++++++++
docs/superpowers/reviews/codex/phase-04.md:111:    phase4: Add local workspace registry
docs/superpowers/reviews/codex/phase-04.md:113:    Pure registry store (multi-attach, duplicate-folder AND duplicate-
docs/superpowers/reviews/codex/phase-04.md:117:    paths flow through all fs/registry ops), first-run open-existing
docs/superpowers/reviews/codex/phase-04.md:365:   // Relaunch with the same test home: registry remembers the workspace.
docs/superpowers/reviews/codex/phase-04.md:473:   getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
docs/superpowers/reviews/codex/phase-04.md:500:   getWorkspaceRegistry: "desktop:get-workspace-registry",
docs/superpowers/reviews/codex/phase-04.md:595:   ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
docs/superpowers/reviews/codex/phase-04.md:607:+  // Validates AND canonicalizes: all downstream fs/registry operations use
docs/superpowers/reviews/codex/phase-04.md:717:   getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
docs/superpowers/reviews/codex/phase-04.md:771:   getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
docs/superpowers/reviews/codex/phase-04.md:1019:+import { createRegistryStore, type RegistryEntry } from "./registryStore";
docs/superpowers/reviews/codex/phase-04.md:1024:+// Electron wiring over the pure registry store. The registry lives in
docs/superpowers/reviews/codex/phase-04.md:1038:-function registryPath(): string {
docs/superpowers/reviews/codex/phase-04.md:1052:-      readFileSync(registryPath(), "utf8"),
docs/superpowers/reviews/codex/phase-04.md:1065:-function writeRegistry(registry: RegistryFile): void {
docs/superpowers/reviews/codex/phase-04.md:1066:-  mkdirSync(dirname(registryPath()), { recursive: true });
docs/superpowers/reviews/codex/phase-04.md:1067:-  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
docs/superpowers/reviews/codex/phase-04.md:1077:-  const registry = readRegistry();
docs/superpowers/reviews/codex/phase-04.md:1078:-  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
docs/superpowers/reviews/codex/phase-04.md:1081:-  registry.workspaces.push(workspace);
docs/superpowers/reviews/codex/phase-04.md:1082:-  writeRegistry(registry);
docs/superpowers/reviews/codex/phase-04.md:1094:diff --git a/apps/desktop/src/workspaces/registryStore.test.ts b/apps/desktop/src/workspaces/registryStore.test.ts
docs/superpowers/reviews/codex/phase-04.md:1098:+++ b/apps/desktop/src/workspaces/registryStore.test.ts
docs/superpowers/reviews/codex/phase-04.md:1104:+import { createRegistryStore } from "./registryStore";
docs/superpowers/reviews/codex/phase-04.md:1116:+  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
docs/superpowers/reviews/codex/phase-04.md:1120:+describe("registry store", () => {
docs/superpowers/reviews/codex/phase-04.md:1148:+    const reopened = createRegistryStore(store.registryFile);
docs/superpowers/reviews/codex/phase-04.md:1173:diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
docs/superpowers/reviews/codex/phase-04.md:1177:+++ b/apps/desktop/src/workspaces/registryStore.ts
docs/superpowers/reviews/codex/phase-04.md:1183:+// Pure registry persistence: a JSON file of known local workspaces. The
docs/superpowers/reviews/codex/phase-04.md:1202:+export function createRegistryStore(registryFile: string) {
docs/superpowers/reviews/codex/phase-04.md:1205:+      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
docs/superpowers/reviews/codex/phase-04.md:1212:+  function write(registry: RegistryFile): void {
docs/superpowers/reviews/codex/phase-04.md:1213:+    mkdirSync(dirname(registryFile), { recursive: true });
docs/superpowers/reviews/codex/phase-04.md:1214:+    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
docs/superpowers/reviews/codex/phase-04.md:1218:+    registryFile,
docs/superpowers/reviews/codex/phase-04.md:1229:+      const registry = read();
docs/superpowers/reviews/codex/phase-04.md:1230:+      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
docs/superpowers/reviews/codex/phase-04.md:1236:+        registry.workspaces.some(
docs/superpowers/reviews/codex/phase-04.md:1245:+      registry.workspaces.push(workspace);
docs/superpowers/reviews/codex/phase-04.md:1246:+      write(registry);
docs/superpowers/reviews/codex/phase-04.md:1250:+      const registry = read();
docs/superpowers/reviews/codex/phase-04.md:1251:+      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
docs/superpowers/reviews/codex/phase-04.md:1254:+      write(registry);
docs/superpowers/reviews/codex/phase-04.md:1398: - Remaining risk: API shapes may evolve when Phase 4 (registry) and Phase 5 (history) consume them — acceptable, contract-first by design
docs/superpowers/reviews/codex/phase-04.md:1416: - UI/UX screenshot/design review: screenshot inspected by lead — warm paper bg, centered graphite wordmark, muted subtitle, nonblank, no white flash (backgroundColor set pre-paint). Full Design Review Loop applies from Phase 3.
docs/superpowers/reviews/codex/phase-04.md:1420: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-02.md; commit review + targeted security prompt, both xhigh): (1) MED ELECTRON_RENDERER_URL trusted without isPackaged/loopback guard — packaged app could loadURL + IPC-trust arbitrary origin — FIXED (validateDevServerUrl: unpackaged + loopback + http(s) only, unit-tested incl. packaged rejection); (2) MED only will-navigate enforced; redirects/subframes uncovered — FIXED (will-redirect + will-frame-navigate share the same policy; about:blank/javascript: unit cases added); (3) LOW test bridge env-only gating — FIXED (env flag AND !app.isPackaged); (4) LOW window.open shells any http(s) — could become phishing primitive if renderer renders user content — DEFERRED with reason: renderer content is fully app-controlled until Phase 6 file views; user-gesture/allowlist fix scheduled with Phase 6 (tracked); (5) INFO WindowOpenDecision over-shaped — FIXED (simplified to shouldOpenExternally boolean, less code). Codex confirmed solid: IPC sender validation on every handler, no Node/ipcRenderer leak, webPreferences trio, about:/javascript: denial.
docs/superpowers/reviews/codex/phase-04.md:1429: - Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
docs/superpowers/reviews/codex/phase-04.md:1436: - Decisions made: D-12 | Phase 3 ships minimal real bridge (registry/create/list/createFile), Phase 4 formalizes | first-run must create real folders to be honest | phase 3. D-13 | shell purpose-built, not ported: reuse map showed ports carry transitive web coupling; 400-line shell beats 16 swapped components for v1 | less code | phase 3
docs/superpowers/reviews/codex/phase-04.md:1447: - Deferred findings with reason: SUPERSEDED — claimed-vs-actual verifier correctly failed the deferral as gate-softening; all five missing plan elements built in iteration 2: workspace switcher (real listbox over registry), import action (real file-copy via dialog + copyIntoWorkspace, unit-tested incl. no-overwrite), cloud-sync offer (truthful surface in first-run + status bar + palette — explains, never gates), quick-open Ctrl+P (palette-pattern file jump, E2E-tested), file-preview screenshot (selected-state artifact). Also fixed from verifier nits: me.md catch narrowed to EEXIST-only. Flat path list (not hierarchical tree) remains v0 — hierarchy + virtualization with Phase 5/16. Verifier note on rootPath validation → Phase 4 requirement (recorded).
docs/superpowers/reviews/codex/phase-04.md:1454:+- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
docs/superpowers/reviews/codex/phase-04.md:1456:+- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
docs/superpowers/reviews/codex/phase-04.md:1457:+- Code deleted or consolidated: WorkspaceRegistry's inline persistence replaced by pure registryStore (was untestable electron-coupled code); registerWorkspace silent-skip became explicit duplicate rejection
docs/superpowers/reviews/codex/phase-04.md:1461:+- Decisions made: D-14 | registry naming keeps getWorkspaceRegistry/pickWorkspaceRoot (plan: listLocalWorkspaces/chooseWorkspaceRoot) — same surface, earlier names already shipped in phase2/3; renaming = churn without behavior | less code | phase 4
docs/superpowers/reviews/codex/phase-04.md:1462:+- Tests added: 3 workspace-core (root-choice), 5 registryStore, 1 first-run component (attach), 1 E2E (attach preserves manifest identity, file tree shows existing files)
docs/superpowers/reviews/codex/phase-04.md:1469:+- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
docs/superpowers/reviews/codex/phase-04.md:1472:+- Deferred findings with reason: registry uses userData JSON (plan mentions Electron safeStorage as an option — registry holds no secrets, paths only; safeStorage encryption adds keychain dependency for zero confidentiality gain; revisit when cloud tokens arrive in Phase 9)
docs/superpowers/reviews/codex/phase-04.md:1726:+// returned normalized path so registry equality checks are canonical.
docs/superpowers/reviews/codex/phase-04.md:1764:/bin/bash -lc 'git show ce6910a -- apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/registryStore.ts apps/desktop/src/workspaces/registryStore.test.ts apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/renderer/DesktopFirstRun.tsx apps/desktop/src/renderer/DesktopFirstRun.test.tsx packages/workspace-core/src/paths.ts --unified=120' in /home/ice/dev/dohc
docs/superpowers/reviews/codex/phase-04.md:1770:    phase4: Add local workspace registry
docs/superpowers/reviews/codex/phase-04.md:1772:    Pure registry store (multi-attach, duplicate-folder AND duplicate-
docs/superpowers/reviews/codex/phase-04.md:1776:    paths flow through all fs/registry ops), first-run open-existing
docs/superpowers/reviews/codex/phase-04.md:1814:+  // Validates AND canonicalizes: all downstream fs/registry operations use
docs/superpowers/reviews/codex/phase-04.md:1878:   getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
docs/superpowers/reviews/codex/phase-04.md:1957:+import { createRegistryStore, type RegistryEntry } from "./registryStore";
docs/superpowers/reviews/codex/phase-04.md:1962:+// Electron wiring over the pure registry store. The registry lives in
docs/superpowers/reviews/codex/phase-04.md:1972:-function registryPath(): string {
docs/superpowers/reviews/codex/phase-04.md:1986:-      readFileSync(registryPath(), "utf8"),
docs/superpowers/reviews/codex/phase-04.md:1999:-function writeRegistry(registry: RegistryFile): void {
docs/superpowers/reviews/codex/phase-04.md:2000:-  mkdirSync(dirname(registryPath()), { recursive: true });
docs/superpowers/reviews/codex/phase-04.md:2001:-  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
docs/superpowers/reviews/codex/phase-04.md:2011:-  const registry = readRegistry();
docs/superpowers/reviews/codex/phase-04.md:2012:-  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
docs/superpowers/reviews/codex/phase-04.md:2015:-  registry.workspaces.push(workspace);
docs/superpowers/reviews/codex/phase-04.md:2016:-  writeRegistry(registry);
docs/superpowers/reviews/codex/phase-04.md:2028:diff --git a/apps/desktop/src/workspaces/registryStore.test.ts b/apps/desktop/src/workspaces/registryStore.test.ts
docs/superpowers/reviews/codex/phase-04.md:2032:+++ b/apps/desktop/src/workspaces/registryStore.test.ts
docs/superpowers/reviews/codex/phase-04.md:2038:+import { createRegistryStore } from "./registryStore";
docs/superpowers/reviews/codex/phase-04.md:2050:+  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
docs/superpowers/reviews/codex/phase-04.md:2054:+describe("registry store", () => {
docs/superpowers/reviews/codex/phase-04.md:2082:+    const reopened = createRegistryStore(store.registryFile);
docs/superpowers/reviews/codex/phase-04.md:2107:diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
docs/superpowers/reviews/codex/phase-04.md:2111:+++ b/apps/desktop/src/workspaces/registryStore.ts
docs/superpowers/reviews/codex/phase-04.md:2117:+// Pure registry persistence: a JSON file of known local workspaces. The
docs/superpowers/reviews/codex/phase-04.md:2136:+export function createRegistryStore(registryFile: string) {
docs/superpowers/reviews/codex/phase-04.md:2139:+      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
docs/superpowers/reviews/codex/phase-04.md:2146:+  function write(registry: RegistryFile): void {
docs/superpowers/reviews/codex/phase-04.md:2147:+    mkdirSync(dirname(registryFile), { recursive: true });
docs/superpowers/reviews/codex/phase-04.md:2148:+    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
docs/superpowers/reviews/codex/phase-04.md:2152:+    registryFile,
docs/superpowers/reviews/codex/phase-04.md:2163:+      const registry = read();
docs/superpowers/reviews/codex/phase-04.md:2164:+      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
docs/superpowers/reviews/codex/phase-04.md:2170:+        registry.workspaces.some(
docs/superpowers/reviews/codex/phase-04.md:2179:+      registry.workspaces.push(workspace);
docs/superpowers/reviews/codex/phase-04.md:2180:+      write(registry);
docs/superpowers/reviews/codex/phase-04.md:2184:+      const registry = read();
docs/superpowers/reviews/codex/phase-04.md:2185:+      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
grep: write error: Broken pipe

exec
/bin/bash -lc "grep -R \"cross-drive\\|different drive\\|path.relative\\|relative(approved\\|relative(parent\" -n docs/superpowers/reviews/codex docs/superpowers/plans | head -50" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/reviews/codex/phase-04-fix.md:431:+    const rel = relative(approved, normalized);
docs/superpowers/reviews/codex/phase-04-fix.md:1177:+  const rel = relative(parent, child);
docs/superpowers/reviews/codex/phase-04-fix.md:1503:    const rel = relative(approved, normalized);
docs/superpowers/reviews/codex/phase-04-fix.md:1808:  const rel = relative(parent, child);
docs/superpowers/reviews/codex/phase-04-fix.md:3152:    60	    const rel = relative(approved, normalized);
docs/superpowers/reviews/codex/phase-04-fix.md:3197:    30	  const rel = relative(parent, child);

exec
/bin/bash -lc "git show ce6910a:apps/desktop/src/renderer/DesktopFirstRun.tsx | sed -n '1,120p'" in /home/ice/dev/dohc
 succeeded in 0ms:
import { Cloud, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";

// First launch is a working tool, not a marketing page: pick where your
// files live, create the folder, start working. No account exists here.
export function DesktopFirstRun(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudNote, setCloudNote] = useState(false);

  useEffect(() => {
    void bridge().getDefaultWorkspaceRoot().then(setRoot);
  }, []);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setRoot(picked);
  }

  async function createWorkspace() {
    if (!root || creating) return;
    setCreating(true);
    try {
      const workspace = await bridge().createLocalWorkspace({
        rootPath: `${root}/personal`,
        kind: "personal",
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  }

  async function openExisting() {
    const picked = await bridge().pickWorkspaceRoot();
    if (!picked) return;
    try {
      const workspace = await bridge().attachWorkspaceFolder({
        rootPath: picked,
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
      <div className="flex flex-col items-center gap-1">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">dohc</h1>
        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
      </div>

      <div className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
            Workspace location
          </span>
          <div className="flex items-start justify-between gap-2">
            {/* The whole point of this screen is where files live: never
                truncate the path. */}
            <code className="break-all font-mono text-[13px] leading-snug text-ink">
              {root ?? "…"}
            </code>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
            >
              <FolderOpen size={13} aria-hidden />
              Choose a different folder
            </button>
          </div>
        </div>

        <button
          type="button"
          disabled={!root || creating}
          onClick={() => void createWorkspace()}
          className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create workspace"}
        </button>

        <button
          type="button"
          onClick={() => void openExisting()}
          className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
        >
          Open an existing folder as a workspace
        </button>

        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}

        <div className="flex items-center justify-between gap-4">
          <p className="m-0 text-xs text-subtle">
            Works offline, no account needed. Cloud sync is optional.
          </p>
          <button
            type="button"
            onClick={() => setCloudNote((open) => !open)}
            className="flex shrink-0 items-center gap-1 text-xs text-subtle hover:text-ink"
          >
            <Cloud size={12} aria-hidden />
            Enable dohc Cloud sync
          </button>
        </div>
        {cloudNote ? (
          <p className="m-0 rounded bg-panel-2 px-2.5 py-2 text-xs leading-relaxed text-muted">
            Cloud sync arrives with dohc Cloud accounts — sharing, backup, and
            teams. Your workspace stays fully functional locally, and you can
            connect it later without moving anything.
          </p>
        ) : null}

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/renderer/DesktopFirstRun.test.tsx" in /home/ice/dev/dohc
 succeeded in 0ms:
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFirstRun } from "./DesktopFirstRun";

const bridge = {
  getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
  pickWorkspaceRoot: vi.fn(async () => "/home/ice/projects/research"),
  createLocalWorkspace: vi.fn(async () => ({
    workspaceId: "ws-1",
    rootPath: "/home/ice/dohc/personal",
    kind: "personal" as const,
    mode: "local-first" as const,
  })),
  attachWorkspaceFolder: vi.fn(async () => ({
    workspaceId: "ws-attached",
    rootPath: "/home/ice/projects/research",
    kind: "personal" as const,
    mode: "local-first" as const,
  })),
  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
  listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
  createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
  importWorkspaceFiles: vi.fn(async () => ({ imported: [] })),
};

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("first run", () => {
  it("suggests ~/dohc as the workspace location", async () => {
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    expect(await screen.findByText("/home/ice/dohc")).toBeTruthy();
  });

  it("lets the user choose another folder", async () => {
    const user = userEvent.setup();
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: /choose.*folder/i }),
    );
    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledOnce();
    expect(await screen.findByText("/home/ice/projects/research")).toBeTruthy();
  });

  it("creates a personal workspace and hands it to the shell", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
    await user.click(
      await screen.findByRole("button", { name: /create workspace/i }),
    );
    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "personal" }),
    );
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
  });

  it("attaches an existing folder as a workspace", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
    await user.click(
      await screen.findByRole("button", { name: /open an existing folder/i }),
    );
    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
      rootPath: "/home/ice/projects/research",
    });
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-attached" }),
    );
  });

  it("never requires login and never renders auth fields", async () => {
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await screen.findByText("/home/ice/dohc");
    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in|log in|sign up/i }))
      .toBeNull();
  });

  it("mentions cloud sync as optional, not as a gate", async () => {
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await screen.findByText("/home/ice/dohc");
    const mention = screen.getByText(/cloud sync is optional/i);
    expect(mention).toBeTruthy();
  });

  it("offers Enable dohc Cloud sync without forcing it", async () => {
    const user = userEvent.setup();
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await screen.findByText("/home/ice/dohc");
    const offer = screen.getByRole("button", {
      name: /enable dohc cloud sync/i,
    });
    await user.click(offer);
    // The offer is truthful — it explains, never gates or asks for auth.
    expect(
      screen.getByText(/stays fully functional locally/i),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeTruthy();
  });

  it("reads like a desktop app, not a marketing page", async () => {
    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
    await screen.findByText("/home/ice/dohc");
    // No marketing tropes: pricing, testimonials, feature grids, sign-up CTAs.
    expect(
      screen.queryByText(/get started free|pricing|testimonial|trusted by/i),
    ).toBeNull();
    // The primary action is creating a real workspace folder.
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeTruthy();
  });
});

exec
/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/paths.test.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { describe, expect, it } from "vitest";
import {
  classifyPath,
  defaultWorkspaceRoot,
  isReservedPath,
  validateAttachedFolder,
  validateUserWritePath,
} from "./paths";

describe("workspace roots", () => {
  it("suggests ~/dohc as the default root", () => {
    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
  });

  it("allows attaching arbitrary absolute folders", () => {
    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
  });

  it("allows Windows absolute folders (drive and UNC)", () => {
    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
  });

  it("rejects relative paths as attached folders", () => {
    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
  });
});

describe("reserved paths", () => {
  it("reserves .dohc/manifest.json and the .dohc subtree", () => {
    expect(isReservedPath(".dohc/manifest.json")).toBe(true);
    expect(isReservedPath(".dohc/history/0001.json")).toBe(true);
    expect(isReservedPath("notes/today.md")).toBe(false);
  });

  it("reserves case-insensitive .dohc variants (case-insensitive filesystems)", () => {
    expect(isReservedPath(".DOHC/manifest.json")).toBe(true);
    const result = validateUserWritePath(".DoHc/manifest.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reserved");
  });

  it("rejects user writes into reserved space", () => {
    const result = validateUserWritePath(".dohc/manifest.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reserved");
  });
});

describe("path traversal", () => {
  const traversals = [
    "../escape.md",
    "notes/../../etc/passwd",
    "%2e%2e/sneak.md",
    "..\\windows\\system32",
    "a/%2E%2E/b",
    "%252e%252e/double-encoded.md",
    "..%2fescape.md",
    "..%5cwindows",
  ];

  for (const candidate of traversals) {
    it(`rejects traversal: ${JSON.stringify(candidate)}`, () => {
      const result = validateUserWritePath(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("traversal");
    });
  }

  it("rejects absolute paths inside a workspace", () => {
    const result = validateUserWritePath("/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute");
  });

  it("rejects Windows drive-qualified and UNC write paths", () => {
    for (const candidate of [
      "C:\\Users\\ice\\secret.md",
      "C:/Users/ice/secret.md",
      "\\\\server\\share\\secret.md",
    ]) {
      const result = validateUserWritePath(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("absolute");
    }
  });

  it("rejects encoded-slash absolute paths", () => {
    const result = validateUserWritePath("%2fetc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute");
  });

  it("rejects null bytes", () => {
    const result = validateUserWritePath("notes/a\0b.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("accepts and normalizes ordinary nested paths", () => {
    const result = validateUserWritePath("finance/./reports/q1.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized).toBe("finance/reports/q1.md");
  });
});

describe("workspace root choice", () => {
  it("accepts ordinary folders, including outside the default root", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    expect(
      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
    ).toBe(true);
    expect(
      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
    ).toBe(true);
  });

  it("rejects the filesystem root and the home directory itself", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    for (const dangerous of ["/", "/home/ice", "/home/ice/", "C:\\", "C:/"]) {
      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
      expect(result.ok).toBe(false);
    }
  });

  it("rejects dot-segment disguises of root and home", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    for (const disguised of [
      "/.",
      "/..",
      "/home/ice/.",
      "/home/ice/x/..",
      "/home/./ice",
    ]) {
      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
      expect(result.ok).toBe(false);
    }
  });

  it("rejects leading-double-slash and UNC disguises of root and home", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    expect(validateWorkspaceRootChoice("//home/ice", "/home/ice").ok).toBe(false);
    expect(validateWorkspaceRootChoice("///", "/home/ice").ok).toBe(false);
    expect(validateWorkspaceRootChoice("//server", "/home/ice").ok).toBe(false);
    expect(validateWorkspaceRootChoice("//server/share", "/home/ice").ok).toBe(false);
  });

  it("rejects case variants of the home directory (case-insensitive filesystems)", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    expect(validateWorkspaceRootChoice("/Home/Ice", "/home/ice").ok).toBe(false);
  });

  it("returns the normalized root so equality checks are canonical", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    const result = validateWorkspaceRootChoice(
      "/home/ice/dohc//personal/.",
      "/home/ice",
    );
    expect(result).toEqual({ ok: true, normalized: "/home/ice/dohc/personal" });
  });

  it("rejects relative paths", async () => {
    const { validateWorkspaceRootChoice } = await import("./paths");
    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
  });
});

describe("path classification", () => {
  it("treats .apps/<name>/app.json as visible app source", () => {
    expect(classifyPath("finance/.apps/ledger/app.json")).toEqual({
      kind: "app-source",
      appName: "ledger",
    });
    expect(classifyPath(".apps/tracker/src/App.tsx")).toEqual({
      kind: "app-source",
      appName: "tracker",
    });
  });

  it("treats .sqlite, .sqlite3, and .db files as visible databases", () => {
    expect(classifyPath("finance/wallet.sqlite")).toEqual({ kind: "database" });
    expect(classifyPath("data/cache.sqlite3")).toEqual({ kind: "database" });
    expect(classifyPath("archive/old.db")).toEqual({ kind: "database" });
  });

  it("classifies everything else as a plain file", () => {
    expect(classifyPath("notes/today.md")).toEqual({ kind: "file" });
  });
});

exec
/bin/bash -lc "sed -n '3120,3220p' docs/superpowers/reviews/codex/phase-04-fix.md 2>/dev/null || true" in /home/ice/dev/dohc
 succeeded in 0ms:
for (const [p,c] of [['C:/ws','D:/outside'], ['C:\\\\ws','D:\\\\outside'], ['C:/ws','C:/outside'], ['//server/share/ws','//other/share/out']]) {
 const rel=path.win32.relative(p,c);
 console.log(p,'->',c,'=',JSON.stringify(rel), 'starts ..', rel.startsWith('..'), 'starts sep', rel.startsWith(path.win32.sep));
}
NODE" in /home/ice/dev/dohc
 succeeded in 129ms:
C:/ws -> D:/outside = "D:\\outside" starts .. false starts sep false
C:\ws -> D:\outside = "D:\\outside" starts .. false starts sep false
C:/ws -> C:/outside = "..\\outside" starts .. true starts sep false
//server/share/ws -> //other/share/out = "\\\\other\\share\\out" starts .. false starts sep true

exec
/bin/bash -lc "nl -ba apps/desktop/src/main.ts | sed -n '42,75p'; nl -ba apps/desktop/src/workspaces/workspaceFiles.ts | sed -n '1,40p'; nl -ba packages/workspace-core/src/paths.ts | sed -n '60,118p'; nl -ba apps/desktop/src/workspaces/registryStore.ts | sed -n '20,72p'; nl -ba apps/desktop/src/workspaces/createWorkspaceFolder.ts | sed -n '20,70p'" in /home/ice/dev/dohc
 succeeded in 0ms:
    42	  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    43	  return workspace;
    44	}
    45	
    46	// Workspace roots the main process itself produced — the default suggestion
    47	// and any folder the user chose through the real OS dialog. A renderer cannot
    48	// invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
    49	// be one of these or a descendant. Populated by getDefaultWorkspaceRoot and
    50	// pickWorkspaceRoot before the renderer can create/attach.
    51	const approvedRoots = new Set<string>();
    52	
    53	function approveRoot(rootPath: string): void {
    54	  approvedRoots.add(normalizeAbsolutePath(rootPath));
    55	}
    56	
    57	function isApprovedRoot(normalized: string): boolean {
    58	  for (const approved of approvedRoots) {
    59	    if (normalized === approved) return true;
    60	    const rel = relative(approved, normalized);
    61	    if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)) {
    62	      return true;
    63	    }
    64	  }
    65	  return false;
    66	}
    67	
    68	// The navigation policy is constant for the process lifetime (env var and
    69	// packaged bundle dir cannot change), so compute it once.
    70	let cachedPolicy: ReturnType<typeof navigationPolicy> | null = null;
    71	function policy() {
    72	  if (!cachedPolicy) cachedPolicy = navigationPolicy();
    73	  return cachedPolicy;
    74	}
    75	
     1	import {
     2	  classifyPath,
     3	  validateUserWritePath,
     4	} from "@dohc/workspace-core";
     5	import { constants } from "node:fs";
     6	import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
     7	import { basename, dirname, join, relative, sep } from "node:path";
     8	
     9	// Deepest already-existing ancestor of a (possibly not-yet-created) path —
    10	// the part realpath can resolve, so we can check containment BEFORE mkdir.
    11	async function existingAncestor(path: string): Promise<string> {
    12	  let current = path;
    13	  for (;;) {
    14	    try {
    15	      return await realpath(current);
    16	    } catch {
    17	      const parent = dirname(current);
    18	      if (parent === current) return current;
    19	      current = parent;
    20	    }
    21	  }
    22	}
    23	import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
    24	
    25	const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
    26	
    27	// True iff `child` is the same as or nested under `parent` (both real paths).
    28	function isInside(parent: string, child: string): boolean {
    29	  if (child === parent) return true;
    30	  const rel = relative(parent, child);
    31	  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}`);
    32	}
    33	
    34	export async function listFiles(
    35	  rootPath: string,
    36	): Promise<WorkspaceFileEntry[]> {
    37	  const entries: WorkspaceFileEntry[] = [];
    38	
    39	  async function walk(dir: string, prefix: string): Promise<void> {
    40	    const dirents = await readdir(dir, { withFileTypes: true });
    60	}
    61	
    62	// Lexical normalization: resolves "." and ".." segments and separator noise
    63	// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
    64	// cannot slip past string comparisons. Preserves drive and UNC prefixes.
    65	export function normalizeAbsolutePath(path: string): string {
    66	  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
    67	  const rest = drive ? path.slice(drive.length) : path;
    68	  // A real UNC path needs a server segment after \\ or //; a bare POSIX
    69	  // leading // (or ///) is just the filesystem root and must collapse to /,
    70	  // otherwise "//home/ice" would dodge the home-directory guard.
    71	  const uncMatch = /^([\\/])\1+([^\\/])/.exec(rest);
    72	  const unc = drive === "" && uncMatch !== undefined && uncMatch !== null;

codex
The patch leaves Windows containment checks accepting cross-drive absolute `relative()` results, so both root approval and symlink write-escape protections can be bypassed. It also still risks overwriting an existing registry on non-ENOENT read failures.

Full review comments:

- [P1] Reject cross-drive paths in approval checks — /home/ice/dev/dohc/apps/desktop/src/main.ts:60-62
  On Windows, `path.relative('C:/approved', 'D:/target')` returns an absolute path on D:, which does not start with `..` or `sep`, so this branch treats a different drive as a descendant of the approved root. Once the default/picked root on C: has been approved, a renderer can pass a D: path to create/attach without that folder ever going through the picker; reject absolute `relative()` results or compare parsed roots before accepting descendants.

- [P1] Reject cross-drive realpaths in file containment — /home/ice/dev/dohc/apps/desktop/src/workspaces/workspaceFiles.ts:30-31
  The same predicate is used after `realpath()`. On Windows, when a workspace on C: contains a directory symlink/junction to another drive, `relative(realRoot, realChild)` returns an absolute D: path that passes this test, so `createFile(root, 'link/evil.md')` still writes through the link outside the workspace. Reject different-drive/absolute relative results before allowing the mkdir/write.

- [P2] Treat unreadable registries as errors — /home/ice/dev/dohc/apps/desktop/src/workspaces/registryStore.ts:32-37
  This catch also handles `EACCES`, `EISDIR`, and other read failures, not just a missing file. If the registry exists but is unreadable while the directory is writable, `read()` caches an empty registry and the next `register()`/`setRemote()` will rename a new file over the existing registry, which is the data-loss case this change is trying to prevent; only treat `ENOENT` as fresh and throw on other read errors.
The patch leaves Windows containment checks accepting cross-drive absolute `relative()` results, so both root approval and symlink write-escape protections can be bypassed. It also still risks overwriting an existing registry on non-ENOENT read failures.

Full review comments:

- [P1] Reject cross-drive paths in approval checks — /home/ice/dev/dohc/apps/desktop/src/main.ts:60-62
  On Windows, `path.relative('C:/approved', 'D:/target')` returns an absolute path on D:, which does not start with `..` or `sep`, so this branch treats a different drive as a descendant of the approved root. Once the default/picked root on C: has been approved, a renderer can pass a D: path to create/attach without that folder ever going through the picker; reject absolute `relative()` results or compare parsed roots before accepting descendants.

- [P1] Reject cross-drive realpaths in file containment — /home/ice/dev/dohc/apps/desktop/src/workspaces/workspaceFiles.ts:30-31
  The same predicate is used after `realpath()`. On Windows, when a workspace on C: contains a directory symlink/junction to another drive, `relative(realRoot, realChild)` returns an absolute D: path that passes this test, so `createFile(root, 'link/evil.md')` still writes through the link outside the workspace. Reject different-drive/absolute relative results before allowing the mkdir/write.

- [P2] Treat unreadable registries as errors — /home/ice/dev/dohc/apps/desktop/src/workspaces/registryStore.ts:32-37
  This catch also handles `EACCES`, `EISDIR`, and other read failures, not just a missing file. If the registry exists but is unreadable while the directory is writable, `read()` caches an empty registry and the next `register()`/`setRemote()` will rename a new file over the existing registry, which is the data-loss case this change is trying to prevent; only treat `ENOENT` as fresh and throw on other read errors.
