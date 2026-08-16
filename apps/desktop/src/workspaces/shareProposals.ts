import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import { recordedShareSelector } from "./sharedView";
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
 * Resolve the recipient lane for a workspace, or refuse.
 *
 * Four separate reasons, in the order that makes each answer true:
 *
 * 1. PRESENCE — the same question `sharedViewOf` asks before a write. A
 *    workspace with no share marker has no share to send changes through.
 * 2. The pinned grant must READ BACK completely, through the same function
 *    the pull uses, so this gate and the pull cannot disagree about what the
 *    share grants.
 * 3. The level must positively be `edit`, and the share must not have ended.
 * 4. The marker must name the share. A marker that lost its share id cannot
 *    address a route, and guessing one is not available.
 */
export function requireShareViewProposalScope(
  shareView: unknown,
): ShareViewProposalScope {
  if (!shareViewIsPresent(shareView)) {
    throw new Error("This workspace is not a shared view.");
  }
  const marker = isRecord(shareView) ? shareView : {};
  const grant = recordedShareSelector(marker.grantedSelector);
  if (!grant) throw new SharedFileReadOnlyError();
  if (
    !shareViewTakesLocalWrites({
      access: grant.access,
      ended: marker.ended === true,
    })
  ) {
    throw new SharedFileReadOnlyError();
  }
  const shareId = typeof marker.shareId === "string" ? marker.shareId : "";
  if (!shareId) throw new SharedFileReadOnlyError();
  return { shareId, grant };
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
