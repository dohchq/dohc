import {
  deriveSyncStatus,
  type WatcherEvent,
} from "@dohc/workspace-core";
import type { EngineStoreRefusal } from "@dohc/workspace-engine-client";
import type { SyncStatusResult } from "../ipc/bridgeContract";
import type { CloudSyncEngine } from "./relaySyncEngine";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineCaptureFailure,
} from "./workspaceEngineCapture";
import {
  startWorkspaceWatch,
  type ActiveAgentRun,
  type WorkspaceWatchHandle,
} from "./workspaceWatcher";

// The legacy.dohc/history read/write surface is
// gone from this layer — the engine capture is a workspace's only history.
// Legacy history left on disk by pre-flip versions is a read-only relic.

export interface ActivityWorkspace extends CreatedWorkspace {
  attachmentId: symbol;
}

interface WatchedWorkspace {
  workspace: ActivityWorkspace;
  handle: WorkspaceWatchHandle;
  inFlight: boolean;
  lastSyncedAtMs: number | null;
  engine: CloudSyncEngine | null;
  // Per-workspace engine-capture singleton; null for a shared view or when
  // the capture build failed. Torn down in stopAll
  // after the watcher stops so the final settled batch is captured before
  // shutdown completes.
  capture: WorkspaceEngineCapture | null;
  // True when building the recorder threw: the cause is a failure,
  // not a capability, and the notice states which.
  historyRecordingUnavailable: boolean;
  // True when this workspace is a shared view: no recorder by design.
  // Same rule as above — the cause travels with the decision so no consumer
  // has to guess it.
  historyShareView: boolean;
  // One failure cause keeps the wire status from describing impossible
  // combinations. "other" means capture failed without a store refusal.
  historyCaptureFailure: "other" | EngineStoreRefusal | null;
  // The engine's own words for a refusal, for a report. Null when it gave
  // none or nothing is refused.
  historyCaptureDetail: string | null;
  // The agent run whose writes this workspace's settled batches attribute to
  // right now; null when the local user is editing. AgentIntegration sets it.
  agentRun: ActiveAgentRun | null;
}

/**
 * Mutable activity for one physical workspace attachment.
 *
 * The desktop workspace-authority owner constructs and retains this object.
 * Keeping it separate from the activity service prevents an old attachment's
 * watcher, capture, relay engine, or agent slot from being found through a
 * reused workspace id.
 */
export class WorkspaceActivityState {
  entry: WatchedWorkspace | null = null;
  preservedStatus: SyncStatusResult | null = null;
  liveSessionsGeneration = 0;
}

export interface WorkspaceActivityOptions {
  // Live facts main owns: whether this workspace has cloud sync enabled
  // (registry remote identity) and whether a cloud session exists right now.
  cloudStateFor?: (workspaceId: string) => { enabled: boolean; connected: boolean;
  };
  // Builds a sync engine for a workspace when it is enabled and connected;
  // null keeps the workspace local-only. Called on open and on enableCloud.
  // The options (joinBootstrap) ride through from enableCloud so a freshly
  // joined workspace's engine can be built pull-first (0P-C gate fix).
  engineFor?: (
    workspace: ActivityWorkspace,
    capture: WorkspaceEngineCapture | null,
    engineOptions?: { joinBootstrap?: boolean },
  ) => CloudSyncEngine | null;
  // Builds the watcher->engine capture for a workspace; a null capture
  // leaves the workspace with NO history recorder. Called once per open. The
  // hooks are
  // activity-owned callbacks the builder must wire into the capture it
  // creates (they feed the workspace's history-capture notice state).
  captureFor?: (
    workspace: ActivityWorkspace,
    hooks: WorkspaceCaptureHooks,
  ) => Promise<WorkspaceCaptureDecision> | WorkspaceCaptureDecision;
  // Receives the watcher's already-settled path-rich batch. The callback is
  // internal to main and runs before the path-free renderer notification.
  onWatcherBatch?: (
    workspace: ActivityWorkspace,
    events: readonly WatcherEvent[],
  ) => void;
}

