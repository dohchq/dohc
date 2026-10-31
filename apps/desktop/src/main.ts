import { createChatLinksReader } from "./workspaces/chatLinks";
import { workspaceRootForOperation, workspaceRootsMatch } from "./workspaces/workspaceRootsMatch";
import { createActorPresentationRequest } from "./workspaces/actorPresentation";
import { agentColorsForPresentation } from "./settings/userSettingsStore";
import { createChatFileMentionsReader } from "./workspaces/chatFileMentions";
import { createWorkspaceLinksReader } from "./workspaces/workspaceLinks";
import { linksOperations } from "./ipc/linksOperations";
import { shareHandoffOperations, shareMountOperations, shareProposalOperations, sharedChannelOperations, relayShareOperations } from "./ipc/shareOperations";
import { createOperationHistory } from "./workspaces/workspaceHistoryOperations";
import { createReceivedFileReferenceScopes } from "./workspaces/workspaceFileReferenceScopes";
import { mountRootFor } from "./workspaces/shareMounts";
import { createHistoryCollectionRemote, serverHistorySources } from "./workspaces/historyCollectionRemote";
import { forgetWorkspacePresentation } from "./workspaces/actorPresentation";
import { createEngineFileResolver } from "./workspaces/resolveEngineFiles";
import { createTypingQuitRecovery } from "./workspaces/typingQuitRecovery";
import { writeTypingCheckpointSync, typingRecoveryFailure, hasUnresolvedTypingCheckpoints, flushTypingCheckpoints, writeTypingCheckpoint, readTypingCheckpoints, retireTypingCheckpoint, importTypingCheckpoints, type TypingRecoveryFailure } from "./workspaces/outageTypingRecovery";
import { actOnTypingCopy, type TypingCopyResult } from "./workspaces/typingRecoveryActions";
import { appViewOperations, liveDraftRecoveryOperations } from "./ipc/bridgeContract";
import { recordHistoryPersonIsNamed } from "./ipc/recordHistoryIpc";
import { SharedDocumentWaitingError } from "./ipc/sharedDocumentOpenState";
import { net, clipboard } from "electron";
import { writeWorkspaceFilesAs } from "./workspaces/workspaceFileWrites";
import { createDesktopAutomationControls } from "./workspaces/desktopAutomationControls";
import {parseDohcSiteConfig} from "@dohc/workspace-core";
import {ownerShareLabels, refreshOwnerShareLabels, createOwnerShareLabelRefresh} from "./workspaces/ownerShareLabels";
import { describeAutomationDataset } from "./workspaces/automationDatasetDescription";
import { invalidateDatasetAddresses } from "./workspaces/datasetAddress";
import { createChatDispatchNotices } from "./agents/chatDispatchNotices";
import { hasWorkspaceLiveDrafts, hasRetainedLiveDraft, listLiveDraftRecovery, removeLiveDraftCopies, preserveLiveDraft, removeWorkspaceLiveDrafts, workspaceDraftStore } from "./workspaces/liveDraftRecovery";
import { createPhysicalWorkspaceRemoval, createWorkspaceForget } from "./workspaces/physicalWorkspaceRemoval";
import { createNamedDesktopLiveCapture } from "./workspaces/namedDesktopLive";
import {
  createDesktopWorkspaceCallbacks,
  type DesktopWorkspaceCallbacksDependencies,
} from "./workspaces/desktopWorkspaceCallbacks";
import { createWorkspaceFileProtocolHandler } from "./security/workspaceFileProtocol";
import {readOwnerRestoreResponse} from "./ipc/readOwnerRestoreResponse";
import { readDatasetResponse } from "./ipc/readDatasetResponse";
import { ipcWireError, readError, USE_THIS_COMPUTER, withErrorWords } from "./ipc/errorWords";
import { assertRootNotPrivacyDenied, withPrivacyDenial } from "./workspaces/privacyDenial";
import { onNetworkShare } from "./workspaces/networkShare";
import { createUpdateInstall, registerUpdatesIpcHandlers } from "./ipc/updatesIpc";
import { registerSystemMotionIpc } from "./ipc/systemMotionIpc";
import { registerWorkspaceFolderNameIpc } from "./ipc/workspaceFolderNameIpc";
import { registerSystemPrivacySettingsIpc } from "./ipc/systemPrivacySettingsIpc";
import { createWindowIpc } from "./ipc/windowIpc";
import {
  devToolsEnabled,
  devToolsPreloadArguments,
  registerDevToolsIpcHandlers,
} from "./ipc/devToolsIpc";
import { createAgentRunsIpc } from "./ipc/agentRunsIpc";
import { registerCollectionAutomationsIpc } from "./ipc/collectionAutomationsIpc";
import { registerStopAndRestoreIpc } from "./ipc/stopAndRestoreIpc";
import { createServerRuns } from "./automations/serverRuns";
import { readServerDataset, serverRunsOfAnswer } from "./automations/serverDataset";
import { collectionPlace, finishedTransfer, moveCollectionToServer } from "./workspaces/collectionMove";
import { createPressWindows, refreshSharedButtonInspections, registerAutomationButtonsIpc } from "./ipc/automationButtonsIpc";
import { RECORD_ID_FRONTMATTER_KEY } from "@dohc/workspace-contracts/collection";
import { parseCollectionRecordFields } from "@dohc/workspace-contracts/collection-values";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import type { AppResponseUndoSelection } from "./workspaces/ownerAppResponseModeration";
import { RECORD_NOT_FOUND } from "@dohc/automation-executor/collection-automation-run";
import { detectAgentTools } from "./agents/agentToolDetection";
import { registerAppPreviewIpcHandlers } from "./ipc/appPreviewIpc";
import { registerOwnerAppPublicationIpc, createOwnerAppPublicationHandler, publicationListUnavailable } from "./ipc/ownerAppPublicationIpc";
import { createLocalOwnerAppPublicationHandler } from "./ipc/localOwnerAppPublication";
import { adoptLocalDatasetStore, createLocalDatasetHost, localDatasetStoreExists, localDatasetStoreId, reconcileExistingLocalCollectionApps, type LocalDatasetAgent, type LocalDatasetHost } from "./workspaces/localDatasetHost";
import { collectionsHolderRequired, collectionsKeptElsewhere, CollectionsRefusalError, keepCollectionsHere, keepQuestionWords, type CollectionsHolderCheck, type KeepQuestion } from "./workspaces/collectionsHolder";
import { localCollectionEngine } from "./workspaces/localCollectionEngine";
import { createInstalledDatasetCompiler } from "./workspaces/installedDatasetCompiler";
import { createDatasetAuthorityRouter, createRemoteDatasetData, createServerCollectionsData, resolveRemoteDatasetRevision, type OwnerDatasetData, type RemoteDatasetData } from "./workspaces/remoteDataset";
import { createNamedDatasetData } from "./workspaces/namedDataset";
import { createNamedDatasetCacheRegistry } from "./workspaces/namedDatasetCache";
import { namedDatasetFetch } from "./workspaces/namedDatasetTransport";
import { writeDatasetRecoveryExport } from "./workspaces/datasetRecoveryExport";
import { openRemoteDatasetRecoveryExport } from "./workspaces/remoteDatasetRecoveryExport";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./workspaces/ownerDatasetCopyRegistry";
import { localStateOpened, LocalStateUnavailableError } from "./workspaces/workspaceLocalState";
import { createRemoteDatasetReplicaSource } from "./workspaces/remoteDatasetReplica";
import { createDatasetHandler, type ServerCollections } from "./ipc/datasetIpc";
import { datasetOperations } from "./ipc/datasetOperations";
import { type DatasetPlace, type DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { createHash } from "node:crypto";
import { createDatasetSources, type SourceCreationProgress } from "./workspaces/datasetSourceCreation";
import { flushDatasetSourceCapture } from "./workspaces/datasetSourceCapture";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "./workspaces/localAppLaunch";
import { registerAppViews } from "./window/appViews";
import { createDesktopAppRuntimeLauncher } from "./workspaces/localAppBackendRuntime";
import {registerOwnerAppResponsesIpc,createOwnerAppResponsesHandler} from "./ipc/ownerAppResponsesIpc";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import { createInstalledAppCompiler } from "./workspaces/installedAppCompiler";
import { createPresenceIpc } from "./ipc/presenceIpc";
import { readWorkspaceEnginePolicy } from "./workspaces/workspaceEnginePolicyFile";
import { createWorkspaceEngineIpc } from "./ipc/workspaceEngineIpc";
import { collectionAutomationAuthor } from "./ipc/engineHistoryIpc";
import { createSettingsIpc } from "./ipc/settingsIpc";
import { registerDirectMessagesIpcHandlers, peekReceivedGrantKindForShare } from "./ipc/directMessagesIpc";
import { createChatScopeCapability } from "./ipc/chatScope";
import { registerChatsIpcHandlers } from "./ipc/chatsIpc";
import { workspaceVersionHandlers } from "./ipc/workspaceVersionsIpc";
import { createShareProposalsIpc } from "./ipc/shareProposalsIpc";
import { createShareDirectWriteDelivery } from "./ipc/shareDirectWriteDelivery";
import { registerSharedViewsIpcHandlers } from "./ipc/sharedViewsIpc";
import {
  createWorkspaceSyncStop,
  reopenWithoutSync,
  withWorkspaceSyncTransition,
  type SyncPauseReopen,
} from "./workspaces/stopWorkspaceSync";
import { registerCloudIpcHandlers } from "./ipc/cloudIpc";
import { createSharedChannelsIpc } from "./ipc/sharedChannelsIpc";
import { createShareHandoffIpcHandlers } from "./ipc/shareHandoffIpc";
import { createDesktopSharedChannelSync } from "./workspaces/desktopSharedChannelSync";
import { createWorkspaceFilesIpc } from "./ipc/workspaceFilesIpc";
import { removeEarlierMarkedCopies, removeMarkedCopies, systemMarkedCopies } from "./workspaces/markedCopies";
import { settingsOperations } from "./ipc/settingsOperations";
import { workspaceFileOperations } from "./ipc/workspaceFileOperations";
import { registerWorkspaceHeadingsIpcHandlers } from "./ipc/workspaceFilesIpc";
import { registerNativeMenusIpcHandlers } from "./ipc/nativeMenusIpc";
import {
  createWorkspaceRootApproval,
  registerWorkspaceRegistryIpcHandlers,
  registerOpenWorkspaceIpcHandler,
} from "./ipc/workspaceRegistryIpc";
import { createAppLifecycle } from "./appLifecycle";
import { captureOpenPathFailureTarget } from "./window/openPathFailureTarget";
import { createOpenPathFailures } from "./window/openPathFailures";
import { createWorkspaceFileOpens } from "./window/workspaceFileOpens";
import { confirmOpenPathWorkspace, createOpenPathOpener } from "./workspaces/openPathTarget";
import { runInWorkspaceAuthorityLane } from "./workspaces/workspaceAuthorityLane";
import { randomUUID } from "node:crypto";
import { accessCliQueries, createAccessAcquisition, createAccessOwner, ownerAccessRoster, refreshAccessObservations } from "./access/accessOwner";
import { hasAccessChat, locateAccessVersionPath, resolveAccessFileObject, resolveAccessObject } from "./access/accessObjectResolution";
import { createShareCopyHandler, createShareCopyReader } from "./ipc/shareCopyHandler";
import { shareCopyOperations } from "./ipc/shareCopyOperations";
import { accessOperations } from "./ipc/accessOperations";
import { assertResolvedWorkspacePath } from "./workspaces/workspaceRealPath";
import {
  VersionedLiveAdapter,
  decodeAutomationGroupHandover,
  type AutomationGroupRelayRecord,
  type EngineStoreRefusal,
} from "@dohc/workspace-engine-client";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  systemPreferences,
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
import { watch, existsSync, lstatSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { hostname, release as osRelease, type as osType } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  SitePreviewReplacedEvent,
  McpConfigResult,
  DesktopUserSettingsResult,
  SyncStatusResult,
  RebuildEngineStoreResult,
  WorkspaceSummary,
  UpdateStateEvent,
  ShareHandoffStatus,
  crashReportOperations,
  collectionCopiesLeftOperations,
  workspaceTrustOperations,
  reportingOperations,
  usageRecordOperations,
  noticeOperations,
  scheduleHostOperations,
  chatDispatchNoticeOperations,
  agentRunStateOperations,
  chatDispatchPauseOperations,
  type ScheduleHostResult,
  type NoticeRef,
  type NoticeRow,
  workspaceSearchOperations,
  folderAppOfferOperations,
  workspaceVersionOperations,
} from "./ipc/bridgeContract";
import { CHANNELS } from "./ipc/channels";
import { createSitesIpcHandlers } from "./ipc/sitesIpc";
import { createShareMountIpcHandlers } from "./ipc/shareMountIpc";
import { createEngineYDocSessionIpc } from "./workspaces/engineYDocSessionIpc";
import { createDocumentProjectionWorker } from "./workspaces/documentProjection";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { CreateCollectionRecordPayload } from "./ipc/bridgeContract";
import { collectionRecordWrites, type CollectionRecordEditContext } from "@dohc/automation-executor/collection-record-edits";
import { createRecordByHand, desktopRecordEditContext, type DesktopRecordEditHost, type LocalPersonAuthor } from "./workspaces/desktopRecordEdits";
import { deleteWorkspacePathByHand } from "./workspaces/workspaceFileMoves";
import { createWorkspaceFileMutationOwner } from "./workspaces/workspaceFileMutationOwner";
import { workspaceSearchHandlers } from "./ipc/workspaceSearchIpc";
import { scheduleHostHandlers } from "./ipc/scheduleHostIpc";
import { registerOperations, type OperationBoundary } from "./ipc/operationTable";
import { createUsageStore, USAGE_SNAPSHOT_NAME } from "./usage/usageStore";
import { createRendererUsage } from "./usage/rendererUsage";
import { DESKTOP_USAGE_COVERAGE } from "./usage/cliUsage";
import { usageRecordHandlers } from "./usage/usageRecord";

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
import { initialUpdateState, releaseChannelPreloadArguments } from "./updates/updateMachine";
import { createUpdateAfterFailure } from "./updates/updateAfterFailure";
import { confirmDownloadDialog, confirmRestartDialog, showDownloadingDialog } from "./updates/failureDialogs";
import { finishLaunch } from "./launch/launchMarker";
import {
  createExitRounds,
  createQuitGuard,
  type ExitKind,
} from "./quitGuard";
import { createVersionRounds } from "./versionRounds";
import { decideNavigation } from "./security/electronSecurity";
import { createDesktopTray } from "./window/desktopTray";
import { linuxTrayShown } from "./window/linuxTrayShown";
import { createDesktopWindows } from "./window/desktopWindows";
import { showMessageBox } from "./window/messageBox";
import { renderHtmlToPdf } from "./window/documentPdfExport";
import {
  allowLoopbackFrameOrigin,
  createMainWindow,
  navigationPolicy,
  rememberChromeTheme,
  titleBarOverlayOptions,
} from "./window/createMainWindow";
import {
  canonicalWorkspaceRoot,
  createWorkspaceFolder,
  createWorkspaceFolderWithFreshness,
  type CreatedWorkspace,
} from "./workspaces/createWorkspaceFolder";
import { createFolder, listFiles } from "./workspaces/workspaceFiles";
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
  removeWorkspace as removeRegisteredWorkspace,
  setWorkspaceRemote,
  pauseWorkspaceRemote,
  acknowledgeWorkspaceShareSkips,
  updateWorkspaceShareMounts,
  markWorkspaceShareRosterPulled,
  setWorkspaceShareRoster,
  setWorkspaceAutomationHost,
  setWorkspaceShareView,
  updateWorkspaceSharedChannels,
  reconcileWorkspaceRecipientShares,
  stateDir,
} from "./workspaces/WorkspaceRegistry";
import {
  recipientShareNeedsRecheck,
  readReceivedShareListing,
  reconcileRecipientSharesAfterLookup,
} from "./workspaces/recipientShareReconciliation";
import { createReceivedShareAcquisition, createReceivedShareStore, listReceivedInventory } from "./workspaces/receivedShareStore";
import { workspaceSyncPauseStatus, type WorkspaceSyncPause } from "@dohc/workspace-contracts/workspace-sync";
import { syncPauseFor } from "./workspaces/syncPauseFor";
import { createShareRosters, createHistoryLabels } from "./automations/shareRoster";
import { listRosterGrants, lookupHistoryAccounts } from "@dohc/automation-executor/roster-listing";
import {
  CollectionAutomations,
  type CollectionAutomationsOptions,
  type AutomationSwitchedOff,
  type CollectionAutomationRetry,
  type PressWaitReason,
} from "@dohc/automation-executor/collection-automations";
import { AutomationScheduler } from "@dohc/automation-executor/automation-scheduler";
import { parseReachHandover, type ReachRelayRecord } from "@dohc/automation-executor/reach-verdicts";
import {
  computerLabel,
  computersOfAnswer,
  createAutomationHosts,
  hostOfAnswer,
  createWorkspaceHosts,
  refusalOfAnswer,
  relayUnreachable,
} from "./automations/automationHost";
import { createScheduleRecords } from "./automations/scheduleRecords";
import { skippedRunsNotice } from "@dohc/automation-executor/skipped-runs-notice";
import { groupMessagesNotice } from "@dohc/automation-executor/group-messages-notice";
import { createRunNowIntents, type RunNowIntent } from "./automations/runNowIntents";
import { provedNeverShared, readSyncHistory, recordSynced, runSchedulesOn, scheduleComputer, workspaceMadeBy, type Computer } from "./workspaces/syncHistory";
import { closeActivity, holdBackground, leaveForeground, releaseBackground } from "./workspaces/activityRelease";
import { automationPressRelay, relayPressTransport } from "./automations/relayedPresses";
import { AutomationRunWait, SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import {
  createRelayedPressHost,
  relayedPressFailureNotice,
  type RelayedPressHost,
} from "@dohc/automation-executor/relayed-presses";
import {
  retryAutomationRun,
  retryFromFailureNotice,
  sendFailureNotices,
  switchedOffNotice,
  switcherNameFor,
  whoChangedLast,
  whoSwitchedOff,
} from "./automations/automationNotices";
import { automationFailedNoticeId } from "@dohc/automation-executor/automation-failed-notice";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { localAutomationStoreFolder } from "./automations/localAutomationStore";
import { findChatMessage, hasChatMessage, readChatDirectory } from "@dohc/automation-executor/automation-chat";
import { wakeAgent, wokenAgent, type WokenAgent } from "./automations/automationAgentWake";
import { createAutomationWakeConsumer, createAutomationWakeIntents } from "./automations/automationWakeIntents";
import type { AutomationChatMessage } from "@dohc/automation-executor/automation-chat";
import { createAutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import {
  createWorkspaceAuthorityOwner,
  type WorkspaceAuthorityBinding,
  type WorkspaceAuthorityLease,
  type WorkspaceAuthorityOperation,
  type WorkspaceAuthorityReservation,
} from "./workspaces/workspaceAuthorityOwner";
import {
  type RegistryEntry,
  type ShareMountRecord,
  type ShareViewIdentity,
} from "./workspaces/registryStore";
import {
  SHARE_VIEW_REOPEN_MESSAGE,
  shareViewIdentityIsIntact,
  shareViewIsPresent,
} from "./workspaces/shareViewMarker";
import { shareViewWriteScopeOf, workspaceWriteRefusal } from "./workspaces/shareWriteGate";
import {
  workspaceSummariesFrom,
  workspaceSummaryFor,
} from "./workspaces/workspaceSummaryProjection";
import { RELAY_FETCH_TIMEOUT_MS, assertSharedChannelWritable, joinedSharedChannelForWireId, relayFetchWithTimeout } from "./workspaces/sharedChannels";
import {
  resolveChatRelayIdentity,
  workspaceRemoteMatchesCredentials,
  type ChatRelayIdentityTarget,
} from "./workspaces/chatRelayIdentity";
import { createChatWrites } from "./workspaces/chatWrites";
import { localPersonOwnsWorkspace } from "./workspaces/localPersonOwns";
import { createNoticeStore, type NoticeSession, type NoticeStore } from "./notices/noticeStore";
import { createWorkspaceRefusalNotices } from "./notices/workspaceRefusalNotices";
import { noticeReachFor } from "./notices/noticeReach";
import { createCloudCredentialStore, mayUseKeychain } from "./workspaces/cloudCredentialStore";
import { createLastKnownDmRequestLanesCache } from "./workspaces/dmRequests";
import { readOrCreateLocalInstallationId } from "./workspaces/localInstallationIdentity";
import { createLocalAuthorship } from "./workspaces/localAuthorship";
import {
  createCloudLogin,
  runCloudLogoutTransition,
  type CloudLogin,
} from "./workspaces/cloudLogin";
import { createServerAccountDeletion } from "./workspaces/serverAccountDeletion";
import { registerServerAccountIpc } from "./ipc/serverAccountIpc";
import { insecureLoopbackServersForTests } from "./workspaces/cloudConfiguration";
import { createJoinedWorkspaceRunner } from "./workspaces/createJoinedWorkspace";
import { createOwnerLiveDocumentActions, createRelaySharesIpcHandlers, type OwnerLiveDocumentActionDependencies } from "./ipc/relaySharesIpc";
import { requireCredentials } from "./workspaces/credentialScopedOperation";
import { createExactMountOperationRunner } from "./workspaces/exactMountOperation";
import { CredentialSessionCache } from "./workspaces/credentialSessionCache";
import { createRelaySyncEngine } from "./workspaces/relaySyncEngine";
import { createRelayLogWait } from "./workspaces/relayLogWait";
import { awaitCredentialGeneration, chatShareSessionKey, handleRelayUnauthorized, RelaySessionError } from "./mainChatIpcHandlers";
import { buildShareCode, relayUrlsMatch } from "./workspaces/syncCode";
import {
  assertRealMountRoot,
  mountStoreWorkspaceIdFor,
  shareViewFilesMountProjection,
  updateShareMountRecords,
  usableShareMountRecord,
} from "./workspaces/shareMounts";
import { createShareMountCommands } from "./workspaces/shareMountCommands";
import { createShareSkipRecorder } from "./workspaces/shareSkipRecorder";
import { SharedChannelReadOnlyError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { type ShareAccess } from "@dohc/security-contract/share-selector";
import { datasetBaseFolder } from "@dohc/security-contract/dataset";
import {
  fetchShareViewInfo, fetchShareViewAccess, probeShareViewLog, fetchShareAutomationSwitchable,
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
  settleYDocsAfterFileObservation,
  createWorkspaceActivity,
  WorkspaceActivityState,
} from "./workspaces/workspaceActivity";
import type { WorkspaceEngineCapture } from "./workspaces/workspaceEngineCapture";
import { probeEngineStoreRefusal } from "./workspaces/workspaceEngineCapture";
import { createDesktopEngine } from "./workspaces/desktopEngine";
import { createUnwrittenReleases } from "./workspaces/ownerLiveReleases";
import { onWorkspaceCaptureSettled } from "./workspaces/captureActivityBridge";
import { resumeWorkspaceLinkRewrites } from "./workspaces/workspaceLinkRewrites";
import {createServerOwnerConnection} from "./workspaces/serverOwnerConnection";
import { createReceivedShareEngineAccess } from "./workspaces/receivedShareEngineAccess";
import { shareRecordStatuses } from "./workspaces/shareRecordStatus";
import { createReceivedShareRecord } from "./workspaces/receivedShareRecordCreation";
import { recordedShareSelector } from "./workspaces/shareViewRecords";
import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import { createCaptureLiveStores } from "./workspaces/workspaceEngineCaptureLiveStore";
import type { ActiveAgentRun } from "./agents/activeAgentRun";
import { startWorkspaceFileObservation } from "./workspaces/workspaceFileObservation";
import { createWorkspaceFilesWorker } from "./workspaces/workspaceFilesWorker";
import {
  createRustEngineDaemon,
  EngineClient,
  defaultEngineBinaryPath,
} from "@dohc/workspace-engine-client/daemon";
import {
  broadcastWorkspaceActivity,
  coalesceWorkspaceActivity,
  sendToWorkspaceWindows as sendToWorkspaceWindowsOf,
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
import {
  createChatDispatchService,
  type ChatDispatchPresenceInput,
  type ChatDispatchWorkspace,
} from "./agents/chatDispatchService";
import { createOwedRunNotices } from "./agents/owedRunNotices";
import { isAppImageBoot, isTemporaryMacAppPath, resolveDohcMcpCommand } from "./agents/dohcMcpCommand";
import { resolveDohcCliBinDirectory } from "./agents/chatRunnerProcess";
import { refreshLinuxStableCliBin } from "./agents/linuxStableCliBin";
import { CHAT_AGENT_PRESENCE_TOPIC } from "./collab/agentPresence";
import {
  createLiveAgentDispatchStore,
  type LiveAgentDispatchStoreHandle,
} from "./agents/liveAgentDispatchStore";
import { readFolderAppWorkspaceSources } from "./workspaces/folderAppWorkspaceSources";
import { createFolderAppDetection } from "./workspaces/folderAppDetection";
import { createOwnedSiteCatalog } from "./workspaces/ownedSiteCatalog";
import { createAppPreviewExecution } from "./workspaces/appPreviewExecution";
import { resolveShutdownDeadlineExitCode, WILL_QUIT_BUDGET_MS } from "./shutdownBudgets";
import { createSitePreviewLifecycle } from "./workspaces/sitePreviewLifecycle";
import type { SitePreviewResultBody } from "./ipc/sitePreviewIpc";

import {
  readWorkspaceText,
  resolveWorkspaceFile,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
  writeWorkspaceText,
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
import {
  createDesktopWorkspaceReads,
  type DesktopWorkspaceReadsDependencies,
} from "./workspaces/desktopWorkspaceReads";
import {
  workspaceDatabaseWorker,
  createWorkspaceDatabaseAccess,
} from "./workspaces/workspaceDatabase";
import { registerDesktopDatabaseIpcHandlers } from "./ipc/desktopDatabaseIpc";

import { createDesktopChatBookmarks, type DesktopChatBookmarkProjectionState } from "./workspaces/desktopChatBookmarks";
import { readCachedUserSettingsFile } from "./settings/userSettingsStore";
import { agentIdsNamedIn, automationAgent, firstAgent, listAgents, type Agent, type ThemeMode } from "./settings/userSettings";
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
import { adoptLoginShellPath, hasControllingTerminal, needsLoginShellPath } from "./process/loginShellPath";
import { guardedMoveToApplications, installedAppVersion, offerMoveToApplications } from "./moveToApplications";
import { installCrashCapture } from "./crashReports/crashCapture";
import { createCodeFrames, createCodeLocations, crashReportRoot, type CrashEvent } from "./crashReports/crashReport";
import { confirmCrashReportSend } from "./crashReports/crashReportConsent";
import { confirmWorkspaceTrust, createWorkspaceTrust, folderIdentity } from "./workspaces/workspaceTrust";
import { workspaceTrustHandlers } from "./ipc/workspaceTrustIpc";
import { createCrashReportPreview } from "./crashReports/crashReportPreview";
import { createCrashReportStore, crashReportEndpoint } from "./crashReports/crashReportStore";
import { REPORTING_BUILD, resolveReporting } from "./telemetry/reportingConfig";
import { createTelemetry, privacyInEffect, usageEventFor } from "./telemetry/telemetry";
import { diagnosticsText, saveDiagnostics } from "./telemetry/diagnostics";
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

// Finder and the Dock start a packaged dohc with launchd's PATH, where the
// dohc CLI's node, npm-installed agents, and Homebrew tools are missing. A
// Linux desktop's launcher starts it with the session's PATH, which misses
// what only the shell adds, such as nvm and its npm-installed agents. The
// login shell's PATH is read once, in parallel with startup, once this
// instance holds the single-instance lock, unless a Linux terminal started
// dohc (needsLoginShellPath). Agent runs and agent detection wait for it, at
// most for its timeout.
let loginShellPathRead: Promise<void> = Promise.resolve();

let usageStore: ReturnType<typeof createUsageStore> | undefined;
let usageLoad: ReturnType<typeof setImmediate> | undefined;
// Each window reports it to Notices, with Try again to read the file again.
function usageRecordStopped(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.usageRecordStopped);
  }
}
const rendererUsage = createRendererUsage<IpcMainInvokeEvent>(invocation => usageStore?.recordSuccess(invocation));

const crashFacts = () => ({
  atMs: Date.now(),
  version: app.getVersion(),
  channel: resolveUpdateChannel(app.getVersion()),
  packaged: app.isPackaged,
  system: `${osType()} ${osRelease()}`,
  arch: process.arch,
  electron: process.versions.electron ?? "unknown",
  uptimeSeconds: Math.round(process.uptime()),
});
const codeRoots = [crashReportRoot({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })];

// Crashes are recorded on this computer before anything else can crash. A
// detailed report leaves only when the person confirms in main's own
// dialog, and only to the report server this build names.
const crashReports = createCrashReportStore({
  path: join(stateDir(), "crash-report.json"),
  endpoint: crashReportEndpoint(process.env.DOHC_CRASH_REPORT_URL, app.isPackaged),
  facts: crashFacts,
  codeFrame: createCodeFrames(codeRoots, process.platform),
  onChanged: () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.crashReportChanged);
    }
  },
});
// Whether this computer runs each workspace's app commands. Main's own
// record, in this computer's dohc profile: nothing in a workspace sets it.
const workspaceTrust = createWorkspaceTrust({
  file: join(stateDir(), "workspace-trust.json"),
  onChange: (workspaceId, trusted) => agentTrustChanged(workspaceId, trusted),
});

// Every trust change, from the dialog, Settings, Forget, or New workspace:
// the held notice and the ask on a send come once per change, and requests
// Restricted Mode held start once trusted, without another message.
function agentTrustChanged(workspaceId: string, trusted: boolean): void {
  chatDispatchService.trustChanged(workspaceId);
  chatDispatchNotices.clear(workspaceId, "restricted");
  if (!trusted) return;
  void chatDispatchService.scanWorkspace(workspaceId).catch((error) => {
    console.error("[desktop] chat dispatch scan after trust:", error);
  });
}

// The windows showing a workspace follow its trust at once.
function notifyWorkspaceTrustChanged(workspaceId: string, trusted: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || rendererWorkspaceSessions.current(win.webContents)?.workspaceId !== workspaceId) continue;
    win.webContents.send(CHANNELS.workspaceTrustChanged, { workspaceId, trusted });
  }
}

