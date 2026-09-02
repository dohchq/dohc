// Trailing-edge coalescing for workspace-activity refreshes, shared by the
// shell and the lazy collection chunk (this module must stay a leaf: the
// CollectionPage chunk imports it and must not pull the shell in).

// Window that coalesces a burst of workspace-activity events into one
// refresh. Short enough that a lone save still feels immediate; long enough
// to cover main's per-batch event cadence.
export const WORKSPACE_ACTIVITY_REFRESH_DELAY_MS = 200;

// Cap on how long the trailing edge may keep sliding: a sustained burst
// whose events land inside the window (a long import, an agent writing
// continuously) would otherwise starve every refresh until it ends. During
// such a burst one refresh still fires per cap window.
export const WORKSPACE_ACTIVITY_REFRESH_MAX_WAIT_MS = 1_000;

/**
 * Schedules `run` on the trailing edge of an event burst: call `schedule()`
 * per event and `run` fires once the burst quiets or the cap lapses.
 * `cancel()` drops a pending run on unsubscribe.
 */
export function createActivityCoalescer(run: () => void): {
  schedule: () => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;
  return {
    schedule() {
      const now = Date.now();
      deadline ??= now + WORKSPACE_ACTIVITY_REFRESH_MAX_WAIT_MS;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          deadline = null;
          run();
        },
        Math.min(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS, deadline - now),
      );
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      deadline = null;
    },
  };
}
