// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeBridge, renderShell, STORED_STATE, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";
import { SHORTCUTS, matchShellShortcut, type ShortcutId } from "../shortcuts/shortcutRegistry";
import { buildMenuTemplate } from "../window/applicationMenu";
import type { MenuItemConstructorOptions } from "electron";

async function ready(platform: NodeJS.Platform = "win32") {
  const bridge = makeBridge(Promise.resolve(STORED_STATE), platform);
  renderShell(bridge);
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  return bridge;
}
function keyEvent(accelerator: string, platform: NodeJS.Platform, extra: KeyboardEventInit = {}) {
  const parts = accelerator.split("+");
  return new KeyboardEvent("keydown", {
    key: parts.at(-1)!, ctrlKey: platform !== "darwin", metaKey: platform === "darwin",
    shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), bubbles: true, cancelable: true, ...extra,
  });
}
const shellBindings = Object.entries(SHORTCUTS).filter(([, row]) => row.owner === "shell")
  .flatMap(([id, row]) => row.accelerators.map((accelerator) => [id as ShortcutId, accelerator] as const));

describe.each(["win32", "darwin"] as const)("%s shell shortcuts", (platform) => {
  it("matches the separate history-restore owner without taking editor undo", async () => {
    await ready(platform);
    const bindings = Object.values(SHORTCUTS).filter((row) => row.owner === "history-restore")
      .flatMap((row) => row.accelerators);
    expect(bindings).toHaveLength(1);
    for (const binding of bindings) {
      const event = keyEvent(binding, platform);
      expect(matchShellShortcut(event)).toBe("history-restore-undo");
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(false);
      for (const extra of [{ isComposing: true }, { repeat: true }]) {
        expect(matchShellShortcut(keyEvent(binding, platform, extra))).toBeNull();
      }
    }
  });

  it("pins empty-editor chips as known exceptions pending Correct macOS empty-editor shortcut text", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([])), platform);
    renderShell(bridge);
    await screen.findByText("Select a file, or create one");
    for (const text of ["Ctrl N · new file", "Ctrl K · commands", "Ctrl P · go to"]) {
      expect(screen.getByRole("button", { name: text }).textContent?.trim()).toBe(text);
    }
  });

  it.each(shellBindings)("claims %s: %s and keeps menu registration disabled", async (_id, accelerator) => {
    const bridge = await ready(platform);
    const menu = buildMenuTemplate({ isDev: false, platform, sendCommand: vi.fn(), stepZoom: vi.fn(), showAbout: vi.fn() });
    const items = menu.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : []) as MenuItemConstructorOptions[];
    const item = items.find((candidate) => candidate.accelerator === accelerator)!;
    const event = keyEvent(accelerator, platform);
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    expect(item.registerAccelerator).toBe(false);
    expect(bridge.stepWindowZoom).not.toHaveBeenCalled();
  });

  it.each(shellBindings)("leaves %s: %s with a focused editor that claimed it", async (_id, accelerator) => {
    await ready(platform);
    const editor = document.createElement("textarea");
    screen.getByTestId("workspace-shell").append(editor);
    editor.addEventListener("keydown", (event) => event.preventDefault());
    const event = keyEvent(accelerator, platform);
    fireEvent(editor, event);
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(screen.queryByTestId("command-palette")).toBeNull();
    expect(screen.queryByTestId("quick-open")).toBeNull();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it.each(shellBindings)("blocks %s: %s during composition and repeat", async (_id, accelerator) => {
    await ready(platform);
    for (const init of [{ isComposing: true }, { repeat: true }]) {
      const event = keyEvent(accelerator, platform, init);
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.queryByTestId("command-palette")).toBeNull();
    expect(screen.queryByTestId("quick-open")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("keeps keyboard palette toggling separate from menu opening", async () => {
    const bridge = await ready(platform);
    const binding = SHORTCUTS["command-palette"].accelerators[0];
    fireEvent(window, keyEvent(binding, platform));
    await screen.findByTestId("command-palette");
    act(() => bridge.emitMenuCommand("command-palette"));
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    fireEvent(window, keyEvent(binding, platform));
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it.each(["menu", "shell", "chip"])("takes a changed registry binding through %s", async (consumer) => {
    const accelerators = SHORTCUTS["quick-open"].accelerators;
    const original = accelerators[0];
    Reflect.set(accelerators, "0", "CommandOrControl+O");
    try {
      await ready(platform);
      if (consumer === "chip") {
        const trigger = screen.getByTestId("titlebar-quick-open");
        expect(trigger.querySelector("kbd")?.textContent).toBe(platform === "darwin" ? "⌘O" : "Ctrl O");
      } else if (consumer === "menu") {
        const menu = buildMenuTemplate({ isDev: false, platform, sendCommand: vi.fn(), stepZoom: vi.fn(), showAbout: vi.fn() });
        const view = menu.find((item) => item.label === "View")!.submenu as MenuItemConstructorOptions[];
        expect(view.find((item) => item.label === "Go To")!.accelerator).toBe("CommandOrControl+O");
      } else {
        const event = keyEvent("CommandOrControl+O", platform);
        fireEvent(window, event);
        expect(event.defaultPrevented).toBe(true);
        await screen.findByTestId("quick-open");
      }
    } finally {
      Reflect.set(accelerators, "0", original);
    }
  });
});
