// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { MENU_COMMANDS, isEditorMenuCommand } from "../ipc/channels";
import { COMMAND_ROWS, type StaticCommandId } from "../renderer/commands/commandRows";
import { buildMenuTemplate } from "../window/applicationMenu";
import {
  SHORTCUTS, hasPrimaryModifier, matchShellShortcut, matchShellShortcutChord, shortcutAccelerators, shortcutChords, shortcutKeys, shortcutText, shortcutTitle,
  type ShortcutId,
} from "./shortcutRegistry";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

function menu(platform: NodeJS.Platform) {
  const sendCommand = vi.fn();
  const stepZoom = vi.fn();
  const items = flatten(buildMenuTemplate({ isDev: false, platform, sendCommand, stepZoom, showAbout: vi.fn() }));
  return { items, sendCommand, stepZoom };
}

describe("shortcut menu contract", () => {
  it.each(["win32", "darwin", "linux"] as const)("derives every explicit %s menu accelerator, including aliases", (platform) => {
    const { items, sendCommand, stepZoom } = menu(platform);
    const expected: string[] = [];
    for (const [id, row] of Object.entries(SHORTCUTS)) {
      // macOS's Edit > Find also shows the editor's find keys.
      const findItem = platform === "darwin" && isEditorMenuCommand(id);
      if (row.owner !== "shell" && row.owner !== "main" && row.owner !== "native" && !findItem) continue;
      if ("platforms" in row && !(row.platforms as readonly string[]).includes(platform)) continue;
      for (const [index, accelerator] of shortcutAccelerators(id as ShortcutId, platform).entries()) {
        expected.push(accelerator);
        const matches = items.filter((item) => item.accelerator === accelerator);
        expect(matches, id).toHaveLength(1);
        const item = matches[0]!;
        if (row.owner === "shell" || findItem) {
          expect(MENU_COMMANDS).toContain(id);
          expect(item.registerAccelerator).toBe(false);
          sendCommand.mockClear();
          item.click!(undefined!, undefined!, undefined!);
          expect(sendCommand).toHaveBeenCalledExactlyOnceWith(undefined, id);
        } else if (row.owner === "main") {
          expect(item.registerAccelerator).toBeUndefined();
          stepZoom.mockClear();
          item.click!(undefined!, undefined!, undefined!);
          expect(stepZoom).toHaveBeenCalledExactlyOnceWith(id === "zoom-in" ? "in" : id === "zoom-out" ? "out" : "reset");
        } else {
          expect(item.role).toBe(id === "quit" ? "quit" : "close");
        }
        expect(item.visible === false).toBe(index > 0);
      }
    }
    expect(items.filter((item) => item.accelerator).map((item) => item.accelerator).sort()).toEqual(expected.sort());
  });

  it.each(["win32", "darwin"] as const)("labels every visible %s command item from its command row", (platform) => {
    const { items, sendCommand, stepZoom } = menu(platform);
    const zoomIds = { in: "zoom-in", out: "zoom-out", reset: "zoom-reset" } as const;
    const labels: Record<string, string> = {};
    for (const item of items.filter((entry) => entry.click && entry.visible !== false)) {
      sendCommand.mockClear();
      stepZoom.mockClear();
      item.click!(undefined!, undefined!, undefined!);
      const step = stepZoom.mock.calls[0]?.[0] as keyof typeof zoomIds | undefined;
      const id: string | undefined = sendCommand.mock.calls[0]?.[1] ?? (step && zoomIds[step]);
      if (id === undefined) {
        expect(item.label).toBe("About dohc");
        continue;
      }
      // macOS's Help menu repeats the palette without the keys View registers.
      const helpCopy = platform === "darwin" && id === "command-palette" && item.accelerator === undefined;
      expect(item.accelerator, id).toBe(helpCopy ? undefined : shortcutAccelerators(id as StaticCommandId, platform)[0]);
      labels[id] = item.label!;
    }
    // macOS's app menu marks Settings with the ellipsis of a command that opens a window.
    const settingsLabel = platform === "darwin" ? "Settings…" : "Settings";
    // Edit > Find, on macOS only, acts on the focused editor and has no rows.
    const findLabels = platform === "darwin" ? {
      "editor-find": "Find…", "editor-replace": "Find and replace…",
      "find-again-next": "Find next", "find-again-previous": "Find previous",
    } : {};
    const rowLabels = Object.fromEntries([...MENU_COMMANDS, ...Object.values(zoomIds)].flatMap((id) =>
      isEditorMenuCommand(id) ? [] : [[
        id,
        id === "command-palette" ? "Command palette" : id === "settings" ? settingsLabel : COMMAND_ROWS[id].label.replace(/^View: /, ""),
      ]]));
    expect(labels).toEqual({ ...rowLabels, ...findLabels });
    expect(labels).toEqual({
      ...findLabels,
      "new-file": "New file", "new-folder": "New folder", "new-collection": "New collection",
      "open-workspace": "Open workspace folder…", "import-files": "Import files",
      "export-workspace": "Export workspace as zip", "close-tab": "Close tab",
      "next-tab": "Show next tab", "previous-tab": "Show previous tab",
      "command-palette": "Command palette", "quick-open": "Go to", "new-editor-group-right": "New editor group right",
      "toggle-sidebar": "Toggle sidebar", "toggle-about": "Toggle About", "show-chats": "Chats",
      "toggle-theme": "Toggle light/dark theme", "zoom-reset": "Reset zoom", "zoom-in": "Zoom in", "zoom-out": "Zoom out",
      "settings": settingsLabel, "check-updates": "Check for updates", "install-update": "Update and restart",
    });
  });

  it("emits all aliases and leaves native registration only to main and native owners", () => {
    const row = SHORTCUTS["new-file"];
    const originalOwner = row.owner;
    const originalAccelerators = row.accelerators;
    Reflect.set(row, "accelerators", ["CommandOrControl+N", "CommandOrControl+Shift+N"]);
    try {
      for (const [owner, registerAccelerator] of [["main", undefined], ["native", undefined], ["document", false], ["editor", false]] as const) {
        Reflect.set(row, "owner", owner);
        const { items, sendCommand } = menu("win32");
        const matches = items.filter((item) => item.label?.startsWith("New file"));
        expect(matches.map((item) => item.accelerator)).toEqual(row.accelerators);
        expect(matches.map((item) => item.visible === false)).toEqual([false, true]);
        for (const item of matches) {
          expect(item.registerAccelerator, owner).toBe(registerAccelerator);
          sendCommand.mockClear();
          item.click!(undefined!, undefined!, undefined!);
          expect(sendCommand).toHaveBeenCalledExactlyOnceWith(undefined, "new-file");
        }
      }
    } finally {
      Reflect.set(row, "owner", originalOwner);
      Reflect.set(row, "accelerators", originalAccelerators);
    }
  });

  it("uses B2 command ids for palette actions and keeps the existing non-palette owners explicit", () => {
    const nonPalette = Object.entries(SHORTCUTS).filter(([id, row]) => !(id in COMMAND_ROWS) && row.owner !== "editor" && row.owner !== "history-restore").map(([id]) => id);
    expect(nonPalette.sort()).toEqual([
      "close-window", "quit", "command-palette", "dev-panel",
      "find-close", "find-next", "find-previous", "find-again-next", "find-again-previous",
      "palette-accept", "palette-dismiss", "palette-move",
    ].sort());
    expect(shortcutAccelerators("show-chats", "darwin")).toEqual([]);
  });
});

