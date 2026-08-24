import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { assertInstanceBudget } from "./pluginWebAppInstances";
import {
  PluginHost,
  PluginHostPanelDeclaration,
  PluginHostRecordToken,
  type PluginHostOptions,
} from "./PluginHost";
import { PluginSurfaceHostLifecycle } from "./pluginSurfaceHostLifecycle";
import { PLUGIN_HOST_METHODS, type PluginRuntimeStatus } from "./pluginHostProtocol";
import { readPluginLocalState } from "./pluginLocalState";
import {
  PluginSurfaces,
  type PluginPanelStartRequest,
  type PluginPanelStartAdmission,
  type PluginSurfaceHostLease,
  type PluginSurfaceStopTarget,
  type PluginWebAppHostLease,
  type PluginWebAppStartAdmission,
  type PluginWebAppContainer,
  type PluginWebAppViewLike,
} from "./pluginSurfaces";
import { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeView implements PluginWebAppViewLike {
  static created: FakeView[] = [];
  static throwOnNextLoad = false;
  static throwOnNextSessionHardening = false;
  static onNextClose: (() => void) | null = null;
  static onNextCreate: (() => void) | null = null;

  readonly load = deferred<void>();
  readonly bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
  readonly visibility: boolean[] = [];
  readonly zoom: number[] = [];
  readonly throwOnSessionHardening = FakeView.throwOnNextSessionHardening;
  closed = 0;
  destroyed = false;
  onClose: () => void = () => undefined;
  readonly throwOnLoad: boolean;
  readonly webContents = {
      session: {
        on: () => this.webContents.session,
        setPermissionRequestHandler: () => {
          if (this.throwOnSessionHardening) {
            throw new Error("session hardening failed");
          }
        },
    },
    on: () => this.webContents,
    setWindowOpenHandler: () => undefined,
    loadURL: () => {
      if (this.throwOnLoad) throw new Error("load threw");
      return this.load.promise;
    },
    isDestroyed: () => this.destroyed,
    close: () => {
      this.closed += 1;
      this.destroyed = true;
      this.onClose();
    },
    setZoomLevel: (level: number) => this.zoom.push(level),
  };

  constructor(_options: object) {
    FakeView.throwOnNextSessionHardening = false;
    this.throwOnLoad = FakeView.throwOnNextLoad;
    FakeView.throwOnNextLoad = false;
    this.onClose = FakeView.onNextClose ?? (() => undefined);
    FakeView.onNextClose = null;
    FakeView.created.push(this);
    FakeView.onNextCreate?.();
    FakeView.onNextCreate = null;
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds.push(bounds);
  }

  setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }
}

beforeEach(() => {
  FakeView.created = [];
  FakeView.throwOnNextLoad = false;
  FakeView.throwOnNextSessionHardening = false;
  FakeView.onNextClose = null;
  FakeView.onNextCreate = null;
});

const defaultHostRecord = {} as PluginHostRecordToken;

type TestHostLease = PluginSurfaceHostLease & {
  currentRecord(): PluginHostRecordToken | undefined;
  releases: number;
};

function lease(options: {
  steps?: string[];
  label?: string;
  gate?: Promise<void>;
  record?: () => PluginHostRecordToken | undefined;
} = {}): TestHostLease {
  return {
    releases: 0,
    start: async () => "spawn-1",
    currentSpawnId: () => "spawn-1",
    currentRecord: options.record ?? (() => defaultHostRecord),
    async release() {
      this.releases += 1;
      options.steps?.push(`release:${options.label ?? "lease"}`);
      await options.gate;
    },
  };
}

