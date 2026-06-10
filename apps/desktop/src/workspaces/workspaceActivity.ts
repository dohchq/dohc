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

  function open(workspace: CreatedWorkspace): SyncStatusResult {
    if (!watched.has(workspace.workspaceId)) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: () => {} },
      };
      watched.set(workspace.workspaceId, entry);
      entry.handle = startWorkspaceWatch(workspace, {
        onRecorded: () => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          notify();
        },
      });
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

  function stopAll(): void {
    for (const w of watched.values()) w.handle.stop();
    watched.clear();
  }

  return { open, listChangeSets, getStatus, stopAll };
}
