import { SAVE_STATE } from "./ui/StateMark";

// The save chip's tooltip says the same when a person's access ends.
export const ACCESS_ENDED_REASON = "Your access to this document ended.";

// Why a document is read-only, one sentence for each reason, in the words its
// save chip uses. A cause with its own notice above the page, such as a lossy
// note or a deleted file, adds no sentence here.
export function readOnlyReasons(causes: { accessEnded: boolean; shared: boolean; tooLarge: boolean }): string[] {
  const reasons = [
    causes.accessEnded ? ACCESS_ENDED_REASON : undefined,
    // Ended access says more than shared access.
    causes.shared && !causes.accessEnded ? SAVE_STATE["read-only"].title : undefined,
    causes.tooLarge ? SAVE_STATE["too-large"].title : undefined,
  ];
  return reasons.filter((reason): reason is string => reason !== undefined);
}
