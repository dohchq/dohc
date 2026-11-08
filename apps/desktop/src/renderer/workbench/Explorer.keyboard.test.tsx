// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const edged = () =>
    screen
      .getAllByRole("treeitem")
      .filter((item) => item.querySelector('[data-testid="tree-row-open-edge"]'))
      .map((item) => item.dataset.path);
  async function openNotes() {
    const user = userEvent.setup();
    const props = explorerProps(expanded);
    const view = render(<Fixture {...props} />);
    await user.click(row("notes.md"));
    view.rerender(<Fixture {...props} {...opened("notes.md")} />);
    return user;
  }

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

  it("edges the open file among picked rows, and keeps the edge after focus leaves", async () => {
    const user = await openNotes();
    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    expect(edged()).toEqual(["notes.md"]);

    await user.click(screen.getByRole("button", { name: "After tree" }));
    expect(edged()).toEqual(["notes.md"]);
    expect(row("notes.md").className).toContain(TINT);
  });

  it("edges neither the open file alone nor a picked row that is not open", async () => {
    await openNotes();
    expect(edged()).toEqual([]);

    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    expect(edged()).toEqual(["notes.md"]);
    expect(row("apps/reading-list/index.html").className).toContain(TINT);
  });

  it("removes the edge when the pick clears", async () => {
    await openNotes();
    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    expect(edged()).toEqual(["notes.md"]);

    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    expect(edged()).toEqual([]);
    expect(marked()).toEqual(["notes.md"]);
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

describe("selecting several rows in Files", () => {
  afterEach(() => vi.unstubAllGlobals());

  const PATHS = ["a.md", "b.md", "c.md", "d.md"];
  const many = (overrides: Partial<ExplorerProps> = {}) =>
    explorerProps({
      files: PATHS.map((path) => ({ path, kind: "file" as const })),
      folders: [],
      editorGroups: [{ id: "group-1", tabs: [{ path: "a.md" }], activeTab: "a.md", size: 1 }],
      ...overrides,
    });
  const bar = () => screen.queryByTestId("explorer-selection-bar");
  const selected = () =>
    screen.getAllByRole("treeitem").filter((item) => item.getAttribute("aria-selected") === "true").map((item) => item.dataset.path);

  it("counts two or more selected rows, and shows no count for one", () => {
    render(<Fixture {...many()} />);
    fireEvent.click(row("b.md"));
    expect(bar()).toBeNull();

    fireEvent.click(row("c.md"), { ctrlKey: true });
    for (const path of ["b.md", "c.md"]) expect(row(path).className).toContain("bg-(--dohc-selection) text-ink");
    // The open row outside the selection keeps its own fill and weight.
    expect(row("a.md").className).toContain("bg-selected font-medium");
    expect(bar()?.textContent).toBe("2 selected");

    fireEvent.click(within(bar()!).getByRole("button", { name: "Clear selection" }));
    expect(bar()).toBeNull();
    expect(selected()).toEqual([]);
  });

  it("drops a selected row someone else removes from the count and the delete", () => {
    const props = many();
    const view = render(<Fixture {...props} />);
    fireEvent.click(row("b.md"));
    fireEvent.click(row("c.md"), { ctrlKey: true });
    fireEvent.click(row("d.md"), { ctrlKey: true });
    expect(bar()?.textContent).toBe("3 selected");
    view.rerender(<Fixture {...props} files={props.files.filter((file) => file.path !== "c.md")} />);
    expect(bar()?.textContent).toBe("2 selected");
    fireEvent.keyDown(row("d.md"), { key: "Delete" });
    expect([...screen.getByTestId("delete-confirm").querySelectorAll("li")].map((item) => item.textContent)).toEqual(["b.md", "d.md"]);
  });

  it("extends the selection with Shift and the arrows from the row it started on", async () => {
    const user = userEvent.setup();
    render(<Fixture {...many()} />);
    await user.click(row("b.md"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(selected()).toEqual(["b.md", "c.md", "d.md"]);
    expect(document.activeElement).toBe(row("d.md"));
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(selected()).toEqual(["b.md", "c.md"]);
    await user.keyboard("{Shift>}{Home}{/Shift}");
    expect(selected()).toEqual(["a.md", "b.md"]);
  });

  it("selects every row with Ctrl+A, and Escape clears it", async () => {
    const user = userEvent.setup();
    render(<Fixture {...many()} />);
    await user.click(row("b.md"));
    await user.keyboard("{Control>}a{/Control}");
    expect(selected()).toEqual(PATHS);
    expect(bar()?.textContent).toBe("4 selected");
    await user.keyboard("{Escape}");
    expect(selected()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it.each([
    ["pins the rows that are not pinned", ["c.md"], "pin", ["b.md", "d.md"]],
    ["unpins every row when all are pinned", ["b.md", "c.md", "d.md"], "unpin", ["b.md", "c.md", "d.md"]],
  ] as const)("%s from a selected row's menu", async (_name, pinned, choice, toggled) => {
    const showExplorerMenu = vi.fn(async (_input: unknown) => choice);
    vi.stubGlobal("dohcDesktop", { showExplorerMenu });
    const onTogglePin = vi.fn();
    render(<Fixture {...many({ pinned: [...pinned], onTogglePin })} />);
    fireEvent.click(row("b.md"));
    fireEvent.click(row("c.md"), { ctrlKey: true });
    fireEvent.click(row("d.md"), { ctrlKey: true });
    fireEvent.contextMenu(row("c.md"));
    expect(showExplorerMenu).toHaveBeenCalledWith({
      workspaceId: "workspace-1", path: "c.md", kind: "file", pinned: choice === "unpin", count: 3,
    });
    await waitFor(() => expect(onTogglePin.mock.calls.map(([path]) => path)).toEqual(toggled));
  });

  it("gives a row outside the selection its own menu", () => {
    const showExplorerMenu = vi.fn(async (_input: unknown) => null);
    vi.stubGlobal("dohcDesktop", { showExplorerMenu });
    render(<Fixture {...many()} />);
    fireEvent.click(row("b.md"));
    fireEvent.click(row("c.md"), { ctrlKey: true });
    fireEvent.contextMenu(row("d.md"));
    expect(showExplorerMenu).toHaveBeenCalledWith({ workspaceId: "workspace-1", path: "d.md", kind: "file", pinned: false });
    expect(selected()).toEqual(["d.md"]);
  });

  it("deletes the rest when some are refused, and reports the refusals once", async () => {
    const refusal = (path: string) =>
      new Error(
        `Error invoking remote method 'desktop:delete-workspace-path': LivePageOwnedError: dohc can't delete "${path}" while it has live editing on\nIn Live documents, stop live editing for this page, then delete it again.`,
      );
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath !== "c.md") throw refusal(relativePath);
    });
    vi.stubGlobal("dohcDesktop", { deleteWorkspacePath });
    const onError = vi.fn();
    const onPathsChanged = vi.fn();
    const user = userEvent.setup();
    render(<Fixture {...many({ onError, onPathsChanged })} />);
    await user.click(row("b.md"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}{Delete}");
    await user.click(screen.getByTestId("confirm-delete"));

    await waitFor(() => expect(onPathsChanged).toHaveBeenCalledTimes(1));
    expect(deleteWorkspacePath).toHaveBeenCalledTimes(3);
    expect(onPathsChanged.mock.calls[0]![0]).toEqual([expect.objectContaining({ kind: "delete-file", path: "c.md" })]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [, , retry, changes, livePage] = onError.mock.calls[0]!;
    expect(livePage).toEqual({ paths: ["b.md", "d.md"], action: "delete" });
    // The shell takes the notice back once one of these changes happens.
    const refused = [
      expect.objectContaining({ kind: "delete-file", path: "b.md" }),
      expect.objectContaining({ kind: "delete-file", path: "d.md" }),
    ];
    expect(changes).toEqual(refused);

    // Try again deletes the two refused pages again, and reports the same changes.
    deleteWorkspacePath.mockClear();
    retry();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath)).toEqual(["b.md", "d.md"]);
    expect(onError.mock.calls[1]![3]).toEqual(refused);
  });

  it("reports a live editing refusal apart from another failure in the same delete", async () => {
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "b.md") {
        throw new Error(`Error invoking remote method 'desktop:delete-workspace-path': LivePageOwnedError: dohc can't delete "b.md" while it has live editing on\nIn Live documents, stop live editing for this page, then delete it again.`);
      }
      if (relativePath === "c.md") throw new Error("Error invoking remote method 'desktop:delete-workspace-path': Error: The disk is full.");
    });
    vi.stubGlobal("dohcDesktop", { deleteWorkspacePath });
    const onError = vi.fn();
    const onPathsChanged = vi.fn();
    const user = userEvent.setup();
    render(<Fixture {...many({ onError, onPathsChanged })} />);
    await user.click(row("b.md"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}{Delete}");
    await user.click(screen.getByTestId("confirm-delete"));

    await waitFor(() => expect(onPathsChanged).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![4]).toEqual({ path: "b.md", action: "delete" });
    expect(onError.mock.calls[1]![4]).toBeUndefined();
  });

  it("reports a folder live editing refused on its own, beside another failure in the same delete", async () => {
    const folderRefusal = new Error(
      `Error invoking remote method 'desktop:delete-workspace-path': LiveFolderError: dohc can't delete "box" while a page in it has live editing on\nIn Live documents, stop live editing for every page in this folder, then delete the folder again.`,
    );
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "box") throw folderRefusal;
      if (relativePath === "c.md") throw new Error("Error invoking remote method 'desktop:delete-workspace-path': Error: The disk is full.");
    });
    vi.stubGlobal("dohcDesktop", { deleteWorkspacePath });
    const onError = vi.fn();
    const onPathsChanged = vi.fn();
    const user = userEvent.setup();
    render(<Fixture {...many({ folders: ["box"], onError, onPathsChanged })} />);
    await user.click(row("b.md"));
    await user.keyboard("{Control>}a{/Control}{Delete}");
    await user.click(screen.getByTestId("confirm-delete"));

    await waitFor(() => expect(onPathsChanged).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledTimes(2);
    // The folder's report keeps its own refusal, which the shell turns into
    // the way to Live documents, and its Try again.
    const folder = onError.mock.calls.find(([, , , change]) => change?.path === "box");
    expect(folder?.[1]).toBe(folderRefusal);
    expect(folder?.[2]).toEqual(expect.any(Function));
    const other = onError.mock.calls.find(([, , , change]) => change?.path === "c.md");
    expect(other?.[1]).not.toBe(folderRefusal);
    expect(other?.[4]).toBeUndefined();
  });

  it("deletes the focused row alone when it is outside the selection, as its menu would", () => {
    render(<Fixture {...many()} />);
    const dialog = () => screen.getByTestId("delete-confirm");
    fireEvent.click(row("b.md"));
    fireEvent.click(row("c.md"), { ctrlKey: true });
    act(() => row("d.md").focus());
    fireEvent.keyDown(row("d.md"), { key: "Delete" });
    expect(within(dialog()).getByRole("heading").textContent).toBe("Delete d.md?");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    act(() => row("c.md").focus());
    fireEvent.keyDown(row("c.md"), { key: "Delete" });
    expect(within(dialog()).getByRole("heading").textContent).toBe("Delete 2 items?");
    expect([...dialog().querySelectorAll("li")].map((item) => item.textContent)).toEqual(["b.md", "c.md"]);
  });
});
