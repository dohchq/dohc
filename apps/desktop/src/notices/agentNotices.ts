import type { NoticeRow, WorkspaceSummary } from "../ipc/bridgeContract";
import { ACCESS_ENDED_NOTE, opensControls, sentNoticeTarget, type SentNoticeTarget } from "./noticeTarget";
import { sentNoticePlace } from "./sentNoticePlace";

// A Notices row as an agent reads it, newest first. `opens` is where the
// desktop's Open goes, found by the same resolver.
export interface AgentNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
  sender: { kind: NonNullable<NoticeRow["senderKind"]>; label: string | null } | null;
  createdAtMs: number;
  read: boolean;
  opens: SentNoticeTarget | null;
  note?: string;
}

/**
 * The rows about one workspace: its own, and those of a share it views or
 * holds in shared-with-me. A caller that reaches this workspace reads only
 * these, never a row that opens in another workspace or an unadded share.
 */
export function agentNotices(
  notices: readonly NoticeRow[],
  workspaces: readonly WorkspaceSummary[],
  workspaceId: string,
): AgentNotice[] {
  return notices
    .flatMap((notice): AgentNotice[] => {
      const place = sentNoticePlace(notice, workspaces, workspaceId);
      if (place.kind === "access-ended") {
        return notice.workspaceId === workspaceId ? [agentNotice(notice, null, ACCESS_ENDED_NOTE)] : [];
      }
      if (place.kind !== "workspace" || place.workspace.workspaceId !== workspaceId) return [];
      return [agentNotice(notice, sentNoticeTarget(notice, place, opensControls(notice)))];
    })
    .sort((left, right) => right.createdAtMs - left.createdAtMs || left.id.localeCompare(right.id));
}

function agentNotice(notice: NoticeRow, opens: SentNoticeTarget | null, note?: string): AgentNotice {
  return {
    id: notice.noticeId,
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    sender: notice.senderKind === null ? null : { kind: notice.senderKind, label: notice.senderLabel },
    createdAtMs: notice.createdAtMs,
    read: notice.readAtMs !== null,
    opens,
    ...(note === undefined ? {} : { note }),
  };
}
