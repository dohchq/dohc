import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event, Request, Response } from "@dohc/workspace-engine-client";
import {
  createRustEngineDaemon,
  EngineClient,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
  type EngineDaemonLifecycleOptions,
  type EngineClientSpawnOptions,
} from "@dohc/workspace-engine-client/daemon";
import { createDesktopEngine } from "./desktopEngine";
import { EngineRelayClient } from "./engineRelayClient";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import type { RegistryEntry } from "./registryStore";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { PluginWorkspaceRuntimes, type PluginWorkspaceRuntimeParts } from "../plugins/pluginWorkspaceRuntimes";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "./testTemp";

const ownerHostMock = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn() }));
vi.mock("./desktopOwnerHost", () => ({ readDesktopOwnerHostConfig: ownerHostMock.read, startDesktopOwnerHost: ownerHostMock.start }));

type State = { pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace> };
type Dependencies = Parameters<typeof createDesktopEngine<State>>[0];

function workspaceIdOf(request: Request): unknown {
  return typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)
    ? request.params.workspaceId : undefined;
}

class Client implements EngineDaemonClient {
  readonly requests: Request[] = [];
  readonly handlers = new Set<(event: Event) => void>();
  readonly smokeClosed = deferred();
  readonly closed = deferred();
  exitWait: Promise<void> = Promise.resolve();
  respond?: (request: Request) => Promise<Response>;

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    if (this.respond) return this.respond(request);
    if (request.method === "workspace.close" && request.workspace === "smoke") this.smokeClosed.resolve();
    return { id: request.id, result: request.method === "workspace.open"
      ? { workspace: String(workspaceIdOf(request)).startsWith("desktop-startup-smoke-") ? "smoke" : "workspace-handle" }
      : request.method === "workspace.close" ? { closed: true }
      : request.method === "engine.ping" ? { ok: true } : null };
  }

  onEvent(handler: (event: Event) => void) {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(name: string, payload: Event["payload"]) {
    for (const handler of this.handlers) handler({ seq: 1, sessionGeneration: 1, name, payload });
  }
  close() { this.closed.resolve(); }
  waitForExit() { return this.exitWait; }
}

function parts(dispose: () => Promise<void> = async () => undefined) {
  return {
    pipeline: {
      start: vi.fn(async () => undefined), cancelStart: vi.fn(), dispose: vi.fn(dispose),
      handleWatcherEvents: vi.fn(async () => undefined), pluginRegistration: vi.fn(() => null),
      hasUnrecoverableFailedReplacement: vi.fn(() => false),
    },
    agentDrivers: { list: vi.fn(() => []) },
    workspaceEvents: { dispose: vi.fn(), handleWatcherEvents: vi.fn(), handleRecordEvent: vi.fn() },
    automations: { dispose: vi.fn(async () => undefined), stopForEngineRestart: vi.fn(), notifyClaimed: vi.fn() },
  };
}

