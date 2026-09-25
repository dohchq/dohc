import type { App, BrowserWindow, Dialog, Menu, WebContents } from "electron";
import type { DesktopUserSettingsResult, WorkspaceSummary } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import { createWorkspaceWindowRegistry } from "../quitGuard";
import { buildMenuTemplate } from "./applicationMenu";
import {
  createGuestZoomApplier,
  resolvePersistedZoomApplication,
} from "./windowZoom";
import {
  focusShareHandoffWindow,
  focusShareHandoffWindowWhenReady,
} from "../shareHandoffIngress";
import type { createMainWindow as createMainWindowImplementation } from "./createMainWindow";
import type { ZoomStep } from "../settings/userSettings";
import type { readCachedUserSettingsFile as readSettings } from "../settings/userSettingsStore";
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
  // One zoom step through the settings file owner, which saves it and puts it
  // into effect.
  stepWindowZoom(step: ZoomStep): Promise<unknown>;
  createMainWindow: typeof createMainWindowImplementation;
  // Handed to every renderer window's preload (dev-tools grant).
  preloadArguments?: readonly string[];
  afterRendererCrashLoop?: () => void;
  readonly pluginSurfaces: { applyWebAppZoom(level: number): void };
  readonly rendererWorkspaceSessions: Pick<
    RendererWorkspaceSessionOwner<WebContents>, "current" | "retireForReload" | "retireAfterCrash"
  >;
  // A workspace window that finishes loading during a pending exit round
  // joins it; one that closes leaves it.
  readonly exitRounds?: {
    enroll(window: BrowserWindow): void;
    remove(participantId: number): void;
  };
}

