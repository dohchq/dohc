import { describe, expect, it, vi } from "vitest";
import { assertInstanceBudget } from "./pluginWebAppInstances";
import {
  PluginSurfaces,
  type PluginPanelStartAdmission,
  type PluginSurfaceHostLease,
  type PluginWebAppStartAdmission,
  type PluginWebAppContainer,
  type PluginWebAppViewLike,
} from "./pluginSurfaces";

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

function lease(options: {
  steps?: string[];
  label?: string;
  gate?: Promise<void>;
} = {}): PluginSurfaceHostLease & { releases: number } {
  return {
    releases: 0,
    start: async () => "spawn-1",
    currentSpawnId: () => "spawn-1",
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
  assertBudget?: (liveAndReservedOtherInstances: number) => void;
}): PluginWebAppStartAdmission {
  const spawn = input.spawn ?? (() => "spawn-1");
  const attempt = input.attempt ?? "attempt";
  return {
    assertInstanceBudget: input.assertBudget ?? (() => undefined),
    assertAllowed: () => undefined,
    acquireHostLease: async () => ({
      start: async () => {
        await input.startGate;
        input.steps?.push(`host:${attempt}`);
        return input.startHost ? input.startHost() : spawn();
      },
      currentSpawnId: spawn,
      release: () => input.ownedLease.release(),
    }),
    startWebApp: async () => {
      input.onWebAppStart?.();
      await input.webAppGate;
      return {
        url: `http://127.0.0.1:4000/pair#${attempt}`,
        title: attempt,
      };
    },
    unpair: async () => {
      input.steps?.push(`unpair:${attempt}`);
      await input.unpairGate;
    },
  };
}

function createSurfaces(options: {
  notifications?: string[];
  errors?: unknown[];
  revoked?: string[];
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
    onPanelAuthorityRevoked: ({ panelId }) => options.revoked?.push(panelId),
    onError: (error) => options.errors?.push(error),
  });
}

const panelRequest = {
  workspaceId: "ws",
  pluginId: "plugin",
  panelId: "panel",
  senderId: 7,
  generation: 1,
};

