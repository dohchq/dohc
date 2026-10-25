// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { Explorer, type ExplorerProps } from "./Explorer";

const moveWorkspacePath = vi.fn();
const showExplorerMenu = vi.fn();
const createWorkspaceFile = vi.fn();
const createWorkspaceFolder = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  moveWorkspacePath.mockResolvedValue({ path: "" });
  showExplorerMenu.mockResolvedValue(null);
  window.dohcDesktop = { moveWorkspacePath, showExplorerMenu, createWorkspaceFile, createWorkspaceFolder } as unknown as DohcDesktopBridge;
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
      { path: "LICENSE", kind: "file" },
      { path: "report.csv", kind: "file" },
      { path: "archive.tar.gz", kind: "file" },
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
    newFolderRequest: null,
    onNewPage: vi.fn(),
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

async function beginRename(path: string): Promise<HTMLElement> {
  const row = screen
    .getAllByTestId("tree-row")
    .find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "F2" });
  return await screen.findByTestId("tree-edit-input");
}

async function renameTo(path: string, name: string): Promise<void> {
  const input = await beginRename(path);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("Explorer rename", () => {
  it.each(["a?b", "CON", "NUL.md", "tail.", "tail ", "a".repeat(253)])("keeps the refused Windows name %s beside its error", async name => {
    window.dohcDesktop!.platform = "win32";
    const props = { ...explorerProps(), onBeginChanges: vi.fn() };
    render(<Explorer {...props} />);
    const input = await beginRename("notes.md");
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect((screen.getByTestId("tree-edit-input") as HTMLInputElement).value).toBe(name);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    expect(input.classList.contains("border-danger")).toBe(true);
    expect(moveWorkspacePath).not.toHaveBeenCalled();
    expect(props.onBeginChanges).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "valid" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.classList.contains("border-danger")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(moveWorkspacePath).toHaveBeenCalledOnce());
  });

  it.each(["file", "folder"] as const)("validates a Windows new %s inline before mutation", async kind => {
    window.dohcDesktop!.platform = "win32";
    render(<Explorer {...explorerProps()} createRequest={{ id: 1, kind }} />);
    const input = await screen.findByTestId("tree-edit-input");
    fireEvent.change(input, { target: { value: "a?b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("A name cannot contain a question mark (?). Remove it.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.classList.contains("border-danger")).toBe(true);
    expect((input as HTMLInputElement).value).toBe("a?b");
    expect(createWorkspaceFile).not.toHaveBeenCalled();
    expect(createWorkspaceFolder).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("tree-edit-input")).toBeNull();
  });

  it.each([".env", "旅.md", "NOTES.md", "folder/moved.md"])("allows Windows rename to %s", async name => {
    window.dohcDesktop!.platform = "win32";
    render(<Explorer {...explorerProps()} />);
    await renameTo("notes.md", name);
    await waitFor(() => expect(moveWorkspacePath).toHaveBeenCalledWith(expect.objectContaining({ toPath: name })));
  });

  it.each(["darwin", "linux"] as const)("keeps %s punctuation behavior", async platform => {
    window.dohcDesktop!.platform = platform;
    render(<Explorer {...explorerProps()} />);
    await renameTo("notes.md", "a?b");
    await waitFor(() => expect(moveWorkspacePath).toHaveBeenCalledWith(expect.objectContaining({ toPath: "a?b.md" })));
  });

  it("keeps renaming through an Enter or Escape that an input method owns", async () => {
    render(<Explorer {...explorerProps()} />);
    const input = await beginRename("report.csv");
    fireEvent.change(input, { target: { value: "旅" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    await act(async () => {});
    expect(screen.getByTestId("tree-edit-input")).toBe(input);
    expect(moveWorkspacePath).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith(expect.objectContaining({ fromPath: "report.csv", toPath: "旅.csv" })),
    );
  });

  it("leaves a right-click in the name field to the text menu and keeps the rename open", async () => {
    render(<Explorer {...explorerProps()} />);
    const input = await beginRename("notes.md");
    // An uncancelled event is what lets Electron open main's text menu.
    expect(fireEvent.contextMenu(input)).toBe(true);
    await act(async () => {});
    expect(showExplorerMenu).not.toHaveBeenCalled();
    expect(screen.getByTestId("tree-edit-input")).toBe(input);
    // The tree around the field keeps its own menu.
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    await waitFor(() => expect(showExplorerMenu).toHaveBeenCalledOnce());
  });

  it("gives a new name without an extension the file's own extension", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("report.csv", "summary");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        fromPath: "report.csv",
        toPath: "summary.csv",
      }),
    );
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.path).toBe("summary.csv"));
  });

  it.each([
    ["notes.md", "notes"],
    ["report.csv", "report"],
  ])("leaves %s in place when only its extension is removed", async (path, name) => {
    render(<Explorer {...explorerProps()} />);
    await renameTo(path, name);
    await act(async () => {});
    expect(screen.queryByTestId("tree-edit-input")).toBeNull();
    expect(moveWorkspacePath).not.toHaveBeenCalled();
  });

  it("gives back only the last part of a multi-part extension", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("archive.tar.gz", "backup");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith(
        expect.objectContaining({ fromPath: "archive.tar.gz", toPath: "backup.gz" }),
      ),
    );
  });

  it("leaves a file without an extension in place when its name is untouched", async () => {
    render(<Explorer {...explorerProps()} />);
    const input = await beginRename("LICENSE");
    expect((input as HTMLInputElement).value).toBe("LICENSE");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(screen.queryByTestId("tree-edit-input")).toBeNull();
    expect(moveWorkspacePath).not.toHaveBeenCalled();
  });

  it("keeps a file without an extension extensionless", async () => {
    render(<Explorer {...explorerProps()} />);
    await renameTo("LICENSE", "NOTICE");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        fromPath: "LICENSE",
        toPath: "NOTICE",
      }),
    );
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.path).toBe("NOTICE"));
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
// Focus returns to the renamed row during the same keydown. A browser presses
// that row with the key's default action, which opened the new path before
// the move made it, and the editor stayed on "no longer available".
it("keeps the key that ends a rename from pressing the row focus returns to", async () => {
  for (const key of ["Enter", "Escape"]) {
    const { unmount } = render(<Explorer {...explorerProps()} />);
    const input = await beginRename("notes.md");
    fireEvent.change(input, { target: { value: "plan.md" } });
    expect(fireEvent.keyDown(input, { key }), key).toBe(false);
    unmount();
  }
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

it("does not close a new folder input while a rename waits to begin", async () => {
  const begin = deferred<null>();
  const props = { ...explorerProps(), onBeginChanges: vi.fn().mockReturnValueOnce(begin.promise) };
  const view = render(<Explorer {...props} />);
  await renameTo("hello.m", "renamed.md");
  expect((screen.getByTestId("tree-edit-input") as HTMLInputElement).readOnly).toBe(true);
  view.rerender(<Explorer {...props} newFolderRequest={1} />);
  const nextInput = screen.getByTestId("tree-edit-input");
  expect((nextInput as HTMLInputElement).readOnly).toBe(false);
  await act(async () => { begin.resolve(null); });
  expect(screen.getByTestId("tree-edit-input")).toBe(nextInput);
  expect(document.activeElement).toBe(nextInput);
});
