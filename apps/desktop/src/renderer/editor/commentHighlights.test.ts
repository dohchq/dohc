// @vitest-environment jsdom
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import {
  commentHighlightKey,
  makeCommentHighlightPlugin,
  setCommentAnchors,
} from "./commentHighlights";
import { doc, paragraph } from "./testDocs";

const painted = (state: EditorState) =>
  commentHighlightKey
    .getState(state)!
    .find()
    .map((decoration) => state.doc.textBetween(decoration.from, decoration.to));

describe("comment highlights", () => {
  const plugin = makeCommentHighlightPlugin({ anchors: () => [], onOpen: () => {} });
  const start = () =>
    EditorState.create({
      doc: doc(paragraph("Ship the plan on Monday"), paragraph("Budget is tight")),
      plugins: [plugin],
    });

  it("paints each comment's passage, and none for a passage the document lacks", () => {
    const before = start();
    const state = before.apply(
      setCommentAnchors(before, [
        { threadId: "a", quote: "the plan" },
        { threadId: "b", quote: "Budget" },
        { threadId: "c", quote: "Friday" },
      ]),
    );
    expect(painted(state)).toEqual(["the plan", "Budget"]);
  });

  it("keeps a passage painted through an edit before it", () => {
    let state = start();
    state = state.apply(setCommentAnchors(state, [{ threadId: "a", quote: "the plan" }]));
    state = state.apply(state.tr.insertText("Please ", 1));
    expect(painted(state)).toEqual(["the plan"]);
  });

  it("opens every comment whose passage holds the clicked text, and not a neighbour's", () => {
    const opened: string[][] = [];
    const clicking = makeCommentHighlightPlugin({
      anchors: () => [],
      onOpen: (threadIds) => opened.push(threadIds),
    });
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        doc: doc(paragraph("Ship the plan on Monday")),
        plugins: [clicking],
      }),
    });
    view.dispatch(
      setCommentAnchors(view.state, [
        { threadId: "a", quote: "the plan" },
        { threadId: "b", quote: "plan on" },
      ]),
    );
    // The painted spans: "the " is the first passage's, "plan" both, " on" the second's.
    const spans = [...view.dom.querySelectorAll("[data-comment-thread]")];
    expect(spans.map((span) => span.textContent)).toEqual(["the ", "plan", " on"]);
    // Where the caret lands within a span does not change whose comments open.
    for (const [span, pos] of [
      [0, 6],
      [1, 14],
      [1, 10],
      [2, 14],
    ] as const)
      clicking.props.handleClick!.call(clicking, view, pos, {
        target: spans[span],
      } as unknown as MouseEvent);
    expect(opened).toEqual([["a"], ["a", "b"], ["a", "b"], ["b"]]);
    view.destroy();
  });
});
