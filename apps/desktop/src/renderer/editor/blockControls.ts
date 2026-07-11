import type { RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

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

function buildBlockControlDecorations(
  doc: unknown,
  onInsertRef: RefObject<(pos: number) => void>,
  onSelectRef: RefObject<(pos: number) => void>,
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
        () => {
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
          handle.title = "select block";
          handle.setAttribute("aria-label", "select block");
          handle.addEventListener("mousedown", stopEditorMouseEvent);
          handle.addEventListener("click", (event) => {
            stopEditorMouseEvent(event);
            onSelectRef.current(pos);
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
  onSelectRef,
}: {
  onInsertRef: RefObject<(pos: number) => void>;
  onSelectRef: RefObject<(pos: number) => void>;
}) {
  return new Plugin({
    key: blockControlsKey,
    state: {
      init(_, instance) {
        return buildBlockControlDecorations(instance.doc, onInsertRef, onSelectRef);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildBlockControlDecorations(tr.doc, onInsertRef, onSelectRef);
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
