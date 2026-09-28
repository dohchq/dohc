import "../testing/legendListMock";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, vi } from "vitest";
import * as Y from "yjs";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type {
  AgentRunStatusResult,
  ReadCrashReportResult,
  ListCollectionAutomationRunsResult,
  ListCollectionAutomationsResult,
  FindAutomationCollectionPayload,
  FindAutomationCollectionResult,
  RetryCollectionAutomationResult,
  ChatChannelRecord,
  DismissShareSkipsPayload,
  MountShareResult,
  GetRelayReceivedShareResult,
  DmRecord,
  FileChatThreadRecord,
  ImportWorkspaceFilesResult,
  ListEngineMomentsResponse,
  ListFileChatsResult,
  ListMyShareChangesResult,
  ListShareProposalsResult,
  GetCollectionResult,
  ListCollectionsPayload,
  ListCollectionsResult,
  ListOwnerLiveDocumentsPayload,
  ListOwnerLiveRefusalsPayload,
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  OwnerLiveDocumentActionPayload,
  OwnerLiveDocumentsResult,
  OwnerLiveRefusalsResult,
  RetryOwnerLiveSharePayload,
  QueryCollectionRecordsResult,
  ListWorkspaceVersionsResult,
  ReadShareProposalChangesResult,
  ReadShareProposalFileContentResult,
  SettleShareProposalPayload,
  UndoRelaySharePayload,
  SettleShareProposalResult,
  SubmitShareChangesResult,
  PushShareDirectWritesResult,
  ShareDirectWritesPushedEvent,
  WithdrawShareChangesResult,
  McpConfigResult,
  ReadWorkspaceTextPayload,
  ReadEngineMomentResult,
  RebuildEngineStoreResult,
  RefreshSharedViewResult,
  StartAgentRunResult,
  SwitchWorkspaceVersionResult,
  SyncDmsPayload,
  SyncDmsResult,
  SyncStatusResult,
  TryInVersionStateResult,
  ShowExplorerMenuResult,
  ShowWorkbenchMenuResult,
  UpdateStateEvent,
  MenuCommand,
  SearchResultsEvent,
  WriteWorkspaceTextPayload,
  WriteWorkspaceTextResult,
  WorkspaceActivityEvent,
  WorkspaceSearchPayload,
  WorkspaceUiState,
} from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettingsResult,
} from "../workspaces/workspaceSettings";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
import { resetOrphanedDrafts, useAllOrphanedDrafts } from "./orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./collab/engineDocLease";
import {
  CollectionFieldWriteHost,
  resetCollectionFieldWritesForTests,
} from "./collections/recordFieldWrites";
import { resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";
import { forgetSyncFailureNoticesForTests } from "./shell/useSyncFailureNotice";
import { RecoveryList } from "./RecoveryList";

// The close dialog's list, standing on its own: the guard subscribes and hands
// the rows down, so a test of the LIST needs the same one-line subscriber.
export function GlobalRecoveryList() {
  return <RecoveryList rows={useAllOrphanedDrafts()} showWorkspace />;
}

export const WORKSPACE: Workspace = {
  workspaceId: "ws-shell-test",
  rootPath: "/home/sam/dohc/personal",
  kind: "personal",
  mode: "local-first",
};

export const OTHER_WORKSPACE: Workspace = {
  ...WORKSPACE,
  workspaceId: "ws-shell-other",
  rootPath: "/home/sam/dohc/other",
};

export const SYNC_STATUS: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  // Required on the contract: every status states whether
  // the recorder failed to build, whether the workspace is a shared view,
  // and whether the engine refused the workspace's data store.
  historyRecordingUnavailable: false,
  historyShareView: false,
  liveSessionsGeneration: 0,
};

const IDLE_UPDATE_STATE: UpdateStateEvent = {
  status: "idle",
  message: "Updates have not been checked yet.",
  currentVersion: "1.2.3",
  channel: "latest",
  canCheck: true,
  canInstall: false,
};

export const READY_UPDATE_STATE: UpdateStateEvent = {
  status: "ready",
  message: "Update 1.2.4 is ready. Restart dohc to apply it.",
  currentVersion: "1.2.3",
  channel: "latest",
  canCheck: false,
  canInstall: true,
  version: "1.2.4",
};

export const STORED_STATE: WorkspaceUiState = {
  version: 3,
  activeView: "explorer",
  sidebarVisible: true,
  sidebarWidth: 320,
  editorGroups: [
    { id: "primary", tabs: ["b.md"], activeTab: "b.md", size: 1 },
  ],
  activeEditorGroup: "primary",
  chatsVisible: true,
  chatsWidth: 360,
};

