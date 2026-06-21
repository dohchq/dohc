import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { basename } from "node:path";
import type { MenuCommand, WorkspaceSummary } from "../ipc/bridgeContract";

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
  recentWorkspaces?: WorkspaceSummary[];
  sendCommand: (window: BrowserWindow | undefined, command: MenuCommand) => void;
  openRecentWorkspace?: (
    window: BrowserWindow | undefined,
    workspace: WorkspaceSummary,
  ) => void;
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
  const recentWorkspaces = (options.recentWorkspaces ?? []).slice(0, 10);
  const recentLabel = (workspace: WorkspaceSummary): string => {
    const leaf = basename(workspace.rootPath);
    return leaf.length > 0 ? leaf : workspace.rootPath;
  };

  return [
    ...(isMac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        command("New File", "new-file", "CommandOrControl+N"),
        command("New Folder…", "new-folder"),
        { type: "separator" },
        command("Open Workspace…", "open-workspace"),
        {
          label: "Open Recent",
          submenu:
            recentWorkspaces.length > 0
              ? recentWorkspaces.map((workspace) => ({
                  label: recentLabel(workspace),
                  sublabel: workspace.rootPath,
                  click: (_item, window) =>
                    options.openRecentWorkspace?.(
                      window as BrowserWindow | undefined,
                      workspace,
                    ),
                }))
              : [{ label: "No Recent Workspaces", enabled: false }],
        },
        command("Data Fragments…", "import-export"),
        command("Import Files…", "import-files"),
        command("Export Workspace as Zip…", "export-workspace"),
        { type: "separator" },
        command("Close Tab", "close-tab", "CommandOrControl+W"),
        // VS Code convention: Ctrl+W closes the TAB (renderer-owned above),
        // so the close role must not keep its DEFAULT Ctrl+W accelerator —
        // it would close the whole window on every tab close.
        { role: "close", label: "Close Window", accelerator: "CommandOrControl+Shift+W" },
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
      submenu: [
        command("Check for Updates…", "check-updates"),
        command("Update and Restart", "install-update"),
        { type: "separator" },
        { label: "About dohc", click: () => options.showAbout() },
      ],
    },
  ];
}
