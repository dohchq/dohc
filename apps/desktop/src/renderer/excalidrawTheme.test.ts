import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSS_TOKEN_NAMES, palette, type ThemeTokens } from "./tokens";
import { contrastRatio as contrast } from "./accentColor";

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

  it("shows the dark selection in the dark accent", () => {
    const formula = declarations(block(':root[data-theme="dark"] .excalidraw')).get("--color-selection")!;
    const accent = [1, 3, 5].map((index) => parseInt(palette.dark.accent.slice(index, index + 2), 16));
    const channels = { r: accent[0]!, g: accent[1]!, b: accent[2]! };
    const drawn = [...formula.matchAll(/calc\(\(([^)]+)\) \/ ([\d.]+)\)/g)].map(([, sum, divisor]) => {
      const terms = [...sum!.matchAll(/([+-])?\s*([\d.]+)(?: \* ([rgb]))?/g)].map(
        ([, sign, factor, channel]) => (sign === "-" ? -1 : 1) * Number(factor) * (channel ? channels[channel as "r"] : 1),
      );
      return terms.reduce((total, term) => total + term, 0) / Number(divisor);
    });
    expect(drawn).toHaveLength(3);
    for (const channel of drawn) expect(channel).toBeGreaterThanOrEqual(-0.5);
    for (const channel of drawn) expect(channel).toBeLessThanOrEqual(255.5);

    // invert(93%), then hue-rotate(180deg), per sRGB channel.
    const inverted = drawn.map((channel) => 0.93 * 255 - 0.86 * Math.round(channel));
    const rotate = [
      [-0.574, 1.43, 0.144],
      [0.426, 0.43, 0.144],
      [0.426, 1.43, -0.856],
    ];
    const shown = rotate.map((row) => row.reduce((total, factor, index) => total + factor * inverted[index]!, 0));
    shown.forEach((channel, index) => expect(Math.abs(channel - accent[index]!)).toBeLessThanOrEqual(1));
  });

  it("keeps the selected tool, the slider track and the icons readable on the islands", () => {
    const set = declarations(block(":root .excalidraw"));
    const token = (name: string) => tokenKey.get(/^var\((--dohc-[a-z0-9-]+)\)$/.exec(set.get(name) ?? "")?.[1] ?? "");
    expect(token("--island-bg-color")).toBe("panel");
    const pairs = [
      ["--color-surface-primary-container", 3],
      ["--color-slider-track", 3],
      ["--color-on-surface", 4.5],
    ] as const;
    for (const mode of ["light", "dark"] as const) {
      for (const [name, minimum] of pairs) {
        const key = token(name);
        expect(key, name).toBeDefined();
        expect(contrast(palette[mode][key!], palette[mode].panel), `${name} (${mode})`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });
});
