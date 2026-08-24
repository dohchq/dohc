import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import {
  createTrustedPluginIpcRegistrar,
  registerPluginIpcHandlers,
} from "./pluginIpcHandlers";

const directOperations = vi.hoisted(() => ({
  addOffer: vi.fn(),
  listOffers: vi.fn(),
  loadPanel: vi.fn(),
  loadWebApp: vi.fn(),
  removeOffer: vi.fn(),
}));

vi.mock("../plugins/pluginPanelRegistration", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../plugins/pluginPanelRegistration")
  >()),
  loadPluginPanelRegistration: directOperations.loadPanel,
  loadPluginWebAppRegistration: directOperations.loadWebApp,
}));

vi.mock("../plugins/pluginOffers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/pluginOffers")>()),
  addOfferedPlugin: directOperations.addOffer,
  listOfferedPlugins: directOperations.listOffers,
  removeAddedOfferedPlugin: directOperations.removeOffer,
}));

const pluginStatus = {
  id: "example-plugin",
  directoryName: "example-plugin",
  rootPath: "C:\\workspace\\plugins\\example-plugin",
  valid: true,
  status: "ready",
  disabledReason: null,
  runtimeStatus: "ready",
  sourceHash: "a".repeat(64),
  approvedHash: "a".repeat(64),
  installedBaselineHash: "a".repeat(64),
  displayName: "Example plugin",
  description: null,
  publisher: null,
  icon: null,
  pluginVersion: null,
  repository: null,
  issues: null,
  license: null,
  settings: [],
  hasFailedReplacement: false,
  panels: [{ id: "panel", title: "Panel", placement: "editor", icon: null }],
  commands: [{ id: "run", title: "Run" }],
  webApps: [{ id: "app", title: "Manifest title", instanced: false }],
  diagnostics: [],
  warnings: [],
  error: null,
} as const;

const manifest = {
  version: 1,
  name: "example-plugin",
  entry: "src/index.ts",
  panels: [
    {
      id: "panel",
      title: "Panel",
      entry: "panels/index.html",
      placement: "editor",
    },
  ],
  commands: [{ id: "run", title: "Run" }],
  webApps: [{ id: "app", title: "Manifest title", instanced: false }],
  settings: [],
};

const registration = {
  pluginRoot: "C:\\workspace\\plugins\\example-plugin",
  directoryName: "example-plugin",
  manifest,
};

const actionFailure = {
  ok: false,
  error: {
    stage: "state",
    code: "refused",
    message: "The action was refused.",
  },
  plugin: null,
} as const;

const pluginChannels = [
  CHANNELS.openPluginPanel,
  CHANNELS.startPluginPanel,
  CHANNELS.invokePluginCommand,
  CHANNELS.stopPluginPanel,
  CHANNELS.invokePluginPanelSdk,
  CHANNELS.openPluginWebApp,
  CHANNELS.startPluginWebApp,
  CHANNELS.setPluginWebAppBounds,
  CHANNELS.stopPluginWebApp,
  CHANNELS.listPlugins,
  CHANNELS.listOfferedPlugins,
  CHANNELS.addOfferedPlugin,
  CHANNELS.installPlugin,
  CHANNELS.disablePlugin,
  CHANNELS.enablePlugin,
  CHANNELS.approvePlugin,
  CHANNELS.rebuildPlugin,
  CHANNELS.pluginUninstallPreflight,
  CHANNELS.pluginSizes,
  CHANNELS.getPluginSettings,
  CHANNELS.setPluginSettings,
  CHANNELS.uninstallPlugin,
] as const;

const basePanelPayload = {
  workspaceId: "workspace-1",
  pluginId: "example-plugin",
  panelId: "panel",
};
const baseWebAppPayload = {
  workspaceId: "workspace-1",
  pluginId: "example-plugin",
  webAppId: "app",
  instanceKey: null,
};
const baseActionPayload = {
  workspaceId: "workspace-1",
  pluginId: "example-plugin",
};

