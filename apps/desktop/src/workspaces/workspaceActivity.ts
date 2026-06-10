import { deriveSyncStatus, type SyncStatus } from "@dohc/workspace-core";
import type {
  ChangeSetRecord,
  SyncStatusResult,
} from "../ipc/bridgeContract";
import type { CloudSyncEngine } from "./cloudSyncEngine";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  createChangeSetStore,
  humanSummary,
  startWorkspaceWatch,
  type WorkspaceWatchHandle,
} from "./workspaceWatcher";

interface WatchedWorkspace {
  workspace: CreatedWorkspace;
  handle: WorkspaceWatchHandle;
  inFlight: boolean;
  lastSyncedAtMs: number | null;
  engine: CloudSyncEngine | null;
}

export interface WorkspaceActivityOptions {
  // Live facts main owns: whether this workspace has cloud sync enabled
  // (registry remote identity) and whether a cloud session exists right now.
  cloudStateFor?: (workspaceId: string) => { enabled: boolean; connected: boolean };
  // Builds a sync engine for a workspace when it is enabled AND connected;
  // null keeps the workspace local-only. Called on open and on enableCloud.
  engineFor?: (workspace: CreatedWorkspace) => CloudSyncEngine | null;
}

// Owns the live file-watch → history pipeline per workspace, the optional
// cloud sync engine riding on it, and the derived sync status. The desktop
// layer opens a workspace once; subsequent timeline and status reads are
// served from here, and activity pushes notify the UI.
export function createWorkspaceActivity(
  notify: () => void,
  options: WorkspaceActivityOptions = {},
) {
  const watched = new Map<string, WatchedWorkspace>();

  function statusFor(workspaceId: string): SyncStatus {
    const w = watched.get(workspaceId);
    const cloud = options.cloudStateFor?.(workspaceId) ?? {
      enabled: false,
      connected: false,
    };
    const snap = w?.engine?.snapshot();
    return deriveSyncStatus({
      pendingChangeCount: snap?.pendingChangeCount ?? 0,
      inFlight: (w?.inFlight ?? false) || (snap?.syncing ?? false),
      hasConflict: (snap?.conflictCount ?? 0) > 0,
      cloudEnabled: cloud.enabled,
      cloudConnected: cloud.connected,
      lastSyncedAtMs: snap?.lastSyncedAtMs ?? w?.lastSyncedAtMs ?? null,
    });
  }

  async function open(workspace: CreatedWorkspace): Promise<SyncStatusResult> {
    if (!watched.has(workspace.workspaceId)) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: async () => {}, ready: Promise.resolve() },
        engine: null,
      };
      watched.set(workspace.workspaceId, entry);
      entry.handle = startWorkspaceWatch(workspace, {
        onRecorded: () => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          // Every settled local change set queues a (debounced) cloud push.
          entry.engine?.queueSync();
          notify();
        },
      });
      // Don't report the workspace open until the watcher's initial scan is
      // done — a write made right after openWorkspace resolves is guaranteed
      // observed. Bounded so a pathological scan can't hang the renderer.
      await Promise.race([
        entry.handle.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      const engine = options.engineFor?.(workspace) ?? null;
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
  async function enableCloud(workspace: CreatedWorkspace): Promise<void> {
    const entry = watched.get(workspace.workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspace.workspaceId}`);
    if (entry.engine) return;
    const engine = options.engineFor?.(workspace) ?? null;
    if (!engine) throw new Error("Cloud sync requires a signed-in dohc Cloud session");
    entry.engine = engine;
    await engine.start();
    notify();
  }

  async function listChangeSets(
    workspace: CreatedWorkspace,
  ): Promise<ChangeSetRecord[]> {
    const store = createChangeSetStore(workspace.rootPath);
    const records = await store.list();
    return records.map((record) => ({
      id: record.id,
      recordedAtMs: record.recordedAtMs,
      kind: record.kind,
      author: record.author,
      summary: record.summary,
      humanSummary: humanSummary(record),
      fileCount: record.files.length,
    }));
  }

  function getStatus(workspaceId: string): SyncStatusResult {
    return statusFor(workspaceId);
  }

  // Resolves once every watcher has flushed AND its in-flight records are
  // written — the quit path awaits this so the last save is never dropped.
  async function stopAll(): Promise<void> {
    const stops = [...watched.values()].flatMap((w) => [
      w.handle.stop(),
      w.engine?.stop() ?? Promise.resolve(),
    ]);
    watched.clear();
    await Promise.all(stops);
  }

  return { open, enableCloud, listChangeSets, getStatus, stopAll };
}
