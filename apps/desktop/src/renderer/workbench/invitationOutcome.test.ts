import { describe, expect, it } from "vitest";
import { invitationOutcome, nextInvitationList, type InvitationList } from "./invitationOutcome";

const LISTS: InvitationList[] = ["waiting", "listed", "failed"];
const EVERY_INPUT = LISTS.flatMap((shares) => LISTS.flatMap((dms) =>
  [false, true].flatMap((rowMounted) => [false, true].flatMap((chatsOn) => [false, true].map((waitedTooLong) =>
    ({ progress: { rowMounted, shares, dms }, chatsOn, waitedTooLong }))))));

describe("invitationOutcome", () => {
  it.each([
    // rowMounted, shares, dms, chatsOn, waitedTooLong → outcome
    [false, "waiting", "waiting", true, false, "pending"],
    [false, "listed", "waiting", true, false, "pending"],
    [false, "waiting", "listed", true, false, "pending"],
    [false, "listed", "listed", true, false, "absent"],
    [false, "failed", "waiting", true, false, "failed"],
    [false, "listed", "failed", true, false, "failed"],
    [false, "waiting", "waiting", true, true, "late"],
    [false, "listed", "waiting", true, true, "late"],
    [false, "listed", "listed", true, true, "absent"],
    [false, "failed", "listed", true, true, "failed"],
    [false, "waiting", "waiting", false, false, "off"],
    [false, "listed", "listed", false, true, "off"],
    // A notice's Open revealed another invitation, so this one's lists are
    // never read again, but its row mounted.
    [true, "waiting", "waiting", true, false, "shown"],
    [true, "failed", "failed", true, true, "shown"],
    [true, "listed", "listed", false, false, "shown"],
  ] as const)("row %s, shares %s, messages %s, chats on %s, waited too long %s: %s", (rowMounted, shares, dms, chatsOn, waitedTooLong, outcome) => {
    expect(invitationOutcome({ progress: { rowMounted, shares, dms }, chatsOn, waitedTooLong })).toBe(outcome);
  });

  it("is pending, late or off before Chats reports anything", () => {
    expect(invitationOutcome({ progress: null, chatsOn: true, waitedTooLong: false })).toBe("pending");
    expect(invitationOutcome({ progress: null, chatsOn: true, waitedTooLong: true })).toBe("late");
    expect(invitationOutcome({ progress: null, chatsOn: false, waitedTooLong: false })).toBe("off");
  });

  it("is shown whenever a row is mounted, and never pending once the wait runs out", () => {
    for (const input of EVERY_INPUT) {
      if (input.progress.rowMounted) expect(invitationOutcome(input)).toBe("shown");
      if (input.waitedTooLong) expect(invitationOutcome(input)).not.toBe("pending");
    }
  });
});

describe("nextInvitationList", () => {
  it.each([
    ["waiting", true, "listed"],
    ["waiting", false, "failed"],
    ["listed", true, "listed"],
    ["listed", false, "failed"],
    ["failed", true, "failed"],
    ["failed", false, "failed"],
  ] as const)("%s, then a read that answered %s, is %s", (current, listed, next) => {
    expect(nextInvitationList(current, listed)).toBe(next);
  });
});
