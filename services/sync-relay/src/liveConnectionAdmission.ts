import {createLiveBufferBudget, LiveConnectionLimitError, type LiveConnectionLimitCode} from "@dohc/live-session-contract/live-connection";
/** A relay shares these reservations across its owner, desktop, and browser routes. */
export function createLiveConnectionAdmission() {
  const counts = new Map<string, number>();
  let budget: ReturnType<typeof createLiveBufferBudget> | undefined, maximum: number | undefined;
  return {
    buffers(maxBytes: number) {
      if (maximum !== undefined && maximum !== maxBytes) throw new TypeError("Live routes must share one buffer budget.");
      maximum = maxBytes;
      return budget ??= createLiveBufferBudget(maxBytes);
    },
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
