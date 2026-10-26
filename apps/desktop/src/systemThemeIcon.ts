import { existsSync } from "node:fs";
import { join } from "node:path";

type SystemThemeIcon = "light" | "dark";

/** Resolve the icon asset directory consistently in development and packages. */
export function resolveDesktopIconDirectory(options: {
  isPackaged: boolean;
  resourcesPath?: string;
  moduleDirectory: string;
}): string {
  if (options.isPackaged && options.resourcesPath) return options.resourcesPath;
  return join(options.moduleDirectory, "../../build");
}

/** Return the themed asset variant for Electron's resolved system appearance. */
export function systemThemeIcon(
  shouldUseDarkColors: boolean,
): SystemThemeIcon {
  return shouldUseDarkColors ? "dark" : "light";
}

/** Return the packaged PNG filename for the resolved system appearance. */
export function systemThemeIconFileName(
  shouldUseDarkColors: boolean,
): string {
  return `icon-${systemThemeIcon(shouldUseDarkColors)}.png`;
}

/**
 * Prefer the OS-theme-specific icon, while retaining icon.png as a safe
 * fallback for development trees and older packaged resources.
 */
export function resolveSystemThemeIconPath(
  directory: string,
  shouldUseDarkColors: boolean,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  const themedPath = join(
    directory,
    systemThemeIconFileName(shouldUseDarkColors),
  );
  if (fileExists(themedPath)) return themedPath;

  const fallbackPath = join(directory, "icon.png");
  return fileExists(fallbackPath) ? fallbackPath : null;
}
