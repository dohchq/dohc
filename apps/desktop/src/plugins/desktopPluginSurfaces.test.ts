import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../ipc/channels";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createGuestZoomApplier } from "../window/windowZoom";
import { createTestScratch } from "../workspaces/testTemp";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { createDesktopPluginSurfaces } from "./desktopPluginSurfaces";
import { PluginHost } from "./PluginHost";
import { PluginPipeline } from "./PluginPipeline";
import { createPluginAgentDrivers } from "./pluginAgentDrivers";
import { PluginAutomations } from "./pluginAutomations";
import { PluginHostOwnership } from "./pluginHostOwnership";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";
import { acquirePluginSurfaceLease, ensurePluginStarted } from "./pluginHostStart";
import {
  PluginSurfaces,
  type PluginPanelHostLease,
  type PluginSurfaceHostLease,
  type PluginWebAppViewLike,
} from "./pluginSurfaces";
import {
  guestWebPreferences,
  pluginWebAppPartition,
  type GuestNavigationEvent,
  type GuestWebPreferences,
} from "./pluginWebAppGuest";
import { assertInstanceBudget } from "./pluginWebAppInstances";
import { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";
import { PluginWorkspaceRuntimes } from "./pluginWorkspaceRuntimes";

class NativeSender extends EventEmitter {
  destroyed = false;
  readonly sent: Array<{ channel: string; value: unknown }> = [];
  constructor(readonly id: number) { super(); }
  isDestroyed(): boolean { return this.destroyed; }
  send(channel: string, value: unknown): void { this.sent.push({ channel, value }); }
  destroy(): void { this.destroyed = true; this.emit("destroyed"); }
}

class NativeGuestSession extends EventEmitter {
  permission: ((sender: unknown, permission: string, answer: (granted: boolean) => void) => void) | undefined;
  setPermissionRequestHandler(handler: NonNullable<NativeGuestSession["permission"]>): void {
    this.permission = handler;
  }
}

class NativeGuestContents extends EventEmitter {
  readonly session = new NativeGuestSession();
  readonly zoom: number[] = [];
  readonly urls: string[] = [];
  destroyed = false;
  openWindow: (() => { action: "deny" }) | undefined;
  setWindowOpenHandler(handler: () => { action: "deny" }): void { this.openWindow = handler; }
  async loadURL(url: string): Promise<void> { this.urls.push(url); }
  isDestroyed(): boolean { return this.destroyed; }
  close(): void { this.destroyed = true; }
  setZoomLevel(level: number): void { this.zoom.push(level); }
}

class NativeView implements PluginWebAppViewLike {
  readonly webContents = new NativeGuestContents();
  readonly visibility: boolean[] = [];
  readonly bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
  constructor(readonly options: { webPreferences: GuestWebPreferences }) {}
  setVisible(visible: boolean): void { this.visibility.push(visible); }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds.push(bounds);
  }
}

class NativeWindow {
  destroyed = false;
  readonly views: NativeView[] = [];
  readonly removed: NativeView[] = [];
  readonly contentView = {
    addChildView: (view: NativeView) => { this.views.push(view); },
    removeChildView: (view: NativeView) => {
      this.removed.push(view);
      const index = this.views.indexOf(view);
      if (index !== -1) this.views.splice(index, 1);
    },
  };
  isDestroyed(): boolean { return this.destroyed; }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, "Surface fixture cleanup failed");
});

type Workspace = { workspaceId: string; rootPath: string };
const panel = { id: "panel", title: "Panel", entry: "panel.html", placement: "editor" as const };
const previewUrl = "http://127.0.0.1:4100/panel.html";
const webAppUrl = "http://127.0.0.1:4200/pair#private-credential";

