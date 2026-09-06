import { createWorkspaceFileProtocolHandler } from "./security/workspaceFileProtocol";
import { createPresenceIpc } from "./ipc/presenceIpc";
import { createWorkspaceEngineIpc } from "./ipc/workspaceEngineIpc";
import { createSettingsIpc } from "./ipc/settingsIpc";
import { registerDirectMessagesIpcHandlers, peekReceivedGrantKindForShare } from "./ipc/directMessagesIpc";
import { createChatScopeCapability } from "./ipc/chatScope";
import { registerChatsIpcHandlers } from "./ipc/chatsIpc";
import { registerWorkspaceVersionsIpcHandlers } from "./ipc/workspaceVersionsIpc";
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
import { databaseOpLogPath, normalizeAbsolutePath, preferredBuildOutput } from "@dohc/workspace-core";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import { randomUUID } from "node:crypto";
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
  session,
  shell,
  Tray,
  utilityProcess,
  webContents,
  WebContentsView,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  ListAutomationFailuresPayload,
  DismissAutomationFailurePayload,
  ListAutomationFailuresResult,
  OpenExternalUrlPayload,
  ImportToDatabasePayload,
  ImportToDatabaseResult,
  GetSitePreviewLogsPayload,
  GetSitePreviewLogsResult,
  StopSitePreviewPayload,
  PluginPanelSdkEvent,
  PluginStatusChangedEvent,
  DesktopMarksResult,
  LaunchMarksResult,
  PluginPanelInvalidatedEvent,
  PluginWebAppFailedEvent,
  WorkspaceIdPayload,
  ChatRunRecordsForThreadPayload,
  ChatRunRecordsForThreadResult,
  ReloadRendererRequestPayload,
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
  SetTitlebarThemePayload,
  StepWindowZoomPayload,
  WriteClipboardTextPayload,
  SyncStatusResult,
  RebuildEngineStoreResult,
  WorkspaceSummary,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
  ShareHandoffStatus,
} from "./ipc/bridgeContract";
import { CHANNELS } from "./ipc/channels";
import { createSitesIpcHandlers } from "./ipc/sitesIpc";
import {
  createStartSitePreviewHandler,
  type SitePreviewExecutionInput,
} from "./ipc/sitePreviewIpc";
import { registerShareMountIpcHandlers } from "./ipc/shareMountIpc";
import { registerPluginIpcHandlers } from "./ipc/pluginIpcHandlers";
import { createEngineYDocSessionIpc } from "./workspaces/engineYDocSessionIpc";
import {
  createCollectionRecord,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "./workspaces/collectionRecordEdits";
import { createWorkspaceFileMutationOwner } from "./workspaces/workspaceFileMutationOwner";
import { registerWorkspaceSearchIpcHandlers } from "./ipc/workspaceSearchIpc";

import { createPresencePollRegistry } from "./collab/presencePollRegistry";

import { createDesktopRendererWorkspaceRetirement } from "./mainRendererWorkspaceRetirement";
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
  createQuitGuard,
  createRecoveryChecker,
  createWorkspaceWindowRegistry,
} from "./quitGuard";
import { decideNavigation, isSafeExternalUrl } from "./security/electronSecurity";
import { isInside } from "./security/pathContainment";
import {
  applyDesktopIconToPlatform,
  resolveDesktopIconDirectory,
  resolveSystemThemeIconPath,
} from "./systemThemeIcon";
import { buildMenuTemplate } from "./window/applicationMenu";
import {
  createUserSettingsWriteQueue,
  createGuestZoomApplier,
  createZoomMutation,
  resolvePersistedZoomApplication,
} from "./window/windowZoom";
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
  unacknowledgedAutomationFailures,
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
} from "./workspaces/sharedChannels";
import {
  assertSharedChannelMessageIdentity,
  resolveChatRelayIdentity,
  resolveWorkspaceRelayAuthorId,
  workspaceRemoteMatchesCredentials,
  type ChatRelayIdentityTarget,
} from "./workspaces/chatRelayIdentity";
import { createCloudCredentialStore } from "./workspaces/cloudCredentialStore";
import { resolveManagedCloudConfiguration } from "./workspaces/cloudConfiguration";
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
import { relayUrlsMatch } from "./workspaces/syncCode";
import {
  assertRealMountRoot,
  mountStoreWorkspaceIdFor,
  overlayCanonicalShareMountFiles,
  shareViewFilesMountProjection,
  shareMountRecordsForId,
} from "./workspaces/shareMounts";
import { createShareMountCommands } from "./workspaces/shareMountCommands";
import { prepareOwnedStaticSitePreview } from "./workspaces/ownedStaticSiteFileSource";
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
import { createReceivedShareEngineAccess } from "./workspaces/receivedShareEngineAccess";
import { createCaptureLiveStores } from "./workspaces/workspaceEngineCaptureLiveStore";
import type { ActiveAgentRun } from "./workspaces/workspaceWatcher";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
  type EngineDaemonLifecycle,
} from "@dohc/workspace-engine-client/daemon";
import { bridgeCaptureEventsToRenderer } from "./workspaces/captureActivityBridge";
import { bridgeRecordEventsToPlugins } from "./workspaces/recordEventsBridge";
import { bridgeAutomationClaimsToExecutors } from "./workspaces/automationClaimsBridge";
import {
  broadcastWorkspaceActivity,
  workspaceActivityPayload,
  type WorkspaceActivityScope,
} from "./ipc/workspaceActivityBroadcast";
import { WorkspaceFileListingCache } from "./workspaces/workspaceFileListingCache";
import { probeRelayWorkspace } from "./workspaces/relayWorkspaceProbe";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
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
  EngineWorkspaceSessions,
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
  isAppImageBoot,
  pluginHostEnvFor,
  resolveDohcCliBinDirectory,
  resolveDohcMcpCommand,
  type ChatDispatchPresenceInput,
  type ChatDispatchWorkspace,
} from "./agents/chatDispatchService";
import { refreshLinuxStableCliBin } from "./agents/linuxStableCliBin";
import { CHAT_AGENT_PRESENCE_TOPIC } from "./collab/agentPresence";
import {
  createLiveAgentDispatchStore,
  type LiveAgentDispatchStoreHandle,
} from "./agents/liveAgentDispatchStore";
import { buildOutputSiteRoot } from "./workspaces/sitePackage";
import { createOwnedSiteCatalog } from "./workspaces/ownedSiteCatalog";
import {
  buildSite,
  startSiteDevServer,
  startStaticSitePreview,
  WILL_QUIT_BUDGET_MS,
  type SiteLogEntry,
} from "./workspaces/siteRunner";
import { commandForSiteScript } from "./workspaces/siteScriptCommand";
import { createSitePreviewLifecycle, START_CANCELLED_MESSAGE } from "./workspaces/sitePreviewLifecycle";
import { startStaticDirectoryPreview } from "./security/staticDirectoryPreview";
import { PluginHost } from "./plugins/PluginHost";
import { PluginHostOwnership } from "./plugins/pluginHostOwnership";
import {
  PluginPipeline,
  type PluginPipelineStatusEvent,
} from "./plugins/PluginPipeline";
import {
  acquirePluginSurfaceLease,
  ensurePluginStarted,
} from "./plugins/pluginHostStart";
import { createPluginAuthoredTextWriter } from "./plugins/pluginAuthoredWrite";
import { PluginAutomations } from "./plugins/pluginAutomations";
import {
  invokePluginSdkHost,
  type PluginAutomationRunAuthority,
} from "./plugins/pluginSdkHost";
import { createOwnedWorkspaceSdkReads } from "./workspaces/ownedWorkspaceSdkReads";
import { createPluginUtilityTransport } from "./plugins/pluginUtilityTransport";
import { PluginChildProcessBroker } from "./plugins/pluginChildProcessBroker";
import { PluginWorkspaceEvents } from "./plugins/pluginWorkspaceEvents";
import { createPluginPanelSdkEventEmitter } from "./plugins/pluginPanelSdkEvent";
import { PluginSurfaceHostLifecycle } from "./plugins/pluginSurfaceHostLifecycle";
import { createPluginAgentDrivers } from "./plugins/pluginAgentDrivers";
import { pluginDataDir } from "./plugins/pluginLocalState";
import { pluginIdToSafePath } from "./plugins/pluginSourceSnapshot";
import type { RegisteredPlugin } from "./plugins/pluginPanelRegistration";
import { PluginWorkspaceRuntimes } from "./plugins/pluginWorkspaceRuntimes";
import {
  PluginSurfaces,
  type PluginPanelHostLease,
  type PluginPanelSdkAuthorization,
  type PluginSurfaceHostLease,
  type PluginWebAppContainer,
  type PluginWebAppHostLease,
} from "./plugins/pluginSurfaces";

import {
  prepareWorkspaceFileRead,
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
  shareMountRegistryIsPresent,
  storedShareMounts,
} from "./workspaces/shareViewFilesTarget";
import { createOwnedProjectionRepairer } from "./workspaces/ownedProjectionRepair";
import { createOwnedWorkspaceFileReader } from "./workspaces/ownedWorkspaceFileReader";
import { importOwnedWorkspaceDatabase } from "./workspaces/ownedWorkspaceDatabaseImport";
import {
  workspaceDatabaseWorker,
  type DatabaseEdit,
} from "./workspaces/workspaceDatabase";
import type { OwnedWorkspaceDatabaseReader } from "./workspaces/ownedWorkspaceFileReader";
import { registerWorkspaceDatabaseIpcHandlers } from "./ipc/workspaceDatabaseIpc";
import { WorkspaceGraphIndex } from "./workspaces/workspaceGraph";

