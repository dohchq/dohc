// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shortcutName } from "../../shortcuts/shortcutNames";
import { SHORTCUTS, shortcutChords, type ShortcutId } from "../../shortcuts/shortcutRegistry";
import { KeyboardSettings, keyboardGroups } from "./KeyboardSettings";

afterEach(cleanup);

const IDS = Object.keys(SHORTCUTS) as ShortcutId[];
const MAC_ONLY = IDS.filter((id) => "platform" in SHORTCUTS[id]);
const chordText = (keys: readonly string[]) => keys.join(" ");
const listed = (platform: string, devTools = true) =>
  keyboardGroups(platform, devTools).flatMap(({ heading, rows }) =>
    rows.flatMap((row) => row.chords.map((keys) => `${heading} | ${row.name} | ${chordText(keys)}`)));

describe("keyboard settings", () => {
  it.each(["win32", "darwin", "linux"])("lists every shortcut %s answers, by its name, with each of its chords", (platform) => {
    const rows = listed(platform);
    for (const id of IDS.filter((id) => platform === "darwin" || !MAC_ONLY.includes(id))) {
      expect(shortcutName(id), id).not.toBe("");
      for (const keys of shortcutChords(id, platform)) {
        expect(rows.filter((row) => row.endsWith(` | ${shortcutName(id)} | ${chordText(keys)}`)), id).toHaveLength(1);
      }
    }
    expect(rows).toHaveLength(IDS.filter((id) => platform === "darwin" || !MAC_ONLY.includes(id))
      .reduce((count, id) => count + shortcutChords(id, platform).length, 0));
  });

  it.each(["win32", "darwin", "linux"])("gives each %s chord one meaning under its heading", (platform) => {
    for (const { heading, rows } of keyboardGroups(platform, true)) {
      const chords = rows.flatMap((row) => row.chords.map(chordText));
      expect(new Set(chords).size, heading).toBe(chords.length);
    }
  });

  it("says where a chord with two meanings works", () => {
    const meaning = (platform: string, chord: string) =>
      listed(platform).filter((row) => row.endsWith(` | ${chord}`)).map((row) => row.split(" | ").slice(0, 2).join(": "));
    expect(meaning("win32", "Ctrl B")).toEqual(["Workbench: Toggle sidebar", "Document: Bold"]);
    expect(meaning("win32", "Ctrl K")).toEqual(["Workbench: Command palette", "Document: Link"]);
    expect(meaning("darwin", "⌘ Z")).toEqual(["Workbench: Undo restore", "Document: Undo"]);
    expect(meaning("win32", "Enter")).toEqual(["Find: Find next", "Command palette and Go to: Open"]);
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
      "Workbench | Command palette | ⇧ ⌘ P", "Workbench | Toggle About | ⌥ ⌘ B", "Find | Close find | esc",
    ]));
    expect(listed("win32")).toEqual(expect.arrayContaining([
      "Workbench | Command palette | Ctrl Shift P", "Workbench | Show next tab | Ctrl Page Down",
      "Workbench | Zoom in | Ctrl Num +", "Find | Close find | Esc",
    ]));
  });

  it("lists the dev tools' key only where the dev tools show", () => {
    expect(listed("win32", true)).toContain("Workbench | Dev tools | Ctrl Shift D");
    expect(listed("win32", false).some((row) => row.includes("Dev tools"))).toBe(false);
  });

  it("draws each heading over its rows, and each chord's keys as chips", () => {
    render(<KeyboardSettings platform="win32" devTools={false} />);
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent))
      .toEqual(["Workbench", "Document", "Find", "Command palette and Go to"]);
    const palette = screen.getByText("Command palette").closest("section")!.querySelector("kbd")!.parentElement!.parentElement!;
    expect([...palette.children].map((chord) => [...chord.querySelectorAll("kbd")].map((key) => key.textContent)))
      .toEqual([["Ctrl", "Shift", "P"], ["Ctrl", "K"]]);
    // A screen reader hears the second chord as another way, not more keys.
    expect(palette.textContent).toBe("CtrlShiftPorCtrlK");
    expect(within(palette).getByText("or").className).toContain("sr-only");
  });
});
