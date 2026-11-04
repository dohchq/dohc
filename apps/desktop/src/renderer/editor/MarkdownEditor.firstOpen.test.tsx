// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { LazyMarkdownEditor, preloadMarkdownEditor } from "./LazyMarkdownEditor";

afterEach(() => {
  cleanup();
});

describe("a live note's first open", () => {
  it("shows no loading rows once the editor code that the read view started has loaded", async () => {
    // The read view calls this as soon as a note's text shows.
    preloadMarkdownEditor();
    await vi.dynamicImportSettled();
    await act(async () => {});

    const ydoc = markdownToYDoc("Large note");
    try {
      render(
        <LazyMarkdownEditor
          value="Large note"
          onDirty={vi.fn()}
          workspaceId="workspace-1"
          path="notes/large.md"
          knownFiles={[]}
          collab={{ ydoc, status: "connected", peerCount: 0, synced: true }}
        />,
      );
      expect(screen.queryByText("Loading editor...")).toBeNull();
      expect(await screen.findByTestId("markdown-editor")).toBeTruthy();
    } finally {
      ydoc.destroy();
    }
  });
});
