import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { AddressedDatasetDescription as DatasetDescription, DatasetListElsewhere } from "@dohc/cli/dataset";
import { collectionsElsewhereWords, readCollectionsRefusal, readServerCollectionsUnavailable, type CollectionsElsewhere, type CollectionsRefusalRead } from "../../ipc/errorWords";

// Stable empty set: the Explorer is memoized, so the "no collections"
// default must not be a fresh identity per render.
const EMPTY_COLLECTION_FOLDERS: ReadonlySet<string> = new Set();
const EMPTY_DATASETS: DatasetDescription[] = [];

// Where the Collections this computer doesn't list are, beside the ones it lists.
const elsewhereOf = (elsewhere: DatasetListElsewhere | undefined, datasets: readonly DatasetDescription[]): CollectionsElsewhere | null =>
  elsewhere ? { computer: elsewhere.computer.label, others: datasets.length > 0, words: collectionsElsewhereWords(elsewhere.computer, datasets.length > 0) } : null;

export function useCollectionFolders(
  workspaceId: string,
  workspaceIsReady: boolean,
  isShareView: boolean,
  // Healthy received shares read Collections within their pinned grant.
  shareViewReadsCollections = false,
  shareViewEnded = false,
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
  // `elsewhere`: another computer keeps the workspace's Collections, and the
  // list holds the ones on this computer's server. It says where the others
  // are, or, when the server didn't answer, where all of them are.
  const [dataState, setDataState] = useState<{ workspaceId: string; datasets: DatasetDescription[]; nextCursor: string | null; elsewhere: CollectionsElsewhere | null } | null>(null);
  const datasets = !shareViewEnded && dataState?.workspaceId === workspaceId ? dataState.datasets : EMPTY_DATASETS;
  const nextDataset = !shareViewEnded && dataState?.workspaceId === workspaceId ? dataState.nextCursor : null;
  const collectionsElsewhere = !shareViewEnded && dataState?.workspaceId === workspaceId ? dataState.elsewhere : null;
  // The list has loaded at least once. Showing the archived list again keeps it loaded.
  const collectionsListed = !shareViewEnded && dataState?.workspaceId === workspaceId;
  // Why this computer cannot list the workspace's Collections, such as
  // another computer keeping them. The list says so in place, so a refresh
  // after each change does not report it again.
  const [refusalState, setRefusalState] = useState<{ workspaceId: string; refusal: CollectionsRefusalRead } | null>(null);
  const collectionsRefusal = refusalState?.workspaceId === workspaceId ? refusalState.refusal : null;
  const datasetRequest = useRef(0);
  const [archiveView, setArchiveView] = useState<{ workspaceId: string; enabled: boolean }>({ workspaceId, enabled: false });
  const includeArchived = !isShareView && archiveView.workspaceId === workspaceId && archiveView.enabled;
  const setIncludeArchived = useCallback((enabled: boolean) => {
    datasetRequest.current++;
    setDataState({ workspaceId, datasets: [], nextCursor: null, elsewhere: null });
    setArchiveView({ workspaceId, enabled });
  }, [workspaceId]);
  const refreshDatasets = useCallback(async () => {
    const request = ++datasetRequest.current;
    let result;
    try {
      result = await bridge().dataset({ workspaceId, action: "list", limit: 50, ...(includeArchived ? { includeArchived: true } : {}) });
    } catch (error) {
      const refusal = readCollectionsRefusal(error);
      if (refusal === null) {
        // The server didn't answer: the list keeps what it last showed, or
        // says where the Collections are, and the failure is reported.
        const unavailable = readServerCollectionsUnavailable(error);
        if (unavailable === null) throw error;
        if (request === datasetRequest.current) {
          setDataState(current => current?.workspaceId === workspaceId && current.elsewhere !== null ? current
            : { workspaceId, datasets: [], nextCursor: null, elsewhere: { computer: unavailable.computer, others: false, words: unavailable.elsewhere } });
          setRefusalState(null);
        }
        throw new Error(unavailable.failure);
      }
      if (request !== datasetRequest.current) return;
      setDataState({ workspaceId, datasets: [], nextCursor: null, elsewhere: null });
      setRefusalState({ workspaceId, refusal });
      return;
    }
    if (request !== datasetRequest.current) return;
    if (result.kind !== "list") throw Error("dohc could not read the Collections list.");
    setDataState({ workspaceId, datasets: result.datasets, nextCursor: result.nextCursor, elsewhere: elsewhereOf(result.elsewhere, result.datasets) });
    setRefusalState(null);
  }, [workspaceId, includeArchived]);
  const loadMoreDatasets = useCallback(async () => {
    if (!nextDataset) return;
    const request = ++datasetRequest.current;
    const result = await bridge().dataset({ workspaceId, action: "list", limit: 50, after: nextDataset, ...(includeArchived ? { includeArchived: true } : {}) });
    if (request !== datasetRequest.current) return;
    if (result.kind !== "list") throw Error("dohc could not read the Collections list.");
    setDataState(current => {
      const datasets = [...(current?.workspaceId === workspaceId ? current.datasets : []), ...result.datasets];
      return { workspaceId, datasets, nextCursor: result.nextCursor, elsewhere: elsewhereOf(result.elsewhere, datasets) };
    });
  }, [workspaceId, nextDataset, includeArchived]);
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
    datasetRequest.current++;
    if (shareViewEnded) setDataState(null);
  }, [shareViewEnded]);
  useEffect(() => {
    if (!workspaceIsReady || (isShareView && !shareViewReadsCollections)) return;
    // First load; afterwards the list rides the files+history activity
    // coalescer below. listCollections is one cheap index read, so no path
    // filter: a new collection appears through collection.yaml writes, a
    // rename or delete arrives as ordinary path activity, and a scope-free
    // event (no paths) must refresh too.
    void refreshCollections();
  }, [workspaceIsReady, isShareView, shareViewReadsCollections, refreshCollections]);

  return { collectionFolders, refreshCollections, datasets, refreshDatasets, nextDataset, loadMoreDatasets, includeArchived, setIncludeArchived, collectionsRefusal, collectionsElsewhere, collectionsListed };
}
