import { preserveNamedLiveDraft } from "./workspaces/namedLiveDraftRecovery";
import { createNamedDesktopLiveCapture } from "./workspaces/namedDesktopLive";
import {
  createDesktopWorkspaceCallbacks,
  type DesktopWorkspaceCallbacksDependencies,
} from "./workspaces/desktopWorkspaceCallbacks";
import { createWorkspaceFileProtocolHandler } from "./security/workspaceFileProtocol";
import {readOwnerRestoreResponse} from "./ipc/readOwnerRestoreResponse";
import { readDatasetResponse } from "./ipc/readDatasetResponse";
import { registerUpdatesIpcHandlers } from "./ipc/updatesIpc";
import { createWindowIpc } from "./ipc/windowIpc";
import {
  devToolsEnabled,
  devToolsPreloadArguments,
  registerDevToolsIpcHandlers,
} from "./ipc/devToolsIpc";
import { createAgentRunsIpc } from "./ipc/agentRunsIpc";
import { detectAgentTools } from "./agents/agentToolDetection";
import { registerAppPreviewIpcHandlers } from "./ipc/appPreviewIpc";
import { registerOwnerAppPublicationIpc, createOwnerAppPublicationHandler } from "./ipc/ownerAppPublicationIpc";
import { createLocalOwnerAppPublicationHandler } from "./ipc/localOwnerAppPublication";
import { createLocalDatasetHost, type LocalDatasetHost } from "./workspaces/localDatasetHost";
import { createInstalledDatasetCompiler } from "./workspaces/installedDatasetCompiler";
import { createDatasetAuthorityRouter, createRemoteDatasetData, createRemoteDatasetTransferTarget, resolveRemoteDatasetRevision } from "./workspaces/remoteDataset";
import { createNamedDatasetData } from "./workspaces/namedDataset";
import { createNamedDatasetCacheRegistry } from "./workspaces/namedDatasetCache";
import { namedDatasetFetch } from "./workspaces/namedDatasetTransport";
import { writeDatasetRecoveryExport } from "./workspaces/datasetRecoveryExport";
import { openRemoteDatasetRecoveryExport } from "./workspaces/remoteDatasetRecoveryExport";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./workspaces/ownerDatasetCopyRegistry";
import { createRemoteDatasetReplicaSource } from "./workspaces/remoteDatasetReplica";
import { createDatasetHandler } from "./ipc/datasetIpc";
import { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { createHash } from "node:crypto";
import { createFile as createDatasetSourceFile } from "./workspaces/workspaceFiles";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "./workspaces/localAppLaunch";
import { createDesktopAppRuntimeLauncher } from "./workspaces/localAppBackendRuntime";
import {registerOwnerAppResponsesIpc,createOwnerAppResponsesHandler} from "./ipc/ownerAppResponsesIpc";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import { createInstalledAppCompiler } from "./workspaces/installedAppCompiler";
import { createPresenceIpc } from "./ipc/presenceIpc";
import { createWorkspaceEngineIpc } from "./ipc/workspaceEngineIpc";
import { createSettingsIpc } from "./ipc/settingsIpc";
import { registerDirectMessagesIpcHandlers, peekReceivedGrantKindForShare } from "./ipc/directMessagesIpc";
import { createChatScopeCapability } from "./ipc/chatScope";
import { registerChatsIpcHandlers } from "./ipc/chatsIpc";
import { workspaceVersionHandlers } from "./ipc/workspaceVersionsIpc";
import { registerShareProposalsIpcHandlers } from "./ipc/shareProposalsIpc";
import { registerSharedViewsIpcHandlers } from "./ipc/sharedViewsIpc";
import { registerCloudIpcHandlers } from "./ipc/cloudIpc";
import { registerSharedChannelsIpcHandlers } from "./ipc/sharedChannelsIpc";
import { registerShareHandoffIpcHandlers } from "./ipc/shareHandoffIpc";
import { createDesktopSharedChannelSync } from "./workspaces/desktopSharedChannelSync";
import { createWorkspaceFilesIpc } from "./ipc/workspaceFilesIpc";
import { registerWorkspaceGraphIpcHandlers } from "./ipc/workspaceGraphIpc";
import { registerNativeMenusIpcHandlers } from "./ipc/nativeMenusIpc";
import {
  createWorkspaceRootApproval,
  registerWorkspaceRegistryIpcHandlers,
  registerOpenWorkspaceIpcHandler,
} from "./ipc/workspaceRegistryIpc";
import { createAppLifecycle } from "./appLifecycle";
import { runInWorkspaceAuthorityLane } from "./workspaces/workspaceAuthorityLane";
import { normalizeAbsolutePath } from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import {
  VersionedLiveAdapter,
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
  session,
  shell,
  Tray,
  utilityProcess,
  webContents,
  WebContentsView,
  type IpcMainInvokeEvent,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PluginPanelSdkEvent,
  PluginStatusChangedEvent,
  McpConfigResult,
  DesktopUserSettingsResult,
  SyncStatusResult,
  RebuildEngineStoreResult,
  WorkspaceSummary,
  UpdateStateEvent,
  ShareHandoffStatus,
  workspaceSearchOperations,
  workspaceVersionOperations,
} from "./ipc/bridgeContract";
import { CHANNELS } from "./ipc/channels";
import { createSitesIpcHandlers } from "./ipc/sitesIpc";
import { registerShareMountIpcHandlers } from "./ipc/shareMountIpc";
import { registerPluginIpcHandlers } from "./ipc/pluginIpcHandlers";
import { createEngineYDocSessionIpc } from "./workspaces/engineYDocSessionIpc";
import type { CollectionRecordEditContext } from "./workspaces/collectionRecordEdits";
import { createWorkspaceFileMutationOwner } from "./workspaces/workspaceFileMutationOwner";
import { workspaceSearchHandlers } from "./ipc/workspaceSearchIpc";
import { registerOperations, type OperationBoundary } from "./ipc/operationTable";

import { createPresencePollRegistry } from "./collab/presencePollRegistry";

import { createDesktopRendererWorkspaceRetirement } from "./mainRendererWorkspaceRetirement";
import { createDesktopPluginSurfaces } from "./plugins/desktopPluginSurfaces";
import { RendererWorkspaceSessionOwner } from "./window/rendererWorkspaceSessionOwner";
import { createExactRendererWorkspaceReferenceOwner } from "./window/exactRendererWorkspaceReference";
import {
  createRendererWorkspaceOperationRunner,
  type ExactRendererWorkspaceOperation,
} from "./window/rendererWorkspaceOperation";
import { desktopMarks } from "./performance/desktopMarks";
import { launchMarks, logLaunchMarksOnce } from "./performance/launchMarks";
import {
  publicUpdateState,
  resolveUpdateChannel,
  startAutoUpdates,
  type AutoUpdateController,
  type PublicUpdateState,
} from "./updates/electronUpdater";
import { initialUpdateState } from "./updates/updateMachine";
import {
  createExitRounds,
  createQuitGuard,
  type ExitKind,
} from "./quitGuard";
import { decideNavigation } from "./security/electronSecurity";
import { createDesktopTray } from "./window/desktopTray";
import { createDesktopWindows } from "./window/desktopWindows";
import { renderHtmlToPdf } from "./window/documentPdfExport";
import {
  allowLoopbackFrameOrigin,
  createMainWindow,
  navigationPolicy,
  rememberChromeTheme,
  titleBarOverlayOptions,
} from "./window/createMainWindow";
import {
  createWorkspaceFolder,
  resetFailedJoinFolder,
  type CreatedWorkspace,
} from "./workspaces/createWorkspaceFolder";
import { createFolder } from "./workspaces/workspaceFiles";
import {
  completePendingEngineStoreMove,
  EngineStoreRecoveryFailedError,
  moveEngineStoreAside,
  withEngineStoreRecoveredUnderEngineStoreLock,
} from "./workspaces/engineStoreRebuild";
import {
  completeWorkspaceJoinBootstrap,
  effectiveHome,
  findWorkspace,
  listWorkspaces,
  markWorkspaceOpened,
  registerWorkspace,
  removeWorkspace,
  setWorkspaceRemote,
  acknowledgeWorkspaceAutomationFailure,
  acknowledgeWorkspaceShareSkips,
  endWorkspaceShareView,
  setWorkspaceShareMounts,
  setWorkspaceShareView,
  setWorkspaceSharedChannels,
  stateDir,
} from "./workspaces/WorkspaceRegistry";
import {
  createWorkspaceAuthorityOwner,
  type WorkspaceAuthorityBinding,
  type WorkspaceAuthorityLease,
  type WorkspaceAuthorityOperation,
  type WorkspaceAuthorityReservation,
} from "./workspaces/workspaceAuthorityOwner";
import {
  type RegistryEntry,
} from "./workspaces/registryStore";
import {
  readableShareLevel,
  shareViewGranterEmail,
  shareViewIsPresent,
} from "./workspaces/shareViewMarker";
import { workspaceWriteRefusal } from "./workspaces/shareWriteGate";
import {
  workspaceSummariesFrom,
  workspaceSummaryFor,
} from "./workspaces/workspaceSummaryProjection";
import {
  assertSharedChannelWritable,
  relayFetchWithTimeout,
  RELAY_FETCH_TIMEOUT_MS,
} from "./workspaces/sharedChannels";
import {
  resolveChatRelayIdentity,
  resolveWorkspaceRelayAuthorId,
  workspaceRemoteMatchesCredentials,
  type ChatRelayIdentityTarget,
} from "./workspaces/chatRelayIdentity";
import { createChatWrites } from "./workspaces/chatWrites";
import { createCloudCredentialStore } from "./workspaces/cloudCredentialStore";
import { createLastKnownDmRequestLanesCache } from "./workspaces/dmRequests";
import { readOrCreateLocalReactorId } from "./workspaces/localReactorId";
import {
  createCloudLogin,
  type CloudLogin,
} from "./workspaces/cloudLogin";
import { createJoinedWorkspaceRunner } from "./workspaces/createJoinedWorkspace";
import { registerRelaySharesIpcHandlers } from "./ipc/relaySharesIpc";
import { requireCredentials } from "./workspaces/credentialScopedOperation";
import { createExactMountOperationRunner } from "./workspaces/exactMountOperation";
import { CredentialSessionCache } from "./workspaces/credentialSessionCache";
import { createRelaySyncEngine } from "./workspaces/relaySyncEngine";
import { awaitCredentialGeneration, chatShareSessionKey, handleRelayUnauthorized, RelaySessionError } from "./mainChatIpcHandlers";
import { mcpCloudEnvironment } from "./agents/mcpCloudEnvironment";
import { buildShareCode, relayUrlsMatch } from "./workspaces/syncCode";
import {
  assertRealMountRoot,
  mountStoreWorkspaceIdFor,
  shareViewFilesMountProjection,
  shareMountRecordsForId,
} from "./workspaces/shareMounts";
import { createShareMountCommands } from "./workspaces/shareMountCommands";
import { createShareSkipRecorder } from "./workspaces/shareSkipRecorder";
import { SharedChannelReadOnlyError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { type ShareAccess } from "@dohc/security-contract/share-selector";
import {
  fetchShareViewInfo,
} from "./workspaces/shareViewInfo";
import { installWorkspaceDataKey } from "./workspaces/workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaces/workspaceKeyEnvelopeEnrollment";
import { bootstrapJoinedWorkspace } from "./workspaces/workspaceJoinEnrollment";
import {
  readWorkspaceDataKeyForEnrollment,
  readWorkspaceSecretState,
} from "./workspaces/workspaceSecretEnrollmentState";
import {
  closeWorkspaceActivityAndRelay,
  createWorkspaceActivity,
  WorkspaceActivityState,
} from "./workspaces/workspaceActivity";
import type { WorkspaceEngineCapture } from "./workspaces/workspaceEngineCapture";
import { probeEngineStoreRefusal } from "./workspaces/workspaceEngineCapture";
import { createDesktopEngine } from "./workspaces/desktopEngine";
import {createServerOwnerConnection} from "./workspaces/serverOwnerConnection";
import { createReceivedShareEngineAccess } from "./workspaces/receivedShareEngineAccess";
import { createCaptureLiveStores } from "./workspaces/workspaceEngineCaptureLiveStore";
import type { ActiveAgentRun } from "./workspaces/workspaceWatcher";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
} from "@dohc/workspace-engine-client/daemon";
import {
  broadcastWorkspaceActivity,
  workspaceActivityPayload,
  type WorkspaceActivityScope,
} from "./ipc/workspaceActivityBroadcast";
import { WorkspaceFileListingCache } from "./workspaces/workspaceFileListingCache";
import { probeRelayWorkspace } from "./workspaces/relayWorkspaceProbe";
import {
  type EngineRelayWorkspaceClient,
} from "./workspaces/engineRelayClient";
// The proposal routes that do not go through the engine: reviewing,
// settling, listing and withdrawing read and write only relay state.
import {
  listMyShareProposals,
  listShareProposals,
  readShareProposal,
  readShareProposalOp,
  settleShareProposal,
  withdrawShareProposal,
} from "./workspaces/shareProposalRelay";
import {
  type AttachedEngineWorkspace,
  type EngineWorkspace,
} from "@dohc/workspace-engine-client/daemon";
import {
  createDesktopLinkedChatStore,
  type DesktopLinkedChatStore,
} from "./workspaces/liveLinkedChatStore";
import {
  captureForWorkspace,
  captureRefusal,
  type EngineFeature,
} from "./workspaces/engineCaptureGate";
import {
  AgentIntegrationState,
  createAgentIntegration,
  type AgentRunRecord,
} from "./agents/AgentIntegration";
import type { AgentSessionManager } from "./agents/AgentSessionManager";
import { createTryInVersionSessions } from "./agents/tryInVersion";
import {
  createChatDispatchService,
  type ChatDispatchPresenceInput,
  type ChatDispatchWorkspace,
} from "./agents/chatDispatchService";
import { isAppImageBoot, resolveDohcMcpCommand } from "./agents/dohcMcpCommand";
import { resolveDohcCliBinDirectory } from "./agents/chatRunnerProcess";
import { refreshLinuxStableCliBin } from "./agents/linuxStableCliBin";
import { CHAT_AGENT_PRESENCE_TOPIC } from "./collab/agentPresence";
import {
  createLiveAgentDispatchStore,
  type LiveAgentDispatchStoreHandle,
} from "./agents/liveAgentDispatchStore";
import { createOwnedSiteCatalog } from "./workspaces/ownedSiteCatalog";
import { createAppPreviewExecution } from "./workspaces/appPreviewExecution";
import {
  WILL_QUIT_BUDGET_MS,
} from "./workspaces/siteRunner";
import { createSitePreviewLifecycle } from "./workspaces/sitePreviewLifecycle";
import { createPluginPanelPreviewStarter } from "./plugins/pluginPanelLifecycle";
import { createDesktopPluginRuntime, type DesktopPluginRuntimeDependencies } from "./plugins/desktopPluginRuntime";
import {
  type PluginPipelineStatusEvent,
} from "./plugins/PluginPipeline";
import {
  createPluginPanelSurfaceHostLease,
  createPluginWebAppHostLease,
} from "./plugins/pluginHostStart";
import { createDesktopPluginSdk } from "./plugins/desktopPluginSdk";
import { PluginWorkspaceRuntimes } from "./plugins/pluginWorkspaceRuntimes";
import {
  type PluginSurfaces,
} from "./plugins/pluginSurfaces";

import {
  resolveWorkspaceFile,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaces/workspaceAssets";
import {
  createShareViewFiles,
  ShareViewFilesState,
  type ShareViewFiles,
  type ShareViewFilesTarget,
} from "./workspaces/shareViewFiles";
import {
  resolveRegisteredShareViewFilesTarget,
  storedShareMounts,
} from "./workspaces/shareViewFilesTarget";
import { createOwnedProjectionRepairer } from "./workspaces/ownedProjectionRepair";
import { createOwnedWorkspaceFileReader } from "./workspaces/ownedWorkspaceFileReader";
import {
  createDesktopWorkspaceReads,
  type DesktopWorkspaceReadsDependencies,
} from "./workspaces/desktopWorkspaceReads";
import {
  workspaceDatabaseWorker,
  createWorkspaceDatabaseAccess,
} from "./workspaces/workspaceDatabase";
import { registerDesktopDatabaseIpcHandlers } from "./ipc/desktopDatabaseIpc";
import { WorkspaceGraphIndex } from "./workspaces/workspaceGraph";

import { createDesktopChatBookmarks, type DesktopChatBookmarkProjectionState } from "./workspaces/desktopChatBookmarks";
import {
  readCachedUserSettingsFile,
  writeUserSettingsFile,
} from "./settings/userSettingsStore";
import { readWorkspaceSettingsFile } from "./workspaces/workspaceSettingsFile";
import { createSearchRegistry } from "./workspaces/workspaceSearch";
import { WorkspaceSearchOwner } from "./workspaces/workspaceSearchOwner";
import { createWorkspaceSearchDaemonQuery } from "./workspaces/workspaceSearchDaemon";
import { rgPath } from "@vscode/ripgrep";
import { createDesktopCliServer } from "./cli/desktopCliServer";
import {
  startCliServer,
  type CliRunMessageLink,
} from "./cli/cliServer";
import { makeProcessDiagnosticsNonFatal } from "./process/stdioResilience";
import {
  createShareHandoffIntentSlot,
  registerShareHandoffProtocol,
} from "./shareHandoffIngress";
import { createShareHandoffRedemptionCoordinator } from "./shareHandoffRedemption";

// A launcher that exited leaves main's stdout/stderr a pipe with no reader, and
// a pipe write throws synchronously. Diagnostics must never be able to crash the
// app they are diagnosing. This runs before main does any work; module-eval-time
// logging in the imports above is still unguarded, which is why this stays a
// top-level statement rather than moving inside app.whenReady.
makeProcessDiagnosticsNonFatal();

const shareHandoffIntentSlot = createShareHandoffIntentSlot();
registerShareHandoffProtocol(app, process);

// Custom scheme that serves a workspace file's bytes to the renderer:
//   dohc-file://<workspaceId>/<relative/path>
// Registered privileged so the renderer can fetch() text and use it as
// <img>/<audio> src, without piping large binaries through IPC as base64.
// Must be declared before app `ready`.
const DOHC_FILE_SCHEME = "dohc-file";
const { workerDatabaseReader, editWorkspaceDatabaseInWorker } =
  createWorkspaceDatabaseAccess(workspaceDatabaseWorker);
const {
  shareViewFilesTargetForPath,
  readOwnedWorkspaceText,
  readOwnedWorkspaceTextFor,
  readOwnedWorkspaceAsset,
  readOwnedWorkspaceAssetFor,
  listOwnedWorkspaceFilesFor,
  ownedWorkspaceReadsFor,
} = createDesktopWorkspaceReads({
  withPhysicalWorkspaceOperation,
  withEngineAdapter,
  isRecordValue,
  get desktopEngine(): DesktopWorkspaceReadsDependencies["desktopEngine"] {
    return desktopEngine;
  },
  get shareViewFiles(): DesktopWorkspaceReadsDependencies["shareViewFiles"] {
    return shareViewFiles;
  },
  get receivedShareEngine(): DesktopWorkspaceReadsDependencies["receivedShareEngine"] {
    return receivedShareEngine;
  },
  get ensureOwnedProjectionTargetCurrent(): DesktopWorkspaceReadsDependencies["ensureOwnedProjectionTargetCurrent"] {
    return ensureOwnedProjectionTargetCurrent;
  },
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: DOHC_FILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function requireWorkspace(workspaceId: string) {
  const workspace = findWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

// PR 18 read-only shared views: a shared view is a read-only local workspace.
// `sharedViewOf` is the one authoritative predicate; every mutation surface
// (file writes, agent runs, and the MCP config)
// routes through it so a shared view can never be changed, only read. The
// renderer also hides its edit affordances; this main-process layer is the
// enforcement that cannot be skipped.
function sharedViewOf(workspaceId: string): {
  granterEmail: string | null;
  // The level the PINNED grant names, or null when the grant cannot be read.
  // Every caller that asks only "is this a share view?" reads the object's
  // presence and never these two, so PRESENCE stays the answer to that
  // question wherever it is asked.
  access: ShareAccess | null;
  ended: boolean;
} | null {
  const entry = findWorkspace(workspaceId);
  if (!entry) return null;
  // PRESENCE, not truthiness. A stored `shareView: null` is a share view
  // whose marker lost its value, not a workspace that never had one, and
  // `?? null` read the two as the same thing — which made someone else's
  // files writable here. Only an absent field is an ordinary
  // workspace; anything else stays refused, readable marker or not.
  if (!shareViewIsPresent(entry.shareView)) return null;
  const marker: Record<string, unknown> = isRecordValue(entry.shareView)
    ? entry.shareView
    : {};
  return {
    granterEmail: shareViewGranterEmail(entry.shareView),
    access: readableShareLevel(marker.grantedSelector),
    ended: marker.ended === true,
  };
}

// The workspace write boundary, over the rule in `shareWriteGate.ts`. It
// refuses on the PRESENCE of a share view at every level, which is what the
// 27 handlers behind it need: they write the workspace FOLDER, and a share
// view's folder is a projection of its engine store. The file changes an edit
// grant admits are routed through ShareViewFiles instead of this disk gate.
function assertWritableWorkspace(workspace: { workspaceId: string }): void {
  const refusal = workspaceWriteRefusal(findWorkspace(workspace.workspaceId)?.shareView);
  if (refusal) throw new Error(refusal);
}

// Agents may read a shared view (the copyable MCP config serves a read-only
// profile), but a managed agent run writes into the workspace, so it is
// refused with honest copy.
function assertAgentRunnableWorkspace(workspaceId: string): void {
  if (sharedViewOf(workspaceId)) {
    throw new Error("Agents can't run in a shared view — it's read-only.");
  }
}

let autoUpdateController: AutoUpdateController | null = null;

// app.getAppPath() is unreliable here: when Electron is launched with a
// direct script path (as the e2e harness does, and as a plain built binary
// is), it resolves to the launched script's own directory (dist/main) rather
// than the package root, with no upward package.json search — it silently
// pointed pnpm resolution at dist/main/resources and broke every plugin
// install (the e2e caught this). import.meta.dirname is the currently
// executing module's own directory (dist/main at runtime, exactly like
// the plugin runtime factory's sibling plugin-host.js resolution below), so two
// levels up reaches apps/desktop deterministically regardless of how
// Electron was launched. Every dev-mode resolver walks from here, so this
// one call site is the only place that encodes that layout.
function desktopPackageRootInDev(): string {
  return join(import.meta.dirname, "..", "..");
}

function pluginResourcesBasePath(): string {
  return app.isPackaged
    ? process.resourcesPath
    : join(desktopPackageRootInDev(), "resources");
}

function notifyPluginStatusChanged(
  workspaceId: string,
  event: PluginPipelineStatusEvent,
): void {
  // Emitted from a queueMicrotask with no catch above it, so a payload that
  // fails the IPC schema is dropped and logged — it must never become an
  // uncaught main-process exception.
  const payload = PluginStatusChangedEvent.safeParse({ workspaceId, ...event });
  if (!payload.success) {
    console.error(
      `[desktop] dropped a plugin status event for ${workspaceId} that ` +
        `failed the IPC schema: ${payload.error.message}`,
    );
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (
      rendererWorkspaceSessions.current(win.webContents)?.workspaceId !==
      workspaceId
    ) {
      continue;
    }
    win.webContents.send(CHANNELS.pluginStatusChanged, payload.data);
  }
}

// An automation claim failed (settled by this desktop's executor, or
// inserted failed by the engine at the depth cap): poke the windows on that
// workspace to re-read the failure notices. A poke, not the record — the
// renderer re-lists through CHANNELS.listAutomationFailures, so nothing
// here can go stale or leak across workspaces.
function notifyAutomationFailuresChanged(workspaceId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (
      rendererWorkspaceSessions.current(win.webContents)?.workspaceId !==
      workspaceId
    ) {
      continue;
    }
    win.webContents.send(CHANNELS.automationFailuresChanged, { workspaceId });
  }
}

function notifyPluginPanelSdkEvent(event: unknown): void {
  const payload = PluginPanelSdkEvent.safeParse(event);
  if (!payload.success) {
    console.error(
      "[desktop] dropped a plugin panel SDK event that failed the IPC " +
        `schema: ${payload.error.message}`,
    );
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (
      rendererWorkspaceSessions.current(win.webContents)?.workspaceId !==
      payload.data.workspaceId
    ) {
      continue;
    }
    win.webContents.send(CHANNELS.pluginPanelSdkEvent, payload.data);
  }
}

const {
  withWorkspaceAttachment,
  withWorkspaceAttachmentAsync,
  createRelayOnChange,
  onWatcherBatch,
} = createDesktopWorkspaceCallbacks<DesktopWorkspaceAuthorityState>({
  findWorkspace,
  requireWorkspaceAuthority,
  notifyRenderer,
  get workspaceAuthorities(): DesktopWorkspaceCallbacksDependencies<DesktopWorkspaceAuthorityState>["workspaceAuthorities"] {
    return workspaceAuthorities;
  },
  get pluginWorkspaceRuntimes(): DesktopWorkspaceCallbacksDependencies<DesktopWorkspaceAuthorityState>["pluginWorkspaceRuntimes"] {
    return pluginWorkspaceRuntimes;
  },
  get chatDispatchService(): DesktopWorkspaceCallbacksDependencies<DesktopWorkspaceAuthorityState>["chatDispatchService"] {
    return chatDispatchService;
  },
});

let linuxStableCliBinDir: string | undefined;

const createPluginWorkspaceRuntimeParts = createDesktopPluginRuntime({
  utilityProcess, stateDir, pluginResourcesBasePath,
  requireWorkspaceAuthority, withWorkspaceAttachment, withEngineAdapter,
  findWorkspace, ownedWorkspaceReadsFor,
  sharedViewOf, notifyAutomationFailuresChanged,
  pluginHostEntry: join(import.meta.dirname, "plugin-host.js"),
  pnpmRunnerEntry: join(import.meta.dirname, "pnpm-runner.js"),
  get workspaceAuthorities(): DesktopPluginRuntimeDependencies["workspaceAuthorities"] {
    return workspaceAuthorities;
  },
  get workspaceActivity(): DesktopPluginRuntimeDependencies["workspaceActivity"] {
    return workspaceActivity;
  },
  get invokeWorkspacePluginSdk(): DesktopPluginRuntimeDependencies["invokeWorkspacePluginSdk"] {
    return invokeWorkspacePluginSdk;
  },
});

const executeAppPreview = createAppPreviewExecution({
  get shareViewFiles() { return shareViewFiles; },
  get shareViewFilesTargetForPath() { return shareViewFilesTargetForPath; },
});

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
    });
  }
  return cachedCloudLogin;
}

