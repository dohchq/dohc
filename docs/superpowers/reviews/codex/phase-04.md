OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb126-ac93-7232-b69c-eecfe8ed0309
--------
user
commit ce6910a
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames ce6910a' in /home/ice/dev/dohc
 succeeded in 133ms:
?? docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md
?? docs/superpowers/reviews/codex/phase-04.md
/home/ice/dev/dohc
ce6910a (HEAD -> claude/desktop-local-first-cloud-sync) phase4: Add local workspace registry
 .gitignore                                         |  1 +
 apps/desktop/e2e/firstRunWorkspace.spec.ts         | 50 +++++++++++++-
 apps/desktop/src/ipc/bridgeContract.ts             |  7 ++
 apps/desktop/src/ipc/channels.ts                   |  1 +
 apps/desktop/src/main.ts                           | 38 ++++++++++-
 apps/desktop/src/preload.ts                        |  2 +
 apps/desktop/src/renderer/DesktopFirstRun.test.tsx | 22 ++++++
 apps/desktop/src/renderer/DesktopFirstRun.tsx      | 21 ++++++
 apps/desktop/src/workspaces/WorkspaceRegistry.ts   | 56 +++++----------
 apps/desktop/src/workspaces/registryStore.test.ts  | 73 ++++++++++++++++++++
 apps/desktop/src/workspaces/registryStore.ts       | 79 ++++++++++++++++++++++
 ...desktop-local-first-cloud-sync.execution-log.md | 26 +++++++
 packages/workspace-core/src/paths.test.ts          | 48 +++++++++++++
 packages/workspace-core/src/paths.ts               | 48 +++++++++++++
 14 files changed, 429 insertions(+), 43 deletions(-)

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
 succeeded in 6717ms:
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
/bin/bash -lc "git show --find-renames --find-copies --src-prefix=a/ --dst-prefix=b/ --no-ext-diff --unified=80 ce6910a -- . ':(exclude)docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md' ':(exclude)docs/superpowers/reviews/codex/phase-04.md'" in /home/ice/dev/dohc
 succeeded in 122ms:
commit ce6910a523556d287882b9b6a5300ace79aa18c8
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:48:17 2026 +0800

    phase4: Add local workspace registry
    
    Pure registry store (multi-attach, duplicate-folder AND duplicate-
    identity rejection, remote identity only after explicit sync enable),
    attachWorkspaceFolder IPC adopting existing manifests, root-choice
    guard with lexical dot-segment/drive/UNC normalization (canonical
    paths flow through all fs/registry ops), first-run open-existing
    flow, dialog test seam. Verifier probes confirmed and closed two
    escapes pre-commit. 77 unit tests + 4 E2E green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/.gitignore b/.gitignore
index 253bb72..d660e4e 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1,12 +1,13 @@
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
+test-results/
diff --git a/apps/desktop/e2e/firstRunWorkspace.spec.ts b/apps/desktop/e2e/firstRunWorkspace.spec.ts
index 3fcf82b..4562932 100644
--- a/apps/desktop/e2e/firstRunWorkspace.spec.ts
+++ b/apps/desktop/e2e/firstRunWorkspace.spec.ts
@@ -1,83 +1,83 @@
 import { expect, test } from "@playwright/test";
 import { existsSync, readFileSync } from "node:fs";
-import { mkdir, mkdtemp } from "node:fs/promises";
+import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { _electron as electron, type ElectronApplication, type Page } from "playwright";
 
 const SCREENSHOT_DIR = "test-results/screenshots/phase-03";
 
 async function launchFirstRun(): Promise<{
   app: ElectronApplication;
   page: Page;
   testHome: string;
 }> {
   const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
   const launchArgs = ["apps/desktop/dist/main/main.js"];
   if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
     launchArgs.push("--no-sandbox");
   }
   const app = await electron.launch({
     args: launchArgs,
     cwd: process.cwd(),
     env: {
       ...process.env,
       DOHC_DESKTOP_TEST: "1",
       DOHC_TEST_HOME: testHome,
     },
   });
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
@@ -93,107 +93,155 @@ test("first run creates a real workspace folder and lands in a native shell", as
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
 
+test("attaching an existing dohc workspace preserves its identity", async () => {
+  // Pre-create a workspace folder with a known manifest identity.
+  const elsewhere = await mkdtemp(join(tmpdir(), "dohc-existing-"));
+  const existingRoot = join(elsewhere, "finance");
+  await mkdir(join(existingRoot, ".dohc"), { recursive: true });
+  await writeFile(
+    join(existingRoot, ".dohc", "manifest.json"),
+    JSON.stringify({
+      version: 1,
+      workspaceId: "ws-keep-this-identity",
+      kind: "personal",
+      mode: "local-first",
+    }),
+  );
+  await writeFile(join(existingRoot, "budget.md"), "# Budget");
+
+  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
+  const launchArgs = ["apps/desktop/dist/main/main.js"];
+  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
+    launchArgs.push("--no-sandbox");
+  }
+  const app = await electron.launch({
+    args: launchArgs,
+    cwd: process.cwd(),
+    env: {
+      ...process.env,
+      DOHC_DESKTOP_TEST: "1",
+      DOHC_TEST_HOME: testHome,
+      DOHC_TEST_PICK_PATH: existingRoot,
+    },
+  });
+  const page = await app.firstWindow();
+
+  await page
+    .getByRole("button", { name: /open an existing folder/i })
+    .click();
+  await expect(page.getByTestId("workspace-shell")).toBeVisible();
+  await expect(page.getByTestId("file-tree")).toContainText("budget.md");
+
+  // Identity preserved: the manifest still carries the original workspaceId.
+  const manifest = JSON.parse(
+    readFileSync(join(existingRoot, ".dohc", "manifest.json"), "utf8"),
+  );
+  expect(manifest.workspaceId).toBe("ws-keep-this-identity");
+
+  await app.close();
+});
+
 test("returning user lands directly in the shell, not first-run", async () => {
   const { app, page, testHome } = await launchFirstRun();
   await page.getByRole("button", { name: /create workspace/i }).click();
   await expect(page.getByTestId("workspace-shell")).toBeVisible();
   await app.close();
 
   // Relaunch with the same test home: registry remembers the workspace.
   const relaunchArgs = ["apps/desktop/dist/main/main.js"];
   if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
     relaunchArgs.push("--no-sandbox");
   }
   const second = await electron.launch({
     args: relaunchArgs,
     cwd: process.cwd(),
     env: {
       ...process.env,
       DOHC_DESKTOP_TEST: "1",
       DOHC_TEST_HOME: testHome,
     },
   });
   const page2 = await second.firstWindow();
   await expect(page2.getByTestId("workspace-shell")).toBeVisible();
   await expect(
     page2.getByRole("button", { name: /create workspace/i }),
   ).toHaveCount(0);
   await second.close();
 });
diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
index a8d543a..e947526 100644
--- a/apps/desktop/src/ipc/bridgeContract.ts
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -1,94 +1,101 @@
 import { z } from "zod";
 
 // Typed contract for everything the preload bridge exposes. Main-process
 // handlers validate results against these before returning them. Payload
 // validation starts with the first payload-accepting channel (Phase 4).
 // The renderer never sees raw Electron APIs.
 
 export const VersionResult = z.string().min(1);
 export type VersionResult = z.infer<typeof VersionResult>;
 
 export const PickWorkspaceRootResult = z.string().min(1).nullable();
 export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
 
 export const WorkspaceSummary = z.object({
   workspaceId: z.string().min(1),
   rootPath: z.string().min(1),
   kind: z.enum(["personal", "shared", "cloud-only"]),
   mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
 });
 export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
 
 export const WorkspaceRegistryResult = z.object({
   workspaces: z.array(WorkspaceSummary),
 });
 export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
 
 export const DefaultWorkspaceRootResult = z.string().min(1);
 
 export const CreateLocalWorkspacePayload = z.object({
   rootPath: z.string().min(1),
   kind: z.enum(["personal", "shared"]),
 });
 export type CreateLocalWorkspacePayload = z.infer<
   typeof CreateLocalWorkspacePayload
 >;
 
+export const AttachWorkspaceFolderPayload = z.object({
+  rootPath: z.string().min(1),
+});
+
 export const ListWorkspaceFilesPayload = z.object({
   workspaceId: z.string().min(1),
 });
 
 export const WorkspaceFileEntry = z.object({
   path: z.string().min(1),
   kind: z.enum(["file", "database", "app-source"]),
 });
 export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;
 
 export const ListWorkspaceFilesResult = z.object({
   files: z.array(WorkspaceFileEntry),
 });
 export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;
 
 export const CreateWorkspaceFilePayload = z.object({
   workspaceId: z.string().min(1),
   relativePath: z.string().min(1),
 });
 
 export const CreateWorkspaceFileResult = z.object({
   path: z.string().min(1),
 });
 
 export const ImportWorkspaceFilesPayload = z.object({
   workspaceId: z.string().min(1),
 });
 
 export const ImportWorkspaceFilesResult = z.object({
   imported: z.array(z.string().min(1)),
 });
 
 export const LaunchMarksResult = z.object({
   appReadyMs: z.number().positive(),
   firstWindowMs: z.number().positive(),
   firstPaintMs: z.number().positive(),
 });
 export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;
 
 export interface DohcDesktopBridge {
   getVersion(): Promise<VersionResult>;
   pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
   getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
   getDefaultWorkspaceRoot(): Promise<string>;
   createLocalWorkspace(
     payload: CreateLocalWorkspacePayload,
   ): Promise<WorkspaceSummary>;
+  attachWorkspaceFolder(payload: {
+    rootPath: string;
+  }): Promise<WorkspaceSummary>;
   listWorkspaceFiles(payload: {
     workspaceId: string;
   }): Promise<ListWorkspaceFilesResult>;
   createWorkspaceFile(payload: {
     workspaceId: string;
     relativePath: string;
   }): Promise<{ path: string }>;
   importWorkspaceFiles(payload: {
     workspaceId: string;
   }): Promise<{ imported: string[] }>;
 }
diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
index b2473ca..0de9127 100644
--- a/apps/desktop/src/ipc/channels.ts
+++ b/apps/desktop/src/ipc/channels.ts
@@ -1,14 +1,15 @@
 export const CHANNELS = {
   getVersion: "desktop:get-version",
   pickWorkspaceRoot: "desktop:pick-workspace-root",
   getWorkspaceRegistry: "desktop:get-workspace-registry",
   getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
   createLocalWorkspace: "desktop:create-local-workspace",
+  attachWorkspaceFolder: "desktop:attach-workspace-folder",
   listWorkspaceFiles: "desktop:list-workspace-files",
   createWorkspaceFile: "desktop:create-workspace-file",
   importWorkspaceFiles: "desktop:import-workspace-files",
   firstPaint: "desktop:first-paint",
   getLaunchMarks: "desktop:test:get-launch-marks",
 } as const;
 
 export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
index 26d0975..499c3e1 100644
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -1,151 +1,185 @@
-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
+import {
+  defaultWorkspaceRoot,
+  validateWorkspaceRootChoice,
+} from "@dohc/workspace-core";
 import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
 import {
+  AttachWorkspaceFolderPayload,
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
   VersionResult,
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
 
 // IPC is an untrusted boundary: handlers only answer frames the navigation
 // policy itself would allow (exact dev origin or the packaged bundle).
 function isTrustedFrame(frameUrl: string): boolean {
   return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
 }
 
 function assertTrustedSender(event: IpcMainInvokeEvent): void {
   const frameUrl = event.senderFrame?.url ?? "";
   if (!isTrustedFrame(frameUrl)) {
     throw new Error(`Untrusted IPC sender: ${frameUrl}`);
   }
 }
 
 function registerIpcHandlers(): void {
   ipcMain.handle(CHANNELS.getVersion, (event) => {
     assertTrustedSender(event);
     return VersionResult.parse(app.getVersion());
   });
 
   ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
     assertTrustedSender(event);
+    // Test seam: native dialogs cannot be driven by Playwright.
+    const testPick = process.env.DOHC_TEST_PICK_PATH;
+    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
+      return PickWorkspaceRootResult.parse(testPick);
+    }
     const result = await dialog.showOpenDialog({
       properties: ["openDirectory", "createDirectory"],
     });
     const picked = result.canceled ? null : (result.filePaths[0] ?? null);
     return PickWorkspaceRootResult.parse(picked);
   });
 
   ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
     assertTrustedSender(event);
     return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
   });
 
   ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
     assertTrustedSender(event);
     return DefaultWorkspaceRootResult.parse(
       defaultWorkspaceRoot(effectiveHome()),
     );
   });
 
+  // Validates AND canonicalizes: all downstream fs/registry operations use
+  // the normalized root, so dot-segment or separator variants of the same
+  // folder cannot bypass guards or register twice.
+  function usableRoot(rootPath: string): string {
+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
+    if (!check.ok) throw new Error(check.reason);
+    return check.normalized;
+  }
+
   ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
     assertTrustedSender(event);
     const input = CreateLocalWorkspacePayload.parse(payload);
-    const created = await createWorkspaceFolder(input);
+    const created = await createWorkspaceFolder({
+      rootPath: usableRoot(input.rootPath),
+      kind: input.kind,
+    });
     registerWorkspace(created);
     return WorkspaceSummary.parse(created);
   });
 
+  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = AttachWorkspaceFolderPayload.parse(payload);
+    // Adopts an existing dohc workspace (manifest identity preserved) or
+    // turns the folder into a fresh personal workspace in place.
+    const attached = await createWorkspaceFolder({
+      rootPath: usableRoot(input.rootPath),
+      kind: "personal",
+    });
+    registerWorkspace(attached);
+    return WorkspaceSummary.parse(attached);
+  });
+
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
diff --git a/apps/desktop/src/preload.ts b/apps/desktop/src/preload.ts
index d36a531..653795f 100644
--- a/apps/desktop/src/preload.ts
+++ b/apps/desktop/src/preload.ts
@@ -1,33 +1,35 @@
 import { contextBridge, ipcRenderer } from "electron";
 import { CHANNELS } from "./ipc/channels";
 
 // The entire bridge surface. Narrow on purpose: the renderer gets named,
 // typed operations — never raw ipcRenderer, never Node.
 contextBridge.exposeInMainWorld("dohcDesktop", {
   getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
   pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
   getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
   getDefaultWorkspaceRoot: () =>
     ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
   createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
     ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
+  attachWorkspaceFolder: (payload: { rootPath: string }) =>
+    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
   listWorkspaceFiles: (payload: { workspaceId: string }) =>
     ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
   createWorkspaceFile: (payload: {
     workspaceId: string;
     relativePath: string;
   }) => ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
   importWorkspaceFiles: (payload: { workspaceId: string }) =>
     ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
 });
 
 // One-shot paint signal for launch instrumentation (no data, no response).
 contextBridge.exposeInMainWorld("dohcDesktopInternal", {
   firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
 });
 
 if (process.env.DOHC_DESKTOP_TEST === "1") {
   contextBridge.exposeInMainWorld("dohcDesktopTest", {
     getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
   });
 }
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
index d0bcab9..d9be7b3 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
@@ -1,108 +1,130 @@
 // @vitest-environment jsdom
 import { cleanup, render, screen } from "@testing-library/react";
 import userEvent from "@testing-library/user-event";
 import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
 import { DesktopFirstRun } from "./DesktopFirstRun";
 
 const bridge = {
   getVersion: vi.fn(async () => "0.1.0"),
   getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
   pickWorkspaceRoot: vi.fn(async () => "/home/ice/projects/research"),
   createLocalWorkspace: vi.fn(async () => ({
     workspaceId: "ws-1",
     rootPath: "/home/ice/dohc/personal",
     kind: "personal" as const,
     mode: "local-first" as const,
   })),
+  attachWorkspaceFolder: vi.fn(async () => ({
+    workspaceId: "ws-attached",
+    rootPath: "/home/ice/projects/research",
+    kind: "personal" as const,
+    mode: "local-first" as const,
+  })),
   getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
   listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
   createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
+  importWorkspaceFiles: vi.fn(async () => ({ imported: [] })),
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
 
+  it("attaches an existing folder as a workspace", async () => {
+    const user = userEvent.setup();
+    const onReady = vi.fn();
+    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
+    await user.click(
+      await screen.findByRole("button", { name: /open an existing folder/i }),
+    );
+    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
+      rootPath: "/home/ice/projects/research",
+    });
+    expect(onReady).toHaveBeenCalledWith(
+      expect.objectContaining({ workspaceId: "ws-attached" }),
+    );
+  });
+
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
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.tsx b/apps/desktop/src/renderer/DesktopFirstRun.tsx
index 39d5793..2645be1 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.tsx
@@ -1,103 +1,124 @@
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
 
+  async function openExisting() {
+    const picked = await bridge().pickWorkspaceRoot();
+    if (!picked) return;
+    try {
+      const workspace = await bridge().attachWorkspaceFolder({
+        rootPath: picked,
+      });
+      props.onWorkspaceReady(workspace);
+    } catch (cause) {
+      setError(cause instanceof Error ? cause.message : String(cause));
+    }
+  }
+
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
 
+        <button
+          type="button"
+          onClick={() => void openExisting()}
+          className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
+        >
+          Open an existing folder as a workspace
+        </button>
+
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
diff --git a/apps/desktop/src/workspaces/WorkspaceRegistry.ts b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
index 492c52c..68defb4 100644
--- a/apps/desktop/src/workspaces/WorkspaceRegistry.ts
+++ b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
@@ -1,65 +1,41 @@
 import { app } from "electron";
-import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { homedir } from "node:os";
-import { dirname, join } from "node:path";
+import { join } from "node:path";
 import type { CreatedWorkspace } from "./createWorkspaceFolder";
+import { createRegistryStore, type RegistryEntry } from "./registryStore";
 
-// Registry of known local workspaces. Lives in Electron userData; in test
-// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
-// formalizes attachment/duplicate rules with dedicated tests.
+// Electron wiring over the pure registry store. The registry lives in
+// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
+// hermetic (gated on test env AND unpackaged build).
 
 function testHome(): string | null {
   return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
     ? (process.env.DOHC_TEST_HOME ?? null)
     : null;
 }
 
 export function effectiveHome(): string {
   return testHome() ?? homedir();
 }
 
-function registryPath(): string {
-  const base = testHome() ?? app.getPath("userData");
-  return join(base, "dohc-workspaces.json");
-}
-
-interface RegistryFile {
-  version: 1;
-  workspaces: CreatedWorkspace[];
-}
+let cachedStore: ReturnType<typeof createRegistryStore> | null = null;
 