function fixture() {
  const rows = new Map<string, RegistryEntry>();
  const states = new Map<string, State>();
  const created: Array<{ workspaceId: string; parts: ReturnType<typeof parts> }> = [];
  let makeParts = (_workspace: CreatedWorkspace) => parts();
  const cleanupErrors = vi.fn();
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => rows.get(id) ?? null,
    canonicalizeRoot: resolve,
    createState: (binding): State => {
      const state = { pluginRuntimes: new PluginWorkspaceRuntimes<CreatedWorkspace>({
        assertWritable: () => undefined,
        isOpen: (id) => rows.has(id),
        create: (workspace) => {
          const result = makeParts(workspace);
          created.push({ workspaceId: workspace.workspaceId, parts: result });
          return result as unknown as PluginWorkspaceRuntimeParts;
        },
        onPipelineStatus: () => undefined, onCleanupError: cleanupErrors,
      }) };
      states.set(binding.workspaceId, state);
      return state;
    },
  });
  const client = new Client();
  let launch: (options: EngineClientSpawnOptions) => Promise<EngineDaemonClient> = async () => client;
  let options!: EngineDaemonLifecycleOptions;
  let configureDaemon = (_daemon: ReturnType<typeof createRustEngineDaemon>) => {};
  const daemons: ReturnType<typeof createRustEngineDaemon>[] = [];
  const spawns: EngineClientSpawnOptions[] = [];
  let quitting = false;
  const dependencies: Dependencies = {
    app: { isPackaged: false, getAppPath: vi.fn(() => "app-root"), quit: vi.fn() },
    dialog: { showErrorBox: vi.fn() },
    process: { env: {}, resourcesPath: "resources" },
    createRustEngineDaemon: vi.fn((input) => {
      options = input;
      const daemon = createRustEngineDaemon({ ...input,
        fileExists: () => true, launch: (spawnOptions) => { spawns.push(spawnOptions); return launch(spawnOptions); },
        sleep: async () => undefined,
        pingIntervalMs: 60_000, healthyResetMs: 60_000,
      });
      daemons.push(daemon);
      configureDaemon(daemon);
      return daemon;
    }),
    defaultEngineBinaryPath: vi.fn(() => resolve("test-engine")),
    isQuitting: () => quitting,
    workspaceAuthorities: authorities,
    pluginWorkspaceRuntimes: {
      current: (id) => {
        if (!rows.has(id)) return undefined;
        const lease = authorities.acquire(id);
        try { return lease.state.pluginRuntimes.current(id); } finally { lease.release(); }
      },
    },
    notifyRenderer: vi.fn(), notifyAutomationFailuresChanged: vi.fn(),
    launchMarks: { daemonReady: vi.fn() }, desktopMarks: { markOnce: vi.fn() },
    logLaunchMarksOnce: vi.fn(),
  };
  const engine = createDesktopEngine(dependencies);
  return {
    engine, dependencies, client, rows, states, created, cleanupErrors, authorities, daemons, spawns,
    options: () => options,
    setQuitting: (value: boolean) => { quitting = value; },
    setLaunch: (value: typeof launch) => { launch = value; },
    setDaemon: (value: typeof configureDaemon) => { configureDaemon = value; },
    setParts: (value: typeof makeParts) => { makeParts = value; },
    async addWorkspace(workspaceId: string) {
      const workspace: RegistryEntry = { workspaceId, rootPath: resolve(workspaceId), kind: "personal", mode: "local-first" };
      rows.set(workspaceId, workspace);
      const lease = authorities.acquire(workspaceId);
      try { await lease.state.pluginRuntimes.ensure(workspace); } finally { lease.release(); }
      return workspace;
    },
    async close(expectedRuntimeError?: Error) {
      quitting = true;
      const stopped = await Promise.allSettled([...states].map(([id, state]) => state.pluginRuntimes.stop(id)));
      try { await engine.closeAllRelayTransportWorkspaces(); }
      finally {
        await Promise.all(daemons.map((daemon) => daemon.stop()));
        await authorities.close();
      }
      for (const result of stopped) {
        if (result.status === "rejected" && result.reason !== expectedRuntimeError) throw result.reason;
      }
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("desktop engine construction", () => {
  it.each(["initial", "credential", "cloud", "rejecting-close", "quitting"])("retires discovered owner bindings before the first relay request after %s rebind", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-relay-rebind-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => { throw new Error("No editor in this discovery test."); });
    ownerHostMock.read.mockReturnValue({ nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: { aggregateBytes: 1024, maxUploads: 1 } });
    const stops: ReturnType<typeof vi.fn>[] = [];
    ownerHostMock.start.mockImplementation(() => { const stop = vi.fn(); stops.push(stop); return { stop }; });
    let handles = 0, blockedHandle: string | undefined;
    let request: Promise<unknown> | undefined;
    const closing = deferred(), closeEntered = deferred();
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async input => {
      if (input.method === "workspace.open" && workspaceIdOf(input) === "owner") {
        f.client.requests.push(input);
        return { id: input.id, result: { workspace: `owner-${++handles}` } };
      }
      if (input.method === "workspace.close" && input.workspace === blockedHandle) {
        closeEntered.resolve(); await closing.promise;
        if (mode === "rejecting-close") throw new Error("injected binding close failure");
      }
      if (input.method === "sync.probe") { f.client.requests.push(input); return { id: input.id, result: { hasContent: true } }; }
      return originalSend(input);
    };
    try {
      expect(await f.engine.start()).toBe(true);
      const lease = f.authorities.acquire("owner");
      const workspace = { workspaceId: "owner", rootPath, attachmentId: lease.binding.attachmentId };
      lease.release();
      let relay = f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "first-token" } });
      const rotated = mode === "credential" || mode === "cloud";
      if (rotated) await relay.probe();
      if (mode === "cloud") await f.engine.closeAllRelayTransportWorkspaces();
      if (rotated) relay = f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "second-token" } });
      const discovered = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      blockedHandle = discovered.workspaces[0].workspaceHandle;
      const priorStop = stops.at(-1)!;
      request = relay.probe();
      await closeEntered.promise;
      expect(() => discovered.assertCurrent()).toThrow("Owner host daemon retired.");
      expect(priorStop).toHaveBeenCalledOnce();
      const startsBeforeClose = ownerHostMock.start.mock.calls.length;
      if (mode === "quitting") f.setQuitting(true);
      closing.resolve();
      await expect(request).resolves.toEqual({ hasContent: true });
      if (mode === "quitting") {
        expect(ownerHostMock.start).toHaveBeenCalledTimes(startsBeforeClose);
        return;
      }
      const current = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(() => current.assertCurrent()).not.toThrow();
      expect(current.client).toBe(discovered.client);
      expect(current.workspaces[0].workspaceHandle).not.toBe(blockedHandle);
      expect(f.client.requests.filter(row => row.method === "sync.probe").at(-1)?.workspace).toBe(current.workspaces[0].workspaceHandle);
      const opened = f.client.requests.filter(row => row.method === "workspace.open" && workspaceIdOf(row) === "owner").at(-1)!;
      expect(opened.params).toMatchObject({ relay: { bearerToken: rotated ? "second-token" : "first-token" } });
      const starts = ownerHostMock.start.mock.calls.length;
      await relay.probe();
      expect(ownerHostMock.start).toHaveBeenCalledTimes(starts);
    } finally {
      closing.resolve(); await request?.catch(() => undefined); await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset();
    }
  });

  it.each(["workspace", "cloud", "overlapping-cloud", "shutdown"])("retires owner discovery during %s close and resumes only while running", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-host-rotation-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => { throw new Error("No editor in this discovery test."); });
    const stopped: ReturnType<typeof vi.fn>[] = [];
    ownerHostMock.read.mockReturnValue({ nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: { aggregateBytes: 1024, maxUploads: 1 } });
    ownerHostMock.start.mockImplementation(() => { const stop = vi.fn(); stopped.push(stop); return { stop }; });
    let handles = 0;
    const closing = deferred(), closeEntered = deferred();
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async request => {
      if (request.method === "workspace.open" && workspaceIdOf(request) === "owner") return { id: request.id, result: { workspace: `owner-${++handles}` } };
      if (request.method === "workspace.close" && request.workspace === "owner-1") { closeEntered.resolve(); await closing.promise; }
      return originalSend(request);
    };
    try {
      expect(await f.engine.start()).toBe(true);
      const lease = f.authorities.acquire("owner");
      const workspace = { workspaceId: "owner", rootPath, attachmentId: lease.binding.attachmentId };
      lease.release();
      f.engine.relayClient!.bind({...workspace, relay: {baseUrl: "https://relay.test", token: "first-token"}});
      const first = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(first.workspaces).toEqual([{ workspaceId: "owner", workspaceHandle: "owner-1" }]);
      const close = mode === "cloud" ? f.engine.closeAllRelayTransportWorkspaces() : f.engine.closeRelayTransportWorkspace(workspace);
      await closeEntered.promise;
      expect(stopped[0]).toHaveBeenCalledOnce();
      expect(() => first.assertCurrent()).toThrow("Owner host daemon retired.");
      if (mode === "shutdown") f.setQuitting(true);
      const shutdownDone = mode === "shutdown" || mode === "overlapping-cloud" ? f.engine.closeAllRelayTransportWorkspaces() : Promise.resolve();
      f.options().onLaunch?.();
      expect(ownerHostMock.start).toHaveBeenCalledTimes(1);
      closing.resolve(); await close; await shutdownDone;
      expect(ownerHostMock.start).toHaveBeenCalledTimes(mode === "shutdown" ? 1 : 2);
      if (mode === "shutdown") {
        f.options().onLaunch?.();
        expect(ownerHostMock.start).toHaveBeenCalledTimes(1);
        return;
      }
      f.engine.relayClient!.bind({...workspace, relay: {baseUrl: "https://relay.test", token: "second-token"}});
      const next = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(next.workspaces).toEqual([{ workspaceId: "owner", workspaceHandle: "owner-2" }]);
      expect(() => next.assertCurrent()).not.toThrow();
      expect(next.client).toBe(first.client);
      await f.engine.closeAllRelayTransportWorkspaces();
      expect(() => next.assertCurrent()).toThrow("Owner host daemon retired.");
      const reopened = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(reopened.workspaces).toEqual([{ workspaceId: "owner", workspaceHandle: "owner-3" }]);
      expect(() => reopened.assertCurrent()).not.toThrow();
    } finally {
      closing.resolve(); await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset();
    }
  });

  it("creates no daemon until start and publishes sessions only after the held handshake", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred();
    f.setLaunch(async () => { entered.resolve(); await held.promise; return f.client; });
    expect(await f.engine.startup).toBe(false);
    expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();
    expect(f.engine.daemon).toBeNull();
    expect(() => f.engine.requireEngineSessions()).toThrow("sessions are unavailable");
    const started = f.engine.start();
    try {
      await entered.promise;
      expect(f.engine.startup).toBe(started);
      expect(f.engine.daemon).toBe(f.daemons[0]);
      expect(f.engine.sessions).toBeNull(); expect(f.engine.relayClient).toBeNull();
      expect(f.dependencies.launchMarks.daemonReady).not.toHaveBeenCalled();
      held.resolve();
      expect(await started).toBe(true);
      expect(f.engine.sessions).toBeInstanceOf(EngineWorkspaceSessions);
      expect(f.engine.requireEngineSessions()).toBe(f.engine.sessions);
      expect(f.engine.relayClient).toBeInstanceOf(EngineRelayClient);
      expect(f.dependencies.defaultEngineBinaryPath).toHaveBeenCalledWith({
        isPackaged: false, appPath: "app-root", resourcesPath: "resources",
      });
      expect(f.dependencies.launchMarks.daemonReady).toHaveBeenCalledOnce();
      expect(f.dependencies.desktopMarks.markOnce).toHaveBeenCalledWith("daemon-ready");
      expect(f.dependencies.logLaunchMarksOnce).toHaveBeenCalledOnce();
    } finally { held.resolve(); await started; await f.close(); }
  });

  it.each([
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "1234" }, false, 1234],
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "1234" }, true, undefined],
    [{ DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "1234" }, false, undefined],
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "0" }, false, undefined],
    [{ DOHC_DESKTOP_TEST: "1", DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: "Infinity" }, false, undefined],
  ] as const)("reads test restart overrides at start for %j, packaged %s", async (env, packaged, backoff) => {
    const f = fixture();
    Object.assign(f.dependencies.process.env, env); Object.assign(f.dependencies.app, { isPackaged: packaged });
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().initialBackoffMs).toBe(backoff);
      expect(f.options().maxBackoffMs).toBe(backoff);
    } finally { await f.close(); }
  });

  it("contains binary path failure, shows the startup dialog, and takes ordinary quit", async () => {
    const f = fixture(); const error = new Error("binary path failed");
    f.dependencies.defaultEngineBinaryPath = () => { throw error; };
    const engine = createDesktopEngine(f.dependencies);
    try {
      expect(await engine.start()).toBe(false);
      expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Rust engine failed to start",
        "binary path failed\n\nThe desktop cannot start without the Rust engine.");
      expect(f.dependencies.app.quit).toHaveBeenCalledOnce();
      expect(engine.daemon).toBeNull(); expect(engine.sessions).toBeNull(); expect(engine.relayClient).toBeNull();
    } finally { await f.close(); }
  });

  it("waits for failed-start stop before clearing constructed handles and quitting", async () => {
    const f = fixture(); const held = deferred();
    f.client.exitWait = held.promise;
    const error = new Error("marks failed");
    f.dependencies.launchMarks.daemonReady = () => { throw error; };
    const started = f.engine.start();
    try {
      await f.client.closed.promise;
      expect(f.engine.daemon).toBe(f.daemons[0]);
      expect(f.engine.sessions).toBeInstanceOf(EngineWorkspaceSessions);
      expect(f.engine.relayClient).toBeInstanceOf(EngineRelayClient);
      expect(f.dependencies.app.quit).not.toHaveBeenCalled();
      held.resolve();
      expect(await started).toBe(false);
      expect(f.engine.daemon).toBeNull(); expect(f.engine.sessions).toBeNull(); expect(f.engine.relayClient).toBeNull();
      expect(f.dependencies.app.quit).toHaveBeenCalledOnce();
    } finally { held.resolve(); await started; await f.close(); }
  });

  it("contains stop rejection on failed start and still quits", async () => {
    const f = fixture(); const stopError = new Error("stop failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.dependencies.launchMarks.daemonReady = () => { throw "non-error startup failure"; };
    const engine = f.engine;
    f.setDaemon((daemon) => { vi.spyOn(daemon, "stop").mockRejectedValueOnce(stopError); });
    try {
      expect(await engine.start()).toBe(false);
      expect(logged).toHaveBeenCalledWith("[desktop] Rust engine daemon stop after failed start:", stopError);
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Rust engine failed to start",
        "Unknown Rust engine startup error.\n\nThe desktop cannot start without the Rust engine.");
      expect(f.dependencies.app.quit).toHaveBeenCalledOnce();
      expect(engine.daemon).toBeNull();
    } finally {
      await f.close();
    }
  });
});

