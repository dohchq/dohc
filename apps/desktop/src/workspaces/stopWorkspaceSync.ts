import { runInKeyedLane } from "../keyedLane";
import type { CloudStopSyncResult, SyncStatusResult } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";
import type { WorkspaceSyncPause, WorkspaceSyncPauseAuthor, WorkspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";

const syncTransitions = new Map<string, Promise<void>>();
export function withWorkspaceSyncTransition<Result>(workspaceId: string, work: () => Promise<Result>): Promise<Result> {
  return runInKeyedLane(syncTransitions, workspaceId, work);
}

export interface SyncStopOperation {
  readonly workspace: RegistryEntry;
  assertCurrent(): void;
}

export interface SyncPauseReopen {
  closeActivity(workspaceId: string): Promise<unknown>;
  closeRelay(workspace: RegistryEntry): Promise<void>;
  openActivity(workspace: RegistryEntry): Promise<unknown>;
  notify(workspaceId: string): void;
}

// Reopening removes the daemon's relay configuration without touching data,
// and the local open abandons an unfinished pull. Every step runs, even if
// the window changes workspaces, and the first failure is reported.
export async function reopenWithoutSync(
  dependencies: SyncPauseReopen,
  workspace: RegistryEntry,
): Promise<{ reopened: boolean; failure?: { error: unknown } }> {
  let failure: { error: unknown } | undefined;
  let reopened = false;
  try {
    await dependencies.closeActivity(workspace.workspaceId);
  } catch (error) {
    failure = { error };
  }
  try {
    await dependencies.closeRelay(workspace);
  } catch (error) {
    failure ??= { error };
  }
  try {
    await dependencies.openActivity(workspace);
    reopened = true;
  } catch (error) {
    failure ??= { error };
  } finally {
    try { dependencies.notify(workspace.workspaceId); } catch (error) { failure ??= { error }; }
  }
  return failure ? { reopened, failure } : { reopened };
}

export function createWorkspaceSyncStop(dependencies: SyncPauseReopen & {
  person(): Promise<WorkspaceSyncPauseAuthor>;
  pauseStatus(pause: WorkspaceSyncPause): WorkspaceSyncPauseStatus;
  withOwnerHostPaused<Result>(work: () => Promise<Result>): Promise<Result>;
  prepare(workspace: RegistryEntry): Promise<() => void>;
  resume(workspace: RegistryEntry): Promise<unknown>;
  pauseRemote(workspaceId: string, pause: WorkspaceSyncPause): void;
  status(workspaceId: string): SyncStatusResult;
  cleanupFailed(workspaceId: string, error: unknown): void;
  // Collection updates waited when sync paused, and the reopen that ends the
  // wait did not finish.
  reopenFailed(workspace: RegistryEntry): void;
  nowMs?: () => number;
}) {
  return async (operation: SyncStopOperation, actor?: WorkspaceSyncPauseAuthor): Promise<CloudStopSyncResult> => {
    const workspaceId = operation.workspace.workspaceId;
    const author = actor === undefined ? dependencies.person() : Promise.resolve(actor);
    return withWorkspaceSyncTransition(workspaceId, async () => {
      const pausedBy = await author;
      operation.assertCurrent();
      const workspace = operation.workspace;
      if (workspace.joinBootstrapPending) {
        throw new Error("This workspace is still joining. Wait for it to finish, then stop sync. If it doesn't finish, choose Forget and join again.");
      }
      let status = dependencies.status(workspaceId);
      const result = (): CloudStopSyncResult => ({
        workspaceId: workspace.workspaceId,
        workspaceSynced: false,
        ...(status.syncPause ? { syncPause: status.syncPause } : {}),
        status,
      });
      if (shareViewIsPresent(workspace.shareView)) {
        throw new Error("This workspace syncs through a received share. Open the owner's workspace to stop its sync.");
      }
      if (!workspace.remote) return result();
      const collectionsWaiting = status.collectionsWaitingForSync !== undefined;
      let saved = false;
      let reopened = false;
      try {
        await dependencies.withOwnerHostPaused(async () => {
          operation.assertCurrent();
          // Keep capture and file observation alive if settlement refuses.
          let resumeAdmission: (() => void) | undefined;
          try {
            resumeAdmission = await dependencies.prepare(workspace);
            operation.assertCurrent();
            const syncPause = { atMs: (dependencies.nowMs ?? Date.now)(), author: pausedBy };
            dependencies.pauseRemote(workspace.workspaceId, syncPause);
            saved = true;
            status = { ...status, syncPause: dependencies.pauseStatus(syncPause) };
          } catch (error) {
            // A refused pause keeps the original sync setting and failure.
            resumeAdmission?.();
            await dependencies.resume(workspace).catch(() => undefined);
            throw error;
          }
          // Once paused, finish resource cleanup even if the window changes workspaces.
          const reopen = await reopenWithoutSync(dependencies, workspace);
          reopened = reopen.reopened;
          if (reopen.failure) throw reopen.failure.error;
        });
      } catch (error) {
        if (!saved) throw error;
        dependencies.cleanupFailed(workspaceId, error);
        if (collectionsWaiting && !reopened) dependencies.reopenFailed(workspace);
      }
      // The saved pause is the outcome, even if its attachment retired during cleanup.
      try { operation.assertCurrent(); status = dependencies.status(workspaceId); } catch { /* Keep the saved outcome. */ }
      return result();
    });
  };
}
