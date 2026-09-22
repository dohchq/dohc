// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @dnd-kit/dom references ResizeObserver while its module evaluates and
// tracks droppable geometry with IntersectionObserver. jsdom implements
// neither, so the stubs must exist before the imports below run.
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] {
      return [];
    }
  }
  Object.assign(globalThis, {
    ResizeObserver: ObserverStub,
    IntersectionObserver: ObserverStub,
  });
});

import { BoardView } from "./BoardView";
import { flaggedValue, indexedValue, makeGroup, makeRecord, makeSchema } from "../testSupport";

Element.prototype.scrollIntoView = () => {};
Document.prototype.getAnimations = () => [];
Element.prototype.getAnimations = () => [];
Document.prototype.elementFromPoint = () => null;
Element.prototype.animate = () => ({ finished: Promise.resolve() }) as unknown as Animation;
window.matchMedia = (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

// The column virtualizer measures its scroll element through offsetWidth
// and offsetHeight, which jsdom reports as 0. Give every element a nonzero
// box so cards render (TableView.test.tsx precedent).
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

/**
 * jsdom reports every rect as 0x0 at the origin, which would make every
 * column collide at the same point. Give an element real geometry so the
 * keyboard sensor's collision detection can tell columns apart. The drag
 * feedback moves the lifted card with a CSS translate, which a fixed rect
 * would hide, so the rect follows the element's translate style.
 */
function setRect(element: Element, x: number, y: number, width: number, height: number): void {
  element.getBoundingClientRect = () => {
    const translate =
      element instanceof HTMLElement ? element.style.getPropertyValue("--dnd-translate") : "";
    const match = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(translate ?? "");
    const left = x + (match ? Number(match[1]) : 0);
    const top = y + (match ? Number(match[2]) : 0);
    return {
      x: left,
      y: top,
      width,
      height,
      top,
      left,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function makeGroups() {
  return [
    makeGroup("todo", [
      makeRecord("rec-a", [
        indexedValue("title", "Write the spec"),
        indexedValue("status", "todo"),
        indexedValue("estimate", 3),
      ]),
    ]),
    makeGroup("doing", [
      makeRecord("rec-b", [indexedValue("title", "Ship the board"), indexedValue("status", "doing")]),
    ]),
  ];
}

/** Horizontal distance between adjacent column origins in layOutBoard. */
const COLUMN_PITCH = 300;
/**
 * How far one shifted arrow press moves a lifted card: the keyboard
 * sensor's 10px offset times its 5x shift factor.
 */
const SHIFTED_ARROW_PX = 50;
/**
 * Presses that cross one COLUMN_PITCH, plus one so the card lands well
 * inside the neighbor column instead of on its boundary.
 */
const ARROWS_TO_NEXT_COLUMN = Math.ceil(COLUMN_PITCH / SHIFTED_ARROW_PX) + 1;

/** Lays out the rendered columns side by side and the cards inside them. */
function layOutBoard(): void {
  const columns = screen.getAllByRole("list");
  // jsdom computes every overflow style as "", which @dnd-kit/dom reads as a
  // clipping ancestor; with 0x0 ancestor rects every droppable would be
  // invisible. Give the whole ancestor chain viewport-sized rects first,
  // then the real geometry below.
  let ancestor: Element | null = columns[0] ?? null;
  while (ancestor) {
    setRect(ancestor, 0, 0, 1024, 768);
    ancestor = ancestor.parentElement;
  }
  columns.forEach((column, index) => {
    setRect(column, index * COLUMN_PITCH + 10, 30, 240, 360);
    const columnElement = column.closest("section");
    if (columnElement) setRect(columnElement, index * COLUMN_PITCH, 0, 260, 400);
    within(column)
      .queryAllByRole("listitem")
      .forEach((card, cardIndex) => {
        setRect(card, index * COLUMN_PITCH + 20, 40 + cardIndex * 90, 220, 80);
        // The virtual-item wrappers between the card and its column read as
        // 0x0 clipping ancestors to @dnd-kit/dom; viewport-sized rects keep
        // them from hiding the card.
        let wrapper: Element | null = card.parentElement;
        while (wrapper && wrapper !== column) {
          setRect(wrapper, 0, 0, 1024, 768);
          wrapper = wrapper.parentElement;
        }
      });
  });
}

/** The lift's observable effect: isDragging renders the opacity-50 class. */
async function waitForLift(card: HTMLElement, lifted: boolean) {
  await waitFor(() => {
    expect(card.className.includes("opacity-50")).toBe(lifted);
  });
}

/** Keyboard drag per the default keyboard sensor: Enter lifts, arrows move, Enter drops. */
async function keyboardDrag(card: HTMLElement, arrows: { key: string; code: string }[]) {
  card.focus();
  fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
  await waitForLift(card, true);
  for (const arrow of arrows) {
    // The drag feedback writes each move to the card's translate style.
    const before = card.style.getPropertyValue("--dnd-translate");
    fireEvent.keyDown(card.ownerDocument, { ...arrow, shiftKey: true });
    await waitFor(() => {
      expect(card.style.getPropertyValue("--dnd-translate")).not.toBe(before);
    });
  }
  fireEvent.keyDown(card.ownerDocument, { key: "Enter", code: "Enter" });
  await waitForLift(card, false);
}

describe("BoardView", () => {
  it("renders a column per group with its label and count", () => {
    render(<BoardView schema={makeSchema()} groups={makeGroups()} groupBy="status" />);
    const columns = screen.getAllByRole("list");
    expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual(["todo", "doing"]);
    expect(within(columns[0]!).getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows the first visible field as the card title and the rest as cells", () => {
    render(
      <BoardView
        schema={makeSchema()}
        groups={makeGroups()}
        groupBy="status"
        visibleFields={["title", "estimate"]}
      />,
    );
    const card = screen.getByRole("listitem", { name: "Write the spec" });
    expect(within(card).getByText("Write the spec")).toBeDefined();
    expect(within(card).getByText("3")).toBeDefined();
    // The grouped field is not in visibleFields, so it stays off the card.
    expect(within(card).queryByText("todo")).toBeNull();
  });

  it("labels the null group No value and marks a flagged card with a warning dot", () => {
    const groups = [
      makeGroup(null, [makeRecord("rec-none", [indexedValue("title", "No status yet")])]),
      // A flagged grouped field groups under its raw value.
      makeGroup("shipped!!", [
        makeRecord("rec-flagged", [
          indexedValue("title", "Bad status"),
          flaggedValue("status", "shipped!!"),
        ]),
      ]),
    ];
    render(<BoardView schema={makeSchema()} groups={groups} groupBy="status" />);
    const columns = screen.getAllByRole("list");
    expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual([
      "No value",
      "shipped!!",
    ]);
    const flaggedCard = screen.getByRole("listitem", { name: "Bad status" });
    expect(within(flaggedCard).getByRole("img", { name: "Invalid value" })).toBeDefined();
    const cleanCard = screen.getByRole("listitem", { name: "No status yet" });
    expect(within(cleanCard).queryByRole("img", { name: "Invalid value" })).toBeNull();
  });

  it("emits the grouped-field change when a keyboard drag lands on another column", async () => {
    const onCellChange = vi.fn();
    render(
      <BoardView
        schema={makeSchema()}
        groups={makeGroups()}
        groupBy="status"
        onCellChange={onCellChange}
      />,
    );
    layOutBoard();
    const card = screen.getByRole("listitem", { name: "Write the spec" });
    await keyboardDrag(
      card,
      Array.from({ length: ARROWS_TO_NEXT_COLUMN }, () => ({
        key: "ArrowRight",
        code: "ArrowRight",
      })),
    );
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-a",
      recordPath: "tasks/rec-a.md",
      field: "status",
      value: "doing",
    });
  });

  it("emits null when a card lands on the No value column", async () => {
    const onCellChange = vi.fn();
    const groups = [
      makeGroup(null, []),
      makeGroup("doing", [
        makeRecord("rec-b", [indexedValue("title", "Ship the board"), indexedValue("status", "doing")]),
      ]),
    ];
    render(
      <BoardView schema={makeSchema()} groups={groups} groupBy="status" onCellChange={onCellChange} />,
    );
    layOutBoard();
    const card = screen.getByRole("listitem", { name: "Ship the board" });
    await keyboardDrag(
      card,
      Array.from({ length: ARROWS_TO_NEXT_COLUMN }, () => ({
        key: "ArrowLeft",
        code: "ArrowLeft",
      })),
    );
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-b",
      recordPath: "tasks/rec-b.md",
      field: "status",
      value: null,
    });
  });

  it("emits nothing when the drag is canceled or stays in its column", async () => {
    const onCellChange = vi.fn();
    render(
      <BoardView
        schema={makeSchema()}
        groups={makeGroups()}
        groupBy="status"
        onCellChange={onCellChange}
      />,
    );
    layOutBoard();
    const card = screen.getByRole("listitem", { name: "Write the spec" });

    // Escape cancels the lifted card.
    card.focus();
    fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
    await waitForLift(card, true);
    fireEvent.keyDown(card.ownerDocument, { key: "Escape", code: "Escape" });
    await waitForLift(card, false);

    // A drop without leaving the column keeps the field as it is.
    await keyboardDrag(card, []);
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("shows the empty state when no group has records", () => {
    render(
      <BoardView schema={makeSchema()} groups={[makeGroup("todo", []), makeGroup(null, [])]} groupBy="status" />,
    );
    expect(screen.getByText("No records in this collection yet.")).toBeDefined();
  });

  it("emits the card's record on click, not from a keyboard drag's Enter", async () => {
    const onOpenRecord = vi.fn();
    render(
      <BoardView
        schema={makeSchema()}
        groups={makeGroups()}
        groupBy="status"
        onOpenRecord={onOpenRecord}
        onCellChange={vi.fn()}
      />,
    );
    layOutBoard();
    const card = screen.getByRole("listitem", { name: "Write the spec" });
    fireEvent.click(card);
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "rec-a", path: "tasks/rec-a.md" }),
    );

    // Enter lifts the card for the keyboard drag sensor; it must not open.
    onOpenRecord.mockClear();
    await keyboardDrag(card, []);
    expect(onOpenRecord).not.toHaveBeenCalled();
  });

  it("does not lift read-only cards", async () => {
    render(<BoardView schema={makeSchema()} groups={makeGroups()} groupBy="status" />);
    layOutBoard();
    const card = screen.getByRole("listitem", { name: "Write the spec" });
    card.focus(); fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
    expect(card.className.includes("opacity-50")).toBe(false);
  });

  it("mounts only the cards near the column's viewport, and more on scroll", () => {
    const records = Array.from({ length: 60 }, (_, index) =>
      makeRecord(`rec-${index}`, [
        indexedValue("title", `Task ${index}`),
        indexedValue("status", "todo"),
      ]),
    );
    render(
      <BoardView schema={makeSchema()} groups={[makeGroup("todo", records)]} groupBy="status" />,
    );
    const column = screen.getByRole("list");
    // The stubbed 600px viewport holds a handful of cards; the rest of the
    // 60 stay unmounted.
    expect(within(column).getAllByRole("listitem").length).toBeLessThan(records.length);
    expect(within(column).queryByRole("listitem", { name: "Task 59" })).toBeNull();

    // Scrolling to the bottom mounts the late cards and unmounts the early.
    column.scrollTop = 60 * 600;
    fireEvent.scroll(column);
    expect(within(column).getByRole("listitem", { name: "Task 59" })).toBeDefined();
    expect(within(column).queryByRole("listitem", { name: "Task 0" })).toBeNull();
  });

  it("keeps a lifted card mounted while its column scrolls it out of view", async () => {
    const onCellChange = vi.fn();
    const records = Array.from({ length: 60 }, (_, index) =>
      makeRecord(`rec-${index}`, [
        indexedValue("title", `Task ${index}`),
        indexedValue("status", "todo"),
      ]),
    );
    render(
      <BoardView
        schema={makeSchema()}
        groups={[makeGroup("todo", records), makeGroup("doing", [])]}
        groupBy="status"
        onCellChange={onCellChange}
      />,
    );
    layOutBoard();
    const column = screen.getAllByRole("list")[0]!;
    const card = within(column).getByRole("listitem", { name: "Task 0" });
    card.focus();
    fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
    await waitForLift(card, true);

    // Autoscroll or a long keyboard drag can carry the column past the
    // lifted card's slot; the card must survive it, or the drag dies.
    column.scrollTop = 60 * 600;
    fireEvent.scroll(column);
    expect(within(column).getByRole("listitem", { name: "Task 0" })).toBe(card);
    expect(within(column).queryByRole("listitem", { name: "Task 1" })).toBeNull();

    // The drag still finishes: the drop lands (in place, so no change), and
    // with nothing lifted the far-scrolled card unmounts like any other.
    fireEvent.keyDown(card.ownerDocument, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(within(column).queryByRole("listitem", { name: "Task 0" })).toBeNull();
    });
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("opens the record from the card's focusable Open button", () => {
    const onOpenRecord = vi.fn();
    render(
      <BoardView
        schema={makeSchema()}
        groups={makeGroups()}
        groupBy="status"
        onOpenRecord={onOpenRecord}
      />,
    );
    const open = screen.getByRole("button", { name: "Open Write the spec" });
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "rec-a", path: "tasks/rec-a.md" }),
    );
  });
});
