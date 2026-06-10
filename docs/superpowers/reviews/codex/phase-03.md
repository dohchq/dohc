OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb111-ed14-7413-8d63-bc424fc2280b
--------
user
commit 529c0d4
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git rev-parse --show-toplevel && git status --short && git show --stat --oneline --decorate --no-renames 529c0d4' in /home/ice/dev/dohc
 succeeded in 113ms:
 M docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
?? docs/superpowers/reviews/codex/phase-03.md
?? docs/superpowers/reviews/codex/ui-phase-03.md
?? test-results/
529c0d4 (HEAD -> claude/desktop-local-first-cloud-sync) phase3: Add native desktop workspace shell
 apps/desktop/e2e/firstRunWorkspace.spec.ts         | 199 +++++++++++
 apps/desktop/electron.vite.config.ts               |   8 +-
 apps/desktop/package.json                          |  14 +
 apps/desktop/src/ipc/bridgeContract.ts             |  74 ++++-
 apps/desktop/src/ipc/channels.ts                   |   5 +
 apps/desktop/src/main.ts                           |  77 ++++-
 apps/desktop/src/preload.ts                        |  12 +
 apps/desktop/src/renderer/CommandPalette.tsx       |  78 +++++
 apps/desktop/src/renderer/DesktopFirstRun.test.tsx | 108 ++++++
 apps/desktop/src/renderer/DesktopFirstRun.tsx      | 103 ++++++
 apps/desktop/src/renderer/DesktopRoot.tsx          |  39 +++
 .../desktop/src/renderer/DesktopWorkspaceShell.tsx | 365 +++++++++++++++++++++
 apps/desktop/src/renderer/NewFileDialog.tsx        |  56 ++++
 apps/desktop/src/renderer/bridge.ts                |  14 +
 apps/desktop/src/renderer/index.html               |   2 +-
 apps/desktop/src/renderer/main.ts                  |  33 --
 apps/desktop/src/renderer/main.tsx                 |  15 +
 apps/desktop/src/renderer/styles.css               |  40 +++
 apps/desktop/src/renderer/theme.ts                 |  22 ++
 apps/desktop/src/workspaces/WorkspaceRegistry.ts   |  65 ++++
 .../src/workspaces/createWorkspaceFolder.ts        |  52 +++
 apps/desktop/src/workspaces/workspaceFiles.test.ts |  64 ++++
 apps/desktop/src/workspaces/workspaceFiles.ts      |  75 +++++
 apps/desktop/vitest.config.ts                      |   2 +-
 ...desktop-local-first-cloud-sync.execution-log.md |  38 ++-
 pnpm-lock.yaml                                     | 142 ++++++++
 26 files changed, 1649 insertions(+), 53 deletions(-)

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
2026-06-10T10:27:15.491027Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open
exec
/bin/bash -lc "git ls-files '*AGENTS.md'" in /home/ice/dev/dohc
 succeeded in 0ms:
AGENTS.md
apps/app/AGENTS.md

exec
/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 529c0d4 -- apps/desktop/src/main.ts apps/desktop/src/ipc/bridgeContract.ts apps/desktop/src/ipc/channels.ts apps/desktop/src/preload.ts apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/createWorkspaceFolder.ts apps/desktop/src/workspaces/workspaceFiles.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:26:33 2026 +0800

    phase3: Add native desktop workspace shell
    
    First-run creates real workspace folders (suggested ~/dohc, manifest
    via workspace-core, no account); shell ships every plan-required
    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
    never overwrites), truthful cloud-sync offer, agent activity panel,
    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
    Design review loop: 2 iterations, all hard items pass, judges
    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
    E2E (real on-disk assertions, relaunch persistence).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
index 64a5a7a..a8d543a 100644
--- a/apps/desktop/src/ipc/bridgeContract.ts
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -1,38 +1,94 @@
 import { z } from "zod";
 
 // Typed contract for everything the preload bridge exposes. Main-process
 // handlers validate results against these before returning them. Payload
 // validation starts with the first payload-accepting channel (Phase 4).
 // The renderer never sees raw Electron APIs.
 
 export const VersionResult = z.string().min(1);
 export type VersionResult = z.infer<typeof VersionResult>;
 
 export const PickWorkspaceRootResult = z.string().min(1).nullable();
 export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
 
-// The real registry arrives in Phase 4; the contract starts narrow.
+export const WorkspaceSummary = z.object({
+  workspaceId: z.string().min(1),
+  rootPath: z.string().min(1),
+  kind: z.enum(["personal", "shared", "cloud-only"]),
+  mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
+});
+export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
+
 export const WorkspaceRegistryResult = z.object({
-  workspaces: z.array(
-    z.object({
-      workspaceId: z.string().min(1),
-      rootPath: z.string().min(1),
-      kind: z.enum(["personal", "shared", "cloud-only"]),
-      mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
-    }),
-  ),
+  workspaces: z.array(WorkspaceSummary),
 });
 export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
 
+export const DefaultWorkspaceRootResult = z.string().min(1);
+
+export const CreateLocalWorkspacePayload = z.object({
+  rootPath: z.string().min(1),
+  kind: z.enum(["personal", "shared"]),
+});
+export type CreateLocalWorkspacePayload = z.infer<
+  typeof CreateLocalWorkspacePayload
+>;
+
+export const ListWorkspaceFilesPayload = z.object({
+  workspaceId: z.string().min(1),
+});
+
+export const WorkspaceFileEntry = z.object({
+  path: z.string().min(1),
+  kind: z.enum(["file", "database", "app-source"]),
+});
+export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;
+
+export const ListWorkspaceFilesResult = z.object({
+  files: z.array(WorkspaceFileEntry),
+});
+export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;
+
+export const CreateWorkspaceFilePayload = z.object({
+  workspaceId: z.string().min(1),
+  relativePath: z.string().min(1),
+});
+
+export const CreateWorkspaceFileResult = z.object({
+  path: z.string().min(1),
+});
+
+export const ImportWorkspaceFilesPayload = z.object({
+  workspaceId: z.string().min(1),
+});
+
+export const ImportWorkspaceFilesResult = z.object({
+  imported: z.array(z.string().min(1)),
+});
+
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
+  getDefaultWorkspaceRoot(): Promise<string>;
+  createLocalWorkspace(
+    payload: CreateLocalWorkspacePayload,
+  ): Promise<WorkspaceSummary>;
+  listWorkspaceFiles(payload: {
+    workspaceId: string;
+  }): Promise<ListWorkspaceFilesResult>;
+  createWorkspaceFile(payload: {
+    workspaceId: string;
+    relativePath: string;
+  }): Promise<{ path: string }>;
+  importWorkspaceFiles(payload: {
+    workspaceId: string;
+  }): Promise<{ imported: string[] }>;
 }
diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
index 0981b5d..b2473ca 100644
--- a/apps/desktop/src/ipc/channels.ts
+++ b/apps/desktop/src/ipc/channels.ts
@@ -1,9 +1,14 @@
 export const CHANNELS = {
   getVersion: "desktop:get-version",
   pickWorkspaceRoot: "desktop:pick-workspace-root",
   getWorkspaceRegistry: "desktop:get-workspace-registry",
+  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
+  createLocalWorkspace: "desktop:create-local-workspace",
+  listWorkspaceFiles: "desktop:list-workspace-files",
+  createWorkspaceFile: "desktop:create-workspace-file",
+  importWorkspaceFiles: "desktop:import-workspace-files",
   firstPaint: "desktop:first-paint",
   getLaunchMarks: "desktop:test:get-launch-marks",
 } as const;
 
 export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
index c70d9ed..26d0975 100644
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -1,78 +1,151 @@
+import { defaultWorkspaceRoot } from "@dohc/workspace-core";
 import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
 import {
+  CreateLocalWorkspacePayload,
+  CreateWorkspaceFilePayload,
+  CreateWorkspaceFileResult,
+  DefaultWorkspaceRootResult,
+  ImportWorkspaceFilesPayload,
+  ImportWorkspaceFilesResult,
   LaunchMarksResult,
+  ListWorkspaceFilesPayload,
+  ListWorkspaceFilesResult,
   PickWorkspaceRootResult,
   VersionResult,
   WorkspaceRegistryResult,
+  WorkspaceSummary,
 } from "./ipc/bridgeContract";
 import { CHANNELS } from "./ipc/channels";
 import { launchMarks } from "./performance/launchMarks";
 import { decideNavigation } from "./security/electronSecurity";
 import { navigationPolicy } from "./window/createMainWindow";
+import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
+import {
+  effectiveHome,
+  findWorkspace,
+  listWorkspaces,
+  registerWorkspace,
+} from "./workspaces/WorkspaceRegistry";
+import {
+  copyIntoWorkspace,
+  createFile,
+  listFiles,
+} from "./workspaces/workspaceFiles";
+
+function requireWorkspace(workspaceId: string) {
+  const workspace = findWorkspace(workspaceId);
+  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
+  return workspace;
+}
 
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
     const result = await dialog.showOpenDialog({
       properties: ["openDirectory", "createDirectory"],
     });
     const picked = result.canceled ? null : (result.filePaths[0] ?? null);
     return PickWorkspaceRootResult.parse(picked);
   });
 
   ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
     assertTrustedSender(event);
-    // Real registry lands in Phase 4.
-    return WorkspaceRegistryResult.parse({ workspaces: [] });
+    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
+  });
+
+  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
+    assertTrustedSender(event);
+    return DefaultWorkspaceRootResult.parse(
+      defaultWorkspaceRoot(effectiveHome()),
+    );
+  });
+
+  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = CreateLocalWorkspacePayload.parse(payload);
+    const created = await createWorkspaceFolder(input);
+    registerWorkspace(created);
+    return WorkspaceSummary.parse(created);
+  });
+
+  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = ListWorkspaceFilesPayload.parse(payload);
+    const workspace = requireWorkspace(input.workspaceId);
+    return ListWorkspaceFilesResult.parse({
+      files: await listFiles(workspace.rootPath),
+    });
+  });
+
+  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = CreateWorkspaceFilePayload.parse(payload);
+    const workspace = requireWorkspace(input.workspaceId);
+    const path = await createFile(workspace.rootPath, input.relativePath);
+    return CreateWorkspaceFileResult.parse({ path });
+  });
+
+  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = ImportWorkspaceFilesPayload.parse(payload);
+    const workspace = requireWorkspace(input.workspaceId);
+    const result = await dialog.showOpenDialog({
+      properties: ["openFile", "multiSelections"],
+      title: "Import files into workspace",
+    });
+    const imported = result.canceled
+      ? []
+      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
+    return ImportWorkspaceFilesResult.parse({ imported });
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
index d0293f0..d36a531 100644
--- a/apps/desktop/src/preload.ts
+++ b/apps/desktop/src/preload.ts
@@ -1,21 +1,33 @@
 import { contextBridge, ipcRenderer } from "electron";
 import { CHANNELS } from "./ipc/channels";
 
 // The entire bridge surface. Narrow on purpose: the renderer gets named,
 // typed operations — never raw ipcRenderer, never Node.
 contextBridge.exposeInMainWorld("dohcDesktop", {
   getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
   pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
   getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
+  getDefaultWorkspaceRoot: () =>
+    ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
+  createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
+    ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
+  listWorkspaceFiles: (payload: { workspaceId: string }) =>
+    ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
+  createWorkspaceFile: (payload: {
+    workspaceId: string;
+    relativePath: string;
+  }) => ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
+  importWorkspaceFiles: (payload: { workspaceId: string }) =>
+    ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
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
diff --git a/apps/desktop/src/workspaces/WorkspaceRegistry.ts b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
new file mode 100644
index 0000000..492c52c
--- /dev/null
+++ b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
@@ -0,0 +1,65 @@
+import { app } from "electron";
+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { homedir } from "node:os";
+import { dirname, join } from "node:path";
+import type { CreatedWorkspace } from "./createWorkspaceFolder";
+
+// Registry of known local workspaces. Lives in Electron userData; in test
+// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
+// formalizes attachment/duplicate rules with dedicated tests.
+
+function testHome(): string | null {
+  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
+    ? (process.env.DOHC_TEST_HOME ?? null)
+    : null;
+}
+
+export function effectiveHome(): string {
+  return testHome() ?? homedir();
+}
+
+function registryPath(): string {
+  const base = testHome() ?? app.getPath("userData");
+  return join(base, "dohc-workspaces.json");
+}
+
+interface RegistryFile {
+  version: 1;
+  workspaces: CreatedWorkspace[];
+}
+
+function readRegistry(): RegistryFile {
+  try {
+    const parsed = JSON.parse(
+      readFileSync(registryPath(), "utf8"),
+    ) as RegistryFile;
+    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
+  } catch {
+    return { version: 1, workspaces: [] };
+  }
+}
+
+function writeRegistry(registry: RegistryFile): void {
+  mkdirSync(dirname(registryPath()), { recursive: true });
+  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
+}
+
+export function listWorkspaces(): CreatedWorkspace[] {
+  return readRegistry().workspaces;
+}
+
+export function registerWorkspace(workspace: CreatedWorkspace): void {
+  const registry = readRegistry();
+  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
+    return;
+  }
+  registry.workspaces.push(workspace);
+  writeRegistry(registry);
+}
+
+export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
+  return (
+    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
+    null
+  );
+}
diff --git a/apps/desktop/src/workspaces/createWorkspaceFolder.ts b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
new file mode 100644
index 0000000..e651f22
--- /dev/null
+++ b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
@@ -0,0 +1,52 @@
+import {
+  createWorkspaceManifest,
+  defaultWorkspaceMode,
+  type WorkspaceKind,
+} from "@dohc/workspace-core";
+import { randomUUID } from "node:crypto";
+import { mkdir, writeFile } from "node:fs/promises";
+import { join } from "node:path";
+
+export interface CreatedWorkspace {
+  workspaceId: string;
+  rootPath: string;
+  kind: WorkspaceKind;
+  mode: ReturnType<typeof defaultWorkspaceMode>;
+}
+
+const FIRST_CONTEXT = `# About me
+
+Tell your agents who you are and how you like to work.
+This file lives at .context/me.md inside your workspace folder.
+`;
+
+export async function createWorkspaceFolder(input: {
+  rootPath: string;
+  kind: Extract<WorkspaceKind, "personal" | "shared">;
+}): Promise<CreatedWorkspace> {
+  const manifest = createWorkspaceManifest({
+    workspaceId: randomUUID(),
+    kind: input.kind,
+  });
+
+  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
+  await mkdir(join(input.rootPath, ".context"), { recursive: true });
+  await writeFile(
+    join(input.rootPath, ".dohc", "manifest.json"),
+    `${JSON.stringify(manifest, null, 2)}\n`,
+  );
+  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
+    flag: "wx",
+  }).catch((error: unknown) => {
+    // An existing me.md is the user's; never overwrite it. Real failures
+    // (permissions, disk) must still surface.
+    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
+  });
+
+  return {
+    workspaceId: manifest.workspaceId,
+    rootPath: input.rootPath,
+    kind: input.kind,
+    mode: manifest.mode,
+  };
+}
diff --git a/apps/desktop/src/workspaces/workspaceFiles.ts b/apps/desktop/src/workspaces/workspaceFiles.ts
new file mode 100644
index 0000000..2efe19b
--- /dev/null
+++ b/apps/desktop/src/workspaces/workspaceFiles.ts
@@ -0,0 +1,75 @@
+import {
+  classifyPath,
+  validateUserWritePath,
+} from "@dohc/workspace-core";
+import { constants } from "node:fs";
+import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
+import { basename, dirname, join } from "node:path";
+import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
+
+const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
+
+export async function listFiles(
+  rootPath: string,
+): Promise<WorkspaceFileEntry[]> {
+  const entries: WorkspaceFileEntry[] = [];
+
+  async function walk(dir: string, prefix: string): Promise<void> {
+    const dirents = await readdir(dir, { withFileTypes: true });
+    for (const dirent of dirents) {
+      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
+      if (dirent.isDirectory()) {
+        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
+      } else {
+        const classified = classifyPath(rel);
+        entries.push({
+          path: rel,
+          kind: classified.kind === "database" ? "database"
+            : classified.kind === "app-source" ? "app-source"
+            : "file",
+        });
+      }
+    }
+  }
+
+  await walk(rootPath, "");
+  entries.sort((a, b) => a.path.localeCompare(b.path));
+  return entries;
+}
+
+export async function createFile(
+  rootPath: string,
+  relativePath: string,
+): Promise<string> {
+  const validated = validateUserWritePath(relativePath);
+  if (!validated.ok) {
+    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
+  }
+  const absolute = join(rootPath, validated.normalized);
+  await mkdir(dirname(absolute), { recursive: true });
+  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
+    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
+  });
+  return validated.normalized;
+}
+
+// Imports copy external files into the workspace root by basename; existing
+// files are never overwritten (skipped, not errored — imports are additive).
+export async function copyIntoWorkspace(
+  rootPath: string,
+  absolutePaths: string[],
+): Promise<string[]> {
+  const imported: string[] = [];
+  for (const source of absolutePaths) {
+    const name = basename(source);
+    const validated = validateUserWritePath(name);
+    if (!validated.ok) continue;
+    try {
+      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
+      imported.push(validated.normalized);
+    } catch (error) {
+      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
+    }
+  }
+  return imported;
+}

