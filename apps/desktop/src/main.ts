import {
  defaultWorkspaceRoot,
  isSharedWithMePath,
  normalizeAbsolutePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import {
  CHATS_METHOD,
  VersionedLiveAdapter,
  WORKSPACE_METHOD,
  decodeGranularChatMessageSearchResponse,
  decodeUnreadFileThreads,
} from "@dohc/workspace-engine-client";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  ExportDocumentFilePayload,
  ExportDocumentFileResult,
  ShowExplorerMenuPayload,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuPayload,
  ShowWorkbenchMenuResult,
  type ExplorerMenuCommand,
  type WorkbenchMenuCommand,
  DefaultWorkspaceRootResult,
  ApplyDatabaseEditPayload,
  CloudEnableSyncPayload,
  CloudJoinWorkspacePayload,
  CreateRelaySharePayload,
  CreateRelayShareResult,
  ListRelaySharesResult,
  RevokeRelaySharePayload,
  ShareChatChannelPayload,
  ShareChatChannelResult,
  ListChatChannelSharesPayload,
  ListChatChannelSharesResult,
  JoinSharedChannelPayload,
  JoinSharedChannelResult,
  LeaveSharedChannelPayload,
  MountSharePayload,
  MountShareResult,
  OpenSharedViewPayload,
  OpenSharedViewResult,
  RefreshShareMountsPayload,
  RefreshShareMountsResult,
  RefreshSharedViewPayload,
  RefreshSharedViewResult,
  UnmountSharePayload,
  UnmountShareResult,
  CloudJoinWorkspaceResult,
  CloudLoginPollResult,
  CloudLoginStartPayload,
  CloudLoginStartResult,
  CloudStatusPayload,
  CloudStatusResult,
  DismissSyncReviewNoticePayload,
  OpenExternalUrlPayload,
  DatabaseSnapshotResult,
  ImportToDatabasePayload,
  ImportToDatabaseResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  InvokeSiteSdkPayload,
  InvokeSiteSdkResult,
  DesktopMarksResult,
  LaunchMarksResult,
  ListSitesPayload,
  ListSitesResult,
  SitePackagePayload,
  SitePackageResult,
  StartSitePreviewPayload,
  StartSitePreviewResult,
  StopSitePreviewPayload,
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
  ListChatThreadDecisionsPayload,
  ListChatThreadDecisionsResult,
  ResolveChatDecisionPayload,
  ResolveChatDecisionResult,
  ListChatThreadAttachmentsPayload,
  ListChatThreadAttachmentsResult,
  ChatRunRecordsForThreadPayload,
  ChatRunRecordsForThreadResult,
  ListChatChannelsPayload,
  ListChatChannelsResult,
  ListChatFollowsPayload,
  ListChatFollowsResult,
  SetChatFollowPayload,
  SetChatFollowResult,
  ListPersonalChatFeedPayload,
  ListPersonalChatFeedResult,
  MarkPersonalChatFeedSeenPayload,
  CreateChatChannelPayload,
  CreateChatChannelResult,
  ListChannelThreadsPayload,
  ListChannelThreadsResult,
  StartChannelThreadPayload,
  StartChannelThreadResult,
  MarkChatThreadReadPayload,
  MarkChatThreadReadResult,
  ListChatReactionsPayload,
  ListChatReactionsResult,
  SetChatReactionPayload,
  SetChatReactionResult,
  SyncDmsPayload,
  SyncDmsResult,
  StartDmPayload,
  StartDmResult,
  PresencePublishPayload,
  PresencePollPayload,
  PresenceCancelPayload,
  PresenceResult,
  type PresenceScopeInput,
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
  StopAgentRunPayload,
  ResumeThreadDispatchPayload,
  ChatDispatchStateForThreadPayload,
  ChatDispatchStateForThreadResult,
  RunnerSelfTestPayload,
  RunnerSelfTestResult,
  DesktopUserSettingsResult,
  PickWorkspaceRootResult,
  ReadWorkspaceGraphPayload,
  GetBacklinksPayload,
  GetBacklinksResult,
  ListWorkspaceHeadingsPayload,
  ListWorkspaceHeadingsResult,
  ListChatFileMentionsPayload,
  ListChatFileMentionsResult,
  ListChatBookmarksPayload,
  ListChatBookmarksResult,
  SaveChatBookmarkPayload,
  SaveChatBookmarkResult,
  ArchiveChatBookmarkPayload,
  ArchiveChatBookmarkResult,
  type ChatFileReferenceInput,
  ReadWorkspaceDatabasePayload,
  ReadWorkspaceTextPayload,
  ReadWorkspaceTextResult,
  WriteWorkspaceTextPayload,
  WriteWorkspaceAssetPayload,
  MAX_PICKED_IMAGES,
  PickImageFilesPayload,
  PickImageFilesResult,
  WRITE_ASSET_MAX_BYTES,
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
  OpenEngineYDocSessionPayload,
  OpenEngineYDocSessionResult,
  ApplyEngineYDocUpdatePayload,
  CloseEngineYDocSessionPayload,
  EngineYDocRemoteUpdateEventSchema,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
} from "./ipc/bridgeContract";
import { CHANNELS, SEARCH_EVENT_MAX_ENTRIES } from "./ipc/channels";
// The relay presence transport is a dependency-free module (no DOM/React): main
// reuses it so the presence wire contract (routes, publish/leave/poll) lives in
// ONE place. Main is the ONLY holder of the relay bearer token — the renderer's
// presence transport calls the presence IPC handlers below, never the relay.
import {
  createRelayPresenceTransport,
  type PresenceScope as RelayPresenceScope,
} from "./renderer/collab/presenceChannel";
import { createPresencePollRegistry } from "./collab/presencePollRegistry";
import type { EngineYDocProviderSession } from "./collab/ydocEngineProviderSession";
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
import {
  applyDesktopIconToPlatform,
  resolveDesktopIconDirectory,
  resolveSystemThemeIconPath,
  shouldUseDarkSystemIcon,
} from "./systemThemeIcon";
import { buildMenuTemplate } from "./window/applicationMenu";
import { renderHtmlToPdf } from "./window/documentPdfExport";
import {
  allowSitePreviewOrigin,
  navigationPolicy,
  rememberChromeTheme,
  titleBarOverlayOptions,
} from "./window/createMainWindow";
import {
  createWorkspaceFolder,
  resetFailedJoinFolder,
  SHARED_WITH_ME_FOLDER,
  type CreatedWorkspace,
} from "./workspaces/createWorkspaceFolder";
import {
  completeWorkspaceJoinBootstrap,
  effectiveHome,
  findWorkspace,
  listWorkspaces,
  registerWorkspace,
  removeWorkspace,
  setWorkspaceRemote,
  setWorkspaceShareMounts,
  setWorkspaceShareView,
  setWorkspaceSharedChannels,
  stateDir,
} from "./workspaces/WorkspaceRegistry";
import type { JoinedSharedChannel } from "./workspaces/registryStore";
import {
  assertSharedChannelWritable,
  createKeyedSerializer,
  mergeJoinedChannel,
  relayFetchWithTimeout,
  syncJoinedSharedChannels,
} from "./workspaces/sharedChannels";
import {
  dmChannelNameFor,
  grantDmRecipients,
  listDmRecords,
  matchDmChannelByRecipients,
  parseDmRecipients,
  peekReceivedGrantKind,
  requireShareableChatChannel,
  runningThread,
  type DmPeekResult,
  type DmRecordInfo,
  type ShareLogPage,
} from "./workspaces/dmChats";
import { createCloudCredentialStore } from "./workspaces/cloudCredentialStore";
import { claimDmHome, readDmHome } from "./workspaces/dmHomeStore";
import { readOrCreateLocalReactorId } from "./workspaces/localReactorId";
import { createCloudLogin, type CloudLogin } from "./workspaces/cloudLogin";
import { createRelaySyncEngine } from "./workspaces/relaySyncEngine";
import { validateSecretPassphrase } from "./workspaces/secretPassphrase";
import {
  createChatChannelIpcHandler,
  createReadAwareChatIpcHandler,
  createSharedChannelWritableChatIpcHandler,
  createSetChatReactionIpcHandler,
} from "./mainChatIpcHandlers";
import {
  buildShareCode,
  parseShareCode,
  parseSyncCode,
  relayUrlsMatch,
} from "./workspaces/syncCode";
import { refreshSharedViewOnce } from "./workspaces/sharedView";
import {
  assertMountableSelector,
  createMountDirectory,
  mountLabelFor,
  mountStoreWorkspaceIdFor,
  relayTargetForShareMount,
  refreshShareMountOnce,
  removeMountFolder,
} from "./workspaces/shareMounts";
import {
  createVersionedTextStore,
  downloadKeyEnvelope,
  installWorkspaceDataKey,
  readWorkspaceDataKeyForEnrollment,
  readWorkspaceSecretState,
  RelayKeyEnvelopeMissingError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  searchWorkspaceEngine,
  SecretKeyEnvelopeError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  GENERAL_CHANNEL_WIRE_ID,
  fetchShareViewInfo,
  fetchSharedChannelInfo,
  unwrapWorkspaceDataKey,
  uploadKeyEnvelope,
  wrapWorkspaceDataKey,
  type ChannelThreadSummary,
  type ChatChannelSummary,
  type ChatMessage,
  type ChatBookmark,
  type ChatReaction,
  type ChatThread,
  type SyncRelayConnection,
  type VersionedTextMomentSummary,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import {
  engineMomentDetailForIpc,
  engineMomentForIpc,
  versionConflictForIpc,
} from "./ipc/engineHistoryIpc";
import { createWorkspaceActivity } from "./workspaces/workspaceActivity";
import type { WorkspaceEngineCapture } from "./workspaces/workspaceEngineCapture";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
  type EngineDaemonLifecycle,
} from "./workspaces/engineDaemonLifecycle";
import {
  EngineRelayClient,
  probeWorkspaceRelay,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
  type EngineRelayWorkspaceClient,
} from "./workspaces/engineRelayClient";
import { EngineWorkspaceSessions } from "./workspaces/engineWorkspaceSessions";
import {
  createDesktopLinkedChatStore,
  type DesktopLinkedChatStore,
} from "./workspaces/liveLinkedChatStore";
import {
  captureForFlaggedWorkspace,
  configureWorkspaceKernelRuntime,
} from "./workspaces/engineCaptureGate";
import {
  readWorkspaceEnginePolicy,
  resolveEngineSearchPolicy,
} from "./workspaces/workspaceEnginePolicyFile";
import { createAgentIntegration } from "./agents/AgentIntegration";
import type { AgentSessionManager } from "./agents/AgentSessionManager";
import { createTryInVersionSessions } from "./agents/tryInVersion";
import {
  createChatDispatchService,
  type ChatDispatchPresenceInput,
  type ChatDispatchWorkspace,
} from "./agents/chatDispatchService";
import { CHAT_AGENT_PRESENCE_TOPIC } from "./collab/agentPresence";
import {
  createLiveAgentDispatchStore,
  type LiveAgentDispatchStoreHandle,
} from "./agents/liveAgentDispatchStore";
import {
  buildOutputSiteRoot,
  staticPreviewTargetForSite,
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
import { invokeSiteSdkHost } from "./workspaces/siteSdkHost";
import { createSitePreviewSdkAuthorityRegistry } from "./workspaces/sitePreviewSdkAuthority";
import {
  mediaTypeForExtension,
  readWorkspaceAsset,
  readWorkspaceText,
  resolveWorkspaceFile,
  writeWorkspaceAsset,
  writeWorkspaceText,
} from "./workspaces/workspaceAssets";
import {
  applyDatabaseEdit,
  importToDatabase,
  readDatabaseSnapshot,
} from "./workspaces/workspaceDatabase";
import {
  readWorkspaceGraph,
  readWorkspaceBacklinks,
} from "./workspaces/workspaceGraph";
import {
  extractWorkspaceHeadings,
  findWorkspaceHeading,
  workspaceHeadingRecords,
} from "./workspaces/workspaceHeadings";
import {
  listChatChannelsReadOnlySafe,
  listChatFollowsReadOnlySafe,
  markPersonalFeedSeenReadOnlySafe,
} from "./workspaces/chatFollowAccess";
import { addChatMentionsToWorkspaceGraph } from "./workspaces/chatMentionGraphOverlay";
import {
  resolveChatFileMentionPath,
  resolveTrackedChatFilePath,
} from "./workspaces/chatFileReferenceResolution";
import { formatChatBookmarkProjection } from "./workspaces/chatBookmarkProjection";
import { projectChatBookmarksAfterPull } from "./workspaces/chatBookmarkPullProjection";
import {
  archiveChatBookmarkProjection,
  writeChatBookmarkProjection,
} from "./workspaces/chatBookmarkProjectionWrite";
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
  readCachedUserSettingsFile,
  writeUserSettingsFile,
} from "./settings/userSettingsStore";
import { DEFAULT_WORKSPACE_SETTINGS } from "./workspaces/workspaceSettings";
import {
  readWorkspaceSettingsFile,
  writeWorkspaceSettingsFile,
} from "./workspaces/workspaceSettingsFile";
import {
  createSearchRegistry,
  mountScopedIncludeGlob,
} from "./workspaces/workspaceSearch";
import { rgPath } from "@vscode/ripgrep";
import {
  startCliServer,
  type CliRegistryWorkspace,
  type CliRunMessageLink,
  type CliServerHandle,
  type CliWorkspaceContext,
} from "./cli/cliServer";
import { ensureAgentsChatBlock } from "./cli/agentsChatBlock";
import { createWorkspaceChatLifecycle } from "./workspaces/workspaceChatLifecycle";

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

// WS-G2-C-2: only RICH (markdown) files bind to an engine Y.Doc — that is the
// editor surface the Collaboration extension drives. Plain source/CSV/JSON/text
// files keep the local autosave editor, and secret paths never open as a Y.Doc
// (the driver refuses one anyway). The renderer already gates on the same
// classifier; this is the main-side authority.
function isRichEnginePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return ext === "md" || ext === "markdown";
}

// PR 18 read-only shared views: a shared view is a read-only local workspace.
// `sharedViewOf` is the ONE authoritative predicate; every mutation surface
// (file writes, agent runs, code-executing site previews, and the MCP config)
// routes through it so a shared view can never be changed, only read. The
// renderer also hides its edit affordances; this main-process layer is the
// enforcement that cannot be skipped.
function sharedViewOf(workspaceId: string): { granterEmail: string | null } | null {
  return findWorkspace(workspaceId)?.shareView ?? null;
}

function assertWritableWorkspace(workspace: { workspaceId: string }): void {
  const shareView = sharedViewOf(workspace.workspaceId);
  if (shareView) {
    const granter = shareView.granterEmail ?? "the person who shared it";
    throw new Error(`This is a shared view — ask ${granter} for changes.`);
  }
}

// Agents may READ a shared view (the copyable MCP config serves a read-only
// profile), but a MANAGED agent run writes into the workspace, so it is
// refused with honest copy.
function assertAgentRunnableWorkspace(workspaceId: string): void {
  if (sharedViewOf(workspaceId)) {
    throw new Error("Agents can't run in a shared view — it's read-only.");
  }
}

// dev/build/preview site modes execute the folder's own code. A shared view
// holds someone else's code, so only the static (already-materialized)
// preview is allowed; the code-executing modes are refused.
function assertSitePreviewMode(
  workspaceId: string,
  mode: "static" | "dev" | "build",
): void {
  if (mode !== "static" && sharedViewOf(workspaceId)) {
    throw new Error(
      "Live and built site previews run the site's own code, so they're disabled in a shared view. Use the static preview.",
    );
  }
}

type SitePreviewHandle = StaticSitePreview | SiteProcessHandle;

const sitePreviewHandles = new Map<string, SitePreviewHandle>();
const sitePreviewOriginReleases = new Map<string, () => void>();
const sitePreviewSdkAuthorities = createSitePreviewSdkAuthorityRegistry();
const sitePreviewStartLocks = new Map<string, Promise<void>>();
const sitePreviewStartControllersBySender = new Map<
  number,
  Set<AbortController>
>();
let autoUpdateController: AutoUpdateController | null = null;
let applicationMenuCanInstallUpdate: boolean | null = null;

// Latest search per renderer: the engine-backed search path awaits (flush +
// index query) before its mount-scoped rg pass, so an OLDER search can reach
// startSearch after a NEWER one already started — and the registry's
// kill-and-replace would cancel the newer child. Stale handlers check this
// before touching the registry.
const latestSearchIdBySender = new Map<number, string>();
const rendererGenerationBySender = new Map<number, number>();

function rendererGeneration(senderId: number): number {
  return rendererGenerationBySender.get(senderId) ?? 0;
}

function advanceRendererGeneration(senderId: number): void {
  rendererGenerationBySender.set(senderId, rendererGeneration(senderId) + 1);
}

function beginSitePreviewStart(senderId: number): {
  controller: AbortController;
  finish: () => void;
} {
  const controller = new AbortController();
  const controllers =
    sitePreviewStartControllersBySender.get(senderId) ??
    new Set<AbortController>();
  controllers.add(controller);
  sitePreviewStartControllersBySender.set(senderId, controllers);
  return {
    controller,
    finish: () => {
      controllers.delete(controller);
      if (controllers.size === 0) {
        sitePreviewStartControllersBySender.delete(senderId);
      }
    },
  };
}

function abortSitePreviewStartsForSender(senderId: number): void {
  const controllers = sitePreviewStartControllersBySender.get(senderId);
  sitePreviewStartControllersBySender.delete(senderId);
  for (const controller of controllers ?? []) controller.abort();
}

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
  sitePreviewSdkAuthorities.revokePreview(workspaceId, siteRoot);
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
  sitePreviewSdkAuthorities.revokeAll();
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

type SitePreviewStartInput = {
  workspaceId: string;
  workspaceRoot: string;
  site: SitePackageInfo;
  mode: "static" | "dev" | "build";
  isCurrent: () => boolean;
  signal: AbortSignal;
  sdkScopeRoot: string | null;
  sharedView: boolean;
};

async function rememberCurrentSitePreviewHandle(
  key: string,
  handle: SitePreviewHandle,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) {
    await handle.stop().catch(() => undefined);
    throw new Error("Site preview start was cancelled because the renderer restarted.");
  }
  rememberSitePreviewHandle(key, handle);
}

async function startPreviewForSite(
  input: SitePreviewStartInput,
): Promise<StartSitePreviewResult> {
  const key = sitePreviewKey(input.workspaceId, input.site.root);
  return withSitePreviewStartLock(key, async () => startPreviewForSiteUnlocked(input, key));
}

async function startPreviewForSiteUnlocked(
  input: SitePreviewStartInput,
  key: string,
): Promise<StartSitePreviewResult> {
  if (!input.isCurrent()) {
    throw new Error("Site preview start was cancelled because the renderer restarted.");
  }
  try {
    await stopSitePreviewHandle(input.workspaceId, input.site.root);
  } catch (error) {
    console.warn("[desktop] failed to stop previous site preview", error);
  }
  if (!input.isCurrent()) {
    throw new Error("Site preview start was cancelled because the renderer restarted.");
  }

  if (input.mode === "static") {
    const target = staticPreviewTargetForSite(input.site, {
      sharedView: input.sharedView,
    });
    const entry = target.entry ?? undefined;
    if ((input.sharedView || input.site.authority.kind === "share") && !entry) {
      throw new Error(
        "This shared package does not include a built site artifact. Ask the owner to build and share it again.",
      );
    }
    const handle = await startStaticSitePreview(input.workspaceRoot, target.root, {
      entry,
    });
    await rememberCurrentSitePreviewHandle(key, handle, input.isCurrent);
    return {
      siteRoot: input.site.root,
      mode: input.mode,
      url: handle.url,
      logs: [],
      sdkScopeRoot: input.sdkScopeRoot,
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
      signal: input.signal,
    });
    await rememberCurrentSitePreviewHandle(key, handle, input.isCurrent);
    return {
      siteRoot: input.site.root,
      mode: input.mode,
      url: handle.url,
      logs: handle.logs(),
      sdkScopeRoot: input.sdkScopeRoot,
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
      signal: input.signal,
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
  if (!input.isCurrent()) {
    throw new Error("Site preview start was cancelled because the renderer restarted.");
  }
  if (!outputRoot) throw new Error(`Site has no build output to preview: ${input.site.root}`);
  const handle = await startStaticSitePreview(
    input.workspaceRoot,
    buildOutputSiteRoot(input.site, outputRoot),
  );
  await rememberCurrentSitePreviewHandle(key, handle, input.isCurrent);
  return {
    siteRoot: input.site.root,
    mode: input.mode,
    url: handle.url,
    logs,
    sdkScopeRoot: input.sdkScopeRoot,
    ...(build ? { build } : {}),
  };
}

// Native dialogs cannot be driven by Playwright, so every dialog-backed IPC
// gets ONE seam of the same shape: a DOHC_TEST_* env var holding a JSON array
// of absolute paths, honored only in an unpackaged test build. Shared so the
// import and image-picker seams cannot drift apart in their validation.
function testAbsolutePaths(envName: string, maxEntries: number): string[] | null {
  if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return null;
  const raw = process.env[envName];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envName} must be a JSON array of absolute paths`);
  }
  if (!Array.isArray(parsed) || parsed.length > maxEntries) {
    throw new Error(
      `${envName} must be an array with at most ${maxEntries} paths`,
    );
  }
  const paths: string[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 4096 ||
      !isAbsolute(entry)
    ) {
      throw new Error(`${envName} entries must be absolute paths`);
    }
    paths.push(entry);
  }
  return paths;
}

function testImportPaths(): string[] | null {
  return testAbsolutePaths("DOHC_TEST_IMPORT_PATHS", 100);
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
const activeWorkspaceIdBySender = new Map<number, string>();
const activeWorkspaceCleanupHooked = new WeakSet<Electron.WebContents>();

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

// Relay-share HTTP (PR 18): grant-side calls go to the SYNC RELAY (not the
// legacy workspace-api). The token is the same signed-in session bearer and
// only ever goes to the relay this machine signed in with.
function relayShareErrorCopy(
  status: number,
  data: { error?: string; code?: string } | null,
): string {
  switch (data?.code) {
    case "secret_path":
      return "Secret files can't be shared.";
    case "recipient_not_found":
      return "No dohc account matches that email. Ask them to sign in to dohc Cloud once, then share again.";
    case "empty_selector":
      return "Pick a file, folder, or version to share.";
    case "invalid_path":
      return "That path can't be shared.";
    case "not_found":
      return "That share isn't available anymore.";
    default:
      return data?.error ?? `Sharing failed (${status}).`;
  }
}

async function relayShareJson<T>(path: string, init?: RequestInit): Promise<T> {
  await warmCredentialCache();
  if (!cachedCredentials) throw new Error("Sign in to dohc Cloud first.");
  if (!cachedCredentials.relayUrl) {
    throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
  }
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${cachedCredentials.token}`);
  const response = await fetch(
    `${normalizeServerUrl(cachedCredentials.relayUrl)}${path}`,
    { ...init, headers },
  );
  if (response.status === 401) {
    throw new Error("Your dohc Cloud session expired. Sign in again, then retry.");
  }
  const data = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string; code?: string }
    | null;
  if (!response.ok || data?.ok === false) {
    throw new Error(relayShareErrorCopy(response.status, data));
  }
  return data as T;
}

// MU-C4 shared channels: one best-effort refresh pass over every shared
// channel this workspace has JOINED — push the member's local channel ops,
// pull everyone else's. Never throws (transient failures log and retry on
// the next pass); a revoked share is marked ENDED in the registry so it
// stops syncing while the local copy stays readable. Runs from the Chats
// IPC surface (fresh on open, prompt push after a send) and from the
// workspace's relay sync engine cadence.
//
// Concurrency (CodeRabbit Stability): those triggers can fire together for
// the SAME workspace, and overlapping passes would race the per-share
// cursor/peer state in engine.db — so passes are serialized per workspace
// (queued, never dropped). Every relay request inside a pass is also bounded
// by a timeout so a hung relay can't block the awaited listChatChannels path.
const SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS = 15_000;