const validPayloads: Record<string, unknown> = {
  [CHANNELS.openPluginPanel]: {
    ...basePanelPayload,
    pluginRoot: registration.pluginRoot,
  },
  [CHANNELS.startPluginPanel]: {
    ...basePanelPayload,
    placement: "editor",
  },
  [CHANNELS.invokePluginCommand]: {
    ...baseActionPayload,
    commandId: "run",
  },
  [CHANNELS.stopPluginPanel]: basePanelPayload,
  [CHANNELS.invokePluginPanelSdk]: {
    ...basePanelPayload,
    method: "files.read",
    params: { path: "README.md" },
  },
  [CHANNELS.openPluginWebApp]: {
    ...baseWebAppPayload,
    pluginRoot: registration.pluginRoot,
  },
  [CHANNELS.startPluginWebApp]: baseWebAppPayload,
  [CHANNELS.setPluginWebAppBounds]: {
    ...baseWebAppPayload,
    bounds: { x: 1, y: 2, width: 300, height: 200 },
    visible: true,
  },
  [CHANNELS.stopPluginWebApp]: baseWebAppPayload,
  [CHANNELS.listPlugins]: { workspaceId: "workspace-1" },
  [CHANNELS.listOfferedPlugins]: { workspaceId: "workspace-1" },
  [CHANNELS.addOfferedPlugin]: {
    workspaceId: "workspace-1",
    directoryName: "codex",
  },
  [CHANNELS.installPlugin]: baseActionPayload,
  [CHANNELS.disablePlugin]: baseActionPayload,
  [CHANNELS.enablePlugin]: baseActionPayload,
  [CHANNELS.approvePlugin]: baseActionPayload,
  [CHANNELS.rebuildPlugin]: baseActionPayload,
  [CHANNELS.pluginUninstallPreflight]: {
    ...baseActionPayload,
    directoryName: "example-plugin",
  },
  [CHANNELS.pluginSizes]: {
    ...baseActionPayload,
    directoryName: "example-plugin",
  },
  [CHANNELS.getPluginSettings]: {
    ...baseActionPayload,
    directoryName: "example-plugin",
  },
  [CHANNELS.setPluginSettings]: {
    ...baseActionPayload,
    directoryName: "example-plugin",
    values: {},
  },
  [CHANNELS.uninstallPlugin]: {
    ...baseActionPayload,
    directoryName: "example-plugin",
    confirmationToken: "00000000-0000-4000-8000-000000000000",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness() {
  const log: string[] = [];
  const state = {
    trusted: true,
    writable: true,
    generation: 3,
  };
  const workspace = {
    workspaceId: "workspace-1",
    rootPath: "C:\\workspace",
  };
  const sender = {
    id: 41,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getZoomFactor: vi.fn(() => 1.25),
  };
  const event = { sender };
  const handlers = new Map<
    string,
    (capturedEvent: typeof event, payload: unknown) => unknown | Promise<unknown>
  >();
  const activeWorkspaceIdBySender = new Map([[sender.id, workspace.workspaceId]]);

  const host = {
    activationOf: vi.fn(async () => undefined),
    currentRecord: vi.fn(() => ({ id: "host-record" })),
    getSpawnId: vi.fn(() => "spawn-1"),
    invokeCommand: vi.fn(async () => undefined),
  };
  const commandAuthority = {
    start: vi.fn(async (enqueue: () => Promise<{ value: unknown }>) => ({
      kind: "admitted",
      value: (await enqueue()).value,
    })),
  };
  const pipeline = {
    approve: vi.fn(async () => {
      log.push("approve");
      return { ok: true, plugin: pluginStatus };
    }),
    disable: vi.fn(async (_pluginId: string, hooks?: { onWillStopRuntime?: () => void }) => {
      log.push("disable");
      hooks?.onWillStopRuntime?.();
      log.push("disable-result");
      return { ok: true, plugin: pluginStatus };
    }),
    enable: vi.fn(async () => {
      log.push("enable");
      return { ok: true, plugin: pluginStatus };
    }),
    ensureStarted: vi.fn(async () => ({
      kind: "existing",
      value: { ok: true, plugin: pluginStatus },
    })),
    findDirectorySupersededBy: vi.fn(() => null),
    getPluginSettings: vi.fn(async () => ({})),
    handleWatcherEvents: vi.fn(async () => undefined),
    host,
    hostOwnership: {
      runCommand: vi.fn(async (_pluginId: string, operation: (authority: unknown) => Promise<unknown>) => ({
        kind: "completed",
        value: await operation(commandAuthority),
      })),
    },
    install: vi.fn(async () => {
      log.push("install");
      return { ok: true, plugin: pluginStatus };
    }),
    list: vi.fn(() => [pluginStatus]),
    pluginRegistration: vi.fn(() => registration),
    rebuild: vi.fn(async () => {
      log.push("rebuild");
      return { ok: true, plugin: pluginStatus };
    }),
    setPluginSettings: vi.fn(async () => ({})),
    sizes: vi.fn(async () => ({ installedBytes: 1, dataBytes: 2 })),
    uninstall: vi.fn(
      async (
        _pluginId: string,
        _directoryName: string,
        _confirmationToken: string,
        hooks?: { onWillStopRuntime?: (pluginId: string) => void },
      ) => {
        log.push("uninstall");
        hooks?.onWillStopRuntime?.("example-plugin");
        log.push("uninstall-result");
        return { ok: true, plugin: pluginStatus, identity: "released" };
      },
    ),
    uninstallPreflight: vi.fn(async () => ({
      ok: false,
      error: actionFailure.error,
    })),
  };
  const pipelines = new Map([[workspace.workspaceId, pipeline]]);
  const registrations = new Map([
    [workspace.workspaceId, new Map([[pluginStatus.id, registration]])],
  ]);

  let panelAdmission: { assertAllowed(): void; acquireHostLease(): Promise<unknown> } | null = null;
  let webAppAdmission: { assertAllowed(): void; acquireHostLease(): Promise<unknown> } | null = null;
  const surfaces = {
    applyWebAppBounds: vi.fn((request) => {
      log.push("bounds");
      return request.workspaceId === workspace.workspaceId;
    }),
    authorizePanelSdk: vi.fn((request) => {
      log.push("authorize-sdk");
      return {
        authority: {
          senderId: request.senderId,
          generation: request.currentGeneration(),
          workspaceId: request.workspaceId,
          pluginId: request.pluginId,
          panelId: request.panelId,
          spawnId: request.liveSpawnId(),
          signal: new AbortController().signal,
        },
        surfaceId: 9,
        isPushLive: () => true,
      };
    }),
    startPanel: vi.fn(async (_request, admission) => {
      log.push("start-panel");
      panelAdmission = admission;
      return {
        url: "http://127.0.0.1:43111/",
        title: "Panel",
        surfaceId: 9,
      };
    }),
    startWebApp: vi.fn(async (_request, admission) => {
      log.push("start-web-app");
      webAppAdmission = admission;
      return { origin: "http://127.0.0.1:43112/" };
    }),
    stop: vi.fn(async (target) => {
      log.push(target.clearPartition ? "stop-partition" : "stop-surface");
    }),
    withPluginSdkGrantSuspensions: vi.fn(async (run) => {
      const result = await run((identity: { pluginId: string }) => {
        log.push(`suspend:${identity.pluginId}`);
      });
      log.push(result.ok ? "commit-suspensions" : "restore-suspensions");
      return result;
    }),
  };

  const platform = {
    builtinPluginsRoot: vi.fn(() => "C:\\desktop\\plugins"),
    createPanelHostLease: vi.fn(() => ({
      currentRecord: () => ({ id: "host-record" }),
      currentSpawnId: () => "spawn-1",
      release: async () => undefined,
      start: async () => "spawn-1",
      startPanel: async () => ({
        spawnId: "spawn-1",
        hostRecord: { id: "host-record" },
        panel: { id: "panel", title: "Panel", entry: "panels/index.html" },
      }),
    })),
    createWebAppContainer: vi.fn(() => ({
      attach: () => undefined,
      detach: () => undefined,
      isDestroyed: () => false,
    })),
    createWebAppHostLease: vi.fn(() => ({
      currentSpawnId: () => "spawn-1",
      release: async () => undefined,
      start: async () => "spawn-1",
      startWebApp: async () => ({ url: "http://127.0.0.1:43112/" }),
      unpair: async () => undefined,
    })),
    routePanelSdk: vi.fn(async () => {
      log.push("route-sdk");
      return { ok: true };
    }),
    startPanelPreview: vi.fn(async () => ({
      url: "http://127.0.0.1:43111/",
      stop: async () => undefined,
    })),
  };

  const requireWorkspace = vi.fn((workspaceId: string) => {
    log.push("require-workspace");
    if (workspaceId !== workspace.workspaceId) throw new Error("Unknown workspace");
    return workspace;
  });
  const assertWritable = vi.fn(() => {
    log.push("assert-writable");
    if (!state.writable) throw new Error("The workspace is read-only.");
  });
  const ensurePipeline = vi.fn(async () => {
    log.push("ensure-pipeline");
    return pipeline;
  });

  registerPluginIpcHandlers({
    registrar: createTrustedPluginIpcRegistrar(
      {
        handle: (
          channel: string,
          handler: (
            capturedEvent: typeof event,
            payload: unknown,
          ) => unknown | Promise<unknown>,
        ) => {
          if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
          handlers.set(channel, handler);
        },
      },
      () => {
        log.push("trust");
        if (!state.trusted) throw new Error("Untrusted sender");
      },
    ),
    workspaces: {
      activeWorkspaceIdBySender,
      assertWritable,
      require: requireWorkspace,
    },
    rendererGeneration: () => state.generation,
    pipelines,
    ensurePipeline,
    registrations,
    surfaces,
    platform,
  } as never);

  const invoke = async (channel: string, payload = validPayloads[channel]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler(event, payload);
  };

  return {
    activeWorkspaceIdBySender,
    assertWritable,
    ensurePipeline,
    event,
    handlers,
    invoke,
    log,
    pipeline,
    platform,
    registrations,
    requireWorkspace,
    sender,
    state,
    surfaces,
    get panelAdmission() {
      return panelAdmission;
    },
    get webAppAdmission() {
      return webAppAdmission;
    },
  };
}

beforeEach(() => {
  directOperations.loadPanel.mockReset().mockResolvedValue({
    pluginRoot: registration.pluginRoot,
    manifest,
    panel: manifest.panels[0],
  });
  directOperations.loadWebApp.mockReset().mockResolvedValue({
    pluginRoot: registration.pluginRoot,
    manifest,
    webApp: manifest.webApps[0],
  });
  directOperations.listOffers.mockReset().mockResolvedValue([]);
  directOperations.addOffer.mockReset().mockResolvedValue({
    identity: { kind: "added" },
    contentHash: "b".repeat(64),
  });
  directOperations.removeOffer.mockReset().mockResolvedValue(undefined);
});

describe("plugin IPC handlers", () => {
  it("registers the complete plugin control plane once", () => {
    const harness = createHarness();

    expect([...harness.handlers]).toHaveLength(22);
    expect([...harness.handlers.keys()]).toEqual(pluginChannels);
  });

  it("checks sender trust before parsing or effects on every channel", async () => {
    const harness = createHarness();
    harness.state.trusted = false;

    for (const channel of pluginChannels) {
      harness.log.length = 0;
      await expect(harness.invoke(channel)).rejects.toThrow("Untrusted sender");
      expect(harness.log, channel).toEqual(["trust"]);
    }
  });

  it("rejects malformed input after trust and before workspace lookup or effects", async () => {
    const harness = createHarness();

    for (const channel of pluginChannels) {
      harness.log.length = 0;
      await expect(harness.invoke(channel, null)).rejects.toThrow();
      expect(harness.log, channel).toEqual(["trust"]);
    }
  });

  it("gates writable actions before pipeline construction or effects", async () => {
    const harness = createHarness();
    harness.log.length = 0;

    await expect(harness.invoke(CHANNELS.installPlugin)).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.log).toEqual([
      "trust",
      "require-workspace",
      "assert-writable",
      "ensure-pipeline",
      "install",
    ]);

    harness.log.length = 0;
    harness.state.writable = false;
    await expect(harness.invoke(CHANNELS.listOfferedPlugins)).resolves.toMatchObject({
      ok: false,
    });
    expect(harness.log).toEqual([
      "trust",
      "require-workspace",
      "assert-writable",
    ]);
    expect(directOperations.listOffers).not.toHaveBeenCalled();
  });

  it.each([
    [CHANNELS.listOfferedPlugins, directOperations.listOffers],
    [CHANNELS.addOfferedPlugin, directOperations.addOffer],
  ] as const)(
    "revalidates write authority after pipeline startup for %s",
    async (channel, effect) => {
      const harness = createHarness();
      const pipelineReady = deferred<typeof harness.pipeline>();
      harness.ensurePipeline.mockReturnValueOnce(pipelineReady.promise);

      const request = harness.invoke(channel);
      await vi.waitFor(() => expect(harness.ensurePipeline).toHaveBeenCalledOnce());
      harness.state.writable = false;
      pipelineReady.resolve(harness.pipeline);

      await expect(request).resolves.toMatchObject({ ok: false });
      expect(harness.assertWritable).toHaveBeenCalledTimes(2);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("revalidates write authority after command pipeline startup", async () => {
    const harness = createHarness();
    const pipelineReady = deferred<typeof harness.pipeline>();
    harness.ensurePipeline.mockReturnValueOnce(pipelineReady.promise);

    const request = harness.invoke(CHANNELS.invokePluginCommand);
    await vi.waitFor(() => expect(harness.ensurePipeline).toHaveBeenCalledOnce());
    harness.state.writable = false;
    pipelineReady.resolve(harness.pipeline);

    await expect(request).rejects.toThrow("read-only");
    expect(harness.assertWritable).toHaveBeenCalledTimes(2);
    expect(harness.pipeline.hostOwnership.runCommand).not.toHaveBeenCalled();
  });

  it("uses readable active-workspace policy and exact owner identity for stops", async () => {
    const harness = createHarness();
    harness.state.writable = false;

    await harness.invoke(CHANNELS.stopPluginPanel);
    expect(harness.assertWritable).not.toHaveBeenCalled();
    expect(harness.surfaces.stop).toHaveBeenCalledWith({
      kind: "panel",
      workspaceId: "workspace-1",
      pluginId: "example-plugin",
      panelId: "panel",
      owner: { senderId: 41, generation: 3 },
    });

    harness.surfaces.stop.mockClear();
    harness.activeWorkspaceIdBySender.set(41, "workspace-2");
    await expect(harness.invoke(CHANNELS.stopPluginWebApp)).rejects.toThrow(
      "does not target the active workspace",
    );
    expect(harness.surfaces.stop).not.toHaveBeenCalled();
  });

  it("keeps bounds and panel SDK ownership distinct from workspace lookup", async () => {
    const harness = createHarness();
    harness.requireWorkspace.mockImplementation(() => {
      throw new Error("workspace lookup must not run");
    });

    await harness.invoke(CHANNELS.setPluginWebAppBounds);
    expect(harness.surfaces.applyWebAppBounds).toHaveBeenCalledWith({
      ...baseWebAppPayload,
      senderId: 41,
      generation: 3,
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      visible: true,
      zoomFactor: 1.25,
    });

    const result = await harness.invoke(CHANNELS.invokePluginPanelSdk);
    expect(result).toEqual({ result: { ok: true } });
    expect(harness.platform.routePanelSdk).toHaveBeenCalledOnce();
    expect(harness.requireWorkspace).not.toHaveBeenCalled();
    const authorizationRequest = harness.surfaces.authorizePanelSdk.mock.calls[0]?.[0];
    expect(authorizationRequest.currentGeneration()).toBe(3);
    expect(authorizationRequest.activeWorkspaceId()).toBe("workspace-1");
    expect(authorizationRequest.liveSpawnId()).toBe("spawn-1");
  });

  it("revalidates renderer and write authority before deferred panel effects", async () => {
    const harness = createHarness();
    await harness.invoke(CHANNELS.startPluginPanel);
    const admission = harness.panelAdmission;
    expect(admission).not.toBeNull();

    harness.ensurePipeline.mockClear();
    harness.state.generation += 1;
    expect(() => admission!.assertAllowed()).toThrow(
      "does not target the active workspace",
    );
    await expect(admission!.acquireHostLease()).rejects.toThrow(
      "does not target the active workspace",
    );
    expect(harness.ensurePipeline).not.toHaveBeenCalled();

    harness.state.generation -= 1;
    harness.state.writable = false;
    await expect(admission!.acquireHostLease()).rejects.toThrow("read-only");
    expect(harness.ensurePipeline).not.toHaveBeenCalled();
  });

  it("revalidates renderer and write authority before deferred web app effects", async () => {
    const harness = createHarness();
    await harness.invoke(CHANNELS.startPluginWebApp);
    const admission = harness.webAppAdmission;
    expect(admission).not.toBeNull();

    harness.ensurePipeline.mockClear();
    harness.activeWorkspaceIdBySender.set(41, "workspace-2");
    expect(() => admission!.assertAllowed()).toThrow(
      "does not target the active workspace",
    );
    await expect(admission!.acquireHostLease()).rejects.toThrow(
      "does not target the active workspace",
    );
    expect(harness.ensurePipeline).not.toHaveBeenCalled();
  });

  it("rechecks an open after its registration load settles", async () => {
    const harness = createHarness();
    const loaded = deferred<{
      pluginRoot: string;
      manifest: typeof manifest;
      panel: (typeof manifest.panels)[number];
    }>();
    directOperations.loadPanel.mockReturnValueOnce(loaded.promise);

    const opening = harness.invoke(CHANNELS.openPluginPanel);
    await vi.waitFor(() => expect(directOperations.loadPanel).toHaveBeenCalledOnce());
    harness.state.generation += 1;
    loaded.resolve({
      pluginRoot: registration.pluginRoot,
      manifest,
      panel: manifest.panels[0],
    });

    await expect(opening).rejects.toThrow("does not target the active workspace");
    expect(harness.ensurePipeline).not.toHaveBeenCalled();
  });

  it("loads and remembers panel and web app registrations from discovered identity", async () => {
    const harness = createHarness();
    harness.registrations.clear();

    await expect(harness.invoke(CHANNELS.openPluginPanel)).resolves.toEqual({
      pluginId: "example-plugin",
      panelId: "panel",
    });
    expect(directOperations.loadPanel).toHaveBeenCalledWith({
      workspaceRoot: "C:\\workspace",
      pluginRoot: registration.pluginRoot,
      pluginId: "example-plugin",
      panelId: "panel",
      pluginRegistration: harness.pipeline,
    });
    expect(harness.registrations.get("workspace-1")?.get("example-plugin"))
      .toMatchObject({ directoryName: "example-plugin" });

    await expect(harness.invoke(CHANNELS.openPluginWebApp)).resolves.toEqual({
      pluginId: "example-plugin",
      webAppId: "app",
      instanceKey: null,
    });
    expect(directOperations.loadWebApp).toHaveBeenCalledOnce();
  });

  it("passes exact panel and web app identity to their surface owner", async () => {
    const harness = createHarness();

    await expect(harness.invoke(CHANNELS.startPluginPanel)).resolves.toEqual({
      status: "ok",
      url: "http://127.0.0.1:43111/",
      title: "Panel",
      surfaceId: 9,
    });
    expect(harness.surfaces.startPanel.mock.calls[0]?.[0]).toEqual({
      ...basePanelPayload,
      placement: "editor",
      senderId: 41,
      generation: 3,
    });

    await expect(harness.invoke(CHANNELS.startPluginWebApp)).resolves.toEqual({
      status: "ok",
      title: "Manifest title",
      origin: "http://127.0.0.1:43112/",
    });
    expect(harness.surfaces.startWebApp.mock.calls[0]?.[0]).toMatchObject({
      ...baseWebAppPayload,
      senderId: 41,
      generation: 3,
      workspaceRoot: "C:\\workspace",
    });
    expect(harness.platform.createWebAppContainer).toHaveBeenCalledWith(
      harness.sender,
    );
  });

  it("routes commands through the pipeline's command ownership", async () => {
    const harness = createHarness();

    await expect(harness.invoke(CHANNELS.invokePluginCommand)).resolves.toEqual({
      status: "ok",
    });
    expect(harness.pipeline.hostOwnership.runCommand).toHaveBeenCalledWith(
      "example-plugin",
      expect.any(Function),
    );
    expect(harness.pipeline.host.invokeCommand).toHaveBeenCalledWith(
      "example-plugin",
      "run",
    );
  });

  it("leaves rebuild ownership with the pipeline lifecycle", async () => {
    const harness = createHarness();

    await expect(harness.invoke(CHANNELS.rebuildPlugin)).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.pipeline.rebuild).toHaveBeenCalledWith("example-plugin");
    expect(harness.surfaces.stop).not.toHaveBeenCalled();
  });

  it("keeps disable suspension ordering and restores a failed action", async () => {
    const harness = createHarness();

    await harness.invoke(CHANNELS.disablePlugin);
    expect(harness.log.slice(-4)).toEqual([
      "disable",
      "suspend:example-plugin",
      "disable-result",
      "commit-suspensions",
    ]);

    harness.log.length = 0;
    harness.pipeline.disable.mockImplementationOnce(async (_pluginId, hooks) => {
      logHook(harness.log, hooks?.onWillStopRuntime);
      return actionFailure as never;
    });
    await expect(harness.invoke(CHANNELS.disablePlugin)).resolves.toEqual(
      actionFailure,
    );
    expect(harness.log).toEqual([
      "trust",
      "require-workspace",
      "assert-writable",
      "ensure-pipeline",
      "disable",
      "suspend:example-plugin",
      "disable-result",
      "restore-suspensions",
    ]);
  });

  it("cleans released uninstall identity only after suspension commits", async () => {
    const harness = createHarness();
    harness.log.length = 0;

    const result = await harness.invoke(CHANNELS.uninstallPlugin);

    expect(result).toEqual({ ok: true, plugin: pluginStatus });
    expect(result).not.toHaveProperty("identity");
    expect(harness.log).toEqual([
      "trust",
      "require-workspace",
      "assert-writable",
      "ensure-pipeline",
      "uninstall",
      "suspend:example-plugin",
      "uninstall-result",
      "commit-suspensions",
      "stop-partition",
    ]);
    expect(harness.registrations.get("workspace-1")?.has("example-plugin"))
      .toBe(false);
  });

  it("preserves partition and registration for retained or failed uninstall", async () => {
    const retained = createHarness();
    retained.pipeline.uninstall.mockResolvedValueOnce({
      ok: true,
      plugin: pluginStatus,
      identity: "retained",
    });

    await retained.invoke(CHANNELS.uninstallPlugin);
    expect(retained.surfaces.stop).not.toHaveBeenCalled();
    expect(retained.registrations.get("workspace-1")?.has("example-plugin"))
      .toBe(true);

    const failed = createHarness();
    failed.pipeline.uninstall.mockImplementationOnce(async (_id, _directory, _token, hooks) => {
      logHook(failed.log, () => hooks?.onWillStopRuntime?.("example-plugin"));
      return actionFailure as never;
    });

    await expect(failed.invoke(CHANNELS.uninstallPlugin)).resolves.toEqual(
      actionFailure,
    );
    expect(failed.log).toContain("restore-suspensions");
    expect(failed.surfaces.stop).not.toHaveBeenCalled();
    expect(failed.registrations.get("workspace-1")?.has("example-plugin"))
      .toBe(true);
  });

  it("parses handler output before returning it", async () => {
    const harness = createHarness();
    harness.pipeline.install.mockResolvedValueOnce({ ok: true, plugin: {} } as never);

    const result = await harness.invoke(CHANNELS.installPlugin);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "pipeline-unavailable" },
      plugin: null,
    });
  });
});

function logHook(log: string[], hook: (() => void) | undefined): void {
  log.push("disable");
  hook?.();
  log.push("disable-result");
}
