export const LIVE_CONNECTION_LIMIT_CLOSE_CODE = 4409;
export const LIVE_CONNECTION_LIMIT_MESSAGES = {
  live_total_limit: "This server has too many open documents. Try again after another document closes.",
  live_grant_limit: "This share has too many open documents. Try again after another document closes.",
  live_person_limit: "You have too many open documents. Close another document, then try again.",
  live_session_limit: "This editing session has too many open documents. Close another document, then try again.",
  live_buffer_limit: "This server has no room for more live editing data. Try again after another document closes.",
} as const;
export type LiveConnectionLimitCode = keyof typeof LIVE_CONNECTION_LIMIT_MESSAGES;
export function liveConnectionLimitMessage(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(LIVE_CONNECTION_LIMIT_MESSAGES, value)
    ? LIVE_CONNECTION_LIMIT_MESSAGES[value as LiveConnectionLimitCode] : undefined;
}
export class LiveConnectionLimitError extends Error {
  constructor(readonly code: LiveConnectionLimitCode) { super(LIVE_CONNECTION_LIMIT_MESSAGES[code]); }
}

/** Synchronous reservations; no buffered inputs or waiting queue. */
export function createLiveBufferBudget(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Invalid live buffer budget.");
  let bytes = 0;
  return {
    reserve(size: number): () => void {
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Invalid live buffer charge.");
      if (size > maxBytes - bytes) throw new LiveConnectionLimitError("live_buffer_limit");
      bytes += size;
      let held = true;
      return () => { if (held) { held = false; bytes -= size; } };
    },
    usage: () => bytes,
  };
}
