import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDesktopIconDirectory,
  resolveSystemThemeIconPath,
  systemThemeIconFileName,
} from "./systemThemeIcon";

describe("system theme app icon", () => {
  it("selects the matching light or dark asset", () => {
    expect(systemThemeIconFileName(false)).toBe("icon-light.png");
    expect(systemThemeIconFileName(true)).toBe("icon-dark.png");
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
