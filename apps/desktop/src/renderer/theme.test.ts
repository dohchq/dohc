// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../settings/userSettings";
import { readableAccent } from "./accentColor";
import { applyLookSettings, differsOnlyInLook } from "./theme";
import { chosenHue } from "./workbench/chosenColors";

function settings(change: {
  appearance?: Partial<DesktopUserSettings["appearance"]>;
  editor?: Partial<DesktopUserSettings["editor"]>;
  profile?: DesktopUserSettings["profile"];
}): DesktopUserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    profile: change.profile ?? DEFAULT_USER_SETTINGS.profile,
    appearance: { ...DEFAULT_USER_SETTINGS.appearance, ...change.appearance },
    editor: { ...DEFAULT_USER_SETTINGS.editor, ...change.editor },
  };
}

const property = (name: string) => document.documentElement.style.getPropertyValue(name);

afterEach(() => applyLookSettings(DEFAULT_USER_SETTINGS));

describe("applying the settings file's look", () => {
  it("sets the accent in a shade that reads in the theme on screen", () => {
    applyLookSettings(settings({ appearance: { themeMode: "light", accentColor: "#ffd400" } }));
    expect(property("--dohc-accent")).toBe(readableAccent("#ffd400", "light"));

    applyLookSettings(settings({ appearance: { themeMode: "dark", accentColor: "#ffd400" } }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(property("--dohc-accent")).toBe(readableAccent("#ffd400", "dark"));

    // Back to dohc's own accent: the stylesheet's value applies again.
    applyLookSettings(settings({ appearance: { themeMode: "dark" } }));
    expect(property("--dohc-accent")).toBe("");
  });

  it("sets the editor font and size", () => {
    applyLookSettings(settings({ editor: { fontFamily: "serif", fontSize: 18 } }));
    expect(property("--dohc-editor-font")).toBe("var(--font-serif)");
    expect(property("--dohc-editor-font-size")).toBe("18px");

    // An installed font falls back to dohc's sans when this computer lacks it.
    applyLookSettings(settings({ editor: { fontFamily: "Iowan Old Style" } }));
    expect(property("--dohc-editor-font")).toBe('"Iowan Old Style", var(--font-sans)');
  });

  it("hands your colors to the avatars", () => {
    applyLookSettings(settings({ appearance: { yourColor: "teal", yourAgentColor: "plum" } }));
    expect(chosenHue("human")).toBe("teal");
    expect(chosenHue("agent")).toBe("plum");
    applyLookSettings(DEFAULT_USER_SETTINGS);
    expect(chosenHue("human")).toBeNull();
  });

  it("tells a look-only change from one the shell must render", () => {
    const read = (value: DesktopUserSettings) => ({ settings: value, source: "stored" as const });
    const base = read(DEFAULT_USER_SETTINGS);
    expect(differsOnlyInLook(base, read(settings({ appearance: { accentColor: "#224488" } })))).toBe(true);
    expect(differsOnlyInLook(base, read(settings({ editor: { fontSize: 20, fontFamily: "mono" } })))).toBe(true);
    // Line wrap and spellcheck change how the editor behaves, not how it looks.
    expect(differsOnlyInLook(base, read(settings({ editor: { lineWrap: false } })))).toBe(false);
    expect(differsOnlyInLook(base, read(settings({ editor: { spellcheck: false } })))).toBe(false);
    expect(differsOnlyInLook(base, read(settings({ profile: { preferredName: "Ada" } })))).toBe(false);
    expect(differsOnlyInLook(base, {
      ...read(DEFAULT_USER_SETTINGS),
      ignored: [{ key: "editor.fontSize", reason: "invalid" }],
    })).toBe(false);
  });
});
