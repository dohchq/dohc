// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
