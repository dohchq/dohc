// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo, WorkspaceFileEntry } from "../../ipc/bridgeContract";
import type { ExplorerApps } from "./AppsSection";
import { Explorer, type ExplorerProps } from "./Explorer";
import { OTHER_FILES_SHOWN } from "./explorerHomeModel";
import { collectionTabPath, siteTabPath } from "./workbenchState";

const app = {
  root: "trip",
  title: "Trip",
  kind: "static",
  confidence: "high",
  entryPath: "trip/index.html",
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["trip/index.html"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
} as unknown as SitePackageInfo;

function apps(overrides: Partial<ExplorerApps> = {}): ExplorerApps {
  return {
    state: { status: "ready", workspaceId: "workspace-1", apps: [app] },
    retry: vi.fn(),
    pinnedApps: [],
    onSetPinned: vi.fn(),
    reveal: false,
    onRevealed: vi.fn(),
    ...overrides,
  };
}

const TABLE = "00000000-0000-4000-8000-000000000002";

function file(path: string): WorkspaceFileEntry {
  return { path, kind: "file" };
}

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    mode: "home",
    onModeChange: vi.fn(),
    listed: true,
    files: [
      file("notes.md"),
      file("Plans/Spring.md"),
      file("Plans/Old/Winter.md"),
      file("trip/index.html"),
      file("trip/readme.md"),
      file("guests/dataset.json"),
      file("guests/notes.md"),
      file("tasks/one.md"),
      file("budget.csv"),
      file("photos/tram.png"),
    ],
    folders: ["Plans", "Plans/Old", "trip", "guests", "tasks", "photos", "empty"],
    editorGroups: [{ id: "group-1", tabs: [{ path: "notes.md" }], activeTab: "notes.md", size: 1 }],
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
    collectionFolders: new Set(["tasks"]),
    appFolders: new Set(["trip"]),
    onOpenCollection: vi.fn(),
    apps: apps(),
    dataCollections: [{ datasetId: "d", datasetPath: "guests/dataset.json", tableId: TABLE, name: "Guests" }],
    onOpenDataCollection: vi.fn(),
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

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function rowLabels(name: string): string[] {
  return [...section(name).querySelectorAll<HTMLElement>("[data-home-key]")]
    .filter((element) => element.dataset.testid !== undefined && !element.dataset.homeKey!.startsWith("section:") && !element.dataset.homeKey!.endsWith(":more"))
    .map((element) => element.querySelector(".truncate")?.textContent ?? element.textContent ?? "");
}

const PAGE_PATHS = Array.from({ length: 500 }, (_, index) => `file-${String(index).padStart(4, "0")}.md`);

// Home with 500 pages and 40 of them open in one group.
function largeHome(): Partial<ExplorerProps> {
  return {
    files: PAGE_PATHS.map(file), folders: [], apps: undefined, dataCollections: [], collectionFolders: new Set(),
    editorGroups: [{ id: "group-1", tabs: PAGE_PATHS.slice(0, 40).map((path) => ({ path })), activeTab: PAGE_PATHS[0]!, size: 1 }],
  };
}

function mounted(path: string): boolean {
  return document.querySelector(`[data-home-key="pages:${path}"]`) !== null;
}

function rect(top: number, height: number) {
  return { x: 0, y: top, top, left: 0, right: 280, bottom: top + height, width: 280, height, toJSON: () => ({}) };
}

// Renders Home in a 280 px scroller, 100 rows into Pages less `offset`: how
// far Open editors pushes Pages down.
function scrolledHome(props: ExplorerProps, offset: () => number) {
  const view = render(<Explorer {...props} />);
  const scroller = screen.getByTestId("file-tree");
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 280 });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0, 280));
  vi.spyOn(section("Pages").querySelector("ul")!, "getBoundingClientRect").mockImplementation(() => rect(-2_800 + offset(), 14_000));
  fireEvent.scroll(scroller);
  return view;
}

