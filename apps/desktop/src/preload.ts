import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  CreateLocalWorkspacePayload,
  DohcDesktopBridge,
  InvokeSiteSdkPayload,
  ListSitesPayload,
  MenuCommand,
  SetUserSettingsPayload,
  SetWorkspaceSettingsPayload,
  SitePackagePayload,
  StartSitePreviewPayload,
  StopSitePreviewPayload,
  WorkspaceSettingsPayload,
  WorkspaceSummary,
  WriteClipboardTextPayload,
} from "./ipc/bridgeContract";
import { parseInvokeSiteSdkPayloadForIpc } from "./ipc/bridgeContract";
import {
  CHANNELS,
  isExplorerMenuCommand,
  isMenuCommand,
  isWorkbenchMenuCommand,
  parseEngineYDocRemoteUpdateEvent,
  parseEngineYDocSaveStateEvent,
  parseSearchResultsEvent,
  parseUpdateStateEvent,
  parseWorkspaceActivatedEvent,
} from "./ipc/channels";

// The entire bridge surface. Narrow on purpose: the renderer gets named,
// typed operations — never raw ipcRenderer, never Node. Typed as
// DohcDesktopBridge so it cannot drift from the contract (a missing or
// mistyped method fails the desktop typecheck).
const bridge: DohcDesktopBridge = {
  platform: process.platform,
  reloadRenderer: () => ipcRenderer.invoke(CHANNELS.reloadRenderer),
  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
  getDefaultWorkspaceRoot: () =>
    ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
  createLocalWorkspace: (payload: CreateLocalWorkspacePayload) =>
    ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
  attachWorkspaceFolder: (payload) =>
    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
  listWorkspaceFiles: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
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
  // The invoke RESULT is validated here like main→renderer events are: only
  // an exact member of the closed EXPLORER_MENU_COMMANDS tuple reaches
  // renderer code — anything else reads as null ("dismissed").
  showExplorerMenu: async (payload) => {
    const result: unknown = await ipcRenderer.invoke(
      CHANNELS.showExplorerMenu,
      payload,
    );
    return isExplorerMenuCommand(result) ? result : null;
  },
  showWorkbenchMenu: async (payload) => {
    const result: unknown = await ipcRenderer.invoke(
      CHANNELS.showWorkbenchMenu,
      payload,
    );
    return isWorkbenchMenuCommand(result) ? result : null;
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
  stopSitePreview: (payload: StopSitePreviewPayload) =>
    ipcRenderer.invoke(CHANNELS.stopSitePreview, payload),
  invokeSiteSdk: (payload: InvokeSiteSdkPayload) =>
    ipcRenderer.invoke(
      CHANNELS.invokeSiteSdk,
      parseInvokeSiteSdkPayloadForIpc(payload),
    ),
  openExternalUrl: (payload) =>
    ipcRenderer.invoke(CHANNELS.openExternalUrl, payload),
  cloudLoginStart: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudLoginStart, payload),
  cloudLoginPoll: () => ipcRenderer.invoke(CHANNELS.cloudLoginPoll),
  cloudStatus: (payload) => ipcRenderer.invoke(CHANNELS.cloudStatus, payload),
  cloudLogout: () => ipcRenderer.invoke(CHANNELS.cloudLogout),
  cloudEnableSync: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudEnableSync, payload),
  cloudJoinWorkspace: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudJoinWorkspace, payload),
  dismissSyncReviewNotice: (payload) =>
    ipcRenderer.invoke(CHANNELS.dismissSyncReviewNotice, payload),
  createRelayShare: (payload) => ipcRenderer.invoke(CHANNELS.createRelayShare, payload),
  listRelayShares: () => ipcRenderer.invoke(CHANNELS.listRelayShares),
  revokeRelayShare: (payload) => ipcRenderer.invoke(CHANNELS.revokeRelayShare, payload),
  shareChatChannel: (payload) => ipcRenderer.invoke(CHANNELS.shareChatChannel, payload),
  listChatChannelShares: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChatChannelShares, payload),
  joinSharedChannel: (payload) => ipcRenderer.invoke(CHANNELS.joinSharedChannel, payload),
  leaveSharedChannel: (payload) =>
    ipcRenderer.invoke(CHANNELS.leaveSharedChannel, payload),
  openSharedView: (payload) => ipcRenderer.invoke(CHANNELS.openSharedView, payload),
  refreshSharedView: (payload) => ipcRenderer.invoke(CHANNELS.refreshSharedView, payload),
  mountShare: (payload) => ipcRenderer.invoke(CHANNELS.mountShare, payload),
  refreshShareMounts: (payload) => ipcRenderer.invoke(CHANNELS.refreshShareMounts, payload),
  unmountShare: (payload) => ipcRenderer.invoke(CHANNELS.unmountShare, payload),
  openWorkspace: (payload) => ipcRenderer.invoke(CHANNELS.openWorkspace, payload),
  listWorkspaceVersions: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceVersions, payload),
  createWorkspaceVersion: (payload) =>
    ipcRenderer.invoke(CHANNELS.createWorkspaceVersion, payload),
  switchWorkspaceVersion: (payload) =>
    ipcRenderer.invoke(CHANNELS.switchWorkspaceVersion, payload),
  compareWorkspaceVersions: (payload) =>
    ipcRenderer.invoke(CHANNELS.compareWorkspaceVersions, payload),
  mergeWorkspaceVersion: (payload) =>
    ipcRenderer.invoke(CHANNELS.mergeWorkspaceVersion, payload),
  listWorkspaceVersionConflicts: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceVersionConflicts, payload),
  resolveWorkspaceVersionConflict: (payload) =>
    ipcRenderer.invoke(CHANNELS.resolveWorkspaceVersionConflict, payload),
  tryInWorkspaceVersion: (payload) =>
    ipcRenderer.invoke(CHANNELS.tryInWorkspaceVersion, payload),
  getTryInVersionState: (payload) =>
    ipcRenderer.invoke(CHANNELS.getTryInVersionState, payload),
  dismissTryInVersionReview: (payload) =>
    ipcRenderer.invoke(CHANNELS.dismissTryInVersionReview, payload),
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
  startDm: (payload) => ipcRenderer.invoke(CHANNELS.startDm, payload),
  presencePublish: (payload) => ipcRenderer.invoke(CHANNELS.presencePublish, payload),
  presencePoll: (payload) => ipcRenderer.invoke(CHANNELS.presencePoll, payload),
  presenceCancel: (payload) => ipcRenderer.invoke(CHANNELS.presenceCancel, payload),
  getSyncStatus: (payload) => ipcRenderer.invoke(CHANNELS.getSyncStatus, payload),
  startAgentRun: (payload) => ipcRenderer.invoke(CHANNELS.startAgentRun, payload),
  endAgentRun: (payload) => ipcRenderer.invoke(CHANNELS.endAgentRun, payload),
  getAgentRunStatus: (payload) =>
    ipcRenderer.invoke(CHANNELS.getAgentRunStatus, payload),
  getMcpConfig: (payload) => ipcRenderer.invoke(CHANNELS.getMcpConfig, payload),
  probeAgentDrivers: (payload) =>
    ipcRenderer.invoke(CHANNELS.probeAgentDrivers, payload),
  getAgentSessionState: (payload) =>
    ipcRenderer.invoke(CHANNELS.getAgentSessionState, payload),
  answerAgentPermission: (payload) =>
    ipcRenderer.invoke(CHANNELS.answerAgentPermission, payload),
  stopAgentRun: (payload) =>
    ipcRenderer.invoke(CHANNELS.stopAgentRun, payload),
  resumeThreadDispatch: (payload) =>
    ipcRenderer.invoke(CHANNELS.resumeThreadDispatch, payload),
  chatDispatchStateForThread: (payload) =>
    ipcRenderer.invoke(CHANNELS.chatDispatchStateForThread, payload),
  runnerSelfTest: (payload) =>
    ipcRenderer.invoke(CHANNELS.runnerSelfTest, payload),
  getUserSettings: () => ipcRenderer.invoke(CHANNELS.getUserSettings),
  setUserSettings: (payload: SetUserSettingsPayload) =>
    ipcRenderer.invoke(CHANNELS.setUserSettings, payload),
  resetUserSettings: () => ipcRenderer.invoke(CHANNELS.resetUserSettings),
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
  getWorkspaceUiState: (payload) =>
    ipcRenderer.invoke(CHANNELS.getWorkspaceUiState, payload),
  setWorkspaceUiState: (payload) =>
    ipcRenderer.invoke(CHANNELS.setWorkspaceUiState, payload),
  onWorkspaceActivity: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(CHANNELS.workspaceActivity, handler);
    return () => ipcRenderer.removeListener(CHANNELS.workspaceActivity, handler);
  },
  // Event payloads from main are still validated at this boundary: only a
  // command from the closed MENU_COMMANDS set ever reaches renderer code
  // (isMenuCommand — unit-tested against String objects/toString tricks; the
  // sandboxed preload stays dependency-free, bridgeContract's MenuCommand
  // enum derives from the same tuple so the two can never drift).
  onMenuCommand: (listener) => {
    const handler = (_event: unknown, command: unknown) => {
      if (isMenuCommand(command)) {
        listener(command as MenuCommand);
      }
    };
    ipcRenderer.on(CHANNELS.menuCommand, handler);
    return () => ipcRenderer.removeListener(CHANNELS.menuCommand, handler);
  },
  onWorkspaceActivated: (listener) => {
    const handler = (_event: unknown, raw: unknown) => {
      const workspace = parseWorkspaceActivatedEvent(raw);
      if (workspace) listener(workspace as WorkspaceSummary);
    };
    ipcRenderer.on(CHANNELS.workspaceActivated, handler);
    return () => ipcRenderer.removeListener(CHANNELS.workspaceActivated, handler);
  },
  // Same boundary rule as onMenuCommand: only a value that passes the closed
  // dependency-free check (parseUpdateStateEvent — exact tuple member status,
  // bounded primitive string message) reaches renderer code, and only the two
  // validated fields cross, never the raw event payload.
  onUpdateState: (listener) => {
    const handler = (_event: unknown, raw: unknown) => {
      const state = parseUpdateStateEvent(raw);
      if (state) listener(state);
    };
    ipcRenderer.on(CHANNELS.updateState, handler);
    return () => ipcRenderer.removeListener(CHANNELS.updateState, handler);
  },
  getUpdateState: async () => {
    const result: unknown = await ipcRenderer.invoke(CHANNELS.getUpdateState);
    const state = parseUpdateStateEvent(result);
    if (!state) throw new Error("Invalid update state from main process.");
    return state;
  },
  checkForUpdates: async () => {
    const result: unknown = await ipcRenderer.invoke(CHANNELS.checkForUpdates);
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("Invalid update check result from main process.");
    }
    const raw = result as Record<string, unknown>;
    const state = parseUpdateStateEvent(raw.state);
    if (typeof raw.checked !== "boolean" || !state) {
      throw new Error("Invalid update check result from main process.");
    }
    return { checked: raw.checked, state };
  },
  installUpdate: async () => {
    const result: unknown = await ipcRenderer.invoke(CHANNELS.installUpdate);
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("Invalid update install result from main process.");
    }
    const raw = result as Record<string, unknown>;
    const state = parseUpdateStateEvent(raw.state);
    if (
      typeof raw.accepted !== "boolean" ||
      typeof raw.completed !== "boolean" ||
      !state
    ) {
      throw new Error("Invalid update install result from main process.");
    }
    return { accepted: raw.accepted, completed: raw.completed, state };
  },
  // Content search (Phase E5.0): results stream main→renderer as bounded
  // batches; the searchId round-trips so stale batches drop renderer-side.
  searchWorkspace: (payload) =>
    ipcRenderer.invoke(CHANNELS.searchWorkspace, payload),
  cancelWorkspaceSearch: (payload) =>
    ipcRenderer.invoke(CHANNELS.cancelWorkspaceSearch, payload),
  // Same boundary rule as onUpdateState: every batch is validated by the
  // closed dependency-free parseSearchResultsEvent check (bounded searchId,
  // entries rebuilt field by field, every path lexically safe-relative) —
  // anything else never reaches renderer code.
  onSearchResults: (listener) => {
    const handler = (_event: unknown, raw: unknown) => {
      const batch = parseSearchResultsEvent(raw);
      if (batch) listener(batch);
    };
    ipcRenderer.on(CHANNELS.searchResults, handler);
    return () => ipcRenderer.removeListener(CHANNELS.searchResults, handler);
  },
  // WS-G2-C-2 engine Y.Doc editor binding: the drop-in for HocuspocusProvider.
  // Updates cross as raw Uint8Array (structured clone); the sessionId
  // round-trips so the renderer applies forwarded deltas only for the bound
  // session.
  openEngineYDocSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocOpen, payload),
  applyEngineYDocUpdate: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocApplyUpdate, payload),
  closeEngineYDocSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.engineYDocClose, payload),
  // Same boundary rule as onSearchResults: every event is validated by the
  // closed dependency-free parseEngineYDocRemoteUpdateEvent check (bounded
  // sessionId, real Uint8Array within the byte bound) before it reaches
  // renderer code.
  onEngineYDocRemoteUpdate: (listener) => {
    const handler = (_event: unknown, raw: unknown) => {
      const parsed = parseEngineYDocRemoteUpdateEvent(raw);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on(CHANNELS.engineYDocRemoteUpdate, handler);
    return () => ipcRenderer.removeListener(CHANNELS.engineYDocRemoteUpdate, handler);
  },
  onEngineYDocSaveState: (listener) => {
    const handler = (_event: unknown, raw: unknown) => {
      const parsed = parseEngineYDocSaveStateEvent(raw);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on(CHANNELS.engineYDocSaveState, handler);
    return () => ipcRenderer.removeListener(CHANNELS.engineYDocSaveState, handler);
  },
};

contextBridge.exposeInMainWorld("dohcDesktop", bridge);

// One-shot paint signal for launch instrumentation (no data, no response).
contextBridge.exposeInMainWorld("dohcDesktopInternal", {
  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
});

// Test-only bridge. The authoritative gate is the main-process handler, which
// is double-gated (env AND !app.isPackaged); the preload cannot read
// isPackaged, so this env-only check is intentionally the weaker side — never
// expose a data-returning test channel here without a matching double-gated
// handler. Build-time stripping lands with Phase 14 packaging.
if (process.env.DOHC_DESKTOP_TEST === "1") {
  contextBridge.exposeInMainWorld("dohcDesktopTest", {
    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
    getDesktopMarks: () => ipcRenderer.invoke(CHANNELS.getDesktopMarks),
  });
}