export function storedStateWithTabs(
  tabs: string[],
  activeTab: string | null = tabs[0] ?? null,
): WorkspaceUiState {
  return {
    ...STORED_STATE,
    editorGroups: [{ id: "primary", tabs, activeTab, size: 1 }],
    activeEditorGroup: "primary",
  };
}

export function storedTabs(state: WorkspaceUiState): string[] {
  return state.editorGroups.flatMap((group) => group.tabs);
}

export function isFileOpenStartMark(name: string): boolean {
  return name.startsWith("file-open-start:");
}

// One canonical DM, as the graph node a click starts a navigation from and as
// the record syncDms answers with.
export const DM_GRAPH_NODE = {
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

export const CANONICAL_DM: DmRecord = {
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

export function dmSyncResult(
  dms: DmRecord[] = [],
  available = true,
): SyncDmsResult {
  return { available, dms, pending: [], declined: [], failed: false };
}

Element.prototype.scrollIntoView = vi.fn();

const originalSetPointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "setPointerCapture",
);
const originalHasPointerCapture = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "hasPointerCapture",
);
const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
);

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

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

// A record file's live document as the engine serves it: the frontmatter map
// carries the record's id, which the write queue verifies before applying.
export function recordDocUpdate(recordId: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("frontmatter").set("id", recordId);
  return Y.encodeStateAsUpdate(doc);
}

