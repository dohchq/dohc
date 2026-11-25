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
    ).toEqual({ x: 100, y: 126, maxHeight: 180, maxWidth: 240, placement: "below" });
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
    ).toEqual({ x: 548, y: 314, maxHeight: 180, maxWidth: 240, placement: "above", bottom: 106 });
  });

  it("stays inside the given bounds, flipping above when they end below the cursor", () => {
    expect(
      resolveFloatingMenuPosition({
        cursorRect: { left: 10, top: 300, bottom: 320 },
        viewportWidth: 800,
        viewportHeight: 600,
        bounds: { top: 50, left: 100, right: 700, bottom: 400 },
        menuWidth: 240,
        menuMaxHeight: 180,
      }),
    ).toEqual({ x: 112, y: 114, maxHeight: 180, maxWidth: 240, placement: "above", bottom: 306 });
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
    ).toEqual({ x: 20, y: 12, maxHeight: 162, maxWidth: 320, placement: "above", bottom: 146 });
  });

  it("pins the above-placement bottom anchor to the cursor's top edge", () => {
    const position = resolveFloatingMenuPosition({
      cursorRect: { left: 100, top: 500, bottom: 520 },
      viewportWidth: 800,
      viewportHeight: 600,
      menuWidth: 240,
      menuMaxHeight: 180,
      gap: 6,
    });
    expect(position.placement).toBe("above");
    expect(position.bottom).toBe(600 - (500 - 6));
    expect(600 - (position.y + position.maxHeight)).toBe(position.bottom);
  });

  it("returns no bottom anchor for below placement", () => {
    const position = resolveFloatingMenuPosition({
      cursorRect: { left: 100, top: 100, bottom: 120 },
      viewportWidth: 800,
      viewportHeight: 600,
      menuWidth: 240,
      menuMaxHeight: 180,
    });
    expect(position.placement).toBe("below");
    expect(position.bottom).toBeUndefined();
  });
});

it("opens above when asked and there is room, and below when there is none", () => {
  const input = {
    viewportWidth: 1000,
    viewportHeight: 800,
    menuWidth: 200,
    menuMaxHeight: 100,
    margin: 4,
    gap: 4,
    prefer: "above" as const,
  };
  expect(
    resolveFloatingMenuPosition({ ...input, cursorRect: { left: 50, top: 400, bottom: 420 } }),
  ).toMatchObject({ placement: "above", bottom: 404 });
  expect(
    resolveFloatingMenuPosition({ ...input, cursorRect: { left: 50, top: 40, bottom: 60 } }),
  ).toMatchObject({ placement: "below", y: 64 });
});

it("narrows a menu wider than its bounds to fit inside them", () => {
  const position = resolveFloatingMenuPosition({
    cursorRect: { left: 120, top: 300, bottom: 320 },
    viewportWidth: 375,
    viewportHeight: 812,
    bounds: { top: 100, left: 16, right: 354, bottom: 700 },
    menuWidth: 360,
    margin: 12,
  });
  expect(position.x).toBe(28);
  expect(position.x + position.maxWidth).toBe(342);
});

it("keeps a menu inside its bounds when the caret has scrolled out of them", () => {
  const bounds = { top: 100, left: 0, right: 1440, bottom: 586 };
  const input = { viewportWidth: 1440, viewportHeight: 700, bounds, menuMaxHeight: 140 };
  const below = resolveFloatingMenuPosition({
    ...input,
    cursorRect: { left: 400, top: 640, bottom: 660 },
  });
  expect(below.y).toBeGreaterThanOrEqual(bounds.top);
  expect(below.y + below.maxHeight).toBeLessThanOrEqual(bounds.bottom);
  const above = resolveFloatingMenuPosition({
    ...input,
    cursorRect: { left: 400, top: 40, bottom: 60 },
  });
  expect(above.y).toBeGreaterThanOrEqual(bounds.top);
  expect(above.y + above.maxHeight).toBeLessThanOrEqual(bounds.bottom);
});

it("keeps a menu at its minimum height, inside its bounds when they hold it, on screen when not", () => {
  const input = { viewportWidth: 1440, viewportHeight: 700, menuMaxHeight: 140, menuMinHeight: 46 };
  const sliver = resolveFloatingMenuPosition({
    ...input,
    bounds: { top: 0, left: 0, right: 1440, bottom: 72 },
    cursorRect: { left: 400, top: 46, bottom: 70 },
  });
  expect(sliver.maxHeight).toBe(46);
  expect(sliver.y).toBeGreaterThanOrEqual(0);
  expect(sliver.y + sliver.maxHeight).toBeLessThanOrEqual(72);
  const strip = resolveFloatingMenuPosition({
    ...input,
    bounds: { top: 664, left: 0, right: 1440, bottom: 700 },
    cursorRect: { left: 400, top: 907, bottom: 926 },
  });
  expect(strip.y).toBeGreaterThanOrEqual(0);
  expect(strip.y + strip.maxHeight).toBeLessThanOrEqual(700);
});

it("fits a minimum-height menu into a strip of exactly its height", () => {
  const position = resolveFloatingMenuPosition({
    cursorRect: { left: 400, top: 907, bottom: 926 },
    viewportWidth: 1440,
    viewportHeight: 700,
    bounds: { top: 654, left: 0, right: 1440, bottom: 700 },
    menuMinHeight: 46,
  });
  expect(position.y).toBe(654);
  expect(position.y + position.maxHeight).toBe(700);
});

it("keeps a menu that leaves its bounds out of the part of the screen the page covers", () => {
  const screen = { top: 60, bottom: 700 };
  const position = resolveFloatingMenuPosition({
    cursorRect: { left: 400, top: 46, bottom: 70 },
    viewportWidth: 1440,
    viewportHeight: 700,
    bounds: { top: 60, left: 0, right: 1440, bottom: 72, screen },
    menuMinHeight: 80,
  });
  expect(position.y).toBeGreaterThanOrEqual(screen.top);
  expect(position.y + position.maxHeight).toBeLessThanOrEqual(screen.bottom);
  expect(position.placement).toBe("below");
  expect(position.bottom).toBeUndefined();
});
