import {
  databaseOpLogPath,
  defaultWorkspaceRoot,
  isSharedWithMePath,
  normalizeAbsolutePath,
  preferredBuildOutput,
  validateUserReadPath,
  validateUserWritePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AttachWorkspaceFolderPayload,
  CreateLocalWorkspacePayload,
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
  CreateRelayShareLinkPayload,
  CreateRelayShareLinkResult,
  ListRelayShareLinksPayload,
  ListRelayShareLinksResult,
  RelayShareLinkCreateResponse,
  RelayShareLinkDependentConflict,
  RelayShareLinkEndResponse,
  RelayShareLinkListResponse,
  RelayShareLinkRotateResponse,
  RotateRelayShareLinkPayload,
  RotateRelayShareLinkResult,
  RevokeRelayShareLinkPayload,
  RevokeRelayShareLinkResult,
  ShareChatChannelPayload,
  ShareChatChannelResult,
  ListChatChannelSharesPayload,
  ListChatChannelSharesResult,
  ListJoinedSharedChannelsPayload,
  ListJoinedSharedChannelsResult,
  JoinSharedChannelPayload,
  JoinSharedChannelResult,
  LeaveSharedChannelPayload,
  OpenSharedViewPayload,
  OpenSharedViewResult,
  RefreshSharedViewPayload,
  DismissShareSkipsPayload,
  ListShareProposalsPayload,
  ListShareProposalsResult,
  ReadShareProposalChangesPayload,
  ReadShareProposalChangesResult,
  ReadShareProposalFileContentPayload,
  ReadShareProposalFileContentResult,
  SettleShareProposalPayload,
  SettleShareProposalResult,
  SubmitShareChangesPayload,
  resolveSubmitShareChangesResult,
  ListMyShareChangesPayload,
  ListMyShareChangesResult,
  WithdrawShareChangesPayload,
  WithdrawShareChangesResult,
  RefreshSharedViewResult,
  CloudJoinWorkspaceResult,
  CloudLoginPollResult,
  CloudLoginStartPayload,
  CloudLoginStartResult,
  CloudStatusPayload,
  CloudStatusResult,
  OpenExternalUrlPayload,
  DatabaseSnapshotResult,
  ImportToDatabasePayload,
  ImportToDatabaseResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  GetSitePreviewLogsPayload,
  GetSitePreviewLogsResult,
  StopSitePreviewPayload,
  PluginPanelSdkEvent,
  PluginStatusChangedEvent,
  DesktopMarksResult,
  LaunchMarksResult,
  PluginPanelInvalidatedEvent,
  PluginWebAppFailedEvent,
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  WorkspaceIdPayload,
  ListWorkspaceVersionsResult,
  CreateWorkspaceVersionPayload,
  SwitchWorkspaceVersionPayload,
  SwitchWorkspaceVersionResult,
  CompareWorkspaceVersionsPayload,
  CompareWorkspaceVersionsResult,
  MergeWorkspaceVersionPayload,
  MergeWorkspaceVersionResult,
  ListWorkspaceVersionConflictsPayload,
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
  GetChatThreadRevisionPayload,
  GetChatThreadRevisionResult,
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
  AcceptDmPayload,
  AcceptDmResult,
  DeclineDmPayload,
  RequestDmAgainPayload,
  SyncDmsPayload,
  SyncDmsResult,
  StartDmPayload,
  StartDmResult,
  LeaveDmPayload,
  PresencePublishRequestPayload,
  PresencePollPayload,
  PresenceCancelPayload,
  PresenceResult,
  type PresenceScopeInput,
  ChatThreadRecord,
  ChatMessageRecord,
  OpenFileExternallyPayload,
  OpenWorkspaceRequestPayload,
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
  MAX_PICKED_IMAGES,
  PickImageFilesPayload,
  PickImageFilesResult,
  WRITE_ASSET_MAX_BYTES,
  SetTitlebarThemePayload,
  StepWindowZoomPayload,
  SetUserSettingsPayload,
  SetWorkspaceSettingsPayload,
  SetWorkspaceUiStatePayload,
  WorkspaceSettingsPayload,
  WorkspaceSettingsResult,
  WriteClipboardTextPayload,
  GetWorkspaceUiStateResult,
  SyncStatusResult,
  RebuildEngineStorePayload,
  RebuildEngineStoreResult,
  WorkspaceRegistryResult,
  WorkspaceSummary,
  WorkspaceGraphResult,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
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
import { createWorkspaceFileMutationOwner } from "./workspaces/workspaceFileMutationOwner";
import { registerWorkspaceSearchIpcHandlers } from "./ipc/workspaceSearchIpc";
// The relay presence transport is a dependency-free module (no DOM/React): main
// reuses it so the presence wire contract (routes, publish/leave/poll) lives in
// ONE place. Main is the ONLY holder of the relay bearer token — the renderer's
// presence transport calls the presence IPC handlers below, never the relay.
import {
  createRelayPresenceTransport,
  type PresenceScope as RelayPresenceScope,
} from "./renderer/collab/presenceChannel";
import { createPresencePollRegistry } from "./collab/presencePollRegistry";
import { PresenceMutationOwner } from "./collab/presenceMutationOwner";
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
  shouldUseDarkSystemIcon,
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
  rebuildEngineStoreRequest,
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
import type { JoinedSharedChannel, RegistryEntry } from "./workspaces/registryStore";
import {
  readableShareLevel,
  shareViewGranterEmail,
  shareViewIsPresent,
} from "./workspaces/shareViewMarker";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaces/workspaceTextLimits";
import {
  shareViewTakesLocalWrites,
  workspaceWriteRefusal,
} from "./workspaces/shareWriteGate";
import {
  assertShareProposalGranter,
  requireShareViewMembership,
  requireShareViewProposalScope,
  sameShareViewProposalScope,
  shareProposalOpPath,
  type ShareViewProposalScope,
} from "./workspaces/shareProposals";
import { createShareProposalOperationScope } from "./workspaces/shareProposalOperationScope";
import { pathShareLanes } from "./workspaces/relayShareLanes";
import {
  workspaceSummariesFrom,
  workspaceSummaryFor,
} from "./workspaces/workspaceSummaryProjection";
import {
  assertSharedChannelWritable,
  createPassCoverageReporter,
  endJoinedChannel,
  joinedSharedChannelForTarget,
  relayFetchWithTimeout,
  SHARED_CHANNEL_SYNC_PASS_ROWS,
  scopeJoinedChannels,
  syncJoinedSharedChannels,
} from "./workspaces/sharedChannels";
import {
  assertSharedChannelMessageIdentity,
  assertSyncEnrollmentCredentials,
  joinedChannelMatchesCredentials,
  resolveChatRelayIdentity,
  resolveShareViewRelayAuthorId,
  resolveWorkspaceRelayAuthorId,
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
  resolveDmKinds,
  runningThread,
  shareIdsToWithholdFromOrdinaryInvites,
  type DmPeekResult,
  type DmRecordInfo,
  type ShareLogPage,
} from "./workspaces/dmChats";
import { createCloudCredentialStore } from "./workspaces/cloudCredentialStore";
import {
  clearDeclinedDm,
  declineDm,
  readDeclinedDms,
} from "./workspaces/dmRequestStore";
import {
  classifyDmRequests,
  classifyDmRequestsWithFallback,
  createLastKnownDmRequestLanesCache,
  isShareAcceptedInWorkspace,
  liveSharedChannelHoldersByShareId,
  liveSharedChannelHoldersByWireId,
  markLeftInLastKnownLanes,
  otherLiveSharedChannelHolder,
  otherLiveSharedChannelHolderByWireId,
  reserveAndPullSharedChannel,
  withholdDmsInRequestLanes,
} from "./workspaces/dmRequests";
import { readOrCreateLocalReactorId } from "./workspaces/localReactorId";
import {
  adoptCompletedCloudLoginSession,
  createCloudLogin,
  runCloudLogoutTransition,
  type CloudLogin,
} from "./workspaces/cloudLogin";
import { CredentialSessionCache } from "./workspaces/credentialSessionCache";
import { createRelaySyncEngine } from "./workspaces/relaySyncEngine";
import {
  awaitCredentialGeneration,
  chatViewerAuthorId,
  createChatChannelIpcHandler,
  createListJoinedSharedChannelsIpcHandler,
  createMarkChatThreadReadIpcHandler,
  chatShareSessionKey,
  createSetChatReactionIpcHandler,
  handleRelayUnauthorized,
  reactionsForViewer,
  readRelayChatShareLanes,
  RelaySessionError,
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
  assertShareChangesJournalable,
  SharePinInvalidError,
  recordedShareSelector,
  shareViewIdentitySelector,
} from "./workspaces/shareViewRecords";
import { assertShareChatWritable } from "./workspaces/shareChatGate";
import {
  assertMountableSelector,
  assertRealMountRoot,
  mountStoreWorkspaceIdFor,
  overlayCanonicalShareMountFiles,
  refuseImportIntoShareProjection,
  resolveShareMountPath,
  shareViewFilesMountProjection,
  shareMountRecordsForId,
  usableShareMountRecord,
} from "./workspaces/shareMounts";
import { createShareMountCommands } from "./workspaces/shareMountCommands";
import {
  collectOwnedWorkspaceZipEntries,
} from "./workspaces/ownedWorkspaceZip";
import { prepareOwnedStaticSitePreview } from "./workspaces/ownedStaticSiteFileSource";
import { createShareSkipRecorder } from "./workspaces/shareSkipRecorder";
import {
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  SharedFileReadOnlyError,
  type RelayWorkspaceBootstrapResult,
  type ShareProposal,
  type ShareProposalOp,
  type ShareViewRefusal,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import {
  isShareAccessValue,
  type ShareAccess,
} from "@dohc/security-contract/share-selector";
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
import type { ShareViewSelector } from "./workspaces/shareViewInfo";
import { fetchSharedChannelInfo } from "./workspaces/sharedChannelInfo";
import { installWorkspaceDataKey } from "./workspaces/workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaces/workspaceKeyEnvelopeEnrollment";
import { bootstrapJoinedWorkspace } from "./workspaces/workspaceJoinEnrollment";
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
import {
  broadcastWorkspaceActivity,
  workspaceActivityPayload,
  type WorkspaceActivityScope,
} from "./ipc/workspaceActivityBroadcast";
import { WorkspaceFileListingCache } from "./workspaces/workspaceFileListingCache";
import {
  EngineRelayClient,
  probeWorkspaceRelay,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
  type EngineRelayWorkspaceClient,
} from "./workspaces/engineRelayClient";
// #646 PR3a. The proposal routes that do not go through the engine: reviewing,
// settling, listing and withdrawing read and write ONLY relay state.
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
  captureForFlaggedWorkspace,
  createDispatchRunRelease,
  dispatchScanEligible,
  type EngineFeature,
  engineOffRefusal,
  releaseAndRefuseWithoutCapture,
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
import {
  assertActiveWorkspaceForSite,
  createSitePreviewLifecycle,
} from "./workspaces/sitePreviewLifecycle";
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
import { invokePluginSdkHost } from "./plugins/pluginSdkHost";
import { createOwnedWorkspaceSdkReads } from "./workspaces/ownedWorkspaceSdkReads";
import { createPluginUtilityTransport } from "./plugins/pluginUtilityTransport";
import { PluginChildProcessBroker } from "./plugins/pluginChildProcessBroker";
import { PluginWorkspaceEvents } from "./plugins/pluginWorkspaceEvents";
import { createPluginPanelFileWatchEmitter } from "./plugins/pluginPanelSdkEvent";
import { PluginSurfaceHostLifecycle } from "./plugins/pluginSurfaceHostLifecycle";
import { createPluginAgentDrivers } from "./plugins/pluginAgentDrivers";
import { BUILT_IN_AGENT_DRIVER_IDS } from "./agents/AgentDriver";
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
import type { DohcPluginManifest } from "./plugins/pluginManifestSchema";
import {
  mediaTypeForExtension,
  prepareWorkspaceFileRead,
  readWorkspaceText,
  resolveWorkspaceFile,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaces/workspaceAssets";
import {
  createShareViewFiles,
  ShareViewFilesState,
  type ShareViewFileChangeOutcome,
  type ShareViewFiles,
  type ShareViewFilesTarget,
} from "./workspaces/shareViewFiles";
import {
  resolveRegisteredShareViewFilesTarget,
  shareMountRegistryIsPresent,
  storedShareMounts,
  workspaceHasReceivedShareState,
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
import {
  extractWorkspaceHeadings,
  findWorkspaceHeading,
  workspaceHeadingRecords,
} from "./workspaces/workspaceHeadings";
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
  copyIntoWorkspace,
  importDroppedPaths,
  listFiles,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  ZIP_TOO_LARGE_REFUSAL,
} from "./workspaces/workspaceFiles";
import { explorerMenuEntries } from "./workspaces/explorerMenu";
import { buildStoreZip, type ZipEntry } from "./workspaces/zipWriter";
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

// PR 18 read-only shared views: a shared view is a read-only local workspace.
// `sharedViewOf` is the ONE authoritative predicate; every mutation surface
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
  // files writable here (#646). Only an ABSENT field is an ordinary
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

// Agents may READ a shared view (the copyable MCP config serves a read-only
// profile), but a MANAGED agent run writes into the workspace, so it is
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
// install (#777's e2e caught this). import.meta.dirname is the currently
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
  // registry the agent session manager builds, so a plugin driver is chosen,
  // probed, and stopped exactly like one dohc ships.
  let pluginHostRef: PluginHost | null = null;
  const pluginDrivers = createPluginAgentDrivers({
    host: {
      requestDriver: (pluginId, spawnId, method, params) => {
        if (!pluginHostRef) {
          throw new Error(`Plugin "${pluginId}" is not running.`);
        }
        return pluginHostRef.requestDriver(pluginId, spawnId, method, params);
      },
    },
    reservedDriverIds: BUILT_IN_AGENT_DRIVER_IDS,
  });
  // This workspace's plugin file subscriptions, fed by the settled watcher
  // batch (see onWatcherBatch) — the same feed the pipeline reads.
  const workspaceEvents = new PluginWorkspaceEvents();
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
    // Shares invokeWorkspacePluginSdk with #777's panel SDK route
    // (invokePluginPanelSdk below) so both paths get the same isWritable /
    // writeAvailable / MomentAuthor handling instead of a second copy. Only
    // this, the plugin's own request path (not the panel path), supplies
    // invokeChildProcess — a panel is renderer-driven UI, not the plugin's
    // own activated code, so it never brokers child processes.
    routeSdkRequest: (pluginId, method, params, spawnId, signal, emitEvent) =>
      runWithAuthority(() =>
        invokeWorkspacePluginSdk({
          workspaceId: workspace.workspaceId,
          pluginId,
          spawnId,
          requestPath: "plugin-process",
          isWritable: () => !sharedViewOf(workspace.workspaceId),
          signal,
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
          unsubscribeFileWatch: (watchParams) =>
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
    onStatusChange: hooks.onPipelineStatus,
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
  return { pipeline, agentDrivers: pluginDrivers, workspaceEvents };
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
          throw new Error("Shared site file returned an invalid result.");
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
      throw new Error(`Site has no dev or start script: ${input.site.root}`);
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
        `Site build failed or did not produce a static output folder.${
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
    throw new Error("Site preview start was cancelled because the renderer restarted.");
  }
  if (!outputRoot) throw new Error(`Site has no build output to preview: ${input.site.root}`);
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
// refresh without polling. A scoped push reaches only windows whose ACTIVE
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
// carries the NEW session's key so a same-account token rotation invalidates
// nothing.
// The phase completes the two-moment contract: "changing" is transition
// start (views PRESERVE same-session state and ask for nothing — the
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
// set-aside drafts would answer nothing (#579 review, r12). Tracked at
// creation instead of guessed from getAllWindows().
const workspaceWindows = createWorkspaceWindowRegistry<BrowserWindow>(
  (window) => window.isDestroyed(),
);
// The last zoom level any path applied (mutation, settings save, or the
// persisted read). The bootstrap seeds it from the cached settings read
// BEFORE the first window exists, so every window — including the first of
// a launch — starts at the right scale before any show(). Null only until
// that seed lands, which precedes every window creation.
let knownZoomLevel: number | null = null;

function trackWorkspaceWindow(window: BrowserWindow): BrowserWindow {
  workspaceWindows.track(window);
  window.on("closed", () => workspaceWindows.forget(window));
  // The persisted zoom level is a window property main owns, set
  // SYNCHRONOUSLY at creation — before any show() on either creation path —
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
        // One path for hosts AND guests: a guest attached before the read
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
  // Embedded plugin content follows the window zoom (#875): the person who
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
  peekedReceivedGrantKinds.clear();
  // #742 P1 SECURITY (rounds 4–5): every credential-cache clear is a session
  // transition (login adoption, logout, or a current-session 401 — all three
  // call this one function). Clearing here, not at each call site
  // individually, is what makes sure a NEW account's first failed poll can
  // never be served the PREVIOUS account's cached request rows, sender
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
async function remoteForWorkspace(workspace: RegistryEntry) {
  await warmCredentialCache();
  const credentialGeneration = credentialCacheGeneration;
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
  return { credentials, credentialGeneration };
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

type RelayShareRetainedDependentSetResult<T> =
  | { kind: "success"; body: T }
  | { kind: "dependents-changed"; body: unknown; status: number };

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
  init?: RequestInit,
  options?: { retainDependentSetConflict: true },
): Promise<T | RelayShareRetainedDependentSetResult<T>> {
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
    // The relay proved a session invalid — but only the session THIS request
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
      options?.retainDependentSetConflict &&
      response.status === 409 &&
      data?.ok === false &&
      data.code === "dependents_changed"
    ) {
      return { kind: "dependents-changed", body: data, status: response.status };
    }
    throw new Error(relayShareErrorCopy(response.status, data));
  }
  if (options?.retainDependentSetConflict) {
    return { kind: "success", body: data as T };
  }
  return data as T;
}

async function relayShareJson<T>(path: string, init?: RequestInit): Promise<T> {
  await warmCredentialCache();
  const credentials = cachedCredentials;
  if (!credentials) throw new RelaySessionError("Sign in to dohc Cloud first.");
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

interface DesktopWorkspaceAuthorityState {
  activity: WorkspaceActivityState;
  workspaceGraph: WorkspaceGraphIndex;
  pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace>;
  pluginSurfaces: PluginSurfaces<WebContentsView>;
  sitePreviews: ReturnType<typeof createSitePreviewLifecycle>;
  tryInVersionSessions: ReturnType<typeof createTryInVersionSessions>;
  workspaceChatLifecycle: ReturnType<typeof createWorkspaceChatLifecycle>;
  shareMountCommands: ReturnType<typeof createShareMountCommandsFor>;
  shareViewFiles: ShareViewFilesState;
  sharedChannelWork: Promise<void>;
  sharedChannelSyncCursor: string | null;
  lastKnownDmRequestLanes: ReturnType<
    typeof createLastKnownDmRequestLanesCache
  >;
  bookmarkProjectionPending: boolean;
  bookmarkProjectionRunning: boolean;
  agentIntegration: AgentIntegrationState;
  linkedChatStore: DesktopLinkedChatStore | null;
  agentDispatchStoreHandle: LiveAgentDispatchStoreHandle | null;
  dispatchAgentRunId: string | null;
  dispatchSync: Promise<boolean> | null;
  retainedActivity: boolean;
  activityOpening: Promise<SyncStatusResult> | null;
  activityClosing: Promise<void> | null;
  pendingCliRunMessageLinks: Set<string>;
  engineStoreRebuild: Promise<void> | null;
  lastEngineStoreRebuildResult: RebuildEngineStoreResult | null;
  chatBookmarkRuns: Map<string, Promise<void>>;
}

type DesktopWorkspaceAuthorityLease = WorkspaceAuthorityLease<
  RegistryEntry,
  DesktopWorkspaceAuthorityState
>;

type DesktopWorkspaceOperation = WorkspaceAuthorityOperation<
  RegistryEntry,
  DesktopWorkspaceAuthorityState
>;

interface DesktopWorkspaceOperationAuthority {
  readonly state: DesktopWorkspaceAuthorityState;
  assertCurrent(): void;
}

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
    sharedChannelWork: Promise.resolve(),
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
    engineStoreRebuild: null,
    lastEngineStoreRebuildResult: null,
    chatBookmarkRuns: new Map(),
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

function serializeWorkspaceAuthorityWork<Result>(
  authority: DesktopWorkspaceOperationAuthority,
  run: () => Promise<Result>,
): Promise<Result> {
  const state = authority.state;
  const result = state.sharedChannelWork
    .catch(() => undefined)
    .then(async () => {
      authority.assertCurrent();
      const value = await run();
      authority.assertCurrent();
      return value;
    });
  state.sharedChannelWork = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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
const presenceMutationOwner = new PresenceMutationOwner<WebContents>();
// A stable ownership key so one window holds at most ONE poll per (scope, topic):
// a new poll for the same key supersedes (aborts) the prior long-poll.
function presenceScopeTopicKey(scope: PresenceScopeInput, topic: string): string {
  return JSON.stringify(
    scope.kind === "workspace"
      ? ["w", scope.workspaceId, topic]
      : ["s", scope.workspaceId, scope.shareId, topic],
  );
}

function presenceMutationKey(
  scope: PresenceScopeInput,
  topic: string,
  clientId: string,
): string {
  return JSON.stringify([presenceScopeTopicKey(scope, topic), clientId]);
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
      workspaceId: entry.workspaceId,
    };
  } else {
    const joined = (findWorkspace(scope.workspaceId)?.sharedChannels ?? []).some(
      (channel) =>
        channel.shareId === scope.shareId && channel.ended !== true,
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

const reportSharedChannelPassCoverage = createPassCoverageReporter((message) =>
  console.info(message),
);
let materializePendingChatBookmarksForWorkspace:
  | ((workspaceId: string) => Promise<void>)
  | null = null;

// Workspaces that might hold pending chat-bookmark projections. The engine
// marks a projection pending when a reply reaches a bookmarked target; every
// path a reply can take through this process (agent dispatch, CLI/MCP write,
// relay pull, renderer send) either projects immediately or flags its
// workspace here. The slow background worker below only visits flagged
// workspaces — plus each workspace once on open, for rows a previous
// session left behind.
function queueChatBookmarkProjection(workspaceId: string): void {
  if (!findWorkspace(workspaceId)) return;
  const lease = requireWorkspaceAuthority(workspaceId);
  lease.state.bookmarkProjectionPending = true;
  lease.release();
}

async function projectPendingChatBookmarksAfterPull(workspaceId: string): Promise<void> {
  await projectChatBookmarksAfterPull({
    readOnly: Boolean(sharedViewOf(workspaceId)),
    project: async () => {
      await materializePendingChatBookmarksForWorkspace?.(workspaceId);
    },
    reportError: (error) => {
      console.error(`[desktop] post-pull chat bookmark projection (${workspaceId}):`, error);
      // The pull marked projections pending and this pass failed to write
      // them; the background worker retries.
      queueChatBookmarkProjection(workspaceId);
    },
  });
}

// Resolves to the live rows this pass did not reach, so an awaited caller can
// say so in its own response.
function syncWorkspaceSharedChannels(
  workspaceId: string,
  priorityChannelWireId?: string,
): Promise<number> {
  return workspaceAuthorities.withAuthority(workspaceId, (lease) =>
    serializeWorkspaceAuthorityWork(lease, () =>
      runSharedChannelSyncPass(lease, priorityChannelWireId),
    ),
  );
}

function syncRendererWorkspaceSharedChannels(
  operation: DesktopRendererWorkspaceOperation,
  priorityChannelWireId?: string,
): Promise<number> {
  return serializeWorkspaceAuthorityWork(operation, () =>
    runSharedChannelSyncPass(operation, priorityChannelWireId),
  );
}

// A pass triggered by a write must cover the share that was written, whatever
// the rotation would have reached (#718). The trigger knows the chat target,
// not the share, so resolve it here through the same registry lookup the write
// gate uses. An unresolved target simply syncs without a priority.
async function syncSharedChannelsForChatTarget(
  workspaceId: string,
  target?: { channelId: string } | { threadId: string },
): Promise<number> {
  const entry = findWorkspace(workspaceId);
  if (!entry) return 0;
  return workspaceAuthorities.withAuthority(workspaceId, async (lease) => {
    lease.assertCurrent();
    if (!target) return await syncWorkspaceSharedChannels(workspaceId);
    let joinedChannel: JoinedSharedChannel | null;
    try {
      joinedChannel = await joinedSharedChannelForTarget({
        workspaceId,
        sharedChannels: entry.sharedChannels,
        store: linkedChatStoreFor(lease),
        target,
      });
      lease.assertCurrent();
    } catch {
      // The lookup failed. That says nothing about the target, so an ordinary
      // pass is safer than treating the channel as local.
      return await syncWorkspaceSharedChannels(workspaceId);
    }
    if (!joinedChannel || joinedChannel.ended === true) return 0;
    return await syncWorkspaceSharedChannels(
      workspaceId,
      joinedChannel.channelWireId,
    );
  });
}

async function syncRendererSharedChannelsForChatTarget(
  operation: DesktopRendererWorkspaceOperation,
  target?: { channelId: string } | { threadId: string },
): Promise<number> {
  operation.assertCurrent();
  const workspace = operation.workspace;
  if (!target) return syncRendererWorkspaceSharedChannels(operation);
  let joinedChannel: JoinedSharedChannel | null;
  try {
    joinedChannel = await joinedSharedChannelForTarget({
      workspaceId: workspace.workspaceId,
      sharedChannels: workspace.sharedChannels,
      store: linkedChatStoreFor(workspace),
      target,
    });
    operation.assertCurrent();
  } catch {
    return syncRendererWorkspaceSharedChannels(operation);
  }
  if (!joinedChannel || joinedChannel.ended === true) return 0;
  return syncRendererWorkspaceSharedChannels(
    operation,
    joinedChannel.channelWireId,
  );
}

// A pass with no rows to cover left nothing behind. Clearing the remainder this
// workspace last reported keeps a returning partial pass from being deduped
// against a report from before the rows went away.
function reportSharedChannelPassCoveredEverything(workspaceId: string): void {
  reportSharedChannelPassCoverage({
    workspaceId,
    live: 0,
    uncovered: 0,
    passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
  });
}

async function runSharedChannelSyncPass(
  authority: DesktopWorkspaceAuthorityLease | DesktopWorkspaceOperation,
  priorityChannelWireId?: string,
): Promise<number> {
  const binding = "binding" in authority ? authority.binding : null;
  const operation: DesktopWorkspaceOperation | null =
    binding === null ? (authority as DesktopWorkspaceOperation) : null;
  const workspaceId = operation
    ? operation.workspace.workspaceId
    : binding!.workspaceId;
  let requestCredentialGeneration: number | null = null;
  const assertRequestCurrent = (): void => {
    authority.assertCurrent();
    if (
      operation &&
      requestCredentialGeneration !== null &&
      credentialCacheGeneration !== requestCredentialGeneration
    ) {
      throw new Error("Your dohc Cloud session changed. Try again.");
    }
  };
  // Live rows this pass is responsible for. A pass that dies before finishing —
  // or never starts, because the account is signed out — refreshed none of them,
  // and must say so rather than report a clean sweep. Seeded before the
  // credential work so a rejection there still knows the count.
  let liveRows = 0;
  try {
    authority.assertCurrent();
    const current = operation ? operation.workspace : findWorkspace(workspaceId);
    const entry = current
      ? {
          ...current,
          attachmentId: operation
            ? operation.workspace.attachmentId
            : binding!.attachmentId,
          rootPath: operation
            ? current.rootPath
            : binding!.canonicalRootPath,
        }
      : null;
    // The registry, unfiltered: the pass needs a row's PLACE even after the row
    // stops being syncable, or a revoked cursor sends the rotation back to the
    // front. Only `channels` below is filtered down to the work set.
    const registryOrder = entry?.sharedChannels ?? [];
    const channels = registryOrder.filter((channel) => !channel.ended);
    if (!entry || channels.length === 0) {
      reportSharedChannelPassCoveredEverything(workspaceId);
      return 0;
    }
    liveRows = channels.length;
    await warmCredentialCache();
    requestCredentialGeneration = credentialCacheGeneration;
    assertRequestCurrent();
    const syncCredentials = cachedCredentials;
    // Signed out, or signed in to a server this workspace does not sync with:
    // the rows are joined and none of them got refreshed.
    if (!syncCredentials?.relayUrl) return liveRows;
    const relayUrl = syncCredentials.relayUrl;
    // A joined channel syncs only for the relay account that joined it.
    const matching = channels.filter((channel) =>
      joinedChannelMatchesCredentials(channel, syncCredentials),
    );
    // No row belongs to this account's relay, so no row is in this pass's remit
    // — nothing was left behind by a bound, and nothing can be.
    if (matching.length === 0) {
      reportSharedChannelPassCoveredEverything(workspaceId);
      return 0;
    }
    liveRows = matching.length;
    const relay = {
      baseUrl: normalizeServerUrl(relayUrl),
      token: syncCredentials.token,
      fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
    };
    const daemonRelay = receivedShareEngine.relayForRegistered({
      ...entry,
      relay,
    });
    const result = await syncJoinedSharedChannels({
      rootDir: entry.rootPath,
      workspaceId: entry.workspaceId,
      relay,
      channels: matching,
      registryOrder,
      passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
      resumeAfterChannelWireId:
        authority.state.sharedChannelSyncCursor ?? undefined,
      priorityChannelWireId,
      pull: async (input) => {
        assertRequestCurrent();
        const pulled = await daemonRelay.pullSharedChannel({
          shareId: input.shareId,
          channelWireId: input.channelWireId,
        });
        assertRequestCurrent();
        return pulled;
      },
      push: async (input) => {
        assertRequestCurrent();
        const pushed = await daemonRelay.pushSharedChannel({
          shareId: input.shareId,
          channelWireId: input.channelWireId,
        });
        assertRequestCurrent();
        return pushed;
      },
    });
    assertRequestCurrent();
    if (result.resumeAfterChannelWireId === null) {
      authority.state.sharedChannelSyncCursor = null;
    } else {
      authority.state.sharedChannelSyncCursor = result.resumeAfterChannelWireId;
    }
    // Rows this pass did not leave fresh: the ones the rotation never reached,
    // plus the ones it reached and could not sync.
    const unrefreshed = result.uncovered + result.failedRows;
    reportSharedChannelPassCoverage({
      workspaceId,
      live: matching.length,
      uncovered: unrefreshed,
      passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
    });
    if (result.endedShareIds.length > 0 || result.readOnlyShareIds.length > 0) {
      const ended = new Set(result.endedShareIds);
      // A read-write grant that turned out read-only on push (flipped or
      // recorded stale) downgrades the registry row too: the renderer's
      // composer honesty keys off `joined.access`, and a corrected row stops
      // every future pass from re-attempting the same doomed push.
      const readOnly = new Set(result.readOnlyShareIds);
      assertRequestCurrent();
      setWorkspaceSharedChannels(
        workspaceId,
        ((operation ? operation.workspace : findWorkspace(workspaceId))
          ?.sharedChannels ?? []).map((channel) => {
          if (ended.has(channel.shareId)) return { ...channel, ended: true };
          if (readOnly.has(channel.shareId)) return { ...channel, access: "read-only" as const };
          return channel;
        }),
      );
      assertRequestCurrent();
    }
    if (result.changed || result.endedShareIds.length > 0 || result.readOnlyShareIds.length > 0) {
      assertRequestCurrent();
      notifyRenderer({ workspaceId });
    }
    if (result.changed) {
      assertRequestCurrent();
      await projectPendingChatBookmarksAfterPull(workspaceId);
      assertRequestCurrent();
    }
    return unrefreshed;
  } catch (error) {
    if (operation) assertRequestCurrent();
    console.error(`[desktop] shared channel sync failed for ${workspaceId}:`, error);
    return liveRows;
  }
}

// The copyable MCP launch config for a workspace. The user's AI tool spawns the
// dohc MCP stdio server with these args; --workspace scopes every tool to this
// root (path containment), --home points it at the desktop registry/state dir.
// The command comes from resolveDohcMcpCommand: a packaged install's own
// shipped cli-bin launcher by absolute path, the workspace bin `dohc-mcp` in
// dev, with DOHC_MCP_COMMAND as the explicit override.
// The MCP profile a workspace hands out (#646): `null` for a workspace this
// machine owns, and the share's level for a share view.
//
// The two questions compose, and in this order. PRESENCE decides whether a
// share profile applies at all — a marker whose value was lost is still a
// share view, and reading it as an ordinary workspace would hand out the full
// write-capable server. READABILITY only decides how much the profile opens,
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
  // A share view hands out the MCP profile for its level (#646): the launched
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
  // The flag-gated engine capture (see engineCaptureGate.ts — shared with the
  // arc-gate QA harness so the harness asserts against the REAL gate). The
  // gate also owns the shared-view rule (#540): main only states whether the
  // workspace is one, and the decision carries the cause so the null capture
  // never wears the Settings opt-out's copy.
  captureFor: async (workspace, hooks) =>
    captureForFlaggedWorkspace(
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
// "Try it in a version" (PR 0N-2): one gesture composing EXISTING operations
// — fork-and-switch on the engine capture chain, then a dohc-tracked run —
// and a review state when the run ends. Resolution of the capture mirrors
// requireEngineCapture (workspace identity from the registry, engine flag
// gate); unflagged workspaces reject with the same product message.
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
        throw new Error(
          engineOffRefusal(
            workspaceActivity.getStatus(workspace, lease.state.activity),
            "Versions",
            "restart",
          ),
        );
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
    const [{ createAgentDriverRegistry }, { createDesktopAgentDrivers }, { createAgentSessionManager }] =
      await Promise.all([
        import("./agents/AgentDriver"),
        import("./agents/AgentProcessDrivers"),
        import("./agents/AgentSessionManager"),
      ]);
    cachedAgentSessions = createAgentSessionManager({
      registry: createAgentDriverRegistry(createDesktopAgentDrivers(process.env)),
      // A workspace's plugin drivers join its registry beside the built-ins.
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
// hydrated every file's CONTENT via a full-text listing just to read two string
// fields off each row.
//
// listTextFileMetadata is the right call: it pages (limit 500 + afterPath) so
// a workspace past one page is no longer silently truncated, and it never
// hydrates file bodies.
async function engineSearchIndexFor(
  workspace: EngineWorkspace,
): Promise<{ versionId: string; files: { objectId: string; path: string }[];
} | null> {
  const sessions = rustEngineWorkspaceSessions;
  if (!sessions) return null;
  const read = async (engineWorkspace: EngineWorkspace) => await sessions.run(
    engineWorkspace,
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

async function inWorkspaceEngineStoreLane<Result>(
  lease: DesktopWorkspaceAuthorityLease,
  work: () => Promise<Result>,
): Promise<Result> {
  const state = lease.state;
  const previous = state.engineStoreRebuild ?? Promise.resolve();
const result = previous
    .catch(() => undefined)
    .then(async () => {
      lease.assertCurrent();
const value = await work();
      lease.assertCurrent();
      return value;
    });
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  state.engineStoreRebuild = settled;
  try {
    return await result;
  } finally {
    if (state.engineStoreRebuild === settled) state.engineStoreRebuild = null;
  }
}

function withEngineStoreRecoveredForAuthority<Result>(
  lease: DesktopWorkspaceAuthorityLease,
  body: () => Promise<Result>,
): Promise<Result> {
  const workspace = canonicalWorkspaceFor(lease);
  return inWorkspaceEngineStoreLane(lease, () =>
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
          const { capture } = await captureForFlaggedWorkspace(
            {
              ...workspace,
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
  // move, or found nothing pending) but BEFORE activity.open starts the
  // daemon-owned capture. The rebuild's own reopen uses this to release the
  // request-scoped gate before capture.start()'s startup probe binds a
  // session — otherwise that probe races the still-raised gate and
  // self-refuses in the background (#882 round 19).
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

async function acquireDispatchRunActivity(
  workspace: CreatedWorkspace & { attachmentId?: symbol },
): Promise<() => Promise<boolean>> {
  return withWorkspaceAttachmentAsync(workspace, async (lease) => {
    const current = canonicalWorkspaceFor(lease);
    const alreadyOpen = workspaceActivity.isOpen(lease.state.activity);
    await lease.state.workspaceChatLifecycle.open(
      current,
      () => ensureWorkspaceActivityOpen(current),
    );
    return createDispatchRunRelease({
      alreadyOpen,
      isRetained: () =>
        withWorkspaceAttachment(current, (held) => held.state.retainedActivity) ??
        false,
      close: () => closeDispatchRunActivity(current),
    });
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
  // An opted-out workspace must record NOTHING: without this gate the
  // workspace-open scan reaches dispatchStoreFor/chatStoreFor, whose daemon
  // workspace.open creates .dohc/engine/engine.db. Open sessions answer from
  // their capture snapshot (the flag applies at the NEXT open).
  scanEligible: (workspace) =>
    withWorkspaceAttachmentAsync(workspace, () =>
      dispatchScanEligible(workspace, activity),
    ),
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
    // The helper owns both orders (#583): cause read before the release,
    // recovery derived from what the release actually did.
    await releaseAndRefuseWithoutCapture({
      capture: activity.engineCaptureFor(workspace.workspaceId),
      // A retention that landed during our close reopens the workspace; its
      // capture builds after the release resolves. Settling joins (or, for
      // an already-retained workspace, starts — the retainer will reuse it)
      // that open, so the capture read judges a formed state.
      settleKeptOpen: () =>
        ensureWorkspaceActivityOpen(registered).then(
          () => undefined,
          () => undefined,
        ),
      currentCapture: () => activity.engineCaptureFor(workspace.workspaceId),
      status: () => activity.getStatus(workspace.workspaceId),
      release,
      feature: "Chats",
    });
    return async () => {
      await release();
    };
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
    throw new Error(
      engineOffRefusal(
        activity.getStatus(workspace.workspaceId),
        "Plugins",
        "restart",
      ),
    );
  }
  return { workspace, capture };
}

async function invokeWorkspacePluginSdk(input: {
  workspaceId: string;
  pluginId: string;
  spawnId: string;
  requestPath: "panel" | "plugin-process";
  isWritable: () => boolean;
  signal?: AbortSignal;
  invokeChildProcess?: (method: string, params?: unknown) => Promise<unknown>;
  subscribeFileWatch?: (params: unknown) => { subscriptionId: string };
  unsubscribeFileWatch?: (params: unknown) => boolean;
  method: string;
  params?: unknown;
}): Promise<unknown> {
  return withPhysicalWorkspaceOperation(input.workspaceId, async (operation) => {
    const workspace = operation.workspace;
    const signal = input.signal
      ? AbortSignal.any([input.signal, operation.signal])
      : operation.signal;
    return invokePluginSdkHost(
      {
        pluginId: input.pluginId,
        workspaceRoot: workspace.rootPath,
        spawnId: input.spawnId,
        requestPath: input.requestPath,
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
        unsubscribeFileWatch: input.unsubscribeFileWatch,
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
      ? createPluginPanelFileWatchEmitter({
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
      unsubscribeFileWatch: workspaceEvents
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
        "Chats",
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
      void syncSharedChannelsForChatTarget(workspace.workspaceId, target);
      void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
        console.error("[desktop] CLI dispatch scan:", error);
      });
    },
    // No renderer poll runs the sync pass on the CLI's or MCP's behalf (#731):
    // AWAIT (bounded — see cliServer.ts's CHAT_READ_SYNC_BUDGET_MS) the same
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

// Close every live engine Y.Doc session (app quit) BEFORE the engine stores are
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
  const window = trackWorkspaceWindow(
    createMainWindow({ beforeRendererReload: prepareAfterRendererCrash }),
  );
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
// Settles with the daemon handshake (false = startup failed and the app is
// quitting). The whenReady continuation creates the window WHILE the daemon
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

const shareMountCommands: Pick<
  ReturnType<typeof createShareMountCommandsFor>,
  "mount" | "refresh" | "unmount"
> = {
  mount(input) {
    const attachmentId = Reflect.get(input.workspace, "attachmentId");
    if (typeof attachmentId !== "symbol") {
      throw new Error("Share mount work requires an exact workspace attachment.");
    }
    return withPhysicalWorkspaceOperation(
      input.workspace.workspaceId,
      async (operation) => {
        if (operation.workspace.attachmentId !== attachmentId) {
          throw new Error("Share mount work belongs to a retired workspace.");
        }
        await engineDaemonStartup;
        operation.assertCurrent();
        input.assertCurrent();
        return operation.state.shareMountCommands.mount({
          ...input,
          workspace: operation.workspace,
          assertCurrent: () => {
            operation.assertCurrent();
            input.assertCurrent();
          },
        });
      },
    );
  },
  refresh(input) {
    const attachmentId = Reflect.get(input.workspace, "attachmentId");
    if (typeof attachmentId !== "symbol") {
      throw new Error("Share mount work requires an exact workspace attachment.");
    }
    return withPhysicalWorkspaceOperation(
      input.workspace.workspaceId,
      async (operation) => {
        if (operation.workspace.attachmentId !== attachmentId) {
          throw new Error("Share mount work belongs to a retired workspace.");
        }
        await engineDaemonStartup;
        operation.assertCurrent();
        input.assertCurrent();
        return operation.state.shareMountCommands.refresh({
          workspace: operation.workspace,
          assertCurrent: () => {
            operation.assertCurrent();
            input.assertCurrent();
          },
        });
      },
    );
  },
  unmount(input) {
    const attachmentId = Reflect.get(input.workspace, "attachmentId");
    if (typeof attachmentId !== "symbol") {
      throw new Error("Share mount work requires an exact workspace attachment.");
    }
    return withPhysicalWorkspaceOperation(
      input.workspace.workspaceId,
      async (operation) => {
        if (operation.workspace.attachmentId !== attachmentId) {
          throw new Error("Share mount work belongs to a retired workspace.");
        }
        await engineDaemonStartup;
        operation.assertCurrent();
        input.assertCurrent();
        return operation.state.shareMountCommands.unmount({
          ...input,
          workspace: operation.workspace,
          assertCurrent: () => {
            operation.assertCurrent();
            input.assertCurrent();
          },
        });
      },
    );
  },
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

function listOwnedWorkspaceFiles(workspace: { workspaceId: string }) {
  return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
    listOwnedWorkspaceFilesFor(operation.workspace),
  );
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
  return createOwnedWorkspaceSdkReads({
    workspace,
    files: shareViewFiles,
    ...(databaseReader ? { databaseReader } : {}),
    listFiles: () => listOwnedWorkspaceFilesFor(workspace),
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
      presencePolls: presencePollRegistry,
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

function ownedWorkspaceGraphSource(
  workspace: RegistryEntry & { readonly attachmentId: symbol },
) {
  const hasShareState = workspaceHasReceivedShareState(workspace);
  return {
    // Ordinary workspaces share the Explorer's complete listing. Received
    // shares still list per request so authority changes are intersected before
    // resolution; their parsed bodies remain reusable by content identity.
    list: () =>
      hasShareState
        ? listOwnedWorkspaceFilesFor(workspace)
        : workspaceFileListings.list({
            workspaceId: workspace.workspaceId,
            attachmentId: workspace.attachmentId,
            allowCached: true,
            load: () => listOwnedWorkspaceFilesFor(workspace),
          }),
    ...(hasShareState
      ? {
          readText: (path: string) => readOwnedWorkspaceTextFor(workspace, path),
        }
      : {}),
  };
}

async function collectShareTargetZipEntries(input: {
  target: ShareViewFilesTarget;
  rootName: string;
  relativePath?: string;
}): Promise<{ entries: ZipEntry[]; baseName: string }> {
  const listed = await shareViewFiles.list(input.target);
  let selectedPath: string | undefined;
  if (input.relativePath !== undefined) {
    const validated = validateUserReadPath(input.relativePath);
    if (!validated.ok) {
      throw new Error(
        `Invalid export path (${validated.reason}): ${input.relativePath}`,
      );
    }
    selectedPath = validated.normalized;
    if (classifyEngineFilePathForRead(selectedPath).kind === "secret") {
      throw new Error(
        `Secret files never leave the workspace in an export: ${selectedPath}`,
      );
    }
  }
  const selected = listed.files.filter(
    (file) =>
      selectedPath === undefined ||
      file.path === selectedPath ||
      file.path.startsWith(`${selectedPath}/`),
  );
  if (
    selectedPath !== undefined &&
    selected.length === 0 &&
    !(listed.folders ?? []).includes(selectedPath)
  ) {
    throw new Error(`Export path does not exist: ${selectedPath}`);
  }
  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (const file of selected) {
    if (classifyEngineFilePathForRead(file.path).kind === "secret") continue;
    const read = await shareViewFiles.read(input.target, {
      kind: "asset",
      path: file.path,
    });
    if (read.kind !== "asset") {
      throw new Error("Shared export read returned an invalid result.");
    }
    totalBytes += read.bytes.byteLength;
    if (
      entries.length >= MAX_ZIP_ENTRIES ||
      totalBytes > MAX_ZIP_TOTAL_BYTES
    ) {
      throw new Error(ZIP_TOO_LARGE_REFUSAL);
    }
    const archivePath =
      selectedPath === undefined
        ? file.path
        : file.path === selectedPath
          ? basename(selectedPath)
          : `${basename(selectedPath)}/${file.path.slice(selectedPath.length + 1)}`;
    entries.push({ path: archivePath, data: read.bytes });
  }
  const name =
    selectedPath === undefined ? input.rootName : basename(selectedPath);
  return {
    entries,
    baseName: name.replace(/\.[^.]+$/, "") || name,
  };
}

async function collectOwnedZipEntries(
  workspace: NonNullable<ReturnType<typeof findWorkspace>>,
  relativePath?: string,
): Promise<{ entries: ZipEntry[]; baseName: string }> {
  return collectOwnedWorkspaceZipEntries({
    workspace,
    ...(relativePath === undefined ? {} : { relativePath }),
    collectShare: collectShareTargetZipEntries,
  });
}

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

function shareViewImportResult(
  workspaceId: string,
  outcome: ShareViewFileChangeOutcome,
): { imported: string[]; skipped: number; interrupted?: true } {
  if (outcome.status === "committed") {
    if (outcome.projection === "pending") notifyRenderer({ workspaceId });
    if (
      typeof outcome.value !== "object" ||
      outcome.value === null ||
      !("imported" in outcome.value) ||
      !("skipped" in outcome.value)
    ) {
      throw new Error("Shared file import returned an invalid result.");
    }
    return outcome.value as { imported: string[]; skipped: number };
  }
  notifyRenderer({ workspaceId });
  console.error("[desktop] shared file import did not finish cleanly", outcome);
  if (outcome.status === "partial") {
    const imported = outcome.effects
      .filter((effect) => effect.before === "absent" && effect.after === "present")
      .map((effect) => effect.path);
    return {
      imported,
      skipped: 0,
      interrupted: true,
    };
  }
  throw new Error(
    "dohc could not confirm which shared files were imported. Do not retry the whole import. Refresh the shared view, then choose only files that are still missing.",
  );
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

app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // FIRST, synchronously (#564): a document open mid transport-retry holds
  // the capture chain, and workspaceAuthorityStop below queues behind it. This resolves
  // its armed backoff and makes the next failure final, so the chain frees in
  // at most one attempt instead of spending the whole 3 s budget. Nothing is
  // abandoned that a user could see: an opening document is read-only (#533),
  // so no edit exists yet on the path being given up.
  //
  // That claim only holds because the sessions scope this to a BOUNDED region
  // — the document open. An already-open document retrying a write the engine
  // accepted keeps retrying, without backoff, for whatever the quit timer
  // leaves it: its update exists only in the canonical in-memory Y.Doc, so
  // abandoning that retry would discard the edit (codex P1).
  rustEngineWorkspaceSessions?.beginShutdown();
  const searchStop = workspaceSearchOwner.dispose().catch(() => undefined);
  // Here, not at before-quit: every window has closed, so every beforeunload
  // has had its chance to veto and this quit is now certain (#579 review,
  // r19). Fire-and-forget — skip locks and do not await async stops so
  // termination stays quick; child.unref() and the OS finish the cleanup.
  const pluginStop = stopAllPluginWorkspaces();
  const agentSessionStop = (
    cachedAgentSessions?.stopAll() ?? Promise.resolve()
  ).catch(() => undefined);
  const chatDispatchStop = chatDispatchService.stop().catch(() => undefined);
  const cliServerStop = chatDispatchStop.then(() =>
    (cliServerStartup ?? Promise.resolve(cliServer))
    .then((server) => server?.close())
    .catch(() => undefined),
  );
  // Close live engine Y.Doc sessions (settle + release reservations) before the
  // engine stores stop — a session must never settle onto a closed store.
  const engineYDocStop = closeAllEngineYDocSessions();
  const agentIntegrationStop = agentSessionStop
    .then(() => agentIntegration.stopAll())
    .catch(() => undefined);
  // The physical authority owns the capture and every per-workspace surface.
  // Stop every producer first; chaining an already-started close promise here
  // would not impose this order.
  const workspaceAuthorityStop = Promise.allSettled([
    engineYDocStop,
    agentSessionStop,
    chatDispatchStop,
    cliServerStop,
    searchStop,
    agentIntegrationStop,
    pluginStop,
  ])
    .then(() => workspaceAuthorities.close())
    .catch(() => undefined);
  const workspaceShutdown = workspaceAuthorityStop
    .then(async () => await workspaceDatabaseWorker.dispose())
    .then(async () => await closeAllRelayTransportWorkspaces())
    .catch(() => undefined)
    .then(async () => await rustEngineDaemon?.stop());
  void Promise.race([
    workspaceShutdown,
    new Promise<void>((resolve) => setTimeout(resolve, WILL_QUIT_BUDGET_MS)),
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
    // This is an exact capability-spelling check, not filesystem containment:
    // the approved root or requested workspace may not exist yet. The create
    // path realpath-checks its existing parent before it writes.
    const prefix = approved.endsWith("/") ? approved : `${approved}/`;
    if (normalized === approved || normalized.startsWith(prefix)) {
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
            isCurrent: () => {
              try {
                operation.assertCurrent();
                return true;
              } catch {
                return false;
              }
            },
          },
        }),
    );
  },
};

// Injectable clock/id seams (oracle/tests) for renderer-initiated database
// edits, whose nowMs becomes appliedAt (and createId the operationId) in the
// persisted JSONL operation log. Omitted ⇒ the real wall clock / randomUUID,
// identical to today's behavior.
// Quit-ask guard (#567): shared by the before-quit interceptor and the IPC
// handlers the renderer answers through. The state machine lives in
// quitGuard.ts so the busy-renderer promise is a tested fact: a silent ACK
// window opens a MAIN-side dialog that names the loss — it never quits by
// itself (#579 review, r11).
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
  // the workspace windows FIRST: a destroyed window runs no beforeunload, so
  // a renderer that wakes cannot veto the decision and open a second warning
  // (#579 review, r15). app.quit() still follows, so the will-quit teardown —
  // engine sessions, stores, WAL locks — runs exactly as for any other quit.
  forceQuit: () => {
    for (const window of workspaceWindows.allLive()) window.destroy();
    app.quit();
  },
});

// Recovery re-check at the quit boundary (#579 review, r12). The renderer's
// own check happens before it asks for the install, and a reopen can set an
// edit aside in the gap between the two — separate processes, and a queued
// render lands inside it. So main asks again HERE, and only then approves the
// quit that quitAndInstall starts.
//
// A renderer that misses the ACK window may be BUSY, not dead, and no
// deadline tells those apart (#579 review, r16). Silence therefore asks the
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
    registerPhysicalWorkspace(created);
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
    registerPhysicalWorkspace(attached);
    refreshNativeWorkspaceSurfaces();
    return summary;
  });

  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "File listing stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        const listing = await workspaceFileListings.list({
          workspaceId: workspace.workspaceId,
          attachmentId: workspace.attachmentId,
          allowCached: input.allowCached === true,
          load: async () => await listOwnedWorkspaceFilesFor(workspace),
        });
        return ListWorkspaceFilesResult.parse(listing);
      },
    );
  });

  ipcMain.handle(CHANNELS.createWorkspaceFile, workspaceFileMutations.createFile);
  ipcMain.handle(
    CHANNELS.createWorkspaceFolder,
    workspaceFileMutations.createFolder,
  );
  ipcMain.handle(CHANNELS.moveWorkspacePath, workspaceFileMutations.movePath);
  ipcMain.handle(CHANNELS.deleteWorkspacePath, workspaceFileMutations.deletePath);

  ipcMain.handle(CHANNELS.exportWorkspaceZip, async (event, payload) => {
    assertTrustedSender(event);
    const input = ExportWorkspaceZipPayload.parse(payload);
    const inactiveMessage =
      "Export stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );
    // Gather + bound BEFORE asking where to save: an over-limit export
    // refuses without ever showing a dialog.
    const { entries, baseName } = await exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      (operation) =>
        collectOwnedZipEntries(operation.workspace, input.relativePath),
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
    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) => {
        if (target === null) {
          return ExportWorkspaceZipResult.parse({ path: null });
        }
        const { writeFile } = await import("node:fs/promises");
        operation.assertCurrent();
        await writeFile(target, buildStoreZip(entries));
        operation.assertCurrent();
        return ExportWorkspaceZipResult.parse({ path: target });
      },
    );
  });

  // "Copy as Markdown" / "Export as HTML" / "Export as PDF" (ViewHeader's
  // document menu). The renderer always sends the same self-contained HTML
  // (documentExport.ts); this handler only decides where the bytes land
  // (.html verbatim, .pdf via the hidden offscreen window) — see
  // documentPdfExport.ts for the "only one export in flight" guard.
  ipcMain.handle(CHANNELS.exportDocumentFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = ExportDocumentFilePayload.parse(payload);
    const inactiveMessage =
      "Export stopped because this window changed workspaces.";
    // workspaceId authorizes the CALLER (a real, currently-open workspace) —
    // the save target itself is intentionally outside any workspace, same as
    // exportWorkspaceZip above.
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );

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
    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) => {
        if (target === null) {
          return ExportDocumentFileResult.parse({ path: null });
        }
        const { writeFile } = await import("node:fs/promises");
        operation.assertCurrent();
        if (input.kind === "pdf") {
          const pdf = await renderHtmlToPdf(input.content);
          operation.assertCurrent();
          await writeFile(target, pdf);
        } else {
          // Markdown and HTML both arrive as the exact text to persist —
          // markdown is the raw document source, HTML the self-contained render.
          await writeFile(target, input.content, "utf8");
        }
        operation.assertCurrent();
        return ExportDocumentFileResult.parse({ path: target });
      },
    );
  });

  // Native explorer context menu over the CLOSED EXPLORER_MENU_COMMANDS set:
  // main owns every label and the item structure (the renderer only names
  // what was right-clicked), and the chosen id resolves the SAME invoke —
  // null on dismiss. "Reveal in file manager" is performed HERE (containment
  // first) so no broader open-path IPC needs to exist for it.
  ipcMain.handle(CHANNELS.showExplorerMenu, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShowExplorerMenuPayload.parse(payload);
    const inactiveMessage =
      "Explorer action stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );
    const menuContext = await exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      (operation) => {
        const registryEntry = operation.workspace;
        const shareView = sharedViewOf(registryEntry.workspaceId);
        const isSharedView = shareView !== null;
        const isMountPath =
          !isSharedView && !!input.path && isSharedWithMePath(input.path);
        const mountForPath = isMountPath
          ? (() => {
              const mounts = storedShareMounts(registryEntry);
              return mounts
                .filter((mount) => usableShareMountRecord(mounts, mount))
                .find(
                  (mount) => input.path === `shared-with-me/${mount.label}`,
                );
            })()
          : undefined;
        return {
          shareView,
          isMountPath,
          hasMountRecord: mountForPath !== undefined,
          canShare:
            !isSharedView &&
            !isMountPath &&
            !!registryEntry.remote &&
            input.kind !== "root",
        };
      },
    );

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
      // The menu's shape is decided by `explorerMenuEntries`, where it can be
      // driven at every level; main owns only the Electron plumbing. main
      // still owns the MENU, so a renderer cannot add an item back.
      // Share-mount paths (shared-with-me/…) are a read-only projection of
      // someone else's files. The mount root itself (shared-with-me/<label>
      // with a matching mount record) additionally offers refresh and removal.
      const template: Electron.MenuItemConstructorOptions[] = explorerMenuEntries({
        kind: input.kind,
        pinned: input.pinned === true,
        isMountPath: menuContext.isMountPath,
        hasMountRecord: menuContext.hasMountRecord,
        // Sharing onward is offered nowhere in a share view or a mount:
        // someone else's files are not this account's to grant, and a share
        // needs a relay-side workspace to grant from.
        canShare: menuContext.canShare,
        shareView: menuContext.shareView,
      }).map((entry) =>
        entry.kind === "separator" ? { type: "separator" as const } : item(entry.label, entry.id),
      );
      const menu = Menu.buildFromTemplate(template);
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      menu.popup({
        window,
        // The close callback can fire before the clicked item's handler —
        // defer one tick so `picked` is settled either way.
        callback: () => setImmediate(() => resolve(picked)),
      });
    });

    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) => {
        if (chosen === "open-externally" && input.path) {
          // Containment before the OS sees the path (resolveWorkspaceFile:
          // validate + realpath + inside-root), same rule as openFileExternally.
          await ensureOwnedProjectionCurrent(operation.workspace, input.path!);
          const { realTarget } = await resolveWorkspaceFile(
            operation.workspace.rootPath,
            input.path!,
            "read",
          );
          operation.assertCurrent();
          shell.showItemInFolder(realTarget);
        }
        return ShowExplorerMenuResult.parse(chosen);
      },
    );
  });

  ipcMain.handle(CHANNELS.showWorkbenchMenu, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShowWorkbenchMenuPayload.parse(payload);
    const inactiveMessage =
      "Workbench menu stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );

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
              item("Move into New Group", "move-tab-to-new-group"),
              item("Close Editor Group", "close-editor-group", {
                enabled: input.canCloseEditorGroup === true,
              }),
              separator,
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

    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      () => ShowWorkbenchMenuResult.parse(chosen),
    );
  });

  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportWorkspaceFilesPayload.parse(payload);
    const importInto = (
      operation: DesktopRendererWorkspaceOperation,
      absolutePaths: string[],
      screenAgainstRoots: string[] | null,
    ) => {
      const workspace = operation.workspace;
      return withStaleSensitiveWorkspaceOperation(
        workspace.rootPath,
        async (lease) => {
          const currentWorkspace = operation.workspace;
          const isShareView = shareViewIsPresent(currentWorkspace.shareView);
          if (!isShareView) {
            assertWritableWorkspace(currentWorkspace);
            await refuseImportIntoShareProjection(
              workspace.rootPath,
              input.targetDir,
              storedShareMounts(currentWorkspace),
              shareMountRegistryIsPresent(currentWorkspace),
            );
            return screenAgainstRoots === null
              ? copyIntoWorkspace(
                  workspace.rootPath,
                  absolutePaths,
                  input.targetDir,
                )
              : importDroppedPaths(
                  workspace.rootPath,
                  absolutePaths,
                  screenAgainstRoots,
                  input.targetDir,
                );
          }
          return shareViewImportResult(
            workspace.workspaceId,
            await shareViewFiles.change(
              lease,
              { kind: "standalone", workspaceId: workspace.workspaceId },
              {
                kind: "import",
                absolutePaths,
                screenAgainstRoots,
                targetDir: input.targetDir,
              },
            ),
          );
        },
      );
    };
    // OS drag-in path: renderer-supplied absolute paths (see the trust-delta
    // note on the payload) re-validated by the drag-in screen — regular
    // files only, never any registered workspace's .dohc metadata. The
    // renderer-supplied targetDir is re-validated inside the import path
    // (resolveImportDestination) before any copy.
    const droppedPaths = input.droppedPaths;
    if (droppedPaths !== undefined) {
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "File import stopped because this window changed workspaces.",
        async (operation) =>
          ImportWorkspaceFilesResult.parse(
            await importInto(
              operation,
              droppedPaths,
              listWorkspaces().map((ws) => ws.rootPath),
            ),
          ),
      );
    }
    const inactiveMessage =
      "File import stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );
    const picked = testImportPaths();
    const result =
      picked === null
        ? await dialog.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            title: "Import files into workspace",
          })
        : { canceled: false, filePaths: picked };
    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) =>
        result.canceled
          ? ImportWorkspaceFilesResult.parse({ imported: [], skipped: 0 })
          : ImportWorkspaceFilesResult.parse(
              await importInto(operation, result.filePaths, null),
            ),
    );
  });

  // Plugin SDK reads use the combined helper to make the main-process
  // workspace authorization boundary explicit. Older workspace handlers keep
  // the equivalent assertTrustedSender + requireWorkspace steps separate.
  ipcMain.handle(CHANNELS.readWorkspaceText, async (event, payload) => {
    const input = ReadWorkspaceTextPayload.parse(payload);
    assertTrustedSender(event);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "File read stopped because this window changed workspaces.",
      async (operation) =>
        ReadWorkspaceTextResult.parse(
          await readOwnedWorkspaceTextFor(
            operation.workspace,
            input.relativePath,
          ),
        ),
    );
  });

  ipcMain.handle(CHANNELS.writeWorkspaceText, workspaceFileMutations.writeText);
  ipcMain.handle(CHANNELS.writeWorkspaceAsset, workspaceFileMutations.writeAsset);

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
    const inactiveMessage =
      "Image selection stopped because this window changed workspaces.";
    const workspaceReference = await exactRendererWorkspaceReferences.capture(
      event.sender,
      input.workspaceId,
      inactiveMessage,
    );
    await exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      (operation) => assertWritableWorkspace(operation.workspace),
    );

    const seam = testAbsolutePaths("DOHC_TEST_PICK_IMAGE_PATHS", MAX_PICKED_IMAGES);
    let picked: string[];
    if (seam) {
      picked = seam;
    } else {
      const result = await dialog.showOpenDialog({
        title: "Insert image",
        // The workspace directory — where a user's own images live — instead
        // of wherever the OS last happened to leave the dialog.
        defaultPath: workspaceReference.canonicalRootPath,
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

    return exactRendererWorkspaceReferences.withReference(
      event.sender,
      workspaceReference,
      inactiveMessage,
      async (operation) => {
        assertWritableWorkspace(operation.workspace);
        const { readFile, stat } = await import("node:fs/promises");
        const files: PickImageFilesResult["files"] = [];
        for (const path of picked.slice(0, MAX_PICKED_IMAGES)) {
          try {
            const info = await stat(path);
            // Oversize picks are refused the same QUIET way paste refuses them:
            // skipped with a warning, never a thrown dialog in the user's face.
            if (
              !info.isFile() ||
              info.size === 0 ||
              info.size > WRITE_ASSET_MAX_BYTES
            ) {
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
      },
    );
  });

  ipcMain.handle(CHANNELS.openFileExternally, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenFileExternallyPayload.parse(payload);
    await withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "External file open stopped because this window changed workspaces.",
      async (operation) => {
        // Resolve+contain first: only a real file inside the workspace can be
        // handed to the OS opener — never an arbitrary path or URL. window.open
        // remains fully denied; this is the only sanctioned external-open path.
        await ensureOwnedProjectionCurrent(
          operation.workspace,
          input.relativePath,
        );
        const { realTarget } = await resolveWorkspaceFile(
          operation.workspace.rootPath,
          input.relativePath,
          "read",
        );
        operation.assertCurrent();
        const error = await shell.openPath(realTarget);
        if (error) throw new Error(error);
      },
    );
  });

  ipcMain.handle(CHANNELS.readWorkspaceGraph, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadWorkspaceGraphPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Workspace graph read stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        const graph = await operation.state.workspaceGraph.readGraph(
          workspace.rootPath,
          ownedWorkspaceGraphSource(workspace),
        );
        if (!input.includeChatMentions) return WorkspaceGraphResult.parse(graph);
        const { workspace: engineWorkspace } = await requireEngineCapture(
          workspace.workspaceId,
          "Chat mentions",
        );
    const rowsUncovered = await syncWorkspaceSharedChannels(
      engineWorkspace.workspaceId,
    );
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
      ...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),
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
      },
    );
  });

  ipcMain.handle(CHANNELS.getBacklinks, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetBacklinksPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Backlink read stopped because this window changed workspaces.",
      async (operation) =>
        GetBacklinksResult.parse({
          sources: await operation.state.workspaceGraph.readBacklinks(
            operation.workspace.rootPath,
            input.path,
            ownedWorkspaceGraphSource(operation.workspace),
          ),
        }),
    );
  });

  ipcMain.handle(CHANNELS.listWorkspaceHeadings, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceHeadingsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Heading read stopped because this window changed workspaces.",
      async (operation) => {
        const source = await readOwnedWorkspaceTextFor(
          operation.workspace,
          input.path,
        );
        return ListWorkspaceHeadingsResult.parse({
          headings: workspaceHeadingRecords(extractWorkspaceHeadings(source.text)),
        });
      },
    );
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
      // The INCOMING session's identity, computed BEFORE anything is
      // cleared: the immediate broadcast says where the session is going, so
      // a same-account rotation carries the SAME key and mounted views keep
      // their rows instead of reading a signed-out interim as a switch.
      const incomingKey = chatShareSessionKey(await cloudLogin().credentials());
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
        notifySessionChanging: () =>
          notifyCloudSessionChangedWithKey(incomingKey, "changing"),
        notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
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
      // The shell asks at mount, which can precede the daemon handshake now
      // that the window loads during it.
      await engineDaemonStartup;
      const sessions = requireEngineSessions();
      workspaceSecretState = await withPhysicalWorkspaceOperation(
        workspace.workspaceId,
        async (operation) =>
          await readWorkspaceSecretState(
            receivedShareEngine.workspaceForRegistered(operation.workspace),
            sessions,
          ),
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
    await runCloudLogoutTransition({
      clearCachedCredentials: () => clearCachedCredentials(),
      logout: () => cloudLogin().logout(),
      stopEngines: () => activity.stopEngines(),
      closeRelayTransportWorkspaces: () => closeAllRelayTransportWorkspaces(),
      // Scope-free: logout changes every workspace's sync state at once.
      notifyWorkspaceActivity: () => notifyRenderer(),
      // Logout is a one-event transition to a known state: signed out. The
      // key change is what makes every view clear and refresh.
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
    });
  });

  // Enabling sync claims the workspace id. The first claimant owns it. The
  // owner can retry, and another account gets the relay's fixed 404. The
  // handler then records the verified binding and starts the merge engine.
  //
  // The relay's POST /sync/workspaces is the SOLE claim authority: workspace-api
  // is now auth-only and 404s every non-auth route, so there is no separate
  // preclaim to make — the relay owns ownership end to end (create / idempotent
  // same-owner / foreign-refused).
  ipcMain.handle(CHANNELS.cloudEnableSync, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudEnableSyncPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Cloud enrollment stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        // A received share replicates through its pinned share lane. Enrolling its
        // projection as an owned workspace would claim someone else's filtered
        // copy and creates another engine-open path that has no reason to exist.
        assertWritableWorkspace(workspace);
        const credentials = await loadAndCacheCurrentCredentials();
        operation.assertCurrent();
        if (!credentials) throw new Error("Sign in to dohc Cloud first");
        if (!credentials.relayUrl) {
          throw new Error("Cloud sync requires a relay URL");
        }
        assertSyncEnrollmentCredentials(workspace, credentials);
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
        try {
          await daemonRelay.claim();
        } catch (error) {
          if (error instanceof RelayWorkspaceUnavailableError) {
            throw new Error(
              "This workspace id is already claimed by another account",
            );
          }
          throw error;
        }
        operation.assertCurrent();
        const sessions = rustEngineWorkspaceSessions;
        if (!sessions) {
          throw new Error("Rust engine workspace sessions are unavailable.");
        }
        const dataKey = await readWorkspaceDataKeyForEnrollment(
          receivedShareEngine.workspaceForRegistered(workspace),
          sessions,
        );
        operation.assertCurrent();
        await enrollWorkspaceKeyEnvelope({
          workspaceId: workspace.workspaceId,
          dataKey,
          ...(input.passphrase === undefined
            ? {}
            : { passphrase: input.passphrase }),
          transport: daemonRelay,
          installDataKey: async (unwrapped) =>
            await installWorkspaceDataKey(workspace.rootPath, unwrapped),
        });
        operation.assertCurrent();
        setWorkspaceRemote(workspace.workspaceId, {
          serverUrl: credentials.serverUrl,
          ownerUserId: credentials.userId,
        });
        await activity.enableCloud(workspace);
        operation.assertCurrent();
        return SyncStatusResult.parse(activity.getStatus(workspace.workspaceId));
      },
    );
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
    let authorityBinding: DesktopWorkspaceAuthorityBinding | null = null;
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

    await mkdir(rootPath, { recursive: true });
    const authorityReservation = workspaceAuthorities.reserveBinding({
      workspaceId: parsed.workspaceId,
      rootPath,
    });
    let created!: CreatedWorkspace;
    let summary!: ReturnType<typeof WorkspaceSummary.parse>;
    desktopMarks.mark("workspace-join-start");
    try {
      // Join bootstrap (0P-C gate fix): identity/metadata only — no starter
      // files. The synced workspace's real content arrives with the first
      // pull; anything seeded here could be captured by reconciliation and
      // pushed INTO the remote workspace before that pull.
      created = await createWorkspaceFolder({
        rootPath,
        kind: "personal",
        workspaceId: parsed.workspaceId,
        bootstrap: "join",
      });
      summary = WorkspaceSummary.parse(created);
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
      await bootstrapJoinedWorkspace({
        workspaceId: parsed.workspaceId,
        identity: probe.identity,
        ...(input.passphrase === undefined
          ? {}
          : { passphrase: input.passphrase }),
        transport: daemonRelay,
        installDataKey: async (unwrapped) =>
          await installWorkspaceDataKey(created.rootPath, unwrapped),
      });

      authorityBinding = registerReservedPhysicalWorkspace(
        authorityReservation,
        { ...created, joinBootstrapPending: true },
      );
      refreshNativeWorkspaceSurfaces();

      // Now open capture, bind the remote, and enable the pull-first engine.
      // joinBootstrap makes the engine PULL-FIRST:
      // its start() is the first pull (materialize + cursor commit), and no
      // push can reach the relay before that pull succeeds — a fresh join can
      // never seed boilerplate into the remote or conflict against it.
      await openWorkspaceActivity(created, {
        afterActivityOpen: async () => {
          setWorkspaceRemote(created.workspaceId, {
            serverUrl: credentials.serverUrl,
            ownerUserId: credentials.userId,
          });
          await activity.enableCloud(created, { joinBootstrap: true });
          completeWorkspaceJoinBootstrap(created.workspaceId);
        },
      });
    } catch (error) {
      // Failed-first-pull contract (0P-C gate fix, documented choice): roll
      // the ENTIRE join back — engine/watcher/capture, registry entry, and
      // the folder contents this attempt created — instead of leaving a
      // half-joined workspace whose next launch would push before ever
      // having pulled. Everything removed still lives on the relay; the
      // user retries with the same code and the same (empty again) folder.
      console.error(`[desktop] join rollback for ${rootPath}:`, error);
      try {
        if (authorityBinding) {
          await removePhysicalWorkspace(authorityBinding, () =>
            cleanupFailedPhysicalWorkspace(parsed.workspaceId, rootPath),
          );
        } else {
          await workspaceAuthorities.releaseReservation(
            authorityReservation,
            () => cleanupFailedPhysicalWorkspace(parsed.workspaceId, rootPath),
          );
        }
      } catch (cleanupError) {
        console.error("[desktop] join rollback cleanup:", cleanupError);
        throw new Error(
          "Couldn't safely roll back the workspace. Its folder was left in place; restart dohc before retrying.",
        );
      }
      refreshNativeWorkspaceSurfaces();
      // Scope-free: the rollback removed a registry entry no window has
      // active yet — every window's workspace list is what changed.
      notifyRenderer();
      if (
        error instanceof Error &&
        /^(?:Passphrase required|Passphrase could not)\b/u.test(error.message)
      ) {
        throw error;
      }
      throw new Error(
        "Couldn't download the workspace. Nothing was added on this machine — check your connection and try again.",
      );
    }
    desktopMarks.measureSince("workspace-join", "workspace-join-start");
    // Scope-free: the join added a registry entry no window has active yet.
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
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        if (shareViewIsPresent(workspace.shareView)) {
          throw new Error(
            "This is a shared view — only the original workspace can be shared.",
          );
        }
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(workspace);
        operation.assertCurrent();
        const created = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => credentialCacheGeneration,
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<{ shareId: string }>(
              credentials,
              `/sync/${encodeURIComponent(workspace.workspaceId)}/shares`,
              {
                method: "POST",
                body: JSON.stringify({
                  recipientEmail: input.recipientEmail,
                  access: input.access,
                  ...(input.paths ? { paths: input.paths } : {}),
                  ...(input.versionId ? { versionId: input.versionId } : {}),
                }),
              },
            );
          },
        });
        operation.assertCurrent();
        const shareCode = buildShareCode({
          shareId: created.shareId,
          relayUrl: credentials.relayUrl!,
        });
        return CreateRelayShareResult.parse({
          shareId: created.shareId,
          shareCode,
          recipientEmail: input.recipientEmail,
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.listRelayShares, async (event) => {
    assertTrustedSender(event);
    const result = await relayShareJson<{
      granted: Array<Record<string, unknown>>;
      received?: Array<Record<string, unknown>>;
    }>("/sync/shares");
    const relayUrl = cachedCredentials?.relayUrl;
    const withCode = (row: Record<string, unknown>) => ({
      ...row,
      shareCode: buildShareCode({ shareId: String(row.shareId), relayUrl: relayUrl! }),
    });
    // The two managers split this listing; see relayShareLanes for why a
    // damaged row stays in the granted lane.
    const lanes = pathShareLanes(result);
    const granted = lanes.granted.map(withCode);
    const received = lanes.received.map(withCode);
    return ListRelaySharesResult.parse({ granted, received });
  });

  ipcMain.handle(CHANNELS.revokeRelayShare, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeRelaySharePayload.parse(payload);
    await relayShareJson(`/sync/shares/${encodeURIComponent(input.shareId)}/revoke`, {
      method: "POST",
    });
    return undefined;
  });

  ipcMain.handle(CHANNELS.createRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateRelayShareLinkPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        operation.assertCurrent();
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(operation.workspace);
        operation.assertCurrent();
        const relayResult = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => credentialCacheGeneration,
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/links`,
              {
                method: "POST",
                body: JSON.stringify(
                  "paths" in input
                    ? { paths: input.paths }
                    : { versionId: input.versionId },
                ),
              },
            );
          },
        });
        operation.assertCurrent();
        const parsed = RelayShareLinkCreateResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return CreateRelayShareLinkResult.parse(parsed.data);
      },
    );
  });

  ipcMain.handle(CHANNELS.listRelayShareLinks, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListRelayShareLinksPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        operation.assertCurrent();
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(operation.workspace);
        operation.assertCurrent();
        const relayResult = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => credentialCacheGeneration,
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/links`,
            );
          },
        });
        operation.assertCurrent();
        const parsed = RelayShareLinkListResponse.safeParse(relayResult);
        if (!parsed.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return ListRelayShareLinksResult.parse(parsed.data);
      },
    );
  });

  ipcMain.handle(CHANNELS.rotateRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = RotateRelayShareLinkPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        operation.assertCurrent();
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(operation.workspace);
        operation.assertCurrent();
        const relayResult = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => credentialCacheGeneration,
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/shares/${encodeURIComponent(input.shareId)}/links/${encodeURIComponent(input.grantId)}/rotate`,
              {
                method: "POST",
                body: JSON.stringify({
                  workspaceId: operation.workspace.workspaceId,
                  expectedDependentGrantIds: input.expectedDependentGrantIds,
                }),
              },
              { retainDependentSetConflict: true },
            );
          },
        });
        operation.assertCurrent();
        if (relayResult.kind === "dependents-changed") {
          const conflict = RelayShareLinkDependentConflict.safeParse(
            relayResult.body,
          );
          if (!conflict.success) {
            throw new Error(relayShareErrorCopy(relayResult.status, null));
          }
          return RotateRelayShareLinkResult.parse({
            outcome: "dependents-changed",
            dependents: conflict.data.dependents,
          });
        }
        const rotated = RelayShareLinkRotateResponse.safeParse(relayResult.body);
        if (!rotated.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return RotateRelayShareLinkResult.parse({
          outcome: "rotated",
          url: rotated.data.url,
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.revokeRelayShareLink, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevokeRelayShareLinkPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        operation.assertCurrent();
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(operation.workspace);
        operation.assertCurrent();
        const relayResult = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => credentialCacheGeneration,
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<unknown>(
              credentials,
              `/sync/shares/${encodeURIComponent(input.shareId)}/revoke`,
              {
                method: "POST",
                body: JSON.stringify({
                  grantId: input.grantId,
                  workspaceId: operation.workspace.workspaceId,
                  expectedDependentGrantIds: input.expectedDependentGrantIds,
                }),
              },
              { retainDependentSetConflict: true },
            );
          },
        });
        operation.assertCurrent();
        if (relayResult.kind === "dependents-changed") {
          const conflict = RelayShareLinkDependentConflict.safeParse(
            relayResult.body,
          );
          if (!conflict.success) {
            throw new Error(relayShareErrorCopy(relayResult.status, null));
          }
          return RevokeRelayShareLinkResult.parse({
            outcome: "dependents-changed",
            dependents: conflict.data.dependents,
          });
        }
        const ended = RelayShareLinkEndResponse.safeParse(relayResult.body);
        if (!ended.success) {
          throw new Error(relayShareErrorCopy(500, null));
        }
        return RevokeRelayShareLinkResult.parse({ outcome: "ended" });
      },
    );
  });

  // --- Shared channels (MU-C4) --------------------------------------------
  // A chat-channel grant shares a WHOLE channel (threads/messages/reactions)
  // with another account, read-write by default. The relay owns every
  // security decision (membership, authorship, channel scoping, revocation);
  // these handlers only address grants and move the member-side sync.

  ipcMain.handle(CHANNELS.shareChatChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = ShareChatChannelPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        assertWritableWorkspace(workspace);
        const store = linkedChatStoreFor(workspace);
        await requireShareableChatChannel({
          workspaceId: workspace.workspaceId,
          channelId: input.channelId,
          store,
        });
        operation.assertCurrent();
        const wireId = await store.getChannelWireId({
          workspaceId: workspace.workspaceId,
          channelId: input.channelId,
        });
        operation.assertCurrent();
        if (!wireId) throw new Error("This channel can't be shared yet.");
        // "general" is every workspace's personal default channel — the SAME wire
        // id everywhere by design, so sharing it would merge strangers' personal
        // chats. Refuse with a way forward.
        if (wireId === GENERAL_CHANNEL_WIRE_ID) {
          throw new Error(
            "The general channel is personal to each workspace. Create a channel to share it.",
          );
        }
        if (
          workspace.sharedChannels?.some(
            (channel) => channel.channelWireId === wireId,
          )
        ) {
          throw new Error(
            "This channel was shared with you — ask the person who shared it to add more people.",
          );
        }
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(workspace);
        operation.assertCurrent();
        const created = await awaitCredentialGeneration({
          capturedGeneration: credentialGeneration,
          currentGeneration: () => credentialCacheGeneration,
          run: () => {
            operation.assertCurrent();
            return relayShareJsonWithCredentials<{ shareId: string }>(
              credentials,
              `/sync/${encodeURIComponent(workspace.workspaceId)}/shares`,
              {
                method: "POST",
                body: JSON.stringify({
                  recipientEmail: input.recipientEmail,
                  channelWireId: wireId,
                  ...(input.access ? { access: input.access } : {}),
                }),
              },
            );
          },
        });
        operation.assertCurrent();
        return ShareChatChannelResult.parse({ shareId: created.shareId });
      },
    );
  });

  // What THIS machine joined, for the channels the caller named. The grant
  // side lives on the relay; this side does not, so asking it costs no network
  // — and a caller that needs only this must not wait on a relay that may
  // never answer.
  //
  // The scope is a required argument, not a filter a caller may skip: the
  // registry array grows with every channel this workspace has ever joined,
  // and an unscoped answer would carry that history to the renderer. The write
  // gate is unaffected — assertSharedChannelWritable reads the whole array
  // here in main and never crosses IPC at all.
  function joinedChannelAnswers(
    workspace: RegistryEntry,
    channelWireIds: readonly string[],
  ) {
    return scopeJoinedChannels(workspace.sharedChannels ?? [], channelWireIds);
  }

  ipcMain.handle(
    CHANNELS.listJoinedSharedChannels,
    createListJoinedSharedChannelsIpcHandler({
      assertTrustedSender,
      withWorkspaceOperation: (event, workspaceId, work) =>
        withRendererWorkspaceOperation(
          event.sender,
          workspaceId,
          "Sharing stopped because this window changed workspaces.",
          work,
        ),
      answerJoinedChannels: joinedChannelAnswers,
    }),
  );

  function shareIdsClaimedByOtherWorkspaces(workspaceId: string): Set<string> {
    const claimed = new Set<string>();
    for (const [shareId, holders] of liveSharedChannelHoldersByShareId(
      listWorkspaces(),
    )) {
      if ([...holders].some((holder) => holder !== workspaceId)) claimed.add(shareId);
    }
    return claimed;
  }

  function otherWorkspaceHoldingShare(
    shareId: string,
    workspaceId: string,
  ): { workspaceId: string; rootPath: string } | null {
    return otherLiveSharedChannelHolder({
      workspaces: listWorkspaces(),
      shareId,
      workspaceId,
    });
  }

  function otherWorkspaceHoldingWireId(
    channelWireId: string,
    workspaceId: string,
  ): { workspaceId: string; rootPath: string } | null {
    return otherLiveSharedChannelHolderByWireId({
      workspaces: listWorkspaces(),
      channelWireId,
      workspaceId,
    });
  }

  function assertShareNotHeldElsewhere(
    shareId: string,
    workspaceId: string,
    channelWireId?: string,
  ): void {
    const holder =
      otherWorkspaceHoldingShare(shareId, workspaceId) ??
      (channelWireId
        ? otherWorkspaceHoldingWireId(channelWireId, workspaceId)
        : null);
    if (!holder) return;
    const workspaceName =
      holder.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
    throw new Error(
      `This conversation already lives in ${workspaceName}. Open that workspace to continue.`,
    );
  }

  function reserveAndPullSharedChannelForWorkspace(input: {
    operation: DesktopRendererWorkspaceOperation;
    assertCurrent?: () => void;
    relay: SyncRelayConnection;
    shareId: string;
    recipientUserId: string;
    relayUrl: string;
    preWrite?: (info: { channelWireId: string }) => void;
  }): Promise<JoinedSharedChannel> {
    const workspace = input.operation.workspace;
    const assertCurrent = input.assertCurrent ?? input.operation.assertCurrent;
    return reserveAndPullSharedChannel({
      relay: input.relay,
      shareId: input.shareId,
      workspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      recipientUserId: input.recipientUserId,
      relayUrl: input.relayUrl,
      preWrite: input.preWrite,
      readSharedChannels: () => {
        assertCurrent();
        return input.operation.workspace.sharedChannels ?? [];
      },
      writeSharedChannels: (workspaceId, channels) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error("Shared channel write targeted a different workspace.");
        }
        assertCurrent();
        setWorkspaceSharedChannels(workspaceId, channels);
        assertCurrent();
      },
      fetchInfo: async (request) => {
        assertCurrent();
        const info = await fetchSharedChannelInfo(request);
        assertCurrent();
        return info;
      },
      pull: async ({ workspaceId, rootPath, relay, shareId, channelWireId }) => {
        assertCurrent();
        if (
          workspaceId !== workspace.workspaceId ||
          rootPath !== workspace.rootPath
        ) {
          throw new Error("Shared channel pull targeted a different workspace.");
        }
        const result = await relayClientForWorkspace({
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          attachmentId: workspace.attachmentId,
          relay,
        }).pullSharedChannel({
          shareId,
          channelWireId,
        });
        assertCurrent();
        return result;
      },
      serialize: (workspaceId, run) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error("Shared channel work targeted a different workspace.");
        }
        return serializeWorkspaceAuthorityWork(
          { state: input.operation.state, assertCurrent },
          run,
        );
      },
      afterPull: async (workspaceId) => {
        if (workspaceId !== workspace.workspaceId) {
          throw new Error("Shared channel pull targeted a different workspace.");
        }
        assertCurrent();
        await projectPendingChatBookmarksAfterPull(workspaceId);
        assertCurrent();
      },
    });
  }

  ipcMain.handle(CHANNELS.listChatChannelShares, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelSharesPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        // Relay-side listings need a signed-in session; without one the local
        // joined set still answers (their local copies keep working offline), and
        // the relay side reports signed-out or unreachable instead of posing as
        // an empty listing.
        //
        // ONE credentials snapshot serves both the fetch and the session key, so
        // the key always names the session the request actually used — a login
        // or switch landing mid-flight cannot drift them apart.
        await warmCredentialCache();
        operation.assertCurrent();
        const credentials = cachedCredentials;
        const shareCredentialGeneration = credentialCacheGeneration;
        const assertCurrentShareSession = (): void => {
          operation.assertCurrent();
          if (credentialCacheGeneration !== shareCredentialGeneration) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        };
        const shareIdsClaimedElsewhere = shareIdsClaimedByOtherWorkspaces(
          workspace.workspaceId,
        );
        const relay = await readRelayChatShareLanes({
          fetchListing: async () => {
            if (!credentials) {
              throw new RelaySessionError("Sign in to dohc Cloud first.");
            }
            assertCurrentShareSession();
            const listing = await relayShareJsonWithCredentials<{
              granted?: Array<Record<string, unknown>>;
              received?: Array<Record<string, unknown>>;
            }>(credentials, "/sync/shares");
            assertCurrentShareSession();
            const receivedShareIds = Array.isArray(listing.received)
              ? listing.received.flatMap((row) => {
                  const selector = row.selector as
                    | { kind?: unknown }
                    | undefined;
                  return selector?.kind === "chat-channel" &&
                    typeof row.shareId === "string"
                    ? [row.shareId]
                    : [];
                })
              : [];
            // This adds bounded relay reads only for uncached grants. The one-time
            // cost closes the request-gate window before the first syncDms poll.
            await resolveDmKinds({
              shareIds: receivedShareIds,
              cache: peekedReceivedGrantKinds,
              peekKind: async (shareId) => {
                assertCurrentShareSession();
                const kind = await peekReceivedGrantKindForShare(
                  {
                    baseUrl: normalizeServerUrl(credentials.relayUrl!),
                    token: credentials.token,
                    fetch: relayFetchWithTimeout(
                      SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS,
                    ),
                  },
                  shareId,
                );
                assertCurrentShareSession();
                return kind;
              },
            });
            assertCurrentShareSession();
            for (const shareId of shareIdsToWithholdFromOrdinaryInvites({
              shareIds: receivedShareIds,
              cache: peekedReceivedGrantKinds,
            })) {
              shareIdsClaimedElsewhere.add(shareId);
            }
            return listing;
          },
          workspaceId: workspace.remote ? workspace.workspaceId : null,
          shareIdsClaimedElsewhere,
        });
        assertCurrentShareSession();
        // The caller's channels PLUS the invitations this answer is about to hand
        // it. The sharing surface shows both, and for each invitation it decides
        // whether this workspace has already joined that channel — a question it
        // cannot ask in advance, because this call is what tells it the invitation
        // exists. Read after the relay await, so a sync pass that ended a row
        // during it is reflected rather than missed.
        const shownWireIds = [
          ...input.channelWireIds,
          ...(relay.state === "answered"
            ? relay.received.map((row) => row.channelWireId)
            : []),
        ];
        return ListChatChannelSharesResult.parse({
          joined: joinedChannelAnswers(operation.workspace, shownWireIds),
          sessionKey:
            relay.state === "signed-out"
              ? null
              : chatShareSessionKey(credentials),
          relay,
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.joinSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = JoinSharedChannelPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Joining stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        if (shareViewIsPresent(workspace.shareView)) {
          throw new Error(
            "Shared views are read-only — join channels from a workspace you own.",
          );
        }
        await warmCredentialCache();
        operation.assertCurrent();
        const joinCredentials = cachedCredentials;
        const joinCredentialGeneration = credentialCacheGeneration;
        if (!joinCredentials) throw new Error("Sign in to dohc Cloud first.");
        if (!joinCredentials.relayUrl) {
          throw new Error(
            "Reconnect dohc Cloud with a sync relay URL, then try again.",
          );
        }
        // Capture the credentials BEFORE the awaits below (CodeRabbit Data
        // Integrity): cachedCredentials can change during fetch/pull (logout,
        // relay switch) — re-reading it afterwards can crash on null or pin the
        // joined channel to the WRONG relay. The join is atomic against the
        // credentials it started with.
        const joinedRelayUrl = joinCredentials.relayUrl;
        const joinedRecipientUserId = joinCredentials.userId;
        const assertCurrentJoinSession = (): void => {
          operation.assertCurrent();
          if (credentialCacheGeneration !== joinCredentialGeneration) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        };
        const relay = {
          baseUrl: normalizeServerUrl(joinedRelayUrl),
          token: joinCredentials.token,
          // Same timeout wrapper runSharedChannelSyncPass uses (:973): an
          // unresponsive relay must abort the join's fetch/pull instead of leaving
          // the renderer's "Joining…" button stuck forever.
          fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
        };
        let joined: JoinedSharedChannel;
        try {
          joined = await reserveAndPullSharedChannelForWorkspace({
            operation,
            assertCurrent: assertCurrentJoinSession,
            relay,
            shareId: input.shareId,
            recipientUserId: joinedRecipientUserId,
            relayUrl: joinedRelayUrl,
          });
          assertCurrentJoinSession();
        } catch (error) {
          assertCurrentJoinSession();
          if (error instanceof ShareUnavailableError) {
            throw new Error("That shared channel isn't available anymore.");
          }
          throw error;
        }
        return JoinSharedChannelResult.parse({
          joined: { ...joined, ended: false },
        });
      },
    );
  });

  // Member-initiated leave: purely local — the channel stops syncing and its
  // rows stay readable. Keep an ended tombstone so participant provenance and
  // the read-only write gate survive after live grant data is gone. Shared by
  // leaveSharedChannel and leaveDm (#742) — a DM's accepted row IS a
  // JoinedSharedChannel row in the same registry, so ending it is the same
  // operation regardless of which surface asked.
  function endWorkspaceJoinedChannel(
    operation: DesktopRendererWorkspaceOperation,
    shareId: string,
  ): void {
    const workspace = operation.workspace;
    operation.assertCurrent();
    setWorkspaceSharedChannels(
      workspace.workspaceId,
      endJoinedChannel(workspace.sharedChannels ?? [], shareId),
    );
    operation.assertCurrent();
  }

  ipcMain.handle(CHANNELS.leaveSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveSharedChannelPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Leaving stopped because this window changed workspaces.",
      (operation) => {
        endWorkspaceJoinedChannel(operation, input.shareId);
        return undefined;
      },
    );
  });

  // Record that the user has seen a share's skipped ops.
  //
  // It does NOT delete them. The cursor has already committed past those ops,
  // so this record is the only remaining evidence of what is missing —
  // deleting it behind a one-click control would be an irreversible change
  // with no reverse path and no warning. Acknowledging hides the warning,
  // keeps the coordinates for diagnosis, and lets a later refusal (a higher
  // generation) raise it again on its own.
  ipcMain.handle(CHANNELS.dismissShareSkips, async (event, payload) => {
    assertTrustedSender(event);
    const input = DismissShareSkipsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Share warning update stopped because this window changed workspaces.",
      (operation) => {
        const workspace = operation.workspace;
        if (
          input.shareId === undefined &&
          !shareViewIsPresent(workspace.shareView)
        ) {
          throw new Error("This workspace is not a shared view.");
        }
        if (
          input.shareId !== undefined &&
          shareMountRecordsForId(
            storedShareMounts(workspace),
            input.shareId,
          ).length === 0
        ) {
          throw new Error("That share is not mounted in this workspace.");
        }
        operation.assertCurrent();
        acknowledgeWorkspaceShareSkips(
          workspace.workspaceId,
          input.shareId,
          input.generation,
        );
        operation.assertCurrent();
        notifyRenderer({ workspaceId: workspace.workspaceId });
      },
    );
  });

  // ---- Share changes (#646 PR3a) ----
  //
  // Two lanes, and a workspace is only ever in one of them. The GRANTER lane
  // reads and settles the changes a recipient sent for a workspace this
  // machine owns; the RECIPIENT lane sends, lists, and takes back this
  // machine's own changes from inside an edit-level share view. Each refuses
  // the other's workspace before it reaches the relay, so a renderer that
  // names the wrong workspace gets a refusal here rather than a generic 404
  // from a route it should never have addressed.
  //
  // Neither lane trusts a client-supplied share id. The renderer names a
  // workspace; the registry answers which share that workspace is, and at
  // what level.

  interface ShareProposalGranterScope {
    readonly workspaceId: string;
    readonly attachmentId: symbol;
    readonly rootPath: string;
    relay: SyncRelayConnection;
    credentialGeneration: number;
  }

  function sameShareProposalGranterScope(
    left: ShareProposalGranterScope,
    right: ShareProposalGranterScope,
  ): boolean {
    return (
      left.workspaceId === right.workspaceId &&
      left.attachmentId === right.attachmentId &&
      left.rootPath === right.rootPath &&
      left.relay.baseUrl === right.relay.baseUrl &&
      left.relay.token === right.relay.token &&
      left.credentialGeneration === right.credentialGeneration
    );
  }

  function withShareProposalGranterOperation<Result>(
    sender: WebContents,
    workspaceId: string,
    work: (scope: {
      resolve(): ShareProposalGranterScope;
      assert(scope: ShareProposalGranterScope): void;
      readText(path: string): ReturnType<typeof readOwnedWorkspaceTextFor>;
      queueCloudSync(): void;
    }) => Promise<Result>,
  ): Promise<Result> {
    return withRendererWorkspaceOperation(
      sender,
      workspaceId,
      "Share changes stopped because this window changed workspaces.",
      async (operation) => {
        await warmCredentialCache();
        operation.assertCurrent();
        const resolve = (): ShareProposalGranterScope => {
          operation.assertCurrent();
          const workspace = operation.workspace;
          assertShareProposalGranter(workspace.shareView);
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
          if (!credentials.relayUrl) {
            throw new Error(
              "Reconnect dohc Cloud with a sync relay URL, then try again.",
            );
          }
          return {
            workspaceId: workspace.workspaceId,
            attachmentId: workspace.attachmentId,
            rootPath: workspace.rootPath,
            relay: {
              baseUrl: normalizeServerUrl(credentials.relayUrl),
              token: credentials.token,
              fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
            },
            credentialGeneration: credentialCacheGeneration,
          };
        };
        const scope = createShareProposalOperationScope({
          resolve,
          same: sameShareProposalGranterScope,
          changedMessage:
            "Share changes stopped because this workspace's cloud binding changed.",
        });
        return await work({
          ...scope,
          readText: (path) => readOwnedWorkspaceTextFor(operation.workspace, path),
          queueCloudSync: () => {
            operation.assertCurrent();
            activity.queueCloudSync(operation.workspace.workspaceId);
          },
        });
      },
    );
  }

  // The RECIPIENT lane's scope. The pinned grant and the share id come from
  // `shareProposals.ts`, and the CALLER states which rule applies: sending
  // needs the edit level, while listing and withdrawing what was already sent
  // need only membership — a reverse path a downgrade removes is not one.
  //
  // What is left here is the session, which must be signed in and on the
  // share's ORIGIN relay. The refresh SKIPS a session on another relay because
  // it runs on a cadence; this refuses, because a person pressed a button and
  // is owed an answer.
  interface ShareProposalRecipientScope {
    workspaceId: string;
    attachmentId: symbol;
    rootPath: string;
    shareId: string;
    grant: ShareViewSelector;
    relay: SyncRelayConnection;
    credentialGeneration: number;
  }

  function withShareProposalRecipientOperation<Result>(
    sender: WebContents,
    workspaceId: string,
    resolveScope: (shareView: unknown) => ShareViewProposalScope,
    work: (scope: {
      resolve(): ShareProposalRecipientScope;
      assert(scope: ShareProposalRecipientScope): void;
    }) => Promise<Result>,
  ): Promise<Result> {
    const sameScope = (
      left: ShareProposalRecipientScope,
      right: ShareProposalRecipientScope,
    ): boolean =>
      left.workspaceId === right.workspaceId &&
      left.attachmentId === right.attachmentId &&
      left.rootPath === right.rootPath &&
      left.shareId === right.shareId &&
      sameShareViewProposalScope(left, right) &&
      left.relay.baseUrl === right.relay.baseUrl &&
      left.relay.token === right.relay.token &&
      left.credentialGeneration === right.credentialGeneration;
    return withRendererWorkspaceOperation(
      sender,
      workspaceId,
      "Share changes stopped because this window changed workspaces.",
      async (operation) => {
        await warmCredentialCache();
        operation.assertCurrent();
        const resolve = (): ShareProposalRecipientScope => {
          operation.assertCurrent();
          const workspace = operation.workspace;
          const proposalScope = resolveScope(workspace.shareView);
          const credentials = cachedCredentials;
          if (!credentials?.relayUrl) {
            throw new Error("Sign in to dohc Cloud first.");
          }
          const shareRelayUrl = isRecordValue(workspace.shareView)
            ? workspace.shareView.relayUrl
            : undefined;
          if (
            typeof shareRelayUrl === "string" &&
            !relayUrlsMatch(credentials.relayUrl, shareRelayUrl)
          ) {
            throw new Error("Sign in to the cloud server this share came from.");
          }
          return {
            workspaceId: workspace.workspaceId,
            attachmentId: workspace.attachmentId,
            rootPath: workspace.rootPath,
            ...proposalScope,
            relay: {
              baseUrl: normalizeServerUrl(credentials.relayUrl),
              token: credentials.token,
              fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
            },
            credentialGeneration: credentialCacheGeneration,
          };
        };
        return await work(createShareProposalOperationScope({
          resolve,
          same: sameScope,
          changedMessage:
            "Share changes stopped because this shared view changed.",
        }));
      },
    );
  }

  // The after content of one proposed change. Owner-scoped: the blob was
  // uploaded into THIS workspace's storage, so the granter reads it back
  // through the blob route its own sync already uses.
  //
  // Tolerant, exactly as the current side is. A change this surface cannot
  // PREVIEW is still a change the granter has to answer, and failing the read
  // would take the Decline button with it — leaving the granter unable to say
  // no to something they cannot see.
  async function shareProposalIncomingText(
    relay: SyncRelayConnection,
    workspaceId: string,
    op: ShareProposalOp,
  ): Promise<string | null> {
    // A delete has no after side, and binary content is not something a text
    // diff can show. Both are "no incoming text", which the review states.
    if (op.operation === "delete" || !op.afterBlobSha256) return null;
    if (op.afterContentKind !== "text") return null;
    try {
      const response = await (relay.fetch ?? fetch)(
        `${relay.baseUrl}/sync/${encodeURIComponent(workspaceId)}/blobs/` +
          encodeURIComponent(op.afterBlobSha256),
        { headers: { authorization: `Bearer ${relay.token}` } },
      );
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      // The bound the CONTRACT enforces on this very field, not a larger one
      // from somewhere else. `incomingText` is validated by
      // `WORKSPACE_EDITOR_TEXT`, so text over that bound would make the whole
      // response fail to parse — and one unreadable file would take every
      // other file in the review down with it. This is also the bound the
      // current side already answers with (`readWorkspaceText` truncates at
      // it and reads as no preview), so the two sides agree.
      if (bytes.byteLength > WORKSPACE_TEXT_EDITOR_MAX_BYTES) return null;
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  // The opened proposal's file rows, from ops that name a path. An op naming
  // none describes no file this surface can show, and is left out rather than
  // rendered as a blank row. Only the review builds these; the polled listing
  // carries counts.
  function shareProposalFileRows(
    proposal: ShareProposal,
  ): Array<{ op: ShareProposalOp; path: string }> {
    return proposal.ops.flatMap((op) => {
      const path = shareProposalOpPath(op);
      return path ? [{ op, path }] : [];
    });
  }

  ipcMain.handle(CHANNELS.listShareProposals, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListShareProposalsPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const proposals = await listShareProposals({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
        });
        operation.assert(scope);
        return ListShareProposalsResult.parse({
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            shareId: proposal.shareId,
            proposedByEmail: proposal.proposedByEmail,
            createdAtMs: proposal.createdAtMs,
            ops: proposal.ops,
          })),
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.readShareProposalChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadShareProposalChangesPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const proposal = await readShareProposal({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
          proposalId: input.proposalId,
        });
        operation.assert(scope);
        return ReadShareProposalChangesResult.parse({
          proposedByEmail: proposal.proposedByEmail,
          files: shareProposalFileRows(proposal).map(({ op, path }) => ({
            opIndex: op.opIndex,
            path,
            operation: op.operation,
            drifted: op.drifted,
            afterByteLength: op.afterByteLength,
          })),
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.readShareProposalFileContent, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadShareProposalFileContentPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const op = await readShareProposalOp({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
          proposalId: input.proposalId,
          opIndex: input.opIndex,
        });
        operation.assert(scope);
        const currentText =
          op.currentPath === null
            ? null
            : await operation.readText(op.currentPath).then(
                (read) => (read.truncated ? null : read.text),
                () => null,
              );
        operation.assert(scope);
        const incomingText = await shareProposalIncomingText(
          scope.relay,
          scope.workspaceId,
          op,
        );
        operation.assert(scope);
        return ReadShareProposalFileContentResult.parse({
          currentText,
          incomingText,
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.settleShareProposal, async (event, payload) => {
    assertTrustedSender(event);
    const input = SettleShareProposalPayload.parse(payload);
    return withShareProposalGranterOperation(
      event.sender,
      input.workspaceId,
      async (operation) => {
        const scope = operation.resolve();
        const settled = await settleShareProposal({
          relay: scope.relay,
          workspaceId: scope.workspaceId,
          proposalId: input.proposalId,
          decision: input.decision,
        });
        operation.assert(scope);
        if (settled.state !== "accepted" && settled.state !== "declined") {
          throw new Error("Those changes are no longer open. Refresh, then try again.");
        }
        if (settled.state === "accepted") operation.queueCloudSync();
        return SettleShareProposalResult.parse({ state: settled.state });
      },
    );
  });

  ipcMain.handle(CHANNELS.submitShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = SubmitShareChangesPayload.parse(payload);
    // SENDING needs the edit level.
    return withShareProposalRecipientOperation(
      event.sender,
      input.workspaceId,
      requireShareViewProposalScope,
      async (operation) => {
        const beforeReconcile = operation.resolve();
        const reconciled = await withStaleSensitiveWorkspaceOperation(
          beforeReconcile.rootPath,
          (lease) =>
            shareViewFiles.reconcile(
              lease,
              {
                kind: "standalone",
                workspaceId: beforeReconcile.workspaceId,
              },
              "settle",
            ),
        );
        operation.assert(beforeReconcile);
        const scope = operation.resolve();
        if (reconciled.kind !== "settle") {
          throw new Error("Shared file settlement returned an invalid result.");
        }
        if (reconciled.collisionRecordQuarantined) {
          throw new Error(
            "dohc found a damaged shared file recovery record. Refresh shared files. Then send your changes again.",
          );
        }
        assertShareChangesJournalable(reconciled.unjournalablePaths);
        // The engine owns the submit: it reads this replica's own journal, so it
        // has to be the process holding the store.
        const result = await resolveSubmitShareChangesResult(
          reconciled.capturedPaths + reconciled.repairedPaths,
          () =>
            receivedShareEngine.relayFor({
              engineWorkspaceId: scope.workspaceId,
              rootPath: scope.rootPath,
              attachmentId: scope.attachmentId,
              relay: scope.relay,
            }).submitShareProposal({
              shareId: scope.shareId,
              grantedSelector: scope.grant,
              // PR3a mints a fresh key per submit. It makes the relay's idempotency
              // hold for a retry INSIDE one submit (blobs, then the POST), not for
              // a second press: a second press sends whatever is pending then,
              // which is a second set of changes and a second proposal.
              submitId: randomUUID(),
            }),
        );
        operation.assert(scope);
        return result;
      },
    );
  });

  ipcMain.handle(CHANNELS.listMyShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListMyShareChangesPayload.parse(payload);
    // SEEING what was already sent needs membership only: a downgrade must
    // not hide the changes it can no longer add to.
    return withShareProposalRecipientOperation(
      event.sender,
      input.workspaceId,
      requireShareViewMembership,
      async (operation) => {
        const scope = operation.resolve();
        const proposals = await listMyShareProposals({
          relay: scope.relay,
          shareId: scope.shareId,
        });
        operation.assert(scope);
        return ListMyShareChangesResult.parse({
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            state: proposal.state,
            createdAtMs: proposal.createdAtMs,
            files: proposal.ops,
          })),
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.withdrawShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = WithdrawShareChangesPayload.parse(payload);
    // TAKING BACK needs membership only, for the same reason.
    return withShareProposalRecipientOperation(
      event.sender,
      input.workspaceId,
      requireShareViewMembership,
      async (operation) => {
        const scope = operation.resolve();
        const settled = await withdrawShareProposal({
          relay: scope.relay,
          shareId: scope.shareId,
          proposalId: input.proposalId,
        });
        operation.assert(scope);
        if (settled.state !== "withdrawn") {
          // The granter settled it first. Saying "withdrawn" here would tell the
          // recipient their changes are back when the granter already has them.
          throw new Error(
            "Those changes were already answered. Refresh to see the result.",
          );
        }
        return WithdrawShareChangesResult.parse({ state: settled.state });
      },
    );
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
    await mkdir(rootPath, { recursive: true });
    const reservedWorkspaceId = randomUUID();
    const authorityReservation = workspaceAuthorities.reserveBinding({
      workspaceId: reservedWorkspaceId,
      rootPath,
    });
    let created!: CreatedWorkspace;
    let authorityBinding: DesktopWorkspaceAuthorityBinding | null = null;
    try {
      created = await createWorkspaceFolder({
        rootPath,
        kind: "personal",
        workspaceId: reservedWorkspaceId,
        bootstrap: "join",
      });
      authorityBinding = registerReservedPhysicalWorkspace(
        authorityReservation,
        created,
      );
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
      // Before the first pull: a share view that writes back needs its own
      // sync identity, and the pull is what gives it the share cursor that
      // makes local writes journal.
      //
      // SOFT, like the refresh site. Opening a share is a read, and a failure
      // here costs the recipient the ability to send changes, not the ability
      // to open what they were given. The next refresh records it.
      await workspaceAuthorities
        .withBinding(authorityBinding, (lease) =>
          recordShareViewIdentity(canonicalWorkspaceFor(lease)),
        )
        .catch((error) => {
          console.error("[desktop] share view identity:", error);
        });
      const reconciled = await withStaleSensitiveWorkspaceOperation(
        created.rootPath,
        (lease) =>
          shareViewFiles.reconcile(
            lease,
            { kind: "standalone", workspaceId: created.workspaceId },
            "refresh",
          ),
      );
      if (reconciled.kind !== "refresh") {
        throw new Error("Shared view refresh returned an invalid result.");
      }
      const outcome = reconciled.outcome;
      if ("ok" in outcome && !outcome.ok) {
        throw new Error(outcome.errorMessage);
      }
      if (outcome.status === "ended") {
        throw new ShareUnavailableError();
      }
    } catch (error) {
      console.error(`[desktop] open-share rollback for ${rootPath}:`, error);
      try {
        if (authorityBinding) {
          await removePhysicalWorkspace(authorityBinding, () =>
            cleanupFailedPhysicalWorkspace(created.workspaceId, rootPath),
          );
        } else {
          await workspaceAuthorities.releaseReservation(
            authorityReservation,
            () =>
              cleanupFailedPhysicalWorkspace(reservedWorkspaceId, rootPath),
          );
        }
      } catch (cleanupError) {
        console.error("[desktop] open-share rollback cleanup:", cleanupError);
        throw new Error(
          "Couldn't safely roll back the shared view. Its folder was left in place; restart dohc before retrying.",
        );
      }
      refreshNativeWorkspaceSurfaces();
      // Scope-free: the rollback removed a registry entry no window has
      // active yet — every window's workspace list is what changed.
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
    // A share view is opened HERE, not wherever a status read happens to land
    // first (#646 PR3). It needs the activity entry: that entry is what states
    // `historyShareView` to the status bar and the notice center, so the null
    // capture below is explained by a decision this open made.
    //
    // It deliberately gets NO recorder and no cloud engine. Its files are
    // written straight to its engine store by the write path, so a watcher
    // here would only observe writes this process already journaled, and it
    // replicates through its share rather than through a workspace remote.
    //
    // After the refresh, because a failed refresh rolls the whole open back.
    await openWorkspaceActivity(requireWorkspace(created.workspaceId));
    // Scope-free: the open added a registry entry no window has active yet.
    notifyRenderer();
    // Through the PROJECTION, not a raw parse: the level lives under the
    // record's pinned grant, and a raw parse would strip it and hand the
    // renderer a fresh share view with no level to state.
    const summary = workspaceSummaryFor(requireWorkspace(created.workspaceId));
    return OpenSharedViewResult.parse({ workspace: summary });
  });

  ipcMain.handle(CHANNELS.refreshSharedView, async (event, payload) => {
    assertTrustedSender(event);
    const input = RefreshSharedViewPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Shared view refresh stopped because this window changed workspaces.",
      async (operation) => {
        // The shell's on-open auto-refresh can run during the daemon handshake
        // now that the window loads during it; the reconcile needs sessions. The
        // physical operation is already held before this wait begins.
        await engineDaemonStartup;
        operation.assertCurrent();
        const workspace = operation.workspace;
        if (!shareViewIsPresent(workspace.shareView)) {
          throw new Error("This workspace is not a shared view.");
        }
        if (!workspace.shareView) {
          throw new Error(
            "This shared view's record is damaged, so it can't refresh safely. Remove it, then open the share code again.",
          );
        }
        // #646 PR2: the backstop this share's chat push docstring claims. A push
        // that failed — offline, a rotated session, a relay blip — is retried
        // here, before the pull, so a refresh drains the backlog instead of
        // leaving it until the recipient happens to write again.
        // Before the push, because the push needs the identity this writes. A
        // share view opened before #646 PR3-1 has none, and this is where it gains
        // one.
        if (!workspace.shareView.ended) {
          await recordShareViewIdentity(workspace).catch((error) => {
            console.error("[desktop] share view enrolment:", error);
          });
          await pushShareViewChat(workspace).catch((error) => {
            console.error(
              "[desktop] share view chat push (refresh backstop):",
              error,
            );
          });
        }
        let outcome;
        try {
          const reconciled = await withStaleSensitiveWorkspaceOperation(
            workspace.rootPath,
            (lease) =>
              shareViewFiles.reconcile(
                lease,
                { kind: "standalone", workspaceId: workspace.workspaceId },
                "refresh",
              ),
          );
          if (reconciled.kind !== "refresh") {
            throw new Error("Shared view refresh returned an invalid result.");
          }
          outcome = reconciled.outcome;
        } catch (error) {
          operation.assertCurrent();
          // A pull that failed on a later page still persisted the refusals its
          // earlier pages recorded, so the renderer is told once here too.
          notifyRenderer({ workspaceId: workspace.workspaceId });
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
        if ("ok" in outcome && !outcome.ok) {
          operation.assertCurrent();
          notifyRenderer({ workspaceId: workspace.workspaceId });
          return RefreshSharedViewResult.parse(outcome);
        }
        operation.assertCurrent();
        if (outcome.status === "ended") refreshNativeWorkspaceSurfaces();
        notifyRenderer({ workspaceId: workspace.workspaceId });
        return RefreshSharedViewResult.parse(outcome);
      },
    );
  });

  // ---- Share mounts ----
  // The receive side materialized INSIDE a host workspace: the share's
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
      "The Site preview logs request does not target the active workspace. Open the workspace and try again.",
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
      "The Site preview stop request does not target the active workspace. Open the workspace and try again.",
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
                isCurrent: () => {
                  try {
                    operation.assertCurrent();
                    return true;
                  } catch {
                    return false;
                  }
                },
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

  ipcMain.handle(CHANNELS.openWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenWorkspaceRequestPayload.parse(payload);
    return withPhysicalWorkspaceOperation(input.workspaceId, async (operation) => {
      const workspace = operation.workspace;
      const rendererSession = await rendererWorkspaceSessions.open(
        event.sender,
        workspace,
        input.rendererDocumentId,
      );
      preferredWorkspaceId = workspace.workspaceId;
      const status = SyncStatusResult.parse(
        await syncStatusWithOwnedProjection(
          workspace,
          await openWorkspaceActivityForOperation(
            operation,
            {},
            ensureWorkspaceActivityOpen,
          ),
        ),
      );
      operation.assertCurrent();
      if (!rendererSession.isCurrent()) {
        throw new Error(
          "Workspace open stopped because this window changed workspaces.",
        );
      }
      if (!sharedViewOf(workspace.workspaceId)) {
        // A plugin-pipeline start failure must not fail the whole handler —
        // the workspace itself already opened. listPlugins and friends
        // separately convert a failed plugin runtime warmup into a structured
        // pluginIpcError; this is best-effort warmup, and the renderer's file
        // tree must not wait on it (fire-and-forget, like the dispatch scan in
        // openWorkspaceActivityWith).
        void withPhysicalWorkspaceOperation(workspace.workspaceId, (warmup) => {
          if (warmup.workspace.attachmentId !== workspace.attachmentId) return;
          return warmup.state.pluginRuntimes.ensure(warmup.workspace);
        }).catch((error: unknown) => {
          console.error(
            `[desktop] plugin pipeline warmup failed for ${workspace.workspaceId}:`,
            error,
          );
        });
      }
      return status;
    });
  });

  // Named versions (PR 0M-4). Every handler resolves the workspace through
  // requireWorkspace (renderer identity is never trusted) and is gated on the
  // workspace-engine alpha capture being attached — for unflagged workspaces
  // the calls reject.
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
      // #541: the feature's "not enabled" copy holds only for the real
      // opt-out — after a failed capture build the refusal names the failure.
      throw new Error(
        engineOffRefusal(activity.getStatus(workspace.workspaceId), feature, "restart"),
      );
    }
    return { workspace, capture };
  }

  // #646 PR2: chat follows the share. `requireEngineCapture` is the ONE
  // barrier between a share view and chat today, and it throws for every
  // share view because a share view has no capture — by design: a capture
  // records local file writes, which is exactly what a share view must never
  // do. So this resolves a SCOPE instead of widening that gate. A local
  // workspace still goes through `requireEngineCapture` unchanged; a share
  // view gets a narrower scope carrying the level it was granted.
  //
  // A share scope answers PER-FILE chat only. `listChatChannels` and every
  // other workspace-wide surface keeps `requireEngineCapture` and stays
  // refused — filtering a workspace-wide listing is the shape that produced
  // #627, and not routing it is smaller and safer.
  type ChatScope =
    | {
        kind: "workspace";
        workspace: RegistryEntry;
        capture: WorkspaceEngineCapture;
        store: DesktopLinkedChatStore;
      }
    | {
        kind: "share";
        workspace: RegistryEntry & { attachmentId: symbol };
        engineWorkspace: EngineWorkspace;
        store: DesktopLinkedChatStore;
        withAuthority<Result>(work: () => Promise<Result>): Promise<Result>;
        // The pinned level, or null when the stored grant cannot be read.
        // The registry file is DATA, not a contract (see
        // workspaceSummaryProjection.ts), so the level is read through
        // `readableShareLevel` rather than trusted from the record's type.
        access: ShareAccess | null;
        // The account this recipient writes chat under. Absent when signed
        // out, or signed into a relay that is not this share's — see
        // `assertChatWritable`, which refuses rather than writing a comment
        // that can never leave the machine.
        authorUserId: string | undefined;
        // The granter ended this share. The local copy stays readable and
        // stops taking writes, exactly as an ended chat-channel grant does.
        ended: boolean;
      };

  async function requireChatScope(workspaceId: string): Promise<ChatScope> {
    return await workspaceAuthorities.withAuthority(workspaceId, async (lease) => {
      const workspace = canonicalWorkspaceFor(lease);
      // PRESENCE, the same question `sharedViewOf` asks before a write. A
      // marker that lost its value is still a share view, and resolving a
      // CAPTURE for it would give someone else's workspace the local chat
      // surface — the enforcement layer failing open.
      if (!shareViewIsPresent(workspace.shareView)) {
        const local = await requireEngineCapture(workspaceId, "Chats");
        lease.assertCurrent();
        return {
          kind: "workspace",
          workspace: local.workspace,
          capture: local.capture,
          store: linkedChatStoreFor(lease),
        };
      }
      // Idempotent, and the same guarantee requireEngineCapture makes: the
      // workspace's daemon session is live before any store call reaches it.
      await openWorkspaceActivity(workspace);
      lease.assertCurrent();
      await warmCredentialCache();
      lease.assertCurrent();
      const binding = lease.binding;
      const engineWorkspace = receivedShareEngine.workspaceFor({
        engineWorkspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        attachmentId: binding.attachmentId,
      });
      return {
        kind: "share",
        workspace,
        engineWorkspace,
        store: linkedChatStoreFor(lease),
        withAuthority: (work) =>
          workspaceAuthorities.withBinding(binding, () => work()),
        // The level the PINNED grant names, or null when the grant cannot be
        // read completely. Read through the same function the refresh path
        // uses, so this gate and the pull cannot disagree about what a share
        // grants.
        access: readableShareLevel(workspace.shareView?.grantedSelector),
        ended: workspace.shareView?.ended === true,
        authorUserId: resolveShareViewRelayAuthorId(
          workspace.shareView ?? {},
          cachedCredentials,
        ),
      };
    });
  }

  // The chat write gate, run BEFORE any durable row. A view share reads the
  // discussion about its files and adds nothing to it; comment and edit both
  // write. The relay refuses the push again with the same words, so the
  // renderer disabling its composer is honesty, not authorization.
  // A local workspace is writable by definition; a share view answers to the
  // shared rule, which the tests drive directly rather than re-implementing.
  function assertChatWritable(scope: ChatScope): void {
    if (scope.kind !== "share") return;
    assertShareChatWritable(scope);
  }

  // #646 PR2: this recipient's own chat, back to the granter — the file-share
  // mirror of `syncSharedChannelsForChatTarget`. Fire-and-forget from a write
  // handler, with the share's refresh cadence as the backstop, and skipped
  // whenever a refresh would be skipped: an ended share, a signed-out user, or
  // a session on a relay that is not this share's origin.
  // #646 PR3-1: give this share view the sync identity its share lane needs,
  // before the first pull or push. Without it the share view journals no local
  // write and every push refuses before the relay is contacted.
  //
  // Run at open and again at every refresh. The engine writes the row once, so
  // a refresh costs one call and changes nothing.
  //
  // Skipped — never thrown — for the same reasons a refresh is skipped: a
  // damaged pin, an ended share, no credentials, or a session on a relay that
  // is not this share's origin. A `view` share is skipped as well: it may push
  // nothing, so it needs no identity and must not be given one.
  async function recordShareViewIdentity(
    workspace: RegistryEntry & { attachmentId: symbol },
  ): Promise<void> {
    await warmCredentialCache();
    const credentials = cachedCredentials;
    const grantedSelector = shareViewIdentitySelector({
      shareView: workspace.shareView,
      relayUrl: credentials?.relayUrl,
      relayUrlsMatch,
    });
    if (!grantedSelector || !credentials?.relayUrl) return;
    await receivedShareEngine.relayFor({
      engineWorkspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      attachmentId: workspace.attachmentId,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }).recordShareViewIdentity({ grantedSelector });
  }

  async function pushShareViewChat(
    workspace: RegistryEntry & { attachmentId: symbol },
  ): Promise<void> {
    const shareView = workspace.shareView;
    if (!shareView || shareView.ended) return;
    // The pinned grant, read back through the rule the pull uses. A grant this
    // process cannot read completely is not one to push through: the engine
    // scopes the push by it, and the relay judges the batch against the stored
    // selector either way. Skipped, not failed — a write that reached this far
    // was already refused if the level was unreadable.
    const grantedSelector = recordedShareSelector(shareView.grantedSelector);
    if (!grantedSelector) return;
    // Positive recognition of a level that may write, before anything reaches
    // the engine. A `view` share pushes nothing, and letting it try produced a
    // refusal in the log that read like a defect and was not one.
    if (grantedSelector.access !== "comment" && grantedSelector.access !== "edit") {
      return;
    }
    await warmCredentialCache();
    const credentials = cachedCredentials;
    if (!credentials?.relayUrl) return;
    if (shareView.relayUrl && !relayUrlsMatch(credentials.relayUrl, shareView.relayUrl)) {
      return;
    }
    await receivedShareEngine.relayFor({
      engineWorkspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      attachmentId: workspace.attachmentId,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }).pushShareView({ shareId: shareView.shareId, grantedSelector });
  }

  // Every chat write reaches the granter the same way, whichever scope it was
  // written in: a local workspace nudges its own cloud sync and any joined
  // shared channel, a share view pushes its own chat lane.
  function syncChatWriteFor(scope: ChatScope, target: { threadId: string }): void {
    if (scope.kind === "share") {
      void scope
        .withAuthority(() => pushShareViewChat(scope.workspace))
        .catch((error) => {
          console.error("[desktop] share view chat push:", error);
        });
      return;
    }
    void syncSharedChannelsForChatTarget(scope.workspace.workspaceId, target);
    activity.queueCloudSync(scope.workspace.workspaceId);
  }

  // The file a chat is about, resolved for either scope. A share view has no
  // capture to ask, so it asks the engine's own file index — the same index
  // the mentions path already reads, over files that arrived by replay.
  async function chatFileObjectId(scope: ChatScope, path: string): Promise<string | null> {
    if (scope.kind === "workspace") return await scope.capture.fileObjectIdForPath(path);
    const index = await scope.withAuthority(
      async () => await activeEngineFileIndex(scope.engineWorkspace),
    );
    return index.objectIdByPath.get(path) ?? null;
  }

  async function requireVersionOperations(workspaceId: string) {
    const { capture } = await requireEngineCapture(
      workspaceId,
      "Versions",
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
    const input = WorkspaceIdPayload.parse(payload);
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
    notifyRenderer({ workspaceId: input.workspaceId });
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
    notifyRenderer({ workspaceId: input.workspaceId });
    return SwitchWorkspaceVersionResult.parse(result);
  });

  ipcMain.handle(CHANNELS.compareWorkspaceVersions, async (event, payload) => {
    assertTrustedSender(event);
    const input = CompareWorkspaceVersionsPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const page = await capture.compareVersions(input.versionId, {
      ...(input.afterPath !== undefined ? { afterPath: input.afterPath } : {}),
    });
    return CompareWorkspaceVersionsResult.parse(page);
  });

  ipcMain.handle(CHANNELS.mergeWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = MergeWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const result = await capture.mergeVersionIntoMain(input.versionId);
    notifyRenderer({ workspaceId: input.workspaceId });
    // The merge reports a count; the rows are open conflicts in the engine,
    // read back one page at a time like every other conflict reader (#562).
    const page =
      result.conflictCount > 0
        ? await capture.listOpenConflictsPage()
        : { conflicts: [], nextAfterConflictId: null };
    return MergeWorkspaceVersionResult.parse({
      mergedFileCount: result.mergedFileCount,
      unchangedFileCount: result.unchangedFileCount,
      conflictCount: result.conflictCount,
      conflicts: page.conflicts.map(versionConflictForIpc),
      nextAfterConflictId: page.nextAfterConflictId,
    });
  });

  ipcMain.handle(CHANNELS.listWorkspaceVersionConflicts, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceVersionConflictsPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const page = await capture.listOpenConflictsPage(input.afterConflictId);
    return ListWorkspaceVersionConflictsResult.parse({
      conflicts: page.conflicts.map(versionConflictForIpc),
      nextAfterConflictId: page.nextAfterConflictId,
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
      notifyRenderer({ workspaceId: input.workspaceId });
      return ResolveWorkspaceVersionConflictResult.parse({
        conflicts: outcome.remaining.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: outcome.remaining.nextAfterConflictId,
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
    const input = WorkspaceIdPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return TryInVersionStateResult.parse({
      state: tryInVersionSessions.snapshot(input.workspaceId),
    });
  });

  ipcMain.handle(CHANNELS.dismissTryInVersionReview, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
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
    // The path resolver, not a capture: a share view has no capture and its
    // files still resolve (#646 PR2). Everything below only ever asked the
    // capture this one question.
    fileObjectIdForPath: (path: string) => Promise<string | null>,
    references: readonly ChatFileReferenceInput[] | undefined,
  ) {
    const resolved: Array<{
      objectId: Awaited<ReturnType<WorkspaceEngineCapture["fileObjectIdForPath"]>
      > & string;
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
        fileObjectIdForPath,
      );
      if (!trackedFile) {
        throw new Error(`Cannot mention ${reference.path} because dohc is not tracking it yet.`);
      }
      const { objectId, path: resolvedPath } = trackedFile;
      if (!reference.headingAnchor) {
        resolved.push({ objectId, pathHint: resolvedPath });
        continue;
      }
      const source = await readOwnedWorkspaceText(workspace, resolvedPath);
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
  async function withChatBookmarkRun<T>(
    workspaceId: string,
    bookmarkId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const lease = requireWorkspaceAuthority(workspaceId);
    const runs = lease.state.chatBookmarkRuns;
    const previous = runs.get(bookmarkId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        lease.assertCurrent();
        const value = await run();
        lease.assertCurrent();
        return value;
      });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    runs.set(bookmarkId, settled);
    try {
      return await result;
    } finally {
      if (runs.get(bookmarkId) === settled) runs.delete(bookmarkId);
      lease.release();
    }
  }

  async function materializeChatBookmark(
    workspace: ReturnType<typeof requireWorkspace>,
    capture: WorkspaceEngineCapture,
    bookmark: ChatBookmark,
  ): Promise<ChatBookmark> {
    return withChatBookmarkRun(
      workspace.workspaceId,
      bookmark.bookmarkId,
      async () => {
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
          const threads = await store.listThreads({
            workspaceId: workspace.workspaceId,
          });
          const thread = threads.find(
            (entry) => entry.id === bookmark.threadId,
          );
          if (!thread) throw new Error("The source chat no longer exists.");
          const allMessages = await store.listMessages({
            workspaceId: workspace.workspaceId,
            threadId: bookmark.threadId,
          });
          let selectedMessages = allMessages;
          if (bookmark.messageId) {
            const selected = allMessages.find(
              (message) => message.id === bookmark.messageId,
            );
            if (!selected)
              throw new Error("The bookmarked message no longer exists.");
            const parent = selected.parentMessageId
              ? allMessages.find(
                  (message) => message.id === selected.parentMessageId,
                )
              : undefined;
            selectedMessages = parent ? [parent, selected] : [selected];
          }
          const channel = thread.channelId
            ? (
                await store.listChannels({ workspaceId: workspace.workspaceId })
              ).find((entry) => entry.id === thread.channelId)
            : undefined;
          const text = formatChatBookmarkProjection({
            bookmarkId: bookmark.bookmarkId,
            threadId: bookmark.threadId,
            ...(bookmark.messageId ? { messageId: bookmark.messageId } : {}),
            ...(channel
              ? { channelId: channel.id, channelName: channel.name }
              : {}),
            title: thread.title,
            mode: bookmark.mode,
            updatedAtMs: Date.now(),
            ...(bookmark.mode === "snapshot"
              ? { snapshotAtMs: bookmark.createdAtMs }
              : {}),
            messages: selectedMessages.map((message) => ({
              id: message.id,
              authorKind: message.author.kind,
              authorDisplayName: message.author.displayName,
              body: message.body,
              createdAtMs: message.createdAtMs,
              ...(message.parentMessageId
                ? { parentMessageId: message.parentMessageId }
                : {}),
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
            failureReason:
              error instanceof Error ? error.message : "Projection failed",
          });
          throw new Error(
            failed.bookmark.failureReason ?? "Could not save chat bookmark.",
          );
        }
      },
    );
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
      await materializeChatBookmark(workspace, capture, bookmark).catch(
        (error) => {
          console.error("[desktop] chat bookmark projection:", error);
          // Re-flag so the worker's next tick retries. If markBookmarkFailed
          // itself failed, the row is still pending and this is the only retry
          // path; if it succeeded, the row left listPendingBookmarks and the
          // extra pass finds nothing — no permanent-failure loop.
          queueChatBookmarkProjection(workspace.workspaceId);
        },
      );
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
      "Engine history",
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
      protectedTruncated: page.protectedTruncated,
    });
  });

  ipcMain.handle(CHANNELS.readEngineMoment, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadEngineMomentPayload.parse(payload);
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Engine history",
    );
    const moment = await capture.readMoment(input.momentId);
    return ReadEngineMomentResult.parse({
      moment: moment
        ? engineMomentDetailForIpc(moment, agentAuthorDisplayName)
        : null,
    });
  });

  ipcMain.handle(CHANNELS.restoreEngineMomentFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = RestoreEngineMomentFilePayload.parse(payload);
    const { capture } = await requireEngineCapture(
      input.workspaceId,
      "Engine history",
    );
    const result = await capture.restoreFileToBeforeMoment(input.momentId);
    notifyRenderer({ workspaceId: input.workspaceId });
    return RestoreEngineMomentFileResult.parse(result);
  });

  ipcMain.handle(CHANNELS.listFileChats, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListFileChatsPayload.parse(payload);
    // #646 PR2: reachable from a share view at EVERY level. The file it names
    // is one the share already served, and an out-of-selector thread was
    // never served by the relay nor applied by the engine boundary — there is
    // no superset here to filter.
    const scope = await requireChatScope(input.workspaceId);
    const { workspace, store } = scope;
    const fileObjectId = await chatFileObjectId(scope, input.path);
    const threads = fileObjectId
      ? await store.listThreadsForFile({
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
      "Chats",
    );
    const rowsUncovered = await syncWorkspaceSharedChannels(
      workspace.workspaceId,
    );
    const objectId = await capture.fileObjectIdForPath(input.path);
    const store = linkedChatStoreFor(workspace);
    const mentions = await store.listFileMentions({
      workspaceId: workspace.workspaceId,
      ...(objectId ? { objectId } : { pathHint: input.path }),
    });
    const activeFiles = await activeEngineFileIndex(workspace);
    const mentionChannelWireIds = new Map(
      await Promise.all(
        [
          ...new Set(
            mentions.flatMap((mention) =>
              mention.channel ? [mention.channel.id] : [],
            ),
          ),
        ].map(
          async (channelId) =>
            [
              channelId,
              await store.getChannelWireId({
                workspaceId: workspace.workspaceId,
                channelId,
              }),
            ] as const,
        ),
      ),
    );
    return ListChatFileMentionsResult.parse({
      ...(rowsUncovered > 0
        ? { sharedChannelRowsUncovered: rowsUncovered }
        : {}),
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
        return [
          {
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
                    ? {
                        channelWireId: mentionChannelWireIds.get(
                          mention.channel.id,
                        )!,
                      }
                    : {}),
                  channelName: mention.channel.name,
                  channelSlug: mention.channel.slug,
                  channelKind: mention.channel.kind,
                }
              : {}),
          },
        ];
      }),
    });
  });

  ipcMain.handle(CHANNELS.listChatBookmarks, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatBookmarksPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
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
      "Chats",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const threads = await store.listThreads({
      workspaceId: workspace.workspaceId,
    });
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
    notifyRenderer({ workspaceId: workspace.workspaceId });
    return SaveChatBookmarkResult.parse({
      bookmark: chatBookmarkForIpc(bookmark),
    });
  });

  ipcMain.handle(CHANNELS.archiveChatBookmark, async (event, payload) => {
    assertTrustedSender(event);
    const input = ArchiveChatBookmarkPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
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
    const projected = await materializeChatBookmark(
      workspace,
      capture,
      archived,
    );
    notifyRenderer({ workspaceId: workspace.workspaceId });
    return ArchiveChatBookmarkResult.parse({
      bookmark: chatBookmarkForIpc(projected),
    });
  });

  ipcMain.handle(CHANNELS.createFileChat, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateFileChatPayload.parse(payload);
    // #646 PR2: reachable from a share view at comment and edit. The level is
    // the server-side decision main owns; the relay refuses the push again
    // with the same words if this one is ever skipped.
    const scope = await requireChatScope(input.workspaceId);
    assertChatWritable(scope);
    const { workspace, store } = scope;
    // The chat links to the file's STABLE engine object id (never the path),
    // so the link survives renames; the path rides along as a display hint.
    const fileObjectId = await chatFileObjectId(scope, input.path);
    if (!fileObjectId) {
      throw new Error(
        "Chats aren't available for this file yet — only text files dohc tracks can have Chats.",
      );
    }
    const thread = await store.createThread({
      workspaceId: workspace.workspaceId,
      title: input.title,
      linkedFile: { objectId: fileObjectId, pathHint: input.path },
    });
    syncChatWriteFor(scope, { threadId: thread.id });
    return CreateFileChatResult.parse({ thread: chatThreadForIpc(thread) });
  });

  ipcMain.handle(CHANNELS.listChatMessages, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatMessagesPayload.parse(payload);
    // Reachable from a share view at every level (#646 PR2), for a thread on
    // a file the share already served.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const messages = await store.listMessages({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return ListChatMessagesResult.parse({
      messages: messages.map(chatMessageForIpc),
    });
  });

  ipcMain.handle(CHANNELS.getChatThreadRevision, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetChatThreadRevisionPayload.parse(payload);
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const revision = await store.getThreadRevision({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return GetChatThreadRevisionResult.parse({ revision });
  });

  ipcMain.handle(CHANNELS.sendChatMessage, async (event, payload) => {
    assertTrustedSender(event);
    const input = SendChatMessagePayload.parse(payload);
    // #646 PR2: a share view resolves a scope instead of a capture, and its
    // LEVEL is the write gate. A local workspace still resolves a capture and
    // is writable by definition — `assertWritableWorkspace` refused exactly
    // the share views this scope now admits at comment and edit.
    const scope = await requireChatScope(input.workspaceId);
    assertChatWritable(scope);
    const { workspace, store } = scope;
    // MU-C4 (CodeRabbit security): a READ-ONLY shared-channel grant rejects
    // writes at the main boundary, BEFORE any durable local row — the
    // renderer disabling its composer is honesty, not authorization.
    await assertSharedChannelWritable({
      workspaceId: workspace.workspaceId,
      sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
      store,
      target: { threadId: input.threadId },
    });
    // Resolve one relay-scoped identity before attachments or any durable
    // write. Shared channels require it; local history may omit it.
    const target = { threadId: input.threadId };
    const message = await writeChatMessageFromMain({
      resolveAuthorUserId: () =>
        verifiedChatAuthorUserIdFor(workspace.workspaceId, target, store),
      resolveAttachments: () =>
        resolveChatFileReferences(
          workspace,
          (path) => chatFileObjectId(scope, path),
          input.fileReferences,
        ),
      revalidateAuthorUserId: (authorUserId) =>
        revalidateChatWrite(workspace, target, authorUserId, store),
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
    // Bookmarks and agent dispatch are LOCAL projections of a workspace this
    // machine owns. A share view owns neither: it has no capture to project
    // into, and an agent dispatched from someone else's shared file would be
    // this machine acting on a workspace it only reads.
    if (scope.kind === "workspace") {
      void materializePendingChatBookmarks(workspace, scope.capture).catch((error) => {
        console.error("[desktop] chat bookmark projection:", error);
        queueChatBookmarkProjection(workspace.workspaceId);
      });
      void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
        console.error("[desktop] local chat dispatch scan:", error);
      });
    }
    // MU-C4: if this thread lives in a joined shared channel, push it out
    // promptly (fire-and-forget; the sync cadence is the backstop). A share
    // view pushes its own chat lane instead (#646 PR2).
    syncChatWriteFor(scope, { threadId: input.threadId });
    return SendChatMessageResult.parse({ message: chatMessageForIpc(message) });
  });

  ipcMain.handle(CHANNELS.listChatThreadDecisions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatThreadDecisionsPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
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
    // #646 PR2: reachable from a share view at comment and edit.
    const scope = await requireChatScope(input.workspaceId);
    assertChatWritable(scope);
    const { workspace, store } = scope;
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
    syncChatWriteFor(scope, { threadId: input.threadId });
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
      "Chats",
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
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Chats stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        // MU-C4: refresh joined shared channels BEFORE reading, so opening
        // Chats shows other members' latest messages. Offline, local rows
        // still answer.
        const rowsUncovered =
          await syncRendererWorkspaceSharedChannels(operation);
        operation.assertCurrent();
        const store = linkedChatStoreFor(workspace);
        // First chat use auto-creates General.
        await store.ensureGeneralChannel({
          workspaceId: workspace.workspaceId,
        });
        operation.assertCurrent();
        const channels = await store.listChannels({
          workspaceId: workspace.workspaceId,
        });
        operation.assertCurrent();
        // Wire identities let the renderer match channels against share grants.
        const wireIdEntries = await Promise.all(
          channels.map(async (channel) => [
            channel.id,
            await store
              .getChannelWireId({
                workspaceId: workspace.workspaceId,
                channelId: channel.id,
              })
              .catch(() => null),
          ] as const),
        );
        operation.assertCurrent();
        const wireIds = new Map(wireIdEntries);
        // The "Files" grouping: file-linked Chats with their CURRENT path (the
        // stable object id resolved through the active version), falling back
        // to the captured hint when the engine no longer owns the file.
        const threads = await store.listThreads({
          workspaceId: workspace.workspaceId,
        });
        operation.assertCurrent();
        const fileThreads = threads.filter((thread) => thread.linkedFile);
        let pathByObjectId = new Map<string, string>();
        if (fileThreads.length > 0) {
          try {
            ({ pathByObjectId } = await activeEngineFileIndex(workspace));
          } catch {
            // Path resolution is display-only; the hint fallback keeps the
            // listing honest enough.
          }
          operation.assertCurrent();
        }
        return ListChatChannelsResult.parse({
          ...(rowsUncovered > 0
            ? { sharedChannelRowsUncovered: rowsUncovered }
            : {}),
          channels: channels.map((channel) => ({
            ...chatChannelForIpc(channel),
            wireId: wireIds.get(channel.id) ?? null,
          })),
          fileThreads: fileThreads.map((thread) => ({
            ...chatThreadForIpc(thread),
            path:
              (thread.linkedFile
                ? (pathByObjectId.get(thread.linkedFile.objectId) ??
                  thread.linkedFile.pathHint)
                : undefined) ?? null,
          })),
        });
      },
    );
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
      "Chats",
    );
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const ownerUserId = localUserId();
    await store.ensureDefaultChannelFollows({
      workspaceId: workspace.workspaceId,
      ownerUserId,
    });
    const follows = await store.listFollows({
      workspaceId: workspace.workspaceId,
      ownerUserId,
    });
    return ListChatFollowsResult.parse({ follows: follows.map(chatFollowForIpc) });
  });

  ipcMain.handle(CHANNELS.setChatFollow, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetChatFollowPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
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
    notifyRenderer({ workspaceId: workspace.workspaceId });
    return SetChatFollowResult.parse({ follow: chatFollowForIpc(follow) });
  });

  ipcMain.handle(CHANNELS.listPersonalChatFeed, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListPersonalChatFeedPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const rowsUncovered = await syncWorkspaceSharedChannels(workspace.workspaceId);
    const store = linkedChatStoreFor(workspace);
    const ownerUserId = localUserId();
    await store.ensureDefaultChannelFollows({
      workspaceId: workspace.workspaceId,
      ownerUserId,
    });
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
      ...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),
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

  ipcMain.handle(CHANNELS.markPersonalChatFeedSeen, async (event, payload) => {
    assertTrustedSender(event);
    const input = MarkPersonalChatFeedSeenPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
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
  });

  ipcMain.handle(
    CHANNELS.createChatChannel,
    createChatChannelIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => CreateChatChannelPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats"),
      assertWritable: ({ workspace }) => assertWritableWorkspace(workspace),
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
      "Chats",
    );
    const localFallbackAuthorId = localReactorFallbackId();
    const store = linkedChatStoreFor(workspace);
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId,
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            channelId: input.channelId,
          }, store)
        ).authorUserId,
    });
    // MU-C4: refresh before reading, the way listChatChannels does. A channel
    // view has no poll of its own, and the pass is bounded, so an untargeted
    // sync could leave the channel the user just opened waiting for the
    // rotation. Naming it puts it in THIS pass (#718).
    await syncSharedChannelsForChatTarget(workspace.workspaceId, {
      channelId: input.channelId,
    });
    const threads = await store.listChannelThreads({
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
      "Chats",
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
        verifiedChatAuthorUserIdFor(workspace.workspaceId, target, store),
      resolveAttachments: () =>
        resolveChatFileReferences(workspace, capture.fileObjectIdForPath, input.fileReferences),
      revalidateAuthorUserId: (authorUserId) =>
        revalidateChatWrite(workspace, target, authorUserId, store),
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
      queueChatBookmarkProjection(workspace.workspaceId);
    });
    void syncSharedChannelsForChatTarget(workspace.workspaceId, {
      channelId: input.channelId,
    });
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
      viewerAuthorId:
        started.message.authorUserId ?? localReactorFallbackId(),
    });
  });

  ipcMain.handle(
    CHANNELS.markChatThreadRead,
    createMarkChatThreadReadIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => MarkChatThreadReadPayload.parse(payload),
      // #646 PR2: reachable from a share view at EVERY level, view included.
      requireContext: requireChatScope,
      run: async ({ workspace, store }, input) => {
        const state = await store.markThreadRead({
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
    // #646 PR2: reachable from a share view at EVERY level. The panel loads
    // messages and reactions together, so a capture gate here refuses the
    // whole thread open, not just its reactions.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId: localReactorFallbackId(),
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            threadId: input.threadId,
          }, store)
        ).authorUserId,
    });
    const reactions = await store.listReactions({
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
      // #646 PR2: reachable from a share view at comment and edit.
      requireContext: requireChatScope,
      assertWritable: assertChatWritable,
      run: async (scope, input) => {
        const { workspace, store } = scope;
        await warmCredentialCache();
        const target = { threadId: input.threadId };
        // MU-C4 (CodeRabbit security): reactions are writes too — a read-only
        // shared channel rejects them before any durable row.
        await assertSharedChannelWritable({
          workspaceId: workspace.workspaceId,
          sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,
          store,
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
            verifiedChatAuthorUserIdFor(workspace.workspaceId, target, store),
          revalidateReplicationAuthorId: (authorUserId) =>
            revalidateChatWrite(workspace, target, authorUserId, store),
          listReactions: () =>
            store.listReactions({
              workspaceId: workspace.workspaceId,
              threadId: input.threadId,
            }),
          setReaction: (mutation) => store.setReaction(mutation),
          state: input.state,
        });
        // #646 PR2: a reaction is a pushable share kind, so a share scope
        // pushes its own lane here. The joined-channel and cloud-sync nudges
        // below are inert without an engine capture.
        syncChatWriteFor(scope, { threadId: input.threadId });
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
  // shows nothing. Authorization lives at the relay. This layer lists
  // requests, accepts them into a workspace, and displays established DMs.

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

  // The account-level declined-request file spans every workspace. Accepted
  // DMs live only in the chosen workspace's shared-channel registry.
  function dmRequestFile(): string {
    return join(stateDir(), "dohc-dm-requests.json");
  }

  // Peek a received chat-channel grant's kind without mutating the local store.
  // The share-log GET paginates raw rows before the
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

  // Reconcile DM state with the relay and return the workspace's DM list.
  // Called by the renderer on Chats mount + a gentle poll while visible; the
  // network part degrades silently offline (local list still serves).
  ipcMain.handle(CHANNELS.syncDms, async (event, payload) => {
    assertTrustedSender(event);
    const input = SyncDmsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Chats stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        await warmCredentialCache();
        operation.assertCurrent();
        const syncCredentials = cachedCredentials;
        const syncCredentialGeneration = credentialCacheGeneration;
        const assertCurrentDmSyncSession = (): void => {
          operation.assertCurrent();
          if (credentialCacheGeneration !== syncCredentialGeneration) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        };
        const relay = syncCredentials?.relayUrl
          ? {
              baseUrl: normalizeServerUrl(syncCredentials.relayUrl),
              token: syncCredentials.token,
              fetch: relayFetchWithTimeout(
                SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS,
              ),
            }
          : null;
        const store = linkedChatStoreFor(workspace);
        const { pending, declined } =
          await classifyDmRequestsWithFallback({
            workspaceId: workspace.workspaceId,
            cache: operation.state.lastKnownDmRequestLanes,
            // The cache belongs to this physical attachment. The credential
            // generation guard also prevents an old account's in-flight
            // classify from repopulating it after a session transition.
            credentialGeneration: () => credentialCacheGeneration,
            classify: async () => {
              if (!relay || !syncCredentials) {
                throw new Error("DM sync is unavailable: not signed in.");
              }
              assertCurrentDmSyncSession();
              const listing = await relayShareJsonWithCredentials<{
                received?: Array<{
                  shareId?: unknown;
                  granterEmail?: unknown;
                  selector?: { kind?: unknown; channelWireId?: unknown };
                }>;
              }>(syncCredentials, "/sync/shares");
              assertCurrentDmSyncSession();
              // Re-derived on EVERY call, not a snapshot taken once:
              // classifyDmRequests calls this twice around its async peek.
              return classifyDmRequests({
                received: listing.received ?? [],
                kindCache: peekedReceivedGrantKinds,
                peekKind: async (shareId) => {
                  assertCurrentDmSyncSession();
                  const kind = await peekReceivedGrantKindForShare(
                    relay,
                    shareId,
                  );
                  assertCurrentDmSyncSession();
                  return kind;
                },
                holdersByShareId: () => {
                  assertCurrentDmSyncSession();
                  return liveSharedChannelHoldersByShareId(listWorkspaces());
                },
                holdersByWireId: () => {
                  assertCurrentDmSyncSession();
                  return liveSharedChannelHoldersByWireId(listWorkspaces());
                },
                declinedShareIds: readDeclinedDms(dmRequestFile()),
              });
            },
          });
        assertCurrentDmSyncSession();
        if (relay) {
          try {
            // Push the member's local ops, pull everyone else's, for the joined
            // DMs (and other shared channels) this bounded pass reaches.
            await syncRendererSharedChannelsForChatTarget(
              operation,
              input.openChannelId
                ? { channelId: input.openChannelId }
                : undefined,
            );
            assertCurrentDmSyncSession();
            // The cloud engine owns its work after this request queues it. Do
            // not extend the renderer operation into that durable process.
            activity.queueCloudSync(workspace.workspaceId);
          } catch (error) {
            assertCurrentDmSyncSession();
            // Offline degradation: the local DM list still serves and the next
            // pass retries.
            console.error(
              `[desktop] DM sync failed for ${workspace.rootPath}:`,
              error,
            );
          }
        }
        assertCurrentDmSyncSession();
        const dms = await listDmRecords({
          workspaceId: workspace.workspaceId,
          store,
          sharedChannels: operation.workspace.sharedChannels ?? [],
        });
        assertCurrentDmSyncSession();
        const requestShareIds = new Set(
          [...pending, ...declined].map((row) => row.shareId),
        );
        // Fresh, AFTER classify resolves — not reused from before it, which
        // could be stale by the time the withhold decision needs it.
        const holdersByShareId = liveSharedChannelHoldersByShareId(
          listWorkspaces(),
        );
        const holdersByWireId = liveSharedChannelHoldersByWireId(
          listWorkspaces(),
        );
        return SyncDmsResult.parse({
          available: relay !== null,
          dms: withholdDmsInRequestLanes({
            dms,
            requestShareIds,
            holdersByShareId,
            holdersByWireId,
            workspaceId: workspace.workspaceId,
          }).map(dmRecordForIpc),
          pending,
          declined,
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.acceptDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = AcceptDmPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Accepting stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        if (shareViewIsPresent(workspace.shareView)) {
          throw new Error(
            "Shared views are read-only — add this conversation to a workspace you own.",
          );
        }

        assertShareNotHeldElsewhere(input.shareId, workspace.workspaceId);
        const acceptedHere = isShareAcceptedInWorkspace(
          workspace.sharedChannels ?? [],
          input.shareId,
        );
        if (!acceptedHere) {
          if (peekedReceivedGrantKinds.get(input.shareId) !== "dm") {
            throw new Error(
              "dohc could not find that message request. Wait for Chats to refresh, then try again.",
            );
          }
          await warmCredentialCache();
          operation.assertCurrent();
          const acceptCredentials = cachedCredentials;
          const acceptCredentialGeneration = credentialCacheGeneration;
          if (!acceptCredentials) throw new Error("Sign in to dohc Cloud first.");
          if (!acceptCredentials.relayUrl) {
            throw new Error(
              "Reconnect dohc Cloud with a sync relay URL, then try again.",
            );
          }
          const acceptedRelayUrl = acceptCredentials.relayUrl;
          const assertCurrentAcceptSession = (): void => {
            operation.assertCurrent();
            if (credentialCacheGeneration !== acceptCredentialGeneration) {
              throw new Error("Your dohc Cloud session changed. Try again.");
            }
          };
          const relay = {
            baseUrl: normalizeServerUrl(acceptedRelayUrl),
            token: acceptCredentials.token,
            fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
          };
          // Two open Chats views can accept the same account-wide request
          // concurrently; only the first may reserve it.
          assertShareNotHeldElsewhere(input.shareId, workspace.workspaceId);
          try {
            await reserveAndPullSharedChannelForWorkspace({
              operation,
              assertCurrent: assertCurrentAcceptSession,
              relay,
              shareId: input.shareId,
              recipientUserId: acceptCredentials.userId,
              relayUrl: acceptedRelayUrl,
              preWrite: (info) => {
                assertCurrentAcceptSession();
                assertShareNotHeldElsewhere(
                  input.shareId,
                  workspace.workspaceId,
                  info.channelWireId,
                );
              },
            });
            assertCurrentAcceptSession();
          } catch (error) {
            assertCurrentAcceptSession();
            if (error instanceof ShareUnavailableError) {
              throw new Error(
                "That conversation isn't available anymore. Ask the sender to message you again.",
              );
            }
            // The reservation row is the write gate. Once it exists, a pull
            // failure is not an accept failure; the local DM check below tells
            // whether enough data landed to open the conversation.
            if (
              !isShareAcceptedInWorkspace(
                operation.workspace.sharedChannels ?? [],
                input.shareId,
              )
            ) {
              throw error;
            }
          }
        }

        operation.assertCurrent();
        // Acceptance succeeded, so obsolete decline-marker cleanup is
        // best-effort. It is account-scoped and owns no workspace authority.
        void clearDeclinedDm(dmRequestFile(), input.shareId);
        const dm = (
          await listDmRecords({
            workspaceId: workspace.workspaceId,
            store: linkedChatStoreFor(workspace),
            sharedChannels: operation.workspace.sharedChannels ?? [],
          })
        ).find((record) => record.shareId === input.shareId);
        operation.assertCurrent();
        if (!dm) {
          throw new Error(
            "dohc added the conversation but could not open it. Open it from Direct messages.",
          );
        }
        return AcceptDmResult.parse({ dm: dmRecordForIpc(dm) });
      },
    );
  });

  ipcMain.handle(CHANNELS.declineDm, (event, payload) => {
    assertTrustedSender(event);
    const input = DeclineDmPayload.parse(payload);
    if (!declineDm(dmRequestFile(), input.shareId)) {
      throw new Error("dohc could not save this choice. Try again.");
    }
    return undefined;
  });

  ipcMain.handle(CHANNELS.requestDmAgain, (event, payload) => {
    assertTrustedSender(event);
    const input = RequestDmAgainPayload.parse(payload);
    if (!clearDeclinedDm(dmRequestFile(), input.shareId)) {
      throw new Error("dohc could not save this choice. Try again.");
    }
    return undefined;
  });

  // The DM surface's reverse path for placement (#742): ends the SAME row
  // leaveSharedChannel ends. The next syncDms poll's classifyDmRequests finds
  // no live holder for this shareId, so the conversation reappears as a
  // request and can be accepted into any workspace, including this one.
  ipcMain.handle(CHANNELS.leaveDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveDmPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Leaving stopped because this window changed workspaces.",
      (operation) => {
        const workspace = operation.workspace;
        const leftRow = (workspace.sharedChannels ?? []).find(
          (channel) => channel.shareId === input.shareId,
        );
        endWorkspaceJoinedChannel(operation, input.shareId);
        operation.assertCurrent();
        // The leave is locally knowable without the relay. Keep this physical
        // attachment's fallback lanes consistent with the registry write.
        markLeftInLastKnownLanes(
          operation.state.lastKnownDmRequestLanes,
          workspace.workspaceId,
          {
            shareId: input.shareId,
            granterEmail: leftRow?.granterEmail ?? null,
          },
        );
        return undefined;
      },
    );
  });

  // Start (or continue) a DM: dedupe by recipient set, ensure one live grant
  // per recipient, and send the first message into the single running thread.
  ipcMain.handle(CHANNELS.startDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartDmPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Starting a direct message stopped because this window changed workspaces.",
      async (operation) => {
        // A DM needs the full collaboration surface: a signed-in relay session
        // and a synced workspace. The exact operation supplies the canonical
        // physical root used by both the local engine and relay work.
        const workspace = operation.workspace;
        assertWritableWorkspace(workspace);
        const { credentials, credentialGeneration } =
          await remoteForWorkspace(workspace);
        operation.assertCurrent();
        function assertCurrentDmSession(): void {
          operation.assertCurrent();
          if (credentialCacheGeneration !== credentialGeneration) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        }
        async function awaitCurrentDmSession<Result>(
          run: () => Promise<Result>,
        ): Promise<Result> {
          assertCurrentDmSession();
          const result = await awaitCredentialGeneration({
            capturedGeneration: credentialGeneration,
            currentGeneration: () => credentialCacheGeneration,
            run,
          });
          assertCurrentDmSession();
          return result;
        }
        const { capture } = await requireEngineCapture(workspace, "Chats");
        assertCurrentDmSession();
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
          throw new Error(
            "A direct message needs a recipient other than yourself.",
          );
        }
        // Resolve mentions before creating/granting a DM so an invalid or stale
        // heading cannot leave behind a partially initialized conversation.
        const attachments = await awaitCurrentDmSession(() =>
          resolveChatFileReferences(
            workspace,
            capture.fileObjectIdForPath,
            input.fileReferences,
          ),
        );
        const store = linkedChatStoreFor(workspace);
        // A DM's identity is its LIVE grant recipient set, not its display
        // name. Enumerate live chat-channel grants once for deduplication and
        // for deciding which recipients still need a grant.
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
        // Starting a DM with the same live recipient set opens the existing one.
        const dmChannels = (
          await awaitCurrentDmSession(() =>
            store.listChannels({ workspaceId: workspace.workspaceId }),
          )
        ).filter((channel) => channel.kind === "dm");
        const dmChannelWires = await Promise.all(
          dmChannels.map(async (channel) => ({
            id: channel.id,
            wireId:
              (await awaitCurrentDmSession(() =>
                store.getChannelWireId({
                  workspaceId: workspace.workspaceId,
                  channelId: channel.id,
                }),
              )) ?? channel.id,
          })),
        );
        assertCurrentDmSession();
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
        // Grant the full recipient set before the first message mutation.
        // grantDmRecipients revokes grants created by this call if setup or
        // commit fails.
        const covered = liveGrantEmailsByWire.get(wireId) ?? new Set<string>();
        let threads: Awaited<ReturnType<typeof store.listChannelThreads>> = [];
        const message = await grantDmRecipients({
          recipients,
          covered,
          createGrant: async (email) => {
            assertCurrentDmSession();
            const created = await relayShareJsonWithCredentials<{
              shareId?: string;
            }>(
              credentials,
              `/sync/${encodeURIComponent(workspace.workspaceId)}/shares`,
              {
                method: "POST",
                body: JSON.stringify({
                  recipientEmail: email,
                  channelWireId: wireId,
                  access: "read-write",
                }),
              },
            );
            // The helper records this id before its next currentness check, so
            // retirement during POST still rolls the grant back.
            return typeof created.shareId === "string" ? created.shareId : null;
          },
          // Compensating cleanup uses the captured relay session even when
          // forward authority is stale, so retirement cannot strand a partial
          // recipient set.
          revokeGrant: async (shareId) => {
            await relayShareJsonWithCredentials(
              credentials,
              `/sync/shares/${encodeURIComponent(shareId)}/revoke`,
              { method: "POST" },
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
        assertCurrentDmSession();
        if (!message) throw new Error("Could not start that direct message.");
        // These durable owners take over only after exact request admission.
        assertCurrentDmSession();
        activity.queueCloudSync(workspace.workspaceId);
        assertCurrentDmSession();
        void chatDispatchService
          .scanWorkspace(workspace.workspaceId)
          .catch((error) => {
            console.error("[desktop] local chat dispatch scan:", error);
          });
        assertCurrentDmSession();
        const dm = (
          await awaitCurrentDmSession(() =>
            listDmRecords({
              workspaceId: workspace.workspaceId,
              store,
              sharedChannels: operation.workspace.sharedChannels ?? [],
            }),
          )
        ).find((candidate) => candidate.channelId === channelId);
        if (!dm) throw new Error("Could not start that direct message.");
        return StartDmResult.parse({
          dm: dmRecordForIpc(dm),
          message: chatMessageForIpc(message),
        });
      },
    );
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
    const input = PresencePublishRequestPayload.parse(payload);
    const rendererSession = rendererWorkspaceSessions.currentForDocument(
      event.sender,
      input.rendererDocumentId,
    );
    if (
      !rendererSession ||
      input.scope.workspaceId !== rendererSession.workspaceId
    ) {
      return PresenceResult.parse({ ok: false, reason: "unavailable" });
    }
    const key = presenceMutationKey(input.scope, input.topic, input.clientId);
    const resolveLeave = async (): Promise<() => Promise<void>> => {
      const transport = await presenceRelayTransportForScope(input.scope);
      if (!transport) throw new Error("Presence scope is unavailable");
      return () =>
        transport.leave({ topic: input.topic, clientId: input.clientId });
    };
    try {
      if (input.leave === true) {
        await presenceMutationOwner.leave(
          rendererSession,
          key,
          input.incarnationId,
          resolveLeave,
        );
        // A leave has no snapshot to echo; report an empty one so the renderer
        // clears without treating it as a failure.
        return PresenceResult.parse({ ok: true, snapshot: { version: 0, peers: [] } });
      }
      // The exact renderer lease owns this mutation BEFORE scope resolution
      // warms credentials. Retirement serializes its leave behind any request
      // that may already have landed at the relay.
      const snapshot = await presenceMutationOwner.publish(
        rendererSession,
        key,
        input.incarnationId,
        {
          resolve: async () => {
            const transport = await presenceRelayTransportForScope(input.scope);
            if (!transport) throw new Error("Presence scope is unavailable");
            return {
              publish: () =>
                transport.publish({
                  topic: input.topic,
                  clientId: input.clientId,
                  state: input.state ?? null,
                }),
              leave: () =>
                transport.leave({
                  topic: input.topic,
                  clientId: input.clientId,
                }),
            };
          },
        },
      );
      if (!snapshot) {
        return PresenceResult.parse({ ok: false, reason: "unavailable" });
      }
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
    const rendererSession = rendererWorkspaceSessions.current(event.sender);
    if (
      !rendererSession ||
      input.scope.workspaceId !== rendererSession.workspaceId
    ) {
      return PresenceResult.parse({ ok: false, reason: "aborted" });
    }
    // Register the controller BEFORE any await: scope resolution warms the
    // credential cache, and a presenceCancel arriving during that window must
    // abort THIS poll promptly (workspace-switch repaint), not wait out the 35s
    // safety cap. Ownership keys on (senderId + pollId) so only this window can
    // cancel it, and at most one poll runs per (sender, scope, topic).
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
      if (handle.signal.aborted || !rendererSession.isCurrent()) {
        return PresenceResult.parse({ ok: false, reason: "aborted" });
      }
      const snapshot = await transport.poll({
        topic: input.topic,
        since: input.since,
        signal: handle.signal,
      });
      if (!rendererSession.isCurrent()) {
        return PresenceResult.parse({ ok: false, reason: "aborted" });
      }
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
    if (!rendererWorkspaceSessions.current(event.sender)) {
      return undefined;
    }
    // Only aborts a poll THIS sender owns; a cancel for another window's pollId
    // is a no-op.
    presencePollRegistry.cancel(event.sender.id, input.pollId);
    return undefined;
  });

  ipcMain.handle(CHANNELS.getSyncStatus, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return SyncStatusResult.parse(
      await syncStatusWithOwnedProjection(
        workspace,
        activity.getStatus(input.workspaceId),
      ),
    );
  });

  ipcMain.handle(CHANNELS.rebuildEngineStore, async (event, payload) => {
    assertTrustedSender(event);
    const input = RebuildEngineStorePayload.parse(payload);
    const registered = requireWorkspace(input.workspaceId);
    assertWritableWorkspace(registered);
    return workspaceAuthorities.withAuthority(input.workspaceId, (lease) =>
      inWorkspaceEngineStoreLane(lease,
      async () => {
        const workspace = canonicalWorkspaceFor(lease);
        const sessions = requireEngineSessions();
        return RebuildEngineStoreResult.parse(
          await rebuildEngineStoreRequest(workspace.rootPath, {
            isStoreRefused: () =>
              Boolean(
                activity.getStatus(workspace.workspaceId).engineStoreRefused,
              ),
            hasActiveAgentRun: () =>
              activity.hasAgentRun(workspace.workspaceId, workspace.rootPath),
            previousResult: () =>
              lease.state.lastEngineStoreRebuildResult ?? undefined,
            rememberResult: (result) =>
              (lease.state.lastEngineStoreRebuildResult = result),
            closeActivity: async () => {
              try {
                await closeDispatchRunActivity(workspace, {
                  notifyRenderer: false,
                });
              } catch (error) {
                notifyRenderer({ workspaceId: workspace.workspaceId });
                throw error;
              }
            },
            probeStoreRefusal: () =>
              probeEngineStoreRefusal(
                workspace,
                sessions,
              ),
            rebuildGate: {
              begin: () => sessions.beginRebuild(workspace),
              end: () => sessions.endRebuild(workspace),
            },
            moveStoreAside: moveEngineStoreAside,
            reopenActivity: async () => {
              try {
                await openWorkspaceActivityUnderEngineStoreLock(workspace, {
                  afterReopenRecoverySettled: () =>
                    sessions.endRebuild(workspace),
                });
              } finally {
                notifyRenderer({ workspaceId: workspace.workspaceId });
              }
            },
          }),
        );
      }),
    );
  });

  // Enabling agents starts a local run: the workspace must already be OPEN (the
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
    requireWorkspace(input.workspaceId);
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

  ipcMain.handle(CHANNELS.getUserSettings, async (event) => {
    assertTrustedSender(event);
    return DesktopUserSettingsResult.parse(
      await readCachedUserSettingsFile(stateDir()),
    );
  });

  ipcMain.handle(CHANNELS.setUserSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetUserSettingsPayload.parse(payload);
    const result = await enqueueUserSettingsWrite(async () => {
      await writeUserSettingsFile(stateDir(), input.settings);
      cachedPreferredName = input.settings.profile.preferredName;
      // The windows must match whatever zoom level was just persisted, however
      // it got into the saved object.
      applyZoomLevelToWindows(input.settings.appearance.zoomLevel);
      return DesktopUserSettingsResult.parse({
        settings: input.settings,
        source: "stored",
      });
    });
    await refreshDispatchTray();
    if (input.settings.runner.enabled && input.settings.runner.command.trim()) {
      for (const workspace of openDispatchWorkspaces()) {
        void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
          console.error("[desktop] runner-settings dispatch scan:", error);
        });
      }
    }
    return result;
  });

  ipcMain.handle(CHANNELS.resetUserSettings, async (event) => {
    assertTrustedSender(event);
    const result = await enqueueUserSettingsWrite(async () => {
      await writeUserSettingsFile(stateDir(), DEFAULT_USER_SETTINGS);
      cachedPreferredName = undefined;
      applyZoomLevelToWindows(DEFAULT_USER_SETTINGS.appearance.zoomLevel);
      return DesktopUserSettingsResult.parse({
        settings: DEFAULT_USER_SETTINGS,
        source: "stored",
      });
    });
    await refreshDispatchTray();
    return result;
  });

  ipcMain.handle(CHANNELS.getWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceSettingsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Workspace settings read stopped because this window changed workspaces.",
      async (operation) =>
        WorkspaceSettingsResult.parse(
          await readWorkspaceSettingsFile(operation.workspace.rootPath),
        ),
    );
  });

  ipcMain.handle(CHANNELS.setWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetWorkspaceSettingsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Workspace settings save stopped because this window changed workspaces.",
      async (operation) =>
        WorkspaceSettingsResult.parse(
          await saveWorkspaceSettingsFile(
            operation.workspace.rootPath,
            input.patch,
          ),
        ),
    );
  });

  ipcMain.handle(CHANNELS.resetWorkspaceSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceSettingsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Workspace settings reset stopped because this window changed workspaces.",
      async (operation) =>
        WorkspaceSettingsResult.parse(
          await resetWorkspaceSettingsFile(operation.workspace.rootPath),
        ),
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

  // The palette and the Settings stepper share the menu accelerators' zoom
  // mutation; the answer is the settings now on disk, so the caller paints
  // the level actually in effect.
  ipcMain.handle(CHANNELS.stepWindowZoom, async (event, payload) => {
    assertTrustedSender(event);
    const input = StepWindowZoomPayload.parse(payload);
    return DesktopUserSettingsResult.parse(await stepWindowZoom(input.step));
  });

  // Per-workspace workbench UI state (.dohc/ui-state.json). The renderer
  // cannot write .dohc through writeWorkspaceText (reserved path) — this
  // narrow pair is the only writer, same pattern as agent-runs.json. Both
  // directions are zod-bounded; a corrupt/foreign on-disk file reads as null
  // ("no saved state"), never an error.
  ipcMain.handle(CHANNELS.getWorkspaceUiState, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "UI state read stopped because this window changed workspaces.",
      async (operation) => {
        const parsed = GetWorkspaceUiStateResult.safeParse(
          await readUiStateFile(operation.workspace.rootPath),
        );
        return parsed.success ? parsed.data : null;
      },
    );
  });

  ipcMain.handle(CHANNELS.setWorkspaceUiState, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetWorkspaceUiStatePayload.parse(payload);
    await withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "UI state write stopped because this window changed workspaces.",
      (operation) => writeUiStateFile(operation.workspace.rootPath, input.state),
    );
  });

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
            isCurrent: () => {
              try {
                operation.assertCurrent();
                return true;
              } catch {
                return false;
              }
            },
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

  ipcMain.handle(CHANNELS.engineYDocOpen, async (event, payload) => {
    assertTrustedSender(event);
    return engineYDocSessionIpc.open(event.sender, payload);
  });

  ipcMain.handle(
    CHANNELS.engineYDocReadArtifactAsset,
    async (event, payload) => {
      assertTrustedSender(event);
      return engineYDocSessionIpc.readArtifactAsset(event.sender, payload);
    },
  );

  ipcMain.handle(CHANNELS.engineYDocApplyUpdate, (event, payload) => {
    assertTrustedSender(event);
    return engineYDocSessionIpc.applyUpdate(event.sender, payload);
  });

  ipcMain.handle(
    CHANNELS.engineYDocAcknowledgeLineageReplacement,
    (event, payload) => {
      assertTrustedSender(event);
      return engineYDocSessionIpc.acknowledgeLineageReplacement(
        event.sender,
        payload,
      );
    },
  );

  ipcMain.handle(CHANNELS.engineYDocClose, async (event, payload) => {
    assertTrustedSender(event);
    await engineYDocSessionIpc.close(event.sender, payload);
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
    // Re-ask at the QUIT BOUNDARY (#579 review, r12): the renderer checked
    // before it called, and a reopen can set an edit aside in the gap. Only
    // once main has a fresh answer does it approve the quit that
    // quitAndInstall starts — the ask cannot veto it afterwards, because
    // that would burn the one-shot latch (#579 review, r10).
    if (await recoveryChecker.ask()) {
      return UpdateActionResult.parse({
        accepted: false,
        completed: false,
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
  // the canonical capture layer. A list/open still materializes immediately.
  // Event-gated (see queueChatBookmarkProjection): every reply path flags
  // its workspace, so the worker idles instead of querying every open
  // workspace unconditionally. The slow cadence is the crash backstop — a
  // failed pass re-flags and retries here.
  const bookmarkProjectionTimer = setInterval(() => {
    for (const workspaceId of activity.listOpenWorkspaceIds()) {
      if (!findWorkspace(workspaceId)) continue;
      const lease = requireWorkspaceAuthority(workspaceId);
      const state = lease.state;
      if (!state.bookmarkProjectionPending || state.bookmarkProjectionRunning) {
        lease.release();
        continue;
      }
      const workspace = canonicalWorkspaceFor(lease);
      const capture = activity.engineCaptureFor(workspaceId,
        workspace.rootPath,
      );
      if (!capture || sharedViewOf(workspaceId)) {
        lease.release();
        continue;
      }
      state.bookmarkProjectionPending = false;
      state.bookmarkProjectionRunning = true;
      void materializePendingChatBookmarks(workspace, capture)
        .then(() => lease.assertCurrent())
        .catch((error) => {
          console.error("[desktop] live chat bookmark projection:", error);
          try {
            lease.assertCurrent();
            state.bookmarkProjectionPending = true;
          } catch {
            // The successor owns a separate queue.
          }
        })
        .finally(() => {
          state.bookmarkProjectionRunning = false;
          lease.release();
        });
    }
  }, 30_000);
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
      // A capture event can die with the previous daemon's transport after its
      // moment committed; the replacement never re-emits it (its baseline finds
      // disk and manifest agreeing). One repaint per healthy launch closes that
      // staleness window. Scope-free: the lost event could have belonged to
      // any open workspace.
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

  // Quit interception (#567 / #579 review, r10): a set-aside draft storage
  // could not keep (#600) lives only in renderer memory, and a quit is its
  // one irreversible exit — the renderer must get to warn BEFORE any
  // destructive teardown runs. It answers for those drafts alone. This
  // matters doubly for updates: electron-updater's quitAndInstall is
  // ONE-SHOT, so the decision has to come before it is ever called. The
  // renderer answers every ask promptly: resume (no drafts, or the user
  // confirmed) or hold (its dialog owns the decision). A silent renderer
  // gets the guard's MAIN-side dialog, never a silent force-quit.
  app.on("before-quit", (event) => {
    // No workspace window means nobody to ask and no renderer-held drafts to
    // lose — a hidden export window is not a reason to intercept, and not a
    // renderer that could answer (#579 review, r12).
    if (!liveWorkspaceWindow()) return;
    quitGuard.beforeQuit(event);
  });

  void app.whenReady().then(async () => {
    // Electron is ready; marked before any startup work so the mark measures
    // Electron itself (it used to land after the daemon await, which recorded
    // daemon boot as "app ready").
    launchMarks.appReady();
    desktopMarks.markOnce("app-ready");

    // The daemon spawn + handshake runs while the window is created and the
    // renderer loads. The continuation below awaits it before anything that
    // needs the engine; boot-time IPC awaits engineDaemonStartup on its own
    // paths.
    engineDaemonStartup = startRustEngineDaemon();
    // Warms the promise cache the zoom read in trackWorkspaceWindow shares;
    // awaited just before the window is created, so the persisted zoom is
    // known by then and the read overlaps the daemon handshake meanwhile.
    const cachedSettingsRead = readCachedUserSettingsFile(stateDir());
    if (app.isPackaged && process.platform === "linux" && isAppImageBoot()) {
      // A failed refresh must not block startup or discard an intact pair
      // from an earlier boot. With no usable pair, report the launcher
      // unavailable instead of exposing the AppImage mount path. The await
      // overlaps the daemon handshake above.
      linuxStableCliBinDir = await refreshLinuxStableCliBin({
        resourcesCliBinDir: resolveDohcCliBinDirectory({
          appRoot: app.getAppPath(),
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        }),
        targetDir: join(stateDir(), "cli-bin"),
        onError: (error) => console.error("[desktop] Stable Linux cli-bin refresh failed:", error),
      });
    }
    // BrowserWindow and Dock APIs are only safe after Electron is ready.
    nativeTheme.on("updated", refreshSystemThemeDesktopIcons);
    // Handlers exist before the window: the renderer's first IPC call races
    // the daemon handshake now, and an unregistered handler would reject it.
    registerIpcHandlers();

    // Serve workspace file bytes for dohc-file://<workspaceId>/<relpath>.
    // Registered before the window so the first load can already fetch.
    protocol.handle(DOHC_FILE_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const workspace = findWorkspace(url.hostname);
        if (!workspace) return new Response("Unknown workspace", { status: 404 });
        const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        const { bytes, mediaType } = await readOwnedWorkspaceAsset(
          workspace,
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

    // The persisted zoom must be KNOWN before the first window exists:
    // trackWorkspaceWindow applies a known level synchronously at creation,
    // before any show(), while its async read lands only after
    // createMainWindow's ready-to-show show() — a wrong-scale first frame
    // that firstPaint then describes. The read is promise-cached local IO
    // warmed above, so this await costs the read only; the renderer load
    // stays concurrent with the daemon handshake.
    const cachedSettings = (await cachedSettingsRead).settings;
    cachedPreferredName = cachedSettings.profile.preferredName;
    knownZoomLevel ??= cachedSettings.appearance.zoomLevel;

    // The window exists and its renderer loads WHILE the daemon handshakes;
    // everything below that needs the daemon still waits for it.
    const window = trackWorkspaceWindow(
      createMainWindow({ beforeRendererReload: prepareAfterRendererCrash }),
    );
    // Same tick as the window, so the load cannot finish before this listener.
    // The activation send chains on it below, once the daemon is up and the
    // launch workspaces are open.
    const windowLoaded = new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", resolve);
    });
    launchMarks.firstWindow();
    desktopMarks.markOnce("first-window");

    if (!(await engineDaemonStartup)) return;

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

    const launchWorkspace = await openWorkspacePaths(
      collectOpenWorkspaceArgs(process.argv),
    );
    // A path the handlers queued during the bootstrap is a later intent than
    // the launch arguments, so it wins.
    const pendingWorkspace = await flushPendingOpenPaths();
    const activatedWorkspace = pendingWorkspace ?? launchWorkspace;
    refreshNativeWorkspaceSurfaces();
    // The renderer has subscribed once the load finishes, so this send lands —
    // and being last, it wins over any activation an open above sent into a
    // still-loading window.
    void windowLoaded.then(() => {
      if (activatedWorkspace) sendWorkspaceActivated(window, activatedWorkspace);
      // A path that arrived while the awaits above were pending is still
      // queued when the gate opens below, and no later event is guaranteed to
      // flush it. This one is the backstop, and its opens send their own
      // activations after the send above, so the later intent still wins.
      void flushPendingOpenPaths(window);
    });
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
      // A restart already staged has no install left to make — quitAndInstall
      // started its own quit on the first call and has none left to start.
      // Main makes it, so the fact lives HERE and not in a renderer module a
      // reload would reset (#579 review, r18). The quit is already approved:
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
