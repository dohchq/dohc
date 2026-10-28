import { isWorkspaceVisibilityPolicyPath } from "../ipc/bridgeContract";
import { workspaceRootsMatch } from "./workspaceRootsMatch";
import {
  deriveSyncStatus,
  type WatcherEvent,
} from "@dohc/workspace-core";
import type { EngineStoreRefusal } from "@dohc/workspace-engine-client";
import type { AgentRunStateEvent, SyncStatusResult } from "../ipc/bridgeContract";
import type { CloudSyncEngine } from "./relaySyncEngine";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineCaptureFailure,
} from "./workspaceEngineCapture";
import type { ActiveAgentRun } from "../agents/activeAgentRun";
import type { WorkspaceObservationCallbacks, WorkspaceObservationHandle } from "./workspaceFileObservation";
import type { WorkspaceActivityScope } from "../ipc/workspaceActivityBroadcast";

// The legacy.dohc/history read/write surface is
// gone from this layer — the engine capture is a workspace's only history.
// Legacy history left on disk by pre-flip versions is a read-only relic.

export interface ActivityWorkspace extends CreatedWorkspace {
  attachmentId: symbol;
}

interface WatchedWorkspace {
  workspace: ActivityWorkspace;
  handle: WorkspaceObservationHandle;
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
  fileObservationFailure: NonNullable<SyncStatusResult["fileObservationFailure"]> | null;
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
  // True once the engine reports that this workspace's drive cannot refuse to
  // replace a file. Sticky for the open workspace, so its notice shows once.
  atomicPlacementUnavailable: boolean;
  // True once the check finds the root on a network share.
  onNetworkShare: boolean;
  recoveryUnavailable: boolean;
  keptFiles: readonly (readonly [string, string])[];
  // Old file copies the engine keeps on a drive that cannot tell it whether
  // a program still uses one. Null until the engine first reports.
  retainedCopies: NonNullable<SyncStatusResult["retainedCopies"]> | null;
  heldFiles: NonNullable<SyncStatusResult["heldFiles"]>;
  // The engine's latest answer: Collection updates wait for an unfinished
  // pull. Asked at open and after sync passes, and kept as sync engines
  // attach and detach. Reads are numbered so an older answer that resolves
  // late cannot replace a newer one.
  collectionsWaiting: boolean;
  collectionsWaitingAsked: number;
  collectionsWaitingAnswered: number;
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
  // The run outlives capture when stopping sync restarts local activity.
  agentRun: { workspace: ActivityWorkspace; run: ActiveAgentRun } | null = null;
  preservedStatus: SyncStatusResult | null = null;
  liveSessionsGeneration = 0;
  // Sync paused while Collection updates waited, and the reopen that ends
  // the wait did not finish. Only the engine answering that nothing waits
  // clears it.
  syncPauseReopenFailed = false;
}

