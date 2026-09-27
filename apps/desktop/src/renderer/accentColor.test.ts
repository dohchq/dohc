import { describe, expect, it } from "vitest";
import {
  ACCENT_HOVER,
  ACCENT_MIN_CONTRAST,
  ACCENT_TINT,
  accentReads,
  contrastRatio,
  mixHex,
  readableAccent,
} from "./accentColor";
import { palette } from "./tokens";

const MODES = ["light", "dark"] as const;
const SURFACES = ["bg", "panel", "panel2", "line"] as const;

// Every 51st step of each channel: 216 colors from black to white.
const GRID = [0, 51, 102, 153, 204, 255].flatMap((r) =>
  [0, 51, 102, 153, 204, 255].flatMap((g) =>
    [0, 51, 102, 153, 204, 255].map((b) =>
      `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`)));

describe("a chosen accent color", () => {
  for (const mode of MODES) {
    it(`reads on every surface, on its tint, and under paper labels in the ${mode} theme`, () => {
      for (const chosen of GRID) {
        const accent = readableAccent(chosen, mode);
        for (const name of SURFACES) {
          const surface = palette[mode][name];
          const pairs = [
            ["on", surface],
            ["on its tint over", mixHex(accent, surface, ACCENT_TINT)],
          ] as const;
          for (const [label, on] of pairs) {
            const ratio = contrastRatio(accent, on);
            expect(ratio, `${chosen} → ${accent} ${label} ${name} (${mode})`)
              .toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
          }
          const hover = contrastRatio(palette[mode].bg, mixHex(accent, surface, ACCENT_HOVER));
          expect(hover, `paper on hovered ${accent} over ${name} (${mode})`)
            .toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
        }
      }
    });
  }

  it("keeps dohc's own accent as it is", () => {
    expect(accentReads(palette.light.accent, "light")).toBe(true);
    expect(accentReads(palette.dark.accent, "dark")).toBe(true);
    expect(readableAccent("#1F4A73", "light")).toBe("#1f4a73");
    // Magenta reads on the dark panels but only 4.40:1 on line.
    expect(contrastRatio("#ff00e1", palette.dark.line)).toBeLessThan(ACCENT_MIN_CONTRAST);
    expect(contrastRatio(readableAccent("#ff00e1", "dark"), palette.dark.line))
      .toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
  });

  it("darkens a mid gray in the light theme and lightens it in the dark theme", () => {
    // A mid gray reads on the surfaces but not on its own tint.
    expect(accentReads("#666666", "light")).toBe(false);
    const light = readableAccent("#808080", "light");
    const dark = readableAccent("#808080", "dark");
    expect(contrastRatio(light, "#000000")).toBeLessThan(contrastRatio("#808080", "#000000"));
    expect(contrastRatio(dark, "#ffffff")).toBeLessThan(contrastRatio("#808080", "#ffffff"));
  });
});
