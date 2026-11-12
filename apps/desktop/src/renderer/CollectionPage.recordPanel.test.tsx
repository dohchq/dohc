// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CollectionRecord, CollectionRecordGroup, CollectionSchema, CollectionValue } from "@dohc/workspace-contracts";
import type { GetCollectionResult, QueryCollectionRecordsPayload, QueryCollectionRecordsResult, WorkspaceActivityEvent } from "../ipc/bridgeContract";
import { CollectionPage, FIND_RECORD_LIMIT, FIND_RECORD_PAGE, type CollectionPageProps } from "./CollectionPage";
import { resetAutomationButtonsForTests } from "./collections/useAutomationButtons";
import { CollectionFieldWriteHost, resetCollectionFieldWritesForTests } from "./collections/recordFieldWrites";
import type { UseEngineDoc } from "./collab/useEngineDoc";

// A document Collection's record, open in the panel beside its view. The
// page, the panel, the fields and the write queue are real. The record's
// body is the shell's to draw, so a stand-in shows which file it was asked for.

// The board's drag library and the table's virtualizer need what jsdom lacks (CollectionPage.test.tsx).
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] {
      return [];
    }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
});

// A field write opens the record's live document. Here that is a real Y.Doc, so a write shows in its frontmatter.
const docMock = vi.hoisted(() => ({ current: null as UseEngineDoc | null }));
vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: (): unknown => {
    if (docMock.current === null) throw new Error("docMock.current unset");
    return docMock.current;
  },
}));
vi.mock("./collections/recordSourceCheck", () => ({
  useRecordSourceCheck: () => ({ state: "clear", contentHash: "c".repeat(64) }),
}));
// The ⚡ panel stands aside. It answers a close ask as the real one does: it closes, or, while it
// holds a draft the person keeps, it stays and says so.
vi.mock("./collections/AutomationsPanel", async (original) => {
  const actual = await original<typeof import("./collections/AutomationsPanel")>();
  const { useEffect, useRef, useState } = await import("react");
  return {
    ...actual,
    AutomationsPanel: (props: { closeAsk?: number; onClose: () => void; onStayed?: () => void }) => {
      const [draft, setDraft] = useState(false);
      const answered = useRef(props.closeAsk ?? 0);
      useEffect(() => {
        const ask = props.closeAsk ?? 0;
        if (ask <= answered.current) return;
        answered.current = ask;
        if (draft) props.onStayed?.();
        else props.onClose();
      }, [props.closeAsk]);
      return (
        <aside aria-label="Automations">
          <label>
            <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
            Holds a draft
          </label>
        </aside>
      );
    },
  };
});

function engineDoc(partial: Partial<UseEngineDoc>): UseEngineDoc {
  return {
    available: false, opening: false, doc: null, saveState: { kind: "saved-here" }, saveError: null,
    readOnlyWhileEditing: false, deletedWhileEditing: false, ...partial,
  } as UseEngineDoc;
}
/** The live document of record `id`, which the page's writes reach. */
function liveDoc(id = "rec-1"): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("frontmatter").set("id", id);
  docMock.current = engineDoc({ available: true, doc });
  return doc;
}

