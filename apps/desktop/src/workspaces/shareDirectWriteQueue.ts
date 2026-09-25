import type { PushShareDirectWritesResult } from "../ipc/bridgeContract";

// How long saves settle before a push. A burst of saves makes one push.
export const DIRECT_WRITE_PUSH_DELAY_MS = 800;

/**
 * Main's queue of direct pushes (ADR 0013), one lane per share view. A save
 * in an Edit share view asks for a push here, so the push goes even when the
 * window leaves the view before the delay ends. One push runs per view at a
 * time; a request during it runs one more after it.
 *
 * A relay that answers that it takes no direct writes keeps that answer for
 * the rest of the session: the lane is a deployment setting, and asking on
 * every save would send a request that fails. Send changes still works.
 */
export function createShareDirectWriteQueue(dependencies: {
  push(workspaceId: string): Promise<PushShareDirectWritesResult>;
  /** A push that no window asked for finished; windows on the view show it. */
  report(workspaceId: string, result: PushShareDirectWritesResult): void;
  delayMs?: number;
}) {
  const delayMs = dependencies.delayMs ?? DIRECT_WRITE_PUSH_DELAY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<PushShareDirectWritesResult>>();
  const again = new Set<string>();
  const unavailable = new Set<string>();

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
    if (result.status === "unavailable") unavailable.add(workspaceId);
    return result;
  }

  function run(workspaceId: string): Promise<PushShareDirectWritesResult> {
    if (unavailable.has(workspaceId)) return Promise.resolve({ status: "unavailable" });
    const current = running.get(workspaceId);
    if (current) {
      again.add(workspaceId);
      return current;
    }
    const pushed = pushOnce(workspaceId).finally(() => {
      running.delete(workspaceId);
      if (again.delete(workspaceId)) {
        void run(workspaceId).then((result) => dependencies.report(workspaceId, result));
      }
    });
    running.set(workspaceId, pushed);
    return pushed;
  }

  return {
    /** A file in the share view was saved or created. */
    edited(workspaceId: string): void {
      if (unavailable.has(workspaceId)) return;
      const timer = timers.get(workspaceId);
      if (timer !== undefined) clearTimeout(timer);
      timers.set(workspaceId, setTimeout(() => {
        timers.delete(workspaceId);
        void run(workspaceId).then((result) => dependencies.report(workspaceId, result));
      }, delayMs));
    },
    /** Pushes now, as a view does when it opens, and answers the caller. */
    pushNow(workspaceId: string): Promise<PushShareDirectWritesResult> {
      return run(workspaceId);
    },
  };
}
