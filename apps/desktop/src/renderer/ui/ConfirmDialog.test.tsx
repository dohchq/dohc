// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfirmDialogCard } from "./ConfirmDialog";

function card(intent?: "default" | "danger") {
  return (
    <ConfirmDialogCard
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
    expect(confirm.className).toContain("bg-danger");
    expect(confirm.className).not.toContain("bg-accent");
    // The intent changes the fill only: the dialog's name, the testids and
    // the labels are pinned by e2e.
    expect(screen.getByRole("dialog", { name: "Delete 12 files from Research?" })).toBeTruthy();
    expect(screen.getByTestId("confirm-cancel").textContent).toBe("Cancel");
    expect(confirm.textContent).toBe("Delete files");
  });
});
