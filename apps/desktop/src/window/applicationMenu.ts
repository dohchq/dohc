import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { SHORTCUTS, shortcutAccelerators, type ShortcutId } from "../shortcuts/shortcutRegistry";
import { shortcutName } from "../shortcuts/shortcutNames";
import { basename } from "node:path";
import type { MenuCommand, WorkspaceSummary } from "../ipc/bridgeContract";
import { COMMAND_ROWS, isStaticCommandId, type StaticCommandId } from "../renderer/commands/commandRows";
import type { ZoomStep } from "../settings/userSettings";

// Each item's label is its palette row's label, so the menu and the palette
// cannot disagree. The menu already groups by category, so "View: Chats" shows
// as "Chats". The palette does not list itself, and macOS's Edit > Find items
// act on the editor that has focus, which the palette would take, so neither
// has a row: they take their shortcut's name. macOS adds the ellipsis of a
// command that asks for more: Settings… in the app menu, and Find… and Find
// and replace…, which open the find bar.
function menuLabel(id: MenuCommand | StaticCommandId): string {
  if (isStaticCommandId(id)) return COMMAND_ROWS[id].label.replace(/^View: /, "");
  return id === "editor-find" || id === "editor-replace" ? `${shortcutName(id)}…` : shortcutName(id);
}

