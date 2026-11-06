// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";
import { newPageTabPath } from "./workbenchState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    mode: "files",
    onModeChange: vi.fn(),
    listed: true,
    recentFiles: [],
    files: [
      { path: "apps/reading-list/index.html", kind: "file" },
      { path: "notes.md", kind: "file" },
    ],
    folders: ["apps", "apps/reading-list"],
    editorGroups: [{ id: "group-1", tabs: [], activeTab: null, size: 1 }],
    activeEditorGroup: "group-1",
    dirtyPaths: new Set(),
    shareView: null,
    recoveryPaths: new Set(),
    expandedFolders: [],
    pinned: [],
    openEditorsHeight: 180,
    onOpenEditorsHeightChange: vi.fn(),
    newFolderRequest: null,
    onNewPage: vi.fn(),
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

function Fixture(props: ExplorerProps) {
  return (
    <>
      <Explorer {...props} />
      <button>After tree</button>
    </>
  );
}

function row(path: string): HTMLElement {
  const result = screen.getAllByRole("treeitem").find((item) => item.dataset.path === path);
  if (!result) throw new Error(`Missing tree row: ${path}`);
  return result;
}

function expectTabStop(path: string) {
  expect(screen.getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toEqual([row(path)]);
  for (const item of screen.getAllByRole("treeitem")) {
    expect(item.tabIndex).toBe(item.dataset.path === path ? 0 : -1);
  }
}

async function tabIntoTree(user: ReturnType<typeof userEvent.setup>, path: string) {
  screen.getByRole("button", { name: "Collapse folders in explorer" }).focus();
  await user.tab();
  expect(document.activeElement).toBe(row(path));
  expectTabStop(path);
}

describe("Explorer tree tab stop", () => {
  it("enters the first row without prior focus, moves with arrows, and leaves in one Tab", async () => {
    const user = userEvent.setup();
    render(<Fixture {...explorerProps()} />);

    expectTabStop("apps");
    await tabIntoTree(user, "apps");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("notes.md"));
    expectTabStop("notes.md");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After tree" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(row("notes.md"));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse folders in explorer" }));
  });

  it("re-enters at the selected row", async () => {
    const user = userEvent.setup();
    render(<Fixture {...explorerProps()} />);

    await user.click(row("notes.md"));
    expect(row("notes.md").getAttribute("aria-selected")).toBe("true");
    await tabIntoTree(user, "notes.md");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After tree" }));
  });

  it("falls back to the first visible row after the selected row is deleted", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    const view = render(<Fixture {...props} />);
    await user.click(row("notes.md"));

    view.rerender(<Fixture {...props} files={props.files.filter((file) => file.path !== "notes.md")} />);

    expectTabStop("apps");
    await tabIntoTree(user, "apps");
    await user.keyboard("{ArrowRight}");
    expect(props.onSetFolderExpanded).toHaveBeenCalledWith("apps", true);
  });

  it("falls back after the selected row is collapsed away", async () => {
    const user = userEvent.setup();
    const props = explorerProps({ expandedFolders: ["apps", "apps/reading-list"] });
    const view = render(<Fixture {...props} />);
    await user.click(row("apps/reading-list/index.html"));

    view.rerender(<Fixture {...props} expandedFolders={[]} />);

    expectTabStop("apps");
    await tabIntoTree(user, "apps");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("notes.md"));
  });

  it("uses a remaining selection when the focused row disappears", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    const view = render(<Fixture {...props} />);
    await user.click(row("notes.md"));
    await user.keyboard("{ArrowUp}");

    view.rerender(
      <Fixture
        {...props}
        folders={[]}
        files={[{ path: "a.md", kind: "file" }, { path: "notes.md", kind: "file" }]}
      />,
    );

    expectTabStop("notes.md");
    await tabIntoTree(user, "notes.md");
  });

  it("keeps the initial tab stop mounted when a virtualized tree scrolls", async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: 500 }, (_, index) => ({
      path: `file-${String(index).padStart(4, "0")}.md`,
      kind: "file" as const,
    }));
    render(<Fixture {...explorerProps({ folders: [], files })} />);
    const tree = screen.getByTestId("file-tree");
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 280 });
    vi.spyOn(screen.getByRole("tree"), "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, -5600, 200, 14000),
    );
    fireEvent.scroll(tree, { target: { scrollTop: 5600 } });

    expect(row("file-0200.md")).toBeDefined();
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(64);
    expectTabStop("file-0000.md");
    await tabIntoTree(user, "file-0000.md");
  });
});

