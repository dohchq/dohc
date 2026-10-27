// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { editorTabTestId } from "../testPins";
import type { ExplorerProps } from "./workbench/Explorer";
import {
  CHATS_TAB_PATH,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  chatTabPath,
  collectionTabPath,
  momentDiffTabPath,
  siteTabPath,
  transactionalCollectionTabPath,
  versionCompareTabPath,
} from "./workbench/workbenchState";
import { makeBridge, renderShell, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";

const requested = vi.hoisted(() => ({ path: "", seedInvalidApp: false, left: [] as string[] }));
vi.mock("./workbench/workbenchState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workbench/workbenchState")>();
  return {
    ...actual,
    parseUiState: (...args: Parameters<typeof actual.parseUiState>) => {
      const state = actual.parseUiState(...args);
      if (!requested.seedInvalidApp) return state;
      // Main rejects this singleton during open and restore. Seed invalid
      // renderer state only to exercise its defensive shell fallback.
      return {
        ...state,
        editorGroups: state.editorGroups.map(group => group.id === state.activeEditorGroup
          ? { ...group, tabs: [{ path: "tab://app/" }], activeTab: "tab://app/" }
          : group),
      };
    },
  };
});
vi.mock("./workbench/Explorer", () => ({
  Explorer: (props: Pick<ExplorerProps, "onOpenFile">) => (
    <button onClick={() => props.onOpenFile(requested.path)}>Open test tab</button>
  ),
}));
// Keep the shell, its navigation callbacks and its authority gates real.
// Leaf markers identify which component the switch actually mounts.
vi.mock("./FileInspector", () => ({
  FileInspector: (props: { path: string }) => (
    <div data-testid="file-inspector" data-path={props.path}>
      <input aria-label={`Field in ${props.path}`} onBlur={() => requested.left.push(props.path)} />
    </div>
  ),
}));
vi.mock("./workbench/GraphView", () => ({
  GraphView: () => <div data-testid="graph-view" />,
}));
vi.mock("./workbench/ChatsView", () => ({
  ChatsView: (props: { editorTabPath?: string }) => <div data-testid="chats-view" data-path={props.editorTabPath} />,
}));
vi.mock("./workbench/WorkspaceVersions", async (importOriginal) => ({
  ...await importOriginal<typeof import("./workbench/WorkspaceVersions")>(),
  VersionComparePage: (props: { versionId: string }) => <div data-testid="version-compare-page" data-version={props.versionId} />,
}));
vi.mock("./workbench/EngineMomentDiffPage", () => ({
  EngineMomentDiffPage: (props: { tabPath: string }) => <div data-testid="engine-moment-diff-page" data-path={props.tabPath} />,
}));
vi.mock("./SitePreviewPage", () => ({
  SitePreviewPage: (props: { siteRoot: string }) => <div data-testid="site-preview-page" data-root={props.siteRoot} />,
}));
vi.mock("./CollectionPage", () => ({
  CollectionPage: (props: { collectionPath: string }) => <div data-testid="collection-page" data-path={props.collectionPath} />,
}));
vi.mock("./ConnectedTransactionalCollection", () => ({
  ConnectedTransactionalCollection: (props: { datasetPath: string; tableId: string }) => (
    <div data-testid="transactional-collection-page" data-path={props.datasetPath} data-table={props.tableId} />
  ),
}));

