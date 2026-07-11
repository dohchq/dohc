// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineDocSaveState } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";

// Finding: in engine mode the DocumentMenu export must serialize the LIVE
// editor (collab-bound to the engine Y.Doc), not the stale props.body that
// serializeDraftRef falls back to whenever the properties panel is open or the
// doc opened in read/truncated mode. We prove this by opening the properties
// panel (the exact state where the old code returned the stale disk body) and
// asserting the exported markdown is the live editor body.

const engineDocState: {
  available: boolean;
  doc: Y.Doc | null;
  saveState: EngineDocSaveState;
} = { available: false, doc: null, saveState: "saved" };

vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: () => engineDocState,
}));

// A stub editor that reports a live body distinct from the disk body, so the
// test can tell whether the menu read the editor or the stale prop.
const LIVE_BODY = "# Live engine body\n";
vi.mock("./editor/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef<{ focus: () => void; getMarkdown: () => string }>(
    function MarkdownEditorStub(_props, ref) {
      useImperativeHandle(ref, () => ({
        focus: () => {},
        getMarkdown: () => LIVE_BODY,
      }));
      return <div data-testid="editor-stub" />;
    },
  ),
}));

vi.mock("./PropertiesPanel", () => ({
  PropertiesPanel: () => <div data-testid="properties-stub" />,
}));

vi.mock("./PageIdentity", () => ({
  PageIdentity: () => <div data-testid="page-identity-stub" />,
}));

const writeText = vi.fn(async () => {});

describe("engine-mode DocumentMenu exports the live editor body, not stale props.body", () => {
  const bridgeMock = {
    readWorkspaceText: vi.fn(async () => ({
      text: "# Stale disk body\n",
      truncated: false,
    })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [{ path: "a.md", kind: "file" }],
      folders: [],
    })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
  };

  beforeEach(() => {
    engineDocState.available = true;
    engineDocState.doc = new Y.Doc();
    engineDocState.saveState = "saved";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    engineDocState.available = false;
    engineDocState.doc = null;
  });

  it("copies the live editor markdown even while the properties panel is open", async () => {
    const user = userEvent.setup();
    // navigator.clipboard is defined AFTER userEvent.setup() so its own stub
    // doesn't shadow ours (same ordering the DocumentMenu unit test relies on).
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    // Editor mounts once the file text loads (async IPC).
    await screen.findByTestId("editor-stub");

    // Open the properties panel — the state where serializeDraftRef used to
    // return the stale disk body.
    await user.click(screen.getByTestId("markdown-properties-toggle"));
    await screen.findByTestId("properties-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LIVE_BODY));
    expect(writeText).not.toHaveBeenCalledWith("# Stale disk body\n");
  });
});
