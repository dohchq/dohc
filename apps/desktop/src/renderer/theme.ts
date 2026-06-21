import type {
  DesktopUserSettings,
  DesktopUserSettingsResult,
  ThemeMode,
} from "../settings/userSettings";
import { effectiveThemeMode } from "../settings/userSettings";

const LEGACY_STORAGE_KEY = "dohc-theme";

type AppearanceSettings = DesktopUserSettings["appearance"];

let media: MediaQueryList | null = null;
let currentAppearance: AppearanceSettings = {
  themeMode: "system",
  density: "comfortable",
  reduceMotion: false,
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

  void window.dohcDesktop
    ?.getUserSettings?.()
    .then(async (result: DesktopUserSettingsResult) => {
      let next = result.settings.appearance;
      if (result.source === "default" && (legacy === "light" || legacy === "dark")) {
        next = { ...next, themeMode: legacy };
        await window.dohcDesktop?.setUserSettings?.({
          settings: {
            ...result.settings,
            appearance: next,
          },
        });
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

export function toggleTheme(): void {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  void setThemeMode(next).catch(() => undefined);
}
