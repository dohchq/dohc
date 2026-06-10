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

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/preload.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
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

exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/security/electronSecurity.ts" in /home/ice/dev/dohc
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

exec
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/ipc/bridgeContract.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,160p' apps/desktop/src/ipc/channels.ts" in /home/ice/dev/dohc
 succeeded in 102ms:
 succeeded in 102ms:
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

codex
The payload schemas currently require strings and basic enums, while most path safety appears to depend on workspace-core validators plus a final `relative()` guard in `listFiles`. I’m checking tests and the workspace-core package now so the scenarios point at the exact invariants the code actually relies on.
exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/createWorkspaceFolder.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/workspaceFiles.ts" in /home/ice/dev/dohc
 succeeded in 106ms:
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

 succeeded in 107ms:
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
/bin/bash -lc "sed -n '1,240p' apps/desktop/src/workspaces/WorkspaceRegistry.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/workspaces/registryStore.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc 'rg -n "validateWorkspaceRootChoice|validateAttachedFolder|validateUserWritePath|defaultWorkspaceRoot|workspace-core" -S .' in /home/ice/dev/dohc
 succeeded in 110ms:
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

 succeeded in 110ms:
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

 succeeded in 115ms:
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:541:  workspace-core/           # local-first workspace model, modes, paths, change sets
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:675:- Create: `packages/workspace-core/package.json`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:676:- Create: `packages/workspace-core/tsconfig.json`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:677:- Create: `packages/workspace-core/src/workspaceMode.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:678:- Create: `packages/workspace-core/src/paths.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:679:- Create: `packages/workspace-core/src/metadata.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:680:- Create: `packages/workspace-core/src/changeSet.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:681:- Create: `packages/workspace-core/src/conflicts.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:682:- Create: `packages/workspace-core/src/index.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:683:- Create: `packages/workspace-core/src/workspaceMode.test.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:684:- Create: `packages/workspace-core/src/paths.test.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:685:- Create: `packages/workspace-core/src/changeSet.test.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:740:pnpm --filter @dohc/workspace-core test
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:741:pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:748:Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:753:git add packages/workspace-core package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1024:- Modify: `packages/workspace-core/src/metadata.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1084:git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1269:- Create: `packages/workspace-core/src/apps.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1270:- Create: `packages/workspace-core/src/apps.test.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1323:git add packages/workspace-core apps/desktop services/app-tester docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1334:- Create: `packages/workspace-core/src/databases.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1335:- Create: `packages/workspace-core/src/databases.test.ts`
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1369:pnpm --filter @dohc/workspace-core test src/databases.test.ts
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1378:git add packages/workspace-core services/sqlite-worker apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1731:| atom create/read/write | workspace-core/workspace-sync/workspace-postgres tests | pass |
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2151:packages/workspace-core
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2222:workspace path validation -> packages/workspace-core
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2223:file type detection -> packages/workspace-core
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2227:database file rules -> packages/workspace-core + sqlite-worker
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:6:- Expected test state: workspace-core 40/40, desktop 37/37, E2E 4/4, smoke green — all committed
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:129:- Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:132:- Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:134:- Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:136:- Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:177:- Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:183:- Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:187:- Failing tests fixed: ESM workspace-core load crash (bundling); vitest .tsx glob gap
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:191:- Security/collaboration regressions: all new channels sender-validated + zod-parsed payloads/results; file ops traversal-guarded via workspace-core
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:192:- Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:193:- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:202:- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:204:- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:210:- Tests added: 3 workspace-core (root-choice), 5 registryStore, 1 first-run component (attach), 1 E2E (attach preserves manifest identity, file tree shows existing files)
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:217:- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
./packages/workspace-core/package.json:2:  "name": "@dohc/workspace-core",
./packages/workspace-core/src/paths.ts:1:export function defaultWorkspaceRoot(homeDir: string): string {
./packages/workspace-core/src/paths.ts:16:export function validateAttachedFolder(path: string): FolderValidation {
./packages/workspace-core/src/paths.ts:34:export function validateUserWritePath(relativePath: string): WritePathValidation {
./packages/workspace-core/src/paths.ts:93:export function validateWorkspaceRootChoice(
./packages/workspace-core/src/paths.ts:97:  const attached = validateAttachedFolder(rootPath);
./packages/workspace-core/src/paths.test.ts:4:  defaultWorkspaceRoot,
./packages/workspace-core/src/paths.test.ts:6:  validateAttachedFolder,
./packages/workspace-core/src/paths.test.ts:7:  validateUserWritePath,
./packages/workspace-core/src/paths.test.ts:12:    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
./packages/workspace-core/src/paths.test.ts:16:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:17:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:21:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:22:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:23:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
./packages/workspace-core/src/paths.test.ts:27:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./packages/workspace-core/src/paths.test.ts:40:    const result = validateUserWritePath(".DoHc/manifest.json");
./packages/workspace-core/src/paths.test.ts:46:    const result = validateUserWritePath(".dohc/manifest.json");
./packages/workspace-core/src/paths.test.ts:66:      const result = validateUserWritePath(candidate);
./packages/workspace-core/src/paths.test.ts:73:    const result = validateUserWritePath("/etc/passwd");
./packages/workspace-core/src/paths.test.ts:84:      const result = validateUserWritePath(candidate);
./packages/workspace-core/src/paths.test.ts:91:    const result = validateUserWritePath("%2fetc/passwd");
./packages/workspace-core/src/paths.test.ts:97:    const result = validateUserWritePath("notes/a\0b.md");
./packages/workspace-core/src/paths.test.ts:103:    const result = validateUserWritePath("finance/./reports/q1.md");
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
./apps/desktop/package.json:34:    "@dohc/workspace-core": "workspace:*",
./apps/desktop/electron.vite.config.ts:9:    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:7:} from "@dohc/workspace-core";
./apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./apps/desktop/src/workspaces/workspaceFiles.ts:3:  validateUserWritePath,
./apps/desktop/src/workspaces/workspaceFiles.ts:4:} from "@dohc/workspace-core";
./apps/desktop/src/workspaces/workspaceFiles.ts:44:  const validated = validateUserWritePath(relativePath);
./apps/desktop/src/workspaces/workspaceFiles.ts:65:    const validated = validateUserWritePath(name);
./apps/desktop/src/main.ts:2:  defaultWorkspaceRoot,
./apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
./apps/desktop/src/main.ts:4:} from "@dohc/workspace-core";
./apps/desktop/src/main.ts:86:      defaultWorkspaceRoot(effectiveHome()),
./apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./pnpm-lock.yaml:216:      '@dohc/workspace-core':
./pnpm-lock.yaml:218:        version: link:../../packages/workspace-core
./pnpm-lock.yaml:333:  packages/workspace-core:
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:49:apps/desktop/src/main.ts:3:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:59:apps/desktop/src/main.ts:94:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:106:apps/desktop/src/workspaces/createWorkspaceFolder.ts:4:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:107:apps/desktop/src/workspaces/createWorkspaceFolder.ts:43:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:129:apps/desktop/src/workspaces/workspaceFiles.ts:3:  validateUserWritePath,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:130:apps/desktop/src/workspaces/workspaceFiles.ts:44:  const validated = validateUserWritePath(relativePath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:136:apps/desktop/src/workspaces/workspaceFiles.ts:65:    const validated = validateUserWritePath(name);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:147:  defaultWorkspaceRoot,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:148:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:149:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:231:      defaultWorkspaceRoot(effectiveHome()),
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:239:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:488:The payload schemas currently require strings and basic enums, while most path safety appears to depend on workspace-core validators plus a final `relative()` guard in `listFiles`. I’m checking tests and the workspace-core package now so the scenarios point at the exact invariants the code actually relies on.
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:497:  validateAttachedFolder,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:500:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:536:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:583:  validateUserWritePath,
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:584:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:624:  const validated = validateUserWritePath(relativePath);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:645:    const validated = validateUserWritePath(name);
./docs/superpowers/reviews/codex/adversarial-scenarios-phase-04.md:662:/bin/bash -lc 'rg -n "validateWorkspaceRootChoice|validateAttachedFolder|validateUserWritePath|defaultWorkspaceRoot|workspace-core" -S .' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-04.md:34: packages/workspace-core/src/paths.test.ts          | 48 +++++++++++++
./docs/superpowers/reviews/codex/phase-04.md:35: packages/workspace-core/src/paths.ts               | 48 +++++++++++++
./docs/superpowers/reviews/codex/phase-04.md:517:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:519:+  defaultWorkspaceRoot,
./docs/superpowers/reviews/codex/phase-04.md:520:+  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/phase-04.md:521:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:603:       defaultWorkspaceRoot(effectiveHome()),
./docs/superpowers/reviews/codex/phase-04.md:611:+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/phase-04.md:1381: - Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
./docs/superpowers/reviews/codex/phase-04.md:1384: - Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
./docs/superpowers/reviews/codex/phase-04.md:1386: - Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
./docs/superpowers/reviews/codex/phase-04.md:1388: - Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
./docs/superpowers/reviews/codex/phase-04.md:1429: - Execution map: reuse-map recon (artifact committed in phase2 fix) → renderer deps installed (react 19.2.6/tailwind 4/@dohc/brand/lucide, TS+types repinned to repo standards) → failing tests written (6 first-run component tests + 2-test native UX E2E) → RED recorded (incl. catching vitest glob missing .tsx — fixed) → bridge extensions (4 new validated channels) + workspaces service (registry w/ test-home seam, createWorkspaceFolder w/ workspace-core manifest, file ops via validateUserWritePath) → React shell (FirstRun/Shell/Palette/NewFileDialog/theme/styles on shared brand tokens) → ESM crash fixed (electron-vite must bundle workspace pkgs — externalizeDepsPlugin exclude) → GREEN 20/20 unit + 3/3 E2E + smoke → design loop (2 Claude judges gating + codex -i advisory) → 3 soft fixes → all green again
./docs/superpowers/reviews/codex/phase-04.md:1435: - Dependencies added: react/react-dom 19.2.6, lucide-react, @dohc/brand + @dohc/workspace-core (workspace), tailwindcss 4 + @tailwindcss/vite, @vitejs/plugin-react, testing-library trio + jsdom (dev)
./docs/superpowers/reviews/codex/phase-04.md:1439: - Failing tests fixed: ESM workspace-core load crash (bundling); vitest .tsx glob gap
./docs/superpowers/reviews/codex/phase-04.md:1443: - Security/collaboration regressions: all new channels sender-validated + zod-parsed payloads/results; file ops traversal-guarded via workspace-core
./docs/superpowers/reviews/codex/phase-04.md:1444: - Reviewer/subagent findings: verifiers wf_5ff43339-c71 — test-quality PASS (deletion mutation bites; manifest-content/keyboard-file/relaunch assertions all real, no sleeps; createFile traversal-proof incl. wx no-overwrite; listFiles skips ignored dirs, doesn't follow symlinks; doctored workspaceId fails closed). One tracked note → Phase 4: CreateLocalWorkspacePayload.rootPath is only z.string().min(1) — a compromised renderer could register "/" or $HOME as a workspace then enumerate/create-empty broadly; Phase 4 attachment rules MUST add root validation (validateAttachedFolder + reject root/home-itself). claimed-vs-actual initially killed by session limit; re-run via workflow resume (cached test-quality) — verdict FAIL on plan-completeness (every claim true, gates green, hunts clean, but 5 plan-required shell elements missing). HONORED: all 5 built in iteration 2 rather than deferred. Design loop iteration 2 judge: PASS, zero hard fails, all 10 plan shell elements verified present (code+screenshot evidence); 2 polish notes (offer-row gutter, Ctrl P hint) applied same-pass.
./docs/superpowers/reviews/codex/phase-04.md:1445: - Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-03.md): (1) P1 creating over an existing dohc workspace overwrote its manifest, severing workspaceId identity for sync/history — FIXED (adopt existing manifest, keep identity; unit-tested with recorded RED); (2) P2 rootPath accepted relative paths (created .dohc relative to process cwd) — FIXED (validateAttachedFolder in createWorkspaceFolder; also closes the verifier's tracked rootPath note at the absolute-path level — Phase 4 still adds root/home-itself rejection); (3) P2 stale files/selection leaked across workspace switch — FIXED (shell keyed by workspaceId, remount on switch). 30/30 unit + 3/3 E2E + smoke green after fixes.
./docs/superpowers/reviews/codex/phase-04.md:1454:+- Execution map: workspace-core validateWorkspaceRootChoice tests-first (RED 3) → impl (rejects "/", home-itself, drive roots, relative) → registryStore extracted as pure module, tests-first (RED: missing module; 5 tests: multi-attach, duplicate rejection w/ message, persistence across instances, local-only-no-remote, remote-identity-only-after-setRemote) → WorkspaceRegistry rewired as electron shim over store → attachWorkspaceFolder IPC (validated, adopts-or-creates) + DOHC_TEST_PICK_PATH dialog seam (test+unpackaged gated) → first-run "Open an existing folder" + component test → attach-preserves-identity E2E → 36/36 unit + 4/4 E2E + typecheck + build + smoke green
./docs/superpowers/reviews/codex/phase-04.md:1456:+- Files changed: packages/workspace-core/src/paths.{ts,test.ts} (+validateWorkspaceRootChoice), apps/desktop/src/workspaces/{registryStore.ts,registryStore.test.ts,WorkspaceRegistry.ts}, ipc/{channels,bridgeContract}.ts (+attach), main.ts (root-choice enforcement on create+attach, attach handler, pick seam), preload.ts, renderer/DesktopFirstRun.{tsx,test.tsx}, e2e/firstRunWorkspace.spec.ts (+attach test)
./docs/superpowers/reviews/codex/phase-04.md:1462:+- Tests added: 3 workspace-core (root-choice), 5 registryStore, 1 first-run component (attach), 1 E2E (attach preserves manifest identity, file tree shows existing files)
./docs/superpowers/reviews/codex/phase-04.md:1469:+- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.
./docs/superpowers/reviews/codex/phase-04.md:1475:diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
./docs/superpowers/reviews/codex/phase-04.md:1477:--- a/packages/workspace-core/src/paths.test.ts
./docs/superpowers/reviews/codex/phase-04.md:1478:+++ b/packages/workspace-core/src/paths.test.ts
./docs/superpowers/reviews/codex/phase-04.md:1491:     const result = validateUserWritePath(".DoHc/manifest.json");
./docs/superpowers/reviews/codex/phase-04.md:1497:     const result = validateUserWritePath(".dohc/manifest.json");
./docs/superpowers/reviews/codex/phase-04.md:1517:       const result = validateUserWritePath(candidate);
./docs/superpowers/reviews/codex/phase-04.md:1524:     const result = validateUserWritePath("/etc/passwd");
./docs/superpowers/reviews/codex/phase-04.md:1535:       const result = validateUserWritePath(candidate);
./docs/superpowers/reviews/codex/phase-04.md:1542:     const result = validateUserWritePath("%2fetc/passwd");
./docs/superpowers/reviews/codex/phase-04.md:1548:     const result = validateUserWritePath("notes/a\0b.md");
./docs/superpowers/reviews/codex/phase-04.md:1554:     const result = validateUserWritePath("finance/./reports/q1.md");
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
./docs/superpowers/reviews/codex/phase-04.md:1630:diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-04.md:1632:--- a/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-04.md:1633:+++ b/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-04.md:1635: export function defaultWorkspaceRoot(homeDir: string): string {
./docs/superpowers/reviews/codex/phase-04.md:1650: export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-04.md:1668: export function validateUserWritePath(relativePath: string): WritePathValidation {
./docs/superpowers/reviews/codex/phase-04.md:1727:+export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/phase-04.md:1731:+  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/phase-04.md:1764:/bin/bash -lc 'git show ce6910a -- apps/desktop/src/workspaces/WorkspaceRegistry.ts apps/desktop/src/workspaces/registryStore.ts apps/desktop/src/workspaces/registryStore.test.ts apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/renderer/DesktopFirstRun.tsx apps/desktop/src/renderer/DesktopFirstRun.test.tsx packages/workspace-core/src/paths.ts --unified=120' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-04.md:1787:-import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:1789:+  defaultWorkspaceRoot,
./docs/superpowers/reviews/codex/phase-04.md:1790:+  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/phase-04.md:1791:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:1818:+    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/phase-04.md:2192:diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-04.md:2194:--- a/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-04.md:2195:+++ b/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-04.md:2196:@@ -59,6 +59,54 @@ export function validateUserWritePath(relativePath: string): WritePathValidation
./docs/superpowers/reviews/codex/phase-04.md:2231:+export function validateWorkspaceRootChoice(
./docs/superpowers/reviews/codex/phase-04.md:2235:+  const attached = validateAttachedFolder(rootPath);
./docs/superpowers/reviews/codex/phase-04.md:2256:  defaultWorkspaceRoot,
./docs/superpowers/reviews/codex/phase-04.md:2257:  validateWorkspaceRootChoice,
./docs/superpowers/reviews/codex/phase-04.md:2258:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2340:      defaultWorkspaceRoot(effectiveHome()),
./docs/superpowers/reviews/codex/phase-04.md:2348:    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
./docs/superpowers/reviews/codex/phase-04.md:2445:  validateAttachedFolder,
./docs/superpowers/reviews/codex/phase-04.md:2448:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2484:  const folderCheck = validateAttachedFolder(input.rootPath);
./docs/superpowers/reviews/codex/phase-04.md:2531:  validateUserWritePath,
./docs/superpowers/reviews/codex/phase-04.md:2532:} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-04.md:2572:  const validated = validateUserWritePath(relativePath);
./docs/superpowers/reviews/codex/phase-04.md:2593:    const validated = validateUserWritePath(name);
./docs/superpowers/reviews/codex/phase-03.md:70:    via workspace-core, no account); shell ships every plan-required
./docs/superpowers/reviews/codex/phase-03.md:213:+import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:291:+      defaultWorkspaceRoot(effectiveHome()),
./docs/superpowers/reviews/codex/phase-03.md:485:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:541:+  validateUserWritePath,
./docs/superpowers/reviews/codex/phase-03.md:542:+} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:582:+  const validated = validateUserWritePath(relativePath);
./docs/superpowers/reviews/codex/phase-03.md:603:+    const validated = validateUserWritePath(name);
./docs/superpowers/reviews/codex/phase-03.md:625:    via workspace-core, no account); shell ships every plan-required
./docs/superpowers/reviews/codex/phase-03.md:1472:    via workspace-core, no account); shell ships every plan-required
./docs/superpowers/reviews/codex/phase-03.md:1702:+    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
./docs/superpowers/reviews/codex/phase-03.md:1767:+    "@dohc/workspace-core": "workspace:*",
./docs/superpowers/reviews/codex/phase-03.md:2004:    via workspace-core, no account); shell ships every plan-required
./docs/superpowers/reviews/codex/phase-03.md:2101:/bin/bash -lc "ls packages && git ls-files packages/workspace-core packages/brand apps/desktop/src | sed -n '1,200p'" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-03.md:2107:workspace-core
./docs/superpowers/reviews/codex/phase-03.md:2138:packages/workspace-core/package.json
./docs/superpowers/reviews/codex/phase-03.md:2139:packages/workspace-core/src/changeSet.test.ts
./docs/superpowers/reviews/codex/phase-03.md:2140:packages/workspace-core/src/changeSet.ts
./docs/superpowers/reviews/codex/phase-03.md:2141:packages/workspace-core/src/conflicts.ts
./docs/superpowers/reviews/codex/phase-03.md:2142:packages/workspace-core/src/index.ts
./docs/superpowers/reviews/codex/phase-03.md:2143:packages/workspace-core/src/metadata.ts
./docs/superpowers/reviews/codex/phase-03.md:2144:packages/workspace-core/src/paths.test.ts
./docs/superpowers/reviews/codex/phase-03.md:2145:packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-03.md:2146:packages/workspace-core/src/workspaceMode.test.ts
./docs/superpowers/reviews/codex/phase-03.md:2147:packages/workspace-core/src/workspaceMode.ts
./docs/superpowers/reviews/codex/phase-03.md:2148:packages/workspace-core/tsconfig.json
./docs/superpowers/reviews/codex/phase-03.md:2151:/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/index.ts && sed -n '1,240p' packages/workspace-core/src/paths.ts && sed -n '1,240p' packages/workspace-core/src/workspaceMode.ts && cat packages/workspace-core/package.json" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-03.md:2158:export function defaultWorkspaceRoot(homeDir: string): string {
./docs/superpowers/reviews/codex/phase-03.md:2173:export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-03.md:2191:export function validateUserWritePath(relativePath: string): WritePathValidation {
./docs/superpowers/reviews/codex/phase-03.md:2254:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-03.md:2272:/bin/bash -lc "sed -n '1,240p' packages/workspace-core/src/metadata.ts && sed -n '1,180p' packages/workspace-core/src/paths.test.ts" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-03.md:2313:  defaultWorkspaceRoot,
./docs/superpowers/reviews/codex/phase-03.md:2315:  validateAttachedFolder,
./docs/superpowers/reviews/codex/phase-03.md:2316:  validateUserWritePath,
./docs/superpowers/reviews/codex/phase-03.md:2321:    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
./docs/superpowers/reviews/codex/phase-03.md:2325:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2326:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2330:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2331:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2332:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-03.md:2336:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/reviews/codex/phase-03.md:2349:    const result = validateUserWritePath(".DoHc/manifest.json");
./docs/superpowers/reviews/codex/phase-03.md:2355:    const result = validateUserWritePath(".dohc/manifest.json");
./docs/superpowers/reviews/codex/phase-03.md:2375:      const result = validateUserWritePath(candidate);
./docs/superpowers/reviews/codex/phase-03.md:2382:    const result = validateUserWritePath("/etc/passwd");
./docs/superpowers/reviews/codex/phase-03.md:2393:      const result = validateUserWritePath(candidate);
./docs/superpowers/reviews/codex/phase-03.md:2400:    const result = validateUserWritePath("%2fetc/passwd");
./docs/superpowers/reviews/codex/phase-03.md:2406:    const result = validateUserWritePath("notes/a\0b.md");
./docs/superpowers/reviews/codex/phase-03.md:2412:    const result = validateUserWritePath("finance/./reports/q1.md");
./docs/superpowers/reviews/codex/phase-03.md:2442:/bin/bash -lc "grep -R \"personal\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md packages/workspace-core apps/desktop | sed -n '1,200p'" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-03.md:2458:packages/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
./docs/superpowers/reviews/codex/phase-03.md:2459:packages/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
./docs/superpowers/reviews/codex/phase-03.md:2460:packages/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
./docs/superpowers/reviews/codex/phase-03.md:2461:packages/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
./docs/superpowers/reviews/codex/phase-03.md:2471:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:6:  it("defaults personal workspaces to local-first", () => {
./docs/superpowers/reviews/codex/phase-03.md:2472:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.test.ts:7:    expect(defaultWorkspaceMode("personal")).toBe("local-first");
./docs/superpowers/reviews/codex/phase-03.md:2473:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:6:export type WorkspaceKind = "personal" | "shared" | "cloud-only";
./docs/superpowers/reviews/codex/phase-03.md:2474:apps/desktop/node_modules/@dohc/workspace-core/src/workspaceMode.ts:9:  personal: "local-first",
./docs/superpowers/reviews/codex/phase-03.md:2581:- Modify: `packages/workspace-core/src/metadata.ts`
./docs/superpowers/reviews/codex/phase-03.md:2646:git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/reviews/codex/phase-03.md:3045:     5	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:3398:     1	import { defaultWorkspaceRoot } from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:3474:    77	      defaultWorkspaceRoot(effectiveHome()),
./docs/superpowers/reviews/codex/phase-03.md:3550:     3	  validateUserWritePath,
./docs/superpowers/reviews/codex/phase-03.md:3551:     4	} from "@dohc/workspace-core";
./docs/superpowers/reviews/codex/phase-03.md:3591:    44	  const validated = validateUserWritePath(relativePath);
./docs/superpowers/reviews/codex/phase-03.md:3612:    65	    const validated = validateUserWritePath(name);
./docs/superpowers/reviews/codex/phase-03.md:3939:    via workspace-core, no account); shell ships every plan-required
./docs/superpowers/reviews/codex/phase-03.md:4018:+      '@dohc/workspace-core':
./docs/superpowers/reviews/codex/phase-03.md:4020:+        version: link:../../packages/workspace-core
./docs/superpowers/reviews/codex/phase-03.md:4135:   packages/workspace-core:
./docs/superpowers/reviews/codex/phase-03.md:4183:    via workspace-core, no account); shell ships every plan-required
./docs/superpowers/reviews/codex/phase-03.md:4234:  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
./docs/superpowers/reviews/codex/phase-03.md:4246:  When this IPC payload is called with a relative `rootPath`, the main process creates `.dohc` and `.context` relative to the Electron process cwd rather than a user-selected folder. Since the preload bridge exposes this method to renderer code and workspace-core already requires attached folders to be absolute, validate/refine `rootPath` with that invariant before calling `createWorkspaceFolder`.
./docs/superpowers/reviews/codex/phase-00.md:242:+- Exact next action: `git add` Phase 0 files → commit "Inventory old plan for desktop local-first pivot" → launch codex review (high tier, background) → Phase 1 read-only prep (workspace-core test design) while review runs
./docs/superpowers/reviews/codex/phase-00.md:910:   workspace-core/           # local-first workspace model, modes, paths, change sets
./docs/superpowers/reviews/codex/phase-00.md:1046: - Create: `packages/workspace-core/package.json`
./docs/superpowers/reviews/codex/phase-00.md:1047: - Create: `packages/workspace-core/tsconfig.json`
./docs/superpowers/reviews/codex/phase-00.md:1048: - Create: `packages/workspace-core/src/workspaceMode.ts`
./docs/superpowers/reviews/codex/phase-00.md:1049: - Create: `packages/workspace-core/src/paths.ts`
./docs/superpowers/reviews/codex/phase-00.md:1050: - Create: `packages/workspace-core/src/metadata.ts`
./docs/superpowers/reviews/codex/phase-00.md:1051: - Create: `packages/workspace-core/src/changeSet.ts`
./docs/superpowers/reviews/codex/phase-00.md:1052: - Create: `packages/workspace-core/src/conflicts.ts`
./docs/superpowers/reviews/codex/phase-00.md:1053: - Create: `packages/workspace-core/src/index.ts`
./docs/superpowers/reviews/codex/phase-00.md:1054: - Create: `packages/workspace-core/src/workspaceMode.test.ts`
./docs/superpowers/reviews/codex/phase-00.md:1055: - Create: `packages/workspace-core/src/paths.test.ts`
./docs/superpowers/reviews/codex/phase-00.md:1056: - Create: `packages/workspace-core/src/changeSet.test.ts`
./docs/superpowers/reviews/codex/phase-00.md:1111: pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/phase-00.md:1112: pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/phase-00.md:1119: Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.
./docs/superpowers/reviews/codex/phase-00.md:1124: git add packages/workspace-core package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/reviews/codex/phase-00.md:1399: - Modify: `packages/workspace-core/src/metadata.ts`
./docs/superpowers/reviews/codex/phase-00.md:1459: git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/reviews/codex/phase-00.md:1646: - Create: `packages/workspace-core/src/apps.ts`
./docs/superpowers/reviews/codex/phase-00.md:1647: - Create: `packages/workspace-core/src/apps.test.ts`
./docs/superpowers/reviews/codex/phase-00.md:1700: git add packages/workspace-core apps/desktop services/app-tester docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/reviews/codex/phase-00.md:1711: - Create: `packages/workspace-core/src/databases.ts`
./docs/superpowers/reviews/codex/phase-00.md:1712: - Create: `packages/workspace-core/src/databases.test.ts`
./docs/superpowers/reviews/codex/phase-00.md:1746: pnpm --filter @dohc/workspace-core test src/databases.test.ts
./docs/superpowers/reviews/codex/phase-00.md:1755: git add packages/workspace-core services/sqlite-worker apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/reviews/codex/phase-00.md:2124: | atom create/read/write | workspace-core/workspace-sync/workspace-postgres tests | pass |
./docs/superpowers/reviews/codex/phase-00.md:2517: workspace path validation -> packages/workspace-core
./docs/superpowers/reviews/codex/phase-00.md:2518: file type detection -> packages/workspace-core
./docs/superpowers/reviews/codex/phase-00.md:2522: database file rules -> packages/workspace-core + sqlite-worker
./docs/superpowers/reviews/codex/phase-00.md:4770:@dohc/workspace-core	packages/workspace-core/package.json	vitest run
./docs/superpowers/reviews/codex/phase-00.md:4794:/bin/bash -lc 'git status --short packages/workspace-core && git log --oneline -- packages/workspace-core/package.json | head' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-00.md:4796:?? packages/workspace-core/
./docs/superpowers/reviews/codex/phase-02.md:1268:-- Expected test state: workspace-core 31/31 green; baseline green (11 PASS + 1 KNOWN-FAIL web)
./docs/superpowers/reviews/codex/phase-02.md:1386: - Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
./docs/superpowers/reviews/codex/phase-02.md:1389: - Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
./docs/superpowers/reviews/codex/phase-02.md:1391: - Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
./docs/superpowers/reviews/codex/phase-02.md:1393: - Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
./docs/superpowers/reviews/codex/phase-01.md:22: packages/workspace-core/package.json               | 17 ++++
./docs/superpowers/reviews/codex/phase-01.md:23: packages/workspace-core/src/changeSet.test.ts      | 84 ++++++++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:24: packages/workspace-core/src/changeSet.ts           | 57 +++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:25: packages/workspace-core/src/conflicts.ts           | 13 +++
./docs/superpowers/reviews/codex/phase-01.md:26: packages/workspace-core/src/index.ts               |  5 ++
./docs/superpowers/reviews/codex/phase-01.md:27: packages/workspace-core/src/metadata.ts            | 36 ++++++++
./docs/superpowers/reviews/codex/phase-01.md:28: packages/workspace-core/src/paths.test.ts          | 99 ++++++++++++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:29: packages/workspace-core/src/paths.ts               | 66 +++++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:30: packages/workspace-core/src/workspaceMode.test.ts  | 32 +++++++
./docs/superpowers/reviews/codex/phase-01.md:31: packages/workspace-core/src/workspaceMode.ts       | 16 ++++
./docs/superpowers/reviews/codex/phase-01.md:32: packages/workspace-core/tsconfig.json              |  4 +
./docs/superpowers/reviews/codex/phase-01.md:37:/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 67d692f -- packages/workspace-core/src packages/workspace-core/package.json packages/workspace-core/tsconfig.json pnpm-lock.yaml' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-01.md:54:diff --git a/packages/workspace-core/package.json b/packages/workspace-core/package.json
./docs/superpowers/reviews/codex/phase-01.md:58:+++ b/packages/workspace-core/package.json
./docs/superpowers/reviews/codex/phase-01.md:61:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-01.md:77:diff --git a/packages/workspace-core/src/changeSet.test.ts b/packages/workspace-core/src/changeSet.test.ts
./docs/superpowers/reviews/codex/phase-01.md:81:+++ b/packages/workspace-core/src/changeSet.test.ts
./docs/superpowers/reviews/codex/phase-01.md:167:diff --git a/packages/workspace-core/src/changeSet.ts b/packages/workspace-core/src/changeSet.ts
./docs/superpowers/reviews/codex/phase-01.md:171:+++ b/packages/workspace-core/src/changeSet.ts
./docs/superpowers/reviews/codex/phase-01.md:230:diff --git a/packages/workspace-core/src/conflicts.ts b/packages/workspace-core/src/conflicts.ts
./docs/superpowers/reviews/codex/phase-01.md:234:+++ b/packages/workspace-core/src/conflicts.ts
./docs/superpowers/reviews/codex/phase-01.md:249:diff --git a/packages/workspace-core/src/index.ts b/packages/workspace-core/src/index.ts
./docs/superpowers/reviews/codex/phase-01.md:253:+++ b/packages/workspace-core/src/index.ts
./docs/superpowers/reviews/codex/phase-01.md:260:diff --git a/packages/workspace-core/src/metadata.ts b/packages/workspace-core/src/metadata.ts
./docs/superpowers/reviews/codex/phase-01.md:264:+++ b/packages/workspace-core/src/metadata.ts
./docs/superpowers/reviews/codex/phase-01.md:302:diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
./docs/superpowers/reviews/codex/phase-01.md:306:+++ b/packages/workspace-core/src/paths.test.ts
./docs/superpowers/reviews/codex/phase-01.md:311:+  defaultWorkspaceRoot,
./docs/superpowers/reviews/codex/phase-01.md:313:+  validateAttachedFolder,
./docs/superpowers/reviews/codex/phase-01.md:314:+  validateUserWritePath,
./docs/superpowers/reviews/codex/phase-01.md:319:+    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
./docs/superpowers/reviews/codex/phase-01.md:323:+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-01.md:324:+    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
./docs/superpowers/reviews/codex/phase-01.md:328:+    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
./docs/superpowers/reviews/codex/phase-01.md:340:+    const result = validateUserWritePath(".dohc/manifest.json");
./docs/superpowers/reviews/codex/phase-01.md:360:+      const result = validateUserWritePath(candidate);
./docs/superpowers/reviews/codex/phase-01.md:367:+    const result = validateUserWritePath("/etc/passwd");
./docs/superpowers/reviews/codex/phase-01.md:373:+    const result = validateUserWritePath("notes/a\0b.md");
./docs/superpowers/reviews/codex/phase-01.md:379:+    const result = validateUserWritePath("finance/./reports/q1.md");
./docs/superpowers/reviews/codex/phase-01.md:407:diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-01.md:411:+++ b/packages/workspace-core/src/paths.ts
./docs/superpowers/reviews/codex/phase-01.md:413:+export function defaultWorkspaceRoot(homeDir: string): string {
./docs/superpowers/reviews/codex/phase-01.md:419:+export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-01.md:436:+export function validateUserWritePath(relativePath: string): WritePathValidation {
./docs/superpowers/reviews/codex/phase-01.md:479:diff --git a/packages/workspace-core/src/workspaceMode.test.ts b/packages/workspace-core/src/workspaceMode.test.ts
./docs/superpowers/reviews/codex/phase-01.md:483:+++ b/packages/workspace-core/src/workspaceMode.test.ts
./docs/superpowers/reviews/codex/phase-01.md:517:diff --git a/packages/workspace-core/src/workspaceMode.ts b/packages/workspace-core/src/workspaceMode.ts
./docs/superpowers/reviews/codex/phase-01.md:521:+++ b/packages/workspace-core/src/workspaceMode.ts
./docs/superpowers/reviews/codex/phase-01.md:539:diff --git a/packages/workspace-core/tsconfig.json b/packages/workspace-core/tsconfig.json
./docs/superpowers/reviews/codex/phase-01.md:543:+++ b/packages/workspace-core/tsconfig.json
./docs/superpowers/reviews/codex/phase-01.md:634:+  packages/workspace-core:
./docs/superpowers/reviews/codex/phase-01.md:923:--- ./packages/workspace-core/package.json
./docs/superpowers/reviews/codex/phase-01.md:925:  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-01.md:1345:/bin/bash -lc "nl -ba packages/workspace-core/src/paths.ts | sed -n '1,120p'" in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-01.md:1347:     1	export function defaultWorkspaceRoot(homeDir: string): string {
./docs/superpowers/reviews/codex/phase-01.md:1353:     7	export function validateAttachedFolder(path: string): FolderValidation {
./docs/superpowers/reviews/codex/phase-01.md:1370:    24	export function validateUserWritePath(relativePath: string): WritePathValidation {
./docs/superpowers/reviews/codex/phase-01.md:1920:748:Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.
./docs/superpowers/reviews/codex/phase-01.md:1969:  workspace-core/           # local-first workspace model, modes, paths, change sets
./docs/superpowers/reviews/codex/phase-01.md:2103:- Create: `packages/workspace-core/package.json`
./docs/superpowers/reviews/codex/phase-01.md:2104:- Create: `packages/workspace-core/tsconfig.json`
./docs/superpowers/reviews/codex/phase-01.md:2105:- Create: `packages/workspace-core/src/workspaceMode.ts`
./docs/superpowers/reviews/codex/phase-01.md:2106:- Create: `packages/workspace-core/src/paths.ts`
./docs/superpowers/reviews/codex/phase-01.md:2107:- Create: `packages/workspace-core/src/metadata.ts`
./docs/superpowers/reviews/codex/phase-01.md:2108:- Create: `packages/workspace-core/src/changeSet.ts`
./docs/superpowers/reviews/codex/phase-01.md:2109:- Create: `packages/workspace-core/src/conflicts.ts`
./docs/superpowers/reviews/codex/phase-01.md:2110:- Create: `packages/workspace-core/src/index.ts`
./docs/superpowers/reviews/codex/phase-01.md:2111:- Create: `packages/workspace-core/src/workspaceMode.test.ts`
./docs/superpowers/reviews/codex/phase-01.md:2112:- Create: `packages/workspace-core/src/paths.test.ts`
./docs/superpowers/reviews/codex/phase-01.md:2113:- Create: `packages/workspace-core/src/changeSet.test.ts`
./docs/superpowers/reviews/codex/phase-01.md:2168:pnpm --filter @dohc/workspace-core test
./docs/superpowers/reviews/codex/phase-01.md:2169:pnpm --filter @dohc/workspace-core typecheck
./docs/superpowers/reviews/codex/phase-01.md:2176:Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.
./docs/superpowers/reviews/codex/phase-01.md:2181:git add packages/workspace-core package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
./docs/superpowers/reviews/codex/phase-01.md:2208:- Expected test state: workspace-core 31/31 green; baseline green (11 PASS + 1 KNOWN-FAIL web)
./docs/superpowers/reviews/codex/phase-01.md:2311:- Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
./docs/superpowers/reviews/codex/phase-01.md:2314:- Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
./docs/superpowers/reviews/codex/phase-01.md:2316:- Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
./docs/superpowers/reviews/codex/phase-01.md:2318:- Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
./docs/superpowers/reviews/codex/phase-01.md:2355: packages/workspace-core/package.json               | 17 ++++
./docs/superpowers/reviews/codex/phase-01.md:2356: packages/workspace-core/src/changeSet.test.ts      | 84 ++++++++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:2357: packages/workspace-core/src/changeSet.ts           | 57 +++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:2358: packages/workspace-core/src/conflicts.ts           | 13 +++
./docs/superpowers/reviews/codex/phase-01.md:2359: packages/workspace-core/src/index.ts               |  5 ++
./docs/superpowers/reviews/codex/phase-01.md:2360: packages/workspace-core/src/metadata.ts            | 36 ++++++++
./docs/superpowers/reviews/codex/phase-01.md:2361: packages/workspace-core/src/paths.test.ts          | 99 ++++++++++++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:2362: packages/workspace-core/src/paths.ts               | 66 +++++++++++++++
./docs/superpowers/reviews/codex/phase-01.md:2363: packages/workspace-core/src/workspaceMode.test.ts  | 32 +++++++
./docs/superpowers/reviews/codex/phase-01.md:2364: packages/workspace-core/src/workspaceMode.ts       | 16 ++++
./docs/superpowers/reviews/codex/phase-01.md:2365: packages/workspace-core/tsconfig.json              |  4 +
./docs/superpowers/reviews/codex/phase-01.md:2370:/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 67d692f -- packages/workspace-core/src packages/workspace-core/package.json packages/workspace-core/tsconfig.json pnpm-lock.yaml' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-01.md:2387:diff --git a/packages/workspace-core/package.json b/packages/workspace-core/package.json
./docs/superpowers/reviews/codex/phase-01.md:2391:+++ b/packages/workspace-core/package.json
./docs/superpowers/reviews/codex/phase-01.md:2394:+  "name": "@dohc/workspace-core",
./docs/superpowers/reviews/codex/phase-01.md:2410:diff --git a/packages/workspace-core/src/changeSet.test.ts b/packages/workspace-core/src/changeSet.test.ts
./docs/superpowers/reviews/codex/phase-01.md:2414:+++ b/packages/workspace-core/src/changeSet.test.ts
./docs/superpowers/reviews/codex/phase-01.md:2500:diff --git a/packages/workspace-core/src/changeSet.ts b/packages/workspace-core/src/changeSet.ts
./docs/superpowers/reviews/codex/phase-01.md:2504:+++ b/packages/workspace-core/src/changeSet.ts
./docs/superpowers/reviews/codex/phase-01.md:2563:diff --git a/packages/workspace-core/src/conflicts.ts b/packages/workspace-core/src/conflicts.ts
./docs/superpowers/reviews/codex/phase-01.md:2567:+++ b/packages/workspace-core/src/conflicts.ts
./docs/superpowers/reviews/codex/phase-01.md:2582:diff --git a/packages/workspace-core/src/index.ts b/packages/workspace-core/src/index.ts
./docs/superpowers/reviews/codex/phase-01.md:2586:+++ b/packages/workspace-core/src/index.ts
./docs/superpowers/reviews/codex/phase-01.md:2593:diff --git a/packages/workspace-core/src/metadata.ts b/packages/workspace-core/src/metadata.ts
./docs/superpowers/reviews/codex/phase-01.md:2612:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
./docs/superpowers/reviews/codex/phase-01.md:2613:  On default macOS/Windows workspaces, the filesystem is case-insensitive, so `.DOHC/manifest.json` aliases the reserved `.dohc/manifest.json`. Because this only compares the lowercase literal `.dohc`, `validateUserWritePath(".DOHC/manifest.json")` returns ok and later filesystem writes can overwrite dohc metadata the reserved-space guard is meant to protect.
./docs/superpowers/reviews/codex/phase-01.md:2615:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
./docs/superpowers/reviews/codex/phase-01.md:2618:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
./docs/superpowers/reviews/codex/phase-01.md:2624:- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
./docs/superpowers/reviews/codex/phase-01.md:2625:  On default macOS/Windows workspaces, the filesystem is case-insensitive, so `.DOHC/manifest.json` aliases the reserved `.dohc/manifest.json`. Because this only compares the lowercase literal `.dohc`, `validateUserWritePath(".DOHC/manifest.json")` returns ok and later filesystem writes can overwrite dohc metadata the reserved-space guard is meant to protect.
./docs/superpowers/reviews/codex/phase-01.md:2627:- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
./docs/superpowers/reviews/codex/phase-01.md:2630:- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9

exec
/bin/bash -lc "sed -n '1,220p' packages/workspace-core/src/paths.ts" in /home/ice/dev/dohc
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
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/workspaceFiles.test.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/createWorkspaceFolder.test.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/registryStore.test.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,280p' apps/desktop/src/security/electronSecurity.test.ts" in /home/ice/dev/dohc
 succeeded in 110ms:
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

 succeeded in 112ms:
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

 succeeded in 112ms:
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

 succeeded in 116ms:
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

codex
The unit tests cover many lexical path cases in `workspace-core`, but there is no direct test file for `main.ts` IPC handler registration or sender enforcement. I’m checking window wiring and any E2E coverage so “currently covers it” is not overstated.
exec
/bin/bash -lc "rg -n \"dohcDesktop|createLocalWorkspace|attachWorkspaceFolder|createWorkspaceFile|listWorkspaceFiles|importWorkspaceFiles|getLaunchMarks|firstPaint|Untrusted IPC|senderFrame|DOHC_TEST_PICK_PATH|workspace root|manifest identity|file tree\" apps/desktop/src apps/desktop/e2e apps/desktop/tests test e2e --glob '"'!**/node_modules/**'"'" in /home/ice/dev/dohc
 exited 2 in 0ms:
rg: apps/desktop/tests: No such file or directory (os error 2)
rg: test: No such file or directory (os error 2)
rg: e2e: No such file or directory (os error 2)
apps/desktop/e2e/desktopLaunch.spec.ts:32:      dohcDesktopTest?: { getLaunchMarks(): Promise<Record<string, number>> };
apps/desktop/e2e/desktopLaunch.spec.ts:33:    }).dohcDesktopTest?.getLaunchMarks(),
apps/desktop/e2e/desktopLaunch.spec.ts:38:  expect(marks?.firstPaintMs).toBeGreaterThan(0);
apps/desktop/e2e/firstRunWorkspace.spec.ts:85:  // --- Shell surfaces: sidebar/file tree, status, agent panel ---
apps/desktop/e2e/firstRunWorkspace.spec.ts:174:  // Pre-create a workspace folder with a known manifest identity.
apps/desktop/e2e/firstRunWorkspace.spec.ts:201:      DOHC_TEST_PICK_PATH: existingRoot,
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:11:  createLocalWorkspace: vi.fn(async () => ({
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:17:  attachWorkspaceFolder: vi.fn(async () => ({
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:24:  listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:25:  createWorkspaceFile: vi.fn(async () => ({ path: "notes/welcome.md" })),
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:26:  importWorkspaceFiles: vi.fn(async () => ({ imported: [] })),
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:30:  vi.stubGlobal("dohcDesktop", bridge);
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:62:    expect(bridge.createLocalWorkspace).toHaveBeenCalledWith(
apps/desktop/src/renderer/DesktopFirstRun.test.tsx:77:    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledWith({
apps/desktop/src/renderer/bridge.ts:5:    dohcDesktop?: DohcDesktopBridge;
apps/desktop/src/renderer/bridge.ts:6:    dohcDesktopInternal?: { firstPaint(): void };
apps/desktop/src/renderer/bridge.ts:11:  const api = window.dohcDesktop;
apps/desktop/src/preload.ts:6:contextBridge.exposeInMainWorld("dohcDesktop", {
apps/desktop/src/preload.ts:12:  createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
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
apps/desktop/src/renderer/NewFileDialog.tsx:20:      const result = await bridge().createWorkspaceFile({
apps/desktop/src/main.ts:52:  const frameUrl = event.senderFrame?.url ?? "";
apps/desktop/src/main.ts:54:    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
apps/desktop/src/main.ts:67:    const testPick = process.env.DOHC_TEST_PICK_PATH;
apps/desktop/src/main.ts:99:  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
apps/desktop/src/main.ts:110:  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
apps/desktop/src/main.ts:113:    // Adopts an existing dohc workspace (manifest identity preserved) or
apps/desktop/src/main.ts:123:  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
apps/desktop/src/main.ts:132:  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
apps/desktop/src/main.ts:140:  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
apps/desktop/src/main.ts:154:  ipcMain.on(CHANNELS.firstPaint, (event) => {
apps/desktop/src/main.ts:155:    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
apps/desktop/src/main.ts:156:      launchMarks.firstPaint();
apps/desktop/src/main.ts:163:    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
apps/desktop/src/workspaces/createWorkspaceFolder.ts:45:    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:45:    await bridge().importWorkspaceFiles({
apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:48:    const result = await bridge().listWorkspaceFiles({
apps/desktop/src/renderer/DesktopWorkspaceShell.tsx:55:    const result = await bridge().listWorkspaceFiles({
apps/desktop/src/workspaces/workspaceFiles.test.ts:48:  it("copies external files into the workspace root by basename", async () => {
apps/desktop/src/workspaces/workspaceFiles.ts:56:// Imports copy external files into the workspace root by basename; existing
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts:54:  it("rejects relative workspace roots", async () => {
apps/desktop/src/renderer/DesktopFirstRun.tsx:29:      const workspace = await bridge().createLocalWorkspace({
apps/desktop/src/renderer/DesktopFirstRun.tsx:44:      const workspace = await bridge().attachWorkspaceFolder({
apps/desktop/src/renderer/main.tsx:14:  window.dohcDesktopInternal?.firstPaint();
apps/desktop/src/ipc/channels.ts:6:  createLocalWorkspace: "desktop:create-local-workspace",
apps/desktop/src/ipc/channels.ts:7:  attachWorkspaceFolder: "desktop:attach-workspace-folder",
apps/desktop/src/ipc/channels.ts:8:  listWorkspaceFiles: "desktop:list-workspace-files",
apps/desktop/src/ipc/channels.ts:9:  createWorkspaceFile: "desktop:create-workspace-file",
apps/desktop/src/ipc/channels.ts:10:  importWorkspaceFiles: "desktop:import-workspace-files",
apps/desktop/src/ipc/channels.ts:11:  firstPaint: "desktop:first-paint",
apps/desktop/src/ipc/channels.ts:12:  getLaunchMarks: "desktop:test:get-launch-marks",
apps/desktop/src/ipc/bridgeContract.ts:76:  firstPaintMs: z.number().positive(),
apps/desktop/src/ipc/bridgeContract.ts:85:  createLocalWorkspace(
apps/desktop/src/ipc/bridgeContract.ts:88:  attachWorkspaceFolder(payload: {
apps/desktop/src/ipc/bridgeContract.ts:91:  listWorkspaceFiles(payload: {
apps/desktop/src/ipc/bridgeContract.ts:94:  createWorkspaceFile(payload: {
apps/desktop/src/ipc/bridgeContract.ts:98:  importWorkspaceFiles(payload: {
apps/desktop/src/performance/launchMarks.ts:10:  firstPaintMs: number;
apps/desktop/src/performance/launchMarks.ts:22:  firstPaint: () => markOnce("firstPaintMs"),

exec
/bin/bash -lc "find apps/desktop -maxdepth 3 -type f \\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \\) | sort" in /home/ice/dev/dohc
 succeeded in 0ms:
apps/desktop/e2e/desktopLaunch.spec.ts
apps/desktop/e2e/firstRunWorkspace.spec.ts
apps/desktop/src/renderer/DesktopFirstRun.test.tsx
apps/desktop/src/security/electronSecurity.test.ts
apps/desktop/src/workspaces/createWorkspaceFolder.test.ts
apps/desktop/src/workspaces/registryStore.test.ts
apps/desktop/src/workspaces/workspaceFiles.test.ts

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/window/createMainWindow.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
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

codex
There are only two E2E specs, and the first-run flow exercises happy paths for create/attach/list/new file/import but not adversarial payloads or untrusted frames. I’m reading those to map which scenarios are indirectly covered versus merely adjacent.
exec
/bin/bash -lc "sed -n '1,160p' apps/desktop/e2e/desktopLaunch.spec.ts" in /home/ice/dev/dohc
exec
/bin/bash -lc "sed -n '1,280p' apps/desktop/e2e/firstRunWorkspace.spec.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { _electron as electron } from "playwright";

const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
const PERF_FILE = "test-results/performance/desktop-performance.json";

test("launches dohc desktop and renders the first-run shell", async () => {
  const launchArgs = ["apps/desktop/dist/main/main.js"];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
    launchArgs.push("--no-sandbox");
  }
  const app = await electron.launch({
    args: launchArgs,
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
  });

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
/bin/bash -lc "sed -n '1,180p' apps/desktop/src/renderer/DesktopFirstRun.test.tsx" in /home/ice/dev/dohc
 succeeded in 0ms:
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
/bin/bash -lc "sed -n '1,140p' apps/desktop/src/renderer/DesktopWorkspaceShell.tsx" in /home/ice/dev/dohc
 succeeded in 0ms:
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

codex
One subtle payload case worth confirming is whether Zod accepts inherited properties on payload objects. I’m going to run a small read-only Node check against the installed dependency because that affects whether prototype-polluted IPC payloads are a real validator bypass or just a malformed-payload rejection.
exec
/bin/bash -lc "node -e \"const { z } = require('zod'); const schema=z.object({workspaceId:z.string().min(1), relativePath:z.string().min(1)}); const payload=Object.create({workspaceId:'ws-1', relativePath:'notes/x.md'}); try { console.log(JSON.stringify(schema.parse(payload))); } catch (e) { console.log('ERR', e.errors||e.message); } const p={__proto__:{polluted:'yes'}, workspaceId:'ws-1', relativePath:'notes/x.md'}; console.log(JSON.stringify(schema.parse(p))); console.log({polluted:{}.polluted});\"" in /home/ice/dev/dohc
 succeeded in 115ms:
{"workspaceId":"ws-1","relativePath":"notes/x.md"}
{"workspaceId":"ws-1","relativePath":"notes/x.md"}
{ polluted: undefined }

codex
1. IPC malformed payload object: input `null`, `[]`, or `{ workspaceId: 1 }`; call `window.dohcDesktop.listWorkspaceFiles(payload)` -> `ipcRenderer.invoke(desktop:list-workspace-files)` -> `ListWorkspaceFilesPayload.parse`; invariant: malformed payloads reject before registry/file access. SHOULD cover: `apps/desktop/e2e/firstRunWorkspace.spec.ts` or a missing IPC unit test. Currently: No.

2. IPC oversized file path: input `{ workspaceId: "ws-1", relativePath: "a/".repeat(500000) + "x.md" }`; call `createWorkspaceFile` -> payload parse -> `validateUserWritePath` -> `mkdir/writeFile`; invariant: IPC rejects bounded-size payloads before CPU/filesystem pressure. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts` plus IPC validation coverage. Currently: No.

