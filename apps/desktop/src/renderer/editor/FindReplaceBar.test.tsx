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
  const editor = new Editor({
    extensions: [StarterKit, findReplaceExtension],
    content: "<p>the cat, the mat, the hat</p>",
  });
  try {
    render(<FindReplaceBar editor={editor} />);
    act(() =>
      editor.view.dispatch(
        editor.state.tr.setMeta(findReplaceKey, { type: "open", replace: true, query: "the" }),
      ),
    );
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

it("highlights 0/0 with danger class when query has no matches and re-focuses on Mod+F / Mod+H", () => {
  vi.stubGlobal("dohcDesktop", { platform: "win32" });
  Element.prototype.scrollIntoView = vi.fn();
  const editor = new Editor({
    extensions: [StarterKit, findReplaceExtension],
    content: "<p>the cat, the mat</p>",
  });
  try {
    render(<FindReplaceBar editor={editor} />);
    act(() =>
      editor.view.dispatch(
        editor.state.tr.setMeta(findReplaceKey, { type: "open", replace: false, query: "zzz" }),
      ),
    );
    const count = screen.getByText("0/0");
    expect(count.className).toContain("is-empty");
    expect(count.className).toContain("text-danger");

    const findInput = screen.getByPlaceholderText("Find") as HTMLInputElement;
    findInput.blur();
    expect(document.activeElement).not.toBe(findInput);

    // Re-opening via open meta increments openNonce and re-focuses + selects Find input.
    act(() =>
      editor.view.dispatch(
        editor.state.tr.setMeta(findReplaceKey, { type: "open", replace: false }),
      ),
    );
    expect(document.activeElement).toBe(findInput);
    expect(findInput.selectionStart).toBe(0);
    expect(findInput.selectionEnd).toBe(3);

    // Pressing Ctrl+H inside Find input with an active query opens & focuses Replace input.
    fireEvent.keyDown(findInput, { key: "h", ctrlKey: true });
    const replaceInput = screen.getByPlaceholderText("Replace") as HTMLInputElement;
    expect(document.activeElement).toBe(replaceInput);
  } finally {
    editor.destroy();
  }
});
