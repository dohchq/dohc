// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { MarkdownEditor } from "./MarkdownEditor";

const NOTE = "# plain.md\n\nAn ordinary paragraph.\n";

type EditorElement = HTMLElement & { editor: Editor };

function LiveEditor({ ydoc }: { ydoc: Y.Doc }) {
  return (
    <MarkdownEditor
      value=""
      onDirty={vi.fn()}
      workspaceId="workspace-1"
      path="plain.md"
      knownFiles={[]}
      collab={{ ydoc, status: "connected", peerCount: 0, synced: true }}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("MarkdownEditor autolink in a live document", () => {
  it("opens a note headed by a word that reads as a web address without changing it", async () => {
    const ydoc = markdownToYDoc(NOTE);
    const updates: Uint8Array[] = [];
    ydoc.on("update", (update: Uint8Array) => updates.push(update));
    try {
      render(<LiveEditor ydoc={ydoc} />);
      expect(await screen.findByText("plain.md")).toBeTruthy();
      expect(yDocToMarkdown(ydoc)).toBe(NOTE);
      expect(updates).toEqual([]);
    } finally {
      ydoc.destroy();
    }
  });

  it("still links a web address the owner types", async () => {
    const ydoc = markdownToYDoc("# Plain\n\nVisit\n");
    try {
      render(<LiveEditor ydoc={ydoc} />);
      expect(await screen.findByText("Visit")).toBeTruthy();
      const { view } = (screen.getByText("Visit").closest(".ProseMirror") as EditorElement).editor;
      const end = view.state.doc.content.size - 1;
      act(() => view.dispatch(view.state.tr.insertText(" example.com ", end)));
      expect(yDocToMarkdown(ydoc)).toContain("[example.com](http://example.com)");
    } finally {
      ydoc.destroy();
    }
  });
});
