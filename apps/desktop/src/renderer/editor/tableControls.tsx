// Table row/column/header controls — grips + menus layered on TableKit's
// existing commands (addRowBefore/After, deleteRow, addColumnBefore/After,
// deleteColumn, toggleHeaderRow, deleteTable). TableKit ships every command
// already; this file is only the missing UI.
//
// GFM round-trip caveat (see AGENTS.md "text is the primitive"): markdown
// tables express per-COLUMN alignment via the delimiter row (`:---`, `:---:`,
// `---:`) but NOT merged cells. So there is per-column alignment UI (the
// column grip menu's Align left/center/right, applied to every cell in the
// column) but deliberately no merge/split UI — only what survives a markdown
// round-trip. Alignment lives on the standard `align` cell attr that
// @tiptap/extension-table already serializes to / parses from the GFM
// delimiter row, so the round-trip is lossless with no custom serializer.
//
// Grip placement: each grip is a ProseMirror decoration WIDGET nested
// *inside* the relevant cell (first-row cell for a column grip,
// first-cell-of-row for a row grip) but rendered in the table's OUTER margin
// via negative CSS offsets (a column grip floats above its column, a row grip
// floats left of its row — Notion-style), so grip chrome never overlaps or
// reflows cell text. Nesting the widget inside the cell (rather than a
// JS-measured floating overlay) is what keeps each grip glued to its
// column/row during a live column-resize drag: prosemirror-tables mutates
// cell/col widths directly on the DOM (see prosemirror-tables'
// columnresizing.ts) without dispatching a transaction until mouseup — the
// same trick it uses to render its own `.column-resize-handle` widget nested
// inside the cell. A widget that is a DOM descendant of the cell inherits the
// live-resized box for free through ordinary CSS layout (`position: absolute`
// against the cell's `position: relative`; the negative top/left offsets only
// shift the grip into the margin — the edge it hugs still tracks the cell);
// a JS-measured overlay driven off `docChanged`/ResizeObserver would visibly
// lag until the drag finishes. This mirrors the block gutter (`blockControls`
// inline in MarkdownEditor.tsx): a widget nested one position inside the
// target node, hover-revealed via a `Decoration.node` class on an ancestor.

import { Node as PMNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  TableMap,
  toggleHeaderRow,
} from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";

export const tableControlsKey = new PluginKey("dohc-table-controls");

type TableCommand = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
) => boolean;

type GripMenuItem = {
  label: string;
  destructive?: boolean;
  run: (view: EditorView) => void;
};

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function runTableCommand(view: EditorView, command: TableCommand): void {
  if (view.editable === false) return;
  command(view.state, view.dispatch);
  view.focus();
}

function selectColumn(view: EditorView, cellPos: number): void {
  if (view.editable === false) return;
  const $cell = view.state.doc.resolve(cellPos);
  view.dispatch(view.state.tr.setSelection(CellSelection.colSelection($cell)));
}

function selectRow(view: EditorView, cellPos: number): void {
  if (view.editable === false) return;
  const $cell = view.state.doc.resolve(cellPos);
  view.dispatch(view.state.tr.setSelection(CellSelection.rowSelection($cell)));
}

function focusCell(view: EditorView, cellPos: number): void {
  if (view.editable === false) return;
  const $pos = view.state.doc.resolve(cellPos + 1);
  view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
}

// Per-column GFM alignment. The value is written to the standard `align`
// cell attr (TableKit's tableCell/tableHeader) on EVERY cell in the column,
// which @tiptap/extension-table serializes to the delimiter row (`:---`,
// `:---:`, `---:`) and parses back losslessly — so this survives the markdown
// round-trip with no custom serializer. Setting it on the whole column keeps
// the delimiter deterministic and the on-screen CSS `text-align` consistent
// across the column. Driven off a fresh colSelection rather than the current
// selection, so it works no matter what is selected when the menu item runs.
type CellAlign = "left" | "center" | "right";

function setColumnAlign(view: EditorView, cellPos: number, align: CellAlign): void {
  if (view.editable === false) return;
  const { state } = view;
  const $cell = state.doc.resolve(cellPos);
  const selection = CellSelection.colSelection($cell);
  let tr = state.tr;
  selection.forEachCell((cell, pos) => {
    tr = tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
  });
  if (tr.docChanged) view.dispatch(tr);
  view.focus();
}

function appendColumn(view: EditorView, lastColCellPos: number): void {
  if (view.editable === false) return;
  const $cell = view.state.doc.resolve(lastColCellPos);
  view.dispatch(view.state.tr.setSelection(CellSelection.colSelection($cell)));
  addColumnAfter(view.state, view.dispatch);
  view.focus();
}