// Presence (MU-C5) relay bounds. Publish/leave are quick, so a 15s cap frees a
// hung socket. The poll is a long-poll: its own AbortSignal (presenceCancel)
// governs, and this safety cap only fires if the relay stalls past its hold
// (<=30s) so an IPC invoke can never dangle forever.
const PRESENCE_PUBLISH_TIMEOUT_MS = 15_000;
const PRESENCE_POLL_SAFETY_MS = 35_000;
// In-flight presence long-polls, owned by (senderId + pollId) so a poll can only
// be cancelled/superseded by its own window, and bounded so a renderer can't
// open unbounded relay long-polls / controllers / timers.
const presencePollRegistry = createPresencePollRegistry();
// Senders whose presence-poll 'destroyed' cleanup hook is already attached.
const presencePollCleanupHooked = new WeakSet<Electron.WebContents>();
// A stable ownership key so one window holds at most ONE poll per (scope, topic):
// a new poll for the same key supersedes (aborts) the prior long-poll.
function presenceScopeTopicKey(scope: PresenceScopeInput, topic: string): string {
  return JSON.stringify(
    scope.kind === "workspace"
      ? ["w", scope.workspaceId, topic]
      : ["s", scope.shareId, topic],
  );
}
function hookPresencePollCleanup(sender: Electron.WebContents): void {
  if (presencePollCleanupHooked.has(sender)) return;
  presencePollCleanupHooked.add(sender);
  // Window closed / renderer gone: abort every long-poll this window still owns.
  sender.once("destroyed", () => presencePollRegistry.disposeSender(sender.id));
}

async function presenceRelayTransportForScope(
  scope: PresenceScopeInput,
): Promise<ReturnType<typeof createRelayPresenceTransport> | null> {
  await warmCredentialCache();
  if (!cachedCredentials?.relayUrl) return null;
  const baseUrl = normalizeServerUrl(cachedCredentials.relayUrl);
  const token = cachedCredentials.token;
  const fetchImpl = relayFetchWithTimeout(PRESENCE_PUBLISH_TIMEOUT_MS);
  let relayScope: RelayPresenceScope;
  if (scope.kind === "workspace") {
    const entry = findWorkspace(scope.workspaceId);
    const remote = entry?.remote;
    if (!remote || !credentialMatchesRemote(remote.serverUrl)) return null;
    relayScope = {
      kind: "workspace",
      workspaceId: remote.remoteWorkspaceId,
    };
  } else {
    const joined = listWorkspaces().some((entry) =>
      (entry.sharedChannels ?? []).some(
        (channel) =>
          channel.shareId === scope.shareId && channel.ended !== true,
      ),
    );
    if (!joined) return null;
    relayScope = { kind: "share", shareId: scope.shareId };
  }
  return createRelayPresenceTransport({
    baseUrl,
    token,
    scope: relayScope,
    fetch: fetchImpl,
  });
}

const serializeSharedChannelSync = createKeyedSerializer();
let materializePendingChatBookmarksForWorkspace:
  | ((workspaceId: string) => Promise<void>)
  | null = null;

async function projectPendingChatBookmarksAfterPull(workspaceId: string): Promise<void> {
  await projectChatBookmarksAfterPull({
    readOnly: Boolean(sharedViewOf(workspaceId)),
    project: async () => {
      await materializePendingChatBookmarksForWorkspace?.(workspaceId);
    },
    reportError: (error) => {
      console.error(`[desktop] post-pull chat bookmark projection (${workspaceId}):`, error);
    },
  });
}

function syncWorkspaceSharedChannels(workspaceId: string): Promise<void> {
  return serializeSharedChannelSync(workspaceId, () =>
    runSharedChannelSyncPass(workspaceId),
  );
}

async function runSharedChannelSyncPass(workspaceId: string): Promise<void> {
  try {
    const entry = findWorkspace(workspaceId);
    const channels = (entry?.sharedChannels ?? []).filter((channel) => !channel.ended);
    if (!entry || channels.length === 0) return;
    await warmCredentialCache();
    if (!cachedCredentials?.relayUrl) return;
    const relayUrl = cachedCredentials.relayUrl;
    // Origin-relay pin (mirrors the shared-view refresh rule): a share is
    // only ever refreshed against the relay it was joined from — signed into
    // a DIFFERENT relay, skip rather than misread a 404 as "ended".
    const matching = channels.filter((channel) => relayUrlsMatch(channel.relayUrl, relayUrl));
    if (matching.length === 0) return;
    const relay = {
      baseUrl: normalizeServerUrl(relayUrl),
      token: cachedCredentials.token,
      fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
    };
    const daemonRelay = relayClientForWorkspace({
      workspaceId: entry.workspaceId,
      rootPath: entry.rootPath,
      relay,
    });
    const result = await syncJoinedSharedChannels({
      rootDir: entry.rootPath,
      workspaceId: entry.workspaceId,
      relay,
      channels: matching,
      pull: async (input) =>
        await daemonRelay.pullSharedChannel({
          shareId: input.shareId,
          channelWireId: input.channelWireId,
        }),
      push: async (input) =>
        await daemonRelay.pushSharedChannel({
          shareId: input.shareId,
          channelWireId: input.channelWireId,
        }),
    });
    if (result.endedShareIds.length > 0 || result.readOnlyShareIds.length > 0) {
      const ended = new Set(result.endedShareIds);
      // A read-write grant that turned out read-only on push (flipped or
      // recorded stale) downgrades the registry row too: the renderer's
      // composer honesty keys off `joined.access`, and a corrected row stops
      // every future pass from re-attempting the same doomed push.
      const readOnly = new Set(result.readOnlyShareIds);
      setWorkspaceSharedChannels(
        workspaceId,
        (findWorkspace(workspaceId)?.sharedChannels ?? []).map((channel) => {
          if (ended.has(channel.shareId)) return { ...channel, ended: true };
          if (readOnly.has(channel.shareId)) return { ...channel, access: "read-only" as const };
          return channel;
        }),
      );
    }
    if (result.changed || result.endedShareIds.length > 0 || result.readOnlyShareIds.length > 0) {
      notifyRenderer();
    }
    if (result.changed) await projectPendingChatBookmarksAfterPull(workspaceId);
  } catch (error) {
    console.error(`[desktop] shared channel sync failed for ${workspaceId}:`, error);
  }
}

// The copyable MCP launch config for a workspace. The user's AI tool spawns the
// dohc MCP stdio server with these args; --workspace scopes every tool to this
// root (path containment), --home points it at the desktop registry/state dir.
// DOHC_MCP_COMMAND lets a packaged build override the launcher with its shipped
// binary; the default `dohc-mcp` is the @dohc/mcp bin on PATH.
function mcpConfigFor(
  rootPath: string,
  options: { readOnly?: boolean } = {},
): {
  command: string;
  args: string[];
  workspacePath: string;
  home: string;
} {
  const command = process.env.DOHC_MCP_COMMAND?.trim() || "dohc-mcp";
  const home = stateDir();
  const configuredSdkPackageJsonPath = process.env.DOHC_SDK_PACKAGE_JSON?.trim();
  const packagedSdkPackageJsonPath = join(
    process.resourcesPath,
    "sdk-package",
    "package.json",
  );
  const developmentSdkPackageJsonPath = resolve(
    app.getAppPath(),
    "..",
    "..",
    "packages",
    "sdk",
    "package.json",
  );
  const sdkPackageJsonPath =
    configuredSdkPackageJsonPath ||
    (existsSync(packagedSdkPackageJsonPath)
      ? packagedSdkPackageJsonPath
      : existsSync(developmentSdkPackageJsonPath)
        ? developmentSdkPackageJsonPath
        : undefined);
  const sdkDependencyRange = process.env.DOHC_SDK_DEPENDENCY_RANGE?.trim();
  const args = ["--workspace", rootPath, "--home", home];
  // Shared views hand out a READ-ONLY MCP profile: the launched server never
  // registers the mutating tools (PR 18), so an agent can read the shared
  // view but cannot write into it.
  if (options.readOnly) args.push("--read-only");
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
  const workspace = listWorkspaces().find((entry) => entry.rootPath === rootPath);
  // Defense in depth: managed agent runs are already refused on shared views,
  // but if a runtime MCP is ever spawned for one it must be the read-only
  // profile — never the write-capable server.
  const config = mcpConfigFor(rootPath, { readOnly: !!workspace?.shareView });
  const remote = workspace?.remote;
  const env =
    remote && cachedCredentials && credentialMatchesRemote(remote.serverUrl)
      ? {
          DOHC_MCP_CLOUD_SERVER_URL: cachedCredentials.serverUrl,
          DOHC_MCP_CLOUD_EMAIL: cachedCredentials.email,
          DOHC_MCP_OWNER_NAME: localUserDisplayName(),
          DOHC_MCP_CLOUD_TOKEN: cachedCredentials.token,
          // WS-MU-C0: the OPAQUE Better Auth user id, so the agent's chat sends
          // stamp a VERIFIED authorUserId the relay accepts as actor.userId.
          // Present only when the session carries it (older credential files omit
          // it — the agent then sends solo, byte-identical to today).
          ...(cachedCredentials.userId
            ? { DOHC_MCP_CLOUD_USER_ID: cachedCredentials.userId }
            : {}),
        }
      : undefined;
  return {
    command: config.command,
    args: config.args,
    ...(env ? { env } : {}),
  };
}

// Test-only sync timing seams (hermetic E2E: the offline-rejoin spec cannot
// wait out production backoff). Ignored outside DOHC_DESKTOP_TEST like every
// other DOHC_TEST_* seam.
function testSyncTimingOverrides(): {
  debounceMs?: number;
  initialBackoffMs?: number;
} {
  if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return {};
  const debounce = Number(process.env.DOHC_TEST_SYNC_DEBOUNCE_MS);
  const backoff = Number(process.env.DOHC_TEST_SYNC_BACKOFF_MS);
  return {
    ...(Number.isFinite(debounce) && debounce > 0 ? { debounceMs: debounce } : {}),
    ...(Number.isFinite(backoff) && backoff > 0 ? { initialBackoffMs: backoff } : {}),
  };
}

function relayClientForWorkspace(input: {
  workspaceId: string;
  rootPath: string;
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}): EngineRelayWorkspaceClient {
  if (!rustEngineRelayClient) {
    throw new Error("Rust engine relay client is unavailable.");
  }
  return rustEngineRelayClient.bind(input);
}

function engineForWorkspace(
  workspace: { workspaceId: string; rootPath: string },
  capture: WorkspaceEngineCapture | null,
  engineOptions: { joinBootstrap?: boolean } = {},
) {
  const remote = findWorkspace(workspace.workspaceId)?.remote;
  if (!remote || !cachedCredentials) return null;
  if (!capture || !cachedCredentials.relayUrl) return null;
  // Only sync when the session belongs to the server this workspace is bound
  // to; a mismatch keeps it local-only (no token leak, no mass-delete).
  if (!credentialMatchesRemote(remote.serverUrl)) return null;
  const relay = {
    baseUrl: cachedCredentials.relayUrl,
    token: cachedCredentials.token,
  };
  const daemonRelay = relayClientForWorkspace({
    workspaceId: remote.remoteWorkspaceId,
    rootPath: workspace.rootPath,
    relay,
  });
  return createRelaySyncEngine({
    rootDir: workspace.rootPath,
    remoteWorkspaceId: remote.remoteWorkspaceId,
    relay,
    operations: {
      push: () => daemonRelay.push(),
      pull: () => daemonRelay.pull(),
      recoverOrigin: () => daemonRelay.recoverOrigin(),
    },
    capture,
    onChange: () => {
      notifyRenderer();
      void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
        console.error("[desktop] relay dispatch scan:", error);
      });
    },
    // MU-C4: joined shared channels refresh on the same cadence as the
    // workspace's own sync (best-effort; never fails the pass).
    syncSharedChannels: () => syncWorkspaceSharedChannels(workspace.workspaceId),
    // A replicated chat message can mark a live bookmark pending without
    // touching the file watcher. Project immediately after the pull commits;
    // the periodic worker remains only a crash/retry backstop.
    afterSuccessfulPull: () =>
      projectPendingChatBookmarksAfterPull(workspace.workspaceId),
    // Post-pass open-conflict truth: pulled peer resolutions and local
    // resolutions both clear the status-bar/notice conflict state, and the
    // ids lifecycle the pending remote-resolve notice (0P-C gate fix).
    listOpenConflictIds: async () =>
      (await capture.listOpenConflicts()).map((conflict) => conflict.id),
    // A freshly joined workspace's engine is pull-first: no push before the
    // first successful pull (0P-C gate fix).
    ...(engineOptions.joinBootstrap ? { joinBootstrap: true } : {}),
    ...testSyncTimingOverrides(),
  });
}