describe("active and picked rows", () => {
  const TINT = "bg-(--dohc-selection)";
  const untitled = newPageTabPath("page-1", "");
  const opened = (activeTab: string | null) => ({
    editorGroups: [
      { id: "group-1", tabs: activeTab ? [{ path: activeTab }] : [], activeTab, size: 1 },
    ],
  });
  const expanded = { expandedFolders: ["apps", "apps/reading-list"] };
  const marked = () =>
    screen
      .getAllByRole("treeitem")
      .filter((item) => item.className.includes(TINT) || item.className.includes("bg-selected"))
      .map((item) => item.dataset.path);

  it("marks no row active when the active tab is not a tree path", () => {
    render(<Fixture {...explorerProps({ ...expanded, ...opened(untitled) })} />);
    expect(marked()).toEqual([]);
    expect(screen.getAllByRole("treeitem").some((item) => item.className.includes("font-medium"))).toBe(false);
  });

  it("shows one click as one active row with no tint", async () => {
    const user = userEvent.setup();
    const props = explorerProps(expanded);
    const view = render(<Fixture {...props} />);
    await user.click(row("notes.md"));
    view.rerender(<Fixture {...props} {...opened("notes.md")} />);

    expect(marked()).toEqual(["notes.md"]);
    expect(row("notes.md").className).toContain("bg-selected");
    expect(row("notes.md").className).toContain("font-medium");
    expect(row("notes.md").className).not.toContain(TINT);
    expect(row("notes.md").getAttribute("aria-selected")).toBe("true");
  });

  it("tints two picked rows, and the open one keeps its weight after focus leaves", async () => {
    const user = userEvent.setup();
    const props = explorerProps(expanded);
    const view = render(<Fixture {...props} />);
    await user.click(row("notes.md"));
    view.rerender(<Fixture {...props} {...opened("notes.md")} />);
    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    await user.click(screen.getByRole("button", { name: "After tree" }));

    for (const path of ["notes.md", "apps/reading-list/index.html"]) {
      expect(row(path).className).toContain(TINT);
      expect(row(path).className).not.toContain("bg-selected");
      expect(row(path).getAttribute("aria-selected")).toBe("true");
    }
    expect(row("notes.md").className).toContain("font-medium");
    expect(row("apps/reading-list/index.html").className).not.toContain("font-medium");

    // Clearing the pick returns the open file to the active fill.
    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    expect(marked()).toEqual(["notes.md"]);
    expect(row("notes.md").className).toContain("bg-selected");
  });

  it("tints a folder clicked while a file is open, and keeps the file active", async () => {
    const user = userEvent.setup();
    render(<Fixture {...explorerProps({ ...expanded, ...opened("notes.md") })} />);
    await user.click(row("apps"));

    expect(row("apps").className).toContain(TINT);
    expect(row("apps").getAttribute("aria-selected")).toBe("true");
    expect(row("notes.md").className).toContain("bg-selected");
    expect(row("notes.md").className).toContain("font-medium");
    expect(row("notes.md").className).not.toContain(TINT);
  });

  it("keeps a folder picked on purpose when another editor becomes active", async () => {
    const user = userEvent.setup();
    const props = explorerProps({ ...expanded, ...opened("notes.md") });
    const view = render(<Fixture {...props} />);
    await user.click(row("apps"));
    view.rerender(<Fixture {...props} {...opened(untitled)} />);

    expect(marked()).toEqual(["apps"]);
    expect(row("apps").className).toContain(TINT);
  });
});

