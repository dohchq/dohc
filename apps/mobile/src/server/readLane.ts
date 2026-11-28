export const PREFETCH_AT_ONCE = 2;

export interface ReadLane {
  screen<T>(read: () => Promise<T>, byPerson: boolean): Promise<T>;
  ahead<T>(
    signal: AbortSignal,
    read: (signal: AbortSignal, promote: () => boolean) => Promise<T>,
  ): Promise<T>;
  free(): boolean;
  onFree(listener: () => void): () => void;
}

const lanes = new WeakMap<object, ReadLane>();

function start<T>(read: () => Promise<T>): Promise<T> {
  try {
    return read();
  } catch (error) {
    return Promise.reject(error);
  }
}

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
    screen(read, byPerson) {
      screens += 1;
      if (byPerson) for (const controller of ahead) controller.abort();
      return start(read).finally(() => {
        screens -= 1;
        settled();
      });
    },
    ahead(signal, read) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort);
      if (signal.aborted) abort();
      ahead.add(controller);
      let promoted = false;
      let finished = false;
      const promote = () => {
        if (finished || promoted || controller.signal.aborted) return false;
        promoted = true;
        ahead.delete(controller);
        screens += 1;
        for (const other of ahead) other.abort();
        return true;
      };
      return start(() => read(controller.signal, promote)).finally(() => {
        finished = true;
        signal.removeEventListener("abort", abort);
        if (promoted) screens -= 1;
        else ahead.delete(controller);
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
