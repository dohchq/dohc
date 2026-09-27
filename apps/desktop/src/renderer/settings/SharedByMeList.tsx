import { useRequestSequence } from "../useRequestSequence";
import { ipcErrorMessage } from "../ipcError";
import { Copy, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  RelayShareGrantedRow,
  ShareProposalRow,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { ShareRemovalNotices } from "../shell/useShareRemovalNotices";
import { ProposalReviewDialog } from "../workbench/ProposalReviewDialog";
import { ShareAccessBadge } from "./ShareAccessBadge";

// "Shared by me": the management list for relay share grants. Lives
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
      // Open submissions for this workspace, oldest first per share. Shares
      // granted from another workspace list with no count: the read is
      // workspace-scoped, and a missing count states less than a wrong one.
      openChanges: Map<string, { count: number; oldest: ShareProposalRow }>;
    }
  | { status: "error"; message: string };

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

function recipientLabel(share: RelayShareGrantedRow): string {
  return share.recipientEmail ?? share.recipientUserId ?? "the recipient";
}

export function SharedByMeList(props: {
  workspaceId: string;
  // Ending a share is undoable for a while. The shell shows that notice and
  // holds the Undo, so it outlives Settings; a refused End goes to the same
  // shell with Try again, and the list stays.
  shareRemovals?: ShareRemovalNotices;
}) {
  const workspaceId = props.workspaceId;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [copiedInvitationGrantId, setCopiedInvitationGrantId] = useState<string | null>(null);
  const [reviewProposalId, setReviewProposalId] = useState<string | null>(null);
  // Which row is asking before it discards. Ending a share settles what the
  // recipient still has waiting, so the count is shown before the click.
  const [confirmShareId, setConfirmShareId] = useState<string | null>(null);
  // Latest-wins token: the open-changes read is workspace-scoped, so an
  // answer for one workspace must never repaint another.
  const loadToken = useRequestSequence();
  // Bumped only by unmount or a workspace switch, so an Undo that lands later
  // can tell this list is still the one it came from before reading again.
  const listEpoch = useRequestSequence([workspaceId]);

  async function refresh() {
    const token = loadToken.next();
    try {
      const [shares, proposals] = await Promise.all([
        bridge().listRelayShares(),
        // A workspace with no proposal lane yet still lists its shares.
        bridge()
          .listShareProposals({ workspaceId })
          .catch(() => ({ proposals: [] as ShareProposalRow[] })),
      ]);
      if (!loadToken.isCurrent(token)) return;
      // What the row shows: how many are waiting, and which one the Review
      // button opens — the oldest, because that is the one waiting longest.
      const openChanges = new Map<string, { count: number; oldest: ShareProposalRow }>();
      for (const proposal of proposals.proposals) {
        const seen = openChanges.get(proposal.shareId);
        openChanges.set(proposal.shareId, {
          count: (seen?.count ?? 0) + 1,
          oldest:
            seen && seen.oldest.createdAtMs <= proposal.createdAtMs
              ? seen.oldest
              : proposal,
        });
      }
      setLoad({ status: "ready", shares: shares.granted, openChanges });
    } catch (cause) {
      if (!loadToken.isCurrent(token)) return;
      setLoad({ status: "error", message: ipcErrorMessage(cause) });
    }
  }

  useEffect(() => {
    void refresh();
    // Reloads when the workspace changes; revokes refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function revoke(share: RelayShareGrantedRow) {
    const shareId = share.shareId;
    const epoch = listEpoch.current();
    setBusyShareId(shareId);
    try {
      const result = await bridge().revokeRelayShare({ shareId });
      const subject = `the share of ${selectorLabel(share)} with ${recipientLabel(share)}`;
      props.shareRemovals?.removed({
        workspaceId,
        shareId,
        undo: result.undo,
        message: result.undo ? `Ended ${subject}.` : `The share of ${selectorLabel(share)} with ${recipientLabel(share)} has already ended.`,
        restoredMessage: `Restored ${subject}.`,
        restored: () => {
          if (listEpoch.isCurrent(epoch)) void refresh();
        },
      });
      if (!listEpoch.isCurrent(epoch)) return;
      setConfirmShareId(null);
      await refresh();
    } catch (cause) {
      if (!listEpoch.isCurrent(epoch)) return;
      if (props.shareRemovals) {
        props.shareRemovals.failed({
          workspaceId,
          message: `dohc could not end the share of ${selectorLabel(share)} with ${recipientLabel(share)}.`,
          cause,
          retry: () => void revoke(share),
        });
      } else {
        setLoad({ status: "error", message: ipcErrorMessage(cause) });
      }
    } finally {
      if (listEpoch.isCurrent(epoch)) setBusyShareId(null);
    }
  }

  async function copyCode(share: RelayShareGrantedRow) {
    const token = loadToken.current();
    try {
      await bridge().writeClipboardText({ text: share.shareCode });
      if (loadToken.isCurrent(token)) setCopiedShareId(share.shareId);
    } catch {
      // Non-fatal; the row keeps its copy affordance.
    }
  }

  async function copyInvitation(share: RelayShareGrantedRow) {
    if (!share.browserInvitationUrl) return;
    const token = loadToken.current();
    try {
      await bridge().writeClipboardText({ text: share.browserInvitationUrl });
      if (loadToken.isCurrent(token)) setCopiedInvitationGrantId(share.grantId);
    } catch {
      // The row keeps its copy control for retry.
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
        const waiting = load.openChanges.get(share.shareId) ?? null;
        return (
        <li
          key={share.grantId}
          data-testid="shared-by-me-row"
          data-share-id={share.shareId}
          data-grant-id={share.grantId}
          data-revoked={share.revokedAtMs !== null || undefined}
          className="flex items-center gap-2 bg-panel px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[11px] text-ink">
                {selectorLabel(share)}
              </span>
              {share.selector ? (
                <ShareAccessBadge access={share.access} />
              ) : null}
            </div>
            <div className="truncate text-[11px] text-subtle">
              {share.revokedAtMs !== null
                ? `Ended — was shared with ${share.recipientEmail ?? share.recipientUserId}`
                : `Shared with ${share.recipientEmail ?? share.recipientUserId}`}
              {share.selector ? "" : " — dohc can't read what this share grants"}
            </div>
          </div>
          {/* Ending a share settles what it was carrying, so a row only
              offers a review while something is genuinely waiting. */}
          {waiting ? (
            <button
              type="button"
              data-testid="shared-by-me-review"
              data-open-changes={waiting.count}
              onClick={() => setReviewProposalId(waiting.oldest.proposalId)}
              className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              {waiting.count > 1
                ? `Review changes (${waiting.count})`
                : "Review changes"}
            </button>
          ) : null}
          {share.revokedAtMs === null ? (
            <>
              {share.selector && share.browserInvitationUrl && (
                <button type="button" data-testid="shared-by-me-copy-invitation"
                  onClick={() => void copyInvitation(share)}
                  className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink">
                  {copiedInvitationGrantId === share.grantId ? "Browser invitation copied" : "Copy browser invitation"}
                </button>
              )}
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
              {/* Ending a share DECLINES whatever the recipient still has
                  waiting. Undo brings the share back, not the declined
                  changes, so the count is stated before the click that
                  discards them, never after. */}
              {confirmShareId === share.shareId ? (
                <>
                  <span
                    data-testid="shared-by-me-revoke-confirm"
                    className="min-w-0 flex-1 truncate text-[11px] text-warning"
                  >
                    {waiting
                      ? waiting.count === 1
                        ? `End this share and decline 1 change ${recipientLabel(share)} sent? Undo restores the share, not the declined change.`
                        : `End this share and decline ${waiting.count} changes ${recipientLabel(share)} sent? Undo restores the share, not the declined changes.`
                      : `End this share? ${recipientLabel(share)} keeps a read-only copy and stops receiving updates.`}
                  </span>
                  <button
                    type="button"
                    data-testid="shared-by-me-revoke-cancel"
                    onClick={() => setConfirmShareId(null)}
                    className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="shared-by-me-revoke"
                    disabled={busyShareId === share.shareId}
                    onClick={() => void revoke(share)}
                    className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-danger transition-colors hover:bg-panel-2 disabled:opacity-50"
                  >
                    {busyShareId === share.shareId ? "Ending…" : "End share"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="shared-by-me-revoke-start"
                  disabled={busyShareId === share.shareId}
                  onClick={() => setConfirmShareId(share.shareId)}
                  className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:text-danger disabled:opacity-50"
                >
                  End share
                </button>
              )}
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
