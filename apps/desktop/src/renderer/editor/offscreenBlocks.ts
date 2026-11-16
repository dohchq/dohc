import { keydownHandler } from "@tiptap/pm/keymap";
import { Plugin, PluginKey, Selection, TextSelection, type Command } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// styles.css lets a top-level block away from the viewport skip its layout and
// paint, so opening a long note and typing in it cost what is near the screen.
// A skipped block has no layout: the browser cannot place a caret in it, and
// until it has drawn the block once it knows only an estimate of its height.
// This file keeps what a person can notice the same as in a note that is all
// laid out.
//
// - Caret. A block made under the caret, by Enter or by a line turning into a
//   list, would be skipped for its first frame, and the next keys would land
//   out of order. The blocks that hold the selection's ends carry a class that
//   keeps them laid out from the frame they appear in.
// - Start and end. The browser's own jump to the note's start or end puts the
//   caret at the front of a skipped block. Those keys set the selection here.
// - Jumps. A scroll to a far block aims at an estimated place, and the blocks
//   it brings near the viewport then take their real heights and move the
//   target. `scrollToPlace` (scrollToPlace.ts) follows it until it stays.

const offscreenBlocksKey = new PluginKey<DecorationSet>("dohc-offscreen-blocks");

/** The top-level blocks that hold the selection's two ends, by position. */
function caretBlocks(doc: ProseMirrorNode, selection: Selection): number[] {
  const blocks = new Set<number>();
  for (const $end of [selection.$anchor, selection.$head]) {
    const pos = $end.depth === 0 ? $end.pos : $end.before(1);
    if (doc.nodeAt(pos)) blocks.add(pos);
  }
  return [...blocks].sort((a, b) => a - b);
}

function mark(doc: ProseMirrorNode, blocks: readonly number[]): DecorationSet {
  return DecorationSet.create(
    doc,
    blocks.map((pos) =>
      Decoration.node(pos, pos + doc.nodeAt(pos)!.nodeSize, { class: "dohc-caret-block" }),
    ),
  );
}

/** Moves the caret to the note's start or end, or extends the selection there. */
function toEdge(edge: "start" | "end", extend: boolean): Command {
  return (state, dispatch) => {
    const target = edge === "start" ? Selection.atStart(state.doc) : Selection.atEnd(state.doc);
    const selection = extend
      ? TextSelection.between(state.selection.$anchor, target.$head)
      : target;
    dispatch?.(state.tr.setSelection(selection).scrollIntoView());
    return true;
  };
}

// macOS moves to a document's edge with Command and an arrow.
const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
const [startKey, endKey] = mac ? ["Mod-ArrowUp", "Mod-ArrowDown"] : ["Mod-Home", "Mod-End"];

export function makeOffscreenBlocksPlugin() {
  return new Plugin<DecorationSet>({
    key: offscreenBlocksKey,
    state: {
      init(_, state) {
        return mark(state.doc, caretBlocks(state.doc, state.selection));
      },
      apply(tr, old) {
        if (!tr.docChanged && !tr.selectionSet) return old;
        const blocks = caretBlocks(tr.doc, tr.selection);
        const kept = tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
        const marked = kept.find().map((decoration) => decoration.from);
        return marked.length === blocks.length && marked.every((pos, i) => pos === blocks[i])
          ? kept
          : mark(tr.doc, blocks);
      },
    },
    props: {
      decorations(state) {
        return offscreenBlocksKey.getState(state);
      },
      handleKeyDown: keydownHandler({
        [startKey]: toEdge("start", false),
        [endKey]: toEdge("end", false),
        [`Shift-${startKey}`]: toEdge("start", true),
        [`Shift-${endKey}`]: toEdge("end", true),
      }),
    },
  });
}
