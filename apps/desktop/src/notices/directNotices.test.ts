import { describe, expect, it } from "vitest";
import type { DirectConversation } from "@dohc/security-contract/direct-messages";
import { NoticeRow } from "../ipc/bridgeContract";
import { directNoticeRead, directNoticeRows } from "./directNotices";
import { sentNoticePlace } from "./sentNoticePlace";

const conversation = (input: { id: string; author: string; unread: number; body?: string; blocked?: boolean; name?: string | null }): DirectConversation => ({
  conversationId: input.id,
  person: { personId: "sam", name: input.name === undefined ? "Sam Rivera" : input.name, blocked: input.blocked ?? false },
  last: { seq: 7, messageId: "m7", authorId: input.author, authorName: "Sam Rivera", body: input.body ?? "Lunch\n tomorrow?", createdAtMs: 70_000 },
  unread: input.unread,
});

describe("direct message notices", () => {
  it("raises one row for each conversation with an unread message from the other person, and clears it once read", () => {
    const rows = directNoticeRows("ana", [
      conversation({ id: "c1", author: "sam", unread: 2 }),
      // Read, written by the viewer, or from someone the viewer blocked: no row.
      conversation({ id: "c2", author: "sam", unread: 0 }),
      conversation({ id: "c3", author: "ana", unread: 0 }),
      conversation({ id: "c4", author: "sam", unread: 1, blocked: true }),
    ]);
    expect(rows).toEqual([{
      store: "direct", noticeId: "direct:c1:7", kind: "direct-message", workspaceId: null, recipientShareId: null,
      senderKind: "person", senderLabel: "Sam Rivera", title: "Sam Rivera messaged you", body: "Lunch tomorrow?",
      target: { thread: "c1" }, createdAtMs: 70_000, readAtMs: null, postedHere: false,
    }]);
    // Each row is one the notice list accepts as it crosses to a window.
    for (const row of rows) expect(NoticeRow.safeParse(row).success).toBe(true);
    // Reading names the conversation and the message.
    expect(directNoticeRead(rows[0]!.noticeId)).toEqual({ conversationId: "c1", seq: 7 });
    expect(directNoticeRead("direct:c1:")).toBeNull();
    expect(directNoticeRead("chat:c1:7")).toBeNull();
    // Once the conversation is read, the list has no row for it.
    expect(directNoticeRows("ana", [conversation({ id: "c1", author: "sam", unread: 0 })])).toEqual([]);
  });

  it("keeps a long message and name inside the notice limits", () => {
    const [row] = directNoticeRows("ana", [conversation({ id: "c1", author: "sam", unread: 1, body: "x".repeat(2_000), name: "N".repeat(80) })]);
    expect(NoticeRow.safeParse(row).success).toBe(true);
    expect([...row!.senderLabel!].length).toBe(40);
  });

  it("opens the conversation in Chats, from any workspace", () => {
    const [row] = directNoticeRows("ana", [conversation({ id: "c1", author: "sam", unread: 1 })]);
    expect(sentNoticePlace(row!, [], "workspace-a")).toEqual({ kind: "direct", conversationId: "c1" });
  });
});
