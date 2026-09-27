import { useCallback, useEffect, useMemo } from "react";
import type { GetRelayReceivedShareResult, NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { opensForLiveEditing } from "../OpenSharedView";
import { useAutomationRetry } from "../collections/useAutomationRetry";
import { workspaceName } from "../Titlebar";
import { AUTOMATION_NOTICE_KINDS, type SentNotice } from "../workbench/NoticeCenter";
import { sentNoticeFolder, sentNoticePlace } from "./sentNoticePlace";
import { sentNoticeRef, type SentNotices } from "./useSentNotices";

export const ACCESS_ENDED_NOTE =
  "Your access to this ended. Ask the person who shared it to share it again.";
export const NOT_HERE_NOTE =
  "This workspace isn't on this computer. Join it from Manage workspaces, then choose Open again.";
// Open beside it is the way to try again.
export const SHARE_LOOKUP_FAILED_NOTE = "dohc could not open this share.";

// Main dismisses a failed run's notice once its run is queued again.
const nothingToReread = () => undefined;

// A share a notice named, for the Open a share surface, and the notice's
// file, to open once the share is added.
export interface NoticeShare {
  resolvedShare: { shareId: string; shareCode: string };
  liveEditing: boolean;
  path: string | null;
}

/**
 * The shell's side of Notices sent to this person: where each one opens from
 * this workspace, and the actions the notice center offers on them. Opening
 * marks a notice read, then goes to its file here, switches to the workspace
 * that holds it, or offers to add the share it came through.
 */
export function useSentNoticeProps(input: {
  sentNotices: SentNotices | undefined;
  workspaceId: string;
  workspaces: readonly WorkspaceSummary[];
  openFile: (path: string) => void;
  openAutomation: (automationId: string) => void;
  onSwitchWorkspace: (workspace: WorkspaceSummary, openPath?: string) => void;
  onOpenShare: (share: NoticeShare) => void;
  reportShellError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
}) {
  const { sentNotices, workspaceId, workspaces, openFile, openAutomation, onSwitchWorkspace, onOpenShare, reportShellError } = input;

  const describe = useCallback(
    (notice: NoticeRow): SentNotice => {
      const place = sentNoticePlace(notice, workspaces, workspaceId);
      // A share in this workspace's shared-with-me still comes from
      // someone else's workspace, so it names its folder.
      const here = place.kind === "workspace" &&
        place.workspace.workspaceId === workspaceId &&
        place.mount === null;
      return {
        notice,
        folder: here
          ? null
          : sentNoticeFolder(notice) ??
            (place.kind === "workspace" ? place.mount ?? workspaceName(place.workspace) : null),
        openable: place.kind !== "none",
      };
    },
    [workspaceId, workspaces],
  );
  const rows = useMemo(
    () => (sentNotices?.notices ?? []).filter(notice => notice.kind !== "sync-refusal" || notice.workspaceId !== workspaceId).map(describe),
    [describe, sentNotices?.notices, workspaceId],
  );
  const toast = useMemo(
    () => (sentNotices?.toast && (sentNotices.toast.kind !== "sync-refusal" || sentNotices.toast.workspaceId !== workspaceId) ? describe(sentNotices.toast) : null),
    [describe, sentNotices?.toast, workspaceId],
  );

  // A list main could not read is a failure with a way to ask again.
  const listFailure = sentNotices?.listFailure ?? null;
  const relist = sentNotices?.relist;
  useEffect(() => {
    if (!listFailure || !relist) return;
    reportShellError("dohc could not read notices sent to you.", listFailure.error, relist);
  }, [listFailure, relist, reportShellError]);

  const account = sentNotices?.account ?? null;
  const runNow = useCallback(
    async (notice: NoticeRow): Promise<string | null> =>
      (await bridge().runSkippedScheduleNow({ account, notice: sentNoticeRef(notice) })).note,
    [account],
  );
  const requestRetry = useCallback(
    (notice: NoticeRow, startOver: boolean) =>
      bridge().retryAutomationNotice({ account, notice: sentNoticeRef(notice), startOver }),
    [account],
  );
  const noticeRetry = useAutomationRetry({
    workspaceId,
    request: requestRetry,
    onError: reportShellError,
    onQueued: nothingToReread,
  });

  const read = useCallback(
    (notices: readonly NoticeRow[]) => {
      if (!sentNotices || notices.length === 0) return;
      const refs = notices.map(sentNoticeRef);
      const attempt = () => {
        sentNotices.read(refs).catch((error: unknown) => {
          reportShellError("dohc could not mark notices read.", error, attempt);
        });
      };
      attempt();
    },
    [reportShellError, sentNotices],
  );

  // Resolves to null once the notice opened, or to a sentence for its row.
  // Nothing opens once `signal` aborts: the panel closed, the notice was
  // dismissed, or another Open started.
  const onOpenSentNotice = useCallback(
    async (notice: NoticeRow, signal: AbortSignal): Promise<string | null> => {
      if (notice.readAtMs === null) read([notice]);
      const place = sentNoticePlace(notice, workspaces, workspaceId);
      switch (place.kind) {
        case "none":
          return null;
        case "access-ended":
          return ACCESS_ENDED_NOTE;
        case "not-here":
          return NOT_HERE_NOTE;
        case "workspace":
          if (place.workspace.workspaceId !== workspaceId) {
            onSwitchWorkspace(place.workspace, place.path ?? undefined);
          } else if (place.mount === null && notice.target?.automation && AUTOMATION_NOTICE_KINDS.has(notice.kind)) {
            openAutomation(notice.target.automation);
          } else if (place.path !== null) {
            openFile(place.path);
          }
          return null;
        case "share": {
          let found: GetRelayReceivedShareResult;
          try {
            found = await bridge().getRelayReceivedShare({ shareId: place.shareId });
          } catch {
            return SHARE_LOOKUP_FAILED_NOTE;
          }
          if (signal.aborted) return null;
          if (!found.found) return ACCESS_ENDED_NOTE;
          onOpenShare({
            resolvedShare: { shareId: found.share.shareId, shareCode: found.share.shareCode },
            liveEditing: opensForLiveEditing(found.share),
            path: place.path,
          });
          return null;
        }
      }
    },
    [onOpenShare, onSwitchWorkspace, openAutomation, openFile, read, workspaceId, workspaces],
  );

  const onDismissSentNotice = useCallback(
    (notice: NoticeRow) => {
      if (!sentNotices) return;
      const attempt = () => {
        sentNotices.dismiss(sentNoticeRef(notice)).catch((error: unknown) => {
          reportShellError("dohc could not dismiss this notice.", error, attempt);
        });
      };
      attempt();
    },
    [reportShellError, sentNotices],
  );

  const onReadAllSentNotices = useCallback(
    () => read((sentNotices?.notices ?? []).filter((notice) => notice.readAtMs === null)),
    [read, sentNotices?.notices],
  );

  return {
    sentNoticesAccount: sentNotices?.account ?? null,
    sentNotices: rows,
    sentNoticesLoading: sentNotices ? !sentNotices.settled : false,
    sentNoticeToast: toast,
    onHideSentNoticeToast: sentNotices?.hideToast,
    onOpenSentNotice,
    onDismissSentNotice,
    onReadAllSentNotices,
    onRunSentNoticeNow: runNow,
    onRetrySentNotice: noticeRetry.retry,
    // The confirmation Try again asks for before a run starts over.
    retryDialog: noticeRetry.dialog,
  };
}
