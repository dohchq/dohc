import { useEffect, useState } from "react";
import type { RelayShareReceivedRow } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// "Shared with me" (share mounts): the receive-side inventory. Lives in
// Settings → Cloud beside SharedByMeList. Each row is a path/version share
// addressed to this account; "Add to workspace" mounts it into the CURRENT
// workspace as a read-only shared-with-me/<label>/ folder, and an
// already-mounted share says so with a way to remove it.

type MountInfo = { shareId: string; label: string; ended?: boolean };

type LoadState =
  | { status: "loading" }
  | { status: "ready"; shares: RelayShareReceivedRow[]; mounts: MountInfo[] }
  | { status: "error"; message: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function selectorLabel(share: RelayShareReceivedRow): string {
  if (share.selector.versionId) {
    const suffix =
      share.selector.paths.length > 0 ? ` (${share.selector.paths.join(", ")})` : "";
    return `Version ${share.selector.versionId === "main" ? "Main" : share.selector.versionId}${suffix}`;
  }
  return share.selector.paths.join(", ") || "Everything";
}

export function SharedWithMeList(props: {
  workspaceId: string;
  // Mount/unmount change the explorer tree; the settings host refreshes it.
  onWorkspaceFilesChanged?: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [busyShareId, setBusyShareId] = useState<string | null>(null);

  async function refresh() {
    try {
      const [shares, registry] = await Promise.all([
        bridge().listRelayShares(),
        bridge().getWorkspaceRegistry(),
      ]);
      const workspace = registry.workspaces.find(
        (entry) => entry.workspaceId === props.workspaceId,
      );
      setLoad({
        status: "ready",
        shares: shares.received,
        mounts: workspace?.shareMounts ?? [],
      });
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    void refresh();
    // Load once per mount; mount/unmount refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mount(share: RelayShareReceivedRow) {
    setBusyShareId(share.shareId);
    try {
      await bridge().mountShare({
        workspaceId: props.workspaceId,
        shareCode: share.shareCode,
      });
      await refresh();
      props.onWorkspaceFilesChanged?.();
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    } finally {
      setBusyShareId(null);
    }
  }

  async function unmount(shareId: string) {
    setBusyShareId(shareId);
    try {
      await bridge().unmountShare({ workspaceId: props.workspaceId, shareId });
      await refresh();
      props.onWorkspaceFilesChanged?.();
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    } finally {
      setBusyShareId(null);
    }
  }

  if (load.status === "loading") {
    return <p className="m-0 text-[11px] text-subtle">Loading shares sent to you…</p>;
  }
  if (load.status === "error") {
    return (
      <p data-testid="shared-with-me-error" className="m-0 text-[11px] text-subtle">
        {load.message}
      </p>
    );
  }
  if (load.shares.length === 0) {
    return (
      <p data-testid="shared-with-me-empty" className="m-0 text-[11px] text-subtle">
        Nothing shared with you yet. When someone shares files to your account,
        they show up here.
      </p>
    );
  }
  return (
    <ul
      className="m-0 list-none divide-y divide-line overflow-hidden rounded-lg border border-line p-0"
      data-testid="shared-with-me-list"
    >
      {load.shares.map((share) => {
        const mounted = load.mounts.find((m) => m.shareId === share.shareId);
        return (
          <li
            key={share.shareId}
            data-testid="shared-with-me-row"
            data-share-id={share.shareId}
            className="flex items-center gap-2 bg-panel px-2.5 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-ink">
                {selectorLabel(share)}
              </div>
              <div className="truncate text-[11px] text-subtle">
                {`From ${share.granterEmail ?? "another dohc user"}`}
                {mounted
                  ? ` — in this workspace as shared-with-me/${mounted.label}${mounted.ended ? " (ended)" : ""}`
                  : ""}
              </div>
            </div>
            {mounted ? (
              <button
                type="button"
                data-testid="shared-with-me-unmount"
                disabled={busyShareId === share.shareId}
                onClick={() => void unmount(share.shareId)}
                className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:text-danger disabled:opacity-50"
              >
                {busyShareId === share.shareId ? "Removing…" : "Remove from workspace"}
              </button>
            ) : (
              <button
                type="button"
                data-testid="shared-with-me-mount"
                disabled={busyShareId === share.shareId}
                onClick={() => void mount(share)}
                className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                {busyShareId === share.shareId ? "Adding…" : "Add to workspace"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
