// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSchema } from "@dohc/workspace-contracts";
import { ViewsDialog } from "./ViewsDialog";

const schema: CollectionSchema = {
  name: null,
  description: null,
  fields: [{ name: "Status", type: "text" }],
  views: [{ name: "Board", kind: "table", groupBy: null, sort: [], visibleFields: null, dateField: null }],
};

afterEach(cleanup);

it("closes from its X", () => {
  const onClose = vi.fn();
  render(<ViewsDialog schema={schema} apply={vi.fn()} onClose={onClose} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps keyboard focus on the delete control while it arms, then deletes", async () => {
  const apply = vi.fn(async (mutate: (schema: CollectionSchema) => CollectionSchema) => {
    mutate(schema);
    return null;
  });
  const onDeleted = vi.fn();
  render(<ViewsDialog schema={schema} apply={apply} onClose={vi.fn()} onRenamed={vi.fn()} onDeleted={onDeleted} />);

  const arm = screen.getByRole("button", { name: "Delete view Board" });
  arm.focus();
  fireEvent.click(arm);

  // Arming swaps the control for the danger confirm; focus must follow it,
  // or a keyboard user is dropped at the top of the dialog.
  const confirm = screen.getByRole("button", { name: "Delete view Board" });
  expect(confirm).not.toBe(arm);
  expect(confirm.textContent).toBe("Confirm delete");
  expect(document.activeElement).toBe(confirm);

  fireEvent.click(confirm);
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("Board"));
  expect(apply).toHaveBeenCalledOnce();
});
