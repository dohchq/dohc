import { deriveSyncStatus } from "@dohc/workspace-core";
import type { SyncStatusResult } from "../ipc/bridgeContract";
import type { CloudSyncEngine } from "./relaySyncEngine";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  startWorkspaceWatch,
  type ActiveAgentRun,
  type WorkspaceWatchHandle,
} from "./workspaceWatcher";

// Retirement Phase C (WS-H1): the legacy .dohc/history read/write surface is
// gone from this layer — the engine capture is a workspace's only history.
// Legacy history left on disk by pre-flip versions is a read-only relic.

interface WatchedWorkspace {
  workspace: CreatedWorkspace;
  handle: WorkspaceWatchHandle;
  inFlight: boolean;
  lastSyncedAtMs: number | null;
  engine: CloudSyncEngine | null;
  // Per-workspace engine-capture singleton; null while the workspace is
  // explicitly opted out (or the capture build failed). Torn down in stopAll
  // AFTER the watcher stops so the final settled batch is captured before
  // shutdown completes.
  capture: WorkspaceEngineCapture | null;
  // True once captureFor resolved and produced NO capture: this workspace
  // records no history at all (engine opt-out, or a failed capture build).
  // Drives the persistent "History is off for this workspace" notice.
  historyRecordingOff: boolean;
  // Why the open-time settings read could not be trusted, straight from that
  // read. Null when the file read normally. The notice states THIS cause
  // instead of blaming the Settings toggle, and the renderer never answers
  // the question from a read of its own.
  settingsWarning: string | null;
  // True when building the recorder THREW (#505). The workspace records
  // nothing either way, but the cause is a failure, not the user's Settings
  // choice — the notice states which, so a real failure never wears the
  // opt-out's copy.
  historyRecordingUnavailable: boolean;
  // True when this workspace is a shared view (#540): no recorder by design.
  // Same rule as above — the cause travels with the decision so no consumer
  // has to guess it.
  historyShareView: boolean;
  // True while the engine capture (this workspace's SOLE history recorder)
  // is failing. Drives the persistent history-capture notice: set on the
  // first failed capture pass, cleared when a later pass succeeds, notify()
  // only on transitions so repeated failures never spam the UI.
  captureFailed: boolean;
  // The agent run whose writes this workspace's settled batches attribute to
  // right now; null when the local user is editing. AgentIntegration sets it.
  agentRun: ActiveAgentRun | null;
}

export interface WorkspaceActivityOptions {
  // Live facts main owns: whether this workspace has cloud sync enabled
  // (registry remote identity) and whether a cloud session exists right now.
  cloudStateFor?: (workspaceId: string) => { enabled: boolean; connected: boolean };
  // Builds a sync engine for a workspace when it is enabled AND connected;
  // null keeps the workspace local-only. Called on open and on enableCloud.
  // The options (joinBootstrap) ride through from enableCloud so a freshly
  // JOINED workspace's engine can be built pull-first (0P-C gate fix).
  engineFor?: (
    workspace: CreatedWorkspace,
    capture: WorkspaceEngineCapture | null,
    engineOptions?: { joinBootstrap?: boolean },
  ) => CloudSyncEngine | null;
  // Builds the watcher->engine capture for a workspace; a null capture
  // (explicit engine opt-out) leaves the workspace with NO history recorder.
  // Called once per open; main owns the flag read. The hooks are
  // activity-owned callbacks the builder must wire into the capture it
  // creates (they feed the workspace's history-capture notice state).
  captureFor?: (
    workspace: CreatedWorkspace,
    hooks: WorkspaceCaptureHooks,
  ) => Promise<WorkspaceCaptureDecision> | WorkspaceCaptureDecision;
  // Dormant R13b shadow observer. No shipping caller supplies it; a later
  // composition PR may use it to mirror successfully recorded activity into
  // the Rust adapter without affecting the live watcher/capture pipeline.
  onRustEngineShadowActivity?: (activity: {
    workspaceId: string;
    rootPath: string;
  }) => void | Promise<void>;
}