configureWorkspaceKernelRuntime({
  isPackaged: app.isPackaged,
  resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
});

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
  // Shared views (PR 18) never get capture: they are fed exclusively by the
  // share's filtered pull, and a watcher would re-journal materialized files.
  captureFor: async (workspace, hooks) =>
    findWorkspace(workspace.workspaceId)?.shareView
      ? null
      : captureForFlaggedWorkspace(
          workspace,
          hooks,
          rustEngineWorkspaceSessions,
        ),
});
const panelAgentRunSlots = new Map<string, string>();
// Local agent integration: owns the per-workspace MCP child + active-run slot
// and persists agent-run records. The run slot is wired into the watcher
// (workspaceActivity.setAgentRun) so a run's writes are attributed to the
// agent. The MCP child is spawned only in a packaged/dev runtime where a server
// entry resolves; otherwise the toggle still flips and the user's AI tool
// launches its own copy via the Settings config snippet.
const agentIntegration = createAgentIntegration({
  rootFor: (workspaceId) => findWorkspace(workspaceId)?.rootPath ?? null,
  setAgentRun: async (workspaceId, run) => {
    if (run) {
      const previous = panelAgentRunSlots.get(workspaceId);
      if (previous) await activity.clearAgentRun(workspaceId, previous);
      if (!(await activity.claimAgentRun(workspaceId, run))) {
        throw new Error("Another agent run is already active in this workspace.");
      }
      panelAgentRunSlots.set(workspaceId, run.agentRunId);
      return;
    }
    const ownedRunId = panelAgentRunSlots.get(workspaceId);
    if (ownedRunId) await activity.clearAgentRun(workspaceId, ownedRunId);
    panelAgentRunSlots.delete(workspaceId);
  },
  home: stateDir(),
  // Every terminal run path funnels through endAgentRun (driver
  // turn-completed via AgentSessionManager, a Settings stop, the endAgentRun
  // IPC) — the try-in-version review card listens on that single seam.
  // tryInVersionSessions is initialized just below, before any run can end.
  onRunEnded: ({ workspaceId, runId, status }) => {
    tryInVersionSessions.handleRunEnded(workspaceId, runId, status);
    void chatDispatchService.scanWorkspace(workspaceId).catch((error) => {
      console.error("[desktop] post-panel-run dispatch scan:", error);
    });
  },
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
    await openWorkspaceActivity(workspace);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      throw new Error("Versions are not enabled for this workspace.");
    }
    desktopMarks.measureSince("try-in-version-ops", "try-in-version-ops-start");
    return capture;
  },
  startRun: async (workspaceId, task, driverId) => {
    assertChatRunnerIdle(workspaceId);
    desktopMarks.mark("try-in-version-run-start-begin");
    if (driverId) {
      // The driver session path: the driver does the work and the run id
      // comes from the session (startSession starts the run through
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

// Linked Chats (PR 0M-5): one lazy Rust-backed store per workspace.
const linkedChatStores = new Map<string, DesktopLinkedChatStore>();
function linkedChatStoreFor(workspace: {
  workspaceId: string;
  rootPath: string;
}): DesktopLinkedChatStore {
  const existing = linkedChatStores.get(workspace.workspaceId);
  if (existing) return existing;
  if (!rustEngineWorkspaceSessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  const store = createDesktopLinkedChatStore(workspace, {
    sessions: rustEngineWorkspaceSessions,
  });
  linkedChatStores.set(workspace.workspaceId, store);
  return store;
}

const agentDispatchStoreHandles = new Map<
  string,
  LiveAgentDispatchStoreHandle
>();
const dispatchAgentRunSlots = new Map<string, string>();
function agentDispatchStoreHandleFor(workspace: {
  workspaceId: string;
  rootPath: string;
}): LiveAgentDispatchStoreHandle {
  const existing = agentDispatchStoreHandles.get(workspace.workspaceId);
  if (existing) return existing;
  if (!rustEngineWorkspaceSessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  const handle = createLiveAgentDispatchStore(
    workspace,
    rustEngineWorkspaceSessions,
  );
  agentDispatchStoreHandles.set(workspace.workspaceId, handle);
  return handle;
}

// Engine search (WS-D): per-workspace versioned-text-store connection for the
// indexed search path, the same lazy-singleton idiom as linkedChatStores —
// search-as-you-type must not pay a fresh SQLite open (and its quick_check)
// per keystroke. Closed beside the chat stores at quit.
const engineSearchStores = new Map<string, VersionedTextStore>();
// R16: the LAST remaining consumer of the legacy TypeScript versioned-text
// store in main.ts. It survives only because searchWorkspaceEngine takes the
// store itself; that call swaps to the daemon's search.query RPC in its own
// step, and this helper dies with it. Every other reader below now goes
// through engineSearchIndexFor.
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

// The object-id <-> path index the search surfaces need, read through the
// DAEMON rather than a second sqlite connection.
//
// This used to call createVersionedTextStore(rootPath), which opened another
// node:sqlite connection to the engine.db the daemon owns -- exactly what
// workspaceEngineCapture.ts warns about ("a second createVersionedTextStore on
// the same engine.db would be a second write connection and node:sqlite
// deadlocks"). It also hydrated every file's CONTENT via listTextFiles just to
// read two string fields off each row.
//
// listTextFileMetadata is the right call: it pages (limit 500 + afterPath) so
// a workspace past one page is no longer silently truncated, and it never
// hydrates file bodies.
async function engineSearchIndexFor(workspace: {
  workspaceId: string;
  rootPath: string;
}): Promise<{ versionId: string; files: { objectId: string; path: string }[] } | null> {
  const sessions = rustEngineWorkspaceSessions;
  if (!sessions) return null;
  return await sessions.run(
    { workspaceId: workspace.workspaceId, rootPath: workspace.rootPath },
    async (binding) => {
      const adapter = new VersionedLiveAdapter(binding.client, binding.workspace, {
        workspaceId: workspace.workspaceId,
      });
      const active = await adapter.getActiveVersion({
        workspaceId: workspace.workspaceId,
      });
      if (!active) return null;
      const files = await adapter.listTextFileMetadata({
        workspaceId: workspace.workspaceId,
        versionId: active.id,
      });
      return {
        versionId: active.id,
        files: files.map((file) => ({ objectId: file.objectId, path: file.path })),
      };
    },
  );
}

async function activeEngineFileIndex(workspace: {
  workspaceId: string;
  rootPath: string;
}): Promise<{
  pathByObjectId: Map<string, string>;
  objectIdByPath: Map<string, string>;
}> {
  const index = await engineSearchIndexFor(workspace);
  if (!index) {
    return { pathByObjectId: new Map(), objectIdByPath: new Map() };
  }
  return {
    pathByObjectId: new Map(index.files.map((file) => [file.objectId, file.path])),
    objectIdByPath: new Map(index.files.map((file) => [file.path, file.objectId])),
  };
}

// The human author every renderer-sent chat message is attributed to. Main
// derives it — the renderer never supplies identity. At alpha the desktop's
// preferred local profile name. Email remains an auth/contact identifier and
// is never reused as a public chat display name.
let cachedPreferredName: string | undefined;
function localUserDisplayName(): string {
  return cachedPreferredName ?? "You";
}

// The opaque per-install reactor id used when signed out (no cloud user id). A
// stable uuid persisted in stateDir — NEVER the email — so a signed-out
// reaction cell is stable across restarts without leaking PII into the CRDT.
// Memoized after the first read; the sync fs touch happens at most once.
let cachedLocalReactorId: string | null = null;
function localReactorFallbackId(): string {
  if (cachedLocalReactorId) return cachedLocalReactorId;
  const id = readOrCreateLocalReactorId(join(stateDir(), "dohc-local-id.json"));
  cachedLocalReactorId = id;
  return id;
}

// The local user's STABLE, OPAQUE reactor identity (WS-MU-C2). This value
// becomes a replicated CRDT author key, so it must NEVER be the raw email — a
// raw email would replicate to every peer (PII/GDPR exposure) and persist in
// the immutable CRDT history. Prefer the Better Auth user id (an opaque uuid)
// when signed in; that is forward-compatible with MU-C0, which verifies
// authorId === actor.userId server-side. Signed out (or an older credential
// file with no userId) falls back to a persisted per-install uuid. The
// email→display-name mapping stays LOCAL in localUserDisplayName().
function localUserId(): string {
  return cachedCredentials?.userId ?? localReactorFallbackId();
}

// The VERIFIED relay identity a signed-in send stamps on a chat message
// (WS-MU-C0). Present ONLY when signed in to the relay: the OPAQUE Better Auth
// user id the relay verifies as `actor.userId` before admitting the op. Solo /
// signed-out returns undefined, so message.append omits `authorUserId` and stays
// byte-identical to the pre-MU-C0 shape (unlike reactions, which anchor on a
// stable local fallback id even offline). NEVER the email — identity is opaque;
// the email is display-only via localUserDisplayName().
function relayAuthorUserId(): string | undefined {
  return cachedCredentials?.userId;
}

function workspaceForDispatch(workspaceId: string): ChatDispatchWorkspace | null {
  const workspace = findWorkspace(workspaceId);
  if (!workspace || sharedViewOf(workspaceId)) {
    return null;
  }
  return {
    workspaceId: workspace.workspaceId,
    rootPath: workspace.rootPath,
  };
}

function syncDispatchWorkspaces(): ChatDispatchWorkspace[] {
  if (!cachedCredentials) return [];
  return listWorkspaces()
    .filter(
      (workspace) =>
        workspace.remote !== undefined &&
        credentialMatchesRemote(workspace.remote.serverUrl),
    )
    .map((workspace) => workspaceForDispatch(workspace.workspaceId))
    .filter(
      (workspace): workspace is ChatDispatchWorkspace => workspace !== null,
    );
}

// Tray-only scans use a scoped capture instead of retaining a file watcher.
// Actual runs acquire activity temporarily so their writes are captured and
// attributed. Normal renderer/CLI opens retain activity for the app session.
const dispatchScopedSyncs = new Map<string, Promise<boolean>>();
const retainedWorkspaceActivities = new Set<string>();
const workspaceActivityOpenPromises = new Map<
  string,
  Promise<SyncStatusResult>
>();
const workspaceActivityClosePromises = new Map<string, Promise<void>>();

async function syncWorkspaceForDispatch(workspaceId: string): Promise<boolean> {
  const closing = workspaceActivityClosePromises.get(workspaceId);
  if (closing) await closing.catch(() => undefined);
  if (activity.listOpenWorkspaceIds().includes(workspaceId)) {
    activity.queueCloudSync(workspaceId);
    return activity.engineCaptureFor(workspaceId) !== null;
  }
  const existing = dispatchScopedSyncs.get(workspaceId);
  if (existing) return existing;
  const workspace = findWorkspace(workspaceId);
  if (!workspace || sharedViewOf(workspaceId)) return false;
  const scoped = (async () => {
    const capture = await captureForFlaggedWorkspace(
      workspace,
      {
        activeAgentRun: () => null,
        onCaptureOutcome: () => undefined,
      },
      rustEngineWorkspaceSessions,
    );
    if (!capture) return false;
    try {
      // A normal open may have started while the scoped capture was built.
      // Yield ownership rather than opening a second relay sync engine.
      if (activity.listOpenWorkspaceIds().includes(workspaceId)) {
        activity.queueCloudSync(workspaceId);
        return activity.engineCaptureFor(workspaceId) !== null;
      }
      const engine = engineForWorkspace(workspace, capture);
      if (!engine) return false;
      try {
        await engine.start();
        return true;
      } finally {
        await engine.stop().catch(() => undefined);
        const relayWorkspaceId = workspace.remote?.remoteWorkspaceId;
        if (relayWorkspaceId) {
          await closeRelayTransportWorkspace(relayWorkspaceId).catch(
            () => undefined,
          );
        }
      }
    } finally {
      await capture.stop().catch(() => undefined);
    }
  })();
  dispatchScopedSyncs.set(workspaceId, scoped);
  try {
    return await scoped;
  } finally {
    if (dispatchScopedSyncs.get(workspaceId) === scoped) {
      dispatchScopedSyncs.delete(workspaceId);
    }
  }
}

async function ensureWorkspaceActivityOpen(
  workspace: CreatedWorkspace,
): Promise<SyncStatusResult> {
  for (;;) {
    const scoped = dispatchScopedSyncs.get(workspace.workspaceId);
    if (scoped) {
      await scoped.catch(() => undefined);
      continue;
    }
    const closing = workspaceActivityClosePromises.get(workspace.workspaceId);
    if (closing) {
      await closing.catch(() => undefined);
      continue;
    }
    const existing = workspaceActivityOpenPromises.get(workspace.workspaceId);
    if (existing) return existing;
    // activity.open registers the workspace synchronously before its first
    // await. With no yield after the checks above, a scoped scan can only
    // start before us (and be observed on the next loop) or after us (and
    // yield to the registered activity owner).
    const opening = activity.open(workspace);
    workspaceActivityOpenPromises.set(workspace.workspaceId, opening);
    try {
      return await opening;
    } finally {
      if (workspaceActivityOpenPromises.get(workspace.workspaceId) === opening) {
        workspaceActivityOpenPromises.delete(workspace.workspaceId);
      }
    }
  }
}

async function closeDispatchRunActivity(workspaceId: string): Promise<void> {
  const existing = workspaceActivityClosePromises.get(workspaceId);
  if (existing) return existing;
  const relayWorkspaceId =
    findWorkspace(workspaceId)?.remote?.remoteWorkspaceId;
  const closing = activity.close(workspaceId);
  workspaceActivityClosePromises.set(workspaceId, closing);
  try {
    await closing;
    if (relayWorkspaceId) {
      await closeRelayTransportWorkspace(relayWorkspaceId);
    }
  } finally {
    if (workspaceActivityClosePromises.get(workspaceId) === closing) {
      workspaceActivityClosePromises.delete(workspaceId);
    }
  }
}

async function acquireDispatchRunActivity(
  workspace: CreatedWorkspace,
): Promise<() => Promise<void>> {
  const alreadyOpen = activity
    .listOpenWorkspaceIds()
    .includes(workspace.workspaceId);
  await workspaceChatLifecycle.open(
    workspace,
    () => ensureWorkspaceActivityOpen(workspace),
  );
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (alreadyOpen || retainedWorkspaceActivities.has(workspace.workspaceId)) {
      return;
    }
    await closeDispatchRunActivity(workspace.workspaceId);
  };
}

function openDispatchWorkspaces(): ChatDispatchWorkspace[] {
  return activity
    .listOpenWorkspaceIds()
    .filter((workspaceId) => activity.engineCaptureFor(workspaceId) !== null)
    .map(workspaceForDispatch)
    .filter((workspace): workspace is ChatDispatchWorkspace => workspace !== null);
}

async function publishAgentPresence(
  input: ChatDispatchPresenceInput,
): Promise<void> {
  const transport = await presenceRelayTransportForScope({
    kind: "workspace",
    workspaceId: input.workspaceId,
  });
  if (!transport) return;
  const topics = [
    `chat:thread:${input.threadId}`,
    CHAT_AGENT_PRESENCE_TOPIC,
  ];
  if (input.leave) {
    await Promise.all(
      topics.map((topic) => transport.leave({ topic, clientId: input.clientId })),
    );
    return;
  }
  await Promise.all(
    topics.map((topic) =>
      transport.publish({
        topic,
        clientId: input.clientId,
        state: input.state ?? null,
      }),
    ),
  );
}

const pendingCliRunMessageLinks = new Set<string>();

function cliRunMessageLinkKey(link: CliRunMessageLink): string {
  return `${link.workspaceId}\u0000${link.runId}\u0000${link.messageId}`;
}

function hasPendingCliRunMessageLink(
  workspaceId: string,
  runId: string,
): boolean {
  const prefix = `${workspaceId}\u0000${runId}\u0000`;
  return [...pendingCliRunMessageLinks].some((key) => key.startsWith(prefix));
}

const chatDispatchService = createChatDispatchService({
  workspaceFor: workspaceForDispatch,
  listOpenWorkspaces: openDispatchWorkspaces,
  listSyncWorkspaces: syncDispatchWorkspaces,
  chatStoreFor: linkedChatStoreFor,
  dispatchStoreFor: (workspace) =>
    agentDispatchStoreHandleFor(workspace).store,
  readRunnerSettings: async () =>
    (await readCachedUserSettingsFile(stateDir())).settings.runner,
  identityFor: async (workspaceId) => {
    await warmCredentialCache();
    const remote = findWorkspace(workspaceId)?.remote;
    const verifiedUserId =
      remote && credentialMatchesRemote(remote.serverUrl)
        ? relayAuthorUserId()
        : undefined;
    return {
      displayName: localUserDisplayName(),
      ...(verifiedUserId ? { verifiedUserId } : {}),
    };
  },
  stateDir,
  appRoot: () => app.getAppPath(),
  isPackaged: () => app.isPackaged,
  resourcesPath: () =>
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  queueSync: syncWorkspaceForDispatch,
  prepareRunWorkspace: async (workspace) => {
    const registered = findWorkspace(workspace.workspaceId);
    if (!registered) {
      throw new Error(`Unknown workspace: ${workspace.workspaceId}`);
    }
    const release = await acquireDispatchRunActivity(registered);
    if (!activity.engineCaptureFor(workspace.workspaceId)) {
      await release();
      throw new Error("Chats are not enabled for this workspace.");
    }
    return release;
  },
  authorizeServiceNote: async (workspace, threadId) => {
    try {
      await assertSharedChannelWritable({
        workspaceId: workspace.workspaceId,
        sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
        store: linkedChatStoreFor(workspace),
        target: { threadId },
      });
      return true;
    } catch (error) {
      if (!(error instanceof SharedChannelReadOnlyError)) throw error;
      return false;
    }
  },
  onMessagePosted: (workspaceId) => {
    notifyRenderer();
    activity.queueCloudSync(workspaceId);
    void syncWorkspaceSharedChannels(workspaceId);
    void chatDispatchService.scanWorkspace(workspaceId).catch((error) => {
      console.error("[desktop] chat dispatch scan:", error);
    });
  },
  onRunUpdated: () => notifyRenderer(),
  setRunAttribution: async (workspaceId, run) => {
    if (run) {
      if (!(await activity.claimAgentRun(workspaceId, run))) {
        throw new Error("Another agent run is already active in this workspace.");
      }
      dispatchAgentRunSlots.set(workspaceId, run.agentRunId);
      return;
    }
    const ownedRunId = dispatchAgentRunSlots.get(workspaceId);
    if (ownedRunId) await activity.clearAgentRun(workspaceId, ownedRunId);
    dispatchAgentRunSlots.delete(workspaceId);
  },
  runSlotOccupied: (workspaceId) => activity.hasAgentRun(workspaceId),
  hasPendingRunMessageLink: hasPendingCliRunMessageLink,
  publishPresence: publishAgentPresence,
  requeueFailedTrigger: (input) => {
    const workspace = workspaceForDispatch(input.workspaceId);
    return workspace
      ? agentDispatchStoreHandleFor(workspace).requeueFailedTrigger(input)
      : false;
  },
  listAppQuitRecoveries: (workspaceId) => {
    const workspace = workspaceForDispatch(workspaceId);
    return workspace
      ? agentDispatchStoreHandleFor(workspace).listAppQuitRecoveries(
          workspaceId,
        )
      : [];
  },
  onError: (error) => {
    console.error("[desktop] chat dispatch:", error);
  },
});

function assertChatRunnerIdle(workspaceId: string): void {
  if (chatDispatchService.hasLiveRun(workspaceId)) {
    throw new Error("Your chat runner is already working in this workspace.");
  }
}

const workspaceChatLifecycle = createWorkspaceChatLifecycle({
  isReadOnly: (workspaceId) => Boolean(sharedViewOf(workspaceId)),
  isReadyForMaintenance: (workspaceId) =>
    findWorkspace(workspaceId)?.joinBootstrapPending !== true,
  maintain: async (rootPath) => {
    await ensureAgentsChatBlock(rootPath);
  },
  onError: (error) => {
    console.error("[desktop] AGENTS.md chat description:", error);
  },
});

async function openWorkspaceActivity(
  workspace: CreatedWorkspace,
  afterActivityOpen?: () => Promise<void>,
): Promise<SyncStatusResult> {
  retainedWorkspaceActivities.add(workspace.workspaceId);
  const result = await workspaceChatLifecycle.open(
    workspace,
    () => ensureWorkspaceActivityOpen(workspace),
    afterActivityOpen,
  );
  void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
    console.error("[desktop] chat dispatch workspace-open scan:", error);
  });
  return result;
}

// Agent-facing `dohc chat`: the socket authenticates locally, then MAIN
// resolves the registry workspace and derives identity exactly like renderer
// chat sends. The client can claim only the behavior-bearing human/agent kind;
// it never supplies the user id or display identity.
let cliServer: CliServerHandle | null = null;
let cliServerStartup: Promise<CliServerHandle | null> | null = null;

async function openCliWorkspace(
  requested: CliRegistryWorkspace,
): Promise<CliWorkspaceContext> {
  const workspace = findWorkspace(requested.workspaceId);
  if (!workspace || resolve(workspace.rootPath) !== resolve(requested.rootPath)) {
    throw new Error("dohc: not inside a dohc workspace");
  }
  await openWorkspaceActivity(workspace);
  const capture = activity.engineCaptureFor(workspace.workspaceId);
  if (!capture) throw new Error("Chats are not enabled for this workspace.");
  const store = linkedChatStoreFor(workspace);
  const daemon = rustEngineDaemon;
  return {
    workspaceId: workspace.workspaceId,
    rootPath: workspace.rootPath,
    store,
    dispatchStore: agentDispatchStoreHandleFor(workspace).store,
    readOnly: Boolean(sharedViewOf(workspace.workspaceId)),
    fileObjectIdForPath: (path) => capture.fileObjectIdForPath(path),
    ...(daemon
      ? {
          daemonReads: {
            async queryChatMessagesGranular(input: {
              query: string;
              limit: number;
            }) {
              return decodeGranularChatMessageSearchResponse(
                await daemon.requestWorkspace(
                  workspace.rootPath,
                  workspace.workspaceId,
                  WORKSPACE_METHOD.searchQueryChatMessagesGranular,
                  input,
                ),
              );
            },
            async listUnreadFileThreads(input: {
              pageLimit: number;
              afterThreadId?: string;
            }) {
              return decodeUnreadFileThreads(
                await daemon.requestWorkspace(
                  workspace.rootPath,
                  workspace.workspaceId,
                  CHATS_METHOD.readStateListUnreadFileThreads,
                  input,
                ),
              );
            },
          },
        }
      : {}),
    filePathForObjectId: (objectId) => capture.filePathForObjectId(objectId),
    listMoments: async ({ limit }) => {
      const page = await capture.listMoments({ limit });
      return page.moments
        .filter(
          (moment): moment is typeof moment & { objectId: string; protected: false } =>
            !moment.protected && Boolean(moment.objectId),
        )
        .map((moment) => ({
          id: moment.id,
          workspaceId: workspace.workspaceId,
          versionId: moment.versionId,
          objectId: moment.objectId,
          path: moment.path,
          recordedAtMs: moment.recordedAtMs,
          operation: moment.operation,
          ...(moment.contentKind ? { contentKind: moment.contentKind } : {}),
          ...(moment.byteLength !== undefined
            ? { byteLength: moment.byteLength }
            : {}),
          metadata: moment.metadata,
          ...(moment.author ? { author: moment.author } : {}),
          momentOrder: moment.momentOrder,
        }));
    },
    readMoment: async (momentId) => {
      const detail = await capture.readMoment(momentId);
      return detail && !detail.protected ? detail.moment : null;
    },
    assertWritable: async (target) => {
      assertWritableWorkspace(workspace);
      await assertSharedChannelWritable({
        workspaceId: workspace.workspaceId,
        sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
        store,
        target,
      });
    },
  };
}

async function startDesktopCliServer(): Promise<CliServerHandle> {
  await workspaceChatLifecycle.boot(listWorkspaces()).catch((error: unknown) => {
    console.error("[desktop] AGENTS.md boot maintenance:", error);
  });
  const server = await startCliServer({
    stateDir: stateDir(),
    listWorkspaces: () =>
      listWorkspaces()
        .map(({ workspaceId, rootPath }) => ({
          workspaceId,
          rootPath,
          readOnly: Boolean(sharedViewOf(workspaceId)),
        })),
    openWorkspace: openCliWorkspace,
    identity: async () => {
      await warmCredentialCache();
      const authorUserId = relayAuthorUserId();
      return {
        displayName: localUserDisplayName(),
        ...(authorUserId ? { authorUserId } : {}),
        reactionAuthorId: localUserId(),
      };
    },
    onWrite: (workspace) => {
      notifyRenderer();
      activity.queueCloudSync(workspace.workspaceId);
      void syncWorkspaceSharedChannels(workspace.workspaceId);
      void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
        console.error("[desktop] CLI dispatch scan:", error);
      });
    },
    onRunMessageLinkPending: (link) => {
      pendingCliRunMessageLinks.add(cliRunMessageLinkKey(link));
    },
    onRunMessageLinkSettled: (link) => {
      pendingCliRunMessageLinks.delete(cliRunMessageLinkKey(link));
      void chatDispatchService.scanWorkspace(link.workspaceId).catch((error) => {
        console.error("[desktop] CLI provenance recovery scan:", error);
      });
    },
    onRunMessageLinkAbandoned: (link) => {
      pendingCliRunMessageLinks.delete(cliRunMessageLinkKey(link));
    },
    onError: (error) => {
      console.error("[desktop] CLI server:", error);
    },
  });
  return {
    socketPath: server.socketPath,
    tokenPath: server.tokenPath,
    ready: server.ready,
    async close() {
      await server.close();
    },
  };
}

// Content search (Phase E5.0): at most one live ripgrep child per renderer,
// tracked by handle. A new search, an explicit cancel, the renderer's
// webContents going away, and app quit each kill the SPECIFIC tracked child.
const searchRegistry = createSearchRegistry({ rgPath });
// Senders whose 'destroyed' cleanup hook is already attached.
const searchCleanupHooked = new WeakSet<Electron.WebContents>();

// WS-G2-C-2 engine Y.Doc editor binding: the live node-only sessions main owns
// on the renderer's behalf, keyed by the renderer-minted sessionId. Each holds
// the single-canonical reservation for its object; closing it (renderer close,
// window gone, app quit) releases the reservation so the object can reopen.
interface EngineYDocSessionEntry {
  session: EngineYDocProviderSession;
  senderId: number;
  workspaceId: string;
}
const engineYDocSessions = new Map<string, EngineYDocSessionEntry>();
const pendingEngineYDocOpensBySender = new Map<number, Set<Promise<void>>>();
// Senders whose engine-ydoc 'destroyed' cleanup hook is already attached.
const engineYDocCleanupHooked = new WeakSet<Electron.WebContents>();

function beginPendingEngineYDocOpen(senderId: number): () => void {
  let finish: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pendingForSender =
    pendingEngineYDocOpensBySender.get(senderId) ?? new Set<Promise<void>>();
  pendingForSender.add(pending);
  pendingEngineYDocOpensBySender.set(senderId, pendingForSender);
  return () => {
    pendingForSender.delete(pending);
    if (pendingForSender.size === 0) pendingEngineYDocOpensBySender.delete(senderId);
    finish();
  };
}

async function waitForPendingEngineYDocOpens(senderId: number): Promise<void> {
  await Promise.all([...(pendingEngineYDocOpensBySender.get(senderId) ?? [])]);
}

// Close and drop every engine Y.Doc session owned by one renderer (window gone
// / crashed). Settles the converged state and releases each reservation.
async function closeEngineYDocSessionsForSender(senderId: number): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const [sessionId, entry] of [...engineYDocSessions]) {
    if (entry.senderId !== senderId) continue;
    engineYDocSessions.delete(sessionId);
    closing.push(entry.session.close().catch(() => undefined));
  }
  await Promise.all(closing);
}

async function prepareForRendererReload(senderId: number): Promise<void> {
  // `openWorkspace` records the active workspace before awaiting watcher
  // startup. Re-prioritize that sender's workspace so its replacement renderer
  // boots back into the same place, while closing every main-owned resource
  // the crashed renderer cannot clean up itself.
  const activeWorkspaceId =
    activeWorkspaceIdBySender.get(senderId) ?? preferredWorkspaceId;
  if (activeWorkspaceId) preferredWorkspaceId = activeWorkspaceId;
  advanceRendererGeneration(senderId);
  abortSitePreviewStartsForSender(senderId);
  sitePreviewSdkAuthorities.revokeSender(senderId);
  searchRegistry.disposeOwner(senderId);
  latestSearchIdBySender.delete(senderId);
  await Promise.all([
    closeEngineYDocSessionsForSender(senderId),
    waitForPendingEngineYDocOpens(senderId),
    activeWorkspaceId
      ? stopSitePreviewsForWorkspace(activeWorkspaceId)
      : Promise.resolve(),
  ]);
}

// Close every live engine Y.Doc session (app quit) BEFORE the engine stores are
// stopped, so no session settles onto a closed store.
async function closeAllEngineYDocSessions(): Promise<void> {
  const entries = [...engineYDocSessions.values()];
  engineYDocSessions.clear();
  await Promise.all(entries.map((entry) => entry.session.close().catch(() => undefined)));
}

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

let dispatchTray: Tray | null = null;

function configuredRunnerEnabled(settings: DesktopUserSettingsResult["settings"]): boolean {
  return settings.runner.enabled && settings.runner.command.trim().length > 0;
}

function desktopIconDirectory(): string {
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  return resolveDesktopIconDirectory({
    isPackaged: app.isPackaged,
    resourcesPath,
    moduleDirectory: import.meta.dirname,
  });
}

function currentDesktopIconPath(): string | null {
  return resolveSystemThemeIconPath(
    desktopIconDirectory(),
    shouldUseDarkSystemIcon(nativeTheme),
  );
}

function dispatchTrayIcon() {
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  const themedPath = currentDesktopIconPath();
  const packagedFallback = resourcesPath
    ? join(resourcesPath, "tray-icon.png")
    : "";
  let icon = nativeImage.createFromPath(themedPath ?? packagedFallback);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(join(app.getAppPath(), "build/icon.png"));
  }
  if (process.platform === "darwin") icon.setTemplateImage(true);
  return icon;
}

async function showOrCreateMainWindow(): Promise<void> {
  const existing = targetWindow(undefined);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const { createMainWindow } = await import("./window/createMainWindow");
  const window = createMainWindow({ beforeRendererReload: prepareForRendererReload });
  window.show();
  window.focus();
}

function rebuildDispatchTrayMenu(): void {
  if (!dispatchTray) return;
  dispatchTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open dohc",
        click: () => {
          void showOrCreateMainWindow();
        },
      },
      {
        label: "Pause agent dispatch",
        type: "checkbox",
        checked: chatDispatchService.isPaused(),
        click: (item) => {
          chatDispatchService.setPaused(item.checked);
          rebuildDispatchTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: "Quit dohc",
        click: () => app.quit(),
      },
    ]),
  );
}

function ensureDispatchTray(): void {
  if (!dispatchTray) {
    dispatchTray = new Tray(dispatchTrayIcon());
    dispatchTray.setToolTip("dohc agent dispatch");
    dispatchTray.on("double-click", () => {
      void showOrCreateMainWindow();
    });
  }
  rebuildDispatchTrayMenu();
}

function refreshSystemThemeDesktopIcons(): void {
  const iconPath = currentDesktopIconPath();
  if (iconPath) {
    applyDesktopIconToPlatform({
      platform: process.platform,
      iconPath,
      windows: BrowserWindow.getAllWindows(),
      setDockIcon: (path) => app.dock?.setIcon(path),
    });
  }
  if (dispatchTray) dispatchTray.setImage(dispatchTrayIcon());
}

async function refreshDispatchTray(): Promise<boolean> {
  const { settings } = await readCachedUserSettingsFile(stateDir());
  const enabled = configuredRunnerEnabled(settings);
  if (enabled && !quitting) {
    ensureDispatchTray();
  } else if (dispatchTray) {
    dispatchTray.destroy();
    dispatchTray = null;
  }
  return enabled;
}

// Quit must wait for the final settle-window flush AND its history record to
// be durably written — otherwise a save right before quit is silently lost.
// Bounded so a wedged disk can't make the app unquittable.
let quitting = false;
let rustEngineDaemon: EngineDaemonLifecycle | null = null;
let rustEngineWorkspaceSessions: EngineWorkspaceSessions | null = null;
let rustEngineRelayClient: EngineRelayClient | null = null;
const relayTransportRoutes = new RelayTransportRouteGuard();

async function closeRelayTransportWorkspace(workspaceId: string): Promise<void> {
  if (rustEngineRelayClient) {
    await rustEngineRelayClient.closeWorkspace(workspaceId);
    return;
  }
  await rustEngineWorkspaceSessions?.closeWorkspace(workspaceId);
  relayTransportRoutes.releaseWorkspace(workspaceId);
}

async function closeAllRelayTransportWorkspaces(): Promise<void> {
  if (rustEngineRelayClient) {
    await rustEngineRelayClient.closeAll();
    return;
  }
  await rustEngineWorkspaceSessions?.closeAll();
  for (const workspaceId of relayTransportRoutes.workspaceIds()) {
    relayTransportRoutes.releaseWorkspace(workspaceId);
  }
}

