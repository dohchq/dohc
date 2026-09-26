import { isAbsolute } from "node:path";
import {
  classifyShareHandoffArguments,
  receiveShareHandoffArguments,
  type ShareHandoffIntentSlot,
} from "./shareHandoffIngress";

interface QuitEvent {
  preventDefault(): void;
}

interface LifecycleApp {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<unknown>;
  quit(): void;
  exit(code: number): void;
  on(event: "will-quit", listener: (event: QuitEvent) => void): unknown;
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
  on(event: "open-url", listener: (event: QuitEvent, argument: string) => void): unknown;
  on(event: "open-file", listener: (event: QuitEvent, argument: string) => void): unknown;
  on(event: "second-instance", listener: (event: unknown, argv: string[]) => void): unknown;
  on(event: "window-all-closed", listener: () => void): unknown;
  on(event: "activate", listener: () => void): unknown;
  on(event: "browser-window-created", listener: (event: unknown, window: SessionWindow) => void): unknown;
}

// Windows ends a logoff, shutdown, or restart without a quit event. The
// window's session-end is the confirmed end; query-session-end can still be
// cancelled.
interface SessionWindow {
  on(event: "session-end", listener: () => void): unknown;
}

// Starts updates when the first window never finishes loading, so a renderer
// that hangs on load cannot keep a bad build from its fix.
const UPDATE_START_FALLBACK_MS = 10_000;

// A launch counts as finished once the app has run this long after its first
// window loaded, or when it quits cleanly first. A build that crashes or
// exits sooner on every start builds up the launch count.
export const LAUNCH_SETTLED_MS = 30_000;

interface CliServer {
  close(): Promise<void>;
}

