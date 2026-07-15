// Table row/column/header controls — Notion-style handles + menus layered on
// TableKit's existing commands (addRowBefore/After, deleteRow,
// addColumnBefore/After, deleteColumn, toggleHeaderRow, deleteTable).
// TableKit ships every command already; this file is only the missing UI.
//
// Interaction model (mirrors Notion's simple tables):
// - Hovering a cell reveals exactly one small pill handle above its COLUMN
//   and one beside its ROW (the plugin's mousemove handler toggles
//   `is-active` on the matching grips) — not a bar on every row/column at
//   once. Clicking a handle selects the row/column and opens its options
//   menu (insert before/after, align, duplicate, delete).
// - Hovering the table reveals slim "+" strips hugging the full right edge
//   (append column) and bottom edge (append row), plus a "⋯" table menu at
//   the top-left corner (toggle header row, delete table).
// - Dragging a handle reorders rows/columns with an insertion-line preview.
//   Row boundaries also expose a separate resize affordance so reorder and
//   resize remain distinct gestures.
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

import { Fragment, Node as PMNode } from "@tiptap/pm/model";
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
  cellAround,
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
let nextTableControlsInstanceId = 0;

// Grips sit 13px out with an 8px pill; 18px covers that chrome (and the
// 15px append strips) while the pointer crosses the table-edge gap.
const GRIP_MARGIN = 18;
const MIN_ROW_HEIGHT = 36;

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
type TableDropSide = "before" | "after";

type TableDropTarget = {
  index: number;
  side: TableDropSide;
  destination: number;
  bandElement: HTMLElement;
};

type TableDragState = {
  band: TableBand;
  index: number;
  cellPos: number;
  tableElement: HTMLTableElement;
  sourceButton: HTMLButtonElement;
  scrollContainer: HTMLElement | null;
  preview: HTMLElement;
  indicator: HTMLElement;
  dropTarget?: TableDropTarget;
};

type TableRowResizeState = {
  rowPos: number;
  rowIndex: number;
  rowElement: HTMLTableRowElement;
  tableElement: HTMLTableElement;
  handle: HTMLButtonElement;
  pointerId: number;
  startY: number;
  startHeight: number;
  currentHeight: number;
  originalInlineHeight: string;
};

type TableControlsRuntime = {
  instanceId: number;
  activeDrag: TableDragState | null;
  activeRowResize: TableRowResizeState | null;
  cancelPointer: (() => void) | null;
  closeMenu: (() => void) | null;
  menuSerial: number;
};

function createTableControlsRuntime(): TableControlsRuntime {
  return {
    instanceId: nextTableControlsInstanceId++,
    activeDrag: null,
    activeRowResize: null,
    cancelPointer: null,
    closeMenu: null,
    menuSerial: 0,
  };
}

const suppressTableGripClickUntil = new WeakMap<HTMLButtonElement, number>();

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

export function resolveTableDropDestination({
  sourceIndex,
  targetIndex,
  side,
  bandCount,
}: {
  sourceIndex: number;
  targetIndex: number;
  side: TableDropSide;
  bandCount: number;
}): number {
  // Convert the visual boundary (before/after the hovered band) into the
  // final zero-based index after the source band has been removed.
  const boundary = targetIndex + (side === "after" ? 1 : 0);
  const destination = boundary - (sourceIndex < boundary ? 1 : 0);
  return Math.max(0, Math.min(destination, bandCount - 1));
}

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}

