import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { PendingTreeChange } from "../workbench/file-tree-optimistic";
import {
  goneMountProjections,
  shareRefreshSummary,
  shareUnmountProjection,
} from "./shareProjection";

export function useShareMounts(
  workspaceId: string,
  workspaceShareMounts: NonNullable<WorkspaceSummary["shareMounts"]>,
  refreshWorkspaceRegistry: () => Promise<WorkspaceSummary[]>,
  onExplorerPathsChanged: (changes: PendingTreeChange[]) => void,
  refreshFiles: () => Promise<unknown>,
  reportShellError: (fallback: string, error: unknown) => void,
  showShellNotice: (message: string) => void,
) {
  // Share mounts: the registry is loaded once at boot, so the shell owns a
  // live copy of this workspace's mounts — reloaded after every mount /
  // unmount / refresh — otherwise the poll gate and unmount lookups would
  // run against a stale boot-time snapshot.
  const [shareMounts, setShareMounts] = useState(
    workspaceShareMounts,
  );
  // Bumped whenever a share pull changed files: mounted content has no host
  // history, so the open-file refresh key needs its own signal or an open
  // mounted tab keeps showing pre-pull content.
  const [mountContentEpoch, setMountContentEpoch] = useState(0);
  // Ref mirror so reloads diff against the current set without making the
  // state updater side-effectful (StrictMode replays updaters).
  const shareMountsRef = useRef(shareMounts);
  shareMountsRef.current = shareMounts;
  // Latest-wins token (cloudStatusToken/engineHistoryToken precedent): a
  // slower, earlier-started reload must never clobber a fresher one — a
  // stale registry snapshot could resurrect a just-removed mount or fire a
  // spurious delete-folder projection against a still-valid one.
  // Shares this shell removed whose FOLDER stayed on disk. Their records are
  // gone, so the next reload sees them vanish; without this it would project
  // a folder delete over files that are still there.
  const foldersLeftBehind = useRef(new Set<string>());
  const shareMountsToken = useRef(0);
  const commitShareMounts = useCallback(
    (next: NonNullable<WorkspaceSummary["shareMounts"]>) => {
      if (next === shareMountsRef.current) return;
      const gone = goneMountProjections({
        previous: shareMountsRef.current,
        next,
        foldersLeftBehind: foldersLeftBehind.current,
      });
      if (gone.length > 0) onExplorerPathsChanged(gone);
      setShareMounts(next);
    },
    [onExplorerPathsChanged],
  );
  const reloadShareMounts = useCallback(async () => {
    const token = ++shareMountsToken.current;
    try {
      const workspaces = await refreshWorkspaceRegistry();
      if (token !== shareMountsToken.current) return;
      const entry = workspaces.find(
        (candidate) => candidate.workspaceId === workspaceId,
      );
      commitShareMounts(entry?.shareMounts ?? []);
    } catch {
      // Keep the last known set; the next reload corrects it.
    }
  }, [commitShareMounts, refreshWorkspaceRegistry, workspaceId]);

  // Share mounts: pull every mount's share once (quietly — offline or
  // signed-out refreshes are no-ops main-side). `announce` adds the visible
  // summary for the explicit "Refresh Share(s)" menu action.
  const refreshShareMounts = useCallback(
    async (announce = false) => {
      let results: Array<{
        label: string;
        status: "updated" | "unchanged" | "ended" | "damaged";
        changedPaths: number;
      }>;
      try {
        results = (await bridge().refreshShareMounts({ workspaceId })).results;
      } catch (error) {
        if (announce) reportShellError("Couldn't refresh shares.", error);
        return;
      }
      const changed = results.reduce((sum, row) => sum + row.changedPaths, 0);
      if (changed > 0) {
        setMountContentEpoch((epoch) => epoch + 1);
        await refreshFiles().catch(() => undefined);
      }
      if (results.some((row) => row.status === "ended")) void reloadShareMounts();
      if (announce) showShellNotice(shareRefreshSummary(results));
    },
    [workspaceId, refreshFiles, reportShellError, showShellNotice, reloadShareMounts],
  );

  // DesktopRoot owns the live registry snapshot above this keyed shell. A
  // switch consumes that snapshot without another full-registry IPC; registry
  // change events and explicit writers refresh it at the root.
  useEffect(() => {
    commitShareMounts(workspaceShareMounts);
  }, [commitShareMounts, workspaceShareMounts]);

  const mountCount = shareMounts.length;

  const unmountShare = useCallback(
    async (path: string) => {
      const label = path.split("/")[1] ?? "";
      const mount = shareMounts.find((m) => m.label === label);
      if (!mount) return;
      let folderLeft = false;
      try {
        const result = await bridge().unmountShare({
          workspaceId,
          shareId: mount.shareId,
        });
        folderLeft = result?.folderLeft === true;
      } catch (error) {
        reportShellError("Couldn't remove the share.", error);
        return;
      }
      // Reproject tabs/pins exactly like a folder delete — but only when the
      // folder actually went. When removal could clean up the record alone,
      // the files are still on disk, and projecting a delete would throw away
      // path-keyed state (tabs, pins, drafts) for files the user still has.
      if (folderLeft) {
        // The record is gone, so the next mount reload sees this share vanish
        // and would project the delete this branch just refused. Remembered
        // until that reload consumes it.
        foldersLeftBehind.current.add(mount.shareId);
      }
      onExplorerPathsChanged(
        shareUnmountProjection({ shareId: mount.shareId, label, folderLeft }),
      );
      await refreshFiles().catch(() => undefined);
      void reloadShareMounts();
      // The record went but its folder stayed, because its label is not one
      // this app would ever address a folder through. The files are still on
      // disk, so say where they are and leave the choice to the user.
      showShellNotice(
        folderLeft
          ? `Removed ${label} from this workspace. Its folder is still in shared-with-me/ — delete it yourself if you don't want it.`
          : `Removed ${label} from this workspace.`,
      );
    },
    [
      workspaceId,
      shareMounts,
      onExplorerPathsChanged,
      refreshFiles,
      reportShellError,
      showShellNotice,
      reloadShareMounts,
    ],
  );

  const onSettingsFilesChanged = (outcome?: { folderLeftShareId?: string }) => {
    // A Settings removal that left its folder behind reports the
    // share id here, before the reload below sees the record
    // vanish — otherwise that reload projects a folder delete over
    // files that are still on disk.
    if (outcome?.folderLeftShareId) {
      foldersLeftBehind.current.add(outcome.folderLeftShareId);
    }
    void reloadShareMounts();
    void refreshFiles().catch(() => undefined);
  };

  return {
    mountCount,
    mountContentEpoch,
    reloadShareMounts,
    refreshShareMounts,
    unmountShare,
    onSettingsFilesChanged,
  };
}
