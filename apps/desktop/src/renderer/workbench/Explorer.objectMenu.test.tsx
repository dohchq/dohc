// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, ExplorerMenuEntry } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { Explorer, type ExplorerProps } from "./Explorer";

// The Explorer's menu draws what main returns and nothing else, opens from
// the pointer and from the keyboard, and gives focus back to its row. A
// rename, move or delete main recorded says so with Undo, and a menu never
// outlives its workspace.

const RENAME: ExplorerMenuEntry = { kind: "item", label: "Rename", id: "rename" };
const DELETE: ExplorerMenuEntry = { kind: "item", label: "Delete", id: "delete" };
const PIN: ExplorerMenuEntry = { kind: "item", label: "Pin", id: "pin" };
const EXPORT: ExplorerMenuEntry = { kind: "item", label: "Export as zip…", id: "export-zip" };
const REVEAL: ExplorerMenuEntry = { kind: "item", label: "Show in File Explorer", id: "open-externally" };
const SEPARATOR: ExplorerMenuEntry = { kind: "separator" };

const RENAMED = "dohc-operation:11111111-1111-4111-8111-111111111111";
const DELETED = "dohc-operation:22222222-2222-4222-8222-222222222222";

const bridge = {
  readExplorerMenu: vi.fn(),
  revealExplorerPath: vi.fn(),
  moveWorkspacePath: vi.fn(),
  deleteWorkspacePath: vi.fn(),
  undoHistoryOperation: vi.fn(),
  exportWorkspaceZip: vi.fn(),
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  bridge.readExplorerMenu.mockResolvedValue([RENAME, DELETE, SEPARATOR, PIN, EXPORT, REVEAL]);
  bridge.revealExplorerPath.mockResolvedValue(undefined);
  bridge.exportWorkspaceZip.mockResolvedValue({ path: null });
  bridge.moveWorkspacePath.mockImplementation(async (payload: { toPath: string }) => ({
    path: payload.toPath, operationId: RENAMED, undo: { available: true },
  }));
  bridge.deleteWorkspacePath.mockResolvedValue({ trashed: true, operationId: DELETED, undo: { available: true } });
  bridge.undoHistoryOperation.mockResolvedValue({ ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [] });
  window.dohcDesktop = { platform: "win32", ...bridge } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-a",
    files: [
      { path: "notes.md", kind: "file" },
      { path: "plan.md", kind: "file" },
      { path: "drafts/old.md", kind: "file" },
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
    onNotice: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function row(path: string): HTMLElement {
  const found = screen.getAllByTestId("tree-row").find((candidate) => candidate.dataset.path === path);
  if (!found) throw new Error(`no tree row for ${path}`);
  return found;
}

function shownPaths(): (string | undefined)[] {
  return screen.getAllByTestId("tree-row").map((candidate) => candidate.dataset.path);
}

// Each row's label, without the shortcut drawn after it.
function labels(): (string | null | undefined)[] {
  return screen.getAllByRole("menuitem").map((item) => item.firstElementChild?.textContent);
}

async function renameTo(path: string, name: string): Promise<void> {
  fireEvent.click(row(path));
  fireEvent.keyDown(row(path), { key: "F2" });
  const input = await screen.findByTestId("tree-edit-input");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

// The Undo the notice offered, as the shell's toast would run it.
async function noticeWithUndo(props: ExplorerProps, message: string): Promise<() => void> {
  await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(message, expect.any(Function)));
  return vi.mocked(props.onNotice).mock.calls.find(([text]) => text === message)![1]!;
}

describe("the Explorer's menu", () => {
  it("asks main about what was right-clicked and draws only the entries main returned", async () => {
    bridge.readExplorerMenu.mockResolvedValue([RENAME, SEPARATOR, EXPORT]);
    render(<Explorer {...explorerProps({ pinned: ["notes.md"] })} />);
    fireEvent.contextMenu(row("notes.md"), { clientX: 30, clientY: 40 });

    const menu = await screen.findByRole("menu", { name: "notes.md" });
    expect(bridge.readExplorerMenu).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "notes.md", kind: "file", pinned: true });
    expect(labels()).toEqual(["Rename", "Export as zip…"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(menu.style.left).toBe("30px");
    expect(menu.style.top).toBe("40px");
    // The tree's own keys, shown beside the rows that run them.
    expect(screen.getByRole("menuitem", { name: "Rename" }).getAttribute("aria-keyshortcuts")).toBe("F2");
  });

  it("asks for the folder and the workspace's own menus", async () => {
    render(<Explorer {...explorerProps()} />);
    fireEvent.contextMenu(row("drafts"));
    await screen.findByRole("menu", { name: "drafts" });
    expect(bridge.readExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", path: "drafts", kind: "folder", pinned: false });
    fireEvent.pointerDown(screen.getByTestId("file-tree"));
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    await screen.findByRole("menu", { name: "Files" });
    expect(bridge.readExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", kind: "root", pinned: false });
  });

  it("opens nothing when main offers nothing, or when a newer right-click overtook it", async () => {
    bridge.readExplorerMenu.mockResolvedValueOnce([]);
    render(<Explorer {...explorerProps()} />);
    fireEvent.contextMenu(row("notes.md"));
    await act(async () => {});
    expect(screen.queryByRole("menu")).toBeNull();

    const slow = deferred<ExplorerMenuEntry[]>();
    bridge.readExplorerMenu.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([PIN]);
    fireEvent.contextMenu(row("notes.md"));
    fireEvent.contextMenu(row("plan.md"));
    await screen.findByRole("menu", { name: "plan.md" });
    await act(async () => slow.resolve([RENAME]));
    expect(screen.getByRole("menu", { name: "plan.md" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("opens nothing when Escape or a press elsewhere comes before main answers", async () => {
    render(<Explorer {...explorerProps()} />);
    for (const dismiss of [
      () => fireEvent.keyDown(row("notes.md"), { key: "Escape" }),
      () => fireEvent.pointerDown(document.body),
    ]) {
      const late = deferred<ExplorerMenuEntry[]>();
      bridge.readExplorerMenu.mockReturnValueOnce(late.promise);
      fireEvent.contextMenu(row("notes.md"));
      dismiss();
      await act(async () => late.resolve([RENAME]));
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(row("notes.md"));
    }
  });

  it.each([
    ["the Menu key", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("opens under the focused row from %s, moves with arrows and letters, and gives focus back on Escape", async (_name, key) => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    const target = row("plan.md");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 100, 200, 28));
    target.focus();
    fireEvent.keyDown(target, key);
    const menu = await screen.findByRole("menu", { name: "plan.md" });
    expect(menu.style.left).toBe("12px");
    expect(menu.style.top).toBe("128px");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    // The browser's own contextmenu event for the key opens no second menu.
    fireEvent.contextMenu(target);
    await act(async () => {});
    expect(bridge.readExplorerMenu).toHaveBeenCalledOnce();

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    await user.keyboard("e");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Export as zip…" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Show in File Explorer" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row("plan.md")));

    // A right-click after the key presses its pointer first, and opens.
    fireEvent.pointerDown(row("notes.md"));
    fireEvent.contextMenu(row("notes.md"));
    await screen.findByRole("menu", { name: "notes.md" });
  });

  it("gives focus back to the right-clicked row after a pick", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    fireEvent.contextMenu(row("notes.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row("notes.md")));
  });

  it("starts a rename from the menu with focus in the name field", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    fireEvent.contextMenu(row("notes.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByTestId("tree-edit-input");
    await act(async () => {});
    expect(document.activeElement).toBe(input);
  });

  it("runs each pick through its own operation, which main checks again", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.contextMenu(row("notes.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Show in File Explorer" }));
    expect(bridge.revealExplorerPath).toHaveBeenCalledWith({ workspaceId: "workspace-a", path: "notes.md" });

    bridge.revealExplorerPath.mockRejectedValueOnce(new Error("no such file"));
    fireEvent.pointerDown(row("plan.md"));
    fireEvent.contextMenu(row("plan.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Show in File Explorer" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("no such file", expect.any(Error)));

    fireEvent.contextMenu(row("plan.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(props.onTogglePin).toHaveBeenCalledWith("plan.md");
  });

  it("deletes from the menu without asking, since Undo can bring it back", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.contextMenu(row("notes.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-a", relativePath: "notes.md" }));
    await noticeWithUndo(props, "Deleted notes.md");
  });

  it("still asks in a share view, whose delete has no trash", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ shareView: { granterEmail: "owner@dohc.test" } })} />);
    fireEvent.contextMenu(row("notes.md"));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByTestId("delete-confirm")).toBeTruthy();
    expect(bridge.deleteWorkspacePath).not.toHaveBeenCalled();
  });
});

describe("Undo after a rename, a move or a delete", () => {
  it("undoes a rename with the operation id main returned, and moves its tabs back", async () => {
    const props = explorerProps();
    render(<Explorer {...props} />);
    await renameTo("notes.md", "ideas");
    const undo = await noticeWithUndo(props, "Renamed notes.md to ideas.md");

    vi.mocked(props.onPathsChanged).mockClear();
    act(() => undo());
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledWith({ workspaceId: "workspace-a", operationId: RENAMED }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Renamed ideas.md back to notes.md"));
    expect(props.onPathsChanged).toHaveBeenCalledWith([expect.objectContaining({ kind: "file", fromPath: "ideas.md", toPath: "notes.md" })]);
  });

  it("undoes a delete from the Delete key", async () => {
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.click(row("plan.md"));
    fireEvent.keyDown(row("plan.md"), { key: "Delete" });
    const undo = await noticeWithUndo(props, "Deleted plan.md");
    act(() => undo());
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledWith({ workspaceId: "workspace-a", operationId: DELETED }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Restored plan.md"));
  });

  // Each Undo runs before a listing has shown its change, so the next
  // listing looks as it did before the change.
  it("shows what an immediate Undo put back once the next listing lands", async () => {
    const props = explorerProps();
    const view = render(<Explorer {...props} />);
    fireEvent.click(row("plan.md"));
    fireEvent.keyDown(row("plan.md"), { key: "Delete" });
    const undoDelete = await noticeWithUndo(props, "Deleted plan.md");
    expect(shownPaths()).not.toContain("plan.md");
    act(() => undoDelete());
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Restored plan.md"));
    view.rerender(<Explorer {...props} files={[...props.files]} />);
    expect(shownPaths()).toContain("plan.md");

    await renameTo("notes.md", "ideas");
    const undoRename = await noticeWithUndo(props, "Renamed notes.md to ideas.md");
    act(() => undoRename());
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Renamed ideas.md back to notes.md"));
    view.rerender(<Explorer {...props} files={[...props.files]} />);
    expect(shownPaths()).toContain("notes.md");
    expect(shownPaths()).not.toContain("ideas.md");
  });

  it("gives a drag-and-drop move the same Undo", async () => {
    const props = explorerProps();
    render(<Explorer {...props} />);
    const dataTransfer = { effectAllowed: "move", dropEffect: "move", files: [], types: [], setData: vi.fn() };
    fireEvent.dragStart(row("notes.md"), { dataTransfer });
    fireEvent.dragOver(row("drafts"), { dataTransfer });
    fireEvent.drop(row("drafts"), { dataTransfer });
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-a", fromPath: "notes.md", toPath: "drafts/notes.md" }));
    const undo = await noticeWithUndo(props, "Moved notes.md to drafts");
    act(() => undo());
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledWith({ workspaceId: "workspace-a", operationId: RENAMED }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Moved notes.md back to Files"));
  });

  it("files main's refusal with Try again, which asks main again", async () => {
    const reason = "Cannot undo the rename. notes.md now occupies the old path. Move it first.";
    bridge.undoHistoryOperation.mockResolvedValueOnce({ ok: false, reason });
    const props = explorerProps();
    render(<Explorer {...props} />);
    await renameTo("notes.md", "ideas");
    const undo = await noticeWithUndo(props, "Renamed notes.md to ideas.md");
    act(() => undo());
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(reason, expect.any(Error), expect.any(Function)));
    expect(props.onNotice).not.toHaveBeenCalledWith("Renamed ideas.md back to notes.md");

    const retry = vi.mocked(props.onError).mock.calls[0]![2]!;
    act(() => retry());
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledTimes(2));
    expect(bridge.undoHistoryOperation).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", operationId: RENAMED });
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Renamed ideas.md back to notes.md"));
  });

  it("files a part-finished Undo with main's words, and Try again only where it can help", async () => {
    bridge.undoHistoryOperation.mockResolvedValueOnce({
      ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [],
      remaining: [{ path: "plan.md", reason: "dohc could not put plan.md back. It stays at drafts/plan.md.", retry: false }],
    });
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.click(row("plan.md"));
    fireEvent.keyDown(row("plan.md"), { key: "Delete" });
    const undo = await noticeWithUndo(props, "Deleted plan.md");
    act(() => undo());
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(
      "dohc could not put plan.md back. It stays at drafts/plan.md.", expect.any(Error), undefined));
  });

  it("offers no Undo main cannot run, and says why in main's words", async () => {
    bridge.moveWorkspacePath.mockResolvedValueOnce({
      path: "archive", operationId: RENAMED,
      undo: { available: false, reason: "Undo for a folder rename isn't available yet. Rename it back yourself.", paths: [] },
    });
    const props = explorerProps();
    render(<Explorer {...props} />);
    await renameTo("drafts", "archive");
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(
      "Renamed drafts to archive. Undo for a folder rename isn't available yet. Rename it back yourself.", undefined));
  });

  it("says nothing new for a change that is not a History operation", async () => {
    bridge.moveWorkspacePath.mockResolvedValueOnce({ path: "ideas.md" });
    const props = explorerProps();
    render(<Explorer {...props} />);
    await renameTo("notes.md", "ideas");
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalled());
    expect(props.onNotice).not.toHaveBeenCalled();
  });
});

// The shell holds notices and Undo to their workspace; the shell's own
// tests cover that.
describe("a workspace switch", () => {
  it("closes a menu left open, so it cannot act in workspace B", async () => {
    const props = explorerProps();
    const view = render(<Explorer {...props} />);
    fireEvent.contextMenu(row("notes.md"));
    await screen.findByRole("menu", { name: "notes.md" });
    view.rerender(<Explorer {...props} workspaceId="workspace-b" />);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