3. IPC oversized workspace id: input `{ workspaceId: "x".repeat(10_000_000) }`; call `listWorkspaceFiles` or `importWorkspaceFiles` -> parse -> `findWorkspace`; invariant: bridge payloads have sane length caps and cannot cause memory/latency DoS. SHOULD cover: missing IPC contract test. Currently: No.

4. IPC extra-key contract bypass: input `{ workspaceId: "ws-1", relativePath: "notes/a.md", rootPath: "/" }`; call `createWorkspaceFile` -> Zod object parse strips unknown keys -> file write proceeds; invariant: IPC boundary rejects unexpected fields if the bridge contract is intended to be strict. SHOULD cover: missing IPC contract test. Currently: No.

5. Prototype-backed payload fields: input object whose own properties are empty but prototype has `{ workspaceId: "ws-1", relativePath: "notes/x.md" }`; call handler directly or through any path preserving prototypes -> `CreateWorkspaceFilePayload.parse` accepts inherited values -> `createFile`; invariant: IPC validators only trust own structured-clone/JSON properties. SHOULD cover: missing IPC contract test. Currently: No.

6. Registry JSON prototype pollution probe: registry file contains `{"version":1,"workspaces":[{"workspaceId":"ws-1","rootPath":"/tmp/ws","kind":"personal","mode":"local-first","__proto__":{"polluted":true}}]}`; call `getWorkspaceRegistry` -> `JSON.parse` -> `WorkspaceRegistryResult.parse`; invariant: parsed registry cannot mutate prototypes or leak unknown metadata. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

