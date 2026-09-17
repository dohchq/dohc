import { useCallback, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { indexFileListing } from "../workbench/file-listing-index";
import {
  pruneMissingRestoredTabs,
  type WorkbenchState,
} from "../workbench/workbenchState";

export function useWorkspaceListing(workspaceId: string) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  // An empty workspace also lists zero files, so freshness needs its own flag.
  // A completed main-process cache hit can paint the explorer immediately,
  // but restored-tab reconciliation must wait for an independent disk walk.
  const [filesRevalidated, setFilesRevalidated] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const fileIndex = useMemo(() => indexFileListing(files), [files]);
  const { presentPaths } = fileIndex;

  // Latest-wins: fourteen call sites issue listings — mount, the watcher,
  // imports, restores, the share pull — and they can resolve out of order. An
  // older snapshot committing last would show a stale tree and make the
  // reconciliation below read a live file as deleted.
  //
  // Supersession is decided when a response commits, not when it is issued. A
  // newer request that is merely in flight has not answered anything yet, and
  // if it fails it never will: dropping this answer for it would leave the
  // explorer empty after a failed refresh, with nothing to retry it. So an
  // older answer fills an unanswered UI, and the newer one supersedes it when
  // it lands. Only an answer older than what is already displayed is dropped.
  const filesRequest = useRef(0);
  const committedFilesRequest = useRef(0);
  // How many listings are still in flight, and a bump each time that reaches
  // zero. The destructive close waits for quiet, not for a particular id: a
  // request that fails never commits, so keying off "newest issued" would
  // block the close for as long as the app ran.
  const pendingFilesRequests = useRef(0);
  // The newest request that FAILED. A failure is not an answer, so it cannot
  // refute anything — but it does mean the tree may have moved in a way no
  // surviving snapshot saw, which taints every older snapshot for the one
  // purpose that cannot be undone. See the close below.
  const failedFilesRequest = useRef(0);
  const [listingsSettled, setListingsSettled] = useState(0);
  const [fileListingCommit, setFileListingCommit] = useState<{
    request: number;
    listingSource: "cached" | "fresh";
  } | null>(null);
  const refreshFiles = useCallback(
    async (options: { allowCached?: true } = {}) => {
      const request = ++filesRequest.current;
      pendingFilesRequests.current += 1;
      try {
        const result = await bridge().listWorkspaceFiles({
          workspaceId,
          ...options,
        });
        if (request <= committedFilesRequest.current) {
          return result.cached === true;
        }
        committedFilesRequest.current = request;
        // IPC returns new arrays even when revalidation found no change.
        // Keep the indexes and explorer tree; freshness still commits below.
        setFiles((current) =>
          current.length === result.files.length &&
          current.every((file, index) => {
            const next = result.files[index];
            return file.path === next.path && file.kind === next.kind && file.icon === next.icon;
          })
            ? current
            : result.files,
        );
        const nextFolders = result.folders ?? [];
        setFolders((current) =>
          current.length === nextFolders.length &&
          current.every((folder, index) => folder === nextFolders[index])
            ? current
            : nextFolders,
        );
        setFilesRevalidated(result.cached !== true);
        setFileListingCommit({
          request,
          listingSource: result.cached === true ? "cached" : "fresh",
        });
        return result.cached === true;
      } catch (error) {
        if (request > failedFilesRequest.current) {
          failedFilesRequest.current = request;
        }
        throw error;
      } finally {
        pendingFilesRequests.current -= 1;
        if (pendingFilesRequests.current === 0) {
          setListingsSettled((settled) => settled + 1);
        }
      }
    },
    [workspaceId],
  );

  const hasCommittedListing = useCallback(
    () => committedFilesRequest.current !== 0,
    [],
  );
  const prepareRestoredTabPruning = useCallback(
    (restoredTabPaths: ReadonlySet<string>, dirtyPaths: ReadonlySet<string>) => {
      if (!filesRevalidated || restoredTabPaths.size === 0) return null;
      // Closing a tab is destructive, so it waits until no listing is in
      // flight. The watermark above deliberately lets an older success fill the
      // display — right for the explorer, wrong for closing tabs, because a
      // pull still in flight can carry back a file this older listing predates.
      // Once everything has settled, the committed response is the newest
      // SUCCESS by construction (a response only commits if it is newer than
      // what is displayed), so a failed newer request leaves the older listing
      // authoritative instead of blocking the close for the rest of the session.
      if (pendingFilesRequests.current > 0) return null;
      // A failure since the displayed listing was issued means the tree may
      // have changed in a way this snapshot never saw — refreshShareView pulls
      // a file back and the listing that would have shown it is the one that
      // failed. Closing on the older snapshot would then close a tab whose file
      // exists. Waiting costs a delay; closing costs the user their tab, so the
      // close waits for a success issued after the failure. Not a deadlock: the
      // next successful listing re-enables it.
      if (committedFilesRequest.current <= failedFilesRequest.current) return null;
      // A dirty tab is never closed. Closing it unmounts the keyed inspector
      // mid-draft, whose cleanup flushes best-effort to a path that no longer
      // exists; the write fails, the failure is swallowed, and the draft is
      // gone with no error and no way back. Waiting costs nothing: this re-runs
      // when the draft settles, and closes the tab then.
      const closable = new Set(
        [...restoredTabPaths].filter((path) => !dirtyPaths.has(path)),
      );
      const fileExists = (path: string) => presentPaths.has(path);
      return (state: WorkbenchState) =>
        pruneMissingRestoredTabs(state, closable, fileExists);
    },
    [filesRevalidated, presentPaths],
  );

  return {
    files,
    folders,
    fileIndex,
    filesRevalidated,
    listingsSettled,
    fileListingCommit,
    refreshFiles,
    hasCommittedListing,
    prepareRestoredTabPruning,
  };
}
