import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppLifecycle } from "./appLifecycle";
import { createQuitGuard } from "./quitGuard";
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
      reportTrayFailure: vi.fn(),
      warmCredentials: vi.fn(async () => { log.push("credentials"); }),
      reconcileCloud: vi.fn(() => { log.push("cloud"); }),
      startUpdates: vi.fn(() => { log.push("updates"); }),
      updateAfterStartupFailure: vi.fn(async () => { log.push("update-check"); return false; }),
      updateAfterWindowLoadFailure: vi.fn(async () => { log.push("window-update-check"); return false; }),
    },
    beforeQuit: vi.fn(),
    shutdown: {
      budgetMs: 3000,
      beginEngineShutdown: vi.fn(() => { log.push("begin-shutdown"); }),
      stopSearch: vi.fn(async () => { log.push("search-stop"); }),
      stopSitePreviews: vi.fn(async () => { log.push("site-previews-stop"); }),
      settleYDocs: vi.fn(async () => { log.push("ydoc-settle"); }),
      stopAgentIntegration: vi.fn(async () => { log.push("integration-stop"); }),
      closeWorkspaces: vi.fn(async () => { log.push("workspaces-close"); }),
      disposeDatabase: vi.fn(async () => { log.push("database-stop"); }),
      closeRelay: vi.fn(async () => { log.push("relay-close"); }),
      stopEngine: vi.fn(async () => { log.push("engine-stop"); }),
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
  it("registers IPC before the window, applies stored zoom, and overlaps the daemon handshake", async () => {
    const f = fixture();
    const ready = f.lifecycle.start();
    expect(f.log).toEqual([]);
    f.appReady.resolve();
    await f.settingsRequested.promise;
    expect(f.log).toEqual(["app-ready", "engine-start", "settings-read", "handlers"]);
    f.settings.resolve({ zoom: 1.75 });
    expect(await f.created.promise).toEqual({ id: 1, zoom: 1.75 });
    expect(f.log.slice(-4)).toEqual(["settings-apply", "window", "load-listener", "first-window"]);
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

  it("does not bootstrap or capture handoff intents in a losing process", async () => {
    const f = fixture((d) => { d.runtime.argv.push(handoffUrl); });
    f.app.lock = false;
    await f.lifecycle.start();
    expect(f.app.quit).toHaveBeenCalledOnce();
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
  it.each(["search", "sitePreviews", "dispatch", "ydoc", "integration", "cli"] as const)(
    "waits for %s before releasing workspace authority",
    async (heldProducer) => {
      vi.useFakeTimers();
      const gates = {
        search: deferred(), sitePreviews: deferred(), dispatch: deferred(),
        ydoc: deferred(), integration: deferred(), cli: deferred(),
      };
      const f = fixture((d) => {
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
      search: deferred(), sitePreviews: deferred(), dispatch: deferred(), ydoc: deferred(), integration: deferred(), cli: deferred(),
    };
    const integrationStarted = deferred();
    const cliStarted = deferred();
    const workspacesClosed = deferred();
    const exited = deferred();
    const f = fixture((d) => {
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
  });

  it("exits once at the shutdown budget without closing a store beneath a held producer", async () => {
    vi.useFakeTimers();
    const held = deferred();
    const f = fixture((d) => { d.shutdown.settleYDocs = () => held.promise; });
    f.app.emit("will-quit", event());
    const repeated = event();
    f.app.emit("will-quit", repeated);
    expect(repeated.preventDefault).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2999);
    expect(f.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.dependencies.shutdown.closeWorkspaces).not.toHaveBeenCalled();
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.dependencies.shutdown.closeWorkspaces).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledOnce();
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

  it.each([false, true])("keeps the process after the last window only when dispatch is enabled: %s", async (enabled) => {
    vi.useFakeTimers();
    const f = fixture((d) => { d.services.refreshTray = async () => enabled; });
    await boot(f);
    f.app.emit("window-all-closed");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.quit).toHaveBeenCalledTimes(enabled ? 0 : 1);
    expect(f.dependencies.services.releaseIdleWorkspaces, "staying closes the workspaces nothing uses").toHaveBeenCalledTimes(enabled ? 1 : 0);
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
