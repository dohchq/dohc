/** A relay shares these reservations across its owner, desktop, and browser routes. */
export function createLiveConnectionAdmission() {
  const counts = new Map<string, number>();
  return {
    reserve(bounds: readonly (readonly [string, number])[]): (() => void) | null {
      if (bounds.some(([key, limit]) => (counts.get(key) ?? 0) >= limit)) return null;
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
