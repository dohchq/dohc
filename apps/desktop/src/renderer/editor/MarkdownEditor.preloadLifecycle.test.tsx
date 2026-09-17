// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { MarkdownEditor } from "./MarkdownEditor";
import { markdownToYDoc, yDocToMarkdown } from "./import-export";
import { preloadCollaborativeMarkdownEditor } from "../MarkdownView";
import { EditorErrorBoundary } from "./EditorErrorBoundary";

it("keeps a warmed editor usable when render yields before commit", async () => {
  await preloadCollaborativeMarkdownEditor();
  const doc = markdownToYDoc("Restored after restart");
  vi.useFakeTimers();
  function YieldBeforeCommit() {
    // Let Tiptap's real uncommitted-editor destruction timer run at the
    // point where React can yield during a concurrent startup render.
    vi.advanceTimersByTime(1);
    return null;
  }
  try {
    render(
      <EditorErrorBoundary resetKey="restart">
        <div style={{ overflowY: "auto" }}>
          <MarkdownEditor
            value="Restored after restart"
            workspaceId="workspace-1"
            path="restored.md"
            knownFiles={[]}
            onDirty={vi.fn()}
            collab={{ ydoc: doc, status: "disabled", peerCount: 0, synced: true }}
          />
          <YieldBeforeCommit />
        </div>
      </EditorErrorBoundary>,
    );
    await act(async () => {});
    expect(screen.queryByTestId("editor-crash-recovery")).toBeNull();
    const surface = screen.getByTestId("markdown-editor") as HTMLElement & { editor: Editor };
    expect(surface.getAttribute("contenteditable")).toBe("true");
    expect(surface.textContent).toContain("Restored after restart");
    act(() => { surface.editor.commands.insertContent("First edit. "); });
    expect(yDocToMarkdown(doc)).toContain("First edit. Restored after restart");
  } finally {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    doc.destroy();
  }
});
