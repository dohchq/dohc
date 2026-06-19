import { describe, expect, it } from "vitest";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";

describe("resolveFloatingMenuPosition", () => {
  it("places a menu below the cursor when there is room", () => {
    expect(
      resolveFloatingMenuPosition({
        cursorRect: { left: 100, top: 100, bottom: 120 },
        viewportWidth: 800,
        viewportHeight: 600,
        menuWidth: 240,
        menuMaxHeight: 180,
      }),
    ).toEqual({ x: 100, y: 126, maxHeight: 180, placement: "below" });
  });

  it("flips above and clamps the left edge inside the viewport", () => {
    expect(
      resolveFloatingMenuPosition({
        cursorRect: { left: 790, top: 500, bottom: 520 },
        viewportWidth: 800,
        viewportHeight: 600,
        menuWidth: 240,
        menuMaxHeight: 180,
      }),
    ).toEqual({ x: 548, y: 314, maxHeight: 180, placement: "above" });
  });

  it("shrinks to the larger side when neither side has full height", () => {
    expect(
      resolveFloatingMenuPosition({
        cursorRect: { left: 20, top: 180, bottom: 200 },
        viewportWidth: 360,
        viewportHeight: 320,
        menuWidth: 320,
        menuMaxHeight: 300,
      }),
    ).toEqual({ x: 20, y: 12, maxHeight: 162, placement: "above" });
  });
});
