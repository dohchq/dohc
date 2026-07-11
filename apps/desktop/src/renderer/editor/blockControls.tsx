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

function isBlockControlTarget(nodeName: string): boolean {
  return [
    "paragraph",
    "heading",
    "blockquote",
    "bulletList",
    "orderedList",
    "codeBlock",
    "code_block",
    "horizontalRule",
    "table",
  ].includes(nodeName);
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

function createDragGhost(blockDom: HTMLElement): HTMLElement {
  const ghost = blockDom.cloneNode(true) as HTMLElement;
  ghost
    .querySelectorAll(".dohc-block-affordance")
    .forEach((el) => el.remove());
  ghost.className = "dohc-block-drag-ghost";
  ghost.style.width = `${blockDom.offsetWidth}px`;
  document.body.append(ghost);
  return ghost;
}

/**
 * Populate `dataTransfer` and `view.dragging` for a block drag, mirroring
 * prosemirror-view's `handlers.dragstart`: serialize the slice for the
 * clipboard, set the html/plain payloads + `effectAllowed`, and hand the slice
 * to `view.dragging` with `move: true`. A NodeSelection is set on the block so
 * ProseMirror's native drop (which calls `tr.deleteSelection()` when a dragging
 * object without a `node` is moved) removes the source. Returns the ghost node
 * so the caller can clean it up on dragend.
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

function buildBlockControlDecorations(
  doc: unknown,
  onInsertRef: RefObject<(pos: number) => void>,
  onOpenMenuRef: RefObject<(pos: number, rect: DOMRect) => void>,
): DecorationSet {
  const decorations: Decoration[] = [];

  (doc as TopLevelDocLike).forEach((node, offset, index) => {
    if (!isBlockControlTarget(node.type.name)) return;

    const pos = offset;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: "dohc-block-node",
        "data-dohc-block-index": String(index),
      }),
    );
    decorations.push(
      Decoration.widget(
        pos + 1,
        (view) => {
          const wrap = document.createElement("span");
          wrap.className = "dohc-block-affordance";
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

          let ghost: HTMLElement | null = null;
          const removeGhost = () => {
            ghost?.remove();
            ghost = null;
          };

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
            ghost = startBlockDrag(view, pos, handle, dragEvent.dataTransfer);
          });
          handle.addEventListener("dragend", removeGhost);

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
        { side: -1, key: `dohc-block-controls-${pos}` },
      ),
    );
  });

  return DecorationSet.create(doc as never, decorations);
}

export function makeBlockControlsPlugin({
  onInsertRef,
  onOpenMenuRef,
}: {
  onInsertRef: RefObject<(pos: number) => void>;
  onOpenMenuRef: RefObject<(pos: number, rect: DOMRect) => void>;
}) {
  return new Plugin({
    key: blockControlsKey,
    state: {
      init(_, instance) {
        return buildBlockControlDecorations(instance.doc, onInsertRef, onOpenMenuRef);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildBlockControlDecorations(tr.doc, onInsertRef, onOpenMenuRef);
      },
    },
    props: {
      decorations(state) {
        return blockControlsKey.getState(state) as DecorationSet | undefined;
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
  return manager.serialize({ type: "doc", content: [node.toJSON()] });
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
      if (containerRef.current?.contains(event.target as Node)) return;
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
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            setOpen(true);
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
