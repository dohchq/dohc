import type { PushShareDirectWritesResult } from "../ipc/bridgeContract";

// How long saves settle before a push. A burst of saves makes one push.
export const DIRECT_WRITE_PUSH_DELAY_MS = 800;
const MAX_HELD_ANSWERS = 8;

/**
 * Main's queue of direct pushes (ADR 0013), one lane per share view. A save
 * in an Edit share view asks for a push here, so the push goes even when the
 * window leaves the view before the delay ends. One push runs per view at a
 * time; a request during it runs one more after it.
 */
export function createShareDirectWriteQueue(dependencies: {
  push(workspaceId: string): Promise<PushShareDirectWritesResult>;
  /**
   * A push that no window asked for finished; windows on the view show it.
   * Answers false when no window shows the view.
   */
  report(workspaceId: string, result: PushShareDirectWritesResult): boolean;
  delayMs?: number;
}) {
  const delayMs = dependencies.delayMs ?? DIRECT_WRITE_PUSH_DELAY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<PushShareDirectWritesResult>>();
  const again = new Set<string>();
  // Answers no window has shown yet, per view, until one opens it.
  const held = new Map<string, PushShareDirectWritesResult[]>();

  function report(workspaceId: string, result: PushShareDirectWritesResult): void {
    if (result.status === "pushed" && result.writes.every((write) => write.result === "written")) return;
    if (dependencies.report(workspaceId, result)) return;
    const waiting = held.get(workspaceId) ?? [];
    // The newest few are enough to say what went wrong.
    held.set(workspaceId, [...waiting, result].slice(-MAX_HELD_ANSWERS));
  }

  async function pushOnce(workspaceId: string): Promise<PushShareDirectWritesResult> {
    let result: PushShareDirectWritesResult;
    try {
      result = await dependencies.push(workspaceId);
    } catch (error) {
      result = {
        status: "failed",
        writes: [],
        errorMessage: error instanceof Error ? error.message : String(error),
        lasting: false,
      };
    }
    return result;
  }

  function run(workspaceId: string): Promise<PushShareDirectWritesResult> {
    const current = running.get(workspaceId);
    if (current) {
      again.add(workspaceId);
      return current;
    }
    const pushed = pushOnce(workspaceId).finally(() => {
      running.delete(workspaceId);
      if (again.delete(workspaceId)) {
        void run(workspaceId).then((result) => report(workspaceId, result));
      }
    });
    running.set(workspaceId, pushed);
    return pushed;
  }

  return {
    /** Shows windows on the view an answer, or holds it until one opens. */
    report,
    /** A file in the share view was saved or created. */
    edited(workspaceId: string): void {
      const timer = timers.get(workspaceId);
      if (timer !== undefined) clearTimeout(timer);
      timers.set(workspaceId, setTimeout(() => {
        timers.delete(workspaceId);
        void run(workspaceId).then((result) => report(workspaceId, result));
      }, delayMs));
    },
    /**
     * Pushes now, as a view does when it opens, and answers the caller. A
     * save waiting for its delay goes with it, and answers held while no
     * window showed the view are shown again.
     */
    pushNow(workspaceId: string): Promise<PushShareDirectWritesResult> {
      const timer = timers.get(workspaceId);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(workspaceId);
      const waiting = held.get(workspaceId) ?? [];
      held.delete(workspaceId);
      for (const result of waiting) report(workspaceId, result);
      return run(workspaceId);
    },
  };
}
