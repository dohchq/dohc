import { createHash } from "node:crypto";
import { NOTICE_POSTED_ID_MAX_CHARS } from "@dohc/workspace-contracts/relay";

// The notice the owner gets when Group messages started no automations on
// this computer for a reason they can act on. One notice per workspace,
// reason, and day of this computer's clock, so a skip repeated all day posts
// the same notice again instead of a second one.

/** Why a Group message started nothing: dated ahead of this computer's clock, or arrived after the coverage floor passed it. */
export type GroupMessagesSkipped = "ahead" | "late";

export interface GroupMessagesNotice {
  workspaceId: string;
  noticeId: string;
  kind: "automation-failed";
  title: string;
  body: string;
  target: Record<string, never>;
}

export function groupMessagesNotice(input: {
  workspaceId: string;
  reason: GroupMessagesSkipped;
  atMs: number;
}): GroupMessagesNotice {
  const { workspaceId, reason, atMs } = input;
  const day = new Date(atMs).toISOString().slice(0, 10);
  let noticeId = `group-messages-skipped:${workspaceId}:${reason}:${day}`;
  if ([...noticeId].length > NOTICE_POSTED_ID_MAX_CHARS) {
    const workspace = createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
    noticeId = `group-messages-skipped:${workspace}:${reason}:${day}`;
  }
  return {
    workspaceId,
    noticeId,
    kind: "automation-failed",
    title: "Group messages started no automations",
    body: reason === "ahead"
      ? "Some Group messages are dated more than an hour later than this computer's clock. Check that this computer's date and time are right."
      : "Some Group messages reached this computer too late to start automations here. Their automations may have already run on another of your computers. Check before you post one again.",
    target: {},
  };
}
