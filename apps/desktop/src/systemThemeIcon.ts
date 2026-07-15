import { existsSync } from "node:fs";
import { join } from "node:path";

export type SystemThemeIcon = "light" | "dark";

type NativeThemeIconState = {
  shouldUseDarkColors: boolean;
};

type IconWindow = {
  setIcon(iconPath: string): void;
};

/**
 * Follow Electron's resolved system appearance. The desktop app does not
 * override nativeTheme.themeSource, so this signal tracks the OS on every
 * supported platform.
 */
export function shouldUseDarkSystemIcon(
  theme: NativeThemeIconState,
): boolean {
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
