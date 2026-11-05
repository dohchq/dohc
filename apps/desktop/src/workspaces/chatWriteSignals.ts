const listeners = new Map<string, Set<() => void>>();

export function signalChatWrite(workspaceId: string): void {
  for (const listener of listeners.get(workspaceId) ?? []) listener();
}

export function subscribeChatWrites(workspaceId: string, listener: () => void): () => void {
  const workspaceListeners = listeners.get(workspaceId) ?? new Set<() => void>();
  listeners.set(workspaceId, workspaceListeners);
  workspaceListeners.add(listener);
  return () => {
    workspaceListeners.delete(listener);
    if (workspaceListeners.size === 0) listeners.delete(workspaceId);
  };
}
