import type { UseEngineDoc } from "./collab/useEngineDoc";
import { SAVE_STATE } from "./ui/StateMark";

// The save chip's tooltip says the same when a person's access ends.
export const ACCESS_ENDED_REASON = "Your access to this document ended.";
// The chip's Try again finishes the replacement.
export const REPLACEMENT_FAILED_REASON = "dohc could not finish replacing this document. Try again to finish it.";
// The session stays read-only until the document is reopened.
export const CONNECTION_LOST_REASON = "dohc lost its connection to this document. Close and reopen it to edit.";

// Why this session became read-only, beside any row it set aside, since no row
// says why. None once the file is gone, because its notice says why, or when
// access ended, which has its own reason.
export function transitionReason(
  engine: Pick<UseEngineDoc, "readOnlyWhileEditing" | "readOnlyCause" | "deletedWhileEditing">,
): string | undefined {
  if (!engine.readOnlyWhileEditing || engine.deletedWhileEditing) return undefined;
  if (engine.readOnlyCause === "lineage-failure") return REPLACEMENT_FAILED_REASON;
  if (engine.readOnlyCause === "reconnecting") return CONNECTION_LOST_REASON;
  return undefined;
}

// Why a document is read-only, one sentence for each reason. The source strip
// and the save chip's tooltip both say it. A cause with its own notice above
// the page, such as a lossy note, a truncated file or a deleted one, adds no
// sentence here.
export function readOnlyReasons(causes: {
  accessEnded: boolean;
  shared: boolean;
  transition: string | undefined;
}): string[] {
  const reasons = [
    causes.accessEnded ? ACCESS_ENDED_REASON : undefined,
    // Ended access says more than shared access.
    causes.shared && !causes.accessEnded ? SAVE_STATE["read-only"].title : undefined,
    causes.transition,
  ];
  return reasons.filter((reason): reason is string => reason !== undefined);
}
