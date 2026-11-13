// @vitest-environment jsdom
import { Editor, Extension, getSchema } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { closeHistory } from "@tiptap/pm/history";
import { columnResizingPluginKey } from "@tiptap/pm/tables";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { makeTableControlsPlugin } from "./tableControls";
import { DohcTableRowHeight } from "@dohc/ydoc-projection/markdown-extensions";

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

// A 3 by 3 table whose cells read A1 to C3, after an optional paragraph.
function labeledTableDoc(intro?: string) {
  return {
    type: "doc",
    content: [
      ...(intro ? [{ type: "paragraph", content: [{ type: "text", text: intro }] }] : []),
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
  };
}

function createLabeledTableEditor(intro?: string): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      DohcTableRowHeight,
      TableKit.configure({ table: { resizable: true } }),
      testTableControls,
    ],
    content: labeledTableDoc(intro),
  });
}

const collabExtensions = (document: Y.Doc) => [
  StarterKit.configure({ undoRedo: false }),
  DohcTableRowHeight,
  TableKit.configure({ table: { resizable: true } }),
  testTableControls,
  Collaboration.configure({ document, field: "body" }),
];

// Two editors on two Y.Docs that pass every update to each other, the way a
// collaborator's edits reach a note. Both open the labeled table after "Intro".
async function createSyncedEditors(): Promise<{ local: Editor; peer: Editor }> {
  const localDoc = new Y.Doc();
  const peerDoc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    getSchema(collabExtensions(localDoc)),
    labeledTableDoc("Intro"),
    localDoc.getXmlFragment("body"),
  );
  Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(localDoc));
  localDoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== peerDoc) Y.applyUpdate(peerDoc, update, localDoc);
  });
  peerDoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== localDoc) Y.applyUpdate(localDoc, update, peerDoc);
  });
  const local = new Editor({ extensions: collabExtensions(localDoc) });
  const peer = new Editor({ extensions: collabExtensions(peerDoc) });
  // The sync plugin renders the Y.Doc after the editor is created.
  await vi.waitFor(() => {
    expect(local.view.dom.querySelector("table")).not.toBeNull();
    expect(peer.view.dom.querySelector("table")).not.toBeNull();
  });
  return { local, peer };
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
  // The label is the row's first child; a destructive row adds its Del chip.
  const item = Array.from(menu.querySelectorAll(".dohc-table-menu__item")).find(
    (el) => el.firstElementChild?.textContent === label,
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
    colwidth?: number[] | null;
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

async function createSyncedTableEditors() {
  const { local: editor, peer: collaborator } = await createSyncedEditors();
  const editors = [editor, collaborator];
  editors.forEach((each) => document.body.append(each.view.dom));
  const destroy = () => {
    editors.forEach((each) => {
      const dom = each.view.dom;
      each.destroy();
      dom.remove();
    });
  };
  return { editor, collaborator, destroy };
}

describe("table gestures while the note changes", () => {
  let pair: Awaited<ReturnType<typeof createSyncedTableEditors>> | undefined;
  const errors: unknown[] = [];
  const recordError = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };

  afterEach(() => {
    window.dispatchEvent(new MouseEvent("mouseup"));
    window.removeEventListener("error", recordError);
    pair?.destroy();
    pair = undefined;
    elementFromPointResult = null;
    vi.restoreAllMocks();
    expect(errors.splice(0)).toEqual([]);
  });

  async function setup() {
    window.addEventListener("error", recordError);
    pair = await createSyncedTableEditors();
    return pair;
  }

  function editAbove(editor: Editor) {
    editor.view.dispatch(editor.state.tr.insertText("New text ", 1));
  }

  function editCell(editor: Editor, label: string) {
    let text = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === label) text = pos;
    });
    editor.view.dispatch(editor.state.tr.insertText("x", text));
  }

  function expectNoDragChrome(editor: Editor) {
    expect(editor.view.dom.querySelector(
      ".is-reordering, .is-dragging, .is-drop-target, .dohc-table-drag-source, .dohc-table-drop-before, .dohc-table-drop-after, [aria-grabbed='true']",
    )).toBeNull();
    expect(document.body.querySelector(".dohc-table-drag-preview, .dohc-table-drop-indicator")).toBeNull();
    expect(document.body.querySelector("[data-dohc-table-drag-status]")?.textContent)
      .toBe("Table reorder cancelled.");
  }

  const gestures = [
    { band: "row", origin: "synced" },
    { band: "column", origin: "synced" },
  ];

  function startGripDrag(editor: Editor, band: string) {
    const selector = `.dohc-table-grip--${band === "column" ? "col" : "row"}`;
    const grips = editor.view.dom.querySelectorAll(selector);
    const source = grips[0]!;
    elementFromPointResult = source;
    dispatchPointer(source, "pointerdown");
    elementFromPointResult = grips[2]!;
    dispatchPointer(source, "pointermove", { clientX: 10, clientY: 10 });
    expect(source.getAttribute("aria-grabbed")).toBe("true");
    expect(document.body.querySelector(".dohc-table-drop-indicator.is-visible")).not.toBeNull();
    return { selector, source };
  }

  it.each(gestures)("finishes a $band grip drag after a $origin edit above the table", async ({ band, origin }) => {
    const { editor, collaborator } = await setup();
    const before = tableTextGrid(editor);
    const { selector, source } = startGripDrag(editor, band);

    editAbove(origin === "synced" ? collaborator : editor);
    expect(editor.state.doc.firstChild?.textContent).toBe("New text Intro");
    expect(source.getAttribute("aria-grabbed")).toBe("true");
    elementFromPointResult = editor.view.dom.querySelectorAll(selector)[2]!;
    dispatchPointer(editor.view.dom, "pointerup", { clientX: 10, clientY: 10 });

    expect(errors).toEqual([]);
    const moved = band === "row"
      ? [before[1]!, before[2]!, before[0]!]
      : before.map((row) => [row[1]!, row[2]!, row[0]!]);
    expect(tableTextGrid(editor)).toEqual(moved);
    expect(tableTextGrid(collaborator)).toEqual(moved);
    expect(source.getAttribute("aria-grabbed")).toBe("false");
  });

  it.each(gestures)("cancels a $band grip drag after a $origin edit in its table", async ({ band, origin }) => {
    const { editor, collaborator } = await setup();
    const { selector, source } = startGripDrag(editor, band);

    editCell(origin === "synced" ? collaborator : editor, "C3");
    const before = tableTextGrid(editor);
    expect(before[2]![2]).toBe("xC3");
    expectNoDragChrome(editor);
    elementFromPointResult = editor.view.dom.querySelectorAll(selector)[2]!;
    dispatchPointer(editor.view.dom, "pointerup", { clientX: 10, clientY: 10 });

    expect(errors).toEqual([]);
    expect(tableTextGrid(editor)).toEqual(before);
    expect(tableTextGrid(collaborator)).toEqual(before);
    expect(source.getAttribute("aria-grabbed")).toBe("false");
    expectNoDragChrome(editor);

    // The grip stays in place through the edit, so a new drag from it works.
    drag(source, editor.view.dom.querySelectorAll(selector)[2]!);
    const moved = band === "row"
      ? [before[1]!, before[2]!, before[0]!]
      : before.map((row) => [row[1]!, row[2]!, row[0]!]);
    expect(tableTextGrid(editor)).toEqual(moved);
    expect(tableTextGrid(collaborator)).toEqual(moved);
  });

  function mouse(target: EventTarget, type: string, clientX: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 20, button: 0, buttons: 1 });
    Object.defineProperty(event, "which", { value: 1 });
    target.dispatchEvent(event);
  }

  function startColumnResize(editor: Editor) {
    const cell = editor.view.dom.querySelectorAll("th")[1] as HTMLTableCellElement;
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 100, 40));
    Object.defineProperty(cell, "offsetWidth", { configurable: true, value: 100 });
    elementFromPointResult = cell;
    mouse(cell, "mousemove", 199);
    const handle = columnResizingPluginKey.getState(editor.state)!.activeHandle;
    expect(editor.state.doc.nodeAt(handle)?.textContent).toBe("A2");
    mouse(cell, "mousedown", 199);
    expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeTruthy();
    mouse(window, "mousemove", 239);
    expect(editor.view.dom.querySelectorAll("col")[1]?.style.width).toBe("140px");
    return handle;
  }

  function widths(editor: Editor) {
    return tableNode(editor).content?.map((row) => row.content?.map((cell) => cell.attrs?.colwidth ?? null));
  }

  it("cancels a column width resize after a synced edit in its table", async () => {
    const { editor, collaborator } = await setup();
    const table = editor.view.dom.querySelector("table")!;
    const beforeSize = [table.style.width, table.style.minWidth];
    startColumnResize(editor);

    editCell(collaborator, "C3");
    const before = tableNode(editor);
    expect(tableTextGrid(editor)[2]![2]).toBe("xC3");
    mouse(window, "mousemove", 259);
    mouse(window, "mouseup", 259);

    expect(errors).toEqual([]);
    expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeFalsy();
    expect(tableNode(editor)).toEqual(before);
    expect(tableNode(collaborator)).toEqual(before);
    expect(Array.from(editor.view.dom.querySelectorAll("col"), (col) => col.style.width)).toEqual(["", "", ""]);
    const currentTable = editor.view.dom.querySelector("table")!;
    expect([currentTable.style.width, currentTable.style.minWidth]).toEqual(beforeSize);
    expect(editor.view.dom.querySelector(".column-resize-dragging, .column-resize-handle")).toBeNull();
  });

  it.each(["synced"])("finishes a column width resize on the same column after a %s edit above the table", async (origin) => {
    const { editor, collaborator } = await setup();
    const before = tableTextGrid(editor);
    const handle = startColumnResize(editor);

    editAbove(origin === "synced" ? collaborator : editor);
    expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(handle + "New text ".length);
    expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeTruthy();
    mouse(window, "mousemove", 259);
    mouse(window, "mouseup", 259);

    expect(errors).toEqual([]);
    expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeFalsy();
    expect(widths(editor)).toEqual(Array.from({ length: 3 }, () => [null, [160], null]));
    expect(widths(collaborator)).toEqual(widths(editor));
    expect(tableTextGrid(editor)).toEqual(before);
  });

  function startRowResize(editor: Editor) {
    const row = editor.view.dom.querySelector("tr")!;
    const handle = editor.view.dom.querySelector(".dohc-table-row-resize")!;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 40));
    dispatchPointer(handle, "pointerdown", { clientY: 100 });
    dispatchPointer(handle, "pointermove", { clientY: 134 });
    expect(row.style.height).toBe("74px");
    return { row, handle };
  }

  it("cancels a row height resize after a synced edit in its table", async () => {
    const { editor, collaborator } = await setup();
    const { row, handle } = startRowResize(editor);

    editCell(collaborator, "C3");
    const before = tableNode(editor);
    dispatchPointer(editor.view.dom, "pointermove", { clientY: 150 });
    dispatchPointer(editor.view.dom, "pointerup", { clientY: 150 });

    expect(errors).toEqual([]);
    expect(tableNode(editor)).toEqual(before);
    expect(tableNode(collaborator)).toEqual(before);
    expect(row.style.height).toBe("");
    expect(handle.classList.contains("is-resizing")).toBe(false);
    expect(editor.view.dom.querySelector(".is-resizing, [aria-grabbed='true']")).toBeNull();
    expect(document.body.querySelector("[data-dohc-table-drag-status]")?.textContent)
      .toBe("Row 1 resize cancelled.");
  });
});

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

  // A click in an embedded frame, such as an app preview, blurs the window
  // with focus already in the frame. The grip must not pull it back out.

  // jsdom has no layout: a 100px list over 28px rows.

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

  // Text before a table moves every position in it. The controls keep their
  // elements through that, so each one must find its position when it's used.
  describe("after the table's positions move", () => {
    let peer: Editor | undefined;

    afterEach(() => {
      peer?.destroy();
      peer = undefined;
    });

    function control(target: Editor, selector: string, index = 0): HTMLElement {
      const element = target.view.dom.querySelectorAll(selector)[index];
      if (!(element instanceof HTMLElement)) throw new Error(`${selector} ${index} missing`);
      return element;
    }

    function rowHeights(target: Editor): (number | null)[] {
      return (tableNode(target).content ?? []).map((row) => row.attrs?.height ?? null);
    }

    const labeledGrid = [
      ["A1", "A2", "A3"],
      ["B1", "B2", "B3"],
      ["C1", "C2", "C3"],
    ];

    it("acts on its own row and column after undoing and redoing a column and a row add", () => {
      editor = createLabeledTableEditor("Intro");
      click(control(editor, ".dohc-table-grip--col", 0));
      click(menuItemByLabel("Insert column left"));
      editor.view.dispatch(closeHistory(editor.state.tr));
      click(control(editor, ".dohc-table-append--row"));
      expect(tableTextGrid(editor)).toHaveLength(4);

      editor.commands.undo();
      editor.commands.undo();
      expect(tableTextGrid(editor)).toEqual(labeledGrid);
      editor.commands.redo();
      expect(tableTextGrid(editor)[0]).toEqual(["", "A1", "A2", "A3"]);

      click(control(editor, ".dohc-table-grip--col", 2));
      click(menuItemByLabel("Align right"));
      expect(columnAligns(editor, 1)).toEqual([null, null, null]);
      expect(columnAligns(editor, 2)).toEqual(["right", "right", "right"]);

      click(control(editor, ".dohc-table-grip--row", 2));
      click(menuItemByLabel("Delete row"));
      expect(tableTextGrid(editor).map((row) => row[1])).toEqual(["A1", "B1"]);
    });

    it("adds, resizes and moves the right row and column after a collaborator's edit arrives through sync", async () => {
      ({ local: editor, peer } = await createSyncedEditors());
      const typeOnPeer = () => peer!.view.dispatch(peer!.state.tr.insertText("Synced ", 1));

      typeOnPeer();
      click(control(editor, ".dohc-table-append--col"));
      expect(tableTextGrid(editor)).toEqual([
        ["A1", "A2", "A3", ""],
        ["B1", "B2", "B3", ""],
        ["C1", "C2", "C3", ""],
      ]);
      typeOnPeer();
      click(control(editor, ".dohc-table-append--row"));
      expect(tableTextGrid(editor)).toEqual([
        ["A1", "A2", "A3", ""],
        ["B1", "B2", "B3", ""],
        ["C1", "C2", "C3", ""],
        ["", "", "", ""],
      ]);

      typeOnPeer();
      control(editor, ".dohc-table-row-resize", 2).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      expect(rowHeights(editor)).toEqual([null, null, 38, null]);

      typeOnPeer();
      const rowGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--row");
      drag(rowGrips[0] as HTMLElement, rowGrips[2] as HTMLElement);
      expect(tableTextGrid(editor)).toEqual([
        ["B1", "B2", "B3", ""],
        ["C1", "C2", "C3", ""],
        ["A1", "A2", "A3", ""],
        ["", "", "", ""],
      ]);
      expect(rowHeights(editor)).toEqual([null, 38, null, null]);
      typeOnPeer();
      const columnGrips = editor.view.dom.querySelectorAll(".dohc-table-grip--col");
      drag(columnGrips[0] as HTMLElement, columnGrips[2] as HTMLElement);
      expect(tableTextGrid(editor)).toEqual([
        ["B2", "B3", "B1", ""],
        ["C2", "C3", "C1", ""],
        ["A2", "A3", "A1", ""],
        ["", "", "", ""],
      ]);
      expect(rowHeights(editor)).toEqual([null, 38, null, null]);
      expect(tableTextGrid(peer)).toEqual(tableTextGrid(editor));
    });

  });
});
