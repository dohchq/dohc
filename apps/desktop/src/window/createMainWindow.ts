import {
  app,
  BrowserWindow,
  nativeTheme,
  screen,
  type WebContents,
} from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { palette, TITLEBAR_HEIGHT_PX } from "../renderer/tokens";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  validateDevServerUrl,
  type NavigationPolicy,
} from "../security/electronSecurity";
import { isLoopbackHostname } from "../security/loopback";
import {
  resolveDesktopIconDirectory,
  resolveSystemThemeIconPath,
} from "../systemThemeIcon";
import { stateDir } from "../workspaces/WorkspaceRegistry";
import { installRendererCrashRecovery } from "./rendererCrashRecovery";
import {
  createDebouncedSaver,
  DEFAULT_WINDOW_SIZE,
  initialChromeTheme,
  MIN_WINDOW_SIZE,
  parseWindowState,
  planWindowPlacement,
  serializeWindowState,
  MANAGER_WINDOW_STATE_FILE,
  MANAGER_WINDOW_SIZE,
  WINDOW_STATE_FILE,
  type ChromeTheme,
} from "./windowState";

// The theme the native chrome was last told about: the persisted theme at
// launch, then whatever the renderer's theme.ts reports on every flip. One
// theme for the app. A flip patches the theme into every role's state file
// on disk, open or closed, without touching that file's geometry, so the
// next launch of either role paints the current theme.
let chromeTheme: ChromeTheme | null = null;
const WINDOW_ROLES = ["workspace", "manager"] as const;
type StateFileIo = {
  read(file: string): string | null;
  write(file: string, contents: string): void;
};
let stateFileIo: StateFileIo = {
  read(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  write: writeFileSync,
};

function writeThemeIntoStateFile(role: WindowRole, theme: ChromeTheme): void {
  const file = windowStateFile(role);
  const state = parseWindowState(
    stateFileIo.read(file),
    role === "manager" ? MANAGER_WINDOW_SIZE : MIN_WINDOW_SIZE,
  );
  // A role never opened has no geometry to keep; its first window writes
  // the running theme with its own bounds.
  if (!state) return;
  try {
    stateFileIo.write(file, serializeWindowState({ ...state, theme }));
  } catch {
    // Window state is a convenience; a read-only disk must not break the app.
  }
}

// Called by the desktop:set-titlebar-theme IPC handler so the next launch
// paints the correct chrome before any renderer JS runs.
export function rememberChromeTheme(theme: ChromeTheme): void {
  if (chromeTheme === theme) return;
  chromeTheme = theme;
  for (const role of WINDOW_ROLES) writeThemeIntoStateFile(role, theme);
}

// Test seam: the module theme is app-run scoped, and the test replaces disk.
export function resetChromeThemeForTests(io?: StateFileIo): void {
  chromeTheme = null;
  stateFileIo = io ?? {
    read(file) {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    write: writeFileSync,
  };
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

function windowStateFile(role: WindowRole = "workspace"): string {
  return join(stateDir(), role === "manager" ? MANAGER_WINDOW_STATE_FILE : WINDOW_STATE_FILE);
}

const allowedLoopbackFrameOrigins = new Map<string, number>();

function loopbackHttpOrigin(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function allowLoopbackFrameOrigin(frameUrl: string): () => void {
  const origin = loopbackHttpOrigin(frameUrl);
  if (!origin) return () => undefined;
  allowedLoopbackFrameOrigins.set(
    origin,
    (allowedLoopbackFrameOrigins.get(origin) ?? 0) + 1,
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const count = allowedLoopbackFrameOrigins.get(origin) ?? 0;
    if (count <= 1) allowedLoopbackFrameOrigins.delete(origin);
    else allowedLoopbackFrameOrigins.set(origin, count - 1);
  };
}

export function isAllowedLoopbackFrameUrl(targetUrl: string): boolean {
  const origin = loopbackHttpOrigin(targetUrl);
  return origin !== null && allowedLoopbackFrameOrigins.has(origin);
}

function loadPlacement(role: WindowRole = "workspace") {
  // First launch / unreadable state: centered default.
  const state = parseWindowState(
    stateFileIo.read(windowStateFile(role)),
    role === "manager" ? MANAGER_WINDOW_SIZE : MIN_WINDOW_SIZE,
  );
  const displays = screen.getAllDisplays().map((display) => display.bounds);
  return {
    ...planWindowPlacement(state, displays),
    theme: initialChromeTheme(state, nativeTheme.shouldUseDarkColors),
  };
}

interface TrackedWindow {
  isDestroyed(): boolean;
  getNormalBounds(): { x: number; y: number; width: number; height: number };
  isMaximized(): boolean;
  on(
    event: "resize" | "move" | "maximize" | "unmaximize" | "close" | "closed",
    listener: () => void,
  ): unknown;
}

// Exported for the window-state test; production calls it through
// createMainWindow. Each window writes only its own file, so two windows of
// one role cannot overwrite each other's newer geometry on a theme flip.
export function trackWindowState(
  window: TrackedWindow,
  role: WindowRole = "workspace",
): void {
  const persist = () => {
    if (window.isDestroyed()) return;
    const state = {
      bounds: window.getNormalBounds(),
      isMaximized: window.isMaximized(),
      ...(chromeTheme ? { theme: chromeTheme } : {}),
    };
    try {
      stateFileIo.write(windowStateFile(role), serializeWindowState(state));
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

// Exported for the theme test: the same read a launch performs.
export function persistedChromeTheme(role: WindowRole): ChromeTheme | undefined {
  return parseWindowState(
    stateFileIo.read(windowStateFile(role)),
    role === "manager" ? MANAGER_WINDOW_SIZE : MIN_WINDOW_SIZE,
  )?.theme;
}

export type WindowRole = "workspace" | "manager";

export function createMainWindow(options?: {
  beforeRendererReload?: (sender: WebContents) => void | Promise<void>;
  // The manager is a smaller window that renders only the workspace
  // manager. It keeps its own bounds so it never fights the main window.
  role?: WindowRole;
  // Main-derived facts the preload reads from process.argv.
  preloadArguments?: readonly string[];
}): BrowserWindow {
  const role: WindowRole = options?.role ?? "workspace";
  const preloadPath = join(import.meta.dirname, "../preload/preload.cjs");
  const placement = loadPlacement(role);
  // Native chrome paints the launch theme (persisted user choice, else the OS
  // preference) before any renderer JS — no light flash on dark launches.
  // A window opened later follows the theme the app already runs in rather
  // than its own file, which may be older.
  chromeTheme ??= placement.theme;
  const theme = chromeTheme;
  // The executable and Wayland launcher keep the static packaging icon. Live
  // Windows/X11 window icons follow the OS appearance where the shell allows.
  const iconDirectory = resolveDesktopIconDirectory({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDirectory: import.meta.dirname,
  });
  const iconPath = resolveSystemThemeIconPath(
    iconDirectory,
    nativeTheme.shouldUseDarkColors,
  );

  const window = new BrowserWindow({
    show: false,
    ...(placement.bounds ?? (role === "manager" ? MANAGER_WINDOW_SIZE : DEFAULT_WINDOW_SIZE)),
    minWidth: role === "manager" ? MANAGER_WINDOW_SIZE.width : MIN_WINDOW_SIZE.width,
    minHeight: role === "manager" ? MANAGER_WINDOW_SIZE.height : MIN_WINDOW_SIZE.height,
    backgroundColor: palette[theme].bg,
    ...(iconPath ? { icon: iconPath } : {}),
    // Native chrome: the renderer draws the titlebar (Titlebar.tsx drag
    // strip); the OS draws only its window controls.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: titleBarOverlayOptions(theme),
        }),
    webPreferences: createMainWindowWebPreferences(preloadPath, options?.preloadArguments),
  });

  // BrowserWindow's `icon` option is ignored on macOS; set the Dock icon after
  // construction there. Windows and Linux already received the initial icon.
  if (process.platform === "darwin" && iconPath) app.dock?.setIcon(iconPath);

  if (placement.isMaximized) window.maximize();
  trackWindowState(window, role);

  // A crashed renderer reloads instead of leaving a permanently blank window
  // (crash-loop guarded) — see rendererCrashRecovery.ts.
  installRendererCrashRecovery(
    window.webContents,
    Date.now,
    options?.beforeRendererReload
      ? () => options.beforeRendererReload?.(window.webContents)
      : undefined,
  );

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
    if (isAllowedLoopbackFrameUrl(event.url)) return;
    denyDisallowed(event, event.url);
  });

  window.once("ready-to-show", () => window.show());

  const devServer = devServerUrl();
  const query = role === "manager" ? { view: "manager" } : undefined;
  if (devServer) {
    const url = new URL(devServer);
    if (query) url.searchParams.set("view", query.view);
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
      ...(query ? { query } : {}),
    });
  }

  return window;
}
