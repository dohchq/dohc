import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { CommentAnchor } from "../workbench/fileComments";
import { findQuote } from "./commentAnchors";

// Paints each comment's passage, and opens the comment a click lands in. An
// edit maps the painted ranges at once; the passages are found again from
// their quotes once typing pauses, so a passage edited away loses its paint
// and one that arrives later, as a shared document fills in, gains it.

export const commentHighlightKey = new PluginKey<DecorationSet>("dohc-comment-highlights");

const FIND_AGAIN_MS = 400;
const ATTRIBUTE = "data-comment-thread";

function paint(doc: ProseMirrorNode, anchors: readonly CommentAnchor[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const anchor of anchors) {
    const range = findQuote(doc, anchor.quote);
    if (!range) continue;
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: "rounded-[2px] bg-accent/15 underline decoration-accent/60 underline-offset-2",
          [ATTRIBUTE]: anchor.threadId,
        },
        { threadId: anchor.threadId },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

/** A transaction that paints `anchors` anew. */
export function setCommentAnchors(state: EditorState, anchors: readonly CommentAnchor[]) {
  return state.tr.setMeta(commentHighlightKey, anchors).setMeta("addToHistory", false);
}

export function makeCommentHighlightPlugin(options: {
  anchors: () => readonly CommentAnchor[];
  // Every comment whose passage holds the click, oldest first.
  onOpen: (threadIds: string[]) => void;
}) {
  return new Plugin<DecorationSet>({
    key: commentHighlightKey,
    state: {
      init: (_, state) => paint(state.doc, options.anchors()),
      apply(tr, painted) {
        const anchors = tr.getMeta(commentHighlightKey) as readonly CommentAnchor[] | undefined;
        if (anchors) return paint(tr.doc, anchors);
        return tr.docChanged ? painted.map(tr.mapping, tr.doc) : painted;
      },
    },
    props: {
      decorations: (state) => commentHighlightKey.getState(state),
      handleClick(view, pos, event) {
        if (!(event.target as HTMLElement | null)?.closest(`[${ATTRIBUTE}]`)) return false;
        // Passages can overlap, and the painted span names only one of them.
        const threadIds = (commentHighlightKey.getState(view.state)?.find(pos, pos) ?? []).map(
          (decoration) => (decoration.spec as { threadId: string }).threadId,
        );
        if (threadIds.length > 0) options.onOpen(threadIds);
        // The click still places the caret, so the passage stays editable.
        return false;
      },
    },
    view() {
      let timer = 0;
      return {
        update(view, previous) {
          if (view.state.doc === previous.doc || options.anchors().length === 0) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            if (!view.isDestroyed) view.dispatch(setCommentAnchors(view.state, options.anchors()));
          }, FIND_AGAIN_MS);
        },
        destroy() {
          window.clearTimeout(timer);
        },
      };
    },
  });
}
