import type {
  DesktopUserSettings,
  DesktopUserSettingsResult,
  ThemeMode,
} from "../settings/userSettings";
import {
  DEFAULT_ZOOM_LEVEL,
  effectiveThemeMode,
} from "../settings/userSettings";

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
  // appearance.zoomLevel is deliberately not applied here: zoom is a window
  // property main owns (windowZoom.ts) — main applies it on window load, on
  // every zoom step, and on every settings save.
}

// Follows the system theme unless the user explicitly toggled; never
// interrupts running work (a data-attribute flip only).
export function initTheme(): void {
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => applyAppearance(currentAppearance));

  applyAppearance(currentAppearance);

  void window.dohcDesktop
    ?.getUserSettings?.()
    .then((result: DesktopUserSettingsResult) => {
      applyAppearance(result.settings.appearance);
    })
    .catch(() => undefined);
}

export function applyAppearanceSettings(appearance: AppearanceSettings): void {
  applyAppearance(appearance);
}

async function setThemeMode(themeMode: ThemeMode): Promise<void> {
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

export function toggleTheme(): void {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  void setThemeMode(next).catch((error) => {
    console.warn("Failed to persist theme mode", error);
  });
}
