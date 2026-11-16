// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitBlock } from "@tiptap/pm/commands";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { DecorationSet, EditorView } from "@tiptap/pm/view";
import { makeOffscreenBlocksPlugin } from "./offscreenBlocks";
import { doc, paragraph } from "./testDocs";

const views: EditorView[] = [];
function mount(document: PMNode) {
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: document, plugins: [makeOffscreenBlocksPlugin()] }),
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
    },
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const marked = (view: EditorView) =>
  [...view.dom.querySelectorAll(".dohc-caret-block")].map((block) => block.textContent);
const select = (view: EditorView, anchor: number, head = anchor) =>
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
const press = (view: EditorView, init: KeyboardEventInit) =>
  view.someProp("handleKeyDown", (handle) => handle(view, new KeyboardEvent("keydown", init)));

describe("the blocks that hold the caret", () => {
  it("carry the mark that keeps them laid out, at both ends of a selection", () => {
    const view = mount(doc(paragraph("one"), paragraph("two"), paragraph("three")));
    expect(marked(view)).toEqual(["one"]);
    select(view, 12);
    expect(marked(view)).toEqual(["three"]);
    select(view, 2, 12);
    expect(marked(view)).toEqual(["one", "three"]);
  });

  it("include a block made under the caret in the transaction that makes it", () => {
    const view = mount(doc(paragraph("one"), paragraph("two")));
    select(view, 4);
    let marksAtFirstDraw: (string | null)[] | null = null;
    const update = view.updateState.bind(view);
    view.updateState = (state) => {
      update(state);
      marksAtFirstDraw ??= marked(view);
    };
    splitBlock(view.state, view.dispatch);
    // The new, empty paragraph holds the caret and is marked as it is drawn.
    expect(view.state.doc.childCount).toBe(3);
    expect(marksAtFirstDraw).toEqual([""]);
    expect(view.dom.children[1]!.classList.contains("dohc-caret-block")).toBe(true);
  });

  it("keep their mark through typing without building it again", () => {
    const view = mount(doc(paragraph("one"), paragraph("two")));
    select(view, 7);
    const build = vi.spyOn(DecorationSet, "create");
    view.dispatch(view.state.tr.insertText("x"));
    view.dispatch(view.state.tr.insertText("y", 1));
    expect(build).not.toHaveBeenCalled();
    expect(marked(view)).toEqual(["txwo"]);
  });
});

describe("the keys to a note's start and end", () => {
  it("set the selection, which the browser cannot do in a block it has not laid out", () => {
    const view = mount(doc(paragraph("one"), paragraph("two"), paragraph("three")));
    select(view, 6);
    expect(press(view, { key: "End", ctrlKey: true })).toBe(true);
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.head).toBe(view.state.doc.content.size - 1);

    expect(press(view, { key: "Home", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(view.state.selection.anchor).toBe(view.state.doc.content.size - 1);
    expect(view.state.selection.head).toBe(1);

    expect(press(view, { key: "Home", ctrlKey: true })).toBe(true);
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.head).toBe(1);
    // A plain End stays the browser's: it moves within a line that is laid out.
    expect(press(view, { key: "End" })).toBeFalsy();
  });
});
