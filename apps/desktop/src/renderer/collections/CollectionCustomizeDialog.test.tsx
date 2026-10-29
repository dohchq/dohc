// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionCustomizeDialog, automationsFile, documentCollectionFiles, type CollectionFile } from "./CollectionCustomizeDialog";

afterEach(cleanup);

// A Manage menu like a dataset Collection's: a <details> that closes when
// one of its buttons is clicked.
function Harness(props: { files: readonly CollectionFile[]; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <details onClick={(event) => { if (event.target instanceof HTMLButtonElement) event.currentTarget.open = false; }}>
        <summary>Manage Collection</summary>
        <button type="button" onClick={() => setOpen(true)}>Customize…</button>
      </details>
      {open ? <CollectionCustomizeDialog name="Trips" files={props.files} onOpenFile={props.onOpenFile ?? vi.fn()} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

async function openDialog(files: readonly CollectionFile[], onOpenFile?: (path: string) => void) {
  const user = userEvent.setup();
  render(<Harness files={files} {...(onOpenFile ? { onOpenFile } : {})} />);
  await user.click(screen.getByText("Manage Collection"));
  await user.click(screen.getByRole("button", { name: "Customize…" }));
  return { user, dialog: screen.getByRole("dialog", { name: "Customize Trips" }) };
}

describe("CollectionCustomizeDialog", () => {
  it("lists each file with what it holds, and returns focus to the menu that opened it", async () => {
    const { user, dialog } = await openDialog(documentCollectionFiles("trips", true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    expect(dialog.textContent).toContain("Fields and views");
    expect(dialog.textContent).toContain("trips/collection.yaml");
    expect(dialog.textContent).toContain("trips/automations.yaml");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Manage Collection"));
  });

  it("opens a file in a tab and closes, leaving focus to the tab", async () => {
    const onOpenFile = vi.fn();
    const { user } = await openDialog(documentCollectionFiles("trips", true), onOpenFile);
    await user.click(screen.getByRole("button", { name: "Open automations.yaml" }));

    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("trips/automations.yaml");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByText("Manage Collection"));
  });

  it("copies a file's path", async () => {
    const { user } = await openDialog(documentCollectionFiles("trips", true));
    await user.click(screen.getByRole("button", { name: "Copy collection.yaml path" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Path copied" })).toBeTruthy());
    expect(await navigator.clipboard.readText()).toBe("trips/collection.yaml");
  });

  it("says what makes automations.yaml in Open's place before the first automation, and still copies its path", async () => {
    const { dialog } = await openDialog([automationsFile("trips", false)]);
    expect(within(dialog).getByText("Made with the first automation.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Copy automations.yaml path" })).toBeTruthy();
  });
});
