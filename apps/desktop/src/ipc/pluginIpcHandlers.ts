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
  loadPluginPanelRegistration,
  loadPluginWebAppRegistration,
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
  getZoomFactor(): number;
}

interface PluginIpcEvent<TSender extends PluginIpcSender> {
  readonly sender: TSender;
}

interface PluginIpcWorkspace {
  readonly workspaceId: string;
  readonly rootPath: string;
}

interface PluginRendererWorkspaceSession {
  readonly workspaceId: string;
  readonly generation: number;
  isCurrent(): boolean;
}

type PluginIpcHandler<TEvent, TWorkspace extends PluginIpcWorkspace> = (
  event: TEvent,
  payload: unknown,
  active: ActiveWorkspacePolicy<TWorkspace> | undefined,
) => unknown | Promise<unknown>;

interface PluginIpcRegistrar<
  TEvent,
  TWorkspace extends PluginIpcWorkspace = PluginIpcWorkspace,
> {
  handle(channel: string, handler: PluginIpcHandler<TEvent, TWorkspace>): void;
}

type PluginIpcSurfaces<TView extends PluginWebAppViewLike> = Pick<
  PluginSurfaces<TView>,
  | "applyWebAppBounds"
  | "authorizePanelSdk"
  | "startPanel"
  | "startWebApp"
  | "stop"
