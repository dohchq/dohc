import type { SyncStatusResult } from "../../ipc/bridgeContract";

const SYNC_LABEL: Record<SyncStatusResult["state"], string> = {
  synced: "Local · saved",
  syncing: "Saving…",
  "local-changes": "Local changes",
  conflict: "Conflict",
  "cloud-disconnected": "Cloud disconnected",
};

const SYNC_DOT: Record<SyncStatusResult["state"], string> = {
  synced: "bg-success",
  syncing: "bg-warning",
  "local-changes": "bg-warning",
  conflict: "bg-danger",
  "cloud-disconnected": "bg-subtle",
};

export function WorkspaceSyncStatus({ syncStatus }: {
  syncStatus: SyncStatusResult | null;
}) {
  const state = syncStatus?.state;
  const conflictCount = state === "conflict" ? syncStatus?.conflictCount ?? 0 : 0;
  const label = state
    ? `${SYNC_LABEL[state]}${conflictCount > 0 ? ` (${conflictCount})` : ""}`
    : "Checking status";
  return (
    <span
      data-testid="sync-status"
      data-state={state ?? "unknown"}
      role="status"
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
    >
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${state ? SYNC_DOT[state] : "bg-subtle"}`} />
      <span>{label}</span>
    </span>
  );
}
