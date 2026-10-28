import { registerTypingCheckpoint } from "./workspaces/outageTypingRecovery";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppLifecycle, LAUNCH_SETTLED_MS } from "./appLifecycle";
import { createAutomationWakeConsumer, createAutomationWakeIntents, type AutomationWakeIntent } from "./automations/automationWakeIntents";
import { createTestScratch } from "./workspaces/testTemp";
import { createWorkspaceAuthorityOwner } from "./workspaces/workspaceAuthorityOwner";
import { createExitRounds, createQuitGuard } from "./quitGuard";
import { DISPATCH_STOP_LIMIT_MS, QUIT_ASK_TIMEOUT_MS, resolveShutdownDeadlineExitCode, WILL_QUIT_BUDGET_MS } from "./shutdownBudgets";
import { closeElectronApplication } from "../../../scripts/verification/close-electron.mjs";
import { DESKTOP_CLOSE_GRACE_MS } from "../../../scripts/verification/desktop-close-policy.mjs";
import { beginLaunch, finishLaunch, type MarkerFileSystem } from "./launch/launchMarker";
import { createShareHandoffIntentSlot } from "./shareHandoffIngress";
import { deferred } from "./testing/deferred";

interface Window {
  id: number;
  zoom: number;
}

type Dependencies = Parameters<typeof createAppLifecycle<Window, string, { zoom: number }>>[0];

function event() {
  return { preventDefault: vi.fn() };
}

function fixture(configure?: (dependencies: Dependencies) => void) {
  const log: string[] = [];
  const appReady = deferred();
  const engine = deferred<boolean>();
  const settings = deferred<{ zoom: number }>();
  const settingsRequested = deferred();
  const created = deferred<Window>();
  const loaded = deferred<boolean>();
  const activated = deferred<string>();
  let zoom = 0;
  let current: Window | undefined;
  class App extends EventEmitter {
    lock = true;
    requestSingleInstanceLock = vi.fn(() => this.lock);
    whenReady = vi.fn(() => appReady.promise);
    quit = vi.fn(() => { log.push("quit"); });
    exit = vi.fn();
  }
  const app = new App();
  const slot = createShareHandoffIntentSlot();
  const cli = { close: vi.fn(async () => { log.push("cli-close"); }) };
  const dependencies: Dependencies = {
    app,
    runtime: { platform: "win32", argv: [process.execPath], execPath: process.execPath },
    handoff: { slot, pendingCodeChanged: vi.fn() },
    windows: {
      create: vi.fn(() => {
        log.push("window");
        current = { id: 1, zoom };
        created.resolve(current);
        return current;
      }),
      whenLoaded: vi.fn(() => { log.push("load-listener"); return loaded.promise; }),
      openFailureTarget: (window) => ({
        whenReady: () => loaded.promise,
        isCurrent: () => current === window,
      }),
      current: () => current,
      hasWorkspace: () => current !== undefined,
      hasAny: () => current !== undefined,
      showOrCreate: vi.fn(async () => current ?? { id: 2, zoom }),
      activate: vi.fn((_window, workspace) => {
        log.push(`activate:${workspace}`);
        activated.resolve(workspace);
      }),
    },
    workspaces: {
      openPath: vi.fn(async (path) => { log.push(`open:${path}`); return path; }),
      recordOpenFailure: vi.fn(),
      reportOpenFailure: vi.fn(),
      refreshNativeSurfaces: vi.fn(() => { log.push("native"); }),
    },
    bootstrap: {
      markReady: vi.fn(() => { log.push("app-ready"); }),
      startEngine: vi.fn(() => { log.push("engine-start"); return engine.promise; }),
      loadSettings: vi.fn(() => {
        log.push("settings-read");
        settingsRequested.resolve();
        return settings.promise;
      }),
      applySettings: vi.fn((value) => { log.push("settings-apply"); zoom = value.zoom; }),
      prepareCli: vi.fn(() => undefined),
      registerHandlers: vi.fn(() => { log.push("handlers"); }),
      markFirstWindow: vi.fn(() => { log.push("first-window"); }),
      reportFailure: vi.fn(() => { log.push("report-failure"); }),
    },
    services: {
      startCli: vi.fn(async () => { log.push("cli-start"); return cli; }),
      reportCliFailure: vi.fn(),
      dispatch: {
        start: vi.fn(() => { log.push("dispatch-start"); }),
        stop: vi.fn(async () => { log.push("dispatch-stop"); }),
      },
      refreshTray: vi.fn(async () => { log.push("tray"); return false; }),
      releaseIdleWorkspaces: vi.fn(async () => { log.push("release idle"); }),
      noticeRunningInBackground: vi.fn(async () => { log.push("background notice"); }),
      reportTrayFailure: vi.fn(),
      warmCredentials: vi.fn(async () => { log.push("credentials"); }),
      reconcileCloud: vi.fn(() => { log.push("cloud"); }),
      startUpdates: vi.fn(() => { log.push("updates"); }),
      updateAfterStartupFailure: vi.fn(async () => { log.push("update-check"); return false; }),
      updateAfterWindowLoadFailure: vi.fn(async () => { log.push("window-update-check"); return false; }),
    },
    launch: {
      finished: vi.fn(() => { log.push("launch-finished"); }),
      settled: vi.fn(() => { log.push("launch-settled"); }),
    },
    beforeQuit: vi.fn(),
    shutdown: {
      budgetMs: 3000,
      deadlineExitCode: 0,
      beginEngineShutdown: vi.fn(() => { log.push("begin-shutdown"); }),
      stopNoticeRefusals: vi.fn(async () => { log.push("notice-refusals-stop"); }),
      stopAutomationWakes: vi.fn(async () => { log.push("automation-wakes-stop"); }),
      stopSearch: vi.fn(async () => { log.push("search-stop"); }),
      stopSitePreviews: vi.fn(async () => { log.push("site-previews-stop"); }),
      removeMarkedCopies: vi.fn(async () => { log.push("marked-copies-remove"); }),
      settleYDocs: vi.fn(async () => { log.push("ydoc-settle"); }),
      stopAgentIntegration: vi.fn(async () => { log.push("integration-stop"); }),
      flushReports: vi.fn(async () => { log.push("reports-flush"); }),
      closeWorkspaces: vi.fn(async () => { log.push("workspaces-close"); }),
      disposeDatabase: vi.fn(async () => { log.push("database-stop"); }),
      closeRelay: vi.fn(async () => { log.push("relay-close"); }),
      stopEngine: vi.fn(async () => { log.push("engine-stop"); }),
      reportQuit: vi.fn(),
    },
  };
  configure?.(dependencies);
  const lifecycle = createAppLifecycle(dependencies);
  return { app, dependencies, lifecycle, log, appReady, engine, settings, settingsRequested, created, loaded, activated, slot, cli };
}

