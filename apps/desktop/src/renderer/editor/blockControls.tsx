import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ChevronDown } from "lucide-react";
import {
  FLOATING_MENU_MAX_HEIGHT,
  resolveFloatingMenuPosition,
  type FloatingMenuPlacement,
} from "./floatingMenuPosition";
import { escapeHighlightMarkdown } from "./extensions";

type TopLevelDocLike = {
  forEach: (
    cb: (
      node: {
        type: { name: string };
        attrs?: Record<string, unknown>;
        nodeSize: number;
        textContent?: string;
      },
      offset: number,
      index: number,
    ) => void,
  ) => void;
};

const blockControlsKey = new PluginKey("dohc-block-controls");

function isEditableEditor(editor: Editor | null | undefined): boolean {
  if (!editor) return false;
  if ((editor as { isEditable?: boolean }).isEditable === false) return false;
  if ((editor.view as { editable?: boolean }).editable === false) return false;
  return true;
}

function isEditableView(view: EditorView): boolean {
  return (view as { editable?: boolean }).editable !== false;
}

function stopEditorMouseEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

// ── drag payload ──────────────────────────────────────────────────────────

/**
 * The slice that a top-level block at `pos` contributes to a drag. Mirrors what
 * ProseMirror's own draggable-node dragstart uses: `NodeSelection.content()`,
 * i.e. a slice whose single child is the block node (openStart/openEnd 0).
 * Factored out so the drag payload can be unit-tested without a real DnD event.
 */
export function blockDragSlice(view: EditorView, pos: number): Slice | null {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return null;
  return NodeSelection.create(view.state.doc, pos).content();
}

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

function buildBlockControlDecorations(
  doc: unknown,
  onInsertRef: RefObject<(pos: number) => void>,
  onOpenMenuRef: RefObject<(pos: number, rect: DOMRect) => void>,
  ghostSlot: DragGhostSlot,
): DecorationSet {
  const decorations: Decoration[] = [];

  (doc as TopLevelDocLike).forEach((node, offset, index) => {
    const pos = offset;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: "dohc-block-node",
        "data-dohc-block-index": String(index),
      }),
    );
    decorations.push(
      Decoration.widget(
        pos,
        (view) => {
          const wrap = document.createElement("span");
          wrap.className = "dohc-block-affordance";
          wrap.setAttribute("data-dohc-block-index", String(index));
          wrap.setAttribute("contenteditable", "false");

          const plus = document.createElement("button");
          plus.type = "button";
          plus.className = "dohc-block-gutter-btn dohc-block-plus";
          plus.title = "insert block";
          plus.setAttribute("aria-label", "insert block");
          plus.addEventListener("mousedown", stopEditorMouseEvent);
          plus.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            onInsertRef.current(pos);
          });

          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = "dohc-block-gutter-btn dohc-block-handle";
          handle.title = "drag to move · click for actions";
          handle.setAttribute("aria-label", "block actions");
          handle.setAttribute("draggable", "true");
          // Only stop propagation (not preventDefault) so the native HTML5 drag
          // can still start — preventing the mousedown default cancels dragging.
          handle.addEventListener("mousedown", (event) => event.stopPropagation());

          handle.addEventListener("dragstart", (event) => {
            const dragEvent = event as DragEvent;
            dragEvent.stopPropagation();
            if (!isEditableView(view) || !dragEvent.dataTransfer) {
              dragEvent.preventDefault();
              return;
            }
            const node = view.state.doc.nodeAt(pos);
            if (!node) {
              dragEvent.preventDefault();
              return;
            }
            // Whatever the slot still holds can no longer be reached: parking
            // a new ghost over it would strand the old one on `document.body`.
            removeBlockDragGhost(ghostSlot);
            ghostSlot.current = startBlockDrag(
              view,
              pos,
              handle,
              dragEvent.dataTransfer,
            );
          });
          handle.addEventListener("dragend", () =>
            removeBlockDragGhost(ghostSlot),
          );

          handle.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            if (view.state.doc.nodeAt(pos)) {
              view.dispatch(
                view.state.tr.setSelection(
                  NodeSelection.create(view.state.doc, pos),
                ),
              );
            }
            onOpenMenuRef.current(pos, handle.getBoundingClientRect());
          });

          wrap.append(plus, handle);
          return wrap;
        },
        { side: -1, key: `dohc-block-controls-${index}-${pos}` },
      ),
    );
  });

  return DecorationSet.create(doc as never, decorations);
}

