// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FILE_KIND_RECORDS } from "@dohc/workspace-contracts/kinds";
import { makeBridge, renderShell, STORED_STATE, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";
import { SHORTCUTS, matchShellShortcut, shortcutAccelerators, type ShortcutId } from "../shortcuts/shortcutRegistry";
import { buildMenuTemplate } from "../window/applicationMenu";
import type { MenuItemConstructorOptions } from "electron";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { EDITOR_MENU_COMMANDS } from "../ipc/channels";
import { onEditorMenuCommand } from "./editor/editorMenuCommands";

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
  it("matches the separate history-restore owner without taking editor undo", async () => {
    await ready(platform);
    const bindings = Object.values(SHORTCUTS).filter((row) => row.owner === "history-restore")
      .flatMap((row) => row.accelerators);
    expect(bindings).toHaveLength(1);
    for (const binding of bindings) {
      const event = keyEvent(binding, platform);
      expect(matchShellShortcut(event, platform)).toBe("history-restore-undo");
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(false);
      for (const extra of [{ isComposing: true }, { repeat: true }]) {
        expect(matchShellShortcut(keyEvent(binding, platform, extra), platform)).toBeNull();
      }
    }
  });

  it("labels the start surface's document tile with the new-file binding", async () => {
    renderShell(makeBridge(Promise.resolve(storedStateWithTabs([])), platform));
    const tile = await within(await screen.findByTestId("start-surface")).findByRole("button", { name: FILE_KIND_RECORDS.markdown.name });
    expect(tile.textContent).toContain(platform === "darwin" ? "⌘N" : "Ctrl N");
    expect(tile.getAttribute("aria-keyshortcuts")).toBe(platform === "darwin" ? "Meta+N" : "Control+N");
  });

  it.each(shellBindings(platform))("claims %s: %s and keeps menu registration disabled", async (_id, accelerator) => {
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

  it.each(shellBindings(platform))("leaves %s: %s with a focused editor that claimed it", async (_id, accelerator) => {
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

  it.each(shellBindings(platform))("blocks %s: %s during composition and repeat", async (_id, accelerator) => {
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
    fireEvent(screen.getByRole("textbox", { name: "Command" }), keyEvent(binding, platform));
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("does not toggle the workspace behind Settings, while Escape closes Settings", async () => {
    await ready(platform);
    fireEvent(window, keyEvent(SHORTCUTS.settings.accelerators[0], platform));
    await screen.findByTestId("settings-dialog");

    fireEvent(window, keyEvent(SHORTCUTS["toggle-sidebar"].accelerators[0], platform));
    expect(screen.getByTestId("side-panel")).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId("settings-dialog"), { key: "Escape", bubbles: true });
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
  });

  it("toggles the sidebar while Notices is open", async () => {
    await ready(platform);
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-center");
    expect(screen.getByTestId("side-panel")).toBeTruthy();

    fireEvent(screen.getByTestId("notice-center-toggle"), keyEvent(SHORTCUTS["toggle-sidebar"].accelerators[0], platform));
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(screen.getByTestId("notice-center")).toBeTruthy();
  });

  it("closes Go to with its toggle shortcut", async () => {
    await ready(platform);
    const binding = SHORTCUTS["quick-open"].accelerators[0];
    fireEvent(window, keyEvent(binding, platform));
    await screen.findByTestId("quick-open");

    const event = keyEvent(binding, platform);
    fireEvent(screen.getByRole("textbox", { name: "File" }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("quick-open")).toBeNull();
  });

  it.each([
    ["plain", {}],
    ["repeated", { repeat: true }],
    ["composing", { isComposing: true }],
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

  it.each([
    ["command palette", "command-palette", "command-palette"],
    ["Go to", "quick-open", "quick-open"],
  ] as const)("does not toggle the workspace behind the %s, while Escape closes it", async (_name, shortcutId, testId) => {
    await ready(platform);
    fireEvent(window, keyEvent(SHORTCUTS[shortcutId].accelerators[0], platform));
    await screen.findByTestId(testId);

    fireEvent(window, keyEvent(SHORTCUTS["toggle-sidebar"].accelerators[0], platform));
    expect(screen.getByTestId("side-panel")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("textbox", { name: testId === "quick-open" ? "File" : "Command" }), { key: "Escape", bubbles: true });
    await waitFor(() => expect(screen.queryByTestId(testId)).toBeNull());
  });

  it("does not toggle the workspace behind a confirm dialog, while Escape closes it", async () => {
    await ready(platform);
    function ConfirmFixture() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ConfirmDialog
          title="Confirm"
          confirmLabel="Confirm"
          testId="shortcut-confirm"
          cancelTestId="shortcut-confirm-cancel"
          confirmTestId="shortcut-confirm-action"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        >
          Confirm this action?
        </ConfirmDialog>
      ) : null;
    }
    render(<ConfirmFixture />);
    await screen.findByTestId("shortcut-confirm");

    fireEvent(window, keyEvent(SHORTCUTS["toggle-sidebar"].accelerators[0], platform));
    expect(screen.getByTestId("side-panel")).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId("shortcut-confirm"), { key: "Escape", bubbles: true });
    await waitFor(() => expect(screen.queryByTestId("shortcut-confirm")).toBeNull());
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
        expect(view.find((item) => item.label === "Go to")!.accelerator).toBe("CommandOrControl+O");
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
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(groups()).toBe(groupsBefore);
    field.remove();
  });
});

describe("macOS text editing inside a modal", () => {
  it.each([
    ["plain", {}],
    ["repeated", { repeat: true }],
    ["composing", { isComposing: true }],
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
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
  });
});

describe("macOS Edit > Find", () => {
  it("hands each item to the editor that has focus, and to nothing without one", async () => {
    const bridge = await ready("darwin");
    const editor = document.createElement("div");
    const field = editor.appendChild(document.createElement("input"));
    screen.getByTestId("workspace-shell").append(editor);
    const received = vi.fn();
    const stop = onEditorMenuCommand(editor, received);
    try {
      field.focus();
      for (const command of EDITOR_MENU_COMMANDS) act(() => bridge.emitMenuCommand(command));
      expect(received.mock.calls).toEqual(EDITOR_MENU_COMMANDS.map((command) => [command]));

      field.blur();
      for (const command of EDITOR_MENU_COMMANDS) act(() => bridge.emitMenuCommand(command));
      expect(received).toHaveBeenCalledTimes(EDITOR_MENU_COMMANDS.length);
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      expect(screen.queryByTestId("command-palette")).toBeNull();
      expect(screen.queryByTestId("quick-open")).toBeNull();
    } finally {
      stop();
      editor.remove();
    }
  });
});