// A preview left by a dohc that ended while its dialog was open goes now.
const crashReportPreview = createCrashReportPreview({
  path: join(stateDir(), "crash-report-to-send.txt"),
  openPath: (path) => shell.openPath(path),
});
void crashReportPreview.remove();
// Usage and short error reports. Only a packaged build that names a PostHog
// project sends them, and only as the switches in Privacy allow.
const telemetry = createTelemetry({
  reporting: resolveReporting({
    build: REPORTING_BUILD,
    packaged: app.isPackaged,
    env: process.env,
    argv: process.argv,
  }),
  statePath: join(stateDir(), "reporting.json"),
  facts: () => ({
    atMs: Date.now(),
    version: app.getVersion(),
    channel: resolveUpdateChannel(app.getVersion()),
    os: osType(),
    osVersion: osRelease(),
    arch: process.arch,
    electron: process.versions.electron ?? "unknown",
  }),
  locate: createCodeLocations(codeRoots, process.platform),
  readCode: (path) => readFile(join(codeRoots[0]!, path), "utf8"),
});
// The report switches as the settings file sets them. A file main cannot
// read turns both off.
const readPrivacy = () => readCachedUserSettingsFile(stateDir()).then(
  privacyInEffect,
  () => ({ usageReports: false, errorReports: false }),
);
if (telemetry.available.usage || telemetry.available.errors) {
  void readPrivacy().then((privacy) => telemetry.setPrivacy(privacy));
}
telemetry.track({ name: "app_launched" });
function recordCrash(event: CrashEvent): void {
  crashReports.record(event);
  telemetry.reportError({ kind: "crash", event });
}
installCrashCapture({
  process,
  app,
  isWindowPage: (contents: WebContents) => BrowserWindow.fromWebContents(contents)?.webContents === contents,
  record: recordCrash,
});

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
  lookupOwnedWorkspaceFilesFor,
  ownedWorkspaceReadsFor,
} = createDesktopWorkspaceReads({
  listDiskFiles: (rootPath, scope) => workspaceFilesWorker.list(rootPath, scope),
  withPhysicalWorkspaceOperation,
  isRecordValue,
  get desktopEngine(): DesktopWorkspaceReadsDependencies["desktopEngine"] {
    return desktopEngine;
  },
  get shareViewFiles(): DesktopWorkspaceReadsDependencies["shareViewFiles"] {
    return shareViewFiles;
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
  if (!workspace) throw new Error("This workspace is not open. Open it again.");
  return workspace;
}

// PR 18 read-only shared views: a shared view is a read-only local workspace.
// `sharedViewOf` is the one authoritative predicate; every mutation surface
// (file writes, agent runs, and the MCP config)
// routes through it so a shared view can never be changed, only read. The
// renderer also hides its edit affordances; this main-process layer is the
// enforcement that cannot be skipped. Every caller that asks only "is this a
// share view?" reads the object's presence, never its level.
function sharedViewOf(workspaceId: string): ReturnType<typeof shareViewWriteScopeOf> {
  const entry = findWorkspace(workspaceId);
  return entry ? shareViewWriteScopeOf(entry.shareView) : null;
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
let autoUpdateStartup: Promise<AutoUpdateController | null> | null = null;

// app.getAppPath() is unreliable here: when Electron is launched with a
// direct script path (as the e2e harness does, and as a plain built binary
// is), it resolves to the launched script's own directory (dist/main) rather
// than the package root, with no upward package.json search — it silently
// pointed resource resolution at dist/main/resources. import.meta.dirname is
// the currently executing module's own directory (dist/main at runtime), so two
// levels up reaches apps/desktop deterministically regardless of how
// Electron was launched. Every dev-mode resolver walks from here, so this
// one call site is the only place that encodes that layout.
function desktopPackageRootInDev(): string {
  return join(import.meta.dirname, "..", "..");
}

function resourcesBasePath(): string {
  return app.isPackaged
    ? process.resourcesPath
    : join(desktopPackageRootInDev(), "resources");
}

// Automation runs finished, an Undo put records back, a claim failed, or a
// retry queued one: poke the windows on that workspace to read its run
// history and dataset records again. A poke, not the record, so nothing here can go stale or leak across
// workspaces.
function notifyAutomationRunsChanged(workspaceId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (
      rendererWorkspaceSessions.current(win.webContents)?.workspaceId !==
      workspaceId
    ) {
      continue;
    }
    win.webContents.send(CHANNELS.automationRunsChanged, { workspaceId });
  }
}

// The windows that pressed a Button field hear how its run went, while they
// still show the workspace they pressed in.
const pressWindows = createPressWindows<WebContents>(
  (sender) => rendererWorkspaceSessions.current(sender)?.workspaceId ?? null,
);

// The person a press acts for: the signed-in account, read after the
// credential cache is warm, or this computer's own id when signed out.
async function pressingPerson(): Promise<string> {
  await warmCredentialCache();
  return localUserId();
}

// Whether this computer's person owns the workspace: a workspace that never
// synced is its computer's person's, and a synced one is its owner
// account's. A shared view is never this person's.
async function localPersonOwns(workspaceId: string): Promise<boolean> {
  await warmCredentialCache();
  return localPersonOwnsWorkspace(findWorkspace(workspaceId), cachedCredentials);
}

// A Collection automation step started or stopped waiting for a current
// editor: the windows on that workspace re-list the hold notices.
function notifyAutomationHoldsChanged(workspaceId: string): void {
  notifyWorkspaceWindows(workspaceId, CHANNELS.automationHoldsChanged);
}

// The automations main read from a workspace changed, or a shared view's host
// answered a Button check: the windows on that workspace re-read the ⚡ field
// marks and their Buttons' states.
function notifyCollectionAutomationsChanged(workspaceId: string): void {
  notifyWorkspaceWindows(workspaceId, CHANNELS.collectionAutomationsChanged);
}

function notifyWorkspaceWindows(workspaceId: string, channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (rendererWorkspaceSessions.current(win.webContents)?.workspaceId !== workspaceId) continue;
    win.webContents.send(channel, { workspaceId });
  }
}

const shareDirectWriteDelivery = createShareDirectWriteDelivery<WebContents>({
  targets: () => BrowserWindow.getAllWindows().map(window => window.webContents),
  currentSession: sender => rendererWorkspaceSessions.current(sender),
  isSharedView: workspaceId => shareViewIsPresent(findWorkspace(workspaceId)?.shareView),
});

// Main's queue of direct pushes, once the IPC handlers are registered.
let shareDirectWrites: { shareViewEdited(workspaceId: string): void; recordCreated(workspaceId: string): void } | null = null;

const {
  withWorkspaceAttachment,
  withWorkspaceAttachmentAsync,
  createRelayOnChange,
  onWatcherBatch,
  onObservationResync,
} = createDesktopWorkspaceCallbacks<DesktopWorkspaceAuthorityState>({
  findWorkspace,
  requireWorkspaceAuthority,
  notifyRenderer,
  get workspaceAuthorities(): DesktopWorkspaceCallbacksDependencies<DesktopWorkspaceAuthorityState>["workspaceAuthorities"] {
    return workspaceAuthorities;
  },
  get chatDispatchService(): DesktopWorkspaceCallbacksDependencies<DesktopWorkspaceAuthorityState>["chatDispatchService"] {
    return chatDispatchService;
  },
  collectionAutomationsOf: (state) => state.collectionAutomations,
});

let linuxStableCliBinDir: string | undefined;

const executeAppPreview = createAppPreviewExecution({
  get shareViewFiles() { return shareViewFiles; },
  get shareViewFilesTargetForPath() { return shareViewFilesTargetForPath; },
  assertMayRunAppCode: (workspace) => workspaceTrust.assertTrusted(workspace),
});

// Lazy: safeStorage and userData are only safe to touch after app ready, and
// handlers register inside whenReady. The session token lives encrypted in
// the credential store and never crosses IPC.
let cachedCloudLogin: CloudLogin | null = null;
function cloudLogin(): CloudLogin {
  if (!cachedCloudLogin) {
    cachedCloudLogin = createCloudLogin({
      allowInsecureLoopbackForTests: !app.isPackaged && insecureLoopbackServersForTests(process.env),
      store: createCloudCredentialStore({
        dir: stateDir(),
        cipher: mayUseKeychain({ isPackaged: app.isPackaged, platform: process.platform, env: process.env }) ? {
          isAvailable: () => safeStorage.isEncryptionAvailable(),
          encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
          decrypt: (cipherText) =>
            safeStorage.decryptString(Buffer.from(cipherText, "base64")),
        } : undefined,
      }),
    });
  }
  return cachedCloudLogin;
}

// Live file-watch → history pipeline. Pushes a renderer notification whenever
// a settled batch is recorded so the file tree, timeline, and sync status
// refresh without polling. A scoped push reaches only windows whose active
// workspace matches, so a window on
// workspace B never refetches its world for workspace A's activity. Only a
// genuinely cross-workspace event (logout, registry change, daemon
// relaunch) broadcasts scope-free.
const workspaceFilesWorker = createWorkspaceFilesWorker();
const workspaceFileListings = new WorkspaceFileListingCache(process.platform, async (workspaceId, attachmentId, paths) => {
  const lease = requireWorkspaceAuthority(workspaceId);
  try {
    if (lease.binding.attachmentId !== attachmentId) return [];
    const workspace = canonicalWorkspaceFor(lease);
    const diskPaths = sharedViewOf(workspaceId) ? [] : paths.filter(path =>
      !shareMountRegistryIsPresent(workspace) || !path.startsWith("shared-with-me/"));
    const result = await workspaceFilesWorker.metadata(lease.binding.canonicalRootPath, diskPaths);
    lease.assertCurrent();
    return result.files;
  } finally { lease.release(); }
});

const notifyRendererCoalesced = coalesceWorkspaceActivity(sendRendererActivity);
function notifyRenderer(scope?: WorkspaceActivityScope): void { notifyRendererCoalesced(scope); }

function sendRendererActivity(scope?: WorkspaceActivityScope): void {
  if (scope) {
    for (const workspace of listWorkspaces()) {
      const mounts = storedShareMounts(workspace);
      const mount = mounts.find(mount => usableShareMountRecord(mounts, mount)
        && mountStoreWorkspaceIdFor(workspace.workspaceId, mount.shareId) === scope?.workspaceId);
      if (mount) {
        scope = { workspaceId: workspace.workspaceId,
          ...(scope.summaryChanged ? { summaryChanged: true } : {}),
          ...(scope.pathSetChanged !== undefined ? { pathSetChanged: scope.pathSetChanged } : {}),
          ...(scope.paths ? { paths: scope.paths.map(path => `shared-with-me/${mount.label}/${path}`) } : {}) };
        break;
      }
    }
  }
  const activityEvent = workspaceActivityPayload(scope);
  workspaceFileListings.invalidate(activityEvent);
  invalidateDatasetAddresses(activityEvent);
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
// Every window's preload gets that decision and this build's release channel.
const preloadArguments = [
  ...devToolsPreloadArguments(devToolsGranted),
  ...releaseChannelPreloadArguments(resolveUpdateChannel(app.getVersion())),
];

const desktopWindows = createDesktopWindows({
  app, Menu, dialog, process, workspaceSummaries, currentUpdateState,
  stateDir, readCachedUserSettingsFile, createMainWindow,
  // Menu clicks arrive after startup, when the settings owner exists.
  stepWindowZoom: (step) => settingsIpc.stepWindowZoom(step),
  preloadArguments,
  afterRendererCrashLoop,
  get rendererWorkspaceSessions(): Pick<
    RendererWorkspaceSessionOwner<WebContents>, "current" | "currentDocumentId" | "retireForReload" | "retireAfterCrash"
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
  broadcastUserSettings, broadcastAgentColor,
  refreshApplicationMenu,
  refreshNativeWorkspaceSurfaces,
  prepareForRendererReload,
  prepareAfterRendererCrash,
  showOrCreateMainWindow,
} = desktopWindows;
// Synchronous mirror of the credential store for status derivation (the
// status handler path is hot). Refreshed at ready, login, and logout.
type CloudSessionCredentials = NonNullable<
  Awaited<ReturnType<CloudLogin["credentials"]>>
>;
let cachedCredentials: CloudSessionCredentials | null = null;
let clearButtonInspections: (() => void) | undefined;
let retryStopAndRestoreReleases: (() => void) | undefined;
// The folders an account change has not removed yet, and the accounts that
// left, stay in this record. The next start removes those folders before any
// copy opens. Every window shows what is left.
const ownerDatasetCopies = createOwnerDatasetCopyRegistry({
  record: join(stateDir(), "dataset-copy-removals.json"),
  workspaces: () => listWorkspaces().map(workspace => workspace.rootPath),
  onLeftover: () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.collectionCopiesLeftChanged);
    }
  },
});
const namedDatasetPages = createNamedDatasetCacheRegistry({ directory: () => join(stateDir(), "named-dataset-pages") });
let credentialCacheGeneration = 0;
let receivedShareCredentialsChanged: ((current: CloudSessionCredentials | null, settled: boolean) => void) | undefined;
// Who History credits this computer's edits to. A credential load's
// placeholder null never relabels edits made meanwhile.
const localAuthorship = createLocalAuthorship({
  installationId: () => localInstallationId(),
  loadCredentials: () => credentialSessionCache.warm(() => cloudLogin().credentials()),
});
let ownerDeliveryCredentialLifetime = new AbortController();
// Share kind is relay/account-scoped, not workspace-scoped. Keep one cache
// across physical workspaces in the same session, and clear it whenever that
// credential session ends or changes.
const peekedReceivedGrantKinds = new Map<string, "dm" | "not-dm">();
const credentialSessionCache =
  new CredentialSessionCache<CloudSessionCredentials>((snapshot, settled) => {
    ownerDeliveryCredentialLifetime.abort();
    ownerDeliveryCredentialLifetime = new AbortController();
    const buttonAccountChanged = chatShareSessionKey(cachedCredentials) !== chatShareSessionKey(snapshot.credentials);
    cachedCredentials = snapshot.credentials;
    credentialCacheGeneration = snapshot.generation;
    receivedShareCredentialsChanged?.(cachedCredentials, settled);
    if (buttonAccountChanged) {
      refreshSharedButtonInspections(() => clearButtonInspections?.(),
        activity.listOpenWorkspaceIds().filter(workspaceId => sharedViewOf(workspaceId) !== null),
        notifyCollectionAutomationsChanged);
    }
    if (settled) localAuthorship.credentialsSettled(snapshot.credentials?.userId ?? null);
    void ownerDatasetCopies.credentialsChanged(snapshot.credentials ? datasetCopyOwnerKey(snapshot.credentials) : null)
      .catch(error => console.error("Collection copy cleanup failed", error));
    // A credential load publishes a temporary null first. Keep saved pages until the account is known.
    if (snapshot.credentials) void namedDatasetPages.credentialsChanged(datasetCopyOwnerKey(snapshot.credentials))
      .catch(error => console.error("Saved Collection page cleanup failed", error));
    shareHandoffRedemption.credentialsChanged();
    // The notice list shows the signed-in account's notices.
    notifyNoticesChanged();
    if (snapshot.credentials) void noticeStore().sync();
    if (snapshot.credentials) resumeAutomationSessionWaits();
    if (settled && snapshot.credentials) retryStopAndRestoreReleases?.();
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

// Notices sent to the signed-in person, and this computer's own. The store
// pulls after workspace/share changes and settled press receipts, at sign-in,
// and when a window gains focus.
let cachedNoticeStore: NoticeStore | null = null;
// The signed-in session from one credential snapshot: the account and every
// reach read the same credentials, and the session stops being current as
// soon as the credentials change.
async function noticeSession(): Promise<NoticeSession | null> {
  await warmCredentialCache();
  const { credentials, generation } = credentialSessionCache.snapshot();
  if (!credentials?.relayUrl) return null;
  return {
    account: {
      key: chatShareSessionKey(credentials)!,
      userId: credentials.userId,
      relay: {
        baseUrl: credentials.relayUrl,
        token: credentials.token,
        fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
      },
    },
    isCurrent: () => credentialSessionCache.snapshot().generation === generation,
    // An owned workspace is named; a share view is reached through its share.
    reachFor: (workspaceId) => {
      const workspace = findWorkspace(workspaceId);
      return workspace ? noticeReachFor(workspace, credentials) : null;
    },
  };
}
function notifyNoticesChanged(): void {
  if (app.isReady()) void automationWakeConsumer.resume();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNELS.noticesChanged);
  }
}
function noticeStore(): NoticeStore {
  cachedNoticeStore ??= createNoticeStore({
    directory: join(stateDir(), "notices"),
    session: noticeSession,
    installId: localInstallationId,
    onChanged: notifyNoticesChanged,
    ...createWorkspaceRefusalNotices({
      sessions: () => desktopEngine.sessions,
      workspaces: listWorkspaces,
      withOperation: withPhysicalWorkspaceOperation,
      workspaceForRegistered: workspace => receivedShareEngine.workspaceForRegistered(workspace),
    }),
  });
  return cachedNoticeStore;
}
app.on("browser-window-focus", () => void noticeStore().sync());

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
async function remoteForWorkspace(workspace: RegistryEntry, options?: { allowPaused: boolean }) {
  await warmCredentialCache();
  const credentialGeneration = credentialCacheGeneration;
  const remote = workspace.remote ?? (options?.allowPaused ? workspace.pausedRemote : undefined);
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
  await recordSyncedIfNeeded(workspace);
  return { credentials, credentialGeneration };
}

// The registry can know a workspace synced before its own folder does, as
// for one synced before the folder kept a record. Mark it in the folder,
// once per run, for a folder that is there.
const syncRecorded = new Set<string>();
async function recordSyncedIfNeeded(workspace: RegistryEntry): Promise<void> {
  if (syncRecorded.has(workspace.workspaceId)) return;
  if (!existsSync(join(workspace.rootPath, ".dohc", "manifest.json"))) return;
  await recordSynced(workspace.rootPath);
  syncRecorded.add(workspace.workspaceId);
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
    // One relay code for every chat refusal, and the desktop refuses the
    // general group, the agent lane, and direct-message-as-group before it
    // asks the relay. What remains is a group the relay has not synced yet.
    case "invalid_chat":
      return "This can't be shared yet. Wait for it to sync, then try again.";
    case "ambiguous_selector":
      return "A group is shared as it is now, not at a version. Share it without choosing a version.";
    default:
      return data?.error ?? `Sharing failed (${status}).`;
  }
}

type RelayShareRetainedDependentSetResult<T> =
  | { kind: "success"; body: T }
  | { kind: "dependents-changed"; body: unknown; status: number };

type RelayShareRetainedNotFoundResult<T> =
  | { kind: "success"; body: T }
  // `removed`: the relay said the owner removed this account's access, as
  // opposed to a share it does not know.
  | { kind: "missing"; removed: boolean };

// `unavailable`: the relay itself answered not found, so it does not publish apps for this workspace and account.
type RelayShareRetainedUnavailableResult<T> = { kind: "success"; body: T } | { kind: "unavailable" };

type RelayShareJsonOptions =
  | { retainDependentSetConflict: true }
  | { retainNotFound: true }
  | { retainUnavailable: true }
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
  init: RequestInit | undefined,
  options: { retainUnavailable: true },
): Promise<RelayShareRetainedUnavailableResult<T>>;
async function relayShareJsonWithCredentials<T>(
  credentials: CloudSessionCredentials,
  path: string,
  init?: RequestInit,
  options?: RelayShareJsonOptions,
): Promise<
  | T
  | RelayShareRetainedDependentSetResult<T>
  | RelayShareRetainedNotFoundResult<T>
  | RelayShareRetainedUnavailableResult<T>
> {
  if (!credentials.relayUrl) {
    throw new Error("Reconnect your server to refresh its connection settings, then try again.");
  }
  const creation = /^\/sync\/([^/]+)\/shares(?:\/links)?$/.exec(path);
  if (creation && init?.method === "POST" && typeof init.body === "string") {
    const workspace = findWorkspace(decodeURIComponent(creation[1]!));
    if (workspace && !shareViewIsPresent(workspace.shareView)) {
      const input = JSON.parse(init.body) as Record<string, unknown>;
      const labels = await labelsForOwnerShare(workspace, credentials, input);
      init = {...init, body: JSON.stringify({...input, ...labels})};
    }
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
      (data.code === "not_found" || data.code === "share_access_removed")
    ) {
      return { kind: "missing", removed: data.code === "share_access_removed" };
    }
    if (options && "retainUnavailable" in options && publicationListUnavailable(response.status, data)) {
      return { kind: "unavailable" };
    }
    throw new Error(relayShareErrorCopy(response.status, data));
  }
  if (options && !("retainRestoreConflict" in options)) {
    return { kind: "success", body: data as T };
  }
  return data as T;
}

async function ownerGroupNames(workspace: EngineWorkspace) {
  const store = linkedChatStoreFor(workspace);
  const names = new Map<string, string>();
  for (const channel of await store.listChannels({workspaceId: workspace.workspaceId})) {
    if (channel.kind !== "channel") continue;
    const wireId = await store.getChannelWireId({workspaceId: workspace.workspaceId, channelId: channel.id});
    if (wireId) names.set(wireId, channel.name);
  }
  return names;
}

async function labelsForOwnerShare(workspace: EngineWorkspace, credentials: CloudSessionCredentials, selector: {paths?: unknown; channelWireId?: unknown}, options: {refresh?: boolean; groupNames?: () => Promise<Map<string, string>>} = {}) {
  const generation = credentialCacheGeneration;
  const lease = requireWorkspaceAuthority(workspace.workspaceId);
  try {
    lease.assertCurrent();
    if (cachedCredentials?.token !== credentials.token || cachedCredentials.userId !== credentials.userId) throw new Error("Your server session changed. Try again.");
    if (workspace.attachmentId !== undefined && workspace.attachmentId !== lease.binding.attachmentId) throw new Error("This workspace was closed. Open it again.");
    const lookup = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try {return await read();} catch (error) {if (options.refresh) throw error; return null;}
    };
    const labels = await ownerShareLabels({rootPath: workspace.rootPath, selector,
      appName: async path => {
        const config = await lookup(() => readWorkspaceTextIfPresent(workspace.rootPath, `${path}/dohc.json`));
        return config && !config.truncated ? parseDohcSiteConfig(config.text).config?.title ?? null : null;
      },
      groupName: async wireId => (await lookup(options.groupNames ?? (() => ownerGroupNames(workspace))))?.get(wireId) ?? null});
    lease.assertCurrent();
    if (generation !== credentialCacheGeneration) throw new Error("Your server session changed. Try again.");
    return labels;
  } finally {lease.release();}
}

async function relayShareJson<T>(path: string, init?: RequestInit): Promise<T> {
  await warmCredentialCache();
  const credentials = requireCredentials(cachedCredentials, RelaySessionError);
  return relayShareJsonWithCredentials(credentials, path, init);
}

// Live account listings record removals; an exact-share read confirms resumptions.
async function reconcileReceivedShares(listing: unknown, acquisitionIsCurrent: () => boolean = () => true): Promise<void> {
  const parsed = readReceivedShareListing(listing);
  const credentials = cachedCredentials;
  const generation = credentialCacheGeneration;
  if (!parsed || !credentials?.relayUrl || !acquisitionIsCurrent()) return;
  for (const entry of listWorkspaces()) {
    try {
      const changed = await reconcileRecipientSharesAfterLookup({
        listing: parsed,
        credentials,
        currentEntry: () => findWorkspace(entry.workspaceId),
        updateEntry: (reconcile) => reconcileWorkspaceRecipientShares(entry.workspaceId, reconcile),
        isCurrent: () => generation === credentialCacheGeneration && acquisitionIsCurrent(),
        lookupShare: (shareId) => relayShareJsonWithCredentials<unknown>(
          credentials, `/sync/shares/${encodeURIComponent(shareId)}`,
        ),
        onLookupError: (shareId, error) =>
          console.warn(`[desktop] received share lookup for ${shareId}:`, error),
      });
      if (changed) notifyRenderer({ workspaceId: entry.workspaceId });
    } catch (error) {
      console.warn(`[desktop] received share reconciliation for ${entry.workspaceId}:`, error);
    }
  }
}

// Account-wide observations belong to stateDir and never authorize workspace operations.
const receivedShareStore = createReceivedShareStore(join(stateDir(), "received-shares"));
const receivedShareAcquisition = createReceivedShareAcquisition({
  store: receivedShareStore,
  scope: () => cachedCredentials?.relayUrl ? {
    userId: cachedCredentials.userId, relayUrl: cachedCredentials.relayUrl, generation: credentialCacheGeneration,
  } : null,
  list: async scope => {
    const credentials = cachedCredentials;
    if (!credentials || scope.generation !== credentialCacheGeneration) throw new Error("Server session changed.");
    return listReceivedInventory(path => relayShareJsonWithCredentials<unknown>(credentials, path), () => {
      if (scope.generation !== credentialCacheGeneration) throw new Error("Server session changed.");
    });
  },
  onLive: (inventory, _scope, isCurrent) => reconcileReceivedShares(inventory, isCurrent),
  logError: error => console.warn("[desktop] received share observation:", error),
});

receivedShareCredentialsChanged = (current, settled) => {
  const scope = (credentials: CloudSessionCredentials | null) => credentials?.relayUrl ? {
    userId: credentials.userId, relayUrl: credentials.relayUrl, generation: credentialCacheGeneration,
  } : null;
  receivedShareAcquisition.credentialsChanged(scope(current), settled);
};

// The account file remains while another registered workspace can use it.
function removeWorkspace(workspaceId: string): void {
  removeRegisteredWorkspace(workspaceId);
  if (listWorkspaces().length !== 0) return;
  receivedShareAcquisition.retire();
  if (cachedCredentials?.relayUrl) receivedShareStore.remove({
    userId: cachedCredentials.userId, relayUrl: cachedCredentials.relayUrl, generation: credentialCacheGeneration,
  });
}

// Existing received-copy recovery uses a live listing, without refreshing the Access store.
let removalRecheck: { generation: number; startedAt: number; pending: Promise<void> } | null = null;
async function recheckRemovedShares(workspaceId: string): Promise<void> {
  const entry = findWorkspace(workspaceId);
  if (!entry || !recipientShareNeedsRecheck(entry)) return;
  await warmCredentialCache();
  const credentials = cachedCredentials;
  if (!credentials?.relayUrl) return;
  const generation = credentialCacheGeneration;
  if (removalRecheck?.generation === generation && Date.now() - removalRecheck.startedAt < 30_000) {
    return removalRecheck.pending;
  }
  const pending = (async () => {
    try {
      const listing = await awaitCredentialGeneration({
        capturedGeneration: generation,
        currentGeneration: () => credentialCacheGeneration,
        run: () => relayShareJsonWithCredentials<unknown>(credentials, "/sync/shares"),
      });
      await reconcileReceivedShares(listing, () => generation === credentialCacheGeneration);
    } catch (error) {
      console.warn(`[desktop] share removal recheck for ${workspaceId}:`, error);
    }
  })();
  removalRecheck = { generation, startedAt: Date.now(), pending };
  await pending;
}

const rosterContexts = new Map<string, { generation: number; binding: unknown }>();
function rosterContext(workspaceId: string): unknown {
  let binding: unknown = null;
  try { binding = workspaceAuthorities.currentBinding(workspaceId); } catch { /* The attachment retired. */ }
  let context = rosterContexts.get(workspaceId);
  if (!context || context.generation !== credentialCacheGeneration || context.binding !== binding) {
    context = { generation: credentialCacheGeneration, binding };
    rosterContexts.set(workspaceId, context);
  }
  return context;
}

// Each open workspace's copy of the grants its owner gave, for the automation
// reach check.
const shareRosters = createShareRosters({
  findWorkspace,
  context: rosterContext,
  saveRoster: setWorkspaceShareRoster,
  markRosterPulled: markWorkspaceShareRosterPulled,
  listRoster: async (workspace) => {
    let credentials: CloudSessionCredentials;
    try {
      ({ credentials } = await remoteForWorkspace(workspace, { allowPaused: true }));
    } catch (error) {
      // Signed out, or signed in to another account or server: the message
      // says which, and dohc could not ask.
      return { kind: "unanswered", next: error instanceof Error ? error.message : "Sign in to your server first.", partial: false };
    }
    if (!credentials.relayUrl) {
      return { kind: "unanswered", next: "Reconnect your sharing server, then try again.", partial: false };
    }
    return listRosterGrants(workspace.workspaceId, async (path) => {
      const response = await relayShareResponseWithCredentials(credentials, path, { method: "GET" });
      return { status: response.status, body: await response.json().catch(() => undefined) };
    });
  },
  localUserId: async () => {
    await warmCredentialCache().catch(() => undefined);
    return cachedCredentials?.userId ?? null;
  },
  // This computer's own id for its person names them, signed in or not, only
  // where nobody else ever had a part in the workspace.
  localPersonId: async (workspace) => {
    const proved = await provedNeverShared(workspace, () =>
      withEngineAdapter(workspace, (adapter) => adapter.remoteChangesApplied()).catch(() => null));
    return proved ? localInstallationId() : null;
  },
  syncHistory: (workspace) => readSyncHistory(workspace.rootPath),
  logError: (workspaceId, error) =>
    console.warn(`[desktop] share roster refresh failed for ${workspaceId}:`, error),
  onListed: (workspaceId) => collectionAutomationsOf(workspaceId)?.rosterChanged(),
});

const historyLabelWindows = new Map<WebContents, ReturnType<typeof createHistoryLabels>>();
function invalidateHistoryLabels(workspaceId: string | null): void {
  for (const labels of historyLabelWindows.values()) labels.invalidate(workspaceId);
}
function historyLabelsFor(sender: WebContents): ReturnType<typeof createHistoryLabels> {
  const existing = historyLabelWindows.get(sender);
  if (existing) return existing;
  const labels = createHistoryLabels({
    snapshot: (workspaceId) => {
      const workspace = findWorkspace(workspaceId);
      const remote = workspace?.remote ?? workspace?.pausedRemote;
      return { roster: shareRosters.observation(workspaceId).listing, shareView: workspace?.shareView,
        owner: !sender.isDestroyed() && !!remote && !workspace?.shareView && workspaceRemoteMatchesCredentials(remote, cachedCredentials),
        context: rosterContext(workspaceId), inventory: workspace?.shareRoster?.version };
    },
    ready: workspaceId => {
      if (!sender.isDestroyed() && rendererWorkspaceSessions.current(sender)?.workspaceId === workspaceId) sender.send(CHANNELS.historyNamesChanged, { workspaceId });
    },
    lookupAccounts: async (workspaceId, ids) => {
      const workspace = findWorkspace(workspaceId);
      if (!workspace?.remote || workspace.shareView) return null;
      await warmCredentialCache();
      const { credentials } = await remoteForWorkspace(workspace);
      return lookupHistoryAccounts(workspaceId, async path => {
        const response = await relayShareResponseWithCredentials(credentials, path, { method: "GET" });
        return { status: response.status, body: await response.json().catch(() => undefined) };
      }, ids);
    },
  });
  if (!sender.isDestroyed()) {
    historyLabelWindows.set(sender, labels);
    sender.once("destroyed", () => {
      labels.invalidate(null);
      historyLabelWindows.delete(sender);
    });
  }
  return labels;
}

const accessAcquisition = createAccessAcquisition({
  roster: workspaceId => shareRosters.requestRefresh(workspaceId),
  received: () => receivedShareAcquisition.refresh(),
});
const accessScopeIds = new WeakMap<object, string>();
type AccessWorkspaceOperation = { workspace: RegistryEntry & { attachmentId: symbol }; signal: AbortSignal; assertCurrent(): void };
const accessOwner = createAccessOwner<AccessWorkspaceOperation>({
  scope: operation => {
    const context = rosterContext(operation.workspace.workspaceId) as object;
    let id = accessScopeIds.get(context);
    if (!id) { id = randomUUID(); accessScopeIds.set(context, id); }
    return id;
  },
  assertCurrent: operation => operation.assertCurrent(),
  account: () => cachedCredentials ? { userId: cachedCredentials.userId, email: cachedCredentials.email,
    relayUrl: cachedCredentials.relayUrl, generation: credentialCacheGeneration } : null,
  roster: ({ workspace }) => ownerAccessRoster(workspace, cachedCredentials, shareRosters.observation),
  received: () => receivedShareAcquisition.observation(),
  refresh: operation => refreshAccessObservations(operation, warmCredentialCache, accessAcquisition),
  resolve: async (operation, ref) => {
    const workspace = operation.workspace;
    return resolveAccessObject(workspace, ref, {
      filePathForObjectId: objectId => resolveAccessFileObject(workspace, objectId,
        work => withEngineAdapter(receivedShareEngine.workspaceForRegistered(workspace), work), operation.signal),
      locatePath: async (path, versionId) => {
        if (versionId !== null && versionId !== "main") {
          return withEngineAdapter(receivedShareEngine.workspaceForRegistered(workspace), adapter =>
            locateAccessVersionPath(workspace.workspaceId, path, versionId, adapter));
        }
        try {
          const located = await assertResolvedWorkspacePath({ rootPath: workspace.rootPath, absolutePath: join(workspace.rootPath, path),
            spelled: path, label: "File path", access: "read" });
          const stat = await lstat(located.resolvedAbsolute).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
          return { path: located.relative.replaceAll("\\", "/"), exists: stat !== null };
        } catch { return null; }
      },
      hasChat: async channelWireId => workspace.sharedChannels?.some(channel => channel.channelWireId === channelWireId) === true ||
        await hasAccessChat(workspace.workspaceId, channelWireId, linkedChatStoreFor(workspace)),
    });
  },
  permissions: async (operation, datasetId, after) => {
    const { workspace, signal } = operation;
    const authority = await collectionsAuthorityFor(workspace, signal);
    const page = { action: "permissions" as const, workspaceId: workspace.workspaceId, datasetId, after, limit: 100 };
    if (authority.kind === "server") return authority.server.data(signal, () => operation.assertCurrent()).permissions!(page);
    const { local } = authority;
    const data = createDatasetAuthorityRouter(local, {
      status: id => finishedTransferOf(workspace, local, id, signal),
      remote: async targetOrigin => {
        const remote = await remoteForWorkspace(workspace);
        operation.assertCurrent();
        if (!remote.credentials.relayUrl || new URL(remote.credentials.relayUrl).origin !== targetOrigin) throw new Error("Collection host unavailable.");
        return createRemoteDatasetData({ workspaceId: workspace.workspaceId, ...remote, signal,
          currentCredentialGeneration: () => credentialCacheGeneration, assertCurrent: () => operation.assertCurrent(), relayJson: relayShareJsonWithCredentials });
      },
    });
    return data.permissions!(page);
  },
});

// One formula evaluator for every open workspace. Its worker thread starts
// on the first run and stops when idle. The worker runs from the staged
// runtime, like the dataset child, because the main bundle cannot resolve
// the package's own worker file.
const automationEvaluator = createAutomationFormulaEvaluator(() =>
  createAutomationEvaluator({
    entryPath: join(resourcesBasePath(), "app-backend-runtime", "automation-worker.mjs"),
  }),
);

// The Collection automation executor of an open workspace, or undefined.
function collectionAutomationsOf(workspaceId: string): CollectionAutomations | undefined {
  return withWorkspaceAttachment({ workspaceId }, (lease) => lease.state.collectionAutomations);
}

