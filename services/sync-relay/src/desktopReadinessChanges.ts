type Scope = { shareId: string } | { workspaceId: string; path: string };
const observers = new WeakMap<object, Map<string, Set<() => void>>>();
const queued = new WeakMap<object, Set<string>>();
const shareKey = (shareId: string) => JSON.stringify(["share", shareId]);
const pathKey = (workspaceId: string, path: string) => JSON.stringify(["path", workspaceId, path]);

/** Readiness does not subscribe to the relay-wide write signal. */
export function observeDesktopReadiness(storage: object, scope: { shareId: string; workspaceId: string; path: string }, changed: () => void): () => void {
  let groups = observers.get(storage);
  if (!groups) { groups = new Map(); observers.set(storage, groups); }
  const keys = [shareKey(scope.shareId), pathKey(scope.workspaceId, scope.path)];
  for (const key of keys) {
    let listeners = groups.get(key);
    if (!listeners) { listeners = new Set(); groups.set(key, listeners); }
    listeners.add(changed);
  }
  return () => {
    for (const key of keys) {
      const listeners = groups.get(key);
      listeners?.delete(changed);
      if (listeners?.size === 0) groups.delete(key);
    }
    if (groups.size === 0) observers.delete(storage);
  };
}

export function notifyDesktopReadiness(storage: object, scope: Scope): void {
  const key = "shareId" in scope ? shareKey(scope.shareId) : pathKey(scope.workspaceId, scope.path);
  if (!observers.get(storage)?.has(key)) return;
  let pending = queued.get(storage);
  if (!pending) { pending = new Set(); queued.set(storage, pending); }
  if (pending.has(key)) return;
  pending.add(key);
  const pendingKeys = pending;
  // Leave SQLite before a waiter checks authority again. Removed waits stay removed.
  queueMicrotask(() => {
    pendingKeys.delete(key);
    if (pendingKeys.size === 0) queued.delete(storage);
    for (const listener of [...(observers.get(storage)?.get(key) ?? [])]) {
      try { listener(); } catch { /* Other waits still receive this change. */ }
    }
  });
}
