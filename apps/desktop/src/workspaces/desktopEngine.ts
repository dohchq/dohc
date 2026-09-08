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
import type { WorkspaceAuthorityLease } from "./workspaceAuthorityOwner";
import type { PluginWorkspaceRuntimes } from "../plugins/pluginWorkspaceRuntimes";
import type { launchMarks as launchMarksImplementation } from "../performance/launchMarks";
import type { desktopMarks as desktopMarksImplementation } from "../performance/desktopMarks";
import {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {ExistingOwnerDeviceConfig} from "@dohc/sync-relay/device-host";
import {readDesktopOwnerHostConfig,startDesktopOwnerHost} from "./desktopOwnerHost";

type EngineAuthorityState = {
  pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace>;
};

interface DesktopEngineDependencies<State extends EngineAuthorityState> {
  existingOwnerFor?: ExistingOwnerDeviceConfig["ownerFor"];
  app: Pick<App, "isPackaged" | "getAppPath" | "quit">;
  dialog: Pick<Dialog, "showErrorBox">;
  process: { env: NodeJS.ProcessEnv; resourcesPath?: string };
  createRustEngineDaemon: typeof createRustEngineDaemonImplementation;
  defaultEngineBinaryPath: typeof defaultEngineBinaryPathImplementation;
  isQuitting(): boolean;
  workspaceAuthorities: {
    workspaceIds(): string[];
    withAuthority<Result>(
      workspaceId: string,
      work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  pluginWorkspaceRuntimes: Pick<PluginWorkspaceRuntimes<CreatedWorkspace>, "current">;
  notifyRenderer(scope?: WorkspaceActivityScope): void;
  notifyAutomationFailuresChanged(workspaceId: string): void;
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
  let ownerHost: ReturnType<typeof startDesktopOwnerHost> | undefined;
  let ownerHostConfig: ReturnType<typeof readDesktopOwnerHostConfig> | undefined;
  const startOwnerHost = () => {
    ownerHost?.stop(); ownerHost = undefined;
    if (!ownerHostConfig || !rustEngineDaemon || !rustEngineWorkspaceSessions || !dependencies.existingOwnerFor) return;
    const daemon = rustEngineDaemon, sessions = rustEngineWorkspaceSessions, config = ownerHostConfig;
    ownerHost = startDesktopOwnerHost({config,ownerFor: dependencies.existingOwnerFor,
      onError: error => console.error("[desktop] owner host connection failed:",error),
      bindings: async () => {
        const client = daemon.currentClient();
        if (!(client instanceof EngineClient)) throw new Error("Owner host requires the desktop daemon client.");
        const workspaces = [];
        for (const workspaceId of config.workspaceIds) {
          workspaces.push(await workspaceAuthorities.withAuthority(workspaceId,async lease => {
            lease.assertCurrent();
            const workspace = {workspaceId,rootPath: lease.binding.canonicalRootPath,attachmentId: lease.binding.attachmentId};
            return sessions.run(workspace, async binding => {
              lease.assertCurrent();
              if (binding.client !== client) throw new Error("Owner host daemon changed.");
              return {workspaceId,workspaceHandle: binding.workspace};
            });
          }));
        }
        return {client,workspaces,assertCurrent: () => {
          if (isQuitting() || daemon.currentClient() !== client) throw new Error("Owner host daemon retired.");
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

  async function closeRelayTransportWorkspace(
    workspace: string | EngineWorkspace,
  ): Promise<void> {
    const workspaceId =
      typeof workspace === "string" ? workspace : workspace.workspaceId;
    if (rustEngineRelayClient) {
      await rustEngineRelayClient.closeWorkspace(workspace);
      return;
    }
    await rustEngineWorkspaceSessions?.closeWorkspace(workspace);
    relayTransportRoutes.releaseWorkspace(workspaceId);
  }

  async function closeAllRelayTransportWorkspaces(): Promise<void> {
    ownerHost?.stop(); ownerHost = undefined;
    if (rustEngineRelayClient) {
      await rustEngineRelayClient.closeAll();
      return;
    }
    await rustEngineWorkspaceSessions?.closeAll();
    for (const workspaceId of relayTransportRoutes.workspaceIds()) {
      relayTransportRoutes.releaseWorkspace(workspaceId);
    }
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
        ownerHostConfig = readDesktopOwnerHostConfig(process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG);
      }
      rustEngineDaemon = createRustEngineDaemon({
        ...(ownerHostConfig ? {privateOwnerHost: {configPath: ownerHostConfig.nativeConfigPath,
          client: {aggregateBytes: ownerHostConfig.transport.aggregateBytes,maxUploads: ownerHostConfig.transport.maxUploads}}} : {}),
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
            // (the dohc-interface skill). "The workspace engine" is the noun the
            // shipping UI already uses for this (SettingsDialog, StatusBar,
            // NoticeCenter), so this must not invent another one.
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
          ownerHost?.stop(); ownerHost = undefined;
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
      // A fresh debug-engine adoption measured 18.7 s for 5,000 files and
      // 101.8 s for 15,000 files on the launch fixture; 120 s bounds that path
      // with headroom. The renderer names the wait.
      rustEngineWorkspaceSessions = new EngineWorkspaceSessions(relaySource, {
        workspaceOpenDeadlineMs: 120_000,
      });
      rustEngineRelayClient = new EngineRelayClient({
        sessions: rustEngineWorkspaceSessions,
        routes: relayTransportRoutes,
      });
      startOwnerHost();
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
