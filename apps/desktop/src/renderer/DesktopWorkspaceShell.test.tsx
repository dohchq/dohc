// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeSetRecord,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuResult,
  WorkspaceSearchPayload,
  WorkspaceUiState,
} from "../ipc/bridgeContract";
import type { SearchResultsEvent } from "../ipc/channels";
import { rendererMarks } from "../performance/rendererMarks";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";

const WORKSPACE: Workspace = {
  workspaceId: "ws-shell-test",
  rootPath: "/home/ice/dohc/personal",
  kind: "personal",
  mode: "local-first",
};

const SYNC_STATUS = {
  state: "synced" as const,
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
};

const STORED_STATE: WorkspaceUiState = {
  version: 1,
  activeView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 320,
  tabs: ["b.md"],
  activeTab: "b.md",
  historyVisible: true,
  historyWidth: 360,
};

Element.prototype.scrollIntoView = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function changeSet(id: string, recordedAtMs: number, humanSummary: string): ChangeSetRecord {
  return {
    id,
    recordedAtMs,
    kind: "user-edit",
    author: { kind: "user", userId: "ice" },
    summary: humanSummary,
    humanSummary,
    fileCount: 1,
  };
}

function makeBridge(
  uiStatePromise: Promise<WorkspaceUiState | null>,
  initialChangeSets: ChangeSetRecord[] = [],
) {
  let changeSets = initialChangeSets;
  let activityCallback: (() => void) | null = null;
  let searchCallback: ((batch: SearchResultsEvent) => void) | null = null;
  return {
    setChangeSets: (next: ChangeSetRecord[]) => {
      changeSets = next;
    },
    emitWorkspaceActivity: () => activityCallback?.(),
    emitSearchResults: (batch: SearchResultsEvent) => searchCallback?.(batch),
    getWorkspaceUiState: vi.fn(() => uiStatePromise),
    setWorkspaceUiState: vi.fn(
      async (_payload: { workspaceId: string; state: WorkspaceUiState }) => undefined,
    ),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [
        { path: "a.md", kind: "file" as const },
        { path: "b.md", kind: "file" as const },
      ],
      folders: [] as string[],
    })),
    openWorkspace: vi.fn(async () => SYNC_STATUS),
    getSyncStatus: vi.fn(async () => SYNC_STATUS),
    listChangeSets: vi.fn(async () => ({ changeSets })),
    readCatchUpSummary: vi.fn(async () => {
      const latest = changeSets[changeSets.length - 1] ?? null;
      return {
        lines: changeSets.map((change) => change.humanSummary),
        latestRecordedAtMs: latest?.recordedAtMs ?? null,
        latestChangeSetId: latest?.id ?? null,
        latestHistoryIndex: changeSets.length > 0 ? changeSets.length - 1 : null,
      };
    }),
    getAgentRunStatus: vi.fn(async () => ({
      mcpEnabled: false,
      activeRun: null,
      lastRun: null,
    })),
    getMcpConfig: vi.fn(async () => ({
      command: "dohc-mcp",
      args: ["--workspace", WORKSPACE.rootPath, "--home", "/tmp/dohc-home"],
      workspacePath: WORKSPACE.rootPath,
      home: "/tmp/dohc-home",
    })),
    probeAgentDrivers: vi.fn(async () => ({
      drivers: [],
      session: null,
    })),
    getAgentSessionState: vi.fn(async () => ({
      drivers: [],
      session: null,
    })),
    startAgentSession: vi.fn(async () => ({
      drivers: [],
      session: null,
    })),
    stopAgentSession: vi.fn(async () => ({
      drivers: [],
      session: null,
    })),
    answerAgentPermission: vi.fn(async () => ({
      drivers: [],
      session: null,
    })),
    readWorkspaceText: vi.fn(async () => ({ text: "# Doc\n", truncated: false })),
    readWorkspaceGraph: vi.fn(async () => ({
      nodes: [
        { path: "a.md", title: "A", incoming: 0, outgoing: 1 },
        { path: "b.md", title: "B", incoming: 1, outgoing: 0 },
      ],
      edges: [{ source: "a.md", target: "b.md", kind: "wikilink" as const }],
      unresolvedLinks: 0,
      scannedFileCount: 2,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    createWorkspaceFile: vi.fn(async (payload: { relativePath: string }) => ({
      path: payload.relativePath,
    })),
    createWorkspaceFolder: vi.fn(async (payload: { relativePath: string }) => ({
      path: payload.relativePath,
    })),
    importWorkspaceFiles: vi.fn(async () => ({ imported: ["imported.md"] })),
    exportWorkspaceZip: vi.fn(async () => ({ path: "/tmp/workspace.zip" })),
    showExplorerMenu: vi.fn(async (): Promise<ShowExplorerMenuResult> => null),
    showWorkbenchMenu: vi.fn(async (): Promise<ShowWorkbenchMenuResult> => null),
    getDroppedFilePaths: vi.fn(() => []),
    cloudStatus: vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true,
    })),
    createDataFragment: vi.fn(async () => ({
      fragment: {
        fragmentId: "fragment-created",
        sourceWorkspaceId: "ws-shell-test",
        sourcePath: "a.md",
        title: "Shared data",
        preview: "10 apples",
        contentType: "text/plain",
        createdBy: "owner-1",
        createdAt: "2026-06-18T00:00:00.000Z",
        recipientEmail: "peer@dohc.test",
      },
    })),
    listDataFragments: vi.fn(async () => ({
      fragments: [
        {
          fragmentId: "fragment-1",
          sourceWorkspaceId: "source-ws",
          sourcePath: "source.md",
          title: "Apple count",
          preview: "10 apples",
          contentType: "text/plain",
          createdBy: "owner-1",
          createdAt: "2026-06-18T00:00:00.000Z",
          recipientEmail: "me@dohc.test",
        },
      ],
    })),
    readDataFragment: vi.fn(async () => ({
      fragment: {
        fragmentId: "fragment-1",
        sourceWorkspaceId: "source-ws",
        sourcePath: "source.md",
        title: "Apple count",
        preview: "10 apples",
        contentType: "text/plain",
        createdBy: "owner-1",
        createdAt: "2026-06-18T00:00:00.000Z",
        recipientEmail: "me@dohc.test",
        body: "10 apples",
      },
    })),
    revokeDataFragment: vi.fn(async () => undefined),
    listWorkspaceShares: vi.fn(async () => ({ shares: [] })),
    listWorkspaceMembers: vi.fn(async () => ({
      members: [{ userId: "owner-1", email: "owner@dohc.test", role: "owner" }],
    })),
    listWorkspaceInvites: vi.fn(async () => ({ invites: [] })),
    createWorkspaceInvite: vi.fn(async () => ({
      invite: {
        inviteId: "invite-1",
        workspaceId: "ws-shell-test",
        email: "new@dohc.test",
        role: "member",
        invitedBy: "owner-1",
        status: "pending" as const,
      },
    })),
    revokeWorkspaceInvite: vi.fn(async () => undefined),
    collabToken: vi.fn(async () => ({ available: false as const })),
    onWorkspaceActivity: vi.fn((callback: () => void) => {
      activityCallback = callback;
      return () => {
        activityCallback = null;
      };
    }),
    onMenuCommand: vi.fn(() => () => {}),
    onUpdateState: vi.fn(() => () => {}),
    // Content search (E5.0): the shell subscribes on mount.
    onSearchResults: vi.fn((callback: (batch: SearchResultsEvent) => void) => {
      searchCallback = callback;
      return () => {
        searchCallback = null;
      };
    }),
    searchWorkspace: vi.fn(async (_payload: WorkspaceSearchPayload) => undefined),
    cancelWorkspaceSearch: vi.fn(async () => undefined),
  };
}