describe("shortcut display", () => {
  it.each(["win32", "darwin", "linux"])("keeps the exact %s text", (platform) => {
    const mac = platform === "darwin";
    expect(shortcutText("quick-open", platform)).toBe(mac ? "⌘P" : "Ctrl P");
    for (const [id, key] of [["zoom-in", "="], ["zoom-out", "-"], ["zoom-reset", "0"]] as const) {
      expect(shortcutKeys(id, platform)).toEqual([mac ? "⌘" : "Ctrl", key]);
    }
    expect(shortcutText("dev-panel", platform)).toBe(mac ? "⇧⌘D" : "Ctrl Shift D");
    expect(shortcutText("command-palette", platform)).toBe(mac ? "⇧⌘P" : "Ctrl Shift P");
    expect(shortcutText("toggle-about", platform)).toBe(mac ? "⌥⌘B" : "Ctrl Alt B");
    expect(shortcutText("editor-replace", platform)).toBe(mac ? "⌥⌘F" : "Ctrl H");
    expect(["palette-move", "palette-accept", "palette-dismiss"].map((id) => shortcutText(id as ShortcutId, platform)))
      .toEqual(["↑↓", mac ? "↩" : "↵", "esc"]);
  });

  it.each(["win32", "darwin", "linux"])("writes %s chords for tooltips", (platform) => {
    const mac = platform === "darwin";
    expect(shortcutTitle("toggle-markdown-source", platform)).toBe(mac ? "⌘/" : "Ctrl+/");
    expect(shortcutTitle("editor-link", platform)).toBe(mac ? "⌘K" : "Ctrl+K");
    expect(shortcutTitle("dev-panel", platform)).toBe(mac ? "⇧⌘D" : "Ctrl+Shift+D");
    expect(["find-previous", "find-next", "find-close"].map((id) => shortcutTitle(id as ShortcutId, platform)))
      .toEqual(mac ? ["⇧↩", "↩", "esc"] : ["Shift+Enter", "Enter", "Esc"]);
  });

  it.each(["win32", "darwin", "linux"])("draws each of a row's %s chords", (platform) => {
    const mac = platform === "darwin";
    expect(shortcutChords("command-palette", platform)).toEqual(mac ? [["⇧", "⌘", "P"], ["⌘", "K"]] : [["Ctrl", "Shift", "P"], ["Ctrl", "K"]]);
    expect(shortcutChords("zoom-in", platform)).toEqual(mac ? [["⌘", "="], ["⌘", "+"], ["⌘", "Num +"]] : [["Ctrl", "="], ["Ctrl", "+"], ["Ctrl", "Num +"]]);
    expect(shortcutChords("next-tab", platform)).toEqual(mac ? [["⌃", "Tab"], ["⇧", "⌘", "]"]] : [["Ctrl", "Tab"], ["Ctrl", "Page Down"]]);
    expect(shortcutChords("editor-backspace-word", platform)).toEqual([mac ? ["⌘", "⌫"] : ["Ctrl", "Backspace"]]);
    // A row's keys stand for its first chord in a chip; every chord shows on its own.
    expect(shortcutChords("palette-move", platform)).toEqual([["↑"], ["↓"]]);
    expect(shortcutChords("palette-dismiss", platform)).toEqual([[mac ? "esc" : "Esc"]]);
  });

  it("answers another layout's name for a chord without listing it", () => {
    for (const platform of ["win32", "darwin"]) {
      expect(shortcutAccelerators("editor-undo", platform)).toEqual(["CommandOrControl+Z", "CommandOrControl+Я"]);
      expect(shortcutChords("editor-undo", platform)).toEqual([[platform === "darwin" ? "⌘" : "Ctrl", "Z"]]);
      expect(shortcutChords("editor-redo", platform).map((keys) => keys.at(-1))).toEqual(["Z", "Y"]);
    }
  });

  it("gives Replace ⌥⌘F on macOS, where ⌘H hides the app", () => {
    expect(shortcutAccelerators("editor-replace", "darwin")).toEqual(["CommandOrControl+Alt+F"]);
    expect(shortcutAccelerators("editor-replace", "win32")).toEqual(["CommandOrControl+H"]);
    expect(shortcutAccelerators("editor-replace", "linux")).toEqual(["CommandOrControl+H"]);
  });
});

