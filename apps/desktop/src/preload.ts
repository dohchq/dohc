import { linksOperations } from "./ipc/linksOperations";
import { shareHandoffOperations, shareMountOperations, shareProposalOperations, sharedChannelOperations, relayShareOperations } from "./ipc/shareOperations";
import { chatOperations } from "./ipc/chatOperations";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { shareCopyOperations } from "./ipc/shareCopyOperations";
import { accessOperations } from "./ipc/accessOperations";
import { settingsOperations } from "./ipc/settingsOperations";
import { workspaceFileOperations } from "./ipc/workspaceFileOperations";
import { devToolsGranted } from "./ipc/devToolsIpc";
import { insecureLoopbackServersForTests } from "./workspaces/cloudConfiguration";
import {OwnerAppPublicationRequest, OwnerAppPublicationResult} from "./ipc/ownerAppPublicationContract";
import { datasetOperations } from "./ipc/datasetOperations";
import {OwnerAppResponsesRequest,OwnerAppResponsesResult} from "@dohc/cli/app-responses";
import { releaseChannelFromArgv } from "./updates/updateMachine";
import type {
  CreateLocalWorkspacePayload,
  DohcDesktopBridge,
  GetSitePreviewLogsPayload,
  ListSitesPayload,
  SitePackagePayload,
  StartSitePreviewPayload,
  StopSitePreviewPayload,
  WorkspaceActivityEvent,
} from "./ipc/bridgeContract";
import {
  workspaceSyncOperations,
  CaptureHoldsEvent,
  workspaceFolderNameOperations,
  systemMotionOperations,
  systemPrivacySettingsOperations,
  serverAccountOperations,
  SitePreviewReplacedEvent,
  DesktopUserSettingsResult,
  AgentColorChangedEvent,
  ShareDirectWritesPushedEvent,
  shareDirectWriteDeliveryOperations,
  EngineYDocLineageReplacementEvent,
  EngineYDocRemoteUpdateEvent,
  EngineYDocOwnerHandoff,
  EngineYDocSaveStateEvent,
  ExitRoundAnswerPayload,
  ExitRoundMessage,
  ExplorerMenuCommand,
  MenuCommand,
  CrashReportChangedEvent,
  CollectionCopiesLeftChangedEvent,
  NoticesChangedEvent,
  LiveDraftRecoveryChangedEvent,
  SearchResultsEvent,
  FolderAppAnswer,
  ShareHandoffStatus,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
  WorkbenchMenuCommand,
  WorkspaceIdPayload,
  WorkspaceActivated,
  WorkspacePathOpenFailedEvent,
  WindowFullScreenEvent,
  crashReportOperations,
  collectionCopiesLeftOperations,
  workspaceTrustOperations,
  WorkspaceTrustChangedEvent,
  captureRecoveryOperations,
  fileObservationOperations,
  reportingOperations,
  usageRecordOperations,
  UsageRecordStoppedEvent,
  noticeOperations,
  liveDraftRecoveryOperations,
  stopAndRestoreRecoveryOperations,
  scheduleHostOperations,
  chatDispatchNoticeOperations,
  agentRunStateOperations,
  chatDispatchPauseOperations,
  ChatDispatchPausedEvent,
  ChatAgentRequestsChangedEvent,
  sharedViewAccessOperations,
  ScheduleHostChangedEvent,
  ChatDispatchNoticesEvent,
  AgentRunStateEvent,
  workspaceSearchOperations,
  folderAppOfferOperations,
  workspaceVersionOperations,
  historyOperations,
  engineYDocAdmissionOperations,
  engineYDocSaveOperations,
  parseWorkspaceActivityEventForIpc,
  databaseImportOperations,
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

// A menu command that arrives before anything listens, as when the command
// opened this window, waits for the first listener.
const menuCommandListeners = new Set<(command: MenuCommand) => void>();
const heldMenuCommands: MenuCommand[] = [];
ipcRenderer.on(CHANNELS.menuCommand, (_event, raw: unknown) => {
  const parsed = MenuCommand.safeParse(raw);
  if (!parsed.success) return;
  if (menuCommandListeners.size === 0) heldMenuCommands.push(parsed.data);
  for (const listener of [...menuCommandListeners]) listener(parsed.data);
});

// The entire bridge surface. Narrow on purpose: the renderer gets named,
// typed operations — never raw ipcRenderer, never Node. Typed as
// DohcDesktopBridge so it cannot drift from the contract (a missing or
// mistyped method fails the desktop typecheck).
// One unforgeable identity per preload/document lifetime. Main uses it to
// reject IPC that the outgoing document queued while renderer reload cleanup
// was draining on the same WebContents object.
const rendererDocumentId = crypto.randomUUID();
const relay = operationBridge(relayShareOperations, invoke);

const bridge: DohcDesktopBridge = {
  ...operationBridge(workspaceFileOperations, invoke),
  ...operationBridge(settingsOperations, invoke),
  ...operationBridge(chatOperations, invoke),
  ...operationBridge(shareHandoffOperations, invoke),
  ...operationBridge(shareMountOperations, invoke),
  ...operationBridge(shareProposalOperations, invoke),
  ...operationBridge(sharedChannelOperations, invoke),
  ...relay,
  ownerRestore: relay.ownerRestore as DohcDesktopBridge["ownerRestore"],
  ...operationBridge(workspaceFolderNameOperations, invoke),
  ...operationBridge(systemMotionOperations, invoke),
  ...operationBridge(systemPrivacySettingsOperations, invoke),
  ...operationBridge(serverAccountOperations, invoke),
  ...operationBridge(historyOperations, invoke),
  ...operationBridge(shareDirectWriteDeliveryOperations, invoke),
  ...operationBridge(shareCopyOperations, invoke),
  ...operationBridge(linksOperations, invoke),
  ...operationBridge(accessOperations, invoke),
  platform: process.platform,
  devTools: devToolsGranted(process.argv),
  releaseChannel: releaseChannelFromArgv(process.argv),
  insecureLoopbackServersForTests: insecureLoopbackServersForTests(process.env),
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
  listCollections: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollections, payload),
  getCollection: (payload) =>
    ipcRenderer.invoke(CHANNELS.getCollection, payload),
  queryCollectionRecords: (payload) =>
    ipcRenderer.invoke(CHANNELS.queryCollectionRecords, payload),
  createCollectionRecord: (payload) => ipcRenderer.invoke(CHANNELS.createCollectionRecord, payload),
  getCollectionRecordHistory: (payload) =>
    ipcRenderer.invoke(CHANNELS.getCollectionRecordHistory, payload),
  locateRecordHistoryRun: (payload) => ipcRenderer.invoke(CHANNELS.locateRecordHistoryRun, payload),
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
  // picker-grade import path (files and folders, never a workspace's .dohc).
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
  listWorkspaceHeadings: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceHeadings, payload),
  readWorkspaceDatabase: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceDatabase, payload),
  readWorkspaceDatabasePage: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceDatabasePage, payload),
  applyDatabaseEdit: (payload) =>
    ipcRenderer.invoke(CHANNELS.applyDatabaseEdit, payload),
  ...operationBridge(databaseImportOperations, invoke),
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
  onShareHandoffStatus: (listener) =>
    onEvent(CHANNELS.shareHandoffStatus, ShareHandoffStatus, listener),
  ...operationBridge(workspaceSyncOperations, invoke),
  cloudEnableSync: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudEnableSync, payload),
  cloudJoinWorkspace: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudJoinWorkspace, payload),
  publishOwnerApp: async (payload: OwnerAppPublicationRequest) => OwnerAppPublicationResult.parse(
    await ipcRenderer.invoke(CHANNELS.publishOwnerApp, OwnerAppPublicationRequest.parse(payload))),
  ...operationBridge(datasetOperations, invoke),
  ownerAppResponses:async(payload:OwnerAppResponsesRequest)=>OwnerAppResponsesResult.parse(await ipcRenderer.invoke(CHANNELS.ownerAppResponses,OwnerAppResponsesRequest.parse(payload))),
  ...operationBridge(sharedViewAccessOperations, invoke),
  listCollectionAutomations: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollectionAutomations, payload),
  switchCollectionAutomation: (payload) => ipcRenderer.invoke(CHANNELS.switchCollectionAutomation, payload),
  resolveAutomationControls: (payload) => ipcRenderer.invoke(CHANNELS.resolveAutomationControls, payload),
  listCollectionAutomationRuns: (payload) =>
    ipcRenderer.invoke(CHANNELS.listCollectionAutomationRuns, payload),
  getCollectionAutomationRun: (payload) =>
    ipcRenderer.invoke(CHANNELS.getCollectionAutomationRun, payload),
  listServerAutomationRuns: (payload) =>
    ipcRenderer.invoke(CHANNELS.listServerAutomationRuns, payload),
  retryCollectionAutomation: (payload) =>
    ipcRenderer.invoke(CHANNELS.retryCollectionAutomation, payload),
  undoCollectionAutomationRun: (payload) =>
    ipcRenderer.invoke(CHANNELS.undoCollectionAutomationRun, payload),
  listAutomationTargets: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationTargets, payload),
  listAutomationGroups: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationGroups, payload),
  listAutomationPeople: (payload) =>
    ipcRenderer.invoke(CHANNELS.listAutomationPeople, payload),
  checkCollectionAutomation: (payload) =>
    ipcRenderer.invoke(CHANNELS.checkCollectionAutomation, payload),
  stopAndRestore: (payload) =>
    ipcRenderer.invoke(CHANNELS.stopAndRestore, payload),
  ...operationBridge(stopAndRestoreRecoveryOperations, invoke),
  ...operationBridge(liveDraftRecoveryOperations, invoke),
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
  listServerAutomationHolds: (payload) =>
    ipcRenderer.invoke(CHANNELS.listServerAutomationHolds, payload),
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
  findAutomationCollection: (payload) =>
    ipcRenderer.invoke(CHANNELS.findAutomationCollection, payload),
  onHistoryNamesChanged: (listener) => onEvent(CHANNELS.historyNamesChanged, WorkspaceIdPayload, listener),
  onCollectionAutomationsChanged: (listener) =>
    onEvent(CHANNELS.collectionAutomationsChanged, WorkspaceIdPayload, listener),
  onAutomationRunsChanged: (
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
    ipcRenderer.on(CHANNELS.automationRunsChanged, handler);
    return () =>
      ipcRenderer.removeListener(CHANNELS.automationRunsChanged, handler);
  },
  ...operationBridge(crashReportOperations, invoke),
  ...operationBridge(reportingOperations, invoke),
  ...operationBridge(usageRecordOperations, invoke),
  onUsageRecordStopped: (listener) =>
    onEvent(CHANNELS.usageRecordStopped, UsageRecordStoppedEvent, () => listener()),
  onCrashReportChanged: (listener) =>
    onEvent(CHANNELS.crashReportChanged, CrashReportChangedEvent, () => listener()),
  ...operationBridge(collectionCopiesLeftOperations, invoke),
  onCollectionCopiesLeftChanged: (listener) =>
    onEvent(CHANNELS.collectionCopiesLeftChanged, CollectionCopiesLeftChangedEvent, () => listener()),
  ...operationBridge(workspaceTrustOperations, invoke),
  onWorkspaceTrustChanged: (listener) =>
    onEvent(CHANNELS.workspaceTrustChanged, WorkspaceTrustChangedEvent, listener),
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
  onShareDirectWritesPushed: (listener, workspaceId) => {
    const subscriptionId = crypto.randomUUID();
    const identity = { workspaceId, rendererDocumentId, subscriptionId };
    const unsubscribe = onEvent(CHANNELS.shareDirectWritesPushed, ShareDirectWritesPushedEvent, event => {
      if (event.workspaceId !== workspaceId) return;
      const update = (action: "claim" | "acknowledge" | "release") => bridge.updateShareDirectWriteDelivery({
        ...identity, action, answerId: event.answerId,
      });
      listener(event, { claim: () => update("claim"), acknowledge: () => update("acknowledge"), release: () => update("release") });
    });
    const update = (listening: boolean) => {
      void bridge.updateShareDirectWriteDelivery({ ...identity, action: "listen", listening })
        .catch(error => console.error("[desktop] direct-write subscription failed:", error));
    };
    update(true);
    return () => { unsubscribe(); update(false); };
  },
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
  chatRunRecordsForThread: (payload) =>
    ipcRenderer.invoke(CHANNELS.chatRunRecordsForThread, payload),
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
  ...operationBridge(captureRecoveryOperations, invoke),
  ...operationBridge(fileObservationOperations, invoke),
  retryOwnerLiveDelivery: (payload) => ipcRenderer.invoke(CHANNELS.retryOwnerLiveDelivery, payload),
  retryFileRecovery: (payload) => ipcRenderer.invoke(CHANNELS.retryFileRecovery, payload),
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
  setTitlebarTheme: (payload) =>
    ipcRenderer.invoke(CHANNELS.setTitlebarTheme, payload),
  onWindowFullScreen: (listener) =>
    onEvent(CHANNELS.windowFullScreen, WindowFullScreenEvent, listener),
  onAgentColorChanged: listener => onEvent(CHANNELS.agentColorChanged, AgentColorChangedEvent, listener),
  onUserSettingsChanged: (listener) =>
    onEvent(CHANNELS.userSettingsChanged, DesktopUserSettingsResult, listener),
  stepWindowZoom: (payload) =>
    ipcRenderer.invoke(CHANNELS.stepWindowZoom, payload),
  onCaptureHolds: listener => onEvent(CHANNELS.captureHolds, CaptureHoldsEvent, listener),
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
  onMenuCommand: (listener) => {
    menuCommandListeners.add(listener);
    for (const command of heldMenuCommands.splice(0)) listener(command);
    return () => { menuCommandListeners.delete(listener); };
  },
  onWorkspaceActivated: (listener) =>
    onEvent(CHANNELS.workspaceActivated, WorkspaceActivated, ({ file, ...workspace }) => listener(workspace, file)),
  onWorkspacePathOpenFailed: (listener) =>
    onEvent(CHANNELS.workspacePathOpenFailed, WorkspacePathOpenFailedEvent, () => listener()),
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
  ...operationBridge(folderAppOfferOperations, invoke),
  onFolderAppChanged: listener => onEvent(CHANNELS.folderAppChanged, FolderAppAnswer, listener),
  onSearchResults: (listener) =>
    onEvent(CHANNELS.searchResults, SearchResultsEvent, listener),
  ...operationBridge(noticeOperations, invoke),
  ...operationBridge(scheduleHostOperations, invoke),
  ...operationBridge(chatDispatchNoticeOperations, invoke),
  onNoticesChanged: (listener) =>
    onEvent(CHANNELS.noticesChanged, NoticesChangedEvent, () => listener()),
  onLiveDraftRecoveryChanged: (listener) =>
    onEvent(CHANNELS.liveDraftRecoveryChanged, LiveDraftRecoveryChangedEvent, listener),
  onScheduleHostChanged: (listener) =>
    onEvent(CHANNELS.scheduleHostChanged, ScheduleHostChangedEvent, listener),
  onChatDispatchNotices: (listener) =>
    onEvent(CHANNELS.chatDispatchNotices, ChatDispatchNoticesEvent, listener),
  ...operationBridge(agentRunStateOperations, invoke),
  onAgentRunState: (listener) =>
    onEvent(CHANNELS.agentRunState, AgentRunStateEvent, listener),
  ...operationBridge(chatDispatchPauseOperations, invoke),
  onChatDispatchPaused: (listener) =>
    onEvent(CHANNELS.chatDispatchPaused, ChatDispatchPausedEvent, listener),
  onChatAgentRequestsChanged: (listener) =>
    onEvent(CHANNELS.chatAgentRequestsChanged, ChatAgentRequestsChangedEvent, listener),
  // Engine Y.Doc editor binding.
  // Updates cross as raw Uint8Array (structured clone); the sessionId
  // round-trips so the renderer applies forwarded deltas only for the bound
  // session.
  openEngineYDocSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocOpen, payload),
  ...operationBridge(engineYDocAdmissionOperations, invoke),
  ...operationBridge(engineYDocSaveOperations, invoke),
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
