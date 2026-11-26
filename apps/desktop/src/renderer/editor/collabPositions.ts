import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { ProsemirrorBinding } from "@tiptap/y-tiptap";
import type { Doc, RelativePosition, XmlFragment } from "yjs";
import type { BodySequenceModules } from "./collaborationExtensions";

type YTiptap = typeof import("@tiptap/y-tiptap");
type YSync = { type: XmlFragment; binding: ProsemirrorBinding };

/**
 * Places in a live note that survive everyone's changes, for plugins that must find their text
 * again after a peer's change or an undo. A plugin's `apply` passes its new and old states; a
 * view passes its current state twice.
 */
export type CollabPositions = {
  isShownChange(tr: Transaction): boolean;
  doc(state: EditorState, oldState: EditorState): Doc | null;
  anchor(
    state: EditorState,
    oldState: EditorState,
    pos: number,
    assoc: number,
  ): RelativePosition | null;
  position(state: EditorState, oldState: EditorState, anchor: RelativePosition): number | null;
  anchorTopLevelBlock(state: EditorState, oldState: EditorState, blockPos: number): object | null;
  resolveTopLevelBlock(state: EditorState, oldState: EditorState, anchor: object): number | null;
};

function topLevelChildIndexAt(doc: ProseMirrorNode, blockPos: number): number {
  let found = -1;
  doc.forEach((_child, pos, index) => {
    if (pos === blockPos) found = index;
  });
  return found;
}

function topLevelBlockPosAtIndex(doc: ProseMirrorNode, childIndex: number): number | null {
  if (childIndex < 0 || childIndex >= doc.childCount) return null;
  let pos = 0;
  for (let index = 0; index < childIndex; index += 1) pos += doc.child(index).nodeSize;
  return pos;
}

export function yTiptapPositions(yTiptap: YTiptap): CollabPositions {
  const syncOf = (oldState: EditorState) =>
    yTiptap.ySyncPluginKey.getState(oldState) as YSync | undefined;
  return {
    isShownChange: (tr) =>
      Boolean(
        (tr.getMeta(yTiptap.ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
          ?.isChangeOrigin,
      ),
    doc: (_state, oldState) => syncOf(oldState)?.type.doc ?? null,
    anchor: (_state, oldState, pos) => {
      const sync = syncOf(oldState);
      return sync
        ? (yTiptap.absolutePositionToRelativePosition(
            pos,
            sync.type,
            sync.binding.mapping,
          ) as RelativePosition)
        : null;
    },
    position: (_state, oldState, anchor) => {
      const sync = syncOf(oldState);
      return sync?.type.doc
        ? yTiptap.relativePositionToAbsolutePosition(
            sync.type.doc,
            sync.type,
            anchor,
            sync.binding.mapping,
          )
        : null;
    },
    anchorTopLevelBlock: (state, oldState, blockPos) => {
      const sync = syncOf(oldState);
      const index = topLevelChildIndexAt(state.doc, blockPos);
      return sync && index >= 0 && index < sync.type.length ? sync.type.get(index) : null;
    },
    resolveTopLevelBlock: (state, oldState, anchor) => {
      const sync = syncOf(oldState);
      if (!sync) return null;
      const index = sync.type.toArray().findIndex((child) => child === anchor);
      return index < 0 ? null : topLevelBlockPosAtIndex(state.doc, index);
    },
  };
}

function firstLeafStart(doc: ProseMirrorNode, blockPos: number): number {
  let pos = blockPos;
  let node = doc.nodeAt(pos);
  while (node && !node.isTextblock && !node.isAtom && node.firstChild) {
    pos += 1;
    node = node.firstChild;
  }
  return pos;
}

export function bodySequencePositions(ydoc: Doc, { editor }: BodySequenceModules): CollabPositions {
  return {
    isShownChange: editor.isBodySequenceChange,
    doc: () => ydoc,
    anchor: (state, _oldState, pos, assoc) => editor.bodySequenceAnchor(state, pos, assoc),
    position: (state, _oldState, anchor) => editor.bodySequenceAnchorPosition(state, anchor),
    anchorTopLevelBlock: (state, _oldState, blockPos) =>
      editor.bodySequenceBlockAnchor(state, firstLeafStart(state.doc, blockPos)),
    resolveTopLevelBlock: (state, _oldState, anchor) => {
      const leaf = editor.bodySequenceBlockPosition(state, anchor as RelativePosition);
      if (leaf === null || leaf > state.doc.content.size) return null;
      const $leaf = state.doc.resolve(leaf);
      return $leaf.depth === 0 ? leaf : $leaf.before(1);
    },
  };
}
