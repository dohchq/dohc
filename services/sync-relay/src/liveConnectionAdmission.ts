import {createLiveBufferBudget, LiveConnectionLimitError, type LiveConnectionLimitCode} from "@dohc/live-session-contract/live-connection";
/** A relay shares these reservations across its owner, desktop, and browser routes. */
export function createLiveConnectionAdmission() {
  const counts = new Map<string, number>();
  let budgets: {frames: ReturnType<typeof createLiveBufferBudget>; validation: ReturnType<typeof createLiveBufferBudget>} | undefined;
  let maximum: number | undefined;
  const shared = (maxBytes: number) => {
    if (maximum !== undefined && maximum !== maxBytes) throw new TypeError("Live routes must share one buffer budget.");
    maximum = maxBytes;
    return budgets ??= {frames: createLiveBufferBudget(maxBytes), validation: createLiveBufferBudget(maxBytes)};
  };
  return {
    buffers: (maxBytes: number) => shared(maxBytes).frames,
    /** Checking an edit has its own pool, so it never takes room from any route's frames. */
    validationBuffers: (maxBytes: number) => shared(maxBytes).validation,
    reserve(bounds: readonly (readonly [string, number, LiveConnectionLimitCode?])[]): (() => void) | null {
      const exceeded = bounds.find(([key, limit]) => (counts.get(key) ?? 0) >= limit);
      if (exceeded) { if (exceeded[2]) throw new LiveConnectionLimitError(exceeded[2]); return null; }
      const keys = bounds.map(([key]) => key);
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const key of keys) {
          const remaining = counts.get(key)! - 1;
          if (remaining) counts.set(key, remaining); else counts.delete(key);
        }
      };
    },
  };
}