async function boot(f: ReturnType<typeof fixture>) {
  const ready = f.lifecycle.start();
  f.appReady.resolve();
  f.settings.resolve({ zoom: 1.5 });
  f.engine.resolve(true);
  await ready;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("desktop bootstrap", () => {
  it("registers IPC and installs the menu before the window, applies stored zoom, and overlaps the daemon handshake", async () => {
    const f = fixture();
    const ready = f.lifecycle.start();
    expect(f.log).toEqual([]);
    f.appReady.resolve();
    await f.settingsRequested.promise;
    expect(f.log).toEqual(["app-ready", "engine-start", "settings-read", "handlers"]);
    f.settings.resolve({ zoom: 1.75 });
    expect(await f.created.promise).toEqual({ id: 1, zoom: 1.75 });
    expect(f.log.slice(-5)).toEqual(["settings-apply", "native", "window", "load-listener", "first-window"]);
    expect(f.dependencies.services.startCli).not.toHaveBeenCalled();
    expect(f.dependencies.workspaces.openPath).not.toHaveBeenCalled();
    expect(f.dependencies.services.warmCredentials).not.toHaveBeenCalled();
    f.engine.resolve(true);
    await ready;
    expect(f.dependencies.services.startCli).toHaveBeenCalledOnce();
    expect(f.dependencies.services.updateAfterStartupFailure).not.toHaveBeenCalled();
    expect(f.app.quit).not.toHaveBeenCalled();
    expect(f.dependencies.windows.activate).not.toHaveBeenCalled();
  });

  it("waits for platform CLI preparation before handlers without delaying the engine and settings reads", async () => {
    const preparation = deferred();
    const f = fixture((d) => { d.bootstrap.prepareCli = () => preparation.promise; });
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    await f.settingsRequested.promise;
    expect(f.dependencies.bootstrap.startEngine).toHaveBeenCalledOnce();
    expect(f.dependencies.bootstrap.registerHandlers).not.toHaveBeenCalled();
    f.settings.resolve({ zoom: 2 });
    f.engine.resolve(true);
    preparation.resolve();
    await ready;
    expect(f.log.indexOf("handlers")).toBeLessThan(f.log.indexOf("window"));
  });

  it("opens launch paths before later intents and activates only after the renderer subscribes", async () => {
    const duringOpen = deferred<string | null>();
    const pendingStarted = deferred();
    const lateOpened = deferred();
    const f = fixture((d) => {
      d.runtime.argv.push("--open-workspace", "launch");
      d.workspaces.openPath = vi.fn(async (path, window) => {
        if (path === "pending") { pendingStarted.resolve(); return duringOpen.promise; }
        if (path === "late") {
          expect(window).toEqual({ id: 1, zoom: 1.5 });
          lateOpened.resolve();
        }
        return path;
      });
    });
    const ready = f.lifecycle.start();
    f.app.emit("open-file", event(), "pending");
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1.5 });
    f.engine.resolve(true);
    await pendingStarted.promise;
    f.app.emit("open-file", event(), "late");
    duringOpen.resolve("pending");
    await ready;
    expect(f.dependencies.workspaces.openPath).toHaveBeenNthCalledWith(1, "launch", undefined);
    expect(f.dependencies.workspaces.openPath).toHaveBeenNthCalledWith(2, "pending", undefined);
    expect(f.dependencies.windows.activate).not.toHaveBeenCalled();
    f.loaded.resolve(true);
    expect(await f.activated.promise).toBe("pending");
    await lateOpened.promise;
    expect(f.dependencies.workspaces.openPath).toHaveBeenLastCalledWith("late", { id: 1, zoom: 1.5 });
  });

  it("starts updates once the window loads, while the engine handshake is still pending", async () => {
    const updating = deferred();
    const f = fixture((d) => {
      d.services.startUpdates = vi.fn(() => { updating.resolve(); });
    });
    void f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    await f.created.promise;
    expect(f.dependencies.services.startUpdates).not.toHaveBeenCalled();
    f.loaded.resolve(true);
    await updating.promise;
    expect(f.dependencies.bootstrap.startEngine).toHaveBeenCalledOnce();
    expect(f.dependencies.workspaces.openPath).not.toHaveBeenCalled();
  });

  it("starts updates while a launch workspace never finishes opening", async () => {
    const opening = deferred();
    const updating = deferred();
    const f = fixture((d) => {
      d.runtime.argv.push("--open-workspace", "stuck");
      d.workspaces.openPath = vi.fn(() => {
        opening.resolve();
        return new Promise<string>(() => undefined);
      });
      d.services.startUpdates = vi.fn(() => { updating.resolve(); });
    });
    void f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    f.engine.resolve(true);
    await opening.promise;
    f.loaded.resolve(true);
    await updating.promise;
    expect(f.dependencies.services.startUpdates).toHaveBeenCalledOnce();
  });

  it("checks for an update when the first window fails to load, without activating it", async () => {
    const checked = deferred();
    const f = fixture((d) => {
      d.runtime.argv.push("--open-workspace", "launch");
      d.services.updateAfterWindowLoadFailure = vi.fn(async () => { checked.resolve(); return false; });
    });
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    f.engine.resolve(true);
    await ready;
    f.loaded.resolve(false);
    await checked.promise;
    expect(f.dependencies.services.startUpdates).toHaveBeenCalledOnce();
    expect(f.dependencies.windows.activate).not.toHaveBeenCalled();
    expect(f.app.quit).not.toHaveBeenCalled();
  });

  it("starts updates after a delay when the first window never finishes loading", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    f.engine.resolve(true);
    await ready;
    expect(f.dependencies.services.startUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.dependencies.services.startUpdates).toHaveBeenCalledOnce();
    f.loaded.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.services.startUpdates).toHaveBeenCalledOnce();
  });

  it.each([false, true])("checks for an update before quitting when the daemon cannot start (restarting: %s)", async (restarting) => {
    const f = fixture((d) => {
      d.services.updateAfterStartupFailure = vi.fn(async () => {
        f.log.push("update-check");
        return restarting;
      });
    });
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    f.engine.resolve(false);
    await ready;
    expect(f.log.slice(f.log.indexOf("first-window") + 1)).toEqual(
      restarting ? ["updates", "update-check"] : ["updates", "update-check", "quit"],
    );
    expect(f.dependencies.workspaces.openPath).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports a bootstrap failure, then checks for an update before quitting (restarting: %s)", async (restarting) => {
    const failure = new Error("handlers failed");
    const f = fixture((d) => {
      d.bootstrap.registerHandlers = () => { throw failure; };
      d.services.updateAfterStartupFailure = vi.fn(async () => {
        f.log.push("update-check");
        return restarting;
      });
    });
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    await ready;
    expect(f.dependencies.bootstrap.reportFailure).toHaveBeenCalledWith(failure);
    expect(f.log.slice(f.log.indexOf("report-failure"))).toEqual(
      restarting ? ["report-failure", "updates", "update-check"] : ["report-failure", "updates", "update-check", "quit"],
    );
  });

  it("keeps activation and incoming paths deferred when the daemon cannot start", async () => {
    const f = fixture();
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    f.engine.resolve(false);
    await ready;
    f.app.emit("activate");
    f.app.emit("open-file", event(), "deferred");
    expect(f.dependencies.services.startCli).not.toHaveBeenCalled();
    expect(f.dependencies.workspaces.openPath).not.toHaveBeenCalled();
    expect(f.dependencies.windows.showOrCreate).not.toHaveBeenCalled();
  });

  it("reports a bootstrap rejection and uses the ordinary quit guard without stopping producers", async () => {
    const failure = new Error("settings unavailable");
    const f = fixture((d) => {
      d.bootstrap.registerHandlers = () => { throw failure; };
      d.windows.hasWorkspace = () => true;
    });
    const askRenderer = vi.fn();
    const guard = createQuitGuard({
      ask: askRenderer,
      quit: () => f.app.quit(),
      forceQuit: vi.fn(),
    });
    f.dependencies.beforeQuit = (quitEvent) => { guard.beforeQuit(quitEvent); };
    f.app.quit.mockImplementation(() => { f.app.emit("before-quit", event()); });
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    await ready;
    expect(f.dependencies.bootstrap.reportFailure).toHaveBeenCalledWith(failure);
    expect(askRenderer).toHaveBeenCalledOnce();
    expect(f.lifecycle.isQuitting()).toBe(false);
    expect(f.dependencies.shutdown.beginEngineShutdown).not.toHaveBeenCalled();
    guard.hold();
  });

  it("finishes the launch once the app has run 30 s after its first window loaded", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await boot(f);
    f.loaded.resolve(true);
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLED_MS - 1);
    expect(f.dependencies.launch.finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.dependencies.launch.finished).toHaveBeenCalledOnce();
    expect(f.dependencies.launch.settled).toHaveBeenCalledOnce();
  });

  // Settling starts the engine's startup check, which must not run on the
  // way out: the timer can still fire during quit or after Windows ends the
  // session, neither of which stops the process at once.
  it.each(["quit", "session end"] as const)("does not settle the launch after a %s", async (ending) => {
    vi.useFakeTimers();
    const f = fixture();
    await boot(f);
    f.loaded.resolve(true);
    await vi.advanceTimersByTimeAsync(5_000);
    if (ending === "quit") {
      f.app.emit("will-quit", event());
    } else {
      const window = new EventEmitter();
      f.app.emit("browser-window-created", {}, window);
      window.emit("session-end", {});
    }
    await vi.advanceTimersByTimeAsync(LAUNCH_SETTLED_MS);
    expect(f.dependencies.launch.finished).toHaveBeenCalled();
    expect(f.dependencies.launch.settled).not.toHaveBeenCalled();
  });

  it("finishes the launch at a clean quit before 30 s have passed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await boot(f);
    f.loaded.resolve(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.dependencies.launch.finished).not.toHaveBeenCalled();
    f.app.emit("will-quit", event());
    expect(f.dependencies.launch.finished).toHaveBeenCalledOnce();
    // A quit vetoed at before-quit never reaches will-quit, so it counts nothing.
  });

  it("flushes outage typing at OS session end without cancelling the end", async () => {
    const f = fixture(); await boot(f); const window = new EventEmitter();
    const flush = vi.fn(() => undefined); const unregister = registerTypingCheckpoint("workspace", async()=>{},()=>true,undefined,flush);
    try {
      f.app.emit("browser-window-created", {}, window); const preventDefault = vi.fn();
      window.emit("session-end", {preventDefault});
      expect(flush).toHaveBeenCalledOnce(); expect(preventDefault).not.toHaveBeenCalled();
    } finally {unregister();}
  });

  it("finishes the launch when Windows ends the session, which emits no quit event", async () => {
    const f = fixture();
    await boot(f);
    const early = new EventEmitter();
    f.app.emit("browser-window-created", {}, early);
    early.emit("query-session-end", { preventDefault: vi.fn() });
    // query-session-end can still be cancelled; only session-end is final.
    expect(f.dependencies.launch.finished).not.toHaveBeenCalled();
    early.emit("session-end", {});
    expect(f.dependencies.launch.finished).toHaveBeenCalledOnce();
    const later = new EventEmitter();
    f.app.emit("browser-window-created", {}, later);
    later.emit("session-end", {});
    expect(f.dependencies.launch.finished).toHaveBeenCalledTimes(2);
  });

  it("keeps the launch marker when the process dies within 30 s of its first window", async () => {
    vi.useFakeTimers();
    const files = new Map<string, string>();
    const disk: MarkerFileSystem = {
      readFileSync: (path) => { const content = files.get(path); if (content === undefined) throw new Error("missing"); return content; },
      writeFileSync: (path, data) => { files.set(path, data); },
      rmSync: (path) => { files.delete(path); },
    };
    const f = fixture((d) => { d.launch.finished = finishLaunch; });
    beginLaunch("/profile/dohc-launch.json", "1.0.0", null, disk);
    try {
      await boot(f);
      f.loaded.resolve(true);
      await vi.advanceTimersByTimeAsync(LAUNCH_SETTLED_MS - 1);
      // A crash or a native exit here runs no quit event and no timer, so the
      // next launch reads this count.
      expect(files.get("/profile/dohc-launch.json")).toBe(JSON.stringify({ version: "1.0.0", unfinished: 1 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(files.has("/profile/dohc-launch.json")).toBe(false);
    } finally { finishLaunch(); }
  });

  it.each([true, false])("leaves the launch unfinished when the engine fails (window loaded: %s)", async (windowLoads) => {
    const f = fixture();
    const ready = f.lifecycle.start();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1 });
    f.engine.resolve(false);
    f.loaded.resolve(windowLoads);
    await ready;
    await vi.waitFor(() => expect(f.dependencies.services.startUpdates).toHaveBeenCalled());
    expect(f.dependencies.launch.finished).not.toHaveBeenCalled();
  });

  it("leaves the launch unfinished when the first window fails to load", async () => {
    const f = fixture();
    await boot(f);
    f.loaded.resolve(false);
    await vi.waitFor(() => expect(f.dependencies.services.updateAfterWindowLoadFailure).toHaveBeenCalledOnce());
    expect(f.dependencies.launch.finished).not.toHaveBeenCalled();
  });

  it("does not bootstrap or capture handoff intents in a losing process", async () => {
    const f = fixture((d) => { d.runtime.argv.push(handoffUrl); });
    f.app.lock = false;
    await f.lifecycle.start();
    expect(f.app.quit).toHaveBeenCalledOnce();
    expect(f.dependencies.launch.finished).not.toHaveBeenCalled();
    expect(f.app.whenReady).not.toHaveBeenCalled();
    expect(f.slot.pending()).toBeNull();
    expect(f.app.listenerCount("open-url")).toBe(0);
    expect(f.app.listenerCount("before-quit")).toBe(0);
    expect(f.app.listenerCount("will-quit")).toBe(1);
  });
});

