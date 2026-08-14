import { describe, expect, it } from "vitest";
import { shareViewIsPresent } from "./shareViewMarker";

// main routes every "is this a share view?" gate through this predicate: the
// MCP profile, the capture recorder, the native menu reduction, re-sharing,
// channel joins, and chat. Each one used `!!entry.shareView`, and each one
// therefore fell open on a marker that had lost its value.
//
// The gates themselves live in main.ts, which is not unit-testable; this pins
// the predicate they all now share, and the projection suite pins the
// presentation half.
describe("share-view gates", () => {
  it("refuses every stored marker shape a raw truthiness read let through", () => {
    // `!!x` says false for all of these. Each one is a share view.
    for (const raw of [null, 0, "", false, Number.NaN]) {
      expect(
        shareViewIsPresent(raw),
        `MUTATION: !!shareView lets ${String(raw)} through every main-process gate`,
      ).toBe(true);
    }
  });

  it("still lets an ordinary workspace through", () => {
    expect(shareViewIsPresent(undefined)).toBe(false);
  });
});
