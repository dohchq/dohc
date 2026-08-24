import type { WatcherEvent } from "@dohc/workspace-core";
import { join } from "node:path";
import {
  AddOfferedPluginPayload,
  AddOfferedPluginResult,
  GetPluginSettingsPayload,
  InvokePluginCommandPayload,
  InvokePluginCommandResult,
  InvokePluginPanelSdkPayload,
  InvokePluginPanelSdkResult,
  ListOfferedPluginsPayload,
  ListOfferedPluginsResult,
  ListPluginsPayload,
  ListPluginsResult,
  OpenPluginPanelPayload,
  OpenPluginPanelResult,
  OpenPluginWebAppPayload,
  OpenPluginWebAppResult,
  PluginActionPayload,
  PluginActionResult,
  PluginSettingsResult,
  PluginSizesPayload,
  PluginSizesResult,
  PluginUninstallPreflightPayload,
  PluginUninstallPreflightResult,
  SetPluginSettingsPayload,
  SetPluginWebAppBoundsPayload,
  StartPluginPanelPayload,
  StartPluginPanelResult,
  StartPluginWebAppPayload,
  StartPluginWebAppResult,
  StopPluginPanelPayload,
  StopPluginWebAppPayload,
  UninstallPluginPayload,
} from "./bridgeContract";
import {
  BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES,
  CHANNELS,
} from "./channels";
import { invokeRegisteredPluginCommand } from "../plugins/pluginCommandInvocation";
import type { PluginHostCommandAuthority } from "../plugins/pluginHostOwnership";
import { ensurePluginStarted } from "../plugins/pluginHostStart";
import {
  PluginPipeline,
  type PluginPipelineUninstallResult,
} from "../plugins/PluginPipeline";
import { readPluginManifestFile } from "../plugins/pluginManifest";
import type { PluginHostPanelDeclaration } from "../plugins/PluginHost";
import {
  forgetUninstalledPlugin,
  loadPluginPanelRegistration,
  loadPluginWebAppRegistration,
  rememberPluginRegistration,
  resolveRegisteredPlugin,
  type RegisteredPlugin,
} from "../plugins/pluginPanelRegistration";
import {
  addOfferedPlugin,
  listOfferedPlugins,
  removeAddedOfferedPlugin,
} from "../plugins/pluginOffers";
import {
  assertInstanceBudget,
  requireDeclaredWebApp,
} from "../plugins/pluginWebAppInstances";
import type {
  PluginPanelHostLease,
  PluginPanelSdkAuthorization,
  PluginPanelStartAdmission,
  PluginSurfaces,
  PluginWebAppContainer,
  PluginWebAppHostLease,
  PluginWebAppViewLike,
} from "../plugins/pluginSurfaces";

interface PluginIpcSender {
  readonly id: number;
  isDestroyed(): boolean;
  getZoomFactor(): number;
}

interface PluginIpcEvent<TSender extends PluginIpcSender> {
  readonly sender: TSender;
}

interface PluginIpcWorkspace {
  readonly workspaceId: string;
  readonly rootPath: string;
}

type PluginIpcHandler<TEvent> = (
  event: TEvent,
  payload: unknown,
) => unknown | Promise<unknown>;

interface PluginIpcRegistrar<TEvent> {
  handle(channel: string, handler: PluginIpcHandler<TEvent>): void;
}

const trustedPluginIpcRegistrarBrand: unique symbol = Symbol(
  "trustedPluginIpcRegistrar",
);

interface TrustedPluginIpcRegistrar<TEvent>
  extends PluginIpcRegistrar<TEvent> {
  readonly [trustedPluginIpcRegistrarBrand]: true;
}

export function createTrustedPluginIpcRegistrar<TEvent>(
  registrar: PluginIpcRegistrar<TEvent>,
  assertTrustedSender: (event: TEvent) => void,
): TrustedPluginIpcRegistrar<TEvent> {
  return {
    [trustedPluginIpcRegistrarBrand]: true,
    handle(channel, handler) {
      registrar.handle(channel, (event, payload) => {
        assertTrustedSender(event);
        return handler(event, payload);
      });
    },
  };
}