const tableId = "00000000-0000-4000-8000-000000000002";
const cases = [
  { name: "file", path: "notes.txt", surface: "file-inspector", attributes: { "data-path": "notes.txt" } },
  { name: "graph", path: GRAPH_TAB_PATH, surface: "graph-view" },
  { name: "history", path: HISTORY_TAB_PATH, surface: "history-page" },
  ...[
    CHATS_TAB_PATH,
    chatTabPath({ kind: "new" }),
    chatTabPath({ kind: "channel", id: "team/one" }),
    chatTabPath({ kind: "dm", id: "person one" }),
  ].map(path => ({ name: `chats ${path}`, path, surface: "chats-view", attributes: { "data-path": path } })),
  ...["main", "try/one"].map(version => ({
    name: `versions compare ${version}`, path: versionCompareTabPath(version), surface: "version-compare-page", attributes: { "data-version": version },
  })),
  { name: "moment diff", path: momentDiffTabPath("moment one"), surface: "engine-moment-diff-page", attributes: { "data-path": momentDiffTabPath("moment one") } },
  ...["apps/trip", "sites/acme"].map(root => ({
    name: `app/site ${root}`, path: siteTabPath(root), surface: "site-preview-page", attributes: { "data-root": root },
  })),
  { name: "document Collection", path: collectionTabPath("notes/旅"), surface: "collection-page", attributes: { "data-path": "notes/旅" } },
  { name: "data Collection", path: transactionalCollectionTabPath("data/dataset.json", tableId), surface: "transactional-collection-page", attributes: { "data-path": "data/dataset.json", "data-table": tableId } },
  ...[
    "tab://chats/dm/",
    transactionalCollectionTabPath("../dataset.json", tableId),
    transactionalCollectionTabPath("data/dataset.json", "bad-table-id"),
    "tab://unknown",
  ].map(path => ({ name: `removed ${path}`, path, surface: "file-inspector", attributes: { "data-path": path } })),
];

