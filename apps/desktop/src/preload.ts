import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateLocalWorkspacePayload,
  DohcDesktopBridge,
  MenuCommand,
} from "./ipc/bridgeContract";
import { CHANNELS, isMenuCommand } from "./ipc/channels";

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
  importWorkspaceFiles: (payload) =>
    ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
  readWorkspaceText: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceText, payload),
  writeWorkspaceText: (payload) =>
    ipcRenderer.invoke(CHANNELS.writeWorkspaceText, payload),
  openFileExternally: (payload) =>
    ipcRenderer.invoke(CHANNELS.openFileExternally, payload),
  readWorkspaceDatabase: (payload) =>
    ipcRenderer.invoke(CHANNELS.readWorkspaceDatabase, payload),
  applyDatabaseEdit: (payload) =>
    ipcRenderer.invoke(CHANNELS.applyDatabaseEdit, payload),
  importToDatabase: (payload) =>
    ipcRenderer.invoke(CHANNELS.importToDatabase, payload),
  getAppPackage: (payload) => ipcRenderer.invoke(CHANNELS.getAppPackage, payload),
  runAppTester: (payload) => ipcRenderer.invoke(CHANNELS.runAppTester, payload),
  grantAppTrust: (payload) => ipcRenderer.invoke(CHANNELS.grantAppTrust, payload),
  openExternalUrl: (payload) =>
    ipcRenderer.invoke(CHANNELS.openExternalUrl, payload),
  cloudLoginStart: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudLoginStart, payload),
  cloudLoginPoll: () => ipcRenderer.invoke(CHANNELS.cloudLoginPoll),
  cloudStatus: (payload) => ipcRenderer.invoke(CHANNELS.cloudStatus, payload),
  cloudLogout: () => ipcRenderer.invoke(CHANNELS.cloudLogout),
  cloudEnableSync: (payload) =>
    ipcRenderer.invoke(CHANNELS.cloudEnableSync, payload),
  collabToken: (payload) => ipcRenderer.invoke(CHANNELS.collabToken, payload),
  openWorkspace: (payload) => ipcRenderer.invoke(CHANNELS.openWorkspace, payload),
  listChangeSets: (payload) =>
    ipcRenderer.invoke(CHANNELS.listChangeSets, payload),
  getSyncStatus: (payload) => ipcRenderer.invoke(CHANNELS.getSyncStatus, payload),
  startAgentRun: (payload) => ipcRenderer.invoke(CHANNELS.startAgentRun, payload),
  endAgentRun: (payload) => ipcRenderer.invoke(CHANNELS.endAgentRun, payload),
  getAgentRunStatus: (payload) =>
    ipcRenderer.invoke(CHANNELS.getAgentRunStatus, payload),
  getMcpConfig: (payload) => ipcRenderer.invoke(CHANNELS.getMcpConfig, payload),
  setTitlebarTheme: (payload) =>
    ipcRenderer.invoke(CHANNELS.setTitlebarTheme, payload),
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
