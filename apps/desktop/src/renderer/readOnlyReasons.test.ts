import { describe, expect, it } from "vitest";
import { CONNECTION_LOST_REASON, readOnlyReasons, transitionReason } from "./readOnlyReasons";

const NONE = { accessEnded: false, shared: false, tooLarge: false, transition: undefined };
const TURN = { readOnlyWhileEditing: true, readOnlyCause: "reconnecting", readOnlyDraftId: null, deletedWhileEditing: false } as const;

describe("readOnlyReasons", () => {
  it("gives each reason its own sentence, in the save chip's words", () => {
    expect(readOnlyReasons({ ...NONE, shared: true })).toEqual(["This document is shared with you to read."]);
    expect(readOnlyReasons({ ...NONE, tooLarge: true })).toEqual(["This file is too large to edit in dohc."]);
    expect(readOnlyReasons({ ...NONE, shared: true, tooLarge: true })).toEqual([
      "This document is shared with you to read.",
      "This file is too large to edit in dohc.",
    ]);
  });

  it("says access ended in place of shared access", () => {
    expect(readOnlyReasons({ ...NONE, accessEnded: true, shared: true })).toEqual(["Your access to this document ended."]);
  });

  it("adds the reason a session became read-only", () => {
    expect(readOnlyReasons({ ...NONE, transition: CONNECTION_LOST_REASON })).toEqual([
      "dohc lost its connection to this document. Close and reopen it to edit.",
    ]);
  });

  it("gives no sentence for a cause whose own notice states it", () => {
    expect(readOnlyReasons(NONE)).toEqual([]);
  });
});

describe("transitionReason", () => {
  it("says why a session became read-only with no edit set aside", () => {
    expect(transitionReason({ ...TURN, readOnlyCause: "lineage-failure" }, [])).toBe(
      "dohc could not finish replacing this document. Try again to finish it.",
    );
    expect(transitionReason(TURN, [])).toBe(CONNECTION_LOST_REASON);
    // Ended access has its own sentence.
    expect(transitionReason({ ...TURN, readOnlyCause: "access-ended" }, [])).toBeUndefined();
    expect(transitionReason({ ...TURN, readOnlyWhileEditing: false }, [])).toBeUndefined();
  });

  it("still says why when only an older session set an edit aside", () => {
    expect(transitionReason(TURN, [{ id: 1 }])).toBe(CONNECTION_LOST_REASON);
  });

  it("leaves the reason to the row for this turn's own set-aside edit", () => {
    expect(transitionReason({ ...TURN, readOnlyDraftId: 2 }, [{ id: 1 }, { id: 2 }])).toBeUndefined();
    expect(transitionReason({ ...TURN, readOnlyCause: "lineage-failure", readOnlyDraftId: 2 }, [{ id: 2 }])).toBeUndefined();
  });

  it("leaves the reason to the notice once the file is gone", () => {
    expect(transitionReason({ ...TURN, deletedWhileEditing: true }, [])).toBeUndefined();
  });
});
