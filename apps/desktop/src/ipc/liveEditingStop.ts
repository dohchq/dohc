export const LIVE_STOP_EDITS_PENDING = "Live editing didn't stop. Recent edits haven't reached the server yet.";

// Electron wraps rejected handler messages in its own error string.
export function isLiveStopEditsPending(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LIVE_STOP_EDITS_PENDING);
}
