// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSchema } from "@dohc/workspace-contracts";
import { ViewsDialog } from "./ViewsDialog";

const schema: CollectionSchema = {
  name: null,
  description: null,
  fields: [{ name: "Status", type: "text" }],
  views: [
    { name: "Board", kind: "table", groupBy: null, sort: [], visibleFields: null, dateField: null },
  ],
};

afterEach(cleanup);

it("closes from its X", () => {
  const onClose = vi.fn();
  render(
    <ViewsDialog
      schema={schema}
      apply={vi.fn()}
      onClose={onClose}
      onRenamed={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps keyboard focus on the delete control while it arms, then deletes", async () => {
  const apply = vi.fn(async (mutate: (schema: CollectionSchema) => CollectionSchema) => {
    mutate(schema);
    return null;
  });
  const onDeleted = vi.fn();
  render(
    <ViewsDialog
      schema={schema}
      apply={apply}
      onClose={vi.fn()}
      onRenamed={vi.fn()}
      onDeleted={onDeleted}
    />,
  );

  const arm = screen.getByRole("button", { name: "Delete view Board" });
  arm.focus();
  fireEvent.click(arm);

  // Arming swaps the control for the danger confirm; focus must follow it,
  // or a keyboard user is dropped at the top of the dialog.
  const confirm = screen.getByRole("button", { name: "Delete view Board" });
  expect(confirm).not.toBe(arm);
  expect(confirm.textContent).toBe("Delete view");
  expect(document.activeElement).toBe(confirm);

  fireEvent.click(confirm);
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("Board"));
  expect(apply).toHaveBeenCalledOnce();
});

it("preserves Table and lists categorical group fields first when adding the first Board view", async () => {
  const emptyViews: CollectionSchema = {
    name: "Tasks",
    description: null,
    fields: [
      { name: "Name", type: "text" },
      { name: "Status", type: "select", options: ["Todo", "Done"] },
    ],
    views: [],
  };
  let written: CollectionSchema | null = null;
  const apply = vi.fn(async (mutate: (current: CollectionSchema) => CollectionSchema) => {
    written = mutate(emptyViews);
    return null;
  });
  render(
    <ViewsDialog
      schema={emptyViews}
      apply={apply}
      onClose={vi.fn()}
      onRenamed={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "table" } });
  fireEvent.change(screen.getByLabelText("View kind"), { target: { value: "board" } });
  const groupSelect = screen.getByLabelText("Group by") as HTMLSelectElement;
  expect([...groupSelect.options].slice(1).map((option) => option.value)).toEqual([
    "Status",
    "Name",
  ]);
  fireEvent.change(groupSelect, { target: { value: "Status" } });
  fireEvent.click(screen.getByRole("button", { name: "Create view" }));
  expect(
    await screen.findByText('A view named "table" already exists. Choose another name.'),
  ).toBeTruthy();
  expect(apply).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "By status" } });
  fireEvent.click(screen.getByRole("button", { name: "Create view" }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(written!.views.map((view) => [view.name, view.kind, view.groupBy])).toEqual([
    ["Table", "table", null],
    ["By status", "board", "Status"],
  ]);
});
