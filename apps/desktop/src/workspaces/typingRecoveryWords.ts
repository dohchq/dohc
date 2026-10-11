import type { TypingRecoveryFailure } from "./outageTypingRecovery";
export const CHECKPOINT_FAILURE_MESSAGE = "dohc could not keep your typing on this computer. Keep this window open.";
export const IMPORT_FAILURE_MESSAGE = "dohc could not recover your typing. The kept copy stays on this computer.";
export const AUTHOR_REFUSED_MESSAGE = "Typing by another person cannot be recovered here. The kept copy stays on this computer.";
export const INVALID_AUTHOR_MESSAGE = "dohc could not read who wrote this typing. The kept copy stays on this computer.";
export const HISTORY_MISSING_MESSAGE = "This file is no longer in History. The kept copy stays on this computer.";
export const DRAWING_UNAVAILABLE_MESSAGE = "dohc cannot keep drawing changes while it reconnects. Keep this window open.";
export function typingRecoveryMessage(failure:TypingRecoveryFailure):string {
 switch(failure.reason){case "author-refused":return AUTHOR_REFUSED_MESSAGE;case "invalid-author":return INVALID_AUTHOR_MESSAGE;case "history-missing":return HISTORY_MISSING_MESSAGE;case "drawing-unavailable":return DRAWING_UNAVAILABLE_MESSAGE;default:return failure.kind === "checkpoint" ? CHECKPOINT_FAILURE_MESSAGE : IMPORT_FAILURE_MESSAGE;}
}
