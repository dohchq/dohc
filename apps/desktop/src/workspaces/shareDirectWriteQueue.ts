import type { PushShareDirectWritesResult } from "../ipc/bridgeContract";

// How long saves settle before a push. A burst of saves makes one push.
export const DIRECT_WRITE_PUSH_DELAY_MS = 800;

/**
 * Main's queue of direct pushes (ADR 0013), one lane per share view. A save
 * in an Edit share view asks for a push here, so the push goes even when the
 * window leaves the view before the delay ends. One push runs per view at a
 * time; a request during it runs one more after it.
 */
export function createShareDirectWriteQueue(dependencies: {
  push(workspaceId: string): Promise<PushShareDirectWritesResult>;
  /**
   * Every push uses this feedback lane. Delivery holds answers until shown.
   */
  report(workspaceId: string, result: PushShareDirectWritesResult): void;
  /** Refresh definition delivery status when a push has writes or cannot finish. */
  settled?(workspaceId: string): void;
  delayMs?: number;
}) {
  const delayMs = dependencies.delayMs ?? DIRECT_WRITE_PUSH_DELAY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  function report(workspaceId: string, result: PushShareDirectWritesResult): void {
    if (result.status === "pushed" && result.writes.every((write) => write.result === "written")) return;
    dependencies.report(workspaceId, result);
  }

  async function pushOnce(workspaceId: string): Promise<void> {
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
    if (result.status !== "pushed" || result.writes.length > 0) dependencies.settled?.(workspaceId);
    report(workspaceId, result);
  }

  function run(workspaceId: string): Promise<void> {
    const current = running.get(workspaceId);
    if (current) {
      again.add(workspaceId);
      return current;
    }
    const pushed = pushOnce(workspaceId).finally(() => {
      running.delete(workspaceId);
      if (again.delete(workspaceId)) {
        void run(workspaceId);
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
        void run(workspaceId);
      }, delayMs));
    },
    /**
     * Pushes now and answers only completion. Feedback always uses report,
     * including when a draft retry joins a background push.
     */
    pushNow(workspaceId: string): Promise<void> {
      const timer = timers.get(workspaceId);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(workspaceId);
      return run(workspaceId);
    },
  };
}
