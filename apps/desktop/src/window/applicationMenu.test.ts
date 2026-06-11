import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate } from "./applicationMenu";

function build(isDev = false, platform: NodeJS.Platform = "linux") {
  const sendCommand = vi.fn();
  const showAbout = vi.fn();
  const template = buildMenuTemplate({ isDev, platform, sendCommand, showAbout });
  return { template, sendCommand, showAbout };
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

  it("renderer-owned accelerators are displayed but not registered", () => {
    const { template } = build();
    for (const [menu, label, accelerator] of [
      ["File", "New File", "CommandOrControl+N"],
      ["File", "Close Tab", "CommandOrControl+W"],
      ["View", "Command Palette", "CommandOrControl+Shift+P"],
      ["View", "Quick Open", "CommandOrControl+P"],
      ["View", "Toggle Sidebar", "CommandOrControl+B"],
    ] as const) {
      const item = items(template, menu).find((i) => i.label === label);
      expect(item?.accelerator, label).toBe(accelerator);
      expect(item?.registerAccelerator, label).toBe(false);
    }
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

  it("Ctrl+W belongs to Close Tab; Close Window moved to Ctrl+Shift+W", () => {
    // The close ROLE's default accelerator is Ctrl+W — left in place it would
    // close the window on every tab close.
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
});