function runTableCommand(view: EditorView, command: TableCommand): boolean {
  if (view.editable === false) return false;
  const changed = command(view.state, view.dispatch);
  view.focus();
  return changed;
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

function setTableRowHeight(
  view: EditorView,
  rowPos: number,
  height: number | null,
): void {
  if (view.editable === false) return;
  const row = view.state.doc.nodeAt(rowPos);
  if (!row || row.type.name !== "tableRow") return;
  const normalized =
    height === null ? null : Math.max(MIN_ROW_HEIGHT, Math.round(height));
  const current = Number(row.attrs.height);
  if (
    (normalized === null && row.attrs.height == null) ||
    (normalized !== null && Number.isFinite(current) && current === normalized)
  ) {
    return;
  }
  view.dispatch(
    view.state.tr.setNodeMarkup(rowPos, undefined, {
      ...row.attrs,
      height: normalized,
    }),
  );
}

function tableAtCellPos(
  doc: PMNode,
  cellPos: number,
): { node: PMNode; pos: number } | null {
  const $cell = doc.resolve(cellPos);
  for (let depth = $cell.depth; depth > 0; depth -= 1) {
    if ($cell.node(depth).type.name === "table") {
      return { node: $cell.node(depth), pos: $cell.before(depth) };
    }
  }
  return null;
}

function setTableRowHeights(
  view: EditorView,
  tablePos: number,
  heights: Array<number | null>,
): void {
  const table = view.state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== "table") return;
  const tr = view.state.tr;
  let rowPos = tablePos + 1;
  for (let index = 0; index < table.childCount; index += 1) {
    const row = tr.doc.nodeAt(rowPos);
    if (!row || row.type.name !== "tableRow") return;
    const height = heights[index] ?? null;
    if (row.attrs.height !== height) {
      tr.setNodeMarkup(rowPos, undefined, { ...row.attrs, height });
    }
    rowPos += row.nodeSize;
  }
  if (tr.docChanged) view.dispatch(tr);
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

// Duplicate the row containing `cellPos`, inserting the copy right below.
// Pasted/imported rowspans follow prosemirror-tables' addRowAfter boundary
// rule: a cell whose span crosses the insertion boundary is widened by one
// row, so the duplicate shares the merged cell spreadsheet-style. A cell
// whose span ends at the duplicated row is copied with rowspan normalized to
// one — neighboring-row geometry never changes and no fixTables repair is
// needed. Header cells are duplicated as BODY cells: GFM expresses exactly
// one header row, so a second `th` row would not survive the markdown
// round-trip (see the file-top caveat). This matches Notion, where
// duplicating the header yields a normal row.
function duplicateRow(view: EditorView, cellPos: number): void {
  if (view.editable === false) return;
  const { state } = view;
  const $cell = state.doc.resolve(cellPos);
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const { top: r } = map.findCell(cellPos - tableStart);
  const rowNode = table.child(r);
  const cellType = state.schema.nodes.tableCell;
  const cells: PMNode[] = [];
  const seen = new Set<number>();
  let tr = state.tr;
  for (let col = 0; col < map.width; col += 1) {
    const offset = map.map[r * map.width + col];
    if (seen.has(offset)) continue;
    seen.add(offset);
    const cell = table.nodeAt(offset);
    if (!cell) continue;
    if (map.findCell(offset).bottom - 1 > r) {
      tr = tr.setNodeMarkup(tableStart + offset, undefined, {
        ...cell.attrs,
        rowspan: cell.attrs.rowspan + 1,
      });
      continue;
    }
    const copyType =
      cell.type.name === "tableHeader" && cellType ? cellType : cell.type;
    cells.push(
      copyType.create(
        { ...cell.attrs, rowspan: 1 },
        cell.content,
        cell.marks,
      ),
    );
  }

  let insertPos = tableStart;
  for (let row = 0; row <= r; row += 1) {
    insertPos += table.child(row).nodeSize;
  }
  tr = tr.insert(insertPos, rowNode.copy(Fragment.from(cells)));
  if (tr.docChanged) view.dispatch(tr);
  view.focus();
}

// Duplicate the logical column containing `cellPos`, inserting the copy right
// after it in every row (bottom-to-top so earlier insert positions stay
// valid). Pasted/imported colspans follow prosemirror-tables' addColumn
// convention: a spanning cell covering the selected column is widened at
// that boundary, with its matching colwidth entry duplicated in place — so
// every row gains the same logical column and merged headers remain aligned.
// The dedup set guards pasted-in rowspan cells — a spanning cell appears at
// several TableMap slots but must be copied or widened once; its operation
// covers the same rows.
function duplicateColumn(view: EditorView, cellPos: number): void {
  if (view.editable === false) return;
  const { state } = view;
  const $cell = state.doc.resolve(cellPos);
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const { left: col } = map.findCell(cellPos - tableStart);
  let tr = state.tr;
  const seen = new Set<number>();
  for (let row = map.height - 1; row >= 0; row -= 1) {
    const offset = map.map[row * map.width + col];
    if (seen.has(offset)) continue;
    seen.add(offset);
    const cell = table.nodeAt(offset);
    if (!cell) continue;
    if (cell.attrs.colspan > 1) {
      const { left } = map.findCell(offset);
      const colwidth = cell.attrs.colwidth as number[] | null;
      const i = col - left;
      const nextColwidth = colwidth
        ? [...colwidth.slice(0, i + 1), colwidth[i], ...colwidth.slice(i + 1)]
        : null;
      tr = tr.setNodeMarkup(tableStart + offset, undefined, {
        ...cell.attrs,
        colspan: cell.attrs.colspan + 1,
        colwidth: nextColwidth,
      });
    } else {
      tr = tr.insert(tableStart + offset + cell.nodeSize, cell.copy(cell.content));
    }
  }
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
    { label: "Duplicate column", run: (view) => duplicateColumn(view, cellPos) },
    {
      label: "Delete column",
      destructive: true,
      separatorBefore: true,
      run: (view) => runTableCommand(view, deleteColumn),
    },
  ];
}

