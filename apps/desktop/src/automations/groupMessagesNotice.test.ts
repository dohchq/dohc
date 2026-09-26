import { describe, expect, it } from "vitest";
import { NOTICE_POSTED_ID_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import { groupMessagesNotice } from "./groupMessagesNotice";

describe("groupMessagesNotice", () => {
  const at = Date.UTC(2026, 8, 26, 9, 30);

  it("posts one notice per workspace, reason, and day, and says what to do", () => {
    const ahead = groupMessagesNotice({ workspaceId: "ws-trip", reason: "ahead", atMs: at });
    expect(ahead).toEqual({
      workspaceId: "ws-trip",
      noticeId: "group-messages-skipped:ws-trip:ahead:2026-09-26",
      kind: "automation-failed",
      title: "Group messages started no automations",
      body: "Some Group messages are dated more than an hour later than this computer's clock. Check that this computer's date and time are right.",
      target: {},
    });
    expect(groupMessagesNotice({ workspaceId: "ws-trip", reason: "ahead", atMs: at + 60_000 }).noticeId)
      .toBe(ahead.noticeId);
    expect(groupMessagesNotice({ workspaceId: "ws-trip", reason: "ahead", atMs: at + 86_400_000 }).noticeId)
      .toBe("group-messages-skipped:ws-trip:ahead:2026-09-27");
    const late = groupMessagesNotice({ workspaceId: "ws-trip", reason: "late", atMs: at });
    expect(late.noticeId).toBe("group-messages-skipped:ws-trip:late:2026-09-26");
    expect(late.body).toBe(
      "Some Group messages reached this computer too late to start automations. To run an automation for one, post the message again.",
    );
  });

  it("keeps a long workspace id within the notice id's bound", () => {
    const notice = groupMessagesNotice({ workspaceId: "w".repeat(256), reason: "late", atMs: at });
    expect([...notice.noticeId].length).toBeLessThanOrEqual(NOTICE_POSTED_ID_MAX_CHARS);
    expect(notice.noticeId).toMatch(/^group-messages-skipped:[0-9a-f]{32}:late:2026-09-26$/u);
  });
});