import { createDesktopChatBookmarks, type DesktopChatBookmarkProjectionState } from "./workspaces/desktopChatBookmarks";
import { listFiles } from "./workspaces/workspaceFiles";
import {
  readCachedUserSettingsFile,
  writeUserSettingsFile,
} from "./settings/userSettingsStore";
import { readWorkspaceSettingsFile } from "./workspaces/workspaceSettingsFile";
import { createSearchRegistry } from "./workspaces/workspaceSearch";
import { WorkspaceSearchOwner } from "./workspaces/workspaceSearchOwner";
import { createWorkspaceSearchDaemonQuery } from "./workspaces/workspaceSearchDaemonAdapter";
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
import {
  createShareHandoffIntentSlot,
  focusShareHandoffWindow,
  focusShareHandoffWindowWhenReady,
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
let applicationMenuCanInstallUpdate: boolean | null = null;

// app.getAppPath() is unreliable here: when Electron is launched with a
// direct script path (as the e2e harness does, and as a plain built binary
// is), it resolves to the launched script's own directory (dist/main) rather
// than the package root, with no upward package.json search — it silently
// pointed pnpm resolution at dist/main/resources and broke every plugin
// install (the e2e caught this). import.meta.dirname is the currently
// executing module's own directory (dist/main at runtime, exactly like
// the plugin runtime factory's sibling plugin-host.js resolution below), so two
// levels up reaches apps/desktop deterministically regardless of how
// Electron was launched. Both dev-mode resolvers below walk from here, so
// this one call site is the only place that encodes that layout.
function desktopPackageRootInDev(): string {
  return join(import.meta.dirname, "..", "..");
}

function pluginResourcesBasePath(): string {
  return app.isPackaged
    ? process.resourcesPath
    : join(desktopPackageRootInDev(), "resources");
}

function builtinPluginsRoot(): string {
  // Packaged plugin sources live in extraResources as a plain directory,
  // staged from the repo's checked-in apps/desktop/plugins (electron-builder.yml).
  return app.isPackaged
    ? join(process.resourcesPath, "builtin-plugins")
    : join(desktopPackageRootInDev(), "plugins");
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

let linuxStableCliBinDir: string | undefined;

function createPluginWorkspaceRuntimeParts(
  workspace: CreatedWorkspace,
  hooks: { onPipelineStatus(event: PluginPipelineStatusEvent): void },
) {
  const authorityLease = requireWorkspaceAuthority(workspace.workspaceId);
  const authorityBinding = authorityLease.binding;
  if (authorityBinding.canonicalRootPath !== workspace.rootPath) {
    authorityLease.release();
    throw new Error("Plugin runtime creation received a stale workspace root.");
  }
  const surfaces = authorityLease.state.pluginSurfaces;
  authorityLease.release();
  const runWithAuthority = <Result>(work: () => Result | Promise<Result>) =>
    workspaceAuthorities.withBinding(authorityBinding, () => work());
  let pipeline: PluginPipeline | null = null;
  let surfaceHostLifecycle: PluginSurfaceHostLifecycle | null = null;
  const dohcDir = pluginDataDir(stateDir(), workspace.rootPath);
  const childProcessBroker = new PluginChildProcessBroker({
    dohcDir,
    workspaceRoot: workspace.rootPath,
  });
  // This workspace's plugin-contributed agent drivers. They join the driver
  // registry the agent session manager builds, which chooses, probes, and
  // stops them.
  let pluginHostRef: PluginHost | null = null;
  const pluginDrivers = createPluginAgentDrivers({
    host: {
      requestDriver: (pluginId, spawnId, method, params) => {
        if (!pluginHostRef) {
          throw new Error(`Plugin "${pluginId}" is not running.`);
        }
        return pluginHostRef.requestDriver(pluginId, spawnId, method, params);
      },
      stopDriverSpawn: (pluginId, spawnId) => {
        if (!pluginHostRef) return Promise.resolve();
        return pluginHostRef.stopDriverSpawn(pluginId, spawnId);
      },
    },
  });
  // This workspace's plugin file subscriptions, fed by the settled watcher
  // batch (see onWatcherBatch) — the same feed the pipeline reads.
  const workspaceEvents = new PluginWorkspaceEvents();
  // This workspace's origin-device automation executor (ADR 0008): engine
  // access through the same attachment-pinned adapter collection reads take,
  // manifests through the pipeline created below, and handler runs through
  // the same host-ownership lease a command invocation holds.
  const automations = new PluginAutomations({
    withAdapter: (work) =>
      withEngineAdapter(
        {
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          attachmentId: authorityBinding.attachmentId,
        },
        work,
      ),
    declaredAutomations: (pluginId) => {
      const currentPipeline = pipeline;
      if (!currentPipeline || !currentPipeline.discoveryLanded) return undefined;
      return currentPipeline.pluginRegistration(pluginId)?.manifest.automations ?? null;
    },
    // The read-scope proof a collections.watch makes, through the plugin's
    // own owned read port. A "." subscription needs none: the port is
    // workspace-scoped, so every collection a "." claim can name is one the
    // plugin may read. (Unlike a "." watch, claim delivery has no listed-set
    // filter; a narrower per-plugin read scope would need one here.)
    proveReadable: async (_pluginId, collectionPath) => {
      if (collectionPath === ".") return;
      const registered = findWorkspace(workspace.workspaceId);
      if (!registered) {
        throw new Error("This workspace is not registered on this machine.");
      }
      await ownedWorkspaceReadsFor({
        ...registered,
        attachmentId: authorityBinding.attachmentId,
      }).getCollection({ collectionPath });
    },
    runOnPlugin: async (pluginId, params) => {
      const currentPipeline = pipeline;
      // Pipeline still wiring up: the same transient as a host refusal. The
      // executor defers the claim; a settle here would be terminal.
      if (!currentPipeline) return "refused";
      const outcome = await currentPipeline.hostOwnership.runCommand(
        pluginId,
        async (commandAuthority) => {
          const host = await ensurePluginStarted(
            currentPipeline.host,
            pluginId,
            () =>
              commandAuthority.start(() =>
                currentPipeline.ensureStarted(pluginId, commandAuthority),
              ),
          );
          if (!automations.activeRun({ claimId: params.claimId, pluginId })) {
            return { ok: true as const };
          }
          await host.runAutomation(pluginId, params);
          return { ok: true as const };
        },
      );
      // A refusal is the host mid-change on that plugin (or closing) — the
      // run never started, so the claim must not settle failed. The
      // executor keeps it and retries when the plugin next reaches ready.
      return outcome.kind === "completed" ? "completed" : "refused";
    },
    onClaimFailed: () =>
      notifyAutomationFailuresChanged(workspace.workspaceId),
    onError: (context, error) => {
      console.error(
        `[desktop] automations (${workspace.workspaceId}): ${context}:`,
        error,
      );
    },
  });
  const pluginHost = new PluginHost({
    stateDir: stateDir(),
    workspaceRoot: workspace.rootPath,
    spawnTransport: (callbacks) => {
      const dohcMcpCommand = resolveDohcMcpCommand({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        linuxStableCliBinDir,
      });
      const pluginHostEnv = pluginHostEnvFor(dohcMcpCommand, process.env);
      const child = utilityProcess.fork(
        join(import.meta.dirname, "plugin-host.js"),
        [],
        {
          cwd: callbacks.pluginRoot,
          serviceName: "dohc-plugin-host",
          stdio: ["ignore", "ignore", "pipe"],
          // The driver plugins' chat session configs read this seam for the
          // dohc-mcp command they hand the user's AI tool. Only main knows
          // whether this install is packaged and where its stable launcher
          // lives. If that launcher is unavailable, the host gets an explicit
          // marker and no command it could leak into a spawned process.
          env: pluginHostEnv,
        },
      );
      return createPluginUtilityTransport(child, callbacks);
    },
    // Shares invokeWorkspacePluginSdk with the panel SDK route
    // (invokePluginPanelSdk below) so both paths get the same isWritable /
    // writeAvailable / MomentAuthor handling instead of a second copy. Only
    // this, the plugin's own request path (not the panel path), supplies
    // invokeChildProcess — a panel is renderer-driven UI, not the plugin's
    // own activated code, so it never brokers child processes.
    routeSdkRequest: (
      pluginId,
      method,
      params,
      spawnId,
      signal,
      emitEvent,
      automationClaimId,
    ) =>
      runWithAuthority(() =>
        invokeWorkspacePluginSdk({
          workspaceId: workspace.workspaceId,
          pluginId,
          spawnId,
          requestPath: "plugin-process",
          isWritable: () => !sharedViewOf(workspace.workspaceId),
          signal,
          ...(automationClaimId === undefined ? {} : { automationClaimId }),
          invokeChildProcess: (childMethod, childParams) =>
            childProcessBroker.invoke(
              { pluginId, spawnId, signal, emitEvent },
              childMethod,
              childParams,
            ),
          subscribeFileWatch: (watchParams) =>
            workspaceEvents.subscribe(
              {
                owner: { kind: "process", pluginId, spawnId },
                emitEvent,
              },
              watchParams,
            ),
          subscribeRecordWatch: (watchParams, readable) =>
            workspaceEvents.subscribeRecords(
              {
                owner: { kind: "process", pluginId, spawnId },
                emitEvent,
              },
              watchParams,
              readable,
            ),
          unsubscribeWorkspaceEvents: (watchParams) =>
            workspaceEvents.unsubscribe(
              { owner: { kind: "process", pluginId, spawnId } },
              watchParams,
            ),
          method,
          params,
        }),
      ),
    // The plugin gets its settings with its activation, so it never starts
    // without them and never has to ask. Named by directoryName — settings
    // are stored per directory, and a manifest's declared name can differ
    // from the folder it was found in.
    readPluginSettings: async (directoryName) =>
      (await pipeline?.getPluginSettings(directoryName)) ?? {},
    onDriversRegistered: (pluginId, spawnId, drivers) =>
      pluginDrivers.register(pluginId, spawnId, drivers),
    onDriverEvent: (pluginId, spawnId, params) =>
      pluginDrivers.handleEvent(pluginId, spawnId, params),
    // One seam ends a spawn: the driver's sessions fail here, and the broker
    // takes the harness's whole process tree down. Neither asks the plugin.
    onSpawnEnd: (pluginId, spawnId) => {
      surfaceHostLifecycle?.spawnEnded(pluginId);
      pluginDrivers.endSpawn(pluginId, spawnId);
      workspaceEvents.disposeSpawn(pluginId, spawnId);
      return childProcessBroker.disposeSpawn(pluginId, spawnId);
    },
    onDispose: () => childProcessBroker.dispose(),
    onStatusChange: (pluginId, status) => {
      void Promise.resolve(
        surfaceHostLifecycle?.statusChanged(pluginId, status),
      ).catch(() => undefined);
    },
    onRecoveryDisposition: (pluginId, disposition) => {
      void Promise.resolve(
        surfaceHostLifecycle?.recoveryDisposition(pluginId, disposition),
      ).catch(() => undefined);
    },
  });
  pluginHostRef = pluginHost;
  surfaceHostLifecycle = new PluginSurfaceHostLifecycle({
    workspaceId: workspace.workspaceId,
    host: pluginHost,
    surfaces,
    onRuntimeStatus: (pluginId, status) =>
      pipeline?.noteRuntimeStatus(pluginId, status),
    onError: (error, context) => {
      console.error(`[desktop] ${context}:`, error);
    },
  });
  const hostOwnership = new PluginHostOwnership(pluginHost, {
    onCleanupError: (pluginId, error) => {
      console.warn(
        `[desktop] failed to clean up plugin host ownership for "${pluginId}"`,
        error,
      );
    },
  });
  pipeline = new PluginPipeline({
    workspaceRoot: workspace.rootPath,
    stateDir: stateDir(),
    hostOwnership,
    resourcesBasePath: pluginResourcesBasePath(),
    pnpmRunnerEntry: join(import.meta.dirname, "pnpm-runner.js"),
    // The automation executor reads every status first, so a plugin's
    // engine subscriptions are reconciled before the renderer hears about
    // the same transition.
    onStatusChange: (event) => {
      automations.handlePipelineStatus(event);
      hooks.onPipelineStatus(event);
    },
    onRuntimeStopped: (pluginId) =>
      surfaces.stop({
        kind: "plugin",
        workspaceId: workspace.workspaceId,
        pluginId,
      }),
    isEngineCaptureAvailable: () =>
      withWorkspaceAttachment(
        {
          workspaceId: workspace.workspaceId,
          attachmentId: authorityBinding.attachmentId,
        },
        (lease) =>
          workspaceActivity.engineCaptureFor(lease.state.activity) !== null,
      ) ?? false,
  });
  return { pipeline, agentDrivers: pluginDrivers, workspaceEvents, automations };
}

async function relativeWorkspacePath(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string> {
  const [realWorkspaceRoot, realAbsolutePath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(absolutePath),
  ]);
  const rel = relative(realWorkspaceRoot, realAbsolutePath).replaceAll("\\", "/");
  // Strict on purpose: the workspace root itself is not a build output.
  if (rel === "" || !isInside(realWorkspaceRoot, realAbsolutePath)) {
    throw new Error(`Build output escaped the workspace: ${absolutePath}`);
  }
  return rel;
}

function buildOutputRelativeToSite(siteRoot: string, workspaceRelativeOutput: string): string {
  if (siteRoot === ".") return workspaceRelativeOutput;
  if (workspaceRelativeOutput === siteRoot) return ".";
  if (!workspaceRelativeOutput.startsWith(`${siteRoot}/`)) {
    throw new Error(
      `Build output must be inside the app folder: ${workspaceRelativeOutput}`,
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

async function executePreviewForSite(input: SitePreviewExecutionInput) {
  if (input.mode === "static") {
    const target = await prepareOwnedStaticSitePreview({
      site: input.site,
      sharedView: input.sharedView,
      resolveOwner: (path) =>
        shareViewFilesTargetForPath({ workspaceId: input.workspaceId }, path),
      readOwner: async (ownerTarget, ownerPath) => {
        const read = await shareViewFiles.read(ownerTarget, {
          kind: "asset",
          path: ownerPath,
        });
        if (read.kind !== "asset") {
          throw new Error("Shared app file returned an invalid result.");
        }
        return read.bytes;
      },
    });
    const handle = await startStaticSitePreview(input.workspaceRoot, target.root, {
      authority: input.site.authority,
      entry: target.entry,
      ...(target.fileSource ? { fileSource: target.fileSource } : {}),
    });
    return {
      handle,
      result: {
        siteRoot: input.site.root,
        mode: input.mode,
        logs: [],
      },
    };
  }

  if (input.mode === "dev") {
    if (
      !input.site.configuredScripts.dev &&
      !input.site.scripts.dev &&
      !input.site.configuredScripts.start &&
      !input.site.scripts.start
    ) {
      throw new Error(`App has no dev or start script: ${input.site.root}`);
    }
    const script =
      input.site.configuredScripts.dev || input.site.scripts.dev ? "dev" : "start";
    const command = commandForSiteScript(input.site, script);
    const handle = await startSiteDevServer({
      workspaceRoot: input.workspaceRoot,
      siteRoot: input.site.root,
      command: command.command,
      args: command.args,
      signal: input.signal,
    });
    return {
      handle,
      result: {
        siteRoot: input.site.root,
        mode: input.mode,
        logs: handle.logs(),
      },
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
  let outputRoot = preferredBuildOutput(input.site);
  if (input.site.configuredScripts.build || input.site.scripts.build) {
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
        `App build failed or did not produce a static output folder.${
          recentLogs ? `\n\nRecent output:\n${recentLogs}` : ""
        }`,
      );
    }
    outputRoot = buildOutputRelativeToSite(
      input.site.root,
      await relativeWorkspacePath(input.workspaceRoot, result.outputPath),
    );
  }
  if (!input.isCurrent() || input.signal.aborted) {
    throw new Error(START_CANCELLED_MESSAGE);
  }
  if (!outputRoot) throw new Error(`App has no build output to preview: ${input.site.root}`);
  const handle = await startStaticSitePreview(
    input.workspaceRoot,
    buildOutputSiteRoot(input.site, outputRoot),
    { authority: input.site.authority },
  );
  return {
    handle,
    result: {
      siteRoot: input.site.root,
      mode: input.mode,
      logs,
      ...(build ? { build } : {}),
    },
  };
}

// Lazy: safeStorage and userData are only safe to touch after app ready, and
// handlers register inside whenReady. The session token lives encrypted in
// the credential store and never crosses IPC.
let cachedCloudLogin: CloudLogin | null = null;
const managedCloudConfiguration = resolveManagedCloudConfiguration(process.env);
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
      ...(managedCloudConfiguration.status === "ready"
        ? {
            defaultServerUrl: managedCloudConfiguration.serverUrl,
            defaultRelayUrl: managedCloudConfiguration.relayUrl,
          }
        : {}),
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

// The windows that RUN the workspace renderer. Not every BrowserWindow does:
// the PDF export creates a hidden, preload-less one, and asking IT about
// set-aside drafts would answer nothing. Tracked at
// creation instead of guessed from getAllWindows().
const workspaceWindows = createWorkspaceWindowRegistry<BrowserWindow>(
  (window) => window.isDestroyed(),
);
// The last zoom level any path applied (mutation, settings save, or the
// persisted read). The bootstrap seeds it from the cached settings read
// before the first window exists, so every window — including the first of
// a launch — starts at the right scale before any show(). Null only until
// that seed lands, which precedes every window creation.
let knownZoomLevel: number | null = null;

function trackWorkspaceWindow(window: BrowserWindow): BrowserWindow {
  workspaceWindows.track(window);
  window.on("closed", () => workspaceWindows.forget(window));
  // The persisted zoom level is a window property main owns, set
  // synchronously at creation — before any show() on either creation path —
  // so no visible frame paints at 100% and then jumps. The async read below
  // is the reconcile backstop (a settings save can land mid-launch);
  // best-effort — a fresh install has only the default.
  if (knownZoomLevel !== null) {
    window.webContents.setZoomLevel(knownZoomLevel);
  }
  const persistedZoom = readCachedUserSettingsFile(stateDir())
    .then(({ settings }) => settings.appearance.zoomLevel)
    .catch(() => null);
  const applyPersistedZoom = () => {
    void persistedZoom.then((zoomLevel) => {
      const application = resolvePersistedZoomApplication(
        zoomLevel,
        knownZoomLevel,
      );
      if (application === null) return;
      if ("applyEverywhere" in application) {
        // One path for hosts and guests: a guest attached before the read
        // resolved must not stay at 100% until the next zoom change.
        applyZoomLevelToWindows(application.applyEverywhere);
      } else if (!window.isDestroyed()) {
        window.webContents.setZoomLevel(application.applyToWindow);
      }
    });
  };
  window.once("ready-to-show", applyPersistedZoom);
  window.webContents.once("did-finish-load", applyPersistedZoom);
  return window;
}
function liveWorkspaceWindow(): BrowserWindow | undefined {
  return workspaceWindows.live();
}

function targetWindow(window: BrowserWindow | undefined): BrowserWindow | undefined {
  return window ?? liveWorkspaceWindow() ?? BrowserWindow.getAllWindows()[0];
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

// One user-settings write queue for every caller. Full saves and zoom steps
// cannot interleave their file mutations.
//
// Tracked workspace windows only, never getAllWindows(): a hidden utility
// window (the PDF export renderer) must keep its own zoom, or an export
// mid-render would change layout with the user's keystroke.
function applyZoomLevelToWindows(zoomLevel: number): void {
  knownZoomLevel = zoomLevel;
  for (const window of workspaceWindows.allLive()) {
    window.webContents.setZoomLevel(zoomLevel);
  }
  // Embedded plugin content follows the window zoom: the person who
  // zoomed because text was too small is usually working IN the panel. Only
  // embedded guests — the same app opened by URL keeps the browser's zoom.
  pluginSurfaces.applyWebAppZoom(zoomLevel);
}

const bindGuestZoom = createGuestZoomApplier(() => knownZoomLevel);

const enqueueUserSettingsWrite = createUserSettingsWriteQueue();
const mutateWindowZoom = createZoomMutation({
  enqueue: enqueueUserSettingsWrite,
  read: () => readCachedUserSettingsFile(stateDir()),
  write: (settings) => writeUserSettingsFile(stateDir(), settings),
  apply: applyZoomLevelToWindows,
});

async function stepWindowZoom(
  step: Parameters<typeof mutateWindowZoom>[0],
): Promise<DesktopUserSettingsResult> {
  const result = DesktopUserSettingsResult.parse(await mutateWindowZoom(step));
  for (const window of workspaceWindows.allLive()) {
    window.webContents.send(CHANNELS.userSettingsChanged, result);
  }
  return result;
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
        stepZoom: (step) => {
          void stepWindowZoom(step).catch((error) => {
            console.error("[desktop] window zoom:", error);
            // The accelerator path has no renderer surface to answer on (the
            // palette and Settings show their own errors), so the refusal —
            // e.g. an unreadable settings file — must reach the user here.
            dialog.showErrorBox(
              "Zoom",
              error instanceof Error
                ? `${error.message} Open Settings to repair or reset it.`
                : "dohc could not change the window zoom.",
            );
          });
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
// Share kind is relay/account-scoped, not workspace-scoped. Keep one cache
// across physical workspaces in the same session, and clear it whenever that
// credential session ends or changes.
const peekedReceivedGrantKinds = new Map<string, "dm" | "not-dm">();
const credentialSessionCache =
  new CredentialSessionCache<CloudSessionCredentials>((snapshot) => {
    cachedCredentials = snapshot.credentials;
    credentialCacheGeneration = snapshot.generation;
    shareHandoffRedemption.credentialsChanged();
  });
function refreshCredentialCache(): Promise<void> {
  return credentialSessionCache.refresh(() => cloudLogin().credentials());
}
function warmCredentialCache(): Promise<void> {
  return credentialSessionCache.warm(() => cloudLogin().credentials());
}
function clearCachedCredentials(): void {
  credentialSessionCache.clear();
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

const SHARE_HANDOFF_REDEMPTION_FETCH_TIMEOUT_MS = 15_000;
const shareHandoffRedemption = createShareHandoffRedemptionCoordinator({
  intent: shareHandoffIntentSlot,
  createStatusId: randomUUID,
  credentialSnapshot: () => credentialSessionCache.snapshot(),
  fetch: relayFetchWithTimeout(SHARE_HANDOFF_REDEMPTION_FETCH_TIMEOUT_MS),
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
    throw new Error("Your dohc Cloud session changed. Try again.");
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

type RelayShareRetainedDependentSetResult<T> =
  | { kind: "success"; body: T }
  | { kind: "dependents-changed"; body: unknown; status: number };

type RelayShareRetainedNotFoundResult<T> =
  | { kind: "success"; body: T }
  | { kind: "missing" };

type RelayShareJsonOptions =
  | { retainDependentSetConflict: true }
  | { retainNotFound: true };

const RELAY_SHARE_FETCH_TIMEOUT_MS = 15_000;
const relayShareFetch = relayFetchWithTimeout(RELAY_SHARE_FETCH_TIMEOUT_MS);

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
    throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
  }
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
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
      "Your dohc Cloud session expired. Sign in again, then retry.",
      { sessionWasCurrent },
    );
  }
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    code?: string;
    [key: string]: unknown;
  }
    | null;
  if (!response.ok || data?.ok === false) {
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
  if (options) {
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
  workspaceChatLifecycle: ReturnType<typeof createWorkspaceChatLifecycle>;
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
    workspaceChatLifecycle: createWorkspaceChatLifecycleFor(binding),
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
      state.workspaceChatLifecycle.settled(),
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

function withWorkspaceAttachment<Result>(
  workspace: { workspaceId: string; attachmentId?: symbol },
  work: (lease: DesktopWorkspaceAuthorityLease) => Result,
): Result | undefined {
  if (!findWorkspace(workspace.workspaceId)) return undefined;
  let lease: DesktopWorkspaceAuthorityLease;
  try {
    lease = requireWorkspaceAuthority(workspace.workspaceId);
  } catch {
    return undefined;
  }
  try {
    if (
      workspace.attachmentId !== undefined &&
      lease.binding.attachmentId !== workspace.attachmentId
    ) {
      return undefined;
    }
    return work(lease);
  } finally {
    lease.release();
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

function withWorkspaceAttachmentAsync<Result>(
  workspace: { workspaceId: string; attachmentId?: symbol },
  work: (lease: DesktopWorkspaceAuthorityLease) => Result | Promise<Result>,
): Promise<Result> {
  return workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) => {
    if (
      workspace.attachmentId !== undefined &&
      lease.binding.attachmentId !== workspace.attachmentId
    ) {
      throw new Error("This callback belongs to a retired workspace authority.");
    }
    return work(lease);
  });
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

function registerPhysicalWorkspace(
  workspace: RegistryEntry,
): DesktopWorkspaceAuthorityBinding {
  return workspaceAuthorities.registerBinding(
    workspace,
    physicalWorkspaceRegistration(workspace),
  );
}

function registerReservedPhysicalWorkspace(
  reservation: WorkspaceAuthorityReservation,
  workspace: RegistryEntry,
): DesktopWorkspaceAuthorityBinding {
  return workspaceAuthorities.registerReservedBinding(
    reservation,
    workspace,
    physicalWorkspaceRegistration(workspace),
  );
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
const { queueChatBookmarkProjection, projectPendingChatBookmarksAfterPull } = desktopChatBookmarks;

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
  projectPendingChatBookmarksAfterPull,
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
  if (!rustEngineRelayClient) {
    throw new Error("Rust engine relay client is unavailable.");
  }
  return rustEngineRelayClient.bind(input);
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
    onChange: () => {
      withWorkspaceAttachment(workspace, () => {
        notifyRenderer({ workspaceId: workspace.workspaceId });
        void withWorkspaceAttachmentAsync(workspace, () =>
          chatDispatchService.scanWorkspace(workspace.workspaceId),
        ).catch((error) => {
          console.error("[desktop] relay dispatch scan:", error);
        });
      });
    },
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
        projectPendingChatBookmarksAfterPull(workspace.workspaceId),
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
  onWatcherBatch: (workspace, events) => {
    withWorkspaceAttachment(workspace, () =>
      pluginWorkspaceRuntimes.current(workspace.workspaceId)
        ?.handleWatcherEvents(events),
    );
  },
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
  reconcileCloud: (engineFor: typeof engineForWorkspace): void => {
    for (const workspaceId of workspaceAuthorities.workspaceIds()) {
      withWorkspaceActivityState(workspaceId, (lease) =>
        workspaceActivity.reconcileCloud(lease.state.activity, engineFor, false),
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
    withWorkspaceActivityState(workspaceId, (lease, workspace) =>
      workspaceActivity.getStatus(workspace, lease.state.activity),
    ),
  listOpenWorkspaceIds: () =>
    workspaceAuthorities.workspaceIds().filter((workspaceId) =>
      withWorkspaceActivityState(workspaceId, (lease) =>
        workspaceActivity.isOpen(lease.state.activity),
      ),
    ),
  queueCloudSync: (workspaceId: string): void => {
    if (!findWorkspace(workspaceId)) return;
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
  operationsFor: async (workspaceId) => {
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
  if (!rustEngineWorkspaceSessions) {
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
    sessions: rustEngineWorkspaceSessions,
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
  if (!rustEngineWorkspaceSessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  const binding = lease.binding;
    const handle = createLiveAgentDispatchStore(
      {
        workspaceId: binding.workspaceId,
        rootPath: binding.canonicalRootPath,
        attachmentId: binding.attachmentId,
      },
    rustEngineWorkspaceSessions,
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
  const sessions = rustEngineWorkspaceSessions;
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

async function verifiedChatAuthorUserIdFor(
  workspaceId: string,
  target: ChatRelayIdentityTarget,
  store: DesktopLinkedChatStore,
): Promise<string | undefined> {
  const identity = await chatRelayIdentityFor(workspaceId, target, store);
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
  store: DesktopLinkedChatStore,
): Promise<void> {
  await assertSharedChannelWritable({
    workspaceId: workspace.workspaceId,
    sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
    store,
    target,
  });
  const currentAuthorUserId = await verifiedChatAuthorUserIdFor(
    workspace.workspaceId,
    target,
    store,
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
    await lease.state.workspaceChatLifecycle.open(
      current,
      () => ensureWorkspaceActivityOpen(current),
    );
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
      return {
        displayName: localUserDisplayName(),
        ...(verifiedUserId ? { verifiedUserId } : {}),
      };
    }),
  stateDir,
  appRoot: () => app.getAppPath(),
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

function createWorkspaceChatLifecycleFor(
  binding: WorkspaceAuthorityBinding<RegistryEntry>,
) {
  return createWorkspaceChatLifecycle({
    isReadOnly: (workspaceId) =>
      withWorkspaceAttachment(
        { workspaceId, attachmentId: binding.attachmentId },
        () => Boolean(sharedViewOf(workspaceId)),
      ) ?? true,
    isReadyForMaintenance: (workspaceId) =>
      withWorkspaceAttachment(
        { workspaceId, attachmentId: binding.attachmentId },
        () => findWorkspace(workspaceId)?.joinBootstrapPending !== true,
      ) ?? false,
    maintain: async (rootPath) => {
      if (rootPath !== binding.canonicalRootPath) {
        throw new Error("Chat maintenance received a stale workspace root.");
      }
      await ensureAgentsChatBlock(rootPath);
    },
    onError: (error) => {
      console.error("[desktop] AGENTS.md chat description:", error);
    },
  });
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
  await engineDaemonStartup;
  operation.assertCurrent();
  const canonicalWorkspace = operation.workspace;
  operation.state.retainedActivity = true;
  const result = await operation.state.workspaceChatLifecycle.open(
    canonicalWorkspace,
    () => ensureOpen(canonicalWorkspace, options),
    options.afterActivityOpen,
  );
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

function createPluginSurfaceHostLease(
  pipeline: PluginPipeline,
  pluginId: string,
): PluginSurfaceHostLease {
  const host = pipeline.host;
  const lease = acquirePluginSurfaceLease(pipeline.hostOwnership, pluginId);
  return {
    start: async () => {
      const startedHost = await ensurePluginStarted(
        host,
        pluginId,
        () =>
          lease.start((authority) =>
            pipeline.ensureStarted(pluginId, authority),
          ),
      );
      const spawnId = startedHost.getSpawnId(pluginId);
      if (!spawnId) {
        throw new Error(`Plugin "${pluginId}" has no active process.`);
      }
      return spawnId;
    },
    currentSpawnId: () => host.getSpawnId(pluginId),
    release: () => lease.release(),
  };
}

function createPluginPanelSurfaceHostLease(
  pipeline: PluginPipeline,
  pluginId: string,
): PluginPanelHostLease {
  const host = pipeline.host;
  const lease = createPluginSurfaceHostLease(pipeline, pluginId);
  return {
    ...lease,
    currentRecord: () => host.currentRecord(pluginId),
    startPanel: async (panelId) => {
      const spawnId = await lease.start();
      const ready = host.readyPanelsForSpawn(pluginId, spawnId);
      const panel = ready?.panels.find((candidate) => candidate.id === panelId);
      if (!ready || !panel) {
        throw new Error(
          `Plugin "${pluginId}" does not declare panel "${panelId}" in its active runtime.`,
        );
      }
      return { spawnId, hostRecord: ready.record, panel };
    },
  };
}

function createPluginWebAppHostLease(
  pipeline: PluginPipeline,
  pluginId: string,
  webAppId: string,
  instanceKey: string | null,
): PluginWebAppHostLease {
  const host = pipeline.host;
  return {
    ...createPluginSurfaceHostLease(pipeline, pluginId),
    startWebApp: () => host.startWebApp(pluginId, webAppId, instanceKey),
    unpair: (expectedSpawnId) => {
      if (host.getSpawnId(pluginId) !== expectedSpawnId) return Promise.resolve();
      return host.stopWebApp(pluginId, webAppId, instanceKey);
    },
  };
}

function createPluginWebAppContainer(
  sender: WebContents,
): PluginWebAppContainer<WebContentsView> {
  let attachedWindow: BrowserWindow | null = null;
  return {
    isDestroyed: () => {
      const window = attachedWindow ?? BrowserWindow.fromWebContents(sender);
      return !window || window.isDestroyed();
    },
    attach: (view) => {
      const window = BrowserWindow.fromWebContents(sender);
      if (!window || window.isDestroyed()) {
        throw new Error("The plugin web app request has no open window.");
      }
      attachedWindow = window;
      window.contentView.addChildView(view);
    },
    detach: (view) => {
      const window = attachedWindow;
      attachedWindow = null;
      if (!window || window.isDestroyed()) return;
      window.contentView.removeChildView(view);
    },
  };
}

// Tells one renderer its guest died after the start already answered "ok".
// Without it the page keeps a `ready` state over an empty frame and the user
// sees a blank tab with nothing to act on. The event carries no failure text:
// the load error can embed the start URL, credential fragment included.
//
// generation gates this the same way every other send in this file does
// (round-13 finding 3): WebContents ids recycle across a crash-reload, so
// a sender resolved by a stale id — or a captured reference whose renderer
// has since reloaded — could otherwise deliver a dead guest's failure to
// whatever unrelated page now answers to that id or generation.
function notifyPluginWebAppFailed(
  sender: WebContents,
  generation: number,
  event: PluginWebAppFailedEvent,
): void {
  if (
    sender.isDestroyed() ||
    rendererWorkspaceSessions.current(sender)?.generation !== generation
  ) {
    return;
  }
  sender.send(CHANNELS.pluginWebAppFailed, PluginWebAppFailedEvent.parse(event));
}

function notifyPluginPanelInvalidated(
  sender: WebContents,
  generation: number,
  event: PluginPanelInvalidatedEvent,
): void {
  if (
    sender.isDestroyed() ||
    rendererWorkspaceSessions.current(sender)?.generation !== generation
  ) {
    return;
  }
  sender.send(
    CHANNELS.pluginPanelInvalidated,
    PluginPanelInvalidatedEvent.parse(event),
  );
}

function createPluginSurfaces(
  binding: WorkspaceAuthorityBinding<RegistryEntry>,
  pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace>,
): PluginSurfaces<WebContentsView> {
  return new PluginSurfaces<WebContentsView>({
  ViewClass: WebContentsView,
  bindWebAppZoom: bindGuestZoom,
  allowPanelOrigin: allowLoopbackFrameOrigin,
  clearPanelStorage: (options) =>
    session.defaultSession.clearStorageData(options),
  clearGuestPartition: (partition) =>
    session.fromPartition(partition).clearStorageData(),
  notifyWebAppFailed: ({ senderId, generation, ...event }) => {
    const sender = webContents.fromId(senderId);
    if (!sender) return;
    withWorkspaceAttachment(
      {
        workspaceId: binding.workspaceId,
        attachmentId: binding.attachmentId,
      },
      () => notifyPluginWebAppFailed(sender, generation, event),
    );
  },
  notifyPanelInvalidated: ({ senderId, generation, ...event }) => {
    const sender = webContents.fromId(senderId);
    if (!sender) return;
    withWorkspaceAttachment(
      {
        workspaceId: binding.workspaceId,
        attachmentId: binding.attachmentId,
      },
      () => notifyPluginPanelInvalidated(sender, generation, event),
    );
  },
  onPanelDisposed: ({ workspaceId, pluginId, panelId, surfaceId }) => {
    pluginRuntimes.current(workspaceId)?.workspaceEvents.disposeOwner({
      kind: "panel",
      workspaceId,
      pluginId,
      panelId,
      surfaceId,
    });
  },
  onError: (error, context) => {
    console.warn(`[desktop] ${context}`, error);
  },
  });
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

async function invokeWorkspacePluginSdk(input: {
  workspaceId: string;
  pluginId: string;
  spawnId: string;
  requestPath: "panel" | "plugin-process";
  isWritable: () => boolean;
  signal?: AbortSignal;
  /** The claim id the plugin-process request declared (see SdkRequestParams). */
  automationClaimId?: string;
  invokeChildProcess?: (method: string, params?: unknown) => Promise<unknown>;
  subscribeFileWatch?: (params: unknown) => { subscriptionId: string };
  subscribeRecordWatch?: (
    params: unknown,
    readable?: ReadonlySet<string>,
  ) => { subscriptionId: string };
  unsubscribeWorkspaceEvents?: (params: unknown) => boolean;
  method: string;
  params?: unknown;
}): Promise<unknown> {
  return withPhysicalWorkspaceOperation(input.workspaceId, async (operation) => {
    const workspace = operation.workspace;
    const signal = input.signal
      ? AbortSignal.any([input.signal, operation.signal])
      : operation.signal;
    // Resolve a request-declared automation claim against the runs this
    // workspace's executor actually started on this plugin — main-derived
    // authority, like the author; the plugin's tag grants nothing.
    const automationRun: PluginAutomationRunAuthority | undefined =
      input.automationClaimId === undefined
        ? undefined
        : operation.state.pluginRuntimes
            .current(input.workspaceId)
            ?.automations.activeRun({
              claimId: input.automationClaimId,
              pluginId: input.pluginId,
            });
    return invokePluginSdkHost(
      {
        pluginId: input.pluginId,
        workspaceRoot: workspace.rootPath,
        spawnId: input.spawnId,
        requestPath: input.requestPath,
        ...(input.automationClaimId === undefined
          ? {}
          : { automationClaimId: input.automationClaimId }),
        ...(automationRun === undefined ? {} : { automationRun }),
        // Read from the registration main holds, never from the request: what a
        // plugin may open is what its approved manifest declares.
        declaredWebApps: operation.state.pluginRuntimes
          .current(input.workspaceId)
          ?.registeredPlugin(input.pluginId)
          ?.manifest.webApps,
        isWritable: input.isWritable,
        /** Main supplies this read authority. Plugins cannot select or widen it. */
        reads: ownedWorkspaceReadsFor(workspace, workerDatabaseReader(signal)),
        editDatabase: ({ path, edit, author, nowMs, operationId, signal: editSignal }) =>
          editWorkspaceDatabaseInWorker({
            rootPath: workspace.rootPath,
            relativePath: path,
            edit,
            author,
            nowMs,
            ...(operationId ? { operationId } : {}),
            ...(editSignal ? { signal: editSignal } : {}),
          }),
        writeAvailable: async () => {
          try {
            await openWorkspaceActivityForOperation(
              operation,
              {},
              ensureWorkspaceActivityOpen,
            );
            operation.assertCurrent();
            return Boolean(activity.engineCaptureFor(input.workspaceId));
          } catch {
            return false;
          }
        },
        signal,
        invokeChildProcess: input.invokeChildProcess,
        subscribeFileWatch: input.subscribeFileWatch,
        // The one main-side collection write seam. Authority mirrors
        // writeAuthoredText: a writable workspace and a running engine
        // capture, resolved when the write happens, never cached.
        editCollections: {
          // The idempotency key is the automation run's claim-id-plus-ordinal:
          // it must reach the seam, or a reaper re-run could write twice.
          setRecordFields: async ({
            recordPath,
            fields,
            author,
            idempotencyKey,
            signal: editSignal,
          }) =>
            setCollectionRecordFields(
              await collectionEditContextFor(operation, editSignal),
              {
                recordPath,
                fields,
                author,
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
              },
            ),
          createRecord: async ({
            collectionPath,
            name,
            fields,
            author,
            idempotencyKey,
            signal: editSignal,
          }) =>
            createCollectionRecord(
              await collectionEditContextFor(operation, editSignal),
              {
                collectionPath,
                name,
                ...(fields === undefined ? {} : { fields }),
                author,
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
              },
            ),
        },
        subscribeRecordWatch: input.subscribeRecordWatch,
        unsubscribeWorkspaceEvents: input.unsubscribeWorkspaceEvents,
        writeAuthoredText: createPluginAuthoredTextWriter({
          signal,
          requireWritableCapture: async () => {
            const { workspace: workspaceForWrite, capture } =
              await requirePluginEngineCaptureForOperation(operation);
            assertWritableWorkspace(workspaceForWrite);
            return { workspaceRoot: workspaceForWrite.rootPath, capture };
          },
          pipeline: () =>
            operation.state.pluginRuntimes.current(input.workspaceId)?.pipeline,
        }),
      },
      input.method,
      input.params,
    );
  });
}

async function routePluginPanelSdk(input: {
  authorization: PluginPanelSdkAuthorization;
  method: string;
  params?: unknown;
}): Promise<unknown> {
  const { authority, surfaceId, isPushLive } = input.authorization;
  return workspaceAuthorities.withAuthority(authority.workspaceId, async () => {
    const workspaceEvents = pluginWorkspaceRuntimes.current(
      authority.workspaceId,
    )?.workspaceEvents;
    const owner = {
      kind: "panel" as const,
      workspaceId: authority.workspaceId,
      pluginId: authority.pluginId,
      panelId: authority.panelId,
      surfaceId,
    };
    const emitEvent = workspaceEvents
      ? createPluginPanelSdkEventEmitter({
          workspaceId: authority.workspaceId,
          pluginId: authority.pluginId,
          panelId: authority.panelId,
          isPanelRunning: isPushLive,
          send: notifyPluginPanelSdkEvent,
        })
      : undefined;
    return invokeWorkspacePluginSdk({
      workspaceId: authority.workspaceId,
      pluginId: authority.pluginId,
      spawnId: authority.spawnId,
      requestPath: "panel",
      isWritable: () => !sharedViewOf(authority.workspaceId),
      signal: authority.signal,
      subscribeFileWatch:
        workspaceEvents && emitEvent
          ? (watchParams) =>
              workspaceEvents.subscribe({ owner, emitEvent }, watchParams)
          : undefined,
      subscribeRecordWatch:
        workspaceEvents && emitEvent
          ? (watchParams, readable) =>
              workspaceEvents.subscribeRecords(
                { owner, emitEvent },
                watchParams,
                readable,
              )
          : undefined,
      unsubscribeWorkspaceEvents: workspaceEvents
        ? (watchParams) => workspaceEvents.unsubscribe({ owner }, watchParams)
        : undefined,
      method: input.method,
      params: input.params,
    });
  });
}

// A plugin this workspace can serve panels for. The pipeline's current
// discovery owns the manifest. The registration map is only a fallback for a
// plugin the pipeline does not currently expose. Approval is unaffected:
// ensurePluginStarted still hash-verifies before it executes anything, and
// panels still serve from the approved snapshot rather than from pluginRoot.
function registeredPlugin(
  workspaceId: string,
  pluginId: string,
): RegisteredPlugin | undefined {
  return pluginWorkspaceRuntimes.current(workspaceId)
    ?.registeredPlugin(pluginId);
}

// Panels serve from the approved, hash-verified snapshot — never from
// plugin.pluginRoot (live, unverified workspace-folder source) — matching
// ensurePluginStarted's own hash-verify-before-execute gate: a panel is
// code from this plugin as much as its process is, and the userData-
// residency rule applies the same way.
function pluginSnapshotRoot(workspace: CreatedWorkspace, pluginId: string): string {
  return join(
    pluginDataDir(stateDir(), workspace.rootPath),
    "plugins",
    pluginIdToSafePath(pluginId),
    "snapshot",
  );
}

async function startPluginPanelPreview(input: {
  workspace: CreatedWorkspace;
  pluginId: string;
  panel: { entry: string };
}) {
  const snapshotRoot = pluginSnapshotRoot(input.workspace, input.pluginId);
  const entryPath = join(snapshotRoot, input.panel.entry);
  const handle = await startStaticDirectoryPreview(dirname(entryPath), {
    containmentRoot: snapshotRoot,
    entry: basename(entryPath),
    entryLabel: "plugin panel entry",
  });
  return { url: handle.url, stop: () => handle.stop() };
}

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

// Agent-facing `dohc chat`: the socket authenticates locally, then MAIN
// resolves the registry workspace and derives identity exactly like renderer
// chat sends. The client can claim only the behavior-bearing human/agent kind;
// it never supplies the user id or display identity.
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
    throw new Error(captureRefusal("Chats"));
  }
  const store = linkedChatStoreFor(workspace);
  const daemon = rustEngineDaemon;
  if (!daemon) throw new Error("The workspace engine is not running.");
  // The CLI's collection writes ride the same seam plugin SDK edits take,
  // resolved per write under the physical workspace's authority, so a
  // retired-and-reattached workspace refuses instead of falling through to
  // its successor.
  const cliCollectionEdit = <T>(
    work: (context: CollectionRecordEditContext) => Promise<T>,
  ): Promise<T> =>
    withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) =>
      await work(await collectionEditContextFor(operation)),
    );
  return {
    workspaceId: workspace.workspaceId,
    rootPath: workspace.rootPath,
    store,
    dispatchStore: agentDispatchStoreHandleFor(workspace).store,
    readOnly: Boolean(sharedViewOf(workspace.workspaceId)),
    fileObjectIdForPath: (path) => capture.fileObjectIdForPath(path),
    daemonReads: {
      async queryChatMessagesGranular(input: { query: string; limit: number }) {
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
    // Engine-backed collection reads and writes for the CLI/MCP verbs.
    // withEngineAdapter derives the attachment (and share-view session mode)
    // from the registered workspace itself — the renderer collection routes'
    // authority, reached from main's side. The plugin SDK's owned read port
    // wraps the same call in receivedShareEngine.workspaceForRegistered; the
    // CLI resolved this workspace by cwd above, so it already holds the
    // registered entry that wrapper would look up. Writes go through the
    // desktop's one collection write seam, the same path plugin SDK edits
    // take.
    collections: {
      writes: {
        setFields: (input) =>
          cliCollectionEdit((context) => setCollectionRecordFields(context, input)),
        createRecord: (input) =>
          cliCollectionEdit((context) => createCollectionRecord(context, input)),
      },
      query: async (params) => {
        const result = await withEngineAdapter(
          workspace,
          async (adapter) => await adapter.queryCollectionRecords(params),
        );
        if (!result) throw new Error("The workspace engine is not running.");
        return result;
      },
      getRecord: async (params) => {
        const result = await withEngineAdapter(
          workspace,
          async (adapter) =>
            await adapter.getCollectionRecord({
              collectionPath: params.collectionPath,
              recordId: params.recordId,
              historyLimit: params.historyLimit,
              ...(params.beforeHistoryId !== undefined
                ? { beforeHistoryId: params.beforeHistoryId }
                : {}),
            }),
        );
        if (!result) throw new Error("The workspace engine is not running.");
        return result;
      },
    },
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
      const identity = await chatRelayIdentityFor(
        workspace.workspaceId,
        target,
        store,
      );
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
  await Promise.allSettled(
    listWorkspaces().map((workspace) =>
      workspaceAuthorities.withAuthority(workspace.workspaceId, (lease) =>
        lease.state.workspaceChatLifecycle.boot([
          canonicalWorkspaceFor(lease),
        ]),
      ),
    ),
  );
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
          ? (
              await chatRelayIdentityFor(
                workspaceId,
                target,
                linkedChatStoreFor(workspace),
              )
            ).authorUserId
          : resolveWorkspaceRelayAuthorId(workspace, cachedCredentials)
        : undefined;
      return {
        displayName: localUserDisplayName(),
        ...(authorUserId ? { authorUserId } : {}),
        reactionAuthorId: localReactorFallbackId(),
      };
    },
    onWrite: (workspace, target) => {
      notifyRenderer({ workspaceId: workspace.workspaceId });
      // A CLI or MCP reply can mark a live bookmark projection pending.
      queueChatBookmarkProjection(workspace.workspaceId);
      activity.queueCloudSync(workspace.workspaceId);
      void syncSharedChannelsForChatTarget(workspace.workspaceId, target).catch((error) => {
        console.error("[desktop] shared channel sync:", error);
      });
      void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
        console.error("[desktop] CLI dispatch scan:", error);
      });
    },
    // No renderer poll runs the sync pass on the CLI's or MCP's behalf:
    // Await (bounded — see cliServer.ts's CHAT_READ_SYNC_BUDGET_MS) the same
    // pass syncDms already names a target for, so the read's own channel is
    // covered past the pass's row bound. Never throws — offline, it returns
    // fast and the local rows answer.
    onRead: async (workspace, target) => {
      await syncSharedChannelsForChatTarget(workspace.workspaceId, target);
    },
    onRunMessageLinkPending: (link) => {
      rememberPendingCliRunMessageLink(link, true);
    },
    onRunMessageLinkSettled: (link) => {
      rememberPendingCliRunMessageLink(link, false);
      void chatDispatchService.scanWorkspace(link.workspaceId).catch((error) => {
        console.error("[desktop] CLI provenance recovery scan:", error);
      });
    },
    onRunMessageLinkAbandoned: (link) => {
      rememberPendingCliRunMessageLink(link, false);
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

async function prepareForRendererReload(
  sender: WebContents,
  rendererDocumentId: string,
): Promise<boolean> {
  // `openWorkspace` records the active workspace before awaiting watcher
  // startup. Re-prioritize that sender's workspace so its replacement renderer
  // boots back into the same place, while closing every main-owned resource
  // the crashed renderer cannot clean up itself.
  const activeWorkspaceId =
    rendererWorkspaceSessions.current(sender)?.workspaceId ??
    preferredWorkspaceId;
  // retireForReload invalidates the lease before returning its promise. The
  // outgoing document cannot admit fresh work while these owners drain.
  const accepted = await rendererWorkspaceSessions.retireForReload(
    sender,
    rendererDocumentId,
  );
  if (accepted && activeWorkspaceId) preferredWorkspaceId = activeWorkspaceId;
  return accepted;
}

async function prepareAfterRendererCrash(sender: WebContents): Promise<void> {
  const activeWorkspaceId =
    rendererWorkspaceSessions.current(sender)?.workspaceId ??
    preferredWorkspaceId;
  if (activeWorkspaceId) preferredWorkspaceId = activeWorkspaceId;
  await rendererWorkspaceSessions.retireAfterCrash(sender);
}

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
    nativeTheme.shouldUseDarkColors,
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

async function showOrCreateMainWindow(): Promise<BrowserWindow> {
  const existing = targetWindow(undefined);
  if (existing) {
    focusShareHandoffWindow(existing);
    return existing;
  }
  const window = trackWorkspaceWindow(
    createMainWindow({ beforeRendererReload: prepareAfterRendererCrash }),
  );
  focusShareHandoffWindowWhenReady(window);
  return window;
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
  if (enabled && !appLifecycle.isQuitting()) {
    ensureDispatchTray();
  } else if (dispatchTray) {
    dispatchTray.destroy();
    dispatchTray = null;
  }
  return enabled;
}

let rustEngineDaemon: EngineDaemonLifecycle | null = null;
let rustEngineWorkspaceSessions: EngineWorkspaceSessions | null = null;
let rustEngineRelayClient: EngineRelayClient | null = null;
// Settles with the daemon handshake (false = startup failed and the app is
// quitting). The whenReady continuation creates the window while the daemon
// starts, so a fast renderer can ask for the engine before the handshake
// settles; boot-time paths that need engine sessions await this first instead
// of throwing the broken-invariant error at it.
let engineDaemonStartup: Promise<boolean> = Promise.resolve(false);
const relayTransportRoutes = new RelayTransportRouteGuard();

// Narrowing for the engine-access gates. The invariant is real:
// every boot-time path that can reach the engine awaits engineDaemonStartup
// first (openWorkspaceActivityWith, cloudStatus, the share-view file and
// mount lanes), and startRustEngineDaemon
// quits the app when the handshake fails; this handle is nulled only on that
// failure path. A later startup-smoke failure restarts the daemon without
// nulling it. A throw here would mean that invariant broke, which must be
// loud, not a silent drop to the legacy engine.
function requireEngineSessions(): EngineWorkspaceSessions {
  if (!rustEngineWorkspaceSessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  return rustEngineWorkspaceSessions;
}

const receivedShareEngine = createReceivedShareEngineAccess({
  sessions: requireEngineSessions,
  createStores: createCaptureLiveStores,
  relayClient: () => {
    if (!rustEngineRelayClient) {
      throw new Error("Rust engine relay client is unavailable.");
    }
    return rustEngineRelayClient;
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
  engineReady: () => engineDaemonStartup,
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
          throw new Error("Sign in to dohc Cloud first.");
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

async function shareViewFilesTargetForPath(
  workspace: { workspaceId: string },
  relativePath: string,
): Promise<{ target: ShareViewFilesTarget; path: string } | null> {
  return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
    createOwnedWorkspaceFileReader({
      workspace: operation.workspace,
      files: shareViewFiles,
    }).resolveShare(relativePath),
  );
}

// Share-backed reads answer from the engine share store, and a restored
// share tab's first read can precede the daemon handshake (the window loads
// during it). Ungated, that read errors once and nothing retries it: a
// current share reports zero changed paths, so no refresh-key bump ever
// re-reads the tab. Only the share branch calls `read`, so local disk reads
// stay concurrent with the handshake.
const gatedShareViewFileReads: Pick<ShareViewFiles, "read"> = {
  read: async (target, request) => {
    await engineDaemonStartup;
    return shareViewFiles.read(target, request);
  },
};

async function readOwnedWorkspaceText(
  workspace: { workspaceId: string },
  relativePath: string,
) {
  return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
    readOwnedWorkspaceTextFor(operation.workspace, relativePath),
  );
}

function readOwnedWorkspaceTextFor(
  workspace: RegistryEntry & { readonly attachmentId: symbol },
  relativePath: string,
) {
  return createOwnedWorkspaceFileReader({
    workspace,
    files: gatedShareViewFileReads,
  }).readText(relativePath);
}

async function readOwnedWorkspaceAsset(
  workspace: { workspaceId: string },
  relativePath: string,
) {
  return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
    readOwnedWorkspaceAssetFor(operation.workspace, relativePath),
  );
}

function readOwnedWorkspaceAssetFor(
  workspace: RegistryEntry & { readonly attachmentId: symbol },
  relativePath: string,
) {
  return createOwnedWorkspaceFileReader({
    workspace,
    files: gatedShareViewFileReads,
  }).readAsset(relativePath);
}

async function listOwnedWorkspaceFilesFor(
  workspace: RegistryEntry & { readonly attachmentId: symbol },
) {
  if (shareViewIsPresent(workspace.shareView)) {
    // The shell lists at mount, which can precede the daemon handshake now
    // that the window loads during it; the share store needs sessions. A
    // plain workspace's disk listing below stays ungated on purpose.
    await engineDaemonStartup;
    return shareViewFiles.list(
      {
        kind: "standalone",
        workspaceId: workspace.workspaceId,
      },
      { includeContentIdentity: true },
    );
  }
  const mounts = storedShareMounts(workspace);
  const disk = await listFiles(workspace.rootPath, {
    includeContentIdentity: true,
  });
  if (!shareMountRegistryIsPresent(workspace)) return disk;
  await engineDaemonStartup;
  return overlayCanonicalShareMountFiles({
    disk,
    mounts,
    listCanonical: (mount) =>
      shareViewFiles.list(
        {
          kind: "mount",
          workspaceId: workspace.workspaceId,
          shareId: mount.shareId,
        },
        { includeContentIdentity: true },
      ),
    onFailure: (mount, error) => {
      const identity = isRecordValue(mount)
        ? `"${String(mount.label)}" (${String(mount.shareId)})`
        : "from an unreadable registry record";
      console.error(
        `[desktop] could not list mounted share ${identity}`,
        error,
      );
    },
  });
}

function workerDatabaseReader(
  signal?: AbortSignal,
): OwnedWorkspaceDatabaseReader {
  return {
    readPrepared: (path, source) =>
      source.withVerifiedPath((absolutePath) =>
        workspaceDatabaseWorker.readPath({ absolutePath, path, signal }),
      ),
    readBytes: (path, bytes) =>
      workspaceDatabaseWorker.readBytes({ bytes, path, signal }),
    readPagePrepared: (path, source, table, offset) =>
      source.withVerifiedPath((absolutePath) =>
        workspaceDatabaseWorker.readPagePath({
          absolutePath,
          path,
          table,
          offset,
          signal,
        }),
      ),
    readPageBytes: (path, bytes, table, offset) =>
      workspaceDatabaseWorker.readPageBytes({
        bytes,
        path,
        table,
        offset,
        signal,
      }),
  };
}

async function editWorkspaceDatabaseInWorker(input: {
  rootPath: string;
  relativePath: string;
  edit: DatabaseEdit;
  author: ChangeAuthor;
  nowMs: number;
  operationId?: string;
  signal?: AbortSignal;
}) {
  const resolved = await resolveWorkspaceFile(
    input.rootPath,
    input.relativePath,
  );
  if (input.signal?.aborted) throw new Error("Database edit was cancelled.");
  const source = await prepareWorkspaceFileRead(
    input.rootPath,
    resolved.resolvedPath,
  );
  const logPath = join(
    input.rootPath,
    databaseOpLogPath(resolved.normalized),
  );
  return source.withVerifiedPath((absolutePath) =>
    workspaceDatabaseWorker.editPath({
      absolutePath,
      path: resolved.normalized,
      logPath,
      statePath: join(dirname(logPath), "state.sqlite"),
      edit: input.edit,
      operation: {
        operationId: input.operationId ?? randomUUID(),
        databasePath: resolved.normalized,
        table: input.edit.table,
        op: input.edit.op,
        rowId: String(input.edit.rowId),
        payload: input.edit.payload ?? {},
        appliedAt: input.nowMs,
        author: input.author,
      },
      signal: input.signal,
    }),
  );
}

function ownedWorkspaceReadsFor(
  workspace: RegistryEntry & { readonly attachmentId: symbol },
  databaseReader?: OwnedWorkspaceDatabaseReader,
) {
  // The same engine boundary the renderer's collections.* IPC uses: a
  // received share reads its share engine, everything else the local one.
  const collectionAdapter = async <T>(
    work: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> => {
    const result = await withEngineAdapter(
      receivedShareEngine.workspaceForRegistered(workspace),
      work,
    );
    if (result === null) throw new Error("The workspace engine is not running.");
    return result;
  };
  return createOwnedWorkspaceSdkReads({
    workspace,
    files: shareViewFiles,
    ...(databaseReader ? { databaseReader } : {}),
    listFiles: () => listOwnedWorkspaceFilesFor(workspace),
    collections: {
      // "No collections" is the honest empty answer without a capture;
      // the addressed reads below must name the missing capability instead.
      list: async () =>
        (await withEngineAdapter(
          receivedShareEngine.workspaceForRegistered(workspace),
          async (adapter) => await adapter.listCollections(),
        )) ?? { collections: [] },
      get: ({ collectionPath }) =>
        collectionAdapter(
          async (adapter) => await adapter.getCollection({ collectionPath }),
        ),
      query: (params) =>
        collectionAdapter(
          async (adapter) => await adapter.queryCollectionRecords(params),
        ),
      getRecord: ({ collectionPath, recordId, historyLimit, beforeHistoryId }) =>
        collectionAdapter(
          async (adapter) =>
            await adapter.getCollectionRecord({
              collectionPath,
              recordId,
              historyLimit,
              ...(beforeHistoryId === undefined ? {} : { beforeHistoryId }),
            }),
        ),
    },
    repairProjection: (target) =>
      ensureOwnedProjectionTargetCurrent({
        rootPath: workspace.rootPath,
        target,
      }),
    onSearchSourceFailure: (source, error) =>
      console.error(
        `[desktop] could not prepare ${source.prefix ?? "the shared view"} for an owned workspace read`,
        error,
      ),
  });
}

const workspaceSearchOwner = new WorkspaceSearchOwner<
  RegistryEntry & { readonly attachmentId: symbol }
>({
  searchRegistry: createSearchRegistry({ rgPath }),
  prepareOwnedSearch: async (workspace) =>
    await ownedWorkspaceReadsFor(workspace).prepareSearch(),
  engineCaptureFor: (workspaceId) => activity.engineCaptureFor(workspaceId),
  queryEngine: createWorkspaceSearchDaemonQuery(
    () => rustEngineWorkspaceSessions,
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

async function closeRelayTransportWorkspace(
  workspace: string | EngineWorkspace,
): Promise<void> {
  const workspaceId =
    typeof workspace === "string" ? workspace : workspace.workspaceId;
  if (rustEngineRelayClient) {
    await rustEngineRelayClient.closeWorkspace(workspace);
    return;
  }
  await rustEngineWorkspaceSessions?.closeWorkspace(workspace);
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

const appLifecycle = createAppLifecycle<BrowserWindow, WorkspaceSummary, DesktopUserSettingsResult>({
  app,
  runtime: process,
  handoff: {
    slot: shareHandoffIntentSlot,
    pendingCodeChanged: () => shareHandoffRedemption.pendingCodeChanged(),
  },
  windows: {
    create: () => trackWorkspaceWindow(
      createMainWindow({ beforeRendererReload: prepareAfterRendererCrash }),
    ),
    whenLoaded: (window) => new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", resolve);
    }),
    current: () => targetWindow(undefined),
    hasWorkspace: () => liveWorkspaceWindow() !== undefined,
    hasAny: () => BrowserWindow.getAllWindows().length !== 0,
    showOrCreate: showOrCreateMainWindow,
    activate: sendWorkspaceActivated,
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
    startEngine: () => {
      engineDaemonStartup = startRustEngineDaemon();
      return engineDaemonStartup;
    },
    loadSettings: () => readCachedUserSettingsFile(stateDir()),
    applySettings: ({ settings }) => {
      cachedPreferredName = settings.profile.preferredName;
      knownZoomLevel ??= settings.appearance.zoomLevel;
    },
    prepareCli: () => {
      if (!app.isPackaged || process.platform !== "linux" || !isAppImageBoot()) return;
      return refreshLinuxStableCliBin({
        resourcesCliBinDir: resolveDohcCliBinDirectory({
          appRoot: app.getAppPath(),
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
    reconcileCloud: () => { activity.reconcileCloud(engineForWorkspace); },
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
      rustEngineWorkspaceSessions?.beginShutdown();
      desktopChatBookmarks.stop();
    },
    stopSearch: () => workspaceSearchOwner.dispose(),
    stopPlugins: stopAllPluginWorkspaces,
    stopAgentSessions: () => cachedAgentSessions?.stopAll() ?? Promise.resolve(),
    settleYDocs: closeAllEngineYDocSessions,
    stopAgentIntegration: () => agentIntegration.stopAll(),
    closeWorkspaces: () => workspaceAuthorities.close(),
    disposeDatabase: () => workspaceDatabaseWorker.dispose(),
    closeRelay: closeAllRelayTransportWorkspaces,
    stopEngine: async () => { await rustEngineDaemon?.stop(); },
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
  sendWorkspaceActivated(window, workspace);
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

const sitePreviewSenderWorkspaceAuthority = {
  requireTrustedSender: senderWorkspaceAuthority.requireTrustedSender,
  withActiveWorkspace<Result>(
    sender: WebContents,
    workspaceId: string,
    subject: string,
    action: string,
    work: (input: {
      workspace: CreatedWorkspace;
      session: { isCurrent(): boolean };
    }) => Promise<Result>,
  ): Promise<Result> {
    return withRendererWorkspaceOperation(
      sender,
      workspaceId,
      `The ${subject} does not target the active workspace. Open the workspace and ${action}.`,
      (operation) =>
        work({
          workspace: operation.workspace,
          session: {
            isCurrent: operation.isCurrent,
          },
        }),
    );
  },
};

// Injectable clock/id seams (oracle/tests) for renderer-initiated database
// edits, whose nowMs becomes appliedAt (and createId the operationId) in the
// persisted JSONL operation log. Omitted ⇒ the real wall clock / randomUUID,
// identical to today's behavior.
// Quit-ask guard: shared by the before-quit interceptor and the IPC
// handlers the renderer answers through. The state machine lives in
// quitGuard.ts so the busy-renderer promise is a tested fact: a silent ACK
// window opens a MAIN-side dialog that names the loss — it never quits by
// itself.
const quitGuard = createQuitGuard({
  askRenderer: () => {
    // The WORKSPACE window, never an arbitrary live one: the PDF export's
    // hidden preload-less window would answer nothing and the user would get
    // the unresponsive dialog over drafts that were fully available (#579
    // review, r12).
    liveWorkspaceWindow()?.webContents.send(CHANNELS.quitRequested);
  },
  confirmForceQuit: async () => {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "dohc isn't responding.",
      detail:
        "Quitting now can lose unsaved recovery text. Wait, or quit anyway.",
      buttons: ["Wait", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  },
  quit: () => app.quit(),
  // The user chose "quit anyway" over a renderer that never answered. Destroy
  // the workspace windows first: a destroyed window runs no beforeunload, so
  // a renderer that wakes cannot veto the decision and open a second warning.
  // App.quit() still follows, so the will-quit teardown —
  // engine sessions, stores, WAL locks — runs exactly as for any other quit.
  forceQuit: () => {
    for (const window of workspaceWindows.allLive()) window.destroy();
    app.quit();
  },
});

// Recovery re-check at the quit boundary. The renderer's
// own check happens before it asks for the install, and a reopen can set an
// edit aside in the gap between the two — separate processes, and a queued
// render lands inside it. So main asks again here, and only then approves the
// quit that quitAndInstall starts.
//
// A renderer that misses the ACK window may be busy, not dead, and no
// deadline tells those apart. Silence therefore asks the
// USER rather than refusing the install the user just asked for — the same
// escalation the quit ask uses, with the loss named.
const recoveryChecker = createRecoveryChecker({
  send: (requestId) => {
    const window = liveWorkspaceWindow();
    if (!window) return false;
    window.webContents.send(CHANNELS.recoveryCheckRequested, requestId);
    return true;
  },
  confirmProceed: async () => {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "dohc isn't responding.",
      detail:
        "Installing now can lose unsaved recovery text. Wait, or install anyway.",
      buttons: ["Wait", "Install anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  },
});

function registerIpcHandlers(
  deps: { now?: () => number; createId?: () => string } = {},
): void {
  const now = deps.now ?? (() => Date.now());
  ipcMain.handle(CHANNELS.reloadRenderer, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReloadRendererRequestPayload.parse(payload);
    const sender = event.sender;
    const accepted = await prepareForRendererReload(
      sender,
      input.rendererDocumentId,
    );
    if (accepted && !sender.isDestroyed()) sender.reload();
  });

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
    registerPhysicalWorkspace,
    refreshNativeWorkspaceSurfaces,
    desktopMarks,
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
    withEngineAdapter, requireEngineCapture, localUserDisplayName, notifyRenderer,
    requireWorkspace, assertWritableWorkspace, syncStatusWithOwnedProjection, activity,
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

  // The only path from renderer to the OS browser (window.open is a pure
  // deny): http(s) URLs only, used by cloud login's verification step.
  ipcMain.handle(CHANNELS.openExternalUrl, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenExternalUrlPayload.parse(payload);
    if (!isSafeExternalUrl(input.url)) {
      throw new Error(`Refusing to open non-http(s) URL externally`);
    }
    await shell.openExternal(input.url);
  });

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
    reconcileCloud: () => activity.reconcileCloud(engineForWorkspace),
    notifyCloudSessionChanged, notifyCloudSessionChangedWithKey,
    notifyRenderer, findWorkspace, managedCloudConfiguration,
    engineDaemonStartup: () => engineDaemonStartup,
    requireEngineSessions, currentEngineSessions: () => rustEngineWorkspaceSessions,
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
    projectPendingChatBookmarksAfterPull,
    normalizeServerUrl,
    peekedReceivedGrantKinds,
    peekReceivedGrantKindForShare,
    acknowledgeWorkspaceShareSkips,
    notifyRenderer,
  });

  // Automation failures (ADR 0008): the engine's failed claim rows — one
  // row per automation with the newest error and a counting generation —
  // minus what the owner has acknowledged in the registry.
  ipcMain.handle(CHANNELS.listAutomationFailures, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListAutomationFailuresPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Automation notice read stopped because this window changed workspaces.",
      async (operation) => {
        const result = await withEngineAdapter(
          receivedShareEngine.workspaceForRegistered(operation.workspace),
          async (adapter) => await adapter.listAutomationFailures(),
        );
        return ListAutomationFailuresResult.parse({
          failures: unacknowledgedAutomationFailures(
            result?.failures ?? [],
            operation.workspace.automationFailureAcks,
          ),
        });
      },
    );
  });

  // Record that the user has seen an automation's failures. It does not
  // delete the claim rows — they are the remaining evidence of what failed.
  // Acknowledging hides the notice; a failure recorded after the render has
  // a higher generation, so it comes back on its own. The generation is
  // clamped to what the engine actually holds, so a claimed generation
  // above the current one cannot pre-acknowledge failures yet to happen.
  ipcMain.handle(CHANNELS.dismissAutomationFailure, async (event, payload) => {
    assertTrustedSender(event);
    const input = DismissAutomationFailurePayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Automation notice update stopped because this window changed workspaces.",
      async (operation) => {
        const result = await withEngineAdapter(
          receivedShareEngine.workspaceForRegistered(operation.workspace),
          async (adapter) => await adapter.listAutomationFailures(),
        );
        if (!result) {
          throw new Error("The workspace engine is not running.");
        }
        const current = result.failures.find(
          (failure) => failure.automationId === input.automationId,
        );
        // No failed claims for that automation: nothing to acknowledge.
        if (!current) return;
        operation.assertCurrent();
        acknowledgeWorkspaceAutomationFailure(
          input.workspaceId,
          input.automationId,
          Math.min(input.generation, current.generation),
        );
        notifyAutomationFailuresChanged(input.workspaceId);
      },
    );
  });

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
    engineDaemonStartup: () => engineDaemonStartup,
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

  registerWorkspaceDatabaseIpcHandlers<
    IpcMainInvokeEvent,
    DesktopWorkspaceOperation["workspace"]
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
    withWorkspaceOperation: (
      event,
      workspaceId,
      inactiveMessage,
      work,
    ) =>
      withRendererWorkspaceOperation(
        event.sender,
        workspaceId,
        inactiveMessage,
        work,
      ),
    assertWritableWorkspace,
    read: (operation, relativePath) =>
      createOwnedWorkspaceFileReader({
        workspace: operation.workspace,
        files: shareViewFiles,
        databaseReader: workerDatabaseReader(operation.signal),
      }).readDatabase(relativePath),
    readPage: (operation, input) =>
      createOwnedWorkspaceFileReader({
        workspace: operation.workspace,
        files: shareViewFiles,
        databaseReader: workerDatabaseReader(operation.signal),
      }).readDatabasePage(input.relativePath, input.table, input.offset),
    edit: (operation, input) =>
      editWorkspaceDatabaseInWorker({
        rootPath: operation.workspace.rootPath,
        relativePath: input.relativePath,
        edit: input.edit,
        author: { kind: "user", userId: "local" },
        nowMs: input.nowMs,
        operationId: input.operationId,
        signal: operation.signal,
      }),
    now,
    createId: deps.createId ?? randomUUID,
  });

  ipcMain.handle(CHANNELS.importToDatabase, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportToDatabasePayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Database import stopped because this window changed workspaces.",
      async (operation) => {
        assertWritableWorkspace(operation.workspace);
        return ImportToDatabaseResult.parse(
          await importOwnedWorkspaceDatabase({
            workspace: operation.workspace,
            files: shareViewFiles,
            sourcePath: input.sourceRelativePath,
            databasePath: input.databaseRelativePath,
            tableName: input.tableName,
          }),
        );
      },
    );
  });

  const siteIpcHandlers = createSitesIpcHandlers({
    authority: senderWorkspaceAuthority,
    catalog: ownedSiteCatalog,
  });
  ipcMain.handle(CHANNELS.listSites, siteIpcHandlers.listSites);
  ipcMain.handle(CHANNELS.getSitePackage, siteIpcHandlers.getSitePackage);

  const startSitePreview = createStartSitePreviewHandler({
    authority: sitePreviewSenderWorkspaceAuthority,
    catalog: ownedSiteCatalog,
    lifecycle: sitePreviews,
    isSharedView: (workspaceId) => !!sharedViewOf(workspaceId),
    execute: executePreviewForSite,
  });
  ipcMain.handle(CHANNELS.startSitePreview, startSitePreview);

  ipcMain.handle(CHANNELS.getSitePreviewLogs, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetSitePreviewLogsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "The app preview logs request does not target the active workspace. Open the workspace and try again.",
      (operation) =>
        GetSitePreviewLogsResult.parse(
          operation.state.sitePreviews.status(
            operation.workspace.workspaceId,
            input.siteRoot,
          ),
        ),
    );
  });

  ipcMain.handle(CHANNELS.stopSitePreview, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopSitePreviewPayload.parse(payload);
    await withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "The app preview stop request does not target the active workspace. Open the workspace and try again.",
      (operation) =>
        operation.state.sitePreviews.stop({
          getActiveWorkspaceId: () => {
            try {
              operation.assertCurrent();
              return operation.workspace.workspaceId;
            } catch {
              return undefined;
            }
          },
          workspaceId: operation.workspace.workspaceId,
          siteRoot: input.siteRoot,
        }),
    );
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
      builtinPluginsRoot,
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
      preferredWorkspaceId = workspaceId;
    },
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
    openWorkspaceActivity, receivedShareEngine, syncSharedChannelsForChatTarget, activity,
    activeEngineFileIndex, readOwnedWorkspaceText,
  });

  registerWorkspaceVersionsIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, requireEngineCapture, requireWorkspace, notifyRenderer,
    activity, tryInVersionSessions, desktopMarks,
  });

  workspaceEngineIpc.registerHistory();

  registerChatsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, chatScope, requireEngineCapture, linkedChatStoreFor, findWorkspace,
    assertWritableWorkspace, warmCredentialCache, localUserId, localUserDisplayName,
    localReactorFallbackId, currentCredentials: () => cachedCredentials,
    verifiedChatAuthorUserIdFor, revalidateChatWrite, chatRelayIdentityFor,
    syncWorkspaceSharedChannels, syncSharedChannelsForChatTarget,
    syncRendererWorkspaceSharedChannels, withRendererWorkspaceOperation, activeEngineFileIndex,
    activity, chatDispatchService, desktopChatBookmarks, notifyRenderer,
  });

  ipcMain.handle(CHANNELS.chatRunRecordsForThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = ChatRunRecordsForThreadPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
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

  // Enabling agents starts a local run: the workspace must already be open (the
  // watcher must be live for the run slot to attach), so open it first.
  ipcMain.handle(CHANNELS.startAgentRun, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    assertAgentRunnableWorkspace(workspace.workspaceId);
    assertChatRunnerIdle(workspace.workspaceId);
    return StartAgentRunResult.parse(
      await startAgentRunWithWorkspaceActivity(workspace),
    );
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
    // A shared view hands out the MCP profile for its level, so the user's AI
    // tool is offered only the write tools the grant allows.
    const shareAccess = mcpShareAccessOf(workspace.shareView);
    return McpConfigResult.parse(mcpConfigFor(workspace.rootPath, shareAccess));
  });

  ipcMain.handle(CHANNELS.probeAgentDrivers, async (event, payload) => {
    assertTrustedSender(event);
    const input = AgentRunPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Every driver is plugin-contributed, and workspace open only warms the
    // plugin runtime in the background. A probe that ran ahead of it would
    // answer "no drivers" and the caller would cache that for its lifetime.
    if (!sharedViewOf(workspace.workspaceId)) {
      await pluginWorkspaceRuntimes.ensure(workspace);
    }
    const sessions = await agentSessionManager();
    await sessions.probeDrivers(input.workspaceId);
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
    await senderWorkspaceAuthority.withActiveWorkspace(
      event.sender,
      input.workspaceId,
      "Agent run stop",
      async () => {
        await chatDispatchService.stopAgentRun(input.workspaceId, input.runId);
      },
    );
  });

  ipcMain.handle(CHANNELS.chatDispatchStateForThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = ChatDispatchStateForThreadPayload.parse(payload);
    await requireEngineCapture(
      input.workspaceId,
      "Chats",
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
      "Chats",
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

  const settingsIpc = createSettingsIpc<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender, stateDir, enqueueUserSettingsWrite,
    setCachedPreferredName: (preferredName) => { cachedPreferredName = preferredName; },
    applyZoomLevelToWindows, refreshDispatchTray, openDispatchWorkspaces,
    chatDispatchService, withRendererWorkspaceOperation,
  });
  settingsIpc.registerSettingsIpcHandlers();

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
    // Persist so the next launch paints the native chrome in this theme
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

  // The palette and the Settings stepper share the menu accelerators' zoom
  // mutation; the answer is the settings now on disk, so the caller paints
  // the level actually in effect.
  ipcMain.handle(CHANNELS.stepWindowZoom, async (event, payload) => {
    assertTrustedSender(event);
    const input = StepWindowZoomPayload.parse(payload);
    return DesktopUserSettingsResult.parse(await stepWindowZoom(input.step));
  });

  settingsIpc.registerWorkspaceUiStateIpcHandlers();

  registerWorkspaceSearchIpcHandlers<
    IpcMainInvokeEvent,
    RegistryEntry & { readonly attachmentId: symbol }
  >({
    registerHandler: (channel, handler) => ipcMain.handle(channel, handler),
    assertTrustedSender,
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
  });

  workspaceEngineIpc.registerYDoc();

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
        state: currentUpdateState(),
      });
    }
    // Re-ask at the quit boundary: the renderer checked
    // before it called, and a reopen can set an edit aside in the gap. Only
    // once main has a fresh answer does it approve the quit that
    // quitAndInstall starts — the ask cannot veto it afterwards, because
    // that would burn the one-shot latch.
    if (await recoveryChecker.ask()) {
      return UpdateActionResult.parse({
        accepted: false,
        state: currentUpdateState(),
      });
    }
    quitGuard.approve();
    const result = UpdateActionResult.parse(
      await autoUpdateController.installUpdate(),
    );
    if (!result.accepted) quitGuard.revoke();
    return result;
  });

  ipcMain.handle(CHANNELS.recoveryCheckAnswer, (event, payload: unknown) => {
    assertTrustedSender(event);
    const answer = payload as { requestId?: unknown; blocked?: unknown };
    if (
      typeof answer?.requestId !== "number" ||
      typeof answer?.blocked !== "boolean"
    ) {
      return;
    }
    recoveryChecker.answer(answer.requestId, answer.blocked);
  });

  ipcMain.handle(CHANNELS.holdQuit, (event) => {
    assertTrustedSender(event);
    // The renderer's recovery dialog owns the decision now; the quit stays
    // cancelled until the user resumes it (or never).
    quitGuard.hold();
  });

  ipcMain.handle(CHANNELS.resumeQuit, (event) => {
    assertTrustedSender(event);
    quitGuard.resume();
  });

  ipcMain.on(CHANNELS.firstPaint, (event) => {
    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
      launchMarks.firstPaint();
      desktopMarks.markOnce("first-renderer-paint");
      logLaunchMarksOnce();
    }
  });

  // Double-gated: env flag and unpackaged build. A packaged app launched
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

  desktopChatBookmarks.start();
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
  const restartingPluginRuntimes = new Set<PluginWorkspaceRuntimes<CreatedWorkspace>>();
  // Everything, including resolving the binary path, runs inside the try: a
  // throw while building the options would otherwise reject this whenReady
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
        if (terminal) {
          for (const runtimes of restartingPluginRuntimes) {
            runtimes.failEngineRestart(error);
          }
        }
        // The supervisor's diagnostic is for us: it names engine.ping, probe
        // counts and wedge budgets, which tell a developer or an agent exactly
        // which limit was hit. It goes to the log in full.
        console.error("[desktop] Rust engine daemon:", error);
        if (terminal && !appLifecycle.isQuitting()) {
          // The dialog is for the user, so it says what broke and what to do
          // instead — no internal names, one instruction per sentence
          // (the dohc-interface skill). "The workspace engine" is the noun the
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
      beforePublish: async () => {
        await Promise.all(workspaceAuthorities.workspaceIds().map((workspaceId) =>
          workspaceAuthorities.withAuthority(workspaceId, (lease) => {
            const runtimes = lease.state.pluginRuntimes;
            restartingPluginRuntimes.add(runtimes);
            return runtimes.prepareForEngineRestart();
          }),
        ));
      },
      // A capture event can die with the previous daemon's transport after its
      // moment committed; the replacement never re-emits it (its baseline finds
      // disk and manifest agreeing). One repaint per healthy launch closes that
      // staleness window. Scope-free: the lost event could have belonged to
      // any open workspace.
      onLaunch: () => {
        for (const runtimes of restartingPluginRuntimes) {
          runtimes.resumeAfterEngineRestart();
        }
        restartingPluginRuntimes.clear();
        notifyRenderer();
      },
    });
    await rustEngineDaemon.start();
    // The daemon owns capture: its capture.momentRecorded events are the only
    // signal that a moment landed, so bridge them onto the renderer's
    // workspace-activity ping or the history timeline goes permanently stale.
    bridgeCaptureEventsToRenderer(rustEngineDaemon, notifyRenderer);
    // The daemon also records collection changes autonomously: its record
    // events are the only live signal behind a plugin's collections.watch
    // subscription, so route each one to the owning workspace's registry.
    bridgeRecordEventsToPlugins(rustEngineDaemon, (workspaceId) =>
      pluginWorkspaceRuntimes.current(workspaceId)?.workspaceEvents,
    );
    // The daemon also claims each local record change for its subscribed
    // automations (ADR 0008); its automation.claimed events wake the owning
    // workspace's executor to drain the durable claim table, and a claim
    // inserted already failed (the depth cap's chain-stopped stop report)
    // pokes the owner's failure notice instead.
    bridgeAutomationClaimsToExecutors(
      rustEngineDaemon,
      (workspaceId) => pluginWorkspaceRuntimes.current(workspaceId)?.automations,
      notifyAutomationFailuresChanged,
    );
    const relaySource = new RelayConfiguredDaemonClientSource(
      rustEngineDaemon,
      relayTransportRoutes,
    );
    // A fresh debug-engine adoption measured 18.7 s for 5,000 files and
    // 101.8 s for 15,000 files on the launch fixture; 120 s bounds that path
    // with headroom. The renderer names the wait.
    rustEngineWorkspaceSessions = new EngineWorkspaceSessions(relaySource, {
      workspaceOpenDeadlineMs: 120_000,
    });
    rustEngineRelayClient = new EngineRelayClient({
      sessions: rustEngineWorkspaceSessions,
      routes: relayTransportRoutes,
    });
    console.info(
      "[desktop] Rust engine daemon handshake complete; startup smoke running.",
    );
    // Marked here, where the handshake actually completes — the bootstrap
    // gate's await also covers the cached-settings read, which would inflate
    // this mark.
    launchMarks.daemonReady();
    desktopMarks.markOnce("daemon-ready");
    logLaunchMarksOnce();
    return true;
  } catch (error) {
    for (const runtimes of restartingPluginRuntimes) {
      runtimes.failEngineRestart(error);
    }
    const message =
      error instanceof Error ? error.message : "Unknown Rust engine startup error.";
    console.error("[desktop] Rust engine daemon failed to start:", error);
    dialog.showErrorBox(
      "Rust engine failed to start",
      `${message}\n\nThe desktop cannot start without the Rust engine.`,
    );
    // Contained: a stop() throw here would reject engineDaemonStartup itself,
    // skip the quit below, and rethrow from every gated await instead of
    // letting the quit land.
    await rustEngineDaemon?.stop().catch((stopError: unknown) => {
      console.error(
        "[desktop] Rust engine daemon stop after failed start:",
        stopError,
      );
    });
    rustEngineDaemon = null;
    rustEngineWorkspaceSessions = null;
    rustEngineRelayClient = null;
    // The window may already be up — it loads while the daemon handshakes —
    // and by the time the user dismisses the dialog above, a restored tab can
    // hold edits (local reads and the plain editor never wait for the
    // daemon). So this quit goes through the ordinary path: before-quit
    // intercepts while a workspace window is live, and the quit guard's ask
    // lets the renderer flush or warn about that work — a destroy() here
    // would discard it with no beforeunload and no ask.
    app.quit();
    return false;
  }
}

void appLifecycle.start();
