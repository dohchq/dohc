import { beginCollectionWriteOperation, collectionWriteFailures } from "./recordFieldWrites";

// A stuck queue must not hold a path or version operation open forever.
// Matches RecoveryCloseGuard's exit cap: main's settle retries top out well
// inside it, so a queue still silent after this is a hung engine, not a slow
// save.
export const COLLECTION_WRITE_STALL_MS = 20_000;

/**
 * The renderer-side gate every lineage operation (Explorer rename/move/
 * delete, version switch/create/merge, try-in-version, moment restore) takes
 * before changing the paths or lineage a collection write targets. It pauses
 * the workspace's cell acceptance immediately, flushes mounted drafts, and
 * drains the queued writes. It refuses the operation — pause released, error
 * thrown with the user-facing line — when a write failed or the queue
 * stalled, because a retained edit retried after the change would land on a
 * path or lineage its user never saw.
 *
 * The caller holds the returned release across its IPCs and path projection,
 * and calls it when the operation ends, on success and on failure alike.
 */
export async function beginCollectionLineageOperation(
  workspaceId: string,
  flushDrafts?: () => Promise<void>,
): Promise<() => void> {
  const operation = beginCollectionWriteOperation(workspaceId, {
    stallMs: COLLECTION_WRITE_STALL_MS,
  });
  try {
    await flushDrafts?.();
    const settled = await operation.settled;
    if (settled.stalled) {
      throw new Error(
        "dohc could not finish saving a collection change. Try again.",
      );
    }
    const failed = collectionWriteFailures().filter(
      (failure) => failure.workspaceId === workspaceId,
    ).length;
    if (failed > 0) {
      throw new Error(
        failed === 1
          ? "A collection change did not save. Retry or discard it, then try again."
          : `${failed} collection changes did not save. Retry or discard them, then try again.`,
      );
    }
  } catch (error) {
    operation.release();
    throw error;
  }
  return operation.release;
}