// Live file-watch → history pipeline. Pushes a renderer notification whenever
// a settled batch is recorded so the file tree, timeline, and sync status
// refresh without polling. A scoped push reaches only windows whose active
// workspace matches — the pluginStatusChanged rule — so a window on
// workspace B never refetches its world for workspace A's activity. Only a
// genuinely cross-workspace event (logout, registry change, daemon
// relaunch) broadcasts scope-free.
const workspaceFileListings = new WorkspaceFileListingCache();

function notifyRenderer(scope?: WorkspaceActivityScope): void {
  const activityEvent = workspaceActivityPayload(scope);
  workspaceFileListings.invalidate(activityEvent);
  invalidateWorkspaceGraphIndexes(activityEvent);
  broadcastWorkspaceActivity({
    windows: BrowserWindow.getAllWindows(),
    activeWorkspaceIdOf: (webContentsId) => {
      const sender = webContents.fromId(webContentsId);
      return sender
        ? rendererWorkspaceSessions.current(sender)?.workspaceId
        : undefined;
    },
    scope,
  });
}

// A cloud session transition (login, logout, account switch, or a relay
// proving the session dead) re-scopes every renderer cache tied to the
// signed-in account. The generic activity ping deliberately reaches only
// cheap local refreshes, so account-scoped caches get their own signal. It
// carries the new session's key so a same-account token rotation invalidates
// nothing.
// The phase completes the two-moment contract: "changing" is transition
// start (views preserve same-session state and ask for nothing — the
// credential cache is mid-transition), "ready" is adoption end (views run
// their one revalidation against the settled session).
function notifyCloudSessionChanged(phase: "changing" | "ready"): void {
  notifyCloudSessionChangedWithKey(chatShareSessionKey(cachedCredentials), phase);
}
function notifyCloudSessionChangedWithKey(
  sessionKey: string | null,
  phase: "changing" | "ready",
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.cloudSessionChanged, { sessionKey, phase });
  }
}

function workspaceSummaries(): WorkspaceSummary[] {
  return workspaceSummariesFrom(listWorkspaces());
}

// Main's single dev-tools decision: gates the dev channels and is handed to
// every renderer's preload, so a packaged app with the env var set shows
// nothing.
const devToolsGranted = devToolsEnabled(process.env, app);

const desktopWindows = createDesktopWindows({
  app, BrowserWindow, Menu, dialog, process, workspaceSummaries, currentUpdateState,
  stateDir, readCachedUserSettingsFile, writeUserSettingsFile, createMainWindow,
  preloadArguments: devToolsPreloadArguments(devToolsGranted),
  get pluginSurfaces(): { applyWebAppZoom(level: number): void } { return pluginSurfaces; },
  get rendererWorkspaceSessions(): Pick<
    RendererWorkspaceSessionOwner<WebContents>, "current" | "retireForReload" | "retireAfterCrash"
  > { return rendererWorkspaceSessions; },
  get exitRounds() { return exitRounds; },
});
const {
  workspaceWindows,
  prioritizePreferredWorkspace,
  trackWorkspaceWindow,
  liveWorkspaceWindow,
  targetWindow,
  sendWorkspaceActivated,
  applyZoomLevelToWindows,
  bindGuestZoom,
  enqueueUserSettingsWrite,
  stepWindowZoom,
  refreshApplicationMenu,
  refreshNativeWorkspaceSurfaces,
  prepareForRendererReload,
  prepareAfterRendererCrash,
  showOrCreateMainWindow,
} = desktopWindows;
const { createPluginWebAppContainer, createPluginSurfaces } =
  createDesktopPluginSurfaces<WebContents, WebContentsView>({
    BrowserWindow, WebContentsView, webContents, session, bindGuestZoom,
    allowLoopbackFrameOrigin, withWorkspaceAttachment,
    get rendererWorkspaceSessions(): RendererWorkspaceSessionOwner<WebContents> {
      return rendererWorkspaceSessions;
    },
  });

// Synchronous mirror of the credential store for status derivation (the
// status handler path is hot). Refreshed at ready, login, and logout.
type CloudSessionCredentials = NonNullable<
  Awaited<ReturnType<CloudLogin["credentials"]>>
>;
let cachedCredentials: CloudSessionCredentials | null = null;
const ownerDatasetCopies = createOwnerDatasetCopyRegistry();
const namedDatasetPages = createNamedDatasetCacheRegistry({ directory: () => join(stateDir(), "named-dataset-pages") });
let credentialCacheGeneration = 0;
let ownerDeliveryCredentialLifetime = new AbortController();
// Share kind is relay/account-scoped, not workspace-scoped. Keep one cache
// across physical workspaces in the same session, and clear it whenever that
// credential session ends or changes.
const peekedReceivedGrantKinds = new Map<string, "dm" | "not-dm">();
const credentialSessionCache =
  new CredentialSessionCache<CloudSessionCredentials>((snapshot) => {
    ownerDeliveryCredentialLifetime.abort();
    ownerDeliveryCredentialLifetime = new AbortController();
    cachedCredentials = snapshot.credentials;
    credentialCacheGeneration = snapshot.generation;
    void ownerDatasetCopies.credentialsChanged(snapshot.credentials ? datasetCopyOwnerKey(snapshot.credentials) : null)
      .catch(error => console.error("Collection copy cleanup failed", error));
    // A credential load publishes a temporary null first. Keep saved pages until the account is known.
    if (snapshot.credentials) void namedDatasetPages.credentialsChanged(datasetCopyOwnerKey(snapshot.credentials))
      .catch(error => console.error("Saved Collection page cleanup failed", error));
    shareHandoffRedemption.credentialsChanged();
  });
async function refreshCredentialCache(): Promise<void> {
  try { await credentialSessionCache.refresh(() => cloudLogin().credentials()); }
  finally { if (!cachedCredentials) await namedDatasetPages.credentialsChanged(null); }
}
async function warmCredentialCache(): Promise<void> {
  await credentialSessionCache.warm(() => cloudLogin().credentials());
  if (!cachedCredentials) await namedDatasetPages.credentialsChanged(null);
}
function clearCachedCredentials(): void {
  credentialSessionCache.clear();
  void namedDatasetPages.credentialsChanged(null).catch(error => console.error("Saved Collection page cleanup failed", error));
  peekedReceivedGrantKinds.clear();
  // #742 P1 SECURITY (rounds 4–5): every credential-cache clear is a session
  // transition (login adoption, logout, or a current-session 401 — all three
  // call this one function). Clearing here, not at each call site
  // individually, is what makes sure a new account's first failed poll can
  // never be served the previous account's cached request rows, sender
  // emails included, regardless of which of the three paths ended the
  // session.
  for (const workspaceId of workspaceAuthorities.workspaceIds()) {
    const lease = workspaceAuthorities.acquire(workspaceId);
    try {
      lease.state.lastKnownDmRequestLanes.clear();
    } finally {
      lease.release();
    }
  }
}

function publishShareHandoffStatus(status: ShareHandoffStatus): void {
  const publicStatus = ShareHandoffStatus.parse(status);
  if (!app.isReady()) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.shareHandoffStatus, publicStatus);
  }
}

const shareHandoffRedemption = createShareHandoffRedemptionCoordinator({
  intent: shareHandoffIntentSlot,
  createStatusId: randomUUID,
  credentialSnapshot: () => credentialSessionCache.snapshot(),
  fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
  handleUnauthorized: (requestCredentials) =>
    handleRelayUnauthorized({
      requestCredentials,
      currentCredentials: cachedCredentials,
      clearCachedCredentials: () => clearCachedCredentials(),
      notifySessionChanging: () => notifyCloudSessionChanged("changing"),
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
      invalidatePersistedSessionIf: (expected) =>
        cloudLogin().invalidateSessionIf(expected),
    }),
  publishStatus: publishShareHandoffStatus,
});

async function loadAndCacheCurrentCredentials(): Promise<CloudSessionCredentials | null> {
  const loaded = await credentialSessionCache.adoptCurrent(() =>
    cloudLogin().credentials(),
  );
  if (!loaded.current) {
    throw new Error("Your server session changed. Try again.");
  }
  return loaded.credentials;
}

// Trailing-slash-insensitive server-URL compare: the registry's recorded
// serverUrl must match the server that issued the cached token, or the workspace
// stays local-only. Otherwise machine B's token could be POSTed to server A
// (account takeover) and a re-pointed registry could mass-delete.
function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
async function remoteForWorkspace(workspace: RegistryEntry) {
  await warmCredentialCache();
  const credentialGeneration = credentialCacheGeneration;
  const remote = workspace.remote;
  if (!remote) throw new Error("Sync this workspace before sharing.");
  const credentials = requireCredentials(cachedCredentials);
  if (!workspaceRemoteMatchesCredentials(remote, credentials)) {
    if (
      normalizeServerUrl(credentials.serverUrl) !==
      normalizeServerUrl(remote.serverUrl)
    ) {
      throw new Error("Sign in to the cloud server this workspace uses.");
    }
    throw new Error("Sign in to the account that synced this workspace.");
  }
  return { credentials, credentialGeneration };
}

// Relay-share HTTP: grant-side calls go to the SYNC RELAY (not the
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
      return "No account on this server matches that email. Ask them to create an account here, then share again.";
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

type RelayShareRetainedDependentSetResult<T> =
  | { kind: "success"; body: T }
  | { kind: "dependents-changed"; body: unknown; status: number };

type RelayShareRetainedNotFoundResult<T> =
  | { kind: "success"; body: T }
  | { kind: "missing" };

type RelayShareJsonOptions =
  | { retainDependentSetConflict: true }
  | { retainNotFound: true }
  | { retainRestoreConflict: true };

const relayShareFetch = relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS);

async function relayShareResponseWithCredentials(
  credentials: CloudSessionCredentials, path: string, init: RequestInit,
  classifyNamedOffline = false,
): Promise<Response> {
  if (!credentials.relayUrl) throw new Error("Reconnect your sharing server, then try again.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${credentials.token}`);
  const fetchResponse = (signal = init.signal) => relayShareFetch(`${normalizeServerUrl(credentials.relayUrl!)}${path}`, {
    ...init, signal, headers, redirect: "error", cache: "no-store", credentials: "omit",
  });
  const response = await (classifyNamedOffline ? namedDatasetFetch(fetchResponse, init.signal) : fetchResponse());
  if (response.status === 401) {
    await handleRelayUnauthorized({
      requestCredentials: credentials, currentCredentials: cachedCredentials,
      clearCachedCredentials: () => clearCachedCredentials(),
      notifySessionChanging: () => notifyCloudSessionChanged("changing"),
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
      invalidatePersistedSessionIf: expected => cloudLogin().invalidateSessionIf(expected),
    });
  }
  return response;
}

async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init: RequestInit | undefined,
  options: {retainRestoreConflict: true},
): Promise<T>;
async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init?: RequestInit,
): Promise<T>;
async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init: RequestInit | undefined,
  options: { retainDependentSetConflict: true },
): Promise<RelayShareRetainedDependentSetResult<T>>;
async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init: RequestInit | undefined,
  options: { retainNotFound: true },
): Promise<RelayShareRetainedNotFoundResult<T>>;
async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init?: RequestInit,
  options?: RelayShareJsonOptions,
): Promise<
  | T
  | RelayShareRetainedDependentSetResult<T>
  | RelayShareRetainedNotFoundResult<T>
