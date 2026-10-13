// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { columnTexts, CsvTable, CsvView, numericColumns } from "./CsvView";
import { documentVersionKey } from "./documentVersionKey";
import { MAX_CSV_PREVIEW_ROWS } from "./offers/csvBound";
import { resetOrphanedDrafts } from "./orphanedDrafts";
import { acquireSharedLocalDocument, resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";

// Each row's gutter, by row number, every time a row renders.
const gutterRenders = vi.hoisted(() => [] as Array<number | undefined>);
vi.mock("./ui/DataGrid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/DataGrid")>();
  return {
    ...actual,
    DataGridGutter: (props: Parameters<typeof actual.DataGridGutter>[0]) => {
      gutterRenders.push(props.number);
      return actual.DataGridGutter(props);
    },
  };
});

const writeWorkspaceText = vi.fn<DohcDesktopBridge["writeWorkspaceText"]>();
const releases: Array<() => void> = [];
const buffers: Array<ReturnType<typeof acquireSharedLocalDocument>["buffer"]> = [];

// A CSV as FileInspector hands it to its view.
function csvFile(body: string) {
  const { buffer, release } = acquireSharedLocalDocument(documentVersionKey("ws-1", "funnel.csv", undefined));
  releases.push(release);
  buffers.push(buffer);
  const contentReadTicket = buffer.beginRead();
  buffer.initializeRead(body, "hash-1", contentReadTicket);
  return {
    workspaceId: "ws-1",
    path: "funnel.csv",
    body,
    contentHash: "hash-1",
    contentReadTicket,
    contentRequestId: 1,
    latestContentRequestId: 1,
    switchReadPending: false,
    switchUnresyncedRef: { current: false },
    refreshAfterConflict: vi.fn(),
    localBuffer: buffer,
  };
}

const FUNNEL = [
  ["stage", "count", "conversion"],
  ["Visited", "4820", "1.00"],
  ["Signed up", "1290", "0.27"],
];

const table = (rows: string[][], locked = false) =>
  render(
    <CsvTable
      rows={rows}
      numeric={numericColumns(rows)}
      widths={columnTexts(rows)}
      locked={locked}
      onUpdateCell={vi.fn()}
      onEndEdit={vi.fn()}
      onDeleteRow={vi.fn()}
      onDeleteColumn={vi.fn()}
      onAddRow={vi.fn()}
      onAddColumn={vi.fn()}
    />,
  );
const cell = (label: string) => screen.getByLabelText(label).closest("td, th") as HTMLElement;
// Whether the table sets a column, counted from 0, as numbers.
const isNumber = (column: number) =>
  screen.getByRole("table").style.getPropertyValue(`--data-grid-align-${column}`) === "right";
// The text that sets a column's width.
const widthText = (column: number) =>
  screen.getByTestId("data-grid-widths").querySelectorAll("td")[column + 1]!.textContent;

describe("CSV numeric columns", () => {
  it("finds a column numeric when every non-empty preview cell is a finite number", () => {
    expect(numericColumns([
      ["name", "count", "ratio", "blank", "mixed", "infinite"],
      ["Ada", "4820", " 0.27 ", "", "12", "Infinity"],
      ["Bo", "", "-1e3", "", "n/a", "1"],
    ])).toEqual([false, true, true, false, false, false]);
    // The header's own words never decide.
    expect(numericColumns([["2024", "name"], ["Ada", "Bo"]])).toEqual([false, false]);
    expect(numericColumns([])).toEqual([]);
  });

  it("reads only the preview's rows", () => {
    const rows = [["count"], ...Array.from({ length: MAX_CSV_PREVIEW_ROWS }, () => ["1"]), ["not a number"]];
    expect(numericColumns(rows)).toEqual([true]);
  });

  it("checks only the edited column after a cell edit, and keeps the list when nothing changed", () => {
    const rows = [["a", "b"], ["1", "x"]];
    // A stale answer for column b survives an edit to column a, so only a was read.
    const previous = [true, true];
    expect(numericColumns(rows, previous, 0)).toBe(previous);
    const flipped = numericColumns([["a", "b"], ["one", "x"]], previous, 0);
    expect(flipped).toEqual([false, true]);
    expect(flipped).not.toBe(previous);
    // An edit past the last column, or no edited column, reads every column again.
    expect(numericColumns([["a", "b", "c"], ["1", "x", "2"]], previous, 2)).toEqual([true, false, true]);
    expect(numericColumns(rows, previous)).toEqual([true, false]);
  });
});

describe("CSV column widths", () => {
  it("takes each column's header and its widest preview cell, counting a wide character as two", () => {
    expect(columnTexts([
      ["stage", "note"],
      ["Visited", "東京駅"],
      ["Signed up", "Tokyo"],
    ])).toEqual([{ header: "stage", cell: "Signed up" }, { header: "note", cell: "東京駅" }]);
  });
});