describe("desktop engine restart coordination", () => {
  it("retires real plugin runtimes before publication and recreates them after launch", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred();
    let first = true;
    f.setParts(() => {
      const initial = first; first = false;
      return parts(async () => { if (initial) { entered.resolve(); await held.promise; } });
    });
    const workspace = await f.addWorkspace("workspace");
    const original = f.created[0]!.parts;
    const started = f.engine.start();
    let waiting: Promise<unknown> | undefined;
    try {
      await entered.promise;
      expect(original.automations.stopForEngineRestart).toHaveBeenCalledOnce();
      expect(() => f.engine.daemon!.currentClient()).toThrow();
      expect(f.engine.sessions).toBeNull();
      expect(f.dependencies.notifyRenderer).not.toHaveBeenCalled();
      waiting = f.states.get("workspace")!.pluginRuntimes.ensure(workspace);
      expect(f.created).toHaveLength(1);
      held.resolve();
      expect(await started).toBe(true);
      await waiting;
      expect(f.created).toHaveLength(2);
      expect(f.engine.daemon!.currentClient()).toBe(f.client);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith();
      expect(f.cleanupErrors).not.toHaveBeenCalled();
    } finally { held.resolve(); await started; await waiting; await f.close(); }
  });

  it("keeps the composed session and relay owners through a real daemon restart", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred(); const relaunched = deferred();
    let generation = 0;
    f.setParts(() => {
      const current = generation++;
      return parts(async () => { if (current === 1) { entered.resolve(); await held.promise; } });
    });
    const workspace = await f.addWorkspace("workspace");
    let restarting: Promise<unknown> | undefined;
    try {
      await f.engine.start(); await f.client.smokeClosed.promise;
      const runtimes = f.states.get("workspace")!.pluginRuntimes;
      await runtimes.ensure(workspace);
      const sessions = f.engine.sessions; const relay = f.engine.relayClient; const daemon = f.engine.daemon;
      const replacement = new Client();
      f.setLaunch(async () => replacement);
      vi.mocked(f.dependencies.notifyRenderer).mockImplementation(() => { relaunched.resolve(); });
      f.spawns[0]!.onExit!(1, null);
      await entered.promise;
      expect(f.engine.daemon).toBe(daemon);
      expect(() => daemon!.currentClient()).toThrow();
      expect(f.engine.sessions).toBe(sessions); expect(f.engine.relayClient).toBe(relay);
      restarting = runtimes.ensure(workspace);
      held.resolve(); await relaunched.promise; await restarting;
      expect(daemon!.currentClient()).toBe(replacement);
      expect(f.created).toHaveLength(3);
      expect(f.dependencies.launchMarks.daemonReady).toHaveBeenCalledOnce();
      replacement.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(f.created[2]!.parts.automations.notifyClaimed).toHaveBeenCalledOnce();
    } finally { held.resolve(); await restarting; await f.close(); }
  });

  it("holds every physical workspace lease until its own restart preparation drains", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred();
    f.setParts((workspace) => parts(async () => {
      if (workspace.workspaceId === "first") { entered.resolve(); await held.promise; }
    }));
    await f.addWorkspace("first"); await f.addWorkspace("second");
    const first = f.states.get("first")!.pluginRuntimes;
    const second = f.states.get("second")!.pluginRuntimes;
    const secondPrepared = vi.spyOn(second, "prepareForEngineRestart");
    const firstResumed = vi.spyOn(first, "resumeAfterEngineRestart");
    const started = f.engine.start();
    let drained: Promise<void> | undefined; let disposed = false;
    try {
      await entered.promise;
      drained = f.authorities.invalidate("first").then(() => { disposed = true; });
      expect(secondPrepared).toHaveBeenCalledOnce();
      expect(disposed).toBe(false);
      held.resolve(); await started; await drained;
      expect(disposed).toBe(true);
      expect(firstResumed).toHaveBeenCalledOnce();
    } finally { held.resolve(); await started; await drained; await f.close(); }
  });

  it("propagates preparation failure to paused plugin callers and the startup failure path", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred(); const error = new Error("host teardown failed");
    f.setParts(() => parts(async () => { entered.resolve(); await held.promise; throw error; }));
    const workspace = await f.addWorkspace("workspace");
    const runtimes = f.states.get("workspace")!.pluginRuntimes;
    const failed = vi.spyOn(runtimes, "failEngineRestart");
    const started = f.engine.start();
    let waiting: Promise<unknown> | undefined;
    try {
      await entered.promise;
      waiting = runtimes.ensure(workspace).catch((failure: unknown) => failure);
      held.resolve();
      expect(await started).toBe(false);
      expect(await waiting).toBe(error);
      expect(failed).toHaveBeenCalledWith(error);
      expect(f.dependencies.app.quit).toHaveBeenCalledOnce();
      expect(f.engine.sessions).toBeNull();
    } finally { held.resolve(); await started; await waiting; await f.close(error); }
  });

  it("reads quitting state on terminal failure and fails only the prepared restart set", async () => {
    const f = fixture();
    const workspace = await f.addWorkspace("workspace");
    const error = new Error("terminal failure");
    let waiting: Promise<unknown> | undefined;
    try {
      await f.engine.start();
      const runtimes = f.states.get("workspace")!.pluginRuntimes;
      await runtimes.ensure(workspace);
      const failed = vi.spyOn(runtimes, "failEngineRestart");
      f.options().onFailure!(error, true);
      expect(failed).not.toHaveBeenCalled();
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("The workspace engine stopped",
        "dohc stopped restarting the workspace engine.\n\nRestart dohc. If this happens again, review the desktop logs. If it continues, reinstall dohc.");
      vi.mocked(f.dependencies.dialog.showErrorBox).mockClear();
      await f.options().beforePublish!();
      waiting = runtimes.ensure(workspace).catch((failure: unknown) => failure);
      f.options().onFailure!(error, false);
      expect(failed).not.toHaveBeenCalled();
      f.setQuitting(true);
      f.options().onFailure!(error, true);
      expect(await waiting).toBe(error);
      expect(failed).toHaveBeenCalledWith(error);
      expect(f.dependencies.dialog.showErrorBox).not.toHaveBeenCalled();
      expect(f.engine.sessions).not.toBeNull();
      expect(f.dependencies.app.quit).not.toHaveBeenCalled();
    } finally {
      f.states.get("workspace")!.pluginRuntimes.failEngineRestart(error);
      await waiting;
      await f.close();
    }
  });
});

