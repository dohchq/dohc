// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { Explorer, type ExplorerProps } from "./Explorer";
import { createNotVersionedMarks, NotVersionedMarks } from "./notVersionedMarks";

const moveWorkspacePath = vi.fn();
const deleteWorkspacePath = vi.fn();
const readExplorerMenu = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  moveWorkspacePath.mockResolvedValue({ path: "" });
  deleteWorkspacePath.mockResolvedValue({ trashed: true });
  readExplorerMenu.mockResolvedValue([]);
  window.dohcDesktop = {
    moveWorkspacePath,
    deleteWorkspacePath,
    readExplorerMenu,
  } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function explorerProps(): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    mode: "files",
    onModeChange: vi.fn(),
    listed: true,
    files: [
      { path: "clip.mp4", kind: "file" },
      { path: "notes.md", kind: "file" },
    ],
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
    listingRequest: 0,
    onRefresh: vi.fn(() => 1),
    onError: vi.fn(),
    onNotice: vi.fn(),
    onNewCollection: vi.fn(),
  };
}

function renderExplorer(marked: string[]) {
  const marks = createNotVersionedMarks();
  marks.set(marked);
  const props = explorerProps();
  render(
    <NotVersionedMarks.Provider value={marks}>
      <Explorer {...props} />
    </NotVersionedMarks.Provider>,
  );
  return { marks, props };
}

const row = (path: string) =>
  screen.getAllByTestId("tree-row").find((candidate) => candidate.dataset.path === path)!;

async function renameTo(path: string, name: string) {
  fireEvent.click(row(path));
  fireEvent.keyDown(row(path), { key: "F2" });
  const input = await screen.findByTestId("tree-edit-input");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("Explorer, in a version, for files it does not track", () => {
  it("marks those rows Not versioned, and no others", () => {
    renderExplorer(["clip.mp4"]);
    expect(row("clip.mp4").dataset.notVersioned).toBe("true");
    expect(row("clip.mp4").getAttribute("aria-label")).toBe("clip.mp4, Not versioned");
    expect(row("clip.mp4").querySelector("[data-testid=tree-row-not-versioned]")?.textContent).toBe(
      "Not versioned",
    );
    expect(row("notes.md").dataset.notVersioned).toBeUndefined();
    expect(row("notes.md").querySelector("[data-testid=tree-row-not-versioned]")).toBeNull();
  });

  it("asks before a rename, and Cancel changes nothing", async () => {
    renderExplorer(["clip.mp4"]);
    await renameTo("clip.mp4", "renamed.mp4");
    const dialog = await screen.findByTestId("not-versioned-confirm");
    expect(dialog.textContent).toContain("Rename clip.mp4 in Main too?");
    expect(dialog.textContent).toContain(
      "It isn't versioned, so Main and every version have the same copy.",
    );
    fireEvent.click(screen.getByTestId("cancel-not-versioned"));
    await waitFor(() => expect(screen.queryByTestId("not-versioned-confirm")).toBeNull());
    expect(moveWorkspacePath).not.toHaveBeenCalled();
  });

  it("renames once the person agrees, telling main they did", async () => {
    renderExplorer(["clip.mp4"]);
    await renameTo("clip.mp4", "renamed.mp4");
    fireEvent.click(await screen.findByTestId("confirm-not-versioned"));
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        fromPath: "clip.mp4",
        toPath: "renamed.mp4",
        confirmNotVersioned: true,
      }),
    );
  });

  it("asks before a delete, then deletes", async () => {
    renderExplorer(["clip.mp4"]);
    fireEvent.click(row("clip.mp4"));
    fireEvent.keyDown(row("clip.mp4"), { key: "Delete" });
    const dialog = await screen.findByTestId("not-versioned-confirm");
    expect(dialog.textContent).toContain("Delete clip.mp4 from Main too?");
    expect(deleteWorkspacePath).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-not-versioned"));
    await waitFor(() =>
      expect(deleteWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        relativePath: "clip.mp4",
        confirmNotVersioned: true,
      }),
    );
  });

  it("changes a tracked file without asking", async () => {
    renderExplorer(["clip.mp4"]);
    await renameTo("notes.md", "renamed.md");
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        fromPath: "notes.md",
        toPath: "renamed.md",
      }),
    );
    expect(screen.queryByTestId("not-versioned-confirm")).toBeNull();
  });

  it("asks when main refuses a file the marks had not caught, then runs it again", async () => {
    const { props } = renderExplorer([]);
    moveWorkspacePath.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'desktop:move-workspace-path': NotVersionedError: This change also happens in Main, because notes.md isn't versioned.\nnotes.md",
      ),
    );
    await renameTo("notes.md", "renamed.md");
    const dialog = await screen.findByTestId("not-versioned-confirm");
    expect(dialog.textContent).toContain("Rename notes.md in Main too?");
    expect(props.onError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-not-versioned"));
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenLastCalledWith({
        workspaceId: "workspace-1",
        fromPath: "notes.md",
        toPath: "renamed.md",
        confirmNotVersioned: true,
      }),
    );
  });
});

