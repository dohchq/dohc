// Where a link's handoff to Chats stands. Every input is state, and the
// outcome is worked out again whenever one changes, so nothing waits on a
// particular read.

// One list's reads that started after the reveal: `listed` once one answered,
// `failed` once one did not. A failure stands until a new reveal.
export type InvitationList = "waiting" | "listed" | "failed";

// What Chats has seen of the invitation since the reveal began.
export interface InvitationProgress {
  // A row that stands for the invitation is mounted (ShareRowMark).
  rowMounted: boolean;
  shares: InvitationList;
  dms: InvitationList;
}

export type InvitationOutcome = "shown" | "off" | "failed" | "absent" | "late" | "pending";

// How long a handoff may stay on "Opening share…". A healthy reveal answers
// within one share read and one message sync, which may queue behind a sync
// already running; each takes well under the 5 s poll period, or polls would
// pile up. Three poll periods leaves room for a slow relay, and a later
// answer still replaces `late`.
export const INVITATION_WAIT_MS = 15_000;

export function invitationOutcome(input: {
  progress: InvitationProgress | null;
  chatsOn: boolean;
  waitedTooLong: boolean;
}): InvitationOutcome {
  const { progress } = input;
  if (progress?.rowMounted) return "shown";
  if (!input.chatsOn) return "off";
  if (progress?.shares === "failed" || progress?.dms === "failed") return "failed";
  if (progress?.shares === "listed" && progress.dms === "listed") return "absent";
  return input.waitedTooLong ? "late" : "pending";
}

// What a list says once one more read that started after the reveal ends.
export function nextInvitationList(current: InvitationList, listed: boolean): InvitationList {
  if (current === "failed") return current;
  return listed ? "listed" : "failed";
}
