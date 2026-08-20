// dohc's design tokens, shaped for a plugin panel. A panel renders on its
// own loopback origin, so nothing in the app's stylesheet reaches it and the
// host cannot touch its DOM; tokens travel as data instead.
//
// This is styling only. The payload grants no authority, gates on no
// capability, and a panel that never asks for it is unaffected.

import { type DohcTheme } from "@dohc/sdk";
import { CSS_TOKEN_NAMES, fonts, palette, type ThemeTokens } from "./tokens";

/**
 * The attributes theme.ts writes to <html>. They are the whole appearance
 * state a panel can see, so watching exactly these catches every change —
 * the settings dialog, the command palette toggle, and an OS theme flip
 * while the mode is "system" — without the bridge knowing about any of them.
 */
export const THEME_ATTRIBUTES = [
  "data-theme",
  "data-density",
  "data-reduce-motion",
] as const;

/**
 * Reads what is on screen right now. The values come from `palette`, which
 * tokens.test.ts already holds byte-identical to styles.css, so a panel and
 * the app cannot show different colors for the same token.
 */
export function readDohcTheme(root: HTMLElement): DohcTheme {
  const mode = root.dataset.theme === "dark" ? "dark" : "light";
  const tokens: Record<string, string> = { ...fonts };
  for (const key of Object.keys(CSS_TOKEN_NAMES) as (keyof ThemeTokens)[]) {
    tokens[CSS_TOKEN_NAMES[key]] = palette[mode][key];
  }
  return {
    mode,
    density: root.dataset.density === "compact" ? "compact" : "comfortable",
    reduceMotion: root.dataset.reduceMotion === "true",
    tokens,
  };
}
