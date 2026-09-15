import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
export interface LiveHostChanges {
  readonly maxListeners: number;
  subscribe(changed: () => void, document?: LiveDocumentKey): () => void;
  notify(document?: LiveDocumentKey): void;
}

const observers = new WeakMap<object, Set<() => void>>();
const queued = new WeakSet<object>();
export function hasRelayWriteObservers(storage: object): boolean { return observers.has(storage); }

/** Each shared host owns one observer, released with its connection. */
export function observeRelayWrites(storage: object, changed: () => void): () => void {
  let listeners = observers.get(storage);
  if (!listeners) { listeners = new Set(); observers.set(storage, listeners); }
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0) observers.delete(storage);
  };
}

/** Notify after leaving SQLite. Ambiguous failures also require a fresh authority check. */
export function notifyRelayWrite(storage: object): void {
  if (!observers.has(storage) || queued.has(storage)) return;
  queued.add(storage);
  queueMicrotask(() => {
    queued.delete(storage);
    for (const listener of [...(observers.get(storage) ?? [])]) {
      try { listener(); } catch { /* One host cannot suppress another host's wake. */ }
    }
  });
}
