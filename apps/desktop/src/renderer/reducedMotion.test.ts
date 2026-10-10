// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { initReducedMotion, prefersReducedMotion } from "./reducedMotion";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.dohcDesktop;
  delete document.documentElement.dataset.systemReducedMotion;
});

function environment(matches: boolean, platform = "linux") {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const media = { matches, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  const getSystemReducedMotion = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
  vi.stubGlobal("dohcDesktop", { platform, getSystemReducedMotion });
  return { visibility, media, getSystemReducedMotion };
}

it("honors live native changes in both directions when the media query is stale", async () => {
  const { media, getSystemReducedMotion } = environment(false);
  const stop = initReducedMotion();
  await vi.advanceTimersByTimeAsync(0);
  expect(prefersReducedMotion()).toBe(false);
  getSystemReducedMotion.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(media.matches).toBe(false);
  expect(prefersReducedMotion()).toBe(true);
  expect(document.documentElement.dataset.systemReducedMotion).toBe("true");
  media.matches = true;
  getSystemReducedMotion.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(prefersReducedMotion()).toBe(false);
  expect(document.documentElement.dataset.systemReducedMotion).toBe("false");
  stop();
});

it("stops polling while hidden, refreshes on return, and releases its timer", async () => {
  const { visibility, getSystemReducedMotion } = environment(false);
  const stop = initReducedMotion();
  await vi.advanceTimersByTimeAsync(0);
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(getSystemReducedMotion).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(getSystemReducedMotion).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(getSystemReducedMotion).toHaveBeenCalledTimes(2);
});

it("does not overlap reads or apply an answer after disposal", async () => {
  const { getSystemReducedMotion } = environment(false);
  let resolve!: (value: boolean) => void;
  getSystemReducedMotion.mockImplementation(() => new Promise((answer) => { resolve = answer; }));
  const stop = initReducedMotion();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(getSystemReducedMotion).toHaveBeenCalledTimes(1);
  stop();
  resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.documentElement.dataset.systemReducedMotion).toBeUndefined();
});

it("uses the media query on other platforms and when a native read fails", async () => {
  const native = environment(true, "darwin");
  const stop = initReducedMotion();
  await vi.advanceTimersByTimeAsync(10000);
  expect(native.getSystemReducedMotion).not.toHaveBeenCalled();
  expect(prefersReducedMotion()).toBe(true);
  stop();
  const linux = environment(true);
  linux.getSystemReducedMotion.mockRejectedValue(new Error("Unavailable"));
  const stopLinux = initReducedMotion();
  await vi.advanceTimersByTimeAsync(1000);
  expect(prefersReducedMotion()).toBe(true);
  expect(document.documentElement.dataset.systemReducedMotion).toBeUndefined();
  stopLinux();
});
