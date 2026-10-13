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
    };
  }, [index, listingCommitted, sources.listing, sources.collections, sources.apps, sources.versions, sources.groups, context.pinned, context.recent]);
  // This render owns the view, not the index. An abandoned render changes no state.
  // Check incoming verdicts before any query, including before the effect commits them.
  const safe = () => index.canQuery(listingCommitted ? sources.listing : undefined);
  return {
    workspaceId,
    get revision() { return index.revision; },
    get preparing() { return index.preparing || !safe(); },
    get rows() { return safe() ? index.rows : []; },
    query: (query, limit) => safe() ? index.query(query, limit) : [],
  };
}
