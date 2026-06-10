OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb12b-5aad-7f22-9da5-03f0795a25fd
--------
user
changes against 'main'
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git diff e2de7a3ad4234a2337cc7962865849551c34547b --stat && git diff e2de7a3ad4234a2337cc7962865849551c34547b' in /home/ice/dev/dohc
 succeeded in 107ms:
ion.action` is always `"deny"` and the caller ignores it, returning `{ action: "deny" }` directly. This is harmless but over-shaped for the current behavior; a boolean like `shouldOpenExternalHttpUrl()` would be simpler.
+
+Solid areas: IPC does validate sender URL on every handler, preload does not expose raw `ipcRenderer`, Node, or Electron internals, web preferences correctly set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, and direct `about:`/`javascript:` URLs are denied by the decision helpers.
+tokens used
+48,136
+1. `apps/desktop/src/window/createMainWindow.ts:14` / `apps/desktop/src/window/createMainWindow.ts:52` — **Medium**  
+   `ELECTRON_RENDERER_URL` is trusted at runtime without an `app.isPackaged` or loopback-only dev guard. In a packaged app launched with that env var, dohc can `loadURL()` an arbitrary URL and `navigationPolicy()` will treat that URL’s origin as IPC-trusted. Current IPC is narrow, but this pattern would become dangerous as filesystem/workspace IPC lands. Gate this to non-packaged dev builds, require `http://localhost`/loopback, and validate the initial URL before `loadURL()`.
+
+2. `apps/desktop/src/window/createMainWindow.ts:44` — **Medium**  
+   Navigation enforcement only handles `will-navigate`. Electron has separate surfaces for server redirects and frame navigations, so an allowed URL can redirect out, and subframe navigations are not checked by this policy. Current CSP helps, but this should be enforced at the Electron boundary too. Add equivalent denial for `will-redirect` and `will-frame-navigate`, with tests for redirects, iframes, `about:blank`, and `javascript:`.
+
+3. `apps/desktop/src/preload.ts:17` / `apps/desktop/src/main.ts:53` — **Low**  
+   The test bridge is gated only by `DOHC_DESKTOP_TEST=1`. Today it exposes launch timings only, so impact is low, but env-only gating is easy to accidentally enable in packaged builds and risky as test helpers grow. Require both the env flag and a non-packaged/test runtime check.
+
+4. `apps/desktop/src/security/electronSecurity.ts:69` / `apps/desktop/src/window/createMainWindow.ts:38` — **Low**  
+   `window.open()` denies new Electron windows, which is good, but shells out any `http:` or `https:` URL from renderer code. If renderer content is ever user-influenced, this becomes an external browser/phishing spam primitive. Consider requiring HTTPS and a user-initiated action, or routing through an allowlist/confirmation path.
+
+5. `apps/desktop/src/security/electronSecurity.ts:62` — **Info**  
+   `WindowOpenDecision.action` is always `"deny"` and the caller ignores it, returning `{ action: "deny" }` directly. This is harmless but over-shaped for the current behavior; a boolean like `shouldOpenExternalHttpUrl()` would be simpler.
+
+Solid areas: IPC does validate sender URL on every handler, preload does not expose raw `ipcRenderer`, Node, or Electron internals, web preferences correctly set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, and direct `about:`/`javascript:` URLs are denied by the decision helpers.
diff --git a/docs/superpowers/reviews/codex/phase-03.md b/docs/superpowers/reviews/codex/phase-03.md
new file mode 100644
index 0000000..41335e3
--- /dev/null
+++ b/docs/superpowers/reviews/codex/phase-03.md
@@ -0,0 +1,4249 @@
+OpenAI Codex v0.130.0
+--------
+workdir: /home/ice/dev/dohc
+model: gpt-5.5
+provider: openai
+approval: never
+sandbox: read-only
+reasoning effort: xhigh
+reasoning summaries: none
+session id: 019eb111-ed14-7413-8d63-bc424fc2280b
+--------
+user
+commit 529c0d4
+warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
+exec
+/bin/bash -lc 'git rev-parse --show-toplevel && git status --short && git show --stat --oneline --decorate --no-renames 529c0d4' in /home/ice/dev/dohc
+ succeeded in 113ms:
+ M docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+?? docs/superpowers/reviews/codex/phase-03.md
+?? docs/superpowers/reviews/codex/ui-phase-03.md
+?? test-results/
+529c0d4 (HEAD -> claude/desktop-local-first-cloud-sync) phase3: Add native desktop workspace shell
+ apps/desktop/e2e/firstRunWorkspace.spec.ts         | 199 +++++++++++
+ apps/desktop/electron.vite.config.ts               |   8 +-
+ apps/desktop/package.json                          |  14 +
+ apps/desktop/src/ipc/bridgeContract.ts             |  74 ++++-
+ apps/desktop/src/ipc/channels.ts                   |   5 +
+ apps/desktop/src/main.ts                           |  77 ++++-
+ apps/desktop/src/preload.ts                        |  12 +
+ apps/desktop/src/renderer/CommandPalette.tsx       |  78 +++++
+ apps/desktop/src/renderer/DesktopFirstRun.test.tsx | 108 ++++++
+ apps/desktop/src/renderer/DesktopFirstRun.tsx      | 103 ++++++
+ apps/desktop/src/renderer/DesktopRoot.tsx          |  39 +++
+ .../desktop/src/renderer/DesktopWorkspaceShell.tsx | 365 +++++++++++++++++++++
+ apps/desktop/src/renderer/NewFileDialog.tsx        |  56 ++++
+ apps/desktop/src/renderer/bridge.ts                |  14 +
+ apps/desktop/src/renderer/index.html               |   2 +-
+ apps/desktop/src/renderer/main.ts                  |  33 --
+ apps/desktop/src/renderer/main.tsx                 |  15 +
+ apps/desktop/src/renderer/styles.css               |  40 +++
+ apps/desktop/src/renderer/theme.ts                 |  22 ++
+ apps/desktop/src/workspaces/WorkspaceRegistry.ts   |  65 ++++
+ .../src/workspaces/createWorkspaceFolder.ts        |  52 +++
+ apps/desktop/src/workspaces/workspaceFiles.test.ts |  64 ++++
+ apps/desktop/src/workspaces/workspaceFiles.ts      |  75 +++++
+ apps/desktop/vitest.config.ts                      |   2 +-
+ ...desktop-local-first-cloud-sync.execution-log.md |  38 ++-
+ pnpm-lock.yaml                                     | 142 ++++++++
+ 26 files changed, 1649 insertions(+), 53 deletions(-)
+
+exec
+/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
+2026-06-10T10:27:15.491027Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open
+exec
+/bin/bash -lc "git ls-files '*AGENTS.md'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+AGENTS.md
+apps/app/AGENTS.md
+
+exec
+/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 529c0d4 -- apps/desktop/src/main.ts apps/desktop/src/ipc/bridgeContract.ts apps/desktop/src/ipc/channels.ts apps/desktop/src/preload.ts apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/createWorkspaceFolder.ts apps/desktop/src/workspaces/workspaceFiles.ts' in /home/ice/dev/dohc
+ succeeded in 0ms:
+commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
+Author: Ice de Vera <iestyndevera@gmail.com>
+Date:   Wed Jun 10 18:26:33 2026 +0800
+
+    phase3: Add native desktop workspace shell
+    
+    First-run creates real workspace folders (suggested ~/dohc, manifest
+    via workspace-core, no account); shell ships every plan-required
+    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
+    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
+    never overwrites), truthful cloud-sync offer, agent activity panel,
+    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
+    Design review loop: 2 iterations, all hard items pass, judges
+    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
+    E2E (real on-disk assertions, relaunch persistence).
+    
+    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
+index 64a5a7a..a8d543a 100644
+--- a/apps/desktop/src/ipc/bridgeContract.ts
++++ b/apps/desktop/src/ipc/bridgeContract.ts
+@@ -1,38 +1,94 @@
+ import { z } from "zod";
+ 
+ // Typed contract for everything the preload bridge exposes. Main-process
+ // handlers validate results against these before returning them. Payload
+ // validation starts with the first payload-accepting channel (Phase 4).
+ // The renderer never sees raw Electron APIs.
+ 
+ export const VersionResult = z.string().min(1);
+ export type VersionResult = z.infer<typeof VersionResult>;
+ 
+ export const PickWorkspaceRootResult = z.string().min(1).nullable();
+ export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;
+ 
+-// The real registry arrives in Phase 4; the contract starts narrow.
++export const WorkspaceSummary = z.object({
++  workspaceId: z.string().min(1),
++  rootPath: z.string().min(1),
++  kind: z.enum(["personal", "shared", "cloud-only"]),
++  mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
++});
++export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
++
+ export const WorkspaceRegistryResult = z.object({
+-  workspaces: z.array(
+-    z.object({
+-      workspaceId: z.string().min(1),
+-      rootPath: z.string().min(1),
+-      kind: z.enum(["personal", "shared", "cloud-only"]),
+-      mode: z.enum(["local-first", "cloud-first-local-copy", "cloud-only"]),
+-    }),
+-  ),
++  workspaces: z.array(WorkspaceSummary),
+ });
+ export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
+ 
++export const DefaultWorkspaceRootResult = z.string().min(1);
++
++export const CreateLocalWorkspacePayload = z.object({
++  rootPath: z.string().min(1),
++  kind: z.enum(["personal", "shared"]),
++});
++export type CreateLocalWorkspacePayload = z.infer<
++  typeof CreateLocalWorkspacePayload
++>;
++
++export const ListWorkspaceFilesPayload = z.object({
++  workspaceId: z.string().min(1),
++});
++
++export const WorkspaceFileEntry = z.object({
++  path: z.string().min(1),
++  kind: z.enum(["file", "database", "app-source"]),
++});
++export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;
++
++export const ListWorkspaceFilesResult = z.object({
++  files: z.array(WorkspaceFileEntry),
++});
++export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;
++
++export const CreateWorkspaceFilePayload = z.object({
++  workspaceId: z.string().min(1),
++  relativePath: z.string().min(1),
++});
++
++export const CreateWorkspaceFileResult = z.object({
++  path: z.string().min(1),
++});
++
++export const ImportWorkspaceFilesPayload = z.object({
++  workspaceId: z.string().min(1),
++});
++
++export const ImportWorkspaceFilesResult = z.object({
++  imported: z.array(z.string().min(1)),
++});
++
+ export const LaunchMarksResult = z.object({
+   appReadyMs: z.number().positive(),
+   firstWindowMs: z.number().positive(),
+   firstPaintMs: z.number().positive(),
+ });
+ export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;
+ 
+ export interface DohcDesktopBridge {
+   getVersion(): Promise<VersionResult>;
+   pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
+   getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
++  getDefaultWorkspaceRoot(): Promise<string>;
++  createLocalWorkspace(
++    payload: CreateLocalWorkspacePayload,
++  ): Promise<WorkspaceSummary>;
++  listWorkspaceFiles(payload: {
++    workspaceId: string;
++  }): Promise<ListWorkspaceFilesResult>;
++  createWorkspaceFile(payload: {
++    workspaceId: string;
++    relativePath: string;
++  }): Promise<{ path: string }>;
++  importWorkspaceFiles(payload: {
++    workspaceId: string;
++  }): Promise<{ imported: string[] }>;
+ }
+diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
+index 0981b5d..b2473ca 100644
+--- a/apps/desktop/src/ipc/channels.ts
++++ b/apps/desktop/src/ipc/channels.ts
+@@ -1,9 +1,14 @@
+ export const CHANNELS = {
+   getVersion: "desktop:get-version",
+   pickWorkspaceRoot: "desktop:pick-workspace-root",
+   getWorkspaceRegistry: "desktop:get-workspace-registry",
++  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
++  createLocalWorkspace: "desktop:create-local-workspace",
++  listWorkspaceFiles: "desktop:list-workspace-files",
++  createWorkspaceFile: "desktop:create-workspace-file",
++  importWorkspaceFiles: "desktop:import-workspace-files",
+   firstPaint: "desktop:first-paint",
+   getLaunchMarks: "desktop:test:get-launch-marks",
+ } as const;
+ 
+ export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
+diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
+index c70d9ed..26d0975 100644
+--- a/apps/desktop/src/main.ts
++++ b/apps/desktop/src/main.ts
+@@ -1,78 +1,151 @@
++import { defaultWorkspaceRoot } from "@dohc/workspace-core";
+ import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
+ import {
++  CreateLocalWorkspacePayload,
++  CreateWorkspaceFilePayload,
++  CreateWorkspaceFileResult,
++  DefaultWorkspaceRootResult,
++  ImportWorkspaceFilesPayload,
++  ImportWorkspaceFilesResult,
+   LaunchMarksResult,
++  ListWorkspaceFilesPayload,
++  ListWorkspaceFilesResult,
+   PickWorkspaceRootResult,
+   VersionResult,
+   WorkspaceRegistryResult,
++  WorkspaceSummary,
+ } from "./ipc/bridgeContract";
+ import { CHANNELS } from "./ipc/channels";
+ import { launchMarks } from "./performance/launchMarks";
+ import { decideNavigation } from "./security/electronSecurity";
+ import { navigationPolicy } from "./window/createMainWindow";
++import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
++import {
++  effectiveHome,
++  findWorkspace,
++  listWorkspaces,
++  registerWorkspace,
++} from "./workspaces/WorkspaceRegistry";
++import {
++  copyIntoWorkspace,
++  createFile,
++  listFiles,
++} from "./workspaces/workspaceFiles";
++
++function requireWorkspace(workspaceId: string) {
++  const workspace = findWorkspace(workspaceId);
++  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
++  return workspace;
++}
+ 
+ // IPC is an untrusted boundary: handlers only answer frames the navigation
+ // policy itself would allow (exact dev origin or the packaged bundle).
+ function isTrustedFrame(frameUrl: string): boolean {
+   return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
+ }
+ 
+ function assertTrustedSender(event: IpcMainInvokeEvent): void {
+   const frameUrl = event.senderFrame?.url ?? "";
+   if (!isTrustedFrame(frameUrl)) {
+     throw new Error(`Untrusted IPC sender: ${frameUrl}`);
+   }
+ }
+ 
+ function registerIpcHandlers(): void {
+   ipcMain.handle(CHANNELS.getVersion, (event) => {
+     assertTrustedSender(event);
+     return VersionResult.parse(app.getVersion());
+   });
+ 
+   ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
+     assertTrustedSender(event);
+     const result = await dialog.showOpenDialog({
+       properties: ["openDirectory", "createDirectory"],
+     });
+     const picked = result.canceled ? null : (result.filePaths[0] ?? null);
+     return PickWorkspaceRootResult.parse(picked);
+   });
+ 
+   ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
+     assertTrustedSender(event);
+-    // Real registry lands in Phase 4.
+-    return WorkspaceRegistryResult.parse({ workspaces: [] });
++    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
++  });
++
++  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
++    assertTrustedSender(event);
++    return DefaultWorkspaceRootResult.parse(
++      defaultWorkspaceRoot(effectiveHome()),
++    );
++  });
++
++  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
++    assertTrustedSender(event);
++    const input = CreateLocalWorkspacePayload.parse(payload);
++    const created = await createWorkspaceFolder(input);
++    registerWorkspace(created);
++    return WorkspaceSummary.parse(created);
++  });
++
++  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
++    assertTrustedSender(event);
++    const input = ListWorkspaceFilesPayload.parse(payload);
++    const workspace = requireWorkspace(input.workspaceId);
++    return ListWorkspaceFilesResult.parse({
++      files: await listFiles(workspace.rootPath),
++    });
++  });
++
++  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
++    assertTrustedSender(event);
++    const input = CreateWorkspaceFilePayload.parse(payload);
++    const workspace = requireWorkspace(input.workspaceId);
++    const path = await createFile(workspace.rootPath, input.relativePath);
++    return CreateWorkspaceFileResult.parse({ path });
++  });
++
++  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
++    assertTrustedSender(event);
++    const input = ImportWorkspaceFilesPayload.parse(payload);
++    const workspace = requireWorkspace(input.workspaceId);
++    const result = await dialog.showOpenDialog({
++      properties: ["openFile", "multiSelections"],
++      title: "Import files into workspace",
++    });
++    const imported = result.canceled
++      ? []
++      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
++    return ImportWorkspaceFilesResult.parse({ imported });
+   });
+ 
+   ipcMain.on(CHANNELS.firstPaint, (event) => {
+     if (isTrustedFrame(event.senderFrame?.url ?? "")) {
+       launchMarks.firstPaint();
+     }
+   });
+ 
+   // Double-gated: env flag AND unpackaged build. A packaged app launched
+   // with the env var set must never grow test surface.
+   if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
+     ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
+       assertTrustedSender(event);
+       return LaunchMarksResult.parse(launchMarks.snapshot());
+     });
+   }
+ }
+ 
+ // Single-instance lock gates the entire bootstrap, not just a quit() call.
+ if (!app.requestSingleInstanceLock()) {
+   app.quit();
+ } else {
+   void app.whenReady().then(async () => {
+     launchMarks.appReady();
+     registerIpcHandlers();
+     const { createMainWindow } = await import("./window/createMainWindow");
+     createMainWindow();
+     launchMarks.firstWindow();
+   });
+ 
+   app.on("window-all-closed", () => {
+     if (process.platform !== "darwin") app.quit();
+   });
+ }
+diff --git a/apps/desktop/src/preload.ts b/apps/desktop/src/preload.ts
+index d0293f0..d36a531 100644
+--- a/apps/desktop/src/preload.ts
++++ b/apps/desktop/src/preload.ts
+@@ -1,21 +1,33 @@
+ import { contextBridge, ipcRenderer } from "electron";
+ import { CHANNELS } from "./ipc/channels";
+ 
+ // The entire bridge surface. Narrow on purpose: the renderer gets named,
+ // typed operations — never raw ipcRenderer, never Node.
+ contextBridge.exposeInMainWorld("dohcDesktop", {
+   getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
+   pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
+   getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
++  getDefaultWorkspaceRoot: () =>
++    ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
++  createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
++    ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
++  listWorkspaceFiles: (payload: { workspaceId: string }) =>
++    ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
++  createWorkspaceFile: (payload: {
++    workspaceId: string;
++    relativePath: string;
++  }) => ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
++  importWorkspaceFiles: (payload: { workspaceId: string }) =>
++    ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
+ });
+ 
+ // One-shot paint signal for launch instrumentation (no data, no response).
+ contextBridge.exposeInMainWorld("dohcDesktopInternal", {
+   firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
+ });
+ 
+ if (process.env.DOHC_DESKTOP_TEST === "1") {
+   contextBridge.exposeInMainWorld("dohcDesktopTest", {
+     getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
+   });
+ }
+diff --git a/apps/desktop/src/workspaces/WorkspaceRegistry.ts b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
+new file mode 100644
+index 0000000..492c52c
+--- /dev/null
++++ b/apps/desktop/src/workspaces/WorkspaceRegistry.ts
+@@ -0,0 +1,65 @@
++import { app } from "electron";
++import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
++import { homedir } from "node:os";
++import { dirname, join } from "node:path";
++import type { CreatedWorkspace } from "./createWorkspaceFolder";
++
++// Registry of known local workspaces. Lives in Electron userData; in test
++// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
++// formalizes attachment/duplicate rules with dedicated tests.
++
++function testHome(): string | null {
++  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
++    ? (process.env.DOHC_TEST_HOME ?? null)
++    : null;
++}
++
++export function effectiveHome(): string {
++  return testHome() ?? homedir();
++}
++
++function registryPath(): string {
++  const base = testHome() ?? app.getPath("userData");
++  return join(base, "dohc-workspaces.json");
++}
++
++interface RegistryFile {
++  version: 1;
++  workspaces: CreatedWorkspace[];
++}
++
++function readRegistry(): RegistryFile {
++  try {
++    const parsed = JSON.parse(
++      readFileSync(registryPath(), "utf8"),
++    ) as RegistryFile;
++    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
++  } catch {
++    return { version: 1, workspaces: [] };
++  }
++}
++
++function writeRegistry(registry: RegistryFile): void {
++  mkdirSync(dirname(registryPath()), { recursive: true });
++  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
++}
++
++export function listWorkspaces(): CreatedWorkspace[] {
++  return readRegistry().workspaces;
++}
++
++export function registerWorkspace(workspace: CreatedWorkspace): void {
++  const registry = readRegistry();
++  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
++    return;
++  }
++  registry.workspaces.push(workspace);
++  writeRegistry(registry);
++}
++
++export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
++  return (
++    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
++    null
++  );
++}
+diff --git a/apps/desktop/src/workspaces/createWorkspaceFolder.ts b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
+new file mode 100644
+index 0000000..e651f22
+--- /dev/null
++++ b/apps/desktop/src/workspaces/createWorkspaceFolder.ts
+@@ -0,0 +1,52 @@
++import {
++  createWorkspaceManifest,
++  defaultWorkspaceMode,
++  type WorkspaceKind,
++} from "@dohc/workspace-core";
++import { randomUUID } from "node:crypto";
++import { mkdir, writeFile } from "node:fs/promises";
++import { join } from "node:path";
++
++export interface CreatedWorkspace {
++  workspaceId: string;
++  rootPath: string;
++  kind: WorkspaceKind;
++  mode: ReturnType<typeof defaultWorkspaceMode>;
++}
++
++const FIRST_CONTEXT = `# About me
++
++Tell your agents who you are and how you like to work.
++This file lives at .context/me.md inside your workspace folder.
++`;
++
++export async function createWorkspaceFolder(input: {
++  rootPath: string;
++  kind: Extract<WorkspaceKind, "personal" | "shared">;
++}): Promise<CreatedWorkspace> {
++  const manifest = createWorkspaceManifest({
++    workspaceId: randomUUID(),
++    kind: input.kind,
++  });
++
++  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
++  await mkdir(join(input.rootPath, ".context"), { recursive: true });
++  await writeFile(
++    join(input.rootPath, ".dohc", "manifest.json"),
++    `${JSON.stringify(manifest, null, 2)}\n`,
++  );
++  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
++    flag: "wx",
++  }).catch((error: unknown) => {
++    // An existing me.md is the user's; never overwrite it. Real failures
++    // (permissions, disk) must still surface.
++    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
++  });
++
++  return {
++    workspaceId: manifest.workspaceId,
++    rootPath: input.rootPath,
++    kind: input.kind,
++    mode: manifest.mode,
++  };
++}
+diff --git a/apps/desktop/src/workspaces/workspaceFiles.ts b/apps/desktop/src/workspaces/workspaceFiles.ts
+new file mode 100644
+index 0000000..2efe19b
+--- /dev/null
++++ b/apps/desktop/src/workspaces/workspaceFiles.ts
+@@ -0,0 +1,75 @@
++import {
++  classifyPath,
++  validateUserWritePath,
++} from "@dohc/workspace-core";
++import { constants } from "node:fs";
++import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
++import { basename, dirname, join } from "node:path";
++import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
++
++const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
++
++export async function listFiles(
++  rootPath: string,
++): Promise<WorkspaceFileEntry[]> {
++  const entries: WorkspaceFileEntry[] = [];
++
++  async function walk(dir: string, prefix: string): Promise<void> {
++    const dirents = await readdir(dir, { withFileTypes: true });
++    for (const dirent of dirents) {
++      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
++      if (dirent.isDirectory()) {
++        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
++      } else {
++        const classified = classifyPath(rel);
++        entries.push({
++          path: rel,
++          kind: classified.kind === "database" ? "database"
++            : classified.kind === "app-source" ? "app-source"
++            : "file",
++        });
++      }
++    }
++  }
++
++  await walk(rootPath, "");
++  entries.sort((a, b) => a.path.localeCompare(b.path));
++  return entries;
++}
++
++export async function createFile(
++  rootPath: string,
++  relativePath: string,
++): Promise<string> {
++  const validated = validateUserWritePath(relativePath);
++  if (!validated.ok) {
++    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
++  }
++  const absolute = join(rootPath, validated.normalized);
++  await mkdir(dirname(absolute), { recursive: true });
++  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
++    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
++  });
++  return validated.normalized;
++}
++
++// Imports copy external files into the workspace root by basename; existing
++// files are never overwritten (skipped, not errored — imports are additive).
++export async function copyIntoWorkspace(
++  rootPath: string,
++  absolutePaths: string[],
++): Promise<string[]> {
++  const imported: string[] = [];
++  for (const source of absolutePaths) {
++    const name = basename(source);
++    const validated = validateUserWritePath(name);
++    if (!validated.ok) continue;
++    try {
++      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
++      imported.push(validated.normalized);
++    } catch (error) {
++      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
++    }
++  }
++  return imported;
++}
+
+exec
+/bin/bash -lc 'git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/src/renderer/DesktopWorkspaceShell.tsx apps/desktop/src/renderer/DesktopRoot.tsx apps/desktop/src/renderer/DesktopFirstRun.tsx apps/desktop/src/renderer/CommandPalette.tsx apps/desktop/src/renderer/NewFileDialog.tsx apps/desktop/src/renderer/bridge.ts apps/desktop/src/renderer/main.tsx apps/desktop/src/renderer/main.ts apps/desktop/src/renderer/styles.css apps/desktop/src/renderer/theme.ts' in /home/ice/dev/dohc
+ succeeded in 0ms:
+commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
+Author: Ice de Vera <iestyndevera@gmail.com>
+Date:   Wed Jun 10 18:26:33 2026 +0800
+
+    phase3: Add native desktop workspace shell
+    
+    First-run creates real workspace folders (suggested ~/dohc, manifest
+    via workspace-core, no account); shell ships every plan-required
+    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
+    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
+    never overwrites), truthful cloud-sync offer, agent activity panel,
+    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
+    Design review loop: 2 iterations, all hard items pass, judges
+    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
+    E2E (real on-disk assertions, relaunch persistence).
+    
+    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+diff --git a/apps/desktop/src/renderer/CommandPalette.tsx b/apps/desktop/src/renderer/CommandPalette.tsx
+new file mode 100644
+index 0000000..9226f56
+--- /dev/null
++++ b/apps/desktop/src/renderer/CommandPalette.tsx
+@@ -0,0 +1,78 @@
++import { useEffect, useRef, useState } from "react";
++
++export interface Command {
++  id: string;
++  label: string;
++  run: () => void;
++}
++
++export function CommandPalette(props: {
++  commands: Command[];
++  onClose: () => void;
++  testId?: string;
++  placeholder?: string;
++  ariaLabel?: string;
++}) {
++  const [query, setQuery] = useState("");
++  const inputRef = useRef<HTMLInputElement>(null);
++
++  useEffect(() => {
++    inputRef.current?.focus();
++  }, []);
++
++  const matches = props.commands.filter((command) =>
++    command.label.toLowerCase().includes(query.toLowerCase()),
++  );
++
++  function runCommand(command: Command | undefined) {
++    if (!command) return;
++    props.onClose();
++    command.run();
++  }
++
++  return (
++    <div
++      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
++      onClick={props.onClose}
++    >
++      <div
++        data-testid={props.testId ?? "command-palette"}
++        className="w-130 max-w-[80vw] overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
++        onClick={(event) => event.stopPropagation()}
++      >
++        <input
++          ref={inputRef}
++          type="text"
++          aria-label={props.ariaLabel ?? "Command"}
++          placeholder={props.placeholder ?? "Type a command…"}
++          value={query}
++          onChange={(event) => setQuery(event.target.value)}
++          onKeyDown={(event) => {
++            if (event.key === "Escape") props.onClose();
++            if (event.key === "Enter") runCommand(matches[0]);
++          }}
++          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-subtle"
++        />
++        <ul role="listbox" aria-label="Commands" className="m-0 max-h-72 list-none overflow-y-auto p-1">
++          {matches.length === 0 ? (
++            <li className="px-3 py-2 text-xs text-subtle">No matching commands</li>
++          ) : (
++            matches.map((command, index) => (
++              <li key={command.id} role="option" aria-selected={index === 0}>
++                <button
++                  type="button"
++                  onClick={() => runCommand(command)}
++                  className={`w-full rounded px-3 py-1.5 text-left text-[13px] ${
++                    index === 0 ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
++                  }`}
++                >
++                  {command.label}
++                </button>
++              </li>
++            ))
++          )}
++        </ul>
++      </div>
++    </div>
++  );
++}
+diff --git a/apps/desktop/src/renderer/DesktopFirstRun.tsx b/apps/desktop/src/renderer/DesktopFirstRun.tsx
+new file mode 100644
+index 0000000..39d5793
+--- /dev/null
++++ b/apps/desktop/src/renderer/DesktopFirstRun.tsx
+@@ -0,0 +1,103 @@
++import { Cloud, FolderOpen } from "lucide-react";
++import { useEffect, useState } from "react";
++import { bridge } from "./bridge";
++import type { Workspace } from "./DesktopWorkspaceShell";
++
++// First launch is a working tool, not a marketing page: pick where your
++// files live, create the folder, start working. No account exists here.
++export function DesktopFirstRun(props: {
++  onWorkspaceReady: (workspace: Workspace) => void;
++}) {
++  const [root, setRoot] = useState<string | null>(null);
++  const [creating, setCreating] = useState(false);
++  const [error, setError] = useState<string | null>(null);
++  const [cloudNote, setCloudNote] = useState(false);
++
++  useEffect(() => {
++    void bridge().getDefaultWorkspaceRoot().then(setRoot);
++  }, []);
++
++  async function chooseFolder() {
++    const picked = await bridge().pickWorkspaceRoot();
++    if (picked) setRoot(picked);
++  }
++
++  async function createWorkspace() {
++    if (!root || creating) return;
++    setCreating(true);
++    try {
++      const workspace = await bridge().createLocalWorkspace({
++        rootPath: `${root}/personal`,
++        kind: "personal",
++      });
++      props.onWorkspaceReady(workspace);
++    } catch (cause) {
++      setError(cause instanceof Error ? cause.message : String(cause));
++      setCreating(false);
++    }
++  }
++
++  return (
++    <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
++      <div className="flex flex-col items-center gap-1">
++        <h1 className="m-0 text-2xl font-semibold tracking-tight">dohc</h1>
++        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
++      </div>
++
++      <div className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
++        <div className="flex flex-col gap-1">
++          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
++            Workspace location
++          </span>
++          <div className="flex items-start justify-between gap-2">
++            {/* The whole point of this screen is where files live: never
++                truncate the path. */}
++            <code className="break-all font-mono text-[13px] leading-snug text-ink">
++              {root ?? "…"}
++            </code>
++            <button
++              type="button"
++              onClick={() => void chooseFolder()}
++              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
++            >
++              <FolderOpen size={13} aria-hidden />
++              Choose a different folder
++            </button>
++          </div>
++        </div>
++
++        <button
++          type="button"
++          disabled={!root || creating}
++          onClick={() => void createWorkspace()}
++          className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
++        >
++          {creating ? "Creating…" : "Create workspace"}
++        </button>
++
++        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
++
++        <div className="flex items-center justify-between gap-4">
++          <p className="m-0 text-xs text-subtle">
++            Works offline, no account needed. Cloud sync is optional.
++          </p>
++          <button
++            type="button"
++            onClick={() => setCloudNote((open) => !open)}
++            className="flex shrink-0 items-center gap-1 text-xs text-subtle hover:text-ink"
++          >
++            <Cloud size={12} aria-hidden />
++            Enable dohc Cloud sync
++          </button>
++        </div>
++        {cloudNote ? (
++          <p className="m-0 rounded bg-panel-2 px-2.5 py-2 text-xs leading-relaxed text-muted">
++            Cloud sync arrives with dohc Cloud accounts — sharing, backup, and
++            teams. Your workspace stays fully functional locally, and you can
++            connect it later without moving anything.
++          </p>
++        ) : null}
++      </div>
++    </div>
++  );
++}
+diff --git a/apps/desktop/src/renderer/DesktopRoot.tsx b/apps/desktop/src/renderer/DesktopRoot.tsx
+new file mode 100644
+index 0000000..ba0e93f
+--- /dev/null
++++ b/apps/desktop/src/renderer/DesktopRoot.tsx
+@@ -0,0 +1,39 @@
++import { useEffect, useState } from "react";
++import { bridge } from "./bridge";
++import { DesktopFirstRun } from "./DesktopFirstRun";
++import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
++
++export function DesktopRoot() {
++  const [loaded, setLoaded] = useState(false);
++  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
++  const [workspace, setWorkspace] = useState<Workspace | null>(null);
++
++  useEffect(() => {
++    void bridge()
++      .getWorkspaceRegistry()
++      .then((registry) => {
++        setWorkspaces(registry.workspaces);
++        setWorkspace(registry.workspaces[0] ?? null);
++        setLoaded(true);
++      });
++  }, []);
++
++  if (!loaded) return null;
++  if (!workspace) {
++    return (
++      <DesktopFirstRun
++        onWorkspaceReady={(created) => {
++          setWorkspaces([created]);
++          setWorkspace(created);
++        }}
++      />
++    );
++  }
++  return (
++    <DesktopWorkspaceShell
++      workspace={workspace}
++      workspaces={workspaces}
++      onSwitchWorkspace={setWorkspace}
++    />
++  );
++}
+diff --git a/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
+new file mode 100644
+index 0000000..f747851
+--- /dev/null
++++ b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
+@@ -0,0 +1,365 @@
++import {
++  Bot,
++  Check,
++  ChevronsUpDown,
++  Cloud,
++  Database,
++  FilePlus2,
++  FileText,
++  Import,
++  LayoutGrid,
++} from "lucide-react";
++import { useCallback, useEffect, useMemo, useState } from "react";
++import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
++import { bridge } from "./bridge";
++import { CommandPalette, type Command } from "./CommandPalette";
++import { NewFileDialog } from "./NewFileDialog";
++import { toggleTheme } from "./theme";
++
++export type Workspace = WorkspaceSummary;
++
++function workspaceName(workspace: Workspace): string {
++  return workspace.rootPath.split("/").pop() ?? "workspace";
++}
++
++function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
++  if (kind === "database") return <Database size={13} aria-hidden />;
++  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
++  return <FileText size={13} aria-hidden />;
++}
++
++export function DesktopWorkspaceShell(props: {
++  workspace: Workspace;
++  workspaces: Workspace[];
++  onSwitchWorkspace: (workspace: Workspace) => void;
++}) {
++  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
++  const [selected, setSelected] = useState<string | null>(null);
++  const [paletteOpen, setPaletteOpen] = useState(false);
++  const [newFileOpen, setNewFileOpen] = useState(false);
++  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
++  const [switcherOpen, setSwitcherOpen] = useState(false);
++  const [cloudOpen, setCloudOpen] = useState(false);
++
++  const importFiles = useCallback(async () => {
++    await bridge().importWorkspaceFiles({
++      workspaceId: props.workspace.workspaceId,
++    });
++    const result = await bridge().listWorkspaceFiles({
++      workspaceId: props.workspace.workspaceId,
++    });
++    setFiles(result.files);
++  }, [props.workspace.workspaceId]);
++
++  const refreshFiles = useCallback(async () => {
++    const result = await bridge().listWorkspaceFiles({
++      workspaceId: props.workspace.workspaceId,
++    });
++    setFiles(result.files);
++  }, [props.workspace.workspaceId]);
++
++  useEffect(() => {
++    void refreshFiles();
++  }, [refreshFiles]);
++
++  useEffect(() => {
++    function onKeyDown(event: KeyboardEvent) {
++      const mod = event.metaKey || event.ctrlKey;
++      if (!mod) return;
++      if (event.key === "n") {
++        event.preventDefault();
++        setNewFileOpen(true);
++      } else if (event.key === "k") {
++        event.preventDefault();
++        setPaletteOpen((open) => !open);
++      } else if (event.key === "p") {
++        event.preventDefault();
++        setQuickOpenOpen((open) => !open);
++      }
++    }
++    window.addEventListener("keydown", onKeyDown);
++    return () => window.removeEventListener("keydown", onKeyDown);
++  }, []);
++
++  const commands = useMemo<Command[]>(
++    () => [
++      {
++        id: "new-file",
++        label: "New file",
++        run: () => setNewFileOpen(true),
++      },
++      {
++        id: "quick-open",
++        label: "Go to file",
++        run: () => setQuickOpenOpen(true),
++      },
++      {
++        id: "import-files",
++        label: "Import files into workspace",
++        run: () => void importFiles(),
++      },
++      {
++        id: "connect-cloud",
++        label: "Connect dohc Cloud",
++        run: () => setCloudOpen(true),
++      },
++      {
++        id: "toggle-theme",
++        label: "Toggle light/dark theme",
++        run: toggleTheme,
++      },
++    ],
++    [importFiles],
++  );
++
++  return (
++    <div
++      data-testid="workspace-shell"
++      className="app-chrome flex h-screen flex-col bg-bg text-ink"
++    >
++      <div className="flex min-h-0 flex-1">
++        {/* Sidebar */}
++        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2">
++          <header className="relative border-b border-line">
++            <button
++              type="button"
++              data-testid="workspace-switcher"
++              aria-haspopup="listbox"
++              aria-expanded={switcherOpen}
++              onClick={() => setSwitcherOpen((open) => !open)}
++              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-panel"
++            >
++              <span className="truncate text-[13px] font-semibold">
++                {workspaceName(props.workspace)}
++              </span>
++              <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
++            </button>
++            {switcherOpen ? (
++              <ul
++                role="listbox"
++                aria-label="Workspaces"
++                className="absolute left-2 right-2 top-full z-20 mt-1 m-0 list-none rounded border border-line bg-panel p-1 shadow-md"
++              >
++                {props.workspaces.map((candidate) => (
++                  <li key={candidate.workspaceId} role="option" aria-selected={candidate.workspaceId === props.workspace.workspaceId}>
++                    <button
++                      type="button"
++                      onClick={() => {
++                        setSwitcherOpen(false);
++                        props.onSwitchWorkspace(candidate);
++                      }}
++                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-muted hover:text-ink"
++                    >
++                      {candidate.workspaceId === props.workspace.workspaceId ? (
++                        <Check size={12} aria-hidden />
++                      ) : (
++                        <span className="w-3" aria-hidden />
++                      )}
++                      <span className="truncate">{workspaceName(candidate)}</span>
++                      <span className="ml-auto text-[10px] uppercase text-subtle">
++                        {candidate.kind}
++                      </span>
++                    </button>
++                  </li>
++                ))}
++              </ul>
++            ) : null}
++          </header>
++
++          <nav
++            data-testid="file-tree"
++            aria-label="Files"
++            className="min-h-0 flex-1 overflow-y-auto py-1"
++          >
++            {files.length === 0 ? (
++              <button
++                type="button"
++                onClick={() => setNewFileOpen(true)}
++                className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
++              >
++                <FilePlus2 size={13} aria-hidden />
++                Create your first file
++              </button>
++            ) : (
++              <ul className="m-0 list-none p-0">
++                {files.map((file) => (
++                  <li key={file.path}>
++                    <button
++                      type="button"
++                      onClick={() => setSelected(file.path)}
++                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
++                        selected === file.path
++                          ? "bg-panel text-ink"
++                          : "text-muted hover:text-ink"
++                      }`}
++                    >
++                      <FileIcon kind={file.kind} />
++                      <span className="truncate">{file.path}</span>
++                    </button>
++                  </li>
++                ))}
++              </ul>
++            )}
++          </nav>
++
++          <footer className="flex flex-col gap-1 border-t border-line px-3 py-1.5">
++            <button
++              type="button"
++              onClick={() => setNewFileOpen(true)}
++              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
++            >
++              <FilePlus2 size={13} aria-hidden />
++              New file
++              <kbd className="ml-auto font-mono text-[10px] text-subtle">
++                Ctrl N
++              </kbd>
++            </button>
++            <button
++              type="button"
++              onClick={() => void importFiles()}
++              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
++            >
++              <Import size={13} aria-hidden />
++              Import files
++            </button>
++          </footer>
++        </aside>
++
++        {/* Main area */}
++        <main className="flex min-w-0 flex-1 items-center justify-center bg-bg">
++          {selected ? (
++            <div className="flex flex-col items-center gap-1 text-center">
++              <span className="font-mono text-[13px] text-ink">{selected}</span>
++              <span className="text-xs text-subtle">
++                File editing arrives with the editor surface.
++              </span>
++            </div>
++          ) : (
++            <div className="flex flex-col items-center gap-2 text-center">
++              <span className="text-sm text-muted">
++                Select a file, or create one
++              </span>
++              <div className="flex items-center gap-3">
++                <button
++                  type="button"
++                  onClick={() => setNewFileOpen(true)}
++                  className="font-mono text-xs text-subtle hover:text-ink"
++                >
++                  Ctrl N · new file
++                </button>
++                <button
++                  type="button"
++                  onClick={() => setPaletteOpen(true)}
++                  className="font-mono text-xs text-subtle hover:text-ink"
++                >
++                  Ctrl K · commands
++                </button>
++                <button
++                  type="button"
++                  onClick={() => setQuickOpenOpen(true)}
++                  className="font-mono text-xs text-subtle hover:text-ink"
++                >
++                  Ctrl P · go to file
++                </button>
++              </div>
++            </div>
++          )}
++        </main>
++
++        {/* Agent activity panel */}
++        <aside
++          data-testid="agent-panel"
++          aria-label="Agent activity"
++          className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
++        >
++          <header className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[13px] font-semibold">
++            <Bot size={14} aria-hidden />
++            Agent activity
++          </header>
++          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
++            <span className="text-xs text-muted">No agent runs yet</span>
++            <span className="text-[11px] text-subtle">
++              Point Codex or Claude Code at this folder — changes show up here
++              as a timeline.
++            </span>
++          </div>
++        </aside>
++      </div>
++
++      {/* Status bar */}
++      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3">
++        <span
++          data-testid="sync-status"
++          className="flex items-center gap-1.5 text-[11px] text-muted"
++        >
++          <span
++            aria-hidden
++            className="inline-block h-1.5 w-1.5 rounded-full bg-success"
++          />
++          Local · saved
++        </span>
++        <button
++          type="button"
++          onClick={() => setCloudOpen(true)}
++          className="flex items-center gap-1.5 text-[11px] text-subtle hover:text-ink"
++        >
++          <Cloud size={12} aria-hidden />
++          Connect dohc Cloud
++        </button>
++      </footer>
++
++      {paletteOpen ? (
++        <CommandPalette
++          commands={commands}
++          onClose={() => setPaletteOpen(false)}
++        />
++      ) : null}
++      {quickOpenOpen ? (
++        <CommandPalette
++          testId="quick-open"
++          placeholder="Go to file…"
++          ariaLabel="File"
++          commands={files.map((file) => ({
++            id: file.path,
++            label: file.path,
++            run: () => setSelected(file.path),
++          }))}
++          onClose={() => setQuickOpenOpen(false)}
++        />
++      ) : null}
++      {newFileOpen ? (
++        <NewFileDialog
++          workspaceId={props.workspace.workspaceId}
++          onClose={() => setNewFileOpen(false)}
++          onCreated={() => {
++            setNewFileOpen(false);
++            void refreshFiles();
++          }}
++        />
++      ) : null}
++      {cloudOpen ? (
++        <div
++          className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
++          onClick={() => setCloudOpen(false)}
++        >
++          <div
++            data-testid="cloud-sync-panel"
++            className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-4 shadow-lg"
++            onClick={(event) => event.stopPropagation()}
++          >
++            <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
++              <Cloud size={14} aria-hidden />
++              dohc Cloud
++            </h2>
++            <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
++              Cloud sync brings sharing, backup, and team workspaces. It
++              arrives with dohc Cloud accounts — this workspace stays fully
++              functional locally, and you can connect it then without moving
++              anything.
++            </p>
++          </div>
++        </div>
++      ) : null}
++    </div>
++  );
++}
+diff --git a/apps/desktop/src/renderer/NewFileDialog.tsx b/apps/desktop/src/renderer/NewFileDialog.tsx
+new file mode 100644
+index 0000000..1c07920
+--- /dev/null
++++ b/apps/desktop/src/renderer/NewFileDialog.tsx
+@@ -0,0 +1,56 @@
++import { useEffect, useRef, useState } from "react";
++import { bridge } from "./bridge";
++
++export function NewFileDialog(props: {
++  workspaceId: string;
++  onClose: () => void;
++  onCreated: (path: string) => void;
++}) {
++  const [name, setName] = useState("");
++  const [error, setError] = useState<string | null>(null);
++  const inputRef = useRef<HTMLInputElement>(null);
++
++  useEffect(() => {
++    inputRef.current?.focus();
++  }, []);
++
++  async function create() {
++    if (!name.trim()) return;
++    try {
++      const result = await bridge().createWorkspaceFile({
++        workspaceId: props.workspaceId,
++        relativePath: name.trim(),
++      });
++      props.onCreated(result.path);
++    } catch (cause) {
++      setError(cause instanceof Error ? cause.message : String(cause));
++    }
++  }
++
++  return (
++    <div
++      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
++      onClick={props.onClose}
++    >
++      <div
++        className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-3 shadow-lg"
++        onClick={(event) => event.stopPropagation()}
++      >
++        <input
++          ref={inputRef}
++          type="text"
++          aria-label="File name"
++          placeholder="notes/today.md"
++          value={name}
++          onChange={(event) => setName(event.target.value)}
++          onKeyDown={(event) => {
++            if (event.key === "Escape") props.onClose();
++            if (event.key === "Enter") void create();
++          }}
++          className="w-full rounded border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-subtle"
++        />
++        {error ? <p className="mb-0 mt-2 text-xs text-danger">{error}</p> : null}
++      </div>
++    </div>
++  );
++}
+diff --git a/apps/desktop/src/renderer/bridge.ts b/apps/desktop/src/renderer/bridge.ts
+new file mode 100644
+index 0000000..1c2cb50
+--- /dev/null
++++ b/apps/desktop/src/renderer/bridge.ts
+@@ -0,0 +1,14 @@
++import type { DohcDesktopBridge } from "../ipc/bridgeContract";
++
++declare global {
++  interface Window {
++    dohcDesktop?: DohcDesktopBridge;
++    dohcDesktopInternal?: { firstPaint(): void };
++  }
++}
++
++export function bridge(): DohcDesktopBridge {
++  const api = window.dohcDesktop;
++  if (!api) throw new Error("dohc desktop bridge is unavailable");
++  return api;
++}
+diff --git a/apps/desktop/src/renderer/main.ts b/apps/desktop/src/renderer/main.ts
+deleted file mode 100644
+index 0e0da32..0000000
+--- a/apps/desktop/src/renderer/main.ts
++++ /dev/null
+@@ -1,33 +0,0 @@
+-// Minimal first-run shell. Phase 3 replaces this with the real desktop
+-// workspace shell (driven by the component reuse map + design review loop).
+-
+-declare global {
+-  interface Window {
+-    dohcDesktopInternal?: { firstPaint(): void };
+-  }
+-}
+-
+-const root = document.getElementById("root");
+-if (root) {
+-  const main = document.createElement("main");
+-  main.style.cssText =
+-    "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;";
+-
+-  const heading = document.createElement("h1");
+-  heading.textContent = "dohc";
+-  heading.style.cssText =
+-    "font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;";
+-
+-  const subtitle = document.createElement("p");
+-  subtitle.textContent = "Your workspace is a folder.";
+-  subtitle.style.cssText = "font-size:14px;opacity:0.65;margin:0;";
+-
+-  main.append(heading, subtitle);
+-  root.append(main);
+-}
+-
+-requestAnimationFrame(() => {
+-  window.dohcDesktopInternal?.firstPaint();
+-});
+-
+-export {};
+diff --git a/apps/desktop/src/renderer/main.tsx b/apps/desktop/src/renderer/main.tsx
+new file mode 100644
+index 0000000..89b5151
+--- /dev/null
++++ b/apps/desktop/src/renderer/main.tsx
+@@ -0,0 +1,15 @@
++import { createRoot } from "react-dom/client";
++import { DesktopRoot } from "./DesktopRoot";
++import { initTheme } from "./theme";
++import "./styles.css";
++
++initTheme();
++
++const container = document.getElementById("root");
++if (container) {
++  createRoot(container).render(<DesktopRoot />);
++}
++
++requestAnimationFrame(() => {
++  window.dohcDesktopInternal?.firstPaint();
++});
+diff --git a/apps/desktop/src/renderer/styles.css b/apps/desktop/src/renderer/styles.css
+new file mode 100644
+index 0000000..7439dc9
+--- /dev/null
++++ b/apps/desktop/src/renderer/styles.css
+@@ -0,0 +1,40 @@
++@import "@dohc/brand/tokens.css";
++@import "tailwindcss";
++
++@custom-variant dark ([data-theme='dark'] &);
++
++/* Semantic layer over the shared brand tokens. The desktop renderer never
++ * redefines brand colors — packages/brand/src/tokens.css is the source. */
++@theme inline {
++  --color-bg: var(--dohc-bg);
++  --color-panel: var(--dohc-panel);
++  --color-panel-2: var(--dohc-panel-2);
++  --color-ink: var(--dohc-ink);
++  --color-muted: var(--dohc-muted);
++  --color-subtle: var(--dohc-subtle);
++  --color-accent: var(--dohc-accent);
++  --color-line: var(--dohc-line);
++  --color-success: var(--dohc-success);
++  --color-warning: var(--dohc-warning);
++  --color-danger: var(--dohc-danger);
++  --font-sans: var(--font-sans);
++  --font-mono: var(--font-mono);
++}
++
++html,
++body,
++#root {
++  height: 100%;
++  margin: 0;
++  background: var(--dohc-bg);
++  color: var(--dohc-ink);
++  font-family: var(--font-sans);
++  font-size: 14px;
++  -webkit-font-smoothing: antialiased;
++}
++
++/* Desktop app, not a web page: no text cursor or selection on chrome. */
++.app-chrome {
++  user-select: none;
++  cursor: default;
++}
+diff --git a/apps/desktop/src/renderer/theme.ts b/apps/desktop/src/renderer/theme.ts
+new file mode 100644
+index 0000000..2b0350b
+--- /dev/null
++++ b/apps/desktop/src/renderer/theme.ts
+@@ -0,0 +1,22 @@
++const STORAGE_KEY = "dohc-theme";
++
++function apply(media: MediaQueryList): void {
++  const stored = localStorage.getItem(STORAGE_KEY);
++  const dark = stored ? stored === "dark" : media.matches;
++  document.documentElement.dataset.theme = dark ? "dark" : "light";
++}
++
++// Follows the system theme unless the user explicitly toggled; never
++// interrupts running work (a data-attribute flip only).
++export function initTheme(): void {
++  const media = window.matchMedia("(prefers-color-scheme: dark)");
++  media.addEventListener("change", () => apply(media));
++  apply(media);
++}
++
++export function toggleTheme(): void {
++  const next =
++    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
++  localStorage.setItem(STORAGE_KEY, next);
++  document.documentElement.dataset.theme = next;
++}
+
+exec
+/bin/bash -lc "git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/vitest.config.ts apps/desktop/src/renderer/index.html apps/desktop/src/renderer/DesktopFirstRun.test.tsx apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/e2e/firstRunWorkspace.spec.ts pnpm-lock.yaml | sed -n '1,240p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
+Author: Ice de Vera <iestyndevera@gmail.com>
+Date:   Wed Jun 10 18:26:33 2026 +0800
+
+    phase3: Add native desktop workspace shell
+    
+    First-run creates real workspace folders (suggested ~/dohc, manifest
+    via workspace-core, no account); shell ships every plan-required
+    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
+    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
+    never overwrites), truthful cloud-sync offer, agent activity panel,
+    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
+    Design review loop: 2 iterations, all hard items pass, judges
+    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
+    E2E (real on-disk assertions, relaunch persistence).
+    
+    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+diff --git a/apps/desktop/e2e/firstRunWorkspace.spec.ts b/apps/desktop/e2e/firstRunWorkspace.spec.ts
+new file mode 100644
+index 0000000..3fcf82b
+--- /dev/null
++++ b/apps/desktop/e2e/firstRunWorkspace.spec.ts
+@@ -0,0 +1,199 @@
++import { expect, test } from "@playwright/test";
++import { existsSync, readFileSync } from "node:fs";
++import { mkdir, mkdtemp } from "node:fs/promises";
++import { tmpdir } from "node:os";
++import { join } from "node:path";
++import { _electron as electron, type ElectronApplication, type Page } from "playwright";
++
++const SCREENSHOT_DIR = "test-results/screenshots/phase-03";
++
++async function launchFirstRun(): Promise<{
++  app: ElectronApplication;
++  page: Page;
++  testHome: string;
++}> {
++  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
++  const launchArgs = ["apps/desktop/dist/main/main.js"];
++  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
++    launchArgs.push("--no-sandbox");
++  }
++  const app = await electron.launch({
++    args: launchArgs,
++    cwd: process.cwd(),
++    env: {
++      ...process.env,
++      DOHC_DESKTOP_TEST: "1",
++      DOHC_TEST_HOME: testHome,
++    },
++  });
++  const page = await app.firstWindow();
++  return { app, page, testHome };
++}
++
++async function shot(page: Page, name: string): Promise<void> {
++  await mkdir(SCREENSHOT_DIR, { recursive: true });
++  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
++  const scheme = await page.evaluate(() =>
++    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
++  );
++  await page.screenshot({
++    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
++  });
++}
++
++async function expectNoOverflow(page: Page): Promise<void> {
++  const overflow = await page.evaluate(() => ({
++    x: document.documentElement.scrollWidth - window.innerWidth,
++    y: document.documentElement.scrollHeight - window.innerHeight,
++  }));
++  expect(overflow.x).toBeLessThanOrEqual(0);
++  expect(overflow.y).toBeLessThanOrEqual(0);
++}
++
++test("first run creates a real workspace folder and lands in a native shell", async () => {
++  const { app, page, testHome } = await launchFirstRun();
++
++  // --- First run: suggests <home>/dohc, no login, cloud sync optional ---
++  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
++  await expect(page.getByText(join(testHome, "dohc"))).toBeVisible();
++  await expect(page.getByText(/cloud sync is optional/i)).toBeVisible();
++  await expect(
++    page.getByRole("button", { name: /enable dohc cloud sync/i }),
++  ).toBeVisible();
++  await expect(
++    page.getByRole("button", { name: /sign in|log in|sign up/i }),
++  ).toHaveCount(0);
++  await page.setViewportSize({ width: 1280, height: 800 });
++  await expectNoOverflow(page);
++  await shot(page, "first-run");
++
++  // --- Create the workspace: a real folder must appear on disk ---
++  await page.getByRole("button", { name: /create workspace/i }).click();
++  await expect(page.getByTestId("workspace-shell")).toBeVisible();
++
++  const workspaceRoot = join(testHome, "dohc", "personal");
++  expect(existsSync(join(workspaceRoot, ".dohc", "manifest.json"))).toBe(true);
++  const manifest = JSON.parse(
++    readFileSync(join(workspaceRoot, ".dohc", "manifest.json"), "utf8"),
++  );
++  expect(manifest).toMatchObject({
++    version: 1,
++    kind: "personal",
++    mode: "local-first",
++  });
++
++  // --- Shell surfaces: sidebar/file tree, status, agent panel ---
++  await expect(page.getByTestId("file-tree")).toBeVisible();
++  await expect(page.getByTestId("sync-status")).toBeVisible();
++  await expect(page.getByTestId("agent-panel")).toBeVisible();
++  // Agent activity is a panel with an empty-state action, not a paragraph.
++  await expect(page.getByTestId("agent-panel")).toContainText(/no agent runs/i);
++
++  // --- Keyboard: new file ---
++  await page.keyboard.press("ControlOrMeta+n");
++  const nameInput = page.getByRole("textbox", { name: /file name/i });
++  await expect(nameInput).toBeVisible();
++  await nameInput.fill("notes/today.md");
++  await nameInput.press("Enter");
++  await expect(
++    page.getByTestId("file-tree").getByText("today.md"),
++  ).toBeVisible();
++  expect(existsSync(join(workspaceRoot, "notes", "today.md"))).toBe(true);
++
++  // --- Keyboard: command palette opens, filters, closes ---
++  await page.keyboard.press("ControlOrMeta+k");
++  const palette = page.getByTestId("command-palette");
++  await expect(palette).toBeVisible();
++  await expect(palette.getByRole("option")).toHaveCount(5);
++  await expect(palette).toContainText(/import files/i);
++  await expect(palette).toContainText(/connect dohc cloud/i);
++  await page.keyboard.type("new");
++  await expect(palette.getByRole("option").first()).toContainText(/new/i);
++  await shot(page, "command-palette");
++  await page.keyboard.press("Escape");
++  await expect(palette).toHaveCount(0);
++
++  // --- Keyboard: quick-open jumps to a file ---
++  await page.keyboard.press("ControlOrMeta+p");
++  const quickOpen = page.getByTestId("quick-open");
++  await expect(quickOpen).toBeVisible();
++  await page.keyboard.type("today");
++  await expect(quickOpen.getByRole("option").first()).toContainText(
++    "notes/today.md",
++  );
++  await page.keyboard.press("Enter");
++  await expect(quickOpen).toHaveCount(0);
++  await expect(page.getByTestId("workspace-shell")).toContainText(
++    "notes/today.md",
++  );
++  await shot(page, "file-preview");
++
++  // --- Workspace switcher lists the current workspace ---
++  await page.getByTestId("workspace-switcher").click();
++  const switcherList = page.getByRole("listbox", { name: /workspaces/i });
++  await expect(switcherList.getByRole("option")).toHaveCount(1);
++  await expect(switcherList).toContainText("personal");
++  await page.getByTestId("workspace-switcher").click();
++
++  // --- Cloud connect is an honest surface, not a gate ---
++  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
++  await expect(page.getByTestId("cloud-sync-panel")).toContainText(
++    /fully functional locally/i,
++  );
++  await page.mouse.click(10, 10); // backdrop click closes
++  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);
++
++  // --- Layout holds at both required sizes, light and dark ---
++  for (const size of [
++    { width: 1280, height: 800 },
++    { width: 1536, height: 960 },
++  ]) {
++    await page.setViewportSize(size);
++    await expectNoOverflow(page);
++    await shot(page, "workspace-shell");
++  }
++  await page.emulateMedia({ colorScheme: "dark" });
++  await expect
++    .poll(async () =>
++      page.evaluate(() => document.documentElement.dataset.theme),
++    )
++    .toBe("dark");
++  await expectNoOverflow(page);
++  await shot(page, "workspace-shell");
++  await page.emulateMedia({ colorScheme: "light" });
++
++  // --- No marketing chrome anywhere in the shell ---
++  await expect(
++    page.getByText(/get started free|pricing|trusted by/i),
++  ).toHaveCount(0);
++
++  await app.close();
++});
++
++test("returning user lands directly in the shell, not first-run", async () => {
++  const { app, page, testHome } = await launchFirstRun();
++  await page.getByRole("button", { name: /create workspace/i }).click();
++  await expect(page.getByTestId("workspace-shell")).toBeVisible();
++  await app.close();
++
++  // Relaunch with the same test home: registry remembers the workspace.
++  const relaunchArgs = ["apps/desktop/dist/main/main.js"];
++  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
++    relaunchArgs.push("--no-sandbox");
++  }
++  const second = await electron.launch({
++    args: relaunchArgs,
++    cwd: process.cwd(),
++    env: {
++      ...process.env,
++      DOHC_DESKTOP_TEST: "1",
++      DOHC_TEST_HOME: testHome,
++    },
++  });
++  const page2 = await second.firstWindow();
++  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
++  await expect(
++    page2.getByRole("button", { name: /create workspace/i }),
++  ).toHaveCount(0);
++  await second.close();
++});
+diff --git a/apps/desktop/electron.vite.config.ts b/apps/desktop/electron.vite.config.ts
+index ba94e75..53a7d24 100644
+--- a/apps/desktop/electron.vite.config.ts
++++ b/apps/desktop/electron.vite.config.ts
+@@ -1,24 +1,30 @@
+-import { defineConfig } from "electron-vite";
++import tailwindcss from "@tailwindcss/vite";
++import react from "@vitejs/plugin-react";
++import { defineConfig, externalizeDepsPlugin } from "electron-vite";
+ 
+ export default defineConfig({
+   main: {
++    // Workspace packages ship raw TS — they must be bundled, not
++    // externalized, or Node ESM fails on their extensionless imports.
++    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
+     build: {
+       outDir: "dist/main",
+
+exec
+/bin/bash -lc "git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/vitest.config.ts apps/desktop/src/renderer/index.html apps/desktop/src/renderer/DesktopFirstRun.test.tsx apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/e2e/firstRunWorkspace.spec.ts | sed -n '240,520p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+       outDir: "dist/main",
+       lib: { entry: "src/main.ts" },
+     },
+   },
+   preload: {
+     build: {
+       outDir: "dist/preload",
+       // Sandboxed preloads must be CommonJS.
+       lib: { entry: "src/preload.ts", formats: ["cjs"] },
+     },
+   },
+   renderer: {
+     root: "src/renderer",
++    plugins: [react(), tailwindcss()],
+     build: {
+       outDir: "dist/renderer",
+       rollupOptions: { input: "src/renderer/index.html" },
+     },
+   },
+ });
+diff --git a/apps/desktop/package.json b/apps/desktop/package.json
+index 46bbf67..0a2d68f 100644
+--- a/apps/desktop/package.json
++++ b/apps/desktop/package.json
+@@ -1,27 +1,41 @@
+ {
+   "name": "@dohc/desktop",
+   "private": true,
+   "version": "0.1.0",
+   "type": "module",
+   "main": "dist/main/main.js",
+   "scripts": {
+     "dev": "electron-vite dev",
+     "build": "electron-vite build",
+     "test": "vitest run",
+     "typecheck": "tsc --noEmit"
+   },
+   "devDependencies": {
+     "@electron/fuses": "^2.1.2",
++    "@tailwindcss/vite": "^4.3.0",
++    "@testing-library/dom": "^10.4.1",
++    "@testing-library/react": "^16.3.2",
++    "@testing-library/user-event": "^14.6.1",
+     "@types/node": "^22.19.19",
++    "@types/react": "^19.2.15",
++    "@types/react-dom": "^19.2.3",
++    "@vitejs/plugin-react": "^6.0.2",
+     "electron": "^42.4.0",
+     "electron-builder": "^26.15.2",
+     "electron-vite": "^5.0.0",
++    "jsdom": "^29.1.1",
++    "tailwindcss": "^4.3.0",
+     "typescript": "^5.9.3",
+     "vite": "^8.0.14",
+     "vitest": "^2.1.9"
+   },
+   "dependencies": {
++    "@dohc/brand": "workspace:*",
++    "@dohc/workspace-core": "workspace:*",
+     "electron-updater": "^6.8.9",
++    "lucide-react": "^1.16.0",
++    "react": "^19.2.6",
++    "react-dom": "^19.2.6",
+     "zod": "^3.25.76"
+   }
+ }
+diff --git a/apps/desktop/src/renderer/DesktopFirstRun.test.tsx b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+new file mode 100644
+index 0000000..d0bcab9
+--- /dev/null
++++ b/apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+@@ -0,0 +1,108 @@
++// @vitest-environment jsdom
++import { cleanup, render, screen } from "@testing-library/react";
++import userEvent from "@testing-library/user-event";
++import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
++import { DesktopFirstRun } from "./DesktopFirstRun";
++
++const bridge = {
++  getVersion: vi.fn(async () => "0.1.0"),
++  getDefaultWorkspaceRoot: vi.fn(async () => "/home/ice/dohc"),
++  pickWorkspaceRoot: vi.fn(async () => "/home/ice/projects/research"),
++  createLocalWorkspace: vi.fn(async () => ({
++    workspaceId: "ws-1",
++    rootPath: "/home/ice/dohc/personal",
++    kind: "personal" as const,
++    mode: "local-first" as const,
++  })),
++  getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
++  listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
++  createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
++};
++
++beforeEach(() => {
++  vi.stubGlobal("dohcDesktop", bridge);
++});
++
++afterEach(() => {
++  cleanup();
++  vi.unstubAllGlobals();
++  vi.clearAllMocks();
++});
++
++describe("first run", () => {
++  it("suggests ~/dohc as the workspace location", async () => {
++    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
++    expect(await screen.findByText("/home/ice/dohc")).toBeTruthy();
++  });
++
++  it("lets the user choose another folder", async () => {
++    const user = userEvent.setup();
++    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
++    await user.click(
++      await screen.findByRole("button", { name: /choose.*folder/i }),
++    );
++    expect(bridge.pickWorkspaceRoot).toHaveBeenCalledOnce();
++    expect(await screen.findByText("/home/ice/projects/research")).toBeTruthy();
++  });
++
++  it("creates a personal workspace and hands it to the shell", async () => {
++    const user = userEvent.setup();
++    const onReady = vi.fn();
++    render(<DesktopFirstRun onWorkspaceReady={onReady} />);
++    await user.click(
++      await screen.findByRole("button", { name: /create workspace/i }),
++    );
++    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
++      expect.objectContaining({ kind: "personal" }),
++    );
++    expect(onReady).toHaveBeenCalledWith(
++      expect.objectContaining({ workspaceId: "ws-1" }),
++    );
++  });
++
++  it("never requires login and never renders auth fields", async () => {
++    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
++    await screen.findByText("/home/ice/dohc");
++    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
++    expect(screen.queryByRole("button", { name: /sign in|log in|sign up/i }))
++      .toBeNull();
++  });
++
++  it("mentions cloud sync as optional, not as a gate", async () => {
++    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
++    await screen.findByText("/home/ice/dohc");
++    const mention = screen.getByText(/cloud sync is optional/i);
++    expect(mention).toBeTruthy();
++  });
++
++  it("offers Enable dohc Cloud sync without forcing it", async () => {
++    const user = userEvent.setup();
++    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
++    await screen.findByText("/home/ice/dohc");
++    const offer = screen.getByRole("button", {
++      name: /enable dohc cloud sync/i,
++    });
++    await user.click(offer);
++    // The offer is truthful — it explains, never gates or asks for auth.
++    expect(
++      screen.getByText(/stays fully functional locally/i),
++    ).toBeTruthy();
++    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
++    expect(
++      screen.getByRole("button", { name: /create workspace/i }),
++    ).toBeTruthy();
++  });
++
++  it("reads like a desktop app, not a marketing page", async () => {
++    render(<DesktopFirstRun onWorkspaceReady={() => {}} />);
++    await screen.findByText("/home/ice/dohc");
++    // No marketing tropes: pricing, testimonials, feature grids, sign-up CTAs.
++    expect(
++      screen.queryByText(/get started free|pricing|testimonial|trusted by/i),
++    ).toBeNull();
++    // The primary action is creating a real workspace folder.
++    expect(
++      screen.getByRole("button", { name: /create workspace/i }),
++    ).toBeTruthy();
++  });
++});
+diff --git a/apps/desktop/src/renderer/index.html b/apps/desktop/src/renderer/index.html
+index 00237e8..1557140 100644
+--- a/apps/desktop/src/renderer/index.html
++++ b/apps/desktop/src/renderer/index.html
+@@ -1,37 +1,37 @@
+ <!doctype html>
+ <html lang="en">
+   <head>
+     <meta charset="UTF-8" />
+     <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
+     <title>dohc</title>
+     <style>
+       /* Warm paper + graphite, set inline so first paint is never unstyled. */
+       :root {
+         color-scheme: light dark;
+       }
+       html,
+       body {
+         margin: 0;
+         height: 100%;
+         background: #faf7f2;
+         color: #2b2926;
+         font-family:
+           system-ui,
+           -apple-system,
+           "Segoe UI",
+           sans-serif;
+       }
+       @media (prefers-color-scheme: dark) {
+         html,
+         body {
+           background: #1c1a18;
+           color: #e8e4de;
+         }
+       }
+     </style>
+   </head>
+   <body>
+     <div id="root"></div>
+-    <script type="module" src="./main.ts"></script>
++    <script type="module" src="./main.tsx"></script>
+   </body>
+ </html>
+diff --git a/apps/desktop/src/workspaces/workspaceFiles.test.ts b/apps/desktop/src/workspaces/workspaceFiles.test.ts
+new file mode 100644
+index 0000000..f749cfd
+--- /dev/null
++++ b/apps/desktop/src/workspaces/workspaceFiles.test.ts
+@@ -0,0 +1,64 @@
++import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
++import { tmpdir } from "node:os";
++import { join } from "node:path";
++import { beforeEach, describe, expect, it } from "vitest";
++import { copyIntoWorkspace, createFile, listFiles } from "./workspaceFiles";
++
++let root: string;
++
++beforeEach(async () => {
++  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
++});
++
++describe("createFile", () => {
++  it("creates nested files through validated paths", async () => {
++    const path = await createFile(root, "notes/./today.md");
++    expect(path).toBe("notes/today.md");
++    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
++  });
++
++  it("rejects traversal and reserved paths", async () => {
++    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
++    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
++  });
++
++  it("never overwrites an existing file", async () => {
++    await writeFile(join(root, "keep.md"), "original");
++    await createFile(root, "keep.md");
++    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
++  });
++});
++
++describe("listFiles", () => {
++  it("lists files but skips internal directories", async () => {
++    await mkdir(join(root, ".dohc"), { recursive: true });
++    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
++    await mkdir(join(root, "notes"), { recursive: true });
++    await writeFile(join(root, "notes", "a.md"), "");
++    await writeFile(join(root, "wallet.sqlite"), "");
++    const files = await listFiles(root);
++    expect(files).toEqual([
++      { path: "notes/a.md", kind: "file" },
++      { path: "wallet.sqlite", kind: "database" },
++    ]);
++  });
++});
++
++describe("copyIntoWorkspace", () => {
++  it("copies external files into the workspace root by basename", async () => {
++    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
++    await writeFile(join(outside, "receipt.png"), "png-bytes");
++    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
++    expect(imported).toEqual(["receipt.png"]);
+
+exec
+/bin/bash -lc "git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/vitest.config.ts | sed -n '520,760p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+exec
+/bin/bash -lc 'git show --no-ext-diff --unified=100 --no-renames 529c0d4 -- apps/desktop/src/workspaces/workspaceFiles.test.ts apps/desktop/vitest.config.ts' in /home/ice/dev/dohc
+ succeeded in 0ms:
+commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
+Author: Ice de Vera <iestyndevera@gmail.com>
+Date:   Wed Jun 10 18:26:33 2026 +0800
+
+    phase3: Add native desktop workspace shell
+    
+    First-run creates real workspace folders (suggested ~/dohc, manifest
+    via workspace-core, no account); shell ships every plan-required
+    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
+    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
+    never overwrites), truthful cloud-sync offer, agent activity panel,
+    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
+    Design review loop: 2 iterations, all hard items pass, judges
+    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
+    E2E (real on-disk assertions, relaunch persistence).
+    
+    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+diff --git a/apps/desktop/src/workspaces/workspaceFiles.test.ts b/apps/desktop/src/workspaces/workspaceFiles.test.ts
+new file mode 100644
+index 0000000..f749cfd
+--- /dev/null
++++ b/apps/desktop/src/workspaces/workspaceFiles.test.ts
+@@ -0,0 +1,64 @@
++import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
++import { tmpdir } from "node:os";
++import { join } from "node:path";
++import { beforeEach, describe, expect, it } from "vitest";
++import { copyIntoWorkspace, createFile, listFiles } from "./workspaceFiles";
++
++let root: string;
++
++beforeEach(async () => {
++  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
++});
++
++describe("createFile", () => {
++  it("creates nested files through validated paths", async () => {
++    const path = await createFile(root, "notes/./today.md");
++    expect(path).toBe("notes/today.md");
++    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
++  });
++
++  it("rejects traversal and reserved paths", async () => {
++    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
++    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
++  });
++
++  it("never overwrites an existing file", async () => {
++    await writeFile(join(root, "keep.md"), "original");
++    await createFile(root, "keep.md");
++    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
++  });
++});
++
++describe("listFiles", () => {
++  it("lists files but skips internal directories", async () => {
++    await mkdir(join(root, ".dohc"), { recursive: true });
++    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
++    await mkdir(join(root, "notes"), { recursive: true });
++    await writeFile(join(root, "notes", "a.md"), "");
++    await writeFile(join(root, "wallet.sqlite"), "");
++    const files = await listFiles(root);
++    expect(files).toEqual([
++      { path: "notes/a.md", kind: "file" },
++      { path: "wallet.sqlite", kind: "database" },
++    ]);
++  });
++});
++
++describe("copyIntoWorkspace", () => {
++  it("copies external files into the workspace root by basename", async () => {
++    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
++    await writeFile(join(outside, "receipt.png"), "png-bytes");
++    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
++    expect(imported).toEqual(["receipt.png"]);
++    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
++  });
++
++  it("skips files that already exist instead of overwriting", async () => {
++    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
++    await writeFile(join(outside, "notes.md"), "incoming");
++    await writeFile(join(root, "notes.md"), "existing");
++    const imported = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
++    expect(imported).toEqual([]);
++    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
++  });
++});
+diff --git a/apps/desktop/vitest.config.ts b/apps/desktop/vitest.config.ts
+index cfd92e3..1f7ba79 100644
+--- a/apps/desktop/vitest.config.ts
++++ b/apps/desktop/vitest.config.ts
+@@ -1,8 +1,8 @@
+ import { defineConfig } from "vitest/config";
+ 
+ // e2e/ runs under Playwright (playwright.config.ts), never vitest.
+ export default defineConfig({
+   test: {
+-    include: ["src/**/*.test.ts"],
++    include: ["src/**/*.test.{ts,tsx}"],
+   },
+ });
+
+exec
+/bin/bash -lc "ls packages && git ls-files packages/workspace-core packages/brand apps/desktop/src | sed -n '1,200p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+brand
+config
+workspace-contracts
+workspace-convex-compat
+workspace-core
+workspace-fs
+workspace-postgres
+apps/desktop/src/ipc/bridgeContract.ts
+apps/desktop/src/ipc/channels.ts
+apps/desktop/src/main.ts
+apps/desktop/src/performance/launchMarks.ts
+apps/desktop/src/preload.ts
+apps/desktop/src/renderer/CommandPalette.tsx
+apps/desktop/src/renderer/DesktopFirstRun.test.tsx
+apps/desktop/src/renderer/DesktopFirstRun.tsx
+apps/desktop/src/renderer/DesktopRoot.tsx
+apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
+apps/desktop/src/renderer/NewFileDialog.tsx
+apps/desktop/src/renderer/bridge.ts
+apps/desktop/src/renderer/index.html
+apps/desktop/src/renderer/main.tsx
+apps/desktop/src/renderer/styles.css
+apps/desktop/src/renderer/theme.ts
+apps/desktop/src/security/electronSecurity.test.ts
+apps/desktop/src/security/electronSecurity.ts
+apps/desktop/src/window/createMainWindow.ts
+apps/desktop/src/workspaces/WorkspaceRegistry.ts
+apps/desktop/src/workspaces/createWorkspaceFolder.ts
+apps/desktop/src/workspaces/workspaceFiles.test.ts
+apps/desktop/src/workspaces/workspaceFiles.ts
+packages/brand/package.json
+packages/brand/src/DohcLogo.tsx
+packages/brand/src/constants.ts
+packages/brand/src/index.ts
+packages/brand/src/tokens.css
+packages/workspace-core/package.json
+packages/workspace-core/src/changeSet.test.ts
+packages/workspace-core/src/changeSet.ts
+packages/workspace-core/src/conflicts.ts
+packages/workspace-core/src/index.ts
+packages/workspace-core/src/metadata.ts
+packages/workspace-core/src/paths.test.ts
+packages/workspace-core/src/paths.ts
+packages/workspace-core/src/workspaceMode.test.ts
+packages/workspace-core/src/workspaceMode.ts
+packages/workspace-core/tsconfig.json
+
+exec
+/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/index.ts && sed -n '1,240p' packages/workspace-core/src/paths.ts && sed -n '1,240p' packages/workspace-core/src/workspaceMode.ts && cat packages/workspace-core/package.json" in /home/ice/dev/dohc
+ succeeded in 0ms:
+export * from "./workspaceMode";
+export * from "./metadata";
+export * from "./paths";
+export * from "./changeSet";
+export * from "./conflicts";
+export function defaultWorkspaceRoot(homeDir: string): string {
+  return `${homeDir.replace(/\/+$/, "")}/dohc`;
+}
+
+export type FolderValidation = { ok: true } | { ok: false; reason: string };
+
+// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
+function isAbsolutePathLike(path: string): boolean {
+  return (
+    path.startsWith("/") ||
+    /^[A-Za-z]:[\\/]/.test(path) ||
+    path.startsWith("\\\\")
+  );
+}
+
+export function validateAttachedFolder(path: string): FolderValidation {
+  if (!isAbsolutePathLike(path)) {
+    return { ok: false, reason: "attached folders must be absolute paths" };
+  }
+  return { ok: true };
+}
+
+// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
+// so a case-sensitive guard would let writes overwrite dohc metadata.
+export function isReservedPath(relativePath: string): boolean {
+  const lower = relativePath.toLowerCase();
+  return lower === ".dohc" || lower.startsWith(".dohc/");
+}
+
+export type WritePathValidation =
+  | { ok: true; normalized: string }
+  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };
+
+export function validateUserWritePath(relativePath: string): WritePathValidation {
+  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
+  if (isAbsolutePathLike(relativePath)) return { ok: false, reason: "absolute" };
+  // Percent-encoded dots/separators are traversal in disguise; decode until
+  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
+  let decoded = relativePath;
+  for (;;) {
+    const next = decoded
+      .replace(/%25/gi, "%")
+      .replace(/%2e/gi, ".")
+      .replace(/%2f/gi, "/")
+      .replace(/%5c/gi, "\\");
+    if (next === decoded) break;
+    decoded = next;
+  }
+  // Decoding may reveal an absolute path (%2fetc, C%3A is out of scope but
+  // drive letters survive decoding as-is).
+  if (isAbsolutePathLike(decoded)) return { ok: false, reason: "absolute" };
+  const segments = decoded.replaceAll("\\", "/").split("/");
+  if (segments.includes("..")) return { ok: false, reason: "traversal" };
+  const normalized = segments
+    .filter((segment) => segment !== "" && segment !== ".")
+    .join("/");
+  if (normalized.length === 0) return { ok: false, reason: "invalid" };
+  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
+  return { ok: true, normalized };
+}
+
+export type PathClassification =
+  | { kind: "app-source"; appName: string }
+  | { kind: "database" }
+  | { kind: "file" };
+
+const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
+
+export function classifyPath(relativePath: string): PathClassification {
+  const segments = relativePath.split("/");
+  const appsIndex = segments.indexOf(".apps");
+  const appName = appsIndex === -1 ? undefined : segments[appsIndex + 1];
+  if (appName) return { kind: "app-source", appName };
+  const lower = relativePath.toLowerCase();
+  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
+    return { kind: "database" };
+  }
+  return { kind: "file" };
+}
+export type WorkspaceMode =
+  | "local-first"
+  | "cloud-first-local-copy"
+  | "cloud-only";
+
+export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+
+const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
+  personal: "local-first",
+  shared: "cloud-first-local-copy",
+  "cloud-only": "cloud-only",
+};
+
+export function defaultWorkspaceMode(kind: WorkspaceKind): WorkspaceMode {
+  return DEFAULT_MODE_BY_KIND[kind];
+}
+{
+  "name": "@dohc/workspace-core",
+  "private": true,
+  "type": "module",
+  "exports": {
+    ".": "./src/index.ts"
+  },
+  "scripts": {
+    "test": "vitest run",
+    "typecheck": "tsc --noEmit"
+  },
+  "devDependencies": {
+    "@types/node": "^22.19.19",
+    "typescript": "^5.9.3",
+    "vitest": "^2.1.9"
+  }
+}
+
+exec
+/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/metadata.ts && sed -n '1,180p' packages/workspace-core/src/paths.test.ts" in /home/ice/dev/dohc
+ succeeded in 0ms:
+import {
+  defaultWorkspaceMode,
+  type WorkspaceKind,
+  type WorkspaceMode,
+} from "./workspaceMode";
+
+// Mode lives on the workspace manifest and nowhere else: a workspace is
+// local-first, cloud-first, or cloud-only as a whole, never per file.
+export interface WorkspaceManifest {
+  version: 1;
+  workspaceId: string;
+  mode: WorkspaceMode;
+  kind: WorkspaceKind;
+}
+
+export function createWorkspaceManifest(input: {
+  workspaceId: string;
+  kind: WorkspaceKind;
+  mode?: WorkspaceMode;
+}): WorkspaceManifest {
+  return {
+    version: 1,
+    workspaceId: input.workspaceId,
+    kind: input.kind,
+    mode: input.mode ?? defaultWorkspaceMode(input.kind),
+  };
+}
+
+export interface FileRecord {
+  path: string;
+  contentHash: string;
+}
+
+export function createFileRecord(input: FileRecord): FileRecord {
+  return { path: input.path, contentHash: input.contentHash };
+}
+import { describe, expect, it } from "vitest";
+import {
+  classifyPath,
+  defaultWorkspaceRoot,
+  isReservedPath,
+  validateAttachedFolder,
+  validateUserWritePath,
+} from "./paths";
+
+describe("workspace roots", () => {
+  it("suggests ~/dohc as the default root", () => {
+    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
+  });
+
+  it("allows attaching arbitrary absolute folders", () => {
+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
+    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
+  });
+
+  it("allows Windows absolute folders (drive and UNC)", () => {
+    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
+    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
+    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
+  });
+
+  it("rejects relative paths as attached folders", () => {
+    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
+  });
+});
+
+describe("reserved paths", () => {
+  it("reserves .dohc/manifest.json and the .dohc subtree", () => {
+    expect(isReservedPath(".dohc/manifest.json")).toBe(true);
+    expect(isReservedPath(".dohc/history/0001.json")).toBe(true);
+    expect(isReservedPath("notes/today.md")).toBe(false);
+  });
+
+  it("reserves case-insensitive .dohc variants (case-insensitive filesystems)", () => {
+    expect(isReservedPath(".DOHC/manifest.json")).toBe(true);
+    const result = validateUserWritePath(".DoHc/manifest.json");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("reserved");
+  });
+
+  it("rejects user writes into reserved space", () => {
+    const result = validateUserWritePath(".dohc/manifest.json");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("reserved");
+  });
+});
+
+describe("path traversal", () => {
+  const traversals = [
+    "../escape.md",
+    "notes/../../etc/passwd",
+    "%2e%2e/sneak.md",
+    "..\\windows\\system32",
+    "a/%2E%2E/b",
+    "%252e%252e/double-encoded.md",
+    "..%2fescape.md",
+    "..%5cwindows",
+  ];
+
+  for (const candidate of traversals) {
+    it(`rejects traversal: ${JSON.stringify(candidate)}`, () => {
+      const result = validateUserWritePath(candidate);
+      expect(result.ok).toBe(false);
+      if (!result.ok) expect(result.reason).toBe("traversal");
+    });
+  }
+
+  it("rejects absolute paths inside a workspace", () => {
+    const result = validateUserWritePath("/etc/passwd");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("absolute");
+  });
+
+  it("rejects Windows drive-qualified and UNC write paths", () => {
+    for (const candidate of [
+      "C:\\Users\\ice\\secret.md",
+      "C:/Users/ice/secret.md",
+      "\\\\server\\share\\secret.md",
+    ]) {
+      const result = validateUserWritePath(candidate);
+      expect(result.ok).toBe(false);
+      if (!result.ok) expect(result.reason).toBe("absolute");
+    }
+  });
+
+  it("rejects encoded-slash absolute paths", () => {
+    const result = validateUserWritePath("%2fetc/passwd");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("absolute");
+  });
+
+  it("rejects null bytes", () => {
+    const result = validateUserWritePath("notes/a\0b.md");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("invalid");
+  });
+
+  it("accepts and normalizes ordinary nested paths", () => {
+    const result = validateUserWritePath("finance/./reports/q1.md");
+    expect(result.ok).toBe(true);
+    if (result.ok) expect(result.normalized).toBe("finance/reports/q1.md");
+  });
+});
+
+describe("path classification", () => {
+  it("treats .apps/<name>/app.json as visible app source", () => {
+    expect(classifyPath("finance/.apps/ledger/app.json")).toEqual({
+      kind: "app-source",
+      appName: "ledger",
+    });
+    expect(classifyPath(".apps/tracker/src/App.tsx")).toEqual({
+      kind: "app-source",
+      appName: "tracker",
+    });
+  });
+
+  it("treats .sqlite, .sqlite3, and .db files as visible databases", () => {
+    expect(classifyPath("finance/wallet.sqlite")).toEqual({ kind: "database" });
+    expect(classifyPath("data/cache.sqlite3")).toEqual({ kind: "database" });
+    expect(classifyPath("archive/old.db")).toEqual({ kind: "database" });
+  });
+
+  it("classifies everything else as a plain file", () => {
+    expect(classifyPath("notes/today.md")).toEqual({ kind: "file" });
+  });
+});
+
+exec
+/bin/bash -lc "grep -R \"personal\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md packages/workspace-core apps/desktop | sed -n '1,200p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+grep: apps/desktop/node_modules/.bin/tsc: No such file or directory
+grep: apps/desktop/node_modules/.bin/tsserver: No such file or directory
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:108:- Local-only personal workspace edits should not require approval.
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:692:expect(defaultWorkspaceMode("personal")).toBe("local-first");
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:725:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:938:- creates `personal` workspace.
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1038:Tests must assert creating `personal` writes:
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1041:~/dohc/personal/
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1053:  "kind": "personal"
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1434:- local-first personal workspace can sync after login.
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1536:- local-first personal workspaces work fully without Hocuspocus running.
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2307:2. create local-only personal workspace with no account.
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2372:- personal workspace defaults to local-first.
+docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2481:- Local-only personal workspace works with no account.
+packages/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
+packages/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
+packages/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+packages/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
+apps/desktop/src/ipc/bridgeContract.ts:17:  kind: z.enum(["personal", "shared", "cloud-only"]),
+apps/desktop/src/ipc/bridgeContract.ts:31:  kind: z.enum(["personal", "shared"]),
+apps/desktop/src/workspaces/createWorkspaceFolder.ts:25:  kind: Extract<WorkspaceKind, "personal" | "shared">;
+apps/desktop/src/renderer/DesktopFirstRun.tsx:30:        rootPath: `${root}/personal`,
+apps/desktop/src/renderer/DesktopFirstRun.tsx:31:        kind: "personal",
+apps/desktop/src/renderer/DesktopFirstRun.test.tsx:13:    rootPath: "/home/ice/dohc/personal",
+apps/desktop/src/renderer/DesktopFirstRun.test.tsx:14:    kind: "personal" as const,
+apps/desktop/src/renderer/DesktopFirstRun.test.tsx:48:  it("creates a personal workspace and hands it to the shell", async () => {
+apps/desktop/src/renderer/DesktopFirstRun.test.tsx:56:      expect.objectContaining({ kind: "personal" }),
+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
+apps/desktop/dist/main/main.js:23:	personal: "local-first",
+apps/desktop/dist/main/main.js:115:		"personal",
+apps/desktop/dist/main/main.js:129:	kind: z.enum(["personal", "shared"])
+apps/desktop/dist/renderer/assets/index-Cdgr5hPX.js:10264:				rootPath: `${root}/personal`,
+apps/desktop/dist/renderer/assets/index-Cdgr5hPX.js:10265:				kind: "personal"
+apps/desktop/e2e/firstRunWorkspace.spec.ts:74:  const workspaceRoot = join(testHome, "dohc", "personal");
+apps/desktop/e2e/firstRunWorkspace.spec.ts:81:    kind: "personal",
+apps/desktop/e2e/firstRunWorkspace.spec.ts:135:  await expect(switcherList).toContainText("personal");
+
+exec
+/bin/bash -lc "sed -n '930,1065p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
+ succeeded in 0ms:
+- Modify: current React app exports if reused from `apps/app/src`
+
+- [ ] **Step 1: Write failing first-run tests**
+
+Tests must assert first launch:
+
+- suggests `~/dohc`.
+- allows choosing another folder.
+- creates `personal` workspace.
+- does not require login.
+- offers "Enable dohc Cloud sync" but does not force it.
+- looks and behaves like a desktop app, not a web onboarding page.
+
+- [ ] **Step 2: Write failing native UX E2E**
+
+Playwright Electron test must assert:
+
+- app opens with a framelike desktop shell.
+- sidebar/file tree is immediately usable.
+- keyboard shortcuts work: new file, command palette, quick open.
+- theme follows system but does not interrupt running agent/sync work.
+- text does not overflow at 1280x800 and 1536x960.
+- screenshot comparison or screenshot artifact exists for first-run, workspace shell, command palette, and file preview.
+- app chrome uses muted dohc styling and does not render marketing/landing-page UI.
+- agent activity renders as a timeline/panel, not as one giant final paragraph.
+
+- [ ] **Step 3: Implement desktop-first shell**
+
+Reuse current React components per the component reuse map: the Phase 3 recon must produce `docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md`, classifying each candidate in `apps/app/src/components/` as (a) reuse as-is, (b) port with data-layer swap, or (c) rebuild — using the mechanical criterion: a component is reusable only if it has no imports from `convex/react`, `apps/app/convex/_generated`, or web router internals; otherwise its data access must be lifted to props fed by the typed desktop bridge. Implementer briefs cite this artifact, never "where sensible". Change UX that feels web-first.
+
+Desktop shell must include:
+
+- workspace switcher.
+- local sync status.
+- file tree.
+- editor/preview/app area.
+- agent/activity panel.
+- command palette.
+- upload/import action.
+- cloud sync connect button.
+
+Avoid landing-page UI. First screen should be the usable workspace.
+
+Visual style requirements:
+
+- preserve dohc's current simple muted styling.
+- use warm paper/graphite foundations.
+- keep sidebar density close to Obsidian/t3code rather than a SaaS dashboard.
+- use restrained hover/active states.
+- keep cards only for repeated items, modals, and genuinely framed tools.
+- make command palette and file switcher keyboard-first.
+- keep text readable and compact; no hero-sized type inside tool surfaces.
+- no decorative gradients/orbs/bokeh.
+- no AI-generated marketing copy inside the app shell.
+
+- [ ] **Step 4: Run visual smoke**
+
+```bash
+pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
+```
+
+Expected:
+
+- screenshot saved.
+- nonblank desktop shell.
+- no overlapping text.
+- first workspace created.
+- first-run and workspace shell screenshots look native, muted, and consistent with dohc.
+- command palette and file tree are visibly usable.
+
+- [ ] **Step 5: Delete-or-justify**
+
+Identify web-only onboarding UI that should not exist in desktop. Delete it if not needed for web/cloud-only; otherwise isolate it under web-only code.
+
+- [ ] **Step 6: Commit**
+
+```bash
+git add apps/desktop apps/app/src docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+git commit -m "Add native desktop workspace shell"
+```
+
+---
+
+## Phase 4: Local Workspace Registry And Folder Creation
+
+**Files:**
+
+- Create: `apps/desktop/src/workspaces/WorkspaceRegistry.ts`
+- Create: `apps/desktop/src/workspaces/WorkspaceRegistry.test.ts`
+- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
+- Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
+- Modify: `apps/desktop/src/ipc/bridgeContract.ts`
+- Modify: `apps/desktop/src/preload.ts`
+- Modify: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
+- Modify: `packages/workspace-core/src/metadata.ts`
+
+- [ ] **Step 1: Write failing registry tests**
+
+Tests must assert:
+
+- default root is suggested as `${home}/dohc`.
+- multiple attached folders are supported.
+- duplicate folder attachment is rejected.
+- local-only workspace does not require account.
+- shared/cloud workspaces record remote identity only after sync is enabled.
+
+- [ ] **Step 2: Write failing folder creation tests**
+
+Tests must assert creating `personal` writes:
+
+```txt
+~/dohc/personal/
+  .dohc/manifest.json
+  .context/me.md
+```
+
+Manifest includes:
+
+```json
+{
+  "version": 1,
+  "workspaceId": "...",
+  "mode": "local-first",
+  "kind": "personal"
+}
+```
+
+- [ ] **Step 3: Implement registry and folder creation**
+
+Use Electron safe storage or app user data path for the registry. Visible workspace content lives where the user chose.
+
+- [ ] **Step 4: Wire IPC**
+
+Expose validated desktop bridge methods:
+
+```ts
+
+exec
+/bin/bash -lc "sed -n '1065,1165p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
+ succeeded in 0ms:
+```ts
+listLocalWorkspaces()
+createLocalWorkspace(input)
+attachWorkspaceFolder(input)
+chooseWorkspaceRoot()
+```
+
+- [ ] **Step 5: Run tests**
+
+```bash
+pnpm --filter @dohc/desktop test src/workspaces
+pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
+```
+
+Expected: pass.
+
+- [ ] **Step 6: Commit**
+
+```bash
+git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+git commit -m "Add local workspace registry"
+```
+
+---
+
+## Phase 5: File Watcher, Batched Sync, And Local-First History
+
+**Files:**
+
+- Modify: `packages/workspace-fs/src/watch.ts`
+- Modify: `packages/workspace-fs/src/scan.ts`
+- Modify: `packages/workspace-fs/src/diff.ts`
+- Create: `packages/workspace-sync/package.json`
+- Create: `packages/workspace-sync/tsconfig.json`
+- Create: `packages/workspace-sync/src/batchedSync.ts`
+- Create: `packages/workspace-sync/src/batchedSync.test.ts`
+- Create: `packages/workspace-history/package.json`
+- Create: `packages/workspace-history/src/changeSetStore.ts`
+- Create: `packages/workspace-history/src/changeSetStore.test.ts`
+- Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
+
+- [ ] **Step 1: Install watcher dependency**
+
+```bash
+pnpm add --filter @dohc/workspace-fs chokidar
+```
+
+- [ ] **Step 2: Write failing batched sync tests**
+
+Tests must assert:
+
+- single markdown save syncs after settle delay.
+- 18 app-file writes group into one change set.
+- temp files are ignored.
+- SQLite WAL/journal writes do not sync raw transient files.
+- generated app build output under `.dohc/cache` does not sync as user content.
+
+- [ ] **Step 3: Write failing history tests**
+
+Tests must assert:
+
+- change set records user/agent/import/sync kind.
+- provenance points to source prompt/import/agent run where available.
+- human summary is generated or stored.
+- no Git conflict markers appear in user files.
+- the history store exposes an ordered change-set timeline queryable by the desktop UI: kind, author (human or agent), plain-language summary, files touched.
+
+- [ ] **Step 4: Implement batched sync**
+
+Use settled windows:
+
+```txt
+markdown/text: 500ms-2s
+app folders: group until quiet for 2s
+SQLite files: wait for WAL/journal settle or explicit import operation
+bulk changes: group as one change set
+```
+
+- [ ] **Step 5: Implement local history store**
+
+Store history under:
+
+```txt
+.dohc/history/
+.dohc/changes/
+```
+
+Do not require Git.
+
+- [ ] **Step 6: Wire desktop sync status and history surface**
+
+Desktop shell shows:
+
+- synced
+- syncing
+- local changes
+- conflict
+- cloud disconnected
+
+Also wire the workspace history surface — the "git log for everyday people":
+
+
+ succeeded in 82149ms:
+../vibeam-pr-0.4/AGENTS.md
+../vibeam-pr-0.4/agents/founding-engineer/AGENTS.md
+../vibeam-pr-0.4/agents/ceo/AGENTS.md
+../vibeam-pr-0.4/agents/cmo/AGENTS.md
+../vibeam-pr-0.4/agents/cos/AGENTS.md
+../extra/vibeam-mono/vibeam-app/AGENTS.md
+../extra/vibeam-mono/AGENTS.md
+../extra/vibeam-mono/vibe-gui/AGENTS.md
+../extra/vibeam-mono/agents/founding-engineer/AGENTS.md
+../extra/vibeam-mono/agents/ceo/AGENTS.md
+../extra/vibeam-mono/agents/cmo/AGENTS.md
+../extra/vibeam-mono/agents/cos/AGENTS.md
+../dohc/AGENTS.md
+../dohc/apps/app/AGENTS.md
+../vibeam-pr-0.3/AGENTS.md
+../vibeam-pr-0.3/agents/founding-engineer/AGENTS.md
+../vibeam-pr-0.3/agents/ceo/AGENTS.md
+../vibeam-pr-0.3/agents/cmo/AGENTS.md
+../vibeam-pr-0.3/agents/cos/AGENTS.md
+../projects/opflow/node_modules/ts-loader/AGENTS.md
+../projects/opflow/node_modules/recharts/AGENTS.md
+../projects/opflow/packages/frontend/node_modules/ts-loader/AGENTS.md
+../projects/opflow/packages/frontend/node_modules/recharts/AGENTS.md
+../projects/bundae/apps/web/AGENTS.md
+../projects/remote-ai-tool/vibeam/AGENTS.md
+../projects/remote-ai-tool/agentic-clis/AGENTS.md
+../vibeam-pr-0.2/AGENTS.md
+../vibeam-pr-0.2/agents/founding-engineer/AGENTS.md
+../vibeam-pr-0.2/agents/ceo/AGENTS.md
+../vibeam-pr-0.2/agents/cmo/AGENTS.md
+../vibeam-pr-0.2/agents/cos/AGENTS.md
+../work/vacuumlabs/swell/swhype/contracts/lib/devtools/AGENTS.md
+../work/vacuumlabs/swell/swhype/contracts/lib/devtools/packages/AGENTS.md
+../work/vacuumlabs/swell/swhype/contracts/lib/devtools/tests/AGENTS.md
+../work/vacuumlabs/swell/swhype/contracts/lib/devtools/examples/AGENTS.md
+../work/vacuumlabs/opnet/opnft-fun/AGENTS.md
+../work/vacuumlabs/opnet/opnft-fun/node_modules/recharts/AGENTS.md
+../work/vacuumlabs/opnet/opnft-fun/packages/db/AGENTS.md
+../work/vacuumlabs/opnet/opnft-fun/frontend/AGENTS.md
+../work/vacuumlabs/opnet/motoswap-ui/node_modules/recharts/AGENTS.md
+../work/vacuumlabs/opnet/momoto-bug-repro/node_modules/ts-loader/AGENTS.md
+../vibeam-pr-0.5/AGENTS.md
+../vibeam-pr-0.5/agents/founding-engineer/AGENTS.md
+../vibeam-pr-0.5/agents/ceo/AGENTS.md
+../vibeam-pr-0.5/agents/cmo/AGENTS.md
+../vibeam-pr-0.5/agents/cos/AGENTS.md
+../vibeam/vibeam-app/AGENTS.md
+../vibeam/AGENTS.md
+../vibeam/agents/founding-engineer/AGENTS.md
+../vibeam/agents/ceo/AGENTS.md
+../vibeam/agents/cmo/AGENTS.md
+../vibeam/agents/cos/AGENTS.md
+../oss-repos/codex/AGENTS.md
+../oss-repos/t3code/AGENTS.md
+../oss-repos/t3code/.repos/alchemy-effect/AGENTS.md
+../oss-repos/t3code/.repos/alchemy-effect/packages/alchemy/src/AWS/AGENTS.md
+../oss-repos/t3code/.repos/effect-smol/AGENTS.md
+../vibeam-pr-0.9/AGENTS.md
+../vibeam-pr-0.9/agents/founding-engineer/AGENTS.md
+../vibeam-pr-0.9/agents/ceo/AGENTS.md
+../vibeam-pr-0.9/agents/cmo/AGENTS.md
+../vibeam-pr-0.9/agents/cos/AGENTS.md
+
+exec
+/bin/bash -lc 'cat apps/desktop/tsconfig.json 2>/dev/null || ls apps/desktop && cat tsconfig.json' in /home/ice/dev/dohc
+ exited 1 in 0ms:
+{
+  "extends": "../../tsconfig.base.json",
+  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "electron.vite.config.ts", "playwright.config.ts"]
+}
+cat: tsconfig.json: No such file or directory
+
+exec
+/bin/bash -lc 'cat tsconfig.base.json && cat apps/desktop/playwright.config.ts && cat pnpm-workspace.yaml && cat package.json' in /home/ice/dev/dohc
+ succeeded in 0ms:
+{
+  "compilerOptions": {
+    "target": "ES2022",
+    "lib": ["dom", "dom.iterable", "ES2022"],
+    "module": "ESNext",
+    "moduleResolution": "Bundler",
+    "jsx": "react-jsx",
+    "strict": true,
+    "skipLibCheck": true,
+    "noEmit": true,
+    "allowJs": true,
+    "isolatedModules": true,
+    "incremental": true,
+    "resolveJsonModule": true,
+    "allowSyntheticDefaultImports": true,
+    "esModuleInterop": true,
+    "forceConsistentCasingInFileNames": true
+  }
+}
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
+packages:
+  - "apps/*"
+  - "packages/*"
+  - "services/*"
+
+# pnpm 10 ignores dependency build scripts by default; Electron's binary
+# download runs in its postinstall, so it must be allowlisted explicitly.
+onlyBuiltDependencies:
+  - electron
+  - electron-winstaller
+  - esbuild
+{
+  "name": "dohc",
+  "private": true,
+  "type": "module",
+  "engines": {
+    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
+    "pnpm": "10.24.0"
+  },
+  "scripts": {
+    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
+    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
+    "dev:desktop": "pnpm --filter @dohc/desktop dev",
+    "build:desktop": "pnpm --filter @dohc/desktop build",
+    "test:desktop": "pnpm --filter @dohc/desktop test",
+    "test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
+    "smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs",
+    "dev:sync": "node scripts/dev-sync.mjs",
+    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
+    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
+    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
+    "build": "pnpm -r --if-present build",
+    "start": "pnpm --filter @dohc/web --if-present run start",
+    "preview": "pnpm --filter @dohc/web --if-present run preview",
+    "reset:dev": "node scripts/reset-dev-data.mjs",
+    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
+    "typecheck": "pnpm -r --if-present typecheck",
+    "test": "pnpm -r --if-present test",
+    "test:e2e": "playwright test",
+    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
+    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
+    "lint": "pnpm -r --if-present lint",
+    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
+    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
+    "check:self-host": "node scripts/check-self-host.mjs",
+    "check:debt": "node scripts/check-tech-debt.mjs"
+  },
+  "packageManager": "pnpm@10.24.0",
+  "devDependencies": {
+    "@playwright/test": "^1.60.0"
+  }
+}
+
+exec
+/bin/bash -lc 'ls -l node_modules/playwright node_modules/@playwright/test apps/desktop/node_modules/playwright apps/desktop/node_modules/@playwright/test 2>/dev/null || true' in /home/ice/dev/dohc
+ succeeded in 0ms:
+node_modules/@playwright/test:
+total 60
+-rw-r--r-- 31 ice ice 11601 Sep  2  2025 LICENSE
+-rw-r--r-- 31 ice ice   254 Sep  2  2025 NOTICE
+-rw-r--r--  3 ice ice 11270 May 27 03:50 README.md
+-rwxr-xr-x  9 ice ice   707 Mar 24 17:22 cli.js
+-rw-r--r-- 17 ice ice   679 Mar 24 17:22 index.d.ts
+-rw-r--r--  9 ice ice   648 Mar 24 17:22 index.js
+-rw-r--r-- 17 ice ice   679 Mar 24 17:22 index.mjs
+-rw-r--r--  2 ice ice   754 May 27 03:50 package.json
+-rw-r--r--  9 ice ice   650 Mar 24 17:22 reporter.d.ts
+-rw-r--r-- 17 ice ice   645 Mar 24 17:22 reporter.js
+-rw-r--r-- 17 ice ice   645 Mar 24 17:22 reporter.mjs
+
+node_modules/playwright:
+total 80
+-rw-r--r-- 31 ice ice 11601 Sep  2  2025 LICENSE
+-rw-r--r-- 31 ice ice   254 Sep  2  2025 NOTICE
+-rw-r--r--  3 ice ice 11270 May 27 03:50 README.md
+-rw-r--r--  2 ice ice   705 May 27 03:50 ThirdPartyNotices.txt
+-rwxr-xr-x 12 ice ice   698 Sep  2  2025 cli.js
+-rw-r--r-- 12 ice ice   636 Sep  2  2025 index.d.ts
+-rw-r--r-- 12 ice ice   648 Sep  2  2025 index.js
+-rw-r--r-- 12 ice ice   704 Sep  2  2025 index.mjs
+-rw-r--r-- 12 ice ice   942 Sep  2  2025 jsx-runtime.js
+-rw-r--r-- 12 ice ice   764 Sep  2  2025 jsx-runtime.mjs
+drwxr-xr-x 11 ice ice  4096 May 27 03:50 lib
+-rw-r--r--  2 ice ice  1559 May 27 03:50 package.json
+-rw-r--r-- 12 ice ice   673 Sep  2  2025 test.d.ts
+-rw-r--r-- 12 ice ice   806 Sep  2  2025 test.js
+-rw-r--r--  2 ice ice  1400 May 27 03:50 test.mjs
+drwxr-xr-x  2 ice ice  4096 May 27 03:50 types
+
+exec
+/bin/bash -lc 'pnpm --filter @dohc/desktop exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
+ exited 1 in 463ms:
+ ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)
+
+Your pnpm version is incompatible with "/home/ice/dev/dohc".
+
+Expected version: 10.24.0
+Got: 9.14.4
+
+This is happening because the package's manifest has an engines.pnpm field specified.
+To fix this issue, install the required pnpm version globally.
+
+To install the latest version of pnpm, run "pnpm i -g pnpm".
+To check your pnpm version, run "pnpm -v".
+
+exec
+/bin/bash -lc './node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
+ succeeded in 1776ms:
+exec
+/bin/bash -lc './node_modules/.bin/vitest run --config apps/desktop/vitest.config.ts' in /home/ice/dev/dohc
+ exited 1 in 273ms:
+failed to load config from /home/ice/dev/dohc/apps/desktop/vitest.config.ts
+
+⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
+Error: EROFS: read-only file system, open '/home/ice/dev/dohc/apps/desktop/vitest.config.ts.timestamp-1781087367407-9f620007f5cc1.mjs'
+    at async open (node:internal/fs/promises:641:25)
+    at async Object.writeFile (node:internal/fs/promises:1249:14)
+    at async loadConfigFromBundledFile (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66973:5)
+    at async loadConfigFromFile (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66816:24)
+    at async resolveConfig (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66416:24)
+    at async _createServer (file:///home/ice/dev/dohc/node_modules/vitest/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:63015:18)
+    at async createViteServer (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:9842:18)
+    at async createVitest (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11461:18)
+    at async prepareVitest (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11884:15)
+    at async startVitest (file:///home/ice/dev/dohc/node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11813:15) {
+  errno: -30,
+  code: 'EROFS',
+  syscall: 'open',
+  path: '/home/ice/dev/dohc/apps/desktop/vitest.config.ts.timestamp-1781087367407-9f620007f5cc1.mjs'
+}
+
+
+
+
+exec
+/bin/bash -lc "cat packages/brand/package.json && sed -n '1,160p' packages/brand/src/tokens.css" in /home/ice/dev/dohc
+ succeeded in 0ms:
+{
+  "name": "@dohc/brand",
+  "private": true,
+  "type": "module",
+  "exports": {
+    ".": "./src/index.ts",
+    "./tokens.css": "./src/tokens.css"
+  },
+  "peerDependencies": {
+    "react": "^19.0.0"
+  },
+  "devDependencies": {
+    "@types/react": "^19.2.14",
+    "react": "^19.2.5"
+  }
+}
+/* dohc brand tokens — source of truth for the design system.
+ *
+ * Brand tokens are kept separate from component tokens so future theme
+ * work can change surfaces without changing the brand itself. Mirrors
+ * dohc-brand-bible.html sections 03 (color) and 04 (type). */
+
+:root {
+  --font-serif: 'Iowan Old Style', 'Charter', Georgia, serif;
+  --font-sans: 'Aptos', 'Segoe UI', ui-sans-serif, system-ui, sans-serif;
+  --font-mono: 'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
+
+  /* Light mode (warm paper) */
+  --dohc-bg: #f7f6f1;
+  --dohc-panel: #fffefa;
+  --dohc-panel-2: #ece9e1;
+  --dohc-ink: #151515;
+  --dohc-muted: #66635d;
+  --dohc-subtle: #8b867b;
+  --dohc-accent: #2d342e;
+  --dohc-line: rgba(21, 21, 21, 0.12);
+  --dohc-grid: rgba(21, 21, 21, 0.026);
+
+  /* Semantic state colors — muted, functional, never decorative */
+  --dohc-success: #4f7666;
+  --dohc-warning: #a77a35;
+  --dohc-danger: #b64b37;
+  --dohc-info: #3868a6;
+}
+
+[data-theme='dark'] {
+  /* Dark mode — warm ink, never pure black/white. Neutral-charcoal
+   * background, faint green-black card surface, darker neutral-charcoal
+   * side panels (panel-2). */
+  --dohc-bg: #100f0e;
+  --dohc-panel: #191c1a;
+  --dohc-panel-2: #0e0e0d;
+  --dohc-ink: #f4f1ea;
+  --dohc-muted: #aaa69c;
+  --dohc-subtle: #78746d;
+  --dohc-accent: #d7d0c0;
+  --dohc-line: rgba(244, 241, 234, 0.14);
+  --dohc-grid: rgba(244, 241, 234, 0.035);
+}
+
+exec
+/bin/bash -lc "nl -ba apps/desktop/src/workspaces/createWorkspaceFolder.ts | sed -n '1,120p'
+nl -ba apps/desktop/src/renderer/DesktopWorkspaceShell.tsx | sed -n '1,240p'
+nl -ba apps/desktop/src/workspaces/WorkspaceRegistry.ts | sed -n '1,120p'
+nl -ba apps/desktop/src/main.ts | sed -n '1,150p'
+nl -ba apps/desktop/src/workspaces/workspaceFiles.ts | sed -n '1,120p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+     1	import {
+     2	  createWorkspaceManifest,
+     3	  defaultWorkspaceMode,
+     4	  type WorkspaceKind,
+     5	} from "@dohc/workspace-core";
+     6	import { randomUUID } from "node:crypto";
+     7	import { mkdir, writeFile } from "node:fs/promises";
+     8	import { join } from "node:path";
+     9	
+    10	export interface CreatedWorkspace {
+    11	  workspaceId: string;
+    12	  rootPath: string;
+    13	  kind: WorkspaceKind;
+    14	  mode: ReturnType<typeof defaultWorkspaceMode>;
+    15	}
+    16	
+    17	const FIRST_CONTEXT = `# About me
+    18	
+    19	Tell your agents who you are and how you like to work.
+    20	This file lives at .context/me.md inside your workspace folder.
+    21	`;
+    22	
+    23	export async function createWorkspaceFolder(input: {
+    24	  rootPath: string;
+    25	  kind: Extract<WorkspaceKind, "personal" | "shared">;
+    26	}): Promise<CreatedWorkspace> {
+    27	  const manifest = createWorkspaceManifest({
+    28	    workspaceId: randomUUID(),
+    29	    kind: input.kind,
+    30	  });
+    31	
+    32	  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
+    33	  await mkdir(join(input.rootPath, ".context"), { recursive: true });
+    34	  await writeFile(
+    35	    join(input.rootPath, ".dohc", "manifest.json"),
+    36	    `${JSON.stringify(manifest, null, 2)}\n`,
+    37	  );
+    38	  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
+    39	    flag: "wx",
+    40	  }).catch((error: unknown) => {
+    41	    // An existing me.md is the user's; never overwrite it. Real failures
+    42	    // (permissions, disk) must still surface.
+    43	    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
+    44	  });
+    45	
+    46	  return {
+    47	    workspaceId: manifest.workspaceId,
+    48	    rootPath: input.rootPath,
+    49	    kind: input.kind,
+    50	    mode: manifest.mode,
+    51	  };
+    52	}
+     1	import {
+     2	  Bot,
+     3	  Check,
+     4	  ChevronsUpDown,
+     5	  Cloud,
+     6	  Database,
+     7	  FilePlus2,
+     8	  FileText,
+     9	  Import,
+    10	  LayoutGrid,
+    11	} from "lucide-react";
+    12	import { useCallback, useEffect, useMemo, useState } from "react";
+    13	import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
+    14	import { bridge } from "./bridge";
+    15	import { CommandPalette, type Command } from "./CommandPalette";
+    16	import { NewFileDialog } from "./NewFileDialog";
+    17	import { toggleTheme } from "./theme";
+    18	
+    19	export type Workspace = WorkspaceSummary;
+    20	
+    21	function workspaceName(workspace: Workspace): string {
+    22	  return workspace.rootPath.split("/").pop() ?? "workspace";
+    23	}
+    24	
+    25	function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
+    26	  if (kind === "database") return <Database size={13} aria-hidden />;
+    27	  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
+    28	  return <FileText size={13} aria-hidden />;
+    29	}
+    30	
+    31	export function DesktopWorkspaceShell(props: {
+    32	  workspace: Workspace;
+    33	  workspaces: Workspace[];
+    34	  onSwitchWorkspace: (workspace: Workspace) => void;
+    35	}) {
+    36	  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
+    37	  const [selected, setSelected] = useState<string | null>(null);
+    38	  const [paletteOpen, setPaletteOpen] = useState(false);
+    39	  const [newFileOpen, setNewFileOpen] = useState(false);
+    40	  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
+    41	  const [switcherOpen, setSwitcherOpen] = useState(false);
+    42	  const [cloudOpen, setCloudOpen] = useState(false);
+    43	
+    44	  const importFiles = useCallback(async () => {
+    45	    await bridge().importWorkspaceFiles({
+    46	      workspaceId: props.workspace.workspaceId,
+    47	    });
+    48	    const result = await bridge().listWorkspaceFiles({
+    49	      workspaceId: props.workspace.workspaceId,
+    50	    });
+    51	    setFiles(result.files);
+    52	  }, [props.workspace.workspaceId]);
+    53	
+    54	  const refreshFiles = useCallback(async () => {
+    55	    const result = await bridge().listWorkspaceFiles({
+    56	      workspaceId: props.workspace.workspaceId,
+    57	    });
+    58	    setFiles(result.files);
+    59	  }, [props.workspace.workspaceId]);
+    60	
+    61	  useEffect(() => {
+    62	    void refreshFiles();
+    63	  }, [refreshFiles]);
+    64	
+    65	  useEffect(() => {
+    66	    function onKeyDown(event: KeyboardEvent) {
+    67	      const mod = event.metaKey || event.ctrlKey;
+    68	      if (!mod) return;
+    69	      if (event.key === "n") {
+    70	        event.preventDefault();
+    71	        setNewFileOpen(true);
+    72	      } else if (event.key === "k") {
+    73	        event.preventDefault();
+    74	        setPaletteOpen((open) => !open);
+    75	      } else if (event.key === "p") {
+    76	        event.preventDefault();
+    77	        setQuickOpenOpen((open) => !open);
+    78	      }
+    79	    }
+    80	    window.addEventListener("keydown", onKeyDown);
+    81	    return () => window.removeEventListener("keydown", onKeyDown);
+    82	  }, []);
+    83	
+    84	  const commands = useMemo<Command[]>(
+    85	    () => [
+    86	      {
+    87	        id: "new-file",
+    88	        label: "New file",
+    89	        run: () => setNewFileOpen(true),
+    90	      },
+    91	      {
+    92	        id: "quick-open",
+    93	        label: "Go to file",
+    94	        run: () => setQuickOpenOpen(true),
+    95	      },
+    96	      {
+    97	        id: "import-files",
+    98	        label: "Import files into workspace",
+    99	        run: () => void importFiles(),
+   100	      },
+   101	      {
+   102	        id: "connect-cloud",
+   103	        label: "Connect dohc Cloud",
+   104	        run: () => setCloudOpen(true),
+   105	      },
+   106	      {
+   107	        id: "toggle-theme",
+   108	        label: "Toggle light/dark theme",
+   109	        run: toggleTheme,
+   110	      },
+   111	    ],
+   112	    [importFiles],
+   113	  );
+   114	
+   115	  return (
+   116	    <div
+   117	      data-testid="workspace-shell"
+   118	      className="app-chrome flex h-screen flex-col bg-bg text-ink"
+   119	    >
+   120	      <div className="flex min-h-0 flex-1">
+   121	        {/* Sidebar */}
+   122	        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2">
+   123	          <header className="relative border-b border-line">
+   124	            <button
+   125	              type="button"
+   126	              data-testid="workspace-switcher"
+   127	              aria-haspopup="listbox"
+   128	              aria-expanded={switcherOpen}
+   129	              onClick={() => setSwitcherOpen((open) => !open)}
+   130	              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-panel"
+   131	            >
+   132	              <span className="truncate text-[13px] font-semibold">
+   133	                {workspaceName(props.workspace)}
+   134	              </span>
+   135	              <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
+   136	            </button>
+   137	            {switcherOpen ? (
+   138	              <ul
+   139	                role="listbox"
+   140	                aria-label="Workspaces"
+   141	                className="absolute left-2 right-2 top-full z-20 mt-1 m-0 list-none rounded border border-line bg-panel p-1 shadow-md"
+   142	              >
+   143	                {props.workspaces.map((candidate) => (
+   144	                  <li key={candidate.workspaceId} role="option" aria-selected={candidate.workspaceId === props.workspace.workspaceId}>
+   145	                    <button
+   146	                      type="button"
+   147	                      onClick={() => {
+   148	                        setSwitcherOpen(false);
+   149	                        props.onSwitchWorkspace(candidate);
+   150	                      }}
+   151	                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-muted hover:text-ink"
+   152	                    >
+   153	                      {candidate.workspaceId === props.workspace.workspaceId ? (
+   154	                        <Check size={12} aria-hidden />
+   155	                      ) : (
+   156	                        <span className="w-3" aria-hidden />
+   157	                      )}
+   158	                      <span className="truncate">{workspaceName(candidate)}</span>
+   159	                      <span className="ml-auto text-[10px] uppercase text-subtle">
+   160	                        {candidate.kind}
+   161	                      </span>
+   162	                    </button>
+   163	                  </li>
+   164	                ))}
+   165	              </ul>
+   166	            ) : null}
+   167	          </header>
+   168	
+   169	          <nav
+   170	            data-testid="file-tree"
+   171	            aria-label="Files"
+   172	            className="min-h-0 flex-1 overflow-y-auto py-1"
+   173	          >
+   174	            {files.length === 0 ? (
+   175	              <button
+   176	                type="button"
+   177	                onClick={() => setNewFileOpen(true)}
+   178	                className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
+   179	              >
+   180	                <FilePlus2 size={13} aria-hidden />
+   181	                Create your first file
+   182	              </button>
+   183	            ) : (
+   184	              <ul className="m-0 list-none p-0">
+   185	                {files.map((file) => (
+   186	                  <li key={file.path}>
+   187	                    <button
+   188	                      type="button"
+   189	                      onClick={() => setSelected(file.path)}
+   190	                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
+   191	                        selected === file.path
+   192	                          ? "bg-panel text-ink"
+   193	                          : "text-muted hover:text-ink"
+   194	                      }`}
+   195	                    >
+   196	                      <FileIcon kind={file.kind} />
+   197	                      <span className="truncate">{file.path}</span>
+   198	                    </button>
+   199	                  </li>
+   200	                ))}
+   201	              </ul>
+   202	            )}
+   203	          </nav>
+   204	
+   205	          <footer className="flex flex-col gap-1 border-t border-line px-3 py-1.5">
+   206	            <button
+   207	              type="button"
+   208	              onClick={() => setNewFileOpen(true)}
+   209	              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
+   210	            >
+   211	              <FilePlus2 size={13} aria-hidden />
+   212	              New file
+   213	              <kbd className="ml-auto font-mono text-[10px] text-subtle">
+   214	                Ctrl N
+   215	              </kbd>
+   216	            </button>
+   217	            <button
+   218	              type="button"
+   219	              onClick={() => void importFiles()}
+   220	              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
+   221	            >
+   222	              <Import size={13} aria-hidden />
+   223	              Import files
+   224	            </button>
+   225	          </footer>
+   226	        </aside>
+   227	
+   228	        {/* Main area */}
+   229	        <main className="flex min-w-0 flex-1 items-center justify-center bg-bg">
+   230	          {selected ? (
+   231	            <div className="flex flex-col items-center gap-1 text-center">
+   232	              <span className="font-mono text-[13px] text-ink">{selected}</span>
+   233	              <span className="text-xs text-subtle">
+   234	                File editing arrives with the editor surface.
+   235	              </span>
+   236	            </div>
+   237	          ) : (
+   238	            <div className="flex flex-col items-center gap-2 text-center">
+   239	              <span className="text-sm text-muted">
+   240	                Select a file, or create one
+     1	import { app } from "electron";
+     2	import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
+     3	import { homedir } from "node:os";
+     4	import { dirname, join } from "node:path";
+     5	import type { CreatedWorkspace } from "./createWorkspaceFolder";
+     6	
+     7	// Registry of known local workspaces. Lives in Electron userData; in test
+     8	// mode it lives under DOHC_TEST_HOME so E2E runs are hermetic. Phase 4
+     9	// formalizes attachment/duplicate rules with dedicated tests.
+    10	
+    11	function testHome(): string | null {
+    12	  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged
+    13	    ? (process.env.DOHC_TEST_HOME ?? null)
+    14	    : null;
+    15	}
+    16	
+    17	export function effectiveHome(): string {
+    18	  return testHome() ?? homedir();
+    19	}
+    20	
+    21	function registryPath(): string {
+    22	  const base = testHome() ?? app.getPath("userData");
+    23	  return join(base, "dohc-workspaces.json");
+    24	}
+    25	
+    26	interface RegistryFile {
+    27	  version: 1;
+    28	  workspaces: CreatedWorkspace[];
+    29	}
+    30	
+    31	function readRegistry(): RegistryFile {
+    32	  try {
+    33	    const parsed = JSON.parse(
+    34	      readFileSync(registryPath(), "utf8"),
+    35	    ) as RegistryFile;
+    36	    return parsed.version === 1 ? parsed : { version: 1, workspaces: [] };
+    37	  } catch {
+    38	    return { version: 1, workspaces: [] };
+    39	  }
+    40	}
+    41	
+    42	function writeRegistry(registry: RegistryFile): void {
+    43	  mkdirSync(dirname(registryPath()), { recursive: true });
+    44	  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
+    45	}
+    46	
+    47	export function listWorkspaces(): CreatedWorkspace[] {
+    48	  return readRegistry().workspaces;
+    49	}
+    50	
+    51	export function registerWorkspace(workspace: CreatedWorkspace): void {
+    52	  const registry = readRegistry();
+    53	  if (registry.workspaces.some((w) => w.rootPath === workspace.rootPath)) {
+    54	    return;
+    55	  }
+    56	  registry.workspaces.push(workspace);
+    57	  writeRegistry(registry);
+    58	}
+    59	
+    60	export function findWorkspace(workspaceId: string): CreatedWorkspace | null {
+    61	  return (
+    62	    readRegistry().workspaces.find((w) => w.workspaceId === workspaceId) ??
+    63	    null
+    64	  );
+    65	}
+     1	import { defaultWorkspaceRoot } from "@dohc/workspace-core";
+     2	import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
+     3	import {
+     4	  CreateLocalWorkspacePayload,
+     5	  CreateWorkspaceFilePayload,
+     6	  CreateWorkspaceFileResult,
+     7	  DefaultWorkspaceRootResult,
+     8	  ImportWorkspaceFilesPayload,
+     9	  ImportWorkspaceFilesResult,
+    10	  LaunchMarksResult,
+    11	  ListWorkspaceFilesPayload,
+    12	  ListWorkspaceFilesResult,
+    13	  PickWorkspaceRootResult,
+    14	  VersionResult,
+    15	  WorkspaceRegistryResult,
+    16	  WorkspaceSummary,
+    17	} from "./ipc/bridgeContract";
+    18	import { CHANNELS } from "./ipc/channels";
+    19	import { launchMarks } from "./performance/launchMarks";
+    20	import { decideNavigation } from "./security/electronSecurity";
+    21	import { navigationPolicy } from "./window/createMainWindow";
+    22	import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
+    23	import {
+    24	  effectiveHome,
+    25	  findWorkspace,
+    26	  listWorkspaces,
+    27	  registerWorkspace,
+    28	} from "./workspaces/WorkspaceRegistry";
+    29	import {
+    30	  copyIntoWorkspace,
+    31	  createFile,
+    32	  listFiles,
+    33	} from "./workspaces/workspaceFiles";
+    34	
+    35	function requireWorkspace(workspaceId: string) {
+    36	  const workspace = findWorkspace(workspaceId);
+    37	  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
+    38	  return workspace;
+    39	}
+    40	
+    41	// IPC is an untrusted boundary: handlers only answer frames the navigation
+    42	// policy itself would allow (exact dev origin or the packaged bundle).
+    43	function isTrustedFrame(frameUrl: string): boolean {
+    44	  return decideNavigation(frameUrl, navigationPolicy()).action === "allow";
+    45	}
+    46	
+    47	function assertTrustedSender(event: IpcMainInvokeEvent): void {
+    48	  const frameUrl = event.senderFrame?.url ?? "";
+    49	  if (!isTrustedFrame(frameUrl)) {
+    50	    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
+    51	  }
+    52	}
+    53	
+    54	function registerIpcHandlers(): void {
+    55	  ipcMain.handle(CHANNELS.getVersion, (event) => {
+    56	    assertTrustedSender(event);
+    57	    return VersionResult.parse(app.getVersion());
+    58	  });
+    59	
+    60	  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
+    61	    assertTrustedSender(event);
+    62	    const result = await dialog.showOpenDialog({
+    63	      properties: ["openDirectory", "createDirectory"],
+    64	    });
+    65	    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
+    66	    return PickWorkspaceRootResult.parse(picked);
+    67	  });
+    68	
+    69	  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
+    70	    assertTrustedSender(event);
+    71	    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
+    72	  });
+    73	
+    74	  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
+    75	    assertTrustedSender(event);
+    76	    return DefaultWorkspaceRootResult.parse(
+    77	      defaultWorkspaceRoot(effectiveHome()),
+    78	    );
+    79	  });
+    80	
+    81	  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
+    82	    assertTrustedSender(event);
+    83	    const input = CreateLocalWorkspacePayload.parse(payload);
+    84	    const created = await createWorkspaceFolder(input);
+    85	    registerWorkspace(created);
+    86	    return WorkspaceSummary.parse(created);
+    87	  });
+    88	
+    89	  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
+    90	    assertTrustedSender(event);
+    91	    const input = ListWorkspaceFilesPayload.parse(payload);
+    92	    const workspace = requireWorkspace(input.workspaceId);
+    93	    return ListWorkspaceFilesResult.parse({
+    94	      files: await listFiles(workspace.rootPath),
+    95	    });
+    96	  });
+    97	
+    98	  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
+    99	    assertTrustedSender(event);
+   100	    const input = CreateWorkspaceFilePayload.parse(payload);
+   101	    const workspace = requireWorkspace(input.workspaceId);
+   102	    const path = await createFile(workspace.rootPath, input.relativePath);
+   103	    return CreateWorkspaceFileResult.parse({ path });
+   104	  });
+   105	
+   106	  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
+   107	    assertTrustedSender(event);
+   108	    const input = ImportWorkspaceFilesPayload.parse(payload);
+   109	    const workspace = requireWorkspace(input.workspaceId);
+   110	    const result = await dialog.showOpenDialog({
+   111	      properties: ["openFile", "multiSelections"],
+   112	      title: "Import files into workspace",
+   113	    });
+   114	    const imported = result.canceled
+   115	      ? []
+   116	      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
+   117	    return ImportWorkspaceFilesResult.parse({ imported });
+   118	  });
+   119	
+   120	  ipcMain.on(CHANNELS.firstPaint, (event) => {
+   121	    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
+   122	      launchMarks.firstPaint();
+   123	    }
+   124	  });
+   125	
+   126	  // Double-gated: env flag AND unpackaged build. A packaged app launched
+   127	  // with the env var set must never grow test surface.
+   128	  if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
+   129	    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
+   130	      assertTrustedSender(event);
+   131	      return LaunchMarksResult.parse(launchMarks.snapshot());
+   132	    });
+   133	  }
+   134	}
+   135	
+   136	// Single-instance lock gates the entire bootstrap, not just a quit() call.
+   137	if (!app.requestSingleInstanceLock()) {
+   138	  app.quit();
+   139	} else {
+   140	  void app.whenReady().then(async () => {
+   141	    launchMarks.appReady();
+   142	    registerIpcHandlers();
+   143	    const { createMainWindow } = await import("./window/createMainWindow");
+   144	    createMainWindow();
+   145	    launchMarks.firstWindow();
+   146	  });
+   147	
+   148	  app.on("window-all-closed", () => {
+   149	    if (process.platform !== "darwin") app.quit();
+   150	  });
+     1	import {
+     2	  classifyPath,
+     3	  validateUserWritePath,
+     4	} from "@dohc/workspace-core";
+     5	import { constants } from "node:fs";
+     6	import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
+     7	import { basename, dirname, join } from "node:path";
+     8	import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
+     9	
+    10	const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
+    11	
+    12	export async function listFiles(
+    13	  rootPath: string,
+    14	): Promise<WorkspaceFileEntry[]> {
+    15	  const entries: WorkspaceFileEntry[] = [];
+    16	
+    17	  async function walk(dir: string, prefix: string): Promise<void> {
+    18	    const dirents = await readdir(dir, { withFileTypes: true });
+    19	    for (const dirent of dirents) {
+    20	      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
+    21	      if (dirent.isDirectory()) {
+    22	        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
+    23	      } else {
+    24	        const classified = classifyPath(rel);
+    25	        entries.push({
+    26	          path: rel,
+    27	          kind: classified.kind === "database" ? "database"
+    28	            : classified.kind === "app-source" ? "app-source"
+    29	            : "file",
+    30	        });
+    31	      }
+    32	    }
+    33	  }
+    34	
+    35	  await walk(rootPath, "");
+    36	  entries.sort((a, b) => a.path.localeCompare(b.path));
+    37	  return entries;
+    38	}
+    39	
+    40	export async function createFile(
+    41	  rootPath: string,
+    42	  relativePath: string,
+    43	): Promise<string> {
+    44	  const validated = validateUserWritePath(relativePath);
+    45	  if (!validated.ok) {
+    46	    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
+    47	  }
+    48	  const absolute = join(rootPath, validated.normalized);
+    49	  await mkdir(dirname(absolute), { recursive: true });
+    50	  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
+    51	    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
+    52	  });
+    53	  return validated.normalized;
+    54	}
+    55	
+    56	// Imports copy external files into the workspace root by basename; existing
+    57	// files are never overwritten (skipped, not errored — imports are additive).
+    58	export async function copyIntoWorkspace(
+    59	  rootPath: string,
+    60	  absolutePaths: string[],
+    61	): Promise<string[]> {
+    62	  const imported: string[] = [];
+    63	  for (const source of absolutePaths) {
+    64	    const name = basename(source);
+    65	    const validated = validateUserWritePath(name);
+    66	    if (!validated.ok) continue;
+    67	    try {
+    68	      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
+    69	      imported.push(validated.normalized);
+    70	    } catch (error) {
+    71	      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
+    72	    }
+    73	  }
+    74	  return imported;
+    75	}
+
+exec
+/bin/bash -lc "sed -n '1,240p' apps/desktop/src/window/createMainWindow.ts && sed -n '1,240p' apps/desktop/src/security/electronSecurity.ts && sed -n '1,220p' apps/desktop/src/security/electronSecurity.test.ts" in /home/ice/dev/dohc
+ succeeded in 117ms:
+import { app, BrowserWindow, shell } from "electron";
+import { join } from "node:path";
+import { pathToFileURL } from "node:url";
+import {
+  createMainWindowWebPreferences,
+  decideNavigation,
+  shouldOpenExternally,
+  validateDevServerUrl,
+  type NavigationPolicy,
+} from "../security/electronSecurity";
+
+// Warm paper — set before first paint so launch never flashes white.
+const BACKGROUND_COLOR = "#faf7f2";
+
+function devServerUrl(): string | null {
+  return validateDevServerUrl(
+    process.env.ELECTRON_RENDERER_URL,
+    app.isPackaged,
+  );
+}
+
+export function navigationPolicy(): NavigationPolicy {
+  const devServer = devServerUrl();
+  if (devServer) {
+    // Dev: exact loopback dev-server origin only; no file navigation at all.
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
+    if (shouldOpenExternally(url)) void shell.openExternal(url);
+    return { action: "deny" };
+  });
+
+  // Top-frame navigations, server redirects, and subframe navigations all
+  // go through the same policy: each is a separate Electron surface.
+  const denyDisallowed = (event: { preventDefault(): void }, url: string) => {
+    if (decideNavigation(url, navigationPolicy()).action === "deny") {
+      event.preventDefault();
+    }
+  };
+  window.webContents.on("will-navigate", denyDisallowed);
+  window.webContents.on("will-redirect", denyDisallowed);
+  window.webContents.on("will-frame-navigate", (event) => {
+    denyDisallowed(event, event.url);
+  });
+
+  window.once("ready-to-show", () => window.show());
+
+  const devServer = devServerUrl();
+  if (devServer) {
+    void window.loadURL(devServer);
+  } else {
+    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
+  }
+
+  return window;
+}
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
+// window.open never creates a BrowserWindow (callers always deny). http(s)
+// targets are handed to the OS browser; every other scheme is dropped.
+export function shouldOpenExternally(targetUrl: string): boolean {
+  try {
+    const protocol = new URL(targetUrl).protocol;
+    return protocol === "https:" || protocol === "http:";
+  } catch {
+    return false;
+  }
+}
+
+// The dev-server URL is only honored in unpackaged dev builds and only when
+// it points at loopback: a packaged app launched with ELECTRON_RENDERER_URL
+// set must never load (or IPC-trust) an arbitrary origin.
+const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
+
+export function validateDevServerUrl(
+  raw: string | undefined,
+  isPackaged: boolean,
+): string | null {
+  if (!raw || isPackaged) return null;
+  try {
+    const url = new URL(raw);
+    const httpLike = url.protocol === "http:" || url.protocol === "https:";
+    return httpLike && LOOPBACK_HOSTS.has(url.hostname) ? raw : null;
+  } catch {
+    return null;
+  }
+}
+import { describe, expect, it } from "vitest";
+import {
+  createMainWindowWebPreferences,
+  decideNavigation,
+  shouldOpenExternally,
+  validateDevServerUrl,
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
+
+  it("denies about:blank and javascript: URLs", () => {
+    expect(decideNavigation("about:blank", policy).action).toBe("deny");
+    expect(decideNavigation("javascript:alert(1)", policy).action).toBe(
+      "deny",
+    );
+  });
+});
+
+describe("dev server URL validation", () => {
+  it("accepts loopback dev servers in unpackaged builds", () => {
+    expect(validateDevServerUrl("http://localhost:5173", false)).toBe(
+      "http://localhost:5173",
+    );
+    expect(validateDevServerUrl("http://127.0.0.1:5173", false)).toBe(
+      "http://127.0.0.1:5173",
+    );
+  });
+
+  it("rejects everything in packaged builds", () => {
+    expect(validateDevServerUrl("http://localhost:5173", true)).toBeNull();
+  });
+
+  it("rejects non-loopback and non-http origins in dev", () => {
+    expect(validateDevServerUrl("http://evil.example.com:5173", false)).toBeNull();
+    expect(validateDevServerUrl("file:///tmp/x", false)).toBeNull();
+    expect(validateDevServerUrl("not a url", false)).toBeNull();
+  });
+});
+
+describe("window.open policy", () => {
+  it("routes http and https targets through the external shell handler", () => {
+    expect(shouldOpenExternally("https://dohc.ai/docs")).toBe(true);
+    expect(shouldOpenExternally("http://dohc.ai/docs")).toBe(true);
+  });
+
+  it("never shells out non-http(s) schemes or junk", () => {
+    expect(shouldOpenExternally("file:///etc/passwd")).toBe(false);
+    expect(shouldOpenExternally("smb://share/x")).toBe(false);
+    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
+    expect(shouldOpenExternally("not a url")).toBe(false);
+  });
+});
+
+exec
+/bin/bash -lc "sed -n '1,200p' apps/desktop/src/performance/launchMarks.ts" in /home/ice/dev/dohc
+ succeeded in 0ms:
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
+
+exec
+/bin/bash -lc "git show --no-ext-diff --unified=60 529c0d4 -- pnpm-lock.yaml | sed -n '1,240p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
+Author: Ice de Vera <iestyndevera@gmail.com>
+Date:   Wed Jun 10 18:26:33 2026 +0800
+
+    phase3: Add native desktop workspace shell
+    
+    First-run creates real workspace folders (suggested ~/dohc, manifest
+    via workspace-core, no account); shell ships every plan-required
+    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
+    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
+    never overwrites), truthful cloud-sync offer, agent activity panel,
+    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
+    Design review loop: 2 iterations, all hard items pass, judges
+    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
+    E2E (real on-disk assertions, relaunch persistence).
+    
+    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
+index f071c69..7106877 100644
+--- a/pnpm-lock.yaml
++++ b/pnpm-lock.yaml
+@@ -153,142 +153,184 @@ importers:
+         specifier: ^4.2.4
+         version: 4.3.0
+       y-indexeddb:
+         specifier: ^9.0.12
+         version: 9.0.12(yjs@13.6.30)
+       y-prosemirror:
+         specifier: ^1.3.7
+         version: 1.3.7(prosemirror-model@1.25.7)(prosemirror-state@1.4.4)(prosemirror-view@1.41.8)(y-protocols@1.0.7(yjs@13.6.30))(yjs@13.6.30)
+       y-protocols:
+         specifier: ^1.0.7
+         version: 1.0.7(yjs@13.6.30)
+       yjs:
+         specifier: ^13.6.30
+         version: 13.6.30
+       zod:
+         specifier: ^3.23.8
+         version: 3.25.76
+     devDependencies:
+       '@edge-runtime/vm':
+         specifier: ^4.0.4
+         version: 4.0.4
+       '@types/js-yaml':
+         specifier: ^4.0.9
+         version: 4.0.9
+       '@types/jsdom':
+         specifier: 28.0.3
+         version: 28.0.3
+       '@types/node':
+         specifier: ^22.13.10
+         version: 22.19.19
+       '@types/prismjs':
+         specifier: ^1.26.6
+         version: 1.26.6
+       '@types/react':
+         specifier: ^19.2.14
+         version: 19.2.15
+       '@types/react-dom':
+         specifier: ^19.2.0
+         version: 19.2.3(@types/react@19.2.15)
+       '@vitejs/plugin-react':
+         specifier: ^6.0.1
+         version: 6.0.2(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+       concurrently:
+         specifier: ^9.1.0
+         version: 9.2.1
+       convex-test:
+         specifier: ^0.0.51
+         version: 0.0.51(convex@1.39.1(react@19.2.6))
+       typescript:
+         specifier: ^5.7.2
+         version: 5.9.3
+       vite:
+         specifier: ^8.0.10
+         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+       vitest:
+         specifier: ^2.1.9
+         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
+ 
+   apps/desktop:
+     dependencies:
++      '@dohc/brand':
++        specifier: workspace:*
++        version: link:../../packages/brand
++      '@dohc/workspace-core':
++        specifier: workspace:*
++        version: link:../../packages/workspace-core
+       electron-updater:
+         specifier: ^6.8.9
+         version: 6.8.9
++      lucide-react:
++        specifier: ^1.16.0
++        version: 1.16.0(react@19.2.6)
++      react:
++        specifier: ^19.2.6
++        version: 19.2.6
++      react-dom:
++        specifier: ^19.2.6
++        version: 19.2.6(react@19.2.6)
+       zod:
+         specifier: ^3.25.76
+         version: 3.25.76
+     devDependencies:
+       '@electron/fuses':
+         specifier: ^2.1.2
+         version: 2.1.2
++      '@tailwindcss/vite':
++        specifier: ^4.3.0
++        version: 4.3.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
++      '@testing-library/dom':
++        specifier: ^10.4.1
++        version: 10.4.1
++      '@testing-library/react':
++        specifier: ^16.3.2
++        version: 16.3.2(@testing-library/dom@10.4.1)(@types/react-dom@19.2.3(@types/react@19.2.15))(@types/react@19.2.15)(react-dom@19.2.6(react@19.2.6))(react@19.2.6)
++      '@testing-library/user-event':
++        specifier: ^14.6.1
++        version: 14.6.1(@testing-library/dom@10.4.1)
+       '@types/node':
+         specifier: ^22.19.19
+         version: 22.19.19
++      '@types/react':
++        specifier: ^19.2.15
++        version: 19.2.15
++      '@types/react-dom':
++        specifier: ^19.2.3
++        version: 19.2.3(@types/react@19.2.15)
++      '@vitejs/plugin-react':
++        specifier: ^6.0.2
++        version: 6.0.2(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+       electron:
+         specifier: ^42.4.0
+         version: 42.4.0
+       electron-builder:
+         specifier: ^26.15.2
+         version: 26.15.2(electron-builder-squirrel-windows@26.15.2)
+       electron-vite:
+         specifier: ^5.0.0
+         version: 5.0.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
++      jsdom:
++        specifier: ^29.1.1
++        version: 29.1.1(@noble/hashes@2.2.0)
++      tailwindcss:
++        specifier: ^4.3.0
++        version: 4.3.0
+       typescript:
+         specifier: ^5.9.3
+         version: 5.9.3
+       vite:
+         specifier: ^8.0.14
+         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+       vitest:
+         specifier: ^2.1.9
+         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
+ 
+   packages/brand:
+     devDependencies:
+       '@types/react':
+         specifier: ^19.2.14
+         version: 19.2.15
+       react:
+         specifier: ^19.2.5
+         version: 19.2.6
+ 
+   packages/config: {}
+ 
+   packages/workspace-contracts:
+     dependencies:
+       zod:
+         specifier: ^3.23.8
+         version: 3.25.76
+     devDependencies:
+       typescript:
+         specifier: ^5.7.2
+         version: 5.9.3
+       vitest:
+         specifier: ^2.1.9
+         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
+ 
+   packages/workspace-convex-compat:
+     dependencies:
+       '@dohc/workspace-contracts':
+         specifier: workspace:*
+         version: link:../workspace-contracts
+       convex:
+         specifier: ^1.37.0
+         version: 1.39.1(react@19.2.6)
+       convex-test:
+         specifier: ^0.0.51
+         version: 0.0.51(convex@1.39.1(react@19.2.6))
+     devDependencies:
+       typescript:
+         specifier: ^5.7.2
+         version: 5.9.3
+       vite:
+         specifier: ^8.0.10
+         version: 8.0.14(@types/node@25.9.2)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+       vitest:
+         specifier: ^2.1.9
+         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
+ 
+   packages/workspace-core:
+     devDependencies:
+       '@types/node':
+         specifier: ^22.19.19
+@@ -552,120 +594,124 @@ packages:
+     resolution: {integrity: sha512-+W6cISkXFa1jXsDEdYA8HeevQT/FULhxzR99pxphltZcVaugps53THCeiWA8SguxxpSp3gKPiuYfSWopkLQ4hw==}
+     engines: {node: '>=6.9.0'}
+ 
+   '@babel/helper-module-imports@7.28.6':
+     resolution: {integrity: sha512-l5XkZK7r7wa9LucGw9LwZyyCUscb4x37JWTPz7swwFE/0FMQAGpiWUZn8u9DzkSBWEcK25jmvubfpw2dnAMdbw==}
+     engines: {node: '>=6.9.0'}
+ 
+   '@babel/helper-module-transforms@7.28.6':
+     resolution: {integrity: sha512-67oXFAYr2cDLDVGLXTEABjdBJZ6drElUSI7WKp70NrpyISso3plG9SAGEF6y7zbha/wOzUByWWTJvEDVNIUGcA==}
+     engines: {node: '>=6.9.0'}
+     peerDependencies:
+       '@babel/core': ^7.0.0
+ 
+   '@babel/helper-plugin-utils@7.28.6':
+     resolution: {integrity: sha512-S9gzZ/bz83GRysI7gAD4wPT/AI3uCnY+9xn+Mx/KPs2JwHJIz1W8PZkg2cqyt3RNOBM8ejcXhV6y8Og7ly/Dug==}
+     engines: {node: '>=6.9.0'}
+ 
+   '@babel/helper-plugin-utils@7.29.7':
+     resolution: {integrity: sha512-G7sHYigPY17oO5SYWnfD/0MTBwVR781S/JI643e/JhUYgVgWE/61SoW3NH9KWUKyKq5LVh3npif99Wkt6j86Jw==}
+     engines: {node: '>=6.9.0'}
+ 
+   '@babel/helper-string-parser@7.27.1':
+     resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
+     engines: {node: '>=6.9.0'}
+ 
+   '@babel/helper-validator-identifier@7.28.5':
+     resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
+     engines: {node: '>=6.9.0'}
+ 
+   '@babel/helper-validator-option@7.27.1':
+     resolution: {integrity: sha512-YvjJow9FxbhFFKDSuFnVCe2WxXk1zWc22fFePVNEaWJEu8IrZVlda6N0uHwzZrUM1il7NC9Mlp4MaJYbYd9JSg==}
+     engines: {node: '>=6.9.0'}
+
+exec
+/bin/bash -lc 'git show --check --no-renames 529c0d4' in /home/ice/dev/dohc
+ succeeded in 0ms:
+commit 529c0d4a83d3dce10d83374cb54f4e15469df32b
+Author: Ice de Vera <iestyndevera@gmail.com>
+Date:   Wed Jun 10 18:26:33 2026 +0800
+
+    phase3: Add native desktop workspace shell
+    
+    First-run creates real workspace folders (suggested ~/dohc, manifest
+    via workspace-core, no account); shell ships every plan-required
+    surface: file tree, workspace switcher, quick-open (Ctrl+P), command
+    palette (Ctrl+K), new file (Ctrl+N), import files (validated copy,
+    never overwrites), truthful cloud-sync offer, agent activity panel,
+    sync status. React 19 + Tailwind 4 on shared @dohc/brand tokens.
+    Design review loop: 2 iterations, all hard items pass, judges
+    pixel-verified brand tokens. 27 unit tests + 3 Playwright Electron
+    E2E (real on-disk assertions, relaunch persistence).
+    
+    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+
+exec
+/bin/bash -lc "nl -ba apps/desktop/src/ipc/bridgeContract.ts | sed -n '20,45p'" in /home/ice/dev/dohc
+ succeeded in 0ms:
+    20	export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;
+    21	
+    22	export const WorkspaceRegistryResult = z.object({
+    23	  workspaces: z.array(WorkspaceSummary),
+    24	});
+    25	export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;
+    26	
+    27	export const DefaultWorkspaceRootResult = z.string().min(1);
+    28	
+    29	export const CreateLocalWorkspacePayload = z.object({
+    30	  rootPath: z.string().min(1),
+    31	  kind: z.enum(["personal", "shared"]),
+    32	});
+    33	export type CreateLocalWorkspacePayload = z.infer<
+    34	  typeof CreateLocalWorkspacePayload
+    35	>;
+    36	
+    37	export const ListWorkspaceFilesPayload = z.object({
+    38	  workspaceId: z.string().min(1),
+    39	});
+    40	
+    41	export const WorkspaceFileEntry = z.object({
+    42	  path: z.string().min(1),
+    43	  kind: z.enum(["file", "database", "app-source"]),
+    44	});
+    45	export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;
+
+codex
+The patch introduces a data-integrity issue around existing workspace manifests, under-validates workspace root IPC input, and can display stale workspace state after switching. These issues can break or misrepresent real local workspaces.
+
+Full review comments:
+
+- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
+  When first-run is pointed at a folder that already contains `.dohc/manifest.json` (for example after the Electron userData registry was deleted or the user chooses an existing dohc workspace), this unconditional write replaces the manifest with a fresh `workspaceId`. That severs the workspace identity used by registry/sync/history even though the user's files remain, so creation should attach/read the existing manifest or fail with an exclusive write instead of overwriting it.
+
+- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
+  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
+
+- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
+  When multiple workspaces are registered, switching only updates the parent workspace while this component keeps its current `files` and `selected` state from the previous workspace until the async refresh completes, and `selected` is never cleared. A user can switch to workspace B and still see or preview a path from workspace A, so clear/key workspace-local state when `workspaceId` changes.
+The patch introduces a data-integrity issue around existing workspace manifests, under-validates workspace root IPC input, and can display stale workspace state after switching. These issues can break or misrepresent real local workspaces.
+
+Full review comments:
+
+- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
+  When first-run is pointed at a folder that already contains `.dohc/manifest.json` (for example after the Electron userData registry was deleted or the user chooses an existing dohc workspace), this unconditional write replaces the manifest with a fresh `workspaceId`. That severs the workspace identity used by registry/sync/history even though the user's files remain, so creation should attach/read the existing manifest or fail with an exclusive write instead of overwriting it.
+
+- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
+  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
+
+- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
+  When multiple workspaces are registered, switching only updates the parent workspace while this component keeps its current `files` and `selected` state from the previous workspace until the async refresh completes, and `selected` is never cleared. A user can switch to workspace B and still see or preview a path from workspace A, so clear/key workspace-local state when `workspaceId` changes.
diff --git a/docs/superpowers/reviews/codex/ui-phase-03.md b/docs/superpowers/reviews/codex/ui-phase-03.md
new file mode 100644
index 0000000..74096dd
--- /dev/null
+++ b/docs/superpowers/reviews/codex/ui-phase-03.md
@@ -0,0 +1,77 @@
+Reading prompt from stdin...
+OpenAI Codex v0.130.0
+--------
+workdir: /home/ice/dev/dohc
+model: gpt-5.5
+provider: openai
+approval: never
+sandbox: read-only
+reasoning effort: high
+reasoning summaries: none
+session id: 019eb0c7-7480-7161-a300-fe23c3557fd0
+--------
+user
+Score each attached dohc Desktop screenshot against this rubric, per-file per-item pass/fail with failing region described: (1) looks like a native desktop app not a web page; (2) calm/professional next to Obsidian, Linear, Raycast; (3) warm paper + graphite, no palette drift; (4) deliberate spacing/alignment/type hierarchy; (5) no overflow/truncation/occlusion; (6) empty states offer the next real action; (7) no marketing chrome/gradients/cards. Files in order: first-run, workspace-shell 1280 light, workspace-shell 1536 light, workspace-shell 1536 dark, command-palette. Calibration: must sit comfortably next to Obsidian/Linear/Raycast. This is a v1 shell; the editor surface intentionally arrives in a later phase.
+
+warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
+codex
+Below is strict pass/fail against the calibration target: native, quiet, Obsidian/Linear/Raycast-adjacent.
+
+| File | 1 Native | 2 Calm/pro | 3 Warm paper + graphite | 4 Spacing/type | 5 No overflow | 6 Next action | 7 No marketing/cards |
+|---|---|---|---|---|---|---|---|
+| first-run | Pass | Pass | Pass | Pass | **Fail** | Pass | **Fail** |
+| workspace-shell 1280 light | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
+| workspace-shell 1536 light | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
+| workspace-shell 1536 dark | Pass | Pass | **Fail** | Pass | Pass | Pass | Pass |
+| command-palette | Pass | Pass | Pass | Pass | Pass | Pass | **Fail** |
+
+**Failures**
+
+`first-run`
+- Item 5: Workspace path is visibly truncated in the workspace location row. Region: center card, path text before “Choose a different folder”.
+- Item 7: The centered bordered card reads a bit web-onboarding/modal-card rather than native desktop setup. Region: first-run setup container.
+
+`workspace-shell 1280 light`
+- No failures. This is the strongest calibration hit: quiet, native, warm, inspectable, and not over-designed.
+
+`workspace-shell 1536 light`
+- No failures. The large empty center is acceptable for v1 shell given the editor surface is intentionally later.
+
+`workspace-shell 1536 dark`
+- Item 3: Dark mode loses the warm paper + graphite identity and becomes close to generic black/charcoal. Region: entire shell background and side panels. It is still calm, but the brand warmth disappears.
+
+`command-palette`
+- Item 7: The palette itself is fine, but the dimmed overlay plus floating rounded panel creates a slightly web-app modal feel. Region: command palette overlay and centered command box.
+
+Highest-priority fixes: make dark mode warmer and less pure-black, handle long paths more deliberately on first-run, and make first-run/palette containers feel more like native utility panels than web cards.
+tokens used
+24,497
+Below is strict pass/fail against the calibration target: native, quiet, Obsidian/Linear/Raycast-adjacent.
+
+| File | 1 Native | 2 Calm/pro | 3 Warm paper + graphite | 4 Spacing/type | 5 No overflow | 6 Next action | 7 No marketing/cards |
+|---|---|---|---|---|---|---|---|
+| first-run | Pass | Pass | Pass | Pass | **Fail** | Pass | **Fail** |
+| workspace-shell 1280 light | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
+| workspace-shell 1536 light | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
+| workspace-shell 1536 dark | Pass | Pass | **Fail** | Pass | Pass | Pass | Pass |
+| command-palette | Pass | Pass | Pass | Pass | Pass | Pass | **Fail** |
+
+**Failures**
+
+`first-run`
+- Item 5: Workspace path is visibly truncated in the workspace location row. Region: center card, path text before “Choose a different folder”.
+- Item 7: The centered bordered card reads a bit web-onboarding/modal-card rather than native desktop setup. Region: first-run setup container.
+
+`workspace-shell 1280 light`
+- No failures. This is the strongest calibration hit: quiet, native, warm, inspectable, and not over-designed.
+
+`workspace-shell 1536 light`
+- No failures. The large empty center is acceptable for v1 shell given the editor surface is intentionally later.
+
+`workspace-shell 1536 dark`
+- Item 3: Dark mode loses the warm paper + graphite identity and becomes close to generic black/charcoal. Region: entire shell background and side panels. It is still calm, but the brand warmth disappears.
+
+`command-palette`
+- Item 7: The palette itself is fine, but the dimmed overlay plus floating rounded panel creates a slightly web-app modal feel. Region: command palette overlay and centered command box.
+
+Highest-priority fixes: make dark mode warmer and less pure-black, handle long paths more deliberately on first-run, and make first-run/palette containers feel more like native utility panels than web cards.
diff --git a/package.json b/package.json
index b6999d9..4e99072 100644
--- a/package.json
+++ b/package.json
@@ -9,6 +9,11 @@
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
@@ -25,6 +30,7 @@
     "sync:local": "pnpm --filter @dohc/workspace-fs sync",
     "lint": "pnpm -r --if-present lint",
     "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
+    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
     "check:self-host": "node scripts/check-self-host.mjs",
     "check:debt": "node scripts/check-tech-debt.mjs"
   },
diff --git a/packages/workspace-core/package.json b/packages/workspace-core/package.json
new file mode 100644
index 0000000..dcb85c5
--- /dev/null
+++ b/packages/workspace-core/package.json
@@ -0,0 +1,17 @@
+{
+  "name": "@dohc/workspace-core",
+  "private": true,
+  "type": "module",
+  "exports": {
+    ".": "./src/index.ts"
+  },
+  "scripts": {
+    "test": "vitest run",
+    "typecheck": "tsc --noEmit"
+  },
+  "devDependencies": {
+    "@types/node": "^22.19.19",
+    "typescript": "^5.9.3",
+    "vitest": "^2.1.9"
+  }
+}
diff --git a/packages/workspace-core/src/changeSet.test.ts b/packages/workspace-core/src/changeSet.test.ts
new file mode 100644
index 0000000..6e6834d
--- /dev/null
+++ b/packages/workspace-core/src/changeSet.test.ts
@@ -0,0 +1,84 @@
+import { describe, expect, it } from "vitest";
+import {
+  addBoundaryCrossing,
+  addFileChanges,
+  createChangeSet,
+  requiresReview,
+  type BoundaryCrossing,
+} from "./changeSet";
+import { describeConflict } from "./conflicts";
+
+const agentAuthor = {
+  kind: "agent" as const,
+  agentId: "codex-local",
+  onBehalfOf: "user-1",
+};
+
+describe("change set grouping", () => {
+  it("groups one agent run editing many files into a single change set", () => {
+    const set = createChangeSet({
+      kind: "agent-run",
+      author: agentAuthor,
+      summary: "Imported transactions and built ledger app",
+    });
+    const files = Array.from({ length: 18 }, (_, i) => ({
+      path: `finance/.apps/ledger/src/file-${i}.tsx`,
+      operation: "write" as const,
+    }));
+    const grouped = addFileChanges(set, files);
+    expect(grouped.files).toHaveLength(18);
+    expect(grouped.kind).toBe("agent-run");
+    expect(grouped.author).toEqual(agentAuthor);
+  });
+});
+
+describe("review requirements", () => {
+  it("does not require approval for normal allowed edits", () => {
+    const set = addFileChanges(
+      createChangeSet({
+        kind: "user-edit",
+        author: { kind: "user", userId: "user-1" },
+        summary: "Edited notes",
+      }),
+      [{ path: "notes/today.md", operation: "write" }],
+    );
+    expect(requiresReview(set)).toBe(false);
+  });
+
+  const crossings: BoundaryCrossing[] = [
+    "public-share",
+    "permission-change",
+    "bulk-delete",
+    "app-trust",
+    "private-to-shared",
+  ];
+
+  for (const crossing of crossings) {
+    it(`requires review for boundary crossing: ${crossing}`, () => {
+      const set = addBoundaryCrossing(
+        createChangeSet({
+          kind: "agent-run",
+          author: agentAuthor,
+          summary: "Crossed a boundary",
+        }),
+        crossing,
+      );
+      expect(requiresReview(set)).toBe(true);
+      expect(set.boundaryCrossings).toContain(crossing);
+    });
+  }
+});
+
+describe("conflict summaries", () => {
+  it("produces a human-readable summary without Git conflict markers", () => {
+    const summary = describeConflict({
+      path: "notes/plan.md",
+      localDescription: "you reworded the intro",
+      remoteDescription: "Maya added a budget section",
+    });
+    expect(summary).toContain("notes/plan.md");
+    expect(summary).toContain("you reworded the intro");
+    expect(summary).toContain("Maya added a budget section");
+    expect(summary).not.toMatch(/<{7}|>{7}|={7}/);
+  });
+});
diff --git a/packages/workspace-core/src/changeSet.ts b/packages/workspace-core/src/changeSet.ts
new file mode 100644
index 0000000..5773eaf
--- /dev/null
+++ b/packages/workspace-core/src/changeSet.ts
@@ -0,0 +1,57 @@
+export type ChangeSetKind =
+  | "user-edit"
+  | "agent-run"
+  | "import"
+  | "sync"
+  | "app-build";
+
+export type BoundaryCrossing =
+  | "public-share"
+  | "external-export"
+  | "permission-change"
+  | "bulk-delete"
+  | "app-trust"
+  | "private-to-shared"
+  | "unmergeable-overwrite";
+
+export type ChangeAuthor =
+  | { kind: "user"; userId: string }
+  | { kind: "agent"; agentId: string; onBehalfOf: string };
+
+export interface FileChange {
+  path: string;
+  operation: "write" | "delete" | "rename";
+}
+
+export interface ChangeSet {
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+  files: FileChange[];
+  boundaryCrossings: BoundaryCrossing[];
+}
+
+export function createChangeSet(input: {
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+}): ChangeSet {
+  return { ...input, files: [], boundaryCrossings: [] };
+}
+
+export function addFileChanges(set: ChangeSet, files: FileChange[]): ChangeSet {
+  return { ...set, files: [...set.files, ...files] };
+}
+
+export function addBoundaryCrossing(
+  set: ChangeSet,
+  crossing: BoundaryCrossing,
+): ChangeSet {
+  return { ...set, boundaryCrossings: [...set.boundaryCrossings, crossing] };
+}
+
+// Liberal by default: ordinary edits sync freely; only genuine boundary
+// crossings need a human to look.
+export function requiresReview(set: ChangeSet): boolean {
+  return set.boundaryCrossings.length > 0;
+}
diff --git a/packages/workspace-core/src/conflicts.ts b/packages/workspace-core/src/conflicts.ts
new file mode 100644
index 0000000..7c24e46
--- /dev/null
+++ b/packages/workspace-core/src/conflicts.ts
@@ -0,0 +1,13 @@
+export interface ConflictInput {
+  path: string;
+  localDescription: string;
+  remoteDescription: string;
+}
+
+// Conflicts read like a sentence, never like Git markers.
+export function describeConflict(input: ConflictInput): string {
+  return (
+    `Both sides changed ${input.path}: ${input.localDescription}, ` +
+    `while ${input.remoteDescription}. Both versions are kept until you choose.`
+  );
+}
diff --git a/packages/workspace-core/src/index.ts b/packages/workspace-core/src/index.ts
new file mode 100644
index 0000000..7d6db61
--- /dev/null
+++ b/packages/workspace-core/src/index.ts
@@ -0,0 +1,5 @@
+export * from "./workspaceMode";
+export * from "./metadata";
+export * from "./paths";
+export * from "./changeSet";
+export * from "./conflicts";
diff --git a/packages/workspace-core/src/metadata.ts b/packages/workspace-core/src/metadata.ts
new file mode 100644
index 0000000..daf60cd
--- /dev/null
+++ b/packages/workspace-core/src/metadata.ts
@@ -0,0 +1,36 @@
+import {
+  defaultWorkspaceMode,
+  type WorkspaceKind,
+  type WorkspaceMode,
+} from "./workspaceMode";
+
+// Mode lives on the workspace manifest and nowhere else: a workspace is
+// local-first, cloud-first, or cloud-only as a whole, never per file.
+export interface WorkspaceManifest {
+  version: 1;
+  workspaceId: string;
+  mode: WorkspaceMode;
+  kind: WorkspaceKind;
+}
+
+export function createWorkspaceManifest(input: {
+  workspaceId: string;
+  kind: WorkspaceKind;
+  mode?: WorkspaceMode;
+}): WorkspaceManifest {
+  return {
+    version: 1,
+    workspaceId: input.workspaceId,
+    kind: input.kind,
+    mode: input.mode ?? defaultWorkspaceMode(input.kind),
+  };
+}
+
+export interface FileRecord {
+  path: string;
+  contentHash: string;
+}
+
+export function createFileRecord(input: FileRecord): FileRecord {
+  return { path: input.path, contentHash: input.contentHash };
+}
diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
new file mode 100644
index 0000000..41c0ffa
--- /dev/null
+++ b/packages/workspace-core/src/paths.test.ts
@@ -0,0 +1,178 @@
+import { describe, expect, it } from "vitest";
+import {
+  classifyPath,
+  defaultWorkspaceRoot,
+  isReservedPath,
+  validateAttachedFolder,
+  validateUserWritePath,
+} from "./paths";
+
+describe("workspace roots", () => {
+  it("suggests ~/dohc as the default root", () => {
+    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
+  });
+
+  it("allows attaching arbitrary absolute folders", () => {
+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
+    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
+  });
+
+  it("allows Windows absolute folders (drive and UNC)", () => {
+    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
+    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
+    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
+  });
+
+  it("rejects relative paths as attached folders", () => {
+    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
+  });
+});
+
+describe("reserved paths", () => {
+  it("reserves .dohc/manifest.json and the .dohc subtree", () => {
+    expect(isReservedPath(".dohc/manifest.json")).toBe(true);
+    expect(isReservedPath(".dohc/history/0001.json")).toBe(true);
+    expect(isReservedPath("notes/today.md")).toBe(false);
+  });
+
+  it("reserves case-insensitive .dohc variants (case-insensitive filesystems)", () => {
+    expect(isReservedPath(".DOHC/manifest.json")).toBe(true);
+    const result = validateUserWritePath(".DoHc/manifest.json");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("reserved");
+  });
+
+  it("rejects user writes into reserved space", () => {
+    const result = validateUserWritePath(".dohc/manifest.json");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("reserved");
+  });
+});
+
+describe("path traversal", () => {
+  const traversals = [
+    "../escape.md",
+    "notes/../../etc/passwd",
+    "%2e%2e/sneak.md",
+    "..\\windows\\system32",
+    "a/%2E%2E/b",
+    "%252e%252e/double-encoded.md",
+    "..%2fescape.md",
+    "..%5cwindows",
+  ];
+
+  for (const candidate of traversals) {
+    it(`rejects traversal: ${JSON.stringify(candidate)}`, () => {
+      const result = validateUserWritePath(candidate);
+      expect(result.ok).toBe(false);
+      if (!result.ok) expect(result.reason).toBe("traversal");
+    });
+  }
+
+  it("rejects absolute paths inside a workspace", () => {
+    const result = validateUserWritePath("/etc/passwd");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("absolute");
+  });
+
+  it("rejects Windows drive-qualified and UNC write paths", () => {
+    for (const candidate of [
+      "C:\\Users\\ice\\secret.md",
+      "C:/Users/ice/secret.md",
+      "\\\\server\\share\\secret.md",
+    ]) {
+      const result = validateUserWritePath(candidate);
+      expect(result.ok).toBe(false);
+      if (!result.ok) expect(result.reason).toBe("absolute");
+    }
+  });
+
+  it("rejects encoded-slash absolute paths", () => {
+    const result = validateUserWritePath("%2fetc/passwd");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("absolute");
+  });
+
+  it("rejects null bytes", () => {
+    const result = validateUserWritePath("notes/a\0b.md");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("invalid");
+  });
+
+  it("accepts and normalizes ordinary nested paths", () => {
+    const result = validateUserWritePath("finance/./reports/q1.md");
+    expect(result.ok).toBe(true);
+    if (result.ok) expect(result.normalized).toBe("finance/reports/q1.md");
+  });
+});
+
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
+describe("path classification", () => {
+  it("treats .apps/<name>/app.json as visible app source", () => {
+    expect(classifyPath("finance/.apps/ledger/app.json")).toEqual({
+      kind: "app-source",
+      appName: "ledger",
+    });
+    expect(classifyPath(".apps/tracker/src/App.tsx")).toEqual({
+      kind: "app-source",
+      appName: "tracker",
+    });
+  });
+
+  it("treats .sqlite, .sqlite3, and .db files as visible databases", () => {
+    expect(classifyPath("finance/wallet.sqlite")).toEqual({ kind: "database" });
+    expect(classifyPath("data/cache.sqlite3")).toEqual({ kind: "database" });
+    expect(classifyPath("archive/old.db")).toEqual({ kind: "database" });
+  });
+
+  it("classifies everything else as a plain file", () => {
+    expect(classifyPath("notes/today.md")).toEqual({ kind: "file" });
+  });
+});
diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
new file mode 100644
index 0000000..d9b976f
--- /dev/null
+++ b/packages/workspace-core/src/paths.ts
@@ -0,0 +1,127 @@
+export function defaultWorkspaceRoot(homeDir: string): string {
+  return `${homeDir.replace(/\/+$/, "")}/dohc`;
+}
+
+export type FolderValidation = { ok: true } | { ok: false; reason: string };
+
+// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
+function isAbsolutePathLike(path: string): boolean {
+  return (
+    path.startsWith("/") ||
+    /^[A-Za-z]:[\\/]/.test(path) ||
+    path.startsWith("\\\\")
+  );
+}
+
+export function validateAttachedFolder(path: string): FolderValidation {
+  if (!isAbsolutePathLike(path)) {
+    return { ok: false, reason: "attached folders must be absolute paths" };
+  }
+  return { ok: true };
+}
+
+// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
+// so a case-sensitive guard would let writes overwrite dohc metadata.
+export function isReservedPath(relativePath: string): boolean {
+  const lower = relativePath.toLowerCase();
+  return lower === ".dohc" || lower.startsWith(".dohc/");
+}
+
+export type WritePathValidation =
+  | { ok: true; normalized: string }
+  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };
+
+export function validateUserWritePath(relativePath: string): WritePathValidation {
+  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
+  if (isAbsolutePathLike(relativePath)) return { ok: false, reason: "absolute" };
+  // Percent-encoded dots/separators are traversal in disguise; decode until
+  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
+  let decoded = relativePath;
+  for (;;) {
+    const next = decoded
+      .replace(/%25/gi, "%")
+      .replace(/%2e/gi, ".")
+      .replace(/%2f/gi, "/")
+      .replace(/%5c/gi, "\\");
+    if (next === decoded) break;
+    decoded = next;
+  }
+  // Decoding may reveal an absolute path (%2fetc, C%3A is out of scope but
+  // drive letters survive decoding as-is).
+  if (isAbsolutePathLike(decoded)) return { ok: false, reason: "absolute" };
+  const segments = decoded.replaceAll("\\", "/").split("/");
+  if (segments.includes("..")) return { ok: false, reason: "traversal" };
+  const normalized = segments
+    .filter((segment) => segment !== "" && segment !== ".")
+    .join("/");
+  if (normalized.length === 0) return { ok: false, reason: "invalid" };
+  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
+  return { ok: true, normalized };
+}
+
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
+export type PathClassification =
+  | { kind: "app-source"; appName: string }
+  | { kind: "database" }
+  | { kind: "file" };
+
+const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
+
+export function classifyPath(relativePath: string): PathClassification {
+  const segments = relativePath.split("/");
+  const appsIndex = segments.indexOf(".apps");
+  const appName = appsIndex === -1 ? undefined : segments[appsIndex + 1];
+  if (appName) return { kind: "app-source", appName };
+  const lower = relativePath.toLowerCase();
+  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
+    return { kind: "database" };
+  }
+  return { kind: "file" };
+}
diff --git a/packages/workspace-core/src/workspaceMode.test.ts b/packages/workspace-core/src/workspaceMode.test.ts
new file mode 100644
index 0000000..a55e893
--- /dev/null
+++ b/packages/workspace-core/src/workspaceMode.test.ts
@@ -0,0 +1,32 @@
+import { describe, expect, it } from "vitest";
+import { createFileRecord, createWorkspaceManifest } from "./metadata";
+import { defaultWorkspaceMode } from "./workspaceMode";
+
+describe("workspace modes", () => {
+  it("defaults personal workspaces to local-first", () => {
+    expect(defaultWorkspaceMode("personal")).toBe("local-first");
+  });
+
+  it("defaults shared workspaces to cloud-first with a local copy", () => {
+    expect(defaultWorkspaceMode("shared")).toBe("cloud-first-local-copy");
+  });
+
+  it("defaults cloud-only workspaces to cloud-only", () => {
+    expect(defaultWorkspaceMode("cloud-only")).toBe("cloud-only");
+  });
+
+  it("stores mode on the workspace manifest, never on file records", () => {
+    const manifest = createWorkspaceManifest({
+      workspaceId: "ws-1",
+      kind: "shared",
+    });
+    expect(manifest.mode).toBe("cloud-first-local-copy");
+    expect(manifest.version).toBe(1);
+
+    const record = createFileRecord({
+      path: "notes/today.md",
+      contentHash: "abc123",
+    });
+    expect("mode" in record).toBe(false);
+  });
+});
diff --git a/packages/workspace-core/src/workspaceMode.ts b/packages/workspace-core/src/workspaceMode.ts
new file mode 100644
index 0000000..c686bc7
--- /dev/null
+++ b/packages/workspace-core/src/workspaceMode.ts
@@ -0,0 +1,16 @@
+export type WorkspaceMode =
+  | "local-first"
+  | "cloud-first-local-copy"
+  | "cloud-only";
+
+export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+
+const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
+  personal: "local-first",
+  shared: "cloud-first-local-copy",
+  "cloud-only": "cloud-only",
+};
+
+export function defaultWorkspaceMode(kind: WorkspaceKind): WorkspaceMode {
+  return DEFAULT_MODE_BY_KIND[kind];
+}
diff --git a/packages/workspace-core/tsconfig.json b/packages/workspace-core/tsconfig.json
new file mode 100644
index 0000000..9e25e6e
--- /dev/null
+++ b/packages/workspace-core/tsconfig.json
@@ -0,0 +1,4 @@
+{
+  "extends": "../../tsconfig.base.json",
+  "include": ["src/**/*.ts"]
+}
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 1c414a8..7106877 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -28,7 +28,7 @@ importers:
         version: 0.6.1(@ai-sdk/provider-utils@4.0.27(zod@3.25.76))(ai@6.0.180(zod@3.25.76))(convex-helpers@0.1.118(@standard-schema/spec@1.1.0)(convex@1.39.1(react@19.2.6))(react@19.2.6)(typescript@5.9.3)(zod@3.25.76))(convex@1.39.1(react@19.2.6))(react@19.2.6)
       '@convex-dev/workos-authkit':
         specifier: ^0.2.2
-        version: 0.2.5(@edge-runtime/vm@4.0.4)(@standard-schema/spec@1.1.0)(@types/debug@4.1.13)(@types/node@22.19.19)(@workos-inc/authkit-react@0.11.0(react@19.2.6))(@workos-inc/node@8.13.0)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1)(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)(zod@3.25.76)
+        version: 0.2.5(@edge-runtime/vm@4.0.4)(@standard-schema/spec@1.1.0)(@types/debug@4.1.13)(@types/node@22.19.19)(@workos-inc/authkit-react@0.11.0(react@19.2.6))(@workos-inc/node@8.13.0)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)(zod@3.25.76)
       '@dohc/brand':
         specifier: workspace:*
         version: link:../../packages/brand
@@ -109,7 +109,7 @@ importers:
         version: 0.28.0
       isomorphic-dompurify:
         specifier: 3.14.0
-        version: 3.14.0
+        version: 3.14.0(@noble/hashes@2.2.0)
       jose:
         specifier: ^6.2.3
         version: 6.2.3
@@ -127,7 +127,7 @@ importers:
         version: 2.0.3
       nitro:
         specifier: 3.0.260429-beta
-        version: 3.0.260429-beta(chokidar@5.0.0)(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0))(jiti@2.7.0)(lru-cache@11.5.0)(rollup@4.60.4)(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+        version: 3.0.260429-beta(chokidar@5.0.0)(dotenv@16.6.1)(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0))(jiti@2.7.0)(lru-cache@11.5.0)(rollup@4.60.4)(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
       prismjs:
         specifier: ^1.30.0
         version: 1.30.0
@@ -206,7 +206,83 @@ importers:
         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
+
+  apps/desktop:
+    dependencies:
+      '@dohc/brand':
+        specifier: workspace:*
+        version: link:../../packages/brand
+      '@dohc/workspace-core':
+        specifier: workspace:*
+        version: link:../../packages/workspace-core
+      electron-updater:
+        specifier: ^6.8.9
+        version: 6.8.9
+      lucide-react:
+        specifier: ^1.16.0
+        version: 1.16.0(react@19.2.6)
+      react:
+        specifier: ^19.2.6
+        version: 19.2.6
+      react-dom:
+        specifier: ^19.2.6
+        version: 19.2.6(react@19.2.6)
+      zod:
+        specifier: ^3.25.76
+        version: 3.25.76
+    devDependencies:
+      '@electron/fuses':
+        specifier: ^2.1.2
+        version: 2.1.2
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
+      '@types/node':
+        specifier: ^22.19.19
+        version: 22.19.19
+      '@types/react':
+        specifier: ^19.2.15
+        version: 19.2.15
+      '@types/react-dom':
+        specifier: ^19.2.3
+        version: 19.2.3(@types/react@19.2.15)
+      '@vitejs/plugin-react':
+        specifier: ^6.0.2
+        version: 6.0.2(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+      electron:
+        specifier: ^42.4.0
+        version: 42.4.0
+      electron-builder:
+        specifier: ^26.15.2
+        version: 26.15.2(electron-builder-squirrel-windows@26.15.2)
+      electron-vite:
+        specifier: ^5.0.0
+        version: 5.0.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
+      jsdom:
+        specifier: ^29.1.1
+        version: 29.1.1(@noble/hashes@2.2.0)
+      tailwindcss:
+        specifier: ^4.3.0
+        version: 4.3.0
+      typescript:
+        specifier: ^5.9.3
+        version: 5.9.3
+      vite:
+        specifier: ^8.0.14
+        version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+      vitest:
+        specifier: ^2.1.9
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/brand:
     devDependencies:
@@ -230,7 +306,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/workspace-convex-compat:
     dependencies:
@@ -249,10 +325,22 @@ importers:
         version: 5.9.3
       vite:
         specifier: ^8.0.10
-        version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+        version: 8.0.14(@types/node@25.9.2)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+      vitest:
+        specifier: ^2.1.9
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
+
+  packages/workspace-core:
+    devDependencies:
+      '@types/node':
+        specifier: ^22.19.19
+        version: 22.19.19
+      typescript:
+        specifier: ^5.9.3
+        version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/workspace-fs:
     dependencies:
@@ -274,7 +362,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   packages/workspace-postgres:
     dependencies:
@@ -299,7 +387,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   services/agent-sandbox:
     dependencies:
@@ -318,7 +406,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   services/app-tester:
     devDependencies:
@@ -336,7 +424,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   services/hocuspocus:
     dependencies:
@@ -397,7 +485,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   services/sqlite-worker:
     devDependencies:
@@ -412,7 +500,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
   services/workspace-api:
     dependencies:
@@ -431,7 +519,7 @@ importers:
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
-        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)
 
 packages:
 
@@ -520,6 +608,10 @@ packages:
     resolution: {integrity: sha512-S9gzZ/bz83GRysI7gAD4wPT/AI3uCnY+9xn+Mx/KPs2JwHJIz1W8PZkg2cqyt3RNOBM8ejcXhV6y8Og7ly/Dug==}
     engines: {node: '>=6.9.0'}
 
+  '@babel/helper-plugin-utils@7.29.7':
+    resolution: {integrity: sha512-G7sHYigPY17oO5SYWnfD/0MTBwVR781S/JI643e/JhUYgVgWE/61SoW3NH9KWUKyKq5LVh3npif99Wkt6j86Jw==}
+    engines: {node: '>=6.9.0'}
+
   '@babel/helper-string-parser@7.27.1':
     resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
     engines: {node: '>=6.9.0'}
@@ -553,6 +645,16 @@ packages:
     peerDependencies:
       '@babel/core': ^7.0.0-0
 
+  '@babel/plugin-transform-arrow-functions@7.29.7':
+    resolution: {integrity: sha512-N7zArUXWzAMzm+/N0uPBeVB3Fam5lMxtUwMmDK5f/IBBS7a7p1qeUoxd/6CckXoxUdgsntq1Dh8xNW06maZbDQ==}
+    engines: {node: '>=6.9.0'}
+    peerDependencies:
+      '@babel/core': ^7.0.0-0
+
+  '@babel/runtime@7.29.7':
+    resolution: {integrity: sha512-Nq8OhGWiZIZGV6hLHoyAKLLcJihP/xFeBMGJoUrxTX2psI8dCifzLhZISFb+VWS3wFMRDmCGw5R+dOySCqPLhw==}
+    engines: {node: '>=6.9.0'}
+
   '@babel/template@7.28.6':
     resolution: {integrity: sha512-YA6Ma2KsCdGb+WC6UpBVFJGXL58MDA6oyONbjyF/+5sBgxY/dwkhLogbMT2GXXyU84/IhRw/2D1Os1B/giz+BQ==}
     engines: {node: '>=6.9.0'}
@@ -652,6 +754,55 @@ packages:
     resolution: {integrity: sha512-LqPw+yaSPpCNnVZl5XoHQAySEzlnZiC9gReUuQHMh9GI03KKqwpVqWkIK1UfK116Yww7f2WZuAgnY/nhHwTsJA==}
     engines: {node: '>=16'}
 
+  '@electron-internal/extract-zip@1.0.2':
+    resolution: {integrity: sha512-VJuNETNPEhrmQEZezeTZO5TZMV+dobBRyJ7zHjGJWIhMS7m7W1UeClt69u4hkUxv9ZZVxuli/E9Yvc4gDNHGsg==}
+    engines: {node: '>=22.12.0'}
+
+  '@electron/asar@3.4.1':
+    resolution: {integrity: sha512-i4/rNPRS84t0vSRa2HorerGRXWyF4vThfHesw0dmcWHp+cspK743UanA0suA5Q5y8kzY2y6YKrvbIUn69BCAiA==}
+    engines: {node: '>=10.12.0'}
+    hasBin: true
+
+  '@electron/fuses@1.8.0':
+    resolution: {integrity: sha512-zx0EIq78WlY/lBb1uXlziZmDZI4ubcCXIMJ4uGjXzZW0nS19TjSPeXPAjzzTmKQlJUZm0SbmZhPKP7tuQ1SsEw==}
+    hasBin: true
+
+  '@electron/fuses@2.1.2':
+    resolution: {integrity: sha512-x083OSf4xO9CKUKmJFYW+Egua9y/v2XOCcCIuWnM4RlpMj8xHwKICezlVN6vZyI2cZTr/ysZXRU5AKtYPJivBQ==}
+    engines: {node: '>=22.12.0'}
+    hasBin: true
+
+  '@electron/get@3.1.0':
+    resolution: {integrity: sha512-F+nKc0xW+kVbBRhFzaMgPy3KwmuNTYX1fx6+FxxoSnNgwYX6LD7AKBTWkU0MQ6IBoe7dz069CNkR673sPAgkCQ==}
+    engines: {node: '>=14'}
+
+  '@electron/get@5.0.0':
+    resolution: {integrity: sha512-pjoBpru1KdEtcExBnuHAP1cAc/5faoedw0hzJkL3o4/IJp7HNF1+fbrdxT3gMYRX2oJfvnA/WXeCTVQpYYxyJA==}
+    engines: {node: '>=22.12.0'}
+
+  '@electron/notarize@2.5.0':
+    resolution: {integrity: sha512-jNT8nwH1f9X5GEITXaQ8IF/KdskvIkOFfB2CvwumsveVidzpSc+mvhhTMdAGSYF3O+Nq49lJ7y+ssODRXu06+A==}
+    engines: {node: '>= 10.0.0'}
+
+  '@electron/osx-sign@1.3.3':
+    resolution: {integrity: sha512-KZ8mhXvWv2rIEgMbWZ4y33bDHyUKMXnx4M0sTyPNK/vcB81ImdeY9Ggdqy0SWbMDgmbqyQ+phgejh6V3R2QuSg==}
+    engines: {node: '>=12.0.0'}
+    hasBin: true
+
+  '@electron/rebuild@4.0.4':
+    resolution: {integrity: sha512-Rzc39XPdk/+/wBG8MfwAHohXflep0ITUfulb6Rgz3R0NeSB1noE+E9/M/cb8ftCAiyDD9PPhLuuWgE1GaInbKg==}
+    engines: {node: '>=22.12.0'}
+    hasBin: true
+
+  '@electron/universal@2.0.3':
+    resolution: {integrity: sha512-Wn9sPYIVFRFl5HmwMJkARCCf7rqK/EurkfQ/rJZ14mHP3iYTjZSIOSVonEAnhWeAXwtw7zOekGRlc6yTtZ0t+g==}
+    engines: {node: '>=16.4'}
+
+  '@electron/windows-sign@1.2.2':
+    resolution: {integrity: sha512-dfZeox66AvdPtb2lD8OsIIQh12Tp0GNCRUDfBHIKGpbmopZto2/A8nSpYYLoedPIHpqkeblZ/k8OV0Gy7PYuyQ==}
+    engines: {node: '>=14.14'}
+    hasBin: true
+
   '@emnapi/core@1.10.0':
     resolution: {integrity: sha512-yq6OkJ4p82CAfPl0u9mQebQHKPJkY7WrIuk205cTYnYe+k2Z8YBh11FrbRG/H6ihirqcacOgl2BIO8oyMQLeXw==}
 
@@ -676,6 +827,12 @@ packages:
     cpu: [ppc64]
     os: [aix]
 
+  '@esbuild/aix-ppc64@0.25.12':
+    resolution: {integrity: sha512-Hhmwd6CInZ3dwpuGTF8fJG6yoWmsToE+vYgD4nytZVxcu1ulHpUQRAB1UJ8+N1Am3Mz4+xOByoQoSZf4D+CpkA==}
+    engines: {node: '>=18'}
+    cpu: [ppc64]
+    os: [aix]
+
   '@esbuild/aix-ppc64@0.27.0':
     resolution: {integrity: sha512-KuZrd2hRjz01y5JK9mEBSD3Vj3mbCvemhT466rSuJYeE/hjuBrHfjjcjMdTm/sz7au+++sdbJZJmuBwQLuw68A==}
     engines: {node: '>=18'}
@@ -700,6 +857,12 @@ packages:
     cpu: [arm64]
     os: [android]
 
+  '@esbuild/android-arm64@0.25.12':
+    resolution: {integrity: sha512-6AAmLG7zwD1Z159jCKPvAxZd4y/VTO0VkprYy+3N2FtJ8+BQWFXU+OxARIwA46c5tdD9SsKGZ/1ocqBS/gAKHg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [android]
+
   '@esbuild/android-arm64@0.27.0':
     resolution: {integrity: sha512-CC3vt4+1xZrs97/PKDkl0yN7w8edvU2vZvAFGD16n9F0Cvniy5qvzRXjfO1l94efczkkQE6g1x0i73Qf5uthOQ==}
     engines: {node: '>=18'}
@@ -724,6 +887,12 @@ packages:
     cpu: [arm]
     os: [android]
 
+  '@esbuild/android-arm@0.25.12':
+    resolution: {integrity: sha512-VJ+sKvNA/GE7Ccacc9Cha7bpS8nyzVv0jdVgwNDaR4gDMC/2TTRc33Ip8qrNYUcpkOHUT5OZ0bUcNNVZQ9RLlg==}
+    engines: {node: '>=18'}
+    cpu: [arm]
+    os: [android]
+
   '@esbuild/android-arm@0.27.0':
     resolution: {integrity: sha512-j67aezrPNYWJEOHUNLPj9maeJte7uSMM6gMoxfPC9hOg8N02JuQi/T7ewumf4tNvJadFkvLZMlAq73b9uwdMyQ==}
     engines: {node: '>=18'}
@@ -748,6 +917,12 @@ packages:
     cpu: [x64]
     os: [android]
 
+  '@esbuild/android-x64@0.25.12':
+    resolution: {integrity: sha512-5jbb+2hhDHx5phYR2By8GTWEzn6I9UqR11Kwf22iKbNpYrsmRB18aX/9ivc5cabcUiAT/wM+YIZ6SG9QO6a8kg==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [android]
+
   '@esbuild/android-x64@0.27.0':
     resolution: {integrity: sha512-wurMkF1nmQajBO1+0CJmcN17U4BP6GqNSROP8t0X/Jiw2ltYGLHpEksp9MpoBqkrFR3kv2/te6Sha26k3+yZ9Q==}
     engines: {node: '>=18'}
@@ -772,6 +947,12 @@ packages:
     cpu: [arm64]
     os: [darwin]
 
+  '@esbuild/darwin-arm64@0.25.12':
+    resolution: {integrity: sha512-N3zl+lxHCifgIlcMUP5016ESkeQjLj/959RxxNYIthIg+CQHInujFuXeWbWMgnTo4cp5XVHqFPmpyu9J65C1Yg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [darwin]
+
   '@esbuild/darwin-arm64@0.27.0':
     resolution: {integrity: sha512-uJOQKYCcHhg07DL7i8MzjvS2LaP7W7Pn/7uA0B5S1EnqAirJtbyw4yC5jQ5qcFjHK9l6o/MX9QisBg12kNkdHg==}
     engines: {node: '>=18'}
@@ -796,6 +977,12 @@ packages:
     cpu: [x64]
     os: [darwin]
 
+  '@esbuild/darwin-x64@0.25.12':
+    resolution: {integrity: sha512-HQ9ka4Kx21qHXwtlTUVbKJOAnmG1ipXhdWTmNXiPzPfWKpXqASVcWdnf2bnL73wgjNrFXAa3yYvBSd9pzfEIpA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [darwin]
+
   '@esbuild/darwin-x64@0.27.0':
     resolution: {integrity: sha512-8mG6arH3yB/4ZXiEnXof5MK72dE6zM9cDvUcPtxhUZsDjESl9JipZYW60C3JGreKCEP+p8P/72r69m4AZGJd5g==}
     engines: {node: '>=18'}
@@ -820,6 +1007,12 @@ packages:
     cpu: [arm64]
     os: [freebsd]
 
+  '@esbuild/freebsd-arm64@0.25.12':
+    resolution: {integrity: sha512-gA0Bx759+7Jve03K1S0vkOu5Lg/85dou3EseOGUes8flVOGxbhDDh/iZaoek11Y8mtyKPGF3vP8XhnkDEAmzeg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [freebsd]
+
   '@esbuild/freebsd-arm64@0.27.0':
     resolution: {integrity: sha512-9FHtyO988CwNMMOE3YIeci+UV+x5Zy8fI2qHNpsEtSF83YPBmE8UWmfYAQg6Ux7Gsmd4FejZqnEUZCMGaNQHQw==}
     engines: {node: '>=18'}
@@ -844,6 +1037,12 @@ packages:
     cpu: [x64]
     os: [freebsd]
 
+  '@esbuild/freebsd-x64@0.25.12':
+    resolution: {integrity: sha512-TGbO26Yw2xsHzxtbVFGEXBFH0FRAP7gtcPE7P5yP7wGy7cXK2oO7RyOhL5NLiqTlBh47XhmIUXuGciXEqYFfBQ==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [freebsd]
+
   '@esbuild/freebsd-x64@0.27.0':
     resolution: {integrity: sha512-zCMeMXI4HS/tXvJz8vWGexpZj2YVtRAihHLk1imZj4efx1BQzN76YFeKqlDr3bUWI26wHwLWPd3rwh6pe4EV7g==}
     engines: {node: '>=18'}
@@ -868,6 +1067,12 @@ packages:
     cpu: [arm64]
     os: [linux]
 
+  '@esbuild/linux-arm64@0.25.12':
+    resolution: {integrity: sha512-8bwX7a8FghIgrupcxb4aUmYDLp8pX06rGh5HqDT7bB+8Rdells6mHvrFHHW2JAOPZUbnjUpKTLg6ECyzvas2AQ==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [linux]
+
   '@esbuild/linux-arm64@0.27.0':
     resolution: {integrity: sha512-AS18v0V+vZiLJyi/4LphvBE+OIX682Pu7ZYNsdUHyUKSoRwdnOsMf6FDekwoAFKej14WAkOef3zAORJgAtXnlQ==}
     engines: {node: '>=18'}
@@ -892,6 +1097,12 @@ packages:
     cpu: [arm]
     os: [linux]
 
+  '@esbuild/linux-arm@0.25.12':
+    resolution: {integrity: sha512-lPDGyC1JPDou8kGcywY0YILzWlhhnRjdof3UlcoqYmS9El818LLfJJc3PXXgZHrHCAKs/Z2SeZtDJr5MrkxtOw==}
+    engines: {node: '>=18'}
+    cpu: [arm]
+    os: [linux]
+
   '@esbuild/linux-arm@0.27.0':
     resolution: {integrity: sha512-t76XLQDpxgmq2cNXKTVEB7O7YMb42atj2Re2Haf45HkaUpjM2J0UuJZDuaGbPbamzZ7bawyGFUkodL+zcE+jvQ==}
     engines: {node: '>=18'}
@@ -916,6 +1127,12 @@ packages:
     cpu: [ia32]
     os: [linux]
 
+  '@esbuild/linux-ia32@0.25.12':
+    resolution: {integrity: sha512-0y9KrdVnbMM2/vG8KfU0byhUN+EFCny9+8g202gYqSSVMonbsCfLjUO+rCci7pM0WBEtz+oK/PIwHkzxkyharA==}
+    engines: {node: '>=18'}
+    cpu: [ia32]
+    os: [linux]
+
   '@esbuild/linux-ia32@0.27.0':
     resolution: {integrity: sha512-Mz1jxqm/kfgKkc/KLHC5qIujMvnnarD9ra1cEcrs7qshTUSksPihGrWHVG5+osAIQ68577Zpww7SGapmzSt4Nw==}
     engines: {node: '>=18'}
@@ -940,6 +1157,12 @@ packages:
     cpu: [loong64]
     os: [linux]
 
+  '@esbuild/linux-loong64@0.25.12':
+    resolution: {integrity: sha512-h///Lr5a9rib/v1GGqXVGzjL4TMvVTv+s1DPoxQdz7l/AYv6LDSxdIwzxkrPW438oUXiDtwM10o9PmwS/6Z0Ng==}
+    engines: {node: '>=18'}
+    cpu: [loong64]
+    os: [linux]
+
   '@esbuild/linux-loong64@0.27.0':
     resolution: {integrity: sha512-QbEREjdJeIreIAbdG2hLU1yXm1uu+LTdzoq1KCo4G4pFOLlvIspBm36QrQOar9LFduavoWX2msNFAAAY9j4BDg==}
     engines: {node: '>=18'}
@@ -964,6 +1187,12 @@ packages:
     cpu: [mips64el]
     os: [linux]
 
+  '@esbuild/linux-mips64el@0.25.12':
+    resolution: {integrity: sha512-iyRrM1Pzy9GFMDLsXn1iHUm18nhKnNMWscjmp4+hpafcZjrr2WbT//d20xaGljXDBYHqRcl8HnxbX6uaA/eGVw==}
+    engines: {node: '>=18'}
+    cpu: [mips64el]
+    os: [linux]
+
   '@esbuild/linux-mips64el@0.27.0':
     resolution: {integrity: sha512-sJz3zRNe4tO2wxvDpH/HYJilb6+2YJxo/ZNbVdtFiKDufzWq4JmKAiHy9iGoLjAV7r/W32VgaHGkk35cUXlNOg==}
     engines: {node: '>=18'}
@@ -988,6 +1217,12 @@ packages:
     cpu: [ppc64]
     os: [linux]
 
+  '@esbuild/linux-ppc64@0.25.12':
+    resolution: {integrity: sha512-9meM/lRXxMi5PSUqEXRCtVjEZBGwB7P/D4yT8UG/mwIdze2aV4Vo6U5gD3+RsoHXKkHCfSxZKzmDssVlRj1QQA==}
+    engines: {node: '>=18'}
+    cpu: [ppc64]
+    os: [linux]
+
   '@esbuild/linux-ppc64@0.27.0':
     resolution: {integrity: sha512-z9N10FBD0DCS2dmSABDBb5TLAyF1/ydVb+N4pi88T45efQ/w4ohr/F/QYCkxDPnkhkp6AIpIcQKQ8F0ANoA2JA==}
     engines: {node: '>=18'}
@@ -1012,6 +1247,12 @@ packages:
     cpu: [riscv64]
     os: [linux]
 
+  '@esbuild/linux-riscv64@0.25.12':
+    resolution: {integrity: sha512-Zr7KR4hgKUpWAwb1f3o5ygT04MzqVrGEGXGLnj15YQDJErYu/BGg+wmFlIDOdJp0PmB0lLvxFIOXZgFRrdjR0w==}
+    engines: {node: '>=18'}
+    cpu: [riscv64]
+    os: [linux]
+
   '@esbuild/linux-riscv64@0.27.0':
     resolution: {integrity: sha512-pQdyAIZ0BWIC5GyvVFn5awDiO14TkT/19FTmFcPdDec94KJ1uZcmFs21Fo8auMXzD4Tt+diXu1LW1gHus9fhFQ==}
     engines: {node: '>=18'}
@@ -1036,6 +1277,12 @@ packages:
     cpu: [s390x]
     os: [linux]
 
+  '@esbuild/linux-s390x@0.25.12':
+    resolution: {integrity: sha512-MsKncOcgTNvdtiISc/jZs/Zf8d0cl/t3gYWX8J9ubBnVOwlk65UIEEvgBORTiljloIWnBzLs4qhzPkJcitIzIg==}
+    engines: {node: '>=18'}
+    cpu: [s390x]
+    os: [linux]
+
   '@esbuild/linux-s390x@0.27.0':
     resolution: {integrity: sha512-hPlRWR4eIDDEci953RI1BLZitgi5uqcsjKMxwYfmi4LcwyWo2IcRP+lThVnKjNtk90pLS8nKdroXYOqW+QQH+w==}
     engines: {node: '>=18'}
@@ -1060,6 +1307,12 @@ packages:
     cpu: [x64]
     os: [linux]
 
+  '@esbuild/linux-x64@0.25.12':
+    resolution: {integrity: sha512-uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [linux]
+
   '@esbuild/linux-x64@0.27.0':
     resolution: {integrity: sha512-1hBWx4OUJE2cab++aVZ7pObD6s+DK4mPGpemtnAORBvb5l/g5xFGk0vc0PjSkrDs0XaXj9yyob3d14XqvnQ4gw==}
     engines: {node: '>=18'}
@@ -1078,6 +1331,12 @@ packages:
     cpu: [x64]
     os: [linux]
 
+  '@esbuild/netbsd-arm64@0.25.12':
+    resolution: {integrity: sha512-xXwcTq4GhRM7J9A8Gv5boanHhRa/Q9KLVmcyXHCTaM4wKfIpWkdXiMog/KsnxzJ0A1+nD+zoecuzqPmCRyBGjg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [netbsd]
+
   '@esbuild/netbsd-arm64@0.27.0':
     resolution: {integrity: sha512-6m0sfQfxfQfy1qRuecMkJlf1cIzTOgyaeXaiVaaki8/v+WB+U4hc6ik15ZW6TAllRlg/WuQXxWj1jx6C+dfy3w==}
     engines: {node: '>=18'}
@@ -1102,6 +1361,12 @@ packages:
     cpu: [x64]
     os: [netbsd]
 
+  '@esbuild/netbsd-x64@0.25.12':
+    resolution: {integrity: sha512-Ld5pTlzPy3YwGec4OuHh1aCVCRvOXdH8DgRjfDy/oumVovmuSzWfnSJg+VtakB9Cm0gxNO9BzWkj6mtO1FMXkQ==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [netbsd]
+
   '@esbuild/netbsd-x64@0.27.0':
     resolution: {integrity: sha512-xbbOdfn06FtcJ9d0ShxxvSn2iUsGd/lgPIO2V3VZIPDbEaIj1/3nBBe1AwuEZKXVXkMmpr6LUAgMkLD/4D2PPA==}
     engines: {node: '>=18'}
@@ -1120,6 +1385,12 @@ packages:
     cpu: [x64]
     os: [netbsd]
 
+  '@esbuild/openbsd-arm64@0.25.12':
+    resolution: {integrity: sha512-fF96T6KsBo/pkQI950FARU9apGNTSlZGsv1jZBAlcLL1MLjLNIWPBkj5NlSz8aAzYKg+eNqknrUJ24QBybeR5A==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [openbsd]
+
   '@esbuild/openbsd-arm64@0.27.0':
     resolution: {integrity: sha512-fWgqR8uNbCQ/GGv0yhzttj6sU/9Z5/Sv/VGU3F5OuXK6J6SlriONKrQ7tNlwBrJZXRYk5jUhuWvF7GYzGguBZQ==}
     engines: {node: '>=18'}
@@ -1144,6 +1415,12 @@ packages:
     cpu: [x64]
     os: [openbsd]
 
+  '@esbuild/openbsd-x64@0.25.12':
+    resolution: {integrity: sha512-MZyXUkZHjQxUvzK7rN8DJ3SRmrVrke8ZyRusHlP+kuwqTcfWLyqMOE3sScPPyeIXN/mDJIfGXvcMqCgYKekoQw==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [openbsd]
+
   '@esbuild/openbsd-x64@0.27.0':
     resolution: {integrity: sha512-aCwlRdSNMNxkGGqQajMUza6uXzR/U0dIl1QmLjPtRbLOx3Gy3otfFu/VjATy4yQzo9yFDGTxYDo1FfAD9oRD2A==}
     engines: {node: '>=18'}
@@ -1162,6 +1439,12 @@ packages:
     cpu: [x64]
     os: [openbsd]
 
+  '@esbuild/openharmony-arm64@0.25.12':
+    resolution: {integrity: sha512-rm0YWsqUSRrjncSXGA7Zv78Nbnw4XL6/dzr20cyrQf7ZmRcsovpcRBdhD43Nuk3y7XIoW2OxMVvwuRvk9XdASg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [openharmony]
+
   '@esbuild/openharmony-arm64@0.27.0':
     resolution: {integrity: sha512-nyvsBccxNAsNYz2jVFYwEGuRRomqZ149A39SHWk4hV0jWxKM0hjBPm3AmdxcbHiFLbBSwG6SbpIcUbXjgyECfA==}
     engines: {node: '>=18'}
@@ -1186,6 +1469,12 @@ packages:
     cpu: [x64]
     os: [sunos]
 
+  '@esbuild/sunos-x64@0.25.12':
+    resolution: {integrity: sha512-3wGSCDyuTHQUzt0nV7bocDy72r2lI33QL3gkDNGkod22EsYl04sMf0qLb8luNKTOmgF/eDEDP5BFNwoBKH441w==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [sunos]
+
   '@esbuild/sunos-x64@0.27.0':
     resolution: {integrity: sha512-Q1KY1iJafM+UX6CFEL+F4HRTgygmEW568YMqDA5UV97AuZSm21b7SXIrRJDwXWPzr8MGr75fUZPV67FdtMHlHA==}
     engines: {node: '>=18'}
@@ -1210,6 +1499,12 @@ packages:
     cpu: [arm64]
     os: [win32]
 
+  '@esbuild/win32-arm64@0.25.12':
+    resolution: {integrity: sha512-rMmLrur64A7+DKlnSuwqUdRKyd3UE7oPJZmnljqEptesKM8wx9J8gx5u0+9Pq0fQQW8vqeKebwNXdfOyP+8Bsg==}
+    engines: {node: '>=18'}
+    cpu: [arm64]
+    os: [win32]
+
   '@esbuild/win32-arm64@0.27.0':
     resolution: {integrity: sha512-W1eyGNi6d+8kOmZIwi/EDjrL9nxQIQ0MiGqe/AWc6+IaHloxHSGoeRgDRKHFISThLmsewZ5nHFvGFWdBYlgKPg==}
     engines: {node: '>=18'}
@@ -1234,6 +1529,12 @@ packages:
     cpu: [ia32]
     os: [win32]
 
+  '@esbuild/win32-ia32@0.25.12':
+    resolution: {integrity: sha512-HkqnmmBoCbCwxUKKNPBixiWDGCpQGVsrQfJoVGYLPT41XWF8lHuE5N6WhVia2n4o5QK5M4tYr21827fNhi4byQ==}
+    engines: {node: '>=18'}
+    cpu: [ia32]
+    os: [win32]
+
   '@esbuild/win32-ia32@0.27.0':
     resolution: {integrity: sha512-30z1aKL9h22kQhilnYkORFYt+3wp7yZsHWus+wSKAJR8JtdfI76LJ4SBdMsCopTR3z/ORqVu5L1vtnHZWVj4cQ==}
     engines: {node: '>=18'}
@@ -1258,6 +1559,12 @@ packages:
     cpu: [x64]
     os: [win32]
 
+  '@esbuild/win32-x64@0.25.12':
+    resolution: {integrity: sha512-alJC0uCZpTFrSL0CCDjcgleBXPnCrEAhTBILpeAp7M/OFgoqtAetfBzX0xM00MUsVVPpVjlPuMbREqnZCXaTnA==}
+    engines: {node: '>=18'}
+    cpu: [x64]
+    os: [win32]
+
   '@esbuild/win32-x64@0.27.0':
     resolution: {integrity: sha512-aIitBcjQeyOhMTImhLZmtxfdOcuNRpwlPNmlFKPcHQYPhEssw75Cl1TSXJXpMkzaua9FUetx/4OQKq7eJul5Cg==}
     engines: {node: '>=18'}
@@ -1313,6 +1620,10 @@ packages:
       y-protocols: ^1.0.6
       yjs: ^13.6.8
 
+  '@isaacs/fs-minipass@4.0.1':
+    resolution: {integrity: sha512-wgm9Ehl2jpeqP3zw/7mo3kRHFp5MEDhqAdwy1fTGkHAwnkGOVsgpvQhL8B5n1qlb01jV3n/bI0ZfZp5lWA1k4w==}
+    engines: {node: '>=18.0.0'}
+
   '@jridgewell/gen-mapping@0.3.13':
     resolution: {integrity: sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==}
 
@@ -1332,12 +1643,28 @@ packages:
   '@lifeomic/attempt@3.1.0':
     resolution: {integrity: sha512-QZqem4QuAnAyzfz+Gj5/+SLxqwCAw2qmt7732ZXodr6VDWGeYLG6w1i/vYLa55JQM9wRuBKLmXmiZ2P0LtE5rw==}
 
+  '@malept/cross-spawn-promise@2.0.0':
+    resolution: {integrity: sha512-1DpKU0Z5ThltBwjNySMC14g0CkbyhCaz9FkhxqNsZI6uAPJXFS8cMXlBKo26FJ8ZuW6S9GCMcR9IO5k2X5/9Fg==}
+    engines: {node: '>= 12.13.0'}
+
+  '@malept/flatpak-bundler@0.4.0':
+    resolution: {integrity: sha512-9QOtNffcOF/c1seMCDnjckb3R9WHcG34tky+FHpNKKCW0wc/scYLwMtO+ptyGUfMW0/b/n4qRiALlaFHc9Oj7Q==}
+    engines: {node: '>= 10.0.0'}
+
   '@napi-rs/wasm-runtime@1.1.4':
     resolution: {integrity: sha512-3NQNNgA1YSlJb/kMH1ildASP9HW7/7kYnRI2szWJaofaS1hWmbGI4H+d3+22aGzXXN9IJ+n+GiFVcGipJP18ow==}
     peerDependencies:
       '@emnapi/core': ^1.7.1
       '@emnapi/runtime': ^1.7.1
 
+  '@noble/hashes@1.4.0':
+    resolution: {integrity: sha512-V1JJ1WTRUqHHrOSh597hURcMqVKVGL/ea3kv0gSnEdsEZ0/+VyPghM1lMNGc00z7CIQorSvbKpuJkxvuHbvdbg==}
+    engines: {node: '>= 16'}
+
+  '@noble/hashes@2.2.0':
+    resolution: {integrity: sha512-IYqDGiTXab6FniAgnSdZwgWbomxpy9FtYvLKs7wCUs2a8RkITG+DFGO1DM9cr+E3/RgADRpFjrKVaJ1z6sjtEg==}
+    engines: {node: '>= 20.19.0'}
+
   '@oozcitak/dom@2.0.2':
     resolution: {integrity: sha512-GjpKhkSYC3Mj4+lfwEyI1dqnsKTgwGy48ytZEhm4A/xnH/8z9M3ZVXKr/YGQi3uCLs1AEBS+x5T2JPiueEDW8w==}
     engines: {node: '>=20.0'}
@@ -1361,6 +1688,20 @@ packages:
   '@oxc-project/types@0.132.0':
     resolution: {integrity: sha512-FESMOxil5Se014ui/Eq8fT5uHJo6nIRwH0PfJrZJXs6Gek3ZVFOrpUv3YIZT20m+extU98Hg1Ym72U58rlsxUQ==}
 
+  '@peculiar/asn1-schema@2.7.0':
+    resolution: {integrity: sha512-W8ZfWzLmQnrcky+eh3tni4IozMdqBDiHWU0N+vve/UGjMaUs8c0L7A2oEdkBXS8rTpWDpK/aoI3DG/L/hxmxPg==}
+
+  '@peculiar/json-schema@1.1.12':
+    resolution: {integrity: sha512-coUfuoMeIB7B8/NMekxaDzLhaYmp0HZNPEjYRm9goRou8UZIC3z21s0sL9AWoCw4EG876QyO3kYrc61WNF9B/w==}
+    engines: {node: '>=8.0.0'}
+
+  '@peculiar/utils@2.0.3':
+    resolution: {integrity: sha512-+oL3HPFRIZ1St2K50lWCXiioIgSoxzz7R1J3uF6neO2yl1sgmpgY6XXJH4BdpoDkMWznQTeYF6oWNDZLCdQ4eQ==}
+
+  '@peculiar/webcrypto@1.7.1':
+    resolution: {integrity: sha512-ODOov0sGMJMf3jPonOkgGqPknTsu+DdQ7kD++gz8aI+aFMOMHFbWAA2taqXXVTdP+OTOQR/znGvSpmkeI0WTYQ==}
+    engines: {node: '>=14.18.0'}
+
   '@playwright/test@1.60.0':
     resolution: {integrity: sha512-O71yZIbAh/PxDMNGns37GHBIfrVkEVyn+AXyIa5dOTfb4/xNvRWV+Vv/NMbNCtODB/pO7vLlF2OTmMVLhmr7Ag==}
     engines: {node: '>=18'}
@@ -1586,9 +1927,17 @@ packages:
     cpu: [x64]
     os: [win32]
 
+  '@sindresorhus/is@4.6.0':
+    resolution: {integrity: sha512-t09vSN3MdfsyCHoFcTRCH/iUtG7OJ0CsjzB8cjAmKc/va/kIgeDI/TxsigdncE/4be734m0cvIYwNaV4i2XqAw==}
+    engines: {node: '>=10'}
+
   '@standard-schema/spec@1.1.0':
     resolution: {integrity: sha512-l2aFy5jALhniG5HgqrD6jXLi/rUWrKvqN/qJx6yoJsgKhblVd+iqqU4RCXavm/jPityDo5TCvKMnpjKnOriy0w==}
 
+  '@szmarczak/http-timer@4.0.6':
+    resolution: {integrity: sha512-4BAffykYOgO+5nzBWYwE3W90sBgLJoUPRWWcL8wlyiM8IB8ipJz3UMJ9KXQd1RKQXpKp8Tutn80HZtWsu2u76w==}
+    engines: {node: '>=10'}
+
   '@tailwindcss/node@4.3.0':
     resolution: {integrity: sha512-aFb4gUhFOgdh9AXo4IzBEOzBkkAxm9VigwDJnMIYv3lcfXCJVesNfbEaBl4BNgVRyid92AmdviqwBUBRKSeY3g==}
 
@@ -1812,6 +2161,31 @@ packages:
     resolution: {integrity: sha512-uhOeFyxLcU41HzvrxsGpiWdcMbScY1EDgbZ5K7DVRMYInbLYWAC0EA/kx9wXAoSM8q82bUG2hRl8+EAjE6XAbA==}
     engines: {node: '>=20.19'}
 
+  '@testing-library/dom@10.4.1':
+    resolution: {integrity: sha512-o4PXJQidqJl82ckFaXUeoAW+XysPLauYI43Abki5hABd853iMhitooc6znOnczgbTYmEP6U6/y1ZyKAIsvMKGg==}
+    engines: {node: '>=18'}
+
+  '@testing-library/react@16.3.2':
+    resolution: {integrity: sha512-XU5/SytQM+ykqMnAnvB2umaJNIOsLF3PVv//1Ew4CTcpz0/BRyy/af40qqrt7SjKpDdT1saBMc42CUok5gaw+g==}
+    engines: {node: '>=18'}
+    peerDependencies:
+      '@testing-library/dom': ^10.0.0
+      '@types/react': ^18.0.0 || ^19.0.0
+      '@types/react-dom': ^18.0.0 || ^19.0.0
+      react: ^18.0.0 || ^19.0.0
+      react-dom: ^18.0.0 || ^19.0.0
+    peerDependenciesMeta:
+      '@types/react':
+        optional: true
+      '@types/react-dom':
+        optional: true
+
+  '@testing-library/user-event@14.6.1':
+    resolution: {integrity: sha512-vq7fv0rnt+QTXgPxr5Hjc210p6YKq2kmdziLgnsZGgLJ9e6VAShx1pACLuRjd/AS/sr7phAR58OIIpf0LlmQNw==}
+    engines: {node: '>=12', npm: '>=6'}
+    peerDependencies:
+      '@testing-library/dom': '>=7.21.4'
+
   '@tiptap/core@3.23.6':
     resolution: {integrity: sha512-MRB3pHz4Oxqmcawh0cQ5iOGdY5xtNYp/1CoK7hdTLzw5K0C6/gTC2VvanB1R4INaB6EpBkxG/GiWkVirDRnuXw==}
     peerDependencies:
@@ -2013,6 +2387,12 @@ packages:
   '@tybys/wasm-util@0.10.2':
     resolution: {integrity: sha512-RoBvJ2X0wuKlWFIjrwffGw1IqZHKQqzIchKaadZZfnNpsAYp2mM0h36JtPCjNDAHGgYez/15uMBpfGwchhiMgg==}
 
+  '@types/aria-query@5.0.4':
+    resolution: {integrity: sha512-rfT93uj5s0PRL7EzccGMs3brplhcrghnDoV26NqKhCAS1hVo+WdNsPvE/yb6ilfr5hi2MEk6d5EWJTKdxg8jVw==}
+
+  '@types/cacheable-request@6.0.3':
+    resolution: {integrity: sha512-IQ3EbTzGxIigb1I3qPZc1rWJnH0BmSKv5QYTalEwweFvyBDLSAe24zP0le/hyi7ecGfZVlIVAg4BZqb8WBwKqw==}
+
   '@types/chai@5.2.3':
     resolution: {integrity: sha512-Mw558oeA9fFbv65/y4mHtXDs9bPnFMZAL/jxdPFUpOHHIXX91mcgEHbS5Lahr+pwZFR8A7GQleRWeI6cGFC2UA==}
 
@@ -2031,15 +2411,24 @@ packages:
   '@types/estree@1.0.9':
     resolution: {integrity: sha512-GhdPgy1el4/ImP05X05Uw4cw2/M93BCUmnEvWZNStlCzEKME4Fkk+YpoA5OiHNQmoS7Cafb8Xa3Pya8m1Qrzeg==}
 
+  '@types/fs-extra@9.0.13':
+    resolution: {integrity: sha512-nEnwB++1u5lVDM2UI4c1+5R+FYaKfaAzS4OococimjVm3nQw3TuzH5UNsocrcTBbhnerblyHj4A49qXbIiZdpA==}
+
   '@types/hast@3.0.4':
     resolution: {integrity: sha512-WPs+bbQw5aCj+x6laNGWLH3wviHtoCv/P3+otBhbOhJgG8qtpdAMlTCxLtsTWA7LH1Oh/bFCHsBn0TPS5m30EQ==}
 
+  '@types/http-cache-semantics@4.2.0':
+    resolution: {integrity: sha512-L3LgimLHXtGkWikKnsPg0/VFx9OGZaC+eN1u4r+OB1XRqH3meBIAVC2zr1WdMH+RHmnRkqliQAOHNJ/E0j/e0Q==}
+
   '@types/js-yaml@4.0.9':
     resolution: {integrity: sha512-k4MGaQl5TGo/iipqb2UDG2UwjXziSWkh0uysQelTlJpX1qGlpUZYm8PnO4DxG1qBomtJUdYJ6qR6xdIah10JLg==}
 
   '@types/jsdom@28.0.3':
     resolution: {integrity: sha512-/HQ2uFoetFTXuye8vzIcHw2z6Fwi7Hi/qcgC+RoS9NCyewiqxhVGqlG+ViGB6lkax481R6dmhf1I7lIGlzJStQ==}
 
+  '@types/keyv@3.1.4':
+    resolution: {integrity: sha512-BQ5aZNSCpj7D6K2ksrRCTmKRLEpnPvWDiLPfoGyhZ++8YtiK9d/3DBKPJgry359X/P1PfruyYwvnvwFjuEiEIg==}
+
   '@types/mdast@4.0.4':
     resolution: {integrity: sha512-kGaNbPh1k7AFzgpud/gMdvIm5xuECykRR+JnWKQno9TAXVa6WIVCGTPvYGekIDL4uwCZQSYbUxNBSb1aUo79oA==}
 
@@ -2049,6 +2438,12 @@ packages:
   '@types/node@22.19.19':
     resolution: {integrity: sha512-dyh/xO2Fh5bYrfWaaqGrRQQGkNdmYw6AmaAUvYeUMNTWQtvb796ikLdmTchRmOlOiIJ1TDXfWgVx1QkUlQ6Hew==}
 
+  '@types/node@24.13.1':
+    resolution: {integrity: sha512-RSpUJGmvsJ1ZeBehQZFhIdpsz+bIpES0nIQXko4Ybq+N+kX6XvOq3Jo+iJ82FWLdblFq85AsMikd3m35jgezYg==}
+
+  '@types/node@25.9.2':
+    resolution: {integrity: sha512-G05zqtJhcDLb8uslf5EjCxXg9G1KQxiV8OS0R26IC//Eoyitzqe8z37I7cqvnZlrlSfgocQRfSn/AHBZJJFyGw==}
+
   '@types/pg@8.20.0':
     resolution: {integrity: sha512-bEPFOaMAHTEP1EzpvHTbmwR8UsFyHSKsRisLIHVMXnpNefSbGA1bD6CVy+qKjGSqmZqNqBDV2azOBo8TgkcVow==}
 
@@ -2063,6 +2458,9 @@ packages:
   '@types/react@19.2.15':
     resolution: {integrity: sha512-eRwcGNHve+E8qtEQSSRl6urh+rFop4v8gm6O8rGv25CodbvFdLjA1vVQ1KkiFE0w0UPOnb8tDiFKL5lp0rtY5Q==}
 
+  '@types/responselike@1.0.3':
+    resolution: {integrity: sha512-H/+L+UkTV33uf49PH5pCAUBVPNj2nDBXTN+qS1dOwyyg24l3CcicicCA7ca+HMvJBZcFgl5r8e+RR6elsb4Lyw==}
+
   '@types/tough-cookie@4.0.5':
     resolution: {integrity: sha512-/Ad8+nIOV7Rl++6f1BdKxFSMgmoqEoYbHRpPcx3JEfv8VRsQe9Z4mCXeJBzxs7mbHY/XOZZuXlRNfhpVPbs6ZA==}
 
@@ -2183,16 +2581,31 @@ packages:
       react: ^18.0 || ^19.0
       react-dom: ^18.0 || ^19.0
 
+  '@xmldom/xmldom@0.8.13':
+    resolution: {integrity: sha512-KRYzxepc14G/CEpEGc3Yn+JKaAeT63smlDr+vjB8jRfgTBBI9wRj/nkQEO+ucV8p8I9bfKLWp37uHgFrbntPvw==}
+    engines: {node: '>=10.0.0'}
+
+  abbrev@4.0.0:
+    resolution: {integrity: sha512-a1wflyaL0tHtJSmLSOVybYhy22vRih4eduhhrkcjgrWGnRfrZtovJ2FRjxuTtkkj47O/baf0R86QU5OuYpz8fA==}
+    engines: {node: ^20.17.0 || >=22.9.0}
+
   accessor-fn@1.5.3:
     resolution: {integrity: sha512-rkAofCwe/FvYFUlMB0v0gWmhqtfAtV1IUkdPbfhTUyYniu5LrC0A0UJkTH0Jv3S8SvwkmfuAlY+mQIJATdocMA==}
     engines: {node: '>=12'}
 
+  agent-base@7.1.4:
+    resolution: {integrity: sha512-MnA+YT8fwfJPgBx3m60MNqakm30XOkyIoH1y6huTQvC0PwZG7ki8NacLBcrPbNoo8vEZy7Jpuk7+jMO+CUovTQ==}
+    engines: {node: '>= 14'}
+
   ai@6.0.180:
     resolution: {integrity: sha512-tOyRbwD0PEjMZKGvYQcTsv95K2zktwwNhQ49QOUAh0g8MNprO7ELIO1SgANMuPc0BFtkP6Ny6OAdjq3TtxLCbQ==}
     engines: {node: '>=18'}
     peerDependencies:
       zod: ^3.25.76 || ^4.1.8
 
+  ajv@8.20.0:
+    resolution: {integrity: sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==}
+
   ansi-regex@5.0.1:
     resolution: {integrity: sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==}
     engines: {node: '>=8'}
@@ -2201,13 +2614,31 @@ packages:
     resolution: {integrity: sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==}
     engines: {node: '>=8'}
 
+  ansi-styles@5.2.0:
+    resolution: {integrity: sha512-Cxwpt2SfTzTtXcfOlzGEee8O+c+MmUgGrNiBcXnuWxuFJHe6a5Hz7qwhwe5OgaSYI0IJvkLqWX1ASG+cJOkEiA==}
+    engines: {node: '>=10'}
+
   ansis@4.3.0:
     resolution: {integrity: sha512-44mvgtPvohuU/70DdY5Oz2AIrLJ9k6/5x4KmoSvPwO+5Moijo0+N9D0fKbbYZQWP1hNm5CpOf+E01jhxG/r8xg==}
     engines: {node: '>=14'}
 
+  app-builder-lib@26.15.2:
+    resolution: {integrity: sha512-3mYfKOjr/ZY7gFESOcq8kylBMgGPpmlQYnpBVit4p6zIg0t/8bkWBILdMMtnjFyN2jllyBf225T8dLlz3D6oBQ==}
+    engines: {node: '>=14.0.0'}
+    peerDependencies:
+      dmg-builder: 26.15.2
+      electron-builder-squirrel-windows: 26.15.2
+
   argparse@2.0.1:
     resolution: {integrity: sha512-8+9WqebbFzpX9OR+Wa6O29asIogeRMzcGtAINdpMHHyAg10f05aSFVBbcEqGf/PXw1EjAZ+q2/bEBg3DvurK3Q==}
 
+  aria-query@5.3.0:
+    resolution: {integrity: sha512-b0P0sZPKtyu8HkeRAfCq0IfURZK+SuwMjY1UXGBU27wpAiTwQAIlq56IbIO+ytk/JjS1fMR14ee5WBBfKi5J6A==}
+
+  asn1js@3.0.10:
+    resolution: {integrity: sha512-S2s3aOytiKdFRdulw2qPE51MzjzVOisppcVv7jVFR+Kw0kxwvFrDcYA0h7Ndqbmj0HkMIXYWaoj7fli8kgx1eg==}
+    engines: {node: '>=12.0.0'}
+
   assertion-error@2.0.1:
     resolution: {integrity: sha512-Izi8RQcffqCeNVgFigKli1ssklIbpHnCYc6AknXGYoB6grJqyeby7jv12JUQgmTAnIDnbck1uxksT4dzN3PWBA==}
     engines: {node: '>=12'}
@@ -2219,15 +2650,42 @@ packages:
   async-channel@0.2.0:
     resolution: {integrity: sha512-BJyjI/sfKlyijaBt2hbOSxT28xGNtLR0QLzAKO1Hlnv5BULY7sAoYoTPW3lfr1ZIC7y+FxabxO9T8GXpyoofGg==}
 
+  async-exit-hook@2.0.1:
+    resolution: {integrity: sha512-NW2cX8m1Q7KPA7a5M2ULQeZ2wR5qI5PAbw5L0UOMxdioVk9PMZ0h1TmyZEkPYrCvYjDlFICusOu1dlEKAAeXBw==}
+    engines: {node: '>=0.12.0'}
+
   async-mutex@0.5.0:
     resolution: {integrity: sha512-1A94B18jkJ3DYq284ohPxoXbfTA5HsQ7/Mf4DEhcyLx3Bz27Rh59iScbB6EPiP+B+joue6YCxcMXSbFC1tZKwA==}
 
+  async@3.2.6:
+    resolution: {integrity: sha512-htCUDlxyyCLMgaM3xXg0C0LW2xqfuQ6p05pCEIsXuyQ+a1koYKTuBMzRNwmybfLgvJDMd0r1LTn4+E0Ti6C2AA==}
+
+  asynckit@0.4.0:
+    resolution: {integrity: sha512-Oei9OH4tRh0YqU3GxhX79dM/mwVgvbZJaSNaRk+bshkj0S5cfHcgYakreBjrHwatXKbz+IoIdYLxrKim2MjW0Q==}
+
+  at-least-node@1.0.0:
+    resolution: {integrity: sha512-+q/t7Ekv1EDY2l6Gda6LLiX14rU9TV20Wa3ofeQmwPFZbOMo9DXrLbOjFaaclkXKWidIaopwAObQDqwWtGUjqg==}
+    engines: {node: '>= 4.0.0'}
+
+  aws4@1.13.2:
+    resolution: {integrity: sha512-lHe62zvbTB5eEABUVi/AwVh0ZKY9rMMDhmm+eeyuuUQbQ3+J+fONVQOZyj+DdrvD4BY33uYniyRJ4UJIaSKAfw==}
+
   babel-dead-code-elimination@1.0.12:
     resolution: {integrity: sha512-GERT7L2TiYcYDtYk1IpD+ASAYXjKbLTDPhBtYj7X1NuRMDTMtAx9kyBenub1Ev41lo91OHCKdmP+egTDmfQ7Ig==}
 
   bail@2.0.2:
     resolution: {integrity: sha512-0xO6mYd7JB2YesxDKplafRpsiOzPt9V02ddPCLbY1xYGPOX24NTyN50qnUxgCPcSoYMhKpAuBTjQoRZCAkUDRw==}
 
+  balanced-match@1.0.2:
+    resolution: {integrity: sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==}
+
+  balanced-match@4.0.4:
+    resolution: {integrity: sha512-BLrgEcRTwX2o6gGxGOCNyMvGSp35YofuYzw9h1IMTRmKqttAZZVU67bdb9Pr2vUHA8+j3i2tJfjO6C6+4myGTA==}
+    engines: {node: 18 || 20 || >=22}
+
+  base64-js@1.5.1:
+    resolution: {integrity: sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA==}
+
   baseline-browser-mapping@2.10.31:
     resolution: {integrity: sha512-MujYO3eP72uvmSE0i4wltsodRfIpZATP3jvzRNRGGxgzId7aVocVJJV3nf01qnzzKFGxQVC9bpWxl5cjxTr/7Q==}
     engines: {node: '>=6.0.0'}
@@ -2242,23 +2700,67 @@ packages:
   birpc@2.9.0:
     resolution: {integrity: sha512-KrayHS5pBi69Xi9JmvoqrIgYGDkD6mcSe/i6YKi3w5kekCLzrX4+nawcXqrj2tIp50Kw/mT/s3p+GVK0A0sKxw==}
 
+  bluebird@3.7.2:
+    resolution: {integrity: sha512-XpNj6GDQzdfW+r2Wnn7xiSAd7TM3jzkxGXBGTtWKuSXv1xUV+azxAm8jdWZN06QTQk+2N2XB9jRDkvbmQmcRtg==}
+
   boolbase@1.0.0:
     resolution: {integrity: sha512-JZOSA7Mo9sNGB8+UjSgzdLtokWAky1zbztM3WRLCbZ70/3cTANmQmOdR7y2g+J0e2WXywy1yS468tY+IruqEww==}
 
+  boolean@3.2.0:
+    resolution: {integrity: sha512-d0II/GO9uf9lfUHH2BQsjxzRJZBdsjgsBiW4BvhWk/3qoKwQFjIDVN19PfX8F2D/r9PCMTtLWjYVCFrpeYUzsw==}
+    deprecated: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.
+
+  brace-expansion@1.1.15:
+    resolution: {integrity: sha512-EwOCDEex4quD37XhqM3omwtMoJjr//isUZz1JopUNWms+4Z2ViyM/k1YIRePpoVNnQhENnxtFjLaxNHrT7xIUg==}
+
+  brace-expansion@2.1.1:
+    resolution: {integrity: sha512-WR1cURNjuvBLMZBMbqM0UoE+WAfdUcEV1ccD8PVBVOI+Z3ND4+SZbN8RsfT2bMuG1qwz5RFvPukSZm5fF2D5eA==}
+
+  brace-expansion@5.0.6:
+    resolution: {integrity: sha512-kLpxurY4Z4r9sgMsyG0Z9uzsBlgiU/EFKhj/h91/8yHu0edo7XuixOIH3VcJ8kkxs6/jPzoI6U9Vj3WqbMQ94g==}
+    engines: {node: 18 || 20 || >=22}
+
   browserslist@4.28.2:
     resolution: {integrity: sha512-48xSriZYYg+8qXna9kwqjIVzuQxi+KYWp2+5nCYnYKPTr0LvD89Jqk2Or5ogxz0NUMfIjhh2lIUX/LyX9B4oIg==}
     engines: {node: ^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7}
     hasBin: true
 
+  buffer-from@1.1.2:
+    resolution: {integrity: sha512-E+XQCRwSbaaiChtv6k6Dwgc+bx+Bs6vuKJHHl5kox/BaKbhiXzqQOwK4cO22yElGp2OCmjwVhT3HmxgyPGnJfQ==}
+
+  builder-util-runtime@9.7.0:
+    resolution: {integrity: sha512-g/kR520giAFYkSXTzcmF3kqQq7wi8F6N6SzeDgZrqTBN+VHdmgWOyTdD1yD7AATDId/yXLvuP34CxW46/BwCdw==}
+    engines: {node: '>=12.0.0'}
+
+  builder-util@26.15.0:
+    resolution: {integrity: sha512-dUx+HxVbiNsNQ4mGe1PyoC/tBmsHwBNDLdBuqWCj+rhHFE9lHgrXiGYKAM1uNlznhAaUSyMlms84VeSSr3gOBA==}
+    engines: {node: '>=14.0.0'}
+
+  bytestreamjs@2.0.1:
+    resolution: {integrity: sha512-U1Z/ob71V/bXfVABvNr/Kumf5VyeQRBEm6Txb0PQ6S7V5GpBM3w4Cbqz/xPDicR5tN0uvDifng8C+5qECeGwyQ==}
+    engines: {node: '>=6.0.0'}
+
   cac@6.7.14:
     resolution: {integrity: sha512-b6Ilus+c3RrdDk+JhLKUAQfzzgLEPy6wcXqS7f/xe1EETvsDP6GORG7SFuOs6cID5YkqchW/LXZbX5bc8j7ZcQ==}
     engines: {node: '>=8'}
 
-  caniuse-lite@1.0.30001793:
-    resolution: {integrity: sha512-iwSsYWaCOoh26cV8NwNRViHlrfUvYsHDfRVcbtmw0Kg6PJIZZXwMkj1442FYLBGkeUf1juAsU3DTfxW579mrPA==}
+  cacheable-lookup@5.0.4:
+    resolution: {integrity: sha512-2/kNscPhpcxrOigMZzbiWF7dz8ilhb/nIHU3EyZiXWXpeq/au8qJ8VhdftMkty3n7Gj6HIGalQG8oiBNB3AJgA==}
+    engines: {node: '>=10.6.0'}
 
-  canvas-color-tracker@1.3.2:
-    resolution: {integrity: sha512-ryQkDX26yJ3CXzb3hxUVNlg1NKE4REc5crLBq661Nxzr8TNd236SaEf2ffYLXyI5tSABSeguHLqcVq4vf9L3Zg==}
+  cacheable-request@7.0.4:
+    resolution: {integrity: sha512-v+p6ongsrp0yTGbJXjgxPow2+DL93DASP4kXCDKb8/bwRtt9OEF3whggkkDkGNzgcWy2XaF4a8nZglC7uElscg==}
+    engines: {node: '>=8'}
+
+  call-bind-apply-helpers@1.0.2:
+    resolution: {integrity: sha512-Sp1ablJ0ivDkSzjcaJdxEunN5/XvksFJ2sMBFfq6x0ryhQV/2b/KwFe21cMpmHtPOSij8K99/wSfoEuTObmuMQ==}
+    engines: {node: '>= 0.4'}
+
+  caniuse-lite@1.0.30001793:
+    resolution: {integrity: sha512-iwSsYWaCOoh26cV8NwNRViHlrfUvYsHDfRVcbtmw0Kg6PJIZZXwMkj1442FYLBGkeUf1juAsU3DTfxW579mrPA==}
+
+  canvas-color-tracker@1.3.2:
+    resolution: {integrity: sha512-ryQkDX26yJ3CXzb3hxUVNlg1NKE4REc5crLBq661Nxzr8TNd236SaEf2ffYLXyI5tSABSeguHLqcVq4vf9L3Zg==}
     engines: {node: '>=12'}
 
   ccount@2.0.1:
@@ -2303,10 +2805,28 @@ packages:
     resolution: {integrity: sha512-TQMmc3w+5AxjpL8iIiwebF73dRDF4fBIieAqGn9RGCWaEVwQ6Fb2cGe31Yns0RRIzii5goJ1Y7xbMwo1TxMplw==}
     engines: {node: '>= 20.19.0'}
 
+  chownr@3.0.0:
+    resolution: {integrity: sha512-+IxzY9BZOQd/XuYPRmrvEVjF/nqj5kgT4kEq7VofrDoM1MxoRjEWkrCC3EtLi59TVawxTAn+orJwFQcrqEN1+g==}
+    engines: {node: '>=18'}
+
+  chromium-pickle-js@0.2.0:
+    resolution: {integrity: sha512-1R5Fho+jBq0DDydt+/vHWj5KJNJCKdARKOCwZUen84I5BreWoLqRLANH1U87eJy1tiASPtMnGqJJq0ZsLoRPOw==}
+
+  ci-info@4.3.1:
+    resolution: {integrity: sha512-Wdy2Igu8OcBpI2pZePZ5oWjPC38tmDVx5WKUXKwlLYkA0ozo85sLsLvkBbBn/sZaSCMFOGZJ14fvW9t5/d7kdA==}
+    engines: {node: '>=8'}
+
+  ci-info@4.4.0:
+    resolution: {integrity: sha512-77PSwercCZU2Fc4sX94eF8k8Pxte6JAwL4/ICZLFjJLqegs7kCuAsqqj/70NQF6TvDpgFjkubQB2FW2ZZddvQg==}
+    engines: {node: '>=8'}
+
   cliui@8.0.1:
     resolution: {integrity: sha512-BSeNnyus75C4//NQ9gQt1/csTXyo/8Sb+afLAkzAptFuMsod9HFokGNudZpi/oQV73hnVK+sR+5PVRMd+Dr7YQ==}
     engines: {node: '>=12'}
 
+  clone-response@1.0.3:
+    resolution: {integrity: sha512-ROoL94jJH2dUVML2Y/5PEDNaSHgeOdSDicUyS7izcF63G6sTc/FTjLub4b8Il9S8S0beOfYt0TaA5qvFK+w0wA==}
+
   color-convert@2.0.1:
     resolution: {integrity: sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==}
     engines: {node: '>=7.0.0'}
@@ -2314,9 +2834,28 @@ packages:
   color-name@1.1.4:
     resolution: {integrity: sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==}
 
+  combined-stream@1.0.8:
+    resolution: {integrity: sha512-FQN4MRfuJeHf7cBbBMJFXhKSDq+2kAArBlmRBvcvFE5BB1HZKXtSFASDhdlz9zOYwxh8lDdnvmMOe/+5cdoEdg==}
+    engines: {node: '>= 0.8'}
+
   comma-separated-tokens@2.0.3:
     resolution: {integrity: sha512-Fu4hJdvzeylCfQPp9SGWidpzrMs7tTrlu6Vb8XGaRGck8QSNZJJp538Wrb60Lax4fPwR64ViY468OIUTbRlGZg==}
 
+  commander@5.1.0:
+    resolution: {integrity: sha512-P0CysNDQ7rtVw4QIQtm+MRxV66vKFSvlsQvGYXZWR3qFU0jlMKHZZZgw8e+8DSah4UDKMqnknRDQz+xuQXQ/Zg==}
+    engines: {node: '>= 6'}
+
+  commander@9.5.0:
+    resolution: {integrity: sha512-KRs7WVDKg86PWiuAqhDrAQnTXZKraVcCc6vFdL14qrZ/DcWwuRo7VoiYXalXO7S5GKpqYiVEwCbgFDfxNHKJBQ==}
+    engines: {node: ^12.20.0 || >=14}
+
+  compare-version@0.1.2:
+    resolution: {integrity: sha512-pJDh5/4wrEnXX/VWRZvruAGHkzKdr46z11OlTPN+VrATlWWhSKewNCJ1futCO5C7eJB3nPMFZA1LeYtcFboZ2A==}
+    engines: {node: '>=0.10.0'}
+
+  concat-map@0.0.1:
+    resolution: {integrity: sha512-/Srv4dswyQNBfohGpz9o6Yb3Gz3SrUDqBH5rTuhGR7ahtlbYKnVxw2bCFMRljaA7EXHaXZ8wsHdodFvbkhKmqg==}
+
   concurrently@9.2.1:
     resolution: {integrity: sha512-fsfrO0MxV64Znoy8/l1vVIjjHa29SZyyqPgQBwhiDcaW8wJc2W3XWVOGx4M3oJBnv/zdUZIIp1gDeS98GzP8Ng==}
     engines: {node: '>=18'}
@@ -2378,6 +2917,16 @@ packages:
   cookie-es@3.1.1:
     resolution: {integrity: sha512-UaXxwISYJPTr9hwQxMFYZ7kNhSXboMXP+Z3TRX6f1/NyaGPfuNUZOWP1pUEb75B2HjfklIYLVRfWiFZJyC6Npg==}
 
+  core-util-is@1.0.3:
+    resolution: {integrity: sha512-ZQBvi1DcpJ4GDqanjucZ2Hj3wEO5pZDS89BWbkcrvdxksJorwUDDZamX9ldFkp9aw2lmBDLgkObEA4DWNJ9FYQ==}
+
+  cross-dirname@0.1.0:
+    resolution: {integrity: sha512-+R08/oI0nl3vfPcqftZRpytksBXDzOUveBq/NBVx0sUp1axwzPQrKinNx5yd5sxPu8j1wIy8AfnVQ+5eFdha6Q==}
+
+  cross-spawn@7.0.6:
+    resolution: {integrity: sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==}
+    engines: {node: '>= 8'}
+
   crossws@0.4.5:
     resolution: {integrity: sha512-wUR89x/Rw7/8t+vn0CmGDYM9TD6VtARGb0LD5jq2wjtMy1vCP4M+sm6N6TigWeTYvnA8MoW29NqqXD0ep0rfBA==}
     peerDependencies:
@@ -2518,13 +3067,33 @@ packages:
   decode-named-character-reference@1.3.0:
     resolution: {integrity: sha512-GtpQYB283KrPp6nRw50q3U9/VfOutZOe103qlN7BPP6Ad27xYnOIWv4lPzo8HCAL+mMZofJ9KEy30fq6MfaK6Q==}
 
+  decompress-response@6.0.0:
+    resolution: {integrity: sha512-aW35yZM6Bb/4oJlZncMH2LCoZtJXTRxES17vE3hoRiowU2kWHaJKFkSBDnDR+cm9J+9QhXmREyIfv0pji9ejCQ==}
+    engines: {node: '>=10'}
+
   deep-eql@5.0.2:
     resolution: {integrity: sha512-h5k/5U50IJJFpzfL6nO9jaaumfjO/f2NjK/oYB2Djzm4p9L+3T9qWpZqZ2hAbLPuuYq9wrU08WQyBTL5GbPk5Q==}
     engines: {node: '>=6'}
 
+  defer-to-connect@2.0.1:
+    resolution: {integrity: sha512-4tvttepXG1VaYGrRibk5EwJd1t4udunSOVMdLSAL6mId1ix438oPwPZMALY41FCijukO1L0twNcGsdzS7dHgDg==}
+    engines: {node: '>=10'}
+
+  define-data-property@1.1.4:
+    resolution: {integrity: sha512-rBMvIzlpA8v6E+SJZoo++HAYqsLrkg7MSfIinMPFhmkorw7X+dOXVJQs+QT69zGkzMyfDnIMN2Wid1+NbL3T+A==}
+    engines: {node: '>= 0.4'}
+
+  define-properties@1.2.1:
+    resolution: {integrity: sha512-8QmQKqEASLd5nx0U1B1okLElbUuuttJ/AnYmRXbbbGDWh6uS208EjD4Xqq/I9wK7u0v6O08XhTWnt5XtEbR6Dg==}
+    engines: {node: '>= 0.4'}
+
   defu@6.1.7:
     resolution: {integrity: sha512-7z22QmUWiQ/2d0KkdYmANbRUVABpZ9SNYyH5vx6PZ+nE5bcC0l7uFvEfHlyld/HcGBFTL536ClDt3DEcSlEJAQ==}
 
+  delayed-stream@1.0.0:
+    resolution: {integrity: sha512-ZySD7Nf91aLB0RxL4KGrKHBXl7Eds1DAmEdcoVawXnLD7SDhpNgtuII2aAkg7a7QS41jxPSZ17p4VdGnMHk3MQ==}
+    engines: {node: '>=0.4.0'}
+
   dequal@2.0.3:
     resolution: {integrity: sha512-0je+qPKHEMohvfRTCEo3CrPG6cAzAYgmzKyxRiYSSDkS6eGJdyVJm7WaYA5ECaAD9wLB2T4EEeymA5aFVcYXCA==}
     engines: {node: '>=6'}
@@ -2533,6 +3102,9 @@ packages:
     resolution: {integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==}
     engines: {node: '>=8'}
 
+  detect-node@2.1.0:
+    resolution: {integrity: sha512-T0NIuQpnTvFDATNuHN5roPwSBG83rFsuO+MXXH9/3N1eFbn4wcPjttvjMLEPWJ0RGUYgQE7cGgS3tNxbqCGM7g==}
+
   devlop@1.1.0:
     resolution: {integrity: sha512-RWmIqhcFf1lRYBvNmr7qTNuyCt/7/ns2jbpp1+PalgE/rDQcBT0fioSMUpJ93irlUhC5hrg4cYqe6U+0ImW0rA==}
 
@@ -2540,6 +3112,15 @@ packages:
     resolution: {integrity: sha512-DPi0FmjiSU5EvQV0++GFDOJ9ASQUVFh5kD+OzOnYdi7n3Wpm9hWWGfB/O2blfHcMVTL5WkQXSnRiK9makhrcnw==}
     engines: {node: '>=0.3.1'}
 
+  dir-compare@4.2.0:
+    resolution: {integrity: sha512-2xMCmOoMrdQIPHdsTawECdNPwlVFB9zGcz3kuhmBO6U3oU+UQjsue0i8ayLKpgBcm+hcXPMVSGUN9d+pvJ6+VQ==}
+
+  dmg-builder@26.15.2:
+    resolution: {integrity: sha512-fMkjRqKyPtsz4Kzu/qGP0BGjqzMCIgp+/7kw/u6YH6lvn/8hvL3c0TXhoFayBoYdpPCnEinnCHztd4bW7/jetA==}
+
+  dom-accessibility-api@0.5.16:
+    resolution: {integrity: sha512-X7BJ2yElsnOJ30pZF4uIIDfBEVgF4XEBxL9Bxhy6dnrm5hkzqmsWHGTiHqRiITNhMyFLyAiWndIJP7Z1NTteDg==}
+
   dom-serializer@2.0.0:
     resolution: {integrity: sha512-wIkAryiqt/nV5EQKqQpo3SToSOV9J0DnbJqwK7Wv/Trc92zIAYZ4FlMu+JPFW1DfGFt81ZTCGgDEabffXeLyJg==}
 
@@ -2556,6 +3137,14 @@ packages:
   domutils@3.2.2:
     resolution: {integrity: sha512-6kZKyUajlDuqlHKVX1w7gyslj9MPIXzIFiz/rGu35uC1wMi+kMhQwGhl4lt9unC9Vb9INnY9Z3/ZA3+FhASLaw==}
 
+  dotenv-expand@11.0.7:
+    resolution: {integrity: sha512-zIHwmZPRshsCdpMDyVsqGmgyP0yT8GAgXUnkdAoJisxvf33k7yO6OuoKmcTGuXPWSsm8Oh88nZicRLA9Y0rUeA==}
+    engines: {node: '>=12'}
+
+  dotenv@16.6.1:
+    resolution: {integrity: sha512-uBq4egWHTcTt33a72vpSG0z3HnPuIl6NqYcTrKEg2azoEyl2hpW0zqlxysq2pK9HlDIHyHyakeYaYnSAwd8bow==}
+    engines: {node: '>=12'}
+
   drizzle-orm@0.45.2:
     resolution: {integrity: sha512-kY0BSaTNYWnoDMVoyY8uxmyHjpJW1geOmBMdSSicKo9CIIWkSxMIj2rkeSR51b8KAPB7m+qysjuHme5nKP+E5Q==}
     peerDependencies:
@@ -2657,9 +3246,55 @@ packages:
       oxc-resolver:
         optional: true
 
+  dunder-proto@1.0.1:
+    resolution: {integrity: sha512-KIN/nDJBQRcXw0MLVhZE9iQHmG68qAVIBg9CqmUYjmQIhgij9U5MFvrqkUL5FbtyyzZuOeOt0zdeRe4UY7ct+A==}
+    engines: {node: '>= 0.4'}
+
+  duplexer2@0.1.4:
+    resolution: {integrity: sha512-asLFVfWWtJ90ZyOUHMqk7/S2w2guQKxUI2itj3d92ADHhxUSbCMGi1f1cBcJ7xM1To+pE/Khbwo1yuNbMEPKeA==}
+
+  ejs@3.1.10:
+    resolution: {integrity: sha512-UeJmFfOrAQS8OJWPZ4qtgHyWExa088/MtK5UEyoJGFH67cDEXkZSviOiKRCZ4Xij0zxI3JECgYs3oKx+AizQBA==}
+    engines: {node: '>=0.10.0'}
+    hasBin: true
+
+  electron-builder-squirrel-windows@26.15.2:
+    resolution: {integrity: sha512-PNl+SSRoma9mXhxycNGxutZPgvmK19v41mn8F9oecpAU2QNAldpB4HfMuA1LwFC2j8aRzzV5M9HKlKe6dfpvNw==}
+
+  electron-builder@26.15.2:
+    resolution: {integrity: sha512-veKM9+dCljaC5A74Pwc0ZWQ9arOHREXWh9hUIf8NGg49ch7x+IB4QhbMzIrV5ONZIXM2OEkaxW11cAPjPtoi4A==}
+    engines: {node: '>=14.0.0'}
+    hasBin: true
+
+  electron-publish@26.15.1:
+    resolution: {integrity: sha512-BMgMHOyexWn0UnOC+Afffw0DMrr0yfLp4U8YsLXwoJ3Da7LS7WUnz21teYZqO0gaApE1KgsjREWmbPqvF5JcPg==}
+
   electron-to-chromium@1.5.360:
     resolution: {integrity: sha512-GkcBt6YYAw9SxFWn+xVar4cLVGlXVuswwtRLBozi2zp0GjXs4ZnOrqV4zbXzg35n7w81hCkyJNYicgXlVHAmBA==}
 
+  electron-updater@6.8.9:
+    resolution: {integrity: sha512-ZhVxM9iGONUpZGI1FxdMRgJjUFXi7AYGVa5PwKlO1tV1/4zDxQmfKpXOHVztKrd6L9rLcFjERvi1Mf2vxyTkig==}
+
+  electron-vite@5.0.0:
+    resolution: {integrity: sha512-OHp/vjdlubNlhNkPkL/+3JD34ii5ov7M0GpuXEVdQeqdQ3ulvVR7Dg/rNBLfS5XPIFwgoBLDf9sjjrL+CuDyRQ==}
+    engines: {node: ^20.19.0 || >=22.12.0}
+    hasBin: true
+    peerDependencies:
+      '@swc/core': ^1.0.0
+      vite: ^5.0.0 || ^6.0.0 || ^7.0.0
+    peerDependenciesMeta:
+      '@swc/core':
+        optional: true
+
+  electron-winstaller@5.4.0:
+    resolution: {integrity: sha512-bO3y10YikuUwUuDUQRM4KfwNkKhnpVO7IPdbsrejwN9/AABJzzTQ4GeHwyzNSrVO+tEH3/Np255a3sVZpZDjvg==}
+    engines: {node: '>=8.0.0'}
+
+  electron@42.4.0:
+    resolution: {integrity: sha512-OXXqh9LD9KxXPv2Fe25EfU9N9AvWTuV6V81sfhQaNvTAXCd9ONA+Q4OWvMe+CmYD6xIwjFxGGtG/ZphDYYC5OQ==}
+    engines: {node: '>= 22.12.0'}
+    hasBin: true
+
   emoji-mart@5.6.0:
     resolution: {integrity: sha512-eJp3QRe79pjwa+duv+n7+5YsNhRcMl812EcFVwrnRvYKoNPoQb5qxU8DG6Bgwji0akHdp6D4Ln6tYLG58MFSow==}
 
@@ -2673,6 +3308,9 @@ packages:
   encoding-sniffer@0.2.1:
     resolution: {integrity: sha512-5gvq20T6vfpekVtqrYQsSCFZ1wEg5+wW0/QaZMWkFr6BqD3NfKs0rLCx4rrVlSWJeZb5NBJgVLswK/w2MWU+Gw==}
 
+  end-of-stream@1.4.5:
+    resolution: {integrity: sha512-ooEGc6HP26xXq/N+GCGOT0JKCLDGrq2bQUZrQ7gyrJiZANJ/8YDTxTpQBXGMn+WbIQXNVpyWymm7KYVICQnyOg==}
+
   enhanced-resolve@5.21.6:
     resolution: {integrity: sha512-aNnGCvbJ/RIyWo1IuhNdVjnNF+EjH9wpzpNHt+ci/m9He9LJvUN8wrCcXjp9cWsGNAuvSpVFTx/vraAFQ8qGjQ==}
     engines: {node: '>=10.13.0'}
@@ -2693,6 +3331,14 @@ packages:
     resolution: {integrity: sha512-zwfzJecQ/Uej6tusMqwAqU/6KL2XaB2VZ2Jg54Je6ahNBGNH6Ek6g3jjNCF0fG9EWQKGZNddNjU5F1ZQn/sBnA==}
     engines: {node: '>=20.19.0'}
 
+  env-paths@2.2.1:
+    resolution: {integrity: sha512-+h1lkLKhZMTYjog1VEpJNG7NZJWcuc2DDk/qsqSTRRCOXiLjeQ1d1/udrUGhqMxUgAlwKNZ0cf2uqan5GLuS2A==}
+    engines: {node: '>=6'}
+
+  env-paths@3.0.0:
+    resolution: {integrity: sha512-dtJUTepzMW3Lm/NPxRf3wP4642UWhjL2sQxc+ym2YMj1m/H2zDNQOlezafzkHwn6sMstjHTwG6iQQsctDW/b1A==}
+    engines: {node: ^12.20.0 || ^14.13.1 || >=16.0.0}
+
   env-runner@0.1.7:
     resolution: {integrity: sha512-i7h96jxETJYhXy5grgHNJ9xNzCzWIn9Ck/VkkYgOlE4gOqknsLX3CmlVb5LmwNex8sOoLFVZLz+TIw/+b5rktA==}
     hasBin: true
@@ -2705,14 +3351,41 @@ packages:
       miniflare:
         optional: true
 
+  err-code@2.0.3:
+    resolution: {integrity: sha512-2bmlRpNKBxT/CRmPOlyISQpNj+qSeYvcym/uT0Jx2bMOlKLtSy1ZmLuVxSEKKyor/N5yhvp/ZiG1oE3DEYMSFA==}
+
+  es-define-property@1.0.1:
+    resolution: {integrity: sha512-e3nRfgfUZ4rNGL232gUgX06QNyyez04KdjFrF+LTRoOXmrOgFKDg4BCdsjW8EnT69eqdYGmRpJwiPVYNrCaW3g==}
+    engines: {node: '>= 0.4'}
+
+  es-errors@1.3.0:
+    resolution: {integrity: sha512-Zf5H2Kxt2xjTvbJvP2ZWLEICxA6j+hAmMzIlypy4xcBg1vKVnx89Wy0GbS+kf5cwCVFFzdCFh2XSCFNULS6csw==}
+    engines: {node: '>= 0.4'}
+
   es-module-lexer@1.7.0:
     resolution: {integrity: sha512-jEQoCwk8hyb2AZziIOLhDqpm5+2ww5uIE6lkO/6jcOCusfk6LhMHpXXfBLXTZ7Ydyt0j4VoUQv6uGNYbdW+kBA==}
 
+  es-object-atoms@1.1.2:
+    resolution: {integrity: sha512-HWcBoN6NileqtSydK2FqHbS/LoDd2pqrnQHLyJzBj4kOp/ky2MWMN694xOfkK8/SnUsW2DH7EfyVlydKCsm1Zw==}
+    engines: {node: '>= 0.4'}
+
+  es-set-tostringtag@2.1.0:
+    resolution: {integrity: sha512-j6vWzfrGVfyXxge+O0x5sh6cvxAog0a/4Rdd2K36zCMV5eJ+/+tOAngRO8cODMNWbVRdVlmGZQL2YS3yR8bIUA==}
+    engines: {node: '>= 0.4'}
+
+  es6-error@4.1.1:
+    resolution: {integrity: sha512-Um/+FxMr9CISWh0bi5Zv0iOD+4cFh5qLeks1qhAopKVAJw3drgKbKySikp7wGhDL0HPeaja0P5ULZrxLkniUVg==}
+
   esbuild@0.21.5:
     resolution: {integrity: sha512-mg3OPMV4hXywwpoDxu3Qda5xCKQi+vCTZq8S9J/EpkhB2HzKXq4SNFZE3+NK93JYxc8VMSep+lOUSC/RVKaBqw==}
     engines: {node: '>=12'}
     hasBin: true
 
+  esbuild@0.25.12:
+    resolution: {integrity: sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==}
+    engines: {node: '>=18'}
+    hasBin: true
+
   esbuild@0.27.0:
     resolution: {integrity: sha512-jd0f4NHbD6cALCyGElNpGAOtWxSq46l9X/sWB0Nzd5er4Kz2YTm+Vl0qKFT9KUJvD8+fiO8AvoHhFvEatfVixA==}
     engines: {node: '>=18'}
@@ -2732,6 +3405,10 @@ packages:
     resolution: {integrity: sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==}
     engines: {node: '>=6'}
 
+  escape-string-regexp@4.0.0:
+    resolution: {integrity: sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==}
+    engines: {node: '>=10'}
+
   escape-string-regexp@5.0.0:
     resolution: {integrity: sha512-/veY75JbMK4j1yjvuUxuVsiS/hr/4iHs9FTT6cgTexxdE0Ly/glccBAkloH/DofkjRbZU3bnoj38mOmhkZ0lHw==}
     engines: {node: '>=12'}
@@ -2753,16 +3430,25 @@ packages:
     resolution: {integrity: sha512-knvyeauYhqjOYvQ66MznSMs83wmHrCycNEN6Ao+2AeYEfxUIkuiVxdEa1qlGEPK+We3n0THiDciYSsCcgW/DoA==}
     engines: {node: '>=12.0.0'}
 
+  exponential-backoff@3.1.3:
+    resolution: {integrity: sha512-ZgEeZXj30q+I0EN+CbSSpIyPaJ5HVQD18Z1m+u1FXbAeT94mr1zw50q4q6jiiC447Nl/YTcIYSAftiGqetwXCA==}
+
   exsolve@1.0.8:
     resolution: {integrity: sha512-LmDxfWXwcTArk8fUEnOfSZpHOJ6zOMUJKOtFLFqJLoKJetuQG874Uc7/Kki7zFLzYybmZhp1M7+98pfMqeX8yA==}
 
   extend@3.0.2:
     resolution: {integrity: sha512-fjquC59cD7CyW6urNXK0FBufkZcoiGG80wTuPujX590cB5Ttln20E2UB4S/WARVqhXffZl2LNgS+gQdPIIim/g==}
 
+  fast-deep-equal@3.1.3:
+    resolution: {integrity: sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==}
+
   fast-equals@5.4.0:
     resolution: {integrity: sha512-jt2DW/aNFNwke7AUd+Z+e6pz39KO5rzdbbFCg2sGafS4mk13MI7Z8O5z9cADNn5lhGODIgLwug6TZO2ctf7kcw==}
     engines: {node: '>=6.0.0'}
 
+  fast-uri@3.1.2:
+    resolution: {integrity: sha512-rVjf7ArG3LTk+FS6Yw81V1DLuZl1bRbNrev6Tmd/9RaroeeRRJhAt7jg/6YFxbvAQXUCavSoZhPPj6oOx+5KjQ==}
+
   fdir@6.5.0:
     resolution: {integrity: sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==}
     engines: {node: '>=12.0.0'}
@@ -2775,6 +3461,9 @@ packages:
   fetchdts@0.1.7:
     resolution: {integrity: sha512-YoZjBdafyLIop9lSxXVI33oLD5kN31q4Td+CasofLLYeLXRFeOsuOw0Uo+XNRi9PZlbfdlN2GmRtm4tCEQ9/KA==}
 
+  filelist@1.0.6:
+    resolution: {integrity: sha512-5giy2PkLYY1cP39p17Ech+2xlpTRL9HLspOfEgm0L6CwBXBTgsK5ou0JtzYuepxkaQ/tvhCFIJ5uXo0OrM2DxA==}
+
   float-tooltip@1.7.5:
     resolution: {integrity: sha512-/kXzuDnnBqyyWyhDMH7+PfP8J/oXiAavGzcRxASOMRHFuReDtofizLLJsf7nnDLAfEaMW4pVWaXrAjtnglpEkg==}
     engines: {node: '>=12'}
@@ -2783,6 +3472,33 @@ packages:
     resolution: {integrity: sha512-TdJ2KbkoiDQ7NIRx8IPGD0mAXXpLhamS7c+b7W98b0MHG7lphnda1VOQX/98UDTsttIAdH4TcP0l0MauSnLK8w==}
     engines: {node: '>=12'}
 
+  form-data@4.0.5:
+    resolution: {integrity: sha512-8RipRLol37bNs2bhoV67fiTEvdTrbMUYcFTiy3+wuuOnUog2QBHCZWXDRijWQfAkhBj2Uf5UnVaiWwA5vdd82w==}
+    engines: {node: '>= 6'}
+
+  fs-extra@10.1.0:
+    resolution: {integrity: sha512-oRXApq54ETRj4eMiFzGnHWGy+zo5raudjuxN0b8H7s/RU2oW0Wvsx9O0ACRN/kRq9E8Vu/ReskGB5o3ji+FzHQ==}
+    engines: {node: '>=12'}
+
+  fs-extra@11.3.5:
+    resolution: {integrity: sha512-eKpRKAovdpZtR1WopLHxlBWvAgPny3c4gX1G5Jhwmmw4XJj0ifSD5qB5TOo8hmA0wlRKDAOAhEE1yVPgs6Fgcg==}
+    engines: {node: '>=14.14'}
+
+  fs-extra@7.0.1:
+    resolution: {integrity: sha512-YJDaCJZEnBmcbw13fvdAM9AwNOJwOzrE4pqMqBq5nFiEqXUqHwlK4B+3pUw6JNvfSPtX05xFHtYy/1ni01eGCw==}
+    engines: {node: '>=6 <7 || >=8'}
+
+  fs-extra@8.1.0:
+    resolution: {integrity: sha512-yhlQgA6mnOJUKOsRUFsgJdQCvkKhcz8tlZG5HBQfReYZy46OwLcY+Zia0mtdHsOo9y/hP+CxMN0TU9QxoOtG4g==}
+    engines: {node: '>=6 <7 || >=8'}
+
+  fs-extra@9.1.0:
+    resolution: {integrity: sha512-hcg3ZmepS30/7BSFqRvoo3DOMQu7IjqxO5nCDt+zM9XWjb33Wg7ziNT+Qvqbuc3+gWpzO02JubVyk2G4Zvo1OQ==}
+    engines: {node: '>=10'}
+
+  fs.realpath@1.0.0:
+    resolution: {integrity: sha512-OO0pH2lK6a0hZnAdau5ItzHPI6pUlvI7jMVnxUQRtw4owF2wk8lOSabtGDCTP4Ggrg2MbGnWO9X8K1t4+fGMDw==}
+
   fsevents@2.3.2:
     resolution: {integrity: sha512-xiqMQR4xAeHTuB9uWm+fFRcIOgKBMiOBP+eXiyT7jsgVCq1bkVygt00oASowB7EdtpOHaaPgKt812P9ab+DDKA==}
     engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
@@ -2793,6 +3509,9 @@ packages:
     engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
     os: [darwin]
 
+  function-bind@1.1.2:
+    resolution: {integrity: sha512-7XHNxH7qX9xG5mIwxkhumTox/MIRNcOgDrxWsMt2pAr23WHp6MrRlN7FBSFpCpr+oVO0F744iUgR82nJMfG2SA==}
+
   gensync@1.0.0-beta.2:
     resolution: {integrity: sha512-3hN7NaskYvMDLQY55gnW3NQ+mesEAepTqlg+VEbj7zzqEMBVNhzcGYYeqFo/TlYz6eQiFcp1HcsCZO+nGgS8zg==}
     engines: {node: '>=6.9.0'}
@@ -2801,9 +3520,41 @@ packages:
     resolution: {integrity: sha512-DyFP3BM/3YHTQOCUL/w0OZHR0lpKeGrxotcHWcqNEdnltqFwXVfhEBQ94eIo34AfQpo0rGki4cyIiftY06h2Fg==}
     engines: {node: 6.* || 8.* || >= 10.*}
 
+  get-intrinsic@1.3.0:
+    resolution: {integrity: sha512-9fSjSaos/fRIVIp+xSJlE6lfwhES7LNtKaCBIamHsjr2na1BiABJPo0mOjjz8GJDURarmCPGqaiVg5mfjb98CQ==}
+    engines: {node: '>= 0.4'}
+
+  get-proto@1.0.1:
+    resolution: {integrity: sha512-sTSfBjoXBp89JvIKIefqw7U2CCebsc74kiY6awiGogKtoSGbgjYE/G/+l9sF3MWFPNc9IcoOC4ODfKHfxFmp0g==}
+    engines: {node: '>= 0.4'}
+
+  get-stream@5.2.0:
+    resolution: {integrity: sha512-nBF+F1rAZVCu/p7rjzgA+Yb4lfYXrpl7a6VmJrU8wF9I1CKvP/QwPNZHnOlwbTkY6dvtFIzFMSyQXbLoTQPRpA==}
+    engines: {node: '>=8'}
+
   get-tsconfig@4.14.0:
     resolution: {integrity: sha512-yTb+8DXzDREzgvYmh6s9vHsSVCHeC0G3PI5bEXNBHtmshPnO+S5O7qgLEOn0I5QvMy6kpZN8K1NKGyilLb93wA==}
 
+  glob@7.2.3:
+    resolution: {integrity: sha512-nFR0zLpU2YCaRxwoCJvL6UvCH2JFyFVIvwTLsIf21AuHlMskA1hhTdk+LlYJtOlYt9v6dvszD2BGRqBL+iQK9Q==}
+    deprecated: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
+
+  global-agent@3.0.0:
+    resolution: {integrity: sha512-PT6XReJ+D07JvGoxQMkT6qji/jVNfX/h364XHZOWeRzy64sSFr+xJ5OX7LI3b4MPQzdL4H8Y8M0xzPpsVMwA8Q==}
+    engines: {node: '>=10.0'}
+
+  globalthis@1.0.4:
+    resolution: {integrity: sha512-DpLKbNU4WylpxJykQujfCcwYWiV/Jhm50Goo0wrVILAv5jOr9d+H+UR3PhSCD2rCCEIg0uc+G+muBTwD54JhDQ==}
+    engines: {node: '>= 0.4'}
+
+  gopd@1.2.0:
+    resolution: {integrity: sha512-ZUKRh6/kUFoAiTAtTYPZJ3hw9wNxx+BIBOijnlG9PnrJsCcSjs1wyyD6vJpaYtgnzDrKYRSqf3OO6Rfa93xsRg==}
+    engines: {node: '>= 0.4'}
+
+  got@11.8.6:
+    resolution: {integrity: sha512-6tfZ91bOr7bOXnK7PRDCGBLa1H4U080YHNaAQ2KsMGlLEzRbk44nsZF2E1IeRc3vtJHPVbKCYgdFbaGO2ljd8g==}
+    engines: {node: '>=10.19.0'}
+
   graceful-fs@4.2.11:
     resolution: {integrity: sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==}
 
@@ -2831,6 +3582,21 @@ packages:
     resolution: {integrity: sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==}
     engines: {node: '>=8'}
 
+  has-property-descriptors@1.0.2:
+    resolution: {integrity: sha512-55JNKuIW+vq4Ke1BjOTjM2YctQIvCT7GFzHwmfZPGo5wnrgkid0YQtnAleFSqumZm4az3n2BS+erby5ipJdgrg==}
+
+  has-symbols@1.1.0:
+    resolution: {integrity: sha512-1cDNdwJ2Jaohmb3sg4OmKaMBwuC48sYni5HUw2DvsC8LjGTLK9h+eb1X6RyuOHe4hT0ULCW68iomhjUoKUqlPQ==}
+    engines: {node: '>= 0.4'}
+
+  has-tostringtag@1.0.2:
+    resolution: {integrity: sha512-NqADB8VjPFLM2V0VvHUewwwsw0ZWBaIdgo+ieHtK3hasLz4qeCRjYcqfB6AQrBggRKppKF8L52/VqdVsO47Dlw==}
+    engines: {node: '>= 0.4'}
+
+  hasown@2.0.4:
+    resolution: {integrity: sha512-T2UbfbBEF32wiepXIsMlTW9+dDYC6wMh/t/vYA4tuOMKqWz/n3vr1NFSxQiyP+zk2mXsoMA/i/7qV6LKut1t1A==}
+    engines: {node: '>= 0.4'}
+
   hast-util-to-jsx-runtime@2.3.6:
     resolution: {integrity: sha512-zl6s8LwNyo1P9uw+XJGvZtdFF1GdAkOg8ujOw+4Pyb76874fLps4ueHXDhXWdk6YHQ6OgUtinliG7RsYvCbbBg==}
 
@@ -2847,6 +3613,10 @@ packages:
   hookable@6.1.1:
     resolution: {integrity: sha512-U9LYDy1CwhMCnprUfeAZWZGByVbhd54hwepegYTK7Pi5NvqEj63ifz5z+xukznehT7i6NIZRu89Ay1AZmRsLEQ==}
 
+  hosted-git-info@4.1.0:
+    resolution: {integrity: sha512-kyCuEOWjJqZuDbRHzL8V93NzQhwIB71oFWSyzVo+KPZI+pnQPPxucdkrOZvkLRnrf5URsQM+IJ09Dw29cRALIA==}
+    engines: {node: '>=10'}
+
   html-encoding-sniffer@6.0.0:
     resolution: {integrity: sha512-CV9TW3Y3f8/wT0BRFc1/KAVQ3TUHiXmaAb6VW9vtiMFf7SLoMd1PdAc4W3KFOFETBJUb90KatHqlsZMWV+R9Gg==}
     engines: {node: ^20.19.0 || ^22.12.0 || >=24.0.0}
@@ -2857,6 +3627,21 @@ packages:
   htmlparser2@10.1.0:
     resolution: {integrity: sha512-VTZkM9GWRAtEpveh7MSF6SjjrpNVNNVJfFup7xTY3UpFtm67foy9HDVXneLtFVt4pMz5kZtgNcvCniNFb1hlEQ==}
 
+  http-cache-semantics@4.2.0:
+    resolution: {integrity: sha512-dTxcvPXqPvXBQpq5dUr6mEMJX4oIEFv6bwom3FDwKRDsuIjjJGANqhBuoAn9c1RQJIdAKav33ED65E2ys+87QQ==}
+
+  http-proxy-agent@7.0.2:
+    resolution: {integrity: sha512-T1gkAiYYDWYx3V5Bmyu7HcfcvL7mUrTWiM6yOfa3PIphViJ/gFPbvidQ+veqSOHci/PxBcDabeUNCzpOODJZig==}
+    engines: {node: '>= 14'}
+
+  http2-wrapper@1.0.3:
+    resolution: {integrity: sha512-V+23sDMr12Wnz7iTcDeJr3O6AIxlnvT/bmaAAAP/Xda35C90p9599p0F1eHR/N1KILWSoWVAiOMFjBBXaXSMxg==}
+    engines: {node: '>=10.19.0'}
+
+  https-proxy-agent@7.0.6:
+    resolution: {integrity: sha512-vK9P5/iUfdl95AI+JVyUuIcVtd4ofvtrOr3HNtM2yxC9bnMbEdp3x01OhQNnjb8IJYi38VlTE3mBXwcfvywuSw==}
+    engines: {node: '>= 14'}
+
   httpxy@0.5.3:
     resolution: {integrity: sha512-SMS9V6Sn7VWaS11lYhoAr0ceoaiolTWf4jYdJn0NJhCdKMu9R2H9Fh0LBDWBHQF6HRLI1PmaePYsjanSpE5PEw==}
 
@@ -2868,6 +3653,13 @@ packages:
     resolution: {integrity: sha512-SP23P27OUKzXWEC/TOyWlwLviofQkCSCKONnc62eItjp69yCZZPqDQtr3Pw5gJDnPeUMqExmKydNZaJO0FU9pw==}
     engines: {node: '>=12'}
 
+  inflight@1.0.6:
+    resolution: {integrity: sha512-k92I/b08q4wvFscXCLvqfsHCrjrF7yiXsQuIVvVE7N82W3+aqpzuUdBbfhWcy/FZR3/4IgflMgKLOsvPDrGCJA==}
+    deprecated: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.
+
+  inherits@2.0.4:
+    resolution: {integrity: sha512-k/vGaX4/Yla3WzyMCvTQOXYeIHvqOKtnqBduzTHpzpQZzAskKMhZ2K+EnBiSM9zGSoIFeMpXKxa4dYeZIQqewQ==}
+
   inline-style-parser@0.2.7:
     resolution: {integrity: sha512-Nb2ctOyNR8DqQoR0OwRG95uNWIC0C1lCgf5Naz5H6Ji72KZ8OcFZLz2P5sNgwlyoJ8Yif11oMuYs5pBQa86csA==}
 
@@ -2901,10 +3693,32 @@ packages:
   is-potential-custom-element-name@1.0.1:
     resolution: {integrity: sha512-bCYeRA2rVibKZd+s2625gGnGF/t7DSqDs4dP7CrLA1m7jKWz6pps0LpYLJN8Q64HtmPKJ1hrN3nzPNKFEKOUiQ==}
 
+  isarray@1.0.0:
+    resolution: {integrity: sha512-VLghIWNM6ELQzo7zwmcg0NmTVyWKYjvIeM83yjp0wRDTmUnrM678fQbcKBo6n2CJEF0szoG//ytg+TKla89ALQ==}
+
+  isbinaryfile@4.0.10:
+    resolution: {integrity: sha512-iHrqe5shvBUcFbmZq9zOQHBoeOhZJu6RQGrDpBgenUm/Am+F3JM2MgQj+rK3Z601fzrL5gLZWtAPH2OBaSVcyw==}
+    engines: {node: '>= 8.0.0'}
+
+  isbinaryfile@5.0.7:
+    resolution: {integrity: sha512-gnWD14Jh3FzS3CPhF0AxNOJ8CxqeblPTADzI38r0wt8ZyQl5edpy75myt08EG2oKvpyiqSqsx+Wkz9vtkbTqYQ==}
+    engines: {node: '>= 18.0.0'}
+
   isbot@5.1.40:
     resolution: {integrity: sha512-yNeeynhhtIVRBk12tBV4eHNxwB42HzR4Q3Ea7vCOiJhImGaAIdIMrbJtacQlBizGLjUPw+akkFI5Dn9T70XoVQ==}
     engines: {node: '>=18'}
 
+  isexe@2.0.0:
+    resolution: {integrity: sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==}
+
+  isexe@3.1.5:
+    resolution: {integrity: sha512-6B3tLtFqtQS4ekarvLVMZ+X+VlvQekbe4taUkf/rhVO3d/h0M2rfARm/pXLcPEsjjMsFgrFgSrhQIxcSVrBz8w==}
+    engines: {node: '>=18'}
+
+  isexe@4.0.0:
+    resolution: {integrity: sha512-FFUtZMpoZ8RqHS3XeXEmHWLA4thH+ZxCv2lOiPIn1Xc7CxrqhWzNSDzD+/chS/zbYezmiwWLdQC09JdQKmthOw==}
+    engines: {node: '>=20'}
+
   isomorphic-dompurify@3.14.0:
     resolution: {integrity: sha512-64W8/lsfqgaDWfEkvrIVk8FdIk29Mya0Fp39excQEdlcLUPg1Cn7CtCYe6CtPbFW90JpEKTXG0QQtIUNENJ7sw==}
     engines: {node: ^20.19.0 || ^22.13.0 || >=24.0.0}
@@ -2912,6 +3726,11 @@ packages:
   isomorphic.js@0.2.5:
     resolution: {integrity: sha512-PIeMbHqMt4DnUP3MA/Flc0HElYjMXArsw1qwJZcm9sqR8mq3l8NYizFMty0pWwE/tzIGH3EKK5+jes5mAr85yw==}
 
+  jake@10.9.4:
+    resolution: {integrity: sha512-wpHYzhxiVQL+IV05BLE2Xn34zW1S223hvjtqk0+gsPrwd/8JNLXJgZZM/iPFsYc1xyphF+6M6EvdE5E9MBGkDA==}
+    engines: {node: '>=10'}
+    hasBin: true
+
   jerrypick@1.1.2:
     resolution: {integrity: sha512-YKnxXEekXKzhpf7CLYA0A+oDP8V0OhICNCr5lv96FvSsDEmrb0GKM776JgQvHTMjr7DTTPEVv/1Ciaw0uEWzBA==}
     engines: {node: '>=12'}
@@ -2947,22 +3766,43 @@ packages:
     engines: {node: '>=6'}
     hasBin: true
 
+  json-buffer@3.0.1:
+    resolution: {integrity: sha512-4bV5BfR2mqfQTJm+V5tPPdf+ZpuhiIvTuAB5g8kcrXOZpTT/QwwVRWBywX1ozr6lEuPdbHxwaJlm9G6mI2sfSQ==}
+
+  json-schema-traverse@1.0.0:
+    resolution: {integrity: sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==}
+
   json-schema@0.4.0:
     resolution: {integrity: sha512-es94M3nTIfsEPisRafak+HDLfHXnKBhV3vU5eqPcS3flIWqcxJWgXHXiey3YrpaNsanY5ei1VoYEbOzijuq9BA==}
 
+  json-stringify-safe@5.0.1:
+    resolution: {integrity: sha512-ZClg6AaYvamvYEE82d3Iyd3vSSIjQ+odgjaTzRuO3s7toCdFKczob2i0zCh7JE8kWn17yvAWhUVxvqGwUalsRA==}
+
   json5@2.2.3:
     resolution: {integrity: sha512-XmOWe7eyHYH14cLdVPoyg+GOH3rYX++KpzrylJwSW98t3Nk+U8XOl8FWKOgwtzdb8lXGf6zYwDUzeHMWfxasyg==}
     engines: {node: '>=6'}
     hasBin: true
 
+  jsonfile@4.0.0:
+    resolution: {integrity: sha512-m6F1R3z8jjlf2imQHS2Qez5sjKWQzbuuhuJ/FKYFRZvPE3PuHcSMVZzfsLhGVOkfd20obL5SWEBew5ShlquNxg==}
+
+  jsonfile@6.2.1:
+    resolution: {integrity: sha512-zwOTdL3rFQ/lRdBnntKVOX6k5cKJwEc1HdilT71BWEu7J41gXIB2MRp+vxduPSwZJPWBxEzv4yH1wYLJGUHX4Q==}
+
   kapsule@1.16.3:
     resolution: {integrity: sha512-4+5mNNf4vZDSwPhKprKwz3330iisPrb08JyMgbsdFrimBCKNHecua/WBwvVg3n7vwx0C1ARjfhwIpbrbd9n5wg==}
     engines: {node: '>=12'}
 
+  keyv@4.5.4:
+    resolution: {integrity: sha512-oxVHkHR/EJf2CNXnWxRLW6mg7JyCCUcG0DtEGmL2ctUo1PNTin1PUil+r/+4r5MpVgC/fn1kjsx7mjSujKqIpw==}
+
   kleur@4.1.5:
     resolution: {integrity: sha512-o+NO+8WrRiQEE4/7nwRJhN1HWpVmJm511pBHUxPLtp0BUISzlBplORYSmTclCnJvQq2tKu/sgl3xVpkc7ZWuQQ==}
     engines: {node: '>=6'}
 
+  lazy-val@1.0.5:
+    resolution: {integrity: sha512-0/BnGCCfyUMkBpeDgWihanIAF9JmZhHBgUhEqzvf+adhNGLoP6TaiI5oF8oyb3I45P+PcnrqihSf01M0l0G5+Q==}
+
   lib0@0.2.117:
     resolution: {integrity: sha512-DeXj9X5xDCjgKLU/7RR+/HQEVzuuEUiwldwOGsHK/sfAfELGWEyTcf0x+uOvCvK3O2zPmZePXWL85vtia6GyZw==}
     engines: {node: '>=16'}
@@ -3044,6 +3884,16 @@ packages:
   lodash-es@4.18.1:
     resolution: {integrity: sha512-J8xewKD/Gk22OZbhpOVSwcs60zhd95ESDwezOFuA3/099925PdHJ7OFHNTGtajL3AlZkykD32HykiMo+BIBI8A==}
 
+  lodash.escaperegexp@4.1.2:
+    resolution: {integrity: sha512-TM9YBvyC84ZxE3rgfefxUWiQKLilstD6k7PTGt6wfbtXF8ixIJLOL3VYyV/z+ZiPLsVxAsKAFVwWlWeb2Y8Yyw==}
+
+  lodash.isequal@4.5.0:
+    resolution: {integrity: sha512-pDo3lu8Jhfjqls6GkMgpahsF9kCyayhgykjyLMNFTKWrpVdAQtYyB4muAMWozBB4ig/dtWAmsMxLEI8wuz+DYQ==}
+    deprecated: This package is deprecated. Use require('node:util').isDeepStrictEqual instead.
+
+  lodash@4.18.1:
+    resolution: {integrity: sha512-dMInicTPVE8d1e5otfwmmjlxkZoUpiVLwyeTdUsi/Caj/gfzzblBcCE5sRHV/AsjuCmxWrte2TNGSYuCeCq+0Q==}
+
   longest-streak@3.1.0:
     resolution: {integrity: sha512-9Ri+o0JYgehTaVBBDoMqIl8GXtbWg711O3srftcHhZ0dqnETqLaoIK0x17fUw9rFSlK/0NlsKe0Ahhyl5pXE2g==}
 
@@ -3054,6 +3904,10 @@ packages:
   loupe@3.2.1:
     resolution: {integrity: sha512-CdzqowRJCeLU72bHvWqwRBBlLcMEtIvGrlvef74kMnV2AolS9Y8xUv1I0U/MNAWMhBlKIoyuEgoJ0t/bbwHbLQ==}
 
+  lowercase-keys@2.0.0:
+    resolution: {integrity: sha512-tqNXrS78oMOE73NMxK4EMLQsQowWf8jKooH9g7xPavRT706R6bkQJ6DY2Te7QukaZsulxa30wQ7bk0pm4XiHmA==}
+    engines: {node: '>=8'}
+
   lowlight@3.3.0:
     resolution: {integrity: sha512-0JNhgFoPvP6U6lE/UdVsSq99tn6DhjjpAj5MxG49ewd2mOBVtwWYIT8ClyABhq198aXXODMU6Ox8DrGy/CpTZQ==}
 
@@ -3064,11 +3918,19 @@ packages:
   lru-cache@5.1.1:
     resolution: {integrity: sha512-KpNARQA3Iwv+jTA0utUVVbrh+Jlrr1Fv0e56GGzAFOXN7dk/FviaDW8LHmK52DlcH4WP2n6gI8vN1aesBFgo9w==}
 
+  lru-cache@6.0.0:
+    resolution: {integrity: sha512-Jo6dJ04CmSjuznwJSS3pUeWmd/H0ffTlkXXgwZi+eq1UCmqQwCh+eLsYOYCwY991i2Fah4h1BEMCx4qThGbsiA==}
+    engines: {node: '>=10'}
+
   lucide-react@1.16.0:
     resolution: {integrity: sha512-dYwyPzb4MEKpGUmNYk3WKWPnMrHs3FKM+q94kAnJrcDIqqn1hq2xY8scaS2ovsOCM5D51ey2gaRG3PBb1vgoYQ==}
     peerDependencies:
       react: ^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0
 
+  lz-string@1.5.0:
+    resolution: {integrity: sha512-h5bgJWpxJNswbU7qCrV0tIKQCaS3blPDrqKWx+QxzuzL1zGUzij9XCWLrSLsJPu5t+eWA/ycetzYAO5IOMcWAQ==}
+    hasBin: true
+
   magic-string@0.30.21:
     resolution: {integrity: sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==}
 
@@ -3080,6 +3942,14 @@ packages:
     engines: {node: '>= 20'}
     hasBin: true
 
+  matcher@3.0.0:
+    resolution: {integrity: sha512-OkeDaAZ/bQCxeFAozM55PKcKU0yJMPGifLwV4Qgjitu+5MoAfSQN4lsLJeXZ1b8w0x+/Emda6MZgXS1jvsapng==}
+    engines: {node: '>=10'}
+
+  math-intrinsics@1.1.0:
+    resolution: {integrity: sha512-/IXtbwEk5HTPyEwyKX6hGkYXxM9nbj64B+ilVJnC/R6B0pH5G4V3b0pVbL7DBj4tkhBAppbQUlf6F6Xl9LHu1g==}
+    engines: {node: '>= 0.4'}
+
   mdast-util-find-and-replace@3.0.2:
     resolution: {integrity: sha512-Tmd1Vg/m3Xz43afeNxDIhWRtFZgM2VLyaf4vSTYwudTyeuTneoL3qtWMA5jeLyz/O1vDJmmV4QuScFCA2tBPwg==}
 
@@ -3212,6 +4082,57 @@ packages:
   micromark@4.0.2:
     resolution: {integrity: sha512-zpe98Q6kvavpCr1NPVSCMebCKfD7CA2NqZ+rykeNhONIJBpc1tFKt9hucLGwha3jNTNI8lHpctWJWoimVF4PfA==}
 
+  mime-db@1.52.0:
+    resolution: {integrity: sha512-sPU4uV7dYlvtWJxwwxHD0PuihVNiE7TyAbQ5SWxDCB9mUYvOgroQOwYQQOKPJ8CIbE+1ETVlOoK1UC2nU3gYvg==}
+    engines: {node: '>= 0.6'}
+
+  mime-types@2.1.35:
+    resolution: {integrity: sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==}
+    engines: {node: '>= 0.6'}
+
+  mime@2.6.0:
+    resolution: {integrity: sha512-USPkMeET31rOMiarsBNIHZKLGgvKc/LrjofAnBlOttf5ajRvqiRA8QsenbcooctK6d6Ts6aqZXBA+XbkKthiQg==}
+    engines: {node: '>=4.0.0'}
+    hasBin: true
+
+  mimic-response@1.0.1:
+    resolution: {integrity: sha512-j5EctnkH7amfV/q5Hgmoal1g2QHFJRraOtmx0JpIqkxhBhI/lJSl1nMpQ45hVarwNETOoWEimndZ4QK0RHxuxQ==}
+    engines: {node: '>=4'}
+
+  mimic-response@3.1.0:
+    resolution: {integrity: sha512-z0yWI+4FDrrweS8Zmt4Ej5HdJmky15+L2e6Wgn3+iK5fWzb6T3fhNFq2+MeTRb064c6Wr4N/wv0DzQTjNzHNGQ==}
+    engines: {node: '>=10'}
+
+  minimatch@10.2.5:
+    resolution: {integrity: sha512-MULkVLfKGYDFYejP07QOurDLLQpcjk7Fw+7jXS2R2czRQzR56yHRveU5NDJEOviH+hETZKSkIk5c+T23GjFUMg==}
+    engines: {node: 18 || 20 || >=22}
+
+  minimatch@3.1.5:
+    resolution: {integrity: sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==}
+
+  minimatch@5.1.9:
+    resolution: {integrity: sha512-7o1wEA2RyMP7Iu7GNba9vc0RWWGACJOCZBJX2GJWip0ikV+wcOsgVuY9uE8CPiyQhkGFSlhuSkZPavN7u1c2Fw==}
+    engines: {node: '>=10'}
+
+  minimatch@9.0.9:
+    resolution: {integrity: sha512-OBwBN9AL4dqmETlpS2zasx+vTeWclWzkblfZk7KTA5j3jeOONz/tRCnZomUyvNg83wL5Zv9Ss6HMJXAgL8R2Yg==}
+    engines: {node: '>=16 || 14 >=14.17'}
+
+  minimist@1.2.8:
+    resolution: {integrity: sha512-2yyAR8qBkN3YuheJanUpWC5U3bb5osDywNB8RzDVlDwDHbocAJveqqj1u8+SVD7jkWT4yvsHCpWqqWqAxb0zCA==}
+
+  minipass@7.1.3:
+    resolution: {integrity: sha512-tEBHqDnIoM/1rXME1zgka9g6Q2lcoCkxHLuc7ODJ5BxbP5d4c2Z5cGgtXAku59200Cx7diuHTOYfSBD8n6mm8A==}
+    engines: {node: '>=16 || 14 >=14.17'}
+
+  minizlib@3.1.0:
+    resolution: {integrity: sha512-KZxYo1BUkWD2TVFLr0MQoM8vUUigWD3LlD83a/75BqC+4qE0Hb1Vo5v1FgcfaNXvfXzr+5EhQ6ing/CaBijTlw==}
+    engines: {node: '>= 18'}
+
+  mkdirp@0.5.6:
+    resolution: {integrity: sha512-FP+p8RB8OWpF3YZBCrP5gtADmtXApB5AMLn+vdyA+PyxCjrCs00mjyUozssO33cwDeT3wNGdLxJ5M//YqtHAJw==}
+    hasBin: true
+
   ms@2.1.3:
     resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}
 
@@ -3254,10 +4175,34 @@ packages:
       zephyr-agent:
         optional: true
 
+  node-abi@4.31.0:
+    resolution: {integrity: sha512-Erq5w/t3syw3s4sDsUaX4QttIdBPsGKTT1DTRsCkTonGggczhlDKm/wDX3o+HPJpQ41EjXCbcmXf0tgr5YZJXw==}
+    engines: {node: '>=22.12.0'}
+
+  node-api-version@0.2.1:
+    resolution: {integrity: sha512-2xP/IGGMmmSQpI1+O/k72jF/ykvZ89JeuKX3TLJAYPDVLUalrshrLHkeVcCCZqG/eEa635cr8IBYzgnDvM2O8Q==}
+
+  node-gyp@12.4.0:
+    resolution: {integrity: sha512-OMcPNvqTCFUnNaBlmdgq+lfNqY7gTiSmNRDjY3uAXRyudeKZEZxu3CLtjMQrx4zZxCX2b/mpNqTtwuCJgXhHkw==}
+    engines: {node: ^20.17.0 || >=22.9.0}
+    hasBin: true
+
+  node-int64@0.4.0:
+    resolution: {integrity: sha512-O5lz91xSOeoXP6DulyHfllpq+Eg00MWitZIbtPfoSEvqIHdl5gfcY6hYzDWnj0qD5tz52PI08u9qUvSVeUBeHw==}
+
   node-releases@2.0.45:
     resolution: {integrity: sha512-iIbHXV9eBB2nB0wa7oTsrrXq+qQt+9SIlx9AX3T96YgobtEQfis5n6TJ6vV+3QP8DwdriEAcGhARaFCu37peBg==}
     engines: {node: '>=18'}
 
+  nopt@9.0.0:
+    resolution: {integrity: sha512-Zhq3a+yFKrYwSBluL4H9XP3m3y5uvQkB/09CwDruCiRmR/UJYnn9W4R48ry0uGC70aeTPKLynBtscP9efFFcPw==}
+    engines: {node: ^20.17.0 || >=22.9.0}
+    hasBin: true
+
+  normalize-url@6.1.0:
+    resolution: {integrity: sha512-DlL+XwOy3NxAQ8xuC0okPgK46iuVNAK01YN7RueYBqqFeGsBjV9XmCAzAdgt+667bCl5kPh9EqKKDwnaPG1I7A==}
+    engines: {node: '>=10'}
+
   nth-check@2.1.1:
     resolution: {integrity: sha512-lqjrjmaOoAnWfMmBPL+XNnynZh2+swxiX3WUE0s4yEHI6m+AwrK2UZOimIRl3X/4QctVqS8AiZjFqyOGrMXb/w==}
 
@@ -3265,6 +4210,10 @@ packages:
     resolution: {integrity: sha512-rJgTQnkUnH1sFw8yT6VSU3zD3sWmu6sZhIseY8VX+GRu3P6F7Fu+JNDoXfklElbLJSnc3FUQHVe4cU5hj+BcUg==}
     engines: {node: '>=0.10.0'}
 
+  object-keys@1.1.1:
+    resolution: {integrity: sha512-NuAESUOUMrlIXOfHKzD6bpPu3tYt3xvjNdRIQ+FeT0lNb4K8WR70CaDxhuNguS2XG+GjkyMwOzsN5ZktImfhLA==}
+    engines: {node: '>= 0.4'}
+
   ocache@0.1.4:
     resolution: {integrity: sha512-e7geNdWjxSnvsSgvLuPvgKgu7ubM10ZmTPOgpr7mz2BXYtvjMKTiLhjFi/gWU8chkuP6hNkZBsa9LzOusyaqkQ==}
 
@@ -3274,9 +4223,20 @@ packages:
   ohash@2.0.11:
     resolution: {integrity: sha512-RdR9FQrFwNBNXAr4GixM8YaRZRJ5PUWbKYbE5eOsrwAjJW0q2REGcf79oYPsLyskQCZG1PLN+S/K1V00joZAoQ==}
 
+  once@1.4.0:
+    resolution: {integrity: sha512-lNaJgI+2Q5URQBkccEKHTQOPaXdUxnZZElQTZY0MFUAuaEqe1E+Nyvgdz/aIyNi6Z9MzO5dv1H8n58/GELp3+w==}
+
   orderedmap@2.1.1:
     resolution: {integrity: sha512-TvAWxi0nDe1j/rtMcWcIj94+Ffe6n7zhow33h40SKxmsmozs6dz/e+EajymfoFcHd7sxNn8yHM8839uixMOV6g==}
 
+  p-cancelable@2.1.1:
+    resolution: {integrity: sha512-BZOr3nRQHOntUjTrH8+Lh54smKHoHyur8We1V8DSMVrl5A2malOOwuJRnKRDjSnkoeBh4at6BwEnb5I7Jl31wg==}
+    engines: {node: '>=8'}
+
+  p-limit@3.1.0:
+    resolution: {integrity: sha512-TYOanM3wGwNGsZN2cVTYPArw454xnXj5qmWF1bEoAc4+cU/ol7GVh7odevjp1FNHduHc3KZMcFduxU5Xc6uJRQ==}
+    engines: {node: '>=10'}
+
   parse-entities@4.0.2:
     resolution: {integrity: sha512-GG2AQYWoLgL877gQIKeRPGO1xF9+eG1ujIb5soS5gPvLQ1y2o8FL90w2QWNdf9I361Mpp7726c+lj3U0qK1uGw==}
 
@@ -3292,6 +4252,14 @@ packages:
   parse5@8.0.1:
     resolution: {integrity: sha512-z1e/HMG90obSGeidlli3hj7cbocou0/wa5HacvI3ASx34PecNjNQeaHNo5WIZpWofN9kgkqV1q5YvXe3F0FoPw==}
 
+  path-is-absolute@1.0.1:
+    resolution: {integrity: sha512-AVbw3UJ2e9bq64vSaS9Am0fje1Pa8pbGqTTsmXfaIiMpnr5DlDhfJOuLj9Sf95ZPVDAUerDfEk88MPmPe7UCQg==}
+    engines: {node: '>=0.10.0'}
+
+  path-key@3.1.1:
+    resolution: {integrity: sha512-ojmeN0qd+y0jszEtoY48r0Peq5dwMEkIlCOu6Q5f41lfkswXuKtYrhgoTpLnyIcHm24Uhqx+5Tqm2InSwLhE6Q==}
+    engines: {node: '>=8'}
+
   pathe@1.1.2:
     resolution: {integrity: sha512-whLdWMYL2TwI08hn8/ZqAbrVemu0LNaNNJZX73O6qaIdCTfXutsLhMkjdENX0qhsQ9uIimo4/aQOmXkoon2nDQ==}
 
@@ -3302,6 +4270,10 @@ packages:
     resolution: {integrity: sha512-//nshmD55c46FuFw26xV/xFAaB5HF9Xdap7HJBBnrKdAd6/GxDBaNA1870O79+9ueg61cZLSVc+OaFlfmObYVQ==}
     engines: {node: '>= 14.16'}
 
+  pe-library@0.4.1:
+    resolution: {integrity: sha512-eRWB5LBz7PpDu4PUlwT0PhnQfTQJlDDdPa35urV4Osrm0t0AqQFGn+UIkU3klZvwJ8KPO3VbBFsXquA6p6kqZw==}
+    engines: {node: '>=12', npm: '>=6'}
+
   pg-cloudflare@1.4.0:
     resolution: {integrity: sha512-Vo7z/6rrQYxpNRylp4Tlob2elzbh+N/MOQbxFVWCxS7oEx6jF53GTJFxK2WWpKuBRkmiin4Mt+xofFDjx09R0A==}
 
@@ -3343,6 +4315,10 @@ packages:
     resolution: {integrity: sha512-QP88BAKvMam/3NxH6vj2o21R6MjxZUAd6nlwAS/pnGvN9IVLocLHxGYIzFhg6fUQ+5th6P4dv4eW9jX3DSIj7A==}
     engines: {node: '>=12'}
 
+  pkijs@3.4.0:
+    resolution: {integrity: sha512-emEcLuomt2j03vxD54giVB4SxTjnsqkU692xZOZXHDVoYyypEm+b3jpiTcc+Cf+myooc+/Ly0z01jqeNHVgJGw==}
+    engines: {node: '>=16.0.0'}
+
   playwright-core@1.60.0:
     resolution: {integrity: sha512-9bW6zvX/m0lEbgTKJ6YppOKx8H3VOPBMOCFh2irXFOT4BbHgrx5hPjwJYLT40Lu+4qtD36qKc/Hn56StUW57IA==}
     engines: {node: '>=18'}
@@ -3353,6 +4329,10 @@ packages:
     engines: {node: '>=18'}
     hasBin: true
 
+  plist@3.1.0:
+    resolution: {integrity: sha512-uysumyrvkUX0rX/dEVqt8gC3sTBzd4zoWfLeS29nb53imdaXVvLINYXTI2GNqzaMuvacNx4uJQ8+b3zXR0pkgQ==}
+    engines: {node: '>=10.4.0'}
+
   postcss@8.5.15:
     resolution: {integrity: sha512-FfR8sjd4em2T6fb3I2MwAJU7HWVMr9zba+enmQeeWFfCbm+UOC/0X4DS8XtpUTMwWMGbjKYP7xjfNekzyGmB3A==}
     engines: {node: ^10 || ^12 || >=14}
@@ -3373,6 +4353,11 @@ packages:
     resolution: {integrity: sha512-9ZhXKM/rw350N1ovuWHbGxnGh/SNJ4cnxHiM0rxE4VN41wsg8P8zWn9hv/buK00RP4WvlOyr/RBDiptyxVbkZQ==}
     engines: {node: '>=0.10.0'}
 
+  postject@1.0.0-alpha.6:
+    resolution: {integrity: sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==}
+    engines: {node: '>=14.0.0'}
+    hasBin: true
+
   preact@10.29.2:
     resolution: {integrity: sha512-7tNmwg/7mzzAoB/8kSg6Hl37JraAZw3Z3A0JSY7VXlZwo82Xn0G7wKbNNs2qoF4ZEEsQGTwDAroNdqKs1ofJxQ==}
 
@@ -3381,13 +4366,35 @@ packages:
     engines: {node: '>=14'}
     hasBin: true
 
+  pretty-format@27.5.1:
+    resolution: {integrity: sha512-Qb1gy5OrP5+zDf2Bvnzdl3jsTf1qXVMazbvCoKhtKqVs4/YK4ozX4gKQJJVyNe+cajNPn0KoC0MC3FUmaHWEmQ==}
+    engines: {node: ^10.13.0 || ^12.13.0 || ^14.15.0 || >=15.0.0}
+
   prismjs@1.30.0:
     resolution: {integrity: sha512-DEvV2ZF2r2/63V+tK8hQvrR2ZGn10srHbXviTlcv7Kpzw8jWiNTqbVgjO3IY8RxrrOUF8VPMQQFysYYYv0YZxw==}
     engines: {node: '>=6'}
 
+  proc-log@6.1.0:
+    resolution: {integrity: sha512-iG+GYldRf2BQ0UDUAd6JQ/RwzaQy6mXmsk/IzlYyal4A4SNFw54MeH4/tLkF4I5WoWG9SQwuqWzS99jaFQHBuQ==}
+    engines: {node: ^20.17.0 || >=22.9.0}
+
+  process-nextick-args@2.0.1:
+    resolution: {integrity: sha512-3ouUOpQhtgrbOa17J7+uxOTpITYWaGP7/AhoR3+A+/1e9skrzelGi/dXzEYyvbxubEF6Wn2ypscTKiKJFFn1ag==}
+
+  progress@2.0.3:
+    resolution: {integrity: sha512-7PiHtLll5LdnKIMw100I+8xJXR5gW2QwWYkT6iJva0bXitZKa/XMrSbdmg3r2Xnaidz9Qumd0VPaMrZlF9V9sA==}
+    engines: {node: '>=0.4.0'}
+
+  promise-retry@2.0.1:
+    resolution: {integrity: sha512-y+WKFlBR8BGXnsNlIHFGPZmyDf3DFMoLhaflAnyZgV6rG6xu+JwesTo2Q9R6XwYmtmwAFCkAk3e35jEdoeh/3g==}
+    engines: {node: '>=10'}
+
   prop-types@15.8.1:
     resolution: {integrity: sha512-oj87CgZICdulUohogVAR7AjlC0327U4el4L6eAvOqCeudMDVU0NThNaV+b9Df4dXgSP1gXMTnPdhfe/2qDH5cg==}
 
+  proper-lockfile@4.1.2:
+    resolution: {integrity: sha512-TjNPblN4BwAWMXU8s9AEz4JmQxnD1NNL7bNOY/AKUzyamc379FWASUhc/K1pL2noVb+XmZKLL68cjzLsiOAMaA==}
+
   property-information@7.1.0:
     resolution: {integrity: sha512-TwEZ+X+yCJmYfL7TPUOcvBZ4QfoT5YenQiJuX//0th53DE6w0xxLEtfK3iyryQFddXuvkIk51EEgrJQ0WJkOmQ==}
 
@@ -3427,13 +4434,27 @@ packages:
   prosemirror-view@1.41.8:
     resolution: {integrity: sha512-TnKDdohEatgyZNGCDWIdccOHXhYloJwbwU+phw/a23KBvJIR9lWQWW7WHHK3vBdOLDNuF7TaX98GObUZOWkOnA==}
 
+  pump@3.0.4:
+    resolution: {integrity: sha512-VS7sjc6KR7e1ukRFhQSY5LM2uBWAUPiOPa/A3mkKmiMwSmRFUITt0xuj+/lesgnCv+dPIEYlkzrcyXgquIHMcA==}
+
   punycode@2.3.1:
     resolution: {integrity: sha512-vYt7UD1U9Wg6138shLtLOvdAu+8DsC/ilFtEVHcH+wydcSpNE20AfSOduf6MkRFahL5FY7X1oU7nKVZFtfq8Fg==}
     engines: {node: '>=6'}
 
+  pvtsutils@1.3.6:
+    resolution: {integrity: sha512-PLgQXQ6H2FWCaeRak8vvk1GW462lMxB5s3Jm673N82zI4vqtVUPuZdffdZbPDFRoU8kAhItWFtPCWiPpp4/EDg==}
+
+  pvutils@1.1.5:
+    resolution: {integrity: sha512-KTqnxsgGiQ6ZAzZCVlJH5eOjSnvlyEgx1m8bkRJfOhmGRqfo5KLvmAlACQkrjEtOQ4B7wF9TdSLIs9O90MX9xA==}
+    engines: {node: '>=16.0.0'}
+
   quansync@1.0.0:
     resolution: {integrity: sha512-5xZacEEufv3HSTPQuchrvV6soaiACMFnq1H8wkVioctoH3TRha9Sz66lOxRwPK/qZj7HPiSveih9yAyh98gvqA==}
 
+  quick-lru@5.1.1:
+    resolution: {integrity: sha512-WuyALRjWPDGtt/wzJiadO5AXY+8hZ80hVpe6MyivgraREW751X3SbhRvG3eLKOYN+8VEvqLcf3wdnt44Z4S4SA==}
+    engines: {node: '>=10'}
+
   react-dom@19.2.6:
     resolution: {integrity: sha512-0prMI+hvBbPjsWnxDLxlCGyM8PN6UuWjEUCYmZhO67xIV9Xasa/r/vDnq+Xyq4Lo27g8QSbO5YzARu0D1Sps3g==}
     peerDependencies:
@@ -3448,6 +4469,9 @@ packages:
   react-is@16.13.1:
     resolution: {integrity: sha512-24e6ynE2H+OKt4kqsOvNd8kBpV65zoxbA4BVsEOB3ARVWQki/DHzaUoC5KuON/BiccDaCCTZBuOcfZs70kR8bQ==}
 
+  react-is@17.0.2:
+    resolution: {integrity: sha512-w2GsyukL62IJnlaff/nRegPQR94C/XXamvMWmSHRJ4y7Ts/4ocGRmTHvOs8PSE6pB3dWOrD/nueuU5sduBsQ4w==}
+
   react-kapsule@2.5.7:
     resolution: {integrity: sha512-kifAF4ZPD77qZKc4CKLmozq6GY1sBzPEJTIJb0wWFK6HsePJatK3jXplZn2eeAt3x67CDozgi7/rO8fNQ/AL7A==}
     engines: {node: '>=12'}
@@ -3470,6 +4494,13 @@ packages:
     resolution: {integrity: sha512-sfWGGfavi0xr8Pg0sVsyHMAOziVYKgPLNrS7ig+ivMNb3wbCBw3KxtflsGBAwD3gYQlE/AEZsTLgToRrSCjb0Q==}
     engines: {node: '>=0.10.0'}
 
+  read-binary-file-arch@1.0.6:
+    resolution: {integrity: sha512-BNg9EN3DD3GsDXX7Aa8O4p92sryjkmzYYgmgTAc6CA4uGLEDzFfxOxugu21akOxpcXHiEgsYkC6nPsQvLLLmEg==}
+    hasBin: true
+
+  readable-stream@2.3.8:
+    resolution: {integrity: sha512-8p0AUk4XODgIewSi0l8Epjs+EVnWiK7NoDIEGU0HhE7+ZyY8D1IMY7odu5lRrFXGg71L15KG8QrPmum45RTtdA==}
+
   readdirp@4.1.2:
     resolution: {integrity: sha512-GDhwkLfywWL2s6vEjyhri+eXmfH6j1L7JE27WhqLeYzoh/A3DBaYGEj2H/HFZCn/kMfim73FXxEJTw06WtxQwg==}
     engines: {node: '>= 14.18.0'}
@@ -3498,9 +4529,32 @@ packages:
     resolution: {integrity: sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==}
     engines: {node: '>=0.10.0'}
 
+  resedit@1.7.2:
+    resolution: {integrity: sha512-vHjcY2MlAITJhC0eRD/Vv8Vlgmu9Sd3LX9zZvtGzU5ZImdTN3+d6e/4mnTyV8vEbyf1sgNIrWxhWlrys52OkEA==}
+    engines: {node: '>=12', npm: '>=6'}
+
+  resolve-alpn@1.2.1:
+    resolution: {integrity: sha512-0a1F4l73/ZFZOakJnQ3FvkJ2+gSTQWz/r2KE5OdDY0TxPm5h4GkqkWWfM47T7HsbnOtcJVEF4epCVy6u7Q3K+g==}
+
   resolve-pkg-maps@1.0.0:
     resolution: {integrity: sha512-seS2Tj26TBVOC2NIc2rOe2y2ZO7efxITtLZcGSOnHHNOQ7CkiUBfw0Iw2ck6xkIhPwLhKNLS8BO+hEpngQlqzw==}
 
+  responselike@2.0.1:
+    resolution: {integrity: sha512-4gl03wn3hj1HP3yzgdI7d3lCkF95F21Pz4BPGvKHinyQzALR5CapwC8yIi0Rh58DEMQ/SguC03wFj2k0M/mHhw==}
+
+  retry@0.12.0:
+    resolution: {integrity: sha512-9LkiTwjUh6rT555DtE9rTX+BKByPfrMzEAtnlEtdEwr3Nkffwiihqe2bWADg+OQRjt9gl6ICdmB/ZFDCGAtSow==}
+    engines: {node: '>= 4'}
+
+  rimraf@2.6.3:
+    resolution: {integrity: sha512-mwqeW5XsA2qAejG46gYdENaxXjx9onRNCfn7L0duuP4hCuTIi/QO7PDK07KJfp1d+izWPrzEJDcSqBa0OZQriA==}
+    deprecated: Rimraf versions prior to v4 are no longer supported
+    hasBin: true
+
+  roarr@2.15.4:
+    resolution: {integrity: sha512-CHhPh+UNHD2GTXNYhPWLnU8ONHdI+5DI+4EYIAOaiD63rHeYlZvyh8P+in5999TTSFgUYuKUAjzRI4mdh/p+2A==}
+    engines: {node: '>=8.0'}
+
   rolldown-plugin-dts@0.13.14:
     resolution: {integrity: sha512-wjNhHZz9dlN6PTIXyizB6u/mAg1wEFMW9yw7imEVe3CxHSRnNHVyycIX0yDEOVJfDNISLPbkCIPEpFpizy5+PQ==}
     engines: {node: '>=20.18.0'}
@@ -3536,9 +4590,19 @@ packages:
   rxjs@7.8.2:
     resolution: {integrity: sha512-dhKf903U/PQZY6boNNtAGdWbG85WAbjT/1xYoZIC7FAY0yWapOBQVsVrDl58W86//e1VpMNBtRV4MaXfdMySFA==}
 
+  safe-buffer@5.1.2:
+    resolution: {integrity: sha512-Gd2UZBJDkXlY7GbJxfsE8/nvKkUEU1G38c1siN6QP6a9PT9MmHB8GnpscSmMJSoF8LOIrt8ud/wPtojys4G6+g==}
+
   safer-buffer@2.1.2:
     resolution: {integrity: sha512-YZo3K82SD7Riyi0E1EQPojLz7kpepnSQI9IyPbHHg1XXXevb5dJI7tpyN2ADxGcQbHG7vcyRHk0cbwqcQriUtg==}
 
+  sanitize-filename@1.6.4:
+    resolution: {integrity: sha512-9ZyI08PsvdQl2r/bBIGubpVdR3RR9sY6RDiWFPreA21C/EFlQhmgo20UZlNjZMMZNubusLhAQozkA0Od5J21Eg==}
+
+  sax@1.6.0:
+    resolution: {integrity: sha512-6R3J5M4AcbtLUdZmRv2SygeVaM7IhrLXu9BmnOGmmACak8fiUtOsYNWUS4uK7upbmHIBbLBeFeI//477BKLBzA==}
+    engines: {node: '>=11.0.0'}
+
   saxes@6.0.0:
     resolution: {integrity: sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==}
     engines: {node: '>=v12.22.7'}
@@ -3546,15 +4610,31 @@ packages:
   scheduler@0.27.0:
     resolution: {integrity: sha512-eNv+WrVbKu1f3vbYJT/xtiF5syA5HPIMtf9IgY/nKg0sWqzAUEvqY/xm7OcZc/qafLx/iO9FgOmeSAp4v5ti/Q==}
 
+  semver-compare@1.0.0:
+    resolution: {integrity: sha512-YM3/ITh2MJ5MtzaM429anh+x2jiLVjqILF4m4oyQB18W7Ggea7BfqdH/wGMK7dDiMghv/6WG7znWMwUDzJiXow==}
+
+  semver@5.7.2:
+    resolution: {integrity: sha512-cBznnQ9KjJqU67B52RMC65CMarK2600WFnbkcaiwWq3xy/5haFJlshgnpjovMVJ+Hff49d8GEn0b87C5pDQ10g==}
+    hasBin: true
+
   semver@6.3.1:
     resolution: {integrity: sha512-BR7VvDCVHO+q2xBEWskxS6DJE1qRnb7DxzUrogb71CWoSficBxYsiAGd+Kl0mmq/MprG9yArRkyrQxTO6XjMzA==}
     hasBin: true
 
+  semver@7.7.4:
+    resolution: {integrity: sha512-vFKC2IEtQnVhpT78h1Yp8wzwrf8CM+MzKMHGJZfBtzhZNycRFnXsHk6E5TxIkkMsgNS7mdX3AGB7x2QM2di4lA==}
+    engines: {node: '>=10'}
+    hasBin: true
+
   semver@7.8.1:
     resolution: {integrity: sha512-rkVq3IXh+4FDGch+KwzX3aV9W3kO54GyEgpvBzSyctDA6Xtd7RJQV1xmXbeQp5v7+VzLOfVqiutSE6GICgPFvg==}
     engines: {node: '>=10'}
     hasBin: true
 
+  serialize-error@7.0.1:
+    resolution: {integrity: sha512-8I8TjW5KMOKsZQTvoxjuSIa7foAwPWGOts+6o7sgjz41/qMD9VQHEDxi6PBvK2l0MXUmqZyNpUK+T2tQaaElvw==}
+    engines: {node: '>=10'}
+
   seroval-plugins@1.5.4:
     resolution: {integrity: sha512-S0xQPhUTefAhNvNWFg0c1J8qJArHt5KdtJ/cFAofo06KD1MVSeFWyl4iiu+ApDIuw0WhjpOfCdgConOfAnLgkw==}
     engines: {node: '>=10'}
@@ -3565,6 +4645,14 @@ packages:
     resolution: {integrity: sha512-46uFvgrXTVxZcUorgSSRZ4y+ieqLLQRMlG4bnCZKW3qI6BZm7Rg4ntMW4p1mILEEBZWrFlcpp0AyIIlM6jD9iw==}
     engines: {node: '>=10'}
 
+  shebang-command@2.0.0:
+    resolution: {integrity: sha512-kHxr2zZpYtdmrN1qDjrrX/Z1rR1kG8Dx+gkpK1G4eXmvXswmcE1hTWBWYUzlraYw1/yZp6YuDY77YtvbN0dmDA==}
+    engines: {node: '>=8'}
+
+  shebang-regex@3.0.0:
+    resolution: {integrity: sha512-7++dFhtcx3353uBaq8DDR4NuxBetBzC7ZQOhmTQInHEd6bSrXdiEyzCvG07Z44UYdLShWUyXt5M/yhz8ekcb1A==}
+    engines: {node: '>=8'}
+
   shell-quote@1.8.3:
     resolution: {integrity: sha512-ObmnIF4hXNg1BqhnHmgbDETF8dLPCggZWBjkQfhZpbszZnYur5DUljTcCHii5LC3J5E0yeO/1LIMyH+UvHQgyw==}
     engines: {node: '>= 0.4'}
@@ -3572,10 +4660,24 @@ packages:
   siginfo@2.0.0:
     resolution: {integrity: sha512-ybx0WO1/8bSBLEWXZvEd7gMW3Sn3JFlW3TvX1nREbDLRNQNaeNN8WK0meBwPdAaOI7TtRRRJn/Es1zhrrCHu7g==}
 
+  signal-exit@3.0.7:
+    resolution: {integrity: sha512-wnD2ZE+l+SPC/uoS0vXeE9L1+0wuaMqKlfz9AMUo38JsyLSBWSFcHR1Rri62LZc12vLr1gb3jl7iwQhgwpAbGQ==}
+
+  simple-update-notifier@2.0.0:
+    resolution: {integrity: sha512-a2B9Y0KlNXl9u/vsW6sTIu9vGEpfKu2wRV6l1H3XEas/0gUIzGzBoP/IouTcUQbm9JWZLH3COxyn03TYlFax6w==}
+    engines: {node: '>=10'}
+
   source-map-js@1.2.1:
     resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
     engines: {node: '>=0.10.0'}
 
+  source-map-support@0.5.21:
+    resolution: {integrity: sha512-uBHU3L3czsIyYXKX88fdrGovxdSCoTGDRZ6SYXtSRxLZUzHg5P/66Ht6uoUlHu9EZod+inXhKo3qQgwXUT/y1w==}
+
+  source-map@0.6.1:
+    resolution: {integrity: sha512-UjgapumWlbMhkBgzT7Ykc5YXUT46F0iKu8SGXq0bcwP5dz/h0Plj6enJqjz1Zbq2l5WaqYnrVbwWOWMyF3F47g==}
+    engines: {node: '>=0.10.0'}
+
   source-map@0.7.6:
     resolution: {integrity: sha512-i5uvt8C3ikiWeNZSVZNWcfZPItFQOsYTUAOkcUPGd8DqDy1uOUikjt5dG+uRlwyvR108Fb9DOd4GvXfT0N2/uQ==}
     engines: {node: '>= 12'}
@@ -3587,6 +4689,9 @@ packages:
     resolution: {integrity: sha512-UcjcJOWknrNkF6PLX83qcHM6KHgVKNkV62Y8a5uYDVv9ydGQVwAHMKqHdJje1VTWpljG0WYpCDhrCdAOYH4TWg==}
     engines: {node: '>= 10.x'}
 
+  sprintf-js@1.1.3:
+    resolution: {integrity: sha512-Oo+0REFV59/rz3gfJNKQiBlwfHaSESl1pcGyABQsnnIfWOFt6JNj5gCog2U6MLZ//IGYD+nA8nI+mTShREReaA==}
+
   srvx@0.11.15:
     resolution: {integrity: sha512-iXsux0UcOjdvs0LCMa2Ws3WwcDUozA3JN3BquNXkaFPP7TpRqgunKdEgoZ/uwb1J6xaYHfxtz9Twlh6yzwM6Tg==}
     engines: {node: '>=20.16.0'}
@@ -3595,6 +4700,10 @@ packages:
   stackback@0.0.2:
     resolution: {integrity: sha512-1XMJE5fQo1jGH6Y/7ebnwPOBEkIEnT4QF32d5R1+VXdXveM0IBMJt8zfaxX1P3QhVwrYe+576+jkANtSS2mBbw==}
 
+  stat-mode@1.0.0:
+    resolution: {integrity: sha512-jH9EhtKIjuXZ2cWxmXS8ZP80XyC3iasQxMDV8jzhNJpfDb7VbQLVW4Wvsxz9QZvzV+G4YoSfBUVKDOyxLzi/sg==}
+    engines: {node: '>= 6'}
+
   std-env@3.10.0:
     resolution: {integrity: sha512-5GS12FdOZNliM5mAOxFRg7Ir0pWz8MdpYm6AY6VPkGpbA7ZzmbzNcBJQ0GPvvyWgcY7QAhCgf9Uy89I03faLkg==}
 
@@ -3602,6 +4711,9 @@ packages:
     resolution: {integrity: sha512-wKyQRQpjJ0sIp62ErSZdGsjMJWsap5oRNihHhu6G7JVO/9jIB6UyevL+tXuOqrng8j/cxKTWyWUwvSTriiZz/g==}
     engines: {node: '>=8'}
 
+  string_decoder@1.1.1:
+    resolution: {integrity: sha512-n/ShnvDi6FHbbVfviro+WojiFzv+s8MPMHBczVePfUpDJLwoLT0ht1l4YwBCbi8pJAveEEdnkHyPyTP/mzRfwg==}
+
   stringify-entities@4.0.4:
     resolution: {integrity: sha512-IwfBptatlO+QCJUo19AqvrPNqlVMpW9YEL2LIVY+Rpv2qsjCGxaDLNRgeGsQWJhfItebuJhsGSLjaBbNSQ+ieg==}
 
@@ -3618,6 +4730,10 @@ packages:
   style-to-object@1.0.14:
     resolution: {integrity: sha512-LIN7rULI0jBscWQYaSswptyderlarFkjQ+t79nzty8tcIAceVomEVlLzH5VP4Cmsv6MtKhs7qaAiwlcp+Mgaxw==}
 
+  sumchecker@3.0.1:
+    resolution: {integrity: sha512-MvjXzkz/BOfyVDkG0oFOtBxHX2u3gKbMHIF/dXblZsgD3BWOFLmHovIpZY7BykJdAjcqRCBi1WYBNdEC9yI7vg==}
+    engines: {node: '>= 8.0'}
+
   supports-color@7.2.0:
     resolution: {integrity: sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==}
     engines: {node: '>=8'}
@@ -3640,7 +4756,24 @@ packages:
     resolution: {integrity: sha512-uxc/zpqFg6x7C8vOE7lh6Lbda8eEL9zmVm/PLeTPBRhh1xCgdWaQ+J1CUieGpIfm2HdtsUpRv+HshiasBMcc6A==}
     engines: {node: '>=6'}
 
-  tinybench@2.9.0:
+  tar@7.5.16:
+    resolution: {integrity: sha512-56adEpPMouktRlBLXiaYFFzZ/3+JXa8P9n7WbR+ibIjtviN55mEaOkiysCnPnWm+7kkui1Dn8J9l+g6zV8731w==}
+    engines: {node: '>=18'}
+
+  temp-file@3.4.0:
+    resolution: {integrity: sha512-C5tjlC/HCtVUOi3KWVokd4vHVViOmGjtLwIh4MuzPo/nMYTV/p1urt3RnMz2IWXDdKEGJH3k5+KPxtqRsUYGtg==}
+
+  temp@0.9.4:
+    resolution: {integrity: sha512-yYrrsWnrXMcdsnu/7YMYAofM1ktpL5By7vZhf15CrXijWWrEYZks5AXBudalfSWJLlnen/QUJUB5aoB0kqZUGA==}
+    engines: {node: '>=6.0.0'}
+
+  tiny-async-pool@1.3.0:
+    resolution: {integrity: sha512-01EAw5EDrcVrdgyCLgoSPvqznC0sVxDSVeiOz09FUpjh71G79VCqneOr+xvt7T1r76CF6ZZfPjHorN2+d+3mqA==}
+
+  tiny-typed-emitter@2.1.0:
+    resolution: {integrity: sha512-qVtvMxeXbVej0cQWKqVSSAHmKZEHAvxdF8HEUBFWts8h+xEo5m/lEiPakuyZ3BnCBjOD8i24kzNOiOLLgsSxhA==}
+
+  tinybench@2.9.0:
     resolution: {integrity: sha512-0+DUvqWMValLmha6lr4kD8iAMK1HzV0/aKnCtWb9v9641TnP/MFb7Pc2bxoxQjTXAErryXVgUOfv2YqNllqGeg==}
 
   tinycolor2@1.6.0:
@@ -3684,6 +4817,13 @@ packages:
     resolution: {integrity: sha512-ELrFxuqsDdHUwoh0XxDbxuLD3Wnz49Z57IFvTtvWy1hJdcMZjXLIuonjilCiWHlT2GbE4Wlv1wKVTzDFnXH1aw==}
     hasBin: true
 
+  tmp-promise@3.0.3:
+    resolution: {integrity: sha512-RwM7MoPojPxsOBYnyd2hy0bxtIlVrihNs9pj5SUvY8Zz1sQcQG2tG1hSr8PDxfgEB8RNKDhqbIlroIarSNDNsQ==}
+
+  tmp@0.2.7:
+    resolution: {integrity: sha512-e0votIpp4Uo2AJYSzVHV6xCcawuiez3DzqDAbrTc3YxBkplN6e+dM13ZeIcZnDg/QpSuU2zfZ3rzwY8ukEnaXw==}
+    engines: {node: '>=14.14'}
+
   tough-cookie@6.0.1:
     resolution: {integrity: sha512-LktZQb3IeoUWB9lqR5EWTHgW/VTITCXg4D21M+lvybRVdylLrRMnqaIONLVb5mav8vM19m44HIcGq4qASeu2Qw==}
     engines: {node: '>=16'}
@@ -3702,6 +4842,9 @@ packages:
   trough@2.2.0:
     resolution: {integrity: sha512-tmMpK00BjZiUyVyvrBK7knerNgmgvcV/KLVyuma/SC+TQN167GrMRciANTz09+k3zW8L8t60jWO1GpfkZdjTaw==}
 
+  truncate-utf8-bytes@1.0.2:
+    resolution: {integrity: sha512-95Pu1QXQvruGEhv62XCMO3Mm90GscOCClvrIUwCM0PYOXK3kaF3l3sIHxx71ThJfcbM2O5Au6SO3AWCSEfW4mQ==}
+
   tsdown@0.12.9:
     resolution: {integrity: sha512-MfrXm9PIlT3saovtWKf/gCJJ/NQCdE0SiREkdNC+9Qy6UHhdeDPxnkFaBD7xttVUmgp0yUHtGirpoLB+OVLuLA==}
     engines: {node: '>=18.0.0'}
@@ -3732,6 +4875,10 @@ packages:
     engines: {node: '>=18.0.0'}
     hasBin: true
 
+  type-fest@0.13.1:
+    resolution: {integrity: sha512-34R7HTnG0XIJcBSn5XhDd7nNFPRcXYRZrBB2O2jdKqYODldSzBAqzsWoZYYvduky73toYS/ESqxPvkDf/F0XMg==}
+    engines: {node: '>=10'}
+
   type-fest@5.6.0:
     resolution: {integrity: sha512-8ZiHFm91orbSAe2PSAiSVBVko18pbhbiB3U9GglSzF/zCGkR+rxpHx6sEMCUm4kxY4LjDIUGgCfUMtwfZfjfUA==}
     engines: {node: '>=20'}
@@ -3757,9 +4904,19 @@ packages:
   undici-types@6.21.0:
     resolution: {integrity: sha512-iwDZqg0QAGrg9Rav5H4n0M64c3mkR59cJ6wQp+7C4nI0gsmExaedaYLNO44eT4AtBBwjbTiGPMlt2Md0T9H9JQ==}
 
+  undici-types@7.18.2:
+    resolution: {integrity: sha512-AsuCzffGHJybSaRrmr5eHr81mwJU3kjw6M+uprWvCXiNeN9SOGwQ3Jn8jb8m3Z6izVgknn1R0FTCEAP2QrLY/w==}
+
+  undici-types@7.24.6:
+    resolution: {integrity: sha512-WRNW+sJgj5OBN4/0JpHFqtqzhpbnV0GuB+OozA9gCL7a993SmU+1JBZCzLNxYsbMfIeDL+lTsphD5jN5N+n0zg==}
+
   undici-types@7.25.0:
     resolution: {integrity: sha512-AXNgS1Byr27fTI+2bsPEkV9CxkT8H6xNyRI68b3TatlZo3RkzlqQBLL+w7SmGPVpokjHbcuNVQUWE7FRTg+LRA==}
 
+  undici@6.26.0:
+    resolution: {integrity: sha512-4yqz8a3n5HmGTlsbADNtr/dJlhkh/55Rq798G6ibiULcXbDtaLpTl1pvdqcbFfeoj3iSi52lePFM7h9H21cw/A==}
+    engines: {node: '>=18.17'}
+
   undici@7.25.0:
     resolution: {integrity: sha512-xXnp4kTyor2Zq+J1FfPI6Eq3ew5h6Vl0F/8d9XU5zZQf1tX9s2Su1/3PiMmUANFULpmksxkClamIZcaUqryHsQ==}
     engines: {node: '>=20.18.1'}
@@ -3785,6 +4942,14 @@ packages:
   unist-util-visit@5.1.0:
     resolution: {integrity: sha512-m+vIdyeCOpdr/QeQCu2EzxX/ohgS8KbnPDgFni4dQsfSCtpz8UqDyY5GjRru8PDKuYn7Fq19j1CQ+nJSsGKOzg==}
 
+  universalify@0.1.2:
+    resolution: {integrity: sha512-rBJeI5CXAlmy1pV+617WB9J63U6XcazHHF2f2dbJix4XzpUF0RS3Zbj0FGIOCAva5P/d/GBOYaACQ1w+0azUkg==}
+    engines: {node: '>= 4.0.0'}
+
+  universalify@2.0.1:
+    resolution: {integrity: sha512-gptHNQghINnc/vTGIk0SOFGFNXw7JVrlRUtConJRlvaw6DuX0wO5Jeko9sWrMBhh+PsYAZ7oXAiOnf/UKogyiw==}
+    engines: {node: '>= 10.0.0'}
+
   unplugin@3.0.0:
     resolution: {integrity: sha512-0Mqk3AT2TZCXWKdcoaufeXNukv2mTrEZExeXlHIOZXdqYoHHr4n51pymnwV8x2BOVxwXbK2HLlI7usrqMpycdg==}
     engines: {node: ^20.19.0 || >=22.12.0}
@@ -3863,6 +5028,9 @@ packages:
       uploadthing:
         optional: true
 
+  unzipper@0.12.3:
+    resolution: {integrity: sha512-PZ8hTS+AqcGxsaQntl3IRBw65QrBI6lxzqDEL7IAo/XCEqRTKGfOX56Vea5TH9SZczRVxuzk1re04z/YjuYCJA==}
+
   update-browserslist-db@1.2.3:
     resolution: {integrity: sha512-Js0m9cx+qOgDxo0eMiFGEueWztz+d4+M3rGlmKPT+T4IS/jP4ylw3Nwpu6cpTTP8R1MAC1kF4VbdLt3ARf209w==}
     hasBin: true
@@ -3874,6 +5042,12 @@ packages:
     peerDependencies:
       react: ^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0
 
+  utf8-byte-length@1.0.5:
+    resolution: {integrity: sha512-Xn0w3MtiQ6zoz2vFyUVruaCL53O/DwUvkEeOvj+uulMm0BkUGYWmBYVyElqZaSLhY6ZD0ulfU3aBra2aVT4xfA==}
+
+  util-deprecate@1.0.2:
+    resolution: {integrity: sha512-EPD5q1uXyFxJpCrLnCc1nHnq3gOa6DZBocAIiI2TaSCA7VCJ1UJDMagCzIkXNsUYfD1daK//LTEQ8xiIbrHtcw==}
+
   valibot@1.4.0:
     resolution: {integrity: sha512-iC/x7fVcSyOwlm/VSt7RlHnzNGLGvR9GnxdifUeWoCJo0q4ZZvrVkIHC6faTlkxG47I2Y4UrFquPuVHCrOnrLg==}
     peerDependencies:
@@ -4080,6 +5254,9 @@ packages:
     resolution: {integrity: sha512-o8qghlI8NZHU1lLPrpi2+Uq7abh4GGPpYANlalzWxyWteJOCsr/P+oPBA49TOLu5FTZO4d3F9MnWJfiMo4BkmA==}
     engines: {node: '>=18'}
 
+  webcrypto-core@1.9.2:
+    resolution: {integrity: sha512-gsXecm82UQNlTBURJGuqOWy1Ww08S3kZUcr3aOJS02Pk0xLtkfeUAVC0u0xhgdonFme80edSJUIJyuvL/7250Q==}
+
   webidl-conversions@8.0.1:
     resolution: {integrity: sha512-BMhLD/Sw+GbJC21C/UgyaZX41nPt8bUTg+jWyDeg7e7YN4xOM05YPSIXceACnXVtqyEw/LMClUQMtMZ+PGGpqQ==}
     engines: {node: '>=20'}
@@ -4104,6 +5281,21 @@ packages:
     resolution: {integrity: sha512-1to4zXBxmXHV3IiSSEInrreIlu02vUOvrhxJJH5vcxYTBDAx51cqZiKdyTxlecdKNSjj8EcxGBxNf6Vg+945gw==}
     engines: {node: ^20.19.0 || ^22.12.0 || >=24.0.0}
 
+  which@2.0.2:
+    resolution: {integrity: sha512-BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==}
+    engines: {node: '>= 8'}
+    hasBin: true
+
+  which@5.0.0:
+    resolution: {integrity: sha512-JEdGzHwwkrbWoGOlIHqQ5gtprKGOenpDHpxE9zVR1bWbOtYRyPPHMe9FaP6x61CmNaTThSkb0DAJte5jD+DmzQ==}
+    engines: {node: ^18.17.0 || >=20.5.0}
+    hasBin: true
+
+  which@6.0.1:
+    resolution: {integrity: sha512-oGLe46MIrCRqX7ytPUf66EAYvdeMIZYn3WaocqqKZAxrBpkqHfL/qvTyJ/bTk5+AqHCjXmrv3CEWgy368zhRUg==}
+    engines: {node: ^20.17.0 || >=22.9.0}
+    hasBin: true
+
   why-is-node-running@2.3.0:
     resolution: {integrity: sha512-hUrmaWBdVDcxvYqnyh09zunKzROWjbZTiNy8dBEjkS7ehEDQibXJ7XvlmtbwuTclUiIyN+CyXQD4Vmko8fNm8w==}
     engines: {node: '>=8'}
@@ -4113,6 +5305,9 @@ packages:
     resolution: {integrity: sha512-YVGIj2kamLSTxw6NsZjoBxfSwsn0ycdesmc4p+Q21c5zPuZ1pl+NfxVdxPtdHvmNVOQ6XSYG4AUtyt/Fi7D16Q==}
     engines: {node: '>=10'}
 
+  wrappy@1.0.2:
+    resolution: {integrity: sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==}
+
   ws@8.18.0:
     resolution: {integrity: sha512-8VbfWfHLbbwu3+N6OKsOMpBdT4kXPDDB9cJk2bJ6mh9ucxdlnNvH1e+roYkKmN9Nxw2yjz7VzeO9oOz2zJ04Pw==}
     engines: {node: '>=10.0.0'}
@@ -4133,6 +5328,10 @@ packages:
     resolution: {integrity: sha512-bx8Q1STctnNaaDymWnkfQLKofs0mGNN7rLLapJlGuV3VlvegD7Ls4ggMjE3aUSWItCCzU0PEv45lI87iSigiCA==}
     engines: {node: '>=20.0'}
 
+  xmlbuilder@15.1.1:
+    resolution: {integrity: sha512-yMqGBqtXyeN1e3TGYvgNgDVZ3j84W4cwkOXQswghol6APgZWaff9lnbvN7MHYJOiXsvGPXtjTYJEiC9J2wv9Eg==}
+    engines: {node: '>=8.0'}
+
   xmlchars@2.2.0:
     resolution: {integrity: sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==}
 
@@ -4169,6 +5368,13 @@ packages:
   yallist@3.1.1:
     resolution: {integrity: sha512-a4UGQaWPH59mOXUYnAG2ewncQS4i4F43Tv3JoAM+s2VDAmS9NsK8GpDMLrCHPksFT7h3K6TOoUNn2pb7RoXx4g==}
 
+  yallist@4.0.0:
+    resolution: {integrity: sha512-3wdGidZyq5PB084XLES5TpOSRA3wjXAlIWMhum2kRcv/41Sn2emQ0dycQW4uZXLejwKvg6EsvbdlVL+FYEct7A==}
+
+  yallist@5.0.0:
+    resolution: {integrity: sha512-YgvUTfwqyc7UXVMrB+SImsVYSmTS8X/tSrtdNZMImM+n7+QTriRXyXim0mBrTXNeqzVF0KWGgHPeiyViFFrNDw==}
+    engines: {node: '>=18'}
+
   yargs-parser@21.1.1:
     resolution: {integrity: sha512-tVpsJW7DdjecAiFpbIB1e3qxIQsE6NoPc5/eTdrbbIC4h0LVsWhnoa3g+m2HclBIujHzsxZ4VJVA+GUuc2/LBw==}
     engines: {node: '>=12'}
@@ -4181,6 +5387,10 @@ packages:
     resolution: {integrity: sha512-vv/9h42eCMC81ZHDFswuu/MKzkl/vyq1BhaNGfHyOonwlG4CJbQF4oiBBJPvfdeCt/PlVDWh7Nov9D34YY09uQ==}
     engines: {node: '>=16.0.0', npm: '>=8.0.0'}
 
+  yocto-queue@0.1.0:
+    resolution: {integrity: sha512-rVksvsnNCdJ/ohGc6xgPwyN8eheCxsiLM8mxuE/t/mOVqJewPuO1miLpTHQiRgTKCLexL4MeAFVagts7HmNZ2Q==}
+    engines: {node: '>=10'}
+
   zod@3.25.76:
     resolution: {integrity: sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==}
 
@@ -4312,6 +5522,8 @@ snapshots:
 
   '@babel/helper-plugin-utils@7.28.6': {}
 
+  '@babel/helper-plugin-utils@7.29.7': {}
+
   '@babel/helper-string-parser@7.27.1': {}
 
   '@babel/helper-validator-identifier@7.28.5': {}
@@ -4337,6 +5549,13 @@ snapshots:
       '@babel/core': 7.29.0
       '@babel/helper-plugin-utils': 7.28.6
 
+  '@babel/plugin-transform-arrow-functions@7.29.7(@babel/core@7.29.0)':
+    dependencies:
+      '@babel/core': 7.29.0
+      '@babel/helper-plugin-utils': 7.29.7
+
+  '@babel/runtime@7.29.7': {}
+
   '@babel/template@7.28.6':
     dependencies:
       '@babel/code-frame': 7.29.0
@@ -4381,10 +5600,10 @@ snapshots:
       convex: 1.39.1(react@19.2.6)
       convex-helpers: 0.1.118(@standard-schema/spec@1.1.0)(convex@1.39.1(react@19.2.6))(react@19.2.6)(typescript@5.9.3)(zod@3.25.76)
 
-  '@convex-dev/workos-authkit@0.2.5(@edge-runtime/vm@4.0.4)(@standard-schema/spec@1.1.0)(@types/debug@4.1.13)(@types/node@22.19.19)(@workos-inc/authkit-react@0.11.0(react@19.2.6))(@workos-inc/node@8.13.0)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1)(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)(zod@3.25.76)':
+  '@convex-dev/workos-authkit@0.2.5(@edge-runtime/vm@4.0.4)(@standard-schema/spec@1.1.0)(@types/debug@4.1.13)(@types/node@22.19.19)(@workos-inc/authkit-react@0.11.0(react@19.2.6))(@workos-inc/node@8.13.0)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)(zod@3.25.76)':
     dependencies:
       '@convex-dev/workflow': 0.3.12(@convex-dev/workpool@0.4.6(convex-helpers@0.1.118(@standard-schema/spec@1.1.0)(convex@1.39.1(react@19.2.6))(react@19.2.6)(typescript@5.9.3)(zod@3.25.76))(convex@1.39.1(react@19.2.6)))(convex-helpers@0.1.118(@standard-schema/spec@1.1.0)(convex@1.39.1(react@19.2.6))(react@19.2.6)(typescript@5.9.3)(zod@3.25.76))(convex@1.39.1(react@19.2.6))
-      '@convex-dev/workos': 0.0.1(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1)(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)
+      '@convex-dev/workos': 0.0.1(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)
       '@convex-dev/workpool': 0.4.6(convex-helpers@0.1.118(@standard-schema/spec@1.1.0)(convex@1.39.1(react@19.2.6))(react@19.2.6)(typescript@5.9.3)(zod@3.25.76))(convex@1.39.1(react@19.2.6))
       '@workos-inc/authkit-react': 0.11.0(react@19.2.6)
       '@workos-inc/node': 8.13.0
@@ -4424,13 +5643,13 @@ snapshots:
       - yaml
       - zod
 
-  '@convex-dev/workos@0.0.1(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1)(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)':
+  '@convex-dev/workos@0.0.1(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(convex@1.39.1(react@19.2.6))(jiti@2.7.0)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)(react@19.2.6)(tsx@4.22.3)(typescript@5.9.3)':
     dependencies:
       '@workos-inc/authkit-react': 0.11.0(react@19.2.6)
       convex: 1.39.1(react@19.2.6)
       react: 19.2.6
       tsdown: 0.12.9(typescript@5.9.3)
-      vitest: 3.2.4(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(jiti@2.7.0)(jsdom@29.1.1)(lightningcss@1.32.0)(tsx@4.22.3)
+      vitest: 3.2.4(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(jiti@2.7.0)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)(tsx@4.22.3)
     transitivePeerDependencies:
       - '@arethetypeswrong/core'
       - '@edge-runtime/vm'
@@ -4495,6 +5714,102 @@ snapshots:
     dependencies:
       '@edge-runtime/primitives': 5.1.1
 
+  '@electron-internal/extract-zip@1.0.2': {}
+
+  '@electron/asar@3.4.1':
+    dependencies:
+      commander: 5.1.0
+      glob: 7.2.3
+      minimatch: 3.1.5
+
+  '@electron/fuses@1.8.0':
+    dependencies:
+      chalk: 4.1.2
+      fs-extra: 9.1.0
+      minimist: 1.2.8
+
+  '@electron/fuses@2.1.2': {}
+
+  '@electron/get@3.1.0':
+    dependencies:
+      debug: 4.4.3
+      env-paths: 2.2.1
+      fs-extra: 8.1.0
+      got: 11.8.6
+      progress: 2.0.3
+      semver: 6.3.1
+      sumchecker: 3.0.1
+    optionalDependencies:
+      global-agent: 3.0.0
+    transitivePeerDependencies:
+      - supports-color
+
+  '@electron/get@5.0.0':
+    dependencies:
+      debug: 4.4.3
+      env-paths: 3.0.0
+      graceful-fs: 4.2.11
+      progress: 2.0.3
+      semver: 7.8.1
+      sumchecker: 3.0.1
+    optionalDependencies:
+      undici: 7.25.0
+    transitivePeerDependencies:
+      - supports-color
+
+  '@electron/notarize@2.5.0':
+    dependencies:
+      debug: 4.4.3
+      fs-extra: 9.1.0
+      promise-retry: 2.0.1
+    transitivePeerDependencies:
+      - supports-color
+
+  '@electron/osx-sign@1.3.3':
+    dependencies:
+      compare-version: 0.1.2
+      debug: 4.4.3
+      fs-extra: 10.1.0
+      isbinaryfile: 4.0.10
+      minimist: 1.2.8
+      plist: 3.1.0
+    transitivePeerDependencies:
+      - supports-color
+
+  '@electron/rebuild@4.0.4':
+    dependencies:
+      '@malept/cross-spawn-promise': 2.0.0
+      debug: 4.4.3
+      node-abi: 4.31.0
+      node-api-version: 0.2.1
+      node-gyp: 12.4.0
+      read-binary-file-arch: 1.0.6
+    transitivePeerDependencies:
+      - supports-color
+
+  '@electron/universal@2.0.3':
+    dependencies:
+      '@electron/asar': 3.4.1
+      '@malept/cross-spawn-promise': 2.0.0
+      debug: 4.4.3
+      dir-compare: 4.2.0
+      fs-extra: 11.3.5
+      minimatch: 9.0.9
+      plist: 3.1.0
+    transitivePeerDependencies:
+      - supports-color
+
+  '@electron/windows-sign@1.2.2':
+    dependencies:
+      cross-dirname: 0.1.0
+      debug: 4.4.3
+      fs-extra: 11.3.5
+      minimist: 1.2.8
+      postject: 1.0.0-alpha.6
+    transitivePeerDependencies:
+      - supports-color
+    optional: true
+
   '@emnapi/core@1.10.0':
     dependencies:
       '@emnapi/wasi-threads': 1.2.1
@@ -4521,6 +5836,9 @@ snapshots:
   '@esbuild/aix-ppc64@0.21.5':
     optional: true
 
+  '@esbuild/aix-ppc64@0.25.12':
+    optional: true
+
   '@esbuild/aix-ppc64@0.27.0':
     optional: true
 
@@ -4533,6 +5851,9 @@ snapshots:
   '@esbuild/android-arm64@0.21.5':
     optional: true
 
+  '@esbuild/android-arm64@0.25.12':
+    optional: true
+
   '@esbuild/android-arm64@0.27.0':
     optional: true
 
@@ -4545,6 +5866,9 @@ snapshots:
   '@esbuild/android-arm@0.21.5':
     optional: true
 
+  '@esbuild/android-arm@0.25.12':
+    optional: true
+
   '@esbuild/android-arm@0.27.0':
     optional: true
 
@@ -4557,6 +5881,9 @@ snapshots:
   '@esbuild/android-x64@0.21.5':
     optional: true
 
+  '@esbuild/android-x64@0.25.12':
+    optional: true
+
   '@esbuild/android-x64@0.27.0':
     optional: true
 
@@ -4569,6 +5896,9 @@ snapshots:
   '@esbuild/darwin-arm64@0.21.5':
     optional: true
 
+  '@esbuild/darwin-arm64@0.25.12':
+    optional: true
+
   '@esbuild/darwin-arm64@0.27.0':
     optional: true
 
@@ -4581,6 +5911,9 @@ snapshots:
   '@esbuild/darwin-x64@0.21.5':
     optional: true
 
+  '@esbuild/darwin-x64@0.25.12':
+    optional: true
+
   '@esbuild/darwin-x64@0.27.0':
     optional: true
 
@@ -4593,6 +5926,9 @@ snapshots:
   '@esbuild/freebsd-arm64@0.21.5':
     optional: true
 
+  '@esbuild/freebsd-arm64@0.25.12':
+    optional: true
+
   '@esbuild/freebsd-arm64@0.27.0':
     optional: true
 
@@ -4605,6 +5941,9 @@ snapshots:
   '@esbuild/freebsd-x64@0.21.5':
     optional: true
 
+  '@esbuild/freebsd-x64@0.25.12':
+    optional: true
+
   '@esbuild/freebsd-x64@0.27.0':
     optional: true
 
@@ -4617,6 +5956,9 @@ snapshots:
   '@esbuild/linux-arm64@0.21.5':
     optional: true
 
+  '@esbuild/linux-arm64@0.25.12':
+    optional: true
+
   '@esbuild/linux-arm64@0.27.0':
     optional: true
 
@@ -4629,6 +5971,9 @@ snapshots:
   '@esbuild/linux-arm@0.21.5':
     optional: true
 
+  '@esbuild/linux-arm@0.25.12':
+    optional: true
+
   '@esbuild/linux-arm@0.27.0':
     optional: true
 
@@ -4641,6 +5986,9 @@ snapshots:
   '@esbuild/linux-ia32@0.21.5':
     optional: true
 
+  '@esbuild/linux-ia32@0.25.12':
+    optional: true
+
   '@esbuild/linux-ia32@0.27.0':
     optional: true
 
@@ -4653,6 +6001,9 @@ snapshots:
   '@esbuild/linux-loong64@0.21.5':
     optional: true
 
+  '@esbuild/linux-loong64@0.25.12':
+    optional: true
+
   '@esbuild/linux-loong64@0.27.0':
     optional: true
 
@@ -4665,6 +6016,9 @@ snapshots:
   '@esbuild/linux-mips64el@0.21.5':
     optional: true
 
+  '@esbuild/linux-mips64el@0.25.12':
+    optional: true
+
   '@esbuild/linux-mips64el@0.27.0':
     optional: true
 
@@ -4677,6 +6031,9 @@ snapshots:
   '@esbuild/linux-ppc64@0.21.5':
     optional: true
 
+  '@esbuild/linux-ppc64@0.25.12':
+    optional: true
+
   '@esbuild/linux-ppc64@0.27.0':
     optional: true
 
@@ -4689,6 +6046,9 @@ snapshots:
   '@esbuild/linux-riscv64@0.21.5':
     optional: true
 
+  '@esbuild/linux-riscv64@0.25.12':
+    optional: true
+
   '@esbuild/linux-riscv64@0.27.0':
     optional: true
 
@@ -4701,6 +6061,9 @@ snapshots:
   '@esbuild/linux-s390x@0.21.5':
     optional: true
 
+  '@esbuild/linux-s390x@0.25.12':
+    optional: true
+
   '@esbuild/linux-s390x@0.27.0':
     optional: true
 
@@ -4713,6 +6076,9 @@ snapshots:
   '@esbuild/linux-x64@0.21.5':
     optional: true
 
+  '@esbuild/linux-x64@0.25.12':
+    optional: true
+
   '@esbuild/linux-x64@0.27.0':
     optional: true
 
@@ -4722,6 +6088,9 @@ snapshots:
   '@esbuild/linux-x64@0.28.0':
     optional: true
 
+  '@esbuild/netbsd-arm64@0.25.12':
+    optional: true
+
   '@esbuild/netbsd-arm64@0.27.0':
     optional: true
 
@@ -4734,6 +6103,9 @@ snapshots:
   '@esbuild/netbsd-x64@0.21.5':
     optional: true
 
+  '@esbuild/netbsd-x64@0.25.12':
+    optional: true
+
   '@esbuild/netbsd-x64@0.27.0':
     optional: true
 
@@ -4743,6 +6115,9 @@ snapshots:
   '@esbuild/netbsd-x64@0.28.0':
     optional: true
 
+  '@esbuild/openbsd-arm64@0.25.12':
+    optional: true
+
   '@esbuild/openbsd-arm64@0.27.0':
     optional: true
 
@@ -4755,6 +6130,9 @@ snapshots:
   '@esbuild/openbsd-x64@0.21.5':
     optional: true
 
+  '@esbuild/openbsd-x64@0.25.12':
+    optional: true
+
   '@esbuild/openbsd-x64@0.27.0':
     optional: true
 
@@ -4764,6 +6142,9 @@ snapshots:
   '@esbuild/openbsd-x64@0.28.0':
     optional: true
 
+  '@esbuild/openharmony-arm64@0.25.12':
+    optional: true
+
   '@esbuild/openharmony-arm64@0.27.0':
     optional: true
 
@@ -4776,6 +6157,9 @@ snapshots:
   '@esbuild/sunos-x64@0.21.5':
     optional: true
 
+  '@esbuild/sunos-x64@0.25.12':
+    optional: true
+
   '@esbuild/sunos-x64@0.27.0':
     optional: true
 
@@ -4788,6 +6172,9 @@ snapshots:
   '@esbuild/win32-arm64@0.21.5':
     optional: true
 
+  '@esbuild/win32-arm64@0.25.12':
+    optional: true
+
   '@esbuild/win32-arm64@0.27.0':
     optional: true
 
@@ -4800,6 +6187,9 @@ snapshots:
   '@esbuild/win32-ia32@0.21.5':
     optional: true
 
+  '@esbuild/win32-ia32@0.25.12':
+    optional: true
+
   '@esbuild/win32-ia32@0.27.0':
     optional: true
 
@@ -4812,6 +6202,9 @@ snapshots:
   '@esbuild/win32-x64@0.21.5':
     optional: true
 
+  '@esbuild/win32-x64@0.25.12':
+    optional: true
+
   '@esbuild/win32-x64@0.27.0':
     optional: true
 
@@ -4821,7 +6214,9 @@ snapshots:
   '@esbuild/win32-x64@0.28.0':
     optional: true
 
-  '@exodus/bytes@1.15.1': {}
+  '@exodus/bytes@1.15.1(@noble/hashes@2.2.0)':
+    optionalDependencies:
+      '@noble/hashes': 2.2.0
 
   '@floating-ui/core@1.7.5':
     dependencies:
@@ -4863,6 +6258,10 @@ snapshots:
     transitivePeerDependencies:
       - srvx
 
+  '@isaacs/fs-minipass@4.0.1':
+    dependencies:
+      minipass: 7.1.3
+
   '@jridgewell/gen-mapping@0.3.13':
     dependencies:
       '@jridgewell/sourcemap-codec': 1.5.5
@@ -4884,6 +6283,19 @@ snapshots:
 
   '@lifeomic/attempt@3.1.0': {}
 
+  '@malept/cross-spawn-promise@2.0.0':
+    dependencies:
+      cross-spawn: 7.0.6
+
+  '@malept/flatpak-bundler@0.4.0':
+    dependencies:
+      debug: 4.4.3
+      fs-extra: 9.1.0
+      lodash: 4.18.1
+      tmp-promise: 3.0.3
+    transitivePeerDependencies:
+      - supports-color
+
   '@napi-rs/wasm-runtime@1.1.4(@emnapi/core@1.10.0)(@emnapi/runtime@1.10.0)':
     dependencies:
       '@emnapi/core': 1.10.0
@@ -4891,6 +6303,10 @@ snapshots:
       '@tybys/wasm-util': 0.10.2
     optional: true
 
+  '@noble/hashes@1.4.0': {}
+
+  '@noble/hashes@2.2.0': {}
+
   '@oozcitak/dom@2.0.2':
     dependencies:
       '@oozcitak/infra': 2.0.2
@@ -4912,6 +6328,28 @@ snapshots:
 
   '@oxc-project/types@0.132.0': {}
 
+  '@peculiar/asn1-schema@2.7.0':
+    dependencies:
+      '@peculiar/utils': 2.0.3
+      asn1js: 3.0.10
+      tslib: 2.8.1
+
+  '@peculiar/json-schema@1.1.12':
+    dependencies:
+      tslib: 2.8.1
+
+  '@peculiar/utils@2.0.3':
+    dependencies:
+      tslib: 2.8.1
+
+  '@peculiar/webcrypto@1.7.1':
+    dependencies:
+      '@peculiar/asn1-schema': 2.7.0
+      '@peculiar/json-schema': 1.1.12
+      '@peculiar/utils': 2.0.3
+      tslib: 2.8.1
+      webcrypto-core: 1.9.2
+
   '@playwright/test@1.60.0':
     dependencies:
       playwright: 1.60.0
@@ -5046,8 +6484,14 @@ snapshots:
   '@rollup/rollup-win32-x64-msvc@4.60.4':
     optional: true
 
+  '@sindresorhus/is@4.6.0': {}
+
   '@standard-schema/spec@1.1.0': {}
 
+  '@szmarczak/http-timer@4.0.6':
+    dependencies:
+      defer-to-connect: 2.0.1
+
   '@tailwindcss/node@4.3.0':
     dependencies:
       '@jridgewell/remapping': 2.3.5
@@ -5317,6 +6761,31 @@ snapshots:
 
   '@tanstack/virtual-file-routes@1.162.0': {}
 
+  '@testing-library/dom@10.4.1':
+    dependencies:
+      '@babel/code-frame': 7.29.0
+      '@babel/runtime': 7.29.7
+      '@types/aria-query': 5.0.4
+      aria-query: 5.3.0
+      dom-accessibility-api: 0.5.16
+      lz-string: 1.5.0
+      picocolors: 1.1.1
+      pretty-format: 27.5.1
+
+  '@testing-library/react@16.3.2(@testing-library/dom@10.4.1)(@types/react-dom@19.2.3(@types/react@19.2.15))(@types/react@19.2.15)(react-dom@19.2.6(react@19.2.6))(react@19.2.6)':
+    dependencies:
+      '@babel/runtime': 7.29.7
+      '@testing-library/dom': 10.4.1
+      react: 19.2.6
+      react-dom: 19.2.6(react@19.2.6)
+    optionalDependencies:
+      '@types/react': 19.2.15
+      '@types/react-dom': 19.2.3(@types/react@19.2.15)
+
+  '@testing-library/user-event@14.6.1(@testing-library/dom@10.4.1)':
+    dependencies:
+      '@testing-library/dom': 10.4.1
+
   '@tiptap/core@3.23.6(@tiptap/pm@3.23.6)':
     dependencies:
       '@tiptap/pm': 3.23.6
@@ -5536,6 +7005,15 @@ snapshots:
       tslib: 2.8.1
     optional: true
 
+  '@types/aria-query@5.0.4': {}
+
+  '@types/cacheable-request@6.0.3':
+    dependencies:
+      '@types/http-cache-semantics': 4.2.0
+      '@types/keyv': 3.1.4
+      '@types/node': 22.19.19
+      '@types/responselike': 1.0.3
+
   '@types/chai@5.2.3':
     dependencies:
       '@types/deep-eql': 4.0.2
@@ -5555,10 +7033,16 @@ snapshots:
 
   '@types/estree@1.0.9': {}
 
+  '@types/fs-extra@9.0.13':
+    dependencies:
+      '@types/node': 22.19.19
+
   '@types/hast@3.0.4':
     dependencies:
       '@types/unist': 3.0.3
 
+  '@types/http-cache-semantics@4.2.0': {}
+
   '@types/js-yaml@4.0.9': {}
 
   '@types/jsdom@28.0.3':
@@ -5568,6 +7052,10 @@ snapshots:
       parse5: 8.0.1
       undici-types: 7.25.0
 
+  '@types/keyv@3.1.4':
+    dependencies:
+      '@types/node': 22.19.19
+
   '@types/mdast@4.0.4':
     dependencies:
       '@types/unist': 3.0.3
@@ -5578,6 +7066,15 @@ snapshots:
     dependencies:
       undici-types: 6.21.0
 
+  '@types/node@24.13.1':
+    dependencies:
+      undici-types: 7.18.2
+
+  '@types/node@25.9.2':
+    dependencies:
+      undici-types: 7.24.6
+    optional: true
+
   '@types/pg@8.20.0':
     dependencies:
       '@types/node': 22.19.19
@@ -5594,6 +7091,10 @@ snapshots:
     dependencies:
       csstype: 3.2.3
 
+  '@types/responselike@1.0.3':
+    dependencies:
+      '@types/node': 22.19.19
+
   '@types/tough-cookie@4.0.5': {}
 
   '@types/trusted-types@2.0.7':
@@ -5637,6 +7138,14 @@ snapshots:
     optionalDependencies:
       vite: 5.4.21(@types/node@22.19.19)(lightningcss@1.32.0)
 
+  '@vitest/mocker@2.1.9(vite@5.4.21(@types/node@25.9.2)(lightningcss@1.32.0))':
+    dependencies:
+      '@vitest/spy': 2.1.9
+      estree-walker: 3.0.3
+      magic-string: 0.30.21
+    optionalDependencies:
+      vite: 5.4.21(@types/node@25.9.2)(lightningcss@1.32.0)
+
   '@vitest/mocker@3.2.4(vite@7.3.3(@types/node@22.19.19)(jiti@2.7.0)(lightningcss@1.32.0)(tsx@4.22.3))':
     dependencies:
       '@vitest/spy': 3.2.4
@@ -5727,8 +7236,14 @@ snapshots:
       - '@workos-inc/node'
       - typescript
 
+  '@xmldom/xmldom@0.8.13': {}
+
+  abbrev@4.0.0: {}
+
   accessor-fn@1.5.3: {}
 
+  agent-base@7.1.4: {}
+
   ai@6.0.180(zod@3.25.76):
     dependencies:
       '@ai-sdk/gateway': 3.0.114(zod@3.25.76)
@@ -5737,16 +7252,83 @@ snapshots:
       '@opentelemetry/api': 1.9.1
       zod: 3.25.76
 
+  ajv@8.20.0:
+    dependencies:
+      fast-deep-equal: 3.1.3
+      fast-uri: 3.1.2
+      json-schema-traverse: 1.0.0
+      require-from-string: 2.0.2
+
   ansi-regex@5.0.1: {}
 
   ansi-styles@4.3.0:
     dependencies:
       color-convert: 2.0.1
 
+  ansi-styles@5.2.0: {}
+
   ansis@4.3.0: {}
 
+  app-builder-lib@26.15.2(dmg-builder@26.15.2)(electron-builder-squirrel-windows@26.15.2):
+    dependencies:
+      '@electron/asar': 3.4.1
+      '@electron/fuses': 1.8.0
+      '@electron/get': 3.1.0
+      '@electron/notarize': 2.5.0
+      '@electron/osx-sign': 1.3.3
+      '@electron/rebuild': 4.0.4
+      '@electron/universal': 2.0.3
+      '@malept/flatpak-bundler': 0.4.0
+      '@noble/hashes': 2.2.0
+      '@peculiar/webcrypto': 1.7.1
+      '@types/fs-extra': 9.0.13
+      ajv: 8.20.0
+      asn1js: 3.0.10
+      async-exit-hook: 2.0.1
+      builder-util: 26.15.0
+      builder-util-runtime: 9.7.0
+      chromium-pickle-js: 0.2.0
+      ci-info: 4.3.1
+      debug: 4.4.3
+      dmg-builder: 26.15.2(electron-builder-squirrel-windows@26.15.2)
+      dotenv: 16.6.1
+      dotenv-expand: 11.0.7
+      ejs: 3.1.10
+      electron-builder-squirrel-windows: 26.15.2(dmg-builder@26.15.2)
+      electron-publish: 26.15.1
+      fs-extra: 10.1.0
+      hosted-git-info: 4.1.0
+      isbinaryfile: 5.0.7
+      jiti: 2.7.0
+      js-yaml: 4.1.1
+      json5: 2.2.3
+      lazy-val: 1.0.5
+      minimatch: 10.2.5
+      pkijs: 3.4.0
+      plist: 3.1.0
+      proper-lockfile: 4.1.2
+      resedit: 1.7.2
+      semver: 7.7.4
+      tar: 7.5.16
+      temp-file: 3.4.0
+      tiny-async-pool: 1.3.0
+      unzipper: 0.12.3
+      which: 5.0.0
+    transitivePeerDependencies:
+      - supports-color
+
   argparse@2.0.1: {}
 
+  aria-query@5.3.0:
+    dependencies:
+      dequal: 2.0.3
+
+  asn1js@3.0.10:
+    dependencies:
+      pvtsutils: 1.3.6
+      pvutils: 1.1.5
+      tslib: 2.8.1
+
   assertion-error@2.0.1: {}
 
   ast-kit@2.2.0:
@@ -5756,10 +7338,20 @@ snapshots:
 
   async-channel@0.2.0: {}
 
+  async-exit-hook@2.0.1: {}
+
   async-mutex@0.5.0:
     dependencies:
       tslib: 2.8.1
 
+  async@3.2.6: {}
+
+  asynckit@0.4.0: {}
+
+  at-least-node@1.0.0: {}
+
+  aws4@1.13.2: {}
+
   babel-dead-code-elimination@1.0.12:
     dependencies:
       '@babel/core': 7.29.0
@@ -5771,6 +7363,12 @@ snapshots:
 
   bail@2.0.2: {}
 
+  balanced-match@1.0.2: {}
+
+  balanced-match@4.0.4: {}
+
+  base64-js@1.5.1: {}
+
   baseline-browser-mapping@2.10.31: {}
 
   bezier-js@6.1.4: {}
@@ -5781,8 +7379,26 @@ snapshots:
 
   birpc@2.9.0: {}
 
+  bluebird@3.7.2: {}
+
   boolbase@1.0.0: {}
 
+  boolean@3.2.0:
+    optional: true
+
+  brace-expansion@1.1.15:
+    dependencies:
+      balanced-match: 1.0.2
+      concat-map: 0.0.1
+
+  brace-expansion@2.1.1:
+    dependencies:
+      balanced-match: 1.0.2
+
+  brace-expansion@5.0.6:
+    dependencies:
+      balanced-match: 4.0.4
+
   browserslist@4.28.2:
     dependencies:
       baseline-browser-mapping: 2.10.31
@@ -5791,8 +7407,55 @@ snapshots:
       node-releases: 2.0.45
       update-browserslist-db: 1.2.3(browserslist@4.28.2)
 
+  buffer-from@1.1.2: {}
+
+  builder-util-runtime@9.7.0:
+    dependencies:
+      debug: 4.4.3
+      sax: 1.6.0
+    transitivePeerDependencies:
+      - supports-color
+
+  builder-util@26.15.0:
+    dependencies:
+      '@types/debug': 4.1.13
+      builder-util-runtime: 9.7.0
+      chalk: 4.1.2
+      cross-spawn: 7.0.6
+      debug: 4.4.3
+      fs-extra: 10.1.0
+      http-proxy-agent: 7.0.2
+      https-proxy-agent: 7.0.6
+      js-yaml: 4.1.1
+      sanitize-filename: 1.6.4
+      source-map-support: 0.5.21
+      stat-mode: 1.0.0
+      temp-file: 3.4.0
+      tiny-async-pool: 1.3.0
+    transitivePeerDependencies:
+      - supports-color
+
+  bytestreamjs@2.0.1: {}
+
   cac@6.7.14: {}
 
+  cacheable-lookup@5.0.4: {}
+
+  cacheable-request@7.0.4:
+    dependencies:
+      clone-response: 1.0.3
+      get-stream: 5.2.0
+      http-cache-semantics: 4.2.0
+      keyv: 4.5.4
+      lowercase-keys: 2.0.0
+      normalize-url: 6.1.0
+      responselike: 2.0.1
+
+  call-bind-apply-helpers@1.0.2:
+    dependencies:
+      es-errors: 1.3.0
+      function-bind: 1.1.2
+
   caniuse-lite@1.0.30001793: {}
 
   canvas-color-tracker@1.3.2:
@@ -5855,20 +7518,45 @@ snapshots:
     dependencies:
       readdirp: 5.0.0
 
+  chownr@3.0.0: {}
+
+  chromium-pickle-js@0.2.0: {}
+
+  ci-info@4.3.1: {}
+
+  ci-info@4.4.0: {}
+
   cliui@8.0.1:
     dependencies:
       string-width: 4.2.3
       strip-ansi: 6.0.1
       wrap-ansi: 7.0.0
 
+  clone-response@1.0.3:
+    dependencies:
+      mimic-response: 1.0.1
+
   color-convert@2.0.1:
     dependencies:
       color-name: 1.1.4
 
   color-name@1.1.4: {}
 
+  combined-stream@1.0.8:
+    dependencies:
+      delayed-stream: 1.0.0
+
   comma-separated-tokens@2.0.3: {}
 
+  commander@5.1.0: {}
+
+  commander@9.5.0:
+    optional: true
+
+  compare-version@0.1.2: {}
+
+  concat-map@0.0.1: {}
+
   concurrently@9.2.1:
     dependencies:
       chalk: 4.1.2
@@ -5908,6 +7596,17 @@ snapshots:
 
   cookie-es@3.1.1: {}
 
+  core-util-is@1.0.3: {}
+
+  cross-dirname@0.1.0:
+    optional: true
+
+  cross-spawn@7.0.6:
+    dependencies:
+      path-key: 3.1.1
+      shebang-command: 2.0.0
+      which: 2.0.2
+
   crossws@0.4.5(srvx@0.11.15):
     optionalDependencies:
       srvx: 0.11.15
@@ -6006,10 +7705,10 @@ snapshots:
       d3-selection: 3.0.0
       d3-transition: 3.0.1(d3-selection@3.0.0)
 
-  data-urls@7.0.0:
+  data-urls@7.0.0(@noble/hashes@2.2.0):
     dependencies:
       whatwg-mimetype: 5.0.0
-      whatwg-url: 16.0.1
+      whatwg-url: 16.0.1(@noble/hashes@2.2.0)
     transitivePeerDependencies:
       - '@noble/hashes'
 
@@ -6027,20 +7726,62 @@ snapshots:
     dependencies:
       character-entities: 2.0.2
 
+  decompress-response@6.0.0:
+    dependencies:
+      mimic-response: 3.1.0
+
   deep-eql@5.0.2: {}
 
+  defer-to-connect@2.0.1: {}
+
+  define-data-property@1.1.4:
+    dependencies:
+      es-define-property: 1.0.1
+      es-errors: 1.3.0
+      gopd: 1.2.0
+    optional: true
+
+  define-properties@1.2.1:
+    dependencies:
+      define-data-property: 1.1.4
+      has-property-descriptors: 1.0.2
+      object-keys: 1.1.1
+    optional: true
+
   defu@6.1.7: {}
 
+  delayed-stream@1.0.0: {}
+
   dequal@2.0.3: {}
 
   detect-libc@2.1.2: {}
 
+  detect-node@2.1.0:
+    optional: true
+
   devlop@1.1.0:
     dependencies:
       dequal: 2.0.3
 
   diff@8.0.4: {}
 
+  dir-compare@4.2.0:
+    dependencies:
+      minimatch: 3.1.5
+      p-limit: 3.1.0
+
+  dmg-builder@26.15.2(electron-builder-squirrel-windows@26.15.2):
+    dependencies:
+      app-builder-lib: 26.15.2(dmg-builder@26.15.2)(electron-builder-squirrel-windows@26.15.2)
+      builder-util: 26.15.0
+      fs-extra: 10.1.0
+      js-yaml: 4.1.1
+    transitivePeerDependencies:
+      - electron-builder-squirrel-windows
+      - supports-color
+
+  dom-accessibility-api@0.5.16: {}
+
   dom-serializer@2.0.0:
     dependencies:
       domelementtype: 2.3.0
@@ -6063,6 +7804,12 @@ snapshots:
       domelementtype: 2.3.0
       domhandler: 5.0.3
 
+  dotenv-expand@11.0.7:
+    dependencies:
+      dotenv: 16.6.1
+
+  dotenv@16.6.1: {}
+
   drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0):
     optionalDependencies:
       '@opentelemetry/api': 1.9.1
@@ -6071,8 +7818,106 @@ snapshots:
 
   dts-resolver@2.1.3: {}
 
+  dunder-proto@1.0.1:
+    dependencies:
+      call-bind-apply-helpers: 1.0.2
+      es-errors: 1.3.0
+      gopd: 1.2.0
+
+  duplexer2@0.1.4:
+    dependencies:
+      readable-stream: 2.3.8
+
+  ejs@3.1.10:
+    dependencies:
+      jake: 10.9.4
+
+  electron-builder-squirrel-windows@26.15.2(dmg-builder@26.15.2):
+    dependencies:
+      app-builder-lib: 26.15.2(dmg-builder@26.15.2)(electron-builder-squirrel-windows@26.15.2)
+      builder-util: 26.15.0
+      electron-winstaller: 5.4.0
+    transitivePeerDependencies:
+      - dmg-builder
+      - supports-color
+
+  electron-builder@26.15.2(electron-builder-squirrel-windows@26.15.2):
+    dependencies:
+      app-builder-lib: 26.15.2(dmg-builder@26.15.2)(electron-builder-squirrel-windows@26.15.2)
+      builder-util: 26.15.0
+      builder-util-runtime: 9.7.0
+      chalk: 4.1.2
+      ci-info: 4.4.0
+      dmg-builder: 26.15.2(electron-builder-squirrel-windows@26.15.2)
+      fs-extra: 10.1.0
+      lazy-val: 1.0.5
+      simple-update-notifier: 2.0.0
+      yargs: 17.7.2
+    transitivePeerDependencies:
+      - electron-builder-squirrel-windows
+      - supports-color
+
+  electron-publish@26.15.1:
+    dependencies:
+      '@types/fs-extra': 9.0.13
+      aws4: 1.13.2
+      builder-util: 26.15.0
+      builder-util-runtime: 9.7.0
+      chalk: 4.1.2
+      form-data: 4.0.5
+      fs-extra: 10.1.0
+      lazy-val: 1.0.5
+      mime: 2.6.0
+    transitivePeerDependencies:
+      - supports-color
+
   electron-to-chromium@1.5.360: {}
 
+  electron-updater@6.8.9:
+    dependencies:
+      builder-util-runtime: 9.7.0
+      fs-extra: 10.1.0
+      js-yaml: 4.1.1
+      lazy-val: 1.0.5
+      lodash.escaperegexp: 4.1.2
+      lodash.isequal: 4.5.0
+      semver: 7.7.4
+      tiny-typed-emitter: 2.1.0
+    transitivePeerDependencies:
+      - supports-color
+
+  electron-vite@5.0.0(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)):
+    dependencies:
+      '@babel/core': 7.29.0
+      '@babel/plugin-transform-arrow-functions': 7.29.7(@babel/core@7.29.0)
+      cac: 6.7.14
+      esbuild: 0.25.12
+      magic-string: 0.30.21
+      picocolors: 1.1.1
+      vite: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
+    transitivePeerDependencies:
+      - supports-color
+
+  electron-winstaller@5.4.0:
+    dependencies:
+      '@electron/asar': 3.4.1
+      debug: 4.4.3
+      fs-extra: 7.0.1
+      lodash: 4.18.1
+      temp: 0.9.4
+    optionalDependencies:
+      '@electron/windows-sign': 1.2.2
+    transitivePeerDependencies:
+      - supports-color
+
+  electron@42.4.0:
+    dependencies:
+      '@electron-internal/extract-zip': 1.0.2
+      '@electron/get': 5.0.0
+      '@types/node': 24.13.1
+    transitivePeerDependencies:
+      - supports-color
+
   emoji-mart@5.6.0: {}
 
   emoji-regex@8.0.0: {}
@@ -6084,6 +7929,10 @@ snapshots:
       iconv-lite: 0.6.3
       whatwg-encoding: 3.1.1
 
+  end-of-stream@1.4.5:
+    dependencies:
+      once: 1.4.0
+
   enhanced-resolve@5.21.6:
     dependencies:
       graceful-fs: 4.2.11
@@ -6097,6 +7946,10 @@ snapshots:
 
   entities@8.0.0: {}
 
+  env-paths@2.2.1: {}
+
+  env-paths@3.0.0: {}
+
   env-runner@0.1.7:
     dependencies:
       crossws: 0.4.5(srvx@0.11.15)
@@ -6104,8 +7957,28 @@ snapshots:
       httpxy: 0.5.3
       srvx: 0.11.15
 
+  err-code@2.0.3: {}
+
+  es-define-property@1.0.1: {}
+
+  es-errors@1.3.0: {}
+
   es-module-lexer@1.7.0: {}
 
+  es-object-atoms@1.1.2:
+    dependencies:
+      es-errors: 1.3.0
+
+  es-set-tostringtag@2.1.0:
+    dependencies:
+      es-errors: 1.3.0
+      get-intrinsic: 1.3.0
+      has-tostringtag: 1.0.2
+      hasown: 2.0.4
+
+  es6-error@4.1.1:
+    optional: true
+
   esbuild@0.21.5:
     optionalDependencies:
       '@esbuild/aix-ppc64': 0.21.5
@@ -6132,6 +8005,35 @@ snapshots:
       '@esbuild/win32-ia32': 0.21.5
       '@esbuild/win32-x64': 0.21.5
 
+  esbuild@0.25.12:
+    optionalDependencies:
+      '@esbuild/aix-ppc64': 0.25.12
+      '@esbuild/android-arm': 0.25.12
+      '@esbuild/android-arm64': 0.25.12
+      '@esbuild/android-x64': 0.25.12
+      '@esbuild/darwin-arm64': 0.25.12
+      '@esbuild/darwin-x64': 0.25.12
+      '@esbuild/freebsd-arm64': 0.25.12
+      '@esbuild/freebsd-x64': 0.25.12
+      '@esbuild/linux-arm': 0.25.12
+      '@esbuild/linux-arm64': 0.25.12
+      '@esbuild/linux-ia32': 0.25.12
+      '@esbuild/linux-loong64': 0.25.12
+      '@esbuild/linux-mips64el': 0.25.12
+      '@esbuild/linux-ppc64': 0.25.12
+      '@esbuild/linux-riscv64': 0.25.12
+      '@esbuild/linux-s390x': 0.25.12
+      '@esbuild/linux-x64': 0.25.12
+      '@esbuild/netbsd-arm64': 0.25.12
+      '@esbuild/netbsd-x64': 0.25.12
+      '@esbuild/openbsd-arm64': 0.25.12
+      '@esbuild/openbsd-x64': 0.25.12
+      '@esbuild/openharmony-arm64': 0.25.12
+      '@esbuild/sunos-x64': 0.25.12
+      '@esbuild/win32-arm64': 0.25.12
+      '@esbuild/win32-ia32': 0.25.12
+      '@esbuild/win32-x64': 0.25.12
+
   esbuild@0.27.0:
     optionalDependencies:
       '@esbuild/aix-ppc64': 0.27.0
@@ -6221,6 +8123,9 @@ snapshots:
 
   escalade@3.2.0: {}
 
+  escape-string-regexp@4.0.0:
+    optional: true
+
   escape-string-regexp@5.0.0: {}
 
   estree-util-is-identifier-name@3.0.0: {}
@@ -6235,18 +8140,28 @@ snapshots:
 
   expect-type@1.3.0: {}
 
+  exponential-backoff@3.1.3: {}
+
   exsolve@1.0.8: {}
 
   extend@3.0.2: {}
 
+  fast-deep-equal@3.1.3: {}
+
   fast-equals@5.4.0: {}
 
+  fast-uri@3.1.2: {}
+
   fdir@6.5.0(picomatch@4.0.4):
     optionalDependencies:
       picomatch: 4.0.4
 
   fetchdts@0.1.7: {}
 
+  filelist@1.0.6:
+    dependencies:
+      minimatch: 5.1.9
+
   float-tooltip@1.7.5:
     dependencies:
       d3-selection: 3.0.0
@@ -6271,20 +8186,126 @@ snapshots:
       kapsule: 1.16.3
       lodash-es: 4.18.1
 
+  form-data@4.0.5:
+    dependencies:
+      asynckit: 0.4.0
+      combined-stream: 1.0.8
+      es-set-tostringtag: 2.1.0
+      hasown: 2.0.4
+      mime-types: 2.1.35
+
+  fs-extra@10.1.0:
+    dependencies:
+      graceful-fs: 4.2.11
+      jsonfile: 6.2.1
+      universalify: 2.0.1
+
+  fs-extra@11.3.5:
+    dependencies:
+      graceful-fs: 4.2.11
+      jsonfile: 6.2.1
+      universalify: 2.0.1
+
+  fs-extra@7.0.1:
+    dependencies:
+      graceful-fs: 4.2.11
+      jsonfile: 4.0.0
+      universalify: 0.1.2
+
+  fs-extra@8.1.0:
+    dependencies:
+      graceful-fs: 4.2.11
+      jsonfile: 4.0.0
+      universalify: 0.1.2
+
+  fs-extra@9.1.0:
+    dependencies:
+      at-least-node: 1.0.0
+      graceful-fs: 4.2.11
+      jsonfile: 6.2.1
+      universalify: 2.0.1
+
+  fs.realpath@1.0.0: {}
+
   fsevents@2.3.2:
     optional: true
 
   fsevents@2.3.3:
     optional: true
 
+  function-bind@1.1.2: {}
+
   gensync@1.0.0-beta.2: {}
 
   get-caller-file@2.0.5: {}
 
+  get-intrinsic@1.3.0:
+    dependencies:
+      call-bind-apply-helpers: 1.0.2
+      es-define-property: 1.0.1
+      es-errors: 1.3.0
+      es-object-atoms: 1.1.2
+      function-bind: 1.1.2
+      get-proto: 1.0.1
+      gopd: 1.2.0
+      has-symbols: 1.1.0
+      hasown: 2.0.4
+      math-intrinsics: 1.1.0
+
+  get-proto@1.0.1:
+    dependencies:
+      dunder-proto: 1.0.1
+      es-object-atoms: 1.1.2
+
+  get-stream@5.2.0:
+    dependencies:
+      pump: 3.0.4
+
   get-tsconfig@4.14.0:
     dependencies:
       resolve-pkg-maps: 1.0.0
 
+  glob@7.2.3:
+    dependencies:
+      fs.realpath: 1.0.0
+      inflight: 1.0.6
+      inherits: 2.0.4
+      minimatch: 3.1.5
+      once: 1.4.0
+      path-is-absolute: 1.0.1
+
+  global-agent@3.0.0:
+    dependencies:
+      boolean: 3.2.0
+      es6-error: 4.1.1
+      matcher: 3.0.0
+      roarr: 2.15.4
+      semver: 7.8.1
+      serialize-error: 7.0.1
+    optional: true
+
+  globalthis@1.0.4:
+    dependencies:
+      define-properties: 1.2.1
+      gopd: 1.2.0
+    optional: true
+
+  gopd@1.2.0: {}
+
+  got@11.8.6:
+    dependencies:
+      '@sindresorhus/is': 4.6.0
+      '@szmarczak/http-timer': 4.0.6
+      '@types/cacheable-request': 6.0.3
+      '@types/responselike': 1.0.3
+      cacheable-lookup: 5.0.4
+      cacheable-request: 7.0.4
+      decompress-response: 6.0.0
+      http2-wrapper: 1.0.3
+      lowercase-keys: 2.0.0
+      p-cancelable: 2.1.1
+      responselike: 2.0.1
+
   graceful-fs@4.2.11: {}
 
   h3@2.0.1-rc.20(crossws@0.4.5(srvx@0.11.15)):
@@ -6303,6 +8324,21 @@ snapshots:
 
   has-flag@4.0.0: {}
 
+  has-property-descriptors@1.0.2:
+    dependencies:
+      es-define-property: 1.0.1
+    optional: true
+
+  has-symbols@1.1.0: {}
+
+  has-tostringtag@1.0.2:
+    dependencies:
+      has-symbols: 1.1.0
+
+  hasown@2.0.4:
+    dependencies:
+      function-bind: 1.1.2
+
   hast-util-to-jsx-runtime@2.3.6:
     dependencies:
       '@types/estree': 1.0.9
@@ -6333,9 +8369,13 @@ snapshots:
 
   hookable@6.1.1: {}
 
-  html-encoding-sniffer@6.0.0:
+  hosted-git-info@4.1.0:
     dependencies:
-      '@exodus/bytes': 1.15.1
+      lru-cache: 6.0.0
+
+  html-encoding-sniffer@6.0.0(@noble/hashes@2.2.0):
+    dependencies:
+      '@exodus/bytes': 1.15.1(@noble/hashes@2.2.0)
     transitivePeerDependencies:
       - '@noble/hashes'
 
@@ -6348,6 +8388,27 @@ snapshots:
       domutils: 3.2.2
       entities: 7.0.1
 
+  http-cache-semantics@4.2.0: {}
+
+  http-proxy-agent@7.0.2:
+    dependencies:
+      agent-base: 7.1.4
+      debug: 4.4.3
+    transitivePeerDependencies:
+      - supports-color
+
+  http2-wrapper@1.0.3:
+    dependencies:
+      quick-lru: 5.1.1
+      resolve-alpn: 1.2.1
+
+  https-proxy-agent@7.0.6:
+    dependencies:
+      agent-base: 7.1.4
+      debug: 4.4.3
+    transitivePeerDependencies:
+      - supports-color
+
   httpxy@0.5.3: {}
 
   iconv-lite@0.6.3:
@@ -6356,6 +8417,13 @@ snapshots:
 
   index-array-by@1.4.2: {}
 
+  inflight@1.0.6:
+    dependencies:
+      once: 1.4.0
+      wrappy: 1.0.2
+
+  inherits@2.0.4: {}
+
   inline-style-parser@0.2.7: {}
 
   internmap@2.0.3: {}
@@ -6381,18 +8449,36 @@ snapshots:
 
   is-potential-custom-element-name@1.0.1: {}
 
+  isarray@1.0.0: {}
+
+  isbinaryfile@4.0.10: {}
+
+  isbinaryfile@5.0.7: {}
+
   isbot@5.1.40: {}
 
-  isomorphic-dompurify@3.14.0:
+  isexe@2.0.0: {}
+
+  isexe@3.1.5: {}
+
+  isexe@4.0.0: {}
+
+  isomorphic-dompurify@3.14.0(@noble/hashes@2.2.0):
     dependencies:
       dompurify: 3.4.5
-      jsdom: 29.1.1
+      jsdom: 29.1.1(@noble/hashes@2.2.0)
     transitivePeerDependencies:
       - '@noble/hashes'
       - canvas
 
   isomorphic.js@0.2.5: {}
 
+  jake@10.9.4:
+    dependencies:
+      async: 3.2.6
+      filelist: 1.0.6
+      picocolors: 1.1.1
+
   jerrypick@1.1.2: {}
 
   jiti@2.7.0: {}
@@ -6407,17 +8493,17 @@ snapshots:
     dependencies:
       argparse: 2.0.1
 
-  jsdom@29.1.1:
+  jsdom@29.1.1(@noble/hashes@2.2.0):
     dependencies:
       '@asamuzakjp/css-color': 5.1.11
       '@asamuzakjp/dom-selector': 7.1.1
       '@bramus/specificity': 2.4.2
       '@csstools/css-syntax-patches-for-csstree': 1.1.4(css-tree@3.2.1)
-      '@exodus/bytes': 1.15.1
+      '@exodus/bytes': 1.15.1(@noble/hashes@2.2.0)
       css-tree: 3.2.1
-      data-urls: 7.0.0
+      data-urls: 7.0.0(@noble/hashes@2.2.0)
       decimal.js: 10.6.0
-      html-encoding-sniffer: 6.0.0
+      html-encoding-sniffer: 6.0.0(@noble/hashes@2.2.0)
       is-potential-custom-element-name: 1.0.1
       lru-cache: 11.5.0
       parse5: 8.0.1
@@ -6428,23 +8514,46 @@ snapshots:
       w3c-xmlserializer: 5.0.0
       webidl-conversions: 8.0.1
       whatwg-mimetype: 5.0.0
-      whatwg-url: 16.0.1
+      whatwg-url: 16.0.1(@noble/hashes@2.2.0)
       xml-name-validator: 5.0.0
     transitivePeerDependencies:
       - '@noble/hashes'
 
   jsesc@3.1.0: {}
 
+  json-buffer@3.0.1: {}
+
+  json-schema-traverse@1.0.0: {}
+
   json-schema@0.4.0: {}
 
+  json-stringify-safe@5.0.1:
+    optional: true
+
   json5@2.2.3: {}
 
+  jsonfile@4.0.0:
+    optionalDependencies:
+      graceful-fs: 4.2.11
+
+  jsonfile@6.2.1:
+    dependencies:
+      universalify: 2.0.1
+    optionalDependencies:
+      graceful-fs: 4.2.11
+
   kapsule@1.16.3:
     dependencies:
       lodash-es: 4.18.1
 
+  keyv@4.5.4:
+    dependencies:
+      json-buffer: 3.0.1
+
   kleur@4.1.5: {}
 
+  lazy-val@1.0.5: {}
+
   lib0@0.2.117:
     dependencies:
       isomorphic.js: 0.2.5
@@ -6502,6 +8611,12 @@ snapshots:
 
   lodash-es@4.18.1: {}
 
+  lodash.escaperegexp@4.1.2: {}
+
+  lodash.isequal@4.5.0: {}
+
+  lodash@4.18.1: {}
+
   longest-streak@3.1.0: {}
 
   loose-envify@1.4.0:
@@ -6510,6 +8625,8 @@ snapshots:
 
   loupe@3.2.1: {}
 
+  lowercase-keys@2.0.0: {}
+
   lowlight@3.3.0:
     dependencies:
       '@types/hast': 3.0.4
@@ -6522,10 +8639,16 @@ snapshots:
     dependencies:
       yallist: 3.1.1
 
+  lru-cache@6.0.0:
+    dependencies:
+      yallist: 4.0.0
+
   lucide-react@1.16.0(react@19.2.6):
     dependencies:
       react: 19.2.6
 
+  lz-string@1.5.0: {}
+
   magic-string@0.30.21:
     dependencies:
       '@jridgewell/sourcemap-codec': 1.5.5
@@ -6534,6 +8657,13 @@ snapshots:
 
   marked@17.0.6: {}
 
+  matcher@3.0.0:
+    dependencies:
+      escape-string-regexp: 4.0.0
+    optional: true
+
+  math-intrinsics@1.1.0: {}
+
   mdast-util-find-and-replace@3.0.2:
     dependencies:
       '@types/mdast': 4.0.4
@@ -6880,13 +9010,53 @@ snapshots:
     transitivePeerDependencies:
       - supports-color
 
+  mime-db@1.52.0: {}
+
+  mime-types@2.1.35:
+    dependencies:
+      mime-db: 1.52.0
+
+  mime@2.6.0: {}
+
+  mimic-response@1.0.1: {}
+
+  mimic-response@3.1.0: {}
+
+  minimatch@10.2.5:
+    dependencies:
+      brace-expansion: 5.0.6
+
+  minimatch@3.1.5:
+    dependencies:
+      brace-expansion: 1.1.15
+
+  minimatch@5.1.9:
+    dependencies:
+      brace-expansion: 2.1.1
+
+  minimatch@9.0.9:
+    dependencies:
+      brace-expansion: 2.1.1
+
+  minimist@1.2.8: {}
+
+  minipass@7.1.3: {}
+
+  minizlib@3.1.0:
+    dependencies:
+      minipass: 7.1.3
+
+  mkdirp@0.5.6:
+    dependencies:
+      minimist: 1.2.8
+
   ms@2.1.3: {}
 
   nanoid@3.3.12: {}
 
   nf3@0.3.17: {}
 
-  nitro@3.0.260429-beta(chokidar@5.0.0)(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0))(jiti@2.7.0)(lru-cache@11.5.0)(rollup@4.60.4)(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)):
+  nitro@3.0.260429-beta(chokidar@5.0.0)(dotenv@16.6.1)(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0))(jiti@2.7.0)(lru-cache@11.5.0)(rollup@4.60.4)(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)):
     dependencies:
       consola: 3.4.2
       crossws: 0.4.5(srvx@0.11.15)
@@ -6903,6 +9073,7 @@ snapshots:
       unenv: 2.0.0-rc.24
       unstorage: 2.0.0-alpha.7(chokidar@5.0.0)(db0@0.3.4(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0)))(lru-cache@11.5.0)(ofetch@2.0.0-alpha.3)
     optionalDependencies:
+      dotenv: 16.6.1
       jiti: 2.7.0
       rollup: 4.60.4
       vite: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
@@ -6937,14 +9108,46 @@ snapshots:
       - sqlite3
       - uploadthing
 
+  node-abi@4.31.0:
+    dependencies:
+      semver: 7.8.1
+
+  node-api-version@0.2.1:
+    dependencies:
+      semver: 7.8.1
+
+  node-gyp@12.4.0:
+    dependencies:
+      env-paths: 2.2.1
+      exponential-backoff: 3.1.3
+      graceful-fs: 4.2.11
+      nopt: 9.0.0
+      proc-log: 6.1.0
+      semver: 7.8.1
+      tar: 7.5.16
+      tinyglobby: 0.2.16
+      undici: 6.26.0
+      which: 6.0.1
+
+  node-int64@0.4.0: {}
+
   node-releases@2.0.45: {}
 
+  nopt@9.0.0:
+    dependencies:
+      abbrev: 4.0.0
+
+  normalize-url@6.1.0: {}
+
   nth-check@2.1.1:
     dependencies:
       boolbase: 1.0.0
 
   object-assign@4.1.1: {}
 
+  object-keys@1.1.1:
+    optional: true
+
   ocache@0.1.4:
     dependencies:
       ohash: 2.0.11
@@ -6953,8 +9156,18 @@ snapshots:
 
   ohash@2.0.11: {}
 
+  once@1.4.0:
+    dependencies:
+      wrappy: 1.0.2
+
   orderedmap@2.1.1: {}
 
+  p-cancelable@2.1.1: {}
+
+  p-limit@3.1.0:
+    dependencies:
+      yocto-queue: 0.1.0
+
   parse-entities@4.0.2:
     dependencies:
       '@types/unist': 2.0.11
@@ -6982,12 +9195,18 @@ snapshots:
     dependencies:
       entities: 8.0.0
 
+  path-is-absolute@1.0.1: {}
+
+  path-key@3.1.1: {}
+
   pathe@1.1.2: {}
 
   pathe@2.0.3: {}
 
   pathval@2.0.1: {}
 
+  pe-library@0.4.1: {}
+
   pg-cloudflare@1.4.0:
     optional: true
 
@@ -7027,6 +9246,15 @@ snapshots:
 
   picomatch@4.0.4: {}
 
+  pkijs@3.4.0:
+    dependencies:
+      '@noble/hashes': 1.4.0
+      asn1js: 3.0.10
+      bytestreamjs: 2.0.1
+      pvtsutils: 1.3.6
+      pvutils: 1.1.5
+      tslib: 2.8.1
+
   playwright-core@1.60.0: {}
 
   playwright@1.60.0:
@@ -7035,6 +9263,12 @@ snapshots:
     optionalDependencies:
       fsevents: 2.3.2
 
+  plist@3.1.0:
+    dependencies:
+      '@xmldom/xmldom': 0.8.13
+      base64-js: 1.5.1
+      xmlbuilder: 15.1.1
+
   postcss@8.5.15:
     dependencies:
       nanoid: 3.3.12
@@ -7051,18 +9285,46 @@ snapshots:
     dependencies:
       xtend: 4.0.2
 
+  postject@1.0.0-alpha.6:
+    dependencies:
+      commander: 9.5.0
+    optional: true
+
   preact@10.29.2: {}
 
   prettier@3.8.3: {}
 
+  pretty-format@27.5.1:
+    dependencies:
+      ansi-regex: 5.0.1
+      ansi-styles: 5.2.0
+      react-is: 17.0.2
+
   prismjs@1.30.0: {}
 
+  proc-log@6.1.0: {}
+
+  process-nextick-args@2.0.1: {}
+
+  progress@2.0.3: {}
+
+  promise-retry@2.0.1:
+    dependencies:
+      err-code: 2.0.3
+      retry: 0.12.0
+
   prop-types@15.8.1:
     dependencies:
       loose-envify: 1.4.0
       object-assign: 4.1.1
       react-is: 16.13.1
 
+  proper-lockfile@4.1.2:
+    dependencies:
+      graceful-fs: 4.2.11
+      retry: 0.12.0
+      signal-exit: 3.0.7
+
   property-information@7.1.0: {}
 
   prosemirror-changeset@2.4.1:
@@ -7134,10 +9396,23 @@ snapshots:
       prosemirror-state: 1.4.4
       prosemirror-transform: 1.12.0
 
+  pump@3.0.4:
+    dependencies:
+      end-of-stream: 1.4.5
+      once: 1.4.0
+
   punycode@2.3.1: {}
 
+  pvtsutils@1.3.6:
+    dependencies:
+      tslib: 2.8.1
+
+  pvutils@1.1.5: {}
+
   quansync@1.0.0: {}
 
+  quick-lru@5.1.1: {}
+
   react-dom@19.2.6(react@19.2.6):
     dependencies:
       react: 19.2.6
@@ -7152,6 +9427,8 @@ snapshots:
 
   react-is@16.13.1: {}
 
+  react-is@17.0.2: {}
+
   react-kapsule@2.5.7(react@19.2.6):
     dependencies:
       jerrypick: 1.1.2
@@ -7182,6 +9459,22 @@ snapshots:
 
   react@19.2.6: {}
 
+  read-binary-file-arch@1.0.6:
+    dependencies:
+      debug: 4.4.3
+    transitivePeerDependencies:
+      - supports-color
+
+  readable-stream@2.3.8:
+    dependencies:
+      core-util-is: 1.0.3
+      inherits: 2.0.4
+      isarray: 1.0.0
+      process-nextick-args: 2.0.1
+      safe-buffer: 5.1.2
+      string_decoder: 1.1.1
+      util-deprecate: 1.0.2
+
   readdirp@4.1.2: {}
 
   readdirp@5.0.0: {}
@@ -7224,8 +9517,34 @@ snapshots:
 
   require-from-string@2.0.2: {}
 
+  resedit@1.7.2:
+    dependencies:
+      pe-library: 0.4.1
+
+  resolve-alpn@1.2.1: {}
+
   resolve-pkg-maps@1.0.0: {}
 
+  responselike@2.0.1:
+    dependencies:
+      lowercase-keys: 2.0.0
+
+  retry@0.12.0: {}
+
+  rimraf@2.6.3:
+    dependencies:
+      glob: 7.2.3
+
+  roarr@2.15.4:
+    dependencies:
+      boolean: 3.2.0
+      detect-node: 2.1.0
+      globalthis: 1.0.4
+      json-stringify-safe: 5.0.1
+      semver-compare: 1.0.0
+      sprintf-js: 1.1.3
+    optional: true
+
   rolldown-plugin-dts@0.13.14(rolldown@1.0.2)(typescript@5.9.3):
     dependencies:
       '@babel/generator': 7.29.1
@@ -7303,40 +9622,84 @@ snapshots:
     dependencies:
       tslib: 2.8.1
 
+  safe-buffer@5.1.2: {}
+
   safer-buffer@2.1.2: {}
 
+  sanitize-filename@1.6.4:
+    dependencies:
+      truncate-utf8-bytes: 1.0.2
+
+  sax@1.6.0: {}
+
   saxes@6.0.0:
     dependencies:
       xmlchars: 2.2.0
 
   scheduler@0.27.0: {}
 
+  semver-compare@1.0.0:
+    optional: true
+
+  semver@5.7.2: {}
+
   semver@6.3.1: {}
 
+  semver@7.7.4: {}
+
   semver@7.8.1: {}
 
+  serialize-error@7.0.1:
+    dependencies:
+      type-fest: 0.13.1
+    optional: true
+
   seroval-plugins@1.5.4(seroval@1.5.4):
     dependencies:
       seroval: 1.5.4
 
   seroval@1.5.4: {}
 
+  shebang-command@2.0.0:
+    dependencies:
+      shebang-regex: 3.0.0
+
+  shebang-regex@3.0.0: {}
+
   shell-quote@1.8.3: {}
 
   siginfo@2.0.0: {}
 
+  signal-exit@3.0.7: {}
+
+  simple-update-notifier@2.0.0:
+    dependencies:
+      semver: 7.8.1
+
   source-map-js@1.2.1: {}
 
+  source-map-support@0.5.21:
+    dependencies:
+      buffer-from: 1.1.2
+      source-map: 0.6.1
+
+  source-map@0.6.1: {}
+
   source-map@0.7.6: {}
 
   space-separated-tokens@2.0.2: {}
 
   split2@4.2.0: {}
 
+  sprintf-js@1.1.3:
+    optional: true
+
   srvx@0.11.15: {}
 
   stackback@0.0.2: {}
 
+  stat-mode@1.0.0: {}
+
   std-env@3.10.0: {}
 
   string-width@4.2.3:
@@ -7345,6 +9708,10 @@ snapshots:
       is-fullwidth-code-point: 3.0.0
       strip-ansi: 6.0.1
 
+  string_decoder@1.1.1:
+    dependencies:
+      safe-buffer: 5.1.2
+
   stringify-entities@4.0.4:
     dependencies:
       character-entities-html4: 2.1.0
@@ -7366,6 +9733,12 @@ snapshots:
     dependencies:
       inline-style-parser: 0.2.7
 
+  sumchecker@3.0.1:
+    dependencies:
+      debug: 4.4.3
+    transitivePeerDependencies:
+      - supports-color
+
   supports-color@7.2.0:
     dependencies:
       has-flag: 4.0.0
@@ -7382,6 +9755,30 @@ snapshots:
 
   tapable@2.3.3: {}
 
+  tar@7.5.16:
+    dependencies:
+      '@isaacs/fs-minipass': 4.0.1
+      chownr: 3.0.0
+      minipass: 7.1.3
+      minizlib: 3.1.0
+      yallist: 5.0.0
+
+  temp-file@3.4.0:
+    dependencies:
+      async-exit-hook: 2.0.1
+      fs-extra: 10.1.0
+
+  temp@0.9.4:
+    dependencies:
+      mkdirp: 0.5.6
+      rimraf: 2.6.3
+
+  tiny-async-pool@1.3.0:
+    dependencies:
+      semver: 5.7.2
+
+  tiny-typed-emitter@2.1.0: {}
+
   tinybench@2.9.0: {}
 
   tinycolor2@1.6.0: {}
@@ -7411,6 +9808,12 @@ snapshots:
     dependencies:
       tldts-core: 7.0.30
 
+  tmp-promise@3.0.3:
+    dependencies:
+      tmp: 0.2.7
+
+  tmp@0.2.7: {}
+
   tough-cookie@6.0.1:
     dependencies:
       tldts: 7.0.30
@@ -7425,6 +9828,10 @@ snapshots:
 
   trough@2.2.0: {}
 
+  truncate-utf8-bytes@1.0.2:
+    dependencies:
+      utf8-byte-length: 1.0.5
+
   tsdown@0.12.9(typescript@5.9.3):
     dependencies:
       ansis: 4.3.0
@@ -7456,6 +9863,9 @@ snapshots:
     optionalDependencies:
       fsevents: 2.3.3
 
+  type-fest@0.13.1:
+    optional: true
+
   type-fest@5.6.0:
     dependencies:
       tagged-tag: 1.0.0
@@ -7481,8 +9891,15 @@ snapshots:
 
   undici-types@6.21.0: {}
 
+  undici-types@7.18.2: {}
+
+  undici-types@7.24.6:
+    optional: true
+
   undici-types@7.25.0: {}
 
+  undici@6.26.0: {}
+
   undici@7.25.0: {}
 
   unenv@2.0.0-rc.24:
@@ -7522,6 +9939,10 @@ snapshots:
       unist-util-is: 6.0.1
       unist-util-visit-parents: 6.0.2
 
+  universalify@0.1.2: {}
+
+  universalify@2.0.1: {}
+
   unplugin@3.0.0:
     dependencies:
       '@jridgewell/remapping': 2.3.5
@@ -7535,6 +9956,14 @@ snapshots:
       lru-cache: 11.5.0
       ofetch: 2.0.0-alpha.3
 
+  unzipper@0.12.3:
+    dependencies:
+      bluebird: 3.7.2
+      duplexer2: 0.1.4
+      fs-extra: 11.3.5
+      graceful-fs: 4.2.11
+      node-int64: 0.4.0
+
   update-browserslist-db@1.2.3(browserslist@4.28.2):
     dependencies:
       browserslist: 4.28.2
@@ -7545,6 +9974,10 @@ snapshots:
     dependencies:
       react: 19.2.6
 
+  utf8-byte-length@1.0.5: {}
+
+  util-deprecate@1.0.2: {}
+
   valibot@1.4.0(typescript@5.9.3):
     optionalDependencies:
       typescript: 5.9.3
@@ -7577,6 +10010,24 @@ snapshots:
       - supports-color
       - terser
 
+  vite-node@2.1.9(@types/node@25.9.2)(lightningcss@1.32.0):
+    dependencies:
+      cac: 6.7.14
+      debug: 4.4.3
+      es-module-lexer: 1.7.0
+      pathe: 1.1.2
+      vite: 5.4.21(@types/node@25.9.2)(lightningcss@1.32.0)
+    transitivePeerDependencies:
+      - '@types/node'
+      - less
+      - lightningcss
+      - sass
+      - sass-embedded
+      - stylus
+      - sugarss
+      - supports-color
+      - terser
+
   vite-node@3.2.4(@types/node@22.19.19)(jiti@2.7.0)(lightningcss@1.32.0)(tsx@4.22.3):
     dependencies:
       cac: 6.7.14
@@ -7608,6 +10059,16 @@ snapshots:
       fsevents: 2.3.3
       lightningcss: 1.32.0
 
+  vite@5.4.21(@types/node@25.9.2)(lightningcss@1.32.0):
+    dependencies:
+      esbuild: 0.21.5
+      postcss: 8.5.15
+      rollup: 4.60.4
+    optionalDependencies:
+      '@types/node': 25.9.2
+      fsevents: 2.3.3
+      lightningcss: 1.32.0
+
   vite@7.3.3(@types/node@22.19.19)(jiti@2.7.0)(lightningcss@1.32.0)(tsx@4.22.3):
     dependencies:
       esbuild: 0.27.7
@@ -7637,11 +10098,25 @@ snapshots:
       jiti: 2.7.0
       tsx: 4.22.3
 
+  vite@8.0.14(@types/node@25.9.2)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3):
+    dependencies:
+      lightningcss: 1.32.0
+      picomatch: 4.0.4
+      postcss: 8.5.15
+      rolldown: 1.0.2
+      tinyglobby: 0.2.16
+    optionalDependencies:
+      '@types/node': 25.9.2
+      esbuild: 0.28.0
+      fsevents: 2.3.3
+      jiti: 2.7.0
+      tsx: 4.22.3
+
   vitefu@1.1.3(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)):
     optionalDependencies:
       vite: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
 
-  vitest@2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0):
+  vitest@2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0):
     dependencies:
       '@vitest/expect': 2.1.9
       '@vitest/mocker': 2.1.9(vite@5.4.21(@types/node@22.19.19)(lightningcss@1.32.0))
@@ -7666,7 +10141,44 @@ snapshots:
     optionalDependencies:
       '@edge-runtime/vm': 4.0.4
       '@types/node': 22.19.19
-      jsdom: 29.1.1
+      jsdom: 29.1.1(@noble/hashes@2.2.0)
+    transitivePeerDependencies:
+      - less
+      - lightningcss
+      - msw
+      - sass
+      - sass-embedded
+      - stylus
+      - sugarss
+      - supports-color
+      - terser
+
+  vitest@2.1.9(@edge-runtime/vm@4.0.4)(@types/node@25.9.2)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0):
+    dependencies:
+      '@vitest/expect': 2.1.9
+      '@vitest/mocker': 2.1.9(vite@5.4.21(@types/node@25.9.2)(lightningcss@1.32.0))
+      '@vitest/pretty-format': 2.1.9
+      '@vitest/runner': 2.1.9
+      '@vitest/snapshot': 2.1.9
+      '@vitest/spy': 2.1.9
+      '@vitest/utils': 2.1.9
+      chai: 5.3.3
+      debug: 4.4.3
+      expect-type: 1.3.0
+      magic-string: 0.30.21
+      pathe: 1.1.2
+      std-env: 3.10.0
+      tinybench: 2.9.0
+      tinyexec: 0.3.2
+      tinypool: 1.1.1
+      tinyrainbow: 1.2.0
+      vite: 5.4.21(@types/node@25.9.2)(lightningcss@1.32.0)
+      vite-node: 2.1.9(@types/node@25.9.2)(lightningcss@1.32.0)
+      why-is-node-running: 2.3.0
+    optionalDependencies:
+      '@edge-runtime/vm': 4.0.4
+      '@types/node': 25.9.2
+      jsdom: 29.1.1(@noble/hashes@2.2.0)
     transitivePeerDependencies:
       - less
       - lightningcss
@@ -7678,7 +10190,7 @@ snapshots:
       - supports-color
       - terser
 
-  vitest@3.2.4(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(jiti@2.7.0)(jsdom@29.1.1)(lightningcss@1.32.0)(tsx@4.22.3):
+  vitest@3.2.4(@edge-runtime/vm@4.0.4)(@types/debug@4.1.13)(@types/node@22.19.19)(jiti@2.7.0)(jsdom@29.1.1(@noble/hashes@2.2.0))(lightningcss@1.32.0)(tsx@4.22.3):
     dependencies:
       '@types/chai': 5.2.3
       '@vitest/expect': 3.2.4
@@ -7707,7 +10219,7 @@ snapshots:
       '@edge-runtime/vm': 4.0.4
       '@types/debug': 4.1.13
       '@types/node': 22.19.19
-      jsdom: 29.1.1
+      jsdom: 29.1.1(@noble/hashes@2.2.0)
     transitivePeerDependencies:
       - jiti
       - less
@@ -7728,6 +10240,14 @@ snapshots:
     dependencies:
       xml-name-validator: 5.0.0
 
+  webcrypto-core@1.9.2:
+    dependencies:
+      '@peculiar/asn1-schema': 2.7.0
+      '@peculiar/json-schema': 1.1.12
+      '@peculiar/utils': 2.0.3
+      asn1js: 3.0.10
+      tslib: 2.8.1
+
   webidl-conversions@8.0.1: {}
 
   webpack-virtual-modules@0.6.2: {}
@@ -7740,14 +10260,26 @@ snapshots:
 
   whatwg-mimetype@5.0.0: {}
 
-  whatwg-url@16.0.1:
+  whatwg-url@16.0.1(@noble/hashes@2.2.0):
     dependencies:
-      '@exodus/bytes': 1.15.1
+      '@exodus/bytes': 1.15.1(@noble/hashes@2.2.0)
       tr46: 6.0.0
       webidl-conversions: 8.0.1
     transitivePeerDependencies:
       - '@noble/hashes'
 
+  which@2.0.2:
+    dependencies:
+      isexe: 2.0.0
+
+  which@5.0.0:
+    dependencies:
+      isexe: 3.1.5
+
+  which@6.0.1:
+    dependencies:
+      isexe: 4.0.0
+
   why-is-node-running@2.3.0:
     dependencies:
       siginfo: 2.0.0
@@ -7759,6 +10291,8 @@ snapshots:
       string-width: 4.2.3
       strip-ansi: 6.0.1
 
+  wrappy@1.0.2: {}
+
   ws@8.18.0: {}
 
   xml-name-validator@5.0.0: {}
@@ -7770,6 +10304,8 @@ snapshots:
       '@oozcitak/util': 10.0.0
       js-yaml: 4.1.1
 
+  xmlbuilder@15.1.1: {}
+
   xmlchars@2.2.0: {}
 
   xtend@4.0.2: {}
@@ -7797,6 +10333,10 @@ snapshots:
 
   yallist@3.1.1: {}
 
+  yallist@4.0.0: {}
+
+  yallist@5.0.0: {}
+
   yargs-parser@21.1.1: {}
 
   yargs@17.7.2:
@@ -7813,6 +10353,8 @@ snapshots:
     dependencies:
       lib0: 0.2.117
 
+  yocto-queue@0.1.0: {}
+
   zod@3.25.76: {}
 
   zod@4.4.3: {}
diff --git a/pnpm-workspace.yaml b/pnpm-workspace.yaml
index 1d8028e..344f458 100644
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -2,3 +2,10 @@ packages:
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
diff --git a/scripts/check-desktop-local-first-baseline.mjs b/scripts/check-desktop-local-first-baseline.mjs
new file mode 100644
index 0000000..45e8944
--- /dev/null
+++ b/scripts/check-desktop-local-first-baseline.mjs
@@ -0,0 +1,65 @@
+import { spawnSync } from "node:child_process";
+import { existsSync } from "node:fs";
+
+// Tests must run under Node 22.13.x: Node 25 breaks 17 @dohc/web tests
+// (see execution log Environment section). Pin via PATH prefix; fail loudly
+// if the pinned toolchain is missing rather than silently using caller PATH.
+const pinnedNodeBin =
+  process.env.DOHC_TEST_NODE_BIN ?? "/home/ice/.local/share/nvm/v22.13.0/bin";
+const pnpmBin = "/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin";
+
+if (!existsSync(`${pinnedNodeBin}/node`)) {
+  console.error(`Pinned Node not found at ${pinnedNodeBin}/node.`);
+  console.error(
+    "Set DOHC_TEST_NODE_BIN to a Node 22.13+ bin directory (Node 25 breaks @dohc/web tests).",
+  );
+  process.exit(1);
+}
+
+const env = {
+  ...process.env,
+  PATH: `${pinnedNodeBin}:${pnpmBin}:${process.env.PATH ?? ""}`,
+};
+
+// Known pre-existing failures on main @ e2de7a3: 4 @dohc/web tests (see
+// execution log Gotchas). This allowance dies when those tests are fixed or
+// deleted with Convex in Phase 13 — do not add entries for new failures.
+const knownFailingBaseline = new Set(["pnpm --filter @dohc/web test"]);
+
+const commands = [
+  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
+  ["pnpm", ["--filter", "@dohc/web", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-convex-compat", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
+  ["pnpm", ["--filter", "@dohc/hocuspocus", "test"]],
+  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
+  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
+  ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
+  ["pnpm", ["check:debt"]],
+];
+
+const results = [];
+for (const [cmd, args] of commands) {
+  const label = `${cmd} ${args.join(" ")}`;
+  console.log(`\n$ ${label}`);
+  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
+  results.push({ label, status: result.status ?? 1 });
+}
+
+console.log("\n=== Baseline summary ===");
+let unexpected = 0;
+for (const { label, status } of results) {
+  const known = status !== 0 && knownFailingBaseline.has(label);
+  const tag = status === 0 ? "PASS" : known ? "KNOWN-FAIL (recorded baseline)" : "FAIL";
+  if (status !== 0 && !known) unexpected += 1;
+  console.log(`${tag.padEnd(32)} ${label}`);
+}
+
+if (unexpected > 0) {
+  console.error(`\n${unexpected} unexpected failure(s) beyond the recorded baseline.`);
+  process.exit(1);
+}
+console.log("\nBaseline check passed (known baseline failures tolerated).");

exec
/bin/bash -lc 'git diff --name-only e2de7a3ad4234a2337cc7962865849551c34547b' in /home/ice/dev/dohc
 succeeded in 0ms:
.gitignore
AGENTS.md
apps/desktop/e2e/desktopLaunch.spec.ts
apps/desktop/e2e/firstRunWorkspace.spec.ts
apps/desktop/electron.vite.config.ts
apps/desktop/package.json
apps/desktop/playwright.config.ts
apps/desktop/scripts/smoke-test.mjs
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
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
apps/desktop/src/workspaces/createWorkspaceFolder.ts
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/registryStore.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/workspaceFiles.ts
apps/desktop/tsconfig.json
apps/desktop/vitest.config.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md
docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md
docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md
docs/superpowers/reviews/codex/phase-00.md
docs/superpowers/reviews/codex/phase-01.md
docs/superpowers/reviews/codex/phase-02.md
docs/superpowers/reviews/codex/phase-03.md
docs/superpowers/reviews/codex/ui-phase-03.md
package.json
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
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/check-desktop-local-first-baseline.mjs

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/main.ts && printf '\\n--- createMainWindow ---\\n' && sed -n '1,200p' apps/desktop/src/window/createMainWindow.ts && printf '\\n--- preload ---\\n' && sed -n '1,200p' apps/desktop/src/preload.ts && printf '\\n--- bridgeContract ---\\n' && sed -n '1,220p' apps/desktop/src/ipc/bridgeContract.ts && printf '\\n--- channels ---\\n' && cat apps/desktop/src/ipc/channels.ts" in /home/ice/dev/dohc
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

--- createMainWindow ---
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

--- preload ---
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
  attachWorkspaceFolder: (payload: { rootPath: string }) =>
    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
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

--- bridgeContract ---
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

export const AttachWorkspaceFolderPayload = z.object({
  rootPath: z.string().min(1),
});

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
  attachWorkspaceFolder(payload: {
    rootPath: string;
  }): Promise<WorkspaceSummary>;
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

--- channels ---
export const CHANNELS = {
  getVersion: "desktop:get-version",
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
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/workspaces/createWorkspaceFolder.ts && printf '\\n--- registry ---\\n' && sed -n '1,240p' apps/desktop/src/workspaces/WorkspaceRegistry.ts && printf '\\n--- registryStore ---\\n' && sed -n '1,220p' apps/desktop/src/workspaces/registryStore.ts && printf '\\n--- workspaceFiles ---\\n' && sed -n '1,240p' apps/desktop/src/workspaces/workspaceFiles.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
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

--- registry ---
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

--- registryStore ---
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

exec
/bin/bash -lc "sed -n '1,260p' packages/workspace-core/src/paths.ts && printf '\\n--- metadata ---\\n' && sed -n '1,200p' packages/workspace-core/src/metadata.ts && printf '\\n--- workspaceMode ---\\n' && cat packages/workspace-core/src/workspaceMode.ts && printf '\\n--- changeSet ---\\n' && sed -n '1,200p' packages/workspace-core/src/changeSet.ts && printf '\\n--- conflicts ---\\n' && cat packages/workspace-core/src/conflicts.ts && printf '\\n--- index ---\\n' && cat packages/workspace-core/src/index.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
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

--- metadata ---
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

--- workspaceMode ---
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

--- changeSet ---
export type ChangeSetKind =
  | "user-edit"
  | "agent-run"
  | "import"
  | "sync"
  | "app-build";

export type BoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "app-trust"
  | "private-to-shared"
  | "unmergeable-overwrite";

export type ChangeAuthor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOf: string };

export interface FileChange {
  path: string;
  operation: "write" | "delete" | "rename";
}

export interface ChangeSet {
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: FileChange[];
  boundaryCrossings: BoundaryCrossing[];
}

export function createChangeSet(input: {
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
}): ChangeSet {
  return { ...input, files: [], boundaryCrossings: [] };
}

export function addFileChanges(set: ChangeSet, files: FileChange[]): ChangeSet {
  return { ...set, files: [...set.files, ...files] };
}

export function addBoundaryCrossing(
  set: ChangeSet,
  crossing: BoundaryCrossing,
): ChangeSet {
  return { ...set, boundaryCrossings: [...set.boundaryCrossings, crossing] };
}

// Liberal by default: ordinary edits sync freely; only genuine boundary
// crossings need a human to look.
export function requiresReview(set: ChangeSet): boolean {
  return set.boundaryCrossings.length > 0;
}

--- conflicts ---
export interface ConflictInput {
  path: string;
  localDescription: string;
  remoteDescription: string;
}

// Conflicts read like a sentence, never like Git markers.
export function describeConflict(input: ConflictInput): string {
  return (
    `Both sides changed ${input.path}: ${input.localDescription}, ` +
    `while ${input.remoteDescription}. Both versions are kept until you choose.`
  );
}

--- index ---
export * from "./workspaceMode";
export * from "./metadata";
export * from "./paths";
export * from "./changeSet";
export * from "./conflicts";

exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/renderer/DesktopFirstRun.tsx && printf '\\n--- DesktopRoot ---\\n' && sed -n '1,220p' apps/desktop/src/renderer/DesktopRoot.tsx && printf '\\n--- DesktopWorkspaceShell ---\\n' && sed -n '1,520p' apps/desktop/src/renderer/DesktopWorkspaceShell.tsx && printf '\\n--- CommandPalette ---\\n' && sed -n '1,180p' apps/desktop/src/renderer/CommandPalette.tsx && printf '\\n--- NewFileDialog ---\\n' && sed -n '1,160p' apps/desktop/src/renderer/NewFileDialog.tsx && printf '\\n--- bridge ---\\n' && cat apps/desktop/src/renderer/bridge.ts && printf '\\n--- theme ---\\n' && cat apps/desktop/src/renderer/theme.ts" in /home/ice/dev/dohc
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
      </div>
    </div>
  );
}

--- DesktopRoot ---
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

--- DesktopWorkspaceShell ---
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

--- CommandPalette ---
import { useEffect, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  run: () => void;
}

export function CommandPalette(props: {
  commands: Command[];
  onClose: () => void;
  testId?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = props.commands.filter((command) =>
    command.label.toLowerCase().includes(query.toLowerCase()),
  );

  function runCommand(command: Command | undefined) {
    if (!command) return;
    props.onClose();
    command.run();
  }

  return (
    <div
      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
      onClick={props.onClose}
    >
      <div
        data-testid={props.testId ?? "command-palette"}
        className="w-130 max-w-[80vw] overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          aria-label={props.ariaLabel ?? "Command"}
          placeholder={props.placeholder ?? "Type a command…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") runCommand(matches[0]);
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-subtle"
        />
        <ul role="listbox" aria-label="Commands" className="m-0 max-h-72 list-none overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-subtle">No matching commands</li>
          ) : (
            matches.map((command, index) => (
              <li key={command.id} role="option" aria-selected={index === 0}>
                <button
                  type="button"
                  onClick={() => runCommand(command)}
                  className={`w-full rounded px-3 py-1.5 text-left text-[13px] ${
                    index === 0 ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {command.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

--- NewFileDialog ---
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";

export function NewFileDialog(props: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function create() {
    if (!name.trim()) return;
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId: props.workspaceId,
        relativePath: name.trim(),
      });
      props.onCreated(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div
      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
      onClick={props.onClose}
    >
      <div
        className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-3 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          aria-label="File name"
          placeholder="notes/today.md"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") void create();
          }}
          className="w-full rounded border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-subtle"
        />
        {error ? <p className="mb-0 mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

--- bridge ---
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

--- theme ---
const STORAGE_KEY = "dohc-theme";

function apply(media: MediaQueryList): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  const dark = stored ? stored === "dark" : media.matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

// Follows the system theme unless the user explicitly toggled; never
// interrupts running work (a data-attribute flip only).
export function initTheme(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => apply(media));
  apply(media);
}

export function toggleTheme(): void {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.dataset.theme = next;
}

exec
/bin/bash -lc "cat apps/desktop/package.json && printf '\\n--- electron.vite.config ---\\n' && cat apps/desktop/electron.vite.config.ts && printf '\\n--- playwright config ---\\n' && cat apps/desktop/playwright.config.ts && printf '\\n--- tsconfig ---\\n' && cat apps/desktop/tsconfig.json && printf '\\n--- vitest config ---\\n' && cat apps/desktop/vitest.config.ts && printf '\\n--- root package ---\\n' && cat package.json && printf '\\n--- workspace package ---\\n' && cat packages/workspace-core/package.json && cat packages/workspace-core/tsconfig.json" in /home/ice/dev/dohc
 succeeded in 0ms:
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

--- electron.vite.config ---
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // Workspace packages ship raw TS — they must be bundled, not
    // externalized, or Node ESM fails on their extensionless imports.
    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
    build: {
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
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: { input: "src/renderer/index.html" },
    },
  },
});

--- playwright config ---
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

--- tsconfig ---
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "electron.vite.config.ts", "playwright.config.ts"]
}

--- vitest config ---
import { defineConfig } from "vitest/config";

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

--- root package ---
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

--- workspace package ---
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
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}

exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/security/electronSecurity.ts && printf '\\n--- test ---\\n' && sed -n '1,260p' apps/desktop/src/security/electronSecurity.test.ts" in /home/ice/dev/dohc
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

--- test ---
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
/bin/bash -lc "find apps/desktop -maxdepth 3 -type f | sort | sed -n '1,200p'" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/dist/main/main.js
apps/desktop/dist/preload/preload.cjs
apps/desktop/dist/renderer/index.html
apps/desktop/e2e/desktopLaunch.spec.ts
apps/desktop/e2e/firstRunWorkspace.spec.ts
apps/desktop/electron.vite.config.ts
apps/desktop/package.json
apps/desktop/playwright.config.ts
apps/desktop/scripts/smoke-test.mjs
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
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
apps/desktop/src/workspaces/createWorkspaceFolder.ts
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/registryStore.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts
apps/desktop/src/workspaces/workspaceFiles.ts
apps/desktop/tsconfig.json
apps/desktop/tsconfig.tsbuildinfo
apps/desktop/vitest.config.ts

exec
/bin/bash -lc "sed -n '1,260p' packages/workspace-core/src/paths.test.ts && printf '\\n--- createWorkspace tests ---\\n' && sed -n '1,200p' apps/desktop/src/workspaces/createWorkspaceFolder.test.ts && printf '\\n--- registry tests ---\\n' && sed -n '1,220p' apps/desktop/src/workspaces/registryStore.test.ts && printf '\\n--- workspace files tests ---\\n' && sed -n '1,220p' apps/desktop/src/workspaces/workspaceFiles.test.ts && printf '\\n--- desktop first run test ---\\n' && sed -n '1,220p' apps/desktop/src/renderer/DesktopFirstRun.test.tsx" in /home/ice/dev/dohc
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

--- createWorkspace tests ---
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFolder } from "./createWorkspaceFolder";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dohc-create-"));
});

describe("createWorkspaceFolder", () => {
  it("creates a fresh workspace with manifest and context", async () => {
    const root = join(base, "personal");
    const created = await createWorkspaceFolder({ rootPath: root, kind: "personal" });
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      version: 1,
      kind: "personal",
      mode: "local-first",
      workspaceId: created.workspaceId,
    });
    expect(await readFile(join(root, ".context", "me.md"), "utf8")).toContain(
      "About me",
    );
  });

  it("adopts an existing workspace instead of overwriting its identity", async () => {
    const root = join(base, "existing");
    await mkdir(join(root, ".dohc"), { recursive: true });
    const existing = {
      version: 1,
      workspaceId: "ws-existing-identity",
      kind: "personal",
      mode: "local-first",
    };
    await writeFile(
      join(root, ".dohc", "manifest.json"),
      JSON.stringify(existing),
    );

    const adopted = await createWorkspaceFolder({ rootPath: root, kind: "personal" });

    expect(adopted.workspaceId).toBe("ws-existing-identity");
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest.workspaceId).toBe("ws-existing-identity");
  });

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});

--- registry tests ---
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createRegistryStore } from "./registryStore";

let store: ReturnType<typeof createRegistryStore>;

const personal = {
  workspaceId: "ws-1",
  rootPath: "/home/ice/dohc/personal",
  kind: "personal" as const,
  mode: "local-first" as const,
};

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
  store = createRegistryStore(join(dir, "workspaces.json"));
});

describe("registry store", () => {
  it("supports multiple attached folders", () => {
    store.register(personal);
    store.register({
      workspaceId: "ws-2",
      rootPath: "/mnt/data/research",
      kind: "personal",
      mode: "local-first",
    });
    expect(store.list()).toHaveLength(2);
  });

  it("rejects duplicate folder attachment", () => {
    store.register(personal);
    expect(() =>
      store.register({ ...personal, workspaceId: "ws-other" }),
    ).toThrow(/already attached/i);
  });

  it("rejects a second root carrying an already-registered workspace identity", () => {
    store.register(personal);
    expect(() =>
      store.register({ ...personal, rootPath: "/home/ice/dohc/personal-copy" }),
    ).toThrow(/identity .* already attached|already attached .* identity/i);
  });

  it("persists across store instances", () => {
    store.register(personal);
    const reopened = createRegistryStore(store.registryFile);
    expect(reopened.find("ws-1")?.rootPath).toBe(personal.rootPath);
  });

  it("local-only workspaces carry no account or remote identity", () => {
    store.register(personal);
    const entry = store.find("ws-1");
    expect(entry).toBeTruthy();
    expect(entry && "remote" in entry && entry.remote).toBeFalsy();
  });

  it("records remote identity only when sync is explicitly enabled", () => {
    store.register({ ...personal, kind: "shared", mode: "cloud-first-local-copy" });
    expect(store.find("ws-1")?.remote).toBeUndefined();

    store.setRemote("ws-1", {
      serverUrl: "https://cloud.dohc.example",
      remoteWorkspaceId: "rw-99",
    });
    expect(store.find("ws-1")?.remote).toEqual({
      serverUrl: "https://cloud.dohc.example",
      remoteWorkspaceId: "rw-99",
    });
  });
});

--- workspace files tests ---
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { copyIntoWorkspace, createFile, listFiles } from "./workspaceFiles";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
});

describe("createFile", () => {
  it("creates nested files through validated paths", async () => {
    const path = await createFile(root, "notes/./today.md");
    expect(path).toBe("notes/today.md");
    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
  });

  it("rejects traversal and reserved paths", async () => {
    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
  });

  it("never overwrites an existing file", async () => {
    await writeFile(join(root, "keep.md"), "original");
    await createFile(root, "keep.md");
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
  });
});

describe("listFiles", () => {
  it("lists files but skips internal directories", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "");
    await writeFile(join(root, "wallet.sqlite"), "");
    const files = await listFiles(root);
    expect(files).toEqual([
      { path: "notes/a.md", kind: "file" },
      { path: "wallet.sqlite", kind: "database" },
    ]);
  });
});

describe("copyIntoWorkspace", () => {
  it("copies external files into the workspace root by basename", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
    expect(imported).toEqual(["receipt.png"]);
    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
  });

  it("skips files that already exist instead of overwriting", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
    await writeFile(join(outside, "notes.md"), "incoming");
    await writeFile(join(root, "notes.md"), "existing");
    const imported = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(imported).toEqual([]);
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
  });
});

--- desktop first run test ---
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
/bin/bash -lc "sed -n '1,320p' apps/desktop/e2e/firstRunWorkspace.spec.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
      DOHC_TEST_PICK_PATH: existingRoot,
    },
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

exec
/bin/bash -lc 'git status --short' in /home/ice/dev/dohc
 succeeded in 0ms:
 M docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
?? docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md
?? docs/superpowers/reviews/codex/checkpoint-phase-04.md
?? docs/superpowers/reviews/codex/phase-04.md

exec
/bin/bash -lc "git ls-files apps/desktop/dist | sed -n '1,20p'; git check-ignore -v apps/desktop/dist/main/main.js || true" in /home/ice/dev/dohc
 succeeded in 0ms:
.gitignore:3:dist/	apps/desktop/dist/main/main.js

exec
/bin/bash -lc 'cat apps/desktop/scripts/smoke-test.mjs' in /home/ice/dev/dohc
 succeeded in 0ms:
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Spawns the built desktop app for a few seconds and fails on fatal stderr
// patterns (t3code's smoke pattern). Catches broken builds that unit tests
// cannot see: missing modules, preload failures, renderer crashes.

const repoRoot = process.cwd();
const mainEntry = join(repoRoot, "apps/desktop/dist/main/main.js");

if (!existsSync(mainEntry)) {
  console.error(`Desktop build missing: ${mainEntry} — run pnpm build:desktop first.`);
  process.exit(1);
}

const FATAL_PATTERNS = [
  /MODULE_NOT_FOUND/,
  /Uncaught (Error|Exception)/i,
  /Cannot find module/,
  /Unable to load preload script/,
  /Renderer process crashed/i,
  /ERR_FILE_NOT_FOUND/,
];

const args = [mainEntry];
if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");

const child = spawn(
  join(repoRoot, "node_modules/.bin/electron"),
  args,
  {
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});
child.stdout.on("data", () => {});

const SMOKE_DURATION_MS = 8000;

setTimeout(() => {
  child.kill("SIGTERM");
}, SMOKE_DURATION_MS);

child.on("exit", () => {
  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
  if (fatal.length > 0) {
    console.error("Desktop smoke FAILED. Fatal stderr patterns:");
    for (const pattern of fatal) console.error(`  ${pattern}`);
    console.error("--- stderr ---");
    console.error(stderr.slice(0, 4000));
    process.exit(1);
  }
  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
  process.exit(0);
});

exec
/bin/bash -lc 'cat tsconfig.base.json' in /home/ice/dev/dohc
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

exec
/bin/bash -lc 'pnpm --filter @dohc/desktop exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
 exited 1 in 445ms:
 ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)

Your pnpm version is incompatible with "/home/ice/dev/dohc".

Expected version: 10.24.0
Got: 9.14.4

This is happening because the package's manifest has an engines.pnpm field specified.
To fix this issue, install the required pnpm version globally.

To install the latest version of pnpm, run "pnpm i -g pnpm".
To check your pnpm version, run "pnpm -v".

exec
/bin/bash -lc '/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin/pnpm --filter @dohc/desktop exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
 succeeded in 2181ms:
exec
/bin/bash -lc '/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin/pnpm --filter @dohc/workspace-core exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
 succeeded in 1226ms:
exec
/bin/bash -lc '/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin/pnpm --filter @dohc/workspace-core test -- --runInBand' in /home/ice/dev/dohc
 exited 1 in 1079ms:

> @dohc/workspace-core@ test /home/ice/dev/dohc/packages/workspace-core
> vitest run -- --runInBand


 RUN  v2.1.9 /home/ice/dev/dohc/packages/workspace-core


⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 3 unhandled errors during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: ENOENT: no such file or directory, mkdir '/tmp/rpIHTlq2uHJeXUNjw0KAQ'
 ❯ mkdir node:internal/fs/promises:861:10
 ❯ Proxy.fetch ../../node_modules/vitest/dist/chunks/resolveConfig.rBxzbVsl.js:6636:9
 ❯ EventEmitter.onMessage ../../node_modules/vitest/dist/chunks/index.68735LiX.js:91:20


⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: ENOENT: no such file or directory, mkdir '/tmp/rpIHTlq2uHJeXUNjw0KAQ'
 ❯ mkdir node:internal/fs/promises:861:10
 ❯ Proxy.fetch ../../node_modules/vitest/dist/chunks/resolveConfig.rBxzbVsl.js:6636:9
 ❯ EventEmitter.onMessage ../../node_modules/vitest/dist/chunks/index.68735LiX.js:91:20


⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: ENOENT: no such file or directory, mkdir '/tmp/rpIHTlq2uHJeXUNjw0KAQ'
 ❯ mkdir node:internal/fs/promises:861:10
 ❯ Proxy.fetch ../../node_modules/vitest/dist/chunks/resolveConfig.rBxzbVsl.js:6636:9
 ❯ EventEmitter.onMessage ../../node_modules/vitest/dist/chunks/index.68735LiX.js:91:20

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 Test Files  no tests
      Tests  no tests
     Errors  3 errors
   Start at  18:57:08
   Duration  266ms (transform 18ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 0ms)


⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: EROFS: read-only file system, open '/home/ice/dev/dohc/packages/workspace-core/node_modules/.vite/vitest/results.json'
 ❯ open node:internal/fs/promises:641:25
 ❯ Object.writeFile node:internal/fs/promises:1249:14
 ❯ ResultsCache.writeToCache ../../node_modules/vitest/dist/chunks/resolveConfig.rBxzbVsl.js:4280:5
 ❯ ../../node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:10827:7
 ❯ Vitest.runFiles ../../node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:10840:12
 ❯ Vitest.start ../../node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:10682:7
 ❯ startVitest ../../node_modules/vitest/dist/chunks/cli-api.DqsSTaIi.js:11848:7
 ❯ start ../../node_modules/vitest/dist/chunks/cac.CB_9Zo9Q.js:1506:17
 ❯ CAC.run ../../node_modules/vitest/dist/chunks/cac.CB_9Zo9Q.js:1486:3

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { errno: -30, code: 'EROFS', syscall: 'open', path: '/home/ice/dev/dohc/packages/workspace-core/node_modules/.vite/vitest/results.json' }



/home/ice/dev/dohc/packages/workspace-core:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @dohc/workspace-core@ test: `vitest run -- --runInBand`
Exit status 1

exec
/bin/bash -lc "rg \"@dohc/workspace-core\" -n . --glob '"'!pnpm-lock.yaml'"'" in /home/ice/dev/dohc
 succeeded in 0ms:
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:740:pnpm --filter @dohc/workspace-core test
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:741:pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1369:pnpm --filter @dohc/workspace-core test src/databases.test.ts
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:196:- Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:149:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:500:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:584:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:800:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:740:pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:801:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:741:pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:811:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1369:pnpm --filter @dohc/workspace-core test src/databases.test.ts
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:824:./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:183:- Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:833:./packages/workspace-core/package.json:2:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:868:./apps/desktop/package.json:34:    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:869:./apps/desktop/electron.vite.config.ts:9:    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:871:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:7:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:874:./apps/desktop/src/workspaces/workspaceFiles.ts:4:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:879:./apps/desktop/src/main.ts:4:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:882:./pnpm-lock.yaml:216:      '@dohc/workspace-core':
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:894:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:149:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:899:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:500:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:902:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:584:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:908:./docs/superpowers/reviews/codex/phase-04.md:517:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:911:./docs/superpowers/reviews/codex/phase-04.md:521:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:919:./docs/superpowers/reviews/codex/phase-04.md:1435: - Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:959:./docs/superpowers/reviews/codex/phase-04.md:1787:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:962:./docs/superpowers/reviews/codex/phase-04.md:1791:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:972:./docs/superpowers/reviews/codex/phase-04.md:2258:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:976:./docs/superpowers/reviews/codex/phase-04.md:2448:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:979:./docs/superpowers/reviews/codex/phase-04.md:2532:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:983:./docs/superpowers/reviews/codex/phase-03.md:213:+import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:985:./docs/superpowers/reviews/codex/phase-03.md:485:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:987:./docs/superpowers/reviews/codex/phase-03.md:542:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:992:./docs/superpowers/reviews/codex/phase-03.md:1702:+    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:993:./docs/superpowers/reviews/codex/phase-03.md:1767:+    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1012:./docs/superpowers/reviews/codex/phase-03.md:2254:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1037:./docs/superpowers/reviews/codex/phase-03.md:2471:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1038:./docs/superpowers/reviews/codex/phase-03.md:2472:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1039:./docs/superpowers/reviews/codex/phase-03.md:2473:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1040:./docs/superpowers/reviews/codex/phase-03.md:2474:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1043:./docs/superpowers/reviews/codex/phase-03.md:3045:     5	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1044:./docs/superpowers/reviews/codex/phase-03.md:3398:     1	import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1047:./docs/superpowers/reviews/codex/phase-03.md:3551:     4	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1051:./docs/superpowers/reviews/codex/phase-03.md:4018:+      '@dohc/workspace-core':
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1070:./docs/superpowers/reviews/codex/phase-00.md:1111: pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1071:./docs/superpowers/reviews/codex/phase-00.md:1112: pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1081:./docs/superpowers/reviews/codex/phase-00.md:1746: pnpm --filter @dohc/workspace-core test src/databases.test.ts
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1087:./docs/superpowers/reviews/codex/phase-00.md:4770:@dohc/workspace-core	packages/workspace-core/package.json	vitest run
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1109:./docs/superpowers/reviews/codex/phase-01.md:61:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1147:./docs/superpowers/reviews/codex/phase-01.md:925:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1165:./docs/superpowers/reviews/codex/phase-01.md:2168:pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1166:./docs/superpowers/reviews/codex/phase-01.md:2169:pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1188:./docs/superpowers/reviews/codex/phase-01.md:2394:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-00.md:1111: pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/phase-00.md:1112: pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/phase-00.md:1746: pnpm --filter @dohc/workspace-core test src/databases.test.ts
./docs/superpowers/reviews/codex/phase-00.md:4770:@dohc/workspace-core	packages/workspace-core/package.json	vitest run
./docs/superpowers/reviews/codex/phase-01.md:61:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-01.md:925:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-01.md:2168:pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/phase-01.md:2169:pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/phase-01.md:2394:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-03.md:213:+import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:485:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:542:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:1702:+    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./docs/superpowers/reviews/codex/phase-03.md:1767:+    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/phase-03.md:2254:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-03.md:2471:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
./docs/superpowers/reviews/codex/phase-03.md:2472:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
./docs/superpowers/reviews/codex/phase-03.md:2473:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
./docs/superpowers/reviews/codex/phase-03.md:2474:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
./docs/superpowers/reviews/codex/phase-03.md:3045:     5	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:3398:     1	import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:3551:     4	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:4018:+      '@dohc/workspace-core':
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:257:++import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:529:++} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:586:++} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:1746:++    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:1811:++    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:2298:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:2515:+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:2516:+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:2517:+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:2518:+apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:3089:+     5	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:3442:+     1	import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:3595:+     4	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:4062:++      '@dohc/workspace-core':
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:4408:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:5079:+      '@dohc/workspace-core':
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:9802:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:10227:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:10435:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:11529:    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:11547:    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:11646:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:12802:/bin/bash -lc '/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin/pnpm --filter @dohc/workspace-core exec tsc --noEmit --incremental false --pretty false' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:12805:/bin/bash -lc '/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin/pnpm --filter @dohc/workspace-core test -- --runInBand' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:12808:> @dohc/workspace-core@ test /home/ice/dev/dohc/packages/workspace-core
./docs/superpowers/reviews/codex/checkpoint-phase-04.md:12867: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @dohc/workspace-core@ test: `vitest run -- --runInBand`
./apps/desktop/package.json:34:    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/phase-04.md:517:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:521:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:1435: - Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
./docs/superpowers/reviews/codex/phase-04.md:1787:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:1791:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2258:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2448:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2532:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2674:./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:871:./apps/desktop/src/workspaces/createWorkspaceFolder.ts:7:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2951:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2955:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:3692:    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/phase-04.md:3783:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:4915:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:5116:} from "@dohc/workspace-core";
./packages/workspace-core/package.json:2:  "name": "@dohc/workspace-core",
./apps/desktop/electron.vite.config.ts:9:    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./apps/desktop/src/main.ts:4:} from "@dohc/workspace-core";
./apps/desktop/src/workspaces/workspaceFiles.ts:4:} from "@dohc/workspace-core";
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:7:} from "@dohc/workspace-core";

exec
/bin/bash -lc 'ls -ld node_modules/@playwright/test node_modules/playwright 2>/dev/null || true; ls -ld apps/desktop/node_modules/@playwright/test apps/desktop/node_modules/playwright 2>/dev/null || true' in /home/ice/dev/dohc
 succeeded in 0ms:
drwxr-xr-x 2 ice ice 4096 May 27 03:50 node_modules/@playwright/test
drwxr-xr-x 4 ice ice 4096 May 27 03:50 node_modules/playwright

exec
/bin/bash -lc "sed -n '1,220p' scripts/check-dual-backend-baseline.mjs && printf '\\n--- self-host ---\\n' && sed -n '1,160p' scripts/check-self-host.mjs" in /home/ice/dev/dohc
 succeeded in 0ms:
import { spawnSync } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
  ["pnpm", ["--filter", "@dohc/web", "test"]],
  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
  ["pnpm", ["--filter", "@dohc/hocuspocus", "test"]],
  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
];

for (const [cmd, args] of commands) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

--- self-host ---
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const COMPOSE_FILE = 'docker-compose.self-host.yml'
const ENV_FILE = '.env.self-host.example'
const REQUIRED_SERVICES = [
  'web',
  'workspace-api',
  'postgres',
  'object-storage',
  'hocuspocus',
  'sqlite-worker',
  'app-tester',
  'agent-sandbox',
]

const startRequested =
  process.argv.includes('--start') || process.env.DOHC_SELF_HOST_START === '1'

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const marker = ok ? 'ok' : 'missing'
  console.log(`[${marker}] ${name}${detail ? ` - ${detail}` : ''}`)
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function requireCommand(command, args, label) {
  const result = run(command, args)
  if (result.status === 0) {
    record(label, true, (result.stdout || result.stderr).trim().split(/\r?\n/)[0])
    return true
  }
  record(label, false, `${command} ${args.join(' ')} failed or is unavailable`)
  return false
}

function composeArgs(...args) {
  return ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args]
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function checkServiceScripts() {
  const root = readPackageJson('package.json')
  record(
    'root check:self-host script',
    root.scripts?.['check:self-host'] === 'node scripts/check-self-host.mjs',
    'package.json exposes pnpm check:self-host',
  )
  for (const [label, path] of [
    ['web app package', 'apps/app/package.json'],
    ['workspace API package', 'services/workspace-api/package.json'],
    ['Hocuspocus package', 'services/hocuspocus/package.json'],
    ['sqlite worker package', 'services/sqlite-worker/package.json'],
    ['app tester package', 'services/app-tester/package.json'],
    ['agent sandbox package', 'services/agent-sandbox/package.json'],
  ]) {
    record(label, existsSync(path), path)
  }
}

function checkComposeConfig() {
  if (!existsSync(COMPOSE_FILE)) {
    record('self-host compose file', false, COMPOSE_FILE)
    return false
  }
  if (!existsSync(ENV_FILE)) {
    record('self-host env example', false, ENV_FILE)
    return false
  }
  const config = run('docker', composeArgs('config', '--services'))
  if (config.status !== 0) {
    record(
      'docker compose config',
      false,
      (config.stderr || config.stdout).trim() || 'compose config failed',
    )
    return false
  }
  const services = new Set(config.stdout.trim().split(/\r?\n/).filter(Boolean))
  for (const service of REQUIRED_SERVICES) {
    record(`compose service:${service}`, services.has(service), service)
  }
  return REQUIRED_SERVICES.every((service) => services.has(service))
}

function startComposeStack() {
  const up = spawnSync('docker', composeArgs('up', '-d', ...REQUIRED_SERVICES), {
    stdio: 'inherit',
  })
  if (up.status !== 0) {
    record('compose up', false, 'docker compose up failed')
    return
  }
  const ps = run('docker', composeArgs('ps', '--services', '--filter', 'status=running'))
  if (ps.status !== 0) {
    record('compose ps', false, (ps.stderr || ps.stdout).trim())
    return
  }
  const running = new Set(ps.stdout.trim().split(/\r?\n/).filter(Boolean))
  for (const service of REQUIRED_SERVICES) {
    record(`running service:${service}`, running.has(service), service)
  }
}

requireCommand('docker', ['--version'], 'Docker CLI')
requireCommand('docker', ['compose', 'version'], 'Docker Compose')
checkServiceScripts()
const composeOk = checkComposeConfig()

if (startRequested && composeOk) {
  startComposeStack()
} else if (composeOk) {
  console.log(
    'Self-host preflight passed. To start the stack, run: pnpm check:self-host -- --start',
  )
}

if (results.some((result) => !result.ok)) {
  console.error('Self-host check failed. Missing dependencies are listed above.')
  process.exit(1)
}

exec
/bin/bash -lc 'cat apps/desktop/src/renderer/styles.css && cat apps/desktop/src/renderer/main.tsx && cat apps/desktop/src/renderer/index.html' in /home/ice/dev/dohc
 succeeded in 0ms:
@import "@dohc/brand/tokens.css";
@import "tailwindcss";

@custom-variant dark ([data-theme='dark'] &);

/* Semantic layer over the shared brand tokens. The desktop renderer never
 * redefines brand colors — packages/brand/src/tokens.css is the source. */
@theme inline {
  --color-bg: var(--dohc-bg);
  --color-panel: var(--dohc-panel);
  --color-panel-2: var(--dohc-panel-2);
  --color-ink: var(--dohc-ink);
  --color-muted: var(--dohc-muted);
  --color-subtle: var(--dohc-subtle);
  --color-accent: var(--dohc-accent);
  --color-line: var(--dohc-line);
  --color-success: var(--dohc-success);
  --color-warning: var(--dohc-warning);
  --color-danger: var(--dohc-danger);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
}

html,
body,
#root {
  height: 100%;
  margin: 0;
  background: var(--dohc-bg);
  color: var(--dohc-ink);
  font-family: var(--font-sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}

/* Desktop app, not a web page: no text cursor or selection on chrome. */
.app-chrome {
  user-select: none;
  cursor: default;
}
import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import { initTheme } from "./theme";
import "./styles.css";

initTheme();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<DesktopRoot />);
}

requestAnimationFrame(() => {
  window.dohcDesktopInternal?.firstPaint();
});
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
    <script type="module" src="./main.tsx"></script>
  </body>
</html>

exec
/bin/bash -lc 'rg "will-frame-navigate" node_modules/electron -n | head -20' in /home/ice/dev/dohc
 succeeded in 0ms:
node_modules/electron/electron.d.ts:17412:     * Unlike `will-navigate`, `will-frame-navigate` is fired when the main frame or
node_modules/electron/electron.d.ts:17425:    on(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
node_modules/electron/electron.d.ts:17426:    off(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
node_modules/electron/electron.d.ts:17427:    once(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
node_modules/electron/electron.d.ts:17428:    addListener(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
node_modules/electron/electron.d.ts:17429:    removeListener(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
node_modules/electron/electron.d.ts:19496:    addEventListener(event: 'will-frame-navigate', listener: (event: WillFrameNavigateEvent) => void, useCapture?: boolean): this;
node_modules/electron/electron.d.ts:19497:    removeEventListener(event: 'will-frame-navigate', listener: (event: WillFrameNavigateEvent) => void): this;

exec
/bin/bash -lc "sed -n '17400,17435p' node_modules/electron/electron.d.ts && rg \"interface WebContentsWillFrameNavigateEventParams\" -n node_modules/electron/electron.d.ts && sed -n '22780,22810p' node_modules/electron/electron.d.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
                                                 */
                                                webPreferences: WebPreferences,
                                                /**
                                                 * The other `<webview>` parameters such as the `src` URL. This object can be
                                                 * modified to adjust the parameters of the guest page.
                                                 */
                                                params: Record<string, string>) => void): this;
    /**
     * Emitted when a user or the page wants to start navigation in any frame. It can
     * happen when the `window.location` object is changed or a user clicks a link in
     * the page.
     *
     * Unlike `will-navigate`, `will-frame-navigate` is fired when the main frame or
     * any of its subframes attempts to navigate. When the navigation event comes from
     * the main frame, `isMainFrame` will be `true`.
     *
     * This event will not emit when the navigation is started programmatically with
     * APIs like `webContents.loadURL` and `webContents.back`.
     *
     * It is also not emitted for in-page navigations, such as clicking anchor links or
     * updating the `window.location.hash`. Use `did-navigate-in-page` event for this
     * purpose.
     *
     * Calling `event.preventDefault()` will prevent the navigation.
     */
    on(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
    off(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
    once(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
    addListener(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
    removeListener(event: 'will-frame-navigate', listener: (details: Event<WebContentsWillFrameNavigateEventParams>) => void): this;
    /**
     * Emitted when a user or the page wants to start navigation on the main frame. It
     * can happen when the `window.location` object is changed or a user clicks a link
     * in the page.
     *
     * This event will not emit when the navigation is started programmatically with
24000:  interface WebContentsWillFrameNavigateEventParams {
    callback?: () => void;
  }

  interface PowerMonitorSpeedLimitChangeEventParams {
    /**
     * The operating system's advertised speed limit for CPUs, in percent.
     */
    limit: number;
  }

  interface PowerMonitorThermalStateChangeEventParams {
    /**
     * The system's new thermal state. Can be `unknown`, `nominal`, `fair`, `serious`,
     * `critical`.
     */
    state: ('unknown' | 'nominal' | 'fair' | 'serious' | 'critical');
  }

  interface PreconnectOptions {
    /**
     * URL for preconnect. Only the origin is relevant for opening the socket.
     */
    url: string;
    /**
     * number of sockets to preconnect. Must be between 1 and 6. Defaults to 1.
     */
    numSockets?: number;
  }

  interface PrintToPDFOptions {
    /**

exec
/bin/bash -lc "sed -n '23990,24025p' node_modules/electron/electron.d.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
     * Settings of web page's features.
     */
    webPreferences?: WebPreferences;
    /**
     * If present, the given WebContents will be adopted by the WebContentsView. A
     * WebContents may only be presented in one WebContentsView at a time.
     */
    webContents?: WebContents;
  }

  interface WebContentsWillFrameNavigateEventParams {
    /**
     * The URL the frame is navigating to.
     */
    url: string;
    /**
     * This event does not fire for same document navigations using window.history api
     * and reference fragment navigations. This property is always set to `false` for
     * this event.
     */
    isSameDocument: boolean;
    /**
     * True if the navigation is taking place in a main frame.
     */
    isMainFrame: boolean;
    /**
     * The frame to be navigated. May be `null` if accessed after the frame has either
     * navigated or been destroyed.
     */
    frame: (WebFrameMain) | (null);
    /**
     * The frame which initiated the navigation, which can be a parent frame (e.g. via
     * `window.open` with a frame's name), or null if the navigation was not initiated
     * by a frame. This can also be null if the initiating frame was deleted before the
     * event was emitted.
     */

exec
/bin/bash -lc 'cat apps/desktop/src/performance/launchMarks.ts' in /home/ice/dev/dohc
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
/bin/bash -lc "nl -ba apps/desktop/src/main.ts | sed -n '150,210p'; nl -ba scripts/check-desktop-local-first-baseline.mjs | sed -n '1,35p'; nl -ba package.json | sed -n '8,22p'; nl -ba packages/workspace-core/src/paths.ts | sed -n '1,8p'; nl -ba apps/desktop/src/renderer/DesktopFirstRun.tsx | sed -n '20,40p'" in /home/ice/dev/dohc
 succeeded in 119ms:
     1	import { spawnSync } from "node:child_process";
     2	import { existsSync } from "node:fs";
     3	
     4	// Tests must run under Node 22.13.x: Node 25 breaks 17 @dohc/web tests
     5	// (see execution log Environment section). Pin via PATH prefix; fail loudly
     6	// if the pinned toolchain is missing rather than silently using caller PATH.
     7	const pinnedNodeBin =
     8	  process.env.DOHC_TEST_NODE_BIN ?? "/home/ice/.local/share/nvm/v22.13.0/bin";
     9	const pnpmBin = "/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin";
    10	
    11	if (!existsSync(`${pinnedNodeBin}/node`)) {
    12	  console.error(`Pinned Node not found at ${pinnedNodeBin}/node.`);
    13	  console.error(
    14	    "Set DOHC_TEST_NODE_BIN to a Node 22.13+ bin directory (Node 25 breaks @dohc/web tests).",
    15	  );
    16	  process.exit(1);
    17	}
    18	
    19	const env = {
    20	  ...process.env,
    21	  PATH: `${pinnedNodeBin}:${pnpmBin}:${process.env.PATH ?? ""}`,
    22	};
    23	
    24	// Known pre-existing failures on main @ e2de7a3: 4 @dohc/web tests (see
    25	// execution log Gotchas). This allowance dies when those tests are fixed or
    26	// deleted with Convex in Phase 13 — do not add entries for new failures.
    27	const knownFailingBaseline = new Set(["pnpm --filter @dohc/web test"]);
    28	
    29	const commands = [
    30	  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
    31	  ["pnpm", ["--filter", "@dohc/web", "test"]],
    32	  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
    33	  ["pnpm", ["--filter", "@dohc/workspace-convex-compat", "test"]],
    34	  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
    35	  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
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
     1	export function defaultWorkspaceRoot(homeDir: string): string {
     2	  return `${homeDir.replace(/\/+$/, "")}/dohc`;
     3	}
     4	
     5	export type FolderValidation = { ok: true } | { ok: false; reason: string };
     6	
     7	// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
     8	function isAbsolutePathLike(path: string): boolean {
    20	  async function chooseFolder() {
    21	    const picked = await bridge().pickWorkspaceRoot();
    22	    if (picked) setRoot(picked);
    23	  }
    24	
    25	  async function createWorkspace() {
    26	    if (!root || creating) return;
    27	    setCreating(true);
    28	    try {
    29	      const workspace = await bridge().createLocalWorkspace({
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

exec
/bin/bash -lc 'rg "test:desktop:e2e|build:desktop|check:desktop" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md | head -50' in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:117:- Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:124:- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:174:- Commands run: install+electron --version (42.4.0); test RED→GREEN 7/7; typecheck PASS; build PASS (main ESM/preload CJS/renderer); test:desktop:e2e PASS 534ms; smoke:desktop PASS — all pinned Node 22.13
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:391:ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:645:"check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs"
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:655:pnpm check:desktop-local-first-baseline
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:812:- Desktop E2E gets its own `apps/desktop/playwright.config.ts` (testDir `./e2e`, `workers: 1` — Electron instances can't parallelize on one display, NO webServer block, ~60s per-test timeout). Root script becomes `"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts"`. The root `playwright.config.ts` (testDir `./apps/app/e2e`, web dev-server bootstrap) must remain untouched so `pnpm test:e2e` keeps working.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:880:"build:desktop": "pnpm --filter @dohc/desktop build",
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:882:"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:890:pnpm build:desktop
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:891:pnpm test:desktop:e2e
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:988:pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1076:pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1176:pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1246:pnpm test:desktop:e2e apps/desktop/e2e/fileTypes.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1315:pnpm test:desktop:e2e apps/desktop/e2e/localApps.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1370:pnpm test:desktop:e2e apps/desktop/e2e/sqliteImport.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1466:pnpm test:desktop:e2e apps/desktop/e2e/cloudLogin.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1467:pnpm test:desktop:e2e apps/desktop/e2e/cloudSync.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1573:pnpm test:desktop:e2e apps/desktop/e2e/collaboration.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1574:pnpm test:desktop:e2e apps/desktop/e2e/liveCoEditing.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1649:pnpm test:desktop:e2e apps/desktop/e2e/localAgent.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1743:pnpm check:desktop-local-first-baseline
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1763:pnpm test:desktop:e2e
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1821:pnpm build:desktop
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2049:pnpm test:desktop:e2e apps/desktop/e2e/performance.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2273:pnpm build:desktop
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2274:pnpm test:desktop:e2e
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2331:pnpm build:desktop
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2332:pnpm test:desktop:e2e

exec
/bin/bash -lc 'rg "/home/ice|DOHC_TEST_NODE_BIN|Node-pinned" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md | head -80' in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:16:- Toolchain freeze: tests run under Node v22.13.0 via PATH prefix `/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`. Shell default is Node v25.2.1 — Node 25 breaks 17 @dohc/web tests (verified 2026-06-10: AtomEditor.lifecycle suite 13/13 fail on 25, 13/13 pass on 22.13). Never run `nvm use`.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:18:- Codex: `/home/ice/.local/share/nvm/v25.2.1/bin/codex` (codex-cli 0.130.0, ChatGPT auth). Verified: `exec` read-only sandbox + `-m gpt-5.5 -c model_reasoning_effort="xhigh"` works (2026-06-10, 15.2K tokens). `gpt-5.5-fast` NOT available on this auth. Second install exists at `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex` (0.137.0-alpha.4, found by team audit) — using the verified 0.130.0; revisit only if review subcommand misbehaves.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:62:### t3code desktop renderer digest (source: /home/ice/dev/oss-repos/t3code/apps/desktop; digested 2026-06-10)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:115:- Execution map: env preflight (done: services healthy, node/codex/display recorded) → execution log (this file) → baseline script Node-pinned → baseline background run → inventory doc from recon digests → commit → codex review (high tier, background)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:117:- Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:124:- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:131:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-00.md): (1) baseline script fail-fasts on known web failures, can't reproduce recorded baseline at later gates — FIXED @ phase0(fix) commit (continue-on-error + summary + known-failure allowance that dies in Phase 13); (2) baseline omits @dohc/hocuspocus and @dohc/workspace-convex-compat suites — FIXED (both added); (3) pinned-Node path silently falls back to caller PATH on other machines — FIXED (existsSync check, DOHC_TEST_NODE_BIN override, hard error). Invocation gotcha discovered: `--commit` cannot combine with custom prompt (both codex versions) — plan updated with working pattern.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:230:- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:32:- Local reference implementation: `/home/ice/dev/oss-repos/t3code/apps/desktop`
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:175:1. Before first implementation in Phase 3: recon the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`) and record which layout, titlebar, panel, and status-surface patterns to adopt or reject.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:269:- the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:903:/home/ice/dev/oss-repos/t3code/apps/desktop/src/main.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:904:/home/ice/dev/oss-repos/t3code/apps/desktop/src/preload.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:905:/home/ice/dev/oss-repos/t3code/apps/desktop/src/electron
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2448:Work in /home/ice/dev/dohc.

exec
/bin/bash -lc "rg \"\\[P[0-3]\\]|finding|FAIL|PROBE-CONFIRMED|bug\" docs/superpowers/reviews/codex/phase-03.md docs/superpowers/reviews/codex/ui-phase-03.md -n | head -100" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/reviews/codex/phase-03.md:2770:../work/vacuumlabs/opnet/momoto-bug-repro/node_modules/ts-loader/AGENTS.md
docs/superpowers/reviews/codex/phase-03.md:4230:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/phase-03.md:4233:- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/phase-03.md:4236:- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
docs/superpowers/reviews/codex/phase-03.md:4242:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/phase-03.md:4245:- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/phase-03.md:4248:- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149

exec
/bin/bash -lc "sed -n '4200,4260p' docs/superpowers/reviews/codex/phase-03.md" in /home/ice/dev/dohc
 succeeded in 0ms:
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

exec
/bin/bash -lc "rg \"Full review comments|\\[P[0-3]\\]\" docs/superpowers/reviews/codex/phase-04.md docs/superpowers/reviews/codex/checkpoint-phase-04.md docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md -n | tail -100" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1198:./docs/superpowers/reviews/codex/phase-01.md:2612:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1200:./docs/superpowers/reviews/codex/phase-01.md:2615:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1201:./docs/superpowers/reviews/codex/phase-01.md:2618:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1202:./docs/superpowers/reviews/codex/phase-01.md:2624:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1204:./docs/superpowers/reviews/codex/phase-01.md:2627:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:1205:./docs/superpowers/reviews/codex/phase-01.md:2630:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
docs/superpowers/reviews/codex/phase-04.md:2699:./docs/superpowers/reviews/codex/phase-03.md:4230:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/phase-04.md:2701:./docs/superpowers/reviews/codex/phase-03.md:4242:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/phase-04.md:5356:1198:./docs/superpowers/reviews/codex/phase-01.md:2612:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
docs/superpowers/reviews/codex/phase-04.md:5358:1200:./docs/superpowers/reviews/codex/phase-01.md:2615:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
docs/superpowers/reviews/codex/phase-04.md:5359:1201:./docs/superpowers/reviews/codex/phase-01.md:2618:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
docs/superpowers/reviews/codex/phase-04.md:5360:1202:./docs/superpowers/reviews/codex/phase-01.md:2624:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
docs/superpowers/reviews/codex/phase-04.md:5362:1204:./docs/superpowers/reviews/codex/phase-01.md:2627:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
docs/superpowers/reviews/codex/phase-04.md:5363:1205:./docs/superpowers/reviews/codex/phase-01.md:2630:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
docs/superpowers/reviews/codex/phase-04.md:5566:Full review comments:
docs/superpowers/reviews/codex/phase-04.md:5568:- [P2] Reject UNC share roots as filesystem roots — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:101-101
docs/superpowers/reviews/codex/phase-04.md:5571:- [P2] Reject case variants of the home directory — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:104-104
docs/superpowers/reviews/codex/phase-04.md:5575:Full review comments:
docs/superpowers/reviews/codex/phase-04.md:5577:- [P2] Reject UNC share roots as filesystem roots — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:101-101
docs/superpowers/reviews/codex/phase-04.md:5580:- [P2] Reject case variants of the home directory — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:104-104
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4272:+Full review comments:
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4274:+- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4277:+- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4280:+- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4284:+Full review comments:
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4286:+- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4289:+- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/checkpoint-phase-04.md:4292:+- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13545:docs/superpowers/reviews/codex/phase-03.md:4230:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13546:docs/superpowers/reviews/codex/phase-03.md:4233:- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13547:docs/superpowers/reviews/codex/phase-03.md:4236:- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13548:docs/superpowers/reviews/codex/phase-03.md:4242:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13549:docs/superpowers/reviews/codex/phase-03.md:4245:- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13550:docs/superpowers/reviews/codex/phase-03.md:4248:- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13583:Full review comments:
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13585:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13588:- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13591:- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13595:Full review comments:
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13597:- [P1] Make workspace creation idempotent for existing roots — /home/ice/dev/dohc/apps/desktop/src/workspaces/createWorkspaceFolder.ts:34-37
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13600:- [P2] Require absolute paths for workspace roots — /home/ice/dev/dohc/apps/desktop/src/ipc/bridgeContract.ts:29-31
docs/superpowers/reviews/codex/checkpoint-phase-04.md:13603:- [P2] Clear workspace-local state when switching workspaces — /home/ice/dev/dohc/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:147-149

exec
/bin/bash -lc "sed -n '5540,5595p' docs/superpowers/reviews/codex/phase-04.md" in /home/ice/dev/dohc
 succeeded in 0ms:
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

exec
/bin/bash -lc "nl -ba packages/workspace-core/src/paths.ts | sed -n '88,110p'" in /home/ice/dev/dohc
 succeeded in 0ms:
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
   106	  }
   107	  return { ok: true, normalized };
   108	}
   109	
   110	export type PathClassification =

codex
The new workspace root guard still permits root-equivalent folders on common platforms, and the Electron lifecycle leaves macOS users without a window after closing the last one. These are actionable correctness issues for the desktop/local-first flow.

Full review comments:

- [P2] Reject UNC share roots as workspace roots — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:101-101
  When a Windows user chooses a UNC share root like `\\server\share`, `normalizeAbsolutePath()` produces `//server/share`, which is not equal to the bare `//` checked here. The new attach/open flow will then register and recursively list the entire share even though this guard says roots must not be attachable; require a child below the share before returning ok.

- [P2] Reject case variants of the home directory — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:104-104
  On Windows and default macOS, a path that differs only by case from `homeDir` denotes the same folder, but this exact comparison accepts it. If `homedir()` yields `C:/Users/Ice` and IPC/dialog input supplies `c:/users/ice`, `attachWorkspaceFolder` can register the user's home and list it recursively despite the guard; compare a case-folded or canonical form on case-insensitive platforms.

- [P2] Recreate a window on macOS activation — /home/ice/dev/dohc/apps/desktop/src/main.ts:182-184
  On macOS, this handler intentionally keeps the app alive after the last window closes, but there is no corresponding `app.on("activate")` path to call `createMainWindow()` when the Dock icon is clicked. After a user closes the only window, dohc stays running with no way to reopen a workspace except quitting and relaunching.
The new workspace root guard still permits root-equivalent folders on common platforms, and the Electron lifecycle leaves macOS users without a window after closing the last one. These are actionable correctness issues for the desktop/local-first flow.

Full review comments:

- [P2] Reject UNC share roots as workspace roots — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:101-101
  When a Windows user chooses a UNC share root like `\\server\share`, `normalizeAbsolutePath()` produces `//server/share`, which is not equal to the bare `//` checked here. The new attach/open flow will then register and recursively list the entire share even though this guard says roots must not be attachable; require a child below the share before returning ok.

- [P2] Reject case variants of the home directory — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:104-104
  On Windows and default macOS, a path that differs only by case from `homeDir` denotes the same folder, but this exact comparison accepts it. If `homedir()` yields `C:/Users/Ice` and IPC/dialog input supplies `c:/users/ice`, `attachWorkspaceFolder` can register the user's home and list it recursively despite the guard; compare a case-folded or canonical form on case-insensitive platforms.

- [P2] Recreate a window on macOS activation — /home/ice/dev/dohc/apps/desktop/src/main.ts:182-184
  On macOS, this handler intentionally keeps the app alive after the last window closes, but there is no corresponding `app.on("activate")` path to call `createMainWindow()` when the Dock icon is clicked. After a user closes the only window, dohc stays running with no way to reopen a workspace except quitting and relaunching.