> {
  if (!credentials.relayUrl) {
    throw new Error("Reconnect your server to refresh its connection settings, then try again.");
  }
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${credentials.token}`);
  const response = await relayShareFetch(
    `${normalizeServerUrl(credentials.relayUrl)}${path}`,
    { ...init, headers },
  );
  if (response.status === 401) {
    // The relay proved a session invalid — but only the session this request
    // used. handleRelayUnauthorized acts if and only if that is still the
    // current one, and then completely: memory, broadcast, persistent store.
    const sessionWasCurrent = await handleRelayUnauthorized({
      requestCredentials: credentials,
      currentCredentials: cachedCredentials,
      clearCachedCredentials: () => clearCachedCredentials(),
      notifySessionChanging: () => notifyCloudSessionChanged("changing"),
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
      invalidatePersistedSessionIf: (expected) =>
        cloudLogin().invalidateSessionIf(expected),
    });
    throw new RelaySessionError(
      "Your server session expired. Sign in again, then retry.",
      { sessionWasCurrent },
    );
  }
  const datasetRoute = /^\/sync\/(?:shares\/)?[^/]+\/datasets(?:\/([0-9a-f-]{36})(?:\/([a-z]+))?)?(?:\?|$)/.exec(path);
  const data = (datasetRoute
    ? await readDatasetResponse(response, datasetRoute[2] ?? (datasetRoute[1] ? "describe" : "list"), init?.signal ?? new AbortController().signal)
    : options && "retainRestoreConflict" in options
    ? await readOwnerRestoreResponse(response)
    : await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    code?: string;
    [key: string]: unknown;
  }
    | null;
  if (!response.ok || data?.ok === false) {
    if (options && "retainRestoreConflict" in options && response.status === 409 && data && "status" in data && "result" in data) {
      return data as T;
    }
    if (
      options &&
      "retainDependentSetConflict" in options &&
      response.status === 409 &&
      data?.ok === false &&
      data.code === "dependents_changed"
    ) {
      return { kind: "dependents-changed", body: data, status: response.status };
    }
    if (
      options &&
      "retainNotFound" in options &&
      response.status === 404 &&
      data?.ok === false &&
      data.code === "not_found"
    ) {
      return { kind: "missing" };
    }
    throw new Error(relayShareErrorCopy(response.status, data));
  }
  if (options && !("retainRestoreConflict" in options)) {
    return { kind: "success", body: data as T };
  }
  return data as T;
}

async function relayShareJson<T>(path: string, init?: RequestInit): Promise<T> {
  await warmCredentialCache();
  const credentials = requireCredentials(cachedCredentials, RelaySessionError);
  return relayShareJsonWithCredentials(credentials, path, init);
}

// MU-C4 shared channels: one best-effort refresh pass over every shared
// channel this workspace has joined — push the member's local channel ops,
// pull everyone else's. Never throws (transient failures log and retry on
// the next pass); a revoked share is marked ended in the registry so it
// stops syncing while the local copy stays readable. Runs from the Chats
// IPC surface (fresh on open, prompt push after a send) and from the
// workspace's relay sync engine cadence.
//
// Concurrency: those triggers can fire together for
// the same workspace, and overlapping passes would race the per-share
// cursor/peer state in engine.db — so passes are serialized per workspace
// (queued, never dropped). Every relay request inside a pass is also bounded
// by a timeout so a hung relay can't block the awaited listChatChannels path.

interface DesktopWorkspaceAuthorityState extends DesktopChatBookmarkProjectionState {
  activity: WorkspaceActivityState;
  workspaceGraph: WorkspaceGraphIndex;
  pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace>;
  pluginSurfaces: PluginSurfaces<WebContentsView>;
  sitePreviews: ReturnType<typeof createSitePreviewLifecycle>;
  tryInVersionSessions: ReturnType<typeof createTryInVersionSessions>;
  shareMountCommands: ReturnType<typeof createShareMountCommandsFor>;
  shareViewFiles: ShareViewFilesState;
  operationLanes: Map<string, Promise<void>>;
  sharedChannelSyncCursor: string | null;
  lastKnownDmRequestLanes: ReturnType<
    typeof createLastKnownDmRequestLanesCache
  >;
  agentIntegration: AgentIntegrationState;
  linkedChatStore: DesktopLinkedChatStore | null;
  agentDispatchStoreHandle: LiveAgentDispatchStoreHandle | null;
  dispatchAgentRunId: string | null;
  dispatchSync: Promise<boolean> | null;
  retainedActivity: boolean;
  activityOpening: Promise<SyncStatusResult> | null;
  activityClosing: Promise<void> | null;
  pendingCliRunMessageLinks: Set<string>;
  lastEngineStoreRebuildResult: RebuildEngineStoreResult | null;
}

type DesktopWorkspaceAuthorityLease = WorkspaceAuthorityLease<
  RegistryEntry,
  DesktopWorkspaceAuthorityState
>;

type DesktopWorkspaceOperation = WorkspaceAuthorityOperation<
  RegistryEntry,
  DesktopWorkspaceAuthorityState
>;

function createDesktopWorkspaceAuthorityState(
  binding: WorkspaceAuthorityBinding<RegistryEntry>,
): DesktopWorkspaceAuthorityState {
  const pluginRuntimes = new PluginWorkspaceRuntimes<CreatedWorkspace>({
    assertWritable: assertWritableWorkspace,
    isOpen: () =>
      rendererWorkspaceSessions.isAttachmentOpen(binding.attachmentId),
    create: createPluginWorkspaceRuntimeParts,
    onPipelineStatus: (workspaceId, event) => {
      withWorkspaceAttachment(
        { workspaceId, attachmentId: binding.attachmentId },
        () => notifyPluginStatusChanged(workspaceId, event),
      );
    },
    onCleanupError: (workspaceId, error) => {
      console.warn(
        `[desktop] failed to clean up plugins for workspace "${workspaceId}"`,
        error,
      );
    },
  });
  const pluginSurfaces = createPluginSurfaces(binding, pluginRuntimes);
  return {
    activity: new WorkspaceActivityState(),
    workspaceGraph: new WorkspaceGraphIndex(),
    pluginRuntimes,
    pluginSurfaces,
    sitePreviews: createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    }),
    tryInVersionSessions: createTryInVersionSessionsFor(binding),
    shareMountCommands: createShareMountCommandsFor(binding),
    shareViewFiles: new ShareViewFilesState(),
    operationLanes: new Map(),
    sharedChannelSyncCursor: null,
    lastKnownDmRequestLanes: createLastKnownDmRequestLanesCache(),
    bookmarkProjectionPending: false,
    bookmarkProjectionRunning: false,
    agentIntegration: new AgentIntegrationState(),
    linkedChatStore: null,
    agentDispatchStoreHandle: null,
    dispatchAgentRunId: null,
    dispatchSync: null,
    retainedActivity: false,
    activityOpening: null,
    activityClosing: null,
    pendingCliRunMessageLinks: new Set(),
    lastEngineStoreRebuildResult: null,
  };
}

type PhysicalRelayWorkspace = Pick<
  RegistryEntry,
  "workspaceId" | "rootPath" | "shareMounts"
> & { attachmentId: symbol };

function workspaceSessionTargetForPhysicalWorkspace(
  targetWorkspaceId: string,
  workspace: PhysicalRelayWorkspace,
): string | EngineWorkspace {
  if (targetWorkspaceId !== workspace.workspaceId) return targetWorkspaceId;
  return {
    workspaceId: workspace.workspaceId,
    rootPath: workspace.rootPath,
    attachmentId: workspace.attachmentId,
  };
}

function relayCloseTargetsForPhysicalWorkspace(
  workspace: PhysicalRelayWorkspace,
): Array<string | EngineWorkspace> {
  const mountStoreWorkspaceIds = new Set(
    storedShareMounts(workspace).map((mount) =>
      mountStoreWorkspaceIdFor(workspace.workspaceId, mount.shareId),
    ),
  );
  return [
    workspaceSessionTargetForPhysicalWorkspace(
      workspace.workspaceId,
      workspace,
    ),
    ...mountStoreWorkspaceIds,
  ];
}

const workspaceAuthorities = createWorkspaceAuthorityOwner({
  findWorkspace,
  canonicalizeRoot: (rootPath) => realpathSync.native(rootPath),
  createState: createDesktopWorkspaceAuthorityState,
  disposeState: async (state, binding, workspaceAtDisposal) => {
    const physicalWorkspace = {
      ...workspaceAtDisposal,
      rootPath: binding.canonicalRootPath,
      attachmentId: binding.attachmentId,
    };
    const relayCloseTargets =
      relayCloseTargetsForPhysicalWorkspace(physicalWorkspace);
    const results = await Promise.allSettled([
      state.linkedChatStore?.close() ?? Promise.resolve(),
      state.agentDispatchStoreHandle?.close() ?? Promise.resolve(),
      Promise.resolve().then(() =>
        agentIntegration.disposeState(state.agentIntegration),
      ),
      state.pluginRuntimes.stop(binding.workspaceId, () =>
        state.pluginSurfaces.stop({
          kind: "workspace",
          workspaceId: binding.workspaceId,
        }),
      ),
      state.sitePreviews.stopWorkspace(binding.workspaceId),
      state.tryInVersionSessions.settled(),
      ...relayCloseTargets.map((target) => closeRelayTransportWorkspace(target)),
      engineYDocSessionIpc.retireAuthority(binding.attachmentId),
      workspaceActivity.close(physicalWorkspace, state.activity, {
        expectedRootPath: binding.canonicalRootPath,
        preserveStatus: false,
      }),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  },
});
function requireWorkspaceAuthority(
  workspaceId: string,
): DesktopWorkspaceAuthorityLease {
  return workspaceAuthorities.acquire(workspaceId);
}

function withPhysicalWorkspaceOperation<Result>(
  workspaceId: string,
  work: (operation: DesktopWorkspaceOperation) => Result | Promise<Result>,
): Promise<Result> {
  return workspaceAuthorities.withOperation(workspaceId, work);
}

type DesktopRendererWorkspaceOperation = ExactRendererWorkspaceOperation<
  DesktopWorkspaceOperation["workspace"],
  DesktopWorkspaceAuthorityState,
  NonNullable<ReturnType<RendererWorkspaceSessionOwner<WebContents>["current"]>>
>;

function withCurrentWorkspaceAttachmentOperation<Result>(
  workspace: { workspaceId: string; attachmentId: symbol },
  work: (operation: DesktopWorkspaceOperation) => Result | Promise<Result>,
): Promise<Result | undefined> {
  let began = false;
  try {
    return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) => {
      if (operation.workspace.attachmentId !== workspace.attachmentId) {
        return undefined;
      }
      began = true;
      return work(operation);
    }).catch((error) => {
      if (!began) return undefined;
      throw error;
    });
  } catch {
    return Promise.resolve(undefined);
  }
}

function invalidateWorkspaceGraphIndexes(event: {
  workspaceId?: string;
  paths?: readonly string[];
}): void {
  const invalidate = (workspaceId: string) =>
    withWorkspaceAttachment({ workspaceId }, (lease) =>
      lease.state.workspaceGraph.invalidate(event.paths),
    );
  if (event.workspaceId) {
    invalidate(event.workspaceId);
    return;
  }
  for (const workspaceId of workspaceAuthorities.workspaceIds()) {
    invalidate(workspaceId);
  }
}

type DesktopPluginWorkspaceRuntimes = Omit<
  Pick<
  PluginWorkspaceRuntimes<CreatedWorkspace>,
  "current" | "ensure" | "stop"
  >,
  "stop"
> & {
  stop(
    workspace: string | { workspaceId: string; attachmentId: symbol },
    beforeDispose: () => Promise<void>,
  ): Promise<void>;
};

const pluginWorkspaceRuntimes: DesktopPluginWorkspaceRuntimes = {
  current(workspaceId) {
    return withWorkspaceAttachment({ workspaceId }, (lease) =>
      lease.state.pluginRuntimes.current(workspaceId),
    );
  },
  ensure(workspace) {
    return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) => {
      if (
        operation.workspace.rootPath !== workspace.rootPath ||
        ("attachmentId" in workspace &&
          workspace.attachmentId !== operation.workspace.attachmentId)
      ) {
        throw new Error("Plugin runtime request belongs to a retired workspace.");
      }
      return operation.state.pluginRuntimes.ensure(operation.workspace);
    });
  },
  stop(workspace, beforeDispose) {
    if (typeof workspace === "string") {
      return workspaceAuthorities.withAuthority(workspace, (lease) =>
        lease.state.pluginRuntimes.stop(workspace, beforeDispose),
      );
    }
    return withCurrentWorkspaceAttachmentOperation(workspace, (operation) =>
      operation.state.pluginRuntimes.stop(workspace.workspaceId, beforeDispose),
    ).then(() => undefined);
  },
};

type WorkspacePluginSurfaceTarget =
  | Parameters<PluginSurfaces<WebContentsView>["stop"]>[0]
  | { kind: "workspace"; workspaceId: string; attachmentId: symbol };

type WorkspacePluginSurfaces = Omit<
  Pick<
    PluginSurfaces<WebContentsView>,
  | "applyWebAppBounds"
  | "authorizePanelSdk"
  | "startPanel"
  | "startWebApp"
  | "stop"
  >,
  "stop"
> & {
  stop(target: WorkspacePluginSurfaceTarget): Promise<void>;
  applyWebAppZoom(level: number): void;
  close(): Promise<void>;
  withPluginSdkGrantSuspensions<Result extends { readonly ok: boolean }>(
    workspaceId: string,
    run: (
      suspend: (identity: { workspaceId: string; pluginId: string }) => void,
    ) => Promise<Result>,
  ): Promise<Result>;
};

const pluginSurfaces: WorkspacePluginSurfaces = {
  startPanel(request, admission) {
    return workspaceAuthorities.withAuthority(request.workspaceId, (lease) =>
      lease.state.pluginSurfaces.startPanel(request, admission),
    );
  },
  startWebApp(request, admission) {
    return workspaceAuthorities.withAuthority(request.workspaceId, (lease) =>
      lease.state.pluginSurfaces.startWebApp(request, admission),
    );
  },
  authorizePanelSdk(request) {
    const lease = requireWorkspaceAuthority(request.workspaceId);
    try {
      return lease.state.pluginSurfaces.authorizePanelSdk(request);
    } finally {
      lease.release();
    }
  },
  applyWebAppBounds(request) {
    return (
      withWorkspaceAttachment({ workspaceId: request.workspaceId }, (lease) =>
        lease.state.pluginSurfaces.applyWebAppBounds(request),
      ) ?? false
    );
  },
  applyWebAppZoom(level) {
    for (const workspaceId of workspaceAuthorities.workspaceIds()) {
      withWorkspaceAttachment({ workspaceId }, (lease) =>
        lease.state.pluginSurfaces.applyWebAppZoom(level),
      );
    }
  },
  stop(target) {
    if (target.kind === "workspace" && "attachmentId" in target) {
      return withCurrentWorkspaceAttachmentOperation(target, (operation) =>
        operation.state.pluginSurfaces.stop({
          kind: "workspace",
          workspaceId: target.workspaceId,
        }),
      ).then(() => undefined);
    }
    if (target.kind !== "sender") {
      return workspaceAuthorities.withAuthority(target.workspaceId, (lease) =>
        lease.state.pluginSurfaces.stop(target),
      );
    }
    return Promise.all(
      workspaceAuthorities.workspaceIds().map((workspaceId) =>
        workspaceAuthorities.withAuthority(workspaceId, (lease) =>
          lease.state.pluginSurfaces.stop(target),
        ),
      ),
    ).then(() => undefined);
  },
  withPluginSdkGrantSuspensions(workspaceId, run) {
    return workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      lease.state.pluginSurfaces.withPluginSdkGrantSuspensions(run),
    );
  },
  close() {
    return Promise.all(
      workspaceAuthorities.workspaceIds().map((workspaceId) =>
        workspaceAuthorities.withAuthority(workspaceId, (lease) =>
          lease.state.pluginSurfaces.close(),
        ),
      ),
    ).then(() => undefined);
  },
};

type SitePreviewLifecycle = Omit<
  ReturnType<typeof createSitePreviewLifecycle>,
  "stopWorkspace"
> & {
  stopWorkspace(
    workspace: string | { workspaceId: string; attachmentId: symbol },
  ): Promise<void>;
};

const sitePreviews: SitePreviewLifecycle = {
  start: (input) =>
    workspaceAuthorities.withAuthority(input.workspaceId, (lease) =>
      lease.state.sitePreviews.start(input),
    ),
  status(workspaceId, siteRoot) {
    const lease = requireWorkspaceAuthority(workspaceId);
    try {
      return lease.state.sitePreviews.status(workspaceId, siteRoot);
    } finally {
      lease.release();
    }
  },
  stop(input) {
    return workspaceAuthorities.withAuthority(input.workspaceId, (lease) =>
      lease.state.sitePreviews.stop(input),
    );
  },
  cancelSender(senderId) {
    for (const workspaceId of workspaceAuthorities.workspaceIds()) {
      withWorkspaceAttachment({ workspaceId }, (lease) =>
        lease.state.sitePreviews.cancelSender(senderId),
      );
    }
  },
  stopWorkspace(workspace) {
    if (typeof workspace === "string") {
      return workspaceAuthorities.withAuthority(workspace, (lease) =>
        lease.state.sitePreviews.stopWorkspace(workspace),
      );
    }
    return withCurrentWorkspaceAttachmentOperation(workspace, (operation) =>
      operation.state.sitePreviews.stopWorkspace(workspace.workspaceId),
    ).then(() => undefined);
  },
  stopAll() {
    return Promise.all(
      workspaceAuthorities.workspaceIds().map((workspaceId) =>
        workspaceAuthorities.withAuthority(workspaceId, (lease) =>
          lease.state.sitePreviews.stopAll(),
        ),
      ),
    ).then(() => undefined);
  },
};

type DesktopWorkspaceAuthorityBinding =
  WorkspaceAuthorityBinding<RegistryEntry>;

function physicalWorkspaceRegistration(workspace: RegistryEntry) {
  return {
    persist: () => registerWorkspace(workspace),
    rollback: () => {
      const current = findWorkspace(workspace.workspaceId);
      if (!current) return;
      if (current.rootPath !== workspace.rootPath) {
        throw new Error(
          "The workspace registry binding changed before registration rollback.",
        );
      }
      removeWorkspace(workspace.workspaceId);
    },
  };
}

// Register, then tell every window: a workspace created or attached from the
// manager window must show up in the other windows' switchers at once.
function registerPhysicalWorkspace(
  workspace: RegistryEntry,
): DesktopWorkspaceAuthorityBinding {
  const binding = workspaceAuthorities.registerBinding(
    workspace,
    physicalWorkspaceRegistration(workspace),
  );
  notifyRenderer();
  return binding;
}

function registerReservedPhysicalWorkspace(
  reservation: WorkspaceAuthorityReservation,
  workspace: RegistryEntry,
): DesktopWorkspaceAuthorityBinding {
  const binding = workspaceAuthorities.registerReservedBinding(
    reservation,
    workspace,
    physicalWorkspaceRegistration(workspace),
  );
  notifyRenderer();
  return binding;
}

// Forget: close every handle the app holds on the workspace and drop its
// registry row. The folder is untouched; opening it again re-adopts the
// manifest and its identity.
async function forgetWorkspace(workspaceId: string): Promise<void> {
  await removePhysicalWorkspace(workspaceAuthorities.currentBinding(workspaceId));
  notifyRenderer();
}

function removePhysicalWorkspace(
  binding: DesktopWorkspaceAuthorityBinding,
  beforeRegistryRemoval: () => void | Promise<void> = () => undefined,
): Promise<void> {
  return workspaceAuthorities.retireBinding(binding, {
    finalize: beforeRegistryRemoval,
    removeBinding: () => {
      const current = findWorkspace(binding.workspaceId);
      if (!current || current.rootPath !== binding.registeredRootPath) {
        throw new Error(
          "The workspace registry binding changed before removal completed.",
        );
      }
      removeWorkspace(binding.workspaceId);
    },
  });
}

async function cleanupFailedPhysicalWorkspace(
  workspaceId: string,
  rootPath: string,
): Promise<void> {
  await closeRelayTransportWorkspace(workspaceId);
  await resetFailedJoinFolder(rootPath);
}

const createJoinedWorkspace = createJoinedWorkspaceRunner({
  reserve: (input) => workspaceAuthorities.reserveBinding(input),
  createFolder: createWorkspaceFolder,
  register: registerReservedPhysicalWorkspace,
  remove: removePhysicalWorkspace,
  release: (reservation, cleanup) =>
    workspaceAuthorities.releaseReservation(reservation, cleanup),
  cleanup: cleanupFailedPhysicalWorkspace,
  rollbackComplete: () => {
    refreshNativeWorkspaceSurfaces();
    notifyRenderer();
  },
  logError: (message, error) => console.error(message, error),
});

const {
  presencePollRegistry, presenceMutationOwner, presenceRelayTransportForScope,
  registerPresenceIpcHandlers,
} = createPresenceIpc<WebContents>({
  warmCredentialCache, currentCredentials: () => cachedCredentials, normalizeServerUrl, findWorkspace,
});
const relayShareDiscussionActivityPolls = createPresencePollRegistry();

const desktopChatBookmarks = createDesktopChatBookmarks({
  findWorkspace, requireWorkspaceAuthority, canonicalWorkspaceFor, linkedChatStoreFor,
  warmCredentialCache, localUserId, sharedViewOf,
  activity: {
    listOpenWorkspaceIds: () => activity.listOpenWorkspaceIds(),
    engineCaptureFor: (workspaceId, rootPath) => activity.engineCaptureFor(workspaceId, rootPath),
  },
});
const { queueChatBookmarkProjection, projectPendingChatBookmarks } = desktopChatBookmarks;

const {
  syncWorkspaceSharedChannels,
  syncRendererWorkspaceSharedChannels,
  syncSharedChannelsForChatTarget,
  syncRendererSharedChannelsForChatTarget,
} = createDesktopSharedChannelSync<
  DesktopWorkspaceAuthorityState,
  DesktopRendererWorkspaceOperation
>({
  workspaceAuthorities,
  findWorkspace,
  warmCredentialCache,
  currentCredentialGeneration: () => credentialCacheGeneration,
  currentCredentials: () => cachedCredentials,
  normalizeServerUrl,
  receivedShareEngine: {
    relayForRegistered: (workspace) => receivedShareEngine.relayForRegistered(workspace),
  },
  setWorkspaceSharedChannels,
  notifyRenderer,
  projectPendingChatBookmarksAfterPull: projectPendingChatBookmarks,
  linkedChatStoreFor,
});

// The copyable MCP launch config for a workspace. The user's AI tool spawns the
// dohc MCP stdio server with these args; --workspace scopes every tool to this
// root (path containment), --home points it at the desktop registry/state dir.
// The command comes from resolveDohcMcpCommand: a packaged install's own
// shipped cli-bin launcher by absolute path, the workspace bin `dohc-mcp` in
// dev, with DOHC_MCP_COMMAND as the explicit override.
// The MCP profile a workspace hands out: `null` for a workspace this
// machine owns, and the share's level for a share view.
//
// The two questions compose, and in this order. PRESENCE decides whether a
// share profile applies at all — a marker whose value was lost is still a
// share view, and reading it as an ordinary workspace would hand out the full
// write-capable server. Readability only decides how much the profile opens,
// so a present marker with no readable grant falls to `view`, which registers
// no write tools at all.
function mcpShareAccessOf(shareView: unknown): ShareAccess | null {
  if (!shareViewIsPresent(shareView)) return null;
  const grantedSelector = isRecordValue(shareView) ? shareView.grantedSelector : undefined;
  return readableShareLevel(grantedSelector) ?? "view";
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MCP_LAUNCHER_UNAVAILABLE_MESSAGE =
  "dohc could not prepare its MCP launcher. Restart dohc to try again.";

function mcpConfigFor(
  rootPath: string,
  shareAccess: ShareAccess | null,
): McpConfigResult {
  const command = resolveDohcMcpCommand({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    linuxStableCliBinDir,
  });
  if (command === null) {
    return {
      unavailable: true,
      message: MCP_LAUNCHER_UNAVAILABLE_MESSAGE,
    };
  }
  const home = stateDir();
  const args = ["--workspace", rootPath, "--home", home];
  // A share view hands out the MCP profile for its level: the launched
  // server registers only the write tools that level grants. `null` is a local
  // workspace, which gets every tool.
  if (shareAccess) args.push("--share-access", shareAccess);
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
  // but if a runtime MCP is ever spawned for one it must carry the share's
  // level — never the full local profile.
  const config = mcpConfigFor(rootPath, mcpShareAccessOf(workspace?.shareView));
  if ("unavailable" in config) throw new Error(config.message);
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
  attachmentId?: symbol;
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}): EngineRelayWorkspaceClient {
  if (!desktopEngine.relayClient) {
    throw new Error("Rust engine relay client is unavailable.");
  }
  return desktopEngine.relayClient.bind(input);
}

function engineForWorkspace(
  workspace: { workspaceId: string; rootPath: string; attachmentId?: symbol },
  capture: WorkspaceEngineCapture | null,
  engineOptions: { joinBootstrap?: boolean } = {},
) {
  const remote = findWorkspace(workspace.workspaceId)?.remote;
  const credentials = cachedCredentials;
  if (!remote || !credentials) return null;
  if (!capture || !credentials.relayUrl) return null;
  if (!workspace.attachmentId) {
    throw new Error("Cloud sync requires a registered workspace attachment.");
  }
  // Only sync when the session belongs to the server this workspace is bound
  // to; a mismatch keeps it local-only (no token leak, no mass-delete).
  if (!workspaceRemoteMatchesCredentials(remote, credentials)) return null;
  const relay = {
    baseUrl: credentials.relayUrl,
    token: credentials.token,
  };
  const daemonRelay = relayClientForWorkspace({
    workspaceId: workspace.workspaceId,
    rootPath: workspace.rootPath,
    attachmentId: workspace.attachmentId,
    relay,
  });
  return createRelaySyncEngine({
    rootDir: workspace.rootPath,
    relay,
    operations: {
      push: () => daemonRelay.push(),
      pull: (materializePage) => daemonRelay.pull(materializePage),
      recoverOrigin: () => daemonRelay.recoverOrigin(),
    },
    capture,
    onChange: createRelayOnChange(workspace),
    // MU-C4: joined shared channels refresh on the same cadence as the
    // workspace's own sync (best-effort; never fails the pass).
    syncSharedChannels: async () => {
      await withWorkspaceAttachmentAsync(workspace, () =>
        syncWorkspaceSharedChannels(workspace.workspaceId),
      );
    },
    // A replicated chat message can mark a live bookmark pending without
    // touching the file watcher. Project immediately after the pull commits;
    // the periodic worker remains only a crash/retry backstop.
    afterSuccessfulPull: () =>
      withWorkspaceAttachmentAsync(workspace, () =>
        projectPendingChatBookmarks(workspace.workspaceId),
      ),
    countOpenConflicts: async () => await capture.countOpenConflicts(),
    // A freshly joined workspace's engine is pull-first: no push before the
    // first successful pull (0P-C gate fix).
    ...(engineOptions.joinBootstrap ? { joinBootstrap: true } : {}),
    ...testSyncTimingOverrides(),
  });
}

const workspaceActivity = createWorkspaceActivity(notifyRenderer, {
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
  // The engine capture gate (engineCaptureGate.ts) owns the shared-view rule:
  // main only states whether the workspace is one, and the decision
  // carries the cause.
  captureFor: (workspace, hooks) =>
    captureForWorkspace(
      {
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        attachmentId: workspace.attachmentId,
        shareView: sharedViewOf(workspace.workspaceId) !== null,
      },
      hooks,
      requireEngineSessions(),
    ),
  // One settled batch, two readers: the approval pipeline, and the plugins
  // that subscribed to a prefix of it. Neither changes the batch.
  onWatcherBatch,
});

function withWorkspaceActivityState<Result>(
  workspaceId: string,
  work: (
    lease: DesktopWorkspaceAuthorityLease,
    workspace: RegistryEntry & { attachmentId: symbol },
  ) => Result,
): Result {
  const lease = requireWorkspaceAuthority(workspaceId);
  try {
    return work(lease, canonicalWorkspaceFor(lease));
  } finally {
    lease.release();
  }
}

// Compatibility-shaped ingress for existing main-process callers. The
// service itself owns no registry: every operation first resolves the current
// physical attachment and then works only with that authority-owned state.
const activity = {
  open: (workspace: RegistryEntry) =>
    workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) =>
      workspaceActivity.open(canonicalWorkspaceFor(lease), lease.state.activity),
    ),
  close: (
    workspaceId: string,
    options?: { preserveStatus?: boolean; notify?: boolean; expectedRootPath?: string },
  ) => {
    if (!findWorkspace(workspaceId)) return Promise.resolve(false);
    return workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      workspaceActivity.close(
        canonicalWorkspaceFor(lease),
        lease.state.activity,
        options,
      ),
    );
  },
  enableCloud: (
    workspace: RegistryEntry,
    options?: { joinBootstrap?: boolean },
  ) =>
    workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) =>
      workspaceActivity.enableCloud(
        canonicalWorkspaceFor(lease),
        lease.state.activity,
        options,
      ),
    ),
  reconcileCloud: (): void => {
    for (const workspaceId of workspaceAuthorities.workspaceIds()) {
      withWorkspaceActivityState(workspaceId, (lease) =>
        workspaceActivity.reconcileCloud(
          lease.state.activity,
          engineForWorkspace,
          false,
        ),
      );
    }
    notifyRenderer();
  },
  stopEngines: async (): Promise<void> => {
    await Promise.all(
      workspaceAuthorities.workspaceIds().map((workspaceId) =>
        workspaceAuthorities.withAuthority(workspaceId, (lease) =>
          workspaceActivity.stopEngine(lease.state.activity, false),
        ),
      ),
    );
    notifyRenderer();
  },
  getStatus: (workspaceId: string) =>
    withWorkspaceActivityState(workspaceId, (lease, workspace) => ({
      ...workspaceActivity.getStatus(workspace, lease.state.activity),
      ownerLiveDelivery: desktopEngine.ownerLiveDeliveryStatus(workspaceId),
      ownerLiveDeliveryReason: desktopEngine.ownerLiveDeliveryReason(workspaceId),
      hasOwnerLiveRefusals: desktopEngine.hasOwnerLiveRefusals(workspaceId),
    })),
  listOpenWorkspaceIds: () =>
    workspaceAuthorities.workspaceIds().filter((workspaceId) =>
      withWorkspaceActivityState(workspaceId, (lease) =>
        workspaceActivity.isOpen(lease.state.activity),
      ),
    ),
  queueCloudSync: (workspaceId: string): void => {
    if (!findWorkspace(workspaceId)) return;
    desktopEngine.retryOwnerDelivery(workspaceId);
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.queueCloudSync(lease.state.activity),
    );
  },
  setAgentRun: (workspaceId: string, run: ActiveAgentRun | null) =>
    workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      workspaceActivity.setAgentRun(
        canonicalWorkspaceFor(lease),
        lease.state.activity,
        run,
      ),
    ),
  claimAgentRun: (
    workspaceId: string,
    run: ActiveAgentRun,
    expectedRootPath?: string,
  ) =>
    workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      workspaceActivity.claimAgentRun(
        canonicalWorkspaceFor(lease),
        lease.state.activity,
        run,
        expectedRootPath,
      ),
    ),
  clearAgentRun: (
    workspaceId: string,
    agentRunId: string,
    expectedRootPath?: string,
  ) =>
    workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      workspaceActivity.clearAgentRun(
        lease.state.activity,
        agentRunId,
        expectedRootPath,
      ),
    ),
  hasAgentRun: (workspaceId: string, expectedRootPath?: string) =>
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.hasAgentRun(lease.state.activity, expectedRootPath),
    ),
  engineCaptureFor: (workspaceId: string, expectedRootPath?: string) => {
    if (!findWorkspace(workspaceId)) return null;
    return withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.engineCaptureFor(
        lease.state.activity,
        expectedRootPath,
      ),
    );
  },
  workspaceRootPath: (workspaceId: string) => {
    if (!findWorkspace(workspaceId)) return null;
    return withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.workspaceRootPath(lease.state.activity),
    );
  },
  registerExpectedEngineEvents: (
    workspaceId: string,
    events: Parameters<WorkspaceEngineCapture["registerExpectedEngineEvents"]>[0],
  ) =>
    withWorkspaceActivityState(workspaceId, (lease, workspace) =>
      workspaceActivity.registerExpectedEngineEvents(
        workspace,
        lease.state.activity,
        events,
      ),
    ),
};
// Local agent integration: owns the per-workspace MCP child + active-run slot
// and persists agent-run records. The run slot is wired into the watcher
// (workspaceActivity.setAgentRun) so a run's writes are attributed to the
// agent. The MCP child is spawned only in a packaged/dev runtime where a server
// entry resolves; otherwise the toggle still flips and the user's AI tool
// launches its own copy via the Settings config snippet.
const agentIntegration = createAgentIntegration({
  workspaceIds: () => workspaceAuthorities.workspaceIds(),
  acquire: (workspaceId) => {
    const lease = requireWorkspaceAuthority(workspaceId);
    const workspace = canonicalWorkspaceFor(lease);
    return {
      attachmentId: lease.binding.attachmentId,
      workspaceId,
      rootPath: workspace.rootPath,
      state: lease.state.agentIntegration,
      assertCurrent: () => lease.assertCurrent(),
      setAgentRun: async (run: ActiveAgentRun | null) => {
        if (run) {
          const previous = lease.state.agentIntegration.activeRun?.id;
          if (previous) {
            await workspaceActivity.clearAgentRun(
              lease.state.activity,
              previous,
              workspace.rootPath,
            );
          }
          lease.assertCurrent();
          if (
            !(await workspaceActivity.claimAgentRun(
              workspace,
              lease.state.activity,
              run,
              workspace.rootPath,
            ))
          ) {
            throw new Error(
              "Another agent run is already active in this workspace.",
            );
          }
          return;
        }
        const ownedRunId = lease.state.agentIntegration.activeRun?.id;
        if (ownedRunId) {
          await workspaceActivity.clearAgentRun(
            lease.state.activity,
            ownedRunId,
            workspace.rootPath,
          );
        }
        lease.assertCurrent();
      },
      release: () => lease.release(),
    };
  },
  home: stateDir(),
  // Every terminal run path funnels through endAgentRun (driver
  // turn-completed via AgentSessionManager, a Settings stop, the endAgentRun
  // IPC) — the try-in-version review card listens on that single seam.
  // tryInVersionSessions is initialized just below, before any run can end.
  onRunEnded: ({ attachmentId, workspaceId, runId, status }) => {
    tryInVersionSessions.handleRunEnded(
      { workspaceId, attachmentId },
      runId,
      status,
    );
    void chatDispatchService.scanWorkspace(workspaceId, attachmentId).catch((error) => {
      console.error("[desktop] post-panel-run dispatch scan:", error);
    });
  },
});
// "Try it in a version" (PR 0N-2): one gesture composing existing operations
// — fork-and-switch on the engine capture chain, then a dohc-tracked run —
// and a review state when the run ends. Resolution of the capture mirrors
// requireEngineCapture (workspace identity from the registry, engine flag
// gate); a workspace without a capture rejects with the same product message.
function createTryInVersionSessionsFor(
  binding: WorkspaceAuthorityBinding<RegistryEntry>,
) {
  return createTryInVersionSessions({
  operationsFor: async () => {
    return workspaceAuthorities.withBinding(binding, async (lease) => {
      desktopMarks.mark("try-in-version-ops-start");
      const workspace = canonicalWorkspaceFor(lease);
      await openWorkspaceActivity(workspace);
      lease.assertCurrent();
      const capture = workspaceActivity.engineCaptureFor(lease.state.activity);
      if (!capture) {
        throw new Error(captureRefusal("Versions"));
      }
      desktopMarks.measureSince(
        "try-in-version-ops",
        "try-in-version-ops-start",
      );
      return capture;
    });
  },
  startRun: async (workspaceId, task, driverId) => {
    return workspaceAuthorities.withBinding(binding, async (lease) => {
      assertChatRunnerIdle(workspaceId);
      desktopMarks.mark("try-in-version-run-start-begin");
      if (driverId) {
        const sessions = await agentSessionManager();
        const snapshot = await sessions.startSession({
          workspaceId,
          driverId,
          prompt: task,
        });
        lease.assertCurrent();
        const session = snapshot.session;
        if (!session?.runId || session.status === "failed") {
          throw new Error(session?.lastError ?? "The agent could not start.");
        }
        return { id: session.runId };
      }
      const run = await startAgentRunWithWorkspaceActivity(
        canonicalWorkspaceFor(lease),
      );
      desktopMarks.measureSince(
        "try-in-version-run-start",
        "try-in-version-run-start-begin",
      );
      return run;
    });
  },
  onStateChanged: (workspaceId) =>
    withWorkspaceAttachment(
      { workspaceId, attachmentId: binding.attachmentId },
      () => notifyRenderer({ workspaceId }),
    ),
  });
}

const tryInVersionSessions = {
  start(workspaceId: string, task: string, driverId?: string) {
    return workspaceAuthorities.withAuthority(workspaceId, (lease) =>
      lease.state.tryInVersionSessions.start(workspaceId, task, driverId),
    );
  },
  handleRunEnded(
    workspace: { workspaceId: string; attachmentId: symbol },
    runId: string,
    status: "complete" | "failed",
  ): void {
    withWorkspaceAttachment(workspace, (lease) =>
      lease.state.tryInVersionSessions.handleRunEnded(
        workspace.workspaceId,
        runId,
        status,
      ),
    );
  },
  snapshot(workspaceId: string) {
    return withWorkspaceAttachment({ workspaceId }, (lease) =>
      lease.state.tryInVersionSessions.snapshot(workspaceId),
    ) ?? null;
  },
  dismiss(workspaceId: string): boolean {
    return withWorkspaceAttachment({ workspaceId }, (lease) =>
      lease.state.tryInVersionSessions.dismiss(workspaceId),
    ) ?? false;
  },
};
/**
 * The workspace's own `agents.*` settings: which driver it prefers, and which
 * model that driver should start with. Unreadable settings answer with the
 * defaults, which is "no preference" — the same thing an unset file says.
 */
async function workspaceAgentDefaults(
  workspaceId: string,
): Promise<{ defaultDriverId: string | null; defaultModel: string | null }> {
  const workspace = findWorkspace(workspaceId);
  if (!workspace) return { defaultDriverId: null, defaultModel: null };
  const { settings } = await readWorkspaceSettingsFile(workspace.rootPath);
  return {
    defaultDriverId: settings.agents.defaultDriverId,
    defaultModel: settings.agents.defaultModel,
  };
}

let cachedAgentSessions: AgentSessionManager | null = null;
async function agentSessionManager(): Promise<AgentSessionManager> {
  if (!cachedAgentSessions) {
    const { createAgentSessionManager } = await import("./agents/AgentSessionManager");
    cachedAgentSessions = createAgentSessionManager({
      pluginDriversFor: (workspaceId) =>
        pluginWorkspaceRuntimes.current(workspaceId)?.agentDrivers.list() ?? [],
      agentDefaultsFor: workspaceAgentDefaults,
      integration: {
        ...agentIntegration,
        startAgentRun: (workspaceId) =>
          startAgentRunWithWorkspaceActivity(requireWorkspace(workspaceId)),
      },
      rootFor: (workspaceId) => findWorkspace(workspaceId)?.rootPath ?? null,
      mcpFor: mcpRuntimeConfigFor,
    });
  }
  return cachedAgentSessions;
}

// Linked chats and dispatch use the same physical authority as every other
// workspace-owned resource. Each call into either store reacquires that exact
// binding, so a detached and reattached workspace cannot reuse the old store.
function linkedChatStoreFor(
  workspaceOrLease: EngineWorkspace | DesktopWorkspaceAuthorityLease,
): DesktopLinkedChatStore {
  const ownsLease = !("binding" in workspaceOrLease);
  const lease = ownsLease
    ? requireWorkspaceAuthority(workspaceOrLease.workspaceId)
    : workspaceOrLease;
  try {
    lease.assertCurrent();
    if (
      !("binding" in workspaceOrLease) &&
      workspaceOrLease.attachmentId !== undefined &&
      workspaceOrLease.attachmentId !== lease.binding.attachmentId
    ) {
      throw new Error("This chat store request belongs to a retired workspace.");
    }
  const existing = lease.state.linkedChatStore;
  if (existing) return existing;
  if (!desktopEngine.sessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  const current = findWorkspace(lease.binding.workspaceId);
    if (!current) {
      throw new Error(`Unknown workspace: ${lease.binding.workspaceId}`);
    }
    const binding = lease.binding;
    const engineWorkspace = receivedShareEngine.workspaceForRegistered({
      ...current,
      rootPath: binding.canonicalRootPath,
      attachmentId: binding.attachmentId,
    });
    const store = createDesktopLinkedChatStore(engineWorkspace, {
    sessions: desktopEngine.sessions,
      runWithAuthority: (work) =>
        workspaceAuthorities.withBinding(binding, () => work()),
    });
    lease.state.linkedChatStore = store;
  return store;
} finally {
    if (ownsLease) lease.release();
  }
}

function agentDispatchStoreHandleFor(workspace: {
  workspaceId: string;
  rootPath: string;
  attachmentId?: symbol;
}): LiveAgentDispatchStoreHandle {
  const lease = requireWorkspaceAuthority(workspace.workspaceId);
  try {
    lease.assertCurrent();
    if (
      workspace.attachmentId !== undefined &&
      workspace.attachmentId !== lease.binding.attachmentId
    ) {
      throw new Error("This dispatch store request belongs to a retired workspace.");
    }
    const existing = lease.state.agentDispatchStoreHandle;
  if (existing) return existing;
  if (!desktopEngine.sessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  const binding = lease.binding;
    const handle = createLiveAgentDispatchStore(
      {
        workspaceId: binding.workspaceId,
        rootPath: binding.canonicalRootPath,
        attachmentId: binding.attachmentId,
      },
    desktopEngine.sessions,
      {
        runWithAuthority: (work) =>
          workspaceAuthorities.withBinding(binding, () => work()),
      },
    );
    lease.state.agentDispatchStoreHandle = handle;
  return handle;
  } finally {
    lease.release();
  }
}

// The object-id <-> path index the search surfaces need, read through the
// DAEMON rather than a second sqlite connection.
//
// This used to call the legacy TypeScript store factory, which opened another
// node:sqlite connection to the engine.db the daemon owns -- exactly the second
// writable connection workspaceEngineCapture.ts warns can deadlock. It also
// hydrated every file's content via a full-text listing just to read two string
// fields off each row.
//
// listTextFileMetadata is the right call: it pages (limit 500 + afterPath) so
// a workspace past one page is no longer silently truncated, and it never
// hydrates file bodies.
async function engineSearchIndexFor(
  workspace: EngineWorkspace,
): Promise<{ versionId: string; files: { objectId: string; path: string }[];
} | null> {
  return await withEngineAdapter(workspace, async (adapter) => {
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
  });
}

// One daemon round-trip per read, through the workspace-attachment authority
// sandwich. Returns null when the daemon has no workspace sessions (engine
// unavailable), so callers can answer with an empty result — collections.list
// says "no collections" — while surfaces that must not guess raise a visible
// error.
async function withEngineAdapter<T>(
  workspace: EngineWorkspace,
  work: (adapter: VersionedLiveAdapter) => Promise<T>,
): Promise<T | null> {
  const sessions = desktopEngine.sessions;
  if (!sessions) return null;
  const read = async (engineWorkspace: EngineWorkspace) =>
    await sessions.run(engineWorkspace, async (binding) =>
      await work(
        new VersionedLiveAdapter(binding.client, binding.workspace, {
          workspaceId: workspace.workspaceId,
        }),
      ),
    );
  const registered = findWorkspace(workspace.workspaceId);
  if (!registered) return await read(workspace);
  if (
    workspace.attachmentId === undefined &&
    registered.rootPath !== workspace.rootPath
  ) {
    throw new Error(
      "The engine workspace belongs to a replaced physical attachment.",
    );
  }
  return await withWorkspaceAttachmentAsync(workspace, async (lease) =>
    await read(engineWorkspaceForAuthority(lease)),
  );
}

async function activeEngineFileIndex(workspace: EngineWorkspace): Promise<{
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
let cachedAgentName: string | undefined;
let cachedPreferredName: string | undefined;
function localUserDisplayName(): string {
  return cachedPreferredName ?? "You";
}

// The opaque per-install reactor id used when signed out (no cloud user id). A
// stable uuid persisted in stateDir — never the email — so a signed-out
// reaction cell is stable across restarts without leaking PII into the CRDT.
// Memoized after the first read; the sync fs touch happens at most once.
let cachedLocalReactorId: string | null = null;
function localReactorFallbackId(): string {
  if (cachedLocalReactorId) return cachedLocalReactorId;
  const id = readOrCreateLocalReactorId(join(stateDir(), "dohc-local-id.json"));
  cachedLocalReactorId = id;
  return id;
}

// The local user's stable, OPAQUE reactor identity (WS-MU-C2). This value
// becomes a replicated CRDT author key, so it must never be the raw email — a
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
  store: DesktopLinkedChatStore,
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
        store,
        target,
      }),
  });
}

function workspaceForDispatch(workspaceId: string): ChatDispatchWorkspace | null {
  const workspace = findWorkspace(workspaceId);
  if (!workspace || sharedViewOf(workspaceId)) {
    return null;
  }
  const lease = requireWorkspaceAuthority(workspaceId);
  try {
    return {
      workspaceId: lease.binding.workspaceId,
      rootPath: lease.binding.canonicalRootPath,
      attachmentId: lease.binding.attachmentId,
    };
  } finally {
    lease.release();
  }
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
function canonicalWorkspaceFor(
  lease: DesktopWorkspaceAuthorityLease,
): RegistryEntry & { attachmentId: symbol } {
  lease.assertCurrent();
const workspace = findWorkspace(lease.binding.workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${lease.binding.workspaceId}`);
  }
  return {
    ...workspace,
    rootPath: lease.binding.canonicalRootPath,
    attachmentId: lease.binding.attachmentId,
  };
}

