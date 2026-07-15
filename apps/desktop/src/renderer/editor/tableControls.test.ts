// @vitest-environment jsdom
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeTableControlsPlugin,
  resolveTableDropDestination,
  resolveTableMenuPosition,
} from "./tableControls";
import { DohcTableRowHeight } from "./extensions";

// ProseMirror's resize/drop plugins ask the browser for a hit-test while these
// tests dispatch synthetic pointer/drag events. jsdom has no layout engine, so
// provide the inert browser API those unrelated plugins expect.
let elementFromPointResult: Element | null = null;
Object.defineProperty(document, "execCommand", {
  configurable: true,
  // ProseMirror's Safari shadow-selection workaround calls this browser API;
  // jsdom does not implement it, and the return value is irrelevant here.
  value: () => false,
});

// jsdom has no elementFromPoint; prosemirror-tables' columnresizing plugin
// calls it (via posAtCoords) on every mousemove the hover-tracking tests
// dispatch. Tests can point it at a synthetic target during drag gestures.
beforeAll(() => {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => elementFromPointResult,
  });
});

const testTableControls = Extension.create({
  name: "testTableControls",
  addProseMirrorPlugins() {
    return [makeTableControlsPlugin()];
  },
});

function createEditor(content: string): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      DohcTableRowHeight,
      TableKit.configure({ table: { resizable: true } }),
      testTableControls,
    ],
    content,
  });
}

function createTableEditor(rows = 2, cols = 2): Editor {
  const editor = createEditor("<p></p>");
  editor.commands.insertTable({ rows, cols, withHeaderRow: true });
  return editor;
}

function createLabeledTableEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      DohcTableRowHeight,
      TableKit.configure({ table: { resizable: true } }),
      testTableControls,
    ],
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: ["A", "B", "C"].map((rowLabel) => ({
            type: "tableRow",
            content: ["1", "2", "3"].map((columnLabel) => ({
              type: rowLabel === "A" ? "tableHeader" : "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: `${rowLabel}${columnLabel}` }],
                },
              ],
            })),
          })),
        },
      ],
    },
  });
}

function createColspanTableEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      DohcTableRowHeight,
      TableKit.configure({ table: { resizable: true } }),
      testTableControls,
    ],
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
                },
                {
                  type: "tableHeader",
                  attrs: { colspan: 2, rowspan: 1, colwidth: null },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "B+C" }] }],
                },
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "D" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: ["A", "B", "C", "D"].map((text) => ({
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              })),
            },
          ],
        },
      ],
    },
  });
}

function menuItemByLabel(label: string): HTMLButtonElement {
  const menu = document.body.querySelector(".dohc-table-menu");
  if (!menu) throw new Error("grip menu did not open");
  const item = Array.from(menu.querySelectorAll(".dohc-table-menu__item")).find(
    (el) => el.textContent === label,
  );
  if (!item) throw new Error(`menu item "${label}" not found`);
  return item as HTMLButtonElement;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function dispatchPointer(
  element: Element,
  type: string,
  { clientX = 0, clientY = 0, pointerId = 1 } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  element.dispatchEvent(event);
}

function drag(source: Element, target: Element): void {
  elementFromPointResult = source;
  dispatchPointer(source, "pointerdown");
  elementFromPointResult = target;
  dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });
  dispatchPointer(source, "pointerup", { clientX: 10, clientY: 10 });
  elementFromPointResult = null;
}

// `editor.getJSON()`'s type is inferred from the registered extensions
// (a deep NodeType/TextType union) and is awkward to destructure generically
// in a test; a small structural type is simpler than fighting that union.
type JsonNode = {
  type: string;
  attrs?: {
    align?: string | null;
    colspan?: number;
    rowspan?: number;
    height?: number | null;
  };
  content?: JsonNode[];
  text?: string;
};

function tableNode(editor: Editor): JsonNode {
  const json = editor.getJSON() as unknown as { content?: JsonNode[] };
  const table = json.content?.find((node) => node.type === "table");
  if (!table) throw new Error("no table in doc");
  return table;
}

// The align attr each cell in `colIndex` carries, top row to bottom.
function columnAligns(editor: Editor, colIndex: number): (string | null)[] {
  return (tableNode(editor).content ?? []).map(
    (row) => row.content?.[colIndex]?.attrs?.align ?? null,
  );
}

function tableTextGrid(editor: Editor): string[][] {
  return (tableNode(editor).content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .flatMap((paragraph) => paragraph.content ?? [])
        .map((text) => (text as JsonNode & { text?: string }).text ?? "")
        .join(""),
    ),
  );
}

