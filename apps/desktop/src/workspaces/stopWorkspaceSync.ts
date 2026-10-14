import { runInKeyedLane } from "../keyedLane";
import type { CloudStopSyncResult, SyncStatusResult } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";
import type { CloudCredentials } from "./cloudCredentialStore";
import { workspaceRemoteMatchesCredentials, assertSyncEnrollmentCredentials } from "./chatRelayIdentity";

const syncTransitions = new Map<string, Promise<void>>();
export function withWorkspaceSyncTransition<Result>(workspaceId: string, work: () => Promise<Result>): Promise<Result> {
  return runInKeyedLane(syncTransitions, workspaceId, work);
}

export interface SyncStopOperation {
  readonly workspace: RegistryEntry;
  assertCurrent(): void;
}

export function createWorkspaceSyncStop(dependencies: {
  credentials(): Promise<CloudCredentials | null>;
  currentCredentials(): CloudCredentials | null;
  withOwnerHostPaused<Result>(work: () => Promise<Result>): Promise<Result>;
  prepare(workspace: RegistryEntry): Promise<() => void>;
  resume(workspace: RegistryEntry): Promise<unknown>;
  pauseRemote(workspaceId: string): void;
  closeActivity(workspaceId: string): Promise<unknown>;
  closeRelay(workspace: RegistryEntry): Promise<void>;
  openActivity(workspace: RegistryEntry): Promise<unknown>;
  status(workspaceId: string): SyncStatusResult;
  notify(workspaceId: string): void;
}) {
  return async (operation: SyncStopOperation): Promise<CloudStopSyncResult> => {
    const workspace = operation.workspace;
    const result = (): CloudStopSyncResult => ({
      workspaceId: workspace.workspaceId,
      workspaceSynced: false,
      reversible: true,
      irreversibleEffects: [],
      status: dependencies.status(workspace.workspaceId),
    });
    operation.assertCurrent();
    if (workspace.shareView) {
      throw new Error("This workspace syncs through a received share. Open the owner's workspace to stop its sync.");
    }
    if (!workspace.remote && !workspace.pausedRemote) return result();
    const credentials = await dependencies.credentials();
    operation.assertCurrent();
    if (workspace.remote || workspace.pausedRemote) {
      if (!credentials) throw new Error("Sign in to the account that synced this workspace.");
      assertSyncEnrollmentCredentials(workspace, credentials);
    }
    await dependencies.withOwnerHostPaused(async () => {
      operation.assertCurrent();
      // Keep capture and file observation alive if settlement refuses.
      let resumeAdmission: (() => void) | undefined;
      try {
        resumeAdmission = await dependencies.prepare(workspace);
        operation.assertCurrent();
        const remote = workspace.remote ?? workspace.pausedRemote;
        if (remote && !workspaceRemoteMatchesCredentials(remote, dependencies.currentCredentials())) {
          throw new Error("Your server session changed. Sign in to the account that synced this workspace.");
        }
        dependencies.pauseRemote(workspace.workspaceId);
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
        await dependencies.closeRelay(workspace);
      } catch (error) {
        failure = { error };
      }
      try {
        await dependencies.openActivity(workspace);
      } catch (error) {
        failure ??= { error };
      } finally {
        dependencies.notify(workspace.workspaceId);
      }
      if (failure) throw failure.error;
    });
    operation.assertCurrent();
    return result();
  };
}
