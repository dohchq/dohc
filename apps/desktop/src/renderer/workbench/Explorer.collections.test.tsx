// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorTitle, Explorer, type ExplorerProps } from "./Explorer";
import { collectionTabPath, transactionalCollectionTabPath } from "./workbenchState";

afterEach(cleanup);

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [
      { path: "notes.md", kind: "file" },
      { path: "tasks/one.md", kind: "file" },
      { path: "archive/old.md", kind: "file" },
    ],
    folders: ["tasks", "archive"],
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
    collectionFolders: new Set(["tasks"]),
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

function treeRow(path: string): HTMLElement {
  const row = screen
    .getAllByTestId("tree-row")
    .find((candidate) => candidate.dataset.path === path);
  if (!row) throw new Error(`no tree row for ${path}`);
  return row;
}

describe("Explorer collection folders", () => {
  it("uses the human table label for open data Collections and a neutral loading label",()=>{
    const path=transactionalCollectionTabPath("data/dataset.json","00000000-0000-4000-8000-000000000002");
    expect(editorTitle(path,"Registrations")).toBe("Registrations");expect(editorTitle(path)).toBe("Collection");
  });
  it("offers recovery before the workspace has any data Collections", () => {
    const onRestoreCollection = vi.fn();
    const view = render(<Explorer {...explorerProps({ dataCollections: [], onRestoreCollection })} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Collections" })).getByRole("button", { name: "Restore from recovery file" }));
    expect(onRestoreCollection).toHaveBeenCalledOnce();
    view.rerender(<Explorer {...explorerProps({ dataCollections: [], onRestoreCollection, shareView: { granterEmail: "owner@example.test" } })} />);
    expect(screen.queryByRole("button", { name: "Restore from recovery file" })).toBeNull();
  });
  it("opens the collection on a row click instead of toggling the folder", () => {
    const props = explorerProps();
    render(<Explorer {...props} />);

    fireEvent.click(treeRow("tasks"));

    expect(props.onOpenCollection).toHaveBeenCalledExactlyOnceWith("tasks");
    expect(props.onToggleFolder).not.toHaveBeenCalled();
    expect(props.onOpenFile).not.toHaveBeenCalled();
  });

  it("still toggles a collection folder from its chevron", () => {
    const props = explorerProps();
    render(<Explorer {...props} />);

    fireEvent.click(within(treeRow("tasks")).getByTestId("tree-row-chevron"));

    expect(props.onToggleFolder).toHaveBeenCalledExactlyOnceWith("tasks");
    expect(props.onOpenCollection).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])(
    "opens the collection with %s instead of toggling the folder",
    (_label, key) => {
      const props = explorerProps();
      render(<Explorer {...props} />);
      const row = treeRow("tasks");

      // The click gives the row the tree's internal focus; clear its open so
      // the assertions below measure keyboard activation only.
      fireEvent.click(row);
      vi.mocked(props.onOpenCollection).mockClear();
      fireEvent.keyDown(row, { key });

      expect(props.onOpenCollection).toHaveBeenCalledExactlyOnceWith("tasks");
      expect(props.onToggleFolder).not.toHaveBeenCalled();
    },
  );

  it("keeps plain folders toggling on a row click", () => {
    const props = explorerProps();
    render(<Explorer {...props} />);

    fireEvent.click(treeRow("archive"));

    expect(props.onToggleFolder).toHaveBeenCalledExactlyOnceWith("archive");
    expect(props.onOpenCollection).not.toHaveBeenCalled();
  });

  it("titles a collection tab with the folder leaf", () => {
    expect(editorTitle(collectionTabPath("projects/road trips"))).toBe(
      "road trips",
    );
  });
});

// The words a row's tooltip shows, opened from the keyboard and from the
// pointer, and closed by Escape and by leaving. The words are their own tab
// stop, apart from the row's buttons.
function expectTooltip(trigger: HTMLElement, words: string) {
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(trigger.tabIndex).toBe(0);
  expect(trigger.tagName).not.toBe("BUTTON");
  fireEvent.focus(trigger);
  expect(screen.getByRole("tooltip").textContent).toBe(words);
  expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(trigger);
  fireEvent.mouseEnter(trigger.closest("p")!);
  expect(screen.getByRole("tooltip").textContent).toBe(words);
  fireEvent.mouseLeave(trigger.closest("p")!);
  expect(screen.queryByRole("tooltip")).toBeNull();
}

describe("Collections this computer cannot use", () => {
  it("says where they are in a few words, and offers to keep Collections no computer keeps here", () => {
    const onKeepCollections = vi.fn(), onRetryCollections = vi.fn();
    const words = "dohc doesn't know which computer keeps this workspace's Collections. To keep them on this computer, choose Use this computer in dohc.";
    const { rerender } = render(<Explorer {...explorerProps({ collectionsRefusal: { kind: "unclaimed", words }, onKeepCollections, onRetryCollections,
      dataCollections: [], onRestoreCollection: vi.fn() })} />);
    const section = screen.getByRole("region", { name: "Collections" });
    expect(within(section).getByTestId("collections-refusal").textContent).toBe("Which computer keeps these Collections?Use this computer");
    expect(within(section).queryByText("Restore from recovery file")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Use this computer" }));
    expect(onKeepCollections).toHaveBeenCalledOnce();
    expect(within(section).queryByRole("button", { name: "Try again" })).toBeNull();
    const elsewhere = "These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.";
    rerender(<Explorer {...explorerProps({ collectionsRefusal: { kind: "elsewhere", words: elsewhere, computer: "Laptop" }, onKeepCollections, onRetryCollections })} />);
    expectTooltip(screen.getByText("On Laptop"), elsewhere);
    // Main named no computer: the row says the whole sentence, and still offers both steps.
    rerender(<Explorer {...explorerProps({ collectionsRefusal: { kind: "elsewhere", words: elsewhere, computer: null }, onKeepCollections, onRetryCollections })} />);
    expect(screen.getByTestId("collections-refusal").textContent).toBe(`${elsewhere}Use this computerTry again`);
    expect(screen.getByText(elsewhere).tabIndex).toBe(-1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryCollections).toHaveBeenCalledOnce();
    // Behind main's question, which names the other computer.
    fireEvent.click(screen.getByRole("button", { name: "Use this computer" }));
    expect(onKeepCollections).toHaveBeenCalledTimes(2);
    rerender(<Explorer {...explorerProps({ collectionsRefusal: { kind: "replaced", words: "Another copy replaced it." }, onKeepCollections, onRetryCollections })} />);
    expect(screen.getByTestId("collections-refusal").textContent).toContain("Another copy replaced it.");
    expect(screen.queryByRole("button", { name: "Use this computer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("Collections on this computer's server, where another computer keeps the workspace's own", () => {
  it("lists them as rows and names the computer that keeps the others, without offering recovery here", () => {
    const onKeepCollections = vi.fn();
    const rows = [{ datasetId: "00000000-0000-4000-8000-000000000001", datasetPath: "registrations/dataset.json", tableId: "00000000-0000-4000-8000-000000000002", name: "Registrations" }];
    const words = "Other Collections are on Laptop. Open this workspace there to use them, or to move them to a server.";
    const { rerender } = render(<Explorer {...explorerProps({ dataCollections: rows, collectionsElsewhere: { computer: "Laptop", others: true, words }, onKeepCollections,
      onIncludeArchivedCollections: vi.fn(), onRestoreCollection: vi.fn() })} />);
    const section = screen.getByRole("region", { name: "Collections" });
    expect(within(section).getByRole("button", { name: "Registrations" })).toBeTruthy();
    expectTooltip(within(section).getByText("Others on Laptop"), words);
    expect(within(section).getByTestId("collections-elsewhere").textContent).toBe(`Others on Laptop${words}Use this computer`);
    expect(within(section).queryByTestId("collections-refusal")).toBeNull();
    expect(within(section).getByLabelText("Archived collections")).toBeTruthy();
    expect(within(section).queryByText("Restore from recovery file")).toBeNull();
    // Behind main's question, which names the other computer.
    fireEvent.click(within(section).getByRole("button", { name: "Use this computer" }));
    expect(onKeepCollections).toHaveBeenCalledOnce();
    // The server didn't answer: no rows, the line, and Keep.
    const offline = "These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.";
    rerender(<Explorer {...explorerProps({ dataCollections: [], collectionsElsewhere: { computer: "Laptop", others: false, words: offline }, onKeepCollections, onRestoreCollection: vi.fn() })} />);
    expectTooltip(screen.getByText("On Laptop"), offline);
    expect(screen.queryByRole("button", { name: "Registrations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use this computer" })).toBeTruthy();
    expect(screen.queryByText("Restore from recovery file")).toBeNull();
    // Main named no computer: the row says the whole sentence, with the same step.
    rerender(<Explorer {...explorerProps({ dataCollections: [], collectionsElsewhere: { computer: null, others: false, words: offline }, onKeepCollections })} />);
    expect(screen.getByTestId("collections-elsewhere").textContent).toBe(`${offline}Use this computer`);
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });
});
