// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { stubEditorGlobals } from "./FileInspector.editor-fixture";
import { TEST_CONTENT_HASH, settleAfterUnmount } from "./FileInspector.draft-fixture";
import { resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";
import { disposeEngineDocLeasesForTests } from "./collab/engineDocLease";

// The editor's code and the collaboration code load only when the test lets
// them, so the note can finish opening first, as it can at launch.
const code = vi.hoisted(() => {
  const gate = () => {
    let release = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { loaded, release };
  };
  return { editor: gate(), collaboration: gate() };
});
vi.mock("./editor/MarkdownEditor", async (importOriginal) => {
  await code.editor.loaded;
  return importOriginal();
});
vi.mock("@tiptap/extension-collaboration", async (importOriginal) => {
  await code.collaboration.loaded;
  return importOriginal();
});

const NOTE = "# Plan\n\nBase paragraph.\n";

function heldOpenBridge() {
  const serverDoc = markdownToYDoc(NOTE);
  let bind = () => {};
  const bridge = {
    platform: "linux" as const,
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text: NOTE,
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(async () => ({
      status: "written",
      contentHash: TEST_CONTENT_HASH,
    })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
    openEngineYDocSession: vi.fn(
      () =>
        new Promise<{ available: boolean; initialUpdate?: Uint8Array; lineageGeneration?: number }>(
          (resolve) => {
            bind = () =>
              resolve({
                available: true,
                initialUpdate: Y.encodeStateAsUpdate(serverDoc),
                lineageGeneration: 1,
              });
          },
        ),
    ),
    applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
    closeEngineYDocSession: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
    onEngineYDocOwnerHandoff: () => () => undefined,
    prepareEngineYDocOwnerHandoff: async () => undefined,
    onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
    onEngineYDocSaveState: vi.fn(() => () => undefined),
  };
  return { bridge, bind: () => act(() => bind()) };
}

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  await disposeEngineDocLeasesForTests();
  resetSharedLocalDocumentsForTests();
  vi.unstubAllGlobals();
});

describe("a live note whose editor code loads after it opens", () => {
  it("keeps its read-only text until the editor replaces it, with no loading rows between", async () => {
    stubEditorGlobals();
    const { bridge, bind } = heldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge);

    // Every frame from the read view to the editor: the note's text, and
    // never the loading rows.
    const frames: Array<{ text: boolean; rows: boolean }> = [];
    const observer = new MutationObserver(() => {
      const pane = document.querySelector("[data-testid='view-markdown']");
      frames.push({
        text: !!pane?.textContent?.includes("Base paragraph."),
        rows: !!document.body.textContent?.includes("Loading editor..."),
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await waitFor(() =>
        expect(screen.getByTestId("view-markdown").textContent).toContain("Base paragraph."),
      );
      await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));

      bind();
      await act(async () => {});
      expect(screen.getByTestId("view-markdown").textContent).toContain("Base paragraph.");

      // The editor's code arrives; the collaboration code is still loading.
      code.editor.release();
      await act(async () => {
        await import("./editor/MarkdownEditor");
      });
      await act(async () => {});
      expect(screen.getByTestId("view-markdown").textContent).toContain("Base paragraph.");

      code.collaboration.release();
      await screen.findByTestId("markdown-editor");
      await waitFor(() =>
        expect(screen.getByTestId("view-markdown").textContent).toContain("Base paragraph."),
      );
    } finally {
      observer.disconnect();
    }

    const shown = frames.findIndex((frame) => frame.text);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(frames.slice(shown).filter((frame) => frame.rows || !frame.text)).toEqual([]);
  });
});