7. Registry shape poisoning: registry file contains `{"version":1,"workspaces":{"workspaceId":"ws-1","rootPath":"/"}}`; call `listWorkspaceFiles({ workspaceId: "ws-1" })` -> `findWorkspace` -> `.find` on non-array throws; invariant: corrupted registry fails closed or resets without crashing IPC. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

8. Registry root poisoning: registry file contains a valid-looking entry `{ workspaceId:"ws-poison", rootPath:"/", kind:"personal", mode:"local-first" }`; call `listWorkspaceFiles({ workspaceId:"ws-poison" })` -> `findWorkspace` -> `listFiles("/")`; invariant: persisted registry entries are revalidated before file operations, not trusted blindly. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts` or IPC E2E. Currently: No.

9. Registry duplicate-id poisoning: registry file has two entries with `workspaceId:"ws-1"`, attacker-controlled root first and real root second; call `createWorkspaceFile({ workspaceId:"ws-1", relativePath:"notes/a.md" })` -> `find` returns first -> write targets attacker root; invariant: duplicate workspace identities are rejected at read time, not only during `register`. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

10. Untrusted IPC sender: frame URL `https://evil.example/app` invokes `desktop:get-version` or `desktop:create-workspace-file`; call `ipcRenderer.invoke` -> `assertTrustedSender` -> deny; invariant: every IPC channel refuses disallowed sender frames. SHOULD cover: `apps/desktop/e2e/desktopLaunch.spec.ts` or missing main IPC test. Currently: No direct coverage.

