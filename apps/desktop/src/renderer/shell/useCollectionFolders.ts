import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { DatasetDescription } from "@dohc/security-contract/dataset";

// Stable empty set: the Explorer is memoized, so the "no collections"
// default must not be a fresh identity per render.
const EMPTY_COLLECTION_FOLDERS: ReadonlySet<string> = new Set();
const EMPTY_DATASETS: DatasetDescription[] = [];

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
  const [dataState, setDataState] = useState<{ workspaceId: string; datasets: DatasetDescription[]; nextCursor: string | null } | null>(null);
  const datasets = dataState?.workspaceId === workspaceId ? dataState.datasets : EMPTY_DATASETS;
  const nextDataset = dataState?.workspaceId === workspaceId ? dataState.nextCursor : null;
  const datasetRequest = useRef(0);
  const refreshDatasets = useCallback(async () => {
    const request = ++datasetRequest.current;
    const result = await bridge().dataset({ workspaceId, action: "list", limit: 50 });
    if (request !== datasetRequest.current) return;
    if (result.kind !== "list") throw Error("dohc could not read the Collections list.");
    setDataState({ workspaceId, datasets: result.datasets, nextCursor: result.nextCursor });
  }, [workspaceId]);
  const loadMoreDatasets = useCallback(async () => {
    if (!nextDataset) return;
    const request = ++datasetRequest.current;
    const result = await bridge().dataset({ workspaceId, action: "list", limit: 50, after: nextDataset });
    if (request !== datasetRequest.current) return;
    if (result.kind !== "list") throw Error("dohc could not read the Collections list.");
    setDataState(current => ({ workspaceId, datasets: [...(current?.workspaceId === workspaceId ? current.datasets : []), ...result.datasets], nextCursor: result.nextCursor }));
  }, [workspaceId, nextDataset]);
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
    return () => { collectionsRequest.current++; datasetRequest.current++; };
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

  return { collectionFolders, refreshCollections, datasets, refreshDatasets, nextDataset, loadMoreDatasets };
}