function container(): PluginWebAppContainer<FakeView> & { views: FakeView[] } {
  const views: FakeView[] = [];
  return {
    views,
    isDestroyed: () => false,
    attach: (view) => views.push(view),
    detach: (view) => {
      const index = views.indexOf(view);
      if (index >= 0) views.splice(index, 1);
    },
  };
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

const webRequest = (ownedContainer = container()) => ({
  workspaceId: "ws",
  workspaceRoot: "C:/ws",
  pluginId: "plugin",
  webAppId: "app",
  instanceKey: null,
  senderId: 7,
  generation: 1,
  container: ownedContainer,
});

function webAdmission(input: {
  ownedLease: PluginSurfaceHostLease;
  attempt?: string;
  spawn?: () => string;
  steps?: string[];
  unpairGate?: Promise<void>;
  startGate?: Promise<void>;
  webAppGate?: Promise<void>;
  onWebAppStart?: () => void;
  startHost?: () => Promise<string>;
  startWebApp?: () => Promise<{ url: string; title?: string }>;
  unpair?: (expectedSpawnId: string) => Promise<void>;
  assertBudget?: (liveAndReservedOtherInstances: number) => void;
}): PluginWebAppStartAdmission {
  const spawn = input.spawn ?? (() => "spawn-1");
  const attempt = input.attempt ?? "attempt";
  return {
    assertInstanceBudget: input.assertBudget ?? (() => undefined),
    assertAllowed: () => undefined,
    acquireHostLease: async (): Promise<PluginWebAppHostLease> => ({
      start: async () => {
        await input.startGate;
        input.steps?.push(`host:${attempt}`);
        return input.startHost ? input.startHost() : spawn();
      },
      currentSpawnId: spawn,
      startWebApp:
        input.startWebApp ??
        (async () => {
          input.onWebAppStart?.();
          await input.webAppGate;
          return {
            url: `http://127.0.0.1:4000/pair#${attempt}`,
            title: attempt,
          };
        }),
      unpair:
        input.unpair ??
        (async () => {
          input.steps?.push(`unpair:${attempt}`);
          await input.unpairGate;
        }),
      release: () => input.ownedLease.release(),
    }),
  };
}

function createSurfaces(options: {
  notifications?: string[];
  invalidatedSurfaceIds?: number[];
  invalidationError?: Error;
  errors?: unknown[];
  disposedPanelIds?: string[];
  disposedSurfaceIds?: number[];
  workspaceEvents?: PluginWorkspaceEvents;
  boundWebContents?: FakeView["webContents"][];
} = {}) {
  return new PluginSurfaces<FakeView>({
    ViewClass: FakeView,
    bindWebAppZoom: (webContents) => {
      options.boundWebContents?.push(webContents);
      webContents.setZoomLevel(0);
    },
    allowPanelOrigin: () => () => undefined,
    clearPanelStorage: () => Promise.resolve(),
    clearGuestPartition: () => Promise.resolve(),
    notifyWebAppFailed: ({ pluginId }) =>
      options.notifications?.push(pluginId),
    notifyPanelInvalidated: ({ surfaceId }) => {
      options.invalidatedSurfaceIds?.push(surfaceId);
      if (options.invalidationError) throw options.invalidationError;
    },
    onPanelDisposed: ({
      workspaceId,
      pluginId,
      panelId,
      surfaceId,
    }) => {
      options.disposedPanelIds?.push(panelId);
      options.disposedSurfaceIds?.push(surfaceId);
      options.workspaceEvents?.disposeOwner({
        kind: "panel",
        workspaceId,
        pluginId,
        panelId,
        surfaceId,
      });
    },
    onError: (error) => options.errors?.push(error),
  });
}

const panelRequest = {
  workspaceId: "ws",
  pluginId: "plugin",
  panelId: "panel",
  placement: "editor" as const,
  senderId: 7,
  generation: 1,
};

const declaredPanels = [{
  id: "panel",
  title: "Panel",
  placement: "editor" as const,
  entry: "panel/index.html",
}];

function panelAdmission(input: {
  ownedLease: TestHostLease;
  spawn?: () => string;
  startGate?: Promise<void>;
  previewGate?: Promise<void>;
  onPreviewStart?: () => void;
  previewStop?: () => Promise<void>;
  url?: string;
  panel?: Partial<PluginHostPanelDeclaration>;
}): PluginPanelStartAdmission {
  const spawn = input.spawn ?? (() => "spawn-1");
  return {
    assertAllowed: () => undefined,
    acquireHostLease: async () => ({
      start: async () => {
        await input.startGate;
        return spawn();
      },
      startPanel: async (panelId) => {
        await input.startGate;
        return {
          spawnId: spawn(),
          hostRecord: input.ownedLease.currentRecord() ?? defaultHostRecord,
          panel: {
            id: panelId,
            title: "Panel",
            entry: "panel/index.html",
            placement: "editor",
            ...input.panel,
          },
        };
      },
      currentSpawnId: spawn,
      currentRecord: () => input.ownedLease.currentRecord(),
      release: () => input.ownedLease.release(),
    }),
    startPreview: async () => {
      input.onPreviewStart?.();
      await input.previewGate;
      return {
        url: input.url ?? "http://127.0.0.1:4100/panel.html",
        stop: input.previewStop ?? (() => Promise.resolve()),
      };
    },
  };
}

type TestSurfaceScope = {
  workspaceId: string;
  pluginId: string;
  senderId: number;
};

async function startSurfacePair(
  surfaces: PluginSurfaces<FakeView>,
  scope: TestSurfaceScope,
  suffix: string,
) {
  const panel = {
    ...scope,
    generation: 1,
    panelId: `${suffix}-panel`,
    placement: "editor" as const,
  };
  const webApp = {
    ...scope,
    generation: 1,
    workspaceRoot: "C:/workspace",
    webAppId: `${suffix}-app`,
    instanceKey: null,
    container: container(),
  };
  await surfaces.startPanel(panel, panelAdmission({ ownedLease: lease() }));
  await surfaces.startWebApp(webApp, webAdmission({ ownedLease: lease() }));
  return { panel, webApp };
}

function panelIsLive(
  surfaces: PluginSurfaces<FakeView>,
  panel: TestSurfaceScope & { generation: number; panelId: string },
): boolean {
  try {
    surfaces.authorizePanelSdk({
      workspaceId: panel.workspaceId,
      pluginId: panel.pluginId,
      panelId: panel.panelId,
      senderId: panel.senderId,
      currentGeneration: () => panel.generation,
      activeWorkspaceId: () => panel.workspaceId,
      liveSpawnId: () => "spawn-1",
    });
    return true;
  } catch {
    return false;
  }
}

function webAppIsLive(
  surfaces: PluginSurfaces<FakeView>,
  webApp: TestSurfaceScope & {
    generation: number;
    webAppId: string;
    instanceKey: string | null;
  },
): boolean {
  return surfaces.applyWebAppBounds({
    workspaceId: webApp.workspaceId,
    pluginId: webApp.pluginId,
    webAppId: webApp.webAppId,
    instanceKey: webApp.instanceKey,
    senderId: webApp.senderId,
    generation: webApp.generation,
    zoomFactor: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    visible: true,
  });
}

describe("PluginSurfaces web app attempt ownership", () => {
  it("unpairs a stopped pending navigation without touching its successor", async () => {
    FakeView.created = [];
    const notifications: string[] = [];
    const unpairs: Array<{
      attempt: string;
      expectedSpawnId: string;
      liveSpawnId: string;
    }> = [];
    let currentSpawn = "spawn-1";
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: () => Promise.resolve(),
      notifyWebAppFailed: ({ pluginId }) => notifications.push(pluginId),
      notifyPanelInvalidated: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
    const target = {
      workspaceId: "ws",
      workspaceRoot: "C:/ws",
      pluginId: "plugin",
      webAppId: "app",
      instanceKey: null,
      senderId: 7,
      generation: 1,
      container: container(),
    };
    const firstLease = lease();
    const secondLease = lease();
    const admission = (ownedLease: PluginSurfaceHostLease, attempt: string) => ({
      assertInstanceBudget: () => undefined,
      assertAllowed: () => undefined,
      acquireHostLease: async () => ({
        start: async () => currentSpawn,
        currentSpawnId: () => currentSpawn,
        startWebApp: async () => ({
          url: `http://127.0.0.1:4000/pair#${attempt}`,
          title: attempt,
        }),
        unpair: async (expectedSpawnId: string) => {
          unpairs.push({ attempt, expectedSpawnId, liveSpawnId: currentSpawn });
        },
        release: () => ownedLease.release(),
      }),
    });

    await surfaces.startWebApp(target, admission(firstLease, "a"));
    const firstView = FakeView.created[0]!;
    const stopping = surfaces.stop({
      kind: "web-app",
      workspaceId: target.workspaceId,
      pluginId: target.pluginId,
      webAppId: target.webAppId,
      instanceKey: target.instanceKey,
      owner: { senderId: 7, generation: 1 },
    });
    firstView.load.reject(new Error("closed during navigation"));
    await stopping;
    currentSpawn = "spawn-2";
    await surfaces.startWebApp(target, admission(secondLease, "b"));

    await turns();

    expect(notifications).toEqual([]);
    expect(unpairs).toEqual([{
      attempt: "a",
      expectedSpawnId: "spawn-1",
      liveSpawnId: "spawn-1",
    }]);
    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(0);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 7,
        generation: 1,
        zoomFactor: 1,
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        visible: true,
      }),
    ).toBe(true);
    expect(FakeView.created[1]!.bounds).toEqual([
      { x: 1, y: 2, width: 3, height: 4 },
    ]);
  });

  it("retires a pending predecessor before requesting its successor URL", async () => {
    FakeView.created = [];
    const steps: string[] = [];
    const predecessorUnpaired = deferred<void>();
    const predecessorUnpairEntered = deferred<void>();
    const surfaces = createSurfaces();
    const request = webRequest();
    const firstLease = lease({ steps, label: "a" });
    await surfaces.startWebApp(
      request,
      webAdmission({
        ownedLease: firstLease,
        attempt: "a",
        steps,
        unpair: async () => {
          steps.push("unpair:a");
          predecessorUnpairEntered.resolve();
          await predecessorUnpaired.promise;
        },
      }),
    );

    const successor = surfaces.startWebApp(
      request,
      webAdmission({
        ownedLease: lease({ steps, label: "b" }),
        attempt: "b",
        steps,
        onWebAppStart: () => steps.push("credential:b"),
      }),
    );
    await predecessorUnpairEntered.promise;

    expect(steps).toContain("unpair:a");
    expect(steps).not.toContain("credential:b");
    predecessorUnpaired.resolve();
    await successor;
    expect(steps.indexOf("credential:b")).toBeGreaterThan(
      steps.indexOf("unpair:a"),
    );
    expect(firstLease.releases).toBe(1);
  });

  it("does not unpair a navigation that fulfilled before its stop", async () => {
    FakeView.created = [];
    const unpair = vi.fn(async () => undefined);
    const ownedLease = lease();
    const surfaces = createSurfaces();
    const request = webRequest();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease, unpair }),
    );
    FakeView.created[0]!.load.resolve();
    await turns();

    await surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
    });

    expect(unpair).not.toHaveBeenCalled();
    expect(ownedLease.releases).toBe(1);
  });

  it("still removes a stopped pending navigation when exact unpair fails", async () => {
    FakeView.created = [];
    const failure = new Error("unpair failed");
    const errors: unknown[] = [];
    const ownedLease = lease();
    const surfaces = createSurfaces({ errors });
    const request = webRequest();
    const unpair = vi.fn(async () => {
      throw failure;
    });
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease, unpair }),
    );

    await surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
    });

    expect(unpair).toHaveBeenCalledOnce();
    expect(errors).toEqual([failure]);
    expect(ownedLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(webAppIsLive(surfaces, request)).toBe(false);
  });

  it("retires a pending predecessor and refuses its successor when unpair fails", async () => {
    FakeView.created = [];
    const failure = new Error("unpair failed");
    const errors: unknown[] = [];
    const firstLease = lease();
    const secondLease = lease();
    const surfaces = createSurfaces({ errors });
    const request = webRequest();
    const unpair = vi.fn(async () => {
      throw failure;
    });
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: firstLease, unpair }),
    );

    await expect(
      surfaces.startWebApp(
        request,
        webAdmission({ ownedLease: secondLease, attempt: "successor" }),
      ),
    ).rejects.toBe(failure);

    expect(unpair).toHaveBeenCalledOnce();
    expect(errors).toEqual([failure]);
    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(FakeView.created).toHaveLength(1);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(webAppIsLive(surfaces, request)).toBe(false);
  });

  it("does not unpair a successor spawn when stop observes a host change", async () => {
    FakeView.created = [];
    let spawnId = "spawn-a";
    const unpair = vi.fn(async () => undefined);
    const firstLease = lease();
    const secondLease = lease();
    const surfaces = createSurfaces();
    const request = webRequest();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: firstLease, spawn: () => spawnId, unpair }),
    );

    const stopping = surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
    });
    spawnId = "spawn-b";
    await stopping;
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: secondLease, spawn: () => spawnId }),
    );

    expect(unpair).not.toHaveBeenCalled();
    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(0);
    expect(webAppIsLive(surfaces, request)).toBe(true);
  });

  it("settles a consumed start failure, then recovers outside its own lane", async () => {
    FakeView.created = [];
    FakeView.throwOnNextLoad = true;
    const steps: string[] = [];
    FakeView.onNextClose = () => steps.push("dispose");
    const ownedLease = lease({ steps, label: "failed" });
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: () => Promise.resolve(),
      notifyWebAppFailed: () => steps.push("notify"),
      notifyPanelInvalidated: () => undefined,
      onError: () => undefined,
    });
    const request = webRequest();

    await expect(
      surfaces.startWebApp(
        request,
        webAdmission({ ownedLease, attempt: "failed", steps }),
      ),
    ).rejects.toThrow("load threw");
    await surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
    });

    expect(steps).toEqual([
      "host:failed",
      "notify",
      "unpair:failed",
      "dispose",
      "release:failed",
    ]);
    expect(ownedLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
  });

  it("queues a restart behind the failed attempt's unpair", async () => {
    FakeView.created = [];
    const steps: string[] = [];
    const unpair = deferred<void>();
    const surfaces = createSurfaces({ notifications: steps });
    const request = webRequest();
    await surfaces.startWebApp(
      request,
      webAdmission({
        ownedLease: lease({ steps, label: "a" }),
        attempt: "a",
        steps,
        unpairGate: unpair.promise,
      }),
    );
    FakeView.created[0]!.load.reject(new Error("navigation failed"));
    await turns();

    let restartSettled = false;
    const restart = surfaces
      .startWebApp(
        request,
        webAdmission({
          ownedLease: lease({ steps, label: "b" }),
          attempt: "b",
          steps,
        }),
      )
      .then(() => {
        restartSettled = true;
      });
    await turns();

    expect(steps).toContain("unpair:a");
    expect(steps).not.toContain("host:b");
    expect(restartSettled).toBe(false);
    unpair.resolve();
    await restart;
    expect(steps.indexOf("host:b")).toBeGreaterThan(steps.indexOf("unpair:a"));
  });

  it("releases pending and displaced attempts exactly once when guest creation throws", async () => {
    FakeView.created = [];
    const notifications: string[] = [];
    const surfaces = createSurfaces({ notifications });
    const request = webRequest();
    const firstLease = lease();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: firstLease, attempt: "a" }),
    );
    const firstView = FakeView.created[0]!;

    FakeView.throwOnNextLoad = true;
    const secondLease = lease();
    await expect(
      surfaces.startWebApp(
        request,
        webAdmission({ ownedLease: secondLease, attempt: "b" }),
      ),
    ).rejects.toThrow("load threw");
    await surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
    });

    expect(notifications).toEqual(["plugin"]);
    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(firstView.closed).toBe(1);
    expect(FakeView.created[1]!.closed).toBe(1);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 7,
        generation: 1,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("destroys and releases a pending view exactly once when attachment fails", async () => {
    FakeView.created = [];
    const ownedLease = lease();
    const unpair = vi.fn(async () => undefined);
    const ownedContainer = container();
    const attach = ownedContainer.attach;
    ownedContainer.attach = () => {
      throw new Error("window disappeared");
    };
    const surfaces = createSurfaces();
    const request = webRequest(ownedContainer);
    const admission = webAdmission({ ownedLease, attempt: "pending", unpair });

    await expect(surfaces.startWebApp(request, admission)).rejects.toThrow(
      "window disappeared",
    );
    ownedContainer.attach = attach;
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: lease(), attempt: "replacement" }),
    );

    expect(unpair).toHaveBeenCalledOnce();
    expect(ownedLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
  });

  it("owns and recovers a guest when setup throws immediately after construction", async () => {
    FakeView.created = [];
    FakeView.throwOnNextSessionHardening = true;
    const notifications: string[] = [];
    const unpaired = deferred<void>();
    const ownedLease = lease();
    const surfaces = createSurfaces({ notifications });
    const request = webRequest();
    const unpair = vi.fn(async () => {
      unpaired.resolve();
    });
    const admission = webAdmission({
      ownedLease,
      attempt: "setup-failure",
      unpair,
    });

    await expect(surfaces.startWebApp(request, admission)).rejects.toThrow(
      "session hardening failed",
    );
    await unpaired.promise;
    await turns();

    expect(unpair).toHaveBeenCalledOnce();
    expect(ownedLease.releases).toBe(1);
    expect(FakeView.created).toHaveLength(1);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(notifications).toEqual(["plugin"]);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: request.workspaceId,
        pluginId: request.pluginId,
        webAppId: request.webAppId,
        instanceKey: request.instanceKey,
        senderId: request.senderId,
        generation: request.generation,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("recovers a consumed credential when its window closes before guest creation", async () => {
    FakeView.created = [];
    const steps: string[] = [];
    const ownedContainer = container();
    ownedContainer.isDestroyed = () => true;
    const ownedLease = lease({ steps, label: "closed-window" });
    const surfaces = createSurfaces({ notifications: steps });

    await expect(
      surfaces.startWebApp(
        webRequest(ownedContainer),
        webAdmission({
          ownedLease,
          attempt: "closed-window",
          steps,
        }),
      ),
    ).rejects.toThrow("The plugin web app request has no open window.");
    await surfaces.stop({
      kind: "sender",
      senderId: 7,
    });

    expect(steps).toEqual([
      "host:closed-window",
      "plugin",
      "unpair:closed-window",
      "release:closed-window",
    ]);
    expect(FakeView.created).toEqual([]);
    expect(ownedLease.releases).toBe(1);
  });

  it("runs a scope stop after post-register displaced cleanup in the identity lane", async () => {
    FakeView.created = [];
    const releaseDisplaced = deferred<void>();
    const surfaces = createSurfaces();
    const request = webRequest();
    const firstLease = lease({ gate: releaseDisplaced.promise });
    const secondLease = lease();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: firstLease, attempt: "a" }),
    );
    FakeView.created[0]!.load.resolve();
    await turns();

    let replacementSettled = false;
    const replacementCreated = deferred<void>();
    const unpair = vi.fn(async () => undefined);
    FakeView.onNextCreate = () => replacementCreated.resolve();
    const replacement = surfaces
      .startWebApp(
        request,
        webAdmission({ ownedLease: secondLease, attempt: "b", unpair }),
      )
      .then(() => {
        replacementSettled = true;
      });
    await replacementCreated.promise;
    expect(FakeView.created).toHaveLength(2);
    expect(replacementSettled).toBe(false);

    let stopSettled = false;
    const stopped = surfaces
      .stop({
        kind: "plugin",
        workspaceId: "ws",
        pluginId: "plugin",
      })
      .then(() => {
        stopSettled = true;
      });
    await turns();
    expect(stopSettled).toBe(false);
    expect(FakeView.created[1]!.closed).toBe(0);
    const replacementRejected = expect(replacement).rejects.toThrow(/cancelled/);

    releaseDisplaced.resolve();
    await Promise.all([replacementRejected, stopped]);
    expect(unpair).toHaveBeenCalledOnce();
    expect(FakeView.created[1]!.closed).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 7,
        generation: 1,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("rejects an installed web-app replacement overtaken by a host change", async () => {
    FakeView.created = [];
    const releaseDisplaced = deferred<void>();
    const notifications: string[] = [];
    const surfaces = createSurfaces({ notifications });
    const request = webRequest();
    const firstLease = lease({ gate: releaseDisplaced.promise });
    const secondLease = lease();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: firstLease, attempt: "first" }),
    );
    FakeView.created[0]!.load.resolve();
    await turns();
    const replacement = surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: secondLease, attempt: "replacement" }),
    );
    while (firstLease.releases === 0) await Promise.resolve();
    expect(FakeView.created).toHaveLength(2);
    expect(FakeView.created[1]!.closed).toBe(0);

    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
    });
    const rejected = expect(replacement).rejects.toThrow(/restarted/);
    releaseDisplaced.resolve();
    await rejected;
    await turns();

    expect(notifications).toEqual(["plugin"]);
    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(FakeView.created[1]!.closed).toBe(1);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: request.workspaceId,
        pluginId: request.pluginId,
        webAppId: request.webAppId,
        instanceKey: request.instanceKey,
        senderId: request.senderId,
        generation: request.generation,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("rechecks the exact spawn after displaced web-app cleanup", async () => {
    FakeView.created = [];
    const releaseDisplaced = deferred<void>();
    const surfaces = createSurfaces();
    const request = webRequest();
    const firstLease = lease({ gate: releaseDisplaced.promise });
    const secondLease = lease();
    let spawnId = "spawn-1";
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: firstLease, attempt: "first" }),
    );
    FakeView.created[0]!.load.resolve();
    await turns();
    const replacement = surfaces.startWebApp(
      request,
      webAdmission({
        ownedLease: secondLease,
        attempt: "replacement",
        spawn: () => spawnId,
      }),
    );
    while (firstLease.releases === 0) await Promise.resolve();

    spawnId = "spawn-2";
    const rejected = expect(replacement).rejects.toThrow(/restarted/);
    releaseDisplaced.resolve();
    await rejected;
    await turns();

    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(FakeView.created[1]!.closed).toBe(1);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: request.workspaceId,
        pluginId: request.pluginId,
        webAppId: request.webAppId,
        instanceKey: request.instanceKey,
        senderId: request.senderId,
        generation: request.generation,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("reserves the shared instance budget before sibling identity lanes await", async () => {
    FakeView.created = [];
    const surfaces = createSurfaces();
    const assertBudget = (count: number) =>
      assertInstanceBudget("plugin", "app", count);
    for (let index = 0; index < 19; index += 1) {
      await surfaces.startWebApp(
        { ...webRequest(), instanceKey: `live-${index}` },
        webAdmission({ ownedLease: lease(), assertBudget }),
      );
    }
    const firstGate = deferred<void>();
    const first = surfaces.startWebApp(
      { ...webRequest(), instanceKey: "candidate-a" },
      webAdmission({
        ownedLease: lease(),
        attempt: "candidate-a",
        startGate: firstGate.promise,
        assertBudget,
      }),
    );

    await expect(
      surfaces.startWebApp(
        { ...webRequest(), instanceKey: "candidate-b" },
        webAdmission({
          ownedLease: lease(),
          attempt: "candidate-b",
          assertBudget,
        }),
      ),
    ).rejects.toThrow(/limit of 20 instances/);
    firstGate.resolve();
    await expect(first).resolves.toMatchObject({ title: "candidate-a" });
    expect(FakeView.created).toHaveLength(20);
    await surfaces.close();
  });

  it("releases an instance reservation when its start fails", async () => {
    FakeView.created = [];
    const surfaces = createSurfaces();
    const assertBudget = (count: number) =>
      assertInstanceBudget("plugin", "app", count);
    for (let index = 0; index < 19; index += 1) {
      await surfaces.startWebApp(
        { ...webRequest(), instanceKey: `live-${index}` },
        webAdmission({ ownedLease: lease(), assertBudget }),
      );
    }
    const failedGate = deferred<void>();
    const failedLease = lease();
    const failedAdmission = webAdmission({
      ownedLease: failedLease,
      attempt: "failed-candidate",
      assertBudget,
      startHost: async () => {
        await failedGate.promise;
        throw new Error("host refused start");
      },
    });
    const failed = surfaces.startWebApp(
      { ...webRequest(), instanceKey: "failed-candidate" },
      failedAdmission,
    );

    await expect(
      surfaces.startWebApp(
        { ...webRequest(), instanceKey: "replacement-candidate" },
        webAdmission({ ownedLease: lease(), assertBudget }),
      ),
    ).rejects.toThrow(/limit of 20 instances/);
    failedGate.resolve();
    await expect(failed).rejects.toThrow("host refused start");
    await expect(
      surfaces.startWebApp(
        { ...webRequest(), instanceKey: "replacement-candidate" },
        webAdmission({
          ownedLease: lease(),
          attempt: "replacement-candidate",
          assertBudget,
        }),
      ),
    ).resolves.toMatchObject({ title: "replacement-candidate" });

    expect(failedLease.releases).toBe(1);
    expect(FakeView.created).toHaveLength(20);
    await surfaces.close();
  });

  it.each([
    ["panel", "stop", null],
    ["web app", "stop", new Error("simulated lease release failure")],
    ["panel", "close", null],
    ["web app", "close", null],
  ] as const)(
    "releases a %s lease before queued %s waits for its start lane",
    async (kind, cleanup, releaseFailure) => {
      FakeView.created = [];
      const startEntered = deferred<void>();
      const releaseRequested = deferred<void>();
      const startSettled = deferred<void>();
      const finishRelease = deferred<void>();
      const errors: unknown[] = [];
      let releaseCalls = 0;
      const release = async () => {
        releaseCalls += 1;
        releaseRequested.resolve();
        await startSettled.promise;
        await finishRelease.promise;
        if (releaseFailure) throw releaseFailure;
      };
      const start = async () => {
        startEntered.resolve();
        await releaseRequested.promise;
        startSettled.resolve();
        return "spawn-1";
      };
      const surfaces = createSurfaces({ errors });
      const starting = kind === "panel"
        ? surfaces.startPanel(panelRequest, {
            assertAllowed: () => undefined,
            acquireHostLease: async () => ({
              start,
              startPanel: async (panelId) => ({
                spawnId: await start(),
                hostRecord: defaultHostRecord,
                panel: {
                  id: panelId,
                  title: "Panel",
                  entry: "panel/index.html",
                  placement: "editor",
                },
              }),
              currentSpawnId: () => "spawn-1",
              currentRecord: () => defaultHostRecord,
              release,
            }),
            startPreview: async () => ({
              url: "http://127.0.0.1:4100/panel.html",
              stop: async () => undefined,
            }),
          })
        : surfaces.startWebApp(webRequest(), {
            assertInstanceBudget: () => undefined,
            assertAllowed: () => undefined,
            acquireHostLease: async () => ({
              start,
              currentSpawnId: () => "spawn-1",
              startWebApp: async () => ({
                url: "http://127.0.0.1:4000/pair#attempt",
              }),
              unpair: async () => undefined,
              release,
            }),
          });
      const startOutcome = starting.then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await startEntered.promise;
      const stopping = cleanup === "stop"
        ? surfaces.stop({
            kind: "plugin",
            workspaceId: "ws",
            pluginId: "plugin",
          })
        : surfaces.close();
      let stopSettled = false;
      void stopping.then(() => {
        stopSettled = true;
      });

      try {
        expect(releaseCalls).toBe(1);
        await startSettled.promise;
        await turns(50);
        expect(stopSettled).toBe(false);
        finishRelease.resolve();
        const [outcome] = await Promise.all([startOutcome, stopping]);
        expect(outcome.ok).toBe(false);
        expect(String(outcome.error)).toMatch(/cancelled/);
        expect(releaseCalls).toBe(1);
        expect(errors).toEqual(releaseFailure ? [releaseFailure] : []);
        expect(FakeView.created).toEqual([]);
      } finally {
        releaseRequested.resolve();
        startSettled.resolve();
        finishRelease.resolve();
        await Promise.all([startOutcome, stopping.catch(() => undefined)]);
        await surfaces.close();
      }
    },
  );

  it("captures pre-install panel and web-app attempts for a sender stop", async () => {
    FakeView.created = [];
    const panelGate = deferred<void>();
    const webAppGate = deferred<void>();
    const panelStopped = vi.fn(async () => undefined);
    const panelLease = lease();
    const webAppLease = lease();
    const surfaces = createSurfaces();
    const panelStart = surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: panelLease,
        previewStop: panelStopped,
        startGate: panelGate.promise,
      }),
    );
    const webAppStart = surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: webAppLease, startGate: webAppGate.promise }),
    );
    await turns();
    const stopped = surfaces.stop({ kind: "sender", senderId: 7 });
    const panelRejected = expect(panelStart).rejects.toThrow(/cancelled/);
    const webAppRejected = expect(webAppStart).rejects.toThrow(/cancelled/);

    panelGate.resolve();
    webAppGate.resolve();
    await Promise.all([panelRejected, webAppRejected, stopped]);

    expect(panelStopped).not.toHaveBeenCalled();
    expect(panelLease.releases).toBe(1);
    expect(webAppLease.releases).toBe(1);
    expect(FakeView.created).toEqual([]);
    expect(() =>
      surfaces.authorizePanelSdk({
        workspaceId: "ws",
        pluginId: "plugin",
        panelId: "panel",
        senderId: 7,
        currentGeneration: () => 1,
        activeWorkspaceId: () => "ws",
        liveSpawnId: () => "spawn-1",
      }),
    ).toThrow();
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 7,
        generation: 1,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("synchronously cancels pre-install attempts captured by close", async () => {
    FakeView.created = [];
    const panelGate = deferred<void>();
    const webAppGate = deferred<void>();
    const panelLease = lease();
    const webAppLease = lease();
    const surfaces = createSurfaces();
    const panelStart = surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: panelLease,
        startGate: panelGate.promise,
      }),
    );
    const webAppStart = surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: webAppLease, startGate: webAppGate.promise }),
    );
    await turns();

    const closing = surfaces.close();
    const panelRejected = expect(panelStart).rejects.toThrow(/cancelled/);
    const webAppRejected = expect(webAppStart).rejects.toThrow(/cancelled/);
    panelGate.resolve();
    webAppGate.resolve();

    await Promise.all([panelRejected, webAppRejected, closing]);
    expect(panelLease.releases).toBe(1);
    expect(webAppLease.releases).toBe(1);
    expect(FakeView.created).toEqual([]);
    expect(() =>
      surfaces.authorizePanelSdk({
        workspaceId: "ws",
        pluginId: "plugin",
        panelId: "panel",
        senderId: 7,
        currentGeneration: () => 1,
        activeWorkspaceId: () => "ws",
        liveSpawnId: () => "spawn-1",
      }),
    ).toThrow();
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 7,
        generation: 1,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(false);
  });

  it("synchronously cancels pre-install attempts captured by exact owner stops", async () => {
    FakeView.created = [];
    const previewGate = deferred<void>();
    const credentialGate = deferred<void>();
    const previewEntered = deferred<void>();
    const credentialEntered = deferred<void>();
    const panelLease = lease();
    const webAppLease = lease();
    const stopPreview = vi.fn(async () => undefined);
    const unpair = vi.fn(async () => undefined);
    const surfaces = createSurfaces();
    const panelStart = surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: panelLease,
        previewGate: previewGate.promise,
        onPreviewStart: () => previewEntered.resolve(),
        previewStop: stopPreview,
      }),
    );
    const request = webRequest();
    const admission = webAdmission({
      ownedLease: webAppLease,
      webAppGate: credentialGate.promise,
      onWebAppStart: () => credentialEntered.resolve(),
      unpair,
    });
    const webAppStart = surfaces.startWebApp(
      request,
      admission,
    );
    await Promise.all([previewEntered.promise, credentialEntered.promise]);

    const panelStop = surfaces.stop({
      kind: "panel",
      workspaceId: panelRequest.workspaceId,
      pluginId: panelRequest.pluginId,
      panelId: panelRequest.panelId,
      owner: { senderId: 7, generation: 1 },
    });
    const webAppStop = surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
      owner: { senderId: 7, generation: 1 },
    });
    const panelRejected = expect(panelStart).rejects.toThrow(/cancelled/);
    const webAppRejected = expect(webAppStart).rejects.toThrow(/cancelled/);
    previewGate.resolve();
    credentialGate.resolve();

    await Promise.all([
      panelRejected,
      webAppRejected,
      panelStop,
      webAppStop,
    ]);
    expect(panelLease.releases).toBe(1);
    expect(webAppLease.releases).toBe(1);
    expect(stopPreview).toHaveBeenCalledOnce();
    expect(unpair).toHaveBeenCalledOnce();
    expect(FakeView.created).toEqual([]);
  });

  it("continues cancelled credential cleanup when exact unpair throws", async () => {
    FakeView.created = [];
    const credentialGate = deferred<void>();
    const credentialEntered = deferred<void>();
    const failure = new Error("unpair failed");
    const errors: unknown[] = [];
    const notifications: string[] = [];
    const ownedLease = lease();
    const surfaces = createSurfaces({ errors, notifications });
    const request = webRequest();
    const unpair = vi.fn(async () => {
      throw failure;
    });
    const admission = webAdmission({
      ownedLease,
      webAppGate: credentialGate.promise,
      onWebAppStart: () => credentialEntered.resolve(),
      unpair,
    });
    const starting = surfaces.startWebApp(request, admission);
    await credentialEntered.promise;

    const stopping = surfaces.stop({
      kind: "web-app",
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      webAppId: request.webAppId,
      instanceKey: request.instanceKey,
      owner: { senderId: request.senderId, generation: request.generation },
    });
    const rejected = expect(starting).rejects.toThrow(/cancelled/);
    credentialGate.resolve();
    await Promise.all([rejected, stopping]);

    expect(unpair).toHaveBeenCalledOnce();
    expect(ownedLease.releases).toBe(1);
    expect(FakeView.created).toEqual([]);
    expect(notifications).toEqual([]);
    expect(errors).toEqual([failure]);
  });

  it.each(["spawn", "epoch"] as const)(
    "does not unpair a cancelled credential after its %s changes",
    async (change) => {
      FakeView.created = [];
      const credentialGate = deferred<void>();
      const credentialEntered = deferred<void>();
      const notifications: string[] = [];
      const ownedLease = lease();
      let spawnId = "spawn-a";
      const surfaces = createSurfaces({ notifications });
      const request = webRequest();
      const unpair = vi.fn(async () => undefined);
      const admission = webAdmission({
        ownedLease,
        spawn: () => spawnId,
        webAppGate: credentialGate.promise,
        onWebAppStart: () => credentialEntered.resolve(),
        unpair,
      });
      const starting = surfaces.startWebApp(request, admission);
      await credentialEntered.promise;

      const stopping = surfaces.stop({
        kind: "web-app",
        workspaceId: request.workspaceId,
        pluginId: request.pluginId,
        webAppId: request.webAppId,
        instanceKey: request.instanceKey,
        owner: { senderId: request.senderId, generation: request.generation },
      });
      if (change === "spawn") {
        spawnId = "spawn-b";
      } else {
        surfaces.hostChanged({
          kind: "terminal",
          workspaceId: request.workspaceId,
          pluginId: request.pluginId,
        });
      }
      const rejected = expect(starting).rejects.toThrow(/cancelled/);
      credentialGate.resolve();
      await Promise.all([rejected, stopping]);
      await turns();

      expect(unpair).not.toHaveBeenCalled();
      expect(ownedLease.releases).toBe(1);
      expect(FakeView.created).toEqual([]);
      expect(notifications).toEqual([]);
    },
  );

  it("lets an exact owner stop cancel a replacement behind another owner's record", async () => {
    FakeView.created = [];
    const surfaces = createSurfaces();
    const firstPanelLease = lease();
    const firstWebAppLease = lease();
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: firstPanelLease }),
    );
    const firstWebRequest = webRequest();
    await surfaces.startWebApp(
      firstWebRequest,
      webAdmission({ ownedLease: firstWebAppLease, attempt: "first" }),
    );
    FakeView.created[0]!.load.resolve();
    await turns();

    const previewGate = deferred<void>();
    const previewEntered = deferred<void>();
    const credentialGate = deferred<void>();
    const credentialEntered = deferred<void>();
    const secondPanelLease = lease();
    const secondWebAppLease = lease();
    const secondPanelRequest = { ...panelRequest, generation: 2 };
    const secondWebRequest = { ...webRequest(), generation: 2 };
    const secondPanelStart = surfaces.startPanel(
      secondPanelRequest,
      panelAdmission({
        ownedLease: secondPanelLease,
        previewGate: previewGate.promise,
        onPreviewStart: () => previewEntered.resolve(),
      }),
    );
    const unpair = vi.fn(async () => undefined);
    const secondWebAdmission = webAdmission({
      ownedLease: secondWebAppLease,
      attempt: "second",
      webAppGate: credentialGate.promise,
      onWebAppStart: () => credentialEntered.resolve(),
      unpair,
    });
    const secondWebStart = surfaces.startWebApp(
      secondWebRequest,
      secondWebAdmission,
    );
    await Promise.all([previewEntered.promise, credentialEntered.promise]);

    const panelStop = surfaces.stop({
      kind: "panel",
      workspaceId: secondPanelRequest.workspaceId,
      pluginId: secondPanelRequest.pluginId,
      panelId: secondPanelRequest.panelId,
      owner: { senderId: secondPanelRequest.senderId, generation: 2 },
    });
    const webAppStop = surfaces.stop({
      kind: "web-app",
      workspaceId: secondWebRequest.workspaceId,
      pluginId: secondWebRequest.pluginId,
      webAppId: secondWebRequest.webAppId,
      instanceKey: secondWebRequest.instanceKey,
      owner: { senderId: secondWebRequest.senderId, generation: 2 },
    });
    const panelRejected = expect(secondPanelStart).rejects.toThrow(/cancelled/);
    const webAppRejected = expect(secondWebStart).rejects.toThrow(/cancelled/);
    previewGate.resolve();
    credentialGate.resolve();
    await Promise.all([panelRejected, webAppRejected, panelStop, webAppStop]);

    expect(unpair).toHaveBeenCalledOnce();
    expect(secondPanelLease.releases).toBe(1);
    expect(secondWebAppLease.releases).toBe(1);
    expect(firstPanelLease.releases).toBe(0);
    expect(firstWebAppLease.releases).toBe(0);
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: firstWebRequest.workspaceId,
        pluginId: firstWebRequest.pluginId,
        webAppId: firstWebRequest.webAppId,
        instanceKey: firstWebRequest.instanceKey,
        senderId: firstWebRequest.senderId,
        generation: firstWebRequest.generation,
        zoomFactor: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: true,
      }),
    ).toBe(true);
    expect(() =>
      surfaces.authorizePanelSdk({
        workspaceId: panelRequest.workspaceId,
        pluginId: panelRequest.pluginId,
        panelId: panelRequest.panelId,
        senderId: panelRequest.senderId,
        currentGeneration: () => panelRequest.generation,
        activeWorkspaceId: () => panelRequest.workspaceId,
        liveSpawnId: () => "spawn-1",
      }),
    ).not.toThrow();
    await surfaces.close();
  });

  it("rejects an exact owner stop when only another owner's pending attempts exist", async () => {
    const panelGate = deferred<void>();
    const webAppGate = deferred<void>();
    const panelStart = deferred<void>();
    const webAppStart = deferred<void>();
    const surfaces = createSurfaces();
    const startingPanel = surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: lease(),
        previewGate: panelGate.promise,
        onPreviewStart: () => panelStart.resolve(),
      }),
    );
    const request = webRequest();
    const startingWebApp = surfaces.startWebApp(
      request,
      webAdmission({
        ownedLease: lease(),
        webAppGate: webAppGate.promise,
        onWebAppStart: () => webAppStart.resolve(),
      }),
    );
    await Promise.all([panelStart.promise, webAppStart.promise]);

    await expect(
      surfaces.stop({
        kind: "panel",
        workspaceId: panelRequest.workspaceId,
        pluginId: panelRequest.pluginId,
        panelId: panelRequest.panelId,
        owner: { senderId: panelRequest.senderId, generation: 2 },
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      surfaces.stop({
        kind: "web-app",
        workspaceId: request.workspaceId,
        pluginId: request.pluginId,
        webAppId: request.webAppId,
        instanceKey: request.instanceKey,
        owner: { senderId: request.senderId, generation: 2 },
      }),
    ).rejects.toThrow(/does not belong/);

    panelGate.resolve();
    webAppGate.resolve();
    await Promise.all([startingPanel, startingWebApp]);
    await surfaces.close();
  });

  it("skips unpair after a spawn change but still cleans up the exact failed attempt", async () => {
    FakeView.created = [];
    let spawnId = "spawn-a";
    const notifications: string[] = [];
    const unpair = vi.fn(async () => undefined);
    const failedLease = lease();
    const surfaces = createSurfaces({ notifications });
    const request = webRequest();
    const admission = webAdmission({
      ownedLease: failedLease,
      spawn: () => spawnId,
      unpair,
    });
    await surfaces.startWebApp(request, admission);

    FakeView.created[0]!.load.reject(new Error("load failed"));
    spawnId = "spawn-b";
    await turns();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: lease(), spawn: () => spawnId }),
    );

    expect(notifications).toEqual(["plugin"]);
    expect(unpair).not.toHaveBeenCalled();
    expect(failedLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
  });

  it("continues exact recovery when failure notification throws", async () => {
    FakeView.created = [];
    const reported: unknown[] = [];
    const unpair = vi.fn(async () => undefined);
    const failedLease = lease();
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: () => Promise.resolve(),
      notifyWebAppFailed: () => {
        throw new Error("renderer gone");
      },
      notifyPanelInvalidated: () => undefined,
      onError: (error) => reported.push(error),
    });
    const request = webRequest();
    const admission = webAdmission({ ownedLease: failedLease, unpair });
    await surfaces.startWebApp(request, admission);
    FakeView.created[0]!.load.reject(new Error("load failed"));
    await turns();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: lease(), attempt: "replacement" }),
    );

    expect(unpair).toHaveBeenCalledOnce();
    expect(failedLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(reported).toEqual([new Error("renderer gone")]);
  });

  it("notifies once when a host change overtakes queued recovery", async () => {
    FakeView.created = [];
    const notifications: string[] = [];
    const failedLease = lease();
    const surfaces = createSurfaces({ notifications });
    await surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: failedLease, attempt: "failed" }),
    );

    FakeView.created[0]!.load.reject(new Error("load failed"));
    await Promise.resolve();
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });

    expect(notifications).toEqual(["plugin"]);
    await turns();
    expect(notifications).toEqual(["plugin"]);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(failedLease.releases).toBe(1);
  });
});

