// @vitest-environment jsdom
import { Editor, Extension, type JSONContent } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeTableControlsPlugin,
  resolveTableDropDestination,
  resolveTableMenuPosition,
} from "./tableControls";
import { DohcTableRowHeight } from "./extensions";
import { SafeTrailingNode } from "./safeTrailingNode";

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

function labeledTable(prefix = "") {
  return {
    type: "table",
    content: ["A", "B", "C"].map((rowLabel) => ({
      type: "tableRow",
      content: ["1", "2", "3"].map((columnLabel) => ({
        type: rowLabel === "A" ? "tableHeader" : "tableCell",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `${prefix}${rowLabel}${columnLabel}` }],
          },
        ],
      })),
    })),
  };
}

function createLabeledTableEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      DohcTableRowHeight,
      TableKit.configure({ table: { resizable: true } }),
      testTableControls,
    ],
    content: { type: "doc", content: [labeledTable()] },
  });
}

// Two 3x3 tables, x and y, between paragraphs. The closing paragraph keeps
// the trailing-node plugin from adding one during the first edit.
function createTwoTableEditor(): Editor {
  const paragraph = (text: string) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
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
        paragraph("Intro"),
        labeledTable("x"),
        paragraph("Between"),
        labeledTable("y"),
        paragraph("Outro"),
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

// The witness observes any gesture DOM change, including ignored grip attributes.
// ProseMirror registered its real observer first and settles before this callback.
function afterDOMMutation(root: Node): Promise<void> {
  return new Promise((resolve) => {
    const witness = new MutationObserver(() => {
      witness.disconnect();
      resolve();
    });
    witness.observe(root, { attributes: true, childList: true, subtree: true });
  });
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

function tableNode(editor: Editor, index = 0): JsonNode {
  const json = editor.getJSON() as unknown as { content?: JsonNode[] };
  const table = json.content?.filter((node) => node.type === "table")[index];
  if (!table) throw new Error("no table in doc");
  return table;
}

// The align attr each cell in `colIndex` carries, top row to bottom.
function columnAligns(editor: Editor, colIndex: number): (string | null)[] {
  return (tableNode(editor).content ?? []).map(
    (row) => row.content?.[colIndex]?.attrs?.align ?? null,
  );
}

function tableTextGrid(editor: Editor, index = 0): string[][] {
  return (tableNode(editor, index).content ?? []).map((row) =>
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
  let editorFrame: HTMLIFrameElement | undefined;

  function moveEditorToFrame(target: Editor): Window {
    editorFrame = document.createElement("iframe");
    document.body.append(editorFrame);
    const frameDocument = editorFrame.contentDocument!;
    Object.defineProperty(frameDocument, "elementFromPoint", {
      configurable: true,
      value: () => elementFromPointResult,
    });
    const content = target.getJSON();
    target.commands.clearContent();
    frameDocument.body.append(target.view.dom);
    target.view.updateRoot();
    // Build fresh widgets after the editor moves. Their detached buttons
    // start in the global document and are adopted when ProseMirror inserts them.
    target.commands.setContent(content);
    return editorFrame.contentWindow!;
  }

  afterEach(() => {
    elementFromPointResult = null;
    document.body.querySelector(".dohc-table-menu")?.remove();
    document.body.querySelector(".dohc-table-drag-preview")?.remove();
    document.body.querySelector(".dohc-table-drop-indicator")?.remove();
    editor?.destroy();
    editor = undefined;
    editorFrame?.remove();
    editorFrame = undefined;
  });

  function dragFirstRowToLast(target: Editor): void {
    const grips = target.view.dom.querySelectorAll(".dohc-table-grip--row");
    drag(grips[0] as HTMLElement, grips[2] as HTMLElement);
  }

  function dragStatusText(): (string | null)[] {
    return Array.from(
      document.body.querySelectorAll("[data-dohc-table-drag-status]"),
    ).map((region) => region.textContent);
  }

  it("takes its drag live region down with the editor", () => {
    editor = createLabeledTableEditor();
    dragFirstRowToLast(editor);
    const status = document.body.querySelector("[data-dohc-table-drag-status]");
    expect(status?.getAttribute("role")).toBe("status");
    // Without this the region is announced only when focus lands on it, which
    // for an off-screen status node means never.
    expect(status?.getAttribute("aria-live")).toBe("polite");

    editor.destroy();
    editor = undefined;

    // A live region left on `document.body` outlives its editor: every
    // workspace switch would add one more for a screen reader to enumerate.
    expect(document.body.querySelector("[data-dohc-table-drag-status]")).toBeNull();
  });

  it("gives each mounted editor its own live region", () => {
    const first = createLabeledTableEditor();
    const second = createLabeledTableEditor();
    editor = second;

    dragFirstRowToLast(first);
    const columnGrips = second.view.dom.querySelectorAll(".dohc-table-grip--col");
    drag(columnGrips[0] as HTMLElement, columnGrips[2] as HTMLElement);

    // One region per editor, each holding its own editor's announcement. A
    // single shared region would let one editor announce into the other's.
    expect(dragStatusText()).toEqual([
      "Row 1 moved to position 3.",
      "Column 1 moved to position 3.",
    ]);

    first.destroy();

    expect(dragStatusText()).toEqual(["Column 1 moved to position 3."]);
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
      ".dohc-table-grip--row.is-active",
    );
    const visibleColumns = editor.view.dom.querySelectorAll(
      ".dohc-table-grip--col.is-active",
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
      ".dohc-table-row-resize.is-active",
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

  it.each(["release", "Escape"])("handles a table drag's %s in the editor's window", (ending) => {
    editor = createLabeledTableEditor();
    const editorWindow = moveEditorToFrame(editor);
    const source = editor.view.dom.querySelector(".dohc-table-grip--row") as HTMLElement;
    expect(source.ownerDocument.defaultView).toBe(editorWindow);
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = editor.view.dom.querySelectorAll("tr")[2]!.cells[1]!;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });
    expect(source.getAttribute("aria-grabbed")).toBe("true");
    elementFromPointResult = null;

    editorWindow.dispatchEvent(ending === "release"
      ? new MouseEvent("mouseup", { button: 0 })
      : new KeyboardEvent("keydown", { key: "Escape" }));

    expect(source.getAttribute("aria-grabbed")).toBe("false");
    expect(tableTextGrid(editor).map((row) => row[0])).toEqual(
      ending === "release" ? ["B1", "C1", "A1"] : ["A1", "B1", "C1"],
    );
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

  it.each(["row", "column", "resize"] as const)(
    "keeps a fresh table-ending document unchanged during %s gesture feedback and cancellation",
    async (gesture) => {
      editor = new Editor({
        extensions: [
          StarterKit.configure({ trailingNode: false }),
          SafeTrailingNode.configure({ node: "paragraph", notAfter: ["paragraph"] }),
          DohcTableRowHeight,
          TableKit.configure({ table: { resizable: true } }),
          testTableControls,
        ],
        content: { type: "doc", content: [labeledTable()] },
      });
      const view = editor.view;
      document.body.append(view.dom);
      try {
        const table = renderedTable(editor, 0);
        const selector = gesture === "resize"
          ? '.dohc-table-row-resize[data-table-row-resize="1"]'
          : gesture === "row"
            ? '.dohc-table-grip--row[data-row="1"]'
            : '.dohc-table-grip--col[data-col="1"]';
        const source = table.querySelector<HTMLElement>(selector)!;
        const originalDoc = editor.state.doc;
        const originalContent = editor.getJSON();
        const expectUnchangedDocument = () => {
          expect(editor!.state.doc).toBe(originalDoc);
          expect(editor!.getJSON()).toEqual(originalContent);
          expect(editor!.state.doc.childCount).toBe(1);
          expect(editor!.state.doc.lastChild?.type.name).toBe("table");
        };
        if (gesture === "resize") {
          Object.defineProperty(table.rows[1]!, "getBoundingClientRect", {
            configurable: true,
            value: () => ({ top: 0, bottom: 40, left: 0, right: 240, width: 240, height: 40 }),
          });
        }
        expectUnchangedDocument();
        const startSettled = afterDOMMutation(view.dom);
        elementFromPointResult = source;
        dispatchPointer(source, "pointerdown", { clientY: 100 });
        if (gesture !== "resize") {
          dispatchPointer(source, "pointermove", { clientX: 8, clientY: 108 });
        }
        await startSettled;
        expectUnchangedDocument();
        expect(source.getAttribute("aria-grabbed")).toBe("true");

        const feedbackSettled = afterDOMMutation(view.dom);
        elementFromPointResult = gesture === "row" ? table.rows[2]!.cells[0]! : table.rows[1]!.cells[2]!;
        dispatchPointer(view.dom, "pointermove", { clientX: 20, clientY: 134 });
        await feedbackSettled;
        expectUnchangedDocument();
        if (gesture === "resize") {
          expect(table.rows[1]!.style.height).toBe("74px");
          expect(tableNode(editor).content?.[1]?.attrs?.height).toBeNull();
        } else {
          expect(document.body.querySelector<HTMLElement>(".dohc-table-drop-indicator.is-visible")?.dataset.label)
            .toBe(`Drop to ${gesture} 3`);
        }

        const cancelSettled = afterDOMMutation(view.dom);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await cancelSettled;
        expectUnchangedDocument();
        expect(source.getAttribute("aria-grabbed")).toBe("false");
        expect(table.querySelector(".is-dragging, .is-resizing, .dohc-table-drag-source, .dohc-table-row-is-resizing")).toBeNull();
        expect(document.body.querySelector(".dohc-table-drag-preview, .dohc-table-drop-indicator")).toBeNull();
        if (gesture === "resize") expect(table.rows[1]!.style.height).toBe("");
        dispatchPointer(view.dom, "pointerup", { clientX: 20, clientY: 134 });
        expectUnchangedDocument();
      } finally {
        view.dom.remove();
      }
    },
  );

  it.each(["row", "column"] as const)(
    "keeps a %s drag through actual observer settlement",
    async (band) => {
      editor = createLabeledTableEditor();
      // Settle StarterKit's trailing paragraph before the gesture's document snapshot.
      editor.commands.setTextSelection(textPos(editor, "A1"));
      const view = editor.view;
      document.body.append(view.dom);
      try {
        const table = renderedTable(editor, 0);
        const selector = band === "row"
          ? '.dohc-table-grip--row[data-row="1"]'
          : '.dohc-table-grip--col[data-col="1"]';
        const source = table.querySelector<HTMLElement>(selector)!;
        const originalDoc = editor.state.doc;
        elementFromPointResult = source;
        dispatchPointer(source, "pointerdown");
        const sourceSettled = afterDOMMutation(view.dom);
        dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });
        await sourceSettled;
        expect.soft(source.isConnected).toBe(true);
        expect.soft(table.querySelector(selector)).toBe(source);
        expect.soft(source.getAttribute("aria-grabbed")).toBe("true");
        expect.soft(editor.state.doc).toBe(originalDoc);

        const targetSettled = afterDOMMutation(view.dom);
        elementFromPointResult = band === "row" ? table.rows[2]!.cells[0]! : table.rows[1]!.cells[2]!;
        dispatchPointer(view.dom, "pointermove", { clientX: 20, clientY: 20 });
        await targetSettled;
        expect.soft(table.querySelector(selector)).toBe(source);
        expect.soft(source.getAttribute("aria-grabbed")).toBe("true");
        expect.soft(document.body.querySelector<HTMLElement>(".dohc-table-drop-indicator.is-visible")?.dataset.label)
          .toBe(`Drop to ${band} 3`);
        expect.soft(editor.state.doc).toBe(originalDoc);

        elementFromPointResult = band === "row" ? table.rows[2]!.cells[0]! : table.rows[1]!.cells[2]!;
        dispatchPointer(view.dom, "pointerup", { clientX: 20, clientY: 20 });
        expect.soft(document.body.querySelector(".dohc-table-drag-preview, .dohc-table-drop-indicator")).toBeNull();
        expect(tableTextGrid(editor)).toEqual(band === "row"
          ? [["A1", "A2", "A3"], ["C1", "C2", "C3"], ["B1", "B2", "B3"]]
          : [["A1", "A3", "A2"], ["B1", "B3", "B2"], ["C1", "C3", "C2"]]);
      } finally {
        view.dom.remove();
      }
    },
  );

  it("keeps a pointer row resize through actual observer settlement", async () => {
    editor = createLabeledTableEditor();
    // Settle StarterKit's trailing paragraph before the gesture's document snapshot.
    editor.commands.setTextSelection(textPos(editor, "A1"));
    const view = editor.view;
    document.body.append(view.dom);
    try {
      const table = renderedTable(editor, 0);
      const row = table.rows[1]!;
      const handle = row.querySelector<HTMLElement>(".dohc-table-row-resize")!;
      const originalDoc = editor.state.doc;
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 0, bottom: 40, left: 0, right: 240, width: 240, height: 40 }),
      });
      const downSettled = afterDOMMutation(view.dom);
      dispatchPointer(handle, "pointerdown", { clientY: 100 });
      await downSettled;
      expect.soft(table.rows[1]).toBe(row);
      expect.soft(handle.isConnected).toBe(true);
      expect.soft(table.rows[1]!.querySelector(".dohc-table-row-resize")).toBe(handle);
      expect.soft(editor.state.doc).toBe(originalDoc);
      const moveSettled = afterDOMMutation(row);
      dispatchPointer(view.dom, "pointermove", { clientY: 134 });
      await moveSettled;
      expect.soft(table.rows[1]!.style.height).toBe("74px");
      expect.soft(editor.state.doc).toBe(originalDoc);
      dispatchPointer(view.dom, "pointerup", { clientY: 134 });
      expect(tableNode(editor).content?.[1]?.attrs?.height).toBe(74);
      expect(table.rows[1]!.style.height).toBe("74px");
    } finally {
      view.dom.remove();
    }
  });

  it.each(["Escape", "click"] as const)(
    "keeps a saved row height after pointer resize %s and observer settlement",
    async (ending) => {
      editor = createLabeledTableEditor();
      const savedRow = editor.state.doc.nodeAt(1)!;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(1, undefined, {
        ...savedRow.attrs,
        height: 74,
      }));
      const view = editor.view;
      document.body.append(view.dom);
      try {
        const table = renderedTable(editor, 0);
        const row = table.rows[0]!;
        const handle = row.querySelector<HTMLElement>(".dohc-table-row-resize")!;
        const originalDoc = editor.state.doc;
        Object.defineProperty(row, "getBoundingClientRect", {
          configurable: true,
          value: () => ({ top: 0, bottom: 74, left: 0, right: 240, width: 240, height: 74 }),
        });
        expect(row.dataset.rowHeight).toBe("74");
        expect(row.style.height).toBe("74px");
        const downSettled = afterDOMMutation(view.dom);
        dispatchPointer(handle, "pointerdown", { clientY: 100 });
        await downSettled;
        expect(table.rows[0]).toBe(row);
        expect(editor.state.doc).toBe(originalDoc);

        if (ending === "Escape") {
          const moveSettled = afterDOMMutation(view.dom);
          dispatchPointer(view.dom, "pointermove", { clientY: 134 });
          await moveSettled;
          expect(table.rows[0]!.style.height).toBe("108px");
          expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(74);
          expect(editor.state.doc).toBe(originalDoc);
        }

        const endSettled = afterDOMMutation(view.dom);
        if (ending === "Escape") {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        } else {
          dispatchPointer(view.dom, "pointerup", { clientY: 100 });
        }
        await endSettled;
        expect(editor.state.doc).toBe(originalDoc);
        expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(74);
        expect(table.rows[0]!.dataset.rowHeight).toBe("74");
        expect(table.rows[0]!.style.height).toBe("74px");
        expect(handle.getAttribute("aria-grabbed")).toBe("false");
        expect(table.querySelector(".is-resizing, .dohc-table-row-is-resizing")).toBeNull();
      } finally {
        view.dom.remove();
      }
    },
  );

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

  it.each(["release", "Escape"])("handles a row resize's %s in the editor's window", (ending) => {
    editor = createTableEditor(2, 2);
    const editorWindow = moveEditorToFrame(editor);
    const row = editor.view.dom.querySelector("tr") as HTMLTableRowElement;
    const handle = editor.view.dom.querySelector(".dohc-table-row-resize") as HTMLButtonElement;
    expect(handle.ownerDocument.defaultView).toBe(editorWindow);
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, bottom: 40, left: 0, right: 240, width: 240, height: 40 }),
    });
    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointermove", { clientY: 134 });
    expect(row.style.height).toBe("74px");

    editorWindow.dispatchEvent(ending === "release"
      ? new MouseEvent("mouseup", { button: 0 })
      : new KeyboardEvent("keydown", { key: "Escape" }));

    expect(handle.getAttribute("aria-grabbed")).toBe("false");
    expect(handle.classList.contains("is-resizing")).toBe(false);
    expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(ending === "release" ? 74 : null);
    expect(row.style.height).toBe(ending === "release" ? "74px" : "");
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
    let reachedWindow = false;
    const markWindowMouseup = () => {
      reachedWindow = true;
    };
    window.addEventListener("mouseup", markWindowMouseup, true);
    try {
      expect(handle.isConnected).toBe(false);
      handle.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: false,
          cancelable: true,
          button: 0,
        }),
      );
    } finally {
      window.removeEventListener("mouseup", markWindowMouseup, true);
    }

    expect(reachedWindow).toBe(false);
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

  it("refreshes edge hit areas after layout changes while the same cell stays hovered", () => {
    editor = createTableEditor(2, 2);
    const dom = editor.view.dom;
    const table = dom.querySelector("table")!;
    const cells = [...table.querySelectorAll<HTMLElement>("td, th")];
    const colStrip = table.querySelector<HTMLElement>(".dohc-table-append--col")!;
    const rowStrip = table.querySelector<HTMLElement>(".dohc-table-append--row")!;
    const resizeHandles = [...table.querySelectorAll<HTMLElement>(".dohc-table-row-resize")];
    let width = 200;
    let height = 100;
    Object.defineProperty(table, "getBoundingClientRect", {
      value: () => new DOMRect(20, 30, width, height),
    });
    cells.forEach((cell, index) => {
      Object.defineProperty(cell, "getBoundingClientRect", {
        value: () => new DOMRect(
          20 + (index % 2) * width / 2,
          30 + Math.floor(index / 2) * height / 2,
          width / 2,
          height / 2,
        ),
      });
    });
    dom.dispatchEvent(new MouseEvent("mouseenter"));
    cells[0]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(colStrip.style.height).toBe("100px");
    expect(rowStrip.style.width).toBe("200px");
    expect(resizeHandles.map((handle) => handle.style.width)).toEqual(["200px", "200px"]);

    const unchangedDocument = editor.state.doc;
    width = 340;
    height = 180;
    cells[0]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    expect(editor.state.doc).toBe(unchangedDocument);
    expect(colStrip.style.height).toBe("180px");
    expect(rowStrip.style.width).toBe("340px");
    expect(resizeHandles.map((handle) => handle.style.width)).toEqual(["340px", "340px"]);
    expect(table.querySelectorAll(".dohc-table-row-resize.is-active")).toHaveLength(1);
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
    // within a cell) — asserting it does not throw and does not delete the
    // table is the contract this test guards; TableKit owns the exact
    // behavior.
    expect(after).toBeDefined();
    expect(tableNode(editor).content).toHaveLength(2);
  });
});

