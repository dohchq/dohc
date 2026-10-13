import { useEffect, useMemo, useReducer } from "react";
import { GoToIndex, type GoToSources, type QuickOpenContext } from "../workbench/quick-open-rank";

// Unmounted until the palette PR. Source owners supply committed snapshots
// and retain their workspace/request guards. Each task yields before continuing.
export function useGoToIndex(workspaceId: string, sources: GoToSources, context: QuickOpenContext, listingCommitted = true): GoToIndex {
  const index = useMemo(() => new GoToIndex(workspaceId), [workspaceId]);
  const [, repaint] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    if (!listingCommitted) return;
    const run = index.update(sources, context);
    let current = true;
    let task: ReturnType<typeof setTimeout>;
    const prepare = () => {
      if (!current) return;
      if (run.step()) repaint();
      else task = setTimeout(prepare, 0);
    };
    repaint();
    task = setTimeout(prepare, 0);
    return () => {
      current = false;
      clearTimeout(task);
      run.cancel();
    };
  }, [index, listingCommitted, sources.listing, sources.collections, sources.apps, sources.versions, sources.groups, context.pinned, context.recent]);
  return index;
}
