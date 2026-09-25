// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import "./SourceCodeEditor";
import {
  markdownToYDoc,
  replaceYDocWithMarkdown,
  yDocToMarkdown,
} from "./editor/import-export";
import { FileInspector } from "./FileInspector";
import { resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";

vi.mock("./editor/import-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editor/import-export")>();
  return {
    ...actual,
    yDocToMarkdown: vi.fn(actual.yDocToMarkdown),
  };
});

let engineDocState: UseEngineDoc;
vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: () => engineDocState,
}));

const INITIAL_MARKDOWN = "# Plan\n\nInitial paragraph.\n";
const SOURCE_UPDATE_DELAY_MS = 150;
const SOURCE_UPDATE_MAX_WAIT_MS = 500;

function engineState(doc: Y.Doc): UseEngineDoc {
  return {
    available: true,
    opening: false,
    doc,
    objectId: "object-1",
    versionId: "version-1",
    saveState: "saved",
    saveError: null,
    notInVersion: false,
    documentUnavailable: false,
  liveHostUnavailable: false,
    engineMayHoldDocument: false,
    artifactAssetsInvalid: false,
    deletedWhileEditing: false,
    goneCause: null,
    deletedDraftId: null,
    recoveryAssets: null,
    permanentFailureWhileEditing: false,
    readOnlyWhileEditing: false,
    removalInProgress: null,
    artifactAssets: [],
    readArtifactAsset: async () => {
      throw new Error("no artifact asset");
    },
    flushPendingLocalUpdates: async () => undefined,
  };
}

function stubEditorGlobals(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 16)),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
}

function makeBridge(markdownByPath: Record<string, string>): DohcDesktopBridge {
  return {
    readWorkspaceText: vi.fn(async ({ relativePath }) => ({
      text: markdownByPath[relativePath] ?? "",
      truncated: false,
      contentHash: "sha256:test",
    })),
    writeWorkspaceText: vi.fn(async () => ({
      status: "written" as const,
      contentHash: "sha256:test",
    })),
    listWorkspaceFiles: vi.fn(async () => ({
      files: Object.keys(markdownByPath).map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
    writeWorkspaceAsset: vi.fn(async () => undefined),
  } as unknown as DohcDesktopBridge;
}

async function openSourceView(doc: Y.Doc) {
  engineDocState = engineState(doc);
  const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
  fireEvent.click(await screen.findByTestId("markdown-source-toggle"));
  const sourceView = await screen.findByTestId("markdown-source-view");
  await waitFor(() => expect(sourceView.textContent).toContain("Initial paragraph."));
  return view;
}

describe("FileInspector engine source update scheduling", () => {
  beforeEach(() => {
    stubEditorGlobals();
    vi.stubGlobal(
      "dohcDesktop",
      makeBridge({
        "a.md": INITIAL_MARKDOWN,
        "b.md": "# Other\n\nCurrent document.\n",
      }),
    );
  });

  afterEach(() => {
    cleanup();
    resetSharedLocalDocumentsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the initial source projection without waiting for the update debounce", async () => {
    const doc = markdownToYDoc(INITIAL_MARKDOWN);
    engineDocState = engineState(doc);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    const serialize = vi.mocked(yDocToMarkdown);
    serialize.mockClear();

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("markdown-source-toggle"));
    await act(async () => {
      await Promise.resolve();
      // SourceCodeEditor commits on its next frame. This stays well below the
      // update debounce and therefore cannot make a delayed initial projection pass.
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("view-markdown-source").textContent).toContain(
      "Initial paragraph.",
    );
  });

  it("bounds source serializations during a sustained update burst", async () => {
    const doc = markdownToYDoc(INITIAL_MARKDOWN);
    await openSourceView(doc);
    const serialize = vi.mocked(yDocToMarkdown);
    serialize.mockClear();
    vi.useFakeTimers();

    for (let elapsed = 0; elapsed < SOURCE_UPDATE_MAX_WAIT_MS * 2; elapsed += 25) {
      act(() => {
        replaceYDocWithMarkdown(doc, `# Plan\n\nUpdate at ${elapsed} ms.\n`);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
      });
    }

    expect(serialize).toHaveBeenCalledTimes(2);
  });

  it("renders the latest update on the trailing edge", async () => {
    const doc = markdownToYDoc(INITIAL_MARKDOWN);
    await openSourceView(doc);
    const serialize = vi.mocked(yDocToMarkdown);
    serialize.mockClear();
    vi.useFakeTimers();

    act(() => replaceYDocWithMarkdown(doc, "# Plan\n\nFirst update.\n"));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    act(() => replaceYDocWithMarkdown(doc, "# Plan\n\nSecond update.\n"));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    act(() => replaceYDocWithMarkdown(doc, "# Plan\n\nFinal update.\n"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOURCE_UPDATE_DELAY_MS - 1);
    });
    expect(serialize).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("markdown-source-view").textContent).toContain(
      "Final update.",
    );
  });

  it("never paints a queued projection after a document switch", async () => {
    const firstDoc = markdownToYDoc(INITIAL_MARKDOWN);
    const view = await openSourceView(firstDoc);
    const serialize = vi.mocked(yDocToMarkdown);
    serialize.mockClear();
    vi.useFakeTimers();

    act(() => {
      replaceYDocWithMarkdown(firstDoc, "# Plan\n\nStale first document.\n");
    });

    const secondDoc = markdownToYDoc("# Other\n\nCurrent document.\n");
    engineDocState = engineState(secondDoc);
    view.rerender(<FileInspector workspaceId="ws-1" path="b.md" />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId("markdown-source-view").textContent).toContain(
      "Current document.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOURCE_UPDATE_MAX_WAIT_MS);
    });
    expect(screen.getByTestId("markdown-source-view").textContent).not.toContain(
      "Stale first document.",
    );
    expect(serialize).toHaveBeenCalledTimes(1);
  });
});
