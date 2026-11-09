import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RefreshShareMountsResult,
  WorkspaceSummary,
} from "../../ipc/bridgeContract";
import { shareNoticePaths, shareUnjournalableNotice, shareUnjournalableTitle } from "../shareUnjournalableNotice";
import { bridge } from "../bridge";
import type { ShellErrorKind } from "./useShellError";
import type { PendingTreeChange } from "../workbench/file-tree-optimistic";
import {
  goneMountProjections,
  shareRefreshSummary,
  shareUnmountProjection,
} from "./shareProjection";

// A mount keeps its refresh records where every shared view does, in its own
// .dohc/local/share-refresh, so the person finds this one under its label.
const collisionRecordPath = (label: string) =>
  `shared-with-me/${label}/.dohc/local/share-refresh/share-collision-record.json`;
const collisionRecordRefusal = (shareId: string) =>
  `share-mount-collision-record:${shareId}`;
const keptPathsNotice = (shareId: string) =>
  `share-mount-kept-paths:${shareId}`;
const collisionRecordSetAside = (shareId: string) =>
  `share-mount-collision-record-set-aside:${shareId}`;
// A share whose refresh files its own refusal row.
const refusedOnItsRow = (row: RefreshShareMountsResult["results"][number]) =>
  row.status === "failed" && row.errorKind === "collision-record";

