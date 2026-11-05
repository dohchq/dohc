// Phase 5 shared contract: the user-visible sync state. workspace-history /
// the desktop bridge produce it; the shell's status surface binds to it.

type SyncState =
  | "synced"
  | "syncing"
  | "local-changes"
  | "conflict"
  | "sync-failed"
  | "account-unconfirmed"
  | "update-required";

interface SyncStatus {
  state: SyncState;
  pendingChangeCount: number;
  lastSyncedAtMs: number | null;
}

interface SyncStatusInput {
  pendingChangeCount: number;
  inFlight: boolean;
  hasConflict: boolean;
  // The last sync pass failed and none has succeeded since.
  syncFailed: boolean;
  // Sync is on but can't run until someone acts: dohc can't confirm the
  // account that syncs the workspace, or one side must update. Null while
  // sync can run, and for a local-only workspace.
  syncBlocked: "account-unconfirmed" | "update-required" | null;
  lastSyncedAtMs: number | null;
}

// Single source of truth for state precedence so the shell never re-derives
// it: conflict beats everything, then a failed sync (a retry in flight does
// not undo it), then in-flight, then a blocked sync, then pending edits,
// then settled.
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  const base = {
    pendingChangeCount: input.pendingChangeCount,
    lastSyncedAtMs: input.lastSyncedAtMs,
  };
  if (input.hasConflict) return { ...base, state: "conflict" };
  if (input.syncFailed) return { ...base, state: "sync-failed" };
  if (input.inFlight) return { ...base, state: "syncing" };
  if (input.syncBlocked) return { ...base, state: input.syncBlocked };
  if (input.pendingChangeCount > 0) return { ...base, state: "local-changes" };
  return { ...base, state: "synced" };
}
