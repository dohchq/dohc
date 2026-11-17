import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_SENDER_LABEL_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
} from "@dohc/workspace-contracts/relay";
import type { DirectConversation } from "@dohc/security-contract/direct-messages";
import type { NoticeRow } from "../ipc/bridgeContract";

// A direct message that arrived and is not read yet shows in Notices. The row
// comes from the account's direct list, not from the relay's notice list, so
// reading the conversation anywhere takes it away: no read row stays behind.

export const DIRECT_NOTICE_KIND = "direct-message";

const cut = (text: string, max: number) => {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};

/** One row per conversation with an unread message from the other person: its newest one. */
export function directNoticeRows(
  viewerId: string,
  conversations: readonly DirectConversation[],
): NoticeRow[] {
  return conversations.flatMap(({ conversationId, person, last, unread }) => {
    if (unread === 0 || last.authorId === viewerId || person.blocked) return [];
    const name = cut(person.name ?? last.authorName ?? "Someone", NOTICE_SENDER_LABEL_MAX_CHARS);
    return [
      {
        store: "direct",
        noticeId: `direct:${conversationId}:${last.seq}`,
        kind: DIRECT_NOTICE_KIND,
        workspaceId: null,
        recipientShareId: null,
        senderKind: "person",
        senderLabel: name,
        title: cut(`${name} messaged you`, NOTICE_TITLE_MAX_CHARS),
        body: cut(last.body.replace(/\s+/gu, " ").trim(), NOTICE_BODY_MAX_CHARS),
        target: { thread: conversationId },
        createdAtMs: last.createdAtMs,
        readAtMs: null,
        postedHere: false,
      } satisfies NoticeRow,
    ];
  });
}

/** The conversation and seq a direct row's id names, to mark it read. */
export function directNoticeRead(noticeId: string): { conversationId: string; seq: number } | null {
  const match = /^direct:([A-Za-z0-9_-]{1,128}):(\d{1,15})$/u.exec(noticeId);
  return match ? { conversationId: match[1]!, seq: Number(match[2]) } : null;
}
