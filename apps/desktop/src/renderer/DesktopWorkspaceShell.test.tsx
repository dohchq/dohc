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
  ChangeSetDetailRecord,
  ChangeSetFileRecord,
  ChangeSetRecord,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuResult,
  UpdateStateEvent,
  WorkspaceSearchPayload,
  WorkspaceUiState,
} from "../ipc/bridgeContract";
import type { MenuCommandId, SearchResultsEvent } from "../ipc/channels";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { rendererMarks } from "../performance/rendererMarks";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
import { historyDiffTabPath } from "./workbench/workbenchState";

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

const IDLE_UPDATE_STATE: UpdateStateEvent = {
  status: "idle",
  message: "Updates have not been checked yet.",
  currentVersion: "1.2.3",
  channel: "latest",
  canCheck: true,
  canInstall: false,
};

const READY_UPDATE_STATE: UpdateStateEvent = {
  status: "ready",
  message: "Update 1.2.4 is ready — restart dohc to apply it.",
  currentVersion: "1.2.3",
  channel: "latest",
  canCheck: false,
  canInstall: true,
  version: "1.2.4",
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
  const pathMatch = humanSummary.match(/\b(?:edited|updated|deleted|shared)\s+([^\s]+)$/i);
  const previewPath = pathMatch?.[1] ?? "notes/today.md";
  return {
    id,
    recordedAtMs,
    kind: "user-edit",
    author: { kind: "user", userId: "ice" },
    summary: humanSummary,
    humanSummary,
    fileCount: 1,
    filePreview: [
      {
        path: previewPath,
        operation: /\bdeleted\b/i.test(humanSummary) ? "delete" : "write",
      },
    ],
  };
}

function makeBridge(
  uiStatePromise: Promise<WorkspaceUiState | null>,
  initialChangeSets: ChangeSetRecord[] = [],
  filesByChangeSetId: Record<string, ChangeSetFileRecord[]> = {},
  detailsByChangeSetId: Record<
    string,
    Partial<Pick<ChangeSetDetailRecord, "boundaryCrossings" | "provenance">>
  > = {},
) {
  let changeSets = initialChangeSets;
  let activityCallback: (() => void) | null = null;
  let searchCallback: ((batch: SearchResultsEvent) => void) | null = null;
  let menuCallback: ((command: MenuCommandId) => void) | null = null;
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
    readChangeSet: vi.fn(async (payload: { changeSetId: string }) => {
      const record = changeSets.find((change) => change.id === payload.changeSetId);
      const details = detailsByChangeSetId[payload.changeSetId];
      const files = filesByChangeSetId[payload.changeSetId] ?? [
        {
          path: "notes/today.md",
          operation: "write" as const,
          mediaType: "text/markdown",
          before: { text: "# Today\nBefore\n", truncated: false },
          after: { text: "# Today\nAfter\n", truncated: false },
        },
      ];
      return {
        changeSet: record
          ? {
            ...record,
            files,
              boundaryCrossings:
                details?.boundaryCrossings ?? record.boundaryCrossingPreview ?? [],
              ...(details?.provenance ? { provenance: details.provenance } : {}),
            }
          : null,
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
    getUserSettings: vi.fn(async () => ({
      settings: DEFAULT_USER_SETTINGS,
      source: "default" as const,
    })),
    setUserSettings: vi.fn(async (payload: { settings: typeof DEFAULT_USER_SETTINGS }) => ({
      settings: payload.settings,
      source: "stored" as const,
    })),
    resetUserSettings: vi.fn(async () => ({
      settings: DEFAULT_USER_SETTINGS,
      source: "stored" as const,
    })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
    setWorkspaceSettings: vi.fn(
      async (payload: { settings: typeof DEFAULT_WORKSPACE_SETTINGS }) => ({
        settings: payload.settings,
        source: "stored" as const,
      }),
    ),
    resetWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "stored" as const,
    })),
    writeClipboardText: vi.fn(async () => undefined),
    setTitlebarTheme: vi.fn(async () => undefined),
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
    restoreHistoryFile: vi.fn(async () => ({ restored: "text" as const })),
    undoHistoryFileRestore: vi.fn(async () => ({ restored: "text" as const })),
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
    getUpdateState: vi.fn(async () => IDLE_UPDATE_STATE),
    checkForUpdates: vi.fn(async () => ({
      checked: true,
      state: READY_UPDATE_STATE,
    })),
    installUpdate: vi.fn(async () => ({
      accepted: true,
      completed: false,
      state: READY_UPDATE_STATE,
    })),
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
    onMenuCommand: vi.fn((callback: (command: MenuCommandId) => void) => {
      menuCallback = callback;
      return () => {
        menuCallback = null;
      };
    }),
    emitMenuCommand: (command: MenuCommandId) => menuCallback?.(command),
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

describe("workspace shell errors", () => {
  it("reports openWorkspace failures instead of leaving an unhandled rejection", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace.mockRejectedValueOnce(new Error("Watcher failed"));

    renderShell(bridge);

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "Watcher failed",
    );
  });

  it("reports refresh failures after a successful file import without retrying import", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalled());
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("Refresh failed"));

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));

    await waitFor(() => {
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "Refresh failed",
      );
    });
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

