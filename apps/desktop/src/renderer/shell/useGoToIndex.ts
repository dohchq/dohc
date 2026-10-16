import { useEffect, useMemo, useReducer } from "react";
import { GoToIndex, type GoToSources, type QuickOpenContext } from "../workbench/quick-open-rank";

export type GoToIndexView = Pick<GoToIndex, "workspaceId" | "revision" | "preparing" | "rows" | "query">;

// Unmounted until the palette PR. Source owners supply committed snapshots
// and retain their workspace/request guards. Each task yields before continuing.
export function useGoToIndex(workspaceId: string, sources: GoToSources, context: QuickOpenContext, listingCommitted = true): GoToIndexView {
  const index = useMemo(() => new GoToIndex(workspaceId), [workspaceId]);
  const [, repaint] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => () => index.cancel(), [index]);
  useEffect(() => {
    if (!listingCommitted) return;
    const run = index.update(sources, context);
    if (!run) return;
    let current = true;
    const controller = new AbortController();
    const scheduler = (globalThis as typeof globalThis & { scheduler?: {
      postTask(callback: () => void, options: { priority: "background"; signal: AbortSignal }): Promise<unknown>;
    } }).scheduler;
    const channel = scheduler ? undefined : new MessageChannel();
    const close = () => { controller.abort(); channel?.port1.close(); channel?.port2.close(); };
    const schedule = () => {
      if (scheduler) void scheduler.postTask(prepare, { priority: "background", signal: controller.signal }).catch(error => {
        if (!controller.signal.aborted) throw error;
      });
      else channel!.port2.postMessage(null);
    };
    const prepare = () => {
      if (!current) return;
      if (run.step()) { close(); repaint(); }
      else schedule();
    };
    repaint();
    if (channel) channel.port1.onmessage = prepare;
    schedule();
    return () => {
      current = false;
      close();
    };
  }, [index, listingCommitted, sources.listing, sources.collections, sources.apps, sources.versions, sources.groups, context.pinned, context.recent]);
  // This render owns the view, not the index. An abandoned render changes no state.
  // Check incoming verdicts before any query, including before the effect commits them.
  const removed = useMemo(() => index.removedKeys(sources),
    [index, index.revision, sources.collections, sources.apps, sources.versions, sources.groups]);
  const safe = () => index.canQuery(listingCommitted ? sources.listing : undefined);
  return {
    workspaceId,
    get revision() { return index.revision; },
    get preparing() { return index.preparing || !safe(); },
    get rows() { return safe() ? index.rowsWithout(removed) : []; },
    query: (query, limit) => safe() ? index.query(query, limit, removed) : [],
  };
}
