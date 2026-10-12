// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

const requested = vi.hoisted(() => ({ path: "" }));
vi.mock("./workbench/Explorer", () => ({
  Explorer: (props: Pick<ExplorerProps, "onOpenFile">) => (
    <button onClick={() => props.onOpenFile(requested.path)}>Open test tab</button>
  ),
}));
// Keep the shell, its navigation callbacks and its authority gates real.
// Leaf markers identify which component the switch actually mounts.
vi.mock("./FileInspector", () => ({
  FileInspector: (props: { path: string }) => <div data-testid="file-inspector" data-path={props.path} />,
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

  it("keeps the empty editor state when no tab is open", async () => {
    renderShell(makeBridge(Promise.resolve(storedStateWithTabs([]))));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const pane = within(screen.getByTestId("editor-group-primary"));
    expect(pane.getByText("Select a file, or create one")).toBeTruthy();
    expect(pane.queryByTestId("file-inspector")).toBeNull();
  });
});
