// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { CsvTable, CsvView, numericColumns } from "./CsvView";
import { documentVersionKey } from "./documentVersionKey";
import { MAX_CSV_PREVIEW_ROWS } from "./offers/csvBound";
import { resetOrphanedDrafts } from "./orphanedDrafts";
import { acquireSharedLocalDocument, resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";

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
      locked={locked}
      onUpdateCell={vi.fn()}
      onDeleteRow={vi.fn()}
      onDeleteColumn={vi.fn()}
      onAddRow={vi.fn()}
      onAddColumn={vi.fn()}
    />,
  );
const cell = (label: string) => screen.getByLabelText(label).closest("td, th") as HTMLElement;
const isNumber = (label: string) =>
  cell(label).className.includes("text-right") && screen.getByLabelText(label).className.includes("text-right");

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
    // A changed width, or no edited column, reads every column again.
    expect(numericColumns([["a", "b", "c"], ["1", "x", "2"]], previous, 0)).toEqual([true, false, true]);
    expect(numericColumns(rows, previous)).toEqual([true, false]);
  });
});

describe("CSV grid", () => {
  afterEach(cleanup);

  it("right-aligns a number column's cells and header in mono", () => {
    table(FUNNEL);
    expect(isNumber("Row 1 column 1")).toBe(false);
    expect(isNumber("Row 1 column 2")).toBe(true);
    expect(isNumber("Row 2 column 3")).toBe(true);
    expect(cell("Row 1 column 2").className).toContain("font-mono");
    expect(isNumber("Header column 2")).toBe(true);
    expect(cell("Header column 2").className).not.toContain("font-mono");
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

  it("sizes its columns to their content instead of the pane", () => {
    table(FUNNEL);
    expect(screen.getByRole("table").className).not.toContain("w-full");
    expect(screen.getByLabelText("Row 1 column 1").className).toContain("field-sizing-content");
  });
});

describe("CSV view alignment", () => {
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

  it("realigns a column when an edit makes it hold a word or only numbers", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("stage,count\nVisited,4820\nSigned up,1290")} />);
    expect(isNumber("Row 2 column 2")).toBe(true);

    await user.type(screen.getByLabelText("Row 2 column 2"), "x");
    expect(isNumber("Row 1 column 2")).toBe(false);
    expect(isNumber("Row 2 column 2")).toBe(false);

    await user.type(screen.getByLabelText("Row 2 column 2"), "{Backspace}");
    expect(isNumber("Row 2 column 2")).toBe(true);
    expect(isNumber("Row 2 column 1")).toBe(false);
  });
});
