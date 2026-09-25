import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  CSS_TOKEN_NAMES,
  IDENTITY_HUES,
  fonts,
  identityHues,
  palette,
  type ThemeTokens,
} from "./tokens";

// WCAG contrast (relative-luminance math per WCAG 2.x, no dependency).
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`expected 6-digit hex, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(match[1].slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// An sRGB mix, the fill an avatar draws with `bg-hue-*/15` over its card.
function mix(fg: string, bg: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i, 3 + i), 16);
  return `#${[0, 2, 4]
    .map((i) => Math.round(channel(fg, i) * amount + channel(bg, i) * (1 - amount)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("WCAG AA contrast, both modes", () => {
  const PAIRS: Array<{
    fg: keyof ThemeTokens;
    bg: keyof ThemeTokens;
    min: number;
  }> = [
    { fg: "ink", bg: "bg", min: 4.5 },
    { fg: "muted", bg: "bg", min: 4.5 },
    { fg: "ink", bg: "panel", min: 4.5 },
    { fg: "ink", bg: "panel2", min: 4.5 },
    { fg: "agent", bg: "bg", min: 4.5 },
    { fg: "agent", bg: "panel", min: 4.5 },
    { fg: "agent", bg: "panel2", min: 4.5 },
    // subtle is decorative (kbd hints, timestamps): 3.0 is the bar — on
    // every surface it actually sits on, not just bg (the sidebar, history
    // timeline, and status bar all render text-subtle on panel-2).
    { fg: "subtle", bg: "bg", min: 3.0 },
    { fg: "subtle", bg: "panel", min: 3.0 },
    { fg: "subtle", bg: "panel2", min: 3.0 },
    // The find-match mark is an OPAQUE chip that must pop on every surface a
    // result row renders on: the side panel, the hover row (panel-2), and the
    // keyboard-selected row (line) — 3:1 is the graphical-object bar.
    { fg: "match", bg: "panel", min: 3.0 },
    { fg: "match", bg: "panel2", min: 3.0 },
    { fg: "match", bg: "line", min: 3.0 },
    // Bold ink text sits ON the mark. Light clears AA (4.62); dark tops out
    // at 4.27 — the physical ceiling while the mark itself holds 3:1 against
    // the selected-row bg (bold weight carries the remaining gap).
    { fg: "ink", bg: "match", min: 4.2 },
  ];

  for (const mode of ["light", "dark"] as const) {
    it(`${mode} token pairs clear their thresholds`, () => {
      for (const pair of PAIRS) {
        const ratio = contrast(palette[mode][pair.fg], palette[mode][pair.bg]);
        expect(
          ratio,
          `${pair.fg} on ${pair.bg} (${mode}) = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(pair.min);
      }
    });

    // Avatar initials are text: AA on every surface an avatar sits on, and
    // on the avatar's own tinted fill, which is the tightest of the four.
    it(`${mode} identity hues read as text on paper and on their tint`, () => {
      for (const hue of IDENTITY_HUES) {
        const fg = identityHues[mode][hue];
        const surfaces = ["bg", "panel", "panel2"] as const;
        for (const surface of surfaces) {
          const bg = palette[mode][surface];
          for (const [label, on] of [
            [surface, bg],
            [`${surface} tint`, mix(fg, bg, 0.15)],
          ] as const) {
            const ratio = contrast(fg, on);
            expect(ratio, `${hue} on ${label} (${mode}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });
  }
});

// styles.css carries the same values as a static stylesheet so first paint
// never waits on JS. This is the guard that keeps the two files identical.
describe("styles.css mirrors tokens.ts", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf("}", start));
  };
  const blocks = { light: block(":root"), dark: block("[data-theme='dark']") };

  for (const mode of ["light", "dark"] as const) {
    it(`${mode} values match`, () => {
      const expected = [
        ...Object.entries(CSS_TOKEN_NAMES).map(
          ([key, name]) => [name, palette[mode][key as keyof ThemeTokens]] as const,
        ),
        ...IDENTITY_HUES.map((hue) => [`--dohc-hue-${hue}`, identityHues[mode][hue]] as const),
      ];
      for (const [name, value] of expected) {
        expect(blocks[mode], name).toContain(`${name}: ${value};`);
      }
    });
  }

  it("type stacks match", () => {
    for (const [name, value] of Object.entries(fonts)) {
      expect(blocks.light, name).toContain(`${name}: ${value};`);
    }
  });
});

// main.tsx bundles both families through fontsource. A stack whose first name
// is not the one the package's @font-face rules declare fails silently: every
// surface renders in the system fallback and nothing reports it.
describe("the type stacks name the bundled families", () => {
  const require = createRequire(import.meta.url);
  const declaredFamilies = (specifier: string) =>
    new Set(
      [...readFileSync(require.resolve(specifier), "utf8").matchAll(/font-family:\s*['"]?([^'";]+)['"]?;/g)]
        .map((match) => match[1]),
    );
  const firstFamily = (stack: string) => stack.split(",")[0].trim().replace(/^"|"$/g, "");

  for (const [token, specifier] of [
    ["--font-sans", "@fontsource-variable/inter"],
    ["--font-mono", "@fontsource/ibm-plex-mono/400.css"],
  ] as const) {
    it(`${token} is the family ${specifier} declares`, () => {
      expect(declaredFamilies(specifier)).toEqual(new Set([firstFamily(fonts[token])]));
    });
  }
});
