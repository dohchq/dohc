import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
export interface NamedFrameChanges { subscribe(changed: () => void, document?: LiveDocumentKey): () => void }
const key = (document: LiveDocumentKey) => JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);

/** One shared wake per microtask; notifications contain no bytes or event queue. */
export function createNamedFrameChanges(maxListeners: number) {
  if (!Number.isSafeInteger(maxListeners) || maxListeners < 1) throw new TypeError("Invalid frame listener bound.");
  const listeners = new Map<() => void, {document: string | undefined; dirty: boolean}>();
  let queued = false;
  return {
    maxListeners,
    subscribe(changed: () => void, document?: LiveDocumentKey) {
      if (listeners.size >= maxListeners) throw new Error("Frame listener capacity exhausted.");
      listeners.set(changed, {document: document ? key(document) : undefined, dirty: false});
      return () => { listeners.delete(changed); };
    },
    notify(document?: LiveDocumentKey) {
      const selected = document ? key(document) : undefined;
      for (const row of listeners.values()) if (row.document === undefined || selected !== undefined && row.document === selected) row.dirty = true;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        for (const [listener, row] of [...listeners]) {
          if (!row.dirty) continue;
          row.dirty = false;
          try { listener(); } catch { /* Other captures still receive this wake. */ }
        }
      });
    },
    listenerCount: () => listeners.size,
  };
}
