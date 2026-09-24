import { readError, UNKNOWN_ERROR_WORDS } from "../ipc/errorWords";

// The words a person reads for a failed call. A sentence the error wrote for
// a person stands alone. Words from the map say why, so the fallback, the
// caller's sentence about what failed, goes before them.
export function ipcErrorMessage(error: unknown, fallback?: string): string {
  const { words, mapped } = readError(error);
  if (words === null) return fallback ?? UNKNOWN_ERROR_WORDS;
  return mapped && fallback ? `${fallback} ${words}` : words;
}
