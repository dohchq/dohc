import { useEffect, useMemo, useReducer } from "react";
import { GoToIndex, type GoToSources, type QuickOpenContext } from "../workbench/quick-open-rank";

// Source owners supply committed snapshots and keep their own response guards.
// The first preparation runs after the Explorer's listing has painted. No reads
// start here; opening or typing in the palette never loads any source.
export function useGoToIndex(workspaceId: string, sources: GoToSources, context: QuickOpenContext, listingCommitted = true): GoToIndex {
  const index = useMemo(() => new GoToIndex(workspaceId), [workspaceId]);
  const [, repaint] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    if (!listingCommitted) return;
    let current = true;
    let firstFrame = 0;
    let paintedFrame = 0;
    const prepare = () => {
      if (!current) return;
      const previousRevision = index.revision;
      index.update(sources, context);
      if (index.revision !== previousRevision) repaint();
    };
    if (index.revision === 0) {
      firstFrame = requestAnimationFrame(() => {
        paintedFrame = requestAnimationFrame(prepare);
      });
    } else prepare();
    return () => {
      current = false;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(paintedFrame);
    };
  }, [index, listingCommitted, sources.listing, sources.collections, sources.apps, sources.versions, sources.groups, context.pinned, context.recent]);
  return index;
}
