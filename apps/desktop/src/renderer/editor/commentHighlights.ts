import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { CommentAnchor } from "../workbench/fileComments";
import { quoteFinder } from "./commentAnchors";

export const commentHighlightKey = new PluginKey<DecorationSet>("dohc-comment-highlights");

const FIND_AGAIN_MS = 400;
const ATTRIBUTE = "data-comment-thread";

function paint(doc: ProseMirrorNode, anchors: readonly CommentAnchor[]): DecorationSet {
  const decorations: Decoration[] = [];
  if (anchors.length === 0) return DecorationSet.empty;
  const find = quoteFinder(doc);
  for (const anchor of anchors) {
    const range = find(anchor.quote);
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

export function setCommentAnchors(state: EditorState, anchors: readonly CommentAnchor[]) {
  return state.tr.setMeta(commentHighlightKey, anchors).setMeta("addToHistory", false);
}

export function makeCommentHighlightPlugin(options: {
  anchors: () => readonly CommentAnchor[];
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
      handleClick(view, _pos, event) {
        const span = (event.target as HTMLElement | null)?.closest(`[${ATTRIBUTE}]`);
        if (!span) return false;
        const from = view.posAtDOM(span, 0);
        const to = view.posAtDOM(span, span.childNodes.length);
        const threadIds = (commentHighlightKey.getState(view.state)?.find(from, to) ?? [])
          .filter((decoration) => decoration.from <= from && to <= decoration.to)
          .map((decoration) => (decoration.spec as { threadId: string }).threadId);
        if (threadIds.length > 0) options.onOpen(threadIds);
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
