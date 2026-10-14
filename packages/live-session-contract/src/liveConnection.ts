export const LIVE_CONNECTION_LIMIT_CLOSE_CODE = 4409;
export const LIVE_CONNECTION_LIMIT_MESSAGES = {
  live_total_limit: "This server has too many open documents. Try again after another document closes.",
  live_workspace_limit: "This workspace has too many open documents. Try again after another document closes.",
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
  const scopedBytes = new Map<string, number>();
  return {
    reserve(size: number, scopes: readonly (readonly [string, number])[] = []): () => void {
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Invalid live buffer charge.");
      if (scopes.some(([, limit]) => !Number.isSafeInteger(limit) || limit < 1) ||
        new Set(scopes.map(([key]) => key)).size !== scopes.length) throw new TypeError("Invalid live buffer scope.");
      if (scopes.some(([key, limit]) => size > limit - (scopedBytes.get(key) ?? 0)) || size > maxBytes - bytes) throw new LiveConnectionLimitError("live_buffer_limit");
      bytes += size;
      for (const [key] of scopes) scopedBytes.set(key, (scopedBytes.get(key) ?? 0) + size);
      let held = true;
      return () => {
        if (!held) return;
        held = false; bytes -= size;
        for (const [key] of scopes) {
          const remaining = scopedBytes.get(key)! - size;
          if (remaining) scopedBytes.set(key, remaining); else scopedBytes.delete(key);
        }
      };
    },
    usage: () => bytes,
  };
}