-function readRegistry(): RegistryFile {
-  try {
-    const parsed = JSON.parse(
-      readFileSync(registryPath(), "utf8"),
-    ) as RegistryFile;
-    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
-  } catch {
-    return { version: 1, workspaces: [] };
+function store() {
+  if (!cachedStore) {
+    const base = testHome() ?? app.getPath("userData");
+    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
   }
+  return cachedStore;
 }
 
-function writeRegistry(registry: RegistryFile): void {
-  mkdirSync(dirname(registryPath()), { recursive: true });
-  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
-}
-
-export function listWorkspaces(): CreatedWorkspace[] {
-  return readRegistry().workspaces;
+export function listWorkspaces(): RegistryEntry[] {
+  return store().list();
 }
 
 export function registerWorkspace(workspace: CreatedWorkspace): void {
-  const registry = readRegistry();
-  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
-    return;
-  }
-  registry.workspaces.push(workspace);
-  writeRegistry(registry);
+  store().register(workspace);
 }
 
-export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
-  return (
-    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
-    null
-  );
+export function findWorkspace(workspaceId: string): RegistryEntry | null {
+  return store().find(workspaceId);
 }
diff --git a/apps/desktop/src/workspaces/registryStore.test.ts b/apps/desktop/src/workspaces/registryStore.test.ts
new file mode 100644
index 0000000..3e62d41
--- /dev/null
+++ b/apps/desktop/src/workspaces/registryStore.test.ts
@@ -0,0 +1,73 @@
+import { mkdtemp } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { beforeEach, describe, expect, it } from "vitest";
+import { createRegistryStore } from "./registryStore";
+
+let store: ReturnType<typeof createRegistryStore>;
+
+const personal = {
+  workspaceId: "ws-1",
+  rootPath: "/home/ice/dohc/personal",
+  kind: "personal" as const,
+  mode: "local-first" as const,
+};
+
+beforeEach(async () => {
+  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
+  store = createRegistryStore(join(dir, "workspaces.json"));
+});
+
+describe("registry store", () => {
+  it("supports multiple attached folders", () => {
+    store.register(personal);
+    store.register({
+      workspaceId: "ws-2",
+      rootPath: "/mnt/data/research",
+      kind: "personal",
+      mode: "local-first",
+    });
+    expect(store.list()).toHaveLength(2);
+  });
+
+  it("rejects duplicate folder attachment", () => {
+    store.register(personal);
+    expect(() =>
+      store.register({ ...personal, workspaceId: "ws-other" }),
+    ).toThrow(/already attached/i);
+  });
+
+  it("rejects a second root carrying an already-registered workspace identity", () => {
+    store.register(personal);
+    expect(() =>
+      store.register({ ...personal, rootPath: "/home/ice/dohc/personal-copy" }),
+    ).toThrow(/identity .* already attached|already attached .* identity/i);
+  });
+
+  it("persists across store instances", () => {
+    store.register(personal);
+    const reopened = createRegistryStore(store.registryFile);
+    expect(reopened.find("ws-1")?.rootPath).toBe(personal.rootPath);
+  });
+
+  it("local-only workspaces carry no account or remote identity", () => {
+    store.register(personal);
+    const entry = store.find("ws-1");
+    expect(entry).toBeTruthy();
+    expect(entry && "remote" in entry && entry.remote).toBeFalsy();
+  });
+
+  it("records remote identity only when sync is explicitly enabled", () => {
+    store.register({ ...personal, kind: "shared", mode: "cloud-first-local-copy" });
+    expect(store.find("ws-1")?.remote).toBeUndefined();
+
+    store.setRemote("ws-1", {
+      serverUrl: "https://cloud.dohc.example",
+      remoteWorkspaceId: "rw-99",
+    });
+    expect(store.find("ws-1")?.remote).toEqual({
+      serverUrl: "https://cloud.dohc.example",
+      remoteWorkspaceId: "rw-99",
+    });
+  });
+});
diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
new file mode 100644
index 0000000..19b9714
--- /dev/null
+++ b/apps/desktop/src/workspaces/registryStore.ts
@@ -0,0 +1,79 @@
+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { dirname } from "node:path";
+import type { CreatedWorkspace } from "./createWorkspaceFolder";
+
+// Pure registry persistence: a JSON file of known local workspaces. The
+// electron wiring (userData path, test-home seam) lives in
+// WorkspaceRegistry.ts; this module is unit-testable with a temp file.
+
+export interface RemoteIdentity {
+  serverUrl: string;
+  remoteWorkspaceId: string;
+}
+
+export interface RegistryEntry extends CreatedWorkspace {
+  // Present only after the user explicitly enables cloud sync (Phase 9).
+  remote?: RemoteIdentity;
+}
+
+interface RegistryFile {
+  version: 1;
+  workspaces: RegistryEntry[];
+}
+
+export function createRegistryStore(registryFile: string) {
+  function read(): RegistryFile {
+    try {
+      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
+      return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
+    } catch {
+      return { version: 1, workspaces: [] };
+    }
+  }
+
+  function write(registry: RegistryFile): void {
+    mkdirSync(dirname(registryFile), { recursive: true });
+    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
+  }
+
+  return {
+    registryFile,
+
+    list(): RegistryEntry[] {
+      return read().workspaces;
+    },
+
+    find(workspaceId: string): RegistryEntry | null {
+      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
+    },
+
+    register(workspace: RegistryEntry): void {
+      const registry = read();
+      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
+        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
+      }
+      // Two roots with one workspaceId would make file operations silently
+      // target whichever registered first (e.g., attaching a copied folder).
+      if (
+        registry.workspaces.some(
+          (w) => w.workspaceId === workspace.workspaceId,
+        )
+      ) {
+        throw new Error(
+          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
+            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
+        );
+      }
+      registry.workspaces.push(workspace);
+      write(registry);
+    },
+
+    setRemote(workspaceId: string, remote: RemoteIdentity): void {
+      const registry = read();
+      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
+      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
+      entry.remote = remote;
+      write(registry);
+    },
+  };
+}
diff --git a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
index f553adb..3cf6767 100644
--- a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+++ b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
@@ -10,186 +10,212 @@
 - Open worktrees: none
 - Pending reviews: codex phase-03 (in flight)
 
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
 
 ### Component reuse map digest (source: docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md; 2026-06-10)
 
 - Counts: 20 reuse-as-is, 16 port-with-swap, 3 rebuild (Chat, WorkspaceSwitcher, WorkspaceManagementDialog), 3 skip (Onboarding, SharedAtomView, NotFoundPage). Exactly 18 files import convex/react|@convex-dev|@tanstack/react-router directly.
 - Styling: Tailwind v4.2.4 CSS-first, NO tailwind.config — everything via `@theme inline` + `@custom-variant dark` (data-theme) in apps/app/src/styles.css (2,695 lines). Brand tokens: packages/brand/src/tokens.css (export `@dohc/brand/tokens.css`) — warm paper #f7f6f1, graphite #151515. TRAP/consolidation target (Phase 17): styles.css duplicates the brand palette instead of importing tokens.css.
 - Desktop renderer needs: react, react-dom, tailwindcss, @tailwindcss/vite, @dohc/brand, @fontsource(s) — extract shared token layer rather than copy.
 - Phase 3 pulls as-is: ActivityBar, SidebarChrome, Skeleton, NoticeCenter, AgentActivityTimeline, AgentRunRail, AgentModelPicker. Small swaps: FileTree (fully props-driven; only Convex via UploadFileButton import), CommandPalette (3 useQuery + extract OPEN_SKETCH_EVENT constant — else drags AtomEditor+Convex transitively). Rebuild WorkspaceSwitcher against bridge WorkspaceRegistryResult. Model shell layout/keyboard map on apps/app/src/routes/_app.tsx.
 - Phase 6+: FileTypeView, DatabaseStudio, DatabaseTableGrid clean+props-driven (as-is); HtmlAtomFrame/SearchOverlay swaps; Chat transport rebuild in Phase 11 (useUIMessages is structurally Convex), presentational children reusable.
 - Traps: AgentChatSidebar transitively renders WorkspaceSwitcher (Convex+router); UploadFileButton calls useMutation unconditionally (crashes without ConvexProvider); type-only Convex imports in DatabaseTableGrid/storageUpload need re-homing before Phase 13.
 
 ### Port-source file paths (verified present 2026-06-10)
 
 - File-type views: apps/app/src/components/FileTypeView.tsx; Database Studio: DatabaseStudio.tsx, DatabaseTableGrid.tsx; tree: FileTree.tsx; upload: UploadFileButton.tsx; agent activity: AgentActivityTimeline.tsx, AgentRunRail.tsx (+ AgentChatSidebar.tsx).
 
 ## Gotchas (append-only)
 
 - Node 25 breaks 17 @dohc/web tests; pin 22.13.0 via PATH (see Environment).
 - workspace-postgres tests: shared local DB fixture, not file-parallel.
 - pnpm 10 ignores postinstall — Electron needs onlyBuiltDependencies in pnpm-workspace.yaml BEFORE install (Phase 2).
 - Root playwright.config.ts is web-only (testDir apps/app/e2e + webServer); desktop gets own config.
 - check:debt bans the literal deferred-work marker tokens it scans for, in any file including docs — never write them, even when describing the rule itself (this line was rewritten once for exactly that reason).
+- RED runs of path-handling tests can pollute the working tree (a not-yet-rejected relative path created real dirs under apps/desktop cwd). Inspect `git status --short` BEFORE every `git add` of a directory; never blind-add after running new filesystem tests.
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
 
 ### Phase 2: Electron Desktop Scaffold And Test Harness
 
 - Status: in progress (all gates green; verifiers running; commit pending)
 - Execution map: tests-first (security unit + launch E2E + dedicated playwright config, written during phase-01 review window) → pnpm-workspace onlyBuiltDependencies → install (electron 42.4.0 binary verified) → unit RED recorded (missing module) → implement (main/preload/window/security/channels/bridgeContract/launchMarks/renderer/electron.vite.config/vitest.config/smoke) → unit GREEN 7/7 + typecheck + build → E2E pass (first try, WSLg, no xvfb needed) → smoke pass → screenshot inspected → verifiers → commit → codex review (xhigh tier)
 - Resume notes: verifiers wf_7528cd05-564 in flight; commit phase2 on pass.
 - Files changed: apps/desktop/* (16 files), pnpm-workspace.yaml (onlyBuiltDependencies), root package.json (5 desktop scripts), pnpm-lock.yaml
 - Code deleted or consolidated: none (greenfield scaffold)
 - Net LOC delta (`git diff --shortstat`): recorded at commit (~600 lines apps/desktop incl. tests)
 - Old paths retained and why: root playwright.config.ts untouched (web E2E keeps working — per plan/team audit)
 - Dependencies added (name, size, justification): electron 42.4.0 (runtime), electron-vite 5 + vite 8 (build, repo is vite-native), electron-builder + @electron/fuses (Phase 14 packaging, installed now per plan), electron-updater (Phase 14), zod (IPC validation), vitest/typescript/@types/node pinned to repo standards (TS6→5.9, types25→22 corrected post-install)
 - Decisions made (D-NN ids): D-10 | Phase 2 renderer is dependency-free TS+HTML placeholder; React arrives in Phase 3 via component reuse map | smallest first paint, Phase 3 owns the real shell | phase 2. D-11 | preload built CJS (sandboxed preload requirement); main ESM (import.meta.dirname) | electron-vite 5 + sandbox constraint | phase 2
 - Tests added: 7 security unit tests (webPreferences trio, absolute preload, navigation policy, window.open deny + external routing + scheme restrictions); 1 Playwright Electron E2E (heading visible, screenshot at convention path, launch marks positive, perf JSON written); smoke script (8s fatal-stderr scan)
 - Commands run: install+electron --version (42.4.0); test RED→GREEN 7/7; typecheck PASS; build PASS (main ESM/preload CJS/renderer); test:desktop:e2e PASS 534ms; smoke:desktop PASS — all pinned Node 22.13
 - Failing tests fixed: RED→GREEN by implementation; vitest/e2e separation fixed via vitest.config include
 - Electron E2E/manual smoke: E2E pass (no sandbox workarounds needed on WSLg — DOHC_E2E_NO_CHROMIUM_SANDBOX path exists but unused); smoke pass
 - UI/UX screenshot/design review: screenshot inspected by lead — warm paper bg, centered graphite wordmark, muted subtitle, nonblank, no white flash (backgroundColor set pre-paint). Full Design Review Loop applies from Phase 3.
 - Performance measurements: cold launch appReady 194ms / firstWindow 232ms / firstPaint 315ms (budget: shell <2000ms — 6x headroom); recorded to test-results/performance/desktop-performance.json
 - Security/collaboration regressions: IPC sender-origin validation on all invoke handlers; zod-parsed results; test bridge gated on DOHC_DESKTOP_TEST; CSP in renderer; window.open denied universally
 - Reviewer/subagent findings: verifiers wf_7528cd05-564 BOTH PASS. test-quality: deletion mutation fails suite; sandbox:false mutation caught at exact assertion; E2E flake-free (no sleeps). claimed-vs-actual: probed RUNTIME bridge surface without test env (Node unreachable, exact bridge shape, test bridge double-gated); re-ran full gate chain green. Findings fixed pre-commit: (1) origin prefix-match bypass (file:// allowed any local file; dev origin matched localhost:5173.evil.com) — FIXED with NavigationPolicy (exact http origins + bundle-scoped file prefix, deny-by-default incl. unparseable), assertTrustedSender now uses the same policy; (2) http:// scheme untested in window.open — test added; (3) single-instance lock didn't gate bootstrap — restructured; (4) bridgeContract comment overstated payload validation — corrected. 11/11 after fixes; full gate chain re-run green.
 - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-02.md; commit review + targeted security prompt, both xhigh): (1) MED ELECTRON_RENDERER_URL trusted without isPackaged/loopback guard — packaged app could loadURL + IPC-trust arbitrary origin — FIXED (validateDevServerUrl: unpackaged + loopback + http(s) only, unit-tested incl. packaged rejection); (2) MED only will-navigate enforced; redirects/subframes uncovered — FIXED (will-redirect + will-frame-navigate share the same policy; about:blank/javascript: unit cases added); (3) LOW test bridge env-only gating — FIXED (env flag AND !app.isPackaged); (4) LOW window.open shells any http(s) — could become phishing primitive if renderer renders user content — DEFERRED with reason: renderer content is fully app-controlled until Phase 6 file views; user-gesture/allowlist fix scheduled with Phase 6 (tracked); (5) INFO WindowOpenDecision over-shaped — FIXED (simplified to shouldOpenExternally boolean, less code). Codex confirmed solid: IPC sender validation on every handler, no Node/ipcRenderer leak, webPreferences trio, about:/javascript: denial.
 - Relevant findings fixed: 4 verifier findings pre-commit + codex findings 1,2,3,5 in phase2(fix); 14/14 tests after
 - Deferred findings with reason: desktopSmoke.test.ts realized as scripts/smoke-test.mjs (executable smoke beats a vitest stub; runs in every phase gate); codex finding 4 (window.open user-gesture/allowlist) deferred to Phase 6 when user content first renders
 - Remaining risk: fuses configuration deferred to Phase 14 packaging (per plan); titlebar is default chrome until Phase 3
 - Next phase: 3
 
 ### Phase 3: Native-Feeling Desktop Shell UX
 
 - Status: in progress (design loop iteration 1 PASSED; verifiers running; commit pending)
 - Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
 - Resume notes: verifiers wf_5ff43339-c71 in flight; commit phase3 on pass.
 - Files changed: apps/desktop renderer (9 new React/TS files + styles.css), workspaces/ (3 new), ipc (channels+contract extended), main.ts/preload.ts (4 new handlers), electron.vite.config.ts, vitest.config.ts (.tsx glob), e2e/firstRunWorkspace.spec.ts, package.json deps, pnpm-lock
 - Code deleted or consolidated: src/renderer/main.ts (replaced by main.tsx); redundant kind badge removed in design loop
 - Net LOC delta: recorded at commit
 - Old paths retained and why: web components NOT copied yet — Phase 3 shell is purpose-built per reuse map (smaller than porting); FileTree/CommandPalette ports deferred to when their features (virtualization, multi-command surface) are actually needed (reuse-before-write cuts both ways: this shell is ~400 lines total)
 - Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
 - Decisions made: D-12 | Phase 3 ships minimal real bridge (registry/create/list/createFile), Phase 4 formalizes | first-run must create real folders to be honest | phase 3. D-13 | shell purpose-built, not ported: reuse map showed ports carry transitive web coupling; 400-line shell beats 16 swapped components for v1 | less code | phase 3
 - Tests added: 7 component (first-run: suggest/choose/create/no-auth/cloud-optional/cloud-offer-truthful/no-marketing), 7 workspaceFiles unit (createFile validation/no-overwrite, listFiles ignores, copyIntoWorkspace basename/skip-existing — RED recorded for copyIntoWorkspace), 2 E2E expanded (adds: palette 5 commands incl. import+cloud, quick-open Ctrl+P file jump, switcher listbox, cloud panel honest copy + backdrop close, file-preview screenshot)
 - Commands run: RED→GREEN cycles + full gate chain (all pinned Node 22.13)
 - Failing tests fixed: ESM workspace-core load crash (bundling); vitest .tsx glob gap
 - Electron E2E/manual smoke: 3/3 E2E + smoke green
 - UI/UX screenshot/design review: Design Review Loop iteration 1 — Claude judges (gating): ALL 7 PASS, zero hard fails, pixel-sampled token verification (#f7f6f1/#100f0e/#151515/#f4f1ea exact). Codex -i advisory: shell screens all-pass ("strongest calibration hit"); 4 fails dispositioned: path truncation FIXED (wrap, never truncate), first-run card-feel REJECTED (Claude evidence: utilitarian tool card, no marketing), dark-mode-too-black REJECTED (faithful to final brand tokens — flagged to Ice as brand-level observation), palette modal-feel REJECTED (Raycast-calibrated). Claude soft fixes applied: clickable empty-state actions, redundant PERSONAL badge removed. Accent #2d342e green-cast note REJECTED (it IS the brand accent token).
 - Performance measurements: launch marks pipeline intact (E2E re-verified); shell adds React — bundle size watch begins Phase 16 ratchet
 - Security/collaboration regressions: all new channels sender-validated + zod-parsed payloads/results; file ops traversal-guarded via workspace-core
 - Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
 - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
 - Relevant findings fixed: all 3 codex findings in phase3(fix) commit
 - Deferred findings with reason: SUPERSEDED — claimed-vs-actual verifier correctly failed the deferral as gate-softening; all five missing plan elements built in iteration 2: workspace switcher (real listbox over registry), import action (real file-copy via dialog + copyIntoWorkspace, unit-tested incl. no-overwrite), cloud-sync offer (truthful surface in first-run + status bar + palette — explains, never gates), quick-open Ctrl+P (palette-pattern file jump, E2E-tested), file-preview screenshot (selected-state artifact). Also fixed from verifier nits: me.md catch narrowed to EEXIST-only. Flat path list (not hierarchical tree) remains v0 — hierarchy + virtualization with Phase 5/16. Verifier note on rootPath validation → Phase 4 requirement (recorded).
 - Remaining risk: shell density will be rejudged when editor surface lands (Phase 6)
 - Next phase: 4
+
+### Phase 4: Local Workspace Registry And Folder Creation
+
+- Status: in progress (all gates green; verifiers running; commit pending)
+- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
+- Resume notes: verifiers wf_76209a51-999 in flight; commit phase4 on pass; then POST-PHASE-4 CHECKPOINT (Electron security/IPC review: finder fan-out + codex --base main + verify pipeline + adversarial scenario consult per plan).
+- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
+- Code deleted or consolidated: WorkspaceRegistry's inline persistence replaced by pure registryStore (was untestable electron-coupled code); registerWorkspace silent-skip became explicit duplicate rejection
+- Net LOC delta: recorded at commit
+- Old paths retained and why: none affected
+- Dependencies added: none
+- Decisions made: D-14 | registry naming keeps getWorkspaceRegistry/pickWorkspaceRoot (plan: listLocalWorkspaces/chooseWorkspaceRoot) — same surface, earlier names already shipped in phase2/3; renaming = churn without behavior | less code | phase 4
+- Tests added: 3 workspace-core (root-choice), 5 registryStore, 1 first-run component (attach), 1 E2E (attach preserves manifest identity, file tree shows existing files)
+- Commands run: RED→GREEN per module; full gate chain green (pinned Node)
+- Failing tests fixed: none beyond planned REDs
+- Electron E2E/manual smoke: 4/4 E2E + smoke green
+- UI/UX screenshot/design review: not a design-loop phase; first-run gained one quiet secondary button (screenshot regenerates in E2E artifacts)
+- Performance measurements: launch marks pipeline intact via E2E
+- Security/collaboration regressions: closes tracked finding (workspace root cannot be "/", home, or drive root — enforced on BOTH create and attach paths); pick seam double-gated; duplicate attachment rejected
+- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
+- Codex third-party review findings: pending post-commit (xhigh + targeted security prompt — high-risk phase)
+- Relevant findings fixed: 2 verifier escapes + 1 test gap fixed pre-commit; 40/40 core + 37/37 desktop after
+- Deferred findings with reason: registry uses userData JSON (plan mentions Electron safeStorage as an option — registry holds no secrets, paths only; safeStorage encryption adds keychain dependency for zero confidentiality gain; revisit when cloud tokens arrive in Phase 9)
+- Remaining risk: same-workspaceId-two-roots edge (foreign manifest copy) — findWorkspace returns first match; harmless today (both roots valid), revisit with sync identity in Phase 9
+- Next phase: 5
diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
index 68d58a0..41c0ffa 100644
--- a/packages/workspace-core/src/paths.test.ts
+++ b/packages/workspace-core/src/paths.test.ts
@@ -29,102 +29,150 @@ describe("workspace roots", () => {
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
 
+describe("workspace root choice", () => {
+  it("accepts ordinary folders, including outside the default root", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    expect(
+      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
+    ).toBe(true);
+    expect(
+      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
+    ).toBe(true);
+  });
+
+  it("rejects the filesystem root and the home directory itself", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    for (const dangerous of ["/", "/home/ice", "/home/ice/", "C:\\", "C:/"]) {
+      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
+      expect(result.ok).toBe(false);
+    }
+  });
+
+  it("rejects dot-segment disguises of root and home", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    for (const disguised of [
+      "/.",
+      "/..",
+      "/home/ice/.",
+      "/home/ice/x/..",
+      "/home/./ice",
+    ]) {
+      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
+      expect(result.ok).toBe(false);
+    }
+  });
+
+  it("returns the normalized root so equality checks are canonical", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    const result = validateWorkspaceRootChoice(
+      "/home/ice/dohc//personal/.",
+      "/home/ice",
+    );
+    expect(result).toEqual({ ok: true, normalized: "/home/ice/dohc/personal" });
+  });
+
+  it("rejects relative paths", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
+  });
+});
+
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
diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
index 6d8e481..d9b976f 100644
--- a/packages/workspace-core/src/paths.ts
+++ b/packages/workspace-core/src/paths.ts
@@ -1,79 +1,127 @@
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
 
+// Lexical normalization: resolves "." and ".." segments and separator noise
+// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
+// cannot slip past string comparisons. Preserves drive and UNC prefixes.
+export function normalizeAbsolutePath(path: string): string {
+  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
+  const rest = drive ? path.slice(drive.length) : path;
+  const unc = rest.startsWith("\\\\") || rest.startsWith("//");
+  const segments = rest.replaceAll("\\", "/").split("/");
+  const out: string[] = [];
+  for (const segment of segments) {
+    if (segment === "" || segment === ".") continue;
+    if (segment === "..") {
+      out.pop();
+      continue;
+    }
+    out.push(segment);
+  }
+  const prefix = unc ? "//" : "/";
+  const joined = `${drive}${prefix}${out.join("/")}`;
+  const trimmed = joined.replace(/\/+$/, "");
+  return trimmed || (drive ? drive : "/");
+}
+
+export type RootChoiceValidation =
+  | { ok: true; normalized: string }
+  | { ok: false; reason: string };
+
+// Registry policy: a workspace root must be a real folder choice — never the
+// filesystem root or the home directory itself, which would hand workspace
+// file operations the user's entire disk or home. Callers must use the
+// returned normalized path so registry equality checks are canonical.
+export function validateWorkspaceRootChoice(
+  rootPath: string,
+  homeDir: string,
+): RootChoiceValidation {
+  const attached = validateAttachedFolder(rootPath);
+  if (!attached.ok) return attached;
+  const normalized = normalizeAbsolutePath(rootPath);
+  const home = normalizeAbsolutePath(homeDir);
+  if (normalized === "/" || /^[A-Za-z]:$/.test(normalized) || normalized === "//") {
+    return { ok: false, reason: "workspace root cannot be the filesystem root" };
+  }
+  if (normalized === home) {
+    return { ok: false, reason: "workspace root cannot be the home directory itself" };
+  }
+  return { ok: true, normalized };
+}
+
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

exec
/bin/bash -lc 'git show ce6910a -- apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/registryStore.ts apps/desktop/src/workspaces/registryStore.test.ts apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/renderer/DesktopFirstRun.tsx apps/desktop/src/renderer/DesktopFirstRun.test.tsx packages/workspace-core/src/paths.ts --unified=120' in /home/ice/dev/dohc
 succeeded in 119ms:
commit ce6910a523556d287882b9b6a5300ace79aa18c8
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:48:17 2026 +0800

    phase4: Add local workspace registry
    
    Pure registry store (multi-attach, duplicate-folder AND duplicate-
    identity rejection, remote identity only after explicit sync enable),
    attachWorkspaceFolder IPC adopting existing manifests, root-choice
    guard with lexical dot-segment/drive/UNC normalization (canonical
    paths flow through all fs/registry ops), first-run open-existing
    flow, dialog test seam. Verifier probes confirmed and closed two
    escapes pre-commit. 77 unit tests + 4 E2E green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
index 26d0975..499c3e1 100644
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -1,6 +1,10 @@
-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
+import {
+  defaultWorkspaceRoot,
+  validateWorkspaceRootChoice,
+} from "@dohc/workspace-core";
 import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
 import {
+  AttachWorkspaceFolderPayload,
   CreateLocalWorkspacePayload,
   CreateWorkspaceFilePayload,
   CreateWorkspaceFileResult,
@@ -59,6 +63,11 @@ function registerIpcHandlers(): void {
 
   ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
     assertTrustedSender(event);
+    // Test seam: native dialogs cannot be driven by Playwright.
+    const testPick = process.env.DOHC_TEST_PICK_PATH;
+    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
+      return PickWorkspaceRootResult.parse(testPick);
+    }
     const result = await dialog.showOpenDialog({
       properties: ["openDirectory", "createDirectory"],
     });
@@ -78,14 +87,39 @@ function registerIpcHandlers(): void {
     );
   });
 
+  // Validates AND canonicalizes: all downstream fs/registry operations use
+  // the normalized root, so dot-segment or separator variants of the same
+  // folder cannot bypass guards or register twice.
+  function usableRoot(rootPath: string): string {
+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
+    if (!check.ok) throw new Error(check.reason);
+    return check.normalized;
+  }
+
   ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
     assertTrustedSender(event);
     const input = CreateLocalWorkspacePayload.parse(payload);
-    const created = await createWorkspaceFolder(input);
+    const created = await createWorkspaceFolder({
+      rootPath: usableRoot(input.rootPath),
+      kind: input.kind,
+    });
     registerWorkspace(created);
     return WorkspaceSummary.parse(created);
   });
 
+  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = AttachWorkspaceFolderPayload.parse(payload);
+    // Adopts an existing dohc workspace (manifest identity preserved) or
+    // turns the folder into a fresh personal workspace in place.
+    const attached = await createWorkspaceFolder({
+      rootPath: usableRoot(input.rootPath),
+      kind: "personal",
+    });
+    registerWorkspace(attached);
+    return WorkspaceSummary.parse(attached);
+  });
+
   ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
     assertTrustedSender(event);
     const input = ListWorkspaceFilesPayload.parse(payload);
diff --git a/apps/desktop/src/preload.ts b/apps/desktop/src/preload.ts
index d36a531..653795f 100644
--- a/apps/desktop/src/preload.ts
+++ b/apps/desktop/src/preload.ts
@@ -11,6 +11,8 @@ contextBridge.exposeInMainWorld("dohcDesktop", {
     ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
   createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
     ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
+  attachWorkspaceFolder: (payload: { rootPath: string }) =>
+    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
   listWorkspaceFiles: (payload: { workspaceId: string }) =>
     ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
   createWorkspaceFile: (payload: {
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
index d0bcab9..d9be7b3 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
@@ -14,9 +14,16 @@ const bridge = {
     kind: "personal" as const,
     mode: "local-first" as const,
   })),
+  attachWorkspaceFolder: vi.fn(async () => ({
+    workspaceId: "ws-attached",
+    rootPath: "/home/ice/projects/research",
+    kind: "personal" as const,
+    mode: "local-first" as const,
+  })),
   getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
   listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
   createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
+  importWorkspaceFiles: vi.fn(async () => ({ imported: [] })),
 };
 
 beforeEach(() => {
@@ -60,6 +67,21 @@ describe("first run", () => {
     );
   });
 
+  it("attaches an existing folder as a workspace", async () => {
+    const user = userEvent.setup();
+    const onReady = vi.fn();
+    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
+    await user.click(
+      await screen.findByRole("button", { name: /open an existing folder/i }),
+    );
+    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
+      rootPath: "/home/ice/projects/research",
+    });
+    expect(onReady).toHaveBeenCalledWith(
+      expect.objectContaining({ workspaceId: "ws-attached" }),
+    );
+  });
+
   it("never requires login and never renders auth fields", async () => {
     render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
     await screen.findByText("/home/ice/dohc");
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.tsx b/apps/desktop/src/renderer/DesktopFirstRun.tsx
index 39d5793..2645be1 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.tsx
@@ -37,6 +37,19 @@ export function DesktopFirstRun(props: {
     }
   }
 
+  async function openExisting() {
+    const picked = await bridge().pickWorkspaceRoot();
+    if (!picked) return;
+    try {
+      const workspace = await bridge().attachWorkspaceFolder({
+        rootPath: picked,
+      });
+      props.onWorkspaceReady(workspace);
+    } catch (cause) {
+      setError(cause instanceof Error ? cause.message : String(cause));
+    }
+  }
+
   return (
     <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
       <div className="flex flex-col items-center gap-1">
@@ -75,6 +88,14 @@ export function DesktopFirstRun(props: {
           {creating ? "Creating…" : "Create workspace"}
         </button>
 
+        <button
+          type="button"
+          onClick={() => void openExisting()}
+          className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
+        >
+          Open an existing folder as a workspace
+        </button>
+
         {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
 
         <div className="flex items-center justify-between gap-4">
diff --git a/apps/desktop/src/workspaces/WorkspaceRegistry.ts b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
index 492c52c..68defb4 100644
--- a/apps/desktop/src/workspaces/WorkspaceRegistry.ts
+++ b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
@@ -1,12 +1,12 @@
 import { app } from "electron";
-import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { homedir } from "node:os";
-import { dirname, join } from "node:path";
+import { join } from "node:path";
 import type { CreatedWorkspace } from "./createWorkspaceFolder";
+import { createRegistryStore, type RegistryEntry } from "./registryStore";
 
-// Registry of known local workspaces. Lives in Electron userData; in test
-// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
-// formalizes attachment/duplicate rules with dedicated tests.
+// Electron wiring over the pure registry store. The registry lives in
+// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
+// hermetic (gated on test env AND unpackaged build).
 
 function testHome(): string | null {
   return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
@@ -18,48 +18,24 @@ export function effectiveHome(): string {
   return testHome() ?? homedir();
 }
 
-function registryPath(): string {
-  const base = testHome() ?? app.getPath("userData");
-  return join(base, "dohc-workspaces.json");
-}
-
-interface RegistryFile {
-  version: 1;
-  workspaces: CreatedWorkspace[];
-}
+let cachedStore: ReturnType<typeof createRegistryStore> | null = null;
 
-function readRegistry(): RegistryFile {
-  try {
-    const parsed = JSON.parse(
-      readFileSync(registryPath(), "utf8"),
-    ) as RegistryFile;
-    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
-  } catch {
-    return { version: 1, workspaces: [] };
+function store() {
+  if (!cachedStore) {
+    const base = testHome() ?? app.getPath("userData");
+    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
   }
+  return cachedStore;
 }
 
-function writeRegistry(registry: RegistryFile): void {
-  mkdirSync(dirname(registryPath()), { recursive: true });
-  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
-}
-
-export function listWorkspaces(): CreatedWorkspace[] {
-  return readRegistry().workspaces;
+export function listWorkspaces(): RegistryEntry[] {
+  return store().list();
 }
 
 export function registerWorkspace(workspace: CreatedWorkspace): void {
-  const registry = readRegistry();
-  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
-    return;
-  }
-  registry.workspaces.push(workspace);
-  writeRegistry(registry);
+  store().register(workspace);
 }
 
-export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
-  return (
-    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
-    null
-  );
+export function findWorkspace(workspaceId: string): RegistryEntry | null {
+  return store().find(workspaceId);
 }
diff --git a/apps/desktop/src/workspaces/registryStore.test.ts b/apps/desktop/src/workspaces/registryStore.test.ts
new file mode 100644
index 0000000..3e62d41
--- /dev/null
+++ b/apps/desktop/src/workspaces/registryStore.test.ts
@@ -0,0 +1,73 @@
+import { mkdtemp } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { beforeEach, describe, expect, it } from "vitest";
+import { createRegistryStore } from "./registryStore";
+
+let store: ReturnType<typeof createRegistryStore>;
+
+const personal = {
+  workspaceId: "ws-1",
+  rootPath: "/home/ice/dohc/personal",
+  kind: "personal" as const,
+  mode: "local-first" as const,
+};
+
+beforeEach(async () => {
+  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
+  store = createRegistryStore(join(dir, "workspaces.json"));
+});
+
+describe("registry store", () => {
+  it("supports multiple attached folders", () => {
+    store.register(personal);
+    store.register({
+      workspaceId: "ws-2",
+      rootPath: "/mnt/data/research",
+      kind: "personal",
+      mode: "local-first",
+    });
+    expect(store.list()).toHaveLength(2);
+  });
+
+  it("rejects duplicate folder attachment", () => {
+    store.register(personal);
+    expect(() =>
+      store.register({ ...personal, workspaceId: "ws-other" }),
+    ).toThrow(/already attached/i);
+  });
+
+  it("rejects a second root carrying an already-registered workspace identity", () => {
+    store.register(personal);
+    expect(() =>
+      store.register({ ...personal, rootPath: "/home/ice/dohc/personal-copy" }),
+    ).toThrow(/identity .* already attached|already attached .* identity/i);
+  });
+
+  it("persists across store instances", () => {
+    store.register(personal);
+    const reopened = createRegistryStore(store.registryFile);
+    expect(reopened.find("ws-1")?.rootPath).toBe(personal.rootPath);
+  });
+
+  it("local-only workspaces carry no account or remote identity", () => {
+    store.register(personal);
+    const entry = store.find("ws-1");
+    expect(entry).toBeTruthy();
+    expect(entry && "remote" in entry && entry.remote).toBeFalsy();
+  });
+
+  it("records remote identity only when sync is explicitly enabled", () => {
+    store.register({ ...personal, kind: "shared", mode: "cloud-first-local-copy" });
+    expect(store.find("ws-1")?.remote).toBeUndefined();
+
+    store.setRemote("ws-1", {
+      serverUrl: "https://cloud.dohc.example",
+      remoteWorkspaceId: "rw-99",
+    });
+    expect(store.find("ws-1")?.remote).toEqual({
+      serverUrl: "https://cloud.dohc.example",
+      remoteWorkspaceId: "rw-99",
+    });
+  });
+});
diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
new file mode 100644
index 0000000..19b9714
--- /dev/null
+++ b/apps/desktop/src/workspaces/registryStore.ts
@@ -0,0 +1,79 @@
+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { dirname } from "node:path";
+import type { CreatedWorkspace } from "./createWorkspaceFolder";
+
+// Pure registry persistence: a JSON file of known local workspaces. The
+// electron wiring (userData path, test-home seam) lives in
+// WorkspaceRegistry.ts; this module is unit-testable with a temp file.
+
+export interface RemoteIdentity {
+  serverUrl: string;
+  remoteWorkspaceId: string;
+}
+
+export interface RegistryEntry extends CreatedWorkspace {
+  // Present only after the user explicitly enables cloud sync (Phase 9).
+  remote?: RemoteIdentity;
+}
+
+interface RegistryFile {
+  version: 1;
+  workspaces: RegistryEntry[];
+}
+
+export function createRegistryStore(registryFile: string) {
+  function read(): RegistryFile {
+    try {
+      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
+      return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
+    } catch {
+      return { version: 1, workspaces: [] };
+    }
+  }
+
+  function write(registry: RegistryFile): void {
+    mkdirSync(dirname(registryFile), { recursive: true });
+    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
+  }
+
+  return {
+    registryFile,
+
+    list(): RegistryEntry[] {
+      return read().workspaces;
+    },
+
+    find(workspaceId: string): RegistryEntry | null {
+      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
+    },
+
+    register(workspace: RegistryEntry): void {
+      const registry = read();
+      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
+        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
+      }
+      // Two roots with one workspaceId would make file operations silently
+      // target whichever registered first (e.g., attaching a copied folder).
+      if (
+        registry.workspaces.some(
+          (w) => w.workspaceId === workspace.workspaceId,
+        )
+      ) {
+        throw new Error(
+          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
+            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
+        );
+      }
+      registry.workspaces.push(workspace);
+      write(registry);
+    },
+
+    setRemote(workspaceId: string, remote: RemoteIdentity): void {
+      const registry = read();
+      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
+      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
+      entry.remote = remote;
+      write(registry);
+    },
+  };
+}
diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
index 6d8e481..d9b976f 100644
--- a/packages/workspace-core/src/paths.ts
+++ b/packages/workspace-core/src/paths.ts
@@ -59,6 +59,54 @@ export function validateUserWritePath(relativePath: string): WritePathValidation
   return { ok: true, normalized };
 }
 
+// Lexical normalization: resolves "." and ".." segments and separator noise
+// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
+// cannot slip past string comparisons. Preserves drive and UNC prefixes.
+export function normalizeAbsolutePath(path: string): string {
+  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
+  const rest = drive ? path.slice(drive.length) : path;
+  const unc = rest.startsWith("\\\\") || rest.startsWith("//");
+  const segments = rest.replaceAll("\\", "/").split("/");
+  const out: string[] = [];
+  for (const segment of segments) {
+    if (segment === "" || segment === ".") continue;
+    if (segment === "..") {
+      out.pop();
+      continue;
+    }
+    out.push(segment);
+  }
+  const prefix = unc ? "//" : "/";
+  const joined = `${drive}${prefix}${out.join("/")}`;
+  const trimmed = joined.replace(/\/+$/, "");
+  return trimmed || (drive ? drive : "/");
+}
+
+export type RootChoiceValidation =
+  | { ok: true; normalized: string }
+  | { ok: false; reason: string };
+
+// Registry policy: a workspace root must be a real folder choice — never the
+// filesystem root or the home directory itself, which would hand workspace
+// file operations the user's entire disk or home. Callers must use the
+// returned normalized path so registry equality checks are canonical.
+export function validateWorkspaceRootChoice(
+  rootPath: string,
+  homeDir: string,
+): RootChoiceValidation {
+  const attached = validateAttachedFolder(rootPath);
+  if (!attached.ok) return attached;
+  const normalized = normalizeAbsolutePath(rootPath);
+  const home = normalizeAbsolutePath(homeDir);
+  if (normalized === "/" || /^[A-Za-z]:$/.test(normalized) || normalized === "//") {
+    return { ok: false, reason: "workspace root cannot be the filesystem root" };
+  }
+  if (normalized === home) {
+    return { ok: false, reason: "workspace root cannot be the home directory itself" };
+  }
+  return { ok: true, normalized };
+}
+
 export type PathClassification =
   | { kind: "app-source"; appName: string }
   | { kind: "database" }

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/main.ts && printf '\\n--- createWorkspaceFolder ---\\n' && sed -n '1,240p' apps/desktop/src/workspaces/createWorkspaceFolder.ts && printf '\\n--- workspaceFiles ---\\n' && sed -n '1,260p' apps/desktop/src/workspaces/workspaceFiles.ts && printf '\\n--- renderer bridge types? ---\\n' && grep -R \"interface DohcDesktopBridge\\|dohcDesktop\" -n apps/desktop/src | head -50" in /home/ice/dev/dohc
 succeeded in 147ms:
import {
  defaultWorkspaceRoot,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
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
  VersionResult,
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

// IPC is an untrusted boundary: handlers only answer frames the navigation
// policy itself would allow (exact dev origin or the packaged bundle).
function isTrustedFrame(frameUrl: string): boolean {
  return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url ?? "";
  if (!isTrustedFrame(frameUrl)) {
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.getVersion, (event) => {
    assertTrustedSender(event);
    return VersionResult.parse(app.getVersion());
  });

  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
    assertTrustedSender(event);
    // Test seam: native dialogs cannot be driven by Playwright.
    const testPick = process.env.DOHC_TEST_PICK_PATH;
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
      return PickWorkspaceRootResult.parse(testPick);
    }
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    return PickWorkspaceRootResult.parse(picked);
  });

  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
    assertTrustedSender(event);
    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
  });

  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
    assertTrustedSender(event);
    return DefaultWorkspaceRootResult.parse(
      defaultWorkspaceRoot(effectiveHome()),
    );
  });

  // Validates AND canonicalizes: all downstream fs/registry operations use
  // the normalized root, so dot-segment or separator variants of the same
  // folder cannot bypass guards or register twice.
  function usableRoot(rootPath: string): string {
    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
    if (!check.ok) throw new Error(check.reason);
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

--- createWorkspaceFolder ---
import {
  createWorkspaceManifest,
  defaultWorkspaceMode,
  validateAttachedFolder,
  type WorkspaceKind,
  type WorkspaceManifest,
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

async function readExistingManifest(
  rootPath: string,
): Promise<WorkspaceManifest | null> {
  try {
    const raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as WorkspaceManifest;
    return parsed.version === 1 && typeof parsed.workspaceId === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
}): Promise<CreatedWorkspace> {
  const folderCheck = validateAttachedFolder(input.rootPath);
  if (!folderCheck.ok) {
    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
  }

  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  const existing = await readExistingManifest(input.rootPath);
  if (existing) {
    return {
      workspaceId: existing.workspaceId,
      rootPath: input.rootPath,
      kind: existing.kind === "cloud-only" ? input.kind : existing.kind,
      mode: existing.mode,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: randomUUID(),
    kind: input.kind,
  });

  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
  await mkdir(join(input.rootPath, ".context"), { recursive: true });
  await writeFile(
    join(input.rootPath, ".dohc", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
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

--- workspaceFiles ---
import {
  classifyPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);

export async function listFiles(
  rootPath: string,
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
      } else {
        const classified = classifyPath(rel);
        entries.push({
          path: rel,
          kind: classified.kind === "database" ? "database"
            : classified.kind === "app-source" ? "app-source"
            : "file",
        });
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
  await mkdir(dirname(absolute), { recursive: true });
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

--- renderer bridge types? ---
apps/desktop/src/preload.ts:6:contextBridge.exposeInMainWorld("dohcDesktop", {
apps/desktop/src/preload.ts:27:contextBridge.exposeInMainWorld("dohcDesktopInternal", {
apps/desktop/src/preload.ts:32:  contextBridge.exposeInMainWorld("dohcDesktopTest", {
apps/desktop/src/ipc/bridgeContract.ts:80:export interface DohcDesktopBridge {
apps/desktop/src/renderer/bridge.ts:5:    dohcDesktop?: DohcDesktopBridge;
apps/desktop/src/renderer/bridge.ts:6:    dohcDesktopInternal?: { firstPaint(): void };
apps/desktop/src/renderer/bridge.ts:11:  const api = window.dohcDesktop;
apps/desktop/src/renderer/main.tsx:14:  window.dohcDesktopInternal?.firstPaint();
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:30:  vi.stubGlobal("dohcDesktop", bridge);

exec
/bin/bash -lc "grep -R \"createWorkspaceFolder\" -n . --exclude-dir=node_modules --exclude-dir=.git && grep -R \"validateWorkspaceRootChoice\\|normalizeAbsolutePath\\|validateAttachedFolder\" -n . --exclude-dir=node_modules --exclude-dir=.git" in /home/ice/dev/dohc
 succeeded in 266ms:
./apps/desktop/src/main.ts:26:import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
./apps/desktop/src/main.ts:102:    const created = await createWorkspaceFolder({
./apps/desktop/src/main.ts:115:    const attached = await createWorkspaceFolder({
./apps/desktop/src/workspaces/registryStore.ts:3:import type { CreatedWorkspace } from "./createWorkspaceFolder";
./apps/desktop/src/workspaces/WorkspaceRegistry.ts:4:import type { CreatedWorkspace } from "./createWorkspaceFolder";
./apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:5:import { createWorkspaceFolder } from "./createWorkspaceFolder";
./apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:13:describe("createWorkspaceFolder", () => {
./apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:16:    const created = await createWorkspaceFolder({ rootPath: root, kind: "personal" });
./apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:45:    const adopted = await createWorkspaceFolder({ rootPath: root, kind: "personal" });
./apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:56:      createWorkspaceFolder({ rootPath: "relative/place", kind: "personal" }),
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:39:export async function createWorkspaceFolder(input: {
./apps/desktop/dist/main/main.js:315://#region src/workspaces/createWorkspaceFolder.ts
./apps/desktop/dist/main/main.js:330:async function createWorkspaceFolder(input) {
./apps/desktop/dist/main/main.js:519:		const created = await createWorkspaceFolder({
./apps/desktop/dist/main/main.js:528:		const attached = await createWorkspaceFolder({
./apps/desktop/tsconfig.tsbuildinfo:1:{"fileNames":["../../node_modules/typescript/lib/lib.es5.d.ts","../../node_modules/typescript/lib/lib.es2015.d.ts","../../node_modules/typescript/lib/lib.es2016.d.ts","../../node_modules/typescript/lib/lib.es2017.d.ts","../../node_modules/typescript/lib/lib.es2018.d.ts","../../node_modules/typescript/lib/lib.es2019.d.ts","../../node_modules/typescript/lib/lib.es2020.d.ts","../../node_modules/typescript/lib/lib.es2021.d.ts","../../node_modules/typescript/lib/lib.es2022.d.ts","../../node_modules/typescript/lib/lib.dom.d.ts","../../node_modules/typescript/lib/lib.dom.iterable.d.ts","../../node_modules/typescript/lib/lib.es2015.core.d.ts","../../node_modules/typescript/lib/lib.es2015.collection.d.ts","../../node_modules/typescript/lib/lib.es2015.generator.d.ts","../../node_modules/typescript/lib/lib.es2015.iterable.d.ts","../../node_modules/typescript/lib/lib.es2015.promise.d.ts","../../node_modules/typescript/lib/lib.es2015.proxy.d.ts","../../node_modules/typescript/lib/lib.es2015.reflect.d.ts","../../node_modules/typescript/lib/lib.es2015.symbol.d.ts","../../node_modules/typescript/lib/lib.es2015.symbol.wellknown.d.ts","../../node_modules/typescript/lib/lib.es2016.array.include.d.ts","../../node_modules/typescript/lib/lib.es2016.intl.d.ts","../../node_modules/typescript/lib/lib.es2017.arraybuffer.d.ts","../../node_modules/typescript/lib/lib.es2017.date.d.ts","../../node_modules/typescript/lib/lib.es2017.object.d.ts","../../node_modules/typescript/lib/lib.es2017.sharedmemory.d.ts","../../node_modules/typescript/lib/lib.es2017.string.d.ts","../../node_modules/typescript/lib/lib.es2017.intl.d.ts","../../node_modules/typescript/lib/lib.es2017.typedarrays.d.ts","../../node_modules/typescript/lib/lib.es2018.asyncgenerator.d.ts","../../node_modules/typescript/lib/lib.es2018.asynciterable.d.ts","../../node_modules/typescript/lib/lib.es2018.intl.d.ts","../../node_modules/typescript/lib/lib.es2018.promise.d.ts","../../node_modules/typescript/lib/lib.es2018.regexp.d.ts","../../node_modules/typescript/lib/lib.es2019.array.d.ts","../../node_modules/typescript/lib/lib.es2019.object.d.ts","../../node_modules/typescript/lib/lib.es2019.string.d.ts","../../node_modules/typescript/lib/lib.es2019.symbol.d.ts","../../node_modules/typescript/lib/lib.es2019.intl.d.ts","../../node_modules/typescript/lib/lib.es2020.bigint.d.ts","../../node_modules/typescript/lib/lib.es2020.date.d.ts","../../node_modules/typescript/lib/lib.es2020.promise.d.ts","../../node_modules/typescript/lib/lib.es2020.sharedmemory.d.ts","../../node_modules/typescript/lib/lib.es2020.string.d.ts","../../node_modules/typescript/lib/lib.es2020.symbol.wellknown.d.ts","../../node_modules/typescript/lib/lib.es2020.intl.d.ts","../../node_modules/typescript/lib/lib.es2020.number.d.ts","../../node_modules/typescript/lib/lib.es2021.promise.d.ts","../../node_modules/typescript/lib/lib.es2021.string.d.ts","../../node_modules/typescript/lib/lib.es2021.weakref.d.ts","../../node_modules/typescript/lib/lib.es2021.intl.d.ts","../../node_modules/typescript/lib/lib.es2022.array.d.ts","../../node_modules/typescript/lib/lib.es2022.error.d.ts","../../node_modules/typescript/lib/lib.es2022.intl.d.ts","../../node_modules/typescript/lib/lib.es2022.object.d.ts","../../node_modules/typescript/lib/lib.es2022.string.d.ts","../../node_modules/typescript/lib/lib.es2022.regexp.d.ts","../../node_modules/typescript/lib/lib.decorators.d.ts","../../node_modules/typescript/lib/lib.decorators.legacy.d.ts","../../node_modules/@types/react/global.d.ts","../../node_modules/csstype/index.d.ts","../../node_modules/@types/react/index.d.ts","../../node_modules/@types/react/jsx-runtime.d.ts","../../packages/workspace-core/src/workspaceMode.ts","../../packages/workspace-core/src/metadata.ts","../../packages/workspace-core/src/paths.ts","../../packages/workspace-core/src/changeSet.ts","../../packages/workspace-core/src/conflicts.ts","../../packages/workspace-core/src/index.ts","../../node_modules/@types/node/compatibility/disposable.d.ts","../../node_modules/@types/node/compatibility/indexable.d.ts","../../node_modules/@types/node/compatibility/iterators.d.ts","../../node_modules/@types/node/compatibility/index.d.ts","../../node_modules/@types/node/globals.typedarray.d.ts","../../node_modules/@types/node/buffer.buffer.d.ts","../../node_modules/@types/node/globals.d.ts","../../node_modules/@types/node/web-globals/abortcontroller.d.ts","../../node_modules/@types/node/web-globals/domexception.d.ts","../../node_modules/@types/node/web-globals/events.d.ts","../../node_modules/undici-types/header.d.ts","../../node_modules/undici-types/readable.d.ts","../../node_modules/undici-types/file.d.ts","../../node_modules/undici-types/fetch.d.ts","../../node_modules/undici-types/formdata.d.ts","../../node_modules/undici-types/connector.d.ts","../../node_modules/undici-types/client.d.ts","../../node_modules/undici-types/errors.d.ts","../../node_modules/undici-types/dispatcher.d.ts","../../node_modules/undici-types/global-dispatcher.d.ts","../../node_modules/undici-types/global-origin.d.ts","../../node_modules/undici-types/pool-stats.d.ts","../../node_modules/undici-types/pool.d.ts","../../node_modules/undici-types/handlers.d.ts","../../node_modules/undici-types/balanced-pool.d.ts","../../node_modules/undici-types/agent.d.ts","../../node_modules/undici-types/mock-interceptor.d.ts","../../node_modules/undici-types/mock-agent.d.ts","../../node_modules/undici-types/mock-client.d.ts","../../node_modules/undici-types/mock-pool.d.ts","../../node_modules/undici-types/mock-errors.d.ts","../../node_modules/undici-types/proxy-agent.d.ts","../../node_modules/undici-types/env-http-proxy-agent.d.ts","../../node_modules/undici-types/retry-handler.d.ts","../../node_modules/undici-types/retry-agent.d.ts","../../node_modules/undici-types/api.d.ts","../../node_modules/undici-types/interceptors.d.ts","../../node_modules/undici-types/util.d.ts","../../node_modules/undici-types/cookies.d.ts","../../node_modules/undici-types/patch.d.ts","../../node_modules/undici-types/websocket.d.ts","../../node_modules/undici-types/eventsource.d.ts","../../node_modules/undici-types/filereader.d.ts","../../node_modules/undici-types/diagnostics-channel.d.ts","../../node_modules/undici-types/content-type.d.ts","../../node_modules/undici-types/cache.d.ts","../../node_modules/undici-types/index.d.ts","../../node_modules/@types/node/web-globals/fetch.d.ts","../../node_modules/@types/node/web-globals/navigator.d.ts","../../node_modules/@types/node/web-globals/storage.d.ts","../../node_modules/@types/node/assert.d.ts","../../node_modules/@types/node/assert/strict.d.ts","../../node_modules/@types/node/async_hooks.d.ts","../../node_modules/@types/node/buffer.d.ts","../../node_modules/@types/node/child_process.d.ts","../../node_modules/@types/node/cluster.d.ts","../../node_modules/@types/node/console.d.ts","../../node_modules/@types/node/constants.d.ts","../../node_modules/@types/node/crypto.d.ts","../../node_modules/@types/node/dgram.d.ts","../../node_modules/@types/node/diagnostics_channel.d.ts","../../node_modules/@types/node/dns.d.ts","../../node_modules/@types/node/dns/promises.d.ts","../../node_modules/@types/node/domain.d.ts","../../node_modules/@types/node/events.d.ts","../../node_modules/@types/node/fs.d.ts","../../node_modules/@types/node/fs/promises.d.ts","../../node_modules/@types/node/http.d.ts","../../node_modules/@types/node/http2.d.ts","../../node_modules/@types/node/https.d.ts","../../node_modules/@types/node/inspector.d.ts","../../node_modules/@types/node/inspector.generated.d.ts","../../node_modules/@types/node/module.d.ts","../../node_modules/@types/node/net.d.ts","../../node_modules/@types/node/os.d.ts","../../node_modules/@types/node/path.d.ts","../../node_modules/@types/node/perf_hooks.d.ts","../../node_modules/@types/node/process.d.ts","../../node_modules/@types/node/punycode.d.ts","../../node_modules/@types/node/querystring.d.ts","../../node_modules/@types/node/readline.d.ts","../../node_modules/@types/node/readline/promises.d.ts","../../node_modules/@types/node/repl.d.ts","../../node_modules/@types/node/sea.d.ts","../../node_modules/@types/node/sqlite.d.ts","../../node_modules/@types/node/stream.d.ts","../../node_modules/@types/node/stream/promises.d.ts","../../node_modules/@types/node/stream/consumers.d.ts","../../node_modules/@types/node/stream/web.d.ts","../../node_modules/@types/node/string_decoder.d.ts","../../node_modules/@types/node/test.d.ts","../../node_modules/@types/node/timers.d.ts","../../node_modules/@types/node/timers/promises.d.ts","../../node_modules/@types/node/tls.d.ts","../../node_modules/@types/node/trace_events.d.ts","../../node_modules/@types/node/tty.d.ts","../../node_modules/@types/node/url.d.ts","../../node_modules/@types/node/util.d.ts","../../node_modules/@types/node/v8.d.ts","../../node_modules/@types/node/vm.d.ts","../../node_modules/@types/node/wasi.d.ts","../../node_modules/@types/node/worker_threads.d.ts","../../node_modules/@types/node/zlib.d.ts","../../node_modules/@types/node/index.d.ts","../../node_modules/electron/electron.d.ts","../../node_modules/zod/v3/helpers/typeAliases.d.cts","../../node_modules/zod/v3/helpers/util.d.cts","../../node_modules/zod/v3/index.d.cts","../../node_modules/zod/v3/ZodError.d.cts","../../node_modules/zod/v3/locales/en.d.cts","../../node_modules/zod/v3/errors.d.cts","../../node_modules/zod/v3/helpers/parseUtil.d.cts","../../node_modules/zod/v3/helpers/enumUtil.d.cts","../../node_modules/zod/v3/helpers/errorUtil.d.cts","../../node_modules/zod/v3/helpers/partialUtil.d.cts","../../node_modules/zod/v3/standard-schema.d.cts","../../node_modules/zod/v3/types.d.cts","../../node_modules/zod/v3/external.d.cts","../../node_modules/zod/index.d.cts","./src/ipc/bridgeContract.ts","./src/ipc/channels.ts","./src/performance/launchMarks.ts","./src/security/electronSecurity.ts","./src/window/createMainWindow.ts","./src/workspaces/createWorkspaceFolder.ts","./src/workspaces/registryStore.ts","./src/workspaces/WorkspaceRegistry.ts","./src/workspaces/workspaceFiles.ts","./src/main.ts","./src/preload.ts","./src/renderer/bridge.ts","./src/renderer/theme.ts","../../node_modules/vitest/node_modules/@vitest/pretty-format/dist/index.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/types.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/helpers.d.ts","../../node_modules/vitest/node_modules/tinyrainbow/dist/index-c1cfc5e9.d.ts","../../node_modules/vitest/node_modules/tinyrainbow/dist/node.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/index.d.ts","../../node_modules/vitest/node_modules/@vitest/runner/dist/tasks-3ZnPj1LR.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/types-Bxe-2Udy.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/diff.d.ts","../../node_modules/vitest/node_modules/@vitest/runner/dist/types.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/error.d.ts","../../node_modules/vitest/node_modules/@vitest/runner/dist/index.d.ts","../../node_modules/vitest/dist/chunks/environment.LoooBwUu.d.ts","../../node_modules/rollup/node_modules/@types/estree/index.d.ts","../../node_modules/rollup/dist/rollup.d.ts","../../node_modules/rollup/dist/parseAst.d.ts","../../node_modules/vitest/node_modules/vite/types/hmrPayload.d.ts","../../node_modules/vitest/node_modules/vite/types/customEvent.d.ts","../../node_modules/vitest/node_modules/vite/types/hot.d.ts","../../node_modules/vitest/node_modules/vite/dist/node/types.d-aGj9QkWt.d.ts","../../node_modules/vitest/node_modules/esbuild/lib/main.d.ts","../../node_modules/source-map-js/source-map.d.ts","../../node_modules/postcss/lib/previous-map.d.ts","../../node_modules/postcss/lib/input.d.ts","../../node_modules/postcss/lib/css-syntax-error.d.ts","../../node_modules/postcss/lib/declaration.d.ts","../../node_modules/postcss/lib/root.d.ts","../../node_modules/postcss/lib/warning.d.ts","../../node_modules/postcss/lib/lazy-result.d.ts","../../node_modules/postcss/lib/no-work-result.d.ts","../../node_modules/postcss/lib/processor.d.ts","../../node_modules/postcss/lib/result.d.ts","../../node_modules/postcss/lib/document.d.ts","../../node_modules/postcss/lib/rule.d.ts","../../node_modules/postcss/lib/node.d.ts","../../node_modules/postcss/lib/comment.d.ts","../../node_modules/postcss/lib/container.d.ts","../../node_modules/postcss/lib/at-rule.d.ts","../../node_modules/postcss/lib/list.d.ts","../../node_modules/postcss/lib/postcss.d.ts","../../node_modules/postcss/lib/postcss.d.mts","../../node_modules/vitest/node_modules/vite/dist/node/runtime.d.ts","../../node_modules/vitest/node_modules/vite/types/importGlob.d.ts","../../node_modules/vitest/node_modules/vite/types/metadata.d.ts","../../node_modules/vitest/node_modules/vite/dist/node/index.d.ts","../../node_modules/vitest/node_modules/@vitest/snapshot/dist/environment-Ddx0EDtY.d.ts","../../node_modules/vitest/node_modules/@vitest/snapshot/dist/rawSnapshot-CPNkto81.d.ts","../../node_modules/vitest/node_modules/@vitest/snapshot/dist/index.d.ts","../../node_modules/vitest/node_modules/@vitest/snapshot/dist/environment.d.ts","../../node_modules/vitest/dist/chunks/config.Cy0C388Z.d.ts","../../node_modules/vitest/node_modules/vite-node/dist/trace-mapping.d-DLVdEqOp.d.ts","../../node_modules/vitest/node_modules/vite-node/dist/index-z0R8hVRu.d.ts","../../node_modules/vitest/node_modules/vite-node/dist/index.d.ts","../../node_modules/@types/deep-eql/index.d.ts","../../node_modules/assertion-error/index.d.ts","../../node_modules/@types/chai/index.d.ts","../../node_modules/vitest/node_modules/@vitest/utils/dist/source-map.d.ts","../../node_modules/vitest/node_modules/vite-node/dist/client.d.ts","../../node_modules/vitest/node_modules/vite-node/dist/server.d.ts","../../node_modules/vitest/node_modules/@vitest/runner/dist/utils.d.ts","../../node_modules/tinybench/dist/index.d.ts","../../node_modules/vitest/dist/chunks/benchmark.geERunq4.d.ts","../../node_modules/vitest/node_modules/@vitest/snapshot/dist/manager.d.ts","../../node_modules/vitest/dist/chunks/reporters.nr4dxCkA.d.ts","../../node_modules/vitest/dist/chunks/worker.tN5KGIih.d.ts","../../node_modules/vitest/dist/chunks/worker.B9FxPCaC.d.ts","../../node_modules/vitest/dist/chunks/vite.CzKp4x9w.d.ts","../../node_modules/vitest/node_modules/@vitest/expect/dist/chai.d.cts","../../node_modules/vitest/node_modules/@vitest/expect/dist/index.d.ts","../../node_modules/vitest/node_modules/@vitest/expect/index.d.ts","../../node_modules/vitest/node_modules/@vitest/spy/dist/index.d.ts","../../node_modules/vitest/node_modules/@vitest/mocker/dist/types-DZOqTgiN.d.ts","../../node_modules/vitest/node_modules/@vitest/mocker/dist/index.d.ts","../../node_modules/vitest/dist/chunks/mocker.cRtM890J.d.ts","../../node_modules/vitest/dist/chunks/suite.B2jumIFP.d.ts","../../node_modules/expect-type/dist/utils.d.ts","../../node_modules/expect-type/dist/overloads.d.ts","../../node_modules/expect-type/dist/branding.d.ts","../../node_modules/expect-type/dist/messages.d.ts","../../node_modules/expect-type/dist/index.d.ts","../../node_modules/vitest/dist/index.d.ts","./src/security/electronSecurity.test.ts","./src/workspaces/createWorkspaceFolder.test.ts","./src/workspaces/registryStore.test.ts","./src/workspaces/workspaceFiles.test.ts","./src/renderer/CommandPalette.tsx","../../node_modules/@types/react-dom/client.d.ts","../../node_modules/@types/aria-query/index.d.ts","../../node_modules/@testing-library/dom/types/matches.d.ts","../../node_modules/@testing-library/dom/types/wait-for.d.ts","../../node_modules/@testing-library/dom/types/query-helpers.d.ts","../../node_modules/@testing-library/dom/types/queries.d.ts","../../node_modules/@testing-library/dom/types/get-queries-for-element.d.ts","../../node_modules/pretty-format/build/types.d.ts","../../node_modules/pretty-format/build/index.d.ts","../../node_modules/@testing-library/dom/types/screen.d.ts","../../node_modules/@testing-library/dom/types/wait-for-element-to-be-removed.d.ts","../../node_modules/@testing-library/dom/types/get-node-text.d.ts","../../node_modules/@testing-library/dom/types/events.d.ts","../../node_modules/@testing-library/dom/types/pretty-dom.d.ts","../../node_modules/@testing-library/dom/types/role-helpers.d.ts","../../node_modules/@testing-library/dom/types/config.d.ts","../../node_modules/@testing-library/dom/types/suggestions.d.ts","../../node_modules/@testing-library/dom/types/index.d.ts","../../node_modules/@types/react-dom/test-utils/index.d.ts","../../node_modules/@testing-library/react/types/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/eventMap.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/types.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/dispatchEvent.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/focus.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/input.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/click/isClickableInput.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/dataTransfer/Blob.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/dataTransfer/DataTransfer.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/dataTransfer/FileList.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/dataTransfer/Clipboard.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/edit/timeValue.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/edit/isContentEditable.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/edit/isEditable.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/edit/maxLength.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/edit/setFiles.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/focus/cursor.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/focus/getActiveElement.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/focus/getTabDestination.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/focus/isFocusable.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/focus/selection.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/focus/selector.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/keyDef/readNextDescriptor.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/cloneEvent.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/findClosest.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/getDocumentFromNode.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/getTreeDiff.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/getWindow.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/isDescendantOrSelf.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/isElementType.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/isVisible.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/isDisabled.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/level.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/misc/wait.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/pointer/cssPointerEvents.d.ts","../../node_modules/@testing-library/user-event/dist/types/utils/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/document/UI.d.ts","../../node_modules/@testing-library/user-event/dist/types/document/getValueOrTextContent.d.ts","../../node_modules/@testing-library/user-event/dist/types/document/copySelection.d.ts","../../node_modules/@testing-library/user-event/dist/types/document/trackValue.d.ts","../../node_modules/@testing-library/user-event/dist/types/document/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/getInputRange.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/modifySelection.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/moveSelection.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/setSelectionPerMouse.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/modifySelectionPerMouse.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/selectAll.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/setSelectionRange.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/setSelection.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/updateSelectionOnFocus.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/selection/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/event/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/system/pointer/buttons.d.ts","../../node_modules/@testing-library/user-event/dist/types/system/pointer/shared.d.ts","../../node_modules/@testing-library/user-event/dist/types/system/pointer/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/system/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/system/keyboard.d.ts","../../node_modules/@testing-library/user-event/dist/types/options.d.ts","../../node_modules/@testing-library/user-event/dist/types/convenience/click.d.ts","../../node_modules/@testing-library/user-event/dist/types/convenience/hover.d.ts","../../node_modules/@testing-library/user-event/dist/types/convenience/tab.d.ts","../../node_modules/@testing-library/user-event/dist/types/convenience/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/keyboard/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/clipboard/copy.d.ts","../../node_modules/@testing-library/user-event/dist/types/clipboard/cut.d.ts","../../node_modules/@testing-library/user-event/dist/types/clipboard/paste.d.ts","../../node_modules/@testing-library/user-event/dist/types/clipboard/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/pointer/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/utility/clear.d.ts","../../node_modules/@testing-library/user-event/dist/types/utility/selectOptions.d.ts","../../node_modules/@testing-library/user-event/dist/types/utility/type.d.ts","../../node_modules/@testing-library/user-event/dist/types/utility/upload.d.ts","../../node_modules/@testing-library/user-event/dist/types/utility/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/setup/api.d.ts","../../node_modules/@testing-library/user-event/dist/types/setup/directApi.d.ts","../../node_modules/@testing-library/user-event/dist/types/setup/setup.d.ts","../../node_modules/@testing-library/user-event/dist/types/setup/index.d.ts","../../node_modules/@testing-library/user-event/dist/types/index.d.ts","../../node_modules/lucide-react/dist/lucide-react.d.ts","./src/renderer/NewFileDialog.tsx","./src/renderer/DesktopWorkspaceShell.tsx","./src/renderer/DesktopFirstRun.tsx","./src/renderer/DesktopFirstRun.test.tsx","./src/renderer/DesktopRoot.tsx","./src/renderer/main.tsx","../../node_modules/playwright-core/types/protocol.d.ts","../../node_modules/playwright-core/types/structs.d.ts","../../node_modules/playwright-core/types/types.d.ts","../../node_modules/playwright-core/index.d.ts","../../node_modules/playwright/types/test.d.ts","../../node_modules/playwright/test.d.ts","../../node_modules/@playwright/test/index.d.ts","../../node_modules/playwright/index.d.ts","./e2e/desktopLaunch.spec.ts","./e2e/firstRunWorkspace.spec.ts","../../node_modules/vite/types/hmrPayload.d.ts","../../node_modules/vite/dist/node/chunks/moduleRunnerTransport.d.ts","../../node_modules/vite/types/customEvent.d.ts","../../node_modules/rolldown/dist/shared/logging-BSNejiLS.d.mts","../../node_modules/@oxc-project/types/types.d.ts","../../node_modules/rolldown/dist/shared/binding-DktDDYoY.d.mts","../../node_modules/@rolldown/pluginutils/dist/filter/index.d.mts","../../node_modules/@rolldown/pluginutils/dist/index.d.mts","../../node_modules/rolldown/dist/shared/define-config-Bo24xyUK.d.mts","../../node_modules/rolldown/dist/index.d.mts","../../node_modules/rolldown/dist/parse-ast-index.d.mts","../../node_modules/vite/types/internal/rollupTypeCompat.d.ts","../../node_modules/rolldown/dist/shared/constructors-Dc4Y1bfN.d.mts","../../node_modules/rolldown/dist/plugins-index.d.mts","../../node_modules/rolldown/dist/shared/transform-BpeSEA-X.d.mts","../../node_modules/rolldown/dist/utils-index.d.mts","../../node_modules/vite/types/hot.d.ts","../../node_modules/vite/dist/node/module-runner.d.ts","../../node_modules/esbuild/lib/main.d.ts","../../node_modules/vite/types/internal/esbuildOptions.d.ts","../../node_modules/vite/types/metadata.d.ts","../../node_modules/vite/types/internal/terserOptions.d.ts","../../node_modules/lightningcss/node/ast.d.ts","../../node_modules/lightningcss/node/targets.d.ts","../../node_modules/lightningcss/node/index.d.ts","../../node_modules/vite/types/internal/lightningcssOptions.d.ts","../../node_modules/vite/types/internal/cssPreprocessorOptions.d.ts","../../node_modules/rolldown/dist/filter-index.d.mts","../../node_modules/vite/types/importGlob.d.ts","../../node_modules/vite/dist/node/index.d.ts","../../node_modules/@tailwindcss/vite/dist/index.d.mts","../../node_modules/@vitejs/plugin-react/types/optionalTypes.d.ts","../../node_modules/@vitejs/plugin-react/dist/index.d.ts","../../node_modules/electron-vite/dist/index.d.ts","./electron.vite.config.ts","./playwright.config.ts","../../node_modules/keyv/src/index.d.ts","../../node_modules/@types/http-cache-semantics/index.d.ts","../../node_modules/@types/responselike/index.d.ts","../../node_modules/@types/cacheable-request/index.d.ts","../../node_modules/@types/ms/index.d.ts","../../node_modules/@types/debug/index.d.ts","../../node_modules/@types/estree/index.d.ts","../../node_modules/@types/estree-jsx/index.d.ts","../../node_modules/@types/fs-extra/index.d.ts","../../node_modules/@types/unist/index.d.ts","../../node_modules/@types/hast/index.d.ts","../../node_modules/@types/js-yaml/index.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/common/html.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/common/token.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/common/error-codes.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/tokenizer/preprocessor.d.ts","../../node_modules/entities/dist/decode-codepoint.d.ts","../../node_modules/entities/dist/generated/decode-data-html.d.ts","../../node_modules/entities/dist/generated/decode-data-xml.d.ts","../../node_modules/entities/dist/decode.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/tokenizer/index.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/tree-adapters/interface.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/parser/open-element-stack.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/parser/formatting-element-list.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/parser/index.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/tree-adapters/default.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/serializer/index.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/common/foreign-content.d.ts","../../node_modules/@types/jsdom/node_modules/parse5/dist/index.d.ts","../../node_modules/tough-cookie/dist/index.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/utility.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/header.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/readable.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/fetch.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/formdata.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/connector.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/client-stats.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/client.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/errors.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/dispatcher.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/global-dispatcher.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/global-origin.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/pool-stats.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/pool.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/handlers.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/balanced-pool.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/round-robin-pool.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/h2c-client.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/mock-interceptor.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/mock-call-history.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/mock-agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/mock-client.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/mock-pool.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/snapshot-agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/mock-errors.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/proxy-agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/socks5-proxy-agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/env-http-proxy-agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/retry-handler.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/retry-agent.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/api.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/cache-interceptor.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/interceptors.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/util.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/cookies.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/patch.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/websocket.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/eventsource.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/diagnostics-channel.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/content-type.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/cache.d.ts","../../node_modules/@types/jsdom/node_modules/undici-types/index.d.ts","../../node_modules/@types/jsdom/index.d.ts","../../node_modules/@types/keyv/index.d.ts","../../node_modules/@types/mdast/index.d.ts","../../node_modules/pg-types/index.d.ts","../../node_modules/pg-protocol/dist/messages.d.ts","../../node_modules/pg-protocol/dist/serializer.d.ts","../../node_modules/pg-protocol/dist/parser.d.ts","../../node_modules/pg-protocol/dist/index.d.ts","../../node_modules/@types/pg/lib/type-overrides.d.ts","../../node_modules/@types/pg/index.d.ts","../../node_modules/@types/prismjs/index.d.ts","../../node_modules/@types/react-dom/index.d.ts","../../node_modules/@types/tough-cookie/index.d.ts","../../node_modules/@types/trusted-types/lib/index.d.ts","../../node_modules/@types/trusted-types/index.d.ts","../../node_modules/@types/use-sync-external-store/index.d.ts"],"fileIdsList":[[63,75,123,136,140,141,398,399],[63,75,123,135,136,140,141,144,145,398,399],[63,75,123,140,141,432,434,435],[63,75,123,140,141,398],[63,75,123,140,141,188],[63,75,123,140,141],[63,69,75,123,140,141,174,189,190,191,192,193,194,196,197],[63,75,123,140,141,174,190],[62,63,75,123,140,141],[63,75,123,140,141,282,307,384,388],[62,63,75,123,140,141,200,385,387],[62,63,75,123,140,141,200,387,388],[62,63,75,123,140,141,189,200,201,287,385,386],[62,63,75,123,140,141,200],[63,75,123,140,141,189],[63,75,123,140,141,201,288,390],[63,75,123,140,141,192,282],[63,75,123,140,141,145],[63,75,123,140,141,145,166,174,192],[63,75,123,140,141,144,145,174,194,195],[63,75,123,136,140,141,144,145,194,282],[63,69,75,123,128,136,140,141,145],[63,75,123,136,140,141,144,145,195,282],[63,75,123,135,140,141,145,194],[63,75,123,136,140,141,144,145,197,282],[63,69,75,123,135,136,140,141,145,189],[75,123,140,141],[75,123,140,141,397],[75,123,140,141,408],[75,123,140,141,431],[75,123,140,141,293],[75,123,140,141,290,291,292,293,294,297,298,299,300,301,302,303,304],[75,123,140,141,289],[75,123,140,141,296],[75,123,140,141,290,291,292],[75,123,140,141,290,291],[75,123,140,141,293,294,296],[75,123,140,141,291],[62,75,123,140,141,288,305,306],[75,123,140,141,383],[75,123,140,141,370,371,372],[75,123,140,141,365,366,367],[75,123,140,141,343,344,345,346],[75,123,140,141,309,383],[75,123,140,141,309],[75,123,140,141,309,310,311,312,357],[75,123,140,141,347],[75,123,140,141,342,348,349,350,351,352,353,354,355,356],[75,123,140,141,357],[75,123,140,141,308],[75,123,140,141,361,363,364,382,383],[75,123,140,141,361,363],[75,123,140,141,358,361,383],[75,123,140,141,368,369,373,374,379],[75,123,140,141,362,364,374,382],[75,123,140,141,381,382],[75,123,140,141,358,362,364,380,381],[75,123,140,141,362,383],[75,123,140,141,360],[75,123,140,141,360,362,383],[75,123,140,141,358,359],[75,123,140,141,375,376,377,378],[75,123,140,141,364,383],[75,123,140,141,319],[75,123,140,141,313,320],[75,123,140,141,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341],[75,123,140,141,339,383],[75,123,134,137,140,141,166,173,438,439,440],[75,123,140,141,255,256],[75,123,140,141,442],[75,123,140,141,444,445],[75,123,135,140,141,173],[75,123,140,141,447],[75,123,134,140,141,169,173,466,467,510],[75,123,140,141,451],[75,123,140,141,450,451],[75,123,140,141,450],[75,123,140,141,450,451,452,458,459,462,463,464,465],[75,123,140,141,451,459],[75,123,140,141,450,451,452,458,459,460,461],[75,123,140,141,450,459],[75,123,140,141,459,463],[75,123,140,141,451,452,453,457],[75,123,140,141,452],[75,123,140,141,450,451,459],[75,123,140,141,166,474,477,480,481],[75,123,140,141,155,166,477],[75,123,140,141,166,477,481],[75,123,140,141,155],[75,123,140,141,471],[75,123,140,141,475],[75,123,140,141,166,473,474,477],[75,123,140,141,143,163],[75,123,140,141,173],[75,123,140,141,173,471],[75,123,140,141,143,166,473,477],[75,123,134,140,141,155,166,468,469,470,472,476],[75,123,140,141,477,486,494],[75,123,140,141,469,475],[75,123,140,141,477,504,505],[75,123,140,141,158,166,173,469,472,477],[75,123,140,141,173,471,472],[75,123,140,141,477],[75,123,140,141,166,473,477],[75,123,140,141,468],[75,123,140,141,471,472,473,475,476,477,478,479,481,482,483,484,485,486,487,488,489,490,491,492,493,494,495,496,497,498,499,500,501,502,503,505,506,507,508,509],[75,123,131,140,141,477,497,500],[75,123,140,141,477,486,487,488],[75,123,140,141,475,477,487,489],[75,123,140,141,476],[75,123,140,141,469,471,477],[75,123,140,141,477,481,487,489],[75,123,140,141,481],[75,123,140,141,166,475,477,480],[75,123,140,141,469,473,477,486],[75,123,140,141,155,472],[75,123,140,141,477,497],[75,123,140,141,489],[75,123,140,141,469,473,477,481],[75,123,140,141,158,171,173,471,472,477,504],[75,123,134,140,141,173],[75,120,121,123,140,141],[75,122,123,140,141],[123,140,141],[75,123,128,140,141,158],[75,123,124,129,134,140,141,143,155,166,472],[75,123,124,125,134,140,141,143],[70,71,72,75,123,140,141],[75,123,126,140,141,167],[75,123,127,128,135,140,141,144],[75,123,128,140,141,155,163,472],[75,123,129,131,134,140,141,143,472],[75,122,123,130,140,141],[75,123,131,132,140,141],[75,123,133,134,140,141],[75,122,123,134,140,141],[75,123,134,135,136,140,141,155,166,472],[75,123,134,135,136,140,141,150,155,158,472],[75,116,123,131,134,137,140,141,143,155,166,472],[75,123,134,135,137,138,140,141,143,155,163,166,472],[75,123,137,139,140,141,155,163,166,472],[73,74,75,76,77,78,79,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172],[75,123,134,140,141],[75,123,140,141,142,166],[75,123,131,134,140,141,143,155,472],[75,123,140,141,144],[75,123,140,141,145],[75,122,123,140,141,146],[75,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,472],[75,123,140,141,148],[75,123,140,141,149],[75,123,134,140,141,150,151],[75,123,140,141,150,152,167,169],[75,123,135,140,141],[75,123,134,140,141,155,156,158,472],[75,123,140,141,157,158,472],[75,123,140,141,155,156],[75,123,140,141,158],[75,123,140,141,159],[75,120,123,140,141,155,160,166],[75,123,134,140,141,161,162],[75,123,140,141,161,162],[75,123,128,140,141,143,155,163,472],[75,123,140,141,164],[75,123,140,141,143,165],[75,123,137,140,141,149,166,472],[75,123,128,140,141,167],[75,123,140,141,155,168,472],[75,123,140,141,142,169,472],[75,123,140,141,170],[75,116,123,140,141],[75,116,123,134,136,140,141,146,155,158,166,168,169,171],[75,123,140,141,155,172,472],[75,123,134,140,141,155,163,173,514,515,518,519,520],[75,123,140,141,520],[62,75,123,140,141],[60,61,75,123,140,141],[75,123,137,140,141,155,173],[75,123,140,141,524],[75,123,140,141,431,433],[75,123,134,135,140,141,173],[75,123,140,141,454,455,456],[75,123,140,141,277,278],[75,123,140,141,277,278,279,280],[75,123,140,141,277,279],[75,123,140,141,277],[75,123,140,141,424,425],[75,123,140,141,173,515,516,517],[75,123,140,141,155,173,515],[75,123,140,141,394],[75,123,124,135,140,141,155,174,177,188,392,393],[75,123,140,141,395],[75,123,140,141,396],[75,123,140,141,238],[75,123,140,141,236,238],[75,123,140,141,227,235,236,237,239,241],[75,123,140,141,225],[75,123,140,141,228,233,238,241],[75,123,140,141,224,241],[75,123,140,141,228,229,232,233,234,241],[75,123,140,141,228,229,230,232,233,241],[75,123,140,141,225,226,227,228,229,233,234,235,237,238,239,241],[75,123,140,141,241],[75,123,140,141,223,225,226,227,228,229,230,232,233,234,235,236,237,238,239,240],[75,123,140,141,223,241],[75,123,140,141,228,230,231,233,234,241],[75,123,140,141,232,241],[75,123,140,141,233,234,238,241],[75,123,140,141,226,236],[75,123,140,141,295],[75,123,140,141,410],[75,123,140,141,405,407,410],[75,123,140,141,406,407],[75,123,140,141,407,410,414],[75,123,140,141,406],[75,123,140,141,407,410],[75,123,140,141,405,406,407,409],[75,123,140,141,405,407],[75,123,140,141,406,407,416],[75,123,140,141,216,245],[75,123,140,141,215,216],[75,88,92,123,140,141,166],[75,88,123,140,141,155,166],[75,83,123,140,141],[75,85,88,123,140,141,163,166],[75,83,123,140,141,173],[75,85,88,123,140,141,143,166],[75,80,81,84,87,123,134,140,141,155,166],[75,88,95,123,140,141],[75,80,86,123,140,141],[75,88,109,110,123,140,141],[75,84,88,123,140,141,158,166,173],[75,109,123,140,141,173],[75,82,83,123,140,141,173],[75,88,123,140,141],[75,82,83,84,85,86,87,88,89,90,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,110,111,112,113,114,115,123,140,141],[75,88,103,123,140,141],[75,88,95,96,123,140,141],[75,86,88,96,97,123,140,141],[75,87,123,140,141],[75,80,83,88,123,140,141],[75,88,92,96,97,123,140,141],[75,92,123,140,141],[75,86,88,91,123,140,141,166],[75,80,85,88,95,123,140,141],[75,83,88,109,123,140,141,171,173],[75,123,140,141,402],[75,123,134,135,137,138,139,140,141,143,155,163,166,172,173,242,402,403,404,411,412,413,415,417,419,421,422,423,427,428,429,430,431],[75,123,140,141,402,403,404,418],[75,123,140,141,404],[75,123,140,141,420],[75,123,140,141,426],[75,123,140,141,411,422,431],[75,123,140,141,411,431],[75,123,140,141,213,261,262,282],[75,123,140,141,202,213,249,250,282],[75,123,140,141,274],[75,123,135,140,141,155,202,207,213,214,246,249,251,254,258,259,260,263,264,268,269,282],[75,123,140,141,213,261,262,263,282],[75,123,140,141,246,265],[75,123,140,141,171,266],[75,123,140,141,213,214,249,251,254,282],[75,123,135,140,141,155,171,202,207,210,213,214,246,249,250,251,254,258,259,260,261,262,263,264,265,266,267,268,269,271,272,274,275,276,281,282],[75,123,140,141,206,207,210],[75,123,140,141,270],[75,123,140,141,273],[75,123,140,141,207,208,210,211,212],[75,123,140,141,207],[75,123,140,141,207,208,210],[75,123,140,141,207,208],[75,123,140,141,247],[75,123,140,141,202,247,248],[75,123,140,141,202,247],[75,123,140,141,202,209],[75,123,140,141,203],[75,123,140,141,202,203,204,206],[75,123,140,141,202],[75,123,140,141,205],[75,123,140,141,252,253],[75,123,140,141,252],[75,123,140,141,246,252,253,268],[75,123,134,135,137,138,139,140,141,143,155,163,166,172,173,216,217,218,219,220,221,222,242,243,244,245],[75,123,140,141,218,219,220,221],[75,123,140,141,218,219,220],[75,123,140,141,218],[75,123,140,141,219],[75,123,140,141,216],[75,123,140,141,187],[75,123,140,141,175,176,177],[75,123,140,141,178,179],[75,123,140,141,175,176,178,180,181,186],[75,123,140,141,176,178],[75,123,140,141,186],[75,123,140,141,178],[75,123,140,141,175,176,178,181,182,183,184,185],[63,64,65,66,67,68,75,123,140,141],[63,64,75,123,140,141]],"fileInfos":[{"version":"c430d44666289dae81f30fa7b2edebf186ecc91a2d4c71266ea6ae76388792e1","affectsGlobalScope":true,"impliedFormat":1},{"version":"45b7ab580deca34ae9729e97c13cfd999df04416a79116c3bfb483804f85ded4","impliedFormat":1},{"version":"3facaf05f0c5fc569c5649dd359892c98a85557e3e0c847964caeb67076f4d75","impliedFormat":1},{"version":"e44bb8bbac7f10ecc786703fe0a6a4b952189f908707980ba8f3c8975a760962","impliedFormat":1},{"version":"5e1c4c362065a6b95ff952c0eab010f04dcd2c3494e813b493ecfd4fcb9fc0d8","impliedFormat":1},{"version":"68d73b4a11549f9c0b7d352d10e91e5dca8faa3322bfb77b661839c42b1ddec7","impliedFormat":1},{"version":"5efce4fc3c29ea84e8928f97adec086e3dc876365e0982cc8479a07954a3efd4","impliedFormat":1},{"version":"feecb1be483ed332fad555aff858affd90a48ab19ba7272ee084704eb7167569","impliedFormat":1},{"version":"ee7bad0c15b58988daa84371e0b89d313b762ab83cb5b31b8a2d1162e8eb41c2","impliedFormat":1},{"version":"080941d9f9ff9307f7e27a83bcd888b7c8270716c39af943532438932ec1d0b9","affectsGlobalScope":true,"impliedFormat":1},{"version":"2e80ee7a49e8ac312cc11b77f1475804bee36b3b2bc896bead8b6e1266befb43","affectsGlobalScope":true,"impliedFormat":1},{"version":"c57796738e7f83dbc4b8e65132f11a377649c00dd3eee333f672b8f0a6bea671","affectsGlobalScope":true,"impliedFormat":1},{"version":"dc2df20b1bcdc8c2d34af4926e2c3ab15ffe1160a63e58b7e09833f616efff44","affectsGlobalScope":true,"impliedFormat":1},{"version":"515d0b7b9bea2e31ea4ec968e9edd2c39d3eebf4a2d5cbd04e88639819ae3b71","affectsGlobalScope":true,"impliedFormat":1},{"version":"0559b1f683ac7505ae451f9a96ce4c3c92bdc71411651ca6ddb0e88baaaad6a3","affectsGlobalScope":true,"impliedFormat":1},{"version":"0dc1e7ceda9b8b9b455c3a2d67b0412feab00bd2f66656cd8850e8831b08b537","affectsGlobalScope":true,"impliedFormat":1},{"version":"ce691fb9e5c64efb9547083e4a34091bcbe5bdb41027e310ebba8f7d96a98671","affectsGlobalScope":true,"impliedFormat":1},{"version":"8d697a2a929a5fcb38b7a65594020fcef05ec1630804a33748829c5ff53640d0","affectsGlobalScope":true,"impliedFormat":1},{"version":"4ff2a353abf8a80ee399af572debb8faab2d33ad38c4b4474cff7f26e7653b8d","affectsGlobalScope":true,"impliedFormat":1},{"version":"fb0f136d372979348d59b3f5020b4cdb81b5504192b1cacff5d1fbba29378aa1","affectsGlobalScope":true,"impliedFormat":1},{"version":"d15bea3d62cbbdb9797079416b8ac375ae99162a7fba5de2c6c505446486ac0a","affectsGlobalScope":true,"impliedFormat":1},{"version":"68d18b664c9d32a7336a70235958b8997ebc1c3b8505f4f1ae2b7e7753b87618","affectsGlobalScope":true,"impliedFormat":1},{"version":"eb3d66c8327153d8fa7dd03f9c58d351107fe824c79e9b56b462935176cdf12a","affectsGlobalScope":true,"impliedFormat":1},{"version":"38f0219c9e23c915ef9790ab1d680440d95419ad264816fa15009a8851e79119","affectsGlobalScope":true,"impliedFormat":1},{"version":"69ab18c3b76cd9b1be3d188eaf8bba06112ebbe2f47f6c322b5105a6fbc45a2e","affectsGlobalScope":true,"impliedFormat":1},{"version":"a680117f487a4d2f30ea46f1b4b7f58bef1480456e18ba53ee85c2746eeca012","affectsGlobalScope":true,"impliedFormat":1},{"version":"2f11ff796926e0832f9ae148008138ad583bd181899ab7dd768a2666700b1893","affectsGlobalScope":true,"impliedFormat":1},{"version":"4de680d5bb41c17f7f68e0419412ca23c98d5749dcaaea1896172f06435891fc","affectsGlobalScope":true,"impliedFormat":1},{"version":"954296b30da6d508a104a3a0b5d96b76495c709785c1d11610908e63481ee667","affectsGlobalScope":true,"impliedFormat":1},{"version":"ac9538681b19688c8eae65811b329d3744af679e0bdfa5d842d0e32524c73e1c","affectsGlobalScope":true,"impliedFormat":1},{"version":"0a969edff4bd52585473d24995c5ef223f6652d6ef46193309b3921d65dd4376","affectsGlobalScope":true,"impliedFormat":1},{"version":"9e9fbd7030c440b33d021da145d3232984c8bb7916f277e8ffd3dc2e3eae2bdb","affectsGlobalScope":true,"impliedFormat":1},{"version":"811ec78f7fefcabbda4bfa93b3eb67d9ae166ef95f9bff989d964061cbf81a0c","affectsGlobalScope":true,"impliedFormat":1},{"version":"717937616a17072082152a2ef351cb51f98802fb4b2fdabd32399843875974ca","affectsGlobalScope":true,"impliedFormat":1},{"version":"d7e7d9b7b50e5f22c915b525acc5a49a7a6584cf8f62d0569e557c5cfc4b2ac2","affectsGlobalScope":true,"impliedFormat":1},{"version":"71c37f4c9543f31dfced6c7840e068c5a5aacb7b89111a4364b1d5276b852557","affectsGlobalScope":true,"impliedFormat":1},{"version":"576711e016cf4f1804676043e6a0a5414252560eb57de9faceee34d79798c850","affectsGlobalScope":true,"impliedFormat":1},{"version":"89c1b1281ba7b8a96efc676b11b264de7a8374c5ea1e6617f11880a13fc56dc6","affectsGlobalScope":true,"impliedFormat":1},{"version":"74f7fa2d027d5b33eb0471c8e82a6c87216223181ec31247c357a3e8e2fddc5b","affectsGlobalScope":true,"impliedFormat":1},{"version":"d6d7ae4d1f1f3772e2a3cde568ed08991a8ae34a080ff1151af28b7f798e22ca","affectsGlobalScope":true,"impliedFormat":1},{"version":"063600664504610fe3e99b717a1223f8b1900087fab0b4cad1496a114744f8df","affectsGlobalScope":true,"impliedFormat":1},{"version":"934019d7e3c81950f9a8426d093458b65d5aff2c7c1511233c0fd5b941e608ab","affectsGlobalScope":true,"impliedFormat":1},{"version":"52ada8e0b6e0482b728070b7639ee42e83a9b1c22d205992756fe020fd9f4a47","affectsGlobalScope":true,"impliedFormat":1},{"version":"3bdefe1bfd4d6dee0e26f928f93ccc128f1b64d5d501ff4a8cf3c6371200e5e6","affectsGlobalScope":true,"impliedFormat":1},{"version":"59fb2c069260b4ba00b5643b907ef5d5341b167e7d1dbf58dfd895658bda2867","affectsGlobalScope":true,"impliedFormat":1},{"version":"639e512c0dfc3fad96a84caad71b8834d66329a1f28dc95e3946c9b58176c73a","affectsGlobalScope":true,"impliedFormat":1},{"version":"368af93f74c9c932edd84c58883e736c9e3d53cec1fe24c0b0ff451f529ceab1","affectsGlobalScope":true,"impliedFormat":1},{"version":"af3dd424cf267428f30ccfc376f47a2c0114546b55c44d8c0f1d57d841e28d74","affectsGlobalScope":true,"impliedFormat":1},{"version":"995c005ab91a498455ea8dfb63aa9f83fa2ea793c3d8aa344be4a1678d06d399","affectsGlobalScope":true,"impliedFormat":1},{"version":"959d36cddf5e7d572a65045b876f2956c973a586da58e5d26cde519184fd9b8a","affectsGlobalScope":true,"impliedFormat":1},{"version":"965f36eae237dd74e6cca203a43e9ca801ce38824ead814728a2807b1910117d","affectsGlobalScope":true,"impliedFormat":1},{"version":"3925a6c820dcb1a06506c90b1577db1fdbf7705d65b62b99dce4be75c637e26b","affectsGlobalScope":true,"impliedFormat":1},{"version":"0a3d63ef2b853447ec4f749d3f368ce642264246e02911fcb1590d8c161b8005","affectsGlobalScope":true,"impliedFormat":1},{"version":"8cdf8847677ac7d20486e54dd3fcf09eda95812ac8ace44b4418da1bbbab6eb8","affectsGlobalScope":true,"impliedFormat":1},{"version":"8444af78980e3b20b49324f4a16ba35024fef3ee069a0eb67616ea6ca821c47a","affectsGlobalScope":true,"impliedFormat":1},{"version":"3287d9d085fbd618c3971944b65b4be57859f5415f495b33a6adc994edd2f004","affectsGlobalScope":true,"impliedFormat":1},{"version":"b4b67b1a91182421f5df999988c690f14d813b9850b40acd06ed44691f6727ad","affectsGlobalScope":true,"impliedFormat":1},{"version":"8e7f8264d0fb4c5339605a15daadb037bf238c10b654bb3eee14208f860a32ea","affectsGlobalScope":true,"impliedFormat":1},{"version":"782dec38049b92d4e85c1585fbea5474a219c6984a35b004963b00beb1aab538","affectsGlobalScope":true,"impliedFormat":1},{"version":"7e29f41b158de217f94cb9676bf9cbd0cd9b5a46e1985141ed36e075c52bf6ad","affectsGlobalScope":true,"impliedFormat":1},{"version":"ac51dd7d31333793807a6abaa5ae168512b6131bd41d9c5b98477fc3b7800f9f","impliedFormat":1},{"version":"bd7dee3446a5b94651d58000ddfda40296f073e9372891f65003a524b4620697","impliedFormat":1},{"version":"42c169fb8c2d42f4f668c624a9a11e719d5d07dacbebb63cbcf7ef365b0a75b3","impliedFormat":1},"a02ee9382c051c8f17b59c858ac398eca92a1beba04e51c1fb9fa80c1da4f381","05479b11811a224b2f78c79e7c102b5717f3113ffebd0ba32ee74684c2031e4c","fd99941cc0f993846ad0566e976b928e3e6a057a902c8022a2b49ae50dc9b7aa","68d4e6ae5d8a2f2f17112d876fad421f432ad7ad500eaad21b7ca6a8a1c26907","7112fd0dc38f38938b903c0d92988ae205fe620b178dbe8fbe515600f8041da6","637010ea999d1ae6009c4c791610dff54b4e208d483725e586804366f823ee17",{"version":"6c7176368037af28cb72f2392010fa1cef295d6d6744bca8cfb54985f3a18c3e","affectsGlobalScope":true,"impliedFormat":1},{"version":"ab41ef1f2cdafb8df48be20cd969d875602483859dc194e9c97c8a576892c052","affectsGlobalScope":true,"impliedFormat":1},{"version":"437e20f2ba32abaeb7985e0afe0002de1917bc74e949ba585e49feba65da6ca1","affectsGlobalScope":true,"impliedFormat":1},{"version":"21d819c173c0cf7cc3ce57c3276e77fd9a8a01d35a06ad87158781515c9a438a","impliedFormat":1},{"version":"98cffbf06d6bab333473c70a893770dbe990783904002c4f1a960447b4b53dca","affectsGlobalScope":true,"impliedFormat":1},{"version":"3af97acf03cc97de58a3a4bc91f8f616408099bc4233f6d0852e72a8ffb91ac9","affectsGlobalScope":true,"impliedFormat":1},{"version":"808069bba06b6768b62fd22429b53362e7af342da4a236ed2d2e1c89fcca3b4a","affectsGlobalScope":true,"impliedFormat":1},{"version":"1db0b7dca579049ca4193d034d835f6bfe73096c73663e5ef9a0b5779939f3d0","affectsGlobalScope":true,"impliedFormat":1},{"version":"9798340ffb0d067d69b1ae5b32faa17ab31b82466a3fc00d8f2f2df0c8554aaa","affectsGlobalScope":true,"impliedFormat":1},{"version":"f26b11d8d8e4b8028f1c7d618b22274c892e4b0ef5b3678a8ccbad85419aef43","affectsGlobalScope":true,"impliedFormat":1},{"version":"5929864ce17fba74232584d90cb721a89b7ad277220627cc97054ba15a98ea8f","impliedFormat":1},{"version":"763fe0f42b3d79b440a9b6e51e9ba3f3f91352469c1e4b3b67bfa4ff6352f3f4","impliedFormat":1},{"version":"25c8056edf4314820382a5fdb4bb7816999acdcb929c8f75e3f39473b87e85bc","impliedFormat":1},{"version":"c464d66b20788266e5353b48dc4aa6bc0dc4a707276df1e7152ab0c9ae21fad8","impliedFormat":1},{"version":"78d0d27c130d35c60b5e5566c9f1e5be77caf39804636bc1a40133919a949f21","impliedFormat":1},{"version":"c6fd2c5a395f2432786c9cb8deb870b9b0e8ff7e22c029954fabdd692bff6195","impliedFormat":1},{"version":"1d6e127068ea8e104a912e42fc0a110e2aa5a66a356a917a163e8cf9a65e4a75","impliedFormat":1},{"version":"5ded6427296cdf3b9542de4471d2aa8d3983671d4cac0f4bf9c637208d1ced43","impliedFormat":1},{"version":"7f182617db458e98fc18dfb272d40aa2fff3a353c44a89b2c0ccb3937709bfb5","impliedFormat":1},{"version":"cadc8aced301244057c4e7e73fbcae534b0f5b12a37b150d80e5a45aa4bebcbd","impliedFormat":1},{"version":"385aab901643aa54e1c36f5ef3107913b10d1b5bb8cbcd933d4263b80a0d7f20","impliedFormat":1},{"version":"9670d44354bab9d9982eca21945686b5c24a3f893db73c0dae0fd74217a4c219","impliedFormat":1},{"version":"0b8a9268adaf4da35e7fa830c8981cfa22adbbe5b3f6f5ab91f6658899e657a7","impliedFormat":1},{"version":"11396ed8a44c02ab9798b7dca436009f866e8dae3c9c25e8c1fbc396880bf1bb","impliedFormat":1},{"version":"ba7bc87d01492633cb5a0e5da8a4a42a1c86270e7b3d2dea5d156828a84e4882","impliedFormat":1},{"version":"4893a895ea92c85345017a04ed427cbd6a1710453338df26881a6019432febdd","impliedFormat":1},{"version":"c21dc52e277bcfc75fac0436ccb75c204f9e1b3fa5e12729670910639f27343e","impliedFormat":1},{"version":"13f6f39e12b1518c6650bbb220c8985999020fe0f21d818e28f512b7771d00f9","impliedFormat":1},{"version":"9b5369969f6e7175740bf51223112ff209f94ba43ecd3bb09eefff9fd675624a","impliedFormat":1},{"version":"4fe9e626e7164748e8769bbf74b538e09607f07ed17c2f20af8d680ee49fc1da","impliedFormat":1},{"version":"24515859bc0b836719105bb6cc3d68255042a9f02a6022b3187948b204946bd2","impliedFormat":1},{"version":"ea0148f897b45a76544ae179784c95af1bd6721b8610af9ffa467a518a086a43","impliedFormat":1},{"version":"24c6a117721e606c9984335f71711877293a9651e44f59f3d21c1ea0856f9cc9","impliedFormat":1},{"version":"dd3273ead9fbde62a72949c97dbec2247ea08e0c6952e701a483d74ef92d6a17","impliedFormat":1},{"version":"405822be75ad3e4d162e07439bac80c6bcc6dbae1929e179cf467ec0b9ee4e2e","impliedFormat":1},{"version":"0db18c6e78ea846316c012478888f33c11ffadab9efd1cc8bcc12daded7a60b6","impliedFormat":1},{"version":"e61be3f894b41b7baa1fbd6a66893f2579bfad01d208b4ff61daef21493ef0a8","impliedFormat":1},{"version":"bd0532fd6556073727d28da0edfd1736417a3f9f394877b6d5ef6ad88fba1d1a","impliedFormat":1},{"version":"89167d696a849fce5ca508032aabfe901c0868f833a8625d5a9c6e861ef935d2","impliedFormat":1},{"version":"615ba88d0128ed16bf83ef8ccbb6aff05c3ee2db1cc0f89ab50a4939bfc1943f","impliedFormat":1},{"version":"a4d551dbf8746780194d550c88f26cf937caf8d56f102969a110cfaed4b06656","impliedFormat":1},{"version":"8bd86b8e8f6a6aa6c49b71e14c4ffe1211a0e97c80f08d2c8cc98838006e4b88","impliedFormat":1},{"version":"317e63deeb21ac07f3992f5b50cdca8338f10acd4fbb7257ebf56735bf52ab00","impliedFormat":1},{"version":"4732aec92b20fb28c5fe9ad99521fb59974289ed1e45aecb282616202184064f","impliedFormat":1},{"version":"2e85db9e6fd73cfa3d7f28e0ab6b55417ea18931423bd47b409a96e4a169e8e6","impliedFormat":1},{"version":"c46e079fe54c76f95c67fb89081b3e399da2c7d109e7dca8e4b58d83e332e605","impliedFormat":1},{"version":"bf67d53d168abc1298888693338cb82854bdb2e69ef83f8a0092093c2d562107","impliedFormat":1},{"version":"b52476feb4a0cbcb25e5931b930fc73cb6643fb1a5060bf8a3dda0eeae5b4b68","affectsGlobalScope":true,"impliedFormat":1},{"version":"f9501cc13ce624c72b61f12b3963e84fad210fbdf0ffbc4590e08460a3f04eba","affectsGlobalScope":true,"impliedFormat":1},{"version":"e7721c4f69f93c91360c26a0a84ee885997d748237ef78ef665b153e622b36c1","affectsGlobalScope":true,"impliedFormat":1},{"version":"0fa06ada475b910e2106c98c68b10483dc8811d0c14a8a8dd36efb2672485b29","impliedFormat":1},{"version":"33e5e9aba62c3193d10d1d33ae1fa75c46a1171cf76fef750777377d53b0303f","impliedFormat":1},{"version":"2b06b93fd01bcd49d1a6bd1f9b65ddcae6480b9a86e9061634d6f8e354c1468f","impliedFormat":1},{"version":"6a0cd27e5dc2cfbe039e731cf879d12b0e2dded06d1b1dedad07f7712de0d7f4","affectsGlobalScope":true,"impliedFormat":1},{"version":"13f5c844119c43e51ce777c509267f14d6aaf31eafb2c2b002ca35584cd13b29","impliedFormat":1},{"version":"e60477649d6ad21542bd2dc7e3d9ff6853d0797ba9f689ba2f6653818999c264","impliedFormat":1},{"version":"c2510f124c0293ab80b1777c44d80f812b75612f297b9857406468c0f4dafe29","affectsGlobalScope":true,"impliedFormat":1},{"version":"5524481e56c48ff486f42926778c0a3cce1cc85dc46683b92b1271865bcf015a","impliedFormat":1},{"version":"4c829ab315f57c5442c6667b53769975acbf92003a66aef19bce151987675bd1","affectsGlobalScope":true,"impliedFormat":1},{"version":"b2ade7657e2db96d18315694789eff2ddd3d8aea7215b181f8a0b303277cc579","impliedFormat":1},{"version":"9855e02d837744303391e5623a531734443a5f8e6e8755e018c41d63ad797db2","impliedFormat":1},{"version":"4d631b81fa2f07a0e63a9a143d6a82c25c5f051298651a9b69176ba28930756d","impliedFormat":1},{"version":"836a356aae992ff3c28a0212e3eabcb76dd4b0cc06bcb9607aeef560661b860d","impliedFormat":1},{"version":"1e0d1f8b0adfa0b0330e028c7941b5a98c08b600efe7f14d2d2a00854fb2f393","impliedFormat":1},{"version":"41670ee38943d9cbb4924e436f56fc19ee94232bc96108562de1a734af20dc2c","affectsGlobalScope":true,"impliedFormat":1},{"version":"c906fb15bd2aabc9ed1e3f44eb6a8661199d6c320b3aa196b826121552cb3695","impliedFormat":1},{"version":"22295e8103f1d6d8ea4b5d6211e43421fe4564e34d0dd8e09e520e452d89e659","impliedFormat":1},{"version":"58647d85d0f722a1ce9de50955df60a7489f0593bf1a7015521efe901c06d770","impliedFormat":1},{"version":"73b5fa37db36eeac90c4d752e39586f1b57187400c4f5280fd05f16437287a45","impliedFormat":1},{"version":"a10f0e1854f3316d7ee437b79649e5a6ae3ae14ffe6322b02d4987071a95362e","impliedFormat":1},{"version":"e208f73ef6a980104304b0d2ca5f6bf1b85de6009d2c7e404028b875020fa8f2","impliedFormat":1},{"version":"d163b6bc2372b4f07260747cbc6c0a6405ab3fbcea3852305e98ac43ca59f5bc","impliedFormat":1},{"version":"e6fa9ad47c5f71ff733744a029d1dc472c618de53804eae08ffc243b936f87ff","affectsGlobalScope":true,"impliedFormat":1},{"version":"a6f137d651076822d4fe884287e68fd61785a0d3d1fdb250a5059b691fa897db","impliedFormat":1},{"version":"24826ed94a78d5c64bd857570fdbd96229ad41b5cb654c08d75a9845e3ab7dde","impliedFormat":1},{"version":"8b479a130ccb62e98f11f136d3ac80f2984fdc07616516d29881f3061f2dd472","impliedFormat":1},{"version":"928af3d90454bf656a52a48679f199f64c1435247d6189d1caf4c68f2eaf921f","affectsGlobalScope":true,"impliedFormat":1},{"version":"bceb58df66ab8fb00170df20cd813978c5ab84be1d285710c4eb005d8e9d8efb","affectsGlobalScope":true,"impliedFormat":1},{"version":"3f16a7e4deafa527ed9995a772bb380eb7d3c2c0fd4ae178c5263ed18394db2c","impliedFormat":1},{"version":"933921f0bb0ec12ef45d1062a1fc0f27635318f4d294e4d99de9a5493e618ca2","impliedFormat":1},{"version":"71a0f3ad612c123b57239a7749770017ecfe6b66411488000aba83e4546fde25","impliedFormat":1},{"version":"77fbe5eecb6fac4b6242bbf6eebfc43e98ce5ccba8fa44e0ef6a95c945ff4d98","impliedFormat":1},{"version":"4f9d8ca0c417b67b69eeb54c7ca1bedd7b56034bb9bfd27c5d4f3bc4692daca7","impliedFormat":1},{"version":"814118df420c4e38fe5ae1b9a3bafb6e9c2aa40838e528cde908381867be6466","impliedFormat":1},{"version":"a3fc63c0d7b031693f665f5494412ba4b551fe644ededccc0ab5922401079c95","impliedFormat":1},{"version":"80523c00b8544a2000ae0143e4a90a00b47f99823eb7926c1e03c494216fc363","impliedFormat":1},{"version":"37ba7b45141a45ce6e80e66f2a96c8a5ab1bcef0fc2d0f56bb58df96ec67e972","impliedFormat":1},{"version":"45650f47bfb376c8a8ed39d4bcda5902ab899a3150029684ee4c10676d9fbaee","impliedFormat":1},{"version":"746911b62b329587939560deb5c036aca48aece03147b021fa680223255d5183","affectsGlobalScope":true,"impliedFormat":1},{"version":"18fd40412d102c5564136f29735e5d1c3b455b8a37f920da79561f1fde068208","impliedFormat":1},{"version":"c8d3e5a18ba35629954e48c4cc8f11dc88224650067a172685c736b27a34a4dc","impliedFormat":1},{"version":"f0be1b8078cd549d91f37c30c222c2a187ac1cf981d994fb476a1adc61387b14","affectsGlobalScope":true,"impliedFormat":1},{"version":"0aaed1d72199b01234152f7a60046bc947f1f37d78d182e9ae09c4289e06a592","impliedFormat":1},{"version":"2b55d426ff2b9087485e52ac4bc7cfafe1dc420fc76dad926cd46526567c501a","impliedFormat":1},{"version":"66ba1b2c3e3a3644a1011cd530fb444a96b1b2dfe2f5e837a002d41a1a799e60","impliedFormat":1},{"version":"7e514f5b852fdbc166b539fdd1f4e9114f29911592a5eb10a94bb3a13ccac3c4","impliedFormat":1},{"version":"5b7aa3c4c1a5d81b411e8cb302b45507fea9358d3569196b27eb1a27ae3a90ef","affectsGlobalScope":true,"impliedFormat":1},{"version":"5987a903da92c7462e0b35704ce7da94d7fdc4b89a984871c0e2b87a8aae9e69","affectsGlobalScope":true,"impliedFormat":1},{"version":"ea08a0345023ade2b47fbff5a76d0d0ed8bff10bc9d22b83f40858a8e941501c","impliedFormat":1},{"version":"47613031a5a31510831304405af561b0ffaedb734437c595256bb61a90f9311b","impliedFormat":1},{"version":"ae062ce7d9510060c5d7e7952ae379224fb3f8f2dd74e88959878af2057c143b","impliedFormat":1},{"version":"8a1a0d0a4a06a8d278947fcb66bf684f117bf147f89b06e50662d79a53be3e9f","affectsGlobalScope":true,"impliedFormat":1},{"version":"358765d5ea8afd285d4fd1532e78b88273f18cb3f87403a9b16fef61ac9fdcfe","impliedFormat":1},{"version":"9f55299850d4f0921e79b6bf344b47c420ce0f507b9dcf593e532b09ea7eeea1","impliedFormat":1},{"version":"2811b4a386a990e9884a92c3d93a9a6b7c811cfcde0ef95d35110828e8e6dab5","affectsGlobalScope":true,"impliedFormat":1},{"version":"d3cfde44f8089768ebb08098c96d01ca260b88bccf238d55eee93f1c620ff5a5","impliedFormat":1},{"version":"293eadad9dead44c6fd1db6de552663c33f215c55a1bfa2802a1bceed88ff0ec","impliedFormat":1},{"version":"833e92c058d033cde3f29a6c7603f517001d1ddd8020bc94d2067a3bc69b2a8e","impliedFormat":1},{"version":"08b2fae7b0f553ad9f79faec864b179fc58bc172e295a70943e8585dd85f600c","impliedFormat":1},{"version":"f12edf1672a94c578eca32216839604f1e1c16b40a1896198deabf99c882b340","impliedFormat":1},{"version":"e3498cf5e428e6c6b9e97bd88736f26d6cf147dedbfa5a8ad3ed8e05e059af8a","impliedFormat":1},{"version":"dba3f34531fd9b1b6e072928b6f885aa4d28dd6789cbd0e93563d43f4b62da53","impliedFormat":1},{"version":"f672c876c1a04a223cf2023b3d91e8a52bb1544c576b81bf64a8fec82be9969c","impliedFormat":1},{"version":"e4b03ddcf8563b1c0aee782a185286ed85a255ce8a30df8453aade2188bbc904","impliedFormat":1},{"version":"2329d90062487e1eaca87b5e06abcbbeeecf80a82f65f949fd332cfcf824b87b","impliedFormat":1},{"version":"25b3f581e12ede11e5739f57a86e8668fbc0124f6649506def306cad2c59d262","impliedFormat":1},{"version":"4fdb529707247a1a917a4626bfb6a293d52cd8ee57ccf03830ec91d39d606d6d","impliedFormat":1},{"version":"a9ebb67d6bbead6044b43714b50dcb77b8f7541ffe803046fdec1714c1eba206","impliedFormat":1},{"version":"5780b706cece027f0d4444fbb4e1af62dc51e19da7c3d3719f67b22b033859b9","impliedFormat":1},{"version":"13cf85419bed0cdf8620928644cd22f879ab8716be06c54b25121f2275866f8d","signature":"f7c61da660b0b00d56978b38dbd455e15d715a1ed7289ab5e57b0cff7f75c736"},{"version":"d2ef18ae3de4b054850f2a20ec73ef3654169a9c4ba1f6dc2aaff6704066cbfb","signature":"d752248665264faadee9e4ac41d3553b94bc5faa7cc340f4b06d35eeae114a4e"},"96c1975b27880a2d45533bc9a5c8519b67f0b8426227d25cf338bb46d8ee88ac","8c6f2cfa70430e9fcc8270da30ff9edb3dc58d7d2267226306126274a3a69e71","1b4c3c8430dab098711e99e50fdf6b04ca0997532bf491d1151b8bc6b1c32102","0ea06ef050a9aefc5feffc042fa9c0542595e5a51b29d0ffd86444c0308d963a",{"version":"56ea3533fda008ec0d62b803351c9ec44ee7a895bb5a28d8991e63e592d76f8b","signature":"98569d84de7b59f97c23e53ccae3281c959a77a9f256252035c44251bb8190c2"},"3429c12ab0faef47ed7819acd99826009d6662d0e1e67568a89819b4d1b1e398","3af6889916c13140e8a6d27c0f48f55823181704d61c19eb90472bb1ff6a44e8",{"version":"09f49f068b07ef851d5f1204ca91ca734368456747d1d6ff6e2e485bd87d2a15","signature":"8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881"},{"version":"95f77feb94e09a91586ad4730f582bab32a003594b6044a80ac2ef59e93c4fd2","signature":"8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881"},{"version":"ee2f127bc1b6e2646e28fc02e6af67ab39eeaf4422e78f2a75c15009e691d523","affectsGlobalScope":true},"7ad6c95a8c35432498a58634c45caff1acbfb3f23f9808c14a63469327eb197a",{"version":"d2e64a6f25013b099e83bfadb2c388d7bef3e8f3fdb25528225bbc841e7e7e3a","impliedFormat":99},{"version":"369ba5259e66ca8c7d35e3234f7a2a0863a770fdb8266505747c65cf346a0804","impliedFormat":99},{"version":"64d984f55025daf604f670b7dfd090ea765f2098aee871174ef2ee3e94479098","impliedFormat":99},{"version":"f147b6710441cf3ec3234adf63b0593ce5e8c9b692959d21d3babc8454bcf743","impliedFormat":99},{"version":"e96d5373a66c2cfbbc7e6642cf274055aa2c7ff6bd37be7480c66faf9804db6d","impliedFormat":99},{"version":"02bcdd7a76c5c1c485cbf05626d24c86ac8f9a1d8dc31f8924108bbaa4cf3ba9","impliedFormat":99},{"version":"c874ab6feac6e0fdf9142727c9a876065777a5392f14b0bbcf869b1e69eb46b5","impliedFormat":99},{"version":"7c553fc9e34773ddbaabe0fa1367d4b109101d0868a008f11042bee24b5a925d","impliedFormat":99},{"version":"9962ce696fbdce2421d883ca4b062a54f982496625437ae4d3633376c5ad4a80","impliedFormat":99},{"version":"e3ea467c4a7f743f3548c9ed61300591965b1d12c08c8bb9aaff8a002ba95fce","impliedFormat":99},{"version":"4c17183a07a63bea2653fbfc0a942b027160ddbee823024789a415f9589de327","impliedFormat":99},{"version":"3e2203c892297ea44b87470fde51b3d48cfe3eeb6901995de429539462894464","impliedFormat":99},{"version":"c84bf7a4abc5e7fdf45971a71b25b0e0d34ccd5e720a866dd78bb71d60d41a3f","impliedFormat":99},{"version":"151ff381ef9ff8da2da9b9663ebf657eac35c4c9a19183420c05728f31a6761d","impliedFormat":1},{"version":"ee70b8037ecdf0de6c04f35277f253663a536d7e38f1539d270e4e916d225a3f","affectsGlobalScope":true,"impliedFormat":1},{"version":"a660aa95476042d3fdcc1343cf6bb8fdf24772d31712b1db321c5a4dcc325434","impliedFormat":1},{"version":"282f98006ed7fa9bb2cd9bdbe2524595cfc4bcd58a0bb3232e4519f2138df811","impliedFormat":1},{"version":"6222e987b58abfe92597e1273ad7233626285bc2d78409d4a7b113d81a83496b","impliedFormat":1},{"version":"cbe726263ae9a7bf32352380f7e8ab66ee25b3457137e316929269c19e18a2be","impliedFormat":1},{"version":"8b96046bf5fb0a815cba6b0880d9f97b7f3a93cf187e8dcfe8e2792e97f38f87","impliedFormat":99},{"version":"bacf2c84cf448b2cd02c717ad46c3d7fd530e0c91282888c923ad64810a4d511","affectsGlobalScope":true,"impliedFormat":1},{"version":"402e5c534fb2b85fa771170595db3ac0dd532112c8fa44fc23f233bc6967488b","impliedFormat":1},{"version":"52dcc257df5119fb66d864625112ce5033ac51a4c2afe376a0b299d2f7f76e4a","impliedFormat":1},{"version":"e5bab5f871ef708d52d47b3e5d0aa72a08ee7a152f33931d9a60809711a2a9a3","impliedFormat":1},{"version":"e16dc2a81595736024a206c7d5c8a39bfe2e6039208ef29981d0d95434ba8fcf","impliedFormat":1},{"version":"cc4a4903fb698ca1d961d4c10dce658aa3a479faf40509d526f122b044eaf6a4","impliedFormat":1},{"version":"19ee8416e6473ed6c7adb868fa796b5653cf0fa2a337658e677eaa0d134388c3","impliedFormat":1},{"version":"1328ab4e442614b28cdb3d4b414cf68325c0da0dca07287a338d0654b7a00261","impliedFormat":1},{"version":"a039dc21f045919f3cbee2ec13812cc6cc3eebc99dae4be00973230f468d19a6","impliedFormat":1},{"version":"3fbe57af01460e49dcd29df55d6931e1672bc6f1be0fb073d11410bc16f9037d","impliedFormat":1},{"version":"f760be449e8562ec5c09bb5187e8e1eabf3c113c0c58cddda53ef8c69f3e2131","impliedFormat":1},{"version":"44325ed13294fce6ab825b82947bbeed2611db7dad9d9135260192f375e5a189","impliedFormat":1},{"version":"e392e8fb5b514eafc585601c1d781485aa6dd6a320e75daf1064a4c6918a1b45","impliedFormat":1},{"version":"46e4a36e8ddbdfb4e7330e11c81c970dc8b218611df9183d39c41c5f8c653b55","impliedFormat":1},{"version":"370bde134aa8c2abc926d0e99d3a4d5d5dba65c6ee65459137e4f02670cbf841","impliedFormat":1},{"version":"6332f565867cf4a740a70e30f31cefba37ef7cebcf74f22eab8d744fde6d193e","impliedFormat":1},{"version":"2977b7884aedc895a1d0c9c210c7cf3272c29d6959a08a6fa3ff71e0aff08175","impliedFormat":1},{"version":"17f2922d41ddd032830a91371c948cd9ce903b35c95adca72271a54584f19b0b","impliedFormat":1},{"version":"3eed76ede2a1a14d7c9bb0a642041282dcc264811139d3dd275c9fe14efc9840","impliedFormat":1},{"version":"e3cf0611709328b449ec13f8c436712d62003620ce480139fae46ce001c2ee9f","impliedFormat":1},{"version":"8d369483f0c2b9ee388129cfdb6a43bc8112b377e86a41884bd06e19ce04f4c1","impliedFormat":99},{"version":"82e687ebd99518bc63ea04b0c3810fb6e50aa6942decd0ca6f7a56d9b9a212a6","impliedFormat":99},{"version":"7f698624bbbb060ece7c0e51b7236520ebada74b747d7523c7df376453ed6fea","impliedFormat":1},{"version":"8f07f2b6514744ac96e51d7cb8518c0f4de319471237ea10cf688b8d0e9d0225","impliedFormat":1},{"version":"257b83faa134d971c738a6b9e4c47e59bb7b23274719d92197580dd662bfafc3","impliedFormat":99},{"version":"e01ea380015ed698c3c0e2ccd0db72f3fc3ef1abc4519f122aa1c1a8d419a505","impliedFormat":99},{"version":"5ada1f8a9580c0f7478fe03ae3e07e958f0b79bdfb9dd50eeb98c1324f40011b","impliedFormat":99},{"version":"a8301dc90b4bd9fba333226ee0f1681aeeff1bd90233a8f647e687cb4b7d3521","impliedFormat":99},{"version":"e3225dc0bec183183509d290f641786245e6652bc3dce755f7ef404060693c35","impliedFormat":99},{"version":"09a03870ed8c55d7453bc9ad684df88965f2f770f987481ca71b8a09be5205bc","impliedFormat":99},{"version":"e6233e1c976265e85aa8ad76c3881febe6264cb06ae3136f0257e1eab4a6cc5a","impliedFormat":99},{"version":"2cdd50ddc49e2d608ee848fc4ab0db9a2716624fabb4209c7c683d87e54d79c5","impliedFormat":99},{"version":"e431d664338b8470abb1750d699c7dfcebb1a25434559ef85bb96f1e82de5972","impliedFormat":99},{"version":"427fe2004642504828c1476d0af4270e6ad4db6de78c0b5da3e4c5ca95052a99","impliedFormat":1},{"version":"2eeffcee5c1661ddca53353929558037b8cf305ffb86a803512982f99bcab50d","impliedFormat":99},{"version":"9afb4cb864d297e4092a79ee2871b5d3143ea14153f62ef0bb04ede25f432030","affectsGlobalScope":true,"impliedFormat":99},{"version":"2c4254139d037c3caca66ce291c1308c1b5092cfcb151eb25980db932dd3b01a","impliedFormat":99},{"version":"970ae00ed018cb96352dc3f37355ef9c2d9f8aa94d7174ccd6d0ed855e462097","impliedFormat":99},{"version":"d2f8dee457ef7660b604226d471d55d927c3051766bdd80353553837492635c3","impliedFormat":99},{"version":"110a503289a2ef76141ffff3ffceb9a1c3662c32748eb9f6777a2bd0866d6fb1","impliedFormat":99},{"version":"69bf2422313487956e4dacf049f30cb91b34968912058d244cb19e4baa24da97","impliedFormat":99},{"version":"310e6b62c493ce991624169a1c1904015769d947be88dc67e00adc7ebebcfa87","impliedFormat":99},{"version":"62fefda288160bf6e435b21cc03d3fbac11193d8d3bd0e82d86623cca7691c29","impliedFormat":99},{"version":"fcc46a8bcbf9bef21023bba1995160a25f0bc590ca3563ec44c315b4f4c1b18a","impliedFormat":99},{"version":"0309a01650023994ed96edbd675ea4fdc3779a823ce716ad876cc77afb792b62","impliedFormat":99},{"version":"f13d7beeea58e219daef3a40e0dc4f2bd7d9581ac04cedec236102a12dfd2090","impliedFormat":99},{"version":"669573548930fb7d0a0761b827e203dc623581e21febf0be80fb02414f217d74","impliedFormat":99},{"version":"48c411efce1848d1ed55de41d7deb93cbf7c04080912fd87aa517ed25ef42639","affectsGlobalScope":true,"impliedFormat":1},{"version":"a094636c05f3e75cb072684dd42cd25a4c1324bec4a866706c85c04cecd49613","affectsGlobalScope":true,"impliedFormat":99},{"version":"fe2d63fcfdde197391b6b70daf7be8c02a60afa90754a5f4a04bdc367f62793d","impliedFormat":99},{"version":"9a3e2c85ec1ab7a0874a19814cc73c691b716282cb727914093089c5a8475955","impliedFormat":99},{"version":"cbdc781d2429935c9c42acd680f2a53a9f633e8de03290ec6ea818e4f7bff19a","impliedFormat":99},{"version":"9f6d9f5dd710922f82f69abf9a324e28122b5f31ae6f6ce78427716db30a377e","impliedFormat":99},{"version":"ac2414a284bdecfd6ab7b87578744ab056cd04dd574b17853cd76830ef5b72f2","impliedFormat":99},{"version":"c3f921bbc9d2e65bd503a56fbc66da910e68467baedb0b9db0cc939e1876c0d7","impliedFormat":99},{"version":"c30a41267fc04c6518b17e55dcb2b810f267af4314b0b6d7df1c33a76ce1b330","impliedFormat":1},{"version":"72422d0bac4076912385d0c10911b82e4694fc106e2d70added091f88f0824ba","impliedFormat":1},{"version":"da251b82c25bee1d93f9fd80c5a61d945da4f708ca21285541d7aff83ecb8200","impliedFormat":1},{"version":"64db14db2bf37ac089766fdb3c7e1160fabc10e9929bc2deeede7237e4419fc8","impliedFormat":1},{"version":"98b94085c9f78eba36d3d2314affe973e8994f99864b8708122750788825c771","impliedFormat":1},{"version":"0cc99fbb161d78729d71fad66c6c363e3095862d6277160f29fa960744b785c6","affectsGlobalScope":true,"impliedFormat":99},"eafe971f0537c72b0c88921ace227edc4385aaa7a0d6f55d71a2cf7354d999dd","42f6ef2098e5f1fad32f3a3fe6c1a53ed69d96c88c8cd0f1f7f704e3644c04db",{"version":"82feed5761798327b042b439f08378a00c861b18568b0df4e91ed1fe0cba74d5","signature":"8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881"},"d54312c268bdb1e2f6fc96632df8c10b541926b13c3be2e84ddb5c781a3deb15","5c4acc6116059d2ff6bc705a70e85a1a63ccb32cc5431f7cf0d3bf8c2702cdc8",{"version":"bc03c3c352f689e38c0ddd50c39b1e65d59273991bfc8858a9e3c0ebb79c023b","impliedFormat":1},{"version":"ae77d81a5541a8abb938a0efedf9ac4bea36fb3a24cc28cfa11c598863aba571","impliedFormat":1},{"version":"3cfb7c0c642b19fb75132154040bb7cd840f0002f9955b14154e69611b9b3f81","impliedFormat":1},{"version":"8387ec1601cf6b8948672537cf8d430431ba0d87b1f9537b4597c1ab8d3ade5b","impliedFormat":1},{"version":"d16f1c460b1ca9158e030fdf3641e1de11135e0c7169d3e8cf17cc4cc35d5e64","impliedFormat":1},{"version":"a934063af84f8117b8ce51851c1af2b76efe960aa4c7b48d0343a1b15c01aedf","impliedFormat":1},{"version":"e3c5ad476eb2fca8505aee5bdfdf9bf11760df5d0f9545db23f12a5c4d72a718","impliedFormat":1},{"version":"462bccdf75fcafc1ae8c30400c9425e1a4681db5d605d1a0edb4f990a54d8094","impliedFormat":1},{"version":"5923d8facbac6ecf7c84739a5c701a57af94a6f6648d6229a6c768cf28f0f8cb","impliedFormat":1},{"version":"d0570ce419fb38287e7b39c910b468becb5b2278cf33b1000a3d3e82a46ecae2","impliedFormat":1},{"version":"3aca7f4260dad9dcc0a0333654cb3cde6664d34a553ec06c953bce11151764d7","impliedFormat":1},{"version":"a0a6f0095f25f08a7129bc4d7cb8438039ec422dc341218d274e1e5131115988","impliedFormat":1},{"version":"b58f396fe4cfe5a0e4d594996bc8c1bfe25496fbc66cf169d41ac3c139418c77","impliedFormat":1},{"version":"45785e608b3d380c79e21957a6d1467e1206ac0281644e43e8ed6498808ace72","impliedFormat":1},{"version":"bece27602416508ba946868ad34d09997911016dbd6893fb884633017f74e2c5","impliedFormat":1},{"version":"2a90177ebaef25de89351de964c2c601ab54d6e3a157cba60d9cd3eaf5a5ee1a","impliedFormat":1},{"version":"82200e963d3c767976a5a9f41ecf8c65eca14a6b33dcbe00214fcbe959698c46","impliedFormat":1},{"version":"b4966c503c08bbd9e834037a8ab60e5f53c5fd1092e8873c4a1c344806acdab2","impliedFormat":1},{"version":"3d3208d0f061e4836dd5f144425781c172987c430f7eaee483fadaa3c5780f9f","impliedFormat":1},{"version":"34a8a5b4c21e7a6d07d3b6bce72371da300ec1aed58961067e13f1f4dc849712","impliedFormat":1},{"version":"da0f84fcd93700b4a5fbf9c6f166a6cc19fc798231bff56dd1e3875bfc6966eb","impliedFormat":1},{"version":"634ff08e0143bec98401c737de7bfc6883bfec09200bd3806d2a4cfc79c62aaa","impliedFormat":1},{"version":"90a86863e3a57143c50fec5129d844ec12cef8fe44d120e56650ed51a6ce9867","impliedFormat":1},{"version":"472c0a98c5de98b8f5206132c941b052f5cc1ae78860cb8712ac4f1ebf4550ca","impliedFormat":1},{"version":"538c4903ef9f8df7d84c6cf2e065d589a2532d152fa44105c7093a606393b814","impliedFormat":1},{"version":"cfcb6acbb793a78b20899e6537c010bfbbf939c77471abcdc2a41faf9682ca1a","impliedFormat":1},{"version":"a7798e86de8e76844f774f8e0e338149893789cdc08970381f0ae78c86e8667f","impliedFormat":1},{"version":"eebc21bb922816f92302a1f9dcefc938e74d4af8c0a111b2a52519d7e25d4868","impliedFormat":1},{"version":"6b359d3c3138a9f4d3a9c9a8fda24be6fd15bd789e692252b53e68ce99db8edc","impliedFormat":1},{"version":"9488b648a6a4146b26c0fd4e85984f617056293092a89861f5259a69be16ca5c","impliedFormat":1},{"version":"e156513655462b5811a8f980e32ccd204c19042f8c9756430fe4e8d6f7c1326e","impliedFormat":1},{"version":"5679b694d138b8c4b3d56c9b1210f903c6b0ca2b5e7f1682a2dd41a6c955f094","impliedFormat":1},{"version":"ca8da035b76fb0136d2c1390dda650b7979202dbe0f5dc7eaefcde1c76dee4f4","impliedFormat":1},{"version":"4b1022a607444684abeee6537e4cace97263d1ef047c31b012c41fdc15838a79","impliedFormat":1},{"version":"dd0271250f1e4314e52d7e0da9f3b25a708827f8a43ceff847a2a5e3fd3283e8","affectsGlobalScope":true,"impliedFormat":1},{"version":"47971d8a8639a2a2dd684091c6e7660ec5909fed540c4479ca24e22ac237194e","affectsGlobalScope":true,"impliedFormat":1},{"version":"e1075312b07671ef1cbf46409a0fa2eb2b90bb59c6215c94f0e530113013eeda","impliedFormat":1},{"version":"1bfd63c3f3749c5dc925bb0c05f229f9a376b8d3f8173d0e01901c08202caf6f","impliedFormat":1},{"version":"da850b4fdbabdd528f8b9c2784c5ba3b3bedc4e2e1e34dcd08b6407f9ec61a25","impliedFormat":1},{"version":"e61c918bb5f4a39b795a06e22bc4d44befcefd22f6a5c8a732c9ed0b565a6128","impliedFormat":1},{"version":"ee56351989b0e6f31fd35c9048e222146ced0aac68c64ce2e034f7c881327d6d","impliedFormat":1},{"version":"f58b2f1c8f4bcf519377d39f9555631b6507977ad2f4d8b73ac04622716dc925","impliedFormat":1},{"version":"4c805d3d1228c73877e7550afd8b881d89d9bc0c6b73c88940cffcdd2931b1f6","impliedFormat":1},{"version":"4aa74b4bc57c535815ae004550c59a953c8f8c3c61418ac47a7dcfefba76d1ba","impliedFormat":1},{"version":"78b17ceb133d95df989a1e073891259b54c968f71f416cd76185308af4f9a185","impliedFormat":1},{"version":"d76e5d04d111581b97e0aa35de3063022d20d572f22f388d3846a73f6ce0b788","impliedFormat":1},{"version":"0a53bb48eba6e9f5a56e3b85529fbbe786d96e84871579d10593d4f3ae0f9dba","impliedFormat":1},{"version":"d34fb8b0a66f0a406c7ce63a36f16dda7ff4500b11b0bd30a491aa0d59336d1f","impliedFormat":1},{"version":"282b31893b18a06114e5173f775dd085597ca220d183b8bd474d21846c048334","impliedFormat":1},{"version":"ed27d5ce258f069acf0036471d1fbb56b4cb3c16d7401b52a51297eca651db62","impliedFormat":1},{"version":"ec203a515afd88589bf1d384535024f5b90ebe6b5c416fb3dcca0abd428a8ba4","impliedFormat":1},{"version":"32a2a1374b57f0744d284ca93b477bd97825922513a24dfe262cbf3497377d96","impliedFormat":1},{"version":"a8b60d24dc1eb26c0e987f9461c893744339a7f48e4496f8077f258a644cffab","impliedFormat":1},{"version":"3f9df27a77a23d69088e369b42af5f95bcb3e605e6b5c2395f0bfcd82045e051","affectsGlobalScope":true,"impliedFormat":1},{"version":"9fd080a9458c6d6f3eb6d4e2b12a3ec498d7d219863e9dca0646bdee9acce875","impliedFormat":1},{"version":"e5d31928bee2ba0e72aeb858881891f8948326e4f91823028d0aea5c6f9e7564","affectsGlobalScope":true,"impliedFormat":1},{"version":"9a9ba9f6fd097bb2f57d68da8a39403bbe4dc818b8ccd155a780e4e23fa556f2","impliedFormat":1},{"version":"e50c4cd1f5cbce3e74c19a5bbf503c460e6ae86597e6d648a98c7f6c90b596dd","impliedFormat":1},{"version":"fa140f881e20591ce163039a7968b54c5e51c11228708b4f9147473d06471cf5","affectsGlobalScope":true,"impliedFormat":1},{"version":"295eca0c47be1191690fd2fe588195fff9d4dc43852aceb8b4cab2aa634579f0","impliedFormat":1},{"version":"59ee7346e19b0050508a592702871dc943083c6dcb69a47d52e888115d840781","impliedFormat":1},{"version":"067712491fb2094c212c733dd8e2d56e74c309a9ce9dac9e919286b7245a1eb4","impliedFormat":1},{"version":"a5eae58ac55bd30c42359e4b01fb2be5eddac336869d3f04ffb4daa54b58f009","impliedFormat":1},{"version":"d12d691ef8933e8db39f2ca81d6973940ff5e37bb421752f5b6e7bc15dea3abf","impliedFormat":1},{"version":"4c5f8bd9b3a1aae4e4fddfee41667e495a045f73ed603993038fa6a8ba92fa14","impliedFormat":1},{"version":"dfb274ab0f319cf18ce7152067c25f984c7fd1924fc72b3f66734588444c934a","impliedFormat":1},{"version":"108c8c05cbc3fbbbd4ff4fc0779c9bef55655c28528eb0f77829795dc9f0b484","impliedFormat":1},{"version":"a7e5444d24cdec45f113f4fb8a687e1c83a5d30c55d2da19a04be71108ad77bd","impliedFormat":1},{"version":"41ec17e218b7358fcff25c719bc419fec8ec98f13e561b9a33b07392d4fec24c","impliedFormat":1},{"version":"23c204326746e981e02d7f0a15ab6f8015f9035998cb3766c9ddbf8ea247aea2","impliedFormat":1},{"version":"25f994b5d76ce6a3186a3319555bbba79706dac2174019915c39ac6080e98c7e","impliedFormat":1},{"version":"dfa4e2c6a612d43851ccbc499598cb006a3a78bc8c7f972c52078f862fa84e47","impliedFormat":1},{"version":"02c1705fa902f172be6e9020d74bcd92ce5db8d2ef3e1b03aabc2ac8eb46c3db","impliedFormat":1},{"version":"99d2d8a0c7bb3dd77459552269a7b5865fa912cedab69db686d40d2586b551f7","impliedFormat":1},{"version":"b47abe58626d76d258472b1d5f76752dd29efe681545f32698db84e7f83517df","impliedFormat":1},{"version":"3a99bbbbbf42e45c3d203e7c74f1319b79f9821c5e5f3cdd03249184d3e003ce","impliedFormat":1},{"version":"aaacc0e12ab4de27bdf131f666e315d8e60abec26c7f87501e0a7806fc824ae6","impliedFormat":1},{"version":"3b4195afd41a9215afc7be0820f8083f6bd2e85e5e0b45bb0061fb041944711e","impliedFormat":1},{"version":"108df8095f5e25d7189dd0d1433ac2df75ec40c779d8faf7d2670f1485beb643","impliedFormat":1},{"version":"ddd3c1d3c9ff67140191a3cf49b09875e20f28f2fc5535ae5ea16e14293a989b","impliedFormat":1},{"version":"7b496e53d5f7e1737adcb5610516476ee055bf547918797348f245c68e7418fe","impliedFormat":1},{"version":"577f44389d7faedd7fc9c0330caf73140e5d0d5f6c968210bff78be569f398a7","impliedFormat":1},{"version":"3046c57724587a59bceefadd30040d418e9df81b9f3cfd680618a3511302ed7a","impliedFormat":1},{"version":"15ccc911ed15397e838471bfe6d476c28deffe976c05cb057e6b1ea7491242c2","impliedFormat":1},{"version":"64b5a5ebdaead77a9a564aa938f4fb7a45e27cda7441d3bee8c9de8a4df5a04f","impliedFormat":1},{"version":"a48037f7af5f80df8973db5e562e17566407541de284b8dadf1879ea3aed8a2f","impliedFormat":1},{"version":"dab97d96ce986857150db03f0d435b44c060d126b4a387c7807f4e9f6c92e531","impliedFormat":1},{"version":"85f39366ea7bc5e34b596fc97de18a7e377856755e789d8e931054f2191d9b8b","impliedFormat":1},{"version":"daf3ea3d49f6e8a2fa70b7ca1f21bd97f1b65021b31fbfccb73dd55f86abb792","impliedFormat":1},{"version":"b15bd260805f9dd06cd4b2b741057209994823942c5696fd835e8a04fb4aab6b","impliedFormat":1},{"version":"6635a824edf99ed52dbd3502d5bce35990c3ed5e2ec5cef88229df8ac0c52b06","impliedFormat":1},{"version":"d6577effa37aae713c34363b7cc4c84851cbabe399882c60e2b70bcbb02bfa01","impliedFormat":1},{"version":"8eaf80ad438890fe5880c39a7bbf2c998ce7d29d4c14dd56d82db63bd871eefb","impliedFormat":1},{"version":"9b3e7f776f312c76ac67e1060e5398d7ac2c69d6a3a928a9daaae2eb05b15f56","impliedFormat":1},{"version":"202042eccb4789b7dee51ba9ecab0b854834ea5c1d6a3946504bfc733d4468c3","impliedFormat":1},{"version":"2b2ef76a9f36094b07ee6f76a5ac6903f2f65c0a20283201814a8d1e752cb592","impliedFormat":1},{"version":"8882e4e087d0bc8cc713cb3d8090c45d33e373e6f5c83e0f8d00fe6a950ef875","impliedFormat":1},{"version":"ac21bc74759274985ce9b5d4e4c46dfbdd345cb6439c856941193be9e9519cdf","impliedFormat":1},"6caad2304b1a62161e9652354fb7fc592056ce90c4029ec20c766685ade06a1c","9e37c8f3b0f75d6f437611c8d9bb40d214c096af21f68fe1fb73e96a97ba4fef",{"version":"30475ec1ee09219d8e6656696f78ba5d7bfa16ed34d73a1d72d465c5502c10b7","signature":"50d0a31dc529cbca69361c8c1106ffd8392c242f39b2c76286e2137289b48474"},{"version":"46b95f78a62977450b1eb9a14c6d8c4e41b8215ad92f0f763df167c78759edb6","signature":"8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881"},"f1f5b549079c714ccfa504311a19c49a1d4059146697c49aa5d7751c8aedcb65","c6e1515fe1b2763d0a958c2d9aa24894ae14bfee9e5b85c163c9c6646904a4b5",{"version":"681cf9768031b874fafdd81a20e8a20ca6c92a5cbf12e86532a69182e315b065","impliedFormat":1},{"version":"32727845ab5bd8a9ef3e4844c567c09f6d418fcf0f90d381c00652a6f23e7f6e","impliedFormat":1},{"version":"e5b810845dedef5aa0d682efa61be20dcb2e28c27a64ff5cc4cfc122f3f3980f","impliedFormat":1},{"version":"7a8ec10b0834eb7183e4bfcd929838ac77583828e343211bb73676d1e47f6f01","impliedFormat":1},{"version":"f02650de64b96593c1eb736f28a6a0a773c51662d8525b06cc735d77fa9c7af8","affectsGlobalScope":true,"impliedFormat":1},{"version":"3f00324f263189b385c3a9383b1f4dae6237697bcf0801f96aa35c340512d79c","impliedFormat":1},{"version":"ec8997c2e5cea26befc76e7bf990750e96babb16977673a9ff3b5c0575d01e48","impliedFormat":1},{"version":"b07f64ff6ec710998a62b07377fbda0ab4c313ba1f0055bfe9faa22cffedd47c","impliedFormat":1},"edfb16fa0b00c176a5599d55d5b86507435d00ad566a368e7f9e79c4f8f4f1a6",{"version":"8875406c33d072171b96fa70437823908eef109f83e78f7f1b2c5fd6e6c45fbf","signature":"8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881"},{"version":"3b89216a7e38a454985ad17bb2ff85792837dc812f2a89fa5f60ad0a2e216fa7","impliedFormat":99},{"version":"16fe60bb544cfedfd2b5bb2f7d0b3957be7978706d57d9f06edc9c0c8dbdba23","impliedFormat":99},{"version":"de4a612aa8f1704af486f701e21993c786ba7d8cfed55fffa6684026aea2346e","impliedFormat":99},{"version":"c73fdf42528325dd17940937ed787b15ae3445c6a2dae1a2b74bc4d87d337ca2","impliedFormat":99},{"version":"e8e17dfef3cfa9f0847ac93dd535a9896af7fb57c1a1b164484bb1b0ee4a25d8","impliedFormat":99},{"version":"7f2bb8f9aba83e5f5952cf362e405452e02ff420667434021e9a8be095b15fc1","impliedFormat":99},{"version":"638a22f8e16b31c37297483fa38cfc760ed309b16d4c606a7b4532f4394c9c0c","impliedFormat":99},{"version":"9394183f4c37b8591156f32e41223c9e0dd211eefe7499155d4cdf15268eaea8","impliedFormat":99},{"version":"cb9b6d9e3f32decbd816ffb20a392fe774ba7a2bd615b5c22ce645312f703ef0","impliedFormat":99},{"version":"b333e679ec61ac6bc9e696bf9adac47b20701568697f1a0e2a05674f97e02f5d","impliedFormat":99},{"version":"ac7293557679952437466a41e6e8a47614cb99a51d0440fc36ac7aa02d44ab93","impliedFormat":99},{"version":"7d3e062a778b8f5ea4f0cac7e925e31f88e6739812ebc5f827474324a4048f14","impliedFormat":99},{"version":"be030f8dc45fded610c82e51642b195a3dc80fa0ec63e1b822425050e1b04743","impliedFormat":99},{"version":"8c1fb5394cc1cf2943fa7a294632a4a24eb4fbd4a68aee00131dc93c02d2de09","impliedFormat":99},{"version":"f232e7548dd00bc8631f61bf8b0259288a3b68a21023f1f177427c05d905446b","impliedFormat":99},{"version":"2dca43f25e917d7f01f2963e665852c92ca18b2f939694cbfdc87c503210c0a6","impliedFormat":99},{"version":"4e003c868b0d8f8ad200b96cbc653e18e513fa23e1c19c4fe3cc25d4394efc47","impliedFormat":99},{"version":"8887e70871f697fa42ad7cdf32168db60ec2d6760c173c97973e35377fe5d83b","impliedFormat":99},{"version":"161c8e0690c46021506e32fda85956d785b70f309ae97011fd27374c065cac9b","affectsGlobalScope":true,"impliedFormat":1},{"version":"e0864480ea083087d705f9405bd6bf59b795e8474c3447f0d6413b2bce535a09","impliedFormat":99},{"version":"e67cbea16f1994af89efd700542dbf3828a46a52b29e4d67e801bd7869dc103c","impliedFormat":99},{"version":"f582b0fcbf1eea9b318ab92fb89ea9ab2ebb84f9b60af89328a91155e1afce72","impliedFormat":99},{"version":"3fd8a5aefd8c3feb3936ca66f5aa89dff7bf6e6537b4158dbd0f6e0d65ed3b9e","impliedFormat":1},{"version":"a18642ddf216f162052a16cba0944892c4c4c977d3306a87cb673d46abbb0cbf","impliedFormat":1},{"version":"41c41c6e90133bb2a14f7561f29944771886e5535945b2b372e2f6ed6987746e","impliedFormat":1},{"version":"4ec16d7a4e366c06a4573d299e15fe6207fc080f41beac5da06f4af33ea9761e","impliedFormat":99},{"version":"960bd764c62ac43edc24eaa2af958a4b4f1fa5d27df5237e176d0143b36a39c6","affectsGlobalScope":true,"impliedFormat":99},{"version":"c765b3bfab230cec7c051c6d90880270d3846746a186d2d02729fc7b10abf5a2","impliedFormat":99},{"version":"59f8dc89b9e724a6a667f52cdf4b90b6816ae6c9842ce176d38fcc973669009e","affectsGlobalScope":true,"impliedFormat":99},{"version":"a29a1d34dc79bdd96b6f8a9bf529199f8811b3d22f0c8be12c28c9898f9b383a","impliedFormat":99},{"version":"7757c6ca7a8ad1992401c6aff33633d6a088515be5a39d7ee188b35bfc8e5f8e","impliedFormat":99},{"version":"2faebfa830ae4cfbfb58e48b0ec20a2a63882d776f0ca36ec7155d45cf1b7f2d","impliedFormat":99},{"version":"dc6e3ce502651ecc523590588213bfb986c04b60f5265d37f76662b824425903","impliedFormat":99},{"version":"748aaddcaf36dd6d2cd08d9b4a8fdf621da41cb61dc4536d17104a23a7c12f6d","impliedFormat":99},"fc91f7ff2593690565f5b1a91e4a7e0dd8e1cf8dfecc4424bb78f206d6810919","9990ab6510e8f419ad5e3929619f6ce78f91a798c55304ccafbe34bacaa3f934",{"version":"42baf4ca38c38deaf411ea73f37bc39ff56c6e5c761a968b64ac1b25c92b5cd8","impliedFormat":1},{"version":"4f6ae308c5f2901f2988c817e1511520619e9025b9b12cc7cce2ab2e6ffed78a","impliedFormat":1},{"version":"8718fa41d7cf4aa91de4e8f164c90f88e0bf343aa92a1b9b725a9c675c64e16b","impliedFormat":1},{"version":"f992cd6cc0bcbaa4e6c810468c90f2d8595f8c6c3cf050c806397d3de8585562","impliedFormat":1},{"version":"fb893a0dfc3c9fb0f9ca93d0648694dd95f33cbad2c0f2c629f842981dfd4e2e","impliedFormat":1},{"version":"89e326922cadcc2331d7e851011cf9f0456a681aaf3c95b48b81f8d80e8cdfba","impliedFormat":1},{"version":"751764bb94219b4ce8f5475dc35d3de2e432fea01a0c9610cd7f69ad05e398c6","impliedFormat":1},{"version":"5d08a179b846f5ee674624b349ebebe2121c455e3a265dc93da4e8d9e89722b4","impliedFormat":1},{"version":"ed19da84b7dbf00952ad0b98ce5c194f1903bcf7c94d8103e8e0d63b271543ae","impliedFormat":1},{"version":"89121c1bf2990f5219bfd802a3e7fc557de447c62058d6af68d6b6348d64499a","impliedFormat":1},{"version":"79b4369233a12c6fa4a07301ecb7085802c98f3a77cf9ab97eee27e1656f82e6","impliedFormat":1},{"version":"7a1dd1e9c8bf5e23129495b10718b280340c7500570e0cfe5cffcdee51e13e48","impliedFormat":1},{"version":"19990350fca066265b2c190c9b6cde1229f35002ea2d4df8c9e397e9942f6c89","impliedFormat":99},{"version":"8fb8fdda477cd7382477ffda92c2bb7d9f7ef583b1aa531eb6b2dc2f0a206c10","impliedFormat":99},{"version":"66995b0c991b5c5d42eff1d950733f85482c7419f7296ab8952e03718169e379","impliedFormat":99},{"version":"9863f888da357e35e013ca3465b794a490a198226bd8232c2f81fb44e16ff323","impliedFormat":99},{"version":"e72bf395b12850f1ac67333d8d8a448b452a9354a382d173e24df1140441ef4a","impliedFormat":99},{"version":"976dfad6edebf8b3400ae9a4eb5d599ff2a3f42bcd29a23f5c3f8cbb64faf0fe","impliedFormat":99},{"version":"ad4d7cca0eb5ed856af2233a9d3cb82f88f4e395b7486b3a38be7ed7e929dce4","impliedFormat":99},{"version":"6d27c62b4b283b38fd2deaafa0b05a3137450a82c163fd303d0a4c205daa0012","impliedFormat":99},{"version":"b4c6184d78303b0816e779a48bef779b15aea4a66028eb819aac0abee8407dea","impliedFormat":99},{"version":"db085d2171d48938a99e851dafe0e486dce9859e5dfa73c21de5ed3d4d6fb0c5","impliedFormat":99},{"version":"62a3ad1ddd1f5974b3bf105680b3e09420f2230711d6520a521fab2be1a32838","impliedFormat":99},{"version":"a77be6fc44c876bc10c897107f84eaba10790913ebdcad40fcda7e47469b2160","impliedFormat":99},{"version":"06cf55b6da5cef54eaaf51cdc3d4e5ebf16adfdd9ebd20cec7fe719be9ced017","impliedFormat":99},{"version":"91f5dbcdb25d145a56cffe957ec665256827892d779ef108eb2f3864faff523b","impliedFormat":99},{"version":"052ba354bab8fb943e0bc05a0769f7b81d7c3b3c6cd0f5cfa53c7b2da2a525c5","impliedFormat":99},{"version":"927955a3de5857e0a1c575ced5a4245e74e6821d720ed213141347dd1870197f","impliedFormat":99},{"version":"fec804d54cd97dd77e956232fc37dc13f53e160d4bbeeb5489e86eeaa91f7ebd","impliedFormat":99},{"version":"ef5a2229cc377ddd1b8d3fb498b161d6d47ca2d8fa5857b9cfee5ab6b945b687","impliedFormat":99},{"version":"cdcf9ea426ad970f96ac930cd176d5c69c6c24eebd9fc580e1572d6c6a88f62c","impliedFormat":1},{"version":"23cd712e2ce083d68afe69224587438e5914b457b8acf87073c22494d706a3d0","impliedFormat":1},{"version":"156a859e21ef3244d13afeeba4e49760a6afa035c149dda52f0c45ea8903b338","impliedFormat":1},{"version":"3ac40516c33b87f751f7507346933081a26cdb8a3e11a6b3aa07d23f803c85db","impliedFormat":1},{"version":"4ac80270b6787c2b77a2d98a9714a71f4363c24b5890314f3ba582c94bfbe779","impliedFormat":1},{"version":"14e9acf826baba0ef4b5665704084896e7bcc06f65a9ab13af7e93d27d6b7069","impliedFormat":1},{"version":"68834d631c8838c715f225509cfc3927913b9cc7a4870460b5b60c8dbdb99baf","impliedFormat":1},{"version":"21adf13435b9b748529c8cedf80f884e5130b9684188120a686cd2b26a2059c7","impliedFormat":1},{"version":"eec76bf6b9346f3f95fa402621b889489e96930e72295b0369022f332e9b4a6a","impliedFormat":1},{"version":"096a67958cdf1d95e780cf723d60e26e6ece748154feb0f388776d3976ecdcfa","impliedFormat":1},{"version":"ea6bc8de8b59f90a7a3960005fd01988f98fd0784e14bc6922dde2e93305ec7d","impliedFormat":1},{"version":"36107995674b29284a115e21a0618c4c2751b32a8766dd4cb3ba740308b16d59","impliedFormat":1},{"version":"914a0ae30d96d71915fc519ccb4efbf2b62c0ddfb3a3fc6129151076bc01dc60","impliedFormat":1},{"version":"9c32412007b5662fd34a8eb04292fb5314ec370d7016d1c2fb8aa193c807fe22","impliedFormat":1},{"version":"d243db6b25788f439e7e2f03c05688e92f46764351673bb0e7b2f3631232e186","impliedFormat":1},{"version":"4d327f7d72ad0918275cea3eee49a6a8dc8114ae1d5b7f3f5d0774de75f7439a","impliedFormat":1},{"version":"6ebe8ebb8659aaa9d1acbf3710d7dae3e923e97610238b9511c25dc39023a166","impliedFormat":1},{"version":"e85d7f8068f6a26710bff0cc8c0fc5e47f71089c3780fbede05857331d2ddec9","impliedFormat":1},{"version":"7befaf0e76b5671be1d47b77fcc65f2b0aad91cc26529df1904f4a7c46d216e9","impliedFormat":1},{"version":"0a60a292b89ca7218b8616f78e5bbd1c96b87e048849469cccb4355e98af959a","impliedFormat":1},{"version":"0b6e25234b4eec6ed96ab138d96eb70b135690d7dd01f3dd8a8ab291c35a683a","impliedFormat":1},{"version":"9666f2f84b985b62400d2e5ab0adae9ff44de9b2a34803c2c5bd3c8325b17dc0","impliedFormat":1},{"version":"40cd35c95e9cf22cfa5bd84e96408b6fcbca55295f4ff822390abb11afbc3dca","impliedFormat":1},{"version":"b1616b8959bf557feb16369c6124a97a0e74ed6f49d1df73bb4b9ddf68acf3f3","impliedFormat":1},{"version":"5b03a034c72146b61573aab280f295b015b9168470f2df05f6080a2122f9b4df","impliedFormat":1},{"version":"40b463c6766ca1b689bfcc46d26b5e295954f32ad43e37ee6953c0a677e4ae2b","impliedFormat":1},{"version":"249b9cab7f5d628b71308c7d9bb0a808b50b091e640ba3ed6e2d0516f4a8d91d","impliedFormat":1},{"version":"d33ce35e3f9cfcc1d94eca415bdd3bde94d5b153ffdd33e6c4455c029986c630","impliedFormat":1},{"version":"80aae6afc67faa5ac0b32b5b8bc8cc9f7fa299cff15cf09cc2e11fd28c6ae29e","impliedFormat":1},{"version":"f473cd2288991ff3221165dcf73cd5d24da30391f87e85b3dd4d0450c787a391","impliedFormat":1},{"version":"499e5b055a5aba1e1998f7311a6c441a369831c70905cc565ceac93c28083d53","impliedFormat":1},{"version":"8aee8b6d4f9f62cf3776cda1305fb18763e2aade7e13cea5bbe699112df85214","impliedFormat":1},{"version":"98498b101803bb3dde9f76a56e65c14b75db1cc8bec5f4db72be541570f74fc5","impliedFormat":1},{"version":"4dc59f6e1dbf3d5f66660fceabe6c174d3261b37b696ae1854f0dbaf255fc753","impliedFormat":1},{"version":"5d0375ca7310efb77e3ef18d068d53784faf62705e0ad04569597ae0e755c401","impliedFormat":1},{"version":"59af37caec41ecf7b2e76059c9672a49e682c1a2aa6f9d7dc78878f53aa284d6","impliedFormat":1},{"version":"addf417b9eb3f938fddf8d81e96393a165e4be0d4a8b6402292f9c634b1cb00d","impliedFormat":1},{"version":"436d7b4543b340b0f3eef4310d524242e41369b9652aa9c70428767c4dcac455","impliedFormat":1},{"version":"adf27937dba6af9f08a68c5b1d3fce0ca7d4b960c57e6d6c844e7d1a8e53adae","impliedFormat":1},{"version":"12950411eeab8563b349cb7959543d92d8d02c289ed893d78499a19becb5a8cc","impliedFormat":1},{"version":"2e85db9e6fd73cfa3d7f28e0ab6b55417ea18931423bd47b409a96e4a169e8e6","impliedFormat":1},{"version":"c46e079fe54c76f95c67fb89081b3e399da2c7d109e7dca8e4b58d83e332e605","impliedFormat":1},{"version":"114f493b30f364255290472111b5a4791d5902c308645670cd0401429cbc6930","impliedFormat":1},{"version":"1671a94d1e5c9862700b8ac8a79034524bc802c344f51909db2c4f040372cc62","affectsGlobalScope":true,"impliedFormat":1},{"version":"fec943fdb3275eb6e006b35e04a8e2e99e9adf3f4b969ddf15315ac7575a93e4","impliedFormat":1},{"version":"d4a22007b481fe2a2e6bfd3a42c00cd62d41edb36d30fc4697df2692e9891fc8","impliedFormat":1},{"version":"f60e3e3060207ac982da13363181fd7ee4beecc19a7c569f0d6bb034331066c2","impliedFormat":1},{"version":"17230b34bb564a3a2e36f9d3985372ccab4ad1722df2c43f7c5c2b553f68e5db","impliedFormat":1},{"version":"dcb41cc4b671f5f85d3754e68dfde7824686a8adbb4c690cb259c1501cb868e1","impliedFormat":1},{"version":"21ac4cf3f8d8c6e1201cb31f600be708c9a37867fc5c73b7ccf80560fae591c8","impliedFormat":1},{"version":"0dfe35191a04e8f9dc7caeb9f52f2ee07402736563d12cbccd15fb5f31ac877f","impliedFormat":1},{"version":"798367363a3274220cbed839b883fe2f52ba7197b25e8cb2ac59c1e1fd8af6b7","impliedFormat":1},{"version":"2636a309ed87d6876728d9aca846a76b372cf2a21a4fdf9940a82a2dd86687d0","impliedFormat":1},{"version":"e85d04f57b46201ddc8ba238a84322432a4803a5d65e0bbd8b3b4f05345edd51","impliedFormat":1},{"version":"be1cc4d94ea60cbe567bc29ed479d42587bf1e6cba490f123d329976b0fe4ee5","impliedFormat":1},{"version":"03c258e060b7da220973f84b89615e4e9850e9b5d30b3a8e4840b3e3268ae8eb","impliedFormat":1},{"version":"15fe687c59d62741b4494d5e623d497d55eb38966ecf5bea7f36e48fc3fbe15e","impliedFormat":1},{"version":"2c3b8be03577c98530ef9cb1a76e2c812636a871f367e9edf4c5f3ce702b77f8","affectsGlobalScope":true,"impliedFormat":1},{"version":"7fa8d75d229eeaee235a801758d9c694e94405013fe77d5d1dd8e3201fc414f1","impliedFormat":1}],"root":[[189,201],[283,287],[386,391],400,401,436,437],"options":{"allowJs":true,"allowSyntheticDefaultImports":true,"esModuleInterop":true,"jsx":4,"module":99,"skipLibCheck":true,"strict":true,"target":9},"referencedMap":[[400,1],[401,2],[436,3],[437,4],[189,5],[190,6],[198,7],[191,6],[199,8],[287,9],[389,10],[388,11],[390,12],[387,13],[386,14],[200,15],[391,16],[201,6],[283,17],[192,18],[193,19],[196,20],[284,21],[194,22],[285,23],[195,24],[286,25],[197,26],[406,27],[398,28],[408,27],[409,29],[432,30],[303,27],[300,27],[299,27],[294,31],[305,32],[290,33],[301,34],[293,35],[292,36],[302,27],[297,37],[304,27],[298,38],[291,27],[307,39],[370,40],[371,40],[373,41],[372,40],[365,40],[366,40],[368,42],[367,40],[343,27],[345,27],[344,27],[347,43],[346,27],[310,44],[308,45],[311,27],[358,46],[312,40],[348,47],[357,48],[349,27],[352,49],[350,27],[353,27],[355,27],[351,49],[354,27],[356,27],[309,50],[384,51],[369,40],[364,52],[374,53],[380,54],[381,55],[383,56],[382,57],[362,52],[363,58],[359,59],[361,60],[360,61],[375,40],[379,62],[376,40],[377,63],[378,40],[313,27],[314,27],[317,27],[315,27],[316,27],[319,27],[320,64],[321,27],[322,27],[318,27],[323,27],[324,27],[325,27],[326,27],[327,65],[328,27],[342,66],[329,27],[330,27],[331,27],[332,27],[333,27],[334,27],[335,27],[338,27],[336,27],[337,27],[339,40],[340,40],[341,67],[289,27],[441,68],[257,69],[443,70],[255,27],[445,71],[444,27],[446,72],[448,73],[439,27],[449,27],[511,74],[452,75],[465,76],[450,27],[451,77],[466,78],[461,79],[462,80],[460,81],[464,82],[458,83],[453,84],[463,85],[459,76],[486,86],[499,87],[483,88],[500,89],[509,90],[474,91],[475,92],[473,93],[508,94],[503,95],[507,96],[477,97],[496,98],[476,99],[506,100],[471,101],[472,102],[478,103],[479,27],[485,104],[482,103],[469,105],[510,106],[501,107],[489,108],[488,103],[490,109],[493,110],[487,111],[491,112],[504,94],[480,113],[481,114],[494,115],[470,116],[498,117],[497,103],[484,114],[492,118],[495,119],[502,27],[468,27],[505,120],[512,121],[513,73],[442,27],[120,122],[121,122],[122,123],[75,124],[123,125],[124,126],[125,127],[70,27],[73,128],[71,27],[72,27],[126,129],[127,130],[128,131],[129,132],[130,133],[131,134],[132,134],[133,135],[134,136],[135,137],[136,138],[76,27],[74,27],[137,139],[138,140],[139,141],[173,142],[140,143],[141,27],[142,144],[143,145],[144,146],[145,147],[146,148],[147,149],[148,150],[149,151],[150,152],[151,152],[152,153],[153,27],[154,154],[155,155],[157,156],[156,157],[158,158],[159,159],[160,160],[161,161],[162,162],[163,163],[164,164],[165,165],[166,166],[167,167],[168,168],[169,169],[170,170],[77,27],[78,27],[79,27],[117,171],[118,27],[119,27],[171,172],[172,173],[520,174],[519,175],[521,27],[288,176],[522,176],[306,176],[60,27],[62,177],[63,176],[440,178],[523,27],[525,179],[524,27],[447,27],[526,27],[434,180],[433,27],[256,27],[61,27],[435,30],[174,181],[454,27],[457,182],[455,27],[456,27],[420,27],[279,183],[281,184],[280,185],[278,186],[277,27],[438,143],[424,27],[426,187],[425,27],[385,176],[518,188],[515,94],[517,189],[516,94],[514,27],[395,190],[392,27],[393,190],[394,191],[399,192],[397,193],[396,192],[239,194],[237,195],[238,196],[226,197],[227,195],[234,198],[225,199],[230,200],[240,27],[231,201],[236,202],[242,203],[241,204],[224,205],[232,206],[233,207],[228,208],[235,194],[229,209],[296,210],[295,27],[429,211],[411,212],[412,213],[415,214],[407,215],[414,216],[410,217],[405,27],[416,218],[417,219],[217,220],[216,221],[215,27],[223,27],[262,27],[467,27],[58,27],[59,27],[10,27],[11,27],[13,27],[12,27],[2,27],[14,27],[15,27],[16,27],[17,27],[18,27],[19,27],[20,27],[21,27],[3,27],[22,27],[23,27],[4,27],[24,27],[28,27],[25,27],[26,27],[27,27],[29,27],[30,27],[31,27],[5,27],[32,27],[33,27],[34,27],[35,27],[6,27],[39,27],[36,27],[37,27],[38,27],[40,27],[7,27],[41,27],[46,27],[47,27],[42,27],[43,27],[44,27],[45,27],[8,27],[51,27],[48,27],[49,27],[50,27],[52,27],[9,27],[53,27],[54,27],[55,27],[57,27],[56,27],[1,27],[95,222],[105,223],[94,222],[115,224],[86,225],[85,93],[114,94],[108,226],[113,227],[88,228],[102,229],[87,230],[111,231],[83,232],[82,94],[112,233],[84,234],[89,235],[90,27],[93,235],[80,27],[116,236],[106,237],[97,238],[98,239],[100,240],[96,241],[99,242],[109,94],[91,243],[92,244],[101,245],[81,89],[104,237],[103,235],[107,27],[110,246],[403,247],[431,248],[419,249],[404,247],[402,27],[418,250],[430,27],[428,27],[421,251],[427,252],[413,253],[423,27],[422,254],[263,255],[251,256],[214,27],[275,257],[265,258],[276,259],[268,260],[267,261],[266,262],[282,263],[269,27],[270,264],[271,265],[274,266],[273,27],[202,27],[213,267],[208,268],[211,269],[261,270],[247,27],[250,271],[249,272],[264,272],[248,273],[272,27],[210,274],[212,274],[204,275],[207,276],[258,275],[209,277],[203,27],[222,27],[205,27],[206,278],[259,279],[253,280],[254,279],[260,281],[252,27],[246,282],[243,283],[221,284],[219,285],[218,27],[220,286],[244,27],[245,287],[188,288],[178,289],[180,290],[187,291],[182,27],[183,27],[181,292],[184,293],[175,27],[176,27],[177,288],[179,294],[185,27],[186,295],[67,6],[68,6],[69,296],[65,297],[66,6],[64,6]],"affectedFilesPendingEmit":[400,401,436,437,189,190,198,191,199,287,389,388,390,387,386,200,391,201,283,192,193,196,284,194,285,195,286,197],"version":"5.9.3"}
./docs/superpowers/reviews/codex/phase-04.md:543: import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-04.md:619:-    const created = await createWorkspaceFolder(input);
./docs/superpowers/reviews/codex/phase-04.md:620:+    const created = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/phase-04.md:633:+    const attached = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/phase-04.md:1018: import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-04.md:1181:+import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-04.md:1429: - Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
./docs/superpowers/reviews/codex/phase-04.md:1445: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/phase-04.md:1826:-    const created = await createWorkspaceFolder(input);
./docs/superpowers/reviews/codex/phase-04.md:1827:+    const created = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/phase-04.md:1840:+    const attached = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/phase-04.md:1956: import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-04.md:2115:+import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-04.md:2253:/bin/bash -lc "sed -n '1,260p' apps/desktop/src/main.ts && printf '\\n--- createWorkspaceFolder ---\\n' && sed -n '1,240p' apps/desktop/src/workspaces/createWorkspaceFolder.ts && printf '\\n--- workspaceFiles ---\\n' && sed -n '1,260p' apps/desktop/src/workspaces/workspaceFiles.ts && printf '\\n--- renderer bridge types? ---\\n' && grep -R \"interface DohcDesktopBridge\\|dohcDesktop\" -n apps/desktop/src | head -50" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-04.md:2280:import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-04.md:2356:    const created = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/phase-04.md:2369:    const attached = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/phase-04.md:2441:--- createWorkspaceFolder ---
./docs/superpowers/reviews/codex/phase-04.md:2480:export async function createWorkspaceFolder(input: {
./docs/superpowers/reviews/codex/phase-04.md:2617:/bin/bash -lc "grep -R \"createWorkspaceFolder\" -n . --exclude-dir=node_modules --exclude-dir=.git && grep -R \"validateWorkspaceRootChoice\\|normalizeAbsolutePath\\|validateAttachedFolder\" -n . --exclude-dir=node_modules --exclude-dir=.git" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:24:apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:25:apps/desktop/src/workspaces/createWorkspaceFolder.ts
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:36:apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:44:apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:106:apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:107:apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:108:apps/desktop/src/workspaces/createWorkspaceFolder.ts:45:    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:111:apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:54:  it("rejects relative workspace roots", async () => {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:142:I found the relevant surface area: IPC registration lives in `main.ts`, the bridge is very thin, and file/path logic is split between `createWorkspaceFolder.ts`, `workspaceFiles.ts`, and registry storage. I’m reading the implementation and tests now to distinguish covered cases from plausible gaps.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:171:import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:247:    const created = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:260:    const attached = await createWorkspaceFolder({
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:490:/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/createWorkspaceFolder.ts" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:532:export async function createWorkspaceFolder(input: {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:667:import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:709:import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:823:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:177:- Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:828:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:193:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:870:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:871:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:7:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:872:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:887:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:106:apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:888:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:107:apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:918:./docs/superpowers/reviews/codex/phase-04.md:1429: - Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:923:./docs/superpowers/reviews/codex/phase-04.md:1445: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1055:./docs/superpowers/reviews/codex/phase-03.md:4234:  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1056:./docs/superpowers/reviews/codex/phase-03.md:4246:  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
./docs/superpowers/reviews/codex/phase-03.md:43: .../src/workspaces/createWorkspaceFolder.ts        |  52 +++
./docs/superpowers/reviews/codex/phase-03.md:61:/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 529c0d4 -- apps/desktop/src/main.ts apps/desktop/src/ipc/bridgeContract.ts apps/desktop/src/ipc/channels.ts apps/desktop/src/preload.ts apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/createWorkspaceFolder.ts apps/desktop/src/workspaces/workspaceFiles.ts' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-03.md:234:+import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-03.md:298:+    const created = await createWorkspaceFolder(input);
./docs/superpowers/reviews/codex/phase-03.md:414:+import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-03.md:475:diff --git a/apps/desktop/src/workspaces/createWorkspaceFolder.ts b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
./docs/superpowers/reviews/codex/phase-03.md:479:+++ b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
./docs/superpowers/reviews/codex/phase-03.md:503:+export async function createWorkspaceFolder(input: {
./docs/superpowers/reviews/codex/phase-03.md:2130:apps/desktop/src/workspaces/createWorkspaceFolder.ts
./docs/superpowers/reviews/codex/phase-03.md:2464:apps/desktop/src/workspaces/createWorkspaceFolder.ts:25:  kind: Extract<WorkspaceKind, "personal" | "shared">;
./docs/superpowers/reviews/codex/phase-03.md:2576:- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
./docs/superpowers/reviews/codex/phase-03.md:2577:- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
./docs/superpowers/reviews/codex/phase-03.md:3035:/bin/bash -lc "nl -ba apps/desktop/src/workspaces/createWorkspaceFolder.ts | sed -n '1,120p'
./docs/superpowers/reviews/codex/phase-03.md:3063:    23	export async function createWorkspaceFolder(input: {
./docs/superpowers/reviews/codex/phase-03.md:3337:     5	import type { CreatedWorkspace } from "./createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-03.md:3419:    22	import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
./docs/superpowers/reviews/codex/phase-03.md:3481:    84	    const created = await createWorkspaceFolder(input);
./docs/superpowers/reviews/codex/phase-03.md:4230:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
./docs/superpowers/reviews/codex/phase-03.md:4234:  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
./docs/superpowers/reviews/codex/phase-03.md:4242:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
./docs/superpowers/reviews/codex/phase-03.md:4246:  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
./docs/superpowers/reviews/codex/phase-00.md:1394: - Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
./docs/superpowers/reviews/codex/phase-00.md:1395: - Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:177:- Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:193:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1019:- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1020:- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
./apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
./apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./apps/desktop/dist/main/main.js:48:function validateAttachedFolder(path) {
./apps/desktop/dist/main/main.js:97:function normalizeAbsolutePath(path) {
./apps/desktop/dist/main/main.js:113:function validateWorkspaceRootChoice(rootPath, homeDir) {
./apps/desktop/dist/main/main.js:114:	const attached = validateAttachedFolder(rootPath);
./apps/desktop/dist/main/main.js:116:	const normalized = normalizeAbsolutePath(rootPath);
./apps/desktop/dist/main/main.js:117:	const home = normalizeAbsolutePath(homeDir);
./apps/desktop/dist/main/main.js:331:	const folderCheck = validateAttachedFolder(input.rootPath);
./apps/desktop/dist/main/main.js:512:		const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./packages/workspace-core/src/paths.test.ts:6:  validateAttachedFolder,
./packages/workspace-core/src/paths.test.ts:16:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:17:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:21:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:22:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:23:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:27:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./packages/workspace-core/src/paths.test.ts:111:    const { validateWorkspaceRootChoice } = await import("./paths");
./packages/workspace-core/src/paths.test.ts:113:      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
./packages/workspace-core/src/paths.test.ts:116:      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
./packages/workspace-core/src/paths.test.ts:121:    const { validateWorkspaceRootChoice } = await import("./paths");
./packages/workspace-core/src/paths.test.ts:123:      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
./packages/workspace-core/src/paths.test.ts:129:    const { validateWorkspaceRootChoice } = await import("./paths");
./packages/workspace-core/src/paths.test.ts:137:      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
./packages/workspace-core/src/paths.test.ts:143:    const { validateWorkspaceRootChoice } = await import("./paths");
./packages/workspace-core/src/paths.test.ts:144:    const result = validateWorkspaceRootChoice(
./packages/workspace-core/src/paths.test.ts:152:    const { validateWorkspaceRootChoice } = await import("./paths");
./packages/workspace-core/src/paths.test.ts:153:    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
./packages/workspace-core/src/paths.ts:16:export function validateAttachedFolder(path: string): FolderValidation {
./packages/workspace-core/src/paths.ts:65:export function normalizeAbsolutePath(path: string): string {
./packages/workspace-core/src/paths.ts:93:export function validateWorkspaceRootChoice(
./packages/workspace-core/src/paths.ts:97:  const attached = validateAttachedFolder(rootPath);
./packages/workspace-core/src/paths.ts:99:  const normalized = normalizeAbsolutePath(rootPath);
./packages/workspace-core/src/paths.ts:100:  const home = normalizeAbsolutePath(homeDir);
./docs/superpowers/reviews/codex/phase-04.md:520:+  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/phase-04.md:611:+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/phase-04.md:1444: - Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
./docs/superpowers/reviews/codex/phase-04.md:1445: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/phase-04.md:1454:+- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
./docs/superpowers/reviews/codex/phase-04.md:1456:+- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
./docs/superpowers/reviews/codex/phase-04.md:1469:+- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
./docs/superpowers/reviews/codex/phase-04.md:1562:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/phase-04.md:1564:+      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
./docs/superpowers/reviews/codex/phase-04.md:1567:+      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
./docs/superpowers/reviews/codex/phase-04.md:1572:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/phase-04.md:1574:+      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
./docs/superpowers/reviews/codex/phase-04.md:1580:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/phase-04.md:1588:+      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
./docs/superpowers/reviews/codex/phase-04.md:1594:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/phase-04.md:1595:+    const result = validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/phase-04.md:1603:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/phase-04.md:1604:+    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
./docs/superpowers/reviews/codex/phase-04.md:1650: export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-04.md:1699:+export function normalizeAbsolutePath(path: string): string {
./docs/superpowers/reviews/codex/phase-04.md:1727:+export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/phase-04.md:1731:+  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/phase-04.md:1733:+  const normalized = normalizeAbsolutePath(rootPath);
./docs/superpowers/reviews/codex/phase-04.md:1734:+  const home = normalizeAbsolutePath(homeDir);
./docs/superpowers/reviews/codex/phase-04.md:1790:+  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/phase-04.md:1818:+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/phase-04.md:2203:+export function normalizeAbsolutePath(path: string): string {
./docs/superpowers/reviews/codex/phase-04.md:2231:+export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/phase-04.md:2235:+  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/phase-04.md:2237:+  const normalized = normalizeAbsolutePath(rootPath);
./docs/superpowers/reviews/codex/phase-04.md:2238:+  const home = normalizeAbsolutePath(homeDir);
./docs/superpowers/reviews/codex/phase-04.md:2257:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/phase-04.md:2348:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/phase-04.md:2445:  validateAttachedFolder,
./docs/superpowers/reviews/codex/phase-04.md:2484:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/phase-04.md:2617:/bin/bash -lc "grep -R \"createWorkspaceFolder\" -n . --exclude-dir=node_modules --exclude-dir=.git && grep -R \"validateWorkspaceRootChoice\\|normalizeAbsolutePath\\|validateAttachedFolder\" -n . --exclude-dir=node_modules --exclude-dir=.git" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-01.md:313:+  validateAttachedFolder,
./docs/superpowers/reviews/codex/phase-01.md:323:+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-01.md:324:+    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-01.md:328:+    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/reviews/codex/phase-01.md:419:+export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-01.md:1353:     7	export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:49:apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:59:apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:106:apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:107:apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:148:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:239:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:497:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:536:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:662:/bin/bash -lc 'rg -n "validateWorkspaceRootChoice|validateAttachedFolder|validateUserWritePath|defaultWorkspaceRoot|workspace-core" -S .' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:827:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:192:- Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:828:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:193:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:829:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:202:- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:830:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:204:- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:832:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:217:- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:835:./packages/workspace-core/src/paths.ts:16:export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:837:./packages/workspace-core/src/paths.ts:93:export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:838:./packages/workspace-core/src/paths.ts:97:  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:840:./packages/workspace-core/src/paths.test.ts:6:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:843:./packages/workspace-core/src/paths.test.ts:16:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:844:./packages/workspace-core/src/paths.test.ts:17:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:845:./packages/workspace-core/src/paths.test.ts:21:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:846:./packages/workspace-core/src/paths.test.ts:22:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:847:./packages/workspace-core/src/paths.test.ts:23:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:848:./packages/workspace-core/src/paths.test.ts:27:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:857:./packages/workspace-core/src/paths.test.ts:111:    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:858:./packages/workspace-core/src/paths.test.ts:113:      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:859:./packages/workspace-core/src/paths.test.ts:116:      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:860:./packages/workspace-core/src/paths.test.ts:121:    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:861:./packages/workspace-core/src/paths.test.ts:123:      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:862:./packages/workspace-core/src/paths.test.ts:129:    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:863:./packages/workspace-core/src/paths.test.ts:137:      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:864:./packages/workspace-core/src/paths.test.ts:143:    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:865:./packages/workspace-core/src/paths.test.ts:144:    const result = validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:866:./packages/workspace-core/src/paths.test.ts:152:    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:867:./packages/workspace-core/src/paths.test.ts:153:    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:870:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:872:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:878:./apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:881:./apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:885:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:49:apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:886:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:59:apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:887:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:106:apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:888:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:107:apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:893:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:148:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:896:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:239:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:898:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:497:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:900:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:536:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:905:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:662:/bin/bash -lc 'rg -n "validateWorkspaceRootChoice|validateAttachedFolder|validateUserWritePath|defaultWorkspaceRoot|workspace-core" -S .' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:910:./docs/superpowers/reviews/codex/phase-04.md:520:+  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:913:./docs/superpowers/reviews/codex/phase-04.md:611:+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:922:./docs/superpowers/reviews/codex/phase-04.md:1444: - Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:923:./docs/superpowers/reviews/codex/phase-04.md:1445: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:924:./docs/superpowers/reviews/codex/phase-04.md:1454:+- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:925:./docs/superpowers/reviews/codex/phase-04.md:1456:+- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:927:./docs/superpowers/reviews/codex/phase-04.md:1469:+- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:939:./docs/superpowers/reviews/codex/phase-04.md:1562:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:940:./docs/superpowers/reviews/codex/phase-04.md:1564:+      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:941:./docs/superpowers/reviews/codex/phase-04.md:1567:+      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:942:./docs/superpowers/reviews/codex/phase-04.md:1572:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:943:./docs/superpowers/reviews/codex/phase-04.md:1574:+      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:944:./docs/superpowers/reviews/codex/phase-04.md:1580:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:945:./docs/superpowers/reviews/codex/phase-04.md:1588:+      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:946:./docs/superpowers/reviews/codex/phase-04.md:1594:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:947:./docs/superpowers/reviews/codex/phase-04.md:1595:+    const result = validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:948:./docs/superpowers/reviews/codex/phase-04.md:1603:+    const { validateWorkspaceRootChoice } = await import("./paths");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:949:./docs/superpowers/reviews/codex/phase-04.md:1604:+    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:954:./docs/superpowers/reviews/codex/phase-04.md:1650: export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:956:./docs/superpowers/reviews/codex/phase-04.md:1727:+export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:957:./docs/superpowers/reviews/codex/phase-04.md:1731:+  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:961:./docs/superpowers/reviews/codex/phase-04.md:1790:+  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:963:./docs/superpowers/reviews/codex/phase-04.md:1818:+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:968:./docs/superpowers/reviews/codex/phase-04.md:2231:+export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:969:./docs/superpowers/reviews/codex/phase-04.md:2235:+  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:971:./docs/superpowers/reviews/codex/phase-04.md:2257:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:974:./docs/superpowers/reviews/codex/phase-04.md:2348:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:975:./docs/superpowers/reviews/codex/phase-04.md:2445:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:977:./docs/superpowers/reviews/codex/phase-04.md:2484:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1010:./docs/superpowers/reviews/codex/phase-03.md:2173:export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1015:./docs/superpowers/reviews/codex/phase-03.md:2315:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1018:./docs/superpowers/reviews/codex/phase-03.md:2325:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1019:./docs/superpowers/reviews/codex/phase-03.md:2326:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1020:./docs/superpowers/reviews/codex/phase-03.md:2330:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1021:./docs/superpowers/reviews/codex/phase-03.md:2331:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1022:./docs/superpowers/reviews/codex/phase-03.md:2332:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1023:./docs/superpowers/reviews/codex/phase-03.md:2336:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1123:./docs/superpowers/reviews/codex/phase-01.md:313:+  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1126:./docs/superpowers/reviews/codex/phase-01.md:323:+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1127:./docs/superpowers/reviews/codex/phase-01.md:324:+    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1128:./docs/superpowers/reviews/codex/phase-01.md:328:+    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1137:./docs/superpowers/reviews/codex/phase-01.md:419:+export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1150:./docs/superpowers/reviews/codex/phase-01.md:1353:     7	export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-03.md:2173:export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-03.md:2315:  validateAttachedFolder,
./docs/superpowers/reviews/codex/phase-03.md:2325:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2326:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2330:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2331:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2332:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2336:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:192:- Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:193:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:202:- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:204:- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:217:- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.

exec
/bin/bash -lc 'git diff ce6910a''^ ce6910a --name-status && git diff ce6910a''^ ce6910a -- apps/desktop/src/renderer apps/desktop/src/ipc apps/desktop/src/main.ts apps/desktop/src/workspaces packages/workspace-core/src --unified=40' in /home/ice/dev/dohc
 succeeded in 145ms:
M	.gitignore
M	apps/desktop/e2e/firstRunWorkspace.spec.ts
M	apps/desktop/src/ipc/bridgeContract.ts
M	apps/desktop/src/ipc/channels.ts
M	apps/desktop/src/main.ts
M	apps/desktop/src/preload.ts
M	apps/desktop/src/renderer/DesktopFirstRun.test.tsx
M	apps/desktop/src/renderer/DesktopFirstRun.tsx
M	apps/desktop/src/workspaces/WorkspaceRegistry.ts
A	apps/desktop/src/workspaces/registryStore.test.ts
A	apps/desktop/src/workspaces/registryStore.ts
M	docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
M	packages/workspace-core/src/paths.test.ts
M	packages/workspace-core/src/paths.ts
diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
index a8d543a..e947526 100644
--- a/apps/desktop/src/ipc/bridgeContract.ts
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -34,6 +34,10 @@ export type CreateLocalWorkspacePayload = z.infer<
   typeof CreateLocalWorkspacePayload
 >;
 
+export const AttachWorkspaceFolderPayload = z.object({
+  rootPath: z.string().min(1),
+});
+
 export const ListWorkspaceFilesPayload = z.object({
   workspaceId: z.string().min(1),
 });
@@ -81,6 +85,9 @@ export interface DohcDesktopBridge {
   createLocalWorkspace(
     payload: CreateLocalWorkspacePayload,
   ): Promise<WorkspaceSummary>;
+  attachWorkspaceFolder(payload: {
+    rootPath: string;
+  }): Promise<WorkspaceSummary>;
   listWorkspaceFiles(payload: {
     workspaceId: string;
   }): Promise<ListWorkspaceFilesResult>;
diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
index b2473ca..0de9127 100644
--- a/apps/desktop/src/ipc/channels.ts
+++ b/apps/desktop/src/ipc/channels.ts
@@ -4,6 +4,7 @@ export const CHANNELS = {
   getWorkspaceRegistry: "desktop:get-workspace-registry",
   getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
   createLocalWorkspace: "desktop:create-local-workspace",
+  attachWorkspaceFolder: "desktop:attach-workspace-folder",
   listWorkspaceFiles: "desktop:list-workspace-files",
   createWorkspaceFile: "desktop:create-workspace-file",
   importWorkspaceFiles: "desktop:import-workspace-files",
diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
index 26d0975..499c3e1 100644
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -1,6 +1,10 @@
-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
+import {
+  defaultWorkspaceRoot,
+  validateWorkspaceRootChoice,
+} from "@dohc/workspace-core";
 import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
 import {
+  AttachWorkspaceFolderPayload,
   CreateLocalWorkspacePayload,
   CreateWorkspaceFilePayload,
   CreateWorkspaceFileResult,
@@ -59,6 +63,11 @@ function registerIpcHandlers(): void {
 
   ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
     assertTrustedSender(event);
+    // Test seam: native dialogs cannot be driven by Playwright.
+    const testPick = process.env.DOHC_TEST_PICK_PATH;
+    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
+      return PickWorkspaceRootResult.parse(testPick);
+    }
     const result = await dialog.showOpenDialog({
       properties: ["openDirectory", "createDirectory"],
     });
@@ -78,14 +87,39 @@ function registerIpcHandlers(): void {
     );
   });
 
+  // Validates AND canonicalizes: all downstream fs/registry operations use
+  // the normalized root, so dot-segment or separator variants of the same
+  // folder cannot bypass guards or register twice.
+  function usableRoot(rootPath: string): string {
+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
+    if (!check.ok) throw new Error(check.reason);
+    return check.normalized;
+  }
+
   ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
     assertTrustedSender(event);
     const input = CreateLocalWorkspacePayload.parse(payload);
-    const created = await createWorkspaceFolder(input);
+    const created = await createWorkspaceFolder({
+      rootPath: usableRoot(input.rootPath),
+      kind: input.kind,
+    });
     registerWorkspace(created);
     return WorkspaceSummary.parse(created);
   });
 
+  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = AttachWorkspaceFolderPayload.parse(payload);
+    // Adopts an existing dohc workspace (manifest identity preserved) or
+    // turns the folder into a fresh personal workspace in place.
+    const attached = await createWorkspaceFolder({
+      rootPath: usableRoot(input.rootPath),
+      kind: "personal",
+    });
+    registerWorkspace(attached);
+    return WorkspaceSummary.parse(attached);
+  });
+
   ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
     assertTrustedSender(event);
     const input = ListWorkspaceFilesPayload.parse(payload);
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
index d0bcab9..d9be7b3 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
@@ -14,9 +14,16 @@ const bridge = {
     kind: "personal" as const,
     mode: "local-first" as const,
   })),
+  attachWorkspaceFolder: vi.fn(async () => ({
+    workspaceId: "ws-attached",
+    rootPath: "/home/ice/projects/research",
+    kind: "personal" as const,
+    mode: "local-first" as const,
+  })),
   getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
   listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
   createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
+  importWorkspaceFiles: vi.fn(async () => ({ imported: [] })),
 };
 
 beforeEach(() => {
@@ -60,6 +67,21 @@ describe("first run", () => {
     );
   });
 
+  it("attaches an existing folder as a workspace", async () => {
+    const user = userEvent.setup();
+    const onReady = vi.fn();
+    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
+    await user.click(
+      await screen.findByRole("button", { name: /open an existing folder/i }),
+    );
+    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
+      rootPath: "/home/ice/projects/research",
+    });
+    expect(onReady).toHaveBeenCalledWith(
+      expect.objectContaining({ workspaceId: "ws-attached" }),
+    );
+  });
+
   it("never requires login and never renders auth fields", async () => {
     render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
     await screen.findByText("/home/ice/dohc");
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.tsx b/apps/desktop/src/renderer/DesktopFirstRun.tsx
index 39d5793..2645be1 100644
--- a/apps/desktop/src/renderer/DesktopFirstRun.tsx
+++ b/apps/desktop/src/renderer/DesktopFirstRun.tsx
@@ -37,6 +37,19 @@ export function DesktopFirstRun(props: {
     }
   }
 
+  async function openExisting() {
+    const picked = await bridge().pickWorkspaceRoot();
+    if (!picked) return;
+    try {
+      const workspace = await bridge().attachWorkspaceFolder({
+        rootPath: picked,
+      });
+      props.onWorkspaceReady(workspace);
+    } catch (cause) {
+      setError(cause instanceof Error ? cause.message : String(cause));
+    }
+  }
+
   return (
     <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
       <div className="flex flex-col items-center gap-1">
@@ -75,6 +88,14 @@ export function DesktopFirstRun(props: {
           {creating ? "Creating…" : "Create workspace"}
         </button>
 
+        <button
+          type="button"
+          onClick={() => void openExisting()}
+          className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
+        >
+          Open an existing folder as a workspace
+        </button>
+
         {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
 
         <div className="flex items-center justify-between gap-4">
diff --git a/apps/desktop/src/workspaces/WorkspaceRegistry.ts b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
index 492c52c..68defb4 100644
--- a/apps/desktop/src/workspaces/WorkspaceRegistry.ts
+++ b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
@@ -1,12 +1,12 @@
 import { app } from "electron";
-import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { homedir } from "node:os";
-import { dirname, join } from "node:path";
+import { join } from "node:path";
 import type { CreatedWorkspace } from "./createWorkspaceFolder";
+import { createRegistryStore, type RegistryEntry } from "./registryStore";
 
-// Registry of known local workspaces. Lives in Electron userData; in test
-// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
-// formalizes attachment/duplicate rules with dedicated tests.
+// Electron wiring over the pure registry store. The registry lives in
+// userData; in test mode it lives under DOHC_TEST_HOME so E2E runs are
+// hermetic (gated on test env AND unpackaged build).
 
 function testHome(): string | null {
   return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
@@ -18,48 +18,24 @@ export function effectiveHome(): string {
   return testHome() ?? homedir();
 }
 
-function registryPath(): string {
-  const base = testHome() ?? app.getPath("userData");
-  return join(base, "dohc-workspaces.json");
-}
-
-interface RegistryFile {
-  version: 1;
-  workspaces: CreatedWorkspace[];
-}
+let cachedStore: ReturnType<typeof createRegistryStore> | null = null;
 
-function readRegistry(): RegistryFile {
-  try {
-    const parsed = JSON.parse(
-      readFileSync(registryPath(), "utf8"),
-    ) as RegistryFile;
-    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
-  } catch {
-    return { version: 1, workspaces: [] };
+function store() {
+  if (!cachedStore) {
+    const base = testHome() ?? app.getPath("userData");
+    cachedStore = createRegistryStore(join(base, "dohc-workspaces.json"));
   }
+  return cachedStore;
 }
 
-function writeRegistry(registry: RegistryFile): void {
-  mkdirSync(dirname(registryPath()), { recursive: true });
-  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
-}
-
-export function listWorkspaces(): CreatedWorkspace[] {
-  return readRegistry().workspaces;
+export function listWorkspaces(): RegistryEntry[] {
+  return store().list();
 }
 
 export function registerWorkspace(workspace: CreatedWorkspace): void {
-  const registry = readRegistry();
-  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
-    return;
-  }
-  registry.workspaces.push(workspace);
-  writeRegistry(registry);
+  store().register(workspace);
 }
 
-export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
-  return (
-    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
-    null
-  );
+export function findWorkspace(workspaceId: string): RegistryEntry | null {
+  return store().find(workspaceId);
 }
diff --git a/apps/desktop/src/workspaces/registryStore.test.ts b/apps/desktop/src/workspaces/registryStore.test.ts
new file mode 100644
index 0000000..3e62d41
--- /dev/null
+++ b/apps/desktop/src/workspaces/registryStore.test.ts
@@ -0,0 +1,73 @@
+import { mkdtemp } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { beforeEach, describe, expect, it } from "vitest";
+import { createRegistryStore } from "./registryStore";
+
+let store: ReturnType<typeof createRegistryStore>;
+
+const personal = {
+  workspaceId: "ws-1",
+  rootPath: "/home/ice/dohc/personal",
+  kind: "personal" as const,
+  mode: "local-first" as const,
+};
+
+beforeEach(async () => {
+  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
+  store = createRegistryStore(join(dir, "workspaces.json"));
+});
+
+describe("registry store", () => {
+  it("supports multiple attached folders", () => {
+    store.register(personal);
+    store.register({
+      workspaceId: "ws-2",
+      rootPath: "/mnt/data/research",
+      kind: "personal",
+      mode: "local-first",
+    });
+    expect(store.list()).toHaveLength(2);
+  });
+
+  it("rejects duplicate folder attachment", () => {
+    store.register(personal);
+    expect(() =>
+      store.register({ ...personal, workspaceId: "ws-other" }),
+    ).toThrow(/already attached/i);
+  });
+
+  it("rejects a second root carrying an already-registered workspace identity", () => {
+    store.register(personal);
+    expect(() =>
+      store.register({ ...personal, rootPath: "/home/ice/dohc/personal-copy" }),
+    ).toThrow(/identity .* already attached|already attached .* identity/i);
+  });
+
+  it("persists across store instances", () => {
+    store.register(personal);
+    const reopened = createRegistryStore(store.registryFile);
+    expect(reopened.find("ws-1")?.rootPath).toBe(personal.rootPath);
+  });
+
+  it("local-only workspaces carry no account or remote identity", () => {
+    store.register(personal);
+    const entry = store.find("ws-1");
+    expect(entry).toBeTruthy();
+    expect(entry && "remote" in entry && entry.remote).toBeFalsy();
+  });
+
+  it("records remote identity only when sync is explicitly enabled", () => {
+    store.register({ ...personal, kind: "shared", mode: "cloud-first-local-copy" });
+    expect(store.find("ws-1")?.remote).toBeUndefined();
+
+    store.setRemote("ws-1", {
+      serverUrl: "https://cloud.dohc.example",
+      remoteWorkspaceId: "rw-99",
+    });
+    expect(store.find("ws-1")?.remote).toEqual({
+      serverUrl: "https://cloud.dohc.example",
+      remoteWorkspaceId: "rw-99",
+    });
+  });
+});
diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
new file mode 100644
index 0000000..19b9714
--- /dev/null
+++ b/apps/desktop/src/workspaces/registryStore.ts
@@ -0,0 +1,79 @@
+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { dirname } from "node:path";
+import type { CreatedWorkspace } from "./createWorkspaceFolder";
+
+// Pure registry persistence: a JSON file of known local workspaces. The
+// electron wiring (userData path, test-home seam) lives in
+// WorkspaceRegistry.ts; this module is unit-testable with a temp file.
+
+export interface RemoteIdentity {
+  serverUrl: string;
+  remoteWorkspaceId: string;
+}
+
+export interface RegistryEntry extends CreatedWorkspace {
+  // Present only after the user explicitly enables cloud sync (Phase 9).
+  remote?: RemoteIdentity;
+}
+
+interface RegistryFile {
+  version: 1;
+  workspaces: RegistryEntry[];
+}
+
+export function createRegistryStore(registryFile: string) {
+  function read(): RegistryFile {
+    try {
+      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
+      return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
+    } catch {
+      return { version: 1, workspaces: [] };
+    }
+  }
+
+  function write(registry: RegistryFile): void {
+    mkdirSync(dirname(registryFile), { recursive: true });
+    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
+  }
+
+  return {
+    registryFile,
+
+    list(): RegistryEntry[] {
+      return read().workspaces;
+    },
+
+    find(workspaceId: string): RegistryEntry | null {
+      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
+    },
+
+    register(workspace: RegistryEntry): void {
+      const registry = read();
+      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
+        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
+      }
+      // Two roots with one workspaceId would make file operations silently
+      // target whichever registered first (e.g., attaching a copied folder).
+      if (
+        registry.workspaces.some(
+          (w) => w.workspaceId === workspace.workspaceId,
+        )
+      ) {
+        throw new Error(
+          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
+            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
+        );
+      }
+      registry.workspaces.push(workspace);
+      write(registry);
+    },
+
+    setRemote(workspaceId: string, remote: RemoteIdentity): void {
+      const registry = read();
+      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
+      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
+      entry.remote = remote;
+      write(registry);
+    },
+  };
+}
diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
index 68d58a0..41c0ffa 100644
--- a/packages/workspace-core/src/paths.test.ts
+++ b/packages/workspace-core/src/paths.test.ts
@@ -106,6 +106,54 @@ describe("path traversal", () => {
   });
 });
 
+describe("workspace root choice", () => {
+  it("accepts ordinary folders, including outside the default root", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    expect(
+      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
+    ).toBe(true);
+    expect(
+      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
+    ).toBe(true);
+  });
+
+  it("rejects the filesystem root and the home directory itself", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    for (const dangerous of ["/", "/home/ice", "/home/ice/", "C:\\", "C:/"]) {
+      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
+      expect(result.ok).toBe(false);
+    }
+  });
+
+  it("rejects dot-segment disguises of root and home", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    for (const disguised of [
+      "/.",
+      "/..",
+      "/home/ice/.",
+      "/home/ice/x/..",
+      "/home/./ice",
+    ]) {
+      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
+      expect(result.ok).toBe(false);
+    }
+  });
+
+  it("returns the normalized root so equality checks are canonical", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    const result = validateWorkspaceRootChoice(
+      "/home/ice/dohc//personal/.",
+      "/home/ice",
+    );
+    expect(result).toEqual({ ok: true, normalized: "/home/ice/dohc/personal" });
+  });
+
+  it("rejects relative paths", async () => {
+    const { validateWorkspaceRootChoice } = await import("./paths");
+    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
+  });
+});
+
 describe("path classification", () => {
   it("treats .apps/<name>/app.json as visible app source", () => {
     expect(classifyPath("finance/.apps/ledger/app.json")).toEqual({
diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
index 6d8e481..d9b976f 100644
--- a/packages/workspace-core/src/paths.ts
+++ b/packages/workspace-core/src/paths.ts
@@ -59,6 +59,54 @@ export function validateUserWritePath(relativePath: string): WritePathValidation
   return { ok: true, normalized };
 }
 
+// Lexical normalization: resolves "." and ".." segments and separator noise
+// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
+// cannot slip past string comparisons. Preserves drive and UNC prefixes.
+export function normalizeAbsolutePath(path: string): string {
+  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
+  const rest = drive ? path.slice(drive.length) : path;
+  const unc = rest.startsWith("\\\\") || rest.startsWith("//");
+  const segments = rest.replaceAll("\\", "/").split("/");
+  const out: string[] = [];
+  for (const segment of segments) {
+    if (segment === "" || segment === ".") continue;
+    if (segment === "..") {
+      out.pop();
+      continue;
+    }
+    out.push(segment);
+  }
+  const prefix = unc ? "//" : "/";
+  const joined = `${drive}${prefix}${out.join("/")}`;
+  const trimmed = joined.replace(/\/+$/, "");
+  return trimmed || (drive ? drive : "/");
+}
+
+export type RootChoiceValidation =
+  | { ok: true; normalized: string }
+  | { ok: false; reason: string };
+
+// Registry policy: a workspace root must be a real folder choice — never the
+// filesystem root or the home directory itself, which would hand workspace
+// file operations the user's entire disk or home. Callers must use the
+// returned normalized path so registry equality checks are canonical.
+export function validateWorkspaceRootChoice(
+  rootPath: string,
+  homeDir: string,
+): RootChoiceValidation {
+  const attached = validateAttachedFolder(rootPath);
+  if (!attached.ok) return attached;
+  const normalized = normalizeAbsolutePath(rootPath);
+  const home = normalizeAbsolutePath(homeDir);
+  if (normalized === "/" || /^[A-Za-z]:$/.test(normalized) || normalized === "//") {
+    return { ok: false, reason: "workspace root cannot be the filesystem root" };
+  }
+  if (normalized === home) {
+    return { ok: false, reason: "workspace root cannot be the home directory itself" };
+  }
+  return { ok: true, normalized };
+}
+
 export type PathClassification =
   | { kind: "app-source"; appName: string }
   | { kind: "database" }

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/renderer/DesktopFirstRun.tsx && printf '\\n--- bridge.ts ---\\n' && sed -n '1,160p' apps/desktop/src/renderer/bridge.ts && printf '\\n--- root index exports ---\\n' && sed -n '1,160p' packages/workspace-core/src/index.ts" in /home/ice/dev/dohc
 succeeded in 131ms:
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

--- bridge.ts ---
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

--- root index exports ---
export * from "./workspaceMode";
export * from "./metadata";
export * from "./paths";
export * from "./changeSet";
export * from "./conflicts";

exec
/bin/bash -lc "cat package.json && printf '\\n--- desktop package ---\\n' && cat apps/desktop/package.json && printf '\\n--- tsconfig desktop ---\\n' && cat apps/desktop/tsconfig.json" in /home/ice/dev/dohc
 succeeded in 116ms:
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

--- desktop package ---
{
  "name": "@dohc/desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@electron/fuses": "^2.1.2",
    "@tailwindcss/vite": "^4.3.0",
    "@testing-library/dom": "^10.4.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.19.19",
    "@types/react": "^19.2.15",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "electron": "^42.4.0",
    "electron-builder": "^26.15.2",
    "electron-vite": "^5.0.0",
    "jsdom": "^29.1.1",
    "tailwindcss": "^4.3.0",
    "typescript": "^5.9.3",
    "vite": "^8.0.14",
    "vitest": "^2.1.9"
  },
  "dependencies": {
    "@dohc/brand": "workspace:*",
    "@dohc/workspace-core": "workspace:*",
    "electron-updater": "^6.8.9",
    "lucide-react": "^1.16.0",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "zod": "^3.25.76"
  }
}

--- tsconfig desktop ---
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "electron.vite.config.ts", "playwright.config.ts"]
}

exec
/bin/bash -lc 'git show ce6910a''^:apps/desktop/src/workspaces/WorkspaceRegistry.ts && printf '"'\\n--- parent createWorkspaceFolder ---\\n' && git show ce6910a"'^:apps/desktop/src/workspaces/createWorkspaceFolder.ts && printf '"'\\n--- parent paths ---\\n' && git show ce6910a"'^:packages/workspace-core/src/paths.ts' in /home/ice/dev/dohc
 succeeded in 118ms:
import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Registry of known local workspaces. Lives in Electron userData; in test
// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
// formalizes attachment/duplicate rules with dedicated tests.

function testHome(): string | null {
  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
    ? (process.env.DOHC_TEST_HOME ?? null)
    : null;
}

export function effectiveHome(): string {
  return testHome() ?? homedir();
}

function registryPath(): string {
  const base = testHome() ?? app.getPath("userData");
  return join(base, "dohc-workspaces.json");
}

interface RegistryFile {
  version: 1;
  workspaces: CreatedWorkspace[];
}

function readRegistry(): RegistryFile {
  try {
    const parsed = JSON.parse(
      readFileSync(registryPath(), "utf8"),
    ) as RegistryFile;
    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
  } catch {
    return { version: 1, workspaces: [] };
  }
}

function writeRegistry(registry: RegistryFile): void {
  mkdirSync(dirname(registryPath()), { recursive: true });
  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

export function listWorkspaces(): CreatedWorkspace[] {
  return readRegistry().workspaces;
}

export function registerWorkspace(workspace: CreatedWorkspace): void {
  const registry = readRegistry();
  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
    return;
  }
  registry.workspaces.push(workspace);
  writeRegistry(registry);
}

export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
  return (
    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
    null
  );
}

--- parent createWorkspaceFolder ---
import {
  createWorkspaceManifest,
  defaultWorkspaceMode,
  validateAttachedFolder,
  type WorkspaceKind,
  type WorkspaceManifest,
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

async function readExistingManifest(
  rootPath: string,
): Promise<WorkspaceManifest | null> {
  try {
    const raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as WorkspaceManifest;
    return parsed.version === 1 && typeof parsed.workspaceId === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
}): Promise<CreatedWorkspace> {
  const folderCheck = validateAttachedFolder(input.rootPath);
  if (!folderCheck.ok) {
    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
  }

  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  const existing = await readExistingManifest(input.rootPath);
  if (existing) {
    return {
      workspaceId: existing.workspaceId,
      rootPath: input.rootPath,
      kind: existing.kind === "cloud-only" ? input.kind : existing.kind,
      mode: existing.mode,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: randomUUID(),
    kind: input.kind,
  });

  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
  await mkdir(join(input.rootPath, ".context"), { recursive: true });
  await writeFile(
    join(input.rootPath, ".dohc", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
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

--- parent paths ---
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

exec
/bin/bash -lc "git ls-files apps/desktop/dist/main/main.js apps/desktop/dist/preload/preload.js apps/desktop/dist/renderer/index.html | cat && ls apps/desktop/dist/main 2>/dev/null | head && grep -n \"attachWorkspaceFolder\\|attach-workspace\" -n apps/desktop/dist/main/main.js apps/desktop/dist/preload/preload.js 2>/dev/null || true" in /home/ice/dev/dohc
 succeeded in 135ms:
main.js
apps/desktop/dist/main/main.js:203:	attachWorkspaceFolder: "desktop:attach-workspace-folder",
apps/desktop/dist/main/main.js:526:	ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/renderer/App.tsx 2>/dev/null || ls apps/desktop/src/renderer && grep -R \"getWorkspaceRegistry\\|WorkspaceRegistry\\|DesktopFirstRun\\|WorkspaceShell\" -n apps/desktop/src/renderer | head -100" in /home/ice/dev/dohc
 succeeded in 144ms:
CommandPalette.tsx
DesktopFirstRun.test.tsx
DesktopFirstRun.tsx
DesktopRoot.tsx
DesktopWorkspaceShell.tsx
NewFileDialog.tsx
bridge.ts
index.html
main.tsx
styles.css
theme.ts
apps/desktop/src/renderer/DesktopFirstRun.tsx:4:import type { Workspace } from "./DesktopWorkspaceShell";
apps/desktop/src/renderer/DesktopFirstRun.tsx:8:export function DesktopFirstRun(props: {
apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:31:export function DesktopWorkspaceShell(props: {
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:5:import { DesktopFirstRun } from "./DesktopFirstRun";
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:23:  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:41:    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:47:    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:58:    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:73:    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:86:    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:94:    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:102:    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:119:    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
apps/desktop/src/renderer/DesktopRoot.tsx:3:import { DesktopFirstRun } from "./DesktopFirstRun";
apps/desktop/src/renderer/DesktopRoot.tsx:4:import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
apps/desktop/src/renderer/DesktopRoot.tsx:13:      .getWorkspaceRegistry()
apps/desktop/src/renderer/DesktopRoot.tsx:24:      <DesktopFirstRun
apps/desktop/src/renderer/DesktopRoot.tsx:33:    <DesktopWorkspaceShell

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/renderer/DesktopRoot.tsx && printf '\\n--- shell ---\\n' && sed -n '1,320p' apps/desktop/src/renderer/DesktopWorkspaceShell.tsx" in /home/ice/dev/dohc
 succeeded in 118ms:
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

--- shell ---
import {
  Bot,
  Check,
  ChevronsUpDown,
  Cloud,
  Database,
  FilePlus2,
  FileText,
  Import,
  LayoutGrid,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { CommandPalette, type Command } from "./CommandPalette";
import { NewFileDialog } from "./NewFileDialog";
import { toggleTheme } from "./theme";

export type Workspace = WorkspaceSummary;

function workspaceName(workspace: Workspace): string {
  return workspace.rootPath.split("/").pop() ?? "workspace";
}

function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
  if (kind === "database") return <Database size={13} aria-hidden />;
  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
  return <FileText size={13} aria-hidden />;
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);

  const importFiles = useCallback(async () => {
    await bridge().importWorkspaceFiles({
      workspaceId: props.workspace.workspaceId,
    });
    const result = await bridge().listWorkspaceFiles({
      workspaceId: props.workspace.workspaceId,
    });
    setFiles(result.files);
  }, [props.workspace.workspaceId]);

  const refreshFiles = useCallback(async () => {
    const result = await bridge().listWorkspaceFiles({
      workspaceId: props.workspace.workspaceId,
    });
    setFiles(result.files);
  }, [props.workspace.workspaceId]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === "n") {
        event.preventDefault();
        setNewFileOpen(true);
      } else if (event.key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "p") {
        event.preventDefault();
        setQuickOpenOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "new-file",
        label: "New file",
        run: () => setNewFileOpen(true),
      },
      {
        id: "quick-open",
        label: "Go to file",
        run: () => setQuickOpenOpen(true),
      },
      {
        id: "import-files",
        label: "Import files into workspace",
        run: () => void importFiles(),
      },
      {
        id: "connect-cloud",
        label: "Connect dohc Cloud",
        run: () => setCloudOpen(true),
      },
      {
        id: "toggle-theme",
        label: "Toggle light/dark theme",
        run: toggleTheme,
      },
    ],
    [importFiles],
  );

  return (
    <div
      data-testid="workspace-shell"
      className="app-chrome flex h-screen flex-col bg-bg text-ink"
    >
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2">
          <header className="relative border-b border-line">
            <button
              type="button"
              data-testid="workspace-switcher"
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              onClick={() => setSwitcherOpen((open) => !open)}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-panel"
            >
              <span className="truncate text-[13px] font-semibold">
                {workspaceName(props.workspace)}
              </span>
              <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
            </button>
            {switcherOpen ? (
              <ul
                role="listbox"
                aria-label="Workspaces"
                className="absolute left-2 right-2 top-full z-20 mt-1 m-0 list-none rounded border border-line bg-panel p-1 shadow-md"
              >
                {props.workspaces.map((candidate) => (
                  <li key={candidate.workspaceId} role="option" aria-selected={candidate.workspaceId === props.workspace.workspaceId}>
                    <button
                      type="button"
                      onClick={() => {
                        setSwitcherOpen(false);
                        props.onSwitchWorkspace(candidate);
                      }}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-muted hover:text-ink"
                    >
                      {candidate.workspaceId === props.workspace.workspaceId ? (
                        <Check size={12} aria-hidden />
                      ) : (
                        <span className="w-3" aria-hidden />
                      )}
                      <span className="truncate">{workspaceName(candidate)}</span>
                      <span className="ml-auto text-[10px] uppercase text-subtle">
                        {candidate.kind}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </header>

          <nav
            data-testid="file-tree"
            aria-label="Files"
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            {files.length === 0 ? (
              <button
                type="button"
                onClick={() => setNewFileOpen(true)}
                className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
              >
                <FilePlus2 size={13} aria-hidden />
                Create your first file
              </button>
            ) : (
              <ul className="m-0 list-none p-0">
                {files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(file.path)}
                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
                        selected === file.path
                          ? "bg-panel text-ink"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      <FileIcon kind={file.kind} />
                      <span className="truncate">{file.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>

          <footer className="flex flex-col gap-1 border-t border-line px-3 py-1.5">
            <button
              type="button"
              onClick={() => setNewFileOpen(true)}
              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
            >
              <FilePlus2 size={13} aria-hidden />
              New file
              <kbd className="ml-auto font-mono text-[10px] text-subtle">
                Ctrl N
              </kbd>
            </button>
            <button
              type="button"
              onClick={() => void importFiles()}
              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
            >
              <Import size={13} aria-hidden />
              Import files
            </button>
          </footer>
        </aside>

        {/* Main area */}
        <main className="flex min-w-0 flex-1 items-center justify-center bg-bg">
          {selected ? (
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono text-[13px] text-ink">{selected}</span>
              <span className="text-xs text-subtle">
                File editing arrives with the editor surface.
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="text-sm text-muted">
                Select a file, or create one
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setNewFileOpen(true)}
                  className="font-mono text-xs text-subtle hover:text-ink"
                >
                  Ctrl N · new file
                </button>
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  className="font-mono text-xs text-subtle hover:text-ink"
                >
                  Ctrl K · commands
                </button>
                <button
                  type="button"
                  onClick={() => setQuickOpenOpen(true)}
                  className="font-mono text-xs text-subtle hover:text-ink"
                >
                  Ctrl P · go to file
                </button>
              </div>
            </div>
          )}
        </main>

        {/* Agent activity panel */}
        <aside
          data-testid="agent-panel"
          aria-label="Agent activity"
          className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
        >
          <header className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[13px] font-semibold">
            <Bot size={14} aria-hidden />
            Agent activity
          </header>
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
            <span className="text-xs text-muted">No agent runs yet</span>
            <span className="text-[11px] text-subtle">
              Point Codex or Claude Code at this folder — changes show up here
              as a timeline.
            </span>
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3">
        <span
          data-testid="sync-status"
          className="flex items-center gap-1.5 text-[11px] text-muted"
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-success"
          />
          Local · saved
        </span>
        <button
          type="button"
          onClick={() => setCloudOpen(true)}
          className="flex items-center gap-1.5 text-[11px] text-subtle hover:text-ink"
        >
          <Cloud size={12} aria-hidden />
          Connect dohc Cloud
        </button>
      </footer>

      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {quickOpenOpen ? (
        <CommandPalette
          testId="quick-open"
          placeholder="Go to file…"

exec
/bin/bash -lc "sed -n '320,640p' apps/desktop/src/renderer/DesktopWorkspaceShell.tsx" in /home/ice/dev/dohc
 succeeded in 114ms:
          placeholder="Go to file…"
          ariaLabel="File"
          commands={files.map((file) => ({
            id: file.path,
            label: file.path,
            run: () => setSelected(file.path),
          }))}
          onClose={() => setQuickOpenOpen(false)}
        />
      ) : null}
      {newFileOpen ? (
        <NewFileDialog
          workspaceId={props.workspace.workspaceId}
          onClose={() => setNewFileOpen(false)}
          onCreated={() => {
            setNewFileOpen(false);
            void refreshFiles();
          }}
        />
      ) : null}
      {cloudOpen ? (
        <div
          className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
          onClick={() => setCloudOpen(false)}
        >
          <div
            data-testid="cloud-sync-panel"
            className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
              <Cloud size={14} aria-hidden />
              dohc Cloud
            </h2>
            <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
              Cloud sync brings sharing, backup, and team workspaces. It
              arrives with dohc Cloud accounts — this workspace stays fully
              functional locally, and you can connect it then without moving
              anything.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

exec
/bin/bash -lc "nl -ba packages/workspace-core/src/paths.ts | sed -n '55,105p' && nl -ba apps/desktop/src/renderer/DesktopFirstRun.tsx | sed -n '30,105p' && nl -ba apps/desktop/src/workspaces/registryStore.ts | sed -n '35,75p'" in /home/ice/dev/dohc
 succeeded in 120ms:
    55	    .filter((segment) => segment !== "" && segment !== ".")
    56	    .join("/");
    57	  if (normalized.length === 0) return { ok: false, reason: "invalid" };
    58	  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
    59	  return { ok: true, normalized };
    60	}
    61	
    62	// Lexical normalization: resolves "." and ".." segments and separator noise
    63	// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
    64	// cannot slip past string comparisons. Preserves drive and UNC prefixes.
    65	export function normalizeAbsolutePath(path: string): string {
    66	  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
    67	  const rest = drive ? path.slice(drive.length) : path;
    68	  const unc = rest.startsWith("\\\\") || rest.startsWith("//");
    69	  const segments = rest.replaceAll("\\", "/").split("/");
    70	  const out: string[] = [];
    71	  for (const segment of segments) {
    72	    if (segment === "" || segment === ".") continue;
    73	    if (segment === "..") {
    74	      out.pop();
    75	      continue;
    76	    }
    77	    out.push(segment);
    78	  }
    79	  const prefix = unc ? "//" : "/";
    80	  const joined = `${drive}${prefix}${out.join("/")}`;
    81	  const trimmed = joined.replace(/\/+$/, "");
    82	  return trimmed || (drive ? drive : "/");
    83	}
    84	
    85	export type RootChoiceValidation =
    86	  | { ok: true; normalized: string }
    87	  | { ok: false; reason: string };
    88	
    89	// Registry policy: a workspace root must be a real folder choice — never the
    90	// filesystem root or the home directory itself, which would hand workspace
    91	// file operations the user's entire disk or home. Callers must use the
    92	// returned normalized path so registry equality checks are canonical.
    93	export function validateWorkspaceRootChoice(
    94	  rootPath: string,
    95	  homeDir: string,
    96	): RootChoiceValidation {
    97	  const attached = validateAttachedFolder(rootPath);
    98	  if (!attached.ok) return attached;
    99	  const normalized = normalizeAbsolutePath(rootPath);
   100	  const home = normalizeAbsolutePath(homeDir);
   101	  if (normalized === "/" || /^[A-Za-z]:$/.test(normalized) || normalized === "//") {
   102	    return { ok: false, reason: "workspace root cannot be the filesystem root" };
   103	  }
   104	  if (normalized === home) {
   105	    return { ok: false, reason: "workspace root cannot be the home directory itself" };
    30	        rootPath: `${root}/personal`,
    31	        kind: "personal",
    32	      });
    33	      props.onWorkspaceReady(workspace);
    34	    } catch (cause) {
    35	      setError(cause instanceof Error ? cause.message : String(cause));
    36	      setCreating(false);
    37	    }
    38	  }
    39	
    40	  async function openExisting() {
    41	    const picked = await bridge().pickWorkspaceRoot();
    42	    if (!picked) return;
    43	    try {
    44	      const workspace = await bridge().attachWorkspaceFolder({
    45	        rootPath: picked,
    46	      });
    47	      props.onWorkspaceReady(workspace);
    48	    } catch (cause) {
    49	      setError(cause instanceof Error ? cause.message : String(cause));
    50	    }
    51	  }
    52	
    53	  return (
    54	    <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
    55	      <div className="flex flex-col items-center gap-1">
    56	        <h1 className="m-0 text-2xl font-semibold tracking-tight">dohc</h1>
    57	        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
    58	      </div>
    59	
    60	      <div className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
    61	        <div className="flex flex-col gap-1">
    62	          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
    63	            Workspace location
    64	          </span>
    65	          <div className="flex items-start justify-between gap-2">
    66	            {/* The whole point of this screen is where files live: never
    67	                truncate the path. */}
    68	            <code className="break-all font-mono text-[13px] leading-snug text-ink">
    69	              {root ?? "…"}
    70	            </code>
    71	            <button
    72	              type="button"
    73	              onClick={() => void chooseFolder()}
    74	              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
    75	            >
    76	              <FolderOpen size={13} aria-hidden />
    77	              Choose a different folder
    78	            </button>
    79	          </div>
    80	        </div>
    81	
    82	        <button
    83	          type="button"
    84	          disabled={!root || creating}
    85	          onClick={() => void createWorkspace()}
    86	          className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
    87	        >
    88	          {creating ? "Creating…" : "Create workspace"}
    89	        </button>
    90	
    91	        <button
    92	          type="button"
    93	          onClick={() => void openExisting()}
    94	          className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
    95	        >
    96	          Open an existing folder as a workspace
    97	        </button>
    98	
    99	        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
   100	
   101	        <div className="flex items-center justify-between gap-4">
   102	          <p className="m-0 text-xs text-subtle">
   103	            Works offline, no account needed. Cloud sync is optional.
   104	          </p>
   105	          <button
    35	    mkdirSync(dirname(registryFile), { recursive: true });
    36	    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
    37	  }
    38	
    39	  return {
    40	    registryFile,
    41	
    42	    list(): RegistryEntry[] {
    43	      return read().workspaces;
    44	    },
    45	
    46	    find(workspaceId: string): RegistryEntry | null {
    47	      return read().workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
    48	    },
    49	
    50	    register(workspace: RegistryEntry): void {
    51	      const registry = read();
    52	      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
    53	        throw new Error(`Folder is already attached: ${workspace.rootPath}`);
    54	      }
    55	      // Two roots with one workspaceId would make file operations silently
    56	      // target whichever registered first (e.g., attaching a copied folder).
    57	      if (
    58	        registry.workspaces.some(
    59	          (w) => w.workspaceId === workspace.workspaceId,
    60	        )
    61	      ) {
    62	        throw new Error(
    63	          `This folder carries the identity of an already attached workspace (${workspace.workspaceId}). ` +
    64	            `If this is a copy, remove its .dohc folder to attach it as a new workspace.`,
    65	        );
    66	      }
    67	      registry.workspaces.push(workspace);
    68	      write(registry);
    69	    },
    70	
    71	    setRemote(workspaceId: string, remote: RemoteIdentity): void {
    72	      const registry = read();
    73	      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
    74	      if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);
    75	      entry.remote = remote;

