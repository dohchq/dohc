import {
  defaultWorkspaceRoot,
  normalizeAbsolutePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  AttachWorkspaceFolderPayload,
  CreateLocalWorkspacePayload,
  CreateWorkspaceFilePayload,
  CreateWorkspaceFileResult,
  CreateWorkspaceFolderPayload,
  MoveWorkspacePathPayload,
  DeleteWorkspacePathPayload,
  DeleteWorkspacePathResult,
  ExportWorkspaceZipPayload,
  ExportWorkspaceZipResult,
  ShowExplorerMenuPayload,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuPayload,
  ShowWorkbenchMenuResult,
  type ExplorerMenuCommand,
  type WorkbenchMenuCommand,
  DefaultWorkspaceRootResult,
  ApplyDatabaseEditPayload,
  CloudEnableSyncPayload,
  CloudLoginPollResult,
  CloudLoginStartPayload,
  CloudLoginStartResult,
  CloudStatusPayload,
  CloudStatusResult,
  CollabTokenPayload,
  CollabTokenResult,
  CreateDataFragmentPayload,
  CreateDataFragmentResult,
  CreateWorkspaceInvitePayload,
  CreateWorkspaceInviteResult,
  CreateWorkspaceSharePayload,
  CreateWorkspaceShareResult,
  OpenExternalUrlPayload,
  DatabaseSnapshotResult,
  ImportToDatabasePayload,
  ImportToDatabaseResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  ListDataFragmentsPayload,
  ListDataFragmentsResult,
  DesktopMarksResult,
  LaunchMarksResult,
  ListSitesPayload,
  ListSitesResult,
  SitePackagePayload,
  SitePackageResult,
  StartSitePreviewPayload,
  StartSitePreviewResult,
  StopSitePreviewPayload,
  ListWorkspaceSharesPayload,
  ListWorkspaceSharesResult,
  ListWorkspaceMembersResult,
  ListWorkspaceInvitesResult,
  ReadChangeSetPayload,
  ReadChangeSetResult,
  RestoreHistoryFilePayload,
  RestoreHistoryFileResult,
  ListChangeSetsResult,
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  ListWorkspaceVersionsResult,
  CreateWorkspaceVersionPayload,
  SwitchWorkspaceVersionPayload,
  SwitchWorkspaceVersionResult,
  CompareWorkspaceVersionsPayload,
  CompareWorkspaceVersionsResult,
  MergeWorkspaceVersionPayload,
  MergeWorkspaceVersionResult,
  ListWorkspaceVersionConflictsResult,
  ResolveWorkspaceVersionConflictPayload,
  ResolveWorkspaceVersionConflictResult,
  TryInVersionStateResult,
  TryInWorkspaceVersionPayload,
  TryInWorkspaceVersionResult,
  WorkspaceVersionConflict,
  WorkspaceVersionRecord,
  ListEngineMomentsPayload,
  ListEngineMomentsResult,
  ReadEngineMomentPayload,
  ReadEngineMomentResult,
  RestoreEngineMomentFilePayload,
  RestoreEngineMomentFileResult,
  ListFileChatsPayload,
  ListFileChatsResult,
  CreateFileChatPayload,
  CreateFileChatResult,
  ListChatMessagesPayload,
  ListChatMessagesResult,
  SendChatMessagePayload,
  SendChatMessageResult,
  ListChatChannelsPayload,
  ListChatChannelsResult,
  CreateChatChannelPayload,
  CreateChatChannelResult,
  ListChannelThreadsPayload,
  ListChannelThreadsResult,
  StartChannelThreadPayload,
  StartChannelThreadResult,
  MarkChatThreadReadPayload,
  MarkChatThreadReadResult,
  EngineMomentRecord,
  EngineMomentDetailRecord,
  ChatThreadRecord,
  ChatMessageRecord,
  OpenFileExternallyPayload,
  OpenWorkspacePayload,
  AgentRunPayload,
  EndAgentRunPayload,
  StartAgentRunResult,
  AgentRunStatusResult,
  McpConfigResult,
  AgentPanelSnapshotResult,
  AgentPermissionResponsePayload,
  StartAgentSessionPayload,
  DesktopUserSettingsResult,
  PickWorkspaceRootResult,
  ReadWorkspaceGraphPayload,
  ReadWorkspaceDatabasePayload,
  ReadDataFragmentPayload,
  ReadDataFragmentResult,
  ReadWorkspaceTextPayload,
  ReadWorkspaceTextResult,
  RevokeDataFragmentPayload,
  RevokeWorkspaceSharePayload,
  RevokeWorkspaceInvitePayload,
  WriteWorkspaceTextPayload,
  SetTitlebarThemePayload,
  SetUserSettingsPayload,
  SetWorkspaceSettingsPayload,
  SetWorkspaceUiStatePayload,
  WorkspaceSettingsPayload,
  WorkspaceSettingsResult,
  WriteClipboardTextPayload,
  GetWorkspaceUiStateResult,
  SyncStatusResult,
  WorkspaceRegistryResult,
  WorkspaceSummary,
  WorkspaceGraphResult,
  WorkspaceSearchPayload,
  CancelWorkspaceSearchPayload,
  SearchResultsEventSchema,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
} from "./ipc/bridgeContract";
import { CHANNELS, SEARCH_EVENT_MAX_ENTRIES } from "./ipc/channels";
import { desktopMarks } from "./performance/desktopMarks";
import { launchMarks } from "./performance/launchMarks";
import {
  publicUpdateState,
  resolveUpdateChannel,
  startAutoUpdates,
  type AutoUpdateController,
  type PublicUpdateState,
} from "./updates/electronUpdater";
import { initialUpdateState } from "./updates/updateMachine";
import { decideNavigation, isSafeExternalUrl } from "./security/electronSecurity";
import { buildMenuTemplate } from "./window/applicationMenu";
import {
  allowSitePreviewOrigin,
  navigationPolicy,
  rememberChromeTheme,
  titleBarOverlayOptions,
} from "./window/createMainWindow";
import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
import {
  effectiveHome,
  findWorkspace,
  listWorkspaces,
  registerWorkspace,
  setWorkspaceRemote,
  stateDir,
} from "./workspaces/WorkspaceRegistry";
import { createCloudCredentialStore } from "./workspaces/cloudCredentialStore";
import {
  createCloudDataFragment,
  listCloudDataFragments,
  readCloudDataFragment,
  revokeCloudDataFragment,
} from "./workspaces/cloudDataFragments";
import { createCloudLogin, type CloudLogin } from "./workspaces/cloudLogin";
import { createCloudSyncEngine } from "./workspaces/cloudSyncEngine";
import {
  createLinkedChatStore,
  createVersionedTextStore,
  searchWorkspaceEngine,
  type ChannelThreadSummary,
  type ChatChannelSummary,
  type ChatMessage,
  type ChatThread,
  type LinkedChatStore,
  type VersionedTextMomentSummary,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import type {
  WorkspaceEngineMomentDetail,
  WorkspaceEngineMomentSummary,
} from "./workspaces/workspaceEngineCapture";
import { createWorkspaceActivity } from "./workspaces/workspaceActivity";
import { captureForFlaggedWorkspace } from "./workspaces/engineCaptureGate";
import {
  readWorkspaceEnginePolicy,
  resolveEngineSearchPolicy,
} from "./workspaces/workspaceEnginePolicyFile";
import { createAgentIntegration } from "./agents/AgentIntegration";
import type { AgentSessionManager } from "./agents/AgentSessionManager";
import { createTryInVersionSessions } from "./agents/tryInVersion";
import {
  buildOutputSiteRoot,
  entryRelativeToSite,
  getSitePackage,
  listSitePackages,
  type SitePackageInfo,
} from "./workspaces/sitePackage";
import {
  buildSite,
  packageManagerCommand,
  splitCommandLine,
  startSiteDevServer,
  startStaticSitePreview,
  type SiteLogEntry,
  type SiteProcessHandle,
  type StaticSitePreview,
} from "./workspaces/siteRunner";
import {
  readWorkspaceAsset,
  readWorkspaceText,
  resolveWorkspaceFile,
  writeWorkspaceText,
} from "./workspaces/workspaceAssets";
import {
  expectedHistoryRestoreEvent,
  restoreHistoryFileSnapshot,
  undoHistoryFileRestoreSnapshot,
} from "./workspaces/historyRestore";
import {
  applyDatabaseEdit,
  importToDatabase,
  readDatabaseSnapshot,
} from "./workspaces/workspaceDatabase";
import { readWorkspaceGraph } from "./workspaces/workspaceGraph";
import {
  collectZipEntries,
  copyIntoWorkspace,
  createFile,
  createFolder,
  deletePath,
  importDroppedPaths,
  listFiles,
  movePath,
} from "./workspaces/workspaceFiles";
import { buildStoreZip } from "./workspaces/zipWriter";
import { readUiStateFile, writeUiStateFile } from "./workspaces/workspaceUiState";
import {
  DEFAULT_USER_SETTINGS,
} from "./settings/userSettings";
import {
  readUserSettingsFile,
  writeUserSettingsFile,
} from "./settings/userSettingsStore";
import { DEFAULT_WORKSPACE_SETTINGS } from "./workspaces/workspaceSettings";
import {
  readWorkspaceSettingsFile,
  writeWorkspaceSettingsFile,
} from "./workspaces/workspaceSettingsFile";
import { createSearchRegistry } from "./workspaces/workspaceSearch";
import { rgPath } from "@vscode/ripgrep";

// Custom scheme that serves a workspace file's bytes to the renderer:
//   dohc-file://<workspaceId>/<relative/path>
// Registered privileged so the renderer can fetch() text and use it as
// <img>/<audio> src, without piping large binaries through IPC as base64.
// Must be declared before app `ready`.
const DOHC_FILE_SCHEME = "dohc-file";
protocol.registerSchemesAsPrivileged([
  {
    scheme: DOHC_FILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function trustedDohcFileCorsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const devRendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (devRendererUrl) {
    try {
      return new URL(devRendererUrl).origin === origin ? origin : null;
    } catch {
      return null;
    }
  }
  return origin === "file://" || origin === "null" ? origin : null;
}

function requireWorkspace(workspaceId: string) {
  const workspace = findWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

type SitePreviewHandle = StaticSitePreview | SiteProcessHandle;

const sitePreviewHandles = new Map<string, SitePreviewHandle>();
const sitePreviewOriginReleases = new Map<string, () => void>();
const sitePreviewStartLocks = new Map<string, Promise<void>>();
let autoUpdateController: AutoUpdateController | null = null;
let applicationMenuCanInstallUpdate: boolean | null = null;

function sitePreviewKey(workspaceId: string, siteRoot: string): string {
  return `${workspaceId}\0${siteRoot}`;
}

async function withSitePreviewStartLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sitePreviewStartLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  sitePreviewStartLocks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sitePreviewStartLocks.get(key) === queued) {
      sitePreviewStartLocks.delete(key);
    }
  }
}

async function stopSitePreviewHandle(workspaceId: string, siteRoot: string): Promise<void> {
  const key = sitePreviewKey(workspaceId, siteRoot);
  const handle = sitePreviewHandles.get(key);
  sitePreviewHandles.delete(key);
  try {
    await handle?.stop();
  } finally {
    sitePreviewOriginReleases.get(key)?.();
    sitePreviewOriginReleases.delete(key);
  }
}

function stopSitePreviewsForQuit(): void {
  // Idempotent by design: explicit update installs and Electron's own
  // before-quit-for-update event can both ask for the same cleanup.
  for (const [key, handle] of [...sitePreviewHandles]) {
    sitePreviewOriginReleases.get(key)?.();
    sitePreviewOriginReleases.delete(key);
    sitePreviewHandles.delete(key);
    void handle.stop().catch(() => undefined);
  }
}

async function stopSitePreviewsForWorkspace(workspaceId: string): Promise<void> {
  const prefix = `${workspaceId}\0`;
  const siteRoots = new Set<string>();
  for (const key of sitePreviewHandles.keys()) {
    if (key.startsWith(prefix)) siteRoots.add(key.slice(prefix.length));
  }
  for (const key of sitePreviewOriginReleases.keys()) {
    if (key.startsWith(prefix)) siteRoots.add(key.slice(prefix.length));
  }

  await Promise.all(
    [...siteRoots].map((siteRoot) =>
      withSitePreviewStartLock(
        sitePreviewKey(workspaceId, siteRoot),
        () => stopSitePreviewHandle(workspaceId, siteRoot),
      ).catch((error) => {
        console.warn("[desktop] failed to stop site preview during workspace switch", error);
      }),
    ),
  );
}

function rememberSitePreviewHandle(key: string, handle: SitePreviewHandle): void {
  sitePreviewOriginReleases.get(key)?.();
  sitePreviewHandles.set(key, handle);
  sitePreviewOriginReleases.set(key, allowSitePreviewOrigin(handle.url));
}

function commandForSiteScript(
  site: SitePackageInfo,
  script: keyof SitePackageInfo["scripts"],
): { command: string; args: string[] } {
  const configuredCommand = site.configuredScripts?.[script];
  if (configuredCommand) return splitCommandLine(configuredCommand);
  const configured = site.scripts[script];
  if (!configured) throw new Error(`Site has no ${script} script: ${site.root}`);
  if (site.packagePath) {
    return packageManagerCommand(site.packageManager ?? "npm", script);
  }
  return splitCommandLine(configured);
}

function relativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const rel = relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new Error(`Build output escaped the workspace: ${absolutePath}`);
  }
  return rel;
}

