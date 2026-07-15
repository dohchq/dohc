import { existsSync } from "node:fs";
import { join } from "node:path";

export type SystemThemeIcon = "light" | "dark";

type NativeThemeIconState = {
  shouldUseDarkColors: boolean;
  shouldUseDarkColorsForSystemIntegratedUI?: boolean;
};

type IconWindow = {
  setIcon(iconPath: string): void;
};

/**
 * Windows exposes separate app and system appearance preferences. The desktop
 * icon belongs to system chrome, so follow that signal there; Electron's
 * general dark-color signal follows the OS on macOS and Linux.
 */
export function shouldUseDarkSystemIcon(
  platform: NodeJS.Platform,
  theme: NativeThemeIconState,
): boolean {
  if (
    platform === "win32" &&
    typeof theme.shouldUseDarkColorsForSystemIntegratedUI === "boolean"
  ) {
    return theme.shouldUseDarkColorsForSystemIntegratedUI;
  }
  return theme.shouldUseDarkColors;
}

/**
 * Electron changes window icons on Windows/Linux and the application Dock
 * icon on macOS. Keeping that platform split here prevents calling an API on
 * an OS where Electron does not support it.
 */
export function applyDesktopIconToPlatform(options: {
  platform: NodeJS.Platform;
  iconPath: string;
  windows: ReadonlyArray<IconWindow>;
  setDockIcon?: (iconPath: string) => void;
}): void {
  if (options.platform === "darwin") {
    options.setDockIcon?.(options.iconPath);
    return;
  }
  for (const window of options.windows) window.setIcon(options.iconPath);
}

export function systemThemeIcon(
  shouldUseDarkColors: boolean,
): SystemThemeIcon {
  return shouldUseDarkColors ? "dark" : "light";
}

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
