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
  AgentRunStatusResult,
  ChatChannelRecord,
  DmRecord,
  EngineMomentRecord,
  FileChatThreadRecord,
  ListEngineMomentsResult,
  ListWorkspaceVersionsResult,
  McpConfigResult,
  RefreshSharedViewResult,
  StartAgentRunResult,
  SwitchWorkspaceVersionResult,
  TryInVersionStateResult,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuResult,
  UpdateStateEvent,
  WorkspaceSearchPayload,
  WorkspaceUiState,
} from "../ipc/bridgeContract";
import type { MenuCommandId, SearchResultsEvent } from "../ipc/channels";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettingsResult,
} from "../workspaces/workspaceSettings";
import { rendererMarks } from "../performance/rendererMarks";
import {
  chatMentionOpenTarget,
  chatsNavigationChangesDestination,
  chatsNavigationLeavesConversation,
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
  CHATS_TAB_PATH,
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
  // Required on the contract (#505, #540): every status states whether the
  // recorder failed to build and whether the workspace is a shared view. This
  // fake is not type-checked against SyncStatusResult, so it declares the
  // causes by hand rather than shipping a payload main could never produce.
  historyRecordingUnavailable: false,
  historyShareView: false,
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

// One canonical DM, as the graph node a click starts a navigation from and as
// the record syncDms answers with.
const DM_GRAPH_NODE = {
  path: "chat-thread:dm-thread",
  kind: "chat-thread" as const,
  threadId: "dm-thread",
  channelId: "dm-local",
  channelWireId: "dm-wire",
  channelName: "alice@example.com",
  channelKind: "dm" as const,
  title: "Direct message",
  incoming: 1,
  outgoing: 0,
};

const CANONICAL_DM: DmRecord = {
  channelId: "dm-local",
  channelWireId: "dm-wire",
  name: "alice@example.com",
  peerLabel: "Alice",
  role: "owner",
  shareId: null,
  threadId: "dm-thread",
  unreadCount: 1,
  connected: true,
};

Element.prototype.scrollIntoView = vi.fn();

// The dirty-draft test types into the real markdown editor, which needs the
// same two globals jsdom lacks that FileInspector.test.tsx stubs.
vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
for (const method of ["getClientRects", "getBoundingClientRect"] as const) {
  Object.defineProperty(Range.prototype, method, {
    configurable: true,
    value: () =>
      method === "getClientRects"
        ? []
        : {
            bottom: 0,
            height: 0,
            left: 0,
            right: 0,
            top: 0,
            width: 0,
            x: 0,
            y: 0,
            toJSON: () => {},
          },
  });
}

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
    // Typed to the contract, not to this idle default: a freshness test drives
    // a real running agent through it.
    getAgentRunStatus: vi.fn(
      async (): Promise<AgentRunStatusResult> => ({
        mcpEnabled: false,
        activeRun: null,
        lastRun: null,
      }),
    ),
    getMcpConfig: vi.fn(async (): Promise<McpConfigResult> => ({
      command: "dohc-mcp",
      args: ["--workspace", WORKSPACE.rootPath, "--home", "/tmp/dohc-home"],
      workspacePath: WORKSPACE.rootPath,
      home: "/tmp/dohc-home",
    })),
    // The Settings agent toggle reaches these. Typed to the contract, because
    // a test that drives the toggle has to be able to swap them.
    startAgentRun: vi.fn(
      async (): Promise<StartAgentRunResult> => ({
        id: "run-1",
        startedAt: 1,
        agentId: "agent-1",
        onBehalfOf: "ice",
        status: "running",
      }),
    ),
    endAgentRun: vi.fn(async (): Promise<void> => undefined),
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
    getWorkspaceSettings: vi.fn(async (): Promise<WorkspaceSettingsResult> => ({
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
  bridge.getWorkspaceSettings = vi.fn(async (): Promise<WorkspaceSettingsResult> => ({
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
    // Typed to the contract, not to this empty default: a test that drives
    // real pages must be able to swap the implementation.
    listEngineMoments: vi.fn(
      async (): Promise<ListEngineMomentsResult> => ({
        moments: [],
        nextBeforeMomentOrder: null,
        latestMomentOrder: 0,
        activeVersionId: "main",
      }),
    ),
    // Typed to the contract, not to these empty defaults: the freshness tests
    // drive a real review card and a real version switch through them.
    getTryInVersionState: vi.fn(
      async (): Promise<TryInVersionStateResult> => ({ state: null }),
    ),
    dismissTryInVersionReview: vi.fn(async (): Promise<void> => undefined),
    switchWorkspaceVersion: vi.fn(
      async (): Promise<SwitchWorkspaceVersionResult> => ({
        activeVersionId: "main",
        changedFileCount: 0,
      }),
    ),
    // Typed to the contract as well: a workspace with only Main is this
    // default, not the shape every test is allowed to report.
    listWorkspaceVersions: vi.fn(
      async (): Promise<ListWorkspaceVersionsResult> => ({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main",
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
        ],
        activeVersionId: "main",
      }),
    ),
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

  // Two keys, two purposes. Cancelling a pending DM lookup asks "did the user
  // go somewhere?", and a focused message is somewhere. Scoping drafts asks
  // the narrower "did they leave the conversation?", because the draft they
  // typed there must survive a jump inside it.
  it("separates leaving a conversation from going somewhere inside it", () => {
    const focused = threadNav("thread-1", "message-1");
    const otherMessage = threadNav("thread-1", "message-2");
    const otherThread = threadNav("thread-2");

    // A backlink to another message in the open thread: going somewhere...
    expect(chatsNavigationChangesDestination(focused, otherMessage)).toBe(true);
    // ...without leaving the conversation, so the draft stays.
    expect(chatsNavigationLeavesConversation(focused, otherMessage)).toBe(false);

    // Another conversation is both.
    expect(chatsNavigationChangesDestination(focused, otherThread)).toBe(true);
    expect(chatsNavigationLeavesConversation(focused, otherThread)).toBe(true);

    // The panel re-reporting where it already is, is neither.
    expect(
      chatsNavigationChangesDestination(focused, threadNav("thread-1", "message-1")),
    ).toBe(false);
    expect(chatsNavigationLeavesConversation(focused, focused)).toBe(false);
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

  // P1: closing a DIRTY tab unmounts the inspector mid-draft, and its cleanup
  // flushes best-effort to a path that no longer exists. resolveWorkspaceFile
  // requires the file, the write fails, the failure is swallowed — the draft
  // would be gone with no error and no way back.
  it("never closes a restored tab with an unsaved draft, and closes it once saved", async () => {
    const listing = (...paths: string[]) => ({
      files: paths.map((path) => ({ path, kind: "file" as const })),
      folders: [] as string[],
    });
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve({ ...STORED_STATE, tabs: ["a.md"], activeTab: "a.md" }),
    );
    renderShell(bridge);

    // Type into the restored tab's document without letting it settle.
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(await screen.findByTestId("markdown-editor"), "Draft!");
    await screen.findByTestId("tab-dirty");
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();

    // The file disappears from the workspace while that draft is unsaved.
    bridge.listWorkspaceFiles = vi.fn(async () => listing("b.md"));
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });

    // The tab stays open, so the draft still has somewhere to live.
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-dirty")).toBeTruthy();

    // Once the draft settles, the deferred close completes.
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByTestId("tab-a.md")).toBeNull();
    });
  }, 20_000);

  // A provisional display-fill must not drive a destructive close: the pull
  // still in flight can carry back a file the older listing predates.
  it("defers closing a tab while a newer listing is still pending", async () => {
    const older = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    const newer = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "pulled.md"],
        activeTab: "b.md",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() =>
      ++issued === 1 ? older.promise : newer.promise,
    );
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The older listing lands first and does not know about pulled.md.
    await act(async () => {
      older.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await older.promise;
    });
    // It fills the display, but must not close anything: a newer answer is
    // still coming.
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();

    // The newer one carries the file back.
    await act(async () => {
      newer.resolve({
        files: [
          { path: "b.md", kind: "file" },
          { path: "pulled.md", kind: "file" },
        ],
        folders: [],
      });
      await newer.promise;
    });
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();
    expect(screen.getAllByText("pulled.md").length).toBeGreaterThan(0);
  });

  // Closing the ACTIVE tab remounts the keyed inspector on its neighbour —
  // an open. Without the mark, that mount measure brackets a stale mark.
  it("marks file-open-start when closing the active tab hands over to a survivor", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "gone.md"],
        activeTab: "gone.md",
      }),
    );
    renderShell(bridge);

    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => name === "file-open-start").length;

    // Wait for the RESTORE to land first, or the assertions below pass
    // vacuously against the empty default state.
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
    });
    expect(openStartCalls()).toBe(1);

    mark.mockRestore();
  });

  // A failure is not an answer, so it cannot make an older snapshot
  // authoritative for CLOSING: the listing that failed may have been the one
  // that would have shown a file pulled back in. The close waits for a
  // success issued after the failure. It is not blocked forever — the next
  // successful listing re-enables it — and correctness beats eagerness for
  // work that cannot be undone.
  it("waits for a listing that succeeds after a failure before closing", async () => {
    const older = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failNewer!: (error: Error) => void;
    const newer = new Promise<never>((_resolve, reject) => {
      failNewer = reject;
    });
    const third = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "gone.md"],
        activeTab: "b.md",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() => {
      issued += 1;
      return issued === 1 ? older.promise : issued === 2 ? newer : third.promise;
    });
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The older listing commits, but a newer request is still in flight.
    await act(async () => {
      older.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await older.promise;
    });
    expect(await screen.findByTestId("tab-gone.md")).toBeTruthy();

    // The newer request fails. Everything has settled now, but that failure
    // could have been the listing that would have shown the file pulled back
    // in, so the older snapshot cannot authorise a close.
    await act(async () => {
      failNewer(new Error("listing failed"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("tab-gone.md")).toBeTruthy();

    // A listing issued after the failure answers, and still does not have the
    // file. Now the close is authorised.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(3));
    await act(async () => {
      third.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await third.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  // Codex's scenario: the pull brings a file BACK, and the listing that would
  // have shown it is the one that failed. Closing on the pre-pull snapshot
  // would close a tab whose file exists.
  it("does not close on a pre-pull snapshot when the post-pull listing failed", async () => {
    const prePull = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failPostPull!: (error: Error) => void;
    const postPull = new Promise<never>((_resolve, reject) => {
      failPostPull = reject;
    });
    const afterPull = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let issued = 0;
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "pulled.md"],
        activeTab: "b.md",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() => {
      issued += 1;
      return issued === 1
        ? prePull.promise
        : issued === 2
          ? postPull
          : afterPull.promise;
    });
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The pre-pull snapshot commits; it predates the file coming back.
    await act(async () => {
      prePull.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await prePull.promise;
    });
    // The listing that would have carried the pulled file fails.
    await act(async () => {
      failPostPull(new Error("listing failed"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();

    // A later listing confirms the file is really there. Still no close.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(3));
    await act(async () => {
      afterPull.resolve({
        files: [
          { path: "b.md", kind: "file" },
          { path: "pulled.md", kind: "file" },
        ],
        folders: [],
      });
      await afterPull.promise;
    });
    expect(screen.getByTestId("tab-pulled.md")).toBeTruthy();
  });

  // CodeRabbit: reconciling commits through the direct setter (it must not set
  // the touched flag), which also skips mutateWb's DM-navigation invalidation.
  // A DM navigation in flight would then still pass its isCurrent() check and
  // land its destination on top of the tab the close just activated.
  it("discards an in-flight DM navigation when closing a tab moves the active tab", async () => {
    const dmNode = {
      path: "chat-thread:dm-thread",
      kind: "chat-thread" as const,
      threadId: "dm-thread",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      channelName: "alice@example.com",
      channelKind: "dm" as const,
      title: "Direct message",
      incoming: 1,
      outgoing: 0,
    };
    const listing = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    const sync = deferred<{ available: boolean; dms: never[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "gone.md"],
        activeTab: "gone.md",
      }),
    );
    // The listing is held so the close cannot happen before the navigation.
    bridge.listWorkspaceFiles = vi.fn(() => listing.promise);
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [dmNode],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === dmNode.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Now the listing lands without the active tab's file, so the close runs
    // and hands over to the survivor.
    await act(async () => {
      listing.resolve({ files: [{ path: "b.md", kind: "file" }], folders: [] });
      await listing.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");

    // The navigation answers late. It is stale, so it must not open Chats
    // over the tab the close just activated.
    await act(async () => {
      sync.resolve({ available: true, dms: [] });
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-${CHATS_TAB_PATH}`)).toBeNull();
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
  }, 20_000);

  // The same invalidation from the other side: mutateWb is THE seam every
  // user-driven transition routes through, so a file click has to cancel a
  // pending DM navigation. It incremented the pending request in place, and
  // since the navigation holds that very object, its isCurrent() compared the
  // object against itself and the cancellation did nothing.
  it("discards an in-flight DM navigation when the user opens a file", async () => {
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, { path: "a.md", title: "A", incoming: 0, outgoing: 0 }],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // The user goes somewhere else: opening a file is a plain mutateWb
    // transition, which is what must cancel the navigation.
    const afterNav = await screen.findAllByTestId("graph-file-row");
    await user.click(afterNav.find((row) => row.dataset.path === "a.md")!);
    expect((await screen.findByTestId("tab-a.md")).dataset.active).toBe("true");

    // The navigation answers late, with the DM it would have opened. It is
    // stale, so it must not open Chats over the file the user just opened.
    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-${CHATS_TAB_PATH}`)).toBeNull();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  }, 20_000);

  // A chat thread opening in the PANEL moves no tab either, and it is the
  // destination change that conflicts most directly: the user chose another
  // conversation, so the DM they walked away from must not arrive as a tab on
  // top of it.
  it("discards an in-flight DM navigation when another chat thread opens in the panel", async () => {
    const fileThreadNode = {
      path: "chat-thread:file-thread",
      kind: "chat-thread" as const,
      threadId: "file-thread",
      title: "Notes discussion",
      incoming: 1,
      outgoing: 0,
    };
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, fileThreadNode],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // The user picks a different conversation. It has no channel metadata, so
    // it opens in the panel — no tab moves.
    const afterNav = await screen.findAllByTestId("graph-file-row");
    await user.click(afterNav.find((row) => row.dataset.path === fileThreadNode.path)!);
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
    expect(screen.queryByTestId(`tab-${CHATS_TAB_PATH}`)).toBeNull();

    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-${CHATS_TAB_PATH}`)).toBeNull();
  }, 20_000);

  // The third seam of the same kind, and the reason the predicate now lives at
  // the destination WRITE: with the Chats tab already active, moving to
  // another channel changes the chat destination while the active tab stays
  // put, so neither the tab check nor onChatsNav (which openChatsNavInTab
  // bypasses by writing the ref itself) can see it.
  it("discards an in-flight DM navigation when another channel opens in the active Chats tab", async () => {
    const channelNode = (id: string, name: string, title: string) => ({
      path: `chat-thread:${id}`,
      kind: "chat-thread" as const,
      threadId: id,
      channelId: `channel-${id}`,
      channelName: name,
      channelSlug: name,
      channelKind: "channel" as const,
      title,
      incoming: 1,
      outgoing: 0,
    });
    const first = channelNode("thread-planning", "planning", "Planning discussion");
    const second = channelNode("thread-hiring", "hiring", "Hiring discussion");
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, first, second],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Open a channel conversation in the Chats TAB, with the graph still in
    // the sidebar. Every navigation from here leaves the active tab alone.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === first.path)!);
    const chatsTab = await screen.findByTestId(`tab-${CHATS_TAB_PATH}`);
    expect(chatsTab.dataset.active).toBe("true");

    // Start a canonical DM navigation and leave it in flight.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === DM_GRAPH_NODE.path,
      )!,
    );
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // The user moves to a different conversation. The tab never moves.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === second.path,
      )!,
    );
    expect(screen.getByTestId(`tab-${CHATS_TAB_PATH}`).dataset.active).toBe("true");

    // Collapse the sidebar so the graph's own row labels stop matching, and
    // only the Chats surface answers the queries below. Re-selecting the
    // active view toggles the panel — a workbench write that moves no tab, so
    // it must not cancel the navigation either.
    await user.click(screen.getByTestId("activity-graph"));
    expect(await screen.findByText("Hiring discussion")).toBeTruthy();

    // The DM answers late. It must not remount Chats over the conversation the
    // user chose.
    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });
    expect(screen.getByText("Hiring discussion")).toBeTruthy();
    expect(screen.queryByText(CANONICAL_DM.name)).toBeNull();
  }, 20_000);

  // The positive direction, and the reason it is not optional: every
  // cancellation test above also passes when NOTHING ever lands, so a fix that
  // cancelled the navigation the moment it started would read as green.
  it("lands a DM navigation that nothing interrupts", async () => {
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });

    expect(await screen.findByTestId(`tab-${CHATS_TAB_PATH}`)).toBeTruthy();
  }, 20_000);

  // Cancelling on EVERY workbench write would make this seam hostile: a width
  // drag streams one mutation per pointermove, so a user who clicks a DM and
  // then adjusts the sidebar loses the click — and the syncDms failure branch
  // is isCurrent-gated too, so nothing would surface. Only a destination
  // change cancels.
  it("keeps an in-flight DM navigation through a sidebar width drag", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Drag the sidebar edge: a workbench write per pointermove, and not one
    // that moves the active tab.
    const panel = screen.getByTestId("side-panel");
    expect(panel.style.width).toBe("240px");
    const handle = screen.getByTestId("sidebar-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 300 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 420 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 1 });
    await waitFor(() => expect(panel.style.width).toBe("420px"));

    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });

    expect(await screen.findByTestId(`tab-${CHATS_TAB_PATH}`)).toBeTruthy();
  }, 20_000);

  // A destination change inside the ACTIVE file moves no tab, so the check
  // above cannot see it — but the user did navigate, and a late DM would open
  // Chats over the line they just jumped to.
  it("discards an in-flight DM navigation when a search result moves within the active file", async () => {
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // a.md is open and active, and a search has results inside it.
    await user.click(await screen.findByText("a.md"));
    expect((await screen.findByTestId("tab-a.md")).dataset.active).toBe("true");
    await user.click(screen.getByTestId("activity-search"));
    await user.type(screen.getByTestId("search-input"), "apples");
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());
    const searchPayload = bridge.searchWorkspace.mock.calls.at(-1)![0];
    act(() => {
      bridge.emitSearchResults({
        searchId: searchPayload.searchId,
        entries: [
          {
            path: "a.md",
            line: 12,
            column: 9,
            preview: "I ate 10 apples",
            matchStart: 9,
            matchEnd: 15,
          },
        ],
        done: true,
        limitHit: false,
      });
    });
    await screen.findByTestId("search-result-row");

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Back to the results and jump to the line. The tab never moves: a.md was
    // already active, so only the in-document destination changed.
    await user.click(screen.getByTestId("activity-search"));
    await user.click(await screen.findByTestId("search-result-row"));
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");

    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-${CHATS_TAB_PATH}`)).toBeNull();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  }, 20_000);

  // The residual window the destination KEY cannot see: opening the chat
  // destination that is already open. Nothing about the key changed, the tab
  // does not move, and the panel reports nothing — yet the user issued an open
  // command, and a repeated backlink is the sharper form of it
  // (chatsNavigationRequiresRemount remounts the page for the message you
  // already focused, precisely so a second click scrolls back to it). The late
  // DM would replace that page. An explicit open therefore always cancels.
  it("discards an in-flight DM navigation when the open chat destination is commanded again", async () => {
    const channel = {
      path: "chat-thread:thread-planning",
      kind: "chat-thread" as const,
      threadId: "thread-planning",
      channelId: "channel-planning",
      channelName: "planning",
      channelSlug: "planning",
      channelKind: "channel" as const,
      title: "Planning discussion",
      incoming: 1,
      outgoing: 0,
    };
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, channel],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Open the channel conversation in the Chats TAB, with the graph still in
    // the sidebar.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === channel.path)!);
    expect((await screen.findByTestId(`tab-${CHATS_TAB_PATH}`)).dataset.active).toBe("true");

    // Start a canonical DM navigation and leave it in flight.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === DM_GRAPH_NODE.path,
      )!,
    );
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Command the SAME conversation again. Every check the seam has says
    // nothing moved: same destination key, same active tab, same sidebar view.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === channel.path,
      )!,
    );
    expect(screen.getByTestId(`tab-${CHATS_TAB_PATH}`).dataset.active).toBe("true");

    // Collapse the sidebar so the graph's own row labels stop matching and
    // only the Chats surface answers the query below.
    await user.click(screen.getByTestId("activity-graph"));
    expect(await screen.findByText("Planning discussion")).toBeTruthy();

    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });
    expect(screen.getByText("Planning discussion")).toBeTruthy();
    expect(screen.queryByText(CANONICAL_DM.name)).toBeNull();
  }, 20_000);

  // Chat mocks the Chats PAGE needs to load its feed and a thread. The base
  // engine bridge only stubs the navigator's overview surface.
  function chatsPageBridge(uiState: WorkspaceUiState) {
    const bridge = makeEngineBridge(Promise.resolve(uiState));
    const syncAnswers: Array<
      (value: { available: boolean; dms: DmRecord[] }) => void
    > = [];
    bridge.syncDms = vi.fn(
      () =>
        new Promise<{ available: boolean; dms: DmRecord[] }>((resolve) => {
          syncAnswers.push(resolve);
        }),
    );
    bridge.listChatChannels = vi.fn(async () => ({
      channels: [
        {
          id: "channel-team",
          name: "team",
          slug: "team",
          kind: "channel" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
          threadCount: 1,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    }));
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    return Object.assign(bridge, {
      syncAnswers,
      listPersonalChatFeed: vi.fn(async () => ({
        items: [
          {
            message: {
              id: "message-feed",
              threadId: "thread-team",
              authorKind: "human" as const,
              authorDisplayName: "You",
              body: "Feed update worth revisiting",
              createdAtMs: 1,
            },
            thread: {
              id: "thread-team",
              title: "Feed thread",
              createdAtMs: 1,
              updatedAtMs: 1,
              channelId: "channel-team",
              messageCount: 1,
              lastReadSequence: 1,
              unreadCount: 0,
            },
            channel: {
              id: "channel-team",
              name: "team",
              slug: "team",
              kind: "channel" as const,
            },
            reactions: [],
            matchedBy: ["channel" as const],
          },
        ],
      })),
      listChatMessages: vi.fn(async () => ({
        messages: [
          {
            id: "message-feed",
            threadId: "thread-team",
            authorKind: "human" as const,
            authorDisplayName: "You",
            body: "Feed update worth revisiting",
            createdAtMs: 1,
          },
        ],
      })),
      listChatReactions: vi.fn(async () => ({ reactions: [], viewerAuthorId: "you" })),
      listChatThreadDecisions: vi.fn(async () => ({ decisions: [] })),
      listChatThreadAttachments: vi.fn(async () => ({ attachments: [] })),
      chatRunRecordsForThread: vi.fn(async () => ({ runs: {} })),
      chatDispatchStateForThread: vi.fn(async () => ({
        liveRun: false,
        pendingCount: 0,
        paused: false,
      })),
      markChatThreadRead: vi.fn(async () => ({ lastReadSequence: 1, revision: 1 })),
    });
  }

  const CHATS_PAGE_STATE: WorkspaceUiState = {
    ...STORED_STATE,
    tabs: [CHATS_TAB_PATH],
    activeTab: CHATS_TAB_PATH,
    chatsVisible: false,
  };

  // #552: the Chats PAGE's feed/backlink click is a COMMAND. It must cancel a
  // pending DM lookup synchronously in the click — the passive nav report is
  // an effect that flushes after the microtask queue, so a DM answer landing
  // in the same tick as the click would pass its isCurrent() check first and
  // remount the page over the message the user just jumped to.
  it("discards a DM answer that lands in the same tick as a page feed click", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    // The page mounts on the Chats tab; go to the Feed.
    await user.click(await screen.findByTestId("chats-feed-link"));
    const post = await screen.findByText("Feed update worth revisiting");
    const postButton = post.closest("button")!;

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    // Collapse the sidebar so only the Chats page answers the queries below.
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user clicks the feed item: the
    // answer's continuation is queued first, and the click handler runs
    // before it does. Only a cancellation issued before the next macrotask
    // wins this race — the passive nav report flushes too late.
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!({ available: true, dms: [CANONICAL_DM] });
      postButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // The sharp assertion: the destination views alone cannot distinguish a
    // won race from a lost one — chatsNav.current is last-write-wins, so the
    // late report can paper over the DM destination before the remount seed
    // reads it. A DM answer that WINS calls openChatsNavInTab, which bumps
    // chatsPageRevision and remounts the page: a second overview load. The
    // cancel won only if no such load happened.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore);
  }, 20_000);

  // The same race through the BACK button: every BackHeader and the keyboard
  // shortcut route through goBack, which must issue the same synchronous
  // command — a DM answer queued in the tick of the Back click would
  // otherwise pass its isCurrent() check and remount the DM over the channel
  // the user went back to.
  it("discards a DM answer that lands in the same tick as the Back click", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    // Land in a thread via the feed.
    await user.click(await screen.findByTestId("chats-feed-link"));
    const post = await screen.findByText("Feed update worth revisiting");
    await user.click(post.closest("button")!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user presses Back.
    const backButton = screen.getByTestId("chats-thread-back");
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!({ available: true, dms: [CANONICAL_DM] });
      backButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-channel-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // Same proof as the feed-click race: a DM answer that wins remounts the
    // page, which loads the overview again. The cancel won only if it
    // did not.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore);
  }, 20_000);

  // The same race through "New message": the compose screen opens with a
  // direct nav write, and a DM answer queued in the same tick would remount
  // the DM over the compose the user just opened.
  it("discards a DM answer that lands in the same tick as the New message click", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    // The DM section renders only once the page's own DM sync answers.
    await screen.findByTestId("chats-feed-link");
    await act(async () => {
      bridge.syncAnswers[0]!({ available: true, dms: [] });
      await Promise.resolve();
    });
    const newDmButton = await screen.findByTestId("chats-new-dm");

    // Start a canonical DM navigation from the graph and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The DM answers in the same tick the user clicks "New message".
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!({ available: true, dms: [CANONICAL_DM] });
      newDmButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByTestId("chats-dm-new-back")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // A DM answer that wins remounts the page: a second overview load.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore);
  }, 20_000);

  // The awaited form of the same click: a feed item carrying a focus target
  // navigates in place (openConversation -> command + report), and the DM
  // answers late. The destination write must cancel it.
  it("discards an in-flight DM navigation when a page feed click jumps to a message", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    renderShell(bridge);

    await user.click(await screen.findByTestId("chats-feed-link"));
    const post = await screen.findByText("Feed update worth revisiting");

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    const dmCallsBefore = bridge.syncDms.mock.calls.length;
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() =>
      expect(bridge.syncDms.mock.calls.length).toBe(dmCallsBefore + 1),
    );
    await user.click(screen.getByTestId("activity-graph"));

    // The user jumps to the message. The DM answers late; it is stale.
    await user.click(post.closest("button")!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    await act(async () => {
      bridge.syncAnswers.at(-1)!({ available: true, dms: [CANONICAL_DM] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
  }, 20_000);

  // The surviving mutant from #552's review: openFile's heading-target
  // invalidation. A heading jump into the ALREADY-ACTIVE file moves no tab,
  // so mutateWb's transition check cannot see it — only openFile's own
  // `if (target)` branch cancels the pending DM.
  it("discards an in-flight DM navigation when a heading jump lands in the active file", async () => {
    const heading = {
      path: "a.md#plan",
      kind: "heading" as const,
      filePath: "a.md",
      headingAnchor: "plan",
      title: "Plan",
      incoming: 1,
      outgoing: 0,
    };
    const sync = deferred<{ available: boolean; dms: DmRecord[] }>();
    const user = userEvent.setup();
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["a.md"],
        activeTab: "a.md",
        chatsVisible: false,
      }),
    );
    bridge.readWorkspaceGraph = vi.fn(async () => ({
      nodes: [DM_GRAPH_NODE, heading],
      edges: [],
      unresolvedLinks: 0,
      scannedFileCount: 1,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    }));
    bridge.syncDms = vi.fn(() => sync.promise);
    renderShell(bridge);

    // Start a canonical DM navigation and leave it in flight.
    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-chat-mentions-toggle"));
    const rows = await screen.findAllByTestId("graph-file-row");
    await user.click(rows.find((row) => row.dataset.path === DM_GRAPH_NODE.path)!);
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());

    // Jump to a heading in the file that is ALREADY the active tab: no tab
    // moves, only the in-document destination changes.
    await user.click(
      (await screen.findAllByTestId("graph-file-row")).find(
        (row) => row.dataset.path === heading.path,
      )!,
    );
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");

    await act(async () => {
      sync.resolve({ available: true, dms: [CANONICAL_DM] });
      await sync.promise;
    });
    expect(screen.queryByTestId(`tab-${CHATS_TAB_PATH}`)).toBeNull();
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  }, 20_000);

  // A request that is merely in flight has not answered anything, and a
  // request that fails never will. Superseding on ISSUE would drop the only
  // answer there is and leave the explorer empty with nothing to retry it.
  it("commits an older listing when the newer request failed", async () => {
    const older = deferred<{
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    }>();
    let failNewer!: (error: Error) => void;
    const newer = new Promise<never>((_resolve, reject) => {
      failNewer = reject;
    });
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(() => (++issued === 1 ? older.promise : newer));
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The newer request fails. Nothing has been displayed yet.
    await act(async () => {
      failNewer(new Error("listing failed"));
      await Promise.resolve();
    });
    expect(screen.queryByText("a.md")).toBeNull();

    // The older answer arrives — and it is the only answer there is.
    await act(async () => {
      older.resolve({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
        ],
        folders: [],
      });
      await older.promise;
    });

    expect(await screen.findByText("a.md")).toBeTruthy();
    expect(screen.getByText("b.md")).toBeTruthy();
  });

  // Listings resolve out of order (the mount listing can overtake the one the
  // share pull triggered). An older snapshot committing last would show a
  // stale tree and, worse, make the reconciliation read a live file as
  // deleted and close its tab.
  it("ignores a listing that resolves after a newer one was issued", async () => {
    type Listing = {
      files: Array<{ path: string; kind: "file" }>;
      folders: string[];
    };
    const older = deferred<Listing>();
    const newer = deferred<Listing>();
    let issued = 0;
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "live.md"],
        activeTab: "b.md",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(() =>
      ++issued === 1 ? older.promise : newer.promise,
    );
    renderShell(bridge);

    // A second listing is issued while the first is still in flight.
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));

    // The newer one lands first and knows about live.md.
    await act(async () => {
      newer.resolve({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
          { path: "live.md", kind: "file" },
        ],
        folders: [],
      });
      await newer.promise;
    });
    expect(await screen.findByTestId("tab-live.md")).toBeTruthy();

    // Then the stale one, which predates live.md, arrives last.
    await act(async () => {
      older.resolve({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
        ],
        folders: [],
      });
      await older.promise;
    });

    // It commits nothing: the tab is open and the tree still lists the file
    // (its name renders in the explorer row, the open-editors row, and the
    // tab — the stale snapshot would have removed all three).
    expect(screen.getByTestId("tab-live.md")).toBeTruthy();
    expect(screen.getAllByText("live.md").length).toBeGreaterThan(0);
  });

  // Either load can win. When the listing lands FIRST there is nothing
  // restored to judge yet, so the restore itself has to re-run the check —
  // otherwise the missing tab survives and gets written back out.
  it("prunes a restored tab when the file listing arrives before the stored state", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    renderShell(bridge);

    // The listing lands first: a.md and b.md, no ghost.md.
    await screen.findByText("a.md");

    await act(async () => {
      stored.resolve({
        ...STORED_STATE,
        tabs: ["b.md", "ghost.md"],
        activeTab: "b.md",
      });
      await Promise.resolve();
    });

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("tab-ghost.md")).toBeNull();
    });
    await waitFor(() => {
      const states = bridge.setWorkspaceUiState.mock.calls.map(
        ([payload]) => payload.state,
      );
      expect(states.some((state) => state.tabs.includes("ghost.md"))).toBe(false);
      expect(states.some((state) => state.tabs.join() === "b.md")).toBe(true);
    });
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

  // #476: the results outlive the panel, so the criteria that produced them
  // must too. A reopened empty input above surviving results named a query
  // the user never sees.
  it("reopens the panel showing the criteria its results belong to", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    await user.type(await screen.findByTestId("search-input"), "apples");
    await user.click(screen.getByTestId("search-toggle-case"));
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());

    const searchPayload = bridge.searchWorkspace.mock.calls.at(-1)![0];
    expect(searchPayload.caseSensitive).toBe(true);
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
        ],
        done: true,
        limitHit: false,
      });
    });
    await screen.findByTestId("search-result-row");

    // Clicking the active rail item collapses the panel: SearchView unmounts.
    await user.click(screen.getByTestId("activity-search"));
    expect(screen.queryByTestId("search-input")).toBeNull();
    await user.click(screen.getByTestId("activity-search"));

    const reopened = await screen.findByTestId("search-input");
    expect((reopened as HTMLInputElement).value).toBe("apples");
    expect(screen.getByTestId("search-toggle-case").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getAllByTestId("search-result-row")).toHaveLength(1);
  });

  // The filter boxes are collapsed by default, so a surviving glob would
  // narrow the visible results from behind a closed disclosure.
  it("reopens the filter boxes when the surviving criteria carry a glob", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    await user.type(await screen.findByTestId("search-input"), "apples");
    await user.click(screen.getByTestId("search-filter-toggle"));
    await user.type(await screen.findByTestId("search-include"), "*.md");
    await waitFor(() =>
      expect(bridge.searchWorkspace.mock.calls.at(-1)![0].includeGlob).toBe("*.md"),
    );

    await user.click(screen.getByTestId("activity-search"));
    expect(screen.queryByTestId("search-input")).toBeNull();
    await user.click(screen.getByTestId("activity-search"));

    const reopenedInclude = await screen.findByTestId("search-include");
    expect((reopenedInclude as HTMLInputElement).value).toBe("*.md");
    expect(screen.getByTestId("search-exclude")).toBeTruthy();
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
    // Main's status says the opt-out happened (#542): the placeholder's
    // Settings copy is earned by that status, not by the renderer's own read.
    const offStatus = { ...SYNC_STATUS, historyRecordingOff: true };
    bridge.openWorkspace = vi.fn(async () => offStatus);
    bridge.getSyncStatus = vi.fn(async () => offStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("history-open-tab"));

    const historyTab = await screen.findByTestId("tab-dohc://history");
    expect(historyTab.dataset.active).toBe("true");
    const page = await screen.findByTestId("history-page");
    // Retirement Phase C: an opted-out workspace has no history source; the
    // page says so instead of rendering an empty timeline.
    const placeholder = within(page).getByTestId("history-off-placeholder");
    await waitFor(() => {
      expect(placeholder.textContent).toContain("History is off for this workspace");
      expect(placeholder.textContent).toContain("turned off in Settings");
    });
  });

  // #542: the renderer's own settings read failed, and main has NOT said
  // recording is off — it may be recording right now. The placeholder must
  // not blame Settings, and must not promise "not recorded": either would be
  // a cause the renderer's silently-caught read invented.
  it("claims neither a Settings cause nor 'not recorded' when its own read failed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getWorkspaceSettings = vi.fn(async () => {
      throw new Error("transient read failure");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    expect(placeholder.textContent).toContain("History is unavailable");
    expect(placeholder.textContent).toContain(
      "dohc could not confirm whether this workspace records history.",
    );
    // The Next this state owes (#601 codex P2): the one action that re-runs
    // both reads — no lighter re-read is wired on this surface.
    expect(placeholder.textContent).toContain("Restart dohc to try again.");
    // The false cause and the false privacy assurance this pins against.
    expect(placeholder.textContent).not.toContain("Settings");
    expect(placeholder.textContent).not.toContain("not being recorded");
  });

  // The masked vector (#601 codex P2): the recorder failed to build on an
  // engine-ENABLED workspace. The renderer's own read still says engine-on,
  // and without the status override the shell mounts the engine timeline —
  // whose every listEngineMoments call can only error. Main's status must
  // override the renderer capability, and the engine fetch must never fire.
  it("lets the status failure override the renderer's engine-on read", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    const failedStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      historyRecordingUnavailable: true,
    };
    bridge.openWorkspace = vi.fn(async () => failedStatus);
    bridge.getSyncStatus = vi.fn(async () => failedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    // Prove the renderer's read really said engine-ON before anything is
    // asserted: this engine-only control exists only once the settings read
    // resolved the flag true. Without this the pins below pass vacuously in
    // the pre-read window where engineEnabled is still false.
    await screen.findByTestId("titlebar-chats-sidebar");

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    expect(placeholder.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );
    expect(placeholder.textContent).not.toContain("turned off in Settings");

    // Activity pushes take the no-engine refresh path too — the pin that
    // kills the recurring listEngineMoments error loop.
    const statusCalls = bridge.getSyncStatus.mock.calls.length;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() =>
      expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(statusCalls),
    );
    expect(bridge.listEngineMoments).not.toHaveBeenCalled();
  });

  // #505 on this surface: the recorder failed to build. Nothing records, but
  // the cause is a failure — the opt-out's Settings copy would be false.
  it("names the failure, not Settings, when main says the recorder could not be built", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const failedStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      historyRecordingUnavailable: true,
    };
    bridge.openWorkspace = vi.fn(async () => failedStatus);
    bridge.getSyncStatus = vi.fn(async () => failedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    await waitFor(() =>
      expect(placeholder.textContent).toContain(
        "dohc could not start recording history for this workspace.",
      ),
    );
    expect(placeholder.textContent).not.toContain("turned off in Settings");
  });

  // #483 on this surface: an unreadable settings file is the cause main
  // established, and its warning already names the file and the fix.
  it("names the unreadable settings file when that read is the cause", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const warnedStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      settingsWarning:
        "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.",
    };
    bridge.openWorkspace = vi.fn(async () => warnedStatus);
    bridge.getSyncStatus = vi.fn(async () => warnedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    await waitFor(() =>
      expect(placeholder.textContent).toContain("/ws/.dohc/settings.local.json"),
    );
    expect(placeholder.textContent).not.toContain("turned off in Settings");
  });

  // #540's class on this surface: a shared view records no history BY
  // DESIGN — a capability, not an opt-out, so no Settings blame.
  it("states the shared-view capability instead of blaming Settings", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
    });

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    expect(placeholder.textContent).toContain("A shared view records no history");
    expect(placeholder.textContent).not.toContain("Settings");
  });

  // #540 on the History surface itself: a shared view materializes no
  // settings file, so the renderer's settings read comes back with the
  // default flag ON — but the share's open deliberately installed no
  // capture, so every engine call can only error. The surface must state
  // the capability instead, and must never ask main for engine moments.
  it("gives a shared view the capability truth and never asks for engine moments", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
    });

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    // The empty-state recipe (copy.md): ONE text-sm text-muted line carrying
    // the state and the Next together.
    expect(placeholder.textContent).toContain(
      "A shared view records no history. Refresh the shared view to get the latest shared changes.",
    );
    const lines = placeholder.querySelectorAll("span");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.className).toContain("text-sm");
    expect(lines[0]?.className).toContain("text-muted");
    // The Next works on this surface: the share banner's Refresh control,
    // pinned to exist alongside the instruction that names it.
    expect(screen.getByTestId("shared-view-refresh")).toBeTruthy();
    // The false cause this pins against: the opt-out's Settings copy, about
    // a toggle nobody touched.
    expect(placeholder.textContent).not.toContain("Settings");

    // Activity pushes take the no-engine refresh path too — this is the pin
    // that kills a regression to the recurring "Could not open history"
    // error loop.
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });
    expect(bridge.listEngineMoments).not.toHaveBeenCalled();
  });

  // The ended share has no Refresh control, so its placeholder must not
  // instruct one — the false-instruction class this lane exists to kill.
  it("an ended share's placeholder does not name the Refresh it no longer has", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        ended: true,
      },
    });

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    // Same single-line shape, with the ended share's own true Next — and an
    // active sentence naming who ended it (copy.md), not a passive
    // "was ended" with no actor.
    expect(placeholder.textContent).toContain(
      "A shared view records no history. granter@dohc.test ended this share. You can still open the files it shared.",
    );
    expect(placeholder.textContent).not.toContain("was ended");
    expect(placeholder.textContent).not.toContain("Refresh");
    expect(screen.queryByTestId("shared-view-refresh")).toBeNull();
  });

  function historyMoment(id: string, summary: string): EngineMomentRecord {
    return {
      id,
      versionId: "main",
      path: "notes/plan.md",
      recordedAtMs: 100,
      operation: "write",
      origin: "local-file",
      momentOrder: 1,
      summary,
    };
  }

  function historyPage(
    moments: EngineMomentRecord[],
    activeVersionId = "main",
  ): ListEngineMomentsResult {
    return {
      moments,
      nextBeforeMomentOrder: null,
      latestMomentOrder: 1,
      activeVersionId,
    };
  }

  // The listing loaders' rule, on the timeline: a request that is merely in
  // flight has answered nothing, and one that FAILS never will. Superseding on
  // ISSUE threw away the only answer there was, and the panel stayed empty
  // until some later event refreshed it.
  it("commits an older history page when the newer refresh failed", async () => {
    const older = deferred<ListEngineMomentsResult>();
    let failNewer!: (error: Error) => void;
    const newer = new Promise<never>((_resolve, reject) => {
      failNewer = reject;
    });
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => (++issued === 1 ? older.promise : newer));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    // The newer request fails. Nothing has been displayed yet.
    await act(async () => {
      failNewer(new Error("history failed"));
      await Promise.resolve();
    });
    expect(screen.queryByText("Reordered the plan")).toBeNull();

    // The older answer arrives — and it is the only answer there is.
    await act(async () => {
      older.resolve(historyPage([historyMoment("m-older", "Reordered the plan")]));
      await older.promise;
    });

    expect(await screen.findByText("Reordered the plan")).toBeTruthy();
  });

  // The other half of the same rule: an answer OLDER than what is already
  // displayed is still dropped, so a slow response cannot move the timeline
  // backward.
  it("ignores a history page that resolves after a newer one committed", async () => {
    const older = deferred<ListEngineMomentsResult>();
    const newer = deferred<ListEngineMomentsResult>();
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() =>
      ++issued === 1 ? older.promise : newer.promise,
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    await act(async () => {
      newer.resolve(historyPage([historyMoment("m-newer", "Added the launch checklist")]));
      await newer.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    await act(async () => {
      older.resolve(historyPage([historyMoment("m-older", "Reordered the plan")]));
      await older.promise;
    });

    expect(screen.queryByText("Reordered the plan")).toBeNull();
    expect(screen.getByText("Added the launch checklist")).toBeTruthy();
  });

  // The pagination's cursor points into the DISPLAYED timeline, so an older
  // refresh must not reset the timeline under it — the append would land
  // against a cursor that no longer describes what is on screen. The refresh
  // is issued first here, which is the ordinary ordering, not a rare race.
  it("keeps an older refresh from resetting the timeline under a pagination in flight", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    const earlier = deferred<ListEngineMomentsResult>();
    const pages = [first, refreshed, earlier];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => pages[issued++]!.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    // A refresh goes out, and the user asks for earlier changes while it is
    // still in flight.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    // The refresh answers first, because it was issued first.
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });
    // Then the page the user actually asked for.
    await act(async () => {
      earlier.resolve(historyPage([historyMoment("m-earlier", "Started the plan")]));
      await earlier.promise;
    });

    expect(await screen.findByText("Started the plan")).toBeTruthy();
    expect(screen.getByText("Added the launch checklist")).toBeTruthy();
    expect(screen.queryByText("Rewrote the plan")).toBeNull();
  });

  // The same pair, answering the other way round: once the page the user asked
  // for is on screen, an older refresh landing after it is an older answer and
  // is dropped like any other.
  it("drops an older refresh that answers after the pagination it raced", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    const earlier = deferred<ListEngineMomentsResult>();
    const pages = [first, refreshed, earlier];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => pages[issued++]!.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    await act(async () => {
      earlier.resolve(historyPage([historyMoment("m-earlier", "Started the plan")]));
      await earlier.promise;
    });
    expect(await screen.findByText("Started the plan")).toBeTruthy();

    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    expect(screen.getByText("Started the plan")).toBeTruthy();
    expect(screen.getByText("Added the launch checklist")).toBeTruthy();
    expect(screen.queryByText("Rewrote the plan")).toBeNull();
  });

  // #489 one layer over: a pagination that FAILS answered nothing either, so
  // it must stop holding back the refresh it raced. If its token were left
  // standing, the dead pagination would block every older refresh for the rest
  // of the session and the timeline would go stale with nothing to retry it.
  it("commits a refresh that raced a pagination which then failed", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
      page,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    // The page the user asked for fails. It answered nothing, so it holds
    // nothing back.
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
  });

  // #507, and the mirror of the test above: the refresh answers FIRST, while
  // the pagination is still in flight. Blocked is not refuted — when the
  // pagination then fails, this is again the only answer anyone has, so
  // discarding it at resolve time would leave the timeline stale with nothing
  // to retry it.
  it("commits a refresh that was blocked by a pagination which then failed", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
      page,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    // The refresh answers while the pagination is still out. It is held, not
    // displayed: the pagination could still land on top of it.
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // The pagination fails, so nothing newer ever arrives, and the held answer
    // is the only one there is.
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
  });

  // #507's other half: the page the user asked for answered, and a newer
  // refresh that merely FAILED took it away — leaving "Loading…" disabled on
  // the button as well, so the earlier moments were unreachable.
  it("commits a pagination whose newer refresh failed, and frees the button", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const earlier = deferred<ListEngineMomentsResult>();
    let failRefresh!: (error: Error) => void;
    const refreshed = new Promise<never>((_resolve, reject) => {
      failRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      earlier.promise,
      refreshed,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    // The user asks for earlier changes, then an activity event fires a
    // refresh that fails.
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      failRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    await act(async () => {
      earlier.resolve({
        ...historyPage([historyMoment("m-earlier", "Started the plan")]),
        nextBeforeMomentOrder: 0,
      });
      await earlier.promise;
    });

    // The page displays, and the control the user pressed is usable again.
    expect(await screen.findByText("Started the plan")).toBeTruthy();
    expect(screen.getByText("Added the launch checklist")).toBeTruthy();
    const loadMore = screen.getByTestId("engine-history-load-more");
    await waitFor(() => expect(loadMore.hasAttribute("disabled")).toBe(false));
    expect(loadMore.textContent).toBe("Show earlier changes");
  });

  const REVIEW_STATE = {
    status: "review" as const,
    task: "Draft the launch note",
    versionId: "try-1",
    versionName: "Try: launch note",
    runId: "run-1",
    startedAtMs: 10,
    endedAtMs: 20,
    runOutcome: "complete" as const,
    changedFileCount: 1,
    mergeAvailable: false,
  };

  // The held answer is a TIMELINE answer. Holding the whole response would
  // republish snapshots the user has acted on since — here the review card the
  // main process already dismissed, which nothing else would clear.
  it("does not bring back a review the user dismissed while a page was loading", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
      page,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    // The main process keeps reporting the review until it is dismissed.
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A refresh answers while a pagination is in flight, so it is held — and
    // the response it carries still contains the review.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // The user dismisses the review.
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(bridge.dismissTryInVersionReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    // The pagination fails, so the held TIMELINE answer commits — and only it.
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("try-review-card")).toBeNull();
  });

  // One layer deeper: the dismissal happens while the refresh is still in
  // flight. Counting only responses, that refresh is still the newest thing
  // the snapshot watermark has seen, so its status half would undo an action
  // the user took after it was issued — and nothing would put the card away
  // again, because dismissing emits no replacement activity.
  it("does not bring back a review dismissed while the refresh was still in flight", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
      page,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    // The main process keeps reporting the review until it is dismissed.
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A refresh is out — its try-state half has already answered, carrying the
    // review — and a newer pagination is out behind it.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(bridge.getTryInVersionState).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    // The user dismisses the card while both are still in flight.
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(bridge.dismissTryInVersionReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    // Now let everything settle: the refresh answers, and the pagination fails
    // so the held timeline commits.
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    // The timeline still lands — only the snapshot the user overruled is gone.
    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("try-review-card")).toBeNull();
  });

  // A version switch changes which timeline is true, so it is a boundary: an
  // answer describing the version the user left must never paint the one they
  // are now on, however the newest-answer race would otherwise resolve.
  it("never paints the version the user left over the one they switched to", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const staleRefresh = deferred<ListEngineMomentsResult>();
    const stalePage = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      staleRefresh.promise,
      stalePage.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    // The workspace reports the try version until the switch runs, Main after.
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
      ],
      activeVersionId: switched ? "main" : "try-1",
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage(
          [historyMoment("m-first", "Wrote the note in the try version")],
          "try-1",
        ),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // A refresh and a pagination are both in flight when the user leaves.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    // Set aside: switch back to Main. Its own refresh fails, so nothing newer
    // ever answers — exactly when the stale answers would win.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(4));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // Both answers from the version the user left arrive too late to matter.
    await act(async () => {
      staleRefresh.resolve(
        historyPage(
          [historyMoment("m-stale", "Edited the note in the try version")],
          "try-1",
        ),
      );
      await staleRefresh.promise;
    });
    await act(async () => {
      stalePage.resolve(
        historyPage(
          [historyMoment("m-stale-page", "Started the try version")],
          "try-1",
        ),
      );
      await stalePage.promise;
    });

    expect(screen.queryByText("Edited the note in the try version")).toBeNull();
    expect(screen.queryByText("Started the try version")).toBeNull();
  });

  // The other side of that boundary. Main notifies the renderer BEFORE the
  // switch invoke resolves, so an activity refresh can be ISSUED — and answer
  // — for the new version before the shell hears about the switch at all.
  // Rejecting by arrival order threw that valid answer away and left the panel
  // on the version the user had just left.
  it("keeps a new-version answer that raced the switch it belongs to", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const earlyRefresh = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      earlyRefresh.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
      ],
      activeVersionId: switched ? "main" : "try-1",
    }));
    // The switch lands in the daemon and notifies the renderer before the
    // invoke resolves, which is the ordering this test exists for.
    const switchInvoke = deferred<void>();
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      bridge.emitWorkspaceActivity();
      await switchInvoke.promise;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(
        historyPage([historyMoment("m-first", "Wrote the note in the try version")], "try-1"),
      );
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // Set aside: the daemon switches and notifies, so the activity refresh for
    // MAIN is ISSUED before the switch invoke resolves — and it is still in
    // flight when the shell finally hears about the switch.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    // The switch resolves, the shell runs its boundary, and its own refresh
    // fails — so the early answer is the only one that will ever describe Main.
    await act(async () => {
      switchInvoke.resolve();
      await switchInvoke.promise;
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // It answers last, describing the version the user is now on.
    await act(async () => {
      earlyRefresh.resolve(
        historyPage([historyMoment("m-early", "Back on main")], "main"),
      );
      await earlyRefresh.promise;
    });

    expect(await screen.findByText("Back on main")).toBeTruthy();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
  });

  // The boundary has to name the version the user LEFT, and before the FIRST
  // page commits the panel displays none. Inferring that version from the
  // timeline left the guard with nothing to reject, so the answer describing
  // the version they had already left painted the panel — and stayed there
  // when the post-switch refresh failed.
  it("rejects the version the user left before the timeline committed one", async () => {
    const stranded = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1",
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    // The first page is still in flight, so the panel knows no version of its
    // own when the user leaves this one.
    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());

    // The switch's own refresh fails, so nothing newer ever answers — exactly
    // when the stranded answer would win.
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
  });

  // A boundary anyone has to AWAIT is not a boundary. When the old version's
  // answer lands first, it meets a guard that knows nothing, commits, and
  // whatever arrives later cannot retract it — so a failed switch-triggered
  // refresh left the previous version's moments on screen. Two awaits used to
  // sit in front of the announcement: the shell's own lookup, and the
  // selector's post-switch re-read. Neither answers here.
  it("rejects the old version's answer without waiting for a lookup", async () => {
    const stranded = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    let switched = false;
    // Only the selector's mount read answers. Every later read hangs forever:
    // the shell's own lookup if it still needed one, AND the selector's
    // post-switch re-read — so a boundary announced after either of them is a
    // boundary that never arrives.
    const hungLookup = new Promise<never>(() => {});
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads > 1) return hungLookup;
      return Promise.resolve({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "try-1",
            name: "Try: launch note",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: switched ? "main" : "try-1",
      });
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
  });

  // The residual window (#555): a switch that FAILED, whose recovery re-read
  // also failed, leaves the shell asking which version is active. That lookup
  // is a boundary arriving after the answers it must judge — an old-version
  // answer landing first meets a guard that knows nothing and paints. The
  // lookup cannot stop the paint, so it judges the committed page when it
  // settles: naming a version the lookup contradicts, the page is dropped and
  // the timeline asked again.
  it("drops an old-version answer the failed-switch lookup contradicts", async () => {
    const stranded = deferred<ListEngineMomentsResult>();
    const repaint = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      stranded.promise,
      switchRefresh,
      repaint.promise,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    // Read 1 is the selector's mount read. Read 2 is its recovery re-read
    // after the failed switch — it fails too, so nobody can name the active
    // version and the shell has to ask. Read 3 is that lookup, held open.
    // Later reads (the re-key refresh) hang: nothing else may answer.
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    // The switch failed — but it partially applied, so the workspace really
    // is on Main; only the lookup can say so.
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );

    // The switch-triggered refresh fails: nothing newer will answer on its own.
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // The old version's answer lands while the lookup is still in flight. The
    // guard knows nothing yet, so it paints — this is the window itself.
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // The lookup settles and contradicts the committed page: dropped, and the
    // timeline is asked again.
    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "main" });
      await lookup.promise;
    });
    await waitFor(() =>
      expect(screen.queryByText("Wrote the note in the try version")).toBeNull(),
    );
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      repaint.resolve(historyPage([historyMoment("m-main", "Back on main")], "main"));
      await repaint.promise;
    });
    expect(await screen.findByText("Back on main")).toBeTruthy();
  });

  // The other verdict the lookup can reach: it agrees with the committed page
  // (the failed switch never applied). Dropping here would blank a timeline
  // that is right — and this is every merge and conflict resolution, whose
  // lookup only restates what is already true.
  it("keeps the committed page when the failed-switch lookup agrees with it", async () => {
    const stranded = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // The switch never applied: the lookup names the version the page already
    // describes. Nothing is dropped and nothing is re-fetched.
    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "try-1" });
      await lookup.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();
    expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2);
  });

  // The judge must know when court is over: a lookup that settles after the
  // shell unmounted judges nothing. Without the committed-watermark half of
  // the staleness question, a contradicting late lookup would drop state and
  // fire four IPC reads for a workspace the user already left — the renderer
  // async-state invariant.
  it("a lookup that settles after unmount drops nothing and asks nothing", async () => {
    const stranded = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    const view = renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    // The user leaves while the lookup is still in flight.
    view.unmount();

    // The lookup settles, contradicting the page the shell once displayed.
    // Nothing may happen: no drop, and above all no re-fetch for a shell
    // that is gone.
    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "main" });
      await lookup.promise;
      await Promise.resolve();
    });
    expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2);
  });

  // Announcing the switch FIRST re-keys this component, and the re-key used to
  // bump the same counter the operation checks itself against — so the switch
  // invalidated its own token while its follow-up re-read was still pending,
  // its finally skipped, and the selector sat disabled on "Switching…" for the
  // rest of the session. Liveness and operation identity are different
  // questions.
  it("re-enables the selector when the switch re-read outlives the epoch bump", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    let switched = false;
    // Only the mount read answers at once. Every read after it — the switch's
    // own re-read, and the one the re-key issues — is held open, so the
    // operation must survive the re-key to finish at all.
    const held: Array<() => void> = [];
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      const answer = () => ({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "try-1",
            name: "Try: launch note",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: switched ? "main" : "try-1",
      });
      versionReads += 1;
      if (versionReads === 1) return Promise.resolve(answer());
      return new Promise<ReturnType<typeof answer>>((resolveRead) => {
        held.push(() => resolveRead(answer()));
      });
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    // The re-key has happened by now: it is what issues the extra read.
    await waitFor(() => expect(held.length).toBeGreaterThan(1));

    await act(async () => {
      for (const answerRead of held) answerRead();
      await Promise.resolve();
    });

    const trigger = await screen.findByTestId("version-menu-button");
    await waitFor(() =>
      expect(screen.getByTestId("version-menu-active").textContent).not.toBe(
        "Switching…",
      ),
    );
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
  });

  // The same slip on the other flow. "Back to Main" switched, then dismissed
  // the review, and only then said where the workspace had landed — so an
  // old-version answer arriving while the dismissal was in flight met an unset
  // boundary. The dismissal here never settles, which is what a slow one looks
  // like from the timeline's side.
  it("reports Main before the dismissal it does not wait for", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const stranded = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1",
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    // The switch lands; the dismissal that follows it never does.
    bridge.dismissTryInVersionReview = vi.fn(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(
        historyPage(
          [historyMoment("m-first", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A try-version refresh is in flight when the user leaves.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    // Set aside: switch back to Main, then hang on the dismissal.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.dismissTryInVersionReview).toHaveBeenCalled());

    // The boundary's own refresh fails, so the try-version answer is the only
    // one left — and it describes somewhere the user is no longer.
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Edited the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    expect(screen.queryByText("Edited the note in the try version")).toBeNull();
  });

  // Statements about the active version are ordered by the ISSUE counter, and
  // main serves these calls concurrently — so a request issued earlier can
  // answer later. A late answer restating a version the workspace has already
  // moved past must not lower what the workspace said: doing so would leave a
  // watermark below the answers still in flight, and the next one describing
  // the version the user left would read as fresh and paint it.
  it("keeps a late answer from lowering what the workspace already said", async () => {
    const opening = deferred<ListEngineMomentsResult>();
    const late = deferred<ListEngineMomentsResult>();
    const stale = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      opening.promise,
      late.promise,
      stale.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1",
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      opening.resolve(
        historyPage(
          [historyMoment("m-opening", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await opening.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // Two refreshes go out, in this order. They will answer in the other one.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));

    // The switch: the workspace says Main, which is the newest statement of all
    // — issued after both refreshes. The switch's own refresh fails, so nothing
    // newer than those two ever answers.
    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(4));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // The EARLIER of the two refreshes answers first, and it is right about
    // Main — it just says nothing the workspace has not already said.
    await act(async () => {
      late.resolve(historyPage([historyMoment("m-late", "Back on main")], "main"));
      await late.promise;
    });
    expect(await screen.findByText("Back on main")).toBeTruthy();

    // The later one describes the version the user left. It is newer than that
    // Main answer and older than the workspace's statement, and it loses to the
    // statement.
    await act(async () => {
      stale.resolve(
        historyPage(
          [historyMoment("m-stale", "Edited the note in the try version")],
          "try-1",
        ),
      );
      await stale.promise;
    });

    expect(screen.queryByText("Edited the note in the try version")).toBeNull();
    expect(screen.getByText("Back on main")).toBeTruthy();
  });

  // The same callback runs for merges, conflict resolutions, and a "Set aside"
  // that was already on Main — none of which change the active version. Clearing
  // the held refresh on every one of them threw away a good answer, and when the
  // pagination holding it and the replacement refresh both failed, the timeline
  // never got it.
  it("keeps a held refresh when the version state changed without a switch", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    let failDismissRefresh!: (error: Error) => void;
    const dismissRefresh = new Promise<never>((_resolve, reject) => {
      failDismissRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
      page,
      dismissRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // Set aside while already on Main: no switch runs, but the shell hears the
    // version state changed. Its refresh fails, so the held answer is still the
    // only one anyone has.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(4));
    expect(bridge.switchWorkspaceVersion).not.toHaveBeenCalled();
    await act(async () => {
      failDismissRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
  });

  // A failure is an ANSWER for the version rule: it answers about somewhere
  // the user has left. The switch bumps the issue counter but not the
  // committed watermark, so the old pagination's rejection still read as
  // "about the open timeline" and posted a banner for a version nobody is
  // looking at.
  it("says nothing about a pagination that failed for the version the user left", async () => {
    const first = deferred<ListEngineMomentsResult>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      page,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1",
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage(
          [historyMoment("m-first", "Wrote the note in the try version")],
          "try-1",
        ),
        nextBeforeMomentOrder: 1,
      });
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // Earlier moments are on their way when the user leaves this version.
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    // Nothing commits for the new version either, so the committed watermark
    // never moves — the only thing that can tell the failure apart is which
    // version it belongs to.
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    // That refresh's own failure is real and is reported. Clear it, so what
    // remains can only have come from the pagination.
    await user.click(await screen.findByLabelText("Dismiss workspace error"));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Starting or ending a run is the user acting. Merely OBSERVING that the run
  // changed under the rendered label is not: that reading came from its own
  // request, which can be older than a refresh the shell is still waiting on.
  // Superseding on it threw the newer answer away, and a run seen alive just
  // before it ended left the indicator running with nothing to correct it.
  it("keeps an observed agent state from rejecting a newer refresh", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const afterTheRun = deferred<ListEngineMomentsResult>();
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      afterTheRun.promise,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    let activeRunId: string | null = null;
    bridge.getAgentRunStatus = vi.fn(async () => ({
      mcpEnabled: true,
      activeRun: activeRunId
        ? {
            id: activeRunId,
            startedAt: 1,
            agentId: "agent-1",
            onBehalfOf: "ice",
            status: "running" as const,
          }
        : null,
      lastRun: null,
    }));
    // The panel's reread is held open through getMcpConfig, which only the
    // settings panel calls — so the shell's own requests run unimpeded.
    const heldPanelReads: Array<() => void> = [];
    let panelReads = 0;
    const mcpConfig: McpConfigResult = {
      command: "dohc-mcp",
      args: [],
      workspacePath: WORKSPACE.rootPath,
      home: "/tmp/dohc-home",
    };
    bridge.getMcpConfig = vi.fn(() => {
      panelReads += 1;
      if (panelReads === 1) return Promise.resolve(mcpConfig);
      return new Promise<McpConfigResult>((resolveRead) => {
        heldPanelReads.push(() => resolveRead(mcpConfig));
      });
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(historyPage([historyMoment("m-first", "Added the launch checklist")]));
      await first.promise;
    });
    expect(screen.queryByTestId("agent-run-indicator")).toBeNull();

    // Settings opens while no run is going, so the panel renders "no run".
    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Agents & MCP",
      ),
    );
    await screen.findByTestId("mcp-enable-toggle");

    // A run starts, and the toggle's reread catches it alive — but the reread
    // is still in flight.
    activeRunId = "run-1";
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(heldPanelReads.length).toBe(1));

    // The run ends, and the refresh that captured the END is waiting on its
    // history page.
    activeRunId = null;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    // The reread answers first, reporting the run it saw alive.
    await act(async () => {
      for (const answerRead of heldPanelReads) answerRead();
      await Promise.resolve();
    });
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();

    // Then the refresh lands, and it knows the run is over.
    await act(async () => {
      afterTheRun.resolve(historyPage([historyMoment("m-after", "Rewrote the plan")]));
      await afterTheRun.promise;
    });

    await waitFor(() =>
      expect(screen.queryByTestId("agent-run-indicator")).toBeNull(),
    );
  });

  // Supersession is per LANE. The user dismissed a review; that says nothing
  // about sync or agent state, and the dismiss emits no activity event, so
  // rejecting those lanes too would strand the status bar with no other source.
  it("suppresses only the lane the user wrote when a refresh answers late", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    // The workspace moves on before the second refresh is issued, so that
    // refresh carries fresh news on the two lanes the user did not write.
    let movedOn = false;
    bridge.getSyncStatus = vi.fn(async () =>
      movedOn ? { ...SYNC_STATUS, state: "syncing" as const } : SYNC_STATUS,
    );
    bridge.getAgentRunStatus = vi.fn(async () => ({
      mcpEnabled: false,
      activeRun: movedOn
        ? {
            id: "run-1",
            startedAt: 1,
            agentId: "agent-1",
            onBehalfOf: "ice",
            status: "running" as const,
          }
        : null,
      lastRun: null,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(historyPage([historyMoment("m-first", "Added the launch checklist")]));
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();
    expect(screen.getByTestId("sync-status").dataset.state).toBe("synced");
    expect(screen.queryByTestId("agent-run-indicator")).toBeNull();

    // A refresh is in flight when the user dismisses the review.
    movedOn = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // The lane the user wrote stays written; the lanes they did not, update.
    expect(screen.queryByTestId("try-review-card")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
    expect(screen.getByTestId("agent-run-indicator")).toBeTruthy();
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

// AUDIT-OPTOUT: a settings file that cannot be read reads as opted out, so the
// workspace records no history. The Settings dialog is not enough — the user
// must see it without opening Settings.
//
// #483: the notice states what MAIN's open-time read found — the read that
// decided whether anything is recorded. The renderer's own read of the same
// file happens at a different moment and can disagree with it: one way round
// the user gets a true "history is off" under a false cause, the other way a
// recording workspace promises "no history".
const UNREADABLE_WARNING =
  "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";

const OPTED_OUT_READ = async (): Promise<WorkspaceSettingsResult> => ({
  settings: {
    ...DEFAULT_WORKSPACE_SETTINGS,
    experimental: {
      ...DEFAULT_WORKSPACE_SETTINGS.experimental,
      workspaceEngineAlpha: false,
    },
  },
  source: "recovered" as const,
  warning: UNREADABLE_WARNING,
});

describe("unreadable workspace settings", () => {
  it("raises the settings warning in the notice center, not only in Settings", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getWorkspaceSettings = vi.fn(OPTED_OUT_READ);
    const offStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      settingsWarning: UNREADABLE_WARNING,
    };
    bridge.openWorkspace = vi.fn(async () => offStatus);
    bridge.getSyncStatus = vi.fn(async () => offStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    expect(
      (await screen.findByTestId("notice-workspace-settings-unreadable"))
        .textContent,
    ).toContain("/ws/.dohc/settings.local.json");
  });

  it("names main's cause even when the renderer's own read succeeded", async () => {
    // Main's read hit a transient error at open, so nothing is recorded for
    // this session. The renderer read the same file a moment later and it was
    // fine — the notice must still say WHY, not blame the Settings toggle.
    const bridge = makeBridge(Promise.resolve(null));
    const offStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      settingsWarning: UNREADABLE_WARNING,
    };
    bridge.openWorkspace = vi.fn(async () => offStatus);
    bridge.getSyncStatus = vi.fn(async () => offStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    expect(
      (await screen.findByTestId("notice-workspace-settings-unreadable"))
        .textContent,
    ).toContain("/ws/.dohc/settings.local.json");
    expect(screen.queryByTestId("notice-history-recording-off")).toBeNull();
  });

  it("never promises 'no history' while the workspace is recording", async () => {
    // The reverse race: the renderer's read failed, main's succeeded and the
    // engine is recording. A notice sourced from the renderer's read would be
    // a false privacy assurance.
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getWorkspaceSettings = vi.fn(OPTED_OUT_READ);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    // The panel opened, so a missing notice means no notice — not a missed
    // render.
    expect(await screen.findByTestId("notice-center")).toBeTruthy();
    expect(screen.queryByTestId("notice-workspace-settings-unreadable")).toBeNull();
    expect(screen.queryByTestId("notice-history-recording-off")).toBeNull();
  });
});
