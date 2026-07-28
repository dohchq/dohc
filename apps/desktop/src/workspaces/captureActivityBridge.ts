import type { Event } from "@dohc/workspace-engine-client";

/** Emitted by the daemon once per settled capture batch / reconcile pass. */
export const CAPTURE_MOMENT_RECORDED_EVENT = "capture.momentRecorded";

const DEFAULT_DEBOUNCE_MS = 100;

// The daemon records capture moments autonomously — no TS write path runs, so
// nothing else pings the renderer's workspace-activity channel when one lands
// and the history timeline would stay stale forever. Bridge the daemon's
// capture events onto the existing notify seam, debounced so a multi-file
// reconcile costs one repaint.
export function bridgeCaptureEventsToRenderer(
  daemon: { onEvent(handler: (event: Event) => void): () => void },
  notify: () => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = daemon.onEvent((event) => {
    if (event.name !== CAPTURE_MOMENT_RECORDED_EVENT) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      notify();
    }, debounceMs);
    timer.unref?.();
  });
  return () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
