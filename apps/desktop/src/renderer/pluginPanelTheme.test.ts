// @vitest-environment jsdom
import { DOHC_THEME_PROTOCOL, isDohcTheme } from "@dohc/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  THEME_ATTRIBUTES,
  dohcThemeMessage,
  readDohcTheme,
} from "./pluginPanelTheme";
import { CSS_TOKEN_NAMES, fonts, palette } from "./tokens";

function root(attributes: Record<string, string> = {}): HTMLElement {
  const element = document.documentElement;
  for (const name of THEME_ATTRIBUTES) element.removeAttribute(name);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

afterEach(() => root());

describe("readDohcTheme", () => {
  it("reports the light palette by default", () => {
    const theme = readDohcTheme(root());
    expect(theme.mode).toBe("light");
    expect(theme.density).toBe("comfortable");
    expect(theme.reduceMotion).toBe(false);
    expect(theme.tokens["--dohc-ink"]).toBe(palette.light.ink);
  });

  it("reports the dark palette when the app is dark", () => {
    const theme = readDohcTheme(root({ "data-theme": "dark" }));
    expect(theme.mode).toBe("dark");
    expect(theme.tokens["--dohc-ink"]).toBe(palette.dark.ink);
    expect(theme.tokens["--dohc-bg"]).toBe(palette.dark.bg);
  });

  it("carries density and reduced motion", () => {
    const theme = readDohcTheme(
      root({ "data-density": "compact", "data-reduce-motion": "true" }),
    );
    expect(theme.density).toBe("compact");
    expect(theme.reduceMotion).toBe(true);
  });

  // The payload must BE the app's token set, not a list that can fall behind
  // it: every guarded token, spelled the way styles.css spells it, nothing
  // extra beyond the two font stacks.
  it("sends every token the app defines and no others", () => {
    const theme = readDohcTheme(root());
    expect(Object.keys(theme.tokens).sort()).toEqual(
      [...Object.values(CSS_TOKEN_NAMES), ...Object.keys(fonts)].sort(),
    );
    for (const [key, name] of Object.entries(CSS_TOKEN_NAMES)) {
      expect(theme.tokens[name], name).toBe(
        palette.light[key as keyof typeof palette.light],
      );
    }
    expect(theme.tokens["--font-sans"]).toBe(fonts["--font-sans"]);
  });

  it("produces a payload the SDK accepts", () => {
    expect(isDohcTheme(readDohcTheme(root({ "data-theme": "dark" })))).toBe(true);
  });
});

describe("dohcThemeMessage", () => {
  it("stamps the theme protocol", () => {
    const message = dohcThemeMessage(readDohcTheme(root()));
    expect(message.protocol).toBe(DOHC_THEME_PROTOCOL);
    expect(message.theme.mode).toBe("light");
  });
});