function rowMenuItems(cellPos: number): GripMenuItem[] {
  return [
    { label: "Insert row above", run: (view) => runTableCommand(view, addRowBefore) },
    { label: "Insert row below", run: (view) => runTableCommand(view, addRowAfter) },
    { label: "Duplicate row", run: (view) => duplicateRow(view, cellPos) },
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

// A single vanilla-DOM popover per editor instance. Visuals mirror
// `.dohc-slash-menu` (`.dohc-table-menu`
// in styles.css); keyboard model (arrows/Enter/Escape) mirrors
// SlashCommandMenu's handleKeyDown in MarkdownEditor.tsx.
function openGripMenu(
  runtime: TableControlsRuntime,
  view: EditorView,
  anchor: HTMLElement,
  items: GripMenuItem[],
  placement: TableMenuPlacement,
): void {
  runtime.closeMenu?.();
  runtime.closeMenu = null;
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
  menu.tabIndex = -1;
  const menuId = `dohc-table-menu-${runtime.instanceId}-${runtime.menuSerial++}`;
  menu.id = menuId;
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
    const activeButton = buttons[selected];
    if (activeButton) menu.setAttribute("aria-activedescendant", activeButton.id);
  };

  const runItem = (index: number) => {
    const item = items[index];
    close();
    item?.run(view);
  };

  items.forEach((item, index) => {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.id = `${menuId}-item-${index}`;
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
      anchor.focus();
    }
  }

  function onPointerDown(event: MouseEvent): void {
    // Window-level events are retargeted to the shadow host when the embedded
    // editor owns this menu. composedPath preserves the real menu ancestry.
    if (event.composedPath().includes(menu)) return;
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
    if (runtime.closeMenu === close) runtime.closeMenu = null;
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
  menu.focus({ preventScroll: true });
  runtime.closeMenu = close;
}

function clearTableDropTargetChrome(view: EditorView): void {
  view.dom
    .querySelectorAll<HTMLElement>(
      ".dohc-table-grip.is-drop-target, .dohc-table-drop-before, .dohc-table-drop-after",
    )
    .forEach((element) =>
      element.classList.remove(
        "is-drop-target",
        "dohc-table-drop-before",
        "dohc-table-drop-after",
      ),
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
  table: HTMLTableElement,
  band: TableBand,
  index: number,
  className: string,
): void {
  if (band === "row") {
    table.rows[index]?.classList.add(className);
    return;
  }
  Array.from(table.rows).forEach((row) =>
    row.cells[index]?.classList.add(className),
  );
}

function announceTableDrag(view: EditorView, message: string): void {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const editorRoot = view.dom.getRootNode();
  const host =
    editorRoot instanceof ownerWindow.ShadowRoot ? editorRoot : ownerDocument.body;
  let status = host.querySelector<HTMLElement>(
    "[data-dohc-table-drag-status]",
  );
  if (!status) {
    status = ownerDocument.createElement("div");
    status.className = "dohc-table-drag-status";
    status.dataset.dohcTableDragStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    host.appendChild(status);
  }
  status.textContent = message;
}

function createTableDragPreview(
  view: EditorView,
  band: TableBand,
  index: number,
): HTMLElement {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const editorRoot = view.dom.getRootNode();
  const host =
    editorRoot instanceof ownerWindow.ShadowRoot ? editorRoot : ownerDocument.body;
  const preview = ownerDocument.createElement("div");
  preview.className = "dohc-table-drag-preview";
  preview.textContent = `⠿  ${band === "row" ? "Row" : "Column"} ${index + 1}`;
  host.appendChild(preview);
  return preview;
}

function createTableDropIndicator(
  view: EditorView,
  band: TableBand,
): HTMLElement {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const editorRoot = view.dom.getRootNode();
  const host =
    editorRoot instanceof ownerWindow.ShadowRoot ? editorRoot : ownerDocument.body;
  const indicator = ownerDocument.createElement("div");
  indicator.className = `dohc-table-drop-indicator dohc-table-drop-indicator--${band}`;
  indicator.setAttribute("aria-hidden", "true");
  host.appendChild(indicator);
  return indicator;
}

function positionTableDragPreview(
  preview: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  preview.style.transform = `translate3d(${clientX + 14}px, ${clientY + 14}px, 0)`;
}

function positionTableDropIndicator(
  drag: TableDragState,
  target: TableDropTarget,
): void {
  const tableRect = drag.tableElement.getBoundingClientRect();
  const targetRect = target.bandElement.getBoundingClientRect();
  const wrapperRect = drag.tableElement
    .closest<HTMLElement>(".tableWrapper")
    ?.getBoundingClientRect();
  const visibleLeft = Math.max(tableRect.left, wrapperRect?.left ?? tableRect.left);
  const visibleRight = Math.min(tableRect.right, wrapperRect?.right ?? tableRect.right);
  const visibleTop = Math.max(tableRect.top, wrapperRect?.top ?? tableRect.top);
  const visibleBottom = Math.min(tableRect.bottom, wrapperRect?.bottom ?? tableRect.bottom);

  if (drag.band === "row") {
    const y = target.side === "before" ? targetRect.top : targetRect.bottom;
    drag.indicator.style.width = `${Math.max(0, visibleRight - visibleLeft)}px`;
    drag.indicator.style.height = "3px";
    drag.indicator.style.transform = `translate3d(${visibleLeft}px, ${y - 1.5}px, 0)`;
    drag.indicator.dataset.label = `Drop to row ${target.destination + 1}`;
  } else {
    const x = target.side === "before" ? targetRect.left : targetRect.right;
    drag.indicator.style.width = "3px";
    drag.indicator.style.height = `${Math.max(0, visibleBottom - visibleTop)}px`;
    drag.indicator.style.transform = `translate3d(${x - 1.5}px, ${visibleTop}px, 0)`;
    drag.indicator.dataset.label = `Drop to column ${target.destination + 1}`;
  }
  drag.indicator.classList.add("is-visible");
}

function editorElementFromPoint(
  view: EditorView,
  clientX: number,
  clientY: number,
): Element | null {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const root = view.dom.getRootNode();
  if (
    root instanceof ownerWindow.ShadowRoot &&
    typeof root.elementFromPoint === "function"
  ) {
    return root.elementFromPoint(clientX, clientY);
  }
  return ownerDocument.elementFromPoint(clientX, clientY);
}

function tableDropTargetFromPoint(
  view: EditorView,
  drag: TableDragState,
  target: Element | null,
  clientX: number,
  clientY: number,
): TableDropTarget | null {
  if (!target) return null;
  const cell = target.closest<HTMLTableCellElement>("td, th");
  if (!cell || cell.closest("table") !== drag.tableElement) return null;

  const row = cell.closest<HTMLTableRowElement>("tr");
  const bandElement = drag.band === "row" ? row : cell;
  if (!bandElement) return null;
  const rect = bandElement.getBoundingClientRect();
  const pointer = drag.band === "row" ? clientY : clientX;
  const start = drag.band === "row" ? rect.top : rect.left;
  const size = drag.band === "row" ? rect.height : rect.width;

  // DOM rowIndex/cellIndex describe physical elements, not ProseMirror's
  // logical table grid. Resolve the cell through TableMap so pasted rowspan
  // and colspan cells target the same indexes the move commands consume.
  const insideCell = view.posAtDOM(cell, 0);
  const $cell = view.state.doc.resolve(insideCell);
  let cellDepth = -1;
  let tableDepth = -1;
  for (let depth = $cell.depth; depth > 0; depth -= 1) {
    const name = $cell.node(depth).type.name;
    if (cellDepth < 0 && (name === "tableCell" || name === "tableHeader")) {
      cellDepth = depth;
    } else if (cellDepth >= 0 && name === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (cellDepth < 0 || tableDepth < 0) return null;
  const tableNode = $cell.node(tableDepth);
  const map = TableMap.get(tableNode);
  const cellOffset = $cell.before(cellDepth) - $cell.start(tableDepth);
  const cellRect = map.findCell(cellOffset);
  const logicalStart = drag.band === "row" ? cellRect.top : cellRect.left;
  const logicalEnd = drag.band === "row" ? cellRect.bottom : cellRect.right;
  const span = Math.max(1, logicalEnd - logicalStart);
  // A zero-size rect occurs in jsdom and transiently while Chromium lays out
  // newly inserted decorations. Preserve the previous intuitive fallback:
  // a pointer at/after the origin means the trailing edge.
  const fraction =
    size > 0
      ? Math.min(0.999_999, Math.max(0, (pointer - start) / size))
      : pointer < start
        ? 0
        : 0.999_999;
  const scaled = fraction * span;
  const index = logicalStart + Math.floor(scaled);
  const side: TableDropSide = scaled - Math.floor(scaled) < 0.5 ? "before" : "after";
  return {
    index,
    side,
    bandElement,
    destination: resolveTableDropDestination({
      sourceIndex: drag.index,
      targetIndex: index,
      side,
      bandCount: drag.band === "row" ? map.height : map.width,
    }),
  };
}

function markTableDropTarget(
  view: EditorView,
  drag: TableDragState,
  target: TableDropTarget,
): void {
  clearTableDropTargetChrome(view);
  const gripSelector =
    drag.band === "row"
      ? `[data-table-row="${target.index}"]`
      : `[data-table-column="${target.index}"]`;
  drag.tableElement
    .querySelector(gripSelector)
    ?.classList.add("is-drop-target");
  target.bandElement.classList.add(
    target.side === "before" ? "dohc-table-drop-before" : "dohc-table-drop-after",
  );
  positionTableDropIndicator(drag, target);
}

function findVerticalScrollContainer(view: EditorView): HTMLElement | null {
  const ownerWindow = view.dom.ownerDocument.defaultView ?? window;
  let element = view.dom.parentElement;
  while (element) {
    const overflowY = ownerWindow.getComputedStyle(element).overflowY;
    if (
      /(auto|scroll)/.test(overflowY) &&
      element.scrollHeight > element.clientHeight
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

function autoScrollTableDrag(drag: TableDragState, clientY: number): void {
  const scroller = drag.scrollContainer;
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const edge = Math.min(64, Math.max(36, rect.height * 0.1));
  let delta = 0;
  if (clientY < rect.top + edge) {
    delta = -Math.ceil((rect.top + edge - clientY) / 4);
  } else if (clientY > rect.bottom - edge) {
    delta = Math.ceil((clientY - (rect.bottom - edge)) / 4);
  }
  if (delta !== 0) scroller.scrollTop += Math.max(-18, Math.min(delta, 18));
}

function updateTableDragTarget(
  view: EditorView,
  drag: TableDragState,
  hitTarget: Element | null,
  clientX: number,
  clientY: number,
): TableDropTarget | null {
  const target = tableDropTargetFromPoint(view, drag, hitTarget, clientX, clientY);
  if (!target) {
    clearTableDropTargetChrome(view);
    drag.indicator.classList.remove("is-visible");
    drag.dropTarget = undefined;
    return null;
  }

  autoScrollTableDrag(drag, clientY);

  const changed =
    drag.dropTarget?.index !== target.index ||
    drag.dropTarget?.side !== target.side;
  drag.dropTarget = target;
  if (target.destination === drag.index) {
    clearTableDropTargetChrome(view);
    drag.indicator.classList.remove("is-visible");
  } else {
    markTableDropTarget(view, drag, target);
  }
  if (changed) {
    const label = drag.band === "row" ? "row" : "column";
    announceTableDrag(
      view,
      target.destination === drag.index
        ? `${label} ${drag.index + 1}, original position.`
        : `Move ${label} ${drag.index + 1} ${target.side} ${label} ${target.index + 1}.`,
    );
  }
  return target;
}

function finishTableDrop(
  runtime: TableControlsRuntime,
  view: EditorView,
  drag: TableDragState,
  target: TableDropTarget | undefined,
): void {
  drag.preview.remove();
  drag.indicator.remove();
  drag.sourceButton.setAttribute("aria-grabbed", "false");
  suppressTableGripClickUntil.set(drag.sourceButton, Date.now() + 250);

  if (target && target.destination !== drag.index) {
    const sourceTable =
      drag.band === "row" ? tableAtCellPos(view.state.doc, drag.cellPos) : null;
    const rowHeights = sourceTable
      ? Array.from({ length: sourceTable.node.childCount }, (_, index) => {
          const height = sourceTable.node.child(index).attrs.height;
          return typeof height === "number" && Number.isFinite(height)
            ? height
            : null;
        })
      : null;
    // prosemirror-tables resolves rowspan/colspan ranges from the current
    // selection even when its `pos` option identifies the table. Move the
    // selection only after pointer release, when rebuilding decorations can
    // no longer invalidate the active handle.
    focusCell(view, drag.cellPos);
    const command =
      drag.band === "column"
        ? moveTableColumn({
            from: drag.index,
            to: target.destination,
            pos: drag.cellPos,
          })
        : moveTableRow({
            from: drag.index,
            to: target.destination,
            pos: drag.cellPos,
          });
    const moved = runTableCommand(view, command);
    if (moved && sourceTable && rowHeights) {
      const [movedHeight] = rowHeights.splice(drag.index, 1);
      rowHeights.splice(target.destination, 0, movedHeight ?? null);
      setTableRowHeights(view, sourceTable.pos, rowHeights);
    }
    announceTableDrag(
      view,
      moved
        ? `${drag.band === "row" ? "Row" : "Column"} ${drag.index + 1} moved to position ${target.destination + 1}.`
        : `Could not move ${drag.band} ${drag.index + 1}.`,
    );
  }
  runtime.activeDrag = null;
  clearTableDragChrome(view);
}

function configureGripDrag(
  runtime: TableControlsRuntime,
  view: EditorView,
  button: HTMLButtonElement,
  band: TableBand,
  index: number,
  cellPos: number,
): void {
  button.draggable = false;
  const ownerWindow = button.ownerDocument.defaultView ?? window;

  let pointerSession:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        dragging: boolean;
        preview: HTMLElement | null;
      }
    | undefined;

  const detachReleaseFallbacks = () => {
    ownerWindow.removeEventListener("pointermove", handleWindowPointerMove, true);
    ownerWindow.removeEventListener("pointerup", handleWindowPointerUp, true);
    ownerWindow.removeEventListener("mouseup", handleWindowMouseUp, true);
    ownerWindow.removeEventListener("pointercancel", handleWindowPointerCancel, true);
    ownerWindow.removeEventListener("keydown", handleWindowKeyDown, true);
  };

  const releasePointer = (pointerId: number) => {
    try {
      if (button.hasPointerCapture?.(pointerId)) {
        button.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may release capture itself after pointerup/cancel.
    }
  };

  const cancelPointerDrag = (message?: string) => {
    const session = pointerSession;
    if (!session) return;
    detachReleaseFallbacks();
    runtime.cancelPointer = null;
    session.preview?.remove();
    runtime.activeDrag?.indicator.remove();
    button.setAttribute("aria-grabbed", "false");
    if (session.dragging) {
      suppressTableGripClickUntil.set(button, Date.now() + 250);
      if (message) announceTableDrag(view, message);
    }
    runtime.activeDrag = null;
    clearTableDragChrome(view);
    pointerSession = undefined;
    releasePointer(session.pointerId);
  };

  const beginPointerDrag = (event: PointerEvent): TableDragState | null => {
    const tableElement = button.closest("table");
    if (!tableElement || !pointerSession) return null;
    runtime.closeMenu?.();
    runtime.closeMenu = null;
    const preview = createTableDragPreview(view, band, index);
    const indicator = createTableDropIndicator(view, band);
    const drag: TableDragState = {
      band,
      index,
      cellPos,
      tableElement,
      sourceButton: button,
      scrollContainer: findVerticalScrollContainer(view),
      preview,
      indicator,
    };
    runtime.activeDrag = drag;
    pointerSession.dragging = true;
    pointerSession.preview = preview;
    positionTableDragPreview(pointerSession.preview, event.clientX, event.clientY);

    // Do not create a ProseMirror row/column selection here. That dispatches a
    // transaction, rebuilds the table decorations, and detaches the handle
    // that currently owns pointer capture. The drag-source classes below give
    // the same visual feedback without invalidating the active gesture.
    tableElement.classList.add("is-reordering");
    button.classList.add("is-dragging");
    button.setAttribute("aria-grabbed", "true");
    markTableBand(tableElement, band, index, "dohc-table-drag-source");
    announceTableDrag(
      view,
      `Moving ${band} ${index + 1}. Drag over any cell to choose a new position.`,
    );
    return drag;
  };

  const finishPointerDragAt = (
    clientX: number,
    clientY: number,
    pointerId?: number,
  ) => {
    const session = pointerSession;
    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) {
      return;
    }
    detachReleaseFallbacks();
    runtime.cancelPointer = null;
    if (!session.dragging || !runtime.activeDrag) {
      pointerSession = undefined;
      releasePointer(session.pointerId);
      return;
    }
    const drag = runtime.activeDrag;
    const hitTarget = editorElementFromPoint(view, clientX, clientY);
    const previousTarget = drag.dropTarget;
    const target =
      (hitTarget
        ? updateTableDragTarget(view, drag, hitTarget, clientX, clientY)
        : null) ?? previousTarget;
    pointerSession = undefined;
    releasePointer(session.pointerId);
    finishTableDrop(runtime, view, drag, target);
  };

  function handleWindowPointerUp(event: PointerEvent): void {
    finishPointerDragAt(event.clientX, event.clientY, event.pointerId);
  }

  function handleWindowPointerMove(event: PointerEvent): void {
    const session = pointerSession;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.dragging) {
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (dx * dx + dy * dy < 25) return;
    }
    const drag = runtime.activeDrag ?? beginPointerDrag(event);
    if (!drag || !pointerSession?.preview) return;
    event.preventDefault();
    event.stopPropagation();
    positionTableDragPreview(pointerSession.preview, event.clientX, event.clientY);
    const hitTarget = editorElementFromPoint(view, event.clientX, event.clientY);
    updateTableDragTarget(view, drag, hitTarget, event.clientX, event.clientY);
  }

  function handleWindowMouseUp(event: MouseEvent): void {
    if (event.button === 0) finishPointerDragAt(event.clientX, event.clientY);
  }

  function handleWindowPointerCancel(): void {
    cancelPointerDrag("Table reorder cancelled after pointer input ended.");
  }

  function handleWindowKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelPointerDrag("Table reorder cancelled.");
  }

  button.addEventListener("pointerdown", (event) => {
    if (view.editable === false || event.button !== 0) return;
    runtime.cancelPointer?.();
    pointerSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      preview: null,
    };
    runtime.cancelPointer = () => cancelPointerDrag();
    try {
      button.setPointerCapture?.(event.pointerId);
    } catch {
      // Electron supports capture; this only guards synthetic/test renderers.
    }
    // Track on the window so the gesture survives a lost capture or a handle
    // moving out from under the cursor while the table updates visually.
    ownerWindow.addEventListener("pointermove", handleWindowPointerMove, true);
    ownerWindow.addEventListener("pointerup", handleWindowPointerUp, true);
    // Some Electron/automation paths emit mouseup without a matching pointerup.
    ownerWindow.addEventListener("mouseup", handleWindowMouseUp, true);
    ownerWindow.addEventListener("pointercancel", handleWindowPointerCancel, true);
    ownerWindow.addEventListener("keydown", handleWindowKeyDown, true);
  });

  // This local listener is also needed by embedded/synthetic DOMs whose
  // pointer events do not traverse the owning window's capture phase.
  button.addEventListener("pointermove", handleWindowPointerMove);

  button.addEventListener("pointerup", (event) => {
    if (!pointerSession || pointerSession.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishPointerDragAt(event.clientX, event.clientY, event.pointerId);
  });

  button.addEventListener("pointercancel", () => {
    cancelPointerDrag("Table reorder cancelled after pointer input ended.");
  });
}

function configureRowResize(
  runtime: TableControlsRuntime,
  view: EditorView,
  button: HTMLButtonElement,
  rowPos: number,
  rowIndex: number,
): void {
  const ownerWindow = button.ownerDocument.defaultView ?? window;

  const detach = () => {
    ownerWindow.removeEventListener("pointermove", onPointerMove, true);
    ownerWindow.removeEventListener("pointerup", onPointerUp, true);
    ownerWindow.removeEventListener("pointercancel", onPointerCancel, true);
    ownerWindow.removeEventListener("keydown", onKeyDown, true);
  };

  const releasePointer = (pointerId: number) => {
    try {
      if (button.hasPointerCapture?.(pointerId)) {
        button.releasePointerCapture(pointerId);
      }
    } catch {
      // Synthetic renderers and a browser-completed pointerup may release it.
    }
  };

  const finish = (commit: boolean) => {
    const resize = runtime.activeRowResize;
    if (!resize || resize.handle !== button) return;
    const heightChanged = resize.currentHeight !== resize.startHeight;
    detach();
    runtime.cancelPointer = null;
    runtime.activeRowResize = null;
    resize.tableElement.classList.remove("is-resizing-row");
    resize.rowElement.classList.remove("dohc-table-row-is-resizing");
    button.classList.remove("is-resizing");
    button.setAttribute("aria-grabbed", "false");
    releasePointer(resize.pointerId);
    if (commit && heightChanged) {
      setTableRowHeight(view, resize.rowPos, resize.currentHeight);
      announceTableDrag(
        view,
        `Row ${resize.rowIndex + 1} height set to ${Math.round(resize.currentHeight)} pixels.`,
      );
    } else {
      resize.rowElement.style.height = resize.originalInlineHeight;
      if (!commit) {
        announceTableDrag(view, `Row ${resize.rowIndex + 1} resize cancelled.`);
      }
    }
  };

  function onPointerMove(event: PointerEvent): void {
    const resize = runtime.activeRowResize;
    if (!resize || resize.handle !== button || event.pointerId !== resize.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resize.currentHeight = Math.max(
      MIN_ROW_HEIGHT,
      Math.round(resize.startHeight + event.clientY - resize.startY),
    );
    resize.rowElement.style.height = `${resize.currentHeight}px`;
  }

  function onPointerUp(event: PointerEvent): void {
    const resize = runtime.activeRowResize;
    if (!resize || event.pointerId !== resize.pointerId) return;
    finish(true);
  }

  function onPointerCancel(): void {
    finish(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    finish(false);
  }

  button.addEventListener("pointerdown", (event) => {
    if (view.editable === false || event.button !== 0) return;
    const rowElement = button.closest<HTMLTableRowElement>("tr");
    const tableElement = button.closest<HTMLTableElement>("table");
    if (!rowElement || !tableElement) return;
    stopEvent(event);
    runtime.cancelPointer?.();
    const measuredHeight = rowElement.getBoundingClientRect().height;
    const startHeight = Math.max(
      MIN_ROW_HEIGHT,
      Math.round(measuredHeight || Number(rowElement.dataset.rowHeight) || MIN_ROW_HEIGHT),
    );
    runtime.activeRowResize = {
      rowPos,
      rowIndex,
      rowElement,
      tableElement,
      handle: button,
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      currentHeight: startHeight,
      originalInlineHeight: rowElement.style.height,
    };
    runtime.cancelPointer = () => finish(false);
    tableElement.classList.add("is-resizing-row");
    rowElement.classList.add("dohc-table-row-is-resizing");
    button.classList.add("is-resizing");
    button.setAttribute("aria-grabbed", "true");
    try {
      button.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is available in Electron; tests may omit it.
    }
    ownerWindow.addEventListener("pointermove", onPointerMove, true);
    ownerWindow.addEventListener("pointerup", onPointerUp, true);
    ownerWindow.addEventListener("pointercancel", onPointerCancel, true);
    ownerWindow.addEventListener("keydown", onKeyDown, true);
  });

  // Keep synthetic/embedded DOMs functional when their pointer events do not
  // reach the owning window's capture phase.
  button.addEventListener("pointermove", onPointerMove);
  button.addEventListener("pointerup", onPointerUp);
  button.addEventListener("pointercancel", onPointerCancel);

  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    stopEvent(event);
    const rowElement = button.closest<HTMLTableRowElement>("tr");
    if (!rowElement) return;
    const current = Math.max(
      MIN_ROW_HEIGHT,
      Math.round(rowElement.getBoundingClientRect().height || MIN_ROW_HEIGHT),
    );
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const amount = event.shiftKey ? 10 : 2;
    setTableRowHeight(view, rowPos, Math.max(MIN_ROW_HEIGHT, current + direction * amount));
  });

  button.addEventListener("dblclick", (event) => {
    stopEvent(event);
    setTableRowHeight(view, rowPos, null);
    announceTableDrag(view, `Row ${rowIndex + 1} height reset to fit its content.`);
  });
}

function buildRowResizeHandle(
  runtime: TableControlsRuntime,
  view: EditorView,
  rowPos: number,
  rowIndex: number,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-row-resize";
  button.dataset.tableRowResize = String(rowIndex);
  button.title = `Resize row ${rowIndex + 1}; double-click to reset`;
  button.setAttribute("aria-label", `Resize row ${rowIndex + 1}`);
  button.setAttribute("aria-grabbed", "false");
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  configureRowResize(runtime, view, button, rowPos, rowIndex);
  return button;
}

function buildColumnGrip(
  runtime: TableControlsRuntime,
  view: EditorView,
  cellPos: number,
  colIndex: number,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-grip dohc-table-grip--col";
  button.dataset.col = String(colIndex);
  button.title = `Column ${colIndex + 1} - drag to reorder, click for options`;
  button.setAttribute("aria-label", `Select column ${colIndex + 1}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-table-column", String(colIndex));
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  configureGripDrag(runtime, view, button, "column", colIndex, cellPos);
  button.addEventListener("mousedown", stopPropagation);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    if (Date.now() < (suppressTableGripClickUntil.get(button) ?? 0)) return;
    selectColumn(view, cellPos);
    openGripMenu(runtime, view, button, columnMenuItems(cellPos), "column");
  });
  return button;
}

function buildRowGrip(
  runtime: TableControlsRuntime,
  view: EditorView,
  cellPos: number,
  rowIndex: number,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dohc-table-grip dohc-table-grip--row";
  button.dataset.row = String(rowIndex);
  button.title = `Row ${rowIndex + 1} - drag to reorder, click for options`;
  button.setAttribute("aria-label", `Select row ${rowIndex + 1}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-table-row", String(rowIndex));
  button.setAttribute("contenteditable", "false");
  button.disabled = view.editable === false;
  configureGripDrag(runtime, view, button, "row", rowIndex, cellPos);
  button.addEventListener("mousedown", stopPropagation);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    if (Date.now() < (suppressTableGripClickUntil.get(button) ?? 0)) return;
    selectRow(view, cellPos);
    openGripMenu(runtime, view, button, rowMenuItems(cellPos), "row");
  });
  return button;
}

function buildTableMenuButton(
  runtime: TableControlsRuntime,
  view: EditorView,
  cellPos: number,
): HTMLElement {
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
    openGripMenu(runtime, view, button, tableMenuItems(), "table");
  });
  return button;
}

// Notion-style append strips: a slim "+" strip hugging the table's full
// right edge (append column) and full bottom edge (append row). Each is
// anchored inside a corner cell (top-right for the column, bottom-left for
// the row) so it tracks the live-resized table box the same way the grips
// do, and floats into the outer margin via negative CSS offsets. A
// cell-anchored widget can only span its own cell via CSS, so
// sizeAppendStrips stretches each strip to the full table edge with inline
// offsets.
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

type ActiveTableControls = {
  table: HTMLElement | null;
  rowIndex: number;
  columnIndex: number;
};

function setActiveTableControls(
  view: EditorView,
  target: EventTarget | null,
  previous: ActiveTableControls | undefined,
): ActiveTableControls {
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
  if (
    previous?.table === table &&
    previous.rowIndex === rowIndex &&
    previous.columnIndex === columnIndex
  ) {
    return previous;
  }

  view.dom.querySelectorAll<HTMLElement>(".dohc-table-grip").forEach((grip) => {
    const ownsActiveTable = table !== null && grip.closest(".dohc-table-node") === table;
    const matchesRow = grip.dataset.tableRow === String(rowIndex);
    const matchesColumn = grip.dataset.tableColumn === String(columnIndex);
    grip.classList.toggle(
      "is-visible",
      ownsActiveTable && (matchesRow || matchesColumn),
    );
  });
  view.dom
    .querySelectorAll<HTMLElement>(".dohc-table-row-resize")
    .forEach((handle) => {
      const ownsActiveTable =
        table !== null && handle.closest(".dohc-table-node") === table;
      handle.classList.toggle(
        "is-visible",
        ownsActiveTable && handle.dataset.tableRowResize === String(rowIndex),
      );
    });
  return { table, rowIndex, columnIndex };
}

function buildTableControlDecorations(
  doc: PMNode,
  runtime: TableControlsRuntime,
): DecorationSet {
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
          (view) => buildColumnGrip(runtime, view, cellPos, colIndex),
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
        (view) => buildTableMenuButton(runtime, view, topLeftCellPos),
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
    let rowPos = tableStart;
    for (let row = 0; row < map.height; row += 1) {
      const rowNode = node.child(row);
      const cellPos = tableStart + map.map[row * map.width];
      const rowIndex = row;
      if (cellPos !== lastRowCellPos) {
        lastRowCellPos = cellPos;
        decorations.push(
          widgetDecoration(
            cellPos + 1,
            (view) => buildRowGrip(runtime, view, cellPos, rowIndex),
            `dohc-table-row-${cellPos}`,
          ),
        );
      }
      // The resize bar is anchored in the row's first physical cell rather
      // than TableMap's first logical slot. A rowspan from the row above can
      // own that logical slot, but each editable row still needs its own
      // height control and row node position.
      if (rowNode.childCount > 0) {
        const currentRowPos = rowPos;
        const resizeCellPos = rowPos + 1;
        decorations.push(
          widgetDecoration(
            resizeCellPos + 1,
            (view) =>
              buildRowResizeHandle(runtime, view, currentRowPos, rowIndex),
            `dohc-table-row-resize-${currentRowPos}`,
          ),
        );
      }
      rowPos += rowNode.nodeSize;
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

// Stretch the append strips of `table` to span its full right/bottom edge.
// Inline styles override the CSS fallback (which only spans the anchor cell)
// because the strip's absolute-positioning containing block is its anchor
// cell, not the table.
function sizeAppendStrips(table: HTMLElement): void {
  const rect = table.getBoundingClientRect();
  const colStrip = table.querySelector<HTMLElement>(".dohc-table-append--col");
  const colCell = colStrip?.parentElement;
  if (colStrip && colCell) {
    colStrip.style.top = `${rect.top - colCell.getBoundingClientRect().top}px`;
    colStrip.style.height = `${rect.height}px`;
  }
  const rowStrip = table.querySelector<HTMLElement>(".dohc-table-append--row");
  const rowCell = rowStrip?.parentElement;
  if (rowStrip && rowCell) {
    rowStrip.style.left = `${rect.left - rowCell.getBoundingClientRect().left}px`;
    rowStrip.style.width = `${rect.width}px`;
  }
  table
    .querySelectorAll<HTMLElement>(".dohc-table-row-resize")
    .forEach((handle) => {
      const anchorCell = handle.parentElement;
      if (!anchorCell) return;
      handle.style.left = `${rect.left - anchorCell.getBoundingClientRect().left}px`;
      handle.style.width = `${rect.width}px`;
    });
}

// The CSS fallback only spans the anchor corner cell, so size every append
// strip before edge hover. Otherwise a tall/wide table approached straight
// from the right/bottom margin has no full-edge "+" target yet.
function sizeAllAppendStrips(view: EditorView): void {
  view.dom.querySelectorAll<HTMLElement>("table").forEach((table) => {
    if (table.querySelector(".dohc-table-append")) sizeAppendStrips(table);
  });
}

type HoveredTable = { table: HTMLElement; col: number; row: number };

export function makeTableControlsPlugin(): Plugin {
  const runtime = createTableControlsRuntime();
  let activeControls: ActiveTableControls | undefined;
  // Notion reveals ONE column handle (above the hovered column) and ONE row
  // handle (beside the hovered row) — not chrome on every row/column at
  // once. CSS alone can't express "the row-0 cell of whichever column the
  // pointer is in", so mousemove tracking toggles `is-active` on the
  // matching grips. Hovering a grip itself also keeps it active: grips are
  // DOM descendants of their anchor cell, so `closest("td, th")` still
  // resolves.
  let hovered: HoveredTable | null = null;

  const clearHover = (): void => {
    if (!hovered) return;
    hovered.table
      .querySelectorAll(".dohc-table-grip.is-active")
      .forEach((el) => el.classList.remove("is-active"));
    hovered = null;
  };

  // Re-assertable: decorations rebuild on every doc change, dropping the
  // class from the freshly built grips, so the plugin view's update() calls
  // this again for the still-hovered table.
  const applyHover = (): void => {
    if (!hovered) return;
    hovered.table
      .querySelector(`.dohc-table-grip--col[data-col="${hovered.col}"]`)
      ?.classList.add("is-active");
    hovered.table
      .querySelector(`.dohc-table-grip--row[data-row="${hovered.row}"]`)
      ?.classList.add("is-active");
  };

  const onMouseMove = (view: EditorView, event: MouseEvent): boolean => {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    // Over the chrome itself (strips float outside the corner cell's box):
    // keep the current handles rather than re-deriving them from the corner
    // anchor cell.
    if (
      target.closest(
        ".dohc-table-grip, .dohc-table-row-resize, .dohc-table-append, .dohc-table-menu-btn",
      )
    ) {
      return false;
    }
    const cell = target.closest("td, th");
    const table = cell?.closest("table");
    if (!cell || !table || !view.dom.contains(table)) {
      // Inactive grips ignore pointer events. Clearing on the first non-cell
      // move would deactivate a handle in the 5px table-to-pill gap and make
      // it unreachable, so keep it alive until the pointer leaves the outer
      // margin and the grip can catch its own hover/click on the way out.
      if (hovered) {
        const rect = hovered.table.getBoundingClientRect();
        const insideMargin =
          event.clientX >= rect.left - GRIP_MARGIN &&
          event.clientX <= rect.right + GRIP_MARGIN &&
          event.clientY >= rect.top - GRIP_MARGIN &&
          event.clientY <= rect.bottom + GRIP_MARGIN;
        if (insideMargin) return false;
      }
      clearHover();
      return false;
    }
    // Grips carry TableMap indices, so hover must use the same map: DOM
    // sibling counting drifts when a rowspan from above covers earlier
    // slots. A spanning cell activates its anchor row/column handle.
    const pos = view.posAtDOM(cell, 0);
    if (pos < 0) {
      clearHover();
      return false;
    }
    const $cell = cellAround(view.state.doc.resolve(pos));
    if (!$cell) {
      clearHover();
      return false;
    }
    const tableNode = $cell.node(-1);
    const rect = TableMap.get(tableNode).findCell($cell.pos - $cell.start(-1));
    const col = rect.left;
    const row = rect.top;
    if (!hovered || hovered.table !== table || hovered.col !== col || hovered.row !== row) {
      clearHover();
      hovered = { table, col, row };
      applyHover();
    }
    sizeAppendStrips(table);
    return false;
  };

  return new Plugin({
    key: tableControlsKey,
    state: {
      init(_, instance) {
        return buildTableControlDecorations(instance.doc, runtime);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        activeControls = undefined;
        return buildTableControlDecorations(tr.doc, runtime);
      },
    },
    props: {
      decorations(state) {
        return tableControlsKey.getState(state) as DecorationSet | undefined;
      },
      handleDOMEvents: {
        mousemove(view, event) {
          activeControls = setActiveTableControls(
            view,
            event.target,
            activeControls,
          );
          return onMouseMove(view, event);
        },
        mouseenter(view) {
          sizeAllAppendStrips(view);
          return false;
        },
        mouseleave(view) {
          activeControls = setActiveTableControls(view, null, activeControls);
          clearHover();
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
    view(view) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => sizeAllAppendStrips(view));
      }
      return {
        // An open grip menu closes over a raw cell position (see
        // columnMenuItems). If the doc shifts while it's open — e.g. a remote
        // collab edit inserting/removing a column — that offset goes stale and
        // an "Align …" click would target the wrong column. The menu is a
        // detached overlay element, not a decoration, so it isn't rebuilt with
        // the grips; tear it down on any doc change instead.
        update(view, prevState) {
          const docChanged = !view.state.doc.eq(prevState.doc);
          if (docChanged && runtime.activeRowResize) runtime.cancelPointer?.();
          if (runtime.closeMenu && docChanged) {
            runtime.closeMenu();
            runtime.closeMenu = null;
          }
          // Doc changes rebuild the grip widgets (dropping `is-active`) and
          // can change table boxes (added/removed rows): re-stretch every
          // strip and restore the hovered handles without waiting for the
          // next mousemove.
          if (docChanged) sizeAllAppendStrips(view);
          if (hovered) {
            if (!hovered.table.isConnected) {
              hovered = null;
              return;
            }
            applyHover();
          }
        },
        destroy() {
          runtime.cancelPointer?.();
          runtime.cancelPointer = null;
          runtime.closeMenu?.();
          runtime.closeMenu = null;
          runtime.activeDrag?.preview.remove();
          runtime.activeDrag?.indicator.remove();
          runtime.activeDrag = null;
          runtime.activeRowResize = null;
          activeControls = undefined;
          hovered = null;
        },
      };
    },
  });
}
