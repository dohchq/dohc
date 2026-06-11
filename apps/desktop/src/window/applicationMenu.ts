import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../ipc/bridgeContract";

// Real application menu (File/Edit/View/Go/Help). Custom items SEND a
// MenuCommand to the focused window's renderer, where the shell routes it
// through the same command registry the palette uses — the menu owns no
// action logic of its own. Pure template builder so the structure is
// unit-testable without Electron.
//
// registerAccelerator:false on renderer-owned shortcuts: the shell already
// binds Ctrl+N/P/Shift+P/B in keydown handlers; the menu DISPLAYS the
// accelerator but must not register it, or one keypress would fire twice
// (menu command + renderer toggle = net no-op). The option is Windows/Linux
// only — on macOS the accelerators register as key equivalents regardless,
// which is the correct single-fire path there (the menu consumes the
// keystroke before the renderer keydown ever sees it).
export function buildMenuTemplate(options: {
  isDev: boolean;
  platform: NodeJS.Platform;
  sendCommand: (window: BrowserWindow | undefined, command: MenuCommand) => void;
  showAbout: () => void;
}): MenuItemConstructorOptions[] {
  const command = (
    label: string,
    name: MenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    click: (_item, window) =>
      options.sendCommand(window as BrowserWindow | undefined, name),
  });

  // macOS renders the FIRST template entry as the application menu (label
  // replaced by the app name); without an explicit appMenu role, "File"
  // would be swallowed into it and Quit/Hide/Services would be missing.
  const isMac = options.platform === "darwin";

  return [
    ...(isMac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        command("New File", "new-file", "CommandOrControl+N"),
        command("New Folder…", "new-folder"),
        { type: "separator" },
        command("Open Workspace…", "open-workspace"),
        command("Import Files…", "import-files"),
        { type: "separator" },
        { role: "close", label: "Close Window" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        command("Command Palette", "command-palette", "CommandOrControl+Shift+P"),
        command("Quick Open", "quick-open", "CommandOrControl+P"),
        { type: "separator" },
        command("Toggle Sidebar", "toggle-sidebar", "CommandOrControl+B"),
        command("Toggle Theme", "toggle-theme"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        // Dev only: a packaged everyday-people app has no devtools menu item.
        ...(options.isDev
          ? [{ type: "separator" }, { role: "toggleDevTools" }] as const
          : []),
      ],
    },
    {
      label: "Go",
      submenu: [command("Settings", "settings")],
    },
    // Standard macOS Window menu (minimize/zoom/front + window list).
    ...(isMac ? [{ role: "windowMenu" } as const] : []),
    {
      label: "Help",
      submenu: [{ label: "About dohc", click: () => options.showAbout() }],
    },
  ];
}
