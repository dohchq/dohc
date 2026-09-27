import type {
  DesktopUserSettings,
  DesktopUserSettingsResult,
  ThemeMode,
} from "../settings/userSettings";
import {
  DEFAULT_USER_SETTINGS,
  EDITOR_FONTS,
  effectiveThemeMode,
  settingsDeepEqual,
} from "../settings/userSettings";
import { readableAccent } from "./accentColor";
import { setChosenColors } from "./workbench/chosenColors";

// The settings that change only how the window looks. They apply to the
// document here, never through React state, so a save that changes only them
// does not render the shell again.
type LookSettings = Pick<DesktopUserSettings, "appearance" | "editor">;

let media: MediaQueryList | null = null;
let currentLook: LookSettings = DEFAULT_USER_SETTINGS;

// The OS-drawn window controls (titleBarOverlay) can't read CSS — mirror
// every theme flip to main. Best-effort: a platform without an overlay (or a
// test without the bridge) just ignores it.
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  void window.dohcDesktop?.setTitlebarTheme?.({ theme }).catch(() => undefined);
}

function setProperty(name: string, value: string | null): void {
  const style = document.documentElement.style;
  if (value === null) style.removeProperty(name);
  else if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
}

function applyLook(look: LookSettings): void {
  currentLook = look;
  const { appearance, editor } = look;
  const theme = effectiveThemeMode(appearance.themeMode, media?.matches ?? false);
  applyTheme(theme);
  // Inline, so it wins over both theme blocks in styles.css; a theme flip
  // runs this again for the other theme's readable shade.
  setProperty(
    "--dohc-accent",
    appearance.accentColor === null ? null : readableAccent(appearance.accentColor, theme),
  );
  setProperty(
    "--dohc-editor-font",
    (EDITOR_FONTS as readonly string[]).includes(editor.fontFamily)
      ? `var(--font-${editor.fontFamily})`
      : `"${editor.fontFamily}", var(--font-sans)`,
  );
  setProperty("--dohc-editor-font-size", `${editor.fontSize}px`);
  // appearance.zoomLevel is deliberately not applied here: zoom is a window
  // property main owns (windowZoom.ts) — main applies it on window load, on
  // every zoom step, and on every settings save.
}

/** Applies what the settings say about the window's look. */
export function applyLookSettings(settings: DesktopUserSettings): void {
  applyLook(settings);
  setChosenColors(settings.appearance);
}

/**
 * True when two reads of the settings file differ only in look settings, so
 * the shell has nothing new to render. Every appearance key is look; of the
 * editor's, only the font and its size are.
 */
export function differsOnlyInLook(
  before: DesktopUserSettingsResult,
  after: DesktopUserSettingsResult,
): boolean {
  const withoutLook = (result: DesktopUserSettingsResult) => ({
    ...result,
    settings: {
      ...result.settings,
      appearance: null,
      editor: { ...result.settings.editor, fontFamily: null, fontSize: null },
    },
  });
  return settingsDeepEqual(withoutLook(before), withoutLook(after));
}

// Follows the system theme unless the user explicitly toggled; never
// interrupts running work (a data-attribute flip only).
export function initTheme(): void {
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => applyLook(currentLook));

  applyLook(currentLook);

  void window.dohcDesktop
    ?.getUserSettings?.()
    .then((result: DesktopUserSettingsResult) => {
      applyLookSettings(result.settings);
    })
    .catch(() => undefined);
}

async function setThemeMode(themeMode: ThemeMode): Promise<void> {
  const result = await window.dohcDesktop?.getUserSettings?.();
  if (!result) {
    applyLook({ ...currentLook, appearance: { ...currentLook.appearance, themeMode } });
    return;
  }
  const next = {
    ...result.settings,
    appearance: { ...result.settings.appearance, themeMode },
  };
  applyLookSettings(next);
  await window.dohcDesktop?.setUserSettings?.({ settings: next, base: result.settings });
}

export function toggleTheme(): void {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  void setThemeMode(next).catch((error) => {
    console.warn("Failed to persist theme mode", error);
  });
}
