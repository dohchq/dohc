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
  moveTableColumn,
  moveTableRow,
  TableMap,
  toggleHeaderRow,
} from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const tableControlsKey = new PluginKey("dohc-table-controls");

type TableCommand = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
) => boolean;

type GripMenuItem = {
  label: string;
  destructive?: boolean;
  separatorBefore?: boolean;
  run: (view: EditorView) => void;
};

type TableBand = "column" | "row";
type TableMenuPlacement = TableBand | "table";

type TableDragState = {
  band: TableBand;
  index: number;
  tablePos: number;
  cellPos: number;
};

let activeTableDrag: TableDragState | null = null;

type RectLike = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

export function resolveTableMenuPosition({
  anchorRect,
  placement,
  viewportWidth,
  viewportHeight,
  menuWidth = 220,
  menuHeight,
  margin = 8,
  gap = 8,
}: {
  anchorRect: RectLike;
  placement: TableMenuPlacement;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight: number;
  margin?: number;
  gap?: number;
}): { x: number; y: number } {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

  if (placement === "row") {
    const right = anchorRect.right + gap;
    const left = anchorRect.left - menuWidth - gap;
    const x = right + menuWidth <= viewportWidth - margin ? right : left;
    return {
      x: clamp(x, margin, viewportWidth - menuWidth - margin),
      y: clamp(
        anchorRect.top + anchorRect.height / 2 - menuHeight / 2,
        margin,
        viewportHeight - menuHeight - margin,
      ),
    };
  }

  const below = anchorRect.bottom + gap;
  const above = anchorRect.top - menuHeight - gap;
  return {
    x: clamp(
      anchorRect.left + anchorRect.width / 2 - menuWidth / 2,
      margin,
      viewportWidth - menuWidth - margin,
    ),
    y: clamp(
      below + menuHeight <= viewportHeight - margin ? below : above,
      margin,
      viewportHeight - menuHeight - margin,
    ),
  };
}

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}

function runTableCommand(view: EditorView, command: TableCommand): void {
  if (view.editable === false) return;
  command(view.state, view.dispatch);
  view.focus();
}

function deleteSelectedTableBand(view: EditorView): boolean {
  if (view.editable === false) return false;
  const { selection } = view.state;
  if (!(selection instanceof CellSelection)) return false;

  const command = selection.isRowSelection()
    ? deleteRow
    : selection.isColSelection()
      ? deleteColumn
      : null;
  if (!command || !command(view.state, view.dispatch)) return false;

  view.focus();
  return true;
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
    {
      label: "Align left",
      separatorBefore: true,
      run: (view) => setColumnAlign(view, cellPos, "left"),
    },
    { label: "Align center", run: (view) => setColumnAlign(view, cellPos, "center") },
    { label: "Align right", run: (view) => setColumnAlign(view, cellPos, "right") },
    {
      label: "Delete column",
      destructive: true,
      separatorBefore: true,
      run: (view) => runTableCommand(view, deleteColumn),
    },
  ];
}

function rowMenuItems(): GripMenuItem[] {
  return [
    { label: "Insert row above", run: (view) => runTableCommand(view, addRowBefore) },
    { label: "Insert row below", run: (view) => runTableCommand(view, addRowAfter) },
    {
      label: "Delete row",
      destructive: true,
      separatorBefore: true,
      run: (view) => runTableCommand(view, deleteRow),
    },
  ];
}

function tableMenuItems(): GripMenuItem[] {
  return [
    { label: "Toggle header row", run: (view) => runTableCommand(view, toggleHeaderRow) },
    {
      label: "Delete table",
      destructive: true,
      separatorBefore: true,
      run: (view) => runTableCommand(view, deleteTable),
    },
  ];
}

// A single vanilla-DOM popover, module-scoped since only one grip menu can
// be open at a time. Visuals mirror `.dohc-slash-menu` (`.dohc-table-menu`
// in styles.css); keyboard model (arrows/Enter/Escape) mirrors
// SlashCommandMenu's handleKeyDown in MarkdownEditor.tsx.
let closeOpenMenu: (() => void) | null = null;

