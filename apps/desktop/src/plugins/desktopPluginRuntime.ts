import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { utilityProcess } from "electron";
import { pluginHostEnvFor, resolveDohcMcpCommand } from "../agents/chatDispatchService";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import type { OwnedWorkspaceSdkReadPort } from "../workspaces/ownedWorkspaceSdkReadPort";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { createWorkspaceActivity, WorkspaceActivityState } from "../workspaces/workspaceActivity";
import type { createWorkspaceAuthorityOwner, WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import { PluginHost } from "./PluginHost";
import { PluginPipeline, type PluginPipelineStatusEvent } from "./PluginPipeline";
import { createPluginAgentDrivers } from "./pluginAgentDrivers";
import { PluginAutomations, type AutomationEngineAdapter } from "./pluginAutomations";
import { PluginChildProcessBroker } from "./pluginChildProcessBroker";
import { PluginHostOwnership } from "./pluginHostOwnership";
import { ensurePluginStarted } from "./pluginHostStart";
import { pluginDataDir } from "./pluginLocalState";
import type { PluginSdkHostContext } from "./pluginSdkHost";
import { PluginSurfaceHostLifecycle } from "./pluginSurfaceHostLifecycle";
import { createPluginUtilityTransport } from "./pluginUtilityTransport";
import { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";
import type { PluginWorkspaceRuntimeParts } from "./pluginWorkspaceRuntimes";

type PluginRuntimeAuthorityState = {
  pluginSurfaces: ConstructorParameters<typeof PluginSurfaceHostLifecycle>[0]["surfaces"];
  activity: WorkspaceActivityState;
};

type PluginRuntimeAuthorityLease = WorkspaceAuthorityLease<RegistryEntry, PluginRuntimeAuthorityState>;

type PluginRuntimeSdkRequest = Pick<PluginSdkHostContext,
  "pluginId" | "spawnId" | "requestPath" | "isWritable" | "signal" |
  "automationClaimId" | "invokeChildProcess" | "subscribeFileWatch" |
  "subscribeRecordWatch" | "unsubscribeWorkspaceEvents"
> & { workspaceId: string; method: string; params?: unknown };

export interface DesktopPluginRuntimeDependencies {
  app: { readonly isPackaged: boolean };
  process: { readonly resourcesPath: string; readonly env: NodeJS.ProcessEnv };
  utilityProcess: Pick<typeof utilityProcess, "fork">;
  pluginHostEntry: string;
  pnpmRunnerEntry: string;
  readonly linuxStableCliBinDir: string | undefined;
  stateDir(): string;
  pluginResourcesBasePath(): string;
  requireWorkspaceAuthority(workspaceId: string): PluginRuntimeAuthorityLease;
  readonly workspaceAuthorities: Pick<ReturnType<typeof createWorkspaceAuthorityOwner<RegistryEntry, PluginRuntimeAuthorityState>>, "withBinding">;
  readonly workspaceActivity: Pick<ReturnType<typeof createWorkspaceActivity>, "engineCaptureFor">;
  withWorkspaceAttachment<Result>(
    workspace: { workspaceId: string; attachmentId?: symbol },
    work: (lease: PluginRuntimeAuthorityLease) => Result,
  ): Result | undefined;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: AutomationEngineAdapter) => Promise<Result>,
  ): Promise<Result | null>;
  findWorkspace(workspaceId: string): RegistryEntry | null;
  ownedWorkspaceReadsFor(workspace: RegistryEntry & { readonly attachmentId: symbol }): Pick<OwnedWorkspaceSdkReadPort, "getCollection">;
  readonly invokeWorkspacePluginSdk: (input: PluginRuntimeSdkRequest) => Promise<unknown>;
  sharedViewOf(workspaceId: string): object | null;
  notifyAutomationFailuresChanged(workspaceId: string): void;
}

