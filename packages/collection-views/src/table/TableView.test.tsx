// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TableView } from "./TableView";
import { indexedValue, makeRecord, makeSchema } from "../testSupport";

// The virtualizer reads offsetWidth/offsetHeight, which jsdom reports as 0.
// Give every element a nonzero box so the scroll container has a viewport.
const offsetDescriptors = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 900,
  });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(offsetDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

function makeRecords(count: number) {
  return Array.from({ length: count }, (_unused, index) =>
    makeRecord(`rec-${index}`, [indexedValue("title", `Task ${index}`)]),
  );
}

describe("TableView", () => {
  it("derives a column header per schema field", () => {
    render(<TableView schema={makeSchema()} records={makeRecords(1)} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "title",
      "estimate",
      "done",
      "due",
      "status",
      "tags",
      "owner",
      "blocks",
      "link",
    ]);
  });

  it("limits and orders columns by visibleFields", () => {
    render(
      <TableView schema={makeSchema()} records={makeRecords(1)} visibleFields={["status", "title"]} />,
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["status", "title"]);
  });

  it("renders record values into cells", () => {
    render(<TableView schema={makeSchema()} records={makeRecords(3)} />);
    expect(screen.getByText("Task 0")).toBeDefined();
    expect(screen.getByText("Task 2")).toBeDefined();
  });

  it("virtualizes rows instead of rendering the whole result", () => {
    render(<TableView schema={makeSchema()} records={makeRecords(1000)} />);
    const rows = screen.getAllByRole("row");
    // Header row plus the visible window (600px / 28px) plus overscan.
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
  });

  it("cycles a header click through ascending, descending, and off", () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <TableView schema={makeSchema()} records={makeRecords(1)} sort={[]} onSortChange={onSortChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "title" }));
    expect(onSortChange).toHaveBeenLastCalledWith([{ field: "title", direction: "asc" }]);

    rerender(
      <TableView
        schema={makeSchema()}
        records={makeRecords(1)}
        sort={[{ field: "title", direction: "asc" }]}
        onSortChange={onSortChange}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /title/ }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
    fireEvent.click(screen.getByRole("button", { name: /title/ }));
    expect(onSortChange).toHaveBeenLastCalledWith([{ field: "title", direction: "desc" }]);

    rerender(
      <TableView
        schema={makeSchema()}
        records={makeRecords(1)}
        sort={[{ field: "title", direction: "desc" }]}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /title/ }));
    expect(onSortChange).toHaveBeenLastCalledWith([]);
  });

  it("replaces the sort when another column is clicked", () => {
    const onSortChange = vi.fn();
    render(
      <TableView
        schema={makeSchema()}
        records={makeRecords(1)}
        sort={[{ field: "title", direction: "desc" }]}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "estimate" }));
    expect(onSortChange).toHaveBeenLastCalledWith([{ field: "estimate", direction: "asc" }]);
  });

  it("emits a cell change carrying the record, field, and value", () => {
    const onCellChange = vi.fn();
    render(
      <TableView schema={makeSchema()} records={makeRecords(1)} onCellChange={onCellChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Task 0" }));
    const input = screen.getByDisplayValue<HTMLInputElement>("Task 0");
    fireEvent.change(input, { target: { value: "Renamed task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-0",
      recordPath: "tasks/rec-0.md",
      field: "title",
      value: "Renamed task",
    });
  });

  it("shows the empty state when the collection has no records", () => {
    render(<TableView schema={makeSchema()} records={[]} />);
    expect(screen.getByText("No records in this collection yet.")).toBeDefined();
  });
});
