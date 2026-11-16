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
//   target. `scrollToPlace` aims again until the target stays.

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

/** How long a far jump's target stays where it is before the jump lets go of
 * it. What came into view with it, a diagram or an image, draws within this
 * time and moves what is below it. */
const SETTLE_MS = 1500;

/** The far jump that is still keeping its target in place. A later jump ends
 * it, and so does the person moving the view. */
let settling: AbortController | null = null;

/**
 * Scrolls `target` into view, to the top of its scroller or, with `nearest`,
 * only as far as it takes to show it. A target within a window's height is
 * laid out with its neighbours, so it moves smoothly when `smooth` is set. A
 * farther one is reached at once. What came near the viewport with it then
 * takes its real height and can move it, so each frame for a short time looks
 * where the target is and scrolls to it again if it moved.
 *
 * A function as `target` is asked again each frame, for an element the editor
 * may draw again, such as a find match.
 */
export function scrollToPlace(
  target: HTMLElement | (() => HTMLElement | null),
  smooth: boolean,
  block: "start" | "nearest" = "start",
): void {
  settling?.abort();
  const find = typeof target === "function" ? target : () => target;
  const first = find();
  if (!first) return;
  const { top } = first.getBoundingClientRect();
  const near = top > -window.innerHeight && top < 2 * window.innerHeight;
  first.scrollIntoView({ behavior: smooth && near ? "smooth" : "auto", block });
  if (near) return;
  const jump = new AbortController();
  settling = jump;
  const listen = { capture: true, passive: true, signal: jump.signal };
  for (const move of ["wheel", "pointerdown"] as const) {
    window.addEventListener(move, () => jump.abort(), listen);
  }
  // A key in the note moves the caret, and the view with it. A key in the find
  // box asks for the next match, which starts its own jump.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof Element && event.target.closest(".ProseMirror")) jump.abort();
    },
    listen,
  );
  let stillSince = performance.now();
  let last = first.getBoundingClientRect().top;
  const settle = () => {
    if (jump.signal.aborted) return;
    const element = find();
    if (!element?.isConnected) {
      jump.abort();
      return;
    }
    // Where it is comes before how long it has been: a frame that waited
    // behind the drawing of a long note still looks.
    if (Math.abs(element.getBoundingClientRect().top - last) >= 0.5) {
      element.scrollIntoView({ behavior: "auto", block });
      last = element.getBoundingClientRect().top;
      stillSince = performance.now();
    } else if (performance.now() - stillSince > SETTLE_MS) {
      jump.abort();
      return;
    }
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}
