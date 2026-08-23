export async function coalesceDispatchScopedSync(
  syncs: Map<string, Promise<boolean>>,
  workspaceId: string,
  sync: () => Promise<boolean>,
): Promise<boolean> {
  const existing = syncs.get(workspaceId);
  if (existing) return existing;

  // Publish the promise before sync starts so a synchronous re-entry joins it.
  const pending = Promise.resolve().then(sync);
  syncs.set(workspaceId, pending);
  try {
    return await pending;
  } finally {
    if (syncs.get(workspaceId) === pending) {
      syncs.delete(workspaceId);
    }
  }
}
