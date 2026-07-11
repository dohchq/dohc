// Table row/column/header controls — grips + menus layered on TableKit's
// existing commands (addRowBefore/After, deleteRow, addColumnBefore/After,
// deleteColumn, toggleHeaderRow, deleteTable). TableKit ships every command
// already; this file is only the missing UI.
//
// GFM round-trip caveat (see AGENTS.md "text is the primitive"): markdown
// tables cannot express merged cells or per-cell alignment, so there is
// deliberately no merge/split/align UI here — only what survives a
// markdown round-trip.
//
// Grip placement: each grip is a ProseMirror decoration WIDGET nested
// *inside* the relevant cell (first-row cell for a column grip,
// first-cell-of-row for a row grip) rather than a JS-measured floating
// overlay. That choice matters during a live column-resize drag:
// prosemirror-tables mutates cell/col widths directly on the DOM
// (`displayColumnWidth`, see prosemirror-tables' columnresizing.ts) without
// dispatching a transaction until mouseup — the same trick it uses to
// render its own `.column-resize-handle` widget nested inside the cell. A
// widget that is a DOM descendant of the cell inherits the live-resized box
// for free through ordinary CSS layout (`position: absolute` against the
// cell's `position: relative`); a JS-measured overlay driven off
// `docChanged`/ResizeObserver would visibly lag until the drag finishes.
// This mirrors the block gutter (`blockControls` inline in
// MarkdownEditor.tsx): a widget nested one position inside the target node,
// hover-revealed via a `Decoration.node` class on an ancestor.

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

function columnMenuItems(): GripMenuItem[] {
  return [
    { label: "Insert column left", run: (view) => runTableCommand(view, addColumnBefore) },
    { label: "Insert column right", run: (view) => runTableCommand(view, addColumnAfter) },
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
    openGripMenu(view, button, columnMenuItems());
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

    // Table menu affordance: anchored inside the top-right cell.
    const topRightCellPos = tableStart + map.map[map.width - 1];
    decorations.push(
      widgetDecoration(
        topRightCellPos + 1,
        (view) => buildTableMenuButton(view, topRightCellPos),
        `dohc-table-menu-${pos}`,
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
