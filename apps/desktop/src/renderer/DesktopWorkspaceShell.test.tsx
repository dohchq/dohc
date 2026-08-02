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
import { configure } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// These drive userEvent through async UI settles — 67 findBy* awaits across 47
// tests — so the wall-clock profile is the file, not one test (#372).
//
// asyncUtilTimeout is the constraint that actually bit: findBy* rejects on RTL's
// own 1000ms default, so these failed at ~1-3s with "Unable to find
// [data-testid=...]" while the test budget was never reached. Raising testTimeout
// alone fixed nothing here.
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 15_000 });
import type {
  ChatChannelRecord,
  FileChatThreadRecord,
  RefreshSharedViewResult,
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
import {
  chatMentionOpenTarget,
  chatsNavigationRequiresRemount,
  DesktopWorkspaceShell,
  graphChatOpenTarget,
  pendingHeadingTargetForOpen,
  resolveCanonicalDm,
  runCanonicalDmNavigation,
  type Workspace,
} from "./DesktopWorkspaceShell";
import type { ChatsNav } from "./workbench/ChatsView";
import {
  OPEN_EDITORS_DEFAULT_HEIGHT,
  OPEN_EDITORS_MIN_HEIGHT,
} from "./workbench/workbenchState";

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
  chatsVisible: true,
  chatsWidth: 360,
};

Element.prototype.scrollIntoView = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeBridge(uiStatePromise: Promise<WorkspaceUiState | null>) {
  let activityCallback: (() => void) | null = null;
  let searchCallback: ((batch: SearchResultsEvent) => void) | null = null;
  let menuCallback: ((command: MenuCommandId) => void) | null = null;
  return {
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
    // WS-H1: this suite renders the shell as an EXPLICITLY OPTED-OUT
    // workspace (engine off). Post retirement Phase C that means NO history
    // source at all — the rail shows the history-off placeholder. The engine
    // history surface has its own tests (workbench/EngineHistory.test.ts).
    getWorkspaceSettings: vi.fn(async () => ({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        experimental: {
          ...DEFAULT_WORKSPACE_SETTINGS.experimental,
          workspaceEngineAlpha: false,
        },
      },
      source: "stored" as const,
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
    importWorkspaceFiles: vi.fn(async () => ({ imported: ["imported.md"], skipped: 0 })),
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
    createRelayShare: vi.fn(async () => ({
      shareId: "relay-share-1",
      shareCode: "dohc-share:relay-share-1:http://relay.test",
      recipientEmail: "friend@dohc.test",
    })),
    listRelayShares: vi.fn(async () => ({ granted: [] })),
    revokeRelayShare: vi.fn(async () => undefined),
    openSharedView: vi.fn(async () => {
      throw new Error("not used in shell tests");
    }),
    // Typed to the contract, not to this one default: a test that drives a
    // real pull ("updated") must be able to swap the implementation.
    refreshSharedView: vi.fn(
      async (): Promise<RefreshSharedViewResult> => ({
        status: "unchanged",
        changedPaths: 0,
      }),
    ),
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

// Engine-flagged variant: the same bridge with the workspace-engine alpha on
// plus the minimal engine/chats IPC surface the flagged shell touches on
// mount (empty history, no try-session, Main only, no chats yet).
function makeEngineBridge(uiStatePromise: Promise<WorkspaceUiState | null>) {
  const bridge = makeBridge(uiStatePromise);
  bridge.getWorkspaceSettings = vi.fn(async () => ({
    settings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      experimental: {
        ...DEFAULT_WORKSPACE_SETTINGS.experimental,
        workspaceEngineAlpha: true,
      },
    },
    source: "stored" as const,
  }));
  return Object.assign(bridge, {
    listEngineMoments: vi.fn(async () => ({
      moments: [],
      nextBeforeMomentOrder: null,
      latestMomentOrder: 0,
    })),
    getTryInVersionState: vi.fn(async () => ({ state: null })),
    listWorkspaceVersions: vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
      ],
      activeVersionId: "main",
    })),
    listChatChannels: vi.fn(
      async (): Promise<{
        channels: ChatChannelRecord[];
        fileThreads: FileChatThreadRecord[];
      }> => ({ channels: [], fileThreads: [] }),
    ),
    listChannelThreads: vi.fn(async () => ({ threads: [] })),
    listChatChannelShares: vi.fn(async () => {
      // Sharing is optional; ChatsView downgrades a rejection to "none".
      throw new Error("sharing unavailable in shell tests");
    }),
    syncDms: vi.fn(async () => ({ available: false, dms: [] })),
    listFileChats: vi.fn(async () => ({ fileObjectId: null, threads: [] })),
  });
}

