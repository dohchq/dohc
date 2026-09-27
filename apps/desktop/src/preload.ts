import { contextBridge, ipcRenderer, webUtils } from "electron";
import { devToolsGranted } from "./ipc/devToolsIpc";
import {OwnerRestoreRequest, OwnerRestoreActionResponse, type OwnerRestoreAction, type OwnerRestoreResult} from "./ipc/ownerRestoreContract";
import {OwnerAppPublicationRequest, OwnerAppPublicationResult} from "./ipc/ownerAppPublicationContract";
import { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import {OwnerAppResponsesRequest,OwnerAppResponsesResult} from "@dohc/cli/app-responses";
import type {
  CreateLocalWorkspacePayload,
  DohcDesktopBridge,
  GetSitePreviewLogsPayload,
  ListSitesPayload,
  SetUserSettingsPayload,
  SetWorkspaceSettingsPayload,
  SitePackagePayload,
  StartSitePreviewPayload,
  StopSitePreviewPayload,
  WorkspaceSettingsPayload,
  WorkspaceActivityEvent,
  WriteClipboardTextPayload,
} from "./ipc/bridgeContract";
import {
  SitePreviewReplacedEvent,
  ListOwnerLiveDocumentsPayload,
  ListOwnerLiveRefusalsPayload,
  OwnerLiveRefusalsResult,
  RetryOwnerLiveSharePayload,
  OwnerLiveDocumentsResult,
  OwnerLiveDocumentActionPayload,
  DesktopUserSettingsResult,
  ShareDirectWritesPushedEvent,
  EngineYDocLineageReplacementEvent,
  EngineYDocRemoteUpdateEvent,
  EngineYDocOwnerHandoff,
  EngineYDocSaveStateEvent,
  ExitRoundAnswerPayload,
  ExitRoundMessage,
  ExplorerMenuCommand,
  MenuCommand,
  CrashReportChangedEvent,
  NoticesChangedEvent,
  SearchResultsEvent,
  ShareHandoffStatus,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
  WorkbenchMenuCommand,
  WorkspaceIdPayload,
  WorkspaceSummary,
  crashReportOperations,
  noticeOperations,
  scheduleHostOperations,
  chatDispatchNoticeOperations,
  ScheduleHostChangedEvent,
  ChatDispatchNoticesEvent,
  workspaceSearchOperations,
  workspaceVersionOperations,
  parseWorkspaceActivityEventForIpc,
} from "./ipc/bridgeContract";
import { CHANNELS } from "./ipc/channels";
import { operationBridge } from "./ipc/operationTable";
import type { z } from "zod";

// Main→renderer events are validated here before renderer code sees them: a
// value that fails its schema is dropped, and only the parsed (stripped) value
// crosses. An invoke result that fails throws, since the caller is waiting.
function onEvent<Schema extends z.ZodType>(
  channel: string,
  schema: Schema,
  listener: (event: z.output<Schema>) => void,
): () => void {
  const handler = (_event: unknown, raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) listener(parsed.data);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function invoke(channel: string, payload: unknown): Promise<unknown> {
  return ipcRenderer.invoke(channel, payload);
}

async function invokeParsed<Schema extends z.ZodType>(
  channel: string,
  schema: Schema,
  ...args: unknown[]
): Promise<z.output<Schema>> {
  return schema.parse(await ipcRenderer.invoke(channel, ...args));
}

// The entire bridge surface. Narrow on purpose: the renderer gets named,
// typed operations — never raw ipcRenderer, never Node. Typed as
// DohcDesktopBridge so it cannot drift from the contract (a missing or
// mistyped method fails the desktop typecheck).
// One unforgeable identity per preload/document lifetime. Main uses it to
// reject IPC that the outgoing document queued while renderer reload cleanup
// was draining on the same WebContents object.
const rendererDocumentId = crypto.randomUUID();

const bridge: DohcDesktopBridge = {
  platform: process.platform,
  devTools: devToolsGranted(process.argv),
  windowRole:
    new URLSearchParams(window.location.search).get("view") === "manager"
      ? "manager"
      : "workspace",
  reloadRenderer: () =>
    ipcRenderer.invoke(CHANNELS.reloadRenderer, { rendererDocumentId }),
  devForgetWorkspaces: () => ipcRenderer.invoke(CHANNELS.devForgetWorkspaces),
  devRevealPath: (payload) => ipcRenderer.invoke(CHANNELS.devRevealPath, payload),
  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
  getDefaultWorkspaceRoot: () =>
    ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
  getDefaultShareRoot: (payload) =>
    ipcRenderer.invoke(CHANNELS.getDefaultShareRoot, payload),
  createLocalWorkspace: (payload: CreateLocalWorkspacePayload) =>
    ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
  attachWorkspaceFolder: (payload) =>
    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
  forgetWorkspace: (payload) => ipcRenderer.invoke(CHANNELS.forgetWorkspace, payload),
  openWorkspaceWindow: (payload) => ipcRenderer.invoke(CHANNELS.openWorkspaceWindow, payload),
  openWorkspaceManager: () => ipcRenderer.invoke(CHANNELS.openWorkspaceManager),
  closeThisWindow: () => ipcRenderer.invoke(CHANNELS.closeThisWindow),
  revealWorkspaceFolder: (payload) =>
    ipcRenderer.invoke(CHANNELS.revealWorkspaceFolder, payload),
  listWorkspaceFiles: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
  listCollections: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollections, payload),
  getCollection: (payload) =>
    ipcRenderer.invoke(CHANNELS.getCollection, payload),
  queryCollectionRecords: (payload) =>
    ipcRenderer.invoke(CHANNELS.queryCollectionRecords, payload),
  createWorkspaceFile: (payload) =>
    ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
  createWorkspaceFolder: (payload) =>
    ipcRenderer.invoke(CHANNELS.createWorkspaceFolder, payload),
  moveWorkspacePath: (payload) =>
    ipcRenderer.invoke(CHANNELS.moveWorkspacePath, payload),
  deleteWorkspacePath: (payload) =>
    ipcRenderer.invoke(CHANNELS.deleteWorkspacePath, payload),
  exportWorkspaceZip: (payload) =>
    ipcRenderer.invoke(CHANNELS.exportWorkspaceZip, payload),
  exportDocumentFile: (payload) =>
    ipcRenderer.invoke(CHANNELS.exportDocumentFile, payload),
  // The invoke RESULT is validated like main→renderer events are: only a
  // member of the closed command set reaches renderer code — anything else
  // reads as null ("dismissed").
  showExplorerMenu: async (payload) => {
    const result = ExplorerMenuCommand.safeParse(
      await ipcRenderer.invoke(CHANNELS.showExplorerMenu, payload),
    );
    return result.success ? result.data : null;
  },
  showWorkbenchMenu: async (payload) => {
    const result = WorkbenchMenuCommand.safeParse(
      await ipcRenderer.invoke(CHANNELS.showWorkbenchMenu, payload),
    );
    return result.success ? result.data : null;
  },
  // OS drag-in: sandboxed renderers lost File.path in Electron 32+;
  // webUtils.getPathForFile in the preload is the sanctioned resolver.
  // TRUST DELTA flagged in the contract: these paths are renderer-supplied
  // once they cross the bridge — main re-validates each one through the
  // picker-grade import path (files only, never a workspace's .dohc).
  getDroppedFilePaths: (files) => {
    const paths: string[] = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      try {
        const path = webUtils.getPathForFile(file);
        if (typeof path === "string" && path.length > 0) paths.push(path);
      } catch {
        // A synthetic File (no backing fs entry) has no path — skip it.
      }
    }
    return paths;
  },
  importWorkspaceFiles: (payload) =>
    ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
  readWorkspaceText: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceText, payload),
  writeWorkspaceText: (payload) =>
    ipcRenderer.invoke(CHANNELS.writeWorkspaceText, payload),
  writeWorkspaceAsset: (payload) =>
    ipcRenderer.invoke(CHANNELS.writeWorkspaceAsset, payload),
  pickImageFiles: (payload) =>
    ipcRenderer.invoke(CHANNELS.pickImageFiles, payload),
  openFileExternally: (payload) =>
    ipcRenderer.invoke(CHANNELS.openFileExternally, payload),
  readWorkspaceGraph: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceGraph, payload),
  getBacklinks: (payload) => ipcRenderer.invoke(CHANNELS.getBacklinks, payload),
  listWorkspaceHeadings: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceHeadings, payload),
  listChatFileMentions: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatFileMentions, payload),
  listChatBookmarks: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatBookmarks, payload),
  saveChatBookmark: (payload) =>
    ipcRenderer.invoke(CHANNELS.saveChatBookmark, payload),
  archiveChatBookmark: (payload) =>
    ipcRenderer.invoke(CHANNELS.archiveChatBookmark, payload),
  readWorkspaceDatabase: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceDatabase, payload),
  readWorkspaceDatabasePage: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceDatabasePage, payload),
  applyDatabaseEdit: (payload) =>
    ipcRenderer.invoke(CHANNELS.applyDatabaseEdit, payload),
  importToDatabase: (payload) =>
    ipcRenderer.invoke(CHANNELS.importToDatabase, payload),
  listSites: (payload: ListSitesPayload) =>
    ipcRenderer.invoke(CHANNELS.listSites, payload),
  getSitePackage: (payload: SitePackagePayload) =>
    ipcRenderer.invoke(CHANNELS.getSitePackage, payload),
  startSitePreview: (payload: StartSitePreviewPayload) =>
    ipcRenderer.invoke(CHANNELS.startSitePreview, payload),
  getSitePreviewLogs: (payload: GetSitePreviewLogsPayload) =>
    ipcRenderer.invoke(CHANNELS.getSitePreviewLogs, payload),
  stopSitePreview: (payload: StopSitePreviewPayload) =>
    ipcRenderer.invoke(CHANNELS.stopSitePreview, payload),
  onSitePreviewReplaced: (listener) =>
    onEvent(CHANNELS.sitePreviewReplaced, SitePreviewReplacedEvent, listener),
  openExternalUrl: (payload) =>
    ipcRenderer.invoke(CHANNELS.openExternalUrl, payload),
  cloudLoginStart: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudLoginStart, payload),
  cloudLoginPoll: () => ipcRenderer.invoke(CHANNELS.cloudLoginPoll),
  cloudStatus: (payload) => ipcRenderer.invoke(CHANNELS.cloudStatus, payload),
  cloudLogout: () => ipcRenderer.invoke(CHANNELS.cloudLogout),
  getShareHandoffStatus: () =>
    invokeParsed(CHANNELS.getShareHandoffStatus, ShareHandoffStatus),
  acceptShareHandoff: (payload) =>
    ipcRenderer.invoke(CHANNELS.acceptShareHandoff, payload),
  retryShareHandoff: () => ipcRenderer.invoke(CHANNELS.retryShareHandoff),
  dismissShareHandoff: (payload) =>
    ipcRenderer.invoke(CHANNELS.dismissShareHandoff, payload),
  onShareHandoffStatus: (listener) =>
    onEvent(CHANNELS.shareHandoffStatus, ShareHandoffStatus, listener),
  cloudEnableSync: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudEnableSync, payload),
  cloudJoinWorkspace: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudJoinWorkspace, payload),
  createRelayShare: (payload) => ipcRenderer.invoke(CHANNELS.createRelayShare, payload),
  listOwnerLiveDocuments: async payload => OwnerLiveDocumentsResult.parse(await ipcRenderer.invoke(
    CHANNELS.listOwnerLiveDocuments, ListOwnerLiveDocumentsPayload.parse(payload))),
  listOwnerLiveRefusals: async payload => OwnerLiveRefusalsResult.parse(await ipcRenderer.invoke(
    CHANNELS.listOwnerLiveRefusals, ListOwnerLiveRefusalsPayload.parse(payload))),
  retryOwnerLiveShare: async payload => {
    await ipcRenderer.invoke(CHANNELS.retryOwnerLiveShare, RetryOwnerLiveSharePayload.parse(payload));
  },
  stopOwnerLiveDocument: async payload => {
    await ipcRenderer.invoke(CHANNELS.stopOwnerLiveDocument, OwnerLiveDocumentActionPayload.parse(payload));
  },
  resumeOwnerLiveDocument: async payload => {
    await ipcRenderer.invoke(CHANNELS.resumeOwnerLiveDocument, OwnerLiveDocumentActionPayload.parse(payload));
  },
  listRelayShares: () => ipcRenderer.invoke(CHANNELS.listRelayShares),
  getRelayReceivedShare: (payload) =>
    ipcRenderer.invoke(CHANNELS.getRelayReceivedShare, payload),
  revokeRelayShare: (payload) => ipcRenderer.invoke(CHANNELS.revokeRelayShare, payload),
  createRelayShareLink: (payload) =>
    ipcRenderer.invoke(CHANNELS.createRelayShareLink, payload),
  addRelayShareLink: (payload) =>
    ipcRenderer.invoke(CHANNELS.addRelayShareLink, payload),
  listRelayShareLinks: (payload) =>
    ipcRenderer.invoke(CHANNELS.listRelayShareLinks, payload),
  ownerRestore: async <Action extends OwnerRestoreAction>(payload: OwnerRestoreRequest & {action: Action}) => {
    const request = OwnerRestoreRequest.parse(payload);
    return OwnerRestoreActionResponse[request.action].parse(await ipcRenderer.invoke(CHANNELS.ownerRestore, request)) as OwnerRestoreResult<Action>;
  },
  retuneRelayShareLink: (payload) =>
    ipcRenderer.invoke(CHANNELS.retuneRelayShareLink, payload),
  publishOwnerApp: async (payload: OwnerAppPublicationRequest) => OwnerAppPublicationResult.parse(
    await ipcRenderer.invoke(CHANNELS.publishOwnerApp, OwnerAppPublicationRequest.parse(payload))),
  dataset: async (payload: DatasetRequest) => DatasetResult.parse(await ipcRenderer.invoke(CHANNELS.dataset, DatasetRequest.parse(payload))),
  ownerAppResponses:async(payload:OwnerAppResponsesRequest)=>OwnerAppResponsesResult.parse(await ipcRenderer.invoke(CHANNELS.ownerAppResponses,OwnerAppResponsesRequest.parse(payload))),
  rotateRelayShareLink: (payload) =>
    ipcRenderer.invoke(CHANNELS.rotateRelayShareLink, payload),
  revokeRelayShareLink: (payload) =>
    ipcRenderer.invoke(CHANNELS.revokeRelayShareLink, payload),
  listRelayShareDiscussion: (payload) =>
    ipcRenderer.invoke(CHANNELS.listRelayShareDiscussion, payload),
  pollRelayShareDiscussionActivity: (payload) =>
    ipcRenderer.invoke(CHANNELS.pollRelayShareDiscussionActivity, payload),
  cancelRelayShareDiscussionActivity: (payload) =>
    ipcRenderer.invoke(CHANNELS.cancelRelayShareDiscussionActivity, payload),
  appendRelayShareDiscussion: (payload) =>
    ipcRenderer.invoke(CHANNELS.appendRelayShareDiscussion, payload),
  deleteRelayShareDiscussionMessage: (payload) =>
    ipcRenderer.invoke(CHANNELS.deleteRelayShareDiscussionMessage, payload),
  blockRelayShareDiscussionPrincipal: (payload) =>
    ipcRenderer.invoke(CHANNELS.blockRelayShareDiscussionPrincipal, payload),
  unblockRelayShareDiscussionPrincipal: (payload) =>
    ipcRenderer.invoke(CHANNELS.unblockRelayShareDiscussionPrincipal, payload),
  pauseRelayShareDiscussion: (payload) =>
    ipcRenderer.invoke(CHANNELS.pauseRelayShareDiscussion, payload),
  resumeRelayShareDiscussion: (payload) =>
    ipcRenderer.invoke(CHANNELS.resumeRelayShareDiscussion, payload),
  promoteRelayShareGrant: (payload) =>
    ipcRenderer.invoke(CHANNELS.promoteRelayShareGrant, payload),
  revokeRelayShareGrant: (payload) =>
    ipcRenderer.invoke(CHANNELS.revokeRelayShareGrant, payload),
  shareChatChannel: (payload) => ipcRenderer.invoke(CHANNELS.shareChatChannel, payload),
  listChatChannelShares: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatChannelShares, payload),
  listJoinedSharedChannels: (payload) =>
    ipcRenderer.invoke(CHANNELS.listJoinedSharedChannels, payload),
  joinSharedChannel: (payload) => ipcRenderer.invoke(CHANNELS.joinSharedChannel, payload),
  leaveSharedChannel: (payload) =>
    ipcRenderer.invoke(CHANNELS.leaveSharedChannel, payload),
  openSharedView: (payload) => ipcRenderer.invoke(CHANNELS.openSharedView, payload),
  refreshSharedView: (payload) => ipcRenderer.invoke(CHANNELS.refreshSharedView, payload),
  dismissShareSkips: (payload) => ipcRenderer.invoke(CHANNELS.dismissShareSkips, payload),
  listAutomationFailures: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationFailures, payload),
  dismissAutomationFailure: (payload) =>
    ipcRenderer.invoke(CHANNELS.dismissAutomationFailure, payload),
  listCollectionAutomations: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollectionAutomations, payload),
  listCollectionAutomationRuns: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollectionAutomationRuns, payload),
  retryCollectionAutomation: (payload) =>
    ipcRenderer.invoke(CHANNELS.retryCollectionAutomation, payload),
  undoCollectionAutomationRun: (payload) =>
    ipcRenderer.invoke(CHANNELS.undoCollectionAutomationRun, payload),
  listAutomationTargets: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationTargets, payload),
  checkCollectionAutomation: (payload) =>
    ipcRenderer.invoke(CHANNELS.checkCollectionAutomation, payload),
  stopAndRestorePerson: (payload) =>
    ipcRenderer.invoke(CHANNELS.stopAndRestorePerson, payload),
  undoStopAndRestore: (payload) =>
    ipcRenderer.invoke(CHANNELS.undoStopAndRestore, payload),
  confirmCollectionAutomationStep: (payload) =>
    ipcRenderer.invoke(CHANNELS.confirmCollectionAutomationStep, payload),
  writeCollectionAutomations: (payload) =>
    ipcRenderer.invoke(CHANNELS.writeCollectionAutomations, payload),
  listAutomationButtons: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationButtons, payload),
  listRecordButtons: (payload) =>
    ipcRenderer.invoke(CHANNELS.listRecordButtons, payload),
  pressAutomationButton: (payload) =>
    ipcRenderer.invoke(CHANNELS.pressAutomationButton, payload),
  listAutomationHolds: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationHolds, payload),
  resetAutomationHolds: (payload) =>
    ipcRenderer.invoke(CHANNELS.resetAutomationHolds, payload),
  revealAutomationHolds: (payload) =>
    ipcRenderer.invoke(CHANNELS.revealAutomationHolds, payload),
  dismissAutomationStops: (payload) =>
    ipcRenderer.invoke(CHANNELS.dismissAutomationStops, payload),
  automationShareImpact: (payload) =>
    ipcRenderer.invoke(CHANNELS.automationShareImpact, payload),
  listCollectionFieldMarks: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollectionFieldMarks, payload),
  findDatasetCollection: (payload) =>
    ipcRenderer.invoke(CHANNELS.findDatasetCollection, payload),
  onCollectionAutomationsChanged: (listener) =>
    onEvent(CHANNELS.collectionAutomationsChanged, WorkspaceIdPayload, listener),
  onAutomationFailuresChanged: (
    listener: (event: { workspaceId: string }) => void,
  ) => {
    // Validate at the boundary like every main-sent event: the listener
    // only ever sees a workspace id string; anything else is dropped.
    const handler = (_event: unknown, payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "workspaceId" in payload &&
        typeof (payload as { workspaceId: unknown }).workspaceId === "string"
      ) {
        listener({
          workspaceId: (payload as { workspaceId: string }).workspaceId,
        });
      }
    };
    ipcRenderer.on(CHANNELS.automationFailuresChanged, handler);
    return () =>
      ipcRenderer.removeListener(CHANNELS.automationFailuresChanged, handler);
  },
  ...operationBridge(crashReportOperations, invoke),
  onCrashReportChanged: (listener) =>
    onEvent(CHANNELS.crashReportChanged, CrashReportChangedEvent, () => listener()),
  onAutomationHoldsChanged: (
    listener: (event: { workspaceId: string }) => void,
  ) => {
    // Validate at the boundary like every main-sent event: the listener
    // only ever sees a workspace id string; anything else is dropped.
    const handler = (_event: unknown, payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "workspaceId" in payload &&
        typeof (payload as { workspaceId: unknown }).workspaceId === "string"
      ) {
        listener({
          workspaceId: (payload as { workspaceId: string }).workspaceId,
        });
      }
    };
    ipcRenderer.on(CHANNELS.automationHoldsChanged, handler);
    return () =>
      ipcRenderer.removeListener(CHANNELS.automationHoldsChanged, handler);
  },
  onAutomationRunSettled: (listener) => {
    // Validated at the boundary: anything that is not a settled run is dropped.
    const handler = (_event: unknown, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const { workspaceId, claimId, outcome, error } = payload as Record<string, unknown>;
      if (typeof workspaceId !== "string" || typeof claimId !== "string") return;
      if (outcome !== "done" && outcome !== "skipped" && outcome !== "failed" && outcome !== "ended") return;
      if (error !== null && typeof error !== "string") return;
      listener({ workspaceId, claimId, outcome, error });
    };
    ipcRenderer.on(CHANNELS.automationRunSettled, handler);
    return () => ipcRenderer.removeListener(CHANNELS.automationRunSettled, handler);
  },
  onAutomationRunWaiting: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      const { workspaceId, claimId, reason } = payload as Record<string, unknown>;
      if (typeof workspaceId !== "string" || typeof claimId !== "string") return;
      if (reason !== "roster" && reason !== "held" && reason !== "busy") return;
      listener({ workspaceId, claimId, reason });
    };
    ipcRenderer.on(CHANNELS.automationRunWaiting, handler);
    return () => ipcRenderer.removeListener(CHANNELS.automationRunWaiting, handler);
  },
  listShareProposals: (payload) =>
    ipcRenderer.invoke(CHANNELS.listShareProposals, payload),
  readShareProposalChanges: (payload) =>
    ipcRenderer.invoke(CHANNELS.readShareProposalChanges, payload),
  readShareProposalFileContent: (payload) =>
    ipcRenderer.invoke(CHANNELS.readShareProposalFileContent, payload),
  settleShareProposal: (payload) =>
    ipcRenderer.invoke(CHANNELS.settleShareProposal, payload),
  submitShareChanges: (payload) =>
    ipcRenderer.invoke(CHANNELS.submitShareChanges, payload),
  pushShareDirectWrites: (payload) =>
    ipcRenderer.invoke(CHANNELS.pushShareDirectWrites, payload),
  onShareDirectWritesPushed: (listener) =>
    onEvent(CHANNELS.shareDirectWritesPushed, ShareDirectWritesPushedEvent, listener),
  listMyShareChanges: (payload) =>
    ipcRenderer.invoke(CHANNELS.listMyShareChanges, payload),
  withdrawShareChanges: (payload) =>
    ipcRenderer.invoke(CHANNELS.withdrawShareChanges, payload),
  mountShare: (payload) => ipcRenderer.invoke(CHANNELS.mountShare, payload),
  refreshShareMounts: (payload) => ipcRenderer.invoke(CHANNELS.refreshShareMounts, payload),
  unmountShare: (payload) => ipcRenderer.invoke(CHANNELS.unmountShare, payload),
  openWorkspace: (payload) =>
    ipcRenderer.invoke(CHANNELS.openWorkspace, {
      ...payload,
      rendererDocumentId,
    }),
  ...operationBridge(workspaceVersionOperations, invoke),
  listEngineMoments: (payload) =>
    ipcRenderer.invoke(CHANNELS.listEngineMoments, payload),
  readEngineMoment: (payload) =>
    ipcRenderer.invoke(CHANNELS.readEngineMoment, payload),
  restoreEngineMomentFile: (payload) =>
    ipcRenderer.invoke(CHANNELS.restoreEngineMomentFile, payload),
  listFileChats: (payload) =>
    ipcRenderer.invoke(CHANNELS.listFileChats, payload),
  createFileChat: (payload) =>
    ipcRenderer.invoke(CHANNELS.createFileChat, payload),
  listChatMessages: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatMessages, payload),
  getChatThreadRevision: (payload) =>
    ipcRenderer.invoke(CHANNELS.getChatThreadRevision, payload),
  sendChatMessage: (payload) =>
    ipcRenderer.invoke(CHANNELS.sendChatMessage, payload),
  listChatThreadDecisions: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatThreadDecisions, payload),
  resolveChatDecision: (payload) =>
    ipcRenderer.invoke(CHANNELS.resolveChatDecision, payload),
  listChatThreadAttachments: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatThreadAttachments, payload),
  chatRunRecordsForThread: (payload) =>
    ipcRenderer.invoke(CHANNELS.chatRunRecordsForThread, payload),
  listChatChannels: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatChannels, payload),
  listChatFollows: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatFollows, payload),
  setChatFollow: (payload) => ipcRenderer.invoke(CHANNELS.setChatFollow, payload),
  listPersonalChatFeed: (payload) =>
    ipcRenderer.invoke(CHANNELS.listPersonalChatFeed, payload),
  markPersonalChatFeedSeen: (payload) =>
    ipcRenderer.invoke(CHANNELS.markPersonalChatFeedSeen, payload),
  createChatChannel: (payload) =>
    ipcRenderer.invoke(CHANNELS.createChatChannel, payload),
  listChannelThreads: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChannelThreads, payload),
  startChannelThread: (payload) =>
    ipcRenderer.invoke(CHANNELS.startChannelThread, payload),
  markChatThreadRead: (payload) =>
    ipcRenderer.invoke(CHANNELS.markChatThreadRead, payload),
  listChatReactions: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatReactions, payload),
  setChatReaction: (payload) =>
    ipcRenderer.invoke(CHANNELS.setChatReaction, payload),
  syncDms: (payload) => ipcRenderer.invoke(CHANNELS.syncDms, payload),
  acceptDm: (payload) => ipcRenderer.invoke(CHANNELS.acceptDm, payload),
  declineDm: (payload) => ipcRenderer.invoke(CHANNELS.declineDm, payload),
  requestDmAgain: (payload) => ipcRenderer.invoke(CHANNELS.requestDmAgain, payload),
  startDm: (payload) => ipcRenderer.invoke(CHANNELS.startDm, payload),
  leaveDm: (payload) => ipcRenderer.invoke(CHANNELS.leaveDm, payload),
  presencePublish: (payload) =>
    ipcRenderer.invoke(CHANNELS.presencePublish, {
      ...payload,
      rendererDocumentId,
    }),
  presencePoll: (payload) => ipcRenderer.invoke(CHANNELS.presencePoll, payload),
  presenceCancel: (payload) => ipcRenderer.invoke(CHANNELS.presenceCancel, payload),
  getSyncStatus: (payload) => ipcRenderer.invoke(CHANNELS.getSyncStatus, payload),
  retryOwnerLiveDelivery: (payload) => ipcRenderer.invoke(CHANNELS.retryOwnerLiveDelivery, payload),
  retryCloudSync: (payload) => ipcRenderer.invoke(CHANNELS.retryCloudSync, payload),
  rebuildEngineStore: (payload) =>
    ipcRenderer.invoke(CHANNELS.rebuildEngineStore, payload),
  startAgentRun: (payload) => ipcRenderer.invoke(CHANNELS.startAgentRun, payload),
  endAgentRun: (payload) => ipcRenderer.invoke(CHANNELS.endAgentRun, payload),
  getAgentRunStatus: (payload) =>
    ipcRenderer.invoke(CHANNELS.getAgentRunStatus, payload),
  getMcpConfig: (payload) => ipcRenderer.invoke(CHANNELS.getMcpConfig, payload),
  stopAgentRun: (payload) =>
    ipcRenderer.invoke(CHANNELS.stopAgentRun, payload),
  resumeThreadDispatch: (payload) =>
    ipcRenderer.invoke(CHANNELS.resumeThreadDispatch, payload),
  chatDispatchStateForThread: (payload) =>
    ipcRenderer.invoke(CHANNELS.chatDispatchStateForThread, payload),
  runnerSelfTest: (payload) =>
    ipcRenderer.invoke(CHANNELS.runnerSelfTest, payload),
  detectAgentTools: (payload) => ipcRenderer.invoke(CHANNELS.detectAgentTools, payload),
  getUserSettings: () => ipcRenderer.invoke(CHANNELS.getUserSettings),
  setUserSettings: (payload: SetUserSettingsPayload) =>
    ipcRenderer.invoke(CHANNELS.setUserSettings, payload),
  resetUserSettings: () => ipcRenderer.invoke(CHANNELS.resetUserSettings),
  reloadUserSettings: () => ipcRenderer.invoke(CHANNELS.reloadUserSettings),
  setAppPinned: (payload) => ipcRenderer.invoke(CHANNELS.setAppPinned, payload),
  getUserSettingsFilePath: () => ipcRenderer.invoke(CHANNELS.getUserSettingsFilePath),
  openUserSettingsFile: () => ipcRenderer.invoke(CHANNELS.openUserSettingsFile),
  openWorkspaceSettingsFile: (payload: WorkspaceSettingsPayload) =>
    ipcRenderer.invoke(CHANNELS.openWorkspaceSettingsFile, payload),
  getWorkspaceSettings: (payload: WorkspaceSettingsPayload) =>
    ipcRenderer.invoke(CHANNELS.getWorkspaceSettings, payload),
  setWorkspaceSettings: (payload: SetWorkspaceSettingsPayload) =>
    ipcRenderer.invoke(CHANNELS.setWorkspaceSettings, payload),
  resetWorkspaceSettings: (payload: WorkspaceSettingsPayload) =>
    ipcRenderer.invoke(CHANNELS.resetWorkspaceSettings, payload),
  writeClipboardText: (payload: WriteClipboardTextPayload) =>
    ipcRenderer.invoke(CHANNELS.writeClipboardText, payload),
  setTitlebarTheme: (payload) =>
    ipcRenderer.invoke(CHANNELS.setTitlebarTheme, payload),
  onUserSettingsChanged: (listener) =>
    onEvent(CHANNELS.userSettingsChanged, DesktopUserSettingsResult, listener),
  stepWindowZoom: (payload) =>
    ipcRenderer.invoke(CHANNELS.stepWindowZoom, payload),
  getWorkspaceUiState: (payload) =>
    ipcRenderer.invoke(CHANNELS.getWorkspaceUiState, payload),
  setWorkspaceUiState: (payload) =>
    ipcRenderer.invoke(CHANNELS.setWorkspaceUiState, payload),
  onWorkspaceActivity: (listener: (event: WorkspaceActivityEvent) => void) => {
    // Degrades to the payload-free global ping on a malformed payload; an
    // activity notification is never dropped (see the parser's contract).
    const handler = (_event: unknown, raw: unknown) =>
      listener(parseWorkspaceActivityEventForIpc(raw));
    ipcRenderer.on(CHANNELS.workspaceActivity, handler);
    return () => ipcRenderer.removeListener(CHANNELS.workspaceActivity, handler);
  },
  onCloudSessionChanged: (
    listener: (event: {
      sessionKey: string | null;
      phase: "changing" | "ready";
    }) => void,
  ) => {
    // Validate the payload at the boundary like every main-sent event: the
    // listener only ever sees a string key or null, and one of the two
    // phases — an unknown phase degrades to "changing", the phase that
    // takes no action on its own.
    const handler = (_event: unknown, payload: unknown) => {
      const record =
        payload !== null && typeof payload === "object"
          ? (payload as { sessionKey?: unknown; phase?: unknown })
          : {};
      const sessionKey =
        typeof record.sessionKey === "string" ? record.sessionKey : null;
      const phase = record.phase === "ready" ? ("ready" as const) : ("changing" as const);
      listener({ sessionKey, phase });
    };
    ipcRenderer.on(CHANNELS.cloudSessionChanged, handler);
    return () =>
      ipcRenderer.removeListener(CHANNELS.cloudSessionChanged, handler);
  },
  onMenuCommand: (listener) => onEvent(CHANNELS.menuCommand, MenuCommand, listener),
  onWorkspaceActivated: (listener) =>
    onEvent(CHANNELS.workspaceActivated, WorkspaceSummary, listener),
  onUpdateState: (listener) => onEvent(CHANNELS.updateState, UpdateStateEvent, listener),
  getUpdateState: () => invokeParsed(CHANNELS.getUpdateState, UpdateStateEvent),
  checkForUpdates: () => invokeParsed(CHANNELS.checkForUpdates, UpdateCheckResult),
  installUpdate: () => invokeParsed(CHANNELS.installUpdate, UpdateActionResult),
  onExitRound: (listener) => onEvent(CHANNELS.exitRound, ExitRoundMessage, listener),
  answerExitRound: async (payload) => {
    await ipcRenderer.invoke(CHANNELS.exitRoundAnswer, ExitRoundAnswerPayload.parse(payload));
  },
  holdQuit: async () => {
    await ipcRenderer.invoke(CHANNELS.holdQuit);
  },
  resumeQuit: async () => {
    await ipcRenderer.invoke(CHANNELS.resumeQuit);
  },
  // Content search: results stream main→renderer as bounded
  // batches; the searchId round-trips so stale batches drop renderer-side.
  ...operationBridge(workspaceSearchOperations, invoke),
  onSearchResults: (listener) =>
    onEvent(CHANNELS.searchResults, SearchResultsEvent, listener),
  ...operationBridge(noticeOperations, invoke),
  ...operationBridge(scheduleHostOperations, invoke),
  ...operationBridge(chatDispatchNoticeOperations, invoke),
  onNoticesChanged: (listener) =>
    onEvent(CHANNELS.noticesChanged, NoticesChangedEvent, () => listener()),
  onScheduleHostChanged: (listener) =>
    onEvent(CHANNELS.scheduleHostChanged, ScheduleHostChangedEvent, listener),
  onChatDispatchNotices: (listener) =>
    onEvent(CHANNELS.chatDispatchNotices, ChatDispatchNoticesEvent, listener),
  // Engine Y.Doc editor binding.
  // Updates cross as raw Uint8Array (structured clone); the sessionId
  // round-trips so the renderer applies forwarded deltas only for the bound
  // session.
  openEngineYDocSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocOpen, payload),
  readEngineYDocArtifactAsset: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocReadArtifactAsset, payload),
  applyEngineYDocUpdate: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocApplyUpdate, payload),
  acknowledgeEngineYDocLineageReplacement: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocAcknowledgeLineageReplacement, payload),
  prepareEngineYDocOwnerHandoff: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocPrepareOwnerHandoff, payload),
  onEngineYDocOwnerHandoff: (listener) =>
    onEvent(CHANNELS.engineYDocOwnerHandoff, EngineYDocOwnerHandoff, listener),
  closeEngineYDocSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocClose, payload),
  onEngineYDocRemoteUpdate: (listener) =>
    onEvent(CHANNELS.engineYDocRemoteUpdate, EngineYDocRemoteUpdateEvent, listener),
  onEngineYDocLineageReplacement: (listener) =>
    onEvent(
      CHANNELS.engineYDocLineageReplacement,
      EngineYDocLineageReplacementEvent,
      listener,
    ),
  onEngineYDocSaveState: (listener) =>
    onEvent(CHANNELS.engineYDocSaveState, EngineYDocSaveStateEvent, listener),
};

contextBridge.exposeInMainWorld("dohcDesktop", bridge);

// One-shot paint signal for launch instrumentation (no data, no response).
contextBridge.exposeInMainWorld("dohcDesktopInternal", {
  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
});

// Test-only bridge. The authoritative gate is the main-process handler, which
// is double-gated (env and !app.isPackaged); the preload cannot read
// isPackaged, so this env-only check is intentionally the weaker side — never
// expose a data-returning test channel here without a matching double-gated
// handler. Build-time stripping lands with Phase 14 packaging.
if (process.env.DOHC_DESKTOP_TEST === "1") {
  contextBridge.exposeInMainWorld("dohcDesktopTest", {
    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
    getDesktopMarks: () => ipcRenderer.invoke(CHANNELS.getDesktopMarks),
  });
}
