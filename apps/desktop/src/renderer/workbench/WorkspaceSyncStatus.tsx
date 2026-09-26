import type { SyncStatusResult } from "../../ipc/bridgeContract";

// A pass in flight is syncing, never saving: the files are already on disk.
const SYNC_LABEL: Record<SyncStatusResult["state"], string> = {
  synced: "Local · saved",
  syncing: "Syncing…",
  "local-changes": "Local changes",
  conflict: "Conflict",
  "sync-failed": "Sync failed",
  "cloud-disconnected": "Server disconnected",
};

const SYNC_DOT: Record<SyncStatusResult["state"], string> = {
  synced: "bg-success",
  syncing: "bg-warning",
  "local-changes": "bg-warning",
  conflict: "bg-danger",
  "sync-failed": "bg-danger",
  "cloud-disconnected": "bg-subtle",
};

// Sync stopped until one side updates, so the title bar names that side.
export const UPDATE_REQUIRED_LABEL: Record<NonNullable<SyncStatusResult["updateRequired"]>, string> = {
  app: "Update dohc to sync",
  server: "Server needs an update",
};

// Owner live delivery is its own fact, beside the local save state and never
// folded into it: a saved file says nothing about whether live editing is
// running, so "active" here never reads as synced or up to date.
function liveDeliveryLabel(
  delivery: NonNullable<SyncStatusResult["ownerLiveDelivery"]>,
  reason: SyncStatusResult["ownerLiveDeliveryReason"],
): string {
  if (delivery === "preparing") return "Preparing live editing";
  if (delivery === "active") return "Live editing active";
  // A named reason is a state that stays until someone acts on it; an
  // unnamed one is a connection dohc is still dialling.
  return reason ? "Live editing paused" : "Live editing retrying";
}

export function WorkspaceSyncStatus({ syncStatus }: {
  syncStatus: SyncStatusResult | null;
}) {
  const state = syncStatus?.state;
  const conflictCount = state === "conflict" ? syncStatus?.conflictCount ?? 0 : 0;
  // A failed sync names the server when the server is what failed.
  const stateLabel =
    state === "sync-failed" &&
    syncStatus?.syncFailure?.cause === "server-unreachable"
      ? "Server unreachable"
      : state
        ? SYNC_LABEL[state]
        : null;
  const label = stateLabel
    ? `${stateLabel}${conflictCount > 0 ? ` (${conflictCount})` : ""}`
    : "Checking status";
  const shownLabel = syncStatus?.updateRequired
    ? UPDATE_REQUIRED_LABEL[syncStatus.updateRequired]
    : label;
  // Absent means this workspace has nothing to say about live delivery, so
  // the title bar says nothing either.
  const liveDelivery = syncStatus?.ownerLiveDelivery;
  const liveLabel = liveDelivery
    ? liveDeliveryLabel(liveDelivery, syncStatus?.ownerLiveDeliveryReason)
    : null;
  return (
    <>
      <span
        data-testid="sync-status"
        data-state={state ?? "unknown"}
        role="status"
        aria-label={shownLabel}
        title={shownLabel}
        className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
      >
        <span aria-hidden className={`inline-block size-1.5 rounded-full ${state ? SYNC_DOT[state] : "bg-subtle"}`} />
        <span>{shownLabel}</span>
      </span>
      {liveDelivery && liveLabel ? (
        <span
          data-testid="owner-live-delivery-status"
          data-state={liveDelivery}
          role="status"
          aria-label={liveLabel}
          title={liveLabel}
          // Shorten live delivery before local save status; retain its full tooltip.
          className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted"
        >
          <span
            aria-hidden
            className={`inline-block size-1.5 shrink-0 rounded-full ${
              liveDelivery === "active" ? "bg-success" : "bg-warning"
            }`}
          />
          <span className="truncate">{liveLabel}</span>
        </span>
      ) : null}
    </>
  );
}
