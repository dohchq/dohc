// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

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

function row(path: string): HTMLElement | undefined {
  return screen.queryAllByTestId("tree-row").find((candidate) => candidate.dataset.path === path);
}

describe("Explorer reveal", () => {
  it("selects and focuses the revealed folder", () => {
    const onRevealed = vi.fn();
    render(
      <Explorer
        {...explorerProps({
          expandedFolders: ["apps", "apps/reading-list"],
          revealPath: "apps/reading-list",
          onRevealed,
        })}
      />,
    );

    const folder = row("apps/reading-list");
    expect(folder?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(folder);
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("drops a reveal for a path the tree does not list", () => {
    const onRevealed = vi.fn();
    render(<Explorer {...explorerProps({ revealPath: "apps/gone", onRevealed })} />);

    expect(onRevealed).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId("tree-row").some((candidate) => candidate === document.activeElement))
      .toBe(false);
  });

  it("waits until the shell's expansion renders the row", () => {
    const onRevealed = vi.fn();
    const props = explorerProps({ revealPath: "apps/reading-list", onRevealed });
    const view = render(<Explorer {...props} />);

    expect(row("apps/reading-list")).toBeUndefined();
    expect(onRevealed).not.toHaveBeenCalled();

    view.rerender(<Explorer {...props} expandedFolders={["apps", "apps/reading-list"]} />);

    expect(document.activeElement).toBe(row("apps/reading-list"));
    expect(row("apps/reading-list/index.html")).toBeDefined();
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });
});