// What the open-time settings read decided: the recorder, and — when the file
// could not be trusted — why. Both come from ONE read, so the notice can never
// state a cause the capture decision did not have.
export interface WorkspaceCaptureDecision {
  capture: WorkspaceEngineCapture | null;
  warning?: string;
  // True for a shared view (#540): it is fed by the share's pull and never
  // gets a recorder of its own. A capability, not an opt-out and not a
  // failure — without this cause the null capture wears the opt-out's copy,
  // blaming a Settings toggle nobody touched.
  //
  // REQUIRED, like the contract field it feeds: an omitted boolean would
  // read as "not a shared view", and the sole producer of `true` could be
  // deleted without a compile error. A decision that cannot say must not
  // compile.
  shareView: boolean;
}

export interface WorkspaceCaptureHooks {
  // Wire into WorkspaceEngineCaptureOptions.onCaptureOutcome: each background
  // capture pass reports here, and the activity layer turns failure/recovery
  // transitions into the workspace's persistent capture-failure notice.
  onCaptureOutcome: (outcome: { ok: boolean }) => void;
  // Wire into WorkspaceEngineCaptureOptions.activeAgentRun: the workspace's
  // live agent-run slot, so settled batches captured while a dohc-tracked
  // run is active carry agent authorship into engine moments (PR 0N-1).
  activeAgentRun: () => ActiveAgentRun | null;
}