export function createDesktopWindows(dependencies: DesktopWindowsDependencies) {
  const {
    app, BrowserWindow, Menu, dialog, process, workspaceSummaries, currentUpdateState,
    stateDir, readCachedUserSettingsFile, createMainWindow,
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

  // Every window that renders dohc chrome follows the app zoom and hears
  // settings changes: workspace windows and the manager. The hidden PDF
  // export window is neither, so it keeps its own zoom.
  const zoomedWindows = new Set<BrowserWindow>();
  function liveZoomedWindows(): BrowserWindow[] {
    return [...zoomedWindows].filter((window) => !window.isDestroyed());
  }

  function trackWorkspaceWindow(window: BrowserWindow): BrowserWindow {
    workspaceWindows.track(window);
    const participantId = window.webContents.id;
    window.on("closed", () => {
      workspaceWindows.forget(window);
      dependencies.exitRounds?.remove(participantId);
    });
    // A window joins a pending round the moment it is tracked, so a
    // decision made before it existed never covers it. Its renderer cannot
    // answer until it loads; the round asks again then.
    dependencies.exitRounds?.enroll(window);
    window.webContents.on("did-finish-load", () => {
      if (!window.isDestroyed()) dependencies.exitRounds?.enroll(window);
    });
    return followAppZoom(window);
  }

  function followAppZoom(window: BrowserWindow): BrowserWindow {
    zoomedWindows.add(window);
    window.on("closed", () => zoomedWindows.delete(window));
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

  // Activation opens a workspace in a window that runs the workspace
  // renderer. The manager and the hidden export window cannot, so with none
  // live a new workspace window is created and activated once it loads.
  function sendWorkspaceActivated(
    window: BrowserWindow | undefined,
    workspace: WorkspaceSummary,
  ): Promise<BrowserWindow> {
    preferredWorkspaceId = workspace.workspaceId;
    const target =
      window && workspaceWindows.allLive().includes(window) ? window : liveWorkspaceWindow();
    if (target) {
      target.webContents.send(CHANNELS.workspaceActivated, workspace);
      focusShareHandoffWindow(target);
      return Promise.resolve(target);
    }
    return openWorkspaceInWindow(workspace, () => false);
  }

  function reportActivationFailure(workspace: WorkspaceSummary, error: unknown): void {
    console.error(`[desktop] could not open ${workspace.rootPath}:`, error);
    dialog.showErrorBox(
      "Open workspace",
      `dohc could not open ${workspace.rootPath}. Open it again from the workspace manager.`,
    );
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

  // Tracked workspace windows only, never getAllWindows(): a hidden utility
  // window (the PDF export renderer) must keep its own zoom, or an export
  // mid-render would change layout with the user's keystroke.
  function applyZoomLevelToWindows(zoomLevel: number): void {
    knownZoomLevel = zoomLevel;
    for (const window of liveZoomedWindows()) {
      window.webContents.setZoomLevel(zoomLevel);
    }
    // Embedded plugin content follows the window zoom: the person who
    // zoomed because text was too small is usually working IN the panel. Only
    // embedded guests — the same app opened by URL keeps the browser's zoom.
    dependencies.pluginSurfaces.applyWebAppZoom(zoomLevel);
  }

  const bindGuestZoom = createGuestZoomApplier(() => knownZoomLevel);

  function broadcastUserSettings(result: DesktopUserSettingsResult): void {
    for (const window of liveZoomedWindows()) {
      window.webContents.send(CHANNELS.userSettingsChanged, result);
    }
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
            void dependencies.stepWindowZoom(step).catch((error) => {
              console.error("[desktop] window zoom:", error);
              // The accelerator path has no renderer surface to answer on (the
              // palette and Settings show their own errors), so the refusal —
              // e.g. an unreadable settings file, named with its way out —
              // must reach the user here.
              dialog.showErrorBox(
                "Zoom",
                error instanceof Error
                  ? error.message
                  : "dohc could not change the window zoom.",
              );
            });
          },
          openRecentWorkspace: (window, workspace) => {
            void sendWorkspaceActivated(window, workspace).catch((error: unknown) =>
              reportActivationFailure(workspace, error),
            );
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

  let appliedNativeWorkspaceRoots: readonly string[] | null = null;

  function refreshNativeWorkspaceSurfaces(): void {
    if (!app.isReady()) return;
    const roots = nativeWorkspaceSummaries().map((workspace) => workspace.rootPath);
    try {
      if (
        appliedNativeWorkspaceRoots?.length === roots.length &&
        roots.every((root, index) => root === appliedNativeWorkspaceRoots?.[index])
      ) return;

      // A partial refresh invalidates the previous list even if we later return to it.
      appliedNativeWorkspaceRoots = null;
      let recentDocumentsApplied = true;
      try {
        app.clearRecentDocuments();
        for (const root of [...roots].reverse()) {
          app.addRecentDocument(root);
        }
      } catch {
        // Linux and some dev shells do not expose native recent-document storage.
        recentDocumentsApplied = false;
      }
      const userTasksApplied = process.platform !== "win32" || app.setUserTasks(
        roots.slice(0, 10).map((root) => ({
          program: process.execPath,
          arguments: `--open-workspace ${quoteWindowsArg(root)}`,
          iconPath: process.execPath,
          iconIndex: 0,
          title: `Open ${root.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace"}`,
          description: root,
        })),
      );
      if (recentDocumentsApplied && userTasksApplied) {
        appliedNativeWorkspaceRoots = roots;
      }
    } finally {
      refreshApplicationMenu();
    }
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
      focusShareHandoffWindow(managerWindow);
      return managerWindow;
    }
    const window = followAppZoom(
      createMainWindow({
        beforeRendererReload: prepareAfterRendererCrash,
        afterRendererCrashLoop: dependencies.afterRendererCrashLoop,
        role: "manager",
        preloadArguments: dependencies.preloadArguments,
      }),
    );
    window.on("closed", () => {
      if (managerWindow === window) managerWindow = null;
    });
    managerWindow = window;
    return window;
  }

  function createWorkspaceWindow(): BrowserWindow {
    return trackWorkspaceWindow(
      createMainWindow({
        beforeRendererReload: prepareAfterRendererCrash,
        afterRendererCrashLoop: dependencies.afterRendererCrashLoop,
        preloadArguments: dependencies.preloadArguments,
      }),
    );
  }

  // Resolves once the renderer can receive activation; rejects when the
  // window closes or its main frame fails to load. Listeners come off on
  // every path.
  function whenRendererLoaded(window: BrowserWindow): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const contents = window.webContents;
      const settle = (outcome: () => void) => {
        contents.off("did-finish-load", onLoad);
        contents.off("did-fail-load", onFail);
        window.off("closed", onClosed);
        outcome();
      };
      const onLoad = () => settle(resolve);
      const onClosed = () =>
        settle(() => reject(new Error("The window closed before it finished loading.")));
      const onFail = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        _validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame) return;
        settle(() => reject(new Error(`The window failed to load (${errorCode} ${errorDescription}).`)));
      };
      contents.on("did-finish-load", onLoad);
      contents.on("did-fail-load", onFail);
      window.on("closed", onClosed);
    });
  }

  // Opens in flight, keyed by workspace: a second request for the same
  // workspace joins the first instead of creating a second window. Sending
  // activation does not end the open: the renderer still has to receive it
  // and open its session, and a request in that gap must find the same
  // window. So the entry outlives activation and is checked on each open
  // against the window's real session: it stands while the window is live
  // and has no session yet, and retires once the window shows this
  // workspace (the caller's lookup finds it), shows another, or closes.
  const pendingOpens = new Map<string, { window: BrowserWindow; opening: Promise<BrowserWindow> }>();

  function pendingOpenFor(workspaceId: string): Promise<BrowserWindow> | null {
    const pending = pendingOpens.get(workspaceId);
    if (!pending) return null;
    const session = dependencies.rendererWorkspaceSessions.current(pending.window.webContents);
    if (pending.window.isDestroyed() || session !== undefined) {
      pendingOpens.delete(workspaceId);
      return null;
    }
    return pending.opening;
  }

  // A window for one workspace. Reuses a live window already showing it;
  // otherwise creates one and activates the workspace in it once loaded.
  function openWorkspaceInWindow(
    workspace: WorkspaceSummary,
    isShowing: (window: BrowserWindow) => boolean,
  ): Promise<BrowserWindow> {
    const existing = workspaceWindows.allLive().find(isShowing);
    if (existing) {
      focusShareHandoffWindow(existing);
      return Promise.resolve(existing);
    }
    const pending = pendingOpenFor(workspace.workspaceId);
    if (pending) return pending.then((window) => {
      focusShareHandoffWindow(window);
      return window;
    });
    const window = createWorkspaceWindow();
    const entry = {
      window,
      opening: (async () => {
        try {
          await whenRendererLoaded(window);
        } catch (error) {
          if (!window.isDestroyed()) window.destroy();
          throw error;
        }
        window.webContents.send(CHANNELS.workspaceActivated, workspace);
        focusShareHandoffWindow(window);
        return window;
      })(),
    };
    pendingOpens.set(workspace.workspaceId, entry);
    const release = () => {
      if (pendingOpens.get(workspace.workspaceId) === entry) {
        pendingOpens.delete(workspace.workspaceId);
      }
    };
    window.on("closed", release);
    // The caller owns the rejection; a failed open frees the slot at once.
    void entry.opening.catch(release);
    return entry.opening;
  }

  // The window a handoff or tray click should land in: a workspace window,
  // never the manager or the hidden export window. Creates one when none
  // is live.
  async function showOrCreateMainWindow(): Promise<BrowserWindow> {
    const existing = liveWorkspaceWindow();
    if (existing) {
      focusShareHandoffWindow(existing);
      return existing;
    }
    const window = createWorkspaceWindow();
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
    reportActivationFailure,
    applyZoomLevelToWindows,
    bindGuestZoom,
    broadcastUserSettings,
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
