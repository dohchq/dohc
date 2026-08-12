import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate } from "./applicationMenu";

function build(
  isDev = false,
  platform: NodeJS.Platform = "linux",
  canInstallUpdate = false,
) {
  const sendCommand = vi.fn();
  const openRecentWorkspace = vi.fn();
  const showAbout = vi.fn();
  const recentWorkspaces = [
    {
      workspaceId: "recent-1",
      rootPath: "/Users/ice/work/personal",
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
    openRecentWorkspace,
    showAbout,
  });
  return { template, sendCommand, openRecentWorkspace, recentWorkspaces, showAbout };
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
    const newFile = items(template, "File").find((i) => i.label === "New File");
    const fakeWindow = { id: 1 };
    (newFile?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "new-file");
  });

  it("keeps file import and zip export as separate File-menu commands", () => {
    const { template, sendCommand } = build();
    const fileItems = items(template, "File");
    const importFiles = fileItems.find((entry) => entry.label === "Import Files…");
    const exportWorkspace = fileItems.find(
      (entry) => entry.label === "Export Workspace as Zip…",
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

  it("Open Recent lists known workspaces and activates the picked one", () => {
    const { template, openRecentWorkspace, recentWorkspaces } = build();
    const openRecent = items(template, "File").find((i) => i.label === "Open Recent");
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems?.[0]?.label).toBe("personal");
    expect(recentItems?.[0]?.sublabel).toBe("/Users/ice/work/personal");

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

  it("Open Recent has a disabled empty state when no workspaces are known", () => {
    const sendCommand = vi.fn();
    const showAbout = vi.fn();
    const template = buildMenuTemplate({
      isDev: false,
      platform: "linux",
      recentWorkspaces: [],
      sendCommand,
      showAbout,
    });
    const openRecent = items(template, "File").find((i) => i.label === "Open Recent");
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems).toEqual([{ label: "No Recent Workspaces", enabled: false }]);
  });

  it("renderer-owned accelerators are displayed but not registered", () => {
    const { template } = build();
    for (const [menu, label, accelerator] of [
      ["File", "New File", "CommandOrControl+N"],
      ["File", "Close Tab", "CommandOrControl+W"],
      ["View", "Command Palette", "CommandOrControl+Shift+P"],
      ["View", "Quick Open", "CommandOrControl+P"],
      ["View", "New Editor Group Right", "CommandOrControl+\\"],
      ["View", "Toggle Sidebar", "CommandOrControl+B"],
      ["View", "Toggle Chats Panel", "CommandOrControl+Alt+B"],
      ["Go", "Settings", "CommandOrControl+,"],
    ] as const) {
      const item = items(template, menu).find((i) => i.label === label);
      expect(item?.accelerator, label).toBe(accelerator);
      expect(item?.registerAccelerator, label).toBe(false);
    }
  });

  it("routes New Editor Group Right through the native application menu", () => {
    const { template, sendCommand } = build(false, "darwin");
    const fakeWindow = { id: 8 };
    const moveToGroup = items(template, "View").find(
      (entry) => entry.label === "New Editor Group Right",
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

  it("routes Toggle Chats through the native application menu", () => {
    const { template, sendCommand } = build(false, "darwin");
    const fakeWindow = { id: 6 };
    const toggleChats = items(template, "View").find(
      (entry) => entry.label === "Toggle Chats Panel",
    );
    (toggleChats?.click as (a: unknown, b: unknown) => void)(
      undefined,
      fakeWindow,
    );
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "toggle-chats");
  });

  it("keeps a hidden CommandOrControl+K command-palette alias active", () => {
    const { template, sendCommand } = build(false, "darwin");
    const alias = items(template, "View").find(
      (entry) => entry.label === "Command Palette (Alternate)",
    );

    expect(alias).toMatchObject({
      accelerator: "CommandOrControl+K",
      visible: false,
    });

    const fakeWindow = { id: 7 };
    (alias?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "command-palette");
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

  it("keeps separate CommandOrControl shortcuts for Close Tab and Close Window", () => {
    // The close role defaults to CommandOrControl+W. That shortcut belongs to
    // Close Tab, so Close Window must use a different accelerator.
    const { template } = build();
    const closeWindow = items(template, "File").find((i) => i.role === "close");
    expect(closeWindow?.accelerator).toBe("CommandOrControl+Shift+W");
  });

  it("devtools is present in dev and absent in packaged builds", () => {
    const roles = (isDev: boolean) =>
      items(build(isDev).template, "View").map((i) => i.role);
    expect(roles(true)).toContain("toggleDevTools");
    expect(roles(false)).not.toContain("toggleDevTools");
  });

  it("darwin: appMenu role leads (macOS turns the first entry into the app menu) and windowMenu precedes Help", () => {
    const { template } = build(false, "darwin");
    expect(template[0]).toEqual({ role: "appMenu" });
    expect(template.map((entry) => entry.label)).toEqual([
      undefined, // appMenu — macOS supplies the app name
      "File",
      "Edit",
      "View",
      "Go",
      undefined, // windowMenu
      "Help",
    ]);
    expect(template.at(-2)).toEqual({ role: "windowMenu" });
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
    const check = helpItems.find((i) => i.label === "Check for Updates…");
    const install = helpItems.find((i) => i.label === "Update and Restart");
    const fakeWindow = { id: 5 };

    (check?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);
    (install?.click as (a: unknown, b: unknown) => void)(undefined, fakeWindow);

    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "check-updates");
    expect(sendCommand).toHaveBeenCalledWith(fakeWindow, "install-update");
  });

  it("disables Help restart when no update is installable", () => {
    const { template } = build();
    const install = items(template, "Help").find(
      (i) => i.label === "Update and Restart",
    );

    expect(install?.enabled).toBe(false);
  });
});
