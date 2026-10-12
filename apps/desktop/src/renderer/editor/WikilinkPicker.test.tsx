// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import type { JSONContent } from "@tiptap/core";
import { desktopMarkdownExtensions } from "./extensions";
import {
  applyWikilinkPick,
  WikilinkPicker,
  type WikilinkPickerState,
} from "./WikilinkPicker";
import type { WikilinkFile } from "./wikilinkPlugin";
import { inListView, mockListLayout } from "../ui/listLayout.testSupport";

// Same ResizeObserver / Range stubs MarkdownEditor.test.ts uses — needed
// because the picker calls `view.coordsAtPos`, which under real
// ProseMirror/jsdom reaches into DOM Range measurement.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeEditor(markdown: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      ...desktopMarkdownExtensions,
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
    ],
    content: markdown,
    contentType: "markdown",
  });
}

const files: ReadonlyArray<WikilinkFile> = [
  { path: "notes/roadmap.md", title: "Roadmap" },
];

function firstWikilinkNode(json: JSONContent): JSONContent | undefined {
  return json.content?.[0]?.content?.find((n) => n.type === "wikilink");
}

describe("applyWikilinkPick — insertMode: node (the @-mention path)", () => {
  it("replaces the @query text with a wikilink node carrying target + label", () => {
    const editor = makeEditor("@road");
    // "@road" is 5 chars starting at doc pos 1; from = 1 (the "@").
    const view = editor.view;
    applyWikilinkPick(view, 1, files[0]!, "node");

    const node = firstWikilinkNode(editor.getJSON());
    expect(node?.attrs).toMatchObject({
      target: "notes/roadmap",
      label: "Roadmap",
    });
    editor.destroy();
  });

  it("falls back to the path's leaf segment as the label when the file has no title", () => {
    const editor = makeEditor("@untitled-thing");
    const view = editor.view;
    applyWikilinkPick(view, 1, { path: "deep/nested/untitled-thing.md" }, "node");

    const node = firstWikilinkNode(editor.getJSON());
    expect(node?.attrs).toMatchObject({
      target: "deep/nested/untitled-thing",
      label: "untitled-thing",
    });
    editor.destroy();
  });
});

describe("WikilinkPicker — dismiss leaves the literal text intact", () => {
  it("Escape closes the picker without touching the document", async () => {
    const editor = makeEditor("@road");
    const state: WikilinkPickerState = { open: true, from: 1, query: "road" };
    const view = editor.view;
    const onDismiss = vi.fn();

    render(
      createElement(WikilinkPicker, {
        state,
        files,
        view,
        insertMode: "node",
        onDismiss,
      }),
    );

    // The picker is open and showing the match.
    expect(screen.getByRole("option", { name: /Roadmap/ })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    // No transaction was dispatched — the raw "@road" text is untouched.
    expect(editor.getText()).toBe("@road");
    expect(firstWikilinkNode(editor.getJSON())).toBeUndefined();
    editor.destroy();
  });

  it("clicking a match inserts the node and calls onDismiss", async () => {
    const editor = makeEditor("@road");
    const state: WikilinkPickerState = { open: true, from: 1, query: "road" };
    const view = editor.view;
    const onDismiss = vi.fn();

    render(
      createElement(WikilinkPicker, {
        state,
        files,
        view,
        insertMode: "node",
        onDismiss,
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: /Roadmap/ }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(firstWikilinkNode(editor.getJSON())?.attrs).toMatchObject({
      target: "notes/roadmap",
      label: "Roadmap",
    });
    editor.destroy();
  });
});

// While an IME composes, Enter, the arrows and Escape work its candidate list.
// Chromium marks those keys isComposing; some platforms report only keyCode 229.
describe("WikilinkPicker during IME composition", () => {
  it("leaves the composing keys to the editor and the IME, then picks with the keys once composition ends", () => {
    const editor = makeEditor("@road");
    const dom = editor.view.dom;
    document.body.append(dom);
    try {
      editor.commands.focus("end");
      const onDismiss = vi.fn();
      const roads = [
        { path: "notes/roadmap.md", title: "Roadmap" },
        { path: "notes/roads.md", title: "Roads" },
      ];
      render(createElement(WikilinkPicker, { state: { open: true, from: 1, query: "road" }, files: roads, view: editor.view, insertMode: "node", onDismiss }));
      const list = screen.getByRole("listbox", { name: "page links" });
      const options = screen.getAllByRole("option");
      const doc = editor.getJSON();
      const selection = editor.state.selection.toJSON();
      const reached = vi.fn();
      dom.addEventListener("keydown", reached);

      fireEvent.compositionStart(dom);
      for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape"]) {
          const init = { key, ...composing };
          expect(fireEvent.keyDown(dom, init), JSON.stringify(init)).toBe(true);
          expect(reached).toHaveBeenLastCalledWith(expect.objectContaining({ key }));
          expect(onDismiss).not.toHaveBeenCalled();
          expect(list.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
          expect(editor.getJSON()).toEqual(doc);
          expect(editor.state.selection.toJSON()).toEqual(selection);
        }
      }
      expect(reached).toHaveBeenCalledTimes(8);

      fireEvent.compositionEnd(dom);
      fireEvent.keyDown(dom, { key: "ArrowDown" });
      expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
      fireEvent.keyDown(dom, { key: "Enter" });
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(firstWikilinkNode(editor.getJSON())?.attrs).toMatchObject({ target: "notes/roads", label: "Roads" });
    } finally {
      editor.destroy();
      dom.remove();
    }
  });
});

// Twelve matches fill more than the picker's height. The editor keeps focus
// and the typed keys, so only the arrows move the active option.
describe("WikilinkPicker on the Menu part's recipe", () => {
  it("keeps the active option in the list's view as the arrows move it, scrolling only the list", () => {
    const restore = mockListLayout(200);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const editor = makeEditor("[[");
    try {
      const many = Array.from({ length: 12 }, (_, index) => ({ path: `notes/page-${index + 1}.md` }));
      render(createElement(WikilinkPicker, { state: { open: true, from: 1, query: "" }, files: many, view: editor.view, onDismiss: vi.fn() }));
      const list = screen.getByRole("listbox", { name: "page links" });
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(12);

      fireEvent.keyDown(window, { key: "ArrowUp" });
      const last = options.at(-1)!;
      expect(list.getAttribute("aria-activedescendant")).toBe(last.id);
      expect(last.hasAttribute("data-active")).toBe(true);
      expect(inListView(list, last)).toBe(true);
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(inListView(list, options[0]!)).toBe(true);
      // Home and End stay with the editor's query.
      fireEvent.keyDown(window, { key: "End" });
      expect(list.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      restore();
      editor.destroy();
    }
  });

  it("takes the active option only from a pointer that moves", () => {
    const editor = makeEditor("[[");
    const two = [{ path: "notes/one.md" }, { path: "notes/two.md" }];
    render(createElement(WikilinkPicker, { state: { open: true, from: 1, query: "" }, files: two, view: editor.view, onDismiss: vi.fn() }));
    const list = screen.getByRole("listbox", { name: "page links" });
    const second = screen.getAllByRole("option")[1]!;
    fireEvent.mouseMove(second, { movementX: 0, movementY: 0 });
    expect(list.getAttribute("aria-activedescendant")).not.toBe(second.id);
    fireEvent.mouseMove(second, { movementX: 2, movementY: 0 });
    expect(list.getAttribute("aria-activedescendant")).toBe(second.id);
    editor.destroy();
  });
});
