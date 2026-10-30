// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo, WorkspaceFileEntry } from "../../ipc/bridgeContract";
import type { ExplorerApps } from "./AppsSection";
import { Explorer, type ExplorerProps } from "./Explorer";
import { OTHER_FILES_SHOWN, RECENT_SHOWN } from "./explorerHomeModel";
import { collectionTabPath, siteTabPath, transactionalCollectionTabPath } from "./workbenchState";

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
    recentFiles: [],
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
  it("orders its sections Pinned, Recent, Pages, Collections, Apps, Other files", () => {
    render(<Explorer {...explorerProps({ pinned: ["notes.md"], recentFiles: ["budget.csv"] })} />);

    const sections = [...screen.getByTestId("explorer-home").querySelectorAll(":scope > section")];
    expect(sections.map((element) => element.getAttribute("aria-label")))
      .toEqual(["Pinned", "Recent", "Pages", "Collections", "Apps", "Other files"]);
    expect(screen.getByTestId("file-tree").getAttribute("aria-label")).toBe("Home");
  });

  it("leaves Files to Open editors and the folder tree", () => {
    render(<Explorer {...explorerProps({ mode: "files", pinned: ["notes.md"] })} />);

    const sections = [...screen.getByTestId("file-tree").querySelectorAll(":scope > section")];
    expect(sections.map((element) => element.getAttribute("aria-label"))).toEqual(["Open editors", "Files"]);
    expect(screen.queryByTestId("explorer-home")).toBeNull();
  });

  it("draws no Pinned or Recent section with nothing in it, and always draws Pages with its +", async () => {
    const onNewPage = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ files: [], folders: [], apps: undefined, dataCollections: [], collectionFolders: new Set(), onNewPage })} />);

    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
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
    render(<Explorer {...explorerProps({ onOpenFile, recentFiles: ["budget.csv"] })} />);

    const recentToggle = screen.getByTestId("explorer-recent-toggle");
    expect(recentToggle.tabIndex).toBe(0);
    recentToggle.focus();
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

  it("shows the five most recent things that still exist, across kinds", () => {
    render(<Explorer {...explorerProps({
      recentFiles: [
        "gone.md",
        siteTabPath("trip"),
        transactionalCollectionTabPath("guests/dataset.json", TABLE),
        "budget.csv",
        "Plans/Spring.md",
        collectionTabPath("tasks"),
        "notes.md",
      ],
    })} />);

    expect(rowLabels("Recent")).toEqual(["Trip", "Guests", "budget.csv", "Spring", "tasks"]);
    expect(rowLabels("Recent")).toHaveLength(RECENT_SHOWN);
  });

  it("shows the Files menu for a row, with an app folder's sidebar pin", async () => {
    render(<Explorer {...explorerProps({ apps: apps({ pinnedApps: ["trip"] }) })} />);

    fireEvent.contextMenu(within(section("Pages")).getByRole("button", { name: "notes" }));
    expect(showExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "notes.md", kind: "file", pinned: false });
    fireEvent.click(within(section("Apps")).getByRole("button", { name: "More actions for Trip" }));
    expect(showExplorerMenu).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", path: "trip", kind: "folder", pinned: true });
  });

  it("switches to Files to reveal a path", () => {
    const onModeChange = vi.fn();
    render(<Explorer {...explorerProps({ onModeChange, revealPaths: ["budget.csv"] })} />);

    expect(onModeChange).toHaveBeenCalledWith("files");
  });
});