function renderShell(bridge: ReturnType<typeof makeBridge>) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(
    <DesktopWorkspaceShell
      workspace={WORKSPACE}
      workspaces={[WORKSPACE]}
      onSwitchWorkspace={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// THE merge-on-load race (codex P2): the load gate used to compare COMMITTED
// state (wbRef, synced in a passive effect) against defaults. A user action
// whose commit/effects had not flushed yet read as "untouched", and the
// stored state clobbered it. The gate must be a ref set SYNCHRONOUSLY inside
// the mutation, before React even queues the update.
describe("ui-state merge-on-load", () => {
  it("a user open QUEUED before the load resolves wins over stored state (the exact stale-ref race)", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    const row = await screen.findByText("a.md");

    await act(async () => {
      // Resolve the load FIRST (queues its .then as a microtask), then click
      // via a RAW dispatch: React commits the open synchronously but defers
      // passive effects (a scheduler macrotask), so when the awaited
      // microtask runs the .then, wbRef still holds the stale default. Only
      // the synchronous touched-ref can know the user already acted.
      stored.resolve(STORED_STATE);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    // The user's open survived; the stored tabs did NOT clobber it.
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.queryByTestId("tab-b.md")).toBeNull();
    // And the pre-load action is durable: it gets written (immediate write on
    // load-settle, then the debounced writer once the commit lands).
    await waitFor(
      () => {
        const states = bridge.setWorkspaceUiState.mock.calls.map(
          ([payload]) => payload.state,
        );
        expect(
          states.some((state) => state.tabs.includes("a.md")),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("stored state applies when the user touched nothing before the load", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);
    await screen.findByText("a.md");

    await act(async () => {
      stored.resolve(STORED_STATE);
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
    expect((await screen.findByTestId("history-timeline")).style.width).toBe("360px");
  });
});

// Spurious file-open-start marks (codex P2): a no-op click on the already-
// active row used to mark anyway — no remount/measure follows, so the stale
// mark corrupts the NEXT open's latency measure.
describe("file-open-start marking", () => {
  it("marks on a real open, but NOT on a no-op click on the already-active file", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => name === "file-open-start").length;

    const row = await screen.findByText("a.md");
    await user.click(row);
    await screen.findByTestId("tab-a.md");
    expect(openStartCalls()).toBe(1);

    // Re-clicking the active row is a no-op open: no remount, no mark.
    await user.click(row);
    expect(openStartCalls()).toBe(1);

    // A different file is a real open again.
    await user.click(screen.getByText("b.md"));
    await screen.findByTestId("tab-b.md");
    expect(openStartCalls()).toBe(2);

    mark.mockRestore();
  });
});

describe("active file sharing", () => {
  it("opens the share dialog for the active inspector path", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("a.md")).toBeTruthy();
    expect(await within(dialog).findByText("Only you have access.")).toBeTruthy();
    expect(bridge.listWorkspaceShares).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
    });
  });
});

describe("content search", () => {
  it("clears the activity badge as soon as the query is cleared", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    const input = await screen.findByTestId("search-input");

    await user.type(input, "apples");
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());

    const searchPayload = bridge.searchWorkspace.mock.calls.at(-1)![0];
    act(() => {
      bridge.emitSearchResults({
        searchId: searchPayload.searchId,
        entries: [
          {
            path: "a.md",
            line: 1,
            column: 9,
            preview: "I ate 10 apples",
            matchStart: 9,
            matchEnd: 15,
          },
          {
            path: "b.md",
            line: 2,
            column: 4,
            preview: "two apples",
            matchStart: 4,
            matchEnd: 10,
          },
        ],
        done: true,
        limitHit: false,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("activity-search-count").textContent).toBe("2"),
    );

    await user.clear(input);

    await waitFor(() => {
      expect(screen.queryByTestId("activity-search-count")).toBeNull();
    });
  });
});

describe("file tree drag preview", () => {
  it("marks no-op drops before release", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    const rows = await screen.findAllByTestId("tree-row");
    const rowA = rows.find((row) => row.getAttribute("data-path") === "a.md")!;
    const rowB = rows.find((row) => row.getAttribute("data-path") === "b.md")!;
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      files: [],
      types: [],
      setData: vi.fn(),
    };

    fireEvent.dragStart(rowA, { dataTransfer });
    fireEvent.dragOver(rowB, { dataTransfer });

    expect(rowB.dataset.dropState).toBe("blocked");
    expect(within(rowB).queryByTestId("tree-drop-label")).toBeNull();
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("highlights a hovered folder and its visible contents", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [
        { path: "docs/a.md", kind: "file" as const },
        { path: "docs/b.md", kind: "file" as const },
        { path: "loose.md", kind: "file" as const },
      ],
      folders: ["docs"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    const folder = await screen.findByText("docs");
    await user.click(folder);

    const rows = await screen.findAllByTestId("tree-row");
    const source = rows.find((row) => row.getAttribute("data-path") === "loose.md")!;
    const docs = rows.find((row) => row.getAttribute("data-path") === "docs")!;
    const childA = rows.find((row) => row.getAttribute("data-path") === "docs/a.md")!;
    const childB = rows.find((row) => row.getAttribute("data-path") === "docs/b.md")!;
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      files: [],
      types: [],
      setData: vi.fn(),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(docs, { dataTransfer });

    expect(docs.dataset.dropState).toBe("move");
    expect(childA.dataset.dropState).toBe("move");
    expect(childB.dataset.dropState).toBe("move");
    expect(within(docs).queryByTestId("tree-drop-label")).toBeNull();
  });
});

describe("graph view", () => {
  it("opens as a side panel first, then opens the full graph in an editor tab", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");

    await user.click(screen.getByTestId("activity-graph"));

    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
    expect(screen.getByTestId("view-markdown")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("graph-view")
          .some((view) => view.getAttribute("data-variant") === "panel"),
      ).toBe(true);
    });

    await user.click(screen.getByTestId("graph-open-tab"));

    const graphTab = await screen.findByTestId("tab-dohc://graph");
    expect(graphTab.dataset.active).toBe("true");
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("graph-view")
          .some((view) => view.getAttribute("data-variant") === "page"),
      ).toBe(true);
    });
  });
});