// Real application menu (File/Edit/View/Go/Help on Windows and Linux; the
// app menu, File/Edit/View/Window/Help on macOS). Custom items send a
// MenuCommand to the focused window's renderer, where the shell routes it
// through the same command registry the palette uses, or hands an Edit >
// Find item to the editor that has focus — the menu owns no action logic of
// its own. Pure template builder so the structure is unit-testable without
// Electron.
//
// registerAccelerator:false on renderer-owned shortcuts lets Windows/Linux
// display the accelerator without registering a second owner. Electron treats
// the option as Windows/Linux-only. On macOS the same accelerator becomes the
// native unhandled fallback: a focused editor can keep the chord with
// preventDefault, and the menu routes only a chord the renderer did not claim.
export function buildMenuTemplate(options: {
  isDev: boolean;
  platform: NodeJS.Platform;
  recentWorkspaces?: WorkspaceSummary[];
  canInstallUpdate?: boolean;
  sendCommand: (window: BrowserWindow | undefined, command: MenuCommand) => void;
  // Zoom is main-owned so its accelerators keep working on windows that
  // never mount the workspace shell (first run, a broken registry).
  stepZoom: (step: ZoomStep) => void;
  openRecentWorkspace?: (
    window: BrowserWindow | undefined,
    workspace: WorkspaceSummary,
  ) => void;
  // Windows and Linux. macOS shows its own About panel.
  showAbout: () => void;
}): MenuItemConstructorOptions[] {
  const isMac = options.platform === "darwin";
  // keys: false shows a command a second time without its accelerators,
  // which macOS would otherwise register a second time.
  const command = (
    name: MenuCommand,
    { enabled = true, label = menuLabel(name), keys = true } = {},
  ): MenuItemConstructorOptions[] => {
    const accelerators = keys ? shortcutAccelerators(name, options.platform) : [];
    return (accelerators.length ? accelerators : [undefined]).map((accelerator, index) => ({
      label: index > 0 ? label + " (alternate)" : label,
      enabled,
      ...(index > 0 ? { visible: false } : {}),
      ...(accelerator ? { accelerator } : {}),
      ...(accelerator && !["main", "native"].includes(SHORTCUTS[name as ShortcutId]?.owner)
        ? { registerAccelerator: false } : {}),
      click: (_item, window) =>
        options.sendCommand(window as BrowserWindow | undefined, name),
    }));
  };

  const recentWorkspaces = (options.recentWorkspaces ?? []).slice(0, 10);
  const recentLabel = (workspace: WorkspaceSummary): string => {
    const leaf = basename(workspace.rootPath);
    return leaf.length > 0 ? leaf : workspace.rootPath;
  };
  const updates = [
    ...command("check-updates"),
    ...command("install-update", { enabled: options.canInstallUpdate === true }),
  ];

  // macOS renders the first template entry as the application menu, titled
  // with the app's name. It holds About, updates, Settings, and the system's
  // Services, Hide, and Quit. The labels name dohc, not app.name, which names
  // the package or Electron in an unpackaged run.
  const appMenu: MenuItemConstructorOptions = {
    role: "appMenu",
    submenu: [
      { role: "about", label: "About dohc" },
      ...updates,
      { type: "separator" },
      ...command("settings", { label: "Settings…" }),
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide", label: "Hide dohc" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit", label: "Quit dohc", accelerator: shortcutAccelerators("quit", options.platform)[0] },
    ],
  };
  const macEditItems: MenuItemConstructorOptions[] = [
    { type: "separator" },
    {
      label: "Find",
      submenu: [
        ...command("editor-find"),
        ...command("editor-replace"),
        ...command("find-again-next"),
        ...command("find-again-previous"),
      ],
    },
    {
      label: "Substitutions",
      submenu: [
        { role: "showSubstitutions" },
        { type: "separator" },
        { role: "toggleSmartQuotes" },
        { role: "toggleSmartDashes" },
        { role: "toggleTextReplacement" },
      ],
    },
    { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
  ];
  // The standard macOS Window menu, with Safari's tab commands. AppKit
  // appends the window list.
  const windowMenu: MenuItemConstructorOptions = {
    role: "windowMenu",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      ...command("next-tab"),
      ...command("previous-tab"),
      { type: "separator" },
      { role: "front" },
    ],
  };

  return [
    ...(isMac ? [appMenu] : []),
    {
      label: "File",
      submenu: [
        ...command("new-file"),
        ...command("new-folder"),
        ...command("new-collection"),
        { type: "separator" },
        ...command("open-workspace"),
        {
          label: "Open recent",
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
              : [{ label: "No recent workspaces", enabled: false }],
        },
        ...command("import-files"),
        ...command("export-workspace"),
        { type: "separator" },
        // macOS keeps tab switching in the Window menu.
        ...(isMac ? [] : [...command("next-tab"), ...command("previous-tab")]),
        ...command("close-tab"),
        // VS Code convention: CommandOrControl+W closes the tab in the
        // renderer. The close role uses a separate window shortcut.
        { role: "close", label: "Close window", accelerator: shortcutAccelerators("close-window", options.platform)[0] },
        // A schedule can keep dohc running with no window, and GNOME hides the
        // tray icon that would quit it, so Linux quits from File.
        ...(options.platform === "linux"
          ? [{ type: "separator" }, { role: "quit", label: "Quit", accelerator: shortcutAccelerators("quit", options.platform)[0] }] as const
          : []),
      ],
    },
    // The editor answers Undo and Redo. macOS adds the items of Electron's
    // editMenu role, with Find before Substitutions as in TextEdit, and the
    // system appends AutoFill, Dictation, and Emoji & Symbols.
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" }, { role: "delete" }] as const : []),
        { role: "selectAll" },
        ...(isMac ? macEditItems : []),
      ],
    },
    {
      label: "View",
      submenu: [
        ...command("command-palette"),
        ...command("quick-open"),
        ...command("new-editor-group-right"),
        { type: "separator" },
        ...command("toggle-sidebar"),
        ...command("toggle-about"),
        ...command("show-chats"),
        ...command("toggle-theme"),
        { type: "separator" },
        // Main-owned zoom, not the Electron zoom roles: the zoomIn role only
        // answers CommandOrControl+Plus, which needs Shift on most layouts —
        // plain Ctrl+= (the chord keyboards label "+") did nothing while
        // Ctrl+- zoomed out. These accelerators register natively (no
        // registerAccelerator:false), so zoom works on windows that never
        // mount the workspace shell, and every path persists the level. The
        // hidden items keep the shifted and numpad chords live.
        ...([
          { id: "zoom-reset", step: "reset" },
          { id: "zoom-in", step: "in" },
          { id: "zoom-out", step: "out" },
        ] as const).flatMap((zoom) =>
          shortcutAccelerators(zoom.id, options.platform).map(
            (accelerator, index): MenuItemConstructorOptions => ({
              label: menuLabel(zoom.id),
              accelerator,
              ...(index > 0 ? { visible: false } : {}),
              click: () => options.stepZoom(zoom.step),
            }),
          ),
        ),
        ...(isMac
          ? [{ type: "separator" }, { role: "togglefullscreen" }] as const
          : []),
        // Dev only: a packaged everyday-people app has no devtools menu item.
        ...(options.isDev
          ? [{ type: "separator" }, { role: "toggleDevTools" }] as const
          : []),
      ],
    },
    // macOS keeps Settings in the app menu.
    ...(isMac ? [] : [{ label: "Go", submenu: [...command("settings")] }]),
    ...(isMac ? [windowMenu] : []),
    // macOS adds its menu search to Help, which shows only when it has an
    // item. Help holds the command palette, which lists every command.
    {
      label: "Help",
      role: "help",
      submenu: isMac
        ? command("command-palette", { keys: false })
        : [
            ...updates,
            { type: "separator" },
            { label: "About dohc", click: () => options.showAbout() },
          ],
    },
  ];
}