// A click that opened a file selects only that file. When a new page takes
// the editor, nothing in the tree is selected, so Delete acts on the focused
// row.
describe("the open file's selection after a new page opens", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function openThenNewPage() {
    const deleteWorkspacePath = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("dohcDesktop", { platform: "win32", deleteWorkspacePath });
    const user = userEvent.setup();
    const props = explorerProps({ shareView: { granterEmail: "owner@example.test" } });
    const view = render(<Fixture {...props} />);
    await user.click(row("notes.md"));
    const groups = (activeTab: string) => [{ id: "group-1", tabs: [{ path: activeTab }], activeTab, size: 1 }];
    view.rerender(<Fixture {...props} editorGroups={groups("notes.md")} />);
    view.rerender(<Fixture {...props} editorGroups={groups(newPageTabPath("page-1", ""))} />);
    return { user, deleteWorkspacePath };
  }

  it("fills no row", async () => {
    await openThenNewPage();
    for (const item of screen.getAllByRole("treeitem")) {
      expect(item.getAttribute("aria-selected")).toBe("false");
      expect(item.className).not.toContain("bg-selected");
      expect(item.className).not.toContain("bg-(--dohc-selection)");
    }
  });

  it("enters the tree at the file that was open, which Delete would act on", async () => {
    const { user } = await openThenNewPage();
    await tabIntoTree(user, "notes.md");
  });

  it("deletes the focused row, not the file that was open", async () => {
    const { user, deleteWorkspacePath } = await openThenNewPage();
    row("apps").focus();
    await user.keyboard("{Delete}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledTimes(1));
    expect(deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-1", relativePath: "apps" });
  });

  it("deletes the file that was open when its row has focus", async () => {
    const { user, deleteWorkspacePath } = await openThenNewPage();
    row("notes.md").focus();
    await user.keyboard("{Delete}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledTimes(1));
    expect(deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-1", relativePath: "notes.md" });
  });
});

describe("macOS file tree keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["darwin", "⌘⌫ asks", { key: "Backspace", metaKey: true }, true],
    ["darwin", "⌫ alone does not ask", { key: "Backspace" }, false],
    ["darwin", "Delete asks", { key: "Delete" }, true],
    ["win32", "Meta+Backspace does not ask", { key: "Backspace", metaKey: true }, false],
    ["win32", "Delete asks", { key: "Delete" }, true],
  ] as const)("on %s, %s to delete the selection", (platform, _name, init, asks) => {
    vi.stubGlobal("dohcDesktop", { platform });
    render(<Fixture {...explorerProps()} />);
    fireEvent.click(row("notes.md"));
    fireEvent.keyDown(row("notes.md"), init);
    expect(screen.queryByTestId("delete-confirm") !== null).toBe(asks);
  });

  it("adds a row to the selection with ⌘-click on macOS", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    render(<Fixture {...explorerProps({ expandedFolders: ["apps", "apps/reading-list"] })} />);
    fireEvent.click(row("notes.md"));
    fireEvent.click(row("apps/reading-list/index.html"), { metaKey: true });
    expect(row("notes.md").getAttribute("aria-selected")).toBe("true");
    expect(row("apps/reading-list/index.html").getAttribute("aria-selected")).toBe("true");
  });
});

// A share view's delete always asks first, so these tests use one.
describe("the delete dialog by keyboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function askToDelete() {
    const deleteWorkspacePath = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("dohcDesktop", { platform: "win32", deleteWorkspacePath });
    const user = userEvent.setup();
    render(<Fixture {...explorerProps({ shareView: { granterEmail: "owner@example.test" } })} />);
    await user.click(row("notes.md"));
    await user.keyboard("{Delete}");
    return { user, deleteWorkspacePath };
  }

  it("deletes with Delete then Enter", async () => {
    const { user, deleteWorkspacePath } = await askToDelete();
    expect(document.activeElement).toBe(screen.getByTestId("confirm-delete"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-1", relativePath: "notes.md" }));
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
  });

  it("keeps the file with Delete then Escape", async () => {
    const { user, deleteWorkspacePath } = await askToDelete();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    expect(deleteWorkspacePath).not.toHaveBeenCalled();
  });

  it("moves to Cancel with an arrow key, and Enter there keeps the file", async () => {
    const { user, deleteWorkspacePath } = await askToDelete();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByTestId("cancel-delete"));
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    expect(deleteWorkspacePath).not.toHaveBeenCalled();
  });
});