describe("shell tab surfaces", () => {
  it.each(cases)("opens $name on its own surface", async ({ path, surface, attributes }) => {
    renderShell(makeBridge(Promise.resolve(storedStateWithTabs([]))));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    requested.path = path;
    fireEvent.click(screen.getByRole("button", { name: "Open test tab" }));
    const pane = within(screen.getByTestId("editor-group-primary"));
    const view = await pane.findByTestId(surface);
    for (const [key, value] of Object.entries(attributes ?? {})) expect(view.getAttribute(key)).toBe(value);
    for (const other of new Set(cases.map(test => test.surface))) {
      if (other !== surface) expect(pane.queryByTestId(other)).toBeNull();
    }
  });

  it.each([
    { path: "tab://app/", fallback: "closed app" },
    { path: "tab://collection/%ZZ", fallback: "collection error" },
    { path: "tab://versions/compare/", fallback: "compare Main" },
  ])("keeps main's $fallback behavior for $path", async ({ path, fallback }) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      requested.seedInvalidApp = fallback === "closed app";
      renderShell(makeBridge(Promise.resolve(storedStateWithTabs([]))));
      await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
      if (!requested.seedInvalidApp) {
        requested.path = path;
        fireEvent.click(screen.getByRole("button", { name: "Open test tab" }));
      }
      const pane = within(screen.getByTestId("editor-group-primary"));
      if (fallback === "closed app") {
        await waitFor(() => expect(error).toHaveBeenCalledWith("[desktop] invalid site tab path", {
          activeTab: path,
          detail: "active tab matched site tab format but groupSiteRoot parsed to null",
        }));
        expect(await pane.findByTestId("start-surface")).toBeTruthy();
        expect(pane.queryByTestId(editorTabTestId(path))).toBeNull();
      } else if (fallback === "collection error") {
        expect(await pane.findByText("dohc could not open this collection")).toBeTruthy();
        expect(pane.getByRole("button", { name: "Close tab" })).toBeTruthy();
        expect(pane.getByTestId(editorTabTestId(path))).toBeTruthy();
      } else {
        const view = await pane.findByTestId("version-compare-page");
        expect(view.getAttribute("data-version")).toBe("main");
        expect(pane.getByTestId(editorTabTestId(path))).toBeTruthy();
      }
      expect(pane.queryByTestId("site-preview-page")).toBeNull();
      expect(pane.queryByTestId("collection-page")).toBeNull();
      expect(pane.queryByTestId("file-inspector")).toBeNull();
    } finally {
      requested.seedInvalidApp = false;
      error.mockRestore();
    }
  });

  it("keeps the empty editor state when no tab is open", async () => {
    renderShell(makeBridge(Promise.resolve(storedStateWithTabs([]))));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const pane = within(screen.getByTestId("editor-group-primary"));
    expect(pane.getByTestId("start-surface")).toBeTruthy();
    expect(pane.queryByTestId("file-inspector")).toBeNull();
  });

  it.each([
    ["darwin", { key: "}", code: "BracketRight", metaKey: true, shiftKey: true }],
    ["win32", { key: "PageDown", ctrlKey: true }],
  ] as const)("cycles the focused group's tabs on %s, and leaves a claimed chord alone", async (platform, alternate) => {
    const tabs = ["a.txt", "b.txt", "c.txt"];
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(tabs)), platform);
    bridge.listWorkspaceFiles.mockResolvedValue({
      visibility: { status: "ready", rules: [] },
      files: tabs.map((path) => ({ path, kind: "file" as const })),
      folders: [],
    });
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const pane = within(screen.getByTestId("editor-group-primary"));
    const active = () => pane.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.testid;
    expect(active()).toBe(editorTabTestId("a.txt"));

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    await waitFor(() => expect(active()).toBe(editorTabTestId("b.txt")));
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(active()).toBe(editorTabTestId("a.txt")));
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(active()).toBe(editorTabTestId("c.txt")));
    fireEvent.keyDown(window, alternate);
    await waitFor(() => expect(active()).toBe(editorTabTestId("a.txt")));
    act(() => bridge.emitMenuCommand("previous-tab"));
    await waitFor(() => expect(active()).toBe(editorTabTestId("c.txt")));

    // A control that gives ⌃Tab its own meaning claims it first.
    const field = document.createElement("input");
    document.body.append(field);
    field.addEventListener("keydown", (event) => event.preventDefault());
    fireEvent.keyDown(field, { key: "Tab", ctrlKey: true });
    field.remove();
    act(() => bridge.emitMenuCommand("next-tab"));
    await waitFor(() => expect(active()).toBe(editorTabTestId("a.txt")));
  });

  it("leaves a field in the open file before a shortcut switches or closes its tab, as a click does", async () => {
    const tabs = ["a.txt", "b.txt"];
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(tabs)));
    bridge.listWorkspaceFiles.mockResolvedValue({
      visibility: { status: "ready", rules: [] },
      files: tabs.map((path) => ({ path, kind: "file" as const })),
      folders: [],
    });
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const pane = within(screen.getByTestId("editor-group-primary"));
    requested.left = [];

    const field = pane.getByLabelText("Field in a.txt");
    field.focus();
    fireEvent.keyDown(field, { key: "Tab", ctrlKey: true });
    await waitFor(() => expect(pane.getByTestId("file-inspector").dataset.path).toBe("b.txt"));
    expect(requested.left).toEqual(["a.txt"]);

    pane.getByLabelText("Field in b.txt").focus();
    act(() => bridge.emitMenuCommand("close-tab"));
    await waitFor(() => expect(pane.queryByTestId(editorTabTestId("b.txt"))).toBeNull());
    expect(requested.left).toEqual(["a.txt", "b.txt"]);
  });

  it.each(["darwin", "win32"] as const)("closes the last tab, then on macOS the window (%s)", async (platform) => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["b.md"])), platform);
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const pane = within(screen.getByTestId("editor-group-primary"));
    expect(pane.getByTestId(editorTabTestId("b.md"))).toBeTruthy();

    act(() => bridge.emitMenuCommand("close-tab"));
    await waitFor(() => expect(pane.queryByTestId(editorTabTestId("b.md"))).toBeNull());
    expect(bridge.closeThisWindow).not.toHaveBeenCalled();

    act(() => bridge.emitMenuCommand("close-tab"));
    expect(bridge.closeThisWindow).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  });
});
