import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import { recordedShareSelector } from "./shareViewRecords";
import type { ShareViewSelector } from "./shareViewInfo";
import { shareViewIsPresent } from "./shareViewMarker";
import { shareViewTakesLocalWrites } from "./shareWriteGate";

// The two lanes of #646 PR3a, and the rule that keeps a workspace in exactly
// one of them.
//
// GRANTER lane — read the changes recipients sent, then accept or decline
// them. It acts on a workspace this machine owns.
//
// RECIPIENT lane — send, list, and withdraw this machine's own changes. It
// acts from inside a share view, at edit level.
//
// A share view is never the granter, and a workspace this account owns has no
// grant to send changes through, so each lane refuses the other's workspace
// outright rather than answering an empty list. Both rules live here rather
// than inside main's IPC closure so the tests that prove them drive the real
// thing.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a recipient needs to reach the proposal routes: the share it is a view
 * of, and the grant that share pinned.
 *
 * Neither is ever taken from the caller. The renderer names a workspace; the
 * registry answers which share that workspace is, and at what level.
 */
export interface ShareViewProposalScope {
  shareId: string;
  grant: ShareViewSelector;
}

/**
 * The share this workspace is a view of, at whatever level it grants.
 *
 * Three separate reasons, in the order that makes each answer true:
 *
 * 1. PRESENCE — the same question `sharedViewOf` asks before a write. A
 *    workspace with no share marker has no share at all.
 * 2. The pinned grant must READ BACK completely, through the same function
 *    the pull uses, so this gate and the pull cannot disagree about what the
 *    share grants.
 * 3. The marker must name the share. A marker that lost its share id cannot
 *    address a route, and guessing one is not available.
 *
 * This is what LISTING and WITHDRAWING already-sent changes need, and
 * deliberately all they need. Submitting is a reversible state change, and a
 * reverse path a downgrade removes is not a reverse path — it would strand
 * work in front of a granter who may never answer it. The relay draws the
 * same line: its withdraw route asks for membership, not for edit.
 */
export function requireShareViewMembership(
  shareView: unknown,
): ShareViewProposalScope {
  if (!shareViewIsPresent(shareView)) {
    throw new Error("This workspace is not a shared view.");
  }
  const marker = isRecord(shareView) ? shareView : {};
  const grant = recordedShareSelector(marker.grantedSelector);
  if (!grant) throw new SharedFileReadOnlyError();
  const shareId = typeof marker.shareId === "string" ? marker.shareId : "";
  if (!shareId) throw new SharedFileReadOnlyError();
  return { shareId, grant };
}

/**
 * The same scope, for SENDING: the level must positively be `edit`, and the
 * share must not have ended.
 */
export function requireShareViewProposalScope(
  shareView: unknown,
): ShareViewProposalScope {
  const scope = requireShareViewMembership(shareView);
  const marker = isRecord(shareView) ? shareView : {};
  if (
    !shareViewTakesLocalWrites({
      access: scope.grant.access,
      ended: marker.ended === true,
    })
  ) {
    throw new SharedFileReadOnlyError();
  }
  return scope;
}

/**
 * Where one proposed change lands, for a surface that shows one path per row.
 *
 * A write states its after path; a delete states the path it removes. The
 * granter's CURRENT path is the last resort, for the case where the relay
 * described a change whose own two paths it could not state — a row worth
 * showing as damaged rather than dropping from the review.
 */
export function shareProposalOpPath(op: {
  afterPath: string | null;
  basedOnPath: string | null;
  currentPath: string | null;
}): string | null {
  return op.afterPath ?? op.basedOnPath ?? op.currentPath;
}

/**
 * Refuse the granter lane for a share view.
 *
 * PRESENCE, not level: an edit share view is writable and still is not the
 * granter of anything. Accepting changes into someone else's workspace is not
 * a right any level carries.
 */
export function assertShareProposalGranter(shareView: unknown): void {
  if (shareViewIsPresent(shareView)) {
    throw new Error(
      "This is a shared view — open the workspace you shared from to review changes.",
    );
  }
}
