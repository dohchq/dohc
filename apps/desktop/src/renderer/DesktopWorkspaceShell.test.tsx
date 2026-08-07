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
  ReadEngineMomentResult,
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
  chatsOffCopy,
  chatsNavigationChangesDestination,
  chatsNavigationLeavesConversation,
  chatsNavigationRequiresRemount,
  DesktopWorkspaceShell,
  graphChatOpenTarget,
  pendingHeadingTargetForOpen,
  resolveCanonicalDm,
  runCanonicalDmNavigation,
  versionCompareOffCopy,
  type Workspace,
} from "./DesktopWorkspaceShell";
import type { ChatsNav } from "./workbench/ChatsView";
import {
  CHATS_TAB_PATH,
  OPEN_EDITORS_DEFAULT_HEIGHT,
  OPEN_EDITORS_MIN_HEIGHT,
  momentDiffTabPath,
  versionCompareTabPath,
} from "./workbench/workbenchState";
import {
  captureOrphanedDraft,
  resetOrphanedDrafts,
  useAllOrphanedDrafts,
} from "./orphanedDrafts";
import { RecoveryList } from "./RecoveryList";

// The close dialog's list, standing on its own: the guard subscribes and hands
// the rows down, so a test of the LIST needs the same one-line subscriber.
function GlobalRecoveryList() {
  return <RecoveryList rows={useAllOrphanedDrafts()} showWorkspace />;
}

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
    // The shell re-reads the registry to pick up a share's durable skip
    // record. Default: a workspace with nothing skipped.
    getWorkspaceRegistry: vi.fn(
      async (): Promise<{ workspaces: unknown[] }> => ({ workspaces: [] }),
    ),
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
    // The linked-mentions panel bails without this, and its chat-mention read
    // is an ENGINE CAPTURE call (#615) — so a fake that omits it makes every
    // no-call pin on that read pass for the wrong reason.
    getBacklinks: vi.fn(async () => ({ sources: [] as never[] })),
    listChatFileMentions: vi.fn(async () => ({ mentions: [] as never[] })),
    // Typed to the payload the shell really sends: `includeChatMentions` is
    // the flag that decides whether main runs this read through
    // requireEngineCapture, so a pin on it has to be able to read it back.
    readWorkspaceGraph: vi.fn(async (_payload: {
      workspaceId: string;
      includeChatMentions?: boolean;
    }) => ({
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
    dismissShareSkips: vi.fn(async () => undefined),
    refreshSharedView: vi.fn(
      async (): Promise<RefreshSharedViewResult> => ({
        status: "unchanged",
        changedPaths: 0,
        refusedOps: 0,
        refusedDetail: null,
      }),
    ),
    onWorkspaceActivity: vi.fn((callback: () => void) => {
      activityCallback = callback;
      return () => {
        activityCallback = null;
      };
    }),
    onCloudSessionChanged: vi.fn((_callback: () => void) => () => {}),
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
    // Typed to the contract as well: the moment-diff page mounts on it, and
    // a shared view's bridge overrides it with main's refusal.
    readEngineMoment: vi.fn(
      async (): Promise<ReadEngineMomentResult> => ({ moment: null }),
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

// The status a real shared view carries (capture === null, share cause) and
// the workspace identity that rides the capture decision.
const SHARE_STATUS = {
  ...SYNC_STATUS,
  historyRecordingOff: true,
  historyShareView: true,
};
const SHARE_VIEW: Workspace = {
  ...WORKSPACE,
  shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
};

// A bridge that answers the way MAIN answers for a shared view: the capture
// gate short-circuits before the settings read, so requireEngineCapture has
// no capture and every engine call is refused with engineOffRefusal copy. A
// fake that resolved these would model more than main can do, and every
// no-call pin below would pass even after the fix was reverted.
function makeShareBridge(
  uiState: Promise<WorkspaceUiState | null> = Promise.resolve(null),
) {
  const bridge = makeEngineBridge(uiState);
  bridge.openWorkspace = vi.fn(async () => SHARE_STATUS);
  bridge.getSyncStatus = vi.fn(async () => SHARE_STATUS);
  bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
    throw new Error("Versions are not enabled for this workspace.");
  });
  bridge.readEngineMoment = vi.fn(async (): Promise<never> => {
    throw new Error("Engine history is not enabled for this workspace.");
  });
  for (const call of [
    "listChatChannels",
    "listChannelThreads",
    "listFileChats",
    "listChatFileMentions",
    "syncDms",
  ] as const) {
    bridge[call] = vi.fn(async (): Promise<never> => {
      throw new Error("Chats are not enabled for this workspace.");
    });
  }
  return bridge;
}

// The non-vacuity probe for a shared view (#615). Every engine surface is
// hidden there now — the version selector, the Chats panel, the titlebar
// Chats button — so no rendered control can prove the renderer's capability
// read resolved engine-ON, and a no-call pin asserted before that read lands
// would pass for the wrong reason. The read itself carries the proof: wait
// until the shell asked, confirm the answer is engine-ON, then flush the
// state update that answer commits.
async function settleEngineOnRead(bridge: ReturnType<typeof makeEngineBridge>) {
  await waitFor(() => expect(bridge.getWorkspaceSettings).toHaveBeenCalled());
  const read = await bridge.getWorkspaceSettings();
  expect(read.settings.experimental.workspaceEngineAlpha).toBe(true);
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // The set-aside drafts (#567) live in a module store on purpose; tests
  // that seed it must not leak into each other.
  resetOrphanedDrafts();
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
// One share's durable skip record, as the registry holds it.
const SKIPPED_RECORD = {
  ops: [
    {
      originId: "origin-granter",
      originSeq: 7,
      opKind: "moment.append",
      code: "share-boundary-violation",
      detail:
        "replicated moment is outside the share boundary: the share " +
        "granted version main, the relay offered version version-other",
      atMs: 1000,
    },
  ],
  more: 1,
  generation: 3,
};

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
      pull.resolve({
        status: "updated",
        changedPaths: 1,
        refusedOps: 0,
        refusedDetail: null,
      });
      await pull.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("tab-shared-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  // A refresh can record a refusal on an early page and then die on a later
  // one. The evidence is already durable at that point — reading it only on
  // the success path would keep it invisible until a lucky refresh.
  it("shows a refusal recorded by a refresh that then failed", async () => {
    const bridge = makeBridge(
      Promise.resolve({ ...STORED_STATE, tabs: [], activeTab: null }),
    );
    bridge.refreshSharedView = vi.fn(async () => {
      throw new Error("relay went away mid-page");
    });
    bridge.getWorkspaceRegistry = vi.fn(async () => ({
      workspaces: [
        {
          ...WORKSPACE,
          shareView: {
            shareId: "share-1",
            granterEmail: "granter@dohc.test",
            skippedOps: {
              ops: [
                {
                  originId: "origin-granter",
                  originSeq: 4,
                  opKind: "moment.append",
                  code: "share-boundary-violation",
                  detail: "the share granted version main, the relay offered version other",
                  atMs: 1000,
                },
              ],
              more: 0,
              generation: 1,
            },
          },
        },
      ],
    }));
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
    });

    const refused = await screen.findByTestId("shared-view-refused");
    expect(
      refused.textContent,
      "MUTATION: reading the record only after a successful refresh hides evidence the failed one already wrote",
    ).toContain("dohc skipped 1 update outside what this share covers");
  });

  // The record is written DURING the pull, so a refusal that happens while
  // this shell is mounted has to appear without a remount. Reading the boot
  // snapshot in props would show it only after the workspace is reopened.
  it("shows a refusal recorded by a refresh that ran while the shell was open", async () => {
    const bridge = makeBridge(
      Promise.resolve({ ...STORED_STATE, tabs: [], activeTab: null }),
    );
    let recorded = false;
    bridge.refreshSharedView = vi.fn(async () => {
      // What the recorder does mid-pull: the registry now holds the skip.
      recorded = true;
      return {
        status: "unchanged" as const,
        changedPaths: 0,
        refusedOps: 1,
        refusedDetail: "the share granted version main, the relay offered version other",
      };
    });
    bridge.getWorkspaceRegistry = vi.fn(async () => ({
      workspaces: [
        {
          ...WORKSPACE,
          shareView: {
            shareId: "share-1",
            granterEmail: "granter@dohc.test",
            ...(recorded
              ? {
                  skippedOps: {
                    ops: [
                      {
                        originId: "origin-granter",
                        originSeq: 7,
                        opKind: "moment.append",
                        code: "share-boundary-violation",
                        detail:
                          "the share granted version main, the relay offered version other",
                        atMs: 1000,
                      },
                    ],
                    more: 0,
                    generation: 3,
                  },
                }
              : {}),
          },
        },
      ],
    }));
    // Mounts with NO skip record: the shell's boot snapshot is healthy.
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
    });

    const refused = await screen.findByTestId("shared-view-refused");
    expect(
      refused.textContent,
      "MUTATION: reading the boot snapshot hides a refusal until the workspace is reopened",
    ).toContain("dohc skipped 1 update outside what this share covers");
  });

  // A refused op is SKIPPED and the pull keeps going, so the shared view goes
  // on looking healthy while it quietly stops carrying part of what the
  // granter shares. The warning comes from the RECORD, not from the last
  // refresh: the cursor has committed past those ops, so a quiet refresh must
  // not clear it and a restart must not lose it.
  it("says so when a share's record holds ops its pulls skipped", async () => {
    const bridge = makeBridge(
      Promise.resolve({ ...STORED_STATE, tabs: [], activeTab: null }),
    );
    // A refresh that finds nothing new. The warning must survive it.
    bridge.refreshSharedView = vi.fn(async () => ({
      status: "unchanged" as const,
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    }));
    const dismiss = vi.fn(
      async (_payload: { workspaceId: string; generation: number }) => undefined,
    );
    bridge.dismissShareSkips = dismiss;
    // The record the shell re-reads. Dismissing does NOT delete it: main
    // raises acknowledgedGeneration and the ops stay, so the fixture models
    // that rather than a record that vanishes.
    let acknowledged = 0;
    bridge.getWorkspaceRegistry = vi.fn(async () => ({
      workspaces: [
        {
          ...WORKSPACE,
          shareView: {
            shareId: "share-1",
            granterEmail: "granter@dohc.test",
            skippedOps: {
              ...SKIPPED_RECORD,
              acknowledgedGeneration: acknowledged,
            },
          },
        },
      ],
    }));
    dismiss.mockImplementation(async (payload) => {
      acknowledged = payload.generation;
      return undefined;
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: {
        shareId: "share-1",
        granterEmail: "granter@dohc.test",
        skippedOps: SKIPPED_RECORD,
      },
    });

    const lines = await screen.findAllByTestId("shared-view-refused");
    const boundary = lines.find(
      (line) => line.getAttribute("data-kind") === "boundary",
    );
    expect(
      boundary?.textContent,
      "MUTATION: reading the last refresh instead of the record clears the warning while the content is still missing",
    ).toContain("dohc skipped 1 update outside what this share covers");
    expect(boundary?.textContent).toContain("granter@dohc.test");
    expect(boundary?.getAttribute("title")).toContain("version-other");
    // The overflow keeps no class, so it names no cause and sends the reader
    // nowhere.
    const overflow = lines.find(
      (line) => line.getAttribute("data-kind") === "unknown",
    );
    expect(overflow?.textContent).toContain(
      "dohc skipped 1 more update from this share",
    );
    expect(overflow?.textContent).not.toContain("granter@dohc.test");

    // The only honest recovery this surface has: the user says they have seen
    // it. That is recorded durably — and it HIDES the warning rather than
    // deleting the evidence, because the content it names is gone for good.
    await userEvent.click(
      screen.getAllByTestId("shared-view-refused-dismiss")[0]!,
    );
    expect(dismiss).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      // The generation on screen: a refusal recorded since this render is not
      // acknowledged by this click.
      generation: SKIPPED_RECORD.generation,
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId("shared-view-refused")).toHaveLength(0);
    });
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

  // The session signal reaches the SHELL: cloudStatus derives the presence
  // collaboration, so a sign-out must tear the old account's presence down
  // (abort its long poll) and re-query the status immediately — not when
  // some later refresh notices.
  it("tears presence down and re-queries cloud status on a session change", async () => {
    const user = userEvent.setup();
    const sessionListeners: Array<
      (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void
    > = [];
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [CHATS_TAB_PATH],
        activeTab: CHATS_TAB_PATH,
        chatsVisible: false,
      }),
    );
    bridge.onCloudSessionChanged = vi.fn(
      (
        callback: (event: {
          sessionKey: string | null;
          phase: "changing" | "ready";
        }) => void,
      ) => {
        sessionListeners.push(callback);
        return () => {};
      },
    );
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      relayUrl: "wss://relay.dohc.test",
      workspaceSynced: true,
    }));
    bridge.listChatChannels = vi.fn(async () => ({
      channels: [
        {
          id: "channel-team",
          name: "team",
          slug: "team",
          kind: "channel" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
          threadCount: 0,
          unreadCount: 0,
        },
      ],
      fileThreads: [],
    }));
    const presence = Object.assign(bridge, {
      listChatChannelShares: vi.fn(async () => ({
        joined: [],
        sessionKey: "session-a",
        relay: { state: "answered" as const, granted: [], received: [] },
      })),
      presencePublish: vi.fn(async () => ({
        ok: true as const,
        snapshot: { version: 1, peers: [] },
      })),
      presencePoll: vi.fn(() => new Promise(() => {})),
      presenceCancel: vi.fn(async () => ({ ok: true as const })),
    });
    renderShell(presence);

    // Enter a channel in the Chats page: presence engages for its scope.
    await user.click(await screen.findByTestId("chats-channel"));
    await waitFor(() => expect(presence.presencePublish).toHaveBeenCalled());
    const statusQueries = bridge.cloudStatus.mock.calls.length;

    // Sign out. The signal alone must tear presence down — the collaboration
    // rebuilds dormant off the dropped status — and re-query the status.
    act(() => {
      for (const listener of sessionListeners) {
        listener({ sessionKey: null, phase: "ready" });
      }
    });
    await waitFor(() => expect(presence.presenceCancel).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.cloudStatus.mock.calls.length).toBeGreaterThan(statusQueries),
    );
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

  // #591: the in-thread reply-parent jump. It is the one command in the page
  // that writes NO navigation — it only scrolls — so every other seam here
  // (the destination write, the remount, the nav report) sees nothing move.
  // A DM lookup that answers afterwards would still replace the page with the
  // conversation the user left, taking away the message they just jumped to.
  it("discards an in-flight DM navigation when a reply-parent jump scrolls in place", async () => {
    const user = userEvent.setup();
    const bridge = chatsPageBridge(CHATS_PAGE_STATE);
    // A nested reply is what renders the parent backlink: the opening message,
    // a comment on it, and a reply to that comment.
    bridge.listChatMessages = vi.fn(async () => ({
      messages: [
        {
          id: "message-feed",
          threadId: "thread-team",
          authorKind: "human" as const,
          authorDisplayName: "You",
          body: "Feed update worth revisiting",
          createdAtMs: 1,
        },
        {
          id: "message-comment",
          threadId: "thread-team",
          parentMessageId: "message-feed",
          authorKind: "human" as const,
          authorDisplayName: "You",
          body: "A comment on it",
          createdAtMs: 2,
        },
        {
          id: "message-reply",
          threadId: "thread-team",
          parentMessageId: "message-comment",
          authorKind: "human" as const,
          authorDisplayName: "You",
          body: "A reply to the comment",
          createdAtMs: 3,
        },
      ],
    }));
    renderShell(bridge);

    // Land in the thread via the feed.
    await user.click(await screen.findByTestId("chats-feed-link"));
    const post = await screen.findByText("Feed update worth revisiting");
    await user.click(post.closest("button")!);
    expect(await screen.findByTestId("chats-thread-view")).toBeTruthy();
    const backlink = await screen.findByTestId("chats-reply-context");

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

    // The DM answers in the same tick the user jumps to the parent.
    const overviewLoadsBefore = bridge.listChatChannels.mock.calls.length;
    await act(async () => {
      bridge.syncAnswers.at(-1)!({ available: true, dms: [CANONICAL_DM] });
      backlink.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId("chats-thread-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
    // The proof, as in the feed-click race: a DM answer that wins remounts the
    // page and loads the overview again. The cancel won only if it did not.
    expect(bridge.listChatChannels.mock.calls.length).toBe(overviewLoadsBefore);
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
    // kills the recurring listEngineMoments error loop. The residual this
    // used to name — one engine fetch firing before the FIRST status lands —
    // is closed by the test below.
    const statusCalls = bridge.getSyncStatus.mock.calls.length;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() =>
      expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(statusCalls),
    );
    expect(bridge.listEngineMoments).not.toHaveBeenCalled();
  });

  // #637 item 2: the window before main's capture decision. The refresh runs
  // on ANY workspace's activity event, so it is not bounded by this
  // workspace's open resolving — and in that window `statusSaysNoRecorder`
  // reads a missing or default status as a recorder, so the engine branch
  // asked for moments main was about to refuse. The rail could not state the
  // answer either: it does not have one yet.
  it("asks for no history before main's capture decision lands", async () => {
    const FAILED_HISTORY_STATUS = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      historyRecordingUnavailable: true,
    };
    const decision = deferred<typeof FAILED_HISTORY_STATUS>();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(() => decision.promise);
    // Main's answer while the build runs: the entry exists, and its recorder
    // fields are still the defaults it registered before awaiting the build.
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () =>
      decided ? FAILED_HISTORY_STATUS : SYNC_STATUS,
    );
    bridge.listEngineMoments = vi.fn(async (): Promise<never> => {
      throw new Error("Engine history is not enabled for this workspace.");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    // The premise: the renderer's own read said engine-ON, and the decision
    // has not landed.
    await screen.findByTestId("titlebar-chats-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    await user.click(screen.getByTestId("activity-history"));

    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });
    expect(bridge.listEngineMoments).not.toHaveBeenCalled();
    // And the rail claims nothing while it knows nothing: a placeholder here
    // would name a cause main has not established (#542).
    expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();

    // The decision lands, and it is the failure. Now the rail may speak.
    await act(async () => {
      decided = true;
      decision.resolve(FAILED_HISTORY_STATUS);
      await decision.promise;
    });
    const placeholder = await screen.findByTestId("history-off-placeholder");
    expect(placeholder.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );
    expect(bridge.listEngineMoments).not.toHaveBeenCalled();
  });

  // The other half of that branch: a healthy workspace's history must still
  // load. Without this, holding the rail in its load state forever keeps the
  // test above green.
  it("loads history once main's capture decision says a recorder exists", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
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
  // DESIGN — a capability, not an opt-out, so no Settings blame. The status
  // is the one main REALLY produces for a shared view (capture === null sets
  // historyRecordingOff, and the decision carries historyShareView): with a
  // causeless fixture the share branch would be reached through a status no
  // real share view has, and demoting it below the status checks — the #540
  // bug reborn as Settings copy — would survive this suite.
  it("states the shared-view capability instead of blaming Settings", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const shareStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      historyShareView: true,
    };
    bridge.openWorkspace = vi.fn(async () => shareStatus);
    bridge.getSyncStatus = vi.fn(async () => shareStatus);
    const user = userEvent.setup();
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test" },
    });

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    await waitFor(() =>
      expect(placeholder.textContent).toContain("A shared view records no history"),
    );
    expect(placeholder.textContent).not.toContain("Settings");
  });

  // #540 on the History surface itself: a shared view materializes no
  // settings file, so the renderer's settings read comes back with the
  // default flag ON — but the share's open deliberately installed no
  // capture, so every engine call can only error. The surface must state
  // the capability instead, and must never ask main for engine moments.
  it("gives a shared view the capability truth and never asks for engine moments", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    // The status a real share view carries (capture === null, share cause).
    const shareStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      historyShareView: true,
    };
    bridge.openWorkspace = vi.fn(async () => shareStatus);
    bridge.getSyncStatus = vi.fn(async () => shareStatus);
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
    // The status a real share view carries (capture === null, share cause).
    const shareStatus = {
      ...SYNC_STATUS,
      historyRecordingOff: true,
      historyShareView: true,
    };
    bridge.openWorkspace = vi.fn(async () => shareStatus);
    bridge.getSyncStatus = vi.fn(async () => shareStatus);
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

  // #593: a null page is not "no changes". Before the first read answers, the
  // surface knows nothing, and it may claim neither an empty workspace nor a
  // failure. The moment the read ANSWERS with an empty timeline, the empty
  // copy is earned.
  it("claims neither empty nor failed until the first read answers", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => first.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();

    await act(async () => {
      first.resolve(historyPage([]));
      await first.promise;
    });
    expect(await screen.findByText("No changes yet")).toBeTruthy();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // #610: one refresh issues four reads, and they answer four different
  // questions. Awaiting them as one batch made the timeline report a failure
  // that happened somewhere else — the engine had already served the page.
  // The failure is still reported; it is reported about the read that had it.
  it("keeps the history page a sibling read's failure never touched", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.getTryInVersionState = vi.fn(() =>
      Promise.reject(new Error("try state failed")),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.queryByText("No changes yet")).toBeNull();
    // Three lanes share one banner, so the sentence has to say WHICH one went
    // stale — the cause alone names none of them — and it has to offer the way
    // back that the rendered timeline has just hidden.
    const banner = await screen.findByTestId("workspace-shell-error");
    expect(banner.textContent).toContain(
      "dohc could not refresh this workspace's try run.",
    );
    expect(banner.textContent).toContain("try state failed");
    expect(screen.getByTestId("workspace-shell-error-retry")).toBeTruthy();
  });

  // The reverse path, end to end. Separating the lanes took one away: a
  // sibling that fails while the page succeeds renders the timeline, and the
  // timeline hides History's Try again — so the only control that could reach
  // this read is the one on the banner. It has to WORK, not just be there.
  it("asks the failed lane again from the banner", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    let nextStatus: typeof SYNC_STATUS | typeof syncingStatus = SYNC_STATUS;
    let failNextRead = false;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.getSyncStatus = vi.fn(() => {
      if (failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("sync status failed"));
      }
      return Promise.resolve(nextStatus);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();

    failNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(failNextRead).toBe(false));

    // The page renders, so History's own retry is not on screen. The banner
    // names the lane and carries the only way back.
    const banner = await screen.findByTestId("workspace-shell-error");
    expect(banner.textContent).toContain("dohc could not refresh sync status.");
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.getByText("Wrote the plan")).toBeTruthy();

    // The workspace moved on while the lane was stale.
    nextStatus = syncingStatus;
    await user.click(screen.getByTestId("workspace-shell-error-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Independent of each other's SUCCESS is only half of it. A refresh that
  // waits for all four answers before handling any of them is hostage to the
  // slowest lane: a history read that already failed would sit in
  // "Loading history..." behind a sibling that never settles, with no failure
  // and no way to ask again — worse than the batch it replaced, which at
  // least gave up as soon as history did.
  it("says the history read failed while a sibling read never settles", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => Promise.reject(new Error("history failed")));
    bridge.getSyncStatus = vi.fn(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();
    // The Next has to be there too, not just the sentence.
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Loading history...")).toBeNull();
  });

  // The mirror: a page the engine already served is nobody's hostage either.
  it("shows the history page while a sibling read never settles", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.getTryInVersionState = vi.fn(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // The same rule read the other way: the history read is nobody else's
  // answer either. A try session the main process reported still reaches its
  // card while the timeline says it could not load.
  it("shows the try review a failed history read did not answer for", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => Promise.reject(new Error("history failed")));
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();
  });

  // The failure is an answer, and the same ordering rule governs it: an older
  // read falling over while a newer one is still in flight has settled
  // nothing. Calling the surface unloadable there would offer a Try again for
  // a read already on its way.
  it("waits for the newest read before calling the surface unloadable", async () => {
    let failOlder!: (error: Error) => void;
    const older = new Promise<never>((_resolve, reject) => {
      failOlder = reject;
    });
    const newer = deferred<ListEngineMomentsResult>();
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => (++issued === 1 ? older : newer.promise));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));

    await act(async () => {
      failOlder(new Error("older read failed"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("history-load-failed")).toBeNull();

    await act(async () => {
      newer.resolve(historyPage([historyMoment("m-1", "Wrote the plan")]));
      await newer.promise;
    });
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
  });

  // A retry that still shows the failure it is retrying gives the user no
  // sign it took, and would keep offering the button while a read is already
  // on its way. Issuing a read says the surface does not know again — the
  // same thing the first load says.
  it("the retry shows a read on the way, not the failure it is retrying", async () => {
    let failFirst!: (error: Error) => void;
    const first = new Promise<never>((_resolve, reject) => {
      failFirst = reject;
    });
    const second = deferred<ListEngineMomentsResult>();
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => (++issued === 1 ? first : second.promise));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(1));
    await act(async () => {
      failFirst(new Error("history failed"));
      await Promise.resolve();
    });
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.getByText("Loading history...")).toBeTruthy();

    await act(async () => {
      second.resolve(historyPage([historyMoment("m-1", "Wrote the plan")]));
      await second.promise;
    });
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
  });

  // #593's vector, the double failure #588's review found: a switch fails, its
  // recovery read fails, the lookup contradicts the stranded page, and the
  // re-fetch that drop owes fails too. The surface then has no page and no
  // way to get one — and it used to answer that by telling a workspace with
  // real history that it had no changes.
  it("never says 'No changes yet' for a read that failed", async () => {
    const stranded = deferred<ListEngineMomentsResult>();
    const retry = deferred<ListEngineMomentsResult>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    let failRefetch!: (error: Error) => void;
    const refetch = new Promise<never>((_resolve, reject) => {
      failRefetch = reject;
    });
    const responses: Promise<ListEngineMomentsResult>[] = [
      stranded.promise,
      switchRefresh,
      refetch,
      retry.promise,
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

    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "main" });
      await lookup.promise;
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(3));
    await act(async () => {
      failRefetch(new Error("re-fetch failed"));
      await Promise.resolve();
    });

    // No page, and no read on the way. The surface says what happened.
    await waitFor(() => expect(screen.getByTestId("history-load-failed")).toBeTruthy());
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(screen.getByTestId("history-load-failed").textContent).toContain(
      "dohc could not load this workspace's history.",
    );

    // The Next has to WORK on this surface (copy.md): the control reads again.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(4));
    await act(async () => {
      retry.resolve(historyPage([historyMoment("m-main", "Back on main")], "main"));
      await retry.promise;
    });
    expect(await screen.findByText("Back on main")).toBeTruthy();
  });

  // #594: the named road to the same wrong pixels. The switch SUCCEEDS, so it
  // names the version it landed on and nothing has to be looked up — but the
  // page on screen is still the version the user left, and the follow-up
  // refresh is the only thing that would replace it. When that refresh fails,
  // the timeline used to keep naming a version nobody is on.
  it("retracts the old version's timeline when the switch succeeds and its refresh fails", async () => {
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => {
      issued += 1;
      if (issued === 1) {
        return Promise.resolve(
          historyPage(
            [historyMoment("m-try", "Wrote the note in the try version")],
            "try-1",
          ),
        );
      }
      if (issued === 2) return switchRefresh;
      return new Promise<never>(() => {});
    });
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
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(async () => {
      versionReads += 1;
      return {
        versions: versionList,
        activeVersionId: versionReads === 1 ? "try-1" : "main",
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => ({
      activeVersionId: "main",
      changedFileCount: 0,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

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

    // The workspace is on Main. Nothing may still show the try version's
    // moments, and the blank they leave must not read as an empty workspace.
    await waitFor(() =>
      expect(screen.queryByText("Wrote the note in the try version")).toBeNull(),
    );
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();
  });

  // The other verdict on the named path, and the reason the retraction is a
  // question and not a blanket blank: the refresh succeeds, and the timeline
  // is simply the new version's.
  it("shows the new version's timeline when the switch and its refresh succeed", async () => {
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => {
      issued += 1;
      if (issued === 1) {
        return Promise.resolve(
          historyPage(
            [historyMoment("m-try", "Wrote the note in the try version")],
            "try-1",
          ),
        );
      }
      return Promise.resolve(
        historyPage([historyMoment("m-main", "Back on main")], "main"),
      );
    });
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
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(async () => {
      versionReads += 1;
      return {
        versions: versionList,
        activeVersionId: versionReads === 1 ? "try-1" : "main",
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => ({
      activeVersionId: "main",
      changedFileCount: 0,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    expect(await screen.findByText("Back on main")).toBeTruthy();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
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

  // A failure reports, and it takes nothing. The lane's watermark is what an
  // ANSWER earns: a read that failed proves nothing, and the older read still
  // in flight may be the only answer anyone gets. Moving the watermark on a
  // rejection would reject that answer when it lands, and the status bar would
  // sit on a value the workspace has left with nothing to correct it (#507).
  it("commits an older sync status when the newer read failed", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    const heldStatus = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    // Which read gets what is set by this test, not by a call count: the shell
    // reads status more than once while a workspace opens.
    let holdNextRead = false;
    let failNextRead = false;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (holdNextRead) {
        holdNextRead = false;
        return heldStatus.promise;
      }
      if (failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("sync status failed"));
      }
      return Promise.resolve(SYNC_STATUS);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    expect(screen.getByTestId("sync-status").dataset.state).toBe("synced");

    // One refresh's status read is still in flight.
    holdNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(holdNextRead).toBe(false));

    // A newer refresh asks the same lane, and its read fails. The failure is
    // reported — nothing else can say the shown value is now old.
    failNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(failNextRead).toBe(false));
    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();

    // Then the older read answers. It is the only answer this lane has.
    await act(async () => {
      heldStatus.resolve(syncingStatus);
      await heldStatus.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
  });

  // What `committed` is FOR, on the success path: latest-committed-wins. Two
  // refreshes overlap, the newer answers first, and the older must not paint
  // its stale value over it when it finally lands.
  it("keeps an older answer from overwriting a newer one on the same lane", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    const olderRead = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    let nextRead: "older" | null = null;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (nextRead === "older") {
        nextRead = null;
        return olderRead.promise;
      }
      return Promise.resolve(syncingStatus);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());

    // The older refresh's read is still in flight when a newer one answers.
    nextRead = "older";
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(nextRead).toBeNull());
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );

    // The older answer lands last and says something the workspace has left.
    await act(async () => {
      olderRead.resolve(SYNC_STATUS);
      await olderRead.promise;
    });
    expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing");
  });

  // The third way a failure can be superseded, and the one only `committed`
  // catches. The user acted, so this lane holds a value newer than every
  // request in flight — but the lane ASKED nothing, so its newest issued read
  // is still the one now failing. A banner about a card the user dismissed
  // describes nothing on screen.
  it("keeps a failed read from reporting after the user superseded its lane", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const refreshed = deferred<ListEngineMomentsResult>();
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      refreshed.promise,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    let failSecondTryRead!: (error: Error) => void;
    const secondTryRead = new Promise<never>((_resolve, reject) => {
      failSecondTryRead = reject;
    });
    let tryReads = 0;
    bridge.getTryInVersionState = vi.fn(() => {
      tryReads += 1;
      if (tryReads === 1) return Promise.resolve({ state: REVIEW_STATE });
      return secondTryRead;
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await act(async () => {
      first.resolve(historyPage([historyMoment("m-first", "Added the launch checklist")]));
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A refresh is in flight, and its try read has not answered.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.getTryInVersionState).toHaveBeenCalledTimes(2));

    // The user dismisses the review. That is newer than every request issued.
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    // The read the user superseded now fails. It has nothing to report.
    await act(async () => {
      failSecondTryRead(new Error("try state failed"));
      await Promise.resolve();
    });
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("try-review-card")).toBeNull();
  });

  // The same rule, the other ordering. Above, the newer answer had already
  // committed when the older read failed. Here it has not answered yet — so
  // "what did this lane last write" cannot see it, and the failure looks like
  // the newest thing there is. It is not: the lane has already ASKED again.
  // Reporting raises a banner that the newer answer will not take down, and it
  // then sits over a value the user can see is current.
  it("keeps a failed read from reporting while a newer one is in flight", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    let failOlderRead!: (error: Error) => void;
    const olderRead = new Promise<never>((_resolve, reject) => {
      failOlderRead = reject;
    });
    const newerRead = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    let nextRead: "older" | "newer" | null = null;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (nextRead === "older") {
        nextRead = null;
        return olderRead;
      }
      if (nextRead === "newer") {
        nextRead = null;
        return newerRead.promise;
      }
      return Promise.resolve(SYNC_STATUS);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // Two refreshes overlap on this lane. Neither has answered.
    nextRead = "older";
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(nextRead).toBeNull());
    nextRead = "newer";
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(nextRead).toBeNull());

    // The older one fails first. The lane has already asked again, so this
    // failure has nothing to say.
    await act(async () => {
      failOlderRead(new Error("sync status failed"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // The newer one answers, and its value stands with no banner beside it.
    await act(async () => {
      newerRead.resolve(syncingStatus);
      await newerRead.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The twin of the test above, on the other way a read settles. The lane's
  // own reader answers the observation, and that read can FAIL — after a newer
  // refresh already committed the lane. A failure judged without the token
  // then raises a banner about a reading nothing is showing: the newer answer
  // is on screen, correct, and the user is told it could not be read.
  it("keeps a failed agent-lane read from reporting over a newer refresh", async () => {
    const first = deferred<ListEngineMomentsResult>();
    const afterTheRun = deferred<ListEngineMomentsResult>();
    const responses: Promise<ListEngineMomentsResult>[] = [
      first.promise,
      afterTheRun.promise,
    ];
    let issued = 0;
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.listEngineMoments = vi.fn(() => responses[issued++]!);
    // The observation's own read is the one that fails, and it is the first
    // agent read issued after the held panel read is released — nothing else
    // asks in between, because every shell refresh here is driven by the test.
    let failNextAgentRead = false;
    let failObservationRead!: (error: Error) => void;
    let runIsAlive = false;
    bridge.getAgentRunStatus = vi.fn(() => {
      if (failNextAgentRead) {
        failNextAgentRead = false;
        return new Promise<never>((_resolve, reject) => {
          failObservationRead = reject;
        });
      }
      return Promise.resolve({
        mcpEnabled: true,
        activeRun: runIsAlive
          ? {
              id: "run-1",
              startedAt: 1,
              agentId: "agent-1",
              onBehalfOf: "ice",
              status: "running" as const,
            }
          : null,
        lastRun: null,
      });
    });
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

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Agents & MCP",
      ),
    );
    await screen.findByTestId("mcp-enable-toggle");

    // A run starts under the rendered label, so the toggle's reread reports it
    // rather than starting or ending anything.
    runIsAlive = true;
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await waitFor(() => expect(heldPanelReads.length).toBe(1));

    // Release the reread. The observation lands and asks the lane's own
    // reader, whose read is the one that will fail.
    failNextAgentRead = true;
    await act(async () => {
      for (const answerRead of heldPanelReads) answerRead();
      await Promise.resolve();
    });
    await waitFor(() => expect(failObservationRead).toBeTruthy());

    // A newer refresh answers the same lane first, and it says the run is
    // alive. That is what the user is looking at.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledTimes(2));
    await act(async () => {
      afterTheRun.resolve(historyPage([historyMoment("m-after", "Rewrote the plan")]));
      await afterTheRun.promise;
    });
    expect(await screen.findByTestId("agent-run-indicator")).toBeTruthy();

    // Only now does the older read fail. It has nothing to report: the lane
    // already holds a newer answer, and it is on screen.
    await act(async () => {
      failObservationRead(new Error("agent status failed"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.getByTestId("agent-run-indicator")).toBeTruthy();
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

// #589: a shared view materializes no settings file, so the renderer's
// capability read comes back with the schema default ON — but its open
// deliberately installed no capture, and main refuses every version call.
// The selector retried five times and then raised a danger-tone shell error
// naming a Settings toggle nobody touched, and it came back on every share
// refresh (the selector re-keys on versionEpoch).
describe("shared view versions surface", () => {
  it("never asks a shared view for versions, and raises no banner across a share refresh", async () => {
    const bridge = makeShareBridge();
    bridge.refreshSharedView = vi.fn(async () => ({
      status: "updated" as const,
      changedPaths: 1,
      refusedOps: 0,
      refusedDetail: null,
    }));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    // Prove the renderer's read really said engine-ON first. Without it the
    // pins below pass vacuously in the pre-read window.
    await settleEngineOnRead(bridge);
    // The selector is the surface that made the call, and it carries the
    // Try-in-version and compare entry points inside its menu — all three go
    // with it.
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    // The banner is that call's consequence — the selector raises it after
    // five failed attempts over ~5 seconds — so the no-call pin above is what
    // this assertion rests on, not a race with the retry window.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // The share refresh is what made the banner RECUR: its versionEpoch bump
    // re-keys the selector's mount effect. With the selector gone there is no
    // key to bump, so this drives the whole refresh path (pull → file listing
    // → epoch) and pins that nothing along it asks main for versions.
    const pulls = bridge.refreshSharedView.mock.calls.length;
    await user.click(screen.getByTestId("shared-view-refresh"));
    await waitFor(() =>
      expect(bridge.refreshSharedView.mock.calls.length).toBeGreaterThan(pulls),
    );
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // A shared view in the pre-status window. This test was written to isolate
  // the share clause, and it no longer can: once the versions gate required
  // an ANSWERED status (#620), that clause stopped being the only thing that
  // answers here, and main gives a shared view `capture: null` — hence
  // `historyRecordingOff: true` — for the whole of its life
  // (`workspaceActivity.ts`: `entry.historyRecordingOff = entry.capture ===
  // null`). So `!isShareView` inside `versionsEnabled` is now redundant with
  // the status clause and survives deletion. It is kept, and declared
  // unpinned, because it is the SYNCHRONOUS registry fact #614's review
  // asked for: it does not depend on main's status shape staying this way.
  // What this test still pins is the no-call itself, in the window where the
  // shell knows least.
  it("asks a shared view for no versions before its first status arrives", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge();
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    await settleEngineOnRead(bridge);
    // The premise: no status has answered, so the shell knows nothing about
    // the recorder yet.
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    // And it stays gone once the status agrees.
    await act(async () => {
      status.resolve(SHARE_STATUS);
      await status.promise;
    });
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
  });

  // The other half of that branch: a workspace that is NOT a shared view must
  // still get the real page. Without this, replacing VersionComparePage with
  // the placeholder for EVERY workspace keeps this suite green, and only an
  // e2e — which the javascript gate does not run — would catch it.
  it("keeps the real compare page for a persisted compare tab outside a shared view", async () => {
    const comparePath = versionCompareTabPath("v-old");
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [comparePath],
        activeTab: comparePath,
      }),
    );
    renderShell(bridge);

    expect(await screen.findByTestId("version-compare-page")).toBeTruthy();
    expect(screen.queryByTestId("version-compare-share-view")).toBeNull();
  });

  it("states the capability for a persisted compare tab instead of a page that can only fail", async () => {
    const comparePath = versionCompareTabPath("v-old");
    const bridge = makeShareBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [comparePath],
        activeTab: comparePath,
      }),
    );
    renderShell(bridge, SHARE_VIEW);

    // One line, per the empty-state recipe (copy.md): what is missing, then
    // the next step this surface really has — the tab closes.
    const placeholder = await screen.findByTestId("version-compare-share-view");
    expect(placeholder.textContent).toContain(
      "A shared view has no versions to compare. Close this tab to go back to the shared files.",
    );
    // The empty-state recipe's tone, not the neighbouring legacy note's
    // (copy.md: one text-sm text-muted line).
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });
});

// #620: the same error loop from the other cause, on a workspace that is NOT
// a shared view. After a failed capture build main has no capture, so every
// version call is refused — while the renderer's own settings read still says
// engine-on. History has carried main's status override since #601; versions
// did not, so the selector rendered, retried, and raised the danger banner.
describe("versions surface after a failed capture build", () => {
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingOff: true,
    historyRecordingUnavailable: true,
  };

  it("renders no version surface and never asks for versions when the recorder failed to build", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => FAILED_STATUS);
    bridge.getSyncStatus = vi.fn(async () => FAILED_STATUS);
    // Main's REAL answer once the capture build failed (#541 copy).
    bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
      throw new Error(
        "dohc could not start Versions for this workspace. Restart dohc to try again.",
      );
    });
    renderShell(bridge);

    // Both halves of the premise, before anything is pinned: the renderer's
    // own read said engine-ON (this control renders on that read alone), and
    // main's status has landed carrying the failure. Without them the no-call
    // below passes vacuously in the pre-read window.
    await screen.findByTestId("titlebar-chats-sidebar");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    // The banner is that call's consequence, five failed attempts later.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The other half of the branch: a healthy engine workspace must still get
  // the selector. Without this, dropping the version surface for EVERY
  // workspace keeps the suite above green.
  it("keeps the version selector when main's status reports a live recorder", async () => {
    const bridge = makeEngineBridge(Promise.resolve(null));
    renderShell(bridge);

    expect(await screen.findByTestId("version-menu-button")).toBeTruthy();
    await waitFor(() => expect(bridge.listWorkspaceVersions).toHaveBeenCalled());
  });

  // The window the test above cannot see. Its status fake answers in the same
  // microtask flush as the settings read, and PRODUCTION NEVER DOES:
  // `getWorkspaceSettings` is one file read, while `openWorkspace` waits for
  // the capture build and then for main's watcher to finish its first scan.
  // Engine-ON therefore lands first on every open, and a MISSING status used
  // to answer "there is a recorder": the selector mounted, called, retried
  // five times and raised #620's banner inside a window the fixture had
  // closed.
  //
  // So this open does NOT resolve in the same flush.
  it("asks for no versions before main's capture decision lands", async () => {
    const decision = deferred<typeof FAILED_STATUS>();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(() => decision.promise);
    bridge.getSyncStatus = vi.fn(() => decision.promise);
    bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
      throw new Error(
        "dohc could not start Versions for this workspace. Restart dohc to try again.",
      );
    });
    renderShell(bridge);

    // Both halves of the premise. The titlebar Chats button renders on the
    // renderer's own read alone, so it proves that read answered engine-ON;
    // `data-ready` proves the open has not resolved.
    await screen.findByTestId("titlebar-chats-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");

    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    // And the answer keeps it that way — no banner from retries that never
    // started.
    await act(async () => {
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The same window, entered the way production actually enters it: through
  // an activity refresh, while main's entry still holds the defaults it
  // registered before it awaited the capture build.
  //
  // `workspaceActivity.open` registers that entry BEFORE the build — it must,
  // so a batch settling during the build finds a slot — and until the build
  // answers it holds `historyRecordingOff: false` and
  // `historyRecordingUnavailable: false`. Any workspace's activity event
  // makes this shell refresh, so the refresh is what used to read those
  // defaults and commit them as a status. Reading THAT as "there is a
  // recorder" is the same defect as reading a missing status that way, one
  // indirection along.
  //
  // The refresh no longer reads them at all (#637): before the decision it
  // returns, because both of its branches are wrong in this window — and the
  // status it used to commit could arrive AFTER the decided one and put the
  // defaults back. So this pins two things at once: the refresh asks main
  // nothing here, and the gate stays shut through the whole window on the
  // decision alone.
  it("asks main for nothing while its capture decision is still pending", async () => {
    const settings = deferred<WorkspaceSettingsResult>();
    const decision = deferred<typeof FAILED_STATUS>();
    const bridge = makeEngineBridge(Promise.resolve(null));
    bridge.getWorkspaceSettings = vi.fn(() => settings.promise);
    bridge.openWorkspace = vi.fn(() => decision.promise);
    // Main's answer BEFORE the decision: the entry exists and its recorder
    // fields are still at their defaults. After the decision it reports what
    // was decided. A fake that refused before the decision, or kept answering
    // with the defaults after it, would model something main cannot do — and
    // the second of those is what this pin is about.
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () => (decided ? FAILED_STATUS : SYNC_STATUS));
    bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
      throw new Error(
        "dohc could not start Versions for this workspace. Restart dohc to try again.",
      );
    });
    renderShell(bridge);

    // Another workspace records a batch. The shell refreshes — and asks main
    // for nothing, because the only status available to it here is the
    // pre-decision default.
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });
    expect(bridge.getSyncStatus).not.toHaveBeenCalled();
    expect(bridge.listEngineMoments).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");

    // Now the renderer's read answers engine-ON. Every input the old gate had
    // now says "recorder", and main has still decided nothing.
    await act(async () => {
      settings.resolve({
        settings: {
          ...DEFAULT_WORKSPACE_SETTINGS,
          experimental: {
            ...DEFAULT_WORKSPACE_SETTINGS.experimental,
            workspaceEngineAlpha: true,
          },
        },
        source: "stored",
      });
      await settings.promise;
    });
    await screen.findByTestId("titlebar-chats-sidebar");

    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    // The decision lands, and it is the failure. Still nothing.
    await act(async () => {
      decided = true;
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The same cause on the surface that outlives the selector. A persisted
  // compare tab was gated on the share fact alone, so a workspace whose
  // capture build failed still mounted VersionComparePage — which asks for
  // the versions on mount and then says "Could not compare with Main."
  // Reached by opening a compare tab while healthy and restarting after a
  // failed build.
  it("states the capability for a persisted compare tab when the recorder failed to build", async () => {
    const comparePath = versionCompareTabPath("v-old");
    const status = deferred<typeof FAILED_STATUS>();
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [comparePath],
        activeTab: comparePath,
      }),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge);

    // Before the decision lands, the tab mounts no page AND claims nothing:
    // the renderer's own read proves nothing about what main recorded (#542).
    await screen.findByTestId("titlebar-chats-sidebar");
    expect(screen.queryByTestId("version-compare-page")).toBeNull();
    expect(screen.queryByTestId("version-compare-off")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    await act(async () => {
      status.resolve(FAILED_STATUS);
      await status.promise;
    });

    // One line, per the empty-state recipe (copy.md), and the cause main
    // established chooses it. The cause here is a BUILD FAILURE, so the line
    // says what dohc could not do and how to retry. It must never say the
    // workspace has no versions: versions made before this session are still
    // on disk, and the restart this very sentence prescribes brings them
    // back.
    const placeholder = await screen.findByTestId("version-compare-off");
    expect(placeholder.textContent).toContain(
      "dohc could not open versions for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(placeholder.textContent).not.toContain("no versions");
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(screen.queryByTestId("version-compare-page")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });
});

// A capability flag is not a count. Whatever main established about the
// RECORDER, none of it establishes that no version exists: versions live on
// disk and outlive a session whose capture failed to build, an engine the
// user switched off, and a settings file dohc could not read. The compare tab
// has no count to read, so it may never claim absence.
describe("version-compare off copy", () => {
  const base = {
    state: "synced" as const,
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    historyRecordingUnavailable: false,
    historyShareView: false,
  };

  it("calls a failed capture build unavailable, never empty", () => {
    // #505's cause. `historyRecordingOff` rides with it, and reading that
    // first would turn a startup failure into a claim about durable data.
    const copy = versionCompareOffCopy({
      ...base,
      historyRecordingOff: true,
      historyRecordingUnavailable: true,
    });
    expect(copy).toBe(
      "dohc could not open versions for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(copy).not.toContain("no versions");
  });

  it("calls the opt-out off, never empty", () => {
    const copy = versionCompareOffCopy({ ...base, historyRecordingOff: true });
    expect(copy).toContain("Versions are off for this workspace.");
    expect(copy).toContain("Settings → Advanced");
    expect(copy).not.toContain("no versions");
  });

  it("names the unreadable settings file instead of blaming the toggle", () => {
    // #483: the opt-out line below names Settings, and nobody touched it.
    const copy = versionCompareOffCopy({
      ...base,
      historyRecordingOff: true,
      settingsWarning: "dohc could not read /w/x/.dohc/settings.json.",
    });
    expect(copy).toBe("dohc could not read /w/x/.dohc/settings.json.");
  });

  it("claims nothing when main established nothing", () => {
    // The renderer's own read failed. It proves nothing either way (#542).
    const copy = versionCompareOffCopy(base);
    expect(copy).toContain("dohc could not confirm whether this workspace has versions.");
    expect(copy).not.toContain("no versions");
  });
});

// The same rule on the Chats surfaces (#628). Whatever main established about
// the RECORDER, none of it establishes that no chat exists: chats live on disk
// and outlive a session whose capture failed to build, an engine the user
// switched off, and a settings file dohc could not read.
describe("chats off copy", () => {
  const base = {
    state: "synced" as const,
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    historyRecordingUnavailable: false,
    historyShareView: false,
  };

  it("calls a failed capture build unavailable, never empty", () => {
    // #505's cause. `historyRecordingOff` rides with it, and reading that
    // first would turn a startup failure into a claim about durable data.
    const copy = chatsOffCopy({
      ...base,
      historyRecordingOff: true,
      historyRecordingUnavailable: true,
    });
    expect(copy).toBe(
      "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(copy).not.toContain("no chats");
  });

  it("calls the opt-out off, never empty", () => {
    const copy = chatsOffCopy({ ...base, historyRecordingOff: true });
    expect(copy).toContain("Chats are off for this workspace.");
    expect(copy).toContain("Settings → Advanced");
    expect(copy).not.toContain("no chats");
  });

  // The Next has to be the one that works. Main decides the recorder once per
  // app session — `openWorkspaceActivity` retains every workspace it opens and
  // `workspaceActivity.open` no-ops for one it already watches — so leaving
  // the workspace and coming back re-reads the flag nowhere.
  it("tells the user to restart, not to reopen the workspace", () => {
    const copy = chatsOffCopy({ ...base, historyRecordingOff: true });
    expect(copy).toContain("Turn it on. Then restart dohc to use chats.");
    expect(copy).not.toContain("reopen");
  });

  it("names the unreadable settings file instead of blaming the toggle", () => {
    // #483: the opt-out line above names Settings, and nobody touched it.
    const copy = chatsOffCopy({
      ...base,
      historyRecordingOff: true,
      settingsWarning: "dohc could not read /w/x/.dohc/settings.json.",
    });
    expect(copy).toBe("dohc could not read /w/x/.dohc/settings.json.");
  });

  it("claims nothing when main established nothing", () => {
    // The renderer's own read failed. It proves nothing either way (#542).
    const copy = chatsOffCopy(base);
    expect(copy).toContain("dohc could not confirm whether this workspace has chats.");
    expect(copy).not.toContain("no chats");
  });
});

// #615: a shared view gets no capture, so main refuses listChatChannels,
// listFileChats, syncDms and listChatFileMentions — the panel, the tab and the
// titlebar button all offered a capability the share never had, and showed the
// refusal as an error. These pins cover the SHARE fact only; the failed
// capture build on a normal workspace is the describe below (#628).
describe("shared view chats surface", () => {
  it("offers no Chats on a shared view and never asks main for them", async () => {
    // The stored state opens with the Chats panel visible, so an ungated
    // shell mounts it immediately.
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await settleEngineOnRead(bridge);
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    expect(screen.queryByTestId("titlebar-chats-sidebar")).toBeNull();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.listFileChats).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // The two ways back in that outlive the titlebar button.
    await user.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
    expect(screen.queryByTestId("chats-panel")).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).queryByText("Toggle chats panel")).toBeNull();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });

  it("states the capability for a persisted Chats tab instead of a page that can only fail", async () => {
    const bridge = makeShareBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [CHATS_TAB_PATH],
        activeTab: CHATS_TAB_PATH,
      }),
    );
    renderShell(bridge, SHARE_VIEW);

    // One line, per the empty-state recipe (copy.md): what is missing, then
    // the next step this surface really has — the tab closes.
    const placeholder = await screen.findByTestId("chats-page-share-view");
    expect(placeholder.textContent).toContain(
      "A shared view has no chats. Close this tab to go back to the shared files.",
    );
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    // The neighbouring line blames a Settings flag the share never touched.
    expect(screen.queryByTestId("chats-page-off")).toBeNull();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The other half of BOTH gates: a healthy engine workspace gets the real
  // panel. Without this, hiding Chats from every workspace — or replacing the
  // panel with the failed-capture placeholder on every one — keeps the share
  // pins above and the #628 pins below green.
  it("keeps Chats for a workspace that is not a shared view", async () => {
    const bridge = makeEngineBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
    expect(screen.getByTestId("titlebar-chats-sidebar")).toBeTruthy();
    await waitFor(() => expect(bridge.listChatChannels).toHaveBeenCalled());
    expect(screen.queryByTestId("chats-panel-off")).toBeNull();
  });

  // The graph's chat-mentions toggle, on its own. The test above proves the
  // panel is gone, and the panel's own gate hides it whatever this toggle
  // reads — so reverting THIS gate alone changed nothing any pin could see.
  // It is the most expensive one to lose: `includeChatMentions: true` is what
  // sends readWorkspaceGraph through requireEngineCapture, so an ungated
  // toggle fails the WHOLE graph — a surface a shared view legitimately has.
  it("offers no chat mentions in the graph on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await settleEngineOnRead(bridge);
    await user.click(screen.getByTestId("activity-graph"));

    // The graph itself still works — that is the point.
    expect((await screen.findAllByTestId("graph-file-row")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("graph-chat-mentions-toggle")).toBeNull();
    expect(bridge.readWorkspaceGraph).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      includeChatMentions: false,
    });
    expect(bridge.readWorkspaceGraph).not.toHaveBeenCalledWith(
      expect.objectContaining({ includeChatMentions: true }),
    );
  });

  // Ctrl+Alt+B, on its own. The panel's gate hides it either way, so the only
  // thing this shortcut still decides on a shared view is whether the shell
  // CLAIMS the chord from whatever else would handle it.
  it("does not claim Ctrl+Alt+B on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);
    await settleEngineOnRead(bridge);

    const event = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("claims Ctrl+Alt+B for a workspace that is not a shared view", async () => {
    const bridge = makeEngineBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);
    await screen.findByTestId("chats-panel");

    // The handler re-registers in a passive effect whenever `chatsEnabled`
    // changes, so a single dispatch can land in the commit before that effect
    // runs. Retry with a FRESH event: a stale one carries the previous
    // attempt's defaultPrevented and would pass on the first arming forever.
    await waitFor(() => {
      const event = new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  // The last ungated chat call. Linked mentions ride on every markdown open
  // and every window refocus, and `listChatFileMentions` goes through
  // requireEngineCapture like every other Chats call — so a shared view was
  // still issuing one refused call per file open. Its own `.catch` swallowed
  // the refusal, which is exactly why nothing caught it.
  it("asks for no chat mentions when a shared view opens a file", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);

    // The premise: the file really opened, so the panel that issues the call
    // really mounted.
    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.getBacklinks).toHaveBeenCalled());
    expect(bridge.listChatFileMentions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("still asks for chat mentions when a normal workspace opens a file", async () => {
    const bridge = makeEngineBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    await screen.findByTestId("tab-b.md");
    await waitFor(() =>
      expect(bridge.listChatFileMentions).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        path: "b.md",
      }),
    );
  });

  // The ordering interaction #626 found, on this surface. A shared view's
  // status ALSO says no recorder, so once one lands the status clause alone
  // would produce the same result and the share clause would survive
  // deletion. Holding the status pending is what isolates it: `isShareView`
  // is a synchronous registry fact, and it is the only thing that can answer
  // in this window.
  it("states the shared-view fact for a persisted Chats tab before any status arrives", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [CHATS_TAB_PATH],
        activeTab: CHATS_TAB_PATH,
      }),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    const placeholder = await screen.findByTestId("chats-page-share-view");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(placeholder.textContent).toContain("A shared view has no chats.");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });
});

