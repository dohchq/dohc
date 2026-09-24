import { readError, UNKNOWN_ERROR_WORDS } from "../ipc/errorWords";

// The words a person reads for a failed call: the error's own sentence, or
// the words for its class and code, or the caller's fallback.
export function ipcErrorMessage(error: unknown, fallback?: string): string {
  return readError(error).words ?? fallback ?? UNKNOWN_ERROR_WORDS;
}