function appendRow(view: EditorView, lastRowCellPos: number): void {
  if (view.editable === false) return;
  const $cell = view.state.doc.resolve(lastRowCellPos);
  view.dispatch(view.state.tr.setSelection(CellSelection.rowSelection($cell)));
  addRowAfter(view.state, view.dispatch);
  view.focus();
}

function columnMenuItems(cellPos: number): GripMenuItem[] {
  return [
    { label: "Insert column left", run: (view) => runTableCommand(view, addColumnBefore) },
    { label: "Insert column right", run: (view) => runTableCommand(view, addColumnAfter) },
    { label: "Align left", run: (view) => setColumnAlign(view, cellPos, "left") },
    { label: "Align center", run: (view) => setColumnAlign(view, cellPos, "center") },
    { label: "Align right", run: (view) => setColumnAlign(view, cellPos, "right") },
    {
      label: "Delete column",
      destructive: true,
      run: (view) => runTableCommand(view, deleteColumn),
    },
  ];
}

function rowMenuItems(): GripMenuItem[] {
  return [
    { label: "Insert row above", run: (view) => runTableCommand(view, addRowBefore) },
    { label: "Insert row below", run: (view) => runTableCommand(view, addRowAfter) },
    { label: "Delete row", destructive: true, run: (view) => runTableCommand(view, deleteRow) },
  ];
}

function tableMenuItems(): GripMenuItem[] {
  return [
    { label: "Toggle header row", run: (view) => runTableCommand(view, toggleHeaderRow) },
    { label: "Delete table", destructive: true, run: (view) => runTableCommand(view, deleteTable) },
  ];
}

// A single vanilla-DOM popover, module-scoped since only one grip menu can
// be open at a time. Visuals mirror `.dohc-slash-menu` (`.dohc-table-menu`
// in styles.css); keyboard model (arrows/Enter/Escape) mirrors
// SlashCommandMenu's handleKeyDown in MarkdownEditor.tsx.
let closeOpenMenu: (() => void) | null = null;

function openGripMenu(view: EditorView, anchor: HTMLElement, items: GripMenuItem[]): void {
  closeOpenMenu?.();
  closeOpenMenu = null;
  if (view.editable === false || items.length === 0) return;

  const rect = anchor.getBoundingClientRect();
  const position = resolveFloatingMenuPosition({
    cursorRect: { left: rect.left, top: rect.top, bottom: rect.bottom },
    menuWidth: 190,
    menuMaxHeight: 200,
  });

  const menu = document.createElement("div");
  menu.className = "dohc-table-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "table controls");
  menu.style.left = `${position.x}px`;
  menu.style.top = `${position.y}px`;
  menu.style.maxHeight = `${position.maxHeight}px`;

  let selected = 0;
  const buttons: HTMLButtonElement[] = [];
  const highlight = () => {
    buttons.forEach((button, index) => {
      button.classList.toggle("is-selected", index === selected);
    });
  };

  const runItem = (index: number) => {
    const item = items[index];
    close();
    item?.run(view);
  };

  items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.className = `dohc-table-menu__item${item.destructive ? " dohc-table-menu__item--danger" : ""}`;
    button.textContent = item.label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("mouseenter", () => {
      selected = index;
      highlight();
    });
    button.addEventListener("click", (event) => {
      stopEvent(event);
      runItem(index);
    });
    buttons.push(button);
    menu.appendChild(button);
  });
  highlight();

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selected = (selected + 1) % items.length;
      highlight();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selected = (selected - 1 + items.length) % items.length;
      highlight();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      view.focus();
    }
  }

  function onPointerDown(event: MouseEvent): void {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  }

  function close(): void {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("mousedown", onPointerDown, true);
    menu.remove();
    if (closeOpenMenu === close) closeOpenMenu = null;
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("mousedown", onPointerDown, true);
  document.body.appendChild(menu);
  closeOpenMenu = close;
}

function buildColumnGrip(view: EditorView, cellPos: number, colIndex: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-grip dohc-table-grip--col";
  button.title = `Column ${colIndex + 1}`;
  button.setAttribute("aria-label", `Select column ${colIndex + 1}`);
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  button.addEventListener("mousedown", stopEvent);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    selectColumn(view, cellPos);
    openGripMenu(view, button, columnMenuItems(cellPos));
  });
  return button;
}

function buildRowGrip(view: EditorView, cellPos: number, rowIndex: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-grip dohc-table-grip--row";
  button.title = `Row ${rowIndex + 1}`;
  button.setAttribute("aria-label", `Select row ${rowIndex + 1}`);
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  button.addEventListener("mousedown", stopEvent);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    selectRow(view, cellPos);
    openGripMenu(view, button, rowMenuItems());
  });
  return button;
}