// #628: the same class as #620, one surface over. On a workspace that is NOT
// a shared view but whose capture build failed, main refuses every Chats call
// — and the shell offered the panel, the tab and the mention surfaces anyway,
// because they read the renderer's own engine flag and nothing else.
//
// Chats is a persistent sidebar rather than a tab, so the copy decision is
// not the one #615 made: hiding it would remove a fixture of the window from
// a workspace that has chats on disk. The panel stays and states the fact.
describe("chats surface after a failed capture build", () => {
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingOff: true,
    historyRecordingUnavailable: true,
  };

  // Main's real answers once the capture build failed: every Chats call goes
  // through requireEngineCapture, which has no capture to hand it.
  function makeFailedCaptureBridge() {
    const bridge = makeEngineBridge(Promise.resolve(STORED_STATE));
    bridge.openWorkspace = vi.fn(async () => FAILED_STATUS);
    bridge.getSyncStatus = vi.fn(async () => FAILED_STATUS);
    for (const call of [
      "listChatChannels",
      "listChannelThreads",
      "listFileChats",
      "listChatFileMentions",
      "syncDms",
    ] as const) {
      bridge[call] = vi.fn(async (): Promise<never> => {
        throw new Error("Chats are not enabled for this workspace.");
      });
    }
    return bridge;
  }

  it("states the fact in the Chats sidebar and asks main for no chats", async () => {
    const bridge = makeFailedCaptureBridge();
    renderShell(bridge);

    // Both halves of the premise: the renderer's own read said engine-ON —
    // the titlebar button renders on that read alone — and main's status has
    // landed carrying the failure.
    await screen.findByTestId("titlebar-chats-sidebar");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    // The sidebar is still there. It is the fixture the user left open, and
    // the workspace's chats are on disk — the capture build is what failed.
    expect(screen.getByTestId("chats-panel")).toBeTruthy();
    const placeholder = await screen.findByTestId("chats-panel-off");
    // One line, per the empty-state recipe (copy.md), chosen by the cause main
    // established: a build failure, so it says what dohc could not do and the
    // one next step that can change it. It must never say the workspace has
    // no chats — those outlive a session whose capture failed to build.
    expect(placeholder.textContent).toContain(
      "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(placeholder.textContent).not.toContain("no chats");
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");

    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.listFileChats).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The linked-mentions panel rides every markdown open, and
  // listChatFileMentions goes through requireEngineCapture like every other
  // Chats call. Its own `.catch` swallows the refusal, which is why nothing
  // caught it (#615's last ungated call, from the other cause).
  it("asks for no chat mentions when a file opens", async () => {
    const bridge = makeFailedCaptureBridge();
    renderShell(bridge);

    // The premise: the file really opened, so the panel that issues the call
    // really mounted.
    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.getBacklinks).toHaveBeenCalled());
    expect(bridge.listChatFileMentions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("states the fact for a persisted Chats tab instead of a page that can only fail", async () => {
    const bridge = makeFailedCaptureBridge();
    bridge.getWorkspaceUiState = vi.fn(async () => ({
      ...STORED_STATE,
      tabs: [CHATS_TAB_PATH],
      activeTab: CHATS_TAB_PATH,
    }));
    renderShell(bridge);

    const placeholder = await screen.findByTestId("chats-page-off");
    expect(placeholder.textContent).toContain(
      "dohc could not open chats for this workspace.",
    );
    // The line that used to stand here blamed a Settings flag for all three
    // causes, including this one.
    expect(placeholder.textContent).not.toContain("aren't enabled");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The window before the decision, entered the way production enters it: the
  // renderer's own read answers first, and main's registry entry still holds
  // the defaults it registered before awaiting the capture build. Every input
  // the gate has says "recorder", and main has decided nothing.
  it("asks for no chats before main's capture decision lands", async () => {
    const decision = deferred<typeof FAILED_STATUS>();
    const bridge = makeFailedCaptureBridge();
    bridge.openWorkspace = vi.fn(() => decision.promise);
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () => (decided ? FAILED_STATUS : SYNC_STATUS));
    renderShell(bridge);

    await screen.findByTestId("titlebar-chats-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    // The panel is mounted and states nothing: neither read the shell has
    // done proves anything about what main decided (#542).
    expect(screen.getByTestId("chats-panel")).toBeTruthy();
    expect(screen.queryByTestId("chats-panel-off")).toBeNull();

    await act(async () => {
      decided = true;
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(await screen.findByTestId("chats-panel-off")).toBeTruthy();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

});

// #621: virtual tabs survive restore, so a moment-diff tab outlives the
// History surface that opened it — and a shared view has no History surface
// at all (#540). The page asked main for a moment the share has none of and
// fell into its own error state.
describe("shared view moment-diff tab", () => {
  const MOMENT_TAB = momentDiffTabPath("m-1");

  it("states the capability for a persisted moment-diff tab instead of a page that can only fail", async () => {
    const bridge = makeShareBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [MOMENT_TAB],
        activeTab: MOMENT_TAB,
      }),
    );
    renderShell(bridge, SHARE_VIEW);

    const placeholder = await screen.findByTestId("moment-diff-share-view");
    // The same sentence the History placeholder states for a shared view, plus
    // the next step this surface really has.
    expect(placeholder.textContent).toContain(
      "A shared view records no history. Close this tab to go back to the shared files.",
    );
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("keeps the real diff page for a persisted moment-diff tab outside a shared view", async () => {
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [MOMENT_TAB],
        activeTab: MOMENT_TAB,
      }),
    );
    renderShell(bridge);

    await waitFor(() =>
      expect(bridge.readEngineMoment).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        momentId: "m-1",
      }),
    );
    expect(screen.queryByTestId("moment-diff-share-view")).toBeNull();
    expect(screen.queryByTestId("moment-diff-off")).toBeNull();
  });

  // The ordering interaction #626 found. A shared view's status also says no
  // recorder, so holding it pending is what isolates the synchronous share
  // fact from the status clause that would otherwise mask it.
  it("states the shared-view fact before any status arrives", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [MOMENT_TAB],
        activeTab: MOMENT_TAB,
      }),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    const placeholder = await screen.findByTestId("moment-diff-share-view");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(placeholder.textContent).toContain("A shared view records no history.");
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
  });
});