// A Collection automation that wrote a moment, as History shows it.
function automationAuthor(workspaceId: string, automationId: string): ReturnType<typeof collectionAutomationAuthor> {
  return collectionAutomationAuthor(collectionAutomationsOf(workspaceId), automationId);
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
  collectionAutomations: CollectionAutomations;
  /** This attachment's local dataset host, opened on first use and closed after the executor at disposal. */
  datasetHost: DatasetHostSlot;
  // Takes Button presses from shared views while this computer runs the
  // workspace's schedules.
  relayedPresses: RelayedPressHost;
  sitePreviews: ReturnType<typeof createSitePreviewLifecycle<SitePreviewResultBody>>;
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
  // Background work (a dispatch run, a schedule run) using the activity now.
  backgroundHolds: number;
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
  const datasetHost: DatasetHostSlot = { pending: null };
  const collectionAutomations = createCollectionAutomationsFor(binding, datasetHost);
  automationScheduler.add(binding.workspaceId, collectionAutomations, workspaceHosts.open(binding.workspaceId));
  return {
    activity: new WorkspaceActivityState(),
    collectionAutomations,
    datasetHost,
    relayedPresses: createRelayedPressHostFor(binding.workspaceId),
    sitePreviews: createSitePreviewLifecycle<SitePreviewResultBody>({
      allowOrigin: allowLoopbackFrameOrigin,
      notifyReplaced: (senderId, replacement) => {
        const parsed = SitePreviewReplacedEvent.safeParse(replacement);
        const target = webContents.fromId(senderId);
        if (!parsed.success || !target || target.isDestroyed()) return;
        target.send(CHANNELS.sitePreviewReplaced, parsed.data);
      },
    }),
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
    backgroundHolds: 0,
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

let appViews: ReturnType<typeof registerAppViews<DesktopRendererWorkspaceOperation["workspace"]>> | undefined;
const workspaceAuthorities = createWorkspaceAuthorityOwner({
  findWorkspace,
  canonicalizeRoot: (rootPath) => realpathSync.native(rootPath),
  createState: createDesktopWorkspaceAuthorityState,
  disposeState: async (state, binding, workspaceAtDisposal) => {
    await appViews?.closeWorkspace(binding.workspaceId);
    forgetWorkspacePresentation(binding.workspaceId);
    await folderAppDetection.retire(binding.attachmentId);
    const physicalWorkspace = {
      ...workspaceAtDisposal,
      rootPath: binding.canonicalRootPath,
      attachmentId: binding.attachmentId,
    };
    const relayCloseTargets =
      relayCloseTargetsForPhysicalWorkspace(physicalWorkspace);
    shareRosters.close(binding.workspaceId);
    invalidateHistoryLabels(binding.workspaceId);
    rosterContexts.delete(binding.workspaceId);
    automationScheduler.remove(binding.workspaceId);
    automationHosts.close(binding.workspaceId);
    workspaceHosts.close(binding.workspaceId);
    pressWindows.forget(binding.workspaceId);
    state.relayedPresses.stop();
    const results = await Promise.allSettled([
      // The executor hands its held dataset claims back before the host closes.
      state.collectionAutomations.dispose().finally(() => closeLocalDatasetHost(state.datasetHost)),
      state.linkedChatStore?.close() ?? Promise.resolve(),
      state.agentDispatchStoreHandle?.close() ?? Promise.resolve(),
      Promise.resolve().then(() =>
        agentIntegration.disposeState(state.agentIntegration),
      ),
      state.sitePreviews.stopWorkspace(binding.workspaceId),
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


type SitePreviewLifecycle = Omit<
  ReturnType<typeof createSitePreviewLifecycle<SitePreviewResultBody>>,
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
  acquire: (input) =>
    workspaceAuthorities.withAuthority(input.workspaceId, (lease) =>
      lease.state.sitePreviews.acquire(input),
    ),
  release(input) {
    return workspaceAuthorities.withAuthority(input.workspaceId, (lease) =>
      lease.state.sitePreviews.release(input),
    );
  },
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

const removePhysicalWorkspace = createPhysicalWorkspaceRemoval({
  retireBinding: (binding, retirement) => workspaceAuthorities.retireBinding(binding, retirement),
  findWorkspace,
  removeWorkspace,
  confirmDraftRemoval: async workspaceId => {
    await flushTypingCheckpoints(workspaceId);
    if (!(await hasWorkspaceLiveDrafts(join(stateDir(), "live-draft-recovery"), workspaceId))) return true;
    const answer = await showMessageBox({type: "warning", title: "Forget this workspace?",
      message: "This workspace has typing waiting to recover.", detail: "Forget deletes its kept copies from dohc. The folder is not deleted. This cannot be undone.",
      buttons: ["Go back", "Forget"], defaultId: 0, cancelId: 0});
    return answer.response === 1;
  },
  removeDrafts: workspaceId => removeWorkspaceLiveDrafts(join(stateDir(), "live-draft-recovery"), workspaceId),
  onError: (workspaceId, error) => console.warn(`[desktop] Could not remove recovery records for workspace "${workspaceId}":`, error),
});

// Forget: close every handle the app holds on the workspace and drop its
// registry row. The folder is untouched; opening it again re-adopts the
// manifest and its identity.
const forgetWorkspace = createWorkspaceForget({
  // A forgotten workspace opened again is an existing folder: it starts in
  // Restricted Mode.
  // The grant goes first, so a failed write cannot leave one that returns
  // when the folder opens again.
  remove: async workspaceId => {
    await workspaceTrust.restrict(workspaceId);
    await removePhysicalWorkspace(workspaceAuthorities.currentBinding(workspaceId));
  },
  clearNotices: workspaceId => chatDispatchNotices.clearWorkspace(workspaceId),
  notifyRenderer,
});

const createJoinedWorkspace = createJoinedWorkspaceRunner({
  canonicalizeRoot: canonicalWorkspaceRoot,
  reserve: (input) => workspaceAuthorities.reserveBinding(input),
  createFolder: (input) => createWorkspaceFolder({ ...input, homeDir: effectiveHome(), computer: thisComputer() }),
  register: registerReservedPhysicalWorkspace,
  remove: async (binding,cleanup)=>{await removePhysicalWorkspace(binding,cleanup);},
  release: (reservation, cleanup) =>
    workspaceAuthorities.releaseReservation(reservation, cleanup),
  closeRelay: (workspaceId) => closeRelayTransportWorkspace(workspaceId),
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
  runWorkspaceSharedChannelPass,
  syncWorkspaceSharedChannels,
  syncSharedChannelsForChatTarget,
  syncRendererSharedChannelsForChatTarget,
  syncRendererWorkspaceSharedChannels,
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
  updateWorkspaceSharedChannels,
  notifyRenderer,
  projectPendingChatBookmarksAfterPull: projectPendingChatBookmarks,
  linkedChatStoreFor,
  recheckRemovedShares,
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
// so a present marker with no readable grant or identity falls to `view`,
// which registers no write tools at all.
function mcpShareAccessOf(shareView: unknown): ShareAccess | null {
  const scope = shareViewWriteScopeOf(shareView);
  return scope === null ? null : scope.access ?? "view";
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MCP_LAUNCHER_UNAVAILABLE_MESSAGE =
  "dohc could not prepare its MCP launcher. Restart dohc to try again.";
const MCP_TEMPORARY_COPY_MESSAGE =
  "dohc is running from a disk image or a temporary copy. Move dohc to Applications, then open it again.";

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
      message: process.platform === "darwin" && isTemporaryMacAppPath(process.resourcesPath)
        ? MCP_TEMPORARY_COPY_MESSAGE
        : MCP_LAUNCHER_UNAVAILABLE_MESSAGE,
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

// Test-only network-share seam: every workspace reads as on a network
// share, so its notice can be seen on any computer.
function testNetworkShare(): boolean {
  return process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && process.env.DOHC_TEST_NETWORK_SHARE === "1";
}

// Test-only settle seams for the crash spec. The debounce holds an edit
// unsettled until the spec kills the app, instead of racing the kill. The
// gate holds a reopened document's recovery settle while its file exists,
// so the spec can watch the document before and after the write. Ignored
// outside DOHC_DESKTOP_TEST like every other DOHC_TEST_* seam.
function testCaptureSeams(): {
  capture: {settleDebounceMs?: number; openSettleGate?: () => Promise<void>};
  beforeTypingImport?: () => Promise<void>;
  typingSessionRegistered?: () => Promise<void>;
} {
  if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return {capture: {}};
  const debounce = Number(process.env.DOHC_TEST_YDOC_SETTLE_DEBOUNCE_MS);
  const gate = process.env.DOHC_TEST_YDOC_OPEN_SETTLE_GATE;
  const importGate = process.env.DOHC_TEST_TYPING_IMPORT_GATE;
  return {
    capture: {
      ...(Number.isFinite(debounce) && debounce > 0 ? { settleDebounceMs: debounce } : {}),
      ...(gate
        ? {
            openSettleGate: async () => {
              while (existsSync(gate)) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            },
          }
        : {}),
    },
    ...(importGate ? {
      beforeTypingImport: async () => {
        if (!existsSync(importGate)) return;
        await writeFile(importGate + ".waiting", "waiting");
        await new Promise<void>((resolve, reject) => {
          const watcher = watch(dirname(importGate), () => {if (!existsSync(importGate)) {watcher.close(); resolve();}});
          watcher.on("error", error => {watcher.close(); reject(error);});
          if (!existsSync(importGate)) {watcher.close(); resolve();}
        });
      },
      typingSessionRegistered: async () => {if (existsSync(importGate)) await writeFile(importGate + ".opened", "registered");},
    } : {}),
  };
}

function relayClientForWorkspace(input: {
  workspaceId: string;
  rootPath: string;
  accountId: string;
  attachmentId?: symbol;
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}): EngineRelayWorkspaceClient {
  if (!desktopEngine.relayClient) {
    throw new Error("Rust engine relay client is unavailable.");
  }
  return desktopEngine.relayClient.bind(input);
}

const scheduleShareLabelRefresh = createOwnerShareLabelRefresh(
  error => console.error("[desktop] share label refresh failed", error),
);

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
    throw new Error("Open this workspace again to start cloud sync.");
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
    accountId: credentials.userId,
    attachmentId: workspace.attachmentId,
    relay,
  });
  const refreshShareLabels = () => scheduleShareLabelRefresh(workspace.workspaceId,
    () => {
      let groups: Promise<Map<string, string>> | undefined;
      return refreshOwnerShareLabels({workspaceId: workspace.workspaceId,
        list: async () => {
          const listing = await relayShareJsonWithCredentials<{granted: Array<{shareId: string; workspaceId: string; selector: unknown; subjectName?: string | null; revokedAtMs?: number | null; status?: string}>}>(credentials, "/sync/shares");
          let cursor: string | undefined;
          do {
            const page = await relayShareJsonWithCredentials<{links: Array<{shareId: string; selector: unknown; subjectName?: string | null; revokedAtMs?: number | null; status?: string}>; nextCursor?: string}>(credentials,
              `/sync/${encodeURIComponent(workspace.workspaceId)}/shares/links${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
            listing.granted.push(...page.links.map(row => ({...row, workspaceId: workspace.workspaceId})));
            cursor = page.nextCursor;
          } while (cursor);
          return listing;
        },
        labels: selector => labelsForOwnerShare(workspace, credentials, selector, {refresh: true, groupNames: () => groups ??= ownerGroupNames(workspace)}),
        update: (shareId, labels) => relayShareJsonWithCredentials(credentials, `/sync/shares/${encodeURIComponent(shareId)}`, {method: "PUT", body: JSON.stringify(labels)}),
      });
    },
  );
  return createRelaySyncEngine({
    rootDir: workspace.rootPath,
    relay,
    operations: {
      claim: () => daemonRelay.claim(),
      push: () => daemonRelay.push(),
      // Each page's files, once written, go to the Collection automation
      // executor: a pull need not leave a watcher batch.
      pull: async (materializePage) => {
        try { return await daemonRelay.pull(async (changed) => {
          await materializePage(changed);
          await withWorkspaceAttachmentAsync(workspace, lease => workspaceActivity.handlePulledPaths(
            lease.state.activity, changed.map(change => change.path))).catch(error =>
              console.error(`[desktop] reload pulled file consumers for ${workspace.workspaceId}:`, error));
        }); } finally {
          withWorkspaceAttachment(workspace, lease => workspaceActivity.pullFinished(lease.state.activity));
        }
      },
      recoverOrigin: () => daemonRelay.recoverOrigin(),
    },
    // Workspace activity keeps the Collections wait, so it outlasts this
    // engine when the person signs out.
    afterPass: ({ failed }) =>
      withWorkspaceAttachment(workspace, lease => workspaceActivity.syncPassEnded(canonicalWorkspaceFor(lease),
        lease.state.activity, failed, () => daemonRelay.collectionsWaiting())) ?? Promise.resolve(false),
    capture,
    onChange: createRelayOnChange(workspace),
    // MU-C4: joined shared channels refresh on the same cadence as the
    // workspace's own sync (best-effort; never fails the pass).
    syncSharedChannels: async () => {
      const outcome = await withWorkspaceAttachmentAsync(workspace, () =>
        runWorkspaceSharedChannelPass(workspace.workspaceId),
      );
      if (outcome.changed) void collectionAutomationsOf(workspace.workspaceId)?.groupMessagesArrived();
      return outcome.changed;
    },
    // A replicated chat message can mark a live bookmark pending without
    // touching the file watcher. Project immediately after the pull commits;
    // the periodic worker remains only a crash/retry backstop.
    afterSuccessfulPull: ({ recovered }) => {
      void noticeStore().sync();
      void shareRosters.pulled(workspace.workspaceId, recovered);
      refreshShareLabels();
      automationHosts.relayAnswered(workspace.workspaceId);
      collectionAutomationsOf(workspace.workspaceId)?.relayAnswered();
      void collectionAutomationsOf(workspace.workspaceId)?.groupMessagesArrived();
      // The relay answers again, so this computer may be the host again.
      if (recovered) withWorkspaceAttachment({ workspaceId: workspace.workspaceId }, (lease) => lease.state.relayedPresses)?.start();
      return withWorkspaceAttachmentAsync(workspace, () =>
        projectPendingChatBookmarks(workspace.workspaceId),
      );
    },
    // Recorded durably before each pull request goes out.
    pullStarting: () => {
      withWorkspaceAttachment(workspace, lease => workspaceActivity.pullStarting(lease.state.activity));
      return shareRosters.pullStarting(workspace.workspaceId);
    },
    countOpenConflicts: async () => await capture.countOpenConflicts(),
    // Another device's edits reach this one, and a document open here, while
    // nobody touches this desktop: the relay answers a held read when the log
    // changes. The rare pull covers a change that answer missed.
    waitForChange: createRelayLogWait({ workspaceId: workspace.workspaceId, relay }),
    idlePullMs: 5 * 60_000,
    // A freshly joined workspace's engine is pull-first: no push before the
    // first successful pull (0P-C gate fix).
    ...(engineOptions.joinBootstrap ? { joinBootstrap: true } : {}),
    ...testSyncTimingOverrides(),
  });
}

const typingQuitRecovery=createTypingQuitRecovery({
 hasWindows:()=>desktopWindows.workspaceWindows.allLive().length > 0,
 unresolved:hasUnresolvedTypingCheckpoints,flush:flushTypingCheckpoints,quit:()=>app.quit(),beforeQuit:event=>quitGuard.beforeQuit(event),
 confirmLoss:async()=>{const drawing=[...typingRecoveryFailures.values()].some(rows=>[...rows.values()].some(f=>f.reason === "drawing-unavailable"));
 const answer=await showMessageBox({type:"warning",title:drawing ? "Quit without your drawing changes?" : "Quit without your typing?",message:drawing ? "dohc could not keep your drawing changes on this computer." : "dohc could not keep your typing on this computer.",detail:drawing ? "Your drawing changes since the last saved copy are lost when dohc quits." : "Any typing dohc has not kept is lost when it quits.",buttons:["Go back","Quit anyway"],defaultId:0,cancelId:0});return answer.response === 1;},
});
function beforeQuitWithTypingRecovery(event:{preventDefault():void}):void {typingQuitRecovery.beforeQuit(event);}

const typingRecoveryFailures = new Map<string, Map<string, TypingRecoveryFailure>>();
const importedTypingCheckpoints = new Map<string, Awaited<ReturnType<VersionedLiveAdapter["importRecovery"]>>>();
const dismissedTypingCheckpoints = new Set<string>();
const typingRecoveryImports = new Map<symbol, Promise<void>>();
function reportTypingRecoveryFailure(workspaceId: string, failure: TypingRecoveryFailure): void {
  let failures = typingRecoveryFailures.get(workspaceId);
  if (!failures) {failures = new Map(); typingRecoveryFailures.set(workspaceId, failures);}
  failures.set(failure.kind + ":" + (failure.checkpointId ?? failure.path), failure);
  notifyRenderer({workspaceId});
}
function recoverOutageTyping(workspace: CreatedWorkspace & {attachmentId: symbol}): Promise<void> {
  const current = () => workspaceAuthorities.isCurrentAttachment(workspace.workspaceId, workspace.attachmentId);
  const existing = typingRecoveryImports.get(workspace.attachmentId);
  if (existing) return existing;
  const pending = (async () => {
    await testCaptureSeams().beforeTypingImport?.();
    return importTypingCheckpoints(join(stateDir(), "live-draft-recovery"), workspace.workspaceId,
    async input => {
      if (!current()) throw new Error("Workspace changed before typing recovery.");
      const result = await requireEngineSessions().withRetryBudget(120_000, () => requireEngineSessions().run(workspace, async binding => new VersionedLiveAdapter(binding.client, binding.workspace, {workspaceId: workspace.workspaceId}).importRecovery(input), {retryTransportErrors: true}));
      if (!current()) throw new Error("Workspace changed during typing recovery.");
      return result;
    },
    failure => {if (current()) reportTypingRecoveryFailure(workspace.workspaceId, failure);},
    (path, checkpointId, result) => {importedTypingCheckpoints.set(`${workspace.workspaceId}:${checkpointId}`, result); if (current()) {typingRecoveryFailures.get(workspace.workspaceId)?.delete("import:" + checkpointId); notifyRenderer({workspaceId: workspace.workspaceId});}},
  );
  })().catch(error => {if (current()) reportTypingRecoveryFailure(workspace.workspaceId, {kind: "import", path: "", detail: String(error)});}).finally(() => typingRecoveryImports.delete(workspace.attachmentId));
  typingRecoveryImports.set(workspace.attachmentId, pending);
  return pending;
}

const workspaceActivity = createWorkspaceActivity(notifyRenderer, {
  onHeldFiles: (workspaceId, heldFiles) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (rendererWorkspaceSessions.current(win.webContents)?.workspaceId === workspaceId) {
        win.webContents.send(CHANNELS.captureHolds, { workspaceId, heldFiles });
      }
    }
  },
  onAgentRunState: (event) => sendToWorkspaceWindows(CHANNELS.agentRunState, event),
  cloudStateFor: (workspaceId) => {
    const workspace = findWorkspace(workspaceId);
    const remote = workspace?.remote;
    return {
      enabled: !!remote,
      syncPause: workspace ? syncPauseFor(workspace, localInstallationId()) : undefined,
      // Legacy and different-account bindings stay local-only.
      connected:
        !!remote && workspaceRemoteMatchesCredentials(remote, cachedCredentials),
    };
  },
  engineFor: engineForWorkspace,
  collectionsWaitingFor: async workspace => {
    const waiting = await withEngineAdapter(workspace, adapter => adapter.collectionsWaiting());
    if (waiting === null) throw new Error("The workspace engine is not running.");
    return waiting;
  },
  onNetworkShare: rootPath => (testNetworkShare() ? Promise.resolve(true) : onNetworkShare(rootPath)),
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
      {
        ...testCaptureSeams().capture,
        waitForTypingRecovery: async () => {
          await testCaptureSeams().typingSessionRegistered?.();
          await recoverOutageTyping(workspace);
        },
        writeTypingCheckpoint: async checkpoint => {
          try {
            await writeTypingCheckpoint(join(stateDir(), "live-draft-recovery"), checkpoint);
            typingRecoveryFailures.get(workspace.workspaceId)?.delete("checkpoint:" + checkpoint.path);
            notifyRenderer({workspaceId: workspace.workspaceId});
          } catch (error) {
            reportTypingRecoveryFailure(workspace.workspaceId, typingRecoveryFailure("checkpoint",checkpoint.path,error));
            throw error;
          }
        },
        writeTypingCheckpointSync: checkpoint=>writeTypingCheckpointSync(join(stateDir(),"live-draft-recovery"),checkpoint),
        onTypingCheckpointFailure: (path,error)=>reportTypingRecoveryFailure(workspace.workspaceId,typingRecoveryFailure("checkpoint",path,error)),
        onTypingCheckpointRecovered: path=>{typingRecoveryFailures.get(workspace.workspaceId)?.delete("checkpoint:"+path);notifyRenderer({workspaceId:workspace.workspaceId});},
        retireTypingCheckpoint: async checkpoint => {
          for (const row of await readTypingCheckpoints(join(stateDir(), "live-draft-recovery"), workspace.workspaceId)) {
            if (row.checkpoint.objectId === checkpoint.objectId && row.content === JSON.stringify(checkpoint)) await retireTypingCheckpoint(row);
          }
        },
        // Notices shows the drafts main keeps as they change.
        ...workspaceDraftStore(join(stateDir(), "live-draft-recovery"), workspace.workspaceId, {
          all: () => BrowserWindow.getAllWindows(),
          workspaceIdOf: (webContents) => rendererWorkspaceSessions.current(webContents)?.workspaceId,
        }),
        hasRetainedLiveDraft: (path, objectId) => hasRetainedLiveDraft(
          join(stateDir(), "live-draft-recovery"), workspace.workspaceId, path, objectId,
        ),
      },
    ),
  onWatcherBatch: (workspace, events) => {
    onWatcherBatch(workspace, events);
    withWorkspaceAttachment(workspace, () => folderAppDetection.settledEvents(workspace, events));
  },
  onObservationResync: async workspace => {
    await onObservationResync(workspace);
    folderAppDetection.invalidate(workspace);
  },
  observationFor: (workspace, callbacks) => {
    const daemon = desktopEngine.daemon;
    if (!daemon) throw new Error("Workspace file observation requires the engine daemon.");
    return startWorkspaceFileObservation({ ...workspace,
      ...(sharedViewOf(workspace.workspaceId) ? { captureMode: "none" as const } : {}),
    }, requireEngineSessions(), daemon, {
      ...callbacks,
      facts(facts) {
        workspaceFileListings.observe(workspace.workspaceId, workspace.attachmentId, facts);
        callbacks.facts(facts);
      },
    });
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
    options?: { preserveStatus?: boolean; preserveAgentRun?: boolean; notify?: boolean; expectedRootPath?: string },
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
  prepareSyncPause: (workspace: RegistryEntry) =>
    workspaceAuthorities.withAuthority(workspace.workspaceId, lease =>
      workspaceActivity.prepareSyncPause(canonicalWorkspaceFor(lease), lease.state.activity),
    ),
  recordSyncPauseReopenFailed: (workspaceId: string): void =>
    withWorkspaceActivityState(workspaceId, (lease, workspace) =>
      workspaceActivity.recordSyncPauseReopenFailed(workspace, lease.state.activity),
    ),
  readCollectionsWaiting: (workspace: RegistryEntry): Promise<boolean> =>
    workspaceAuthorities.withAuthority(workspace.workspaceId, lease =>
      workspaceActivity.readCollectionsWaiting(canonicalWorkspaceFor(lease), lease.state.activity),
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
      ownerLiveStopFailures: desktopEngine.ownerLiveStopFailures(workspaceId),
      ownerLiveQuarantines: desktopEngine.ownerLiveQuarantines(workspaceId),
      hasOwnerLiveRefusals: desktopEngine.hasOwnerLiveRefusals(workspaceId),
    })),
  recordShareViewStoreRefusal: (
    workspaceId: string,
    refusal: EngineStoreRefusal | null,
    detail: string | null,
  ): void =>
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.recordShareViewStoreRefusal(
        lease.state.activity,
        refusal,
        detail,
      ),
    ),
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
  // Starts the pass under the lease and waits for it outside, so a pass that
  // waits on an unreachable server holds no workspace authority. After a
  // pause there is no sync to retry: Try again repeats the reopen that ends
  // the Collections wait.
  retryCloudSync: (
    workspaceId: string,
    reason: "person" | "reconnect",
  ): Promise<void> => {
    const reopen = withWorkspaceActivityState(workspaceId, (lease, workspace) =>
      workspaceActivity.getStatus(workspace, lease.state.activity).collectionsWaitingForSync === "reopen");
    if (reopen) {
      if (reason !== "person") return Promise.resolve();
      const workspace = requireWorkspace(workspaceId);
      return withWorkspaceSyncTransition(workspaceId, () => desktopEngine.withOwnerHostPaused(async () => {
        const { failure } = await reopenWithoutSync(syncPauseReopen, workspace);
        if (failure) throw failure.error;
      }));
    }
    return withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.retryCloudSync(lease.state.activity, reason),
    );
  },
  retryFileObservation: (workspaceId: string): Promise<void> =>
    withWorkspaceActivityState(workspaceId, lease => workspaceActivity.retryFileObservation(lease.state.activity)),
  syncNow: (workspaceId: string): Promise<void> =>
    withWorkspaceActivityState(workspaceId, (lease) => workspaceActivity.syncNow(lease.state.activity)),
  pushRecorded: (workspaceId: string): Promise<void> =>
    withWorkspaceActivityState(workspaceId, (lease) => workspaceActivity.pushRecorded(lease.state.activity)),
  retryFailingCloudSyncs: (): void => {
    for (const workspaceId of workspaceAuthorities.workspaceIds()) {
      // Started inside the promise, so a workspace closing under the loop
      // fails its own retry and not the others.
      void Promise.resolve()
        .then(() => {
          const failing = withWorkspaceActivityState(workspaceId, (lease, workspace) =>
            workspaceActivity.getStatus(workspace, lease.state.activity).syncFailure,
          );
          return failing ? activity.retryCloudSync(workspaceId, "reconnect") : undefined;
        })
        .catch((error: unknown) => {
          console.error(`[desktop] sync retry after wake failed for ${workspaceId}:`, error);
        });
    }
  },
  queueCloudPull: (workspaceId: string): void => {
    if (!findWorkspace(workspaceId)) return;
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.queueCloudPull(lease.state.activity),
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
  agentRunDepth: (workspaceId: string) =>
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.agentRunDepth(lease.state.activity),
    ),
  dispatchedAgent: (workspaceId: string) =>
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.dispatchedAgent(lease.state.activity),
    ),
  dispatchedRunId: (workspaceId: string) =>
    withWorkspaceActivityState(workspaceId, (lease) =>
      workspaceActivity.dispatchedRunId(lease.state.activity),
    ),
  agentRunWorkspace: (runId: string) => workspaceAuthorities.workspaceIds().find((workspaceId) =>
    withWorkspaceActivityState(workspaceId, (lease) => workspaceActivity.agentRun(lease.state.activity)?.agentRunId === runId),
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
// Local agent integration: owns the per-workspace active-run slot and
// persists agent-run records. The run slot is wired into the watcher
// (workspaceActivity.setAgentRun) so a run's writes are attributed to the
// agent. The user's AI tool launches its own MCP server from the Settings
// config snippet.
const agentIntegration = createAgentIntegration({
  workspaceIds: () => workspaceAuthorities.workspaceIds(),
  localPersonId: localUserId,
  installId: localInstallationId,
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
  onRunEnded: ({ attachmentId, workspaceId }) => {
    void chatDispatchService.scanWorkspace(workspaceId, attachmentId).catch((error) => {
      console.error("[desktop] post-panel-run dispatch scan:", error);
    });
  },
});
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
      throw new Error("This workspace was closed. Open it again.");
    }
  const existing = lease.state.linkedChatStore;
  if (existing) return existing;
  if (!desktopEngine.sessions) {
    throw new Error("Rust engine workspace sessions are unavailable.");
  }
  const current = findWorkspace(lease.binding.workspaceId);
    if (!current) {
      throw new Error("This workspace is not open. Open it again.");
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
      throw new Error("This workspace was closed. Open it again.");
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

// One daemon round-trip per read, through the workspace-attachment authority
// sandwich. Returns null when the daemon has no workspace sessions (engine
// unavailable), so callers can answer with an empty result — collections.list
// says "no collections" — while surfaces that must not guess raise a visible
// error.
async function withEngineAdapter<T>(
  workspace: EngineWorkspace,
  work: (adapter: VersionedLiveAdapter, assertCurrent?: () => void) => Promise<T>,
): Promise<T | null> {
  const sessions = desktopEngine.sessions;
  if (!sessions) return null;
  const read = async (engineWorkspace: EngineWorkspace) =>
    await sessions.run(engineWorkspace, async (binding) =>
      await work(
        new VersionedLiveAdapter(binding.client, binding.workspace, {
          workspaceId: workspace.workspaceId,
        }),
        () => sessions.assertCurrentBinding(engineWorkspace, binding),
      ),
    );
  const registered = findWorkspace(workspace.workspaceId);
  if (!registered) return await read(workspace);
  if (
    workspace.attachmentId === undefined &&
    !workspaceRootsMatch(registered.rootPath, workspace.rootPath)
  ) {
    throw new Error(
      "This workspace changed while this ran. Try again.",
    );
  }
  return await withWorkspaceAttachmentAsync(workspace, async (lease) =>
    await read(engineWorkspaceForAuthority(lease)),
  );
}

const workspaceLinks = createWorkspaceLinksReader(withEngineAdapter, () => shareViewFiles);
const resolveEngineFiles = createEngineFileResolver(withEngineAdapter, createReceivedFileReferenceScopes<EngineWorkspace>({
  findWorkspace,
  currentAttachment: workspaceId => workspaceAuthorities.currentBinding(workspaceId).attachmentId,
  isCurrentAttachment: (workspaceId, attachment) => workspaceAuthorities.isCurrentAttachment(workspaceId, attachment),
  warmCredentials: warmCredentialCache,
  credentials: () => cachedCredentials,
  credentialGeneration: () => credentialCacheGeneration,
  mountWorkspace: (workspace, mount) => receivedShareEngine.workspaceFor({
    engineWorkspaceId: mountStoreWorkspaceIdFor(workspace.workspaceId, mount.shareId),
    rootPath: mountRootFor(workspace.rootPath, mount.label),
  }),
}));

// The human author every renderer-sent chat message is attributed to. Main
// derives it — the renderer never supplies identity. At alpha the desktop's
// preferred local profile name. Email remains an auth/contact identifier and
// is never reused as a public chat display name.
let cachedAgents: readonly Agent[] = [];
let cachedPreferredName: string | undefined;
function localUserDisplayName(): string {
  return cachedPreferredName ?? "You";
}

// The opaque per-install reactor id used when signed out (no cloud user id). A
// stable uuid persisted in stateDir — never the email — so a signed-out
// reaction cell is stable across restarts without leaking PII into the CRDT.
// Memoized after the first read, so the sync fs touch happens at most once
// and an id that could not be saved stays the same for this process.
let cachedLocalInstallationId: string | null = null;
function localInstallationId(): string {
  return cachedLocalInstallationId ??= readOrCreateLocalInstallationId(join(stateDir(), "dohc-local-id.json"),
    (message, error) => console.error(`[desktop] ${message}`, error));
}

// This installation, with its computer's name as settings show it.
function thisComputer(): Computer {
  return { installId: localInstallationId(), label: computerLabel(hostname()) };
}

// The local user's stable, OPAQUE reactor identity (WS-MU-C2). This value
// becomes a replicated CRDT author key, so it must never be the raw email — a
// raw email would replicate to every peer (PII/GDPR exposure) and persist in
// the immutable CRDT history. Prefer the Better Auth user id (an opaque uuid)
// when signed in; that is forward-compatible with MU-C0, which verifies
// authorId === actor.userId server-side. Signed out falls back to a persisted
// per-install uuid. The email→display-name mapping stays LOCAL in
// localUserDisplayName(). It is the account the credential cache last settled
// on, so the null a credential reload publishes while it reads the store never
// credits this person's work to the installation.
function localUserId(): string {
  return localAuthorship.personId();
}

// The person a request is made by, read when it arrives, before it waits for
// its workspace.
function localPerson(): Promise<LocalPersonAuthor> {
  return localAuthorship.person();
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
    throw new Error("This workspace is not open. Open it again.");
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
            const activityRootPath = activity.workspaceRootPath(workspaceId);
            if (
              activityRootPath === null ||
              !workspaceRootsMatch(activityRootPath, workspace.rootPath)
            ) {
              throw new Error(
                "This workspace was closed. Open it again.",
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
            { onCaptureOutcome: () => undefined, onAtomicPlacementUnavailable: () => undefined, onRecoveryUnavailable: () => undefined, onKeptFiles: () => undefined, onRetainedCopies: () => undefined, onHeldFiles: () => undefined },
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
  // The capture credits edits to the settled account, so learn it before
  // the capture can take one.
  await localAuthorship.settled();
  lease.assertCurrent();
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
  void recoverOutageTyping(workspace);
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
  options: { notifyRenderer?: boolean; unlessInUse?: boolean } = {},
): Promise<void> {
  return withWorkspaceAttachmentAsync(
    workspace,
    async (lease) => {
      const current = canonicalWorkspaceFor(lease);
      const relayCloseTarget = current.remote
        ? workspaceSessionTargetForPhysicalWorkspace(
            current.workspaceId,
            current,
          )
        : null;
      const automations = lease.state.collectionAutomations;
      const joined = lease.state.activityClosing !== null;
      const closing = closeActivity(lease.state, () => closeWorkspaceActivityAndRelay({
        closeActivity: async () => {
          await automations.close();
          automationHosts.close(current.workspaceId);
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
      }), options);
      if (closing === null) return;
      await closing;
      forgetWorkspacePresentation(current.workspaceId);
      if (!joined) lease.assertCurrent();
    },
  );
}

// The release closes a TRANSIENT open (background dispatch, runner self-test)
// once nothing owns the workspace: no window or CLI retains it and no other
// background run holds it. Decided from who owns it at release, not from
// whether it was open before: ownership can change while the run is in
// flight.
async function acquireDispatchRunActivity(
  workspace: CreatedWorkspace & { attachmentId?: symbol },
): Promise<() => Promise<void>> {
  return withWorkspaceAttachmentAsync(workspace, async (lease) => {
    const current = canonicalWorkspaceFor(lease);
    holdBackground(lease.state);
    try {
      await ensureWorkspaceActivityOpen(current);
    } catch (error) {
      releaseBackground(lease.state);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      withWorkspaceAttachment(current, (held) => releaseBackground(held.state));
      await closeDispatchRunActivity(current, { unlessInUse: true });
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

// Sends a workspace's event only to windows showing that workspace.
function sendToWorkspaceWindows<Event extends { workspaceId: string }>(channel: string, event: Event): void {
  sendToWorkspaceWindowsOf({
    windows: BrowserWindow.getAllWindows(),
    workspaceIdOf: (webContents) => rendererWorkspaceSessions.current(webContents)?.workspaceId,
    channel,
    event,
  });
}

const chatDispatchNotices = createChatDispatchNotices((event) => {
  sendToWorkspaceWindows(CHANNELS.chatDispatchNotices, event);
});

const chatDispatchService = createChatDispatchService({
  // An agent runs in the workspace folder, where its CLI may follow the
  // folder's own settings, so it starts only where app commands may run.
  assertMayStartAgent: (workspace) => workspaceTrust.assertTrusted(workspace),
  onDispatchNotice: (workspace, notice) => {
    withWorkspaceAttachment(workspace, () => chatDispatchNotices.report(workspace.workspaceId, notice));
  },
  onThreadResumed: (workspace, threadId) => {
    withWorkspaceAttachment(workspace, () => chatDispatchNotices.clear(workspace.workspaceId, "budget-paused", threadId));
  },
  runNotices: {
    post: (input) => noticeStore().postNotice(input),
    owed: createOwedRunNotices(() => join(stateDir(), "owed-run-notices.json")),
  },
  workspaceFor: workspaceForDispatch,
  listOpenWorkspaces: openDispatchWorkspaces,
  listSyncWorkspaces: syncDispatchWorkspaces,
  chatStoreFor: linkedChatStoreFor,
  startSelfTestThread: (workspace, input) => withWorkspaceAttachmentAsync(workspace, async (lease) => {
    const started = await chatWrites.startThread({ workspaceId: workspace.workspaceId, store: linkedChatStoreFor(lease) }, {
      ...input,
      ownThread: true,
      // CLI origin keeps this person's test message from starting an agent run.
      writer: { via: "cli", actor: "human" },
      resolveAttachments: async () => [],
    });
    return started.thread.id;
  }),
  dispatchStoreFor: (workspace) =>
    agentDispatchStoreHandleFor(workspace).store,
  readDispatchAgents: async () =>
    listAgents((await readCachedUserSettingsFile(stateDir())).settings),
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
  // The tray and every window show the pause, wherever it changed.
  onPausedChanged: (paused) => {
    void refreshDispatchTray().catch((error) => console.error("[desktop] dispatch tray:", error));
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.chatDispatchPaused, { paused });
    }
  },
  onRunUpdated: (workspace) =>
    withWorkspaceAttachment(workspace, () =>
      notifyRenderer({ workspaceId: workspace.workspaceId }),
    ),
  onAgentRequestsChanged: (workspace, channelId) =>
    withWorkspaceAttachment(workspace, () =>
      sendToWorkspaceWindows(CHANNELS.chatAgentRequestsChanged, { workspaceId: workspace.workspaceId, channelId }),
    ),
  setRunAttribution: (workspace, run) =>
    withWorkspaceAttachmentAsync(workspace, async (lease) => {
      const workspaceId = workspace.workspaceId;
      if (run) {
      if (!(await activity.claimAgentRun(workspaceId, { ...run, onBehalfOf: localUserId() },
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
  listAppQuitRecoveries: (workspace, threadId) => {
    const current = workspaceForDispatch(workspace.workspaceId);
    return current && current.attachmentId === workspace.attachmentId
      ? agentDispatchStoreHandleFor(workspace).listAppQuitRecoveries(
          workspace.workspaceId,
          threadId,
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
  shareRosters.open(canonicalWorkspace.workspaceId);
  // Automations run where changes are captured: never in a shared view.
  if (activity.engineCaptureFor(canonicalWorkspace.workspaceId)) {
    automationHosts.open(canonicalWorkspace.workspaceId);
    void operation.state.collectionAutomations.open();
    operation.state.relayedPresses.start();
    reconcileLocalCollectionApps(canonicalWorkspace);
    resumeLinkRewrites(canonicalWorkspace, operation.signal);
  }
  return result;
}

// Responses a local Collection app admitted before a quit, crash, or engine
// restart settle once the engine is back. Only an existing store opens.
function reconcileLocalCollectionApps(workspace: { workspaceId: string; rootPath: string }): void {
  void reconcileExistingLocalCollectionApps(workspace.rootPath, () => localDatasetHostFor(workspace, new AbortController().signal))
    .catch(error => { if (!(error instanceof CollectionsRefusalError)) console.warn("[desktop] local Collection app reconciliation:", error); });
}

function resumeLinkRewrites(workspace: EngineWorkspace & {readOnly?: boolean; shareView?: unknown}, signal: AbortSignal): void {
  if (workspace.readOnly || workspace.shareView !== undefined) return;
  void resumeWorkspaceLinkRewrites(workspace, {workspaceId: workspace.workspaceId, signal,
    history: {rewriteHistoryLinks: input => withEngineAdapter(workspace, adapter => adapter.rewriteHistoryLinks(input)).then(result => {
      if (!result) throw new Error("The workspace engine is not running.");
      return result;
    })},
  }).catch(error => console.warn("[desktop] link rewrite recovery:", error));
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

async function requireEngineCaptureForOperation(
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
    throw new Error(captureRefusal("Collections"));
  }
  return { workspace, capture };
}

// Workspace authority for one collection write: a writable workspace with a
// running engine capture, plus the local engine adapter and capture
// announcements the adoption wait reads through. Collection writes land on
// the physical workspace's own engine (a received share view is refused as
// read-only before this). Without a caller's signal, the write lives as long
// as the workspace operation. `person` is read when the write was requested.
async function collectionEditContextFor(
  operation: DesktopWorkspaceOperation,
  person: LocalPersonAuthor,
  editSignal?: AbortSignal,
): Promise<CollectionRecordEditContext> {
  const { capture } = await requireEngineCaptureForOperation(operation);
  return collectionEditContextWith(operation, capture, editSignal ?? operation.signal, person);
}

function collectionEditContextWith(
  operation: DesktopWorkspaceOperation,
  capture: DesktopRecordEditHost["capture"],
  signal: AbortSignal,
  person: LocalPersonAuthor,
): CollectionRecordEditContext {
  const workspace = operation.workspace;
  assertWritableWorkspace(workspace);
  return desktopRecordEditContext({
    capture,
    workspaceRoot: workspace.rootPath,
    person,
    withAdapter: (work) => withEngineAdapter(workspace, work),
    onCaptureSettled: (listener) => {
      const daemon = desktopEngine.daemon;
      if (!daemon) throw new Error("The workspace engine is not running.");
      return onWorkspaceCaptureSettled(daemon, workspace.workspaceId, listener);
    },
    signal,
  });
}

// A workspace text file, or null when there is none.
async function readWorkspaceTextIfPresent(rootPath: string, relativePath: string) {
  try {
    return await readWorkspaceText(rootPath, relativePath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")) return null;
    throw error;
  }
}

// The one timer for every open workspace's schedules.
const automationScheduler = new AutomationScheduler({
  clock: {
    now: Date.now,
    monotonic: () => performance.now(),
    setTimer: (wake, delayMs) => setTimeout(wake, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
  onError: (context, error) => console.warn(`[desktop] Schedules: ${context}:`, error),
  onRecord: (workspaceId, record) => {
    void scheduleRecords.save(workspaceId, record).catch((error: unknown) =>
      console.warn(`[desktop] Schedules: keep the record of workspace "${workspaceId}":`, error));
    void appLifecycle.backgroundReasonsChanged().catch((error: unknown) => console.error("[desktop] dispatch tray:", error));
  },
  openInBackground: (workspaceId) => runSchedulesInBackground(workspaceId),
  // Posted to the owner, and kept here until it reaches the relay.
  onSkipped: (workspaceId, schedule, skipped) =>
    noticeStore().postNotice(skippedRunsNotice({ workspaceId, schedule, skipped })),
  onSkipWithdrawn: (workspaceId, schedule, skipped) =>
    noticeStore().withdraw(skippedRunsNotice({ workspaceId, schedule, skipped }).noticeId),
});

// What each workspace's schedules need when no window has it open.
const scheduleRecords = createScheduleRecords(join(stateDir(), "schedules"));
const runNowIntents = createRunNowIntents(join(stateDir(), "run-now.json"));

// The agent an automation wakes, on or off: dispatch says when it is off.
async function readyAgent(): Promise<WokenAgent | null> {
  return wokenAgent((await readCachedUserSettingsFile(stateDir())).settings);
}

// A wake that needs a runner waits while the automation agent is off.
async function agentRunnerReady(): Promise<boolean> {
  return automationAgent((await readCachedUserSettingsFile(stateDir())).settings)?.enabled === true;
}

async function wakeAutomationAgent(
  workspace: { workspaceId: string; rootPath: string; attachmentId?: symbol },
  signal: AbortSignal,
  message: AutomationChatMessage,
  waitForDispatch = false,
): Promise<void> {
  const { workspaceId } = workspace;
  await withWorkspaceAttachmentAsync(workspace, async (lease) => {
    signal.throwIfAborted();
    const place = { workspaceId, store: linkedChatStoreFor(lease) };
    const local = {
      writer: { via: "automation" as const, ...message.automation, local: true as const },
      signal, body: message.body, messageId: message.messageId, idempotencyKey: message.effectId,
      resolveAttachments: async () => [],
    };
    await wakeAgent({
      posted: async (messageId) => {
        signal.throwIfAborted();
        const posted = await findChatMessage(place.store, workspaceId, messageId);
        if (posted === null) return null;
        const channelId = await place.store.findThreadChannelId({ workspaceId, threadId: posted.threadId });
        const agentId = channelId === null ? undefined
          : (await place.store.listChannels({ workspaceId })).find((channel) => channel.id === channelId)?.agentId;
        if (agentId === undefined) throw new Error("dohc could not find the agent chat this automation's message is in.");
        return { threadId: posted.threadId, agentId };
      },
      readyAgent,
      agentChannelId: async (agent) => {
        signal.throwIfAborted();
        return (await place.store.ensureAgentChannel({ workspaceId, agentId: agent.id, name: agent.name })).id;
      },
      threadExists: async (threadId) => (await place.store.findThreadChannelId({ workspaceId, threadId })) !== null,
      start: ({ channelId, message: wake, ownThread }) => chatWrites.startThread(place, { ...local, channelId, threadId: wake.threadId, ownThread }),
      send: ({ message: wake }) => chatWrites.sendMessage(place, { ...local, threadId: wake.threadId }),
      recordTrigger: (trigger) => {
        signal.throwIfAborted();
        return chatDispatchService.recordTrigger(workspace, trigger);
      },
      scan: () => {
        signal.throwIfAborted();
        const scan = chatDispatchService.scanWorkspace(workspaceId, lease.binding.attachmentId);
        if (waitForDispatch) return scan;
        void scan.catch((error: unknown) => console.error("[desktop] chat dispatch scan:", error));
      },
    }, message);
  });
}

const automationWakeConsumer = createAutomationWakeConsumer({
  intents: createAutomationWakeIntents(join(stateDir(), "automation-wakes.json")),
  pending: () => noticeStore().pendingAutomationWakes(),
  ready: async (intent, needsRunner) => {
    const session = await noticeSession();
    return session !== null && session.account.key === intent.account &&
      session.reachFor(intent.workspaceId)?.workspaceId === intent.workspaceId &&
      (!needsRunner || await agentRunnerReady()) && session.isCurrent();
  },
  enabledIfOpen: async (intent) => {
    const workspace = findWorkspace(intent.workspaceId);
    if (!workspace || workspace.shareView !== undefined) return undefined;
    return await withWorkspaceAttachment(workspace, (held) => {
      if (!workspaceActivity.isOpen(held.state.activity) || held.state.activityClosing) return undefined;
      return held.state.collectionAutomations.enabledForWake(intent.wake.automationId);
    });
  },
  enabled: async (intent) => {
    const workspace = findWorkspace(intent.workspaceId);
    if (!workspace || workspace.shareView !== undefined) return false;
    await desktopEngine.startup;
    const release = await acquireDispatchRunActivity(workspace);
    try {
      const automations = withWorkspaceAttachment(workspace, (held) => held.state.collectionAutomations);
      if (!automations) throw new Error("dohc could not read this workspace's automations.");
      if (!activity.engineCaptureFor(workspace.workspaceId)) throw new Error("dohc could not open this workspace's automations.");
      await automations.open();
      return await automations.enabledForWake(intent.wake.automationId);
    } finally { await release(); }
  },
  dismiss: (intent) => noticeStore().dismissFirst({ store: "account", noticeId: intent.noticeId }, intent.account),
  wake: async (intent, message) => {
    const session = await noticeSession();
    const signal = ownerDeliveryCredentialLifetime.signal;
    const workspace = findWorkspace(intent.workspaceId);
    if (!session || session.account.key !== intent.account || !session.isCurrent() ||
      session.reachFor(intent.workspaceId)?.workspaceId !== intent.workspaceId ||
      !workspace || workspace.shareView !== undefined) throw new Error("The wake's account or workspace changed.");
    await desktopEngine.startup;
    signal.throwIfAborted();
    const release = await acquireDispatchRunActivity(workspace);
    try {
      signal.throwIfAborted();
      if (!session.isCurrent() || session.reachFor(intent.workspaceId)?.workspaceId !== intent.workspaceId) {
        throw new Error("The wake's account or workspace changed.");
      }
      const automations = withWorkspaceAttachment(workspace, (held) => held.state.collectionAutomations);
      if (!automations) throw new Error("dohc could not read this workspace's automations.");
      if (!activity.engineCaptureFor(workspace.workspaceId)) throw new Error("dohc could not open this workspace's automations.");
      await automations.open();
      if (await automations.enabledForWake(intent.wake.automationId)) await wakeAutomationAgent(workspace, signal, message, true);
    } finally { await release(); }
  },
  onError: (error) => console.error("[desktop] agent wake:", error),
});

// At start, every workspace this computer ran schedules for waits for its
// next due time, open or not.
async function watchRecordedSchedules(): Promise<void> {
  for (const { workspaceId, record } of await scheduleRecords.readAll()) {
    const workspace = findWorkspace(workspaceId);
    if (workspace === null || workspace.shareView !== undefined) await scheduleRecords.save(workspaceId, null);
    else automationScheduler.watch(workspaceId, record);
  }
  await refreshDispatchTray();
}

// A schedule of a workspace no window has open is due. Open it the way
// background dispatch does, let the scheduler claim and the executor run,
// then close what this opened.
async function runSchedulesInBackground(workspaceId: string): Promise<void> {
  const registered = findWorkspace(workspaceId);
  if (registered === null || registered.shareView !== undefined) {
    automationScheduler.remove(workspaceId);
    await scheduleRecords.save(workspaceId, null);
    return;
  }
  await desktopEngine.startup;
  const release = await acquireDispatchRunActivity(registered);
  try {
    const automations = withWorkspaceAttachment(registered, (held) => held.state.collectionAutomations);
    if (automations && activity.engineCaptureFor(workspaceId)) {
      automationHosts.open(workspaceId);
      await automations.open();
      await automationScheduler.idle();
      await automations.idle();
    }
  } finally {
    // A window or the CLI that opened the workspace meanwhile keeps it open.
    await release();
  }
}

// Run now on a skipped schedule's notice. The notice's first dismissal on
// the relay picks the one computer that runs it; this one opens the
// workspace the way a due time would, claims the run, and lets it run.
// Resolves to null once the run started here, or to why it did not.
async function runSkippedScheduleNow(ref: NoticeRef, account: string | null): Promise<string | null> {
  const listed = await noticeStore().list();
  const notice = listed.notices.find((row) => row.store === ref.store && row.noticeId === ref.noticeId);
  const automationId = notice?.target?.automation;
  if (!notice || notice.kind !== "schedule-skipped" || !automationId || notice.workspaceId === null) {
    return "This notice has no schedule to run.";
  }
  // Saved before the dismissal, so a crash before the claim resumes it.
  const intent: RunNowIntent = { notice: ref, account, workspaceId: notice.workspaceId, automationId };
  await runNowIntents.save(intent);
  return await continueRunNow(intent);
}

// The rest of a Run now, from its saved intent. The relay names this
// computer as the dismissal's winner, so asking again answers "first" again,
// and the engine's claim is one per notice, so a repeat runs nothing twice.
async function continueRunNow(intent: RunNowIntent): Promise<string | null> {
  const workspace = findWorkspace(intent.workspaceId);
  if (!workspace || workspace.shareView !== undefined) {
    await runNowIntents.remove(intent.notice);
    return "This workspace isn't on this computer. Run it from the computer that has it.";
  }
  await desktopEngine.startup;
  const release = await acquireDispatchRunActivity(workspace);
  try {
    const automations = withWorkspaceAttachment(workspace, (held) => held.state.collectionAutomations);
    if (!automations || !activity.engineCaptureFor(workspace.workspaceId)) {
      return "dohc could not open this workspace to run the automation.";
    }
    automationHosts.open(workspace.workspaceId);
    await automations.open();
    // Checked before the dismissal: a computer that cannot run it leaves
    // the notice for one that can.
    const refusal = await automations.runNowRefusal(intent.automationId);
    if (refusal !== null) {
      await runNowIntents.remove(intent.notice);
      return refusal;
    }
    const dismissal = await noticeStore().dismissFirst(intent.notice, intent.account);
    // The dismissal may have landed with its answer lost: the intent stays,
    // and the next start or window focus asks again.
    if (dismissal === "unanswered") return "dohc could not reach your server. It runs this once it does.";
    if (dismissal === "not-first") {
      await runNowIntents.remove(intent.notice);
      return "This already ran from another computer.";
    }
    if (!(await automations.runNow(intent.automationId, intent.notice.noticeId))) {
      return "dohc could not start the automation. Its engine did not answer.";
    }
    // The claim is in the engine now; it runs from there.
    await runNowIntents.remove(intent.notice);
    await automations.idle();
    return null;
  } finally {
    await release();
  }
}

// Try again from a failed run's notice, on the computer that ran it. A
// workspace no window has open opens the way a due schedule's does, and
// stays open until the run settles.
async function retryAutomationFromNotice(
  notice: NoticeRow,
  input: { automationId: string; claimId: string; startOver: boolean },
): Promise<CollectionAutomationRetry> {
  const workspace = notice.workspaceId !== null
    ? findWorkspace(notice.workspaceId)
    : listWorkspaces().find((entry) => entry.shareView?.shareId === notice.recipientShareId) ?? null;
  if (!workspace) return { status: "refused", reason: "This workspace isn't on this computer anymore." };
  await desktopEngine.startup;
  const release = await acquireDispatchRunActivity(workspace);
  const automations = withWorkspaceAttachment(workspace, (held) => held.state.collectionAutomations);
  let result: CollectionAutomationRetry | null = null;
  try {
    if (!automations) return { status: "refused", reason: "dohc could not open this workspace to run the automation." };
    await automations.open();
    result = await automations.retry(input);
    return result;
  } finally {
    if (automations && result?.status === "queued") {
      void automations.idle().finally(release).catch((error: unknown) =>
        console.warn(`[desktop] Try again in ${workspace.workspaceId}:`, error));
    } else {
      await release();
    }
  }
}

// Someone switched off an automation. The person who changed it last hears
// who did, as History names them, unless they did it themselves. Only the
// owner's computer keeps that History, and only a synced workspace has
// anyone else to tell.
async function sendSwitchedOffNotice(workspaceId: string, switched: AutomationSwitchedOff): Promise<void> {
  const history = ownerHistory(workspaceId);
  if (history === null) return;
  const path = `${switched.collectionPath}/automations.yaml`;
  const { capture, ownerUserId, grants } = history;
  const found = await whoSwitchedOff(capture, { path, id: switched.id, ownerUserId });
  if (found === null) return;
  const switcherName = switcherNameFor({
    switchedOffBy: found.switchedOffBy,
    recipient: found.lastChangedBy,
    ownerUserId,
    ownerName: cachedPreferredName ?? null,
    emailOf: (userId) => grants.find((grant) => grant.recipientUserId === userId && grant.recipientEmail !== null)?.recipientEmail ?? null,
  });
  const notice = switchedOffNotice({ workspaceId, switched, path, ...found, switcherName });
  if (notice !== null) await noticeStore().postNotice(notice);
}

// Who changed an automation last, as the owner's History names them. Null
// on any other computer, which does not keep who changed what.
async function automationLastChangedBy(workspaceId: string, automationId: string): Promise<string | null> {
  const history = ownerHistory(workspaceId);
  const parsed = collectionAutomationsOf(workspaceId)?.locate(automationId) ?? null;
  if (history === null || parsed === null) return null;
  return await whoChangedLast(history.capture, {
    path: `${parsed.collectionPath}/automations.yaml`, id: parsed.id, ownerUserId: history.ownerUserId,
  });
}

// The History of a synced workspace this computer owns, where it records
// who changed each file; null for any other, which has nobody else to tell.
function ownerHistory(workspaceId: string) {
  const entry = findWorkspace(workspaceId);
  const capture = activity.engineCaptureFor(workspaceId);
  if (!entry?.remote || entry.shareView !== undefined || !capture) return null;
  return { capture, ownerUserId: entry.remote.ownerUserId, grants: entry.shareRoster?.grants ?? [] };
}

// Every Run now a crash or a lost answer left unfinished.
let resumingRunNow: Promise<void> | null = null;
function resumeRunNow(): void {
  resumingRunNow ??= (async () => {
    for (const intent of await runNowIntents.list()) {
      const note = await continueRunNow(intent).catch((error: unknown) =>
        error instanceof Error ? error.message : String(error));
      if (note !== null) console.warn(`[desktop] Run now for "${intent.notice.noticeId}": ${note}`);
    }
  })().finally(() => {
    resumingRunNow = null;
  });
}

// The last window closed and dohc stays in the tray for its schedules: a
// workspace no window, CLI call, or background run holds closes, and its
// schedules wait in their records.
async function releaseIdleWorkspaces(): Promise<void> {
  // Agent dispatch watches the open workspaces, and kept them open before
  // schedules could keep dohc running.
  if (dispatchKeepsRunning()) return;
  for (const workspaceId of activity.listOpenWorkspaceIds()) {
    const workspace = findWorkspace(workspaceId);
    if (!workspace) continue;
    // The windows left, so their hold goes, even while a background run
    // still holds the workspace: that run's release closes it.
    const left = withWorkspaceAttachment(workspace, (held) => {
      if (rendererWorkspaceSessions.isAttachmentOpen(held.binding.attachmentId)) return false;
      leaveForeground(held.state);
      return true;
    });
    if (left) {
      await closeDispatchRunActivity(workspace, { unlessInUse: true }).catch((error: unknown) =>
        console.warn(`[desktop] Could not close idle workspace "${workspaceId}":`, error));
    }
  }
}



const AUTOMATION_HOST_REQUEST_TIMEOUT_MS = 15_000;

function announceScheduleHost(workspaceId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNELS.scheduleHostChanged, workspaceId);
  }
}

// Which of the owner's computers runs each open synced workspace's
// schedules, as the relay records it.
const automationHosts = createAutomationHosts({
  installId: localInstallationId,
  label: () => computerLabel(hostname()),
  synced: (workspaceId) => findWorkspace(workspaceId)?.remote !== undefined,
  send: async (workspaceId, request) => {
    const workspace = findWorkspace(workspaceId);
    if (!workspace) return null;
    let credentials: CloudSessionCredentials;
    try {
      ({ credentials } = await remoteForWorkspace(workspace));
    } catch {
      // Signed out, or signed in to another account or server.
      return null;
    }
    if (!credentials.relayUrl) return null;
    const response = await relayShareResponseWithCredentials(
      credentials,
      `/sync/${encodeURIComponent(workspaceId)}/automation-host/${request.action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS),
      },
    );
    return { status: response.status, body: await response.json().catch(() => undefined) };
  },
  stored: (workspaceId) => findWorkspace(workspaceId)?.automationHost,
  store: (workspaceId, host) => {
    setWorkspaceAutomationHost(workspaceId, host);
    announceScheduleHost(workspaceId);
  },
  startedHere: (workspaceId, startAfterMs, floorMs) => automationScheduler.startedHere(workspaceId, startAfterMs, floorMs),
  hostChanged: (workspaceId) => collectionAutomationsOf(workspaceId)?.hostChanged(),
  // The release waits until the engine here claims no more Group messages,
  // and carries what it decided so the next host claims each one once.
  finishHere: async (workspaceId, stillHandingOver) => {
    const automations = collectionAutomationsOf(workspaceId);
    const released = automations ? await automations.releaseGroupSubscriptions(stillHandingOver) : null;
    if (released === null) return null;
    const throughMs = await automationScheduler.finishHere(workspaceId);
    if (throughMs === null) return null;
    // Carried so a step stopped here stays stopped on the next host.
    const reach = automations ? await automations.reachHandover() : null;
    return { throughMs, groups: released.handover, groupsWatched: released.watchedGeneration, reach };
  },
  logError: (workspaceId, error) => console.warn(`[desktop] Schedules in ${workspaceId}: automation host:`, error),
});

// The runs, Undo, and held steps of the owner's self-hosted server, through
// the relay's owner routes. Only the owner's own session asks; any other
// answers that the server has none to show.
const serverRuns = createServerRuns(async (workspaceId, request) => {
  const workspace = findWorkspace(workspaceId);
  if (!workspace || workspace.shareView !== undefined) return null;
  // A sign-in dohc could not read is not a sign-out, so the ask fails. The
  // failure comes from the load this ask waited on, not from shared state.
  const unreadable = await credentialSessionCache.warm(() => cloudLogin().credentials());
  if (unreadable) throw unreadable.error;
  let credentials: CloudSessionCredentials;
  let credentialGeneration: number;
  if (!workspace.remote) {
    // A computer that doesn't sync the workspace or keep its Collections asks
    // the server its Collections moved to, with that server's session.
    const server = await serverCollectionsFor(workspace, AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS));
    if (server === null) return null;
    ({ credentials, credentialGeneration } = server);
  } else try {
    ({ credentials, credentialGeneration } = await remoteForWorkspace(workspace));
  } catch {
    // Signed out, or signed in to another account or server.
    return null;
  }
  if (!credentials.relayUrl) return null;
  const query = request.method === "GET" && request.query ? `?${new URLSearchParams(request.query).toString()}` : "";
  const response = await relayShareResponseWithCredentials(
    credentials,
    `/sync/${encodeURIComponent(workspaceId)}/automation-server/${request.action}${query}`,
    request.method === "GET"
      ? { method: "GET", signal: AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS) }
      : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS),
      },
  );
  return {
    status: response.status,
    body: await response.json().catch(() => undefined),
    asker: { account: credentials.userId, current: () => credentialCacheGeneration === credentialGeneration },
  };
});

// Which of the owner's computers runs a workspace's schedules, for settings
// and the ⚡ panel, after a choose or take-over when one is given. This
// computer acts on the answer at once.
async function scheduleHostState(
  workspaceId: string,
  change?: { action: "choose" | "take-over"; body: Record<string, string | number> },
  localOnly = false,
): Promise<ScheduleHostResult> {
  const entry = findWorkspace(workspaceId);
  if (entry === null || entry.shareView !== undefined || (localOnly && entry.remote !== undefined)) return { kind: "none" };
  if (entry.remote === undefined) {
    const here = thisComputer();
    let host = await scheduleComputer(entry.rootPath, here);
    // Taking over, this computer runs them from now on. The other one stops
    // at its next read, and may have run anything before now.
    if (change?.action === "take-over" && host !== null && !(host.kind === "computer" && host.computer.installId === here.installId)) {
      host = (await runSchedulesOn(entry.rootPath, here)) ? { kind: "computer", computer: here } : null;
      if (host !== null) {
        automationScheduler.startedHere(workspaceId, null, null);
        collectionAutomationsOf(workspaceId)?.hostChanged();
        announceScheduleHost(workspaceId);
      }
    }
    if (host === null) return { kind: "note", message: "Turn on sync to run this workspace's schedules." };
    if (host.kind === "unreadable") {
      const { cause } = readError(host.error);
      return {
        kind: "no-computer",
        message: withErrorWords("No computer runs this workspace's schedules, because dohc could not read which one should.", host.error),
        ...(cause ? { cause } : {}),
      };
    }
    const { computer } = host;
    if (computer.installId === here.installId) return { kind: "this-computer" };
    return {
      kind: "another-computer",
      label: computer.label,
      // An installation by this computer's name may be an earlier one here.
      sameName: computer.label === here.label,
      waits: workspaceHosts.waitsElsewhere(workspaceId),
    };
  }
  let credentials: CloudSessionCredentials;
  let credentialGeneration: number;
  try {
    ({ credentials, credentialGeneration } = await remoteForWorkspace(entry));
  } catch (error) {
    return { kind: "note", message: error instanceof Error ? error.message : "Sign in to your server first." };
  }
  const path = `/sync/${encodeURIComponent(workspaceId)}/automation-host`;
  const request = async (init: RequestInit & { action?: string }) => {
    const response = await relayShareResponseWithCredentials(
      credentials,
      init.action ? `${path}/${init.action}` : path,
      { ...init, signal: AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS) },
    );
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  let answer = change
    ? await request({
      action: change.action,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change.body),
    })
    : await request({ method: "GET" }).catch((error: unknown) => {
      // Offline, a read says so where the host shows. A choice still fails.
      if (relayUnreachable(error)) return null;
      throw error;
    });
  if (answer === null) {
    return { kind: "note", message: "dohc could not reach your server to check which computer runs schedules." };
  }
  // Another computer changed the host first: show it as it is now.
  if (change && answer.status === 409) answer = await request({ method: "GET" });
  // An answer for an account that signed out meanwhile belongs to no one here.
  if (credentialCacheGeneration !== credentialGeneration) {
    throw new Error("Your account changed while dohc asked. Open this setting again.");
  }
  // The server refused the choice, as when it runs no more workspaces: say why.
  const refusal = change ? refusalOfAnswer(answer) : undefined;
  if (refusal !== undefined) throw new Error(refusal);
  const answered = hostOfAnswer(answer);
  const computers = computersOfAnswer(answer);
  if (answered === undefined || computers === undefined) {
    throw new Error("dohc could not read which computer runs this workspace's schedules.");
  }
  const host = automationHosts.learned(workspaceId, answered);
  const installId = localInstallationId();
  return {
    kind: "relay",
    generation: host?.generation ?? 0,
    hostInstallId: host?.installId ?? null,
    handoverFrom: host?.handoverFrom ?? null,
    computers: computers.map((computer) => ({ ...computer, thisComputer: computer.installId === installId })),
  };
}

// Where each workspace's schedules and Group triggers run: the relay's
// host, or for a workspace that does not sync, the computer its folder names.
const workspaceHosts = createWorkspaceHosts({
  here: thisComputer,
  workspace: findWorkspace,
  relay: automationHosts,
  hasHostTriggers: (workspaceId) => collectionAutomationsOf(workspaceId)?.hasHostTriggers() ?? false,
  hostChanged: (workspaceId) => {
    collectionAutomationsOf(workspaceId)?.hostChanged();
    announceScheduleHost(workspaceId);
  },
  elsewhereChanged: announceScheduleHost,
  logError: (workspaceId, error) => console.warn(`[desktop] could not read where workspace ${workspaceId} runs its automations:`, error),
});

// The relay's last release or take over, read at this host generation, as
// the engine takes it: 0 for none, with the handover when a release left it
// for this computer. The engine checks a handover again before it takes it.
async function automationGroupRelayRecord(workspaceId: string, generation: number): Promise<AutomationGroupRelayRecord> {
  const kept = await automationHandoverRecord(workspaceId, generation);
  if (kept === null) return { generation: 0, handover: null };
  return {
    generation: typeof kept.generation === "number" ? kept.generation : 0,
    handover: kept.groups === null ? null : decodeAutomationGroupHandover(kept.groups),
  };
}

// The same record, as the executor takes the last host's reach verdicts:
// verdicts it cannot read count as none, so it holds what it cannot prove.
async function automationReachRelayRecord(workspaceId: string, generation: number): Promise<ReachRelayRecord> {
  const kept = await automationHandoverRecord(workspaceId, generation);
  if (kept === null) return { generation: 0, reach: null, everShared: false };
  if (typeof kept.everShared !== "boolean") throw new Error("The relay's Group handover read did not say whether the workspace was shared.");
  return {
    generation: typeof kept.generation === "number" ? kept.generation : 0,
    reach: kept.reach === null ? null : parseReachHandover(kept.reach),
    everShared: kept.everShared,
  };
}

// The relay's last release or take over at this host generation, or null
// for a workspace that does not sync. Throws when the relay does not answer.
async function automationHandoverRecord(
  workspaceId: string,
  generation: number,
): Promise<{ generation: unknown; groups: NonNullable<unknown> | null; reach: NonNullable<unknown> | null; everShared: unknown } | null> {
  const entry = findWorkspace(workspaceId);
  if (!entry?.remote) return null;
  const { credentials } = await remoteForWorkspace(entry);
  const response = await relayShareResponseWithCredentials(
    credentials,
    `/sync/${encodeURIComponent(workspaceId)}/automation-host/groups?generation=${generation}`,
    { method: "GET", signal: AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS) },
  );
  const body: unknown = await response.json().catch(() => undefined);
  const kept = response.status === 200 && body && typeof body === "object" && (body as { ok?: unknown }).ok === true
    ? body as { generation?: unknown; groups?: unknown; reach?: unknown; everShared?: unknown }
    : undefined;
  if (
    kept === undefined || !(kept.generation === null || Number.isSafeInteger(kept.generation)) ||
    kept.groups === undefined || kept.reach === undefined
  ) {
    throw new Error(`The relay answered the Group handover read with ${response.status}.`);
  }
  return { generation: kept.generation, groups: kept.groups, reach: kept.reach, everShared: kept.everShared };
}

// Whether any computer can run this workspace's schedules and Group
// triggers as it stands. One that synced before, or whose folder has no
// record, needs sync on.
async function hostCanRun(workspaceId: string): Promise<boolean> {
  const entry = findWorkspace(workspaceId);
  if (entry === null || entry.shareView !== undefined) return false;
  return entry.remote !== undefined || (await readSyncHistory(entry.rootPath)) === "never-synced";
}

// Windows sends every top-level window WM_TIMECHANGE when the system clock
// is set, and the scheduler checks its due times again.
const WM_TIMECHANGE = 0x001e;

// This computer's side of shared-view Button presses for one workspace: the
// owner's relay session, and presses run through the workspace's executor.
// A failure reaches the person who pressed as a notice.
function createRelayedPressHostFor(workspaceId: string): RelayedPressHost {
  return createRelayedPressHost({
    workspaceId,
    // The one automation host module decides where automations run; this
    // loop only asks it.
    host: {
      runsHere: () => automationHosts.runsHere(workspaceId),
      stillRuns: () => automationHosts.stillRuns(workspaceId),
      hold: () => automationHosts.hold(workspaceId),
      generation: () => {
        const host = findWorkspace(workspaceId)?.automationHost;
        return automationHosts.stillRuns(workspaceId) && host ? host.generation : null;
      },
    },
    transport: async () => {
      await warmCredentialCache();
      const credentials = cachedCredentials;
      const entry = findWorkspace(workspaceId);
      if (!credentials?.relayUrl || !entry?.remote || shareViewIsPresent(entry.shareView)) return null;
      if (credentials.userId !== entry.remote.ownerUserId || !relayUrlsMatch(credentials.relayUrl, entry.remote.serverUrl)) return null;
      return relayPressTransport(
        { baseUrl: normalizeServerUrl(credentials.relayUrl), token: credentials.token, fetch: relayShareFetch },
        workspaceId,
        localInstallationId(),
      );
    },
    heldClaim: async (press) => {
      const executor = collectionAutomationsOf(workspaceId);
      if (!executor) throw new Error("This workspace was closed. Open it again.");
      return await executor.relayedClaim({ automationId: press.automationId, collectionPath: press.collectionPath, definitionHash: press.definitionHash, pressId: press.hostPressId });
    },
    inspect: async (inspectionIds, signal) => {
      const executor = collectionAutomationsOf(workspaceId);
      return executor ? executor.inspectRelayedBatch(inspectionIds, signal) : inspectionIds.map(() => ({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED }));
    },
    press: async (input, watch) => {
      const executor = collectionAutomationsOf(workspaceId);
      if (!executor) throw new Error("This workspace was closed. Open it again.");
      return await executor.pressRelayed(input, (claimId) => watch(claimId));
    },
    notifyFailure: async (failure) => {
      await noticeStore().postNotice({ workspaceId, ...relayedPressFailureNotice(failure) });
    },
    onError: (context, error) => console.warn(`[desktop] Relayed Button presses in ${workspaceId}: ${context}:`, error),
  });
}

async function hostButtonAuthority(workspaceId: string, id: string, inspection = false) {
  await warmCredentialCache();
  const credentials = cachedCredentials, entry = findWorkspace(workspaceId);
  if (!credentials?.relayUrl || !entry?.remote || shareViewIsPresent(entry.shareView) ||
    credentials.userId !== entry.remote.ownerUserId || !relayUrlsMatch(credentials.relayUrl, entry.remote.serverUrl) ||
    !automationHosts.stillRuns(workspaceId) || !entry.automationHost) throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster");
  return automationPressRelay({ baseUrl: normalizeServerUrl(credentials.relayUrl), token: credentials.token, fetch: relayShareFetch })
    .authority(workspaceId, localInstallationId(), entry.automationHost.generation, id, inspection);
}

// An open workspace's Collection automations. Runs write through the same
// seam as every other collection write, with the capture the workspace
// already opened, and end at the run's own signal or the operation's.
function createCollectionAutomationsFor(
  binding: WorkspaceAuthorityBinding<RegistryEntry>,
  datasetHost: DatasetHostSlot,
): CollectionAutomations {
  const { workspaceId, canonicalRootPath: rootPath, attachmentId } = binding;
  const workspace = { workspaceId, rootPath, attachmentId };
  const recordWrites: CollectionAutomationsOptions["withRecordWrites"] = async (signal, work) => {
    const person = await localPerson();
    return await withPhysicalWorkspaceOperation(workspaceId, async (operation) => {
      if (operation.workspace.attachmentId !== attachmentId) {
        throw new Error("This workspace was closed. Open it again.");
      }
      const capture = activity.engineCaptureFor(workspaceId);
      if (!capture) throw new Error(captureRefusal("Automations"));
      return work(collectionRecordWrites(collectionEditContextWith(operation, capture, AbortSignal.any([signal, operation.signal]), person)));
    });
  };
  return new CollectionAutomations({
    withEngine: (work) => withEngineAdapter(workspace, work),
    // Each write names its author, so Undo writes as the person here the same way.
    withRecordWrites: recordWrites,
    withUndoWrites: recordWrites,
    readText: (path) => readWorkspaceTextIfPresent(rootPath, path),
    writeText: async (path, text, expectedContentHash, automationId) => {
      return withPhysicalWorkspaceOperation(workspaceId, async operation => {
        if (operation.workspace.attachmentId !== attachmentId) throw new Error("This workspace was closed. Open it again.");
        const capture = activity.engineCaptureFor(workspaceId);
        if (!capture || operation.workspace.shareView !== undefined) return writeWorkspaceText(rootPath, path, text, expectedContentHash);
        const result = await writeWorkspaceFilesAs(operation, [{ path, contentBase64: Buffer.from(text).toString("base64"), expectedSha256: expectedContentHash }],
          { kind: "automation", automationId, depth: 1 }, { capture });
        if (result.ok) return { status: "written" as const };
        if (result.currentSha256 !== undefined) return { status: "conflict" as const };
        throw new Error(result.reason);
      });
    },
    pathExists: (path) => lstat(join(rootPath, path)).then(() => true, () => false),
    // A watcher batch reaches the executor before the engine records it.
    recorded: async () => { await activity.engineCaptureFor(workspaceId)?.flush(); },
    roster: () => shareRosters.forRun(workspaceId),
    cachedRoster: () => shareRosters.cached(workspaceId),
    evaluator: automationEvaluator.forWorkspace(workspaceId),
    store: createAutomationRunStore(localAutomationStoreFolder(workspace), () => {
      if (!workspaceAuthorities.isCurrentAttachment(workspaceId, attachmentId)) throw new Error("This workspace was closed. Open it again.");
    }),
    onRunsChanged: () => notifyAutomationRunsChanged(workspaceId),
    onUsageSuccess: invocation => { usageStore?.recordSuccess(invocation); },
    reportFailure: (report) => sendFailureNotices({
      notices: noticeStore(),
      computer: thisComputer(),
      throughShare: findWorkspace(workspaceId)?.shareView !== undefined,
      primaryUserId: localUserId(),
      lastChangedBy: (automationId) => automationLastChangedBy(workspaceId, automationId),
      onError: (context, error) => console.warn(`[desktop] Collection automations in ${workspaceId}: ${context}:`, error),
    }, workspaceId, report),
    withdrawFailure: (failure) =>
      noticeStore().withdraw(automationFailedNoticeId({ workspaceId, installId: localInstallationId(), failure })),
    onSwitchedOff: (switched) => void sendSwitchedOffNotice(workspaceId, switched).catch((error: unknown) =>
      console.warn(`[desktop] Collection automations in ${workspaceId}: tell who changed "${switched.name}" last that it was switched off:`, error)),
    onHoldsChanged: () => notifyAutomationHoldsChanged(workspaceId),
    onAutomationsChanged: () => notifyCollectionAutomationsChanged(workspaceId),
    chat: {
      hasMessage: (messageId) => withWorkspaceAttachmentAsync(workspace, (lease) =>
        hasChatMessage(linkedChatStoreFor(lease), workspaceId, messageId)),
      // A joined Group this computer may only read is marked, as a chat write refuses it (assertJoinedChannelWritable).
      directory: (roster, needs) => withWorkspaceAttachmentAsync(workspace, (lease) =>
        readChatDirectory(linkedChatStoreFor(lease), workspaceId, roster, needs, (wireId) => {
          const joined = joinedSharedChannelForWireId(findWorkspace(workspaceId)?.sharedChannels, wireId);
          return joined === null ? null : { readOnly: joined.access === "read-only", ended: joined.ended === true };
        })),
      // The same write path as every other chat write, as the automation.
      write: (signal, message) => withWorkspaceAttachmentAsync(workspace, async (lease) => {
        const place = { workspaceId, store: linkedChatStoreFor(lease) };
        const common = {
          writer: { via: "automation" as const, ...message.automation },
          // chatWrites checks it just before the row.
          signal,
          body: message.body,
          messageId: message.messageId,
          idempotencyKey: message.effectId,
          resolveAttachments: async () => [],
        };
        if (message.target.kind === "agent") return wakeAutomationAgent(workspace, signal, message);
        return message.target.kind === "group"
          ? await chatWrites.startThread(place, {
              ...common, channelId: message.target.channelId, lane: message.target.lane, threadId: message.threadId,
            })
          : await chatWrites.sendMessage(place, { ...common, threadId: message.target.threadId });
      }),
    },
    // A notice to this computer's own id for its person stays here, even
    // after a sign-in: the reach check allowed it as this computer's person.
    postNotice: ({ recipientUserId, ...notice }, signal) => noticeStore().postNotice({
      workspaceId, ...notice, signal,
      ...(recipientUserId === localInstallationId() ? { onlyHere: true } : { recipientUserId }),
    }),
    // From the last host read, with no relay request: the host module calls
    // hostChanged when the answer may differ.
    groupHost: () => workspaceHosts.groupHost(workspaceId),
    groupRelayRecord: (generation) => automationGroupRelayRecord(workspaceId, generation),
    reachRelayRecord: (generation) => automationReachRelayRecord(workspaceId, generation),
    requestHost: () => automationHosts.admit(workspaceId),
    groupMessagesSkipped: (reason, atMs) => noticeStore().postNotice(groupMessagesNotice({ workspaceId, reason, atMs })),
    readMessageBody: (messageId) => withWorkspaceAttachmentAsync(workspace, async (lease) =>
      (await linkedChatStoreFor(lease).getMessage({ workspaceId, messageId })).body),
    onSchedulesChanged: () => {
      automationScheduler.wake();
      workspaceHosts.automationsChanged(workspaceId);
    },
    hostCanRun: () => hostCanRun(workspaceId),
    // The builder's Group pickers name this computer's Groups; direct messages are not Groups.
    groupList: () => withWorkspaceAttachmentAsync(workspace, async (lease) =>
      (await linkedChatStoreFor(lease).listChannels({ workspaceId }))
        .flatMap((channel) => (channel.kind === "channel" ? [{ name: channel.name, slug: channel.slug }] : []))),
    personName: (userId) => (userId === localUserId() ? localUserDisplayName() : userId),
    localPersonId: localUserId,
    mayRetryPress: async (pressedBy) => pressedBy === (await pressingPerson()) || (await localPersonOwns(workspaceId)),
    onPressSettled: (event) => {
      pressWindows.settled(workspaceId, event);
      withWorkspaceAttachment({ workspaceId }, (lease) => lease.state.relayedPresses)?.runSettled(event);
    },
    onPressWaiting: (event) => {
      pressWindows.waiting(workspaceId, event);
    },
    // A relayed press's run holds off a handover until its writes stop.
    holdForHost: () => automationHosts.hold(workspaceId),
    resolveRelayedPress: (id) => hostButtonAuthority(workspaceId, id),
    resolveButtonInspection: (id) => hostButtonAuthority(workspaceId, id, true),
    onError: (context, error) =>
      console.warn(`[desktop] Collection automations in ${workspaceId}: ${context}:`, error),
    // A Collection on the server, read for a person who asked about it. The server runs it.
    serverDataset: (datasetId) => withPhysicalWorkspaceOperation(workspaceId, async (operation) => {
      if (operation.workspace.attachmentId !== attachmentId) throw new Error("This workspace was closed. Open it again.");
      const server = await serverCollectionOf(operation.workspace, datasetId, operation.signal);
      return server && await readServerDataset(workspaceId, datasetId, server.data, server.automationHost).catch((error: unknown) => {
        // The server doesn't have it: the computer that keeps the workspace's other Collections does.
        if (error instanceof CollectionsRefusalError) return null;
        throw error;
      });
    }),
    withDatasetHost: async (work, open) => {
      // An open host serves the executor until disposal closes it, so a
      // closing executor can still hand its claims back. The executor opens
      // one only for what a person asked about; otherwise it waits for the
      // Collections list or a dataset action to open it.
      const opened = datasetHost.pending;
      if (opened) return await work((await stillHeld(datasetHost, opened)).automations);
      if (!open) return null;
      return await withPhysicalWorkspaceOperation(workspaceId, async (operation) => {
        if (operation.workspace.attachmentId !== attachmentId) throw new Error("This workspace was closed. Open it again.");
        // A workspace that never approved a dataset has no dataset store to open.
        if (!(await localDatasetStoreExists(rootPath))) return null;
        const host = await localDatasetHostFor(operation.workspace, operation.signal);
        return await work(host.automations);
      });
    },
  });
}

// A new session lets automations that waited to post try again.
function resumeAutomationSessionWaits(): void {
  for (const workspaceId of workspaceAuthorities.workspaceIds()) collectionAutomationsOf(workspaceId)?.sessionChanged();
}

async function stopAllSitePreviews(): Promise<void> {
  // Runs once, from the will-quit teardown — the first moment a quit can no
  // longer be cancelled. Idempotent. The caller awaits it inside
  // WILL_QUIT_BUDGET_MS so quit cannot outrun a preview process's own
  // hard-kill path.
  await Promise.allSettled(
    workspaceAuthorities.workspaceIds().map((workspaceId) =>
      workspaceAuthorities.withAuthority(workspaceId, (lease) =>
        lease.state.sitePreviews.stopAll(),
      ),
    ),
  );
}

let describeDatasetForCli: ((workspaceId: string, datasetId: string) => ReturnType<typeof describeAutomationDataset>) | undefined;
let datasetForCli: ((input: DatasetRequest, agent: LocalDatasetAgent | null) => Promise<DatasetResult>) | undefined;
// A window's press path; the CLI's presses take it too.
let pressNamedForCli: ReturnType<typeof registerAutomationButtonsIpc<WebContents, IpcMainInvokeEvent, DesktopWorkspaceOperation>>["pressNamed"] | undefined;
let inspectNamedForCli: ReturnType<typeof registerAutomationButtonsIpc<WebContents, IpcMainInvokeEvent, DesktopWorkspaceOperation>>["inspectNamed"] | undefined;
const activeDatasetHosts = new Set<Promise<LocalDatasetHost>>();
// Each workspace attachment's local dataset host, opened on first use and
// closed when the attachment's state is disposed, after its automation
// executor. Dataset IPC and the automation executor share it.
type DatasetHostSlot = { pending: Promise<LocalDatasetHost> | null };
async function closeLocalDatasetHost(slot: DatasetHostSlot): Promise<void> {
  const pending = slot.pending;
  slot.pending = null;
  if (!pending) return;
  try {
    await (await pending).close();
  } catch (error) {
    console.error("Collection shutdown failed", error);
  } finally {
    activeDatasetHosts.delete(pending);
  }
}
// Whether this installation keeps a workspace's Collections, read from the
// registry at each use.
function collectionsHolderCheck(workspaceId: string): CollectionsHolderCheck {
  return { here: thisComputer, required: () => collectionsHolderRequired(findWorkspace(workspaceId)) };
}
// Asks before keeping Collections another computer may have, in the window
// that asked. Cancel is the default.
async function confirmKeepCollections(window: BrowserWindow | null, question: KeepQuestion): Promise<boolean> {
  const { message, detail } = keepQuestionWords(question);
  const options = { type: "warning" as const, message, detail, buttons: [USE_THIS_COMPUTER, "Cancel"], defaultId: 1, cancelId: 1, noLink: true };
  const { response } = await showMessageBox(options, window);
  return response === 0;
}
// An open host serves new work only while this installation still keeps its
// store. One that no longer does closes, and the next use reads the record anew.
async function stillHeld(slot: DatasetHostSlot, pending: Promise<LocalDatasetHost>): Promise<LocalDatasetHost> {
  const host = await pending;
  try {
    host.held();
  } catch (error) {
    if (error instanceof CollectionsRefusalError && slot.pending === pending) void closeLocalDatasetHost(slot);
    throw error;
  }
  return host;
}
// What a computer that doesn't keep a workspace's Collections can use of
// them: the ones moved to its signed-in server, through that session alone.
interface ServerCollectionsSession {
  credentials: CloudSessionCredentials;
  credentialGeneration: number;
  elsewhere: ServerCollections["elsewhere"];
  /** The server's Collections, for work under `signal` while `assertCurrent` passes. */
  data(signal: AbortSignal, assertCurrent: () => void): RemoteDatasetData;
}
// The workspace does not start syncing, and its server and account stay as
// they are. Null where this computer keeps the Collections, or where it has
// no session for the workspace's server and account. The local store then
// refuses.
async function serverCollectionsFor(workspace: RegistryEntry & { attachmentId?: symbol }, signal: AbortSignal): Promise<ServerCollectionsSession | null> {
  // A store open here that this computer still keeps answers without reading the record.
  const slot = withWorkspaceAttachment(workspace, lease => lease.state.datasetHost);
  if (slot?.pending && await stillHeld(slot, slot.pending).then(() => true, () => false)) return null;
  const elsewhere = await collectionsKeptElsewhere(workspace.rootPath, workspace.workspaceId, collectionsHolderCheck(workspace.workspaceId));
  if (elsewhere === null) return null;
  await warmCredentialCache().catch(() => undefined);
  signal.throwIfAborted();
  const credentials = cachedCredentials, credentialGeneration = credentialCacheGeneration;
  const remote = workspace.remote ?? workspace.pausedRemote;
  if (!credentials?.relayUrl || (remote && !workspaceRemoteMatchesCredentials(remote, credentials))) return null;
  const refusal = new CollectionsRefusalError(elsewhere);
  return {
    credentials, credentialGeneration,
    elsewhere: { server: new URL(credentials.relayUrl).origin, computer: { label: elsewhere.computer.label, sameName: elsewhere.sameName } },
    data: (signal, assertCurrent) => createServerCollectionsData({ workspaceId: workspace.workspaceId, credentials, credentialGeneration, signal,
      currentCredentialGeneration: () => credentialCacheGeneration, assertCurrent,
      relayJson: (credentials, path, init) => relayShareJsonWithCredentials(credentials, path, init, { retainNotFound: true }),
      elsewhere: refusal }),
  };
}
// Who answers for a workspace's Collections, chosen as a Collection action
// chooses: the server, without opening a store, on a computer that doesn't
// keep them; otherwise the local store, which refuses there as before.
type CollectionsAuthority = { kind: "server"; server: ServerCollectionsSession } | { kind: "local"; local: LocalDatasetHost };
async function collectionsAuthorityFor(workspace: RegistryEntry & { attachmentId?: symbol }, signal: AbortSignal): Promise<CollectionsAuthority> {
  const server = await serverCollectionsFor(workspace, signal);
  return server ? { kind: "server", server } : { kind: "local", local: await localDatasetHostFor(workspace, signal) };
}
// The server a Collection moved to, which runs its automations, as this
// computer reaches it: with the session the server issued, at its own origin,
// following no redirect. Null for a Collection kept on this computer.
interface ServerCollection {
  data: RemoteDatasetData;
  /** The owner's automation host state, which says what the server runs. */
  automationHost(): Promise<{ status: number; body: unknown }>;
}
// A Collection's transfer record once its move finished, which every read of a Collection on this computer waits for.
function finishedTransferOf(workspace: RegistryEntry, local: LocalDatasetHost, datasetId: string, signal: AbortSignal) {
  return finishedTransfer({ local, workspaceId: workspace.workspaceId, datasetId, server: () => remoteForWorkspace(workspace),
    currentCredentialGeneration: () => credentialCacheGeneration, relayStream: relayShareJsonWithCredentials, signal });
}
async function serverCollectionOf(workspace: RegistryEntry & { attachmentId?: symbol }, datasetId: string, signal: AbortSignal): Promise<ServerCollection | null> {
  const authority = await collectionsAuthorityFor(workspace, signal);
  let credentials: CloudSessionCredentials, credentialGeneration: number;
  if (authority.kind === "server") ({ credentials, credentialGeneration } = authority.server);
  else {
    const transfer = await finishedTransferOf(workspace, authority.local, datasetId, signal);
    if (transfer === null) return null;
    ({ credentials, credentialGeneration } = await remoteForWorkspace(workspace));
    signal.throwIfAborted();
    if (!credentials.relayUrl || new URL(credentials.relayUrl).origin !== transfer.targetOrigin) throw new Error("Sign in to the server that hosts this Collection.");
  }
  const remote = { workspaceId: workspace.workspaceId, credentials, credentialGeneration, signal,
    currentCredentialGeneration: () => credentialCacheGeneration, assertCurrent: () => signal.throwIfAborted() };
  return {
    data: authority.kind === "server" ? authority.server.data(signal, remote.assertCurrent)
      : createRemoteDatasetData({ ...remote, relayJson: (credentials, path, init) => relayShareJsonWithCredentials(credentials, path, { ...init, redirect: "error" }) }),
    automationHost: () => readAutomationHost(workspace.workspaceId, credentials, credentialGeneration, signal),
  };
}
async function readAutomationHost(workspaceId: string, credentials: CloudSessionCredentials, credentialGeneration: number, signal: AbortSignal) {
  const response = await relayShareResponseWithCredentials(credentials, `/sync/${encodeURIComponent(workspaceId)}/automation-host`,
    { method: "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(AUTOMATION_HOST_REQUEST_TIMEOUT_MS)]) });
  signal.throwIfAborted();
  if (credentialCacheGeneration !== credentialGeneration) throw new Error("Your server session changed. Try again.");
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
/** A Collection's automations, and how many of them a schedule or Group message starts. */
async function automationCounts(workspaceId: string, collectionPath: string) {
  const file = await collectionAutomationsOf(workspaceId)?.automationsIn(collectionPath);
  const automations = file?.status === "read" ? file.automations.flatMap(summary => summary.valid ? [summary.automation] : []) : [];
  return { automations: automations.length,
    scheduledAutomations: automations.filter(automation => automation.when.kind === "schedule" || automation.when.kind === "group-message").length };
}
let installedDatasetCompiler: ReturnType<typeof createInstalledDatasetCompiler> | undefined;
const datasetRuntimePath = () => join(app.isPackaged ? process.resourcesPath : join(desktopPackageRootInDev(), "resources"), "app-backend-runtime");
const localDatasetHostFor = async (workspace: { workspaceId: string; rootPath: string }, signal: AbortSignal) =>
  workspaceAuthorities.withOperation(workspace.workspaceId, async operation => {
    signal.throwIfAborted(); operation.assertCurrent();
    const workspaceRoot = workspaceRootForOperation(operation.workspace.rootPath, workspace.rootPath);
    const slot = operation.state.datasetHost;
    let pending = slot.pending;
    if (!pending) {
      const runtimePath = datasetRuntimePath(), attachment = { workspaceId: workspace.workspaceId, attachmentId: operation.workspace.attachmentId };
      pending = createLocalDatasetHost({ workspaceId: workspace.workspaceId, workspaceRoot, attachmentId: attachment.attachmentId, localPersonId: localUserId,
        holder: collectionsHolderCheck(workspace.workspaceId),
        trashItem: path => shell.trashItem(path),
        runtime: { launch: createDesktopAppRuntimeLauncher(utilityProcess, true), entryPath: join(runtimePath, "child.mjs") },
        persistentRuntime: { launch: createDesktopAppRuntimeLauncher(utilityProcess, false), entryPath: join(runtimePath, "persistent-child.mjs") },
        compile: async (source, path, signal) => {
          installedDatasetCompiler ??= createInstalledDatasetCompiler(resourcesBasePath());
          return (await installedDatasetCompiler)(source, path, signal);
        },
        // Only this attachment's run. A host left from an earlier attachment
        // refuses the invocation rather than write as the owner at depth 0.
        agentRun: () => {
          const run = withWorkspaceAttachment(attachment, lease => workspaceActivity.agentRun(lease.state.activity));
          if (run === undefined) throw new Error("This workspace is no longer available for this Collection operation.");
          return run;
        },
        // A commit that made failed claims, as a chain stop does, sends their notices now.
        onAutomationClaims: (failed) => {
          const automations = collectionAutomationsOf(workspace.workspaceId);
          automations?.notifyClaimed();
          if (failed) automations?.failuresChanged();
        },
        onDatasetsChanged: () => collectionAutomationsOf(workspace.workspaceId)?.datasetsChanged(),
        collectionEngine: () => {
          const capture = activity.engineCaptureFor(workspace.workspaceId, workspaceRoot);
          if (!capture) throw new Error("The workspace engine is unavailable.");
          return localCollectionEngine({ workspaceId: workspace.workspaceId, rootPath: workspaceRoot, capture,
            withAdapter: async work => {
              const result = await withEngineAdapter({ ...workspace, rootPath: workspaceRoot, attachmentId: attachment.attachmentId }, async adapter => ({ value: await work(adapter) }));
              if (result === null) throw new Error("The workspace engine is unavailable.");
              return result.value;
            } });
        },
        collectionAuthor: async () => {
          const run = withWorkspaceAttachment(attachment, lease => workspaceActivity.agentRun(lease.state.activity));
          if (run === undefined) throw new Error("This workspace is no longer available for this Collection operation.");
          return run ? { kind: "agent", agentId: run.agentId, onBehalfOf: run.onBehalfOf, agentRunId: run.agentRunId, ...(run.depth > 0 ? { depth: run.depth } : {}) } : await localPerson();
        },
      });
      slot.pending = pending;
      activeDatasetHosts.add(pending);
      const ownedPending = pending;
      // The executor indexes dataset automations once the host is open.
      void pending.then(() => collectionAutomationsOf(workspace.workspaceId)?.datasetsChanged(), () => undefined);
      void pending.catch(() => { if (slot.pending === ownedPending) slot.pending = null; activeDatasetHosts.delete(ownedPending); });
    }
    const host = await stillHeld(slot, pending);
    signal.throwIfAborted(); operation.assertCurrent();
    return host;
  });
const chatWrites = createChatWrites({
  findWorkspace,
  warmCredentials: warmCredentialCache,
  currentCredentials: () => cachedCredentials,
  currentCredentialGeneration: () => credentialCacheGeneration,
  localUserDisplayName,
  agentDisplayName: async (agentId) => {
    const { settings } = await readCachedUserSettingsFile(stateDir());
    return (agentId ? listAgents(settings).find(({ id }) => id === agentId) : firstAgent(settings))?.name ?? "Agent";
  },
  agentIdsNamedIn: async (body) =>
    agentIdsNamedIn((await readCachedUserSettingsFile(stateDir())).settings, body),
  localInstallationId,
  projectChatBookmarks: (workspaceId) => void projectPendingChatBookmarks(workspaceId),
  queueCloudSync: (workspaceId) => activity.queueCloudSync(workspaceId),
  syncSharedChannelsForChatTarget,
  scanChatDispatch: (workspaceId) => chatDispatchService.scanWorkspace(workspaceId),
  betweenDispatchScans: (workspaceId, write) => chatDispatchService.betweenScans(workspaceId, write),
  notifyRenderer: (workspaceId) => notifyRenderer({ workspaceId }),
});

let ownerAppPublicationForCli: ((input: OwnerAppPublicationRequest, agent: import("@dohc/security-contract/approval-provenance").ApprovalAgent | null) => Promise<OwnerAppPublicationResult>) | undefined;
let ownerAppResponsesForCli:((input:import("@dohc/cli/app-responses").OwnerAppResponsesRequest)=>Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>)|undefined;
let ownerLiveStopAgainForCli: ((operation: DesktopWorkspaceOperation, kept: { path: string } & import("./ipc/relaySharesIpc").OwnerLiveStopAgain) => Promise<import("./ipc/bridgeContract").StopOwnerLiveDocumentResult>) | undefined;
const shareCopyReader = createShareCopyReader<RegistryEntry>({
  remoteForWorkspace, currentCredentialGeneration: () => credentialCacheGeneration,
  relayJson: (credentials, path) => relayShareJsonWithCredentials(credentials, path),
});
// The desktop window and the CLI delete the account through this one client.
// Afterwards this computer forgets every session of the deleted account, even
// one another window signed in with while deletion ran, and keeps another
// account's. Local workspaces stay.
const serverAccountDeletion = createServerAccountDeletion({
  credentials: loadAndCacheCurrentCredentials,
  workspaces: listWorkspaces,
  disconnect: async (deleted) => {
    if (cachedCredentials?.serverUrl !== deleted.serverUrl || cachedCredentials.userId !== deleted.userId) {
      try {
        await cloudLogin().invalidateAccount(deleted);
      } finally {
        notifyCloudSessionChanged("ready");
      }
      return;
    }
    await runCloudLogoutTransition({
      clearCachedCredentials: () => clearCachedCredentials(),
      logout: () => cloudLogin().invalidateAccount(deleted),
      stopEngines: () => activity.stopEngines(),
      closeRelayTransportWorkspaces: () => closeAllRelayTransportWorkspaces({ accountChanged: true }),
      notifyWorkspaceActivity: () => notifyRenderer(),
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
    });
  },
});

const documentProjection = createDocumentProjectionWorker();

const { startDesktopCliServer } = createDesktopCliServer({
  shareCopy: shareCopyReader,
  ownerLiveRecovery: {
    keptEdits: workspaceId => desktopEngine.ownerLiveQuarantines(workspaceId),
    save: (workspace, path, incident) => desktopEngine.saveOwnerLiveRecoveryCopy(workspace, path, incident),
    retry: (workspace, objectId, incident) => desktopEngine.retryOwnerLiveQuarantine(workspace, objectId, incident),
    stopAgain: (operation, kept) => {
      if (!ownerLiveStopAgainForCli) throw new Error("Live editing is not ready. Try again.");
      return ownerLiveStopAgainForCli(operation, kept);
    },
  },
  access: workspaceId => accessCliQueries(accessOwner, work => withPhysicalWorkspaceOperation(workspaceId, work)),
  recordSuccess: invocation => usageStore?.recordSuccess(invocation),
  serverAccount: serverAccountDeletion,
  dataset: (input, agent) => {
    if (!datasetForCli) throw new Error("Collections are not ready. Try again.");
    return datasetForCli(input, agent);
  },
  ownerAppPublication: (input, agent) => {
    if (!ownerAppPublicationForCli) throw new Error("App publication is not ready. Try again.");
    return ownerAppPublicationForCli(input, agent);
  },
  ownerAppResponses:input=>{
    if(!ownerAppResponsesForCli)throw new Error("App responses are not ready. Try again.");
    return ownerAppResponsesForCli(input);
  },
  // The executor calls the Automations panel's IPC makes. A CLI request
  // opened the workspace, and each call waits for its automations to load.
  automations: (workspace) => {
    const opened = async () => {
      const automations = collectionAutomationsOf(workspace.workspaceId);
      if (!automations) throw new Error("This workspace was closed. Open it again.");
      await automations.open();
      return automations;
    };
    return {
      list: collectionPath => withPhysicalWorkspaceOperation(workspace.workspaceId, operation => automationControlsFor(operation).list(collectionPath)),
      switch: (collectionPath, input) => withPhysicalWorkspaceOperation(workspace.workspaceId, operation => automationControlsFor(operation).switch(collectionPath, input)),
      automationIdAt: async (collectionPath, id) => (await opened()).automationIdAt(collectionPath, id),
      runs: async (automationId, before) => (await opened()).runs(automationId, before),
      run: async (automationId, claimId) => (await opened()).run(automationId, claimId),
      serverRuns: (automationId, before) => serverRuns.runs(workspace.workspaceId, automationId, before),
      serverRun: (automationId, claimId) => serverRuns.get(workspace.workspaceId, automationId, claimId),
      retry: (input) => retryAutomationRun({
        notices: noticeStore(),
        installId: localInstallationId(),
        holds: async (run) => (await (await opened()).run(run.automationId, run.claimId)) !== null,
        recovery: async (automationId) => (await opened()).switchedOffTarget(automationId),
        retry: async (run) => (await opened()).retry(run),
      }, { workspaceId: workspace.workspaceId, ...input }),
    };
  },
  // A press goes through the press path a window's press takes, under this
  // workspace's own operation. Internal dataset ids use the same authority
  // as renderer presses, and the executor opens before it is asked.
  buttons: (workspace) => ({
    inspect: async (input, by) => {
      if (!inspectNamedForCli || !describeDatasetForCli) throw new Error("Buttons are not ready. Try again.");
      const describe = describeDatasetForCli;
      return inspectNamedForCli(input, {
        by,
        withOperation: work => withPhysicalWorkspaceOperation(workspace.workspaceId, async operation => {
          if (!shareViewIsPresent(operation.workspace.shareView)) await operation.state.collectionAutomations.open();
          return work(operation);
        }),
        describeDataset: datasetId => describe(workspace.workspaceId, datasetId),
        watch: () => undefined,
      });
    },
    press: async (input, by) => {
      if (!pressNamedForCli || !describeDatasetForCli) throw new Error("Buttons are not ready. Try again.");
      const describe = describeDatasetForCli;
      let waiting: PressWaitReason | null = null;
      const result = await pressNamedForCli({ ...input, workspaceId: workspace.workspaceId }, {
        by,
        withOperation: (work) => withPhysicalWorkspaceOperation(workspace.workspaceId, async (operation) => {
          // A shared view runs no automations here; its presses go to the relay.
          if (!shareViewIsPresent(operation.workspace.shareView)) await operation.state.collectionAutomations.open();
          return await work(operation);
        }),
        describeDataset: (datasetId) => describe(workspace.workspaceId, datasetId),
        // No window hears how the run settles; the caller follows it in run history.
        watch: (_claimId, reason) => { waiting = reason; },
      });
      return { result, waiting };
    },
  }),
  links: workspaceLinks,
  chatLinks: (workspace, input) => workspaceChatLinks(workspace.workspaceId, input),
  chatFileMentions: (workspace, input) => workspaceChatFileMentions(workspace.workspaceId, input),
  findWorkspace,
  listWorkspaces,
  openWorkspaceActivity,
  stopWorkspaceSync: async (operation, author) => {
    const { status: _status, ...result } = await stopWorkspaceSync(operation, author);
    return { ok: true as const, ...result };
  },
  activity,
  linkedChatStoreFor,
  currentDaemon: () => desktopEngine.daemon,
  agentDispatchStoreHandleFor,
  sharedViewOf,
  withPhysicalWorkspaceOperation,
  collectionEditContextFor,
  localPerson,
  withEngineAdapter,
  // The sessions are created below; the CLI server reaches them only per request.
  liveDocuments: {
    readDocument: (input) => engineYDocSessionIpc.readDocument(input),
    editDocument: (input) => engineYDocSessionIpc.editDocument(input),
  },
  trashItem: (path) => shell.trashItem(path),
  markDeletedUnderPath: (attachmentId, path) => engineYDocSessionIpc.fileMutationPort().markDeletedUnderPath(attachmentId, path),
  documentProjection,
  chatWrites,
  startCliServer,
  stateDir,
  localUserDisplayName,
  localPersonId: localUserId,
  notifyRenderer,
  notifyNoticesChanged,
  // Created after the windows, so read when a version change runs.
  versionRound: (workspaceId, change, announce) => versionRounds.run(workspaceId, change, announce),
  syncSharedChannelsForChatTarget,
  chatDispatchService,
  rememberPendingCliRunMessageLink,
});

const engineYDocSessionIpc = createEngineYDocSessionIpc({
  localPersonId: localUserId,
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
    if (marker?.ended) throw new SharedDocumentWaitingError({ state: "access-ended", message: "Your access to this share ended." });
    if (!credentials?.relayUrl) throw new SharedDocumentWaitingError({ state: "failed", message: "dohc could not connect. Check your connection." });
    if (marker && !shareViewIdentityIsIntact(marker)) throw new SharedDocumentWaitingError({ state: "failed", message: SHARE_VIEW_REOPEN_MESSAGE });
    if (!marker || !marker.relayUrl || !relayUrlsMatch(marker.relayUrl, credentials.relayUrl) ||
      marker.grantedSelector?.access !== "edit" ||
      (marker.grantedSelector.versionId !== null && marker.grantedSelector.versionId !== "main")) {
      throw new SharedDocumentWaitingError({ state: "failed", message: "dohc could not open this document for editing. Check the share's Edit access." });
    }
    const identity = (value: ShareViewIdentity | undefined) => JSON.stringify({shareId: value?.shareId,
      recipientUserId: value?.recipientUserId, relayUrl: value?.relayUrl, selector: value?.grantedSelector, ended: value?.ended === true});
    const pinned = identity(marker);
    return createNamedDesktopLiveCapture({ shareId: marker.shareId, selector: marker.grantedSelector,
      accessEnded: () => findWorkspace(workspace.workspaceId)?.shareView?.ended === true,
      isOnline: () => net.isOnline(),
      recordDelivery: path => requireEngineSessions().run(workspace, async binding => {
        const statuses = await shareRecordStatuses(new WorkspaceDaemonRequester(binding.client), {
          workspaceId: workspace.workspaceId, shareId: marker.shareId, paths: [path], grantedSelector: {
            paths: marker.grantedSelector.paths, versionId: marker.grantedSelector.versionId, access: marker.grantedSelector.access,
          },
        }, { workspace: binding.workspace });
        return statuses[path] ?? null;
      }).catch(() => null),
      preserveDraft: async draft => { await preserveLiveDraft(join(stateDir(), "live-draft-recovery"), workspace.workspaceId, draft); },
      credentials: {relayUrl: credentials.relayUrl, token: credentials.token, userId: credentials.userId,
        signal: ownerDeliveryCredentialLifetime.signal},
      // The attachment, not the root's spelling: the registry keeps the root
      // as registered, and this workspace carries its canonical form.
      assertCurrent() {
        if (cachedCredentials?.token !== credentials.token || cachedCredentials?.userId !== credentials.userId ||
          cachedCredentials?.relayUrl !== credentials.relayUrl ||
          !workspaceAuthorities.isCurrentAttachment(workspace.workspaceId, workspace.attachmentId) ||
          identity(findWorkspace(workspace.workspaceId)?.shareView) !== pinned) {
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

// Auto-updates: packaged builds use electron-builder's baked app-update.yml
// feed by default; DOHC_UPDATE_URL is only an explicit mock/dev override.
// Failures are absorbed — updates must never take the app down. Starting
// twice returns the first start.
function startUpdates(): Promise<AutoUpdateController | null> {
  autoUpdateStartup ??= startAutoUpdates({
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
      return controller;
    })
    .catch(() => null);
  return autoUpdateStartup;
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

const { refreshDispatchTray, refreshTrayIcon, dispatchKeepsRunning, noticeRunningInBackground } = createDesktopTray<
  ReturnType<typeof nativeImage.createFromPath>,
  ReturnType<typeof Menu.buildFromTemplate>
>({
  app, process, Menu, nativeImage, nativeTheme, Tray, Notification, linuxTrayShown,
  hasWindow: () => BrowserWindow.getAllWindows().length !== 0,
  moduleDirectory: import.meta.dirname,
  readCachedUserSettingsFile, stateDir, chatDispatchService, showOrCreateMainWindow,
  runningSchedules: () => automationScheduler.runningSchedules(),
  get appLifecycle(): { isQuitting(): boolean } { return appLifecycle; },
});

const desktopEngine = createDesktopEngine({
  resourcesBasePath,
  onWorkspaceOpened: workspaceId => {
    const workspace = findWorkspace(workspaceId);
    // A window's reads that came before this open, such as its settings, read again.
    notifyRenderer({workspaceId});
    if (workspace) void withWorkspaceAttachment({workspaceId}, lease => recoverOutageTyping(canonicalWorkspaceFor(lease)));
    if (workspace && activity.engineCaptureFor(workspaceId)) withWorkspaceAttachment({workspaceId}, lease => {
      reconcileLocalCollectionApps(canonicalWorkspaceFor(lease));
      automationHosts.open(workspaceId);
      void lease.state.collectionAutomations.workspaceOpened();
    });
    if (workspace) void withPhysicalWorkspaceOperation(workspaceId, async operation => {
      resumeLinkRewrites(operation.workspace, operation.signal);
    }).catch(error => console.warn("[desktop] link rewrite recovery:", error));
    void noticeStore().refreshRefusals(workspaceId).catch(error => {
      console.warn("[notices] could not refresh workspace sync refusals after open", error);
    });
  },
  onRefusalsChanged: notifyNoticesChanged,
  ownerLiveReleases: createUnwrittenReleases(() => join(stateDir(), "owner-live-releases.json")),
  documentProjection,
  serverOwnerDelivery: createServerOwnerConnection({stateDir, workspaces: listWorkspaces,
    onRefusalsChanged: workspaceId => notifyRenderer({workspaceId}),
    credentials: () => cachedCredentials ? {value: cachedCredentials, signal: ownerDeliveryCredentialLifetime.signal} : null,
    fetch: (input, init) => relayShareFetch(input, init)}),
  notifyOwnerDeliveryChanged: workspaceId => notifyRenderer({workspaceId}),
  ownerDeliveryCredentials: () => cachedCredentials?.relayUrl ? {bearer: cachedCredentials.token, accountId: cachedCredentials.userId,
    relayUrl: cachedCredentials.relayUrl, signal: ownerDeliveryCredentialLifetime.signal} : null,
  existingOwnerFor: binding => engineYDocSessionIpc.existingOwner(binding),
  findWorkspace,
  app, dialog, process, createRustEngineDaemon, defaultEngineBinaryPath,
  isQuitting: (): boolean => appLifecycle.isQuitting(),
  recordEngineProblem: (error, stage) => recordCrash({ kind: "engine", error, stage }),
  workspaceAuthorities, notifyRenderer,
  collectionAutomations: { current: collectionAutomationsOf },
  noteWriteDeferred: (workspaceId, path) => activity.engineCaptureFor(workspaceId)?.noteWriteDeferred(path),
  launchMarks, desktopMarks, logLaunchMarksOnce,
  noteNoAtomicPlacement: (workspaceId) => {
    try {
      withWorkspaceActivityState(workspaceId, (lease) =>
        workspaceActivity.recordAtomicPlacementUnavailable(lease.state.activity),
      );
    } catch {
      // The workspace closed since the engine wrote; nothing to show.
    }
  },
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

function automationControlsFor(operation: DesktopWorkspaceOperation) {
  return createDesktopAutomationControls({ operation, files: createShareViewFilesForOperation(operation), sessions: requireEngineSessions,
    canSwitch: async (target, collectionPath) => {
      await warmCredentialCache();
      operation.assertCurrent();
      const credentials = cachedCredentials;
      if (!credentials?.relayUrl || target.relayUrl && !relayUrlsMatch(target.relayUrl, credentials.relayUrl)) {
        throw new Error("Sign in to the server that shared this Collection.");
      }
      const generation = credentialCacheGeneration;
      const canSwitch = await fetchShareAutomationSwitchable({ relay: { baseUrl: credentials.relayUrl, token: credentials.token },
        shareId: target.shareId!, collectionPath });
      operation.assertCurrent();
      if (generation !== credentialCacheGeneration) throw new Error("The shared file session changed.");
      return canSwitch;
    },
    edited: target => shareDirectWrites?.shareViewEdited(target.workspaceId),
  });
}

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
    updateMounts: async (workspaceId, update) => {
      if (workspaceId !== binding.workspaceId) {
        throw new Error("Share mount write targeted a different workspace.");
      }
      await updateWorkspaceShareMounts(workspaceId, update);
    },
    loadCredentials: () => loadAndCacheCurrentCredentials(),
    currentCredentialGeneration: () => credentialCacheGeneration,
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
    recheckRemovedShares,
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
          "This workspace was closed. Open it again.",
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
        ...(target.attachmentId ? { attachmentId: target.attachmentId } : {}),
      }),
    resolveRelay: async (target) => {
      await warmCredentialCache().catch(() => undefined);
      const credentials = cachedCredentials;
      if (target.kind === "standalone" && !target.recipientUserId) {
        throw new Error(SHARE_VIEW_REOPEN_MESSAGE);
      }
      if (!credentials?.relayUrl) {
        if (target.kind === "standalone") {
          throw new Error("Sign in to your server first.");
        }
        return null;
      }
      if (
        (target.relayUrl &&
          !relayUrlsMatch(credentials.relayUrl, target.relayUrl)) ||
        (target.kind === "standalone" && target.recipientUserId !== credentials.userId) ||
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
          ...(target.attachmentId ? { attachmentId: target.attachmentId } : {}),
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
          ? createShareSkipRecorder<ShareViewIdentity>({
              update: async (change) => {
                const view = currentWorkspace().shareView;
                if (!view) return;
                await setWorkspaceShareView(target.workspaceId, change(view));
              },
            })
          : createShareSkipRecorder<ShareMountRecord>({
              update: (change) =>
                updateWorkspaceShareMounts(target.workspaceId, (mounts) => {
                  assertCurrent();
                  return updateShareMountRecords(mounts, target.shareId, change);
                }),
            });
      await recorder([...refusals]);
    },
    updateUnsavedPaths: async (target, paths) => {
      assertCurrent();
      const view = currentWorkspace().shareView;
      if (target.kind !== "standalone" || !view) throw new Error("This shared view is no longer registered.");
      await setWorkspaceShareView(target.workspaceId, { ...view, unsavedPaths: paths });
      notifyRenderer({ workspaceId: target.workspaceId, summaryChanged: true });
    },
    markEnded: async (target, unsavedPaths, unconfirmedChanges) => {
      assertCurrent();
      if (target.kind === "standalone") {
        const view = currentWorkspace().shareView;
        if (!view) throw new Error("This shared view is no longer registered.");
        await setWorkspaceShareView(target.workspaceId, { ...view, ended: true,
          ...(unsavedPaths !== undefined ? { unsavedPaths } : {}),
          ...(unconfirmedChanges !== undefined ? { unconfirmedChanges } : {}) });
        notifyRenderer({ workspaceId: target.workspaceId, summaryChanged: true });
        return;
      }
      await updateWorkspaceShareMounts(target.workspaceId, (mounts) => {
        assertCurrent();
        return updateShareMountRecords(mounts, target.shareId, (mount) => ({ ...mount, ended: true }));
      });
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
  linksEdges: (target, input) => withShareViewFilesOperation(target, files => files.linksEdges(target, input)),
  linksIn: (target, input) => withShareViewFilesOperation(target, files => files.linksIn(target, input)),
  linksResolve: (target, input) => withShareViewFilesOperation(target, files => files.linksResolve(target, input)),
  narrow: (lease, target, assertCurrent, commit) =>
    withShareViewFilesOperation(target, files => files.narrow(lease, target, assertCurrent, commit)),
  end: (lease, target, assertCurrent) =>
    withShareViewFilesOperation(target, (files) => files.end(lease, target, assertCurrent)),
  mount: (lease, target) =>
    withShareViewFilesOperation(target, (files) => files.mount(lease, target)),
  change: (lease, target, change) =>
    withShareViewFilesOperation(target, (files) =>
      files.change(lease, target, change),
    ),
  read: (target, request) =>
    withShareViewFilesOperation(target, (files) => files.read(target, request)),
  lookup: (target, paths) =>
    withShareViewFilesOperation(target, files => files.lookup(target, paths)),
  list: (target, options) =>
    withShareViewFilesOperation(target, (files) => files.list(target, options)),
  projectionStatus: (target) =>
    withShareViewFilesOperation(target, (files) =>
      files.projectionStatus(target),
    ),
  reconcile: (lease, target, request, onCursorCommitted) =>
    withShareViewFilesOperation(target, (files) =>
      files.reconcile(lease, target, request, onCursorCommitted),
    ),
  unmount: (lease, target) =>
    withShareViewFilesOperation(target, (files) =>
      files.unmount(lease, target),
    ),
};
const workspaceFileMutations = createWorkspaceFileMutationOwner({
  historyFor: workspace => createOperationHistory(work => withEngineAdapter(workspace, work)),
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
          signal: operation.signal,
          capture: activity.engineCaptureFor(workspaceId, workspace.rootPath),
          yDocSessions: engineYDocSessionIpc.fileMutationPort(),
          assertCurrent: () => operation.assertCurrent(),
        });
      },
    ),
  shareViewFiles,
  trashItem: (path) => shell.trashItem(path),
  localPerson,
  notifyRenderer: (workspaceId) => notifyRenderer({ workspaceId }),
  shareViewEdited: (workspaceId) => shareDirectWrites?.shareViewEdited(workspaceId),
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

const rendererWorkspaceRetirement = createDesktopRendererWorkspaceRetirement<WebContents>({
  engineYDoc: engineYDocSessionIpc,
  sitePreviews,
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
});

const rendererWorkspaceSessions: RendererWorkspaceSessionOwner<WebContents> =
  new RendererWorkspaceSessionOwner<WebContents>({
    retirement: {
      ...rendererWorkspaceRetirement,
      retireSender: session => {
        const closingApps = appViews?.closeOwner(session.sender.id) ?? Promise.resolve();
        shareDirectWriteDelivery.retireSender(session.sender);
        const retiring = rendererWorkspaceRetirement.retireSender(session);
        return { ...retiring,
          requiredForAdmission: Promise.all([retiring.requiredForAdmission, closingApps]).then(() => {}),
        };
      },
    },
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

const folderAppDetection = createFolderAppDetection<Parameters<typeof ownedWorkspaceReadsFor>[0]>({
  sources: (workspace, folder) => withWorkspaceAttachmentAsync(workspace, async lease => {
    const current = canonicalWorkspaceFor(lease);
    const reader = createOwnedWorkspaceFileReader({ workspace: current, files: shareViewFiles });
    return readFolderAppWorkspaceSources(current.rootPath, folder, {
      reader,
      listOwned: async scope => (await listFiles(current.rootPath, scope)).files.map(file => file.path),
      listShare: (target, options) => shareViewFiles.list(target, options),
    });
  }),
  updated: (workspace, answer) => {
    withWorkspaceAttachment(workspace, () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || rendererWorkspaceSessions.current(window.webContents)?.workspaceId !== workspace.workspaceId) continue;
        window.webContents.send(CHANNELS.folderAppChanged, answer);
      }
    });
  },
  failed: error => console.error("[desktop] folder app recognition:", error),
});

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

// Main and the test runner share the OS monotonic clock, including across processes.
if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
  app.prependOnceListener("will-quit", () => {
    if (process.env.DOHC_TEST_QUIT_TIMING === "1") {
      console.log(`DOHC_TEST_WILL_QUIT:${process.hrtime.bigint()}`);
    }
  });
}

// A packaged macOS dohc outside Applications asks once, as a sheet on the
// first window, whether to move there. A decline is remembered in this file.
const MOVE_DECLINED_FILE = "move-to-applications-declined";

function runningBundlePath(): string {
  return resolve(process.execPath, "..", "..", "..");
}

// The version of the dohc of this bundle's name in Applications: null when
// there is none, and "" when it cannot be read.
function installedDohcVersion(): Promise<string | null> {
  return installedAppVersion(join("/Applications", basename(runningBundlePath())), {
    lstat,
    readVersion: (installed) => new Promise((done, fail) => {
      execFile("/usr/bin/plutil", [
        "-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(installed, "Contents", "Info.plist"),
      ], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => (error ? fail(error) : done(stdout)));
    }),
  });
}

// Every move, the first and each Try again, reads the dohc in Applications
// right before it. Electron then quits dohc and opens the moved copy.
function moveDohcToApplications(): Promise<void> {
  return guardedMoveToApplications({
    runningVersion: app.getVersion(),
    installedVersion: installedDohcVersion,
    move: () => {
      try {
        app.moveToApplicationsFolder();
      } catch (error) {
        console.error("[desktop] move to Applications:", error);
        const said = error instanceof Error ? error.message.trim() : "";
        const sentence = said === "" || /[.!?]$/u.test(said) ? said : `${said}.`;
        throw new Error([sentence, "Drag dohc into Applications in Finder to move it yourself."].filter(Boolean).join(" "), { cause: error });
      }
    },
  });
}

function offerMoveToApplicationsOn(window: BrowserWindow | undefined): void {
  if (process.platform !== "darwin" || !app.isPackaged || !window) return;
  const declinedFile = () => join(stateDir(), MOVE_DECLINED_FILE);
  const offer = () => void offerMoveToApplications({
    bundlePath: runningBundlePath(),
    runningVersion: app.getVersion(),
    isInApplicationsFolder: () => app.isInApplicationsFolder(),
    // Any entry there means declined; it is never followed.
    declined: () => lstatSync(declinedFile(), { throwIfNoEntry: false }) !== undefined,
    recordDecline: () => {
      try {
        writeFileSync(declinedFile(), "", { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          console.warn("[desktop] could not remember the declined move to Applications:", error);
        }
      }
    },
    installedVersion: installedDohcVersion,
    showMessageBox: (options) => showMessageBox(options, window),
    move: moveDohcToApplications,
    // A toast and a Notices row in the window, with Try again.
    reportMoveFailure: (error) => {
      const target = window.isDestroyed() ? liveWorkspaceWindow() : window;
      if (target) openPathFailures.reportMove(error, target.webContents);
    },
  }).catch((error: unknown) => console.error("[desktop] move to Applications:", error));
  if (window.isVisible()) offer();
  else window.once("show", offer);
}

// Files from other people open as marked copies in this run's folder.
const markedCopies = systemMarkedCopies(stateDir());

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
        currentRendererDocumentId: (sender) => rendererWorkspaceSessions.currentDocumentId(sender),
        prepareForRendererReload,
        afterRendererCrashLoop,
        preloadArguments,
      }),
    ),
    whenLoaded: (window) => new Promise<boolean>((resolve) => {
      const contents = window.webContents;
      const settle = (loaded: boolean) => {
        contents.off("did-finish-load", onLoad);
        contents.off("did-fail-load", onFail);
        resolve(loaded);
      };
      const onLoad = () => settle(true);
      const onFail = (_event: unknown, errorCode: number, _description: string, _url: string, isMainFrame: boolean) => {
        // ERR_ABORTED (-3) is a load that another navigation replaced; that
        // one still finishes or fails on its own.
        if (isMainFrame && errorCode !== -3) settle(false);
      };
      contents.on("did-finish-load", onLoad);
      contents.on("did-fail-load", onFail);
    }),
    openFailureTarget: (window) => captureOpenPathFailureTarget(window, {
      isLive: () => desktopWindows.showsNotices(window),
      currentSession: () => rendererWorkspaceSessions.current(window.webContents),
      admittedCount: () => rendererWorkspaceSessions.admittedCount(window.webContents),
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
    recordOpenFailure: recordOpenPathFailure,
    reportOpenFailure: (path, error, window) => openPathFailures.report(path, error, window.webContents),
    refreshNativeSurfaces: refreshNativeWorkspaceSurfaces,
  },
  bootstrap: {
    markReady: () => {
      launchMarks.appReady();
      desktopMarks.markOnce("app-ready");
      void removeEarlierMarkedCopies(markedCopies);
      // Start retention even when Off. Never wait for measurement on startup.
      usageLoad = setImmediate(() => {
        usageLoad = undefined;
        try {
          usageStore = createUsageStore({ stateDir, appVersion: app.getVersion(), coverage: DESKTOP_USAGE_COVERAGE,
            onStop: usageRecordStopped });
        } catch {
          usageStore = undefined;
          return;
        }
        void usageStore.load().catch(() => {});
      });
    },
    startEngine: () => desktopEngine.start(),
    loadSettings: () => readCachedUserSettingsFile(stateDir()),
    applySettings: ({ settings }) => {
      cachedPreferredName = settings.profile.preferredName;
      cachedAgents = listAgents(settings);
      desktopWindows.seedZoomLevel(settings.appearance.zoomLevel);
      applyThemeMode(settings.appearance.themeMode);
      session.defaultSession.setSpellCheckerEnabled(settings.editor.spellcheck);
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
      nativeTheme.on("updated", refreshTrayIcon);
      // A backoff can outlast a sleep. On wake, try each failing sync now.
      powerMonitor.on("resume", () => activity.retryFailingCloudSyncs());
      for (const workspace of listWorkspaces()) {
        if (workspace.remote === undefined && workspace.shareView === undefined) continue;
        void recordSyncedIfNeeded(workspace).catch((error: unknown) =>
          console.warn(`[desktop] Could not record that workspace "${workspace.workspaceId}" synced:`, error));
      }
      void watchRecordedSchedules().catch((error: unknown) =>
        console.warn("[desktop] Schedules: read the recorded schedules:", error));
      resumeRunNow();
      void automationWakeConsumer.resume();
      app.on("browser-window-focus", () => { resumeRunNow(); void automationWakeConsumer.resume(); });
      powerMonitor.on("resume", () => void automationWakeConsumer.resume());
      powerMonitor.on("suspend", () => automationScheduler.suspended());
      powerMonitor.on("resume", () => automationScheduler.resumed());
      powerMonitor.on("unlock-screen", () => automationScheduler.wake());
      if (process.platform === "win32") {
        app.on("browser-window-created", (_event, window) => {
          window.hookWindowMessage(WM_TIMECHANGE, () => automationScheduler.wake());
        });
      }
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
      offerMoveToApplicationsOn(liveWorkspaceWindow());
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
    dispatch: {
      start: () => void loginShellPathRead.then(() => {
        if (!appLifecycle.isQuitting()) chatDispatchService.start();
      }),
      stop: () => chatDispatchService.stop(),
    },
    refreshTray: refreshDispatchTray,
    releaseIdleWorkspaces,
    noticeRunningInBackground,
    reportTrayFailure: (error) => console.error("[desktop] dispatch tray:", error),
    warmCredentials: warmCredentialCache,
    reconcileCloud: () => { activity.reconcileCloud(); },
    startUpdates: () => { void startUpdates(); },
    updateAfterStartupFailure: () => updateAfterFailure("startup"),
    updateAfterWindowLoadFailure: () => updateAfterFailure("window-load"),
  },
  launch: { finished: finishLaunch, settled: () => desktopEngine.launchSettled() },
  beforeQuit: beforeQuitWithTypingRecovery,
  beforeQuitWithoutWindows: beforeQuitWithTypingRecovery,
  shutdown: {
    budgetMs: WILL_QUIT_BUDGET_MS,
    deadlineExitCode: resolveShutdownDeadlineExitCode({
      desktopTest: process.env.DOHC_DESKTOP_TEST,
      isPackaged: app.isPackaged,
    }),
    beginEngineShutdown: () => {
      automationScheduler.dispose();
      for (const workspaceId of workspaceAuthorities.workspaceIds()) {
        activity.engineCaptureFor(workspaceId)?.beginShutdown();
      }
      desktopEngine.sessions?.beginShutdown();
      desktopChatBookmarks.stop();
    },
    stopNoticeRefusals: () => noticeStore().stopWorkspaceRefusals(),
    stopAutomationWakes: () => automationWakeConsumer.stop(),
    stopSearch: () => workspaceSearchOwner.dispose(),
    stopSitePreviews: stopAllSitePreviews,
    removeMarkedCopies: () => removeMarkedCopies(markedCopies),
    settleYDocs: async () => {
      await settleYDocsAfterFileObservation(
      [flushTypingCheckpoints(), ...workspaceAuthorities.workspaceIds().map(workspaceId =>
        workspaceAuthorities.withAuthority(workspaceId, lease => workspaceActivity.drainObservations(lease.state.activity)))],
      closeAllEngineYDocSessions,
      );
    },
    stopAgentIntegration: () => agentIntegration.stopAll(),
    flushReports: () => telemetry.flush(),
    closeWorkspaces: async () => {
      await workspaceAuthorities.close();
      await Promise.allSettled([...activeDatasetHosts].map(async pending => (await pending).close()));
      activeDatasetHosts.clear();
      await ownerDatasetCopies.closeAll();
      await namedDatasetPages.close();
    },
    disposeDatabase: async () => {
      if (usageLoad) clearImmediate(usageLoad);
      await usageStore?.close().catch(() => {});
      await workspaceFilesWorker.dispose();
      await workspaceDatabaseWorker.dispose();
    },
    closeRelay: closeAllRelayTransportWorkspaces,
    stopEngine: async () => { await desktopEngine.daemon?.stop(); },
    // The process exits right after this line, so it is written synchronously.
    reportQuit: (line) => { try { writeSync(1, `${line}\n`); } catch { /* No stdout to report to. */ } },
  },
});

const workspaceRootApproval = createWorkspaceRootApproval(effectiveHome);

// A file opened from outside dohc goes to its window once the renderer there
// shows the file's workspace.
const workspaceFileOpens = createWorkspaceFileOpens<WebContents, WorkspaceSummary>({
  shownWorkspaceId: (contents) => rendererWorkspaceSessions.current(contents)?.workspaceId,
  send: (contents, workspace, file) => {
    if (!contents.isDestroyed()) contents.send(CHANNELS.workspaceActivated, { ...workspace, file });
  },
});

// Opens a file or folder the OS or a launch handed dohc: its workspace, and
// the file in a tab. A folder that is not yet a registered workspace becomes
// one only when the person agrees.
const openPathOpener = createOpenPathOpener<WorkspaceSummary, BrowserWindow>({
  workspaces: workspaceSummaries,
  home: effectiveHome,
  platform: process.platform,
  fs: {
    realPath: (path) => {
      try {
        return realpathSync.native(path);
      } catch {
        return null;
      }
    },
    kindOf: (path) => {
      const stats = statSync(path, { throwIfNoEntry: false });
      return stats?.isFile() ? "file" : stats?.isDirectory() ? "folder" : null;
    },
    hasManifest: (folder) => existsSync(join(folder, ".dohc", "manifest.json")),
  },
  confirm: (folder, window) => {
    const parent = window ?? liveWorkspaceWindow();
    return confirmOpenPathWorkspace({
      showMessageBox: (options) => showMessageBox(options, parent),
    }, folder);
  },
  register: async (rootPath) => {
    const created = await createWorkspaceFolder({ rootPath, homeDir: effectiveHome(), kind: "personal", computer: thisComputer() });
    const workspace = WorkspaceSummary.parse(created);
    registerPhysicalWorkspace(created);
    return workspace;
  },
  activate: async (workspace, file, window) => {
    const shown = await sendWorkspaceActivated(window, workspace);
    if (file !== null) workspaceFileOpens.request(shown.webContents, workspace, file);
    refreshNativeWorkspaceSurfaces();
  },
});

// Null means nothing opened.
function openWorkspacePath(path: string, window?: BrowserWindow): Promise<WorkspaceSummary | null> {
  return openPathOpener(path, window);
}

function recordOpenPathFailure(path: string, error: unknown): void {
  console.error(`[desktop] could not open launch path ${path}:`, error);
}

// The window's renderer turns each failure into a toast and a Notices row.
const openPathFailures = createOpenPathFailures<WebContents>({
  workspaceIdOf: (contents) => rendererWorkspaceSessions.current(contents)?.workspaceId ?? null,
  notify: (contents) => contents.send(CHANNELS.workspacePathOpenFailed),
  moveAgain: moveDohcToApplications,
  reopen: async (path, contents) => {
    if (await openWorkspacePath(path, BrowserWindow.fromWebContents(contents) ?? undefined)) return;
    // The person chose Cancel, or nothing opens there now. Stat's own error
    // says why, such as ENOENT.
    const stats = statSync(path);
    if (!stats.isFile() && !stats.isDirectory()) throw new Error("dohc can open only a file or a folder.");
  },
  record: recordOpenPathFailure,
});

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

// Every invoke handler registers here. Electron sends a rejected handler's
// error to the renderer as one string, so this keeps its code in that string.
// A handler that answers finished its action, which a usage report may count.
function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const result: unknown = await listener(event, ...args);
      const counted = usageEventFor(channel, result);
      if (counted) telemetry.track(counted);
      return result;
    } catch (error) {
      throw ipcWireError(withPrivacyDenial(error));
    }
  });
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
  handle: handleIpc,
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
  participants: () => workspaceWindows.answering(),
  participantId: (window) => window.webContents.id,
  send: (window, message) => {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.exitRound, message);
  },
  confirmProceed: async (kind: ExitKind) => {
    const verb = kind === "quit" ? "Quitting" : "Installing";
    const { response } = await showMessageBox({
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

// Version rounds: before the CLI or MCP changes a workspace's versions, the
// workspace windows showing it save their open edits (versionRounds.ts).
const versionRounds = createVersionRounds<BrowserWindow>({
  windowsShowing: (workspaceId) => desktopWindows.workspaceWindows.answering()
    .filter((window) => rendererWorkspaceSessions.current(window.webContents)?.workspaceId === workspaceId),
  windowId: (window) => window.webContents.id,
  isGone: (window) => window.isDestroyed() || window.webContents.isCrashed(),
  send: (window, message) => {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.versionRound, message);
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

const installUpdate = createUpdateInstall<BrowserWindow>({
  currentUpdateState, exitRounds, quitGuard,
  get autoUpdateController() { return autoUpdateController; },
});

// A failing build checks the feed before it gives up, so a person on a bad
// release can still reach the release that fixes it.
const updateAfterFailure = createUpdateAfterFailure({
  controller: startUpdates,
  confirmDownload: (failure, version) => confirmDownloadDialog({ showMessageBox }, failure, version),
  showDownloading: (failure, version, signal) => showDownloadingDialog({ showMessageBox }, failure, version, signal),
  confirmRestart: (failure, version) => confirmRestartDialog({ showMessageBox }, failure, version),
  install: installUpdate,
});

function afterRendererCrashLoop(): void {
  void updateAfterFailure("window-crash");
}

// macOS draws dohc's menus, dialogs, and window background in the theme the
// user chose; "system" follows the OS.
function applyThemeMode(themeMode: ThemeMode): void {
  if (process.platform === "darwin") nativeTheme.themeSource = themeMode;
}

// The owner of the user settings file: every save, zoom step, reset, and
// edit made in the file goes through it and takes effect there.
const settingsIpc = createSettingsIpc<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
  stateDir,
  setCachedNames: (preferredName, agents) => { cachedPreferredName = preferredName; cachedAgents = agents; },
  applyZoomLevelToWindows, applyThemeMode, refreshDispatchTray, openDispatchWorkspaces,
  setSpellCheckerEnabled: (enabled) => session.defaultSession.setSpellCheckerEnabled(enabled),
  chatDispatchService, withRendererWorkspaceOperation, notifyRenderer,
  broadcastAgentColor,
  broadcastUserSettings: (settings) => {
    // Reports follow the switches before any window learns of them.
    telemetry.setPrivacy(privacyInEffect(settings));
    broadcastUserSettings(settings);
    void automationWakeConsumer.resume();
  },
  openPath: (path) => shell.openPath(path),
  knownWorkspaceIds: () => workspaceSummaries().map((workspace) => workspace.workspaceId),
});

async function currentDiagnostics(): Promise<string> {
  return diagnosticsText({
    facts: crashFacts(),
    available: telemetry.available,
    privacy: privacyInEffect(await readCachedUserSettingsFile(stateDir())),
    crashReport: crashReports.read().report?.text ?? null,
  });
}

function pauseStatus(pause: WorkspaceSyncPause) {
  return workspaceSyncPauseStatus(pause, localInstallationId());
}

const syncPauseReopen: SyncPauseReopen = {
  closeActivity: workspaceId => activity.close(workspaceId, { notify: false, preserveAgentRun: true }),
  closeRelay: workspace => closeRelayTransportWorkspace(workspace),
  openActivity: workspace => activity.open(workspace),
  collectionsWaiting: workspace => activity.readCollectionsWaiting(workspace),
  notify: workspaceId => notifyRenderer({ workspaceId }),
};

const stopWorkspaceSync = createWorkspaceSyncStop({
  ...syncPauseReopen,
  person: async () => ({ kind: "person", personId: localInstallationId() }),
  pauseStatus,
  withOwnerHostPaused: work => desktopEngine.withOwnerHostPaused(work),
  prepare: workspace => activity.prepareSyncPause(workspace),
  resume: workspace => activity.enableCloud(workspace),
  pauseRemote: pauseWorkspaceRemote,
  status: workspaceId => activity.getStatus(workspaceId),
  cleanupFailed: (workspaceId, error) => console.error("[desktop] sync pause cleanup:", workspaceId, error),
  reopenFailed: workspace => activity.recordSyncPauseReopenFailed(workspace.workspaceId),
});

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
  openWorkspaceActivity, receivedShareEngine, resolveEngineFiles, readOwnedWorkspaceText,
});

const workspaceChatFileMentions = createChatFileMentionsReader({
  requireChatScope: chatScope.requireChatScope, syncWorkspaceSharedChannels, readWorkspace: findWorkspace,
  principalGeneration: () => credentialCacheGeneration,
});

const workspaceChatLinks = createChatLinksReader({
  requireChatScope: chatScope.requireChatScope, syncWorkspaceSharedChannels, readWorkspace: findWorkspace,
  principalGeneration: () => credentialCacheGeneration,
  currentAttachment: id => workspaceAuthorities.currentBinding(id).attachmentId,
  resolveEngineFiles,
  presentationRequest: async (scope, check) => {
    await warmCredentialCache();
    check();
    const agentColors = await agentColorsForPresentation(stateDir());
    check();
    return createActorPresentationRequest({
      agentColors, store: scope.store, readWorkspace: () => findWorkspace(scope.workspace.workspaceId),
      assertCurrent: check, installationId: localInstallationId(), credentials: cachedCredentials,
    });
  },
});

function registerIpcHandlers(): void {
  registerWorkspaceFolderNameIpc(operationBoundary, workspaceRootApproval.usableRoot);
  registerSystemMotionIpc(operationBoundary, () => systemPreferences.getAnimationSettings());
  registerSystemPrivacySettingsIpc(operationBoundary, process.platform, (url) => shell.openExternal(url));
  registerServerAccountIpc(operationBoundary, serverAccountDeletion);
  shareDirectWriteDelivery.register(operationBoundary);
  const shareCopyHandler = createShareCopyHandler<WebContents, RegistryEntry, DesktopRendererWorkspaceOperation>({
    currentSession: sender => rendererWorkspaceSessions.current(sender) ?? null,
    withRendererWorkspaceOperation, remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    relayJson: (credentials, path) => relayShareJsonWithCredentials(credentials, path),
  });
  registerOperations(operationBoundary, linksOperations, {
    linksEdges: ({ workspaceId: _workspaceId, ...input }, { operation }) => workspaceLinks.edges(operation.workspace, input),
    linksIn: ({ workspaceId: _workspaceId, ...input }, { operation }) => workspaceLinks.incoming(operation.workspace, input),
    linksResolve: ({ workspaceId: _workspaceId, ...input }, { operation }) => workspaceLinks.resolve(operation.workspace, input),
  });
  registerOperations(operationBoundary, shareCopyOperations, {
    getShareCopyDetails: (input, { event }) => shareCopyHandler(event.sender, input),
  });
  registerOperations(operationBoundary, accessOperations, {
    getObjectAccess: (input, { operation }) => accessOwner.object(operation!, input),
    listSharingAccess: (input, { operation }) => accessOwner.sharing(operation!, input),
    requestAccessRefresh: async (_input, { operation }) => { await accessOwner.refresh(operation!); },
  });
  const windowIpc = createWindowIpc<WebContents, IpcMainInvokeEvent, IpcMainEvent>({
    registerHandler: handleIpc,
    registerEvent: (channel, handler) => ipcMain.on(channel, handler),
    assertTrustedSender, prepareForRendererReload, shell, BrowserWindow,
    rememberChromeTheme, titleBarOverlayOptions,
    stepWindowZoom: (step) => settingsIpc.stepWindowZoom(step), exitRounds, versionRounds,
    quitGuard, isTrustedFrame, launchMarks, desktopMarks, logLaunchMarksOnce, app,
  });
  windowIpc.registerReload();

  const { usableRoot } = workspaceRootApproval;
  registerWorkspaceRegistryIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: handleIpc,
    assertTrustedSender,
    app,
    dialog,
    roots: workspaceRootApproval,
    effectiveHome,
    workspaceSummaries,
    prioritizePreferredWorkspace: (workspaces, event) =>
      prioritizePreferredWorkspace(workspaces, event.sender),
    thisComputer,
    createWorkspaceFolder: createWorkspaceFolderWithFreshness,
    forgetWorkspace,
    trustNewWorkspace: (workspace, fresh) => workspaceTrust.trust(workspace, fresh),
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
    registerHandler: handleIpc,
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
    app,
    dialog,
    shell,
    markedCopies,
    withRendererWorkspaceOperation,
    exactRendererWorkspaceReferences,
    workspaceFileListings,
    lookupOwnedWorkspaceFilesFor,
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
  registerOperations(operationBoundary, workspaceFileOperations, workspaceFilesIpc);

  const historyScopeIds = new WeakMap<object, string>();
  const workspaceEngineIpc = createWorkspaceEngineIpc<
    WebContents,
    IpcMainInvokeEvent,
    RegistryEntry,
    DesktopWorkspaceAuthorityState,
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, receivedShareEngine,
    withEngineAdapter, requireEngineCapture, readWorkspaceEnginePolicy, readSyncHistory, agentName: (agentId) => cachedAgents.find(({ id }) => id === agentId)?.name, localPersonId: localUserId,
    localPersonName: localUserDisplayName, localPerson,
    stateDir, localInstallationId, warmCredentialCache, currentCredentials: () => cachedCredentials,
    historyCollections: async operation => {
      const { workspace } = operation;
      const authority = await collectionsAuthorityFor(workspace, operation.signal);
      operation.assertCurrent();
      const generation = credentialCacheGeneration;
      let remoteReady: ReturnType<typeof remoteForWorkspace> | undefined;
      let scope = historyScopeIds.get(operation.state);
      if (!scope) { scope = randomUUID(); historyScopeIds.set(operation.state, scope); }
      const remote = (dataFor: (signal: AbortSignal, current: () => void) => OwnerDatasetData) => createHistoryCollectionRemote({
        expected: operation, generation, currentGeneration: () => credentialCacheGeneration,
        withOperation: work => withPhysicalWorkspaceOperation(workspace.workspaceId, work), dataFor });
      if (authority.kind === "server") {
        const { server } = authority, assertCurrent = () => operation.assertCurrent();
        return { scope: JSON.stringify([scope, generation]), local: serverHistorySources(server.data(operation.signal, assertCurrent), assertCurrent),
          remote: remote((signal, current) => server.data(signal, current)) };
      }
      const { local } = authority;
      return {
        scope: JSON.stringify([scope, generation]),
        local: (positions, limit, sourceIds) => local.historyHeads({ positions, limit, sourceIds }),
        remote: remote((signal, current) => createDatasetAuthorityRouter(local, {
          status: async id => { current(); return finishedTransferOf(workspace, local, id, signal); },
          remote: async targetOrigin => {
            const remote = await (remoteReady ??= remoteForWorkspace(workspace)); current();
            if (!remote.credentials.relayUrl || new URL(remote.credentials.relayUrl).origin !== targetOrigin) throw new Error("Collection host unavailable.");
            return createRemoteDatasetData({ workspaceId: workspace.workspaceId, ...remote, signal,
              currentCredentialGeneration: () => credentialCacheGeneration, assertCurrent: current, relayJson: relayShareJsonWithCredentials });
          },
        })),
      };
    },
    recordHistoryPersonName:(workspaceId, userId, sender) => {
      const workspace = findWorkspace(workspaceId);
      if (!recordHistoryPersonIsNamed(userId, workspace?.remote?.ownerUserId ?? localUserId())) return null;
      return historyLabelsFor(sender).person(workspaceId, userId);
    },
    prepareRecordHistoryPeople: (workspaceId, userIds, sender) => {
      const workspace = findWorkspace(workspaceId);
      const ownerId = workspace?.remote?.ownerUserId ?? localUserId();
      historyLabelsFor(sender).prepare(workspaceId, userIds.filter(userId => recordHistoryPersonIsNamed(userId, ownerId)).map(userId => ({ userId })));
    },
    namedAuthorLabels: (workspaceId, sender) => {
      const historyLabels = historyLabelsFor(sender);
      return {
        prepare: authors => {
          const named = authors.filter(author => author.kind === "named");
          if (named.length === 0) return;
          historyLabels.prepare(workspaceId, named);
        },
        named: author => historyLabels.author(workspaceId, author),
      };
    },
    automationAuthor, notifyRenderer,
    recordHeldFiles: (workspace, files) => withWorkspaceActivityState(workspace.workspaceId, lease => {
      const current = canonicalWorkspaceFor(lease);
      if (current.attachmentId !== workspace.attachmentId) return;
      workspaceActivity.recordHeldFiles(current, lease.state.activity, files);
    }),
    // A shared view keeps no runs: its automations run on the owner's computer.
    signedInAccount: () => cachedCredentials?.userId ?? null,
    automationRunOnThisComputer: async (workspaceId, automationId, claimId) =>
      !sharedViewOf(workspaceId) && (await collectionAutomationsOf(workspaceId)?.hasRun(automationId, claimId) ?? false),
    serverRuns,
    assertWritableWorkspace, syncStatusWithOwnedProjection, activity,
    retryOwnerLiveDelivery: workspaceId => desktopEngine.retryOwnerDelivery(workspaceId),
    retryCloudSync: (workspaceId, reason) => activity.retryCloudSync(workspaceId, reason),
    retryFileObservation: workspaceId => activity.retryFileObservation(workspaceId),
    workspaceAuthorities, canonicalWorkspaceFor, requireEngineSessions, isOnline: () => net.isOnline(),
    closeDispatchRunActivity, probeEngineStoreRefusal, moveEngineStoreAside,
    openWorkspaceActivityUnderEngineStoreLock, engineYDocSessionIpc,
  });
  workspaceEngineIpc.registerCollections();

  registerNativeMenusIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >({
    registerHandler: handleIpc,
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

  registerWorkspaceHeadingsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation>({
    registerHandler: handleIpc, assertTrustedSender, withRendererWorkspaceOperation, readOwnedWorkspaceTextFor,
  });

  windowIpc.registerExternalUrl();

  registerOperations(operationBoundary, shareHandoffOperations, createShareHandoffIpcHandlers({
    shareHandoffRedemption,
  }));

  registerCloudIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: handleIpc,
    assertTrustedSender, cloudLogin, clearCachedCredentials, refreshCredentialCache,
    warmCredentialCache, currentCredentials: () => cachedCredentials, localInstallationId,
    loadAndCacheCurrentCredentials, closeAllRelayTransportWorkspaces, activity,
    currentWorkspaceId: sender => rendererWorkspaceSessions.current(sender)?.workspaceId ?? null,
    stopWorkspaceSync, syncPauseFor: workspace => syncPauseFor(workspace, localInstallationId()),
    reconcileCloud: () => activity.reconcileCloud(),
    notifyCloudSessionChanged, notifyCloudSessionChangedWithKey,
    notifyRenderer, findWorkspace,
    engineDaemonStartup: () => desktopEngine.startup,
    requireEngineSessions, currentEngineSessions: () => desktopEngine.sessions,
    withRendererWorkspaceOperation, receivedShareEngine,
    readWorkspaceSecretState, readWorkspaceDataKeyForEnrollment, assertWritableWorkspace,
    relayClientForWorkspace, enrollWorkspaceKeyEnvelope, installWorkspaceDataKey,
    setWorkspaceRemote: async (workspaceId, remote) => {
      await setWorkspaceRemote(workspaceId, remote);
      retryStopAndRestoreReleases?.();
    }, usableRoot, readdir, mkdir, probeRelayWorkspace,
    createJoinedWorkspace, bootstrapJoinedWorkspace, refreshNativeWorkspaceSurfaces,
    openWorkspaceActivity, completeWorkspaceJoinBootstrap, desktopMarks,
  });

  // The window's Stop and Resume, and an agent's Stop again, use these alike.
  const ownerLiveDocumentDependencies: OwnerLiveDocumentActionDependencies<DesktopWorkspaceOperation["workspace"]> = {
    remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    relayShareJsonWithCredentials,
    pushRecorded: activity.pushRecorded,
    ownerLiveStop: async (workspace,action,path,binding,acceptedCursor) => {
      let result: Awaited<ReturnType<EngineClient["ownerYDocStopRequest"]>> | undefined;
      try {
        result=await requireEngineSessions().run(workspace,async session => {
          const client=desktopEngine.daemon?.currentClient();
          if (!(client instanceof EngineClient)) throw new Error("dohc could not change live editing. Restart dohc and try again.");
          const request={id:0,workspace:session.workspace,deadlineMs:30_000};
          if (action==="request") {
            if (!binding || "lineageClaimId" in binding) throw new TypeError("A Stop request names its document.");
            return client.ownerYDocStopRequest(request,binding);
          }
          if (action==="retired") {await client.ownerYDocStopRetired(request,binding!);return undefined;}
          return undefined;
        });
        if (action==="release" && binding && "lineageClaimId" in binding) result=await desktopEngine.releaseOwnerLiveStop(workspace,binding,acceptedCursor!);
        if (action==="clear") {
          if (!binding || "lineageClaimId" in binding) throw new TypeError("A Resume names its document.");
          await desktopEngine.clearOwnerLiveStop(workspace,binding);
        }
      } finally {
        // Each step of a Stop, failed or not, and a Resume change which refused
        // queues remain and how: a requested Stop shows as waiting at once.
        await desktopEngine.refreshOwnerLiveQuarantines(workspace)
          .catch(error => console.error("[desktop] owner live quarantine read failed:",error));
      }
      if ((result?.state==="released" && !result.retirementOwed) || action==="retired") {
        desktopEngine.clearOwnerLiveStopFailure(workspace.workspaceId,{objectId:result?.document.objectId ?? binding!.objectId});
      } else if (action==="clear") desktopEngine.clearOwnerLiveStopFailure(workspace.workspaceId,{objectId:binding!.objectId});
      desktopEngine.retryOwnerDelivery(workspace.workspaceId);
      return result;
    },
    liveDocument: async (workspace,target) => {
      const resolved=await withEngineAdapter(workspace,adapter => adapter.resolveFiles({workspaceId:workspace.workspaceId,targets:[target]}));
      if (!resolved) throw new Error("dohc could not change live editing. Restart dohc and try again.");
      const [file]=resolved.results;
      return file?.status==="found" ? {mainVersionId:resolved.versionId,objectId:file.objectId,currentPath:file.path} : null;
    },
    withoutEditors: (workspace,path,change) => engineYDocSessionIpc.withLiveEditingChange(workspace.attachmentId,path,change),
    ownerLiveQuarantines: workspace => desktopEngine.ownerLiveQuarantines(workspace.workspaceId),
    unwrittenOwnerLiveReleases: workspace => desktopEngine.unwrittenOwnerLiveReleases(workspace.workspaceId),
    retryOwnerLiveRelease: (workspace,objectId) => desktopEngine.retryOwnerLiveRelease(workspace,objectId),
    listOwnerLiveStops: workspace => requireEngineSessions().run(workspace, async session => {
      const client = desktopEngine.daemon?.currentClient();
      if (!(client instanceof EngineClient)) throw new Error("dohc could not read live editing. Restart dohc and try again.");
      return client.ownerYDocStopList({id:0,workspace:session.workspace,deadlineMs:30_000});
    }),
  };
  const agentOwnerLiveDocuments = createOwnerLiveDocumentActions<DesktopWorkspaceOperation["workspace"], DesktopWorkspaceOperation>(ownerLiveDocumentDependencies);
  ownerLiveStopAgainForCli = (operation, kept) => agentOwnerLiveDocuments.stop(
    {workspaceId: operation.workspace.workspaceId, path: kept.path, again: kept}, operation);
  const relayShareHandlers = createRelaySharesIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation
  >({
    ...ownerLiveDocumentDependencies,
    currentCredentials: () => cachedCredentials,
    warmCredentialCache,
    relayShareJson,
    relayShareErrorCopy,
    relayShareDiscussionActivityPolls,
    retryOwnerLiveQuarantine: (workspace,objectId,incident) => desktopEngine.retryOwnerLiveQuarantine(workspace,objectId,incident),
    saveOwnerLiveRecoveryCopy: (workspace,path,incident) => desktopEngine.saveOwnerLiveRecoveryCopy(workspace,path,incident),
    sharesChanged: (workspaceId) => { receivedShareAcquisition.invalidate(); invalidateHistoryLabels(workspaceId); shareRosters.sharesChanged(workspaceId); },
    reconcileReceivedShares,
  });
  registerOperations(operationBoundary, relayShareOperations, relayShareHandlers);

  let installedAppCompiler: ReturnType<typeof createInstalledAppCompiler> | undefined;
  const ownerPublicationDependencies = {
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    flushCapture: async workspace => {
      await openWorkspaceActivity(workspace);
      const capture = activity.engineCaptureFor(workspace.workspaceId, workspace.rootPath);
      if (!capture) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      // Flush covers only edits the watcher has reported. Reconcile scans the
      // disk, so an edit saved just before Prepare is in the review.
      if (!await withEngineAdapter(workspace, adapter => adapter.reconcileCapture())) {
        throw new Error("dohc could not capture this app. Restart dohc and try again.");
      }
      await capture.flush();
      const result = await withEngineAdapter(workspace, adapter => adapter.flushCapture());
      if (!result) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      return result;
    },
    withAdapter: withEngineAdapter,
    compile: async (request, signal) => {
      installedAppCompiler ??= createInstalledAppCompiler(resourcesBasePath());
      const compile = await installedAppCompiler;
      signal.throwIfAborted();
      return compile(request, { timeoutMs: 60_000, maxMemoryBytes: 1024 * 1024 * 1024, maxProcesses: 8,
        maxInputBytes: 192 * 1024 * 1024, maxOutputBytes: 48 * 1024 * 1024, maxErrorBytes: 64 * 1024 }, signal);
    },
    relayJson: relayShareJsonWithCredentials,
    relayJsonOrUnavailable: (credentials, path, init) => relayShareJsonWithCredentials<unknown>(credentials, path, init, { retainUnavailable: true }),
    upload: async (credentials, workspaceId, sha256, bytes, signal) => {
      const result = await relayShareJsonWithCredentials<{ workspaceId: string; sha256: string; byteLength: number }>(credentials,
        `/sync/${encodeURIComponent(workspaceId)}/blobs/${sha256}`, { method: "PUT", signal, body: Uint8Array.from(bytes).buffer,
          headers: { "content-type": "application/octet-stream" } });
      if (result.workspaceId !== workspaceId || result.sha256 !== sha256 || result.byteLength !== bytes.byteLength) throw new Error("The uploaded app bundle does not match. Try publishing again.");
    },
  } satisfies Parameters<typeof registerOwnerAppPublicationIpc<WebContents, DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation>>[0];
  const datasetForWorkspace = localDatasetHostFor;
  const moveToServer = async (workspace: DesktopRendererWorkspaceOperation["workspace"], datasetId: string, signal: AbortSignal) => {
    const remote = await remoteForWorkspace(workspace);
    signal.throwIfAborted();
    await moveCollectionToServer({ local: await datasetForWorkspace(workspace, signal), workspaceId: workspace.workspaceId, datasetId, ...remote,
      currentCredentialGeneration: () => credentialCacheGeneration, relayStream: relayShareJsonWithCredentials, signal });
  };
  const datasetDependencies = {
    hostForWorkspace: datasetForWorkspace,
    moveToServer,
    collectionPlace: async (workspace: DesktopRendererWorkspaceOperation["workspace"], datasetId: string, signal: AbortSignal): Promise<DatasetPlace> => {
      const authority = await collectionsAuthorityFor(workspace, signal);
      if (authority.kind === "server") return { kind: "server", host: new URL(authority.server.credentials.relayUrl ?? authority.server.credentials.serverUrl).host };
      const { local } = authority, remote = workspace.remote ? await remoteForWorkspace(workspace) : null;
      signal.throwIfAborted();
      return collectionPlace({ transfer: await finishedTransferOf(workspace, local, datasetId, signal), relayUrl: remote?.credentials.relayUrl ?? null,
        automations: async () => automationCounts(workspace.workspaceId, datasetBaseFolder((await local.approvedArtifacts(datasetId)).revision.definition)),
        runs: async () => remote && await readAutomationHost(workspace.workspaceId, remote.credentials, remote.credentialGeneration, signal).then(serverRunsOfAnswer, () => null) });
    },
    serverCollectionsFor: async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal) => {
      const server = await serverCollectionsFor(workspace, signal);
      return server && { data: server.data(signal, () => signal.throwIfAborted()), elsewhere: server.elsewhere };
    },
    automationName: async (workspace: DesktopRendererWorkspaceOperation["workspace"], automationId: string) =>
      await collectionAutomationsOf(workspace.workspaceId)?.nameForHistory(automationId) ?? null,
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
    dataForWorkspace: async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal): Promise<OwnerDatasetData> => {
      // On a computer that doesn't keep the Collections, the server's, as every Collection action chooses.
      const authority = await collectionsAuthorityFor(workspace, signal);
      if (authority.kind === "server") return authority.server.data(signal, () => signal.throwIfAborted());
      const { local } = authority;
      return createDatasetAuthorityRouter(local, {
        status: datasetId => { signal.throwIfAborted(); return finishedTransferOf(workspace, local, datasetId, signal); },
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
          let copyWorkspace: EngineWorkspace | undefined;
          const openCopy = () => workspaceAuthorities.withOperation(workspace.workspaceId, async operation => {
            signal.throwIfAborted(); operation.assertCurrent();
            const rootPath = workspaceRootForOperation(operation.workspace.rootPath, workspace.rootPath);
            copyWorkspace = { ...operation.workspace, rootPath };
            return ownerDatasetCopies.get({ ...copyWorkspace,
              datasetId, origin: targetOrigin, ownerKey, lifetime: operation.signal,
              assertOwner: () => {
                if (!cachedCredentials || datasetCopyOwnerKey(cachedCredentials) !== ownerKey) throw new Error("Sign in as this Collection's owner.");
              },
              runtime: { launch: createDesktopAppRuntimeLauncher(utilityProcess, false), entryPath: join(datasetRuntimePath(), "persistent-child.mjs") },
            });
          });
          // Right after launch the engine's open may still be preparing
          // `.dohc/local`, so a copy waits once for an open already under
          // way. If the folder still isn't ready, the server holds the
          // Collection, so it works online without an offline copy.
          const copy = await openCopy().catch(async (error: unknown) => {
            if (!(error instanceof LocalStateUnavailableError) || error.refusal !== "not-opened" || !copyWorkspace) throw error;
            await localStateOpened(copyWorkspace);
            return openCopy();
          }).catch((error: unknown) => { if (error instanceof LocalStateUnavailableError) return null; throw error; });
          if (copy === null) return data;
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
        return flushDatasetSourceCapture(adapter, signal);
      });
      if (!captured) throw new Error("The workspace engine is unavailable. Reopen the workspace.");
      return captured;
    },
    withAdapter: async <T extends {}>(workspace: DesktopRendererWorkspaceOperation["workspace"], work: (adapter: import("@dohc/workspace-engine-client").VersionedLiveAdapter) => Promise<T>) => {
      const result = await withEngineAdapter(workspace, work);
      if (result === null) throw new Error("The workspace engine is unavailable. Reopen the workspace.");
      return result;
    },
    createSources: async (workspace: DesktopRendererWorkspaceOperation["workspace"], files: Record<string, string>, signal: AbortSignal, progress?: SourceCreationProgress) => {
      assertWritableWorkspace(workspace);
      await createDatasetSources(workspace.rootPath, files, signal, {
        register: () => openWorkspaceActivity(workspace),
        capture: async () => {
          const captured = await withEngineAdapter(workspace, async adapter => {
            await flushDatasetSourceCapture(adapter, signal, Object.keys(files));
            return true;
          });
          if (!captured) throw new Error("The workspace engine is unavailable. Reopen the workspace.");
        },
        verify: async () => {
          const verified = await withEngineAdapter(workspace, async adapter => {
            const metadata = await adapter.captureSourceMetadata({ workspaceId: workspace.workspaceId, versionId: "main", paths: Object.keys(files),
              bounds: { maxInputFiles: 64, maxInputBytes: 2 * 1024 * 1024 }, signal });
            if (metadata.files.length !== Object.keys(files).length || metadata.files.some(file => !Object.hasOwn(files, file.path) || file.sha256 !== createHash("sha256").update(files[file.path]!).digest("hex"))) {
              throw new Error("Saved source differs from this request. Keep it and choose another folder.");
            }
            return true;
          });
          if (!verified) throw new Error("The workspace engine is unavailable. Reopen the workspace.");
        },
      }, progress).finally(() => notifyRenderer({ workspaceId: workspace.workspaceId }));
    },
  };
  const exportDatasetArchive = async (workspace: DesktopRendererWorkspaceOperation["workspace"], datasetId: string,
    path: string, overwrite: boolean | undefined, signal: AbortSignal, authorize: () => void) => {
    const fromServer = async (origin: string, remote: { credentials: CloudSessionCredentials; credentialGeneration: number }) => {
      const archive = await openRemoteDatasetRecoveryExport({ workspaceId: workspace.workspaceId, datasetId,
        origin, ...remote, currentCredentialGeneration: () => credentialCacheGeneration,
        signal, assertCurrent: authorize, maxBytes: 1024 * 1024 * 1024 + 2 * 1024 * 1024,
        relayResponse: relayShareResponseWithCredentials });
      try { return (await writeDatasetRecoveryExport({ path, overwrite, stream: archive.stream, maxBytes: archive.maxBytes, signal, authorize, workspaceRoots: listWorkspaces().map(entry => entry.rootPath) })).savedPath; }
      finally { await archive.dispose(); }
    };
    const authority = await collectionsAuthorityFor(workspace, signal);
    if (authority.kind === "server") {
      const { server } = authority;
      // The server describes only a Collection whose move finished, as the computer that keeps them exports only those.
      await server.data(signal, authorize).describe(datasetId, { includeArchived: true });
      return fromServer(server.elsewhere.server, { credentials: server.credentials, credentialGeneration: server.credentialGeneration });
    }
    const { local } = authority;
    const transfer = await finishedTransferOf(workspace, local, datasetId, signal);
    if (transfer) return fromServer(transfer.targetOrigin, await remoteForWorkspace(workspace));
    const archive = await local.prepareExport(datasetId, { signal });
    try { return (await writeDatasetRecoveryExport({ path, overwrite, stream: archive.stream(), maxBytes: archive.maxBytes, signal, authorize, workspaceRoots: listWorkspaces().map(entry => entry.rootPath) })).savedPath; }
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
  handleIpc(CHANNELS.createCollectionRecord, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = CreateCollectionRecordPayload.parse(raw);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId,
      "Record creation stopped because this window changed workspaces.", async operation => {
      const files = createShareViewFilesForOperation(operation);
      const found = await createOwnedWorkspaceFileReader({ workspace: operation.workspace, files }).resolveShare(`${input.collectionPath}/collection.yaml`);
      operation.assertCurrent();
      if (found) {
        const resolved = resolveRegisteredShareViewFilesTarget(operation.workspace, found.target);
        if (!resolved || resolved.kind !== "standalone") throw new Error("Open this share as a workspace to create a record.");
        return createReceivedShareRecord(input, {
          target: found.target, resolved, files,
          collectionPath: found.path.slice(0, -"/collection.yaml".length),
          assertCurrent: () => {
            operation.assertCurrent();
            if (JSON.stringify(resolveRegisteredShareViewFilesTarget(operation.workspace, found.target)) !== JSON.stringify(resolved)) {
              throw new Error("The shared file session changed. Open the Collection again.");
            }
          },
          checkAuthority: async () => {
            await warmCredentialCache();
            operation.assertCurrent();
            const credentials = cachedCredentials;
            if (!credentials?.relayUrl || resolved.relayUrl && !relayUrlsMatch(resolved.relayUrl, credentials.relayUrl)) return null;
            const generation = credentialCacheGeneration;
            try {
              const info = await fetchShareViewInfo({ relay: { baseUrl: credentials.relayUrl, token: credentials.token }, shareId: resolved.shareId! });
              operation.assertCurrent();
              if (generation !== credentialCacheGeneration) throw new Error("The shared file session changed.");
              if (!info.selector) throw new Error("This Collection does not have Edit access.");
              return info.selector;
            } catch (error) {
              operation.assertCurrent();
              if (generation !== credentialCacheGeneration) throw new Error("The shared file session changed.");
              if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) return null;
              throw error;
            }
          },
          withLease: work => withStaleSensitiveWorkspaceOperation(operation.workspace.rootPath, work),
          recordStatus: path => requireEngineSessions().run({ workspaceId: resolved.storeWorkspaceId,
            rootPath: resolved.rootPath, shareMount: true,
            ...(resolved.kind === "standalone" ? { attachmentId: operation.workspace.attachmentId } : {}) }, async binding => {
            const selector = recordedShareSelector(resolved.grantedSelector);
            const statuses = await shareRecordStatuses(new WorkspaceDaemonRequester(binding.client), {
              workspaceId: resolved.storeWorkspaceId, shareId: resolved.shareId!, paths: [path],
              grantedSelector: selector ? {
                paths: selector.paths,
                versionId: selector.versionId,
                access: selector.access,
              } : null,
            }, { workspace: binding.workspace });
            return statuses[path] ?? null;
          }),
          shareViewEdited: () => { shareDirectWrites?.recordCreated(input.workspaceId); notifyRenderer({ workspaceId: input.workspaceId }); },
        });
      }
      return createRecordByHand(input, {
      author: createLocalChangeAuthor(localUserDisplayName()),
      localPerson,
      withWorkspaceOperation: work => work(operation),
      editContext: (operation: DesktopWorkspaceOperation, person) => collectionEditContextFor(operation, person),
      });
    });
  });
  registerOperations(operationBoundary, datasetOperations, {
    dataset: (request, { event }) => datasetHandler(event.sender, request),
    keepCollectionsHere: async (_input, { event, operation }) => {
      const { workspace } = operation;
      const holder = collectionsHolderCheck(workspace.workspaceId);
      if (!holder.required()) throw new Error("A received share's Collections stay with the person who shared it.");
      const kept = await keepCollectionsHere(workspace.rootPath, workspace.workspaceId, holder.here(), {
        adoptStore: storeId => adoptLocalDatasetStore(workspace.rootPath, workspace.workspaceId, storeId),
        storeIdHere: () => localDatasetStoreId(workspace.rootPath),
        madeBy: () => workspaceMadeBy(workspace.rootPath),
        confirm: question => confirmKeepCollections(BrowserWindow.fromWebContents(event.sender), question),
      });
      operation.assertCurrent();
      if (kept) notifyRenderer({ workspaceId: workspace.workspaceId });
      return { kept };
    },
  });
  const cliDataset = createDatasetHandler<string, DesktopRendererWorkspaceOperation["workspace"], WorkspaceAuthorityOperation<RegistryEntry, DesktopWorkspaceAuthorityState>>({
    ...datasetDependencies, withWorkspaceOperation: (_caller, workspaceId, work) => workspaceAuthorities.withOperation(workspaceId, work),
    exportArchive: async (workspace, input, signal, authorize) => {
      if (!input.savePath) throw new Error("Choose an absolute recovery export path.");
      return exportDatasetArchive(workspace, input.datasetId, input.savePath, input.overwrite, signal, authorize);
    },
  });
  datasetForCli = async (input, agent) => DatasetResult.parse(await cliDataset(input.workspaceId, input, agent));
  describeDatasetForCli = (workspaceId, datasetId) => withPhysicalWorkspaceOperation(workspaceId,
    operation => describeAutomationDataset(operation, datasetId, datasetDependencies));
  const localDatasetLaunches = new WeakMap<LocalDatasetHost, Promise<LocalAppLaunchHost>>();
  const localAppLauncher = async (workspace: DesktopRendererWorkspaceOperation["workspace"], signal: AbortSignal) =>
    workspaceAuthorities.withOperation(workspace.workspaceId, async operation => {
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
      return launcher;
    });
  const localPublication = createLocalOwnerAppPublicationHandler<DesktopRendererWorkspaceOperation["workspace"],
    { workspace: DesktopRendererWorkspaceOperation["workspace"]; signal: AbortSignal; scope?: string; assertCurrent(): void }>({
      ...ownerPublicationDependencies, datasetForWorkspace,
      launchLocalDataset: async (workspace, publicationId, signal) =>
        (await localAppLauncher(workspace, signal)).launch(publicationId, signal),
    });
  appViews = registerAppViews<DesktopRendererWorkspaceOperation["workspace"]>({
    activePublication: async (operation, appRoot) => {
      const listed = await localPublication({ action: "listLocal", workspaceId: operation.workspace.workspaceId, appRoot },
        "app-view", operation);
      operation.assertCurrent();
      return listed?.kind === "localListed" ? listed.publications.find(publication => publication.active)?.publicationId ?? null : null;
    },
    launch: async (operation, publicationId) =>
      (await localAppLauncher(operation.workspace, operation.signal)).launchSession(publicationId, operation.signal, { keepAlive: true }),
  });
  registerOperations(operationBoundary, appViewOperations, { appView: appViews.appView });
  const beforeSharedPublish = async (workspace: DesktopRendererWorkspaceOperation["workspace"], candidate: import("@dohc/security-contract/app-publication").AppPublicationCandidate, signal: AbortSignal) => {
    const dataset = candidate.capabilities.find(capability => capability.kind === "dataset");
    if (dataset) await moveToServer(workspace, dataset.datasetId, signal);
  };
  const resolveDatasetRevision = async (workspace: DesktopRendererWorkspaceOperation["workspace"], binding: import("@dohc/security-contract/dataset").AppDatasetBinding, signal: AbortSignal) =>
    resolveRemoteDatasetRevision(await datasetDependencies.dataForWorkspace(workspace, signal), binding);
  registerOwnerAppPublicationIpc<WebContents, DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation>({ ...ownerPublicationDependencies, localPublication, beforeSharedPublish, resolveDatasetRevision });
  const cliOwnerPublication = createOwnerAppPublicationHandler<string, DesktopRendererWorkspaceOperation["workspace"], WorkspaceAuthorityOperation<RegistryEntry, DesktopWorkspaceAuthorityState>>({
    ...ownerPublicationDependencies, localPublication, beforeSharedPublish, resolveDatasetRevision,
    callerKey: workspaceId => `local-owner-cli:${workspaceId}`,
    withWorkspaceOperation: (_caller, workspaceId, work) => workspaceAuthorities.withOperation(workspaceId, work),
  });
  ownerAppPublicationForCli = (input, agent) => cliOwnerPublication(input.workspaceId, input, agent);
  const undoAcceptedResponse=async(workspace:DesktopRendererWorkspaceOperation["workspace"],input:AppResponseUndoSelection,author?:MomentWriteAuthor)=>{
    await openWorkspaceActivity(workspace);
    const capture=activity.engineCaptureFor(workspace.workspaceId,workspace.rootPath);
    if(!capture)throw new Error("dohc could not open app responses. Restart dohc and try again.");
    return capture.undoAcceptedAppResponse(input,author);
  };
  const ownerResponseDependencies={
    registerHandler:handleIpc,assertTrustedSender,withRendererWorkspaceOperation,
    remoteForWorkspace,currentCredentialGeneration:()=>credentialCacheGeneration,relayJson:relayShareJsonWithCredentials,
    undoAcceptedResponse:(workspace,input)=>undoAcceptedResponse(workspace,input),
  } satisfies Parameters<typeof registerOwnerAppResponsesIpc<WebContents,DesktopRendererWorkspaceOperation["workspace"],DesktopRendererWorkspaceOperation>>[0];
  registerOwnerAppResponsesIpc(ownerResponseDependencies);
  const cliOwnerResponses=createOwnerAppResponsesHandler<string,DesktopRendererWorkspaceOperation["workspace"],WorkspaceAuthorityOperation<RegistryEntry,DesktopWorkspaceAuthorityState>>({
    ...ownerResponseDependencies,withWorkspaceOperation:(_caller,workspaceId,work)=>workspaceAuthorities.withOperation(workspaceId,work),
    // During a run an automation started, a removal through the CLI is the
    // run's agent's, so the removed record's claims carry the run's depth.
    undoAcceptedResponse:(workspace,input)=>{
      const depth=activity.agentRunDepth(workspace.workspaceId);
      return undoAcceptedResponse(workspace,input,depth>0?{kind:"agent",agentId:"dohc-mcp",onBehalfOf:localUserId(),depth}:undefined);
    },
  });
  ownerAppResponsesForCli=input=>cliOwnerResponses(input.workspaceId,input);
  const {
    handlers: sharedChannelHandlers,
    assertShareNotHeldElsewhere,
    reserveAndPullSharedChannelForWorkspace,
    endWorkspaceJoinedChannel,
  } = createSharedChannelsIpc<
    DesktopRendererWorkspaceOperation["workspace"], DesktopRendererWorkspaceOperation
  >({
    requireEngineCapture,
    assertWritableWorkspace,
    linkedChatStoreFor,
    remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    currentCredentials: () => cachedCredentials,
    warmCredentialCache,
    relayShareJsonWithCredentials,
    listWorkspaces,
    updateWorkspaceSharedChannels,
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
    sharesChanged: (workspaceId) => { receivedShareAcquisition.invalidate(); invalidateHistoryLabels(workspaceId); shareRosters.sharesChanged(workspaceId); },
    reconcileReceivedShares,
  });
  registerOperations(operationBoundary, sharedChannelOperations, sharedChannelHandlers);

  const agentRunsIpc = createAgentRunsIpc<WebContents, IpcMainInvokeEvent, RegistryEntry, DesktopRendererWorkspaceOperation>({
    detectAgentTools: async (workspaceRoot: string, signal: AbortSignal) => {
      await loginShellPathRead;
      return detectAgentTools(workspaceRoot, signal, resourcesBasePath());
    },
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, requireEngineCapture,
    linkedChatStoreFor, agentDispatchStoreHandleFor, assertAgentRunnableWorkspace,
    assertChatRunnerIdle, startAgentRunWithWorkspaceActivity,
    agentIntegration, mcpShareAccessOf, mcpConfigFor,
    senderWorkspaceAuthority, chatDispatchService, assertWritableWorkspace,
    openWorkspaceActivity,
  });
  registerCollectionAutomationsIpc<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, sharedViewOf,
    controls: automationControlsFor,
    readText: readWorkspaceTextIfPresent,
    createFile: (event, payload) => workspaceFileMutations.createFile(event, payload),
    writeText: (event, payload) => workspaceFileMutations.writeText(event, payload),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    deletePath: (event, payload) => workspaceFileMutations.deletePath(event, payload),
    watchPress: (workspaceId, claimId, sender) => pressWindows.watch(workspaceId, claimId, sender, null),
    serverRuns,
    relayUnreachable,
  });

  const buttonsIpc = registerAutomationButtonsIpc<WebContents, IpcMainInvokeEvent, DesktopWorkspaceOperation>({
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation,
    readText: readWorkspaceTextIfPresent,
    // A file is a record of the nearest Collection folder above it, when
    // its frontmatter id names a record the engine indexed at this path.
    recordAt: async (operation, path) => {
      const found = await withEngineAdapter(operation.workspace, async (engine) => {
        const collections = (await engine.listCollections()).collections
          .map((collection) => collection.path)
          .filter((collection) => path.startsWith(`${collection}/`))
          .sort((left, right) => right.length - left.length);
        const collectionPath = collections[0];
        if (collectionPath === undefined) return null;
        const read = await readWorkspaceTextIfPresent(operation.workspace.rootPath, path);
        const recordId = read && !read.truncated ? parseCollectionRecordFields(read.text)?.[RECORD_ID_FRONTMATTER_KEY] : undefined;
        if (typeof recordId !== "string") return null;
        try {
          const { record } = await engine.getCollectionRecord({ collectionPath, recordId, historyLimit: 1 });
          return record.path === path ? { collectionPath, record } : null;
        } catch (error) {
          // Not indexed yet, or no longer in this Collection.
          if (error instanceof Error && error.message === RECORD_NOT_FOUND) return null;
          throw error;
        }
      });
      return found ?? null;
    },
    buttonFields: async (operation, collectionPath) => {
      const details = await withEngineAdapter(operation.workspace, (engine) => engine.getCollection({ collectionPath }));
      if (details === null) throw new Error("The workspace engine is not running.");
      return details.schema.fields.flatMap((field) => (field.type === "button" ? [field.name] : []));
    },
    describeDataset: (sender, workspaceId, datasetId) => withRendererWorkspaceOperation(sender, workspaceId,
      "Collection changes stopped because this window changed workspaces.",
      operation => describeAutomationDataset(operation, datasetId, datasetDependencies)),
    pressedBy: pressingPerson,
    inspectionAccount: async () => {
      await credentialSessionCache.warm(() => cloudLogin().credentials());
      return chatShareSessionKey(cachedCredentials);
    },
    // A shared view's press goes to the relay it came from, for this
    // person's own grant; the relay checks the grant again.
    relayPress: async (operation, input) => {
      await warmCredentialCache();
      operation.assertCurrent();
      const credentials = cachedCredentials;
      const generation = credentialCacheGeneration;
      const session = "session" in operation ? (operation as DesktopRendererWorkspaceOperation).session : undefined;
      const retirement = workspaceAuthorities.attachmentRetirementSignal(operation.workspace.workspaceId, operation.workspace.attachmentId);
      const marker = operation.workspace.shareView;
      const shareId = isRecordValue(marker) && typeof marker.shareId === "string" ? marker.shareId : null;
      const shareRelayUrl = isRecordValue(marker) && typeof marker.relayUrl === "string" ? marker.relayUrl : null;
      if (!credentials?.relayUrl) throw new Error("Sign in to your server first.");
      if (shareId === null) throw new Error("This shared view has lost its share. Open it again from the link.");
      if (shareRelayUrl !== null && !relayUrlsMatch(credentials.relayUrl, shareRelayUrl)) {
        throw new Error("Sign in to the cloud server this share came from.");
      }
      await automationPressRelay({ baseUrl: normalizeServerUrl(credentials.relayUrl), token: credentials.token, fetch: relayShareFetch })
        .press(shareId, input, {
          isCurrent: () => (session?.isCurrent() ?? true) && !retirement.aborted && credentialCacheGeneration === generation,
          sync: isCurrent => noticeStore().sync(isCurrent),
        });
    },
    relayInspect: async (operation, input) => {
      const marker = operation.workspace.shareView;
      await warmCredentialCache();
      const credentials = cachedCredentials;
      const shareId = isRecordValue(marker) && typeof marker.shareId === "string" ? marker.shareId : null;
      const relayUrl = isRecordValue(marker) && typeof marker.relayUrl === "string" ? marker.relayUrl : null;
      if (!credentials?.relayUrl || shareId === null || (relayUrl !== null && !relayUrlsMatch(credentials.relayUrl, relayUrl))) {
        return input.map(() => ({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED }));
      }
      return automationPressRelay({ baseUrl: normalizeServerUrl(credentials.relayUrl), token: credentials.token, fetch: relayShareFetch }).inspect(shareId, input);
    },
    serverCollection: (operation, datasetId) => serverCollectionOf(operation.workspace, datasetId, operation.signal),
    inspectionChanged: (workspaceId, attachmentId) => {
      withWorkspaceAttachment({ workspaceId }, lease => {
        if (lease.binding.attachmentId === attachmentId) notifyCollectionAutomationsChanged(workspaceId);
      });
    },
    pressWindows,
  });
  pressNamedForCli = buttonsIpc.pressNamed;
  clearButtonInspections = buttonsIpc.clearInspections;
  inspectNamedForCli = buttonsIpc.inspectNamed;

  registerOperations(operationBoundary, liveDraftRecoveryOperations, {
    typingRecovery: async (input, {operation}) => {
      operation.assertCurrent();
      let result: TypingCopyResult | undefined;
      if (input.action === "dismiss") {
        dismissedTypingCheckpoints.add(`${operation.workspace.workspaceId}:${input.checkpointId}`);
      } else if (input.action === "copy" || input.action === "discard") {
        result = await actOnTypingCopy({directory: join(stateDir(), "live-draft-recovery"),
          workspaceId: operation.workspace.workspaceId, checkpointId: input.checkpointId, action: input.action,
          assertCurrent: () => operation.assertCurrent(), copyText: text => clipboard.writeText(text),
          recovered: () => importedTypingCheckpoints.get(`${operation.workspace.workspaceId}:${input.checkpointId}`)});
        if (result.outcome !== "copied") typingRecoveryFailures.get(operation.workspace.workspaceId)?.delete("import:" + input.checkpointId);
        notifyRenderer({workspaceId: operation.workspace.workspaceId});
      } else if (input.action !== "read") await flushTypingCheckpoints(operation.workspace.workspaceId);
      if (input.action === "retry") await recoverOutageTyping(operation.workspace);
      operation.assertCurrent();
      return {failures: [...(typingRecoveryFailures.get(operation.workspace.workspaceId)?.values() ?? [])]
        .filter(failure => !failure.checkpointId || !dismissedTypingCheckpoints.has(`${operation.workspace.workspaceId}:${failure.checkpointId}`)), ...result};
    },
    listLiveDraftRecovery: (input, {operation}) => {
      operation.assertCurrent();
      return listLiveDraftRecovery(join(stateDir(), "live-draft-recovery"), input.workspaceId);
    },
    discardLiveDraftRecovery: async (input, {event, operation}) => {
      operation.assertCurrent();
      if (desktopWindows.workspaceWindows.allLive().some(window => window.webContents !== event.sender && rendererWorkspaceSessions.current(window.webContents)?.workspaceId === input.workspaceId)) throw new Error("Close the other window for this workspace, then dismiss this draft again.");
      return removeLiveDraftCopies(join(stateDir(), "live-draft-recovery"), operation.workspace.workspaceId, input.objectId, input.snapshotSha256, Math.min(input.discardedAtMs, Date.now()), input.path, input.recordId);
    },
  });

  retryStopAndRestoreReleases = registerStopAndRestoreIpc<
    WebContents,
    IpcMainInvokeEvent,
    DesktopRendererWorkspaceOperation["workspace"],
    DesktopRendererWorkspaceOperation,
    CloudSessionCredentials
  >({
    hasOtherWorkspaceWindow: (sender, workspaceId) => desktopWindows.workspaceWindows.allLive().some(window => window.webContents !== sender && rendererWorkspaceSessions.current(window.webContents)?.workspaceId === workspaceId),
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, remoteForWorkspace,
    currentCredentialGeneration: () => credentialCacheGeneration,
    relayJson: (credentials, path, init) => relayShareJsonWithCredentials(credentials, path, init),
    endLink: async (credentials, path, init) =>
      (await relayShareJsonWithCredentials<unknown>(credentials, path, init, { retainDependentSetConflict: true })).kind === "success"
        ? "ended"
        : "dependents-changed",
    sharesChanged: (workspaceId) => { receivedShareAcquisition.invalidate(); invalidateHistoryLabels(workspaceId); shareRosters.sharesChanged(workspaceId); },
    requireEngineCapture: (workspaceId) => requireEngineCapture(workspaceId, "Engine history"),
    localPerson,
    queuePull: (workspaceId) => activity.queueCloudPull(workspaceId),
    syncNow: (workspaceId) => activity.syncNow(workspaceId),
    deletePath: (event, payload) => workspaceFileMutations.deletePath(event, payload),
    notifyRenderer,
    assertOriginalWorkspace: (workspace) => {
      if (shareViewIsPresent(workspace.shareView)) throw new Error("Only the original workspace has shares to stop.");
    },
    serverRuns,
    currentAutomations: collectionAutomationsOf,
    canReleaseRuns: workspaceId => findWorkspace(workspaceId)?.remote !== undefined && !!cachedCredentials?.relayUrl,
  }).retryServerReleases;

  const shareProposalsIpc = createShareProposalsIpc<DesktopRendererWorkspaceOperation>({
    warmCredentialCache,
    withWorkspaceAuthority: (workspaceId, work) =>
      workspaceAuthorities.withAuthority(workspaceId, (lease) => work({
        get workspace() { return canonicalWorkspaceFor(lease); },
        assertCurrent: () => lease.assertCurrent(),
      })),
    reportDirectWrites: shareDirectWriteDelivery.report,
    automationDefinitionsChanged: workspaceId => {
      notifyCollectionAutomationsChanged(workspaceId);
      notifyRenderer({ workspaceId });
    },
    currentCredentials: () => cachedCredentials,
    currentCredentialGeneration: () => credentialCacheGeneration,
    normalizeServerUrl, isRecordValue, readOwnedWorkspaceTextFor, activity,
    listShareProposals, readShareProposal, readShareProposalOp, settleShareProposal,
    listMyShareProposals, withdrawShareProposal, withStaleSensitiveWorkspaceOperation,
    shareViewFiles, receivedShareEngine,
  });
  shareDirectWrites = shareProposalsIpc;
  registerOperations(operationBoundary, shareProposalOperations, shareProposalsIpc.handlers);

  registerSharedViewsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation, DesktopWorkspaceAuthorityLease>({
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, loadAndCacheCurrentCredentials,
    warmCredentialCache, currentCredentials: () => cachedCredentials,
    currentCredentialGeneration: () => credentialCacheGeneration,
    currentRendererSession: sender => rendererWorkspaceSessions.current(sender),
    onSenderClosed: (sender, close) => {
      sender.once("destroyed", close);
      return () => { sender.removeListener("destroyed", close); };
    },
    engineDaemonStartup: () => desktopEngine.startup,
    fetchShareViewInfo, fetchShareViewAccess, probeShareViewLog, usableRoot, readdir, mkdir, createJoinedWorkspace,
    setWorkspaceShareView, refreshNativeWorkspaceSurfaces, workspaceAuthorities,
    canonicalWorkspaceFor, withStaleSensitiveWorkspaceOperation, shareViewFiles,
    receivedShareEngine, openWorkspaceActivity, requireWorkspace, notifyRenderer,
    syncNotices: isCurrent => noticeStore().sync(isCurrent),
    recordShareViewStoreRefusal: activity.recordShareViewStoreRefusal,
    recheckRemovedShares,
  });

  // ---- Share mounts ----
  // The receive side materialized inside a host workspace: the share's
  // filtered files arrive under shared-with-me/<label>/ as ordinary
  // read-only files (agent-readable through normal tools). The mount's pull
  // state lives in its own nested .dohc (invisible to the host tree), and
  // the host's capture/search/relay-push already exclude shared-with-me via
  // the effective-policy floor — mounted content cannot leak into the
  // host's history or its synced copy.

  registerOperations(operationBoundary, shareMountOperations, createShareMountIpcHandlers({
    assertWritableWorkspace,
    commands: shareMountCommands,
  }));

  registerDesktopDatabaseIpcHandlers<
    WebContents,
    IpcMainInvokeEvent,
    DesktopWorkspaceOperation["workspace"]
  >({
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, assertWritableWorkspace,
    shareViewFiles, workerDatabaseReader, editWorkspaceDatabaseInWorker,
    deleteDatabaseImport: async (operation, path, markChanged, admit) => deleteWorkspacePathByHand(
      { workspace: operation.workspace, assertCurrent: () => operation.signal.throwIfAborted() },
      path, await localPerson(), {
        capture: activity.engineCaptureFor(operation.workspace.workspaceId, operation.workspace.rootPath),
        requestId: randomUUID(), trashItem: path => shell.trashItem(path), markChanged, admit,
        markDeleted: path => engineYDocSessionIpc.fileMutationPort().markDeletedUnderPath(operation.workspace.attachmentId, path),
      },
    ),
  });

  const siteIpcHandlers = createSitesIpcHandlers({
    authority: senderWorkspaceAuthority,
    catalog: ownedSiteCatalog,
  });
  handleIpc(CHANNELS.listSites, siteIpcHandlers.listSites);
  handleIpc(CHANNELS.getSitePackage, siteIpcHandlers.getSitePackage);

  registerAppPreviewIpcHandlers<WebContents, IpcMainInvokeEvent, CreatedWorkspace, DesktopRendererWorkspaceOperation>({
    registerHandler: handleIpc,
    assertTrustedSender, senderWorkspaceAuthority, withRendererWorkspaceOperation,
    appCatalog: ownedSiteCatalog, appPreviews: sitePreviews,
    isSharedView: (workspaceId) => !!sharedViewOf(workspaceId),
    assertMayRunAppCode: (workspace) => workspaceTrust.assertTrusted(workspace),
    executeAppPreview,
  });

  registerOperations(operationBoundary, workspaceTrustOperations, workspaceTrustHandlers<IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    trust: workspaceTrust,
    identify: folderIdentity,
    isSharedView: (workspaceId) => !!sharedViewOf(workspaceId),
    confirm: (event, workspace) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return confirmWorkspaceTrust({
        showMessageBox: (options) => showMessageBox(options, window),
      }, workspace);
    },
    stopAppCommands: (operation) =>
      operation.state.sitePreviews.stopWorkspace(operation.workspace.workspaceId, { rejectOnFailure: true }),
    stopAgents: (workspaceId) => chatDispatchService.stopForRestrictedMode(workspaceId),
    onAsk: (workspaceId) => chatDispatchService.trustAsked(workspaceId),
    wasAsked: (workspaceId) => chatDispatchService.trustWasAsked(workspaceId),
    notifyChanged: notifyWorkspaceTrustChanged,
  }));

  registerOpenWorkspaceIpcHandler<
    WebContents,
    IpcMainInvokeEvent,
    DesktopWorkspaceOperation["workspace"],
    DesktopWorkspaceOperation
  >({
    registerHandler: handleIpc,
    assertTrustedSender,
    withPhysicalWorkspaceOperation,
    rendererWorkspaceSessions,
    setPreferredWorkspaceId: (workspaceId, sender) => {
      desktopWindows.setPreferredWorkspaceId(workspaceId, sender);
    },
    markWorkspaceOpened,
    workspaceShown: (workspaceId, sender) => workspaceFileOpens.shown(sender, workspaceId),
    syncStatusWithOwnedProjection,
    openWorkspaceActivity: async (operation) => {
      // A root macOS refuses would open with every file and engine call failing.
      await assertRootNotPrivacyDenied(operation.workspace.rootPath);
      return openWorkspaceActivityForOperation(operation, {}, ensureWorkspaceActivityOpen);
    },
  });

  // Named versions. Every handler resolves the workspace through
  // requireWorkspace (renderer identity is never trusted) and is gated on the
  // engine capture being attached.

  registerOperations(operationBoundary, folderAppOfferOperations, {
    getFolderApp: (payload, { operation }) => folderAppDetection.read(operation.workspace, payload.folder),
  });

  registerOperations(operationBoundary, workspaceVersionOperations, workspaceVersionHandlers({
    requireEngineCapture, notifyRenderer, activity,
    onRefusalsChanged: notifyNoticesChanged,
  }), rendererUsage.version);

  workspaceEngineIpc.registerHistory();

  registerChatsIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: handleIpc,
    assertTrustedSender, chatScope, requireEngineCapture, linkedChatStoreFor, chatWrites,
    stateDir, assertWritableWorkspace, warmCredentialCache, localUserId,
    localInstallationId, currentCredentials: () => cachedCredentials, chatRelayIdentityFor,
    readWorkspace: findWorkspace, currentCredentialGeneration: () => credentialCacheGeneration,
    syncWorkspaceSharedChannels, syncSharedChannelsForChatTarget,
    chatLinks: workspaceChatLinks,
    syncRendererWorkspaceSharedChannels, withRendererWorkspaceOperation, resolveEngineFiles,
    activity, desktopChatBookmarks, notifyRenderer,
    automationCollectionOf: (workspaceId) => {
      const executor = collectionAutomationsOf(workspaceId);
      return (automationId) => executor?.locate(automationId)?.collectionPath ?? null;
    },
    ensureGroupFolder: async (workspace, folderPath) => {
      await createFolder(workspace.rootPath, folderPath);
    },
    agentWaitsForTrust: (workspaceId, messageId) => chatDispatchService.waitsForTrust(workspaceId, messageId),
  });

  agentRunsIpc.registerChatRunRecords();

  registerDirectMessagesIpcHandlers<WebContents, IpcMainInvokeEvent, DesktopRendererWorkspaceOperation>({
    registerHandler: handleIpc,
    assertTrustedSender, withRendererWorkspaceOperation, requireEngineCapture,
    assertWritableWorkspace, linkedChatStoreFor, warmCredentialCache,
    currentCredentials: () => cachedCredentials,
    currentCredentialGeneration: () => credentialCacheGeneration,
    remoteForWorkspace, relayShareJsonWithCredentials, normalizeServerUrl, listWorkspaces,
    stateDir, peekedReceivedGrantKinds, syncRendererSharedChannelsForChatTarget,
    assertShareNotHeldElsewhere, reserveAndPullSharedChannelForWorkspace,
    endWorkspaceJoinedChannel, chatScope, localUserDisplayName, localInstallationId, activity, chatDispatchService,
  });

  registerPresenceIpcHandlers<IpcMainInvokeEvent>({
    registerHandler: handleIpc,
    assertTrustedSender, rendererWorkspaceSessions,
  });

  workspaceEngineIpc.registerStatusAndRepair();

  agentRunsIpc.registerAgentRuns();

  registerOperations(operationBoundary, settingsOperations, settingsIpc);
  // The settings file applies when saved. The watch lasts as long as main.
  settingsIpc.watchUserSettingsFile();

  windowIpc.registerWindowControls();

  registerOperations(operationBoundary, collectionCopiesLeftOperations, {
    readCollectionCopiesLeft: () => ownerDatasetCopies.leftover(),
    removeCollectionCopiesLeft: async () => {
      await ownerDatasetCopies.removeLeftover().catch(error => console.error("Collection copy cleanup failed", error));
      return ownerDatasetCopies.leftover();
    },
  });

  registerOperations(operationBoundary, crashReportOperations, {
    readCrashReport: () => crashReports.read(),
    dismissCrashReport: async ({ through }) => {
      crashReports.dismiss(through);
      await crashReportPreview.remove();
    },
    // The renderer only opens the dialog. The answer comes from the person.
    sendCrashReport: async (_input, { event }) => ({
      sent: await crashReports.send(async (request) => {
        try {
          return await confirmCrashReportSend({
            showMessageBox: (options) => showMessageBox(options, BrowserWindow.fromWebContents(event.sender)),
            openText: async (text) => await crashReportPreview.show(text),
          }, request);
        } finally {
          // The preview goes when the dialog ends, whatever the answer.
          await crashReportPreview.remove();
        }
      }),
    }),
  }, rendererUsage.crash);

  registerOperations(operationBoundary, reportingOperations, {
    readDiagnostics: async () => ({ text: await currentDiagnostics(), available: telemetry.available }),
    // Main asks where, and writes the text it builds itself.
    saveDiagnostics: async (_input, { event }) => ({
      saved: await saveDiagnostics({
        showSaveDialog: async (options) => {
          const window = BrowserWindow.fromWebContents(event.sender);
          return window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        },
        writeFile: (path, text) => writeFile(path, text, "utf8"),
        defaultPath: join(app.getPath("documents"), "dohc-diagnostics.txt"),
      }, await currentDiagnostics()),
    }),
    // The settings file decides, not the window, and is read here so a
    // window that asks early still gets the saved switches.
    readReportsNotice: async () => telemetry.noticeDue(await readPrivacy()),
    acknowledgeReportsNotice: (shown) => telemetry.acknowledgeNotice(shown),
    reportRendererError: ({ origin, error }) => {
      telemetry.reportError({ kind: "renderer", origin, error });
    },
  });

  registerOperations(operationBoundary, usageRecordOperations, usageRecordHandlers({
    store: () => usageStore,
    file: () => join(stateDir(), USAGE_SNAPSHOT_NAME),
    coverage: DESKTOP_USAGE_COVERAGE,
  }));

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

  registerOperations(operationBoundary, scheduleHostOperations, scheduleHostHandlers<WebContents, IpcMainInvokeEvent>({
    currentRendererSession: sender => rendererWorkspaceSessions.current(sender), scheduleHostState,
  }));

  registerOperations(operationBoundary, chatDispatchNoticeOperations, {
    registerChatDispatchNotices: (input) => chatDispatchNotices.register(input.workspaceId),
    dismissChatDispatchNotice: (input) => chatDispatchNotices.dismiss(input.workspaceId, input.id),
  });

  registerOperations(operationBoundary, chatDispatchPauseOperations, {
    readChatDispatchPaused: () => ({ paused: chatDispatchService.isPaused() }),
    setChatDispatchPaused: ({ paused }) => chatDispatchService.setPaused(paused),
  });

  registerOperations(operationBoundary, agentRunStateOperations, {
    readAgentRunState: (_input, { operation }) =>
      workspaceActivity.agentRunState(operation.workspace, operation.state.activity),
  });

  registerOperations(operationBoundary, noticeOperations, {
    listNotices: () => noticeStore().list(),
    markNotices: (input) => noticeStore().mark(input.notices, input.mark, input.account),
    runSkippedScheduleNow: async (input) => ({ note: await runSkippedScheduleNow(input.notice, input.account) }),
    retryAutomationNotice: (input) => retryFromFailureNotice({ notices: noticeStore(), retry: retryAutomationFromNotice }, input),
    takeWorkspacePathOpenFailures: (_input, { event }) => openPathFailures.take(event.sender),
    retryWorkspacePathOpen: (input, { event }) => openPathFailures.retry(input.attemptId, event.sender),
  }, rendererUsage.notice);

  workspaceEngineIpc.registerYDoc();

  registerUpdatesIpcHandlers({
    registerHandler: handleIpc,
    boundary: operationBoundary,
    assertTrustedSender, currentUpdateState, installUpdate,
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
// start() takes the lock first. A second instance quits without running the profile.
const fromTerminal = process.platform === "linux" && hasControllingTerminal();
if (app.isPackaged && needsLoginShellPath(process.platform, fromTerminal) && app.hasSingleInstanceLock()) {
  loginShellPathRead = adoptLoginShellPath(process.env);
}
