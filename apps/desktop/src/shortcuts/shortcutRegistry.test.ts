import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { MENU_COMMANDS } from "../ipc/channels";
import { COMMAND_ROWS, type StaticCommandId } from "../renderer/commands/commandRows";
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
      expect(item.accelerator, id).toBe(shortcutAccelerators(id as StaticCommandId)[0]);
      labels[id] = item.label!;
    }
    const rowLabels = Object.fromEntries([...MENU_COMMANDS, ...Object.values(zoomIds)].map((id) => [
      id,
      id === "command-palette" ? "Command palette" : COMMAND_ROWS[id].label.replace(/^View: /, ""),
    ]));
    expect(labels).toEqual(rowLabels);
    expect(labels).toEqual({
      "new-file": "New file", "new-folder": "New folder", "new-collection": "New collection",
      "open-workspace": "Open workspace folder…", "import-files": "Import files",
      "export-workspace": "Export workspace as zip", "close-tab": "Close tab",
      "command-palette": "Command palette", "quick-open": "Go to", "new-editor-group-right": "New editor group right",
      "toggle-sidebar": "Toggle sidebar", "toggle-about": "Toggle About", "show-chats": "Chats",
      "toggle-theme": "Toggle light/dark theme", "zoom-reset": "Reset zoom", "zoom-in": "Zoom in", "zoom-out": "Zoom out",
      "settings": "Settings", "check-updates": "Check for updates", "install-update": "Update and restart",
    });
  });

  it("emits all aliases and disables native registration only for shell owners", () => {
    const row = SHORTCUTS["new-file"];
    const originalOwner = row.owner;
    const originalAccelerators = row.accelerators;
    Reflect.set(row, "owner", "document");
    Reflect.set(row, "accelerators", ["CommandOrControl+N", "CommandOrControl+Shift+N"]);
    try {
      const { items, sendCommand } = menu("win32");
      const matches = items.filter((item) => item.label?.startsWith("New file"));
      expect(matches.map((item) => item.accelerator)).toEqual(row.accelerators);
      expect(matches.map((item) => item.visible === false)).toEqual([false, true]);
      for (const item of matches) {
        expect(item.registerAccelerator).toBeUndefined();
        sendCommand.mockClear();
        item.click!(undefined!, undefined!, undefined!);
        expect(sendCommand).toHaveBeenCalledExactlyOnceWith(undefined, "new-file");
      }
    } finally {
      Reflect.set(row, "owner", originalOwner);
      Reflect.set(row, "accelerators", originalAccelerators);
    }
  });

  it("uses B2 command ids for palette actions and keeps the existing non-palette owners explicit", () => {
    const nonPalette = Object.entries(SHORTCUTS).filter(([id, row]) => !(id in COMMAND_ROWS) && row.owner !== "editor" && row.owner !== "history-restore").map(([id]) => id);
    expect(nonPalette.sort()).toEqual([
      "close-window", "command-palette", "dev-panel",
      "palette-accept", "palette-dismiss", "palette-move",
    ].sort());
    expect(shortcutAccelerators("show-chats")).toEqual([]);
  });
});

describe("existing shortcut display", () => {
  it("keeps each display-only hint aligned with its accelerator", () => {
    const canonical = (chord: string) => chord.toLowerCase().split(/[+ ]/).map((key) =>
      ["ctrl", "cmd", "commandorcontrol"].includes(key) ? "mod" : key,
    ).sort();
    const hints = Object.entries(SHORTCUTS).filter(([, row]) => "hint" in row);
    expect(hints.map(([id]) => id)).toEqual(["toggle-markdown-source", "editor-link"]);
    for (const [id, row] of hints) {
      if ("hint" in row) expect(canonical(row.hint), id).toEqual(canonical(row.accelerators[0]));
    }
  });
  it.each(["win32", "darwin", "linux"])("keeps the exact %s text", (platform) => {
    expect(shortcutText("quick-open", platform)).toBe(platform === "darwin" ? "⌘P" : "Ctrl P");
    for (const [id, key] of [["zoom-in", "="], ["zoom-out", "-"], ["zoom-reset", "0"]] as const) {
      expect(shortcutKeys(id, platform)).toEqual([platform === "darwin" ? "⌘" : "Ctrl", key]);
    }
    expect(shortcutText("toggle-markdown-source", platform)).toBe("Ctrl+/");
    expect(shortcutText("editor-link", platform)).toBe("Cmd+K");
    expect(shortcutText("dev-panel", platform)).toBe(platform === "darwin" ? "⇧⌘D" : "Ctrl Shift D");
    expect(shortcutText("command-palette", platform)).toBe(platform === "darwin" ? "⇧⌘P" : "Ctrl Shift P");
    expect(shortcutText("toggle-about", platform)).toBe(platform === "darwin" ? "⌥⌘B" : "Ctrl Alt B");
    expect(["palette-move", "palette-accept", "palette-dismiss"].map((id) => shortcutText(id as ShortcutId, platform))).toEqual(["↑↓", "↵", "esc"]);
  });
});
