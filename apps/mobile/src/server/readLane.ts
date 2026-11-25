export const PREFETCH_AT_ONCE = 2;

/** One sign-in's reads. A screen's read aborts read-ahead on its way, and none starts until it settles. */
export interface ReadLane {
  screen<T>(read: () => Promise<T>): Promise<T>;
  /** Read-ahead, at most `PREFETCH_AT_ONCE` at once, with a signal that `signal` or a screen's read aborts. */
  ahead<T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T>;
  free(): boolean;
  onFree(listener: () => void): () => void;
}

const lanes = new WeakMap<object, ReadLane>();

export function readLane(signIn: object): ReadLane {
  const found = lanes.get(signIn);
  if (found) return found;
  let screens = 0;
  const ahead = new Set<AbortController>();
  const listeners = new Set<() => void>();
  const settled = () => {
    for (const listener of [...listeners]) listener();
  };
  const lane: ReadLane = {
    screen(read) {
      screens += 1;
      for (const controller of ahead) controller.abort();
      return read().finally(() => {
        screens -= 1;
        settled();
      });
    },
    ahead(signal, read) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort);
      ahead.add(controller);
      return read(controller.signal).finally(() => {
        signal.removeEventListener("abort", abort);
        ahead.delete(controller);
        settled();
      });
    },
    free: () => screens === 0 && ahead.size < PREFETCH_AT_ONCE,
    onFree(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  lanes.set(signIn, lane);
  return lane;
}
