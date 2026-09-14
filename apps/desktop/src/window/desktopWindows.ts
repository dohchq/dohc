import type { App, BrowserWindow, Dialog, Menu, WebContents } from "electron";
import { DesktopUserSettingsResult, type WorkspaceSummary } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import { createWorkspaceWindowRegistry } from "../quitGuard";
import { buildMenuTemplate } from "./applicationMenu";
import {
  createUserSettingsWriteQueue,
  createGuestZoomApplier,
  createZoomMutation,
  resolvePersistedZoomApplication,
} from "./windowZoom";
import {
  focusShareHandoffWindow,
  focusShareHandoffWindowWhenReady,
} from "../shareHandoffIngress";
import type { createMainWindow as createMainWindowImplementation } from "./createMainWindow";
import type { readCachedUserSettingsFile as readSettings, writeUserSettingsFile as writeSettings } from "../settings/userSettingsStore";
import type { RendererWorkspaceSessionOwner } from "./rendererWorkspaceSessionOwner";

interface DesktopWindowsDependencies {
  app: Pick<App, "isReady" | "isPackaged" | "getVersion" | "clearRecentDocuments" | "addRecentDocument" | "setUserTasks">;
  BrowserWindow: Pick<typeof BrowserWindow, "getAllWindows">;
  Menu: Pick<typeof Menu, "setApplicationMenu" | "buildFromTemplate">;
  dialog: Pick<Dialog, "showErrorBox" | "showMessageBox">;
  process: Pick<NodeJS.Process, "platform" | "execPath">;
  workspaceSummaries(): WorkspaceSummary[];
  currentUpdateState(): { canInstall?: boolean };
  stateDir(): string;
  readCachedUserSettingsFile: typeof readSettings;
  writeUserSettingsFile: typeof writeSettings;
  createMainWindow: typeof createMainWindowImplementation;
  readonly pluginSurfaces: { applyWebAppZoom(level: number): void };
  readonly rendererWorkspaceSessions: Pick<
    RendererWorkspaceSessionOwner<WebContents>, "current" | "retireForReload" | "retireAfterCrash"
  >;
}

