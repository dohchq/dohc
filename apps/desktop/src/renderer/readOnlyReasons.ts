import type { UseEngineDoc } from "./collab/useEngineDoc";
import { SAVE_STATE } from "./ui/StateMark";

// The save chip's tooltip says the same when a person's access ends.
export const ACCESS_ENDED_REASON = "Your access to this document ended.";
// The chip's Try again finishes the replacement.
export const REPLACEMENT_FAILED_REASON = "dohc could not finish replacing this document. Try again to finish it.";
// The session stays read-only until the document is reopened.
export const CONNECTION_LOST_REASON = "dohc lost its connection to this document. Close and reopen it to edit.";

// The sentence for a session that became read-only with no edit set aside.
// Ended access has its own reason.
export function transitionReason(cause: UseEngineDoc["readOnlyCause"]): string | undefined {
  if (cause === "lineage-failure") return REPLACEMENT_FAILED_REASON;
  if (cause === "reconnecting") return CONNECTION_LOST_REASON;
  return undefined;
}

// Why a document is read-only, one sentence for each reason, in the words its
// save chip uses. A cause with its own notice above the page, such as a lossy
// note or a deleted file, adds no sentence here.
export function readOnlyReasons(causes: {
  accessEnded: boolean;
  shared: boolean;
  tooLarge: boolean;
  transition: UseEngineDoc["readOnlyCause"];
}): string[] {
  const reasons = [
    causes.accessEnded ? ACCESS_ENDED_REASON : undefined,
    // Ended access says more than shared access.
    causes.shared && !causes.accessEnded ? SAVE_STATE["read-only"].title : undefined,
    causes.tooLarge ? SAVE_STATE["too-large"].title : undefined,
    transitionReason(causes.transition),
  ];
  return reasons.filter((reason): reason is string => reason !== undefined);
}
