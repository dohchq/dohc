import { app, BrowserWindow, screen } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { palette, TITLEBAR_HEIGHT_PX } from "../renderer/tokens";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  validateDevServerUrl,
  type NavigationPolicy,
} from "../security/electronSecurity";
import { stateDir } from "../workspaces/WorkspaceRegistry";
import {
  createDebouncedSaver,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  parseWindowState,
  planWindowPlacement,
  serializeWindowState,
  WINDOW_STATE_FILE,
} from "./windowState";

// Light bg token — set before first paint so launch never flashes a wrong
// color (index.html's first-paint block then takes over per theme).
const BACKGROUND_COLOR = palette.light.bg;

// The OS-drawn window controls (Windows/Linux overlay) re-tint with the app
// theme via the desktop:set-titlebar-theme IPC.
export function titleBarOverlayOptions(theme: "light" | "dark"): {
  height: number;
  color: string;
  symbolColor: string;
} {
  return {
    height: TITLEBAR_HEIGHT_PX,
    // Matches the Titlebar strip surface (panel-2), not the page bg.
    color: palette[theme].panel2,
    symbolColor: palette[theme].ink,
  };
}

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

function windowStateFile(): string {
  return join(stateDir(), WINDOW_STATE_FILE);
}

function loadPlacement() {
  let raw: string | null = null;
  try {
    raw = readFileSync(windowStateFile(), "utf8");
  } catch {
    // First launch / unreadable state: centered default.
  }
  const displays = screen.getAllDisplays().map((display) => display.bounds);
  return planWindowPlacement(parseWindowState(raw), displays);
}

function trackWindowState(window: BrowserWindow): void {
  const persist = () => {
    if (window.isDestroyed()) return;
    const state = {
      bounds: window.getNormalBounds(),
      isMaximized: window.isMaximized(),
    };
    try {
      writeFileSync(windowStateFile(), serializeWindowState(state));
    } catch {
      // Window state is a convenience; a read-only disk must not break the app.
    }
  };
  const saver = createDebouncedSaver(persist, 400);
  window.on("resize", saver.schedule);
  window.on("move", saver.schedule);
  window.on("maximize", saver.schedule);
  window.on("unmaximize", saver.schedule);
  // Final geometry must be durable even mid-debounce.
  window.on("close", () => {
    saver.flush();
    persist();
  });
}

export function createMainWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");
  const placement = loadPlacement();
  // Dev/Linux window icon; packaged builds get theirs from electron-builder.
  const iconPath = join(import.meta.dirname, "../../build/icon.png");

  const window = new BrowserWindow({
    show: false,
    ...(placement.bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    backgroundColor: BACKGROUND_COLOR,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    // Native chrome: the renderer draws the titlebar (Titlebar.tsx drag
    // strip); the OS draws only its window controls.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: titleBarOverlayOptions("light"),
        }),
    webPreferences: createMainWindowWebPreferences(preloadPath),
  });

  if (placement.isMaximized) window.maximize();
  trackWindowState(window);

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