describe("history page", () => {
  it("opens history as a full editor tab from the history side panel", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-history-tab", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("history-open-tab"));

    const historyTab = await screen.findByTestId("tab-dohc://history");
    expect(historyTab.dataset.active).toBe("true");
    const page = await screen.findByTestId("history-page");
    expect(within(page).getAllByText("ice edited notes/today.md").length).toBeGreaterThan(
      0,
    );

    await user.click(
      within(page).getByRole("button", { name: /open diff for notes\/today\.md/i }),
    );
    expect((await screen.findByTestId("tab-dohc://history")).dataset.active).toBeUndefined();
    expect(
      (await screen.findByTestId(
        `tab-${historyDiffTabPath("change-history-tab", "notes/today.md")}`,
      )).dataset.active,
    ).toBe("true");
    expect(bridge.readChangeSet).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
      changeSetId: "change-history-tab",
    });
  });
});

describe("open editors", () => {
  it("highlights the full open editors and files header bars on hover", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    expect(screen.getByTestId("open-editors-header").className).toContain(
      "hover:bg-line/40",
    );
    expect(screen.getByTestId("explorer-files-header").className).toContain(
      "hover:bg-line/40",
    );
    expect(screen.getByTestId("open-editors-toggle").className).not.toContain(
      "hover:bg-line/40",
    );
    expect(screen.getByTestId("explorer-files-toggle").className).not.toContain(
      "hover:bg-line/40",
    );
  });

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

  it("creates files and folders from the files title actions at the focused tree context", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "docs/a.md", kind: "file" as const }],
      folders: ["docs"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("docs"));
    await user.click(screen.getByLabelText("New file"));
    await user.keyboard("notes.md{Enter}");

    await waitFor(() =>
      expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        relativePath: "docs/notes.md",
      }),
    );

    await user.click(await screen.findByText("a.md"));
    await user.click(screen.getByLabelText("New folder"));
    await user.keyboard("assets{Enter}");

    await waitFor(() =>
      expect(bridge.createWorkspaceFolder).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        relativePath: "docs/assets",
      }),
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

  it("checks for desktop updates from the command palette", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Check for updates"));

    await waitFor(() => {
      expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
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

  it("routes status bar update commands to the updater bridge", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("install-update");

    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

    await waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledOnce();
    });
  });

  it("opens settings from the status bar context menu", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("settings");
    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });
});

