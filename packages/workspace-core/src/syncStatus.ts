// Phase 5 shared contract: the user-visible sync state. workspace-history /
// the desktop bridge produce it; the shell's status surface binds to it.

export type SyncState =
  | "synced"
  | "syncing"
  | "local-changes"
  | "conflict"
  | "cloud-disconnected";

export interface SyncStatus {
  state: SyncState;
  pendingChangeCount: number;
  lastSyncedAtMs: number | null;
}

export interface SyncStatusInput {
  pendingChangeCount: number;
  inFlight: boolean;
  hasConflict: boolean;
  cloudEnabled: boolean;
  cloudConnected: boolean;
  lastSyncedAtMs: number | null;
}

// Single source of truth for state precedence so the shell never re-derives
// it: conflict beats everything, then in-flight, then disconnect (cloud only),
// then pending edits, then settled.
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  const base = {
    pendingChangeCount: input.pendingChangeCount,
    lastSyncedAtMs: input.lastSyncedAtMs,
  };
  if (input.hasConflict) return { ...base, state: "conflict" };
  if (input.inFlight) return { ...base, state: "syncing" };
  // Disconnection only matters once the user has opted into cloud sync;
  // local-only workspaces are never "disconnected".
  if (input.cloudEnabled && !input.cloudConnected) {
    return { ...base, state: "cloud-disconnected" };
  }
  if (input.pendingChangeCount > 0) return { ...base, state: "local-changes" };
  return { ...base, state: "synced" };
}