type PluginIpcSurfaces<TView extends PluginWebAppViewLike> = Pick<
  PluginSurfaces<TView>,
  | "applyWebAppBounds"
  | "authorizePanelSdk"
  | "startPanel"
  | "startWebApp"
  | "stop"
  | "withPluginSdkGrantSuspensions"
>;

interface PluginIpcPlatform<
  TSender extends PluginIpcSender,
  TWorkspace extends PluginIpcWorkspace,
  TView extends PluginWebAppViewLike,
> {
  builtinPluginsRoot(): string;
  createPanelHostLease(
    pipeline: PluginPipeline,
    pluginId: string,
  ): PluginPanelHostLease;
  createWebAppContainer(sender: TSender): PluginWebAppContainer<TView>;
  createWebAppHostLease(
    pipeline: PluginPipeline,
    pluginId: string,
    webAppId: string,
    instanceKey: string | null,
  ): PluginWebAppHostLease;
  routePanelSdk(input: {
    authorization: PluginPanelSdkAuthorization;
    method: string;
    params?: unknown;
  }): Promise<unknown>;
  startPanelPreview(input: {
    workspace: TWorkspace;
    pluginId: string;
    panel: PluginHostPanelDeclaration;
  }): ReturnType<PluginPanelStartAdmission["startPreview"]>;
}

interface RegisterPluginIpcHandlersOptions<
  TEvent extends PluginIpcEvent<TSender>,
  TSender extends PluginIpcSender,
  TWorkspace extends PluginIpcWorkspace,
  TView extends PluginWebAppViewLike,
> {
  registrar: TrustedPluginIpcRegistrar<TEvent>;
  workspaces: {
    activeWorkspaceIdBySender: ReadonlyMap<number, string>;
    assertWritable(workspace: TWorkspace): void;
    require(workspaceId: string): TWorkspace;
  };
  rendererGeneration(senderId: number): number;
  pipelines: ReadonlyMap<string, PluginPipeline>;
  ensurePipeline(workspace: TWorkspace): Promise<PluginPipeline>;
  registrations: Map<string, Map<string, RegisteredPlugin>>;
  surfaces: PluginIpcSurfaces<TView>;
  platform: PluginIpcPlatform<TSender, TWorkspace, TView>;
}

interface ActiveWorkspacePolicy<TWorkspace extends PluginIpcWorkspace> {
  readonly workspace: TWorkspace;
}

interface WritableActiveWorkspacePolicy<TWorkspace extends PluginIpcWorkspace>
  extends ActiveWorkspacePolicy<TWorkspace> {
  readonly generation: number;
  revalidate(message?: string): void;
}

const DEFAULT_INACTIVE_MESSAGE =
  "The plugin request does not target the active workspace. Open the workspace and try again.";
const CURRENT_RENDERER_MESSAGE =
  "The plugin panel request does not target the active workspace. Open the workspace and try again.";

