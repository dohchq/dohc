import { describe, expect, it } from "vitest";
import { nextZoomLevel, resolvePersistedZoomApplication } from "./windowZoom";

describe("nextZoomLevel", () => {
  it("steps by one level, clamps at the bounds, and resets to 100%", () => {
    expect(nextZoomLevel(0, "in")).toBe(1);
    expect(nextZoomLevel(0, "out")).toBe(-1);
    expect(nextZoomLevel(5, "in")).toBe(5);
    expect(nextZoomLevel(-5, "out")).toBe(-5);
    expect(nextZoomLevel(3, "reset")).toBe(0);
  });
});

describe("resolvePersistedZoomApplication", () => {
  it("the first level of a launch applies to every window", () => {
    expect(resolvePersistedZoomApplication(2, null)).toEqual({
      applyEverywhere: 2,
    });
  });

  it("a user zoom that landed first outranks the launch read", () => {
    expect(resolvePersistedZoomApplication(2, 1)).toEqual({ applyToWindow: 1 });
  });

  it("with nothing known and nothing persisted there is nothing to apply", () => {
    expect(resolvePersistedZoomApplication(null, null)).toBeNull();
  });
});
