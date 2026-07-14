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
let nextTableControlsInstanceId = 0;

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
  dropTarget?: TableDropTarget;
};

type TableControlsRuntime = {
  instanceId: number;
  activeDrag: TableDragState | null;
  cancelPointer: (() => void) | null;
  closeMenu: (() => void) | null;
  menuSerial: number;
};

function createTableControlsRuntime(): TableControlsRuntime {
  return {
    instanceId: nextTableControlsInstanceId++,
    activeDrag: null,
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

function positionTableDragPreview(
  preview: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  preview.style.transform = `translate3d(${clientX + 14}px, ${clientY + 14}px, 0)`;
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
  drag.sourceButton.setAttribute("aria-grabbed", "false");
  suppressTableGripClickUntil.set(drag.sourceButton, Date.now() + 250);

  if (target && target.destination !== drag.index) {
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
    const drag: TableDragState = {
      band,
      index,
      cellPos,
      tableElement,
      sourceButton: button,
      scrollContainer: findVerticalScrollContainer(view),
      preview,
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

function buildColumnGrip(
  runtime: TableControlsRuntime,
  view: EditorView,
  cellPos: number,
  colIndex: number,
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
  button.title = `Row ${rowIndex + 1} — drag to reorder, click for options`;
  button.setAttribute("aria-label", `Select row ${rowIndex + 1}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-table-row", String(rowIndex));
  button.setAttribute("contenteditable", "false");
  button.textContent = "⠿";
  button.disabled = view.editable === false;
  configureGripDrag(runtime, view, button, "row", rowIndex, cellPos);
  button.addEventListener("mousedown", stopPropagation);
  button.addEventListener("click", (event) => {
    stopEvent(event);
    if (Date.now() < (suppressTableGripClickUntil.get(button) ?? 0)) return;
    selectRow(view, cellPos);
    openGripMenu(runtime, view, button, rowMenuItems(), "row");
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
    for (let row = 0; row < map.height; row += 1) {
      const cellPos = tableStart + map.map[row * map.width];
      if (cellPos === lastRowCellPos) continue;
      lastRowCellPos = cellPos;
      const rowIndex = row;
      decorations.push(
        widgetDecoration(
          cellPos + 1,
          (view) => buildRowGrip(runtime, view, cellPos, rowIndex),
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
  const runtime = createTableControlsRuntime();
  let activeControls: ActiveTableControls | undefined;
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
          return false;
        },
        mouseleave(view) {
          activeControls = setActiveTableControls(view, null, activeControls);
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
          if (runtime.closeMenu && !view.state.doc.eq(prevState.doc)) {
            runtime.closeMenu();
            runtime.closeMenu = null;
          }
        },
        destroy() {
          runtime.cancelPointer?.();
          runtime.cancelPointer = null;
          runtime.closeMenu?.();
          runtime.closeMenu = null;
          runtime.activeDrag?.preview.remove();
          runtime.activeDrag = null;
          activeControls = undefined;
        },
      };
    },
  });
}