function withEngineStoreRecoveredForAuthority<Result>(
  lease: DesktopWorkspaceAuthorityLease,
  body: () => Promise<Result>,
): Promise<Result> {
  const workspace = canonicalWorkspaceFor(lease);
  return runInWorkspaceAuthorityLane(lease, "engine-store", () =>
    withEngineStoreRecoveredUnderEngineStoreLock(workspace, body, (rootPath) =>
      completePendingEngineStoreMoveForWorkspace(workspace, rootPath),
    ),
  );
}

function completePendingEngineStoreMoveForWorkspace(
  workspace: AttachedEngineWorkspace,
  rootPath: string,
): Promise<void> {
  const sessions = requireEngineSessions();
  return completePendingEngineStoreMove(rootPath, {
    rebuildGate: {
      begin: () => sessions.beginRebuild(workspace),
      end: () => sessions.endRebuild(workspace),
    },
  });
}

async function syncWorkspaceForDispatch(
  dispatchWorkspace: ChatDispatchWorkspace,
): Promise<boolean> {
  const workspaceId = dispatchWorkspace.workspaceId;
  return withWorkspaceAttachmentAsync(dispatchWorkspace, async (lease) => {
    const existing = lease.state.dispatchSync;
    if (existing) return await existing;
    const pending = Promise.resolve().then(async () => {
      const closing = lease.state.activityClosing;
      if (closing) await closing.catch(() => undefined);
      lease.assertCurrent();
      const workspace = canonicalWorkspaceFor(lease);
      if (sharedViewOf(workspaceId)) return false;
      try {
        return await withEngineStoreRecoveredForAuthority(lease, async () => {
          lease.assertCurrent();
          if (activity.listOpenWorkspaceIds().includes(workspaceId)) {
            if (
              activity.workspaceRootPath(workspaceId) !== workspace.rootPath
            ) {
              throw new Error(
                "This sync belongs to a retired workspace authority.",
              );
            }
            activity.queueCloudSync(workspaceId);
            return (
              activity.engineCaptureFor(workspaceId, workspace.rootPath) !== null
            );
          }
          const { capture } = captureForWorkspace(
            {
              ...workspace,
              // Guarded above: a shared view already returned false.
              shareView: false,
            },
            { onCaptureOutcome: () => undefined },
            requireEngineSessions(),
          );
          if (!capture) return false;
          try {
            const engine = engineForWorkspace(workspace, capture);
            if (!engine) return false;
            try {
              await engine.start();
              lease.assertCurrent();
              return true;
            } finally {
              await engine.stop().catch(() => undefined);
              const relayCloseTarget = workspace.remote
                ? workspaceSessionTargetForPhysicalWorkspace(
                    workspace.workspaceId,
                    workspace,
                  )
                : null;
              if (relayCloseTarget) {
                await closeRelayTransportWorkspace(relayCloseTarget).catch(
                  () => undefined,
                );
              }
            }
          } finally {
            await capture.stop().catch(() => undefined);
          }
        });
      } catch (error) {
        if (!(error instanceof EngineStoreRecoveryFailedError)) throw error;
        // The dispatch pump stops on false. A thrown sync error is logged, then
        // the pump scans anyway and can open the still-split store directly.
        console.error("[desktop] pending engine store move:", error);
        return false;
      }
    });
    lease.state.dispatchSync = pending;
    try {
      return await pending;
    } finally {
      if (lease.state.dispatchSync === pending) {
        lease.state.dispatchSync = null;
      }
    }
  });
}

