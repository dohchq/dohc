import { describe, expect, it } from "vitest";
import { CONNECTION_LOST_REASON, readOnlyReasons, REPLACEMENT_FAILED_REASON, transitionReason } from "./readOnlyReasons";

const NONE = { accessEnded: false, shared: false, tooLarge: false, transition: null };

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

  it("says why a session became read-only with no edit set aside", () => {
    expect(readOnlyReasons({ ...NONE, transition: "lineage-failure" })).toEqual([
      "dohc could not finish replacing this document. Try again to finish it.",
    ]);
    expect(readOnlyReasons({ ...NONE, transition: "reconnecting" })).toEqual([
      "dohc lost its connection to this document. Close and reopen it to edit.",
    ]);
    expect(transitionReason("lineage-failure")).toBe(REPLACEMENT_FAILED_REASON);
    expect(transitionReason("reconnecting")).toBe(CONNECTION_LOST_REASON);
    // Ended access has its own sentence.
    expect(transitionReason("access-ended")).toBeUndefined();
  });

  it("gives no sentence for a cause whose own notice states it", () => {
    expect(readOnlyReasons(NONE)).toEqual([]);
  });
});