11. Opaque sender URL: `about:blank`, `data:text/html,...`, or `blob:http://localhost:5173/...` frame invokes `desktop:list-workspace-files`; call -> `assertTrustedSender` -> `decideNavigation` denies; invariant: inherited/opaque origins cannot use privileged IPC. SHOULD cover: `apps/desktop/src/security/electronSecurity.test.ts` plus IPC test. Currently: Partial for navigation, No for IPC.

12. Dev-origin spoof sender: sender URL `http://localhost:5173.evil.com/x` invokes `desktop:get-workspace-registry`; call -> `assertTrustedSender` -> deny; invariant: exact-origin sender checks are not prefix checks. SHOULD cover: `apps/desktop/src/security/electronSecurity.test.ts` plus IPC test. Currently: Partial for navigation, No for IPC.

13. Root/home dot-segment guard through IPC: input `{ rootPath:"/home/ice/x/..", kind:"personal" }`; call `createLocalWorkspace` -> `usableRoot` -> `validateWorkspaceRootChoice` -> reject; invariant: root/home disguises cannot become workspace roots. SHOULD cover: `packages/workspace-core/src/paths.test.ts` and IPC E2E. Currently: Yes in core, No at IPC handler level.

14. Direct service bypass of root guard: input `{ rootPath:"/", kind:"personal" }`; call `createWorkspaceFolder` directly -> only `validateAttachedFolder` runs -> writes `/.dohc`; invariant: workspace-root guard is enforced at the service boundary, not only `main.ts`. SHOULD cover: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`. Currently: No.

15. Symlink root to home: create `/tmp/link-home -> /home/ice`; input `{ rootPath:"/tmp/link-home", kind:"personal" }`; call `attachWorkspaceFolder` -> lexical `validateWorkspaceRootChoice` passes -> `createWorkspaceFolder` writes `/home/ice/.dohc`; invariant: symlink-realpath roots cannot bypass “not home/root” guard. SHOULD cover: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts` or E2E. Currently: No.

