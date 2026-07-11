// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import type { JSONContent } from "@tiptap/core";
import { dohcMarkdownExtensions } from "./extensions";
import {
  applyWikilinkPick,
  WikilinkPicker,
  type WikilinkPickerState,
} from "./WikilinkPicker";
import type { WikilinkFile } from "./wikilinkPlugin";

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
  // jsdom doesn't implement scrollIntoView; the picker calls it when the
  // active item changes.
  Element.prototype.scrollIntoView = vi.fn();
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
    const view = editor.view as Parameters<typeof applyWikilinkPick>[0];
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
    const view = editor.view as Parameters<typeof applyWikilinkPick>[0];
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
    const view = editor.view as Parameters<typeof WikilinkPicker>[0]["view"];
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
    const view = editor.view as Parameters<typeof WikilinkPicker>[0]["view"];
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
