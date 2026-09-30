import { useCallback, useEffect, useMemo } from "react";
import { isAutomationControlsTarget, type AutomationControlsTarget } from "@dohc/workspace-contracts/relay";
import type { GetRelayReceivedShareResult, NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { opensForLiveEditing } from "../OpenSharedView";
import { useAutomationRetry } from "../collections/useAutomationRetry";
import { useRequestSequence } from "../useRequestSequence";
import { workspaceName } from "../Titlebar";
import { AUTOMATION_NOTICE_KINDS, type SentNotice } from "../workbench/NoticeCenter";
import { sentNoticeFolder, sentNoticePlace, serverRunOfNotice } from "./sentNoticePlace";
import { sentNoticeRef, type SentNotices } from "./useSentNotices";

export const ACCESS_ENDED_NOTE =
  "Your access to this ended. Ask the person who shared it to share it again.";
export const NOT_HERE_NOTE =
  "This workspace isn't on this computer. Join it from Manage workspaces, then choose Open again.";
// Open beside it is the way to try again.
export const SHARE_LOOKUP_FAILED_NOTE = "dohc could not open this share.";
export const AUTOMATION_NOT_HERE_NOTE = "dohc cannot find this automation's Collection on this computer.";
// Open beside it is the way to try again.
const AUTOMATION_LOOKUP_FAILED_NOTE = "dohc could not open this automation.";

/**
 * What a notice's Open asks the workspace it switches to to open once it is
 * ready: a file, or an automation's switch in the ⚡ panel.
 */
export type OpenOnSwitch = string | { automationControls: string };

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
  /**
   * Opens an automation's runs, at the run a notice names when this
   * computer ran it; resolves to a sentence for the row when it cannot.
   */
  openAutomation: (automationId: string, run: string | null) => Promise<string | null>;
  /** Opens an automation's row in the ⚡ panel with its switch focused, to turn it on again. */
  openAutomationControls: (automationId: string) => Promise<string | null>;
  onSwitchWorkspace: (workspace: WorkspaceSummary, open?: OpenOnSwitch) => void;
  onOpenShare: (share: NoticeShare) => void;
  reportShellError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
}) {
  const {
    sentNotices, workspaceId, workspaces, openFile, openAutomation, openAutomationControls, onSwitchWorkspace, onOpenShare, reportShellError,
  } = input;

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
        // Open takes a notice from another workspace there first.
        retryable: serverRunOfNotice(notice)?.workspaceId === workspaceId,
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
    (notice: NoticeRow, startOver: boolean) => {
      const run = serverRunOfNotice(notice);
      return run?.workspaceId === workspaceId
        ? bridge().retryCollectionAutomation({ ...run, startOver, onServer: true })
        : bridge().retryAutomationNotice({ account, notice: sentNoticeRef(notice), startOver });
    },
    [account, workspaceId],
  );

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

  // Where Open goes: the notice's file here, the workspace that holds it,
  // or the share it came through. An automation's notice here goes to the
  // ⚡ panel, on its switch with `controls`, else on its runs.
  const go = useCallback(
    async (notice: NoticeRow, signal: AbortSignal, controls: boolean): Promise<string | null> => {
      const place = sentNoticePlace(notice, workspaces, workspaceId);
      const noteOf = async (opening: Promise<string | null>): Promise<string | null> => {
        let note: string | null;
        try {
          note = await opening;
        } catch {
          note = AUTOMATION_LOOKUP_FAILED_NOTE;
        }
        return signal.aborted ? null : note;
      };
      switch (place.kind) {
        case "none":
          return null;
        case "access-ended":
          return ACCESS_ENDED_NOTE;
        case "not-here":
          return NOT_HERE_NOTE;
        case "workspace": {
          const automation = AUTOMATION_NOTICE_KINDS.has(notice.kind) ? notice.target?.automation : undefined;
          // Only the person's own workspace lists automations with their
          // switches. A share view or shared-with-me folder opens the file.
          const toSwitch = controls && automation !== undefined && place.mount === null && place.workspace.shareView === undefined
            ? automation
            : null;
          if (place.workspace.workspaceId !== workspaceId) {
            onSwitchWorkspace(place.workspace, toSwitch !== null ? { automationControls: toSwitch } : place.path ?? undefined);
          } else if (toSwitch !== null) {
            return await noteOf(openAutomationControls(toSwitch));
          } else if (automation !== undefined && place.mount === null && !controls) {
            // Only the computer that ran a run holds it.
            return await noteOf(openAutomation(automation, notice.postedHere ? notice.target?.run ?? null : null));
          } else if (place.path !== null) {
            openFile(place.path);
          }
          return null;
        }
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
    [onOpenShare, onSwitchWorkspace, openAutomation, openAutomationControls, openFile, workspaceId, workspaces],
  );

  // Resolves to null once the notice opened, or to a sentence for its row.
  // Nothing opens once `signal` aborts: the panel closed, the notice was
  // dismissed, or another Open started. A switched-off automation's notice
  // opens its switch rather than its runs.
  const onOpenSentNotice = useCallback(
    (notice: NoticeRow, signal: AbortSignal): Promise<string | null> => {
      if (notice.readAtMs === null) read([notice]);
      return go(notice, signal, notice.target !== null && isAutomationControlsTarget(notice.target));
    },
    [go, read],
  );

  // Try again on a switched-off automation queues nothing and goes where
  // its Open goes, on the switch that turns it on.
  const workspace = useRequestSequence([workspaceId]);
  const onSwitchedOff = useCallback(
    (_controls: AutomationControlsTarget, notice: NoticeRow) => {
      const epoch = workspace.current();
      void go(notice, new AbortController().signal, true).then((note) => {
        if (note !== null && workspace.isCurrent(epoch)) reportShellError(note, new Error(note));
      });
    },
    [go, reportShellError, workspace],
  );
  const noticeRetry = useAutomationRetry({
    workspaceId,
    request: requestRetry,
    onError: reportShellError,
    onQueued: nothingToReread,
    onSwitchedOff,
  });

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
