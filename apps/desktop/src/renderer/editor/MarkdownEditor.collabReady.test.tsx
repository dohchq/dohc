// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { MarkdownEditor } from "./MarkdownEditor";

function LiveEditor({ ydoc }: { ydoc: Y.Doc }) {
  return (
    <MarkdownEditor
      value="Large note"
      onDirty={vi.fn()}
      workspaceId="workspace-1"
      path="notes/large.md"
      knownFiles={[]}
      collab={{ ydoc, status: "connected", peerCount: 0, synced: true }}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("MarkdownEditor collaboration loader", () => {
  it("mounts a live document's editor in its first commit once the extensions have loaded", async () => {
    const first = markdownToYDoc("Large note");
    const second = markdownToYDoc("Large note");
    try {
      const { unmount } = render(<LiveEditor ydoc={first} />);
      expect(await screen.findByTestId("markdown-editor")).toBeTruthy();
      unmount();

      // No await: the loading rows would cover the read view's text for the
      // whole editor build.
      render(<LiveEditor ydoc={second} />);
      expect(screen.queryByText("Loading editor...")).toBeNull();
      expect(await screen.findByTestId("markdown-editor")).toBeTruthy();
    } finally {
      first.destroy();
      second.destroy();
    }
  });
});