// #637 item 1: the same tab, the other cause. #621 gated it on the share fact
// alone, so a workspace whose recorder failed to build still mounted
// EngineMomentDiffPage — which calls readEngineMoment on mount and falls into
// its own error state. Reached by opening a moment diff while healthy and
// restarting after a failed build.
describe("moment-diff tab after a failed capture build", () => {
  const MOMENT_TAB = momentDiffTabPath("m-1");
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingOff: true,
    historyRecordingUnavailable: true,
  };

  it("states the capability instead of a page that can only fail", async () => {
    const status = deferred<typeof FAILED_STATUS>();
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [MOMENT_TAB],
        activeTab: MOMENT_TAB,
      }),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    bridge.readEngineMoment = vi.fn(async (): Promise<never> => {
      throw new Error("Engine history is not enabled for this workspace.");
    });
    renderShell(bridge);

    // Before the decision lands the tab mounts no page AND claims nothing:
    // the renderer's own read proves nothing about what main recorded (#542).
    await screen.findByTestId("titlebar-chats-sidebar");
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(screen.queryByTestId("moment-diff-off")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();

    await act(async () => {
      status.resolve(FAILED_STATUS);
      await status.promise;
    });

    // The History placeholder's line for this cause: one cause, one sentence,
    // wherever it is stated. It says what dohc could not do — never that the
    // workspace has no history, which the restart it prescribes would undo.
    const placeholder = await screen.findByTestId("moment-diff-off");
    expect(placeholder.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );
    expect(placeholder.textContent).toContain("Restart dohc to try again.");
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The other ordering, which the tests above cannot reach because their open
  // is the slow one (#637, codex r2). Main decides the recorder once per app
  // session and RETAINS the workspace, so re-entering a healthy workspace
  // mid-session resolves `openWorkspace` off that retained entry — before the
  // renderer's own settings read, which is a real file read, has answered.
  // `engineEnabled` still holds its "no answer" false in that window, so the
  // tab took the unavailable branch and stated a restart main never asked for,
  // then flipped to the diff.
  it("states nothing while the settings read is still in flight", async () => {
    const settings = deferred<WorkspaceSettingsResult>();
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [MOMENT_TAB],
        activeTab: MOMENT_TAB,
      }),
    );
    bridge.getWorkspaceSettings = vi.fn(() => settings.promise);
    renderShell(bridge);

    // The premise: main's decision has landed, and it says a recorder exists.
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    // MUTATION: read the capture decision alone -> "History is unavailable.
    // dohc could not confirm…", on a workspace whose history is fine.
    expect(screen.queryByTestId("moment-diff-off")).toBeNull();
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();

    await act(async () => {
      settings.resolve({
        settings: {
          ...DEFAULT_WORKSPACE_SETTINGS,
          experimental: {
            ...DEFAULT_WORKSPACE_SETTINGS.experimental,
            workspaceEngineAlpha: true,
          },
        },
        source: "stored",
      });
      await settings.promise;
    });

    // Both answers are in, and they agree: the real page, asking main for the
    // moment the tab was opened on.
    await waitFor(() =>
      expect(bridge.readEngineMoment).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        momentId: "m-1",
      }),
    );
    expect(screen.queryByTestId("moment-diff-off")).toBeNull();
  });

  // The half that keeps the wait from becoming a forever-load: the settings
  // read can FAIL, and a failure is an answer. Held as "pending" it would
  // leave this tab spinning for the rest of the session.
  it("states the capability once the settings read fails", async () => {
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: [MOMENT_TAB],
        activeTab: MOMENT_TAB,
      }),
    );
    bridge.getWorkspaceSettings = vi.fn(async (): Promise<never> => {
      throw new Error("transient read failure");
    });
    renderShell(bridge);

    // The renderer's read failed and main said nothing was wrong, so this
    // surface knows only what IT could not do — no cause, no claim about what
    // the workspace has (#542).
    const placeholder = await screen.findByTestId("moment-diff-off");
    expect(placeholder.textContent).toContain("History is unavailable.");
    expect(placeholder.textContent).not.toContain("Settings");
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
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