16. UNC/server root variant: input root path like `\\\\server\\share\\..` or `//server/share/..`; call `attachWorkspaceFolder` -> `normalizeAbsolutePath` may canonicalize to `//server`; invariant: UNC server/share roots are not valid workspace roots. SHOULD cover: `packages/workspace-core/src/paths.test.ts`. Currently: No.

17. Malformed existing manifest side effect: workspace folder has `.dohc/manifest.json` with `{ version:1, workspaceId:"ws-bad", kind:"evil", mode:"evil" }`; call `attachWorkspaceFolder` -> `createWorkspaceFolder` adopts -> `registerWorkspace` writes invalid entry -> `WorkspaceSummary.parse` throws after registry mutation; invariant: failed attach/create has no registry side effects and manifests are fully validated before adoption. SHOULD cover: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts` and `registryStore.test.ts`. Currently: No.

18. Create through symlinked subdirectory: workspace contains `out -> /tmp/outside`; input `{ workspaceId:"ws-1", relativePath:"out/pwn.md" }`; call `createWorkspaceFile` -> `validateUserWritePath` ok -> `writeFile(root/out/pwn.md)` follows symlink; invariant: user writes cannot escape the workspace root via symlink components. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

19. Create TOCTOU symlink swap: input `{ relativePath:"notes/pwn.md" }`; call `createWorkspaceFile` -> after validation/`mkdir`, attacker replaces `root/notes` with symlink to `/tmp/outside` before `writeFile`; invariant: path scope is checked against real destination at write time. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

20. ListFiles directory race: root has real directory `notes`; call `listWorkspaceFiles` -> `readdir(root)` returns `notes` as directory -> attacker swaps `notes` to symlink `/etc` before recursive `walk(join(root,"notes"))`; invariant: listing never follows paths outside workspace. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

21. Import into symlinked workspace root: registry/root points to `/tmp/link-home -> /home/ice`; call `importWorkspaceFiles({ workspaceId })` -> dialog returns `/tmp/source/receipt.md` -> `copyIntoWorkspace(rootPath, filePaths)` copies into home; invariant: imports land inside the real workspace root, not a symlink target outside policy. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts` and attach/root tests. Currently: No.