exec
/bin/bash -lc 'git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/src/renderer/DesktopWorkspaceShell.tsx apps/desktop/src/renderer/DesktopRoot.tsx apps/desktop/src/renderer/DesktopFirstRun.tsx apps/desktop/src/renderer/CommandPalette.tsx apps/desktop/src/renderer/NewFileDialog.tsx apps/desktop/src/renderer/bridge.ts apps/desktop/src/renderer/main.tsx apps/desktop/src/renderer/main.ts apps/desktop/src/renderer/styles.css apps/desktop/src/renderer/theme.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:26:33 2026 +0800

    phase3: Add native desktop workspace shell
    
    First-run creates real workspace folders (suggested ~/dohc, manifest
    via workspace-core, no account); shell ships every plan-required
    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
    never overwrites), truthful cloud-sync offer, agent activity panel,
    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
    Design review loop: 2 iterations, all hard items pass, judges
    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
    E2E (real on-disk assertions, relaunch persistence).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/src/renderer/CommandPalette.tsx b/apps/desktop/src/renderer/CommandPalette.tsx
new file mode 100644
index 0000000..9226f56
--- /dev/null
+++ b/apps/desktop/src/renderer/CommandPalette.tsx
@@ -0,0 +1,78 @@
+import { useEffect, useRef, useState } from "react";
+
+export interface Command {
+  id: string;
+  label: string;
+  run: () => void;
+}
+
+export function CommandPalette(props: {
+  commands: Command[];
+  onClose: () => void;
+  testId?: string;
+  placeholder?: string;
+  ariaLabel?: string;
+}) {
+  const [query, setQuery] = useState("");
+  const inputRef = useRef<HTMLInputElement>(null);
+
+  useEffect(() => {
+    inputRef.current?.focus();
+  }, []);
+
+  const matches = props.commands.filter((command) =>
+    command.label.toLowerCase().includes(query.toLowerCase()),
+  );
+
+  function runCommand(command: Command | undefined) {
+    if (!command) return;
+    props.onClose();
+    command.run();
+  }
+
+  return (
+    <div
+      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
+      onClick={props.onClose}
+    >
+      <div
+        data-testid={props.testId ?? "command-palette"}
+        className="w-130 max-w-[80vw] overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
+        onClick={(event) => event.stopPropagation()}
+      >
+        <input
+          ref={inputRef}
+          type="text"
+          aria-label={props.ariaLabel ?? "Command"}
+          placeholder={props.placeholder ?? "Type a command…"}
+          value={query}
+          onChange={(event) => setQuery(event.target.value)}
+          onKeyDown={(event) => {
+            if (event.key === "Escape") props.onClose();
+            if (event.key === "Enter") runCommand(matches[0]);
+          }}
+          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-subtle"
+        />
+        <ul role="listbox" aria-label="Commands" className="m-0 max-h-72 list-none overflow-y-auto p-1">
+          {matches.length === 0 ? (
+            <li className="px-3 py-2 text-xs text-subtle">No matching commands</li>
+          ) : (
+            matches.map((command, index) => (
+              <li key={command.id} role="option" aria-selected={index === 0}>
+                <button
+                  type="button"
+                  onClick={() => runCommand(command)}
+                  className={`w-full rounded px-3 py-1.5 text-left text-[13px] ${
+                    index === 0 ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
+                  }`}
+                >
+                  {command.label}
+                </button>
+              </li>
+            ))
+          )}
+        </ul>
+      </div>
+    </div>
+  );
+}
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.tsx b/apps/desktop/src/renderer/DesktopFirstRun.tsx
new file mode 100644
index 0000000..39d5793
--- /dev/null
+++ b/apps/desktop/src/renderer/DesktopFirstRun.tsx
@@ -0,0 +1,103 @@
+import { Cloud, FolderOpen } from "lucide-react";
+import { useEffect, useState } from "react";
+import { bridge } from "./bridge";
+import type { Workspace } from "./DesktopWorkspaceShell";
+
+// First launch is a working tool, not a marketing page: pick where your
+// files live, create the folder, start working. No account exists here.
+export function DesktopFirstRun(props: {
+  onWorkspaceReady: (workspace: Workspace) => void;
+}) {
+  const [root, setRoot] = useState<string | null>(null);
+  const [creating, setCreating] = useState(false);
+  const [error, setError] = useState<string | null>(null);
+  const [cloudNote, setCloudNote] = useState(false);
+
+  useEffect(() => {
+    void bridge().getDefaultWorkspaceRoot().then(setRoot);
+  }, []);
+
+  async function chooseFolder() {
+    const picked = await bridge().pickWorkspaceRoot();
+    if (picked) setRoot(picked);
+  }
+
+  async function createWorkspace() {
+    if (!root || creating) return;
+    setCreating(true);
+    try {
+      const workspace = await bridge().createLocalWorkspace({
+        rootPath: `${root}/personal`,
+        kind: "personal",
+      });
+      props.onWorkspaceReady(workspace);
+    } catch (cause) {
+      setError(cause instanceof Error ? cause.message : String(cause));
+      setCreating(false);
+    }
+  }
+
+  return (
+    <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
+      <div className="flex flex-col items-center gap-1">
+        <h1 className="m-0 text-2xl font-semibold tracking-tight">dohc</h1>
+        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
+      </div>
+
+      <div className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
+        <div className="flex flex-col gap-1">
+          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
+            Workspace location
+          </span>
+          <div className="flex items-start justify-between gap-2">
+            {/* The whole point of this screen is where files live: never
+                truncate the path. */}
+            <code className="break-all font-mono text-[13px] leading-snug text-ink">
+              {root ?? "…"}
+            </code>
+            <button
+              type="button"
+              onClick={() => void chooseFolder()}
+              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
+            >
+              <FolderOpen size={13} aria-hidden />
+              Choose a different folder
+            </button>
+          </div>
+        </div>
+
+        <button
+          type="button"
+          disabled={!root || creating}
+          onClick={() => void createWorkspace()}
+          className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
+        >
+          {creating ? "Creating…" : "Create workspace"}
+        </button>
+
+        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
+
+        <div className="flex items-center justify-between gap-4">
+          <p className="m-0 text-xs text-subtle">
+            Works offline, no account needed. Cloud sync is optional.
+          </p>
+          <button
+            type="button"
+            onClick={() => setCloudNote((open) => !open)}
+            className="flex shrink-0 items-center gap-1 text-xs text-subtle hover:text-ink"
+          >
+            <Cloud size={12} aria-hidden />
+            Enable dohc Cloud sync
+          </button>
+        </div>
+        {cloudNote ? (
+          <p className="m-0 rounded bg-panel-2 px-2.5 py-2 text-xs leading-relaxed text-muted">
+            Cloud sync arrives with dohc Cloud accounts — sharing, backup, and
+            teams. Your workspace stays fully functional locally, and you can
+            connect it later without moving anything.
+          </p>
+        ) : null}
+      </div>
+    </div>
+  );
+}
diff --git a/apps/desktop/src/renderer/DesktopRoot.tsx b/apps/desktop/src/renderer/DesktopRoot.tsx
new file mode 100644
index 0000000..ba0e93f
--- /dev/null
+++ b/apps/desktop/src/renderer/DesktopRoot.tsx
@@ -0,0 +1,39 @@
+import { useEffect, useState } from "react";
+import { bridge } from "./bridge";
+import { DesktopFirstRun } from "./DesktopFirstRun";
+import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
+
+export function DesktopRoot() {
+  const [loaded, setLoaded] = useState(false);
+  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
+  const [workspace, setWorkspace] = useState<Workspace | null>(null);
+
+  useEffect(() => {
+    void bridge()
+      .getWorkspaceRegistry()
+      .then((registry) => {
+        setWorkspaces(registry.workspaces);
+        setWorkspace(registry.workspaces[0] ?? null);
+        setLoaded(true);
+      });
+  }, []);
+
+  if (!loaded) return null;
+  if (!workspace) {
+    return (
+      <DesktopFirstRun
+        onWorkspaceReady={(created) => {
+          setWorkspaces([created]);
+          setWorkspace(created);
+        }}
+      />
+    );
+  }
+  return (
+    <DesktopWorkspaceShell
+      workspace={workspace}
+      workspaces={workspaces}
+      onSwitchWorkspace={setWorkspace}
+    />
+  );
+}
diff --git a/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
new file mode 100644
index 0000000..f747851
--- /dev/null
+++ b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
@@ -0,0 +1,365 @@
+import {
+  Bot,
+  Check,
+  ChevronsUpDown,
+  Cloud,
+  Database,
+  FilePlus2,
+  FileText,
+  Import,
+  LayoutGrid,
+} from "lucide-react";
+import { useCallback, useEffect, useMemo, useState } from "react";
+import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
+import { bridge } from "./bridge";
+import { CommandPalette, type Command } from "./CommandPalette";
+import { NewFileDialog } from "./NewFileDialog";
+import { toggleTheme } from "./theme";
+
+export type Workspace = WorkspaceSummary;
+
+function workspaceName(workspace: Workspace): string {
+  return workspace.rootPath.split("/").pop() ?? "workspace";
+}
+
+function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
+  if (kind === "database") return <Database size={13} aria-hidden />;
+  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
+  return <FileText size={13} aria-hidden />;
+}
+
+export function DesktopWorkspaceShell(props: {
+  workspace: Workspace;
+  workspaces: Workspace[];
+  onSwitchWorkspace: (workspace: Workspace) => void;
+}) {
+  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
+  const [selected, setSelected] = useState<string | null>(null);
+  const [paletteOpen, setPaletteOpen] = useState(false);
+  const [newFileOpen, setNewFileOpen] = useState(false);
+  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
+  const [switcherOpen, setSwitcherOpen] = useState(false);
+  const [cloudOpen, setCloudOpen] = useState(false);
+
+  const importFiles = useCallback(async () => {
+    await bridge().importWorkspaceFiles({
+      workspaceId: props.workspace.workspaceId,
+    });
+    const result = await bridge().listWorkspaceFiles({
+      workspaceId: props.workspace.workspaceId,
+    });
+    setFiles(result.files);
+  }, [props.workspace.workspaceId]);
+
+  const refreshFiles = useCallback(async () => {
+    const result = await bridge().listWorkspaceFiles({
+      workspaceId: props.workspace.workspaceId,
+    });
+    setFiles(result.files);
+  }, [props.workspace.workspaceId]);
+
+  useEffect(() => {
+    void refreshFiles();
+  }, [refreshFiles]);
+
+  useEffect(() => {
+    function onKeyDown(event: KeyboardEvent) {
+      const mod = event.metaKey || event.ctrlKey;
+      if (!mod) return;
+      if (event.key === "n") {
+        event.preventDefault();
+        setNewFileOpen(true);
+      } else if (event.key === "k") {
+        event.preventDefault();
+        setPaletteOpen((open) => !open);
+      } else if (event.key === "p") {
+        event.preventDefault();
+        setQuickOpenOpen((open) => !open);
+      }
+    }
+    window.addEventListener("keydown", onKeyDown);
+    return () => window.removeEventListener("keydown", onKeyDown);
+  }, []);
+
+  const commands = useMemo<Command[]>(
+    () => [
+      {
+        id: "new-file",
+        label: "New file",
+        run: () => setNewFileOpen(true),
+      },
+      {
+        id: "quick-open",
+        label: "Go to file",
+        run: () => setQuickOpenOpen(true),
+      },
+      {
+        id: "import-files",
+        label: "Import files into workspace",
+        run: () => void importFiles(),
+      },
+      {
+        id: "connect-cloud",
+        label: "Connect dohc Cloud",
+        run: () => setCloudOpen(true),
+      },
+      {
+        id: "toggle-theme",
+        label: "Toggle light/dark theme",
+        run: toggleTheme,
+      },
+    ],
+    [importFiles],
+  );
+
+  return (
+    <div
+      data-testid="workspace-shell"
+      className="app-chrome flex h-screen flex-col bg-bg text-ink"
+    >
+      <div className="flex min-h-0 flex-1">
+        {/* Sidebar */}
+        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2">
+          <header className="relative border-b border-line">
+            <button
+              type="button"
+              data-testid="workspace-switcher"
+              aria-haspopup="listbox"
+              aria-expanded={switcherOpen}
+              onClick={() => setSwitcherOpen((open) => !open)}
+              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-panel"
+            >
+              <span className="truncate text-[13px] font-semibold">
+                {workspaceName(props.workspace)}
+              </span>
+              <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
+            </button>
+            {switcherOpen ? (
+              <ul
+                role="listbox"
+                aria-label="Workspaces"
+                className="absolute left-2 right-2 top-full z-20 mt-1 m-0 list-none rounded border border-line bg-panel p-1 shadow-md"
+              >
+                {props.workspaces.map((candidate) => (
+                  <li key={candidate.workspaceId} role="option" aria-selected={candidate.workspaceId === props.workspace.workspaceId}>
+                    <button
+                      type="button"
+                      onClick={() => {
+                        setSwitcherOpen(false);
+                        props.onSwitchWorkspace(candidate);
+                      }}
+                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-muted hover:text-ink"
+                    >
+                      {candidate.workspaceId === props.workspace.workspaceId ? (
+                        <Check size={12} aria-hidden />
+                      ) : (
+                        <span className="w-3" aria-hidden />
+                      )}
+                      <span className="truncate">{workspaceName(candidate)}</span>
+                      <span className="ml-auto text-[10px] uppercase text-subtle">
+                        {candidate.kind}
+                      </span>
+                    </button>
+                  </li>
+                ))}
+              </ul>
+            ) : null}
+          </header>
+
+          <nav
+            data-testid="file-tree"
+            aria-label="Files"
+            className="min-h-0 flex-1 overflow-y-auto py-1"
+          >
+            {files.length === 0 ? (
+              <button
+                type="button"
+                onClick={() => setNewFileOpen(true)}
+                className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
+              >
+                <FilePlus2 size={13} aria-hidden />
+                Create your first file
+              </button>
+            ) : (
+              <ul className="m-0 list-none p-0">
+                {files.map((file) => (
+                  <li key={file.path}>
+                    <button
+                      type="button"
+                      onClick={() => setSelected(file.path)}
+                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
+                        selected === file.path
+                          ? "bg-panel text-ink"
+                          : "text-muted hover:text-ink"
+                      }`}
+                    >
+                      <FileIcon kind={file.kind} />
+                      <span className="truncate">{file.path}</span>
+                    </button>
+                  </li>
+                ))}
+              </ul>
+            )}
+          </nav>
+
+          <footer className="flex flex-col gap-1 border-t border-line px-3 py-1.5">
+            <button
+              type="button"
+              onClick={() => setNewFileOpen(true)}
+              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
+            >
+              <FilePlus2 size={13} aria-hidden />
+              New file
+              <kbd className="ml-auto font-mono text-[10px] text-subtle">
+                Ctrl N
+              </kbd>
+            </button>
+            <button
+              type="button"
+              onClick={() => void importFiles()}
+              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
+            >
+              <Import size={13} aria-hidden />
+              Import files
+            </button>
+          </footer>
+        </aside>
+
+        {/* Main area */}
+        <main className="flex min-w-0 flex-1 items-center justify-center bg-bg">
+          {selected ? (
+            <div className="flex flex-col items-center gap-1 text-center">
+              <span className="font-mono text-[13px] text-ink">{selected}</span>
+              <span className="text-xs text-subtle">
+                File editing arrives with the editor surface.
+              </span>
+            </div>
+          ) : (
+            <div className="flex flex-col items-center gap-2 text-center">
+              <span className="text-sm text-muted">
+                Select a file, or create one
+              </span>
+              <div className="flex items-center gap-3">
+                <button
+                  type="button"
+                  onClick={() => setNewFileOpen(true)}
+                  className="font-mono text-xs text-subtle hover:text-ink"
+                >
+                  Ctrl N · new file
+                </button>
+                <button
+                  type="button"
+                  onClick={() => setPaletteOpen(true)}
+                  className="font-mono text-xs text-subtle hover:text-ink"
+                >
+                  Ctrl K · commands
+                </button>
+                <button
+                  type="button"
+                  onClick={() => setQuickOpenOpen(true)}
+                  className="font-mono text-xs text-subtle hover:text-ink"
+                >
+                  Ctrl P · go to file
+                </button>
+              </div>
+            </div>
+          )}
+        </main>
+
+        {/* Agent activity panel */}
+        <aside
+          data-testid="agent-panel"
+          aria-label="Agent activity"
+          className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
+        >
+          <header className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[13px] font-semibold">
+            <Bot size={14} aria-hidden />
+            Agent activity
+          </header>
+          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
+            <span className="text-xs text-muted">No agent runs yet</span>
+            <span className="text-[11px] text-subtle">
+              Point Codex or Claude Code at this folder — changes show up here
+              as a timeline.
+            </span>
+          </div>
+        </aside>
+      </div>
+
+      {/* Status bar */}
+      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3">
+        <span
+          data-testid="sync-status"
+          className="flex items-center gap-1.5 text-[11px] text-muted"
+        >
+          <span
+            aria-hidden
+            className="inline-block h-1.5 w-1.5 rounded-full bg-success"
+          />
+          Local · saved
+        </span>
+        <button
+          type="button"
+          onClick={() => setCloudOpen(true)}
+          className="flex items-center gap-1.5 text-[11px] text-subtle hover:text-ink"
+        >
+          <Cloud size={12} aria-hidden />
+          Connect dohc Cloud
+        </button>
+      </footer>
+
+      {paletteOpen ? (
+        <CommandPalette
+          commands={commands}
+          onClose={() => setPaletteOpen(false)}
+        />
+      ) : null}
+      {quickOpenOpen ? (
+        <CommandPalette
+          testId="quick-open"
+          placeholder="Go to file…"
+          ariaLabel="File"
+          commands={files.map((file) => ({
+            id: file.path,
+            label: file.path,
+            run: () => setSelected(file.path),
+          }))}
+          onClose={() => setQuickOpenOpen(false)}
+        />
+      ) : null}
+      {newFileOpen ? (
+        <NewFileDialog
+          workspaceId={props.workspace.workspaceId}
+          onClose={() => setNewFileOpen(false)}
+          onCreated={() => {
+            setNewFileOpen(false);
+            void refreshFiles();
+          }}
+        />
+      ) : null}
+      {cloudOpen ? (
+        <div
+          className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
+          onClick={() => setCloudOpen(false)}
+        >
+          <div
+            data-testid="cloud-sync-panel"
+            className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-4 shadow-lg"
+            onClick={(event) => event.stopPropagation()}
+          >
+            <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
+              <Cloud size={14} aria-hidden />
+              dohc Cloud
+            </h2>
+            <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
+              Cloud sync brings sharing, backup, and team workspaces. It
+              arrives with dohc Cloud accounts — this workspace stays fully
+              functional locally, and you can connect it then without moving
+              anything.
+            </p>
+          </div>
+        </div>
+      ) : null}
+    </div>
+  );
+}
diff --git a/apps/desktop/src/renderer/NewFileDialog.tsx b/apps/desktop/src/renderer/NewFileDialog.tsx
new file mode 100644
index 0000000..1c07920
--- /dev/null
+++ b/apps/desktop/src/renderer/NewFileDialog.tsx
@@ -0,0 +1,56 @@
+import { useEffect, useRef, useState } from "react";
+import { bridge } from "./bridge";
+
+export function NewFileDialog(props: {
+  workspaceId: string;
+  onClose: () => void;
+  onCreated: (path: string) => void;
+}) {
+  const [name, setName] = useState("");
+  const [error, setError] = useState<string | null>(null);
+  const inputRef = useRef<HTMLInputElement>(null);
+
+  useEffect(() => {
+    inputRef.current?.focus();
+  }, []);
+
+  async function create() {
+    if (!name.trim()) return;
+    try {
+      const result = await bridge().createWorkspaceFile({
+        workspaceId: props.workspaceId,
+        relativePath: name.trim(),
+      });
+      props.onCreated(result.path);
+    } catch (cause) {
+      setError(cause instanceof Error ? cause.message : String(cause));
+    }
+  }
+
+  return (
+    <div
+      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
+      onClick={props.onClose}
+    >
+      <div
+        className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-3 shadow-lg"
+        onClick={(event) => event.stopPropagation()}
+      >
+        <input
+          ref={inputRef}
+          type="text"
+          aria-label="File name"
+          placeholder="notes/today.md"
+          value={name}
+          onChange={(event) => setName(event.target.value)}
+          onKeyDown={(event) => {
+            if (event.key === "Escape") props.onClose();
+            if (event.key === "Enter") void create();
+          }}
+          className="w-full rounded border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-subtle"
+        />
+        {error ? <p className="mb-0 mt-2 text-xs text-danger">{error}</p> : null}
+      </div>
+    </div>
+  );
+}
diff --git a/apps/desktop/src/renderer/bridge.ts b/apps/desktop/src/renderer/bridge.ts
new file mode 100644
index 0000000..1c2cb50
--- /dev/null
+++ b/apps/desktop/src/renderer/bridge.ts
@@ -0,0 +1,14 @@
+import type { DohcDesktopBridge } from "../ipc/bridgeContract";
+
+declare global {
+  interface Window {
+    dohcDesktop?: DohcDesktopBridge;
+    dohcDesktopInternal?: { firstPaint(): void };
+  }
+}
+
+export function bridge(): DohcDesktopBridge {
+  const api = window.dohcDesktop;
+  if (!api) throw new Error("dohc desktop bridge is unavailable");
+  return api;
+}
diff --git a/apps/desktop/src/renderer/main.ts b/apps/desktop/src/renderer/main.ts
deleted file mode 100644
index 0e0da32..0000000
--- a/apps/desktop/src/renderer/main.ts
+++ /dev/null
@@ -1,33 +0,0 @@
-// Minimal first-run shell. Phase 3 replaces this with the real desktop
-// workspace shell (driven by the component reuse map + design review loop).
-
-declare global {
-  interface Window {
-    dohcDesktopInternal?: { firstPaint(): void };
-  }
-}
-
-const root = document.getElementById("root");
-if (root) {
-  const main = document.createElement("main");
-  main.style.cssText =
-    "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;";
-
-  const heading = document.createElement("h1");
-  heading.textContent = "dohc";
-  heading.style.cssText =
-    "font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;";
-
-  const subtitle = document.createElement("p");
-  subtitle.textContent = "Your workspace is a folder.";
-  subtitle.style.cssText = "font-size:14px;opacity:0.65;margin:0;";
-
-  main.append(heading, subtitle);
-  root.append(main);
-}
-
-requestAnimationFrame(() => {
-  window.dohcDesktopInternal?.firstPaint();
-});
-
-export {};
diff --git a/apps/desktop/src/renderer/main.tsx b/apps/desktop/src/renderer/main.tsx
new file mode 100644
index 0000000..89b5151
--- /dev/null
+++ b/apps/desktop/src/renderer/main.tsx
@@ -0,0 +1,15 @@
+import { createRoot } from "react-dom/client";
+import { DesktopRoot } from "./DesktopRoot";
+import { initTheme } from "./theme";
+import "./styles.css";
+
+initTheme();
+
+const container = document.getElementById("root");
+if (container) {
+  createRoot(container).render(<DesktopRoot />);
+}
+
+requestAnimationFrame(() => {
+  window.dohcDesktopInternal?.firstPaint();
+});
diff --git a/apps/desktop/src/renderer/styles.css b/apps/desktop/src/renderer/styles.css
new file mode 100644
index 0000000..7439dc9
--- /dev/null
+++ b/apps/desktop/src/renderer/styles.css
@@ -0,0 +1,40 @@
+@import "@dohc/brand/tokens.css";
+@import "tailwindcss";
+
+@custom-variant dark ([data-theme='dark'] &);
+
+/* Semantic layer over the shared brand tokens. The desktop renderer never
+ * redefines brand colors — packages/brand/src/tokens.css is the source. */
+@theme inline {
+  --color-bg: var(--dohc-bg);
+  --color-panel: var(--dohc-panel);
+  --color-panel-2: var(--dohc-panel-2);
+  --color-ink: var(--dohc-ink);
+  --color-muted: var(--dohc-muted);
+  --color-subtle: var(--dohc-subtle);
+  --color-accent: var(--dohc-accent);
+  --color-line: var(--dohc-line);
+  --color-success: var(--dohc-success);
+  --color-warning: var(--dohc-warning);
+  --color-danger: var(--dohc-danger);
+  --font-sans: var(--font-sans);
+  --font-mono: var(--font-mono);
+}
+
+html,
+body,
+#root {
+  height: 100%;
+  margin: 0;
+  background: var(--dohc-bg);
+  color: var(--dohc-ink);
+  font-family: var(--font-sans);
+  font-size: 14px;
+  -webkit-font-smoothing: antialiased;
+}
+
+/* Desktop app, not a web page: no text cursor or selection on chrome. */
+.app-chrome {
+  user-select: none;
+  cursor: default;
+}
diff --git a/apps/desktop/src/renderer/theme.ts b/apps/desktop/src/renderer/theme.ts
new file mode 100644
index 0000000..2b0350b
--- /dev/null
+++ b/apps/desktop/src/renderer/theme.ts
@@ -0,0 +1,22 @@
+const STORAGE_KEY = "dohc-theme";
+
+function apply(media: MediaQueryList): void {
+  const stored = localStorage.getItem(STORAGE_KEY);
+  const dark = stored ? stored === "dark" : media.matches;
+  document.documentElement.dataset.theme = dark ? "dark" : "light";
+}
+
+// Follows the system theme unless the user explicitly toggled; never
+// interrupts running work (a data-attribute flip only).
+export function initTheme(): void {
+  const media = window.matchMedia("(prefers-color-scheme: dark)");
+  media.addEventListener("change", () => apply(media));
+  apply(media);
+}
+
+export function toggleTheme(): void {
+  const next =
+    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
+  localStorage.setItem(STORAGE_KEY, next);
+  document.documentElement.dataset.theme = next;
+}

exec
/bin/bash -lc "git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/vitest.config.ts apps/desktop/src/renderer/index.html apps/desktop/src/renderer/DesktopFirstRun.test.tsx apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/e2e/firstRunWorkspace.spec.ts pnpm-lock.yaml | sed -n '1,240p'" in /home/ice/dev/dohc
 succeeded in 0ms:
commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:26:33 2026 +0800

    phase3: Add native desktop workspace shell
    
    First-run creates real workspace folders (suggested ~/dohc, manifest
    via workspace-core, no account); shell ships every plan-required
    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
    never overwrites), truthful cloud-sync offer, agent activity panel,
    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
    Design review loop: 2 iterations, all hard items pass, judges
    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
    E2E (real on-disk assertions, relaunch persistence).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/e2e/firstRunWorkspace.spec.ts b/apps/desktop/e2e/firstRunWorkspace.spec.ts
new file mode 100644
index 0000000..3fcf82b
--- /dev/null
+++ b/apps/desktop/e2e/firstRunWorkspace.spec.ts
@@ -0,0 +1,199 @@
+import { expect, test } from "@playwright/test";
+import { existsSync, readFileSync } from "node:fs";
+import { mkdir, mkdtemp } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { _electron as electron, type ElectronApplication, type Page } from "playwright";
+
+const SCREENSHOT_DIR = "test-results/screenshots/phase-03";
+
+async function launchFirstRun(): Promise<{
+  app: ElectronApplication;
+  page: Page;
+  testHome: string;
+}> {
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
+    },
+  });
+  const page = await app.firstWindow();
+  return { app, page, testHome };
+}
+
+async function shot(page: Page, name: string): Promise<void> {
+  await mkdir(SCREENSHOT_DIR, { recursive: true });
+  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
+  const scheme = await page.evaluate(() =>
+    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
+  );
+  await page.screenshot({
+    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
+  });
+}
+
+async function expectNoOverflow(page: Page): Promise<void> {
+  const overflow = await page.evaluate(() => ({
+    x: document.documentElement.scrollWidth - window.innerWidth,
+    y: document.documentElement.scrollHeight - window.innerHeight,
+  }));
+  expect(overflow.x).toBeLessThanOrEqual(0);
+  expect(overflow.y).toBeLessThanOrEqual(0);
+}
+
+test("first run creates a real workspace folder and lands in a native shell", async () => {
+  const { app, page, testHome } = await launchFirstRun();
+
+  // --- First run: suggests <home>/dohc, no login, cloud sync optional ---
+  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
+  await expect(page.getByText(join(testHome, "dohc"))).toBeVisible();
+  await expect(page.getByText(/cloud sync is optional/i)).toBeVisible();
+  await expect(
+    page.getByRole("button", { name: /enable dohc cloud sync/i }),
+  ).toBeVisible();
+  await expect(
+    page.getByRole("button", { name: /sign in|log in|sign up/i }),
+  ).toHaveCount(0);
+  await page.setViewportSize({ width: 1280, height: 800 });
+  await expectNoOverflow(page);
+  await shot(page, "first-run");
+
+  // --- Create the workspace: a real folder must appear on disk ---
+  await page.getByRole("button", { name: /create workspace/i }).click();
+  await expect(page.getByTestId("workspace-shell")).toBeVisible();
+
+  const workspaceRoot = join(testHome, "dohc", "personal");
+  expect(existsSync(join(workspaceRoot, ".dohc", "manifest.json"))).toBe(true);
+  const manifest = JSON.parse(
+    readFileSync(join(workspaceRoot, ".dohc", "manifest.json"), "utf8"),
+  );
+  expect(manifest).toMatchObject({
+    version: 1,
+    kind: "personal",
+    mode: "local-first",
+  });
+
+  // --- Shell surfaces: sidebar/file tree, status, agent panel ---
+  await expect(page.getByTestId("file-tree")).toBeVisible();
+  await expect(page.getByTestId("sync-status")).toBeVisible();
+  await expect(page.getByTestId("agent-panel")).toBeVisible();
+  // Agent activity is a panel with an empty-state action, not a paragraph.
+  await expect(page.getByTestId("agent-panel")).toContainText(/no agent runs/i);
+
+  // --- Keyboard: new file ---
+  await page.keyboard.press("ControlOrMeta+n");
+  const nameInput = page.getByRole("textbox", { name: /file name/i });
+  await expect(nameInput).toBeVisible();
+  await nameInput.fill("notes/today.md");
+  await nameInput.press("Enter");
+  await expect(
+    page.getByTestId("file-tree").getByText("today.md"),
+  ).toBeVisible();
+  expect(existsSync(join(workspaceRoot, "notes", "today.md"))).toBe(true);
+
+  // --- Keyboard: command palette opens, filters, closes ---
+  await page.keyboard.press("ControlOrMeta+k");
+  const palette = page.getByTestId("command-palette");
+  await expect(palette).toBeVisible();
+  await expect(palette.getByRole("option")).toHaveCount(5);
+  await expect(palette).toContainText(/import files/i);
+  await expect(palette).toContainText(/connect dohc cloud/i);
+  await page.keyboard.type("new");
+  await expect(palette.getByRole("option").first()).toContainText(/new/i);
+  await shot(page, "command-palette");
+  await page.keyboard.press("Escape");
+  await expect(palette).toHaveCount(0);
+
+  // --- Keyboard: quick-open jumps to a file ---
+  await page.keyboard.press("ControlOrMeta+p");
+  const quickOpen = page.getByTestId("quick-open");
+  await expect(quickOpen).toBeVisible();
+  await page.keyboard.type("today");
+  await expect(quickOpen.getByRole("option").first()).toContainText(
+    "notes/today.md",
+  );
+  await page.keyboard.press("Enter");
+  await expect(quickOpen).toHaveCount(0);
+  await expect(page.getByTestId("workspace-shell")).toContainText(
+    "notes/today.md",
+  );
+  await shot(page, "file-preview");
+
+  // --- Workspace switcher lists the current workspace ---
+  await page.getByTestId("workspace-switcher").click();
+  const switcherList = page.getByRole("listbox", { name: /workspaces/i });
+  await expect(switcherList.getByRole("option")).toHaveCount(1);
+  await expect(switcherList).toContainText("personal");
+  await page.getByTestId("workspace-switcher").click();
+
+  // --- Cloud connect is an honest surface, not a gate ---
+  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
+  await expect(page.getByTestId("cloud-sync-panel")).toContainText(
+    /fully functional locally/i,
+  );
+  await page.mouse.click(10, 10); // backdrop click closes
+  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);
+
+  // --- Layout holds at both required sizes, light and dark ---
+  for (const size of [
+    { width: 1280, height: 800 },
+    { width: 1536, height: 960 },
+  ]) {
+    await page.setViewportSize(size);
+    await expectNoOverflow(page);
+    await shot(page, "workspace-shell");
+  }
+  await page.emulateMedia({ colorScheme: "dark" });
+  await expect
+    .poll(async () =>
+      page.evaluate(() => document.documentElement.dataset.theme),
+    )
+    .toBe("dark");
+  await expectNoOverflow(page);
+  await shot(page, "workspace-shell");
+  await page.emulateMedia({ colorScheme: "light" });
+
+  // --- No marketing chrome anywhere in the shell ---
+  await expect(
+    page.getByText(/get started free|pricing|trusted by/i),
+  ).toHaveCount(0);
+
+  await app.close();
+});
+
+test("returning user lands directly in the shell, not first-run", async () => {
+  const { app, page, testHome } = await launchFirstRun();
+  await page.getByRole("button", { name: /create workspace/i }).click();
+  await expect(page.getByTestId("workspace-shell")).toBeVisible();
+  await app.close();
+
+  // Relaunch with the same test home: registry remembers the workspace.
+  const relaunchArgs = ["apps/desktop/dist/main/main.js"];
+  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
+    relaunchArgs.push("--no-sandbox");
+  }
+  const second = await electron.launch({
+    args: relaunchArgs,
+    cwd: process.cwd(),
+    env: {
+      ...process.env,
+      DOHC_DESKTOP_TEST: "1",
+      DOHC_TEST_HOME: testHome,
+    },
+  });
+  const page2 = await second.firstWindow();
+  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
+  await expect(
+    page2.getByRole("button", { name: /create workspace/i }),
+  ).toHaveCount(0);
+  await second.close();
+});
diff --git a/apps/desktop/electron.vite.config.ts b/apps/desktop/electron.vite.config.ts
index ba94e75..53a7d24 100644
--- a/apps/desktop/electron.vite.config.ts
+++ b/apps/desktop/electron.vite.config.ts
@@ -1,24 +1,30 @@
-import { defineConfig } from "electron-vite";
+import tailwindcss from "@tailwindcss/vite";
+import react from "@vitejs/plugin-react";
+import { defineConfig, externalizeDepsPlugin } from "electron-vite";
 
 export default defineConfig({
   main: {
+    // Workspace packages ship raw TS — they must be bundled, not
+    // externalized, or Node ESM fails on their extensionless imports.
+    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
     build: {
       outDir: "dist/main",

exec
/bin/bash -lc "git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/vitest.config.ts apps/desktop/src/renderer/index.html apps/desktop/src/renderer/DesktopFirstRun.test.tsx apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/e2e/firstRunWorkspace.spec.ts | sed -n '240,520p'" in /home/ice/dev/dohc
 succeeded in 0ms:
       outDir: "dist/main",
       lib: { entry: "src/main.ts" },
     },
   },
   preload: {
     build: {
       outDir: "dist/preload",
       // Sandboxed preloads must be CommonJS.
       lib: { entry: "src/preload.ts", formats: ["cjs"] },
     },
   },
   renderer: {
     root: "src/renderer",
+    plugins: [react(), tailwindcss()],
     build: {
       outDir: "dist/renderer",
       rollupOptions: { input: "src/renderer/index.html" },
     },
   },
 });
diff --git a/apps/desktop/package.json b/apps/desktop/package.json
index 46bbf67..0a2d68f 100644
--- a/apps/desktop/package.json
+++ b/apps/desktop/package.json
@@ -1,27 +1,41 @@
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
+    "@tailwindcss/vite": "^4.3.0",
+    "@testing-library/dom": "^10.4.1",
+    "@testing-library/react": "^16.3.2",
+    "@testing-library/user-event": "^14.6.1",
     "@types/node": "^22.19.19",
+    "@types/react": "^19.2.15",
+    "@types/react-dom": "^19.2.3",
+    "@vitejs/plugin-react": "^6.0.2",
     "electron": "^42.4.0",
     "electron-builder": "^26.15.2",
     "electron-vite": "^5.0.0",
+    "jsdom": "^29.1.1",
+    "tailwindcss": "^4.3.0",
     "typescript": "^5.9.3",
     "vite": "^8.0.14",
     "vitest": "^2.1.9"
   },
   "dependencies": {
+    "@dohc/brand": "workspace:*",
+    "@dohc/workspace-core": "workspace:*",
     "electron-updater": "^6.8.9",
+    "lucide-react": "^1.16.0",
+    "react": "^19.2.6",
+    "react-dom": "^19.2.6",
     "zod": "^3.25.76"
   }
 }
diff --git a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
new file mode 100644
index 0000000..d0bcab9
--- /dev/null
+++ b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
@@ -0,0 +1,108 @@
+// @vitest-environment jsdom
+import { cleanup, render, screen } from "@testing-library/react";
+import userEvent from "@testing-library/user-event";
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
+import { DesktopFirstRun } from "./DesktopFirstRun";
+
+const bridge = {
+  getVersion: vi.fn(async () => "0.1.0"),
+  getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
+  pickWorkspaceRoot: vi.fn(async () => "/home/ice/projects/research"),
+  createLocalWorkspace: vi.fn(async () => ({
+    workspaceId: "ws-1",
+    rootPath: "/home/ice/dohc/personal",
+    kind: "personal" as const,
+    mode: "local-first" as const,
+  })),
+  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
+  listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
+  createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
+};
+
+beforeEach(() => {
+  vi.stubGlobal("dohcDesktop", bridge);
+});
+
+afterEach(() => {
+  cleanup();
+  vi.unstubAllGlobals();
+  vi.clearAllMocks();
+});
+
+describe("first run", () => {
+  it("suggests ~/dohc as the workspace location", async () => {
+    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
+    expect(await screen.findByText("/home/ice/dohc")).toBeTruthy();
+  });
+
+  it("lets the user choose another folder", async () => {
+    const user = userEvent.setup();
+    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
+    await user.click(
+      await screen.findByRole("button", { name: /choose.*folder/i }),
+    );
+    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledOnce();
+    expect(await screen.findByText("/home/ice/projects/research")).toBeTruthy();
+  });
+
+  it("creates a personal workspace and hands it to the shell", async () => {
+    const user = userEvent.setup();
+    const onReady = vi.fn();
+    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
+    await user.click(
+      await screen.findByRole("button", { name: /create workspace/i }),
+    );
+    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
+      expect.objectContaining({ kind: "personal" }),
+    );
+    expect(onReady).toHaveBeenCalledWith(
+      expect.objectContaining({ workspaceId: "ws-1" }),
+    );
+  });
+
+  it("never requires login and never renders auth fields", async () => {
+    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
+    await screen.findByText("/home/ice/dohc");
+    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
+    expect(screen.queryByRole("button", { name: /sign in|log in|sign up/i }))
+      .toBeNull();
+  });
+
+  it("mentions cloud sync as optional, not as a gate", async () => {
+    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
+    await screen.findByText("/home/ice/dohc");
+    const mention = screen.getByText(/cloud sync is optional/i);
+    expect(mention).toBeTruthy();
+  });
+
+  it("offers Enable dohc Cloud sync without forcing it", async () => {
+    const user = userEvent.setup();
+    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
+    await screen.findByText("/home/ice/dohc");
+    const offer = screen.getByRole("button", {
+      name: /enable dohc cloud sync/i,
+    });
+    await user.click(offer);
+    // The offer is truthful — it explains, never gates or asks for auth.
+    expect(
+      screen.getByText(/stays fully functional locally/i),
+    ).toBeTruthy();
+    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
+    expect(
+      screen.getByRole("button", { name: /create workspace/i }),
+    ).toBeTruthy();
+  });
+
+  it("reads like a desktop app, not a marketing page", async () => {
+    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
+    await screen.findByText("/home/ice/dohc");
+    // No marketing tropes: pricing, testimonials, feature grids, sign-up CTAs.
+    expect(
+      screen.queryByText(/get started free|pricing|testimonial|trusted by/i),
+    ).toBeNull();
+    // The primary action is creating a real workspace folder.
+    expect(
+      screen.getByRole("button", { name: /create workspace/i }),
+    ).toBeTruthy();
+  });
+});
diff --git a/apps/desktop/src/renderer/index.html b/apps/desktop/src/renderer/index.html
index 00237e8..1557140 100644
--- a/apps/desktop/src/renderer/index.html
+++ b/apps/desktop/src/renderer/index.html
@@ -1,37 +1,37 @@
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
   </head>
   <body>
     <div id="root"></div>
-    <script type="module" src="./main.ts"></script>
+    <script type="module" src="./main.tsx"></script>
   </body>
 </html>
diff --git a/apps/desktop/src/workspaces/workspaceFiles.test.ts b/apps/desktop/src/workspaces/workspaceFiles.test.ts
new file mode 100644
index 0000000..f749cfd
--- /dev/null
+++ b/apps/desktop/src/workspaces/workspaceFiles.test.ts
@@ -0,0 +1,64 @@
+import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { beforeEach, describe, expect, it } from "vitest";
+import { copyIntoWorkspace, createFile, listFiles } from "./workspaceFiles";
+
+let root: string;
+
+beforeEach(async () => {
+  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
+});
+
+describe("createFile", () => {
+  it("creates nested files through validated paths", async () => {
+    const path = await createFile(root, "notes/./today.md");
+    expect(path).toBe("notes/today.md");
+    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
+  });
+
+  it("rejects traversal and reserved paths", async () => {
+    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
+    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
+  });
+
+  it("never overwrites an existing file", async () => {
+    await writeFile(join(root, "keep.md"), "original");
+    await createFile(root, "keep.md");
+    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
+  });
+});
+
+describe("listFiles", () => {
+  it("lists files but skips internal directories", async () => {
+    await mkdir(join(root, ".dohc"), { recursive: true });
+    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
+    await mkdir(join(root, "notes"), { recursive: true });
+    await writeFile(join(root, "notes", "a.md"), "");
+    await writeFile(join(root, "wallet.sqlite"), "");
+    const files = await listFiles(root);
+    expect(files).toEqual([
+      { path: "notes/a.md", kind: "file" },
+      { path: "wallet.sqlite", kind: "database" },
+    ]);
+  });
+});
+
+describe("copyIntoWorkspace", () => {
+  it("copies external files into the workspace root by basename", async () => {
+    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
+    await writeFile(join(outside, "receipt.png"), "png-bytes");
+    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
+    expect(imported).toEqual(["receipt.png"]);

exec
/bin/bash -lc "git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/vitest.config.ts | sed -n '520,760p'" in /home/ice/dev/dohc
 succeeded in 0ms:
exec
/bin/bash -lc 'git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/vitest.config.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:26:33 2026 +0800

    phase3: Add native desktop workspace shell
    
    First-run creates real workspace folders (suggested ~/dohc, manifest
    via workspace-core, no account); shell ships every plan-required
    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
    never overwrites), truthful cloud-sync offer, agent activity panel,
    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
    Design review loop: 2 iterations, all hard items pass, judges
    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
    E2E (real on-disk assertions, relaunch persistence).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/src/workspaces/workspaceFiles.test.ts b/apps/desktop/src/workspaces/workspaceFiles.test.ts
new file mode 100644
index 0000000..f749cfd
--- /dev/null
+++ b/apps/desktop/src/workspaces/workspaceFiles.test.ts
@@ -0,0 +1,64 @@
+import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { beforeEach, describe, expect, it } from "vitest";
+import { copyIntoWorkspace, createFile, listFiles } from "./workspaceFiles";
+
+let root: string;
+
+beforeEach(async () => {
+  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
+});
+
+describe("createFile", () => {
+  it("creates nested files through validated paths", async () => {
+    const path = await createFile(root, "notes/./today.md");
+    expect(path).toBe("notes/today.md");
+    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
+  });
+
+  it("rejects traversal and reserved paths", async () => {
+    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
+    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
+  });
+
+  it("never overwrites an existing file", async () => {
+    await writeFile(join(root, "keep.md"), "original");
+    await createFile(root, "keep.md");
+    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
+  });
+});
+
+describe("listFiles", () => {
+  it("lists files but skips internal directories", async () => {
+    await mkdir(join(root, ".dohc"), { recursive: true });
+    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
+    await mkdir(join(root, "notes"), { recursive: true });
+    await writeFile(join(root, "notes", "a.md"), "");
+    await writeFile(join(root, "wallet.sqlite"), "");
+    const files = await listFiles(root);
+    expect(files).toEqual([
+      { path: "notes/a.md", kind: "file" },
+      { path: "wallet.sqlite", kind: "database" },
+    ]);
+  });
+});
+
+describe("copyIntoWorkspace", () => {
+  it("copies external files into the workspace root by basename", async () => {
+    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
+    await writeFile(join(outside, "receipt.png"), "png-bytes");
+    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
+    expect(imported).toEqual(["receipt.png"]);
+    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
+  });
+
+  it("skips files that already exist instead of overwriting", async () => {
+    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
+    await writeFile(join(outside, "notes.md"), "incoming");
+    await writeFile(join(root, "notes.md"), "existing");
+    const imported = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
+    expect(imported).toEqual([]);
+    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
+  });
+});
diff --git a/apps/desktop/vitest.config.ts b/apps/desktop/vitest.config.ts
index cfd92e3..1f7ba79 100644
--- a/apps/desktop/vitest.config.ts
+++ b/apps/desktop/vitest.config.ts
@@ -1,8 +1,8 @@
 import { defineConfig } from "vitest/config";
 
 // e2e/ runs under Playwright (playwright.config.ts), never vitest.
 export default defineConfig({
   test: {
-    include: ["src/**/*.test.ts"],
+    include: ["src/**/*.test.{ts,tsx}"],
   },
 });

exec
/bin/bash -lc "ls packages && git ls-files packages/workspace-core packages/brand apps/desktop/src | sed -n '1,200p'" in /home/ice/dev/dohc
 succeeded in 0ms:
brand
config
workspace-contracts
workspace-convex-compat
workspace-core
workspace-fs
workspace-postgres
apps/desktop/src/ipc/bridgeContract.ts
apps/desktop/src/ipc/channels.ts
apps/desktop/src/main.ts
apps/desktop/src/performance/launchMarks.ts
apps/desktop/src/preload.ts
apps/desktop/src/renderer/CommandPalette.tsx
apps/desktop/src/renderer/DesktopFirstRun.test.tsx
apps/desktop/src/renderer/DesktopFirstRun.tsx
apps/desktop/src/renderer/DesktopRoot.tsx
apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
apps/desktop/src/renderer/NewFileDialog.tsx
apps/desktop/src/renderer/bridge.ts
apps/desktop/src/renderer/index.html
apps/desktop/src/renderer/main.tsx
apps/desktop/src/renderer/styles.css
apps/desktop/src/renderer/theme.ts
apps/desktop/src/security/electronSecurity.test.ts
apps/desktop/src/security/electronSecurity.ts
apps/desktop/src/window/createMainWindow.ts
apps/desktop/src/workspaces/WorkspaceRegistry.ts
apps/desktop/src/workspaces/createWorkspaceFolder.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/workspaceFiles.ts
packages/brand/package.json
packages/brand/src/DohcLogo.tsx
packages/brand/src/constants.ts
packages/brand/src/index.ts
packages/brand/src/tokens.css
packages/workspace-core/package.json
packages/workspace-core/src/changeSet.test.ts
packages/workspace-core/src/changeSet.ts
packages/workspace-core/src/conflicts.ts
packages/workspace-core/src/index.ts
packages/workspace-core/src/metadata.ts
packages/workspace-core/src/paths.test.ts
packages/workspace-core/src/paths.ts
packages/workspace-core/src/workspaceMode.test.ts
packages/workspace-core/src/workspaceMode.ts
packages/workspace-core/tsconfig.json

exec
/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/index.ts && sed -n '1,240p' packages/workspace-core/src/paths.ts && sed -n '1,240p' packages/workspace-core/src/workspaceMode.ts && cat packages/workspace-core/package.json" in /home/ice/dev/dohc
 succeeded in 0ms:
export * from "./workspaceMode";
export * from "./metadata";
export * from "./paths";
export * from "./changeSet";
export * from "./conflicts";
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
{
  "name": "@dohc/workspace-core",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.19.19",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}

exec
/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/metadata.ts && sed -n '1,180p' packages/workspace-core/src/paths.test.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
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
/bin/bash -lc "grep -R \"personal\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md packages/workspace-core apps/desktop | sed -n '1,200p'" in /home/ice/dev/dohc
 succeeded in 0ms:
grep: apps/desktop/node_modules/.bin/tsc: No such file or directory
grep: apps/desktop/node_modules/.bin/tsserver: No such file or directory
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:108:- Local-only personal workspace edits should not require approval.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:692:expect(defaultWorkspaceMode("personal")).toBe("local-first");
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:725:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:938:- creates `personal` workspace.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1038:Tests must assert creating `personal` writes:
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1041:~/dohc/personal/
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1053:  "kind": "personal"
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1434:- local-first personal workspace can sync after login.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1536:- local-first personal workspaces work fully without Hocuspocus running.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2307:2. create local-only personal workspace with no account.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2372:- personal workspace defaults to local-first.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2481:- Local-only personal workspace works with no account.
packages/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
packages/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
packages/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
packages/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
apps/desktop/src/ipc/bridgeContract.ts:17:  kind: z.enum(["personal", "shared", "cloud-only"]),
apps/desktop/src/ipc/bridgeContract.ts:31:  kind: z.enum(["personal", "shared"]),
apps/desktop/src/workspaces/createWorkspaceFolder.ts:25:  kind: Extract<WorkspaceKind, "personal" | "shared">;
apps/desktop/src/renderer/DesktopFirstRun.tsx:30:        rootPath: `${root}/personal`,
apps/desktop/src/renderer/DesktopFirstRun.tsx:31:        kind: "personal",
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:13:    rootPath: "/home/ice/dohc/personal",
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:14:    kind: "personal" as const,
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:48:  it("creates a personal workspace and hands it to the shell", async () => {
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:56:      expect.objectContaining({ kind: "personal" }),
apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
apps/desktop/dist/main/main.js:23:	personal: "local-first",
apps/desktop/dist/main/main.js:115:		"personal",
apps/desktop/dist/main/main.js:129:	kind: z.enum(["personal", "shared"])
apps/desktop/dist/renderer/assets/index-Cdgr5hPX.js:10264:				rootPath: `${root}/personal`,
apps/desktop/dist/renderer/assets/index-Cdgr5hPX.js:10265:				kind: "personal"
apps/desktop/e2e/firstRunWorkspace.spec.ts:74:  const workspaceRoot = join(testHome, "dohc", "personal");
apps/desktop/e2e/firstRunWorkspace.spec.ts:81:    kind: "personal",
apps/desktop/e2e/firstRunWorkspace.spec.ts:135:  await expect(switcherList).toContainText("personal");

exec
/bin/bash -lc "sed -n '930,1065p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:
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

- workspace switcher.
- local sync status.
- file tree.
- editor/preview/app area.
- agent/activity panel.
- command palette.
- upload/import action.
- cloud sync connect button.

Avoid landing-page UI. First screen should be the usable workspace.

Visual style requirements:

- preserve dohc's current simple muted styling.
- use warm paper/graphite foundations.
- keep sidebar density close to Obsidian/t3code rather than a SaaS dashboard.
- use restrained hover/active states.
- keep cards only for repeated items, modals, and genuinely framed tools.
- make command palette and file switcher keyboard-first.
- keep text readable and compact; no hero-sized type inside tool surfaces.
- no decorative gradients/orbs/bokeh.
- no AI-generated marketing copy inside the app shell.

- [ ] **Step 4: Run visual smoke**

```bash
pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
```

Expected:

- screenshot saved.
- nonblank desktop shell.
- no overlapping text.
- first workspace created.
- first-run and workspace shell screenshots look native, muted, and consistent with dohc.
- command palette and file tree are visibly usable.

- [ ] **Step 5: Delete-or-justify**

Identify web-only onboarding UI that should not exist in desktop. Delete it if not needed for web/cloud-only; otherwise isolate it under web-only code.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop apps/app/src docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add native desktop workspace shell"
```

---

## Phase 4: Local Workspace Registry And Folder Creation

**Files:**

- Create: `apps/desktop/src/workspaces/WorkspaceRegistry.ts`
- Create: `apps/desktop/src/workspaces/WorkspaceRegistry.test.ts`
- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
- Modify: `apps/desktop/src/ipc/bridgeContract.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
- Modify: `packages/workspace-core/src/metadata.ts`

- [ ] **Step 1: Write failing registry tests**

Tests must assert:

- default root is suggested as `${home}/dohc`.
- multiple attached folders are supported.
- duplicate folder attachment is rejected.
- local-only workspace does not require account.
- shared/cloud workspaces record remote identity only after sync is enabled.

- [ ] **Step 2: Write failing folder creation tests**

Tests must assert creating `personal` writes:

```txt
~/dohc/personal/
  .dohc/manifest.json
  .context/me.md
```

Manifest includes:

```json
{
  "version": 1,
  "workspaceId": "...",
  "mode": "local-first",
  "kind": "personal"
}
```

- [ ] **Step 3: Implement registry and folder creation**

Use Electron safe storage or app user data path for the registry. Visible workspace content lives where the user chose.

- [ ] **Step 4: Wire IPC**

Expose validated desktop bridge methods:

```ts

exec
/bin/bash -lc "sed -n '1065,1165p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:
```ts
listLocalWorkspaces()
createLocalWorkspace(input)
attachWorkspaceFolder(input)
chooseWorkspaceRoot()
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/desktop test src/workspaces
pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add local workspace registry"
```

---

## Phase 5: File Watcher, Batched Sync, And Local-First History

**Files:**

- Modify: `packages/workspace-fs/src/watch.ts`
- Modify: `packages/workspace-fs/src/scan.ts`
- Modify: `packages/workspace-fs/src/diff.ts`
- Create: `packages/workspace-sync/package.json`
- Create: `packages/workspace-sync/tsconfig.json`
- Create: `packages/workspace-sync/src/batchedSync.ts`
- Create: `packages/workspace-sync/src/batchedSync.test.ts`
- Create: `packages/workspace-history/package.json`
- Create: `packages/workspace-history/src/changeSetStore.ts`
- Create: `packages/workspace-history/src/changeSetStore.test.ts`
- Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`

- [ ] **Step 1: Install watcher dependency**

```bash
pnpm add --filter @dohc/workspace-fs chokidar
```

- [ ] **Step 2: Write failing batched sync tests**

Tests must assert:

- single markdown save syncs after settle delay.
- 18 app-file writes group into one change set.
- temp files are ignored.
- SQLite WAL/journal writes do not sync raw transient files.
- generated app build output under `.dohc/cache` does not sync as user content.

- [ ] **Step 3: Write failing history tests**

Tests must assert:

- change set records user/agent/import/sync kind.
- provenance points to source prompt/import/agent run where available.
- human summary is generated or stored.
- no Git conflict markers appear in user files.
- the history store exposes an ordered change-set timeline queryable by the desktop UI: kind, author (human or agent), plain-language summary, files touched.

- [ ] **Step 4: Implement batched sync**

Use settled windows:

```txt
markdown/text: 500ms-2s
app folders: group until quiet for 2s
SQLite files: wait for WAL/journal settle or explicit import operation
bulk changes: group as one change set
```

- [ ] **Step 5: Implement local history store**

Store history under:

```txt
.dohc/history/
.dohc/changes/
```

Do not require Git.

- [ ] **Step 6: Wire desktop sync status and history surface**

Desktop shell shows:

- synced
- syncing
- local changes
- conflict
- cloud disconnected

Also wire the workspace history surface — the "git log for everyday people":


 succeeded in 82149ms:
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
/bin/bash -lc 'cat apps/desktop/tsconfig.json 2>/dev/null || ls apps/desktop && cat tsconfig.json' in /home/ice/dev/dohc
 exited 1 in 0ms:
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "electron.vite.config.ts", "playwright.config.ts"]
}
cat: tsconfig.json: No such file or directory

exec
/bin/bash -lc 'cat tsconfig.base.json && cat apps/desktop/playwright.config.ts && cat pnpm-workspace.yaml && cat package.json' in /home/ice/dev/dohc
 succeeded in 0ms:
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowJs": true,
    "isolatedModules": true,
    "incremental": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
import { defineConfig } from "@playwright/test";

// Dedicated desktop E2E config: Electron instances cannot safely run in
// parallel on one display, and the web app's dev server is irrelevant here.
// The root playwright.config.ts stays untouched for `pnpm test:e2e` (web).
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-e2e",
});
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

exec
/bin/bash -lc 'ls -l node_modules/playwright node_modules/@playwright/test apps/desktop/node_modules/playwright apps/desktop/node_modules/@playwright/test 2>/dev/null || true' in /home/ice/dev/dohc
 succeeded in 0ms:
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
/bin/bash -lc 'pnpm --filter @dohc/desktop exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
 exited 1 in 463ms:
 ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)

Your pnpm version is incompatible with "/home/ice/dev/dohc".

Expected version: 10.24.0
Got: 9.14.4

This is happening because the package's manifest has an engines.pnpm field specified.
To fix this issue, install the required pnpm version globally.

To install the latest version of pnpm, run "pnpm i -g pnpm".
To check your pnpm version, run "pnpm -v".

exec
/bin/bash -lc './node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
 succeeded in 1776ms:
exec
/bin/bash -lc './node_modules/.bin/vitest run --config apps/desktop/vitest.config.ts' in /home/ice/dev/dohc
 exited 1 in 273ms:
failed to load config from /home/ice/dev/dohc/apps/desktop/vitest.config.ts

⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
Error: EROFS: read-only file system, open '/home/ice/dev/dohc/apps/desktop/vitest.config.ts.timestamp-1781087367407-9f620007f5cc1.mjs'
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
  path: '/home/ice/dev/dohc/apps/desktop/vitest.config.ts.timestamp-1781087367407-9f620007f5cc1.mjs'
}




exec
/bin/bash -lc "cat packages/brand/package.json && sed -n '1,160p' packages/brand/src/tokens.css" in /home/ice/dev/dohc
 succeeded in 0ms:
{
  "name": "@dohc/brand",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/tokens.css"
  },
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "react": "^19.2.5"
  }
}
/* dohc brand tokens — source of truth for the design system.
 *
 * Brand tokens are kept separate from component tokens so future theme
 * work can change surfaces without changing the brand itself. Mirrors
 * dohc-brand-bible.html sections 03 (color) and 04 (type). */

:root {
  --font-serif: 'Iowan Old Style', 'Charter', Georgia, serif;
  --font-sans: 'Aptos', 'Segoe UI', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace;

  /* Light mode (warm paper) */
  --dohc-bg: #f7f6f1;
  --dohc-panel: #fffefa;
  --dohc-panel-2: #ece9e1;
  --dohc-ink: #151515;
  --dohc-muted: #66635d;
  --dohc-subtle: #8b867b;
  --dohc-accent: #2d342e;
  --dohc-line: rgba(21, 21, 21, 0.12);
  --dohc-grid: rgba(21, 21, 21, 0.026);

  /* Semantic state colors — muted, functional, never decorative */
  --dohc-success: #4f7666;
  --dohc-warning: #a77a35;
  --dohc-danger: #b64b37;
  --dohc-info: #3868a6;
}

[data-theme='dark'] {
  /* Dark mode — warm ink, never pure black/white. Neutral-charcoal
   * background, faint green-black card surface, darker neutral-charcoal
   * side panels (panel-2). */
  --dohc-bg: #100f0e;
  --dohc-panel: #191c1a;
  --dohc-panel-2: #0e0e0d;
  --dohc-ink: #f4f1ea;
  --dohc-muted: #aaa69c;
  --dohc-subtle: #78746d;
  --dohc-accent: #d7d0c0;
  --dohc-line: rgba(244, 241, 234, 0.14);
  --dohc-grid: rgba(244, 241, 234, 0.035);
}

exec
/bin/bash -lc "nl -ba apps/desktop/src/workspaces/createWorkspaceFolder.ts | sed -n '1,120p'
nl -ba apps/desktop/src/renderer/DesktopWorkspaceShell.tsx | sed -n '1,240p'
nl -ba apps/desktop/src/workspaces/WorkspaceRegistry.ts | sed -n '1,120p'
nl -ba apps/desktop/src/main.ts | sed -n '1,150p'
nl -ba apps/desktop/src/workspaces/workspaceFiles.ts | sed -n '1,120p'" in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import {
     2	  createWorkspaceManifest,
     3	  defaultWorkspaceMode,
     4	  type WorkspaceKind,
     5	} from "@dohc/workspace-core";
     6	import { randomUUID } from "node:crypto";
     7	import { mkdir, writeFile } from "node:fs/promises";
     8	import { join } from "node:path";
     9	
    10	export interface CreatedWorkspace {
    11	  workspaceId: string;
    12	  rootPath: string;
    13	  kind: WorkspaceKind;
    14	  mode: ReturnType<typeof defaultWorkspaceMode>;
    15	}
    16	
    17	const FIRST_CONTEXT = `# About me
    18	
    19	Tell your agents who you are and how you like to work.
    20	This file lives at .context/me.md inside your workspace folder.
    21	`;
    22	
    23	export async function createWorkspaceFolder(input: {
    24	  rootPath: string;
    25	  kind: Extract<WorkspaceKind, "personal" | "shared">;
    26	}): Promise<CreatedWorkspace> {
    27	  const manifest = createWorkspaceManifest({
    28	    workspaceId: randomUUID(),
    29	    kind: input.kind,
    30	  });
    31	
    32	  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
    33	  await mkdir(join(input.rootPath, ".context"), { recursive: true });
    34	  await writeFile(
    35	    join(input.rootPath, ".dohc", "manifest.json"),
    36	    `${JSON.stringify(manifest, null, 2)}\n`,
    37	  );
    38	  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
    39	    flag: "wx",
    40	  }).catch((error: unknown) => {
    41	    // An existing me.md is the user's; never overwrite it. Real failures
    42	    // (permissions, disk) must still surface.
    43	    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    44	  });
    45	
    46	  return {
    47	    workspaceId: manifest.workspaceId,
    48	    rootPath: input.rootPath,
    49	    kind: input.kind,
    50	    mode: manifest.mode,
    51	  };
    52	}
     1	import {
     2	  Bot,
     3	  Check,
     4	  ChevronsUpDown,
     5	  Cloud,
     6	  Database,
     7	  FilePlus2,
     8	  FileText,
     9	  Import,
    10	  LayoutGrid,
    11	} from "lucide-react";
    12	import { useCallback, useEffect, useMemo, useState } from "react";
    13	import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
    14	import { bridge } from "./bridge";
    15	import { CommandPalette, type Command } from "./CommandPalette";
    16	import { NewFileDialog } from "./NewFileDialog";
    17	import { toggleTheme } from "./theme";
    18	
    19	export type Workspace = WorkspaceSummary;
    20	
    21	function workspaceName(workspace: Workspace): string {
    22	  return workspace.rootPath.split("/").pop() ?? "workspace";
    23	}
    24	
    25	function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
    26	  if (kind === "database") return <Database size={13} aria-hidden />;
    27	  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
    28	  return <FileText size={13} aria-hidden />;
    29	}
    30	
    31	export function DesktopWorkspaceShell(props: {
    32	  workspace: Workspace;
    33	  workspaces: Workspace[];
    34	  onSwitchWorkspace: (workspace: Workspace) => void;
    35	}) {
    36	  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
    37	  const [selected, setSelected] = useState<string | null>(null);
    38	  const [paletteOpen, setPaletteOpen] = useState(false);
    39	  const [newFileOpen, setNewFileOpen] = useState(false);
    40	  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
    41	  const [switcherOpen, setSwitcherOpen] = useState(false);
    42	  const [cloudOpen, setCloudOpen] = useState(false);
    43	
    44	  const importFiles = useCallback(async () => {
    45	    await bridge().importWorkspaceFiles({
    46	      workspaceId: props.workspace.workspaceId,
    47	    });
    48	    const result = await bridge().listWorkspaceFiles({
    49	      workspaceId: props.workspace.workspaceId,
    50	    });
    51	    setFiles(result.files);
    52	  }, [props.workspace.workspaceId]);
    53	
    54	  const refreshFiles = useCallback(async () => {
    55	    const result = await bridge().listWorkspaceFiles({
    56	      workspaceId: props.workspace.workspaceId,
    57	    });
    58	    setFiles(result.files);
    59	  }, [props.workspace.workspaceId]);
    60	
    61	  useEffect(() => {
    62	    void refreshFiles();
    63	  }, [refreshFiles]);
    64	
    65	  useEffect(() => {
    66	    function onKeyDown(event: KeyboardEvent) {
    67	      const mod = event.metaKey || event.ctrlKey;
    68	      if (!mod) return;
    69	      if (event.key === "n") {
    70	        event.preventDefault();
    71	        setNewFileOpen(true);
    72	      } else if (event.key === "k") {
    73	        event.preventDefault();
    74	        setPaletteOpen((open) => !open);
    75	      } else if (event.key === "p") {
    76	        event.preventDefault();
    77	        setQuickOpenOpen((open) => !open);
    78	      }
    79	    }
    80	    window.addEventListener("keydown", onKeyDown);
    81	    return () => window.removeEventListener("keydown", onKeyDown);
    82	  }, []);
    83	
    84	  const commands = useMemo<Command[]>(
    85	    () => [
    86	      {
    87	        id: "new-file",
    88	        label: "New file",
    89	        run: () => setNewFileOpen(true),
    90	      },
    91	      {
    92	        id: "quick-open",
    93	        label: "Go to file",
    94	        run: () => setQuickOpenOpen(true),
    95	      },
    96	      {
    97	        id: "import-files",
    98	        label: "Import files into workspace",
    99	        run: () => void importFiles(),
   100	      },
   101	      {
   102	        id: "connect-cloud",
   103	        label: "Connect dohc Cloud",
   104	        run: () => setCloudOpen(true),
   105	      },
   106	      {
   107	        id: "toggle-theme",
   108	        label: "Toggle light/dark theme",
   109	        run: toggleTheme,
   110	      },
   111	    ],
   112	    [importFiles],
   113	  );
   114	
   115	  return (
   116	    <div
   117	      data-testid="workspace-shell"
   118	      className="app-chrome flex h-screen flex-col bg-bg text-ink"
   119	    >
   120	      <div className="flex min-h-0 flex-1">
   121	        {/* Sidebar */}
   122	        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2">
   123	          <header className="relative border-b border-line">
   124	            <button
   125	              type="button"
   126	              data-testid="workspace-switcher"
   127	              aria-haspopup="listbox"
   128	              aria-expanded={switcherOpen}
   129	              onClick={() => setSwitcherOpen((open) => !open)}
   130	              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-panel"
   131	            >
   132	              <span className="truncate text-[13px] font-semibold">
   133	                {workspaceName(props.workspace)}
   134	              </span>
   135	              <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
   136	            </button>
   137	            {switcherOpen ? (
   138	              <ul
   139	                role="listbox"
   140	                aria-label="Workspaces"
   141	                className="absolute left-2 right-2 top-full z-20 mt-1 m-0 list-none rounded border border-line bg-panel p-1 shadow-md"
   142	              >
   143	                {props.workspaces.map((candidate) => (
   144	                  <li key={candidate.workspaceId} role="option" aria-selected={candidate.workspaceId === props.workspace.workspaceId}>
   145	                    <button
   146	                      type="button"
   147	                      onClick={() => {
   148	                        setSwitcherOpen(false);
   149	                        props.onSwitchWorkspace(candidate);
   150	                      }}
   151	                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-muted hover:text-ink"
   152	                    >
   153	                      {candidate.workspaceId === props.workspace.workspaceId ? (
   154	                        <Check size={12} aria-hidden />
   155	                      ) : (
   156	                        <span className="w-3" aria-hidden />
   157	                      )}
   158	                      <span className="truncate">{workspaceName(candidate)}</span>
   159	                      <span className="ml-auto text-[10px] uppercase text-subtle">
   160	                        {candidate.kind}
   161	                      </span>
   162	                    </button>
   163	                  </li>
   164	                ))}
   165	              </ul>
   166	            ) : null}
   167	          </header>
   168	
   169	          <nav
   170	            data-testid="file-tree"
   171	            aria-label="Files"
   172	            className="min-h-0 flex-1 overflow-y-auto py-1"
   173	          >
   174	            {files.length === 0 ? (
   175	              <button
   176	                type="button"
   177	                onClick={() => setNewFileOpen(true)}
   178	                className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
   179	              >
   180	                <FilePlus2 size={13} aria-hidden />
   181	                Create your first file
   182	              </button>
   183	            ) : (
   184	              <ul className="m-0 list-none p-0">
   185	                {files.map((file) => (
   186	                  <li key={file.path}>
   187	                    <button
   188	                      type="button"
   189	                      onClick={() => setSelected(file.path)}
   190	                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
   191	                        selected === file.path
   192	                          ? "bg-panel text-ink"
   193	                          : "text-muted hover:text-ink"
   194	                      }`}
   195	                    >
   196	                      <FileIcon kind={file.kind} />
   197	                      <span className="truncate">{file.path}</span>
   198	                    </button>
   199	                  </li>
   200	                ))}
   201	              </ul>
   202	            )}
   203	          </nav>
   204	
   205	          <footer className="flex flex-col gap-1 border-t border-line px-3 py-1.5">
   206	            <button
   207	              type="button"
   208	              onClick={() => setNewFileOpen(true)}
   209	              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
   210	            >
   211	              <FilePlus2 size={13} aria-hidden />
   212	              New file
   213	              <kbd className="ml-auto font-mono text-[10px] text-subtle">
   214	                Ctrl N
   215	              </kbd>
   216	            </button>
   217	            <button
   218	              type="button"
   219	              onClick={() => void importFiles()}
   220	              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
   221	            >
   222	              <Import size={13} aria-hidden />
   223	              Import files
   224	            </button>
   225	          </footer>
   226	        </aside>
   227	
   228	        {/* Main area */}
   229	        <main className="flex min-w-0 flex-1 items-center justify-center bg-bg">
   230	          {selected ? (
   231	            <div className="flex flex-col items-center gap-1 text-center">
   232	              <span className="font-mono text-[13px] text-ink">{selected}</span>
   233	              <span className="text-xs text-subtle">
   234	                File editing arrives with the editor surface.
   235	              </span>
   236	            </div>
   237	          ) : (
   238	            <div className="flex flex-col items-center gap-2 text-center">
   239	              <span className="text-sm text-muted">
   240	                Select a file, or create one
     1	import { app } from "electron";
     2	import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
     3	import { homedir } from "node:os";
     4	import { dirname, join } from "node:path";
     5	import type { CreatedWorkspace } from "./createWorkspaceFolder";
     6	
     7	// Registry of known local workspaces. Lives in Electron userData; in test
     8	// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
     9	// formalizes attachment/duplicate rules with dedicated tests.
    10	
    11	function testHome(): string | null {
    12	  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
    13	    ? (process.env.DOHC_TEST_HOME ?? null)
    14	    : null;
    15	}
    16	
    17	export function effectiveHome(): string {
    18	  return testHome() ?? homedir();
    19	}
    20	
    21	function registryPath(): string {
    22	  const base = testHome() ?? app.getPath("userData");
    23	  return join(base, "dohc-workspaces.json");
    24	}
    25	
    26	interface RegistryFile {
    27	  version: 1;
    28	  workspaces: CreatedWorkspace[];
    29	}
    30	
    31	function readRegistry(): RegistryFile {
    32	  try {
    33	    const parsed = JSON.parse(
    34	      readFileSync(registryPath(), "utf8"),
    35	    ) as RegistryFile;
    36	    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
    37	  } catch {
    38	    return { version: 1, workspaces: [] };
    39	  }
    40	}
    41	
    42	function writeRegistry(registry: RegistryFile): void {
    43	  mkdirSync(dirname(registryPath()), { recursive: true });
    44	  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
    45	}
    46	
    47	export function listWorkspaces(): CreatedWorkspace[] {
    48	  return readRegistry().workspaces;
    49	}
    50	
    51	export function registerWorkspace(workspace: CreatedWorkspace): void {
    52	  const registry = readRegistry();
    53	  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
    54	    return;
    55	  }
    56	  registry.workspaces.push(workspace);
    57	  writeRegistry(registry);
    58	}
    59	
    60	export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
    61	  return (
    62	    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
    63	    null
    64	  );
    65	}
     1	import { defaultWorkspaceRoot } from "@dohc/workspace-core";
     2	import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
     3	import {
     4	  CreateLocalWorkspacePayload,
     5	  CreateWorkspaceFilePayload,
     6	  CreateWorkspaceFileResult,
     7	  DefaultWorkspaceRootResult,
     8	  ImportWorkspaceFilesPayload,
     9	  ImportWorkspaceFilesResult,
    10	  LaunchMarksResult,
    11	  ListWorkspaceFilesPayload,
    12	  ListWorkspaceFilesResult,
    13	  PickWorkspaceRootResult,
    14	  VersionResult,
    15	  WorkspaceRegistryResult,
    16	  WorkspaceSummary,
    17	} from "./ipc/bridgeContract";
    18	import { CHANNELS } from "./ipc/channels";
    19	import { launchMarks } from "./performance/launchMarks";
    20	import { decideNavigation } from "./security/electronSecurity";
    21	import { navigationPolicy } from "./window/createMainWindow";
    22	import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
    23	import {
    24	  effectiveHome,
    25	  findWorkspace,
    26	  listWorkspaces,
    27	  registerWorkspace,
    28	} from "./workspaces/WorkspaceRegistry";
    29	import {
    30	  copyIntoWorkspace,
    31	  createFile,
    32	  listFiles,
    33	} from "./workspaces/workspaceFiles";
    34	
    35	function requireWorkspace(workspaceId: string) {
    36	  const workspace = findWorkspace(workspaceId);
    37	  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    38	  return workspace;
    39	}
    40	
    41	// IPC is an untrusted boundary: handlers only answer frames the navigation
    42	// policy itself would allow (exact dev origin or the packaged bundle).
    43	function isTrustedFrame(frameUrl: string): boolean {
    44	  return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
    45	}
    46	
    47	function assertTrustedSender(event: IpcMainInvokeEvent): void {
    48	  const frameUrl = event.senderFrame?.url ?? "";
    49	  if (!isTrustedFrame(frameUrl)) {
    50	    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
    51	  }
    52	}
    53	
    54	function registerIpcHandlers(): void {
    55	  ipcMain.handle(CHANNELS.getVersion, (event) => {
    56	    assertTrustedSender(event);
    57	    return VersionResult.parse(app.getVersion());
    58	  });
    59	
    60	  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
    61	    assertTrustedSender(event);
    62	    const result = await dialog.showOpenDialog({
    63	      properties: ["openDirectory", "createDirectory"],
    64	    });
    65	    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    66	    return PickWorkspaceRootResult.parse(picked);
    67	  });
    68	
    69	  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
    70	    assertTrustedSender(event);
    71	    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
    72	  });
    73	
    74	  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
    75	    assertTrustedSender(event);
    76	    return DefaultWorkspaceRootResult.parse(
    77	      defaultWorkspaceRoot(effectiveHome()),
    78	    );
    79	  });
    80	
    81	  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
    82	    assertTrustedSender(event);
    83	    const input = CreateLocalWorkspacePayload.parse(payload);
    84	    const created = await createWorkspaceFolder(input);
    85	    registerWorkspace(created);
    86	    return WorkspaceSummary.parse(created);
    87	  });
    88	
    89	  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
    90	    assertTrustedSender(event);
    91	    const input = ListWorkspaceFilesPayload.parse(payload);
    92	    const workspace = requireWorkspace(input.workspaceId);
    93	    return ListWorkspaceFilesResult.parse({
    94	      files: await listFiles(workspace.rootPath),
    95	    });
    96	  });
    97	
    98	  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
    99	    assertTrustedSender(event);
   100	    const input = CreateWorkspaceFilePayload.parse(payload);
   101	    const workspace = requireWorkspace(input.workspaceId);
   102	    const path = await createFile(workspace.rootPath, input.relativePath);
   103	    return CreateWorkspaceFileResult.parse({ path });
   104	  });
   105	
   106	  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
   107	    assertTrustedSender(event);
   108	    const input = ImportWorkspaceFilesPayload.parse(payload);
   109	    const workspace = requireWorkspace(input.workspaceId);
   110	    const result = await dialog.showOpenDialog({
   111	      properties: ["openFile", "multiSelections"],
   112	      title: "Import files into workspace",
   113	    });
   114	    const imported = result.canceled
   115	      ? []
   116	      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
   117	    return ImportWorkspaceFilesResult.parse({ imported });
   118	  });
   119	
   120	  ipcMain.on(CHANNELS.firstPaint, (event) => {
   121	    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
   122	      launchMarks.firstPaint();
   123	    }
   124	  });
   125	
   126	  // Double-gated: env flag AND unpackaged build. A packaged app launched
   127	  // with the env var set must never grow test surface.
   128	  if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
   129	    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
   130	      assertTrustedSender(event);
   131	      return LaunchMarksResult.parse(launchMarks.snapshot());
   132	    });
   133	  }
   134	}
   135	
   136	// Single-instance lock gates the entire bootstrap, not just a quit() call.
   137	if (!app.requestSingleInstanceLock()) {
   138	  app.quit();
   139	} else {
   140	  void app.whenReady().then(async () => {
   141	    launchMarks.appReady();
   142	    registerIpcHandlers();
   143	    const { createMainWindow } = await import("./window/createMainWindow");
   144	    createMainWindow();
   145	    launchMarks.firstWindow();
   146	  });
   147	
   148	  app.on("window-all-closed", () => {
   149	    if (process.platform !== "darwin") app.quit();
   150	  });
     1	import {
     2	  classifyPath,
     3	  validateUserWritePath,
     4	} from "@dohc/workspace-core";
     5	import { constants } from "node:fs";
     6	import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
     7	import { basename, dirname, join } from "node:path";
     8	import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
     9	
    10	const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
    11	
    12	export async function listFiles(
    13	  rootPath: string,
    14	): Promise<WorkspaceFileEntry[]> {
    15	  const entries: WorkspaceFileEntry[] = [];
    16	
    17	  async function walk(dir: string, prefix: string): Promise<void> {
    18	    const dirents = await readdir(dir, { withFileTypes: true });
    19	    for (const dirent of dirents) {
    20	      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    21	      if (dirent.isDirectory()) {
    22	        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
    23	      } else {
    24	        const classified = classifyPath(rel);
    25	        entries.push({
    26	          path: rel,
    27	          kind: classified.kind === "database" ? "database"
    28	            : classified.kind === "app-source" ? "app-source"
    29	            : "file",
    30	        });
    31	      }
    32	    }
    33	  }
    34	
    35	  await walk(rootPath, "");
    36	  entries.sort((a, b) => a.path.localeCompare(b.path));
    37	  return entries;
    38	}
    39	
    40	export async function createFile(
    41	  rootPath: string,
    42	  relativePath: string,
    43	): Promise<string> {
    44	  const validated = validateUserWritePath(relativePath);
    45	  if (!validated.ok) {
    46	    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
    47	  }
    48	  const absolute = join(rootPath, validated.normalized);
    49	  await mkdir(dirname(absolute), { recursive: true });
    50	  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
    51	    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    52	  });
    53	  return validated.normalized;
    54	}
    55	
    56	// Imports copy external files into the workspace root by basename; existing
    57	// files are never overwritten (skipped, not errored — imports are additive).
    58	export async function copyIntoWorkspace(
    59	  rootPath: string,
    60	  absolutePaths: string[],
    61	): Promise<string[]> {
    62	  const imported: string[] = [];
    63	  for (const source of absolutePaths) {
    64	    const name = basename(source);
    65	    const validated = validateUserWritePath(name);
    66	    if (!validated.ok) continue;
    67	    try {
    68	      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
    69	      imported.push(validated.normalized);
    70	    } catch (error) {
    71	      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    72	    }
    73	  }
    74	  return imported;
    75	}

exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/window/createMainWindow.ts && sed -n '1,240p' apps/desktop/src/security/electronSecurity.ts && sed -n '1,220p' apps/desktop/src/security/electronSecurity.test.ts" in /home/ice/dev/dohc
 succeeded in 117ms:
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
import { describe, expect, it } from "vitest";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  shouldOpenExternally,
  validateDevServerUrl,
} from "./electronSecurity";

describe("main window web preferences", () => {
  it("locks down the renderer: no node, isolated context, sandboxed", () => {
    const prefs = createMainWindowWebPreferences("/abs/path/preload.js");
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
  });

  it("requires an absolute preload path", () => {
    expect(() => createMainWindowWebPreferences("relative/preload.js")).toThrow(
      /absolute/i,
    );
  });
});

describe("navigation policy", () => {
  const policy = {
    httpOrigins: ["http://localhost:5173"],
    fileUrlPrefix: "file:///app/dist/renderer/",
  };

  it("allows in-app navigation", () => {
    expect(
      decideNavigation("file:///app/dist/renderer/index.html", policy),
    ).toEqual({ action: "allow" });
    expect(
      decideNavigation("http://localhost:5173/route", policy),
    ).toEqual({ action: "allow" });
  });

  it("denies navigation to arbitrary external URLs", () => {
    expect(decideNavigation("https://evil.example.com", policy).action).toBe(
      "deny",
    );
  });

  it("denies origin prefix-spoofing (localhost:5173.evil.com)", () => {
    expect(
      decideNavigation("http://localhost:5173.evil.com/x", policy).action,
    ).toBe("deny");
  });

  it("denies local files outside the renderer bundle", () => {
    expect(decideNavigation("file:///etc/passwd", policy).action).toBe("deny");
  });

  it("denies file navigation entirely when no bundle prefix is set (dev)", () => {
    expect(
      decideNavigation("file:///app/dist/renderer/index.html", {
        httpOrigins: ["http://localhost:5173"],
        fileUrlPrefix: null,
      }).action,
    ).toBe("deny");
  });

  it("denies unparseable URLs", () => {
    expect(decideNavigation("not a url", policy).action).toBe("deny");
  });

  it("denies about:blank and javascript: URLs", () => {
    expect(decideNavigation("about:blank", policy).action).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", policy).action).toBe(
      "deny",
    );
  });
});