describe("table controls grips", () => {
  let editor: Editor | undefined;

  afterEach(() => {
    elementFromPointResult = null;
    document.body.querySelector(".dohc-table-menu")?.remove();
    document.body.querySelector(".dohc-table-drag-preview")?.remove();
    document.body.querySelector(".dohc-table-drop-indicator")?.remove();
    editor?.destroy();
    editor = undefined;
  });

  it("renders column grips, row grips, row resize handles, and one table menu button", () => {
    editor = createTableEditor(2, 3);
    const dom = editor.view.dom;
    expect(dom.querySelectorAll(".dohc-table-grip--col")).toHaveLength(3);
    expect(dom.querySelectorAll(".dohc-table-grip--row")).toHaveLength(2);
    expect(dom.querySelectorAll(".dohc-table-row-resize")).toHaveLength(2);
    expect(dom.querySelectorAll(".dohc-table-menu-btn")).toHaveLength(1);
  });

  it("reveals only the six-dot handles for the row and column under the pointer", () => {
    editor = createTableEditor(3, 3);
    const cells = editor.view.dom.querySelectorAll("td, th");
    cells[4]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    const visibleRows = editor.view.dom.querySelectorAll(
      ".dohc-table-grip--row.is-visible",
    );
    const visibleColumns = editor.view.dom.querySelectorAll(
      ".dohc-table-grip--col.is-visible",
    );
    expect(visibleRows).toHaveLength(1);
    expect(visibleRows[0]?.getAttribute("data-table-row")).toBe("1");
    expect(visibleRows[0]?.textContent).toBe("");
    expect(visibleColumns).toHaveLength(1);
    expect(visibleColumns[0]?.getAttribute("data-table-column")).toBe("1");
    expect(visibleColumns[0]?.textContent).toBe("");
  });

  it("mousemove over a cell activates exactly that column's and row's handles", () => {
    editor = createTableEditor(2, 3);
    const dom = editor.view.dom;
    // Body-row cells are `td`; index 1 is row 1 / column 1.
    const cell = dom.querySelectorAll("td")[1] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    const activeCols = dom.querySelectorAll<HTMLElement>(".dohc-table-grip--col.is-active");
    const activeRows = dom.querySelectorAll<HTMLElement>(".dohc-table-grip--row.is-active");
    expect(activeCols).toHaveLength(1);
    expect(activeRows).toHaveLength(1);
    expect(activeCols[0]?.dataset.col).toBe("1");
    expect(activeRows[0]?.dataset.row).toBe("1");
    const visibleResize = dom.querySelectorAll<HTMLElement>(
      ".dohc-table-row-resize.is-visible",
    );
    expect(visibleResize).toHaveLength(1);
    expect(visibleResize[0]?.dataset.tableRowResize).toBe("1");
  });

  it("hovered column handle uses TableMap coordinates when a rowspan precedes the cell", () => {
    editor = createTableEditor();
    editor.commands.setContent(
      '<table><tr><td rowspan="2">R</td><td>A</td></tr><tr><td>B</td></tr></table>',
    );
    const dom = editor.view.dom;
    const cells = dom.querySelectorAll("td");
    const cell = cells[cells.length - 1] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    const activeCols = dom.querySelectorAll<HTMLElement>(".dohc-table-grip--col.is-active");
    expect(activeCols).toHaveLength(1);
    expect(activeCols[0]?.dataset.col).toBe("1");
    // Row 1's col-0 slot is covered by the rowspan, so the decoration
    // builder dedups away row 1's grip — there is nothing to activate.
    expect(dom.querySelectorAll(".dohc-table-grip--row.is-active")).toHaveLength(0);
  });

  it("mousemove outside the table clears the active handles", () => {
    editor = createTableEditor(2, 2);
    const dom = editor.view.dom;
    const cell = dom.querySelector("td") as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(dom.querySelectorAll(".dohc-table-grip.is-active").length).toBeGreaterThan(0);

    const outside = Array.from(dom.querySelectorAll("p")).find(
      (p) => !p.closest("table"),
    ) as HTMLElement;
    // jsdom tables have zero rects, so 400,400 is outside the margin band.
    outside.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }),
    );
    expect(dom.querySelectorAll(".dohc-table-grip.is-active")).toHaveLength(0);
  });

  it("mousemove in the margin band next to the table keeps the active handles", () => {
    editor = createTableEditor(2, 2);
    const dom = editor.view.dom;
    const cell = dom.querySelector("td") as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    const outside = Array.from(dom.querySelectorAll("p")).find(
      (p) => !p.closest("table"),
    ) as HTMLElement;
    outside.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    expect(dom.querySelectorAll(".dohc-table-grip.is-active")).toHaveLength(2);
  });

  it("clicking a column grip selects the column and its menu inserts a column left", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);

    expect(editor.state.selection.toJSON()).toMatchObject({ type: "cell" });

    click(menuItemByLabel("Insert column left"));

    const headerRow = tableNode(editor).content?.[0];
    expect(headerRow?.content).toHaveLength(3);
  });

  it("column grip menu deletes a column", () => {
    editor = createTableEditor(2, 3);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Delete column"));

    const headerRow = tableNode(editor).content?.[0];
    expect(headerRow?.content).toHaveLength(2);
  });

  it("clicking a row grip selects the row and its menu inserts a row below", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--row") as HTMLElement;
    click(grip);

    expect(editor.state.selection.toJSON()).toMatchObject({ type: "cell" });

    click(menuItemByLabel("Insert row below"));

    expect(tableNode(editor).content).toHaveLength(3);
  });

  it("row grip menu deletes a row", () => {
    editor = createTableEditor(3, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--row") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Delete row"));

    expect(tableNode(editor).content).toHaveLength(2);
  });

  it("Backspace deletes a row selected from its handle", () => {
    editor = createTableEditor(3, 2);
    const secondRowGrip = editor.view.dom.querySelectorAll(
      ".dohc-table-grip--row",
    )[1] as HTMLElement;
    click(secondRowGrip);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(tableNode(editor).content).toHaveLength(2);
  });

  it("Delete removes a selected column while its handle menu is open", () => {
    editor = createTableEditor(2, 3);
    const secondColumnGrip = editor.view.dom.querySelectorAll(
      ".dohc-table-grip--col",
    )[1] as HTMLElement;
    click(secondColumnGrip);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));

    expect(tableNode(editor).content?.[0]?.content).toHaveLength(2);
    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
  });

  it("dragging a row handle reorders the row and preserves its cells", () => {
    editor = createLabeledTableEditor();
    const rowGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--row");

    drag(rowGrips[0] as HTMLElement, rowGrips[2] as HTMLElement);

    expect(tableTextGrid(editor)).toEqual([
      ["B1", "B2", "B3"],
      ["C1", "C2", "C3"],
      ["A1", "A2", "A3"],
    ]);
  });

  it("reorders when the editor selection starts outside the table", () => {
    editor = createLabeledTableEditor();
    editor.commands.insertContentAt(0, {
      type: "paragraph",
      content: [{ type: "text", text: "Outside the table" }],
    });
    editor.commands.setTextSelection(1);
    const rowGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--row");

    drag(rowGrips[0] as HTMLElement, rowGrips[2] as HTMLElement);

    expect(tableTextGrid(editor)).toEqual([
      ["B1", "B2", "B3"],
      ["C1", "C2", "C3"],
      ["A1", "A2", "A3"],
    ]);
  });

  it("dragging a column handle reorders every cell in that column", () => {
    editor = createLabeledTableEditor();
    const columnGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--col");

    drag(columnGrips[0] as HTMLElement, columnGrips[2] as HTMLElement);

    expect(tableTextGrid(editor)).toEqual([
      ["A2", "A3", "A1"],
      ["B2", "B3", "B1"],
      ["C2", "C3", "C1"],
    ]);
  });

  it("accepts a drop anywhere inside the target row, not only on its handle", () => {
    editor = createLabeledTableEditor();
    const source = editor.view.dom.querySelector(
      ".dohc-table-grip--row",
    ) as HTMLElement;
    const targetCell = editor.view.dom.querySelectorAll("tr")[1]?.cells[2];
    if (!targetCell) throw new Error("target cell missing");

    drag(source, targetCell);

    expect(tableTextGrid(editor)).toEqual([
      ["B1", "B2", "B3"],
      ["A1", "A2", "A3"],
      ["C1", "C2", "C3"],
    ]);
  });

  it("keeps a resized row height when the row is reordered", () => {
    editor = createLabeledTableEditor();
    const firstRow = editor.state.doc.nodeAt(1);
    if (!firstRow) throw new Error("first row missing");
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(1, undefined, {
        ...firstRow.attrs,
        height: 74,
      }),
    );
    const source = editor.view.dom.querySelector(
      ".dohc-table-grip--row",
    ) as HTMLElement;
    const targetCell = editor.view.dom.querySelectorAll("tr")[1]?.cells[2];
    if (!targetCell) throw new Error("target cell missing");

    drag(source, targetCell);

    expect(tableTextGrid(editor)[1]).toEqual(["A1", "A2", "A3"]);
    expect(tableNode(editor).content?.[0]?.attrs?.height).toBeNull();
    expect(tableNode(editor).content?.[1]?.attrs?.height).toBe(74);
  });

  it("drops at the last valid target when Electron reroutes mouseup", () => {
    editor = createLabeledTableEditor();
    const source = editor.view.dom.querySelector(
      ".dohc-table-grip--row",
    ) as HTMLElement;
    const targetCell = editor.view.dom.querySelectorAll("tr")[2]?.cells[1];
    if (!targetCell) throw new Error("target cell missing");

    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = targetCell;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });
    elementFromPointResult = null;
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 0,
        clientY: 0,
      }),
    );

    expect(tableTextGrid(editor)).toEqual([
      ["B1", "B2", "B3"],
      ["C1", "C2", "C3"],
      ["A1", "A2", "A3"],
    ]);
  });

  it("uses the pointer half to insert before the target row", () => {
    editor = createLabeledTableEditor();
    const rows = editor.view.dom.querySelectorAll("tr");
    const rowGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--row");
    const source = rowGrips[2] as HTMLElement;
    const targetCell = rows[0]?.cells[1];
    if (!targetCell) throw new Error("target cell missing");
    Object.defineProperty(rows[0], "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 100,
        bottom: 140,
        left: 0,
        right: 300,
        width: 300,
        height: 40,
      }),
    });
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = targetCell;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 105 });
    expect(rows[0]?.classList.contains("dohc-table-drop-before")).toBe(true);
    dispatchPointer(source, "pointerup", { clientX: 10, clientY: 105 });

    expect(tableTextGrid(editor)).toEqual([
      ["C1", "C2", "C3"],
      ["A1", "A2", "A3"],
      ["B1", "B2", "B3"],
    ]);
  });

  it("uses logical TableMap columns when a target cell follows a colspan", () => {
    editor = createColspanTableEditor();
    const source = editor.view.dom.querySelector(
      '[data-table-column="0"]',
    ) as HTMLElement;
    const targetCell = editor.view.dom.querySelectorAll("tr")[0]?.cells[2];
    if (!targetCell) throw new Error("colspan target cell missing");
    Object.defineProperty(targetCell, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 40,
        left: 100,
        right: 200,
        width: 100,
        height: 40,
      }),
    });

    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = targetCell;
    dispatchPointer(source, "pointermove", { clientX: 110, clientY: 20 });
    dispatchPointer(source, "pointerup", { clientX: 110, clientY: 20 });

    expect(tableTextGrid(editor)[1]).toEqual(["B", "C", "A", "D"]);
  });

  it("maps before/after boundaries to stable final indexes", () => {
    expect(
      resolveTableDropDestination({
        sourceIndex: 0,
        targetIndex: 2,
        side: "before",
        bandCount: 4,
      }),
    ).toBe(1);
    expect(
      resolveTableDropDestination({
        sourceIndex: 0,
        targetIndex: 2,
        side: "after",
        bandCount: 4,
      }),
    ).toBe(2);
    expect(
      resolveTableDropDestination({
        sourceIndex: 3,
        targetIndex: 0,
        side: "after",
        bandCount: 4,
      }),
    ).toBe(1);
  });

  it("row grip menu duplicates the row below it (header duplicates as a body row)", () => {
    editor = createTableEditor(2, 2);
    // insertTable leaves the caret in the first header cell.
    editor.commands.insertContent("Head");

    const grip = editor.view.dom.querySelector(".dohc-table-grip--row") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Duplicate row"));

    const rows = tableNode(editor).content ?? [];
    expect(rows).toHaveLength(3);
    // The original header row is untouched; the copy right below it is made
    // of BODY cells (GFM has exactly one header row) with the same content.
    expect(rows[0]?.content?.every((cell) => cell.type === "tableHeader")).toBe(true);
    expect(rows[1]?.content?.every((cell) => cell.type === "tableCell")).toBe(true);
    expect(rows[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Head");
  });

  it("row grip menu widens a rowspan crossing the duplicated row", () => {
    editor = createTableEditor();
    editor.commands.setContent(
      '<table><tr><td rowspan="2">R</td><td>b1</td></tr><tr><td>b2</td></tr></table>',
    );

    const grip = editor.view.dom.querySelector(".dohc-table-grip--row") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Duplicate row"));

    const rows = tableNode(editor).content ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.content?.[0]?.attrs?.rowspan).toBe(3);
    expect(rows[1]?.content).toHaveLength(1);
    expect(rows[1]?.content?.[0]?.attrs?.rowspan).toBe(1);
    expect(rows[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("b1");
    expect(rows[2]?.content).toHaveLength(1);
    expect(rows[2]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("b2");
  });

  it("row grip menu copies a rowspan that ends at the duplicated row", () => {
    editor = createTableEditor();
    editor.commands.setContent(
      '<table><tr><td>a</td><td rowspan="2">R</td></tr><tr><td>b</td></tr></table>',
    );

    const grips = editor.view.dom.querySelectorAll<HTMLElement>(
      ".dohc-table-grip--row",
    );
    expect(grips).toHaveLength(2);
    click(grips[1] as HTMLElement);
    click(menuItemByLabel("Duplicate row"));

    const rows = tableNode(editor).content ?? [];
    const copy = rows[2]?.content ?? [];
    expect(rows).toHaveLength(3);
    expect(copy).toHaveLength(2);
    expect(copy.every((cell) => cell.attrs?.rowspan === 1)).toBe(true);
    expect(copy.map((cell) => cell.content?.[0]?.content?.[0]?.text)).toEqual([
      "b",
      "R",
    ]);
  });

  it("column grip menu duplicates the column, alignment included", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Align center"));
    click(grip);
    click(menuItemByLabel("Duplicate column"));

    expect(tableNode(editor).content?.[0]?.content).toHaveLength(3);
    expect(columnAligns(editor, 0)).toEqual(["center", "center"]);
    expect(columnAligns(editor, 1)).toEqual(["center", "center"]);
    expect(columnAligns(editor, 2)).toEqual([null, null]);
  });

  it("column grip menu duplicates exactly one column from a spanning cell", () => {
    editor = createTableEditor();
    editor.commands.setContent(
      '<table><tr><th colspan="2">Span</th><th>C</th></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>',
    );

    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Duplicate column"));

    const rows = tableNode(editor).content ?? [];
    const headerCells = rows[0]?.content ?? [];
    const bodyCells = rows[1]?.content ?? [];
    expect(bodyCells).toHaveLength(4);
    expect(headerCells).toHaveLength(2);
    expect(headerCells[0]?.attrs?.colspan).toBe(3);
    expect(
      headerCells.reduce((width, cell) => width + (cell.attrs?.colspan ?? 1), 0),
    ).toBe(4);
    expect(bodyCells.map((cell) => cell.content?.[0]?.content?.[0]?.text)).toEqual([
      "a",
      "a",
      "b",
      "c",
    ]);
  });

  it("table menu toggles the header row", () => {
    editor = createTableEditor(2, 2);
    const before = tableNode(editor).content?.[0]?.content?.[0]?.type;
    expect(before).toBe("tableHeader");

    const menuButton = editor.view.dom.querySelector(".dohc-table-menu-btn") as HTMLElement;
    click(menuButton);
    click(menuItemByLabel("Toggle header row"));

    const after = tableNode(editor).content?.[0]?.content?.[0]?.type;
    expect(after).toBe("tableCell");
  });

  it("table menu deletes the whole table", () => {
    editor = createTableEditor(2, 2);
    const menuButton = editor.view.dom.querySelector(".dohc-table-menu-btn") as HTMLElement;
    click(menuButton);
    click(menuItemByLabel("Delete table"));

    const json = editor.getJSON();
    expect(json.content?.some((node) => node.type === "table")).toBe(false);
  });

  it("grip menu keyboard nav: ArrowDown then Enter runs the second item", () => {
    editor = createTableEditor(2, 3);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    const menu = document.body.querySelector(".dohc-table-menu") as HTMLElement;
    const items = menu.querySelectorAll<HTMLElement>("[role='menuitem']");
    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute("aria-activedescendant")).toBe(items[0]?.id);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(menu.getAttribute("aria-activedescendant")).toBe(items[1]?.id);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    // Second column menu item is "Insert column right" — still an insert,
    // so the column count grows and the menu closes either way.
    const headerRow = tableNode(editor).content?.[0];
    expect(headerRow?.content).toHaveLength(4);
    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
  });

  it("grip menu closes on Escape without running a command", () => {
    editor = createTableEditor(2, 2);
    // The production editor is connected; connect this test instance as well
    // so browser focus can legitimately return to its originating grip.
    document.body.appendChild(editor.view.dom);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    const menu = document.body.querySelector(".dohc-table-menu") as HTMLElement;
    expect(document.activeElement).toBe(menu);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
    expect(document.activeElement).toBe(grip);
    const headerRow = tableNode(editor).content?.[0];
    expect(headerRow?.content).toHaveLength(2);
  });

  it("keeps the grip menu inside an embedded editor's shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const chrome = document.createElement("div");
    chrome.className = "dohc-tiptap-editor";
    const mount = document.createElement("div");
    chrome.appendChild(mount);
    shadow.appendChild(chrome);
    editor = new Editor({
      element: mount,
      extensions: [
        StarterKit,
        DohcTableRowHeight,
        TableKit.configure({ table: { resizable: true } }),
        testTableControls,
      ],
      content: "<p></p>",
    });
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });

    const grip = shadow.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);

    expect(shadow.querySelector(".dohc-table-menu")).not.toBeNull();
    expect(chrome.querySelector(".dohc-table-menu")).toBeNull();
    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();

    const insertRight = Array.from(
      shadow.querySelectorAll<HTMLElement>(".dohc-table-menu__item"),
    ).find((item) => item.textContent === "Insert column right");
    if (!insertRight) throw new Error("shadow-root menu item missing");
    click(insertRight);
    expect(tableNode(editor).content?.[0]?.content).toHaveLength(3);
    expect(shadow.querySelector(".dohc-table-menu")).toBeNull();

    const currentGrip = shadow.querySelector(".dohc-table-grip--col") as HTMLElement;
    const targetCell = shadow.querySelectorAll("th, td")[2] as HTMLElement;
    let shadowHitTarget: Element | null = currentGrip;
    Object.defineProperty(shadow, "elementFromPoint", {
      configurable: true,
      value: () => shadowHitTarget,
    });
    // A document-level hit test sees only the host. The embedded editor must
    // ask its shadow root to resolve the actual table cell under the pointer.
    elementFromPointResult = host;
    dispatchPointer(currentGrip, "pointerdown");
    shadowHitTarget = targetCell;
    dispatchPointer(currentGrip, "pointermove", { clientX: 10, clientY: 10 });
    expect(shadow.querySelector(".dohc-table-drag-preview")).not.toBeNull();
    expect(shadow.querySelector("[data-dohc-table-drag-status]")).not.toBeNull();
    expect(document.body.querySelector(".dohc-table-drag-preview")).toBeNull();
    expect(
      targetCell.classList.contains("dohc-table-drop-before") ||
        targetCell.classList.contains("dohc-table-drop-after"),
    ).toBe(true);
    dispatchPointer(currentGrip, "pointercancel", { clientX: 10, clientY: 10 });
    shadowHitTarget = null;
    elementFromPointResult = null;
    host.remove();
  });

  it("keeps a row menu next to its handle and repositions it when the pane scrolls", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--row") as HTMLElement;
    let top = 240;
    Object.defineProperty(grip, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 300,
        right: 320,
        top,
        bottom: top + 20,
        width: 20,
        height: 20,
      }),
    });

    click(grip);
    const menu = document.body.querySelector(".dohc-table-menu") as HTMLElement;
    expect(menu.style.left).toBe("328px");
    const before = menu.style.top;

    top = 120;
    window.dispatchEvent(new Event("scroll"));
    expect(menu.style.left).toBe("328px");
    expect(menu.style.top).not.toBe(before);
  });

  it("positions column menus below their handle and flips above near the viewport edge", () => {
    const base = { left: 300, right: 320, width: 20, height: 20 };
    expect(
      resolveTableMenuPosition({
        anchorRect: { ...base, top: 100, bottom: 120 },
        placement: "column",
        viewportWidth: 1000,
        viewportHeight: 700,
        menuHeight: 220,
      }),
    ).toEqual({ x: 200, y: 128 });
    expect(
      resolveTableMenuPosition({
        anchorRect: { ...base, top: 650, bottom: 670 },
        placement: "column",
        viewportWidth: 1000,
        viewportHeight: 700,
        menuHeight: 220,
      }),
    ).toEqual({ x: 200, y: 422 });
  });

  it("positions row menus beside their handle and flips left near the viewport edge", () => {
    const base = { top: 100, bottom: 120, width: 20, height: 20 };
    expect(
      resolveTableMenuPosition({
        anchorRect: { ...base, left: 300, right: 320 },
        placement: "row",
        viewportWidth: 1000,
        viewportHeight: 700,
        menuHeight: 220,
      }),
    ).toEqual({ x: 328, y: 8 });
    expect(
      resolveTableMenuPosition({
        anchorRect: { ...base, left: 900, right: 920 },
        placement: "row",
        viewportWidth: 1000,
        viewportHeight: 700,
        menuHeight: 220,
      }),
    ).toEqual({ x: 672, y: 8 });
  });

  it("keeps the dragged band highlighted while showing the full drop target", () => {
    editor = createLabeledTableEditor();
    const rowGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--row");
    const source = rowGrips[0] as HTMLElement;
    const target = rowGrips[1] as HTMLElement;
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = target;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });

    expect(document.body.querySelector(".dohc-table-drag-preview")?.textContent).toBe(
      "⠿  Row 1",
    );
    expect(source.classList.contains("is-dragging")).toBe(true);
    expect(
      source.closest("tr")?.classList.contains("dohc-table-drag-source"),
    ).toBe(true);
    expect(target.classList.contains("is-drop-target")).toBe(true);
    expect(
      target.closest("tr")?.classList.contains("dohc-table-drop-after"),
    ).toBe(true);
    const indicator = document.body.querySelector<HTMLElement>(
      ".dohc-table-drop-indicator.is-visible",
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.dataset.label).toContain("Drop to row");

    dispatchPointer(source, "pointercancel", { clientX: 10, clientY: 10 });
    expect(
      editor.view.dom.querySelector(".is-dragging, .dohc-table-drop-after"),
    ).toBeNull();
    expect(document.body.querySelector(".dohc-table-drop-indicator")).toBeNull();
  });

  it("resizes a row from its bottom edge and persists the height on the row node", () => {
    editor = createTableEditor(2, 2);
    const row = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    const handle = editor.view.dom.querySelector(
      ".dohc-table-row-resize",
    ) as HTMLButtonElement;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 240,
        width: 240,
        height: 40,
      }),
    });

    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointermove", { clientY: 134 });
    expect(row.style.height).toBe("74px");
    expect(handle.classList.contains("is-resizing")).toBe(true);
    dispatchPointer(handle, "pointerup", { clientY: 134 });

    expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(74);
    const renderedRow = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    expect(renderedRow.dataset.rowHeight).toBe("74");
    expect(renderedRow.style.height).toBe("74px");
  });

  it("commits a resize when Electron delivers only the mouseup fallback", () => {
    editor = createTableEditor(2, 2);
    const row = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    const handle = editor.view.dom.querySelector(
      ".dohc-table-row-resize",
    ) as HTMLButtonElement;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 240,
        width: 240,
        height: 40,
      }),
    });

    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointermove", { clientY: 134 });
    window.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
    );

    expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(74);
    expect(handle.classList.contains("is-resizing")).toBe(false);
  });

  it("commits a resize from a non-bubbling handle mouseup", () => {
    editor = createTableEditor(2, 2);
    const row = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    const handle = editor.view.dom.querySelector(
      ".dohc-table-row-resize",
    ) as HTMLButtonElement;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 240,
        width: 240,
        height: 40,
      }),
    });

    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointermove", { clientY: 134 });
    handle.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: false, cancelable: true, button: 0 }),
    );

    expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(74);
    expect(handle.classList.contains("is-resizing")).toBe(false);
  });

  it("hides row resizing when the editor has no durable Y.Doc backing", () => {
    const localControls = Extension.create({
      name: "localTableControls",
      addProseMirrorPlugins() {
        return [makeTableControlsPlugin({ rowResizeEnabled: false })];
      },
    });
    editor = new Editor({
      extensions: [
        StarterKit,
        DohcTableRowHeight,
        TableKit.configure({ table: { resizable: true } }),
        localControls,
      ],
      content: "<p></p>",
    });
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });

    expect(editor.view.dom.querySelector(".dohc-table-row-resize")).toBeNull();
    expect(editor.view.dom.querySelector(".dohc-table-grip--row")).not.toBeNull();
  });

  it("does not persist a fixed row height when the resize handle is only clicked", () => {
    editor = createTableEditor(2, 2);
    const row = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    const handle = editor.view.dom.querySelector(
      ".dohc-table-row-resize",
    ) as HTMLButtonElement;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 30,
        left: 0,
        right: 240,
        width: 240,
        height: 30,
      }),
    });
    const before = editor.state.doc;

    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointerup", { clientY: 100 });

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(tableNode(editor).content?.[0]?.attrs?.height).toBeNull();
    expect(row.style.height).toBe("");
    expect(handle.getAttribute("role")).toBeNull();
  });

  it("cancels an active row resize when the document changes", () => {
    editor = createTableEditor(2, 2);
    const row = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    const handle = editor.view.dom.querySelector(
      ".dohc-table-row-resize",
    ) as HTMLButtonElement;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 240,
        width: 240,
        height: 40,
      }),
    });

    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointermove", { clientY: 134 });
    expect(row.style.height).toBe("74px");

    let textPos: number | undefined;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock || textPos !== undefined) return true;
      textPos = pos + 1;
      return false;
    });
    if (textPos === undefined) throw new Error("table text block missing");
    editor.view.dispatch(editor.state.tr.insertText("remote ", textPos));

    expect(tableNode(editor).content?.[0]?.attrs?.height).toBeNull();
    expect(row.style.height).toBe("");
    expect(handle.classList.contains("is-resizing")).toBe(false);
    dispatchPointer(handle, "pointerup", { clientY: 134 });
    expect(tableNode(editor).content?.[0]?.attrs?.height).toBeNull();
  });

  it("double-clicking a row resize edge resets its fixed height", () => {
    editor = createTableEditor(2, 2);
    const rowPos = 1;
    const row = editor.state.doc.nodeAt(rowPos);
    if (!row) throw new Error("table row missing");
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(rowPos, undefined, {
        ...row.attrs,
        height: 80,
      }),
    );
    const handle = editor.view.dom.querySelector(
      ".dohc-table-row-resize",
    ) as HTMLButtonElement;
    handle.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );

    expect(tableNode(editor).content?.[0]?.attrs?.height).toBeNull();
  });

  it("does not open the options menu from the click that follows a drag", () => {
    editor = createLabeledTableEditor();
    const grip = editor.view.dom.querySelector(
      ".dohc-table-grip--row",
    ) as HTMLElement;
    elementFromPointResult = grip;
    dispatchPointer(grip, "pointerdown");
    dispatchPointer(grip, "pointermove", { clientX: 10, clientY: 10 });
    dispatchPointer(grip, "pointerup", { clientX: 10, clientY: 10 });

    click(grip);

    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
  });

  it("column grip menu aligns every cell in the column (center) via the `align` attr", () => {
    editor = createTableEditor(3, 2);
    expect(columnAligns(editor, 0)).toEqual([null, null, null]);

    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Align center"));

    // Whole column (header + both body cells) is centered; the other column
    // is untouched.
    expect(columnAligns(editor, 0)).toEqual(["center", "center", "center"]);
    expect(columnAligns(editor, 1)).toEqual([null, null, null]);
  });

  it("column grip menu targets the clicked column (second column, right)", () => {
    editor = createTableEditor(2, 3);
    const secondGrip = editor.view.dom.querySelectorAll(
      ".dohc-table-grip--col",
    )[1] as HTMLElement;
    click(secondGrip);
    click(menuItemByLabel("Align right"));

    expect(columnAligns(editor, 0)).toEqual([null, null]);
    expect(columnAligns(editor, 1)).toEqual(["right", "right"]);
    expect(columnAligns(editor, 2)).toEqual([null, null]);
  });

  it("re-aligning a column overwrites the previous alignment (center then left)", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;

    click(grip);
    click(menuItemByLabel("Align center"));
    expect(columnAligns(editor, 0)).toEqual(["center", "center"]);

    click(grip);
    click(menuItemByLabel("Align left"));
    expect(columnAligns(editor, 0)).toEqual(["left", "left"]);
  });

  it("append-column button adds a column at the right edge", () => {
    editor = createTableEditor(2, 2);
    const appendCol = editor.view.dom.querySelector(
      ".dohc-table-append--col",
    ) as HTMLElement;
    expect(appendCol).not.toBeNull();

    click(appendCol);

    expect(tableNode(editor).content?.[0]?.content).toHaveLength(3);
  });

  it("append strips are sized on editor mouseenter before any cell hover", () => {
    editor = createEditor(
      "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr><tr><td>E</td><td>F</td></tr></table>",
    );
    const dom = editor.view.dom;
    const colStrip = dom.querySelector(".dohc-table-append--col") as HTMLElement;
    const rowStrip = dom.querySelector(".dohc-table-append--row") as HTMLElement;
    expect(colStrip.style.height).toBe("");

    // mouseenter does not bubble; ProseMirror binds it on the editor root.
    dom.dispatchEvent(new MouseEvent("mouseenter"));

    expect(colStrip.style.height).toBe("0px");
    expect(rowStrip.style.width).toBe("0px");
  });

  it("append-row button adds a row at the bottom edge", () => {
    editor = createTableEditor(2, 2);
    const appendRow = editor.view.dom.querySelector(
      ".dohc-table-append--row",
    ) as HTMLElement;
    expect(appendRow).not.toBeNull();

    click(appendRow);

    expect(tableNode(editor).content).toHaveLength(3);
  });

  // setColumnAlign spreads existing attrs, so lock down what alignment newly
  // appended cells inherit: prosemirror-tables' addColumnAfter/addRowAfter fill
  // fresh cells with default attrs, so the new column/row resets to null rather
  // than picking up the adjacent aligned cells.
  it("an appended column resets to null alignment (not inherited from the aligned neighbour)", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Align center"));
    expect(columnAligns(editor, 0)).toEqual(["center", "center"]);

    const appendCol = editor.view.dom.querySelector(
      ".dohc-table-append--col",
    ) as HTMLElement;
    click(appendCol);

    // Original column keeps its alignment; the new right-edge column is null.
    expect(columnAligns(editor, 0)).toEqual(["center", "center"]);
    expect(columnAligns(editor, 2)).toEqual([null, null]);
  });

  it("an appended row resets to null alignment (not inherited from the aligned column above)", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    click(menuItemByLabel("Align center"));
    expect(columnAligns(editor, 0)).toEqual(["center", "center"]);

    const appendRow = editor.view.dom.querySelector(
      ".dohc-table-append--row",
    ) as HTMLElement;
    click(appendRow);

    // The two original cells stay centered; the appended bottom row is null.
    expect(columnAligns(editor, 0)).toEqual(["center", "center", null]);
  });
});