function buildTableMenuButton(view: EditorView, cellPos: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-menu-btn";
  button.title = "Table options";
  button.setAttribute("aria-label", "Table options");
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  button.addEventListener("mousedown", stopEvent);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    focusCell(view, cellPos);
    openGripMenu(view, button, tableMenuItems());
  });
  return button;
}

// Notion-style append affordances: a "+" hugging the table's right edge
// (append column) and one hugging the bottom edge (append row). Each is
// anchored inside a corner cell (top-right for the column, bottom-left for
// the row) so it tracks the live-resized table box the same way the grips
// do, and floats into the outer margin via negative CSS offsets.
function buildAppendColumnButton(view: EditorView, lastColCellPos: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-append dohc-table-append--col";
  button.title = "Add column";
  button.setAttribute("aria-label", "Add column");
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  button.addEventListener("mousedown", stopEvent);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    appendColumn(view, lastColCellPos);
  });
  return button;
}

function buildAppendRowButton(view: EditorView, lastRowCellPos: number): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-append dohc-table-append--row";
  button.title = "Add row";
  button.setAttribute("aria-label", "Add row");
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  button.addEventListener("mousedown", stopEvent);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    appendRow(view, lastRowCellPos);
  });
  return button;
}

function isTableNode(node: { type: { name: string } }): boolean {
  return node.type.name === "table";
}

function widgetDecoration(
  pos: number,
  toDOM: (view: EditorView) => HTMLElement,
  key: string,
): Decoration {
  return Decoration.widget(pos, toDOM, {
    side: -1,
    key,
    ignoreSelection: true,
    stopEvent: () => true,
  });
}

function buildTableControlDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!isTableNode(node)) return;

    const map = TableMap.get(node);
    const tableStart = pos + 1;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, { class: "dohc-table-node" }),
    );

    // Column grips: one per column, anchored inside that column's row-0
    // cell. Dedup guards against pasted-in colspan cells (the editor never
    // creates spans itself — no merge UI — but pasted HTML tables can).
    let lastColCellPos = -1;
    for (let col = 0; col < map.width; col += 1) {
      const cellPos = tableStart + map.map[col];
      if (cellPos === lastColCellPos) continue;
      lastColCellPos = cellPos;
      const colIndex = col;
      decorations.push(
        widgetDecoration(
          cellPos + 1,
          (view) => buildColumnGrip(view, cellPos, colIndex),
          `dohc-table-col-${cellPos}`,
        ),
      );
    }

    // Table menu affordance: anchored inside the top-left cell (the
    // spreadsheet "select-all corner"), floated into the top-left margin.
    const topLeftCellPos = tableStart + map.map[0];
    decorations.push(
      widgetDecoration(
        topLeftCellPos + 1,
        (view) => buildTableMenuButton(view, topLeftCellPos),
        `dohc-table-menu-${pos}`,
      ),
    );

    // Append-column "+": anchored inside the top-right cell, hugging the
    // table's right edge.
    const topRightCellPos = tableStart + map.map[map.width - 1];
    decorations.push(
      widgetDecoration(
        topRightCellPos + 1,
        (view) => buildAppendColumnButton(view, topRightCellPos),
        `dohc-table-append-col-${pos}`,
      ),
    );

    // Row grips: one per row, anchored inside that row's col-0 cell.
    let lastRowCellPos = -1;
    for (let row = 0; row < map.height; row += 1) {
      const cellPos = tableStart + map.map[row * map.width];
      if (cellPos === lastRowCellPos) continue;
      lastRowCellPos = cellPos;
      const rowIndex = row;
      decorations.push(
        widgetDecoration(
          cellPos + 1,
          (view) => buildRowGrip(view, cellPos, rowIndex),
          `dohc-table-row-${cellPos}`,
        ),
      );
    }

    // Append-row "+": anchored inside the bottom-left cell, hugging the
    // table's bottom edge.
    const bottomLeftCellPos = tableStart + map.map[(map.height - 1) * map.width];
    decorations.push(
      widgetDecoration(
        bottomLeftCellPos + 1,
        (view) => buildAppendRowButton(view, bottomLeftCellPos),
        `dohc-table-append-row-${pos}`,
      ),
    );

    return false;
  });

  return DecorationSet.create(doc, decorations);
}

export function makeTableControlsPlugin(): Plugin {
  return new Plugin({
    key: tableControlsKey,
    state: {
      init(_, instance) {
        return buildTableControlDecorations(instance.doc);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildTableControlDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return tableControlsKey.getState(state) as DecorationSet | undefined;
      },
    },
    view() {
      return {
        destroy() {
          closeOpenMenu?.();
          closeOpenMenu = null;
        },
      };
    },
  });
}
