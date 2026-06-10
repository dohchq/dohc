import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  decideWindowOpen,
  type NavigationPolicy,
} from "../security/electronSecurity";

// Warm paper — set before first paint so launch never flashes white.
const BACKGROUND_COLOR = "#faf7f2";

export function navigationPolicy(): NavigationPolicy {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    // Dev: exact dev-server origin only; no file navigation at all.
    return { httpOrigins: [new URL(devServer).origin], fileUrlPrefix: null };
  }
  // Prod: only the packaged renderer bundle directory.
  const rendererDir = join(import.meta.dirname, "../renderer/");
  return { httpOrigins: [], fileUrlPrefix: pathToFileURL(rendererDir).href };
}

export function createMainWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: BACKGROUND_COLOR,
    webPreferences: createMainWindowWebPreferences(preloadPath),
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url);
    if (decision.openExternal) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (decideNavigation(url, navigationPolicy()).action === "deny") {
      event.preventDefault();
    }
  });

  window.once("ready-to-show", () => window.show());

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}