function makeBaseBridge(
  uiStatePromise: Promise<WorkspaceUiState | null>,
  platform: NodeJS.Platform = "linux",
) {
  const activityCallbacks = new Set<(event: WorkspaceActivityEvent) => void>();
  const directWritesPushedCallbacks = new Set<(event: ShareDirectWritesPushedEvent) => void>();
  const crashReportCallbacks = new Set<() => void>();
  let searchCallback: ((batch: SearchResultsEvent) => void) | null = null;
  let menuCallback: ((command: MenuCommand) => void) | null = null;
  return {
    platform,
    emitWorkspaceActivity: (event: WorkspaceActivityEvent = {}) => {
      for (const callback of [...activityCallbacks]) callback(event);
    },
    workspaceActivitySubscriberCount: () => activityCallbacks.size,
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
    listWorkspaceFiles: vi.fn(
      async (
        _payload: ListWorkspaceFilesPayload,
      ): Promise<ListWorkspaceFilesResult> => ({
        files: [
          { path: "a.md", kind: "file" },
          { path: "b.md", kind: "file" },
        ],
        folders: [],
      }),
    ),
    openWorkspace: vi.fn(async () => SYNC_STATUS),
    getSyncStatus: vi.fn(async () => SYNC_STATUS),
    // Owner live documents and the live-delivery retry command. Typed to the
    // contracts, not to these empty defaults: the live-document tests swap in
    // real rows and real refusals.
    listOwnerLiveDocuments: vi.fn(
      async (
        _payload: ListOwnerLiveDocumentsPayload,
      ): Promise<OwnerLiveDocumentsResult> => ({
        documents: [],
        nextCursor: null,
      }),
    ),
    listOwnerLiveRefusals: vi.fn(
      async (
        _payload: ListOwnerLiveRefusalsPayload,
      ): Promise<OwnerLiveRefusalsResult> => ({
        refusals: [],
        nextCursor: null,
      }),
    ),
    retryOwnerLiveShare: vi.fn(
      async (_payload: RetryOwnerLiveSharePayload): Promise<void> => undefined,
    ),
    stopOwnerLiveDocument: vi.fn(
      async (_payload: OwnerLiveDocumentActionPayload): Promise<void> => undefined,
    ),
    resumeOwnerLiveDocument: vi.fn(
      async (_payload: OwnerLiveDocumentActionPayload): Promise<void> => undefined,
    ),
    retryOwnerLiveDelivery: vi.fn(
      async (_payload: { workspaceId: string }): Promise<void> => undefined,
    ),
    retryCloudSync: vi.fn(
      async (_payload: { workspaceId: string; reason: "person" | "reconnect" }): Promise<SyncStatusResult> => SYNC_STATUS,
    ),
    // The refused-store rebuild. Typed to the contract, not to this
    // default: the recovery tests swap in the no-clobber refusal.
    rebuildEngineStore: vi.fn(
      async (): Promise<RebuildEngineStoreResult> => ({
        outcome: "moved",
      }),
    ),
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
    getUserSettingsFilePath: vi.fn(async () => "/state/dohc-settings.json"),
    openUserSettingsFile: vi.fn(async () => undefined),
    getWorkspaceSettings: vi.fn(async (): Promise<WorkspaceSettingsResult> => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
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
    onUserSettingsChanged: vi.fn(() => () => {}),
    onChatDispatchNotices: vi.fn(() => () => {}),
    registerChatDispatchNotices: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, revision: 0, notices: [] })),
    dismissChatDispatchNotice: vi.fn(async () => {}),
    stepWindowZoom: vi.fn(async (payload: { step: "in" | "out" | "reset" }) => ({
      settings: {
        ...DEFAULT_USER_SETTINGS,
        appearance: {
          ...DEFAULT_USER_SETTINGS.appearance,
          zoomLevel: payload.step === "in" ? 1 : payload.step === "out" ? -1 : 0,
        },
      },
      source: "stored" as const,
    })),
    detectAgentTools: vi.fn(async () => ({ workingDirectory: "/workspace", tools: [] })),
    readWorkspaceText: vi.fn(async (_payload: ReadWorkspaceTextPayload) => ({
      text: "# Doc\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    })),
    // The linked-mentions panel bails without this, and its chat-mention read
    // is an ENGINE CAPTURE call — so a fake that omits it makes every
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
    writeWorkspaceText: vi.fn(
      async (_payload: WriteWorkspaceTextPayload): Promise<WriteWorkspaceTextResult> => ({
        status: "written",
        contentHash: "a".repeat(64),
      }),
    ),
    createWorkspaceFile: vi.fn(async (payload: { relativePath: string }) => ({
      path: payload.relativePath,
    })),
    createWorkspaceFolder: vi.fn(async (payload: { relativePath: string }) => ({
      path: payload.relativePath,
    })),
    importWorkspaceFiles: vi.fn(
      async (): Promise<ImportWorkspaceFilesResult> => ({
        imported: ["imported.md"],
        skipped: 0,
      }),
    ),
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
      grantId: "relay-grant-1",
      shareCode: "dohc-share:relay-share-1:http://relay.test",
      recipientEmail: "friend@dohc.test",
    })),
    listRelayShares: vi.fn(async () => ({ granted: [], received: [], removed: [] })),
    retryShareHandoff: vi.fn(async () => undefined),
    dismissShareHandoff: vi.fn(async () => undefined),
    revokeRelayShare: vi.fn(async () => ({
      undo: { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 },
    })),
    undoRelayShare: vi.fn(async (payload: UndoRelaySharePayload) => ({
      shareId: payload.shareId,
    })),
    // Share changes. Typed to the contract, not to these empty
    // defaults: the review and submit tests drive real rows through them.
    listShareProposals: vi.fn(
      async (): Promise<ListShareProposalsResult> => ({ proposals: [] }),
    ),
    readShareProposalChanges: vi.fn(
      async (): Promise<ReadShareProposalChangesResult> => ({
        proposedByEmail: "friend@dohc.test",
        files: [
          {
            opIndex: 0,
            path: "docs/plan.md",
            operation: "write",
            drifted: false,
            afterByteLength: 4,
          },
        ],
      }),
    ),
    readShareProposalFileContent: vi.fn(
      async (): Promise<ReadShareProposalFileContentResult> => ({
        currentText: "one\n",
        incomingText: "two\n",
      }),
    ),
    settleShareProposal: vi.fn(
      async (
        _payload: SettleShareProposalPayload,
      ): Promise<SettleShareProposalResult> => ({ state: "accepted" }),
    ),
    listMyShareChanges: vi.fn(
      async (): Promise<ListMyShareChangesResult> => ({ proposals: [] }),
    ),
    submitShareChanges: vi.fn(
      async (): Promise<SubmitShareChangesResult> => ({
        ok: true,
        submitted: 2,
        capturedLocalChanges: 0,
        skippedOutsideShare: 0,
        morePending: false,
      }),
    ),
    withdrawShareChanges: vi.fn(
      async (): Promise<WithdrawShareChangesResult> => ({ state: "withdrawn" }),
    ),
    pushShareDirectWrites: vi.fn(
      async (): Promise<PushShareDirectWritesResult> => ({ status: "pushed", writes: [] }),
    ),
    emitShareDirectWritesPushed: (event: ShareDirectWritesPushedEvent) => {
      for (const callback of [...directWritesPushedCallbacks]) callback(event);
    },
    onShareDirectWritesPushed: vi.fn(
      (listener: (event: ShareDirectWritesPushedEvent) => void) => {
        directWritesPushedCallbacks.add(listener);
        return () => directWritesPushedCallbacks.delete(listener);
      },
    ),
    pickWorkspaceRoot: vi.fn(async () => null),
    getRelayReceivedShare: vi.fn(
      async (): Promise<GetRelayReceivedShareResult> => ({ found: false }),
    ),
    getDefaultShareRoot: vi.fn(
      async ({ shareId }: { shareId: string }) => `/home/sam/dohc/shared/${shareId}`,
    ),
    // Typed to the contract so a test that adds a share can answer it.
    mountShare: vi.fn(async (): Promise<MountShareResult> => {
      throw new Error("not used in shell tests");
    }),
    openSharedView: vi.fn(async () => {
      throw new Error("not used in shell tests");
    }),
    // Typed to the contract, not to this one default: a test that drives a
    // real pull ("updated") must be able to swap the implementation.
    dismissShareSkips: vi.fn(
      async (_payload: DismissShareSkipsPayload): Promise<void> => undefined,
    ),
    refreshSharedView: vi.fn(
      async (): Promise<RefreshSharedViewResult> => ({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      }),
    ),
    onWorkspaceActivity: vi.fn(
      (callback: (event: WorkspaceActivityEvent) => void) => {
        activityCallbacks.add(callback);
        return () => {
          activityCallbacks.delete(callback);
        };
      },
    ),
    onCloudSessionChanged: vi.fn((_callback: () => void) => () => {}),
    onMenuCommand: vi.fn((callback: (command: MenuCommand) => void) => {
      menuCallback = callback;
      return () => {
        menuCallback = null;
      };
    }),
    retryAutomationNotice: vi.fn(
      async (): Promise<RetryCollectionAutomationResult> => ({ status: "queued", press: false }),
    ),
    listAutomationHolds: vi.fn(async () => ({ holds: [], stops: [], unreadable: false })),
    resetAutomationHolds: vi.fn(async () => ({ status: "reset" as const })),
    revealAutomationHolds: vi.fn(async () => undefined),
    onAutomationRunSettled: vi.fn(() => () => undefined),
    onAutomationRunWaiting: vi.fn(() => () => undefined),
    listAutomationButtons: vi.fn(async () => ({ buttons: [] })),
    listRecordButtons: vi.fn(async () => ({ record: null })),
    onAutomationHoldsChanged: vi.fn(() => () => undefined),
    onCollectionAutomationsChanged: vi.fn(() => () => undefined),
    listCollectionAutomations: vi.fn(
      async (): Promise<ListCollectionAutomationsResult> => ({ status: "missing" }),
    ),
    findAutomationCollection: vi.fn(async (_payload: FindAutomationCollectionPayload): Promise<FindAutomationCollectionResult> => ({ status: "missing" })),
    listCollectionAutomationRuns: vi.fn(
      async (_payload: { workspaceId: string; automationId: string }): Promise<ListCollectionAutomationRunsResult> => ({ status: "listed", runs: [], next: null }),
    ),
    retryCollectionAutomation: vi.fn(
      async (): Promise<RetryCollectionAutomationResult> => ({ status: "queued", press: false }),
    ),
    onAutomationRunsChanged: vi.fn((_listener: (event: { workspaceId: string }) => void) => () => undefined),
    readCrashReport: vi.fn(
      async (_payload: Record<string, never>): Promise<ReadCrashReportResult> => ({
        report: null,
        sendTo: null,
      }),
    ),
    dismissCrashReport: vi.fn(async (_payload: { through: number }) => undefined),
    sendCrashReport: vi.fn(async (_payload: Record<string, never>) => ({ sent: true })),
    emitCrashReportChanged: () => {
      for (const callback of [...crashReportCallbacks]) callback();
    },
    onCrashReportChanged: vi.fn((listener: () => void) => {
      crashReportCallbacks.add(listener);
      return () => crashReportCallbacks.delete(listener);
    }),
    emitMenuCommand: (command: MenuCommand) => menuCallback?.(command),
    onUpdateState: vi.fn(() => () => {}),
    // Content search (E5.0): the shell subscribes on mount.
    onSearchResults: vi.fn((callback: (batch: SearchResultsEvent) => void) => {
      searchCallback = callback;
      return () => {
        searchCallback = null;
      };
    }),
    searchWorkspace: vi.fn(async (_payload: WorkspaceSearchPayload) => ({
      status: "accepted" as const,
    })),
    cancelWorkspaceSearch: vi.fn(async () => undefined),
  };
}

