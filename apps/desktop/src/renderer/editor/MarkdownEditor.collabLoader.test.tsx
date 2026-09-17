// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { markdownToYDoc } from "./import-export";
import { MarkdownEditor } from "./MarkdownEditor";
import { preloadCollaborativeMarkdownEditor } from "../MarkdownView";

const collaborationModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock("@tiptap/extension-collaboration", () => {
  collaborationModule.loads += 1;
  throw "collaboration module failed to load";
});

function CollaborationEditor({ ydoc }: { ydoc: Y.Doc }) {
  return (
    <EditorErrorBoundary resetKey="workspace-1:notes/recovery.md">
      <MarkdownEditor
        value="Recovered"
        onDirty={vi.fn()}
        workspaceId="workspace-1"
        path="notes/recovery.md"
        knownFiles={[]}
        collab={{
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        }}
      />
    </EditorErrorBoundary>
  );
}

beforeEach(() => {
  collaborationModule.loads = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownEditor collaboration loader", () => {
  it("contains a failed shared import across editor recovery attempts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ydoc = markdownToYDoc("Recovered");

    try {
      await preloadCollaborativeMarkdownEditor();
      expect(collaborationModule.loads).toBe(1);
      expect(screen.queryByTestId("markdown-editor")).toBeNull();
      render(
        <StrictMode>
          <CollaborationEditor ydoc={ydoc} />
        </StrictMode>,
      );

      expect(await screen.findByTestId("editor-crash-recovery")).toBeTruthy();
      expect(screen.queryByTestId("markdown-editor")).toBeNull();
      expect(error.mock.calls.some((call) => call[1] instanceof Error)).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Render again" }));

      expect(await screen.findByTestId("editor-crash-recovery")).toBeTruthy();
      expect(screen.queryByTestId("markdown-editor")).toBeNull();
      expect(collaborationModule.loads).toBe(1);
    } finally {
      ydoc.destroy();
    }
  });
});