interface WorkspaceActivityOpenOptions {
  afterActivityOpen?: () => Promise<void>;
  whileEngineStoreLockHeld?: () => Promise<void>;
  // Runs after reopen recovery has settled (resumed and completed a partial
  // move, or found nothing pending) but before activity.open starts the
  // daemon-owned capture. The rebuild's own reopen uses this to release the
  // request-scoped gate before capture.start()'s startup probe binds a
  // session — otherwise that probe races the still-raised gate and
  // self-refuses in the background.
  afterReopenRecoverySettled?: () => void;
}

async function ensureWorkspaceActivityOpenBody(
  lease: DesktopWorkspaceAuthorityLease,
  options: WorkspaceActivityOpenOptions = {},
): Promise<SyncStatusResult> {
  const workspace = canonicalWorkspaceFor(lease);
  let status: SyncStatusResult;
  for (;;) {
    const closing = lease.state.activityClosing;
    if (closing) {
      await closing.catch(() => undefined);
      lease.assertCurrent();
      continue;
    }
    const existing = lease.state.activityOpening;
    if (existing) {
      status = await existing;
      lease.assertCurrent();
      break;
    }
    const opening = activity.open(workspace);
    lease.state.activityOpening = opening;
    try {
      status = await opening;
      lease.assertCurrent();
      break;
    } finally {
      if (lease.state.activityOpening === opening) {
        lease.state.activityOpening = null;
      }
    }
  }
  await options.whileEngineStoreLockHeld?.();
  return status;
}

async function ensureWorkspaceActivityOpen(
  workspace: CreatedWorkspace,
  options: WorkspaceActivityOpenOptions = {},
): Promise<SyncStatusResult> {
  return workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) =>
    withEngineStoreRecoveredForAuthority(lease, () =>
      ensureWorkspaceActivityOpenBody(lease, options),
    ),
  );
}

async function ensureWorkspaceActivityOpenUnderEngineStoreLock(
  workspace: CreatedWorkspace,
  options: WorkspaceActivityOpenOptions = {},
): Promise<SyncStatusResult> {
  return workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) => {
    const canonicalWorkspace = canonicalWorkspaceFor(lease);
    return withEngineStoreRecoveredUnderEngineStoreLock(
      canonicalWorkspace,
      () => ensureWorkspaceActivityOpenBody(lease, options),
      async (rootPath) => {
        await completePendingEngineStoreMoveForWorkspace(
          canonicalWorkspace,
          rootPath,
        );
        lease.assertCurrent();
        options.afterReopenRecoverySettled?.();
      },
    );
  });
}

async function closeDispatchRunActivity(
  workspace: Pick<CreatedWorkspace, "workspaceId"> & { attachmentId?: symbol },
  options: { notifyRenderer?: boolean } = {},
): Promise<void> {
  return withWorkspaceAttachmentAsync(
    workspace,
    async (lease) => {
      const existing = lease.state.activityClosing;
      if (existing) return await existing;
      const current = canonicalWorkspaceFor(lease);
      const relayCloseTarget = current.remote
        ? workspaceSessionTargetForPhysicalWorkspace(
            current.workspaceId,
            current,
          )
        : null;
      const closing = closeWorkspaceActivityAndRelay({
        closeActivity: async () => {
          await activity.close(current.workspaceId, {
            expectedRootPath: current.rootPath,
            preserveStatus: true,
            notify: options.notifyRenderer,
          });
        },
        ...(relayCloseTarget
          ? {
              closeRelay: () => closeRelayTransportWorkspace(relayCloseTarget),
            }
          : {}),
        onRelayCloseError: (error) =>
          console.error(
            `[desktop] relay workspace close failed for ${current.workspaceId}:`,
            error,
          ),
      });
      lease.state.activityClosing = closing;
      try {
        await closing;
        lease.assertCurrent();
      } finally {
        if (lease.state.activityClosing === closing) {
          lease.state.activityClosing = null;
        }
      }
    },
  );
}

