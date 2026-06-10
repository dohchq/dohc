import { deriveSyncStatus, type SyncStatus } from "@dohc/workspace-core";
import type {
  ChangeSetRecord,
  SyncStatusResult,
} from "../ipc/bridgeContract";
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
}

// Owns the live file-watch → history pipeline per workspace and the derived
// sync status. The desktop layer opens a workspace once; subsequent timeline
// and status reads are served from here, and activity pushes notify the UI.
export function createWorkspaceActivity(notify: () => void) {
  const watched = new Map<string, WatchedWorkspace>();

  function statusFor(workspaceId: string): SyncStatus {
    const w = watched.get(workspaceId);
    // Local-only today: nothing is "pending" (edits save immediately) and no
    // cloud, so state is synced unless a batch is being recorded. Cloud and
    // conflict states become reachable in Phases 9/10 through the same
    // deriveSyncStatus inputs.
    return deriveSyncStatus({
      pendingChangeCount: 0,
      inFlight: w?.inFlight ?? false,
      hasConflict: false,
      cloudEnabled: false,
      cloudConnected: false,
      lastSyncedAtMs: w?.lastSyncedAtMs ?? null,
    });
  }

  async function open(workspace: CreatedWorkspace): Promise<SyncStatusResult> {
    if (!watched.has(workspace.workspaceId)) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: async () => {}, ready: Promise.resolve() },
      };
      watched.set(workspace.workspaceId, entry);
      entry.handle = startWorkspaceWatch(workspace, {
        onRecorded: () => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
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
    }
    return statusFor(workspace.workspaceId);
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
    const stops = [...watched.values()].map((w) => w.handle.stop());
    watched.clear();
    await Promise.all(stops);
  }

  return { open, listChangeSets, getStatus, stopAll };
}
