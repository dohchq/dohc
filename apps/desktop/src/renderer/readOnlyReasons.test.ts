import { describe, expect, it } from "vitest";
import { CONNECTION_LOST_REASON, NOT_SAVED_REASON, readOnlyReasons, transitionReason } from "./readOnlyReasons";

const NONE = { gone: false, accessEnded: false, shared: false, transition: undefined, notSaved: false, livePaused: undefined };
const TURN = { readOnlyWhileEditing: true, readOnlyCause: "reconnecting" } as const;

describe("readOnlyReasons", () => {
  it("says a shared document is shared to read", () => {
    expect(readOnlyReasons({ ...NONE, shared: true })).toEqual(["This page is shared with you to read."]);
  });

  it("says access ended in place of shared access", () => {
    expect(readOnlyReasons({ ...NONE, accessEnded: true, shared: true })).toEqual(["Your access to this page ended."]);
  });

  it("adds the reason a session became read-only", () => {
    expect(readOnlyReasons({ ...NONE, transition: CONNECTION_LOST_REASON })).toEqual([
      "dohc lost its connection to this page. Close every tab showing it, then reopen it to edit.",
    ]);
  });

  it("says dohc could not save once the refused edit's row is dismissed", () => {
    expect(readOnlyReasons({ ...NONE, notSaved: true })).toEqual([
      "dohc could not save this page. Close every tab showing it, then reopen it to edit.",
    ]);
  });

  it("says live editing is paused, and where to continue", () => {
    expect(readOnlyReasons({ ...NONE, livePaused: "refused" })).toEqual([
      "Live editing is paused for this page. Open Live documents to continue.",
    ]);
    expect(readOnlyReasons({ ...NONE, livePaused: "full" })).toEqual([
      "Live editing is paused until this page's waiting edits reach the server.",
    ]);
  });

  it("gives no sentence once the file is gone, whatever else applies", () => {
    expect(
      readOnlyReasons({ gone: true, accessEnded: true, shared: true, transition: CONNECTION_LOST_REASON, notSaved: true, livePaused: "refused" }),
    ).toEqual([]);
  });

  it("gives no sentence for a cause whose own notice states it", () => {
    expect(readOnlyReasons(NONE)).toEqual([]);
  });
});

describe("the next step", () => {
  it("asks the person to close every tab, since tabs share one session", () => {
    expect(CONNECTION_LOST_REASON).toBe(
      "dohc lost its connection to this page. Close every tab showing it, then reopen it to edit.",
    );
    expect(NOT_SAVED_REASON).toBe("dohc could not save this page. Close every tab showing it, then reopen it to edit.");
  });
});

describe("transitionReason", () => {
  it("says why a session became read-only", () => {
    expect(transitionReason({ ...TURN, readOnlyCause: "lineage-failure" })).toBe(
      "dohc could not finish replacing this page. Try again to finish it.",
    );
    expect(transitionReason(TURN)).toBe(CONNECTION_LOST_REASON);
    // Ended access has its own sentence.
    expect(transitionReason({ ...TURN, readOnlyCause: "access-ended" })).toBeUndefined();
    expect(transitionReason({ ...TURN, readOnlyWhileEditing: false })).toBeUndefined();
  });
});
