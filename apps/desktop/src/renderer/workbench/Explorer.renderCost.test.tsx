// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "./EditorTabs";
import { Explorer, type ExplorerProps } from "./Explorer";
import { buildTree, leafOf } from "./path-tree";
import { isSingletonEditorTabPath } from "./workbenchState";

// Real implementations, spied: every TreeRow render names its row through
// leafOf, so its call count shows which rows actually re-rendered (the
// chatFileMentions precedent). The fixtures keep every other leafOf caller
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
const LARGE_FILE_PATHS = Array.from(
  { length: 500 },
  (_, index) => `file-${String(index).padStart(4, "0")}.md`,
);

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
    collectionFolders: new Set<string>(),
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
  it("keeps the same tree for a same-listing rerender", () => {
    const props = explorerProps();
    const view = render(<Explorer {...props} />);

    expect(vi.mocked(buildTree)).toHaveBeenCalledTimes(1);
    view.rerender(<Explorer {...props} onRefresh={vi.fn()} />);
    expect(vi.mocked(buildTree)).toHaveBeenCalledTimes(1);
  });

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

  it("mounts only a bounded window for a large tree", () => {
    render(
      <Explorer
        {...explorerProps({
          files: LARGE_FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
        })}
      />,
    );

    const mounted = screen.getAllByTestId("tree-row");
    expect(mounted.length).toBeLessThanOrEqual(64);
    expect(mounted.every((row) => row.style.height === "28px")).toBe(true);
    expect(rowButton("file-0000.md").getAttribute("aria-posinset")).toBe("1");
    expect(rowButton("file-0000.md").getAttribute("aria-setsize")).toBe("500");
    expect(
      mounted.some((row) => row.dataset.path === "file-0499.md"),
    ).toBe(false);
  });

  it("windows scrolled rows while retaining the focused tree item", () => {
    render(
      <Explorer
        {...explorerProps({
          files: LARGE_FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
        })}
      />,
    );

    const first = rowButton("file-0000.md");
    first.focus();
    fireEvent.click(first);
    expect(document.activeElement).toBe(first);

    const container = screen.getByTestId("file-tree");
    const list = screen.getByRole("tree", { name: "Workspace files" });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 280 });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 2_800,
      writable: true,
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 280,
      bottom: 280,
      left: 0,
      width: 280,
      height: 280,
      toJSON: () => ({}),
    });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -2_800,
      top: -2_800,
      right: 280,
      bottom: 137_200,
      left: 0,
      width: 280,
      height: 140_000,
      toJSON: () => ({}),
    });
    fireEvent.scroll(container);

    expect(document.body.contains(rowButton("file-0100.md"))).toBe(true);
    expect(document.body.contains(rowButton("file-0000.md"))).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(screen.getAllByTestId("tree-row").length).toBeLessThanOrEqual(36);
  });

  it("recomputes virtual rows while Open Editors is being resized", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1_000 });

    try {
      render(
        <Explorer
          {...explorerProps({
            files: LARGE_FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
            editorGroups: [
              {
                id: "group-1",
                tabs: LARGE_FILE_PATHS.slice(0, 40).map((path) => ({ path })),
                activeTab: LARGE_FILE_PATHS[0] ?? null,
                size: 1,
              },
            ],
            openEditorsHeight: 56,
          })}
        />,
      );

      const container = screen.getByTestId("file-tree");
      const list = screen.getByRole("tree", { name: "Workspace files" });
      const openEditorsList = screen.getByTestId("open-editors-list");
      Object.defineProperty(container, "clientHeight", { configurable: true, value: 280 });
      Object.defineProperty(container, "scrollTop", {
        configurable: true,
        value: 2_800,
        writable: true,
      });
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 280,
        bottom: 280,
        left: 0,
        width: 280,
        height: 280,
        toJSON: () => ({}),
      });
      vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => {
        const openEditorsCap = Number.parseFloat(openEditorsList.style.maxHeight);
        const top = -2_800 + openEditorsCap - 56;
        return {
          x: 0,
          y: top,
          top,
          right: 280,
          bottom: top + 14_000,
          left: 0,
          width: 280,
          height: 14_000,
          toJSON: () => ({}),
        };
      });
      fireEvent.scroll(container);

      expect(document.body.contains(rowButton("file-0100.md"))).toBe(true);
      expect(
        screen
          .queryAllByTestId("tree-row")
          .some((row) => row.dataset.path === "file-0080.md"),
      ).toBe(false);

      const handle = screen.getByTestId("open-editors-resize");
      Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
      fireEvent.pointerDown(handle, {
        button: 0,
        buttons: 1,
        clientY: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(handle, {
        buttons: 1,
        clientY: 1_000,
        pointerId: 1,
      });

      expect(openEditorsList.style.maxHeight).toBe("600px");
      expect(document.body.contains(rowButton("file-0080.md"))).toBe(true);
    } finally {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it("keeps a virtualized drag origin mounted until the gesture ends", async () => {
    render(
      <Explorer
        {...explorerProps({
          files: LARGE_FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
        })}
      />,
    );

    const first = rowButton("file-0000.md");
    fireEvent.dragStart(first, {
      dataTransfer: { effectAllowed: "none", setData: vi.fn() },
    });

    const container = screen.getByTestId("file-tree");
    const list = screen.getByRole("tree", { name: "Workspace files" });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 280 });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 2_800,
      writable: true,
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 280,
      bottom: 280,
      left: 0,
      width: 280,
      height: 280,
      toJSON: () => ({}),
    });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -2_800,
      top: -2_800,
      right: 280,
      bottom: 137_200,
      left: 0,
      width: 280,
      height: 140_000,
      toJSON: () => ({}),
    });
    fireEvent.scroll(container);

    expect(document.body.contains(first)).toBe(true);
    fireEvent.dragEnd(first);
    await waitFor(() => {
      expect(
        screen
          .queryAllByTestId("tree-row")
          .some((row) => row.dataset.path === "file-0000.md"),
      ).toBe(false);
    });
  });

  it("moves keyboard focus to an unmounted End target", async () => {
    render(
      <Explorer
        {...explorerProps({
          files: LARGE_FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
        })}
      />,
    );

    fireEvent.click(rowButton("file-0000.md"));
    fireEvent.keyDown(screen.getByTestId("file-tree"), { key: "End" });

    await waitFor(() => {
      const last = rowButton("file-0499.md");
      expect(document.activeElement).toBe(last);
      expect(last.getAttribute("tabindex")).toBe("0");
      expect(last.getAttribute("aria-posinset")).toBe("500");
    });
    expect(screen.getAllByTestId("tree-row").length).toBeLessThanOrEqual(64);
  });

  it("keeps a root create row reachable while the large tree is windowed", async () => {
    const props = explorerProps({
      files: LARGE_FILE_PATHS.map((path) => ({ path, kind: "file" as const })),
    });
    const view = render(<Explorer {...props} />);

    view.rerender(
      <Explorer {...props} createRequest={{ kind: "file", id: 1 }} />,
    );

    const input = await screen.findByTestId("tree-edit-input");
    expect(input.getAttribute("aria-label")).toBe("New file name");
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByTestId("tree-row").length).toBeLessThanOrEqual(64);
  });
});
