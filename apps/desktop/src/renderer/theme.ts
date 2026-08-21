import type {
  DesktopUserSettings,
  DesktopUserSettingsResult,
  ThemeMode,
} from "../settings/userSettings";
import {
  DEFAULT_ZOOM_LEVEL,
  clampZoomLevel,
  effectiveThemeMode,
} from "../settings/userSettings";

const LEGACY_STORAGE_KEY = "dohc-theme";

type AppearanceSettings = DesktopUserSettings["appearance"];

let media: MediaQueryList | null = null;
let currentAppearance: AppearanceSettings = {
  themeMode: "system",
  density: "comfortable",
  reduceMotion: false,
  zoomLevel: DEFAULT_ZOOM_LEVEL,
};

// The OS-drawn window controls (titleBarOverlay) can't read CSS — mirror
// every theme flip to main. Best-effort: a platform without an overlay (or a
// test without the bridge) just ignores it.
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  void window.dohcDesktop?.setTitlebarTheme?.({ theme }).catch(() => undefined);
}

function applyAppearance(appearance: AppearanceSettings): void {
  currentAppearance = appearance;
  const prefersDark = media?.matches ?? false;
  applyTheme(effectiveThemeMode(appearance.themeMode, prefersDark));
  document.documentElement.dataset.density = appearance.density;
  document.documentElement.dataset.reduceMotion = String(appearance.reduceMotion);
  // Chromium zoom is a webContents property only main can set. Best-effort,
  // like the titlebar mirror above.
  void window.dohcDesktop?.setWindowZoom?.({ zoomLevel: appearance.zoomLevel })
    .catch(() => undefined);
}

// Follows the system theme unless the user explicitly toggled; never
// interrupts running work (a data-attribute flip only).
export function initTheme(): void {
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => applyAppearance(currentAppearance));

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  const legacyThemeMode =
    legacy === "light" || legacy === "dark" ? legacy : "system";
  applyAppearance({ ...currentAppearance, themeMode: legacyThemeMode });

  const settingsResult = window.dohcDesktop?.getUserSettings?.();
  if (!settingsResult) return;

  void settingsResult
    .then(async (result: DesktopUserSettingsResult) => {
      let next = result.settings.appearance;
      if (result.source === "default" && (legacy === "light" || legacy === "dark")) {
        next = { ...next, themeMode: legacy };
        try {
          await window.dohcDesktop?.setUserSettings?.({
            settings: {
              ...result.settings,
              appearance: next,
            },
          });
        } catch (error) {
          console.warn("Failed to migrate legacy theme setting", error);
        }
      }
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      applyAppearance(next);
    })
    .catch(() => undefined);
}

export function applyAppearanceSettings(appearance: AppearanceSettings): void {
  applyAppearance(appearance);
}

export async function setThemeMode(themeMode: ThemeMode): Promise<void> {
  const result = await window.dohcDesktop?.getUserSettings?.();
  if (!result) {
    applyAppearance({ ...currentAppearance, themeMode });
    return;
  }
  const next = {
    ...result.settings,
    appearance: { ...result.settings.appearance, themeMode },
  };
  applyAppearance(next.appearance);
  await window.dohcDesktop?.setUserSettings?.({ settings: next });
}

export type ZoomStep = "in" | "out" | "reset";

// Keyboard zoom (Ctrl+= / Ctrl+- / Ctrl+0) writes through to the persisted
// setting, so the Settings dialog always shows the level in effect and the
// window reopens at the same zoom. Same read-modify-persist shape as
// setThemeMode: apply first, then save.
export async function stepZoom(step: ZoomStep): Promise<void> {
  const result = await window.dohcDesktop?.getUserSettings?.();
  const current = result?.settings.appearance ?? currentAppearance;
  const zoomLevel =
    step === "reset"
      ? DEFAULT_ZOOM_LEVEL
      : clampZoomLevel(current.zoomLevel + (step === "in" ? 1 : -1));
  if (zoomLevel === current.zoomLevel) return;
  applyAppearance({ ...current, zoomLevel });
  if (!result) return;
  await window.dohcDesktop?.setUserSettings?.({
    settings: {
      ...result.settings,
      appearance: { ...result.settings.appearance, zoomLevel },
    },
  });
}

export function toggleTheme(): void {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  void setThemeMode(next).catch((error) => {
    console.warn("Failed to persist theme mode", error);
  });
}
