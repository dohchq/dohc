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

  it("applies the persisted zoom level to the window on startup", async () => {
    const setWindowZoom = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      getUserSettings: vi.fn(async () => ({
        settings: {
          ...DEFAULT_USER_SETTINGS,
          appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2 },
        },
        source: "stored" as const,
      })),
      setTitlebarTheme: vi.fn(async () => undefined),
      setWindowZoom,
    });

    const { initTheme } = await import("./theme");
    initTheme();

    await vi.waitFor(() => {
      expect(setWindowZoom).toHaveBeenCalledWith({ zoomLevel: 2 });
    });
  });
});

describe("stepZoom", () => {
  function stubBridge(zoomLevel: number) {
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel },
    };
    const setUserSettings = vi.fn(async () => undefined);
    const setWindowZoom = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      getUserSettings: vi.fn(async () => ({
        settings,
        source: "stored" as const,
      })),
      setUserSettings,
      setTitlebarTheme: vi.fn(async () => undefined),
      setWindowZoom,
    });
    return { setUserSettings, setWindowZoom };
  }

  it("zooming in applies the next level and writes it through to settings", async () => {
    const { setUserSettings, setWindowZoom } = stubBridge(0);
    const { stepZoom } = await import("./theme");
    await stepZoom("in");
    expect(setWindowZoom).toHaveBeenCalledWith({ zoomLevel: 1 });
    expect(setUserSettings).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ zoomLevel: 1 }),
      }),
    });
  });

  it("zooming out from Ctrl+- has a keyboard way back and reset returns to 100%", async () => {
    const out = stubBridge(0);
    const { stepZoom } = await import("./theme");
    await stepZoom("out");
    expect(out.setWindowZoom).toHaveBeenCalledWith({ zoomLevel: -1 });

    const reset = stubBridge(-3);
    await stepZoom("reset");
    expect(reset.setWindowZoom).toHaveBeenCalledWith({ zoomLevel: 0 });
    expect(reset.setUserSettings).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ zoomLevel: 0 }),
      }),
    });
  });

  it("stops at the zoom bounds without a save", async () => {
    const { setUserSettings, setWindowZoom } = stubBridge(5);
    const { stepZoom } = await import("./theme");
    await stepZoom("in");
    expect(setWindowZoom).not.toHaveBeenCalled();
    expect(setUserSettings).not.toHaveBeenCalled();
  });
});
