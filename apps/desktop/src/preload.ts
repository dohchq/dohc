import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  CreateLocalWorkspacePayload,
  DohcDesktopBridge,
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
import {
  CHANNELS,
  isExplorerMenuCommand,
  isMenuCommand,
  isWorkbenchMenuCommand,
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
  createDataFragment: (payload) =>
    ipcRenderer.invoke(CHANNELS.createDataFragment, payload),
  listDataFragments: (payload) =>
    ipcRenderer.invoke(CHANNELS.listDataFragments, payload),
  readDataFragment: (payload) =>
    ipcRenderer.invoke(CHANNELS.readDataFragment, payload),
  revokeDataFragment: (payload) =>
    ipcRenderer.invoke(CHANNELS.revokeDataFragment, payload),
  readWorkspaceText: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceText, payload),
  writeWorkspaceText: (payload) =>
    ipcRenderer.invoke(CHANNELS.writeWorkspaceText, payload),
  openFileExternally: (payload) =>
    ipcRenderer.invoke(CHANNELS.openFileExternally, payload),
  readWorkspaceGraph: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceGraph, payload),
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
  openExternalUrl: (payload) =>
    ipcRenderer.invoke(CHANNELS.openExternalUrl, payload),
  cloudLoginStart: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudLoginStart, payload),
  cloudLoginPoll: () => ipcRenderer.invoke(CHANNELS.cloudLoginPoll),
  cloudStatus: (payload) => ipcRenderer.invoke(CHANNELS.cloudStatus, payload),
  cloudLogout: () => ipcRenderer.invoke(CHANNELS.cloudLogout),
  cloudEnableSync: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudEnableSync, payload),
  listWorkspaceShares: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceShares, payload),
  createWorkspaceShare: (payload) =>
    ipcRenderer.invoke(CHANNELS.createWorkspaceShare, payload),
  revokeWorkspaceShare: (payload) =>
    ipcRenderer.invoke(CHANNELS.revokeWorkspaceShare, payload),
  listWorkspaceMembers: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceMembers, payload),
  listWorkspaceInvites: (payload) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceInvites, payload),
  createWorkspaceInvite: (payload) =>
    ipcRenderer.invoke(CHANNELS.createWorkspaceInvite, payload),
  revokeWorkspaceInvite: (payload) =>
    ipcRenderer.invoke(CHANNELS.revokeWorkspaceInvite, payload),
  collabToken: (payload) => ipcRenderer.invoke(CHANNELS.collabToken, payload),
  openWorkspace: (payload) => ipcRenderer.invoke(CHANNELS.openWorkspace, payload),
  listChangeSets: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChangeSets, payload),
  readChangeSet: (payload) =>
    ipcRenderer.invoke(CHANNELS.readChangeSet, payload),
  restoreHistoryFile: (payload) =>
    ipcRenderer.invoke(CHANNELS.restoreHistoryFile, payload),
  undoHistoryFileRestore: (payload) =>
    ipcRenderer.invoke(CHANNELS.undoHistoryFileRestore, payload),
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
  startAgentSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.startAgentSession, payload),
  stopAgentSession: (payload) =>
    ipcRenderer.invoke(CHANNELS.stopAgentSession, payload),
  answerAgentPermission: (payload) =>
    ipcRenderer.invoke(CHANNELS.answerAgentPermission, payload),
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
