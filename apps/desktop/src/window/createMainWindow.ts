import { app, BrowserWindow, nativeTheme, screen } from "electron";
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
  initialChromeTheme,
  MIN_WINDOW_SIZE,
  parseWindowState,
  planWindowPlacement,
  serializeWindowState,
  WINDOW_STATE_FILE,
  type ChromeTheme,
} from "./windowState";

// The theme the native chrome was last told about: persisted-on-disk theme at
// launch, then whatever the renderer's theme.ts reports on every flip. A
// single window owns the chrome, so module state + one persist hook suffice.
let chromeTheme: ChromeTheme = "light";
let persistCurrentWindow: (() => void) | null = null;

// Called by the desktop:set-titlebar-theme IPC handler so the NEXT launch
// paints the correct chrome before any renderer JS runs.
export function rememberChromeTheme(theme: ChromeTheme): void {
  if (chromeTheme === theme) return;
  chromeTheme = theme;
  persistCurrentWindow?.();
}

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

const allowedSitePreviewOrigins = new Map<string, number>();

function normalizeLoopbackHostname(hostname: string): string {
  // Node's WHATWG URL implementation currently returns "[::1]" for hostname,
  // so normalize both bracketed and unbracketed forms before comparison.
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function loopbackHttpOrigin(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(
        normalizeLoopbackHostname(url.hostname),
      )
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function allowSitePreviewOrigin(previewUrl: string): () => void {
  const origin = loopbackHttpOrigin(previewUrl);
  if (!origin) return () => undefined;
  allowedSitePreviewOrigins.set(
    origin,
    (allowedSitePreviewOrigins.get(origin) ?? 0) + 1,
  );
  return () => {
    const count = allowedSitePreviewOrigins.get(origin) ?? 0;
    if (count <= 1) allowedSitePreviewOrigins.delete(origin);
    else allowedSitePreviewOrigins.set(origin, count - 1);
  };
}

function isAllowedSitePreviewUrl(targetUrl: string): boolean {
  const origin = loopbackHttpOrigin(targetUrl);
  return origin !== null && allowedSitePreviewOrigins.has(origin);
}

function loadPlacement() {
  let raw: string | null = null;
  try {
    raw = readFileSync(windowStateFile(), "utf8");
  } catch {
    // First launch / unreadable state: centered default.
  }
  const state = parseWindowState(raw);
  const displays = screen.getAllDisplays().map((display) => display.bounds);
  return {
    ...planWindowPlacement(state, displays),
    theme: initialChromeTheme(state, nativeTheme.shouldUseDarkColors),
  };
}

function trackWindowState(window: BrowserWindow): void {
  const persist = () => {
    if (window.isDestroyed()) return;
    const state = {
      bounds: window.getNormalBounds(),
      isMaximized: window.isMaximized(),
      theme: chromeTheme,
    };
    try {
      writeFileSync(windowStateFile(), serializeWindowState(state));
    } catch {
      // Window state is a convenience; a read-only disk must not break the app.
    }
  };
  persistCurrentWindow = persist;
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
  // Native chrome paints the LAUNCH theme (persisted user choice, else the OS
  // preference) before any renderer JS — no light flash on dark launches.
  chromeTheme = placement.theme;
  // Dev/Linux window icon; packaged builds get theirs from electron-builder.
  const iconPath = join(import.meta.dirname, "../../build/icon.png");

  const window = new BrowserWindow({
    show: false,
    ...(placement.bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    backgroundColor: palette[placement.theme].bg,
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
          titleBarOverlay: titleBarOverlayOptions(placement.theme),
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
    if (isAllowedSitePreviewUrl(event.url)) return;
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
