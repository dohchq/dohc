// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2 } from "lucide-react";
import { ConfirmDialog, ConfirmDialogCard } from "./ConfirmDialog";

function card(intent?: "default" | "danger") {
  return (
    <ConfirmDialogCard
      icon={Trash2}
      title="Delete 12 files from Research?"
      confirmLabel="Delete files"
      intent={intent}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      testId="confirm"
      cancelTestId="confirm-cancel"
      confirmTestId="confirm-action"
    >
      <p>They move to the system trash.</p>
    </ConfirmDialogCard>
  );
}

describe("ConfirmDialog intent", () => {
  afterEach(cleanup);

  it("confirms on the brand primary by default", () => {
    render(card());
    const confirm = screen.getByTestId("confirm-action");
    expect(confirm.className).toContain("bg-accent");
    expect(confirm.className).not.toContain("bg-danger");
    expect(screen.getByRole("button", { name: "Delete files" })).toBe(confirm);
  });

  it("confirms on the danger fill when the action removes or revokes", () => {
    render(card("danger"));
    const confirm = screen.getByTestId("confirm-action");
    expect(confirm.className).toContain("bg-danger-fill");
    expect(confirm.className).not.toContain("bg-accent");
    // The intent changes the fill only: the dialog's name, the testids and
    // the labels are pinned by e2e.
    expect(screen.getByRole("heading", { name: "Delete 12 files from Research?" })).toBeTruthy();
    expect(screen.getByTestId("confirm-cancel").textContent).toBe("Cancel");
    expect(confirm.textContent).toBe("Delete files");
  });

  // The tile's tint shows the intent before a word is read. It is decoration,
  // so a screen reader skips it.
  it("tints its tile by intent", () => {
    render(card("danger"));
    const danger = screen.getByTestId("confirm").querySelector("[aria-hidden]")!;
    expect(danger.className).toContain("bg-danger-tint");
    expect(danger.className).toContain("text-danger");
    expect(danger.querySelector("svg")).toBeTruthy();
    cleanup();
    render(card());
    const quiet = screen.getByTestId("confirm").querySelector("[aria-hidden]")!;
    expect(quiet.className).toContain("bg-panel-2");
    expect(quiet.className).not.toContain("danger");
  });

  // Focus opens on the confirm button, so a screen reader reads the title and
  // the button. The body says what is lost, so it must be read too.
  it("is described by its body", () => {
    render(
      <ConfirmDialog icon={Trash2} title="Delete 12 files from Research?" confirmLabel="Delete files" onCancel={vi.fn()} onConfirm={vi.fn()}
        testId="confirm" cancelTestId="confirm-cancel" confirmTestId="confirm-action">
        <p>They move to the system trash.</p>
      </ConfirmDialog>,
    );
    expect(
      screen.getByRole("dialog", {
        name: "Delete 12 files from Research?",
        description: "They move to the system trash.",
      }),
    ).toBeTruthy();
  });

  // A list of every path, or a Copy button, is not read as the description.
  it("leaves its details out of the description", () => {
    render(
      <ConfirmDialog
        icon={Trash2}
        title="Delete 2 items?"
        confirmLabel="Delete"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        testId="confirm"
        cancelTestId="confirm-cancel"
        confirmTestId="confirm-action"
        details={
          <ul>
            <li>Research/a.md</li>
            <li>Research/b.md</li>
          </ul>
        }
      >
        <p>They move to the system trash.</p>
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Delete 2 items?", description: "They move to the system trash." });
    expect(dialog.textContent).toContain("Research/b.md");
  });
});

function dialog(overrides: Partial<{ confirmDisabled: boolean; choice: boolean }> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      icon={Trash2}
      title="Delete notes.md?"
      confirmLabel="Delete"
      intent="danger"
      confirmDisabled={overrides.confirmDisabled}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="confirm"
      cancelTestId="confirm-cancel"
      confirmTestId="confirm-action"
    >
      {overrides.choice ? <label><input type="checkbox" /> Keep a copy</label> : <p>It moves to the trash.</p>}
    </ConfirmDialog>,
  );
  return { onCancel, onConfirm, cancel: screen.getByTestId("confirm-cancel"), confirm: screen.getByTestId("confirm-action") };
}

describe("ConfirmDialog keys", () => {
  afterEach(cleanup);

  it("starts on the confirm button, so Enter confirms", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm, confirm } = dialog();
    expect(document.activeElement).toBe(confirm);
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels with Escape", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = dialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("moves between its buttons with the arrow keys, and Tab still works", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm, cancel, confirm } = dialog();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(confirm);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{Enter}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("starts on the first control when confirm waits for a choice, and Enter cannot confirm", async () => {
    const user = userEvent.setup();
    const { onConfirm, cancel } = dialog({ confirmDisabled: true, choice: true });
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Keep a copy" }));
    await user.keyboard("{Enter}");
    cancel.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog guards against an Enter nobody meant", () => {
  afterEach(cleanup);

  it("ignores a held Enter, which may be the key that opened it", () => {
    const { onConfirm, confirm } = dialog();
    expect(fireEvent.keyDown(confirm, { key: "Enter", repeat: true })).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ["a text field", <textarea key="field" aria-label="Note" />],
    ["editable text", <div key="field" aria-label="Note" role="textbox" contentEditable suppressContentEditableWarning />],
    // An app's frame may hold a text field the renderer can't see.
    ["an app's frame", <iframe key="field" title="Note" />],
  ])("keeps focus on its panel when it opens while someone types in %s", async (_name, field) => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const shown = (open: boolean) => (
      <>
        {field}
        {open ? (
          <ConfirmDialog icon={Trash2} title="Delete 3 kept copies?" confirmLabel="Delete" intent="danger" onCancel={vi.fn()} onConfirm={onConfirm}
            testId="confirm" cancelTestId="confirm-cancel" confirmTestId="confirm-action">
            <p>They can't be restored.</p>
          </ConfirmDialog>
        ) : null}
      </>
    );
    const { rerender } = render(shown(false));
    const typed = document.querySelector<HTMLElement>("[aria-label=Note], iframe[title=Note]")!;
    typed.focus();
    expect(document.activeElement).toBe(typed);
    rerender(shown(true));
    const panel = screen.getByTestId("confirm").parentElement!;
    expect(document.activeElement).toBe(panel);
    // The panel it focuses is the dialog, so a screen reader reads its title.
    expect(screen.getByRole("dialog", { name: "Delete 3 kept copies?", description: "They can't be restored." })).toBe(panel);
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    // From the panel, an arrow reaches the first or the last button.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByTestId("confirm-cancel"));
    panel.focus();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByTestId("confirm-action"));
  });
});
