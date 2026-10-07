// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { dohcMarkdownExtensions } from "./extensions";
import { applyEmojiPick, EmojiPicker, rankEmoji, type EmojiPickerState } from "./EmojiPicker";
import { EMOJI_DATA } from "./emojiData";
import { makeEmojiPlugin } from "./emojiTrigger";
import { inListView, mockListLayout } from "../ui/listLayout.testSupport";

// Same ResizeObserver / Range stubs WikilinkPicker.test.tsx uses — needed
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
      ...dohcMarkdownExtensions,
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
    ],
    content: markdown,
    contentType: "markdown",
  });
}

function makeEditorWithEmojiPlugin(markdown: string): Editor {
  const TestEmojiExtension = Extension.create({
    name: "testEmojiTrigger",
    addProseMirrorPlugins() {
      return [makeEmojiPlugin(() => {})];
    },
  });
  return new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      ...dohcMarkdownExtensions,
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
      TestEmojiExtension,
    ],
    content: markdown,
    contentType: "markdown",
  });
}

const smile = EMOJI_DATA.find((e) => e.shortcode === "smile")!;

describe("rankEmoji — fuzzy ranking sanity", () => {
  it("ranks an exact shortcode match first", () => {
    const results = rankEmoji("fire");
    expect(results[0]!.entry.shortcode).toBe("fire");
  });

  it("ranks a shortcode-prefix match ahead of a keyword-only match", () => {
    const results = rankEmoji("laugh");
    const laughingIdx = results.findIndex((r) => r.entry.shortcode === "laughing");
    const joyIdx = results.findIndex((r) => r.entry.shortcode === "joy");
    expect(laughingIdx).toBeGreaterThanOrEqual(0);
    expect(joyIdx).toBeGreaterThanOrEqual(0);
    expect(laughingIdx).toBeLessThan(joyIdx);
  });

  it("excludes entries with no match on shortcode or keywords", () => {
    const results = rankEmoji("zzzznomatchzzzz");
    expect(results).toHaveLength(0);
  });

  it("returns every entry, unfiltered, for an empty query", () => {
    expect(rankEmoji("")).toHaveLength(EMOJI_DATA.length);
  });
});

describe("applyEmojiPick — plain-text insertion", () => {
  it("replaces the :query text with the bare emoji character, no node/markup", () => {
    const editor = makeEditor(":smi");
    // ":smi" is 4 chars starting at doc pos 1; from = 1 (the ":"). The
    // cursor tracks the end of the typed query, same as during live typing.
    editor.commands.focus("end");
    const view = editor.view;
    applyEmojiPick(view, 1, smile);

    expect(editor.getText()).toBe(smile.emoji);
    expect(editor.storage.markdown.manager.serialize(editor.getJSON())).toBe(smile.emoji);
    editor.destroy();
  });
});

describe("makeEmojiPlugin — typing the closing colon inserts immediately", () => {
  it("replaces a completed :shortcode: with the emoji as the colon is typed", () => {
    const editor = makeEditorWithEmojiPlugin("hi :smile");
    editor.commands.focus("end");
    editor.commands.insertContent(":");

    expect(editor.getText()).toBe(`hi ${smile.emoji}`);
    editor.destroy();
  });

  it("leaves an unknown shortcode as literal text", () => {
    const editor = makeEditorWithEmojiPlugin("hi :notarealshortcode");
    editor.commands.focus("end");
    editor.commands.insertContent(":");

    expect(editor.getText()).toBe("hi :notarealshortcode:");
    editor.destroy();
  });
});

