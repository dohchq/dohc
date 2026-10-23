// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "../workspaces/workspaceTextLimits";

// Collect the real lazy modules before hook and renderer assertion timers start.
import "./markdown/IncrementalMarkdownDocument";
import "./editor/MarkdownEditor";
import "./SourceCodeEditor";

// The file reader renders through the shared markdown component map, so a
// document reads the same wherever dohc shows it. The map itself is pinned
// beside it (markdownComponents.test.tsx); this pins that the reader still
// hands it over — nothing else renders a table through FileInspector, so the
// reader could quietly fall back to react-markdown's bare defaults and every
// other test would stay green.
//
// Mocks the full UseEngineDoc contract, not just the fields this file reads —
// a partial mock hands undefined to a `!== null` check elsewhere in
// FileInspector.tsx (removalInProgress), which is not the same as null.
const engineDocState: UseEngineDoc = {
  available: false,
  opening: false,
  doc: null,
  objectId: null,
  versionId: null,
  saveState: { kind: "saved-here" },
  saveError: null,
    authorCapacity: false,
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
  changedOutside: null,
  outsideWriteWaiting: false,
  unsavedEditsPending: () => false,
  readOnlyWhileEditing: false,
  readOnlyDraftId: null,
  readOnlyCause: null,
  retryReplacement: null,
  replacedDraftIds: [],
  removalInProgress: null,
  artifactAssets: [],
  readArtifactAsset: async () => {
    throw new Error("no artifact asset");
  },
  flushPendingLocalUpdates: async () => undefined,
};

vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: () => engineDocState,
}));

const TABLE_DOCUMENT = [
  "# Limits",
  "",
  "| Field | Limit |",
  "| --- | ---: |",
  "| name | 214 |",
  "| entry | 1024 |",
  "",
  // Cross the WYSIWYG threshold without using a truncated read. This
  // test owns the non-truncated rich-read branch; the test below owns the
  // bounded source branch for truncated Markdown.
  "x".repeat(WYSIWYG_MARKDOWN_THRESHOLD_BYTES),
  "",
].join("\n");

describe("FileInspector renders markdown through the shared component map", () => {
  const bridgeMock = {
    // A document over the WYSIWYG threshold opens in read mode, which is where
    // the rendered document — rather than the editor — is what this test reads.
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn(async () => ({
      text: TABLE_DOCUMENT,
      truncated: false,
    })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    openFileExternally: vi.fn(async () => undefined),
    linksIn: vi.fn(async () => null),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [{ path: "a.md", kind: "file" }],
      folders: [],
    })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
  };

  beforeEach(() => {
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
  });

  it("opens a note over the limit in bytes as the read preview, even under it in characters", async () => {
    // A live session seeds at most WYSIWYG_MARKDOWN_THRESHOLD_BYTES of UTF-8,
    // so the WYSIWYG editor must not open a note past it without one (#2521).
    // Each sentence is 10 characters and 30 bytes.
    const japanese = `# 長いメモ\n\n${"長いメモの段落です。".repeat(Math.floor(WYSIWYG_MARKDOWN_THRESHOLD_BYTES / 20))}\n`;
    expect(japanese.length).toBeLessThan(WYSIWYG_MARKDOWN_THRESHOLD_BYTES);
    expect(new TextEncoder().encode(japanese).byteLength).toBeGreaterThan(WYSIWYG_MARKDOWN_THRESHOLD_BYTES);
    const read = bridgeMock.readWorkspaceText.getMockImplementation();
    bridgeMock.readWorkspaceText.mockImplementation(async () => ({ text: japanese, truncated: false }));
    try {
      render(<FileInspector workspaceId="ws-1" path="a.md" />);
      expect((await screen.findByTestId("markdown-edit-toggle")).textContent).toContain("Edit");
    } finally {
      if (read) bridgeMock.readWorkspaceText.mockImplementation(read);
    }
  });

  it("shows a table as a table, inside the wrapper that keeps the page from scrolling sideways", async () => {
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");

    const pane = await waitFor(() => {
      const found = view.container.querySelector(".dohc-readable-text table");
      expect(found).not.toBeNull();
      return found as HTMLTableElement;
    });

    expect(Array.from(pane.querySelectorAll("th")).map((cell) => cell.textContent))
      .toEqual(["Field", "Limit"]);
    expect(Array.from(pane.querySelectorAll("td")).map((cell) => cell.textContent))
      .toEqual(["name", "214", "entry", "1024"]);
    // The reader sees a document, never its source.
    expect(view.container.querySelector(".dohc-readable-text")?.textContent)
      .not.toContain("|");
    // The shared map's own table wrapper, the editor's: a wide table scrolls
    // inside itself so the page never scrolls sideways. react-markdown's bare
    // table has no wrapper at all, which is what makes this the probe for the
    // map.
    expect(pane.parentElement?.className).toBe("tableWrapper");
  });

  it("shows truncated markdown in the bounded read-only source viewer", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Large document\n\nThis is the bounded prefix.\n",
      truncated: true,
    });
    const view = render(<FileInspector workspaceId="ws-1" path="large.md" />);

    const source = await screen.findByTestId("markdown-source-view");
    const content = await waitFor(() => {
      const found = source.querySelector(".cm-content");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(content.textContent).toContain("# Large document");
    expect(screen.getByTestId("view-markdown")).toBeTruthy();
    expect(view.container.querySelector(".dohc-readable-text")).toBeNull();
    expect(screen.getByTestId("truncated-notice")).toBeTruthy();
    // About lists the links into a document, so the document asks for none.
    expect(bridgeMock.linksIn).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Open the full file externally" }),
    );
    await waitFor(() =>
      expect(bridgeMock.openFileExternally).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "large.md",
      }),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });
});
