import { describe, expect, it } from "vitest";
import { CONNECTION_LOST_REASON, readOnlyReasons, transitionReason } from "./readOnlyReasons";

const NONE = { gone: false, accessEnded: false, shared: false, transition: undefined, notSaved: false };
const TURN = { readOnlyWhileEditing: true, readOnlyCause: "reconnecting" } as const;

describe("readOnlyReasons", () => {
  it("says a shared document is shared to read", () => {
    expect(readOnlyReasons({ ...NONE, shared: true })).toEqual(["This document is shared with you to read."]);
  });

  it("says access ended in place of shared access", () => {
    expect(readOnlyReasons({ ...NONE, accessEnded: true, shared: true })).toEqual(["Your access to this document ended."]);
  });

  it("adds the reason a session became read-only", () => {
    expect(readOnlyReasons({ ...NONE, transition: CONNECTION_LOST_REASON })).toEqual([
      "dohc lost its connection to this document. Close and reopen it to edit.",
    ]);
  });

  it("says dohc could not save once the refused edit's row is dismissed", () => {
    expect(readOnlyReasons({ ...NONE, notSaved: true })).toEqual([
      "dohc could not save this document. Close and reopen it to edit.",
    ]);
  });

  it("gives no sentence once the file is gone, whatever else applies", () => {
    expect(
      readOnlyReasons({ gone: true, accessEnded: true, shared: true, transition: CONNECTION_LOST_REASON, notSaved: true }),
    ).toEqual([]);
  });

  it("gives no sentence for a cause whose own notice states it", () => {
    expect(readOnlyReasons(NONE)).toEqual([]);
  });
});

describe("transitionReason", () => {
  it("says why a session became read-only", () => {
    expect(transitionReason({ ...TURN, readOnlyCause: "lineage-failure" })).toBe(
      "dohc could not finish replacing this document. Try again to finish it.",
    );
    expect(transitionReason(TURN)).toBe(CONNECTION_LOST_REASON);
    // Ended access has its own sentence.
    expect(transitionReason({ ...TURN, readOnlyCause: "access-ended" })).toBeUndefined();
    expect(transitionReason({ ...TURN, readOnlyWhileEditing: false })).toBeUndefined();
  });
});