22. Import source symlink leak: dialog returns `/tmp/picked/passwords.md` where that path is a symlink to `/etc/passwd`; call `importWorkspaceFiles` -> `copyFile(source, root/basename)` follows source symlink; invariant: import only copies regular selected files or explicitly records symlink provenance. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

23. Import TOCTOU root swap: call `importWorkspaceFiles` -> after dialog selection but before `copyFile`, attacker replaces workspace root with symlink to `/tmp/outside`; invariant: import verifies real destination remains under workspace root at copy time. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

24. Registry canonical path duplicate: register `/tmp/ws/.` then `/tmp/ws` through direct `registryStore.register` calls; call `list`/`find`; invariant: registry storage itself rejects canonical duplicate roots, not only callers that remember to normalize. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

25. Concurrent registry registration race: two store instances read empty registry, both call `register` with same `workspaceId` or same root, both write; invariant: duplicate root/id rejection survives concurrent attach/create attempts and multi-process races. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

26. Reserved path separator variant: input `{ relativePath:".dohc\\manifest.json" }`; call `createWorkspaceFile` -> `validateUserWritePath` normalizes slash -> reject reserved; invariant: `.dohc` cannot be written with Windows separators from any platform. SHOULD cover: `packages/workspace-core/src/paths.test.ts` and `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: likely covered by implementation behavior, but No explicit test.
tokens used
65,661
1. IPC malformed payload object: input `null`, `[]`, or `{ workspaceId: 1 }`; call `window.dohcDesktop.listWorkspaceFiles(payload)` -> `ipcRenderer.invoke(desktop:list-workspace-files)` -> `ListWorkspaceFilesPayload.parse`; invariant: malformed payloads reject before registry/file access. SHOULD cover: `apps/desktop/e2e/firstRunWorkspace.spec.ts` or a missing IPC unit test. Currently: No.

2. IPC oversized file path: input `{ workspaceId: "ws-1", relativePath: "a/".repeat(500000) + "x.md" }`; call `createWorkspaceFile` -> payload parse -> `validateUserWritePath` -> `mkdir/writeFile`; invariant: IPC rejects bounded-size payloads before CPU/filesystem pressure. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts` plus IPC validation coverage. Currently: No.

