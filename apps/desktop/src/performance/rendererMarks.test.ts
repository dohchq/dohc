// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createProfileCounters, profileCounters } from "./profileCounters";
import { installRendererDiagnostics } from "./rendererMarks";

afterEach(() => {
  profileCounters.resetForTests();
  delete window.dohcDesktopMarks;
  delete window.dohcDesktopTest;
  vi.restoreAllMocks();
});

describe("renderer diagnostics admission", () => {
  it("retains no counters, clocks, or hook while awaiting main's capability", async () => {
    const pending = deferred<unknown>();
    window.dohcDesktopTest = { getDesktopMarks: vi.fn(() => pending.promise) };
    const clock = vi.spyOn(performance, "now");
    const installing = installRendererDiagnostics(window);
    profileCounters.add("sessionPublications");
    expect(profileCounters.start()).toBeNull();
    expect(profileCounters.snapshot()).toBeNull();
    expect(window.dohcDesktopMarks).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
    const mainCounters = createProfileCounters(); mainCounters.enable();
    pending.resolve({ counters: mainCounters.snapshot() });
    await installing;
    expect(profileCounters.enabled).toBe(true);
    expect(window.dohcDesktopMarks?.counters()?.sessionPublications).toBe(0);
  });

  it.each(["absent", "packaged-denial", "disabled-main", "replaced-bridge"] as const)("stays disabled after %s", async reason => {
    const mainCounters = createProfileCounters(); mainCounters.enable();
    const bridge = { getDesktopMarks: vi.fn(async () => {
      if (reason === "packaged-denial") throw new Error("No handler registered for desktop:test:get-desktop-marks");
      if (reason === "replaced-bridge") window.dohcDesktopTest = {};
      return { counters: reason === "disabled-main" ? null : mainCounters.snapshot() };
    }) };
    if (reason !== "absent") window.dohcDesktopTest = bridge;
    await installRendererDiagnostics(window);
    expect(profileCounters.enabled).toBe(false);
    expect(profileCounters.snapshot()).toBeNull();
    expect(window.dohcDesktopMarks).toBeUndefined();
    expect(bridge.getDesktopMarks).toHaveBeenCalledTimes(reason === "absent" ? 0 : 1);
  });
});