function renderShell(
  bridge: ReturnType<typeof makeBridge>,
  workspace: Workspace = WORKSPACE,
) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(
    <DesktopWorkspaceShell
      workspace={workspace}
      workspaces={[workspace]}
      onSwitchWorkspace={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("targeted chat navigation", () => {
  const threadNav = (threadId: string, focusMessageId?: string): ChatsNav => ({
    level: "thread",
    channel: {
      id: "channel-1",
      name: "general",
      slug: "general",
      kind: "channel",
      createdAtMs: 0,
      updatedAtMs: 0,
      threadCount: 1,
      unreadCount: 0,
    },
    thread: {
      id: threadId,
      channelId: "channel-1",
      title: "Discussion",
      createdAtMs: 0,
      updatedAtMs: 0,
      messageCount: 2,
      lastReadSequence: 0,
      unreadCount: 0,
    },
    ...(focusMessageId ? { focusMessageId } : {}),
  });

  it("remounts the live chat for a message backlink inside the current thread", () => {
    expect(
      chatsNavigationRequiresRemount(
        threadNav("thread-1", "message-1"),
        threadNav("thread-1", "message-2"),
      ),
    ).toBe(true);
    expect(
      chatsNavigationRequiresRemount(
        threadNav("thread-1", "message-1"),
        threadNav("thread-1"),
      ),
    ).toBe(false);
  });

  it("keeps metadata-light file mentions and graph chats on their known file thread", () => {
    const thread = {
      id: "thread-file",
      title: "File discussion",
      createdAtMs: 10,
      updatedAtMs: 20,
    };
    const mentionTarget = chatMentionOpenTarget({
      attachment: {
        attachmentId: "attachment-1",
        messageId: "message-1",
        threadId: thread.id,
        targetKind: "file",
        objectId: "object-1",
        pathHint: "docs/plan.md",
        createdAtMs: 10,
      },
      message: {
        id: "message-1",
        threadId: thread.id,
        authorKind: "human",
        authorDisplayName: "Ice",
        body: "See the plan",
        createdAtMs: 10,
      },
      thread,
    });
    expect(mentionTarget).toEqual({
      surface: "file",
      thread,
      focusMessageId: "message-1",
    });

    expect(graphChatOpenTarget({
      path: `chat-thread:${thread.id}`,
      kind: "chat-thread",
      threadId: thread.id,
      title: thread.title,
      incoming: 1,
      outgoing: 0,
    })).toEqual({
      surface: "file",
      thread: { ...thread, createdAtMs: 0, updatedAtMs: 0 },
    });
  });

  it("keeps full channel metadata on targeted tab navigation", () => {
    const target = graphChatOpenTarget({
      path: "chat-thread:thread-channel",
      kind: "chat-thread",
      threadId: "thread-channel",
      channelId: "channel-1",
      channelName: "planning",
      channelSlug: "planning",
      channelKind: "channel",
      title: "Planning discussion",
      incoming: 1,
      outgoing: 0,
    });

    expect(target.surface).toBe("channel");
    if (target.surface === "channel") {
      expect(target.nav.level).toBe("thread");
      expect(target.nav.channel.id).toBe("channel-1");
      expect(target.nav.thread.id).toBe("thread-channel");
    }

    const mentionTarget = chatMentionOpenTarget({
      attachment: {
        attachmentId: "attachment-channel",
        messageId: "message-channel",
        threadId: "thread-channel",
        targetKind: "file",
        createdAtMs: 0,
      },
      message: {
        id: "message-channel",
        threadId: "thread-channel",
        authorKind: "agent",
        authorDisplayName: "Ice",
        body: "Updated the plan",
        createdAtMs: 0,
      },
      thread: {
        id: "thread-channel",
        title: "Planning discussion",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      channelId: "channel-1",
      channelName: "planning",
    });
    expect(mentionTarget.surface).toBe("channel");
    if (mentionTarget.surface === "channel") {
      expect(mentionTarget.nav.thread.id).toBe("thread-channel");
      expect(mentionTarget.nav.focusMessageId).toBe("message-channel");
    }
  });

  it("routes DM mentions and graph nodes only through a matching canonical DM", () => {
    const dm = {
      channelId: "dm-local",
      channelWireId: "dm-wire",
      name: "alice@example.com",
      peerLabel: "Alice",
      role: "owner" as const,
      shareId: null,
      threadId: "dm-thread",
      unreadCount: 1,
      connected: true,
    };
    const mentionTarget = chatMentionOpenTarget({
      attachment: {
        attachmentId: "attachment-dm",
        messageId: "message-dm",
        threadId: "dm-thread",
        targetKind: "file",
        createdAtMs: 0,
      },
      message: {
        id: "message-dm",
        threadId: "dm-thread",
        authorKind: "human",
        authorDisplayName: "Alice",
        body: "DM attachment",
        createdAtMs: 0,
      },
      thread: {
        id: "dm-thread",
        title: "Direct message",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      channelId: "dm-local",
      channelWireId: "dm-wire",
      channelName: "alice@example.com",
      channelKind: "dm",
    });
    expect(mentionTarget).toEqual({
      surface: "dm",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      threadId: "dm-thread",
      focusMessageId: "message-dm",
    });
    if (mentionTarget.surface !== "dm") throw new Error("Expected DM target");
    expect(resolveCanonicalDm(mentionTarget, [dm])).toEqual(dm);
    expect(resolveCanonicalDm({ ...mentionTarget, threadId: "other-thread" }, [dm]))
      .toBeNull();
    expect(resolveCanonicalDm({ ...mentionTarget, channelWireId: "other-wire" }, [dm]))
      .toBeNull();

    expect(graphChatOpenTarget({
      path: "chat-thread:dm-thread",
      kind: "chat-thread",
      threadId: "dm-thread",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      channelName: "alice@example.com",
      channelKind: "dm",
      title: "Direct message",
      incoming: 1,
      outgoing: 0,
    })).toEqual({
      surface: "dm",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      threadId: "dm-thread",
    });
  });

  it("preserves a DM mention message target through canonical navigation", async () => {
    const dm = {
      channelId: "dm-local",
      channelWireId: "dm-wire",
      name: "alice@example.com",
      peerLabel: "Alice",
      role: "owner" as const,
      shareId: null,
      threadId: "dm-thread",
      unreadCount: 0,
      connected: true,
    };
    const open = vi.fn();

    await runCanonicalDmNavigation({
      locator: {
        channelId: dm.channelId,
        channelWireId: dm.channelWireId,
        threadId: dm.threadId,
        focusMessageId: "message-dm",
      },
      syncDms: async () => ({ available: true, dms: [dm] }),
      isCurrent: () => true,
      open,
    });

    expect(open).toHaveBeenCalledWith({
      level: "dm",
      dm,
      focusMessageId: "message-dm",
    });
    expect(
      chatsNavigationRequiresRemount(
        { level: "dm", dm, focusMessageId: "message-old" },
        { level: "dm", dm, focusMessageId: "message-dm" },
      ),
    ).toBe(true);
  });

  it("opens an existing local DM when new-DM creation is unavailable", async () => {
    const dm = {
      channelId: "dm-local",
      channelWireId: "dm-wire",
      name: "alice@example.com",
      peerLabel: "Alice",
      role: "owner" as const,
      shareId: null,
      threadId: "dm-thread",
      unreadCount: 0,
      connected: false,
    };
    const open = vi.fn();

    await runCanonicalDmNavigation({
      locator: {
        channelId: dm.channelId,
        channelWireId: dm.channelWireId,
        threadId: dm.threadId,
      },
      syncDms: async () => ({ available: false, dms: [dm] }),
      isCurrent: () => true,
      open,
    });

    expect(open).toHaveBeenCalledWith({ level: "dm", dm });
  });

  it("does not reopen Chats when destination navigation supersedes a delayed DM lookup", async () => {
    const delayed = deferred<{
      available: boolean;
      dms: Array<{
        channelId: string;
        channelWireId: string;
        name: string;
        peerLabel: string;
        role: "owner";
        shareId: null;
        threadId: string;
        unreadCount: number;
        connected: boolean;
      }>;
    }>();
    let current = true;
    const open = vi.fn();
    const pending = runCanonicalDmNavigation({
      locator: {
        channelId: "dm-local",
        channelWireId: "dm-wire",
        threadId: "dm-thread",
      },
      syncDms: () => delayed.promise,
      isCurrent: () => current,
      open,
    });

    // Models the centralized workbench mutation invalidation used by file,
    // graph, history, and arbitrary editor-tab navigation.
    current = false;
    delayed.resolve({
      available: true,
      dms: [{
        channelId: "dm-local",
        channelWireId: "dm-wire",
        name: "alice@example.com",
        peerLabel: "Alice",
        role: "owner",
        shareId: null,
        threadId: "dm-thread",
        unreadCount: 0,
        connected: true,
      }],
    });
    await pending;
    expect(open).not.toHaveBeenCalled();
  });

  it("clears stale chat navigation to channels when DM canonicalization fails", async () => {
    const open = vi.fn();
    const base = {
      locator: { channelId: "dm-local", threadId: "dm-thread" },
      isCurrent: () => true,
      open,
    };
    await runCanonicalDmNavigation({
      ...base,
      syncDms: async () => ({ available: true, dms: [] }),
    });
    expect(open).toHaveBeenLastCalledWith({ level: "channels" });

    open.mockClear();
    await runCanonicalDmNavigation({
      ...base,
      syncDms: async () => {
        throw new Error("offline");
      },
    });
    expect(open).toHaveBeenLastCalledWith({ level: "channels" });
  });
});

describe("heading-target file opens", () => {
  it("clears a prior section command on an ordinary open", () => {
    expect(
      pendingHeadingTargetForOpen("a.md", { anchor: "old-section", nonce: 1 }),
    ).toEqual({
      path: "a.md",
      target: { anchor: "old-section", nonce: 1 },
    });
    expect(pendingHeadingTargetForOpen("a.md")).toBeNull();
  });
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

  // Journey 2 (#337): rolling back a rename left `assets/alpha-renamed.png`
  // in Open Editors for a path that no longer existed — through a restart,
  // because nothing reconciled the restored tabs against the workspace.
  it("restores only the tabs whose files still exist", async () => {
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["assets/alpha-renamed.png", "b.md"],
        activeTab: "b.md",
      }),
    );
    renderShell(bridge);

    // b.md is in the listing; the rolled-back path is not.
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("tab-assets/alpha-renamed.png")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");

    // And the ghost does not come back on the next launch.
    await waitFor(() => {
      const states = bridge.setWorkspaceUiState.mock.calls.map(
        ([payload]) => payload.state,
      );
      expect(states.some((state) => state.tabs.join() === "b.md")).toBe(true);
    });
  });

  // A shared workspace lists its files TWICE on open: once at mount, once
  // after refreshShareView pulls the changed paths. Reconciling against
  // whichever landed first would either miss a remote delete or judge the
  // restored tabs against a pre-pull snapshot.
  it("prunes a restored tab on a listing that lands after the share pull", async () => {
    const listing = (...paths: string[]) =>
      vi.fn(async () => ({
        files: paths.map((path) => ({ path, kind: "file" as const })),
        folders: [] as string[],
      }));
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "shared-gone.md"],
        activeTab: "b.md",
      }),
    );
    // The pre-pull listing still carries the file the granter deleted.
    bridge.listWorkspaceFiles = listing("a.md", "b.md", "shared-gone.md");
    const pull = deferred<RefreshSharedViewResult>();
    bridge.refreshSharedView = vi.fn(() => pull.promise);
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
    });

    // It survives that listing: nothing has said the file is gone yet.
    expect(await screen.findByTestId("tab-shared-gone.md")).toBeTruthy();

    // The pull lands, and the listing it triggers no longer has the file.
    bridge.listWorkspaceFiles = listing("a.md", "b.md");
    await act(async () => {
      pull.resolve({ status: "updated", changedPaths: 1 });
      await pull.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("tab-shared-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  // The scoping earns its keep here: only stored tabs are eligible, so a
  // listing that raced a create cannot close what the user just opened.
  it("never prunes a tab opened this session, whatever a later listing says", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    // b.md is restored; a.md is opened now.
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    fireEvent.click(await screen.findByText("a.md"));
    expect(await screen.findByTestId("tab-a.md")).toBeTruthy();

    // A listing that knows about neither file arrives.
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: [] as Array<{ path: string; kind: "file" }>,
      folders: [] as string[],
    }));
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("tab-b.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
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
    expect((await screen.findByTestId("side-panel")).style.width).toBe("320px");
    // chatsVisible is stored true, but this workspace is engine-off: the
    // Chats panel (and its titlebar toggle) must not exist at all.
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    expect(screen.queryByTestId("titlebar-chats-sidebar")).toBeNull();
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
  it("opens the relay share dialog for the active inspector path and returns a code", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("a.md")).toBeTruthy();

    await user.type(within(dialog).getByTestId("share-email"), "friend@dohc.test");
    await user.click(within(dialog).getByTestId("share-create"));

    const codeElement = await within(dialog).findByTestId("share-code");
    expect(codeElement.textContent).toBe("dohc-share:relay-share-1:http://relay.test");
    expect(bridge.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
      recipientEmail: "friend@dohc.test",
      paths: ["a.md"],
    });
  });
});