function openGripMenu(
  view: EditorView,
  anchor: HTMLElement,
  items: GripMenuItem[],
  placement: TableMenuPlacement,
): void {
  closeOpenMenu?.();
  closeOpenMenu = null;
  if (view.editable === false || items.length === 0) return;

  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const editorRoot = view.dom.getRootNode();
  const menuHost =
    editorRoot instanceof ownerWindow.ShadowRoot ? editorRoot : ownerDocument.body;
  const menu = ownerDocument.createElement("div");
  menu.className = "dohc-table-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "table controls");
  const menuMaxHeight = Math.max(80, Math.min(280, ownerWindow.innerHeight - 16));
  menu.style.maxHeight = `${menuMaxHeight}px`;
  menu.style.visibility = "hidden";
  menu.style.animation = "none";

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
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.className = `dohc-table-menu__item${item.destructive ? " dohc-table-menu__item--danger" : ""}`;
    if (item.separatorBefore) button.classList.add("dohc-table-menu__item--separated");
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
    } else if (event.key === "Backspace" || event.key === "Delete") {
      const deleteIndex = items.findIndex((item) => item.destructive);
      if (deleteIndex >= 0) {
        event.preventDefault();
        runItem(deleteIndex);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      view.focus();
    }
  }

  function onPointerDown(event: MouseEvent): void {
    if (event.target instanceof ownerWindow.Node && menu.contains(event.target)) return;
    close();
  }

  function reposition(): void {
    const anchorRect = anchor.getBoundingClientRect();
    const measured = menu.getBoundingClientRect();
    // jsdom has no layout and returns zero. The estimate also prevents a
    // one-frame jump in a very slow renderer before the first measurement.
    const menuHeight = Math.min(
      menuMaxHeight,
      measured.height || items.length * 35 + 10,
    );
    const position = resolveTableMenuPosition({
      anchorRect,
      placement,
      viewportWidth: ownerWindow.innerWidth,
      viewportHeight: ownerWindow.innerHeight,
      menuHeight,
    });
    menu.style.left = `${position.x}px`;
    menu.style.top = `${position.y}px`;
  }

  function close(): void {
    ownerWindow.removeEventListener("keydown", onKeyDown, true);
    ownerWindow.removeEventListener("mousedown", onPointerDown, true);
    ownerWindow.removeEventListener("resize", reposition);
    ownerWindow.removeEventListener("scroll", reposition, true);
    anchor.classList.remove("is-open");
    anchor.setAttribute("aria-expanded", "false");
    menu.remove();
    if (closeOpenMenu === close) closeOpenMenu = null;
  }

  ownerWindow.addEventListener("keydown", onKeyDown, true);
  ownerWindow.addEventListener("mousedown", onPointerDown, true);
  ownerWindow.addEventListener("resize", reposition);
  ownerWindow.addEventListener("scroll", reposition, true);
  anchor.classList.add("is-open");
  anchor.setAttribute("aria-expanded", "true");
  menuHost.appendChild(menu);
  reposition();
  menu.style.removeProperty("visibility");
  menu.style.removeProperty("animation");
  closeOpenMenu = close;
}

function clearTableDropTargetChrome(view: EditorView): void {
  view.dom
    .querySelectorAll<HTMLElement>(
      ".dohc-table-grip.is-drop-target, .dohc-table-drag-target",
    )
    .forEach((element) =>
      element.classList.remove("is-drop-target", "dohc-table-drag-target"),
    );
}

function clearTableDragChrome(view: EditorView): void {
  clearTableDropTargetChrome(view);
  view.dom
    .querySelectorAll<HTMLElement>(
      ".dohc-table-grip.is-dragging, .dohc-table-drag-source, table.is-reordering",
    )
    .forEach((element) =>
      element.classList.remove(
        "is-dragging",
        "dohc-table-drag-source",
        "is-reordering",
      ),
    );
}

function markTableBand(
  button: HTMLButtonElement,
  band: TableBand,
  index: number,
  className: string,
): void {
  const table = button.closest("table");
  if (!table) return;
  if (band === "row") {
    button.closest("tr")?.classList.add(className);
    return;
  }
  Array.from(table.rows).forEach((row) => row.cells[index]?.classList.add(className));
}

function setTableDragPreview(
  view: EditorView,
  event: DragEvent,
  band: TableBand,
  index: number,
): void {
  if (!event.dataTransfer?.setDragImage) return;
  const ownerDocument = view.dom.ownerDocument;
  const preview = ownerDocument.createElement("div");
  preview.className = "dohc-table-drag-preview";
  preview.textContent = `Move ${band} ${index + 1}`;
  ownerDocument.body.appendChild(preview);
  event.dataTransfer.setDragImage(preview, 14, 14);
  (ownerDocument.defaultView ?? window).setTimeout(() => preview.remove(), 0);
}

