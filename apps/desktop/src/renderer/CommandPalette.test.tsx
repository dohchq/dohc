// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type Command } from "./CommandPalette";
import { SHORTCUTS } from "../shortcuts/shortcutRegistry";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the palette nudges the selected
  // row visible with it.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const ran: string[] = [];
  const onClose = vi.fn();
  const commands: Command[] = ["alpha", "beta", "gamma"].map((id) => ({
    id,
    label: id,
    run: () => ran.push(id),
  }));
  render(<CommandPalette commands={commands} onClose={onClose} />);
  return { ran, onClose };
}

function selectedLabel(): string | null {
  return screen.getByRole("option", { selected: true }).textContent;
}

describe("CommandPalette keyboard selection", () => {
  it.each(["win32", "darwin"].flatMap((platform) =>
    ["input", "result row", "panel"].flatMap((focus) =>
      SHORTCUTS["command-palette"].accelerators.map((binding) => ({ platform, focus, binding })),
    ),
  ))("handles $binding on $platform with focus on the $focus", ({ platform, focus, binding }) => {
    vi.stubGlobal("dohcDesktop", { platform });
    const { ran, onClose } = setup();
    const target = focus === "input"
      ? screen.getByRole("textbox", { name: "Command" })
      : focus === "result row"
        ? screen.getByRole("button", { name: "alpha" })
        : screen.getByTestId("command-palette").closest<HTMLElement>('[data-focus-surface="dialog"]')!;
    target.focus();
    expect(document.activeElement).toBe(target);
    const parts = binding.split("+");
    const event = new KeyboardEvent("keydown", {
      key: parts.at(-1)!, shiftKey: parts.includes("Shift"),
      ctrlKey: platform === "win32", metaKey: platform === "darwin",
      bubbles: true, cancelable: true,
    });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(ran).toEqual([]);
  });

  it("leaves macOS Control+K to the text field", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    const { onClose } = setup();
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("textbox", { name: "Command" }), event);
    expect(event.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves an Enter that confirms an IME composition to the input method", () => {
    const { ran, onClose } = setup();
    const input = screen.getByRole("textbox", { name: "Command" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    expect(ran).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(selectedLabel()).toBe("alpha");
  });

  it("Arrow keys move the selection (wrapping) and Enter runs it", async () => {
    const { ran, onClose } = setup();
    expect(selectedLabel()).toBe("alpha");

    await userEvent.keyboard("{ArrowDown}");
    expect(selectedLabel()).toBe("beta");

    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(selectedLabel()).toBe("gamma"); // wrapped past the top

    await userEvent.keyboard("{Enter}");
    expect(ran).toEqual(["gamma"]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  // A command can open a surface that takes focus at once, as Settings does
  // once its chunk has loaded. Enter must not also press what it focused.
  it("keeps Enter from pressing the control its command focused", async () => {
    const pressed = vi.fn();
    const control = document.createElement("button");
    control.addEventListener("click", pressed);
    document.body.append(control);
    render(<CommandPalette commands={[{ id: "open", label: "open", run: () => control.focus() }]} onClose={vi.fn()} />);

    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(control);
    expect(pressed).not.toHaveBeenCalled();
    control.remove();
  });

  it("typing resets the selection to the first match", async () => {
    const { ran } = setup();
    await userEvent.keyboard("{ArrowDown}"); // beta
    await userEvent.keyboard("g"); // filters to gamma only
    expect(selectedLabel()).toBe("gamma");
    await userEvent.keyboard("{Enter}");
    expect(ran).toEqual(["gamma"]);
  });

  it("selects the result Tab reaches, so its fill shows focus", async () => {
    setup();
    act(() => screen.getByRole("button", { name: "beta" }).focus());
    expect(selectedLabel()).toBe("beta");
  });

  it("Escape from the input closes it once, through the overlay", async () => {
    const { ran, onClose } = setup();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Command" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(ran).toEqual([]);
  });
});