describe("settings entry points", () => {
  it("opens settings from the status bar and activity bar", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("open-settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    await user.click(screen.getByLabelText("Close settings"));

    await user.click(screen.getByTestId("activity-settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("opens settings from the command palette and menu command", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText("Settings"),
    );
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    await user.click(screen.getByLabelText("Close settings"));

    act(() => bridge.emitMenuCommand("settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("opens appearance settings from a section command and Ctrl+comma", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Appearance",
      ),
    );
    expect(await screen.findByTestId("settings-section-appearance")).toBeTruthy();
    await user.click(screen.getByLabelText("Close settings"));

    await user.keyboard("{Control>},{/Control}");
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
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

describe("history details", () => {
  it("groups history rows by day and flags review-required changes in compact rows", async () => {
    const dayOne = new Date(2026, 0, 2, 12, 0).getTime();
    const dayTwo = new Date(2026, 0, 1, 12, 0).getTime();
    const bridge = makeBridge(Promise.resolve(null), [
      {
        ...changeSet("review-change", dayOne, "ice shared notes/public.md"),
        reviewRequired: true,
        boundaryCrossingCount: 1,
        boundaryCrossingPreview: ["private-to-shared"],
      },
      changeSet("ordinary-change", dayOne - 60_000, "ice edited notes/today.md"),
      changeSet("older-change", dayTwo, "ice edited notes/yesterday.md"),
    ]);
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    const headings = await historyRail.findAllByTestId("history-day-heading");
    expect(headings.map((heading) => heading.getAttribute("dateTime"))).toEqual([
      "2026-01-02",
      "2026-01-01",
    ]);
    expect(historyRail.getByTestId("history-review-badge").textContent).toBe(
      "Needs review",
    );
    expect(historyRail.getByTestId("history-review-badge").getAttribute("title")).toBe(
      "Private to shared",
    );
    expect(historyRail.queryByTestId("history-change-details")).toBeNull();
    expect(
      historyRail.getByTestId("history-list").querySelector("[aria-expanded]"),
    ).toBeNull();
  });

  it("filters history by search text and review-required changes", async () => {
    const bridge = makeBridge(Promise.resolve(null), [
      {
        ...changeSet("review", 3000, "ice shared notes/public.md"),
        fileCount: 2,
        reviewRequired: true,
        boundaryCrossingCount: 1,
        boundaryCrossingPreview: ["private-to-shared"],
        lineStats: {
          added: 1,
          removed: 1,
          changedFileCount: 1,
          unavailableFileCount: 1,
        },
      },
      {
        ...changeSet("apples", 2000, "ice edited notes/apples.md"),
        lineStats: {
          added: 10,
          removed: 0,
          changedFileCount: 1,
          unavailableFileCount: 0,
        },
      },
      {
        ...changeSet("budget", 1000, "ice edited finance/budget.csv"),
        lineStats: {
          added: 0,
          removed: 4,
          changedFileCount: 1,
          unavailableFileCount: 0,
        },
      },
    ]);
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    expect(historyRail.getByTestId("history-filter-count").textContent).toBe("3/3");
    expect(historyRail.queryByTestId("history-overview")).toBeNull();

    await user.type(historyRail.getByTestId("history-search-input"), "apples");

    expect(historyRail.getByTestId("history-filter-count").textContent).toBe("1/3");
    expect(
      within(historyRail.getByTestId("history-list")).getByText(
        "ice edited notes/apples.md",
      ),
    ).toBeTruthy();
    expect(historyRail.getByTestId("history-line-stats").textContent).toBe("+10 -0");
    expect(
      within(historyRail.getByTestId("history-list")).queryByText(
        "ice edited finance/budget.csv",
      ),
    ).toBeNull();

    await user.click(historyRail.getByTestId("history-search-clear"));
    await user.click(historyRail.getByTestId("history-review-filter"));

    expect(
      historyRail.getByTestId("history-review-filter").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(historyRail.getByTestId("history-filter-count").textContent).toBe("1/3");
    expect(
      within(historyRail.getByTestId("history-list")).getByText(
        "ice shared notes/public.md",
      ),
    ).toBeTruthy();
    expect(historyRail.getByTestId("history-line-stats").textContent).toBe(
      "+1 -1 · 1 not diffed",
    );
    expect(
      within(historyRail.getByTestId("history-list")).queryByText(
        "ice edited notes/apples.md",
      ),
    ).toBeNull();
  });

  it("filters history by people or agent authors", async () => {
    const bridge = makeBridge(Promise.resolve(null), [
      {
        ...changeSet("agent-plan", 3000, "codex updated docs/plan.md"),
        author: { kind: "agent", agentId: "codex", onBehalfOf: "ice" },
        fileCount: 2,
        lineStats: {
          added: 8,
          removed: 2,
          changedFileCount: 2,
          unavailableFileCount: 0,
        },
      },
      {
        ...changeSet("user-note", 2000, "ice edited notes/today.md"),
        lineStats: {
          added: 1,
          removed: 0,
          changedFileCount: 1,
          unavailableFileCount: 0,
        },
      },
    ]);
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    expect(historyRail.getByTestId("history-filter-count").textContent).toBe("2/2");

    await user.click(historyRail.getByTestId("history-author-filter-agent"));

    expect(
      historyRail.getByTestId("history-author-filter-agent").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(historyRail.getByTestId("history-filter-count").textContent).toBe("1/2");
    expect(
      within(historyRail.getByTestId("history-list")).getByText(
        "codex updated docs/plan.md",
      ),
    ).toBeTruthy();
    expect(historyRail.getByTestId("history-line-stats").textContent).toBe("+8 -2");
    expect(
      within(historyRail.getByTestId("history-list")).queryByText(
        "ice edited notes/today.md",
      ),
    ).toBeNull();

    await user.click(historyRail.getByTestId("history-author-filter-user"));

    expect(historyRail.getByTestId("history-filter-count").textContent).toBe("1/2");
    expect(historyRail.getByTestId("history-line-stats").textContent).toBe("+1 -0");
    expect(
      within(historyRail.getByTestId("history-list")).getByText(
        "ice edited notes/today.md",
      ),
    ).toBeTruthy();
    expect(
      within(historyRail.getByTestId("history-list")).queryByText(
        "codex updated docs/plan.md",
      ),
    ).toBeNull();
  });

  it("keeps history rows minimal without file previews while showing line stats", async () => {
    const bridge = makeBridge(Promise.resolve(null), [
      {
        ...changeSet("many-files", 2000, "ice edited project files"),
        fileCount: 5,
        filePreview: [
          { path: "notes/one.md", operation: "write" },
          { path: "notes/two.md", operation: "write" },
          { path: "data/old.csv", operation: "delete" },
          { path: "docs/renamed.md", operation: "rename" },
        ],
        lineStats: {
          added: 12,
          removed: 5,
          changedFileCount: 3,
          unavailableFileCount: 1,
        },
      },
    ]);
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    const row = await historyRail.findByTestId("change-set");

    expect(row.textContent).toContain("ice edited project files");
    expect(historyRail.getByTestId("history-recorded-at").getAttribute("dateTime")).toBe(
      new Date(2000).toISOString(),
    );
    expect(row.textContent).toContain("5 files");
    expect(historyRail.queryByTestId("history-file-preview")).toBeNull();
    expect(historyRail.queryByTestId("history-file-preview-entry")).toBeNull();
    expect(historyRail.getByTestId("history-line-stats").textContent).toBe(
      "+12 -5 · 1 not diffed",
    );
    expect(historyRail.getByTestId("history-line-stats-added").className).toContain(
      "text-success",
    );
    expect(historyRail.getByTestId("history-line-stats-removed").className).toContain(
      "text-danger",
    );
    expect(row.textContent).not.toContain("notes/one.md");
  });

  it("opens the whole history row as a unified diff tab", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-1", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));

    expect(historyRail.getByTestId("history-recorded-at").getAttribute("dateTime")).toBe(
      new Date(2000).toISOString(),
    );
    expect(historyRail.queryByTestId("history-change-details")).toBeNull();
    expect(historyRail.queryByTestId("history-file-preview")).toBeNull();
    expect(historyRail.queryByText("-Before")).toBeNull();

    await user.click(await historyRail.findByTestId("history-change-open"));

    await waitFor(() =>
      expect(bridge.readChangeSet).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        changeSetId: "change-1",
      }),
    );

    const diffTabPath = historyDiffTabPath("change-1", "notes/today.md");
    const diffTab = await screen.findByTestId(`tab-${diffTabPath}`);
    expect(diffTab.dataset.active).toBe("true");
    expect(diffTab.textContent).toContain("Diff: today.md");
    const diffPage = within(await screen.findByTestId("history-diff-page"));
    expect(diffPage.getByTestId("history-diff-counts").textContent).toBe("+1 -1");
    const diff = diffPage.getByTestId("history-diff-lines");
    expect(diff.querySelector('[data-kind="removed"]')?.textContent).toContain(
      "Before",
    );
    expect(diff.querySelector('[data-kind="added"]')?.textContent).toContain("After");
  });

  it("keeps separated edits as separated diff hunks", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-multi", 2000, "ice edited notes/today.md")],
      {
        "change-multi": [
          {
            path: "notes/today.md",
            operation: "write",
            mediaType: "text/markdown",
            before: {
              text: "title\nold apples\nkept middle\nold oranges\nclosing\n",
              truncated: false,
            },
            after: {
              text: "title\nnew apples\nkept middle\nnew oranges\nclosing\n",
              truncated: false,
            },
          },
        ],
      },
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));
    const diff = within(await screen.findByTestId("history-diff-page")).getByTestId(
      "history-diff-lines",
    );
    const removedLines = [...diff.querySelectorAll('[data-kind="removed"]')].map(
      (line) => line.textContent,
    );
    const addedLines = [...diff.querySelectorAll('[data-kind="added"]')].map(
      (line) => line.textContent,
    );
    const contextLines = [...diff.querySelectorAll('[data-kind="context"]')].map(
      (line) => line.textContent,
    );

    expect(removedLines.join("\n")).toContain("old apples");
    expect(removedLines.join("\n")).toContain("old oranges");
    expect(addedLines.join("\n")).toContain("new apples");
    expect(addedLines.join("\n")).toContain("new oranges");
    expect(contextLines.join("\n")).toContain("kept middle");
  });

  it("opens a history diff editor tab for captured text changes", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-compare", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffTabPath = historyDiffTabPath("change-compare", "notes/today.md");
    expect((await screen.findByTestId(`tab-${diffTabPath}`)).dataset.active).toBe(
      "true",
    );
    const diffPage = within(await screen.findByTestId("history-diff-page"));
    expect(diffPage.getAllByText("notes/today.md").length).toBeGreaterThan(0);
    expect(diffPage.getByTestId("history-diff-counts").textContent).toBe("+1 -1");
    const diff = diffPage.getByTestId("history-diff-lines");
    expect(diff.querySelector('[data-kind="removed"]')?.textContent).toContain(
      "Before",
    );
    expect(diff.querySelector('[data-kind="added"]')?.textContent).toContain("After");
  });

  it("does not open a history diff tab when the active draft flush fails", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-blocked", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await user.click(await screen.findByTestId("markdown-properties-toggle"));
    const editor = await screen.findByTestId("markdown-editor");
    bridge.writeWorkspaceText.mockRejectedValueOnce(new Error("Disk is full"));
    fireEvent.change(editor, { target: { value: "# Doc\nunsaved\n" } });

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "Disk is full",
      ),
    );
    expect(
      screen.queryByTestId(
        `tab-${historyDiffTabPath("change-blocked", "notes/today.md")}`,
      ),
    ).toBeNull();
    expect(bridge.readChangeSet).not.toHaveBeenCalled();
  });

  it("opens the live file from the history diff tab", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-compare-open", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-open-file"));

    expect((await screen.findByTestId("tab-notes/today.md")).dataset.active).toBe(
      "true",
    );
  });

  it("opens the live file when clicking the filename above the history diff", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-title-open", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-file-title-open-file"));

    expect((await screen.findByTestId("tab-notes/today.md")).dataset.active).toBe(
      "true",
    );
  });

  it("restores a history diff file after confirmation and exposes undo", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-revert", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    expect(bridge.restoreHistoryFile).not.toHaveBeenCalled();

    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    expect(confirm.getByText(/only changes this one file/i)).toBeTruthy();
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));

    await waitFor(() =>
      expect(bridge.restoreHistoryFile).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        changeSetId: "change-revert",
        relativePath: "notes/today.md",
      }),
    );
    expect(
      (await diffPage.findByTestId("history-diff-restore-status")).textContent,
    ).toBe("Restored the previous snapshot. Undo restore is available here.");
    await user.click(await diffPage.findByTestId("history-diff-undo-restore"));
    await waitFor(() =>
      expect(bridge.undoHistoryFileRestore).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        changeSetId: "change-revert",
        relativePath: "notes/today.md",
      }),
    );
    expect(
      (await diffPage.findByTestId("history-diff-restore-status")).textContent,
    ).toBe("Undid the restore.");
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(bridge.listChangeSets).toHaveBeenCalledTimes(3));
  });

  it("routes Ctrl+Z in the active history diff tab to guarded undo restore", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-revert-keyboard", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));
    await diffPage.findByTestId("history-diff-undo-restore");

    await user.keyboard("{Control>}z{/Control}");

    await waitFor(() =>
      expect(bridge.undoHistoryFileRestore).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        changeSetId: "change-revert-keyboard",
        relativePath: "notes/today.md",
      }),
    );
    expect(
      (await diffPage.findByTestId("history-diff-restore-status")).textContent,
    ).toBe("Undid the restore.");
  });

  it("offers durable undo when opened on a history restore entry", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("restore-entry", 2200, "You restored notes/today.md")],
      {
        "restore-entry": [
          {
            path: "notes/today.md",
            operation: "write",
            mediaType: "text/markdown",
            before: { text: "# Today\nAfter\n", truncated: false },
            after: { text: "# Today\nBefore\n", truncated: false },
          },
        ],
      },
      {
        "restore-entry": {
          provenance: {
            source: "history-restore",
            restoreOfChangeSetId: "change-revert",
            restoreOfPath: "notes/today.md",
            restoreDirection: "restore",
          },
        },
      },
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    expect(diffPage.getByTestId("history-diff-restore-file").textContent).toBe(
      "Undo restore...",
    );
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    expect(confirm.getByText(/undo this restore/i)).toBeTruthy();
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));

    await waitFor(() =>
      expect(bridge.restoreHistoryFile).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        changeSetId: "restore-entry",
        relativePath: "notes/today.md",
      }),
    );
    expect(bridge.undoHistoryFileRestore).not.toHaveBeenCalled();
    expect(
      (await diffPage.findByTestId("history-diff-restore-status")).textContent,
    ).toBe("Undid the restore. This was recorded in history.");
  });

  it("routes Cmd+Z in the active history diff tab to guarded undo restore", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-revert-command-z", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));
    await diffPage.findByTestId("history-diff-undo-restore");

    await user.keyboard("{Meta>}z{/Meta}");

    await waitFor(() =>
      expect(bridge.undoHistoryFileRestore).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        changeSetId: "change-revert-command-z",
        relativePath: "notes/today.md",
      }),
    );
  });

  it("does not route Ctrl+Z to history undo when focus is outside the diff tab", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-revert-outside", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));
    await diffPage.findByTestId("history-diff-undo-restore");
    bridge.undoHistoryFileRestore.mockClear();

    await user.click(await historyRail.findByTestId("history-change-open"));
    await user.keyboard("{Control>}z{/Control}");

    expect(bridge.undoHistoryFileRestore).not.toHaveBeenCalled();
  });

  it("does not route Ctrl+Z to history undo from editable focus", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-revert-input", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));
    await diffPage.findByTestId("history-diff-undo-restore");
    bridge.undoHistoryFileRestore.mockClear();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await user.keyboard("{Control>}z{/Control}");
    input.remove();

    expect(bridge.undoHistoryFileRestore).not.toHaveBeenCalled();
  });

  it("does not route Ctrl+Z to history undo while a blocking overlay is open", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-revert-overlay", 2000, "ice edited notes/today.md")],
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));
    await diffPage.findByTestId("history-diff-undo-restore");
    bridge.undoHistoryFileRestore.mockClear();

    const overlay = document.createElement("div");
    overlay.setAttribute("data-dohc-modal", "true");
    document.body.appendChild(overlay);
    await user.keyboard("{Control>}z{/Control}");
    overlay.remove();

    expect(bridge.undoHistoryFileRestore).not.toHaveBeenCalled();
  });

  it("shows a safe refusal when history restore detects a stale live file", async () => {
    const bridge = makeBridge(
      Promise.resolve(null),
      [changeSet("change-stale-revert", 2000, "ice edited notes/today.md")],
    );
    bridge.restoreHistoryFile.mockRejectedValueOnce(
      new Error(
        "Cannot restore notes/today.md because the live file changed since this history item.",
      ),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const historyRail = within(await screen.findByTestId("history-timeline"));
    await user.click(await historyRail.findByTestId("history-change-open"));

    const diffPage = within(await screen.findByTestId("history-diff-page"));
    await user.click(diffPage.getByTestId("history-diff-restore-file"));
    const confirm = within(await screen.findByTestId("history-diff-restore-confirm"));
    await user.click(confirm.getByTestId("history-diff-confirm-restore"));

    expect(
      (await diffPage.findByTestId("history-diff-restore-status")).textContent,
    ).toBe(
      "Cannot restore notes/today.md because the live file changed since this history item.",
    );
    expect(diffPage.queryByTestId("history-diff-undo-restore")).toBeNull();
  });

});