function pluginIpcError(error: unknown) {
  return {
    stage: "state" as const,
    code: "pipeline-unavailable",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function registerPluginIpcHandlers<
  TSender extends PluginIpcSender,
  TEvent extends PluginIpcEvent<TSender>,
  TWorkspace extends PluginIpcWorkspace,
  TView extends PluginWebAppViewLike,
>(options: RegisterPluginIpcHandlersOptions<TEvent, TSender, TWorkspace, TView>): void {
  const {
    registrar,
    workspaces,
    rendererGeneration,
    pipelines,
    ensurePipeline,
    registrations,
    surfaces,
    platform,
  } = options;

  const createReadableActiveWorkspacePolicy = (
    event: TEvent,
    workspaceId: string,
    inactiveMessage = DEFAULT_INACTIVE_MESSAGE,
  ): ActiveWorkspacePolicy<TWorkspace> => {
    const workspace = workspaces.require(workspaceId);
    if (workspaces.activeWorkspaceIdBySender.get(event.sender.id) !== workspace.workspaceId) {
      throw new Error(inactiveMessage);
    }
    return { workspace };
  };

  const createWritableActiveWorkspacePolicy = (
    event: TEvent,
    workspaceId: string,
    settings: {
      inactiveMessage?: string;
      trackRenderer?: boolean;
    } = {},
  ): WritableActiveWorkspacePolicy<TWorkspace> => {
    const { workspace } = createReadableActiveWorkspacePolicy(
      event,
      workspaceId,
      settings.inactiveMessage,
    );
    const generation = rendererGeneration(event.sender.id);
    const revalidate = (message = settings.inactiveMessage ?? DEFAULT_INACTIVE_MESSAGE) => {
      if (
        workspaces.activeWorkspaceIdBySender.get(event.sender.id) !==
          workspace.workspaceId ||
        (settings.trackRenderer &&
          (event.sender.isDestroyed() ||
            rendererGeneration(event.sender.id) !== generation))
      ) {
        throw new Error(message);
      }
      workspaces.assertWritable(workspace);
    };
    revalidate();
    return { workspace, generation, revalidate };
  };

  const createExactSurfaceOwnershipPolicy = (
    event: TEvent,
    workspaceId: string,
    inactiveMessage: string,
  ) => {
    const { workspace } = createReadableActiveWorkspacePolicy(
      event,
      workspaceId,
      inactiveMessage,
    );
    return {
      workspace,
      owner: {
        senderId: event.sender.id,
        generation: rendererGeneration(event.sender.id),
      },
    };
  };

  const registeredPlugin = (
    workspaceId: string,
    pluginId: string,
  ): RegisteredPlugin | undefined =>
    resolveRegisteredPlugin(
      pluginId,
      pipelines.get(workspaceId),
      registrations.get(workspaceId),
    );

  const requireDiscoveredDirectoryName = (
    pipeline: PluginPipeline,
    pluginId: string,
  ): string => {
    const directoryName = pipeline.pluginRegistration(pluginId)?.directoryName;
    if (directoryName === undefined) {
      throw new Error(
        `Plugin "${pluginId}" is not currently discovered in this workspace.`,
      );
    }
    return directoryName;
  };

  const packagedBuiltinDisplayName = async (
    directoryName: string,
  ): Promise<string | null> => {
    if (
      !(BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES as readonly string[]).includes(
        directoryName,
      )
    ) {
      return null;
    }
    const manifest = await readPluginManifestFile(
      join(platform.builtinPluginsRoot(), directoryName),
    );
    return manifest.ok
      ? manifest.manifest.displayName ?? manifest.manifest.name
      : null;
  };

  const activePipeline = async (
    event: TEvent,
    workspaceId: string,
  ) => {
    const policy = createWritableActiveWorkspacePolicy(event, workspaceId);
    return {
      pipeline: await ensurePipeline(policy.workspace),
      workspace: policy.workspace,
    };
  };

  registrar.handle(CHANNELS.openPluginPanel, async (event, payload) => {
    const input = OpenPluginPanelPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(event, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
      trackRenderer: true,
    });
    const registration = await loadPluginPanelRegistration({
      workspaceRoot: policy.workspace.rootPath,
      pluginRoot: input.pluginRoot,
      pluginId: input.pluginId,
      panelId: input.panelId,
      pluginRegistration: pipelines.get(policy.workspace.workspaceId),
    });
    policy.revalidate(CURRENT_RENDERER_MESSAGE);
    const pipeline = await ensurePipeline(policy.workspace);
    policy.revalidate(CURRENT_RENDERER_MESSAGE);
    rememberPluginRegistration(
      registrations,
      policy.workspace.workspaceId,
      {
        ...registration,
        directoryName: requireDiscoveredDirectoryName(pipeline, input.pluginId),
      },
    );
    return OpenPluginPanelResult.parse({
      pluginId: input.pluginId,
      panelId: input.panelId,
    });
  });

  registrar.handle(CHANNELS.startPluginPanel, async (event, payload) => {
    const input = StartPluginPanelPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(event, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
      trackRenderer: true,
    });
    const currentPipeline = pipelines.get(policy.workspace.workspaceId);
    if (
      !currentPipeline?.host.currentRecord(input.pluginId) &&
      !registeredPlugin(policy.workspace.workspaceId, input.pluginId)
    ) {
      return StartPluginPanelResult.parse({ status: "not-registered" });
    }
    const started = await surfaces.startPanel(
      {
        workspaceId: policy.workspace.workspaceId,
        pluginId: input.pluginId,
        panelId: input.panelId,
        placement: input.placement,
        senderId: event.sender.id,
        generation: policy.generation,
      },
      {
        assertAllowed: () => policy.revalidate(CURRENT_RENDERER_MESSAGE),
        acquireHostLease: async () => {
          policy.revalidate(CURRENT_RENDERER_MESSAGE);
          const pipeline = await ensurePipeline(policy.workspace);
          policy.revalidate(CURRENT_RENDERER_MESSAGE);
          return platform.createPanelHostLease(pipeline, input.pluginId);
        },
        startPreview: (panel) =>
          platform.startPanelPreview({
            workspace: policy.workspace,
            pluginId: input.pluginId,
            panel,
          }),
      },
    );
    return StartPluginPanelResult.parse({
      status: "ok",
      url: started.url,
      title: started.title,
      surfaceId: started.surfaceId,
    });
  });

  registrar.handle(CHANNELS.invokePluginCommand, async (event, payload) => {
    const input = InvokePluginCommandPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(event, input.workspaceId, {
      inactiveMessage:
        "The plugin command request does not target the active workspace. Open the workspace and try again.",
      trackRenderer: true,
    });
    const pipeline = await ensurePipeline(policy.workspace);
    workspaces.assertWritable(policy.workspace);
    const plugin = registeredPlugin(policy.workspace.workspaceId, input.pluginId);
    if (!plugin) {
      return InvokePluginCommandResult.parse({
        status: "plugin-not-found",
        message: `This workspace has no plugin "${input.pluginId}".`,
      });
    }
    return InvokePluginCommandResult.parse(
      await invokeRegisteredPluginCommand({
        input,
        plugin,
        runCommand: (operation) =>
          pipeline.hostOwnership.runCommand(input.pluginId, operation),
        ensureStarted: async (command: PluginHostCommandAuthority) => {
          policy.revalidate(
            "The plugin command request was cancelled because the renderer changed.",
          );
          return ensurePluginStarted(
            pipeline.host,
            input.pluginId,
            () => command.start(() => pipeline.ensureStarted(input.pluginId, command)),
          );
        },
        ensureCurrent: () =>
          policy.revalidate(
            "The plugin command request was cancelled because the renderer changed.",
          ),
      }),
    );
  });

  registrar.handle(CHANNELS.stopPluginPanel, async (event, payload) => {
    const input = StopPluginPanelPayload.parse(payload);
    const policy = createExactSurfaceOwnershipPolicy(
      event,
      input.workspaceId,
      "The plugin panel stop request does not target the active workspace.",
    );
    await surfaces.stop({
      kind: "panel",
      workspaceId: policy.workspace.workspaceId,
      pluginId: input.pluginId,
      panelId: input.panelId,
      owner: policy.owner,
    });
  });

  registrar.handle(CHANNELS.invokePluginPanelSdk, async (event, payload) => {
    const input = InvokePluginPanelSdkPayload.parse(payload);
    const authorization = surfaces.authorizePanelSdk({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      panelId: input.panelId,
      senderId: event.sender.id,
      currentGeneration: () => rendererGeneration(event.sender.id),
      activeWorkspaceId: () =>
        workspaces.activeWorkspaceIdBySender.get(event.sender.id),
      liveSpawnId: () =>
        pipelines.get(input.workspaceId)?.host.getSpawnId(input.pluginId),
    });
    const result = await platform.routePanelSdk({
      authorization,
      method: input.method,
      params: input.params,
    });
    return InvokePluginPanelSdkResult.parse({ result });
  });

  registrar.handle(CHANNELS.openPluginWebApp, async (event, payload) => {
    const input = OpenPluginWebAppPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(event, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
      trackRenderer: true,
    });
    const registration = await loadPluginWebAppRegistration({
      workspaceRoot: policy.workspace.rootPath,
      pluginRoot: input.pluginRoot,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      pluginRegistration: pipelines.get(policy.workspace.workspaceId),
    });
    policy.revalidate(CURRENT_RENDERER_MESSAGE);
    const pipeline = await ensurePipeline(policy.workspace);
    policy.revalidate(CURRENT_RENDERER_MESSAGE);
    const plugin = rememberPluginRegistration(
      registrations,
      policy.workspace.workspaceId,
      {
        ...registration,
        directoryName: requireDiscoveredDirectoryName(pipeline, input.pluginId),
      },
    );
    requireDeclaredWebApp(
      input.pluginId,
      plugin.manifest.webApps,
      input.webAppId,
      input.instanceKey,
    );
    return OpenPluginWebAppResult.parse({
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
    });
  });

  registrar.handle(CHANNELS.startPluginWebApp, async (event, payload) => {
    const input = StartPluginWebAppPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(event, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
      trackRenderer: true,
    });
    const plugin = registeredPlugin(policy.workspace.workspaceId, input.pluginId);
    if (!plugin) {
      return StartPluginWebAppResult.parse({ status: "not-registered" });
    }
    const webApp = requireDeclaredWebApp(
      input.pluginId,
      plugin.manifest.webApps,
      input.webAppId,
      input.instanceKey,
    );
    const started = await surfaces.startWebApp(
      {
        workspaceId: policy.workspace.workspaceId,
        pluginId: input.pluginId,
        webAppId: input.webAppId,
        instanceKey: input.instanceKey,
        senderId: event.sender.id,
        generation: policy.generation,
        workspaceRoot: policy.workspace.rootPath,
        container: platform.createWebAppContainer(event.sender),
      },
      {
        assertInstanceBudget: (liveAndReservedOtherInstances) =>
          assertInstanceBudget(
            input.pluginId,
            input.webAppId,
            liveAndReservedOtherInstances,
          ),
        assertAllowed: () => policy.revalidate(CURRENT_RENDERER_MESSAGE),
        acquireHostLease: async () => {
          policy.revalidate(CURRENT_RENDERER_MESSAGE);
          const pipeline = await ensurePipeline(policy.workspace);
          policy.revalidate(CURRENT_RENDERER_MESSAGE);
          return platform.createWebAppHostLease(
            pipeline,
            input.pluginId,
            input.webAppId,
            input.instanceKey,
          );
        },
      },
    );
    return StartPluginWebAppResult.parse({
      status: "ok",
      title: started.title ?? webApp.title,
      origin: started.origin,
    });
  });

  registrar.handle(CHANNELS.setPluginWebAppBounds, (event, payload) => {
    const input = SetPluginWebAppBoundsPayload.parse(payload);
    surfaces.applyWebAppBounds({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
      senderId: event.sender.id,
      generation: rendererGeneration(event.sender.id),
      bounds: input.bounds,
      visible: input.visible,
      zoomFactor: event.sender.getZoomFactor(),
    });
  });

  registrar.handle(CHANNELS.stopPluginWebApp, async (event, payload) => {
    const input = StopPluginWebAppPayload.parse(payload);
    const policy = createExactSurfaceOwnershipPolicy(
      event,
      input.workspaceId,
      "The plugin web app stop request does not target the active workspace.",
    );
    await surfaces.stop({
      kind: "web-app",
      workspaceId: policy.workspace.workspaceId,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
      owner: policy.owner,
    });
  });

  registrar.handle(CHANNELS.listPlugins, async (event, payload) => {
    const input = ListPluginsPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(event, input.workspaceId);
      return ListPluginsResult.parse({ ok: true, plugins: pipeline.list() });
    } catch (error) {
      return ListPluginsResult.parse({ ok: false, error: pluginIpcError(error) });
    }
  });

  registrar.handle(CHANNELS.listOfferedPlugins, async (event, payload) => {
    const input = ListOfferedPluginsPayload.parse(payload);
    try {
      const { pipeline, workspace } = await activePipeline(event, input.workspaceId);
      workspaces.assertWritable(workspace);
      const existingPluginIds = new Set(
        pipeline.list().map((plugin) => plugin.id),
      );
      const offers = await listOfferedPlugins(
        platform.builtinPluginsRoot(),
        workspace.rootPath,
        existingPluginIds,
      );
      return ListOfferedPluginsResult.parse({ ok: true, offers });
    } catch (error) {
      return ListOfferedPluginsResult.parse({
        ok: false,
        error: pluginIpcError(error),
      });
    }
  });

  registrar.handle(CHANNELS.addOfferedPlugin, async (event, payload) => {
    const input = AddOfferedPluginPayload.parse(payload);
    try {
      const { pipeline, workspace } = await activePipeline(event, input.workspaceId);
      workspaces.assertWritable(workspace);
      await pipeline.handleWatcherEvents([
        { operation: "update", path: "plugins" },
      ]);
      const existingPluginIds = new Set(
        pipeline.list().map((entry) => entry.id),
      );
      const added = await addOfferedPlugin({
        builtinPluginsRoot: platform.builtinPluginsRoot(),
        workspaceRoot: workspace.rootPath,
        directoryName: input.directoryName,
        existingPluginIds,
      });
      const rediscoveryEvent: WatcherEvent = {
        operation: "create",
        path: `plugins/${input.directoryName}`,
      };
      await pipeline.handleWatcherEvents([rediscoveryEvent]);
      const plugin = pipeline.list().find(
        (entry) => entry.directoryName === input.directoryName,
      );
      const displaced = pipeline.findDirectorySupersededBy(input.directoryName);
      if (!plugin || !plugin.valid || displaced) {
        await removeAddedOfferedPlugin({
          workspaceRoot: workspace.rootPath,
          directoryName: input.directoryName,
          identity: added.identity,
          contentHash: added.contentHash,
        });
        await pipeline.handleWatcherEvents([rediscoveryEvent]);
        throw new Error(
          plugin
            ? `Another plugin already claims the id "${input.directoryName}" in this workspace.`
            : `plugins/${input.directoryName} did not appear after it was added.`,
        );
      }
      return AddOfferedPluginResult.parse({ ok: true, plugin });
    } catch (error) {
      return AddOfferedPluginResult.parse({
        ok: false,
        error: pluginIpcError(error),
      });
    }
  });

  const pluginAction = (
    channel: string,
    run: (
      pipeline: PluginPipeline,
      pluginId: string,
      workspaceId: string,
    ) => Promise<unknown>,
  ): void => {
    registrar.handle(channel, async (event, payload) => {
      const input = PluginActionPayload.parse(payload);
      try {
        const { pipeline } = await activePipeline(event, input.workspaceId);
        return PluginActionResult.parse(
          await run(pipeline, input.pluginId, input.workspaceId),
        );
      } catch (error) {
        return PluginActionResult.parse({
          ok: false,
          error: pluginIpcError(error),
          plugin: null,
        });
      }
    });
  };

  pluginAction(CHANNELS.installPlugin, (pipeline, pluginId) =>
    pipeline.install(pluginId));
  pluginAction(CHANNELS.disablePlugin, (pipeline, pluginId, workspaceId) =>
    surfaces.withPluginSdkGrantSuspensions((suspend) =>
      pipeline.disable(pluginId, {
        onWillStopRuntime: () => suspend({ workspaceId, pluginId }),
      })
    ));
  pluginAction(CHANNELS.enablePlugin, (pipeline, pluginId) =>
    pipeline.enable(pluginId));
  pluginAction(CHANNELS.approvePlugin, (pipeline, pluginId) =>
    pipeline.approve(pluginId));
  pluginAction(CHANNELS.rebuildPlugin, (pipeline, pluginId) =>
    pipeline.rebuild(pluginId));

  registrar.handle(CHANNELS.pluginUninstallPreflight, async (event, payload) => {
    const input = PluginUninstallPreflightPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(event, input.workspaceId);
      const result = await pipeline.uninstallPreflight(
        input.pluginId,
        input.directoryName,
      );
      if (!result.ok) return PluginUninstallPreflightResult.parse(result);
      return PluginUninstallPreflightResult.parse({
        ...result,
        preflight: {
          ...result.preflight,
          packagedDisplayName: await packagedBuiltinDisplayName(
            input.directoryName,
          ),
        },
      });
    } catch (error) {
      return PluginUninstallPreflightResult.parse({
        ok: false,
        error: pluginIpcError(error),
      });
    }
  });

  registrar.handle(CHANNELS.pluginSizes, async (event, payload) => {
    const input = PluginSizesPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(event, input.workspaceId);
      return PluginSizesResult.parse({
        ok: true,
        sizes: await pipeline.sizes(input.directoryName, input.pluginId),
      });
    } catch (error) {
      return PluginSizesResult.parse({
        ok: false,
        error: pluginIpcError(error),
      });
    }
  });

  registrar.handle(CHANNELS.getPluginSettings, async (event, payload) => {
    const input = GetPluginSettingsPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(event, input.workspaceId);
      return PluginSettingsResult.parse({
        ok: true,
        values: await pipeline.getPluginSettings(input.directoryName),
      });
    } catch (error) {
      return PluginSettingsResult.parse({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registrar.handle(CHANNELS.setPluginSettings, async (event, payload) => {
    const input = SetPluginSettingsPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(event, input.workspaceId);
      return PluginSettingsResult.parse({
        ok: true,
        values: await pipeline.setPluginSettings(
          input.directoryName,
          input.pluginId,
          input.values,
        ),
      });
    } catch (error) {
      return PluginSettingsResult.parse({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registrar.handle(CHANNELS.uninstallPlugin, async (event, payload) => {
    const input = UninstallPluginPayload.parse(payload);
    try {
      const { pipeline, workspace } = await activePipeline(
        event,
        input.workspaceId,
      );
      const result: PluginPipelineUninstallResult =
        await surfaces.withPluginSdkGrantSuspensions((suspend) =>
          pipeline.uninstall(
            input.pluginId,
            input.directoryName,
            input.confirmationToken,
            {
              onWillStopRuntime: (pluginId) =>
                suspend({ workspaceId: input.workspaceId, pluginId }),
            },
          )
        );
      const rendererResult = PluginActionResult.parse(
        result.ok
          ? { ok: true, plugin: result.plugin }
          : result,
      );
      const released = result.ok && result.identity === "released";
      if (released) {
        await surfaces.stop({
          kind: "plugin",
          workspaceId: input.workspaceId,
          pluginId: input.pluginId,
          clearPartition: { workspaceRoot: workspace.rootPath },
        });
      }
      forgetUninstalledPlugin({
        registrations,
        workspaceId: input.workspaceId,
        pluginId: input.pluginId,
        directoryName: input.directoryName,
        uninstalled: released,
      });
      return rendererResult;
    } catch (error) {
      return PluginActionResult.parse({
        ok: false,
        error: pluginIpcError(error),
        plugin: null,
      });
    }
  });
}