// The release closes a TRANSIENT open (background dispatch, runner self-test)
// and leaves a workspace that was already open, or that a renderer/CLI
// retained during the run, alone. Decided from the post-run state, not from
// the open itself: a retention can land while the run is in flight.
async function acquireDispatchRunActivity(
  workspace: CreatedWorkspace & { attachmentId?: symbol },
): Promise<() => Promise<void>> {
  return withWorkspaceAttachmentAsync(workspace, async (lease) => {
    const current = canonicalWorkspaceFor(lease);
    const alreadyOpen = workspaceActivity.isOpen(lease.state.activity);
    await ensureWorkspaceActivityOpen(current);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (alreadyOpen) return;
      const retained =
        withWorkspaceAttachment(current, (held) => held.state.retainedActivity) ??
        false;
      if (retained) return;
      await closeDispatchRunActivity(current);
    };
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
  await withWorkspaceAttachmentAsync(input, async () => {
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
        topics.map((topic) =>
          transport.leave({ topic, clientId: input.clientId }),
        ),
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
  });
}

function cliRunMessageLinkKey(link: CliRunMessageLink): string {
  return `${link.runId}\u0000${link.messageId}`;
}

function hasPendingCliRunMessageLink(
  workspace: ChatDispatchWorkspace,
  runId: string,
): boolean {
  const workspaceId = workspace.workspaceId;
  if (!findWorkspace(workspaceId)) return false;
  const lease = requireWorkspaceAuthority(workspaceId);
  try {
    if (
      workspace.attachmentId !== undefined &&
      workspace.attachmentId !== lease.binding.attachmentId
    ) {
      return false;
    }
    const prefix = `${runId}\u0000`;
    return [...lease.state.pendingCliRunMessageLinks].some((key) =>
      key.startsWith(prefix),
    );
  } finally {
    lease.release();
  }
}

function rememberPendingCliRunMessageLink(
  link: CliRunMessageLink,
  pending: boolean,
): void {
  if (!findWorkspace(link.workspaceId)) return;
  const lease = requireWorkspaceAuthority(link.workspaceId);
  if (pending) {
    lease.state.pendingCliRunMessageLinks.add(cliRunMessageLinkKey(link));
  } else {
    lease.state.pendingCliRunMessageLinks.delete(cliRunMessageLinkKey(link));
  }
  lease.release();
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
  identityFor: (workspace, target) =>
    withWorkspaceAttachmentAsync(workspace, async (lease) => {
      await warmCredentialCache();
      lease.assertCurrent();
      const registered = canonicalWorkspaceFor(lease);
      const verifiedUserId = target
        ? (
            await chatRelayIdentityFor(
              registered.workspaceId,
              target,
              linkedChatStoreFor(lease),
            )
          ).authorUserId
        : resolveWorkspaceRelayAuthorId(registered, cachedCredentials);
      const settings = (await readCachedUserSettingsFile(stateDir())).settings;
      lease.assertCurrent();
      return {
        displayName: settings.profile.agentName ?? "Agent",
        ownerDisplayName: localUserDisplayName(),
        ...(verifiedUserId ? { verifiedUserId } : {}),
      };
    }),
  stateDir,
  appRoot: desktopPackageRootInDev,
  isPackaged: () => app.isPackaged,
  resourcesPath: () =>
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  queueSync: syncWorkspaceForDispatch,
  prepareRunWorkspace: async (workspace) => {
    const { registered, release } = await withWorkspaceAttachmentAsync(
      workspace,
      async (lease) => {
        const registered = canonicalWorkspaceFor(lease);
        return {
          registered,
          release: await acquireDispatchRunActivity(registered),
        };
      },
    );
    if (!activity.engineCaptureFor(registered.workspaceId, registered.rootPath)) {
      await release();
      throw new Error(captureRefusal("Chats"));
    }
    return release;
  },
  authorizeServiceNote: (workspace, threadId, verifiedUserId) =>
    withWorkspaceAttachmentAsync(workspace, async (lease) => {
      try {
        const store = linkedChatStoreFor(lease);
        const registered = canonicalWorkspaceFor(lease);
        await assertSharedChannelWritable({
          workspaceId: registered.workspaceId,
          sharedChannels: registered.sharedChannels,
          store,
          target: { threadId },
        });
        const identity = await chatRelayIdentityFor(
          workspace.workspaceId,
          { threadId },
          store,
        );
        return (
          identity.authorUserId === verifiedUserId &&
          (identity.joinedChannel === null || verifiedUserId !== undefined)
        );
      } catch (error) {
        if (!(error instanceof SharedChannelReadOnlyError)) throw error;
        return false;
      }
    }),
  onMessagePosted: (workspace, threadId) => {
    withWorkspaceAttachment(workspace, () => {
      notifyRenderer({ workspaceId: workspace.workspaceId });
      queueChatBookmarkProjection(workspace.workspaceId);
      activity.queueCloudSync(workspace.workspaceId);
      void withWorkspaceAttachmentAsync(workspace, () =>
        syncSharedChannelsForChatTarget(workspace.workspaceId, { threadId }),
      ).catch((error) => {
        console.error("[desktop] shared channel sync:", error);
      });
      void chatDispatchService
        .scanWorkspace(workspace.workspaceId, workspace.attachmentId)
        .catch((error) => {
          console.error("[desktop] chat dispatch scan:", error);
        });
    });
  },
  onRunUpdated: (workspace) =>
    withWorkspaceAttachment(workspace, () =>
      notifyRenderer({ workspaceId: workspace.workspaceId }),
    ),
  setRunAttribution: (workspace, run) =>
    withWorkspaceAttachmentAsync(workspace, async (lease) => {
      const workspaceId = workspace.workspaceId;
      if (run) {
      if (!(await activity.claimAgentRun(workspaceId, run,
            lease.binding.canonicalRootPath,
          ))) {
        throw new Error("Another agent run is already active in this workspace.");
      }
        lease.assertCurrent();
        lease.state.dispatchAgentRunId = run.agentRunId;
        return;
      }
      const ownedRunId = lease.state.dispatchAgentRunId;
      if (ownedRunId) {
        await activity.clearAgentRun(workspaceId, ownedRunId,
          lease.binding.canonicalRootPath,
        );
      }
      lease.assertCurrent();
      lease.state.dispatchAgentRunId = null;
    }),
  runSlotOccupied: (workspace) =>
    withWorkspaceAttachment(workspace, () =>
      activity.hasAgentRun(workspace.workspaceId),
    ) ?? false,
  hasPendingRunMessageLink: hasPendingCliRunMessageLink,
  publishPresence: publishAgentPresence,
  requeueFailedTrigger: (input) => {
    const workspace = workspaceForDispatch(input.workspaceId);
    return workspace &&
      (input.attachmentId === undefined ||
        workspace.attachmentId === input.attachmentId)
      ? agentDispatchStoreHandleFor(workspace).requeueFailedTrigger(input)
      : false;
  },
  listAppQuitRecoveries: (workspace) => {
    const current = workspaceForDispatch(workspace.workspaceId);
    return current && current.attachmentId === workspace.attachmentId
      ? agentDispatchStoreHandleFor(workspace).listAppQuitRecoveries(
          workspace.workspaceId,
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

async function openWorkspaceActivityForOperation(
  operation: DesktopWorkspaceOperation,
  options: WorkspaceActivityOpenOptions,
  ensureOpen: (
    workspace: CreatedWorkspace,
    options: WorkspaceActivityOpenOptions,
  ) => Promise<SyncStatusResult>,
): Promise<SyncStatusResult> {
  // A fast renderer can ask to open a workspace while the daemon is still
  // handshaking (the window loads during it). Wait for the handshake instead
  // of building a capture over null engine sessions.
  await desktopEngine.startup;
  operation.assertCurrent();
  const canonicalWorkspace = operation.workspace;
  operation.state.retainedActivity = true;
  const result = await ensureOpen(canonicalWorkspace, options);
  await options.afterActivityOpen?.();
  operation.assertCurrent();
  void chatDispatchService.scanWorkspace(
    canonicalWorkspace.workspaceId,
    canonicalWorkspace.attachmentId,
  ).catch((error) => {
    console.error("[desktop] chat dispatch workspace-open scan:", error);
  });
  queueChatBookmarkProjection(canonicalWorkspace.workspaceId);
  return result;
}

function openWorkspaceActivityWith(
  workspace: CreatedWorkspace,
  options: WorkspaceActivityOpenOptions,
  ensureOpen: (
    workspace: CreatedWorkspace,
    options: WorkspaceActivityOpenOptions,
  ) => Promise<SyncStatusResult>,
): Promise<SyncStatusResult> {
  return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
    openWorkspaceActivityForOperation(operation, options, ensureOpen),
  );
}

async function openWorkspaceActivity(
  workspace: CreatedWorkspace,
  options: WorkspaceActivityOpenOptions = {},
): Promise<SyncStatusResult> {
  return openWorkspaceActivityWith(
    workspace,
    options,
    ensureWorkspaceActivityOpen,
  );
}

async function openWorkspaceActivityUnderEngineStoreLock(
  workspace: CreatedWorkspace,
  options: WorkspaceActivityOpenOptions = {},
): Promise<SyncStatusResult> {
  return openWorkspaceActivityWith(
    workspace,
    options,
    ensureWorkspaceActivityOpenUnderEngineStoreLock,
  );
}

async function startAgentRunWithWorkspaceActivity(
  workspace: CreatedWorkspace,
): Promise<AgentRunRecord> {
  let run: AgentRunRecord | undefined;
  await openWorkspaceActivity(workspace, {
    whileEngineStoreLockHeld: async () => {
      run = await agentIntegration.startAgentRun(workspace.workspaceId);
    },
  });
  if (!run) throw new Error("The agent run did not start.");
  return run;
}

async function requirePluginEngineCaptureForOperation(
  operation: DesktopWorkspaceOperation,
) {
  await openWorkspaceActivityForOperation(
    operation,
    {},
    ensureWorkspaceActivityOpen,
  );
  operation.assertCurrent();
  const workspace = operation.workspace;
  const capture = activity.engineCaptureFor(workspace.workspaceId);
  if (!capture) {
    throw new Error(captureRefusal("Plugins"));
  }
  return { workspace, capture };
}

// Workspace authority for one collection write: a writable workspace with a
// running engine capture, plus the local engine adapter the adoption wait
// reads through. Collection writes land on the physical workspace's own
// engine (a received share view is refused as read-only before this).
async function collectionEditContextFor(
  operation: DesktopWorkspaceOperation,
  editSignal?: AbortSignal,
): Promise<CollectionRecordEditContext> {
  const { workspace, capture } =
    await requirePluginEngineCaptureForOperation(operation);
  assertWritableWorkspace(workspace);
  return {
    capture,
    workspaceRoot: workspace.rootPath,
    withAdapter: (work) => withEngineAdapter(workspace, work),
    ...(editSignal ? { signal: editSignal } : {}),
  };
}

const { invokeWorkspacePluginSdk, routePluginPanelSdk } =
  createDesktopPluginSdk<DesktopWorkspaceOperation>({
    withPhysicalWorkspaceOperation, ownedWorkspaceReadsFor, workerDatabaseReader,
    editWorkspaceDatabaseInWorker, openWorkspaceActivityForOperation,
    ensureWorkspaceActivityOpen, activity, collectionEditContextFor,
    requirePluginEngineCaptureForOperation, assertWritableWorkspace,
    workspaceAuthorities, pluginWorkspaceRuntimes, sharedViewOf,
    notifyPluginPanelSdkEvent,
  });

const startPluginPanelPreview = createPluginPanelPreviewStarter(stateDir);

async function stopAllPluginWorkspaces(): Promise<void> {
  // Runs once, from the will-quit teardown — the first moment a quit can no
  // longer be cancelled. Idempotent. The caller awaits it inside
  // WILL_QUIT_BUDGET_MS so quit cannot outrun a preview process's own
  // hard-kill path.
  await Promise.allSettled(
    workspaceAuthorities.workspaceIds().map((workspaceId) =>
      workspaceAuthorities.withAuthority(workspaceId, async (lease) => {
        await Promise.allSettled([
          lease.state.sitePreviews.stopAll(),
          lease.state.pluginRuntimes.close(() =>
            lease.state.pluginSurfaces.close(),
          ),
        ]);
      }),
    ),
  );
}

let datasetForCli: ((input: DatasetRequest) => Promise<DatasetResult>) | undefined;
const activeDatasetHosts = new Set<Promise<LocalDatasetHost>>();
const chatWrites = createChatWrites({
  findWorkspace,
  warmCredentials: warmCredentialCache,
  currentCredentials: () => cachedCredentials,
  currentCredentialGeneration: () => credentialCacheGeneration,
  localUserDisplayName,
  agentDisplayName: async () =>
    (await readCachedUserSettingsFile(stateDir())).settings.profile.agentName ?? "Agent",
  localReactorFallbackId,
  projectChatBookmarks: (workspaceId) => void projectPendingChatBookmarks(workspaceId),
  queueCloudSync: (workspaceId) => activity.queueCloudSync(workspaceId),
  syncSharedChannelsForChatTarget,
  scanChatDispatch: (workspaceId) => chatDispatchService.scanWorkspace(workspaceId),
});

let ownerAppPublicationForCli: ((input: OwnerAppPublicationRequest) => Promise<OwnerAppPublicationResult>) | undefined;
let ownerAppResponsesForCli:((input:import("@dohc/cli/app-responses").OwnerAppResponsesRequest)=>Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>)|undefined;
const { startDesktopCliServer } = createDesktopCliServer({
  dataset: input => {
    if (!datasetForCli) throw new Error("Collections are not ready. Try again.");
    return datasetForCli(input);
  },
  ownerAppPublication: input => {
    if (!ownerAppPublicationForCli) throw new Error("App publication is not ready. Try again.");
    return ownerAppPublicationForCli(input);
  },
  ownerAppResponses:input=>{
    if(!ownerAppResponsesForCli)throw new Error("App responses are not ready. Try again.");
    return ownerAppResponsesForCli(input);
  },
  findWorkspace,
  listWorkspaces,
  openWorkspaceActivity,
  activity,
  linkedChatStoreFor,
  currentDaemon: () => desktopEngine.daemon,
  agentDispatchStoreHandleFor,
  sharedViewOf,
  withPhysicalWorkspaceOperation,
  collectionEditContextFor,
  withEngineAdapter,
  chatWrites,
  startCliServer,
  stateDir,
  localUserDisplayName,
  notifyRenderer,
  syncSharedChannelsForChatTarget,
  chatDispatchService,
  rememberPendingCliRunMessageLink,
});

const engineYDocSessionIpc = createEngineYDocSessionIpc({
  sessionFor: (sender) =>
    rendererWorkspaceSessions.current(sender as WebContents),
  acquireWorkspace: (workspaceId) => {
    const lease = requireWorkspaceAuthority(workspaceId);
    return {
      workspace: canonicalWorkspaceFor(lease),
      assertCurrent: () => lease.assertCurrent(),
      release: () => lease.release(),
    };
  },
  captureFor: (workspace) => activity.engineCaptureFor(workspace.workspaceId, workspace.rootPath),
  ensureCaptureFor: async (workspace) => {
    await openWorkspaceActivity(requireWorkspace(workspace.workspaceId));
  },
  isSharedView: (workspace) => sharedViewOf(workspace.workspaceId) !== null,
  sharedCaptureFor: async (workspace) => {
    await warmCredentialCache();
    const registered = findWorkspace(workspace.workspaceId), marker = registered?.shareView;
    const credentials = cachedCredentials;
    if (!marker || !credentials?.relayUrl || !marker.relayUrl ||
      !relayUrlsMatch(marker.relayUrl, credentials.relayUrl) || marker.ended ||
      marker.grantedSelector?.access !== "edit" ||
      (marker.grantedSelector.versionId !== null && marker.grantedSelector.versionId !== "main")) return null;
    const identity = (value: typeof marker | undefined) => JSON.stringify({shareId: value?.shareId, relayUrl: value?.relayUrl,
      selector: value?.grantedSelector, ended: value?.ended === true});
    const pinned = identity(marker);
    return createNamedDesktopLiveCapture({ shareId: marker.shareId, selector: marker.grantedSelector,
      preserveDraft: draft => preserveNamedLiveDraft(join(stateDir(), "live-draft-recovery"), workspace.workspaceId, draft),
      credentials: {relayUrl: credentials.relayUrl, token: credentials.token, userId: credentials.userId,
        signal: ownerDeliveryCredentialLifetime.signal},
      assertCurrent() {
        const current = findWorkspace(workspace.workspaceId);
        if (cachedCredentials?.token !== credentials.token || cachedCredentials?.userId !== credentials.userId ||
          cachedCredentials?.relayUrl !== credentials.relayUrl || current?.rootPath !== workspace.rootPath || identity(current.shareView) !== pinned) {
          throw new Error("The shared file session changed.");
        }
      },
    });
  },
  resolveDocumentPath: async (workspace, path) => {
    try {
      return (await resolveWorkspaceFile(workspace.rootPath, path, "write"))
        .resolvedPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  },
  onError: (message, error) => {
    if (error === undefined) console.error(message);
    else console.error(message, error);
  },
});

// Close every live engine Y.Doc session (app quit) before the engine stores are
// stopped, so no session settles onto a closed store.
async function closeAllEngineYDocSessions(): Promise<void> {
  await engineYDocSessionIpc.shutdown();
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
  return (
    parseUpdateStateForIpc(autoUpdateController?.publicState() ?? fallback) ?? fallback
  );
}

function broadcastUpdateState(state: PublicUpdateState): void {
  const payload = parseUpdateStateForIpc(state);
  if (!payload) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.updateState, payload);
  }
  if (payload.canInstall !== desktopWindows.applicationMenuCanInstallUpdate) {
    refreshApplicationMenu();
  }
}

const { refreshDispatchTray, refreshSystemThemeDesktopIcons } = createDesktopTray<
  ReturnType<typeof nativeImage.createFromPath>,
  ReturnType<typeof Menu.buildFromTemplate>
>({
  app, process, Menu, nativeImage, nativeTheme, Tray, BrowserWindow,
  moduleDirectory: import.meta.dirname,
  readCachedUserSettingsFile, stateDir, chatDispatchService, showOrCreateMainWindow,
  get appLifecycle(): { isQuitting(): boolean } { return appLifecycle; },
});

const desktopEngine = createDesktopEngine({
  serverOwnerDelivery: createServerOwnerConnection({stateDir, workspaces: listWorkspaces,
    onRefusalsChanged: workspaceId => notifyRenderer({workspaceId}),
    credentials: () => cachedCredentials ? {value: cachedCredentials, signal: ownerDeliveryCredentialLifetime.signal} : null,
    fetch: (input, init) => relayShareFetch(input, init)}),
  notifyOwnerDeliveryChanged: workspaceId => notifyRenderer({workspaceId}),
  ownerDeliveryCredentials: () => cachedCredentials?.relayUrl ? {bearer: cachedCredentials.token,
    relayUrl: cachedCredentials.relayUrl, signal: ownerDeliveryCredentialLifetime.signal} : null,
  existingOwnerFor: binding => engineYDocSessionIpc.existingOwner(binding),
  findWorkspace,
  app, dialog, process, createRustEngineDaemon, defaultEngineBinaryPath,
  isQuitting: (): boolean => appLifecycle.isQuitting(),
  workspaceAuthorities, pluginWorkspaceRuntimes, notifyRenderer,
  notifyAutomationFailuresChanged, launchMarks, desktopMarks, logLaunchMarksOnce,
});
const {
  requireEngineSessions, closeRelayTransportWorkspace, closeAllRelayTransportWorkspaces,
} = desktopEngine;


const receivedShareEngine = createReceivedShareEngineAccess({
  sessions: requireEngineSessions,
  createStores: createCaptureLiveStores,
  relayClient: () => {
    if (!desktopEngine.relayClient) {
      throw new Error("Rust engine relay client is unavailable.");
    }
    return desktopEngine.relayClient;
  },
});

function engineWorkspaceForAuthority(
  lease: DesktopWorkspaceAuthorityLease,
): EngineWorkspace {
  return receivedShareEngine.workspaceForRegistered(canonicalWorkspaceFor(lease));
}

let shareViewFiles: ShareViewFiles;
function createShareMountCommandsFor(
  binding: WorkspaceAuthorityBinding<RegistryEntry>,
) {
  return createShareMountCommands({
    readMounts: (workspaceId) =>
      storedShareMounts(findWorkspace(workspaceId) ?? {}),
    writeMounts: (workspaceId, mounts) => {
      if (workspaceId !== binding.workspaceId) {
        throw new Error("Share mount write targeted a different workspace.");
      }
      setWorkspaceShareMounts(workspaceId, mounts);
    },
    loadCredentials: () => loadAndCacheCurrentCredentials(),
    fetchInfo: (relay, shareId) => fetchShareViewInfo({ relay, shareId }),
    listDirectory: (absolutePath) => readdir(absolutePath).catch(() => []),
    withWorkspaceOperation: (workspaceRoot, run) =>
      withExclusiveWorkspaceOperation(
        workspaceRoot,
        (_markWorkspaceChanged, lease) => run(lease),
      ),
    files: () => shareViewFiles,
    projectionFor: shareViewFilesMountProjection,
    closeRelayWorkspace: (workspaceId) =>
      closeRelayTransportWorkspace(workspaceId),
    workspaceSummary: (workspaceId) =>
      workspaceSummaryFor(requireWorkspace(workspaceId)),
    refreshNativeWorkspaceSurfaces,
    notifyRenderer: (scope) =>
      withWorkspaceAttachment(
        { ...scope, attachmentId: binding.attachmentId },
        () => notifyRenderer(scope),
      ),
    logError: (message, error) => console.error(`[desktop] ${message}`, error),
  });
}

const withExactMountOperation = createExactMountOperationRunner<
  DesktopWorkspaceOperation["workspace"],
  DesktopWorkspaceOperation
>({
  withOperation: withPhysicalWorkspaceOperation,
  engineReady: () => desktopEngine.startup,
});

const shareMountCommands: Pick<
  ReturnType<typeof createShareMountCommandsFor>,
  "mount" | "refresh" | "unmount"
> = {
  mount: (input) =>
    withExactMountOperation(input, (operation, current) =>
      operation.state.shareMountCommands.mount({ ...input, ...current }),
    ),
  refresh: (input) =>
    withExactMountOperation(input, (operation, current) =>
      operation.state.shareMountCommands.refresh(current),
    ),
  unmount: (input) =>
    withExactMountOperation(input, (operation, current) =>
      operation.state.shareMountCommands.unmount({ ...input, ...current }),
    ),
};

function createShareViewFilesForOperation(
  operation: DesktopWorkspaceOperation,
): ShareViewFiles {
  const assertCurrent = (): void => operation.assertCurrent();
  const currentWorkspace = () => {
    assertCurrent();
    return operation.workspace;
  };
  return createShareViewFiles({
    stateFor: (target) => {
      assertCurrent();
      if (
        target.workspaceId !== operation.workspace.workspaceId ||
        target.schedulingRootPath !== operation.workspace.rootPath
      ) {
        throw new Error(
          "Share file cache request belongs to a retired workspace.",
        );
      }
      return operation.state.shareViewFiles;
    },
    resolveTarget: (target) => {
      if (target.workspaceId !== operation.workspace.workspaceId) return null;
      return resolveRegisteredShareViewFilesTarget(currentWorkspace(), target);
    },
    openStore: (target) =>
      receivedShareEngine.storeFor({
        engineWorkspaceId: target.storeWorkspaceId,
        rootPath: target.rootPath,
        ...(target.storeWorkspaceId === operation.workspace.workspaceId
          ? { attachmentId: operation.workspace.attachmentId }
          : {}),
      }),
    resolveRelay: async (target) => {
      await warmCredentialCache().catch(() => undefined);
      const credentials = cachedCredentials;
      if (!credentials?.relayUrl) {
        if (target.kind === "standalone") {
          throw new Error("Sign in to your server first.");
        }
        return null;
      }
      if (
        (target.relayUrl &&
          !relayUrlsMatch(credentials.relayUrl, target.relayUrl)) ||
        (target.kind === "mount" &&
          target.recipientEmail != null &&
          credentials.email != null &&
          credentials.email !== target.recipientEmail)
      ) {
        return null;
      }
      return { baseUrl: credentials.relayUrl, token: credentials.token };
    },
    pull: async (target, relay, input) =>
      receivedShareEngine
        .relayFor({
          engineWorkspaceId: target.storeWorkspaceId,
          rootPath: target.rootPath,
          ...(target.storeWorkspaceId === operation.workspace.workspaceId
            ? { attachmentId: operation.workspace.attachmentId }
            : {}),
          relay,
        })
        .pullShareView({
          shareId: target.shareId,
          grantedSelector: input.grantedSelector,
          recordRefusals: input.recordRefusals,
          recordCollisions: input.recordCollisions,
          recordChangedPaths: input.recordChangedPaths,
        }),
    recordRefusals: async (target, refusals) => {
      const recorder =
        target.kind === "standalone"
          ? createShareSkipRecorder({
              current: () => currentWorkspace().shareView,
              persist: (next) => {
                assertCurrent();
                setWorkspaceShareView(target.workspaceId, next);
              },
            })
          : createShareSkipRecorder({
              current: () => {
                const mounts = storedShareMounts(currentWorkspace());
                return shareMountRecordsForId(mounts, target.shareId)[0];
              },
              persist: (next) => {
                const mounts = storedShareMounts(currentWorkspace());
                const matches = new Set(
                  shareMountRecordsForId(mounts, target.shareId),
                );
                assertCurrent();
                setWorkspaceShareMounts(
                  target.workspaceId,
                  mounts.map((mount) => (matches.has(mount) ? next : mount)),
                );
              },
            });
      await recorder([...refusals]);
    },
    markEnded: async (target) => {
      assertCurrent();
      if (target.kind === "standalone") {
        endWorkspaceShareView(target.workspaceId);
        return;
      }
      const mounts = storedShareMounts(currentWorkspace());
      const matches = new Set(shareMountRecordsForId(mounts, target.shareId));
      assertCurrent();
      setWorkspaceShareMounts(
        target.workspaceId,
        mounts.map((mount) =>
          matches.has(mount) ? { ...mount, ended: true } : mount,
        ),
      );
    },
    retireTarget: async (target) => {
      const retireTarget = workspaceSessionTargetForPhysicalWorkspace(
        target.storeWorkspaceId,
        operation.workspace,
      );
      await closeRelayTransportWorkspace(retireTarget).catch(
        () => undefined,
      );
    },
    assertProjectionRoot: async (target) => {
      if (target.kind !== "mount") return;
      if (!target.mountLabel) {
        throw new Error("Share mount record has no label.");
      }
      await assertRealMountRoot(target.schedulingRootPath, target.mountLabel);
    },
    createMount: (owner, target) => {
      assertCurrent();
      return operation.state.shareMountCommands.filesLifecycle.createMount(
        owner,
        target,
      );
    },
    removeMount: (owner, target) => {
      assertCurrent();
      return operation.state.shareMountCommands.filesLifecycle.removeMount(
        owner,
        target,
      );
    },
  });
}

function withShareViewFilesOperation<Result>(
  target: ShareViewFilesTarget,
  work: (files: ShareViewFiles) => Promise<Result>,
): Promise<Result> {
  return withPhysicalWorkspaceOperation(target.workspaceId, (operation) =>
    work(createShareViewFilesForOperation(operation)),
  );
}

shareViewFiles = {
  mount: (lease, target) =>
    withShareViewFilesOperation(target, (files) => files.mount(lease, target)),
  change: (lease, target, change) =>
    withShareViewFilesOperation(target, (files) =>
      files.change(lease, target, change),
    ),
  read: (target, request) =>
    withShareViewFilesOperation(target, (files) => files.read(target, request)),
  list: (target) =>
    withShareViewFilesOperation(target, (files) => files.list(target)),
  projectionStatus: (target) =>
    withShareViewFilesOperation(target, (files) =>
      files.projectionStatus(target),
    ),
  reconcile: (lease, target, request) =>
    withShareViewFilesOperation(target, (files) =>
      files.reconcile(lease, target, request),
    ),
  unmount: (lease, target) =>
    withShareViewFilesOperation(target, (files) =>
      files.unmount(lease, target),
    ),
};
const workspaceFileMutations = createWorkspaceFileMutationOwner({
  assertTrustedSender,
  withRendererWorkspaceOperation: (event, workspaceId, work) =>
    withRendererWorkspaceOperation(
      event.sender,
      workspaceId,
      "File change stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        return await work({
          authorityId: workspace.attachmentId,
          workspace,
          capture: activity.engineCaptureFor(workspaceId, workspace.rootPath),
          yDocSessions: engineYDocSessionIpc.fileMutationPort(),
        });
      },
    ),
  shareViewFiles,
  trashItem: (path) => shell.trashItem(path),
  notifyRenderer: (workspaceId) => notifyRenderer({ workspaceId }),
  logError: (message, error) => console.error(message, error),
});
const ensureOwnedProjectionTargetCurrent =
  createOwnedProjectionRepairer(shareViewFiles);

const workspaceSearchOwner = new WorkspaceSearchOwner<
  RegistryEntry & { readonly attachmentId: symbol }
>({
  searchRegistry: createSearchRegistry({ rgPath }),
  prepareOwnedSearch: async (workspace) =>
    await ownedWorkspaceReadsFor(workspace).prepareSearch(),
  engineCaptureFor: (workspaceId) => activity.engineCaptureFor(workspaceId),
  queryEngine: createWorkspaceSearchDaemonQuery(
    () => desktopEngine.sessions,
  ),
  logError: (message, error) => console.error(`[desktop] ${message}`, error),
});

const rendererWorkspaceSessions: RendererWorkspaceSessionOwner<WebContents> =
  new RendererWorkspaceSessionOwner<WebContents>({
    retirement: createDesktopRendererWorkspaceRetirement<WebContents>({
      engineYDoc: engineYDocSessionIpc,
      sitePreviews,
      pluginSurfaces,
      pluginRuntimes: pluginWorkspaceRuntimes,
      workspaceSearch: workspaceSearchOwner,
      presencePolls: {
        disposeSender: (senderId) => {
          presencePollRegistry.disposeSender(senderId);
          relayShareDiscussionActivityPolls.disposeSender(senderId);
        },
      },
      presenceMutations: presenceMutationOwner,
      onCleanupError: (owner, scope, error) => {
        const identity =
          scope.kind === "sender"
            ? `sender ${scope.senderId}`
            : `workspace "${scope.workspaceId}"`;
        console.warn(
          `[desktop] failed to retire ${owner} for ${identity}`,
          error,
        );
      },
    }),
    onCleanupError: (scope, error) => {
      console.warn(
        "[desktop] renderer workspace retirement failed",
        scope,
        error,
      );
    },
  });

const withRendererWorkspaceOperation =
  createRendererWorkspaceOperationRunner<
    WebContents,
    DesktopWorkspaceOperation["workspace"],
    DesktopWorkspaceAuthorityState,
    NonNullable<
      ReturnType<RendererWorkspaceSessionOwner<WebContents>["current"]>
    >
  >({
    currentSession: (sender) => rendererWorkspaceSessions.current(sender),
    withPhysicalOperation: (workspaceId, work) =>
      withPhysicalWorkspaceOperation(workspaceId, work),
  });

const exactRendererWorkspaceReferences =
  createExactRendererWorkspaceReferenceOwner<
    WebContents,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >((sender, workspaceId, inactiveMessage, work) =>
    withRendererWorkspaceOperation(
      sender,
      workspaceId,
      inactiveMessage,
      work,
    ),
  );

const ownedSiteCatalog = createOwnedSiteCatalog({
  reads: ownedWorkspaceReadsFor,
});

async function ensureOwnedProjectionCurrent(
  workspace: { workspaceId: string },
  relativePath: string,
): Promise<void> {
  await withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) => {
    const routed = await createOwnedWorkspaceFileReader({
      workspace: operation.workspace,
      files: shareViewFiles,
    }).resolveShare(relativePath);
    if (routed === null) return;
    await ensureOwnedProjectionTargetCurrent({
      rootPath: operation.workspace.rootPath,
      target: routed.target,
    });
  });
}

async function syncStatusWithOwnedProjection(
  workspace: NonNullable<ReturnType<typeof findWorkspace>>,
  status: SyncStatusResult,
): Promise<SyncStatusResult> {
  if (!shareViewIsPresent(workspace.shareView)) return status;
  const projection = await shareViewFiles.projectionStatus({
    kind: "standalone",
    workspaceId: workspace.workspaceId,
  });
  if (projection.state === "unavailable") return status;
  return {
    ...status,
    shareProjection:
      projection.state === "current"
        ? { state: "current" }
        : projection,
  };
}

