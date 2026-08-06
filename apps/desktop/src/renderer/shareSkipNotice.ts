// What a share's skipped ops say to the user, in one place because two
// surfaces say it — the workspace banner for a shared view, and the
// shared-with-me row for a mount.
//
// The classes are NOT interchangeable, and treating them as one was a false
// cause: "outside what this share covers — ask the granter" is right when the
// grant excluded the op, and wrong on both counts when the relay sent an
// envelope the engine could not read. There the selector may well cover the
// update, nothing about the share is at fault, and the granter can change
// nothing. So each class says only what is true of it, and none invents a
// next step it does not have — or withholds one it does.

/** Refusals the boundary made: the op fell outside what the share granted. */
const BOUNDARY_CODE = "share-boundary-violation";

/**
 * The file is authentically the granter's and over the ceiling dohc stores.
 *
 * The only replay refusal a person can act on. No repair at the relay helps,
 * but the granter making the file smaller and sharing it again arrives as a
 * new update. `RelayError::ShareBlobOverCeiling`
 * (`crates/dohc-engine-sync/src/error.rs`) mints this code so the notice can
 * say so instead of reporting it as unappliable.
 */
const OVER_CEILING_CODE = "share-blob-over-ceiling";

/**
 * Whether a share has skipped ops the user has not seen.
 *
 * Dismissing raises the acknowledged generation and deletes nothing, so
 * "is there a warning?" is a comparison, not the record's presence. Both
 * surfaces that show the notice ask this, and so does the boot snapshot the
 * workspace shell starts from — a restatement that drifts in one of them
 * shows a warning the user dismissed, or hides one they never saw.
 */
export function hasUnacknowledgedShareSkips<
  T extends { generation: number; acknowledgedGeneration?: number },
>(skipped: T | null | undefined): skipped is T {
  return (
    skipped !== null &&
    skipped !== undefined &&
    skipped.generation > (skipped.acknowledgedGeneration ?? 0)
  );
}

export interface ShareSkipNoticeInput {
  ops: ReadonlyArray<{ code: string; detail: string }>;
  more: number;
  inexact?: boolean;
}

export interface ShareSkipNoticeLine {
  // `unknown` is the overflow: ops the record counted but could not keep, so
  // their cause is not knowable from the record.
  kind: "boundary" | "oversized" | "malformed" | "unknown";
  text: string;
  /** The engine's own message, for the element's title. */
  detail: string | undefined;
}

function updates(total: number): string {
  return `${total} ${total === 1 ? "update" : "updates"}`;
}

/**
 * One line per class present, plus one for the ops whose class is unknown.
 *
 * `more` counts ops the record could not keep, and it keeps NO class with
 * them. Adding it to whichever class the retained sample happens to show is
 * the same false attribution one level down: twenty boundary refusals and one
 * malformed overflow would tell the reader all twenty-one were outside the
 * share and to go ask the granter, and the inverse would bury an actionable
 * boundary refusal inside a count it cannot act on. So the overflow says only
 * what is known — that they were skipped — and claims no cause and no next
 * step.
 */
export function shareSkipNoticeLines(
  skipped: ShareSkipNoticeInput,
  granterEmail: string | null,
): ShareSkipNoticeLine[] {
  const boundary = skipped.ops.filter((op) => op.code === BOUNDARY_CODE);
  const oversized = skipped.ops.filter((op) => op.code === OVER_CEILING_CODE);
  const malformed = skipped.ops.filter(
    (op) => op.code !== BOUNDARY_CODE && op.code !== OVER_CEILING_CODE,
  );
  const lines: ShareSkipNoticeLine[] = [];
  if (boundary.length > 0) {
    lines.push({
      kind: "boundary",
      text: `dohc skipped ${updates(boundary.length)} outside what this share covers. Ask ${
        granterEmail ?? "the person who shared it"
      }.`,
      detail: boundary[0]?.detail,
    });
  }
  if (oversized.length > 0) {
    lines.push({
      kind: "oversized",
      // The one class with a Next, because the granter really can act: the
      // cursor has committed past these files, and a smaller copy shared
      // again arrives as a new update.
      text: `dohc skipped ${updates(oversized.length)} with files over the size limit. Ask ${
        granterEmail ?? "the person who shared it"
      } to make them smaller and share them again.`,
      detail: oversized[0]?.detail,
    });
  }
  if (malformed.length > 0) {
    lines.push({
      kind: "malformed",
      // No instruction: the update was sent in a form dohc cannot read, and
      // there is nothing the reader or the granter can do about that.
      text: `dohc couldn't apply ${updates(malformed.length)} this share sent.`,
      detail: malformed[0]?.detail,
    });
  }
  if (skipped.more > 0) {
    // "at least" rather than "more than N more", which is what the same fact
    // reads like beside the word `more`. The count is a true lower bound —
    // it holds only ops the record can prove distinct — so both are honest
    // and this one is plain.
    const more = skipped.more;
    lines.push({
      kind: "unknown",
      text: `dohc skipped ${skipped.inexact ? "at least " : ""}${more} more ${
        more === 1 && !skipped.inexact ? "update" : "updates"
      } from this share.`,
      detail: undefined,
    });
  }
  return lines;
}
