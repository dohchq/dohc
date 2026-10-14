import { useEffect, useMemo, useReducer } from "react";
import { GoToIndex, type GoToSources, type QuickOpenContext } from "../workbench/quick-open-rank";

/**
 * Unmounted scaffold for consuming committed snapshots without starting reads.
 * Before the palette PR mounts this hook, replace synchronous preparation with
 * background slices of 4 ms or less, outside animation frame callbacks.
 * Source owners retain their response guards. The index compares policy and
 * mount contents, so fresh listing metadata does not reapply every file verdict.
 */
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
