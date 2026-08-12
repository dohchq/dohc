// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";

// Finding: in engine mode the DocumentMenu export must serialize the LIVE
// editor (collab-bound to the engine Y.Doc), not the stale props.body that
// serializeDraftRef falls back to whenever the inline properties surface is
// present or the doc opened in read/truncated mode. We prove this with the
// properties rendered (the exact state where the old code returned the stale
// disk body) and assert the exported markdown is the live editor body.
//
// Mocks the full UseEngineDoc contract, not just the fields this file reads —
// a partial mock silently hands undefined to a `!== null` check elsewhere in
// FileInspector.tsx (removalInProgress), which is not the same as null.
const engineDocState: UseEngineDoc = {
  available: false,
  opening: false,
  doc: null,
  objectId: null,
  versionId: null,
  saveState: "saved",
  notInVersion: false,
  engineMayHoldDocument: false,
  deletedWhileEditing: false,
  deletedDraftId: null,
  readOnlyWhileEditing: false,
  removalInProgress: null,
  artifactAssets: [],
  readArtifactAsset: async () => {
    throw new Error("no artifact asset");
  },
};

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

    // Inline properties always render under the title now — the state where
    // serializeDraftRef used to return the stale disk body.
    await screen.findByTestId("properties-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LIVE_BODY));
    expect(writeText).not.toHaveBeenCalledWith("# Stale disk body\n");
  });

  it("carries LIVE frontmatter (title/icon) edits, not the mount-time markdown", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    // Title / icon edits land in the engine Y.Doc frontmatter MAP (PageIdentity
    // writes there), never in latestDraft.current — so an export must read the
    // live map, not the stale mount-time frontmatter.
    engineDocState.doc!.getMap("frontmatter").set("title", "Live Title");
    engineDocState.doc!.getMap("frontmatter").set("icon", "🚀");

    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("editor-stub");

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `---\ntitle: Live Title\nicon: 🚀\n---\n${LIVE_BODY}`,
      ),
    );
  });
});
