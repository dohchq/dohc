// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerMenuEntry, SitePackageInfo, WorkspaceFileEntry } from "../../ipc/bridgeContract";
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
    listingRequest: 0,
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
    onRefresh: vi.fn(() => 1),
    onError: vi.fn(),
    onNotice: vi.fn(),
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

const RENAME: ExplorerMenuEntry = { kind: "item", label: "Rename", id: "rename" };
const DELETE: ExplorerMenuEntry = { kind: "item", label: "Delete", id: "delete" };

const bridge = {
  readExplorerMenu: vi.fn(async (_input: unknown): Promise<ExplorerMenuEntry[]> => [RENAME, DELETE]),
  deleteWorkspacePath: vi.fn(async (_input: { workspaceId: string; relativePath: string }) => ({
    trashed: true,
    operationId: "dohc-operation:22222222-2222-4222-8222-222222222222",
    undo: { available: true as const },
  })),
};

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Explorer Files", () => {
  it("shows nothing below the Files header before the first listing", () => {
    render(<Explorer {...explorerProps({ mode: "files", listed: false, files: [], folders: [] })} />);

    expect(screen.queryByText("No files yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create your first file" })).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it('shows "No files yet." after an empty listing', () => {
    render(<Explorer {...explorerProps({ mode: "files", files: [], folders: [], editorGroups: [] })} />);

    // An empty-state line says something, so it reads in muted, not subtle.
    for (const line of [within(section("Files")).getByText("No files yet."), screen.getByText("No files open.")]) {
      expect(line.className).toContain("text-muted");
      expect(line.className).not.toContain("text-subtle");
    }
    expect(screen.queryByRole("button", { name: "Create your first file" })).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("shows the tree after a listing with a file", () => {
    render(<Explorer {...explorerProps({ mode: "files", files: [file("notes.md")], folders: [] })} />);

    expect(within(screen.getByRole("tree")).getByRole("treeitem", { name: "notes.md" })).toBeTruthy();
    expect(screen.queryByText("No files yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create your first file" })).toBeNull();
  });

  it('swaps "No files yet." for the new folder row in an empty workspace', async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ mode: "files", files: [], folders: [] })} />);

    await user.click(within(section("Files")).getByRole("button", { name: "New folder" }));

    expect((await screen.findByTestId("tree-edit-input")).getAttribute("aria-label")).toBe("New folder name");
    expect(screen.queryByText("No files yet.")).toBeNull();
  });
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
    // A page shows its title, as Pages does, and another file its name.
    expect(within(openEditors).getByRole("button", { name: "notes" }).title).toBe("notes.md");
    expect(within(openEditors).getByRole("button", { name: "Close notes" })).toBeTruthy();
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
    // Files names an open page by its file name, as its tree does.
    expect(within(section("Open editors")).getByRole("button", { name: "notes.md" })).toBeTruthy();
  });

  it("draws no Pinned section with nothing in it, and always draws Open editors and Pages with its +", async () => {
    const onNewPage = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({
      files: [], folders: [], apps: undefined, dataCollections: [], collectionFolders: new Set(), onNewPage,
      editorGroups: [{ id: "group-1", tabs: [], activeTab: null, size: 1 }],
    })} />);

    // Its line is the toggle's description, as Pages' line is.
    const empty = within(section("Open editors")).getByText("No files open.");
    expect(screen.getByTestId("open-editors-toggle").getAttribute("aria-describedby")).toBe(empty.id);
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Other files" })).toBeNull();
    expect(rowLabels("Pages")).toEqual([]);
    await user.click(within(section("Pages")).getByRole("button", { name: "New page" }));
    expect(onNewPage).toHaveBeenCalledWith("");
  });

  it("says when Pages, Collections or Apps has nothing, in a line the arrows pass over", async () => {
    const user = userEvent.setup();
    render(
      <Explorer
        {...explorerProps({
          files: [],
          folders: [],
          dataCollections: [],
          collectionFolders: new Set(),
          appFolders: new Set(),
          apps: apps({ state: { status: "ready", workspaceId: "workspace-1", apps: [] } }),
          onIncludeArchivedCollections: vi.fn(),
        })}
      />,
    );

    const lines = {
      pages: "No pages yet.",
      collections: "No Collections yet.",
      apps: "No apps yet. Any folder with a web app in it shows up here.",
    };
    for (const [id, words] of Object.entries(lines)) {
      const line = screen.getByTestId(`explorer-${id}-empty`);
      expect(line.textContent).toBe(words);
      // The header's toggle reads the line, since focus never lands on it.
      expect(screen.getByTestId(`explorer-${id}-toggle`).getAttribute("aria-describedby")).toBe(line.id);
    }
    expect(screen.queryByTestId("sites-count")).toBeNull();

    screen.getByTestId("explorer-pages-toggle").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("explorer-collections-toggle"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("explorer-apps-toggle"));

    // A folded section shows no line, and its toggle no longer points at one.
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByTestId("explorer-apps-empty")).toBeNull();
    expect(screen.getByTestId("explorer-apps-toggle").hasAttribute("aria-describedby")).toBe(false);
  });

  it("holds Apps' place while its first read runs, and says nothing yet", () => {
    render(<Explorer {...explorerProps({ apps: apps({ state: { status: "loading" } }) })} />);

    expect(section("Apps")).toBeTruthy();
    expect(screen.queryByTestId("explorer-apps-empty")).toBeNull();
    expect(screen.queryByTestId("sites-row")).toBeNull();
  });

  it("shows an empty Apps section in a workspace of your own, and none in a share view", () => {
    const empty = apps({ state: { status: "ready", workspaceId: "workspace-1", apps: [] } });
    const view = render(<Explorer {...explorerProps({ apps: empty })} />);
    expect(screen.getByTestId("explorer-apps-empty")).toBeTruthy();

    view.rerender(<Explorer {...explorerProps({ apps: empty, shareView: { granterEmail: "sam@example.com" } })} />);
    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();

    view.rerender(<Explorer {...explorerProps({ shareView: { granterEmail: "sam@example.com" } })} />);
    expect(rowLabels("Apps")).toEqual(["Trip"]);

    // A share that holds only an app shows no Pages either.
    view.rerender(<Explorer {...explorerProps({ files: [file("trip/index.html")], folders: ["trip"], dataCollections: [], collectionFolders: new Set(),
      shareView: { granterEmail: "sam@example.com" } })} />);
    expect(rowLabels("Apps")).toEqual(["Trip"]);
    expect(screen.queryByRole("region", { name: "Pages" })).toBeNull();
    expect(screen.queryByTestId("explorer-pages-empty")).toBeNull();
  });

  // Show archived Collections clears the list and reads it again. Until that
  // read lands, the list is not known to be empty.
  it("holds Collections' place while its list is read again, and says nothing yet", () => {
    render(<Explorer {...explorerProps({ dataCollections: [], collectionFolders: new Set(), onIncludeArchivedCollections: vi.fn(),
      includeArchivedCollections: true, collectionsUnknown: "reading" })} />);

    expect(section("Collections")).toBeTruthy();
    expect(screen.queryByTestId("explorer-collections-empty")).toBeNull();
    expect(screen.queryByTestId("collections-failed")).toBeNull();
    expect(screen.getByTestId("explorer-collections-toggle").hasAttribute("aria-describedby")).toBe(false);
  });

  it("leaves Try again in Collections' place when that read fails, and still says nothing", () => {
    const onRetryCollections = vi.fn();
    render(<Explorer {...explorerProps({ dataCollections: [], collectionFolders: new Set(), onIncludeArchivedCollections: vi.fn(),
      includeArchivedCollections: true, collectionsUnknown: "failed", onRetryCollections })} />);

    expect(screen.queryByTestId("explorer-collections-empty")).toBeNull();
    fireEvent.click(within(screen.getByTestId("collections-failed")).getByRole("button", { name: "Try again" }));
    expect(onRetryCollections).toHaveBeenCalledOnce();
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
    expect(bridge.readExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "notes.md", kind: "file", pinned: false });
    await screen.findByRole("menu", { name: "notes.md" });
    await userEvent.hover(within(section("Apps")).getByTestId("sites-row"));
    fireEvent.click(within(section("Apps")).getByRole("button", { name: "More actions for Trip" }));
    expect(bridge.readExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "trip", kind: "folder", pinned: true });
    await screen.findByRole("menu", { name: "trip" });
  });

  it("opens a row's menu under it from the Menu key, once, and gives focus back on Escape", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    const target = within(section("Pages")).getByRole("button", { name: "notes" });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 100, 200, 28));
    target.focus();
    fireEvent.keyDown(target, { key: "ContextMenu" });
    const menu = await screen.findByRole("menu", { name: "notes.md" });
    expect(menu.style.top).toBe("128px");
    expect(bridge.readExplorerMenu).toHaveBeenCalledWith({ workspaceId: "workspace-1", path: "notes.md", kind: "file", pinned: false });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    // The browser's own contextmenu event for the key opens no second menu.
    fireEvent.contextMenu(target);
    await act(async () => {});
    expect(bridge.readExplorerMenu).toHaveBeenCalledOnce();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(target));
  });

  it("deletes from a row's menu without asking, with Undo on its notice", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.contextMenu(within(section("Pages")).getByRole("button", { name: "notes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "workspace-1", relativePath: "notes.md" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Deleted notes.md. It's in the system trash.", expect.any(Function)));
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
  const picked = () =>
    [...document.querySelectorAll<HTMLElement>("[data-home-key]")]
      .filter((button) => button.parentElement?.className.includes("bg-(--dohc-selection)"))
      .map((button) => button.dataset.homeKey);
  const edged = () =>
    [...document.querySelectorAll<HTMLElement>("[data-testid='home-row-open-edge']")].map(
      (edge) => edge.parentElement?.querySelector<HTMLElement>("[data-home-key]")?.dataset.homeKey,
    );
  const bar = () => screen.queryByTestId("explorer-selection-bar");

  it("adds rows with Ctrl-click, and a plain click selects one row and opens it", () => {
    const onOpenFile = vi.fn();
    render(<Explorer {...explorerProps({ onOpenFile })} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(picked()).toEqual(["pages:notes.md", "apps:trip"]);
    // The open page keeps its weight inside the selection and gains the edge.
    expect(homeRow("pages:notes.md").parentElement?.className).toContain("font-medium");
    expect(edged()).toEqual(["pages:notes.md"]);
    expect(bar()?.textContent).toBe("2 selected");
    const note = homeRow("apps:trip").getAttribute("aria-describedby");
    expect(note && document.getElementById(note)?.textContent).toBe("Selected");

    fireEvent.click(homeRow("pages:notes.md"));
    expect(onOpenFile).toHaveBeenCalledWith("notes.md");
    expect(picked()).toEqual([]);
    expect(edged()).toEqual([]);
    expect(homeRow("pages:notes.md").parentElement?.className).toContain("bg-selected font-medium");
    expect(bar()).toBeNull();
    expect(homeRow("apps:trip").getAttribute("aria-describedby")).toBeNull();
  });

  it("selects a range over Home's rows in order, across sections, and counts a pinned page once", () => {
    render(<Explorer {...explorerProps({ pinned: ["notes.md"] })} />);
    fireEvent.click(homeRow("pinned:notes.md"));
    fireEvent.click(homeRow("collections:tasks/"), { shiftKey: true });
    expect(picked()).toEqual([
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
    // A folder clicked alone is not the open row, so it is picked.
    expect(picked()).toEqual(["pages:Plans/"]);
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}");
    expect(document.activeElement).toBe(homeRow(`collections:d:${TABLE}`));
    expect(picked()).toEqual(["pages:Plans/", "pages:notes.md", `collections:d:${TABLE}`]);
  });

  it("selects every row with a path with Ctrl+A, and Escape clears it", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    homeRow("pages:notes.md").focus();
    await user.keyboard("{Control>}a{/Control}");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-home-key]")].filter((button) => button.dataset.path);
    expect(picked()).toEqual(rows.map((button) => button.dataset.homeKey));
    expect(bar()?.textContent).toBe(`${new Set(rows.map((button) => button.dataset.path)).size} selected`);
    await user.keyboard("{Escape}");
    expect(picked()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("shows an app opened from its row as the open row, and clears it when another editor becomes active", () => {
    const props = explorerProps();
    const view = render(<Explorer {...props} />);
    fireEvent.click(homeRow("apps:trip"));
    const tab = siteTabPath("trip");
    view.rerender(<Explorer {...props} editorGroups={[{ id: "group-1", tabs: [{ path: tab }], activeTab: tab, size: 1 }]} />);
    expect(picked()).toEqual([]);
    expect(homeRow("apps:trip").parentElement?.className).toContain("bg-selected font-medium");

    view.rerender(<Explorer {...props} />);
    // The selection held only the app, so it goes with the app's tab.
    expect(picked()).toEqual([]);
    expect(homeRow("apps:trip").parentElement?.className).not.toContain("font-medium");
  });

  // A delete goes to the trash, so the whole selection goes at once and one
  // Undo brings every row back.
  it("deletes the whole selection without asking, with the folders of apps and Collections, under one Undo", async () => {
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
      trashed: true, operationId: `dohc-operation:${relativePath}`, undo: { available: true as const },
    }));
    const undoHistoryOperation = vi.fn(async (_input: { operationId: string }) => ({
      ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [],
    }));
    vi.stubGlobal("dohcDesktop", { ...bridge, deleteWorkspacePath, undoHistoryOperation });
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("collections:tasks/"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    fireEvent.keyDown(homeRow("apps:trip"), { key: "Delete" });
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Deleted 3 items. They're in the system trash.", expect.any(Function)));
    expect(props.onNotice).toHaveBeenCalledOnce();
    expect(deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath)).toEqual(["notes.md", "tasks", "trip"]);

    act(() => vi.mocked(props.onNotice).mock.calls[0]![1]!());
    await waitFor(() => expect(props.onNotice).toHaveBeenLastCalledWith("Restored 3 items"));
    expect(undoHistoryOperation.mock.calls.map(([input]) => input.operationId)).toEqual(
      ["notes.md", "tasks", "trip"].map((path) => `dohc-operation:${path}`),
    );
  });

  // Once the notice is gone, the trash is the way back, so the notice says
  // which trash took each row, as main answered.
  it("says where each row of the selection went", async () => {
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
      trashed: relativePath !== "tasks", operationId: `dohc-operation:${relativePath}`, undo: { available: true as const },
    }));
    vi.stubGlobal("dohcDesktop", { ...bridge, deleteWorkspacePath });
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("collections:tasks/"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    fireEvent.keyDown(homeRow("apps:trip"), { key: "Delete" });
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(
      "Deleted 3 items. 2 are in the system trash, and 1 is in .dohc/local/trash in this workspace.",
      expect.any(Function),
    ));
  });

  it("names the row that did not go when the rest of the selection went, under one Undo for the rest", async () => {
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "tasks") throw new Error("Error invoking remote method 'desktop:delete-workspace-path': Error: The disk is full.");
      return { trashed: true, operationId: `dohc-operation:${relativePath}`, undo: { available: true as const } };
    });
    const undoHistoryOperation = vi.fn(async (_input: { operationId: string }) => ({
      ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [],
    }));
    vi.stubGlobal("dohcDesktop", { ...bridge, deleteWorkspacePath, undoHistoryOperation });
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("collections:tasks/"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    fireEvent.keyDown(homeRow("apps:trip"), { key: "Delete" });

    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Deleted 2 items. They're in the system trash.", expect.any(Function)));
    expect(props.onError).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onError).mock.calls[0]![0]).toMatch(/^dohc could not delete "tasks"\. \S/);

    act(() => vi.mocked(props.onNotice).mock.calls[0]![1]!());
    await waitFor(() => expect(props.onNotice).toHaveBeenLastCalledWith("Restored 2 items"));
    expect(undoHistoryOperation.mock.calls.map(([input]) => input.operationId)).toEqual(
      ["notes.md", "trip"].map((path) => `dohc-operation:${path}`),
    );
  });

  // A share view's delete has no trash, so it asks first, once.
  it("asks once in a share view to delete the whole selection, with the folders of apps and Collections", () => {
    render(<Explorer {...explorerProps({ shareView: { granterEmail: "sam@example.com" } })} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("collections:tasks/"), { ctrlKey: true });
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    fireEvent.keyDown(homeRow("apps:trip"), { key: "Delete" });
    const dialog = screen.getByTestId("delete-confirm");
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete 3 items?");
    expect([...dialog.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["notes.md", "tasks", "trip"]);
    expect(bridge.deleteWorkspacePath).not.toHaveBeenCalled();
  });

  it("deletes the selection from a heading, and the focused row alone when it is outside the selection", async () => {
    const user = userEvent.setup();
    render(<Explorer {...explorerProps()} />);
    const deleted = () => bridge.deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath);
    await user.click(homeRow("pages:Plans/"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    act(() => document.querySelector<HTMLElement>('[data-home-key^="section:"]')!.focus());
    await user.keyboard("{Delete}");
    await waitFor(() => expect(deleted()).toEqual(["Plans", "notes.md"]));

    // The delete cleared the selection, and its rows wait for a listing.
    fireEvent.click(homeRow("apps:trip"), { ctrlKey: true });
    fireEvent.click(homeRow("collections:tasks/"), { ctrlKey: true });
    act(() => homeRow("other:budget.csv").focus());
    fireEvent.keyDown(homeRow("other:budget.csv"), { key: "Delete" });
    await waitFor(() => expect(deleted()).toEqual(["Plans", "notes.md", "budget.csv"]));
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
  });

  it("drags every selected row from one selected page", () => {
    render(<Explorer {...explorerProps()} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("pages:Plans/"), { ctrlKey: true });
    const setData = vi.fn();
    fireEvent.dragStart(homeRow("pages:notes.md"), { dataTransfer: { effectAllowed: "none", setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "notes.md\nPlans");
  });

  it("leaves a selected folder's contents out of the delete, since the folder carries them", async () => {
    const onPathsChanged = vi.fn();
    const user = userEvent.setup();
    const props = explorerProps({ expandedFolders: ["Plans"], onPathsChanged });
    render(<Explorer {...props} />);
    homeRow("pages:notes.md").focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(picked()).toEqual(expect.arrayContaining(["pages:Plans/", "pages:Plans/Old/", "pages:Plans/Spring.md"]));
    await user.keyboard("{Delete}");

    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    await waitFor(() => expect(onPathsChanged).toHaveBeenCalled());
    const deleted = bridge.deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath);
    expect(deleted).toContain("Plans");
    expect(deleted.filter((path) => path.startsWith("Plans/"))).toEqual([]);
    // The notice counts what the delete took, not every selected row.
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(`Deleted ${deleted.length} items. They're in the system trash.`, expect.any(Function)));
  });

  it("drags a selected folder without its selected contents", () => {
    render(<Explorer {...explorerProps({ expandedFolders: ["Plans"] })} />);
    fireEvent.click(homeRow("pages:Plans/"), { ctrlKey: true });
    fireEvent.click(homeRow("pages:Plans/Spring.md"), { ctrlKey: true });
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    const setData = vi.fn();
    fireEvent.dragStart(homeRow("pages:Plans/Spring.md"), { dataTransfer: { effectAllowed: "none", setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "Plans\nnotes.md");
  });

  it("sends a selected row's menu the selection's count, and a row outside it its own menu", async () => {
    render(<Explorer {...explorerProps()} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("other:budget.csv"), { ctrlKey: true });
    fireEvent.contextMenu(homeRow("other:budget.csv"));
    expect(bridge.readExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "budget.csv", kind: "file", pinned: false, count: 2 });
    fireEvent.contextMenu(homeRow("pages:Plans/"));
    expect(bridge.readExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "Plans", kind: "folder", pinned: false });
    await screen.findByRole("menu", { name: "Plans" });
    expect(bar()).toBeNull();
  });

  it("deletes the selection from a selected row's menu without asking", async () => {
    const user = userEvent.setup();
    const props = explorerProps();
    render(<Explorer {...props} />);
    fireEvent.click(homeRow("pages:notes.md"), { ctrlKey: true });
    fireEvent.click(homeRow("other:budget.csv"), { ctrlKey: true });
    fireEvent.contextMenu(homeRow("other:budget.csv"));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.queryByTestId("delete-confirm")).toBeNull();
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Deleted 2 items. They're in the system trash.", expect.any(Function)));
    expect(bridge.deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath)).toEqual(["notes.md", "budget.csv"]);
  });
});
