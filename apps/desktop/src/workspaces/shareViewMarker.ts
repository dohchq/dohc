import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { recordedShareSelector } from "./shareViewRecords";

// Reading a registry entry's share-view marker, as one rule in one place.
//
// Two surfaces ask about this marker and they must agree, because they fail
// in opposite directions when they do not:
//
//   main's `sharedViewOf` decides whether a workspace may be WRITTEN. If it
//   reads a damaged marker as "no share view", someone else's files become
//   writable — the enforcement layer failing open.
//
//   the renderer projection decides how the workspace is PRESENTED. If it
//   drops a damaged marker, the same workspace presents as an ordinary one.
//
// So presence and readability are separate questions, and only presence
// decides the restriction:
//
//   ABSENT  -> an ordinary workspace.
//   PRESENT -> a share view, restricted, whether or not it can be read.
//
// A stored `null` is PRESENT. It is a share-view field that lost its value,
// not a workspace that never had one, and `?? null` used to read the two as
// the same thing.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the entry claims to be a share view at all.
 *
 * Only an absent field means "ordinary workspace". Every other stored value,
 * `null` included, is a share view whose restrictions apply.
 */
export function shareViewIsPresent(shareView: unknown): boolean {
  return shareView !== undefined;
}

/**
 * The level a share view's PINNED grant names, or null when the grant cannot
 * be read completely.
 *
 * The grant is read back through `recordedShareSelector`, the same function
 * the refresh path uses, so the projection's verdict and the pull's verdict
 * cannot disagree. Restating the rule here would let the shell keep
 * presenting (and retrying) a share whose selector the pull permanently
 * refuses.
 */
export function readableShareLevel(grantedSelector: unknown): ShareAccess | null {
  const selector = recordedShareSelector(grantedSelector);
  return selector ? selector.access : null;
}

/**
 * The granter's email, only when it is one the wire schema will carry.
 *
 * Bounded to the schema's own limits on purpose: a damaged marker that
 * carried a 1-character email would fail the summary parse and throw out of
 * the whole projection — the zero-workspaces defect, reached through the very
 * field added to describe the damage.
 */
export function shareViewGranterEmail(shareView: unknown): string | null {
  if (!isRecord(shareView)) return null;
  const email = shareView.granterEmail;
  if (typeof email !== "string") return null;
  return email.length >= 3 && email.length <= 320 ? email : null;
}