function buildOutputRelativeToSite(siteRoot: string, workspaceRelativeOutput: string): string {
  if (siteRoot === ".") return workspaceRelativeOutput;
  if (workspaceRelativeOutput === siteRoot) return ".";
  if (!workspaceRelativeOutput.startsWith(`${siteRoot}/`)) {
    throw new Error(
      `Build output must be within the site directory: ${workspaceRelativeOutput}`,
    );
  }
  return workspaceRelativeOutput.slice(siteRoot.length + 1);
}

function recentSiteBuildLogText(logs: SiteLogEntry[]): string {
  const text = logs
    .slice(-3)
    .map((log) => log.text)
    .join("\n")
    .trim();
  return text.length > 2000 ? `[truncated]\n${text.slice(-2000)}` : text;
}

async function startPreviewForSite(input: {
  workspaceId: string;
  workspaceRoot: string;
  site: SitePackageInfo;
  mode: "static" | "dev" | "build";
}): Promise<StartSitePreviewResult> {
  const key = sitePreviewKey(input.workspaceId, input.site.root);
  return withSitePreviewStartLock(key, async () => startPreviewForSiteUnlocked(input, key));
}

async function startPreviewForSiteUnlocked(
  input: {
    workspaceId: string;
    workspaceRoot: string;
    site: SitePackageInfo;
    mode: "static" | "dev" | "build";
  },
  key: string,
): Promise<StartSitePreviewResult> {
  try {
    await stopSitePreviewHandle(input.workspaceId, input.site.root);
  } catch (error) {
    console.warn("[desktop] failed to stop previous site preview", error);
  }

  if (input.mode === "static") {
    const handle = await startStaticSitePreview(input.workspaceRoot, input.site.root, {
      entry: entryRelativeToSite(input.site) ?? undefined,
    });
    rememberSitePreviewHandle(key, handle);
    return {
      siteRoot: input.site.root,
      mode: input.mode,
      url: handle.url,
      logs: [],
    };
  }

  if (input.mode === "dev") {
    if (!input.site.scripts.dev && !input.site.scripts.start) {
      throw new Error(`Site has no dev or start script: ${input.site.root}`);
    }
    const script = input.site.scripts.dev ? "dev" : "start";
    const command = commandForSiteScript(input.site, script);
    const handle = await startSiteDevServer({
      workspaceRoot: input.workspaceRoot,
      siteRoot: input.site.root,
      command: command.command,
      args: command.args,
    });
    rememberSitePreviewHandle(key, handle);
    return {
      siteRoot: input.site.root,
      mode: input.mode,
      url: handle.url,
      logs: handle.logs(),
    };
  }

  let logs: SiteLogEntry[] = [];
  let build:
    | {
        ok: boolean;
        command: string;
        args: string[];
        outputPath: string | null;
        exitCode: number | null;
      }
    | undefined;
  let outputRoot = input.site.buildOutputs[0] ?? null;
  if (input.site.scripts.build) {
    const command = commandForSiteScript(input.site, "build");
    const result = await buildSite({
      workspaceRoot: input.workspaceRoot,
      siteRoot: input.site.root,
      command: command.command,
      args: command.args,
      output: outputRoot ?? undefined,
    });
    logs = result.logs;
    build = {
      ok: result.ok,
      command: result.command,
      args: result.args,
      outputPath: result.outputPath,
      exitCode: result.exitCode,
    };
    if (!result.ok || !result.outputPath) {
      const recentLogs = recentSiteBuildLogText(result.logs);
      throw new Error(
        `Site build failed or did not produce a static output folder.${
          recentLogs ? `\n\nRecent output:\n${recentLogs}` : ""
        }`,
      );
    }
    outputRoot = buildOutputRelativeToSite(
      input.site.root,
      relativeWorkspacePath(input.workspaceRoot, result.outputPath),
    );
  }
  if (!outputRoot) throw new Error(`Site has no build output to preview: ${input.site.root}`);
  const handle = await startStaticSitePreview(
    input.workspaceRoot,
    buildOutputSiteRoot(input.site, outputRoot),
  );
  rememberSitePreviewHandle(key, handle);
  return {
    siteRoot: input.site.root,
    mode: input.mode,
    url: handle.url,
    logs,
    ...(build ? { build } : {}),
  };
}

function testImportPaths(): string[] | null {
  if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return null;
  const raw = process.env.DOHC_TEST_IMPORT_PATHS;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DOHC_TEST_IMPORT_PATHS must be a JSON array of absolute paths");
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error("DOHC_TEST_IMPORT_PATHS must be an array with at most 100 paths");
  }
  const paths: string[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 4096 ||
      !isAbsolute(entry)
    ) {
      throw new Error("DOHC_TEST_IMPORT_PATHS entries must be absolute paths");
    }
    paths.push(entry);
  }
  return paths;
}

// Lazy: safeStorage and userData are only safe to touch after app ready, and
// handlers register inside whenReady. The session token lives encrypted in
// the credential store and never crosses IPC.
let cachedCloudLogin: CloudLogin | null = null;
function cloudLogin(): CloudLogin {
  if (!cachedCloudLogin) {
    cachedCloudLogin = createCloudLogin({
      store: createCloudCredentialStore({
        dir: stateDir(),
        cipher: {
          isAvailable: () => safeStorage.isEncryptionAvailable(),
          encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
          decrypt: (cipherText) =>
            safeStorage.decryptString(Buffer.from(cipherText, "base64")),
        },
      }),
      defaultServerUrl: process.env.DOHC_CLOUD_URL ?? "http://localhost:1786",
    });
  }
  return cachedCloudLogin;
}

// Live file-watch → history pipeline. Pushes a renderer notification whenever
// a settled batch is recorded so the file tree, timeline, and sync status
// refresh without polling.
function notifyRenderer(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.workspaceActivity);
  }
}

function workspaceSummaries(): WorkspaceSummary[] {
  return listWorkspaces().map((workspace) => WorkspaceSummary.parse(workspace));
}

function nativeWorkspaceSummaries(): WorkspaceSummary[] {
  try {
    return workspaceSummaries();
  } catch {
    // Native recent surfaces are convenience only. The renderer still gets the
    // strict registry parse and shows the refusal screen for malformed state.
    return [];
  }
}

let preferredWorkspaceId: string | null = null;

function prioritizePreferredWorkspace(
  workspaces: WorkspaceSummary[],
): WorkspaceSummary[] {
  if (!preferredWorkspaceId) return workspaces;
  const index = workspaces.findIndex(
    (workspace) => workspace.workspaceId === preferredWorkspaceId,
  );
  if (index <= 0) return workspaces;
  return [
    workspaces[index],
    ...workspaces.slice(0, index),
    ...workspaces.slice(index + 1),
  ];
}

function targetWindow(window: BrowserWindow | undefined): BrowserWindow | undefined {
  return window ?? BrowserWindow.getAllWindows()[0];
}

function sendWorkspaceActivated(
  window: BrowserWindow | undefined,
  workspace: WorkspaceSummary,
): void {
  preferredWorkspaceId = workspace.workspaceId;
  targetWindow(window)?.webContents.send(CHANNELS.workspaceActivated, workspace);
}

function quoteWindowsArg(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
    } else if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += char;
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += char;
      backslashes = 0;
    }
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

function refreshApplicationMenu(): void {
  if (!app.isReady()) return;
  const canInstallUpdate = currentUpdateState().canInstall === true;
  applicationMenuCanInstallUpdate = canInstallUpdate;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        isDev: !app.isPackaged,
        platform: process.platform,
        recentWorkspaces: nativeWorkspaceSummaries(),
        canInstallUpdate,
        sendCommand: (window, command) => {
          targetWindow(window)?.webContents.send(CHANNELS.menuCommand, command);
        },
        openRecentWorkspace: (window, workspace) => {
          sendWorkspaceActivated(window, workspace);
          refreshNativeWorkspaceSurfaces();
        },
        showAbout: () => {
          void dialog.showMessageBox({
            title: "About dohc",
            message: "dohc",
            detail: `Version ${app.getVersion()}\nYour workspace is a folder.`,
          });
        },
      }),
    ),
  );
}

function refreshNativeWorkspaceSurfaces(): void {
  if (!app.isReady()) return;
  const workspaces = nativeWorkspaceSummaries();
  try {
    app.clearRecentDocuments();
    for (const workspace of [...workspaces].reverse()) {
      app.addRecentDocument(workspace.rootPath);
    }
  } catch {
    // Linux and some dev shells do not expose native recent-document storage.
  }
  if (process.platform === "win32") {
    app.setUserTasks(
      workspaces.slice(0, 10).map((workspace) => ({
        program: process.execPath,
        arguments: `--open-workspace ${quoteWindowsArg(workspace.rootPath)}`,
        iconPath: process.execPath,
        iconIndex: 0,
        title: `Open ${workspace.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace"}`,
        description: workspace.rootPath,
      })),
    );
  }
  refreshApplicationMenu();
}

// Synchronous mirror of the credential store for status derivation (the
// status handler path is hot). Refreshed at ready, login, and logout.
let cachedCredentials: Awaited<ReturnType<CloudLogin["credentials"]>> = null;
let credentialCacheReady: Promise<void> | null = null;
let credentialCacheGeneration = 0;
async function refreshCredentialCache(): Promise<void> {
  const generation = credentialCacheGeneration;
  const credentials = await cloudLogin().credentials();
  if (generation === credentialCacheGeneration) cachedCredentials = credentials;
}
function warmCredentialCache(): Promise<void> {
  credentialCacheReady ??= refreshCredentialCache().catch(() => undefined);
  return credentialCacheReady;
}
function setCachedCredentials(credentials: Awaited<ReturnType<CloudLogin["credentials"]>>): void {
  credentialCacheGeneration += 1;
  cachedCredentials = credentials;
  credentialCacheReady = Promise.resolve();
}
function clearCachedCredentials(): void {
  credentialCacheGeneration += 1;
  cachedCredentials = null;
  credentialCacheReady = null;
}

// Trailing-slash-insensitive server-URL compare: the registry's recorded
// serverUrl must match the server that ISSUED the cached token, or the workspace
// stays local-only. Otherwise machine B's token could be POSTed to server A
// (account takeover) and a re-pointed registry could mass-delete.
function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
function credentialMatchesRemote(remoteServerUrl: string): boolean {
  return (
    cachedCredentials !== null &&
    normalizeServerUrl(cachedCredentials.serverUrl) === normalizeServerUrl(remoteServerUrl)
  );
}

