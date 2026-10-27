import { flushTypingCheckpointsSync } from "./workspaces/outageTypingRecovery";
import { isAbsolute } from "node:path";
import { DISPATCH_STOP_LIMIT_MS } from "./shutdownBudgets";
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

// Resolves when the work settles or the limit passes, whichever comes first.
function settledWithin(work: Promise<void>, limitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs); });
  return Promise.race([work.catch(() => undefined), limit]).finally(() => clearTimeout(timer));
}

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
    // Capture before opening. The target owns renderer readiness and rejects
    // delivery after its window or workspace context changes.
    openFailureTarget(window: Window): {
      whenReady(): Promise<boolean>;
      isCurrent(opened?: Workspace | null): boolean;
    };
    current(): Window | undefined;
    hasWorkspace(): boolean;
    hasAny(): boolean;
    showOrCreate(): Promise<Window>;
    activate(window: Window, workspace: Workspace): void;
  };
  workspaces: {
    openPath(path: string, window?: Window): Promise<Workspace | null>;
    recordOpenFailure(path: string, error: unknown): void;
    reportOpenFailure(path: string, error: unknown, window: Window): void;
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
    /** dohc stays running after its last window: say so where no tray does. */
    noticeRunningInBackground(): Promise<void>;
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
    // The app ran LAUNCH_SETTLED_MS after its first window loaded, with no
    // quit or session end first. Never called on the way out.
    settled(): void;
  };
  beforeQuit(event: QuitEvent): void;
  beforeQuitWithoutWindows?(event: QuitEvent): void;
  shutdown: {
    budgetMs: number;
    deadlineExitCode: 0 | 1;
    beginEngineShutdown(): void;
    // Stops new refusal Notice work at once; settles when accepted work is done.
    stopNoticeRefusals(): Promise<void>;
    // Admits no new agent wake at once; settles when the admitted one finishes or parks.
    stopAutomationWakes(): Promise<void>;
    stopSearch(): Promise<void>;
    stopSitePreviews(): Promise<void>;
    settleYDocs(): Promise<void>;
    stopAgentIntegration(): Promise<void>;
    // Sends the reports that wait, within its own deadline inside the budget.
    flushReports(): Promise<void>;
    closeWorkspaces(): Promise<void>;
    disposeDatabase(): Promise<void>;
    closeRelay(): Promise<void>;
    stopEngine(): Promise<void>;
    // Writes how dohc's own shutdown ended, just before the process exits.
    reportQuit(line: string): void;
  };
}) {
  const { app, runtime, handoff, windows, workspaces, bootstrap, services, launch, shutdown } = dependencies;
  let quitting = false;
  let sessionEnded = false;
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
    const shutdownStarted = Date.now();
    // Every ordinary quit reaches here, including Update and Restart's.
    launch.finished();
    event.preventDefault();
    // The steps still running when the budget runs out, named in the quit line.
    const running = new Set<string>();
    const step = <T>(name: string, work: Promise<T>): Promise<T> => {
      running.add(name);
      const done = () => { running.delete(name); };
      work.then(done, done);
      return work;
    };
    // Refusal Notices and agent wakes read workspaces, so they stop before any
    // producer drains.
    const noticeRefusalStop = step("stopNoticeRefusals", shutdown.stopNoticeRefusals());
    const automationWakeStop = step("stopAutomationWakes", shutdown.stopAutomationWakes());
    // Release opening-document backoff before producers drain. Accepted Y.Doc
    // writes keep retrying until settlement or the overall shutdown budget.
    shutdown.beginEngineShutdown();
    const searchStop = step("stopSearch", shutdown.stopSearch()).catch(() => undefined);
    const sitePreviewStop = step("stopSitePreviews", shutdown.stopSitePreviews());
    const chatDispatchStop = step("stopDispatch", settledWithin(services.dispatch.stop(), DISPATCH_STOP_LIMIT_MS));
    const cliServerStop = chatDispatchStop.then(() =>
      step("closeCliServer", (cliServerStartup ?? Promise.resolve(cliServer))
        .then((server) => server?.close()))
        .catch(() => undefined),
    );
    const engineYDocStop = step("settleYDocs", shutdown.settleYDocs());
    const agentIntegrationStop = step("stopAgentIntegration", shutdown.stopAgentIntegration()).catch(() => undefined);
    // Reports go alongside teardown, and exit waits for both within the budget.
    const reportsFlush = step("flushReports", shutdown.flushReports()).catch(() => undefined);
    // Starting close early would let a live producer settle onto a closed store.
    const workspaceAuthorityStop = Promise.allSettled([
      noticeRefusalStop,
      automationWakeStop,
      engineYDocStop,
      chatDispatchStop,
      cliServerStop,
      searchStop,
      agentIntegrationStop,
      sitePreviewStop,
    ])
      .then(() => step("closeWorkspaces", shutdown.closeWorkspaces()))
      .catch(() => undefined);
    const workspaceShutdown = workspaceAuthorityStop
      .then(async () => await step("disposeDatabase", shutdown.disposeDatabase()))
      .then(async () => await step("closeRelay", shutdown.closeRelay()))
      .catch(() => undefined)
      .then(async () => await step("stopEngine", shutdown.stopEngine()));
    let budgetExpired = false;
    let shutdownTimer: ReturnType<typeof setTimeout>;
    void Promise.race([
      Promise.all([workspaceShutdown, reportsFlush]),
      new Promise<void>((resolve) => {
        shutdownTimer = setTimeout(() => {
          budgetExpired = true;
          resolve();
        }, shutdown.budgetMs);
      }),
    ]).finally(() => {
      clearTimeout(shutdownTimer);
      shutdown.reportQuit(budgetExpired
        ? `[desktop] quit: shutdown ran past its ${shutdown.budgetMs} ms budget, still running: ${[...running].join(", ")}`
        : `[desktop] quit: shutdown finished in ${Date.now() - shutdownStarted} ms`);
      app.exit(budgetExpired ? shutdown.deadlineExitCode : 0);
    });
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
    failureWindow = window,
  ): Promise<Workspace | null> {
    let lastOpened: Workspace | null = null;
    const failures: { path: string; error: unknown }[] = [];
    const target = paths.length > 0 && failureWindow ? windows.openFailureTarget(failureWindow) : undefined;
    for (const path of paths) {
      try {
        const opened = await workspaces.openPath(path, window);
        if (opened) lastOpened = opened;
      } catch (error: unknown) {
        workspaces.recordOpenFailure(path, error);
        failures.push({ path, error });
      }
    }
    if (failures.length && failureWindow && target) {
      const reportWindow = failureWindow;
      void target.whenReady().then((loaded) => {
        if (!loaded || quitting || !target.isCurrent(lastOpened)) return;
        for (const { path, error } of failures) {
          if (quitting || !target.isCurrent(lastOpened)) return;
          workspaces.reportOpenFailure(path, error, reportWindow);
        }
      });
    }
    return lastOpened;
  }

  async function flushPendingOpenPaths(window?: Window, failureWindow = window): Promise<Workspace | null> {
    if (pendingOpenPaths.length === 0) return null;
    const paths = pendingOpenPaths.splice(0);
    return openWorkspacePaths(paths, window, failureWindow);
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
    // dohc's menu replaces Electron's default before any window shows.
    workspaces.refreshNativeSurfaces();
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

    const launchWorkspace = await openWorkspacePaths(collectOpenWorkspaceArgs(runtime.argv), undefined, window);
    const pendingWorkspace = await flushPendingOpenPaths(undefined, window);
    const activatedWorkspace = pendingWorkspace ?? launchWorkspace;
    workspaces.refreshNativeSurfaces();
    void windowLoaded.then((loaded) => {
      if (!loaded) return;
      setTimeout(() => {
        launch.finished();
        if (!quitting && !sessionEnded) launch.settled();
      }, LAUNCH_SETTLED_MS).unref?.();
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
        window.on("session-end", () => {
          try {flushTypingCheckpointsSync();} catch {/* Session end cannot be cancelled. */}
          sessionEnded = true;
          launch.finished();
        });
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
        if (!windows.hasWorkspace()) {dependencies.beforeQuitWithoutWindows?.(event); return;}
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
            else if (enabled && !quitting) {
              void services.noticeRunningInBackground().catch(services.reportTrayFailure);
              return services.releaseIdleWorkspaces().catch(() => undefined);
            }
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
