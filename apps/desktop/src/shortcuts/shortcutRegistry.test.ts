import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { MENU_COMMANDS } from "../ipc/channels";
import { COMMAND_ROWS } from "../renderer/commands/commandRows";
import { buildMenuTemplate } from "../window/applicationMenu";
import { SHORTCUTS, shortcutAccelerators, shortcutKeys, shortcutText, type ShortcutId } from "./shortcutRegistry";

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
  it.each(["win32", "darwin"] as const)("derives every explicit %s menu accelerator, including aliases", (platform) => {
    const { items, sendCommand, stepZoom } = menu(platform);
    const expected: string[] = [];
    for (const [id, row] of Object.entries(SHORTCUTS)) {
      if (row.owner !== "shell" && row.owner !== "main" && row.owner !== "native") continue;
      if (id === "history-restore-undo") continue;
      for (const [index, accelerator] of row.accelerators.entries()) {
        expected.push(accelerator);
        const matches = items.filter((item) => item.accelerator === accelerator);
        expect(matches, id).toHaveLength(1);
        const item = matches[0]!;
        if (row.owner === "shell") {
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
          expect(item.role).toBe("close");
        }
        expect(item.visible === false).toBe(index > 0);
      }
    }
    expect(items.filter((item) => item.accelerator).map((item) => item.accelerator).sort()).toEqual(expected.sort());
  });

  it("uses B2 command ids for palette actions and keeps the existing non-palette owners explicit", () => {
    const nonPalette = Object.entries(SHORTCUTS).filter(([id, row]) => !(id in COMMAND_ROWS) && row.owner !== "editor").map(([id]) => id);
    expect(nonPalette.sort()).toEqual([
      "close-window", "command-palette", "dev-panel",
      "history-restore-undo", "palette-accept", "palette-dismiss", "palette-move",
    ].sort());
    expect(shortcutAccelerators("show-chats")).toEqual([]);
  });
});

describe("existing shortcut display", () => {
  it.each(["win32", "darwin", "linux"])("keeps the exact %s text", (platform) => {
    expect(shortcutText("quick-open", platform)).toBe(platform === "darwin" ? "⌘P" : "Ctrl P");
    for (const [id, key] of [["zoom-in", "="], ["zoom-out", "-"], ["zoom-reset", "0"]] as const) {
      expect(shortcutKeys(id, platform)).toEqual([platform === "darwin" ? "⌘" : "Ctrl", key]);
    }
    expect(shortcutText("toggle-markdown-source", platform)).toBe("Ctrl+/");
    expect(shortcutText("editor-link", platform)).toBe("Cmd+K");
    expect(shortcutText("dev-panel", platform)).toBe("Ctrl Shift D");
    expect(["palette-move", "palette-accept", "palette-dismiss"].map((id) => shortcutText(id as ShortcutId, platform))).toEqual(["↑↓", "↵", "esc"]);
  });
});
