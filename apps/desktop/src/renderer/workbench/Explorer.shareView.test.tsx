// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

// What A DELETE PROMISES (#802, sweep blocker 3 and delta findings 5 and 8).
//
// An ordinary workspace's delete goes to a trash with a recovery record, and
// its notice offers Undo, so it runs without asking.
//
// A share view's delete removes the projection of a moment. There is no trash
// on that path, so the local copy goes IRREVERSIBLY — and `AGENTS.md` requires
// telling the user that before an irreversible change runs, not after. What
// can still be taken back is the change, because the granter's copy is
// untouched until they accept it. The dialog has to say that, or it is a
// durability promise dohc cannot keep.

const GRANTER = "granter@dohc.test";

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [
      { path: "note.md", kind: "file" },
      { path: "other.md", kind: "file" },
    ],
    folders: [],
    editorGroups: [
      { id: "group-1", tabs: [{ path: "note.md" }], activeTab: "note.md", size: 1 },
    ],
    activeEditorGroup: "group-1",
    dirtyPaths: new Set(),
    shareView: null,
    recoveryPaths: new Set(),
    expandedFolders: [],
    pinned: [],
    openEditorsHeight: 200,
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
    listingRequest: 0,
    onRefresh: vi.fn(() => 1),
    onError: vi.fn(),
    onNotice: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function confirmText(select: "one" | "two"): string {
  const rows = within(screen.getByTestId("file-tree")).getAllByTestId("tree-row");
  fireEvent.click(rows[0]!);
  if (select === "two") fireEvent.click(rows[1]!, { ctrlKey: true });
  fireEvent.keyDown(rows[0]!, { key: "Delete" });
  return screen.getByTestId("delete-confirm").textContent ?? "";
}

describe("the delete confirmation states where the file goes", () => {
  it("asks nothing in an ordinary workspace, where the delete can be undone", async () => {
    const deleteWorkspacePath = vi.fn(async () => ({ trashed: true }));
    vi.stubGlobal("dohcDesktop", { deleteWorkspacePath });
    try {
      render(<Explorer {...explorerProps()} />);
      const rows = within(screen.getByTestId("file-tree")).getAllByTestId("tree-row");
      fireEvent.click(rows[0]!);
      fireEvent.keyDown(rows[0]!, { key: "Delete" });
      expect(screen.queryByTestId("delete-confirm")).toBeNull();
      await waitFor(() => expect(deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-1", relativePath: "note.md" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("states the local delete is irreversible, and names who still has the file", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: GRANTER } })} />);
    const text = confirmText("one");
    // No recovery is PROMISED — neither location the ordinary dialog names.
    expect(
      text,
      "a share view's delete has no trash to restore from, so promising one is a durability claim dohc cannot keep",
    ).not.toContain("system trash");
    expect(text).not.toContain(".dohc/local/trash");
    expect(text).not.toContain("restored from there");
    // And the irreversibility is stated, before the change runs. An
    // irreversible change the user is told about afterwards is the product
    // invariant this dialog exists to satisfy.
    expect(text).toContain("It goes from your copy now.");
    expect(
      text,
      "the recipient's local copy goes with no trash behind it, and nothing says so before they confirm",
    ).toContain("There is no trash to restore it from.");
    // Who still has it, by name rather than by description.
    expect(
      text,
      "a delete that describes the granter instead of naming them leaves the reader guessing who to ask",
    ).toContain(GRANTER);
    // And the Next, which is the one thing that can still be taken back.
    expect(text).toContain("You can take the change back before then.");
  });

  it("reads as plural for a multi-file selection", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: GRANTER } })} />);
    const text = confirmText("two");
    expect(text).toContain("2 items");
    expect(
      text,
      "a singular sentence over a multi-file selection is wrong on the surface that decides a delete",
    ).toContain("They go from your copy now.");
    expect(text).toContain("There is no trash to restore them from.");
    expect(text).toContain("still has them until");
  });

  it("falls back to a description when the grant names no granter", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: null } })} />);
    const text = confirmText("one");
    expect(text).toContain("The person who shared it still has it");
  });
});
