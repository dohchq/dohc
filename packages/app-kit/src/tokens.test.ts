import { describe, expect, it } from "vitest";

interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}

const nodeProcess = (
  globalThis as { process?: { getBuiltinModule?: (id: string) => NodeFs | undefined } }
).process;
const css = nodeProcess
  ?.getBuiltinModule?.("node:fs")
  ?.readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function extractVars(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of block.matchAll(/(--kit-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[match[1]!] = match[2]!.trim();
  }
  return vars;
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const clean = hex.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

describe("app-kit design tokens WCAG contrast", () => {
  const source = css ?? "";
  const darkIdx = source.indexOf("@media (prefers-color-scheme: dark)");
  const light = extractVars(source.slice(0, darkIdx));
  const darkRootMatch = /:root\s*\{([\s\S]*?)\n\s*\}/.exec(source.slice(darkIdx));
  const dark = { ...light, ...extractVars(darkRootMatch?.[1] ?? "") };

  for (const [themeName, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`meets WCAG AA text (4.5:1) and UI boundary (3:1) targets in ${themeName} mode`, () => {
      expect(source.length).toBeGreaterThan(100);
      const bg = parseHex(tokens["--kit-bg"]!);
      const panel = parseHex(tokens["--kit-panel"]!);
      const panel2 = parseHex(tokens["--kit-panel-2"]!);
      const ink = parseHex(tokens["--kit-ink"]!);
      const muted = parseHex(tokens["--kit-muted"]!);
      const subtle = parseHex(tokens["--kit-subtle"]!);
      const accent = parseHex(tokens["--kit-accent"]!);
      const onAccent = parseHex(tokens["--kit-on-accent"]!);
      const dangerFill = parseHex(tokens["--kit-danger-fill"]!);
      const onDanger = parseHex(tokens["--kit-on-danger"]!);
      const lineStrong = parseHex(tokens["--kit-line-strong"]!);

      for (const surface of [bg, panel, panel2]) {
        expect(contrast(ink, surface), `${themeName} ink`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(muted, surface), `${themeName} muted`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(lineStrong, surface), `${themeName} line-strong`).toBeGreaterThanOrEqual(
          3.0,
        );
      }
      expect(contrast(subtle, panel), `${themeName} subtle on panel`).toBeGreaterThanOrEqual(4.5);

      for (const token of [
        "--kit-accent",
        "--kit-on-accent",
        "--kit-panel",
        "--kit-panel-2",
        "--kit-danger-fill",
        "--kit-on-danger",
        "--kit-line",
      ] as const) {
        expect(tokens[token], `${themeName} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(contrast(onAccent, accent), `${themeName} primary button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(onDanger, dangerFill), `${themeName} danger button`).toBeGreaterThanOrEqual(
        4.5,
      );

      for (const name of [
        "--kit-info",
        "--kit-success",
        "--kit-warning",
        "--kit-danger",
      ] as const) {
        const fg = parseHex(tokens[name]!);
        const tinted = blend(fg, panel, 0.1);
        expect(contrast(fg, panel), `${themeName} ${name} on panel`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(fg, tinted), `${themeName} ${name} on tint`).toBeGreaterThanOrEqual(4.5);
      }

      const focusPct = themeName === "light" ? 0.65 : 0.58;
      expect(
        contrast(blend(accent, panel, focusPct), panel),
        `${themeName} focus outline on panel`,
      ).toBeGreaterThanOrEqual(3.0);
    });
  }
});
