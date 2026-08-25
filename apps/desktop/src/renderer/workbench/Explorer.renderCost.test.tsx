// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";
import { leafOf } from "./path-tree";

// Real implementations, spied: every TreeRow render names its row through
// leafOf, so its call count shows which rows actually re-rendered (the
// chatFileMentions precedent). The fixtures keep every OTHER leafOf caller
// quiet — no open editors, no pins, no inline edit, no delete dialog — so a
// delta is TreeRow renders and nothing else.
vi.mock("./path-tree", { spy: true });

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
  // The shell re-renders on every lane commit (status, history, agent state).
  // With an identical prop set the memoized Explorer must bail instead of
  // reconciling every row. The open editor matters: its row names itself
  // through editorTitle -> leafOf on every EXPLORER render, so this fails if
  // either the Explorer memo goes (leafOf fires from the open-editors list)
  // or the TreeRow stabilization goes (leafOf fires from every row).
  it("skips re-rendering when the host re-renders with unchanged props", () => {
    const props = explorerProps({
      editorGroups: [
        { id: "group-1", tabs: [{ path: "a.md" }], activeTab: "a.md", size: 1 },
      ],
    });
    function Host() {
      const [, setTick] = useState(0);
      return (
        <>
          <button data-testid="bump" onClick={() => setTick((tick) => tick + 1)} />
          <Explorer {...props} />
        </>
      );
    }
    render(<Host />);
    const baseline = leafOfCalls();
    expect(baseline).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("bump"));
    expect(leafOfCalls()).toBe(baseline);
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
