import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
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

  it("opens every comment whose passage holds the click, and not a neighbour's", () => {
    const opened: string[][] = [];
    const clicking = makeCommentHighlightPlugin({
      anchors: () => [],
      onOpen: (threadIds) => opened.push(threadIds),
    });
    let state = EditorState.create({
      doc: doc(paragraph("Ship the plan on Monday")),
      plugins: [clicking],
    });
    state = state.apply(
      setCommentAnchors(state, [
        { threadId: "a", quote: "the plan" },
        { threadId: "b", quote: "plan on" },
      ]),
    );
    // The span the click lands in names one comment, as the painted DOM does.
    const click = (pos: number, span: string) =>
      clicking.props.handleClick!.call(clicking, { state } as EditorView, pos, {
        target: { closest: () => ({ getAttribute: () => span }) },
      } as unknown as MouseEvent);
    click(12, "b"); // "pl|an", in both passages
    click(7, "a"); // "t|he", in the first only
    click(10, "a"); // "the |plan", where the second passage only starts
    expect(opened).toEqual([["a", "b"], ["a"], ["a"]]);
  });
});
