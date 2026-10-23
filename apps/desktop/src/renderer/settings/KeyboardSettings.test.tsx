// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortcutName, shownShortcutNames } from "../../shortcuts/shortcutNames";
import { SHORTCUTS, shortcutChords, type ShortcutId } from "../../shortcuts/shortcutRegistry";
import { KeyboardSettings, keyboardGroups } from "./KeyboardSettings";

afterEach(cleanup);

const IDS = Object.keys(SHORTCUTS) as ShortcutId[];
const answers = (platform: string) => IDS.filter((id) => {
  const row = SHORTCUTS[id];
  return !("platforms" in row) || (row.platforms as readonly string[]).includes(platform);
});
const MAC_ONLY = IDS.filter((id) => !answers("win32").includes(id) && !answers("linux").includes(id));
const chordText = (keys: readonly string[]) => keys.join(" ");
const listed = (platform: string, devTools = true) =>
  keyboardGroups(platform, devTools).flatMap(({ heading, rows }) =>
    rows.flatMap((row) => row.chords.map((keys) => `${heading} | ${row.name} | ${chordText(keys)}`)));
// Each "Heading: Name" a chord shows under.
const meaning = (platform: string, chord: string) =>
  listed(platform).filter((row) => row.endsWith(` | ${chord}`)).map((row) => row.split(" | ").slice(0, 2).join(": "));