describe("open editors", () => {
  it("collapses and restores the file tree section", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    expect(await screen.findAllByTestId("tree-row")).toHaveLength(2);
    await user.click(screen.getByTestId("explorer-files-toggle"));

    expect(screen.queryAllByTestId("tree-row")).toHaveLength(0);
    expect(screen.getByTestId("explorer-files-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );

    await user.click(screen.getByTestId("explorer-files-toggle"));
    expect(await screen.findAllByTestId("tree-row")).toHaveLength(2);
  });

  it("surfaces open-editor title actions for untitled files and close-all", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New untitled text file"));

    expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
      relativePath: "Untitled.txt",
    });
    expect(await screen.findByTestId("tab-Untitled.txt")).toBeTruthy();

    await user.click(screen.getByLabelText("Close all editors"));
    await waitFor(() => expect(screen.queryByTestId("tab-Untitled.txt")).toBeNull());
    expect(screen.queryAllByTestId("open-editor-row")).toHaveLength(0);
  });

  it("surfaces file title actions for create, refresh, and collapse folders", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New file"));
    expect(await screen.findByLabelText("New file name")).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByLabelText("New folder"));
    expect(await screen.findByLabelText("New folder name")).toBeTruthy();
    await user.keyboard("{Escape}");

    const refreshCount = bridge.listWorkspaceFiles.mock.calls.length;
    await user.click(screen.getByLabelText("Refresh explorer"));
    await waitFor(() =>
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(refreshCount),
    );
  });

  it("collapses all expanded folders from the files title action", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "docs/a.md", kind: "file" as const }],
      folders: ["docs"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("docs"));
    await screen.findByText("a.md");
    await user.click(screen.getByLabelText("Collapse folders in explorer"));

    await waitFor(() => expect(screen.queryByText("a.md")).toBeNull());
  });

  it("mirrors tabs in the explorer and supports activate and close", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
    const rowB = treeRows.find((row) => row.getAttribute("data-path") === "b.md")!;

    await user.click(rowA);
    await user.click(rowB);
    await screen.findByTestId("tab-b.md");

    const editorRows = () => screen.getAllByTestId("open-editor-row");
    const openA = () =>
      editorRows().find((row) => row.getAttribute("data-path") === "a.md")!;
    const openB = () =>
      editorRows().find((row) => row.getAttribute("data-path") === "b.md")!;

    expect(openA()).toBeTruthy();
    expect(openB().getAttribute("data-active")).toBe("true");

    await user.click(within(openA()).getByText("a.md"));
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
    expect(openA().getAttribute("data-active")).toBe("true");

    await user.click(within(openA()).getByLabelText("Close a.md"));
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    expect(editorRows().map((row) => row.getAttribute("data-path"))).toEqual(["b.md"]);
  });
});