const CONTROL_SELECTOR =
  ".dohc-table-grip, .dohc-table-row-resize, .dohc-table-menu-btn, .dohc-table-append";

function controlsOf(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(CONTROL_SELECTOR));
}

function expectSameControls(actual: HTMLElement[], expected: HTMLElement[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((control, index) => expect(control).toBe(expected[index]));
}

// Each table's box reads, in the order given.
function countTableReads(tables: HTMLTableElement[]): number[] {
  const reads = tables.map(() => 0);
  tables.forEach((table, index) => {
    Object.defineProperty(table, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        reads[index] = (reads[index] ?? 0) + 1;
        return new DOMRect();
      },
    });
  });
  return reads;
}

// A 2x2 table whose second-row first cell holds a 2x2 table, between
// paragraphs. The inner cells read i00 to i11.
function createNestedTableEditor(): Editor {
  const paragraph = (text: string): JSONContent => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  const table = (cell: (row: number, column: number) => JSONContent[]): JSONContent => ({
    type: "table",
    content: [0, 1].map((row) => ({
      type: "tableRow",
      content: [0, 1].map((column) => ({
        type: "tableCell",
        content: cell(row, column),
      })),
    })),
  });
  const inner = table((row, column) => [paragraph(`i${row}${column}`)]);
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
        paragraph("Intro"),
        table((row, column) =>
          row === 1 && column === 0
            ? [paragraph("o10"), inner]
            : [paragraph(`o${row}${column}`)],
        ),
        paragraph("Outro"),
      ],
    },
  });
}

