// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorTitle, Explorer, type ExplorerProps } from "./Explorer";
import { collectionTabPath } from "./workbenchState";

afterEach(cleanup);

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [
      { path: "notes.md", kind: "file" },
      { path: "tasks/one.md", kind: "file" },
      { path: "archive/old.md", kind: "file" },
    ],
    folders: ["tasks", "archive"],
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
    collectionFolders: new Set(["tasks"]),
    onOpenCollection: vi.fn(),
    onPathsChanged: vi.fn(),
    onImportFiles: vi.fn(),
    onRefreshShareMounts: vi.fn(),
    onUnmountShare: vi.fn(),
    onShare: vi.fn(),
    onRefresh: vi.fn(),
    onNewFileDialog: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function treeRow(path: string): HTMLElement {
  const row = screen
    .getAllByTestId("tree-row")
    .find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  return row;
}

describe("Explorer collection folders", () => {
  it("opens the collection on a row click instead of toggling the folder", () => {
    const props = explorerProps();
    render(<Explorer {...props} />);

    fireEvent.click(treeRow("tasks"));

    expect(props.onOpenCollection).toHaveBeenCalledExactlyOnceWith("tasks");
    expect(props.onToggleFolder).not.toHaveBeenCalled();
    expect(props.onOpenFile).not.toHaveBeenCalled();
  });

  it("still toggles a collection folder from its chevron", () => {
    const props = explorerProps();
    render(<Explorer {...props} />);

    fireEvent.click(within(treeRow("tasks")).getByTestId("tree-row-chevron"));

    expect(props.onToggleFolder).toHaveBeenCalledExactlyOnceWith("tasks");
    expect(props.onOpenCollection).not.toHaveBeenCalled();
  });

  it("keeps plain folders toggling on a row click", () => {
    const props = explorerProps();
    render(<Explorer {...props} />);

    fireEvent.click(treeRow("archive"));

    expect(props.onToggleFolder).toHaveBeenCalledExactlyOnceWith("archive");
    expect(props.onOpenCollection).not.toHaveBeenCalled();
  });

  it("titles a collection tab with the folder leaf", () => {
    expect(editorTitle(collectionTabPath("projects/road trips"))).toBe(
      "road trips",
    );
  });
});
