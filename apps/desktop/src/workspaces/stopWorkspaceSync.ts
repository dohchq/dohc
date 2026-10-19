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

export function createWorkspaceSyncStop(dependencies: {
  person(): Promise<WorkspaceSyncPauseAuthor>;
  pauseStatus(pause: WorkspaceSyncPause): WorkspaceSyncPauseStatus;
  withOwnerHostPaused<Result>(work: () => Promise<Result>): Promise<Result>;
  prepare(workspace: RegistryEntry): Promise<() => void>;
  resume(workspace: RegistryEntry): Promise<unknown>;
  pauseRemote(workspaceId: string, pause: WorkspaceSyncPause): void;
  closeActivity(workspaceId: string): Promise<unknown>;
  closeRelay(workspace: RegistryEntry): Promise<void>;
  openActivity(workspace: RegistryEntry): Promise<unknown>;
  status(workspaceId: string): SyncStatusResult;
  notify(workspaceId: string): void;
  cleanupFailed(workspaceId: string, error: unknown): void;
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
      let saved = false;
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
          // Reopening removes the daemon's relay configuration without touching data.
          let failure: { error: unknown } | undefined;
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
          } catch (error) {
            failure ??= { error };
          } finally {
            try { dependencies.notify(workspace.workspaceId); } catch (error) { failure ??= { error }; }
          }
          if (failure) throw failure.error;
        });
      } catch (error) {
        if (!saved) throw error;
        dependencies.cleanupFailed(workspaceId, error);
      }
      // The saved pause is the outcome, even if its attachment retired during cleanup.
      try { operation.assertCurrent(); status = dependencies.status(workspaceId); } catch { /* Keep the saved outcome. */ }
      return result();
    });
  };
}