function renderedTable(editor: Editor, index: number): HTMLTableElement {
  const table = editor.view.dom.querySelectorAll("table")[index];
  if (!table) throw new Error(`table ${index} missing`);
  return table;
}

function textPos(editor: Editor, text: string): number {
  let found: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    const index = node.text?.indexOf(text) ?? -1;
    if (index >= 0) found = pos + index;
    return true;
  });
  if (found === undefined) throw new Error(`text "${text}" missing`);
  return found;
}

// @tiptap/y-tiptap 3.0.8 applies a remote update the way `_typeChanged`
// does: it clears its Y.Doc-to-node mapping, rebuilds every node, then
// replaces the whole document. Unchanged content is equal but no node is the
// same object. It is not local history.
function applyRemote(editor: Editor, change: (tr: Transaction) => void): void {
  const remote = editor.state.tr;
  change(remote);
  const rebuilt = editor.schema.nodeFromJSON(remote.doc.toJSON());
  editor.view.dispatch(
    editor.state.tr
      .replace(0, editor.state.doc.content.size, new Slice(rebuilt.content, 0, 0))
      .setMeta("addToHistory", false),
  );
}

// Rebuilds the document's first table with its cells rearranged by
// `reorder`, which receives and returns the cells row by row.
function reorderFirstTable(
  tr: Transaction,
  reorder: (rows: JSONContent[][]) => JSONContent[][],
): void {
  let tablePos = -1;
  tr.doc.forEach((node, offset) => {
    if (tablePos < 0 && node.type.name === "table") tablePos = offset;
  });
  const table = tr.doc.nodeAt(tablePos);
  if (!table) throw new Error("no table in doc");
  const json = table.toJSON() as JSONContent;
  const rows = reorder((json.content ?? []).map((row) => row.content ?? []));
  json.content = (json.content ?? []).map((row, index) => ({ ...row, content: rows[index] }));
  tr.replaceWith(tablePos, tablePos + table.nodeSize, tr.doc.type.schema.nodeFromJSON(json));
}