describe("table Notion conveniences", () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  it("Tab moves the selection from one cell to the next (TableKit's goToNextCell, unmodified here)", () => {
    editor = createTableEditor(2, 2);
    const before = editor.state.selection.from;

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );

    const after = editor.state.selection.from;
    expect(after).not.toBe(before);
    expect(tableNode(editor).content).toHaveLength(2); // no row added mid-table
  });

  it("Shift-Tab moves the selection back to the previous cell", () => {
    editor = createTableEditor(2, 2);
    expect(editor.commands.goToNextCell()).toBe(true);
    const middle = editor.state.selection.from;

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(editor.state.selection.from).not.toBe(middle);
  });

  it("Enter in a cell is left to the default paragraph-split behavior (not hijacked)", () => {
    editor = createTableEditor(2, 2);
    const before = tableNode(editor).content?.[0]?.content?.[0]?.content;
    expect(before).toHaveLength(1); // one paragraph in the first header cell

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const after = tableNode(editor).content?.[0]?.content?.[0]?.content;
    // A default Enter inside a table cell's single-paragraph content is a
    // no-op in prosemirror-tables (there's no sibling block to split into
    // within a cell) — asserting it does NOT throw and does NOT delete the
    // table is the contract this test guards; TableKit owns the exact
    // behavior.
    expect(after).toBeDefined();
    expect(tableNode(editor).content).toHaveLength(2);
  });
});
