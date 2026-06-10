import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./ipc/channels";

// The entire bridge surface. Narrow on purpose: the renderer gets named,
// typed operations — never raw ipcRenderer, never Node.
contextBridge.exposeInMainWorld("dohcDesktop", {
  getVersion: () => ipcRenderer.invoke(CHANNELS.getVersion),
  pickWorkspaceRoot: () => ipcRenderer.invoke(CHANNELS.pickWorkspaceRoot),
  getWorkspaceRegistry: () => ipcRenderer.invoke(CHANNELS.getWorkspaceRegistry),
  getDefaultWorkspaceRoot: () =>
    ipcRenderer.invoke(CHANNELS.getDefaultWorkspaceRoot),
  createLocalWorkspace: (payload: { rootPath: string; kind: string }) =>
    ipcRenderer.invoke(CHANNELS.createLocalWorkspace, payload),
  attachWorkspaceFolder: (payload: { rootPath: string }) =>
    ipcRenderer.invoke(CHANNELS.attachWorkspaceFolder, payload),
  listWorkspaceFiles: (payload: { workspaceId: string }) =>
    ipcRenderer.invoke(CHANNELS.listWorkspaceFiles, payload),
  createWorkspaceFile: (payload: {
    workspaceId: string;
    relativePath: string;
  }) => ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
  importWorkspaceFiles: (payload: { workspaceId: string }) =>
    ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
});

// One-shot paint signal for launch instrumentation (no data, no response).
contextBridge.exposeInMainWorld("dohcDesktopInternal", {
  firstPaint: () => ipcRenderer.send(CHANNELS.firstPaint),
});

if (process.env.DOHC_DESKTOP_TEST === "1") {
  contextBridge.exposeInMainWorld("dohcDesktopTest", {
    getLaunchMarks: () => ipcRenderer.invoke(CHANNELS.getLaunchMarks),
  });
}