// Presses `source` and moves the pointer over `target` without releasing.
function startDrag(source: Element, target: Element): void {
  elementFromPointResult = source;
  dispatchPointer(source, "pointerdown");
  elementFromPointResult = target;
  dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });
}

const documentEdits: Array<[string, (editor: Editor) => void]> = [
  ["text inserted above the table", (e) => e.view.dispatch(e.state.tr.insertText("More ", 1))],
  ["text deleted above the table", (e) => e.view.dispatch(e.state.tr.delete(1, 3))],
  [
    "text inserted in its first cell",
    (e) => e.view.dispatch(e.state.tr.insertText("new ", textPos(e, "xA1"))),
  ],
  [
    "text deleted from its first cell",
    (e) => {
      const pos = textPos(e, "xA1");
      e.view.dispatch(e.state.tr.delete(pos, pos + 1));
    },
  ],
  [
    "an undone cell edit",
    (e) => {
      e.view.dispatch(e.state.tr.insertText("draft ", textPos(e, "xB2")));
      e.commands.undo();
    },
  ],
  [
    "a remote edit in its first cell",
    (e) => applyRemote(e, (tr) => tr.insertText("remote ", textPos(e, "xA1"))),
  ],
  [
    "a row inserted below its header",
    (e) => {
      e.commands.setTextSelection(textPos(e, "xA1"));
      e.commands.addRowAfter();
    },
  ],
];

