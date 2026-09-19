import type { App, Dialog } from "electron";
import {
  EngineWorkspaceSessions,
  type EngineDaemonLifecycle,
  type EngineWorkspace,
  type createRustEngineDaemon as createRustEngineDaemonImplementation,
  type defaultEngineBinaryPath as defaultEngineBinaryPathImplementation,
} from "@dohc/workspace-engine-client/daemon";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import { bridgeCaptureEventsToRenderer } from "./captureActivityBridge";
import { bridgeRecordEventsToPlugins } from "./recordEventsBridge";
import { bridgeAutomationClaimsToExecutors } from "./automationClaimsBridge";
import type { WorkspaceActivityScope } from "../ipc/workspaceActivityBroadcast";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { RegistryEntry } from "./registryStore";
import type { WorkspaceAuthorityOperation, WorkspaceAuthorityLease } from "./workspaceAuthorityOwner";
import type { PluginWorkspaceRuntimes } from "../plugins/pluginWorkspaceRuntimes";
import type { launchMarks as launchMarksImplementation } from "../performance/launchMarks";
import type { desktopMarks as desktopMarksImplementation } from "../performance/desktopMarks";
import {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {ExistingOwnerDeviceConfig} from "@dohc/sync-relay/device-host";
import type {readDesktopOwnerHostConfig,startDesktopOwnerHost} from "./desktopOwnerHost";

import type {DesktopOwnerDeliveryConfig, startDesktopOwnerDelivery} from "./desktopOwnerDelivery";
import {relayUrlsMatch} from "./syncCode";
import {readyOwnerDeliveryDocuments, startServerOwnerDelivery} from "./serverOwnerDelivery";

export interface ServerOwnerDelivery {
  prepare(): Promise<Omit<DesktopOwnerDeliveryConfig, "relayUrl" | "documents">>;
  workspaceIds(): string[];
  connect(workspace: RegistryEntry, signal: AbortSignal): Promise<{
    bearer: string; relayUrl: string; signal: AbortSignal;
    assertCurrent(): void;
    documents(signal: AbortSignal): Promise<unknown>;
  } | null>;
}
export type OwnerLiveDeliveryStatus = "preparing" | "active" | "retrying";
type OwnerLiveDeliveryReason = "document-unavailable" | "workspace-changed" | "restart-required";

type EngineAuthorityState = {
  pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace>;
};

interface DesktopEngineDependencies<State extends EngineAuthorityState> {
  serverOwnerDelivery?: ServerOwnerDelivery;
  ownerDeliveryCredentials?(): {bearer: string; relayUrl: string; signal: AbortSignal} | null;
  existingOwnerFor?: ExistingOwnerDeviceConfig["ownerFor"];
  findWorkspace(workspaceId: string): RegistryEntry | null;
  app: Pick<App, "isPackaged" | "getAppPath" | "quit">;
  dialog: Pick<Dialog, "showErrorBox">;
  process: { env: NodeJS.ProcessEnv; resourcesPath?: string };
  createRustEngineDaemon: typeof createRustEngineDaemonImplementation;
  defaultEngineBinaryPath: typeof defaultEngineBinaryPathImplementation;
  isQuitting(): boolean;
  workspaceAuthorities: {
    workspaceIds(): string[];
    withOperation?<Result>(workspaceId: string, work: (operation: WorkspaceAuthorityOperation<RegistryEntry, State>) => Result | Promise<Result>): Promise<Result>;
    withAuthority<Result>(
      workspaceId: string,
      work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  pluginWorkspaceRuntimes: Pick<PluginWorkspaceRuntimes<CreatedWorkspace>, "current">;
  notifyRenderer(scope?: WorkspaceActivityScope): void;
  notifyAutomationFailuresChanged(workspaceId: string): void;
  notifyOwnerDeliveryChanged?(workspaceId: string): void;
  launchMarks: Pick<typeof launchMarksImplementation, "daemonReady">;
  desktopMarks: Pick<typeof desktopMarksImplementation, "markOnce">;
  logLaunchMarksOnce(): void;
}

export function createDesktopEngine<State extends EngineAuthorityState>(
  dependencies: DesktopEngineDependencies<State>,
) {
  const {
    app, dialog, process, createRustEngineDaemon, defaultEngineBinaryPath,
    isQuitting, workspaceAuthorities, pluginWorkspaceRuntimes, notifyRenderer,
    notifyAutomationFailuresChanged, launchMarks, desktopMarks, logLaunchMarksOnce,
  } = dependencies;

  let rustEngineDaemon: EngineDaemonLifecycle | null = null;
  let rustEngineWorkspaceSessions: EngineWorkspaceSessions | null = null;
  let rustEngineRelayClient: EngineRelayClient | null = null;
  let rustEngineSessionSource: RelayConfiguredDaemonClientSource | null = null;
  let ownerHost: ReturnType<typeof startDesktopOwnerHost> | undefined;
  let ownerHostConfig: ReturnType<typeof readDesktopOwnerHostConfig> | undefined;
  let ownerHostModule: typeof import("./desktopOwnerHost") | undefined;
  let ownerHostGeneration = 0;
  let ownerWorkspaceCloses = 0;
  let ownerDelivery: (ReturnType<typeof startDesktopOwnerDelivery> & {retry?(workspaceId: string): void}) | undefined;
  let ownerDeliveryConfig: DesktopOwnerDeliveryConfig | undefined;
  let ownerDeliveryModule: typeof import("./desktopOwnerDelivery") | undefined;
  let nativeOwnerDeliveryModule: typeof import("./nativeOwnerDelivery") | undefined;
  let ownerDeliverySettled = Promise.resolve();
  let ownerDeliveryGeneration = 0;
  let serverOwnerConfig: Awaited<ReturnType<ServerOwnerDelivery["prepare"]>> | undefined;
  const ownerDeliveryStatus = new Map<string, OwnerLiveDeliveryStatus>();
  let serverOwnerUnavailable = false;
  let activeOwnerWorkspace: string | undefined;
  const failedOwnerDocuments = new Map<string, Set<string>>();
  const ownerDeliveryReason = new Map<string, OwnerLiveDeliveryReason>();
  const setOwnerDeliveryStatus = (workspaceId: string, status: OwnerLiveDeliveryStatus | undefined, reason?: OwnerLiveDeliveryReason) => {
    if (ownerDeliveryStatus.get(workspaceId) === status && ownerDeliveryReason.get(workspaceId) === reason) return;
    if (status) ownerDeliveryStatus.set(workspaceId, status); else ownerDeliveryStatus.delete(workspaceId);
    if (reason) ownerDeliveryReason.set(workspaceId, reason); else ownerDeliveryReason.delete(workspaceId);
    dependencies.notifyOwnerDeliveryChanged?.(workspaceId);
  };
  function stopOwnerDelivery(): Promise<void> {
    ownerDeliveryGeneration += 1;
    for (const id of ownerDeliveryStatus.keys()) setOwnerDeliveryStatus(id, undefined);
    failedOwnerDocuments.clear();
    const previous = ownerDelivery;
    ownerDelivery = undefined;
    if (previous) ownerDeliverySettled = Promise.all([ownerDeliverySettled, previous.stop()]).then(() => undefined);
    return ownerDeliverySettled;
  }
  function startOwnerDelivery(): void {
    const settled = stopOwnerDelivery(), generation = ownerDeliveryGeneration;
    void settled.then(() => {
      const server = dependencies.serverOwnerDelivery;
      if (server && serverOwnerConfig && rustEngineDaemon && rustEngineWorkspaceSessions && rustEngineSessionSource &&
        generation === ownerDeliveryGeneration && !isQuitting() && !ownerWorkspaceCloses) {
        const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions, source = rustEngineSessionSource;
        const profile = serverOwnerConfig;
        ownerDelivery = startServerOwnerDelivery({workspaceIds: () => server.workspaceIds(), ...profile,
          onError: error => console.error("[desktop] server owner delivery failed:", error),
          runPass: async (workspaceId, index, lifetime) => {
            if (!workspaceAuthorities.withOperation) throw new Error("Owner delivery workspace authority is unavailable.");
            activeOwnerWorkspace = workspaceId;
            try {return await workspaceAuthorities.withOperation(workspaceId, async operation => {
              const session = await server.connect(operation.workspace, AbortSignal.any([lifetime, operation.signal]));
              if (!session) {setOwnerDeliveryStatus(workspaceId, undefined); return {documentCount: 0, acknowledged: false};}
              const signal = AbortSignal.any([lifetime, operation.signal, session.signal]);
              const check = () => {
                signal.throwIfAborted(); operation.assertCurrent(); session.assertCurrent();
                if (generation !== ownerDeliveryGeneration || isQuitting()) throw new Error("Owner delivery session retired.");
              };
              check();
              try {
              const response = await session.documents(signal);
              const documents = readyOwnerDeliveryDocuments(response, workspaceId);
              check();
              const rows = (response as {documents: {status: string; reason?: unknown}[]}).documents;
              const preparing = rows.some(row => row.status === "preparing");
              const unavailable = rows.some(row => row.status === "unavailable");
              const reason = rows.some(row => row.status === "unavailable" && row.reason === "workspace-changed") ? "workspace-changed" :
                rows.some(row => row.status === "unavailable" && row.reason === "document-unavailable") ? "document-unavailable" : undefined;
              const failures = failedOwnerDocuments.get(workspaceId) ?? new Set<string>();
              for (const path of failures) if (!documents.some(document => document.binding.currentPath === path)) failures.delete(path);
              failedOwnerDocuments.set(workspaceId, failures);
              if (!documents.length) {
                setOwnerDeliveryStatus(workspaceId, unavailable ? "retrying" : preparing ? "preparing" : undefined, reason);
                return {documentCount: 0, acknowledged: false};
              }
              const document = documents[index % documents.length]!;
              nativeOwnerDeliveryModule ??= await import("./nativeOwnerDelivery");
              check();
              const native = nativeOwnerDeliveryModule;
              const result = await sessions.run(operation.workspace, async binding => {
                const client = daemon.currentClient();
                if (!(client instanceof EngineClient)) throw new Error("Owner delivery requires the desktop daemon client.");
                const assertCurrent = () => {
                  check(); sessions.assertCurrentBinding(operation.workspace, binding);
                  if (daemon.currentClient() !== client || binding.client !== source.currentClient()) throw new Error("Owner delivery daemon retired.");
                };
                assertCurrent();
                return native.runNativeOwnerDeliveryPass({client, workspaceHandle: binding.workspace,
                  document, config: {...profile, relayUrl: session.relayUrl, documents},
                  signal, bearer: session.bearer, assertCurrent});
              });
              check();
              if (result === "retry" || result === "frozen") failures.add(document.binding.currentPath);
              else failures.delete(document.binding.currentPath);
              setOwnerDeliveryStatus(workspaceId, failures.size || unavailable ? "retrying" : preparing ? "preparing" : "active", reason);
              return {documentCount: documents.length, acknowledged: result === "acknowledged"};
              } catch (error) {
                if (!operation.signal.aborted && !session.signal.aborted && generation === ownerDeliveryGeneration && !isQuitting()) {
                  setOwnerDeliveryStatus(workspaceId, "retrying", ownerDeliveryReason.get(workspaceId));
                }
                throw error;
              }
            });} finally {activeOwnerWorkspace = undefined;}
          },
        });
        return;
      }
      if (generation !== ownerDeliveryGeneration || isQuitting() || ownerWorkspaceCloses || !ownerDeliveryConfig || !ownerDeliveryModule || !nativeOwnerDeliveryModule || !rustEngineDaemon || !rustEngineWorkspaceSessions || !rustEngineSessionSource) return;
      const config = ownerDeliveryConfig, daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions,
        source = rustEngineSessionSource, native = nativeOwnerDeliveryModule;
      ownerDelivery = ownerDeliveryModule.startDesktopOwnerDelivery({config,
        onError: error => console.error("[desktop] owner delivery failed:", error),
        runPass: async (document, lifetime) => {
          const credentials = dependencies.ownerDeliveryCredentials?.();
          if (!credentials || !relayUrlsMatch(credentials.relayUrl, config.relayUrl) || !dependencies.findWorkspace(document.binding.workspaceId)) return "retry";
          if (!workspaceAuthorities.withOperation) throw new Error("Owner delivery workspace authority is unavailable.");
          return workspaceAuthorities.withOperation(document.binding.workspaceId, operation =>
            sessions.run(operation.workspace, async binding => {
              const client = daemon.currentClient();
              if (!(client instanceof EngineClient)) throw new Error("Owner delivery requires the desktop daemon client.");
              const signal = AbortSignal.any([lifetime, operation.signal, credentials.signal]);
              const assertCurrent = () => {
                signal.throwIfAborted(); operation.assertCurrent();
                sessions.assertCurrentBinding(operation.workspace, binding);
                if (generation !== ownerDeliveryGeneration || isQuitting() || daemon.currentClient() !== client || binding.client !== source.currentClient()) throw new Error("Owner delivery daemon retired.");
              };
              assertCurrent();
              return native.runNativeOwnerDeliveryPass({client, workspaceHandle: binding.workspace,
                document, config, signal, bearer: credentials.bearer, assertCurrent});
            }));
        },
      });
    }).catch(error => console.error("[desktop] owner delivery startup failed:", error));
  }
  const ownerUsesWorkspace = (workspaceId: string) => ownerHostConfig?.workspaceIds.includes(workspaceId) === true ||
    activeOwnerWorkspace === workspaceId ||
    (serverOwnerConfig !== undefined && dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) === true) ||
    ownerDeliveryConfig?.documents.some(document => document.binding.workspaceId === workspaceId) === true;
  const stopOwnerHost = () => {
    ownerHostGeneration += 1;
    const previous = ownerHost;
    ownerHost = undefined;
    previous?.stop();
  };
  const startOwnerHost = () => {
    stopOwnerHost();
    if (isQuitting() || ownerWorkspaceCloses || !ownerHostModule || !ownerHostConfig || !rustEngineDaemon || !rustEngineWorkspaceSessions || !rustEngineSessionSource || !dependencies.existingOwnerFor) return;
    const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions, source = rustEngineSessionSource, config = ownerHostConfig;
    const generation = ownerHostGeneration;
    ownerHost = ownerHostModule.startDesktopOwnerHost({config,ownerFor: dependencies.existingOwnerFor,
      onError: error => console.error("[desktop] owner host connection failed:",error),
      bindings: async () => {
        const client = daemon.currentClient();
        if (!(client instanceof EngineClient)) throw new Error("Owner host requires the desktop daemon client.");
        const workspaces = [];
        const bindingChecks: (() => void)[] = [];
        for (const workspaceId of config.workspaceIds) {
          if (!dependencies.findWorkspace(workspaceId)) continue;
          workspaces.push(await workspaceAuthorities.withAuthority(workspaceId,async lease => {
            lease.assertCurrent();
            const workspace = {workspaceId,rootPath: lease.binding.canonicalRootPath,attachmentId: lease.binding.attachmentId};
            return sessions.run(workspace, async binding => {
              lease.assertCurrent();
              if (daemon.currentClient() !== client || binding.client !== source.currentClient()) throw new Error("Owner host daemon changed.");
              bindingChecks.push(() => sessions.assertCurrentBinding(workspace, binding));
              return {workspaceId,workspaceHandle: binding.workspace};
            });
          }));
        }
        if (!workspaces.length) throw new Error("Owner host has no registered workspaces.");
        return {client,workspaces,assertCurrent: () => {
          if (isQuitting() || ownerHostGeneration !== generation || daemon.currentClient() !== client) throw new Error("Owner host daemon retired.");
          for (const check of bindingChecks) check();
        }};
      },
    });
  };
  // Settles with the daemon handshake (false = startup failed and the app is
  // quitting). The whenReady continuation creates the window while the daemon
  // starts, so a fast renderer can ask for the engine before the handshake
  // settles; boot-time paths that need engine sessions await this first instead
  // of throwing the broken-invariant error at it.
  let engineDaemonStartup: Promise<boolean> = Promise.resolve(false);
  const relayTransportRoutes = new RelayTransportRouteGuard();

  // Narrowing for the engine-access gates. The invariant is real:
  // every boot-time path that can reach the engine awaits engineDaemonStartup
  // first (openWorkspaceActivityWith, cloudStatus, the share-view file and
  // mount lanes), and startRustEngineDaemon
  // quits the app when the handshake fails; this handle is nulled only on that
  // failure path. A later startup-smoke failure restarts the daemon without
  // nulling it. A throw here would mean that invariant broke, which must be
  // loud, not a silent drop to the legacy engine.
  function requireEngineSessions(): EngineWorkspaceSessions {
    if (!rustEngineWorkspaceSessions) {
      throw new Error("Rust engine workspace sessions are unavailable.");
    }
    return rustEngineWorkspaceSessions;
  }

  async function withOwnerHostPaused<Result>(
    pause: boolean,
    work: () => Promise<Result>,
  ): Promise<Result> {
    if (!pause) return work();
    ownerWorkspaceCloses += 1;
    try {
      stopOwnerHost();
      await stopOwnerDelivery();
      return await work();
    } finally {
      ownerWorkspaceCloses -= 1;
      if (!ownerWorkspaceCloses) {startOwnerHost(); startOwnerDelivery();}
    }
  }

  async function closeRelayTransportWorkspace(
    workspace: string | EngineWorkspace,
  ): Promise<void> {
    const workspaceId =
      typeof workspace === "string" ? workspace : workspace.workspaceId;
    const reconnectOwner = ownerUsesWorkspace(workspaceId);
    await withOwnerHostPaused(reconnectOwner, async () => {
      if (rustEngineRelayClient) {
        await rustEngineRelayClient.closeWorkspace(workspace);
        return;
      }
      await rustEngineWorkspaceSessions?.closeWorkspace(workspace);
      relayTransportRoutes.releaseWorkspace(workspaceId);
    });
  }

  async function closeAllRelayTransportWorkspaces(): Promise<void> {
    await withOwnerHostPaused(true, async () => {
      if (rustEngineRelayClient) {
        await rustEngineRelayClient.closeAll();
        return;
      }
      await rustEngineWorkspaceSessions?.closeAll();
      for (const workspaceId of relayTransportRoutes.workspaceIds()) {
        relayTransportRoutes.releaseWorkspace(workspaceId);
      }
    });
  }

  // Test-only daemon restart seam (hermetic E2E: the daemon-kill spec needs the
  // outage to outlive the transport retry window, which production restarts far
  // too fast to reach). Ignored outside DOHC_DESKTOP_TEST like every other
  // DOHC_TEST_* seam.
  function testEngineRestartOverrides(): {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
  } {
    if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return {};
    const backoff = Number(process.env.DOHC_TEST_ENGINE_RESTART_BACKOFF_MS);
    if (!Number.isFinite(backoff) || backoff <= 0) return {};
    return { initialBackoffMs: backoff, maxBackoffMs: backoff };
  }

  async function startRustEngineDaemon(): Promise<boolean> {
    const restartingPluginRuntimes = new Set<PluginWorkspaceRuntimes<CreatedWorkspace>>();
    // Everything, including resolving the binary path, runs inside the try: a
    // throw while building the options would otherwise reject this whenReady
    // callback and leave the user with no dialog, on the one path whose job is
    // to explain that the engine could not start.
    try {
      if (process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG) {
        if (!dependencies.existingOwnerFor) throw new Error("Owner session authority is unavailable.");
        ownerHostModule = await import("./desktopOwnerHost");
        ownerHostConfig = ownerHostModule.readDesktopOwnerHostConfig(process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG);
      }
      if (process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG) {
        if (!dependencies.ownerDeliveryCredentials || !workspaceAuthorities.withOperation) throw new Error("Owner delivery authority is unavailable.");
        ownerDeliveryModule = await import("./desktopOwnerDelivery");
        nativeOwnerDeliveryModule = await import("./nativeOwnerDelivery");
        ownerDeliveryConfig = ownerDeliveryModule.readDesktopOwnerDeliveryConfig(process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG);
      }
      if (!ownerHostConfig && !ownerDeliveryConfig && dependencies.serverOwnerDelivery) {
        if (!workspaceAuthorities.withOperation) throw new Error("Owner delivery authority is unavailable.");
        try {
          serverOwnerConfig = await dependencies.serverOwnerDelivery.prepare();
          serverOwnerUnavailable = false;
        } catch (error) {
          serverOwnerConfig = undefined; serverOwnerUnavailable = true;
          console.error("[desktop] owner live setup unavailable:", error);
        }
      }
      const hostIngress = ownerHostConfig && {configPath: ownerHostConfig.nativeConfigPath,
        client: {aggregateBytes: ownerHostConfig.transport.aggregateBytes, maxUploads: ownerHostConfig.transport.maxUploads}};
      const peerIngress = ownerDeliveryConfig && {configPath: ownerDeliveryConfig.nativeConfigPath, client: ownerDeliveryConfig.nativeClient};
      if (hostIngress && peerIngress && (hostIngress.configPath !== peerIngress.configPath ||
        hostIngress.client.aggregateBytes !== peerIngress.client.aggregateBytes || hostIngress.client.maxUploads !== peerIngress.client.maxUploads)) throw new Error("Private owner modes require the same native ingress configuration and client budget.");
      const ingress = hostIngress ?? peerIngress ?? (serverOwnerConfig && {configPath: serverOwnerConfig.nativeConfigPath, client: serverOwnerConfig.nativeClient});
      rustEngineDaemon = createRustEngineDaemon({
        ...(ingress ? {privateOwnerHost: ingress} : {}),
        ...testEngineRestartOverrides(),
        command: defaultEngineBinaryPath({
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
        }),
        onFailure: (error, terminal) => {
          if (terminal) {
            for (const runtimes of restartingPluginRuntimes) {
              runtimes.failEngineRestart(error);
            }
          }
          // The supervisor's diagnostic is for us: it names engine.ping, probe
          // counts and wedge budgets, which tell a developer or an agent exactly
          // which limit was hit. It goes to the log in full.
          console.error("[desktop] Rust engine daemon:", error);
          if (terminal && !isQuitting()) {
            // The dialog is for the user, so it says what broke and what to do
            // instead — no internal names, one instruction per sentence
            // (the dohc-interface skill). Use the same workspace engine name
            // as the runner settings.
            //
            // Cause-neutral on purpose: a terminal failure also arrives from the
            // restart limit and the crash window, where the engine crashed
            // rather than went silent. Every one of them ends the same way.
            dialog.showErrorBox(
              "The workspace engine stopped",
              "dohc stopped restarting the workspace engine.\n\n" +
                "Restart dohc. If this happens again, review the desktop logs. " +
                "If it continues, reinstall dohc.",
            );
          }
        },
        beforePublish: async () => {
          stopOwnerHost();
          await stopOwnerDelivery();
          await Promise.all(workspaceAuthorities.workspaceIds().map((workspaceId) =>
            workspaceAuthorities.withAuthority(workspaceId, (lease) => {
              const runtimes = lease.state.pluginRuntimes;
              restartingPluginRuntimes.add(runtimes);
              return runtimes.prepareForEngineRestart();
            }),
          ));
        },
        // A capture event can die with the previous daemon's transport after its
        // moment committed; the replacement never re-emits it (its baseline finds
        // disk and manifest agreeing). One repaint per healthy launch closes that
        // staleness window. Scope-free: the lost event could have belonged to
        // any open workspace.
        onLaunch: () => {
          startOwnerHost();
          startOwnerDelivery();
          for (const runtimes of restartingPluginRuntimes) {
            runtimes.resumeAfterEngineRestart();
          }
          restartingPluginRuntimes.clear();
          notifyRenderer();
        },
      });
      await rustEngineDaemon.start();
      // The daemon owns capture: its capture.momentRecorded events are the only
      // signal that a moment landed, so bridge them onto the renderer's
      // workspace-activity ping or the history timeline goes permanently stale.
      bridgeCaptureEventsToRenderer(rustEngineDaemon, notifyRenderer);
      // The daemon also records collection changes autonomously: its record
      // events are the only live signal behind a plugin's collections.watch
      // subscription, so route each one to the owning workspace's registry.
      bridgeRecordEventsToPlugins(rustEngineDaemon, (workspaceId) =>
        pluginWorkspaceRuntimes.current(workspaceId)?.workspaceEvents,
      );
      // The daemon also claims each local record change for its subscribed
      // automations (ADR 0008); its automation.claimed events wake the owning
      // workspace's executor to drain the durable claim table, and a claim
      // inserted already failed (the depth cap's chain-stopped stop report)
      // pokes the owner's failure notice instead.
      bridgeAutomationClaimsToExecutors(
        rustEngineDaemon,
        (workspaceId) => pluginWorkspaceRuntimes.current(workspaceId)?.automations,
        notifyAutomationFailuresChanged,
      );
      const relaySource = new RelayConfiguredDaemonClientSource(
        rustEngineDaemon,
        relayTransportRoutes,
      );
      rustEngineSessionSource = relaySource;
      // A fresh debug-engine adoption measured 18.7 s for 5,000 files and
      // 101.8 s for 15,000 files on the launch fixture; 120 s bounds that path
      // with headroom. The renderer names the wait.
      rustEngineWorkspaceSessions = new EngineWorkspaceSessions(relaySource, {
        workspaceOpenDeadlineMs: 120_000,
      });
      const sessions = rustEngineWorkspaceSessions;
      rustEngineRelayClient = new EngineRelayClient({
        sessions,
        routes: relayTransportRoutes,
        closeWorkspaceBinding: workspace => withOwnerHostPaused(
          ownerUsesWorkspace(workspace.workspaceId),
          () => sessions.closeWorkspaceBinding(workspace).catch(() => undefined),
        ),
      });
      startOwnerHost();
      startOwnerDelivery();
      console.info(
        "[desktop] Rust engine daemon handshake complete; startup smoke running.",
      );
      // Marked here, where the handshake actually completes — the bootstrap
      // gate's await also covers the cached-settings read, which would inflate
      // this mark.
      launchMarks.daemonReady();
      desktopMarks.markOnce("daemon-ready");
      logLaunchMarksOnce();
      return true;
    } catch (error) {
      stopOwnerHost();
      await stopOwnerDelivery();
      for (const runtimes of restartingPluginRuntimes) {
        runtimes.failEngineRestart(error);
      }
      const message =
        error instanceof Error ? error.message : "Unknown Rust engine startup error.";
      console.error("[desktop] Rust engine daemon failed to start:", error);
      dialog.showErrorBox(
        "Rust engine failed to start",
        `${message}\n\nThe desktop cannot start without the Rust engine.`,
      );
      // Contained: a stop() throw here would reject engineDaemonStartup itself,
      // skip the quit below, and rethrow from every gated await instead of
      // letting the quit land.
      await rustEngineDaemon?.stop().catch((stopError: unknown) => {
        console.error(
          "[desktop] Rust engine daemon stop after failed start:",
          stopError,
        );
      });
      rustEngineDaemon = null;
      rustEngineWorkspaceSessions = null;
      rustEngineRelayClient = null;
      rustEngineSessionSource = null;
      // The window may already be up — it loads while the daemon handshakes —
      // and by the time the user dismisses the dialog above, a restored tab can
      // hold edits (local reads and the plain editor never wait for the
      // daemon). So this quit goes through the ordinary path: before-quit
      // intercepts while a workspace window is live, and the quit guard's ask
      // lets the renderer flush or warn about that work — a destroy() here
      // would discard it with no beforeunload and no ask.
      app.quit();
      return false;
    }
  }

  return {
    retryOwnerDelivery(workspaceId: string): void {
      if (dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)) ownerDelivery?.retry?.(workspaceId);
    },
    ownerLiveDeliveryStatus(workspaceId: string): OwnerLiveDeliveryStatus | undefined {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) ? serverOwnerUnavailable ? "retrying" : ownerDeliveryStatus.get(workspaceId) : undefined;
    },
    ownerLiveDeliveryReason(workspaceId: string): OwnerLiveDeliveryReason | undefined {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) ? serverOwnerUnavailable ? "restart-required" : ownerDeliveryReason.get(workspaceId) : undefined;
    },
    get daemon() { return rustEngineDaemon; },
    get sessions() { return rustEngineWorkspaceSessions; },
    get relayClient() { return rustEngineRelayClient; },
    get startup() { return engineDaemonStartup; },
    requireEngineSessions,
    closeRelayTransportWorkspace,
    closeAllRelayTransportWorkspaces,
    start() {
      engineDaemonStartup = startRustEngineDaemon();
      return engineDaemonStartup;
    },
  };
}
