// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import { markdownToYDoc } from "./import-export";
import { preloadCollaborativeMarkdownEditor } from "../MarkdownView";

const collaboration = vi.hoisted(() => {
  const ready = Promise.withResolvers<void>();
  return { ready, loads: 0 };
});

vi.mock("@tiptap/extension-collaboration", async (importOriginal) => {
  collaboration.loads += 1;
  await collaboration.ready.promise;
  return await importOriginal();
});

afterEach(cleanup);

it("shares preloads and preserves the pending and read-only editor handoff", async () => {
  const preloaded = preloadCollaborativeMarkdownEditor();
  const duplicate = preloadCollaborativeMarkdownEditor();
  await waitFor(() => expect(collaboration.loads).toBe(1));
  const doc = markdownToYDoc("Restored content");
  const firstCommits: Array<{ loading: boolean; editable: string | null }> = [];
  function Editor({ readOnly = false }: { readOnly?: boolean }) {
    useLayoutEffect(() => {
      firstCommits.push({
        loading: document.body.textContent?.includes("Loading editor...") ?? false,
        editable: document.querySelector(".tiptap")?.getAttribute("contenteditable") ?? null,
      });
    }, []);
    return <MarkdownEditor
      value="Restored content"
      workspaceId="workspace-1"
      path="restored.md"
      knownFiles={[]}
      onDirty={vi.fn()}
      readOnly={readOnly}
      collab={{ ydoc: doc, status: "disabled", peerCount: 0, synced: true }}
    />;
  }
  try {
    const pending = render(<Editor />);
    expect(firstCommits).toEqual([{ loading: true, editable: null }]);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    await act(async () => {
      collaboration.ready.resolve();
      await Promise.all([preloaded, duplicate]);
    });
    expect(await screen.findByTestId("markdown-editor")).toBeTruthy();
    expect(document.querySelector(".tiptap")?.getAttribute("contenteditable")).toBe("true");
    pending.unmount();
    render(<Editor readOnly />);
    expect(firstCommits.at(-1)).toEqual({ loading: true, editable: null });
    const restored = await screen.findByTestId("markdown-editor");
    expect(restored.getAttribute("contenteditable")).toBe("false");
    expect(restored.textContent).toContain("Restored content");
    expect(collaboration.loads).toBe(1);
  } finally {
    cleanup();
    doc.destroy();
  }
});
