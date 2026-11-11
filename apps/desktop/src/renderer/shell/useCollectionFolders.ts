import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { AddressedDatasetDescription as DatasetDescription, DatasetListElsewhere } from "@dohc/cli/dataset";
import { collectionsElsewhereWords, collectionsRefusalError, type CollectionsElsewhere, type CollectionsRefusalRead } from "../../ipc/errorWords";

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
  // Folders whose dataset.json names no Collection on this computer, which Home shows.
  const [unclaimedDatasetFolders, setUnclaimedDatasetFolders] = useState<ReadonlySet<string>>(EMPTY_COLLECTION_FOLDERS);
  const collectionsRequest = useRef(0);
  // `elsewhere`: another computer keeps the workspace's Collections, and the
  // list holds the ones on this computer's server. It says where the others
  // are, or, when the server didn't answer, where all of them are.
  // `unknown`: the list was cleared for another read, such as the archived
  // list, and no read has landed since. It is being read, or that read failed.
  const [dataState, setDataState] = useState<{ workspaceId: string; datasets: DatasetDescription[]; nextCursor: string | null; elsewhere: CollectionsElsewhere | null; unknown?: "reading" | "failed" } | null>(null);
  const datasets = !shareViewEnded && dataState?.workspaceId === workspaceId ? dataState.datasets : EMPTY_DATASETS;
  const nextDataset = !shareViewEnded && dataState?.workspaceId === workspaceId ? dataState.nextCursor : null;
  const collectionsElsewhere = !shareViewEnded && dataState?.workspaceId === workspaceId ? dataState.elsewhere : null;
  // The list has loaded at least once. Showing the archived list again keeps it loaded.
  const collectionsListed = !shareViewEnded && dataState?.workspaceId === workspaceId;
  const collectionsUnknown = collectionsListed ? dataState?.unknown : undefined;
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
    setDataState({ workspaceId, datasets: [], nextCursor: null, elsewhere: null, unknown: "reading" });
    setArchiveView({ workspaceId, enabled });
  }, [workspaceId]);
  const refreshDatasets = useCallback(async () => {
    const request = ++datasetRequest.current;
    // A list that isn't known shows Try again when its read fails, and holds
    // its place again while Try again reads it.
    setDataState(current => current?.workspaceId === workspaceId && current.unknown === "failed" ? { ...current, unknown: "reading" } : current);
    const failed = (error: unknown): never => {
      if (request === datasetRequest.current) {
        setDataState(current => current?.workspaceId === workspaceId && current.unknown ? { ...current, unknown: "failed" } : current);
      }
      throw error;
    };
    const result = await bridge().dataset({ workspaceId, action: "list", limit: 50, ...(includeArchived ? { includeArchived: true } : {}) }).catch(failed);
    const latest = request === datasetRequest.current;
    if (result.kind === "collections-refused") {
      const { refusal } = result;
      if (refusal.kind !== "server-unavailable") {
        if (latest) {
          setDataState({ workspaceId, datasets: [], nextCursor: null, elsewhere: null });
          setRefusalState({ workspaceId, refusal });
        }
        return;
      }
      // The server didn't answer: the list keeps what it last showed, or
      // says where the Collections are, and the failure is reported.
      if (latest) {
        setDataState(current => current?.workspaceId === workspaceId && current.elsewhere !== null ? current
          : { workspaceId, datasets: [], nextCursor: null, elsewhere: { computer: refusal.computer, others: false, words: refusal.words } });
        setRefusalState(null);
      }
      throw new Error(refusal.failure);
    }
    if (!latest) return;
    if (result.kind !== "list") return failed(Error("dohc could not read the Collections list."));
    setDataState({ workspaceId, datasets: result.datasets, nextCursor: result.nextCursor, elsewhere: elsewhereOf(result.elsewhere, result.datasets) });
    setRefusalState(null);
  }, [workspaceId, includeArchived]);
  const loadMoreDatasets = useCallback(async () => {
    if (!nextDataset) return;
    const request = ++datasetRequest.current;
    const result = await bridge().dataset({ workspaceId, action: "list", limit: 50, after: nextDataset, ...(includeArchived ? { includeArchived: true } : {}) });
    // A later page that this computer can't list is reported, not shown in place.
    if (result.kind === "collections-refused") throw collectionsRefusalError(result.refusal);
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
      setUnclaimedDatasetFolders(result.unclaimedDatasetFolders.length ? new Set(result.unclaimedDatasetFolders) : EMPTY_COLLECTION_FOLDERS);
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

  return { collectionFolders, unclaimedDatasetFolders, refreshCollections, datasets, refreshDatasets, nextDataset, loadMoreDatasets, includeArchived, setIncludeArchived, collectionsRefusal, collectionsElsewhere, collectionsListed, collectionsUnknown };
}
