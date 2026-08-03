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
  WorkspaceDaemonRequester,
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
  ListJoinedSharedChannelsPayload,
  ListJoinedSharedChannelsResult,
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
  EngineYDocSaveStateEventSchema,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
} from "./ipc/bridgeContract";
import {
  CHANNELS,
  SEARCH_EVENT_MAX_ENTRIES,
  type EngineYDocSaveStateName,
} from "./ipc/channels";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
  type EngineYDocSaveSeqState,
} from "./workspaces/engineYDocSaveSeq";
// The relay presence transport is a dependency-free module (no DOM/React): main
// reuses it so the presence wire contract (routes, publish/leave/poll) lives in
// ONE place. Main is the ONLY holder of the relay bearer token — the renderer's
// presence transport calls the presence IPC handlers below, never the relay.
import {
  createRelayPresenceTransport,
  type PresenceScope as RelayPresenceScope,
} from "./renderer/collab/presenceChannel";
import { createPresencePollRegistry } from "./collab/presencePollRegistry";
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
  endJoinedChannel,
  mergeJoinedChannel,
  relayFetchWithTimeout,
  syncJoinedSharedChannels,
} from "./workspaces/sharedChannels";
import {
  assertSharedChannelMessageIdentity,
  joinedChannelMatchesCredentials,
  resolveChatRelayIdentity,
  resolveWorkspaceRelayAuthorId,
  syncEnrollmentRemoteWorkspaceId,
  workspaceRemoteMatchesCredentials,
  type ChatRelayIdentityTarget,
} from "./workspaces/chatRelayIdentity";
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
import {
  adoptCompletedCloudLoginSession,
  createCloudLogin,
  type CloudLogin,
} from "./workspaces/cloudLogin";
import { CredentialSessionCache } from "./workspaces/credentialSessionCache";
import { createRelaySyncEngine } from "./workspaces/relaySyncEngine";
import {
  awaitCredentialGeneration,
  chatViewerAuthorId,
  createChatChannelIpcHandler,
  createReadAwareChatIpcHandler,
  createSharedChannelWritableChatIpcHandler,
  createSetChatReactionIpcHandler,
  reactionsForViewer,
  setChatReactionFromMain,
  writeChatMessageFromMain,
} from "./mainChatIpcHandlers";
import { mcpCloudEnvironment } from "./agents/mcpCloudEnvironment";
import {
  buildShareCode,
  parseShareCode,
  parseSyncCode,
  relayUrlsMatch,
} from "./workspaces/syncCode";
import {
  SharePinInvalidError,
  refreshSharedViewOnce,
} from "./workspaces/sharedView";
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
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  type RelayWorkspaceBootstrapResult,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import type {
  ChannelThreadSummary,
  ChatChannelSummary,
  ChatMessage,
  ChatBookmark,
  ChatReaction,
  ChatThread,
  VersionedTextMomentSummary,
} from "@dohc/workspace-contracts/engine";
import {
  ShareSelectorInvalidError,
  fetchShareViewInfo,
} from "./workspaces/shareViewInfo";
import { fetchSharedChannelInfo } from "./workspaces/sharedChannelInfo";
import { installWorkspaceDataKey } from "./workspaces/workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaces/workspaceKeyEnvelopeEnrollment";
import {
  readWorkspaceDataKeyForEnrollment,
  readWorkspaceSecretState,
  type WorkspaceSecretState,
} from "./workspaces/workspaceSecretEnrollmentState";
import {
  engineMomentDetailForIpc,
  engineMomentForIpc,
  versionConflictForIpc,
} from "./ipc/engineHistoryIpc";
import { createWorkspaceActivity } from "./workspaces/workspaceActivity";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineYDocProviderSession,
} from "./workspaces/workspaceEngineCapture";
import { isYDocPathNotInVersionError } from "./workspaces/workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaces/workspaceEngineCaptureLiveStore";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
  type EngineDaemonLifecycle,
} from "@dohc/workspace-engine-client/daemon";
import { bridgeCaptureEventsToRenderer } from "./workspaces/captureActivityBridge";
import {
  EngineRelayClient,
  probeWorkspaceRelay,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
  type EngineRelayWorkspaceClient,
} from "./workspaces/engineRelayClient";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  createDesktopLinkedChatStore,
  type DesktopLinkedChatStore,
} from "./workspaces/liveLinkedChatStore";
import {
  captureForFlaggedWorkspace,
  dispatchScanEligible,
  createDispatchRunRelease,
  engineOffRefusal,
  releaseAndRefuseWithoutCapture,
} from "./workspaces/engineCaptureGate";
import {
  readWorkspaceEnginePolicy,
  resolveEngineSearchPolicy,
} from "./workspaces/workspaceEnginePolicyFile";
import { queryWorkspaceSearchDaemon } from "./workspaces/workspaceSearchDaemon";
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
import {
  readWorkspaceSettingsFile,
  resetWorkspaceSettingsFile,
  saveWorkspaceSettingsFile,
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
import { makeProcessDiagnosticsNonFatal } from "./process/stdioResilience";

// A launcher that exited leaves main's stdout/stderr a pipe with no reader, and
// a pipe write throws synchronously. Diagnostics must never be able to crash the
// app they are diagnosing. This runs before main does any work; module-eval-time
// logging in the imports above is still unguarded, which is why this stays a
// top-level statement rather than moving inside app.whenReady.
makeProcessDiagnosticsNonFatal();

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
type CloudSessionCredentials = NonNullable<
  Awaited<ReturnType<CloudLogin["credentials"]>>
>;
let cachedCredentials: CloudSessionCredentials | null = null;
let credentialCacheGeneration = 0;
const credentialSessionCache =
  new CredentialSessionCache<CloudSessionCredentials>((snapshot) => {
    cachedCredentials = snapshot.credentials;
    credentialCacheGeneration = snapshot.generation;
  });
function refreshCredentialCache(): Promise<void> {
  return credentialSessionCache.refresh(() => cloudLogin().credentials());
}
function warmCredentialCache(): Promise<void> {
  return credentialSessionCache.warm(() => cloudLogin().credentials());
}
function setCachedCredentials(credentials: CloudSessionCredentials): void {
  credentialSessionCache.set(credentials);
}
function clearCachedCredentials(): void {
  credentialSessionCache.clear();
}
async function loadAndCacheCurrentCredentials(): Promise<CloudSessionCredentials | null> {
  const loaded = await credentialSessionCache.adoptCurrent(() =>
    cloudLogin().credentials(),
  );
  if (!loaded.current) {
    throw new Error("Your dohc Cloud session changed. Try again.");
  }
  return loaded.credentials;
}

// Trailing-slash-insensitive server-URL compare: the registry's recorded
// serverUrl must match the server that ISSUED the cached token, or the workspace
// stays local-only. Otherwise machine B's token could be POSTed to server A
// (account takeover) and a re-pointed registry could mass-delete.
function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
async function remoteForWorkspace(workspaceId: string) {
  await warmCredentialCache();
  const credentialGeneration = credentialCacheGeneration;
  const workspace = requireWorkspace(workspaceId);
  const remote = workspace.remote;
  if (!remote) throw new Error("Sync this workspace before sharing.");
  const credentials = cachedCredentials;
  if (!credentials) throw new Error("Sign in to dohc Cloud first.");
  if (!workspaceRemoteMatchesCredentials(remote, credentials)) {
    if (
      normalizeServerUrl(credentials.serverUrl) !==
      normalizeServerUrl(remote.serverUrl)
    ) {
      throw new Error("Sign in to the cloud server this workspace uses.");
    }
    throw new Error("Sign in to the account that synced this workspace.");
  }
  return { workspace, remote, credentials, credentialGeneration };
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

async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!credentials.relayUrl) {
    throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
  }
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${credentials.token}`);
  const response = await fetch(
    `${normalizeServerUrl(credentials.relayUrl)}${path}`,
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

async function relayShareJson<T>(path: string, init?: RequestInit): Promise<T> {
  await warmCredentialCache();
  const credentials = cachedCredentials;
  if (!credentials) throw new Error("Sign in to dohc Cloud first.");
  return relayShareJsonWithCredentials(credentials, path, init);
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
  const credentials = cachedCredentials;
  if (!credentials?.relayUrl) return null;
  const baseUrl = normalizeServerUrl(credentials.relayUrl);
  const token = credentials.token;
  const fetchImpl = relayFetchWithTimeout(PRESENCE_PUBLISH_TIMEOUT_MS);
  let relayScope: RelayPresenceScope;
  if (scope.kind === "workspace") {
    const entry = findWorkspace(scope.workspaceId);
    const remote = entry?.remote;
    if (!remote || !workspaceRemoteMatchesCredentials(remote, credentials)) {
      return null;
    }
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
    const syncCredentials = cachedCredentials;
    if (!syncCredentials?.relayUrl) return;
    const relayUrl = syncCredentials.relayUrl;
    // A joined channel syncs only for the relay account that joined it.
    const matching = channels.filter((channel) =>
      joinedChannelMatchesCredentials(channel, syncCredentials),
    );
    if (matching.length === 0) return;
    const relay = {
      baseUrl: normalizeServerUrl(relayUrl),
      token: syncCredentials.token,
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

async function mcpRuntimeConfigFor(rootPath: string): Promise<{
  command: string;
  args: string[];
  env?: Record<string, string>;
}> {
  await warmCredentialCache();
  const workspace = listWorkspaces().find((entry) => entry.rootPath === rootPath);
  // Defense in depth: managed agent runs are already refused on shared views,
  // but if a runtime MCP is ever spawned for one it must be the read-only
  // profile — never the write-capable server.
  const config = mcpConfigFor(rootPath, { readOnly: !!workspace?.shareView });
  const env = mcpCloudEnvironment({
    workspace,
    credentials: cachedCredentials,
  });
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
  shareMount?: true;
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
  const credentials = cachedCredentials;
  if (!remote || !credentials) return null;
  if (!capture || !credentials.relayUrl) return null;
  // Only sync when the session belongs to the server this workspace is bound
  // to; a mismatch keeps it local-only (no token leak, no mass-delete).
  if (!workspaceRemoteMatchesCredentials(remote, credentials)) return null;
  const relay = {
    baseUrl: credentials.relayUrl,
    token: credentials.token,
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

const activity = createWorkspaceActivity(notifyRenderer, {
  cloudStateFor: (workspaceId) => {
    const remote = findWorkspace(workspaceId)?.remote;
    return {
      enabled: !!remote,
      // Legacy and different-account bindings stay local-only.
      connected:
        !!remote && workspaceRemoteMatchesCredentials(remote, cachedCredentials),
    };
  },
  engineFor: engineForWorkspace,
  // The flag-gated engine capture (see engineCaptureGate.ts — shared with the
  // arc-gate QA harness so the harness asserts against the REAL gate). The
  // gate also owns the shared-view rule (#540): main only states the share
  // identity from the registry, and the decision carries the cause so the
  // null capture never wears the Settings opt-out's copy.
  captureFor: async (workspace, hooks) =>
    captureForFlaggedWorkspace(
      {
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        shareView: !!findWorkspace(workspace.workspaceId)?.shareView,
      },
      hooks,
      requireEngineSessions(),
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
      throw new Error(
        engineOffRefusal(
          activity.getStatus(workspace.workspaceId),
          "Versions are not enabled for this workspace.",
          // openWorkspaceActivity retained this session: only a restart
          // re-runs the capture decision.
          "restart",
        ),
      );
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

// The object-id <-> path index the search surfaces need, read through the
// DAEMON rather than a second sqlite connection.
//
// This used to call the legacy TypeScript store factory, which opened another
// node:sqlite connection to the engine.db the daemon owns -- exactly the second
// writable connection workspaceEngineCapture.ts warns can deadlock. It also
// hydrated every file's CONTENT via listTextFiles just to read two string
// fields off each row.
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
// authorId === actor.userId server-side. Signed out falls back to a persisted
// per-install uuid. The email→display-name mapping stays LOCAL in
// localUserDisplayName().
function localUserId(): string {
  return cachedCredentials?.userId ?? localReactorFallbackId();
}

// The verified relay identity for a signed-in chat message (WS-MU-C0). A
// signed-in session always carries the opaque Better Auth user id that the relay
// verifies as `actor.userId`. Signed-out sends omit `authorUserId`. Reactions
// still use the stable local fallback id offline. The email stays display-only.
async function chatRelayIdentityFor(
  workspaceId: string,
  target: ChatRelayIdentityTarget,
) {
  await warmCredentialCache();
  const workspace = requireWorkspace(workspaceId);
  const capturedGeneration = credentialCacheGeneration;
  const credentials = cachedCredentials;
  return awaitCredentialGeneration({
    capturedGeneration,
    currentGeneration: () => credentialCacheGeneration,
    run: () =>
      resolveChatRelayIdentity({
        workspace,
        credentials,
        store: linkedChatStoreFor(workspace),
        target,
      }),
  });
}

async function verifiedChatAuthorUserIdFor(
  workspaceId: string,
  target: ChatRelayIdentityTarget,
): Promise<string | undefined> {
  const identity = await chatRelayIdentityFor(workspaceId, target);
  assertSharedChannelMessageIdentity({
    joinedChannel: identity.joinedChannel,
    credentials: cachedCredentials,
    authorUserId: identity.authorUserId,
    resolvedAuthorUserId: identity.authorUserId,
  });
  return identity.authorUserId;
}

async function revalidateChatWrite(
  workspace: { workspaceId: string; rootPath: string },
  target: ChatRelayIdentityTarget,
  authorUserId: string | undefined,
): Promise<void> {
  await assertSharedChannelWritable({
    workspaceId: workspace.workspaceId,
    sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
    store: linkedChatStoreFor(workspace),
    target,
  });
  const currentAuthorUserId = await verifiedChatAuthorUserIdFor(
    workspace.workspaceId,
    target,
  );
  if (currentAuthorUserId !== authorUserId) {
    throw new Error("Your dohc Cloud session changed. Try again.");
  }
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
  const credentials = cachedCredentials;
  if (!credentials) return [];
  return listWorkspaces()
    .filter(
      (workspace) =>
        workspace.remote !== undefined &&
        workspaceRemoteMatchesCredentials(workspace.remote, credentials),
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
    const { capture } = await captureForFlaggedWorkspace(
      {
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        // Guarded above: a shared view already returned false.
        shareView: false,
      },
      {
        activeAgentRun: () => null,
        onCaptureOutcome: () => undefined,
      },
      requireEngineSessions(),
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
): Promise<() => Promise<boolean>> {
  const alreadyOpen = activity
    .listOpenWorkspaceIds()
    .includes(workspace.workspaceId);
  await workspaceChatLifecycle.open(
    workspace,
    () => ensureWorkspaceActivityOpen(workspace),
  );
  // The release resolves to whether a fresh attempt would rebuild the
  // capture, decided from the POST-close retention state (#541) — the
  // close's own await is a window a renderer/CLI open can retain through.
  // The refusal's recovery instruction derives from this fact.
  return createDispatchRunRelease({
    alreadyOpen,
    isRetained: () =>
      retainedWorkspaceActivities.has(workspace.workspaceId),
    close: () => closeDispatchRunActivity(workspace.workspaceId),
  });
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
  identityFor: async (workspaceId, target) => {
    await warmCredentialCache();
    const workspace = findWorkspace(workspaceId);
    const verifiedUserId = workspace
      ? target
        ? (await chatRelayIdentityFor(workspaceId, target)).authorUserId
        : resolveWorkspaceRelayAuthorId(workspace, cachedCredentials)
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
  // An opted-out workspace must record NOTHING: without this gate the
  // workspace-open scan reaches dispatchStoreFor/chatStoreFor, whose daemon
  // workspace.open creates .dohc/engine/engine.db. Open sessions answer from
  // their capture snapshot (the flag applies at the NEXT open).
  scanEligible: (workspace) => dispatchScanEligible(workspace, activity),
  prepareRunWorkspace: async (workspace) => {
    const registered = findWorkspace(workspace.workspaceId);
    if (!registered) {
      throw new Error(`Unknown workspace: ${workspace.workspaceId}`);
    }
    const release = await acquireDispatchRunActivity(registered);
    // The helper owns both orders (#583): cause read before the release,
    // recovery derived from what the release actually did.
    await releaseAndRefuseWithoutCapture({
      capture: activity.engineCaptureFor(workspace.workspaceId),
      currentCapture: () => activity.engineCaptureFor(workspace.workspaceId),
      status: () => activity.getStatus(workspace.workspaceId),
      release,
      notEnabled: "Chats are not enabled for this workspace.",
    });
    return async () => {
      await release();
    };
  },
  authorizeServiceNote: async (workspace, threadId, verifiedUserId) => {
    try {
      await assertSharedChannelWritable({
        workspaceId: workspace.workspaceId,
        sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
        store: linkedChatStoreFor(workspace),
        target: { threadId },
      });
      const identity = await chatRelayIdentityFor(workspace.workspaceId, {
        threadId,
      });
      return (
        identity.authorUserId === verifiedUserId &&
        (identity.joinedChannel === null || verifiedUserId !== undefined)
      );
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
  if (!capture) {
    throw new Error(
      engineOffRefusal(
        activity.getStatus(workspace.workspaceId),
        "Chats are not enabled for this workspace.",
        // openWorkspaceActivity retained this session: only a restart
        // re-runs the capture decision.
        "restart",
      ),
    );
  }
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
    assertMessageWritable: async (target, authorUserId) => {
      const identity = await chatRelayIdentityFor(workspace.workspaceId, target);
      assertSharedChannelMessageIdentity({
        joinedChannel: identity.joinedChannel,
        credentials: cachedCredentials,
        authorUserId,
        resolvedAuthorUserId: identity.authorUserId,
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
    identity: async (workspaceId, target) => {
      await warmCredentialCache();
      const workspace = findWorkspace(workspaceId);
      const authorUserId = workspace
        ? target
          ? (await chatRelayIdentityFor(workspaceId, target)).authorUserId
          : resolveWorkspaceRelayAuthorId(workspace, cachedCredentials)
        : undefined;
      return {
        displayName: localUserDisplayName(),
        ...(authorUserId ? { authorUserId } : {}),
        reactionAuthorId: localReactorFallbackId(),
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
    onDebug: (message) => {
      console.debug(`[desktop] CLI server: ${message}`);
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
  session: WorkspaceEngineYDocProviderSession;
  senderId: number;
  workspaceId: string;
  // The renderer that owns this session, and the generation it was opened
  // under: a crash-reload reuses the WebContents id, so both are required
  // before pushing a save state back.
  sender: Electron.WebContents;
  generation: number;
  // Edit/settle bookkeeping for the honest save indicator. Several settles
  // are routinely in flight at once, so this is a FIFO, not a scalar — see
  // engineYDocSaveSeq.ts.
  saveSeq: EngineYDocSaveSeqState;
}
const engineYDocSessions = new Map<string, EngineYDocSessionEntry>();

// Push a document's REAL save state to the renderer that owns its session.
// Never throws: this is called from session status hooks and from the IPC
// no-op boundaries, neither of which may fail.
function sendEngineYDocSaveState(
  sender: Electron.WebContents,
  generation: number,
  sessionId: string,
  state: EngineYDocSaveStateName,
  seq: number,
): void {
  if (sender.isDestroyed() || rendererGeneration(sender.id) !== generation) return;
  try {
    sender.send(
      CHANNELS.engineYDocSaveState,
      EngineYDocSaveStateEventSchema.parse({ sessionId, state, seq }),
    );
  } catch {
    // A malformed status is DROPPED, never thrown through a status hook.
  }
}
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
  // `shuttingDown` ONLY here: this is the one close that runs inside the
  // will-quit budget, so it is the one close that must not wait for a daemon
  // to come back. A user closing a document still gets the full ladder.
  await Promise.all(
    entries.map((entry) =>
      entry.session.close({ shuttingDown: true }).catch(() => undefined),
    ),
  );
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

// Narrowing for the capture gate, matching what `linkedChatStoreFor` and
// `sharedViewStoreFor` already do (same error text). The invariant is real:
// startRustEngineDaemon quits the app on failure before any window exists, and
// this handle is nulled only on that failure path. A throw here would mean that
// invariant broke, which must be loud, not a silent drop to the legacy engine.
function requireEngineSessions(): EngineWorkspaceSessions {
  if (!rustEngineWorkspaceSessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  return rustEngineWorkspaceSessions;
}

function sharedViewStoreFor(workspace: {
  workspaceId: string;
  rootPath: string;
}) {
  if (!rustEngineWorkspaceSessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  return createCaptureLiveStores(workspace, rustEngineWorkspaceSessions).store;
}

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

// `app.isReady()` turns true before the whenReady continuation finishes
// awaiting the Rust engine daemon, so it cannot gate window creation. This
// flag turns true only once the daemon is up, IPC is registered, and the first
// window exists. Until then, handlers queue their paths instead of opening a
// window the bootstrap cannot serve.
let bootstrapComplete = false;

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
      // A completed login can rotate the bearer token without changing the
      // server or user id. Rebuild every relay-bound engine from the new
      // credential snapshot instead of letting an existing engine keep the
      // previous token.
      await adoptCompletedCloudLoginSession({
        clearCachedCredentials: () => clearCachedCredentials(),
        stopEngines: async () => await activity.stopEngines(),
        closeRelayTransportWorkspaces: async () =>
          await closeAllRelayTransportWorkspaces(),
        refreshCredentialCache: async () => await refreshCredentialCache(),
        // Attach engines to already-open cloud-enabled workspaces that were
        // opened local-only because no session existed yet.
        reconcileCloud: () => {
          activity.reconcileCloud(engineForWorkspace);
        },
      });
    }
    return CloudLoginPollResult.parse(result);
  });

  ipcMain.handle(CHANNELS.cloudStatus, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudStatusPayload.parse(payload ?? {});
    const status = await cloudLogin().status();
    await warmCredentialCache();
    const workspace = input.workspaceId ? findWorkspace(input.workspaceId) : undefined;
    let workspaceSecretState: WorkspaceSecretState | undefined;
    if (workspace) {
      const sessions = rustEngineWorkspaceSessions;
      if (!sessions) {
        throw new Error("Rust engine workspace sessions are unavailable.");
      }
      workspaceSecretState = await readWorkspaceSecretState(
        workspace.rootPath,
        workspace.workspaceId,
        sessions,
      );
    }
    return CloudStatusResult.parse({
      ...status,
      ...(input.workspaceId
        ? {
            workspaceSynced: !!workspace?.remote,
            workspaceSyncConnected:
              !!workspace?.remote &&
              workspaceRemoteMatchesCredentials(
                workspace.remote,
                cachedCredentials,
              ),
            ...(workspaceSecretState ? { workspaceSecretState } : {}),
          }
        : {}),
    });
  });

  ipcMain.handle(CHANNELS.cloudLogout, async (event) => {
    assertTrustedSender(event);
    clearCachedCredentials();
    try {
      await cloudLogin().logout();
    } finally {
      // Stop + drop active engines even if the credential store reports a
      // logout failure. The in-memory session is already invalid.
      await activity.stopEngines();
      await closeAllRelayTransportWorkspaces();
      notifyRenderer();
    }
  });

  // Enabling sync claims the recorded remote workspace id, or the local id on
  // first enrollment. The first claimant owns it; the owner can retry, and a
  // different account gets the relay's fixed 404. The handler then records the
  // verified binding and starts the merge engine.
  //
  // The relay's POST /sync/workspaces is the SOLE claim authority: workspace-api
  // is now auth-only and 404s every non-auth route, so there is no separate
  // preclaim to make — the relay owns ownership end to end (create / idempotent
  // same-owner / foreign-refused).
  ipcMain.handle(CHANNELS.cloudEnableSync, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudEnableSyncPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const credentials = await loadAndCacheCurrentCredentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first");
    if (!credentials.relayUrl) throw new Error("Cloud sync requires a relay URL");
    const remoteWorkspaceId = syncEnrollmentRemoteWorkspaceId(
      workspace,
      credentials,
    );

    {
      const relay = {
        baseUrl: credentials.relayUrl,
        token: credentials.token,
      };
      const daemonRelay = relayClientForWorkspace({
        workspaceId: remoteWorkspaceId,
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
      const sessions = rustEngineWorkspaceSessions;
      if (!sessions) {
        throw new Error("Rust engine workspace sessions are unavailable.");
      }
      const dataKey = await readWorkspaceDataKeyForEnrollment(
        workspace.rootPath,
        workspace.workspaceId,
        sessions,
      );
      await enrollWorkspaceKeyEnvelope({
        workspaceId: remoteWorkspaceId,
        dataKey,
        ...(input.passphrase === undefined
          ? {}
          : { passphrase: input.passphrase }),
        transport: daemonRelay,
        installDataKey: async (unwrapped) =>
          await installWorkspaceDataKey(workspace.rootPath, unwrapped),
      });
    }

    setWorkspaceRemote(workspace.workspaceId, {
      serverUrl: credentials.serverUrl,
      remoteWorkspaceId,
      ownerUserId: credentials.userId,
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
    const credentials = await loadAndCacheCurrentCredentials();
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
    let probe: RelayWorkspaceBootstrapResult;
    try {
      probe = await probeWorkspaceRelay(relayTransportRoutes, {
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
    try {
      // Bootstrap the relay coordinate through a capture-free daemon session
      // BEFORE registration exposes the workspace or activity.open can build
      // capture and start its watcher. An unset relay is claimed; otherwise
      // the pristine daemon adopts the relay's existing epoch and stream with
      // its own new origin. The bootstrap session closes before the captured
      // activity session opens.
      const daemonRelay = relayClientForWorkspace({
        workspaceId: parsed.workspaceId,
        rootPath: created.rootPath,
        relay,
      });
      await daemonRelay.bootstrapJoinIdentity(probe.identity);

      registerWorkspace({ ...created, joinBootstrapPending: true });
      refreshNativeWorkspaceSurfaces();

      // Now open capture, bind the remote, and enable the pull-first engine.
      // joinBootstrap makes the engine PULL-FIRST:
      // its start() is the first pull (materialize + cursor commit), and no
      // push can reach the relay before that pull succeeds — a fresh join can
      // never seed boilerplate into the remote or conflict against it.
      await openWorkspaceActivity(created, async () => {
        setWorkspaceRemote(created.workspaceId, {
          serverUrl: credentials.serverUrl,
          remoteWorkspaceId: parsed.workspaceId,
          ownerUserId: credentials.userId,
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

  // What THIS machine joined, straight from the registry. The grant side lives
  // on the relay; this side does not, so asking it costs no network — and a
  // caller that needs only this must not wait on a relay that may never answer.
  function joinedSharedChannelRows(workspaceId: string) {
    const entry = requireWorkspace(workspaceId);
    return (entry.sharedChannels ?? []).map((channel) => ({
      shareId: channel.shareId,
      channelWireId: channel.channelWireId,
      access: channel.access,
      granterEmail: channel.granterEmail,
      ended: channel.ended === true,
    }));
  }

  ipcMain.handle(CHANNELS.listJoinedSharedChannels, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListJoinedSharedChannelsPayload.parse(payload);
    return ListJoinedSharedChannelsResult.parse({
      joined: joinedSharedChannelRows(input.workspaceId),
    });
  });

  ipcMain.handle(CHANNELS.listChatChannelShares, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelSharesPayload.parse(payload);
    const entry = requireWorkspace(input.workspaceId);
    const joined = joinedSharedChannelRows(input.workspaceId);
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
    const joinCredentials = cachedCredentials;
    if (!joinCredentials) throw new Error("Sign in to dohc Cloud first.");
    if (!joinCredentials.relayUrl) {
      throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
    }
    // Capture the credentials BEFORE the awaits below (CodeRabbit Data
    // Integrity): cachedCredentials can change during fetch/pull (logout,
    // relay switch) — re-reading it afterwards can crash on null or pin the
    // joined channel to the WRONG relay. The join is atomic against the
    // credentials it started with.
    const joinedRelayUrl = joinCredentials.relayUrl;
    const joinedRecipientUserId = joinCredentials.userId;
    const relay = {
      baseUrl: normalizeServerUrl(joinedRelayUrl),
      token: joinCredentials.token,
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
      recipientUserId: joinedRecipientUserId,
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
  // rows stay readable. Keep an ended tombstone so participant provenance and
  // the read-only write gate survive after live grant data is gone.
  ipcMain.handle(CHANNELS.leaveSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveSharedChannelPayload.parse(payload);
    const entry = requireWorkspace(input.workspaceId);
    setWorkspaceSharedChannels(
      input.workspaceId,
      endJoinedChannel(entry.sharedChannels ?? [], input.shareId),
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
    const credentials = await loadAndCacheCurrentCredentials();
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
      if (error instanceof ShareSelectorInvalidError) {
        throw new Error(
          "This share can't be opened: the server didn't say what it shares. Try again later.",
        );
      }
      throw error;
    }
    // A chat-channel code has no file selector, so there is no scope to
    // enforce and nothing to project. Refuse it here rather than record a
    // grant of "everything" (the mount path says the same through
    // assertMountableSelector).
    assertMountableSelector(info.selector);
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
      // Pin the selector the relay just stated, so later pulls enforce it
      // instead of trusting the relay's selection each time.
      grantedSelector: info.selector,
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
        store: sharedViewStoreFor(created),
        // Just pinned on the record above; the refresh reads it back through
        // the same defensive parse every later refresh uses.
        pinnedSelector: info.selector,
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
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
    let outcome;
    try {
      outcome = await refreshSharedViewOnce({
        rootDir: workspace.rootPath,
        workspaceId: workspace.workspaceId,
        relay,
        shareId: shareView.shareId,
        store: sharedViewStoreFor(workspace),
        pinnedSelector: shareView.grantedSelector,
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
          }),
      });
    } catch (error) {
      // A damaged pin does not heal on the next try, and re-asking the relay
      // for one would let it restate a wider scope. Say so instead of
      // reporting "refreshed, nothing new" forever.
      if (error instanceof SharePinInvalidError) {
        throw new Error(
          "This shared view's record is damaged, so it can't refresh safely. " +
            "Remove it, then open the share code again.",
        );
      }
      throw error;
    }
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
    const credentials = await loadAndCacheCurrentCredentials();
    if (!credentials) throw new Error("Sign in to dohc Cloud first.");
    if (!credentials.relayUrl || !relayUrlsMatch(credentials.relayUrl, parsed.relayUrl)) {
      // Same security gate as openSharedView: the session token is only ever
      // sent to the relay this machine signed in with.
      throw new Error(
        "This share lives on a different server than the one you're signed in to. " +
          `Reconnect dohc Cloud with the sync relay URL ${parsed.relayUrl}, then try again.`,
      );
    }
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
      // Pin the selector the relay just stated (same reason as a view).
      grantedSelector: info.selector,
    };
    await createMountDirectory(workspace.rootPath, mount.label);
    const mountRelayTarget = relayTargetForShareMount(
      workspace.workspaceId,
      workspace.rootPath,
      mount,
    );
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
        hostWorkspaceId: workspace.workspaceId,
        hostRoot: workspace.rootPath,
        mount,
        relay,
        openStore: sharedViewStoreFor,
        // Just pinned on the record above; read back through the same
        // defensive parse every later refresh uses.
        pinnedSelector: info.selector,
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
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
          workspace.workspaceId,
          workspace.rootPath,
          mount,
        );
        const daemonRelay = relayClientForWorkspace({
          ...mountRelayTarget,
          relay,
        });
        const outcome = await refreshShareMountOnce({
          hostWorkspaceId: workspace.workspaceId,
          hostRoot: workspace.rootPath,
          mount,
          relay,
          openStore: sharedViewStoreFor,
          pinnedSelector: mount.grantedSelector,
          pull: async (input) =>
            await daemonRelay.pullShareView({
              shareId: input.shareId,
              grantedSelector: input.grantedSelector,
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
        // A damaged pin is permanent, like the expired session above: no
        // later refresh repairs it, and the relay must not be asked for a
        // replacement scope. Reporting "unchanged" would hide it forever.
        if (error instanceof SharePinInvalidError) {
          throw new Error(
            `The record for the share in "${mount.label}" is damaged, so it can't ` +
              "refresh safely. Remove that share, then add it again.",
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
      mountStoreWorkspaceIdFor(workspace.workspaceId, mount.shareId),
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
  async function requireEngineCapture(workspaceId: string, notEnabled: string) {
    const workspace = requireWorkspace(workspaceId);
    // Idempotent: guarantees the watcher + capture are live before any
    // engine operation touches the chain.
    await openWorkspaceActivity(workspace);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      // #541: the caller's "not enabled" copy holds only for the real
      // opt-out — after a failed capture build the refusal names the failure.
      throw new Error(
        engineOffRefusal(activity.getStatus(workspace.workspaceId), notEnabled, "restart"),
      );
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
    // Resolve one relay-scoped identity before attachments or any durable
    // write. Shared channels require it; local history may omit it.
    const store = linkedChatStoreFor(workspace);
    const target = { threadId: input.threadId };
    const message = await writeChatMessageFromMain({
      resolveAuthorUserId: () =>
        verifiedChatAuthorUserIdFor(workspace.workspaceId, target),
      resolveAttachments: () =>
        resolveChatFileReferences(workspace, capture, input.fileReferences),
      revalidateAuthorUserId: (authorUserId) =>
        revalidateChatWrite(workspace, target, authorUserId),
      // Author is derived HERE: renderer-sent messages are always the local
      // human user. Agent authorship arrives through agent tooling, never
      // through this channel.
      write: ({ authorUserId, attachments }) =>
        store.sendMessage({
          workspaceId: workspace.workspaceId,
          threadId: input.threadId,
          author: { kind: "human", displayName: localUserDisplayName() },
          ...(authorUserId ? { authorUserId } : {}),
          ...(input.parentMessageId
            ? { parentMessageId: input.parentMessageId }
            : {}),
          body: input.body,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
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

  function channelThreadForIpc(
    summary: ChannelThreadSummary,
    reactionViewer?: {
      viewerAuthorId: string;
      localFallbackAuthorId: string;
    },
  ) {
    const openingReactions =
      summary.openingMessage?.reactions.map(chatReactionForIpc) ?? [];
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
            reactions: reactionViewer
              ? reactionsForViewer(openingReactions, reactionViewer)
              : openingReactions,
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
    const replicationOwnerUserId = resolveWorkspaceRelayAuthorId(
      workspace,
      cachedCredentials,
    );
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
            const replicationOwnerUserId = resolveWorkspaceRelayAuthorId(
              workspace,
              cachedCredentials,
            );
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
    const localFallbackAuthorId = localReactorFallbackId();
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId,
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            channelId: input.channelId,
          })
        ).authorUserId,
    });
    const threads = await linkedChatStoreFor(workspace).listChannelThreads({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
    });
    return ListChannelThreadsResult.parse({
      threads: threads.map((thread) =>
        channelThreadForIpc(thread, {
          viewerAuthorId,
          localFallbackAuthorId,
        }),
      ),
      viewerAuthorId,
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
    // Resolve one relay-scoped identity before attachments or any durable
    // write. Shared channels require it; local history may omit it.
    const store = linkedChatStoreFor(workspace);
    const target = { channelId: input.channelId };
    const started = await writeChatMessageFromMain({
      resolveAuthorUserId: () =>
        verifiedChatAuthorUserIdFor(workspace.workspaceId, target),
      resolveAttachments: () =>
        resolveChatFileReferences(workspace, capture, input.fileReferences),
      revalidateAuthorUserId: (authorUserId) =>
        revalidateChatWrite(workspace, target, authorUserId),
      // No title, ever, on this path: the thread displays its first-message
      // snippet. Author is main-derived like every renderer send.
      write: ({ authorUserId, attachments }) =>
        store.startChannelThread({
          workspaceId: workspace.workspaceId,
          channelId: input.channelId,
          author: { kind: "human", displayName: localUserDisplayName() },
          ...(authorUserId ? { authorUserId } : {}),
          body: input.body,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
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
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId: localReactorFallbackId(),
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            threadId: input.threadId,
          })
        ).authorUserId,
    });
    const reactions = await linkedChatStoreFor(workspace).listReactions({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return ListChatReactionsResult.parse({
      reactions: reactionsForViewer(reactions.map(chatReactionForIpc), {
        viewerAuthorId,
        localFallbackAuthorId: localReactorFallbackId(),
      }),
      viewerAuthorId,
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
        const target = { threadId: input.threadId };
        // MU-C4 (CodeRabbit security): reactions are writes too — a read-only
        // shared channel rejects them before any durable row.
        await assertSharedChannelWritable({
          workspaceId: workspace.workspaceId,
          sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
          store: linkedChatStoreFor(workspace),
          target,
        });
        const reaction = await setChatReactionFromMain({
          workspaceId: workspace.workspaceId,
          threadId: input.threadId,
          messageId: input.messageId,
          emoji: input.emoji,
          localFallbackAuthorId: localReactorFallbackId(),
          localAuthorDisplayName: localUserDisplayName(),
          resolveReplicationAuthorId: () =>
            verifiedChatAuthorUserIdFor(workspace.workspaceId, target),
          revalidateReplicationAuthorId: (authorUserId) =>
            revalidateChatWrite(workspace, target, authorUserId),
          listReactions: () =>
            linkedChatStoreFor(workspace).listReactions({
              workspaceId: workspace.workspaceId,
              threadId: input.threadId,
            }),
          setReaction: (mutation) =>
            linkedChatStoreFor(workspace).setReaction(mutation),
          state: input.state,
        });
        return SetChatReactionResult.parse({
          reaction: { ...chatReactionForIpc(reaction), state: reaction.state },
          viewerAuthorId: reaction.author.authorId,
        });
      },
      // MU-C4: reactions in a joined shared channel push out promptly too.
      syncJoinedChannels: (workspaceId) => {
        void syncWorkspaceSharedChannels(workspaceId);
      },
      // Signed-in reactions are journaled workspace mutations, so the owner's
      // cloud workspace is nudged too. Signed-out sync attempts are no-ops.
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
    const joinCredentials = cachedCredentials;
    const relayUrl = joinCredentials?.relayUrl;
    if (!joinCredentials || !relayUrl) return;
    const recipientUserId = joinCredentials.userId;
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
          recipientUserId,
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
    const {
      remote,
      credentials,
      credentialGeneration,
    } = await remoteForWorkspace(input.workspaceId);
    function assertCurrentDmSession(): void {
      if (credentialCacheGeneration !== credentialGeneration) {
        throw new Error("Your dohc Cloud session changed. Try again.");
      }
    }
    async function awaitCurrentDmSession<Result>(
      run: () => Promise<Result>,
    ): Promise<Result> {
      assertCurrentDmSession();
      return awaitCredentialGeneration({
        capturedGeneration: credentialGeneration,
        currentGeneration: () => credentialCacheGeneration,
        run,
      });
    }
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
    const authorUserId = resolveWorkspaceRelayAuthorId(
      workspace,
      credentials,
    );
    if (!credentials.relayUrl || !authorUserId) {
      throw new Error("Sign in to dohc Cloud to start a direct message.");
    }
    const recipients = parseDmRecipients(input.recipients);
    const selfEmail = credentials.email.toLowerCase();
    if (selfEmail && recipients.includes(selfEmail)) {
      throw new Error("A direct message needs a recipient other than yourself.");
    }
    // Resolve mentions before creating/granting a DM so an invalid or stale
    // heading cannot leave behind a partially initialized conversation.
    const attachments = await awaitCurrentDmSession(() =>
      resolveChatFileReferences(
        workspace,
        capture,
        input.fileReferences,
      ),
    );
    const store = linkedChatStoreFor(workspace);
    // A DM's identity is its LIVE grant recipient set — NOT its (truncatable,
    // collidable) display name. Enumerate live chat-channel grants keyed by
    // wire id ONCE: used both to dedup the DM (exact recipient-set match) and
    // to compute which recipients still need a grant. The anti-enumeration
    // posture is the relay's: known and unknown emails create indistinguishable
    // grants.
    const shares = await awaitCurrentDmSession(() =>
      relayShareJsonWithCredentials<{
        granted?: Array<{
          recipientEmail?: string | null;
          revokedAtMs?: number | null;
          selector?: { kind?: string; channelWireId?: string };
        }>;
      }>(credentials, "/sync/shares"),
    );
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
    const dmChannelWires = await awaitCurrentDmSession(async () =>
      Promise.all(
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
      ),
    );
    const matchedId = matchDmChannelByRecipients({
      recipients,
      channels: dmChannelWires,
      liveGrantEmailsByWire,
    });
    let channelId = matchedId;
    if (!channelId) {
      channelId = (
        await awaitCurrentDmSession(() =>
          store.createChannel({
            workspaceId: workspace.workspaceId,
            name: dmChannelNameFor(recipients),
            kind: "dm",
          }),
        )
      ).id;
    }
    const wireId =
      (await awaitCurrentDmSession(() =>
        store.getChannelWireId({
          workspaceId: workspace.workspaceId,
          channelId,
        }),
      )) ?? channelId;
    // Ensure one LIVE grant per recipient (grants are rows; a re-run after a
    // revocation re-invites). A freshly created channel has no grants yet. The
    // grants are created ATOMICALLY: if any fails, grantDmRecipients revokes the
    // ones created in THIS call and rethrows, so no half-granted channel lingers
    // to be duplicated on retry (matchDmChannelByRecipients needs an EXACT set).
    // The first message is sent only AFTER this resolves, so a thrown rollback
    // means nothing was said yet; the orphaned channel (zero live grants, no
    // thread) is hidden by listDmRecords.
    const covered = liveGrantEmailsByWire.get(wireId) ?? new Set<string>();
    let threads: Awaited<ReturnType<typeof store.listChannelThreads>> = [];
    const message = await grantDmRecipients({
      recipients,
      covered,
      // FLAT chat-channel grant body (matches shareChatChannel): the relay
      // branches on the top-level channelWireId. A nested chatChannel body
      // would fall through to the path-share validator and silently fail.
      createGrant: async (email) => {
        const created = await relayShareJsonWithCredentials<{ shareId?: string }>(
          credentials,
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
        await relayShareJsonWithCredentials(
          credentials,
          `/sync/shares/${encodeURIComponent(shareId)}/revoke`,
          {
            method: "POST",
          },
        );
      },
      assertCurrent: assertCurrentDmSession,
      beforeCommit: async () => {
        threads = await awaitCurrentDmSession(() =>
          store.listChannelThreads({
            workspaceId: workspace.workspaceId,
            channelId,
          }),
        );
      },
      commit: async () => {
        const running = runningThread(threads);
        const author = {
          kind: "human" as const,
          displayName: localUserDisplayName(),
        };
        return running
          ? store.sendMessage({
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
      },
    });
    if (!message) throw new Error("Could not start that direct message.");
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
    await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
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
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats are not enabled for this workspace.",
    );
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
    return WorkspaceSettingsResult.parse(
      await saveWorkspaceSettingsFile(workspace.rootPath, input.patch),
    );
  });

  ipcMain.handle(CHANNELS.resetWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceSettingsPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return WorkspaceSettingsResult.parse(
      await resetWorkspaceSettingsFile(workspace.rootPath),
    );
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
      {
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
        const sessions = rustEngineWorkspaceSessions;
        if (!sessions) {
          throw new Error("Rust engine workspace sessions are unavailable.");
        }
        const results = await sessions.run(
          workspace,
          async (binding) => {
            const requester = new WorkspaceDaemonRequester(binding.client);
            return await queryWorkspaceSearchDaemon({
              daemon: {
                queryPage: async (params) =>
                  await requester.request(
                    WORKSPACE_METHOD.searchQueryPage,
                    params,
                    { workspace: binding.workspace },
                  ),
              },
              query: input.query,
              limit: SEARCH_EVENT_MAX_ENTRIES,
              isCurrent: isCurrentSearch,
            });
          },
          { retryTransportErrors: true },
        );
        if (results === null) return;
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
  // and forwards remote CRDT deltas back to the sender that opened it. No
  // websocket or token is needed. Gated on an engine-flagged workspace + a
  // rich (markdown) path; a
  // secret/already-live throw surfaces as available:false so the renderer falls
  // back to the plain local autosave editor. The ONE refusal that must not fall
  // back that way is path-not-in-version (#534): the plain editor is writable
  // too, and its autosave would write the very phantom file the engine refusal
  // prevented. That one comes back as available:false + notInVersion:true, and
  // the renderer stops editing instead of downgrading.
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
      let session: WorkspaceEngineYDocProviderSession;
      try {
        session = await capture.openYDocSession({
          path: input.path,
          // Explicit, because the daemon defaults an unspecified session to
          // PLAINTEXT (actor.rs requested_content_kind.unwrap_or(Plaintext)).
          // The gate above admits only rich markdown paths, and a plaintext
          // session seeds/projects the plainText root while the editor binds
          // the body fragment — the doc opens empty and every typed edit
          // settles back to the pre-edit file while the UI shows "Saved".
          contentKind: "richdoc",
          // The document's REAL save state. A settle failure used to reach
          // nothing at all while the editor's own timer kept saying "Saved" —
          // three dogfood journeys watched a doc report Saved over a
          // zero-byte .md. Report every outcome to the renderer that owns it.
          onSaveState: (state, token) => {
            const entry = engineYDocSessions.get(input.sessionId);
            // Pair every outcome with ITS OWN start BY TOKEN. Not by order:
            // an aborting settle never queues on settleChain, and
            // settleChain is per generation while this state is per session.
            const seq = !entry
              ? 0
              : state === "settling"
                ? noteSettleStart(entry.saveSeq, token)
                : noteSettleOutcome(entry.saveSeq, token);
            sendEngineYDocSaveState(
              sender,
              generation,
              input.sessionId,
              state,
              seq,
            );
          },
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
      } catch (error) {
        // Secret path, already-live, or an uncaptured artifact: fall back
        // gracefully — but never silently. A refusal here downgrades the doc to
        // the plain editor, and an unlogged permanent refusal is
        // indistinguishable from intended fallback (it hid a dead engine editor
        // for weeks). Only path-not-in-version sets the flag below; an
        // uncaptured artifact is really on disk, so claiming the version does
        // not have it would be false.
        console.error(
          `[desktop] engine Y.Doc open refused for ${input.path}:`,
          error,
        );
        return OpenEngineYDocSessionResult.parse({
          available: false,
          ...(isYDocPathNotInVersionError(error) ? { notInVersion: true } : {}),
        });
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
      // The daemon honors the requested kind only for state-free markers; a
      // lineage with durable state keeps its own. Binding the rich editor's
      // body fragment onto a plaintext session is silent data loss (empty doc
      // over a non-empty file, typed edits pruned at close) — refuse and fall
      // back to the plain editor, loudly.
      if (session.contentKind !== "richdoc") {
        console.error(
          `[desktop] engine Y.Doc open for ${input.path} came back ${session.contentKind}; ` +
            "falling back to the plain editor (kind-mismatched lineage).",
        );
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
        sender,
        generation,
        saveSeq: createEngineYDocSaveSeqState(),
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
    // an update must never write into a shared view. The IPC answer stays an
    // inert no-op (it must never throw), but the edit IS being discarded, so
    // the document must not be left implying it is still on its way to disk.
    if (sharedViewOf(entry.workspaceId)) {
      sendEngineYDocSaveState(
        entry.sender,
        entry.generation,
        input.sessionId,
        "read-only",
        input.seq,
      );
      return;
    }
    // Count the edit when it REACHES the settle, not when it arrives here.
    // The session queues updates, so hand-over runs ahead of journaling: a
    // settle armed by an earlier update would otherwise start while this one
    // is still queued and report "Saved" for content it never carried — the
    // indicator read Saved over a half-written 140 KiB document (#514).
    entry.session.applyLocalUpdate(input.update, () =>
      noteLocalEdit(entry.saveSeq, input.seq),
    );
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

// Test-only daemon restart seam (hermetic E2E: the daemon-kill spec needs the
// outage to outlive the transport retry window, which production restarts far
// too fast to reach). Ignored outside DOHC_DESKTOP_TEST like every other
// DOHC_TEST_* seam.
function testEngineRestartOverrides(): {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
} {
  if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return {};
  const backoff = Number(process.env.DOHC_TEST_ENGINE_RESTART_BACKOFF_MS);
  if (!Number.isFinite(backoff) || backoff <= 0) return {};
  return { initialBackoffMs: backoff, maxBackoffMs: backoff };
}

async function startRustEngineDaemon(): Promise<boolean> {
  // Everything, including resolving the binary path, runs inside the try: a
  // throw while BUILDING the options would otherwise reject this whenReady
  // callback and leave the user with no dialog, on the one path whose job is
  // to explain that the engine could not start.
  try {
    rustEngineDaemon = createRustEngineDaemon({
      ...testEngineRestartOverrides(),
      command: defaultEngineBinaryPath({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      }),
      onFailure: (error, terminal) => {
        // The supervisor's diagnostic is for us: it names engine.ping, probe
        // counts and wedge budgets, which tell a developer or an agent exactly
        // which limit was hit. It goes to the log in full.
        console.error("[desktop] Rust engine daemon:", error);
        if (terminal && !quitting) {
          // The dialog is for the user, so it says what broke and what to do
          // instead — no internal names, one instruction per sentence
          // (docs/brand/copy.md). "The workspace engine" is the noun the
          // shipping UI already uses for this (SettingsDialog, StatusBar,
          // NoticeCenter), so this must not invent another one.
          //
          // Cause-neutral on purpose: a terminal failure also arrives from the
          // restart limit and the crash window, where the engine crashed
          // rather than went silent. Every one of them ends the same way.
          dialog.showErrorBox(
            "The workspace engine stopped",
            "dohc stopped restarting the workspace engine.\n\n" +
              "Restart dohc. If this happens again, review the desktop logs. " +
              "If it continues, reinstall dohc.",
          );
        }
      },
      // A capture event can die with the previous daemon's transport after its
      // moment committed; the replacement never re-emits it (its baseline finds
      // disk and manifest agreeing). One repaint per healthy launch closes that
      // staleness window.
      onLaunch: () => notifyRenderer(),
    });
    await rustEngineDaemon.start();
    // The daemon owns capture: its capture.momentRecorded events are the ONLY
    // signal that a moment landed, so bridge them onto the renderer's
    // workspace-activity ping or the history timeline goes permanently stale.
    bridgeCaptureEventsToRenderer(rustEngineDaemon, notifyRenderer);
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
    await rustEngineDaemon?.stop();
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
    if (!bootstrapComplete) return;
    const window = targetWindow(undefined);
    if (window) {
      void flushPendingOpenPaths(window);
    } else {
      void showOrCreateMainWindow().then(() =>
        flushPendingOpenPaths(targetWindow(undefined)),
      );
    }
  });

  app.on("second-instance", (_event, argv) => {
    if (!bootstrapComplete) {
      pendingOpenPaths.push(...collectOpenWorkspaceArgs(argv));
      return;
    }
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
    // A path the handlers queued during the bootstrap is a later intent than the
    // launch arguments, so it wins. Drain before the window exists: creating it
    // starts the load, so a listener registered after any further await can miss
    // did-finish-load and never send at all.
    const drainedWorkspace = await flushPendingOpenPaths();
    const activatedWorkspace = drainedWorkspace ?? initialActivatedWorkspace;
    const window = createMainWindow({ beforeRendererReload: prepareForRendererReload });
    // Same tick as the window, so the load cannot finish before this listener.
    window.webContents.once("did-finish-load", () => {
      if (activatedWorkspace) sendWorkspaceActivated(window, activatedWorkspace);
      // A path that arrived while the drain above was awaiting is queued behind
      // an open gate, so no later event is guaranteed to flush it. The renderer
      // has subscribed by now, so this one lands — and being last, it wins.
      void flushPendingOpenPaths(window);
    });
    launchMarks.firstWindow();
    desktopMarks.markOnce("first-window");
    // The daemon is up, IPC is registered, and a window exists, so the deferred
    // handlers can act directly.
    bootstrapComplete = true;

    // Load persisted cloud credentials after the first window exists so local
    // workspaces do not pay credential-store I/O on the visible-launch path.
    void warmCredentialCache().then(() => {
      activity.reconcileCloud(engineForWorkspace);
    });

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
  }).catch((error: unknown) => {
    // A throw after the daemon started would otherwise leave the gate closed
    // forever: the app stays alive with no window and every handler deferring
    // to a bootstrap that already died.
    const message =
      error instanceof Error ? error.message : "Unknown desktop startup error.";
    console.error("[desktop] Desktop startup failed:", error);
    dialog.showErrorBox(
      "dohc failed to start",
      `${message}\n\nRestart dohc. If it fails again, review the desktop logs.`,
    );
    app.quit();
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
    if (!bootstrapComplete) return;
    if (BrowserWindow.getAllWindows().length === 0) {
      void showOrCreateMainWindow();
    }
  });
}