const offsets = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
});
afterEach(() => {
  cleanup();
  resetAutomationButtonsForTests();
  vi.unstubAllGlobals();
  docMock.current = null;
  resetCollectionFieldWritesForTests();
  for (const [name, descriptor] of Object.entries(offsets)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

const TASKS: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [
    { name: "title", type: "text" },
    { name: "done", type: "checkbox" },
    { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma"] },
    { name: "notes", type: "text" },
  ],
  views: [],
};
const value = (field: string, held: CollectionValue) => ({ field, value: held, validation: { status: "valid" as const }, resolvedRelations: [] });
function task(id: string, title: string | null, path = `tasks/${title ?? id}.md`): CollectionRecord {
  return { id, path, conflicted: false, values: [value("title", title), value("done", false), value("tags", ["alpha"]), value("notes", null)] };
}

const SUMMARY = { path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] };
function makeBridge(records: CollectionRecord[], schema: CollectionSchema = TASKS, groups?: () => CollectionRecordGroup[]) {
  const listeners = new Set<(event: WorkspaceActivityEvent) => void>();
  return {
    /** The Collection's records, which a test changes in place. */
    records,
    /** Tells the page the Collection's files changed. */
    changed: () => {
      for (const listener of [...listeners]) listener({ workspaceId: "ws-1", paths: ["tasks/Plan.md"] });
    },
    getCollection: vi.fn(async (): Promise<GetCollectionResult> => ({ ...SUMMARY, schema, recordCount: records.length })),
    // Pages as the engine does: `limit` records after the cursor's record, and a cursor while more remain.
    queryCollectionRecords: vi.fn(async (params: QueryCollectionRecordsPayload): Promise<QueryCollectionRecordsResult> => {
      const limit = params.limit ?? 100;
      const from = params.cursor ? records.findIndex((record) => record.id === params.cursor?.recordId) + 1 : 0;
      const page = records.slice(from, from + limit), last = page.at(-1);
      return {
        collection: SUMMARY,
        records: page,
        groups: params.groupBy && groups ? groups() : null,
        nextCursor: last && from + limit < records.length ? { sortValues: [], recordPath: last.path, recordId: last.id } : null,
      };
    }),
    onWorkspaceActivity: vi.fn((listener: (event: WorkspaceActivityEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    listCollections: vi.fn(async () => ({ collections: [SUMMARY] })),
    listCollectionAutomations: vi.fn(async () => ({ status: "missing" as const })),
    listAutomationPeople: vi.fn(async () => ({ status: "unavailable" as const })),
    listAutomationButtons: vi.fn(async () => ({ buttons: [] })),
    listAutomationHolds: vi.fn(async () => ({ holds: [], unreadable: false })),
    onCollectionAutomationsChanged: vi.fn(() => () => undefined),
    onAutomationRunSettled: vi.fn(() => () => undefined),
    onAutomationRunWaiting: vi.fn(() => () => undefined),
    openExternalUrl: vi.fn(async () => undefined),
  };
}
/** The queries that looked for the open record by its id, and not the view's own. */
const searches = (bridge: ReturnType<typeof makeBridge>) =>
  bridge.queryCollectionRecords.mock.calls.filter(([params]) => params.limit === FIND_RECORD_PAGE);

/** What the shell draws as a record's body: the file's text, where a caret can be, and a control of the file's view. */
const body = (path: string) => (
  <div data-testid="record-body" data-path={path}>
    <div data-testid="body-text" contentEditable suppressContentEditableWarning tabIndex={0} />
    <button type="button">Source</button>
  </div>
);

function page(props: Partial<CollectionPageProps> = {}) {
  return (
    <>
      <CollectionPage
        workspaceId="ws-1"
        collectionPath="tasks"
        activeViewName={null}
        onActiveViewChange={() => undefined}
        onNewRecord={() => undefined}
        onOpenRecord={() => undefined}
        onOpenFile={() => undefined}
        onOpenScheduleSettings={() => undefined}
        onError={() => undefined}
        onNotice={() => undefined}
        automationFocus={null}
        onAutomationFocused={() => undefined}
        renderRecordBody={body}
        {...props}
      />
      <CollectionFieldWriteHost />
    </>
  );
}
function renderPage(bridge: ReturnType<typeof makeBridge>, props: Partial<CollectionPageProps> = {}) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(page(props));
}

const grid = () => screen.getByRole("grid");
const rowAt = (row: number) => grid().querySelector<HTMLElement>(`[role="row"][data-index="${row}"]`)!;
/** The cell of the record in row `row` under the column named `field`. */
function cell(field: string, row = 0): HTMLElement {
  const column = within(grid()).getAllByRole("columnheader").findIndex((header) => header.textContent === field);
  const found = column < 0 ? undefined : rowAt(row).querySelectorAll<HTMLElement>('[role="gridcell"]')[column];
  if (!found) throw new Error(`no ${field} cell in row ${row}`);
  return found;
}
/** The rows the table marks as the open record's. */
const marked = () => [...grid().querySelectorAll('[role="row"][aria-current="true"]')].map((row) => row.getAttribute("data-index"));
/** The record panel. A test that also shows the ⚡ panel names the one it means. */
const panel = () => screen.getByRole("complementary");
const sides = () => screen.queryAllByRole("complementary").map((side) => side.getAttribute("aria-label"));
/** Opens a record from its row, as a person does, with focus on what they pressed. */
function open(name: string): HTMLElement {
  const control = screen.getByRole("button", { name: `Open ${name}` });
  control.focus();
  fireEvent.click(control);
  return control;
}
const property = (field: string) => within(panel()).getByRole("group", { name: field });
const propertyValue = (field: string) => within(property(field)).getAllByRole("button")[0]!;
const propertyEditor = (field: string) => property(field).querySelector<HTMLElement>("[data-cell-editor]");
const propertyInput = (field: string) => propertyEditor(field)!.querySelector<HTMLInputElement>("input")!;
const nameButton = () => within(within(panel()).getByRole("heading")).getByRole("button");
const shownBody = () => within(panel()).getByTestId("record-body");

describe("a document record's panel", () => {
  it("opens a record beside the table from its row and from Ctrl+Enter on a selected cell, marks its row, and leaves the table in use and its rows as they were", async () => {
    const doc = liveDoc();
    const onOpenRecord = vi.fn(), onOpenRecordChange = vi.fn();
    renderPage(makeBridge([task("rec-1", "Plan"), task("rec-2", "Socks")]), { onOpenRecord, onOpenRecordChange });
    await screen.findByRole("button", { name: "Open Plan" });
    const row = rowAt(0), tick = within(row).getByRole("checkbox");

    open("Plan");
    const record = screen.getByRole("complementary", { name: "Plan" });
    expect(document.activeElement).toBe(record);
    expect(within(record).getByRole("heading", { name: "Plan" })).toBeTruthy();
    // The record's file opens in no tab, and the shell keeps the record by its id.
    expect(onOpenRecord).not.toHaveBeenCalled();
    expect(onOpenRecordChange).toHaveBeenLastCalledWith("rec-1");
    expect(marked()).toEqual(["0"]);

    // Opening and resizing the panel built no row of the table again.
    fireEvent.keyDown(within(record).getByRole("separator", { name: "Resize record" }), { key: "ArrowLeft" });
    expect(rowAt(0)).toBe(row);
    expect(within(rowAt(0)).getByRole("checkbox")).toBe(tick);

    // The table stays in use: a selected cell's record opens in place of the first, and a cell still takes a change.
    fireEvent.click(cell("done", 1));
    fireEvent.keyDown(grid(), { key: "Enter", ctrlKey: true });
    expect(sides()).toEqual(["Socks"]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith("rec-2");
    expect(marked()).toEqual(["1"]);
    fireEvent.click(within(rowAt(0)).getByRole("checkbox"));
    await waitFor(() => expect(doc.getMap("frontmatter").get("done")).toBe(true));

    fireEvent.click(within(panel()).getByRole("button", { name: "Close record" }));
    expect(sides()).toEqual([]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith(null);
    expect(marked()).toEqual([]);
    expect(rowAt(0)).toBe(row);
  });

  it("opens a board card's record in the panel and marks the card", async () => {
    const schema: CollectionSchema = {
      ...TASKS,
      fields: [{ name: "title", type: "text" }, { name: "status", type: "select", options: ["Todo"] }],
      views: [{ name: "Board", kind: "board", groupBy: "status", sort: [], visibleFields: null, dateField: null }],
    };
    const plan: CollectionRecord = { id: "rec-1", path: "tasks/Plan.md", conflicted: false, values: [value("title", "Plan"), value("status", "Todo")] };
    const onOpenRecord = vi.fn();
    renderPage(makeBridge([plan], schema, () => [{ value: "Todo", records: [plan] }]), { onOpenRecord });
    fireEvent.click(await screen.findByRole("listitem", { name: "Plan" }));
    expect(sides()).toEqual(["Plan"]);
    expect(screen.getByRole("listitem", { name: "Plan" }).getAttribute("aria-current")).toBe("true");
    expect(shownBody().dataset.path).toBe("tasks/Plan.md");
    expect(onOpenRecord).not.toHaveBeenCalled();
  });

  it("opens a calendar entry's record in the panel and marks the entry", async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const schema: CollectionSchema = {
      ...TASKS,
      fields: [{ name: "title", type: "text" }, { name: "due", type: "date" }],
      views: [{ name: "Calendar", kind: "calendar", groupBy: null, sort: [], visibleFields: null, dateField: "due" }],
    };
    const plan: CollectionRecord = { id: "rec-1", path: "tasks/Plan.md", conflicted: false, values: [value("title", "Plan"), value("due", today)] };
    const onOpenRecord = vi.fn();
    renderPage(makeBridge([plan], schema), { onOpenRecord });
    fireEvent.click(await screen.findByText("Plan"));
    expect(sides()).toEqual(["Plan"]);
    expect(document.querySelector(".rbc-event")?.className).toContain("ring-2");
    expect(onOpenRecord).not.toHaveBeenCalled();
  });

  it("shows the record's name, a row for each other field of the Collection, then the page of the record's own file", async () => {
    renderPage(makeBridge([task("rec-1", "Plan"), task("rec-2", "Socks")]));
    await screen.findByRole("button", { name: "Open Plan" });
    open("Socks");
    expect(within(panel()).getByRole("heading", { name: "Socks" })).toBeTruthy();
    // The name is the heading, so its field has no row.
    expect(within(panel()).getAllByRole("group").map((row) => row.getAttribute("data-property"))).toEqual(["done", "tags", "notes"]);
    expect(shownBody().dataset.path).toBe("tasks/Socks.md");
    expect(property("notes").compareDocumentPosition(shownBody()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("writes a field changed in the panel as the table's cell does, with a pick the index has not shown yet", async () => {
    const doc = liveDoc();
    doc.getMap("frontmatter").set("tags", ["alpha"]);
    const view = renderPage(makeBridge([task("rec-1", "Plan")]));
    // The queue sends its next write once the live document has saved the one before.
    const saves = () => {
      for (const kind of ["saving", "saved-here"] as const) {
        docMock.current = engineDoc({ available: true, doc, saveState: { kind } });
        view.rerender(page());
      }
    };
    await screen.findByRole("button", { name: "Open Plan" });
    open("Plan");

    fireEvent.click(within(property("done")).getByRole("checkbox"));
    await waitFor(() => expect(doc.getMap("frontmatter").get("done")).toBe(true));
    saves();

    fireEvent.click(propertyValue("notes"));
    fireEvent.change(propertyInput("notes"), { target: { value: "Buy wool" } });
    fireEvent.keyDown(propertyInput("notes"), { key: "Enter" });
    await waitFor(() => expect(doc.getMap("frontmatter").get("notes")).toBe("Buy wool"));
    saves();

    // A picker saves its picks on a press away. The second pick adds to the first, which the Collection's index has not shown yet.
    for (const tag of ["beta", "gamma"]) {
      fireEvent.click(propertyValue("tags"));
      fireEvent.click(screen.getByRole("option", { name: tag }));
      fireEvent.pointerDown(document.body);
      saves();
    }
    await waitFor(() => expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta", "gamma"]));
  });

  it("shows a change from the panel that dohc did not save where the table's cell shows it", async () => {
    // The record's live document does not open, so the write fails.
    docMock.current = engineDoc({ available: false });
    renderPage(makeBridge([task("rec-1", "Plan")]));
    await screen.findByRole("button", { name: "Open Plan" });
    open("Plan");
    fireEvent.click(within(property("done")).getByRole("checkbox"));
    expect((await screen.findByTestId("collection-write-error")).textContent).toBe("dohc did not save this change.");
    expect(sides()).toEqual(["Plan"]);
  });

  it("renames a record in its heading where its name is a text field, through the cell's write, and shows a record named by its file as text", async () => {
    const doc = liveDoc();
    renderPage(makeBridge([task("rec-1", "Plan"), task("rec-2", null, "tasks/Draft.md")]));
    await screen.findByRole("button", { name: "Open Plan" });
    open("Plan");
    fireEvent.click(nameButton());
    const input = within(panel()).getByRole("textbox", { name: "title" });
    fireEvent.change(input, { target: { value: "Plan B" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doc.getMap("frontmatter").get("title")).toBe("Plan B"));

    // A record with no title is named by its file, which no cell writes. Its title is a row to fill in.
    open("Draft");
    const heading = within(screen.getByRole("complementary", { name: "Draft" })).getByRole("heading", { name: "Draft" });
    expect(within(heading).queryByRole("button")).toBeNull();
    expect(property("title")).toBeTruthy();
  });

  it("closes the innermost thing on Escape, leaves Escape to text typed in the body, and returns focus to what opened the record", async () => {
    renderPage(makeBridge([task("rec-1", "Plan")]));
    await screen.findByRole("button", { name: "Open Plan" });
    const opener = open("Plan");
    const record = panel();

    fireEvent.click(propertyValue("notes"));
    fireEvent.keyDown(propertyInput("notes"), { key: "Escape" });
    expect(propertyEditor("notes")).toBeNull();
    expect(panel()).toBe(record);

    fireEvent.click(nameButton());
    fireEvent.keyDown(within(record).getByRole("textbox", { name: "title" }), { key: "Escape" });
    expect(within(record).queryByRole("textbox")).toBeNull();
    expect(panel()).toBe(record);

    // The caret is in the body's text: Escape is the editor's, however often it is pressed.
    const text = within(record).getByTestId("body-text");
    text.focus();
    fireEvent.keyDown(text, { key: "Escape" });
    fireEvent.keyDown(text, { key: "Escape" });
    expect(panel()).toBe(record);
    expect(document.activeElement).toBe(text);

    // An input method's Escape belongs to its composition.
    fireEvent.keyDown(record, { key: "Escape", keyCode: 229 });
    expect(panel()).toBe(record);

    // From a control of the body that types no text, Escape closes the record.
    fireEvent.keyDown(within(record).getByRole("button", { name: "Source" }), { key: "Escape" });
    expect(sides()).toEqual([]);
    expect(document.activeElement).toBe(opener);
  });

  it("closes the open record before the table clears its selection", async () => {
    renderPage(makeBridge([task("rec-1", "Plan")]));
    await screen.findByRole("button", { name: "Open Plan" });
    fireEvent.click(cell("done"));
    fireEvent.keyDown(grid(), { key: "Enter", ctrlKey: true });
    expect(document.activeElement).toBe(panel());
    grid().focus();
    fireEvent.keyDown(grid(), { key: "Escape" });
    expect(sides()).toEqual([]);
    expect(cell("done").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(grid());
    fireEvent.keyDown(grid(), { key: "Escape" });
    expect(cell("done").getAttribute("aria-selected")).toBeNull();
  });

  it("opens the record the shell kept by its id without taking focus, and keeps it through a rename of its file", async () => {
    const onOpenRecordChange = vi.fn();
    const bridge = makeBridge([task("rec-1", "Plan")]);
    renderPage(bridge, { initialOpenRecord: "rec-1", onOpenRecordChange });
    const record = await screen.findByRole("complementary", { name: "Plan" });
    expect(record.contains(document.activeElement)).toBe(false);
    expect(marked()).toEqual(["0"]);
    expect(shownBody().dataset.path).toBe("tasks/Plan.md");

    // The file moves and takes another name. The record is the same one, so its panel stays and shows the file where it is now.
    bridge.records[0] = task("rec-1", "Plan", "tasks/archive/Plan 2026.md");
    act(() => bridge.changed());
    await waitFor(() => expect(shownBody().dataset.path).toBe("tasks/archive/Plan 2026.md"));
    expect(panel()).toBe(record);
    expect(record.contains(document.activeElement)).toBe(false);
    expect(onOpenRecordChange).not.toHaveBeenCalled();
  });

  it("says in one line that a kept record is gone or could not be read, offers Close, and shows no other record", async () => {
    const onOpenRecordChange = vi.fn();
    renderPage(makeBridge([task("rec-1", "Plan")]), { initialOpenRecord: "rec-9", onOpenRecordChange });
    const gone = await within(await screen.findByRole("complementary", { name: "Record" })).findByText("This record is no longer in this Collection.");
    expect(gone.getAttribute("role")).toBe("status");
    expect(within(panel()).queryByRole("heading")).toBeNull();
    expect(within(panel()).queryByTestId("record-body")).toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(sides()).toEqual([]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith(null);
    cleanup();

    const failing = makeBridge([task("rec-1", "Plan")]);
    const read = failing.queryCollectionRecords.getMockImplementation()!;
    failing.queryCollectionRecords.mockImplementation(async (params) => {
      if (params.limit === FIND_RECORD_PAGE) throw new Error("Lost reply");
      return read(params);
    });
    renderPage(failing, { initialOpenRecord: "rec-9" });
    expect(await screen.findByText("dohc could not read this record. Close it, then open it again.")).toBeTruthy();
    expect(within(panel()).queryByRole("heading")).toBeNull();
  });

  it("finds a kept record the table has not loaded by its id, and reads it again from its page of records when the Collection changes", async () => {
    const records = Array.from({ length: 600 }, (_, index) => task(`rec-${index}`, `Task ${index}`));
    const bridge = makeBridge(records);
    renderPage(bridge, { initialOpenRecord: "rec-550" });
    const record = await screen.findByRole("complementary", { name: "Task 550" });
    expect(shownBody().dataset.path).toBe("tasks/Task 550.md");
    // The table holds its first records only. The search read the Collection a page at a time, up to the record's.
    expect(screen.queryByRole("button", { name: "Open Task 550" })).toBeNull();
    expect(searches(bridge)).toHaveLength(2);

    records[550] = task("rec-550", "Task 550, done", "tasks/Task 550.md");
    act(() => bridge.changed());
    await screen.findByRole("complementary", { name: "Task 550, done" });
    // The record kept its panel through the read, and one query of its own page found it.
    expect(panel()).toBe(record);
    expect(searches(bridge)).toHaveLength(3);
  });

  it("stops looking for a kept record after the search's limit, and says so", async () => {
    const bridge = makeBridge([task("rec-1", "Plan")]);
    const read = bridge.queryCollectionRecords.getMockImplementation()!;
    // A Collection with more records than the search reads, none of them the kept one.
    bridge.queryCollectionRecords.mockImplementation(async (params) => params.limit === FIND_RECORD_PAGE
      ? { collection: SUMMARY, records: [], groups: null, nextCursor: { sortValues: [], recordPath: "tasks/Plan.md", recordId: "rec-1" } }
      : read(params));
    renderPage(bridge, { initialOpenRecord: "rec-9" });
    expect(await screen.findByText("dohc could not find this record in the first 5,000 records. Close it, then open it from its view.")).toBeTruthy();
    expect(searches(bridge)).toHaveLength(FIND_RECORD_LIMIT / FIND_RECORD_PAGE);
  });

  it("keeps the record one copy of a tab still shows in the tab's saved entry when another copy closes its own, and never makes one copy follow the other", async () => {
    vi.stubGlobal("dohcDesktop", makeBridge([task("rec-1", "Plan"), task("rec-2", "Socks")]));
    // Two editor groups show the Collection's tab. The tab has one saved entry, which both copies read and write.
    function TwoCopies() {
      const [kept, setKept] = useState<string | null>(null);
      return (
        <>
          {["Left", "Right"].map((group) => <div key={group} data-testid={group}>{page({ initialOpenRecord: kept, onOpenRecordChange: setKept })}</div>)}
          <output aria-label="Kept record">{kept ?? "none"}</output>
        </>
      );
    }
    render(<TwoCopies />);
    const copy = (group: string) => within(screen.getByTestId(group));
    const kept = () => screen.getByRole("status", { name: "Kept record" }).textContent;
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open Plan" })).toHaveLength(2));
    fireEvent.click(copy("Left").getByRole("button", { name: "Open Plan" }));
    expect(kept()).toBe("rec-1");
    expect(copy("Right").queryByRole("complementary")).toBeNull();
    fireEvent.click(copy("Right").getByRole("button", { name: "Open Socks" }));
    expect(kept()).toBe("rec-2");
    expect(copy("Left").getByRole("complementary", { name: "Plan" })).toBeTruthy();
    // The right copy closes its record. The left one still shows a record, so the entry holds that one.
    fireEvent.click(within(copy("Right").getByRole("complementary")).getByRole("button", { name: "Close record" }));
    expect(kept()).toBe("rec-1");
    expect(copy("Right").queryByRole("complementary")).toBeNull();
    fireEvent.click(within(copy("Left").getByRole("complementary")).getByRole("button", { name: "Close record" }));
    expect(kept()).toBe("none");
  });

  it("shows one side panel at a time: a record asks the ⚡ panel to close first, opens nothing while that panel keeps a draft, and closes when the ⚡ panel opens", async () => {
    const onOpenRecordChange = vi.fn();
    renderPage(makeBridge([task("rec-1", "Plan")]), { onOpenRecordChange });
    await screen.findByRole("button", { name: "Open Plan" });
    const automations = () => {
      fireEvent.click(screen.getByRole("button", { name: "Collection actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Automations" }));
    };
    automations();
    expect(sides()).toEqual(["Automations"]);

    // The ⚡ panel holds a draft the person keeps: no record opens, and the draft's panel stays.
    fireEvent.click(screen.getByRole("checkbox", { name: "Holds a draft" }));
    open("Plan");
    expect(sides()).toEqual(["Automations"]);
    expect(onOpenRecordChange).not.toHaveBeenCalled();
    // The refused record does not open later, when the ⚡ panel closes for another reason.
    fireEvent.click(screen.getByRole("checkbox", { name: "Holds a draft" }));
    automations();
    expect(sides()).toEqual([]);
    expect(onOpenRecordChange).not.toHaveBeenCalled();

    // With no draft to keep, the ⚡ panel closes and the record takes its place.
    automations();
    open("Plan");
    expect(sides()).toEqual(["Plan"]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith("rec-1");
    // The ⚡ panel opens again and takes the place back.
    automations();
    expect(sides()).toEqual(["Automations"]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith(null);
  });

  it.each([{ accessEnded: false }, { accessEnded: true }])("offers no edit in the panel of a read-only Collection, with access ended: $accessEnded", async ({ accessEnded }) => {
    const doc = liveDoc();
    renderPage(makeBridge([task("rec-1", "Plan")]), { readOnly: true, accessEnded });
    await screen.findByRole("button", { name: "Open Plan" });
    open("Plan");
    // The name is text, a value opens no editor, and a tick changes nothing.
    expect(within(within(panel()).getByRole("heading", { name: "Plan" })).queryByRole("button")).toBeNull();
    fireEvent.click(property("notes").querySelector("[data-property-value]")!);
    expect(propertyEditor("notes")).toBeNull();
    fireEvent.click(within(property("done")).getByRole("checkbox"));
    expect(doc.getMap("frontmatter").get("done")).toBeUndefined();
    // The shell draws the body, read-only by its own rule for the file.
    expect(shownBody().dataset.path).toBe("tasks/Plan.md");
  });

  it("opens the record's file from Open as page, and its History from the panel's menu where the record has one", async () => {
    const onOpenRecord = vi.fn(), onOpenRecordHistory = vi.fn();
    const view = renderPage(makeBridge([task("rec-1", "Plan")]), { onOpenRecord, onOpenRecordHistory });
    await screen.findByRole("button", { name: "Open Plan" });
    open("Plan");
    fireEvent.click(within(panel()).getByRole("button", { name: "Open as page" }));
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("tasks/Plan.md");
    fireEvent.click(within(panel()).getByRole("button", { name: "Record actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    expect(onOpenRecordHistory).toHaveBeenCalledExactlyOnceWith({ collectionPath: "tasks", recordId: "rec-1", recordName: "Plan" });

    // A record with no History, as under shared-with-me, has no menu.
    view.rerender(page({ onOpenRecord }));
    expect(within(panel()).queryByRole("button", { name: "Record actions" })).toBeNull();
  });

  it("saves what the body holds before the record leaves the panel, and keeps the record when that save does not end", async () => {
    // The shell saves the body's text, then runs what waited. A save that fails runs nothing.
    const waiting: Array<() => void> = [];
    const settleRecordBody = (then: () => void) => { waiting.push(then); };
    const saved = () => act(() => waiting.shift()!());
    const onOpenRecord = vi.fn();
    renderPage(makeBridge([task("rec-1", "Plan"), task("rec-2", "Socks")]), { settleRecordBody, onOpenRecord });
    await screen.findByRole("button", { name: "Open Plan" });
    // With no record open there is nothing to save, so the first record opens at once.
    const opener = open("Plan");
    expect(sides()).toEqual(["Plan"]);
    expect(waiting).toHaveLength(0);

    // Another record waits for the save, and one that fails leaves the first record open.
    open("Socks");
    expect(sides()).toEqual(["Plan"]);
    expect(waiting).toHaveLength(1);
    waiting.shift();
    expect(sides()).toEqual(["Plan"]);
    open("Socks");
    saved();
    expect(sides()).toEqual(["Socks"]);

    // Close waits too, and so does Escape.
    fireEvent.click(within(panel()).getByRole("button", { name: "Close record" }));
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(sides()).toEqual(["Socks"]);
    expect(waiting).toHaveLength(2);
    saved();
    expect(sides()).toEqual([]);

    // The record's file opens in a tab only once the body is saved, and so does the ⚡ panel in the record's place.
    opener.focus();
    open("Plan");
    fireEvent.click(within(panel()).getByRole("button", { name: "Open as page" }));
    expect(onOpenRecord).not.toHaveBeenCalled();
    act(() => waiting.pop()!());
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("tasks/Plan.md");
    fireEvent.click(screen.getByRole("button", { name: "Collection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Automations" }));
    expect(sides()).toEqual(["Plan"]);
    act(() => waiting.pop()!());
    expect(sides()).toEqual(["Automations"]);
  });
});