const handoffUrl = `dohc://open/${"a".repeat(43)}?relay=${encodeURIComponent("https://relay.example")}`;

describe("desktop open intents", () => {
  it("captures cold and pre-ready handoffs without creating another window", async () => {
    const f = fixture((d) => { d.runtime.argv.push(handoffUrl); });
    const ready = f.lifecycle.start();
    expect(f.slot.pending()?.relayUrl).toBe("https://relay.example");
    const incoming = event();
    f.app.emit("open-url", incoming, handoffUrl);
    expect(incoming.preventDefault).toHaveBeenCalledOnce();
    expect(f.dependencies.windows.showOrCreate).not.toHaveBeenCalled();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 0 });
    f.engine.resolve(true);
    await ready;
    f.app.emit("open-url", event(), handoffUrl);
    expect(f.dependencies.windows.showOrCreate).toHaveBeenCalledOnce();
  });

  it("uses macOS URL events instead of command-line handoffs", async () => {
    const f = fixture((d) => {
      d.runtime = { ...d.runtime, platform: "darwin", argv: [...d.runtime.argv, handoffUrl] };
    });
    const ready = f.lifecycle.start();
    expect(f.slot.pending()).toBeNull();
    f.app.emit("open-url", event(), handoffUrl);
    expect(f.slot.pending()).not.toBeNull();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 0 });
    f.engine.resolve(true);
    await ready;
  });

  it("ignores rejected second-instance handoffs unless they also contain a workspace path", async () => {
    const opened = deferred();
    const f = fixture((d) => {
      d.workspaces.openPath = vi.fn(async (path) => { opened.resolve(); return path; });
    });
    await boot(f);
    f.app.emit("second-instance", {}, [process.execPath, "dohc://invalid"]);
    expect(f.dependencies.windows.showOrCreate).not.toHaveBeenCalled();
    f.app.emit("second-instance", {}, [process.execPath, "dohc://invalid", "--open-workspace=next"]);
    await opened.promise;
    expect(f.dependencies.workspaces.openPath).toHaveBeenCalledWith("next", { id: 1, zoom: 1.5 });
  });

  it.each(["argv", "open-file", "second-instance"])("retains %s failures and reports each once after renderer readiness", async (source) => {
    const first = new Error("registration refused");
    const second = new Error("activation refused");
    const f = fixture((d) => {
      if (source === "argv") d.runtime.argv.push("--open-workspace=bad", "--open-workspace=good", "--open-workspace=also-bad", "--open-workspace=missing");
      d.workspaces.openPath = vi.fn(async (path) => {
        if (path === "bad") throw first;
        if (path === "also-bad") throw second;
        return path === "missing" ? null : path;
      });
    });
    const ready = f.lifecycle.start();
    if (source === "open-file") {
      for (const path of ["bad", "good", "also-bad", "missing"]) f.app.emit("open-file", event(), path);
    } else if (source === "second-instance") {
      f.app.emit("second-instance", {}, [process.execPath, "--open-workspace=bad", "--open-workspace=good", "--open-workspace=also-bad", "--open-workspace=missing"]);
    }
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1.5 });
    f.engine.resolve(true);
    await ready;
    expect(f.dependencies.workspaces.openPath).toHaveBeenCalledTimes(4);
    expect(f.dependencies.workspaces.recordOpenFailure).toHaveBeenCalledTimes(2);
    expect(f.dependencies.workspaces.recordOpenFailure).toHaveBeenNthCalledWith(1, "bad", first);
    expect(f.dependencies.workspaces.recordOpenFailure).toHaveBeenNthCalledWith(2, "also-bad", second);
    expect(f.dependencies.workspaces.reportOpenFailure).not.toHaveBeenCalled();
    f.loaded.resolve(true);
    expect(await f.activated.promise).toBe("good");
    await Promise.resolve();
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenCalledTimes(2);
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenNthCalledWith(1, "bad", first, { id: 1, zoom: 1.5 });
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenNthCalledWith(2, "also-bad", second, { id: 1, zoom: 1.5 });
    f.app.emit("activate");
    await Promise.resolve();
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenCalledTimes(2);
    expect(f.dependencies.bootstrap.reportFailure).not.toHaveBeenCalled();
    expect(f.app.quit).not.toHaveBeenCalled();
  });

  it.each(["open-file", "second-instance"])("reports post-bootstrap %s failures without waiting to open the next path", async (source) => {
    const failure = new Error("unavailable");
    const nextOpened = deferred();
    const reported = deferred();
    const f = fixture((d) => {
      d.workspaces.openPath = vi.fn(async (path) => {
        if (path === "bad") throw failure;
        nextOpened.resolve();
        return path;
      });
      d.workspaces.reportOpenFailure = vi.fn(() => reported.resolve());
    });
    await boot(f);
    if (source === "open-file") {
      f.app.emit("open-file", event(), "bad");
      f.app.emit("open-file", event(), "good");
    } else {
      f.app.emit("second-instance", {}, [process.execPath, "--open-workspace=bad", "--open-workspace=good"]);
    }
    await nextOpened.promise;
    expect(f.dependencies.workspaces.reportOpenFailure).not.toHaveBeenCalled();
    f.loaded.resolve(true);
    await reported.promise;
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenCalledExactlyOnceWith("bad", failure, { id: 1, zoom: 1.5 });
  });

  it("keeps pending-intent priority after launch and queued failures", async () => {
    const pending = deferred<string | null>();
    const pendingStarted = deferred();
    const lateOpened = deferred();
    const failure = new Error("cannot register");
    const f = fixture((d) => {
      d.runtime.argv.push("--open-workspace=launch", "--open-workspace=bad");
      d.workspaces.openPath = vi.fn(async (path) => {
        if (path === "bad") throw failure;
        if (path === "pending") { pendingStarted.resolve(); return pending.promise; }
        if (path === "late") lateOpened.resolve();
        return path;
      });
    });
    const ready = f.lifecycle.start();
    f.app.emit("open-file", event(), "bad");
    f.app.emit("open-file", event(), "pending");
    f.appReady.resolve();
    f.settings.resolve({ zoom: 1.5 });
    f.engine.resolve(true);
    await pendingStarted.promise;
    f.app.emit("open-file", event(), "late");
    pending.resolve("pending");
    await ready;
    f.loaded.resolve(true);
    expect(await f.activated.promise).toBe("pending");
    await lateOpened.promise;
    expect(f.dependencies.workspaces.openPath).toHaveBeenLastCalledWith("late", { id: 1, zoom: 1.5 });
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenCalledTimes(2);
  });

  it.each(["failed-load", "closed", "replaced", "workspace-changed"])("does not deliver delayed failures to a %s target", async (change) => {
    let current = true;
    const failure = new Error("refused");
    const f = fixture((d) => {
      d.runtime.argv.push("--open-workspace=bad");
      d.workspaces.openPath = vi.fn(async () => { throw failure; });
      d.windows.openFailureTarget = () => ({ whenReady: () => f.loaded.promise, isCurrent: () => current });
    });
    await boot(f);
    expect(f.dependencies.workspaces.recordOpenFailure).toHaveBeenCalledExactlyOnceWith("bad", failure);
    if (change !== "failed-load") current = false;
    f.loaded.resolve(change !== "failed-load");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.dependencies.workspaces.reportOpenFailure).not.toHaveBeenCalled();
  });

  it("reports into a replacement created for its own OS request", async () => {
    const replacement = { id: 2, zoom: 1.5 };
    const failure = new Error("refused");
    const reported = deferred();
    const opened = deferred();
    const f = fixture((d) => {
      d.windows.current = () => undefined;
      d.windows.showOrCreate = vi.fn(async () => replacement);
      d.windows.openFailureTarget = () => ({ whenReady: () => f.loaded.promise, isCurrent: () => true });
      d.workspaces.openPath = vi.fn(async () => { opened.resolve(); throw failure; });
      d.workspaces.reportOpenFailure = vi.fn(() => reported.resolve());
    });
    await boot(f);
    f.app.emit("open-file", event(), "bad");
    await opened.promise;
    f.loaded.resolve(true);
    await reported.promise;
    expect(f.dependencies.workspaces.reportOpenFailure).toHaveBeenCalledExactlyOnceWith("bad", failure, replacement);
  });
  it("deduplicates launch arguments, skips the executable, and continues after an unopenable path", async () => {
    const absolute = resolve("workspace");
    const f = fixture((d) => {
      d.runtime.argv.push(process.execPath, "--open-workspace", "bad", "--open-workspace=good", "--open-workspace=good", absolute, "/app/dist/main/main.js");
      d.workspaces.openPath = vi.fn(async (path) => {
        if (path === "bad") throw new Error("unavailable");
        return path;
      });
    });
    await boot(f);
    expect(f.dependencies.workspaces.openPath).toHaveBeenCalledTimes(3);
    f.loaded.resolve(true);
    expect(await f.activated.promise).toBe(absolute);
  });

  it("opens a window for a post-bootstrap file event when no window remains", async () => {
    const opened = deferred();
    const replacement = { id: 2, zoom: 1.5 };
    const f = fixture((d) => {
      d.windows.current = () => undefined;
      d.windows.showOrCreate = vi.fn(async () => replacement);
      d.workspaces.openPath = vi.fn(async (path) => { opened.resolve(); return path; });
    });
    await boot(f);
    f.app.emit("open-file", event(), "next");
    await opened.promise;
    expect(f.dependencies.windows.showOrCreate).toHaveBeenCalledOnce();
    expect(f.dependencies.workspaces.openPath).toHaveBeenCalledWith("next", replacement);
  });

  it("activates a new window only after bootstrap and when all windows are gone", async () => {
    const f = fixture();
    const ready = f.lifecycle.start();
    f.app.emit("activate");
    expect(f.dependencies.windows.showOrCreate).not.toHaveBeenCalled();
    f.appReady.resolve();
    f.settings.resolve({ zoom: 0 });
    f.engine.resolve(true);
    await ready;
    f.app.emit("activate");
    expect(f.dependencies.windows.showOrCreate).not.toHaveBeenCalled();
    f.dependencies.windows.hasAny = () => false;
    f.app.emit("activate");
    expect(f.dependencies.windows.showOrCreate).toHaveBeenCalledOnce();
  });
});

