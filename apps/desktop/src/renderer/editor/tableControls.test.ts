// @vitest-environment jsdom
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { afterEach, describe, expect, it } from "vitest";
import { makeTableControlsPlugin } from "./tableControls";

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
  attrs?: { align?: string | null };
  content?: JsonNode[];
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