const controlActions: Array<{
  name: string;
  run: (table: HTMLTableElement) => void;
  check: (editor: Editor, before: string[][]) => void;
}> = [
  {
    name: "appends a column",
    run: (table) => click(table.querySelector(".dohc-table-append--col")!),
    check: (editor, before) =>
      expect(tableTextGrid(editor)).toEqual(before.map((row) => [...row, ""])),
  },
  {
    name: "appends a row",
    run: (table) => click(table.querySelector(".dohc-table-append--row")!),
    check: (editor, before) =>
      expect(tableTextGrid(editor)).toEqual([...before, before[0]!.map(() => "")]),
  },
  {
    name: "aligns the second column",
    run: (table) => {
      click(table.querySelectorAll(".dohc-table-grip--col")[1]!);
      click(menuItemByLabel("Align right"));
    },
    check: (editor) => {
      expect(new Set(columnAligns(editor, 1))).toEqual(new Set(["right"]));
      expect(new Set(columnAligns(editor, 0))).toEqual(new Set([null]));
    },
  },
  {
    name: "duplicates the second column",
    run: (table) => {
      click(table.querySelectorAll(".dohc-table-grip--col")[1]!);
      click(menuItemByLabel("Duplicate column"));
    },
    check: (editor, before) =>
      expect(tableTextGrid(editor)).toEqual(
        before.map((row) => [row[0]!, row[1]!, ...row.slice(1)]),
      ),
  },
  {
    name: "duplicates the second row",
    run: (table) => {
      click(table.querySelectorAll(".dohc-table-grip--row")[1]!);
      click(menuItemByLabel("Duplicate row"));
    },
    check: (editor, before) =>
      expect(tableTextGrid(editor)).toEqual([
        ...before.slice(0, 2),
        before[1]!,
        ...before.slice(2),
      ]),
  },
  {
    name: "drags the first row below the third",
    run: (table) => {
      const grips = table.querySelectorAll(".dohc-table-grip--row");
      drag(grips[0]!, grips[2]!);
    },
    check: (editor, before) =>
      expect(tableTextGrid(editor)).toEqual([
        before[1]!,
        before[2]!,
        before[0]!,
        ...before.slice(3),
      ]),
  },
  {
    name: "resizes the second row from the keyboard",
    run: (table) =>
      table.querySelectorAll(".dohc-table-row-resize")[1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    check: (editor, before) =>
      expect(tableNode(editor).content?.map((row) => row.attrs?.height ?? null)).toEqual(
        before.map((_, index) => (index === 1 ? 38 : null)),
      ),
  },
  {
    name: "toggles the header row",
    run: (table) => {
      click(table.querySelector(".dohc-table-menu-btn")!);
      click(menuItemByLabel("Toggle header row"));
    },
    check: (editor) =>
      expect(tableNode(editor).content?.[0]?.content?.map((cell) => cell.type)).toEqual([
        "tableCell",
        "tableCell",
        "tableCell",
      ]),
  },
];

describe("table controls across document edits", () => {
  let editor: Editor | undefined;

  afterEach(() => {
    elementFromPointResult = null;
    document.body.querySelector(".dohc-table-menu")?.remove();
    editor?.destroy();
    editor = undefined;
  });

  describe.each(documentEdits)("after %s", (_, edit) => {
    it.each(controlActions)("$name at the cell's current position", ({ run, check }) => {
      editor = createTwoTableEditor();
      edit(editor);
      const before = tableTextGrid(editor);
      const second = tableTextGrid(editor, 1);

      run(renderedTable(editor, 0));

      check(editor, before);
      expect(tableTextGrid(editor, 1)).toEqual(second);
    });
  });

  it("keeps every control and reads only the edited table's box while typing", () => {
    editor = createTwoTableEditor();
    const target = editor;
    const tables = [renderedTable(target, 0), renderedTable(target, 1)];
    const reads = countTableReads(tables);
    const controls = tables.map(controlsOf);
    const dispatch = (tr: Transaction) => target.view.dispatch(tr);

    dispatch(target.state.tr.insertText("More ", 1));
    dispatch(target.state.tr.delete(1, 3));
    applyRemote(target, (tr) => tr.insertText("remote ", textPos(target, "Between")));
    expect(reads).toEqual([0, 0]);

    dispatch(target.state.tr.insertText("new ", textPos(target, "xA1")));
    target.commands.undo();
    dispatch(target.state.tr.delete(textPos(target, "xB2"), textPos(target, "xB2") + 1));
    applyRemote(target, (tr) => tr.insertText("remote ", textPos(target, "xC3")));
    expect(reads).toEqual([4, 0]);

    tables.forEach((table, index) => expectSameControls(controlsOf(table), controls[index]!));
    const columnStrip = (table: HTMLTableElement) =>
      table.querySelector<HTMLElement>(".dohc-table-append--col")!.style.height;
    expect(columnStrip(tables[0]!)).toBe("0px");
    expect(columnStrip(tables[1]!)).toBe("");
  });

  it("rebuilds and sizes only the table whose structure changed", () => {
    editor = createTwoTableEditor();
    const [first, second] = [renderedTable(editor, 0), renderedTable(editor, 1)];
    const firstControls = controlsOf(first);
    const secondControls = controlsOf(second);
    const oldAppendRow = second.querySelector(".dohc-table-append--row")!;

    click(oldAppendRow);

    expectSameControls(controlsOf(first), firstControls);
    const rebuilt = controlsOf(second);
    // The new row adds a grip and a resize handle and takes the append strip.
    // Controls in unchanged cells stay.
    expect(rebuilt).toHaveLength(secondControls.length + 2);
    expect(rebuilt).not.toContain(oldAppendRow);
    expect(rebuilt.filter((control) => secondControls.includes(control))).toHaveLength(
      secondControls.length - 1,
    );
    expect(second.querySelector('[data-table-row="3"]')).not.toBeNull();
    expect(first.querySelector<HTMLElement>(".dohc-table-append--col")!.style.height).toBe("");
    expect(second.querySelector<HTMLElement>(".dohc-table-append--col")!.style.height).toBe(
      "0px",
    );
  });

  it("runs the second table's controls after edits in the first", () => {
    editor = createTwoTableEditor();
    editor.view.dispatch(editor.state.tr.insertText("More ", 1));
    editor.view.dispatch(editor.state.tr.insertText("new ", textPos(editor, "xA1")));
    const second = renderedTable(editor, 1);

    click(second.querySelector(".dohc-table-append--col")!);
    click(second.querySelectorAll(".dohc-table-grip--col")[1]!);
    click(menuItemByLabel("Duplicate column"));
    const rowGrips = second.querySelectorAll(".dohc-table-grip--row");
    drag(rowGrips[0]!, rowGrips[2]!);

    expect(tableTextGrid(editor, 1)).toEqual([
      ["yB1", "yB2", "yB2", "yB3", ""],
      ["yC1", "yC2", "yC2", "yC3", ""],
      ["yA1", "yA2", "yA2", "yA3", ""],
    ]);
    expect(tableTextGrid(editor)[0]).toEqual(["new xA1", "xA2", "xA3"]);
  });

  it("duplicates a spanning column after text changes in an earlier cell", () => {
    editor = createColspanTableEditor();
    // The first edit also gets the trailing paragraph; the second is mapped.
    editor.view.dispatch(editor.state.tr.insertText("more ", textPos(editor, "A")));
    editor.view.dispatch(editor.state.tr.insertText("more ", textPos(editor, "A")));

    click(editor.view.dom.querySelector('[data-table-column="1"]')!);
    click(menuItemByLabel("Duplicate column"));

    const header = tableNode(editor).content?.[0]?.content ?? [];
    expect(header.map((cell) => cell.attrs?.colspan)).toEqual([1, 3, 1]);
    expect(tableTextGrid(editor)[1]).toEqual(["A", "B", "B", "C", "D"]);
  });

  it("drops a row dragged while text changes above the table", () => {
    editor = createTwoTableEditor();
    const grips = renderedTable(editor, 0).querySelectorAll(".dohc-table-grip--row");
    const source = grips[0]!;
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = grips[2]!;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });

    editor.view.dispatch(editor.state.tr.insertText("More ", 1));
    dispatchPointer(source, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor)).toEqual([
      ["xB1", "xB2", "xB3"],
      ["xC1", "xC2", "xC3"],
      ["xA1", "xA2", "xA3"],
    ]);
  });

  it("drops nothing when a row inserted mid-gesture moves the dragged row", () => {
    editor = createTwoTableEditor();
    const grips = renderedTable(editor, 0).querySelectorAll(".dohc-table-grip--row");
    const source = grips[1]!;
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = grips[2]!;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });

    editor.commands.setTextSelection(textPos(editor, "xB1"));
    editor.commands.addRowBefore();
    expect(renderedTable(editor, 0).contains(source)).toBe(false);
    dispatchPointer(source, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor).map((row) => row[0])).toEqual(["xA1", "", "xB1", "xC1"]);
    expect(editor.view.dom.querySelector(".is-dragging, .is-reordering")).toBeNull();
    expect(document.body.querySelector(".dohc-table-drag-preview")).toBeNull();
  });

  it("drops nothing when a remote edit deletes the dragged row mid-gesture", () => {
    editor = createTwoTableEditor();
    const grips = renderedTable(editor, 0).querySelectorAll(".dohc-table-grip--row");
    const source = grips[1]!;
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = grips[2]!;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });

    // Row B's handle can survive under row C, which takes its index.
    const $text = editor.state.doc.resolve(textPos(editor, "xB1"));
    const rowDepth = $text.depth - 2;
    applyRemote(editor, (tr) => tr.delete($text.before(rowDepth), $text.after(rowDepth)));
    dispatchPointer(source, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor).map((row) => row[0])).toEqual(["xA1", "xC1"]);
    expect(editor.view.dom.querySelector(".is-dragging, .is-reordering")).toBeNull();
    expect(document.body.querySelector(".dohc-table-drag-preview")).toBeNull();
  });

  it("keeps a drag through a remote edit inside its table's cells", () => {
    editor = createTwoTableEditor();
    const grips = renderedTable(editor, 0).querySelectorAll(".dohc-table-grip--row");
    const source = grips[0]!;
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = grips[2]!;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });

    const target = editor;
    applyRemote(target, (tr) => tr.insertText("new ", textPos(target, "xB2")));
    dispatchPointer(source, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor)).toEqual([
      ["xB1", "new xB2", "xB3"],
      ["xC1", "xC2", "xC3"],
      ["xA1", "xA2", "xA3"],
    ]);
  });

  // Equal-shaped bands that trade places diff as text in several cells, and
  // each handle stays at its index. The drag must not move the other band.
  it("drops nothing when a remote update swaps the dragged row with another", () => {
    editor = createTwoTableEditor();
    const grips = renderedTable(editor, 0).querySelectorAll(".dohc-table-grip--row");
    startDrag(grips[1]!, grips[2]!);

    applyRemote(editor, (tr) => reorderFirstTable(tr, (rows) => [rows[0]!, rows[2]!, rows[1]!]));
    dispatchPointer(grips[1]!, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor).map((row) => row[0])).toEqual(["xA1", "xC1", "xB1"]);
    expect(editor.view.dom.querySelector(".is-dragging, .is-reordering")).toBeNull();
    expect(document.body.querySelector(".dohc-table-drag-preview")).toBeNull();
  });

  it("drops nothing when a remote update swaps the dragged column with another", () => {
    editor = createTwoTableEditor();
    const grips = renderedTable(editor, 0).querySelectorAll(".dohc-table-grip--col");
    startDrag(grips[0]!, grips[2]!);

    applyRemote(editor, (tr) =>
      reorderFirstTable(tr, (rows) => rows.map((cells) => [cells[1]!, cells[0]!, cells[2]!])),
    );
    dispatchPointer(grips[0]!, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor)[1]).toEqual(["xB2", "xB1", "xB3"]);
    expect(editor.view.dom.querySelector(".is-dragging, .is-reordering")).toBeNull();
  });

  it("drops nothing when undo moves the dragged row back", () => {
    editor = createTwoTableEditor();
    const table = renderedTable(editor, 0);
    const rowGrips = () => table.querySelectorAll(".dohc-table-grip--row");
    drag(rowGrips()[1]!, rowGrips()[2]!);
    expect(tableTextGrid(editor).map((row) => row[0])).toEqual(["xA1", "xC1", "xB1"]);

    const source = rowGrips()[1]!;
    startDrag(source, rowGrips()[2]!);
    editor.commands.undo();
    dispatchPointer(source, "pointerup", { clientX: 10, clientY: 10 });

    expect(tableTextGrid(editor).map((row) => row[0])).toEqual(["xA1", "xB1", "xC1"]);
    expect(editor.view.dom.querySelector(".is-dragging, .is-reordering")).toBeNull();
  });

  it("leaves a table between two edits untouched, locally and from collaborators", () => {
    editor = createTwoTableEditor();
    const target = editor;
    const tables = [renderedTable(target, 0), renderedTable(target, 1)];
    const controls = tables.map(controlsOf);
    const reads = countTableReads(tables);

    const local = target.state.tr.insertText("A ", textPos(target, "Intro"));
    local.insertText("B ", local.mapping.map(textPos(target, "Between")));
    target.view.dispatch(local);
    applyRemote(target, (tr) => {
      tr.insertText("C ", textPos(target, "Between"));
      tr.insertText("D ", tr.mapping.map(textPos(target, "Outro")));
    });
    applyRemote(target, (tr) => {
      tr.insertText("E ", textPos(target, "Intro"));
      tr.insertText("F ", tr.mapping.map(textPos(target, "Outro")));
    });

    expect(reads).toEqual([0, 0]);
    tables.forEach((table, index) => expectSameControls(controlsOf(table), controls[index]!));
    click(tables[0]!.querySelector(".dohc-table-append--col")!);
    click(tables[1]!.querySelectorAll(".dohc-table-grip--col")[1]!);
    click(menuItemByLabel("Duplicate column"));
    expect(tableTextGrid(target, 0)[0]).toEqual(["xA1", "xA2", "xA3", ""]);
    expect(tableTextGrid(target, 1)[0]).toEqual(["yA1", "yA2", "yA2", "yA3"]);
  });

  // Nested tables have never had controls of their own. A change inside one
  // updates and measures the table that holds it.
  it("keeps the outer table's controls current through nested table edits", () => {
    editor = createNestedTableEditor();
    const target = editor;
    const [outer, inner] = [renderedTable(target, 0), renderedTable(target, 1)];
    expect(outer.contains(inner)).toBe(true);
    expect(controlsOf(inner)).toHaveLength(0);
    expect(outer.querySelectorAll(".dohc-table-grip--col")).toHaveLength(2);
    expect(outer.querySelectorAll(".dohc-table-grip--row")).toHaveLength(2);
    const controls = controlsOf(outer);
    const reads = countTableReads([outer, inner]);

    target.view.dispatch(target.state.tr.insertText("new ", textPos(target, "i00")));
    applyRemote(target, (tr) => tr.insertText("remote ", textPos(target, "i11")));
    expect(reads).toEqual([2, 0]);
    expectSameControls(controlsOf(outer), controls);

    target.commands.setTextSelection(textPos(target, "i11"));
    target.commands.addRowAfter();
    expect(reads).toEqual([3, 0]);
    expectSameControls(controlsOf(outer), controls);
    expect(controlsOf(inner)).toHaveLength(0);

    outer.querySelectorAll(".dohc-table-row-resize")[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    click(outer.querySelector(".dohc-table-append--col")!);

    const outerRows = tableNode(target).content ?? [];
    expect(outerRows.map((row) => row.attrs?.height ?? null)).toEqual([null, 38]);
    expect(outerRows.map((row) => row.content?.length)).toEqual([3, 3]);
    const nested = outerRows[1]?.content?.[0]?.content?.[1];
    expect(nested?.type).toBe("table");
    expect(nested?.content).toHaveLength(3);
  });

  it("keeps every control through column alignment and row height changes", () => {
    editor = createTwoTableEditor();
    const table = renderedTable(editor, 0);
    const controls = controlsOf(table);
    const grip = table.querySelectorAll<HTMLElement>(".dohc-table-grip--col")[1]!;

    click(grip);
    click(menuItemByLabel("Align center"));
    table.querySelectorAll(".dohc-table-row-resize")[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    expectSameControls(controlsOf(table), controls);
    click(grip);
    click(menuItemByLabel("Duplicate column"));
    expect(columnAligns(editor, 2)).toEqual(["center", "center", "center"]);
    expect(tableNode(editor).content?.[0]?.attrs?.height).toBe(38);
  });

  it("closes an open grip menu when a remote edit arrives", () => {
    editor = createTwoTableEditor();
    click(renderedTable(editor, 0).querySelector(".dohc-table-grip--col")!);
    expect(document.body.querySelector(".dohc-table-menu")).not.toBeNull();

    applyRemote(editor, (tr) => tr.insertText("remote ", 1));

    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
  });

  it("follows editability on the controls it keeps", () => {
    editor = createTwoTableEditor();
    const target = editor;
    target.setEditable(false);
    applyRemote(target, (tr) => tr.insertText("remote ", textPos(target, "xA1")));
    expect(controlsOf(target.view.dom).every((control) => control.disabled)).toBe(true);

    target.setEditable(true);
    expect(controlsOf(target.view.dom).some((control) => control.disabled)).toBe(false);
    click(renderedTable(target, 0).querySelector(".dohc-table-append--col")!);
    expect(tableNode(target).content?.[0]?.content).toHaveLength(4);
  });
});