3. IPC oversized workspace id: input `{ workspaceId: "x".repeat(10_000_000) }`; call `listWorkspaceFiles` or `importWorkspaceFiles` -> parse -> `findWorkspace`; invariant: bridge payloads have sane length caps and cannot cause memory/latency DoS. SHOULD cover: missing IPC contract test. Currently: No.

4. IPC extra-key contract bypass: input `{ workspaceId: "ws-1", relativePath: "notes/a.md", rootPath: "/" }`; call `createWorkspaceFile` -> Zod object parse strips unknown keys -> file write proceeds; invariant: IPC boundary rejects unexpected fields if the bridge contract is intended to be strict. SHOULD cover: missing IPC contract test. Currently: No.

5. Prototype-backed payload fields: input object whose own properties are empty but prototype has `{ workspaceId: "ws-1", relativePath: "notes/x.md" }`; call handler directly or through any path preserving prototypes -> `CreateWorkspaceFilePayload.parse` accepts inherited values -> `createFile`; invariant: IPC validators only trust own structured-clone/JSON properties. SHOULD cover: missing IPC contract test. Currently: No.

6. Registry JSON prototype pollution probe: registry file contains `{"version":1,"workspaces":[{"workspaceId":"ws-1","rootPath":"/tmp/ws","kind":"personal","mode":"local-first","__proto__":{"polluted":true}}]}`; call `getWorkspaceRegistry` -> `JSON.parse` -> `WorkspaceRegistryResult.parse`; invariant: parsed registry cannot mutate prototypes or leak unknown metadata. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

