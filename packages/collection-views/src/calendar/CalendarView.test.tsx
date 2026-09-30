// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom cannot lay out react-big-calendar's month grid, so a real pointer
// drag has nothing to hit-test against. The addon mock renders the real
// Calendar plus one drop trigger per event that reports a drop two days
// later, which exercises everything this package owns: event mapping and
// the drop-to-change wiring. The real drag runs in the desktop e2e
// walkthrough.
vi.mock("react-big-calendar/lib/addons/dragAndDrop", async () => {
  const { createElement, Fragment } = await import("react");
  const { addDays: shift } = await import("date-fns/addDays");
  interface MockEvent {
    record: { id: string };
    start: Date;
    end: Date;
  }
  interface MockProps {
    events?: MockEvent[];
    onEventDrop?: (args: { event: MockEvent; start: Date; end: Date }) => void;
  }
  return {
    default: (CalendarComponent: React.ComponentType<object>) =>
      function MockDnDCalendar(props: MockProps) {
        return createElement(
          Fragment,
          null,
          createElement(CalendarComponent, props),
          props.events?.map((event) =>
            createElement("button", {
              key: event.record.id,
              type: "button",
              "data-testid": `drop-${event.record.id}`,
              onClick: () =>
                props.onEventDrop?.({
                  event,
                  start: shift(event.start, 2),
                  end: shift(event.end, 2),
                }),
            }),
          ),
        );
      },
  };
});

import { CalendarView } from "./CalendarView";
import { flaggedValue, indexedValue, makeRecord, makeSchema, V1_FIELDS } from "../testSupport";

afterEach(() => {
  cleanup();
});

const AUGUST = new Date(2026, 7, 15);

function makeRecords() {
  return [
    makeRecord("rec-dated", [indexedValue("title", "Book flights"), indexedValue("due", "2026-08-10")]),
    makeRecord("rec-invalid", [
      indexedValue("title", "Bad date"),
      flaggedValue("due", "not-a-date", "invalid-date"),
    ]),
    makeRecord("rec-undated", [indexedValue("title", "No date yet")]),
  ];
}

describe("CalendarView", () => {
  it("renders an event for each record with a valid keyed date", () => {
    render(
      <CalendarView schema={makeSchema()} records={makeRecords()} dateField="due" defaultDate={AUGUST} />,
    );
    expect(screen.getByText("Book flights")).toBeDefined();
  });

  it("does not render records whose keyed date is invalid or missing", () => {
    render(
      <CalendarView schema={makeSchema()} records={makeRecords()} dateField="due" defaultDate={AUGUST} />,
    );
    expect(screen.queryByText("Bad date")).toBeNull();
    expect(screen.queryByText("No date yet")).toBeNull();
  });

  it("emits the date change when an event is dropped on another day", () => {
    const onCellChange = vi.fn();
    render(
      <CalendarView
        schema={makeSchema()}
        records={makeRecords()}
        dateField="due"
        defaultDate={AUGUST}
        onCellChange={onCellChange}
      />,
    );
    fireEvent.click(screen.getByTestId("drop-rec-dated"));
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-dated",
      recordPath: "tasks/rec-dated.md",
      field: "due",
      value: "2026-08-12",
    });
  });

  it("re-renders from the other field when rekeyed by prop", () => {
    const schema = makeSchema([...V1_FIELDS, { name: "shipped", type: "date" }]);
    const records = [
      makeRecord("rec-due", [indexedValue("title", "Due only"), indexedValue("due", "2026-08-10")]),
      makeRecord("rec-shipped", [
        indexedValue("title", "Shipped only"),
        indexedValue("shipped", "2026-08-20"),
      ]),
    ];
    const { rerender } = render(
      <CalendarView schema={schema} records={records} dateField="due" defaultDate={AUGUST} />,
    );
    expect(screen.getByText("Due only")).toBeDefined();
    expect(screen.queryByText("Shipped only")).toBeNull();

    rerender(
      <CalendarView schema={schema} records={records} dateField="shipped" defaultDate={AUGUST} />,
    );
    expect(screen.queryByText("Due only")).toBeNull();
    expect(screen.getByText("Shipped only")).toBeDefined();
  });

  it("shows the empty state when the collection has no records", () => {
    render(<CalendarView schema={makeSchema()} records={[]} dateField="due" />);
    expect(screen.getByText("No records in this collection yet.")).toBeDefined();
  });

  it("emits the event's record when the event is selected", () => {
    const onOpenRecord = vi.fn();
    render(
      <CalendarView
        schema={makeSchema()}
        records={makeRecords()}
        dateField="due"
        defaultDate={AUGUST}
        onOpenRecord={onOpenRecord}
      />,
    );
    fireEvent.click(screen.getByText("Book flights"));
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "rec-dated", path: "tasks/rec-dated.md" }),
    );
  });
});
