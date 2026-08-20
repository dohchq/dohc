import {
  defaultWorkspaceRoot,
  isSharedWithMePath,
  normalizeAbsolutePath,
  validateUserWritePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  CHATS_METHOD,
  VersionedLiveAdapter,
  WORKSPACE_METHOD,
  WorkspaceDaemonRequester,
  decodeGranularChatMessageSearchResponse,
  decodeUnreadFileThreads,
  isYdocArtifactAssetsInvalidRefusal,
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
  WebContentsView,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import * as Y from "yjs";
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
  SubmitShareChangesResult,
  ListMyShareChangesPayload,
  ListMyShareChangesResult,
  WithdrawShareChangesPayload,
  WithdrawShareChangesResult,
  RefreshSharedViewResult,
  UnmountSharePayload,
  UnmountShareResult,
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
  InvokePluginPanelSdkPayload,
  InvokePluginPanelSdkResult,
  ListPluginsPayload,
  PluginSettingsResult,
  SetPluginSettingsPayload,
  ListPluginsResult,
  PluginActionPayload,
  PluginActionResult,
  PluginSizesResult,
  PluginUninstallPreflightResult,
  UninstallPluginPayload,
  PluginStatusChangedEvent,
  DesktopMarksResult,
  LaunchMarksResult,
  OpenPluginPanelPayload,
  OpenPluginPanelResult,
  StartPluginPanelPayload,
  StartPluginPanelResult,
  StopPluginPanelPayload,
  OpenPluginWebAppPayload,
  OpenPluginWebAppResult,
  StartPluginWebAppPayload,
  StartPluginWebAppResult,
  SetPluginWebAppBoundsPayload,
  StopPluginWebAppPayload,
  PluginWebAppFailedEvent,
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
  WriteWorkspaceTextResult,
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
  ReadEngineYDocArtifactAssetPayload,
  ReadEngineYDocArtifactAssetResult,
  ApplyEngineYDocUpdatePayload,
  ApplyEngineYDocUpdateResult,
  AcknowledgeEngineYDocLineageReplacementPayload,
  AcknowledgeEngineYDocLineageReplacementResult,
  CloseEngineYDocSessionPayload,
  EngineYDocRemoteUpdateEventSchema,
  EngineYDocLineageReplacementEventSchema,
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
import { releaseEngineYDocSession } from "./workspaces/engineYDocSessionRelease";
import {
  claimEngineYDocSessionSlot,
  engineYDocSessionKey,
} from "./workspaces/engineYDocSessionRegistry";
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
import {
  createQuitGuard,
  createRecoveryChecker,
  createWorkspaceWindowRegistry,
} from "./quitGuard";
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
  allowLoopbackFrameOrigin,
  createMainWindow,
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
  acknowledgeWorkspaceShareSkips,
  endWorkspaceShareView,
  setWorkspaceShareMounts,
  setWorkspaceShareView,
  setWorkspaceSharedChannels,
  stateDir,
} from "./workspaces/WorkspaceRegistry";
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
  shareProposalOpPath,
  type ShareViewProposalScope,
} from "./workspaces/shareProposals";
import { pathShareLanes } from "./workspaces/relayShareLanes";
import {
  workspaceSummariesFrom,
  workspaceSummaryFor,
} from "./workspaces/workspaceSummaryProjection";
import {
  assertSharedChannelWritable,
  createKeyedSerializer,
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
  joinedChannelMatchesCredentials,
  resolveChatRelayIdentity,
  resolveShareViewRelayAuthorId,
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
  createSharedChannelWritableChatIpcHandler,
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
  SharePinInvalidError,
  recordedShareSelector,
  refreshSharedViewOnce,
  shareViewIdentitySelector,
} from "./workspaces/sharedView";
import { assertShareChatWritable } from "./workspaces/shareChatGate";
import {
  assertMountableSelector,
  createMountDirectory,
  mountLabelFor,
  mountStoreWorkspaceIdFor,
  relayTargetForShareMount,
  refreshShareMountOnce,
  classifyShareMountRefreshError,
  removeMountFolder,
  shareMountResultRow,
  validMountLabel,
} from "./workspaces/shareMounts";
import { createShareSkipRecorder } from "./workspaces/shareSkipRecorder";
import {
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  SharedFileReadOnlyError,
  type RelayWorkspaceBootstrapResult,
  type ShareProposal,
  type ShareProposalSummary,
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
import { createWorkspaceActivity } from "./workspaces/workspaceActivity";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineYDocProviderSession,
} from "./workspaces/workspaceEngineCapture";
import {
  isYDocPathNotInVersionError,
  isYDocRemovalInProgressError,
  isYDocSessionUnreleasedError,
} from "./workspaces/workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaces/workspaceEngineCaptureLiveStore";
import {
  createRustEngineDaemon,
  defaultEngineBinaryPath,
  isEngineWorkspaceOpenRefusedError,
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
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
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
  startStaticDirectoryPreview,
  type StaticDirectoryPreview,
} from "./security/staticDirectoryPreview";
import { PluginHost } from "./plugins/PluginHost";
import {
  PluginPipeline,
  type PluginPipelineStatusEvent,
} from "./plugins/PluginPipeline";
import { createPluginAuthoredTextWriter } from "./plugins/pluginAuthoredWrite";
import { invokePluginSdkHost } from "./plugins/pluginSdkHost";
import { createPluginUtilityTransport } from "./plugins/pluginUtilityTransport";
import { PluginChildProcessBroker } from "./plugins/pluginChildProcessBroker";
import { PluginWorkspaceEvents } from "./plugins/pluginWorkspaceEvents";
import {
  createPluginAgentDrivers,
  type PluginAgentDrivers,
} from "./plugins/pluginAgentDrivers";
import { BUILT_IN_AGENT_DRIVER_IDS } from "./agents/AgentDriver";
import { pluginDataDir } from "./plugins/pluginLocalState";
import { pluginIdToSafePath } from "./plugins/pluginSourceSnapshot";
import { stopPluginPanelPreview } from "./plugins/pluginPanelLifecycle";
import {
  assertPluginPanelRequestCurrent,
  loadPluginPanelRegistrationForCurrentRenderer,
  revokePluginPanelAuthorities,
  revokePluginPanelAuthoritiesForStatus,
  startPluginPanelWithLock,
  stopPluginPanelWithLock,
} from "./plugins/pluginPanelStartLifecycle";
import { createPluginPanelSdkAuthorityRegistry } from "./plugins/pluginPanelSdkAuthority";
import {
  forgetRemovedPlugin,
  forgetUninstalledPlugin,
  loadPluginWebAppRegistration,
  forgetWorkspaceRegistrations,
  loadPluginPanelRegistration,
  pluginLifecycleKey,
  rememberPluginRegistration,
  startPluginForPanel,
  type RegisteredPlugin,
} from "./plugins/pluginPanelRegistration";
import {
  disposeWorkspacePipeline,
  ensureWorkspacePipeline,
} from "./plugins/pluginPipelineLifecycle";
import {
  clearPluginWebAppPartition,
  createPluginWebAppGuest,
} from "./plugins/pluginWebAppGuest";
import { recoverConsumedWebAppCredential } from "./plugins/pluginWebAppRecovery";
import {
  assertInstanceBudget,
  requireDeclaredWebApp,
} from "./plugins/pluginWebAppInstances";
import {
  PluginWebAppViewRegistry,
  webAppInstanceKey,
  type PluginWebAppViewRecord,
} from "./plugins/pluginWebAppViews";
import type { DohcPluginManifest } from "./plugins/pluginManifestSchema";
import {
  mediaTypeForExtension,
  readWorkspaceAsset,
  readWorkspaceText,
  resolveWorkspaceFile,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
  writeWorkspaceAsset,
} from "./workspaces/workspaceAssets";
import { routeWorkspaceTextWrite } from "./workspaces/workspaceTextWrite";
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
import { collectZipEntries, listFiles } from "./workspaces/workspaceFiles";
import { explorerMenuEntries } from "./workspaces/explorerMenu";
import {
  routeWorkspaceFileCreate,
  routeWorkspaceFileImport,
  routeWorkspaceFolderCreate,
  routeWorkspacePathDelete,
  routeWorkspacePathMove,
} from "./workspaces/workspaceFileOps";
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
// view's folder is a projection of its engine store. The one write a share
// view does admit is routed elsewhere — see `CHANNELS.writeWorkspaceText`.
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

const pluginPipelines = new Map<string, PluginPipeline>();
const pluginPipelineDisposals = new Map<string, Promise<void>>();
// One per workspace, alive for as long as that workspace's plugin pipeline is.
const pluginAgentDriversByWorkspace = new Map<string, PluginAgentDrivers>();
// Also one per workspace, so one workspace's settled batch can only ever
// reach the plugins running in that workspace.
const pluginWorkspaceEventsByWorkspace = new Map<string, PluginWorkspaceEvents>();
let autoUpdateController: AutoUpdateController | null = null;
let applicationMenuCanInstallUpdate: boolean | null = null;

function pluginResourcesBasePath(): string {
  // app.getAppPath() is unreliable here: when Electron is launched with a
  // direct script path (as the e2e harness does, and as a plain built binary
  // is), it resolves to the launched script's own directory (dist/main)
  // rather than the package root, with no upward package.json search — it
  // silently pointed pnpm resolution at dist/main/resources and broke every
  // plugin install (#777's e2e caught this). import.meta.dirname is the
  // currently executing module's own directory (dist/main at runtime,
  // exactly like createPluginPipeline's sibling plugin-host.js resolution
  // below), so two levels up reaches apps/desktop deterministically
  // regardless of how Electron was launched.
  return app.isPackaged
    ? process.resourcesPath
    : join(import.meta.dirname, "..", "..", "resources");
}

function notifyPluginStatusChanged(
  workspaceId: string,
  event: PluginPipelineStatusEvent,
): void {
  // A removed identity releases its panel registration and any panel claim
  // on its host — before the schema guard below, which only protects the
  // renderer send (#779 round 14 A5).
  forgetRemovedPlugin({
    registrations: pluginRegistrations,
    panelStartedHosts,
    workspaceId,
    event,
  });
  // Emitted from a queueMicrotask with no catch above it, so a payload that
  // fails the IPC schema is dropped and logged — it must never become an
  // uncaught main-process exception (#779 round 13 A2).
  const payload = PluginStatusChangedEvent.safeParse({ workspaceId, ...event });
  if (!payload.success) {
    console.error(
      `[desktop] dropped a plugin status event for ${workspaceId} that ` +
        `failed the IPC schema: ${payload.error.message}`,
    );
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (activeWorkspaceIdBySender.get(win.webContents.id) !== workspaceId) continue;
    win.webContents.send(CHANNELS.pluginStatusChanged, payload.data);
  }
}