// What the open-time gate decided: the recorder, and why there is none.
export interface WorkspaceCaptureDecision {
  capture: WorkspaceEngineCapture | null;
  // True for a shared view: it is fed by the share's pull and never
  // gets a recorder of its own. A capability, not a failure; the cause
  // travels with the decision so no consumer has to guess it.
  //
  // Required, like the contract field it feeds: an omitted boolean would
  // read as "not a shared view", and the sole producer of `true` could be
  // deleted without a compile error. A decision that cannot say must not
  // compile.
  shareView: boolean;
}

export interface WorkspaceCaptureHooks {
  onCaptureOutcome: (
    failure: WorkspaceEngineCaptureFailure,
    detail?: string | null,
  ) => void;
}

export async function closeWorkspaceActivityAndRelay(options: {
  closeActivity: () => Promise<void>;
  closeRelay?: () => Promise<void>;
  onRelayCloseError: (error: unknown) => void;
}): Promise<void> {
  await options.closeActivity();
  if (!options.closeRelay) return;
  try {
    await options.closeRelay();
  } catch (error) {
    options.onRelayCloseError(error);
  }
}

// Owns the live file-watch → engine-capture pipeline per workspace, the
// optional cloud sync engine riding on it, and the derived sync status. The
// desktop layer opens a workspace once; subsequent status reads are served
// from here, and activity pushes notify the UI.
export function createWorkspaceActivity(
  // Scoped when the push concerns one workspace (main delivers it only to
  // windows with that workspace active); scope-free for the two pushes below
  // that change every synced workspace at once.
  notify: (scope?: { workspaceId: string; paths?: readonly string[] }) => void,
  options: WorkspaceActivityOptions = {},
) {
  function statusFor(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): SyncStatusResult {
    const { workspaceId } = workspace;
    const liveSessionsGeneration = state.liveSessionsGeneration;
    const preserved = state.preservedStatus;
    if (preserved) return { ...preserved, liveSessionsGeneration };
    const w = state.entry;
    const cloud = options.cloudStateFor?.(workspaceId) ?? {
      enabled: false,
      connected: false,
    };
    const snap = w?.engine?.snapshot();
    const conflictCount = snap?.conflictCount ?? 0;
    const status = deriveSyncStatus({
      pendingChangeCount: snap?.pendingChangeCount ?? 0,
      inFlight: (w?.inFlight ?? false) || (snap?.syncing ?? false),
      hasConflict: conflictCount > 0,
      // A retry someone asked for shows as syncing until it ends.
      syncFailed: (snap?.syncFailure ?? null) !== null && !(snap?.retrying ?? false),
      cloudEnabled: cloud.enabled,
      // A confirmed-401 engine reads as disconnected (the existing
      // "cloud-disconnected" surface) so the UI stops saying "connected" and
      // prompts re-login, instead of spinning on a dead token.
      cloudConnected: cloud.connected && !(snap?.authExpired ?? false),
      lastSyncedAtMs: snap?.lastSyncedAtMs ?? w?.lastSyncedAtMs ?? null,
    });
    // Additive surface: the status bar shows how many files conflict, and
    // the notice center shows when history capture is failing or when a
    // workspace records no history at all.
    const historyCaptureFailure = w?.historyCaptureFailure ?? null;
    const historyCaptureDetail = w?.historyCaptureDetail ?? null;
    const baseStatus = {
      ...status,
      conflictCount,
      historyRecordingUnavailable: w?.historyRecordingUnavailable ?? false,
      historyShareView: w?.historyShareView ?? false,
      sharingDeclined: snap?.sharingDeclined ?? [],
      ownerAdmissionPending: snap?.ownerAdmissionPending ?? [],
      ...(snap?.syncFailure ? { syncFailure: snap.syncFailure } : {}),
      liveSessionsGeneration,
    };
    if (historyCaptureFailure) {
      return {
        ...baseStatus,
        historyCaptureFailed: true,
        engineStoreRefused:
          historyCaptureFailure === "other" ? null : historyCaptureFailure,
        ...(historyCaptureFailure !== "other" && historyCaptureDetail
          ? { engineStoreRefusedDetail: historyCaptureDetail }
          : {}),
      };
    }
    return baseStatus;
  }

  async function open(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): Promise<SyncStatusResult> {
    const current = state.entry;
    if (current && current.workspace.rootPath !== workspace.rootPath) {
      throw new Error(
        "Workspace activity was replaced by another physical root.",
      );
    }
    if (!current) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: async () => {}, ready: Promise.resolve() },
        engine: null,
        capture: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        historyCaptureFailure: null,
        historyCaptureDetail: null,
        agentRun: null,
      };
      state.entry = entry;
      // Resolve the engine capture before the watcher starts, so the mode is
      // known from the first batch. A capture failure leaves the workspace
      // with no recorder, surfaced via the history-off notice, never a
      // failed open.
      if (options.captureFor) {
        try {
          const decision =
            await options.captureFor(workspace, {
              onCaptureOutcome: (failure, detail = null) => {
                // Transition-only: the first failure raises the notice, the
                // first success after a failure clears it, and repeated
                // failures (a persistently broken store retries every batch)
                // never re-notify. The refusal classification transitions the
                // same way: a persistently refused store re-reports
                // the same code on every pass.
                if (
                  entry.historyCaptureFailure === failure &&
                  entry.historyCaptureDetail === detail
                ) {
                  return;
                }
                entry.historyCaptureFailure = failure;
                entry.historyCaptureDetail = detail;
                notify({ workspaceId: workspace.workspaceId });
              },
            });
          // stopAll may have raced the capture build; stop the capture no
          // one will ever own instead of leaking its chain/store handle.
          if (state.entry !== entry) {
            await decision.capture?.stop().catch(() => undefined);
            return statusFor(workspace, state);
          }
          entry.capture = decision.capture;
          entry.historyShareView = decision.shareView;
        } catch (error) {
          console.error(
            `[desktop] workspace engine capture unavailable for ${workspace.rootPath}:`,
            error,
          );
          // The error itself stays in the log: it is developer-facing, and
          // the notice owes the user a state and a next step, not a stack.
          entry.historyRecordingUnavailable = true;
        }
      }
      // stopAll may have raced the capture build; do not start a watcher no
      // one will ever stop.
      if (state.entry !== entry) {
        return statusFor(workspace, state);
      }
      entry.handle = startWorkspaceWatch(workspace, {
        // Non-null from the first batch; null records nothing.
        engineCapture: () => entry.capture,
        onSettledBatch: (events) => options.onWatcherBatch?.(workspace, events),
        onRecorded: (events) => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          // Every settled local batch queues a (debounced) cloud push.
          entry.engine?.queueSync();
          notify({
            workspaceId: workspace.workspaceId,
            paths: events.map((event) => event.path),
          });
        },
      });
      // Startup reconciliation claims its capture-chain slot here, in the same
      // synchronous turn as the watcher start: a batch that settles inside the
      // ready race below would otherwise take the first slot, and
      // reconciliation would then record that batch's effects before the
      // baseline they landed on. The pass runs in the background — closed-period
      // edits become engine moments without blocking the open.
      entry.capture?.start();
      // Don't report the workspace open until the watcher's initial scan is
      // done — a write made right after openWorkspace resolves is guaranteed
      // observed. Bounded so a pathological scan can't hang the renderer.
      await Promise.race([
        entry.handle.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      const engine = options.engineFor?.(workspace, entry.capture) ?? null;
      if (engine) {
        entry.engine = engine;
        // Initial pull+push runs in the background; status updates stream in
        // through onChange/notify rather than blocking the open.
        void engine.start();
      }
    }
    state.preservedStatus = null;
    return statusFor(workspace, state);
  }

  // Enable-sync path: build the engine now (registry remote was just set) and
  // wait for first contact so the caller can surface immediate failures.
  // joinBootstrap builds a pull-first engine for a freshly joined workspace:
  // its start() is the first pull, and no push can happen before that pull
  // succeeds (0P-C gate fix) — so a start() failure here means "nothing
  // arrived yet" and the join handler can roll the whole join back cleanly.
  async function enableCloud(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    engineOptions: { joinBootstrap?: boolean } = {},
  ): Promise<void> {
    const entry = state.entry;
    if (!entry) throw new Error(`Workspace is not open: ${workspace.workspaceId}`);
    if (entry.engine) return;
    const engine = options.engineFor?.(workspace, entry.capture, engineOptions) ?? null;
    if (!engine) throw new Error("Cloud sync requires a signed-in server session");
    entry.engine = engine;
    try {
      // Propagate first-contact failure: a dead token must surface here, not be
      // swallowed while the UI claims sync is enabled.
      await engine.start();
    } catch (error) {
      // Roll back so a retry can re-attach a fresh engine.
      await engine.stop().catch(() => undefined);
      entry.engine = null;
      throw error;
    }
    notify({ workspaceId: workspace.workspaceId });
  }

  // Failed-join rollback (0P-C gate fix): stop and forget one workspace —
  // watcher, engine, and capture — so the join handler can remove its
  // folder/registry state without tearing down every other workspace.
  async function close(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    closeOptions: { preserveStatus?: boolean; notify?: boolean;
      expectedRootPath?: string;
    } = {},
  ): Promise<boolean> {
    const { workspaceId } = workspace;
    const entry = state.entry;
    if (!entry) return false;
    if (
      closeOptions.expectedRootPath !== undefined &&
      entry.workspace.rootPath !== closeOptions.expectedRootPath
    ) {
      return false;
    }
    if (closeOptions.preserveStatus) {
      state.preservedStatus = statusFor(workspace, state);
    } else {
      state.preservedStatus = null;
    }
    state.entry = null;
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => entry.handle.stop()),
      Promise.resolve().then(() => entry.engine?.stop()),
    ]);
    const liveSessionsRetired = await Promise.allSettled([
      Promise.resolve().then(() =>
        entry.capture?.settleAndCloseAllLiveSessions(),
      ),
    ]);
    if (entry.capture) {
      state.liveSessionsGeneration += 1;
    }
    const captureStopped = await Promise.allSettled([
      Promise.resolve().then(() => entry.capture?.stop()),
    ]);
    if (closeOptions.notify !== false) notify({ workspaceId });
    const failed = [...stopped, ...liveSessionsRetired, ...captureStopped].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
    return true;
  }

  // After a login completes, attach engines to already-open cloud-enabled
  // workspaces that don't have one yet (they were opened local-only because no
  // session existed). engineFor returns null when the workspace is local-only
  // or signed into a different server.
  function reconcileCloud(
    state: WorkspaceActivityState,
    engineFor: (
      workspace: CreatedWorkspace,
      capture: WorkspaceEngineCapture | null,
    ) => CloudSyncEngine | null,
    notifyChange = true,
  ): void {
    const entry = state.entry;
    if (entry && !entry.engine) {
      const engine = engineFor(entry.workspace, entry.capture);
      if (engine) {
        entry.engine = engine;
        void engine.start();
      }
    }
    // Scope-free: the login just re-attached engines across workspaces, so
    // every window's sync status may have changed.
    if (notifyChange) notify();
  }

  // Logout path: stop and detach every cloud engine so edits after Disconnect
  // never push with the now-cleared session. The watchers keep running (local
  // history is unaffected).
  async function stopEngine(
    state: WorkspaceActivityState,
    notifyChange = true,
  ): Promise<void> {
    const engine = state.entry?.engine;
    if (state.entry) state.entry.engine = null;
    await engine?.stop().catch(() => undefined);
    // Scope-free: logout detached every workspace's engine at once.
    if (notifyChange) notify();
  }

  function getStatus(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): SyncStatusResult {
    return statusFor(workspace, state);
  }

  function isOpen(state: WorkspaceActivityState): boolean {
    return state.entry !== null;
  }

  // Nudges the (debounced) sync engine outside the watcher path. Resolving a
  // conflict journals a replication op but may change nothing on disk
  // ("keep mine" keeps the local file byte-identical), so without this the
  // other machine's mirrored conflict would stay open until some unrelated
  // edit happened to trigger a push. No-op when the workspace has no engine.
  function queueCloudSync(state: WorkspaceActivityState): void {
    state.entry?.engine?.queueSync();
  }

  // The person asked to sync now, from a sync failure's Try again. Runs a
  // pass without waiting out the backoff and settles when it ends; the
  // outcome is in the status. No-op when the workspace has no engine.
  function retryCloudSync(
    state: WorkspaceActivityState,
    reason: "person" | "reconnect",
  ): Promise<void> {
    return (
      state.entry?.engine?.retryNow({ countsAsAttempt: reason === "person" }) ??
      Promise.resolve()
    );
  }

  // Sets (or clears) the active agent run for an open workspace. The engine
  // capture reads this slot when a batch settles, so writes made during the
  // run are attributed to the agent. Throws if the workspace isn't open — a
  // run can only attach to a live watcher.
  async function setAgentRun(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    run: ActiveAgentRun | null,
  ): Promise<void> {
    const entry = state.entry;
    const { workspaceId } = workspace;
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    await entry.capture?.setActiveAgentRun(run);
    entry.agentRun = run;
  }

  async function claimAgentRun(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    run: ActiveAgentRun,
    expectedRootPath?: string,
  ): Promise<boolean> {
    const { workspaceId } = workspace;
    const entry = state.entry;
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    if (
      expectedRootPath !== undefined &&
      entry.workspace.rootPath !== expectedRootPath
    ) {
      throw new Error(
        "Workspace activity was replaced by another physical root.",
      );
    }
    if (entry.agentRun !== null) return false;
    entry.agentRun = run;
    try {
      await entry.capture?.setActiveAgentRun(run);
      return true;
    } catch (error) {
      if (entry.agentRun?.agentRunId === run.agentRunId) entry.agentRun = null;
      throw error;
    }
  }

  async function clearAgentRun(
    state: WorkspaceActivityState,
    agentRunId: string,
    expectedRootPath?: string,
  ): Promise<void> {
    const entry = state.entry;
    if (!entry) return;
    if (
      expectedRootPath !== undefined &&
      entry.workspace.rootPath !== expectedRootPath
    ) {
      return;
    }
    if (entry.agentRun?.agentRunId !== agentRunId) return;
    await entry.capture?.setActiveAgentRun(null);
    if (entry.agentRun?.agentRunId === agentRunId) entry.agentRun = null;
  }

  function hasAgentRun(state: WorkspaceActivityState,
    expectedRootPath?: string,
  ): boolean {
    const entry = state.entry;
    return (
      entry !== null &&
      (expectedRootPath === undefined ||
        entry.workspace.rootPath === expectedRootPath) && entry.agentRun !== null
    );
  }

  // Registers engine-originated disk writes (restore flows, future engine
  // API/MCP writes) so the watcher's engine capture does not re-record them.
  // Returns null when the workspace has no active engine capture — callers
  // then need no suppression because nothing engine-side is recording.
  function registerExpectedEngineEvents(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    events: Parameters<WorkspaceEngineCapture["registerExpectedEngineEvents"]>[0],
  ): (() => void) | null {
    const { workspaceId } = workspace;
    const entry = state.entry;
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    return entry.capture?.registerExpectedEngineEvents(events) ?? null;
  }

  // The per-workspace engine capture instance (null when the workspace has
  // no capture or is not open). Version-operation IPC handlers gate on this: no
  // capture, no versions surface.
  function engineCaptureFor(state: WorkspaceActivityState,
    expectedRootPath?: string,
  ): WorkspaceEngineCapture | null {
    const entry = state.entry;
    if (
      !entry ||
      (expectedRootPath !== undefined &&
        entry.workspace.rootPath !== expectedRootPath)
    ) {
      return null;
    }
    return entry.capture;
  }

  function workspaceRootPath(state: WorkspaceActivityState): string | null {
    return state.entry?.workspace.rootPath ?? null;
  }

  // Resolves once every watcher has flushed and its in-flight records are
  // written — the quit path awaits this so the last save is never dropped.
  // The engine capture stops after its watcher: the watcher's final flush
  // enqueues the last batch, then capture.stop() awaits the capture chain so
  // the last engine record is durably written too.
  async function stop(state: WorkspaceActivityState): Promise<void> {
    const entry = state.entry;
    state.entry = null;
    state.preservedStatus = null;
    if (!entry) return;
    await Promise.all([
      entry.handle.stop(),
      entry.engine?.stop() ?? Promise.resolve(),
    ]);
    await (entry.capture?.stop() ?? Promise.resolve());
  }

  return {
    open,
    close,
    enableCloud,
    reconcileCloud,
    stopEngine,
    getStatus,
    isOpen,
    queueCloudSync,
    retryCloudSync,
    setAgentRun,
    claimAgentRun,
    clearAgentRun,
    hasAgentRun,
    engineCaptureFor,
    workspaceRootPath,
    registerExpectedEngineEvents,
    stop,
  };
}
