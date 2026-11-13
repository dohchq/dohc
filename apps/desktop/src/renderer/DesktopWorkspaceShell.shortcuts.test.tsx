// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeBridge, renderShell, STORED_STATE } from "./DesktopWorkspaceShell.testHarness";
import { SHORTCUTS, shortcutAccelerators, type ShortcutId } from "../shortcuts/shortcutRegistry";
import { buildMenuTemplate } from "../window/applicationMenu";
import type { MenuItemConstructorOptions } from "electron";

async function ready(platform: NodeJS.Platform = "win32") {
  const bridge = makeBridge(Promise.resolve(STORED_STATE), platform);
  renderShell(bridge);
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  return bridge;
}
// An accelerator as the platform's keyboard sends it: CommandOrControl is
// Command on macOS and Control elsewhere, and Ctrl is Control everywhere.
function keyEvent(accelerator: string, platform: NodeJS.Platform, extra: KeyboardEventInit = {}) {
  const parts = accelerator.split("+");
  const primary = parts.includes("CommandOrControl");
  return new KeyboardEvent("keydown", {
    key: parts.at(-1)!, ctrlKey: parts.includes("Ctrl") || (primary && platform !== "darwin"), metaKey: primary && platform === "darwin",
    shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), bubbles: true, cancelable: true, ...extra,
  });
}
// Each platform's own chords: a row's macOS keys replace its others there.
const shellBindings = (platform: NodeJS.Platform) => Object.entries(SHORTCUTS).filter(([, row]) => row.owner === "shell")
  .flatMap(([id]) => shortcutAccelerators(id as ShortcutId, platform).map((accelerator) => [id as ShortcutId, accelerator] as const));

describe.each(["win32", "darwin"] as const)("%s shell shortcuts", (platform) => {
  it("leaves every shell binding with a focused editor that claimed it", async () => {
    await ready(platform);
    const editor = document.createElement("textarea");
    screen.getByTestId("workspace-shell").append(editor);
    editor.addEventListener("keydown", (event) => event.preventDefault());
    for (const [, accelerator] of shellBindings(platform)) {
      const event = keyEvent(accelerator, platform);
      fireEvent(editor, event);
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      expect(screen.queryByTestId("command-palette")).toBeNull();
      expect(screen.queryByTestId("quick-open")).toBeNull();
      expect(screen.getByTestId("tab-b.md")).toBeTruthy();
      expect(screen.queryByTestId("new-page")).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    }
  });

  it("blocks every shell binding during composition and repeat", async () => {
    await ready(platform);
    for (const [, accelerator] of shellBindings(platform)) {
      for (const init of [{ isComposing: true }, { repeat: true }]) {
        const event = keyEvent(accelerator, platform, init);
        fireEvent(window, event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      expect(screen.getByTestId("tab-b.md")).toBeTruthy();
      expect(screen.queryByTestId("command-palette")).toBeNull();
      expect(screen.queryByTestId("quick-open")).toBeNull();
      expect(screen.queryByTestId("new-page")).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    }
  });

  it("keeps keyboard palette toggling separate from menu opening", async () => {
    const bridge = await ready(platform);
    const binding = SHORTCUTS["command-palette"].accelerators[0];
    fireEvent(window, keyEvent(binding, platform));
    await screen.findByTestId("command-palette");
    act(() => bridge.emitMenuCommand("command-palette"));
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    fireEvent(screen.getByRole("textbox", { name: "Command" }), keyEvent(binding, platform));
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it.each([
    ["plain", {}],
  ] as const)("runs an app-menu command over Settings while guarding %s shortcuts typed inside it", async (_name, extra) => {
    const bridge = await ready(platform);
    fireEvent(window, keyEvent(SHORTCUTS.settings.accelerators[0], platform));
    const dialog = await screen.findByTestId("settings-dialog");

    const binding = SHORTCUTS["toggle-sidebar"].accelerators[0];
    const shortcut = keyEvent(binding, platform, extra);
    fireEvent(dialog, shortcut);
    expect(shortcut.defaultPrevented).toBe(platform === "darwin");
    expect(screen.getByTestId("side-panel")).toBeTruthy();

    const menu = buildMenuTemplate({
      isDev: false, platform,
      sendCommand: (_window, command) => bridge.emitMenuCommand(command),
      stepZoom: vi.fn(), showAbout: vi.fn(),
    });
    const view = menu.find((item) => item.label === "View")!.submenu as MenuItemConstructorOptions[];
    const toggle = view.find((item) => item.accelerator === binding)!;
    act(() => (toggle.click as (item: unknown, window: unknown) => void)(undefined, undefined));
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(screen.getByTestId("settings-dialog")).toBe(dialog);

    fireEvent(dialog, keyEvent(binding, platform, extra));
    expect(screen.queryByTestId("side-panel")).toBeNull();

    const input = document.createElement("input");
    dialog.append(input);
    const undo = keyEvent(SHORTCUTS["history-restore-undo"].accelerators[0], platform, extra);
    fireEvent(input, undo);
    expect(undo.defaultPrevented).toBe(false);
  });
});

describe("macOS Control-key text editing", () => {
  it.each(["textarea", "contenteditable"] as const)("keeps Control chords in a %s instead of running shell commands", async (kind) => {
    await ready("darwin");
    const field = document.createElement(kind === "textarea" ? "textarea" : "div");
    if (kind === "contenteditable") field.contentEditable = "true";
    screen.getByTestId("workspace-shell").append(field);
    field.focus();
    const groups = () => document.querySelectorAll('[data-testid^="editor-group-"]:not([data-testid*="resize"])').length;
    const groupsBefore = groups();
    for (const key of ["n", "p", "k", "b", "w", ",", "\\"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
      fireEvent(field, event);
      expect(event.defaultPrevented, `Control+${key}`).toBe(false);
    }
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.queryByTestId("command-palette")).toBeNull();
    expect(screen.queryByTestId("quick-open")).toBeNull();
    expect(screen.queryByTestId("new-page")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(groups()).toBe(groupsBefore);
    field.remove();
  });
});

describe("macOS text editing inside a modal", () => {
  it.each([
    ["plain", {}],
  ] as const)("preserves %s Control-key defaults without running shell commands", async (_name, extra) => {
    await ready("darwin");
    fireEvent(window, keyEvent(SHORTCUTS.settings.accelerators[0], "darwin"));
    const dialog = await screen.findByTestId("settings-dialog");

    for (const tag of ["input", "textarea"] as const) {
      const input = document.createElement(tag);
      dialog.append(input);
      input.focus();
      for (const key of ["a", "e", "k", "b", "f", "n", "p", "d", "h", "t"]) {
        const event = new KeyboardEvent("keydown", {
          key, ctrlKey: true, bubbles: true, cancelable: true, ...extra,
        });
        fireEvent(input, event);
        expect(event.defaultPrevented, `Control+${key} in ${tag}`).toBe(false);
      }
    }

    expect(screen.getByTestId("settings-dialog")).toBe(dialog);
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.queryByTestId("command-palette")).toBeNull();
    expect(screen.queryByTestId("quick-open")).toBeNull();
    expect(screen.queryByTestId("new-page")).toBeNull();
  });
});