> & {
  withPluginSdkGrantSuspensions<Result extends { readonly ok: boolean }>(
    workspaceId: string,
    run: (
      suspend: (identity: { workspaceId: string; pluginId: string }) => void,
    ) => Promise<Result>,
  ): Promise<Result>;
};

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
  registrar: PluginIpcRegistrar<TEvent, TWorkspace>;
  assertTrustedSender(event: TEvent): void;
  workspaces: {
    assertWritable(workspace: TWorkspace): void;
    withActive<Result>(
      sender: TSender,
      workspaceId: string,
      inactiveMessage: string,
      work: (
        active: ActiveWorkspacePolicy<TWorkspace>,
      ) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  runtimes: {
    current(workspaceId: string): PluginIpcRuntime | undefined;
    ensure(workspace: TWorkspace): Promise<PluginIpcRuntime>;
  };
  surfaces: PluginIpcSurfaces<TView>;
  platform: PluginIpcPlatform<TSender, TWorkspace, TView>;
}

interface PluginIpcRuntime {
  readonly pipeline: PluginPipeline;
  registeredPlugin(pluginId: string): RegisteredPlugin | undefined;
  rememberPlugin(registration: RegisteredPlugin): RegisteredPlugin;
  forgetUninstalledPlugin(input: {
    pluginId: string;
    directoryName: string;
    released: boolean;
  }): void;
}

interface ActiveWorkspacePolicy<TWorkspace extends PluginIpcWorkspace> {
  readonly workspace: TWorkspace;
  readonly session: PluginRendererWorkspaceSession;
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
const PLUGIN_RUNTIME_CHANGED_MESSAGE =
  "The workspace's plugins stopped while this was opening. Open it again.";

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
    registrar: rawRegistrar,
    assertTrustedSender,
    workspaces,
    runtimes,
    surfaces,
    platform,
  } = options;
  const registrar: PluginIpcRegistrar<TEvent, TWorkspace> = {
    handle(channel, handler) {
      rawRegistrar.handle(channel, (event, payload) => {
        assertTrustedSender(event);
        const workspaceId =
          typeof payload === "object" &&
          payload !== null &&
          "workspaceId" in payload &&
          typeof payload.workspaceId === "string"
            ? payload.workspaceId
            : undefined;
        if (workspaceId === undefined) return handler(event, payload, undefined);
        return workspaces.withActive(
          event.sender,
          workspaceId,
          DEFAULT_INACTIVE_MESSAGE,
          (active) => handler(event, payload, active),
        );
      });
    },
  };

  const createReadableActiveWorkspacePolicy = (
    active: ActiveWorkspacePolicy<TWorkspace> | undefined,
    workspaceId: string,
    inactiveMessage = DEFAULT_INACTIVE_MESSAGE,
  ): ActiveWorkspacePolicy<TWorkspace> => {
    if (
      !active ||
      active.workspace.workspaceId !== workspaceId ||
      !active.session.isCurrent()
    ) {
      throw new Error(inactiveMessage);
    }
    return active;
  };

  const createWritableActiveWorkspacePolicy = (
    active: ActiveWorkspacePolicy<TWorkspace> | undefined,
    workspaceId: string,
    settings: {
      inactiveMessage?: string;
    } = {},
  ): WritableActiveWorkspacePolicy<TWorkspace> => {
    const { workspace, session } = createReadableActiveWorkspacePolicy(
      active,
      workspaceId,
      settings.inactiveMessage,
    );
    const generation = session.generation;
    const revalidate = (message = settings.inactiveMessage ?? DEFAULT_INACTIVE_MESSAGE) => {
      if (!session.isCurrent()) {
        throw new Error(message);
      }
      workspaces.assertWritable(workspace);
    };
    revalidate();
    return { workspace, session, generation, revalidate };
  };

  const createExactSurfaceOwnershipPolicy = (
    event: TEvent,
    active: ActiveWorkspacePolicy<TWorkspace> | undefined,
    workspaceId: string,
    inactiveMessage: string,
  ) => {
    const { workspace, session } = createReadableActiveWorkspacePolicy(
      active,
      workspaceId,
      inactiveMessage,
    );
    return {
      workspace,
      owner: {
        senderId: event.sender.id,
        generation: session.generation,
      },
    };
  };

  const requireSurfaceSession = (
    active: ActiveWorkspacePolicy<TWorkspace> | undefined,
    workspaceId: string,
    inactiveMessage: string,
  ): PluginRendererWorkspaceSession => {
    const session = active?.session;
    if (
      !session ||
      !session.isCurrent() ||
      session.workspaceId !== workspaceId
    ) {
      throw new Error(inactiveMessage);
    }
    return session;
  };

  const registeredPlugin = (
    workspaceId: string,
    pluginId: string,
  ): RegisteredPlugin | undefined =>
    runtimes.current(workspaceId)?.registeredPlugin(pluginId);

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
    active: ActiveWorkspacePolicy<TWorkspace> | undefined,
    workspaceId: string,
  ) => {
    const policy = createWritableActiveWorkspacePolicy(active, workspaceId);
    const runtime = await runtimes.ensure(policy.workspace);
    policy.revalidate();
    return {
      runtime,
      pipeline: runtime.pipeline,
      workspace: policy.workspace,
    };
  };

  const ensureExactRuntime = async (
    policy: WritableActiveWorkspacePolicy<TWorkspace>,
    inactiveMessage: string,
  ) => {
    const runtime = await runtimes.ensure(policy.workspace);
    const revalidate = (): void => {
      policy.revalidate(inactiveMessage);
      if (runtimes.current(policy.workspace.workspaceId) !== runtime) {
        throw new Error(PLUGIN_RUNTIME_CHANGED_MESSAGE);
      }
    };
    revalidate();
    return { runtime, revalidate };
  };

  registrar.handle(CHANNELS.openPluginPanel, async (event, payload, active) => {
    const input = OpenPluginPanelPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(active, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
    });
    const { runtime, revalidate } = await ensureExactRuntime(
      policy,
      CURRENT_RENDERER_MESSAGE,
    );
    const pipeline = runtime.pipeline;
    const registration = await loadPluginPanelRegistration({
      workspaceRoot: policy.workspace.rootPath,
      pluginRoot: input.pluginRoot,
      pluginId: input.pluginId,
      panelId: input.panelId,
      pluginRegistration: pipeline,
    });
    revalidate();
    runtime.rememberPlugin({
      ...registration,
      directoryName: requireDiscoveredDirectoryName(pipeline, input.pluginId),
    });
    return OpenPluginPanelResult.parse({
      pluginId: input.pluginId,
      panelId: input.panelId,
    });
  });

  registrar.handle(CHANNELS.startPluginPanel, async (event, payload, active) => {
    const input = StartPluginPanelPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(active, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
    });
    const currentPipeline = runtimes.current(policy.workspace.workspaceId)
      ?.pipeline;
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
          const pipeline = (await runtimes.ensure(policy.workspace)).pipeline;
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

  registrar.handle(CHANNELS.invokePluginCommand, async (event, payload, active) => {
    const input = InvokePluginCommandPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(active, input.workspaceId, {
      inactiveMessage:
        "The plugin command request does not target the active workspace. Open the workspace and try again.",
    });
    const pipeline = (await runtimes.ensure(policy.workspace)).pipeline;
    policy.revalidate();
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

  registrar.handle(CHANNELS.stopPluginPanel, async (event, payload, active) => {
    const input = StopPluginPanelPayload.parse(payload);
    const policy = createExactSurfaceOwnershipPolicy(
      event,
      active,
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

  registrar.handle(CHANNELS.invokePluginPanelSdk, async (event, payload, active) => {
    const input = InvokePluginPanelSdkPayload.parse(payload);
    const session = requireSurfaceSession(
      active,
      input.workspaceId,
      CURRENT_RENDERER_MESSAGE,
    );
    const authorization = surfaces.authorizePanelSdk({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      panelId: input.panelId,
      senderId: event.sender.id,
      currentGeneration: () => session.generation,
      activeWorkspaceId: () =>
        session.isCurrent() ? session.workspaceId : undefined,
      liveSpawnId: () =>
        runtimes.current(input.workspaceId)?.pipeline.host.getSpawnId(
          input.pluginId,
        ),
    });
    const result = await platform.routePanelSdk({
      authorization,
      method: input.method,
      params: input.params,
    });
    return InvokePluginPanelSdkResult.parse({ result });
  });

  registrar.handle(CHANNELS.openPluginWebApp, async (event, payload, active) => {
    const input = OpenPluginWebAppPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(active, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
    });
    const { runtime, revalidate } = await ensureExactRuntime(
      policy,
      CURRENT_RENDERER_MESSAGE,
    );
    const pipeline = runtime.pipeline;
    const registration = await loadPluginWebAppRegistration({
      workspaceRoot: policy.workspace.rootPath,
      pluginRoot: input.pluginRoot,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      pluginRegistration: pipeline,
    });
    revalidate();
    const plugin = runtime.rememberPlugin({
      ...registration,
      directoryName: requireDiscoveredDirectoryName(pipeline, input.pluginId),
    });
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

  registrar.handle(CHANNELS.startPluginWebApp, async (event, payload, active) => {
    const input = StartPluginWebAppPayload.parse(payload);
    const policy = createWritableActiveWorkspacePolicy(active, input.workspaceId, {
      inactiveMessage: CURRENT_RENDERER_MESSAGE,
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
          const pipeline = (await runtimes.ensure(policy.workspace)).pipeline;
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

  registrar.handle(CHANNELS.setPluginWebAppBounds, (event, payload, active) => {
    const input = SetPluginWebAppBoundsPayload.parse(payload);
    const session = requireSurfaceSession(
      active,
      input.workspaceId,
      CURRENT_RENDERER_MESSAGE,
    );
    surfaces.applyWebAppBounds({
      workspaceId: input.workspaceId,
      pluginId: input.pluginId,
      webAppId: input.webAppId,
      instanceKey: input.instanceKey,
      senderId: event.sender.id,
      generation: session.generation,
      bounds: input.bounds,
      visible: input.visible,
      zoomFactor: event.sender.getZoomFactor(),
    });
  });

  registrar.handle(CHANNELS.stopPluginWebApp, async (event, payload, active) => {
    const input = StopPluginWebAppPayload.parse(payload);
    const policy = createExactSurfaceOwnershipPolicy(
      event,
      active,
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

  registrar.handle(CHANNELS.listPlugins, async (_event, payload, active) => {
    const input = ListPluginsPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(active, input.workspaceId);
      return ListPluginsResult.parse({ ok: true, plugins: pipeline.list() });
    } catch (error) {
      return ListPluginsResult.parse({ ok: false, error: pluginIpcError(error) });
    }
  });

  registrar.handle(CHANNELS.listOfferedPlugins, async (_event, payload, active) => {
    const input = ListOfferedPluginsPayload.parse(payload);
    try {
      const { pipeline, workspace } = await activePipeline(active, input.workspaceId);
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

  registrar.handle(CHANNELS.addOfferedPlugin, async (_event, payload, active) => {
    const input = AddOfferedPluginPayload.parse(payload);
    try {
      const { pipeline, workspace } = await activePipeline(active, input.workspaceId);
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
    registrar.handle(channel, async (_event, payload, active) => {
      const input = PluginActionPayload.parse(payload);
      try {
        const { pipeline } = await activePipeline(active, input.workspaceId);
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
    surfaces.withPluginSdkGrantSuspensions(workspaceId, (suspend) =>
      pipeline.disable(pluginId, {
        onWillStopRuntime: () => suspend({ workspaceId, pluginId }),
      }),
    ));
  pluginAction(CHANNELS.enablePlugin, (pipeline, pluginId) =>
    pipeline.enable(pluginId));
  pluginAction(CHANNELS.approvePlugin, (pipeline, pluginId) =>
    pipeline.approve(pluginId));
  pluginAction(CHANNELS.rebuildPlugin, (pipeline, pluginId) =>
    pipeline.rebuild(pluginId));

  registrar.handle(CHANNELS.pluginUninstallPreflight, async (_event, payload, active) => {
    const input = PluginUninstallPreflightPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(active, input.workspaceId);
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

  registrar.handle(CHANNELS.pluginSizes, async (_event, payload, active) => {
    const input = PluginSizesPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(active, input.workspaceId);
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

  registrar.handle(CHANNELS.getPluginSettings, async (_event, payload, active) => {
    const input = GetPluginSettingsPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(active, input.workspaceId);
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

  registrar.handle(CHANNELS.setPluginSettings, async (_event, payload, active) => {
    const input = SetPluginSettingsPayload.parse(payload);
    try {
      const { pipeline } = await activePipeline(active, input.workspaceId);
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

  registrar.handle(CHANNELS.uninstallPlugin, async (_event, payload, active) => {
    const input = UninstallPluginPayload.parse(payload);
    try {
      const { pipeline, runtime, workspace } = await activePipeline(
        active,
        input.workspaceId,
      );
      const result: PluginPipelineUninstallResult =
        await surfaces.withPluginSdkGrantSuspensions(
          input.workspaceId,
          (suspend) =>
            pipeline.uninstall(
              input.pluginId,
              input.directoryName,
              input.confirmationToken,
              {
                onWillStopRuntime: (pluginId) =>
                  suspend({ workspaceId: input.workspaceId, pluginId }),
              },
            ),
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
      runtime.forgetUninstalledPlugin({
        pluginId: input.pluginId,
        directoryName: input.directoryName,
        released,
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
