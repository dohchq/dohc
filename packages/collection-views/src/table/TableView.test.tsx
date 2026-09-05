// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TableView } from "./TableView";
import { indexedValue, makeRecord, makeSchema } from "../testSupport";

// The virtualizer measures its scroll element through offsetWidth and
// offsetHeight, which jsdom reports as 0. Give every element a nonzero box
// so rows render (CollectionPage.test.tsx precedent in apps/desktop).
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
  return Array.from({ length: count }, (_, index) =>
    makeRecord(`rec-${index}`, [indexedValue("title", `Task ${index}`)]),
  );
}

function scroller(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".overflow-auto");
  if (!element) throw new Error("no scroll element");
  return element;
}

describe("TableView paging", () => {
  it("calls onNearEnd when scrolling nears the end of the loaded rows", () => {
    const onNearEnd = vi.fn();
    const records = makeRecords(200);
    const { container } = render(
      <TableView schema={makeSchema()} records={records} onNearEnd={onNearEnd} />,
    );
    // The viewport renders the first ~26 rows of 200: nowhere near the end.
    expect(onNearEnd).not.toHaveBeenCalled();

    const element = scroller(container);
    element.scrollTop = records.length * 28;
    fireEvent.scroll(element);

    expect(onNearEnd).toHaveBeenCalled();
  });

  it("calls onNearEnd on first render when one page cannot outrun the viewport", () => {
    const onNearEnd = vi.fn();
    render(
      <TableView
        schema={makeSchema()}
        records={makeRecords(30)}
        onNearEnd={onNearEnd}
      />,
    );
    expect(onNearEnd).toHaveBeenCalled();
  });
});

describe("paused table editing", () => {
  it("keeps a typed multi-select option mounted and disabled until editing resumes", () => {
    const records = [makeRecord("rec-1", [indexedValue("tags", ["alpha"])])];
    const schema = makeSchema([{ name: "tags", type: "multi-select", options: ["alpha", "beta"] }]);
    const onCellChange = vi.fn(() => 1);
    const onCreateOption = vi.fn();
    const table = (editingDisabled: boolean) => (
      <TableView schema={schema} records={records} editingDisabled={editingDisabled}
        onCellChange={onCellChange} onCreateOption={onCreateOption} />
    );
    const view = render(table(false));
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "delta" } });
    view.rerender(table(true));
    expect(screen.getByLabelText("Add option")).toBe(input);
    expect(input.matches(":disabled")).toBe(true);
    fireEvent.blur(input);
    expect(onCreateOption).not.toHaveBeenCalled();
    expect(onCellChange).not.toHaveBeenCalled();

    view.rerender(table(false));
    expect(screen.getByLabelText("Add option")).toBe(input);
    expect(input.value).toBe("delta");
    expect(input.matches(":disabled")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-1", recordPath: records[0]!.path, field: "tags", option: "delta",
      value: ["alpha", "delta"], previousValues: [["alpha"]],
    });
  });

  it("does not commit or close a text draft when pausing blurs its input", () => {
    const records = [makeRecord("rec-1", [indexedValue("title", "Before")])];
    const schema = makeSchema([{ name: "title", type: "text" }]);
    const onCellChange = vi.fn(() => 1);
    const table = (editingDisabled: boolean) => (
      <TableView schema={schema} records={records} editingDisabled={editingDisabled} onCellChange={onCellChange} />
    );
    const view = render(table(false));
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "Draft" } });
    view.rerender(table(true));
    fireEvent.blur(input);
    expect(onCellChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBe(input);
    view.rerender(table(false));
    expect(input.value).toBe("Draft");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-1", recordPath: records[0]!.path, field: "title", value: "Draft",
    });
  });
});
