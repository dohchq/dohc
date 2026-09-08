import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";

// Stable empty set: the Explorer is memoized, so the "no collections"
// default must not be a fresh identity per render.
const EMPTY_COLLECTION_FOLDERS: ReadonlySet<string> = new Set();

export function useCollectionFolders(
  workspaceId: string,
  workspaceIsReady: boolean,
  isShareView: boolean,
) {
  // Collection folders: the engine's collections.list result,
  // cached as the set of folder paths so the Explorer can route a click on a
  // collection folder to its views. Only the latest issued request commits;
  // a failure quietly keeps the last known set — the engine
  // may simply not be running, and every activity batch retries.
  const [collectionFolders, setCollectionFolders] = useState<
    ReadonlySet<string>
  >(EMPTY_COLLECTION_FOLDERS);
  const collectionsRequest = useRef(0);
  const refreshCollections = useCallback(async () => {
    const request = ++collectionsRequest.current;
    try {
      const result = await bridge().listCollections({ workspaceId });
      if (request !== collectionsRequest.current) return;
      setCollectionFolders(
        new Set(result.collections.map((collection) => collection.path)),
      );
    } catch {
      // Collections are an engine capability; without it the explorer keeps
      // plain folder behavior. Nothing to repaint, nothing to report.
    }
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady || isShareView) return;
    // First load; afterwards the list rides the files+history activity
    // coalescer below. listCollections is one cheap index read, so no path
    // filter: a new collection appears through collection.yaml writes, a
    // rename or delete arrives as ordinary path activity, and a scope-free
    // event (no paths) must refresh too.
    void refreshCollections();
  }, [workspaceIsReady, isShareView, refreshCollections]);

  return { collectionFolders, refreshCollections };
}
