import { SaveStateSchema } from "./saveStateSchema";
import { describe, it, expect } from "vitest";
import { SAVED_HERE, SAVING, saveProblem, saveStateEqual } from "./saveState";

describe("SaveState", () => {
  it("accepts only save facts, with reasons and existing issue identity for problems", () => {
    for (const kind of ["unknown", "saving", "saved-here", "saved-to-host", "pending-share"]) {
      expect(SaveStateSchema.parse({ kind })).toEqual({ kind });
    }
    for (const kind of ["error", "changed-on-disk", "file-locked"] as const) {
      expect(SaveStateSchema.parse(saveProblem(kind, "reason", "request-1"))).toEqual({ kind, reason: "reason", issueId: "request-1" });
      expect(SaveStateSchema.safeParse({ kind }).success).toBe(false);
    }
    for (const kind of ["not-delivered", "read-only", "deleted", "object-changed", "saved", "settling"]) {
      expect(SaveStateSchema.safeParse({ kind }).success).toBe(false);
    }
  });
  it("compares facts, including reason and issue identity", () => {
    expect(saveStateEqual(SAVED_HERE, { kind: "saved-here" })).toBe(true);
    expect(saveStateEqual(SAVED_HERE, SAVING)).toBe(false);
    expect(saveStateEqual(saveProblem("error", "reason", "one"), saveProblem("error", "reason", "one"))).toBe(true);
    expect(saveStateEqual(saveProblem("error", "reason", "one"), saveProblem("error", "reason", "two"))).toBe(false);
    expect(saveStateEqual(saveProblem("error", "one"), saveProblem("error", "two"))).toBe(false);
  });
});
