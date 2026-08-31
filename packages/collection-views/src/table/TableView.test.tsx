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

  it("emits an option create carrying the record, field, option, and value", () => {
    const onCellChange = vi.fn();
    const onCreateOption = vi.fn();
    const records = [
      makeRecord("rec-0", [
        indexedValue("title", "Task 0"),
        indexedValue("status", "todo"),
      ]),
    ];
    render(
      <TableView
        schema={makeSchema()}
        records={records}
        onCellChange={onCellChange}
        onCreateOption={onCreateOption}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "todo" }));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "later" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-0",
      recordPath: "tasks/rec-0.md",
      field: "status",
      option: "later",
      value: "later",
    });
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("shows the empty state when the collection has no records", () => {
    render(<TableView schema={makeSchema()} records={[]} />);
    expect(screen.getByText("No records in this collection yet.")).toBeDefined();
  });

  it("emits the row's record from its Open control", () => {
    const onOpenRecord = vi.fn();
    render(
      <TableView schema={makeSchema()} records={makeRecords(2)} onOpenRecord={onOpenRecord} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Task 1" }));
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "rec-1", path: "tasks/rec-1.md" }),
    );
  });

  it("offers no Open control without onOpenRecord", () => {
    render(<TableView schema={makeSchema()} records={makeRecords(1)} />);
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
  });

  it("keeps relation cells read-only without a relation executor", () => {
    const records = [makeRecord("rec-0", [indexedValue("blocks", ["rec-a"])])];
    render(<TableView schema={makeSchema()} records={records} onCellChange={vi.fn()} />);
    expect(screen.getByText("rec-a")).toBeDefined();
    expect(screen.queryByRole("button", { name: "rec-a" })).toBeNull();
  });

  // jsdom has no hit-testing, so this asserts the structure that makes the
  // options clickable in the app: the editor lives in the table's overlay
  // above the rows, anchored to the first row's top edge, not inside the
  // fixed-height row where the option list would be clipped and its
  // geometry pushed under the column header.
  it("opens a first-row multi-select editor in the overlay, options clickable", () => {
    const onCellChange = vi.fn();
    const records = [
      makeRecord("rec-0", [indexedValue("title", "Task 0"), indexedValue("tags", ["alpha"])]),
      makeRecord("rec-1", [indexedValue("title", "Task 1")]),
    ];
    const { container } = render(
      <TableView schema={makeSchema()} records={records} onCellChange={onCellChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));

    const overlay = container.querySelector<HTMLElement>("[data-cell-editor]");
    expect(overlay).not.toBeNull();
    expect(overlay?.closest("[role='row']")).toBeNull();
    expect(overlay?.style.top).toBe("0px");
    const listbox = screen.getByRole("listbox");
    expect(overlay?.contains(listbox)).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-0",
      recordPath: "tasks/rec-0.md",
      field: "tags",
      value: ["alpha", "gamma"],
    });
  });

  it("keeps an open editor mounted with its state across a records refresh", () => {
    const recordsBefore = [
      makeRecord("rec-0", [indexedValue("title", "Task 0"), indexedValue("tags", ["alpha"])]),
    ];
    const { rerender } = render(
      <TableView
        schema={makeSchema()}
        records={recordsBefore}
        onCellChange={vi.fn()}
        onCreateOption={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    const listbox = screen.getByRole("listbox");
    const addOption = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(addOption, { target: { value: "half-typed" } });

    // The host's store refresh: a brand-new records array (and callbacks)
    // carrying the committed toggle. The editor must not unmount.
    const recordsAfter = [
      makeRecord("rec-0", [indexedValue("title", "Task 0"), indexedValue("tags", ["alpha", "beta"])]),
    ];
    rerender(
      <TableView
        schema={makeSchema()}
        records={recordsAfter}
        onCellChange={vi.fn()}
        onCreateOption={vi.fn()}
      />,
    );
    expect(listbox.isConnected).toBe(true);
    expect(addOption.isConnected).toBe(true);
    expect(addOption.value).toBe("half-typed");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "alpha" }).checked).toBe(true);
  });
});