describe("shell shortcut matching", () => {
  const press = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });

  it.each([
    ["darwin", { metaKey: true }, { ctrlKey: true }],
    ["win32", { ctrlKey: true }, { metaKey: true }],
    ["linux", { ctrlKey: true }, { metaKey: true }],
  ] as const)("takes only the %s primary modifier", (platform, primary, other) => {
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: false, ...primary }, platform)).toBe(true);
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: false, ...other }, platform)).toBe(false);
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: true }, platform)).toBe(false);
    for (const [key, id] of [["n", "new-file"], ["p", "quick-open"], ["k", "command-palette"], ["b", "toggle-sidebar"],
      ["w", "close-tab"], [",", "settings"], ["\\", "new-editor-group-right"], ["z", "history-restore-undo"]] as const) {
      expect(matchShellShortcut(press(key, primary), platform), key).toBe(id);
      expect(matchShellShortcutChord(press(key, primary), platform), key).toBe(id);
      expect(matchShellShortcut(press(key, other), platform), key).toBeNull();
      expect(matchShellShortcutChord(press(key, other), platform), key).toBeNull();
      expect(matchShellShortcut(press(key, { metaKey: true, ctrlKey: true }), platform), key).toBeNull();
    }
  });

  it.each([
    ["darwin", [
      [{ key: "Tab", ctrlKey: true }, "next-tab"],
      [{ key: "Tab", ctrlKey: true, shiftKey: true }, "previous-tab"],
      // Shift turns ] into } on the key it reports.
      [{ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }, "next-tab"],
      [{ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }, "previous-tab"],
      [{ key: "Tab", metaKey: true }, null],
      [{ key: "PageDown", ctrlKey: true }, null],
      [{ key: "]", code: "BracketRight", ctrlKey: true, shiftKey: true }, null],
    ]],
    ...(["win32", "linux"] as const).map((platform) => [platform, [
      [{ key: "Tab", ctrlKey: true }, "next-tab"],
      [{ key: "Tab", ctrlKey: true, shiftKey: true }, "previous-tab"],
      [{ key: "PageDown", ctrlKey: true }, "next-tab"],
      [{ key: "PageUp", ctrlKey: true }, "previous-tab"],
      [{ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }, null],
      [{ key: "Tab", metaKey: true }, null],
    ]] as const),
  ] as const)("switches tabs with the %s chords", (platform, chords) => {
    for (const [init, id] of chords) {
      expect(matchShellShortcut(press(init.key, init), platform), JSON.stringify(init)).toBe(id);
    }
  });

  it("leaves a tab chord to the control that claimed it", () => {
    const claimed = press("Tab", { ctrlKey: true, cancelable: true });
    claimed.preventDefault();
    expect(matchShellShortcut(claimed, "darwin")).toBeNull();
    expect(matchShellShortcut(claimed, "win32")).toBeNull();
  });

  it("matches ⌥⌘B by its physical key only on macOS", () => {
    const optionB = { key: "∫", code: "KeyB", altKey: true };
    expect(matchShellShortcut(press(optionB.key, { ...optionB, metaKey: true }), "darwin")).toBe("toggle-about");
    expect(matchShellShortcut(press(optionB.key, { ...optionB, ctrlKey: true }), "win32")).toBeNull();
  });
});