function setVisibleBlockControl(
  view: EditorView,
  target: EventTarget | null,
  previousIndex: string | null | undefined,
): string | null {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  const owner = element?.closest<HTMLElement>("[data-dohc-block-index]");
  const activeIndex = owner?.dataset.dohcBlockIndex ?? null;
  if (activeIndex === previousIndex) return activeIndex;

  view.dom
    .querySelectorAll<HTMLElement>(".dohc-block-affordance")
    .forEach((control) => {
      control.classList.toggle(
        "is-visible",
        activeIndex !== null && control.dataset.dohcBlockIndex === activeIndex,
      );
    });
  return activeIndex;
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
  onOpenMenuRef: RefObject<(pos: number, rect: DOMRect) => void>;
}) {
  let activeBlockIndex: string | null | undefined;
  const ghostSlot: DragGhostSlot = { current: null };
  return new Plugin({
    key: blockControlsKey,
    state: {
      init(_, instance) {
        return buildBlockControlDecorations(
          instance.doc,
          onInsertRef,
          onOpenMenuRef,
          ghostSlot,
        );
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        activeBlockIndex = undefined;
        return buildBlockControlDecorations(
          tr.doc,
          onInsertRef,
          onOpenMenuRef,
          ghostSlot,
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
          activeBlockIndex = setVisibleBlockControl(
            view,
            event.target,
            activeBlockIndex,
          );
          return false;
        },
        mouseleave(view) {
          activeBlockIndex = setVisibleBlockControl(view, null, activeBlockIndex);
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

export function selectBlock(editor: Editor | null, pos: number): void {
  const view = editor?.view;
  if (!view) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(
    view.state.tr
      .setSelection(NodeSelection.create(view.state.doc, pos))
      .scrollIntoView(),
  );
  view.focus();
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

export type BlockMenuActionId = "duplicate" | "copy-markdown" | "delete";

export type BlockMenuEntry =
  | { kind: "turn-into"; id: BlockMenuTurnIntoId; label: string; glyph: string }
  | { kind: "action"; id: BlockMenuActionId; label: string; glyph: string };

export type BlockMenuState =
  | { open: false }
  | {
      open: true;
      pos: number;
      x: number;
      y: number;
      maxHeight: number;
      placement: FloatingMenuPlacement;
    };

export const CLOSED_BLOCK_MENU_STATE: BlockMenuState = { open: false };

// Exported so the bubble menu's turn-into dropdown (below) can share the
// exact same entry list/order/labels the block context menu uses, instead of
// keeping a second copy that could drift.
export const TURN_INTO_ENTRIES: BlockMenuEntry[] = [
  { kind: "turn-into", id: "paragraph", label: "Text", glyph: "¶" },
  { kind: "turn-into", id: "heading-1", label: "Heading 1", glyph: "H1" },
  { kind: "turn-into", id: "heading-2", label: "Heading 2", glyph: "H2" },
  { kind: "turn-into", id: "heading-3", label: "Heading 3", glyph: "H3" },
  { kind: "turn-into", id: "bulleted-list", label: "Bulleted list", glyph: "-" },
  { kind: "turn-into", id: "numbered-list", label: "Numbered list", glyph: "1." },
  { kind: "turn-into", id: "task-list", label: "Todo list", glyph: "[]" },
  { kind: "turn-into", id: "quote", label: "Quote", glyph: ">" },
];

const ACTION_ENTRIES: BlockMenuEntry[] = [
  { kind: "action", id: "duplicate", label: "Duplicate", glyph: "⧉" },
  { kind: "action", id: "copy-markdown", label: "Copy as markdown", glyph: "md" },
  { kind: "action", id: "delete", label: "Delete", glyph: "✕" },
];

export const BLOCK_MENU_ENTRIES: BlockMenuEntry[] = [
  ...TURN_INTO_ENTRIES,
  ...ACTION_ENTRIES,
];

const TURN_INTO_COUNT = TURN_INTO_ENTRIES.length;

export function resolveBlockMenuState(pos: number, rect: DOMRect): BlockMenuState {
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
  };
}

type BlockTurnIntoChain = {
  focus: () => BlockTurnIntoChain;
  setTextSelection: (pos: number) => BlockTurnIntoChain;
  setParagraph: () => BlockTurnIntoChain;
  toggleHeading: (attrs: { level: 1 | 2 | 3 }) => BlockTurnIntoChain;
  toggleBulletList: () => BlockTurnIntoChain;
  toggleOrderedList: () => BlockTurnIntoChain;
  toggleTaskList: () => BlockTurnIntoChain;
  toggleBlockquote: () => BlockTurnIntoChain;
  run: () => boolean;
};

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
  const chain = editor
    .chain()
    .focus()
    .setTextSelection(inside) as unknown as BlockTurnIntoChain;

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
 * Which turn-into entry describes the block the selection currently sits in
 * — drives the bubble menu's turn-into button label/highlight. Mirrors the
 * same node-type checks `isBlockControlTarget` and `turnBlockInto` use.
 */
export function activeTurnIntoId(editor: Editor | null): BlockMenuTurnIntoId {
  if (!editor) return "paragraph";
  if (editor.isActive("heading", { level: 1 })) return "heading-1";
  if (editor.isActive("heading", { level: 2 })) return "heading-2";
  if (editor.isActive("heading", { level: 3 })) return "heading-3";
  if (editor.isActive("bulletList")) return "bulleted-list";
  if (editor.isActive("orderedList")) return "numbered-list";
  if (editor.isActive("taskList")) return "task-list";
  if (editor.isActive("blockquote")) return "quote";
  return "paragraph";
}

/**
 * Serialize a single block node to markdown via the editor's markdown storage.
 * Wraps the node in a minimal `doc` so the manager serializes it the same way
 * `editor.getMarkdown()` serializes the whole document.
 */
export function serializeBlockToMarkdown(
  editor: Editor,
  node: ProseMirrorNode,
): string {
  const manager = editor.storage.markdown?.manager;
  if (!manager) return node.textContent;
  return manager.serialize(
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
  await writeClipboardText(serializeBlockToMarkdown(editor, node));
}

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
  const [selected, setSelected] = useState(0);
  const open = state.open;
  const pos = state.open ? state.pos : -1;

  useEffect(() => {
    if (!open) return;
    setSelected(0);
    menuRef.current?.focus();
  }, [open, pos]);

  if (!state.open) return null;

  const move = (delta: number) =>
    setSelected(
      (current) =>
        (current + delta + BLOCK_MENU_ENTRIES.length) % BLOCK_MENU_ENTRIES.length,
    );

  return (
    <>
      <div
        className="dohc-block-menu-backdrop"
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <div
        ref={menuRef}
        className="dohc-block-menu"
        role="menu"
        aria-label="block actions"
        tabIndex={-1}
        data-placement={state.placement}
        style={{ left: state.x, top: state.y, maxHeight: state.maxHeight }}
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            onSelect(BLOCK_MENU_ENTRIES[selected] ?? BLOCK_MENU_ENTRIES[0]);
          } else if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            const deleteEntry = ACTION_ENTRIES.find(
              (entry) => entry.kind === "action" && entry.id === "delete",
            );
            if (deleteEntry) onSelect(deleteEntry);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        {BLOCK_MENU_ENTRIES.map((entry, index) => (
          <Fragment key={`${entry.kind}-${entry.id}`}>
            {index === 0 ? (
              <div className="dohc-block-menu__section">Turn into</div>
            ) : null}
            {index === TURN_INTO_COUNT ? (
              <div className="dohc-block-menu__section">Actions</div>
            ) : null}
            <button
              type="button"
              role="menuitem"
              aria-selected={index === selected}
              className={`dohc-block-menu__item${
                index === selected ? " is-selected" : ""
              }${entry.kind === "action" && entry.id === "delete" ? " is-danger" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => onSelect(entry)}
            >
              <span className="dohc-block-menu__glyph">{entry.glyph}</span>
              <span className="dohc-block-menu__label">{entry.label}</span>
            </button>
          </Fragment>
        ))}
      </div>
    </>
  );
}

// ── bubble menu turn-into dropdown ─────────────────────────────────────────

// Width of .dohc-turn-into-menu (styles.css); only used for the shared
// floating-menu math's horizontal clamp, the dropdown itself stays anchored.
const TURN_INTO_MENU_WIDTH = 190;

export type TurnIntoDropdownPosition = {
  placement: FloatingMenuPlacement;
  maxHeight: number;
};

/**
 * Flip side + viewport-fitted max height for the bubble menu's turn-into
 * dropdown. Unlike the other editor popovers this one stays ANCHORED to its
 * trigger with position: absolute — the bubble menu is appended inside
 * .dohc-editor-surface, whose container-type makes it the containing block
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
 */
export function TurnIntoMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dropdown, setDropdown] = useState<TurnIntoDropdownPosition>({
    placement: "below",
    maxHeight: FLOATING_MENU_MAX_HEIGHT,
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const activeId = activeTurnIntoId(editor);
  const activeIndex = TURN_INTO_ENTRIES.findIndex((entry) => entry.id === activeId);
  const activeEntry = TURN_INTO_ENTRIES[activeIndex] ?? TURN_INTO_ENTRIES[0]!;

  useEffect(() => {
    if (!open) return;
    setSelected(activeIndex >= 0 ? activeIndex : 0);
    menuRef.current?.focus();
    // Only reset when the dropdown opens, not on every editor selection tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const move = (delta: number) =>
    setSelected(
      (current) =>
        (current + delta + TURN_INTO_ENTRIES.length) % TURN_INTO_ENTRIES.length,
    );

  // Measure ONCE, at open — the dropdown is anchored to the trigger, so it
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
          className="dohc-turn-into-menu"
          role="listbox"
          aria-label="turn into"
          tabIndex={-1}
          data-placement={dropdown.placement}
          style={{ maxHeight: dropdown.maxHeight }}
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
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
          {TURN_INTO_ENTRIES.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={`dohc-turn-into-menu__item${
                index === selected ? " is-selected" : ""
              }`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => select(entry)}
            >
              <span className="dohc-turn-into-menu__glyph">{entry.glyph}</span>
              <span className="dohc-turn-into-menu__label">{entry.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