export function createDesktopWindows(dependencies: DesktopWindowsDependencies) {
  const {
    app, BrowserWindow, Menu, dialog, process, workspaceSummaries, currentUpdateState,
    stateDir, readCachedUserSettingsFile, writeUserSettingsFile, createMainWindow,
  } = dependencies;

  let applicationMenuCanInstallUpdate: boolean | null = null;

  function nativeWorkspaceSummaries(): WorkspaceSummary[] {
    try {
      return workspaceSummaries();
    } catch {
      // Native recent surfaces are convenience only. The renderer still gets the
      // strict registry parse and shows the refusal screen for malformed state.
      return [];
    }
  }

  let preferredWorkspaceId: string | null = null;

  function prioritizePreferredWorkspace(
    workspaces: WorkspaceSummary[],
  ): WorkspaceSummary[] {
    if (!preferredWorkspaceId) return workspaces;
    const index = workspaces.findIndex(
      (workspace) => workspace.workspaceId === preferredWorkspaceId,
    );
    if (index <= 0) return workspaces;
    return [
      workspaces[index],
      ...workspaces.slice(0, index),
      ...workspaces.slice(index + 1),
    ];
  }

  // The windows that RUN the workspace renderer. Not every BrowserWindow does:
  // the PDF export creates a hidden, preload-less one, and asking IT about
  // set-aside drafts would answer nothing. Tracked at
  // creation instead of guessed from getAllWindows().
  const workspaceWindows = createWorkspaceWindowRegistry<BrowserWindow>(
    (window) => window.isDestroyed(),
  );
  // The last zoom level any path applied (mutation, settings save, or the
  // persisted read). The bootstrap seeds it from the cached settings read
  // before the first window exists, so every window — including the first of
  // a launch — starts at the right scale before any show(). Null only until
  // that seed lands, which precedes every window creation.
  let knownZoomLevel: number | null = null;

  function trackWorkspaceWindow(window: BrowserWindow): BrowserWindow {
    workspaceWindows.track(window);
    window.on("closed", () => workspaceWindows.forget(window));
    // The persisted zoom level is a window property main owns, set
    // synchronously at creation — before any show() on either creation path —
    // so no visible frame paints at 100% and then jumps. The async read below
    // is the reconcile backstop (a settings save can land mid-launch);
    // best-effort — a fresh install has only the default.
    if (knownZoomLevel !== null) {
      window.webContents.setZoomLevel(knownZoomLevel);
    }
    const persistedZoom = readCachedUserSettingsFile(stateDir())
      .then(({ settings }) => settings.appearance.zoomLevel)
      .catch(() => null);
    const applyPersistedZoom = () => {
      void persistedZoom.then((zoomLevel) => {
        const application = resolvePersistedZoomApplication(
          zoomLevel,
          knownZoomLevel,
        );
        if (application === null) return;
        if ("applyEverywhere" in application) {
          // One path for hosts and guests: a guest attached before the read
          // resolved must not stay at 100% until the next zoom change.
          applyZoomLevelToWindows(application.applyEverywhere);
        } else if (!window.isDestroyed()) {
          window.webContents.setZoomLevel(application.applyToWindow);
        }
      });
    };
    window.once("ready-to-show", applyPersistedZoom);
    window.webContents.once("did-finish-load", applyPersistedZoom);
    return window;
  }
  function liveWorkspaceWindow(): BrowserWindow | undefined {
    return workspaceWindows.live();
  }

  function targetWindow(window: BrowserWindow | undefined): BrowserWindow | undefined {
    return window ?? liveWorkspaceWindow() ?? BrowserWindow.getAllWindows()[0];
  }

  function sendWorkspaceActivated(
    window: BrowserWindow | undefined,
    workspace: WorkspaceSummary,
  ): void {
    preferredWorkspaceId = workspace.workspaceId;
    targetWindow(window)?.webContents.send(CHANNELS.workspaceActivated, workspace);
  }

  function quoteWindowsArg(value: string): string {
    let quoted = '"';
    let backslashes = 0;
    for (const char of value) {
      if (char === "\\") {
        backslashes += 1;
      } else if (char === '"') {
        quoted += "\\".repeat(backslashes * 2 + 1);
        quoted += char;
        backslashes = 0;
      } else {
        quoted += "\\".repeat(backslashes);
        quoted += char;
        backslashes = 0;
      }
    }
    quoted += "\\".repeat(backslashes * 2);
    quoted += '"';
    return quoted;
  }

  // One user-settings write queue for every caller. Full saves and zoom steps
  // cannot interleave their file mutations.
  //
  // Tracked workspace windows only, never getAllWindows(): a hidden utility
  // window (the PDF export renderer) must keep its own zoom, or an export
  // mid-render would change layout with the user's keystroke.
  function applyZoomLevelToWindows(zoomLevel: number): void {
    knownZoomLevel = zoomLevel;
    for (const window of workspaceWindows.allLive()) {
      window.webContents.setZoomLevel(zoomLevel);
    }
    // Embedded plugin content follows the window zoom: the person who
    // zoomed because text was too small is usually working IN the panel. Only
    // embedded guests — the same app opened by URL keeps the browser's zoom.
    dependencies.pluginSurfaces.applyWebAppZoom(zoomLevel);
  }

  const bindGuestZoom = createGuestZoomApplier(() => knownZoomLevel);

  const enqueueUserSettingsWrite = createUserSettingsWriteQueue();
  const mutateWindowZoom = createZoomMutation({
    enqueue: enqueueUserSettingsWrite,
    read: () => readCachedUserSettingsFile(stateDir()),
    write: (settings) => writeUserSettingsFile(stateDir(), settings),
    apply: applyZoomLevelToWindows,
  });

  async function stepWindowZoom(
    step: Parameters<typeof mutateWindowZoom>[0],
  ): Promise<DesktopUserSettingsResult> {
    const result = DesktopUserSettingsResult.parse(await mutateWindowZoom(step));
    for (const window of workspaceWindows.allLive()) {
      window.webContents.send(CHANNELS.userSettingsChanged, result);
    }
    return result;
  }

  function refreshApplicationMenu(): void {
    if (!app.isReady()) return;
    const canInstallUpdate = currentUpdateState().canInstall === true;
    applicationMenuCanInstallUpdate = canInstallUpdate;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          isDev: !app.isPackaged,
          platform: process.platform,
          recentWorkspaces: nativeWorkspaceSummaries(),
          canInstallUpdate,
          sendCommand: (window, command) => {
            targetWindow(window)?.webContents.send(CHANNELS.menuCommand, command);
          },
          stepZoom: (step) => {
            void stepWindowZoom(step).catch((error) => {
              console.error("[desktop] window zoom:", error);
              // The accelerator path has no renderer surface to answer on (the
              // palette and Settings show their own errors), so the refusal —
              // e.g. an unreadable settings file — must reach the user here.
              dialog.showErrorBox(
                "Zoom",
                error instanceof Error
                  ? `${error.message} Open Settings to repair or reset it.`
                  : "dohc could not change the window zoom.",
              );
            });
          },
          openRecentWorkspace: (window, workspace) => {
            sendWorkspaceActivated(window, workspace);
            refreshNativeWorkspaceSurfaces();
          },
          showAbout: () => {
            void dialog.showMessageBox({
              title: "About dohc",
              message: "dohc",
              detail: `Version ${app.getVersion()}\nYour workspace is a folder.`,
            });
          },
        }),
      ),
    );
  }

  function refreshNativeWorkspaceSurfaces(): void {
    if (!app.isReady()) return;
    const workspaces = nativeWorkspaceSummaries();
    try {
      app.clearRecentDocuments();
      for (const workspace of [...workspaces].reverse()) {
        app.addRecentDocument(workspace.rootPath);
      }
    } catch {
      // Linux and some dev shells do not expose native recent-document storage.
    }
    if (process.platform === "win32") {
      app.setUserTasks(
        workspaces.slice(0, 10).map((workspace) => ({
          program: process.execPath,
          arguments: `--open-workspace ${quoteWindowsArg(workspace.rootPath)}`,
          iconPath: process.execPath,
          iconIndex: 0,
          title: `Open ${workspace.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace"}`,
          description: workspace.rootPath,
        })),
      );
    }
    refreshApplicationMenu();
  }

  async function prepareForRendererReload(
    sender: WebContents,
    rendererDocumentId: string,
  ): Promise<boolean> {
    // `openWorkspace` records the active workspace before awaiting watcher
    // startup. Re-prioritize that sender's workspace so its replacement renderer
    // boots back into the same place, while closing every main-owned resource
    // the crashed renderer cannot clean up itself.
    const activeWorkspaceId =
      dependencies.rendererWorkspaceSessions.current(sender)?.workspaceId ??
      preferredWorkspaceId;
    // retireForReload invalidates the lease before returning its promise. The
    // outgoing document cannot admit fresh work while these owners drain.
    const accepted = await dependencies.rendererWorkspaceSessions.retireForReload(
      sender,
      rendererDocumentId,
    );
    if (accepted && activeWorkspaceId) preferredWorkspaceId = activeWorkspaceId;
    return accepted;
  }

  async function prepareAfterRendererCrash(sender: WebContents): Promise<void> {
    const activeWorkspaceId =
      dependencies.rendererWorkspaceSessions.current(sender)?.workspaceId ??
      preferredWorkspaceId;
    if (activeWorkspaceId) preferredWorkspaceId = activeWorkspaceId;
    await dependencies.rendererWorkspaceSessions.retireAfterCrash(sender);
  }

  // One manager window at a time. It is not a workspace window: it never
  // joins workspaceWindows, so quit and zoom logic ignore it.
  let managerWindow: BrowserWindow | null = null;
  function showOrCreateManagerWindow(): BrowserWindow {
    if (managerWindow && !managerWindow.isDestroyed()) {
      managerWindow.focus();
      return managerWindow;
    }
    const window = createMainWindow({
      beforeRendererReload: prepareAfterRendererCrash,
      role: "manager",
    });
    window.on("closed", () => {
      if (managerWindow === window) managerWindow = null;
    });
    managerWindow = window;
    return window;
  }

  // A window for one workspace. Reuses a live window already showing it;
  // otherwise creates one and activates the workspace in it once loaded.
  async function openWorkspaceInWindow(
    workspace: WorkspaceSummary,
    isShowing: (window: BrowserWindow) => boolean,
  ): Promise<BrowserWindow> {
    const existing = workspaceWindows.allLive().find(isShowing);
    if (existing) {
      existing.focus();
      return existing;
    }
    const window = trackWorkspaceWindow(
      createMainWindow({ beforeRendererReload: prepareAfterRendererCrash }),
    );
    await new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve());
    });
    if (window.isDestroyed()) return window;
    window.webContents.send(CHANNELS.workspaceActivated, workspace);
    window.focus();
    return window;
  }

  async function showOrCreateMainWindow(): Promise<BrowserWindow> {
    const existing = targetWindow(undefined);
    if (existing) {
      focusShareHandoffWindow(existing);
      return existing;
    }
    const window = trackWorkspaceWindow(
      createMainWindow({ beforeRendererReload: prepareAfterRendererCrash }),
    );
    focusShareHandoffWindowWhenReady(window);
    return window;
  }

  return {
    workspaceWindows,
    prioritizePreferredWorkspace,
    trackWorkspaceWindow,
    liveWorkspaceWindow,
    targetWindow,
    sendWorkspaceActivated,
    applyZoomLevelToWindows,
    bindGuestZoom,
    enqueueUserSettingsWrite,
    stepWindowZoom,
    refreshApplicationMenu,
    refreshNativeWorkspaceSurfaces,
    prepareForRendererReload,
    prepareAfterRendererCrash,
    showOrCreateMainWindow,
    showOrCreateManagerWindow,
    openWorkspaceInWindow,
    get applicationMenuCanInstallUpdate(): boolean | null { return applicationMenuCanInstallUpdate; },
    setPreferredWorkspaceId(workspaceId: string): void { preferredWorkspaceId = workspaceId; },
    seedZoomLevel(zoomLevel: number): void { knownZoomLevel ??= zoomLevel; },
  };
}
