import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate } from "./applicationMenu";

function build(
  isDev = false,
  platform: NodeJS.Platform = "linux",
  canInstallUpdate = false,
) {
  const sendCommand = vi.fn();
  const stepZoom = vi.fn();
  const openRecentWorkspace = vi.fn();
  const showAbout = vi.fn();
  const recentWorkspaces = [
    {
      workspaceId: "recent-1",
      rootPath: "/Users/sam/work/personal",
      kind: "personal" as const,
      mode: "local-first" as const,
    },
  ];
  const template = buildMenuTemplate({
    isDev,
    platform,
    recentWorkspaces,
    canInstallUpdate,
    sendCommand,
    stepZoom,
    openRecentWorkspace,
    showAbout,
  });
  return { template, sendCommand, stepZoom, openRecentWorkspace, recentWorkspaces, showAbout };
}

function items(template: MenuItemConstructorOptions[], label: string) {
  const menu = template.find((entry) => entry.label === label);
  return (menu?.submenu ?? []) as MenuItemConstructorOptions[];
}

describe("application menu template", () => {
  it("has the File/Edit/View/Go/Help structure", () => {
    const { template } = build();
    expect(template.map((entry) => entry.label)).toEqual([
      "File",
      "Edit",
      "View",
      "Go",
      "Help",
    ]);
  });

  it("clicking a custom item sends its MenuCommand to the clicked window", () => {
    const { template, sendCommand } = build();
    const newFile = items(template, "File").find((i) => i.label === "New file");
    const fakeWindow = { id: 1 };
    (newFile?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "new-file");
  });

  it("keeps file import and zip export as separate File-menu commands", () => {
    const { template, sendCommand } = build();
    const fileItems = items(template, "File");
    const importFiles = fileItems.find((entry) => entry.label === "Import files");
    const exportWorkspace = fileItems.find(
      (entry) => entry.label === "Export workspace as zip",
    );
    const fakeWindow = { id: 4 };

    (importFiles?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    (exportWorkspace?.click as (a: unknown, b: unknown) => void)(
      undefined,
      fakeWindow,
    );

    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "import-files");
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "export-workspace");
  });

  it("Open recent lists known workspaces and activates the picked one", () => {
    const { template, openRecentWorkspace, recentWorkspaces } = build();
    const openRecent = items(template, "File").find((i) => i.label === "Open recent");
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems?.[0]?.label).toBe("personal");
    expect(recentItems?.[0]?.sublabel).toBe("/Users/sam/work/personal");

    const fakeWindow = { id: 2 };
    (recentItems[0]?.click as (a: unknown, b: unknown) => void)(
      undefined,
      fakeWindow,
    );
    expect(openRecentWorkspace).toHaveBeenCalledWith(
      fakeWindow,
      recentWorkspaces[0],
    );
  });

  it("Open recent has a disabled empty state when no workspaces are known", () => {
    const sendCommand = vi.fn();
    const showAbout = vi.fn();
    const template = buildMenuTemplate({
      isDev: false,
      platform: "linux",
      recentWorkspaces: [],
      sendCommand,
      stepZoom: vi.fn(),
      showAbout,
    });
    const openRecent = items(template, "File").find((i) => i.label === "Open recent");
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems).toEqual([{ label: "No recent workspaces", enabled: false }]);
  });

  it("renderer-owned accelerators are displayed but not registered", () => {
    const { template } = build();
    for (const [menu, label, accelerator] of [
      ["File", "New file", "CommandOrControl+N"],
      ["File", "Close tab", "CommandOrControl+W"],
      ["View", "Command palette", "CommandOrControl+Shift+P"],
      ["View", "Go to", "CommandOrControl+P"],
      ["View", "New editor group right", "CommandOrControl+\\"],
      ["View", "Toggle sidebar", "CommandOrControl+B"],
      ["View", "Toggle About", "CommandOrControl+Alt+B"],
      ["Go", "Settings", "CommandOrControl+,"],
    ] as const) {
      const item = items(template, menu).find((i) => i.label === label);
      expect(item?.accelerator, label).toBe(accelerator);
      expect(item?.registerAccelerator, label).toBe(false);
    }
  });

  it("routes New editor group right through the native application menu", () => {
    const { template, sendCommand } = build(false, "darwin");
    const fakeWindow = { id: 8 };
    const moveToGroup = items(template, "View").find(
      (entry) => entry.label === "New editor group right",
    );
    (moveToGroup?.click as (a: unknown, b: unknown) => void)(
      undefined,
      fakeWindow,
    );
    expect(sendCommand).toHaveBeenCalledWith(
      fakeWindow,
      "new-editor-group-right",
    );
  });

  it.each([
    ["Toggle About", "toggle-about", "CommandOrControl+Alt+B"],
    ["Chats", "show-chats", undefined],
  ] as const)("routes %s through the native application menu", (label, id, accelerator) => {
    const { template, sendCommand } = build(false, "darwin");
    const fakeWindow = { id: 6 };
    const entry = items(template, "View").find((item) => item.label === label);
    expect(entry?.accelerator).toBe(accelerator);
    (entry?.click as (a: unknown, b: unknown) => void)(
      undefined,
      fakeWindow,
    );
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, id);
  });

  it("keeps a hidden CommandOrControl+K command-palette alias active", () => {
    const { template, sendCommand } = build(false, "darwin");
    const alias = items(template, "View").find(
      (entry) => entry.label === "Command palette (alternate)",
    );

    expect(alias).toMatchObject({
      accelerator: "CommandOrControl+K",
      visible: false,
    });

    const fakeWindow = { id: 7 };
    (alias?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "command-palette");
  });

  it("zoom answers the unshifted, shifted, and numpad chords through main's mutation", () => {
    // Electron's zoomIn role only answers CommandOrControl+Plus, which needs
    // Shift on most layouts — plain Ctrl+= (the key labeled "+") did nothing
    // while Ctrl+- zoomed out, leaving no keyboard way back. Zoom is also
    // main-owned (not a renderer command), so it keeps working on windows
    // that never mount the workspace shell.
    const { template, stepZoom } = build();
    const viewItems = items(template, "View");
    for (const [accelerator, step, hidden] of [
      ["CommandOrControl+0", "reset", false],
      ["CommandOrControl+=", "in", false],
      ["CommandOrControl+Plus", "in", true],
      ["CommandOrControl+numadd", "in", true],
      ["CommandOrControl+-", "out", false],
      ["CommandOrControl+numsub", "out", true],
    ] as const) {
      const item = viewItems.find((entry) => entry.accelerator === accelerator);
      expect(item, accelerator).toBeTruthy();
      // Native registration is the point: no registerAccelerator:false.
      expect(item?.registerAccelerator, accelerator).toBeUndefined();
      expect(item?.visible === false, accelerator).toBe(hidden);
      stepZoom.mockClear();
      (item?.click as () => void)();
      expect(stepZoom, accelerator).toHaveBeenCalledWith(step);
    }
    expect(viewItems.some((entry) => entry.role === "zoomIn")).toBe(false);
  });

  it("Edit menu is pure clipboard roles so copy/paste works everywhere", () => {
    const { template } = build();
    expect(items(template, "Edit").map((i) => i.role)).toEqual([
      "undo",
      "redo",
      undefined,
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
  });

  it.each(["win32", "linux"] as const)("%s shows the tab commands beside Close tab, with Ctrl+PageDown kept as an alternate", (platform) => {
    const { template, sendCommand } = build(false, platform);
    const file = items(template, "File");
    const quit = platform === "linux" ? 2 : 0;
    expect(file.map((entry) => entry.label ?? entry.role).slice(-6 - quit, file.length - quit)).toEqual([
      "Show next tab", "Show next tab (alternate)",
      "Show previous tab", "Show previous tab (alternate)",
      "Close tab", "Close window",
    ]);
    for (const [label, accelerator, hidden] of [
      ["Show next tab", "Ctrl+Tab", false],
      ["Show next tab (alternate)", "Ctrl+PageDown", true],
      ["Show previous tab", "Ctrl+Shift+Tab", false],
      ["Show previous tab (alternate)", "Ctrl+PageUp", true],
    ] as const) {
      const entry = file.find((item) => item.label === label);
      expect(entry, label).toMatchObject({ accelerator, registerAccelerator: false });
      expect(entry?.visible === false, label).toBe(hidden);
    }
    const fakeWindow = { id: 11 };
    (file.find((item) => item.label === "Show previous tab")?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "previous-tab");
  });

  it("darwin: the Window menu holds Show next tab and Show previous tab, as in Safari", () => {
    const { template, sendCommand } = build(false, "darwin");
    const windowMenu = template.find((entry) => entry.role === "windowMenu")!;
    const entries = windowMenu.submenu as MenuItemConstructorOptions[];
    expect(entries.map((entry) => entry.role ?? entry.label ?? entry.type)).toEqual([
      "minimize", "zoom", "separator",
      "Show next tab", "Show next tab (alternate)",
      "Show previous tab", "Show previous tab (alternate)",
      "separator", "front",
    ]);
    expect(entries.filter((entry) => entry.label?.startsWith("Show")).map((entry) => [entry.accelerator, entry.visible !== false])).toEqual([
      ["Ctrl+Tab", true], ["CommandOrControl+Shift+]", false],
      ["Ctrl+Shift+Tab", true], ["CommandOrControl+Shift+[", false],
    ]);
    expect(items(template, "File").some((entry) => entry.label?.startsWith("Show"))).toBe(false);
    const fakeWindow = { id: 12 };
    (entries.find((entry) => entry.label === "Show next tab (alternate)")?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "next-tab");
  });

  it("keeps separate CommandOrControl shortcuts for Close Tab and Close Window", () => {
    // The close role defaults to CommandOrControl+W. That shortcut belongs to
    // Close Tab, so Close Window must use a different accelerator.
    const { template } = build();
    const closeWindow = items(template, "File").find((i) => i.role === "close");
    expect(closeWindow?.accelerator).toBe("CommandOrControl+Shift+W");
  });

  it("linux: File ends with Quit on Ctrl+Q, the way Linux apps quit; Windows keeps Close window last", () => {
    const linuxFile = items(build(false, "linux").template, "File");
    expect(linuxFile.slice(-3).map((i) => i.role ?? i.type)).toEqual(["close", "separator", "quit"]);
    expect(linuxFile.at(-1)).toMatchObject({ role: "quit", label: "Quit", accelerator: "CommandOrControl+Q" });
    const all = (entries: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      entries.flatMap((entry) => [entry, ...(Array.isArray(entry.submenu) ? all(entry.submenu) : [])]);
    expect(all(build(false, "win32").template).some((entry) => entry.role === "quit")).toBe(false);
    const macQuit = all(build(false, "darwin").template).filter((entry) => entry.role === "quit");
    expect(macQuit).toEqual([{ role: "quit", label: "Quit dohc", accelerator: "CommandOrControl+Q" }]);
  });

  it("devtools is present in dev and absent in packaged builds", () => {
    const roles = (isDev: boolean) =>
      items(build(isDev).template, "View").map((i) => i.role);
    expect(roles(true)).toContain("toggleDevTools");
    expect(roles(false)).not.toContain("toggleDevTools");
  });

  it("darwin: the app menu leads and holds About, updates, Settings, and the system's items", () => {
    const { template } = build(false, "darwin", true);
    expect(template.map((entry) => entry.label ?? entry.role)).toEqual([
      "appMenu", // macOS titles it with the app name
      "File",
      "Edit",
      "View",
      "windowMenu",
      "Help",
    ]);
    const appMenu = template[0]!;
    expect(appMenu.role).toBe("appMenu");
    expect((appMenu.submenu as MenuItemConstructorOptions[]).map((entry) => entry.role ?? entry.label ?? entry.type)).toEqual([
      "about",
      "Check for updates",
      "Restart to update",
      "separator",
      "Settings…",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    const settings = (appMenu.submenu as MenuItemConstructorOptions[]).find((entry) => entry.label === "Settings…");
    expect(settings?.accelerator).toBe("CommandOrControl+,");
  });

  it("darwin: one About, the native panel, and no Go menu", () => {
    const { template, sendCommand } = build(false, "darwin");
    const all = (entries: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      entries.flatMap((entry) => [entry, ...(Array.isArray(entry.submenu) ? all(entry.submenu) : [])]);
    const abouts = all(template).filter((entry) => entry.role === "about" || entry.label === "About dohc");
    expect(abouts).toEqual([{ role: "about", label: "About dohc" }]);
    expect(template.some((entry) => entry.label === "Go")).toBe(false);
    const settings = all(template).filter((entry) => entry.label?.startsWith("Settings"));
    expect(settings).toHaveLength(1);
    const fakeWindow = { id: 9 };
    (settings[0]?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "settings");
  });

  it("darwin: the standard Edit menu with Find, Full Screen in View, and the palette in Help beside the menu search", () => {
    const { template, sendCommand } = build(false, "darwin");
    // Electron's editMenu role, with Find before Substitutions as in TextEdit.
    const edit = items(template, "Edit");
    expect(edit.map((entry) => entry.role ?? entry.label ?? entry.type)).toEqual([
      "undo", "redo", "separator",
      "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "separator",
      "Find", "Substitutions", "Speech",
    ]);
    expect(edit.find((entry) => entry.label === "Substitutions")?.submenu).toEqual([
      { role: "showSubstitutions" }, { type: "separator" },
      { role: "toggleSmartQuotes" }, { role: "toggleSmartDashes" }, { role: "toggleTextReplacement" },
    ]);
    expect(edit.find((entry) => entry.label === "Speech")?.submenu).toEqual([
      { role: "startSpeaking" }, { role: "stopSpeaking" },
    ]);
    const view = items(template, "View");
    expect(view.at(-1)).toEqual({ role: "togglefullscreen" });
    const help = template.at(-1)!;
    expect(help).toMatchObject({ label: "Help", role: "help" });
    const helpItems = help.submenu as MenuItemConstructorOptions[];
    // View registers the palette's keys; a second copy would register them again.
    expect(helpItems).toEqual([{ label: "Command palette", enabled: true, click: expect.any(Function) }]);
    const fakeWindow = { id: 10 };
    (helpItems[0]?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "command-palette");
  });

  it("darwin: Edit > Find shows the editor's find keys and hands each item to the clicked window", () => {
    const { template, sendCommand } = build(false, "darwin");
    const find = items(template, "Edit").find((entry) => entry.label === "Find");
    const entries = find?.submenu as MenuItemConstructorOptions[];
    expect(entries.map(({ label, accelerator, registerAccelerator, enabled }) => ({ label, accelerator, registerAccelerator, enabled }))).toEqual([
      { label: "Find…", accelerator: "CommandOrControl+F", registerAccelerator: false, enabled: true },
      { label: "Find and replace…", accelerator: "CommandOrControl+Alt+F", registerAccelerator: false, enabled: true },
      { label: "Find next", accelerator: "CommandOrControl+G", registerAccelerator: false, enabled: true },
      { label: "Find previous", accelerator: "CommandOrControl+Shift+G", registerAccelerator: false, enabled: true },
    ]);
    const fakeWindow = { id: 13 };
    for (const entry of entries) (entry.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand.mock.calls).toEqual([
      [fakeWindow, "editor-find"],
      [fakeWindow, "editor-replace"],
      [fakeWindow, "find-again-next"],
      [fakeWindow, "find-again-previous"],
    ]);
  });

  it.each(["win32", "linux"] as const)("%s keeps Edit, Go, and Help as they were, without macOS items", (platform) => {
    const { template } = build(false, platform);
    expect(template.map((entry) => entry.label)).toEqual(["File", "Edit", "View", "Go", "Help"]);
    expect(items(template, "Edit").map((entry) => entry.role ?? entry.type)).toEqual([
      "undo", "redo", "separator", "cut", "copy", "paste", "selectAll",
    ]);
    expect(template.at(-1)?.role).toBe("help");
    expect(items(template, "Help").map((entry) => entry.label ?? entry.type)).toEqual([
      "Check for updates", "Restart to update", "separator", "About dohc",
    ]);
    expect(items(template, "View").some((entry) => entry.role === "togglefullscreen")).toBe(false);
  });

  it("About is a Help click-through, not a command", () => {
    const { template, showAbout, sendCommand } = build();
    const about = items(template, "Help").find((i) => i.label === "About dohc");
    (about?.click as () => void)();
    expect(showAbout).toHaveBeenCalledOnce();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("routes Help update actions through renderer commands", () => {
    const { template, sendCommand } = build(false, "linux", true);
    const helpItems = items(template, "Help");
    const check = helpItems.find((i) => i.label === "Check for updates");
    const install = helpItems.find((i) => i.label === "Restart to update");
    const fakeWindow = { id: 5 };

    (check?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    (install?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);

    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "check-updates");
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "install-update");
  });

  it("disables Help restart when no update is installable", () => {
    const { template } = build();
    const install = items(template, "Help").find(
      (i) => i.label === "Restart to update",
    );

    expect(install?.enabled).toBe(false);
  });
});