// Every workspace has the engine, so every bridge answers the engine
// surfaces: collections, history, versions, chats. Typed to the contracts so
// a test that drives real rows can swap an implementation in.
export function makeBridge(
  uiStatePromise: Promise<WorkspaceUiState | null>,
  platform: NodeJS.Platform = "linux",
) {
  const bridge = makeBaseBridge(uiStatePromise, platform);
  return Object.assign(bridge, {
    // Collections: the flagged shell lists collections on
    // ready and on activity. Typed to the contract; the collection tests
    // swap in real rows.
    listCollections: vi.fn(
      async (_payload: ListCollectionsPayload): Promise<ListCollectionsResult> => ({
        collections: [],
      }),
    ),
    dataset: vi.fn(async (request: DatasetRequest): Promise<DatasetResult> => {
      if (request.action === "list") return { kind: "list", datasets: [], nextCursor: null };
      throw new Error(`Unexpected dataset action in shell fixture: ${request.action}`);
    }),
    getCollection: vi.fn(async (): Promise<GetCollectionResult> => ({
      path: "tasks",
      status: "valid",
      reasons: [],
      schema: { name: null, description: null, fields: [], views: [] },
      recordCount: 0,
    })),
    queryCollectionRecords: vi.fn(
      async (): Promise<QueryCollectionRecordsResult> => ({
        collection: { path: "tasks", status: "valid", reasons: [] },
        records: [],
        groups: null,
        nextCursor: null,
      }),
    ),
    // Typed to the contract, not to this empty default: a test that drives
    // real pages must be able to swap the implementation.
    listEngineMoments: vi.fn(
      async (): Promise<ListEngineMomentsResponse> => ({
        moments: [],
        nextBeforeMomentOrder: null,
        latestMomentOrder: 0,
        activeVersionId: "main",
        protectedTruncated: false,
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
    listPersonalChatFeed: vi.fn(async () => ({ items: [], nextCursor: null })),
    listChatChannelShares: vi.fn(async () => {
      // Sharing is optional; ChatsView downgrades a rejection to "none".
      throw new Error("sharing unavailable in shell tests");
    }),
    syncDms: vi.fn(
      async (_payload: SyncDmsPayload): Promise<SyncDmsResult> =>
        dmSyncResult([], false),
    ),
    // A fresh revision per read preserves the pre-gating contract for this
    // suite: every open-DM tick reloads. A test exercising the revision gate
    // itself overrides this with a stable value.
    getChatThreadRevision: vi.fn(
      (() => {
        let revision = 0;
        return async () => ({ revision: ++revision });
      })(),
    ),
    listFileChats: vi.fn(
      async (): Promise<ListFileChatsResult> => ({ fileObjectId: null, threads: [] }),
    ),
  });
}

export function renderShell(
  bridge: ReturnType<typeof makeBridge>,
  workspace: Workspace = WORKSPACE,
  workspaces: Workspace[] = [workspace],
) {
  vi.stubGlobal("dohcDesktop", bridge);
  // The host rides outside the shell, exactly as main.tsx mounts it: the
  // collection write queue must keep landing accepted edits while the keyed
  // shell remounts.
  return render(
    <>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell
        workspace={workspace}
        workspaces={workspaces}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    </>,
  );
}

export async function enterMarkdownSource(
  user: ReturnType<typeof userEvent.setup>,
  scope: HTMLElement = document.body,
): Promise<HTMLElement> {
  const shell = await screen.findByTestId("workspace-shell");
  await waitFor(() => expect(shell.dataset.ready).toBe("true"));

  const queries = within(scope);
  const currentSource = queries
    .queryByTestId("markdown-editor")
    ?.querySelector<HTMLElement>(".cm-content");
  if (currentSource?.getAttribute("contenteditable") === "true") {
    return currentSource;
  }

  const toggle = (await queries.findByTestId(
    "markdown-edit-toggle",
  )) as HTMLButtonElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));

  // The label names the next surface: Edit (read) -> Source (WYSIWYG) ->
  // WYSIWYG (source).
  if (toggle.textContent === "Edit") {
    await user.click(toggle);
    await waitFor(() => expect(toggle.textContent).toBe("Source"));
  }
  if (toggle.textContent === "Source") {
    await user.click(toggle);
  } else {
    expect(toggle.textContent).toBe("WYSIWYG");
  }
  return await waitFor(() => {
    const content = queries
      .getByTestId("markdown-editor")
      .querySelector<HTMLElement>(".cm-content");
    expect(content?.getAttribute("contenteditable")).toBe("true");
    return content!;
  });
}

// A history page that never lands. The editor-boundary suites measure draft
// flushes and editor identity across renames, deletes, and close-all; the
// first history commit bumps the inspector's refresh key, which is a
// different behavior with its own tests.
export function holdHistory(bridge: ReturnType<typeof makeBridge>) {
  bridge.listEngineMoments = vi.fn(() => new Promise<never>(() => {}));
  return bridge;
}

export function sourceEditorText(editor: HTMLElement): string {
  return Array.from(editor.querySelectorAll<HTMLElement>(".cm-line"), (line) =>
    line.textContent ?? "",
  ).join("\n");
}

export function shellBootstrapProps(bridge: ReturnType<typeof makeBridge>) {
  return {
    userSettings: {
      settings: DEFAULT_USER_SETTINGS,
      source: "default" as const,
    },
    refreshWorkspaceRegistry: async () =>
      (await bridge.getWorkspaceRegistry()).workspaces as Workspace[],
  };
}

// The status a real shared view carries (capture === null, share cause) and
// the workspace identity that rides the capture decision.
export const SHARE_STATUS = {
  ...SYNC_STATUS,
  historyShareView: true,
};
export const SHARE_VIEW: Workspace = {
  ...WORKSPACE,
  shareView: {
    shareId: "share-1",
    granterEmail: "granter@dohc.test",
    access: "view",
  },
};

// A bridge that answers the way MAIN answers for a shared view: the capture
// gate short-circuits, so requireEngineCapture has no capture and every
// capture-backed call is refused. A fake that resolved these would model more than main can do, and
// every no-call pin below would pass even after the fix was reverted.
//
// `listFileChats` is the one that answers: main resolves a chat
// scope from the share instead of a capture, so the per-file chat surface is
// served at every level. A fake that still refused it would model less than
// main can do, and every pin written against it would certify fiction.
export function makeShareBridge(
  uiState: Promise<WorkspaceUiState | null> = Promise.resolve(null),
) {
  const bridge = makeBridge(uiState);
  bridge.openWorkspace = vi.fn(async () => SHARE_STATUS);
  bridge.getSyncStatus = vi.fn(async () => SHARE_STATUS);
  bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
    throw new Error("Versions are not enabled for this workspace.");
  });
  bridge.readEngineMoment = vi.fn(async (): Promise<never> => {
    throw new Error("Engine history is not enabled for this workspace.");
  });
  // The granter's review channel is workspace-scoped and owner-only: main
  // refuses it for a share view. A fake that answered it would model more
  // than main can do, and the no-call pin below would pass after a revert.
  bridge.listShareProposals.mockRejectedValue(
    new Error("A shared view cannot review changes."),
  );
  for (const call of [
    "listChatChannels",
    "listChannelThreads",
    "listChatFileMentions",
    "syncDms",
  ] as const) {
    bridge[call].mockRejectedValue(
      new Error("Chats are not enabled for this workspace."),
    );
  }
  bridge.listFileChats.mockResolvedValue({
    fileObjectId: "share-object-1",
    threads: [],
  });
  return bridge;
}

// Flushes the shell's mount effects for a shared view, whose capture-backed
// surfaces are hidden, so a no-call pin below is asserted after the shell
// had its chance to call.
export async function settleShareView() {
  await act(async () => {});
}

afterEach(async () => {
  cleanup();
  restoreProperty(
    Element.prototype,
    "setPointerCapture",
    originalSetPointerCapture,
  );
  restoreProperty(
    Element.prototype,
    "hasPointerCapture",
    originalHasPointerCapture,
  );
  restoreProperty(document, "elementFromPoint", originalElementFromPoint);
  await disposeEngineDocLeasesForTests();
  resetSharedLocalDocumentsForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // The set-aside drafts live in a module store on purpose; tests
  // that seed it must not leak into each other.
  resetOrphanedDrafts();
  // The collection write queue is module state on purpose too — a pending
  // head left by one test must not open sessions inside the next.
  resetCollectionFieldWritesForTests();
  // What a sync failure already showed is module state too, so it holds
  // across the shell's remounts.
  forgetSyncFailureNoticesForTests();
});
