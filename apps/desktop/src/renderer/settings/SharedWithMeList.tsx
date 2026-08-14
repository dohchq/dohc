import { useEffect, useRef, useState } from "react";
import type {
  RelayShareReceivedRow,
  ShareAccess,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import {
  hasUnacknowledgedShareSkips,
  shareSkipNoticeLines,
} from "../shareSkipNotice";
import { ShareAccessBadge } from "./ShareAccessBadge";

// "Shared with me" (share mounts): the receive-side inventory. Lives in
// Settings → Cloud beside SharedByMeList. Each row is a path/version share
// addressed to this account; "Add to workspace" mounts it into the CURRENT
// workspace as a read-only shared-with-me/<label>/ folder, and an
// already-mounted share says so with a way to remove it.

type MountInfo = {
  shareId: string;
  label: string;
  granterEmail?: string | null;
  // The pinned level (#646), so a mount the relay no longer lists still says
  // what it grants. Absent when `damaged` says the grant could not be read.
  access?: ShareAccess;
  // The stored grant is unreadable. The row stays so the mount can still be
  // removed; it shows no level and says what happened instead.
  damaged?: true;
  ended?: boolean;
  // Ops this mount's pulls skipped. Durable: the cursor committed past them.
  skippedOps?: {
    ops: Array<{ code: string; detail: string }>;
    more: number;
    generation: number;
    acknowledgedGeneration?: number;
    inexact?: boolean;
  };
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
  if (!share.selector) return "Unreadable share";
  if (share.selector.versionId) {
    const suffix =
      share.selector.paths.length > 0 ? ` (${share.selector.paths.join(", ")})` : "";
    return `Version ${share.selector.versionId === "main" ? "Main" : share.selector.versionId}${suffix}`;
  }
  return share.selector.paths.join(", ") || "Everything";
}

// Ops this mount's pulls skipped, from the mount RECORD. The skip is durable
// — the cursor committed past them — so the line stays until the user
// dismisses it in the workspace that holds the mount.
function SkippedLine(props: {
  mount: MountInfo;
  onDismiss: (shareId: string, generation: number) => void;
}) {
  const skipped = props.mount.skippedOps;
  // Only what the user has not seen: acknowledging hides this line and keeps
  // the record.
  if (!hasUnacknowledgedShareSkips(skipped)) return null;
  return (
    <>
      {shareSkipNoticeLines(skipped, props.mount.granterEmail ?? null).map(
        (line) => (
          <div
            key={line.kind}
            data-testid="shared-with-me-skipped"
            data-kind={line.kind}
            title={line.detail}
            className="flex items-center gap-1.5 text-[11px] text-warning"
          >
            <span className="truncate">{line.text}</span>
            <button
              type="button"
              data-testid="shared-with-me-skipped-dismiss"
              onClick={() =>
                props.onDismiss(props.mount.shareId, skipped.generation)
              }
              className="shrink-0 rounded border border-warning/40 px-1 text-[10px] text-warning hover:bg-warning/20"
            >
              Dismiss
            </button>
          </div>
        ),
      )}
    </>
  );
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
  // A SECOND token, for the registry-only lane. One counter cannot answer two
  // questions — "may this response land?" and "is that other reader
  // superseded?" — and sharing `refreshToken` made an activity signal cancel
  // the initial load's relay lookup, leaving the panel in `loading` until
  // Settings was reopened (the #502 VersionMenu lesson).
  const mountsToken = useRef(0);
  // Bumped whenever the registry lane reads. A slower full refresh that
  // started before that read holds an older registry, so it publishes its
  // relay listing and the mounts below rather than reverting them.
  const mountsCommitted = useRef(0);
  // The freshest mounts the registry lane has seen, held whatever the surface
  // is doing. A read that lands while the panel is still loading has nowhere
  // to paint, and dropping it would consume the ONE activity signal a newly
  // recorded refusal gets — the warning would then wait for an unrelated
  // event. Held here, the full refresh publishes it when it lands.
  const pendingMounts = useRef<MountInfo[] | null>(null);
  // Workspace epoch: bumped ONLY by unmount/workspace switch (refresh bumps
  // its own token per call), so in-flight ACTIONS can tell "still the same
  // panel" apart from "my own follow-up refresh ran".
  const workspaceEpoch = useRef(0);

  // The registry half of `refresh`, for signals that can only have changed
  // registry-local state. Its own lane: it commits registry-owned fields and
  // never touches the relay listing, so it must not invalidate a lookup it
  // does not replace.
  async function reloadMounts() {
    const token = ++mountsToken.current;
    try {
      const registry = await bridge().getWorkspaceRegistry();
      if (token !== mountsToken.current) return;
      const mounts =
        registry.workspaces.find(
          (entry) => entry.workspaceId === props.workspaceId,
        )?.shareMounts ?? [];
      pendingMounts.current = mounts;
      mountsCommitted.current += 1;
      setLoad((previous) =>
        previous.status === "ready" ? { ...previous, mounts } : previous,
      );
    } catch {
      // A failed registry read leaves the rows as they are: this signal is a
      // hint, not the load path.
    }
  }

  async function refresh() {
    const token = ++refreshToken.current;
    const mountsAtStart = mountsCommitted.current;
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
      // The registry lane read while this lookup was in flight, so its mounts
      // are fresher than the ones read here — whether or not the surface was
      // ready to paint them at the time. Publish the listing and those.
      const fresher =
        mountsCommitted.current !== mountsAtStart ? pendingMounts.current : null;
      setLoad({
        status: "ready",
        shares: sharesResult.received,
        mounts: fresher ?? workspace?.shareMounts ?? [],
      });
    } catch (cause) {
      if (token !== refreshToken.current) return;
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    void refresh();
    // A share pull can record a skipped op while this list is open — the
    // pull runs in main and writes the record as it goes. Without this the
    // row keeps showing the snapshot it loaded and says nothing until
    // Settings is reopened.
    //
    // The REGISTRY only. Workspace activity fires on every settled watcher
    // batch, and a full refresh would put a `/sync/shares` request on the
    // wire for each one; the token stops a stale answer landing but not the
    // request. The skip record is registry-local, so nothing here needs the
    // relay.
    const unsubscribe = bridge().onWorkspaceActivity(() => {
      void reloadMounts();
    });
    return () => {
      unsubscribe();
      // Invalidate in-flight responses and actions on unmount / switch.
      refreshToken.current += 1;
      mountsToken.current += 1;
      workspaceEpoch.current += 1;
      // Another workspace's rows are not this one's news.
      pendingMounts.current = null;
    };
    // Loads once per mount and re-arms per workspace; mount/unmount actions
    // refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  async function mount(share: RelayShareReceivedRow) {
    const epoch = workspaceEpoch.current;
    const live = () => epoch === workspaceEpoch.current;
    setBusyShareId(share.shareId);
    try {
      await bridge().mountShare({
        workspaceId: props.workspaceId,
        shareCode: share.shareCode,
      });
      // The panel may have unmounted / switched workspaces mid-action: the
      // follow-up refresh and files-changed callback belong to the OLD
      // workspace and must not run against the new one.
      if (!live()) return;
      await refresh();
      if (live()) props.onWorkspaceFilesChanged?.();
    } catch (cause) {
      if (live()) setLoad({ status: "error", message: errorMessage(cause) });
    } finally {
      if (live()) setBusyShareId(null);
    }
  }

  // Clearing a mount's durable skip record. The content those ops carried is
  // still missing — this says the user has seen the warning, which is the same
  // recovery the shared-view banner offers.
  async function dismissSkips(shareId: string, generation: number) {
    const epoch = workspaceEpoch.current;
    try {
      // The generation on screen. A refusal recorded since this render is not
      // acknowledged by this click, and the refresh below brings it back.
      await bridge().dismissShareSkips({
        workspaceId: props.workspaceId,
        shareId,
        generation,
      });
      if (epoch !== workspaceEpoch.current) return;
      await refresh();
    } catch (cause) {
      if (epoch !== workspaceEpoch.current) return;
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  async function unmount(shareId: string) {
    const epoch = workspaceEpoch.current;
    const live = () => epoch === workspaceEpoch.current;
    setBusyShareId(shareId);
    try {
      await bridge().unmountShare({ workspaceId: props.workspaceId, shareId });
      if (!live()) return;
      await refresh();
      if (live()) props.onWorkspaceFilesChanged?.();
    } catch (cause) {
      if (live()) setLoad({ status: "error", message: errorMessage(cause) });
    } finally {
      if (live()) setBusyShareId(null);
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
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[11px] text-ink">
                {`shared-with-me/${mount.label}`}
              </span>
              {mount.access ? <ShareAccessBadge access={mount.access} /> : null}
            </div>
            <div className="truncate text-[11px] text-subtle">
              {`From ${mount.granterEmail ?? "another dohc user"}`}
              {mount.damaged
                ? " — dohc can't read what this share grants"
                : mount.ended
                  ? " — ended; your copy stays readable but won't update"
                  : " — not listed by the relay right now"}
            </div>
            <SkippedLine mount={mount} onDismiss={dismissSkips} />
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
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-[11px] text-ink">
                  {selectorLabel(share)}
                </span>
                {/* The PINNED level wins whenever this share is mounted. The
                    pin is what the recipient's own pulls enforce, so a relay
                    restating a wider level must not get to announce itself
                    here — including by standing in for a pin that could not be
                    read. A mounted row shows the pin or nothing. Unmounted
                    rows have no pin yet, so the relay's statement is all there
                    is. */}
                {mounted ? (
                  mounted.access ? (
                    <ShareAccessBadge access={mounted.access} />
                  ) : null
                ) : share.selector ? (
                  <ShareAccessBadge access={share.selector.access} />
                ) : null}
              </div>
              <div className="truncate text-[11px] text-subtle">
                {`From ${share.granterEmail ?? "another dohc user"}`}
                {mounted
                  ? ` — in this workspace as shared-with-me/${mounted.label}${
                      mounted.damaged
                        ? "; dohc can't read what this share grants"
                        : mounted.ended
                          ? " (ended)"
                          : ""
                    }`
                  : ""}
              </div>
              {mounted ? (
                <SkippedLine mount={mounted} onDismiss={dismissSkips} />
              ) : null}
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
                // A share whose grant the relay cannot read cannot be
                // mounted: the pin would have nothing to enforce.
                disabled={busyShareId === share.shareId || !share.selector}
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