describe("Explorer Home, in a version", () => {
  it("marks a file it does not track, and no others", async () => {
    const marks = createNotVersionedMarks();
    marks.set(["clip.mp4"]);
    render(
      <NotVersionedMarks.Provider value={marks}>
        <Explorer {...explorerProps()} mode="home" />
      </NotVersionedMarks.Provider>,
    );
    const homeRow = (path: string) =>
      screen.getAllByTestId("home-row").find((candidate) => candidate.dataset.path === path);
    await waitFor(() => expect(homeRow("clip.mp4")?.dataset.notVersioned).toBe("true"));
    expect(
      homeRow("clip.mp4")!.querySelector("[data-testid=home-row-not-versioned]")?.textContent,
    ).toBe("Not versioned");
    expect(homeRow("clip.mp4")!.title).toContain("changes it in Main too");
  });
});

it("a second refusal waits behind the first question, and neither is lost", async () => {
  const refusal = (path: string) =>
    new Error(
      `Error invoking remote method 'desktop:move-workspace-path': NotVersionedError: This change also happens in Main, because ${path} isn't versioned.\n${path}`,
    );
  const { props } = renderExplorer([]);
  moveWorkspacePath.mockRejectedValueOnce(refusal("notes.md"));
  deleteWorkspacePath.mockRejectedValueOnce(refusal("clip.mp4"));
  await renameTo("notes.md", "renamed.md");
  await screen.findByTestId("not-versioned-confirm");
  fireEvent.click(row("clip.mp4"));
  fireEvent.keyDown(row("clip.mp4"), { key: "Delete" });
  await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("not-versioned-confirm").textContent).toContain(
    "Rename notes.md in Main too?",
  );
  fireEvent.click(screen.getByTestId("cancel-not-versioned"));
  await waitFor(() =>
    expect(screen.getByTestId("not-versioned-confirm").textContent).toContain(
      "Delete clip.mp4 from Main too?",
    ),
  );
  expect(screen.getByTestId("not-versioned-confirm").textContent).toContain("system trash");
  fireEvent.click(screen.getByTestId("confirm-not-versioned"));
  await waitFor(() =>
    expect(deleteWorkspacePath).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      relativePath: "clip.mp4",
      confirmNotVersioned: true,
    }),
  );
  expect(props.onError).not.toHaveBeenCalled();
});

it("pressing Delete again asks once, and a question never follows the person to another workspace", async () => {
  const marks = createNotVersionedMarks();
  marks.set(["clip.mp4"]);
  const props = explorerProps();
  const { rerender } = render(
    <NotVersionedMarks.Provider value={marks}>
      <Explorer {...props} />
    </NotVersionedMarks.Provider>,
  );
  fireEvent.click(row("clip.mp4"));
  fireEvent.keyDown(row("clip.mp4"), { key: "Delete" });
  fireEvent.keyDown(row("clip.mp4"), { key: "Delete" });
  fireEvent.click(await screen.findByTestId("cancel-not-versioned"));
  await waitFor(() => expect(screen.queryByTestId("not-versioned-confirm")).toBeNull());

  fireEvent.keyDown(row("clip.mp4"), { key: "Delete" });
  await screen.findByTestId("not-versioned-confirm");
  rerender(
    <NotVersionedMarks.Provider value={marks}>
      <Explorer {...props} workspaceId="workspace-2" />
    </NotVersionedMarks.Provider>,
  );
  await waitFor(() => expect(screen.queryByTestId("not-versioned-confirm")).toBeNull());
  expect(deleteWorkspacePath).not.toHaveBeenCalled();
});

