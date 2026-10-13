import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";

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
  retire(binding: LiveObjectBinding, signal: AbortSignal): Promise<boolean>;
  assertCurrent(): void;
}) {
  const request=() => ({id:0,workspace:options.workspaceHandle,deadlineMs:30_000});
  const rows=await options.client.ownerYDocStopList(request(),options.signal);
  for (const row of rows) await withOwnerLiveStopTransition(options.workspaceId,row.binding.currentPath,async () => {
    options.signal.throwIfAborted();options.assertCurrent();
    // Start may have cancelled this row while it waited for the document slot.
    const current=(await options.client.ownerYDocStopList(request(),options.signal)).find(stop => stop.binding.objectId===row.binding.objectId && stop.binding.mainVersionId===row.binding.mainVersionId);
    if (!current) return;
    const stop=await options.client.ownerYDocStopRequest(request(),current.binding.currentPath,options.signal);
    if (stop.state==="released") return;
    if (!await options.retire(stop.binding,options.signal)) return;
    options.assertCurrent();
    try {await options.client.ownerYDocRelease(request(),stop.binding,options.signal);}
    catch (error) {
      // Let discovery install a restore successor before the next Stop attempt.
      if (!(error instanceof EngineRequestError && ["owner-stop-conflict","owner-stop-restore-pending"].includes(error.message))) throw error;
    }
    options.assertCurrent();
  });
}
