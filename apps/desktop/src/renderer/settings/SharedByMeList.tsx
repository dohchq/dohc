import { Copy, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  RelayShareGrantedRow,
  ShareProposalRow,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ProposalReviewDialog } from "../workbench/ProposalReviewDialog";
import { ShareAccessBadge } from "./ShareAccessBadge";

// "Shared by me" (PR 18): the management list for relay share grants. Lives
// in Settings → Cloud. Calm inventory: what's shared, with whom, and one
// honest way to end it.
//
// #646 PR3a adds one fact and one link: how many submissions from an edit
// recipient are waiting, and the review that decides them. This list is an
// inventory with no detail view, so the row opens the review dialog rather
// than growing a page of its own.

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      shares: RelayShareGrantedRow[];
      // Open submissions for THIS workspace, oldest first per share. Shares
      // granted from another workspace list with no count: the read is
      // workspace-scoped, and a missing count states less than a wrong one.
      openChanges: Map<string, ShareProposalRow[]>;
    }
  | { status: "error"; message: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function selectorLabel(share: RelayShareGrantedRow): string {
  // A row the relay could not read still lists, so ending it stays possible.
  if (!share.selector) return "Unreadable share";
  if (share.selector.versionId) {
    const suffix = share.selector.paths.length > 0
      ? ` (${share.selector.paths.join(", ")})`
      : "";
    return `Version ${share.selector.versionId === "main" ? "Main" : share.selector.versionId}${suffix}`;
  }
  return share.selector.paths.join(", ") || "Everything";
}

export function SharedByMeList(props: { workspaceId: string }) {
  const workspaceId = props.workspaceId;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [reviewProposalId, setReviewProposalId] = useState<string | null>(null);
  // Latest-wins token: the open-changes read is workspace-scoped, so an
  // answer for one workspace must never repaint another.
  const loadToken = useRef(0);

  async function refresh() {
    const token = ++loadToken.current;
    try {
      const [shares, proposals] = await Promise.all([
        bridge().listRelayShares(),
        // A workspace with no proposal lane yet still lists its shares.
        bridge()
          .listShareProposals({ workspaceId })
          .catch(() => ({ proposals: [] as ShareProposalRow[] })),
      ]);
      if (token !== loadToken.current) return;
      const openChanges = new Map<string, ShareProposalRow[]>();
      for (const proposal of [...proposals.proposals].sort(
        (a, b) => a.createdAtMs - b.createdAtMs,
      )) {
        openChanges.set(proposal.shareId, [
          ...(openChanges.get(proposal.shareId) ?? []),
          proposal,
        ]);
      }
      setLoad({ status: "ready", shares: shares.granted, openChanges });
    } catch (cause) {
      if (token !== loadToken.current) return;
      setLoad({ status: "error", message: errorMessage(cause) });
    }
  }

  useEffect(() => {
    void refresh();
    // Reloads when the workspace changes; revokes refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function revoke(shareId: string) {
    setBusyShareId(shareId);
    try {
      await bridge().revokeRelayShare({ shareId });
      await refresh();
    } catch (cause) {
      setLoad({ status: "error", message: errorMessage(cause) });
    } finally {
      setBusyShareId(null);
    }
  }

  async function copyCode(share: RelayShareGrantedRow) {
    try {
      await bridge().writeClipboardText({ text: share.shareCode });
      setCopiedShareId(share.shareId);
    } catch {
      // Non-fatal; the row keeps its copy affordance.
    }
  }

  if (load.status === "loading") {
    return <p className="m-0 text-[11px] text-subtle">Loading your shares…</p>;
  }
  if (load.status === "error") {
    return (
      <p data-testid="shared-by-me-error" className="m-0 text-[11px] text-subtle">
        {load.message}
      </p>
    );
  }
  if (load.shares.length === 0) {
    return (
      <p data-testid="shared-by-me-empty" className="m-0 text-[11px] text-subtle">
        Nothing shared yet. Right-click a file and choose “Share…” to give someone
        a read-only view.
      </p>
    );
  }
  return (
    <>
    <ul
      className="m-0 list-none divide-y divide-line overflow-hidden rounded-lg border border-line p-0"
      data-testid="shared-by-me-list"
    >
      {load.shares.map((share) => {
        const waiting = load.openChanges.get(share.shareId) ?? [];
        return (
        <li
          key={share.shareId}
          data-testid="shared-by-me-row"
          data-share-id={share.shareId}
          data-revoked={share.revokedAtMs !== null || undefined}
          className="flex items-center gap-2 bg-panel px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[11px] text-ink">
                {selectorLabel(share)}
              </span>
              {share.selector ? (
                <ShareAccessBadge access={share.selector.access} />
              ) : null}
            </div>
            <div className="truncate text-[11px] text-subtle">
              {share.revokedAtMs !== null
                ? `Ended — was shared with ${share.recipientEmail ?? share.recipientUserId}`
                : `Shared with ${share.recipientEmail ?? share.recipientUserId}`}
              {share.selector ? "" : " — dohc can't read what this share grants"}
            </div>
          </div>
          {/* Waiting submissions stay reviewable after the share ends: the
              granter deciding about their OWN files is not a recipient
              write, and the changes are already here. */}
          {waiting.length > 0 ? (
            <button
              type="button"
              data-testid="shared-by-me-review"
              data-open-changes={waiting.length}
              onClick={() => setReviewProposalId(waiting[0]!.proposalId)}
              className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              {waiting.length > 1
                ? `Review changes (${waiting.length})`
                : "Review changes"}
            </button>
          ) : null}
          {share.revokedAtMs === null ? (
            <>
              {/* No code to hand out for a row the relay cannot read: the
                  recipient's own open would refuse it. Ending the share
                  stays available — the reverse path must not disappear. */}
              {share.selector ? (
              <button
                type="button"
                data-testid="shared-by-me-copy"
                onClick={() => void copyCode(share)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                {copiedShareId === share.shareId ? (
                  <Check size={11} aria-hidden />
                ) : (
                  <Copy size={11} aria-hidden />
                )}
                {copiedShareId === share.shareId ? "Copied" : "Copy code"}
              </button>
              ) : null}
              <button
                type="button"
                data-testid="shared-by-me-revoke"
                disabled={busyShareId === share.shareId}
                onClick={() => void revoke(share.shareId)}
                className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:text-danger disabled:opacity-50"
              >
                {busyShareId === share.shareId ? "Ending…" : "End share"}
              </button>
            </>
          ) : null}
        </li>
        );
      })}
    </ul>
    {reviewProposalId ? (
      <ProposalReviewDialog
        workspaceId={workspaceId}
        proposalId={reviewProposalId}
        onSettled={() => void refresh()}
        onClose={() => setReviewProposalId(null)}
      />
    ) : null}
    </>
  );
}
