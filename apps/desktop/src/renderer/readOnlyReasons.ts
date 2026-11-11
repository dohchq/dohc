import type { UseEngineDoc } from "./collab/useEngineDoc";
import { SAVE_STATE } from "./ui/StateMark";

// The save chip's tooltip says the same when a person's access ends.
export const ACCESS_ENDED_REASON = "Your access to this document ended.";
// The chip's Try again finishes the replacement.
export const REPLACEMENT_FAILED_REASON = "dohc could not finish replacing this document. Try again to finish it.";
// Tabs showing the document share one session. It stays read-only until every
// tab closes, and reopening then starts a fresh one.
export const CONNECTION_LOST_REASON = "dohc lost its connection to this document. Close every tab showing it, then reopen it to edit.";
// An edit dohc refused for good, once its set-aside row is dismissed. Tabs share
// one session, so only closing every tab ends it.
export const NOT_SAVED_REASON = "dohc could not save this document. Close every tab showing it, then reopen it to edit.";
// The server took none of this computer's live edits to the document, or too
// many wait to reach it. Its Notices row offers what ends the pause.
export const LIVE_EDITING_PAUSED_REASON = "Live editing is paused for this document. Open Notices to continue.";

// Why this session became read-only, beside any row it set aside, since no row
// says why. None when access ended, which has its own reason.
export function transitionReason(
  engine: Pick<UseEngineDoc, "readOnlyWhileEditing" | "readOnlyCause">,
): string | undefined {
  if (!engine.readOnlyWhileEditing) return undefined;
  if (engine.readOnlyCause === "lineage-failure") return REPLACEMENT_FAILED_REASON;
  if (engine.readOnlyCause === "reconnecting") return CONNECTION_LOST_REASON;
  return undefined;
}

// Why a document is read-only, one sentence for each reason. The source strip
// and the save chip's tooltip both say it. A cause with its own notice above
// the page, such as a lossy note, a truncated file or a deleted one, adds no
// sentence here, and a gone file's notice is the only reason given.
export function readOnlyReasons(causes: {
  gone: boolean;
  accessEnded: boolean;
  shared: boolean;
  transition: string | undefined;
  // Refused for good, with its set-aside row dismissed.
  notSaved: boolean;
  // This computer's live edits to it wait on the server.
  livePaused: boolean;
}): string[] {
  if (causes.gone) return [];
  const reasons = [
    causes.accessEnded ? ACCESS_ENDED_REASON : undefined,
    // Ended access says more than shared access.
    causes.shared && !causes.accessEnded ? SAVE_STATE["read-only"].title : undefined,
    causes.transition,
    causes.notSaved ? NOT_SAVED_REASON : undefined,
    causes.livePaused ? LIVE_EDITING_PAUSED_REASON : undefined,
  ];
  return reasons.filter((reason): reason is string => reason !== undefined);
}
