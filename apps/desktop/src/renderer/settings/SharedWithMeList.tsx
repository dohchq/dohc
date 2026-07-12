import { useEffect, useRef, useState } from "react";
import type { RelayShareReceivedRow } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// "Shared with me" (share mounts): the receive-side inventory. Lives in
// Settings → Cloud beside SharedByMeList. Each row is a path/version share
// addressed to this account; "Add to workspace" mounts it into the CURRENT
// workspace as a read-only shared-with-me/<label>/ folder, and an
// already-mounted share says so with a way to remove it.

type MountInfo = {
  shareId: string;
  label: string;
  granterEmail?: string | null;
  ended?: boolean;
};

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
  // Response token (repo invariant for workspace-scoped async loads): a
  // slower older refresh must never overwrite a newer list, and nothing may
  // set state after unmount or a workspace switch.
  const refreshToken = useRef(0);

  async function refresh() {
    const token = ++refreshToken.current;
    try {
      // The registry is local and must render even when the relay listing
      // fails (signed out, offline, different relay) — otherwise the
      // "Remove from workspace" path disappears exactly when the relay
      // can't confirm anything. A failed relay listing renders as an empty
      // received set; the registry-only rows already say the share is not
      // listed by the relay right now.
      const [sharesResult, registry] = await Promise.all([
        bridge()
          .listRelayShares()
          .then((result) => ({ ok: true as const, received: result.received }))
          .catch(() => ({ ok: false as const, received: [] })),
        bridge().getWorkspaceRegistry(),
      ]);
      if (token !== refreshToken.current) return;
      const workspace = registry.workspaces.find(
        (entry) => entry.workspaceId === props.workspaceId,
      );
      setLoad({
        status: "ready",
        shares: sharesResult.received,
        mounts: workspace?.shareMounts ?? [],
      });
    } catch (cause) {
      if (token !== refreshToken.current) return;
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      // Invalidate in-flight responses on unmount / workspace switch.
      refreshToken.current += 1;
    };
    // Loads once per mount and re-arms per workspace; mount/unmount actions
    // refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  async function mount(share: RelayShareReceivedRow) {
    const token = refreshToken.current;
    setBusyShareId(share.shareId);
    try {
      await bridge().mountShare({
        workspaceId: props.workspaceId,
        shareCode: share.shareCode,
      });
      await refresh();
      props.onWorkspaceFilesChanged?.();
    } catch (cause) {
      // Same token rule as refresh(): a rejection from a previous workspace
      // must not surface after a switch.
      if (token === refreshToken.current) {
        setLoad({ status: "error", message: errorMessage(cause) });
      }
    } finally {
      setBusyShareId(null);
    }
  }

  async function unmount(shareId: string) {
    const token = refreshToken.current;
    setBusyShareId(shareId);
    try {
      await bridge().unmountShare({ workspaceId: props.workspaceId, shareId });
      await refresh();
      props.onWorkspaceFilesChanged?.();
    } catch (cause) {
      if (token === refreshToken.current) {
        setLoad({ status: "error", message: errorMessage(cause) });
      }
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
  // A revoked (or wrong-relay) mount vanishes from the relay's received
  // listing while its local copy stays readable — those registry-only mounts
  // still need a row here so "Remove from workspace" stays reachable.
  const registryOnlyMounts = load.mounts.filter(
    (mount) => !load.shares.some((share) => share.shareId === mount.shareId),
  );
  if (load.shares.length === 0 && registryOnlyMounts.length === 0) {
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
      {registryOnlyMounts.map((mount) => (
        <li
          key={mount.shareId}
          data-testid="shared-with-me-row"
          data-share-id={mount.shareId}
          data-registry-only
          className="flex items-center gap-2 bg-panel px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11px] text-ink">
              {`shared-with-me/${mount.label}`}
            </div>
            <div className="truncate text-[11px] text-subtle">
              {`From ${mount.granterEmail ?? "another dohc user"}`}
              {mount.ended
                ? " — ended; your copy stays readable but won't update"
                : " — not listed by the relay right now"}
            </div>
          </div>
          <button
            type="button"
            data-testid="shared-with-me-unmount"
            disabled={busyShareId === mount.shareId}
            onClick={() => void unmount(mount.shareId)}
            className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:text-danger disabled:opacity-50"
          >
            {busyShareId === mount.shareId ? "Removing…" : "Remove from workspace"}
          </button>
        </li>
      ))}
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