describe("desktop shutdown", () => {
  it.each([
    { desktopTest: undefined, isPackaged: false, expected: 0 },
    { desktopTest: "1", isPackaged: false, expected: 1 },
    { desktopTest: undefined, isPackaged: true, expected: 0 },
    { desktopTest: "1", isPackaged: true, expected: 0 },
    { desktopTest: "0", isPackaged: false, expected: 0 },
    { desktopTest: "true", isPackaged: false, expected: 0 },
  ])("reports deadline failure only for an unpackaged test app: %j", ({ desktopTest, isPackaged, expected }) => {
    expect(resolveShutdownDeadlineExitCode({ desktopTest, isPackaged })).toBe(expected);
  });

  it("lets renderer approval and accepted-write drain finish beyond the old helper deadline", async () => {
    vi.useFakeTimers();
    const heldWrite = deferred();
    const exited = deferred();
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
    const f = fixture((d) => {
      d.shutdown.budgetMs = WILL_QUIT_BUDGET_MS;
      d.shutdown.deadlineExitCode = 1;
      d.shutdown.settleYDocs = () => heldWrite.promise;
    });
    const rounds = createExitRounds({
      participants: () => [{ id: 1 }],
      participantId: (participant) => participant.id,
      send: vi.fn(),
      confirmProceed: async () => false,
    });
    const guard = createQuitGuard({
      ask: () => { void rounds.begin("quit").outcome.then((outcome) => { if (outcome === "proceed") guard.resume(); }); },
      quit: () => f.app.quit(),
      forceQuit: vi.fn(),
    });
    f.dependencies.beforeQuit = (quitEvent) => { guard.beforeQuit(quitEvent); };
    f.app.quit.mockImplementation(() => {
      const quitEvent = event();
      f.app.emit("before-quit", quitEvent);
      if (!quitEvent.preventDefault.mock.calls.length) f.app.emit("will-quit", event());
    });
    f.app.exit.mockImplementation((code: number) => {
      child.exitCode = code;
      child.emit("exit", code, null);
      exited.resolve();
    });
    await boot(f);
    const closing = closeElectronApplication({ close: () => { f.app.quit(); return exited.promise; } }, child as unknown as ChildProcess, DESKTOP_CLOSE_GRACE_MS)
      .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    await vi.advanceTimersByTimeAsync(QUIT_ASK_TIMEOUT_MS - 1);
    expect(f.dependencies.shutdown.beginEngineShutdown).not.toHaveBeenCalled();
    rounds.answer(1, rounds.current()!.roundId, "clear");
    await vi.advanceTimersByTimeAsync(5_000 - (QUIT_ASK_TIMEOUT_MS - 1));
    expect(f.dependencies.shutdown.beginEngineShutdown).toHaveBeenCalledOnce();
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    expect(f.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIT_ASK_TIMEOUT_MS + WILL_QUIT_BUDGET_MS - 2 - 5_000);
    heldWrite.resolve();
    expect(await closing).toEqual({ ok: true });
    expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(["notices", "automationWakes", "search", "sitePreviews", "dispatch", "ydoc", "integration", "cli"] as const)(
    "waits for %s before releasing workspace authority",
    async (heldProducer) => {
      vi.useFakeTimers();
      const gates = {
        notices: deferred(), automationWakes: deferred(), search: deferred(), sitePreviews: deferred(), dispatch: deferred(),
        ydoc: deferred(), integration: deferred(), cli: deferred(),
      };
      const f = fixture((d) => {
        d.shutdown.stopNoticeRefusals = () => gates.notices.promise;
        d.shutdown.stopAutomationWakes = () => gates.automationWakes.promise;
        d.shutdown.stopSearch = () => gates.search.promise;
        d.shutdown.stopSitePreviews = () => gates.sitePreviews.promise;
        d.services.dispatch.stop = () => gates.dispatch.promise;
        d.shutdown.settleYDocs = () => gates.ydoc.promise;
        d.shutdown.stopAgentIntegration = () => gates.integration.promise;
        d.services.startCli = async () => ({ close: () => gates.cli.promise });
      });
      await boot(f);
      f.app.emit("will-quit", event());
      for (const [producer, gate] of Object.entries(gates)) {
        if (producer !== heldProducer) gate.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
      gates[heldProducer].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
      expect(f.app.exit).toHaveBeenCalledWith(0);
    },
  );

  it("settles every producer before closing authorities, then closes database, relay, and daemon", async () => {
    vi.useFakeTimers();
    const gates = {
      notices: deferred(), automationWakes: deferred(), search: deferred(), sitePreviews: deferred(), dispatch: deferred(),
      ydoc: deferred(), integration: deferred(), cli: deferred(),
    };
    const integrationStarted = deferred();
    const cliStarted = deferred();
    const workspacesClosed = deferred();
    const exited = deferred();
    const f = fixture((d) => {
      d.shutdown.stopNoticeRefusals = vi.fn(() => gates.notices.promise);
      d.shutdown.stopAutomationWakes = vi.fn(() => gates.automationWakes.promise);
      d.shutdown.stopSearch = () => gates.search.promise;
      d.shutdown.stopSitePreviews = () => gates.sitePreviews.promise;
      d.services.dispatch.stop = () => gates.dispatch.promise;
      d.shutdown.settleYDocs = () => gates.ydoc.promise;
      d.shutdown.stopAgentIntegration = () => { integrationStarted.resolve(); return gates.integration.promise; };
      d.services.startCli = async () => ({ close: () => { cliStarted.resolve(); return gates.cli.promise; } });
      d.shutdown.closeWorkspaces = vi.fn(async () => { workspacesClosed.resolve(); });
    });
    f.app.exit.mockImplementation(() => { exited.resolve(); });
    await boot(f);
    const quit = event();
    f.app.emit("will-quit", quit);
    expect(quit.preventDefault).toHaveBeenCalledOnce();
    expect(f.lifecycle.isQuitting()).toBe(true);
    expect(f.dependencies.shutdown.beginEngineShutdown).toHaveBeenCalledOnce();
    // Refusal Notices and agent wakes both stop before any producer starts to
    // drain, and neither waits for the other.
    for (const stop of [f.dependencies.shutdown.stopNoticeRefusals, f.dependencies.shutdown.stopAutomationWakes]) {
      expect(vi.mocked(stop).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(f.dependencies.shutdown.beginEngineShutdown).mock.invocationCallOrder[0]!);
    }
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    await integrationStarted.promise;
    gates.dispatch.resolve();
    await cliStarted.promise;
    gates.search.resolve();
    gates.sitePreviews.resolve();
    gates.integration.resolve();
    gates.cli.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    expect(f.app.exit).not.toHaveBeenCalled();
    gates.ydoc.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    gates.notices.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    gates.automationWakes.resolve();
    await workspacesClosed.promise;
    await exited.promise;
    expect(f.log.slice(-3)).toEqual(["database-stop", "relay-close", "engine-stop"]);
  });

  it("closes a late CLI server after quit and never starts dispatch", async () => {
    vi.useFakeTimers();
    const cliReady = deferred<{ close(): Promise<void> }>();
    const cliClosed = deferred();
    const f = fixture((d) => { d.services.startCli = () => cliReady.promise; });
    await boot(f);
    f.app.emit("will-quit", event());
    const close = vi.fn(async () => { cliClosed.resolve(); });
    cliReady.resolve({ close });
    await cliClosed.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(f.dependencies.services.dispatch.start).not.toHaveBeenCalled();
    expect(f.app.exit).toHaveBeenCalledWith(0);
  });

  it("awaits authority, database, and relay teardown before stopping the daemon", async () => {
    vi.useFakeTimers();
    const authority = deferred();
    const database = deferred();
    const relay = deferred();
    const f = fixture((d) => {
      d.shutdown.closeWorkspaces = vi.fn(() => authority.promise);
      d.shutdown.disposeDatabase = vi.fn(() => database.promise);
      d.shutdown.closeRelay = vi.fn(() => relay.promise);
    });
    f.app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
    expect(f.dependencies.shutdown.disposeDatabase).not.toHaveBeenCalled();
    authority.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.disposeDatabase).toHaveBeenCalledOnce();
    expect(f.dependencies.shutdown.closeRelay).not.toHaveBeenCalled();
    database.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeRelay).toHaveBeenCalledOnce();
    expect(f.dependencies.shutdown.stopEngine).not.toHaveBeenCalled();
    relay.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.stopEngine).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledWith(0);
    expect(f.dependencies.shutdown.reportQuit).toHaveBeenCalledExactlyOnceWith("[desktop] quit: shutdown finished in 0 ms");
  });

  it.each([0, 1] as const)("exits once with deadline status %s without closing a store beneath a held producer", async (deadlineExitCode) => {
    vi.useFakeTimers();
    const held = deferred();
    const f = fixture((d) => {
      d.shutdown.budgetMs = WILL_QUIT_BUDGET_MS;
      d.shutdown.deadlineExitCode = deadlineExitCode;
      d.shutdown.settleYDocs = () => held.promise;
    });
    f.app.emit("will-quit", event());
    const repeated = event();
    f.app.emit("will-quit", repeated);
    expect(repeated.preventDefault).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WILL_QUIT_BUDGET_MS - 1);
    expect(f.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(deadlineExitCode);
    expect(f.dependencies.shutdown.reportQuit).toHaveBeenCalledExactlyOnceWith(`[desktop] quit: shutdown ran past its ${WILL_QUIT_BUDGET_MS} ms budget`);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledOnce();
  });

  it.each([
    ["refusal Notice work", 0],
    ["refusal Notice work", 1],
    ["an agent wake", 0],
    ["an agent wake", 1],
  ] as const)("exits once while %s holds authorities open, with deadline status %d", async (work, deadlineExitCode) => {
    vi.useFakeTimers();
    const held = deferred();
    const f = fixture((d) => {
      d.shutdown.budgetMs = WILL_QUIT_BUDGET_MS;
      d.shutdown.deadlineExitCode = deadlineExitCode;
      if (work === "an agent wake") d.shutdown.stopAutomationWakes = () => held.promise;
      else d.shutdown.stopNoticeRefusals = () => held.promise;
    });
    await boot(f);
    f.app.emit("will-quit", event());
    expect(f.dependencies.shutdown.flushReports).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(WILL_QUIT_BUDGET_MS - 1);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    expect(f.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(deadlineExitCode);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.exit).toHaveBeenCalledOnce();
  });

  it("stops waiting on a dispatch stop at its limit and still closes within the budget", async () => {
    vi.useFakeTimers();
    const f = fixture((d) => {
      d.shutdown.budgetMs = WILL_QUIT_BUDGET_MS;
      d.shutdown.deadlineExitCode = 1;
      d.services.dispatch.stop = () => new Promise<void>(() => undefined);
    });
    await boot(f);
    f.app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(DISPATCH_STOP_LIMIT_MS - 1);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.log.slice(-4)).toEqual(["workspaces-close", "database-stop", "relay-close", "engine-stop"]);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(DISPATCH_STOP_LIMIT_MS).toBeLessThan(WILL_QUIT_BUDGET_MS);
  });

  it.each(["refusal Notice work", "an agent wake"] as const)("keeps %s ahead of authority close after dispatch reaches its limit", async (work) => {
    vi.useFakeTimers();
    const held = deferred();
    const f = fixture((d) => {
      d.shutdown.budgetMs = WILL_QUIT_BUDGET_MS;
      d.shutdown.deadlineExitCode = 1;
      if (work === "an agent wake") d.shutdown.stopAutomationWakes = () => held.promise;
      else d.shutdown.stopNoticeRefusals = () => held.promise;
      d.services.dispatch.stop = () => new Promise<void>(() => undefined);
    });
    await boot(f);
    f.app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(DISPATCH_STOP_LIMIT_MS);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    expect(f.app.exit).not.toHaveBeenCalled();
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("lets an admitted agent wake finish under open workspace authority, and closes it only after that wake", async () => {
    const file = join(await createTestScratch("quit-wakes-"), "automation-wakes.json");
    const intent = (letter: string, claimed: boolean): AutomationWakeIntent => ({
      account: "relay#owner", workspaceId: "workspace", noticeId: "automation-wake:" + letter.repeat(64), claimed,
      wake: { automationId: "collection:Tasks#ask", name: "Ask", depth: 1, body: "Check the task." },
    });
    const journal = createAutomationWakeIntents(file);
    await journal.save(intent("a", true));
    await journal.save(intent("b", false));
    const authorities = createWorkspaceAuthorityOwner({
      findWorkspace: (workspaceId) => ({ workspaceId, rootPath: "/workspace" }),
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => ({}),
    });
    let closing = false;
    const acquisitions: Array<{ step: string; afterClose: boolean }> = [];
    const withAuthority = async (step: string, work: () => Promise<void> = async () => undefined) => {
      acquisitions.push({ step, afterClose: closing });
      await authorities.withAuthority("workspace", work);
    };
    const waking = deferred();
    const finishWake = deferred();
    const ready = vi.fn(async (_intent: { noticeId: string }, _needsRunner: boolean) => true);
    const errors: unknown[] = [];
    const consumer = createAutomationWakeConsumer({
      intents: journal,
      pending: async () => [],
      ready,
      enabledIfOpen: async () => true,
      enabled: async () => { await withAuthority("read automation"); return true; },
      dismiss: async () => "first",
      wake: async () => {
        await withAuthority("open activity");
        try {
          await withAuthority("write wake", async () => { waking.resolve(); await finishWake.promise; });
        } finally { await withAuthority("release activity"); }
      },
      onError: (error) => errors.push(error),
    });
    const exited = deferred<number>();
    const f = fixture((d) => {
      d.shutdown.deadlineExitCode = 1;
      d.shutdown.stopAutomationWakes = () => consumer.stop();
      d.shutdown.closeWorkspaces = vi.fn(async () => {
        closing = true;
        // A Notice change while authorities close asks the stopped consumer again.
        void consumer.resume();
        await authorities.close();
      });
    });
    f.app.exit.mockImplementation((code: number) => { exited.resolve(code); });
    void consumer.resume();
    await waking.promise;
    f.app.emit("will-quit", event());
    void consumer.resume();
    expect(await journal.list()).toEqual([intent("a", true), intent("b", false)]);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    finishWake.resolve();
    expect(await exited.promise).toBe(0);
    expect(errors).toEqual([]);
    expect(acquisitions).toEqual(["read automation", "open activity", "write wake", "release activity"]
      .map((step) => ({ step, afterClose: false })));
    expect(new Set(ready.mock.calls.map(([admitted]) => admitted.noticeId))).toEqual(new Set([intent("a", true).noticeId]));
    // The wake that was never admitted stays saved for the next start.
    expect(await createAutomationWakeIntents(file).list()).toEqual([intent("b", false)]);
  });

  it("sends reports alongside teardown and exits only once both finish", async () => {
    vi.useFakeTimers();
    const ydoc = deferred();
    const reports = deferred();
    const f = fixture((d) => {
      d.shutdown.settleYDocs = () => ydoc.promise;
      d.shutdown.flushReports = vi.fn(() => reports.promise);
    });
    await boot(f);
    f.app.emit("will-quit", event());
    // Reports start while producers still drain, and teardown does not wait for them.
    expect(f.dependencies.shutdown.flushReports).toHaveBeenCalledOnce();
    ydoc.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.stopEngine).toHaveBeenCalledOnce();
    expect(f.app.exit).not.toHaveBeenCalled();
    reports.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits at the shutdown budget when reports never finish", async () => {
    vi.useFakeTimers();
    const f = fixture((d) => {
      d.shutdown.budgetMs = WILL_QUIT_BUDGET_MS;
      d.shutdown.deadlineExitCode = 1;
      d.shutdown.flushReports = () => new Promise<void>(() => undefined);
    });
    await boot(f);
    f.app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(WILL_QUIT_BUDGET_MS - 1);
    expect(f.dependencies.shutdown.stopEngine).toHaveBeenCalledOnce();
    expect(f.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("removes opened copies at quit and exits only once that finishes, even when it fails", async () => {
    vi.useFakeTimers();
    const removal = deferred();
    const f = fixture((d) => { d.shutdown.removeMarkedCopies = vi.fn(() => removal.promise); });
    await boot(f);
    f.app.emit("will-quit", event());
    expect(f.dependencies.shutdown.removeMarkedCopies).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.stopEngine).toHaveBeenCalledOnce();
    expect(f.app.exit).not.toHaveBeenCalled();
    removal.reject(new Error("a copy is still open"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits normally when sending reports fails", async () => {
    vi.useFakeTimers();
    const f = fixture((d) => { d.shutdown.flushReports = async () => { throw new Error("reports"); }; });
    await boot(f);
    f.app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps producer failure contained and preserves database-failure skipping of relay teardown", async () => {
    vi.useFakeTimers();
    const f = fixture((d) => {
      d.shutdown.stopSitePreviews = async () => { throw new Error("site previews"); };
      d.shutdown.disposeDatabase = async () => { throw new Error("database"); };
    });
    f.app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
    expect(f.dependencies.shutdown.closeRelay).not.toHaveBeenCalled();
    expect(f.dependencies.shutdown.stopEngine).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledWith(0);
  });

  it("asks only workspace renderers before quit and leaves vetoed producers running", async () => {
    const f = fixture((d) => { d.windows.hasWorkspace = () => false; });
    await boot(f);
    f.app.emit("before-quit", event());
    expect(f.dependencies.beforeQuit).not.toHaveBeenCalled();
    f.dependencies.windows.hasWorkspace = () => true;
    const quit = event();
    f.app.emit("before-quit", quit);
    expect(f.dependencies.beforeQuit).toHaveBeenCalledWith(quit);
    expect(f.dependencies.shutdown.beginEngineShutdown).not.toHaveBeenCalled();
  });

  it("runs the checkpoint boundary when ordinary quit has no workspace window", async () => {
    const checkpoint = vi.fn((quit: {preventDefault(): void}) => quit.preventDefault());
    const f = fixture(d => {d.windows.hasWorkspace = () => false; d.beforeQuitWithoutWindows = checkpoint;});
    await boot(f); const quit = event(); f.app.emit("before-quit", quit);
    expect(checkpoint).toHaveBeenCalledWith(quit); expect(f.dependencies.beforeQuit).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the process after the last window only when dispatch is enabled: %s", async (enabled) => {
    vi.useFakeTimers();
    const f = fixture((d) => { d.services.refreshTray = async () => enabled; });
    await boot(f);
    f.app.emit("window-all-closed");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.quit).toHaveBeenCalledTimes(enabled ? 0 : 1);
    expect(f.dependencies.services.releaseIdleWorkspaces, "staying closes the workspaces nothing uses").toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(f.dependencies.services.noticeRunningInBackground, "staying says so").toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it("reports a failed background notice and still closes idle workspaces", async () => {
    vi.useFakeTimers();
    const failure = new Error("notice");
    const f = fixture((d) => {
      d.services.refreshTray = async () => true;
      d.services.noticeRunningInBackground = vi.fn(async () => { throw failure; });
    });
    await boot(f);
    f.app.emit("window-all-closed");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.services.reportTrayFailure).toHaveBeenCalledWith(failure);
    expect(f.dependencies.services.releaseIdleWorkspaces).toHaveBeenCalledOnce();
    expect(f.app.quit).not.toHaveBeenCalled();
  });

  it("quits once the last reason to run without windows goes, and not while a window is open", async () => {
    let keep = true;
    const f = fixture((d) => { d.services.refreshTray = async () => keep; });
    await f.lifecycle.backgroundReasonsChanged();
    expect(f.app.quit, "a schedule still runs").not.toHaveBeenCalled();
    keep = false;
    await f.lifecycle.backgroundReasonsChanged();
    expect(f.app.quit, "no window and nothing to run").toHaveBeenCalledOnce();

    const withWindow = fixture((d) => { d.services.refreshTray = async () => false; });
    withWindow.dependencies.windows.create();
    await withWindow.lifecycle.backgroundReasonsChanged();
    expect(withWindow.app.quit).not.toHaveBeenCalled();
    const mac = fixture((d) => {
      d.runtime = { ...d.runtime, platform: "darwin" };
      d.services.refreshTray = async () => false;
    });
    await mac.lifecycle.backgroundReasonsChanged();
    expect(mac.app.quit).not.toHaveBeenCalled();
  });

  it("quits after a failed tray refresh but leaves macOS window closure alone", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await boot(f);
    f.dependencies.services.refreshTray = async () => { throw new Error("settings"); };
    f.app.emit("window-all-closed");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.quit).toHaveBeenCalledOnce();
    const mac = fixture((d) => { d.runtime = { ...d.runtime, platform: "darwin" }; });
    await boot(mac);
    vi.mocked(mac.dependencies.services.refreshTray).mockClear();
    mac.app.emit("window-all-closed");
    expect(mac.dependencies.services.refreshTray).not.toHaveBeenCalled();
    expect(mac.app.quit).not.toHaveBeenCalled();
  });
});
