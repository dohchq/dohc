// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type Command } from "./CommandPalette";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the palette nudges the selected
  // row visible with it.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

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

  it("typing resets the selection to the first match", async () => {
    const { ran } = setup();
    await userEvent.keyboard("{ArrowDown}"); // beta
    await userEvent.keyboard("g"); // filters to gamma only
    expect(selectedLabel()).toBe("gamma");
    await userEvent.keyboard("{Enter}");
    expect(ran).toEqual(["gamma"]);
  });
});