describe("content search", () => {
  // Journey 1 (#337): queries arrived with their leading characters missing
  // ("MBERDRAFT-8831" for "EMBERDRAFT-8831"). The panel opened, but the input
  // only mounted when a lazy chunk resolved, so everything typed in that gap
  // went to the activity-bar button the user had just clicked.
  it("mounts the focused input in the same commit that opens the panel", () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    // No awaits: nothing can resolve a pending import between the click and
    // the first keystroke, which is exactly the user's situation.
    act(() => {
      fireEvent.click(screen.getByTestId("activity-search"));
    });

    const input = screen.getByTestId("search-input");
    expect(document.activeElement).toBe(input);
  });

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
  it("opens history as a full editor tab showing the history-off placeholder for an opted-out workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("history-open-tab"));

    const historyTab = await screen.findByTestId("tab-dohc://history");
    expect(historyTab.dataset.active).toBe("true");
    const page = await screen.findByTestId("history-page");
    // Retirement Phase C: an opted-out workspace has no history source; the
    // page says so instead of rendering an empty timeline.
    expect(
      within(page).getByTestId("history-off-placeholder").textContent,
    ).toContain("History is off for this workspace");
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

  it("caps the open editors list height so it scrolls instead of growing unbounded", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
    await user.click(rowA);
    await screen.findByTestId("tab-a.md");

    // The list is bounded and scrolls internally (VS Code-style Open Editors)
    // instead of growing without limit as more editors open. The scroll-to-
    // active behavior needs real layout and is covered by the desktop e2e
    // spec (workspace-open-editors.spec.ts).
    const list = screen.getByTestId("open-editors-list");
    expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_DEFAULT_HEIGHT}px`);
    expect(list.className).toContain("overflow-y-auto");
  });

  it("resizes the open editors section by dragging its bottom edge", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
    await user.click(rowA);
    await screen.findByTestId("tab-a.md");

    const list = screen.getByTestId("open-editors-list");
    const handle = screen.getByTestId("open-editors-resize");
    // A non-left press must not start a resize.
    fireEvent.pointerDown(handle, {
      button: 2,
      buttons: 2,
      clientY: 200,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle, { buttons: 2, clientY: 500 });
    expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_DEFAULT_HEIGHT}px`);

    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      clientY: 200,
      pointerId: 1,
    });
    // The one-item list is shorter than its cap; a zero-delta move must
    // preserve the saved cap.
    fireEvent.pointerMove(handle, { buttons: 1, clientY: 200 });
    expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_DEFAULT_HEIGHT}px`);

    fireEvent.pointerMove(handle, { buttons: 1, clientY: 374 });
    await waitFor(() => {
      expect(list.style.maxHeight).toBe("300px");
    });

    // Dragging far above the list clamps at the minimum height.
    fireEvent.pointerMove(handle, { buttons: 1, clientY: 0 });
    await waitFor(() => {
      expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_MIN_HEIGHT}px`);
    });
  });

  it("clamps the rendered open editors height to the viewport", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const original = window.innerHeight;
    try {
      const user = userEvent.setup();
      renderShell(makeBridge(Promise.resolve(null)));

      const treeRows = await screen.findAllByTestId("tree-row");
      const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
      await user.click(rowA);
      await screen.findByTestId("tab-a.md");

      const list = screen.getByTestId("open-editors-list");
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: 150,
      });
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(list.style.maxHeight).toBe("90px"));

      const handle = screen.getByTestId("open-editors-resize");
      fireEvent.pointerDown(handle, {
        button: 0,
        buttons: 1,
        clientY: 100,
        pointerId: 1,
      });
      fireEvent.pointerMove(handle, { buttons: 1, clientY: 200 });
      expect(list.style.maxHeight).toBe("90px");

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: 768,
      });
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(list.style.maxHeight).toBe("190px"));
    } finally {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: original,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });
});

