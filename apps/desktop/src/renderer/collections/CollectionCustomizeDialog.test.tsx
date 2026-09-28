// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskAgent } from "../askAgent";
import { CustomizeContext } from "../settings/customize";
import { CollectionCustomizeDialog, documentCollectionFiles } from "./CollectionCustomizeDialog";

afterEach(cleanup);

// A Manage menu like a dataset Collection's: a <details> that closes when
// one of its buttons is clicked.
function Harness(props: { askAgent?: AskAgent }) {
  const [open, setOpen] = useState(false);
  return (
    <CustomizeContext.Provider value={{ customize: vi.fn(), ...(props.askAgent ? { askAgent: props.askAgent } : {}) }}>
      <details onClick={(event) => { if (event.target instanceof HTMLButtonElement) event.currentTarget.open = false; }}>
        <summary>Manage Collection</summary>
        <button type="button" onClick={() => setOpen(true)}>Customize…</button>
      </details>
      {open ? <CollectionCustomizeDialog name="Trips" files={documentCollectionFiles("trips")} onClose={() => setOpen(false)} /> : null}
    </CustomizeContext.Provider>
  );
}

describe("CollectionCustomizeDialog", () => {
  it("lists each file with what it holds, and returns focus to the menu that opened it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Manage Collection"));
    await user.click(screen.getByRole("button", { name: "Customize…" }));

    const dialog = screen.getByRole("dialog", { name: "Customize Trips" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    expect(dialog.textContent).toContain("Fields and views");
    expect(dialog.textContent).toContain("trips/collection.yaml");
    expect(dialog.textContent).toContain("trips/automations.yaml");
    // No workspace shell, so no agent to ask.
    expect(screen.queryByTestId("ask-agent")).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Manage Collection"));
  });

  it("closes without taking focus back when it hands the change to the agent", async () => {
    const user = userEvent.setup();
    const ask = vi.fn();
    render(<Harness askAgent={{ ready: true, ask, setUp: vi.fn() }} />);
    await user.click(screen.getByText("Manage Collection"));
    await user.click(screen.getByRole("button", { name: "Customize…" }));
    await user.click(screen.getByRole("button", { name: "Ask my agent" }));

    expect(ask).toHaveBeenCalledExactlyOnceWith({ kind: "collection", name: "Trips", files: documentCollectionFiles("trips") });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByText("Manage Collection"));
  });
});
