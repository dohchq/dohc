// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import { FileInspector } from "./FileInspector";

// The file reader and the plugin README share one markdown component map, so
// a document reads the same wherever dohc shows it. The map itself is pinned
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
  saveState: "saved",
  saveError: null,
  notInVersion: false,
  engineMayHoldDocument: false,
  artifactAssetsInvalid: false,
  deletedWhileEditing: false,
  deletedDraftId: null,
  recoveryAssets: null,
  permanentFailureWhileEditing: false,
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

const TABLE_DOCUMENT = [
  "# Limits",
  "",
  "| Field | Limit |",
  "| --- | ---: |",
  "| name | 214 |",
  "| entry | 1024 |",
  "",
].join("\n");

describe("FileInspector renders markdown through the shared component map", () => {
  const bridgeMock = {
    // A truncated read opens in read mode, which is where the rendered
    // document — rather than the editor — is what the reader looks at.
    readWorkspaceText: vi.fn(async () => ({
      text: TABLE_DOCUMENT,
      truncated: true,
    })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
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
    // The shared map's own table wrapper: a wide table scrolls inside itself
    // so the page never scrolls sideways. react-markdown's bare table has no
    // wrapper at all, which is what makes this the probe for the map.
    expect(pane.parentElement?.className).toContain("overflow-x-auto");
  });
});