function createPluginPipeline(workspace: CreatedWorkspace): PluginPipeline {
  let pipeline: PluginPipeline | null = null;
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
  pluginAgentDriversByWorkspace.set(workspace.workspaceId, pluginDrivers);
  // This workspace's plugin file subscriptions, fed by the settled watcher
  // batch (see onWatcherBatch) — the same feed the pipeline reads.
  const workspaceEvents = new PluginWorkspaceEvents();
  pluginWorkspaceEventsByWorkspace.set(workspace.workspaceId, workspaceEvents);
  const pluginHost = new PluginHost({
    stateDir: stateDir(),
    workspaceRoot: workspace.rootPath,
    spawnTransport: (callbacks) => {
      const child = utilityProcess.fork(
        join(import.meta.dirname, "plugin-host.js"),
        [],
        {
          cwd: callbacks.pluginRoot,
          serviceName: "dohc-plugin-host",
          stdio: ["ignore", "ignore", "pipe"],
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
          workspaceEvents.subscribe({ pluginId, spawnId, emitEvent }, watchParams),
        unsubscribeFileWatch: (watchParams) =>
          workspaceEvents.unsubscribe({ pluginId, spawnId }, watchParams),
        method,
        params,
      }),
    // The plugin gets its settings with its activation, so it never starts
    // without them and never has to ask.
    readPluginSettings: async (pluginId) =>
      (await pipeline?.getPluginSettings(pluginId)) ?? {},
    onDriversRegistered: (pluginId, spawnId, drivers) =>
      pluginDrivers.register(pluginId, spawnId, drivers),
    onDriverEvent: (pluginId, spawnId, params) =>
      pluginDrivers.handleEvent(pluginId, spawnId, params),
    // One seam ends a spawn: the driver's sessions fail here, and the broker
    // takes the harness's whole process tree down. Neither asks the plugin.
    onSpawnEnd: (pluginId, spawnId) => {
      pluginDrivers.endSpawn(pluginId, spawnId);
      workspaceEvents.disposeSpawn(pluginId, spawnId);
      return childProcessBroker.disposeSpawn(pluginId, spawnId);
    },
    onDispose: () => {
      workspaceEvents.dispose();
      return childProcessBroker.dispose();
    },
    onStatusChange: (pluginId, status) => {
      pipeline?.noteRuntimeStatus(pluginId, status);
      revokePluginPanelAuthoritiesForStatus({
        workspaceId: workspace.workspaceId,
        pluginId,
        status,
        panels: runningPluginPanels.values(),
        revokePanel: pluginPanelSdkAuthorities.revokePanel,
      });
      // A guest view outliving its plugin would keep showing a dead server:
      // the broker tears the wrapper's process tree down with the spawn.
      if (status === "crashed" || status === "failed" || status === "disabled") {
        stopPluginWebAppsForPlugin(workspace.workspaceId, pluginId);
      }
    },
  });
  pluginHostRef = pluginHost;
  pipeline = new PluginPipeline({
    workspaceRoot: workspace.rootPath,
    stateDir: stateDir(),
    pluginHost,
    resourcesBasePath: pluginResourcesBasePath(),
    pnpmRunnerEntry: join(import.meta.dirname, "pnpm-runner.js"),
    onStatusChange: (event) =>
      notifyPluginStatusChanged(workspace.workspaceId, event),
    isEngineCaptureAvailable: () =>
      activity.engineCaptureFor(workspace.workspaceId) !== null,
  });
  return pipeline;
}

async function ensurePluginPipeline(
  workspace: CreatedWorkspace,
): Promise<PluginPipeline> {
  assertWritableWorkspace(workspace);
  return ensureWorkspacePipeline({
    live: pluginPipelines,
    disposals: pluginPipelineDisposals,
    workspaceId: workspace.workspaceId,
    create: () => createPluginPipeline(workspace),
    start: (pipeline) => pipeline.start(),
    dispose: (pipeline) => disposePluginPipeline(workspace.workspaceId, pipeline),
  });
}

// Stopping the pipeline stops its plugins, which fails their driver sessions
// through onSpawnEnd. This drops the registry the workspace no longer has.
async function disposePluginPipeline(
  workspaceId: string,
  pipeline: PluginPipeline,
): Promise<void> {
  try {
    await pipeline.dispose();
  } finally {
    pluginAgentDriversByWorkspace.delete(workspaceId);
    pluginWorkspaceEventsByWorkspace.get(workspaceId)?.dispose();
    pluginWorkspaceEventsByWorkspace.delete(workspaceId);
  }
}

async function stopPluginPipelineForWorkspace(workspaceId: string): Promise<void> {
  await disposeWorkspacePipeline({
    live: pluginPipelines,
    disposals: pluginPipelineDisposals,
    workspaceId,
    dispose: (pipeline) => disposePluginPipeline(workspaceId, pipeline),
  });
}

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

async function withKeyedStartLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
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

// The windows that RUN the workspace renderer. Not every BrowserWindow does:
// the PDF export creates a hidden, preload-less one, and asking IT about
// set-aside drafts would answer nothing (#579 review, r12). Tracked at
// creation instead of guessed from getAllWindows().
const workspaceWindows = createWorkspaceWindowRegistry<BrowserWindow>(
  (window) => window.isDestroyed(),
);
function trackWorkspaceWindow(window: BrowserWindow): BrowserWindow {
  workspaceWindows.track(window);
  window.on("closed", () => workspaceWindows.forget(window));
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
// #742 P1 (rounds 3–5): the last successfully classified DM request lanes,
// per workspace — see createLastKnownDmRequestLanesCache's own comment for
// the staleness contract. Declared at module scope (not inside the IPC
// registration closure) so relayShareJsonWithCredentials — a top-level
// function, its own separate closure — can clear it from the 401 path below.
const lastKnownDmRequestLanes = createLastKnownDmRequestLanesCache();
function clearCachedCredentials(): void {
  credentialSessionCache.clear();
  // #742 P1 SECURITY (rounds 4–5): every credential-cache clear is a session
  // transition (login adoption, logout, or a current-session 401 — all three
  // call this one function). Clearing here, not at each call site
  // individually, is what makes sure a NEW account's first failed poll can
  // never be served the PREVIOUS account's cached request rows, sender
  // emails included, regardless of which of the three paths ended the
  // session.
  lastKnownDmRequestLanes.clear();
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
// Where each workspace's rotation stopped, by CHANNEL wire id — the identity
// that survives a channel being revoked and re-granted under a new share.
const sharedChannelSyncCursors = new Map<string, string>();
const reportSharedChannelPassCoverage = createPassCoverageReporter((message) =>
  console.info(message),
);
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

// Resolves to the live rows this pass did not reach, so an awaited caller can
// say so in its own response.
function syncWorkspaceSharedChannels(
  workspaceId: string,
  priorityChannelWireId?: string,
): Promise<number> {
  return serializeSharedChannelSync(workspaceId, () =>
    runSharedChannelSyncPass(workspaceId, priorityChannelWireId),
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
  if (!target) return await syncWorkspaceSharedChannels(workspaceId);
  let joinedChannel: JoinedSharedChannel | null;
  try {
    joinedChannel = await joinedSharedChannelForTarget({
      workspaceId,
      sharedChannels: entry.sharedChannels,
      store: linkedChatStoreFor(entry),
      target,
    });
  } catch {
    // The LOOKUP failed (the engine is restarting, say). That says nothing
    // about the target, so fall back to an ordinary pass rather than reading
    // the failure as "this channel is local" and syncing nothing.
    return await syncWorkspaceSharedChannels(workspaceId);
  }
  // A target holding no live grant has nothing to sync. A local channel's
  // threads never came from the relay, and running a pass for it would put a
  // whole window of relay round trips in front of a purely local read.
  if (!joinedChannel || joinedChannel.ended === true) return 0;
  // The CHANNEL, not its grant: this pass may sit in the per-workspace queue,
  // and a revoke plus re-grant while it waits replaces the share id.
  return await syncWorkspaceSharedChannels(workspaceId, joinedChannel.channelWireId);
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
  workspaceId: string,
  priorityChannelWireId?: string,
): Promise<number> {
  // Live rows this pass is responsible for. A pass that dies before finishing —
  // or never starts, because the account is signed out — refreshed none of them,
  // and must say so rather than report a clean sweep. Seeded before the
  // credential work so a rejection there still knows the count.
  let liveRows = 0;
  try {
    const entry = findWorkspace(workspaceId);
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
      registryOrder,
      passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,
      resumeAfterChannelWireId: sharedChannelSyncCursors.get(workspaceId),
      priorityChannelWireId,
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
    if (result.resumeAfterChannelWireId === null) {
      sharedChannelSyncCursors.delete(workspaceId);
    } else {
      sharedChannelSyncCursors.set(workspaceId, result.resumeAfterChannelWireId);
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
    return unrefreshed;
  } catch (error) {
    console.error(`[desktop] shared channel sync failed for ${workspaceId}:`, error);
    return liveRows;
  }
}

// The copyable MCP launch config for a workspace. The user's AI tool spawns the
// dohc MCP stdio server with these args; --workspace scopes every tool to this
// root (path containment), --home points it at the desktop registry/state dir.
// DOHC_MCP_COMMAND lets a packaged build override the launcher with its shipped
// binary; the default `dohc-mcp` is the @dohc/mcp bin on PATH.
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

function mcpConfigFor(
  rootPath: string,
  shareAccess: ShareAccess | null,
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
  // A share view hands out the MCP profile for its level (#646): the launched
  // server registers only the write tools that level grants. `null` is a local
  // workspace, which gets every tool.
  if (shareAccess) args.push("--share-access", shareAccess);
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
  // but if a runtime MCP is ever spawned for one it must carry the share's
  // level — never the full local profile.
  const config = mcpConfigFor(rootPath, mcpShareAccessOf(workspace?.shareView));
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
      pull: (materializePage) => daemonRelay.pull(materializePage),
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
    syncSharedChannels: async () => {
      await syncWorkspaceSharedChannels(workspace.workspaceId);
    },
    // A replicated chat message can mark a live bookmark pending without
    // touching the file watcher. Project immediately after the pull commits;
    // the periodic worker remains only a crash/retry backstop.
    afterSuccessfulPull: () =>
      projectPendingChatBookmarksAfterPull(workspace.workspaceId),
    countOpenConflicts: async () => await capture.countOpenConflicts(),
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
  // gate also owns the shared-view rule (#540): main only states whether the
  // workspace is one, and the decision carries the cause so the null capture
  // never wears the Settings opt-out's copy.
  captureFor: async (workspace, hooks) =>
    captureForFlaggedWorkspace(
      {
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        shareView: sharedViewOf(workspace.workspaceId) !== null,
      },
      hooks,
      requireEngineSessions(),
    ),
  // One settled batch, two readers: the approval pipeline, and the plugins
  // that subscribed to a prefix of it. Neither changes the batch.
  onWatcherBatch: (workspace, events) => {
    pluginPipelines.get(workspace.workspaceId)?.handleWatcherEvents(events);
    pluginWorkspaceEventsByWorkspace
      .get(workspace.workspaceId)
      ?.handleWatcherEvents(events);
  },
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
          "Versions",
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
        pluginAgentDriversByWorkspace.get(workspaceId)?.list() ?? [],
      agentDefaultsFor: workspaceAgentDefaults,
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
  onMessagePosted: (workspaceId, threadId) => {
    notifyRenderer();
    activity.queueCloudSync(workspaceId);
    void syncSharedChannelsForChatTarget(workspaceId, { threadId });
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

interface RunningPluginPanel {
  handle: StaticDirectoryPreview;
  releaseOrigin: () => void;
  workspaceId: string;
  pluginId: string;
  panelId: string;
  senderId: number;
  generation: number;
}

const pluginRegistrations = new Map<string, Map<string, RegisteredPlugin>>();
const pluginPanelSdkAuthorities = createPluginPanelSdkAuthorityRegistry();
const runningPluginPanels = new Map<string, RunningPluginPanel>();
const pluginPanelStartLocks = new Map<string, Promise<void>>();
const pluginHostLifecycleLocks = new Map<string, Promise<void>>();
// A plugin's host can be running because the workspace enabled it (install,
// enable, approve — it should keep running with no panel open at all) or
// because a panel's own cold start is the only reason it's alive. Only the
// latter is this key's to stop when its last panel closes (#779 round 4
// finding 3). ensurePluginStarted adds a key only when IT causes the
// zero-to-running transition; any workspace-level plugin action clears it,
// handing ownership back to the workspace.
const panelStartedHosts = new Set<string>();

function pluginPanelKey(
  workspaceId: string,
  pluginId: string,
  panelId: string,
): string {
  return `${workspaceId}\0${pluginId}\0${panelId}`;
}

const withPluginPanelStartLock = <T>(key: string, operation: () => Promise<T>) =>
  withKeyedStartLock(pluginPanelStartLocks, key, operation);

// Wrapper-plugin web apps (PR3): one main-owned WebContentsView per open web
// app tab. The registry decides which record a request or teardown touches;
// the helpers below apply the Electron effects.
interface AttachedWebAppView {
  view: WebContentsView;
  window: BrowserWindow;
}
const pluginWebAppViews = new PluginWebAppViewRegistry<AttachedWebAppView>();
const pluginWebAppStartLocks = new Map<string, Promise<void>>();
const hardenedGuestPartitions = new Set<string>();
const withPluginWebAppStartLock = <T>(key: string, operation: () => Promise<T>) =>
  withKeyedStartLock(pluginWebAppStartLocks, key, operation);

// The start lock serializes one instance's own starts and teardowns. Two
// instances of one web app are two servers behind two views, so they take two
// locks and start side by side.
function pluginWebAppKey(
  workspaceId: string,
  pluginId: string,
  webAppId: string,
  instanceKey: string | null,
): string {
  return webAppInstanceKey({ workspaceId, pluginId, webAppId, instanceKey });
}

function destroyPluginWebAppViews(
  records: readonly PluginWebAppViewRecord<AttachedWebAppView>[],
): void {
  for (const record of records) {
    const { view, window } = record.view;
    try {
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
    } catch (error) {
      console.warn("[desktop] failed to detach a plugin web app view", error);
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch (error) {
      console.warn("[desktop] failed to close a plugin web app view", error);
    }
  }
}

// Tells one renderer its guest died after the start already answered "ok".
// Without it the page keeps a `ready` state over an empty frame and the user
// sees a blank tab with nothing to act on. The event carries no failure text:
// the load error can embed the start URL, credential fragment included.
function notifyPluginWebAppFailed(
  sender: WebContents,
  event: PluginWebAppFailedEvent,
): void {
  if (sender.isDestroyed()) return;
  sender.send(CHANNELS.pluginWebAppFailed, PluginWebAppFailedEvent.parse(event));
}

function stopPluginWebAppsForPlugin(workspaceId: string, pluginId: string): void {
  destroyPluginWebAppViews(pluginWebAppViews.removeForPlugin(workspaceId, pluginId));
}

const withPluginHostLifecycleLock = <T>(
  key: string,
  operation: () => Promise<T>,
) => withKeyedStartLock(pluginHostLifecycleLocks, key, operation);

async function requirePluginEngineCapture(workspaceId: string) {
  const workspace = requireWorkspace(workspaceId);
  await openWorkspaceActivity(workspace);
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

function invokeWorkspacePluginSdk(input: {
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
  const workspace = requireWorkspace(input.workspaceId);
  return invokePluginSdkHost(
    {
      pluginId: input.pluginId,
      workspaceRoot: workspace.rootPath,
      spawnId: input.spawnId,
      requestPath: input.requestPath,
      // Read from the registration main holds, never from the request: what a
      // plugin may open is what its approved manifest declares.
      declaredWebApps: registeredPlugin(input.workspaceId, input.pluginId)
        ?.manifest.webApps,
      isWritable: input.isWritable,
      writeAvailable: async () => {
        try {
          const workspaceForWrite = requireWorkspace(input.workspaceId);
          await openWorkspaceActivity(workspaceForWrite);
          return Boolean(activity.engineCaptureFor(input.workspaceId));
        } catch {
          return false;
        }
      },
      signal: input.signal,
      invokeChildProcess: input.invokeChildProcess,
      subscribeFileWatch: input.subscribeFileWatch,
      unsubscribeFileWatch: input.unsubscribeFileWatch,
      writeAuthoredText: createPluginAuthoredTextWriter({
        signal: input.signal,
        requireWritableCapture: async () => {
          const { workspace: workspaceForWrite, capture } =
            await requirePluginEngineCapture(input.workspaceId);
          assertWritableWorkspace(workspaceForWrite);
          return { workspaceRoot: workspaceForWrite.rootPath, capture };
        },
        pipeline: () => pluginPipelines.get(input.workspaceId),
      }),
    },
    input.method,
    input.params,
  );
}

// A plugin this workspace can serve panels for. The registration map only
// remembers plugins a tab opened, and a view in the activity bar opens no
// tab, so the pipeline's own discovery — where the manifest actually lives —
// answers for the rest. Approval is unaffected either way: ensurePluginStarted
// still hash-verifies before it executes anything, and panels still serve from
// the approved snapshot rather than from pluginRoot.
function registeredPlugin(
  workspaceId: string,
  pluginId: string,
): RegisteredPlugin | undefined {
  const remembered = pluginRegistrations.get(workspaceId)?.get(pluginId);
  if (remembered) return remembered;
  return pluginPipelines.get(workspaceId)?.pluginRegistration(pluginId) ??
    undefined;
}

// Panels serve from the approved, hash-verified snapshot — never from
// plugin.pluginRoot (live, unverified workspace-folder source) — matching
// ensurePluginStarted's own hash-verify-before-execute gate (CERT779: a
// panel is code from this plugin as much as its process is, and the plan
// doc's userData-residency rule applies the same way).
function pluginSnapshotRoot(workspace: CreatedWorkspace, pluginId: string): string {
  return join(
    pluginDataDir(stateDir(), workspace.rootPath),
    "plugins",
    pluginIdToSafePath(pluginId),
    "snapshot",
  );
}

// Opening a panel must never execute code the install/build pipeline hasn't
// verified and built. `PluginPipeline.ensureStarted()` checks the plugin is
// enabled, its live source hash still matches its approved hash, and starts
// it from the built bundle — never from `plugin.pluginRoot`/`plugin.manifest`
// (the panel registration's own copy, read straight from live source; it
// still supplies panel entry paths elsewhere, but never plugin activation).
// The pipeline also owns per-plugin job serialization, so no separate
// pluginStarts de-dup map is needed here.
//
// It returns when the plugin can serve the caller's next request — every
// caller here makes one — which is when the host's activation settles, not
// when its process exists (#798).
async function ensurePluginStarted(
  workspace: CreatedWorkspace,
  plugin: RegisteredPlugin,
): Promise<PluginHost> {
  const pipeline = await ensurePluginPipeline(workspace);
  await startPluginForPanel({
    panelStartedHosts,
    workspaceId: workspace.workspaceId,
    pluginId: plugin.manifest.name,
    hostActivation: () => pipeline.host.activationOf(plugin.manifest.name),
    ensureStarted: () => pipeline.ensureStarted(plugin.manifest.name),
  });
  return pipeline.host;
}

async function stopRunningPluginPanelPreview(input: {
  handle: StaticDirectoryPreview;
  releaseOrigin: () => void;
}): Promise<void> {
  await stopPluginPanelPreview(
    {
      url: input.handle.url,
      stop: () => input.handle.stop(),
      releaseOrigin: input.releaseOrigin,
    },
    (options) => session.defaultSession.clearStorageData(options),
    (error) => {
      console.warn(
        `[desktop] failed to clear plugin panel storage for ${input.handle.url}`,
        error,
      );
    },
  );
}

// Releases this plugin's on-demand host claim and stops the host when that
// claim was the only reason it runs. Both close paths — the last panel and
// the last web app tab — share this accounting, so neither can stop a host
// the other still needs. Callers hold the plugin's host lifecycle lock
// (withPluginHostLifecycleLock); the claim check and the stop must not
// interleave with another open or close for the same plugin.
async function stopPluginHostIfUnclaimed(
  workspaceId: string,
  pluginId: string,
): Promise<void> {
  const hasAnotherPanel = [...runningPluginPanels.values()].some(
    (candidate) =>
      candidate.workspaceId === workspaceId && candidate.pluginId === pluginId,
  );
  if (
    !hasAnotherPanel &&
    // An open web app rides on the same host — its wrapper server dies
    // with the host's spawn, so it holds the host open exactly like a
    // sibling panel does.
    !pluginWebAppViews.hasForPlugin(workspaceId, pluginId) &&
    // Only stop the host if an on-demand open is the reason it's running at
    // all — an enabled, workspace-started plugin has no panel or tab to
    // answer to (#779 round 4 finding 3).
    panelStartedHosts.delete(pluginLifecycleKey(workspaceId, pluginId))
  ) {
    // Stops the shared host directly rather than through the pipeline's
    // disable()/enable() actions — this is "nothing needs the process right
    // now," not a user disable, so local state (disabled, approvedHash) must
    // not change. PluginHost.stop() does not itself emit a status change, so
    // the pipeline's cached status can go briefly stale here until the next
    // real status-affecting event (any action, or the next ensureStarted);
    // the pipeline never uses that cache to decide whether to start a
    // process, only to display status, so this cannot start a second process
    // for the same id.
    await pluginPipelines.get(workspaceId)?.host.stop(pluginId);
  }
}

async function stopPluginPanel(
  workspaceId: string,
  pluginId: string,
  panelId: string,
): Promise<void> {
  const key = pluginPanelKey(workspaceId, pluginId, panelId);
  pluginPanelSdkAuthorities.revokePanel(workspaceId, pluginId, panelId);
  await stopPluginPanelWithLock(
    key,
    pluginLifecycleKey(workspaceId, pluginId),
    withPluginPanelStartLock,
    withPluginHostLifecycleLock,
    async () => {
      const panel = runningPluginPanels.get(key);
      runningPluginPanels.delete(key);
      if (panel) await stopRunningPluginPanelPreview(panel);
      await stopPluginHostIfUnclaimed(workspaceId, pluginId);
    },
  );
}

async function stopPluginWebApp(
  workspaceId: string,
  pluginId: string,
  webAppId: string,
  instanceKey: string | null,
): Promise<void> {
  await withPluginWebAppStartLock(
    pluginWebAppKey(workspaceId, pluginId, webAppId, instanceKey),
    () =>
      stopPluginWebAppUnderStartLock(
        workspaceId,
        pluginId,
        webAppId,
        instanceKey,
      ),
  );
}

// The same stop for a caller that already holds this web app's start lock —
// the failed-start recovery, which unpairs and stops the view in one section.
// Taking the start lock again from inside that section would wait on itself.
async function stopPluginWebAppUnderStartLock(
  workspaceId: string,
  pluginId: string,
  webAppId: string,
  instanceKey: string | null,
): Promise<void> {
  await withPluginHostLifecycleLock(
    pluginLifecycleKey(workspaceId, pluginId),
    async () => {
      const removed = pluginWebAppViews.remove({
        workspaceId,
        pluginId,
        webAppId,
        instanceKey,
      });
      if (removed) destroyPluginWebAppViews([removed]);
      await stopPluginHostIfUnclaimed(workspaceId, pluginId);
    },
  );
}

async function stopPluginPanelsForWorkspace(workspaceId: string): Promise<void> {
  const stops: Promise<void>[] = [];
  for (const panel of [...runningPluginPanels.values()]) {
    if (panel.workspaceId !== workspaceId) continue;
    stops.push(
      stopPluginPanel(workspaceId, panel.pluginId, panel.panelId).catch((error) => {
        console.warn(
          "[desktop] failed to stop plugin panel during workspace cleanup",
          error,
        );
      }),
    );
  }
  await Promise.all(stops);
}

// Stopping the shared host is the pipeline's job (stopPluginPipelineForWorkspace
// disposes it via PluginPipeline.dispose() -> pluginHost.stopAll()); this only
// stops the panels layered on top of it.
async function stopPluginWorkspace(workspaceId: string): Promise<void> {
  destroyPluginWebAppViews(pluginWebAppViews.removeForWorkspace(workspaceId));
  await stopPluginPanelsForWorkspace(workspaceId);
  await stopPluginPipelineForWorkspace(workspaceId);
  forgetWorkspaceRegistrations(pluginRegistrations, workspaceId);
}

async function stopAllPluginWorkspaces(): Promise<void> {
  pluginPanelSdkAuthorities.revokeAll();
  destroyPluginWebAppViews(pluginWebAppViews.removeAll());
  await Promise.allSettled(
    [...new Set([
      ...pluginPipelines.keys(),
      ...[...runningPluginPanels.values()].map((panel) => panel.workspaceId),
    ])].map((workspaceId) => stopPluginWorkspace(workspaceId)),
  );
  pluginRegistrations.clear();
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
    onWrite: (workspace, target) => {
      notifyRenderer();
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

type EngineYDocArtifactAsset = NonNullable<
  WorkspaceEngineYDocProviderSession["artifactAssets"]
>[number];

function sameEngineYDocArtifactAsset(
  left: EngineYDocArtifactAsset,
  right: EngineYDocArtifactAsset,
): boolean {
  return (
    left.id === right.id &&
    left.mimeType === right.mimeType &&
    left.created === right.created &&
    left.ref === right.ref &&
    left.sha256 === right.sha256 &&
    left.lastRetrieved === right.lastRetrieved &&
    left.version === right.version
  );
}

// WS-G2-C-2 engine Y.Doc editor binding: the live node-only sessions main owns
// on the renderer's behalf, keyed by engineYDocSessionKey — the renderer-minted
// sessionId under the sender main owns. Each holds the single-canonical
// reservation for its object; closing it (renderer close, window gone, app
// quit) releases the reservation so the object can reopen.
interface EngineYDocSessionEntry {
  session: WorkspaceEngineYDocProviderSession;
  sessionId: string;
  senderId: number;
  workspaceId: string;
  // The document this session holds. A renderer retries a failed open under a
  // NEW session id, so the path — not the id — is what lets that retry find the
  // session whose close failed and release it (#657).
  path: string;
  // The renderer that owns this session, and the generation it was opened
  // under: a crash-reload reuses the WebContents id, so both are required
  // before pushing a save state back.
  sender: Electron.WebContents;
  generation: number;
  // Session-local renderer generation. It changes only when the daemon
  // replaces the durable lineage, so updates from the retired Y.Doc cannot
  // be journaled into the winner.
  lineageGeneration: number;
  // Edit/settle bookkeeping for the honest save indicator. Several settles
  // are routinely in flight at once, so this is a FIFO, not a scalar — see
  // engineYDocSaveSeq.ts.
  saveSeq: EngineYDocSaveSeqState;
  artifactAssetsById: ReadonlyMap<string, EngineYDocArtifactAsset>;
  // Descriptors from every lineage this session already replaced. A retired
  // document's recovery can retry a failed asset read after the
  // acknowledgement swapped `artifactAssetsById` to the winner, so losing
  // descriptors stay readable until the normal session close. Kept per
  // descriptor identity, not per id: successive replacements can reuse one
  // file id for different content, and each retired lineage's recovery needs
  // its own descriptor. The current lineage wins an id collision.
  retiredArtifactAssets: EngineYDocArtifactAsset[];
  // Set by releaseEngineYDocSession when a close failed. The next open of this
  // document retries the release before it binds anything.
  closeFailed?: boolean;
  // The session is closing and no longer accepts renderer updates. The entry
  // stays registered until close settles so a failed release remains owned.
  releasing?: boolean;
  // A successful delete removed this path after capture closed the engine
  // session. Main keeps the renderer entry until its normal close, but every
  // later update is an inert no-op and repeats the deleted state.
  deleted?: boolean;
}
const engineYDocSessions = new Map<string, EngineYDocSessionEntry>();
type EngineYDocLineageHandoff = {
  lineageGeneration: number;
  remoteUpdates: Uint8Array[];
  artifactAssets: readonly NonNullable<
    WorkspaceEngineYDocProviderSession["artifactAssets"]
  >[number][];
  acknowledge: () => AcknowledgeEngineYDocLineageReplacementResult;
};
const pendingEngineYDocLineageHandoffs = new Map<
  string,
  EngineYDocLineageHandoff
>();

// Every NON-QUIT teardown of an engine Y.Doc session goes through here: a
// discarded open, the close IPC, the renderer teardown. What a failed close
// means, and why the entry is kept, is stated once in
// engineYDocSessionRelease.ts. Returns true when the session was released.
function releaseEngineYDocSessionEntry(
  sessionKey: string,
  entry: EngineYDocSessionEntry,
  reason: string,
): Promise<boolean> {
  entry.releasing = true;
  pendingEngineYDocLineageHandoffs.delete(sessionKey);
  return releaseEngineYDocSession({
    sessions: engineYDocSessions,
    sessionKey,
    entry,
    reason,
    onCloseFailed: (message, error) => console.error(message, error),
  });
}

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

function notifyEngineYDocSessionsDeleted(
  workspaceId: string,
  pathOrPrefix: string,
): void {
  for (const entry of engineYDocSessions.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    if (
      entry.path !== pathOrPrefix &&
      !entry.path.startsWith(`${pathOrPrefix}/`)
    ) {
      continue;
    }
    entry.deleted = true;
    sendEngineYDocSaveState(
      entry.sender,
      entry.generation,
      entry.sessionId,
      "deleted",
      entry.saveSeq.dirtySeq,
    );
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

// Close every engine Y.Doc session owned by one renderer (window gone /
// crashed / reloading). Settles the converged state and releases each
// reservation.
async function closeEngineYDocSessionsForSender(senderId: number): Promise<void> {
  const closing: Promise<boolean>[] = [];
  for (const [sessionKey, entry] of [...engineYDocSessions]) {
    if (entry.senderId !== senderId) continue;
    closing.push(
      releaseEngineYDocSessionEntry(sessionKey, entry, "renderer teardown"),
    );
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
  pluginPanelSdkAuthorities.revokeSender(senderId);
  destroyPluginWebAppViews(pluginWebAppViews.removeForSender(senderId));
  searchRegistry.disposeOwner(senderId);
  latestSearchIdBySender.delete(senderId);
  await Promise.all([
    closeEngineYDocSessionsForSender(senderId),
    waitForPendingEngineYDocOpens(senderId),
    activeWorkspaceId
      ? stopPluginWorkspace(activeWorkspaceId)
      : Promise.resolve(),
  ]);
  // An open still in flight above registers its session AFTER that sweep read
  // the registry: the generation advanced, so the open discards the session it
  // just got, and a discard whose close FAILS registers it. Sweep once more now
  // that no open is pending, so the reload retries it instead of leaving it for
  // the next open of that path.
  await closeEngineYDocSessionsForSender(senderId);
}

// Close every live engine Y.Doc session (app quit) BEFORE the engine stores are
// stopped, so no session settles onto a closed store.
//
// The one teardown that does NOT go through releaseEngineYDocSession, and the
// only one where that is safe: keeping a failed close reachable buys a retry,
// and nothing here will ever run it — the process is going away. No surface
// follows this either, so there is no plain editor to refuse (#657).
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
  const window = trackWorkspaceWindow(
    createMainWindow({ beforeRendererReload: prepareForRendererReload }),
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
  // FIRST, synchronously (#564): a document open mid transport-retry holds
  // the capture chain, and captureStop below queues behind it. This resolves
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
  searchRegistry.killAll();
  // Here, not at before-quit: every window has closed, so every beforeunload
  // has had its chance to veto and this quit is now certain (#579 review,
  // r19). Fire-and-forget — skip locks and do not await async stops so
  // termination stays quick; child.unref() and the OS finish the cleanup.
  pluginPanelSdkAuthorities.revokeAll();
  const pluginStop = stopAllPluginWorkspaces();
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
      .then(() => pluginStop)
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
      pluginStop,
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
    // Routed like the text save (#802): a share view's create is decided at
    // the seam that would otherwise write, where `routeWorkspaceFileCreate`
    // asks `shareViewTakesLocalWrites` and refuses every level but edit.
    // Every other workspace takes the ordinary refusal, unchanged.
    const shareView = sharedViewOf(workspace.workspaceId);
    if (shareView === null) assertWritableWorkspace(workspace);
    return withStaleSensitiveWorkspaceOperation(workspace.rootPath, async () => {
      const path = await routeWorkspaceFileCreate({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        relativePath: input.relativePath,
        initialText: input.initialText,
        shareView,
        shareViewStore: () => sharedViewStoreFor(workspace),
      });
      return CreateWorkspaceFileResult.parse({ path });
    });
  });

  ipcMain.handle(CHANNELS.createWorkspaceFolder, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceFolderPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // A share view is refused here at EVERY level, as it always was — the
    // engine has no folder object, so there is no moment for a routed create
    // to write. It goes through the router only so the refusal can say that
    // instead of pointing at the granter for a change nothing could send.
    // `routeWorkspaceFolderCreate` decides on the share view's PRESENCE.
    const shareView = sharedViewOf(workspace.workspaceId);
    if (shareView === null) assertWritableWorkspace(workspace);
    return withStaleSensitiveWorkspaceOperation(workspace.rootPath, async () => {
      const path = await routeWorkspaceFolderCreate({
        rootPath: workspace.rootPath,
        relativePath: input.relativePath,
        shareView,
      });
      return CreateWorkspaceFileResult.parse({ path });
    });
  });

  ipcMain.handle(CHANNELS.moveWorkspacePath, async (event, payload) => {
    assertTrustedSender(event);
    const input = MoveWorkspacePathPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Routed like the text save (#802). See createWorkspaceFile above.
    const shareView = sharedViewOf(workspace.workspaceId);
    if (shareView === null) assertWritableWorkspace(workspace);
    return withExclusiveWorkspaceOperation(
      workspace.rootPath,
      async (markWorkspaceChanged) => {
        // Flagged workspaces coordinate single-file renames through the engine
        // FIRST so the file keeps its stable object id (linked Chats survive the
        // rename). Anything the engine declines — folders, binary, untracked —
        // returns a no-op finisher and is captured as delete+write as before.
        const capture = activity.engineCaptureFor(workspace.workspaceId);
        // An engine rename preserves the stable object and its Y.Doc kind,
        // but the editor for the new path is chosen by suffix. A rename out
        // of a live kind strands the document between them: a drawing
        // renamed `.md` hands its portable JSON to a raw autosave editor
        // beside the still-canonical scene, and a drawing renamed `.txt`
        // keeps a scene lineage no text editor or Markdown fold can update.
        // Kind changes go through a new file, not a rename.
        const fromKind = liveDocumentKindForPath(input.fromPath);
        const toKind = liveDocumentKindForPath(input.toPath);
        // A share view's rename keeps the object too — it renames the engine
        // record — so it takes the same refusal. Its files have no capture.
        const keepsTheObject = capture !== null || shareView !== null;
        if (keepsTheObject && fromKind !== null && fromKind !== toKind) {
          throw new Error(
            `A rename cannot change a live document's kind from ${fromKind} to ${toKind ?? "a plain file"}. Create a new file and copy the content instead.`,
          );
        }
        const finishRename = capture
          ? await capture.beginFileRename(input.fromPath, input.toPath)
          : null;
        try {
          const path = await routeWorkspacePathMove({
            workspaceId: workspace.workspaceId,
            rootPath: workspace.rootPath,
            fromPath: input.fromPath,
            toPath: input.toPath,
            shareView,
            shareViewStore: () => sharedViewStoreFor(workspace),
          });
          markWorkspaceChanged();
          await finishRename?.(true);
          return CreateWorkspaceFileResult.parse({ path });
        } catch (error) {
          await finishRename?.(false);
          throw error;
        }
      },
    );
  });

  ipcMain.handle(CHANNELS.deleteWorkspacePath, async (event, payload) => {
    assertTrustedSender(event);
    const input = DeleteWorkspacePathPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Routed like the text save (#802). See createWorkspaceFile above.
    const shareView = sharedViewOf(workspace.workspaceId);
    if (shareView === null) assertWritableWorkspace(workspace);
    return withExclusiveWorkspaceOperation(
      workspace.rootPath,
      async (markWorkspaceChanged) => {
        // WS-G2-C-2 (gate fix 3): a live Y.Doc session over the path being removed
        // would, on a later settle, resurrect the file / orphan the object. Flush +
        // release it (and any session under a deleted folder) BEFORE the disk delete
        // so no stale settle can write the old path afterward.
        const finishDebts = await activity
          .engineCaptureFor(workspace.workspaceId)
          ?.settleAndCloseLiveSessionsForPath(input.relativePath);
        // shell.trashItem first (recoverable on every platform); deletePath
        // falls back to the workspace's .dohc/trash where the OS rejects
        // (cross-filesystem mounts) — never a hard delete either way.
        //
        // The finisher takes the OUTCOME (#595): a pending locked write is
        // cancelled only once the path is provably gone. The same no-share
        // handle that blocks the write can block the trash and the fallback
        // move, and a failed delete leaves a file that still owes its write.
        try {
          const result = await routeWorkspacePathDelete({
            workspaceId: workspace.workspaceId,
            rootPath: workspace.rootPath,
            relativePath: input.relativePath,
            trashItem: (p) => shell.trashItem(p),
            shareView,
            shareViewStore: () => sharedViewStoreFor(workspace),
          });
          markWorkspaceChanged();
          // `deletePath` matches its own disk target against the CANONICAL form
          // `validateUserWritePath` normalizes to (a trailing slash stripped, for
          // example) — but the schema for this payload does not enforce that
          // normalization, so a raw "notes/" would otherwise widen its own
          // prefix match to "notes//" and miss every live session under it.
          const validatedDeletePath = validateUserWritePath(input.relativePath);
          notifyEngineYDocSessionsDeleted(
            workspace.workspaceId,
            validatedDeletePath.ok
              ? validatedDeletePath.normalized
              : input.relativePath,
          );
          finishDebts?.(true);
          return DeleteWorkspacePathResult.parse(result);
        } catch (error) {
          finishDebts?.(false);
          throw error;
        }
      },
    );
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
      // The menu's shape is decided by `explorerMenuEntries`, where it can be
      // driven at every level; main owns only the Electron plumbing. main
      // still owns the MENU, so a renderer cannot add an item back.
      const registryEntry = findWorkspace(input.workspaceId);
      const shareView = sharedViewOf(input.workspaceId);
      const isSharedView = shareView !== null;
      // Share-mount paths (shared-with-me/…) are a read-only projection of
      // someone else's files. The mount root itself (shared-with-me/<label>
      // with a matching mount record) additionally offers refresh and removal.
      const isMountPath =
        !isSharedView && !!input.path && isSharedWithMePath(input.path);
      const mountForPath = isMountPath
        ? (registryEntry?.shareMounts ?? []).find(
            (mount) => input.path === `shared-with-me/${mount.label}`,
          )
        : undefined;
      const template: Electron.MenuItemConstructorOptions[] = explorerMenuEntries({
        kind: input.kind,
        pinned: input.pinned === true,
        isMountPath,
        hasMountRecord: mountForPath !== undefined,
        // Sharing onward is offered nowhere in a share view or a mount:
        // someone else's files are not this account's to grant, and a share
        // needs a relay-side workspace to grant from.
        canShare:
          !isSharedView && !isMountPath && !!registryEntry?.remote && input.kind !== "root",
        shareView,
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

    return ShowWorkbenchMenuResult.parse(chosen);
  });

  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    // Routed like the text save (#802). See createWorkspaceFile above.
    const shareView = sharedViewOf(workspace.workspaceId);
    if (shareView === null) assertWritableWorkspace(workspace);
    const importInto = (
      absolutePaths: string[],
      screenAgainstRoots: string[] | null,
    ) =>
      withStaleSensitiveWorkspaceOperation(workspace.rootPath, () =>
        routeWorkspaceFileImport({
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          absolutePaths,
          screenAgainstRoots,
          targetDir: input.targetDir,
          shareView,
          shareViewStore: () => sharedViewStoreFor(workspace),
        }),
      );
    // OS drag-in path: renderer-supplied absolute paths (see the trust-delta
    // note on the payload) re-validated by the drag-in screen — regular
    // files only, never any registered workspace's .dohc metadata. The
    // renderer-supplied targetDir is re-validated inside the import path
    // (resolveImportDestination) before any copy.
    const droppedPaths = input.droppedPaths;
    if (droppedPaths !== undefined) {
      return ImportWorkspaceFilesResult.parse(
        await importInto(
          droppedPaths,
          listWorkspaces().map((ws) => ws.rootPath),
        ),
      );
    }
    const picked = testImportPaths();
    const result =
      picked === null
        ? await dialog.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            title: "Import files into workspace",
          })
        : { canceled: false, filePaths: picked };
    if (result.canceled) {
      return ImportWorkspaceFilesResult.parse({ imported: [], skipped: 0 });
    }
    return ImportWorkspaceFilesResult.parse(await importInto(result.filePaths, null));
  });

  // Plugin SDK reads use the combined helper to make the main-process
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
    // The ONE write a share view admits, and the only handler that does not
    // take the blanket refusal (#646 PR3). A share view's text save is
    // decided at the seam that would otherwise write —
    // `routeWorkspaceTextWrite` asks `shareViewTakesLocalWrites` and throws
    // `SharedFileReadOnlyError` for every level but edit, for an ended share,
    // and for a grant this process cannot read. Every OTHER workspace takes
    // the ordinary refusal, unchanged.
    const shareView = sharedViewOf(workspace.workspaceId);
    if (shareView === null) assertWritableWorkspace(workspace);
    const writePath = validateUserWritePath(input.relativePath);
    for (const entry of engineYDocSessions.values()) {
      if (
        writePath.ok &&
        entry.workspaceId === workspace.workspaceId &&
        entry.path === writePath.normalized
      ) {
        throw new Error(
          "The engine owns this live document. Close its editor before writing the file directly.",
        );
      }
    }
    return WriteWorkspaceTextResult.parse(
      await routeWorkspaceTextWrite({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        relativePath: input.relativePath,
        text: input.text,
        expectedContentHash: input.expectedContentHash,
        shareView,
        shareViewStore: () => sharedViewStoreFor(workspace),
      }),
    );
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
    await runCloudLogoutTransition({
      clearCachedCredentials: () => clearCachedCredentials(),
      logout: () => cloudLogin().logout(),
      stopEngines: () => activity.stopEngines(),
      closeRelayTransportWorkspaces: () => closeAllRelayTransportWorkspaces(),
      notifyWorkspaceActivity: () => notifyRenderer(),
      // Logout is a one-event transition to a known state: signed out. The
      // key change is what makes every view clear and refresh.
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
    });
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
    if (shareViewIsPresent(entry.shareView)) {
      throw new Error("This is a shared view — only the original workspace can be shared.");
    }
    const { remote } = await remoteForWorkspace(input.workspaceId);
    const created = await relayShareJson<{ shareId: string }>(
      `/sync/${encodeURIComponent(remote.remoteWorkspaceId)}/shares`,
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
      "Chats",
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
  function joinedChannelAnswers(workspaceId: string, channelWireIds: readonly string[]) {
    const entry = requireWorkspace(workspaceId);
    return scopeJoinedChannels(entry.sharedChannels ?? [], channelWireIds);
  }

  ipcMain.handle(
    CHANNELS.listJoinedSharedChannels,
    createListJoinedSharedChannelsIpcHandler({
      assertTrustedSender,
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
    relay: SyncRelayConnection;
    shareId: string;
    workspaceId: string;
    rootPath: string;
    recipientUserId: string;
    relayUrl: string;
    preWrite?: (info: { channelWireId: string }) => void;
  }): Promise<JoinedSharedChannel> {
    return reserveAndPullSharedChannel({
      ...input,
      readSharedChannels: (workspaceId) =>
        findWorkspace(workspaceId)?.sharedChannels ?? [],
      writeSharedChannels: setWorkspaceSharedChannels,
      fetchInfo: fetchSharedChannelInfo,
      pull: ({ workspaceId, rootPath, relay, shareId, channelWireId }) =>
        relayClientForWorkspace({ workspaceId, rootPath, relay }).pullSharedChannel({
          shareId,
          channelWireId,
        }),
      serialize: serializeSharedChannelSync,
      afterPull: projectPendingChatBookmarksAfterPull,
    });
  }

  ipcMain.handle(CHANNELS.listChatChannelShares, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelSharesPayload.parse(payload);
    const entry = requireWorkspace(input.workspaceId);
    // Relay-side listings need a signed-in session; without one the local
    // joined set still answers (their local copies keep working offline), and
    // the relay side reports signed-out or unreachable instead of posing as
    // an empty listing.
    //
    // ONE credentials snapshot serves both the fetch and the session key, so
    // the key always names the session the request actually used — a login
    // or switch landing mid-flight cannot drift them apart.
    await warmCredentialCache();
    const credentials = cachedCredentials;
    const shareIdsClaimedElsewhere = shareIdsClaimedByOtherWorkspaces(input.workspaceId);
    const relay = await readRelayChatShareLanes({
      fetchListing: async () => {
        if (!credentials) throw new RelaySessionError("Sign in to dohc Cloud first.");
        const listing = await relayShareJsonWithCredentials<{
          granted?: Array<Record<string, unknown>>;
          received?: Array<Record<string, unknown>>;
        }>(credentials, "/sync/shares");
        const receivedShareIds = Array.isArray(listing.received)
          ? listing.received.flatMap((row) => {
              const selector = row.selector as { kind?: unknown } | undefined;
              return selector?.kind === "chat-channel" && typeof row.shareId === "string"
                ? [row.shareId]
                : [];
            })
          : [];
        // This adds bounded relay reads only for uncached grants. The one-time
        // cost closes the request-gate window before the first syncDms poll.
        await resolveDmKinds({
          shareIds: receivedShareIds,
          cache: peekedReceivedGrantKinds,
          peekKind: (shareId) =>
            peekReceivedGrantKindForShare(
              {
                baseUrl: normalizeServerUrl(credentials.relayUrl!),
                token: credentials.token,
                fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
              },
              shareId,
            ),
        });
        for (const shareId of shareIdsToWithholdFromOrdinaryInvites({
          shareIds: receivedShareIds,
          cache: peekedReceivedGrantKinds,
        })) {
          shareIdsClaimedElsewhere.add(shareId);
        }
        return listing;
      },
      remoteWorkspaceId: entry.remote?.remoteWorkspaceId ?? null,
      shareIdsClaimedElsewhere,
    });
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
      joined: joinedChannelAnswers(input.workspaceId, shownWireIds),
      sessionKey:
        relay.state === "signed-out" ? null : chatShareSessionKey(credentials),
      relay,
    });
  });

  ipcMain.handle(CHANNELS.joinSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = JoinSharedChannelPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const entry = requireWorkspace(input.workspaceId);
    if (shareViewIsPresent(entry.shareView)) {
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
    let joined: JoinedSharedChannel;
    try {
      joined = await reserveAndPullSharedChannelForWorkspace({
        relay,
        shareId: input.shareId,
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        recipientUserId: joinedRecipientUserId,
        relayUrl: joinedRelayUrl,
      });
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        throw new Error("That shared channel isn't available anymore.");
      }
      throw error;
    }
    return JoinSharedChannelResult.parse({ joined: { ...joined, ended: false } });
  });

  // Member-initiated leave: purely local — the channel stops syncing and its
  // rows stay readable. Keep an ended tombstone so participant provenance and
  // the read-only write gate survive after live grant data is gone. Shared by
  // leaveSharedChannel and leaveDm (#742) — a DM's accepted row IS a
  // JoinedSharedChannel row in the same registry, so ending it is the same
  // operation regardless of which surface asked.
  function endWorkspaceJoinedChannel(workspaceId: string, shareId: string): void {
    const entry = requireWorkspace(workspaceId);
    setWorkspaceSharedChannels(
      workspaceId,
      endJoinedChannel(entry.sharedChannels ?? [], shareId),
    );
  }

  ipcMain.handle(CHANNELS.leaveSharedChannel, async (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveSharedChannelPayload.parse(payload);
    endWorkspaceJoinedChannel(input.workspaceId, input.shareId);
    return undefined;
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
    const workspace = requireWorkspace(input.workspaceId);
    if (input.shareId === undefined && !shareViewIsPresent(workspace.shareView)) {
      throw new Error("This workspace is not a shared view.");
    }
    if (
      input.shareId !== undefined &&
      !(workspace.shareMounts ?? []).some(
        (mount) => mount.shareId === input.shareId,
      )
    ) {
      throw new Error("That share is not mounted in this workspace.");
    }
    acknowledgeWorkspaceShareSkips(
      workspace.workspaceId,
      input.shareId,
      input.generation,
    );
    notifyRenderer();
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

  // The GRANTER lane's target. `remoteForWorkspace` already refuses an
  // unsynced workspace, a signed-out session, and a session on the wrong
  // account or server, so the only rule this adds is the lane split.
  async function requireShareProposalGranter(workspaceId: string): Promise<{
    relay: SyncRelayConnection;
    remoteWorkspaceId: string;
  }> {
    assertShareProposalGranter(requireWorkspace(workspaceId).shareView);
    const { remote, credentials } = await remoteForWorkspace(workspaceId);
    if (!credentials.relayUrl) {
      throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
    }
    return {
      relay: {
        baseUrl: normalizeServerUrl(credentials.relayUrl),
        token: credentials.token,
        fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
      },
      remoteWorkspaceId: remote.remoteWorkspaceId,
    };
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
  async function requireShareProposalRecipient(
    workspaceId: string,
    resolveScope: (shareView: unknown) => ShareViewProposalScope,
  ): Promise<{
    workspace: RegistryEntry;
    shareId: string;
    grant: ShareViewSelector;
    relay: SyncRelayConnection;
  }> {
    const workspace = requireWorkspace(workspaceId);
    const scope = resolveScope(workspace.shareView);
    await warmCredentialCache();
    const credentials = cachedCredentials;
    if (!credentials?.relayUrl) throw new Error("Sign in to dohc Cloud first.");
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
      workspace,
      ...scope,
      relay: {
        baseUrl: normalizeServerUrl(credentials.relayUrl),
        token: credentials.token,
        fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
      },
    };
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
    remoteWorkspaceId: string,
    op: ShareProposalOp,
  ): Promise<string | null> {
    // A delete has no after side, and binary content is not something a text
    // diff can show. Both are "no incoming text", which the review states.
    if (op.operation === "delete" || !op.afterBlobSha256) return null;
    if (op.afterContentKind !== "text") return null;
    try {
      const response = await (relay.fetch ?? fetch)(
        `${relay.baseUrl}/sync/${encodeURIComponent(remoteWorkspaceId)}/blobs/` +
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

  // The proposals waiting on this granter, as SUMMARIES. Opening one review
  // reads that proposal by id rather than this whole set.
  async function openShareProposals(workspaceId: string): Promise<{
    workspace: RegistryEntry;
    target: { relay: SyncRelayConnection; remoteWorkspaceId: string };
    proposals: ShareProposalSummary[];
  }> {
    const workspace = requireWorkspace(workspaceId);
    const target = await requireShareProposalGranter(workspaceId);
    return {
      workspace,
      target,
      proposals: await listShareProposals({
        relay: target.relay,
        workspaceId: target.remoteWorkspaceId,
      }),
    };
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
    const { proposals } = await openShareProposals(input.workspaceId);
    return ListShareProposalsResult.parse({
      proposals: proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        shareId: proposal.shareId,
        proposedByEmail: proposal.proposedByEmail,
        createdAtMs: proposal.createdAtMs,
        ops: proposal.ops,
      })),
    });
  });

  ipcMain.handle(CHANNELS.readShareProposalChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadShareProposalChangesPayload.parse(payload);
    const target = await requireShareProposalGranter(input.workspaceId);
    // ONE proposal, named. Reading the whole open set to find it made opening
    // a review cost every other review's file rows as well.
    const proposal = await readShareProposal({
      relay: target.relay,
      workspaceId: target.remoteWorkspaceId,
      proposalId: input.proposalId,
    });
    // Metadata only. Content is fetched per file, when the granter opens it.
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
  });

  ipcMain.handle(CHANNELS.readShareProposalFileContent, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadShareProposalFileContentPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const target = await requireShareProposalGranter(input.workspaceId);
    // ONE op, resolved by the relay from ids this process holds. The renderer
    // states a position, never a path — the granter's own files are what the
    // local half of this read opens.
    const op = await readShareProposalOp({
      relay: target.relay,
      workspaceId: target.remoteWorkspaceId,
      proposalId: input.proposalId,
      opIndex: input.opIndex,
    });
    // The two sides come from two different places on purpose: the granter's
    // own file is read locally, at the path the granter holds it NOW, and the
    // incoming side is the proposal's after-blob, which lives at the relay and
    // has never touched this machine's files.
    return ReadShareProposalFileContentResult.parse({
      currentText:
        op.currentPath === null
          ? null
          : await readWorkspaceText(workspace.rootPath, op.currentPath).then(
              (read) => (read.truncated ? null : read.text),
              // A file this surface cannot read as text is "no current side",
              // which the review states rather than failing.
              () => null,
            ),
      incomingText: await shareProposalIncomingText(
        target.relay,
        target.remoteWorkspaceId,
        op,
      ),
    });
  });

  ipcMain.handle(CHANNELS.settleShareProposal, async (event, payload) => {
    assertTrustedSender(event);
    const input = SettleShareProposalPayload.parse(payload);
    const target = await requireShareProposalGranter(input.workspaceId);
    const settled = await settleShareProposal({
      relay: target.relay,
      workspaceId: target.remoteWorkspaceId,
      proposalId: input.proposalId,
      decision: input.decision,
    });
    if (settled.state !== "accepted" && settled.state !== "declined") {
      // The relay answered with a state this decision cannot have produced —
      // a withdraw that won the race, or a protocol this client does not
      // speak. Either way the granter's screen must not claim it settled.
      throw new Error("Those changes are no longer open. Refresh, then try again.");
    }
    // Accepted changes reach this workspace over the owner lane it already
    // polls, so nudge that lane instead of applying anything here.
    if (settled.state === "accepted") activity.queueCloudSync(input.workspaceId);
    return SettleShareProposalResult.parse({ state: settled.state });
  });

  ipcMain.handle(CHANNELS.submitShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = SubmitShareChangesPayload.parse(payload);
    // SENDING needs the edit level.
    const scope = await requireShareProposalRecipient(
      input.workspaceId,
      requireShareViewProposalScope,
    );
    // The engine owns the submit: it reads this replica's own journal, so it
    // has to be the process holding the store.
    const result = await relayClientForWorkspace({
      workspaceId: scope.workspace.workspaceId,
      rootPath: scope.workspace.rootPath,
      relay: scope.relay,
    }).submitShareProposal({
      shareId: scope.shareId,
      grantedSelector: scope.grant,
      // PR3a mints a fresh key per submit. It makes the relay's idempotency
      // hold for a retry INSIDE one submit (blobs, then the POST), not for a
      // second press: a second press sends whatever is pending then, which is
      // a second set of changes and a second proposal.
      submitId: randomUUID(),
    });
    return SubmitShareChangesResult.parse(result);
  });

  ipcMain.handle(CHANNELS.listMyShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListMyShareChangesPayload.parse(payload);
    // SEEING what was already sent needs membership only: a downgrade must
    // not hide the changes it can no longer add to.
    const scope = await requireShareProposalRecipient(
      input.workspaceId,
      requireShareViewMembership,
    );
    const proposals = await listMyShareProposals({
      relay: scope.relay,
      shareId: scope.shareId,
    });
    return ListMyShareChangesResult.parse({
      proposals: proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        state: proposal.state,
        createdAtMs: proposal.createdAtMs,
        files: proposal.ops,
      })),
    });
  });

  ipcMain.handle(CHANNELS.withdrawShareChanges, async (event, payload) => {
    assertTrustedSender(event);
    const input = WithdrawShareChangesPayload.parse(payload);
    // TAKING BACK needs membership only, for the same reason.
    const scope = await requireShareProposalRecipient(
      input.workspaceId,
      requireShareViewMembership,
    );
    const settled = await withdrawShareProposal({
      relay: scope.relay,
      shareId: scope.shareId,
      proposalId: input.proposalId,
    });
    if (settled.state !== "withdrawn") {
      // The granter settled it first. Saying "withdrawn" here would tell the
      // recipient their changes are back when the granter already has them.
      throw new Error("Those changes were already answered. Refresh to see the result.");
    }
    return WithdrawShareChangesResult.parse({ state: settled.state });
  });

  // Where a share pull's refusals become durable. Called before the cursor
  // that skips past them is committed, so a later page that fails cannot take
  // an earlier page's reason with it, and a restart still shows it. Merging is
  // idempotent by origin coordinate, because a re-fetched page repeats
  // refusals the record already holds.
  //
  // Persist per PAGE, notify per PULL: see createShareSkipRecorder, which
  // holds no notifier at all. Each pull site below broadcasts once, when it
  // settles.
  function recordShareViewRefusals(
    workspaceId: string,
  ): (refusals: readonly ShareViewRefusal[]) => Promise<void> {
    return createShareSkipRecorder({
      current: () => findWorkspace(workspaceId)?.shareView,
      persist: (next) => setWorkspaceShareView(workspaceId, next),
    });
  }

  // The same durable record for a MOUNTED share, on the mount's own row.
  function recordShareMountRefusals(
    workspaceId: string,
    shareId: string,
  ): (refusals: readonly ShareViewRefusal[]) => Promise<void> {
    return createShareSkipRecorder({
      current: () =>
        findWorkspace(workspaceId)?.shareMounts?.find(
          (mount) => mount.shareId === shareId,
        ),
      persist: (next) =>
        setWorkspaceShareMounts(
          workspaceId,
          (findWorkspace(workspaceId)?.shareMounts ?? []).map((mount) =>
            mount.shareId === shareId ? next : mount,
          ),
        ),
    });
  }

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
      // Before the first pull: a share view that writes back needs its own
      // sync identity, and the pull is what gives it the share cursor that
      // makes local writes journal.
      //
      // SOFT, like the refresh site. Opening a share is a read, and a failure
      // here costs the recipient the ability to send changes, not the ability
      // to open what they were given. The next refresh records it.
      await recordShareViewIdentity(requireWorkspace(created.workspaceId)).catch(
        (error) => {
          console.error("[desktop] share view identity:", error);
        },
      );
      const outcome = await refreshSharedViewOnce({
        rootDir: created.rootPath,
        workspaceId: created.workspaceId,
        relay,
        shareId: parsed.shareId,
        store: sharedViewStoreFor(created),
        // Just pinned on the record above; the refresh reads it back through
        // the same defensive parse every later refresh uses.
        pinnedSelector: info.selector,
        recordRefusals: recordShareViewRefusals(created.workspaceId),
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
            recordRefusals: input.recordRefusals,
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
    const workspace = requireWorkspace(input.workspaceId);
    const shareView = workspace.shareView;
    if (!shareView) throw new Error("This workspace is not a shared view.");
    if (shareView.ended) {
      return RefreshSharedViewResult.parse({
        status: "ended",
        changedPaths: 0,
        refusedOps: 0,
        refusedDetail: null,
      });
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
      return RefreshSharedViewResult.parse({
        status: "unchanged",
        changedPaths: 0,
        refusedOps: 0,
        refusedDetail: null,
      });
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
    // #646 PR2: the backstop this share's chat push docstring claims. A push
    // that failed — offline, a rotated session, a relay blip — is retried
    // here, before the pull, so a refresh drains the backlog instead of
    // leaving it until the recipient happens to write again.
    // Before the push, because the push needs the identity this writes. A
    // share view opened before #646 PR3-1 has none, and this is where it gains
    // one.
    await recordShareViewIdentity(workspace).catch((error) => {
      console.error("[desktop] share view enrolment:", error);
    });
    await pushShareViewChat(workspace).catch((error) => {
      console.error("[desktop] share view chat push (refresh backstop):", error);
    });
    try {
      outcome = await refreshSharedViewOnce({
        rootDir: workspace.rootPath,
        workspaceId: workspace.workspaceId,
        relay,
        shareId: shareView.shareId,
        store: sharedViewStoreFor(workspace),
        pinnedSelector: shareView.grantedSelector,
        recordRefusals: recordShareViewRefusals(workspace.workspaceId),
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
            recordRefusals: input.recordRefusals,
          }),
      });
    } catch (error) {
      // A pull that failed on a later page still persisted the refusals its
      // earlier pages recorded, so the renderer is told once here too.
      notifyRenderer();
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
      //
      // Merged into the CURRENT record, never the pre-pull snapshot above:
      // the pull that ended may have recorded refusals on its way, and
      // writing the snapshot back would drop them.
      endWorkspaceShareView(workspace.workspaceId);
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
        recordRefusals: recordShareMountRefusals(
          workspace.workspaceId,
          parsed.shareId,
        ),
        pull: async (input) =>
          await daemonRelay.pullShareView({
            shareId: input.shareId,
            grantedSelector: input.grantedSelector,
            recordRefusals: input.recordRefusals,
          }),
      });
      if (outcome.status === "ended") throw new ShareUnavailableError();
      refreshNativeWorkspaceSurfaces();
      notifyRenderer();
      return MountShareResult.parse({
        // Through the PROJECTION: a raw registry record nests each mount's
        // level under its pinned grant, so a raw parse cannot satisfy the
        // wire schema and every mount would fail here and roll back.
        workspace: workspaceSummaryFor(requireWorkspace(workspace.workspaceId)),
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
      status: "updated" | "unchanged" | "ended" | "damaged";
      changedPaths: number;
    }> = [];
    // Every row goes through the bounded builder. A record whose identity the
    // wire schema cannot carry is dropped from the REPORT rather than allowed
    // to fail the parse at the end and discard every other mount's status.
    const pushMountResult = (
      mount: { shareId: unknown; label: unknown },
      status: "updated" | "unchanged" | "ended" | "damaged",
      changedPaths: number,
    ): void => {
      const row = shareMountResultRow({
        shareId: mount.shareId,
        label: mount.label,
        status,
        changedPaths,
      });
      if (row) results.push(row);
    };
    if (mounts.length === 0) {
      return RefreshShareMountsResult.parse({ results });
    }
    await warmCredentialCache().catch(() => undefined);
    // ONE credentials snapshot for the whole loop: a sign-out/sign-in while
    // an awaited refresh runs must never pair the old relay URL with a new
    // account's token (gpt-5.6-sol P1).
    const credentials = cachedCredentials;
    // One notification for the whole pass, in a finally: mounts whose pulls
    // persisted refusals before a later mount threw must still reach the UI,
    // and the per-page recorders deliberately broadcast nothing.
    try {
    for (const mount of mounts) {
      if (mount.ended) {
        pushMountResult(mount, "ended", 0);
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
        pushMountResult(mount, "unchanged", 0);
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
          recordRefusals: recordShareMountRefusals(
            workspace.workspaceId,
            mount.shareId,
          ),
          pull: async (input) =>
            await daemonRelay.pullShareView({
              shareId: input.shareId,
              grantedSelector: input.grantedSelector,
              recordRefusals: input.recordRefusals,
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
        pushMountResult(mount, outcome.status, outcome.changedPaths);
      } catch (error) {
        // An expired session must SURFACE, not read as "refreshed, nothing
        // new" — a manual Refresh Share would otherwise report success
        // forever while every pull 401s (codex P2).
        const verdict = classifyShareMountRefreshError(error);
        if (verdict.kind === "abort") throw new Error(verdict.message);
        // One mount's failure must not stop the others.
        console.error(`[desktop] share-mount refresh failed for ${mount.label}:`, error);
        pushMountResult(mount, verdict.status, 0);
      }
    }
    return RefreshShareMountsResult.parse({ results });
    } finally {
      notifyRenderer();
    }
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
    // A record whose label this app would never materialize through gets
    // RECORD cleanup only. Deleting a folder named by an unusable label is
    // the exact move the validator exists to refuse, so the record goes and
    // the folder is reported, never touched. Without this the record could
    // not be removed at all: the folder path would throw and strand it.
    const folderRemovable = validMountLabel(mount.label);
    if (folderRemovable) {
      await removeMountFolder(workspace.rootPath, mount.label);
    }
    const current = findWorkspace(workspace.workspaceId)?.shareMounts ?? [];
    setWorkspaceShareMounts(
      workspace.workspaceId,
      current.filter((m) => m.shareId !== mount.shareId),
    );
    refreshNativeWorkspaceSurfaces();
    notifyRenderer();
    return UnmountShareResult.parse({
      workspace: workspaceSummaryFor(requireWorkspace(workspace.workspaceId)),
      ...(folderRemovable ? {} : { folderLeft: true as const }),
    });
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

  ipcMain.handle(CHANNELS.openPluginPanel, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenPluginPanelPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const sender = event.sender;
    const generation = rendererGeneration(sender.id);
    const isCurrent = () =>
      !sender.isDestroyed() &&
      rendererGeneration(sender.id) === generation &&
      activeWorkspaceIdBySender.get(sender.id) === workspace.workspaceId;
    assertPluginPanelRequestCurrent(isCurrent);
    assertWritableWorkspace(workspace);
    const registration = await loadPluginPanelRegistrationForCurrentRenderer(
      () =>
        loadPluginPanelRegistration({
          workspaceRoot: workspace.rootPath,
          pluginRoot: input.pluginRoot,
          pluginId: input.pluginId,
          panelId: input.panelId,
        }),
      isCurrent,
    );
    assertWritableWorkspace(workspace);
    const plugin = rememberPluginRegistration(
      pluginRegistrations,
      workspace.workspaceId,
      registration,
    );
    await withPluginPanelStartLock(
      pluginPanelKey(workspace.workspaceId, input.pluginId, input.panelId),
      () =>
        withPluginHostLifecycleLock(
          pluginLifecycleKey(workspace.workspaceId, input.pluginId),
          () => {
            assertPluginPanelRequestCurrent(isCurrent);
            assertWritableWorkspace(workspace);
            return ensurePluginStarted(workspace, plugin);
          },
        ),
    );
    return OpenPluginPanelResult.parse({
      pluginId: input.pluginId,
      panelId: input.panelId,
    });
  });

  ipcMain.handle(CHANNELS.startPluginPanel, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartPluginPanelPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const sender = event.sender;
    const generation = rendererGeneration(sender.id);
    const isCurrent = () =>
      !sender.isDestroyed() &&
      rendererGeneration(sender.id) === generation &&
      activeWorkspaceIdBySender.get(sender.id) === workspace.workspaceId;
    if (!isCurrent()) {
      throw new Error(
        "The plugin panel request does not target the active workspace. Open the workspace and try again.",
      );
    }
    assertWritableWorkspace(workspace);
    const plugin = registeredPlugin(workspace.workspaceId, input.pluginId);
    if (!plugin) {
      return StartPluginPanelResult.parse({ status: "not-registered" });
    }
    const panel = plugin.manifest.panels?.find(
      (candidate) => candidate.id === input.panelId,
    );
    if (!panel) {
      throw new Error(
        `Plugin "${input.pluginId}" does not declare panel "${input.panelId}".`,
      );
    }
    // One panel runs once per workspace, so it belongs in one place. A tab
    // restored from before an update can still name a panel the plugin has
    // since moved to the view rail.
    if (panel.placement !== input.placement) {
      throw new Error(
        `Plugin "${input.pluginId}" panel "${input.panelId}" has placement ` +
          `"${panel.placement}", so it cannot open with placement ` +
          `"${input.placement}".`,
      );
    }
    const key = pluginPanelKey(
      workspace.workspaceId,
      input.pluginId,
      input.panelId,
    );
    return startPluginPanelWithLock(
      key,
      pluginLifecycleKey(workspace.workspaceId, input.pluginId),
      withPluginPanelStartLock,
      withPluginHostLifecycleLock,
      () => ensurePluginStarted(workspace, plugin),
      async (host) => {
        const spawnId = host.getSpawnId(input.pluginId);
        if (!spawnId) {
          throw new Error(`Plugin "${input.pluginId}" has no active process.`);
        }
        pluginPanelSdkAuthorities.revokePanel(
          workspace.workspaceId,
          input.pluginId,
          input.panelId,
        );
        const previous = runningPluginPanels.get(key);
        runningPluginPanels.delete(key);
        if (previous) {
          await stopRunningPluginPanelPreview(previous);
        }

        const snapshotRoot = pluginSnapshotRoot(workspace, input.pluginId);
        const entryPath = join(snapshotRoot, panel.entry);
        const handle = await startStaticDirectoryPreview(dirname(entryPath), {
          containmentRoot: snapshotRoot,
          entry: basename(entryPath),
          entryLabel: "plugin panel entry",
        });
        if (!isCurrent()) {
          await stopRunningPluginPanelPreview({
            handle,
            releaseOrigin: () => undefined,
          });
          throw new Error(
            "Plugin panel start was cancelled because the renderer changed.",
          );
        }
        const releaseOrigin = allowLoopbackFrameOrigin(handle.url);
        runningPluginPanels.set(key, {
          handle,
          releaseOrigin,
          workspaceId: workspace.workspaceId,
          pluginId: input.pluginId,
          panelId: input.panelId,
          senderId: sender.id,
          generation,
        });
        pluginPanelSdkAuthorities.register({
          senderId: sender.id,
          generation,
          workspaceId: workspace.workspaceId,
          pluginId: input.pluginId,
          panelId: input.panelId,
        });
        return StartPluginPanelResult.parse({
          status: "ok",
          url: handle.url,
          title: panel.title,
        });
      },
    );
  });

  ipcMain.handle(CHANNELS.stopPluginPanel, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopPluginPanelPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    if (activeWorkspaceIdBySender.get(event.sender.id) !== workspace.workspaceId) {
      throw new Error(
        "The plugin panel stop request does not target the active workspace.",
      );
    }
    const panel = runningPluginPanels.get(
      pluginPanelKey(workspace.workspaceId, input.pluginId, input.panelId),
    );
    if (
      panel &&
      (panel.senderId !== event.sender.id ||
        panel.generation !== rendererGeneration(event.sender.id))
    ) {
      throw new Error(
        "The plugin panel stop request does not belong to this renderer.",
      );
    }
    await stopPluginPanel(
      workspace.workspaceId,
      input.pluginId,
      input.panelId,
    );
  });

  ipcMain.handle(CHANNELS.invokePluginPanelSdk, async (event, payload) => {
    assertTrustedSender(event);
    const input = InvokePluginPanelSdkPayload.parse(payload);
    const sender = event.sender;
    const key = pluginPanelKey(
      input.workspaceId,
      input.pluginId,
      input.panelId,
    );
    const panel = runningPluginPanels.get(key);
    const host = pluginPipelines.get(input.workspaceId)?.host;
    const liveSpawnId = host?.getSpawnId(input.pluginId);
    const generation = rendererGeneration(sender.id);
    const panelRunning = Boolean(
      panel &&
        panel.senderId === sender.id &&
        panel.generation === generation &&
        Boolean(liveSpawnId),
    );
    const authority = pluginPanelSdkAuthorities.authorize({
      senderId: sender.id,
      generation,
      activeWorkspaceId: activeWorkspaceIdBySender.get(sender.id),
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      panelId: input.panelId,
      panelRunning,
      liveSpawnId,
    });
    const result = await invokeWorkspacePluginSdk({
      workspaceId: authority.workspaceId,
      pluginId: authority.pluginId,
      spawnId: authority.spawnId,
      requestPath: "panel",
      isWritable: () => !sharedViewOf(authority.workspaceId),
      signal: authority.signal,
      method: input.method,
      params: input.params,
    });
    return InvokePluginPanelSdkResult.parse({ result });
  });

  ipcMain.handle(CHANNELS.openPluginWebApp, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenPluginWebAppPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const sender = event.sender;
    const generation = rendererGeneration(sender.id);
    const isCurrent = () =>
      !sender.isDestroyed() &&
      rendererGeneration(sender.id) === generation &&
      activeWorkspaceIdBySender.get(sender.id) === workspace.workspaceId;
    assertPluginPanelRequestCurrent(isCurrent);
    assertWritableWorkspace(workspace);
    const registration = await loadPluginPanelRegistrationForCurrentRenderer(
      () =>
        loadPluginWebAppRegistration({
          workspaceRoot: workspace.rootPath,
          pluginRoot: input.pluginRoot,
          pluginId: input.pluginId,
          webAppId: input.webAppId,
        }),
      isCurrent,
    );
    assertWritableWorkspace(workspace);
    const plugin = rememberPluginRegistration(
      pluginRegistrations,
      workspace.workspaceId,
      registration,
    );
    // The open's shape must match the id it names before a tab appears for
    // it: a keyless open of a per-instance app would otherwise reach start
    // and fail there, after the user already has an empty tab.
    requireDeclaredWebApp(
      input.pluginId,
      plugin.manifest.webApps,
      input.webAppId,
      input.instanceKey,
    );
    await withPluginWebAppStartLock(
      pluginWebAppKey(
        workspace.workspaceId,
        input.pluginId,
        input.webAppId,
        input.instanceKey,
      ),
      () =>
        withPluginHostLifecycleLock(
          pluginLifecycleKey(workspace.workspaceId, input.pluginId),
          () => {
            assertPluginPanelRequestCurrent(isCurrent);
            assertWritableWorkspace(workspace);
            return ensurePluginStarted(workspace, plugin);
          },
        ),
    );
    return OpenPluginWebAppResult.parse({
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
    });
  });

  ipcMain.handle(CHANNELS.startPluginWebApp, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartPluginWebAppPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const sender = event.sender;
    const generation = rendererGeneration(sender.id);
    const isCurrent = () =>
      !sender.isDestroyed() &&
      rendererGeneration(sender.id) === generation &&
      activeWorkspaceIdBySender.get(sender.id) === workspace.workspaceId;
    assertPluginPanelRequestCurrent(isCurrent);
    assertWritableWorkspace(workspace);
    const plugin = registeredPlugin(workspace.workspaceId, input.pluginId);
    if (!plugin) {
      return StartPluginWebAppResult.parse({ status: "not-registered" });
    }
    const webApp = requireDeclaredWebApp(
      input.pluginId,
      plugin.manifest.webApps,
      input.webAppId,
      input.instanceKey,
    );
    const identity = {
      workspaceId: workspace.workspaceId,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
    };
    return withPluginWebAppStartLock(
      pluginWebAppKey(
        workspace.workspaceId,
        input.pluginId,
        input.webAppId,
        input.instanceKey,
      ),
      async () => {
        // The budget is read inside the lock, against the live views: a
        // restore that reopens more instances than the budget allows is
        // refused here, which is the only place that sees them all.
        assertInstanceBudget(
          input.pluginId,
          input.webAppId,
          pluginWebAppViews.countOtherInstances(identity),
        );
        const host = await withPluginHostLifecycleLock(
          pluginLifecycleKey(workspace.workspaceId, input.pluginId),
          () => {
            assertPluginPanelRequestCurrent(isCurrent);
            assertWritableWorkspace(workspace);
            return ensurePluginStarted(workspace, plugin);
          },
        );
        const spawnId = host.getSpawnId(input.pluginId);
        if (!spawnId) {
          throw new Error(`Plugin "${input.pluginId}" has no active process.`);
        }
        // The long await: the plugin spawns its server and polls readiness.
        // The returned URL can carry a one-time credential in its fragment;
        // it goes into loadURL below and nowhere else — never a log, never
        // the renderer.
        const started = await host.startWebApp(
          input.pluginId,
          input.webAppId,
          input.instanceKey,
        );
        if (host.getSpawnId(input.pluginId) !== spawnId) {
          throw new Error(
            `Plugin "${input.pluginId}" restarted while its web app was starting. Try again.`,
          );
        }
        // Every path from here to a rendered guest can still fail, and the
        // start URL's one-time credential is already spent. Whatever fails,
        // the plugin's server must not stay paired to a guest that never
        // arrived, so the recovery asks the PLUGIN to unpair. Stopping the
        // view cannot do that job: it only stops the host when an on-demand
        // open is the reason the host runs, and the default deployment is a
        // workspace-started host, which survives — with a paired, cookieless
        // server behind it.
        //
        // The teardown takes this web app's start lock, which is the lock a
        // reopen queues on: the section is claimed before this handler's own
        // one releases, so the reopen waits for the unpair instead of reading
        // the doomed server's state. The recovery runs detached — it must not
        // hold that section open waiting for the handler it runs inside.
        const recoverConsumedCredential = (): void => {
          void recoverConsumedWebAppCredential({
            notifyFailed: () => notifyPluginWebAppFailed(sender, identity),
            withTeardownLock: (teardown) =>
              withPluginWebAppStartLock(
                pluginWebAppKey(
                  workspace.workspaceId,
                  input.pluginId,
                  input.webAppId,
                  input.instanceKey,
                ),
                teardown,
              ),
            unpair: () =>
              host.stopWebApp(
                input.pluginId,
                input.webAppId,
                input.instanceKey,
              ),
            stopView: () =>
              stopPluginWebAppUnderStartLock(
                workspace.workspaceId,
                input.pluginId,
                input.webAppId,
                input.instanceKey,
              ),
            onError: (stage, error) => {
              console.warn(
                `[desktop] failed to ${stage} a plugin web app after a failed start`,
                error,
              );
            },
          });
        };
        try {
          assertPluginPanelRequestCurrent(isCurrent);
          const win = BrowserWindow.fromWebContents(sender);
          if (!win || win.isDestroyed()) {
            throw new Error("The plugin web app request has no open window.");
          }
          const guest = createPluginWebAppGuest({
            workspaceRoot: workspace.rootPath,
            pluginId: input.pluginId,
            url: started.url,
            hardenedPartitions: hardenedGuestPartitions,
            ViewClass: WebContentsView,
            attach: (view, { origin, partition }) => {
              win.contentView.addChildView(view);
              const displaced = pluginWebAppViews.register({
                ...identity,
                senderId: sender.id,
                generation,
                origin,
                partition,
                view: { view, window: win },
              });
              if (displaced) destroyPluginWebAppViews([displaced]);
            },
            onLoadFailure: () => {
              // The load error's message can embed the URL, credential
              // fragment included — report the failure without it.
              console.warn(
                `[desktop] plugin "${input.pluginId}" web app "${input.webAppId}" failed to load its start URL.`,
              );
              recoverConsumedCredential();
            },
          });
          // Every instance of one id shares the manifest title, which would
          // label twenty preview tabs "Preview". A plugin that knows what its
          // instance is may name it; the manifest title is the fallback.
          return StartPluginWebAppResult.parse({
            status: "ok",
            title: started.title ?? webApp.title,
            origin: guest.origin,
          });
        } catch (error) {
          recoverConsumedCredential();
          throw error;
        }
      },
    );
  });

  ipcMain.handle(CHANNELS.setPluginWebAppBounds, (event, payload) => {
    assertTrustedSender(event);
    const input = SetPluginWebAppBoundsPayload.parse(payload);
    // Stale updates are dropped, never applied: a slow bounds report from a
    // previous renderer generation or another workspace's tab must not move
    // the live view (async-guard invariant).
    const record = pluginWebAppViews.authorizeBounds({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
      senderId: event.sender.id,
      generation: rendererGeneration(event.sender.id),
    });
    if (!record) return;
    record.view.view.setBounds(input.bounds);
    record.view.view.setVisible(input.visible);
  });

  ipcMain.handle(CHANNELS.stopPluginWebApp, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopPluginWebAppPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    if (activeWorkspaceIdBySender.get(event.sender.id) !== workspace.workspaceId) {
      throw new Error(
        "The plugin web app stop request does not target the active workspace.",
      );
    }
    const record = pluginWebAppViews.get({
      workspaceId: workspace.workspaceId,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
    });
    if (
      record &&
      (record.senderId !== event.sender.id ||
        record.generation !== rendererGeneration(event.sender.id))
    ) {
      throw new Error(
        "The plugin web app stop request does not belong to this renderer.",
      );
    }
    await stopPluginWebApp(
      workspace.workspaceId,
      input.pluginId,
      input.webAppId,
      input.instanceKey,
    );
  });

  async function activePluginPipelineFor(
    event: IpcMainInvokeEvent,
    workspaceId: string,
  ): Promise<PluginPipeline> {
    const workspace = requireWorkspace(workspaceId);
    if (activeWorkspaceIdBySender.get(event.sender.id) !== workspace.workspaceId) {
      throw new Error(
        "The plugin request does not target the active workspace. Open the workspace and try again.",
      );
    }
    return ensurePluginPipeline(workspace);
  }

  function pluginIpcError(error: unknown) {
    return {
      stage: "state" as const,
      code: "pipeline-unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  ipcMain.handle(CHANNELS.listPlugins, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListPluginsPayload.parse(payload);
    try {
      const pipeline = await activePluginPipelineFor(event, input.workspaceId);
      return ListPluginsResult.parse({ ok: true, plugins: pipeline.list() });
    } catch (error) {
      return ListPluginsResult.parse({ ok: false, error: pluginIpcError(error) });
    }
  });

  // Ends every panel's authority over a plugin before an action that takes
  // its process away. A panel SDK call already in flight carries its own
  // abort signal, so stopping the process is not what cancels it (#779 round
  // 12 A4).
  const revokePluginPanels = (workspaceId: string, pluginId: string): void => {
    revokePluginPanelAuthorities({
      workspaceId,
      pluginId,
      panels: runningPluginPanels.values(),
      revokePanel: pluginPanelSdkAuthorities.revokePanel,
    });
  };

  const pluginAction = (
    channel: string,
    run: (
      pipeline: PluginPipeline,
      pluginId: string,
      workspaceId: string,
    ) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (event, payload) => {
      assertTrustedSender(event);
      const input = PluginActionPayload.parse(payload);
      try {
        const pipeline = await activePluginPipelineFor(event, input.workspaceId);
        const result = PluginActionResult.parse(
          await run(pipeline, input.pluginId, input.workspaceId),
        );
        if (result.ok) {
          // install/enable/approve/disable/uninstall each decide this
          // plugin's running state on the workspace's own authority — an
          // earlier panel's cold start no longer owns whether closing it
          // stops the host (#779 round 4 finding 3).
          panelStartedHosts.delete(pluginLifecycleKey(input.workspaceId, input.pluginId));
        }
        return result;
      } catch (error) {
        return PluginActionResult.parse({
          ok: false,
          error: pluginIpcError(error),
          plugin: null,
        });
      }
    });
  };

  pluginAction(CHANNELS.installPlugin, (pipeline, pluginId) =>
    pipeline.install(pluginId));
  pluginAction(CHANNELS.disablePlugin, (pipeline, pluginId, workspaceId) => {
    revokePluginPanels(workspaceId, pluginId);
    stopPluginWebAppsForPlugin(workspaceId, pluginId);
    return pipeline.disable(pluginId);
  });
  pluginAction(CHANNELS.enablePlugin, (pipeline, pluginId) =>
    pipeline.enable(pluginId));
  pluginAction(CHANNELS.approvePlugin, (pipeline, pluginId) =>
    pipeline.approve(pluginId));

  ipcMain.handle(CHANNELS.pluginUninstallPreflight, async (event, payload) => {
    assertTrustedSender(event);
    const input = PluginActionPayload.parse(payload);
    try {
      const pipeline = await activePluginPipelineFor(event, input.workspaceId);
      return PluginUninstallPreflightResult.parse(
        await pipeline.uninstallPreflight(input.pluginId),
      );
    } catch (error) {
      return PluginUninstallPreflightResult.parse({
        ok: false,
        error: pluginIpcError(error),
      });
    }
  });

  ipcMain.handle(CHANNELS.pluginSizes, async (event, payload) => {
    assertTrustedSender(event);
    const input = PluginActionPayload.parse(payload);
    try {
      const pipeline = await activePluginPipelineFor(event, input.workspaceId);
      return PluginSizesResult.parse({
        ok: true,
        sizes: await pipeline.sizes(input.pluginId),
      });
    } catch (error) {
      return PluginSizesResult.parse({
        ok: false,
        error: pluginIpcError(error),
      });
    }
  });

  ipcMain.handle(CHANNELS.getPluginSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = PluginActionPayload.parse(payload);
    try {
      const pipeline = await activePluginPipelineFor(event, input.workspaceId);
      return PluginSettingsResult.parse({
        ok: true,
        values: await pipeline.getPluginSettings(input.pluginId),
      });
    } catch (error) {
      return PluginSettingsResult.parse({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.handle(CHANNELS.setPluginSettings, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetPluginSettingsPayload.parse(payload);
    try {
      const pipeline = await activePluginPipelineFor(event, input.workspaceId);
      return PluginSettingsResult.parse({
        ok: true,
        values: await pipeline.setPluginSettings(input.pluginId, input.values),
      });
    } catch (error) {
      return PluginSettingsResult.parse({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.handle(CHANNELS.uninstallPlugin, async (event, payload) => {
    assertTrustedSender(event);
    const input = UninstallPluginPayload.parse(payload);
    try {
      const pipeline = await activePluginPipelineFor(event, input.workspaceId);
      // Uninstall stops the plugin's process on its way to deleting the
      // source, so no panel authority over it survives the attempt whether
      // or not the delete succeeds (#779 round 12 A4).
      revokePluginPanels(input.workspaceId, input.pluginId);
      stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId);
      const result = PluginActionResult.parse(
        await pipeline.uninstall(input.pluginId, input.confirmationToken),
      );
      forgetUninstalledPlugin({
        registrations: pluginRegistrations,
        panelStartedHosts,
        workspaceId: input.workspaceId,
        pluginId: input.pluginId,
        uninstalled: result.ok,
      });
      if (result.ok) {
        // The guest partition holds the web app's session cookies — plugin
        // state as much as its data directory. A reinstall starts unpaired.
        await clearPluginWebAppPartition({
          workspaceRoot: requireWorkspace(input.workspaceId).rootPath,
          pluginId: input.pluginId,
          hardenedPartitions: hardenedGuestPartitions,
          fromPartition: (partition) => session.fromPartition(partition),
          onError: (error) => {
            console.warn(
              "[desktop] failed to clear a plugin web app partition after uninstall",
              error,
            );
          },
        });
      }
      return result;
    } catch (error) {
      return PluginActionResult.parse({
        ok: false,
        error: pluginIpcError(error),
        plugin: null,
      });
    }
  });

  ipcMain.handle(CHANNELS.openWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenWorkspacePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const senderId = event.sender.id;
    const previousWorkspaceId = activeWorkspaceIdBySender.get(senderId);
    preferredWorkspaceId = workspace.workspaceId;
    activeWorkspaceIdBySender.set(senderId, workspace.workspaceId);
    if (!activeWorkspaceCleanupHooked.has(event.sender)) {
      activeWorkspaceCleanupHooked.add(event.sender);
      event.sender.once("destroyed", () => {
        const activeWorkspaceId = activeWorkspaceIdBySender.get(senderId);
        pluginPanelSdkAuthorities.revokeSender(senderId);
        activeWorkspaceIdBySender.delete(senderId);
        rendererGenerationBySender.delete(senderId);
        if (activeWorkspaceId) {
          void stopPluginWorkspace(activeWorkspaceId);
        }
      });
    }
    if (previousWorkspaceId && previousWorkspaceId !== workspace.workspaceId) {
      await stopPluginWorkspace(previousWorkspaceId);
    }
    refreshNativeWorkspaceSurfaces();
    const status = SyncStatusResult.parse(await openWorkspaceActivity(workspace));
    // A later openWorkspace call from this same sender can have switched to
    // a different workspace while the await above was pending — its own
    // handler already started stopping this workspace's plugins (the
    // previousWorkspaceId branch above). Warming this workspace's pipeline
    // anyway would start it right back up for a workspace this sender no
    // longer has open (#779 round 4 finding 1).
    const stillActive = activeWorkspaceIdBySender.get(senderId) === workspace.workspaceId;
    if (stillActive && !sharedViewOf(workspace.workspaceId)) {
      // A plugin-pipeline start failure must not fail the whole handler —
      // the workspace itself already opened. listPlugins and friends
      // separately convert a failed ensurePluginPipeline into a structured
      // pluginIpcError (CodeRabbit #779 R6); this is best-effort warmup.
      await ensurePluginPipeline(workspace).catch((error: unknown) => {
        console.error(
          `[desktop] plugin pipeline warmup failed for ${workspace.workspaceId}:`,
          error,
        );
      });
    }
    return status;
  });

  // Named versions (PR 0M-4). Every handler resolves the workspace through
  // requireWorkspace (renderer identity is never trusted) and is gated on the
  // workspace-engine alpha capture being attached — for unflagged workspaces
  // the calls reject.
  async function requireEngineCapture(workspaceId: string, feature: EngineFeature) {
    const workspace = requireWorkspace(workspaceId);
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
      }
    | {
        kind: "share";
        workspace: RegistryEntry;
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
    const workspace = requireWorkspace(workspaceId);
    // PRESENCE, the same question `sharedViewOf` asks before a write. A
    // marker that lost its value is still a share view, and resolving a
    // CAPTURE for it would give someone else's workspace the local chat
    // surface — the enforcement layer failing open.
    if (!shareViewIsPresent(workspace.shareView)) {
      const local = await requireEngineCapture(workspaceId, "Chats");
      return { kind: "workspace", workspace: local.workspace, capture: local.capture };
    }
    // Idempotent, and the same guarantee requireEngineCapture makes: the
    // workspace's daemon session is live before any store call reaches it.
    await openWorkspaceActivity(workspace);
    await warmCredentialCache();
    return {
      kind: "share",
      workspace,
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
    workspace: RegistryEntry,
  ): Promise<void> {
    await warmCredentialCache();
    const credentials = cachedCredentials;
    const grantedSelector = shareViewIdentitySelector({
      shareView: workspace.shareView,
      relayUrl: credentials?.relayUrl,
      relayUrlsMatch,
    });
    if (!grantedSelector || !credentials?.relayUrl) return;
    await relayClientForWorkspace({
      workspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }).recordShareViewIdentity({ grantedSelector });
  }

  async function pushShareViewChat(workspace: RegistryEntry): Promise<void> {
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
    await relayClientForWorkspace({
      workspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }).pushShareView({ shareId: shareView.shareId, grantedSelector });
  }

  // Every chat write reaches the granter the same way, whichever scope it was
  // written in: a local workspace nudges its own cloud sync and any joined
  // shared channel, a share view pushes its own chat lane.
  function syncChatWriteFor(scope: ChatScope, target: { threadId: string }): void {
    if (scope.kind === "share") {
      void pushShareViewChat(scope.workspace).catch((error) => {
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
    const index = await activeEngineFileIndex(scope.workspace);
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
    notifyRenderer();
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
      notifyRenderer();
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
    // The path resolver, not a capture: a share view has no capture and its
    // files still resolve (#646 PR2). Everything below only ever asked the
    // capture this one question.
    fileObjectIdForPath: (path: string) => Promise<string | null>,
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
      moment: moment ? engineMomentDetailForIpc(moment, agentAuthorDisplayName) : null,
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
    notifyRenderer();
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
    const { workspace } = scope;
    const fileObjectId = await chatFileObjectId(scope, input.path);
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
      "Chats",
    );
    const rowsUncovered = await syncWorkspaceSharedChannels(workspace.workspaceId);
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
      ...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),
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
    const projected = await materializeChatBookmark(workspace, capture, archived);
    notifyRenderer();
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
    const { workspace } = scope;
    // The chat links to the file's STABLE engine object id (never the path),
    // so the link survives renames; the path rides along as a display hint.
    const fileObjectId = await chatFileObjectId(scope, input.path);
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
    syncChatWriteFor(scope, { threadId: thread.id });
    return CreateFileChatResult.parse({ thread: chatThreadForIpc(thread) });
  });

  ipcMain.handle(CHANNELS.listChatMessages, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatMessagesPayload.parse(payload);
    // Reachable from a share view at every level (#646 PR2), for a thread on
    // a file the share already served.
    const { workspace } = await requireChatScope(input.workspaceId);
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
    // #646 PR2: a share view resolves a scope instead of a capture, and its
    // LEVEL is the write gate. A local workspace still resolves a capture and
    // is writable by definition — `assertWritableWorkspace` refused exactly
    // the share views this scope now admits at comment and edit.
    const scope = await requireChatScope(input.workspaceId);
    assertChatWritable(scope);
    const { workspace } = scope;
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
        resolveChatFileReferences(
          workspace,
          (path) => chatFileObjectId(scope, path),
          input.fileReferences,
        ),
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
    // Bookmarks and agent dispatch are LOCAL projections of a workspace this
    // machine owns. A share view owns neither: it has no capture to project
    // into, and an agent dispatched from someone else's shared file would be
    // this machine acting on a workspace it only reads.
    if (scope.kind === "workspace") {
      void materializePendingChatBookmarks(workspace, scope.capture).catch((error) => {
        console.error("[desktop] chat bookmark projection:", error);
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
    const { workspace } = scope;
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
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    // MU-C4: refresh joined shared channels BEFORE reading, so opening Chats
    // shows other members' latest messages. Never throws; offline it returns
    // fast and the local rows answer.
    const rowsUncovered = await syncWorkspaceSharedChannels(workspace.workspaceId);
    const store = linkedChatStoreFor(workspace);
    // First chat use auto-creates General.
    await store.ensureGeneralChannel({ workspaceId: workspace.workspaceId });
    const channels = await store.listChannels({ workspaceId: workspace.workspaceId });
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
        ({ pathByObjectId } = await activeEngineFileIndex(workspace));
      } catch {
        // Path resolution is display-only; the hint fallback keeps the
        // listing honest enough.
      }
    }
    return ListChatChannelsResult.parse({
      ...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),
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
    notifyRenderer();
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
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId,
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            channelId: input.channelId,
          })
        ).authorUserId,
    });
    // MU-C4: refresh before reading, the way listChatChannels does. A channel
    // view has no poll of its own, and the pass is bounded, so an untargeted
    // sync could leave the channel the user just opened waiting for the
    // rotation. Naming it puts it in THIS pass (#718).
    await syncSharedChannelsForChatTarget(workspace.workspaceId, {
      channelId: input.channelId,
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
        verifiedChatAuthorUserIdFor(workspace.workspaceId, target),
      resolveAttachments: () =>
        resolveChatFileReferences(workspace, capture.fileObjectIdForPath, input.fileReferences),
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
    createSharedChannelWritableChatIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => MarkChatThreadReadPayload.parse(payload),
      // #646 PR2: reachable from a share view at EVERY level, view included.
      requireContext: requireChatScope,
      // Deliberately ungated. Read state is this reader's own, written
      // locally and never replicated, so there is no write here for a level
      // to refuse — a view recipient who read the discussion must be able to
      // stop it showing as unread.
      assertWritable: null,
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
    // #646 PR2: reachable from a share view at EVERY level. The panel loads
    // messages and reactions together, so a capture gate here refuses the
    // whole thread open, not just its reactions.
    const { workspace } = await requireChatScope(input.workspaceId);
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
      // #646 PR2: reachable from a share view at comment and edit.
      requireContext: requireChatScope,
      assertWritable: assertChatWritable,
      run: async (scope, input) => {
        const { workspace } = scope;
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

  // The account-level declined-request file spans every workspace. Accepted
  // DMs live only in the chosen workspace's shared-channel registry.
  function dmRequestFile(): string {
    return join(stateDir(), "dohc-dm-requests.json");
  }

  // Confirmed received-grant kinds. An empty/unbootstrapped log stays
  // retryable because a grant can arrive before its channel bootstrap ops.
  const peekedReceivedGrantKinds = new Map<string, "dm" | "not-dm">();

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
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const relay = dmRelayConnection();
    const store = linkedChatStoreFor(workspace);
    const { pending, declined } = await classifyDmRequestsWithFallback({
      workspaceId: workspace.workspaceId,
      cache: lastKnownDmRequestLanes,
      // #742 P1 SECURITY (round 6): see classifyDmRequestsWithFallback's own
      // comment — this is the guard against an old account's in-flight
      // classify repopulating a just-cleared cache after a session
      // transition.
      credentialGeneration: () => credentialCacheGeneration,
      classify: async () => {
        if (!relay) throw new Error("DM sync is unavailable: not signed in.");
        const listing = await relayShareJson<{
          received?: Array<{
            shareId?: unknown;
            granterEmail?: unknown;
            selector?: { kind?: unknown; channelWireId?: unknown };
          }>;
        }>("/sync/shares");
        // Re-derived on EVERY call, not a snapshot taken once: classifyDmRequests
        // calls this twice, before and after its own async peek, specifically to
        // catch a grant accepted elsewhere mid-poll (PR #737 round 6) — freezing
        // it here would silently reopen that race.
        return classifyDmRequests({
          received: listing.received ?? [],
          kindCache: peekedReceivedGrantKinds,
          peekKind: (shareId) => peekReceivedGrantKindForShare(relay, shareId),
          holdersByShareId: () =>
            liveSharedChannelHoldersByShareId(listWorkspaces()),
          holdersByWireId: () =>
            liveSharedChannelHoldersByWireId(listWorkspaces()),
          declinedShareIds: readDeclinedDms(dmRequestFile()),
        });
      },
    });
    if (relay) {
      try {
        // Push the member's local ops, pull everyone else's, for the joined
        // DMs (and other shared channels) this bounded pass reaches. The DM the
        // caller has OPEN is named, so the 4 s poll behind an open conversation
        // refreshes that conversation instead of only looking like it does.
        await syncSharedChannelsForChatTarget(
          workspace.workspaceId,
          input.openChannelId ? { channelId: input.openChannelId } : undefined,
        );
        // Owner-side liveness: members' ops land in THIS workspace's own relay
        // bucket; nudge the (debounced) sync engine so they arrive without
        // waiting for an unrelated file edit. No-op when the workspace has no
        // cloud engine.
        activity.queueCloudSync(workspace.workspaceId);
      } catch (error) {
        // Offline degradation: never a crash, never a blocked Chats view — the
        // local DM list still serves and the next pass retries. Unrelated to
        // pending/declined above, which classifyDmRequestsWithFallback already
        // resolved (freshly, or from the last-known cache).
        console.error(`[desktop] DM sync failed for ${workspace.rootPath}:`, error);
      }
    }
    const dms = await listDmRecords({
      workspaceId: workspace.workspaceId,
      store,
      sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels ?? [],
    });
    const requestShareIds = new Set(
      [...pending, ...declined].map((row) => row.shareId),
    );
    // Fresh, AFTER classify resolves — not reused from before it, which could
    // be stale by the time the withhold decision actually needs it.
    const holdersByShareId = liveSharedChannelHoldersByShareId(listWorkspaces());
    const holdersByWireId = liveSharedChannelHoldersByWireId(listWorkspaces());
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
  });

  ipcMain.handle(CHANNELS.acceptDm, async (event, payload) => {
    assertTrustedSender(event);
    const input = AcceptDmPayload.parse(payload);
    const { workspace } = await requireEngineCapture(input.workspaceId, "Chats");
    const entry = requireWorkspace(input.workspaceId);
    if (shareViewIsPresent(entry.shareView)) {
      throw new Error(
        "Shared views are read-only — add this conversation to a workspace you own.",
      );
    }

    assertShareNotHeldElsewhere(input.shareId, input.workspaceId);

    const acceptedHere = isShareAcceptedInWorkspace(
      entry.sharedChannels ?? [],
      input.shareId,
    );
    if (!acceptedHere) {
      if (peekedReceivedGrantKinds.get(input.shareId) !== "dm") {
        throw new Error(
          "dohc could not find that message request. Wait for Chats to refresh, then try again.",
        );
      }
      await warmCredentialCache();
      const acceptCredentials = cachedCredentials;
      if (!acceptCredentials) throw new Error("Sign in to dohc Cloud first.");
      if (!acceptCredentials.relayUrl) {
        throw new Error("Reconnect dohc Cloud with a sync relay URL, then try again.");
      }
      const acceptedRelayUrl = acceptCredentials.relayUrl;
      const relay = {
        baseUrl: normalizeServerUrl(acceptedRelayUrl),
        token: acceptCredentials.token,
        fetch: relayFetchWithTimeout(SHARED_CHANNEL_SYNC_FETCH_TIMEOUT_MS),
      };
      // Recheck after the relay awaits. Two open Chats views can accept the
      // same account-wide request concurrently; only the first may reserve it.
      assertShareNotHeldElsewhere(input.shareId, input.workspaceId);
      try {
        await reserveAndPullSharedChannelForWorkspace({
          relay,
          shareId: input.shareId,
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          recipientUserId: acceptCredentials.userId,
          relayUrl: acceptedRelayUrl,
          preWrite: (info) =>
            assertShareNotHeldElsewhere(
              input.shareId,
              input.workspaceId,
              info.channelWireId,
            ),
        });
      } catch (error) {
        if (error instanceof ShareUnavailableError) {
          throw new Error(
            "That conversation isn't available anymore. Ask the sender to message you again.",
          );
        }
        // The reservation row is the write gate (reserveAndPullSharedChannel writes it
        // before the pull, and keeps it if the pull fails). Once it exists, a pull
        // failure is not an accept failure — fall through to the listDmRecords check
        // below, which reports success if the pull's data landed anyway, or the
        // existing "could not open it" message if it hasn't yet.
        if (
          !isShareAcceptedInWorkspace(
            findWorkspace(input.workspaceId)?.sharedChannels ?? [],
            input.shareId,
          )
        ) {
          throw error;
        }
      }
    }

    // Acceptance succeeded, so this obsolete marker cleanup is best-effort; decline and undecline handlers must persist their requested change.
    void clearDeclinedDm(dmRequestFile(), input.shareId);
    const dm = (
      await listDmRecords({
        workspaceId: input.workspaceId,
        store: linkedChatStoreFor(workspace),
        sharedChannels: findWorkspace(input.workspaceId)?.sharedChannels ?? [],
      })
    ).find((record) => record.shareId === input.shareId);
    if (!dm) {
      throw new Error(
        "dohc added the conversation but could not open it. Open it from Direct messages.",
      );
    }
    return AcceptDmResult.parse({ dm: dmRecordForIpc(dm) });
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
  ipcMain.handle(CHANNELS.leaveDm, (event, payload) => {
    assertTrustedSender(event);
    const input = LeaveDmPayload.parse(payload);
    const leftRow = (
      requireWorkspace(input.workspaceId).sharedChannels ?? []
    ).find((channel) => channel.shareId === input.shareId);
    endWorkspaceJoinedChannel(input.workspaceId, input.shareId);
    // #742 P1 (round 5): the leave is locally knowable without the relay —
    // see markLeftInLastKnownLanes's own comment for why this must run here.
    markLeftInLastKnownLanes(lastKnownDmRequestLanes, input.workspaceId, {
      shareId: input.shareId,
      granterEmail: leftRow?.granterEmail ?? null,
    });
    return undefined;
  });

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
      "Chats",
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
        capture.fileObjectIdForPath,
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
    requireWorkspace(input.workspaceId);
    await chatDispatchService.stopAgentRun(input.workspaceId);
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
  // classified live-document path; a
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
    const validatedPath = validateUserWritePath(input.path);
    if (!validatedPath.ok) {
      return OpenEngineYDocSessionResult.parse({ available: false });
    }
    const path = validatedPath.normalized;
    const requestedKind = liveDocumentKindForPath(path);
    // Only engine-flagged workspaces have a capture. The shared classifier is
    // the main-side authority for which paths bind to a Y.Doc.
    if (!capture || requestedKind === null) {
      return OpenEngineYDocSessionResult.parse({ available: false });
    }
    // PENDING FROM THE FIRST AWAIT, not from the open. A renderer reload waits
    // on this registration (prepareForRendererReload), and the releases below
    // await the daemon: outside it, a reload could finish both its sweeps while
    // this handler sat in a release, and then this handler would take a daemon
    // session for a generation that no longer exists. The check after the open
    // does release that session — but the replacement renderer racing the same
    // document meanwhile gets ydoc-session-busy, and is then stuck read-only
    // over a document nothing is going to release (#616).
    const finishPendingOpen = beginPendingEngineYDocOpen(sender.id);
    // The renderer mints the session id; main owns the sender it came from, so
    // that is what the registry files it under (engineYDocSessionRegistry.ts).
    const sessionKey = engineYDocSessionKey(sender.id, input.sessionId);
    try {
      // A stale session under this key — a renderer that reused an id after a
      // crash — is released before opening a new one.
      const existing = engineYDocSessions.get(sessionKey);
      if (
        existing &&
        !(await releaseEngineYDocSessionEntry(
          sessionKey,
          existing,
          "stale session replaced",
        ))
      ) {
        return OpenEngineYDocSessionResult.parse({
          available: false,
          engineMayHoldDocument: true,
        });
      }
      // THIS OPEN IS THE RETRY, and it has to find its session by DOCUMENT: a
      // marked session keeps its own id and the renderer's "Try again" mints a
      // new one, so nothing keyed by id would ever reach it. The daemon would
      // then answer this open ydoc-session-busy (workspaceEngineCapture.ts,
      // openYDocSessionTask — a failing-close session someone still HOLDS keeps
      // refusing), and the retry that was meant to recover the document would
      // instead be the answer that never can: read-only over a session only
      // this loop knows how to release (#616).
      for (const [failedKey, entry] of [...engineYDocSessions]) {
        if (!entry.closeFailed) continue;
        if (entry.workspaceId !== workspace.workspaceId) continue;
        if (entry.path !== path) continue;
        if (
          !(await releaseEngineYDocSessionEntry(
            failedKey,
            entry,
            "unreleased session retried by a new open",
          ))
        ) {
          return OpenEngineYDocSessionResult.parse({
            available: false,
            engineMayHoldDocument: true,
          });
        }
      }
      // This open owns its save sequence. A refused open can keep reporting
      // after its close fails, so callbacks must not look up state by session id.
      const saveSeq = createEngineYDocSaveSeqState();
      // Stop callbacks after this open loses its session id to another document.
      let refused = false;
      let lineageGeneration = 1;
      let registeredEntry: EngineYDocSessionEntry | null = null;
      let queuedLineageReplacement: {
        update: Uint8Array;
        recoveredPaths: string[];
        remoteUpdates: Uint8Array[];
        artifactAssets: readonly NonNullable<
          WorkspaceEngineYDocProviderSession["artifactAssets"]
        >[number][];
      } | null = null;
      const announceLineageReplacement = (replacement: {
        update: Uint8Array;
        recoveredPaths: string[];
        remoteUpdates: Uint8Array[];
        artifactAssets: readonly NonNullable<
          WorkspaceEngineYDocProviderSession["artifactAssets"]
        >[number][];
      }): void => {
        if (
          refused ||
          sender.isDestroyed() ||
          rendererGeneration(sender.id) !== generation
        ) {
          return;
        }
        const nextLineageGeneration = lineageGeneration + 1;
        const handoff: EngineYDocLineageHandoff = {
          lineageGeneration: nextLineageGeneration,
          remoteUpdates: replacement.remoteUpdates,
          artifactAssets: replacement.artifactAssets,
          acknowledge: () => {
            if (pendingEngineYDocLineageHandoffs.get(sessionKey) !== handoff) {
              return { updates: [] };
            }
            lineageGeneration = nextLineageGeneration;
            if (registeredEntry !== null) {
              registeredEntry.lineageGeneration = nextLineageGeneration;
              for (const asset of registeredEntry.artifactAssetsById.values()) {
                if (
                  !registeredEntry.retiredArtifactAssets.some((retired) =>
                    sameEngineYDocArtifactAsset(retired, asset),
                  )
                ) {
                  registeredEntry.retiredArtifactAssets.push(asset);
                }
              }
              registeredEntry.artifactAssetsById = new Map(
                handoff.artifactAssets.map((asset) => [asset.id, asset]),
              );
            }
            pendingEngineYDocLineageHandoffs.delete(sessionKey);
            const queued = queuedLineageReplacement;
            queuedLineageReplacement = null;
            if (queued !== null) {
              announceLineageReplacement(queued);
              // The queued full snapshot supersedes every delta from the
              // intermediate lineage. Its own later deltas travel with its
              // acknowledgement instead.
              return { updates: [] };
            }
            return { updates: handoff.remoteUpdates };
          },
        };
        // From this point until acknowledgement, neither lineage may accept
        // renderer updates. The losing CRDT cannot merge into the independent
        // winner, and the winner is not editable until its mirror has replaced
        // the losing document.
        pendingEngineYDocLineageHandoffs.set(sessionKey, handoff);
        try {
          sender.send(
            CHANNELS.engineYDocLineageReplacement,
            EngineYDocLineageReplacementEventSchema.parse({
              sessionId: input.sessionId,
              update: replacement.update,
              recoveredPaths: replacement.recoveredPaths,
              artifactAssets: replacement.artifactAssets,
              lineageGeneration: nextLineageGeneration,
            }),
          );
        } catch (error) {
          // The provider already installed the winner, so the retired lineage
          // cannot safely resume. Release this session instead of leaving an
          // unacknowledgeable handoff armed forever.
          if (pendingEngineYDocLineageHandoffs.get(sessionKey) === handoff) {
            pendingEngineYDocLineageHandoffs.delete(sessionKey);
          }
          refused = true;
          console.error(
            `[desktop] could not announce the engine Y.Doc lineage replacement for ${input.path}:`,
            error,
          );
          if (registeredEntry !== null) {
            void releaseEngineYDocSessionEntry(
              sessionKey,
              registeredEntry,
              "lineage replacement announcement failed",
            );
          }
        }
      };
      let session: WorkspaceEngineYDocProviderSession;
      try {
        session = await capture.openYDocSession({
          path,
          // Explicit, because the daemon defaults an unspecified session to
          // PLAINTEXT (actor.rs requested_content_kind.unwrap_or(Plaintext)).
          // The requested kind must match the editor selected for this path.
          // A mismatched session binds the editor to the wrong Y.Doc root.
          contentKind: requestedKind,
          // The document's REAL save state. A settle failure used to reach
          // nothing at all while the editor's own timer kept saying "Saved" —
          // three dogfood journeys watched a doc report Saved over a
          // zero-byte .md. Report every outcome to the renderer that owns it.
          onSaveState: (state, token) => {
            // Pair every outcome with ITS OWN start BY TOKEN. Not by order:
            // an aborting settle never queues on settleChain, and
            // settleChain is per generation while this state is per session.
            const seq =
              state === "settling"
                ? noteSettleStart(saveSeq, token)
                : noteSettleOutcome(saveSeq, token);
            if (refused) return;
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
            // opened this session, and only while this open owns its session
            // id: a refused session whose close failed still hears its
            // document, and the renderer would apply that delta to whichever
            // document holds the id now.
            if (
              refused ||
              sender.isDestroyed() ||
              rendererGeneration(sender.id) !== generation
            ) {
              return;
            }
            const handoff = pendingEngineYDocLineageHandoffs.get(sessionKey);
            if (handoff) {
              (queuedLineageReplacement?.remoteUpdates ?? handoff.remoteUpdates).push(
                update,
              );
              return;
            }
            try {
              sender.send(
                CHANNELS.engineYDocRemoteUpdate,
                EngineYDocRemoteUpdateEventSchema.parse({
                  sessionId: input.sessionId,
                  update,
                  lineageGeneration,
                }),
              );
            } catch {
              // A malformed delta is DROPPED, never thrown through the session's
              // update observer (an uncaught throw there would wedge main).
            }
          },
          onLineageReplaced: (update, recoveredPaths) => {
            if (
              refused ||
              sender.isDestroyed() ||
              rendererGeneration(sender.id) !== generation
            ) {
              return;
            }
            const replacement = {
              update,
              recoveredPaths,
              remoteUpdates: [],
              artifactAssets: session.artifactAssets ?? [],
            };
            if (pendingEngineYDocLineageHandoffs.has(sessionKey)) {
              // Keep only the newest full snapshot. It contains every earlier
              // lineage; deltas observed after it are buffered on this object.
              queuedLineageReplacement = replacement;
              return;
            }
            announceLineageReplacement(replacement);
          },
        });
      } catch (error) {
        // Secret path, already-live, or an uncaptured artifact: fall back
        // gracefully — but never silently. A refusal here downgrades the doc to
        // the plain editor, and an unlogged permanent refusal is
        // indistinguishable from intended fallback (it hid a dead engine editor
        // for weeks). Two flags below refuse that downgrade instead:
        // path-not-in-version (#534, the plain editor would write the phantom
        // back) and an open the engine refused while it may still hold this
        // document (#564) — a spent retry budget, a region refused because the
        // app is quitting, or an open whose session the daemon would not
        // release. A writable plain editor for any of them would take the disk
        // path #533 closed. An uncaptured artifact whose session WAS released
        // is really on disk, so it keeps the plain editor: claiming the
        // version does not have it would be false.
        console.error(
          `[desktop] engine Y.Doc open refused for ${path}:`,
          error,
        );
        return OpenEngineYDocSessionResult.parse({
          available: false,
          ...(isYDocPathNotInVersionError(error) ? { notInVersion: true } : {}),
          ...(isYDocRemovalInProgressError(error)
            ? {
                removalInProgress: {
                  operation: error.removalOperation,
                  message: error.inProgress,
                },
              }
            : {}),
          ...(isYdocArtifactAssetsInvalidRefusal(error)
            ? { artifactAssetsInvalid: true }
            : isEngineWorkspaceOpenRefusedError(error) ||
                isYDocSessionUnreleasedError(error)
              ? { engineMayHoldDocument: true }
              : {}),
        });
      }
      const entry: EngineYDocSessionEntry = {
        session,
        sessionId: input.sessionId,
        senderId: sender.id,
        workspaceId: workspace.workspaceId,
        path,
        sender,
        generation,
        lineageGeneration,
        saveSeq,
        artifactAssetsById: new Map(
          (session.artifactAssets ?? []).map((asset) => [asset.id, asset]),
        ),
        retiredArtifactAssets: [],
      };
      registeredEntry = entry;
      // Every path below that refuses this session releases it through the
      // same helper, and answers read-only unless the release succeeded.
      const release = (reason: string): Promise<boolean> => {
        refused = true;
        return releaseEngineYDocSessionEntry(sessionKey, entry, reason);
      };
      if (refused) {
        const released = await release("lineage replacement announcement failed");
        return OpenEngineYDocSessionResult.parse({
          available: false,
          ...(released ? {} : { engineMayHoldDocument: true }),
        });
      }
      // The renderer can die or reload DURING the await above. Close the stale
      // session before crash cleanup completes so its reservation cannot block
      // the replacement renderer's open.
      if (
        sender.isDestroyed() ||
        rendererGeneration(sender.id) !== generation
      ) {
        const released = await release("renderer gone before hand-over");
        return OpenEngineYDocSessionResult.parse({
          available: false,
          ...(released ? {} : { engineMayHoldDocument: true }),
        });
      }
      // Hooked here, not after the kind check: the sender is known alive from
      // this line on, and a kind-mismatched session whose close FAILS stays
      // registered — the hook is what lets a renderer teardown retry it.
      if (!engineYDocCleanupHooked.has(sender)) {
        engineYDocCleanupHooked.add(sender);
        sender.once("destroyed", () => {
          void closeEngineYDocSessionsForSender(sender.id);
        });
      }
      // The daemon honors the requested kind only for state-free markers; a
      // lineage with durable state keeps its own. Binding an editor to a
      // different content kind is silent data loss. Refuse the session and
      // fall back to the plain editor only once the session is released.
      if (session.contentKind !== requestedKind) {
        console.error(
          `[desktop] engine Y.Doc open for ${path} came back ${session.contentKind}; ` +
            `the editor requested ${requestedKind} (kind-mismatched lineage).`,
        );
        const released = await release("kind-mismatched lineage");
        return OpenEngineYDocSessionResult.parse({
          available: false,
          ...(released ? {} : { engineMayHoldDocument: true }),
        });
      }
      // The slot has to be free STILL: two opens under one id both passed the
      // look above while neither had registered. Burying the winner would keep
      // its daemon session live and unreachable, so the newcomer yields (#683).
      const claim = await claimEngineYDocSessionSlot({
        sessions: engineYDocSessions,
        key: sessionKey,
        entry,
        release,
        onRefused: (message) => console.error(message),
      });
      if (!claim.claimed) {
        return OpenEngineYDocSessionResult.parse({
          available: false,
          ...(claim.released ? {} : { engineMayHoldDocument: true }),
        });
      }
      return OpenEngineYDocSessionResult.parse({
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(session.doc),
        ...(session.objectId ? { objectId: session.objectId } : {}),
        ...(session.versionId ? { versionId: session.versionId } : {}),
        artifactAssets: session.artifactAssets ?? [],
        lineageGeneration,
      });
    } finally {
      finishPendingOpen();
    }
  });

  ipcMain.handle(
    CHANNELS.engineYDocReadArtifactAsset,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = ReadEngineYDocArtifactAssetPayload.parse(payload);
      const entry = engineYDocSessions.get(
        engineYDocSessionKey(event.sender.id, input.sessionId),
      );
      // Deletion marks this entry before the renderer can capture its recovery
      // draft. Keep the version-bound asset reader available until the normal
      // session close so an image-bearing drawing can finish that recovery.
      if (
        !entry ||
        entry.sender !== event.sender ||
        entry.generation !== rendererGeneration(event.sender.id)
      ) {
        throw new Error(
          "The live document session is no longer available. Open the file again.",
        );
      }
      // The renderer's descriptor only selects among the descriptors this
      // session has pinned; the read hydrates from the pinned copy. One id
      // can name the winner's asset and a retired lineage's, so the match is
      // field-exact and the current lineage is tried first.
      const requested = input.descriptor;
      const descriptor = [
        entry.artifactAssetsById.get(requested.id),
        ...entry.retiredArtifactAssets,
      ].find(
        (candidate) =>
          candidate !== undefined &&
          sameEngineYDocArtifactAsset(candidate, requested),
      );
      if (!descriptor) {
        throw new Error(
          `The live document does not reference artifact asset ${requested.id}.`,
        );
      }
      const hydrated = await entry.session.readArtifactAsset(descriptor);
      return ReadEngineYDocArtifactAssetResult.parse(hydrated);
    },
  );

  ipcMain.handle(CHANNELS.engineYDocApplyUpdate, (event, payload) => {
    assertTrustedSender(event);
    const input = ApplyEngineYDocUpdatePayload.parse(payload);
    // Owner-scoped BY THE KEY: the sender comes from the event, so a renderer
    // can only ever reach a session it opened. Refusals are returned as data so
    // the renderer can preserve its canonical mirror.
    const sessionKey = engineYDocSessionKey(event.sender.id, input.sessionId);
    const entry = engineYDocSessions.get(sessionKey);
    if (!entry) {
      return ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: "session-unavailable",
      });
    }
    if (entry.releasing) {
      return ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: "session-unavailable",
      });
    }
    // Main has installed an independent winner, but the renderer may still be
    // inside a transaction on the losing mirror. Never merge that update into
    // the winner and never accept winner edits before the renderer has exposed
    // it. The renderer persists the losing mirror before acknowledging.
    if (
      pendingEngineYDocLineageHandoffs.has(sessionKey) ||
      input.lineageGeneration !== entry.lineageGeneration
    ) {
      return ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: "lineage-transition",
      });
    }
    if (entry.deleted) {
      sendEngineYDocSaveState(
        entry.sender,
        entry.generation,
        entry.sessionId,
        "deleted",
        input.seq,
      );
      return ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: "deleted",
      });
    }
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
      return ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: "read-only",
      });
    }
    // Count the edit when it REACHES the settle, not when it arrives here.
    // The session queues updates, so hand-over runs ahead of journaling: a
    // settle armed by an earlier update would otherwise start while this one
    // is still queued and report "Saved" for content it never carried — the
    // indicator read Saved over a half-written 140 KiB document (#514).
    entry.session.applyLocalUpdate(input.update, () =>
      noteLocalEdit(entry.saveSeq, input.seq),
    );
    return ApplyEngineYDocUpdateResult.parse({ accepted: true });
  });

  ipcMain.handle(
    CHANNELS.engineYDocAcknowledgeLineageReplacement,
    (event, payload) => {
      assertTrustedSender(event);
      const input = AcknowledgeEngineYDocLineageReplacementPayload.parse(payload);
      const sessionKey = engineYDocSessionKey(event.sender.id, input.sessionId);
      const handoff = pendingEngineYDocLineageHandoffs.get(sessionKey);
      if (!handoff || handoff.lineageGeneration !== input.lineageGeneration) {
        return AcknowledgeEngineYDocLineageReplacementResult.parse({ updates: [] });
      }
      return AcknowledgeEngineYDocLineageReplacementResult.parse(
        handoff.acknowledge(),
      );
    },
  );

  ipcMain.handle(CHANNELS.engineYDocClose, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloseEngineYDocSessionPayload.parse(payload);
    const sessionKey = engineYDocSessionKey(event.sender.id, input.sessionId);
    const entry = engineYDocSessions.get(sessionKey);
    if (!entry) return;
    // Deregistering the entry here and swallowing the close is what turned a
    // held document into a clean fallback (#657): the renderer's retry opens
    // under a new id, and nothing was left for that open to release.
    await releaseEngineYDocSessionEntry(
      sessionKey,
      entry,
      "renderer closed the document",
    );
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

    // A path the handlers queued during the bootstrap is a later intent than the
    // launch arguments, so it wins. Drain before the window exists: creating it
    // starts the load, so a listener registered after any further await can miss
    // did-finish-load and never send at all.
    const drainedWorkspace = await flushPendingOpenPaths();
    const activatedWorkspace = drainedWorkspace ?? initialActivatedWorkspace;
    const window = trackWorkspaceWindow(
      createMainWindow({ beforeRendererReload: prepareForRendererReload }),
    );
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
