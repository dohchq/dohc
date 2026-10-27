const POLL_MS = 500;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function createDeferredWritePoller<T>(options: {
  read: (signal: AbortSignal) => Promise<readonly T[]>;
  changedOutside: (change: T) => void;
  onError: (error: unknown) => void;
}): { setActive(active: boolean): void; stop(): void } {
  let active = false;
  let stopped = false;
  let inFlight = false;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;

  function clearPending(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    request?.abort();
  }

  async function poll(): Promise<void> {
    if (stopped || !active || inFlight) return;
    inFlight = true;
    const current = new AbortController();
    request = current;
    let delayMs = POLL_MS;
    try {
      const changes = await options.read(current.signal);
      if (stopped || !active || current.signal.aborted) return;
      backoffMs = INITIAL_BACKOFF_MS;
      for (const change of changes) {
        if (stopped || !active || current.signal.aborted) break;
        options.changedOutside(change);
      }
    } catch (error) {
      if (stopped || !active || current.signal.aborted) return;
      delayMs = backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      options.onError(error);
    } finally {
      inFlight = false;
      request = null;
      if (active && !stopped) {
        // A reopened session starts afresh after the cancelled read returns.
        timer = setTimeout(() => {
          timer = null;
          void poll();
        }, current.signal.aborted ? 0 : delayMs);
        timer.unref?.();
      }
    }
  }

  return {
    setActive(next) {
      if (stopped || active === next) return;
      active = next;
      clearPending();
      if (active) {
        backoffMs = INITIAL_BACKOFF_MS;
        void poll();
      }
    },
    stop() {
      stopped = true;
      active = false;
      clearPending();
    },
  };
}
