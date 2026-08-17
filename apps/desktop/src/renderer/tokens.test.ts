import { describe, expect, it } from "vitest";
import indexHtml from "./index.html?raw";
import stylesCss from "./styles.css?raw";
import { CSS_TOKEN_NAMES, fonts, palette, type ThemeTokens } from "./tokens";

// THE duplication guard for the design tokens: styles.css (static, first
// paint) and tokens.ts (window chrome) deliberately carry the same values;
// this test parses the stylesheet and fails on any drift between them.

/** The declarations inside the first block matching `selector`. */
function blockBody(selector: string): string {
  // Anchored at line start: "[data-theme='dark']" also appears inside the
  // @custom-variant directive, which must not match.
  const rule = new RegExp(
    `^${selector.replace(/[[\]']/g, "\\$&").replace(/\\'/g, "'")}\\s*\\{`,
    "m",
  );
  const match = rule.exec(stylesCss);
  expect(match, `styles.css must contain a ${selector} block`).not.toBeNull();
  const open = stylesCss.indexOf("{", match!.index);
  return stylesCss.slice(open + 1, stylesCss.indexOf("}", open));
}

/** Every custom property declared in a block, keyed by its full name. */
function declarations(selector: string, pattern: RegExp): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const match of blockBody(selector).matchAll(pattern)) {
    declared[match[1]] = match[2].trim();
  }
  return declared;
}

describe("tokens.ts ⟷ styles.css sync", () => {
  const blocks = {
    light: declarations(":root", /(--dohc-[a-z0-9-]+):\s*([^;]+);/g),
    dark: declarations("[data-theme='dark']", /(--dohc-[a-z0-9-]+):\s*([^;]+);/g),
  } as const;

  for (const mode of ["light", "dark"] as const) {
    it(`${mode} values match styles.css exactly`, () => {
      for (const key of Object.keys(CSS_TOKEN_NAMES) as (keyof ThemeTokens)[]) {
        expect(blocks[mode][CSS_TOKEN_NAMES[key]], `${CSS_TOKEN_NAMES[key]} (${mode})`).toBe(
          palette[mode][key],
        );
      }
      // No stray CSS tokens that tokens.ts doesn't know about either.
      expect(Object.keys(blocks[mode]).sort()).toEqual(
        Object.values(CSS_TOKEN_NAMES).sort(),
      );
    });
  }

  // The plugin panel theme bridge sends these stacks to another origin, so
  // they get the same guard the colors have.
  it("font stacks match styles.css exactly", () => {
    expect(declarations(":root", /(--font-[a-z]+):\s*([^;]+);/g)).toEqual({
      ...fonts,
    });
  });
});

// index.html's inline first-paint block is the THIRD copy of bg/ink (it
// exists so the very first frame — before styles.css loads — is already the
// right color). It must stay in sync too: the visualLanguage E2E only sees
// computed styles after the stylesheet has overridden it.
describe("index.html first-paint block ⟷ tokens.ts sync", () => {
  it("light and dark bg/ink match the palette", () => {
    const paints = [
      ...indexHtml.matchAll(/background:\s*(#[0-9a-f]{6});\s*color:\s*(#[0-9a-f]{6});/gi),
    ];
    expect(paints, "expected a light and a dark first-paint pair").toHaveLength(2);
    const [light, dark] = paints;
    expect(light[1]).toBe(palette.light.bg);
    expect(light[2]).toBe(palette.light.ink);
    expect(dark[1]).toBe(palette.dark.bg);
    expect(dark[2]).toBe(palette.dark.ink);
  });
});

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
    // EVERY surface it actually sits on, not just bg (the sidebar, history
    // timeline, and status bar all render text-subtle on panel-2).
    { fg: "subtle", bg: "bg", min: 3.0 },
    { fg: "subtle", bg: "panel", min: 3.0 },
    { fg: "subtle", bg: "panel2", min: 3.0 },
    // The find-match mark is an OPAQUE chip that must pop on every surface a
    // result row renders on: the side panel, the hover row (panel-2), AND the
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
  }
});
