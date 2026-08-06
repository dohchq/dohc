// @vitest-environment jsdom
import { configure } from "@testing-library/dom";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// The editor module NEVER resolves here, so `LazyMarkdownEditor` stays
// suspended for the whole file and `wysiwygRef.current` is null while the
// engine document is live and bound. That is the state this file is about,
// and it is a real one: the Suspense window on open, an editor chunk that
// fails to load, and the error boundary a crashed editor falls back to all
// leave the document header — and its export menu — over an unmounted
// serializer. It is mocked at module scope because that is the only way to
// hold the window open deterministically.
vi.mock("./editor/MarkdownEditor", () => new Promise(() => {}));

import { markdownToYDoc } from "./editor/import-export";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });

const DOC_MARKDOWN = "# Plan\n\nBody from the last read.\n";

function engineBridge(markdown: string, options?: { available?: boolean }) {
  const serverDoc = markdownToYDoc(markdown);
  return {
    readWorkspaceText: vi.fn(async () => ({ text: markdown, truncated: false })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [{ path: "a.md", kind: "file" }],
      folders: [],
    })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
    openEngineYDocSession: vi.fn(async () =>
      options?.available === false
        ? { available: false }
        : { available: true, initialUpdate: Y.encodeStateAsUpdate(serverDoc) },
    ),
    applyEngineYDocUpdate: vi.fn(async () => undefined),
    closeEngineYDocSession: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
    onEngineYDocSaveState: vi.fn(() => () => undefined),
    exportDocumentFile: vi.fn(
      async (_payload: {
        workspaceId: string;
        suggestedName: string;
        content: string;
        kind: string;
      }) => ({ saved: true }),
    ),
  };
}

function stubEditorGlobals() {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

beforeEach(stubEditorGlobals);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// codex r14. The empty-cache guard was one instance of the rule, not the rule.
// A live engine document is CANONICAL (AGENTS.md product invariant) and
// `props.body` is the markdown cache beside it — it lags every edit the Y.Doc
// has taken since the read, and it is empty on the failed-read recovery path
// (#564). Exporting it while the only serializer of the canonical doc is
// unmounted writes a file that is not the user's document, and says it saved.
describe("engine-mode export with no mounted serializer", () => {
  it("refuses the export while the engine document has no serializer", async () => {
    const user = userEvent.setup();
    const bridge = engineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridge);

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    // The engine header is up (the document bound); the editor beneath it is
    // still suspended, so there is nothing to serialize the Y.Doc.
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
    expect(screen.queryByTestId("markdown-editor")).toBeNull();

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-export-markdown"));

    // MUTATION: gate the refusal on an EMPTY cache -> the stale read body is
    // exported as if it were the live document.
    expect(await screen.findByText("Document not open")).toBeTruthy();
    expect(bridge.exportDocumentFile).not.toHaveBeenCalled();
  });

  it("exports the read body when the document is not engine-backed", async () => {
    const user = userEvent.setup();
    const bridge = engineBridge(DOC_MARKDOWN, { available: false });
    vi.stubGlobal("dohcDesktop", bridge);

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    // No engine session: the file on disk IS the document, so the plain
    // editor's own serializer answers and the export must still work.
    await screen.findByTestId("markdown-edit-toggle", {}, { timeout: 5_000 });
    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-export-markdown"));

    await vi.waitFor(() =>
      expect(bridge.exportDocumentFile).toHaveBeenCalledTimes(1),
    );
    expect(bridge.exportDocumentFile).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "markdown", content: DOC_MARKDOWN }),
    );
  });
});