export function useShareMounts(
  workspaceId: string,
  workspaceShareMounts: NonNullable<WorkspaceSummary["shareMounts"]>,
  refreshWorkspaceRegistry: () => Promise<WorkspaceSummary[]>,
  onExplorerPathsChanged: (changes: PendingTreeChange[]) => void,
  refreshFiles: () => Promise<unknown>,
  reportShellError: (
    fallback: string,
    error: unknown,
    retry?: (() => void) | null,
    kind?: ShellErrorKind,
  ) => void,
  showSuccessNotice: (message: string, undo?: () => void, kind?: ShellErrorKind) => void,
  reportShellFailure: (failure: {
    title?: string;
    message: string;
    tone?: "success" | "warning";
    paths?: readonly string[];
    retry?: (() => void) | null;
    noDismiss?: boolean;
    kind?: ShellErrorKind;
    identity?: string;
    repeat?: boolean;
    quiet?: boolean;
  }) => void,
  clearIdentity: (identity: string) => void,
  clearKind: (...kinds: ShellErrorKind[]) => void,
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
  // Shares this shell removed whose FOLDER stayed on disk. Their records are
  // gone, so the next reload sees them vanish; without this it would project
  // a folder delete over files that are still there.
  const foldersLeftBehind = useRef(new Set<string>());
  // A slower reload must not restore a removed mount or project a folder
  // deletion from an outdated registry snapshot.
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
      // A removed share has no refresh left to end its refusal row.
      for (const mount of shareMountsRef.current) {
        if (!next.some((candidate) => candidate.shareId === mount.shareId)) {
          clearIdentity(collisionRecordRefusal(mount.shareId));
          clearIdentity(keptPathsNotice(mount.shareId));
        }
      }
      setShareMounts(next);
    },
    [clearIdentity, onExplorerPathsChanged],
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
  // Announced refreshes share one Notices row, so only the newest may write
  // it: an older one that finishes late must not replace a newer failure.
  const announcedRefreshToken = useRef(0);
  // Every refresh, polled or not, may file or end a share's refusal row, so
  // only the newest one to start writes it.
  const rowsRefreshToken = useRef(0);
  const refreshShareMountsRef = useRef<(announce?: boolean) => Promise<void>>(
    async () => undefined,
  );
  // A share's refusal or warning row is its toast. A refresh the person
  // starts toasts it every time; a polled refresh toasts it only when its row
  // is new. Every refresh reports its completed rebuilds, even if a later
  // refresh has already finished. Returns whether it filed a warning row.
  const reportCollisionRecords = useCallback(
    (results: RefreshShareMountsResult["results"], announce: boolean, newest: boolean) => {
      let warned = false;
      for (const row of results) {
        if (newest && refusedOnItsRow(row)) {
          // The record keeps the person's own files apart while dohc can't
          // read it, so its row has no ×.
          reportShellFailure({
            message:
              `dohc did not update ${row.label} because it could not read ${collisionRecordPath(row.label)}. ` +
              "It keeps a refresh from replacing your own files.",
            retry: () => void refreshShareMountsRef.current(true),
            noDismiss: true,
            kind: "share-collision-record",
            identity: collisionRecordRefusal(row.shareId),
            ...(announce ? {} : { repeat: true }),
          });
        } else if (newest && row.status !== "failed" && row.status !== "damaged") {
          clearIdentity(collisionRecordRefusal(row.shareId));
        }
        if (newest && (row.status === "updated" || row.status === "unchanged" || row.status === "ended")) {
          const paths = row.status === "ended" ? [] : row.unjournalablePaths ?? [];
          if (paths.length === 0) {
            clearIdentity(keptPathsNotice(row.shareId));
          } else {
            warned = true;
            reportShellFailure({
              title: shareUnjournalableTitle(paths, row.label),
              message: shareUnjournalableNotice(paths.map(entry => ({
                ...entry,
                path: `shared-with-me/${row.label}/${entry.path}`,
                ...(entry.owner === undefined ? {} : { owner: `shared-with-me/${row.label}/${entry.owner}` }),
              }))),
              identity: keptPathsNotice(row.shareId),
              tone: "warning",
              retry: () => void refreshShareMountsRef.current(true),
              paths: shareNoticePaths(paths).map(path => `shared-with-me/${row.label}/${path}`),
              noDismiss: true,
              ...(announce ? {} : { repeat: true }),
            });
          }
        }
        if (row.collisionRecordQuarantined) {
          warned = true;
          reportShellFailure({
            message:
              `dohc could not read its record of your files with the same path as a file in ${row.label}. ` +
              "dohc keeps these files apart.",
            identity: collisionRecordSetAside(row.shareId),
            tone: "warning",
          });
        }
      }
      return warned;
    },
    [clearIdentity, reportShellFailure],
  );
  const refreshShareMounts = useCallback(
    async (announce = false) => {
      const token = announce ? ++announcedRefreshToken.current : null;
      const newest = () => token !== null && token === announcedRefreshToken.current;
      const rowsToken = ++rowsRefreshToken.current;
      let results: RefreshShareMountsResult["results"];
      let abortMessage: RefreshShareMountsResult["abortMessage"];
      try {
        ({ results, abortMessage } = await bridge().refreshShareMounts({ workspaceId }));
      } catch (error) {
        if (newest()) reportShellError("Couldn't refresh shares.", error, null, "share-refresh");
        return;
      }
      const wroteRows = rowsToken === rowsRefreshToken.current;
      const warned = reportCollisionRecords(results, announce, wroteRows);
      const changed = results.reduce((sum, row) => sum + row.changedPaths, 0);
      if (changed > 0) {
        setMountContentEpoch((epoch) => epoch + 1);
        await refreshFiles().catch(() => undefined);
      }
      if (results.some((row) => row.status === "ended")) void reloadShareMounts();
      if (!newest()) return;
      if (abortMessage !== undefined) {
        reportShellError("Couldn't refresh shares.", new Error(abortMessage), null, "share-refresh");
        return;
      }
      // A share dohc cannot read or did not refresh is a failure the person
      // has to see. Each refresh's summary replaces the last one's row, so a
      // clean refresh clears an earlier failure. When every share refused on
      // its own row, those rows answer, and no summary repeats them.
      if (wroteRows && results.length > 0 && results.every(refusedOnItsRow)) {
        clearKind("share-refresh");
        return;
      }
      const summary = shareRefreshSummary(results);
      if (results.some((row) => row.status === "failed")) {
        reportShellError(summary, null, () => void refreshShareMountsRef.current(true), "share-refresh");
      } else if (results.some((row) => row.status === "damaged")) {
        reportShellError(summary, null, null, "share-refresh");
      } else if (warned) {
        // A warning row is this refresh's toast, so the summary goes into
        // Notices without one. Ending the last summary first keeps its open
        // toast from coming back after the warning's.
        clearKind("share-refresh");
        reportShellFailure({ message: summary, tone: "success", kind: "share-refresh", quiet: true });
      } else {
        showSuccessNotice(summary, undefined, "share-refresh");
      }
    },
    [workspaceId, refreshFiles, reportShellError, showSuccessNotice, reportShellFailure, reloadShareMounts, reportCollisionRecords, clearKind],
  );
  refreshShareMountsRef.current = refreshShareMounts;

  // DesktopRoot owns the live registry snapshot above this keyed shell. A
  // switch consumes that snapshot without another full-registry IPC; registry
  // change events and explicit writers refresh it at the root.
  useEffect(() => {
    shareMountsToken.current += 1;
    commitShareMounts(workspaceShareMounts);
  }, [commitShareMounts, workspaceShareMounts]);

  const mountCount = shareMounts.length;

  // A failed removal's Try again runs against the mounts the shell holds at
  // that moment, so a share removed meanwhile is not looked up stale.
  const unmountShareRef = useRef<(path: string) => Promise<void>>(async () => undefined);
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
        reportShellError("Couldn't remove the share.", error, () => void unmountShareRef.current(path));
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
      showSuccessNotice(
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
      showSuccessNotice,
      reloadShareMounts,
    ],
  );

  unmountShareRef.current = unmountShare;

  // A mount was added or its record changed outside this hook.
  const onMountsChanged = () => {
    void reloadShareMounts();
    void refreshFiles().catch(() => undefined);
  };

  return {
    shareMounts,
    mountCount,
    mountContentEpoch,
    reloadShareMounts,
    refreshShareMounts,
    unmountShare,
    onMountsChanged,
  };
}
