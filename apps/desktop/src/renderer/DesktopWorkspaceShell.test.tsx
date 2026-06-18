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
  ShowWorkbenchMenuResult,
  WorkspaceUiState,
} from "../ipc/bridgeContract";
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
  return {
    setChangeSets: (next: ChangeSetRecord[]) => {
      changeSets = next;
    },
    emitWorkspaceActivity: () => activityCallback?.(),
    getWorkspaceUiState: vi.fn(() => uiStatePromise),
    setWorkspaceUiState: vi.fn(
      async (_payload: { workspaceId: string; state: WorkspaceUiState }) => undefined,
    ),
    listWorkspaceFiles: vi.fn(async () => ({
      files: [
        { path: "a.md", kind: "file" as const },
        { path: "b.md", kind: "file" as const },
      ],
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
    importWorkspaceFiles: vi.fn(async () => ({ imported: ["imported.md"] })),
    exportWorkspaceZip: vi.fn(async () => ({ path: "/tmp/workspace.zip" })),
    showWorkbenchMenu: vi.fn(async (): Promise<ShowWorkbenchMenuResult> => null),
    getDroppedFilePaths: vi.fn(() => []),
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
    onSearchResults: vi.fn(() => () => {}),
    searchWorkspace: vi.fn(async () => undefined),
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
});

describe("imports and exports", () => {
  it("opens the import/export panel from the explorer footer", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("import-export-open"));

    const dialog = await screen.findByTestId("import-export-dialog");
    expect(within(dialog).getByText("Import / export")).toBeTruthy();
    await user.click(within(dialog).getByTestId("export-workspace-action"));
    await waitFor(() => {
      expect(bridge.exportWorkspaceZip).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
      });
    });
  });
});

describe("native workbench context menus", () => {
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
