// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { findReplaceExtension, findReplaceKey } from "./findReplace";
import { FindReplaceBar } from "./FindReplaceBar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["darwin", { key: "g", metaKey: true }, { key: "G", metaKey: true, shiftKey: true }],
  ["win32", { key: "F3" }, { key: "F3", shiftKey: true }],
] as const)("finds again from the bar's fields on %s", (platform, next, previous) => {
  vi.stubGlobal("dohcDesktop", { platform });
  // jsdom has no layout, and the bar scrolls the active match into view.
  Element.prototype.scrollIntoView = vi.fn();
  const editor = new Editor({ extensions: [StarterKit, findReplaceExtension], content: "<p>the cat, the mat, the hat</p>" });
  try {
    render(<FindReplaceBar editor={editor} />);
    act(() => editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, { type: "open", replace: true, query: "the" })));
    expect(screen.getByText("1/3")).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText("Find"), next);
    expect(screen.getByText("2/3")).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText("Replace"), previous);
    fireEvent.keyDown(screen.getByPlaceholderText("Replace"), previous);
    expect(screen.getByText("3/3")).toBeTruthy();
  } finally {
    editor.destroy();
  }
});