const showExplorerMenu = vi.fn(async (_input: unknown) => null);

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", { showExplorerMenu });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Explorer Home", () => {
  it("orders its sections Open editors, Pinned, Pages, Collections, Apps, Other files", () => {
    render(<Explorer {...explorerProps({ pinned: ["notes.md"] })} />);

    const sections = [...screen.getByTestId("file-tree").querySelectorAll("section")];
    expect(sections.map((element) => element.getAttribute("aria-label")))
      .toEqual(["Open editors", "Pinned", "Pages", "Collections", "Apps", "Other files"]);
    expect(screen.getByTestId("file-tree").getAttribute("aria-label")).toBe("Home");
  });

  it("shows Files' Open editors, and Tab moves on from it into Home's list", async () => {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({
      onActivateTab,
      onCloseTab,
      editorGroups: [{ id: "group-1", tabs: [{ path: "notes.md" }, { path: "budget.csv" }], activeTab: "notes.md", size: 1 }],
    })} />);

    const openEditors = section("Open editors");
    expect(within(openEditors).getAllByTestId("open-editor-row").map((row) => row.dataset.path)).toEqual(["notes.md", "budget.csv"]);
    expect(within(openEditors).getByRole("separator", { name: "Resize open editors" })).toBeTruthy();
    await user.click(within(openEditors).getByRole("button", { name: "budget.csv" }));
    expect(onActivateTab).toHaveBeenCalledWith("group-1", "budget.csv");
    const close = within(openEditors).getByRole("button", { name: "Close budget.csv" });
    await user.click(close);
    expect(onCloseTab).toHaveBeenCalledWith("group-1", "budget.csv");

    close.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("explorer-pages-toggle"));
  });

  it("leaves Files to Open editors and the folder tree", () => {
    render(<Explorer {...explorerProps({ mode: "files", pinned: ["notes.md"] })} />);

    const sections = [...screen.getByTestId("file-tree").querySelectorAll(":scope > section")];
    expect(sections.map((element) => element.getAttribute("aria-label"))).toEqual(["Open editors", "Files"]);
    expect(screen.queryByTestId("explorer-home")).toBeNull();
  });

  it("draws no Pinned section with nothing in it, and always draws Open editors and Pages with its +", async () => {
    const onNewPage = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({
      files: [], folders: [], apps: undefined, dataCollections: [], collectionFolders: new Set(), onNewPage,
      editorGroups: [{ id: "group-1", tabs: [], activeTab: null, size: 1 }],
    })} />);

    expect(within(section("Open editors")).getByText("No open editors")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Other files" })).toBeNull();
    expect(rowLabels("Pages")).toEqual([]);
    await user.click(within(section("Pages")).getByRole("button", { name: "New page" }));
    expect(onNewPage).toHaveBeenCalledWith("");
  });

  it("waits for the first listing before drawing any section", () => {
    render(<Explorer {...explorerProps({ listed: false })} />);

    expect(screen.queryByRole("region", { name: "Pages" })).toBeNull();
  });

  it("lists pages in their own folders, folders first, titled without .md", () => {
    render(<Explorer {...explorerProps({ expandedFolders: ["Plans"] })} />);

    // An app's files are its source, and a Collection's documents are its
    // records, so neither is a page. A folder with no page does not show.
    expect(rowLabels("Pages")).toEqual(["Plans", "Old", "Spring", "notes"]);
    const plans = within(section("Pages")).getByRole("button", { name: "Plans" });
    expect(plans.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens a page, and folds a folder from its row and from the keyboard", async () => {
    const onOpenFile = vi.fn();
    const onToggleFolder = vi.fn();
    const onSetFolderExpanded = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ onOpenFile, onToggleFolder, onSetFolderExpanded, expandedFolders: ["Plans"] })} />);

    await user.click(within(section("Pages")).getByRole("button", { name: "notes" }));
    expect(onOpenFile).toHaveBeenCalledWith("notes.md");
    const plans = within(section("Pages")).getByRole("button", { name: "Plans" });
    await user.click(plans);
    expect(onToggleFolder).toHaveBeenCalledWith("Plans");
    await user.keyboard("{ArrowLeft}");
    expect(onSetFolderExpanded).toHaveBeenCalledWith("Plans", false);
  });

  it("moves through every section as one list", async () => {
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ onOpenFile, pinned: ["budget.csv"] })} />);

    const pinnedToggle = screen.getByTestId("explorer-pinned-toggle");
    expect(pinnedToggle.tabIndex).toBe(0);
    pinnedToggle.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenLastCalledWith("budget.csv");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("explorer-pages-toggle"));
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("explorer-pages-toggle").getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{End}");
    expect((document.activeElement as HTMLElement).dataset.section).toBe("other");
  });

  it("lists Collections and opens each kind", async () => {
    const onOpenCollection = vi.fn();
    const onOpenDataCollection = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ onOpenCollection, onOpenDataCollection })} />);

    expect(rowLabels("Collections")).toEqual(["Guests", "tasks"]);
    await user.click(within(section("Collections")).getByRole("button", { name: "Guests" }));
    expect(onOpenDataCollection).toHaveBeenCalledWith("guests/dataset.json", TABLE);
    await user.click(within(section("Collections")).getByRole("button", { name: "tasks" }));
    expect(onOpenCollection).toHaveBeenCalledWith("tasks");
  });

  it("selects the app whose tab is the focused tab and opens an app from its row", async () => {
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    const props = explorerProps({ onOpenFile });
    const view = render(<Explorer {...props} />);
    const row = screen.getByTestId("sites-row");
    expect(row.getAttribute("aria-current")).toBeNull();

    await user.click(row);
    expect(onOpenFile).toHaveBeenCalledWith(siteTabPath("trip"));

    const tab = siteTabPath("trip");
    view.rerender(<Explorer {...props} editorGroups={[{ id: "group-1", tabs: [{ path: tab }], activeTab: tab, size: 1 }]} />);
    expect(screen.getByTestId("sites-row").getAttribute("aria-current")).toBe("page");
  });

  it("lists other files by name with their folder, and sends the rest to Files", async () => {
    const onModeChange = vi.fn();
    const user = userEvent.setup();
    const view = render(<Explorer {...explorerProps({ onModeChange })} />);
    expect(rowLabels("Other files")).toEqual(["budget.csv", "tram.png"]);
    expect(within(section("Other files")).getByRole("button", { name: /^tram\.png/ }).textContent).toBe("tram.pngphotos");
    expect(screen.queryByTestId("other-files-show-all")).toBeNull();

    const many = Array.from({ length: OTHER_FILES_SHOWN + 3 }, (_, index) => file(`data/${String(index).padStart(2, "0")}.json`));
    view.rerender(<Explorer {...explorerProps({ onModeChange, files: many, folders: ["data"] })} />);
    expect(rowLabels("Other files")).toHaveLength(OTHER_FILES_SHOWN);
    expect(screen.getByTestId("explorer-other-files-header").textContent).toContain(String(OTHER_FILES_SHOWN + 3));
    await user.click(screen.getByTestId("other-files-show-all"));
    expect(onModeChange).toHaveBeenCalledWith("files");
  });

  it("pins apps first, then everything else pinned, once each", () => {
    render(<Explorer {...explorerProps({
      pinned: ["notes.md", "trip", collectionTabPath("tasks"), "gone.md"],
      apps: apps({ pinnedApps: ["trip"] }),
    })} />);

    expect(rowLabels("Pinned")).toEqual(["Trip", "notes", "tasks"]);
  });

  it("shows the Files menu for a row, with an app folder's sidebar pin", async () => {
    render(<Explorer {...explorerProps({ apps: apps({ pinnedApps: ["trip"] }) })} />);

    fireEvent.contextMenu(within(section("Pages")).getByRole("button", { name: "notes" }));
    expect(showExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "notes.md", kind: "file", pinned: false });
    await userEvent.hover(within(section("Apps")).getByTestId("sites-row"));
    fireEvent.click(within(section("Apps")).getByRole("button", { name: "More actions for Trip" }));
    expect(showExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "trip", kind: "folder", pinned: true });
  });

  it("measures the Pages window again while Open editors above it is resized", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1_000 });
    try {
      scrolledHome(
        explorerProps({ ...largeHome(), openEditorsHeight: 56 }),
        () => Number.parseFloat(screen.getByTestId("open-editors-list").style.maxHeight) - 56,
      );
      expect(mounted("file-0100.md")).toBe(true);
      expect(mounted("file-0080.md")).toBe(false);

      const handle = screen.getByTestId("open-editors-resize");
      Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
      fireEvent.pointerDown(handle, { button: 0, buttons: 1, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, { buttons: 1, clientY: 1_000, pointerId: 1 });

      expect(screen.getByTestId("open-editors-list").style.maxHeight).toBe("600px");
      expect(mounted("file-0080.md")).toBe(true);
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("measures the Pages window again when a tab moves into a new group", () => {
    const props = explorerProps(largeHome());
    // Each group heading pushes Pages down, here by an exaggerated 150 px.
    const view = scrolledHome(props, () => 150 * section("Open editors").querySelectorAll('[role="heading"]').length);
    expect(mounted("file-0080.md")).toBe(false);

    const tabs = props.editorGroups[0]!.tabs;
    view.rerender(<Explorer {...props} editorGroups={[
      { id: "group-1", tabs: tabs.slice(0, 20), activeTab: tabs[0]!.path, size: 1 },
      { id: "group-2", tabs: tabs.slice(20), activeTab: tabs[20]!.path, size: 1 },
    ]} />);

    expect(mounted("file-0080.md")).toBe(true);
  });

  it("switches to Files to reveal a path", () => {
    const onModeChange = vi.fn();
    render(<Explorer {...explorerProps({ onModeChange, revealPaths: ["budget.csv"] })} />);

    expect(onModeChange).toHaveBeenCalledWith("files");
  });
});

