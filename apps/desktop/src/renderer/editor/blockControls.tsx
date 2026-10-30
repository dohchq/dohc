import { mapWidgetOwners } from "./widgetOwnership";
import { isCodeBlockNode, isEditableEditor, stopEditorMouseEvent } from "./pmHelpers";
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { serializeRichdocBody } from "@dohc/ydoc-projection";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  ChevronDown,
  ClipboardCopy,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Quote,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  MENU_ACTIVE_OPTION,
  MENU_ACTIVE_OPTION_BESIDE_CURRENT,
  MENU_ENTER,
  MENU_FRAME,
  MENU_ICON,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_TONE,
  MENU_SECTION,
  MENU_SHORTCUT,
  deleteShortcut,
  menuEnterFrom,
  movedPointer,
  moveInMenu,
  revealMenuRow,
} from "../ui/Menu";
import { useDismiss } from "../ui/useDismiss";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";
import { escapeHighlightMarkdown } from "@dohc/ydoc-projection/markdown-extensions";

const blockControlsKey = new PluginKey("dohc-block-controls");

// ── drag payload ──────────────────────────────────────────────────────────

/** The ghost a plugin instance currently has parked on the document. One slot,
 * because it tracks a lifetime rather than a drag: every path that ends a
 * ghost's life — `dragend`, the next `dragstart`, and the plugin's destroy
 * after a workspace switch interrupts a drag — clears it through this slot. */
type DragGhostSlot = { current: HTMLElement | null };

