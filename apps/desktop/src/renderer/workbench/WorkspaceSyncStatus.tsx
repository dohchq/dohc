import type { SyncStatusResult } from "../../ipc/bridgeContract";

const SYNC_LABEL: Record<SyncStatusResult["state"], string> = {
  synced: "Local · saved",
  syncing: "Saving…",
  "local-changes": "Local changes",
  conflict: "Conflict",
  "cloud-disconnected": "Server disconnected",
};

const SYNC_DOT: Record<SyncStatusResult["state"], string> = {
  synced: "bg-success",
  syncing: "bg-warning",
  "local-changes": "bg-warning",
  conflict: "bg-danger",
  "cloud-disconnected": "bg-subtle",
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
  const label = state
    ? `${SYNC_LABEL[state]}${conflictCount > 0 ? ` (${conflictCount})` : ""}`
    : "Checking status";
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
        aria-label={label}
        title={label}
        className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
      >
        <span aria-hidden className={`inline-block size-1.5 rounded-full ${state ? SYNC_DOT[state] : "bg-subtle"}`} />
        <span>{label}</span>
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
