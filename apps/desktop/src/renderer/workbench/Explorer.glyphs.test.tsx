// @vitest-environment jsdom
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { Explorer, TreeRow, type ExplorerProps } from "./Explorer";
import {
  GRAPH_TAB_PATH,
  chatTabPath,
  collectionTabPath,
  momentDiffTabPath,
  siteTabPath,
  versionCompareTabPath,
} from "./workbenchState";

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

function glyphOf(element: Element): SVGSVGElement {
  const glyph = element.querySelector("svg");
  if (!glyph) throw new Error("no glyph");
  return glyph;
}

function file(path: string, kind: WorkspaceFileEntry["kind"] = "file"): WorkspaceFileEntry {
  return { path, kind };
}

function editRowGlyph(): SVGSVGElement {
  const row = screen.getByTestId("tree-edit-input").closest("li");
  if (!row) throw new Error("no edit row");
  return glyphOf(row);
}

describe("Explorer kind glyphs", () => {
  it("draws each file's registry glyph and keeps the row named by its file", () => {
    const paths = [
      "plan.md", "flow.excalidraw", "budget.csv", "package.json", "notes.txt", "app.ts",
      "photo.png", "memo.m4a", "report.pdf", "archive.bin",
    ];
    render(<Explorer {...explorerProps({ files: [...paths.map((path) => file(path)), file("ledger.sqlite", "database")] })} />);
    for (const path of [...paths, "ledger.sqlite"]) {
      const glyph = glyphOf(treeRow(path));
      expect(glyph.classList.contains(`lucide-${fileKindForPath(path).glyphId}`)).toBe(true);
      expect(glyph.getAttribute("width")).toBe("15");
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      // The accessible name is exactly the file name: the glyph adds nothing.
      expect(screen.getByRole("treeitem", { name: path })).toBe(treeRow(path));
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
    expect(glyphOf(treeRow("cache.db")).classList.contains("lucide-file")).toBe(true);
    expect(glyphOf(treeRow("store.bin")).classList.contains("lucide-database")).toBe(true);
    expect(glyphOf(screen.getByTestId("pinned-row")).classList.contains("lucide-database")).toBe(true);
    expect(glyphOf(screen.getByTestId("open-editor-row")).classList.contains("lucide-file")).toBe(true);
  });

  it("shows a page's emoji in place of its glyph without renaming the row", () => {
    render(<Explorer {...explorerProps({ files: [{ path: "launch.md", kind: "file", icon: "🚀" }], pinned: ["launch.md"] })} />);
    for (const row of [treeRow("launch.md"), screen.getByTestId("pinned-row")]) {
      expect(row.querySelector("svg")).toBeNull();
      const hidden = [...row.querySelectorAll("[aria-hidden]")].map((element) => element.textContent);
      expect(hidden).toContain("🚀");
    }
    expect(screen.getByRole("treeitem", { name: "launch.md" })).toBe(treeRow("launch.md"));
    expect(screen.getByRole("button", { name: "launch.md" })).toBe(screen.getByTestId("pinned-row"));
  });

  it("keeps folders on their folder icons", () => {
    render(<Explorer {...explorerProps({ files: [file("notes/plan.md")], folders: ["notes"], pinned: ["notes"] })} />);
    for (const row of [treeRow("notes"), screen.getByTestId("pinned-row")]) {
      const glyph = row.querySelector(".lucide-folder");
      expect(glyph?.getAttribute("width")).toBe("15");
      expect(glyph?.classList.contains("text-subtle")).toBe(true);
    }
  });

  it("draws an app folder's glyph in the folder glyph's box and keeps it a tree row", () => {
    render(
      <Explorer
        {...explorerProps({
          files: [file("site/index.html"), file("notes/plan.md")],
          folders: ["site", "notes"],
          pinned: ["site"],
          expandedFolders: ["site"],
          collectionFolders: new Set(["site"]),
          appFolders: new Set(["site"]),
        })}
      />,
    );
    const app = treeRow("site");
    expect(app.dataset.app).toBe("true");
    expect(app.dataset.collection).toBe("true");
    expect(app.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "site" })).toBe(app);
    for (const row of [app, screen.getByTestId("pinned-row")]) {
      const glyph = row.querySelector(".lucide-app-window");
      expect(glyph?.getAttribute("width")).toBe("15");
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(row.querySelector(".lucide-folder, .lucide-folder-open")).toBeNull();
    }
    expect(treeRow("notes").dataset.app).toBeUndefined();
    expect(treeRow("notes").querySelector(".lucide-folder")).not.toBeNull();
  });

  it("draws every section's glyph at one size, ink on the selected fill and subtle elsewhere", () => {
    render(
      <Explorer
        {...explorerProps({
          files: [file("plan.md"), file("notes.md")],
          pinned: ["notes.md"],
          editorGroups: [{ id: "group-1", tabs: [{ path: "plan.md" }, { path: "notes.md" }], activeTab: "plan.md", size: 1 }],
        })}
      />,
    );
    const [activeEditor, otherEditor] = screen.getAllByTestId("open-editor-row");
    const cases: Array<[HTMLElement | undefined, string]> = [
      [treeRow("plan.md"), "text-ink"],
      [treeRow("notes.md"), "text-subtle"],
      [activeEditor, "text-ink"],
      [otherEditor, "text-subtle"],
      [screen.getByTestId("pinned-row"), "text-subtle"],
    ];
    for (const [row, tone] of cases) {
      if (!row) throw new Error("missing row");
      const glyph = glyphOf(row);
      expect(glyph.getAttribute("width")).toBe("15");
      expect(glyph.classList.contains(tone)).toBe(true);
    }
  });

  describe("open editors", () => {
    function openEditor(path: string): HTMLElement {
      const row = screen.getAllByTestId("open-editor-row").find((candidate) => candidate.dataset.path === path);
      if (!row) throw new Error(`no open editor for ${path}`);
      return row;
    }

    function openEditors(paths: string[], files: WorkspaceFileEntry[], overrides: Partial<ExplorerProps> = {}) {
      render(
        <Explorer
          {...explorerProps({
            files,
            editorGroups: [{ id: "group-1", tabs: paths.map((path) => ({ path })), activeTab: null, size: 1 }],
            ...overrides,
          })}
        />,
      );
    }

    it("takes a database from the listing's header check, as its tab does", () => {
      openEditors(["store.bin", "cache.db", "ledger.sqlite"], [file("store.bin", "database"), file("cache.db"), file("ledger.sqlite", "database")]);
      expect(glyphOf(openEditor("store.bin")).classList.contains("lucide-database")).toBe(true);
      expect(glyphOf(openEditor("cache.db")).classList.contains("lucide-file")).toBe(true);
      expect(glyphOf(openEditor("ledger.sqlite")).classList.contains("lucide-database")).toBe(true);
    });

    it("shows a page's emoji in place of its glyph without renaming the row", () => {
      openEditors(["launch.md"], [{ path: "launch.md", kind: "file", icon: "🚀" }]);
      const row = openEditor("launch.md");
      expect(row.querySelector("svg:not(.lucide-x)")).toBeNull();
      expect(within(row).getByText("🚀").getAttribute("aria-hidden")).toBe("true");
      expect(within(row).getByRole("button", { name: "launch.md" })).toBeTruthy();
    });

    it("draws an app folder's app as its folder row does", () => {
      const app = siteTabPath("site");
      openEditors([app], [file("site/index.html")], { folders: ["site"], appFolders: new Set(["site"]) });
      const glyph = glyphOf(openEditor(app));
      expect(glyph.classList.contains("lucide-app-window")).toBe(true);
      expect(glyph.getAttribute("width")).toBe("15");
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      expect(treeRow("site").querySelector(".lucide-app-window")).not.toBeNull();
    });

    it("draws every other object's glyph from the map tabs use", () => {
      const cases: Array<[string, string]> = [
        [collectionTabPath("people"), "lucide-table-2"],
        [chatTabPath({ kind: "channel", id: "trip" }), "lucide-hash"],
        [chatTabPath({ kind: "dm", id: "person" }), "lucide-message-circle"],
        [versionCompareTabPath("try"), "lucide-layers"],
        [momentDiffTabPath("moment"), "lucide-file-diff"],
        [GRAPH_TAB_PATH, "lucide-workflow"],
      ];
      openEditors(cases.map(([path]) => path), []);
      for (const [path, glyph] of cases) expect(glyphOf(openEditor(path)).classList.contains(glyph)).toBe(true);
    });
  });

  it("lets a drop preview color the glyph with its row", () => {
    const noop = () => undefined;
    render(
      <ul role="tree">
        <TreeRow
          row={{ fullPath: "plan.md", isFolder: false, isExpanded: false, depth: 0, parentPath: null, kind: "file", positionInSet: 1, setSize: 1 }}
          collection={false}
          app={false}
          selected
          active={false}
          tabbable={false}
          dropPreview={{ kind: "blocked", role: "target" }}
          registerRef={noop}
          onRowFocus={noop}
          onRowClick={noop}
          onRowChevronClick={noop}
          onRowContextMenu={noop}
          onRowDragStart={noop}
          onRowDragOver={noop}
          onRowDrop={noop}
          onRowDragLeave={noop}
          onRowDragEnd={noop}
        />
      </ul>,
    );
    const row = treeRow("plan.md");
    expect(row.classList.contains("text-danger")).toBe(true);
    const glyph = glyphOf(row);
    expect(glyph.classList.contains("text-ink")).toBe(false);
    expect(glyph.classList.contains("text-subtle")).toBe(false);
  });

  it("shows the kind of the name being typed when creating and renaming", async () => {
    render(<Explorer {...explorerProps({ files: [file("plan.md")] })} />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const input = await screen.findByTestId("tree-edit-input");
    // An empty draft shows the Markdown default, as does a name without an extension.
    expect(editRowGlyph().classList.contains("lucide-file-text")).toBe(true);
    fireEvent.change(input, { target: { value: "budget.csv" } });
    expect(editRowGlyph().classList.contains("lucide-file-spreadsheet")).toBe(true);
    fireEvent.change(input, { target: { value: "budget" } });
    expect(editRowGlyph().classList.contains("lucide-file-text")).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });

    fireEvent.click(treeRow("plan.md"));
    fireEvent.keyDown(treeRow("plan.md"), { key: "F2" });
    const rename = await screen.findByTestId("tree-edit-input");
    expect(editRowGlyph().classList.contains("lucide-file-text")).toBe(true);
    fireEvent.change(rename, { target: { value: "plan.ts" } });
    expect(editRowGlyph().classList.contains("lucide-file-code")).toBe(true);
    fireEvent.keyDown(rename, { key: "Escape" });
  });

  it.each([
    // A file without an extension stays a plain file.
    ["LICENSE", "NOTICE", "lucide-file"],
    // A name typed without an extension keeps the file's own.
    ["report.csv", "summary", "lucide-file-spreadsheet"],
  ])("keeps %s's kind while renaming it to %s", async (path, name, glyph) => {
    render(<Explorer {...explorerProps({ files: [file(path)] })} />);
    fireEvent.click(treeRow(path));
    fireEvent.keyDown(treeRow(path), { key: "F2" });
    const rename = await screen.findByTestId("tree-edit-input");
    fireEvent.change(rename, { target: { value: name } });
    expect(editRowGlyph().classList.contains(glyph)).toBe(true);
    fireEvent.keyDown(rename, { key: "Escape" });
  });

  it.each([
    // A `.db` the listing does not report as a database stays a plain file.
    ["cache.db", "file", "lucide-file"],
    // A file the listing reports as a database stays one whatever its name.
    ["store.bin", "database", "lucide-database"],
  ] as const)("keeps the listing's kind while renaming %s until the name changes", async (path, listed, glyph) => {
    render(<Explorer {...explorerProps({ files: [file(path, listed)] })} />);
    expect(glyphOf(treeRow(path)).classList.contains(glyph)).toBe(true);
    fireEvent.click(treeRow(path));
    fireEvent.keyDown(treeRow(path), { key: "F2" });
    const rename = await screen.findByTestId("tree-edit-input");
    expect(editRowGlyph().classList.contains(glyph)).toBe(true);
    fireEvent.change(rename, { target: { value: "renamed.csv" } });
    expect(editRowGlyph().classList.contains("lucide-file-spreadsheet")).toBe(true);
    fireEvent.change(rename, { target: { value: path } });
    expect(editRowGlyph().classList.contains(glyph)).toBe(true);
    fireEvent.keyDown(rename, { key: "Escape" });
  });
});

describe("Explorer with no files", () => {
  it("shows the files picture, its line and New file, which starts a file at the root", async () => {
    render(<Explorer {...explorerProps()} />);
    const empty = screen.getByText("This workspace has no files yet.").parentElement!;
    expect(empty.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(empty.textContent).toBe("This workspace has no files yet.New file");
    fireEvent.click(within(empty).getByRole("button", { name: "New file" }));
    expect(await screen.findByTestId("tree-edit-input")).toBeTruthy();
    expect(screen.queryByText("This workspace has no files yet.")).toBeNull();
  });
});