function createDragGhost(blockDom: HTMLElement): HTMLElement {
  const ghost = blockDom.cloneNode(true) as HTMLElement;
  ghost
    .querySelectorAll(".dohc-block-affordance")
    .forEach((el) => el.remove());
  ghost.className = "dohc-block-drag-ghost";
  // The clone carries the block's text off-screen; without this a screen
  // reader reads it as a second copy of the block.
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${blockDom.offsetWidth}px`;
  blockDom.ownerDocument.body.append(ghost);
  return ghost;
}

/**
 * Populate `dataTransfer` and `view.dragging` for a block drag, mirroring
 * prosemirror-view's `handlers.dragstart`: serialize the slice for the
 * clipboard, set the html/plain payloads + `effectAllowed`, and hand the slice
 * to `view.dragging` with `move: true`. A NodeSelection is set on the block so
 * ProseMirror's native drop (which calls `tr.deleteSelection()` when a dragging
 * object without a `node` is moved) removes the source. Returns the ghost node
 * so the caller can park it in the plugin's ghost slot.
 */
function startBlockDrag(
  view: EditorView,
  pos: number,
  handle: HTMLElement,
  dataTransfer: DataTransfer,
): HTMLElement | null {
  const selection = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));

  const slice = selection.content();
  const { dom, text } = view.serializeForClipboard(slice);
  dataTransfer.clearData();
  dataTransfer.setData("text/html", dom.innerHTML);
  dataTransfer.setData("text/plain", text);
  dataTransfer.effectAllowed = "copyMove";

  let ghost: HTMLElement | null = null;
  const blockDom = view.nodeDOM(pos);
  if (blockDom instanceof HTMLElement) {
    ghost = createDragGhost(blockDom);
    dataTransfer.setDragImage(ghost, 12, 12);
  } else {
    dataTransfer.setDragImage(handle, 0, 0);
  }

  view.dragging = { slice, move: true };
  return ghost;
}

function removeBlockDragGhost(slot: DragGhostSlot): void {
  slot.current?.remove();
  slot.current = null;
}

/** What a top-level block hangs left of its text, into the gutter its
 * controls sit in. styles.css keeps the controls clear of it. */
function gutterHang(node: ProseMirrorNode): string | null {
  switch (node.type.name) {
    case "bulletList":
      return "bullet";
    case "orderedList":
      return "number";
    case "taskList":
      return "checkbox";
    case "blockquote":
      return "bar";
    case "callout":
      return "frame";
    case "table":
      return "table";
    default:
      return isCodeBlockNode(node) ? "frame" : null;
  }
}

function buildBlockControlDecorations(
  doc: ProseMirrorNode,
  onInsertRef: RefObject<(pos: number) => void>,
  onOpenMenuRef: RefObject<(pos: number, handle: HTMLElement) => void>,
  ghostSlot: DragGhostSlot,
  owners: Map<number, string>,
  nextOwnerKey: () => string,
): DecorationSet {
  const decorations: Decoration[] = [];

  // Only widgets: ProseMirror checks each node decoration against the
  // document with a scan from its first block, so one per block makes every
  // keystroke quadratic in the document's length.
  doc.forEach((node, pos) => {
    const ownerKey = owners.get(pos) ?? nextOwnerKey();
    const hang = gutterHang(node);
    // A numbered list hangs as many digits as its first number has.
    const digits = hang === "number" ? String(node.attrs.start ?? 1).length : 0;
    decorations.push(
      Decoration.widget(
        pos,
        (view, getPos) => {
          const wrap = document.createElement("span");
          wrap.className = "dohc-block-affordance";
          wrap.setAttribute("contenteditable", "false");
          if (hang) wrap.dataset.hang = hang;
          if (digits) wrap.style.setProperty("--dohc-block-digits", String(digits));

          const plus = document.createElement("button");
          plus.type = "button";
          plus.className = "dohc-block-gutter-btn dohc-block-plus";
          plus.title = "insert block";
          plus.setAttribute("aria-label", "insert block");
          plus.addEventListener("mousedown", stopEditorMouseEvent);
          plus.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            const currentPos = getPos();
            if (currentPos === undefined) return;
            onInsertRef.current(currentPos);
          });

          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = "dohc-block-gutter-btn dohc-block-handle";
          handle.title = "drag to move · click for actions";
          handle.setAttribute("aria-label", "block actions");
          handle.setAttribute("aria-haspopup", "menu");
          handle.setAttribute("aria-expanded", "false");
          handle.setAttribute("draggable", "true");
          // Only stop propagation (not preventDefault) so the native HTML5 drag
          // can still start — preventing the mousedown default cancels dragging.
          handle.addEventListener("mousedown", (event) => event.stopPropagation());

          handle.addEventListener("dragstart", (event) => {
            const dragEvent = event as DragEvent;
            dragEvent.stopPropagation();
            if (view.editable === false || !dragEvent.dataTransfer) {
              dragEvent.preventDefault();
              return;
            }
            const currentPos = getPos();
            if (currentPos === undefined) {
              dragEvent.preventDefault();
              return;
            }
            const node = view.state.doc.nodeAt(currentPos);
            if (!node) {
              dragEvent.preventDefault();
              return;
            }
            // Whatever the slot still holds can no longer be reached: parking
            // a new ghost over it would strand the old one on `document.body`.
            removeBlockDragGhost(ghostSlot);
            ghostSlot.current = startBlockDrag(
              view,
              currentPos,
              handle,
              dragEvent.dataTransfer,
            );
          });
          handle.addEventListener("dragend", () =>
            removeBlockDragGhost(ghostSlot),
          );

          handle.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            const currentPos = getPos();
            if (currentPos === undefined) return;
            if (view.state.doc.nodeAt(currentPos)) {
              view.dispatch(
                view.state.tr.setSelection(
                  NodeSelection.create(view.state.doc, currentPos),
                ),
              );
            }
            onOpenMenuRef.current(currentPos, handle);
          });

          wrap.append(plus, handle);
          return wrap;
        },
        // A block that changes kind or digits gets new controls, with its hang.
        { side: -1, key: `dohc-block-controls-${ownerKey}-${hang}-${digits}`, ownerKey },
      ),
    );
  });

  // Each widget sits on the boundary before its block, inside no block.
  // Built against the full document, ProseMirror checks every widget against
  // every block, so each Enter cost time quadratic in the document's length.
  // The document without its blocks gives the same set.
  return DecorationSet.create(doc.copy(Fragment.empty), decorations);
}

/**
 * A text-only replacement cannot change the set or kind of top-level blocks.
 * Keeping the persistent decoration tree and mapping its positions avoids
 * rebuilding a widget for every block while typing. Structural edits,
 * node replacements, and multi-step transactions still take the
 * full rebuild path below.
 */
function isSingleTextblockReplacement(
  tr: Transaction,
): boolean {
  if (tr.steps.length !== 1) return false;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return false;
  if (step.slice.openStart !== 0 || step.slice.openEnd !== 0) return false;
  for (let index = 0; index < step.slice.content.childCount; index++) {
    if (!step.slice.content.child(index).isText) return false;
  }
  const from = tr.before.resolve(step.from);
  const to = tr.before.resolve(step.to);
  return from.depth === 1 && from.sameParent(to) && from.parent.isTextblock;
}

/** The gutter of the top-level block that holds `target`. A block's gutter is
 * the nearest gutter widget before the block's element, with nothing but
 * other widgets between them. Another widget, such as a Mermaid preview,
 * belongs to no block. */
function blockControlAt(
  view: EditorView,
  target: EventTarget | null,
): HTMLElement | null {
  let element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  while (element && element.parentElement !== view.dom) {
    element = element.parentElement;
  }
  if (!(element instanceof HTMLElement)) return null;
  if (element.classList.contains("ProseMirror-widget")) {
    return element.classList.contains("dohc-block-affordance") ? element : null;
  }
  for (
    let sibling = element.previousElementSibling;
    sibling instanceof HTMLElement && sibling.classList.contains("ProseMirror-widget");
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.classList.contains("dohc-block-affordance")) return sibling;
  }
  return null;
}

/** Delete a whole top-level block after it has been selected from its gutter.
 * Text selections and nested node selections keep ProseMirror's native
 * behavior, so Backspace inside code/table content never destroys the parent
 * block accidentally. */
export function deleteSelectedTopLevelBlock(view: EditorView): boolean {
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return false;
  if (state.doc.resolve(selection.from).depth !== 0) return false;

  view.dispatch(state.tr.deleteSelection().scrollIntoView());
  view.focus();
  return true;
}

export function makeBlockControlsPlugin({
  onInsertRef,
  onOpenMenuRef,
}: {
  onInsertRef: RefObject<(pos: number) => void>;
  onOpenMenuRef: RefObject<(pos: number, handle: HTMLElement) => void>;
}) {
  let visibleControl: HTMLElement | null = null;
  const showBlockControl = (control: HTMLElement | null) => {
    if (control === visibleControl) return;
    visibleControl?.classList.remove("is-visible");
    control?.classList.add("is-visible");
    visibleControl = control;
  };
  const ghostSlot: DragGhostSlot = { current: null };
  let nextId = 0;
  const nextOwnerKey = () => String(nextId++);
  return new Plugin({
    key: blockControlsKey,
    state: {
      init(_, instance) {
        return buildBlockControlDecorations(
          instance.doc,
          onInsertRef,
          onOpenMenuRef,
          ghostSlot,
          new Map(),
          nextOwnerKey,
        );
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        if (isSingleTextblockReplacement(tr)) {
          return tr.doc.content.size === tr.before.content.size
            ? old
            : old.map(tr.mapping, tr.doc);
        }
        return buildBlockControlDecorations(
          tr.doc,
          onInsertRef,
          onOpenMenuRef,
          ghostSlot,
          mapWidgetOwners(old, tr.mapping),
          nextOwnerKey,
        );
      },
    },
    view() {
      return {
        destroy() {
          removeBlockDragGhost(ghostSlot);
        },
      };
    },
    props: {
      decorations(state) {
        return blockControlsKey.getState(state) as DecorationSet | undefined;
      },
      handleDOMEvents: {
        mousemove(view, event) {
          showBlockControl(blockControlAt(view, event.target));
          return false;
        },
        mouseleave() {
          showBlockControl(null);
          return false;
        },
      },
      handleKeyDown(view, event) {
        if (event.key !== "Backspace" && event.key !== "Delete") return false;
        if (!deleteSelectedTopLevelBlock(view)) return false;
        event.preventDefault();
        return true;
      },
    },
  });
}

export function insertBlockAfter(
  editor: Editor | null,
  pos: number,
  openSlashMenuAtPosition: (pos: number) => void,
): void {
  const view = editor?.view;
  if (!view || !isEditableEditor(editor)) return;

  const { state } = view;
  const node = state.doc.nodeAt(pos);
  const paragraph = state.schema.nodes.paragraph;
  if (!node || !paragraph) return;

  const canReuseEmptyParagraph =
    node.type.name === "paragraph" && node.textContent.length === 0;
  const selectionPos = canReuseEmptyParagraph ? pos + 1 : pos + node.nodeSize + 1;
  const tr = canReuseEmptyParagraph
    ? state.tr
    : state.tr.insert(pos + node.nodeSize, paragraph.create());
  tr
    .setSelection(TextSelection.near(tr.doc.resolve(selectionPos)))
    .scrollIntoView();
  view.dispatch(tr);
  view.focus();
  openSlashMenuAtPosition(selectionPos);
}

// ── block context menu ─────────────────────────────────────────────────────

export type BlockMenuTurnIntoId =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bulleted-list"
  | "numbered-list"
  | "task-list"
  | "quote";

type BlockMenuActionId = "duplicate" | "copy-markdown" | "delete";

export type BlockMenuEntry =
  | { kind: "turn-into"; id: BlockMenuTurnIntoId; label: string; icon: LucideIcon }
  | { kind: "action"; id: BlockMenuActionId; label: string; icon: LucideIcon };

export type BlockMenuState =
  | { open: false }
  | {
      open: true;
      pos: number;
      x: number;
      y: number;
      maxHeight: number;
      placement: FloatingMenuPlacement;
      /** The handle that opened the menu, where focus goes back. */
      trigger?: HTMLElement | null;
    };

export const CLOSED_BLOCK_MENU_STATE: BlockMenuState = { open: false };

// Exported so the bubble menu's turn-into dropdown (below) can share the
// exact same entry list/order/labels the block context menu uses, instead of
// keeping a second copy that could drift.
export const TURN_INTO_ENTRIES: BlockMenuEntry[] = [
  { kind: "turn-into", id: "paragraph", label: "Text", icon: Pilcrow },
  { kind: "turn-into", id: "heading-1", label: "Heading 1", icon: Heading1 },
  { kind: "turn-into", id: "heading-2", label: "Heading 2", icon: Heading2 },
  { kind: "turn-into", id: "heading-3", label: "Heading 3", icon: Heading3 },
  { kind: "turn-into", id: "bulleted-list", label: "Bulleted list", icon: List },
  { kind: "turn-into", id: "numbered-list", label: "Numbered list", icon: ListOrdered },
  { kind: "turn-into", id: "task-list", label: "Todo list", icon: ListTodo },
  { kind: "turn-into", id: "quote", label: "Quote", icon: Quote },
];

const ACTION_ENTRIES: BlockMenuEntry[] = [
  { kind: "action", id: "duplicate", label: "Duplicate", icon: Copy },
  { kind: "action", id: "copy-markdown", label: "Copy as markdown", icon: ClipboardCopy },
  { kind: "action", id: "delete", label: "Delete", icon: X },
];

const BLOCK_MENU_ENTRIES: BlockMenuEntry[] = [
  ...TURN_INTO_ENTRIES,
  ...ACTION_ENTRIES,
];

const TURN_INTO_COUNT = TURN_INTO_ENTRIES.length;

export function resolveBlockMenuState(pos: number, trigger: HTMLElement): BlockMenuState {
  const rect = trigger.getBoundingClientRect();
  const position = resolveFloatingMenuPosition({
    cursorRect: { left: rect.right + 6, top: rect.top, bottom: rect.bottom },
    menuWidth: 240,
    menuMaxHeight: FLOATING_MENU_MAX_HEIGHT,
  });
  return {
    open: true,
    pos,
    x: position.x,
    y: position.y,
    maxHeight: position.maxHeight,
    placement: position.placement,
    trigger,
  };
}

export function duplicateBlock(editor: Editor | null, pos: number): void {
  const view = editor?.view;
  if (!view || !isEditableEditor(editor)) return;
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  const insertPos = pos + node.nodeSize;
  const tr = state.tr.insert(insertPos, node);
  if (NodeSelection.isSelectable(node)) {
    tr.setSelection(NodeSelection.create(tr.doc, insertPos));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function deleteBlock(editor: Editor | null, pos: number): void {
  const view = editor?.view;
  if (!view || !isEditableEditor(editor)) return;
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
}

export function turnBlockInto(
  editor: Editor | null,
  pos: number,
  id: BlockMenuTurnIntoId,
): void {
  const view = editor?.view;
  if (!editor || !view || !isEditableEditor(editor)) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;

  const inside = pos + 1;
  const chain = editor.chain().focus().setTextSelection(inside);

  switch (id) {
    case "paragraph":
      chain.setParagraph().run();
      return;
    case "heading-1":
      chain.toggleHeading({ level: 1 }).run();
      return;
    case "heading-2":
      chain.toggleHeading({ level: 2 }).run();
      return;
    case "heading-3":
      chain.toggleHeading({ level: 3 }).run();
      return;
    case "bulleted-list":
      chain.toggleBulletList().run();
      return;
    case "numbered-list":
      chain.toggleOrderedList().run();
      return;
    case "task-list":
      chain.toggleTaskList().run();
      return;
    case "quote":
      chain.toggleBlockquote().run();
      return;
  }
}

/**
 * The top-level block position (the same "pos" the block gutter/context menu
 * operate on) containing the current selection, or null when there isn't one
 * (e.g. no editor, or a selection somehow at doc depth). `$from.before(1)` is
 * the position just before the depth-1 ancestor regardless of how deep the
 * selection actually sits (list item, table cell, ...), matching the "act on
 * the enclosing top-level block" semantics the block menu already has.
 */
export function topLevelBlockPos(editor: Editor | null): number | null {
  const view = editor?.view;
  if (!view) return null;
  const { $from } = view.state.selection;
  if ($from.depth < 1) return null;
  return $from.before(1);
}

/**
 * Which turn-into entry describes the block a position sits in — the bubble
 * menu's turn-into label, for the selection's start, which is the block
 * `turnBlockInto` converts. It reads only the position's ancestors, so it
 * costs the same anywhere in a document. Headings win over lists, and lists
 * over quotes, as in the block menu.
 */
export function turnIntoIdAt($pos: ResolvedPos): BlockMenuTurnIntoId {
  const ancestors = new Set<string>();
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "heading") {
      const level = node.attrs.level;
      if (level === 1) return "heading-1";
      if (level === 2) return "heading-2";
      if (level === 3) return "heading-3";
    }
    ancestors.add(node.type.name);
  }
  if (ancestors.has("bulletList")) return "bulleted-list";
  if (ancestors.has("orderedList")) return "numbered-list";
  if (ancestors.has("taskList")) return "task-list";
  if (ancestors.has("blockquote")) return "quote";
  return "paragraph";
}

/** Serialize one block through the shared projection contract. */
export function serializeBlockToMarkdown(node: ProseMirrorNode): string {
  return serializeRichdocBody(
    escapeHighlightMarkdown({ type: "doc", content: [node.toJSON()] }),
  );
}

async function writeClipboardText(text: string): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    await navigator.clipboard.writeText(text);
  }
}

export async function copyBlockAsMarkdown(
  editor: Editor | null,
  pos: number,
): Promise<void> {
  if (!editor) return;
  const node = editor.view.state.doc.nodeAt(pos);
  if (!node) return;
  await writeClipboardText(serializeBlockToMarkdown(node));
}

// The block handle's menu, drawn from the Menu part's recipe. ProseMirror
// owns the handle, so this cannot be the Menu component; it closes by the
// same rule (useDismiss) and moves by the same keys (moveInMenu). Focus stays
// on the frame and aria-activedescendant names the active row, which takes
// the selected fill whichever of the keyboard or the pointer moved it there.
export function BlockMenu({
  state,
  onSelect,
  onClose,
}: {
  state: BlockMenuState;
  onSelect: (entry: BlockMenuEntry) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Held directly: the editor can sit in a shadow root, where a document
  // lookup by id finds nothing.
  const rowElements = useRef<Array<HTMLButtonElement | null>>([]);
  // Kept after the menu closes: a press on blank space returns focus to the
  // handle when the press ends, which is after the close.
  const trigger = useRef<HTMLElement | null>(null);
  if (state.open) trigger.current = state.trigger ?? null;
  const id = useId();
  const [active, setActive] = useState(0);
  const open = state.open;
  const pos = state.open ? state.pos : -1;
  useDismiss({ open, container: menuRef, trigger, onClose });

  useEffect(() => {
    if (!open) return;
    setActive(0);
    menuRef.current?.focus({ preventScroll: true });
    const handle = trigger.current;
    handle?.setAttribute("aria-expanded", "true");
    return () => handle?.setAttribute("aria-expanded", "false");
  }, [open, pos]);

  const rowId = (index: number) => `${id}-row-${index}`;
  // The list is taller than its cap, so the active row is scrolled into it
  // whenever it changes. The first row of a section brings its label along.
  useLayoutEffect(() => {
    const list = menuRef.current;
    if (!open || !list) return;
    const activeRow = rowElements.current[active];
    const firstOfSection = active === 0 || active === TURN_INTO_COUNT;
    revealMenuRow(list, activeRow, firstOfSection ? activeRow?.parentElement : activeRow);
  }, [open, active]);

  if (!state.open) return null;

  const shortcut = deleteShortcut();
  const labels = BLOCK_MENU_ENTRIES.map((entry) => entry.label);
  // Focus goes back to the handle first, as the Menu part does, and the
  // action then moves it into the document when it edits one.
  const pick = (entry: BlockMenuEntry) => {
    trigger.current?.focus({ preventScroll: true });
    onSelect(entry);
  };
  const row = (entry: BlockMenuEntry, index: number) => {
    const danger = entry.kind === "action" && entry.id === "delete";
    const Icon = entry.icon;
    return (
      <button
        key={`${entry.kind}-${entry.id}`}
        id={rowId(index)}
        ref={(element) => {
          rowElements.current[index] = element;
        }}
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-active={index === active || undefined}
        aria-keyshortcuts={danger ? shortcut.keys : undefined}
        onMouseMove={(event) => {
          // Only a pointer that moves picks the active row, so a menu that
          // opens under a still pointer keeps its first row.
          if (movedPointer(event) && index !== active) setActive(index);
        }}
        onClick={() => pick(entry)}
        className={`${MENU_ROW} ${MENU_ACTIVE_OPTION} ${danger ? MENU_ROW_TONE.danger : `${MENU_ROW_TONE.rest} data-active:text-ink`}`}
      >
        <span className={`${MENU_ICON} ${danger ? "" : "text-subtle"}`}>
          <Icon size={14} aria-hidden />
        </span>
        <span className={MENU_LABEL}>{entry.label}</span>
        {danger ? (
          <span aria-hidden className={MENU_SHORTCUT}>
            {shortcut.label}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      ref={menuRef}
      // The frame holds focus for its rows, and the active row draws the
      // focus outline, so the frame draws none of its own.
      className={`dohc-block-menu ${MENU_FRAME} ${MENU_ENTER} outline-none`}
      role="menu"
      aria-label="block actions"
      aria-activedescendant={rowId(active)}
      tabIndex={-1}
      data-placement={state.placement}
      style={{ left: state.x, top: state.y, maxHeight: state.maxHeight, ...menuEnterFrom(state.placement) }}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const next = moveInMenu(event, active, labels);
        if (next !== null) {
          event.preventDefault();
          setActive(next);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pick(BLOCK_MENU_ENTRIES[active] ?? BLOCK_MENU_ENTRIES[0]);
        } else if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          const deleteEntry = ACTION_ENTRIES.find(
            (entry) => entry.kind === "action" && entry.id === "delete",
          );
          if (deleteEntry) pick(deleteEntry);
        } else if (event.key === "Escape") {
          // useDismiss closed it; one Escape closes one surface.
          event.stopPropagation();
        } else if (event.key === "Tab") {
          // Closed without moving focus, so the key goes where it would.
          onClose();
        }
      }}
    >
      <div role="group" aria-labelledby={`${id}-turn-into`}>
        <div id={`${id}-turn-into`} className={MENU_SECTION}>
          Turn into
        </div>
        {TURN_INTO_ENTRIES.map((entry, index) => row(entry, index))}
      </div>
      <div role="group" aria-labelledby={`${id}-actions`}>
        <div id={`${id}-actions`} className={MENU_SECTION}>
          Actions
        </div>
        {ACTION_ENTRIES.map((entry, index) => row(entry, TURN_INTO_COUNT + index))}
      </div>
    </div>
  );
}

// ── bubble menu turn-into dropdown ─────────────────────────────────────────

// Width of .dohc-turn-into-menu (styles.css); only used for the shared
// floating-menu math's horizontal clamp, the dropdown itself stays anchored.
const TURN_INTO_MENU_WIDTH = 190;

type TurnIntoDropdownPosition = {
  placement: FloatingMenuPlacement;
  maxHeight: number;
};

/**
 * Flip side + viewport-fitted max height for the bubble menu's turn-into
 * dropdown. Unlike the other editor popovers this one stays anchored to its
 * trigger with position: absolute — the bubble menu is appended inside.
 * Dohc-editor-surface, whose container-type makes it the containing block
 * for fixed descendants, so position: fixed viewport coordinates would be
 * re-based onto the pane (see the .dohc-editor-surface comment in
 * styles.css). Only placement/maxHeight from the shared floating-menu math
 * apply; x/y remain the anchor's.
 */
export function resolveTurnIntoDropdown(
  triggerRect: { left: number; top: number; bottom: number },
  viewport?: { width: number; height: number },
): TurnIntoDropdownPosition {
  const { placement, maxHeight } = resolveFloatingMenuPosition({
    cursorRect: triggerRect,
    menuWidth: TURN_INTO_MENU_WIDTH,
    ...(viewport
      ? { viewportWidth: viewport.width, viewportHeight: viewport.height }
      : {}),
  });
  return { placement, maxHeight };
}

/**
 * Compact "current block type" button + dropdown at the left of the bubble
 * menu (MarkdownEditor.tsx). Reuses TURN_INTO_ENTRIES/turnBlockInto —
 * exactly the block context menu's "Turn into" section — so the labels,
 * order, and conversion behavior stay identical between the two entry
 * points; only the trigger and layout differ.
 *
 * The dropdown is a listbox drawn from the Menu part's recipe. It holds focus
 * for its options and names the active one with aria-activedescendant; that
 * option takes the selected fill and, while the keyboard moves, the row's
 * accent line. The block's current type keeps the selected fill.
 */
export function TurnIntoMenu({
  editor,
  activeId,
}: {
  editor: Editor;
  // The selection toolbar reads this from the editor's state.
  activeId: BlockMenuTurnIntoId;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dropdown, setDropdown] = useState<TurnIntoDropdownPosition>({
    placement: "below",
    maxHeight: FLOATING_MENU_MAX_HEIGHT,
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const optionId = (index: number) => `${id}-option-${index}`;

  const activeIndex = TURN_INTO_ENTRIES.findIndex((entry) => entry.id === activeId);
  const activeEntry = TURN_INTO_ENTRIES[activeIndex] ?? TURN_INTO_ENTRIES[0]!;

  useEffect(() => {
    if (!open) return;
    setSelected(activeIndex >= 0 ? activeIndex : 0);
    menuRef.current?.focus({ preventScroll: true });
    // Only reset when the dropdown opens, not on every editor selection tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Only the list scrolls to show the active option.
  useLayoutEffect(() => {
    const list = menuRef.current;
    if (open && list) revealMenuRow(list, optionRefs.current[selected]);
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const container = containerRef.current;
      if (container && event.composedPath().includes(container)) return;
      setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown, true);
    return () => window.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  if (!isEditableEditor(editor)) return null;

  const labels = TURN_INTO_ENTRIES.map((entry) => entry.label);

  // Measure once, at open — the dropdown is anchored to the trigger, so it
  // never repositions while open; only the flip side and max height are
  // resolved here (offscreen/jsdom rects fall back to below/full height).
  const openMenu = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setDropdown(resolveTurnIntoDropdown(rect));
    setOpen(true);
  };

  const select = (entry: BlockMenuEntry) => {
    setOpen(false);
    const pos = topLevelBlockPos(editor);
    if (pos == null || entry.kind !== "turn-into") return;
    turnBlockInto(editor, pos, entry.id);
  };

  return (
    <div className="dohc-turn-into" ref={containerRef}>
      <button
        type="button"
        className="dohc-turn-into__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Turn into"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="dohc-turn-into__label">{activeEntry.label}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open ? (
        <div
          ref={menuRef}
          // The frame holds focus for its options, and the active option
          // draws the focus outline, so the frame draws none of its own.
          className={`dohc-turn-into-menu ${MENU_FRAME} ${MENU_ENTER} outline-none`}
          role="listbox"
          aria-label="turn into"
          aria-activedescendant={optionId(selected)}
          tabIndex={-1}
          data-placement={dropdown.placement}
          style={{ maxHeight: dropdown.maxHeight, ...menuEnterFrom(dropdown.placement) }}
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            const next = moveInMenu(event, selected, labels);
            if (next !== null) {
              event.preventDefault();
              setSelected(next);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              select(TURN_INTO_ENTRIES[selected] ?? TURN_INTO_ENTRIES[0]!);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              // The listbox held DOM focus; without this, dismissing leaves
              // focus on a removed node and the keyboard goes dead.
              editor.commands.focus();
            }
          }}
        >
          {TURN_INTO_ENTRIES.map((entry, index) => {
            const Icon = entry.icon;
            const current = entry.id === activeId;
            return (
              <button
                key={entry.id}
                id={optionId(index)}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                data-active={index === selected || undefined}
                className={`${MENU_ROW} ${MENU_ACTIVE_OPTION_BESIDE_CURRENT} ${
                  current ? MENU_ROW_TONE.current : `${MENU_ROW_TONE.rest} data-active:text-ink`
                }`}
                // Only a pointer that moves picks the active option, so a
                // list that opens under a still pointer keeps the block's own.
                onMouseMove={(event) => {
                  if (movedPointer(event) && index !== selected) setSelected(index);
                }}
                onClick={() => select(entry)}
              >
                <span className={`${MENU_ICON} text-subtle`}>
                  <Icon size={14} aria-hidden />
                </span>
                <span className={MENU_LABEL}>{entry.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
