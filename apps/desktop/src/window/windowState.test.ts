import { describe, expect, it, vi } from "vitest";
import {
  createDebouncedSaver,
  parseWindowState,
  planWindowPlacement,
  serializeWindowState,
  type WindowState,
} from "./windowState";

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const SECOND = { x: 1920, y: 0, width: 1280, height: 1024 };

const saved: WindowState = {
  bounds: { x: 100, y: 80, width: 1280, height: 800 },
  isMaximized: false,
};

describe("parseWindowState", () => {
  it("round-trips through serialize", () => {
    expect(parseWindowState(serializeWindowState(saved))).toEqual(saved);
  });

  it("rejects missing, corrupt, and foreign-shaped input", () => {
    expect(parseWindowState(null)).toBeNull();
    expect(parseWindowState("")).toBeNull();
    expect(parseWindowState("not json")).toBeNull();
    expect(parseWindowState("{}")).toBeNull();
    expect(parseWindowState('{"bounds":{"x":0,"y":0}}')).toBeNull();
    expect(
      parseWindowState('{"bounds":{"x":"0","y":0,"width":1280,"height":800}}'),
    ).toBeNull();
    expect(
      parseWindowState('{"bounds":{"x":0,"y":0,"width":1e999,"height":800}}'),
    ).toBeNull();
  });

  it("rejects bounds below the window minimum", () => {
    expect(
      parseWindowState('{"bounds":{"x":0,"y":0,"width":200,"height":100}}'),
    ).toBeNull();
  });
});

describe("planWindowPlacement", () => {
  it("keeps bounds that are visible on a current display", () => {
    expect(planWindowPlacement(saved, [PRIMARY])).toEqual({
      bounds: saved.bounds,
      isMaximized: false,
    });
  });

  it("keeps bounds on a secondary display", () => {
    const onSecond = { ...saved, bounds: { ...saved.bounds, x: 2000 } };
    expect(planWindowPlacement(onSecond, [PRIMARY, SECOND]).bounds).toEqual(
      onSecond.bounds,
    );
  });

  it("keeps a window larger than the display (still grabbable)", () => {
    const huge = { ...saved, bounds: { x: 10, y: 10, width: 2400, height: 1400 } };
    expect(planWindowPlacement(huge, [PRIMARY]).bounds).toEqual(huge.bounds);
  });

  it("resets to centered default when off every display", () => {
    const offscreen = { ...saved, bounds: { ...saved.bounds, x: 4000, y: 3000 } };
    expect(planWindowPlacement(offscreen, [PRIMARY]).bounds).toBeNull();
    // The unplugged-monitor case: bounds were valid for a display that's gone.
    expect(planWindowPlacement(saved, [SECOND]).bounds).not.toEqual(saved.bounds);
  });

  it("resets when only a sliver would remain visible", () => {
    const sliver = { ...saved, bounds: { ...saved.bounds, x: 1900, y: 1070 } };
    expect(planWindowPlacement(sliver, [PRIMARY]).bounds).toBeNull();
  });

  it("preserves isMaximized even when position resets", () => {
    const offscreen: WindowState = {
      bounds: { x: 9000, y: 9000, width: 1280, height: 800 },
      isMaximized: true,
    };
    expect(planWindowPlacement(offscreen, [PRIMARY])).toEqual({
      bounds: null,
      isMaximized: true,
    });
  });

  it("centers the default window when nothing was saved", () => {
    expect(planWindowPlacement(null, [PRIMARY])).toEqual({
      bounds: null,
      isMaximized: false,
    });
  });
});

describe("createDebouncedSaver", () => {
  it("coalesces a burst into one trailing save and flushes on demand", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = createDebouncedSaver(save, 400);
    saver.schedule();
    saver.schedule();
    saver.schedule();
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(save).toHaveBeenCalledTimes(1);

    saver.schedule();
    saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
    // flush with nothing pending is a no-op
    saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