describe("keyboard settings", () => {
  it.each(["win32", "darwin", "linux"])("lists every shortcut %s answers, by its name, with each of its chords", (platform) => {
    const rows = listed(platform);
    for (const id of answers(platform)) {
      expect(shortcutName(id), id).not.toBe("");
      for (const keys of shortcutChords(id, platform)) {
        expect(rows.filter((row) => row.endsWith(` | ${shortcutName(id)} | ${chordText(keys)}`)), id).toHaveLength(1);
      }
    }
    expect(rows).toHaveLength(answers(platform).reduce((count, id) => count + shortcutChords(id, platform).length, 0));
  });

  it("lists Quit where a menu answers it: macOS and Linux, not Windows", () => {
    expect(meaning("darwin", "⌘ Q")).toEqual(["Workbench: Quit"]);
    expect(meaning("linux", "Ctrl Q")).toEqual(["Workbench: Quit"]);
    expect(meaning("win32", "Ctrl Q")).toEqual([]);
  });

  it.each(["win32", "darwin", "linux"])("keeps each %s row's keys to one place, and each chord to one row under its heading", (platform) => {
    for (const { heading, rows } of keyboardGroups(platform, true)) {
      // One owner answers every key in a row, so its keys all work where the heading says.
      for (const row of rows) expect(new Set(row.ids.map((id) => SHORTCUTS[id].owner)).size, `${heading}: ${row.name}`).toBe(1);
      const chords = rows.flatMap((row) => row.chords.map(chordText));
      expect(new Set(chords).size, heading).toBe(chords.length);
    }
    // The only rows that join shortcuts are macOS's deletion keys, which the document's editor answers.
    const joined = keyboardGroups(platform, true).flatMap(({ rows }) => rows.filter((row) => row.ids.length > 1));
    expect(joined.map((row) => `${row.name}: ${row.ids.join(", ")}`)).toEqual(platform === "darwin"
      ? ["Delete backward: editor-backspace-word, editor-mac-backspace", "Delete forward: editor-delete-word, editor-mac-delete"]
      : []);
  });

  it("says where a chord with two meanings works", () => {
    expect(meaning("win32", "Ctrl B")).toEqual(["Workbench: Toggle sidebar", "Document: Bold"]);
    expect(meaning("win32", "Ctrl K")).toEqual(["Workbench: Command palette", "Document: Link"]);
    expect(meaning("darwin", "⌘ Z")).toEqual(["Workbench: Undo restore", "Document: Undo"]);
    expect(meaning("win32", "Esc")).toEqual(["Find field: Close find", "Command palette and Go to: Dismiss"]);
  });

  it("tells the find field's Enter from Find next's F3, which works from the document", () => {
    for (const [platform, enter] of [["win32", "Enter"], ["darwin", "↩"]] as const) {
      expect(meaning(platform, enter)).toEqual(["Find field: Next match", "Command palette and Go to: Open"]);
      expect(meaning(platform, platform === "darwin" ? "⇧ ↩" : "Shift Enter")).toEqual(["Find field: Previous match"]);
    }
    expect(meaning("win32", "F3")).toEqual(["Document: Find next"]);
    expect(meaning("win32", "Shift F3")).toEqual(["Document: Find previous"]);
    expect(meaning("darwin", "⌘ G")).toEqual(["Document: Find next"]);
    expect(meaning("darwin", "⇧ ⌘ G")).toEqual(["Document: Find previous"]);
  });

  it("shows macOS's own editing keys only on macOS", () => {
    for (const platform of ["win32", "linux"]) {
      const rows = listed(platform);
      expect(rows.some((row) => row.includes("Move to paragraph"))).toBe(false);
      for (const id of MAC_ONLY) {
        for (const keys of shortcutChords(id, platform)) {
          expect(rows.some((row) => row.endsWith(` | ${shortcutName(id)} | ${chordText(keys)}`)), id).toBe(false);
        }
      }
    }
    expect(listed("darwin")).toEqual(expect.arrayContaining([
      "Document | Delete backward | ⌘ ⌫", "Document | Delete backward | ⌃ H", "Document | Delete backward | ⌥ ⌫",
      "Document | Move to paragraph start | ⌃ A",
    ]));
  });

  it("draws macOS keys as symbols and others as words", () => {
    const words = /^(?:Ctrl|Alt|Shift|CommandOrControl|Enter|Escape|Backspace|Delete)$/;
    const keys = keyboardGroups("darwin", true).flatMap(({ rows }) => rows.flatMap((row) => row.chords.flat()));
    expect(keys.filter((key) => words.test(key))).toEqual([]);
    expect(listed("darwin")).toEqual(expect.arrayContaining([
      "Workbench | Command palette | ⇧ ⌘ P", "Workbench | Toggle About | ⌥ ⌘ B", "Find field | Close find | esc",
    ]));
    expect(listed("win32")).toEqual(expect.arrayContaining([
      "Workbench | Command palette | Ctrl Shift P", "Workbench | Show next tab | Ctrl Page Down",
      "Workbench | Zoom in | Ctrl Num +", "Find field | Close find | Esc",
    ]));
  });

  it("lists the dev tools' key only where the dev tools show", () => {
    expect(listed("win32", true)).toContain("Workbench | Dev tools | Ctrl Shift D");
    expect(listed("win32", false).some((row) => row.includes("Dev tools"))).toBe(false);
  });

  it("draws each heading over its rows, and each chord's keys as chips", () => {
    render(<KeyboardSettings platform="win32" devTools={false} />);
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent))
      .toEqual(["Workbench", "Document", "Find field", "Command palette and Go to"]);
    const palette = screen.getByText("Command palette").closest("section")!.querySelector("kbd")!.parentElement!.parentElement!;
    expect([...palette.children].map((chord) => [...chord.querySelectorAll("kbd")].map((key) => key.textContent)))
      .toEqual([["Ctrl", "Shift", "P"], ["Ctrl", "K"]]);
    // A screen reader hears the second chord as another way, not more keys.
    expect(palette.textContent).toBe("CtrlShiftPorCtrlK");
    expect(within(palette).getByText("or").className).toContain("sr-only");
  });
});

describe("Settings search for shortcuts", () => {
  it.each([["win32", false], ["darwin", true], ["linux", true]] as const)("knows the names the %s page lists, and no others", (platform, devTools) => {
    const listedNames = keyboardGroups(platform, devTools).flatMap(({ rows }) => rows.map((row) => row.name));
    expect(shownShortcutNames(platform, devTools).sort()).toEqual([...new Set(listedNames)].sort());
  });

  it.each([["win32", false], ["darwin", true]] as const)("reads the %s renderer's names into the Keyboard section at load", async (platform, devTools) => {
    vi.stubGlobal("dohcDesktop", { platform, devTools });
    vi.resetModules();
    try {
      const { SETTINGS_SECTIONS } = await import("./settingsRegistry");
      const keywords: readonly string[] = SETTINGS_SECTIONS.find((section) => section.id === "keyboard")!.keywords;
      expect(keywords).toEqual(["keyboard", "shortcut", "shortcuts", "keys", ...shownShortcutNames(platform, devTools)]);
      expect(keywords.includes("Move to paragraph start")).toBe(platform === "darwin");
      expect(keywords.includes("Dev tools")).toBe(devTools);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
