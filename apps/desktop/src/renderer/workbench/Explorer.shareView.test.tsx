// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";
import { newPageTabPath } from "./workbenchState";

afterEach(cleanup);

// What a delete promises.
//
// An ordinary workspace's delete goes to a trash with a recovery record, and
// its notice offers Undo, so it runs without asking.
//
// A share view's delete removes the projection of a moment. There is no trash
// on that path, so the local copy goes irreversibly, and `AGENTS.md` requires
// telling the user that before an irreversible change runs, not after. What
// can still be taken back is the change, because the granter's copy is
// untouched until they accept it. The dialog has to say that, or it is a
// durability promise dohc cannot keep.

const GRANTER = "granter@dohc.test";

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    mode: "files",
    onModeChange: vi.fn(),
    listed: true,
    files: [
      { path: "note.md", kind: "file" },
      { path: "other.md", kind: "file" },
    ],
    folders: [],
    editorGroups: [{ id: "group-1", tabs: [{ path: "note.md" }], activeTab: "note.md", size: 1 }],
    activeEditorGroup: "group-1",
    dirtyPaths: new Set(),
    shareView: null,
    recoveryPaths: new Set(),
    expandedFolders: [],
    pinned: [],
    openEditorsHeight: 200,
    onOpenEditorsHeightChange: vi.fn(),
    newFolderRequest: null,
    onNewPage: vi.fn(),
    onOpenFile: vi.fn(),
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseAllTabs: vi.fn(),
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
    listingRequest: 0,
    onRefresh: vi.fn(() => 1),
    onError: vi.fn(),
    onNotice: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function confirmText(select: "one" | "two"): string {
  const rows = within(screen.getByTestId("file-tree")).getAllByTestId("tree-row");
  fireEvent.click(rows[0]!);
  if (select === "two") fireEvent.click(rows[1]!, { ctrlKey: true });
  fireEvent.keyDown(rows[0]!, { key: "Delete" });
  return screen.getByTestId("delete-confirm").textContent ?? "";
}

describe("the delete confirmation states where the file goes", () => {
  it("asks nothing in an ordinary workspace, where the delete can be undone", async () => {
    const deleteWorkspacePath = vi.fn(async () => ({ trashed: true }));
    vi.stubGlobal("dohcDesktop", { deleteWorkspacePath });
    try {
      render(<Explorer {...explorerProps()} />);
      const rows = within(screen.getByTestId("file-tree")).getAllByTestId("tree-row");
      fireEvent.click(rows[0]!);
      fireEvent.keyDown(rows[0]!, { key: "Delete" });
      expect(screen.queryByTestId("delete-confirm")).toBeNull();
      await waitFor(() =>
        expect(deleteWorkspacePath).toHaveBeenCalledWith({
          workspaceId: "workspace-1",
          relativePath: "note.md",
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("states the local delete is irreversible, and names who still has the file", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: GRANTER } })} />);
    const text = confirmText("one");
    expect(
      text,
      "a share view's delete has no trash to restore from, so promising one is a durability claim dohc cannot keep",
    ).not.toContain("system trash");
    expect(text).not.toContain(".dohc/local/trash");
    expect(text).not.toContain("where you can restore");
    expect(text).toContain("It goes from your copy now.");
    expect(
      text,
      "the recipient's local copy goes with no trash behind it, and nothing says so before they confirm",
    ).toContain("There is no trash to restore it from.");
    expect(
      text,
      "a delete that describes the granter instead of naming them leaves the reader guessing who to ask",
    ).toContain(GRANTER);
    expect(text).toContain("You can take the change back before then.");
  });

  it("reads as plural for a multi-file selection", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: GRANTER } })} />);
    const text = confirmText("two");
    expect(text).toContain("2 items");
    expect(
      text,
      "a singular sentence over a multi-file selection is wrong on the surface that decides a delete",
    ).toContain("They go from your copy now.");
    expect(text).toContain("There is no trash to restore them from.");
    expect(text).toContain("still has them until");
  });

  it("falls back to a description when the grant names no granter", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: null } })} />);
    const text = confirmText("one");
    expect(text).toContain("The person who shared it still has it");
  });
});

describe("creating in a joined workspace", () => {
  const joined = { granterEmail: GRANTER };
  const header = () => within(screen.getByTestId("explorer-files-header"));

  it("offers a new page at Edit and hides page and folder creation below it", () => {
    render(<Explorer {...explorerProps({ shareView: joined, creates: { pages: false, folders: false } })} />);
    expect(header().queryByRole("button", { name: "New page" })).toBeNull();
    expect(header().queryByRole("button", { name: "New folder" })).toBeNull();
    cleanup();

    const onNewPage = vi.fn();
    render(<Explorer {...explorerProps({ shareView: joined, creates: { pages: true, folders: false }, onNewPage })} />);
    fireEvent.click(header().getByRole("button", { name: "New page" }));
    expect(onNewPage).toHaveBeenCalledWith("");
    expect(header().queryByRole("button", { name: "New folder" })).toBeNull();
  });

  it("lets an admin name a new folder and opens its first page there, with no empty folder", async () => {
    const createWorkspaceFolder = vi.fn();
    window.dohcDesktop = { createWorkspaceFolder } as unknown as typeof window.dohcDesktop;
    const onNewPage = vi.fn();
    try {
      render(<Explorer {...explorerProps({ shareView: joined, creates: { pages: true, folders: true }, onNewPage })} />);
      fireEvent.click(header().getByRole("button", { name: "New folder" }));
      const name = await screen.findByRole("textbox", { name: "New folder name" });
      fireEvent.change(name, { target: { value: "Plans" } });
      fireEvent.keyDown(name, { key: "Enter" });
      expect(onNewPage).toHaveBeenCalledWith("Plans");
      expect(createWorkspaceFolder).not.toHaveBeenCalled();
    } finally {
      delete window.dohcDesktop;
    }
  });

  it("shows the folder an admin named while its first page is open, and drops it when the page closes", () => {
    const rows = () => within(screen.getByTestId("file-tree")).getAllByTestId("tree-row").map((row) => row.dataset.path);
    const page = newPageTabPath("page-1", "Plans/Week 1");
    const props = explorerProps({ shareView: joined, creates: { pages: true, folders: true }, expandedFolders: ["Plans"] });
    const { rerender } = render(<Explorer {...props} />);
    expect(rows()).toEqual(["note.md", "other.md"]);
    rerender(<Explorer {...props} editorGroups={[{ id: "group-1", tabs: [{ path: "note.md" }, { path: page }], activeTab: page, size: 1 }]} />);
    expect(rows()).toEqual(["Plans", "Plans/Week 1", "note.md", "other.md"]);
    // Cancel: the page closes unwritten, and its folder goes with it.
    rerender(<Explorer {...props} />);
    expect(rows()).toEqual(["note.md", "other.md"]);
  });
});

