import { describe, expect, it } from "vitest";
import { readOnlyReasons } from "./readOnlyReasons";

const NONE = { accessEnded: false, shared: false, tooLarge: false };

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

  it("gives no sentence for a cause whose own notice states it", () => {
    expect(readOnlyReasons(NONE)).toEqual([]);
  });
});
