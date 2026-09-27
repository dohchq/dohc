import { palette } from "./tokens";

// WCAG 2.x relative luminance and contrast, for 6-digit hex colors.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

/** `amount` of `top` over `bottom`, mixed per sRGB channel. */
export function mixHex(top: string, bottom: string, amount: number): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(index, index + 2), 16);
  return `#${[1, 3, 5]
    .map((index) => Math.round(channel(top, index) * amount + channel(bottom, index) * (1 - amount)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Text meets the accent in three ways on each surface: accent text and focus
// rings on the surface, accent text on its own tint (mentions use
// bg-accent/15, table grips a 16% mix), and paper-colored labels on a
// primary button, which fades to 90% on hover. The surfaces include line,
// the fill of an active editor toolbar button that draws "Aa" in the accent.
export const ACCENT_MIN_CONTRAST = 4.5;
export const ACCENT_TINT = 0.16;
export const ACCENT_HOVER = 0.9;
const SURFACES = ["bg", "panel", "panel2", "line"] as const;
const STEPS = 20;

export function accentReads(accent: string, mode: "light" | "dark"): boolean {
  const paper = palette[mode].bg;
  return SURFACES.every((name) => {
    const surface = palette[mode][name];
    return contrastRatio(accent, surface) >= ACCENT_MIN_CONTRAST &&
      contrastRatio(accent, mixHex(accent, surface, ACCENT_TINT)) >= ACCENT_MIN_CONTRAST &&
      contrastRatio(paper, mixHex(accent, surface, ACCENT_HOVER)) >= ACCENT_MIN_CONTRAST;
  });
}

/**
 * The chosen accent, shaded toward black in the light theme or tinted toward
 * white in the dark theme just far enough that it reads in every way above.
 * A color that already reads is used as it is.
 */
export function readableAccent(hex: string, mode: "light" | "dark"): string {
  const color = hex.toLowerCase();
  const toward = mode === "light" ? "#000000" : "#ffffff";
  for (let step = 0; step <= STEPS; step += 1) {
    const candidate = mixHex(toward, color, step / STEPS);
    if (accentReads(candidate, mode)) return candidate;
  }
  return toward;
}
