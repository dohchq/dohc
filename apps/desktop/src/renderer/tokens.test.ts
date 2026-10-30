import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CSS_TOKEN_NAMES,
  IDENTITY_HUES,
  fonts,
  identityHues,
  palette,
  type ThemeTokens,
} from "./tokens";
import { contrastRatio as contrast, luminance, mixHex as mix } from "./accentColor";
import { MENU_FRAME } from "./ui/Menu";

import { agentTextClass, presentationColor, presentationClasses } from "./workbench/actorPresentation";

const SURFACES = ["bg", "panel", "panel2"] as const;

// The ink alpha of a state fill, so the test can composite it on a surface.
function inkAlpha(token: string, name: string): number {
  const alpha = /^color-mix\(in srgb, var\(--dohc-ink\) (\d+)%, transparent\)$/.exec(token);
  expect(alpha, name).not.toBeNull();
  return Number(alpha![1]) / 100;
}

describe("the surface ladder", () => {
  // Paper is one end of the ladder in both themes: chrome (panel) is one
  // step away from it and insets (panel-2) two. Dark once had panel on the
  // far side of panel-2, so a titlebar read lighter than the rail beside it.
  it("steps away from paper in the same order in both themes", () => {
    const light = SURFACES.map((surface) => luminance(palette.light[surface]));
    const dark = SURFACES.map((surface) => luminance(palette.dark[surface]));
    expect(light[0]).toBeGreaterThan(light[1]!);
    expect(light[1]).toBeGreaterThan(light[2]!);
    expect(dark[0]).toBeLessThan(dark[1]!);
    expect(dark[1]).toBeLessThan(dark[2]!);
  });

  it("keeps every step visible", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(contrast(palette[mode].bg, palette[mode].panel), `bg/panel (${mode})`).toBeGreaterThanOrEqual(1.04);
      expect(contrast(palette[mode].panel, palette[mode].panel2), `panel/panel-2 (${mode})`).toBeGreaterThanOrEqual(1.04);
    }
  });
});

describe("state fills", () => {
  // The decided alphas (MEGA-PLAN step 2): 7% hover and 11% selected,
  // and one 40% scrim with no blur. Both themes share them.
  it("are 7% hover, 11% selected and a 40% scrim in both themes", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(inkAlpha(palette[mode].hover, "hover")).toBe(0.07);
      expect(inkAlpha(palette[mode].selected, "selected")).toBe(0.11);
      expect(palette[mode].scrim).toBe("rgba(0, 0, 0, 0.40)");
    }
  });

  it("tell a hovered row from a selected one on every surface", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const surface of SURFACES) {
        const hover = mix(palette[mode].ink, palette[mode][surface], inkAlpha(palette[mode].hover, "hover"));
        const selected = mix(palette[mode].ink, palette[mode][surface], inkAlpha(palette[mode].selected, "selected"));
        expect(contrast(hover, palette[mode][surface]), `hover on ${surface} (${mode})`).toBeGreaterThanOrEqual(1.1);
        expect(contrast(selected, palette[mode][surface]), `selected on ${surface} (${mode})`).toBeGreaterThanOrEqual(1.2);
        expect(contrast(selected, hover), `selected vs hover on ${surface} (${mode})`).toBeGreaterThanOrEqual(1.06);
      }
    }
  });
});