// Owns the live file-watch → engine-capture pipeline per workspace, the
// optional cloud sync engine riding on it, and the derived sync status. The
// desktop layer opens a workspace once; subsequent status reads are served
// from here, and activity pushes notify the UI.
export function createWorkspaceActivity(
  notify: () => void,
  options: WorkspaceActivityOptions = {},
) {
  const watched = new Map<string, WatchedWorkspace>();

  function statusFor(workspaceId: string): SyncStatusResult {
    const w = watched.get(workspaceId);
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
      cloudEnabled: cloud.enabled,
      // A confirmed-401 engine reads as disconnected (the existing
      // "cloud-disconnected" surface) so the UI stops saying "connected" and
      // prompts re-login, instead of spinning on a dead token.
      cloudConnected: cloud.connected && !(snap?.authExpired ?? false),
      lastSyncedAtMs: snap?.lastSyncedAtMs ?? w?.lastSyncedAtMs ?? null,
    });
    // Additive surface: the status bar shows HOW MANY files conflict, the
    // notice center shows when history capture is failing, and — post flag
    // flip — when a workspace records no history at all (engine opt-out;
    // the legacy recorder is retired).
    return {
      ...status,
      conflictCount,
      historyCaptureFailed: w?.captureFailed ?? false,
      historyRecordingOff: w?.historyRecordingOff ?? false,
      ...(w?.settingsWarning ? { settingsWarning: w.settingsWarning } : {}),
      historyRecordingUnavailable: w?.historyRecordingUnavailable ?? false,
      historyShareView: w?.historyShareView ?? false,
      syncFailing: snap?.syncFailing ?? false,
    };
  }

  async function open(workspace: CreatedWorkspace): Promise<SyncStatusResult> {
    if (!watched.has(workspace.workspaceId)) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: async () => {}, ready: Promise.resolve() },
        engine: null,
        capture: null,
        historyRecordingOff: false,
        settingsWarning: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        captureFailed: false,
        agentRun: null,
      };
      watched.set(workspace.workspaceId, entry);
      // Resolve the engine capture BEFORE the watcher starts: the watcher
      // records each settled batch into the engine (or nowhere, for an
      // opted-out workspace), so the mode must be known from the first
      // batch. A capture failure leaves the workspace with no recorder —
      // surfaced via the history-off notice — never a failed open.
      if (options.captureFor) {
        try {
          const decision =
            await options.captureFor(workspace, {
              // Live slot read: the capture stamps a settled batch with
              // whatever run is active at that moment (may flip between
              // batches within one open).
              activeAgentRun: () => entry.agentRun,
              onCaptureOutcome: ({ ok }) => {
                // Transition-only: the FIRST failure raises the notice, the
                // first success after a failure clears it, and repeated
                // failures (a persistently broken store retries every batch)
                // never re-notify.
                if (entry.captureFailed === !ok) return;
                entry.captureFailed = !ok;
                notify();
              },
            });
          // stopAll may have raced the capture build; stop the capture no
          // one will ever own instead of leaking its chain/store handle.
          if (watched.get(workspace.workspaceId) !== entry) {
            await decision.capture?.stop().catch(() => undefined);
            return statusFor(workspace.workspaceId);
          }
          entry.capture = decision.capture;
          entry.settingsWarning = decision.warning ?? null;
          entry.historyShareView = decision.shareView;
        } catch (error) {
          console.error(
            `[desktop] workspace engine capture unavailable for ${workspace.rootPath}:`,
            error,
          );
          // The build FAILED — the user chose nothing. Carry that apart from
          // the opt-out (#505) so the notice states the true cause. The error
          // itself stays in the log: it is developer-facing, and the notice
          // owes the user a state and a next step, not a stack.
          entry.historyRecordingUnavailable = true;
        }
        // No capture => no recorder of any kind (Phase C removed legacy
        // recording). Make that honest and visible, not silent.
        entry.historyRecordingOff = entry.capture === null;
      }
      // stopAll may have raced the capture build; do not start a watcher no
      // one will ever stop.
      if (watched.get(workspace.workspaceId) !== entry) {
        return statusFor(workspace.workspaceId);
      }
      entry.handle = startWorkspaceWatch(workspace, {
        // Non-null from the FIRST batch for engine workspaces; null records
        // nothing (opt-out).
        engineCapture: () => entry.capture,
        onRecorded: () => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          // Every settled local batch queues a (debounced) cloud push.
          entry.engine?.queueSync();
          notify();
          if (options.onRustEngineShadowActivity) {
            try {
              void Promise.resolve(
                options.onRustEngineShadowActivity({
                  workspaceId: workspace.workspaceId,
                  rootPath: workspace.rootPath,
                }),
              ).catch((error: unknown) => {
                console.error(
                  `[desktop] Rust engine shadow activity failed for ${workspace.rootPath}:`,
                  error,
                );
              });
            } catch (error) {
              console.error(
                `[desktop] Rust engine shadow activity failed for ${workspace.rootPath}:`,
                error,
              );
            }
          }
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
    return statusFor(workspace.workspaceId);
  }

  // Enable-sync path: build the engine now (registry remote was just set) and
  // wait for first contact so the caller can surface immediate failures.
  // joinBootstrap builds a pull-first engine for a freshly JOINED workspace:
  // its start() is the first pull, and no push can happen before that pull
  // succeeds (0P-C gate fix) — so a start() failure here means "nothing
  // arrived yet" and the join handler can roll the whole join back cleanly.
  async function enableCloud(
    workspace: CreatedWorkspace,
    engineOptions: { joinBootstrap?: boolean } = {},
  ): Promise<void> {
    const entry = watched.get(workspace.workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspace.workspaceId}`);
    if (entry.engine) return;
    const engine = options.engineFor?.(workspace, entry.capture, engineOptions) ?? null;
    if (!engine) throw new Error("Cloud sync requires a signed-in dohc Cloud session");
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
    notify();
  }

  // Failed-join rollback (0P-C gate fix): stop and forget ONE workspace —
  // watcher, engine, and capture — so the join handler can remove its
  // folder/registry state without tearing down every other workspace.
  async function close(workspaceId: string): Promise<void> {
    const entry = watched.get(workspaceId);
    if (!entry) return;
    watched.delete(workspaceId);
    await Promise.all([entry.handle.stop(), entry.engine?.stop() ?? Promise.resolve()]);
    await (entry.capture?.stop() ?? Promise.resolve());
    notify();
  }

  // After a login completes, attach engines to already-open cloud-enabled
  // workspaces that don't have one yet (they were opened local-only because no
  // session existed). engineFor returns null when the workspace is local-only
  // or signed into a different server.
  function reconcileCloud(
    engineFor: (
      workspace: CreatedWorkspace,
      capture: WorkspaceEngineCapture | null,
    ) => CloudSyncEngine | null,
  ): void {
    for (const entry of watched.values()) {
      if (entry.engine) continue;
      const engine = engineFor(entry.workspace, entry.capture);
      if (!engine) continue;
      entry.engine = engine;
      void engine.start();
    }
    notify();
  }

  // Logout path: stop and detach every cloud engine so edits after Disconnect
  // never push with the now-cleared session. The watchers keep running (local
  // history is unaffected).
  async function stopEngines(): Promise<void> {
    const stops: Array<Promise<void>> = [];
    for (const entry of watched.values()) {
      if (!entry.engine) continue;
      stops.push(entry.engine.stop().catch(() => undefined));
      entry.engine = null;
    }
    await Promise.all(stops);
    notify();
  }

  function getStatus(workspaceId: string): SyncStatusResult {
    return statusFor(workspaceId);
  }

  function listOpenWorkspaceIds(): string[] {
    return [...watched.keys()];
  }

  // Nudges the (debounced) sync engine outside the watcher path. Resolving a
  // conflict journals a replication op but may change NOTHING on disk
  // ("keep mine" keeps the local file byte-identical), so without this the
  // other machine's mirrored conflict would stay open until some unrelated
  // edit happened to trigger a push. No-op when the workspace has no engine.
  function queueCloudSync(workspaceId: string): void {
    watched.get(workspaceId)?.engine?.queueSync();
  }

  // Sets (or clears) the active agent run for an OPEN workspace. The engine
  // capture reads this slot when a batch settles, so writes made during the
  // run are attributed to the agent. Throws if the workspace isn't open — a
  // run can only attach to a live watcher.
  async function setAgentRun(
    workspaceId: string,
    run: ActiveAgentRun | null,
  ): Promise<void> {
    const entry = watched.get(workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    await entry.capture?.setActiveAgentRun(run);
    entry.agentRun = run;
  }

  async function claimAgentRun(
    workspaceId: string,
    run: ActiveAgentRun,
  ): Promise<boolean> {
    const entry = watched.get(workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
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
    workspaceId: string,
    agentRunId: string,
  ): Promise<void> {
    const entry = watched.get(workspaceId);
    if (!entry) return;
    if (entry.agentRun?.agentRunId !== agentRunId) return;
    await entry.capture?.setActiveAgentRun(null);
    if (entry.agentRun?.agentRunId === agentRunId) entry.agentRun = null;
  }

  function hasAgentRun(workspaceId: string): boolean {
    const entry = watched.get(workspaceId);
    return entry !== undefined && entry.agentRun !== null;
  }

  // Registers engine-originated disk writes (restore flows, future engine
  // API/MCP writes) so the watcher's engine capture does not re-record them.
  // Returns null when the workspace has no active engine capture — callers
  // then need no suppression because nothing engine-side is recording.
  function registerExpectedEngineEvents(
    workspaceId: string,
    events: Parameters<WorkspaceEngineCapture["registerExpectedEngineEvents"]>[0],
  ): (() => void) | null {
    const entry = watched.get(workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    return entry.capture?.registerExpectedEngineEvents(events) ?? null;
  }

  // The per-workspace engine capture instance (null when the workspace is
  // opted out or not open). Version-operation IPC handlers gate on this: no
  // capture, no versions surface.
  function engineCaptureFor(workspaceId: string): WorkspaceEngineCapture | null {
    return watched.get(workspaceId)?.capture ?? null;
  }

  // Resolves once every watcher has flushed AND its in-flight records are
  // written — the quit path awaits this so the last save is never dropped.
  // The engine capture stops AFTER its watcher: the watcher's final flush
  // enqueues the last batch, then capture.stop() awaits the capture chain so
  // the last engine record is durably written too.
  async function stopAll(): Promise<void> {
    const stops = [...watched.values()].map(async (w) => {
      await Promise.all([w.handle.stop(), w.engine?.stop() ?? Promise.resolve()]);
      await (w.capture?.stop() ?? Promise.resolve());
    });
    watched.clear();
    await Promise.all(stops);
  }

  return {
    open,
    close,
    enableCloud,
    reconcileCloud,
    stopEngines,
    getStatus,
    listOpenWorkspaceIds,
    queueCloudSync,
    setAgentRun,
    claimAgentRun,
    clearAgentRun,
    hasAgentRun,
    engineCaptureFor,
    registerExpectedEngineEvents,
    stopAll,
  };
}