app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  searchRegistry.killAll();
  const agentSessionStop = cachedAgentSessions?.stopAll() ?? Promise.resolve();
  const chatDispatchStop = chatDispatchService.stop().catch(() => undefined);
  const cliServerStop = chatDispatchStop.then(() =>
    (cliServerStartup ?? Promise.resolve(cliServer))
    .then((server) => server?.close())
    .catch(() => undefined),
  );
  const agentIntegrationStop = agentIntegration.stopAll().catch(() => undefined);
  // Linked chat stores are lazy singletons with SQLite handles on the shared
  // engine.db; close them at quit so WAL locks never outlive the app.
  const chatStoreStop = chatDispatchStop.then(() =>
    Promise.all(
      [...linkedChatStores.values()].map((store) => store.close().catch(() => undefined)),
    ));
  const dispatchStoreStop = chatDispatchStop.then(async () => {
    await Promise.allSettled(
      [...agentDispatchStoreHandles.values()].map(
        async (handle) => await handle.close(),
      ),
    );
    agentDispatchStoreHandles.clear();
  });
  // Engine search stores hold the same kind of lazy SQLite handle; close them
  // with the chat stores so WAL locks never outlive the app.
  const searchStoreStop = Promise.all(
    [...engineSearchStores.values()].map((store) => store.close().catch(() => undefined)),
  );
  // Close live engine Y.Doc sessions (settle + release reservations) before the
  // engine stores stop — a session must never settle onto a closed store.
  const engineYDocStop = closeAllEngineYDocSessions();
  const captureStop = engineYDocStop
      .then(() => chatDispatchStop)
      .then(() => agentIntegrationStop)
      .then(() => activity.stopAll());
  const rustEngineStop = Promise.all([
    captureStop.catch(() => undefined),
    chatStoreStop,
    dispatchStoreStop,
  ])
    .then(async () => await closeAllRelayTransportWorkspaces())
    .catch(() => undefined)
    .then(async () => await rustEngineDaemon?.stop());
  void Promise.race([
    Promise.all([
      agentSessionStop,
      cliServerStop,
      chatDispatchStop,
      agentIntegrationStop,
      captureStop,
      chatStoreStop,
      dispatchStoreStop,
      searchStoreStop,
      rustEngineStop,
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

// Injectable clock/id seams (oracle/tests) for renderer-initiated database
// edits, whose nowMs becomes appliedAt (and createId the operationId) in the
// persisted JSONL operation log. Omitted ⇒ the real wall clock / randomUUID,
// identical to today's behavior.
function registerIpcHandlers(
  deps: { now?: () => number; createId?: () => string } = {},
): void {
  const now = deps.now ?? (() => Date.now());
  ipcMain.handle(CHANNELS.reloadRenderer, async (event) => {
    assertTrustedSender(event);
    const sender = event.sender;
    await prepareForRendererReload(sender.id);
    if (!sender.isDestroyed()) sender.reload();
  });

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
    assertWritableWorkspace(workspace);
    const path = await createFile(workspace.rootPath, input.relativePath);
    return CreateWorkspaceFileResult.parse({ path });
  });

  ipcMain.handle(CHANNELS.createWorkspaceFolder, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceFolderPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
    const path = await createFolder(workspace.rootPath, input.relativePath);
    return CreateWorkspaceFileResult.parse({ path });
  });

  ipcMain.handle(CHANNELS.moveWorkspacePath, async (event, payload) => {
    assertTrustedSender(event);
    const input = MoveWorkspacePathPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
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
    assertWritableWorkspace(workspace);
    // WS-G2-C-2 (gate fix 3): a live Y.Doc session over the path being removed
    // would, on a later settle, resurrect the file / orphan the object. Flush +
    // release it (and any session under a deleted folder) BEFORE the disk delete
    // so no stale settle can write the old path afterward.
    await activity
      .engineCaptureFor(workspace.workspaceId)
      ?.settleAndCloseLiveSessionsForPath(input.relativePath);
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

  // "Copy as Markdown" / "Export as HTML" / "Export as PDF" (ViewHeader's
  // document menu). The renderer always sends the same self-contained HTML
  // (documentExport.ts); this handler only decides where the bytes land
  // (.html verbatim, .pdf via the hidden offscreen window) — see
  // documentPdfExport.ts for the "only one export in flight" guard.
  ipcMain.handle(CHANNELS.exportDocumentFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = ExportDocumentFilePayload.parse(payload);
    // workspaceId authorizes the CALLER (a real, currently-open workspace) —
    // the save target itself is intentionally outside any workspace, same as
    // exportWorkspaceZip above.
    requireWorkspace(input.workspaceId);

    const exportKinds: Record<
      typeof input.kind,
      { extension: string; title: string; filter: Electron.FileFilter }
    > = {
      markdown: {
        extension: "md",
        title: "Export as Markdown",
        filter: { name: "Markdown document", extensions: ["md"] },
      },
      html: {
        extension: "html",
        title: "Export as HTML",
        filter: { name: "HTML document", extensions: ["html"] },
      },
      pdf: {
        extension: "pdf",
        title: "Export as PDF",
        filter: { name: "PDF document", extensions: ["pdf"] },
      },
    };
    const exportKind = exportKinds[input.kind];
    const testSave = process.env.DOHC_TEST_SAVE_PATH;
    let target: string | null;
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testSave) {
      target = testSave;
    } else {
      const result = await dialog.showSaveDialog({
        title: exportKind.title,
        defaultPath: `${input.suggestedName}.${exportKind.extension}`,
        filters: [exportKind.filter],
      });
      target = result.canceled ? null : (result.filePath ?? null);
    }
    if (target !== null) {
      const { writeFile } = await import("node:fs/promises");
      if (input.kind === "pdf") {
        await writeFile(target, await renderHtmlToPdf(input.content));
      } else {
        // Markdown and HTML both arrive as the exact text to persist —
        // markdown is the raw document source, HTML the self-contained render.
        await writeFile(target, input.content, "utf8");
      }
    }
    return ExportDocumentFileResult.parse({ path: target });
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
      // Shared views (PR 18) get a READ-ONLY menu: no create/rename/delete/
      // import — main owns the menu, so the reduction cannot be bypassed by
      // the renderer. Sharing itself is offered only on synced, non-shared
      // workspaces (a share needs a relay-side workspace to grant from).
      const registryEntry = findWorkspace(input.workspaceId);
      const isSharedView = !!registryEntry?.shareView;
      // Share-mount paths (shared-with-me/…) are a read-only projection of
      // someone else's files: no create/rename/delete/import/share — main
      // owns the menu, so the reduction cannot be bypassed by the renderer.
      // The mount root itself (shared-with-me/<label> with a matching mount
      // record) additionally offers refresh and removal.
      const isMountPath =
        !isSharedView && !!input.path && isSharedWithMePath(input.path);
      const mountForPath = isMountPath
        ? (registryEntry?.shareMounts ?? []).find(
            (mount) => input.path === `shared-with-me/${mount.label}`,
          )
        : undefined;
      const canShare =
        !isSharedView && !isMountPath && !!registryEntry?.remote && input.kind !== "root";
      const template: Electron.MenuItemConstructorOptions[] = isSharedView
        ? input.kind === "root"
          ? [item("Export Workspace as Zip…", "export-zip")]
          : [
              input.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
              separator,
              item("Export as Zip…", "export-zip"),
              item("Reveal in File Manager", "open-externally"),
            ]
        : isMountPath
          ? [
              ...(mountForPath
                ? [
                    item("Refresh Share", "refresh-share-mount"),
                    item("Remove Share from Workspace", "unmount-share"),
                    separator,
                  ]
                : [item("Refresh Shares", "refresh-share-mount"), separator]),
              input.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
              separator,
              item("Export as Zip…", "export-zip"),
              item("Reveal in File Manager", "open-externally"),
            ]
        : input.kind === "root"
          ? [
              item("New File", "new-file"),
              item("New Folder", "new-folder"),
              separator,
              item("Import Files…", "import-files"),
              item("Export Workspace as Zip…", "export-zip"),
            ]
          : [
              ...(canShare ? [item("Share…", "share"), separator] : []),
              ...(input.kind === "folder"
                ? [
                    item("New File", "new-file"),
                    item("New Folder", "new-folder"),
                    // Folder-targeted import: files land IN this folder (the
                    // renderer passes the folder as importWorkspaceFiles'
                    // targetDir, re-validated main-side before any copy).
                    item("Import Files…", "import-files"),
                    separator,
                  ]
                : []),
              item("Rename", "rename"),
              item("Delete", "delete"),
              input.pinned ? item("Unpin", "unpin") : item("Pin", "pin"),
              separator,
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
        "read",
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
              item("Copy Path", "copy-path"),
              item("Show in Explorer", "show-in-explorer"),
            ]
          : input.context === "status"
            ? [
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
            : [...editRoles];
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
    assertWritableWorkspace(workspace);
    // OS drag-in path: renderer-supplied absolute paths (see the trust-delta
    // note on the payload) re-validated by importDroppedPaths — regular
    // files only, never any registered workspace's .dohc metadata. The
    // renderer-supplied targetDir is re-validated inside the import path
    // (resolveImportDestination) before any copy.
    if (input.droppedPaths !== undefined) {
      const outcome = await importDroppedPaths(
        workspace.rootPath,
        input.droppedPaths,
        listWorkspaces().map((ws) => ws.rootPath),
        input.targetDir,
      );
      return ImportWorkspaceFilesResult.parse(outcome);
    }
    const picked = testImportPaths();
    const result =
      picked === null
        ? await dialog.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            title: "Import files into workspace",
          })
        : { canceled: false, filePaths: picked };
    const outcome = result.canceled
      ? { imported: [], skipped: 0 }
      : await copyIntoWorkspace(workspace.rootPath, result.filePaths, input.targetDir);
    return ImportWorkspaceFilesResult.parse(outcome);
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
    assertWritableWorkspace(workspace);
    await writeWorkspaceText(workspace.rootPath, input.relativePath, input.text);
  });

  ipcMain.handle(CHANNELS.writeWorkspaceAsset, async (event, payload) => {
    assertTrustedSender(event);
    const input = WriteWorkspaceAssetPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
    await writeWorkspaceAsset(
      workspace.rootPath,
      input.relativePath,
      input.bytes,
    );
  });

  // `/image`: a native open dialog that STARTS AT THE WORKSPACE ROOT (a
  // renderer <input type="file"> cannot set a starting directory), then reads
  // the picks here and hands the renderer their bytes — one round trip into
  // the same write+insert path paste and drop already use. The picked files
  // are deliberately allowed to live ANYWHERE on disk: this is a user-directed
  // pick, and the bytes are copied INTO the workspace by writeWorkspaceAsset,
  // which re-validates containment. The renderer never sees an absolute path.
  ipcMain.handle(CHANNELS.pickImageFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = PickImageFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);

    const seam = testAbsolutePaths("DOHC_TEST_PICK_IMAGE_PATHS", MAX_PICKED_IMAGES);
    let picked: string[];
    if (seam) {
      picked = seam;
    } else {
      const result = await dialog.showOpenDialog({
        title: "Insert image",
        // The workspace directory — where a user's own images live — instead
        // of wherever the OS last happened to leave the dialog.
        defaultPath: workspace.rootPath,
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"],
          },
        ],
      });
      picked = result.canceled ? [] : result.filePaths;
    }

    const { readFile, stat } = await import("node:fs/promises");
    const files: PickImageFilesResult["files"] = [];
    for (const path of picked.slice(0, MAX_PICKED_IMAGES)) {
      try {
        const info = await stat(path);
        // Oversize picks are refused the same QUIET way paste refuses them:
        // skipped with a warning, never a thrown dialog in the user's face.
        if (!info.isFile() || info.size === 0 || info.size > WRITE_ASSET_MAX_BYTES) {
          console.warn(
            `[desktop] skipping picked image "${path}" (${info.size} bytes; max ${WRITE_ASSET_MAX_BYTES}).`,
          );
          continue;
        }
        files.push({
          name: basename(path),
          mediaType: mediaTypeForExtension(path),
          bytes: new Uint8Array(await readFile(path)),
        });
      } catch (error) {
        console.warn(`[desktop] could not read picked image "${path}":`, error);
      }
    }
    return PickImageFilesResult.parse({ files });
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
      "read",
    );
    const error = await shell.openPath(realTarget);
    if (error) throw new Error(error);
  });

  ipcMain.handle(CHANNELS.readWorkspaceGraph, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadWorkspaceGraphPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const graph = await readWorkspaceGraph(workspace.rootPath);
    if (!input.includeChatMentions) return WorkspaceGraphResult.parse(graph);
    const { workspace: engineWorkspace } = await requireEngineCapture(
      input.workspaceId,
      "Chat mentions are not enabled for this workspace.",
    );
    await syncWorkspaceSharedChannels(engineWorkspace.workspaceId);
    const store = linkedChatStoreFor(engineWorkspace);
    const threads = await store.listThreads({ workspaceId: engineWorkspace.workspaceId });
    const graphChannelRows = await store.listChannels({
      workspaceId: engineWorkspace.workspaceId,
    });
    const graphChannels = new Map(
      graphChannelRows.map(
        (channel) => [channel.id, channel] as const,
      ),
    );
    const graphChannelWireIds = new Map(
      await Promise.all(
        graphChannelRows.map(async (channel) => [
          channel.id,
          await store.getChannelWireId({
            workspaceId: engineWorkspace.workspaceId,
            channelId: channel.id,
          }),
        ] as const),
      ),
    );
    const activeFiles = await activeEngineFileIndex(engineWorkspace);
    const authorizedMentions = (
      await Promise.all(
        threads.map(async (thread) => {
          const attachments = await store.listThreadAttachments(
            engineWorkspace.workspaceId,
            thread.id,
          );
          return attachments.flatMap((attachment) => {
            // Stable object identity owns path resolution. A hint is usable
            // only for legacy/opaque rows where no object identity exists; an
            // object that disappeared from the active version fails closed.
            const filePath = attachment.objectId
              ? activeFiles.pathByObjectId.get(attachment.objectId)
              : attachment.pathHint;
            const fileObjectId =
              attachment.objectId ??
              (filePath ? activeFiles.objectIdByPath.get(filePath) : undefined);
            return filePath && fileObjectId
              ? [{
                    threadId: thread.id,
                    threadTitle: thread.title,
                    messageId: attachment.messageId,
                    fileObjectId,
                    filePath,
                    ...(thread.channelId && graphChannels.get(thread.channelId)
                      ? {
                          channel: {
                            id: graphChannels.get(thread.channelId)!.id,
                            ...(graphChannelWireIds.get(thread.channelId)
                              ? { wireId: graphChannelWireIds.get(thread.channelId)! }
                              : {}),
                            name: graphChannels.get(thread.channelId)!.name,
                            slug: graphChannels.get(thread.channelId)!.slug,
                            kind: graphChannels.get(thread.channelId)!.kind,
                          },
                        }
                      : {}),
                    ...(attachment.headingAnchor && attachment.headingText
                      ? {
                          heading: {
                            anchor: attachment.headingAnchor,
                            text: attachment.headingText,
                            occurrence: attachment.headingOccurrence ?? 0,
                          },
                        }
                      : {}),
                  }]
              : [];
          });
        }),
      )
    ).flat();
    const overlaid = addChatMentionsToWorkspaceGraph(
      graph,
      authorizedMentions,
      true,
      activeFiles.objectIdByPath,
    );
    const filePathsById = new Map(
      overlaid.nodes
        .filter((node) => node.kind === "file")
        .map((node) => [node.id, node.path] as const),
    );
    return WorkspaceGraphResult.parse({
      ...overlaid,
      nodes: overlaid.nodes.map((node) =>
        node.kind === "file"
          ? {
              path: node.path,
              kind: "file" as const,
              filePath: node.path,
              title: node.title,
              incoming: node.incoming,
              outgoing: node.outgoing,
            }
          : node.kind === "chat-thread"
            ? {
                path: node.id,
                kind: "chat-thread" as const,
                threadId: node.threadId,
                ...(node.channel
                  ? {
                      channelId: node.channel.id,
                      ...(node.channel.wireId
                        ? { channelWireId: node.channel.wireId }
                        : {}),
                      channelName: node.channel.name,
                      channelSlug: node.channel.slug,
                      channelKind: node.channel.kind,
                    }
                  : {}),
                title: node.title.slice(0, 120),
                incoming: node.incoming,
                outgoing: node.outgoing,
              }
            : {
                path: node.id,
                kind: "heading" as const,
                filePath: node.filePath,
                headingAnchor: node.anchor,
                title: `#${node.title.slice(0, 119)}`,
                incoming: node.incoming,
                outgoing: node.outgoing,
              },
      ),
      edges: overlaid.edges.map((edge) => ({
        source: filePathsById.get(edge.source) ?? edge.source,
        target: filePathsById.get(edge.target) ?? edge.target,
        kind: edge.kind,
      })),
    });
  });

  ipcMain.handle(CHANNELS.getBacklinks, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetBacklinksPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return GetBacklinksResult.parse({
      sources: await readWorkspaceBacklinks(workspace.rootPath, input.path),
    });
  });

  ipcMain.handle(CHANNELS.listWorkspaceHeadings, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceHeadingsPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const source = await readWorkspaceText(workspace.rootPath, input.path);
    return ListWorkspaceHeadingsResult.parse({
      headings: workspaceHeadingRecords(extractWorkspaceHeadings(source.text)),
    });
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
    return CloudLoginStartResult.parse(await cloudLogin().start(input.serverUrl, input.relayUrl));
  });

  ipcMain.handle(CHANNELS.cloudLoginPoll, async (event) => {
    assertTrustedSender(event);
    const result = await cloudLogin().poll();
    if (result.status === "complete") {
      const previousRelayUrl = cachedCredentials?.relayUrl;
      await refreshCredentialCache();
      const relayChanged =
        previousRelayUrl !== undefined &&
        cachedCredentials?.relayUrl !== undefined &&
        normalizeServerUrl(previousRelayUrl) !==
          normalizeServerUrl(cachedCredentials.relayUrl);
      if (relayChanged) {
        await activity.stopEngines();
        await closeAllRelayTransportWorkspaces();
      }
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
    const workspace = input.workspaceId ? findWorkspace(input.workspaceId) : undefined;
    return CloudStatusResult.parse({
      ...status,
      ...(input.workspaceId
        ? {
            workspaceSynced: !!workspace?.remote,
            ...(workspace
              ? {
                  workspaceSecretState: await readWorkspaceSecretState(
                    workspace.rootPath,
                    workspace.workspaceId,
                  ),
                }
              : {}),
          }
        : {}),
    });
  });

  ipcMain.handle(CHANNELS.cloudLogout, async (event) => {
    assertTrustedSender(event);
    await cloudLogin().logout();
    // Stop + drop active engines so edits after Disconnect never push with the
    // now-cleared session.
    await activity.stopEngines();
    await closeAllRelayTransportWorkspaces();
    clearCachedCredentials();
    notifyRenderer();
  });

  // Enabling sync claims the workspace id on the RELAY (first claimant owns
  // it; members re-enable idempotently; strangers get the relay's fixed 404 →
  // "already claimed"), records the remote identity, and starts the merge
  // engine: pull, then push everything local. Requires a signed-in session.
  //
  // The relay's POST /sync/workspaces is the SOLE claim authority: workspace-api
  // is now auth-only and 404s every non-auth route, so there is no separate
  // preclaim to make — the relay owns ownership end to end (create / idempotent
  // same-owner / foreign-refused).
  ipcMain.handle(CHANNELS.cloudEnableSync, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudEnableSyncPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const credentials = await cloudLogin().credentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first");
    if (!credentials.relayUrl) throw new Error("Cloud sync requires a relay URL");
    setCachedCredentials(credentials);

    {
      const relay = {
        baseUrl: credentials.relayUrl,
        token: credentials.token,
      };
      const daemonRelay = relayClientForWorkspace({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        relay,
      });
      try {
        await daemonRelay.claim();
      } catch (error) {
        if (error instanceof RelayWorkspaceUnavailableError) {
          throw new Error("This workspace id is already claimed by another account");
        }
        throw error;
      }
      const dataKey = await readWorkspaceDataKeyForEnrollment(
        workspace.rootPath,
        workspace.workspaceId,
      );
      if (dataKey) {
        const passphrase = input.passphrase ?? "";
        const passphraseError = validateSecretPassphrase(passphrase);
        if (passphraseError) {
          throw new Error(passphraseError);
        }
        try {
          const { envelopeJson } = await wrapWorkspaceDataKey({
            dataKey,
            passphrase,
            workspaceId: workspace.workspaceId,
          });
          await uploadKeyEnvelope({
            workspaceId: workspace.workspaceId,
            relay: {
              baseUrl: credentials.relayUrl,
              token: credentials.token,
            },
            envelopeJson,
          });
        } finally {
          dataKey.fill(0);
        }
      } else {
        let envelopeJson: string | null = null;
        try {
          envelopeJson = await downloadKeyEnvelope({
            workspaceId: workspace.workspaceId,
            relay: {
              baseUrl: credentials.relayUrl,
              token: credentials.token,
            },
          });
        } catch (error) {
          if (!(error instanceof RelayKeyEnvelopeMissingError)) throw error;
        }
        if (envelopeJson) {
          if (!input.passphrase) {
            throw new Error("Passphrase required to unlock synced secrets.");
          }
          let unwrapped: Buffer;
          try {
            unwrapped = await unwrapWorkspaceDataKey({
              envelopeJson,
              passphrase: input.passphrase,
              workspaceId: workspace.workspaceId,
            });
          } catch (error) {
            if (error instanceof SecretKeyEnvelopeError) {
              throw new Error("Passphrase could not unlock synced secrets.");
            }
            throw error;
          }
          try {
            await installWorkspaceDataKey(workspace.rootPath, unwrapped);
          } finally {
            unwrapped.fill(0);
          }
        }
      }
    }

    setWorkspaceRemote(workspace.workspaceId, {
      serverUrl: credentials.serverUrl,
      remoteWorkspaceId: workspace.workspaceId,
    });
    await activity.enableCloud(workspace);
    return SyncStatusResult.parse(activity.getStatus(workspace.workspaceId));
  });

  // Join a synced workspace on THIS machine (0P-C): sync code from the
  // machine that already has it + a locally picked empty folder. Everything
  // is validated BEFORE any local state is created, so a mistyped code can
  // never mint an empty workspace; the first pull brings files, history,
  // and chats through the same engine sync path every later pull uses.
  ipcMain.handle(CHANNELS.cloudJoinWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudJoinWorkspacePayload.parse(payload);
    const parsed = parseSyncCode(input.syncCode);
    if (!parsed) {
      throw new Error(
        "That doesn't look like a workspace code. Copy it again from the other machine.",
      );
    }
    const credentials = await cloudLogin().credentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first.");
    if (!credentials.relayUrl || !relayUrlsMatch(credentials.relayUrl, parsed.relayUrl)) {
      // Security gate, not cosmetics: the session token is only ever sent to
      // the relay this machine signed in with — never to a URL that arrived
      // inside a pasted code.
      throw new Error(
        "This workspace syncs through a different server than the one you're signed in to. " +
          `Reconnect dohc Cloud with the sync relay URL ${parsed.relayUrl}, then join again.`,
      );
    }
    setCachedCredentials(credentials);
    if (findWorkspace(parsed.workspaceId)) {
      throw new Error("This workspace is already on this machine.");
    }
    const rootPath = usableRoot(input.rootPath);
    const existingEntries = await readdir(rootPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (existingEntries.length > 0) {
      throw new Error(
        "Choose an empty folder — the synced workspace's files will be placed inside it.",
      );
    }

    // Pre-flight against the relay BEFORE creating anything locally.
    const relay = { baseUrl: credentials.relayUrl, token: credentials.token };
    try {
      const probe = await probeWorkspaceRelay(relayTransportRoutes, {
        workspaceId: parsed.workspaceId,
        relay,
      });
      if (!probe.hasContent) {
        throw new Error(
          "That workspace hasn't synced anything yet. Make sure sync is on for it on the other machine, then try again.",
        );
      }
    } catch (error) {
      if (error instanceof RelayWorkspaceUnavailableError) {
        throw new Error(
          "No synced workspace matches that code for your account. Check the code and that you're signed in with the same account.",
        );
      }
      if (error instanceof RelayUnauthorizedError) {
        throw new Error("Your dohc Cloud session expired. Sign in again, then retry.");
      }
      throw error;
    }

    desktopMarks.mark("workspace-join-start");
    // Join bootstrap (0P-C gate fix): identity/metadata only — no starter
    // files. The synced workspace's real content arrives with the first
    // pull; anything seeded here could be captured by reconciliation and
    // pushed INTO the remote workspace before that pull.
    const created = await createWorkspaceFolder({
      rootPath,
      kind: "personal",
      workspaceId: parsed.workspaceId,
      bootstrap: "join",
    });
    const summary = WorkspaceSummary.parse(created);
    registerWorkspace({ ...created, joinBootstrapPending: true });
    refreshNativeWorkspaceSurfaces();
    try {
      // Open first (watcher + engine capture on an empty folder), THEN bind
      // the remote and enable sync. joinBootstrap makes the engine PULL-FIRST:
      // its start() is the first pull (materialize + cursor commit), and no
      // push can reach the relay before that pull succeeds — a fresh join can
      // never seed boilerplate into the remote or conflict against it.
      await openWorkspaceActivity(created, async () => {
        setWorkspaceRemote(created.workspaceId, {
          serverUrl: credentials.serverUrl,
          remoteWorkspaceId: parsed.workspaceId,
        });
        await activity.enableCloud(created, { joinBootstrap: true });
        completeWorkspaceJoinBootstrap(created.workspaceId);
      });
    } catch (error) {
      // Failed-first-pull contract (0P-C gate fix, documented choice): roll
      // the ENTIRE join back — engine/watcher/capture, registry entry, and
      // the folder contents this attempt created — instead of leaving a
      // half-joined workspace whose next launch would push before ever
      // having pulled. Everything removed still lives on the relay; the
      // user retries with the same code and the same (empty again) folder.
      console.error(`[desktop] join rollback for ${rootPath}:`, error);
      await activity.close(created.workspaceId).catch(() => undefined);
      await closeRelayTransportWorkspace(parsed.workspaceId).catch(
        () => undefined,
      );
      try {
        removeWorkspace(created.workspaceId);
      } catch {}
      await resetFailedJoinFolder(rootPath).catch(() => undefined);
      refreshNativeWorkspaceSurfaces();
      notifyRenderer();
      throw new Error(
        "Couldn't download the workspace. Nothing was added on this machine — check your connection and try again.",
      );
    }
    desktopMarks.measureSince("workspace-join", "workspace-join-start");
    notifyRenderer();
    return CloudJoinWorkspaceResult.parse({ workspace: summary });
  });

  // ---- Relay shares (PR 18) ----

  // Grant side: create a share on the SYNC RELAY for a synced workspace.
  // Selector validation (secret refusal, traversal, caps) is server-side —
  // the relay is the security boundary; this handler only adds product copy.
  ipcMain.handle(CHANNELS.createRelayShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateRelaySharePayload.parse(payload);
    if (!input.paths?.length && !input.versionId) {
      throw new Error("Pick a file, folder, or version to share.");
    }
    // No transitive sharing: mounted shares are someone else's files. The
    // relay's selector validation refuses reserved paths anyway (the
    // authoritative gate); this adds the honest product copy.
    if (input.paths?.some((path) => isSharedWithMePath(path))) {
      throw new Error(
        "This came to you through a share — copy it into your own files to share it onward.",
      );
    }
    const entry = requireWorkspace(input.workspaceId);
    if (entry.shareView) {
      throw new Error("This is a shared view — only the original workspace can be shared.");
    }
    const { remote } = await remoteForWorkspace(input.workspaceId);
    const created = await relayShareJson<{ shareId: string }>(
      `/sync/${encodeURIComponent(remote.remoteWorkspaceId)}/shares`,
      {
        method: "POST",
        body: JSON.stringify({
          recipientEmail: input.recipientEmail,
          ...(input.paths ? { paths: input.paths } : {}),
          ...(input.versionId ? { versionId: input.versionId } : {}),
        }),
      },
    );
    const shareCode = buildShareCode({
      shareId: created.shareId,
      relayUrl: cachedCredentials!.relayUrl!,
    });
    return CreateRelayShareResult.parse({
      shareId: created.shareId,
      shareCode,
      recipientEmail: input.recipientEmail,
    });
  });

  ipcMain.handle(CHANNELS.listRelayShares, async (event) => {
    assertTrustedSender(event);
    const result = await relayShareJson<{
      granted: Array<Record<string, unknown>>;
      received?: Array<Record<string, unknown>>;
    }>("/sync/shares");
    const relayUrl = cachedCredentials?.relayUrl;
    // Chat-channel grants (MU-C4) are listed through listChatChannelShares;
    // this surface stays the path/version share manager (grant AND receive).
    const notChatChannel = (row: Record<string, unknown>) =>
      (row.selector as { kind?: unknown } | undefined)?.kind !== "chat-channel";
    const withCode = (row: Record<string, unknown>) => ({
      ...row,
      shareCode: buildShareCode({ shareId: String(row.shareId), relayUrl: relayUrl! }),
    });
    const granted = (result.granted ?? []).filter(notChatChannel).map(withCode);
    const received = (result.received ?? []).filter(notChatChannel).map(withCode);
    return ListRelaySharesResult.parse({ granted, received });
  });

  ipcMain.handle(CHANNELS.revokeRelayShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeRelaySharePayload.parse(payload);
    await relayShareJson(`/sync/shares/${encodeURIComponent(input.shareId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return undefined;
  });

  // --- Shared channels (MU-C4) --------------------------------------------
  // A chat-channel grant shares a WHOLE channel (threads/messages/reactions)
  // with another account, read-write by default. The relay owns every
  // security decision (membership, authorship, channel scoping, revocation);
  // these handlers only address grants and move the member-side sync.

  ipcMain.handle(CHANNELS.shareChatChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShareChatChannelPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
    const store = linkedChatStoreFor(workspace);
    await requireShareableChatChannel({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
      store,
    });
    const wireId = await store.getChannelWireId({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
    });
    if (!wireId) throw new Error("This channel can't be shared yet.");
    // "general" is every workspace's personal default channel — the SAME wire
    // id everywhere by design, so sharing it would merge strangers' personal
    // chats. Refuse with a way forward.
    if (wireId === GENERAL_CHANNEL_WIRE_ID) {
      throw new Error(
        "The general channel is personal to each workspace. Create a channel to share it.",
      );
    }
    const entry = findWorkspace(input.workspaceId);
    if (entry?.sharedChannels?.some((channel) => channel.channelWireId === wireId)) {
      throw new Error(
        "This channel was shared with you — ask the person who shared it to add more people.",
      );
    }
    const { remote } = await remoteForWorkspace(input.workspaceId);
    const created = await relayShareJson<{ shareId: string }>(
      `/sync/${encodeURIComponent(remote.remoteWorkspaceId)}/shares`,
      {
        method: "POST",
        body: JSON.stringify({
          recipientEmail: input.recipientEmail,
          channelWireId: wireId,
          ...(input.access ? { access: input.access } : {}),
        }),
      },
    );
    return ShareChatChannelResult.parse({ shareId: created.shareId });
  });

  ipcMain.handle(CHANNELS.listChatChannelShares, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelSharesPayload.parse(payload);
    const entry = requireWorkspace(input.workspaceId);
    const joined = (entry.sharedChannels ?? []).map((channel) => ({
      shareId: channel.shareId,
      channelWireId: channel.channelWireId,
      access: channel.access,
      granterEmail: channel.granterEmail,
      ended: channel.ended === true,
    }));
    // Relay-side listings need a signed-in session; without one the local
    // joined set still answers (their local copies keep working offline).
    let granted: Array<Record<string, unknown>> = [];
    let received: Array<Record<string, unknown>> = [];
    try {
      const result = await relayShareJson<{
        granted?: Array<Record<string, unknown>>;
        received?: Array<Record<string, unknown>>;
      }>("/sync/shares");
      const chatSelector = (row: Record<string, unknown>) => {
        const selector = row.selector as
          | { kind?: unknown; channelWireId?: unknown; access?: unknown }
          | undefined;
        return selector?.kind === "chat-channel" &&
          typeof selector.channelWireId === "string"
          ? {
              channelWireId: selector.channelWireId,
              access: selector.access === "read-only" ? "read-only" : "read-write",
            }
          : null;
      };
      const remoteId = entry.remote?.remoteWorkspaceId ?? null;
      for (const row of result.granted ?? []) {
        const selector = chatSelector(row);
        // Grants are scoped to THIS workspace's remote identity: a channel
        // shared from another workspace is managed there.
        if (!selector || remoteId === null || row.workspaceId !== remoteId) continue;
        granted.push({
          shareId: row.shareId,
          ...selector,
          recipientEmail: row.recipientEmail ?? null,
          revokedAtMs: row.revokedAtMs ?? null,
        });
      }
      for (const row of result.received ?? []) {
        const selector = chatSelector(row);
        if (!selector) continue;
        received.push({
          shareId: row.shareId,
          ...selector,
          granterEmail: row.granterEmail ?? null,
        });
      }
    } catch {
      granted = [];
      received = [];
    }
    return ListChatChannelSharesResult.parse({ granted, received, joined });
  });

  ipcMain.handle(CHANNELS.joinSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = JoinSharedChannelPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const entry = requireWorkspace(input.workspaceId);
    if (entry.shareView) {
      throw new Error("Shared views are read-only — join channels from a workspace you own.");
    }
    await warmCredentialCache();
    if (!cachedCredentials) throw new Error("Sign in to dohc Cloud first.");
    if (!cachedCredentials.relayUrl) {
      throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
    }
    // Capture the credentials BEFORE the awaits below (CodeRabbit Data
    // Integrity): cachedCredentials can change during fetch/pull (logout,
    // relay switch) — re-reading it afterwards can crash on null or pin the
    // joined channel to the WRONG relay. The join is atomic against the
    // credentials it started with.
    const joinedRelayUrl = cachedCredentials.relayUrl;
    const relay = {
      baseUrl: normalizeServerUrl(joinedRelayUrl),
      token: cachedCredentials.token,
      // Same timeout wrapper runSharedChannelSyncPass uses (:973): an
      // unresponsive relay must abort the join's fetch/pull instead of leaving
      // the renderer's "Joining…" button stuck forever.
      fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
    };
    let info;
    try {
      info = await fetchSharedChannelInfo({ relay, shareId: input.shareId });
      const daemonRelay = relayClientForWorkspace({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        relay,
      });
      const pulled = await daemonRelay.pullSharedChannel({
        shareId: info.shareId,
        channelWireId: info.channelWireId,
      });
      if (pulled.applied > 0) {
        await projectPendingChatBookmarksAfterPull(workspace.workspaceId);
      }
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        throw new Error("That shared channel isn't available anymore.");
      }
      throw error;
    }
    const joined: JoinedSharedChannel = {
      shareId: info.shareId,
      channelWireId: info.channelWireId,
      access: info.access,
      granterEmail: info.granterEmail,
      relayUrl: joinedRelayUrl,
    };
    // Dedup by shareId AND channelWireId (CodeRabbit Data Integrity): a
    // re-join of the same channel under a NEW share id (revoked + re-granted)
    // replaces the stale row instead of listing and syncing the channel twice.
    setWorkspaceSharedChannels(
      input.workspaceId,
      mergeJoinedChannel(entry.sharedChannels ?? [], joined),
    );
    return JoinSharedChannelResult.parse({ joined: { ...joined, ended: false } });
  });

  // Member-initiated leave: purely local — the channel stops syncing and its
  // rows stay readable. (Only the granter can revoke the grant itself.)
  ipcMain.handle(CHANNELS.leaveSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveSharedChannelPayload.parse(payload);
    const entry = requireWorkspace(input.workspaceId);
    setWorkspaceSharedChannels(
      input.workspaceId,
      (entry.sharedChannels ?? []).filter((channel) => channel.shareId !== input.shareId),
    );
    return undefined;
  });

  // Receive side: open a pasted share code as a READ-ONLY shared view.
  // Mirrors the join flow's ordering guarantees: everything is validated
  // BEFORE local state exists, the token only ever goes to the signed-in
  // relay, and a failed first pull rolls the whole thing back.
  ipcMain.handle(CHANNELS.openSharedView, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenSharedViewPayload.parse(payload);
    const parsed = parseShareCode(input.shareCode);
    if (!parsed) {
      throw new Error("That doesn't look like a share code. Copy it again and retry.");
    }
    const credentials = await cloudLogin().credentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first.");
    if (!credentials.relayUrl || !relayUrlsMatch(credentials.relayUrl, parsed.relayUrl)) {
      // Security gate, not cosmetics: the session token is only ever sent to
      // the relay this machine signed in with — never to a URL that arrived
      // inside a pasted code.
      throw new Error(
        "This share lives on a different server than the one you're signed in to. " +
          `Reconnect dohc Cloud with the sync relay URL ${parsed.relayUrl}, then try again.`,
      );
    }
    setCachedCredentials(credentials);
    const relay = { baseUrl: credentials.relayUrl, token: credentials.token };
    // Pre-flight against the relay BEFORE creating anything locally; also
    // learns who shared it for the honest read-only copy.
    let info: Awaited<ReturnType<typeof fetchShareViewInfo>>;
    try {
      info = await fetchShareViewInfo({ relay, shareId: parsed.shareId });
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        throw new Error(
          "No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
        );
      }
      if (error instanceof RelayUnauthorizedError) {
        throw new Error("Your dohc Cloud session expired. Sign in again, then retry.");
      }
      throw error;
    }
    const rootPath = usableRoot(input.rootPath);
    const existingEntries = await readdir(rootPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (existingEntries.length > 0) {
      throw new Error("Choose an empty folder — the shared files will be placed inside it.");
    }
    // Identity/metadata only (the join bootstrap): the shared content
    // arrives with the first pull below, and a shared view must never seed
    // starter files of its own.
    const created = await createWorkspaceFolder({
      rootPath,
      kind: "personal",
      bootstrap: "join",
    });
    registerWorkspace(created);
    setWorkspaceShareView(created.workspaceId, {
      shareId: parsed.shareId,
      granterEmail: info.granterEmail,
      // Persist the origin relay so a later refresh signed into a DIFFERENT
      // relay is skipped instead of misreading a 404 as "share ended".
      relayUrl: credentials.relayUrl,
    });
    refreshNativeWorkspaceSurfaces();
    try {
      const daemonRelay = relayClientForWorkspace({
        workspaceId: created.workspaceId,
        rootPath: created.rootPath,
        relay,
      });
      const outcome = await refreshSharedViewOnce({
        rootDir: created.rootPath,
        workspaceId: created.workspaceId,
        relay,
        shareId: parsed.shareId,
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
          }),
      });
      if (outcome.status === "ended") {
        throw new ShareUnavailableError();
      }
    } catch (error) {
      console.error(`[desktop] open-share rollback for ${rootPath}:`, error);
      await closeRelayTransportWorkspace(created.workspaceId).catch(
        () => undefined,
      );
      try {
        removeWorkspace(created.workspaceId);
      } catch {}
      await resetFailedJoinFolder(rootPath).catch(() => undefined);
      refreshNativeWorkspaceSurfaces();
      notifyRenderer();
      if (error instanceof ShareUnavailableError) {
        throw new Error(
          "This share was ended before it could be opened. Nothing was added on this machine.",
        );
      }
      throw new Error(
        "Couldn't open the share. Nothing was added on this machine — check your connection and try again.",
      );
    }
    notifyRenderer();
    const summary = WorkspaceSummary.parse(findWorkspace(created.workspaceId));
    return OpenSharedViewResult.parse({ workspace: summary });
  });

  ipcMain.handle(CHANNELS.refreshSharedView, async (event, payload) => {
    assertTrustedSender(event);
    const input = RefreshSharedViewPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const shareView = workspace.shareView;
    if (!shareView) throw new Error("This workspace is not a shared view.");
    if (shareView.ended) {
      return RefreshSharedViewResult.parse({ status: "ended", changedPaths: 0 });
    }
    await warmCredentialCache();
    if (!cachedCredentials?.relayUrl) throw new Error("Sign in to dohc Cloud first.");
    // Only refresh against the share's ORIGIN relay. Signed into a different
    // relay, a 404 there means "wrong server", not "share ended" — so skip
    // the refresh (leaving the view active) rather than flip it to ended.
    if (
      shareView.relayUrl &&
      !relayUrlsMatch(cachedCredentials.relayUrl, shareView.relayUrl)
    ) {
      return RefreshSharedViewResult.parse({ status: "unchanged", changedPaths: 0 });
    }
    const relay = {
      baseUrl: cachedCredentials.relayUrl,
      token: cachedCredentials.token,
    };
    const daemonRelay = relayClientForWorkspace({
      workspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      relay,
    });
    const outcome = await refreshSharedViewOnce({
      rootDir: workspace.rootPath,
      workspaceId: workspace.workspaceId,
      relay,
      shareId: shareView.shareId,
      pull: async (input) =>
        await daemonRelay.pullShareView({
          shareId: input.shareId,
        }),
    });
    if (outcome.status === "ended") {
      // Persist the honest end state: the view stays readable and stops
      // refreshing; the notice survives restarts.
      setWorkspaceShareView(workspace.workspaceId, { ...shareView, ended: true });
      refreshNativeWorkspaceSurfaces();
    }
    notifyRenderer();
    return RefreshSharedViewResult.parse(outcome);
  });

  // ---- Share mounts ----
  // ONE mount operation at a time per workspace: mount, bulk refresh, and
  // unmount all interleave at their awaits, and unserialized they can drop
  // each other's registry rows (stale replace-the-set snapshots) or
  // re-materialize a folder the unmount just deleted (codex P2 pair). A
  // simple promise chain is enough — operations are short and rare.
  const shareMountLocks = new Map<string, Promise<unknown>>();
  function withShareMountLock<T>(
    workspaceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = shareMountLocks.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(run, run);
    shareMountLocks.set(
      workspaceId,
      next.catch(() => undefined),
    );
    return next;
  }

  // The receive side materialized INSIDE a host workspace: the share's
  // filtered files arrive under shared-with-me/<label>/ as ordinary
  // read-only files (agent-readable through normal tools). The mount's pull
  // state lives in its own nested .dohc (invisible to the host tree), and
  // the host's capture/search/relay-push already exclude shared-with-me via
  // the effective-policy floor — mounted content cannot leak into the
  // host's history or its synced copy.

  ipcMain.handle(CHANNELS.mountShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = MountSharePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // A mount changes the host tree — shared views cannot host mounts.
    assertWritableWorkspace(workspace);
    return withShareMountLock(workspace.workspaceId, async () => {
    const parsed = parseShareCode(input.shareCode);
    if (!parsed) {
      throw new Error("That doesn't look like a share code. Copy it again and retry.");
    }
    const credentials = await cloudLogin().credentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first.");
    if (!credentials.relayUrl || !relayUrlsMatch(credentials.relayUrl, parsed.relayUrl)) {
      // Same security gate as openSharedView: the session token is only ever
      // sent to the relay this machine signed in with.
      throw new Error(
        "This share lives on a different server than the one you're signed in to. " +
          `Reconnect dohc Cloud with the sync relay URL ${parsed.relayUrl}, then try again.`,
      );
    }
    setCachedCredentials(credentials);
    const relay = { baseUrl: credentials.relayUrl, token: credentials.token };
    const existing = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
    if (existing.some((mount) => mount.shareId === parsed.shareId)) {
      throw new Error("This share is already added to this workspace.");
    }
    let info: Awaited<ReturnType<typeof fetchShareViewInfo>>;
    try {
      info = await fetchShareViewInfo({ relay, shareId: parsed.shareId });
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        throw new Error(
          "No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
        );
      }
      if (error instanceof RelayUnauthorizedError) {
        throw new Error("Your dohc Cloud session expired. Sign in again, then retry.");
      }
      throw error;
    }
    // A chat-channel code has no file content to mount — send the user to
    // the right surface instead of creating an empty folder.
    assertMountableSelector(info.selector);
    // Label dedupe considers BOTH registry mounts and whatever is already on
    // disk under shared-with-me — a leftover or hand-made folder must never
    // be adopted (its contents would be overwritten by the pull and deleted
    // by rollback/unmount). createMountDirectory guards the container
    // against symlinks BEFORE any mkdir and creates the label EXCLUSIVELY.
    const sharedWithMeDir = join(workspace.rootPath, SHARED_WITH_ME_FOLDER);
    const onDisk = await readdir(sharedWithMeDir).catch(() => [] as string[]);
    const mount = {
      shareId: parsed.shareId,
      label: mountLabelFor(info.granterEmail, [
        ...existing.map((m) => m.label),
        ...onDisk,
      ]),
      granterEmail: info.granterEmail,
      relayUrl: credentials.relayUrl,
      recipientEmail: credentials.email ?? null,
    };
    await createMountDirectory(workspace.rootPath, mount.label);
    const mountRelayTarget = relayTargetForShareMount(workspace.rootPath, mount);
    try {
      // Inside the rollback scope: a failed registry write (ENOSPC, perms)
      // must also remove the just-created folder — the app deliberately
      // refuses to adopt or delete unrecorded shared-with-me folders, so an
      // orphan here would be permanent (codex P2).
      setWorkspaceShareMounts(workspace.workspaceId, [
        ...(findWorkspace(workspace.workspaceId)?.shareMounts ?? []),
        mount,
      ]);
      const daemonRelay = relayClientForWorkspace({
        ...mountRelayTarget,
        relay,
      });
      const outcome = await refreshShareMountOnce({
        hostRoot: workspace.rootPath,
        mount,
        relay,
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
          }),
      });
      if (outcome.status === "ended") throw new ShareUnavailableError();
      refreshNativeWorkspaceSurfaces();
      notifyRenderer();
      return MountShareResult.parse({
        workspace: WorkspaceSummary.parse(findWorkspace(workspace.workspaceId)),
        mount: {
          shareId: mount.shareId,
          label: mount.label,
          status: outcome.status,
          changedPaths: outcome.changedPaths,
        },
      });
    } catch (error) {
      // Rollback both sides — a failed mount leaves no record and no folder.
      // The record removal filters the CURRENT set (never a stale snapshot).
      console.error(`[desktop] mount-share rollback for ${mount.label}:`, error);
      try {
        const current = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
        setWorkspaceShareMounts(
          workspace.workspaceId,
          current.filter((m) => m.shareId !== mount.shareId),
        );
      } catch {}
      await closeRelayTransportWorkspace(mountRelayTarget.workspaceId).catch(
        () => undefined,
      );
      await removeMountFolder(workspace.rootPath, mount.label).catch(() => undefined);
      notifyRenderer();
      if (error instanceof ShareUnavailableError) {
        throw new Error(
          "This share was ended before it could be added. Nothing was added to this workspace.",
        );
      }
      throw new Error(
        "Couldn't add the share. Nothing was added to this workspace — check your connection and try again.",
      );
    }
    });
  });

  ipcMain.handle(CHANNELS.refreshShareMounts, async (event, payload) => {
    assertTrustedSender(event);
    const input = RefreshShareMountsPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return withShareMountLock(workspace.workspaceId, async () => {
    const mounts = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
    const results: Array<{
      shareId: string;
      label: string;
      status: "updated" | "unchanged" | "ended";
      changedPaths: number;
    }> = [];
    if (mounts.length === 0) {
      return RefreshShareMountsResult.parse({ results });
    }
    await warmCredentialCache().catch(() => undefined);
    // ONE credentials snapshot for the whole loop: a sign-out/sign-in while
    // an awaited refresh runs must never pair the old relay URL with a new
    // account's token (gpt-5.6-sol P1).
    const credentials = cachedCredentials;
    for (const mount of mounts) {
      if (mount.ended) {
        results.push({ shareId: mount.shareId, label: mount.label, status: "ended", changedPaths: 0 });
        continue;
      }
      // Offline, signed out, signed into a DIFFERENT relay, or signed into a
      // different ACCOUNT: skip — recipient routes 404 identically for "not
      // yours" and "revoked", so refreshing under the wrong identity would
      // permanently (and wrongly) stamp the mount ended.
      if (
        !credentials?.relayUrl ||
        !relayUrlsMatch(credentials.relayUrl, mount.relayUrl) ||
        (mount.recipientEmail != null &&
          credentials.email != null &&
          credentials.email !== mount.recipientEmail)
      ) {
        results.push({ shareId: mount.shareId, label: mount.label, status: "unchanged", changedPaths: 0 });
        continue;
      }
      try {
        const relay = {
          baseUrl: credentials.relayUrl,
          token: credentials.token,
        };
        const mountRelayTarget = relayTargetForShareMount(
          workspace.rootPath,
          mount,
        );
        const daemonRelay = relayClientForWorkspace({
          ...mountRelayTarget,
          relay,
        });
        const outcome = await refreshShareMountOnce({
          hostRoot: workspace.rootPath,
          mount,
          relay,
          pull: async (input) =>
            await daemonRelay.pullShareView({
              shareId: input.shareId,
            }),
        });
        if (outcome.status === "ended") {
          await closeRelayTransportWorkspace(mountRelayTarget.workspaceId).catch(
            () => undefined,
          );
          const current = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
          setWorkspaceShareMounts(
            workspace.workspaceId,
            current.map((m) => (m.shareId === mount.shareId ? { ...m, ended: true } : m)),
          );
        }
        results.push({
          shareId: mount.shareId,
          label: mount.label,
          status: outcome.status,
          changedPaths: outcome.changedPaths,
        });
      } catch (error) {
        // An expired session must SURFACE, not read as "refreshed, nothing
        // new" — a manual Refresh Share would otherwise report success
        // forever while every pull 401s (codex P2).
        if (error instanceof RelayUnauthorizedError) {
          throw new Error(
            "Your dohc Cloud session expired. Sign in again, then refresh shares.",
          );
        }
        // One mount's network failure must not stop the others; report it
        // as unchanged and move on.
        console.error(`[desktop] share-mount refresh failed for ${mount.label}:`, error);
        results.push({ shareId: mount.shareId, label: mount.label, status: "unchanged", changedPaths: 0 });
      }
    }
    notifyRenderer();
    return RefreshShareMountsResult.parse({ results });
    });
  });

  ipcMain.handle(CHANNELS.unmountShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = UnmountSharePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
    return withShareMountLock(workspace.workspaceId, async () => {
    const mounts = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
    const mount = mounts.find((m) => m.shareId === input.shareId);
    if (!mount) throw new Error("This share is not added to this workspace.");
    // Disk first, record second: a crash between the two leaves a record
    // whose folder is gone — refresh simply re-materializes or reports
    // ended — never an orphaned folder that looks like local files. The
    // record removal filters the CURRENT set (the lock serializes mount
    // operations, so no writer can interleave here anyway).
    await closeRelayTransportWorkspace(
      mountStoreWorkspaceIdFor(mount.shareId),
    );
    await removeMountFolder(workspace.rootPath, mount.label);
    const current = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
    setWorkspaceShareMounts(
      workspace.workspaceId,
      current.filter((m) => m.shareId !== mount.shareId),
    );
    refreshNativeWorkspaceSurfaces();
    notifyRenderer();
    return UnmountShareResult.parse({
      workspace: WorkspaceSummary.parse(findWorkspace(workspace.workspaceId)),
    });
    });
  });

  // Explicit dismissal of the "a choice made on another machine needs a
  // look" notice (0P-C gate fix): the pending remote-resolve set otherwise
  // clears itself when the referenced conflict resolves or converges.
  ipcMain.handle(CHANNELS.dismissSyncReviewNotice, async (event, payload) => {
    assertTrustedSender(event);
    const input = DismissSyncReviewNoticePayload.parse(payload);
    activity.dismissUnmatchedRemoteResolves(input.workspaceId);
    notifyRenderer();
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
    assertWritableWorkspace(workspace);
    return DatabaseSnapshotResult.parse(
      await applyDatabaseEdit(
        workspace.rootPath,
        input.relativePath,
        input.edit,
        { kind: "user", userId: "local" },
        now(),
        deps.createId ? { createId: deps.createId } : {},
      ),
    );
  });

  ipcMain.handle(CHANNELS.importToDatabase, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportToDatabasePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
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
    const sender = event.sender;
    const generation = rendererGeneration(sender.id);
    const pendingStart = beginSitePreviewStart(sender.id);
    const isCurrent = () =>
      !pendingStart.controller.signal.aborted &&
      !sender.isDestroyed() &&
      rendererGeneration(sender.id) === generation;
    try {
      const workspace = requireWorkspace(input.workspaceId);
      const sharedView = sharedViewOf(workspace.workspaceId);
      assertSitePreviewMode(workspace.workspaceId, input.mode);
      // A mounted share may provide a ready browser artifact, but must never
      // cause package/configured commands from somebody else to execute.
      if (isSharedWithMePath(input.siteRoot) && input.mode !== "static") {
        throw new Error(
          "Sites opened from shared-with-me use the static preview. Copy it into your own files to run dev or build commands.",
        );
      }
      const site = await getSitePackage(workspace.rootPath, input.siteRoot);
      if (!site) throw new Error(`Not a detected site: ${input.siteRoot}`);
      const scopeRoot =
        site.authority.kind === "share"
          ? site.authority.mountRoot
          : sharedView
            ? "."
            : null;
      const result = StartSitePreviewResult.parse(
        await startPreviewForSite({
          workspaceId: input.workspaceId,
          workspaceRoot: workspace.rootPath,
          site,
          mode: input.mode,
          isCurrent,
          signal: pendingStart.controller.signal,
          sharedView: !!sharedView,
          sdkScopeRoot: scopeRoot,
        }),
      );
      if (!isCurrent()) {
        await stopSitePreviewHandle(input.workspaceId, input.siteRoot);
        throw new Error("Site preview start was cancelled because the renderer restarted.");
      }
      sitePreviewSdkAuthorities.register({
        senderId: sender.id,
        generation,
        workspaceId: input.workspaceId,
        siteRoot: site.root,
        workspaceRoot: workspace.rootPath,
        scopeRoot,
        writable: !sharedView && site.authority.kind === "workspace",
      });
      return result;
    } finally {
      pendingStart.finish();
    }
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

  ipcMain.handle(CHANNELS.invokeSiteSdk, async (event, payload) => {
    assertTrustedSender(event);
    const input = InvokeSiteSdkPayload.parse(payload);
    const sender = event.sender;
    const authority = sitePreviewSdkAuthorities.authorize({
      senderId: sender.id,
      generation: rendererGeneration(sender.id),
      activeWorkspaceId: activeWorkspaceIdBySender.get(sender.id),
      workspaceId: input.workspaceId,
      siteRoot: input.siteRoot,
      previewRunning: sitePreviewHandles.has(sitePreviewKey(input.workspaceId, input.siteRoot)),
    });
    const result = await invokeSiteSdkHost(
      {
        workspaceRoot: authority.workspaceRoot,
        scopeRoot: authority.scopeRoot,
        writable: authority.writable,
        signal: authority.signal,
      },
      input.method,
      input.params,
    );
    return InvokeSiteSdkResult.parse({ result });
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
    activeWorkspaceIdBySender.set(event.sender.id, workspace.workspaceId);
    if (!activeWorkspaceCleanupHooked.has(event.sender)) {
      activeWorkspaceCleanupHooked.add(event.sender);
      event.sender.once("destroyed", () => {
        sitePreviewSdkAuthorities.revokeSender(event.sender.id);
        activeWorkspaceIdBySender.delete(event.sender.id);
        rendererGenerationBySender.delete(event.sender.id);
      });
    }
    refreshNativeWorkspaceSurfaces();
    return SyncStatusResult.parse(await openWorkspaceActivity(workspace));
  });

  // Named versions (PR 0M-4). Every handler resolves the workspace through
  // requireWorkspace (renderer identity is never trusted) and is gated on the
  // workspace-engine alpha capture being attached — for unflagged workspaces
  // the calls reject.
  async function requireEngineCapture(workspaceId: string, unavailable: string) {
    const workspace = requireWorkspace(workspaceId);
    // Idempotent: guarantees the watcher + capture are live before any
    // engine operation touches the chain.
    await openWorkspaceActivity(workspace);
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
      // Push the resolution promptly: "keep mine" changes nothing on disk, so
      // without this nudge the other machine's mirrored conflict would stay
      // open until an unrelated edit happened to trigger a sync.
      activity.queueCloudSync(input.workspaceId);
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
  // The moment/conflict record mappers live in ./ipc/engineHistoryIpc (pure,
  // unit-tested); main only injects the display-name rule below.
  // PR 0N-1: the SAME display-name rule the chat rail uses. AgentIntegration
  // stamps onBehalfOf "local" for the desktop's own user, which displays as
  // the cloud email (or "You" when signed out); any other onBehalfOf is
  // already a user-facing label and displays as-is.
  function agentAuthorDisplayName(author: NonNullable<VersionedTextMomentSummary["author"]>): string {
    return author.onBehalfOf === "local" ? localUserDisplayName() : author.onBehalfOf;
  }

  function chatThreadForIpc(thread: ChatThread): ChatThreadRecord {
    return {
      id: thread.id,
      title: thread.title,
      createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs,
    };
  }

  function chatAttachmentForIpc(
    attachment: ChatMessage["attachments"][number],
  ) {
    return {
      attachmentId: attachment.attachmentId,
      threadId: attachment.threadId,
      messageId: attachment.messageId,
      targetKind: attachment.targetKind,
      ...(attachment.objectId ? { objectId: attachment.objectId } : {}),
      ...(attachment.pathHint ? { pathHint: attachment.pathHint } : {}),
      ...(attachment.headingText ? { headingText: attachment.headingText } : {}),
      ...(attachment.headingAnchor ? { headingAnchor: attachment.headingAnchor } : {}),
      ...(attachment.headingOccurrence !== undefined
        ? { headingOccurrence: attachment.headingOccurrence }
        : {}),
      createdAtMs: attachment.createdAtMs,
    };
  }

  function chatMessageForIpc(message: ChatMessage): ChatMessageRecord {
    return {
      id: message.id,
      threadId: message.threadId,
      authorKind: message.author.kind,
      authorDisplayName: message.author.displayName,
      ...(message.parentMessageId
        ? { parentMessageId: message.parentMessageId }
        : {}),
      ...(message.origin ? { origin: message.origin } : {}),
      body: message.body,
      createdAtMs: message.createdAtMs,
      attachments: message.attachments.map(chatAttachmentForIpc),
    };
  }

  async function resolveChatFileReferences(
    workspace: ReturnType<typeof requireWorkspace>,
    capture: WorkspaceEngineCapture,
    references: readonly ChatFileReferenceInput[] | undefined,
  ) {
    const resolved: Array<{
      objectId: Awaited<ReturnType<WorkspaceEngineCapture["fileObjectIdForPath"]>> & string;
      pathHint: string;
      headingText?: string;
      headingAnchor?: string;
      headingOccurrence?: number;
    }> = [];
    const seen = new Set<string>();
    for (const reference of references ?? []) {
      const key = `${reference.path}\0${reference.headingAnchor ?? ""}\0${reference.headingOccurrence ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const trackedFile = await resolveTrackedChatFilePath(
        reference.path,
        capture.fileObjectIdForPath,
      );
      if (!trackedFile) {
        throw new Error(`Cannot mention ${reference.path} because dohc is not tracking it yet.`);
      }
      const { objectId, path: resolvedPath } = trackedFile;
      if (!reference.headingAnchor) {
        resolved.push({ objectId, pathHint: resolvedPath });
        continue;
      }
      const source = await readWorkspaceText(workspace.rootPath, resolvedPath);
      const heading = findWorkspaceHeading(extractWorkspaceHeadings(source.text), {
        anchor: reference.headingAnchor,
        occurrence: reference.headingOccurrence,
      });
      if (!heading) {
        throw new Error(
          `The heading #${reference.headingAnchor} no longer exists in ${resolvedPath}.`,
        );
      }
      resolved.push({
        objectId,
        pathHint: resolvedPath,
        headingText: heading.text,
        headingAnchor: heading.anchor,
        headingOccurrence: heading.occurrence,
      });
    }
    return resolved;
  }

  function chatBookmarkForIpc(bookmark: ChatBookmark) {
    return {
      bookmarkId: bookmark.bookmarkId,
      targetKind: bookmark.targetKind,
      targetId: bookmark.targetId,
      threadId: bookmark.threadId,
      ...(bookmark.messageId ? { messageId: bookmark.messageId } : {}),
      mode: bookmark.mode,
      destinationPath: bookmark.destinationPath,
      state: bookmark.state,
      projectionState: bookmark.projectionState,
      generation: bookmark.generation,
      createdAtMs: bookmark.createdAtMs,
      updatedAtMs: bookmark.updatedAtMs,
    };
  }

  function chatBookmarkDestination(title: string, targetId: string): string {
    const stem = title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 70) || "Chat";
    const suffix = targetId.replace(/[^a-z0-9_-]/giu, "").slice(-10) || "saved";
    return `Bookmarks/Chats/${stem}--${suffix}.md`;
  }

  function chatBookmarkArchiveDestination(bookmark: ChatBookmark): string {
    const name = basename(bookmark.destinationPath).replace(/\.md$/iu, "");
    // The archive generation is durable before projection starts, so this path
    // is unique across save/archive cycles and stable across crash retries.
    return `Bookmarks/Chats/Archived/${name}--g${bookmark.generation}.md`;
  }

  // Every projection/archive for one bookmark shares this queue. Capture
  // writes are serialized too, but callers can otherwise compute the same
  // missing destination before either write starts and race ready/failed
  // transitions for one generation.
  const chatBookmarkRuns = new Map<string, Promise<void>>();
  async function withChatBookmarkRun<T>(
    workspaceId: string,
    bookmarkId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = `${workspaceId}\u0000${bookmarkId}`;
    const previous = chatBookmarkRuns.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    chatBookmarkRuns.set(key, settled);
    try {
      return await result;
    } finally {
      if (chatBookmarkRuns.get(key) === settled) chatBookmarkRuns.delete(key);
    }
  }

  async function materializeChatBookmark(
    workspace: ReturnType<typeof requireWorkspace>,
    capture: WorkspaceEngineCapture,
    bookmark: ChatBookmark,
  ): Promise<ChatBookmark> {
    return withChatBookmarkRun(workspace.workspaceId, bookmark.bookmarkId, async () => {
      const store = linkedChatStoreFor(workspace);
      const current = await store.findBookmark({
        workspaceId: workspace.workspaceId,
        ownerUserId: bookmark.ownerUserId,
        bookmarkId: bookmark.bookmarkId,
      });
      if (!current) throw new Error("That bookmark no longer exists.");
      // A duplicate worker, a newer live generation, or an archive may have
      // won while this call waited for the bookmark queue.
      if (
        current.projectionState !== "pending" ||
        current.generation !== bookmark.generation
      ) {
        return current;
      }
      bookmark = current;
      try {
        if (bookmark.state === "archived") {
          const archivedPath = chatBookmarkArchiveDestination(bookmark);
          // Recovery validates the bookmark-specific frontmatter when legacy
          // state or a crash left projectionObjectId unclaimed. It can recover
          // from either side of an already-completed engine rename.
          const archived = await archiveChatBookmarkProjection({
            bookmark,
            archivedPath,
            capture,
          });
          const ready = await store.markBookmarkReady({
            workspaceId: workspace.workspaceId,
            ownerUserId: bookmark.ownerUserId,
            bookmarkId: bookmark.bookmarkId,
            generation: bookmark.generation,
            projectionObjectId: archived.objectId,
            // The store owns the logical active projection path. The capture
            // layer has already moved this exact object to archivedPath.
            projectionPath: bookmark.destinationPath,
          });
          return ready.bookmark;
        }
        const threads = await store.listThreads({ workspaceId: workspace.workspaceId });
        const thread = threads.find((entry) => entry.id === bookmark.threadId);
        if (!thread) throw new Error("The source chat no longer exists.");
        const allMessages = await store.listMessages({
          workspaceId: workspace.workspaceId,
          threadId: bookmark.threadId,
        });
        let selectedMessages = allMessages;
        if (bookmark.messageId) {
          const selected = allMessages.find((message) => message.id === bookmark.messageId);
          if (!selected) throw new Error("The bookmarked message no longer exists.");
          const parent = selected.parentMessageId
            ? allMessages.find((message) => message.id === selected.parentMessageId)
            : undefined;
          selectedMessages = parent ? [parent, selected] : [selected];
        }
        const channel = thread.channelId
          ? (await store.listChannels({ workspaceId: workspace.workspaceId })).find(
              (entry) => entry.id === thread.channelId,
            )
          : undefined;
        const text = formatChatBookmarkProjection({
          bookmarkId: bookmark.bookmarkId,
          threadId: bookmark.threadId,
          ...(bookmark.messageId ? { messageId: bookmark.messageId } : {}),
          ...(channel ? { channelId: channel.id, channelName: channel.name } : {}),
          title: thread.title,
          mode: bookmark.mode,
          updatedAtMs: Date.now(),
          ...(bookmark.mode === "snapshot" ? { snapshotAtMs: bookmark.createdAtMs } : {}),
          messages: selectedMessages.map((message) => ({
            id: message.id,
            authorKind: message.author.kind,
            authorDisplayName: message.author.displayName,
            body: message.body,
            createdAtMs: message.createdAtMs,
            ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
          })),
        });
        const written = await writeChatBookmarkProjection({
          bookmark,
          text,
          capture,
        });
        const ready = await store.markBookmarkReady({
          workspaceId: workspace.workspaceId,
          ownerUserId: bookmark.ownerUserId,
          bookmarkId: bookmark.bookmarkId,
          generation: bookmark.generation,
          projectionObjectId: written.objectId,
          projectionPath: bookmark.destinationPath,
        });
        return ready.bookmark;
      } catch (error) {
        const failed = await store.markBookmarkFailed({
          workspaceId: workspace.workspaceId,
          ownerUserId: bookmark.ownerUserId,
          bookmarkId: bookmark.bookmarkId,
          generation: bookmark.generation,
          failureReason: error instanceof Error ? error.message : "Projection failed",
        });
        throw new Error(failed.bookmark.failureReason ?? "Could not save chat bookmark.");
      }
    });
  }

  async function materializePendingChatBookmarks(
    workspace: ReturnType<typeof requireWorkspace>,
    capture: WorkspaceEngineCapture,
  ): Promise<void> {
    // Personal chat state must always use the persisted cloud identity when
    // one exists. The renderer can reach this worker before the eager startup
    // warm completes, so wait here instead of briefly projecting under the
    // per-install signed-out fallback id.
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const pending = await store.listPendingBookmarks({
      workspaceId: workspace.workspaceId,
      ownerUserId: localUserId(),
      limit: 50,
    });
    for (const bookmark of pending) {
      await materializeChatBookmark(workspace, capture, bookmark).catch((error) => {
        console.error("[desktop] chat bookmark projection:", error);
      });
    }
  }

  // Relay engines are created outside this IPC-registration scope, while the
  // projection worker shares the bookmark serialization helpers above. Bridge
  // them once at startup; every caller still goes through the shared-view gate
  // in projectPendingChatBookmarksAfterPull.
  materializePendingChatBookmarksForWorkspace = async (workspaceId) => {
    const workspace = findWorkspace(workspaceId);
    const capture = activity.engineCaptureFor(workspaceId);
    if (!workspace || !capture) return;
    await materializePendingChatBookmarks(workspace, capture);
  };

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
      moments: page.moments.map((moment) =>
        engineMomentForIpc(moment, agentAuthorDisplayName),
      ),
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
      moment: moment ? engineMomentDetailForIpc(moment, agentAuthorDisplayName) : null,
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

  ipcMain.handle(CHANNELS.listChatFileMentions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatFileMentionsPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await syncWorkspaceSharedChannels(workspace.workspaceId);
    const objectId = await capture.fileObjectIdForPath(input.path);
    const store = linkedChatStoreFor(workspace);
    const mentions = await store.listFileMentions({
      workspaceId: workspace.workspaceId,
      ...(objectId ? { objectId } : { pathHint: input.path }),
    });
    const activeFiles = await activeEngineFileIndex(workspace);
    const mentionChannelWireIds = new Map(
      await Promise.all(
        [...new Set(mentions.flatMap((mention) => mention.channel ? [mention.channel.id] : []))]
          .map(async (channelId) => [
            channelId,
            await store.getChannelWireId({
              workspaceId: workspace.workspaceId,
              channelId,
            }),
          ] as const),
      ),
    );
    return ListChatFileMentionsResult.parse({
      mentions: mentions.flatMap((mention) => {
        const currentPath = resolveChatFileMentionPath({
          requestedObjectId: objectId,
          ...(mention.attachment.objectId
            ? { attachmentObjectId: mention.attachment.objectId }
            : {}),
          ...(mention.attachment.pathHint
            ? { attachmentPathHint: mention.attachment.pathHint }
            : {}),
          pathByObjectId: activeFiles.pathByObjectId,
        });
        if (!currentPath) return [];
        return [{
          attachment: chatAttachmentForIpc({
            ...mention.attachment,
            pathHint: currentPath,
          }),
          message: chatMessageForIpc(mention.message),
          thread: chatThreadForIpc(mention.thread),
          ...(mention.channel
            ? {
                channelId: mention.channel.id,
                ...(mentionChannelWireIds.get(mention.channel.id)
                  ? { channelWireId: mentionChannelWireIds.get(mention.channel.id)! }
                  : {}),
                channelName: mention.channel.name,
                channelSlug: mention.channel.slug,
                channelKind: mention.channel.kind,
              }
            : {}),
        }];
      }),
    });
  });

  ipcMain.handle(CHANNELS.listChatBookmarks, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatBookmarksPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await warmCredentialCache();
    const bookmarks = await linkedChatStoreFor(workspace).listBookmarks({
      workspaceId: workspace.workspaceId,
      ownerUserId: localUserId(),
    });
    return ListChatBookmarksResult.parse({
      bookmarks: bookmarks.map(chatBookmarkForIpc),
    });
  });

  ipcMain.handle(CHANNELS.saveChatBookmark, async (event, payload) => {
    assertTrustedSender(event);
    const input = SaveChatBookmarkPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const threads = await store.listThreads({ workspaceId: workspace.workspaceId });
    const thread = threads.find((entry) => entry.id === input.target.threadId);
    if (!thread) throw new Error("That chat is no longer available.");
    if (input.target.kind === "message") {
      const messageId = input.target.messageId;
      const messages = await store.listMessages({
        workspaceId: workspace.workspaceId,
        threadId: input.target.threadId,
      });
      if (!messages.some((message) => message.id === messageId)) {
        throw new Error("That message is no longer available.");
      }
    }
    const targetId =
      input.target.kind === "message"
        ? input.target.messageId
        : input.target.threadId;
    const saved = await store.saveBookmark({
      workspaceId: workspace.workspaceId,
      ownerUserId: localUserId(),
      targetKind: input.target.kind,
      targetId,
      mode: input.mode,
      destinationPath: chatBookmarkDestination(thread.title, targetId),
    });
    const bookmark = await materializeChatBookmark(workspace, capture, saved);
    notifyRenderer();
    return SaveChatBookmarkResult.parse({ bookmark: chatBookmarkForIpc(bookmark) });
  });

  ipcMain.handle(CHANNELS.archiveChatBookmark, async (event, payload) => {
    assertTrustedSender(event);
    const input = ArchiveChatBookmarkPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const ownerUserId = localUserId();
    const archived = await withChatBookmarkRun(
      workspace.workspaceId,
      input.bookmarkId,
      async () => {
        const store = linkedChatStoreFor(workspace);
        const bookmark = await store.findBookmark({
          workspaceId: workspace.workspaceId,
          ownerUserId,
          bookmarkId: input.bookmarkId,
        });
        if (!bookmark) throw new Error("That bookmark no longer exists.");
        return store.archiveBookmark({
          workspaceId: workspace.workspaceId,
          ownerUserId,
          bookmarkId: input.bookmarkId,
        });
      },
    );
    const projected = await materializeChatBookmark(workspace, capture, archived);
    notifyRenderer();
    return ArchiveChatBookmarkResult.parse({
      bookmark: chatBookmarkForIpc(projected),
    });
  });

  ipcMain.handle(CHANNELS.createFileChat, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateFileChatPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
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
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    // Shared-channel access is narrower than workspace access. Enforce the
    // workspace's server-owned read-only boundary first; renderer UI state is
    // never authorization.
    assertWritableWorkspace(workspace);
    // MU-C4 (CodeRabbit security): a READ-ONLY shared-channel grant rejects
    // writes at the main boundary, BEFORE any durable local row — the
    // renderer disabling its composer is honesty, not authorization.
    await assertSharedChannelWritable({
      workspaceId: workspace.workspaceId,
      sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
      store: linkedChatStoreFor(workspace),
      target: { threadId: input.threadId },
    });
    // WS-MU-C0: the credential cache must be warm BEFORE relayAuthorUserId()
    // reads it — a send racing an unfinished async cache load would otherwise
    // stamp solo (authorUserId omitted) and lose relay provenance for a
    // signed-in user's message. warmCredentialCache is idempotent.
    await warmCredentialCache();
    const attachments = await resolveChatFileReferences(
      workspace,
      capture,
      input.fileReferences,
    );
    // Author is derived HERE: renderer-sent messages are always the local
    // human user. Agent authorship arrives through agent tooling, never
    // through this channel.
    const message = await linkedChatStoreFor(workspace).sendMessage({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
      author: { kind: "human", displayName: localUserDisplayName() },
      // WS-MU-C0: stamp the verified relay identity when signed in (the relay
      // checks it === actor.userId); omit it solo. Identity is main-derived,
      // never renderer-supplied.
      authorUserId: relayAuthorUserId(),
      ...(input.parentMessageId
        ? { parentMessageId: input.parentMessageId }
        : {}),
      body: input.body,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    void materializePendingChatBookmarks(workspace, capture).catch((error) => {
      console.error("[desktop] chat bookmark projection:", error);
    });
    // MU-C4: if this thread lives in a joined shared channel, push it out
    // promptly (fire-and-forget; the sync cadence is the backstop).
    void syncWorkspaceSharedChannels(workspace.workspaceId);
    activity.queueCloudSync(workspace.workspaceId);
    void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
      console.error("[desktop] local chat dispatch scan:", error);
    });
    return SendChatMessageResult.parse({ message: chatMessageForIpc(message) });
  });

  ipcMain.handle(CHANNELS.listChatThreadDecisions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatThreadDecisionsPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const decisions = await linkedChatStoreFor(workspace).listThreadDecisions(
      workspace.workspaceId,
      input.threadId,
    );
    return ListChatThreadDecisionsResult.parse({
      decisions: decisions.map((decision) => ({
        threadId: decision.threadId,
        messageId: decision.messageId,
        state: decision.state,
        ...(decision.resolvedByMessageId
          ? { resolvedByMessageId: decision.resolvedByMessageId }
          : {}),
        atMs: decision.atMs,
      })),
    });
  });

  ipcMain.handle(CHANNELS.resolveChatDecision, async (event, payload) => {
    assertTrustedSender(event);
    const input = ResolveChatDecisionPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
    const store = linkedChatStoreFor(workspace);
    await assertSharedChannelWritable({
      workspaceId: workspace.workspaceId,
      sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
      store,
      target: { threadId: input.threadId },
    });
    const decision = await store.resolveChatDecision({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
      messageId: input.messageId,
      resolvedByMessageId: input.resolvedByMessageId,
    });
    void syncWorkspaceSharedChannels(workspace.workspaceId);
    activity.queueCloudSync(workspace.workspaceId);
    return ResolveChatDecisionResult.parse({
      decision: {
        threadId: decision.threadId,
        messageId: decision.messageId,
        state: decision.state,
        ...(decision.resolvedByMessageId
          ? { resolvedByMessageId: decision.resolvedByMessageId }
          : {}),
        atMs: decision.atMs,
      },
    });
  });

  ipcMain.handle(CHANNELS.listChatThreadAttachments, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatThreadAttachmentsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const attachments = await linkedChatStoreFor(workspace).listThreadAttachments(
      workspace.workspaceId,
      input.threadId,
    );
    return ListChatThreadAttachmentsResult.parse({ attachments });
  });

  ipcMain.handle(CHANNELS.chatRunRecordsForThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = ChatRunRecordsForThreadPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const linkedChatStore = linkedChatStoreFor(workspace);
    await linkedChatStore.ensureOpen();
    const dispatchStore = agentDispatchStoreHandleFor(workspace).store;
    const found = await dispatchStore.runRecordsForThread(
      workspace.workspaceId,
      input.threadId,
      { limit: 200 },
    );
    const runs = Object.fromEntries(
      Object.entries(found).map(([messageId, run]) => [
        messageId,
        {
          runId: run.runId,
          threadId: run.threadId,
          triggerMessageId: run.triggerMessageId,
          command: run.command,
          startedAtMs: run.startedAtMs,
          ...(run.endedAtMs !== undefined
            ? { endedAtMs: run.endedAtMs }
            : {}),
          ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
          ...(run.logPath ? { logPath: run.logPath } : {}),
        },
      ]),
    );
    return ChatRunRecordsForThreadResult.parse({ runs });
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
      openDecisionCount: summary.openDecisionCount,
      openingMessage: summary.openingMessage
        ? {
            id: summary.openingMessage.id,
            authorKind: summary.openingMessage.author.kind,
            authorDisplayName: summary.openingMessage.author.displayName,
            createdAtMs: summary.openingMessage.createdAtMs,
            bodySnippet: summary.openingMessage.bodySnippet,
            reactions: summary.openingMessage.reactions.map(chatReactionForIpc),
          }
        : null,
    };
  }

  ipcMain.handle(CHANNELS.listChatChannels, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    // MU-C4: refresh joined shared channels BEFORE reading, so opening Chats
    // shows other members' latest messages. Never throws; offline it returns
    // fast and the local rows answer.
    await syncWorkspaceSharedChannels(workspace.workspaceId);
    const store = linkedChatStoreFor(workspace);
    // First chat use auto-creates General only for an owned workspace. Merely
    // listing a shared view is read-only and must not seed durable state.
    const channels = await listChatChannelsReadOnlySafe({
      readOnly: Boolean(sharedViewOf(workspace.workspaceId)),
      seedGeneral: async () => {
        await store.ensureGeneralChannel({ workspaceId: workspace.workspaceId });
      },
      list: () => store.listChannels({ workspaceId: workspace.workspaceId }),
    });
    // Wire identities let the renderer match channels against share grants.
    const wireIdEntries = await Promise.all(
      channels.map(async (channel) => [
        channel.id,
        await store
          .getChannelWireId({ workspaceId: workspace.workspaceId, channelId: channel.id })
          .catch(() => null),
      ] as const),
    );
    const wireIds = new Map(wireIdEntries);
    // The "Files" grouping: file-linked Chats with their CURRENT path (the
    // stable object id resolved through the active version), falling back to
    // the captured hint when the engine no longer owns the file.
    const threads = await store.listThreads({ workspaceId: workspace.workspaceId });
    const fileThreads = threads.filter((thread) => thread.linkedFile);
    let pathByObjectId = new Map<string, string>();
    if (fileThreads.length > 0) {
      try {
        const index = await engineSearchIndexFor(workspace);
        if (index) {
          pathByObjectId = new Map(
            index.files.map((file) => [file.objectId, file.path]),
          );
        }
      } catch {
        // Path resolution is display-only; the hint fallback keeps the
        // listing honest enough.
      }
    }
    return ListChatChannelsResult.parse({
      channels: channels.map((channel) => ({
        ...chatChannelForIpc(channel),
        wireId: wireIds.get(channel.id) ?? null,
      })),
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

  function chatFollowForIpc(follow: {
    targetKind: "person" | "agent" | "channel" | "thread";
    targetId: string;
    state: "following" | "unfollowed";
    updatedAtMs: number;
  }) {
    return {
      targetKind: follow.targetKind,
      targetId: follow.targetId,
      state: follow.state,
      updatedAtMs: follow.updatedAtMs,
    };
  }

  ipcMain.handle(CHANNELS.listChatFollows, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatFollowsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const ownerUserId = localUserId();
    const follows = await listChatFollowsReadOnlySafe({
      readOnly: Boolean(sharedViewOf(workspace.workspaceId)),
      seedDefaults: () => store.ensureDefaultChannelFollows({
        workspaceId: workspace.workspaceId,
        ownerUserId,
      }),
      list: () => store.listFollows({
        workspaceId: workspace.workspaceId,
        ownerUserId,
      }),
    });
    return ListChatFollowsResult.parse({ follows: follows.map(chatFollowForIpc) });
  });

  ipcMain.handle(CHANNELS.setChatFollow, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetChatFollowPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    let targetKind: "person" | "agent" | "channel" | "thread";
    let targetId: string;
    if (input.target.kind === "channel") {
      targetKind = "channel";
      const wireId = await store.getChannelWireId({
        workspaceId: workspace.workspaceId,
        channelId: input.target.channelId,
      });
      if (!wireId) throw new Error("That channel is not available to follow.");
      targetId = wireId;
    } else if (input.target.kind === "thread") {
      targetKind = "thread";
      targetId = input.target.threadId;
    } else {
      const authorTarget = input.target;
      const messages = await store.listMessages({
        workspaceId: workspace.workspaceId,
        threadId: authorTarget.threadId,
      });
      const message = messages.find((entry) => entry.id === authorTarget.messageId);
      if (!message?.authorUserId) {
        throw new Error("That author cannot be followed until their identity is verified.");
      }
      targetKind = message.author.kind === "agent" ? "agent" : "person";
      targetId = message.authorUserId;
    }
    const ownerUserId = localUserId();
    const replicationOwnerUserId = relayAuthorUserId();
    const follow = await store.setFollow({
      workspaceId: workspace.workspaceId,
      ownerUserId,
      ...(replicationOwnerUserId ? { replicationOwnerUserId } : {}),
      targetKind,
      targetId,
      state: input.state,
    });
    if (replicationOwnerUserId) activity.queueCloudSync(workspace.workspaceId);
    notifyRenderer();
    return SetChatFollowResult.parse({ follow: chatFollowForIpc(follow) });
  });

  ipcMain.handle(CHANNELS.listPersonalChatFeed, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListPersonalChatFeedPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await warmCredentialCache();
    await syncWorkspaceSharedChannels(workspace.workspaceId);
    const store = linkedChatStoreFor(workspace);
    const ownerUserId = localUserId();
    if (!sharedViewOf(workspace.workspaceId)) {
      await store.ensureDefaultChannelFollows({
        workspaceId: workspace.workspaceId,
        ownerUserId,
      });
    }
    const page = await store.listPersonalFeed({
      workspaceId: workspace.workspaceId,
      ownerUserId,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    const feedChannelWireIds = new Map(
      await Promise.all(
        [...new Set(page.items.flatMap((item) => item.channel ? [item.channel.id] : []))]
          .map(async (channelId) => [
            channelId,
            await store.getChannelWireId({
              workspaceId: workspace.workspaceId,
              channelId,
            }),
          ] as const),
      ),
    );
    return ListPersonalChatFeedResult.parse({
      items: page.items.map((item) => ({
        message: chatMessageForIpc(item.message),
        thread: chatThreadForIpc(item.thread),
        ...(item.message.authorUserId
          ? {
              authorFollowTarget: {
                targetKind:
                  item.message.author.kind === "agent" ? ("agent" as const) : ("person" as const),
                targetId: item.message.authorUserId,
              },
            }
          : {}),
        ...(item.channel
          ? {
              channel: {
                id: item.channel.id,
                ...(feedChannelWireIds.get(item.channel.id)
                  ? { wireId: feedChannelWireIds.get(item.channel.id)! }
                  : {}),
                name: item.channel.name,
                slug: item.channel.slug,
                kind: item.channel.kind,
              },
            }
          : {}),
        ...(item.parentMessage
          ? { parentMessage: chatMessageForIpc(item.parentMessage) }
          : {}),
        ...(item.openingMessage
          ? { openingMessage: chatMessageForIpc(item.openingMessage) }
          : {}),
        reactions: item.reactions.map(chatReactionForIpc),
        matchedBy: item.matchedBy,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(page.headCursor ? { headCursor: page.headCursor } : {}),
    });
  });

  ipcMain.handle(
    CHANNELS.markPersonalChatFeedSeen,
    createReadAwareChatIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => MarkPersonalChatFeedSeenPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats are not enabled for this workspace."),
      isReadOnly: (workspace) => Boolean(sharedViewOf(workspace.workspaceId)),
      run: async ({ workspace }, input, readOnly) => {
        await markPersonalFeedSeenReadOnlySafe({
          readOnly,
          mark: async () => {
            await warmCredentialCache();
            const ownerUserId = localUserId();
            const replicationOwnerUserId = relayAuthorUserId();
            await linkedChatStoreFor(workspace).markPersonalFeedSeen({
              workspaceId: workspace.workspaceId,
              ownerUserId,
              ...(replicationOwnerUserId ? { replicationOwnerUserId } : {}),
              headCursor: input.headCursor,
            });
            if (replicationOwnerUserId) activity.queueCloudSync(workspace.workspaceId);
          },
        });
      },
    }),
  );

  ipcMain.handle(
    CHANNELS.createChatChannel,
    createChatChannelIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => CreateChatChannelPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats are not enabled for this workspace."),
      assertWritableWorkspace,
      run: async ({ workspace }, input) => {
        const channel = await linkedChatStoreFor(workspace).createChannel({
          workspaceId: workspace.workspaceId,
          name: input.name,
          kind: "channel",
        });
        return CreateChatChannelResult.parse({
          // A locally created channel's wire identity is its own id.
          channel: {
            ...chatChannelForIpc({ ...channel, threadCount: 0, unreadCount: 0 }),
            wireId: channel.id,
          },
        });
      },
      queueCloudSync: (workspaceId) => activity.queueCloudSync(workspaceId),
    }),
  );

  ipcMain.handle(CHANNELS.listChannelThreads, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChannelThreadsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await warmCredentialCache();
    const threads = await linkedChatStoreFor(workspace).listChannelThreads({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
    });
    return ListChannelThreadsResult.parse({
      threads: threads.map(channelThreadForIpc),
      viewerAuthorId: localUserId(),
    });
  });

  ipcMain.handle(CHANNELS.startChannelThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartChannelThreadPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    assertWritableWorkspace(workspace);
    // MU-C4 (CodeRabbit security): read-only shared channels reject the
    // composer at the main boundary, before any durable row.
    await assertSharedChannelWritable({
      workspaceId: workspace.workspaceId,
      sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
      store: linkedChatStoreFor(workspace),
      target: { channelId: input.channelId },
    });
    // WS-MU-C0: warm the credential cache before relayAuthorUserId() reads it,
    // so a thread opened before the async cache load finishes still stamps the
    // signed-in author (never falsely solo). Idempotent.
    await warmCredentialCache();
    const attachments = await resolveChatFileReferences(
      workspace,
      capture,
      input.fileReferences,
    );
    // No title, ever, on this path: the thread displays its first-message
    // snippet. Author is main-derived like every renderer send.
    const started = await linkedChatStoreFor(workspace).startChannelThread({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
      author: { kind: "human", displayName: localUserDisplayName() },
      // WS-MU-C0: stamp the verified relay identity when signed in; omit solo.
      authorUserId: relayAuthorUserId(),
      body: input.body,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    void materializePendingChatBookmarks(workspace, capture).catch((error) => {
      console.error("[desktop] chat bookmark projection:", error);
    });
    void syncWorkspaceSharedChannels(workspace.workspaceId);
    activity.queueCloudSync(workspace.workspaceId);
    void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
      console.error("[desktop] local chat dispatch scan:", error);
    });
    return StartChannelThreadResult.parse({
      thread: channelThreadForIpc({
        thread: started.thread,
        messageCount: 1,
        lastReadSequence: 1,
        unreadCount: 0,
        openDecisionCount: 0,
      }),
      message: chatMessageForIpc(started.message),
    });
  });

  ipcMain.handle(
    CHANNELS.markChatThreadRead,
    createSharedChannelWritableChatIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => MarkChatThreadReadPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats are not enabled for this workspace."),
      assertWritableWorkspace,
      assertSharedChannelWritable: async ({ workspace }, input) => {
        await assertSharedChannelWritable({
          workspaceId: workspace.workspaceId,
          sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
          store: linkedChatStoreFor(workspace),
          target: { threadId: input.threadId },
        });
      },
      run: async ({ workspace }, input) => {
        const state = await linkedChatStoreFor(workspace).markThreadRead({
          workspaceId: workspace.workspaceId,
          threadId: input.threadId,
          upToSequence: input.upToSequence,
        });
        return MarkChatThreadReadResult.parse({
          lastReadSequence: state.lastReadSequence,
          revision: state.revision,
        });
      },
    }),
  );

  // --- Reactions (WS-MU-C2) ------------------------------------------------
  // Durable, commutative emoji reactions. Identity is main-derived: the viewer
  // reacts as the local user (never renderer-supplied), so a reaction is an
  // authored act attributable and, once syncing, relay-verifiable.
  function chatReactionForIpc(reaction: ChatReaction) {
    return {
      reactionId: reaction.reactionId,
      messageId: reaction.messageId,
      threadId: reaction.threadId,
      emoji: reaction.emoji,
      authorId: reaction.author.authorId,
      authorKind: reaction.author.kind,
      authorDisplayName: reaction.author.displayName,
    };
  }

  ipcMain.handle(CHANNELS.listChatReactions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatReactionsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await warmCredentialCache();
    const reactions = await linkedChatStoreFor(workspace).listReactions({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return ListChatReactionsResult.parse({
      reactions: reactions.map(chatReactionForIpc),
      viewerAuthorId: localUserId(),
    });
  });

  ipcMain.handle(
    CHANNELS.setChatReaction,
    createSetChatReactionIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => SetChatReactionPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats are not enabled for this workspace."),
      assertWritableWorkspace,
      run: async ({ workspace }, input) => {
        await warmCredentialCache();
        // MU-C4 (CodeRabbit security): reactions are writes too — a read-only
        // shared channel rejects them before any durable row.
        await assertSharedChannelWritable({
          workspaceId: workspace.workspaceId,
          sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
          store: linkedChatStoreFor(workspace),
          target: { threadId: input.threadId },
        });
        const reaction = await linkedChatStoreFor(workspace).setReaction({
          workspaceId: workspace.workspaceId,
          threadId: input.threadId,
          messageId: input.messageId,
          emoji: input.emoji,
          author: {
            authorId: localUserId(),
            kind: "human",
            displayName: localUserDisplayName(),
          },
          state: input.state,
        });
        return SetChatReactionResult.parse({
          reaction: { ...chatReactionForIpc(reaction), state: reaction.state },
          viewerAuthorId: localUserId(),
        });
      },
      // MU-C4: reactions in a joined shared channel push out promptly too.
      syncJoinedChannels: (workspaceId) => {
        void syncWorkspaceSharedChannels(workspaceId);
      },
      // Reactions are journaled workspace mutations just like messages and
      // decision changes, so the owner's cloud workspace is nudged too.
      queueCloudSync: (workspaceId) => activity.queueCloudSync(workspaceId),
    }),
  );

  // --- Direct messages (WS-MU-C3) ------------------------------------------
  // A DM is a `kind:"dm"` channel plus one MU-C4 chat-channel grant per
  // participant, riding the shared-channel lane. The whole surface is gated on
  // collaboration: signed out / no relay ⇒ available:false and the renderer
  // shows nothing. Authorization lives at the relay — everything here is
  // orchestration (born-shared auto-grant / auto-join) + display.

  // The relay connection DMs ride, or null when collaboration is off.
  function dmRelayConnection(): SyncRelayConnection | null {
    if (!cachedCredentials?.relayUrl) return null;
    return {
      baseUrl: normalizeServerUrl(cachedCredentials.relayUrl),
      token: cachedCredentials.token,
      fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
    };
  }

  function dmRecordForIpc(dm: DmRecordInfo) {
    return {
      channelId: dm.channelId,
      channelWireId: dm.channelWireId,
      name: dm.name,
      peerLabel: dm.peerLabel,
      role: dm.role,
      shareId: dm.shareId,
      threadId: dm.threadId,
      unreadCount: dm.unreadCount,
      connected: dm.connected,
    };
  }

  // The account-level DM homing map file (spans every workspace) — lives in the
  // account/user data dir, never a single workspace's engine db.
  function dmHomeFile(): string {
    return join(stateDir(), "dohc-dm-homes.json");
  }

  // Received chat-channel shares whose authoritative channel.create was
  // observed with the ordinary "channel" kind. Cached so a manual-join invite
  // is probed once, while an empty/unbootstrapped log remains retryable: the relay
  // can expose the grant before the owner's channel bootstrap ops arrive.
  const peekedNonDmShareIds = new Set<string>();

  // Peek a received chat-channel grant's kind WITHOUT mutating the local store:
  // only `kind:"dm"` grants auto-join — a regular shared-channel grant is left
  // to explicit manual join. The share-log GET paginates RAW rows before the
  // share filter, so the peek must PAGE through nextCursor until the first
  // served op (the channel.create bootstrap) appears — reading only the first
  // page is a permanent false negative on any log with an earlier filtered op
  // (e.g. workspace.init). Paging + capping lives in peekReceivedGrantKind.
  function peekReceivedGrantKindForShare(
    relay: SyncRelayConnection,
    shareId: string,
  ): Promise<DmPeekResult> {
    const base = relay.baseUrl.replace(/\/+$/u, "");
    return peekReceivedGrantKind({
      fetchPage: async (since) => {
        const response = await (relay.fetch ?? fetch)(
          `${base}/sync/shares/${encodeURIComponent(shareId)}/log?since=${since}&limit=200`,
          { headers: { authorization: `Bearer ${relay.token}` } },
        );
        if (!response.ok) return null;
        return (await response.json().catch(() => null)) as ShareLogPage | null;
      },
    });
  }

  // Auto-join every received DM grant not yet joined: pull the share's log into
  // this workspace's own chat store and register it in the shared-channel
  // registry (the SAME rows manual joins use), so subsequent passes sync it
  // bidirectionally through `syncWorkspaceSharedChannels`. Regular shared
  // channels are skipped — they stay manual-join.
  async function autoJoinReceivedDms(
    workspace: { workspaceId: string; rootPath: string },
    relay: SyncRelayConnection,
  ): Promise<void> {
    const relayUrl = cachedCredentials?.relayUrl;
    if (!relayUrl) return;
    const listing = await relayShareJson<{
      received?: Array<{
        shareId?: unknown;
        selector?: { kind?: unknown; channelWireId?: unknown };
      }>;
    }>("/sync/shares");
    for (const row of listing.received ?? []) {
      const shareId = typeof row.shareId === "string" ? row.shareId : null;
      const selector = row.selector;
      if (!shareId || selector?.kind !== "chat-channel") continue;
      if (typeof selector.channelWireId !== "string" || selector.channelWireId.length === 0) {
        continue;
      }
      const existing = findWorkspace(workspace.workspaceId)?.sharedChannels ?? [];
      if (
        existing.some(
          (channel) =>
            channel.shareId === shareId || channel.channelWireId === selector.channelWireId,
        )
      ) {
        continue;
      }
      // Probe each received share AT MOST ONCE (CodeRabbit: unbounded relay
      // round-trips). Skip without a network peek when it is either already
      // confirmed non-DM, or a DM homed in ANOTHER workspace (cross-workspace
      // scoping — a received DM is ACCOUNT-wide, so pin it to exactly one local
      // workspace).
      if (peekedNonDmShareIds.has(shareId)) continue;
      const homedIn = readDmHome(dmHomeFile(), shareId);
      if (homedIn && homedIn !== workspace.workspaceId) continue;
      try {
        const kind = await peekReceivedGrantKindForShare(relay, shareId);
        if (kind === "not-dm") {
          // Definitive (a channel kind never changes) — never re-probe.
          peekedNonDmShareIds.add(shareId);
          continue;
        }
        // Transient failure: leave un-cached and retry on the next pass.
        if (kind !== "dm") continue;
        // The DM peek confirmed it — claim it here (or confirm this is home).
        if (!claimDmHome(dmHomeFile(), shareId, workspace.workspaceId)) continue;
        const info = await fetchSharedChannelInfo({ relay, shareId });
        const daemonRelay = relayClientForWorkspace({
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          relay,
        });
        const pulled = await daemonRelay.pullSharedChannel({
          shareId: info.shareId,
          channelWireId: info.channelWireId,
        });
        if (pulled.applied > 0) {
          await projectPendingChatBookmarksAfterPull(workspace.workspaceId);
        }
        const joined: JoinedSharedChannel = {
          shareId: info.shareId,
          channelWireId: info.channelWireId,
          access: info.access,
          granterEmail: info.granterEmail,
          relayUrl,
        };
        setWorkspaceSharedChannels(
          workspace.workspaceId,
          mergeJoinedChannel(
            findWorkspace(workspace.workspaceId)?.sharedChannels ?? [],
            joined,
          ),
        );
      } catch (error) {
        // A share revoked between the listing and the fetch surfaces as
        // unavailable — skip it; the next pass reconciles. Never blocks the
        // other grants.
        if (error instanceof ShareUnavailableError) continue;
        throw error;
      }
    }
  }

  // Reconcile DM state with the relay and return the workspace's DM list.
  // Called by the renderer on Chats mount + a gentle poll while visible; the
  // network part degrades silently offline (local list still serves).
  ipcMain.handle(
    CHANNELS.syncDms,
    createReadAwareChatIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => SyncDmsPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats are not enabled for this workspace."),
      isReadOnly: (workspace) => Boolean(sharedViewOf(workspace.workspaceId)),
      run: async ({ workspace }, _input, readOnly) => {
        await warmCredentialCache();
        const relay = dmRelayConnection();
        const store = linkedChatStoreFor(workspace);
        // The read-shaped DM refresh can auto-join grants and push journal ops.
        // Shared views may list their existing local rows, but never run those
        // durable reconciliation steps.
        if (relay && !readOnly) {
          try {
            // Born-shared auto-join: discover + join received DM grants.
            await autoJoinReceivedDms(workspace, relay);
            // Push the member's local ops, pull everyone else's, for every joined
            // DM (and any other joined shared channel).
            await syncWorkspaceSharedChannels(workspace.workspaceId);
            // Owner-side liveness: members' ops land in THIS workspace's own relay
            // bucket; nudge the (debounced) sync engine so they arrive without
            // waiting for an unrelated file edit. No-op when the workspace has no
            // cloud engine.
            activity.queueCloudSync(workspace.workspaceId);
          } catch (error) {
            // Offline degradation: never a crash, never a blocked Chats view — the
            // local DM list still serves and the next pass retries.
            console.error(`[desktop] DM sync failed for ${workspace.rootPath}:`, error);
          }
        }
        const dms = await listDmRecords({
          workspaceId: workspace.workspaceId,
          store,
          sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels ?? [],
        });
        return SyncDmsResult.parse({ available: relay !== null, dms: dms.map(dmRecordForIpc) });
      },
    }),
  );

  // Start (or continue) a DM: dedupe by recipient set, ensure one live grant
  // per recipient, and send the first message into the single running thread.
  ipcMain.handle(CHANNELS.startDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartDmPayload.parse(payload);
    // A DM needs the full collaboration surface: a signed-in relay session AND
    // a synced workspace — the DM's canonical log is this workspace's relay
    // bucket, so an unsynced workspace could never deliver it.
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
    const { remote } = await remoteForWorkspace(input.workspaceId);
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    await warmCredentialCache();
    const relay = dmRelayConnection();
    const authorUserId = relayAuthorUserId();
    if (!relay || !authorUserId) {
      throw new Error("Sign in to dohc Cloud to start a direct message.");
    }
    const recipients = parseDmRecipients(input.recipients);
    const selfEmail = cachedCredentials?.email?.toLowerCase();
    if (selfEmail && recipients.includes(selfEmail)) {
      throw new Error("A direct message needs a recipient other than yourself.");
    }
    // Resolve mentions before creating/granting a DM so an invalid or stale
    // heading cannot leave behind a partially initialized conversation.
    const attachments = await resolveChatFileReferences(
      workspace,
      capture,
      input.fileReferences,
    );
    const store = linkedChatStoreFor(workspace);
    // A DM's identity is its LIVE grant recipient set — NOT its (truncatable,
    // collidable) display name. Enumerate live chat-channel grants keyed by
    // wire id ONCE: used both to dedup the DM (exact recipient-set match) and
    // to compute which recipients still need a grant. The anti-enumeration
    // posture is the relay's: known and unknown emails create indistinguishable
    // grants.
    const shares = await relayShareJson<{
      granted?: Array<{
        recipientEmail?: string | null;
        revokedAtMs?: number | null;
        selector?: { kind?: string; channelWireId?: string };
      }>;
    }>("/sync/shares");
    const liveGrantEmailsByWire = new Map<string, Set<string>>();
    for (const row of shares.granted ?? []) {
      if (
        (row.revokedAtMs ?? null) !== null ||
        row.selector?.kind !== "chat-channel" ||
        typeof row.selector.channelWireId !== "string" ||
        typeof row.recipientEmail !== "string"
      ) {
        continue;
      }
      const wire = row.selector.channelWireId;
      const set = liveGrantEmailsByWire.get(wire) ?? new Set<string>();
      set.add(row.recipientEmail.toLowerCase());
      liveGrantEmailsByWire.set(wire, set);
    }
    // Starting a DM with a recipient set you already message opens the existing
    // one — matched by its live grant recipients, never by the display name.
    const dmChannelWires = await Promise.all(
      (await store.listChannels({ workspaceId: workspace.workspaceId }))
        .filter((channel) => channel.kind === "dm")
        .map(async (channel) => ({
          id: channel.id,
          wireId:
            (await store.getChannelWireId({
              workspaceId: workspace.workspaceId,
              channelId: channel.id,
            })) ?? channel.id,
        })),
    );
    const matchedId = matchDmChannelByRecipients({
      recipients,
      channels: dmChannelWires,
      liveGrantEmailsByWire,
    });
    const channelId =
      matchedId ??
      (
        await store.createChannel({
          workspaceId: workspace.workspaceId,
          name: dmChannelNameFor(recipients),
          kind: "dm",
        })
      ).id;
    const wireId =
      (await store.getChannelWireId({
        workspaceId: workspace.workspaceId,
        channelId,
      })) ?? channelId;
    // Ensure one LIVE grant per recipient (grants are rows; a re-run after a
    // revocation re-invites). A freshly created channel has no grants yet. The
    // grants are created ATOMICALLY: if any fails, grantDmRecipients revokes the
    // ones created in THIS call and rethrows, so no half-granted channel lingers
    // to be duplicated on retry (matchDmChannelByRecipients needs an EXACT set).
    // The first message is sent only AFTER this resolves, so a thrown rollback
    // means nothing was said yet; the orphaned channel (zero live grants, no
    // thread) is hidden by listDmRecords.
    const covered = liveGrantEmailsByWire.get(wireId) ?? new Set<string>();
    await grantDmRecipients({
      recipients,
      covered,
      // FLAT chat-channel grant body (matches shareChatChannel): the relay
      // branches on the top-level channelWireId. A nested chatChannel body
      // would fall through to the path-share validator and silently fail.
      createGrant: async (email) => {
        const created = await relayShareJson<{ shareId?: string }>(
          `/sync/${encodeURIComponent(remote.remoteWorkspaceId)}/shares`,
          {
            method: "POST",
            body: JSON.stringify({
              recipientEmail: email,
              channelWireId: wireId,
              access: "read-write",
            }),
          },
        );
        return typeof created.shareId === "string" ? created.shareId : null;
      },
      revokeGrant: async (shareId) => {
        await relayShareJson(`/sync/shares/${encodeURIComponent(shareId)}/revoke`, {
          method: "POST",
        });
      },
    });
    // The single running conversation (anti-forum): reuse the oldest thread or
    // start it with this first message. No titles, ever. runningThread is the
    // SAME canonical-thread rule listDmRecords uses (shared so they can't drift).
    const threads = await store.listChannelThreads({
      workspaceId: workspace.workspaceId,
      channelId,
    });
    const running = runningThread(threads);
    const author = { kind: "human" as const, displayName: localUserDisplayName() };
    const message = running
      ? await store.sendMessage({
          workspaceId: workspace.workspaceId,
          threadId: running.thread.id,
          author,
          authorUserId,
          body: input.body,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
      : (
          await store.startChannelThread({
            workspaceId: workspace.workspaceId,
            channelId,
            author,
            authorUserId,
            body: input.body,
            ...(attachments.length > 0 ? { attachments } : {}),
          })
        ).message;
    // Replicate promptly: the channel/thread/message ops are journaled but chat
    // writes never pass through the file watcher.
    activity.queueCloudSync(workspace.workspaceId);
    void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
      console.error("[desktop] local chat dispatch scan:", error);
    });
    const dm = (
      await listDmRecords({
        workspaceId: workspace.workspaceId,
        store,
        sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels ?? [],
      })
    ).find((candidate) => candidate.channelId === channelId);
    if (!dm) throw new Error("Could not start that direct message.");
    return StartDmResult.parse({
      dm: dmRecordForIpc(dm),
      message: chatMessageForIpc(message),
    });
  });

  // Ephemeral presence (MU-C5): the renderer NEVER receives the relay bearer
  // token — its presence transport calls presencePublish/presencePoll/
  // presenceCancel, and MAIN (the sole token holder) makes the actual relay
  // presence request. Scope is authorized HERE before the relay (which
  // re-authorizes from the bearer anyway): a workspace scope must be a synced
  // workspace this account owns; a share scope must be a grant this account has
  // joined. An unauthorized/unavailable scope returns null (renderer → dormant),
  // never a leak.
  //
  ipcMain.handle(CHANNELS.presencePublish, async (event, payload) => {
    assertTrustedSender(event);
    const input = PresencePublishPayload.parse(payload);
    try {
      // Scope resolution (warms the credential cache) runs INSIDE the try so a
      // throw degrades to the dormant "unavailable" result, never a rejected
      // IPC promise — presence is best-effort.
      const transport = await presenceRelayTransportForScope(input.scope);
      if (!transport) return PresenceResult.parse({ ok: false, reason: "unavailable" });
      if (input.leave === true) {
        await transport.leave({ topic: input.topic, clientId: input.clientId });
        // A leave has no snapshot to echo; report an empty one so the renderer
        // clears without treating it as a failure.
        return PresenceResult.parse({ ok: true, snapshot: { version: 0, peers: [] } });
      }
      const snapshot = await transport.publish({
        topic: input.topic,
        clientId: input.clientId,
        state: input.state ?? null,
      });
      return PresenceResult.parse({ ok: true, snapshot });
    } catch {
      // Presence is best-effort: a transient relay failure is "unavailable",
      // never a thrown IPC error.
      return PresenceResult.parse({ ok: false, reason: "unavailable" });
    }
  });

  ipcMain.handle(CHANNELS.presencePoll, async (event, payload) => {
    assertTrustedSender(event);
    const input = PresencePollPayload.parse(payload);
    // Register the controller BEFORE any await: scope resolution warms the
    // credential cache, and a presenceCancel arriving during that window must
    // abort THIS poll promptly (workspace-switch repaint), not wait out the 35s
    // safety cap. Ownership keys on (senderId + pollId) so only this window can
    // cancel it, and at most one poll runs per (sender, scope, topic).
    hookPresencePollCleanup(event.sender);
    const handle = presencePollRegistry.begin(
      event.sender.id,
      input.pollId,
      presenceScopeTopicKey(input.scope, input.topic),
    );
    // Safety timeout caps a hung relay (the hold is <=30s; give headroom then
    // abort) so the IPC invoke can never dangle forever.
    const safety = setTimeout(() => handle.abort(), PRESENCE_POLL_SAFETY_MS);
    try {
      const transport = await presenceRelayTransportForScope(input.scope);
      if (!transport) return PresenceResult.parse({ ok: false, reason: "unavailable" });
      // A cancel could have landed while scope was resolving.
      if (handle.signal.aborted) return PresenceResult.parse({ ok: false, reason: "aborted" });
      const snapshot = await transport.poll({
        topic: input.topic,
        since: input.since,
        signal: handle.signal,
      });
      return PresenceResult.parse({ ok: true, snapshot });
    } catch {
      // Aborted (cancel/switch/timeout) vs a relay error: both degrade to
      // dark, but "aborted" tells the renderer this was an intentional stop.
      return PresenceResult.parse({
        ok: false,
        reason: handle.signal.aborted ? "aborted" : "unavailable",
      });
    } finally {
      clearTimeout(safety);
      // Removes only THIS poll's entry — a superseding poll under the same id is
      // left untouched.
      handle.release();
    }
  });

  ipcMain.handle(CHANNELS.presenceCancel, (event, payload) => {
    assertTrustedSender(event);
    const input = PresenceCancelPayload.parse(payload);
    // Only aborts a poll THIS sender owns; a cancel for another window's pollId
    // is a no-op.
    presencePollRegistry.cancel(event.sender.id, input.pollId);
    return undefined;
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
    assertAgentRunnableWorkspace(workspace.workspaceId);
    assertChatRunnerIdle(workspace.workspaceId);
    await openWorkspaceActivity(workspace);
    return StartAgentRunResult.parse(await agentIntegration.startAgentRun(input.workspaceId));
  });

  ipcMain.handle(CHANNELS.endAgentRun, async (event, payload) => {
    assertTrustedSender(event);
    const input = EndAgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    // A driver-backed run owns a live session (a child process). Ending such
    // a run must go through the session manager so the child is actually
    // stopped and disposed — not just the run record closed (this stop used
    // to live on the retired Agent panel; Settings' stop lands here now).
    // stopSession finalizes the run through agentIntegration.endAgentRun
    // exactly once, so onRunEnded fires as before. No cached manager means
    // no session ever started — plain run-record end.
    const session = cachedAgentSessions?.panelSnapshot(input.workspaceId).session;
    if (
      cachedAgentSessions &&
      session?.runId === input.runId &&
      ["starting", "ready", "running", "waiting-permission"].includes(session.status)
    ) {
      // Keep the caller's explicit outcome (e.g. "failed") on the record.
      await cachedAgentSessions.stopSession(input.workspaceId, input.status);
      return;
    }
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
    // A shared view hands out the read-only MCP profile so the user's AI tool
    // can browse the shared files without any write tool existing.
    const readOnly = !!sharedViewOf(workspace.workspaceId);
    return McpConfigResult.parse(mcpConfigFor(workspace.rootPath, { readOnly }));
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

  ipcMain.handle(CHANNELS.answerAgentPermission, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentPermissionResponsePayload.parse(payload);
    requireWorkspace(input.workspaceId);
    const sessions = await agentSessionManager();
    return AgentPanelSnapshotResult.parse(await sessions.answerPermission(input));
  });

  ipcMain.handle(CHANNELS.stopAgentRun, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopAgentRunPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    await chatDispatchService.stopAgentRun(input.workspaceId);
  });

  ipcMain.handle(CHANNELS.chatDispatchStateForThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = ChatDispatchStateForThreadPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return ChatDispatchStateForThreadResult.parse(
      await chatDispatchService.dispatchStateForThread(
        input.workspaceId,
        input.threadId,
      ),
    );
  });

  ipcMain.handle(CHANNELS.resumeThreadDispatch, async (event, payload) => {
    assertTrustedSender(event);
    const input = ResumeThreadDispatchPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(workspace);
    await chatDispatchService.resumeThreadDispatch(
      input.workspaceId,
      input.threadId,
    );
  });

  ipcMain.handle(CHANNELS.runnerSelfTest, async (event, payload) => {
    assertTrustedSender(event);
    const input = RunnerSelfTestPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertAgentRunnableWorkspace(workspace.workspaceId);
    await openWorkspaceActivity(workspace);
    return RunnerSelfTestResult.parse(
      await chatDispatchService.runnerSelfTest(input.workspaceId),
    );
  });

  ipcMain.handle(CHANNELS.getUserSettings, async (event) => {
    assertTrustedSender(event);
    return DesktopUserSettingsResult.parse(
      await readCachedUserSettingsFile(stateDir()),
    );
  });

  ipcMain.handle(CHANNELS.setUserSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetUserSettingsPayload.parse(payload);
    await writeUserSettingsFile(stateDir(), input.settings);
    cachedPreferredName = input.settings.profile.preferredName;
    await refreshDispatchTray();
    if (input.settings.runner.enabled && input.settings.runner.command.trim()) {
      for (const workspace of openDispatchWorkspaces()) {
        void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
          console.error("[desktop] runner-settings dispatch scan:", error);
        });
      }
    }
    return DesktopUserSettingsResult.parse({
      settings: input.settings,
      source: "stored",
    });
  });

  ipcMain.handle(CHANNELS.resetUserSettings, async (event) => {
    assertTrustedSender(event);
    await writeUserSettingsFile(stateDir(), DEFAULT_USER_SETTINGS);
    cachedPreferredName = undefined;
    await refreshDispatchTray();
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
    const generation = rendererGeneration(sender.id);
    latestSearchIdBySender.set(sender.id, input.searchId);
    const isCurrentSearch = () =>
      !sender.isDestroyed() &&
      rendererGeneration(sender.id) === generation &&
      latestSearchIdBySender.get(sender.id) === input.searchId;
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
          if (isCurrentSearch()) {
            sender.send(
              CHANNELS.searchResults,
              SearchResultsEventSchema.parse({
                searchId: input.searchId,
                entries: [],
                done: true,
                limitHit: false,
                // Surface WHY the results are empty instead of a silent blank:
                // the workspace policy file could not be applied, so search
                // fails closed until it is fixed.
                notice: `Search paused: workspace policy could not be applied — ${decision.message}`.slice(
                  0,
                  500,
                ),
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
        // The engine index deliberately excludes shared-with-me (host
        // capture ignores mounts), so mounted content searches through the
        // rg path, streamed AFTER the engine results under the SAME
        // searchId. Skipped when the workspace has no mounts.
        const mounts = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
        const searchMounts = mounts.length > 0;
        if (isCurrentSearch()) {
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
              done: !searchMounts,
              limitHit: false,
            }),
          );
        }
        if (searchMounts) {
          // Stale-search guard: a newer query may have started its own
          // mount pass while this handler awaited the engine phase — the
          // registry's kill-and-replace must never let the OLDER search
          // cancel it. (The renderer already drops stale batches by id.)
          if (!isCurrentSearch()) return;
          // rg include globs are gitignore-style: basename globs float to
          // any depth (so "*.md" intersects mounts and must be scoped),
          // while anchored path globs outside the projection cannot match
          // under it — the pass is skipped entirely.
          const mountGlob = mountScopedIncludeGlob(input.includeGlob);
          if (mountGlob === null) {
            if (isCurrentSearch()) {
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
          if (!searchCleanupHooked.has(sender)) {
            searchCleanupHooked.add(sender);
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
              includeGlob: mountGlob,
              excludeGlob: input.excludeGlob,
            },
            (batch) => {
              if (!isCurrentSearch()) return;
              try {
                sender.send(CHANNELS.searchResults, SearchResultsEventSchema.parse(batch));
              } catch (error) {
                console.error("[desktop] mount search batch dropped:", error);
              }
            },
            isCurrentSearch,
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
        if (!isCurrentSearch()) return;
        try {
          sender.send(CHANNELS.searchResults, SearchResultsEventSchema.parse(batch));
        } catch {
          // Defense in depth: a batch that fails the contract is DROPPED,
          // never thrown through the engine's stream handler (an uncaught
          // throw there would wedge the main process). The bounded done
          // batch still arrives and settles the renderer.
        }
      },
      isCurrentSearch,
    );
  });

  ipcMain.handle(CHANNELS.cancelWorkspaceSearch, (event, payload) => {
    assertTrustedSender(event);
    const input = CancelWorkspaceSearchPayload.parse(payload);
    searchRegistry.cancel(event.sender.id, input.searchId);
  });

  // WS-G2-C-2 engine Y.Doc editor binding. Main owns the node-only live session
  // (constructed through the workspace's engine capture, which reuses its store)
  // and forwards remote CRDT deltas back to the sender that opened it. This is
  // the drop-in for the old collab-token/Hocuspocus path: no websocket, no
  // token. Gated on an engine-flagged workspace + a rich (markdown) path; a
  // secret/not-found/already-live throw surfaces as available:false so the
  // renderer falls back to the plain local autosave editor.
  ipcMain.handle(CHANNELS.engineYDocOpen, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenEngineYDocSessionPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // WS-G2-C-2 (gate fix 4): a shared view is read-only, but a live engine
    // Y.Doc session is WRITABLE (applyLocalUpdate journals edits + settles to
    // disk). Refuse it at the IPC boundary — same class as the PR-18 shared-view
    // write bypass — so a read-only recipient can never open a writable session.
    // The renderer falls back to the read-only rendered markdown.
    if (sharedViewOf(workspace.workspaceId)) {
      return OpenEngineYDocSessionResult.parse({ available: false });
    }
    const sender = event.sender;
    const generation = rendererGeneration(sender.id);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    // Only engine-flagged workspaces have a capture; only rich (markdown) files
    // bind to a Y.Doc. Everything else stays on the plain editor.
    if (!capture || !isRichEnginePath(input.path)) {
      return OpenEngineYDocSessionResult.parse({ available: false });
    }
    // A stale session under this id (e.g. a renderer that reused an id after a
    // crash) is closed before opening a new one.
    const existing = engineYDocSessions.get(input.sessionId);
    if (existing) {
      engineYDocSessions.delete(input.sessionId);
      await existing.session.close().catch(() => undefined);
    }
    const finishPendingOpen = beginPendingEngineYDocOpen(sender.id);
    try {
      let session: EngineYDocProviderSession;
      try {
        session = await capture.openYDocSession({
          path: input.path,
          onRemoteUpdate: (update) => {
            // Forward a co-editor's delta only to the renderer generation that
            // opened this session. A crash reload reuses the WebContents id.
            if (
              sender.isDestroyed() ||
              rendererGeneration(sender.id) !== generation
            ) {
              return;
            }
            try {
              sender.send(
                CHANNELS.engineYDocRemoteUpdate,
                EngineYDocRemoteUpdateEventSchema.parse({ sessionId: input.sessionId, update }),
              );
            } catch {
              // A malformed delta is DROPPED, never thrown through the session's
              // update observer (an uncaught throw there would wedge main).
            }
          },
        });
      } catch {
        // Secret path, missing file, or already-live: fall back gracefully.
        return OpenEngineYDocSessionResult.parse({ available: false });
      }
      // The renderer can die or reload DURING the await above. Close the stale
      // session before crash cleanup completes so its reservation cannot block
      // the replacement renderer's open.
      if (
        sender.isDestroyed() ||
        rendererGeneration(sender.id) !== generation
      ) {
        await session.close().catch(() => undefined);
        return OpenEngineYDocSessionResult.parse({ available: false });
      }
      if (!engineYDocCleanupHooked.has(sender)) {
        engineYDocCleanupHooked.add(sender);
        sender.once("destroyed", () => {
          void closeEngineYDocSessionsForSender(sender.id);
        });
      }
      engineYDocSessions.set(input.sessionId, {
        session,
        senderId: sender.id,
        workspaceId: workspace.workspaceId,
      });
      return OpenEngineYDocSessionResult.parse({
        available: true,
        initialUpdate: session.initialUpdate,
      });
    } finally {
      finishPendingOpen();
    }
  });

  ipcMain.handle(CHANNELS.engineYDocApplyUpdate, (event, payload) => {
    assertTrustedSender(event);
    const input = ApplyEngineYDocUpdatePayload.parse(payload);
    const entry = engineYDocSessions.get(input.sessionId);
    // Owner-scoped: only the renderer that opened the session can drive it; a
    // no-op for an unknown/closed/foreign session (never throws to the caller).
    if (!entry || entry.senderId !== event.sender.id) return;
    // WS-G2-C-2 (gate fix 4): RE-CHECK the shared-view guard before applying — a
    // workspace can become a read-only shared view after a session opened, and
    // an update must never write into a shared view. Refuse silently (matches
    // the unknown-session no-op above).
    if (sharedViewOf(entry.workspaceId)) return;
    entry.session.applyLocalUpdate(input.update);
  });

  ipcMain.handle(CHANNELS.engineYDocClose, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloseEngineYDocSessionPayload.parse(payload);
    const entry = engineYDocSessions.get(input.sessionId);
    if (!entry || entry.senderId !== event.sender.id) return;
    engineYDocSessions.delete(input.sessionId);
    await entry.session.close().catch(() => undefined);
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

  // Live bookmark projections also follow replies arriving from the local
  // agent, CLI, or relay. The engine only marks those projections pending;
  // this small workspace-scoped worker performs the filesystem write through
  // the canonical capture layer. A list/open still materializes immediately,
  // so the interval is only the background consistency path.
  const bookmarkProjectionRuns = new Set<string>();
  const bookmarkProjectionTimer = setInterval(() => {
    for (const workspaceId of activity.listOpenWorkspaceIds()) {
      if (bookmarkProjectionRuns.has(workspaceId)) continue;
      const workspace = findWorkspace(workspaceId);
      const capture = activity.engineCaptureFor(workspaceId);
      if (!workspace || !capture || sharedViewOf(workspaceId)) continue;
      bookmarkProjectionRuns.add(workspaceId);
      void materializePendingChatBookmarks(workspace, capture)
        .catch((error) => {
          console.error("[desktop] live chat bookmark projection:", error);
        })
        .finally(() => bookmarkProjectionRuns.delete(workspaceId));
    }
  }, 3_000);
  bookmarkProjectionTimer.unref();
  app.once("will-quit", () => clearInterval(bookmarkProjectionTimer));
}

// These identities must be set before ready so Windows taskbar grouping and
// Linux X11/Wayland launcher association use the package identities.
if (process.platform === "win32") app.setAppUserModelId("app.dohc.desktop");
if (process.platform === "linux") app.setDesktopName("dohc.desktop");

async function startRustEngineDaemon(): Promise<boolean> {
  rustEngineDaemon = createRustEngineDaemon({
    command: defaultEngineBinaryPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }),
    onFailure: (error, terminal) => {
      console.error("[desktop] Rust engine daemon:", error);
      if (terminal && !quitting) {
        dialog.showErrorBox(
          "Rust engine stopped",
          `${error.message}\n\nRestart dohc. If the engine stops again, review the desktop logs and repair or reinstall dohc.`,
        );
      }
    },
  });
  try {
    await rustEngineDaemon.start();
    const relaySource = new RelayConfiguredDaemonClientSource(
      rustEngineDaemon,
      relayTransportRoutes,
    );
    rustEngineWorkspaceSessions = new EngineWorkspaceSessions(relaySource);
    rustEngineRelayClient = new EngineRelayClient({
      sessions: rustEngineWorkspaceSessions,
      routes: relayTransportRoutes,
    });
    console.info("[desktop] Rust engine daemon startup smoke passed.");
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Rust engine startup error.";
    console.error("[desktop] Rust engine daemon failed to start:", error);
    dialog.showErrorBox(
      "Rust engine failed to start",
      `${message}\n\nThe desktop cannot start without the Rust engine.`,
    );
    await rustEngineDaemon.stop();
    rustEngineDaemon = null;
    rustEngineWorkspaceSessions = null;
    rustEngineRelayClient = null;
    app.quit();
    return false;
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
      const window = targetWindow(undefined);
      if (window) {
        void flushPendingOpenPaths(window);
      } else {
        void showOrCreateMainWindow().then(() =>
          flushPendingOpenPaths(targetWindow(undefined)),
        );
      }
    }
  });

  app.on("second-instance", (_event, argv) => {
    const window = targetWindow(undefined);
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      void openWorkspacePaths(collectOpenWorkspaceArgs(argv), window);
    } else {
      void showOrCreateMainWindow().then(() =>
        openWorkspacePaths(
          collectOpenWorkspaceArgs(argv),
          targetWindow(undefined),
        ),
      );
    }
  });

  app.on("before-quit", () => {
    // Fire-and-forget on quit: skip locks and do not await async stops so
    // termination stays quick; child.unref() and the OS finish process cleanup.
    stopSitePreviewsForQuit();
  });

  void app.whenReady().then(async () => {
    if (!(await startRustEngineDaemon())) return;
    // BrowserWindow and Dock APIs are only safe after Electron is ready.
    nativeTheme.on("updated", refreshSystemThemeDesktopIcons);
    launchMarks.appReady();
    desktopMarks.markOnce("app-ready");
    cachedPreferredName = (
      await readCachedUserSettingsFile(stateDir())
    ).settings.profile.preferredName;
    registerIpcHandlers();
    cliServerStartup = startDesktopCliServer()
      .then(async (server) => {
        if (quitting) {
          await server.close();
          return null;
        }
        cliServer = server;
        return server;
      })
      .catch((error: unknown) => {
        console.error("[desktop] CLI server failed to start:", error);
        return null;
      });
    void cliServerStartup.then(() => {
      if (!quitting) chatDispatchService.start();
    });
    void refreshDispatchTray().catch((error) => {
      console.error("[desktop] dispatch tray:", error);
    });

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
    const window = createMainWindow({ beforeRendererReload: prepareForRendererReload });
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
    if (process.platform === "darwin") return;
    void refreshDispatchTray()
      .then((enabled) => {
        if (!enabled && !quitting) app.quit();
      })
      .catch(() => {
        if (!quitting) app.quit();
      });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void showOrCreateMainWindow();
    }
  });
}