describe("changing files where this person can't", () => {
  const joined = { granterEmail: GRANTER };
  const rowOf = (path: string) =>
    within(screen.getByTestId("file-tree")).getAllByTestId("tree-row").find((row) => row.dataset.path === path)!;
  const homeRowOf = (key: string) => document.querySelector<HTMLElement>(`[data-home-key="${key}"]`)!;
  const osFiles = () => ({ dropEffect: "copy", effectAllowed: "all", files: [new File(["x"], "a.txt")], types: ["Files"], setData: vi.fn() });

  it("opens no rename, delete, move or import in Files at View, Comment, or as another account", () => {
    const onImportFiles = vi.fn();
    const deleteWorkspacePath = vi.fn();
    const moveWorkspacePath = vi.fn();
    vi.stubGlobal("dohcDesktop", { deleteWorkspacePath, moveWorkspacePath, getDroppedFilePaths: () => ["C:/a.txt"] });
    try {
      render(<Explorer {...explorerProps({ shareView: joined, changes: false, onImportFiles, folders: ["Plans"], files: [{ path: "note.md", kind: "file" }, { path: "Plans/a.md", kind: "file" }] })} />);
      fireEvent.click(rowOf("note.md"));
      fireEvent.keyDown(rowOf("note.md"), { key: "F2" });
      expect(screen.queryByTestId("tree-edit-input")).toBeNull();
      fireEvent.keyDown(rowOf("note.md"), { key: "Delete" });
      expect(screen.queryByTestId("delete-confirm")).toBeNull();

      expect(rowOf("note.md").getAttribute("draggable")).toBe("false");
      const move = { effectAllowed: "move", dropEffect: "move", files: [], types: [], setData: vi.fn() };
      fireEvent.dragStart(rowOf("note.md"), { dataTransfer: move });
      // A drop target that takes nothing leaves the drag over it unprevented.
      expect(fireEvent.dragOver(rowOf("Plans"), { dataTransfer: move })).toBe(true);
      fireEvent.drop(rowOf("Plans"), { dataTransfer: move });
      expect(moveWorkspacePath).not.toHaveBeenCalled();

      const tree = screen.getByTestId("file-tree");
      expect(fireEvent.dragOver(tree, { dataTransfer: osFiles() })).toBe(true);
      fireEvent.drop(tree, { dataTransfer: osFiles() });
      expect(fireEvent.dragOver(rowOf("Plans"), { dataTransfer: osFiles() })).toBe(true);
      fireEvent.drop(rowOf("Plans"), { dataTransfer: osFiles() });
      expect(onImportFiles).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens no rename, delete or drag from Home's rows either", () => {
    render(<Explorer {...explorerProps({ mode: "home", shareView: joined, changes: false })} />);
    act(() => homeRowOf("pages:note.md").focus());
    fireEvent.keyDown(homeRowOf("pages:note.md"), { key: "F2" });
    expect(screen.queryByTestId("tree-edit-input")).toBeNull();
    fireEvent.keyDown(homeRowOf("pages:note.md"), { key: "Delete" });
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    expect(homeRowOf("pages:note.md").getAttribute("draggable")).toBeNull();
  });

  it("keeps rename, delete and drag at Edit", async () => {
    const onImportFiles = vi.fn();
    vi.stubGlobal("dohcDesktop", { getDroppedFilePaths: () => ["C:/a.txt"] });
    try {
      render(<Explorer {...explorerProps({ shareView: joined, changes: true, onImportFiles })} />);
      fireEvent.click(rowOf("note.md"));
      fireEvent.keyDown(rowOf("note.md"), { key: "F2" });
      fireEvent.keyDown(await screen.findByTestId("tree-edit-input"), { key: "Escape" });
      fireEvent.keyDown(rowOf("note.md"), { key: "Delete" });
      expect(screen.getByTestId("delete-confirm")).toBeTruthy();
      expect(rowOf("other.md").getAttribute("draggable")).toBe("true");
      const tree = screen.getByTestId("file-tree");
      expect(fireEvent.dragOver(tree, { dataTransfer: osFiles() })).toBe(false);
      fireEvent.drop(tree, { dataTransfer: osFiles() });
      expect(onImportFiles).toHaveBeenCalledWith(["C:/a.txt"], "");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
