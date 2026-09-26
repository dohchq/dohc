// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("button fields", () => {
  it("shows a button column as a label that neither sorts nor edits", () => {
    const records = [makeRecord("rec-1", [indexedValue("title", "Invoice 12")])];
    const schema = makeSchema([
      { name: "title", type: "text" },
      { name: "Mark paid", type: "button" },
    ]);
    const onSortChange = vi.fn();
    const onCellChange = vi.fn(() => 1);
    render(
      <TableView
        schema={schema}
        records={records}
        onSortChange={onSortChange}
        onCellChange={onCellChange}
      />,
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["title", "Mark paid"]);
    expect(screen.queryByRole("button", { name: "Mark paid" })).toBeNull();
    fireEvent.click(headers[1]!);
    fireEvent.click(screen.getAllByText("Mark paid")[1]!);
    expect(onSortChange).not.toHaveBeenCalled();
    expect(onCellChange).not.toHaveBeenCalled();
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
  });

  it("lets the host draw each button cell for its record, and never a text field's", () => {
    const records = [makeRecord("rec-1", [indexedValue("title", "Invoice 12")])];
    const schema = makeSchema([
      { name: "title", type: "text" },
      { name: "Mark paid", type: "button" },
    ]);
    const renderButton = vi.fn((field: { name: string }, record: { id: string }) => (
      <button type="button">{`${field.name} for ${record.id}`}</button>
    ));
    render(<TableView schema={schema} records={records} renderButton={renderButton} />);
    expect(screen.getByRole("button", { name: "Mark paid for rec-1" })).toBeDefined();
    expect(renderButton.mock.calls.every(([field]) => field.name === "Mark paid")).toBe(true);
    expect(screen.getByText("Invoice 12")).toBeDefined();
  });
});

describe("field marks", () => {
  it("shows a field's mark after its name, and says what it means without renaming the sort control", () => {
    const schema = makeSchema([{ name: "title", type: "text" }, { name: "done", type: "checkbox" }]);
    const marks = new Map([["done", { icon: <svg data-testid="mark-icon" />, label: '"Stamp" sets this field' }]]);
    const onSortChange = vi.fn();
    render(<TableView schema={schema} records={makeRecords(1)} fieldMarks={marks} onSortChange={onSortChange} />);

    const done = screen.getByRole("button", { name: "done" });
    const description = document.getElementById(done.getAttribute("aria-describedby") ?? "");
    expect(description?.getAttribute("role")).toBe("tooltip");
    expect(description?.textContent).toBe('"Stamp" sets this field');
    expect(done.querySelector('[data-testid="mark-icon"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "title" }).hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getAllByTestId("table-field-mark")).toHaveLength(1);

    fireEvent.click(done);
    expect(onSortChange).toHaveBeenCalledWith([{ field: "done", direction: "asc" }]);
  });

  it("shows the words on hover and focus, keeps them while the pointer is on them, and hides them on Escape", () => {
    const schema = makeSchema([{ name: "done", type: "checkbox" }]);
    const marks = new Map([["done", { icon: <svg />, label: '"Stamp" sets this field' }]]);
    render(<TableView schema={schema} records={makeRecords(1)} fieldMarks={marks} />);
    const done = screen.getByRole("button", { name: "done" });
    const words = document.getElementById(done.getAttribute("aria-describedby") ?? "")!;
    const header = screen.getByRole("columnheader", { name: /done/ });
    expect(words.hidden).toBe(true);

    fireEvent.mouseEnter(header);
    expect(words.hidden).toBe(false);
    // The words sit inside the header, so moving onto them keeps them open.
    fireEvent.mouseOver(words);
    expect(words.hidden).toBe(false);
    fireEvent.mouseLeave(header);
    expect(words.hidden).toBe(true);

    // Focus that a pointer press gives, as when a click sorts the column, shows nothing.
    fireEvent.pointerDown(done);
    act(() => done.focus());
    fireEvent.pointerUp(done);
    expect(words.hidden).toBe(true);
    act(() => done.blur());
    act(() => done.focus());
    expect(words.hidden).toBe(false);
    // Escape on the sort control closes the words and nothing around them.
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(done, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(words.hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    act(() => done.blur());

    // Words the pointer opened close on Escape wherever focus is, and
    // leaving focus does not close words the pointer holds open.
    fireEvent.mouseEnter(header);
    act(() => done.focus());
    act(() => done.blur());
    expect(words.hidden).toBe(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(words.hidden).toBe(true);
  });

  it("closes every open mark's words with one Escape, even when the focused mark stops the key", () => {
    const schema = makeSchema([{ name: "title", type: "text" }, { name: "done", type: "checkbox" }]);
    const marks = new Map([
      ["title", { icon: <svg />, label: '"Name" sets this field' }],
      ["done", { icon: <svg />, label: '"Stamp" sets this field' }],
    ]);
    render(<TableView schema={schema} records={makeRecords(1)} fieldMarks={marks} />);
    const title = screen.getByRole("button", { name: "title" });
    const words = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-describedby") ?? "")!;
    const done = screen.getByRole("button", { name: "done" });
    act(() => title.focus());
    fireEvent.mouseEnter(screen.getByRole("columnheader", { name: /done/ }));
    expect([words(title).hidden, words(done).hidden]).toEqual([false, false]);

    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(title, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect([words(title).hidden, words(done).hidden]).toEqual([true, true]);
    // The focused mark still keeps the key from the surface around it.
    expect(outer).not.toHaveBeenCalled();
  });
});
