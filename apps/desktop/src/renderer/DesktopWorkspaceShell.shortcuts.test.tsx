// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeBridge, renderShell, STORED_STATE } from "./DesktopWorkspaceShell.testHarness";
import { SHORTCUTS, type ShortcutId } from "../shortcuts/shortcutRegistry";
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
const shellBindings = Object.entries(SHORTCUTS).filter(([id, row]) => row.owner === "shell" && id !== "history-restore-undo")
  .flatMap(([id, row]) => row.accelerators.map((accelerator) => [id as ShortcutId, accelerator] as const));

describe.each(["win32", "darwin"] as const)("%s shell shortcuts", (platform) => {
  it.each(shellBindings)("claims %s: %s before native fallback", async (_id, accelerator) => {
    const bridge = await ready(platform);
    const nativeSend = vi.fn();
    const menu = buildMenuTemplate({ isDev: false, platform, sendCommand: nativeSend, stepZoom: vi.fn(), showAbout: vi.fn() });
    const items = menu.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : []) as MenuItemConstructorOptions[];
    const item = items.find((candidate) => candidate.accelerator === accelerator)!;
    const event = keyEvent(accelerator, platform);
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    expect(item.registerAccelerator).toBe(false);
    // macOS invokes its native fallback only after an unhandled renderer key.
    // Windows does not register these menu accelerators at all.
    if (platform === "darwin" && !event.defaultPrevented) item.click!(undefined!, undefined!, undefined!);
    expect(nativeSend).not.toHaveBeenCalled();
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
