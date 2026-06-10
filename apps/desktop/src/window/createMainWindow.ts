import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  validateDevServerUrl,
  type NavigationPolicy,
} from "../security/electronSecurity";

// Warm paper — set before first paint so launch never flashes white.
const BACKGROUND_COLOR = "#faf7f2";

function devServerUrl(): string | null {
  return validateDevServerUrl(
    process.env.ELECTRON_RENDERER_URL,
    app.isPackaged,
  );
}

export function navigationPolicy(): NavigationPolicy {
  const devServer = devServerUrl();
  if (devServer) {
    // Dev: exact loopback dev-server origin only; no file navigation at all.
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

  // window.open is a pure deny with NO side effects: renderer content (file
  // views today, app iframes in 7b) must never reach the OS browser except
  // through the explicit, audited openExternalUrl IPC.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Top-frame navigations, server redirects, and subframe navigations all
  // go through the same policy: each is a separate Electron surface.
  const denyDisallowed = (event: { preventDefault(): void }, url: string) => {
    if (decideNavigation(url, navigationPolicy()).action === "deny") {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", denyDisallowed);
  window.webContents.on("will-redirect", denyDisallowed);
  window.webContents.on("will-frame-navigate", (event) => {
    denyDisallowed(event, event.url);
  });

  window.once("ready-to-show", () => window.show());

  const devServer = devServerUrl();
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}
