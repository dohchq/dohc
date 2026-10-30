// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import type { ExplorerApps } from "./AppsSection";
import { Explorer, type ExplorerProps } from "./Explorer";
import { siteTabPath } from "./workbenchState";

afterEach(cleanup);

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

function explorerProps(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    workspaceId: "workspace-1",
    files: [{ path: "notes.md", kind: "file" }, { path: "trip/index.html", kind: "file" }],
    folders: ["trip"],
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
    collectionFolders: new Set(),
    onOpenCollection: vi.fn(),
    apps: apps(),
    dataCollections: [{ datasetId: "d", datasetPath: "data/dataset.json", tableId: "t", name: "Guests" }],
    onPathsChanged: vi.fn(),
    onImportFiles: vi.fn(),
    onRefreshShareMounts: vi.fn(),
    onUnmountShare: vi.fn(),
    onShare: vi.fn(),
    onRefresh: vi.fn(),
    onError: vi.fn(),
    onNewCollection: vi.fn(),
    ...overrides,
  } as ExplorerProps;
}

describe("Explorer Apps section", () => {
  it("orders the sections Open editors, Apps, Collections, Files", () => {
    render(<Explorer {...explorerProps()} />);

    const sections = [...screen.getByTestId("file-tree").querySelectorAll(":scope > section")];
    expect(sections.map((section) => section.getAttribute("aria-label")))
      .toEqual(["Open editors", "Apps", "Collections", "Files"]);
    // Space separates them; no section draws a rule.
    expect(sections.every((section) => !section.className.includes("border-b"))).toBe(true);
  });

  it("has no Apps section while the workspace has no apps", () => {
    render(<Explorer {...explorerProps({
      apps: apps({ state: { status: "ready", workspaceId: "workspace-1", apps: [] } }),
    })} />);

    expect(screen.queryByTestId("explorer-apps-section")).toBeNull();
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

  it("leaves Enter on an app row to the row once a tree row was focused", async () => {
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(<Explorer {...explorerProps({ onOpenFile })} />);
    const treeRow = screen.getAllByTestId("tree-row").find((row) => row.dataset.path === "notes.md")!;
    treeRow.focus();

    screen.getByTestId("sites-row").focus();
    await user.keyboard("{Enter}");

    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(siteTabPath("trip"));
  });
});
