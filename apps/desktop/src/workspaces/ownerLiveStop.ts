import type { LiveObjectBinding } from "@dohc/workspace-engine-client";
import { EngineRequestError, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import { catchUpFromJournal, OwnerJournalPending, type OwnerJournalRead } from "./ownerJournal";
import { sameBinding } from "./ownerLiveReleases";
export type OwnerStopRetirementTarget = {
  objectId: string;
  currentPath: string;
  restoreFenceGeneration?: number;
};

const transitions = new Map<string, Promise<unknown>>();
/** Stop, Start and reconciliation share one document's relay transition. */
export async function withOwnerLiveStopTransition<T>(
  workspaceId: string,
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([workspaceId, path]),
    prior = transitions.get(key);
  const task = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(work);
  transitions.set(key, task);
  try {
    return await task;
  } finally {
    if (transitions.get(key) === task) transitions.delete(key);
  }
}

export type OwnerLiveStop = Awaited<ReturnType<EngineClient["ownerYDocStopRequest"]>>;
export async function reconcileOwnerLiveStops(options: {
  client: EngineClient;
  workspaceHandle: string;
  workspaceId: string;
  signal: AbortSignal;
  retire(binding: OwnerStopRetirementTarget, signal: AbortSignal): Promise<number | null>;
  /** Releases a retired Stop's queue; the engine's own release when absent. */
  release?(
    binding: NonNullable<OwnerLiveStop["binding"]>,
    acceptedCursor: number,
    signal: AbortSignal,
  ): Promise<unknown>;
  assertCurrent(): void;
  onError?(row: OwnerLiveStop, error: unknown): Promise<void> | void;
  onComplete?(row: OwnerLiveStop): void;
}) {
  const request = () => ({ id: 0, workspace: options.workspaceHandle, deadlineMs: 30_000 });
  const rows = await options.client.ownerYDocStopList(request(), options.signal);
  for (const row of rows) {
    if (!row.retirementOwed) continue;
    try {
      await withOwnerLiveStopTransition(options.workspaceId, row.document.currentPath, async () => {
        options.signal.throwIfAborted();
        options.assertCurrent();
        // Start may have cancelled this row while it waited for the document slot.
        const current = (await options.client.ownerYDocStopList(request(), options.signal)).find(
          (stop) =>
            stop.document.objectId === row.document.objectId &&
            stop.document.mainVersionId === row.document.mainVersionId,
        );
        if (!current?.retirementOwed) return;
        const stop = await options.client.ownerYDocStopRequest(
          request(),
          current.document,
          options.signal,
        );
        if (!stop.retirementOwed) return;
        const acceptedCursor = await options.retire(stop.binding ?? stop.document, options.signal);
        if (acceptedCursor === null) return;
        options.assertCurrent();
        try {
          if (stop.binding)
            await (options.release
              ? options.release(stop.binding, acceptedCursor, options.signal)
              : options.client.ownerYDocRelease(
                  request(),
                  stop.binding,
                  { acceptedCursor },
                  options.signal,
                ));
          else await options.client.ownerYDocStopRetired(request(), stop.document, options.signal);
        } catch (error) {
          // Still waiting: a held save applies, discovery installs a restore
          // successor, or the server finishes retiring the note, before the next pass retries. The Stop has not finished.
          if (
            error instanceof OwnerJournalPending ||
            (error instanceof EngineRequestError &&
              ["owner-stop-conflict", "owner-stop-restore-pending"].includes(error.message))
          )
            return;
          // A release that committed ended the Stop even when it then could not write
          // the file, as for one deleted outside dohc. One that did not stays owed.
          const owed = (await options.client.ownerYDocStopList(request(), options.signal)).some(
            (row) =>
              row.retirementOwed &&
              row.document.objectId === stop.document.objectId &&
              row.document.mainVersionId === stop.document.mainVersionId,
          );
          if (owed) throw error;
          console.error(
            "[desktop] owner live release stopped but could not write the file:",
            stop.document.objectId,
            error,
          );
        }
        options.onComplete?.(stop);
        options.assertCurrent();
      });
    } catch (error) {
      options.signal.throwIfAborted();
      options.assertCurrent();
      console.error("[desktop] owner live Stop failed:", row.document.objectId, error);
      try {
        await options.onError?.(row, error);
      } catch (noticeError) {
        console.error("[desktop] owner Stop notice failed:", noticeError);
      }
    }
  }
}

/**
 * Releases each note this computer owns that the server no longer hosts and
 * retired without a Stop, as when its last link ended. Its saves through the
 * server's last one go into the file, and nothing asks the server to Stop it.
 * The release ends the Stop with it, so sharing the note again hosts it. A
 * note that fails is tried again next pass; the rest go on.
 */
export async function releaseRetiredOwnerNotes(options: {
  client: EngineClient;
  workspaceHandle: string;
  workspaceId: string;
  signal: AbortSignal;
  /** The objects the server lists as hosted, in any state. */
  listed: ReadonlySet<string>;
  journal(
    binding: LiveObjectBinding,
    after: number,
    signal: AbortSignal,
  ): ReturnType<OwnerJournalRead>;
  /** Releases the note and ends its Stop, as `ownerYDocRelease` with `retired`. */
  release(binding: LiveObjectBinding, acceptedCursor: number, signal: AbortSignal): Promise<unknown>;
  assertCurrent(): void;
  onComplete?(row: OwnerLiveStop): void;
}) {
  const request = () => ({ id: 0, workspace: options.workspaceHandle, deadlineMs: 30_000 });
  const unlisted = [];
  let after: Parameters<EngineClient["ownerYDocListDrafts"]>[1]["after"] = null;
  do {
    const page = await options.client.ownerYDocListDrafts(
      request(),
      { after, limit: 64 },
      options.signal,
    );
    unlisted.push(...page.drafts.filter((draft) => !options.listed.has(draft.binding.objectId)));
    after = page.next;
  } while (after);
  for (const draft of unlisted) {
    const { binding } = draft;
    try {
      await releaseRetiredOwnerNote(draft);
    } catch (error) {
      options.signal.throwIfAborted();
      options.assertCurrent();
      console.error("[desktop] owner release of a retired note failed:", binding.objectId, error);
    }
  }
  function releaseRetiredOwnerNote(
    draft: Awaited<ReturnType<EngineClient["ownerYDocListDrafts"]>>["drafts"][number],
  ) {
    const { binding } = draft;
    return withOwnerLiveStopTransition(options.workspaceId, binding.currentPath, async () => {
      options.signal.throwIfAborted();
      options.assertCurrent();
      const existing = (await options.client.ownerYDocStopList(request(), options.signal)).find(
        (stop) =>
          stop.document.objectId === binding.objectId &&
          stop.document.mainVersionId === binding.mainVersionId,
      );
      // A Stop this computer asked for finishes in reconcileOwnerLiveStops; a
      // released one waits for Resume.
      if (existing && (existing.retirementOwed || existing.state !== "requested")) return;
      const last = await catchUpFromJournal({
        client: options.client,
        workspaceHandle: options.workspaceHandle,
        target: draft,
        read: (cursor, signal) => options.journal(binding, cursor, signal),
        signal: options.signal,
      });
      if (last === null) return;
      options.assertCurrent();
      const stop =
        existing ??
        (await options.client.ownerYDocStopRequest(
          request(),
          {
            mainVersionId: binding.mainVersionId,
            objectId: binding.objectId,
            currentPath: binding.currentPath,
          },
          options.signal,
          { retired: true },
        ));
      if (!stop.binding || !sameBinding(stop.binding, binding)) return;
      await options.release(stop.binding, last, options.signal);
      options.onComplete?.(stop);
    });
  }
}