export function createAppLifecycle<Window, Workspace, Settings>(dependencies: {
  app: LifecycleApp;
  runtime: Pick<NodeJS.Process, "platform" | "argv" | "execPath">;
  handoff: {
    slot: ShareHandoffIntentSlot;
    pendingCodeChanged(): void;
  };
  windows: {
    create(): Window;
    // Resolves true once the window finishes its first load, and false when
    // its main frame fails to load.
    whenLoaded(window: Window): Promise<boolean>;
    current(): Window | undefined;
    hasWorkspace(): boolean;
    hasAny(): boolean;
    showOrCreate(): Promise<Window>;
    activate(window: Window, workspace: Workspace): void;
  };
  workspaces: {
    openPath(path: string, window?: Window): Promise<Workspace | null>;
    refreshNativeSurfaces(): void;
  };
  bootstrap: {
    markReady(): void;
    startEngine(): Promise<boolean>;
    loadSettings(): Promise<Settings>;
    applySettings(settings: Settings): void;
    prepareCli(): Promise<void> | undefined;
    registerHandlers(): void;
    markFirstWindow(): void;
    reportFailure(error: unknown): void;
  };
  services: {
    startCli(): Promise<CliServer>;
    reportCliFailure(error: unknown): void;
    dispatch: { start(): void; stop(): Promise<void> };
    refreshTray(): Promise<boolean>;
    /** dohc stays in the tray: close workspaces nothing uses any more. */
    releaseIdleWorkspaces(): Promise<void>;
    reportTrayFailure(error: unknown): void;
    warmCredentials(): Promise<void>;
    reconcileCloud(): void;
    startUpdates(): void;
    // Resolves true when the person chose to restart into a downloaded
    // update, so the failed startup must not quit on its own.
    updateAfterStartupFailure(): Promise<boolean>;
    updateAfterWindowLoadFailure(): Promise<boolean>;
  };
  // The launch marker: finished once the app has run LAUNCH_SETTLED_MS
  // after bootstrap and the first window load, at a clean quit, or when the
  // Windows session ends.
  launch: {
    finished(): void;
  };
  beforeQuit(event: QuitEvent): void;
  shutdown: {
    budgetMs: number;
    beginEngineShutdown(): void;
    stopSearch(): Promise<void>;
    stopSitePreviews(): Promise<void>;
    settleYDocs(): Promise<void>;
    stopAgentIntegration(): Promise<void>;
    closeWorkspaces(): Promise<void>;
    disposeDatabase(): Promise<void>;
    closeRelay(): Promise<void>;
    stopEngine(): Promise<void>;
  };
}) {
  const { app, runtime, handoff, windows, workspaces, bootstrap, services, launch, shutdown } = dependencies;
  let quitting = false;
  let bootstrapComplete = false;
  const pendingOpenPaths: string[] = [];
  let cliServer: CliServer | null = null;
  let cliServerStartup: Promise<CliServer | null> | null = null;
  let updatesStarted = false;
  let updatesFallback: ReturnType<typeof setTimeout> | undefined;

  // Register before acquiring the instance lock: a losing process also quits.
  app.on("will-quit", (event) => {
    if (quitting) return;
    quitting = true;
    // Every ordinary quit reaches here, including Update and Restart's.
    launch.finished();
    event.preventDefault();
    // Release opening-document backoff before producers drain. Accepted Y.Doc
    // writes keep retrying until settlement or the overall shutdown budget.
    shutdown.beginEngineShutdown();
    const searchStop = shutdown.stopSearch().catch(() => undefined);
    const sitePreviewStop = shutdown.stopSitePreviews();
    const chatDispatchStop = services.dispatch.stop().catch(() => undefined);
    const cliServerStop = chatDispatchStop.then(() =>
      (cliServerStartup ?? Promise.resolve(cliServer))
        .then((server) => server?.close())
        .catch(() => undefined),
    );
    const engineYDocStop = shutdown.settleYDocs();
    const agentIntegrationStop = shutdown.stopAgentIntegration().catch(() => undefined);
    // Starting close early would let a live producer settle onto a closed store.
    const workspaceAuthorityStop = Promise.allSettled([
      engineYDocStop,
      chatDispatchStop,
      cliServerStop,
      searchStop,
      agentIntegrationStop,
      sitePreviewStop,
    ])
      .then(() => shutdown.closeWorkspaces())
      .catch(() => undefined);
    const workspaceShutdown = workspaceAuthorityStop
      .then(async () => await shutdown.disposeDatabase())
      .then(async () => await shutdown.closeRelay())
      .catch(() => undefined)
      .then(async () => await shutdown.stopEngine());
    void Promise.race([
      workspaceShutdown,
      new Promise<void>((resolve) => setTimeout(resolve, shutdown.budgetMs)),
    ]).finally(() => app.exit(0));
  });

  function collectOpenWorkspaceArgs(argv: string[]): string[] {
    const openWorkspaceArg = "--open-workspace";
    const paths: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index] ?? "";
      if (arg === openWorkspaceArg) {
        const next = argv[index + 1];
        if (next) {
          paths.push(next);
          index += 1;
        }
        continue;
      }
      if (arg.startsWith(`${openWorkspaceArg}=`)) {
        paths.push(arg.slice(openWorkspaceArg.length + 1));
        continue;
      }
      if (arg.startsWith("--")) continue;
      const portable = arg.replace(/\\/g, "/");
      if (portable.endsWith("/dist/main/main.js")) continue;
      if (isAbsolute(arg) && arg !== runtime.execPath) paths.push(arg);
    }
    return [...new Set(paths)];
  }

  async function openWorkspacePaths(
    paths: string[],
    window?: Window,
  ): Promise<Workspace | null> {
    let lastOpened: Workspace | null = null;
    for (const path of paths) {
      const opened = await workspaces.openPath(path, window).catch(() => null);
      if (opened) lastOpened = opened;
    }
    return lastOpened;
  }

  async function flushPendingOpenPaths(window?: Window): Promise<Workspace | null> {
    if (pendingOpenPaths.length === 0) return null;
    const paths = pendingOpenPaths.splice(0);
    return openWorkspacePaths(paths, window);
  }

  async function whenReady(): Promise<void> {
    bootstrap.markReady();
    const engineStartup = bootstrap.startEngine();
    const cachedSettingsRead = bootstrap.loadSettings();
    const cliPreparation = bootstrap.prepareCli();
    if (cliPreparation) await cliPreparation;
    bootstrap.registerHandlers();
    // Apply persisted zoom before creating the first window; overlap its IO
    // and renderer load with the daemon handshake.
    bootstrap.applySettings(await cachedSettingsRead);
    const window = windows.create();
    const windowLoaded = windows.whenLoaded(window);
    bootstrap.markFirstWindow();
    // Updates start once the window loads, whether or not the engine and the
    // launch workspaces ever finish, so a bad build can still reach the build
    // that fixes it. Waiting for the load keeps the updater's module load off
    // the engine handshake. A window that fails to load checks for a fix, one
    // that never loads starts updates after a delay, and a startup failure
    // that comes first starts them itself.
    updatesFallback = setTimeout(startUpdates, UPDATE_START_FALLBACK_MS);
    updatesFallback.unref?.();
    void windowLoaded.then((loaded) => {
      startUpdates();
      if (!loaded) void services.updateAfterWindowLoadFailure();
    });

    if (!(await engineStartup)) {
      await quitAfterStartupFailure();
      return;
    }

    cliServerStartup = services.startCli()
      .then(async (server) => {
        if (quitting) {
          await server.close();
          return null;
        }
        cliServer = server;
        return server;
      })
      .catch((error: unknown) => {
        services.reportCliFailure(error);
        return null;
      });
    void cliServerStartup.then(() => {
      if (!quitting) services.dispatch.start();
    });
    void services.refreshTray().catch(services.reportTrayFailure);

    const launchWorkspace = await openWorkspacePaths(collectOpenWorkspaceArgs(runtime.argv));
    const pendingWorkspace = await flushPendingOpenPaths();
    const activatedWorkspace = pendingWorkspace ?? launchWorkspace;
    workspaces.refreshNativeSurfaces();
    void windowLoaded.then((loaded) => {
      if (!loaded) return;
      setTimeout(() => launch.finished(), LAUNCH_SETTLED_MS).unref?.();
      if (activatedWorkspace) windows.activate(window, activatedWorkspace);
      // Intents received during the last open await still need a drain after
      // activation. They are later intents and must win over launch paths.
      void flushPendingOpenPaths(window);
    });
    bootstrapComplete = true;
    void services.warmCredentials().then(() => services.reconcileCloud());
  }

  // Startup failure uses the ordinary quit path so drafts can veto it. A
  // window may already hold edits: local reads and the plain editor never
  // wait for the engine.
  async function quitAfterStartupFailure(): Promise<void> {
    startUpdates();
    if (!(await services.updateAfterStartupFailure())) app.quit();
  }

  function startUpdates(): void {
    if (updatesStarted) return;
    updatesStarted = true;
    clearTimeout(updatesFallback);
    services.startUpdates();
  }

  return {
    isQuitting: () => quitting,
    /**
     * A reason to run without windows changed, as when the last schedule
     * was switched off. With no window and no reason left, dohc quits, as
     * closing the last window would have.
     */
    async backgroundReasonsChanged(): Promise<void> {
      const keep = await services.refreshTray();
      if (!keep && !quitting && runtime.platform !== "darwin" && !windows.hasAny()) app.quit();
    },
    start(): Promise<void> {
      if (!app.requestSingleInstanceLock()) {
        app.quit();
        return Promise.resolve();
      }
      if (runtime.platform !== "darwin") {
        if (receiveShareHandoffArguments(runtime.argv, handoff.slot)) {
          handoff.pendingCodeChanged();
        }
      }

      app.on("browser-window-created", (_event, window) => {
        window.on("session-end", () => launch.finished());
      });

      app.on("open-url", (event, rawArgument) => {
        event.preventDefault();
        const accepted = receiveShareHandoffArguments([rawArgument], handoff.slot);
        if (accepted) handoff.pendingCodeChanged();
        if (!accepted || !bootstrapComplete) return;
        void windows.showOrCreate();
      });

      app.on("open-file", (event, path) => {
        event.preventDefault();
        pendingOpenPaths.push(path);
        if (!bootstrapComplete) return;
        const window = windows.current();
        if (window) {
          void flushPendingOpenPaths(window);
        } else {
          void windows.showOrCreate().then((createdWindow) => flushPendingOpenPaths(createdWindow));
        }
      });

      app.on("second-instance", (_event, argv) => {
        const handoffIntent = classifyShareHandoffArguments(argv);
        const accepted = receiveShareHandoffArguments(argv, handoff.slot);
        if (accepted) handoff.pendingCodeChanged();
        const workspacePaths = collectOpenWorkspaceArgs(argv);
        if (!bootstrapComplete) {
          pendingOpenPaths.push(...workspacePaths);
          return;
        }
        if (handoffIntent === "rejected" && workspacePaths.length === 0) return;
        void windows.showOrCreate().then((window) => openWorkspacePaths(workspacePaths, window));
      });

      app.on("before-quit", (event) => {
        // A hidden export window cannot answer for renderer-held drafts.
        if (!windows.hasWorkspace()) return;
        dependencies.beforeQuit(event);
      });

      const ready = app.whenReady().then(whenReady).catch(async (error: unknown) => {
        bootstrap.reportFailure(error);
        await quitAfterStartupFailure();
      });

      app.on("window-all-closed", () => {
        if (runtime.platform === "darwin") return;
        void services.refreshTray()
          .then((enabled) => {
            if (!enabled && !quitting) app.quit();
            // A failed close leaves the workspace open; it never quits dohc.
            else if (enabled && !quitting) return services.releaseIdleWorkspaces().catch(() => undefined);
          })
          .catch(() => {
            if (!quitting) app.quit();
          });
      });

      app.on("activate", () => {
        if (!bootstrapComplete) return;
        if (!windows.hasAny()) void windows.showOrCreate();
      });
      return ready;
    },
  };
}