function panelAdmission(input: {
  ownedLease: PluginSurfaceHostLease;
  spawn?: () => string;
  startGate?: Promise<void>;
  previewGate?: Promise<void>;
  onPreviewStart?: () => void;
  previewStop?: () => Promise<void>;
  url?: string;
}): PluginPanelStartAdmission {
  const spawn = input.spawn ?? (() => "spawn-1");
  return {
    assertAllowed: () => undefined,
    acquireHostLease: async () => ({
      start: async () => {
        await input.startGate;
        return spawn();
      },
      currentSpawnId: spawn,
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

describe("PluginSurfaces web app attempt ownership", () => {
  it("ignores a rejected load from an attempt closed before the same identity reopened", async () => {
    FakeView.created = [];
    const notifications: string[] = [];
    const unpairs: string[] = [];
    let currentSpawn = "spawn-1";
    const surfaces = new PluginSurfaces<FakeView>({
      ViewClass: FakeView,
      bindWebAppZoom: (webContents) => webContents.setZoomLevel(0),
      allowPanelOrigin: () => () => undefined,
      clearPanelStorage: () => Promise.resolve(),
      clearGuestPartition: () => Promise.resolve(),
      notifyWebAppFailed: ({ pluginId }) => notifications.push(pluginId),
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
        release: () => ownedLease.release(),
      }),
      startWebApp: async () => ({
        url: `http://127.0.0.1:4000/pair#${attempt}`,
        title: attempt,
      }),
      unpair: async () => {
        unpairs.push(attempt);
      },
    });

    await surfaces.startWebApp(target, admission(firstLease, "a"));
    const firstView = FakeView.created[0]!;
    await surfaces.stop({
      kind: "web-app",
      workspaceId: target.workspaceId,
      pluginId: target.pluginId,
      webAppId: target.webAppId,
      instanceKey: target.instanceKey,
      owner: { senderId: 7, generation: 1 },
    });
    currentSpawn = "spawn-2";
    await surfaces.startWebApp(target, admission(secondLease, "b"));

    firstView.load.reject(new Error("late load failure"));
    await turns();

    expect(notifications).toEqual([]);
    expect(unpairs).toEqual([]);
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
    const admission = webAdmission({ ownedLease, attempt: "pending" });
    admission.unpair = unpair;

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
    const admission = webAdmission({ ownedLease, attempt: "setup-failure" });
    const unpair = vi.fn(async () => {
      unpaired.resolve();
    });
    admission.unpair = unpair;

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

    let replacementSettled = false;
    const replacementCreated = deferred<void>();
    FakeView.onNextCreate = () => replacementCreated.resolve();
    const replacement = surfaces
      .startWebApp(
        request,
        webAdmission({ ownedLease: secondLease, attempt: "b" }),
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
    const replacement = surfaces.startWebApp(
      request,
      webAdmission({ ownedLease: secondLease, attempt: "replacement" }),
    );
    while (firstLease.releases === 0) await Promise.resolve();
    expect(FakeView.created).toHaveLength(2);
    expect(FakeView.created[1]!.closed).toBe(0);

    surfaces.hostChanged({
      kind: "runtime-replaced",
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
    });
    admission.unpair = unpair;
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
    const admission = webAdmission({
      ownedLease,
      webAppGate: credentialGate.promise,
      onWebAppStart: () => credentialEntered.resolve(),
    });
    const unpair = vi.fn(async () => {
      throw failure;
    });
    admission.unpair = unpair;
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
      const admission = webAdmission({
        ownedLease,
        spawn: () => spawnId,
        webAppGate: credentialGate.promise,
        onWebAppStart: () => credentialEntered.resolve(),
      });
      const unpair = vi.fn(async () => undefined);
      admission.unpair = unpair;
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
    const secondWebAdmission = webAdmission({
      ownedLease: secondWebAppLease,
      attempt: "second",
      webAppGate: credentialGate.promise,
      onWebAppStart: () => credentialEntered.resolve(),
    });
    const unpair = vi.fn(async () => undefined);
    secondWebAdmission.unpair = unpair;
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
    });
    admission.unpair = unpair;
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
      onError: (error) => reported.push(error),
    });
    const request = webRequest();
    const admission = webAdmission({ ownedLease: failedLease });
    admission.unpair = unpair;
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
  function authorize(
    surfaces: PluginSurfaces<FakeView>,
    current: {
      generation: number;
      workspaceId: string | undefined;
      spawnId: string | undefined;
    },
  ) {
    return surfaces.authorizePanelSdk({
      workspaceId: "ws",
      pluginId: "plugin",
      panelId: "panel",
      senderId: 7,
      currentGeneration: () => current.generation,
      activeWorkspaceId: () => current.workspaceId,
      liveSpawnId: () => current.spawnId,
    });
  }

  it("never revives a stale same-owner grant after replacement or regrant", async () => {
    FakeView.created = [];
    const surfaces = createSurfaces();
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease(), url: "http://127.0.0.1:4100/a" }),
    );
    const first = authorize(surfaces, current);

    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease(), url: "http://127.0.0.1:4101/b" }),
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
      kind: "runtime-replaced",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    expect(second.authority.signal.aborted).toBe(true);
    expect(second.isPushLive()).toBe(false);
    await turns();
    expect(FakeView.created[0]!.closed).toBe(1);

    const third = authorize(surfaces, current);
    expect(third.authority.spawnId).toBe("spawn-2");
    expect(third.isPushLive()).toBe(true);
    expect(first.isPushLive()).toBe(false);
    expect(second.isPushLive()).toBe(false);
  });

  it("rejects an installed panel replacement overtaken by a host change", async () => {
    const releaseDisplaced = deferred<void>();
    const revoked: string[] = [];
    const surfaces = createSurfaces({ revoked });
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
    expect(revoked).toEqual(["panel"]);

    surfaces.hostChanged({
      kind: "runtime-replaced",
      workspaceId: panelRequest.workspaceId,
      pluginId: panelRequest.pluginId,
    });
    const rejected = expect(replacement).rejects.toThrow(/restarted/);
    releaseDisplaced.resolve();
    await rejected;
    await turns();

    expect(firstLease.releases).toBe(1);
    expect(secondLease.releases).toBe(1);
    expect(revoked).toEqual(["panel", "panel"]);
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
      const surfaces = createSurfaces();
      await surfaces.startPanel(
        panelRequest,
        panelAdmission({
          ownedLease: lease(),
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
      stopPreview.resolve();
      await stopping;
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
    ).resolves.toEqual({ url: "http://127.0.0.1:4100/panel.html" });
  });

  it("does not regrant a runtime replacement queued before permanent close", async () => {
    const stopPreview = deferred<void>();
    const ownedLease = lease();
    const revoked: string[] = [];
    const surfaces = createSurfaces({ revoked });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({
        ownedLease,
        previewStop: () => stopPreview.promise,
      }),
    );
    const original = authorize(surfaces, current);
    current.spawnId = "spawn-2";

    surfaces.hostChanged({
      kind: "runtime-replaced",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    const closing = surfaces.close();
    await Promise.resolve();

    expect(original.isPushLive()).toBe(false);
    expect(() => authorize(surfaces, current)).toThrow();
    stopPreview.resolve();
    await closing;
    expect(ownedLease.releases).toBe(1);
    expect(revoked).toEqual(["panel"]);

    surfaces.hostChanged({
      kind: "runtime-replaced",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    await turns();
    expect(() => authorize(surfaces, current)).toThrow();
  });

  it("does not regrant a runtime replacement superseded by a terminal change", async () => {
    const revoked: string[] = [];
    const surfaces = createSurfaces({ revoked });
    const current = {
      generation: 1,
      workspaceId: "ws" as string | undefined,
      spawnId: "spawn-1" as string | undefined,
    };
    await surfaces.startPanel(
      panelRequest,
      panelAdmission({ ownedLease: lease() }),
    );
    const original = authorize(surfaces, current);
    current.spawnId = "spawn-2";

    surfaces.hostChanged({
      kind: "runtime-replaced",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    surfaces.hostChanged({
      kind: "terminal",
      workspaceId: "ws",
      pluginId: "plugin",
    });
    await turns();

    expect(original.isPushLive()).toBe(false);
    expect(() => authorize(surfaces, current)).toThrow();
    expect(revoked).toEqual(["panel"]);
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

    expect(
      surfaces.applyWebAppBounds({
        workspaceId: "ws",
        pluginId: "plugin",
        webAppId: "app",
        instanceKey: null,
        senderId: 8,
        generation: 1,
        zoomFactor: 2,
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        visible: true,
      }),
    ).toBe(false);
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
