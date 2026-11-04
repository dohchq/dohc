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

// The note's pane is tall once it shows the note's text, as the read view or
// as the editor, and empty until then. `tall` holds the editor's content short
// until its nodes and images have rendered.
function stubPaneLayout(tall: () => boolean = () => true) {
  const pane = (element: Element) => element.matches("[data-testid='view-markdown']");
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return pane(this) && tall() && this.textContent?.includes("Base paragraph.") ? 2_000 : 0;
  });
  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return pane(this) ? 200 : 0;
  });
  return () => {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  };
}

// Keeps each ResizeObserver, so a test can report that the note's content
// changed size.
function stubResizeObservers() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Element[]; observer: ResizeObserver }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly targets: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets, observer: this as unknown as ResizeObserver });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.targets.length = 0;
      }
    },
  );
  // The elements watched by the observers that watch the note's pane content.
  const watched = () => {
    const pane = screen.getByTestId("view-markdown");
    return observers
      .filter(({ targets }) => targets.some((target) => target.parentElement === pane))
      .flatMap(({ targets }) => targets);
  };
  const resize = () =>
    act(() => {
      const pane = screen.getByTestId("view-markdown");
      for (const { callback, targets, observer } of observers) {
        const content = targets.filter((target) => target.parentElement === pane);
        if (content.length === 0) continue;
        callback(
          content.map((target) => ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry),
          observer,
        );
      }
    });
  return { resize, watched };
}

// Opens the note with the person scrolled partway down its read view, then
// shows its editor while the editor's content is still short.
async function openScrolledWithShortEditor(layout: { tall: boolean }) {
  code.editor.release();
  code.collaboration.release();
  stubEditorGlobals();
  const { resize, watched } = stubResizeObservers();
  const { bridge, bind } = heldOpenBridge();
  vi.stubGlobal("dohcDesktop", bridge);
  const restoreLayout = stubPaneLayout(() => layout.tall);
  render(<FileInspector workspaceId="ws-1" path="a.md" />);
  await waitFor(() =>
    expect(screen.getByTestId("view-markdown").textContent).toContain("Base paragraph."),
  );
  await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
  act(() => {
    const pane = screen.getByTestId("view-markdown");
    pane.scrollTop = 600;
    pane.dispatchEvent(new Event("scroll"));
  });
  layout.tall = false;
  bind();
  await screen.findByTestId("markdown-editor");
  expect(screen.getByTestId("view-markdown").scrollTop).toBe(0);
  return { resize, watched, restoreLayout };
}

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  await disposeEngineDocLeasesForTests();
  resetSharedLocalDocumentsForTests();
  vi.unstubAllGlobals();
});

describe("a live note whose editor code loads after it opens", () => {
  it("keeps its read-only text and its place until the editor replaces it, with no loading rows between", async () => {
    stubEditorGlobals();
    const { bridge, bind } = heldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge);

    // Every frame from the read view to the editor: the note's text, and
    // never the loading rows.
    const frames: Array<{ text: boolean; rows: boolean; editor: boolean; top: number }> = [];
    const observer = new MutationObserver(() => {
      const pane = document.querySelector("[data-testid='view-markdown']");
      frames.push({
        text: !!pane?.textContent?.includes("Base paragraph."),
        rows: !!document.body.textContent?.includes("Loading editor..."),
        editor: !!pane?.querySelector("[data-testid='markdown-editor']"),
        top: pane?.scrollTop ?? 0,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const restoreLayout = stubPaneLayout();
    try {
      render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await waitFor(() =>
        expect(screen.getByTestId("view-markdown").textContent).toContain("Base paragraph."),
      );
      await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
      // The person reads partway down while the note opens.
      act(() => {
        const pane = screen.getByTestId("view-markdown");
        pane.scrollTop = 600;
        pane.dispatchEvent(new Event("scroll"));
      });

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
      restoreLayout();
    }

    const shown = frames.findIndex((frame) => frame.text);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(frames.slice(shown).filter((frame) => frame.rows || !frame.text)).toEqual([]);
    // The editor's first frame opens where the person was reading.
    expect(frames.find((frame) => frame.editor)?.top).toBe(600);
  });

  it("moves the editor to where the person was reading once its content is tall enough", async () => {
    const layout = { tall: true };
    const { resize, watched, restoreLayout } = await openScrolledWithShortEditor(layout);
    try {
      // The editor's wrapper fills the pane, so the watched content includes
      // the editor's document, which grows with the note.
      const editorDocument = screen.getByTestId("view-markdown").querySelector(".ProseMirror");
      expect(editorDocument).not.toBeNull();
      expect(watched()).toContain(editorDocument);
      // An image loads, and the content grows without a new node.
      layout.tall = true;
      resize();
      expect(screen.getByTestId("view-markdown").scrollTop).toBe(600);
    } finally {
      restoreLayout();
    }
  });

  it("leaves the editor where the person moved it before its content was tall enough", async () => {
    const layout = { tall: true };
    const { resize, restoreLayout } = await openScrolledWithShortEditor(layout);
    try {
      const pane = screen.getByTestId("view-markdown");
      act(() => {
        pane.scrollTop = 50;
        pane.dispatchEvent(new Event("scroll"));
      });
      // Later edits make the content tall enough for the old position.
      layout.tall = true;
      await act(async () => {
        pane.appendChild(document.createElement("div"));
      });
      resize();
      expect(pane.scrollTop).toBe(50);
    } finally {
      restoreLayout();
    }
  });
});