async function fixture() {
  const scratch = await createTestScratch("desktop-plugin-surfaces-");
  const workspace = { workspaceId: "workspace", rootPath: join(scratch, "workspace") };
  const stateDir = join(scratch, "state");
  await Promise.all([mkdir(workspace.rootPath), mkdir(stateDir)]);
  const authorities = createWorkspaceAuthorityOwner<Workspace, object>({
    findWorkspace: (id) => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: (root) => root,
    createState: () => ({}),
  });
  cleanups.push(() => authorities.close());
  const lease = authorities.acquire(workspace.workspaceId);
  const binding = lease.binding;
  lease.release();
  function sessionsOwner() {
    return new RendererWorkspaceSessionOwner<NativeSender>({
      retirement: {
        retireSender: () => ({
          requiredForAdmission: Promise.resolve(),
          detachedFromAdmission: Promise.resolve(),
        }),
        retireWorkspace: async () => undefined,
      },
    });
  }
  let sessions = sessionsOwner();
  const sender = new NativeSender(7);
  const senders = new Map([[sender.id, sender]]);
  cleanups.push(async () => {
    for (const current of new Set([sender, ...senders.values()])) current.destroy();
  });
  const renderer = await sessions.open(sender, binding, "document-1");
  let nativeWindow: NativeWindow | null = new NativeWindow();
  let zoomLevel = 2;
  const storage: Array<{ origin: string }> = [];
  const partitions: string[] = [];
  const allowedOrigins: string[] = [];
  const releasedOrigins: string[] = [];
  const previewStops: string[] = [];
  let sessionReads = 0;
  const desktop = createDesktopPluginSurfaces<NativeSender, NativeView>({
    BrowserWindow: { fromWebContents: () => nativeWindow },
    WebContentsView: NativeView,
    webContents: { fromId: (id) => senders.get(id) },
    session: {
      defaultSession: { clearStorageData: async (options) => { storage.push(options); } },
      fromPartition: (partition) => ({ clearStorageData: async () => { partitions.push(partition); } }),
    },
    bindGuestZoom: createGuestZoomApplier(() => zoomLevel),
    allowLoopbackFrameOrigin: (url) => {
      allowedOrigins.push(url);
      return () => { releasedOrigins.push(url); };
    },
    withWorkspaceAttachment: (target, work) => {
      const current = authorities.acquire(target.workspaceId);
      try {
        if (target.attachmentId !== undefined && current.binding.attachmentId !== target.attachmentId) return;
        work();
      } finally { current.release(); }
    },
    get rendererWorkspaceSessions() { sessionReads += 1; return sessions; },
  });

  async function createRuntime() {
    const events = new PluginWorkspaceEvents();
    const transportRequests: string[] = [];
    const host = new PluginHost({
      workspaceRoot: workspace.rootPath, stateDir,
      spawnTransport: () => ({
        request: async <T,>(method: string): Promise<T> => {
          transportRequests.push(method);
          return (method === PLUGIN_HOST_METHODS.activate
            ? { commands: [], drivers: [] }
            : method === PLUGIN_HOST_METHODS.startWebApp
              ? { url: webAppUrl }
              : {}) as T;
        },
        notify: () => undefined,
        dispose: async () => undefined,
      }),
      routeSdkRequest: async () => { throw new Error("No process SDK request was admitted"); },
    });
    const ownership = new PluginHostOwnership(host);
    const runtime = new PluginWorkspaceRuntimes<Workspace>({
      assertWritable: () => undefined,
      isOpen: () => true,
      create: () => ({
        pipeline: new PluginPipeline({
          workspaceRoot: workspace.rootPath, stateDir, hostOwnership: ownership,
          pnpmRunnerEntry: join(scratch, "unused-pnpm-runner.js"),
          isEngineCaptureAvailable: () => true,
        }),
        agentDrivers: createPluginAgentDrivers({ host }),
        workspaceEvents: events,
        automations: new PluginAutomations({
          withAdapter: async () => null,
          declaredAutomations: () => [],
          proveReadable: async () => { throw new Error("No automation read was admitted"); },
          runOnPlugin: async () => { throw new Error("No automation run was admitted"); },
          onError: () => undefined,
        }),
      }),
      onPipelineStatus: () => undefined,
    });
    cleanups.push(() => runtime.close());
    await runtime.ensure(workspace);
    await host.start(join(scratch, "native-plugin"), "plugin", {
      version: 1, name: "plugin", entry: "index.js", panels: [panel],
      webApps: [{ id: "app", title: "App", instanced: false }],
    });
    await host.activationOf("plugin");
    return { runtime, events, host, ownership, transportRequests };
  }
  const runtime = await createRuntime();
  function createSurfaces(target = binding, owner = runtime.runtime) {
    const surfaces = desktop.createPluginSurfaces(target, owner);
    cleanups.push(() => surfaces.close());
    return surfaces;
  }
  const surfaces = createSurfaces();

  function surfaceLease(): PluginSurfaceHostLease {
    const held = acquirePluginSurfaceLease(runtime.ownership, "plugin");
    return {
      start: async () => {
        await ensurePluginStarted(runtime.host, "plugin", () => held.start(async () => ({
          kind: "existing", value: { ok: true as const },
        })));
        const spawnId = runtime.host.getSpawnId("plugin");
        if (!spawnId) throw new Error("The native plugin has no live spawn");
        return spawnId;
      },
      currentSpawnId: () => runtime.host.getSpawnId("plugin"),
      release: () => held.release(),
    };
  }
  const request = {
    workspaceId: workspace.workspaceId, pluginId: "plugin",
    senderId: sender.id, generation: renderer.generation,
  };
  async function startPanel(target = surfaces, generation = renderer.generation) {
    return target.startPanel({ ...request, generation, panelId: panel.id, placement: panel.placement }, {
      assertAllowed: () => undefined,
      acquireHostLease: async (): Promise<PluginPanelHostLease> => {
        const held = surfaceLease();
        return {
          ...held,
          currentRecord: () => runtime.host.currentRecord("plugin"),
          startPanel: async (panelId) => {
            const spawnId = await held.start();
            const ready = runtime.host.readyPanelsForSpawn("plugin", spawnId);
            const declaration = ready?.panels.find((candidate) => candidate.id === panelId);
            if (!ready || !declaration) throw new Error("The native plugin has no admitted panel");
            return { spawnId, hostRecord: ready.record, panel: declaration };
          },
        };
      },
      startPreview: async () => ({ url: previewUrl, stop: async () => { previewStops.push(previewUrl); } }),
    });
  }
  async function startWebApp(target = surfaces, generation = renderer.generation) {
    return target.startWebApp({
      ...request, generation, webAppId: "app", instanceKey: null,
      workspaceRoot: workspace.rootPath,
      container: desktop.createPluginWebAppContainer(sender),
    }, {
      assertAllowed: () => undefined,
      assertInstanceBudget: (count) => assertInstanceBudget("plugin", "app", count),
      acquireHostLease: async () => ({
        ...surfaceLease(),
        startWebApp: () => runtime.host.startWebApp("plugin", "app", null),
        unpair: (expectedSpawnId) => runtime.host.getSpawnId("plugin") === expectedSpawnId
          ? runtime.host.stopWebApp("plugin", "app", null) : Promise.resolve(),
      }),
    });
  }
  async function invalidate(target = surfaces) {
    target.hostChanged({ kind: "terminal", workspaceId: workspace.workspaceId, pluginId: "plugin" });
    const hostRecord = runtime.host.currentRecord("plugin");
    const spawnId = runtime.host.getSpawnId("plugin");
    if (!hostRecord || !spawnId) throw new Error("The native plugin has no current record");
    await target.hostReady({ workspaceId: workspace.workspaceId, pluginId: "plugin", hostRecord, spawnId, declaredPanels: [] });
  }
  function authorize(overrides: Partial<Parameters<PluginSurfaces<NativeView>["authorizePanelSdk"]>[0]> = {}) {
    return surfaces.authorizePanelSdk({
      ...request, panelId: panel.id,
      currentGeneration: () => sessions.current(sender)?.generation ?? -1,
      activeWorkspaceId: () => sessions.current(sender)?.workspaceId,
      liveSpawnId: () => runtime.host.getSpawnId("plugin"),
      ...overrides,
    });
  }
  return {
    ...runtime, authorities, binding, workspace, sender, senders, renderer, desktop,
    surfaces, storage, partitions, allowedOrigins, releasedOrigins, previewStops,
    createSurfaces, createRuntime, startPanel, startWebApp, invalidate, authorize,
    sessionReads: () => sessionReads,
    window: () => nativeWindow,
    setWindow: (value: NativeWindow | null) => { nativeWindow = value; },
    setZoom: (value: number) => { zoomLevel = value; },
    sessions: () => sessions,
    replaceSessions: () => { sessions = sessionsOwner(); return sessions; },
  };
}

