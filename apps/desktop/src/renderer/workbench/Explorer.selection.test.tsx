// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { Explorer, type ExplorerProps, type RefusedChanges } from "./Explorer";
import { deleteRefusalIdentity } from "./file-tree-optimistic";

const BLUE = "bg-[var(--dohc-selection)]";
const deleteWorkspacePath = vi.fn();
const showExplorerMenu = vi.fn();

function setPlatform(platform: string) {
  window.dohcDesktop = { platform, deleteWorkspacePath, showExplorerMenu } as unknown as DohcDesktopBridge;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  deleteWorkspacePath.mockReset();
  deleteWorkspacePath.mockResolvedValue(undefined);
  showExplorerMenu.mockResolvedValue(null);
  setPlatform("win32");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FILES = ["a.md", "b.md", "c.md", "d.md"].map((path) => ({ path, kind: "file" as const }));

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    mode: "files",
    onModeChange: vi.fn(),
    listed: true,
    recentFiles: [],
    files: FILES,
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
    onChangesRefused: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function row(path: string): HTMLElement {
  const result = screen.getAllByRole("treeitem").find((item) => item.dataset.path === path);
  if (!result) throw new Error(`Missing tree row: ${path}`);
  return result;
}

function selectedPaths(): string[] {
  return screen.getAllByRole("treeitem").filter((item) => item.getAttribute("aria-selected") === "true").map((item) => item.dataset.path!);
}

function liveRegion(): HTMLElement {
  const region = screen.getByTestId("explorer-selection-bar").querySelector<HTMLElement>("[role=status]");
  if (!region) throw new Error("Missing the selection count's live region");
  return region;
}

describe("clicks", () => {
  it("select a range with Shift-click, and open the row when the anchor is gone", () => {
    const props = explorerProps();
    const view = render(<Explorer {...props} />);
    fireEvent.click(row("d.md"));
    fireEvent.click(row("b.md"), { shiftKey: true });
    expect(selectedPaths()).toEqual(["b.md", "c.md", "d.md"]);
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);

    view.rerender(<Explorer {...props} files={FILES.filter((file) => file.path !== "d.md")} />);
    fireEvent.click(row("a.md"), { shiftKey: true });
    expect(selectedPaths()).toEqual(["a.md"]);
    expect(props.onOpenFile).toHaveBeenLastCalledWith("a.md");
  });
});

describe("Shift+Up and Shift+Down", () => {
  it("extend the selection from the anchor, in either direction", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    await user.click(row("b.md"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(selectedPaths()).toEqual(["b.md", "c.md", "d.md"]);
    expect(document.activeElement).toBe(row("d.md"));
    await user.keyboard("{Shift>}{ArrowUp}{ArrowUp}{ArrowUp}{/Shift}");
    expect(selectedPaths()).toEqual(["a.md", "b.md"]);
    expect(document.activeElement).toBe(row("a.md"));
  });
});

describe("select all", () => {
  it.each([
    ["win32", { ctrlKey: true }, true],
    ["linux", { ctrlKey: true }, true],
    ["darwin", { metaKey: true }, true],
    ["darwin", { ctrlKey: true }, false],
    ["win32", { metaKey: true }, false],
  ] as const)("on %s with %o selects every row: %s", (platform, modifiers, selects) => {
    setPlatform(platform);
    render(<Explorer {...explorerProps()} />);
    fireEvent.click(row("a.md"));
    fireEvent.keyDown(row("a.md"), { key: "a", ...modifiers });
    expect(selectedPaths()).toEqual(selects ? ["a.md", "b.md", "c.md", "d.md"] : ["a.md"]);
  });

  it("selects the rows a virtualized tree has not mounted, wherever it is scrolled", () => {
    const files = Array.from({ length: 500 }, (_, index) => ({ path: `file-${String(index).padStart(4, "0")}.md`, kind: "file" as const }));
    render(<Explorer {...explorerProps({ files })} />);
    const tree = screen.getByTestId("file-tree");
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 280 });
    vi.spyOn(screen.getByRole("tree"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, -5600, 200, 14000));
    fireEvent.scroll(tree, { target: { scrollTop: 5600 } });
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(64);

    fireEvent.click(row("file-0200.md"));
    fireEvent.keyDown(row("file-0200.md"), { key: "a", ctrlKey: true });
    expect(liveRegion().textContent).toBe("500 selected");
    fireEvent.keyDown(row("file-0200.md"), { key: "Delete" });
    expect(screen.getByTestId("delete-confirm").textContent).toContain("Delete 500 items?");
  });
});

