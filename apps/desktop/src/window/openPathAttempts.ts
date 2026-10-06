import { randomUUID } from "node:crypto";

// Enough for every folder one launch names; the oldest goes first after that.
const ATTEMPT_LIMIT = 32;

/**
 * Folders a launch or the OS could not open, each held for one Try again by
 * the window that was told. The renderer names an attempt, never a path, so
 * it cannot make main open a folder nobody asked for.
 */
export function createOpenPathAttempts(limit = ATTEMPT_LIMIT) {
  const attempts = new Map<string, { path: string; windowId: number }>();
  return {
    issue(path: string, windowId: number): string {
      const attemptId = randomUUID();
      attempts.set(attemptId, { path, windowId });
      for (const oldest of attempts.keys()) {
        if (attempts.size <= limit) break;
        attempts.delete(oldest);
      }
      return attemptId;
    },
    // Another window's attempt stays for the window it belongs to.
    take(attemptId: string, windowId: number): string | null {
      const attempt = attempts.get(attemptId);
      if (attempt?.windowId !== windowId) return null;
      attempts.delete(attemptId);
      return attempt.path;
    },
  };
}
