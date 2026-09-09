export interface NamedFrameChanges { subscribe(changed: () => void): () => void }

/** One shared wake per microtask; notifications contain no bytes or event queue. */
export function createNamedFrameChanges(maxListeners: number) {
  if (!Number.isSafeInteger(maxListeners) || maxListeners < 1) throw new TypeError("Invalid frame listener bound.");
  const listeners = new Set<() => void>();
  let queued = false;
  return {
    subscribe(changed: () => void) {
      if (listeners.size >= maxListeners) throw new Error("Frame listener capacity exhausted.");
      listeners.add(changed);
      return () => { listeners.delete(changed); };
    },
    notify() {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        for (const listener of [...listeners]) {
          try { listener(); } catch { /* Other captures still receive this wake. */ }
        }
      });
    },
    listenerCount: () => listeners.size,
  };
}