// A focus mark is a graphical object: 3:1 against what it sits on, a surface
// or a hover or selected fill on that surface. The halo is the accent at the
// focus alpha; a row's line is the accent itself.
describe("keyboard focus marks", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode} halo and row line clear 3:1 on every surface and fill`, () => {
      const tokens = palette[mode];
      const alpha = /^color-mix\(in srgb, var\(--dohc-accent\) (\d+)%, transparent\)$/.exec(tokens.focus);
      expect(alpha, "focus").not.toBeNull();
      for (const surface of SURFACES) {
        const unders = [
          ["", tokens[surface]],
          ["hover/", mix(tokens.ink, tokens[surface], inkAlpha(tokens.hover, "hover"))],
          ["selected/", mix(tokens.ink, tokens[surface], inkAlpha(tokens.selected, "selected"))],
        ] as const;
        for (const [fill, under] of unders) {
          const halo = contrast(mix(tokens.accent, under, Number(alpha![1]) / 100), under);
          expect(halo, `halo on ${fill}${surface} (${mode}) = ${halo.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
          const line = contrast(tokens.accent, under);
          expect(line, `row line on ${fill}${surface} (${mode}) = ${line.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }
});

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
    // Olive is text (an agent's name) on every surface a chat or history
    // row sits on.
    { fg: "agent", bg: "bg", min: 4.5 },
    { fg: "agent", bg: "panel", min: 4.5 },
    { fg: "agent", bg: "panel2", min: 4.5 },
    // subtle is decorative (kbd hints, timestamps): 3.0 is the bar — on
    // every surface it actually sits on, not just bg (count pills and
    // section headers render text-subtle on panel-2).
    { fg: "subtle", bg: "bg", min: 3.0 },
    { fg: "subtle", bg: "panel", min: 3.0 },
    { fg: "subtle", bg: "panel2", min: 3.0 },
    // The find-match mark is an OPAQUE chip that must pop on every surface a
    // result row renders on: paper, the side panel and inset surfaces.
    // 3:1 is the graphical-object bar.
    { fg: "match", bg: "bg", min: 3.0 },
    { fg: "match", bg: "panel", min: 3.0 },
    { fg: "match", bg: "panel2", min: 3.0 },
    // Paper-colored text sits ON the mark, at AA like any other text.
    { fg: "bg", bg: "match", min: 4.5 },
    // Labels on filled buttons use the paper color: primary on accent, and
    // destructive confirms on danger. White on dark-theme danger was 2.7:1.
    { fg: "bg", bg: "accent", min: 4.5 },
    { fg: "bg", bg: "danger", min: 4.5 },
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

    // The editor tints a plain find match 22% blue and an inline atom 10%;
    // ink sits on both. The active match is the opaque chip with paper text,
    // inside code blocks too (styles.css forces it over the syntax colors).
    it(`${mode} text on the match tints is AA`, () => {
      for (const surface of SURFACES) {
        for (const [label, amount] of [["find match", 0.22], ["atom", 0.1]] as const) {
          const tint = mix(palette[mode].match, palette[mode][surface], amount);
          expect(contrast(palette[mode].ink, tint), `ink on ${label}/${surface} (${mode})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${mode} state fills keep row text and find matches readable`, () => {
      for (const state of ["hover", "selected"] as const) {
        const amount = inkAlpha(palette[mode][state], state);
        for (const surface of SURFACES) {
          const fill = mix(palette[mode].ink, palette[mode][surface], amount);
          for (const fg of ["ink", "muted"] as const) {
            expect(contrast(palette[mode][fg], fill), `${fg} on ${state}/${surface} (${mode})`).toBeGreaterThanOrEqual(4.5);
          }
          // The opaque match chip keeps the 3:1 graphical floor on the full
          // fill, the only fill rows use (see the attenuation scan below).
          expect(contrast(palette[mode].match, fill), `match on ${state}/${surface} (${mode})`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    // A destructive row (Delete, Forget) is a menu row: danger text on the
    // menu frame's panel at rest, hovered, and focused, selected or active.
    it(`${mode} danger text is AA on every menu row fill`, () => {
      expect(MENU_FRAME.split(" ")).toContain("bg-panel");
      for (const [fill, amount] of [
        ["rest", 0],
        ["hover", inkAlpha(palette[mode].hover, "hover")],
        ["selected", inkAlpha(palette[mode].selected, "selected")],
      ] as const) {
        const ratio = contrast(palette[mode].danger, mix(palette[mode].ink, palette[mode].panel, amount));
        expect(ratio, `danger on ${fill}/panel (${mode}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
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

  it("state utilities map to their semantic tokens", () => {
    for (const state of ["hover", "selected", "scrim"] as const) {
      expect(block("@theme inline")).toContain(`--color-${state}: var(--dohc-${state});`);
      expect(palette.light[state]).toBe(palette.dark[state]);
    }
  });

  it("type stacks match", () => {
    for (const [name, value] of Object.entries(fonts)) {
      expect(blocks.light, name).toContain(`${name}: ${value};`);
    }
  });

  // index.html's `light dark` follows the OS, so a dark app on a light OS
  // drew white native checkboxes.
  it("native controls follow the app theme and check in the accent", () => {
    expect(blocks.light).toContain("color-scheme: light;");
    expect(blocks.dark).toContain("color-scheme: dark;");
    expect(css).toMatch(/\binput \{\s*accent-color: var\(--dohc-accent\);/);
  });
});

// An attenuated state fill (a bg-selected/ or bg-hover/ opacity modifier)
// lands between hover and selected, too close to either to read; rows use
// the full fills and carry any further meaning in weight or a ring.
describe("renderer rows use the full state fills", () => {
  it("has no bg-selected/ or bg-hover/ opacity modifier", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
    expect(sources.length).toBeGreaterThan(100);
    const offenders = sources.filter((name) => /\bbg-(selected|hover)\//.test(readFileSync(join(root, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});

// The light-only document export carries a copy of the palette. The names it
// spells are the tokens.ts keys, so a changed value must land in both. The
// marketing demo's shadow root (apps/site) uses styles.css itself: its build
// also applies the :root tokens to :host.
describe("copies of the palette mirror tokens.ts", () => {
  const keyOf = Object.fromEntries(
    Object.entries(CSS_TOKEN_NAMES).map(([key, name]) => [name, key as keyof ThemeTokens]),
  );
  const declarations = (css: string) =>
    [...css.matchAll(/(--dohc-[a-z0-9-]+): ([^;]+);/g)].map(([, name, value]) => [name!, value!] as const);

  it("the site demo keeps no copy that could drift", () => {
    const css = readFileSync(new URL("../../../site/src/demo.css", import.meta.url), "utf8");
    expect(declarations(css).filter(([name]) => name in keyOf)).toEqual([]);
  });

  it("the document export", () => {
    const source = readFileSync(new URL("./editor/documentExport.ts", import.meta.url), "utf8");
    const found = [...source.matchAll(/^\s+--([a-z0-9-]+): (#[0-9a-f]{6});$/gm)].map(([, name, value]) => [`--dohc-${name}`, value!] as const);
    expect(found.length).toBeGreaterThan(0);
    for (const [name, value] of found) {
      expect(value, name).toBe(palette.light[keyOf[name]!]);
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

it("keeps document caret labels at AA for every hue and neutral in both themes", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const label = css.match(/\.dohc-notion-editor \.collaboration-carets__label\s*\{([^}]+)\}/)![1]!;
  expect(label.match(/\bcolor:\s*([^;]+);/)![1]!.trim()).toBe("var(--dohc-bg)");
  for (const hue of [null, ...IDENTITY_HUES]) {
    for (const mode of ["light", "dark"] as const) {
      expect(contrast(palette[mode].bg, presentationColor({ group: "label", hue, self: false }, "human", mode).stroke), `${hue ?? "neutral"} label (${mode})`).toBeGreaterThanOrEqual(4.5);
    }
  }
});


it("keeps agent name, glyph and opaque border contrast on every surface in both themes", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const hue of [null, ...IDENTITY_HUES]) {
      const token = { group: "contrast", hue, self: false };
      const color = presentationColor(token, "agent", mode).stroke;
      for (const surface of SURFACES) {
        expect(contrast(color, palette[mode][surface]), String(hue) + "/" + surface).toBeGreaterThanOrEqual(4.5);
      }
      // The name and sparkle beside the avatar take the hue measured above.
      expect(agentTextClass(token)).toBe(hue ? "text-hue-" + hue : "text-agent");
      const classes = presentationClasses(token, "agent");
      expect(classes).toContain(hue ? "border-hue-" + hue : "border-agent");
      expect(classes).not.toContain("/50");
    }
  }
});
