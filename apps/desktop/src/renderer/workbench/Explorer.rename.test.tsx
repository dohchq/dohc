// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { Explorer, type ExplorerProps } from "./Explorer";

const moveWorkspacePath = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  moveWorkspacePath.mockResolvedValue({ path: "" });
  window.dohcDesktop = { moveWorkspacePath } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function explorerProps(): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [
      { path: "hello.m", kind: "file" },
      { path: "notes.md", kind: "file" },
    ],
    folders: ["drafts"],
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
  };
}

async function renameTo(path: string, name: string): Promise<void> {
  const row = screen
    .getAllByTestId("tree-row")
    .find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "F2" });
  const input = await screen.findByTestId("tree-edit-input");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("Explorer rename", () => {
  it("makes a file markdown when the new name has no extension", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("hello.m", "hello");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        fromPath: "hello.m",
        toPath: "hello.md",
      }),
    );
  });

  it("leaves a markdown file in place when only its extension is removed", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("notes.md", "notes");
    expect(screen.queryByTestId("tree-edit-input")).toBeNull();
    expect(moveWorkspacePath).not.toHaveBeenCalled();
  });

  it("keeps an explicit extension", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("hello.m", "hello.txt");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith(
        expect.objectContaining({ fromPath: "hello.m", toPath: "hello.txt" }),
      ),
    );
  });

  it("never adds an extension to a folder", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("drafts", "archive");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith(
        expect.objectContaining({ fromPath: "drafts", toPath: "archive" }),
      ),
    );
  });
});
