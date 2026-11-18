import { describe, expect, it } from "vitest";
import { invitationOutcome, nextInvitationList, type InvitationList } from "./invitationOutcome";

const LISTS: InvitationList[] = ["waiting", "listed", "failed"];
const EVERY_INPUT = LISTS.flatMap((shares) =>
  [false, true].flatMap((rowMounted) =>
    [false, true].flatMap((chatsOn) =>
      [false, true].map((waitedTooLong) => ({
        progress: { rowMounted, shares },
        chatsOn,
        waitedTooLong,
      })),
    ),
  ),
);

describe("invitationOutcome", () => {
  it.each([
    // rowMounted, shares, chatsOn, waitedTooLong → outcome
    [false, "waiting", true, false, "pending"],
    [false, "listed", true, false, "absent"],
    [false, "failed", true, false, "failed"],
    [false, "waiting", true, true, "late"],
    [false, "listed", true, true, "absent"],
    [false, "failed", true, true, "failed"],
    [false, "waiting", false, false, "off"],
    [false, "listed", false, true, "off"],
    // A notice's Open revealed another invitation, so this one's list is
    // never read again, but its row mounted.
    [true, "waiting", true, false, "shown"],
    [true, "failed", true, true, "shown"],
    [true, "listed", false, false, "shown"],
  ] as const)(
    "row %s, shares %s, chats on %s, waited too long %s: %s",
    (rowMounted, shares, chatsOn, waitedTooLong, outcome) => {
      expect(invitationOutcome({ progress: { rowMounted, shares }, chatsOn, waitedTooLong })).toBe(
        outcome,
      );
    },
  );

  it("is pending, late or off before Chats reports anything", () => {
    expect(invitationOutcome({ progress: null, chatsOn: true, waitedTooLong: false })).toBe(
      "pending",
    );
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