// #567 / #579 review: set-aside draft recovery at the shell seams. The drafts
// live in a module store keyed by workspace + path; the shell owns the two
// integrations under test — path remapping on explorer renames, and the
// distinction between recovery (dot, no save promise) and savable-dirty
// (dot AND the version-switch save-first prompt).
describe("set-aside draft recovery", () => {
  it("keeps the notice reachable when the open file is renamed mid-notice", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve({ ...STORED_STATE, tabs: ["a.md"], activeTab: "a.md" }),
    );
    Object.assign(bridge, {
      moveWorkspacePath: vi.fn(async () => undefined),
    });
    captureOrphanedDraft(WORKSPACE.workspaceId, "a.md", "Kept!");
    renderShell(bridge);

    // The notice is up on the open document.
    await screen.findByTestId("view-markdown");
    await screen.findByTestId("orphaned-draft-notice");

    // Rename a.md through the explorer (F2 flow — the same seam every rename
    // takes). The tab remaps to the new path.
    const row = (await screen.findAllByTestId("tree-row")).find((candidate) =>
      candidate.textContent?.includes("a.md"),
    );
    expect(row).toBeTruthy();
    await user.click(row!);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    await screen.findByTestId("tab-renamed.md");

    // MUTATION (remap wiring): drop the remapOrphanedDraftPaths call from
    // onExplorerPathsChanged. The store still keys by a.md, the tab is
    // renamed.md, and the recovery text is unreachable from the UI.
    expect(await screen.findByTestId("orphaned-draft-notice")).toBeTruthy();
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
  });

  it("marks the tab with recovery but lets a version switch proceed without a save promise", async () => {
    const user = userEvent.setup();
    const bridge = makeEngineBridge(
      Promise.resolve({ ...STORED_STATE, tabs: ["a.md"], activeTab: "a.md" }),
    );
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
          id: "v2",
          name: "Draft two",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: "main",
    }));
    captureOrphanedDraft(WORKSPACE.workspaceId, "a.md", "Kept!");
    renderShell(bridge);

    // The recovery marks the tab: an unsaved edit exists, and hiding that
    // would be the engine-Saved lie one level up.
    // MUTATION (dot): drop `|| activeTabRecovery` from the EditorTabs prop.
    await screen.findByTestId("view-markdown");
    await screen.findByTestId("tab-dirty");

    // But it is NOT savable-dirty: switching versions must not prompt
    // "dohc will save them" about a draft the flush cannot write — the store
    // outlives the switch, so the switch just proceeds.
    // MUTATION (lift): lift the recovery-derived state from MarkdownView's
    // onSaveStateChange (the round-1 behavior). The save-first dialog then
    // appears and the switch below never runs.
    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await waitFor(() =>
      expect(bridge.switchWorkspaceVersion).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("version-switch-save-confirm")).toBeNull();
    // The notice survives the switch — recovery needed no save.
    expect(screen.getByTestId("orphaned-draft-notice")).toBeTruthy();
  });

  // #579 review r4: only the mounted inspector can report savable-dirty, but
  // recovery is knowable for EVERY tab — an inactive tab must keep its
  // marker or the user forgets the draft exists.
  it("marks an inactive tab that holds a set-aside draft", async () => {
    const bridge = makeEngineBridge(
      Promise.resolve({
        ...STORED_STATE,
        tabs: ["a.md", "b.md"],
        activeTab: "a.md",
      }),
    );
    captureOrphanedDraft(WORKSPACE.workspaceId, "b.md", "Kept!");
    renderShell(bridge);

    // MUTATION (per-tab set): key the marker off the active tab only. The
    // inactive b.md loses its marker while its draft still exists.
    const inactive = await screen.findByTestId("tab-b.md");
    expect(within(inactive).getByTestId("tab-dirty")).toBeTruthy();
    const active = screen.getByTestId("tab-a.md");
    expect(within(active).queryByTestId("tab-dirty")).toBeNull();
  });

  // #579 review r10: the global recovery list labels rows with the NAME the
  // UI shows for the workspace, not its UUID — the shell registers it.
  it("registers the workspace's display name for the global recovery list", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    captureOrphanedDraft(WORKSPACE.workspaceId, "a.md", "Kept!");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    // The same global list the close dialog embeds.
    // MUTATION (label wiring): drop the shell's noteWorkspaceLabel effect —
    // the row falls back to the raw workspace id.
    render(<GlobalRecoveryList />);
    expect(screen.getByTestId("recovery-list-workspace").textContent).toBe(
      "personal",
    );
  });

  // #579 review r7: a switch can fail AFTER its IPC started — main settles
  // and closes live Y.Doc sessions before it sets the active version, so
  // "the version never moved" does not mean "nothing happened". The reopen
  // must fire, or the editor keeps a session main already closed and later
  // edits vanish into swallowed IPC rejections.
  it("reopens the document when a switch fails after its IPC started", async () => {
    const user = userEvent.setup();
    const bridge = makeEngineBridge(
      Promise.resolve({ ...STORED_STATE, tabs: ["a.md"], activeTab: "a.md" }),
    );
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
          id: "v2",
          name: "Draft two",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: "main",
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed mid-way");
    });
    const openEngineYDocSession = vi.fn(async () => ({ available: false }));
    Object.assign(bridge, { openEngineYDocSession });
    renderShell(bridge);
    await screen.findByTestId("view-markdown");
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(1));

    // No pending draft, so the switch starts at once — and fails inside.
    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await waitFor(() =>
      expect(bridge.switchWorkspaceVersion).toHaveBeenCalled(),
    );

    // MUTATION (switch-issued key): suppress the announce whenever the
    // version did not move, regardless of where the failure happened. The
    // reopen below never comes and the closed-session write path is live.
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(2));
  });

  // #579 review r18: a SUCCESSFUL switch announces before its selector
  // refresh, and announcing again after that refresh fails would bump the
  // version epoch a second time — the same-version reopen moves whatever the
  // user typed in between into set-aside recovery — a notice the user then
  // has to answer.
  //
  // What this test pins is the OUTCOME: one switch, one reopen. It does not
  // pin the `announced` guard that also enforces it — removing that guard
  // still passes.
  //
  // An earlier round claimed that was because a successful switch re-keys this
  // panel. That was WRONG: `<VersionMenu>` is mounted without a key
  // (DesktopWorkspaceShell.tsx), so it is not re-keyed, exactly as
  // WorkspaceVersions.tsx:105-115 intends. What actually absorbs the second
  // announcement is not established — measured on the mutated build, the
  // catch path's recovery read DOES run (four listWorkspaceVersions calls) and
  // the reopen count still stays at two.
  //
  // So: unpinned, and reachable under an order these tests do not produce —
  // two liveness checks sit between the recovery read and the announcement,
  // and passing them is a scheduling order, not a structural barrier. The
  // guard stays because it makes the outcome hold regardless of that order.
  it("reopens once when a successful switch's selector refresh fails", async () => {
    const user = userEvent.setup();
    const bridge = makeEngineBridge(
      Promise.resolve({ ...STORED_STATE, tabs: ["a.md"], activeTab: "a.md" }),
    );
    let switched = false;
    let refreshFailed = false;
    bridge.listWorkspaceVersions = vi.fn(async () => {
      // The switch's OWN refresh fails; the catch path's recovery read then
      // succeeds and reports the version the switch already announced. That
      // is the shape that announces twice.
      if (switched && !refreshFailed) {
        refreshFailed = true;
        throw new Error("selector refresh failed");
      }
      return {
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "v2",
            name: "Draft two",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: switched ? "v2" : "main",
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "v2", changedFileCount: 0 };
    });
    const openEngineYDocSession = vi.fn(async () => ({ available: false }));
    Object.assign(bridge, { openEngineYDocSession });
    renderShell(bridge);
    await screen.findByTestId("view-markdown");
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await waitFor(() =>
      expect(bridge.switchWorkspaceVersion).toHaveBeenCalled(),
    );

    // The switch landed, so the reopen it announced is the RIGHT one.
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(2));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(openEngineYDocSession).toHaveBeenCalledTimes(2);
  });

  // #579 review r5: a deleted file's tab is gone, so no inspector will ever
  // render its notice again — the notice center is the path-independent
  // surface where the draft stays reachable, Copy/Dismiss included.
  it("keeps a deleted path's set-aside draft reachable from the notice center", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    // The path is in no listing and no tab: only the store knows it.
    captureOrphanedDraft(WORKSPACE.workspaceId, "deleted/gone.md", "Kept!");
    // Another workspace's draft must NOT leak into this workspace's notice
    // center (#579 review, r6) — the close guard is the global surface.
    captureOrphanedDraft("ws-somewhere-else", "private/notes.md", "Theirs");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    // MUTATION (notice-center surface): drop the set-aside section from
    // NoticeCenter. The draft exists, the close warning demands action, and
    // no reachable surface offers it.
    // MUTATION (workspace filter): drop the workspaceId filter — the other
    // workspace's private path appears here and both assertions below fail.
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-set-aside-edits");
    const rows = screen.getAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.textContent).toContain("deleted/gone.md");
    expect(row.textContent).not.toContain("private/notes.md");
    // A workspace-scoped list needs no workspace label (#579 review, r7) —
    // only the global close dialog carries them.
    expect(within(row).queryByTestId("recovery-list-workspace")).toBeNull();
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("notice-set-aside-edits")).toBeNull(),
    );

    // ...and with nothing left, the surface says so rather than implying a
    // draft that is not there.
    expect(screen.getByTestId("notice-center").textContent).toContain(
      "All clear",
    );
  });

  // #600: the store no longer dies on reload, quit, update-restart or crash —
  // a set-aside edit is written on capture and restored at launch. The #579
  // lifetime disclosure ("they live only in this window") became false with
  // it, and a false claim about durability is worse than none. The close
  // warning is what names the drafts storage could not keep, at the moment
  // that matters.
  it("makes no claim that set-aside edits die with the window", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    captureOrphanedDraft(WORKSPACE.workspaceId, "notes/a.md", "Kept!");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    // MUTATION (stale disclosure): put the sentence back. The panel then
    // tells the user an edit that survives the next launch is about to be
    // lost.
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const section = await screen.findByTestId("notice-set-aside-edits");
    expect(section.textContent).not.toContain("live only in this window");
    // ...and it names both ways out, so the warning offers what it demands.
    expect(section.textContent).toContain("Copy an edit to keep its text");
    expect(section.textContent).toContain("Dismiss deletes it for good");
  });

  // #600: dropping the blanket disclosure was right for the rows that now
  // survive a quit, and it left the rows that still do NOT — a secret path
  // plaintext storage refuses (#446), a write the quota refused — looking
  // exactly like the durable ones. The lifetime moved onto the row.
  it("marks the set-aside edits that still die with the window", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    captureOrphanedDraft(WORKSPACE.workspaceId, "notes/a.md", "Persisted");
    captureOrphanedDraft(WORKSPACE.workspaceId, ".env", "API_KEY=shh");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    // MUTATION (row lifetime): render the marker for every row, or for none.
    // Either way the panel stops telling the two apart, and the user cannot
    // see which edit the next quit destroys.
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-set-aside-edits");
    const marked = screen
      .getAllByTestId("recovery-list-row")
      .filter(
        (row) => within(row).queryByTestId("recovery-list-window-only") !== null,
      );
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain(".env");
    expect(marked[0].textContent).toContain("Only in this window");
  });

  // #579 review r4: a failed save-first flush aborts the switch, the
  // workspace never leaves its version, and the recovery announcement must
  // not fire — announcing a version change reopens the live document and
  // sets the still-editable draft aside on the SAME version.
  it("does not set the draft aside when a failed switch never left the version", async () => {
    const user = userEvent.setup();
    const bridge = makeEngineBridge(
      Promise.resolve({ ...STORED_STATE, tabs: ["a.md"], activeTab: "a.md" }),
    );
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
          id: "v2",
          name: "Draft two",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: "main",
    }));
    // The save-first flush fails: the autosave write rejects.
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    renderShell(bridge);

    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "Draft!",
    );
    await screen.findByTestId("tab-dirty");

    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await user.click(await screen.findByTestId("version-switch-save-continue"));

    // The flush failed, the switch never started, the version never changed.
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalled(),
    );
    expect(bridge.switchWorkspaceVersion).not.toHaveBeenCalled();

    // MUTATION (failed-switch announce): announce the unchanged version from
    // performSwitch's catch. The bookkeeping reopen then sets the draft
    // aside on the same version — the notice appears and the editor loses
    // the text the user could just keep editing.
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(
      (screen.getByTestId("markdown-editor") as HTMLTextAreaElement).value,
    ).toContain("Draft!");
  });
});