describe("desktop engine composed sessions and events", () => {
  it("uses the 120 second workspace open deadline and the same relay route owner", async () => {
    const f = fixture();
    const workspace = { workspaceId: "workspace", rootPath: await createTestScratch("dohc-desktop-engine-") };
    try {
      await f.engine.start();
      f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "token" } });
      await f.engine.sessions!.run(workspace, async () => undefined);
      const request = f.client.requests.find((item) => item.method === "workspace.open" && workspaceIdOf(item) === "workspace");
      expect(request).toMatchObject({ deadlineMs: 120_000, params: {
        workspaceId: "workspace", relay: { baseUrl: "https://relay.test", bearerToken: "token" },
      } });
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).toThrow("different relay origin");
      await f.engine.closeRelayTransportWorkspace(workspace);
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).not.toThrow();
    } finally { await f.close(); }
  });

  it.each(["workspace", "all"])("releases %s routes after failed startup cleared the client", async (scope) => {
    const f = fixture();
    let retiredRelay!: EngineRelayClient;
    const workspace = { workspaceId: "workspace", rootPath: resolve("workspace") };
    f.dependencies.launchMarks.daemonReady = () => {
      retiredRelay = f.engine.relayClient!;
      retiredRelay.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "token" } });
      throw new Error("startup failed after relay construction");
    };
    try {
      expect(await f.engine.start()).toBe(false);
      expect(f.engine.relayClient).toBeNull();
      expect(() => retiredRelay.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).toThrow("different relay origin");
      if (scope === "workspace") await f.engine.closeRelayTransportWorkspace("workspace");
      else await f.engine.closeAllRelayTransportWorkspaces();
      expect(() => retiredRelay.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).not.toThrow();
    } finally { await f.close(); }
  });

  it("waits for actual session closure before releasing a relay origin", async () => {
    const f = fixture(); const held = deferred(); const entered = deferred();
    const workspace = { workspaceId: "workspace", rootPath: await createTestScratch("dohc-desktop-engine-") };
    let closing: Promise<void> | undefined;
    try {
      await f.engine.start(); await f.client.smokeClosed.promise;
      f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://relay.test", token: "token" } });
      await f.engine.sessions!.run(workspace, async () => undefined);
      f.client.respond = async (request) => {
        if (request.method === "workspace.close" && request.workspace === "workspace-handle") { entered.resolve(); await held.promise; }
        return { id: request.id, result: request.method === "workspace.close" ? { closed: true } : null };
      };
      closing = f.engine.closeRelayTransportWorkspace(workspace);
      await entered.promise;
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).toThrow("different relay origin");
      held.resolve(); await closing;
      expect(() => f.engine.relayClient!.bind({ ...workspace, relay: { baseUrl: "https://other.test", token: "token" } })).not.toThrow();
    } finally { held.resolve(); await closing; await f.close(); }
  });

  it("routes record and automation events to current runtimes and capture events to the renderer", async () => {
    const f = fixture(); const workspace = await f.addWorkspace("workspace");
    try {
      await f.engine.start(); await f.states.get("workspace")!.pluginRuntimes.ensure(workspace);
      const original = f.created[0]!.parts;
      const current = f.created.at(-1)!.parts;
      const payload = { workspaceId: "workspace", collectionPath: "tasks", recordId: "record", author: null,
        timestamp: 10, actorKind: "human", onBehalfOf: null, depth: 0, source: { originId: "origin", originSeq: 1 } };
      f.client.emit("record.updated", payload);
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "failed" });
      expect(original.workspaceEvents.handleRecordEvent).not.toHaveBeenCalled();
      expect(current.workspaceEvents.handleRecordEvent).toHaveBeenCalledWith({ name: "record.updated",
        data: { collectionPath: "tasks", recordId: "record", author: null, timestamp: 10, actorKind: "human",
          onBehalfOf: null, depth: 0, source: { originId: "origin", originSeq: 1 } } });
      expect(current.automations.notifyClaimed).toHaveBeenCalledOnce();
      expect(f.dependencies.notifyAutomationFailuresChanged).toHaveBeenCalledWith("workspace");
      f.rows.delete("workspace");
      f.client.emit("record.updated", payload);
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(current.workspaceEvents.handleRecordEvent).toHaveBeenCalledOnce();
      expect(current.automations.notifyClaimed).toHaveBeenCalledOnce();
      vi.useFakeTimers();
      f.client.emit("capture.momentRecorded", { workspaceId: "workspace", paths: ["notes.md"], appliedCount: 1, notOwnedCount: 0 });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace", paths: ["notes.md"] });
    } finally { vi.useRealTimers(); await f.close(); }
  });
});
