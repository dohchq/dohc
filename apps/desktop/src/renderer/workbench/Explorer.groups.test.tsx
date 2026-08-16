// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

function explorerProps(
  overrides: Partial<ExplorerProps> = {},
): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [
      { path: "one.md", kind: "file" },
      { path: "two.md", kind: "file" },
    ],
    folders: [],
    editorGroups: [
      {
        id: "group-1",
        tabs: [{ path: "one.md" }, { path: "two.md" }],
        activeTab: "one.md",
        size: 1,
      },
    ],
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

describe("Explorer editor groups", () => {
  it("keeps a single group's Open Editors list compact", () => {
    render(<Explorer {...explorerProps()} />);

    expect(screen.queryByText("Group 1")).toBeNull();
    expect(screen.getAllByTestId("open-editor-row")).toHaveLength(2);
  });

  it("groups rows and routes each action through its group id", () => {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    render(
      <Explorer
        {...explorerProps({
          editorGroups: [
            {
              id: "group-1",
              tabs: [{ path: "one.md" }],
              activeTab: "one.md",
              size: 0.5,
            },
            {
              id: "group-2",
              tabs: [{ path: "two.md" }],
              activeTab: "two.md",
              size: 0.5,
            },
          ],
          activeEditorGroup: "group-2",
          dirtyPaths: new Set(["one.md"]),
          onActivateTab,
          onCloseTab,
        })}
      />,
    );

    expect(screen.getByText("Group 1")).toBeTruthy();
    expect(screen.getByText("Group 2")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Group 2 open editors" }),
    ).toBeTruthy();

    const groups = screen.getAllByTestId("open-editor-group");
    const firstRow = within(groups[0]!).getByTestId("open-editor-row");
    const secondRow = within(groups[1]!).getByTestId("open-editor-row");
    expect(firstRow.getAttribute("data-active")).toBe("false");
    expect(secondRow.getAttribute("data-active")).toBe("true");
    expect(within(firstRow).getByLabelText("Unsaved changes")).toBeTruthy();

    fireEvent.click(within(firstRow).getByTitle("one.md"));
    fireEvent.click(within(secondRow).getByRole("button", { name: "Close two.md" }));

    expect(onActivateTab).toHaveBeenCalledWith("group-1", "one.md");
    expect(onCloseTab).toHaveBeenCalledWith("group-2", "two.md");
  });
});
