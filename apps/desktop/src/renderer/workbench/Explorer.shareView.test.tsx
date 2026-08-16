// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

// WHAT A DELETE PROMISES (#802, sweep blocker 3 and delta findings 5 and 8).
//
// An ordinary workspace's delete goes to a trash and can be restored from
// there — from the system trash, or from `.dohc/trash` whenever the system
// trash refuses, which is any rejection and not only a drive that lacks one.
//
// A share view's delete removes the projection of a moment. There is no trash
// on that path, so the local copy goes IRREVERSIBLY — and `AGENTS.md` requires
// telling the user that before an irreversible change runs, not after. What
// can still be taken back is the CHANGE, because the granter's copy is
// untouched until they accept it. Each dialog has to say the one that is true,
// or it is a durability promise dohc cannot keep.

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

function confirmText(select: "one" | "two"): string {
  const rows = within(screen.getByTestId("file-tree")).getAllByTestId("tree-row");
  fireEvent.click(rows[0]!);
  if (select === "two") fireEvent.click(rows[1]!, { ctrlKey: true, metaKey: true });
  fireEvent.keyDown(rows[0]!, { key: "Delete" });
  return screen.getByTestId("delete-confirm").textContent ?? "";
}

describe("the delete confirmation states where the file goes", () => {
  it("names both recovery locations in an ordinary workspace", () => {
    render(<Explorer {...explorerProps()} />);
    const text = confirmText("one");
    expect(text).toContain("system trash");
    expect(text).toContain(".dohc/trash");
    expect(text).toContain("restored from there");
    // The fallback fires on ANY trash rejection, not only a drive without one
    // — `deletePath` catches every `trashItem` error, and copy.md names this
    // dialog as the place the narrower claim shipped.
    expect(
      text,
      "MUTATION: the stated condition is narrower than the one deletePath actually falls back on",
    ).not.toContain("drives without one");
    expect(text).toContain("whenever the system trash refuses");
  });

  it("states the local delete is irreversible, and names who still has the file", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: GRANTER } })} />);
    const text = confirmText("one");
    // No recovery is PROMISED — neither location the ordinary dialog names.
    expect(
      text,
      "MUTATION: a share view's delete has no trash to restore from, so promising one is a durability claim dohc cannot keep",
    ).not.toContain("system trash");
    expect(text).not.toContain(".dohc/trash");
    expect(text).not.toContain("restored from there");
    // And the irreversibility is STATED, before the change runs. An
    // irreversible change the user is told about afterwards is the product
    // invariant this dialog exists to satisfy.
    expect(text).toContain("It goes from your copy now.");
    expect(
      text,
      "MUTATION: the recipient's local copy goes with no trash behind it, and nothing says so before they confirm",
    ).toContain("There is no trash to restore it from.");
    // WHO still has it, by name rather than by description.
    expect(
      text,
      "MUTATION: a delete that describes the granter instead of naming them leaves the reader guessing who to ask",
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
      "MUTATION: a singular sentence over a multi-file selection is wrong on the surface that decides a delete",
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