describe("Escape", () => {
  it("clears the selection and leaves focus on the row", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    await user.click(row("a.md"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await user.keyboard("{Escape}");
    expect(selectedPaths()).toEqual([]);
    expect(document.activeElement).toBe(row("b.md"));
  });

  it("closes the delete dialog and keeps the selection", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    await user.click(row("a.md"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}{Delete}");
    expect(screen.getAllByRole("treeitem")).not.toContain(document.activeElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    expect(selectedPaths()).toEqual(["a.md", "b.md"]);
  });

  it("cancels a rename and keeps the selection", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    await user.click(row("a.md"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}{F2}");
    expect(document.activeElement).toBe(screen.getByTestId("tree-edit-input"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("tree-edit-input")).toBeNull();
    expect(selectedPaths()).toEqual(["a.md", "b.md"]);
  });

  it("leaves the selection when a menu has focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Explorer {...explorerProps()} />
        <div role="menu"><button role="menuitem">Rename</button></div>
      </>,
    );
    await user.click(row("a.md"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    screen.getByRole("menuitem").focus();
    await user.keyboard("{Escape}");
    expect(selectedPaths()).toEqual(["a.md", "b.md"]);
  });
});

describe("the tree", () => {
  it("says several rows can be selected", () => {
    render(<Explorer {...explorerProps()} />);
    expect(screen.getByRole("tree").getAttribute("aria-multiselectable")).toBe("true");
  });
});

describe("the selection bar", () => {
  it("shows the count at two rows or more, and not at one", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    expect(liveRegion().getAttribute("aria-live")).toBe("polite");
    await user.click(row("a.md"));
    expect(screen.getByTestId("explorer-selection-bar").dataset.shown).toBe("false");
    expect(liveRegion().textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();

    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(screen.getByTestId("explorer-selection-bar").dataset.shown).toBe("true");
    expect(liveRegion().textContent).toBe("3 selected");

    await user.click(row("d.md"));
    expect(liveRegion().textContent).toBe("");
  });

  it("clears the selection and moves focus to the tree's focused row", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    await user.click(row("a.md"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const clear = screen.getByRole("button", { name: "Clear selection" });
    expect(clear.title).toBe("Clear selection (Esc)");
    await user.click(clear);
    expect(selectedPaths()).toEqual([]);
    expect(document.activeElement).toBe(row("b.md"));
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
  });
});

describe("the selection fill", () => {
  const open = (path: string) => ({ editorGroups: [{ id: "group-1", tabs: [{ path }], activeTab: path, size: 1 }] });

  it("leaves a plain click on the open row as it was", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps(open("a.md"))} />);
    await user.click(row("a.md"));
    expect(row("a.md").className).not.toContain(BLUE);
    expect(row("a.md").className).toContain("bg-selected");
    expect(row("a.md").className).toContain("font-medium");
  });

  it("marks the open row in a selection blue and keeps its weight", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps(open("a.md"))} />);
    await user.click(row("a.md"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(row("a.md").className).toContain(BLUE);
    expect(row("a.md").className).toContain("font-medium");
    expect(row("b.md").className).toContain(BLUE);
    expect(row("b.md").className).not.toContain("font-medium");
    expect(row("b.md").className).not.toContain("hover:bg-hover");
    expect(row("c.md").className).not.toContain(BLUE);
  });
});

const refusal = (path: string) =>
  new Error(`Error invoking remote method 'desktop:delete-workspace-path': LivePageOwnedError: dohc can't delete "${path}" while it has live editing on\nIn Live documents, stop live editing for this page, then delete it again.`);
