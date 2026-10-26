import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
export type OwnerStopRetirementTarget = {objectId: string; currentPath: string; restoreFenceGeneration?: number};

const transitions = new Map<string, Promise<unknown>>();
/** Stop, Start and reconciliation share one document's relay transition. */
export async function withOwnerLiveStopTransition<T>(workspaceId: string, path: string, work: () => Promise<T>): Promise<T> {
  const key=JSON.stringify([workspaceId,path]), prior=transitions.get(key);
  const task=(prior ? prior.catch(() => undefined) : Promise.resolve()).then(work);
  transitions.set(key,task);
  try {return await task;} finally {if (transitions.get(key)===task) transitions.delete(key);}
}

export type OwnerLiveStop = Awaited<ReturnType<EngineClient["ownerYDocStopRequest"]>>;
export async function reconcileOwnerLiveStops(options: {
  client: EngineClient; workspaceHandle: string; workspaceId: string; signal: AbortSignal;
  retire(binding: OwnerStopRetirementTarget, signal: AbortSignal): Promise<number | null>;
  /** Releases a retired Stop's queue; the engine's own release when absent. */
  release?(binding: NonNullable<OwnerLiveStop["binding"]>, acceptedCursor: number, signal: AbortSignal): Promise<unknown>;
  assertCurrent(): void;
  onError?(row: OwnerLiveStop, error: unknown): Promise<void> | void;
  onComplete?(row: OwnerLiveStop): void;
}) {
  const request=() => ({id:0,workspace:options.workspaceHandle,deadlineMs:30_000});
  const rows=await options.client.ownerYDocStopList(request(),options.signal);
  for (const row of rows) {
    if (!row.retirementOwed) continue;
    try {await withOwnerLiveStopTransition(options.workspaceId,row.document.currentPath,async () => {
    options.signal.throwIfAborted();options.assertCurrent();
    // Start may have cancelled this row while it waited for the document slot.
    const current=(await options.client.ownerYDocStopList(request(),options.signal)).find(stop => stop.document.objectId===row.document.objectId && stop.document.mainVersionId===row.document.mainVersionId);
    if (!current?.retirementOwed) return;
    const stop=await options.client.ownerYDocStopRequest(request(),current.document,options.signal);
    if (!stop.retirementOwed) return;
    const acceptedCursor=await options.retire(stop.binding ?? stop.document,options.signal);
    if (acceptedCursor===null) return;
    options.assertCurrent();
    try {
      if (stop.binding) await (options.release ? options.release(stop.binding,acceptedCursor,options.signal) : options.client.ownerYDocRelease(request(),stop.binding,{acceptedCursor},options.signal));
      else await options.client.ownerYDocStopRetired(request(),stop.document,options.signal);
    }
    catch (error) {
      // Let discovery install a restore successor before the next Stop attempt.
      if (!(error instanceof EngineRequestError && ["owner-stop-conflict","owner-stop-restore-pending"].includes(error.message))) throw error;
    }
    options.onComplete?.(stop);
    options.assertCurrent();
    });} catch (error) {
      options.signal.throwIfAborted();options.assertCurrent();
      console.error("[desktop] owner live Stop failed:", row.document.objectId, error);
      try {await options.onError?.(row,error);} catch (noticeError) {console.error("[desktop] owner Stop notice failed:",noticeError);}
    }
  }
}