describe("CSV grid", () => {
  afterEach(cleanup);

  it("sets number columns right-aligned in mono on the table, and each cell reads its own column", () => {
    table(FUNNEL);
    expect([0, 1, 2].map(isNumber)).toEqual([false, true, true]);
    expect(screen.getByRole("table").style.getPropertyValue("--data-grid-font-1")).toBe("var(--font-mono)");
    expect(cell("Row 1 column 2").style.textAlign).toBe("var(--data-grid-align-1)");
    expect(cell("Row 1 column 2").style.fontFamily).toBe("var(--data-grid-font-1)");
    expect(cell("Header column 2").style.textAlign).toBe("var(--data-grid-align-1)");
    expect(cell("Header column 2").style.fontFamily).toBe("");
    expect(screen.getByLabelText("Row 1 column 2").className).toContain("[text-align:inherit]");
  });

  it("puts each row's number and its Delete row in one gutter box, swapped on hover or focus", () => {
    table(FUNNEL);
    const row = screen.getByLabelText("Row 2 column 1").closest("tr")!;
    expect(row.className).toContain("group/row");
    const gutter = row.querySelector("td")!;
    const remove = within(gutter).getByRole("button", { name: "Delete row 2" });
    const number = within(gutter).getByText("2");
    expect(number.parentElement).toBe(remove.parentElement!.parentElement);
    for (const state of ["group-hover/row", "group-focus-within/row"]) {
      expect(number.className).toContain(`${state}:opacity-0`);
      expect(remove.parentElement!.className).toContain(`${state}:opacity-100`);
    }
    expect(remove.parentElement!.className).toMatch(/(^| )opacity-0( |$)/);
  });

  it("keeps Delete row and Delete column in the tab order while they are hidden", async () => {
    const user = userEvent.setup();
    table(FUNNEL);
    screen.getByLabelText("Row 1 column 1").focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete row 1" }));

    screen.getByLabelText("Header column 1").focus();
    await user.tab();
    const deleteColumn = screen.getByRole("button", { name: "Delete column 1" });
    expect(document.activeElement).toBe(deleteColumn);
    const header = deleteColumn.closest("th")!;
    expect(header.className).toContain("group/column");
    expect(deleteColumn.parentElement!.className).toContain("group-hover/column:opacity-100");
    expect(deleteColumn.parentElement!.className).toContain("group-focus-within/column:opacity-100");
  });

  it("marks the focused cell with the accent outline drawn by the cell", () => {
    table(FUNNEL);
    expect(cell("Row 1 column 1").className).toContain("focus-within:outline-accent");
    expect(cell("Header column 1").className).toContain("has-[input:focus]:outline-accent");
    expect(screen.getByLabelText("Row 1 column 1").className).toContain("outline-none");
  });

  it("numbers a read-only table's rows without row or column actions", () => {
    table(FUNNEL, true);
    const gutter = screen.getByLabelText("Row 2 column 1").closest("tr")!.querySelector("td")!;
    expect(gutter.textContent).toBe("2");
    expect(screen.queryByTestId("csv-delete-row")).toBeNull();
    expect(screen.queryByTestId("csv-delete-column")).toBeNull();
    expect(screen.queryByTestId("csv-add-row")).toBeNull();
  });

  it("sizes its columns from their text instead of the pane or the inputs", () => {
    table(FUNNEL);
    expect(screen.getByRole("table").className).not.toContain("w-full");
    const input = screen.getByLabelText("Row 1 column 1");
    expect(input.getAttribute("size")).toBe("1");
    expect(input.className).not.toContain("field-sizing");
    expect([0, 1, 2].map(widthText)).toEqual(["stageSigned up", "count4820", "conversion1.00"]);
    // The widths row holds no control and is hidden from assistive technology.
    expect(screen.getByTestId("data-grid-widths").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("data-grid-widths").querySelector("input, button")).toBeNull();
  });
});

describe("CSV view while typing", () => {
  beforeEach(() => {
    writeWorkspaceText.mockResolvedValue({ status: "written", contentHash: "hash-2" });
    vi.stubGlobal("dohcDesktop", {
      platform: "win32",
      writeWorkspaceText,
      onEngineYDocSaveState: () => () => {},
    });
  });

  afterEach(async () => {
    await act(async () => {
      cleanup();
      await Promise.all(buffers.splice(0).map((buffer) => buffer.settled()));
    });
    for (const release of releases.splice(0)) release();
    resetSharedLocalDocumentsForTests();
    resetOrphanedDrafts();
    vi.unstubAllGlobals();
    writeWorkspaceText.mockReset();
  });

  it("keeps a column's width while a cell's text grows, and sets it when the edit ends", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("stage,count\nVisited,4820\nSigned up,1290")} />);
    expect(widthText(0)).toBe("stageSigned up");

    await user.type(screen.getByLabelText("Row 1 column 1"), " the pricing page");
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Visited the pricing page");
    expect(widthText(0)).toBe("stageSigned up");

    // Moving to the header ends the cell's edit; the header's own edit then
    // keeps the width until it ends too.
    await user.type(screen.getByLabelText("Header column 1"), " name");
    expect(widthText(0)).toBe("stageVisited the pricing page");
    await user.tab();
    expect(widthText(0)).toBe("stage nameVisited the pricing page");
    expect(widthText(1)).toBe("count4820");
  });

  it("realigns a column when an edit flips it, and renders only the edited row again", async () => {
    const user = userEvent.setup();
    const body = ["stage,count", ...Array.from({ length: 20 }, (_, index) => `step ${index + 1},${index + 1}`)].join("\n");
    render(<CsvView {...csvFile(body)} />);
    const input = screen.getByLabelText("Row 3 column 2");
    input.focus();
    gutterRenders.length = 0;

    // Numbers, then a word, then numbers again.
    await user.keyboard("e");
    const flippedOff = new Set(gutterRenders);
    await user.keyboard("3");
    expect((input as HTMLInputElement).value).toBe("3e3");
    expect(flippedOff).toEqual(new Set([3]));
    expect(new Set(gutterRenders)).toEqual(new Set([3]));

    expect(isNumber(1)).toBe(true);
    expect(isNumber(0)).toBe(false);
    await user.keyboard("x");
    expect(isNumber(1)).toBe(false);
  });
});