function configureGripDrag(
  view: EditorView,
  button: HTMLButtonElement,
  band: TableBand,
  index: number,
  tablePos: number,
  cellPos: number,
): void {
  button.draggable = view.editable !== false;

  button.addEventListener("dragstart", (event) => {
    if (view.editable === false || !event.dataTransfer) {
      event.preventDefault();
      return;
    }

    closeOpenMenu?.();
    closeOpenMenu = null;
    activeTableDrag = { band, index, tablePos, cellPos };
    if (band === "column") selectColumn(view, cellPos);
    else selectRow(view, cellPos);

    button.closest("table")?.classList.add("is-reordering");
    button.classList.add("is-dragging");
    markTableBand(button, band, index, "dohc-table-drag-source");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `dohc-table-${band}-${index}`);
    setTableDragPreview(view, event, band, index);
  });

  button.addEventListener("dragover", (event) => {
    if (
      !activeTableDrag ||
      activeTableDrag.band !== band ||
      activeTableDrag.tablePos !== tablePos ||
      activeTableDrag.index === index
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    clearTableDropTargetChrome(view);
    button.classList.add("is-drop-target");
    markTableBand(button, band, index, "dohc-table-drag-target");
  });

  button.addEventListener("dragleave", () => {
    button.classList.remove("is-drop-target");
    view.dom
      .querySelectorAll<HTMLElement>(".dohc-table-drag-target")
      .forEach((element) => element.classList.remove("dohc-table-drag-target"));
  });

  button.addEventListener("drop", (event) => {
    const drag = activeTableDrag;
    if (
      !drag ||
      drag.band !== band ||
      drag.tablePos !== tablePos ||
      drag.index === index
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const command =
      band === "column"
        ? moveTableColumn({ from: drag.index, to: index, pos: drag.cellPos })
        : moveTableRow({ from: drag.index, to: index, pos: drag.cellPos });
    runTableCommand(view, command);
    activeTableDrag = null;
    clearTableDragChrome(view);
  });

  button.addEventListener("dragend", () => {
    activeTableDrag = null;
    clearTableDragChrome(view);
  });
}

function buildColumnGrip(
  view: EditorView,
  cellPos: number,
  colIndex: number,
  tablePos: number,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-grip dohc-table-grip--col";
  button.title = `Column ${colIndex + 1} — drag to reorder, click for options`;
  button.setAttribute("aria-label", `Select column ${colIndex + 1}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-table-column", String(colIndex));
  button.setAttribute("contenteditable", "false");
  button.textContent = "⠿";
  button.disabled = view.editable === false;
  configureGripDrag(view, button, "column", colIndex, tablePos, cellPos);
  button.addEventListener("mousedown", stopPropagation);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    selectColumn(view, cellPos);
    openGripMenu(view, button, columnMenuItems(cellPos), "column");
  });
  return button;
}

function buildRowGrip(
  view: EditorView,
  cellPos: number,
  rowIndex: number,
  tablePos: number,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-grip dohc-table-grip--row";
  button.title = `Row ${rowIndex + 1} — drag to reorder, click for options`;
  button.setAttribute("aria-label", `Select row ${rowIndex + 1}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-table-row", String(rowIndex));
  button.setAttribute("contenteditable", "false");
  button.textContent = "⠿";
  button.disabled = view.editable === false;
  configureGripDrag(view, button, "row", rowIndex, tablePos, cellPos);
  button.addEventListener("mousedown", stopPropagation);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    selectRow(view, cellPos);
    openGripMenu(view, button, rowMenuItems(), "row");
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
    openGripMenu(view, button, tableMenuItems(), "table");
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

function setActiveTableControls(view: EditorView, target: EventTarget | null): void {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const cell = element?.closest<HTMLTableCellElement>("td, th") ?? null;
  const table = cell?.closest<HTMLElement>(".dohc-table-node") ?? null;
  const rowIndex =
    (cell?.parentElement as HTMLTableRowElement | null)?.rowIndex ?? -1;
  const columnIndex = cell?.cellIndex ?? -1;

  view.dom.querySelectorAll<HTMLElement>(".dohc-table-grip").forEach((grip) => {
    const ownsActiveTable = table !== null && grip.closest(".dohc-table-node") === table;
    const matchesRow = grip.dataset.tableRow === String(rowIndex);
    const matchesColumn = grip.dataset.tableColumn === String(columnIndex);
    grip.classList.toggle(
      "is-visible",
      ownsActiveTable && (matchesRow || matchesColumn),
    );
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
          (view) => buildColumnGrip(view, cellPos, colIndex, pos),
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
          (view) => buildRowGrip(view, cellPos, rowIndex, pos),
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
      handleDOMEvents: {
        mousemove(view, event) {
          setActiveTableControls(view, event.target);
          return false;
        },
        mouseleave(view) {
          setActiveTableControls(view, null);
          return false;
        },
      },
      handleKeyDown(view, event) {
        if (event.key !== "Backspace" && event.key !== "Delete") return false;
        if (!deleteSelectedTableBand(view)) return false;
        event.preventDefault();
        return true;
      },
    },
    view() {
      return {
        // An open grip menu closes over a raw cell position (see
        // columnMenuItems). If the doc shifts while it's open — e.g. a remote
        // collab edit inserting/removing a column — that offset goes stale and
        // an "Align …" click would target the wrong column. The menu is a
        // detached overlay element, not a decoration, so it isn't rebuilt with
        // the grips; tear it down on any doc change instead.
        update(view, prevState) {
          if (closeOpenMenu && !view.state.doc.eq(prevState.doc)) {
            closeOpenMenu();
            closeOpenMenu = null;
          }
        },
        destroy() {
          closeOpenMenu?.();
          closeOpenMenu = null;
        },
      };
    },
  });
}
