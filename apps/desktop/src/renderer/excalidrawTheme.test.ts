import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSS_TOKEN_NAMES, palette, type ThemeTokens } from "./tokens";
import { contrastRatio as contrast, mixHex as mix, readableAccent } from "./accentColor";

const theme = readFileSync(new URL("./excalidrawTheme.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// The build Excalidraw ships in production, which is what dohc packages.
const dist = dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw"));
const excalidrawCss = readFileSync(join(dist, "index.css"), "utf8");
const excalidrawJs = readFileSync(join(dist, "index.js"), "utf8");

const block = (selector: string) => {
  const start = theme.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return theme.slice(start, theme.indexOf("\n}", start));
};
const declarations = (css: string) =>
  new Map([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
const tokenKey = new Map(Object.entries(CSS_TOKEN_NAMES).map(([key, name]) => [name, key as keyof ThemeTokens]));

// A dohc token, or an sRGB mix of two, as the hex color it paints.
function resolve(value: string | undefined, mode: "light" | "dark"): string | undefined {
  const token = /^var\((--dohc-[a-z0-9-]+)\)$/.exec(value ?? "");
  if (token) {
    const key = tokenKey.get(token[1]!);
    const color = key && palette[mode][key];
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
  }
  const mixed = /^color-mix\(in srgb, (var\([^)]+\)) (\d+)%, (var\([^)]+\))\)$/.exec(value ?? "");
  if (!mixed) return undefined;
  const [top, bottom] = [resolve(mixed[1], mode), resolve(mixed[3], mode)];
  return top && bottom ? mix(top, bottom, Number(mixed[2]) / 100) : undefined;
}

const channels = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const hexOf = (rgb: number[]) => `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
const clip = (channel: number) => Math.min(255, Math.max(0, Math.round(channel)));

// The dark selection's channels for an accent, before Chromium clips them.
function drawnFor(accent: string): number[] {
  const formula = declarations(block(':root[data-theme="dark"] .excalidraw')).get("--color-selection")!;
  const [r, g, b] = channels(accent);
  const values = { r: r!, g: g!, b: b! };
  return [...formula.matchAll(/calc\(\(([^)]+)\) \/ ([\d.]+)\)/g)].map(([, sum, divisor]) => {
    const terms = [...sum!.matchAll(/([+-])?\s*([\d.]+)(?: \* ([rgb]))?/g)].map(
      ([, sign, factor, channel]) => (sign === "-" ? -1 : 1) * Number(factor) * (channel ? values[channel as "r"] : 1),
    );
    return terms.reduce((total, term) => total + term, 0) / Number(divisor);
  });
}

// What the dark canvas shows for drawn channels: invert(93%), then
// hue-rotate(180deg), per sRGB channel.
function shown(drawn: number[]): number[] {
  const inverted = drawn.map((channel) => 0.93 * 255 - 0.86 * channel);
  const rotate = [
    [-0.574, 1.43, 0.144],
    [0.426, 0.43, 0.144],
    [0.426, 1.43, -0.856],
  ];
  return rotate.map((row) => row.reduce((total, factor, index) => total + factor * inverted[index]!, 0));
}

describe("Excalidraw's chrome in dohc's tokens", () => {
  // Excalidraw ignores a variable it does not read, so a rename upstream
  // would quietly bring its lavender back.
  it("sets only variables and classes that Excalidraw declares", () => {
    const names = [...declarations(theme).keys()];
    expect(names.length).toBeGreaterThan(0);
    const classes = [...theme.matchAll(/\.([A-Za-z][\w-]*)/g)].map(([, name]) => name!);
    expect(names.filter((name) => !excalidrawCss.includes(`${name}:`))).toEqual([]);
    expect(classes.filter((name) => !excalidrawCss.includes(`.${name}`))).toEqual([]);
  });

  it("still draws dark through the filter the selection color undoes", () => {
    expect(excalidrawCss).toContain("--theme-filter: invert(93%) hue-rotate(180deg);");
    expect(excalidrawJs).toContain("--color-selection");
  });

  // Unregistered, the canvas would read the rgb(from ...) expression as text.
  it("registers the selection as a color", () => {
    const registration = /@property --color-selection \{([^}]*)\}/.exec(theme)?.[1] ?? "";
    expect(registration).toMatch(/syntax:\s*"<color>";/);
  });

  it("shows the dark selection in the dark accent", () => {
    const drawn = drawnFor(palette.dark.accent);
    expect(drawn).toHaveLength(3);
    for (const channel of drawn) expect(channel).toBeGreaterThanOrEqual(-0.5);
    for (const channel of drawn) expect(channel).toBeLessThanOrEqual(255.5);
    const accent = channels(palette.dark.accent);
    shown(drawn.map(clip)).forEach((channel, index) => expect(Math.abs(channel - accent[index]!)).toBeLessThanOrEqual(1));
  });

  // The filter cannot show every color, so a saturated accent shows as the
  // nearest color it can, which must still stand out on a white canvas.
  it("keeps a saturated custom accent's selection visible on the dark canvas", () => {
    const canvas = hexOf(shown([255, 255, 255]).map(clip));
    for (const chosen of ["#ff0000", "#00ff00", "#0000ff", "#00ffff", "#ff00ff", "#ffff00", "#ffffff"]) {
      const accent = readableAccent(chosen, "dark");
      const selection = hexOf(shown(drawnFor(accent).map(clip)).map(clip));
      expect(contrast(selection, canvas), `${chosen} shown as ${selection}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the selected tool, the slider, the icons and selected fills readable on the islands", () => {
    const set = declarations(block(":root .excalidraw"));
    const pairs = [
      ["--color-surface-primary-container", "--island-bg-color", 3],
      ["--color-slider-track", "--island-bg-color", 3],
      ["--color-on-surface", "--island-bg-color", 4.5],
      // The library tick and the selected-items count draw it over the accent.
      ["--color-primary-light", "--color-primary", 4.5],
      // As a fill, it stands off the island as a selected row does (tokens.test.ts).
      ["--color-primary-light", "--island-bg-color", 1.2],
    ] as const;
    for (const mode of ["light", "dark"] as const) {
      for (const [foreground, background, minimum] of pairs) {
        const [front, back] = [resolve(set.get(foreground), mode), resolve(set.get(background), mode)];
        expect(front, `${foreground} (${mode})`).toBeDefined();
        expect(back, `${background} (${mode})`).toBeDefined();
        expect(contrast(front!, back!), `${foreground} on ${background} (${mode})`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });
});