describe("chats panel (right side)", () => {
  it("never renders a right panel (or a collapsed stub) for an engine-off workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await screen.findByText("a.md");
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    expect(screen.queryByTestId("titlebar-chats-sidebar")).toBeNull();
    // The old history rail is gone for good — no timeline, no restore stub.
    expect(screen.queryByTestId("history-timeline")).toBeNull();
    expect(screen.queryByTestId("history-restore")).toBeNull();
  });

  it("toggles from the titlebar and hides entirely when collapsed", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    // Hidden by default (VS Code secondary-sidebar grammar).
    await screen.findByText("a.md");
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    expect(screen.queryByTestId("activity-chats")).toBeNull();

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();

    await user.click(screen.getByTestId("chats-panel-collapse"));
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    // Collapsed means GONE — no 36px stub squatting on the right edge.
    expect(screen.queryByTestId("history-restore")).toBeNull();

    await user.click(screen.getByTestId("titlebar-chats-sidebar"));
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
  });

  it("keeps the navigator open and switches the editor between channels", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listChatChannels.mockResolvedValue({
      channels: [
        {
          id: "channel-1",
          name: "general",
          slug: "general",
          kind: "channel" as const,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          threadCount: 0,
          unreadCount: 0,
        },
        {
          id: "channel-2",
          name: "random",
          slug: "random",
          kind: "channel" as const,
          createdAtMs: 1_700_000_000_001,
          updatedAtMs: 1_700_000_000_001,
          threadCount: 0,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    const panel = await screen.findByTestId("chats-panel");
    const channelButtons = within(panel).getAllByTestId("chats-channel");
    await user.click(channelButtons[0]!);

    const channelView = await screen.findByTestId("chats-channel-view");
    expect(channelView.dataset.variant).toBe("page");
    expect(channelButtons).toHaveLength(2);
    await waitFor(() => expect(channelButtons[0]?.dataset.active).toBe("true"));
    expect(bridge.listChannelThreads).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      channelId: "channel-1",
    });

    await user.click(channelButtons[1]!);
    await waitFor(() => {
      expect(screen.getByTestId("chats-channel-title").textContent).toBe("random");
    });
    expect(screen.getByTestId("chats-panel")).toBeTruthy();
    expect(channelButtons[1]?.dataset.active).toBe("true");
    expect(bridge.listChannelThreads).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      channelId: "channel-2",
    });
  });

  it("keeps both shared-view Chats mounts read-only", async () => {
    const bridge = makeEngineBridge(Promise.resolve(STORED_STATE));
    const startChannelThread = vi.fn();
    Object.assign(bridge, { startChannelThread });
    const sharedWorkspace: Workspace = {
      ...WORKSPACE,
      shareView: {
        shareId: "share-view-1",
        granterEmail: "owner@example.com",
      },
    };
    bridge.listChatChannels.mockResolvedValue({
      channels: [
        {
          id: "channel-1",
          wireId: "wire-1",
          name: "general",
          slug: "general",
          kind: "channel",
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          threadCount: 0,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    });
    bridge.listFileChats.mockResolvedValue({
      fileObjectId: null,
      threads: [],
    });
    const user = userEvent.setup();
    renderShell(bridge, sharedWorkspace);

    const panel = await screen.findByTestId("chats-panel");
    expect(
      await within(panel).findByTestId("chats-workspace-readonly-note"),
    ).toBeTruthy();
    expect(within(panel).queryByTestId("chats-new-channel")).toBeNull();
    expect(within(panel).queryByTestId("chats-channel-follow")).toBeNull();
    expect(bridge.syncDms).not.toHaveBeenCalled();

    await user.click(within(panel).getByTestId("chats-channel"));
    const page = await screen.findByTestId("chats-channel-view");
    expect(page.dataset.variant).toBe("page");
    expect(within(page).getByTestId("chats-readonly-note")).toBeTruthy();
    expect(within(page).queryByTestId("chats-new-thread-composer")).toBeNull();
    expect(within(page).queryByTestId("chats-share-channel")).toBeNull();
    expect(startChannelThread).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("tab-b.md"));
    await user.click(within(panel).getByTestId("chats-panel-tab-file"));
    expect(
      await within(panel).findByTestId("linked-chat-readonly-note"),
    ).toBeTruthy();
    expect(within(panel).queryByTestId("linked-chat-new")).toBeNull();
  });

  it("restores the stored width and can be resized from its left edge", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeEngineBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    const panel = await screen.findByTestId("chats-panel");
    expect(panel.style.width).toBe("360px");
    Object.defineProperty(panel, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 640,
        y: 0,
        left: 640,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 360,
        height: 800,
        toJSON: () => {},
      }),
    });

    const handle = screen.getByTestId("chats-panel-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 100 });

    await waitFor(() => {
      expect(panel.style.width).toBe("900px");
    });
  });

  it("the 'This file' tab shows the active file's chats surface", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    await screen.findByTestId("chats-panel");
    await user.click(screen.getByTestId("chats-panel-tab-file"));

    // No file open yet: the linked-chats surface says so honestly.
    expect(
      (await screen.findByTestId("linked-chats-empty")).textContent,
    ).toContain("No file open");
  });
});

describe("file transfers", () => {
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
    bridge.showWorkbenchMenu.mockResolvedValue("open-history");
    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "status",
      });
    });
    // The command lands: the History view becomes the active rail entry.
    await waitFor(() => {
      expect(
        screen.getByTestId("activity-history").getAttribute("aria-current"),
      ).toBe("page");
    });
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

  it("opens settings from the status bar context menu", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("settings");
    renderShell(bridge);

    fireEvent.contextMenu(await screen.findByTestId("status-workspace"));

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