7. Registry shape poisoning: registry file contains `{"version":1,"workspaces":{"workspaceId":"ws-1","rootPath":"/"}}`; call `listWorkspaceFiles({ workspaceId: "ws-1" })` -> `findWorkspace` -> `.find` on non-array throws; invariant: corrupted registry fails closed or resets without crashing IPC. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

8. Registry root poisoning: registry file contains a valid-looking entry `{ workspaceId:"ws-poison", rootPath:"/", kind:"personal", mode:"local-first" }`; call `listWorkspaceFiles({ workspaceId:"ws-poison" })` -> `findWorkspace` -> `listFiles("/")`; invariant: persisted registry entries are revalidated before file operations, not trusted blindly. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts` or IPC E2E. Currently: No.

9. Registry duplicate-id poisoning: registry file has two entries with `workspaceId:"ws-1"`, attacker-controlled root first and real root second; call `createWorkspaceFile({ workspaceId:"ws-1", relativePath:"notes/a.md" })` -> `find` returns first -> write targets attacker root; invariant: duplicate workspace identities are rejected at read time, not only during `register`. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

10. Untrusted IPC sender: frame URL `https://evil.example/app` invokes `desktop:get-version` or `desktop:create-workspace-file`; call `ipcRenderer.invoke` -> `assertTrustedSender` -> deny; invariant: every IPC channel refuses disallowed sender frames. SHOULD cover: `apps/desktop/e2e/desktopLaunch.spec.ts` or missing main IPC test. Currently: No direct coverage.

11. Opaque sender URL: `about:blank`, `data:text/html,...`, or `blob:http://localhost:5173/...` frame invokes `desktop:list-workspace-files`; call -> `assertTrustedSender` -> `decideNavigation` denies; invariant: inherited/opaque origins cannot use privileged IPC. SHOULD cover: `apps/desktop/src/security/electronSecurity.test.ts` plus IPC test. Currently: Partial for navigation, No for IPC.

12. Dev-origin spoof sender: sender URL `http://localhost:5173.evil.com/x` invokes `desktop:get-workspace-registry`; call -> `assertTrustedSender` -> deny; invariant: exact-origin sender checks are not prefix checks. SHOULD cover: `apps/desktop/src/security/electronSecurity.test.ts` plus IPC test. Currently: Partial for navigation, No for IPC.

13. Root/home dot-segment guard through IPC: input `{ rootPath:"/home/ice/x/..", kind:"personal" }`; call `createLocalWorkspace` -> `usableRoot` -> `validateWorkspaceRootChoice` -> reject; invariant: root/home disguises cannot become workspace roots. SHOULD cover: `packages/workspace-core/src/paths.test.ts` and IPC E2E. Currently: Yes in core, No at IPC handler level.

14. Direct service bypass of root guard: input `{ rootPath:"/", kind:"personal" }`; call `createWorkspaceFolder` directly -> only `validateAttachedFolder` runs -> writes `/.dohc`; invariant: workspace-root guard is enforced at the service boundary, not only `main.ts`. SHOULD cover: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`. Currently: No.

15. Symlink root to home: create `/tmp/link-home -> /home/ice`; input `{ rootPath:"/tmp/link-home", kind:"personal" }`; call `attachWorkspaceFolder` -> lexical `validateWorkspaceRootChoice` passes -> `createWorkspaceFolder` writes `/home/ice/.dohc`; invariant: symlink-realpath roots cannot bypass “not home/root” guard. SHOULD cover: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts` or E2E. Currently: No.

16. UNC/server root variant: input root path like `\\\\server\\share\\..` or `//server/share/..`; call `attachWorkspaceFolder` -> `normalizeAbsolutePath` may canonicalize to `//server`; invariant: UNC server/share roots are not valid workspace roots. SHOULD cover: `packages/workspace-core/src/paths.test.ts`. Currently: No.

17. Malformed existing manifest side effect: workspace folder has `.dohc/manifest.json` with `{ version:1, workspaceId:"ws-bad", kind:"evil", mode:"evil" }`; call `attachWorkspaceFolder` -> `createWorkspaceFolder` adopts -> `registerWorkspace` writes invalid entry -> `WorkspaceSummary.parse` throws after registry mutation; invariant: failed attach/create has no registry side effects and manifests are fully validated before adoption. SHOULD cover: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts` and `registryStore.test.ts`. Currently: No.

18. Create through symlinked subdirectory: workspace contains `out -> /tmp/outside`; input `{ workspaceId:"ws-1", relativePath:"out/pwn.md" }`; call `createWorkspaceFile` -> `validateUserWritePath` ok -> `writeFile(root/out/pwn.md)` follows symlink; invariant: user writes cannot escape the workspace root via symlink components. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

19. Create TOCTOU symlink swap: input `{ relativePath:"notes/pwn.md" }`; call `createWorkspaceFile` -> after validation/`mkdir`, attacker replaces `root/notes` with symlink to `/tmp/outside` before `writeFile`; invariant: path scope is checked against real destination at write time. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

20. ListFiles directory race: root has real directory `notes`; call `listWorkspaceFiles` -> `readdir(root)` returns `notes` as directory -> attacker swaps `notes` to symlink `/etc` before recursive `walk(join(root,"notes"))`; invariant: listing never follows paths outside workspace. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

21. Import into symlinked workspace root: registry/root points to `/tmp/link-home -> /home/ice`; call `importWorkspaceFiles({ workspaceId })` -> dialog returns `/tmp/source/receipt.md` -> `copyIntoWorkspace(rootPath, filePaths)` copies into home; invariant: imports land inside the real workspace root, not a symlink target outside policy. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts` and attach/root tests. Currently: No.

22. Import source symlink leak: dialog returns `/tmp/picked/passwords.md` where that path is a symlink to `/etc/passwd`; call `importWorkspaceFiles` -> `copyFile(source, root/basename)` follows source symlink; invariant: import only copies regular selected files or explicitly records symlink provenance. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

23. Import TOCTOU root swap: call `importWorkspaceFiles` -> after dialog selection but before `copyFile`, attacker replaces workspace root with symlink to `/tmp/outside`; invariant: import verifies real destination remains under workspace root at copy time. SHOULD cover: `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: No.

24. Registry canonical path duplicate: register `/tmp/ws/.` then `/tmp/ws` through direct `registryStore.register` calls; call `list`/`find`; invariant: registry storage itself rejects canonical duplicate roots, not only callers that remember to normalize. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

25. Concurrent registry registration race: two store instances read empty registry, both call `register` with same `workspaceId` or same root, both write; invariant: duplicate root/id rejection survives concurrent attach/create attempts and multi-process races. SHOULD cover: `apps/desktop/src/workspaces/registryStore.test.ts`. Currently: No.

26. Reserved path separator variant: input `{ relativePath:".dohc\\manifest.json" }`; call `createWorkspaceFile` -> `validateUserWritePath` normalizes slash -> reject reserved; invariant: `.dohc` cannot be written with Windows separators from any platform. SHOULD cover: `packages/workspace-core/src/paths.test.ts` and `apps/desktop/src/workspaces/workspaceFiles.test.ts`. Currently: likely covered by implementation behavior, but No explicit test.
