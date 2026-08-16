import { describe, expect, it } from "vitest";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { shareViewTakesLocalWrites } from "./shareWriteGate";

// The rule main's `assertWritableWorkspace` and the capture gate both ask.
// Both fail in a direction that costs something, so every input is stated.
describe("shareViewTakesLocalWrites", () => {
  it("takes writes at edit, and only at edit", () => {
    const levels: ShareAccess[] = ["view", "comment", "edit"];
    const takes = levels.filter((access) =>
      shareViewTakesLocalWrites({ access, ended: false }),
    );
    expect(takes).toEqual(["edit"]);
  });

  it("refuses a damaged grant, which names no level at all", () => {
    expect(
      shareViewTakesLocalWrites({ access: null, ended: false }),
      "MUTATION: an `!== \"view\"` test reads a damaged grant as writable",
    ).toBe(false);
  });

  it("refuses an ended share at every level", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      expect(
        shareViewTakesLocalWrites({ access, ended: true }),
        `${access}: MUTATION: an ended share takes a write nothing will ever send`,
      ).toBe(false);
    }
  });
});