async function remoteForWorkspace(workspaceId: string) {
  await warmCredentialCache();
  const workspace = requireWorkspace(workspaceId);
  const remote = workspace.remote;
  if (!remote) throw new Error("Sync this workspace before sharing.");
  if (!cachedCredentials) throw new Error("Sign in to dohc Cloud first.");
  if (!credentialMatchesRemote(remote.serverUrl)) {
    throw new Error("Sign in to the cloud server this workspace uses.");
  }
  return { workspace, remote, credentials: cachedCredentials };
}

async function cloudJson<T>(
  workspaceId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { remote, credentials } = await remoteForWorkspace(workspaceId);
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${credentials.token}`);
  const response = await fetch(`${remote.serverUrl}${path}`, {
    ...init,
    headers,
  });
  const data = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error ?? `Cloud request failed (${response.status})`);
  }
  return data as T;
}

// Where the Hocuspocus websocket lives. Decision: an explicit
// DOHC_HOCUSPOCUS_URL env wins (self-host points it at their collab server);
// otherwise we derive it from the cloud serverUrl that issued the session by
// swapping the http(s) scheme for ws(s) (so a localhost dev server ->
// ws://localhost, and a real https deploy -> wss://...). The default when
// nothing is known is ws://localhost:1234, the docker-compose.dev.yml port.
const DEFAULT_HOCUSPOCUS_URL = "ws://localhost:1234";
function deriveHocuspocusUrl(serverUrl: string): string {
  const explicit = process.env.DOHC_HOCUSPOCUS_URL?.trim();
  if (explicit) return explicit;
  try {
    const url = new URL(serverUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return DEFAULT_HOCUSPOCUS_URL;
    return url.origin;
  } catch {
    return DEFAULT_HOCUSPOCUS_URL;
  }
}

// The copyable MCP launch config for a workspace. The user's AI tool spawns the
// dohc MCP stdio server with these args; --workspace scopes every tool to this
// root (path containment), --home points it at the desktop registry/state dir.
// DOHC_MCP_COMMAND lets a packaged build override the launcher with its shipped
// binary; the default `dohc-mcp` is the @dohc/mcp bin on PATH.
function mcpConfigFor(rootPath: string): {
  command: string;
  args: string[];
  workspacePath: string;
  home: string;
} {
  const command = process.env.DOHC_MCP_COMMAND?.trim() || "dohc-mcp";
  const home = stateDir();
  const sdkPackageJsonPath = process.env.DOHC_SDK_PACKAGE_JSON?.trim();
  const sdkDependencyRange = process.env.DOHC_SDK_DEPENDENCY_RANGE?.trim();
  const args = ["--workspace", rootPath, "--home", home];
  if (sdkPackageJsonPath) args.push("--sdk-package-json", sdkPackageJsonPath);
  if (sdkDependencyRange) args.push("--sdk-dependency-range", sdkDependencyRange);
  return {
    command,
    args,
    workspacePath: rootPath,
    home,
  };
}

function mcpRuntimeConfigFor(rootPath: string): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const config = mcpConfigFor(rootPath);
  const workspace = listWorkspaces().find((entry) => entry.rootPath === rootPath);
  const remote = workspace?.remote;
  const env =
    remote && cachedCredentials && credentialMatchesRemote(remote.serverUrl)
      ? {
          DOHC_MCP_CLOUD_SERVER_URL: cachedCredentials.serverUrl,
          DOHC_MCP_CLOUD_EMAIL: cachedCredentials.email,
          DOHC_MCP_CLOUD_TOKEN: cachedCredentials.token,
        }
      : undefined;
  return {
    command: config.command,
    args: config.args,
    ...(env ? { env } : {}),
  };
}

function engineForWorkspace(workspace: { workspaceId: string; rootPath: string }) {
  const remote = findWorkspace(workspace.workspaceId)?.remote;
  if (!remote || !cachedCredentials) return null;
  // Only sync when the session belongs to the server this workspace is bound
  // to; a mismatch keeps it local-only (no token leak, no mass-delete).
  if (!credentialMatchesRemote(remote.serverUrl)) return null;
  return createCloudSyncEngine({
    rootDir: workspace.rootPath,
    remoteWorkspaceId: remote.remoteWorkspaceId,
    serverUrl: remote.serverUrl,
    token: cachedCredentials.token,
    onChange: notifyRenderer,
  });
}

const activity = createWorkspaceActivity(notifyRenderer, {
  cloudStateFor: (workspaceId) => {
    const remote = findWorkspace(workspaceId)?.remote;
    return {
      enabled: !!remote,
      // connected requires the session to belong to this workspace's server.
      connected: !!remote && credentialMatchesRemote(remote.serverUrl),
    };
  },
  engineFor: engineForWorkspace,
  // The flag-gated engine capture (see engineCaptureGate.ts — shared with the
  // arc-gate QA harness so the harness asserts against the REAL gate).
  captureFor: captureForFlaggedWorkspace,
});
// Local agent integration: owns the per-workspace MCP child + active-run slot
// and persists agent-run records. The run slot is wired into the watcher
// (workspaceActivity.setAgentRun) so a run's writes are attributed to the
// agent. The MCP child is spawned only in a packaged/dev runtime where a server
// entry resolves; otherwise the toggle still flips and the user's AI tool
// launches its own copy via the Settings config snippet.
const agentIntegration = createAgentIntegration({
  rootFor: (workspaceId) => findWorkspace(workspaceId)?.rootPath ?? null,
  setAgentRun: (workspaceId, run) => activity.setAgentRun(workspaceId, run),
  home: stateDir(),
  // Every terminal run path funnels through endAgentRun (driver
  // turn-completed via AgentSessionManager, panel Stop, the endAgentRun IPC)
  // — the try-in-version review card listens on that single seam.
  // tryInVersionSessions is initialized just below, before any run can end.
  onRunEnded: ({ workspaceId, runId, status }) =>
    tryInVersionSessions.handleRunEnded(workspaceId, runId, status),
});
// "Try it in a version" (PR 0N-2): one gesture composing EXISTING operations
// — fork-and-switch on the engine capture chain, then a dohc-tracked run —
// and a review state when the run ends. Resolution of the capture mirrors
// requireEngineCapture (workspace identity from the registry, engine flag
// gate); unflagged workspaces reject with the same product message.
const tryInVersionSessions = createTryInVersionSessions({
  operationsFor: async (workspaceId) => {
    desktopMarks.mark("try-in-version-ops-start");
    const workspace = requireWorkspace(workspaceId);
    await activity.open(workspace);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      throw new Error("Versions are not enabled for this workspace.");
    }
    desktopMarks.measureSince("try-in-version-ops", "try-in-version-ops-start");
    return capture;
  },
  startRun: async (workspaceId, task, driverId) => {
    desktopMarks.mark("try-in-version-run-start-begin");
    if (driverId) {
      // The agent panel's session path: the driver does the work and the run
      // id comes from the session (startSession starts the run through
      // AgentIntegration, so 0N-1 attribution applies identically).
      const sessions = await agentSessionManager();
      const snapshot = await sessions.startSession({
        workspaceId,
        driverId,
        prompt: task,
      });
      const session = snapshot.session;
      if (!session?.runId || session.status === "failed") {
        throw new Error(session?.lastError ?? "The agent could not start.");
      }
      return { id: session.runId };
    }
    // No driver: a bare dohc-tracked run — the user's own agent tool does the
    // work in the folder and dohc attributes what it changes.
    const run = await agentIntegration.startAgentRun(workspaceId);
    desktopMarks.measureSince(
      "try-in-version-run-start",
      "try-in-version-run-start-begin",
    );
    return run;
  },
  onStateChanged: () => notifyRenderer(),
});
let cachedAgentSessions: AgentSessionManager | null = null;
async function agentSessionManager(): Promise<AgentSessionManager> {
  if (!cachedAgentSessions) {
    const [{ createAgentDriverRegistry }, { createDesktopAgentDrivers }, { createAgentSessionManager }] =
      await Promise.all([
        import("./agents/AgentDriver"),
        import("./agents/AgentProcessDrivers"),
        import("./agents/AgentSessionManager"),
      ]);
    cachedAgentSessions = createAgentSessionManager({
      registry: createAgentDriverRegistry(createDesktopAgentDrivers(process.env)),
      integration: agentIntegration,
      rootFor: (workspaceId) => findWorkspace(workspaceId)?.rootPath ?? null,
      mcpFor: mcpRuntimeConfigFor,
    });
  }
  return cachedAgentSessions;
}

// Linked Chats (PR 0M-5): per-workspace store over the SAME engine.db the
// versioned text store uses (separate WAL-safe connection). Built lazily on
// first chat IPC and only ever for flagged workspaces (the handlers gate on
// the engine capture being attached).
const linkedChatStores = new Map<string, LinkedChatStore>();
function linkedChatStoreFor(workspace: { workspaceId: string; rootPath: string }): LinkedChatStore {
  const existing = linkedChatStores.get(workspace.workspaceId);
  if (existing) return existing;
  const store = createLinkedChatStore(workspace.rootPath);
  linkedChatStores.set(workspace.workspaceId, store);
  return store;
}

// Engine search (WS-D): per-workspace versioned-text-store connection for the
// indexed search path, the same lazy-singleton idiom as linkedChatStores —
// search-as-you-type must not pay a fresh SQLite open (and its quick_check)
// per keystroke. Closed beside the chat stores at quit.
const engineSearchStores = new Map<string, VersionedTextStore>();
function engineSearchStoreFor(workspace: {
  workspaceId: string;
  rootPath: string;
}): VersionedTextStore {
  const existing = engineSearchStores.get(workspace.workspaceId);
  if (existing) return existing;
  const store = createVersionedTextStore(workspace.rootPath);
  engineSearchStores.set(workspace.workspaceId, store);
  return store;
}

// The human author every renderer-sent chat message is attributed to. Main
// derives it — the renderer never supplies identity. At alpha the desktop's
// only durable identity is the dohc Cloud session email; signed-out
// workspaces fall back to "You".
function localUserDisplayName(): string {
  return cachedCredentials?.email ?? "You";
}

// Content search (Phase E5.0): at most one live ripgrep child per renderer,
// tracked by handle. A new search, an explicit cancel, the renderer's
// webContents going away, and app quit each kill the SPECIFIC tracked child.
const searchRegistry = createSearchRegistry({ rgPath });
// Senders whose 'destroyed' cleanup hook is already attached.
const searchCleanupHooked = new WeakSet<Electron.WebContents>();

function fallbackUpdateState(): PublicUpdateState {
  const currentVersion = app.getVersion();
  const state = publicUpdateState(initialUpdateState, {
    currentVersion,
    channel: resolveUpdateChannel(currentVersion),
  });
  return { ...state, canCheck: false, canInstall: false };
}

function parseUpdateStateForIpc(state: PublicUpdateState): UpdateStateEvent | null {
  const parsed = UpdateStateEvent.safeParse(state);
  return parsed.success ? parsed.data : null;
}

function currentUpdateState(): UpdateStateEvent {
  const fallback = fallbackUpdateState();
  return parseUpdateStateForIpc(autoUpdateController?.publicState() ?? fallback) ?? fallback;
}

function broadcastUpdateState(state: PublicUpdateState): void {
  const payload = parseUpdateStateForIpc(state);
  if (!payload) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.updateState, payload);
  }
  if (payload.canInstall !== applicationMenuCanInstallUpdate) {
    refreshApplicationMenu();
  }
}

// Quit must wait for the final settle-window flush AND its history record to
// be durably written — otherwise a save right before quit is silently lost.
// Bounded so a wedged disk can't make the app unquittable.
let quitting = false;
app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  searchRegistry.killAll();
  const agentSessionStop = cachedAgentSessions?.stopAll() ?? Promise.resolve();
  agentIntegration.stopAll();
  // Linked chat stores are lazy singletons with SQLite handles on the shared
  // engine.db; close them at quit so WAL locks never outlive the app.
  const chatStoreStop = Promise.all(
    [...linkedChatStores.values()].map((store) => store.close().catch(() => undefined)),
  );
  // Engine search stores hold the same kind of lazy SQLite handle; close them
  // with the chat stores so WAL locks never outlive the app.
  const searchStoreStop = Promise.all(
    [...engineSearchStores.values()].map((store) => store.close().catch(() => undefined)),
  );
  void Promise.race([
    Promise.all([
      agentSessionStop,
      activity.stopAll(),
      chatStoreStop,
      searchStoreStop,
    ]).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => app.exit(0));
});

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
    // On Windows, relative() across drives returns an absolute path
    // (C:\ws -> D:\evil gives "D:\evil"), which is NOT a descendant.
    if (
      rel.length > 0 &&
      !isAbsolute(rel) &&
      !rel.startsWith("..") &&
      !rel.startsWith(sep)
    ) {
      return true;
    }
  }
  return false;
}

const OPEN_WORKSPACE_ARG = "--open-workspace";
const pendingOpenPaths: string[] = [];

function collectOpenWorkspaceArgs(argv: string[]): string[] {
  const paths: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === OPEN_WORKSPACE_ARG) {
      const next = argv[index + 1];
      if (next) {
        paths.push(next);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith(`${OPEN_WORKSPACE_ARG}=`)) {
      paths.push(arg.slice(OPEN_WORKSPACE_ARG.length + 1));
      continue;
    }
    if (arg.startsWith("--")) continue;
    const portable = arg.replace(/\\/g, "/");
    if (portable.endsWith("/dist/main/main.js")) continue;
    if (isAbsolute(arg) && arg !== process.execPath) paths.push(arg);
  }
  return [...new Set(paths)];
}

function nearestWorkspaceRoot(startPath: string): string | null {
  let current = startPath;
  while (true) {
    if (existsSync(join(current, ".dohc", "manifest.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function workspaceRootForOpenPath(path: string): string | null {
  let normalized: string;
  try {
    normalized = normalizeAbsolutePath(path);
  } catch {
    return null;
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(normalized);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return nearestWorkspaceRoot(normalized) ?? normalized;
  if (!stats.isFile()) return null;
  const parent = dirname(normalized);
  return nearestWorkspaceRoot(parent) ?? parent;
}

async function ensureWorkspaceRegistered(rootPath: string): Promise<WorkspaceSummary> {
  const normalized = normalizeAbsolutePath(rootPath);
  const existing = workspaceSummaries().find(
    (workspace) => normalizeAbsolutePath(workspace.rootPath) === normalized,
  );
  if (existing) return existing;
  const created = await createWorkspaceFolder({
    rootPath: normalized,
    kind: "personal",
  });
  const summary = WorkspaceSummary.parse(created);
  registerWorkspace(created);
  refreshNativeWorkspaceSurfaces();
  return summary;
}

async function openWorkspacePath(
  path: string,
  window?: BrowserWindow,
): Promise<WorkspaceSummary | null> {
  const rootPath = workspaceRootForOpenPath(path);
  if (!rootPath) return null;
  const workspace = await ensureWorkspaceRegistered(rootPath);
  sendWorkspaceActivated(window, workspace);
  refreshNativeWorkspaceSurfaces();
  return workspace;
}

async function openWorkspacePaths(
  paths: string[],
  window?: BrowserWindow,
): Promise<WorkspaceSummary | null> {
  let lastOpened: WorkspaceSummary | null = null;
  for (const path of paths) {
    const opened = await openWorkspacePath(path, window).catch(() => null);
    if (opened) lastOpened = opened;
  }
  return lastOpened;
}

async function flushPendingOpenPaths(
  window?: BrowserWindow,
): Promise<WorkspaceSummary | null> {
  if (pendingOpenPaths.length === 0) return null;
  const paths = pendingOpenPaths.splice(0);
  return openWorkspacePaths(paths, window);
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

function requireAuthorizedWorkspace(
  event: IpcMainInvokeEvent,
  workspaceId: string,
) {
  assertTrustedSender(event);
  // Desktop authorization is main-process owned: the renderer may name a
  // workspace, but only registered workspaces in this local profile resolve,
  // and workspaceAssets re-checks filesystem containment before reading.
  return requireWorkspace(workspaceId);
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
    return WorkspaceRegistryResult.parse({
      workspaces: prioritizePreferredWorkspace(workspaceSummaries()),
    });
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
    desktopMarks.mark("workspace-create-start");
    const created = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: input.kind,
    });
    desktopMarks.measureSince("workspace-create", "workspace-create-start");
    // Parse BEFORE register: a summary that fails the contract must never be
    // persisted into the registry, or every later registry read would throw
    // and the app would launch to a permanent blank window.
    const summary = WorkspaceSummary.parse(created);
    registerWorkspace(created);
    refreshNativeWorkspaceSurfaces();
    return summary;
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
    // Parse-then-register (see createLocalWorkspace): a foreign manifest's
    // workspaceId is untrusted input — an oversized or non-hostname-safe id
    // must fail the attach with a visible error, not brick the registry.
    const summary = WorkspaceSummary.parse(attached);
    registerWorkspace(attached);
    refreshNativeWorkspaceSurfaces();
    return summary;
  });

  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ListWorkspaceFilesResult.parse(await listFiles(workspace.rootPath));
  });

  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceFilePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const path = await createFile(workspace.rootPath, input.relativePath);
    return CreateWorkspaceFileResult.parse({ path });
  });

  ipcMain.handle(CHANNELS.createWorkspaceFolder, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceFolderPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const path = await createFolder(workspace.rootPath, input.relativePath);
    return CreateWorkspaceFileResult.parse({ path });
  });

  ipcMain.handle(CHANNELS.moveWorkspacePath, async (event, payload) => {
    assertTrustedSender(event);
    const input = MoveWorkspacePathPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Flagged workspaces coordinate single-file renames through the engine
    // FIRST so the file keeps its stable object id (linked Chats survive the
    // rename). Anything the engine declines — folders, binary, untracked —
    // returns a no-op finisher and is captured as delete+write as before.
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    const finishRename = capture
      ? await capture.beginFileRename(input.fromPath, input.toPath)
      : null;
    try {
      const path = await movePath(workspace.rootPath, input.fromPath, input.toPath);
      await finishRename?.(true);
      return CreateWorkspaceFileResult.parse({ path });
    } catch (error) {
      await finishRename?.(false);
      throw error;
    }
  });

  ipcMain.handle(CHANNELS.deleteWorkspacePath, async (event, payload) => {
    assertTrustedSender(event);
    const input = DeleteWorkspacePathPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // shell.trashItem first (recoverable on every platform); deletePath
    // falls back to the workspace's .dohc/trash where the OS rejects
    // (cross-filesystem mounts) — never a hard delete either way.
    const result = await deletePath(workspace.rootPath, input.relativePath, (p) =>
      shell.trashItem(p),
    );
    return DeleteWorkspacePathResult.parse(result);
  });

  ipcMain.handle(CHANNELS.exportWorkspaceZip, async (event, payload) => {
    assertTrustedSender(event);
    const input = ExportWorkspaceZipPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Gather + bound BEFORE asking where to save: an over-limit export
    // refuses without ever showing a dialog.
    const { entries, baseName } = await collectZipEntries(
      workspace.rootPath,
      input.relativePath,
    );
    // Test seam (DOHC_TEST_PICK_PATH precedent): native save dialogs cannot
    // be driven by Playwright. Read per-invoke so a spec can repoint it.
    const testSave = process.env.DOHC_TEST_SAVE_PATH;
    let target: string | null;
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testSave) {
      target = testSave;
    } else {
      const result = await dialog.showSaveDialog({
        title: "Export as zip",
        defaultPath: `${baseName}.zip`,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      target = result.canceled ? null : (result.filePath ?? null);
    }
    if (target !== null) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(target, buildStoreZip(entries));
    }
    return ExportWorkspaceZipResult.parse({ path: target });
  });

  // Native explorer context menu over the CLOSED EXPLORER_MENU_COMMANDS set:
  // main owns every label and the item structure (the renderer only names
  // what was right-clicked), and the chosen id resolves the SAME invoke —
  // null on dismiss. "Reveal in file manager" is performed HERE (containment
  // first) so no broader open-path IPC needs to exist for it.
  ipcMain.handle(CHANNELS.showExplorerMenu, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShowExplorerMenuPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);

    const chosen = await new Promise<ExplorerMenuCommand | null>((resolve) => {
      // Test seam (DOHC_TEST_PICK_PATH precedent): a NATIVE menu cannot be
      // driven by Playwright. Read per-invoke so a spec can repoint it via
      // electronApp.evaluate between right-clicks; values outside the closed
      // tuple resolve null exactly like a dismissed menu.
      if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
        const choice = process.env.DOHC_TEST_EXPLORER_MENU_CHOICE;
        if (choice !== undefined) {
          const parsed = ShowExplorerMenuResult.safeParse(choice);
          resolve(parsed.success ? parsed.data : null);
          return;
        }
      }
      let picked: ExplorerMenuCommand | null = null;
      const item = (
        label: string,
        id: ExplorerMenuCommand,
      ): Electron.MenuItemConstructorOptions => ({
        label,
        click: () => {
          picked = id;
        },
      });
      const separator = { type: "separator" as const };
      const template: Electron.MenuItemConstructorOptions[] =
        input.kind === "root"
          ? [
              item("New File", "new-file"),
              item("New Folder", "new-folder"),
              item("Data Fragments…", "import-export"),
              separator,
              item("Import Files…", "import-files"),
              item("Export Workspace as Zip…", "export-zip"),
            ]
          : [
              ...(input.kind === "folder"
                ? [
                    item("New File", "new-file"),
                    item("New Folder", "new-folder"),
                    separator,
                  ]
                : []),
              item("Rename", "rename"),
              item("Delete", "delete"),
              input.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
              separator,
              ...(input.kind === "file"
                ? [item("Data Fragments…", "import-export")]
                : []),
              item("Export as Zip…", "export-zip"),
              item("Reveal in File Manager", "open-externally"),
            ];
      const menu = Menu.buildFromTemplate(template);
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      menu.popup({
        window,
        // The close callback can fire before the clicked item's handler —
        // defer one tick so `picked` is settled either way.
        callback: () => setImmediate(() => resolve(picked)),
      });
    });

    if (chosen === "open-externally" && input.path) {
      // Containment before the OS sees the path (resolveWorkspaceFile:
      // validate + realpath + inside-root), same rule as openFileExternally.
      const { realTarget } = await resolveWorkspaceFile(
        workspace.rootPath,
        input.path,
      );
      shell.showItemInFolder(realTarget);
    }
    return ShowExplorerMenuResult.parse(chosen);
  });

  ipcMain.handle(CHANNELS.showWorkbenchMenu, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShowWorkbenchMenuPayload.parse(payload);
    requireWorkspace(input.workspaceId);

    const chosen = await new Promise<WorkbenchMenuCommand | null>((resolve) => {
      if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
        const choice = process.env.DOHC_TEST_WORKBENCH_MENU_CHOICE;
        if (choice !== undefined) {
          const parsed = ShowWorkbenchMenuResult.safeParse(choice);
          resolve(parsed.success ? parsed.data : null);
          return;
        }
      }
      let picked: WorkbenchMenuCommand | null = null;
      const item = (
        label: string,
        id: WorkbenchMenuCommand,
        options: Electron.MenuItemConstructorOptions = {},
      ): Electron.MenuItemConstructorOptions => ({
        label,
        ...options,
        click: () => {
          picked = id;
        },
      });
      const separator = { type: "separator" as const };
      const editRoles: Electron.MenuItemConstructorOptions[] = [
        { role: "undo" },
        { role: "redo" },
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ];
      const template: Electron.MenuItemConstructorOptions[] =
        input.context === "tab"
          ? [
              item("Close Tab", "close-tab"),
              item("Close Other Tabs", "close-other-tabs"),
              separator,
              item("Data Fragments…", "import-export"),
              separator,
              item("Copy Path", "copy-path"),
              item("Show in Explorer", "show-in-explorer"),
            ]
          : input.context === "status"
            ? [
                item("Open Agent Panel", "open-agent"),
                item("Open History", "open-history"),
                separator,
                item("Connect dohc Cloud", "connect-cloud"),
                item("Settings", "settings"),
                separator,
                item("Check for Updates…", "check-updates"),
                item("Update and Restart", "install-update", {
                  enabled: currentUpdateState().canInstall === true,
                }),
                separator,
                item("Toggle Theme", "toggle-theme"),
              ]
            : [item("Data Fragments…", "import-export"), separator, ...editRoles];
      const menu = Menu.buildFromTemplate(template);
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      menu.popup({
        window,
        callback: () => setImmediate(() => resolve(picked)),
      });
    });

    return ShowWorkbenchMenuResult.parse(chosen);
  });

  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // OS drag-in path: renderer-supplied absolute paths (see the trust-delta
    // note on the payload) re-validated by importDroppedPaths — regular
    // files only, never any registered workspace's .dohc metadata.
    if (input.droppedPaths !== undefined) {
      const imported = await importDroppedPaths(
        workspace.rootPath,
        input.droppedPaths,
        listWorkspaces().map((ws) => ws.rootPath),
      );
      return ImportWorkspaceFilesResult.parse({ imported });
    }
    const picked = testImportPaths();
    const result =
      picked === null
        ? await dialog.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            title: "Import files into workspace",
          })
        : { canceled: false, filePaths: picked };
    const imported = result.canceled
      ? []
      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
    return ImportWorkspaceFilesResult.parse({ imported });
  });

  ipcMain.handle(CHANNELS.createDataFragment, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateDataFragmentPayload.parse(payload);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    return CreateDataFragmentResult.parse(
      await createCloudDataFragment(
        (path, init) => cloudJson(input.workspaceId, path, init),
        remote.remoteWorkspaceId,
        input,
      ),
    );
  });

  ipcMain.handle(CHANNELS.listDataFragments, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListDataFragmentsPayload.parse(payload);
    return ListDataFragmentsResult.parse(
      await listCloudDataFragments((path, init) =>
        cloudJson(input.workspaceId, path, init),
      ),
    );
  });

  ipcMain.handle(CHANNELS.readDataFragment, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadDataFragmentPayload.parse(payload);
    return ReadDataFragmentResult.parse(
      await readCloudDataFragment(
        (path, init) => cloudJson(input.workspaceId, path, init),
        input.fragmentId,
      ),
    );
  });

  ipcMain.handle(CHANNELS.revokeDataFragment, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeDataFragmentPayload.parse(payload);
    await revokeCloudDataFragment(
      (path, init) => cloudJson(input.workspaceId, path, init),
      input.fragmentId,
    );
  });

  // Site preview SDK reads use the combined helper to make the main-process
  // workspace authorization boundary explicit. Older workspace handlers keep
  // the equivalent assertTrustedSender + requireWorkspace steps separate.
  ipcMain.handle(CHANNELS.readWorkspaceText, async (event, payload) => {
    const input = ReadWorkspaceTextPayload.parse(payload);
    const workspace = requireAuthorizedWorkspace(event, input.workspaceId);
    return ReadWorkspaceTextResult.parse(
      await readWorkspaceText(workspace.rootPath, input.relativePath),
    );
  });

  ipcMain.handle(CHANNELS.writeWorkspaceText, async (event, payload) => {
    assertTrustedSender(event);
    const input = WriteWorkspaceTextPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    await writeWorkspaceText(workspace.rootPath, input.relativePath, input.text);
  });

  ipcMain.handle(CHANNELS.openFileExternally, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenFileExternallyPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Resolve+contain first: only a real file inside the workspace can be
    // handed to the OS opener — never an arbitrary path or URL. window.open
    // remains fully denied; this is the only sanctioned external-open path.
    const { realTarget } = await resolveWorkspaceFile(
      workspace.rootPath,
      input.relativePath,
    );
    const error = await shell.openPath(realTarget);
    if (error) throw new Error(error);
  });

  ipcMain.handle(CHANNELS.readWorkspaceGraph, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadWorkspaceGraphPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return WorkspaceGraphResult.parse(await readWorkspaceGraph(workspace.rootPath));
  });

  // The ONLY path from renderer to the OS browser (window.open is a pure
  // deny): http(s) URLs only, used by cloud login's verification step.
  ipcMain.handle(CHANNELS.openExternalUrl, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenExternalUrlPayload.parse(payload);
    if (!isSafeExternalUrl(input.url)) {
      throw new Error(`Refusing to open non-http(s) URL externally`);
    }
    await shell.openExternal(input.url);
  });

  ipcMain.handle(CHANNELS.cloudLoginStart, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudLoginStartPayload.parse(payload ?? {});
    return CloudLoginStartResult.parse(await cloudLogin().start(input.serverUrl));
  });

  ipcMain.handle(CHANNELS.cloudLoginPoll, async (event) => {
    assertTrustedSender(event);
    const result = await cloudLogin().poll();
    if (result.status === "complete") {
      await refreshCredentialCache();
      // Attach engines to already-open cloud-enabled workspaces that were
      // opened local-only because no session existed yet.
      activity.reconcileCloud(engineForWorkspace);
    }
    return CloudLoginPollResult.parse(result);
  });

  ipcMain.handle(CHANNELS.cloudStatus, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudStatusPayload.parse(payload ?? {});
    const status = await cloudLogin().status();
    return CloudStatusResult.parse({
      ...status,
      ...(input.workspaceId
        ? { workspaceSynced: !!findWorkspace(input.workspaceId)?.remote }
        : {}),
    });
  });

  ipcMain.handle(CHANNELS.cloudLogout, async (event) => {
    assertTrustedSender(event);
    await cloudLogin().logout();
    clearCachedCredentials();
    // Stop + drop active engines so edits after Disconnect never push with the
    // now-cleared session.
    await activity.stopEngines();
    notifyRenderer();
  });

  // Enabling sync claims the workspace id on the server (first claimant owns
  // it; members re-enable idempotently; strangers are refused), records the
  // remote identity, and starts the merge engine: pull, then push everything
  // local. Requires a signed-in session.
  ipcMain.handle(CHANNELS.cloudEnableSync, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudEnableSyncPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const credentials = await cloudLogin().credentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first");
    setCachedCredentials(credentials);

    const response = await fetch(`${credentials.serverUrl}/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.token}`,
      },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, kind: workspace.kind }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok === false) {
      throw new Error(
        response.status === 403
          ? "This workspace id is already claimed by another account"
          : (body.error ?? `Enabling sync failed (${response.status})`),
      );
    }

    setWorkspaceRemote(workspace.workspaceId, {
      serverUrl: credentials.serverUrl,
      remoteWorkspaceId: workspace.workspaceId,
    });
    await activity.enableCloud(workspace);
    return SyncStatusResult.parse(activity.getStatus(workspace.workspaceId));
  });

  ipcMain.handle(CHANNELS.listWorkspaceShares, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceSharesPayload.parse(payload);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    return ListWorkspaceSharesResult.parse(
      await cloudJson(
        input.workspaceId,
        `/workspaces/${encodeURIComponent(remote.remoteWorkspaceId)}/shares`,
      ),
    );
  });

  ipcMain.handle(CHANNELS.createWorkspaceShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceSharePayload.parse(payload);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    return CreateWorkspaceShareResult.parse(
      await cloudJson(
        input.workspaceId,
        `/workspaces/${encodeURIComponent(remote.remoteWorkspaceId)}/shares`,
        {
          method: "POST",
          body: JSON.stringify({
            atomPath: input.atomPath,
            recipientEmail: input.recipientEmail,
            capability: input.capability,
          }),
        },
      ),
    );
  });

  ipcMain.handle(CHANNELS.revokeWorkspaceShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeWorkspaceSharePayload.parse(payload);
    await cloudJson(input.workspaceId, `/shares/${encodeURIComponent(input.shareId)}`, {
      method: "DELETE",
    });
  });

  ipcMain.handle(CHANNELS.listWorkspaceMembers, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceSharesPayload.parse(payload);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    return ListWorkspaceMembersResult.parse(
      await cloudJson(
        input.workspaceId,
        `/workspaces/${encodeURIComponent(remote.remoteWorkspaceId)}/members`,
      ),
    );
  });

  ipcMain.handle(CHANNELS.listWorkspaceInvites, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceSharesPayload.parse(payload);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    return ListWorkspaceInvitesResult.parse(
      await cloudJson(
        input.workspaceId,
        `/workspaces/${encodeURIComponent(remote.remoteWorkspaceId)}/invites`,
      ),
    );
  });

  ipcMain.handle(CHANNELS.createWorkspaceInvite, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceInvitePayload.parse(payload);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    return CreateWorkspaceInviteResult.parse(
      await cloudJson(
        input.workspaceId,
        `/workspaces/${encodeURIComponent(remote.remoteWorkspaceId)}/invites`,
        {
          method: "POST",
          body: JSON.stringify({ email: input.email }),
        },
      ),
    );
  });

  ipcMain.handle(CHANNELS.revokeWorkspaceInvite, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeWorkspaceInvitePayload.parse(payload);
    await cloudJson(input.workspaceId, `/invites/${encodeURIComponent(input.inviteId)}`, {
      method: "DELETE",
    });
  });

  // Mints a short-lived live-co-editing token for one atom. Only available for
  // a SHARED cloud workspace (registry remote set) with a signed-in session
  // that belongs to that workspace's server. The session Bearer never crosses
  // IPC: main calls the workspace-api collab-token endpoint and hands back only
  // the 5-min collab JWT, the doc name, and the websocket URL. Any other case
  // (personal/local-only, signed out, server mismatch) returns available:false
  // so the renderer falls back to the plain local autosave editor.
  ipcMain.handle(CHANNELS.collabToken, async (event, payload) => {
    assertTrustedSender(event);
    const input = CollabTokenPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const remote = workspace.remote;
    if (workspace.kind !== "shared" || !remote) {
      return CollabTokenResult.parse({ available: false });
    }
    await warmCredentialCache();
    if (!cachedCredentials || !credentialMatchesRemote(remote.serverUrl)) {
      return CollabTokenResult.parse({ available: false });
    }
    const response = await fetch(
      `${remote.serverUrl}/workspaces/${encodeURIComponent(remote.remoteWorkspaceId)}/collab/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cachedCredentials.token}`,
        },
        body: JSON.stringify({ atomPath: input.relativePath }),
      },
    );
    // Server fails closed on a missing collab secret, non-member, or unknown
    // atom — treat every non-OK response as "no live session", never throw, so
    // the editor stays usable in local mode.
    if (!response.ok) return CollabTokenResult.parse({ available: false });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; token?: string; documentName?: string; baseMarkdown?: string }
      | null;
    if (
      !body?.ok ||
      !body.token ||
      !body.documentName ||
      typeof body.baseMarkdown !== "string"
    ) {
      return CollabTokenResult.parse({ available: false });
    }
    return CollabTokenResult.parse({
      available: true,
      token: body.token,
      documentName: body.documentName,
      baseMarkdown: body.baseMarkdown,
      wsUrl: deriveHocuspocusUrl(remote.serverUrl),
    });
  });

  ipcMain.handle(CHANNELS.readWorkspaceDatabase, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadWorkspaceDatabasePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return DatabaseSnapshotResult.parse(
      await readDatabaseSnapshot(workspace.rootPath, input.relativePath),
    );
  });

  ipcMain.handle(CHANNELS.applyDatabaseEdit, async (event, payload) => {
    assertTrustedSender(event);
    const input = ApplyDatabaseEditPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return DatabaseSnapshotResult.parse(
      await applyDatabaseEdit(
        workspace.rootPath,
        input.relativePath,
        input.edit,
        { kind: "user", userId: "local" },
        Date.now(),
      ),
    );
  });

  ipcMain.handle(CHANNELS.importToDatabase, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportToDatabasePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ImportToDatabaseResult.parse(
      await importToDatabase(
        workspace.rootPath,
        input.sourceRelativePath,
        input.databaseRelativePath,
        input.tableName,
      ),
    );
  });

  ipcMain.handle(CHANNELS.listSites, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListSitesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ListSitesResult.parse({ sites: await listSitePackages(workspace.rootPath) });
  });

  ipcMain.handle(CHANNELS.getSitePackage, async (event, payload) => {
    assertTrustedSender(event);
    const input = SitePackagePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return SitePackageResult.parse(
      await getSitePackage(workspace.rootPath, input.path),
    );
  });

  ipcMain.handle(CHANNELS.startSitePreview, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartSitePreviewPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const site = await getSitePackage(workspace.rootPath, input.siteRoot);
    if (!site) throw new Error(`Not a detected site: ${input.siteRoot}`);
    return StartSitePreviewResult.parse(
      await startPreviewForSite({
        workspaceId: input.workspaceId,
        workspaceRoot: workspace.rootPath,
        site,
        mode: input.mode,
      }),
    );
  });

  ipcMain.handle(CHANNELS.stopSitePreview, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopSitePreviewPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    await withSitePreviewStartLock(
      sitePreviewKey(input.workspaceId, input.siteRoot),
      () => stopSitePreviewHandle(input.workspaceId, input.siteRoot),
    );
  });

  ipcMain.handle(CHANNELS.openWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenWorkspacePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const previousWorkspaceId = preferredWorkspaceId;
    if (previousWorkspaceId && previousWorkspaceId !== workspace.workspaceId) {
      await stopSitePreviewsForWorkspace(previousWorkspaceId);
    }
    preferredWorkspaceId = workspace.workspaceId;
    refreshNativeWorkspaceSurfaces();
    return SyncStatusResult.parse(await activity.open(workspace));
  });

  // Named versions (PR 0M-4). Every handler resolves the workspace through
  // requireWorkspace (renderer identity is never trusted) and is gated on the
  // workspace-engine alpha capture being attached — for unflagged workspaces
  // the calls reject.
  async function requireEngineCapture(workspaceId: string, unavailable: string) {
    const workspace = requireWorkspace(workspaceId);
    // Idempotent: guarantees the watcher + capture are live before any
    // engine operation touches the chain.
    await activity.open(workspace);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      throw new Error(unavailable);
    }
    return { workspace, capture };
  }

  async function requireVersionOperations(workspaceId: string) {
    const { capture } = await requireEngineCapture(
      workspaceId,
      "Versions are not enabled for this workspace.",
    );
    return capture;
  }

  function workspaceVersionForIpc(version: {
    id: string;
    name: string;
    kind: "main" | "named";
    createdAtMs: number;
    forkPoint?: { versionId: string };
  }): WorkspaceVersionRecord {
    return {
      id: version.id,
      name: version.name,
      kind: version.kind,
      createdAtMs: version.createdAtMs,
      canMergeIntoMain:
        version.kind === "named" && version.forkPoint?.versionId === "main",
    };
  }

  function versionConflictForIpc(conflict: {
    id: string;
    path: string;
    sourceVersionId: string;
    targetVersionId: string;
    current: { exists: boolean; text?: string };
    incoming: { exists: boolean; text?: string };
    base: { exists: boolean; text?: string };
  }): WorkspaceVersionConflict {
    return {
      conflictId: conflict.id,
      path: conflict.path,
      sourceVersionId: conflict.sourceVersionId,
      targetVersionId: conflict.targetVersionId,
      currentText: conflict.current.exists ? (conflict.current.text ?? "") : null,
      incomingText: conflict.incoming.exists ? (conflict.incoming.text ?? "") : null,
      baseText: conflict.base.exists ? (conflict.base.text ?? "") : null,
    };
  }

  ipcMain.handle(CHANNELS.listWorkspaceVersions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const snapshot = await capture.listVersions();
    return ListWorkspaceVersionsResult.parse({
      versions: snapshot.versions.map(workspaceVersionForIpc),
      activeVersionId: snapshot.activeVersionId,
    });
  });

  ipcMain.handle(CHANNELS.createWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const snapshot = await capture.createVersion(input.name);
    notifyRenderer();
    return ListWorkspaceVersionsResult.parse({
      versions: snapshot.versions.map(workspaceVersionForIpc),
      activeVersionId: snapshot.activeVersionId,
    });
  });

  ipcMain.handle(CHANNELS.switchWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = SwitchWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const result = await capture.switchVersion(input.versionId);
    notifyRenderer();
    return SwitchWorkspaceVersionResult.parse(result);
  });

  ipcMain.handle(CHANNELS.compareWorkspaceVersions, async (event, payload) => {
    assertTrustedSender(event);
    const input = CompareWorkspaceVersionsPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    return CompareWorkspaceVersionsResult.parse({
      files: await capture.compareVersions(input.versionId),
    });
  });

  ipcMain.handle(CHANNELS.mergeWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = MergeWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const result = await capture.mergeVersionIntoMain(input.versionId);
    notifyRenderer();
    return MergeWorkspaceVersionResult.parse({
      mergedFileCount: result.mergedFileCount,
      unchangedFileCount: result.unchangedFileCount,
      conflicts: result.conflicts.map(versionConflictForIpc),
    });
  });

  ipcMain.handle(CHANNELS.listWorkspaceVersionConflicts, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const conflicts = await capture.listOpenConflicts();
    return ListWorkspaceVersionConflictsResult.parse({
      conflicts: conflicts.map(versionConflictForIpc),
    });
  });

  ipcMain.handle(
    CHANNELS.resolveWorkspaceVersionConflict,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = ResolveWorkspaceVersionConflictPayload.parse(payload);
      const capture = await requireVersionOperations(input.workspaceId);
      const resolution =
        input.resolution.kind === "keep-current"
          ? ({ kind: "keep-current" } as const)
          : input.resolution.kind === "keep-incoming"
            ? ({ kind: "apply-incoming" } as const)
            : ({ kind: "apply-merged", text: input.resolution.text } as const);
      const outcome = await capture.resolveConflict(input.conflictId, resolution);
      notifyRenderer();
      return ResolveWorkspaceVersionConflictResult.parse({
        conflicts: outcome.remaining.map(versionConflictForIpc),
      });
    },
  );

  // "Try it in a version" (PR 0N-2). The gesture handler double-gates on the
  // engine flag (requireVersionOperations here, and the manager's own
  // operationsFor) so an unflagged workspace rejects before anything runs.
  ipcMain.handle(CHANNELS.tryInWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = TryInWorkspaceVersionPayload.parse(payload);
    await requireVersionOperations(input.workspaceId);
    desktopMarks.mark("try-in-version-start");
    const result = await tryInVersionSessions.start(
      input.workspaceId,
      input.task,
      input.driverId,
    );
    // Gesture latency evidence (create+switch+run-start, excluding any agent
    // process startup on the bare-run path), read via the test-gated marks.
    desktopMarks.measureSince("try-in-version-gesture", "try-in-version-start");
    return TryInWorkspaceVersionResult.parse(result);
  });

  ipcMain.handle(CHANNELS.getTryInVersionState, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return TryInVersionStateResult.parse({
      state: tryInVersionSessions.snapshot(input.workspaceId),
    });
  });

  ipcMain.handle(CHANNELS.dismissTryInVersionReview, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    tryInVersionSessions.dismiss(input.workspaceId);
  });

  // Engine history + linked Chats (PR 0M-5). Flagged workspaces read their
  // timeline from engine moments; every handler resolves the workspace via
  // requireWorkspace and rejects when the engine capture is not attached.
  // The shared id/version/path/timestamp/metadata shape both engine-moment
  // record formats are built from — one mapper so they can never drift.
  // PR 0N-1: the SAME display-name rule the chat rail uses. AgentIntegration
  // stamps onBehalfOf "local" for the desktop's own user, which displays as
  // the cloud email (or "You" when signed out); any other onBehalfOf is
  // already a user-facing label and displays as-is.
  function agentAuthorDisplayName(author: NonNullable<VersionedTextMomentSummary["author"]>): string {
    return author.onBehalfOf === "local" ? localUserDisplayName() : author.onBehalfOf;
  }

  function engineMomentBaseForIpc(
    moment: Pick<
      WorkspaceEngineMomentSummary,
      "id" | "versionId" | "path" | "recordedAtMs" | "operation" | "metadata" | "author"
    >,
  ) {
    return {
      id: moment.id,
      versionId: moment.versionId,
      path: moment.path,
      recordedAtMs: moment.recordedAtMs,
      operation: moment.operation,
      origin: moment.metadata.origin,
      ...(moment.author !== undefined
        ? { agentAuthorName: agentAuthorDisplayName(moment.author) }
        : {}),
      ...(moment.metadata.summary !== undefined
        ? { summary: moment.metadata.summary }
        : {}),
      ...(moment.metadata.correlationId !== undefined
        ? { correlationId: moment.metadata.correlationId }
        : {}),
    };
  }

  function engineMomentForIpc(moment: WorkspaceEngineMomentSummary): EngineMomentRecord {
    return {
      ...engineMomentBaseForIpc(moment),
      momentOrder: moment.momentOrder,
      // Only stamped for PROTECTED (secret-backed) moments so ordinary rows
      // stay byte-identical to the pre-PR-08 shape.
      ...(moment.protected ? { protected: true } : {}),
    };
  }

  function engineMomentDetailForIpc(
    detail: WorkspaceEngineMomentDetail,
  ): EngineMomentDetailRecord {
    if (detail.protected) {
      // Protected moments are metadata-only: no payload exists anywhere, so
      // both text sides are null and the renderer shows "Contents are
      // protected" in place of a diff.
      return {
        ...engineMomentBaseForIpc(detail.moment),
        protected: true,
        beforeText: null,
        afterText: null,
      };
    }
    const moment = detail.moment;
    return {
      ...engineMomentBaseForIpc(moment),
      beforeText: moment.payload.before?.text ?? null,
      // A delete moment stores the removed content as its payload; the diff
      // page renders it as before -> nothing.
      afterText: moment.operation === "delete" ? null : moment.payload.after.text,
    };
  }

  function chatThreadForIpc(thread: ChatThread): ChatThreadRecord {
    return {
      id: thread.id,
      title: thread.title,
      createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs,
    };
  }

  function chatMessageForIpc(message: ChatMessage): ChatMessageRecord {
    return {
      id: message.id,
      threadId: message.threadId,
      authorKind: message.author.kind,
      authorDisplayName: message.author.displayName,
      body: message.body,
      createdAtMs: message.createdAtMs,
    };
  }

  ipcMain.handle(CHANNELS.listEngineMoments, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListEngineMomentsPayload.parse(payload);
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Engine history is not enabled for this workspace.",
    );
    const page = await capture.listMoments({
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.beforeMomentOrder !== undefined
        ? { beforeMomentOrder: input.beforeMomentOrder }
        : {}),
    });
    return ListEngineMomentsResult.parse({
      moments: page.moments.map(engineMomentForIpc),
      nextBeforeMomentOrder: page.nextBeforeMomentOrder,
      latestMomentOrder: page.latestMomentOrder,
      activeVersionId: page.activeVersionId,
    });
  });

  ipcMain.handle(CHANNELS.readEngineMoment, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadEngineMomentPayload.parse(payload);
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Engine history is not enabled for this workspace.",
    );
    const moment = await capture.readMoment(input.momentId);
    return ReadEngineMomentResult.parse({
      moment: moment ? engineMomentDetailForIpc(moment) : null,
    });
  });

  ipcMain.handle(CHANNELS.restoreEngineMomentFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = RestoreEngineMomentFilePayload.parse(payload);
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Engine history is not enabled for this workspace.",
    );
    const result = await capture.restoreFileToBeforeMoment(input.momentId);
    notifyRenderer();
    return RestoreEngineMomentFileResult.parse(result);
  });

  ipcMain.handle(CHANNELS.listFileChats, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListFileChatsPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const fileObjectId = await capture.fileObjectIdForPath(input.path);
    const threads = fileObjectId
      ? await linkedChatStoreFor(workspace).listThreadsForFile({
          workspaceId: workspace.workspaceId,
          objectId: fileObjectId,
        })
      : [];
    return ListFileChatsResult.parse({
      fileObjectId,
      threads: threads.map(chatThreadForIpc),
    });
  });

  ipcMain.handle(CHANNELS.createFileChat, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateFileChatPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    // The chat links to the file's STABLE engine object id (never the path),
    // so the link survives renames; the path rides along as a display hint.
    const fileObjectId = await capture.fileObjectIdForPath(input.path);
    if (!fileObjectId) {
      throw new Error(
        "Chats aren't available for this file yet — only text files dohc tracks can have Chats.",
      );
    }
    const thread = await linkedChatStoreFor(workspace).createThread({
      workspaceId: workspace.workspaceId,
      title: input.title,
      linkedFile: { objectId: fileObjectId, pathHint: input.path },
    });
    return CreateFileChatResult.parse({ thread: chatThreadForIpc(thread) });
  });

  ipcMain.handle(CHANNELS.listChatMessages, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatMessagesPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const messages = await linkedChatStoreFor(workspace).listMessages({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return ListChatMessagesResult.parse({
      messages: messages.map(chatMessageForIpc),
    });
  });

  ipcMain.handle(CHANNELS.sendChatMessage, async (event, payload) => {
    assertTrustedSender(event);
    const input = SendChatMessagePayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    // Author is derived HERE: renderer-sent messages are always the local
    // human user. Agent authorship arrives through agent tooling, never
    // through this channel.
    const message = await linkedChatStoreFor(workspace).sendMessage({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
      author: { kind: "human", displayName: localUserDisplayName() },
      body: input.body,
    });
    return SendChatMessageResult.parse({ message: chatMessageForIpc(message) });
  });

  // --- Chats channels (PR 12/13, WS-E) -------------------------------------
  // Workspace-wide Chats organized in channels, same gate as the file rail.
  // Unread counts and read cursors are store-derived; the renderer never
  // supplies identity or read-state revisions of its own.

  function chatChannelForIpc(channel: ChatChannelSummary) {
    return {
      id: channel.id,
      name: channel.name,
      slug: channel.slug,
      kind: channel.kind,
      createdAtMs: channel.createdAtMs,
      updatedAtMs: channel.updatedAtMs,
      threadCount: channel.threadCount,
      unreadCount: channel.unreadCount,
    };
  }

  function channelThreadForIpc(summary: ChannelThreadSummary) {
    return {
      ...chatThreadForIpc(summary.thread),
      channelId: summary.thread.channelId ?? "",
      messageCount: summary.messageCount,
      lastReadSequence: summary.lastReadSequence,
      unreadCount: summary.unreadCount,
    };
  }

  ipcMain.handle(CHANNELS.listChatChannels, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const store = linkedChatStoreFor(workspace);
    // First chat use auto-creates the workspace's default channel.
    await store.ensureGeneralChannel({ workspaceId: workspace.workspaceId });
    const channels = await store.listChannels({ workspaceId: workspace.workspaceId });
    // The "Files" grouping: file-linked Chats with their CURRENT path (the
    // stable object id resolved through the active version), falling back to
    // the captured hint when the engine no longer owns the file.
    const threads = await store.listThreads({ workspaceId: workspace.workspaceId });
    const fileThreads = threads.filter((thread) => thread.linkedFile);
    let pathByObjectId = new Map<string, string>();
    if (fileThreads.length > 0) {
      try {
        const texts = engineSearchStoreFor(workspace);
        const active = await texts.getActiveVersion({
          workspaceId: workspace.workspaceId,
        });
        if (active) {
          const files = await texts.listTextFiles({
            workspaceId: workspace.workspaceId,
            versionId: active.id,
          });
          pathByObjectId = new Map(files.map((file) => [file.objectId, file.path]));
        }
      } catch {
        // Path resolution is display-only; the hint fallback keeps the
        // listing honest enough.
      }
    }
    return ListChatChannelsResult.parse({
      channels: channels.map(chatChannelForIpc),
      fileThreads: fileThreads.map((thread) => ({
        ...chatThreadForIpc(thread),
        path:
          (thread.linkedFile
            ? pathByObjectId.get(thread.linkedFile.objectId) ??
              thread.linkedFile.pathHint
            : undefined) ?? null,
      })),
    });
  });

  ipcMain.handle(CHANNELS.createChatChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateChatChannelPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const channel = await linkedChatStoreFor(workspace).createChannel({
      workspaceId: workspace.workspaceId,
      name: input.name,
      kind: "channel",
    });
    return CreateChatChannelResult.parse({
      channel: chatChannelForIpc({ ...channel, threadCount: 0, unreadCount: 0 }),
    });
  });

  ipcMain.handle(CHANNELS.listChannelThreads, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChannelThreadsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const threads = await linkedChatStoreFor(workspace).listChannelThreads({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
    });
    return ListChannelThreadsResult.parse({
      threads: threads.map(channelThreadForIpc),
    });
  });

  ipcMain.handle(CHANNELS.startChannelThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartChannelThreadPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    // No title, ever, on this path: the thread displays its first-message
    // snippet. Author is main-derived like every renderer send.
    const started = await linkedChatStoreFor(workspace).startChannelThread({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
      author: { kind: "human", displayName: localUserDisplayName() },
      body: input.body,
    });
    return StartChannelThreadResult.parse({
      thread: channelThreadForIpc({
        thread: started.thread,
        messageCount: 1,
        lastReadSequence: 1,
        unreadCount: 0,
      }),
      message: chatMessageForIpc(started.message),
    });
  });

  ipcMain.handle(CHANNELS.markChatThreadRead, async (event, payload) => {
    assertTrustedSender(event);
    const input = MarkChatThreadReadPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const state = await linkedChatStoreFor(workspace).markThreadRead({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
      upToSequence: input.upToSequence,
    });
    return MarkChatThreadReadResult.parse({
      lastReadSequence: state.lastReadSequence,
      revision: state.revision,
    });
  });

  ipcMain.handle(CHANNELS.listChangeSets, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ListChangeSetsResult.parse({
      changeSets: await activity.listChangeSets(workspace),
    });
  });

  ipcMain.handle(CHANNELS.readChangeSet, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadChangeSetPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ReadChangeSetResult.parse(
      await activity.readChangeSet(workspace, input.changeSetId),
    );
  });

  ipcMain.handle(CHANNELS.restoreHistoryFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = RestoreHistoryFilePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const result = await activity.readChangeSet(workspace, input.changeSetId);
    const changeSet = result.changeSet;
    const file = changeSet?.files.find(
      (entry) => entry.path === input.relativePath,
    );
    if (!changeSet || !file) {
      throw new Error(`Changed file not found in history: ${input.relativePath}`);
    }
    const targetRestoreProvenance =
      changeSet.provenance?.source === "history-restore"
        ? changeSet.provenance
        : null;
    const restoreDirection =
      targetRestoreProvenance?.restoreDirection === "restore"
        ? "undo"
        : "restore";
    const restoreOfPath = targetRestoreProvenance?.restoreOfPath ?? file.path;
    const cancelLocalOperation = activity.beginLocalOperation(workspace.workspaceId, {
      paths: [file.path],
      summary:
        restoreDirection === "undo"
          ? `Undid restore for ${restoreOfPath}`
          : `Restored ${restoreOfPath} from history`,
      provenance: {
        source: "history-restore",
        restoreOfChangeSetId:
          targetRestoreProvenance?.restoreOfChangeSetId ?? input.changeSetId,
        restoreOfPath,
        restoreDirection,
      },
      expectedEvents: [expectedHistoryRestoreEvent(file, restoreDirection)],
    });
    try {
      return RestoreHistoryFileResult.parse(
        await restoreHistoryFileSnapshot({
          rootPath: workspace.rootPath,
          file,
          trashItem: (p) => shell.trashItem(p),
        }),
      );
    } catch (error) {
      cancelLocalOperation();
      throw error;
    }
  });

  ipcMain.handle(CHANNELS.undoHistoryFileRestore, async (event, payload) => {
    assertTrustedSender(event);
    const input = RestoreHistoryFilePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const result = await activity.readChangeSet(workspace, input.changeSetId);
    const file = result.changeSet?.files.find(
      (entry) => entry.path === input.relativePath,
    );
    if (!file) {
      throw new Error(`Changed file not found in history: ${input.relativePath}`);
    }
    const cancelLocalOperation = activity.beginLocalOperation(workspace.workspaceId, {
      paths: [file.path],
      summary: `Undid restore for ${file.path}`,
      provenance: {
        source: "history-restore",
        restoreOfChangeSetId: input.changeSetId,
        restoreOfPath: file.path,
        restoreDirection: "undo",
      },
      expectedEvents: [expectedHistoryRestoreEvent(file, "undo")],
    });
    try {
      return RestoreHistoryFileResult.parse(
        await undoHistoryFileRestoreSnapshot({
          rootPath: workspace.rootPath,
          file,
          trashItem: (p) => shell.trashItem(p),
        }),
      );
    } catch (error) {
      cancelLocalOperation();
      throw error;
    }
  });

  ipcMain.handle(CHANNELS.getSyncStatus, (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return SyncStatusResult.parse(activity.getStatus(input.workspaceId));
  });

  // Enabling agents starts a local run: the workspace must already be OPEN (the
  // watcher must be live for the run slot to attach), so open it first.
  ipcMain.handle(CHANNELS.startAgentRun, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    await activity.open(workspace);
    return StartAgentRunResult.parse(await agentIntegration.startAgentRun(input.workspaceId));
  });

  ipcMain.handle(CHANNELS.endAgentRun, async (event, payload) => {
    assertTrustedSender(event);
    const input = EndAgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    await agentIntegration.endAgentRun(input.workspaceId, input.runId, input.status ?? "complete");
  });

  ipcMain.handle(CHANNELS.getAgentRunStatus, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return AgentRunStatusResult.parse(await agentIntegration.getAgentRunStatus(input.workspaceId));
  });

  // The copyable MCP config snippet for the user's AI tool. Main owns the real
  // command/args so the renderer never invents a launch path.
  ipcMain.handle(CHANNELS.getMcpConfig, (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return McpConfigResult.parse(mcpConfigFor(workspace.rootPath));
  });

  ipcMain.handle(CHANNELS.probeAgentDrivers, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    const sessions = await agentSessionManager();
    await sessions.probeDrivers();
    return AgentPanelSnapshotResult.parse(sessions.panelSnapshot(input.workspaceId));
  });

  ipcMain.handle(CHANNELS.getAgentSessionState, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    const sessions = await agentSessionManager();
    return AgentPanelSnapshotResult.parse(sessions.panelSnapshot(input.workspaceId));
  });

  ipcMain.handle(CHANNELS.startAgentSession, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartAgentSessionPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    await activity.open(workspace);
    await warmCredentialCache();
    const sessions = await agentSessionManager();
    return AgentPanelSnapshotResult.parse(await sessions.startSession(input));
  });

  ipcMain.handle(CHANNELS.stopAgentSession, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    const sessions = await agentSessionManager();
    return AgentPanelSnapshotResult.parse(await sessions.stopSession(input.workspaceId));
  });

  ipcMain.handle(CHANNELS.answerAgentPermission, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentPermissionResponsePayload.parse(payload);
    requireWorkspace(input.workspaceId);
    const sessions = await agentSessionManager();
    return AgentPanelSnapshotResult.parse(await sessions.answerPermission(input));
  });

  ipcMain.handle(CHANNELS.getUserSettings, async (event) => {
    assertTrustedSender(event);
    return DesktopUserSettingsResult.parse(await readUserSettingsFile(stateDir()));
  });

  ipcMain.handle(CHANNELS.setUserSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetUserSettingsPayload.parse(payload);
    await writeUserSettingsFile(stateDir(), input.settings);
    return DesktopUserSettingsResult.parse({
      settings: input.settings,
      source: "stored",
    });
  });

  ipcMain.handle(CHANNELS.resetUserSettings, async (event) => {
    assertTrustedSender(event);
    await writeUserSettingsFile(stateDir(), DEFAULT_USER_SETTINGS);
    return DesktopUserSettingsResult.parse({
      settings: DEFAULT_USER_SETTINGS,
      source: "stored",
    });
  });

  ipcMain.handle(CHANNELS.getWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceSettingsPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return WorkspaceSettingsResult.parse(
      await readWorkspaceSettingsFile(workspace.rootPath),
    );
  });

  ipcMain.handle(CHANNELS.setWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetWorkspaceSettingsPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    await writeWorkspaceSettingsFile(workspace.rootPath, input.settings);
    return WorkspaceSettingsResult.parse({
      settings: input.settings,
      source: "stored",
    });
  });

  ipcMain.handle(CHANNELS.resetWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceSettingsPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    await writeWorkspaceSettingsFile(workspace.rootPath, DEFAULT_WORKSPACE_SETTINGS);
    return WorkspaceSettingsResult.parse({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored",
    });
  });

  ipcMain.handle(CHANNELS.writeClipboardText, async (event, payload) => {
    assertTrustedSender(event);
    const input = WriteClipboardTextPayload.parse(payload);
    clipboard.writeText(input.text);
  });

  // Theme flip → re-tint the OS window-control overlay. setTitleBarOverlay
  // only exists where the overlay does (Windows, newer Linux); macOS and
  // older Linux feature-detect to a no-op — never a crash.
  ipcMain.handle(CHANNELS.setTitlebarTheme, (event, payload) => {
    assertTrustedSender(event);
    const input = SetTitlebarThemePayload.parse(payload);
    // Persist so the NEXT launch paints the native chrome in this theme
    // before any renderer JS runs (no light flash on dark launches).
    rememberChromeTheme(input.theme);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof window.setTitleBarOverlay !== "function") return;
    try {
      window.setTitleBarOverlay(titleBarOverlayOptions(input.theme));
    } catch {
      // Platform without a title bar overlay: nothing to re-tint.
    }
  });

  // Per-workspace workbench UI state (.dohc/ui-state.json). The renderer
  // cannot write .dohc through writeWorkspaceText (reserved path) — this
  // narrow pair is the only writer, same pattern as agent-runs.json. Both
  // directions are zod-bounded; a corrupt/foreign on-disk file reads as null
  // ("no saved state"), never an error.
  ipcMain.handle(CHANNELS.getWorkspaceUiState, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const parsed = GetWorkspaceUiStateResult.safeParse(
      await readUiStateFile(workspace.rootPath),
    );
    return parsed.success ? parsed.data : null;
  });

  ipcMain.handle(CHANNELS.setWorkspaceUiState, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetWorkspaceUiStatePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    await writeUiStateFile(workspace.rootPath, input.state);
  });

  // Content search (Phase E5.0): spawns ripgrep rooted at the REAL workspace
  // root (the registry refuses a root that doesn't realpath to a directory)
  // and streams bounded batches back over the searchResults event channel.
  // Every batch is validated against the contract schema BEFORE it is sent;
  // the dependency-free preload re-validates on arrival. Starting a new
  // search from the same renderer kills its previous rg child by handle.
  ipcMain.handle(CHANNELS.searchWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceSearchPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const sender = event.sender;
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (capture) {
      // Read-your-writes: the batch whose capture triggered this search must
      // already be in the index the query runs against.
      await capture.flush();
      const versions = engineSearchStoreFor(workspace);
      {
        const active = await versions.getActiveVersion({
          workspaceId: workspace.workspaceId,
        });
        const policy = await readWorkspaceEnginePolicy(workspace.rootPath);
        const decision = resolveEngineSearchPolicy(policy);
        if (decision.kind === "blocked") {
          // FAIL CLOSED: a malformed policy file must never widen search
          // (resolveEffectivePolicy would default tracked paths to
          // searchable). Capture stays floor-only per WS-F; search returns
          // nothing until the policy file is fixed.
          console.error(
            `[desktop] workspace search blocked by policy validation for ${workspace.rootPath}: ${decision.message}`,
          );
          if (!sender.isDestroyed()) {
            sender.send(
              CHANNELS.searchResults,
              SearchResultsEventSchema.parse({
                searchId: input.searchId,
                entries: [],
                done: true,
                limitHit: false,
              }),
            );
          }
          return;
        }
        const results = await searchWorkspaceEngine({
          workspaceId: workspace.workspaceId,
          versionId: active?.id ?? "main",
          query: input.query,
          versions,
          chats: linkedChatStoreFor(workspace),
          limit: SEARCH_EVENT_MAX_ENTRIES,
          policy: {
            fileVisibility: decision.fileVisibility,
          },
        });
        if (!sender.isDestroyed()) {
          sender.send(
            CHANNELS.searchResults,
            SearchResultsEventSchema.parse({
              searchId: input.searchId,
              entries: results.map((result) => ({
                path: result.path,
                line: result.line,
                column: result.matchStart + 1,
                preview: result.preview,
                matchStart: result.matchStart,
                matchEnd: result.matchEnd,
                surface: result.surface,
                title: result.title,
                ...(result.threadId ? { threadId: result.threadId } : {}),
                ...(result.objectId ? { objectId: result.objectId } : {}),
              })),
              done: true,
              limitHit: false,
            }),
          );
        }
      }
      return;
    }
    if (!searchCleanupHooked.has(sender)) {
      searchCleanupHooked.add(sender);
      // Window closed / renderer gone: kill this renderer's rg child.
      sender.once("destroyed", () => searchRegistry.disposeOwner(sender.id));
    }
    await searchRegistry.startSearch(
      sender.id,
      workspace.rootPath,
      input.searchId,
      {
        query: input.query,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regex: input.regex,
        includeGlob: input.includeGlob,
        excludeGlob: input.excludeGlob,
      },
      (batch) => {
        if (sender.isDestroyed()) return;
        try {
          sender.send(CHANNELS.searchResults, SearchResultsEventSchema.parse(batch));
        } catch {
          // Defense in depth: a batch that fails the contract is DROPPED,
          // never thrown through the engine's stream handler (an uncaught
          // throw there would wedge the main process). The bounded done
          // batch still arrives and settles the renderer.
        }
      },
    );
  });

  ipcMain.handle(CHANNELS.cancelWorkspaceSearch, (event, payload) => {
    assertTrustedSender(event);
    const input = CancelWorkspaceSearchPayload.parse(payload);
    searchRegistry.cancel(event.sender.id, input.searchId);
  });

  ipcMain.handle(CHANNELS.getUpdateState, (event) => {
    assertTrustedSender(event);
    return currentUpdateState();
  });

  ipcMain.handle(CHANNELS.checkForUpdates, async (event) => {
    assertTrustedSender(event);
    if (!autoUpdateController) {
      return UpdateCheckResult.parse({
        checked: false,
        state: currentUpdateState(),
      });
    }
    return UpdateCheckResult.parse(await autoUpdateController.checkForUpdates());
  });

  ipcMain.handle(CHANNELS.installUpdate, async (event) => {
    assertTrustedSender(event);
    if (!autoUpdateController) {
      return UpdateActionResult.parse({
        accepted: false,
        completed: false,
        state: currentUpdateState(),
      });
    }
    return UpdateActionResult.parse(await autoUpdateController.installUpdate());
  });

  ipcMain.on(CHANNELS.firstPaint, (event) => {
    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
      launchMarks.firstPaint();
      desktopMarks.markOnce("first-renderer-paint");
    }
  });

  // Double-gated: env flag AND unpackaged build. A packaged app launched
  // with the env var set must never grow test surface.
  if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
      assertTrustedSender(event);
      return LaunchMarksResult.parse(launchMarks.snapshot());
    });
    ipcMain.handle(CHANNELS.getDesktopMarks, (event) => {
      assertTrustedSender(event);
      return DesktopMarksResult.parse(desktopMarks.snapshot());
    });
  }
}

// Single-instance lock gates the entire bootstrap, not just a quit() call.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("open-file", (event, path) => {
    event.preventDefault();
    pendingOpenPaths.push(path);
    if (app.isReady()) {
      void flushPendingOpenPaths(targetWindow(undefined));
    }
  });

  app.on("second-instance", (_event, argv) => {
    const window = targetWindow(undefined);
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    void openWorkspacePaths(collectOpenWorkspaceArgs(argv), window);
  });

  app.on("before-quit", () => {
    // Fire-and-forget on quit: skip locks and do not await async stops so
    // termination stays quick; child.unref() and the OS finish process cleanup.
    stopSitePreviewsForQuit();
  });

  void app.whenReady().then(async () => {
    launchMarks.appReady();
    desktopMarks.markOnce("app-ready");
    registerIpcHandlers();

    // Serve workspace file bytes for dohc-file://<workspaceId>/<relpath>.
    protocol.handle(DOHC_FILE_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const workspace = findWorkspace(url.hostname);
        if (!workspace) return new Response("Unknown workspace", { status: 404 });
        const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        const { bytes, mediaType } = await readWorkspaceAsset(
          workspace.rootPath,
          relPath,
        );
        // A Uint8Array VIEW over the Buffer's memory — not a second full copy.
        // (Node Buffers are ArrayBuffer-backed; the cast narrows the generic
        // ArrayBufferLike that TS 5.9 infers from .buffer.)
        const body = new Uint8Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ) as Uint8Array<ArrayBuffer>;
        const allowOrigin = trustedDohcFileCorsOrigin(request);
        const headers = new Headers({
          "content-type": mediaType,
          // Never let served workspace bytes be sniffed into active content.
          "x-content-type-options": "nosniff",
        });
        if (allowOrigin) {
          // The renderer fetch()es text files from this scheme; a custom
          // scheme is a distinct origin, so only allow the trusted renderer.
          headers.set("access-control-allow-origin", allowOrigin);
        }
        return new Response(body, {
          headers,
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });

    const launchWorkspace = await openWorkspacePaths(
      collectOpenWorkspaceArgs(process.argv),
    );
    const pendingWorkspace = await flushPendingOpenPaths();
    const initialActivatedWorkspace = pendingWorkspace ?? launchWorkspace;
    refreshNativeWorkspaceSurfaces();

    const { createMainWindow } = await import("./window/createMainWindow");
    const window = createMainWindow();
    if (initialActivatedWorkspace) {
      window.webContents.once("did-finish-load", () => {
        sendWorkspaceActivated(window, initialActivatedWorkspace);
      });
    }
    launchMarks.firstWindow();
    desktopMarks.markOnce("first-window");

    // Load persisted cloud credentials after the first window exists so local
    // workspaces do not pay credential-store I/O on the visible-launch path.
    void warmCredentialCache().then(() => activity.reconcileCloud(engineForWorkspace));

    // Auto-updates: packaged builds use electron-builder's baked app-update.yml
    // feed by default; DOHC_UPDATE_URL is only an explicit mock/dev override.
    // Failures are absorbed — updates must never take the app down.
    void startAutoUpdates({
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion(),
      onBeforeQuitForUpdate: stopSitePreviewsForQuit,
      onState: (_state, state) => {
        broadcastUpdateState(state);
      },
    })
      .then((controller) => {
        autoUpdateController = controller;
        broadcastUpdateState(autoUpdateController?.publicState() ?? fallbackUpdateState());
      })
      .catch(() => undefined);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
