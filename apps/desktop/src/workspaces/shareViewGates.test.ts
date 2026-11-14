import { describe, expect, it } from "vitest";
import { shareViewIsPresent } from "./shareViewMarker";

describe("share-view gates", () => {
  it("refuses every stored marker shape a raw truthiness read let through", () => {
    for (const raw of [null, 0, "", false, Number.NaN]) {
      expect(
        shareViewIsPresent(raw),
        `!!shareView lets ${String(raw)} through every main-process gate`,
      ).toBe(true);
    }
  });

  it("still lets an ordinary workspace through", () => {
    expect(shareViewIsPresent(undefined)).toBe(false);
  });
});