describe("EmojiPicker — dismiss leaves text intact", () => {
  it("Escape closes the picker without touching the document", async () => {
    const editor = makeEditor(":smi");
    const state: EmojiPickerState = { open: true, from: 1, query: "smi" };
    const view = editor.view;
    const onDismiss = vi.fn();

    render(createElement(EmojiPicker, { state, view, onDismiss }));

    expect(screen.getByRole("option", { name: /:smile:/ })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe(":smi");
    editor.destroy();
  });

  it("clicking a match inserts the plain-text emoji and calls onDismiss", async () => {
    const editor = makeEditor(":smi");
    editor.commands.focus("end");
    const state: EmojiPickerState = { open: true, from: 1, query: "smi" };
    const view = editor.view;
    const onDismiss = vi.fn();

    render(createElement(EmojiPicker, { state, view, onDismiss }));

    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: /:smile:/ }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe(smile.emoji);
    editor.destroy();
  });

  it("Tab commits the active match, same as Enter", async () => {
    const editor = makeEditor(":smi");
    editor.commands.focus("end");
    const state: EmojiPickerState = { open: true, from: 1, query: "smi" };
    const view = editor.view;
    const onDismiss = vi.fn();

    render(createElement(EmojiPicker, { state, view, onDismiss }));

    fireEvent.keyDown(window, { key: "Tab" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe(smile.emoji);
    editor.destroy();
  });

  it("exposes the active option via aria-activedescendant and tracks arrow keys", () => {
    const editor = makeEditor(":smi");
    const state: EmojiPickerState = { open: true, from: 1, query: "smi" };
    const view = editor.view;

    render(createElement(EmojiPicker, { state, view, onDismiss: vi.fn() }));

    const listbox = screen.getByRole("listbox", { name: "emoji" });
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    // Points at the first option on open.
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options[0]!.id).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowDown" });

    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    editor.destroy();
  });
});

// While an IME composes, Enter, Tab, the arrows and Escape work its candidate
// list. Chromium marks those keys isComposing; some platforms report only
// keyCode 229.
describe("EmojiPicker during IME composition", () => {
  it("leaves the composing keys to the editor and the IME, then picks with the keys once composition ends", () => {
    const editor = makeEditor(":smi");
    const dom = editor.view.dom;
    document.body.append(dom);
    try {
      editor.commands.focus("end");
      const onDismiss = vi.fn();
      render(createElement(EmojiPicker, { state: { open: true, from: 1, query: "smi" }, view: editor.view, onDismiss }));
      const list = screen.getByRole("listbox", { name: "emoji" });
      const options = screen.getAllByRole("option");
      const doc = editor.getJSON();
      const selection = editor.state.selection.toJSON();
      const reached = vi.fn();
      dom.addEventListener("keydown", reached);

      fireEvent.compositionStart(dom);
      for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const key of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) {
          const init = { key, ...composing };
          expect(fireEvent.keyDown(dom, init), JSON.stringify(init)).toBe(true);
          expect(reached).toHaveBeenLastCalledWith(expect.objectContaining({ key }));
          expect(onDismiss).not.toHaveBeenCalled();
          expect(list.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
          expect(editor.getJSON()).toEqual(doc);
          expect(editor.state.selection.toJSON()).toEqual(selection);
        }
      }
      expect(reached).toHaveBeenCalledTimes(10);

      fireEvent.compositionEnd(dom);
      fireEvent.keyDown(dom, { key: "ArrowDown" });
      expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
      fireEvent.keyDown(dom, { key: "Enter" });
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(editor.getText()).toBe(rankEmoji("smi")[1]!.entry.emoji);
    } finally {
      editor.destroy();
      dom.remove();
    }
  });
});

describe("EmojiPicker on the Menu part's recipe", () => {
  it("keeps the active option in the list's view as the arrows move it, scrolling only the list", () => {
    const restore = mockListLayout(200);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const editor = makeEditor(":");
    try {
      render(createElement(EmojiPicker, { state: { open: true, from: 1, query: "" }, view: editor.view, onDismiss: vi.fn() }));
      const list = screen.getByRole("listbox", { name: "emoji" });
      const options = screen.getAllByRole("option");
      expect(options.length).toBeGreaterThan(8);
      fireEvent.keyDown(window, { key: "ArrowUp" });
      const last = options.at(-1)!;
      expect(last.hasAttribute("data-active")).toBe(true);
      expect(inListView(list, last)).toBe(true);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      restore();
      editor.destroy();
    }
  });
});
