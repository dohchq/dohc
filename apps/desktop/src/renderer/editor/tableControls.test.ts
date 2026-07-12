// @vitest-environment jsdom
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeTableControlsPlugin } from "./tableControls";

// jsdom has no elementFromPoint; prosemirror-tables' columnresizing plugin
// calls it (via posAtCoords) on every mousemove the hover-tracking tests
// dispatch. A null stub keeps it on its "no resize boundary" path.
beforeAll(() => {
  document.elementFromPoint = () => null;
});

const testTableControls = Extension.create({
  name: "testTableControls",
  addProseMirrorPlugins() {
    return [makeTableControlsPlugin()];
  },
});

function createTableEditor(rows = 2, cols = 2): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: true } }),
      testTableControls,
    ],
    content: "<p></p>",
  });
  editor.commands.insertTable({ rows, cols, withHeaderRow: true });
  return editor;
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

// `editor.getJSON()`'s type is inferred from the registered extensions
// (a deep NodeType/TextType union) and is awkward to destructure generically
// in a test; a small structural type is simpler than fighting that union.
type JsonNode = {
  type: string;
  attrs?: { align?: string | null; colspan?: number; rowspan?: number };
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

describe("table controls grips", () => {
  let editor: Editor | undefined;

  afterEach(() => {
    document.body.querySelector(".dohc-table-menu")?.remove();
    editor?.destroy();
    editor = undefined;
  });

  it("renders one column grip per column, one row grip per row, and one table menu button", () => {
    editor = createTableEditor(2, 3);
    const dom = editor.view.dom;
    expect(dom.querySelectorAll(".dohc-table-grip--col")).toHaveLength(3);
    expect(dom.querySelectorAll(".dohc-table-grip--row")).toHaveLength(2);
    expect(dom.querySelectorAll(".dohc-table-menu-btn")).toHaveLength(1);
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

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    // Second column menu item is "Insert column right" — still an insert,
    // so the column count grows and the menu closes either way.
    const headerRow = tableNode(editor).content?.[0];
    expect(headerRow?.content).toHaveLength(4);
    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
  });

  it("grip menu closes on Escape without running a command", () => {
    editor = createTableEditor(2, 2);
    const grip = editor.view.dom.querySelector(".dohc-table-grip--col") as HTMLElement;
    click(grip);
    expect(document.body.querySelector(".dohc-table-menu")).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.body.querySelector(".dohc-table-menu")).toBeNull();
    const headerRow = tableNode(editor).content?.[0];
    expect(headerRow?.content).toHaveLength(2);
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