describe("dev server URL validation", () => {
  it("accepts loopback dev servers in unpackaged builds", () => {
    expect(validateDevServerUrl("http://localhost:5173", false)).toBe(
      "http://localhost:5173",
    );
    expect(validateDevServerUrl("http://127.0.0.1:5173", false)).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("rejects everything in packaged builds", () => {
    expect(validateDevServerUrl("http://localhost:5173", true)).toBeNull();
  });

  it("rejects non-loopback and non-http origins in dev", () => {
    expect(validateDevServerUrl("http://evil.example.com:5173", false)).toBeNull();
    expect(validateDevServerUrl("file:///tmp/x", false)).toBeNull();
    expect(validateDevServerUrl("not a url", false)).toBeNull();
  });
});

describe("window.open policy", () => {
  it("routes http and https targets through the external shell handler", () => {
    expect(shouldOpenExternally("https://dohc.ai/docs")).toBe(true);
    expect(shouldOpenExternally("http://dohc.ai/docs")).toBe(true);
  });

  it("never shells out non-http(s) schemes or junk", () => {
    expect(shouldOpenExternally("file:///etc/passwd")).toBe(false);
    expect(shouldOpenExternally("smb://share/x")).toBe(false);
    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
    expect(shouldOpenExternally("not a url")).toBe(false);
  });
});

exec
/bin/bash -lc "sed -n '1,200p' apps/desktop/src/performance/launchMarks.ts" in /home/ice/dev/dohc
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

exec
/bin/bash -lc "git show --no-ext-diff --unified=60 529c0d4 -- pnpm-lock.yaml | sed -n '1,240p'" in /home/ice/dev/dohc
 succeeded in 0ms:
commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:26:33 2026 +0800

    phase3: Add native desktop workspace shell
    
    First-run creates real workspace folders (suggested ~/dohc, manifest
    via workspace-core, no account); shell ships every plan-required
    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
    never overwrites), truthful cloud-sync offer, agent activity panel,
    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
    Design review loop: 2 iterations, all hard items pass, judges
    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
    E2E (real on-disk assertions, relaunch persistence).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index f071c69..7106877 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -153,142 +153,184 @@ importers:
         specifier: ^4.2.4
         version: 4.3.0
       y-indexeddb:
         specifier: ^9.0.12
         version: 9.0.12(yjs@13.6.30)
       y-prosemirror:
         specifier: ^1.3.7
         version: 1.3.7(prosemirror-model@1.25.7)(prosemirror-state@1.4.4)(prosemirror-view@1.41.8)(y-protocols@1.0.7(yjs@13.6.30))(yjs@13.6.30)
       y-protocols:
         specifier: ^1.0.7
         version: 1.0.7(yjs@13.6.30)
       yjs:
         specifier: ^13.6.30
         version: 13.6.30
       zod:
         specifier: ^3.23.8
         version: 3.25.76
     devDependencies:
       '@edge-runtime/vm':
         specifier: ^4.0.4
         version: 4.0.4
       '@types/js-yaml':
         specifier: ^4.0.9
         version: 4.0.9
       '@types/jsdom':
         specifier: 28.0.3
         version: 28.0.3
       '@types/node':
         specifier: ^22.13.10
         version: 22.19.19
       '@types/prismjs':
         specifier: ^1.26.6
         version: 1.26.6
       '@types/react':
         specifier: ^19.2.14
         version: 19.2.15
       '@types/react-dom':
         specifier: ^19.2.0
         version: 19.2.3(@types/react@19.2.15)
       '@vitejs/plugin-react':
         specifier: ^6.0.1
         version: 6.0.2(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
       concurrently:
         specifier: ^9.1.0
         version: 9.2.1
       convex-test:
         specifier: ^0.0.51
         version: 0.0.51(convex@1.39.1(react@19.2.6))
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vite:
         specifier: ^8.0.10
         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   apps/desktop:
     dependencies:
+      '@dohc/brand':
+        specifier: workspace:*
+        version: link:../../packages/brand
+      '@dohc/workspace-core':
+        specifier: workspace:*
+        version: link:../../packages/workspace-core
       electron-updater:
         specifier: ^6.8.9
         version: 6.8.9
+      lucide-react:
+        specifier: ^1.16.0
+        version: 1.16.0(react@19.2.6)
+      react:
+        specifier: ^19.2.6
+        version: 19.2.6
+      react-dom:
+        specifier: ^19.2.6
+        version: 19.2.6(react@19.2.6)
       zod:
         specifier: ^3.25.76
         version: 3.25.76
     devDependencies:
       '@electron/fuses':
         specifier: ^2.1.2
         version: 2.1.2
+      '@tailwindcss/vite':
+        specifier: ^4.3.0
+        version: 4.3.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+      '@testing-library/dom':
+        specifier: ^10.4.1
+        version: 10.4.1
+      '@testing-library/react':
+        specifier: ^16.3.2
+        version: 16.3.2(@testing-library/dom@10.4.1)(@types/react-dom@19.2.3(@types/react@19.2.15))(@types/react@19.2.15)(react-dom@19.2.6(react@19.2.6))(react@19.2.6)
+      '@testing-library/user-event':
+        specifier: ^14.6.1
+        version: 14.6.1(@testing-library/dom@10.4.1)
       '@types/node':
         specifier: ^22.19.19
         version: 22.19.19
+      '@types/react':
+        specifier: ^19.2.15
+        version: 19.2.15
+      '@types/react-dom':
+        specifier: ^19.2.3
+        version: 19.2.3(@types/react@19.2.15)
+      '@vitejs/plugin-react':
+        specifier: ^6.0.2
+        version: 6.0.2(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
       electron:
         specifier: ^42.4.0
         version: 42.4.0
       electron-builder:
         specifier: ^26.15.2
         version: 26.15.2(electron-builder-squirrel-windows@26.15.2)
       electron-vite:
         specifier: ^5.0.0
         version: 5.0.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+      jsdom:
+        specifier: ^29.1.1
+        version: 29.1.1(@noble/hashes@2.2.0)
+      tailwindcss:
+        specifier: ^4.3.0
+        version: 4.3.0
       typescript:
         specifier: ^5.9.3
         version: 5.9.3
       vite:
         specifier: ^8.0.14
         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/brand:
     devDependencies:
       '@types/react':
         specifier: ^19.2.14
         version: 19.2.15
       react:
         specifier: ^19.2.5
         version: 19.2.6
 
   packages/config: {}
 
   packages/workspace-contracts:
     dependencies:
       zod:
         specifier: ^3.23.8
         version: 3.25.76
     devDependencies:
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/workspace-convex-compat:
     dependencies:
       '@dohc/workspace-contracts':
         specifier: workspace:*
         version: link:../workspace-contracts
       convex:
         specifier: ^1.37.0
         version: 1.39.1(react@19.2.6)
       convex-test:
         specifier: ^0.0.51
         version: 0.0.51(convex@1.39.1(react@19.2.6))
     devDependencies:
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vite:
         specifier: ^8.0.10
         version: 8.0.14(@types/node@25.9.2)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/workspace-core:
     devDependencies:
       '@types/node':
         specifier: ^22.19.19
@@ -552,120 +594,124 @@ packages:
     resolution: {integrity: sha512-+W6cISkXFa1jXsDEdYA8HeevQT/FULhxzR99pxphltZcVaugps53THCeiWA8SguxxpSp3gKPiuYfSWopkLQ4hw==}
     engines: {node: '>=6.9.0'}
 
   '@babel/helper-module-imports@7.28.6':
     resolution: {integrity: sha512-l5XkZK7r7wa9LucGw9LwZyyCUscb4x37JWTPz7swwFE/0FMQAGpiWUZn8u9DzkSBWEcK25jmvubfpw2dnAMdbw==}
     engines: {node: '>=6.9.0'}
 
   '@babel/helper-module-transforms@7.28.6':
     resolution: {integrity: sha512-67oXFAYr2cDLDVGLXTEABjdBJZ6drElUSI7WKp70NrpyISso3plG9SAGEF6y7zbha/wOzUByWWTJvEDVNIUGcA==}
     engines: {node: '>=6.9.0'}
     peerDependencies:
       '@babel/core': ^7.0.0
 
   '@babel/helper-plugin-utils@7.28.6':
     resolution: {integrity: sha512-S9gzZ/bz83GRysI7gAD4wPT/AI3uCnY+9xn+Mx/KPs2JwHJIz1W8PZkg2cqyt3RNOBM8ejcXhV6y8Og7ly/Dug==}
     engines: {node: '>=6.9.0'}
 
   '@babel/helper-plugin-utils@7.29.7':
     resolution: {integrity: sha512-G7sHYigPY17oO5SYWnfD/0MTBwVR781S/JI643e/JhUYgVgWE/61SoW3NH9KWUKyKq5LVh3npif99Wkt6j86Jw==}
     engines: {node: '>=6.9.0'}
 
   '@babel/helper-string-parser@7.27.1':
     resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
     engines: {node: '>=6.9.0'}
 
   '@babel/helper-validator-identifier@7.28.5':
     resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
     engines: {node: '>=6.9.0'}
 
   '@babel/helper-validator-option@7.27.1':
     resolution: {integrity: sha512-YvjJow9FxbhFFKDSuFnVCe2WxXk1zWc22fFePVNEaWJEu8IrZVlda6N0uHwzZrUM1il7NC9Mlp4MaJYbYd9JSg==}
     engines: {node: '>=6.9.0'}

exec
/bin/bash -lc 'git show --check --no-renames 529c0d4' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 18:26:33 2026 +0800

    phase3: Add native desktop workspace shell
    
    First-run creates real workspace folders (suggested ~/dohc, manifest
    via workspace-core, no account); shell ships every plan-required
    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
    never overwrites), truthful cloud-sync offer, agent activity panel,
    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
    Design review loop: 2 iterations, all hard items pass, judges
    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
    E2E (real on-disk assertions, relaunch persistence).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>


exec
/bin/bash -lc "nl -ba apps/desktop/src/ipc/bridgeContract.ts | sed -n '20,45p'" in /home/ice/dev/dohc
 succeeded in 0ms:
    20	export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
    21	
    22	export const WorkspaceRegistryResult = z.object({
    23	  workspaces: z.array(WorkspaceSummary),
    24	});
    25	export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
    26	
    27	export const DefaultWorkspaceRootResult = z.string().min(1);
    28	
    29	export const CreateLocalWorkspacePayload = z.object({
    30	  rootPath: z.string().min(1),
    31	  kind: z.enum(["personal", "shared"]),
    32	});
    33	export type CreateLocalWorkspacePayload = z.infer<
    34	  typeof CreateLocalWorkspacePayload
    35	>;
    36	
    37	export const ListWorkspaceFilesPayload = z.object({
    38	  workspaceId: z.string().min(1),
    39	});
    40	
    41	export const WorkspaceFileEntry = z.object({
    42	  path: z.string().min(1),
    43	  kind: z.enum(["file", "database", "app-source"]),
    44	});
    45	export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

codex
The patch introduces a data-integrity issue around existing workspace manifests, under-validates workspace root IPC input, and can display stale workspace state after switching. These issues can break or misrepresent real local workspaces.

Full review comments:

- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
  When first-run is pointed at a folder that already contains `.dohc/manifest.json` (for example after the Electron userData registry was deleted or the user chooses an existing dohc workspace), this unconditional write replaces the manifest with a fresh `workspaceId`. That severs the workspace identity used by registry/sync/history even though the user's files remain, so creation should attach/read the existing manifest or fail with an exclusive write instead of overwriting it.

- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.

- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
  When multiple workspaces are registered, switching only updates the parent workspace while this component keeps its current `files` and `selected` state from the previous workspace until the async refresh completes, and `selected` is never cleared. A user can switch to workspace B and still see or preview a path from workspace A, so clear/key workspace-local state when `workspaceId` changes.
The patch introduces a data-integrity issue around existing workspace manifests, under-validates workspace root IPC input, and can display stale workspace state after switching. These issues can break or misrepresent real local workspaces.

Full review comments:

- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
  When first-run is pointed at a folder that already contains `.dohc/manifest.json` (for example after the Electron userData registry was deleted or the user chooses an existing dohc workspace), this unconditional write replaces the manifest with a fresh `workspaceId`. That severs the workspace identity used by registry/sync/history even though the user's files remain, so creation should attach/read the existing manifest or fail with an exclusive write instead of overwriting it.

- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.

- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
  When multiple workspaces are registered, switching only updates the parent workspace while this component keeps its current `files` and `selected` state from the previous workspace until the async refresh completes, and `selected` is never cleared. A user can switch to workspace B and still see or preview a path from workspace A, so clear/key workspace-local state when `workspaceId` changes.
