import { describe, expect, it } from "vitest";
import { isMenuCommand, MENU_COMMANDS } from "./channels";

// The preload boundary for main→renderer menu events. These cases are the
// codex-review attack set: the check must accept ONLY exact primitive members
// of the closed tuple — not String objects, toString tricks, case variants,
// or lookalikes — because this predicate is all that stands between an ipc
// event payload and renderer code.
describe("isMenuCommand (preload boundary)", () => {
  it("accepts every member of the closed tuple", () => {
    for (const command of MENU_COMMANDS) {
      expect(isMenuCommand(command)).toBe(true);
    }
  });

  it("rejects case variants and unknown ids", () => {
    expect(isMenuCommand("NEW-FILE")).toBe(false);
    expect(isMenuCommand("New-File")).toBe(false);
    expect(isMenuCommand("new-file ")).toBe(false);
    expect(isMenuCommand("delete-everything")).toBe(false);
    expect(isMenuCommand("")).toBe(false);
  });

  it("rejects non-primitive impostors (String objects, toString tricks)", () => {
    expect(isMenuCommand(new String("new-file"))).toBe(false);
    expect(isMenuCommand({ toString: () => "new-file" })).toBe(false);
    expect(
      isMenuCommand(Object.assign(Object.create(null), { valueOf: () => "new-file" })),
    ).toBe(false);
    expect(isMenuCommand(["new-file"])).toBe(false);
  });

  it("rejects non-strings outright", () => {
    expect(isMenuCommand(null)).toBe(false);
    expect(isMenuCommand(undefined)).toBe(false);
    expect(isMenuCommand(0)).toBe(false);
    expect(isMenuCommand(Symbol("new-file"))).toBe(false);
  });
});
