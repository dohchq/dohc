// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSchema } from "@dohc/workspace-contracts";
import { FieldsDialog } from "./FieldsDialog";

const schema: CollectionSchema = {
  name: null,
  description: null,
  fields: [{ name: "Status", type: "text" }],
  views: [],
};

afterEach(cleanup);

it("closes from its X", () => {
  const onClose = vi.fn();
  render(<FieldsDialog schema={schema} relationTargets={[]} apply={vi.fn()} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("saves an option's color with the field's options", async () => {
  const select: CollectionSchema = {
    ...schema,
    fields: [{ name: "Stage", type: "select", options: ["Todo", "Done"], colors: { Done: "teal" } }],
  };
  let written: CollectionSchema | null = null;
  const apply = vi.fn(async (mutate: (current: CollectionSchema) => CollectionSchema) => {
    written = mutate(select);
    return null;
  });
  render(<FieldsDialog schema={select} relationTargets={[]} apply={apply} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit field Stage" }));
  const done = screen.getByRole("radiogroup", { name: "Color for Done" });
  expect(within(done).getByRole("radio", { name: "Teal" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Color for Todo" })).getByRole("radio", { name: "Rose" }));
  fireEvent.click(screen.getByRole("button", { name: "Save field" }));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(written!.fields[0]).toEqual({ name: "Stage", type: "select", options: ["Todo", "Done"], colors: { Todo: "rose", Done: "teal" } });
});