describe("desktop plugin surface composition", () => {
  it("detaches from the window that attached the view after sender resolution changes", async () => {
    const f = await fixture();
    const original = f.window()!;
    const container = f.desktop.createPluginWebAppContainer(f.sender);
    const view = new NativeView({ webPreferences: guestWebPreferences("partition") });
    container.attach(view);
    const successor = new NativeWindow();
    f.setWindow(successor);
    container.detach(view);
    container.detach(view);
    expect(original.removed).toEqual([view]);
    expect(successor.removed).toEqual([]);
    expect(container.isDestroyed()).toBe(false);
  });

  it.each(["missing", "destroyed"] as const)("refuses attach to a %s window and tolerates detach", async (state) => {
    const f = await fixture();
    const container = f.desktop.createPluginWebAppContainer(f.sender);
    if (state === "missing") f.setWindow(null);
    else f.window()!.destroyed = true;
    const view = new NativeView({ webPreferences: guestWebPreferences("partition") });
    expect(container.isDestroyed()).toBe(true);
    expect(() => container.attach(view)).toThrow("The plugin web app request has no open window.");
    expect(() => container.detach(view)).not.toThrow();
  });

  it("does not touch a destroyed attached window or substitute its live successor", async () => {
    const f = await fixture();
    const original = f.window()!;
    const container = f.desktop.createPluginWebAppContainer(f.sender);
    const view = new NativeView({ webPreferences: guestWebPreferences("partition") });
    container.attach(view);
    original.destroyed = true;
    const successor = new NativeWindow();
    f.setWindow(successor);
    expect(container.isDestroyed()).toBe(true);
    container.detach(view);
    expect(original.removed).toEqual([]);
    expect(successor.removed).toEqual([]);
    expect(container.isDestroyed()).toBe(false);
  });

  it("delivers parsed current surface events without the web-app credential", async () => {
    const f = await fixture();
    expect(f.sessionReads()).toBe(0);
    const opened = await f.startPanel();
    await f.startWebApp();
    await f.invalidate();
    expect(f.sender.sent).toEqual([
      { channel: CHANNELS.pluginWebAppFailed, value: { workspaceId: "workspace", pluginId: "plugin", webAppId: "app", instanceKey: null } },
      { channel: CHANNELS.pluginPanelInvalidated, value: { workspaceId: "workspace", pluginId: "plugin", panelId: "panel", surfaceId: opened.surfaceId } },
    ]);
    expect(JSON.stringify(f.sender.sent)).not.toContain("private-credential");
    expect(f.sessionReads()).toBe(2);
  });

  it.each(["missing sender", "destroyed sender", "reload", "recycled id", "retired attachment", "forged attachment", "forged generation"] as const)(
    "suppresses both notification paths for a %s", async (state) => {
      const f = await fixture();
      const target = state === "forged attachment"
        ? f.createSurfaces({ ...f.binding, attachmentId: Symbol("forged") }) : f.surfaces;
      const generation = state === "forged generation" ? f.renderer.generation + 1 : f.renderer.generation;
      await f.startPanel(target, generation);
      await f.startWebApp(target, generation);
      if (state === "missing sender") f.senders.delete(f.sender.id);
      if (state === "destroyed sender") f.sender.destroy();
      if (state === "reload") {
        await f.sessions().retireForReload(f.sender, "document-1");
        await f.sessions().open(f.sender, f.binding, "document-2");
      }
      if (state === "recycled id") {
        const successor = new NativeSender(f.sender.id);
        f.senders.set(successor.id, successor);
        await f.sessions().open(successor, f.binding, "successor-document");
      }
      if (state === "retired attachment") {
        await f.authorities.invalidate(f.workspace.workspaceId);
        const replacement = f.authorities.acquire(f.workspace.workspaceId);
        expect(replacement.binding.attachmentId).not.toBe(f.binding.attachmentId);
        replacement.release();
        expect(f.sessions().current(f.sender)?.generation).toBe(f.renderer.generation);
      }
      await f.invalidate(target);
      expect(f.sender.sent).toEqual([]);
      expect(f.senders.get(f.sender.id)?.sent ?? []).toEqual([]);
    },
  );

  it("reads a replaced renderer-session owner at callback time", async () => {
    const f = await fixture();
    await f.startPanel();
    await f.startWebApp();
    f.replaceSessions();
    await f.invalidate();
    expect(f.sender.sent).toEqual([]);
    expect(f.sessionReads()).toBe(2);
  });

  it("keeps guest isolation, partition cleanup, and live zoom in their existing owners", async () => {
    const f = await fixture();
    await f.startWebApp();
    const view = f.window()!.views[0]!;
    const partition = pluginWebAppPartition(f.workspace.rootPath, "plugin");
    expect(view.options.webPreferences).toEqual(guestWebPreferences(partition));
    expect(view.options.webPreferences).not.toHaveProperty("preload");
    expect(view.webContents.urls).toEqual([webAppUrl]);
    expect(view.webContents.zoom).toEqual([2]);
    f.setZoom(4);
    view.webContents.emit("did-finish-load");
    expect(view.webContents.zoom).toEqual([2, 4]);
    const blocked = vi.fn();
    const event: GuestNavigationEvent = { preventDefault: blocked };
    view.webContents.emit("will-navigate", event, "https://outside.example/");
    view.webContents.emit("will-redirect", event, "http://127.0.0.1:4300/");
    expect(blocked).toHaveBeenCalledTimes(2);
    expect(view.webContents.openWindow?.()).toEqual({ action: "deny" });
    const permission = vi.fn();
    view.webContents.session.permission?.(view.webContents, "media", permission);
    expect(permission).toHaveBeenCalledWith(false);
    await f.surfaces.stop({ kind: "plugin", workspaceId: "workspace", pluginId: "plugin", clearPartition: { workspaceRoot: f.workspace.rootPath } });
    expect(f.partitions).toEqual([partition]);
    expect(f.storage).toEqual([]);
    expect(f.window()!.views).toEqual([]);
  });

  it("clears panel default-session storage and releases the admitted origin", async () => {
    const f = await fixture();
    await f.startPanel();
    expect(f.allowedOrigins).toEqual([previewUrl]);
    await f.surfaces.stop({ kind: "panel", workspaceId: "workspace", pluginId: "plugin", panelId: "panel" });
    expect(f.storage).toEqual([{ origin: "http://127.0.0.1:4100" }]);
    expect(f.previewStops).toEqual([previewUrl]);
    expect(f.releasedOrigins).toEqual([previewUrl]);
    expect(f.partitions).toEqual([]);
  });

  it("disposes only the exact panel event owner in the captured runtime", async () => {
    const f = await fixture();
    const opened = await f.startPanel();
    const owner = { kind: "panel" as const, workspaceId: "workspace", pluginId: "plugin", panelId: "panel", surfaceId: opened.surfaceId };
    const received: string[] = [];
    const watch = (events: PluginWorkspaceEvents, identity: typeof owner, label: string) => events.subscribe({
      owner: identity, emitEvent: () => { received.push(label); },
    }, { path: "." });
    watch(f.events, owner, "disposed");
    watch(f.events, { ...owner, surfaceId: opened.surfaceId + 1 }, "other-surface");
    await f.authorities.invalidate(f.workspace.workspaceId);
    const replacementLease = f.authorities.acquire(f.workspace.workspaceId);
    const replacementBinding = replacementLease.binding;
    replacementLease.release();
    const replacement = await f.createRuntime();
    f.createSurfaces(replacementBinding, replacement.runtime);
    watch(replacement.events, owner, "replacement-attachment");
    await f.surfaces.stop({ kind: "panel", workspaceId: "workspace", pluginId: "plugin", panelId: "panel" });
    const batch = [{ path: "notes.md", operation: "update" as const }];
    f.events.handleWatcherEvents(batch);
    replacement.events.handleWatcherEvents(batch);
    expect(received).toEqual(["other-surface", "replacement-attachment"]);
  });

  it("retains real panel SDK authorization and revokes the exact grant on disposal", async () => {
    const f = await fixture();
    const opened = await f.startPanel();
    const grant = f.authorize();
    expect(grant.surfaceId).toBe(opened.surfaceId);
    expect(grant.isPushLive()).toBe(true);
    expect(() => f.authorize({ senderId: 8 })).toThrow();
    expect(() => f.authorize({ currentGeneration: () => f.renderer.generation + 1 })).toThrow();
    expect(() => f.authorize({ activeWorkspaceId: () => "other-workspace" })).toThrow();
    expect(() => f.authorize({ liveSpawnId: () => "forged-spawn" })).toThrow();
    await f.surfaces.stop({ kind: "panel", workspaceId: "workspace", pluginId: "plugin", panelId: "panel" });
    expect(grant.authority.signal.aborted).toBe(true);
    expect(grant.isPushLive()).toBe(false);
    expect(() => f.authorize()).toThrow();
  });

  it("contains native send failures through the existing surface error reporter", async () => {
    const f = await fixture();
    await f.startPanel();
    const error = new Error("renderer send failed");
    vi.spyOn(f.sender, "send").mockImplementation(() => { throw error; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await f.invalidate();
    expect(warn).toHaveBeenCalledWith('[desktop] notify invalidated plugin panel "plugin"', error);
    expect(f.previewStops).toEqual([previewUrl]);
  });
});
