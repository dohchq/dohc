// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "./EditorTabs";
import { Explorer, type ExplorerProps } from "./Explorer";
import { leafOf } from "./path-tree";
import { isSingletonEditorTabPath } from "./workbenchState";

// Real implementations, spied: every TreeRow render names its row through
// leafOf, so its call count shows which rows actually re-rendered (the
// chatFileMentions precedent). The fixtures keep every OTHER leafOf caller
// quiet — no open editors, no pins, no inline edit, no delete dialog — so a
// delta is TreeRow renders and nothing else.
vi.mock("./path-tree", { spy: true });
vi.mock("./workbenchState", { spy: true });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FILE_PATHS = ["a.md", "b.md", "c.md", "d.md"];

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
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

function rowButton(path: string): HTMLElement {
  const row = screen
    .getAllByTestId("tree-row")
    .find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  return row;
}

function leafOfCalls(): number {
  return vi.mocked(leafOf).mock.calls.length;
}

describe("Explorer render cost", () => {
  it("keeps EditorTabs out of an unrelated host re-render", () => {
    const props = {
      groupId: "group-1",
      groupNumber: 1,
      tabs: [{ path: "a.md" }],
      activeTab: "a.md",
      activeTabDirty: false,
      recoveryPaths: new Set<string>(),
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onContextMenu: vi.fn(),
      onMove: vi.fn(),
      onMoveToGroup: vi.fn(),
      onCreateGroupRight: vi.fn(),
    };
    function Host() {
      const [, setTick] = useState(0);
      return (
        <>
          <button data-testid="bump" onClick={() => setTick((tick) => tick + 1)} />
          <EditorTabs {...props} />
        </>
      );
    }
    render(<Host />);
    expect(vi.mocked(isSingletonEditorTabPath)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("bump"));
    expect(vi.mocked(isSingletonEditorTabPath)).toHaveBeenCalledTimes(1);
  });

  // Selection state lives in the Explorer, so a click re-renders the tree —
  // but the row callbacks read selection through refs, so only the rows whose
  // flags changed re-render, never the whole tree via new callback identities.
  it("re-renders only the rows a selection change touches", () => {
    render(<Explorer {...explorerProps()} />);
    const baseline = leafOfCalls();

    // First selection: only b.md gains selected + focused flags.
    fireEvent.click(rowButton("b.md"));
    expect(leafOfCalls()).toBe(baseline + 1);

    // Moving the selection: b.md clears, d.md gains — two rows, not four.
    fireEvent.click(rowButton("d.md"));
    expect(leafOfCalls()).toBe(baseline + 3);
  });
});