export function createDesktopPluginRuntime(dependencies: DesktopPluginRuntimeDependencies): (
  workspace: CreatedWorkspace,
  hooks: { onPipelineStatus(event: PluginPipelineStatusEvent): void },
) => PluginWorkspaceRuntimeParts {
  const {
    app, process, utilityProcess, stateDir, pluginResourcesBasePath,
    requireWorkspaceAuthority, withWorkspaceAttachment, withEngineAdapter,
    findWorkspace, ownedWorkspaceReadsFor,
    sharedViewOf, notifyAutomationFailuresChanged,
  } = dependencies;

  return function createPluginWorkspaceRuntimeParts(
    workspace: CreatedWorkspace,
    hooks: { onPipelineStatus(event: PluginPipelineStatusEvent): void },
  ) {
    const authorityLease = requireWorkspaceAuthority(workspace.workspaceId);
    const authorityBinding = authorityLease.binding;
    if (authorityBinding.canonicalRootPath !== workspace.rootPath) {
      authorityLease.release();
      throw new Error("Plugin runtime creation received a stale workspace root.");
    }
    const surfaces = authorityLease.state.pluginSurfaces;
    authorityLease.release();
    const runWithAuthority = <Result>(work: () => Result | Promise<Result>) =>
      dependencies.workspaceAuthorities.withBinding(authorityBinding, () => work());
    let pipeline: PluginPipeline | null = null;
    let surfaceHostLifecycle: PluginSurfaceHostLifecycle | null = null;
    const dohcDir = pluginDataDir(stateDir(), workspace.rootPath);
    const childProcessBroker = new PluginChildProcessBroker({
      dohcDir,
      workspaceRoot: workspace.rootPath,
    });
    // This workspace's plugin-contributed agent drivers. They join the driver
    // registry the agent session manager builds, which chooses, probes, and
    // stops them.
    let pluginHostRef: PluginHost | null = null;
    const pluginDrivers = createPluginAgentDrivers({
      host: {
        requestDriver: (pluginId, spawnId, method, params) => {
          if (!pluginHostRef) {
            throw new Error(`Plugin "${pluginId}" is not running.`);
          }
          return pluginHostRef.requestDriver(pluginId, spawnId, method, params);
        },
        stopDriverSpawn: (pluginId, spawnId) => {
          if (!pluginHostRef) return Promise.resolve();
          return pluginHostRef.stopDriverSpawn(pluginId, spawnId);
        },
      },
    });
    // This workspace's plugin file subscriptions, fed by the settled watcher
    // batch (see onWatcherBatch) — the same feed the pipeline reads.
    const workspaceEvents = new PluginWorkspaceEvents();
    // This workspace's origin-device automation executor (ADR 0008): engine
    // access through the same attachment-pinned adapter collection reads take,
    // manifests through the pipeline created below, and handler runs through
    // the same host-ownership lease a command invocation holds.
    const automations = new PluginAutomations({
      withAdapter: (work) =>
        withEngineAdapter(
          {
            workspaceId: workspace.workspaceId,
            rootPath: workspace.rootPath,
            attachmentId: authorityBinding.attachmentId,
          },
          work,
        ),
      declaredAutomations: (pluginId) => {
        const currentPipeline = pipeline;
        if (!currentPipeline || !currentPipeline.discoveryLanded) return undefined;
        return currentPipeline.pluginRegistration(pluginId)?.manifest.automations ?? null;
      },
      // The read-scope proof a collections.watch makes, through the plugin's
      // own owned read port. A "." subscription needs none: the port is
      // workspace-scoped, so every collection a "." claim can name is one the
      // plugin may read. (Unlike a "." watch, claim delivery has no listed-set
      // filter; a narrower per-plugin read scope would need one here.)
      proveReadable: async (_pluginId, collectionPath) => {
        if (collectionPath === ".") return;
        const registered = findWorkspace(workspace.workspaceId);
        if (!registered) {
          throw new Error("This workspace is not registered on this machine.");
        }
        await ownedWorkspaceReadsFor({
          ...registered,
          attachmentId: authorityBinding.attachmentId,
        }).getCollection({ collectionPath });
      },
      runOnPlugin: async (pluginId, params) => {
        const currentPipeline = pipeline;
        // Pipeline still wiring up: the same transient as a host refusal. The
        // executor defers the claim; a settle here would be terminal.
        if (!currentPipeline) return "refused";
        const outcome = await currentPipeline.hostOwnership.runCommand(
          pluginId,
          async (commandAuthority) => {
            const host = await ensurePluginStarted(
              currentPipeline.host,
              pluginId,
              () =>
                commandAuthority.start(() =>
                  currentPipeline.ensureStarted(pluginId, commandAuthority),
                ),
            );
            if (!automations.activeRun({ claimId: params.claimId, pluginId })) {
              return { ok: true as const };
            }
            await host.runAutomation(pluginId, params);
            return { ok: true as const };
          },
        );
        // A refusal is the host mid-change on that plugin (or closing) — the
        // run never started, so the claim must not settle failed. The
        // executor keeps it and retries when the plugin next reaches ready.
        return outcome.kind === "completed" ? "completed" : "refused";
      },
      onClaimFailed: () =>
        notifyAutomationFailuresChanged(workspace.workspaceId),
      onError: (context, error) => {
        console.error(
          `[desktop] automations (${workspace.workspaceId}): ${context}:`,
          error,
        );
      },
    });
    const pluginHost = new PluginHost({
      stateDir: stateDir(),
      workspaceRoot: workspace.rootPath,
      spawnTransport: (callbacks) => {
        const dohcMcpCommand = resolveDohcMcpCommand({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          linuxStableCliBinDir: dependencies.linuxStableCliBinDir,
        });
        const pluginHostEnv = pluginHostEnvFor(dohcMcpCommand, process.env);
        const child = utilityProcess.fork(
          dependencies.pluginHostEntry,
          [],
          {
            cwd: callbacks.pluginRoot,
            serviceName: "dohc-plugin-host",
            stdio: ["ignore", "ignore", "pipe"],
            // The driver plugins' chat session configs read this seam for the
            // dohc-mcp command they hand the user's AI tool. Only main knows
            // whether this install is packaged and where its stable launcher
            // lives. If that launcher is unavailable, the host gets an explicit
            // marker and no command it could leak into a spawned process.
            env: pluginHostEnv,
          },
        );
        return createPluginUtilityTransport(child, callbacks);
      },
      // Shares invokeWorkspacePluginSdk with the panel SDK route
      // (invokePluginPanelSdk below) so both paths get the same isWritable /
      // writeAvailable / MomentAuthor handling instead of a second copy. Only
      // this, the plugin's own request path (not the panel path), supplies
      // invokeChildProcess — a panel is renderer-driven UI, not the plugin's
      // own activated code, so it never brokers child processes.
      routeSdkRequest: (
        pluginId,
        method,
        params,
        spawnId,
        signal,
        emitEvent,
        automationClaimId,
      ) =>
        runWithAuthority(() =>
          dependencies.invokeWorkspacePluginSdk({
            workspaceId: workspace.workspaceId,
            pluginId,
            spawnId,
            requestPath: "plugin-process",
            isWritable: () => !sharedViewOf(workspace.workspaceId),
            signal,
            ...(automationClaimId === undefined ? {} : { automationClaimId }),
            invokeChildProcess: (childMethod, childParams) =>
              childProcessBroker.invoke(
                { pluginId, spawnId, signal, emitEvent },
                childMethod,
                childParams,
              ),
            subscribeFileWatch: (watchParams) =>
              workspaceEvents.subscribe(
                {
                  owner: { kind: "process", pluginId, spawnId },
                  emitEvent,
                },
                watchParams,
              ),
            subscribeRecordWatch: (watchParams, readable) =>
              workspaceEvents.subscribeRecords(
                {
                  owner: { kind: "process", pluginId, spawnId },
                  emitEvent,
                },
                watchParams,
                readable,
              ),
            unsubscribeWorkspaceEvents: (watchParams) =>
              workspaceEvents.unsubscribe(
                { owner: { kind: "process", pluginId, spawnId } },
                watchParams,
              ),
            method,
            params,
          }),
        ),
      // The plugin gets its settings with its activation, so it never starts
      // without them and never has to ask. Named by directoryName — settings
      // are stored per directory, and a manifest's declared name can differ
      // from the folder it was found in.
      readPluginSettings: async (directoryName) =>
        (await pipeline?.getPluginSettings(directoryName)) ?? {},
      onDriversRegistered: (pluginId, spawnId, drivers) =>
        pluginDrivers.register(pluginId, spawnId, drivers),
      onDriverEvent: (pluginId, spawnId, params) =>
        pluginDrivers.handleEvent(pluginId, spawnId, params),
      // One seam ends a spawn: the driver's sessions fail here, and the broker
      // takes the harness's whole process tree down. Neither asks the plugin.
      onSpawnEnd: (pluginId, spawnId) => {
        surfaceHostLifecycle?.spawnEnded(pluginId);
        pluginDrivers.endSpawn(pluginId, spawnId);
        workspaceEvents.disposeSpawn(pluginId, spawnId);
        return childProcessBroker.disposeSpawn(pluginId, spawnId);
      },
      onDispose: () => childProcessBroker.dispose(),
      onStatusChange: (pluginId, status) => {
        void Promise.resolve(
          surfaceHostLifecycle?.statusChanged(pluginId, status),
        ).catch(() => undefined);
      },
      onRecoveryDisposition: (pluginId, disposition) => {
        void Promise.resolve(
          surfaceHostLifecycle?.recoveryDisposition(pluginId, disposition),
        ).catch(() => undefined);
      },
    });
    pluginHostRef = pluginHost;
    surfaceHostLifecycle = new PluginSurfaceHostLifecycle({
      workspaceId: workspace.workspaceId,
      host: pluginHost,
      surfaces,
      onRuntimeStatus: (pluginId, status) =>
        pipeline?.noteRuntimeStatus(pluginId, status),
      onError: (error, context) => {
        console.error(`[desktop] ${context}:`, error);
      },
    });
    const hostOwnership = new PluginHostOwnership(pluginHost, {
      onCleanupError: (pluginId, error) => {
        console.warn(
          `[desktop] failed to clean up plugin host ownership for "${pluginId}"`,
          error,
        );
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: workspace.rootPath,
      stateDir: stateDir(),
      hostOwnership,
      resourcesBasePath: pluginResourcesBasePath(),
      pnpmRunnerEntry: dependencies.pnpmRunnerEntry,
      // The automation executor reads every status first, so a plugin's
      // engine subscriptions are reconciled before the renderer hears about
      // the same transition.
      onStatusChange: (event) => {
        automations.handlePipelineStatus(event);
        hooks.onPipelineStatus(event);
      },
      onRuntimeStopped: (pluginId) =>
        surfaces.stop({
          kind: "plugin",
          workspaceId: workspace.workspaceId,
          pluginId,
        }),
      isEngineCaptureAvailable: () =>
        withWorkspaceAttachment(
          {
            workspaceId: workspace.workspaceId,
            attachmentId: authorityBinding.attachmentId,
          },
          (lease) =>
            dependencies.workspaceActivity.engineCaptureFor(lease.state.activity) !== null,
        ) ?? false,
    });
    return { pipeline, agentDrivers: pluginDrivers, workspaceEvents, automations };
  };
}