describe("PluginSurfaces panel authority", () => {
  function authorizeExact(
    surfaces: PluginSurfaces<FakeView>,
    request: PluginPanelStartRequest,
    current: {
      generation: number;
      workspaceId: string | undefined;
      spawnId: string | undefined;
    },
  ) {
    return surfaces.authorizePanelSdk({
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      panelId: request.panelId,
      senderId: request.senderId,
      currentGeneration: () => current.generation,
      activeWorkspaceId: () => current.workspaceId,
      liveSpawnId: () => current.spawnId,
    });
  }

  function authorize(
    surfaces: PluginSurfaces<FakeView>,
    current: {
      generation: number;
      workspaceId: string | undefined;
      spawnId: string | undefined;
    },
  ) {
    return authorizeExact(surfaces, panelRequest, current);
  }

  it("revokes SDK grants synchronously without destroying surfaces before action success", async () => {
    FakeView.created = [];
    const disposedSurfaceIds: number[] = [];
    const surfaces = createSurfaces({ disposedSurfaceIds });
    const panelLease = lease();
    const webAppLease = lease();
    const stopPanel = vi.fn(async () => undefined);
    const request = webRequest();
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: panelLease, previewStop: stopPanel }),
    );
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: webAppLease, attempt: "pre-stop" }),
    );
    const active = authorize(surfaces, {
      generation: 1,
      workspaceId: "ws",
      spawnId: "spawn-1",
    });

    surfaces.revokePluginSdkGrants({ workspaceId: "ws", pluginId: "plugin" });

    expect(active.authority.signal.aborted).toBe(true);
    expect(active.isPushLive()).toBe(false);
    expect(stopPanel).not.toHaveBeenCalled();
    expect(panelLease.releases).toBe(0);
    expect(webAppIsLive(surfaces, request)).toBe(true);
    expect(FakeView.created[0]!.closed).toBe(0);
    expect(webAppLease.releases).toBe(0);

    await surfaces.stop({
      kind: "plugin",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    await surfaces.stop({
      kind: "plugin",
      workspaceId: "ws",
      pluginId: "plugin",
    });

    expect(stopPanel).toHaveBeenCalledTimes(1);
    expect(panelLease.releases).toBe(1);
    expect(FakeView.created[0]!.closed).toBe(1);
    expect(webAppLease.releases).toBe(1);
    expect(disposedSurfaceIds).toHaveLength(1);
  });

  it("restores same-spawn panel SDK authority after a failed disable", async () => {
    const surfaces = createSurfaces();
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    const beforeDisable = authorize(surfaces, current);

    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      await Promise.resolve();
      suspend({ workspaceId: "ws", pluginId: "plugin" });
      expect(beforeDisable.authority.signal.aborted).toBe(true);
      return { ok: false };
    });

    const restored = authorize(surfaces, current);
    expect(restored.authority.signal).not.toBe(beforeDisable.authority.signal);
    expect(restored.isPushLive()).toBe(true);
  });

  it("keeps existing panel watch liveness across a failed host stop", async () => {
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    const existingWatchAuthority = authorize(surfaces, current);

    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      suspend({ workspaceId: "ws", pluginId: "plugin" });
      expect(existingWatchAuthority.isPushLive()).toBe(false);
      expect(disposedPanelIds).toEqual([]);
      return { ok: false };
    });

    expect(existingWatchAuthority.isPushLive()).toBe(true);
    expect(disposedPanelIds).toEqual([]);
  });

  it("failed suspension retires only the replaced panel's watches", async () => {
    const events = new PluginWorkspaceEvents();
    const disposedSurfaceIds: number[] = [];
    const oldEvents: string[] = [];
    const successorEvents: string[] = [];
    const surfaces = createSurfaces({
      disposedSurfaceIds,
      workspaceEvents: events,
    });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    const old = authorize(surfaces, current);
    const oldOwner = {
      kind: "panel" as const,
      workspaceId: "ws",
      pluginId: "plugin",
      panelId: "panel",
      surfaceId: old.surfaceId,
    };
    const oldSubscription = events.subscribe(
      {
        owner: oldOwner,
        emitEvent: () => {
          if (old.isPushLive()) oldEvents.push("change");
        },
      },
      { path: "docs" },
    );

    let successor!: ReturnType<typeof authorize>;
    let successorOwner!: typeof oldOwner;
    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      suspend({ workspaceId: "ws", pluginId: "plugin" });
      await surfaces.startPanel(
        panelRequest,
        panelAdmission({ ownedLease: lease() }),
      );
      successor = authorize(surfaces, current);
      successorOwner = { ...oldOwner, surfaceId: successor.surfaceId };
      events.subscribe(
        {
          owner: successorOwner,
          emitEvent: () => {
            if (successor.isPushLive()) successorEvents.push("change");
          },
        },
        { path: "docs" },
      );
      return { ok: false };
    });

    expect(successor.surfaceId).not.toBe(old.surfaceId);
    expect(disposedSurfaceIds).toEqual([old.surfaceId]);
    expect(old.isPushLive()).toBe(false);
    expect(successor.isPushLive()).toBe(true);
    expect(
      events.unsubscribe(
        { owner: oldOwner },
        { subscriptionId: oldSubscription.subscriptionId },
      ),
    ).toBe(false);
    events.handleWatcherEvents([
      { path: "docs/after.md", operation: "update", sha256: "next" },
    ]);
    expect(oldEvents).toEqual([]);
    expect(successorEvents).toEqual(["change"]);
  });

  it("restores every still-live alias and primary suspension after a failed uninstall", async () => {
    const surfaces = createSurfaces();
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    const primary = { ...panelRequest, panelId: "primary-panel" };
    const alias = {
      ...panelRequest,
      pluginId: "plugin-alias",
      panelId: "alias-panel",
    };
    await surfaces.startPanel(
      primary,
      panelAdmission({ ownedLease: lease() }),
    );
    await surfaces.startPanel(
      alias,
      panelAdmission({ ownedLease: lease() }),
    );
    const primaryBefore = authorizeExact(surfaces, primary, current);
    const aliasBefore = authorizeExact(surfaces, alias, current);
    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      for (const request of [primary, alias]) {
        suspend({
          workspaceId: request.workspaceId,
          pluginId: request.pluginId,
        });
      }
      expect(primaryBefore.authority.signal.aborted).toBe(true);
      expect(aliasBefore.authority.signal.aborted).toBe(true);
      return { ok: false };
    });

    expect(authorizeExact(surfaces, primary, current).isPushLive()).toBe(true);
    expect(authorizeExact(surfaces, alias, current).isPushLive()).toBe(true);
  });

  it("finalizes an earlier alias stop while restoring a later failed alias", async () => {
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    const stopped = { ...panelRequest, panelId: "stopped-panel" };
    const retained = {
      ...panelRequest,
      pluginId: "plugin-alias",
      panelId: "retained-panel",
    };
    await surfaces.startPanel(
      stopped,
      panelAdmission({ ownedLease: lease() }),
    );
    await surfaces.startPanel(
      retained,
      panelAdmission({ ownedLease: lease() }),
    );
    const retainedWatchAuthority = authorizeExact(surfaces, retained, current);

    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      suspend({ workspaceId: "ws", pluginId: stopped.pluginId });
      await surfaces.stop({
        kind: "plugin",
        workspaceId: "ws",
        pluginId: stopped.pluginId,
      });
      suspend({ workspaceId: "ws", pluginId: retained.pluginId });
      return { ok: false };
    });

    expect(disposedPanelIds).toEqual(["stopped-panel"]);
    expect(retainedWatchAuthority.isPushLive()).toBe(true);
    expect(() => authorizeExact(surfaces, stopped, current)).toThrow();
    expect(authorizeExact(surfaces, retained, current).isPushLive()).toBe(true);
  });

  it.each(["changed", "absent"] as const)(
    "does not restore a tentative grant when the captured spawn is %s",
    async (change) => {
      let currentSpawnId: string | undefined = "spawn-1";
      const surfaces = createSurfaces();
      await surfaces.startPanel(
        panelRequest,
        panelAdmission({
          ownedLease: lease(),
          spawn: () => currentSpawnId ?? "missing",
        }),
      );
      await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
        suspend({ workspaceId: "ws", pluginId: "plugin" });
        currentSpawnId = change === "changed" ? "spawn-2" : undefined;
        return { ok: false };
      });

      expect(() =>
        authorize(surfaces, {
          generation: 1,
          workspaceId: "ws",
          spawnId: currentSpawnId,
        })
      ).toThrow();
    },
  );

  it("does not restore a tentative grant after a successful stop", async () => {
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      suspend({ workspaceId: "ws", pluginId: "plugin" });
      await surfaces.stop({
        kind: "plugin",
        workspaceId: "ws",
        pluginId: "plugin",
      });
      return { ok: true };
    });

    expect(() =>
      authorize(surfaces, {
        generation: 1,
        workspaceId: "ws",
        spawnId: "spawn-1",
      })
    ).toThrow();
    expect(disposedPanelIds).toEqual(["panel"]);
  });

  it("restores tentative grants before rethrowing an action failure", async () => {
    const failure = new Error("disable failed");
    const surfaces = createSurfaces();
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    await expect(
      surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
        suspend({ workspaceId: "ws", pluginId: "plugin" });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(authorize(surfaces, current).isPushLive()).toBe(true);
  });

  it("does not revoke any grant when the suspension snapshot cannot be captured", async () => {
    const failure = new Error("spawn snapshot failed");
    let throwOnSecondSpawnRead = false;
    const surfaces = createSurfaces();
    const first = { ...panelRequest, panelId: "first-panel" };
    const second = { ...panelRequest, panelId: "second-panel" };
    await surfaces.startPanel(
      first,
      panelAdmission({ ownedLease: lease() }),
    );
    await surfaces.startPanel(
      second,
      panelAdmission({
        ownedLease: lease(),
        spawn: () => {
          if (throwOnSecondSpawnRead) throw failure;
          return "spawn-1";
        },
      }),
    );
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    const firstBefore = authorizeExact(surfaces, first, current);
    const secondBefore = authorizeExact(surfaces, second, current);
    throwOnSecondSpawnRead = true;

    await expect(
      surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
        suspend({ workspaceId: "ws", pluginId: "plugin" });
        return { ok: false };
      }),
    ).rejects.toBe(failure);

    expect(firstBefore.authority.signal.aborted).toBe(false);
    expect(secondBefore.authority.signal.aborted).toBe(false);
  });

  it("reports tentative restore errors without rejecting restoration", async () => {
    const failure = new Error("spawn read failed");
    const errors: unknown[] = [];
    let throwOnSpawnRead = false;
    const surfaces = createSurfaces({ errors });
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: lease(),
        spawn: () => {
          if (throwOnSpawnRead) throw failure;
          return "spawn-1";
        },
      }),
    );
    const result = await surfaces.withPluginSdkGrantSuspensions(
      async (suspend) => {
        suspend({ workspaceId: "ws", pluginId: "plugin" });
        throwOnSpawnRead = true;
        return { ok: false };
      },
    );

    expect(result.ok).toBe(false);
    expect(errors).toEqual([failure]);
  });

  it("does not restore a grant that was already aborted", async () => {
    const surfaces = createSurfaces();
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    surfaces.revokePluginSdkGrants({ workspaceId: "ws", pluginId: "plugin" });

    await surfaces.withPluginSdkGrantSuspensions(async (suspend) => {
      suspend({ workspaceId: "ws", pluginId: "plugin" });
      return { ok: false };
    });

    expect(() =>
      authorize(surfaces, {
        generation: 1,
        workspaceId: "ws",
        spawnId: "spawn-1",
      })
    ).toThrow();
  });

  it("regrants only the retained exact panel after terminal then ready", async () => {
    FakeView.created = [];
    const disposedPanelIds: string[] = [];
    const invalidatedSurfaceIds: number[] = [];
    const surfaces = createSurfaces({ disposedPanelIds, invalidatedSurfaceIds });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: lease(),
        spawn: () => current.spawnId ?? "missing",
        url: "http://127.0.0.1:4100/a",
      }),
    );
    const first = authorize(surfaces, current);

    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: lease(),
        spawn: () => current.spawnId ?? "missing",
        url: "http://127.0.0.1:4101/b",
      }),
    );
    const second = authorize(surfaces, current);
    expect(first.authority.signal.aborted).toBe(true);
    expect(first.isPushLive()).toBe(false);
    expect(second.isPushLive()).toBe(true);
    await surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: lease(), attempt: "replace-runtime" }),
    );

    current.spawnId = "spawn-2";
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    expect(second.authority.signal.aborted).toBe(true);
    expect(second.isPushLive()).toBe(false);
    expect(invalidatedSurfaceIds).toEqual([]);
    await turns();
    expect(FakeView.created[0]!.closed).toBe(1);
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "stale-spawn",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    await turns();
    expect(() => authorize(surfaces, current)).toThrow();
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    await turns();

    const third = authorize(surfaces, current);
    expect(third.authority.spawnId).toBe("spawn-2");
    expect(third.isPushLive()).toBe(true);
    expect(first.isPushLive()).toBe(false);
    expect(second.isPushLive()).toBe(true);
    expect(disposedPanelIds).toEqual(["panel"]);
    expect(invalidatedSurfaceIds).toEqual([]);
  });

  it("keeps one panel watch across a same-record crash respawn", async () => {
    const events = new PluginWorkspaceEvents();
    const invalidatedSurfaceIds: number[] = [];
    const disposedSurfaceIds: number[] = [];
    const surfaces = createSurfaces({
      workspaceEvents: events,
      invalidatedSurfaceIds,
      disposedSurfaceIds,
    });
    const replacementHostRecord = {} as PluginHostRecordToken;
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
      hostRecord: defaultHostRecord as PluginHostRecordToken,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: lease({ record: () => current.hostRecord }),
        spawn: () => current.spawnId ?? "missing",
      }),
    );
    const watch = authorize(surfaces, current);
    const owner = {
      kind: "panel" as const,
      workspaceId: "ws",
      pluginId: "plugin",
      panelId: "panel",
      surfaceId: watch.surfaceId,
    };
    const received: Array<{ subscriptionId: string; path: string }> = [];
    const subscription = events.subscribe(
      {
        owner,
        emitEvent: (subscriptionId, _event, data) => {
          if (!watch.isPushLive()) return;
          received.push({
            subscriptionId,
            path: (data as { path: string }).path,
          });
        },
      },
      { path: "docs" },
    );

    current.spawnId = undefined;
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    events.handleWatcherEvents([
      { path: "docs/while-down.md", operation: "update", sha256: "down" },
    ]);
    expect(received).toEqual([]);

    current.spawnId = "spawn-2";
    await surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    events.handleWatcherEvents([
      { path: "docs/after-ready.md", operation: "update", sha256: "ready" },
    ]);
    expect(received).toEqual([{
      subscriptionId: subscription.subscriptionId,
      path: "docs/after-ready.md",
    }]);

    current.spawnId = undefined;
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    current.spawnId = "spawn-3";
    current.hostRecord = replacementHostRecord;
    await surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-3",
      hostRecord: replacementHostRecord,
      declaredPanels,
    });
    events.handleWatcherEvents([
      { path: "docs/after-replacement.md", operation: "update", sha256: "next" },
    ]);

    expect(invalidatedSurfaceIds).toEqual([watch.surfaceId]);
    expect(disposedSurfaceIds).toEqual([watch.surfaceId]);
    expect(received).toHaveLength(1);
    expect(events.unsubscribe({ owner }, subscription)).toBe(false);
  });

  it.each([
    ["after its crash-loop disable is saved", false],
    ["when its crash-loop disable cannot be saved", true],
  ])("retires a retained panel %s", async (_description, rejectDisabledWrite) => {
    const scratch = await createTestScratch("dohc-plugin-surface-crash-loop-");
    const workspaceRoot = join(scratch, "workspace");
    const stateDir = join(scratch, "state");
    await mkdir(workspaceRoot);
    await mkdir(stateDir);

    const events = new PluginWorkspaceEvents();
    const disposedSurfaceIds: number[] = [];
    const surfaces = createSurfaces({
      workspaceEvents: events,
      disposedSurfaceIds,
    });
    const spawnCallbacks: Array<Parameters<PluginHostOptions["spawnTransport"]>[0]> = [];
    const statuses: PluginRuntimeStatus[] = [];
    const disabledWriteFailure = new Error("disabled state write failed");
    let lifecycle!: PluginSurfaceHostLifecycle;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: (callbacks) => {
        spawnCallbacks.push(callbacks);
        return {
          request: async <T,>(method: string) =>
            (method === PLUGIN_HOST_METHODS.activate
              ? { commands: [], drivers: [] }
              : {}) as T,
          notify: () => undefined,
          dispose: () => Promise.resolve(),
        };
      },
      routeSdkRequest: async () => ({}),
      ...(rejectDisabledWrite
        ? {
            mutatePluginRecord: () => Promise.reject(disabledWriteFailure),
          }
        : {}),
      onSpawnEnd: (pluginId) => {
        lifecycle.spawnEnded(pluginId);
        return Promise.resolve();
      },
      onRecoveryDisposition: (pluginId, disposition) => {
        lifecycle.recoveryDisposition(pluginId, disposition);
      },
      onStatusChange: (pluginId, status) => {
        lifecycle.statusChanged(pluginId, status);
      },
    });
    lifecycle = new PluginSurfaceHostLifecycle({
      workspaceId: "ws",
      host,
      surfaces,
      onRuntimeStatus: (_pluginId, status) => statuses.push(status),
      onError: (error) => {
        throw error;
      },
    });

    const ownedLease = lease({
      record: () => host.currentRecord("plugin"),
    });
    let previewStops = 0;
    try {
      await host.start("C:/plugin", "plugin", {
        version: 1,
        name: "plugin",
        entry: "index.js",
        panels: declaredPanels,
      });
      await vi.waitFor(() => expect(host.getStatus("plugin")).toBe("ready"));
      await surfaces.startPanel(
        panelRequest,
        panelAdmission({
          ownedLease,
          spawn: () => host.getSpawnId("plugin") ?? "missing",
          previewStop: async () => {
            previewStops += 1;
          },
        }),
      );
      const watch = surfaces.authorizePanelSdk({
        workspaceId: "ws",
        pluginId: "plugin",
        panelId: "panel",
        senderId: 7,
        currentGeneration: () => 1,
        activeWorkspaceId: () => "ws",
        liveSpawnId: () => host.getSpawnId("plugin"),
      });
      const owner = {
        kind: "panel" as const,
        workspaceId: "ws",
        pluginId: "plugin",
        panelId: "panel",
        surfaceId: watch.surfaceId,
      };
      const initialHostRecord = host.currentRecord("plugin");
      expect(initialHostRecord).toBeDefined();
      const received: Array<{ subscriptionId: string; path: string }> = [];
      const subscription = events.subscribe(
        {
          owner,
          emitEvent: (subscriptionId, _event, data) => {
            if (!watch.isPushLive()) return;
            received.push({
              subscriptionId,
              path: (data as { path: string }).path,
            });
          },
        },
        { path: "docs" },
      );

      for (let crash = 0; crash < 2; crash += 1) {
        spawnCallbacks[crash]!.onExit({ code: 1, signal: null });
        expect(watch.isPushLive()).toBe(false);
        events.handleWatcherEvents([{
          path: `docs/down-${crash}.md`,
          operation: "update",
          sha256: `down-${crash}`,
        }]);
        await vi.waitFor(() => expect(spawnCallbacks).toHaveLength(crash + 2));
        await vi.waitFor(() => expect(host.getStatus("plugin")).toBe("ready"));
        await vi.waitFor(() => expect(watch.isPushLive()).toBe(true));
        expect(host.currentRecord("plugin")).toBe(initialHostRecord);
        events.handleWatcherEvents([{
          path: `docs/ready-${crash}.md`,
          operation: "update",
          sha256: `ready-${crash}`,
        }]);
      }

      expect(received).toEqual([
        {
          subscriptionId: subscription.subscriptionId,
          path: "docs/ready-0.md",
        },
        {
          subscriptionId: subscription.subscriptionId,
          path: "docs/ready-1.md",
        },
      ]);
      expect(disposedSurfaceIds).toEqual([]);
      expect(ownedLease.releases).toBe(0);
      expect(previewStops).toBe(0);

      spawnCallbacks[2]!.onExit({ code: 1, signal: null });
      expect(watch.isPushLive()).toBe(false);
      if (rejectDisabledWrite) {
        await vi.waitFor(() => expect(host.getStderrLog("plugin")).toContain(
          `Could not save disabled state: ${disabledWriteFailure.message}`,
        ));
        expect(host.getStatus("plugin")).toBe("crashed");
        expect(statuses).not.toContain("disabled");
      } else {
        await vi.waitFor(() => expect(host.getStatus("plugin")).toBe("disabled"));
      }
      await vi.waitFor(() => expect(disposedSurfaceIds).toEqual([watch.surfaceId]));

      expect(ownedLease.releases).toBe(1);
      expect(previewStops).toBe(1);
      expect(events.unsubscribe({ owner }, subscription)).toBe(false);
      expect(spawnCallbacks).toHaveLength(3);
      expect(statuses.at(-1)).toBe(rejectDisabledWrite ? "crashed" : "disabled");
      expect(statuses.filter((status) => status === "ready")).toHaveLength(3);
      const localState = await readPluginLocalState(stateDir, workspaceRoot);
      if (!localState.ok) throw new Error(localState.warning);
      expect(localState.state.plugins.plugin?.disabled).toBe(
        rejectDisabledWrite ? undefined : true,
      );
    } finally {
      await host.stopAll();
      await surfaces.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("reports a rejected terminal-surface stop", async () => {
    const failure = new Error("surface cleanup failed");
    const onError = vi.fn();
    const lifecycle = new PluginSurfaceHostLifecycle({
      workspaceId: "ws",
      host: {
        currentRecord: () => defaultHostRecord,
        getStatus: () => "crashed",
        getSpawnId: () => undefined,
        readyPanelsForSpawn: () => undefined,
      },
      surfaces: {
        hostChanged: () => undefined,
        hostReady: () => Promise.resolve(),
        stop: () => Promise.reject(failure),
      },
      onRuntimeStatus: () => undefined,
      onError,
    });

    lifecycle.spawnEnded("plugin");
    lifecycle.recoveryDisposition("plugin", {
      kind: "terminal",
      record: defaultHostRecord,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith(
      failure,
      'stop retained surfaces for terminal plugin "plugin"',
    );
  });

  it("ignores stale and duplicate terminal recovery outcomes", async () => {
    const stop = vi.fn(() => Promise.resolve());
    let currentRecord = defaultHostRecord;
    const lifecycle = new PluginSurfaceHostLifecycle({
      workspaceId: "ws",
      host: {
        currentRecord: () => currentRecord,
        getStatus: () => "crashed",
        getSpawnId: () => undefined,
        readyPanelsForSpawn: () => undefined,
      },
      surfaces: {
        hostChanged: () => undefined,
        hostReady: () => Promise.resolve(),
        stop,
      },
      onRuntimeStatus: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
    const staleRecord = {} as PluginHostRecordToken;

    lifecycle.spawnEnded("plugin");
    lifecycle.recoveryDisposition("plugin", {
      kind: "terminal",
      record: staleRecord,
    });
    currentRecord = staleRecord;
    lifecycle.recoveryDisposition("plugin", {
      kind: "terminal",
      record: defaultHostRecord,
    });
    currentRecord = defaultHostRecord;
    lifecycle.spawnEnded("plugin");
    lifecycle.recoveryDisposition("plugin", {
      kind: "terminal",
      record: defaultHostRecord,
    });
    lifecycle.recoveryDisposition("plugin", {
      kind: "terminal",
      record: defaultHostRecord,
    });

    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["removed", []],
    [
      "moved",
      [{
        id: "panel",
        title: "Panel",
        placement: "view" as const,
        entry: "panel/index.html",
      }],
    ],
    [
      "entry changed",
      [{
        id: "panel",
        title: "Panel",
        placement: "editor" as const,
        entry: "other/index.html",
      }],
    ],
  ] as const)(
    "disposes a retained panel whose declaration was %s before host ready",
    async (_case, currentDeclarations) => {
      const current = {
        generation: 1,
        workspaceId: "ws" as string | undefined,
        spawnId: "spawn-1" as string | undefined,
      };
      const ownedLease = lease();
      const stopPreview = vi.fn(async () => undefined);
      const invalidatedSurfaceIds: number[] = [];
      const surfaces = createSurfaces({ invalidatedSurfaceIds });
      const started = await surfaces.startPanel(
        panelRequest,
        panelAdmission({
          ownedLease,
          spawn: () => current.spawnId ?? "missing",
          previewStop: stopPreview,
        }),
      );
      current.spawnId = "spawn-2";

      surfaces.hostChanged({
        kind: "terminal",
        workspaceId: "ws",
        pluginId: "plugin",
      });
      await surfaces.hostReady({
        workspaceId: "ws",
        pluginId: "plugin",
        spawnId: "spawn-2",
        hostRecord: defaultHostRecord,
        declaredPanels: currentDeclarations,
      });
      await turns();

      expect(stopPreview).toHaveBeenCalledOnce();
      expect(ownedLease.releases).toBe(1);
      expect(invalidatedSurfaceIds).toEqual([started.surfaceId]);
      expect(() => authorize(surfaces, current)).toThrow();
    },
  );

  it("disposes a retained panel when a new host record runs the same entry", async () => {
    const firstRecord = {} as PluginHostRecordToken;
    const replacementRecord = {} as PluginHostRecordToken;
    let currentRecord = firstRecord;
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    const ownedLease = lease({ record: () => currentRecord });
    const stopPreview = vi.fn(async () => undefined);
    const invalidatedSurfaceIds: number[] = [];
    const invalidationError = new Error("renderer disappeared");
    const errors: unknown[] = [];
    const surfaces = createSurfaces({
      errors,
      invalidatedSurfaceIds,
      invalidationError,
    });
    const started = await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease,
        spawn: () => current.spawnId ?? "missing",
        previewStop: stopPreview,
      }),
    );

    current.spawnId = "spawn-2";
    currentRecord = replacementRecord;
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    await surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: replacementRecord,
      declaredPanels,
    });
    await turns();

    expect(stopPreview).toHaveBeenCalledOnce();
    expect(ownedLease.releases).toBe(1);
    expect(invalidatedSurfaceIds).toEqual([started.surfaceId]);
    expect(errors).toEqual([invalidationError]);
    expect(() => authorize(surfaces, current)).toThrow();
  });

  it("does not let stale-declaration cleanup cancel an admitted moved successor", async () => {
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    const oldLease = lease();
    const successorLease = lease();
    const stopOldPreview = vi.fn(async () => undefined);
    const surfaces = createSurfaces();
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: oldLease,
        spawn: () => current.spawnId ?? "missing",
        previewStop: stopOldPreview,
      }),
    );
    current.spawnId = "spawn-2";
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });

    const successor = { ...panelRequest, placement: "view" as const };
    const successorStart = surfaces.startPanel(
      successor,
      panelAdmission({
        ownedLease: successorLease,
        spawn: () => current.spawnId ?? "missing",
        panel: { placement: "view" },
      }),
    );
    const ready = surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels: [
        {
          id: "panel",
          title: "Panel",
          placement: "view",
          entry: "panel/index.html",
        },
      ],
    });

    await expect(successorStart).resolves.toEqual({
      url: "http://127.0.0.1:4100/panel.html",
      title: "Panel",
      surfaceId: expect.any(Number),
    });
    await ready;

    expect(stopOldPreview).toHaveBeenCalledOnce();
    expect(oldLease.releases).toBe(1);
    expect(successorLease.releases).toBe(0);
    expect(authorizeExact(surfaces, successor, current).isPushLive()).toBe(true);
    await surfaces.close();
  });

  it("rejects an installed panel replacement overtaken by a host change", async () => {
    const releaseDisplaced = deferred<void>();
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    const firstLease = lease({ gate: releaseDisplaced.promise });
    const secondLease = lease();
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: firstLease,
        url: "http://127.0.0.1:4100/first",
      }),
    );
    const replacement = surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: secondLease,
        url: "http://127.0.0.1:4101/replacement",
      }),
    );
    while (firstLease.releases === 0) await Promise.resolve();
    expect(disposedPanelIds).toEqual(["panel"]);

    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: panelRequest.workspaceId,
      pluginId: panelRequest.pluginId,
    });
    const rejected = expect(replacement).rejects.toThrow(/restarted/);
    releaseDisplaced.resolve();
    await rejected;
    await turns();

    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(disposedPanelIds).toEqual(["panel", "panel"]);
    expect(() =>
      surfaces.authorizePanelSdk({
        workspaceId: panelRequest.workspaceId,
        pluginId: panelRequest.pluginId,
        panelId: panelRequest.panelId,
        senderId: panelRequest.senderId,
        currentGeneration: () => panelRequest.generation,
        activeWorkspaceId: () => panelRequest.workspaceId,
        liveSpawnId: () => "spawn-2",
      }),
    ).toThrow();
  });

  it.each(["sender", "plugin", "panel", "all"] as const)(
    "revokes %s authority before gated panel cleanup settles",
    async (kind) => {
      const stopPreview = deferred<void>();
      const ownedLease = lease();
      const disposedSurfaceIds: number[] = [];
      const surfaces = createSurfaces({ disposedSurfaceIds });
      await surfaces.startPanel(
        panelRequest,
        panelAdmission({
          ownedLease,
          previewStop: () => stopPreview.promise,
        }),
      );
      const active = authorize(surfaces, {
        generation: 1,
        workspaceId: "ws",
        spawnId: "spawn-1",
      });

      const stopping = kind === "sender"
        ? surfaces.stop({ kind, senderId: 7 })
        : kind === "plugin"
          ? surfaces.stop({
              kind,
              workspaceId: "ws",
              pluginId: "plugin",
            })
          : kind === "panel"
            ? surfaces.stop({
                kind,
                ...panelRequest,
                owner: { senderId: 7, generation: 1 },
              })
            : surfaces.close();
      expect(active.authority.signal.aborted).toBe(true);
      let settled = false;
      void stopping.then(() => {
        settled = true;
      });
      await turns();
      expect(settled).toBe(false);
      expect(ownedLease.releases).toBe(0);
      expect(disposedSurfaceIds).toEqual([active.surfaceId]);
      stopPreview.resolve();
      await stopping;
      expect(ownedLease.releases).toBe(1);
      expect(disposedSurfaceIds).toEqual([active.surfaceId]);
    },
  );

  it("revokes terminal authority synchronously, stops web apps, and leaves the panel mounted", async () => {
    FakeView.created = [];
    const releaseWebApp = deferred<void>();
    const surfaces = createSurfaces();
    const stopPanel = vi.fn(async () => undefined);
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease(), previewStop: stopPanel }),
    );
    const active = authorize(surfaces, {
      generation: 1,
      workspaceId: "ws",
      spawnId: "spawn-1",
    });
    const request = webRequest();
    const webAppLease = lease({ gate: releaseWebApp.promise });
    await surfaces.startWebApp(
      request,
      webAdmission({
        ownedLease: webAppLease,
        attempt: "terminal",
      }),
    );

    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    expect(active.authority.signal.aborted).toBe(true);
    expect(FakeView.created[0]!.closed).toBe(0);
    await turns();
    expect(FakeView.created[0]!.closed).toBe(1);
    releaseWebApp.resolve();
    await turns();
    expect(webAppLease.releases).toBe(1);
    expect(stopPanel).not.toHaveBeenCalled();

    await expect(
      surfaces.startPanel(
        panelRequest,
        panelAdmission({ ownedLease: lease() }),
      ),
    ).resolves.toEqual({
      url: "http://127.0.0.1:4100/panel.html",
      title: "Panel",
      surfaceId: expect.any(Number),
    });
  });

  it("does not regrant a ready event queued before permanent close", async () => {
    const stopPreview = deferred<void>();
    const ownedLease = lease();
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease,
        spawn: () => current.spawnId ?? "missing",
        previewStop: () => stopPreview.promise,
      }),
    );
    const original = authorize(surfaces, current);
    current.spawnId = "spawn-2";

    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    const closing = surfaces.close();
    await Promise.resolve();

    expect(original.isPushLive()).toBe(false);
    expect(() => authorize(surfaces, current)).toThrow();
    stopPreview.resolve();
    await closing;
    expect(ownedLease.releases).toBe(1);
    expect(disposedPanelIds).toEqual(["panel"]);

    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    await turns();
    expect(() => authorize(surfaces, current)).toThrow();
  });

  it("does not regrant a ready event superseded by a later terminal change", async () => {
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease: lease(),
        spawn: () => current.spawnId ?? "missing",
      }),
    );
    const original = authorize(surfaces, current);
    current.spawnId = "spawn-2";

    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-2",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    await turns();

    expect(original.isPushLive()).toBe(false);
    expect(() => authorize(surfaces, current)).toThrow();
    expect(disposedPanelIds).toEqual([]);
    await surfaces.close();
    expect(disposedPanelIds).toEqual(["panel"]);
  });

  it("leaves successor surfaces live when ready follows their post-terminal start", async () => {
    FakeView.created = [];
    const disposedPanelIds: string[] = [];
    const surfaces = createSurfaces({ disposedPanelIds });
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease(), url: "http://127.0.0.1:4100/old" }),
    );
    const oldGrant = authorize(surfaces, {
      generation: 1,
      workspaceId: "ws",
      spawnId: "spawn-1",
    });
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    expect(oldGrant.authority.signal.aborted).toBe(true);

    const successorPanel = {
      ...panelRequest,
      generation: 2,
    };
    const previewGate = deferred<void>();
    const previewEntered = deferred<void>();
    const successorPanelStart = surfaces.startPanel(
      successorPanel,
      panelAdmission({
        ownedLease: lease(),
        previewGate: previewGate.promise,
        onPreviewStart: () => previewEntered.resolve(),
        url: "http://127.0.0.1:4101/new",
      }),
    );
    await previewEntered.promise;
    const successorWebApp = { ...webRequest(), generation: 2 };
    await surfaces.startWebApp(
      successorWebApp,
      webAdmission({ ownedLease: lease(), attempt: "successor" }),
    );
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-1",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    surfaces.hostReady({
      workspaceId: "ws",
      pluginId: "plugin",
      spawnId: "spawn-1",
      hostRecord: defaultHostRecord,
      declaredPanels,
    });
    previewGate.resolve();
    await expect(successorPanelStart).resolves.toEqual({
      url: "http://127.0.0.1:4101/new",
      title: "Panel",
      surfaceId: expect.any(Number),
    });
    const successorGrant = authorize(surfaces, {
      generation: 2,
      workspaceId: "ws",
      spawnId: "spawn-1",
    });
    await turns();

    expect(successorGrant.authority.signal.aborted).toBe(false);
    expect(successorGrant.isPushLive()).toBe(true);
    expect(disposedPanelIds).toEqual(["panel"]);
    expect(webAppIsLive(surfaces, successorWebApp)).toBe(true);
    await surfaces.close();
  });
});