describe("history rail", () => {
  it("can be collapsed and restored from the right edge", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("history-timeline");
    await user.click(screen.getByTestId("history-collapse"));

    expect(screen.queryByTestId("history-timeline")).toBeNull();
    await user.click(screen.getByTestId("history-restore"));

    expect(await screen.findByTestId("history-timeline")).toBeTruthy();
  });

  it("can be resized well beyond the old narrow rail width", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    const rail = await screen.findByTestId("history-timeline");
    Object.defineProperty(rail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 720,
        y: 0,
        left: 720,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 280,
        height: 800,
        toJSON: () => {},
      }),
    });

    const handle = screen.getByTestId("history-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 100 });

    await waitFor(() => {
      expect(rail.style.width).toBe("900px");
    });
  });
});

describe("data fragments and file transfers", () => {
  it("opens the data-fragment panel from the explorer footer", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("import-export-open"));

    const dialog = await screen.findByTestId("import-export-dialog");
    expect(within(dialog).getByText("Data fragments")).toBeTruthy();
    expect(within(dialog).queryByText("Files and archives")).toBeNull();
  });

  it("keeps file import and workspace zip export as separate commands", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    await waitFor(() => {
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
      });
    });

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Export workspace as zip"));
    await waitFor(() => {
      expect(bridge.exportWorkspaceZip).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
      });
    });
  });
});