exec
/bin/bash -lc "sed -n '1,160p' apps/desktop/src/renderer/DesktopFirstRun.test.tsx" in /home/ice/dev/dohc
 succeeded in 110ms:
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFirstRun } from "./DesktopFirstRun";

const bridge = {
  getVersion: vi.fn(async () => "0.1.0"),
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
/bin/bash -lc "sed -n '1,160p' packages/workspace-core/src/workspaceMode.ts && sed -n '1,160p' packages/workspace-core/src/metadata.ts" in /home/ice/dev/dohc
 succeeded in 109ms:
export type WorkspaceMode =
  | "local-first"
  | "cloud-first-local-copy"
  | "cloud-only";

export type WorkspaceKind = "personal" | "shared" | "cloud-only";

const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
  personal: "local-first",
  shared: "cloud-first-local-copy",
  "cloud-only": "cloud-only",
};

export function defaultWorkspaceMode(kind: WorkspaceKind): WorkspaceMode {
  return DEFAULT_MODE_BY_KIND[kind];
}
import {
  defaultWorkspaceMode,
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

export interface FileRecord {
  path: string;
  contentHash: string;
}

export function createFileRecord(input: FileRecord): FileRecord {
  return { path: input.path, contentHash: input.contentHash };
}

exec
/bin/bash -lc "sed -n '1,180p' docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md 2>/dev/null || true && printf '\\n--- phase04 review head ---\\n' && sed -n '1,140p' docs/superpowers/reviews/codex/phase-04.md 2>/dev/null || true" in /home/ice/dev/dohc
 succeeded in 115ms:
Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 019eb126-cfdb-7560-b551-4b872b5e348e
--------
user
Read apps/desktop/src/ipc/, apps/desktop/src/preload.ts, apps/desktop/src/main.ts, apps/desktop/src/security/electronSecurity.ts, apps/desktop/src/workspaces/ and their existing tests in this repo. ENUMERATE concrete attack scenarios (inputs, exact call sequence, expected invariant violation) designed to BREAK: IPC payload validation, sender checks, workspace path scoping (createWorkspaceFile/listWorkspaceFiles/importWorkspaceFiles/attachWorkspaceFolder), and the workspace-root guard — malformed/oversized payloads, prototype pollution via JSON, traversal variants the current normalization might miss, symlinks, registry poisoning, race conditions. Output ONLY scenario descriptions as a numbered list (no test code, no repo writes). Mark each with which existing test file SHOULD cover it and whether you believe it currently does.
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
codex
I’ll inspect the desktop IPC, preload, main, security, workspace modules, and existing tests, then map concrete break scenarios to the closest current test files. No repo writes.
exec
/bin/bash -lc 'find apps/desktop/src/ipc apps/desktop/src/workspaces -maxdepth 3 -type f | sort' in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/src/ipc/bridgeContract.ts
apps/desktop/src/ipc/channels.ts
apps/desktop/src/workspaces/WorkspaceRegistry.ts
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
apps/desktop/src/workspaces/createWorkspaceFolder.ts
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/registryStore.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/workspaceFiles.ts

exec
/bin/bash -lc "rg --files apps/desktop/src/ipc apps/desktop/src/workspaces apps/desktop/src | rg '("'^apps/desktop/src/(preload|main)'"\\.ts"'$|electronSecurity'"\\.ts"'$|(__tests__|'"\\.test\\.|\\.spec\\.))'" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
apps/desktop/src/preload.ts
apps/desktop/src/main.ts
apps/desktop/src/renderer/DesktopFirstRun.test.tsx
apps/desktop/src/security/electronSecurity.test.ts
apps/desktop/src/security/electronSecurity.ts
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts

exec
/bin/bash -lc "rg -n \"createWorkspaceFile|listWorkspaceFiles|importWorkspaceFiles|attachWorkspaceFolder|workspace-root|workspace root|ipcMain|ipcRenderer|handle\\(|contextBridge|validate|sender|webContents|isDescendant|symlink|realpath|normalize|resolve|registry|prototype|__proto__|constructor\" apps/desktop/src/preload.ts apps/desktop/src/main.ts apps/desktop/src/security/electronSecurity.ts apps/desktop/src/ipc apps/desktop/src/workspaces" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
apps/desktop/src/main.ts:5:import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
apps/desktop/src/main.ts:52:  const frameUrl = event.senderFrame?.url ?? "";
apps/desktop/src/main.ts:54:    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
apps/desktop/src/main.ts:59:  ipcMain.handle(CHANNELS.getVersion, (event) => {
apps/desktop/src/main.ts:64:  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
apps/desktop/src/main.ts:78:  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
apps/desktop/src/main.ts:83:  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
apps/desktop/src/main.ts:90:  // Validates AND canonicalizes: all downstream fs/registry operations use
apps/desktop/src/main.ts:91:  // the normalized root, so dot-segment or separator variants of the same
apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
apps/desktop/src/main.ts:96:    return check.normalized;
apps/desktop/src/main.ts:99:  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
apps/desktop/src/main.ts:110:  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
apps/desktop/src/main.ts:123:  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
apps/desktop/src/main.ts:132:  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
apps/desktop/src/main.ts:140:  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
apps/desktop/src/main.ts:154:  ipcMain.on(CHANNELS.firstPaint, (event) => {
apps/desktop/src/main.ts:155:    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
apps/desktop/src/main.ts:163:    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
apps/desktop/src/security/electronSecurity.ts:78:export function validateDevServerUrl(
apps/desktop/src/preload.ts:1:import { contextBridge, ipcRenderer } from "electron";
apps/desktop/src/preload.ts:5:// typed operations — never raw ipcRenderer, never Node.
apps/desktop/src/preload.ts:6:contextBridge.exposeInMainWorld("dohcDesktop", {
apps/desktop/src/preload.ts:7:  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
apps/desktop/src/preload.ts:8:  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
apps/desktop/src/preload.ts:9:  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
apps/desktop/src/preload.ts:11:    ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
apps/desktop/src/preload.ts:13:    ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
apps/desktop/src/preload.ts:14:  attachWorkspaceFolder: (payload: { rootPath: string }) =>
apps/desktop/src/preload.ts:15:    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
apps/desktop/src/preload.ts:16:  listWorkspaceFiles: (payload: { workspaceId: string }) =>
apps/desktop/src/preload.ts:17:    ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
apps/desktop/src/preload.ts:18:  createWorkspaceFile: (payload: {
apps/desktop/src/preload.ts:21:  }) => ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
apps/desktop/src/preload.ts:22:  importWorkspaceFiles: (payload: { workspaceId: string }) =>
apps/desktop/src/preload.ts:23:    ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
apps/desktop/src/preload.ts:27:contextBridge.exposeInMainWorld("dohcDesktopInternal", {
apps/desktop/src/preload.ts:28:  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
apps/desktop/src/preload.ts:32:  contextBridge.exposeInMainWorld("dohcDesktopTest", {
apps/desktop/src/preload.ts:33:    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
apps/desktop/src/ipc/channels.ts:3:  pickWorkspaceRoot: "desktop:pick-workspace-root",
apps/desktop/src/ipc/channels.ts:4:  getWorkspaceRegistry: "desktop:get-workspace-registry",
apps/desktop/src/ipc/channels.ts:5:  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
apps/desktop/src/ipc/channels.ts:7:  attachWorkspaceFolder: "desktop:attach-workspace-folder",
apps/desktop/src/ipc/channels.ts:8:  listWorkspaceFiles: "desktop:list-workspace-files",
apps/desktop/src/ipc/channels.ts:9:  createWorkspaceFile: "desktop:create-workspace-file",
apps/desktop/src/ipc/channels.ts:10:  importWorkspaceFiles: "desktop:import-workspace-files",
apps/desktop/src/ipc/bridgeContract.ts:4:// handlers validate results against these before returning them. Payload
apps/desktop/src/ipc/bridgeContract.ts:88:  attachWorkspaceFolder(payload: {
apps/desktop/src/ipc/bridgeContract.ts:91:  listWorkspaceFiles(payload: {
apps/desktop/src/ipc/bridgeContract.ts:94:  createWorkspaceFile(payload: {
apps/desktop/src/ipc/bridgeContract.ts:98:  importWorkspaceFiles(payload: {
apps/desktop/src/workspaces/registryStore.test.ts:5:import { createRegistryStore } from "./registryStore";
apps/desktop/src/workspaces/registryStore.test.ts:17:  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
apps/desktop/src/workspaces/registryStore.test.ts:21:describe("registry store", () => {
apps/desktop/src/workspaces/registryStore.test.ts:49:    const reopened = createRegistryStore(store.registryFile);
apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
apps/desktop/src/workspaces/createWorkspaceFolder.ts:45:    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
apps/desktop/src/workspaces/workspaceFiles.test.ts:14:  it("creates nested files through validated paths", async () => {
apps/desktop/src/workspaces/workspaceFiles.test.ts:48:  it("copies external files into the workspace root by basename", async () => {
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:54:  it("rejects relative workspace roots", async () => {
apps/desktop/src/workspaces/registryStore.ts:5:// Pure registry persistence: a JSON file of known local workspaces. The
apps/desktop/src/workspaces/registryStore.ts:24:export function createRegistryStore(registryFile: string) {
apps/desktop/src/workspaces/registryStore.ts:27:      const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as RegistryFile;
apps/desktop/src/workspaces/registryStore.ts:34:  function write(registry: RegistryFile): void {
apps/desktop/src/workspaces/registryStore.ts:35:    mkdirSync(dirname(registryFile), { recursive: true });
apps/desktop/src/workspaces/registryStore.ts:36:    writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
apps/desktop/src/workspaces/registryStore.ts:40:    registryFile,
apps/desktop/src/workspaces/registryStore.ts:51:      const registry = read();
apps/desktop/src/workspaces/registryStore.ts:52:      if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
apps/desktop/src/workspaces/registryStore.ts:58:        registry.workspaces.some(
apps/desktop/src/workspaces/registryStore.ts:67:      registry.workspaces.push(workspace);
apps/desktop/src/workspaces/registryStore.ts:68:      write(registry);
apps/desktop/src/workspaces/registryStore.ts:72:      const registry = read();
apps/desktop/src/workspaces/registryStore.ts:73:      const entry = registry.workspaces.find((w) => w.workspaceId === workspaceId);
apps/desktop/src/workspaces/registryStore.ts:76:      write(registry);
apps/desktop/src/workspaces/WorkspaceRegistry.ts:5:import { createRegistryStore, type RegistryEntry } from "./registryStore";
apps/desktop/src/workspaces/WorkspaceRegistry.ts:7:// Electron wiring over the pure registry store. The registry lives in
apps/desktop/src/workspaces/workspaceFiles.ts:3:  validateUserWritePath,
apps/desktop/src/workspaces/workspaceFiles.ts:44:  const validated = validateUserWritePath(relativePath);
apps/desktop/src/workspaces/workspaceFiles.ts:45:  if (!validated.ok) {
apps/desktop/src/workspaces/workspaceFiles.ts:46:    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
apps/desktop/src/workspaces/workspaceFiles.ts:48:  const absolute = join(rootPath, validated.normalized);
apps/desktop/src/workspaces/workspaceFiles.ts:53:  return validated.normalized;
apps/desktop/src/workspaces/workspaceFiles.ts:56:// Imports copy external files into the workspace root by basename; existing
apps/desktop/src/workspaces/workspaceFiles.ts:65:    const validated = validateUserWritePath(name);
apps/desktop/src/workspaces/workspaceFiles.ts:66:    if (!validated.ok) continue;
apps/desktop/src/workspaces/workspaceFiles.ts:68:      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
apps/desktop/src/workspaces/workspaceFiles.ts:69:      imported.push(validated.normalized);

codex
I found the relevant surface area: IPC registration lives in `main.ts`, the bridge is very thin, and file/path logic is split between `createWorkspaceFolder.ts`, `workspaceFiles.ts`, and registry storage. I’m reading the implementation and tests now to distinguish covered cases from plausible gaps.
exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/main.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import {
  defaultWorkspaceRoot,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
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
  VersionResult,
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

--- phase04 review head ---
OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb126-ac93-7232-b69c-eecfe8ed0309
--------
user
commit ce6910a
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames ce6910a' in /home/ice/dev/dohc
 succeeded in 133ms:
?? docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md
?? docs/superpowers/reviews/codex/phase-04.md
/home/ice/dev/dohc
ce6910a (HEAD -> claude/desktop-local-first-cloud-sync) phase4: Add local workspace registry
 .gitignore                                         |  1 +
 apps/desktop/e2e/firstRunWorkspace.spec.ts         | 50 +++++++++++++-
 apps/desktop/src/ipc/bridgeContract.ts             |  7 ++
 apps/desktop/src/ipc/channels.ts                   |  1 +
 apps/desktop/src/main.ts                           | 38 ++++++++++-
 apps/desktop/src/preload.ts                        |  2 +
 apps/desktop/src/renderer/DesktopFirstRun.test.tsx | 22 ++++++
 apps/desktop/src/renderer/DesktopFirstRun.tsx      | 21 ++++++
 apps/desktop/src/workspaces/WorkspaceRegistry.ts   | 56 +++++----------
 apps/desktop/src/workspaces/registryStore.test.ts  | 73 ++++++++++++++++++++
 apps/desktop/src/workspaces/registryStore.ts       | 79 ++++++++++++++++++++++
 ...desktop-local-first-cloud-sync.execution-log.md | 26 +++++++
 packages/workspace-core/src/paths.test.ts          | 48 +++++++++++++
 packages/workspace-core/src/paths.ts               | 48 +++++++++++++
 14 files changed, 429 insertions(+), 43 deletions(-)

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
 succeeded in 6717ms:
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
/bin/bash -lc "git show --find-renames --find-copies --src-prefix=a/ --dst-prefix=b/ --no-ext-diff --unified=80 ce6910a -- . ':(exclude)docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md' ':(exclude)docs/superpowers/reviews/codex/phase-04.md'" in /home/ice/dev/dohc
 succeeded in 122ms:
commit ce6910a523556d287882b9b6a5300ace79aa18c8
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:48:17 2026 +0800

    phase4: Add local workspace registry
    
    Pure registry store (multi-attach, duplicate-folder AND duplicate-
    identity rejection, remote identity only after explicit sync enable),
    attachWorkspaceFolder IPC adopting existing manifests, root-choice
    guard with lexical dot-segment/drive/UNC normalization (canonical
    paths flow through all fs/registry ops), first-run open-existing
    flow, dialog test seam. Verifier probes confirmed and closed two
    escapes pre-commit. 77 unit tests + 4 E2E green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/.gitignore b/.gitignore
index 253bb72..d660e4e 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1,12 +1,13 @@
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
+test-results/

exec
/bin/bash -lc 'tail -200 docs/superpowers/reviews/codex/phase-04.md 2>/dev/null' in /home/ice/dev/dohc
 succeeded in 118ms:
apps/desktop/src/workspaces/registryStore.ts:76:      write(registry);
apps/desktop/src/workspaces/WorkspaceRegistry.ts:5:import { createRegistryStore, type RegistryEntry } from "./registryStore";
apps/desktop/src/workspaces/WorkspaceRegistry.ts:7:// Electron wiring over the pure registry store. The registry lives in
apps/desktop/src/workspaces/workspaceFiles.ts:3:  validateUserWritePath,
apps/desktop/src/workspaces/workspaceFiles.ts:44:  const validated = validateUserWritePath(relativePath);
apps/desktop/src/workspaces/workspaceFiles.ts:45:  if (!validated.ok) {
apps/desktop/src/workspaces/workspaceFiles.ts:46:    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
apps/desktop/src/workspaces/workspaceFiles.ts:48:  const absolute = join(rootPath, validated.normalized);
apps/desktop/src/workspaces/workspaceFiles.ts:53:  return validated.normalized;
apps/desktop/src/workspaces/workspaceFiles.ts:56:// Imports copy external files into the workspace root by basename; existing
apps/desktop/src/workspaces/workspaceFiles.ts:65:    const validated = validateUserWritePath(name);
apps/desktop/src/workspaces/workspaceFiles.ts:66:    if (!validated.ok) continue;
apps/desktop/src/workspaces/workspaceFiles.ts:68:      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
apps/desktop/src/workspaces/workspaceFiles.ts:69:      imported.push(validated.normalized);

codex
I found the relevant surface area: IPC registration lives in `main.ts`, the bridge is very thin, and file/path logic is split between `createWorkspaceFolder.ts`, `workspaceFiles.ts`, and registry storage. I’m reading the implementation and tests now to distinguish covered cases from plausible gaps.
exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/main.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import {
  defaultWorkspaceRoot,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
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
  VersionResult,
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

--- phase04 review head ---
OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb126-ac93-7232-b69c-eecfe8ed0309
--------
user
commit ce6910a
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames ce6910a' in /home/ice/dev/dohc
 succeeded in 133ms:
?? docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md
?? docs/superpowers/reviews/codex/phase-04.md
/home/ice/dev/dohc
ce6910a (HEAD -> claude/desktop-local-first-cloud-sync) phase4: Add local workspace registry
 .gitignore                                         |  1 +
 apps/desktop/e2e/firstRunWorkspace.spec.ts         | 50 +++++++++++++-
 apps/desktop/src/ipc/bridgeContract.ts             |  7 ++
 apps/desktop/src/ipc/channels.ts                   |  1 +
 apps/desktop/src/main.ts                           | 38 ++++++++++-
 apps/desktop/src/preload.ts                        |  2 +
 apps/desktop/src/renderer/DesktopFirstRun.test.tsx | 22 ++++++
 apps/desktop/src/renderer/DesktopFirstRun.tsx      | 21 ++++++
 apps/desktop/src/workspaces/WorkspaceRegistry.ts   | 56 +++++----------
 apps/desktop/src/workspaces/registryStore.test.ts  | 73 ++++++++++++++++++++
 apps/desktop/src/workspaces/registryStore.ts       | 79 ++++++++++++++++++++++
 ...desktop-local-first-cloud-sync.execution-log.md | 26 +++++++
 packages/workspace-core/src/paths.test.ts          | 48 +++++++++++++
 packages/workspace-core/src/paths.ts               | 48 +++++++++++++
 14 files changed, 429 insertions(+), 43 deletions(-)

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
 succeeded in 6717ms:
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
/bin/bash -lc "git show --find-renames --find-copies --src-prefix=a/ --dst-prefix=b/ --no-ext-diff --unified=80 ce6910a -- . ':(exclude)docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md' ':(exclude)docs/superpowers/reviews/codex/phase-04.md'" in /home/ice/dev/dohc
 succeeded in 122ms:
commit ce6910a523556d287882b9b6a5300ace79aa18c8
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:48:17 2026 +0800

    phase4: Add local workspace registry
    
    Pure registry store (multi-attach, duplicate-folder AND duplicate-
    identity rejection, remote identity only after explicit sync enable),
    attachWorkspaceFolder IPC adopting existing manifests, root-choice
    guard with lexical dot-segment/drive/UNC normalization (canonical
    paths flow through all fs/registry ops), first-run open-existing
    flow, dialog test seam. Verifier probes confirmed and closed two
    escapes pre-commit. 77 unit tests + 4 E2E green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/.gitignore b/.gitignore
index 253bb72..d660e4e 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1,12 +1,13 @@
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
+test-results/

exec
/bin/bash -lc 'tail -200 docs/superpowers/reviews/codex/phase-04.md 2>/dev/null' in /home/ice/dev/dohc

exec
/bin/bash -lc "grep -n \"case\\|UNC\\|share root\\|backslash\\|home\" docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md 2>/dev/null | head -80" in /home/ice/dev/dohc
 succeeded in 116ms:
4:workdir: /home/ice/dev/dohc
19:/bin/bash -lc 'find apps/desktop/src/ipc apps/desktop/src/workspaces -maxdepth 3 -type f | sort' in /home/ice/dev/dohc
32:/bin/bash -lc "rg --files apps/desktop/src/ipc apps/desktop/src/workspaces apps/desktop/src | rg '("'^apps/desktop/src/(preload|main)'"\\.ts"'$|electronSecurity'"\\.ts"'$|(__tests__|'"\\.test\\.|\\.spec\\.))'" in /home/ice/dev/dohc
47:/bin/bash -lc "rg -n \"createWorkspaceFile|listWorkspaceFiles|importWorkspaceFiles|attachWorkspaceFolder|workspace-root|workspace root|ipcMain|ipcRenderer|handle\\(|contextBridge|validate|sender|webContents|isDescendant|symlink|realpath|normalize|resolve|registry|prototype|__proto__|constructor\" apps/desktop/src/preload.ts apps/desktop/src/main.ts apps/desktop/src/security/electronSecurity.ts apps/desktop/src/ipc apps/desktop/src/workspaces" in /home/ice/dev/dohc
142:I found the relevant surface area: IPC registration lives in `main.ts`, the bridge is very thin, and file/path logic is split between `createWorkspaceFolder.ts`, `workspaceFiles.ts`, and registry storage. I’m reading the implementation and tests now to distinguish covered cases from plausible gaps.
144:/bin/bash -lc "sed -n '1,240p' apps/desktop/src/main.ts" in /home/ice/dev/dohc
333:/bin/bash -lc "sed -n '1,220p' apps/desktop/src/preload.ts" in /home/ice/dev/dohc
372:/bin/bash -lc "sed -n '1,240p' apps/desktop/src/security/electronSecurity.ts" in /home/ice/dev/dohc
466:/bin/bash -lc "sed -n '1,240p' apps/desktop/src/ipc/bridgeContract.ts" in /home/ice/dev/dohc
468:/bin/bash -lc "sed -n '1,160p' apps/desktop/src/ipc/channels.ts" in /home/ice/dev/dohc
490:/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/createWorkspaceFolder.ts" in /home/ice/dev/dohc
492:/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/workspaceFiles.ts" in /home/ice/dev/dohc
658:/bin/bash -lc "sed -n '1,240p' apps/desktop/src/workspaces/WorkspaceRegistry.ts" in /home/ice/dev/dohc
660:/bin/bash -lc "sed -n '1,220p' apps/desktop/src/workspaces/registryStore.ts" in /home/ice/dev/dohc
662:/bin/bash -lc 'rg -n "validateWorkspaceRootChoice|validateAttachedFolder|validateUserWritePath|defaultWorkspaceRoot|workspace-core" -S .' in /home/ice/dev/dohc
665:import { homedir } from "node:os";
681:  return testHome() ?? homedir();
712:// electron wiring (userData path, test-home seam) lives in
823:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:177:- Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
827:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:192:- Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
828:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:193:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
829:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:202:- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
832:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:217:- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
834:./packages/workspace-core/src/paths.ts:1:export function defaultWorkspaceRoot(homeDir: string): string {
842:./packages/workspace-core/src/paths.test.ts:12:    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
843:./packages/workspace-core/src/paths.test.ts:16:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
858:./packages/workspace-core/src/paths.test.ts:113:      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
859:./packages/workspace-core/src/paths.test.ts:116:      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
861:./packages/workspace-core/src/paths.test.ts:123:      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
863:./packages/workspace-core/src/paths.test.ts:137:      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
867:./packages/workspace-core/src/paths.test.ts:153:    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
905:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:662:/bin/bash -lc 'rg -n "validateWorkspaceRootChoice|validateAttachedFolder|validateUserWritePath|defaultWorkspaceRoot|workspace-core" -S .' in /home/ice/dev/dohc
918:./docs/superpowers/reviews/codex/phase-04.md:1429: - Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
922:./docs/superpowers/reviews/codex/phase-04.md:1444: - Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
923:./docs/superpowers/reviews/codex/phase-04.md:1445: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
924:./docs/superpowers/reviews/codex/phase-04.md:1454:+- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
927:./docs/superpowers/reviews/codex/phase-04.md:1469:+- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
940:./docs/superpowers/reviews/codex/phase-04.md:1564:+      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
941:./docs/superpowers/reviews/codex/phase-04.md:1567:+      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
943:./docs/superpowers/reviews/codex/phase-04.md:1574:+      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
945:./docs/superpowers/reviews/codex/phase-04.md:1588:+      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
949:./docs/superpowers/reviews/codex/phase-04.md:1604:+    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
953:./docs/superpowers/reviews/codex/phase-04.md:1635: export function defaultWorkspaceRoot(homeDir: string): string {
958:./docs/superpowers/reviews/codex/phase-04.md:1764:/bin/bash -lc 'git show ce6910a -- apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/registryStore.ts apps/desktop/src/workspaces/registryStore.test.ts apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/renderer/DesktopFirstRun.tsx apps/desktop/src/renderer/DesktopFirstRun.test.tsx packages/workspace-core/src/paths.ts --unified=120' in /home/ice/dev/dohc
995:./docs/superpowers/reviews/codex/phase-03.md:2101:/bin/bash -lc "ls packages && git ls-files packages/workspace-core packages/brand apps/desktop/src | sed -n '1,200p'" in /home/ice/dev/dohc
1008:./docs/superpowers/reviews/codex/phase-03.md:2151:/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/index.ts && sed -n '1,240p' packages/workspace-core/src/paths.ts && sed -n '1,240p' packages/workspace-core/src/workspaceMode.ts && cat packages/workspace-core/package.json" in /home/ice/dev/dohc
1009:./docs/superpowers/reviews/codex/phase-03.md:2158:export function defaultWorkspaceRoot(homeDir: string): string {
1013:./docs/superpowers/reviews/codex/phase-03.md:2272:/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/metadata.ts && sed -n '1,180p' packages/workspace-core/src/paths.test.ts" in /home/ice/dev/dohc
1017:./docs/superpowers/reviews/codex/phase-03.md:2321:    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
1018:./docs/superpowers/reviews/codex/phase-03.md:2325:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
1032:./docs/superpowers/reviews/codex/phase-03.md:2442:/bin/bash -lc "grep -R \"personal\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md packages/workspace-core apps/desktop | sed -n '1,200p'" in /home/ice/dev/dohc
1088:./docs/superpowers/reviews/codex/phase-00.md:4794:/bin/bash -lc 'git status --short packages/workspace-core && git log --oneline -- packages/workspace-core/package.json | head' in /home/ice/dev/dohc
1106:./docs/superpowers/reviews/codex/phase-01.md:37:/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 67d692f -- packages/workspace-core/src packages/workspace-core/package.json packages/workspace-core/tsconfig.json pnpm-lock.yaml' in /home/ice/dev/dohc
1125:./docs/superpowers/reviews/codex/phase-01.md:319:+    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
1126:./docs/superpowers/reviews/codex/phase-01.md:323:+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
1136:./docs/superpowers/reviews/codex/phase-01.md:413:+export function defaultWorkspaceRoot(homeDir: string): string {
1148:./docs/superpowers/reviews/codex/phase-01.md:1345:/bin/bash -lc "nl -ba packages/workspace-core/src/paths.ts | sed -n '1,120p'" in /home/ice/dev/dohc
1149:./docs/superpowers/reviews/codex/phase-01.md:1347:     1	export function defaultWorkspaceRoot(homeDir: string): string {
1185:./docs/superpowers/reviews/codex/phase-01.md:2370:/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 67d692f -- packages/workspace-core/src packages/workspace-core/package.json packages/workspace-core/tsconfig.json pnpm-lock.yaml' in /home/ice/dev/dohc
1198:./docs/superpowers/reviews/codex/phase-01.md:2612:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
1199:./docs/superpowers/reviews/codex/phase-01.md:2613:  On default macOS/Windows workspaces, the filesystem is case-insensitive, so `.DOHC/manifest.json` aliases the reserved `.dohc/manifest.json`. Because this only compares the lowercase literal `.dohc`, `validateUserWritePath(".DOHC/manifest.json")` returns ok and later filesystem writes can overwrite dohc metadata the reserved-space guard is meant to protect.
1200:./docs/superpowers/reviews/codex/phase-01.md:2615:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
1201:./docs/superpowers/reviews/codex/phase-01.md:2618:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
1202:./docs/superpowers/reviews/codex/phase-01.md:2624:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
1203:./docs/superpowers/reviews/codex/phase-01.md:2625:  On default macOS/Windows workspaces, the filesystem is case-insensitive, so `.DOHC/manifest.json` aliases the reserved `.dohc/manifest.json`. Because this only compares the lowercase literal `.dohc`, `validateUserWritePath(".DOHC/manifest.json")` returns ok and later filesystem writes can overwrite dohc metadata the reserved-space guard is meant to protect.
1204:./docs/superpowers/reviews/codex/phase-01.md:2627:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
1205:./docs/superpowers/reviews/codex/phase-01.md:2630:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
1208:/bin/bash -lc "sed -n '1,220p' packages/workspace-core/src/paths.ts" in /home/ice/dev/dohc
1210:/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/paths.test.ts" in /home/ice/dev/dohc
1223:    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
1227:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
1231:  it("allows Windows absolute folders (drive and UNC)", () => {
1249:  it("reserves case-insensitive .dohc variants (case-insensitive filesystems)", () => {
1289:  it("rejects Windows drive-qualified and UNC write paths", () => {
1324:      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
1327:      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
1331:  it("rejects the filesystem root and the home directory itself", async () => {
1333:    for (const dangerous of ["/", "/home/ice", "/home/ice/", "C:\\", "C:/"]) {
1334:      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
1339:  it("rejects dot-segment disguises of root and home", async () => {

exec
/bin/bash -lc "sed -n '1340,1520p' docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md 2>/dev/null" in /home/ice/dev/dohc
 succeeded in 116ms:
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

 succeeded in 102ms:
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
  const unc = rest.startsWith("\\\\") || rest.startsWith("//");
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
  if (normalized === "/" || /^[A-Za-z]:$/.test(normalized) || normalized === "//") {
    return { ok: false, reason: "workspace root cannot be the filesystem root" };
  }
  if (normalized === home) {
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

exec

codex
The new root guard still permits important root-equivalent paths on common platforms. These gaps can register and traverse a user's home directory or an entire network share through the new attach/create paths.

Full review comments:

- [P2] Reject UNC share roots as filesystem roots — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:101-101
  On Windows, `\\server\share` normalizes to `//server/share`, so this condition does not reject it because it only rejects bare `//`. The new open-existing flow attaches the picked folder directly, so choosing a share root registers and traverses the entire network share; require at least one child directory below the share before returning ok.

- [P2] Reject case variants of the home directory — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:104-104
  On case-insensitive filesystems such as Windows and default macOS, this exact string comparison lets the same home directory through with different casing, e.g. `homedir()` returns `C:/Users/Ice` but IPC passes `c:\users\ice`. `usableRoot()` then accepts it and `attachWorkspaceFolder`/`createLocalWorkspace` can register the user's home, after which file listing traverses it; compare a case-folded or canonical form for this guard.
The new root guard still permits important root-equivalent paths on common platforms. These gaps can register and traverse a user's home directory or an entire network share through the new attach/create paths.

Full review comments:

- [P2] Reject UNC share roots as filesystem roots — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:101-101
  On Windows, `\\server\share` normalizes to `//server/share`, so this condition does not reject it because it only rejects bare `//`. The new open-existing flow attaches the picked folder directly, so choosing a share root registers and traverses the entire network share; require at least one child directory below the share before returning ok.

- [P2] Reject case variants of the home directory — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:104-104
  On case-insensitive filesystems such as Windows and default macOS, this exact string comparison lets the same home directory through with different casing, e.g. `homedir()` returns `C:/Users/Ice` but IPC passes `c:\users\ice`. `usableRoot()` then accepts it and `attachWorkspaceFolder`/`createLocalWorkspace` can register the user's home, after which file listing traverses it; compare a case-folded or canonical form for this guard.