describe("PluginSurfaces view operations", () => {
  it("binds zoom to the exact guest web contents once", async () => {
    FakeView.created = [];
    const boundWebContents: FakeView["webContents"][] = [];
    const surfaces = createSurfaces({ boundWebContents });

    await surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: lease() }),
    );

    expect(boundWebContents).toEqual([FakeView.created[0]!.webContents]);
    await surfaces.close();
  });

  it("guards bounds by exact owner and applies zoom only to live views", async () => {
    FakeView.created = [];
    const surfaces = createSurfaces();
    const request = webRequest();
    await surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: lease() }),
    );

    const mismatches = [
      { workspaceId: "other-workspace" },
      { pluginId: "other-plugin" },
      { webAppId: "other-app" },
      { instanceKey: "other-instance" },
      { senderId: 8 },
      { generation: 2 },
    ];
    for (const mismatch of mismatches) {
      expect(
        surfaces.applyWebAppBounds({
          ...request,
          ...mismatch,
          zoomFactor: 2,
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          visible: true,
        }),
      ).toBe(false);
    }
    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 7,
        generation: 1,
        zoomFactor: 2,
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        visible: true,
      }),
    ).toBe(true);
    surfaces.applyWebAppZoom(3);
    expect(FakeView.created[0]!.bounds).toEqual([
      { x: 2, y: 4, width: 6, height: 8 },
    ]);
    expect(FakeView.created[0]!.zoom).toEqual([0, 3]);

    await surfaces.close();
    surfaces.applyWebAppZoom(4);
    expect(FakeView.created[0]!.zoom).toEqual([0, 3]);
  });

  it.each([
    ["workspace", { workspaceId: "other-workspace" }],
    ["plugin", { pluginId: "other-plugin" }],
    ["web app", { webAppId: "other-app" }],
  ] as const)(
    "keeps the instance budget separate across %s identity",
    async (_dimension, otherGroup) => {
      FakeView.created = [];
      const surfaces = createSurfaces();
      const assertBudget = (count: number) =>
        assertInstanceBudget("plugin", "app", count);
      for (let index = 0; index < 20; index += 1) {
        await surfaces.startWebApp(
          {
            ...webRequest(),
            ...otherGroup,
            instanceKey: `other-${index}`,
          },
          webAdmission({ ownedLease: lease(), assertBudget }),
        );
      }

      await expect(
        surfaces.startWebApp(
          { ...webRequest(), instanceKey: "target" },
          webAdmission({ ownedLease: lease(), assertBudget }),
        ),
      ).resolves.toMatchObject({ origin: "http://127.0.0.1:4000" });
      await surfaces.close();
    },
  );

  it.each([
    [
      "workspace",
      { kind: "workspace", workspaceId: "target-workspace" },
      { workspaceId: "target-workspace", pluginId: "plugin", senderId: 7 },
      { workspaceId: "other-workspace", pluginId: "plugin", senderId: 7 },
    ],
    [
      "plugin",
      { kind: "plugin", workspaceId: "workspace", pluginId: "target-plugin" },
      { workspaceId: "workspace", pluginId: "target-plugin", senderId: 7 },
      { workspaceId: "workspace", pluginId: "other-plugin", senderId: 7 },
    ],
    [
      "sender",
      { kind: "sender", senderId: 7 },
      { workspaceId: "workspace", pluginId: "plugin", senderId: 7 },
      { workspaceId: "workspace", pluginId: "plugin", senderId: 8 },
    ],
  ] satisfies Array<
    [string, PluginSurfaceStopTarget, TestSurfaceScope, TestSurfaceScope]
  >)(
    "keeps a %s stop inside its exact scope",
    async (_kind, target, matchedScope, survivorScope) => {
      FakeView.created = [];
      const disposedPanelIds: string[] = [];
      const surfaces = createSurfaces({ disposedPanelIds });
      const matched = await startSurfacePair(surfaces, matchedScope, "matched");
      const survivor = await startSurfacePair(
        surfaces,
        survivorScope,
        "survivor",
      );

      await surfaces.stop(target);

      expect(panelIsLive(surfaces, matched.panel)).toBe(false);
      expect(webAppIsLive(surfaces, matched.webApp)).toBe(false);
      expect(panelIsLive(surfaces, survivor.panel)).toBe(true);
      expect(webAppIsLive(surfaces, survivor.webApp)).toBe(true);
      expect(disposedPanelIds).toEqual([matched.panel.panelId]);
      await surfaces.close();
      expect(disposedPanelIds).toEqual([
        matched.panel.panelId,
        survivor.panel.panelId,
      ]);
    },
  );

  it("disposes a stopped secondary alias panel and lease without touching the primary", async () => {
    const surfaces = createSurfaces();
    const primaryLease = lease();
    const aliasLease = lease();
    const stopPrimary = vi.fn(async () => undefined);
    const stopAlias = vi.fn(async () => undefined);
    const primary = {
      ...panelRequest,
      pluginId: "primary-plugin",
      panelId: "primary-panel",
    };
    const alias = {
      ...panelRequest,
      pluginId: "secondary-alias",
      panelId: "alias-panel",
    };
    await surfaces.startPanel(
      primary,
      panelAdmission({ ownedLease: primaryLease, previewStop: stopPrimary }),
    );
    await surfaces.startPanel(
      alias,
      panelAdmission({ ownedLease: aliasLease, previewStop: stopAlias }),
    );

    await surfaces.stop({
      kind: "plugin",
      workspaceId: alias.workspaceId,
      pluginId: alias.pluginId,
    });

    expect(stopAlias).toHaveBeenCalledOnce();
    expect(aliasLease.releases).toBe(1);
    expect(panelIsLive(surfaces, alias)).toBe(false);
    expect(stopPrimary).not.toHaveBeenCalled();
    expect(primaryLease.releases).toBe(0);
    expect(panelIsLive(surfaces, primary)).toBe(true);
    await surfaces.close();
  });

  it("notifies and disposes every stopped web app when one notification throws", async () => {
    FakeView.created = [];
    const notifications: Array<string | null> = [];
    const errors: unknown[] = [];
    const firstLease = lease();
    const secondLease = lease();
    const failure = new Error("first renderer disappeared");
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: () => Promise.resolve(),
      notifyWebAppFailed: ({ instanceKey }) => {
        notifications.push(instanceKey);
        if (instanceKey === "first") throw failure;
      },
      notifyPanelInvalidated: () => undefined,
      onError: (error) => errors.push(error),
    });
    await surfaces.startWebApp(
      { ...webRequest(), instanceKey: "first" },
      webAdmission({ ownedLease: firstLease, attempt: "first" }),
    );
    await surfaces.startWebApp(
      { ...webRequest(), instanceKey: "second" },
      webAdmission({ ownedLease: secondLease, attempt: "second" }),
    );

    await surfaces.stop({
      kind: "plugin",
      workspaceId: "ws",
      pluginId: "plugin",
    });

    expect(notifications).toEqual(["first", "second"]);
    expect(errors).toEqual([failure]);
    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(FakeView.created.map((view) => view.closed)).toEqual([1, 1]);
  });

  it("owns and clears the hardened guest partition", async () => {
    FakeView.created = [];
    const cleared: string[] = [];
    const notifications: string[] = [];
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: async (partition) => {
        cleared.push(partition);
      },
      notifyWebAppFailed: ({ pluginId }) => notifications.push(pluginId),
      notifyPanelInvalidated: () => undefined,
      onError: () => undefined,
    });
    await surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: lease() }),
    );
    await surfaces.stop({
      kind: "plugin",
      workspaceId: "ws",
      pluginId: "plugin",
      clearPartition: { workspaceRoot: "C:/ws" },
    });

    expect(notifications).toEqual(["plugin"]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/^persist:dohc-plugin-/);
  });

  it("holds later starts outside a plugin stop until partition clearing settles", async () => {
    FakeView.created = [];
    const clear = deferred<void>();
    const steps: string[] = [];
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: async () => {
        steps.push("clear");
        await clear.promise;
      },
      notifyWebAppFailed: () => undefined,
      notifyPanelInvalidated: () => undefined,
      onError: () => undefined,
    });
    await surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: lease(), attempt: "old", steps }),
    );
    const stopping = surfaces.stop({
      kind: "plugin",
      workspaceId: "ws",
      pluginId: "plugin",
      clearPartition: { workspaceRoot: "C:/ws" },
    });
    const later = surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: lease(), attempt: "later", steps }),
    );

    while (!steps.includes("clear")) await Promise.resolve();
    expect(steps).not.toContain("host:later");
    clear.resolve();
    await Promise.all([stopping, later]);
    expect(steps.indexOf("host:later")).toBeGreaterThan(steps.indexOf("clear"));
  });

  it("chains an empty plugin stop behind its predecessor exclusion", async () => {
    FakeView.created = [];
    const firstClear = deferred<void>();
    const steps: string[] = [];
    let clearCount = 0;
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: async () => {
        clearCount += 1;
        steps.push(`clear:${clearCount}`);
        if (clearCount === 1) await firstClear.promise;
      },
      notifyWebAppFailed: () => undefined,
      notifyPanelInvalidated: () => undefined,
      onError: () => undefined,
    });
    const target = {
      kind: "plugin" as const,
      workspaceId: "ws",
      pluginId: "plugin",
      clearPartition: { workspaceRoot: "C:/ws" },
    };
    const firstStop = surfaces.stop(target);
    while (!steps.includes("clear:1")) await Promise.resolve();

    let secondSettled = false;
    const secondStop = surfaces.stop(target).then(() => {
      secondSettled = true;
    });
    await turns();
    expect(steps).toEqual(["clear:1"]);
    expect(secondSettled).toBe(false);

    const later = surfaces.startWebApp(
      webRequest(),
      webAdmission({ ownedLease: lease(), attempt: "later", steps }),
    );
    await turns();
    expect(steps).not.toContain("host:later");

    firstClear.resolve();
    await Promise.all([firstStop, secondStop, later]);
    expect(steps).toEqual(["clear:1", "clear:2", "host:later"]);
    await surfaces.close();
  });

  it("does not finish close while a partition clear is still owned", async () => {
    const clear = deferred<void>();
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: () => clear.promise,
      notifyWebAppFailed: () => undefined,
      notifyPanelInvalidated: () => undefined,
      onError: () => undefined,
    });
    const stopping = surfaces.stop({
      kind: "plugin",
      workspaceId: "ws",
      pluginId: "plugin",
      clearPartition: { workspaceRoot: "C:/ws" },
    });
    let closed = false;
    const closing = surfaces.close().then(() => {
      closed = true;
    });

    await turns();
    expect(closed).toBe(false);
    clear.resolve();
    await Promise.all([stopping, closing]);
    expect(closed).toBe(true);
  });

  it("closes permanently after draining every accepted attempt", async () => {
    const surfaces = createSurfaces();
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    const firstClose = surfaces.close();
    expect(surfaces.close()).toBe(firstClose);
    await firstClose;

    expect(() =>
      surfaces.startPanel(
        panelRequest,
        panelAdmission({ ownedLease: lease() }),
      ),
    ).toThrow("Plugin surfaces are closed.");
    await expect(
      surfaces.startWebApp(
        webRequest(),
        webAdmission({ ownedLease: lease() }),
      ),
    ).rejects.toThrow("Plugin surfaces are closed.");
  });
});