const historyOff = (path: string) =>
  new Error(`Error invoking remote method 'desktop:delete-workspace-path': HistoryOffError: dohc can't delete "${path}" without History\nWithout History, dohc can't check whether this page has live editing on. Restart dohc to try again.`);

async function deleteAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(row("a.md"));
  await user.keyboard("{Control>}a{/Control}{Delete}");
  await user.click(screen.getByTestId("confirm-delete"));
}

describe("refusals in a batch", () => {
  it("lets the rest go and raises one notice whose Try again reruns only the refused item", async () => {
    const user = userEvent.setup();
    const props = explorerProps({ files: FILES.slice(0, 3) });
    deleteWorkspacePath.mockImplementation(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "b.md") throw refusal("b.md");
    });
    render(<Explorer {...props} />);
    await deleteAll(user);

    await waitFor(() => expect(props.onChangesRefused).toHaveBeenCalledTimes(1));
    expect(deleteWorkspacePath.mock.calls.map(([payload]) => payload.relativePath)).toEqual(["a.md", "b.md", "c.md"]);
    expect(vi.mocked(props.onPathsChanged).mock.calls[0]![0].map((change) => "path" in change && change.path)).toEqual(["a.md", "c.md"]);
    expect(props.onError).not.toHaveBeenCalled();
    const notice = vi.mocked(props.onChangesRefused).mock.calls[0]![0] as RefusedChanges;
    expect(notice).toMatchObject({
      title: "dohc deleted 2 of 3 items",
      message: "Live editing is on: b.md",
      liveEditing: { path: "b.md" },
    });

    // The rerun is a batch of one, so a second refusal is that page's own notice.
    deleteWorkspacePath.mockClear();
    await act(async () => notice.retry!());
    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(deleteWorkspacePath.mock.calls.map(([payload]) => payload.relativePath)).toEqual(["b.md"]);
    const [, , again, identity, livePage] = vi.mocked(props.onError).mock.calls[0]!;
    expect(again).toBeTypeOf("function");
    expect(identity).toBe(deleteRefusalIdentity("workspace-1", "b.md"));
    expect(livePage).toEqual({ path: "b.md", action: "delete" });
  });

  it("names each reason once, and Try again reruns only what can run again", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    deleteWorkspacePath.mockImplementation(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "a.md" || relativePath === "c.md") throw refusal(relativePath);
      if (relativePath === "d.md") throw historyOff(relativePath);
    });
    render(<Explorer {...props} />);
    await deleteAll(user);

    await waitFor(() => expect(props.onChangesRefused).toHaveBeenCalledTimes(1));
    const notice = vi.mocked(props.onChangesRefused).mock.calls[0]![0] as RefusedChanges;
    expect(notice).toMatchObject({
      title: "dohc deleted 1 of 4 items",
      message: "Live editing is on: a.md, c.md\nHistory is off: d.md",
      liveEditing: { path: "a.md" },
    });
    deleteWorkspacePath.mockClear();
    deleteWorkspacePath.mockResolvedValue(undefined);
    await act(async () => notice.retry!());
    await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledTimes(2));
    expect(deleteWorkspacePath.mock.calls.map(([payload]) => payload.relativePath)).toEqual(["a.md", "c.md"]);
  });

  it("offers no Try again when nothing refused can run again", async () => {
    const user = userEvent.setup();
    const props = explorerProps({ files: FILES.slice(0, 2) });
    deleteWorkspacePath.mockImplementation(async ({ relativePath }: { relativePath: string }) => {
      throw historyOff(relativePath);
    });
    render(<Explorer {...props} />);
    await deleteAll(user);

    await waitFor(() => expect(props.onChangesRefused).toHaveBeenCalledTimes(1));
    const notice = vi.mocked(props.onChangesRefused).mock.calls[0]![0] as RefusedChanges;
    expect(notice).toMatchObject({ title: "dohc could not delete 2 items", message: "History is off: a.md, b.md", liveEditing: null });
    expect(notice.retry).toBeUndefined();
  });
});
