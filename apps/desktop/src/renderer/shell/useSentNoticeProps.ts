import { useCallback, useMemo } from "react";
import type { NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { opensForLiveEditing } from "../ShareHandoffSurface";
import { workspaceName } from "../Titlebar";
import type { SentNotice } from "../workbench/NoticeCenter";
import { sentNoticeFolder, sentNoticePlace } from "./sentNoticePlace";
import { sentNoticeRef, type SentNotices } from "./useSentNotices";

export const ACCESS_ENDED_NOTE =
  "Your access to this ended. Ask the person who shared it to share it again.";
export const NOT_HERE_NOTE =
  "This workspace isn't on this computer. Join it from Manage workspaces, then choose Open again.";

// A share a notice named, for the Open a share surface.
export interface NoticeShare {
  resolvedShare: { shareId: string; shareCode: string };
  liveEditing: boolean;
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
  onSwitchWorkspace: (workspace: WorkspaceSummary, openPath?: string) => void;
  onOpenShare: (share: NoticeShare) => void;
  reportShellError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
}) {
  const { sentNotices, workspaceId, workspaces, openFile, onSwitchWorkspace, onOpenShare, reportShellError } = input;

  const describe = useCallback(
    (notice: NoticeRow): SentNotice => {
      const place = sentNoticePlace(notice, workspaces, workspaceId);
      const here = place.kind === "workspace" && place.workspace.workspaceId === workspaceId;
      return {
        notice,
        folder: here
          ? null
          : sentNoticeFolder(notice) ?? (place.kind === "workspace" ? workspaceName(place.workspace) : null),
        openable: place.kind !== "none",
      };
    },
    [workspaceId, workspaces],
  );
  const rows = useMemo(
    () => (sentNotices?.notices ?? []).map(describe),
    [describe, sentNotices?.notices],
  );
  const toast = useMemo(
    () => (sentNotices?.toast ? describe(sentNotices.toast) : null),
    [describe, sentNotices?.toast],
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

  const onOpenSentNotice = useCallback(
    async (notice: NoticeRow): Promise<string | null> => {
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
          } else if (place.path !== null) {
            openFile(place.path);
          }
          return null;
        case "share": {
          let found;
          try {
            found = await bridge().getRelayReceivedShare({ shareId: place.shareId });
          } catch (error) {
            reportShellError("dohc could not open this share.", error);
            return null;
          }
          if (!found.found) return ACCESS_ENDED_NOTE;
          onOpenShare({
            resolvedShare: { shareId: found.share.shareId, shareCode: found.share.shareCode },
            liveEditing: opensForLiveEditing(found.share),
          });
          return null;
        }
      }
    },
    [onOpenShare, onSwitchWorkspace, openFile, read, reportShellError, workspaceId, workspaces],
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
    sentNotices: rows,
    sentNoticeToast: toast,
    onHideSentNoticeToast: sentNotices?.hideToast,
    onOpenSentNotice,
    onDismissSentNotice,
    onReadAllSentNotices,
  };
}
