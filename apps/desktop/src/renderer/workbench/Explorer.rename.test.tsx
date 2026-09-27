// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
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

it.each(["Enter", "Escape"])("returns to the tree row after rename %s", async (key) => {
  render(<Explorer {...explorerProps()} />);
  const row = screen.getAllByTestId("tree-row").find((node) => node.dataset.path === "notes.md")!;
  row.focus();
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "F2" });
  const input = await screen.findByTestId("tree-edit-input");
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key });
  await waitFor(() => expect(document.activeElement).toBe(screen.getAllByTestId("tree-row").find((node) => node.dataset.path === "notes.md")));
});
it("follows the renamed row through its optimistic path change", async () => {
  render(<Explorer {...explorerProps()} />);
  await renameTo("hello.m", "renamed.md");
  await waitFor(() => expect((document.activeElement as HTMLElement).dataset.path).toBe("renamed.md"));
});
it("keeps the clicked destination when rename ends by blur", async () => {
  render(<><button>Elsewhere</button><Explorer {...explorerProps()} /></>);
  const row = screen.getAllByTestId("tree-row").find((node) => node.dataset.path === "notes.md")!;
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "F2" });
  await screen.findByTestId("tree-edit-input");
  screen.getByText("Elsewhere").focus();
  await waitFor(() => expect(screen.queryByTestId("tree-edit-input")).toBeNull());
  expect(document.activeElement).toBe(screen.getByText("Elsewhere"));
});

it("returns to the original row when a rename fails", async () => {
  moveWorkspacePath.mockRejectedValueOnce(new Error("Rename failed"));
  const props = explorerProps();
  render(<Explorer {...props} />);
  await renameTo("hello.m", "renamed.md");
  await waitFor(() => expect(props.onError).toHaveBeenCalled());
  await waitFor(() => expect((document.activeElement as HTMLElement).dataset.path).toBe("hello.m"));
});

it("does not reuse a rename destination after another focused row is deleted", async () => {
  const props = explorerProps();
  const view = render(<Explorer {...props} />);
  await renameTo("hello.m", "renamed.md");
  await waitFor(() => expect((document.activeElement as HTMLElement).dataset.path).toBe("renamed.md"));
  const renamedFiles = [{ path: "renamed.md", kind: "file" as const }, { path: "notes.md", kind: "file" as const }];
  view.rerender(<Explorer {...props} files={renamedFiles} />);
  screen.getAllByTestId("tree-row").find(node => node.dataset.path === "notes.md")!.focus();
  view.rerender(<Explorer {...props} files={renamedFiles.slice(0, 1)} />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId("file-tree"));
});

it("does not remember a rename completed by deliberately moving focus away", async () => {
  const props = explorerProps();
  const view = render(<><button>Elsewhere</button><Explorer {...props} /></>);
  const row = screen.getAllByTestId("tree-row").find(node => node.dataset.path === "hello.m")!;
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "F2" });
  const input = await screen.findByTestId("tree-edit-input");
  fireEvent.change(input, { target: { value: "renamed.md" } });
  screen.getByText("Elsewhere").focus();
  await waitFor(() => expect(screen.queryByTestId("tree-edit-input")).toBeNull());
  screen.getAllByTestId("tree-row").find(node => node.dataset.path === "notes.md")!.focus();
  view.rerender(<><button>Elsewhere</button><Explorer {...props} files={[{ path: "renamed.md", kind: "file" }]} /></>);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByTestId("file-tree"));
});

it("returns to the original row after an optimistic rename rolls back", async () => {
  const move = deferred<{ path: string }>();
  moveWorkspacePath.mockReturnValueOnce(move.promise);
  const props = explorerProps();
  render(<Explorer {...props} />);
  await renameTo("hello.m", "renamed.md");
  await waitFor(() => expect((document.activeElement as HTMLElement).dataset.path).toBe("renamed.md"));
  await act(async () => { move.reject(new Error("Rename failed")); });
  expect((document.activeElement as HTMLElement).dataset.path).toBe("hello.m");
});

it("does not close a new file input while a rename waits to begin", async () => {
  const begin = deferred<null>();
  const props = { ...explorerProps(), onBeginChanges: vi.fn().mockReturnValueOnce(begin.promise) };
  const view = render(<Explorer {...props} />);
  await renameTo("hello.m", "renamed.md");
  expect((screen.getByTestId("tree-edit-input") as HTMLInputElement).readOnly).toBe(true);
  view.rerender(<Explorer {...props} createRequest={{ id: 1, kind: "file" }} />);
  const nextInput = screen.getByTestId("tree-edit-input");
  expect((nextInput as HTMLInputElement).readOnly).toBe(false);
  await act(async () => { begin.resolve(null); });
  expect(screen.getByTestId("tree-edit-input")).toBe(nextInput);
  expect(document.activeElement).toBe(nextInput);
});