const appLifecycle = createAppLifecycle<BrowserWindow, WorkspaceSummary, DesktopUserSettingsResult>({
  app,
  runtime: process,
  handoff: {
    slot: shareHandoffIntentSlot,
    pendingCodeChanged: () => shareHandoffRedemption.pendingCodeChanged(),
  },
  windows: {
    create: () => trackWorkspaceWindow(
      createMainWindow({
        beforeRendererReload: prepareAfterRendererCrash,
        preloadArguments: devToolsPreloadArguments(devToolsGranted),
      }),
    ),
    whenLoaded: (window) => new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", resolve);
    }),
    current: () => targetWindow(undefined),
    hasWorkspace: () => liveWorkspaceWindow() !== undefined,
    hasAny: () => BrowserWindow.getAllWindows().length !== 0,
    showOrCreate: showOrCreateMainWindow,
    activate: (window, workspace) => {
      void sendWorkspaceActivated(window, workspace).catch((error: unknown) =>
        desktopWindows.reportActivationFailure(workspace, error),
      );
    },
  },
  workspaces: {
    openPath: openWorkspacePath,
    refreshNativeSurfaces: refreshNativeWorkspaceSurfaces,
  },
  bootstrap: {
    markReady: () => {
      launchMarks.appReady();
      desktopMarks.markOnce("app-ready");
    },
    startEngine: () => desktopEngine.start(),
    loadSettings: () => readCachedUserSettingsFile(stateDir()),
    applySettings: ({ settings }) => {
      cachedPreferredName = settings.profile.preferredName;
      cachedAgentName = settings.profile.agentName;
      desktopWindows.seedZoomLevel(settings.appearance.zoomLevel);
    },
    prepareCli: () => {
      if (!app.isPackaged || process.platform !== "linux" || !isAppImageBoot()) return;
      return refreshLinuxStableCliBin({
        resourcesCliBinDir: resolveDohcCliBinDirectory({
          appRoot: desktopPackageRootInDev(),
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        }),
        targetDir: join(stateDir(), "cli-bin"),
        onError: (error) => console.error("[desktop] Stable Linux cli-bin refresh failed:", error),
      }).then((directory) => { linuxStableCliBinDir = directory; });
    },
    registerHandlers: () => {
      nativeTheme.on("updated", refreshSystemThemeDesktopIcons);
      registerIpcHandlers();
      // Serve workspace file bytes for dohc-file://<workspaceId>/<relpath>.
      // Registered before the window so the first load can already fetch.
      protocol.handle(DOHC_FILE_SCHEME, createWorkspaceFileProtocolHandler({
        findWorkspace,
        readOwnedWorkspaceAsset,
      }));
    },
    markFirstWindow: () => {
      launchMarks.firstWindow();
      desktopMarks.markOnce("first-window");
    },
    reportFailure: (error) => {
      const message = error instanceof Error ? error.message : "Unknown desktop startup error.";
      console.error("[desktop] Desktop startup failed:", error);
      dialog.showErrorBox(
        "dohc failed to start",
        `${message}\n\nRestart dohc. If it fails again, review the desktop logs.`,
      );
    },
  },
  services: {
    startCli: startDesktopCliServer,
    reportCliFailure: (error) => console.error("[desktop] CLI server failed to start:", error),
    dispatch: chatDispatchService,
    refreshTray: refreshDispatchTray,
    reportTrayFailure: (error) => console.error("[desktop] dispatch tray:", error),
    warmCredentials: warmCredentialCache,
    reconcileCloud: () => { activity.reconcileCloud(); },
    startUpdates: () => {
      // Auto-updates: packaged builds use electron-builder's baked app-update.yml
      // feed by default; DOHC_UPDATE_URL is only an explicit mock/dev override.
      // Failures are absorbed — updates must never take the app down.
      void startAutoUpdates({
        isPackaged: app.isPackaged,
        currentVersion: app.getVersion(),
        // A restart already staged has no install left to make — quitAndInstall
        // started its own quit on the first call and has none left to start.
        // Main makes it, so the fact lives here and not in a renderer module a
        // reload would reset. The quit is already approved:
        // the IPC handler approves before asking the controller.
        quitForStagedRestart: () => app.quit(),
        onState: (_state, state) => {
          broadcastUpdateState(state);
        },
      })
        .then((controller) => {
          autoUpdateController = controller;
          broadcastUpdateState(autoUpdateController?.publicState() ?? fallbackUpdateState());
        })
        .catch(() => undefined);
    },
  },
  beforeQuit: (event) => { quitGuard.beforeQuit(event); },
  shutdown: {
    budgetMs: WILL_QUIT_BUDGET_MS,
    beginEngineShutdown: () => {
      desktopEngine.sessions?.beginShutdown();
      desktopChatBookmarks.stop();
    },
    stopSearch: () => workspaceSearchOwner.dispose(),
    stopPlugins: stopAllPluginWorkspaces,
    stopAgentSessions: () => cachedAgentSessions?.stopAll() ?? Promise.resolve(),
    settleYDocs: closeAllEngineYDocSessions,
    stopAgentIntegration: () => agentIntegration.stopAll(),
    closeWorkspaces: async () => {
      await workspaceAuthorities.close();
      await Promise.allSettled([...activeDatasetHosts].map(async pending => (await pending).close()));
      activeDatasetHosts.clear();
      await ownerDatasetCopies.closeAll();
      await namedDatasetPages.close();
    },
    disposeDatabase: () => workspaceDatabaseWorker.dispose(),
    closeRelay: closeAllRelayTransportWorkspaces,
    stopEngine: async () => { await desktopEngine.daemon?.stop(); },
  },
});

const workspaceRootApproval = createWorkspaceRootApproval(effectiveHome);

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
  registerPhysicalWorkspace(created);
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
  await sendWorkspaceActivated(window, workspace);
  refreshNativeWorkspaceSurfaces();
  return workspace;
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

const operationBoundary: OperationBoundary<
  IpcMainInvokeEvent,
  DesktopRendererWorkspaceOperation
> = {
  handle: (channel, listener) => ipcMain.handle(channel, listener),
  assertTrustedSender,
  withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
    withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
};

const senderWorkspaceAuthority = {
  requireTrustedSender(event: IpcMainInvokeEvent): WebContents {
    assertTrustedSender(event);
    return event.sender;
  },

  withActiveWorkspace<Result>(
    sender: WebContents,
    workspaceId: string,
    subject: string,
    work: (workspace: CreatedWorkspace) => Promise<Result>,
  ): Promise<Result> {
    return withRendererWorkspaceOperation(
      sender,
      workspaceId,
      `The ${subject} does not target the active workspace. Open the workspace and try again.`,
      (operation) => work(operation.workspace),
    );
  },
};

