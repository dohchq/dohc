// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { splitName } from "../ui/MiddleCutName";
import { Explorer, type ExplorerProps } from "./Explorer";

afterEach(cleanup);

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    mode: "files",
    onModeChange: vi.fn(),
    listed: true,
    recentFiles: [],
    files: [],
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
    onNewCollection: vi.fn(),
    ...overrides,
  };
}

function file(path: string): WorkspaceFileEntry {
  return { path, kind: "file" };
}

function treeRow(path: string): HTMLElement {
  const row = screen.getAllByTestId("tree-row").find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  return row;
}

function parts(element: HTMLElement): [string | null | undefined, string | null | undefined] {
  return [
    element.querySelector("[data-name-start]")?.textContent,
    element.querySelector("[data-name-end]")?.textContent,
  ];
}

const NOTES = "2026-07-08-meeting-notes.md";
const FOLDER = "quarterly-planning-and-budget-review-2026";

describe("splitName", () => {
  it("keeps the last five characters and the whole extension in the end", () => {
    expect(splitName(NOTES)).toEqual({ start: "2026-07-08-meeting-", end: "notes.md" });
    expect(splitName("flow-for-the-launch.excalidraw")).toEqual({ start: "flow-for-the-l", end: "aunch.excalidraw" });
    expect(splitName(FOLDER)).toEqual({ start: "quarterly-planning-and-budget-review", end: "-2026" });
  });

  it("joins back into the name", () => {
    for (const name of [NOTES, FOLDER, ".gitignore", "a.md", "plan", "copy (2).md", "Q3 report v1.5", "café 🚀 notes.md"]) {
      const { start, end } = splitName(name);
      expect(start + end).toBe(name);
    }
  });

  it("takes no extension from a leading dot, a space, or a long suffix", () => {
    expect(splitName(".gitignore").end).toBe("gnore");
    expect(splitName("Meeting with Ana re. the venue").end).toBe("venue");
    expect(splitName("notes.a-suffix-far-too-long").end).toBe("-long");
  });

  it("never splits a character made of two code units", () => {
    expect(splitName("launch-plan-🚀🚀🚀🚀🚀")).toEqual({ start: "launch-plan-", end: "🚀🚀🚀🚀🚀" });
  });

  it("leaves a short name whole in the end", () => {
    expect(splitName("plan.md")).toEqual({ start: "", end: "plan.md" });
  });
});

describe("Explorer names", () => {
  it("draws a long tree name as a start that shrinks and an end that stays", () => {
    render(<Explorer {...explorerProps({ files: [file(`notes/${NOTES}`), file(`${FOLDER}/plan.md`)], folders: [FOLDER, "notes"], expandedFolders: ["notes"] })} />);
    const row = treeRow(`notes/${NOTES}`);
    expect(parts(row)).toEqual(["2026-07-08-meeting-", "notes.md"]);
    expect(row.querySelector("[data-name-start]")?.className).toContain("text-ellipsis");
    expect(row.querySelector("[data-name-end]")?.className).toContain("shrink-0");
    expect(parts(treeRow(FOLDER))).toEqual(["quarterly-planning-and-budget-review", "-2026"]);
  });

  it("names the tree row and its tooltip with the whole name", () => {
    render(<Explorer {...explorerProps({ files: [file(`notes/${NOTES}`), file(`${FOLDER}/plan.md`)], folders: [FOLDER, "notes"], expandedFolders: ["notes"] })} />);
    for (const [path, name] of [[`notes/${NOTES}`, NOTES], [FOLDER, FOLDER]] as const) {
      const row = treeRow(path);
      // Chromium reads the two parts' boxes as two words. jsdom does not, so
      // check the label that keeps the name whole, as well as the role's name.
      expect(row.getAttribute("aria-label")).toBe(name);
      expect(screen.getByRole("treeitem", { name })).toBe(row);
      expect(row.title).toBe(name);
      expect(row.textContent).toBe(name);
    }
  });

  it("draws a short tree name in one part, as before", () => {
    render(<Explorer {...explorerProps({ files: [file("plan.md")] })} />);
    const row = treeRow("plan.md");
    expect(parts(row)).toEqual([undefined, undefined]);
    expect(row.textContent).toBe("plan.md");
    expect(row.getAttribute("aria-label")).toBe("plan.md");
  });

  it("draws a long open editor title the same way and keeps its whole name", () => {
    const path = `notes/${NOTES}`;
    render(
      <Explorer
        {...explorerProps({
          files: [file(path)],
          editorGroups: [{ id: "group-1", tabs: [{ path }], activeTab: null, size: 1 }],
          dirtyPaths: new Set([path]),
        })}
      />,
    );
    const row = screen.getByTestId("open-editor-row");
    expect(parts(row)).toEqual(["2026-07-08-meeting-", "notes.md"]);
    const open = within(row).getByRole("button", { name: `${NOTES}, unsaved changes` });
    expect(open.title).toBe(path);
    expect(within(row).getByRole("button", { name: `Close ${NOTES}` })).toBeTruthy();
  });
});
