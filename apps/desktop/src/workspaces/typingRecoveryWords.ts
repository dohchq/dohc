import type { TypingRecoveryFailure } from "./outageTypingRecovery";
export const CHECKPOINT_FAILURE_MESSAGE =
  "dohc could not keep your typing on this computer. Keep this window open.";
export const IMPORT_FAILURE_MESSAGE =
  "dohc could not recover your typing. The kept copy stays on this computer.";
export const AUTHOR_REFUSED_MESSAGE =
  "dohc cannot recover typing by another person here. The kept copy stays on this computer.";
export const INVALID_AUTHOR_MESSAGE =
  "dohc could not read who wrote this typing. The kept copy stays on this computer.";
export const HISTORY_MISSING_MESSAGE =
  "This file is no longer in History. The kept copy stays on this computer.";
export function typingRecoveryMessage(failure: TypingRecoveryFailure): string {
  switch (failure.reason) {
    case "author-refused":
      return AUTHOR_REFUSED_MESSAGE;
    case "invalid-author":
      return INVALID_AUTHOR_MESSAGE;
    case "history-missing":
      return HISTORY_MISSING_MESSAGE;
    default:
      return failure.kind === "checkpoint" ? CHECKPOINT_FAILURE_MESSAGE : IMPORT_FAILURE_MESSAGE;
  }
}