// Injectable clock/id seams (oracle/tests) for renderer-initiated database
// edits, whose nowMs becomes appliedAt (and createId the operationId) in the
// persisted JSONL operation log. Omitted ⇒ the real wall clock / randomUUID,
// identical to today's behavior.
// Exit rounds: every WORKSPACE window answers before a quit or an update
// install, never the manager or the PDF export's hidden preload-less window,
// which would answer nothing while the user sees the unresponsive dialog
// over drafts that were fully available. The state machine lives in
// quitGuard.ts so the busy-renderer promise is a tested fact: a silent ACK
// window opens a MAIN-side dialog that names the loss — it never proceeds by
// itself.
const exitRounds = createExitRounds<BrowserWindow>({
  participants: () => workspaceWindows.allLive(),
  participantId: (window) => window.webContents.id,
  send: (window, message) => {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.exitRound, message);
  },
  confirmProceed: async (kind: ExitKind) => {
    const verb = kind === "quit" ? "Quitting" : "Installing";
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "dohc isn't responding.",
      detail: `${verb} now can lose unsaved recovery text. Wait, or ${kind === "quit" ? "quit" : "install"} anyway.`,
      buttons: ["Wait", kind === "quit" ? "Quit anyway" : "Install anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  },
});

const quitGuard = createQuitGuard({
  ask: () => {
    const round = exitRounds.begin("quit");
    if (!round.created) return;
    void round.outcome.then((outcome) => {
      if (outcome === "proceed") quitGuard.resume();
      else if (outcome === "forced") quitGuard.force();
    });
  },
  quit: () => app.quit(),
  // The user chose "quit anyway" over a renderer that never answered. Destroy
  // the windows that dialog named first: a destroyed window runs no
  // beforeunload, so a renderer that wakes cannot veto the decision and open
  // a second warning. A window the dialog did not cover answered clear for
  // itself and unloads through its own guard, which can still stop the quit
  // over a draft it captured since. App.quit() then follows, so the
  // will-quit teardown — engine sessions, stores, WAL locks — runs exactly
  // as for any other quit.
  forceQuit: () => {
    for (const window of exitRounds.takeForcedParticipants()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.quit();
  },
});

function registerIpcHandlers(): void {
  const windowIpc = createWindowIpc<WebContents, IpcMainInvokeEvent, IpcMainEvent>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    registerEvent: (channel, handler) => ipcMain.on(channel, handler),
    assertTrustedSender, prepareForRendererReload, shell, clipboard, BrowserWindow,
    rememberChromeTheme, titleBarOverlayOptions, stepWindowZoom, exitRounds,
    quitGuard, isTrustedFrame, launchMarks, desktopMarks, logLaunchMarksOnce, app,
  });
  windowIpc.registerReload();

  const { usableRoot } = workspaceRootApproval;
  registerWorkspaceRegistryIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    app,
    dialog,
    roots: workspaceRootApproval,
    effectiveHome,
    workspaceSummaries,
    prioritizePreferredWorkspace,
    createWorkspaceFolder,
    forgetWorkspace,
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openWorkspaceWindow: (workspace) =>
      desktopWindows.openWorkspaceInWindow(workspace, (window) => {
        const session = rendererWorkspaceSessions.current(window.webContents);
        return session?.workspaceId === workspace.workspaceId;
      }),
    openWorkspaceManager: () => desktopWindows.showOrCreateManagerWindow(),
    closeWindowOf: (event) => BrowserWindow.fromWebContents(event.sender)?.close(),
    registerPhysicalWorkspace,
    refreshNativeWorkspaceSurfaces,
    desktopMarks,
  });

  registerDevToolsIpcHandlers<IpcMainInvokeEvent>({
    enabled: devToolsGranted,
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    listWorkspaces,
    forgetWorkspace,
    stateDir,
    showItemInFolder: (path) => shell.showItemInFolder(path),
  });

  const workspaceFilesIpc = createWorkspaceFilesIpc<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    app,
    dialog,
    shell,
    withRendererWorkspaceOperation,
    exactRendererWorkspaceReferences,
    workspaceFileListings,
    workspaceFileMutations,
    listOwnedWorkspaceFilesFor,
    readOwnedWorkspaceTextFor,
    assertWritableWorkspace,
    shareViewFiles,
    listWorkspaces,
    ensureOwnedProjectionCurrent,
    renderHtmlToPdf,
    notifyRenderer,
  });
  workspaceFilesIpc.registerListing();

  const workspaceEngineIpc = createWorkspaceEngineIpc<
    WebContents,
    IpcMainInvokeEvent,
    RegistryEntry,
    DesktopWorkspaceAuthorityState,
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, receivedShareEngine,
    withEngineAdapter, requireEngineCapture, localAgentDisplayName: () => cachedAgentName ?? "Agent", notifyRenderer,
    requireWorkspace, assertWritableWorkspace, syncStatusWithOwnedProjection, activity,
    retryOwnerLiveDelivery: workspaceId => desktopEngine.retryOwnerDelivery(workspaceId),
    workspaceAuthorities, canonicalWorkspaceFor, requireEngineSessions,
    closeDispatchRunActivity, probeEngineStoreRefusal, moveEngineStoreAside,
    openWorkspaceActivityUnderEngineStoreLock, engineYDocSessionIpc,
  });
  workspaceEngineIpc.registerCollections();

  workspaceFilesIpc.registerExports();

  registerNativeMenusIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    app,
    exactRendererWorkspaceReferences,
    sharedViewOf,
    windowForSender: (sender) => BrowserWindow.fromWebContents(sender) ?? undefined,
    buildFromTemplate: (template) => Menu.buildFromTemplate(template),
    currentUpdateState,
    ensureOwnedProjectionCurrent,
    shell,
  });

  workspaceFilesIpc.registerAccess();

  registerWorkspaceGraphIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    withRendererWorkspaceOperation,
    workspaceFileListings,
    listOwnedWorkspaceFilesFor,
    readOwnedWorkspaceTextFor,
    requireEngineCapture,
    syncWorkspaceSharedChannels,
    linkedChatStoreFor,
    activeEngineFileIndex,
  });

  windowIpc.registerExternalUrl();

  registerShareHandoffIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    shareHandoffRedemption,
  });

  registerCloudIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, cloudLogin, clearCachedCredentials, refreshCredentialCache,
    warmCredentialCache, currentCredentials: () => cachedCredentials,
    loadAndCacheCurrentCredentials, closeAllRelayTransportWorkspaces, activity,
    reconcileCloud: () => activity.reconcileCloud(),
    notifyCloudSessionChanged, notifyCloudSessionChangedWithKey,
    notifyRenderer, findWorkspace,
    engineDaemonStartup: () => desktopEngine.startup,
    requireEngineSessions, currentEngineSessions: () => desktopEngine.sessions,
    withPhysicalWorkspaceOperation, withRendererWorkspaceOperation, receivedShareEngine,
    readWorkspaceSecretState, readWorkspaceDataKeyForEnrollment, assertWritableWorkspace,
    relayClientForWorkspace, enrollWorkspaceKeyEnvelope, installWorkspaceDataKey,
    setWorkspaceRemote, usableRoot, readdir, mkdir, probeRelayWorkspace,
    createJoinedWorkspace, bootstrapJoinedWorkspace, refreshNativeWorkspaceSurfaces,
    openWorkspaceActivity, completeWorkspaceJoinBootstrap, desktopMarks,
  });

  registerRelaySharesIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    withRendererWorkspaceOperation,
    remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    currentCredentials: () => cachedCredentials,
    warmCredentialCache,
    relayShareJson,
    relayShareJsonWithCredentials,
    relayShareErrorCopy,
    relayShareDiscussionActivityPolls,
  });

  let installedAppCompiler: ReturnType<typeof createInstalledAppCompiler> | undefined;
  const ownerPublicationDependencies = {
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    flushCapture: async workspace => {
      await openWorkspaceActivity(workspace);
      const capture = activity.engineCaptureFor(workspace.workspaceId, workspace.rootPath);
      if (!capture) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      await capture.flush();
    },
    withAdapter: withEngineAdapter,
    compile: async (request, signal) => {
      installedAppCompiler ??= createInstalledAppCompiler(pluginResourcesBasePath());
      const compile = await installedAppCompiler;
      signal.throwIfAborted();
      return compile(request, { timeoutMs: 60_000, maxMemoryBytes: 1024 * 1024 * 1024, maxProcesses: 8,
        maxInputBytes: 192 * 1024 * 1024, maxOutputBytes: 48 * 1024 * 1024, maxErrorBytes: 64 * 1024 }, signal);
    },
    relayJson: relayShareJsonWithCredentials,
    upload: async (credentials, workspaceId, sha256, bytes, signal) => {
      const result = await relayShareJsonWithCredentials<{ workspaceId: string; sha256: string; byteLength: number }>(credentials,
        `/sync/${encodeURIComponent(workspaceId)}/blobs/${sha256}`, { method: "PUT", signal, body: Uint8Array.from(bytes).buffer,
          headers: { "content-type": "application/octet-stream" } });
      if (result.workspaceId !== workspaceId || result.sha256 !== sha256 || result.byteLength !== bytes.byteLength) throw new Error("The uploaded app bundle does not match. Try publishing again.");
    },
  } satisfies Parameters<typeof registerOwnerAppPublicationIpc<WebContents, DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation>>[0];
  const localDatasetHosts = new WeakMap<AbortSignal, Promise<LocalDatasetHost>>();
  let installedDatasetCompiler: ReturnType<typeof createInstalledDatasetCompiler> | undefined;
  const datasetRuntimePath = join(app.isPackaged ? process.resourcesPath : join(desktopPackageRootInDev(), "resources"), "app-backend-runtime");
  const datasetForWorkspace = async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal) =>
    workspaceAuthorities.withOperation(workspace.workspaceId, async operation => {
      signal.throwIfAborted(); operation.assertCurrent();
      if (operation.workspace.rootPath !== workspace.rootPath) throw new Error("The Collection workspace attachment changed.");
      let pending = localDatasetHosts.get(operation.signal);
      if (!pending) {
        const lifetime = operation.signal;
        pending = createLocalDatasetHost({ workspaceId: workspace.workspaceId, workspaceRoot: workspace.rootPath,
          assertCurrent: () => { lifetime.throwIfAborted(); },
          runtime: { launch: createDesktopAppRuntimeLauncher(utilityProcess, true), entryPath: join(datasetRuntimePath, "child.mjs") },
          persistentRuntime: { launch: createDesktopAppRuntimeLauncher(utilityProcess, false), entryPath: join(datasetRuntimePath, "persistent-child.mjs") },
          compile: async (source, path, signal) => {
            installedDatasetCompiler ??= createInstalledDatasetCompiler(pluginResourcesBasePath());
            return (await installedDatasetCompiler)(source, path, signal);
          },
        });
        localDatasetHosts.set(lifetime, pending);
        activeDatasetHosts.add(pending);
        const ownedPending = pending;
        void pending.then(host => {
          const close = () => { void host.close().catch(error => console.error("Collection shutdown failed", error)).finally(() => activeDatasetHosts.delete(ownedPending)); };
          if (lifetime.aborted) close(); else lifetime.addEventListener("abort", close, { once: true });
        }, () => { localDatasetHosts.delete(lifetime); activeDatasetHosts.delete(ownedPending); });
      }
      const host = await pending;
      signal.throwIfAborted(); operation.assertCurrent();
      return host;
    });
  const datasetDependencies = {
    hostForWorkspace: datasetForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    namedDataForWorkspace: async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal) => {
      await warmCredentialCache();
      const credentials = requireCredentials(cachedCredentials), credentialGeneration = credentialCacheGeneration;
      signal.throwIfAborted();
      const marker = workspace.shareView as { shareId?: unknown; grantedSelector?: unknown; ended?: unknown } | null;
      const cache = namedDatasetPages.scope({ owner: datasetCopyOwnerKey(credentials),
        binding: [workspace.workspaceId, workspace.rootPath, marker?.shareId, credentials.relayUrl],
        localAuthority: [marker?.grantedSelector, marker?.ended ?? false],
        assertCurrent: () => { signal.throwIfAborted(); if (credentialGeneration !== credentialCacheGeneration) throw Error("Your server session changed. Reopen this workspace."); },
      });
      try { return createNamedDatasetData({ workspaceId: workspace.workspaceId, shareView: workspace.shareView, credentials, credentialGeneration, signal,
        currentCredentialGeneration: () => credentialCacheGeneration,
        assertCurrent: () => signal.throwIfAborted(), relayJson: relayShareJsonWithCredentials,
        offline: { relayResponse: (credentials, path, init) => relayShareResponseWithCredentials(credentials, path, init, true), cache },
      }); } catch (error) { await cache.clear(); throw error; }
    },
    dataForWorkspace: async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal) => {
      const local = await datasetForWorkspace(workspace, signal);
      return createDatasetAuthorityRouter(local, {
        status: async datasetId => { signal.throwIfAborted(); return local.transferStatus(datasetId); },
        remote: async (targetOrigin, datasetId) => {
          const remote = await remoteForWorkspace(workspace);
          signal.throwIfAborted();
          if (!remote.credentials.relayUrl || new URL(remote.credentials.relayUrl).origin !== targetOrigin) {
            throw new Error("Sign in to the server that hosts this Collection.");
          }
          const data = createRemoteDatasetData({ workspaceId: workspace.workspaceId, ...remote, signal,
            currentCredentialGeneration: () => credentialCacheGeneration,
            assertCurrent: () => signal.throwIfAborted(), relayJson: relayShareJsonWithCredentials });
          const ownerKey = datasetCopyOwnerKey(remote.credentials);
          const copy = await workspaceAuthorities.withOperation(workspace.workspaceId, async operation => {
            signal.throwIfAborted(); operation.assertCurrent();
            if (operation.workspace.rootPath !== workspace.rootPath) throw new Error("The Collection workspace attachment changed.");
            return ownerDatasetCopies.get({ workspaceId: workspace.workspaceId, rootPath: workspace.rootPath,
              datasetId, origin: targetOrigin, ownerKey, lifetime: operation.signal,
              assertOwner: () => {
                if (!cachedCredentials || datasetCopyOwnerKey(cachedCredentials) !== ownerKey) throw new Error("Sign in as this Collection's owner.");
              },
              runtime: { launch: createDesktopAppRuntimeLauncher(utilityProcess, false), entryPath: join(datasetRuntimePath, "persistent-child.mjs") },
            });
          });
          const source = createRemoteDatasetReplicaSource({ workspaceId: workspace.workspaceId, datasetId, origin: targetOrigin,
            ...remote, signal, currentCredentialGeneration: () => credentialCacheGeneration,
            assertCurrent: () => signal.throwIfAborted(), relayResponse: relayShareResponseWithCredentials,
            onAccessLost: () => copy.accessLost() });
          return copy.data(data, source, signal);
        },
      });
    },
    flushSourceCapture: async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal) => {
      await openWorkspaceActivity(workspace);
      const captured = await withEngineAdapter(workspace, async adapter => {
        signal.throwIfAborted();
        let capture = await adapter.reconcileCapture();
        for (let attempt = 0; !capture.settled && !capture.degraded && attempt < 8; attempt++) {
          signal.throwIfAborted();
          capture = await adapter.flushCapture();
        }
        signal.throwIfAborted();
        if (!capture.settled || !capture.running || capture.degraded) throw new Error("dohc could not capture these Collection files. Reopen the workspace and try again.");
        return true;
      });
      if (!captured) throw new Error("The workspace engine is unavailable. Reopen the workspace.");
    },
    withAdapter: async <T>(workspace: DesktopRendererWorkspaceOperation["workspace"], work: (adapter: import("@dohc/workspace-engine-client").VersionedLiveAdapter) => Promise<T>) => {
      const result = await withEngineAdapter(workspace, work);
      if (result === null) throw new Error("The workspace engine is unavailable. Reopen the workspace.");
      return result;
    },
    createSources: async (workspace: DesktopRendererWorkspaceOperation["workspace"], files: Record<string, string>, signal: AbortSignal) => {
      assertWritableWorkspace(workspace);
      const entries = Object.entries(files).sort(([left], [right]) => Number(left.endsWith("dataset.json")) - Number(right.endsWith("dataset.json")));
      for (const [path, source] of entries) {
        signal.throwIfAborted();
        await createDatasetSourceFile(workspace.rootPath, path, source);
      }
      await openWorkspaceActivity(workspace);
      const captured = await withEngineAdapter(workspace, async adapter => {
        let capture = await adapter.reconcileCapture();
        for (let attempt = 0; !capture.settled && !capture.degraded && attempt < 8; attempt++) {
          signal.throwIfAborted();
          capture = await adapter.flushCapture();
        }
        if (!capture.settled || !capture.running || capture.degraded) throw new Error("Collection files were saved. Reopen the workspace to finish creating the Collection.");
        const metadata = await adapter.captureSourceMetadata({ workspaceId: workspace.workspaceId, versionId: "main", paths: Object.keys(files),
          bounds: { maxInputFiles: 64, maxInputBytes: 2 * 1024 * 1024 }, signal });
        if (metadata.files.length !== entries.length || metadata.files.some(file => !Object.hasOwn(files, file.path) || file.sha256 !== createHash("sha256").update(files[file.path]!).digest("hex"))) {
          throw new Error("Collection source differs from these fields. Choose another folder or review the saved source.");
        }
        return true;
      });
      if (!captured) throw new Error("Collection files were saved. Reopen the workspace to finish creating the Collection.");
      signal.throwIfAborted();
      notifyRenderer({ workspaceId: workspace.workspaceId });
    },
  };
  const exportDatasetArchive = async (workspace: DesktopRendererWorkspaceOperation["workspace"], datasetId: string,
    path: string, overwrite: boolean | undefined, signal: AbortSignal, authorize: () => void) => {
    const local = await datasetForWorkspace(workspace, signal);
    const transfer = local.transferStatus(datasetId);
    if (transfer) {
      if (transfer.state !== "imported") throw new Error("Finish sharing this Collection before exporting it.");
      const remote = await remoteForWorkspace(workspace);
      const archive = await openRemoteDatasetRecoveryExport({ workspaceId: workspace.workspaceId, datasetId,
        origin: transfer.targetOrigin, ...remote, currentCredentialGeneration: () => credentialCacheGeneration,
        signal, assertCurrent: authorize, maxBytes: 1024 * 1024 * 1024 + 2 * 1024 * 1024,
        relayResponse: relayShareResponseWithCredentials });
      try { return (await writeDatasetRecoveryExport({ path, overwrite, stream: archive.stream, maxBytes: archive.maxBytes, signal, authorize })).savedPath; }
      finally { await archive.dispose(); }
    }
    const archive = await local.prepareExport(datasetId, { signal });
    try { return (await writeDatasetRecoveryExport({ path, overwrite, stream: archive.stream(), maxBytes: archive.maxBytes, signal, authorize })).savedPath; }
    finally { await archive.dispose(); }
  };
  const datasetHandler = createDatasetHandler<WebContents, DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation>({
    ...datasetDependencies,
    chooseRecoveryFile: async (_workspace, signal) => {
      const chosen = await dialog.showOpenDialog({ title: "Restore Collection recovery", properties: ["openFile"],
        filters: [{ name: "Collection recovery", extensions: ["dohc-recovery"] }] });
      signal.throwIfAborted();
      return chosen.canceled ? null : chosen.filePaths[0] ?? null;
    },
    exportArchive: async (workspace, input, signal, authorize) => {
      if (input.savePath !== undefined || input.overwrite !== undefined) throw new Error("Choose the recovery export location in the save dialog.");
      const chosen = await dialog.showSaveDialog({ title: "Export Collection recovery", defaultPath: `collection-${input.datasetId.slice(0, 8)}.dohc-recovery`,
        filters: [{ name: "Collection recovery", extensions: ["dohc-recovery"] }] });
      signal.throwIfAborted(); authorize();
      if (chosen.canceled || !chosen.filePath) return null;
      return exportDatasetArchive(workspace, input.datasetId, chosen.filePath, true, signal, authorize);
    },
    withWorkspaceOperation: (sender, workspaceId, work) => withRendererWorkspaceOperation(sender, workspaceId, "Collection changes stopped because this window changed workspaces.", work),
  });
  ipcMain.handle(CHANNELS.dataset, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return DatasetResult.parse(await datasetHandler(event.sender, DatasetRequest.parse(raw)));
  });
  const cliDataset = createDatasetHandler<string, DesktopRendererWorkspaceOperation["workspace"], WorkspaceAuthorityOperation<RegistryEntry, DesktopWorkspaceAuthorityState>>({
    ...datasetDependencies, withWorkspaceOperation: (_caller, workspaceId, work) => workspaceAuthorities.withOperation(workspaceId, work),
    exportArchive: async (workspace, input, signal, authorize) => {
      if (!input.savePath) throw new Error("Choose an absolute recovery export path.");
      return exportDatasetArchive(workspace, input.datasetId, input.savePath, input.overwrite, signal, authorize);
    },
  });
  datasetForCli = async input => DatasetResult.parse(await cliDataset(input.workspaceId, input));
  const localDatasetLaunches = new WeakMap<LocalDatasetHost, Promise<LocalAppLaunchHost>>();
  const localPublication = createLocalOwnerAppPublicationHandler<DesktopRendererWorkspaceOperation["workspace"],
    { workspace: DesktopRendererWorkspaceOperation["workspace"]; signal: AbortSignal; scope?: string; assertCurrent(): void }>({
      ...ownerPublicationDependencies, datasetForWorkspace,
      launchLocalDataset: async (workspace, publicationId, signal) => workspaceAuthorities.withOperation(workspace.workspaceId, async operation => {
        signal.throwIfAborted(); operation.assertCurrent();
        const host = await datasetForWorkspace(workspace, signal);
        let pending = localDatasetLaunches.get(host);
        if (!pending) {
          pending = createLocalAppLaunchHost({ backend: host.apps, lifetime: operation.signal });
          localDatasetLaunches.set(host, pending);
          void pending.catch(() => localDatasetLaunches.delete(host));
        }
        const launcher = await pending;
        signal.throwIfAborted(); operation.assertCurrent();
        return launcher.launch(publicationId, signal);
      }),
    });
  const beforeSharedPublish = async (workspace: DesktopRendererWorkspaceOperation["workspace"], candidate: import("@dohc/security-contract/app-publication").AppPublicationCandidate, signal: AbortSignal) => {
    const dataset = candidate.capabilities.find(capability => capability.kind === "dataset");
    if (dataset) {
      const remote = await remoteForWorkspace(workspace);
      signal.throwIfAborted();
      if (!remote.credentials.relayUrl) throw new Error("Reconnect your sharing server before publishing.");
      const local = await datasetForWorkspace(workspace, signal);
      const targetOrigin = new URL(remote.credentials.relayUrl).origin;
      const target = createRemoteDatasetTransferTarget({ workspaceId: workspace.workspaceId, datasetId: dataset.datasetId, origin: targetOrigin,
        ...remote, currentCredentialGeneration: () => credentialCacheGeneration, signal, assertCurrent: () => signal.throwIfAborted(),
        relayStream: relayShareJsonWithCredentials });
      await local.transferToShared({ datasetId: dataset.datasetId, targetOrigin, target, signal });
      return;
    }
  };
  const resolveDatasetRevision = async (workspace: DesktopRendererWorkspaceOperation["workspace"], binding: import("@dohc/security-contract/dataset").AppDatasetBinding, signal: AbortSignal) =>
    resolveRemoteDatasetRevision(await datasetDependencies.dataForWorkspace(workspace, signal), binding);
  registerOwnerAppPublicationIpc<WebContents, DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation>({ ...ownerPublicationDependencies, localPublication, beforeSharedPublish, resolveDatasetRevision });
  const cliOwnerPublication = createOwnerAppPublicationHandler<string, DesktopRendererWorkspaceOperation["workspace"], WorkspaceAuthorityOperation<RegistryEntry, DesktopWorkspaceAuthorityState>>({
    ...ownerPublicationDependencies, localPublication, beforeSharedPublish, resolveDatasetRevision,
    callerKey: workspaceId => `local-owner-cli:${workspaceId}`,
    withWorkspaceOperation: (_caller, workspaceId, work) => workspaceAuthorities.withOperation(workspaceId, work),
  });
  ownerAppPublicationForCli = input => cliOwnerPublication(input.workspaceId, input);
  const ownerResponseDependencies={
    registerHandler:(channel,handler)=>ipcMain.handle(channel,handler),assertTrustedSender,withRendererWorkspaceOperation,
    remoteForWorkspace,currentCredentialGeneration:()=>credentialCacheGeneration,relayJson:relayShareJsonWithCredentials,
    undoAcceptedResponse:async(workspace,input)=>{
      await openWorkspaceActivity(workspace);
      const capture=activity.engineCaptureFor(workspace.workspaceId,workspace.rootPath);
      if(!capture)throw new Error("dohc could not open app responses. Restart dohc and try again.");
      return capture.undoAcceptedAppResponse(input);
    },
  } satisfies Parameters<typeof registerOwnerAppResponsesIpc<WebContents,DesktopRendererWorkspaceOperation["workspace"],DesktopRendererWorkspaceOperation>>[0];
  registerOwnerAppResponsesIpc(ownerResponseDependencies);
  const cliOwnerResponses=createOwnerAppResponsesHandler<string,DesktopRendererWorkspaceOperation["workspace"],WorkspaceAuthorityOperation<RegistryEntry,DesktopWorkspaceAuthorityState>>({
    ...ownerResponseDependencies,withWorkspaceOperation:(_caller,workspaceId,work)=>workspaceAuthorities.withOperation(workspaceId,work),
  });
  ownerAppResponsesForCli=input=>cliOwnerResponses(input.workspaceId,input);
  const {
    assertShareNotHeldElsewhere,
    reserveAndPullSharedChannelForWorkspace,
    endWorkspaceJoinedChannel,
  } = registerSharedChannelsIpcHandlers<
    WebContents, IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    withRendererWorkspaceOperation,
    requireEngineCapture,
    assertWritableWorkspace,
    linkedChatStoreFor,
    remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    currentCredentials: () => cachedCredentials,
    warmCredentialCache,
    relayShareJsonWithCredentials,
    listWorkspaces,
    setWorkspaceSharedChannels,
    relayClientForWorkspace,
    projectPendingChatBookmarksAfterPull: projectPendingChatBookmarks,
    normalizeServerUrl,
    peekedReceivedGrantKinds,
    peekReceivedGrantKindForShare,
    acknowledgeWorkspaceShareSkips,
    notifyRenderer,
    unmountShareFolder: ({ workspace, shareId, assertCurrent }) =>
      shareMountCommands.unmount({ workspace, shareId, assertCurrent }),
    mountShareFolder: ({ workspace, shareId, relayUrl, labelHint, assertCurrent }) =>
      shareMountCommands.mount({
        workspace,
        shareCode: buildShareCode({ shareId, relayUrl }),
        ...(labelHint.length > 0 ? { labelHint } : {}),
        assertCurrent,
      }),
  });

  const agentRunsIpc = createAgentRunsIpc<WebContents, IpcMainInvokeEvent, RegistryEntry, DesktopRendererWorkspaceOperation>({
    detectAgentTools,
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, receivedShareEngine, withEngineAdapter,
    acknowledgeWorkspaceAutomationFailure, notifyAutomationFailuresChanged, requireEngineCapture,
    linkedChatStoreFor, agentDispatchStoreHandleFor, requireWorkspace, assertAgentRunnableWorkspace,
    assertChatRunnerIdle, startAgentRunWithWorkspaceActivity,
    get cachedAgentSessions() { return cachedAgentSessions; },
    agentIntegration, mcpShareAccessOf, mcpConfigFor, sharedViewOf, pluginWorkspaceRuntimes,
    agentSessionManager, senderWorkspaceAuthority, chatDispatchService, assertWritableWorkspace,
    openWorkspaceActivity,
  });
  agentRunsIpc.registerAutomationFailures();

  registerShareProposalsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, warmCredentialCache,
    currentCredentials: () => cachedCredentials,
    currentCredentialGeneration: () => credentialCacheGeneration,
    normalizeServerUrl, isRecordValue, readOwnedWorkspaceTextFor, activity,
    listShareProposals, readShareProposal, readShareProposalOp, settleShareProposal,
    listMyShareProposals, withdrawShareProposal, withStaleSensitiveWorkspaceOperation,
    shareViewFiles, receivedShareEngine,
  });

  registerSharedViewsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation, DesktopWorkspaceAuthorityLease>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, loadAndCacheCurrentCredentials,
    warmCredentialCache, currentCredentials: () => cachedCredentials,
    engineDaemonStartup: () => desktopEngine.startup,
    fetchShareViewInfo, usableRoot, readdir, mkdir, createJoinedWorkspace,
    setWorkspaceShareView, refreshNativeWorkspaceSurfaces, workspaceAuthorities,
    canonicalWorkspaceFor, withStaleSensitiveWorkspaceOperation, shareViewFiles,
    receivedShareEngine, openWorkspaceActivity, requireWorkspace, notifyRenderer,
  });

  // ---- Share mounts ----
  // The receive side materialized inside a host workspace: the share's
  // filtered files arrive under shared-with-me/<label>/ as ordinary
  // read-only files (agent-readable through normal tools). The mount's pull
  // state lives in its own nested .dohc (invisible to the host tree), and
  // the host's capture/search/relay-push already exclude shared-with-me via
  // the effective-policy floor — mounted content cannot leak into the
  // host's history or its synced copy.

  registerShareMountIpcHandlers({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    withWorkspaceOperation: (event, workspaceId, work) =>
      withRendererWorkspaceOperation(
        event.sender,
        workspaceId,
        "Share update stopped because this window changed workspaces.",
        work,
      ),
    assertWritableWorkspace,
    commands: shareMountCommands,
  });

  registerDesktopDatabaseIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopWorkspaceOperation["workspace"]
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, assertWritableWorkspace,
    shareViewFiles, workerDatabaseReader, editWorkspaceDatabaseInWorker,
  });

  const siteIpcHandlers = createSitesIpcHandlers({
    authority: senderWorkspaceAuthority,
    catalog: ownedSiteCatalog,
  });
  ipcMain.handle(CHANNELS.listSites, siteIpcHandlers.listSites);
  ipcMain.handle(CHANNELS.getSitePackage, siteIpcHandlers.getSitePackage);

  registerAppPreviewIpcHandlers<WebContents, IpcMainInvokeEvent, CreatedWorkspace, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, senderWorkspaceAuthority, withRendererWorkspaceOperation,
    appCatalog: ownedSiteCatalog, appPreviews: sitePreviews,
    isSharedView: (workspaceId) => !!sharedViewOf(workspaceId),
    executeAppPreview,
  });

  registerPluginIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    CreatedWorkspace,
    WebContentsView
  >({
    registrar: {
      handle: (channel, handler) => {
        ipcMain.handle(channel, handler);
      },
    },
    assertTrustedSender,
    workspaces: {
      assertWritable: assertWritableWorkspace,
      withActive: (sender, workspaceId, inactiveMessage, work) =>
        withRendererWorkspaceOperation(
          sender,
          workspaceId,
          inactiveMessage,
          (operation) =>
            work({
              workspace: operation.workspace,
              session: {
                workspaceId: operation.session.workspaceId,
                generation: operation.session.generation,
                isCurrent: operation.isCurrent,
              },
            }),
        ),
    },
    runtimes: pluginWorkspaceRuntimes,
    surfaces: pluginSurfaces,
    platform: {
      createPanelHostLease: createPluginPanelSurfaceHostLease,
      createWebAppContainer: createPluginWebAppContainer,
      createWebAppHostLease: createPluginWebAppHostLease,
      routePanelSdk: routePluginPanelSdk,
      startPanelPreview: startPluginPanelPreview,
    },
  });

  registerOpenWorkspaceIpcHandler<
    WebContents,
    IpcMainInvokeEvent,
    DesktopWorkspaceOperation["workspace"],
    DesktopWorkspaceOperation
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    withPhysicalWorkspaceOperation,
    rendererWorkspaceSessions,
    setPreferredWorkspaceId: (workspaceId) => {
      desktopWindows.setPreferredWorkspaceId(workspaceId);
    },
    markWorkspaceOpened,
    syncStatusWithOwnedProjection,
    openWorkspaceActivity: (operation) =>
      openWorkspaceActivityForOperation(operation, {}, ensureWorkspaceActivityOpen),
    sharedViewOf,
  });

  // Named versions. Every handler resolves the workspace through
  // requireWorkspace (renderer identity is never trusted) and is gated on the
  // engine capture being attached.
  async function requireEngineCapture(
    workspaceOrId: string | RegistryEntry,
    feature: EngineFeature,
  ) {
    const workspace =
      typeof workspaceOrId === "string"
        ? requireWorkspace(workspaceOrId)
        : workspaceOrId;
    // Idempotent: guarantees the watcher + capture are live before any
    // engine operation touches the chain.
    await openWorkspaceActivity(workspace);
    const capture = activity.engineCaptureFor(workspace.workspaceId);
    if (!capture) {
      throw new Error(captureRefusal(feature));
    }
    return { workspace, capture };
  }

  const chatScope = createChatScopeCapability({
    workspaceAuthorities, canonicalWorkspaceFor, requireEngineCapture, linkedChatStoreFor,
    openWorkspaceActivity, receivedShareEngine, activeEngineFileIndex, readOwnedWorkspaceText,
  });

  registerOperations(operationBoundary, workspaceVersionOperations, workspaceVersionHandlers({
    requireEngineCapture, notifyRenderer, activity, tryInVersionSessions, desktopMarks,
  }));

  workspaceEngineIpc.registerHistory();

  registerChatsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, chatScope, requireEngineCapture, linkedChatStoreFor, chatWrites,
    assertWritableWorkspace, warmCredentialCache, localUserId,
    localReactorFallbackId, currentCredentials: () => cachedCredentials, chatRelayIdentityFor,
    syncWorkspaceSharedChannels, syncSharedChannelsForChatTarget,
    syncRendererWorkspaceSharedChannels, withRendererWorkspaceOperation, activeEngineFileIndex,
    activity, desktopChatBookmarks, notifyRenderer,
    ensureGroupFolder: async (workspace, folderPath) => {
      await createFolder(workspace.rootPath, folderPath);
    },
  });

  agentRunsIpc.registerChatRunRecords();

  registerDirectMessagesIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, withRendererWorkspaceOperation, requireEngineCapture,
    assertWritableWorkspace, linkedChatStoreFor, warmCredentialCache,
    currentCredentials: () => cachedCredentials,
    currentCredentialGeneration: () => credentialCacheGeneration,
    remoteForWorkspace, relayShareJsonWithCredentials, normalizeServerUrl, listWorkspaces,
    stateDir, peekedReceivedGrantKinds, syncRendererSharedChannelsForChatTarget,
    assertShareNotHeldElsewhere, reserveAndPullSharedChannelForWorkspace,
    endWorkspaceJoinedChannel, chatScope, localUserDisplayName, activity, chatDispatchService,
  });

  registerPresenceIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, rendererWorkspaceSessions,
  });

  workspaceEngineIpc.registerStatusAndRepair();

  agentRunsIpc.registerAgentRuns();

  const settingsIpc = createSettingsIpc<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, stateDir, enqueueUserSettingsWrite,
    setCachedPreferredName: (preferredName, agentName) => { cachedPreferredName = preferredName; cachedAgentName = agentName; },
    applyZoomLevelToWindows, refreshDispatchTray, openDispatchWorkspaces,
    chatDispatchService, withRendererWorkspaceOperation, notifyRenderer,
    broadcastUserSettings: (result) => {
      for (const window of workspaceWindows.allLive()) {
        window.webContents.send(CHANNELS.userSettingsChanged, result);
      }
    },
  });
  settingsIpc.registerSettingsIpcHandlers();

  windowIpc.registerWindowControls();

  settingsIpc.registerWorkspaceUiStateIpcHandlers();

  registerOperations(operationBoundary, workspaceSearchOperations, workspaceSearchHandlers<
    IpcMainInvokeEvent,
    RegistryEntry & { readonly attachmentId: symbol }
  >({
    withWorkspaceOperation: (event, workspaceId, work) =>
      withRendererWorkspaceOperation(
        event.sender,
        workspaceId,
        "Search stopped because this window changed workspaces. Search the open workspace instead.",
        async (operation) => {
          await openWorkspaceActivityForOperation(
            operation,
            {},
            ensureWorkspaceActivityOpen,
          );
          operation.assertCurrent();
          return work({
            workspace: operation.workspace,
            attachmentId: operation.workspace.attachmentId,
            signal: operation.signal,
            isCurrent: operation.isCurrent,
          });
        },
      ),
    authorizeCancel: (event) =>
      rendererWorkspaceSessions.current(event.sender) !== undefined,
    owner: workspaceSearchOwner,
    onActivityError: (error) => {
      console.error("[desktop] workspace search activity:", error);
    },
  }));

  workspaceEngineIpc.registerYDoc();

  registerUpdatesIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, currentUpdateState, exitRounds, quitGuard,
    get autoUpdateController() { return autoUpdateController; },
  });

  windowIpc.registerQuitAndMarks();

  desktopChatBookmarks.start();
}

// These identities must be set before ready so Windows taskbar grouping and
// Linux X11/Wayland launcher association use the package identities.
if (process.platform === "win32") app.setAppUserModelId("app.dohc.desktop");
if (process.platform === "linux") app.setDesktopName("dohc.desktop");

void appLifecycle.start();
