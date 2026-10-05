// @vitest-environment jsdom
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [],
    folders: [],
    editorGroups: [{ id: "group-1", tabs: [], activeTab: null, size: 1 }],
    activeEditorGroup: "group-1",
    dirtyPaths: new Set(),
    shareView: null,
    recoveryPaths: new Set(),
    expandedFolders: [],
    pinned: [],
    openEditorsHeight: 180,
    onOpenEditorsHeightChange: vi.fn(),
    createRequest: null,
    onOpenFile: vi.fn(),
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseAllTabs: vi.fn(),
    onNewUntitledTextFile: vi.fn(),
    onCollapseFolders: vi.fn(),
    onSetFolderExpanded: vi.fn(),
    onToggleFolder: vi.fn(),
    onTogglePin: vi.fn(),
    collectionFolders: new Set<string>(),
    onOpenCollection: vi.fn(),
    onPathsChanged: vi.fn(),
    onImportFiles: vi.fn(),
    onRefreshShareMounts: vi.fn(),
    onUnmountShare: vi.fn(),
    onShare: vi.fn(),
    onRefresh: vi.fn(),
    onError: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function treeRow(path: string): HTMLElement {
  const row = screen.getAllByTestId("tree-row").find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  return row;
}

function file(path: string, kind: WorkspaceFileEntry["kind"] = "file"): WorkspaceFileEntry {
  return { path, kind };
}

describe("Explorer kind glyphs", () => {
  it("draws each file's registry glyph, labelled by its kind's name", () => {
    const paths = [
      "plan.md", "flow.excalidraw", "budget.csv", "package.json", "notes.txt", "app.ts",
      "photo.png", "memo.m4a", "report.pdf", "archive.bin",
    ];
    render(<Explorer {...explorerProps({ files: [...paths.map((path) => file(path)), file("ledger.sqlite", "database")] })} />);
    for (const path of [...paths, "ledger.sqlite"]) {
      const kind = fileKindForPath(path);
      const glyph = within(treeRow(path)).getByRole("img");
      expect(glyph.getAttribute("aria-label")).toBe(kind.name);
      expect(glyph.classList.contains(`lucide-${kind.glyphId}`)).toBe(true);
      expect(glyph.getAttribute("width")).toBe("15");
      // The glyph adds no words: the row still reads as its file name.
      expect(treeRow(path).textContent).toBe(path);
    }
  });

  it("takes a database from the listing, not from the file name", () => {
    render(
      <Explorer
        {...explorerProps({
          files: [file("cache.db"), file("store.bin", "database")],
          pinned: ["store.bin"],
          editorGroups: [{ id: "group-1", tabs: [{ path: "cache.db" }], activeTab: null, size: 1 }],
        })}
      />,
    );
    expect(within(treeRow("cache.db")).getByRole("img").getAttribute("aria-label")).toBe("File");
    expect(within(treeRow("store.bin")).getByRole("img").getAttribute("aria-label")).toBe("Database");
    expect(within(screen.getByTestId("pinned-row")).getByRole("img").getAttribute("aria-label")).toBe("Database");
    expect(within(screen.getByTestId("open-editor-row")).getByRole("img").getAttribute("aria-label")).toBe("File");
  });

  it("shows a page's emoji in place of its glyph, still labelled by its kind", () => {
    render(<Explorer {...explorerProps({ files: [{ path: "launch.md", kind: "file", icon: "🚀" }], pinned: ["launch.md"] })} />);
    for (const row of [treeRow("launch.md"), screen.getByTestId("pinned-row")]) {
      const glyph = within(row).getByRole("img", { name: "Document" });
      expect(glyph.textContent).toBe("🚀");
      expect(row.querySelector("svg")).toBeNull();
    }
  });

  it("keeps folders on their folder icons", () => {
    render(<Explorer {...explorerProps({ files: [file("notes/plan.md")], folders: ["notes"] })} />);
    const folder = treeRow("notes");
    expect(within(folder).queryByRole("img")).toBeNull();
    expect(folder.querySelector(".lucide-folder")?.getAttribute("width")).toBe("15");
  });

  it("draws the glyph in ink on a row with the selected fill and subtle elsewhere", () => {
    render(
      <Explorer
        {...explorerProps({
          files: [file("plan.md"), file("notes.md")],
          editorGroups: [{ id: "group-1", tabs: [{ path: "plan.md" }], activeTab: "plan.md", size: 1 }],
        })}
      />,
    );
    expect(within(treeRow("plan.md")).getByRole("img").classList.contains("text-ink")).toBe(true);
    expect(within(treeRow("notes.md")).getByRole("img").classList.contains("text-subtle")).toBe(true);
  });
});
