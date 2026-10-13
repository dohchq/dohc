// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { csvColumns, CsvTable, CsvView } from "./CsvView";
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
      columns={csvColumns(rows)}
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

const numericColumns = (rows: string[][]) => csvColumns(rows).map((column) => column.numeric);

describe("CSV columns", () => {
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

  it("takes each column's header and its widest preview cell", () => {
    expect(csvColumns([
      ["stage", "count"],
      ["Visited", "4820"],
      ["Signed up", "12"],
    ])).toEqual([
      { numeric: false, header: "stage", cell: "Signed up" },
      { numeric: true, header: "count", cell: "4820" },
    ]);
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

  it("keeps a column's alignment and font for the whole edit, renders only the edited row, and realigns when the edit ends", async () => {
    const user = userEvent.setup();
    const body = ["stage,count", "step 1,123456789012", ...Array.from({ length: 19 }, (_, index) => `step ${index + 2},${index + 2}`)].join("\n");
    render(<CsvView {...csvFile(body)} />);
    const table = screen.getByRole("table");
    const style = table.getAttribute("style");
    const input = screen.getByLabelText("Row 3 column 2");
    input.focus();
    gutterRenders.length = 0;

    // Numbers, then a word, then numbers again: the widths row reads the
    // table's style, so an unchanged style keeps the column's width.
    await user.keyboard("e");
    expect(table.getAttribute("style")).toBe(style);
    await user.keyboard("3");
    expect((input as HTMLInputElement).value).toBe("3e3");
    expect(table.getAttribute("style")).toBe(style);
    await user.keyboard("x");
    expect(table.getAttribute("style")).toBe(style);
    expect(isNumber(1)).toBe(true);
    expect(new Set(gutterRenders)).toEqual(new Set([3]));

    gutterRenders.length = 0;
    await user.keyboard("{Enter}");
    expect(isNumber(1)).toBe(false);
    expect(isNumber(0)).toBe(false);
    expect(gutterRenders).toEqual([]);
  });

  it("ends an edit with Enter in a cell and in a header, keeping focus", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("stage,count\nVisited,4820\nSigned up,1290")} />);

    const cellInput = screen.getByLabelText("Row 1 column 1");
    await user.type(cellInput, " the pricing page{Enter}");
    expect(widthText(0)).toBe("stageVisited the pricing page");
    expect(document.activeElement).toBe(cellInput);

    const headerInput = screen.getByLabelText("Header column 2");
    await user.type(headerInput, " of people{Enter}");
    expect(widthText(1)).toBe("count of people4820");
    expect(document.activeElement).toBe(headerInput);
  });

  it("sizes a column from its widest cell as drawn, not its longest", () => {
    // Narrow i, wide CJK, everything else between, as a canvas measures them.
    const measured = (text: string) =>
      [...text].reduce((width, char) => width + (char === "i" ? 3 : char.charCodeAt(0) > 0x2fff ? 13 : 7), 0);
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return { font: "", measureText: (text: string) => ({ width: measured(text) }) };
      }
    });
    const thin = "i".repeat(25);
    const wide = "東京駅前の広い通りにある";
    // Counted as two characters each, the wide text still loses.
    expect(wide.length * 2).toBeLessThan(thin.length);
    render(<CsvView {...csvFile(`note\n${thin}\n${wide}`)} />);
    expect(widthText(0)).toBe(`note${wide}`);
  });
});
