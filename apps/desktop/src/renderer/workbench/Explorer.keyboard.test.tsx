// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
