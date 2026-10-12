import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
type DocumentScope = LiveDocumentKey | Pick<LiveDocumentKey, "workspaceId" | "objectId">;
export interface NamedFrameChanges { subscribe(changed: () => void, document?: DocumentScope): () => void }
const key = (document: LiveDocumentKey) => JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);

/** One shared wake per microtask; notifications contain no bytes or event queue. */
export function createNamedFrameChanges(maxListeners: number) {
  if (!Number.isSafeInteger(maxListeners) || maxListeners < 1) throw new TypeError("Invalid frame listener bound.");
  type Listener = {document: string | undefined; object: string | undefined; workspace: string | undefined; dirty: boolean};
  const listeners = new Map<() => void, Listener>();
  // Desktop admission/readiness subscriptions have their own listener pool.
  const objectListeners = new Map<() => void, Listener>();
  let queued = false;
  const wake = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const [listener, row] of [...listeners, ...objectListeners]) {
        if (!row.dirty) continue;
        row.dirty = false;
        try { listener(); } catch { /* Other captures still receive this wake. */ }
      }
    });
  };
  return {
    maxListeners,
    subscribe(changed: () => void, document?: DocumentScope) {
      const pool = document && !("lineageClaimId" in document) ? objectListeners : listeners;
      if (pool.size >= maxListeners) throw new Error("Frame listener capacity exhausted.");
      pool.set(changed, {document: document && "lineageClaimId" in document ? key(document) : undefined,
        object: document ? JSON.stringify([document.workspaceId, document.objectId]) : undefined,
        workspace: document?.workspaceId, dirty: false});
      return () => { pool.delete(changed); };
    },
    notify(document?: LiveDocumentKey) {
      const selected = document ? key(document) : undefined;
      const object = document ? JSON.stringify([document.workspaceId, document.objectId]) : undefined;
      for (const row of [...listeners.values(), ...objectListeners.values()]) if (row.object === undefined || selected !== undefined &&
        (row.document ? row.document === selected : row.object === object)) row.dirty = true;
      wake();
    },
    notifyHost(workspaceIds: readonly string[]) {
      const workspaces = new Set(workspaceIds);
      for (const row of [...listeners.values(), ...objectListeners.values()]) {
        if (row.workspace === undefined || workspaces.has(row.workspace)) row.dirty = true;
      }
      wake();
    },
    listenerCount: () => listeners.size + objectListeners.size,
  };
}
