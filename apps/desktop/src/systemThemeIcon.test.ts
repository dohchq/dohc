import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyDesktopIconToPlatform,
  resolveDesktopIconDirectory,
  resolveSystemThemeIconPath,
  shouldUseDarkSystemIcon,
  systemThemeIconFileName,
} from "./systemThemeIcon";

describe("system theme app icon", () => {
  it("selects the matching light or dark asset", () => {
    expect(systemThemeIconFileName(false)).toBe("icon-light.png");
    expect(systemThemeIconFileName(true)).toBe("icon-dark.png");
  });

  it("uses Electron's resolved system appearance", () => {
    expect(shouldUseDarkSystemIcon({ shouldUseDarkColors: true })).toBe(true);
    expect(shouldUseDarkSystemIcon({ shouldUseDarkColors: false })).toBe(false);
  });

  it("resolves icon assets from packages and development builds", () => {
    expect(
      resolveDesktopIconDirectory({
        isPackaged: true,
        resourcesPath: "resources",
        moduleDirectory: "dist/main",
      }),
    ).toBe("resources");
    expect(
      resolveDesktopIconDirectory({
        isPackaged: false,
        resourcesPath: "resources",
        moduleDirectory: "dist/main",
      }),
    ).toBe(join("dist/main", "../../build"));
  });

  it.each(["win32", "linux"] as const)(
    "updates every %s window icon without touching the macOS Dock",
    (platform) => {
      const firstWindow = { setIcon: vi.fn() };
      const secondWindow = { setIcon: vi.fn() };
      const setDockIcon = vi.fn();

      applyDesktopIconToPlatform({
        platform,
        iconPath: "icon-dark.png",
        windows: [firstWindow, secondWindow],
        setDockIcon,
      });

      expect(firstWindow.setIcon).toHaveBeenCalledWith("icon-dark.png");
      expect(secondWindow.setIcon).toHaveBeenCalledWith("icon-dark.png");
      expect(setDockIcon).not.toHaveBeenCalled();
    },
  );

  it("updates the macOS Dock without calling the unsupported window API", () => {
    const window = { setIcon: vi.fn() };
    const setDockIcon = vi.fn();

    applyDesktopIconToPlatform({
      platform: "darwin",
      iconPath: "icon-dark.png",
      windows: [window],
      setDockIcon,
    });

    expect(setDockIcon).toHaveBeenCalledWith("icon-dark.png");
    expect(window.setIcon).not.toHaveBeenCalled();
  });

  it("falls back to the packaging icon when themed assets are unavailable", () => {
    const directory = join("fixtures", "icons");
    const fallback = join(directory, "icon.png");
    const existing = new Set([fallback]);

    expect(
      resolveSystemThemeIconPath(directory, true, (path) =>
        existing.has(path),
      ),
    ).toBe(fallback);
  });

  it("returns null when no usable icon exists", () => {
    expect(resolveSystemThemeIconPath("icons", false, () => false)).toBe(
      null,
    );
  });
});
