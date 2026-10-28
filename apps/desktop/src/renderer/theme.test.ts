// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../settings/userSettings";
import { settingsWithAgent, testAgent } from "../testing/agentSettings";
import { deferred } from "../testing/deferred";
import { readableAccent } from "./accentColor";
import { applyLookSettings, differsOnlyInLook, initTheme } from "./theme";
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
    expect(property("--dohc-editor-number-suffix")).toBe("");

    // The mono font's list numbers have a wider period and space.
    applyLookSettings(settings({ editor: { fontFamily: "mono" } }));
    expect(property("--dohc-editor-number-suffix")).toBe("2");

    // An installed font falls back to dohc's sans when this computer lacks it.
    applyLookSettings(settings({ editor: { fontFamily: "Iowan Old Style" } }));
    expect(property("--dohc-editor-font")).toBe('"Iowan Old Style", var(--font-sans)');
    expect(property("--dohc-editor-number-suffix")).toBe("");
  });

  it("measures whether an installed editor font is monospaced", () => {
    // A canvas where a period is as wide as a zero only in Consolas.
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        const context = {
          font: "",
          measureText: (text: string) => ({ width: text === "." && !context.font.includes('"Consolas"') ? 4 : 10 }),
        };
        return context;
      }
    });
    try {
      applyLookSettings(settings({ editor: { fontFamily: "Consolas" } }));
      expect(property("--dohc-editor-number-suffix")).toBe("2");
      applyLookSettings(settings({ editor: { fontFamily: "Georgia" } }));
      expect(property("--dohc-editor-number-suffix")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hands your colors to the avatars", () => {
    applyLookSettings({ ...settingsWithAgent({ hue: "plum" }), appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "teal" } });
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
    // dohc uses the agents in the order the file lists them.
    const claude = testAgent({ name: "Claude Code" }), codex = testAgent({ name: "Codex" });
    expect(differsOnlyInLook(
      read({ ...DEFAULT_USER_SETTINGS, agents: { default: claude, codex } }),
      read({ ...DEFAULT_USER_SETTINGS, agents: { codex, default: claude } }),
    )).toBe(false);
  });
});

describe("the startup read of the settings file", () => {
  const read = (value: DesktopUserSettings): DesktopUserSettingsResult =>
    ({ settings: value, source: "stored" });
  const accepted = settings({
    appearance: { themeMode: "dark", accentColor: "#ffd400", yourColor: "teal" },
    editor: { fontFamily: "serif", fontSize: 18 },
  });

  // Starts the theme with the startup read held open and the system
  // preference under the test's control.
  function start(systemDark: boolean) {
    const startup = deferred<DesktopUserSettingsResult>();
    const setTitlebarTheme = vi.fn(async (_request: { theme: "light" | "dark" }) => undefined);
    const changes = new Set<() => void>();
    const system = {
      matches: systemDark,
      addEventListener: (_type: "change", listener: () => void) => changes.add(listener),
    };
    vi.stubGlobal("matchMedia", () => system);
    vi.stubGlobal("dohcDesktop", { getUserSettings: () => startup.promise, setTitlebarTheme });
    initTheme();
    const prefer = (dark: boolean) => {
      system.matches = dark;
      for (const listener of changes) listener();
    };
    return { startup, setTitlebarTheme, prefer };
  }

  // The look initTheme's read lands is in place once the read's own promise
  // has settled for every earlier listener.
  async function answer(startup: ReturnType<typeof start>["startup"], value: DesktopUserSettings) {
    startup.resolve(read(value));
    await startup.promise;
  }

  function expectAcceptedLook(setTitlebarTheme: ReturnType<typeof start>["setTitlebarTheme"]) {
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(setTitlebarTheme).toHaveBeenLastCalledWith({ theme: "dark" });
    expect(property("--dohc-accent")).toBe(readableAccent("#ffd400", "dark"));
    expect(property("--dohc-editor-font")).toBe("var(--font-serif)");
    expect(property("--dohc-editor-font-size")).toBe("18px");
    expect(chosenHue("human")).toBe("teal");
  }

  afterEach(() => vi.unstubAllGlobals());

  it("applies what the file says when nothing newer arrived first", async () => {
    const { startup, setTitlebarTheme } = start(false);
    expect(document.documentElement.dataset.theme).toBe("light");

    await answer(startup, accepted);
    expectAcceptedLook(setTitlebarTheme);
  });

  it("keeps a newer accepted look when it answers late", async () => {
    const { startup, setTitlebarTheme } = start(false);
    applyLookSettings(accepted);

    await answer(startup, settings({ appearance: { themeMode: "light" } }));
    expectAcceptedLook(setTitlebarTheme);
  });

  it("leaves the window following the system when a newer accepted look chose it", async () => {
    const { startup, prefer } = start(false);
    applyLookSettings(settings({ appearance: { themeMode: "system" } }));

    await answer(startup, settings({ appearance: { themeMode: "light" } }));
    expect(document.documentElement.dataset.theme).toBe("light");
    prefer(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
