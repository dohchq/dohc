// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitBlock } from "@tiptap/pm/commands";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { DecorationSet, EditorView } from "@tiptap/pm/view";
import { makeOffscreenBlocksPlugin, scrollToPlace } from "./offscreenBlocks";
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

describe("a scroll to a place in the note", () => {
  /** A target `top` pixels down the window. A scroll to it brings it to 0. */
  function place(top: number) {
    const element = window.document.createElement("p");
    window.document.body.append(element);
    const at = { top };
    const scrolls: ScrollIntoViewOptions[] = [];
    element.scrollIntoView = (options) => {
      scrolls.push(options as ScrollIntoViewOptions);
      at.top = 0;
    };
    element.getBoundingClientRect = () => ({ top: at.top }) as DOMRect;
    return { element, scrolls, at };
  }
  /** Runs `count` frames, 16 ms apart. False once no frame is waited for. */
  function frames() {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => queue.push(run));
    return (count = 1) => {
      for (let frame = 0; frame < count; frame += 1) {
        now += 16;
        queue.shift()?.(now);
      }
      return queue.length > 0;
    };
  }
  const FAR = 40_000;

  it("moves smoothly to a target within a window's height, once", () => {
    const run = frames();
    const { element, scrolls } = place(window.innerHeight);
    scrollToPlace(element, true);
    expect(run()).toBe(false);
    expect(scrolls).toEqual([{ behavior: "smooth", block: "start" }]);
  });

  it("reaches a far target at once, and again each time what is drawn around it moves it", () => {
    const run = frames();
    const { element, scrolls, at } = place(FAR);
    scrollToPlace(element, true);
    expect(scrolls).toEqual([{ behavior: "auto", block: "start" }]);
    run(3);
    expect(scrolls).toHaveLength(1);
    // A diagram above the target draws a few frames after the jump.
    at.top = 180;
    run();
    expect(scrolls).toHaveLength(2);
    expect(at.top).toBe(0);
    // It keeps the target in place for a second and a half, then lets go.
    expect(run(60)).toBe(true);
    expect(run(40)).toBe(false);
    at.top = 90;
    run();
    expect(scrolls).toHaveLength(2);
  });

  it("lets a later jump end an earlier one", () => {
    const run = frames();
    const far = place(FAR);
    const near = place(100);
    scrollToPlace(far.element, false);
    scrollToPlace(near.element, false);
    far.at.top = 500;
    expect(run()).toBe(false);
    expect(far.scrolls).toHaveLength(1);
  });

  it("lets go when the person moves the view, and not for a key typed in the find box", () => {
    const run = frames();
    const { element, scrolls, at } = place(FAR);
    const findBox = window.document.createElement("input");
    const note = window.document.createElement("div");
    note.className = "ProseMirror";
    window.document.body.append(findBox, note);
    const moved = () => {
      at.top = 300;
      run();
      return scrolls.length;
    };

    scrollToPlace(element, false);
    findBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(moved()).toBe(2);
    note.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    expect(moved()).toBe(2);

    at.top = FAR;
    scrollToPlace(element, false);
    window.dispatchEvent(new WheelEvent("wheel"));
    expect(moved()).toBe(3);
  });

  it("asks a function for the target again each frame", () => {
    const run = frames();
    let match = place(FAR);
    scrollToPlace(() => match.element, false, "nearest");
    // The editor draws the match again as another element.
    match = place(250);
    run();
    expect(match.scrolls).toEqual([{ behavior: "auto", block: "nearest" }]);
  });

  it("lets go of a target that left the page", () => {
    const run = frames();
    const { element, scrolls } = place(FAR);
    scrollToPlace(element, false);
    element.remove();
    expect(run()).toBe(false);
    expect(scrolls).toHaveLength(1);
  });
});
