// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";

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

describe("the active row inside a multi-selection", () => {
  // Two or more selected rows share the selection's tint. The ring marks the
  // focused row, not the open file, so the open file alone is medium weight
  // and still reads after focus leaves the tree.
  it("keeps its weight cue when the tree is not focused", async () => {
    const user = userEvent.setup();
    render(
      <Fixture
        {...explorerProps({
          editorGroups: [{ id: "group-1", tabs: [{ path: "notes.md" }], activeTab: "notes.md", size: 1 }],
          expandedFolders: ["apps", "apps/reading-list"],
        })}
      />,
    );

    await user.click(row("notes.md"));
    fireEvent.click(row("apps/reading-list/index.html"), { ctrlKey: true });
    expect(row("notes.md").getAttribute("aria-selected")).toBe("true");
    expect(row("apps/reading-list/index.html").getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("button", { name: "After tree" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After tree" }));
    expect(row("notes.md").className).toContain("font-medium");
    expect(row("apps/reading-list/index.html").className).not.toContain("font-medium");
    expect(row("apps/reading-list/index.html").className).toContain("bg-selection");
    expect(row("notes.md").className).toContain("bg-selection");
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

  it("tints two or more selected rows and counts them, and leaves a selection of one as it was", () => {
    render(<Fixture {...many()} />);
    fireEvent.click(row("b.md"));
    expect(row("b.md").className).toContain("bg-selected text-ink");
    expect(bar()).toBeNull();

    fireEvent.click(row("c.md"), { ctrlKey: true });
    for (const path of ["b.md", "c.md"]) expect(row(path).className).toContain("bg-selection text-ink");
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
    const onChangeSucceeded = vi.fn();
    const user = userEvent.setup();
    render(<Fixture {...many({ onError, onPathsChanged, onChangeSucceeded })} />);
    await user.click(row("b.md"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}{Delete}");
    await user.click(screen.getByTestId("confirm-delete"));

    await waitFor(() => expect(onPathsChanged).toHaveBeenCalledTimes(1));
    expect(deleteWorkspacePath).toHaveBeenCalledTimes(3);
    expect(onPathsChanged.mock.calls[0]![0]).toEqual([expect.objectContaining({ kind: "delete-file", path: "c.md" })]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [, , retry, identity, livePage] = onError.mock.calls[0]!;
    expect(livePage).toEqual({ paths: ["b.md", "d.md"], action: "delete" });

    // Try again deletes the two refused pages again, and its report replaces this one.
    deleteWorkspacePath.mockClear();
    retry();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath)).toEqual(["b.md", "d.md"]);
    expect(onChangeSucceeded).toHaveBeenCalledWith(identity);
    expect(onError.mock.calls[1]![3]).toBe(identity);
  });
});