describe("selecting several rows in Home", () => {
  const homeRow = (key: string) => {
    const element = document.querySelector<HTMLElement>(`[data-home-key="${key}"]`);
    if (!element) throw new Error(`Missing Home row: ${key}`);
    return element;
  };
  // The fill sits on the row's frame, around its button.
  const tinted = () =>
    [...document.querySelectorAll<HTMLElement>("[data-home-key]")]
      .filter((button) => button.parentElement?.className.includes("bg-selection"))
      .map((button) => button.dataset.homeKey);
  const bar = () => screen.queryByTestId("explorer-selection-bar");

  it("adds rows with Ctrl-click, and a plain click selects one row and opens it", () => {
    const onOpenFile = vi.fn();
    render(<Explorer {...explorerProps({ onOpenFile })} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(tinted()).toEqual(["pages:notes.md", "apps:trip"]);
    // The open page keeps its weight inside the selection.
    expect(homeRow("pages:notes.md").parentElement?.className).toContain("font-medium");
    expect(bar()?.textContent).toBe("2 selected");
    const note = homeRow("apps:trip").getAttribute("aria-describedby");
    expect(note && document.getElementById(note)?.textContent).toBe("Selected");

    fireEvent.click(homeRow("pages:notes.md"));
    expect(onOpenFile).toHaveBeenCalledWith("notes.md");
    expect(tinted()).toEqual([]);
    expect(bar()).toBeNull();
    expect(homeRow("apps:trip").getAttribute("aria-describedby")).toBeNull();
  });

  it("selects a range over Home's rows in order, across sections, and counts a pinned page once", () => {
    render(<Explorer {...explorerProps({ pinned: ["notes.md"] })} />);
    fireEvent.click(homeRow("pinned:notes.md"));
    fireEvent.click(homeRow("collections:tasks/"), { shiftKey: true });
    expect(tinted()).toEqual([
      "pinned:notes.md",
      "pages:Plans/",
      "pages:notes.md",
      `collections:d:${TABLE}`,
      "collections:tasks/",
    ]);
    expect(bar()?.textContent).toBe("4 selected");
  });

  it("extends the selection with Shift and the arrows, past a heading", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    await user.click(homeRow("pages:Plans/"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}");
    expect(document.activeElement).toBe(homeRow(`collections:d:${TABLE}`));
    expect(tinted()).toEqual(["pages:Plans/", "pages:notes.md", `collections:d:${TABLE}`]);
  });

  it("selects every row with a path with Ctrl+A, and Escape clears it", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    homeRow("pages:notes.md").focus();
    await user.keyboard("{Control>}a{/Control}");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-home-key]")].filter((button) => button.dataset.path);
    expect(tinted()).toEqual(rows.map((button) => button.dataset.homeKey));
    expect(bar()?.textContent).toBe(`${new Set(rows.map((button) => button.dataset.path)).size} selected`);
    await user.keyboard("{Escape}");
    expect(tinted()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("asks once to delete the whole selection, with the folders of apps and Collections", () => {
    render(<Explorer {...explorerProps()} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("collections:tasks/"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    fireEvent.keyDown(homeRow("apps:trip"), { key: "Delete" });
    const dialog = screen.getByTestId("delete-confirm");
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete 3 items?");
    expect([...dialog.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["notes.md", "tasks", "trip"]);
  });

  it("drags every selected row from one selected page", () => {
    render(<Explorer {...explorerProps()} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("pages:Plans/"), { ctrlKey: true });
    const setData = vi.fn();
    fireEvent.dragStart(homeRow("pages:notes.md"), { dataTransfer: { effectAllowed: "none", setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "notes.md\nPlans");
  });

  it("sends a selected row's menu the selection's count, and a row outside it its own menu", () => {
    render(<Explorer {...explorerProps()} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("other:budget.csv"), { ctrlKey: true });
    fireEvent.contextMenu(homeRow("other:budget.csv"));
    expect(showExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "budget.csv", kind: "file", pinned: false, count: 2 });
    fireEvent.contextMenu(homeRow("pages:Plans/"));
    expect(showExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "Plans", kind: "folder", pinned: false });
    expect(bar()).toBeNull();
  });
});
