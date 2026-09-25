import { describe, expect, it, vi } from "vitest";
import {
  createGuestZoomApplier,
  nextZoomLevel,
  resolvePersistedZoomApplication,
} from "./windowZoom";

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
  it("the first level of a launch applies everywhere, hosts and guests", () => {
    // A guest attached before the launch read resolved would otherwise stay
    // at 100% until the next zoom change.
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

describe("createGuestZoomApplier", () => {
  function fakeGuest() {
    const calls: number[] = [];
    let destroyed = false;
    let loadHandler: (() => void) | undefined;
    return {
      guest: {
        isDestroyed: () => destroyed,
        setZoomLevel: (level: number) => calls.push(level),
        on: (_event: "did-finish-load", handler: () => void) => {
          loadHandler = handler;
        },
      },
      calls,
      destroy: () => {
        destroyed = true;
      },
      finishLoad: () => loadHandler?.(),
    };
  }

  it("applies the current level at attach and again on every load", () => {
    let level: number | null = 2;
    const bind = createGuestZoomApplier(() => level);
    const { guest, calls, finishLoad } = fakeGuest();
    bind(guest);
    expect(calls).toEqual([2]);
    // Chromium scopes zoom per origin: the first navigation must re-apply.
    finishLoad();
    expect(calls).toEqual([2, 2]);
    // A zoom change while the guest is still loading wins at load time.
    level = 3;
    finishLoad();
    expect(calls).toEqual([2, 2, 3]);
  });

  it("a guest attached before the first level is known applies nothing yet, then takes the load-time level", () => {
    let level: number | null = null;
    const bind = createGuestZoomApplier(() => level);
    const { guest, calls, finishLoad } = fakeGuest();
    bind(guest);
    expect(calls).toEqual([]);
    level = 1;
    finishLoad();
    expect(calls).toEqual([1]);
  });

  it("never touches a destroyed guest", () => {
    const bind = createGuestZoomApplier(() => 2);
    const { guest, calls, destroy, finishLoad } = fakeGuest();
    destroy();
    bind(guest);
    finishLoad();
    expect(calls).toEqual([]);
  });
});