describe("Explorer, for a move main says may change who can see the item", () => {
  const accessRefusal = () =>
    new Error(
      "Error invoking remote method 'desktop:move-workspace-path': AccessChangeError: Moving draft.md into team may change who can see it. People who could read it may keep a copy.",
    );
  function renderWithTeam() {
    const props = {
      ...explorerProps(),
      files: [{ path: "draft.md", kind: "file" as const }],
      folders: ["team"],
    };
    render(<Explorer {...props} />);
    return props;
  }
  function dragInto(path: string, folder: string) {
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      files: [],
      types: [],
      setData: vi.fn(),
    };
    fireEvent.dragStart(row(path), { dataTransfer });
    fireEvent.dragOver(row(folder), { dataTransfer });
    fireEvent.drop(row(folder), { dataTransfer });
  }

  // main finds which folders above it hold a rule, and compares no rules.
  it("asks before the folder's access rules apply, and Cancel moves nothing", async () => {
    const props = renderWithTeam();
    moveWorkspacePath.mockRejectedValueOnce(accessRefusal());
    dragInto("draft.md", "team");
    const dialog = await screen.findByTestId("access-change-confirm");
    expect(within(dialog).getByRole("heading").textContent).toBe("Move draft.md into team?");
    expect(dialog.textContent).toContain(
      "It will follow the access rules for team, which may change who can see it. People who could read it may keep a copy.",
    );
    fireEvent.click(screen.getByTestId("cancel-access-change"));
    await waitFor(() => expect(screen.queryByTestId("access-change-confirm")).toBeNull());
    expect(moveWorkspacePath).toHaveBeenCalledTimes(1);
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("moves once the person agrees, telling main they did", async () => {
    const props = renderWithTeam();
    moveWorkspacePath.mockRejectedValueOnce(accessRefusal());
    dragInto("draft.md", "team");
    fireEvent.click(await screen.findByTestId("confirm-access-change"));
    await waitFor(() =>
      expect(moveWorkspacePath).toHaveBeenLastCalledWith({
        workspaceId: "workspace-1",
        fromPath: "draft.md",
        toPath: "team/draft.md",
        confirmAccessChange: true,
      }),
    );
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("keeps a move's question when another move in the batch asks it after Not versioned", async () => {
    const props = {
      ...explorerProps(),
      files: [
        { path: "draft.md", kind: "file" as const },
        { path: "clip.mp4", kind: "file" as const },
      ],
      folders: ["team"],
    };
    render(<Explorer {...props} />);
    const access = (name: string) =>
      new Error(
        `Error invoking remote method 'desktop:move-workspace-path': AccessChangeError: Moving ${name} into team may change who can see it. People who could read it may keep a copy.`,
      );
    moveWorkspacePath.mockImplementation(
      async (input: { fromPath: string; confirmNotVersioned?: boolean }) => {
        if (input.fromPath === "draft.md") throw access("draft.md");
        if (!input.confirmNotVersioned)
          throw new Error(
            "Error invoking remote method 'desktop:move-workspace-path': NotVersionedError: This change also happens in Main, because clip.mp4 isn't versioned.\nclip.mp4",
          );
        throw access("clip.mp4");
      },
    );
    fireEvent.click(row("draft.md"));
    fireEvent.click(row("clip.mp4"), { ctrlKey: true });
    dragInto("draft.md", "team");
    fireEvent.click(await screen.findByTestId("confirm-not-versioned"));
    await waitFor(() => expect(moveWorkspacePath).toHaveBeenCalledTimes(3));
    const dialog = await screen.findByTestId("access-change-confirm");
    expect(within(dialog).getByRole("heading").textContent).toBe("Move 2 items?");
    moveWorkspacePath.mockResolvedValue({ path: "" });
    fireEvent.click(screen.getByTestId("confirm-access-change"));
    await waitFor(() => expect(moveWorkspacePath).toHaveBeenCalledTimes(5));
    expect(moveWorkspacePath).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      fromPath: "draft.md",
      toPath: "team/draft.md",
      confirmAccessChange: true,
    });
    expect(moveWorkspacePath).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      fromPath: "clip.mp4",
      toPath: "team/clip.mp4",
      confirmNotVersioned: true,
      confirmAccessChange: true,
    });
    expect(props.onError).not.toHaveBeenCalled();
  });
});
