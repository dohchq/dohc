import { useLayoutEffect, useMemo, useReducer } from "react";
import { GoToIndex, type GoToSources, type QuickOpenContext } from "../workbench/quick-open-rank";
/**
 * Prepare after the first paint in background slices below the 4 ms budget.
 * Queries stay withheld until all queued preparation completes.
 * Source owners retain their response guards.
 */
export function useGoToIndex(workspaceId: string, sources: GoToSources, context: QuickOpenContext, listingCommitted = true): GoToIndex {
  const index = useMemo(() => new GoToIndex(workspaceId), [workspaceId]);
  const [, repaint] = useReducer((revision: number) => revision + 1, 0);
  useLayoutEffect(() => {
    if (!listingCommitted) return;
    let current = true;
    let firstFrame = 0;
    let paintedFrame = 0;
    let timer: ReturnType<typeof setTimeout>;
    index.queuePreparation(sources, context);
    repaint();
    const prepare = () => {
      if (!current) return;
      if (index.prepareSlice()) repaint();
      else timer = setTimeout(prepare, 0);
    };
    const schedule = () => { timer = setTimeout(prepare, 0); };
    if (index.revision === 0) {
      firstFrame = requestAnimationFrame(() => {
        paintedFrame = requestAnimationFrame(schedule);
      });
    } else schedule();
    return () => {
      current = false;
      clearTimeout(timer);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(paintedFrame);
    };
  }, [index, listingCommitted, sources.listing, sources.collections, sources.apps, sources.versions, sources.groups, context.pinned, context.recent]);
  return index;
}
