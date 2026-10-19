import {LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES} from "@dohc/live-session-contract/live-frame";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
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
import { deferred } from "../testing/deferred";
import { createTestScratch } from "./testTemp";

const ownerHostMock = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn() }));
vi.mock("./desktopOwnerHost", () => ({ readDesktopOwnerHostConfig: ownerHostMock.read, startDesktopOwnerHost: ownerHostMock.start }));

const ownerDeliveryMock = vi.hoisted(() => ({read: vi.fn(), start: vi.fn(), pass: vi.fn()}));
vi.mock("./desktopOwnerDelivery", () => ({readDesktopOwnerDeliveryConfig: ownerDeliveryMock.read, startDesktopOwnerDelivery: ownerDeliveryMock.start}));
vi.mock("./nativeOwnerDelivery", () => ({runNativeOwnerDeliveryPass: ownerDeliveryMock.pass}));

type State = {
  collectionAutomations: { notifyClaimed: Mock<() => void>; failuresChanged: Mock<() => void>; pauseForEngineRestart: Mock<() => void>; resumeAfterEngineRestart: Mock<() => void> };
};
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
      : request.method === "ydoc.ownerStop.list" ? { stops: [] }
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

function fixture() {
  const rows = new Map<string, RegistryEntry>();
  const states = new Map<string, State>();
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => rows.get(id) ?? null,
    canonicalizeRoot: resolve,
    createState: (binding): State => {
      const state = { collectionAutomations: { notifyClaimed: vi.fn(), failuresChanged: vi.fn(), pauseForEngineRestart: vi.fn(), resumeAfterEngineRestart: vi.fn() } };
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
    resourcesBasePath: () => "resources",
    findWorkspace: id => rows.get(id) ?? null,
    app: { isPackaged: false, getAppPath: vi.fn(() => "app-root") },
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
    recordEngineProblem: vi.fn(),
    workspaceAuthorities: authorities,
    collectionAutomations: { current: (id) => rows.has(id) ? states.get(id)?.collectionAutomations : undefined },
    notifyRenderer: vi.fn(), noteNoAtomicPlacement: vi.fn(),
    launchMarks: { daemonReady: vi.fn() }, desktopMarks: { markOnce: vi.fn() },
    logLaunchMarksOnce: vi.fn(),
  };
  const engine = createDesktopEngine(dependencies);
  return {
    engine, dependencies, client, rows, states, authorities, daemons, spawns,
    options: () => options,
    setQuitting: (value: boolean) => { quitting = value; },
    setLaunch: (value: typeof launch) => { launch = value; },
    setDaemon: (value: typeof configureDaemon) => { configureDaemon = value; },
    async addWorkspace(workspaceId: string) {
      const workspace: RegistryEntry = { workspaceId, rootPath: resolve(workspaceId), kind: "personal", mode: "local-first" };
      rows.set(workspaceId, workspace);
      authorities.acquire(workspaceId).release();
      return workspace;
    },
    async close() {
      quitting = true;
      try { await engine.closeAllRelayTransportWorkspaces(); }
      finally {
        await Promise.all(daemons.map((daemon) => daemon.stop()));
        await authorities.close();
      }
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("desktop engine construction", () => {
  it("derives reader paths from main's resources base when getAppPath points at dist/main", async () => {
    const f = fixture(), resources = await createTestScratch("reader-resources-");
    const generation = "a".repeat(64);
    mkdirSync(resolve(resources, "engine-reader"));
    writeFileSync(resolve(resources, "engine-reader/selection.json"), JSON.stringify({ generation }));
    f.dependencies.resourcesBasePath = () => resources;
    vi.mocked(f.dependencies.app.getAppPath).mockReturnValue(resolve("unrelated/dist/main"));
    try {
      await f.engine.start();
      const config = JSON.parse(f.options().readerConfig!);
      expect(config.bundle).toBe(resolve(resources, "engine-reader", generation, "reader.cjs"));
      expect(config.manifest).toBe(resolve(resources, "engine-reader", generation, "manifest.json"));
    } finally { await f.close(); }
  });
  it("notifies after a workspace binding opens, including reopening", async () => {
    const f = fixture();
    const opened = vi.fn();
    f.dependencies.onWorkspaceOpened = opened;
    const workspace = { workspaceId: "notice-test-workspace", rootPath: await createTestScratch("notice-open-") };
    try {
      await f.engine.start();
      expect(opened).not.toHaveBeenCalled();
      const sessions = f.engine.sessions!;
      await sessions.run(workspace, async () => undefined);
      expect(opened).toHaveBeenCalledExactlyOnceWith("notice-test-workspace");
      await sessions.run(workspace, async () => undefined);
      expect(opened).toHaveBeenCalledTimes(1);
      await sessions.closeWorkspace(workspace);
      await sessions.run(workspace, async () => undefined);
      expect(opened).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  const remote = { serverUrl: "https://server.test", ownerUserId: "owner" };
  it.each<[string, Partial<RegistryEntry>, boolean]>([
    ["a saved pause", { pausedRemote: remote }, true],
    ["a folder reopened as local work", {}, true],
    ["ordinary sync with no session", { remote }, false],
    ["a join still bootstrapping", { joinBootstrapPending: true }, false],
    ["a received share", { shareView: { shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" } } }, false],
  ])("owner opens with %s ask to abandon an unfinished pull: %s", async (_case, entry, abandons) => {
    const f = fixture();
    const workspace = { workspaceId: "local-only", rootPath: await createTestScratch("abandon-open-") };
    f.rows.set(workspace.workspaceId, { ...workspace, kind: "personal", mode: "local-first", ...entry });
    try {
      await f.engine.start();
      const sessions = f.engine.sessions!;
      await sessions.run(workspace, async () => undefined);
      await sessions.closeWorkspace(workspace);
      // A capture-free open is temporary and never asks.
      await sessions.run({ ...workspace, captureMode: "none" }, async () => undefined);
      const opens = f.client.requests
        .filter(request => request.method === "workspace.open" && workspaceIdOf(request) === "local-only")
        .map(request => request.params);
      expect(opens).toHaveLength(2);
      if (abandons) expect(opens[0]).toMatchObject({ abandonOrdinaryPull: true });
      else expect(opens[0]).not.toHaveProperty("abandonOrdinaryPull");
      expect(opens[1]).not.toHaveProperty("abandonOrdinaryPull");
    } finally { await f.close(); }
  });

  it.each(["opens a workspace", "settles idle"] as const)("runs the startup smoke only when the launch %s", async (launch) => {
    const f = fixture();
    const workspace = { workspaceId: "smoke-gate-workspace", rootPath: await createTestScratch("smoke-gate-") };
    try {
      await f.engine.start();
      if (launch === "opens a workspace") await f.engine.sessions!.run(workspace, async () => undefined);
      f.engine.launchSettled();
      await expect(f.options().startupSmoke).resolves.toBe(launch === "settles idle" ? "run" : "skip");
      if (launch === "settles idle") await f.client.smokeClosed.promise;
    } finally { await f.close(); }
  });

  it("passes account changes to relay-session cleanup", async () => {
    const f = fixture();
    try {
      expect(await f.engine.start()).toBe(true);
      const close = vi.spyOn(f.engine.relayClient!, "closeAll").mockResolvedValue(undefined);
      await f.engine.closeAllRelayTransportWorkspaces({ accountChanged: true });
      expect(close).toHaveBeenCalledWith({ accountChanged: true });
    } finally {
      await f.close();
    }
  });

  it.each(["forgotten", "paused"])("discovers remaining configured owners after another workspace is %s", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    for (const workspaceId of ["first","second"]) {
      const rootPath = await createTestScratch(`dohc-owner-workspace-close-${workspaceId}-`);
      f.rows.set(workspaceId,{workspaceId,rootPath,kind:"personal",mode:"local-first"});
    }
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => {throw new Error("No editor in this discovery test.");});
    ownerHostMock.read.mockReturnValue({nativeConfigPath:"native-config",workspaceIds:["first","second"],transport:{aggregateBytes:1024,maxUploads:1}});
    ownerHostMock.start.mockImplementation(() => ({stop:vi.fn()}));
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async request => request.method === "workspace.open" && ["first","second"].includes(String(workspaceIdOf(request)))
      ? {id:request.id,result:{workspace:`handle-${workspaceIdOf(request)}`}} : originalSend(request);
    try {
      expect(f.authorities.workspaceIds()).toEqual([]);
      expect(await f.engine.start()).toBe(true);
      const discover = ownerHostMock.start.mock.calls.at(-1)![0].bindings;
      expect((await discover()).workspaces).toHaveLength(2);
      if (mode === "forgotten") {
        await f.authorities.invalidate("first"); f.rows.delete("first");
      } else {
        await f.engine.withOwnerHostPaused(async () => {
          f.rows.set("first", { ...f.rows.get("first")!, pausedRemote: { serverUrl: "https://server.test", ownerUserId: "owner" } });
        });
      }
      const remaining = await ownerHostMock.start.mock.calls.at(-1)![0].bindings();
      expect(remaining.workspaces).toEqual([{workspaceId:"second",workspaceHandle:"handle-second"}]);
      expect(() => remaining.assertCurrent()).not.toThrow();
      if (mode === "paused") {
        await f.engine.withOwnerHostPaused(async () => {
          const resumed = { ...f.rows.get("first")! };
          delete resumed.pausedRemote;
          f.rows.set("first", resumed);
        });
        expect((await ownerHostMock.start.mock.calls.at(-1)![0].bindings()).workspaces).toHaveLength(2);
        await f.authorities.invalidate("first"); f.rows.delete("first");
      }
      await f.authorities.invalidate("second"); f.rows.delete("second");
      await expect(ownerHostMock.start.mock.calls.at(-1)![0].bindings()).rejects.toThrow("Owner host has no registered workspaces.");
    } finally {await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset();}
  });

  it.each(["closed", "reopened"])("rejects discovered owner handles after a capture directly closes its %s session", async mode => {
    const f = fixture();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-capture-close-");
    f.rows.set("owner", { workspaceId: "owner", rootPath, kind: "personal", mode: "local-first" });
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "test-config";
    f.dependencies.existingOwnerFor = vi.fn(() => { throw new Error("No editor in this discovery test."); });
    ownerHostMock.read.mockReturnValue({ nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: { aggregateBytes: 1024, maxUploads: 1 } });
    ownerHostMock.start.mockImplementation(() => ({ stop: vi.fn() }));
    let handles = 0;
    const originalSend = f.client.sendRequest.bind(f.client);
    f.client.sendRequest = async input => input.method === "workspace.open" && workspaceIdOf(input) === "owner"
      ? { id: input.id, result: { workspace: `owner-${++handles}` } } : originalSend(input);
    try {
      expect(await f.engine.start()).toBe(true);
      const lease = f.authorities.acquire("owner");
      const workspace = { workspaceId: "owner", rootPath, attachmentId: lease.binding.attachmentId };
      lease.release();
      const discover = ownerHostMock.start.mock.calls.at(-1)![0].bindings;
      const captured = await discover();
      expect(() => captured.assertCurrent()).not.toThrow();
      // Temporary dispatch capture closes its store after the paused relay close.
      await f.engine.sessions!.closeWorkspace(workspace);
      if (mode === "reopened") await f.engine.sessions!.run(workspace, async () => undefined);
      expect(() => captured.assertCurrent()).toThrow();
      const current = await discover();
      expect(current.client).toBe(captured.client);
      expect(current.workspaces[0].workspaceHandle).not.toBe(captured.workspaces[0].workspaceHandle);
      expect(() => current.assertCurrent()).not.toThrow();
      expect(() => captured.assertCurrent()).toThrow();
    } finally { await f.close(); ownerHostMock.read.mockReset(); ownerHostMock.start.mockReset(); }
  });

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
      expect(() => discovered.assertCurrent()).toThrow("This live editing session ended.");
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
      expect(() => first.assertCurrent()).toThrow("This live editing session ended.");
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
      expect(() => next.assertCurrent()).toThrow("This live editing session ended.");
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

  it("contains binary path failure, and shows the startup dialog", async () => {
    const f = fixture(); const error = new Error("binary path failed");
    f.dependencies.defaultEngineBinaryPath = () => { throw error; };
    const engine = createDesktopEngine(f.dependencies);
    try {
      expect(await engine.start()).toBe(false);
      expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Rust engine failed to start",
        "binary path failed\n\nThe desktop cannot start without the Rust engine.");
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledWith(error, "startup");
      expect(engine.daemon).toBeNull(); expect(engine.sessions).toBeNull(); expect(engine.relayClient).toBeNull();
    } finally { await f.close(); }
  });

  it("waits for failed-start stop before clearing constructed handles and reporting the failure", async () => {
    const f = fixture(); const held = deferred();
    f.client.exitWait = held.promise;
    const error = new Error("marks failed");
    f.dependencies.launchMarks.daemonReady = () => { throw error; };
    let settled = false;
    const started = f.engine.start();
    void started.then(() => { settled = true; });
    try {
      await f.client.closed.promise;
      expect(f.engine.daemon).toBe(f.daemons[0]);
      expect(f.engine.sessions).toBeInstanceOf(EngineWorkspaceSessions);
      expect(f.engine.relayClient).toBeInstanceOf(EngineRelayClient);
      expect(settled).toBe(false);
      held.resolve();
      expect(await started).toBe(false);
      expect(f.engine.daemon).toBeNull(); expect(f.engine.sessions).toBeNull(); expect(f.engine.relayClient).toBeNull();
    } finally { held.resolve(); await started; await f.close(); }
  });

  it("contains stop rejection on failed start and still reports the failure", async () => {
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
      expect(engine.daemon).toBeNull();
    } finally {
      await f.close();
    }
  });
});

describe("desktop engine restart coordination", () => {
  it("pauses Collection automations before publication and resumes them after launch", async () => {
    const f = fixture();
    await f.addWorkspace("workspace");
    const collection = f.states.get("workspace")!.collectionAutomations;
    collection.pauseForEngineRestart.mockImplementation(() => {
      expect(f.engine.sessions).toBeNull();
      expect(collection.resumeAfterEngineRestart).not.toHaveBeenCalled();
    });
    try {
      expect(await f.engine.start()).toBe(true);
      expect(collection.pauseForEngineRestart).toHaveBeenCalledOnce();
      expect(collection.resumeAfterEngineRestart).toHaveBeenCalledOnce();
      expect(f.engine.daemon!.currentClient()).toBe(f.client);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith();
    } finally { await f.close(); }
  });

  it("keeps the composed session and relay owners through a real daemon restart", async () => {
    const f = fixture(); const relaunched = deferred();
    await f.addWorkspace("workspace");
    try {
      await f.engine.start(); f.engine.launchSettled(); await f.client.smokeClosed.promise;
      const sessions = f.engine.sessions; const relay = f.engine.relayClient; const daemon = f.engine.daemon;
      const replacement = new Client();
      f.setLaunch(async () => replacement);
      vi.mocked(f.dependencies.notifyRenderer).mockImplementation(() => { relaunched.resolve(); });
      f.spawns[0]!.onExit!(1, null);
      await relaunched.promise;
      expect(f.engine.daemon).toBe(daemon);
      expect(daemon!.currentClient()).toBe(replacement);
      expect(f.engine.sessions).toBe(sessions); expect(f.engine.relayClient).toBe(relay);
      expect(f.dependencies.launchMarks.daemonReady).toHaveBeenCalledOnce();
      // The Collection executor paused before each daemon was published and
      // resumed once it answered: at the first start and at the restart.
      const collection = f.states.get("workspace")!.collectionAutomations;
      expect(collection.pauseForEngineRestart).toHaveBeenCalledTimes(2);
      expect(collection.resumeAfterEngineRestart).toHaveBeenCalledTimes(2);
      replacement.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("waits for the startup smoke cap after progress stalls before reporting an engine failure", async () => {
    const f = fixture();
    const opened = deferred();
    const cancel = vi.fn(async (_requestId: number) => {});
    let openId!: number;
    const client: EngineDaemonClient = {
      reportsProgress: () => true,
      async sendRequest(request, _signal, onProgress) {
        if (request.method === "workspace.open" && String(workspaceIdOf(request)).startsWith("desktop-startup-smoke-")) {
          openId = request.id;
          onProgress?.();
          opened.resolve();
          return await new Promise<Response>(() => {});
        }
        return await f.client.sendRequest(request);
      },
      cancelRequest: cancel,
      onEvent: handler => f.client.onEvent(handler),
      close: () => f.client.close(),
      waitForExit: () => f.client.waitForExit(),
    };
    const close = vi.spyOn(client, "close");
    f.setLaunch(async () => client);
    try {
      vi.useFakeTimers();
      await f.engine.start();
      f.engine.launchSettled();
      await opened.promise;
      await vi.advanceTimersByTimeAsync(11_000);
      expect(cancel).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(f.engine.daemon!.currentClient()).toBe(client);
      expect(f.dependencies.recordEngineProblem).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(109_010);
      await vi.waitFor(() => expect(f.dependencies.recordEngineProblem).toHaveBeenCalled(), { timeout: 15_000 });
      expect(cancel).toHaveBeenCalledWith(openId);
      expect(close).toHaveBeenCalledOnce();
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Rust engine workspace.open timed out after 120000ms." }), "restarting",
      );
      expect(f.dependencies.dialog.showErrorBox).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("records one crash problem per engine crash, then the final verdict", async () => {
    const f = fixture();
    const exit = new Error("exited"); const attempt = new Error("attempt failed"); const verdict = new Error("limit");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await f.engine.start();
      const record = vi.mocked(f.dependencies.recordEngineProblem);
      f.options().onFailure!(exit, false);
      f.options().onFailure!(attempt, false);
      f.options().onFailure!(attempt, false);
      f.options().onFailure!(verdict, true);
      expect(record.mock.calls).toEqual([[exit, "restarting"], [verdict, "stopped"]]);
      // A launch ends the crash, so the next failure is a new problem.
      f.options().onLaunch!();
      f.options().onFailure!(exit, false);
      expect(record).toHaveBeenCalledTimes(3);
      expect(record).toHaveBeenLastCalledWith(exit, "restarting");
    } finally { await f.close(); }
  });

  it("reads quitting state on terminal failure", async () => {
    const f = fixture();
    const error = new Error("terminal failure");
    try {
      await f.engine.start();
      f.options().onFailure!(error, true);
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledWith(error, "stopped");
      expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("The workspace engine stopped",
        "dohc stopped restarting the workspace engine.\n\nRestart dohc. If this happens again, review the desktop logs. If it continues, reinstall dohc.");
      vi.mocked(f.dependencies.dialog.showErrorBox).mockClear();
      f.options().onFailure!(error, false);
      expect(f.dependencies.recordEngineProblem).toHaveBeenLastCalledWith(error, "restarting");
      f.setQuitting(true);
      f.options().onFailure!(error, true);
      // A failure while dohc quits is the quit, not a crash.
      expect(f.dependencies.recordEngineProblem).toHaveBeenCalledTimes(2);
      expect(f.dependencies.dialog.showErrorBox).not.toHaveBeenCalled();
      expect(f.engine.sessions).not.toBeNull();
    } finally { await f.close(); }
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
      await f.engine.start(); f.engine.launchSettled(); await f.client.smokeClosed.promise;
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

  it("routes automation events to the current workspace, and Collection projections and a finished first read to the renderer", async () => {
    const f = fixture(); await f.addWorkspace("workspace");
    try {
      await f.engine.start();
      const collection = f.states.get("workspace")!.collectionAutomations;
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "failed" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
      f.client.emit("capture.noAtomicPlacement", { workspaceId: "workspace" });
      expect(f.dependencies.noteNoAtomicPlacement).toHaveBeenCalledWith("workspace");
      expect(collection.failuresChanged).toHaveBeenCalledOnce();
      f.client.emit("capture.noAtomicPlacement", { workspaceId: "workspace" });
      expect(f.dependencies.noteNoAtomicPlacement).toHaveBeenCalledWith("workspace");
      f.rows.delete("workspace");
      f.client.emit("automation.claimed", { workspaceId: "workspace", state: "pending" });
      expect(collection.notifyClaimed).toHaveBeenCalledOnce();
      vi.useFakeTimers();
      vi.mocked(f.dependencies.notifyRenderer).mockClear();
      f.client.emit("capture.momentRecorded", { workspaceId: "workspace", paths: ["notes.md"], appliedCount: 1, notOwnedCount: 0 });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).not.toHaveBeenCalled();
      f.client.emit("collections.projected", { workspaceId: "workspace", paths: ["Log/a.md"], projectedCount: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace", paths: ["Log/a.md"], pathSetChanged: false });
      // The engine answers what it refused while it read a new workspace's
      // files, so the whole workspace reads again.
      vi.mocked(f.dependencies.notifyRenderer).mockClear();
      f.client.emit("capture.initialSettled", { workspaceId: "workspace" });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace", pathSetChanged: false });
    } finally { vi.useRealTimers(); await f.close(); }
  });
});


describe("private owner peer lifecycle", () => {
  it.each(["credentials", "daemon", "workspace"])("holds the workspace session until %s cancellation settles", async mode => {
    const f = fixture(), credentials = new AbortController(), entered = deferred(), settled = deferred();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-owner-peer-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner"}, outboxId: "pending"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      relayUrl: "https://relay.example.test", documents: [document]};
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG = "peer-config";
    f.dependencies.ownerDeliveryCredentials = () => ({bearer: "actual-token", accountId: "owner-account", relayUrl: config.relayUrl, signal: credentials.signal});
    ownerDeliveryMock.read.mockReturnValue(config);
    let active: Promise<unknown> | undefined, lifetime!: AbortController;
    ownerDeliveryMock.start.mockImplementation(options => {
      lifetime = new AbortController();
      return {stop: async () => {lifetime.abort(); await active?.catch(() => undefined);}};
    });
    let passOptions!: Parameters<typeof import("./nativeOwnerDelivery")["runNativeOwnerDeliveryPass"]>[0];
    ownerDeliveryMock.pass.mockImplementation(async options => {passOptions = options; entered.resolve(); await settled.promise; options.assertCurrent(); return "retry";});
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toEqual({configPath: "native-config", client: config.nativeClient});
      const run = ownerDeliveryMock.start.mock.calls.at(-1)![0].runPass;
      active = run(document, lifetime.signal);
      await entered.promise;
      expect(passOptions.bearer).toBe("actual-token");
      expect(passOptions.accountId).toBe("owner-account");
      if (mode === "credentials") credentials.abort();
      let closed = false;
      const closing = Promise.resolve(mode === "daemon" ? f.options().beforePublish!(new AbortController().signal) : f.engine.closeRelayTransportWorkspace("owner")).then(() => {closed = true;});
      expect(passOptions.signal.aborted).toBe(true);
      expect(() => passOptions.assertCurrent()).toThrow();
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.client.requests.filter(request => request.method === "workspace.close" && request.workspace === "workspace-handle")).toHaveLength(0);
      settled.resolve(); await active?.catch(() => undefined); await closing;
      expect(closed).toBe(true);
    } finally {settled.resolve(); await f.close(); ownerDeliveryMock.read.mockReset(); ownerDeliveryMock.start.mockReset(); ownerDeliveryMock.pass.mockReset();}
  });

  it("rejects conflicting native ingress budgets before launching the daemon", async () => {
    const f = fixture();
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG = "host-config";
    f.dependencies.process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG = "peer-config";
    f.dependencies.existingOwnerFor = vi.fn();
    f.dependencies.ownerDeliveryCredentials = () => null;
    ownerHostMock.read.mockReturnValue({nativeConfigPath: "native-config", workspaceIds: ["owner"], transport: {aggregateBytes: 100_000_000, maxUploads: 2}});
    ownerDeliveryMock.read.mockReturnValue({nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 3}, documents: []});
    try {expect(await f.engine.start()).toBe(false); expect(f.dependencies.createRustEngineDaemon).not.toHaveBeenCalled();}
    finally {await f.close(); ownerHostMock.read.mockReset(); ownerDeliveryMock.read.mockReset();}
  });
});

describe("server owner peer lifecycle", () => {
  it("delivers another document when a requested Stop release is corrupt", async () => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-stop-isolation-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const binding = {workspaceId: "owner", mainVersionId: "main", objectId: "broken", lineageClaimId: "a".repeat(64),
      currentPath: "broken.md", selectorPaths: ["broken.md"], restoreFenceGeneration: 1};
    const row = {binding, document: {mainVersionId: "main", objectId: "broken", currentPath: "broken.md"},
      retirementOwed: true, relayDatabaseNamespace: "namespace", state: "requested" as const};
    const document = {binding: {...binding, objectId: "working", currentPath: "working.md", selectorPaths: ["working.md"]},
      relayDatabaseNamespace: "namespace", shareId: "share"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    const client = f.client as unknown as EngineClient;
    vi.spyOn(client, "ownerYDocStopList").mockResolvedValue([row]);
    vi.spyOn(client, "ownerYDocStopRequest").mockResolvedValue(row);
    vi.spyOn(client, "ownerYDocRelease").mockRejectedValue(new Error("owner-stop-corrupt"));
    const documents = vi.fn(async () => ({ok: true, documents: [{path: "working.md", status: "ready", document}]}));
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal,
        assertCurrent() {}, retire: async () => 0, refusals: async () => {}, documents})};
    ownerDeliveryMock.pass.mockResolvedValue("acknowledged");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledWith(expect.objectContaining({document})));
      expect(documents).toHaveBeenCalled();
      expect(f.engine.ownerLiveStopFailures("owner")).toEqual([{path: "broken.md", detail: "owner-stop-corrupt"}]);
      f.engine.clearOwnerLiveStopFailure("owner",{objectId:"broken"});
      expect(f.engine.ownerLiveStopFailures("owner")).toEqual([]);
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });
  it("keeps local work available when optional owner ingress preparation fails", async () => {
    const f = fixture();
    f.dependencies.serverOwnerDelivery = {prepare: async () => {throw new Error("readonly profile");}, workspaceIds: () => ["owner"], hasRefusals: () => undefined, connect: async () => null};
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toBeUndefined();
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("restart-required");
    } finally {await f.close();}
  });
  it.each(["retry", "frozen"])("reports preparing and %s once, and an explicit retry clears the failed document after recovery", async outcome => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-status-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}, relayDatabaseNamespace: "namespace", shareId: "share"};
    let status = "preparing";
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    const changed = vi.fn();
    f.dependencies.notifyOwnerDeliveryChanged = changed;
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => credentials.signal.aborted ? [] : ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal, assertCurrent() {},
        retire: async () => 0, refusals: async () => {},
        documents: async () => ({ok: true, documents: [{path: "a.md", status, document},
          ...(outcome === "frozen" ? [{path: "b.md", status, document: {...document, binding: {...document.binding, objectId: "other", currentPath: "b.md"}}}] : [])]})})};
    ownerDeliveryMock.pass.mockResolvedValue(outcome);
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("preparing"));
      status = "ready"; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying"));
      expect(f.engine.ownerLiveDeliveryReason("owner")).toBe(outcome === "frozen" ? "document-unavailable" : undefined);
      if (outcome === "frozen") {
        ownerDeliveryMock.pass.mockImplementation(async options => options.document.binding.currentPath === "a.md" ? "frozen" : "empty");
        f.engine.retryOwnerDelivery("owner");
        await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledWith(expect.objectContaining({document: expect.objectContaining({binding: expect.objectContaining({currentPath: "b.md"})})})));
        expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable");
      }
      f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(ownerDeliveryMock.pass).toHaveBeenCalledTimes(2));
      expect(changed).toHaveBeenCalledTimes(2);
      ownerDeliveryMock.pass.mockResolvedValueOnce("acknowledged").mockResolvedValue("empty"); f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("active"));
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({workspaceId: "owner"});
      expect(changed).toHaveBeenCalledTimes(3);
      credentials.abort(); expect(f.engine.ownerLiveDeliveryStatus("owner")).toBeUndefined();
    } finally {await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  // Proves: a document the server refused names the workspace's reason over
  // every other, including a frozen document that clears on its own, and
  // stops naming it once the server no longer reports it. Only a document the
  // server cannot start until its owner opens it outranks a refusal, and a
  // diverged server copy, which only the server's operator can continue, outranks both.
  it("reports a document the server refused ahead of every other reason but one it cannot start or whose server copy diverged", async () => {
    const f = fixture(), credentials = new AbortController();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-refused-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}, relayDatabaseNamespace: "namespace", shareId: "share"};
    const refused = {path: "refused.md", status: "unavailable", reason: "session-host-refused"};
    const unopened = {path: "unopened.md", status: "unavailable", reason: "live-document-without-lineage"};
    const divergedRow = {path: "diverged.md", status: "unavailable", reason: "session-host-diverged"};
    const edited = {path: "edited.md", status: "unavailable", reason: "live-edit-unadmitted"};
    const others = [{path: "changed.md", status: "unavailable", reason: "workspace-changed"}, {path: "moved.md", status: "unavailable", reason: "document-unavailable"}];
    const ready = {path: "a.md", status: "ready", document};
    // The server says the workspace diverged whenever any of its rows does, and after its owner stopped every one.
    let rows: unknown[] = others, diverged = false;
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    f.dependencies.serverOwnerDelivery = {prepare: async () => config, workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal, assertCurrent() {},
        retire: async () => 0, refusals: async () => {}, documents: async () => ({ok: true, diverged, documents: rows})})};
    ownerDeliveryMock.pass.mockResolvedValue("frozen");
    try {
      expect(await f.engine.start()).toBe(true);
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("workspace-changed"));
      // With no document to deliver.
      rows = [...others, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A frozen document outranks the server's other reasons, but not a refusal.
      rows = [ready, ...others]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"));
      rows = [ready, ...others, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A document the server cannot start until its owner opens it goes first, with or without a frozen one.
      rows = [...others, refused, unopened]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"));
      rows = [ready, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      rows = [ready, ...others, unopened, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // A diverged server copy outranks all of them, with or without a frozen document.
      // Each step changes the reason, so no step passes on the one before it.
      rows = [...others, refused, unopened, divergedRow]; diverged = true; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, unopened]; diverged = false; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-document-without-lineage"));
      rows = [ready, divergedRow, ...others, unopened, refused]; diverged = true; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [ready, ...others]; diverged = false; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("document-unavailable"));
      // A document edited while live editing was off outranks a frozen one and
      // the server's other reasons, but not a refusal a Resume can still help.
      rows = [ready, ...others, edited]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("live-edit-unadmitted"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      rows = [...others, edited, refused]; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-refused"));
      // The owner stopped every document, and the server still reports its diverged copy.
      rows = []; diverged = true; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryReason("owner")).toBe("session-host-diverged"));
      expect(f.engine.ownerLiveDeliveryStatus("owner")).toBe("retrying");
      // The server no longer reports it.
      diverged = false; f.engine.retryOwnerDelivery("owner");
      await vi.waitFor(() => expect(f.engine.ownerLiveDeliveryStatus("owner")).toBeUndefined());
    } finally {credentials.abort(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });

  it.each(["credentials", "daemon", "workspace"])("discovers ready documents and holds the session until %s cancellation settles", async mode => {
    const f = fixture(), credentials = new AbortController(), entered = deferred(), settled = deferred();
    Object.setPrototypeOf(f.client, Object.defineProperties(Object.create(EngineClient.prototype), Object.getOwnPropertyDescriptors(Client.prototype)));
    const rootPath = await createTestScratch("dohc-server-owner-peer-");
    f.rows.set("owner", {workspaceId: "owner", rootPath, kind: "personal", mode: "local-first"});
    const document = {binding: {workspaceId: "owner", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1}, relayDatabaseNamespace: "namespace", shareId: "share"};
    const config = {nativeConfigPath: "native-config", nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
      frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
        maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      attemptTimeoutMs: 30_000, retryDelayMs: 10_000};
    const documents = vi.fn(async () => ({ok: true, documents: [{path: "a.md", status: "ready", document}]}));
    f.dependencies.serverOwnerDelivery = {prepare: vi.fn(async () => config), workspaceIds: () => ["owner"], hasRefusals: () => undefined,
      connect: async () => ({bearer: "actual-token", accountId: "owner-account", relayUrl: "https://relay.test", signal: credentials.signal,
        assertCurrent: () => credentials.signal.throwIfAborted(), documents, retire: async () => 0, refusals: async () => {}})};
    let passOptions!: Parameters<typeof import("./nativeOwnerDelivery")["runNativeOwnerDeliveryPass"]>[0];
    ownerDeliveryMock.pass.mockImplementation(async options => {passOptions = options; entered.resolve(); await settled.promise; options.assertCurrent(); return "empty";});
    try {
      expect(await f.engine.start()).toBe(true);
      expect(f.options().privateOwnerHost).toEqual({configPath: "native-config", client: config.nativeClient});
      await entered.promise;
      expect(passOptions.document).toEqual(document);
      expect(passOptions.bearer).toBe("actual-token");
      expect(passOptions.accountId).toBe("owner-account");
      if (mode === "credentials") credentials.abort();
      let closed = false;
      const closing = Promise.resolve(mode === "daemon" ? f.options().beforePublish!(new AbortController().signal) : f.engine.closeRelayTransportWorkspace("owner")).then(() => {closed = true;});
      expect(passOptions.signal.aborted).toBe(true);
      expect(() => passOptions.assertCurrent()).toThrow();
      await Promise.resolve(); expect(closed).toBe(false);
      settled.resolve(); await closing;
      expect(closed).toBe(true);
      if (mode === "daemon") {
        ownerDeliveryMock.pass.mockResolvedValue("empty");
        f.options().onLaunch!();
        await vi.waitFor(() => expect(documents).toHaveBeenCalledTimes(2));
      }
    } finally {settled.resolve(); await f.close(); ownerDeliveryMock.pass.mockReset();}
  });
});