describe("native workbench context menus", () => {
  it("opens import/export data from a file tree context menu", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showExplorerMenu.mockResolvedValue("import-export");
    renderShell(bridge);

    const row = (await screen.findAllByTestId("tree-row")).find(
      (item) => item.getAttribute("data-path") === "a.md",
    )!;
    fireEvent.contextMenu(row);

    await waitFor(() => {
      expect(bridge.showExplorerMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        kind: "file",
        path: "a.md",
        pinned: false,
      });
    });
    const dialog = await screen.findByTestId("import-export-dialog");
    expect(within(dialog).getAllByText("a.md").length).toBeGreaterThan(0);
  });

  it("routes tab context menu commands through existing tab actions", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("close-other-tabs");
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await user.click(screen.getByText("b.md"));
    await screen.findByTestId("tab-b.md");

    fireEvent.contextMenu(screen.getByTestId("tab-a.md"));

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "tab",
        path: "a.md",
      });
    });
    await waitFor(() => expect(screen.queryByTestId("tab-b.md")).toBeNull());
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  });

  it("opens the native editor context menu from the inspector area", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    fireEvent.contextMenu(await screen.findByTestId("view-markdown"));

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "editor",
      });
    });
  });

  it("opens import/export data from the editor context menu", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("import-export");
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    fireEvent.contextMenu(await screen.findByTestId("view-markdown"));

    const dialog = await screen.findByTestId("import-export-dialog");
    expect(within(dialog).getByText("Cloud data fragment")).toBeTruthy();
    expect(within(dialog).queryByText("Files and archives")).toBeNull();
  });

  it("opens import/export data for the tab path from the tab context menu", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("import-export");
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await user.click(screen.getByText("b.md"));
    fireEvent.contextMenu(await screen.findByTestId("tab-a.md"));

    const dialog = await screen.findByTestId("import-export-dialog");
    expect(within(dialog).getAllByText("a.md").length).toBeGreaterThan(0);
  });

  it("routes status bar context menu commands to panel actions", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("open-agent");
    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "status",
      });
    });
    expect(await screen.findByTestId("agent-panel")).toBeTruthy();
  });
});

describe("workspace management", () => {
  it("opens the workspace management dialog from the command palette", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("textbox", { name: "Command" }), "manage");
    await user.keyboard("{Enter}");

    const dialog = await screen.findByTestId("workspace-management-dialog");
    expect(await within(dialog).findByText("owner@dohc.test")).toBeTruthy();
    expect(bridge.listWorkspaceMembers).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
    });
    expect(bridge.listWorkspaceInvites).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
    });
  });
});

describe("catch-up refresh", () => {
  it("reloads when a non-top history record arrives", async () => {
    const newest = changeSet("newest", 2000, "ice edited notes/newest.md");
    const bridge = makeBridge(Promise.resolve(null), [newest]);
    renderShell(bridge);

    await waitFor(() => {
      expect(bridge.listChangeSets).toHaveBeenCalled();
      expect(bridge.readCatchUpSummary.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const initialReadCount = bridge.readCatchUpSummary.mock.calls.length;

    bridge.setChangeSets([
      newest,
      changeSet("same-time-behind", 2000, "ice edited notes/behind.md"),
    ]);
    act(() => {
      bridge.emitWorkspaceActivity();
    });

    await waitFor(() => {
      expect(bridge.readCatchUpSummary.mock.calls.length).toBeGreaterThan(
        initialReadCount,
      );
    });
    const historyRail = within(screen.getByTestId("history-timeline"));
    await waitFor(() => {
      expect(
        historyRail
          .getAllByTestId("catch-up-line")
          .map((line) => line.textContent),
      ).toContain("ice edited notes/behind.md");
    });
  });
});