export interface WorkspaceActivityOptions {
  onHeldFiles?: (workspaceId: string, files: NonNullable<SyncStatusResult["heldFiles"]>) => void;
  observationFor: (workspace: ActivityWorkspace, callbacks: WorkspaceObservationCallbacks) => WorkspaceObservationHandle;
  onObservationResync?: (workspace: ActivityWorkspace) => Promise<void>;
  // Live facts main owns: whether this workspace has cloud sync enabled
  // (registry remote identity) and whether a cloud session exists right now.
  cloudStateFor?: (workspaceId: string) => { enabled: boolean; connected: boolean;
    syncPause?: SyncStatusResult["syncPause"];
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
  // The engine's answer: Collection updates wait for an unfinished pull. It
  // reads through the owner's open, so it answers only once that open, which
  // abandons a pull when sync is paused, succeeded.
  collectionsWaitingFor?: (workspace: ActivityWorkspace) => Promise<boolean>;
  // Whether the root is on a network share. Asked once per open, without
  // holding up the open.
  onNetworkShare?: (rootPath: string) => Promise<boolean>;
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
  // Whether this computer's agent is running changed in one workspace.
  onAgentRunState?: (event: AgentRunStateEvent) => void;
}

// A local agent run is any run holding the slot except the runner self-test.
function isAgentAtWork(run: ActiveAgentRun | null): boolean {
  return run !== null && run.dispatch !== "self-test";
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
  onAtomicPlacementUnavailable: () => void;
  onRecoveryUnavailable: (unavailable: boolean) => void;
  onKeptFiles: (paths: readonly (readonly [string, string])[]) => void;
  onRetainedCopies: (summary: NonNullable<SyncStatusResult["retainedCopies"]>) => void;
  onHeldFiles: (files: NonNullable<SyncStatusResult["heldFiles"]>) => void;
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

export async function settleYDocsAfterFileObservation(
  drains: readonly Promise<unknown>[],
  settleYDocs: () => Promise<void>,
): Promise<void> {
  await Promise.allSettled(drains);
  await settleYDocs();
}

// Owns the live file-watch → engine-capture pipeline per workspace, the
// optional cloud sync engine riding on it, and the derived sync status. The
// desktop layer opens a workspace once; subsequent status reads are served
// from here, and activity pushes notify the UI.
export function createWorkspaceActivity(
  // Scoped when the push concerns one workspace (main delivers it only to
  // windows with that workspace active); scope-free for the two pushes below
  // that change every synced workspace at once.
  notify: (scope?: WorkspaceActivityScope) => void,
  options: WorkspaceActivityOptions,
) {
  // Rises on every run state change, in any workspace.
  let agentRunRevision = 0;

  // The run state is read from the live slot only, never from stored runs.
  function agentRunState(
    workspace: Pick<ActivityWorkspace, "workspaceId">,
    state: WorkspaceActivityState,
  ): AgentRunStateEvent {
    return {
      workspaceId: workspace.workspaceId,
      revision: agentRunRevision,
      active: isAgentAtWork(state.agentRun?.run ?? null),
    };
  }

  function publishAgentRunState(workspaceId: string, active: boolean): void {
    agentRunRevision += 1;
    options.onAgentRunState?.({ workspaceId, revision: agentRunRevision, active });
  }

  // Every slot write goes through here, so each change pushes once.
  function assignAgentRun(
    state: WorkspaceActivityState,
    workspace: ActivityWorkspace,
    run: ActiveAgentRun | null,
  ): void {
    const was = isAgentAtWork(state.agentRun?.run ?? null);
    state.agentRun = run ? { workspace, run } : null;
    const active = isAgentAtWork(run);
    if (active !== was) {
      publishAgentRunState(workspace.workspaceId, active);
    }
  }

  // Empties the slot only while it still holds this run.
  function releaseAgentRun(
    state: WorkspaceActivityState,
    workspace: ActivityWorkspace,
    agentRunId: string,
  ): void {
    if (state.agentRun?.run.agentRunId === agentRunId) assignAgentRun(state, workspace, null);
  }

  function statusFor(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): SyncStatusResult {
    const { workspaceId } = workspace;
    const liveSessionsGeneration = state.liveSessionsGeneration;
    const cloud = options.cloudStateFor?.(workspaceId) ?? {
      enabled: false,
      connected: false,
    };
    const syncPause = cloud.syncPause;
    const preserved = state.preservedStatus;
    if (preserved) return { ...preserved, syncPause, liveSessionsGeneration };
    const w = state.entry;
    const snap = w?.engine?.snapshot();
    // Only an engine answer that nothing waits ends the wait: not a running
    // pass, and not signing in or out.
    const collectionsWaitingForSync: SyncStatusResult["collectionsWaitingForSync"] =
      state.syncPauseReopenFailed ? "reopen" : w?.collectionsWaiting ? "sync" : undefined;
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
      // prompts re-login, instead of spinning on a dead token. An engine
      // stopped on the relay API version reads the same way.
      cloudConnected: cloud.connected && !(snap?.authExpired ?? false) && !snap?.updateRequired,
      lastSyncedAtMs: snap?.lastSyncedAtMs ?? w?.lastSyncedAtMs ?? null,
    });
    // Additive surface: the status bar shows how many files conflict, and
    // the notice center shows when history capture is failing or when a
    // workspace records no history at all.
    const historyCaptureFailure = w?.historyCaptureFailure ?? null;
    const historyCaptureDetail = w?.historyCaptureDetail ?? null;
    const baseStatus = {
      ...status,
      ...(syncPause ? { syncPause } : {}),
      conflictCount,
      ...(snap?.claimingIdentity ? { claimingIdentity: true } : {}),
      ...(snap?.updateRequired ? { updateRequired: snap.updateRequired } : {}),
      historyRecordingUnavailable: w?.historyRecordingUnavailable ?? false,
      ...(w?.fileObservationFailure ? { fileObservationFailure: w.fileObservationFailure } : {}),
      historyShareView: w?.historyShareView ?? false,
      atomicPlacementUnavailable: w?.atomicPlacementUnavailable ?? false,
      ...(w?.onNetworkShare ? { onNetworkShare: true } : {}),
      recoveryUnavailable: w?.recoveryUnavailable ?? false,
      keptFiles: (w?.keptFiles ?? []).map(([original, copy]): [string, string] => [original, copy]),
      ...(w?.retainedCopies ? { retainedCopies: { ...w.retainedCopies } } : {}),
      heldFiles: w?.heldFiles ?? [],
      sharingDeclined: snap?.sharingDeclined ?? [],
      ownerAdmissionPending: snap?.ownerAdmissionPending ?? [],
      ...(collectionsWaitingForSync ? { collectionsWaitingForSync } : {}),
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

  // Transition-only: the first failure raises the notice, the first success
  // after a failure clears it, and repeated failures (a persistently broken
  // store retries every batch) never re-notify. The refusal classification
  // transitions the same way: a persistently refused store re-reports the
  // same code on every pass.
  function recordCaptureOutcome(
    entry: WatchedWorkspace,
    failure: "other" | EngineStoreRefusal | null,
    detail: string | null,
  ): void {
    if (
      entry.historyCaptureFailure === failure &&
      entry.historyCaptureDetail === detail
    ) {
      return;
    }
    entry.historyCaptureFailure = failure;
    entry.historyCaptureDetail = detail;
    notify({ workspaceId: entry.workspace.workspaceId });
  }

  // Sticky: the drive does not change while the workspace is open. The
  // engine's event and the health poll both land here; only the first
  // notifies.
  function markAtomicPlacementUnavailable(entry: WatchedWorkspace): void {
    if (entry.atomicPlacementUnavailable) return;
    entry.atomicPlacementUnavailable = true;
    notify({ workspaceId: entry.workspace.workspaceId });
  }

  function recordAtomicPlacementUnavailable(state: WorkspaceActivityState): void {
    if (state.entry) markAtomicPlacementUnavailable(state.entry);
  }

  // A shared view has no recorder, so its refresh is what reaches the store.
  // It reports the store's refusal here, or null once the store answered, so
  // the same status stops the workspace.
  function recordShareViewStoreRefusal(
    state: WorkspaceActivityState,
    refusal: EngineStoreRefusal | null,
    detail: string | null,
  ): void {
    const entry = state.entry;
    if (!entry?.historyShareView) return;
    recordCaptureOutcome(entry, refusal, refusal === null ? null : detail);
  }

  async function open(
    requestedWorkspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): Promise<SyncStatusResult> {
    const current = state.entry;
    const rootPath = current?.workspace.rootPath ?? state.agentRun?.workspace.rootPath;
    if (rootPath !== undefined && !workspaceRootsMatch(rootPath, requestedWorkspace.rootPath)) {
      throw new Error(
        "Workspace activity was replaced by another physical root.",
      );
    }
    const workspace = rootPath === undefined ? requestedWorkspace : { ...requestedWorkspace, rootPath };
    if (!current) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: async () => {}, ready: Promise.resolve(), pulledPaths: async () => {}, pullStarting: () => {}, pullFinished: () => {}, retry: async () => {} },
        engine: null,
        capture: null,
        historyRecordingUnavailable: false,
        fileObservationFailure: null,
        historyShareView: false,
        historyCaptureFailure: null,
        historyCaptureDetail: null,
        atomicPlacementUnavailable: false,
        onNetworkShare: false,
        recoveryUnavailable: false,
        keptFiles: [],
        retainedCopies: null,
        heldFiles: [],
        collectionsWaiting: false,
        collectionsWaitingAsked: 0,
        collectionsWaitingAnswered: 0,
      };
      state.entry = entry;
      void options.onNetworkShare?.(workspace.rootPath).then((shared) => {
        if (!shared || state.entry !== entry) return;
        entry.onNetworkShare = true;
        notify({ workspaceId: workspace.workspaceId });
      }, (error) => console.error(`[desktop] could not check whether ${workspace.rootPath} is on a network share:`, error));
      // Resolve the engine capture before the watcher starts, so the mode is
      // known from the first batch. A capture failure leaves the workspace
      // with no recorder, surfaced via the history-off notice, never a
      // failed open.
      if (options.captureFor) {
        try {
          const decision =
            await options.captureFor(workspace, {
              onCaptureOutcome: (failure, detail = null) =>
                recordCaptureOutcome(entry, failure, detail),
              onAtomicPlacementUnavailable: () => markAtomicPlacementUnavailable(entry),
              onRecoveryUnavailable: (unavailable) => {
                if (state.entry !== entry || entry.recoveryUnavailable === unavailable) return;
                entry.recoveryUnavailable = unavailable;
                notify({ workspaceId: workspace.workspaceId });
              },
              onKeptFiles: (paths) => {
                if (state.entry !== entry || JSON.stringify(paths) === JSON.stringify(entry.keptFiles)) return;
                entry.keptFiles = [...paths];
                notify({ workspaceId: workspace.workspaceId });
              },
              onRetainedCopies: (summary) => {
                const previous = entry.retainedCopies;
                if (state.entry !== entry || (previous?.count === summary.count && previous.bytes === summary.bytes)) return;
                entry.retainedCopies = { count: summary.count, bytes: summary.bytes };
                notify({ workspaceId: workspace.workspaceId });
              },
              onHeldFiles: (files) => {
                if (state.entry !== entry) return;
                recordHeldFiles(workspace, state, files);
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
          if (state.agentRun) {
            await entry.capture?.setActiveAgentRun(state.agentRun.run);
          }
        } catch (error) {
          console.error(
            `[desktop] workspace engine capture unavailable for ${workspace.rootPath}:`,
            error,
          );
          // The error itself stays in the log: it is developer-facing, and
          // the notice owes the user a state and a next step, not a stack.
          entry.historyRecordingUnavailable = true;
          const capture = entry.capture;
          entry.capture = null;
          await capture?.stop().catch(error => {
            console.error("[desktop] failed to stop unavailable workspace capture:", error);
          });
        }
      }
      // stopAll may have raced the capture build; do not start a watcher no
      // one will ever stop.
      if (state.entry !== entry) {
        return statusFor(workspace, state);
      }
      entry.handle = options.observationFor(workspace, {
        facts(facts) {
          if (state.entry !== entry && state.entry !== null) return;
          // Policy metadata refreshes names, not capture, automations or app discovery.
          const events: WatcherEvent[] = facts.filter(fact => !isWorkspaceVisibilityPolicyPath(fact.path, process.platform)).map(fact => ({ path: fact.path,
            operation: fact.kind === "disappeared" ? "delete" : "update" }));
          // Deletion suppression happens before any queued work or close.
          if (events.length) entry.capture?.observeFileEvents(events);
          if (state.entry !== entry) return;
          if (events.length) options.onWatcherBatch?.(workspace, events);
          notify({ workspaceId: workspace.workspaceId, paths: facts.map(fact => fact.path),
            pathSetChanged: facts.some(fact => fact.kind !== "changed") });
        },
        async resync() {
          if (state.entry !== entry && state.entry !== null) return;
          await entry.capture?.resyncFileObservation();
          if (state.entry !== entry) return;
          void options.onObservationResync?.(workspace).catch(error =>
            console.error(`[desktop] reload file consumers for ${workspace.workspaceId}:`, error));
          notify({ workspaceId: workspace.workspaceId });
        },
        captured(paths) {
          if (state.entry !== entry) return;
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          entry.engine?.queueSync();
          entry.engine?.queueWatchedUpload();
          notify({ workspaceId: workspace.workspaceId, paths, pathSetChanged: false });
        },
        pulled(paths) {
          if (state.entry !== entry) return;
          options.onWatcherBatch?.(workspace, paths.map(path => ({ path, operation: "update" })));
        },
        degraded(reason) {
          if (state.entry !== entry || entry.fileObservationFailure === reason) return;
          entry.fileObservationFailure = reason;
          notify({ workspaceId: workspace.workspaceId });
        },
      });
      // Startup reconciliation claims its capture-chain slot here, in the same
      // synchronous turn as the watcher start: a batch that settles inside the
      // ready race below would otherwise take the first slot, and
      // reconciliation would then record that batch's effects before the
      // baseline they landed on. The pass runs in the background — closed-period
      // edits become engine moments without blocking the open.
      entry.capture?.start();
      // Data-ready means the engine's observation baseline exists.
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entry.handle.ready,
          new Promise<void>(resolve => {
            readyTimer = setTimeout(() => {
              resolve();
            }, 5_000);
          }),
        ]);
      } finally {
        if (readyTimer) clearTimeout(readyTimer);
      }
      if (state.entry !== entry) return statusFor(workspace, state);
      const engine = options.engineFor?.(workspace, entry.capture) ?? null;
      if (engine) {
        entry.engine = engine;
        // Initial pull+push runs in the background; status updates stream in
        // through onChange/notify rather than blocking the open.
        void engine.start();
      }
      // A shared view pulls through its share and has no ordinary pull.
      if (options.collectionsWaitingFor && !entry.historyShareView) {
        void readCollectionsWaiting(workspace, state).catch(error =>
          console.error(`[desktop] Collections wait check failed for ${workspace.workspaceId}:`, error));
      }
    }
    state.preservedStatus = null;
    return statusFor(workspace, state);
  }

  // Asks the engine whether Collection updates wait for an unfinished pull,
  // and keeps the answer for this open unless a later read already
  // answered. An answer that nothing waits also ends a failed reopen after a
  // pause. Resolves the answer and whether the status changed.
  async function askCollectionsWaiting(
    state: WorkspaceActivityState,
    read: () => Promise<boolean>,
  ): Promise<{ waiting: boolean; changed: boolean }> {
    const entry = state.entry;
    const asked = entry ? ++entry.collectionsWaitingAsked : 0;
    const waiting = await read();
    if (state.entry !== entry) return { waiting, changed: false };
    if (entry) {
      if (asked < entry.collectionsWaitingAnswered) return { waiting, changed: false };
      entry.collectionsWaitingAnswered = asked;
    }
    const reopened = !waiting && state.syncPauseReopenFailed;
    if (entry && entry.collectionsWaiting === waiting && !reopened) return { waiting, changed: false };
    if (entry) entry.collectionsWaiting = waiting;
    if (reopened) state.syncPauseReopenFailed = false;
    return { waiting, changed: true };
  }

  async function readCollectionsWaiting(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): Promise<boolean> {
    const collectionsWaitingFor = options.collectionsWaitingFor;
    if (!collectionsWaitingFor) throw new Error("dohc cannot ask the engine about Collection updates.");
    const { waiting, changed } = await askCollectionsWaiting(state, () => collectionsWaitingFor(workspace));
    if (changed) notify({ workspaceId: workspace.workspaceId });
    return waiting;
  }

  // A sync pass ended. A failed pass can leave a pull unfinished, and only a
  // later pass can finish it, so the engine is asked after a failure and
  // while Collection updates wait. A failed read keeps the last answer. The
  // sync engine announces the change itself, once the pass has ended.
  async function syncPassEnded(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    failed: boolean,
    read: () => Promise<boolean>,
  ): Promise<boolean> {
    const entry = state.entry;
    if (!entry || (!failed && !entry.collectionsWaiting)) return false;
    try {
      return (await askCollectionsWaiting(state, read)).changed;
    } catch (error) {
      console.error(`[desktop] Collections wait check failed for ${workspace.workspaceId}:`, error);
      return false;
    }
  }

  // The pause saved, but the workspace did not reopen while Collection
  // updates waited for an unfinished pull.
  function recordSyncPauseReopenFailed(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): void {
    if (state.syncPauseReopenFailed) return;
    state.syncPauseReopenFailed = true;
    notify({ workspaceId: workspace.workspaceId });
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

  async function prepareSyncPause(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
  ): Promise<() => void> {
    const entry = state.entry;
    if (!entry) throw new Error("This workspace is not open. Open it and try again.");
    let resumeAdmission: (() => void) | undefined;
    try {
      resumeAdmission = await entry.capture?.settleAndCloseLiveSessionsForSyncPause();
      await entry.engine?.stop();
      entry.engine = null;
      return resumeAdmission ?? (() => {});
    } catch (error) {
      resumeAdmission?.();
      throw error;
    } finally {
      state.liveSessionsGeneration += 1;
      notify({ workspaceId: workspace.workspaceId });
    }
  }

  // Failed-join rollback (0P-C gate fix): stop and forget one workspace —
  // watcher, engine, and capture — so the join handler can remove its
  // folder/registry state without tearing down every other workspace.
  async function close(
    workspace: ActivityWorkspace,
    state: WorkspaceActivityState,
    closeOptions: { preserveStatus?: boolean; preserveAgentRun?: boolean; notify?: boolean;
      expectedRootPath?: string;
    } = {},
  ): Promise<boolean> {
    const { workspaceId } = workspace;
    const entry = state.entry;
    if (!entry) {
      if (!closeOptions.preserveAgentRun && state.agentRun &&
        (closeOptions.expectedRootPath === undefined || workspaceRootsMatch(state.agentRun.workspace.rootPath, closeOptions.expectedRootPath))) {
        assignAgentRun(state, workspace, null);
      }
      return false;
    }
    if (
      closeOptions.expectedRootPath !== undefined &&
      !workspaceRootsMatch(entry.workspace.rootPath, closeOptions.expectedRootPath)
    ) {
      return false;
    }
    if (closeOptions.preserveStatus) {
      state.preservedStatus = statusFor(workspace, state);
    } else {
      state.preservedStatus = null;
    }
    state.entry = null;
    if (!closeOptions.preserveAgentRun) assignAgentRun(state, workspace, null);
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => entry.handle.stop()).catch(async error => {
        entry.capture?.observationDrainFailed();
        await entry.capture?.resyncFileObservation();
        throw error;
      }),
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

  function recordHeldFiles(workspace: ActivityWorkspace, state: WorkspaceActivityState, files: NonNullable<SyncStatusResult["heldFiles"]>): void {
    const entry = state.entry;
    if (!entry || entry.workspace.attachmentId !== workspace.attachmentId || JSON.stringify(files) === JSON.stringify(entry.heldFiles)) return;
    entry.heldFiles = files;
    options.onHeldFiles?.(workspace.workspaceId, files);
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

  // One sync pass now, for work that must act on the relay's state, such
  // as Stop and restore between its passes. Throws unless the pass ended
  // without a failure on a connected engine.
  async function syncNow(state: WorkspaceActivityState): Promise<void> {
    const engine = state.entry?.engine;
    const unsynced = "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again.";
    if (!engine) throw new Error(unsynced);
    await engine.retryNow({ countsAsAttempt: false });
    const snapshot = engine.snapshot();
    if (snapshot.authExpired || snapshot.updateRequired || snapshot.syncFailure) throw new Error(unsynced);
  }

  // Pulls the workspace's own relay log for the Chats polls, where members'
  // replies to the DMs and Groups this workspace owns land. Records no local
  // change. No-op when the workspace has no engine.
  function queueCloudPull(state: WorkspaceActivityState): void {
    state.entry?.engine?.queuePull();
  }

  function pullStarting(state: WorkspaceActivityState): void { state.entry?.handle.pullStarting(); }
  function retryFileObservation(state: WorkspaceActivityState): Promise<void> {
    if (!state.entry) return Promise.reject(new Error("This workspace is not open."));
    return state.entry.handle.retry();
  }
  function pullFinished(state: WorkspaceActivityState): void { state.entry?.handle.pullFinished(); }
  function handlePulledPaths(state: WorkspaceActivityState, paths: readonly string[]): Promise<void> {
    return state.entry?.handle.pulledPaths(paths) ?? Promise.resolve();
  }
  async function drainObservations(state: WorkspaceActivityState): Promise<void> {
    const entry = state.entry;
    if (!entry) return;
    try { await entry.handle.stop(); }
    catch (error) {
      entry.capture?.observationDrainFailed();
      await entry.capture?.resyncFileObservation();
      throw error;
    }
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
    if (state.entry === entry) assignAgentRun(state, workspace, run);
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
      !workspaceRootsMatch(entry.workspace.rootPath, expectedRootPath)
    ) {
      throw new Error(
        "Workspace activity was replaced by another physical root.",
      );
    }
    if (state.agentRun !== null) return false;
    assignAgentRun(state, workspace, run);
    try {
      await entry.capture?.setActiveAgentRun(run);
      return true;
    } catch (error) {
      releaseAgentRun(state, workspace, run.agentRunId);
      throw error;
    }
  }

  async function clearAgentRun(
    state: WorkspaceActivityState,
    agentRunId: string,
    expectedRootPath?: string,
  ): Promise<void> {
    const slot = state.agentRun;
    if (!slot) return;
    if (
      expectedRootPath !== undefined &&
      !workspaceRootsMatch(slot.workspace.rootPath, expectedRootPath)
    ) {
      return;
    }
    if (slot.run.agentRunId !== agentRunId) return;
    await state.entry?.capture?.setActiveAgentRun(null);
    if (state.agentRun === slot) releaseAgentRun(state, slot.workspace, agentRunId);
  }

  function hasAgentRun(state: WorkspaceActivityState,
    expectedRootPath?: string,
  ): boolean {
    const slot = state.agentRun;
    return (
      slot !== null &&
      (expectedRootPath === undefined ||
        workspaceRootsMatch(slot.workspace.rootPath, expectedRootPath))
    );
  }

  // The chain depth an agent's writes declare while a run holds the slot:
  // the run's depth, or 0 with no run. An agent writing through the CLI or
  // MCP during the run writes at the run's depth, whichever agent it is.
  function agentRunDepth(state: WorkspaceActivityState): number {
    return state.agentRun?.run.depth ?? 0;
  }

  // The agent of a run dohc dispatched while it holds the slot, or null. The
  // CLI writes as that agent whatever name a write claims, so the run stays
  // one actor.
  function dispatchedAgent(state: WorkspaceActivityState): string | null {
    const run = state.agentRun?.run;
    return run?.dispatch !== undefined ? run.agentId : null;
  }

  // The engine's id for the run dohc dispatched while it holds the slot, or
  // null. The engine reads that run's agent from its record to choose whose
  // place in a thread the CLI reads and moves. A self-test has no record.
  function dispatchedRunId(state: WorkspaceActivityState): string | null {
    const run = state.agentRun?.run;
    return run?.dispatch === "run" ? run.agentRunId : null;
  }

  // The agent run holding the slot, as a local app's invocation is
  // attributed to it, or null with no run.
  function agentRun(state: WorkspaceActivityState): ActiveAgentRun | null {
    const run = state.agentRun?.run;
    return run ? { ...run } : null;
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
        !workspaceRootsMatch(entry.workspace.rootPath, expectedRootPath))
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
    if (state.entry) await close(state.entry.workspace, state, { notify: false });
    else if (state.agentRun) assignAgentRun(state, state.agentRun.workspace, null);
  }

  return {
    open,
    close,
    enableCloud,
    prepareSyncPause,
    recordSyncPauseReopenFailed,
    readCollectionsWaiting,
    syncPassEnded,
    reconcileCloud,
    stopEngine,
    getStatus,
    recordHeldFiles,
    recordShareViewStoreRefusal,
    recordAtomicPlacementUnavailable,
    isOpen,
    queueCloudSync,
    retryCloudSync,
    syncNow,
    queueCloudPull,
    pullStarting,
    retryFileObservation,
    pullFinished,
    handlePulledPaths,
    drainObservations,
    setAgentRun,
    claimAgentRun,
    clearAgentRun,
    hasAgentRun,
    agentRunDepth,
    dispatchedAgent,
    dispatchedRunId,
    agentRun,
    agentRunState,
    engineCaptureFor,
    workspaceRootPath,
    registerExpectedEngineEvents,
    stop,
  };
}
