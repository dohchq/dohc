// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

// WHAT A DELETE PROMISES (#802, sweep blocker 3).
//
// An ordinary workspace's delete goes to a trash and can be restored from
// there. A share view's delete removes the projection of a moment: there is no
// trash, and what can still be taken back is the CHANGE, because the granter's
// copy is untouched until they accept it. The confirmation has to say the one
// that is true, or it is a durability promise dohc cannot keep.

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [{ path: "note.md", kind: "file" }],
    folders: [],
    editorGroups: [
      { id: "group-1", tabs: [{ path: "note.md" }], activeTab: "note.md", size: 1 },
    ],
    activeEditorGroup: "group-1",
    dirtyPaths: new Set(),
    isShareView: false,
    recoveryPaths: new Set(),
    expandedFolders: [],
    pinned: [],
    openEditorsHeight: 200,
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
    onPathsChanged: vi.fn(),
    onImportFiles: vi.fn(),
    onRefreshShareMounts: vi.fn(),
    onUnmountShare: vi.fn(),
    onShare: vi.fn(),
    onRefresh: vi.fn(),
    onNewFileDialog: vi.fn(),
    ...overrides,
  };
}

function openDeleteConfirm(): void {
  // The TREE row, not the Open Editors row of the same name.
  const row = within(screen.getByTestId("file-tree")).getByTestId("tree-row");
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "Delete" });
}

describe("the delete confirmation states where the file goes", () => {
  it("promises the trash in an ordinary workspace", () => {
    render(<Explorer {...explorerProps()} />);
    openDeleteConfirm();
    const confirm = screen.getByTestId("delete-confirm");
    expect(confirm.textContent).toContain("system trash");
    expect(confirm.textContent).toContain("restored from there");
  });

  it("promises no trash in a share view, and names what can be taken back", () => {
    render(<Explorer {...explorerProps({ isShareView: true })} />);
    openDeleteConfirm();
    const confirm = screen.getByTestId("delete-confirm");
    expect(
      confirm.textContent,
      "MUTATION: a share view's delete has no trash to restore from, so promising one is a durability claim dohc cannot keep",
    ).not.toContain("trash");
    expect(confirm.textContent).toContain("goes from your copy now");
    expect(confirm.textContent).toContain(
      "still has the file until they accept the change you send",
    );
  });
});
