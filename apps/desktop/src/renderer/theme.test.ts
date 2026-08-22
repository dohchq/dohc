// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";

function stubMatchMedia(prefersDark = false): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: prefersDark,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stubMatchMedia();
  localStorage.clear();
  document.documentElement.dataset.theme = "";
  document.documentElement.dataset.density = "";
  document.documentElement.dataset.reduceMotion = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("initTheme", () => {
  it("applies and clears legacy theme storage even when migration persistence fails", async () => {
    const setUserSettings = vi.fn(async () => {
      throw new Error("Disk full");
    });
    const setTitlebarTheme = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      setUserSettings,
      setTitlebarTheme,
    });
    localStorage.setItem("dohc-theme", "dark");

    const { initTheme } = await import("./theme");
    initTheme();

    await vi.waitFor(() => {
      expect(setUserSettings).toHaveBeenCalledOnce();
      expect(localStorage.getItem("dohc-theme")).toBeNull();
      expect(document.documentElement.dataset.theme).toBe("dark");
    });
    expect(setTitlebarTheme).toHaveBeenCalledWith({ theme: "dark" });
    expect(console.warn).toHaveBeenCalledWith(
      "Failed to migrate legacy theme setting",
      expect.any(Error),
    );
  });

});
