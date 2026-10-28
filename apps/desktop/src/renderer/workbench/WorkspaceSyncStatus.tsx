import { TriangleAlert } from "lucide-react";
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

// The dot's shape says the kind of state before its color does: filled is
// settled, a ring is still working or waiting, a triangle needs the person.
// Only a state that needs the person shows its words; the rest keep them for
// the accessible name and the tooltip.
type DotKind = "saved" | "working" | "waiting" | "attention";

const SYNC_DOT: Record<SyncStatusResult["state"], DotKind> = {
  synced: "saved",
  syncing: "working",
  "local-changes": "working",
  conflict: "attention",
  "sync-failed": "attention",
  "cloud-disconnected": "waiting",
};

function Dot(props: { kind: DotKind }) {
  switch (props.kind) {
    case "saved":
      return <span aria-hidden data-dot="saved" className="size-1.5 shrink-0 rounded-full bg-success" />;
    case "working":
      return <span aria-hidden data-dot="working" className="size-2 shrink-0 rounded-full border-[1.5px] border-warning" />;
    case "waiting":
      return <span aria-hidden data-dot="waiting" className="size-2 shrink-0 rounded-full border-[1.5px] border-subtle" />;
    case "attention":
      return <TriangleAlert aria-hidden data-dot="attention" size={12} className="shrink-0 text-danger" />;
  }
}

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
  if (reason === "session-host-refused" || reason === "session-host-diverged") return "Live editing stopped";
  if (reason === "live-document-without-lineage") return "Live editing can't start";
  if (reason === "live-edit-unadmitted" || reason === "conflict-parent-withheld") return "Live editing can't resume";
  return reason ? "Live editing paused" : "Live editing retrying";
}

// The sync state names the server as the problem.
function syncNamesServer(syncStatus: SyncStatusResult | null | undefined): boolean {
  return syncStatus?.state === "cloud-disconnected" ||
    (syncStatus?.state === "sync-failed" && syncStatus.syncFailure?.cause === "server-unreachable");
}

// The title bar says "Server unreachable" or "Server disconnected". Features
// that need the server then add no indicator, toast or row of their own,
// since the server's report covers them. A failed save or a required update
// takes the title bar's words, and then they show again.
export function titleBarNamesServer(syncStatus: SyncStatusResult | null | undefined, failedSaves: number): boolean {
  return syncNamesServer(syncStatus) && !syncStatus?.updateRequired &&
    saveFailedLabel(syncStatus ?? null, failedSaves) === null;
}

// A file that couldn't save outranks every state but those that stop sync
// for the whole workspace, which keep the title bar.
function saveFailedLabel(syncStatus: SyncStatusResult | null, failedSaves: number): string | null {
  if (failedSaves === 0 || syncStatus?.updateRequired) return null;
  if (syncStatus?.state === "conflict" || syncStatus?.state === "sync-failed") return null;
  return `Couldn't save ${failedSaves} ${failedSaves === 1 ? "file" : "files"}`;
}

// The workspace's save and sync state. An editor's own edits in flight show
// on its tab, not here: this is a live region, and typing must not make it
// speak.
export function WorkspaceSyncStatus({ syncStatus, failedSaves }: {
  syncStatus: SyncStatusResult | null;
  // Files in this workspace whose save failed.
  failedSaves: number;
}) {
  const state = syncStatus?.state;
  const conflictCount = state === "conflict" ? syncStatus?.conflictCount ?? 0 : 0;
  // A failed sync names the server when the server is what failed.
  const stateLabel =
    state === "sync-failed" && syncNamesServer(syncStatus)
      ? "Server unreachable"
      : state
        ? SYNC_LABEL[state]
        : null;
  const label = stateLabel
    ? `${stateLabel}${conflictCount > 0 ? ` (${conflictCount})` : ""}`
    : "Checking status";
  const saveFailed = saveFailedLabel(syncStatus, failedSaves);
  const shownLabel = saveFailed ?? (syncStatus?.updateRequired
    ? UPDATE_REQUIRED_LABEL[syncStatus.updateRequired]
    : state === "syncing" && syncStatus?.claimingIdentity
      ? "Setting up sync…"
      : label);
  const dot: DotKind = saveFailed || syncStatus?.updateRequired
    ? "attention"
    : state
      ? SYNC_DOT[state]
      : "waiting";
  // A state that needs the person says so in words beside the dot.
  const worded = dot === "attention" || (dot === "waiting" && state !== undefined);
  // Absent means this workspace has nothing to say about live delivery, so
  // the title bar says nothing either. Live editing waits on a server the
  // title bar already names.
  const liveDelivery = titleBarNamesServer(syncStatus, failedSaves) ? undefined : syncStatus?.ownerLiveDelivery;
  const liveLabel = liveDelivery
    ? liveDeliveryLabel(liveDelivery, syncStatus?.ownerLiveDeliveryReason)
    : null;
  // A retry with no reason is dohc still dialling by itself, so it is a ring.
  const liveDialling = liveDelivery === "retrying" && !syncStatus?.ownerLiveDeliveryReason;
  return (
    <>
      <span
        data-testid="sync-status"
        data-state={saveFailed ? "save-failed" : state ?? "unknown"}
        role="status"
        aria-label={shownLabel}
        title={shownLabel}
        // The dot's box keeps a 20x24 hover target for its tooltip.
        className={`flex h-6 shrink-0 items-center gap-1.5 text-[11px] text-muted ${worded ? "px-1" : "w-5 justify-center"}`}
      >
        <Dot kind={dot} />
        <span className={worded ? undefined : "sr-only"}>{shownLabel}</span>
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
          {liveDialling ? (
            <Dot kind="working" />
          ) : (
            <span
              aria-hidden
              className={`inline-block size-1.5 shrink-0 rounded-full ${
                liveDelivery === "active" ? "bg-success" : "bg-warning"
              }`}
            />
          )}
          <span className="truncate">{liveLabel}</span>
        </span>
      ) : null}
    </>
  );
}
