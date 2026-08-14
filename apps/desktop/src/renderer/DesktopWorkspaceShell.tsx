import { isSharedWithMePath } from "@dohc/workspace-core/paths";
import {
  Bot,
  CircleHelp,
  ExternalLink,
  Eye,
  FileArchive,
  FileText,
  Lock,
  Maximize2,
  PanelRight,
  RefreshCw,
  Search,
  Undo2,
  User,
  X,
} from "lucide-react";
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChatFileMentionRecord,
  ChatThreadRecord,
  CloudStatusResult,
  DmRecord,
  EngineMomentDetailRecord,
  EngineMomentRecord,
  SyncStatusResult,
  TryInVersionRunState,
  WorkbenchMenuCommand,
  WorkspaceGraphResult,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
import { DohcMark } from "@dohc/brand";
import {
  hasUnacknowledgedShareSkips,
  shareSkipNoticeLines,
} from "./shareSkipNotice";
import { buildChatCollaboration } from "./collab/chatCollaboration";
import type { SearchResultsEventEntry } from "../ipc/channels";
import {
  fileOpenStartMark,
  rendererMarks,
} from "../performance/rendererMarks";
import { bridge } from "./bridge";
import { useSnapshotLane } from "./snapshotLane";
import { momentDiffSides } from "./workbench/momentDiffSides";
import { CloudLogin } from "./CloudLogin";
import { ErrorBoundary } from "./ErrorBoundary";
import { CommandPalette, type Command } from "./CommandPalette";
import {
  classifyForView,
  FileInspector,
  preloadMarkdownEditor,
  type DraftFlush,
  type DraftFlushOptions,
  type FileSaveState,
  type HeadingTarget,
  type ScrollTarget,
} from "./FileInspector";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import { NewFileDialog } from "./NewFileDialog";
import { OpenSharedView } from "./OpenSharedView";
import { Overlay } from "./Overlay";
import { DesktopSettings } from "./settings/DesktopSettings";
import {
  DEFAULT_SETTINGS_SECTION,
  type SettingsSectionId,
} from "./settings/settingsRegistry";
import { Titlebar, workspaceName } from "./Titlebar";
import { toggleTheme } from "./theme";
import { SectionLabel } from "./ui/controls";
import { ActivityBar, activityViewLabel } from "./workbench/ActivityBar";
import { EditorTabs } from "./workbench/EditorTabs";
import { EditorGroupLayout } from "./workbench/EditorGroupLayout";
import { Explorer } from "./workbench/Explorer";
import { projectTreePath, type PendingTreeChange } from "./workbench/file-tree-optimistic";
import {
  noteWorkspaceLabel,
  remapOrphanedDraftPaths,
  useOrphanedDraftPaths,
} from "./orphanedDrafts";
import { requestGuardedUpdateInstall } from "./RecoveryCloseGuard";
import { rankQuickOpenPaths } from "./workbench/quick-open-rank";
// Eager on purpose. Behind lazy(), the search input did not exist until the
// chunk resolved, and every character typed in that gap went to whatever the
// user clicked to open the panel — queries arrived with their first letters
// missing. The view carries no dependency the shell does not already load.
import { SearchView } from "./workbench/SearchView";
import { SidePanel } from "./workbench/SidePanel";
import { StatusBar } from "./workbench/StatusBar";
import { AgentPermissionRequests } from "./workbench/AgentPermissionRequests";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { useAgentNotifications } from "./workbench/useAgentNotifications";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  UnifiedDiffLines,
  buildUnifiedDiffLines,
  computeTextDiff,
  type UnifiedDiffLine,
} from "./workbench/unifiedDiff";
import {
  EngineHistoryView,
  engineMomentSourceLabel,
  engineMomentSummary,
} from "./workbench/EngineHistory";
import {
  ConflictReviewDialog,
  VersionComparePage,
  VersionMenu,
} from "./workbench/WorkspaceVersions";
import {
  TryInVersionBanner,
  TryInVersionReviewCard,
} from "./workbench/TryInVersion";
// Type-only: erased at compile time, so the ChatsView chunk stays lazy.
import type {
  AgentSetupSummary,
  ChatsDrafts,
  ChatsNav,
} from "./workbench/ChatsView";
import {
  activeGroup,
  activeTabPath,
  activateTab,
  allTabs,
  closeTab,
  closeEditorGroup,
  createEditorGroupRight,
  focusEditorGroup,
  clampChatsWidth,
  isVersionCompareTabPath,
  parseVersionCompareTabPath,
  versionCompareTabPath,
  isMomentDiffTabPath,
  momentDiffTabPath,
  parseMomentDiffTabPath,
  defaultWorkbenchState,
  CHATS_TAB_PATH,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  isChatsTabPath,
  isGraphTabPath,
  isHistoryDiffTabPath,
  isHistoryTabPath,
  isPluginPanelTabPath,
  isSingletonEditorTabPath,
  isSiteTabPath,
  isVirtualTabPath,
  MAX_OPEN_TABS,
  moveTab,
  moveTabToGroup,
  openTab,
  resizeEditorGroups,
  moveTabToNewGroup,
  parseHistoryDiffTabPath,
  parsePluginPanelTabPath,
  pluginPanelTabPath,
  parseSiteTabPath,
  parseUiState,
  pruneMissingRestoredTabs,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  setChatsWidth,
  setFolderExpanded,
  setOpenEditorsHeight,
  setSidebarWidth,
  setView,
  toggleChats,
  toggleFolderExpanded,
  togglePinned,
  toggleSidebar,
  VIEW_IDS,
  type EditorGroup,
  type WorkbenchState,
  type WorkbenchTab,
} from "./workbench/workbenchState";

// Mounted-share paths (shared-with-me/…) are read-only projections of
// someone else's files. This check is a renderer UX affordance only — main
// refuses every write to the reserved prefix regardless — but it uses the
// same alias-normalizing predicate as main so a case-variant path arriving
// from an agent/open flow ("Shared-With-Me/…") renders read-only too.
function isMountedSharePath(path: string | null): boolean {
  return !!path && isSharedWithMePath(path);
}

function groupsMountingNewDocument(
  current: WorkbenchState,
  next: WorkbenchState,
): string[] {
  return next.editorGroups.flatMap((after) => {
    const before = current.editorGroups.find((group) => group.id === after.id);
    return after.activeTab !== before?.activeTab &&
      after.activeTab !== null &&
      !isVirtualTabPath(after.activeTab)
      ? [after.id]
      : [];
  });
}

function chatsDestinationKey(nav: ChatsNav | null): string {
  if (!nav) return "channels";
  if (nav.level === "channel") return `channel:${nav.channel.id}`;
  if (nav.level === "thread") return `thread:${nav.thread.id}`;
  if (nav.level === "dm") return `dm:${nav.dm.channelId}`;
  return nav.level;
}

function chatsFocusMessageId(nav: ChatsNav | null): string | undefined {
  return nav && (nav.level === "thread" || nav.level === "dm")
    ? nav.focusMessageId
    : undefined;
}

// Two questions about one navigation, deliberately different.
//
// Did the user LEAVE the conversation? That scopes drafts: a draft belongs to
// the conversation it was typed in, so a jump WITHIN that conversation must
// not discard it.
export function chatsNavigationLeavesConversation(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  return chatsDestinationKey(current) !== chatsDestinationKey(next);
}

// Did the user GO somewhere? That cancels a pending DM lookup. A focused
// message IS somewhere — chatsNavigationRequiresRemount treats it as a new
// jump for exactly that reason — so a backlink or feed item landing on another
// message in the open conversation counts, even though the conversation did
// not change and the draft typed there survives.
export function chatsNavigationChangesDestination(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  return (
    chatsNavigationLeavesConversation(current, next) ||
    chatsFocusMessageId(current) !== chatsFocusMessageId(next)
  );
}

// What the history-off placeholder may claim (#542). The placeholder renders
// whenever the renderer's own capability read says the surface does not
// exist, but that read must not SPEAK: whether changes are recorded is
// main's answer (syncStatus, from the one open-time read that decided the
// recorder), and a cause is named only when that status established it. The
// renderer's read failing — or not having answered yet — proves nothing:
// main's read may have started the recorder, and "not being recorded" would
// then be a false privacy assurance (#483's second failure mode).
// Each cause is ONE line, per the empty-state recipe (copy.md): what is
// missing, then the next step its surface really has.
function historyOffPlaceholderCopy(
  syncStatus: SyncStatusResult | null,
  share: { ended: boolean; granterEmail: string | null } | null,
): string {
  if (share) {
    // A capability, not an opt-out and not a failure: a shared view is fed
    // by the share's pull and records no history here. The next step matches
    // the surface — Refresh exists only while the share is live, so an ended
    // share must not name it — and the ended line names who acted, as the
    // banner does.
    return share.ended
      ? `A shared view records no history. ${share.granterEmail ?? "The person who shared it"} ended this share. You can still open the files it shared.`
      : "A shared view records no history. Refresh the shared view to get the latest shared changes.";
  }
  // #483: the warning already names the unreadable file and the fix.
  if (syncStatus?.settingsWarning) return syncStatus.settingsWarning;
  if (syncStatus?.historyRecordingUnavailable) {
    // #505: a failure, not a decision — same copy as the notice center.
    return "dohc could not start recording history for this workspace. Your files still save normally. Restart dohc to try again.";
  }
  if (syncStatus?.historyRecordingOff) {
    // The real opt-out: main read the file and the flag is off. RESTART, not
    // reopen (#687) — see `chatsOffCopy` below for why reopening the workspace
    // re-reads the flag nowhere.
    return "History is off for this workspace. The workspace engine is turned off in Settings → Advanced, so changes are not being recorded. Turn it on. Then restart dohc to record history.";
  }
  // Main has not said recording is off. It may be recording right now, so
  // no cause and no "not recorded" — only what dohc could not do, plus the
  // one next step that reliably re-runs both reads (no lighter re-read is
  // wired on this surface).
  return "History is unavailable. dohc could not confirm whether this workspace records history. Restart dohc to try again.";
}

// What a persisted version-compare tab may claim when the version surface is
// off and the workspace is not a shared view (#626). Same rule as
// `historyOffPlaceholderCopy` above, and one rule of its own: **a capability
// flag is not a count**. `historyRecordingUnavailable` says the recorder
// could not be BUILT this session; versions created before it can still be on
// disk and reachable after the restart this copy prescribes. "You have no
// versions" is a claim about durable data, and dohc does not make one it has
// not established. Every line here says what dohc cannot do now, and none of
// them says what does not exist.
export function versionCompareOffCopy(syncStatus: SyncStatusResult | null): string {
  // #483: the warning already names the unreadable file and the fix, and the
  // opt-out line below would blame a Settings toggle nobody touched.
  if (syncStatus?.settingsWarning) return syncStatus.settingsWarning;
  if (syncStatus?.historyRecordingUnavailable) {
    // #505: a failure, not a decision, and not an emptiness.
    return "dohc could not open versions for this workspace. Your files still save normally. Restart dohc to try again.";
  }
  if (syncStatus?.historyRecordingOff) {
    // The real opt-out. The engine is off, so versions cannot be opened here
    // — which is not the same as there being none. RESTART, not reopen
    // (#687) — see `chatsOffCopy` below for why reopening re-reads nothing.
    return "Versions are off for this workspace. The workspace engine is turned off in Settings → Advanced. Turn it on. Then restart dohc to compare versions.";
  }
  // Main has not said anything is wrong, so the renderer's own read failing
  // is all this surface knows. No cause, and no claim about what exists.
  return "Versions are unavailable. dohc could not confirm whether this workspace has versions. Close this tab to go back to your files.";
}

// What the Chats surfaces may claim when main's capture cannot serve them and
// the workspace is not a shared view (#628). Same two rules as the copy above:
// only main's status names a cause, and a capability flag is not a count —
// chats live on disk and outlive a session whose capture failed to build.
//
// One function for the panel AND the tab, because the next step is the same on
// both: the panel has no tab to close, and restarting is what re-runs the
// capture build either way.
export function chatsOffCopy(syncStatus: SyncStatusResult | null): string {
  // #483: the warning already names the unreadable file and the fix.
  if (syncStatus?.settingsWarning) return syncStatus.settingsWarning;
  if (syncStatus?.historyRecordingUnavailable) {
    // #505: a failure, not a decision, and not an emptiness.
    return "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.";
  }
  if (syncStatus?.historyRecordingOff) {
    // The real opt-out. The engine is off, so chats cannot be opened here —
    // which is not the same as there being none.
    //
    // RESTART, not reopen: main decides the recorder once per workspace per
    // app session — `openWorkspaceActivity` retains every workspace it opens
    // and `workspaceActivity.open` no-ops for one it already watches — so
    // leaving the workspace and coming back re-reads the flag nowhere. Same
    // instruction the settings warning gives, for the same reason.
    return "Chats are off for this workspace. The workspace engine is turned off in Settings → Advanced. Turn it on. Then restart dohc to use chats.";
  }
  // Main has not said anything is wrong, so the renderer's own read failing
  // is all this surface knows. No cause, and no claim about what exists.
  return "Chats are unavailable. dohc could not confirm whether this workspace has chats. Restart dohc to try again.";
}

export function chatsNavigationRequiresRemount(
  current: ChatsNav | null,
  next: ChatsNav,
): boolean {
  if (chatsDestinationKey(current) !== chatsDestinationKey(next)) return true;
  // Message backlinks are commands, not durable conversation identity. Even
  // when the destination thread is already live, remount it with the new
  // focus target so ChatsView gets another chance to scroll (and so clicking
  // the same backlink twice remains useful after the user has scrolled away).
  return (
    (next.level === "thread" || next.level === "dm") &&
    Boolean(next.focusMessageId)
  );
}

export interface DmChatLocator {
  channelId?: string;
  channelWireId?: string;
  threadId: string;
  focusMessageId?: string;
}

type ChatOpenTarget =
  | { surface: "channel"; nav: Extract<ChatsNav, { level: "thread" }> }
  | ({ surface: "dm" } & DmChatLocator)
  | {
      surface: "file";
      thread: Pick<ChatThreadRecord, "id" | "title" | "createdAtMs" | "updatedAtMs">;
      focusMessageId?: string;
    }
  | { surface: "overview" };

export function chatMentionOpenTarget(mention: ChatFileMentionRecord): ChatOpenTarget {
  if (mention.channelKind === "dm") {
    return {
      surface: "dm",
      channelId: mention.channelId,
      channelWireId: mention.channelWireId,
      threadId: mention.thread.id,
      focusMessageId: mention.message.id,
    };
  }
  if (!mention.channelId || !mention.channelName) {
    return {
      surface: "file",
      thread: mention.thread,
      focusMessageId: mention.message.id,
    };
  }
  return {
    surface: "channel",
    nav: {
      level: "thread",
      channel: {
        id: mention.channelId,
        wireId: mention.channelWireId,
        name: mention.channelName,
        slug: mention.channelSlug ?? mention.channelName,
        kind: mention.channelKind ?? "channel",
        createdAtMs: 0,
        updatedAtMs: 0,
        threadCount: 0,
        unreadCount: 0,
      },
      thread: {
        ...mention.thread,
        channelId: mention.channelId,
        messageCount: 0,
        lastReadSequence: 0,
        unreadCount: 0,
      },
      focusMessageId: mention.message.id,
    },
  };
}

export function graphChatOpenTarget(
  node: WorkspaceGraphResult["nodes"][number],
): ChatOpenTarget {
  if (node.kind !== "chat-thread" || !node.threadId) return { surface: "overview" };
  const thread = {
    id: node.threadId,
    title: node.title,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  if (node.channelKind === "dm") {
    return {
      surface: "dm",
      channelId: node.channelId,
      channelWireId: node.channelWireId,
      threadId: node.threadId,
    };
  }
  if (!node.channelId || !node.channelName) return { surface: "file", thread };
  return {
    surface: "channel",
    nav: {
      level: "thread",
      channel: {
        id: node.channelId,
        wireId: node.channelWireId,
        name: node.channelName,
        slug: node.channelSlug ?? node.channelName,
        kind: node.channelKind ?? "channel",
        createdAtMs: 0,
        updatedAtMs: 0,
        threadCount: 0,
        unreadCount: 0,
      },
      thread: {
        ...thread,
        channelId: node.channelId,
        messageCount: 0,
        lastReadSequence: 0,
        unreadCount: 0,
      },
    },
  };
}

export function resolveCanonicalDm(
  locator: DmChatLocator,
  dms: readonly DmRecord[],
): DmRecord | null {
  // A renderer-supplied graph/backlink row is only a locator. Never construct
  // a DM record from its display metadata: require a canonical main-derived DM
  // with the same running thread and every available stable channel identity.
  if (!locator.channelId && !locator.channelWireId) return null;
  return dms.find(
    (dm) =>
      dm.threadId === locator.threadId &&
      (!locator.channelId || dm.channelId === locator.channelId) &&
      (!locator.channelWireId || dm.channelWireId === locator.channelWireId),
  ) ?? null;
}

export async function runCanonicalDmNavigation(input: {
  locator: DmChatLocator;
  syncDms: () => Promise<{ available: boolean; dms: DmRecord[] }>;
  isCurrent: () => boolean;
  open: (nav: Extract<ChatsNav, { level: "dm" }> | { level: "channels" }) => void;
}): Promise<void> {
  try {
    const result = await input.syncDms();
    if (!input.isCurrent()) return;
    // `available` controls whether a new DM can be created; it does not make
    // already-local conversations unreadable while signed out or offline.
    const dm = resolveCanonicalDm(input.locator, result.dms);
    input.open(
      dm
        ? {
            level: "dm",
            dm,
            ...(input.locator.focusMessageId
              ? { focusMessageId: input.locator.focusMessageId }
              : {}),
          }
        : { level: "channels" },
    );
  } catch {
    if (input.isCurrent()) input.open({ level: "channels" });
  }
}

/** The record a pending canonical DM navigation checks itself against. */
type DmNavigationRequest = { workspaceId: string; sequence: number };

// Cancel any in-flight canonical DM navigation so its late answer cannot land
// a chat destination over wherever the user went meanwhile. REPLACE the
// record, never increment it in place: openCanonicalDmInTab installs the very
// object it then compares against, so an in-place increment moves the pending
// navigation's captured sequence too, its isCurrent() compares the object with
// itself, and the cancellation is a no-op.
function invalidateDmNavigation(request: { current: DmNavigationRequest }): void {
  request.current = {
    workspaceId: request.current.workspaceId,
    sequence: request.current.sequence + 1,
  };
}

export function pendingHeadingTargetForOpen(
  path: string,
  target?: HeadingTarget,
): { path: string; target: HeadingTarget } | null {
  return target ? { path, target } : null;
}

export type Workspace = WorkspaceSummary;

const LazyRelayShareDialog = lazy(() =>
  import("./RelayShareDialog").then((mod) => ({ default: mod.RelayShareDialog })),
);
const MARKDOWN_PRELOAD_IDLE_DELAY_MS = 150;

function scheduleMarkdownEditorPreload(): () => void {
  let idleHandle: number | null = null;
  let fired = false;
  const timerHandle = globalThis.setTimeout(() => {
    fired = true;
    if (typeof globalThis.requestIdleCallback === "function") {
      idleHandle = globalThis.requestIdleCallback(preloadMarkdownEditor, {
        timeout: 1_000,
      });
      return;
    }
    preloadMarkdownEditor();
  }, MARKDOWN_PRELOAD_IDLE_DELAY_MS);

  return () => {
    if (!fired) globalThis.clearTimeout(timerHandle);
    if (
      idleHandle !== null &&
      typeof globalThis.cancelIdleCallback === "function"
    ) {
      globalThis.cancelIdleCallback(idleHandle);
    }
  };
}
const LazyGraphView = lazy(() =>
  import("./workbench/GraphView").then((mod) => ({ default: mod.GraphView })),
);
const LazySitesView = lazy(() =>
  import("./workbench/SitesView").then((mod) => ({ default: mod.SitesView })),
);
const LazySitePreviewPage = lazy(() =>
  import("./SitePreviewPage").then((mod) => ({ default: mod.SitePreviewPage })),
);
const LazyPluginPanelPage = lazy(() =>
  import("./PluginPanelPage").then((mod) => ({ default: mod.PluginPanelPage })),
);
const LazyLinkedChatsPanel = lazy(() =>
  import("./workbench/LinkedChats").then((mod) => ({
    default: mod.LinkedChatsPanel,
  })),
);
const LazyChatsView = lazy(() =>
  import("./workbench/ChatsView").then((mod) => ({ default: mod.ChatsView })),
);

// Every folder above a path — expanded when a create/open must REVEAL it.
function ancestorDirs(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

function uniqueUntitledPath(
  files: WorkspaceFileEntry[],
  folders: string[],
  extension: string,
): string {
  const occupied = new Set(
    [...files.map((file) => file.path), ...folders].map((path) =>
      path.toLowerCase(),
    ),
  );
  const base = `Untitled.${extension}`;
  if (!occupied.has(base.toLowerCase())) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `Untitled ${index}.${extension}`;
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  return `Untitled ${Date.now()}.${extension}`;
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      "[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']",
    ) !== null
  );
}

const BLOCKING_MODAL_SELECTOR = "[role='dialog'], [data-dohc-modal='true']";

function hasBlockingModal() {
  return document.querySelector(BLOCKING_MODAL_SELECTOR) !== null;
}

type ActiveUndoHandler = {
  run: () => Promise<void>;
  acceptsEvent: (event: KeyboardEvent) => boolean;
};

type MountedEditorRegistration = {
  tab: WorkbenchTab;
  flush?: DraftFlush;
  sourceToggle?: () => void;
  undo?: ActiveUndoHandler;
};

type EditorRegistrationCallbacks = {
  onSaveStateChange: (state: FileSaveState) => void;
  registerDraftFlush: (flush: DraftFlush | null) => void;
  registerSourceToggle: (toggle: (() => void) | null) => void;
  registerActiveUndo: (handler: ActiveUndoHandler | null) => void;
};

type EditorFocus = {
  groupId: string;
  tab: WorkbenchTab | null;
};

function editorFocus(state: WorkbenchState): EditorFocus {
  const group = activeGroup(state);
  return {
    groupId: group.id,
    tab: group.tabs.find((tab) => tab.path === group.activeTab) ?? null,
  };
}

function hasEditorFocus(state: WorkbenchState, focus: EditorFocus): boolean {
  const current = editorFocus(state);
  return current.groupId === focus.groupId && current.tab === focus.tab;
}

// Engine history diff page (PR 0M-5, flagged workspaces): one MOMENT's
// before/after through the shared unified-diff rendering, with engine-routed
// restore. Restore returns the file to its state BEFORE this moment and
// records a forward "Restored <file>" moment; undo restores to before THAT
// moment — history is never rewritten.
export function EngineMomentDiffPage({
  workspaceId,
  tabPath,
  onBeforeRestore,
  onOpenFile,
  registerActiveUndo,
  onRestored,
}: {
  workspaceId: string;
  tabPath: string;
  onBeforeRestore: () => Promise<void>;
  onOpenFile: (path: string) => void;
  registerActiveUndo: (handler: ActiveUndoHandler | null) => void;
  onRestored: () => void;
}) {
  const momentId = useMemo(() => parseMomentDiffTabPath(tabPath), [tabPath]);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; moment: EngineMomentDetailRecord | null }
    | { status: "error" }
  >({ status: "loading" });
  const [restoreState, setRestoreState] = useState<
    | { status: "idle" }
    | { status: "restoring" }
    | { status: "undoing" }
    | { status: "restored"; restored: "text" | "deleted"; message: string }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  // The forward restore moment to undo against; null = nothing to undo.
  const [undoMomentId, setUndoMomentId] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const restoreInFlight = useRef(false);
  // Liveness: bumped when the tab changes/unmounts so a slow response can
  // never repaint another moment's page.
  const liveToken = useRef(0);

  useEffect(() => {
    const token = ++liveToken.current;
    if (!momentId) {
      setState({ status: "error" });
      return;
    }
    setState({ status: "loading" });
    void bridge()
      .readEngineMoment({ workspaceId, momentId })
      .then((result) => {
        if (token !== liveToken.current) return;
        setState({ status: "ready", moment: result.moment });
      })
      .catch(() => {
        if (token !== liveToken.current) return;
        setState({ status: "error" });
      });
    return () => {
      liveToken.current += 1;
    };
  }, [momentId, workspaceId]);
  useEffect(() => {
    setRestoreState({ status: "idle" });
    setConfirmRestoreOpen(false);
    setUndoMomentId(null);
  }, [tabPath]);

  const moment = state.status === "ready" ? state.moment : null;
  // The diff is the expensive part of this page, and a moment's bodies never
  // change while its tab is open. Build it ONCE per moment: it used to run
  // twice per render — once for the counts, once for the lines — and a
  // hydrated 10 MiB body cost seconds each time.
  const prepared = useMemo(() => {
    if (!moment) return null;
    const sides = momentDiffSides(moment);
    const diff = computeTextDiff(sides.before, sides.after, 800);
    return { sides, diff, lines: buildUnifiedDiffLines(diff) };
  }, [moment]);
  const restoreBusy =
    restoreState.status === "restoring" || restoreState.status === "undoing";
  const canRestore = moment !== null && moment.operation !== "rename" && !undoMomentId;

  const undoRestore = useCallback(async () => {
    const target = undoMomentId;
    if (!target || restoreBusy || restoreInFlight.current) return;
    restoreInFlight.current = true;
    const token = liveToken.current;
    setRestoreState({ status: "undoing" });
    try {
      await onBeforeRestore();
      const result = await bridge().restoreEngineMomentFile({
        workspaceId,
        momentId: target,
      });
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "restored",
        restored: result.restored,
        message:
          result.restored === "deleted"
            ? "Undid the restore by removing the file again. This was recorded in history."
            : "Undid the restore. This was recorded in history.",
      });
      setUndoMomentId(null);
      onRestored();
    } catch (error) {
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Could not undo this restore.",
      });
    } finally {
      restoreInFlight.current = false;
    }
  }, [onBeforeRestore, onRestored, restoreBusy, undoMomentId, workspaceId]);

  useEffect(() => {
    if (!undoMomentId || restoreBusy) {
      registerActiveUndo(null);
      return;
    }
    registerActiveUndo({
      run: undoRestore,
      acceptsEvent: (event) => {
        if (isEditableShortcutTarget(event.target)) return false;
        const page = pageRef.current;
        const target = event.target instanceof Element ? event.target : null;
        const active =
          document.activeElement instanceof Element ? document.activeElement : null;
        const focusOwner = target ?? active;
        if (
          page &&
          focusOwner &&
          focusOwner !== document.body &&
          focusOwner !== document.documentElement &&
          !page.contains(focusOwner)
        ) {
          return false;
        }
        return !hasBlockingModal();
      },
    });
    return () => registerActiveUndo(null);
  }, [registerActiveUndo, restoreBusy, undoMomentId, undoRestore]);

  if (!momentId || state.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-danger">
        Could not load this history diff.
      </div>
    );
  }
  if (state.status === "loading") {
    return <PanelLoading label="history diff" />;
  }
  if (!moment || !prepared) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-subtle">
        This change is no longer in the history record.
      </div>
    );
  }

  // Secret-backed file moment (PR 08): metadata-only — no diff exists, the
  // body shows "Contents are protected" instead. Restore still works (it
  // rides the encrypted path end to end).
  const isProtected = moment.protected === true;
  // Each side presents by its OWN kind (see momentDiffSides).
  const {
    beforeIsBinary,
    afterIsBinary,
    bytesOnly,
    createdFile,
    byteLength: binaryByteLength,
  } = prepared.sides;
  const counts = isProtected || bytesOnly ? null : prepared.diff.counts;
  // Restore returns the BEFORE state, so its wording follows that side.
  const restoreDetail = createdFile
    ? "This change created the file, so restoring removes it from the folder. It stays in history and you can undo."
    : isProtected
      ? "The protected file will be returned to how it was before this change. Its contents stay encrypted and are never shown."
      : beforeIsBinary
        ? "The binary file will be returned byte-for-byte to how it was before this change."
      : "The file will be returned to how it was before this change.";
  // Restoring a create moment REMOVES the file ("deleted"): no open-file
  // affordances for a file that is no longer in the folder (mirrors the
  // legacy HistoryDiffPage guard).
  const canOpenFile =
    restoreState.status === "restored" && restoreState.restored === "deleted"
      ? false
      : moment.operation !== "delete" ||
        (restoreState.status === "restored" && restoreState.restored === "text");
  const diffLines: UnifiedDiffLine[] = prepared.lines;

  const restoreFile = async () => {
    if (!canRestore || restoreBusy || restoreInFlight.current) return;
    restoreInFlight.current = true;
    const token = liveToken.current;
    setConfirmRestoreOpen(false);
    setRestoreState({ status: "restoring" });
    try {
      await onBeforeRestore();
      const result = await bridge().restoreEngineMomentFile({
        workspaceId,
        momentId: moment.id,
      });
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "restored",
        restored: result.restored,
        message:
          result.restored === "deleted"
            ? "Removed the file this change created. Undo restore is available here."
            : "Restored the earlier state. Undo restore is available here.",
      });
      setUndoMomentId(result.restoredMomentId);
      onRestored();
    } catch (error) {
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Could not restore this file.",
      });
    } finally {
      restoreInFlight.current = false;
    }
  };

  return (
    <section
      ref={pageRef}
      data-testid="engine-moment-diff-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <SectionLabel>History diff</SectionLabel>
          <h2 className="mb-0 mt-0.5 truncate text-[15px] font-semibold text-ink">
            {canOpenFile ? (
              <button
                type="button"
                data-testid="engine-diff-title-open-file"
                onClick={() => onOpenFile(moment.path)}
                className="max-w-full cursor-pointer truncate rounded text-left hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title={`Open ${moment.path}`}
              >
                {moment.path}
              </button>
            ) : (
              moment.path
            )}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span>
              {moment.operation === "delete"
                ? "Deleted"
                : createdFile
                  ? "Created"
                  : "Changed"}
            </span>
            <span data-testid="engine-diff-source">
              {engineMomentSourceLabel(moment)}
            </span>
            {counts ? (
              <span className="font-mono" data-testid="engine-diff-counts">
                +{counts.added} -{counts.removed}
              </span>
            ) : null}
          </div>
          <p
            data-testid="engine-diff-summary"
            className="mb-0 mt-1 truncate text-[11px] text-subtle"
          >
            {engineMomentSummary(moment)}
          </p>
          {restoreState.status === "restored" || restoreState.status === "error" ? (
            <p
              data-testid="engine-diff-restore-status"
              className={`mb-0 mt-1 text-[11px] ${
                restoreState.status === "error" ? "text-danger" : "text-success"
              }`}
            >
              {restoreState.message}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          data-testid="engine-diff-restore-file"
          onClick={() => setConfirmRestoreOpen(true)}
          disabled={!canRestore || restoreBusy}
          title={
            undoMomentId
              ? "This restore has already been applied"
              : canRestore
                ? "Restore this file to how it was before this change"
                : "This change can't be restored directly"
          }
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Undo2 size={12} aria-hidden />
          {restoreState.status === "restoring" ? "Restoring..." : "Restore..."}
        </button>
        {undoMomentId ? (
          <button
            type="button"
            data-testid="engine-diff-undo-restore"
            onClick={() => void undoRestore()}
            disabled={restoreBusy}
            className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Undo2 size={12} aria-hidden />
            {restoreState.status === "undoing" ? "Undoing..." : "Undo restore"}
          </button>
        ) : null}
        {canOpenFile ? (
          <button
            type="button"
            data-testid="engine-diff-open-file"
            onClick={() => onOpenFile(moment.path)}
            className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
          >
            <ExternalLink size={12} aria-hidden />
            Open file
          </button>
        ) : null}
      </header>
      <div className="min-h-0 overflow-auto overflow-x-hidden p-4">
        <section className="overflow-hidden rounded border border-line bg-bg shadow-sm">
          <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
            {isProtected ? (
              <Lock size={13} aria-hidden className="shrink-0 text-subtle" />
            ) : afterIsBinary ? (
              <FileArchive size={13} aria-hidden className="shrink-0 text-subtle" />
            ) : (
              <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
              {moment.path}
            </span>
            {counts ? (
              <span className="shrink-0 font-mono text-[11px] text-subtle">
                +{counts.added} -{counts.removed}
              </span>
            ) : null}
          </div>
          {isProtected ? (
            <div
              data-testid="engine-diff-protected"
              className="flex flex-col items-center gap-1 px-4 py-10 text-center"
            >
              <Lock size={16} aria-hidden className="text-subtle" />
              <span className="text-sm text-muted">Contents are protected</span>
              <span className="text-xs text-subtle">
                dohc versions this file encrypted and never shows its contents
                in history, search, or comparisons.
              </span>
            </div>
          ) : bytesOnly ? (
            <div
              data-testid="engine-diff-binary"
              className="flex flex-col items-center gap-1 px-4 py-10 text-center"
            >
              <FileArchive size={16} aria-hidden className="text-subtle" />
              <span className="text-sm text-muted">Binary contents</span>
              <span className="text-xs text-subtle">
                {binaryByteLength} bytes are versioned byte-for-byte and are
                not shown in text diffs.
              </span>
            </div>
          ) : (
            <>
              {beforeIsBinary || afterIsBinary ? (
                <p
                  data-testid="engine-diff-binary-side"
                  className="m-0 border-b border-line bg-panel-2 px-3 py-2 text-[11px] leading-4 text-subtle"
                >
                  {afterIsBinary
                    ? `This file became a binary file. Its ${moment.afterBinary?.byteLength ?? 0} bytes are not shown in text diffs.`
                    : `This file was a binary file before this change. Its ${moment.beforeBinary?.byteLength ?? 0} bytes are not shown in text diffs.`}
                </p>
              ) : null}
              <UnifiedDiffLines lines={diffLines} testId="engine-diff-lines" />
            </>
          )}
        </section>
      </div>
      {confirmRestoreOpen ? (
        <Overlay onClose={() => setConfirmRestoreOpen(false)}>
          <div
            data-testid="engine-diff-restore-confirm"
            className="w-[min(420px,calc(100vw-32px))] rounded border border-line bg-panel p-4 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="engine-diff-restore-confirm-title"
          >
            <h3
              id="engine-diff-restore-confirm-title"
              className="m-0 text-sm font-semibold text-ink"
            >
              Restore this file?
            </h3>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              This only changes this one file and records a new history entry.
              Any edits you made since are saved into history first.
            </p>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              <span className="font-mono text-ink">{moment.path}</span>
              <br />
              {restoreDetail}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="engine-diff-cancel-restore"
                onClick={() => setConfirmRestoreOpen(false)}
                className="h-8 cursor-pointer rounded border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="engine-diff-confirm-restore"
                onClick={() => void restoreFile()}
                className="h-8 cursor-pointer rounded bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                Restore
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </section>
  );
}

// Which surface the right-hand Chats panel shows: every workspace chat
// (channels, DMs, file threads) or the ACTIVE file's chats. Runtime-only.
type ChatsPanelTab = "all" | "file";

// The right-hand Chats panel — dohc's secondary sidebar (VS Code grammar:
// toggleable, resizable, persistent width, gone entirely while hidden).
function ChatsPanel(props: {
  width: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  tab: ChatsPanelTab;
  onTabChange: (tab: ChatsPanelTab) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const dragRight = useRef<number | null>(null);

  return (
    <aside
      ref={panelRef}
      data-testid="chats-panel"
      aria-label="Chats"
      className="relative flex shrink-0 flex-col border-l border-line bg-panel-2"
      style={{ width: props.width }}
    >
      <div
        data-testid="chats-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chats"
        onPointerDown={(event) => {
          // Left button only — a right/middle press must never start a resize.
          if (event.button !== 0) return;
          dragRight.current =
            panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRight.current === null) return;
          // A buttons-up move means the release was missed (capture lost
          // outside the window): end the drag instead of resizing on hover.
          if ((event.buttons & 1) === 0) {
            dragRight.current = null;
            return;
          }
          props.onWidthChange(clampChatsWidth(dragRight.current - event.clientX));
        }}
        onPointerUp={() => {
          dragRight.current = null;
        }}
        onPointerCancel={() => {
          dragRight.current = null;
        }}
        onLostPointerCapture={() => {
          dragRight.current = null;
        }}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80"
      />
      {/* Same header grammar + h-9 band as the side panel: the two
          peer chrome surfaces speak one language and their hairlines
          meet the tab strip's on the same pixel row. */}
      <header className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <div className="flex items-center gap-0.5">
          {(
            [
              ["all", "Chats"],
              ["file", "This file"],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              data-testid={`chats-panel-tab-${tab}`}
              aria-pressed={props.tab === tab}
              onClick={() => props.onTabChange(tab)}
              className={`h-6 rounded px-2 text-[11px] font-semibold uppercase tracking-wide ${
                props.tab === tab
                  ? "bg-line/60 text-ink"
                  : "text-muted hover:bg-line/40 hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-0.5">
          {props.actions}
          <button
            type="button"
            data-testid="chats-panel-collapse"
            aria-label="Hide chats"
            title="Hide chats"
            onClick={props.onCollapse}
            className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
          >
            <PanelRight size={13} aria-hidden />
          </button>
        </span>
      </header>
      {props.children}
    </aside>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
      Loading {label}...
    </div>
  );
}

function InvalidSitePathFallback({
  activeTab,
  onClose,
}: {
  activeTab: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    console.error("[desktop] invalid site tab path", {
      activeTab,
      detail: "active tab matched site tab format but activeSiteRoot parsed to null",
    });
    onClose();
  }, [activeTab, onClose]);

  return null;
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  // An empty workspace also lists zero files, so "loaded" needs its own flag —
  // the restored-tab reconciliation below must never run against a listing
  // that has not happened yet.
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  // Main's single answer to "does anything record here" (#542): when the
  // open-time decision produced no recorder — opt-out, unreadable settings,
  // or a failed capture build — every engine-history call can only error,
  // whatever the renderer's own capability read said.
  const statusSaysNoRecorder = (status: SyncStatusResult | null) =>
    Boolean(status?.historyRecordingOff || status?.historyRecordingUnavailable);
  // Whether main's capture decision for THIS workspace has landed. The
  // surfaces that call on mount need it, and no reading of the status can
  // supply it:
  //
  // - `statusSaysNoRecorder(null)` is false, so a MISSING status reads as a
  //   recorder (#620's first fix attempt).
  // - Main registers the workspace's activity entry before it awaits the
  //   capture build, with the recorder fields at their "nothing is wrong"
  //   defaults (`workspaceActivity.ts`). So a PRESENT status reads as a
  //   recorder too, while the build is still running.
  //
  // Both are the same mistake: a default read as an answer. `openWorkspace`
  // resolving is the answer, and it is the only one available here — main
  // awaits the capture build before it returns, and `getSyncStatus` does not
  // await anything at all (its handler reads the entry as it stands).
  //
  // This shell opens the workspace TWICE — the effect below re-runs when the
  // settings read changes `refreshHistory`'s identity — and both calls answer
  // after the decision because main hands a concurrent second open the first
  // one's promise (`main.ts`, `ensureWorkspaceActivityOpen`). That invariant
  // is what makes this fact a fact; the pins below drive it the way main
  // behaves, with one promise answering every call.
  const [captureDecidedFor, setCaptureDecidedForState] = useState<string | null>(null);
  // Mirror of the same fact, for the callbacks that must consult it without
  // listing it as a dependency — the same reason `syncStatusRef` exists
  // beside it (#542): `refreshHistory` is a dependency of the workspace-open
  // effect, so an identity change there re-opens the workspace.
  const captureDecidedRef = useRef<string | null>(null);
  const setCaptureDecidedFor = useCallback((decidedFor: string) => {
    captureDecidedRef.current = decidedFor;
    setCaptureDecidedForState(decidedFor);
  }, []);
  // MU-C5 presence: the signed-in relay session, if any. Drives whether Chats
  // gets a live presence transport (connected + relayUrl) or stays dormant.
  const [cloudStatus, setCloudStatus] = useState<CloudStatusResult | null>(null);
  // Stable per-session client id so this device's own presence entry is
  // identifiable and filtered out of "others". Lazily minted ONCE — a fresh id
  // per render would churn the presence channel.
  const [presenceClientId] = useState(() => crypto.randomUUID());
  const [sitesRefreshKey, setSitesRefreshKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  const [agentSetup, setAgentSetup] = useState<AgentSetupSummary | null>(null);
  const agentSetupRequestRef = useRef(0);
  // Relay-share dialog target (PR 18): a path (file/folder) or a version.
  const [shareTarget, setShareTarget] = useState<{
    path?: string;
    paths?: string[];
    label?: string;
    versionId?: string;
    versionName?: string;
  } | null>(null);
  const [openShareOpen, setOpenShareOpen] = useState(false);
  // The banner carries its own way out. An error that names a value the user
  // can see and gives no way to ask again leaves them with a stale reading and
  // nothing to do about it — the reverse path every reversible state change
  // owes (AGENTS.md). Errors that are already over when they are shown carry
  // no retry.
  const [shellError, setShellError] = useState<{
    message: string;
    retry: (() => void) | null;
    kind?: "singleton-tab-split" | "tab-limit";
  } | null>(null);
  const showTabLimitError = useCallback(
    (
      openTabCount: number,
      nextAction: "open this file" | "open another tab" | "create an editor group",
    ) => {
      setShellError({
        message: `This workspace has ${openTabCount} open tabs; the limit is ${MAX_OPEN_TABS}. Close a tab to ${nextAction}.`,
        retry: null,
        kind: "tab-limit",
      });
    },
    [],
  );
  const clearTabLimitError = useCallback(() => {
    setShellError((currentError) =>
      currentError?.kind === "tab-limit" ? null : currentError,
    );
  }, []);
  const showSingletonTabSplitError = useCallback(() => {
    setShellError({
      message:
        "This tab owns its process and cannot be split. Open another tab before you create an editor group.",
      retry: null,
      kind: "singleton-tab-split",
    });
  }, []);
  const clearEditorGroupRefusalError = useCallback(() => {
    setShellError((currentError) =>
      currentError?.kind === "singleton-tab-split" ||
      currentError?.kind === "tab-limit"
        ? null
        : currentError,
    );
  }, []);
  // Inline-create requests routed INTO the explorer (palette/menu/header).
  const [createRequest, setCreateRequest] = useState<{
    kind: "file" | "folder";
    id: number;
  } | null>(null);
  const [wb, setWb] = useState<WorkbenchState>(defaultWorkbenchState);
  const wbRef = useRef(wb);

  // Mounted editors are group-scoped. A split keeps every active surface
  // mounted, so a singleton flush/source/undo slot would let either pane
  // overwrite the other and could discard the surviving pane during cleanup.
  const mountedEditorsRef = useRef(new Map<string, MountedEditorRegistration>());
  const editorCallbacksRef = useRef(
    new WeakMap<WorkbenchTab, Map<string, EditorRegistrationCallbacks>>(),
  );
  const dirtyTabsRef = useRef(new WeakSet<WorkbenchTab>());
  const dirtyEpochsRef = useRef(new WeakMap<WorkbenchTab, number>());
  const [dirtyRevision, setDirtyRevision] = useState(0);
  const openSettings = useCallback(
    (section: SettingsSectionId = DEFAULT_SETTINGS_SECTION) => setSettingsSection(section),
    [],
  );
  const closeSettings = useCallback(() => setSettingsSection(null), []);

  // Refresh after Settings closes as well as on workspace changes. A request
  // version prevents a slow response for workspace A from painting workspace B.
  useEffect(() => {
    const version = agentSetupRequestRef.current + 1;
    agentSetupRequestRef.current = version;
    void Promise.all([
      bridge().getUserSettings(),
      bridge().getAgentRunStatus({ workspaceId: props.workspace.workspaceId }),
    ])
      .then(([user, run]) => {
        if (agentSetupRequestRef.current !== version) return;
        setAgentSetup({
          preferredName: user.settings.profile.preferredName,
          runnerConfigured: user.settings.runner.command.trim().length > 0,
          runnerEnabled: user.settings.runner.enabled,
          mcpEnabled: run.mcpEnabled,
        });
      })
      .catch(() => {
        if (agentSetupRequestRef.current === version) setAgentSetup(null);
      });
    return () => {
      if (agentSetupRequestRef.current === version) agentSetupRequestRef.current += 1;
    };
  }, [props.workspace.workspaceId, settingsSection]);

  // An Explorer operation retains every closure that is current while its
  // disk mutation is active. This keeps late drafts tied to the editor that
  // created them, including editors in inactive groups.
  const draftOperationScopesRef = useRef(
    new Set<{ flushes: Set<DraftFlush> }>(),
  );
  const callbacksForEditor = useCallback(
    (groupId: string, tab: WorkbenchTab): EditorRegistrationCallbacks => {
      let byGroup = editorCallbacksRef.current.get(tab);
      if (!byGroup) {
        byGroup = new Map();
        editorCallbacksRef.current.set(tab, byGroup);
      }
      const cached = byGroup.get(groupId);
      if (cached) return cached;

      const updateRegistration = <K extends keyof Omit<MountedEditorRegistration, "tab">>(
        key: K,
        value: MountedEditorRegistration[K] | null,
      ) => {
        const current = mountedEditorsRef.current.get(groupId);
        if (value === null) {
          if (current?.tab !== tab) return;
          const next = { ...current };
          delete next[key];
          if (!next.flush && !next.sourceToggle && !next.undo) {
            mountedEditorsRef.current.delete(groupId);
          } else {
            mountedEditorsRef.current.set(groupId, next);
          }
          return;
        }
        const next = current?.tab === tab ? { ...current } : { tab };
        next[key] = value;
        mountedEditorsRef.current.set(groupId, next);
      };
      const callbacks: EditorRegistrationCallbacks = {
        onSaveStateChange: (state) => {
          const dirty = state !== "saved" && state !== "deleted";
          if (dirty === dirtyTabsRef.current.has(tab)) return;
          if (dirty) {
            dirtyTabsRef.current.add(tab);
            dirtyEpochsRef.current.set(
              tab,
              (dirtyEpochsRef.current.get(tab) ?? 0) + 1,
            );
          } else {
            dirtyTabsRef.current.delete(tab);
          }
          setDirtyRevision((revision) => revision + 1);
        },
        registerDraftFlush: (flush) => {
          if (flush === null && dirtyTabsRef.current.delete(tab)) {
            setDirtyRevision((revision) => revision + 1);
          }
          updateRegistration("flush", flush);
          if (flush) {
            for (const scope of draftOperationScopesRef.current) {
              scope.flushes.add(flush);
            }
          }
        },
        registerSourceToggle: (toggle) => updateRegistration("sourceToggle", toggle),
        registerActiveUndo: (handler) => updateRegistration("undo", handler),
      };
      byGroup.set(groupId, callbacks);
      return callbacks;
    },
    [],
  );
  const flushStableDrafts = useCallback(
    async (
      shouldFlush: (groupId: string, tab: WorkbenchTab) => boolean = () => true,
    ) => {
      const flushedAtEpoch = new Map<DraftFlush, number>();
      while (true) {
        const batch = [...mountedEditorsRef.current.entries()]
          .filter(
            ([groupId, registration]) =>
              registration.flush &&
              (flushedAtEpoch.get(registration.flush) ?? -1) <
                (dirtyEpochsRef.current.get(registration.tab) ?? 0) &&
              shouldFlush(groupId, registration.tab),
          )
          .map(([, registration]) => ({
            flush: registration.flush as DraftFlush,
            epoch: dirtyEpochsRef.current.get(registration.tab) ?? 0,
          }));
        if (batch.length === 0) return;
        for (const { flush, epoch } of batch) {
          flushedAtEpoch.set(flush, epoch);
          await flush();
        }
      }
    },
    [],
  );
  // Version and restore operations are workspace-wide, so every mounted
  // draft must settle before the workspace lineage changes.
  const flushActiveDraft = useCallback(() => flushStableDrafts(), [flushStableDrafts]);
  const beginDraftOperation = useCallback(async (): Promise<DraftFlush> => {
    const scope = { flushes: new Set<DraftFlush>() };
    for (const registration of mountedEditorsRef.current.values()) {
      if (registration.flush) scope.flushes.add(registration.flush);
    }
    draftOperationScopesRef.current.add(scope);

    try {
      await flushStableDrafts();
    } catch (error) {
      draftOperationScopesRef.current.delete(scope);
      throw error;
    }

    let settlement: Promise<void> | null = null;
    return (options?: DraftFlushOptions) => {
      if (settlement) return settlement;
      settlement = (async () => {
        const drained = new Set<DraftFlush>();
        let firstError: unknown;
        let failed = false;
        try {
          while (true) {
            const batch = [...scope.flushes].filter(
              (flush) => !drained.has(flush),
            );
            if (batch.length === 0) break;
            for (const flush of batch) {
              drained.add(flush);
              try {
                await flush(options);
              } catch (error) {
                if (!failed) {
                  failed = true;
                  firstError = error;
                }
              }
            }
          }
        } finally {
          draftOperationScopesRef.current.delete(scope);
        }
        if (failed) throw firstError;
      })();
      return settlement;
    };
  }, [flushStableDrafts]);

  const workspaceId = props.workspace.workspaceId;
  // Set-aside recovery markers (#567): every path holding a draft marks its
  // tab and Open Editors row — inactive tabs included, because the store is
  // knowable for all of them (#579 review, r4). Deliberately NOT part of
  // activeTabDirty, which drives save-first machinery that cannot save these
  // (#579 review, P2). The store outlives tabs and version switches, so no
  // save-first prompt is owed.
  const recoveryPaths = useOrphanedDraftPaths(workspaceId);
  // The global recovery list (the close dialog, above this shell) labels
  // rows with the name the UI shows here — the raw id is a UUID (#579
  // review, r10).
  useEffect(() => {
    noteWorkspaceLabel(workspaceId, workspaceName(props.workspace));
  }, [workspaceId, props.workspace]);
  // Every workbench destination change invalidates an in-flight canonical DM
  // lookup. Kept beside the central mutateWb seam so file/graph/history/tab
  // navigation cannot be missed by a one-off opener.
  const dmNavigationRequest = useRef({ workspaceId, sequence: 0 });
  if (dmNavigationRequest.current.workspaceId !== workspaceId) {
    dmNavigationRequest.current = {
      workspaceId,
      sequence: dmNavigationRequest.current.sequence + 1,
    };
  }
  useEffect(() => {
    setShellError(null);
  }, [workspaceId]);

  // MU-C5 presence: track the signed-in relay session for this workspace. The
  // request token + workspaceId key uphold the no-repaint invariant — a slow
  // cloud-status response for workspace A must never set state after a switch
  // to B. `refreshCloudStatus` is also called when the cloud dialog closes so a
  // fresh sign-in lights presence up without waiting for a workspace switch.
  const cloudStatusToken = useRef(0);
  const refreshCloudStatus = useCallback(() => {
    const token = ++cloudStatusToken.current;
    bridge()
      .cloudStatus({ workspaceId })
      .then((status) => {
        if (token === cloudStatusToken.current) setCloudStatus(status);
      })
      .catch(() => {
        if (token === cloudStatusToken.current) setCloudStatus(null);
      });
  }, [workspaceId]);
  useEffect(() => {
    setCloudStatus(null);
    refreshCloudStatus();
    return () => {
      // A pending response after unmount / switch must never repaint.
      cloudStatusToken.current += 1;
    };
  }, [refreshCloudStatus]);
  // The session signal reaches the SHELL too: cloudStatus derives the
  // presence collaboration, so a sign-out must tear the old account's
  // presence down NOW — dropping the status rebuilds the collaboration
  // dormant and aborts its long poll — not when some later refresh notices.
  // The token bump also stops a stale connected response from repainting;
  // the refresh then reports the new session's truth.
  useEffect(() => {
    return bridge().onCloudSessionChanged(() => {
      cloudStatusToken.current += 1;
      setCloudStatus(null);
      refreshCloudStatus();
    });
  }, [refreshCloudStatus]);

  // The presence collaboration for the ACTIVE workspace, rebuilt per workspace
  // (keyed by workspaceId) so a switch tears the old transport down and aborts
  // its in-flight poll — dormant (null) when signed out / no relay.
  const chatCollaboration = useMemo(
    () =>
      buildChatCollaboration({
        connected: cloudStatus?.connected ?? false,
        relayUrl: cloudStatus?.relayUrl,
        email: cloudStatus?.email,
        workspaceId,
        clientId: presenceClientId,
      }),
    [
      cloudStatus?.connected,
      cloudStatus?.relayUrl,
      cloudStatus?.email,
      workspaceId,
      presenceClientId,
    ],
  );

  // @-mention roster + agent notifications (Agent Notifications & Mentions).
  // The renderer has no identity source yet, so the user shows as "You" —
  // the same fallback main uses for local authorship.
  const LOCAL_USER_LABEL = "You";
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () => [
      {
        id: "agent:default",
        kind: "agent",
        handle: "agent",
        label: `${LOCAL_USER_LABEL}'s agent`,
        description: "your agent",
      },
      { id: "user:you", kind: "user", handle: "you", label: LOCAL_USER_LABEL, description: "you" },
    ],
    [],
  );
  const userMentionCandidates = useMemo(
    () => mentionCandidates.filter((candidate) => candidate.kind === "user"),
    [mentionCandidates],
  );
  const agentNotifs = useAgentNotifications({
    workspaceId,
    workspaceName: workspaceName(props.workspace),
    agentName: `${LOCAL_USER_LABEL}'s agent`,
    userCandidates: userMentionCandidates,
  });
  const addressedToMe = useMemo(
    () =>
      agentNotifs.notifications.filter(
        (notification) => notification.kind === "asked" || notification.kind === "needs-input",
      ),
    [agentNotifs.notifications],
  );
  useEffect(() => {
    return scheduleMarkdownEditorPreload();
  }, [workspaceId]);
  const markdownWikilinkFiles = useMemo<WikilinkFile[]>(
    () =>
      files
        .filter((file) => file.kind === "file" && /\.(md|markdown)$/i.test(file.path))
        .map((file) => {
          const pathNoExt = file.path.replace(/\.(md|markdown)$/i, "");
          return {
            path: file.path,
            title: pathNoExt.split("/").pop() ?? file.path,
            fileId: null,
          };
        }),
    [files],
  );
  const conflictSummaries = useMemo(
    () =>
      files
        .filter((file) => file.kind === "file" && file.path.endsWith(".conflict"))
        .slice(0, 5)
        .map((file) =>
          `${file.path.replace(/\.conflict$/, "")} has a sync conflict (${file.path})`,
        ),
    [files],
  );

  // Content search (Phase E5.0). The model lives HERE, not in the Search
  // view, so results — and the activity-bar count badge — survive switching
  // views while the panel unmounts.
  const search = useWorkspaceSearch(workspaceId);
  const graphRefreshKey = useMemo(
    () =>
      [
        String(files.length),
        files.map((file) => file.path).join("\0"),
      ].join("\0"),
    [files],
  );
  const focusedGroup = activeGroup(wb);
  const focusedTabPath = activeTabPath(wb);
  const openTabs = useMemo(() => allTabs(wb), [wb.editorGroups]);
  const dirtyPaths = useMemo(
    () =>
      new Set(
        openTabs
          .filter((tab) => dirtyTabsRef.current.has(tab))
          .map((tab) => tab.path),
      ),
    [dirtyRevision, openTabs],
  );
  const anyTabDirty = dirtyPaths.size > 0;
  const activeDocumentPath = isVirtualTabPath(focusedTabPath)
    ? null
    : focusedTabPath;

  // A clicked search result: open the file AND land at the line. The target
  // is consumed (cleared) by the inspector once a mounted view applied it.
  const [searchScrollTarget, setSearchScrollTarget] = useState<
    (ScrollTarget & { groupId: string }) | null
  >(null);
  const [headingTarget, setHeadingTarget] = useState<{
    groupId: string;
    path: string;
    target: HeadingTarget;
  } | null>(null);
  const fileOpenRequests = useRef({
    workspaceId,
    sequenceByGroup: new Map<string, number>(),
  });
  if (fileOpenRequests.current.workspaceId !== workspaceId) {
    fileOpenRequests.current = {
      workspaceId,
      sequenceByGroup: new Map<string, number>(),
    };
  }
  const invalidateDeferredFileOpen = useCallback((groupId: string) => {
    const requests = fileOpenRequests.current;
    const sequence = (requests.sequenceByGroup.get(groupId) ?? 0) + 1;
    requests.sequenceByGroup.set(groupId, sequence);
    setHeadingTarget((current) =>
      current?.groupId === groupId ? null : current,
    );
    setSearchScrollTarget((current) =>
      current?.groupId === groupId ? null : current,
    );
    return sequence;
  }, []);
  const invalidateDeferredFileOpenForGroupChange = useCallback(
    (previousGroupId: string, nextGroupId: string) => {
      invalidateDeferredFileOpen(previousGroupId);
      if (nextGroupId !== previousGroupId) {
        invalidateDeferredFileOpen(nextGroupId);
      }
    },
    [invalidateDeferredFileOpen],
  );
  const invalidateDeferredFileOpensForTabTransition = useCallback(
    (
      previous: WorkbenchState,
      next: WorkbenchState,
      requestSequencesAtIssue: ReadonlyMap<string, number>,
    ) => {
      const previousGroups = new Map(
        previous.editorGroups.map((group) => [group.id, group] as const),
      );
      const nextGroups = new Map(
        next.editorGroups.map((group) => [group.id, group] as const),
      );
      for (const groupId of new Set([...previousGroups.keys(), ...nextGroups.keys()])) {
        const activeDocumentChanged =
          (previousGroups.get(groupId)?.activeTab ?? null) !==
          (nextGroups.get(groupId)?.activeTab ?? null);
        const requestSequenceIsFresh =
          fileOpenRequests.current.sequenceByGroup.get(groupId) ===
          requestSequencesAtIssue.get(groupId);
        if (
          requestSequenceIsFresh &&
          (activeDocumentChanged || groupId === previous.activeEditorGroup)
        ) {
          invalidateDeferredFileOpen(groupId);
        }
      }
    },
    [invalidateDeferredFileOpen],
  );
  const scrollNonce = useRef(0);
  const consumeSearchScrollTarget = useCallback((nonce: number) => {
    setSearchScrollTarget((current) => (current?.nonce === nonce ? null : current));
  }, []);

  // Restore per-workspace workbench state from .dohc/ui-state.json. Defaults
  // render immediately (launch budgets key off shell visibility); the stored
  // state MERGES when the IPC resolves: it applies only if the user touched
  // NOTHING in the meantime — a pre-load user action wins (and gets an
  // immediate write, since wb may never change again to arm the debounced
  // one). The touched flag is a ref set SYNCHRONOUSLY inside every workbench
  // mutation (mutateWb below): comparing committed state against defaults
  // would race React's commit — a queued-but-uncommitted user action would
  // read as "untouched" and the stored state would clobber it. Writes stay
  // off until the load settles so a default-state write can never clobber
  // the stored one.
  const uiStateLoaded = useRef(false);
  const userTouchedWb = useRef(false);
  // The tab paths the stored state restored — the only ones a file listing is
  // allowed to close. Empty until the load applies, and empty forever when the
  // user acted first and the stored tabs were discarded. STATE, not a ref: the
  // reconciliation below reads it, and the listing can win the race against
  // this load, so it has to re-run when the restore lands.
  const [restoredTabPaths, setRestoredTabPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // THE one mutation seam for workbench state: every user-driven transition
  // routes through here so the touched flag is set before React even queues
  // the update. Loading stored state is the only setWb that bypasses this.
  const mutateWb = useCallback(
    (updater: (state: WorkbenchState) => WorkbenchState) => {
      // A pending canonical DM navigation loses to a DESTINATION change, not
      // to every workbench write. Most writes here are not one: a width drag
      // streams a mutation per pointermove, and the share-mount poll reaches
      // this seam with no user involved at all — cancelling on those would
      // silently discard a DM the user had just clicked. The transition is
      // computed from wbRef outside the functional updater, the idiom openFile
      // and closeFileTab already use for their marks (updaters are
      // side-effect-free by contract, so probing one is safe).
      const current = wbRef.current;
      const next = updater(current);
      if (next === current) return;
      if (
        next.activeEditorGroup !== current.activeEditorGroup ||
        activeTabPath(next) !== activeTabPath(current)
      ) {
        invalidateDmNavigation(dmNavigationRequest);
      }
      userTouchedWb.current = true;
      setWb(updater);
    },
    [],
  );

  useEffect(
    () =>
      bridge().onPluginPanelOpened((event) => {
        if (event.workspaceId !== workspaceId) return;
        const targetGroupId = wbRef.current.activeEditorGroup;
        invalidateDeferredFileOpen(targetGroupId);
        mutateWb((state) =>
          openTab(
            state,
            pluginPanelTabPath(event.pluginId, event.panelId),
            targetGroupId,
          ),
        );
      }),
    [invalidateDeferredFileOpen, mutateWb, workspaceId],
  );

  useEffect(() => {
    let cancelled = false;
    void bridge()
      .getWorkspaceUiState({ workspaceId })
      .then((stored) => {
        if (cancelled) return;
        if (stored && !userTouchedWb.current) {
          const parsed = parseUiState(stored);
          // Order matters: wbRef first, THEN setWb, THEN enable flushes — a
          // beforeunload between "loaded" and the restored state's commit
          // must flush the restored state, never the stale default.
          wbRef.current = parsed;
          setWb(parsed);
          setRestoredTabPaths(new Set(allTabs(parsed).map((tab) => tab.path)));
        }
        uiStateLoaded.current = true;
        if (userTouchedWb.current) {
          void bridge()
            .setWorkspaceUiState({ workspaceId, state: serializeUiState(wbRef.current) })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        uiStateLoaded.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Debounced persist (500ms): tabs, view, panel visibility/width, rail.
  useEffect(() => {
    wbRef.current = wb;
    if (!uiStateLoaded.current) return;
    const timer = setTimeout(() => {
      void bridge()
        .setWorkspaceUiState({ workspaceId, state: serializeUiState(wb) })
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [wb, workspaceId]);

  // Durability at the edges: the debounce above silently drops changes made
  // within 500ms of quitting or switching workspaces — flush the latest state
  // fire-and-forget on beforeunload and on unmount (workspace switch remounts
  // the shell via key={workspaceId}). Gated on the load having resolved so a
  // default snapshot can never clobber stored state.
  useEffect(() => {
    const flush = () => {
      if (!uiStateLoaded.current) return;
      void bridge()
        .setWorkspaceUiState({ workspaceId, state: serializeUiState(wbRef.current) })
        .catch(() => undefined);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [workspaceId]);

  // The close warning for set-aside drafts lives ABOVE the error boundary
  // (RecoveryCloseGuard in main.tsx, #579 review r5) — a guard here would
  // unmount with a crashed shell and the crash screen's reload would destroy
  // the drafts unannounced.

  // Latest-wins: fourteen call sites issue listings — mount, the watcher,
  // imports, restores, the share pull — and they can resolve out of order. An
  // older snapshot committing last would show a stale tree AND make the
  // reconciliation below read a live file as deleted.
  //
  // Supersession is decided when a response COMMITS, not when it is issued. A
  // newer request that is merely in flight has not answered anything yet, and
  // if it fails it never will: dropping this answer for it would leave the
  // explorer empty after a failed refresh, with nothing to retry it. So an
  // older answer fills an unanswered UI, and the newer one supersedes it when
  // it lands. Only an answer OLDER than what is already displayed is dropped.
  const filesRequest = useRef(0);
  const committedFilesRequest = useRef(0);
  // How many listings are still in flight, and a bump each time that reaches
  // zero. The destructive close waits for quiet, not for a particular id: a
  // request that FAILS never commits, so keying off "newest issued" would
  // block the close for as long as the app ran.
  const pendingFilesRequests = useRef(0);
  // The newest request that FAILED. A failure is not an answer, so it cannot
  // refute anything — but it does mean the tree may have moved in a way no
  // surviving snapshot saw, which taints every older snapshot for the one
  // purpose that cannot be undone. See the close below.
  const failedFilesRequest = useRef(0);
  const [listingsSettled, setListingsSettled] = useState(0);
  const refreshFiles = useCallback(async () => {
    const request = ++filesRequest.current;
    pendingFilesRequests.current += 1;
    try {
      const result = await bridge().listWorkspaceFiles({ workspaceId });
      if (request <= committedFilesRequest.current) return;
      committedFilesRequest.current = request;
      setFiles(result.files);
      setFolders(result.folders ?? []);
      setFilesLoaded(true);
    } catch (error) {
      if (request > failedFilesRequest.current) failedFilesRequest.current = request;
      throw error;
    } finally {
      pendingFilesRequests.current -= 1;
      if (pendingFilesRequests.current === 0) {
        setListingsSettled((settled) => settled + 1);
      }
    }
  }, [workspaceId]);

  // Keep a restored tab only while the workspace still lists its file. A
  // rollback, an external delete, or a share pull changes the tree without an
  // explorer op, so nothing remaps the stored tabs and Open Editors keeps a
  // dead path across restarts.
  //
  // Every listing is checked, not just the first. A shared workspace lists
  // twice on open — once at mount, once after refreshShareView pulls the
  // changed paths — and consuming whichever landed first would either miss a
  // remote delete or judge the tabs against a pre-pull snapshot. Only the
  // RESTORED paths are eligible (see pruneMissingRestoredTabs), so a listing
  // that raced a create can never close a tab opened this session.
  //
  // Both inputs are dependencies because either can arrive first: a listing
  // that beats the ui-state load finds nothing restored yet, and the restore
  // is what has to re-run the check.
  useEffect(() => {
    if (!filesLoaded || restoredTabPaths.size === 0) return;
    // Closing a tab is destructive, so it waits until no listing is in
    // flight. The watermark above deliberately lets an older success fill the
    // display — right for the explorer, wrong for closing tabs, because a
    // pull still in flight can carry back a file this older listing predates.
    // Once everything has settled, the committed response is the newest
    // SUCCESS by construction (a response only commits if it is newer than
    // what is displayed), so a failed newer request leaves the older listing
    // authoritative instead of blocking the close for the rest of the session.
    if (pendingFilesRequests.current > 0) return;
    // A failure since the displayed listing was issued means the tree may
    // have changed in a way this snapshot never saw — refreshShareView pulls
    // a file back and the listing that would have shown it is the one that
    // failed. Closing on the older snapshot would then close a tab whose file
    // exists. Waiting costs a delay; closing costs the user their tab, so the
    // close waits for a success issued AFTER the failure. Not a deadlock: the
    // next successful listing re-enables it.
    if (committedFilesRequest.current <= failedFilesRequest.current) return;
    // A DIRTY tab is never closed. Closing it unmounts the keyed inspector
    // mid-draft, whose cleanup flushes best-effort to a path that no longer
    // exists; the write fails, the failure is swallowed, and the draft is
    // gone with no error and no way back. Waiting costs nothing: this re-runs
    // when the draft settles, and closes the tab then.
    const closable = new Set(
      [...restoredTabPaths].filter((path) => !dirtyPaths.has(path)),
    );
    const present = new Set(files.map((file) => file.path));
    const fileExists = (path: string) => present.has(path);
    const current = wbRef.current;
    const next = pruneMissingRestoredTabs(current, closable, fileExists);
    if (next === current) return;
    const groupsOpeningFiles = groupsMountingNewDocument(current, next);
    if (
      next.activeEditorGroup !== current.activeEditorGroup ||
      activeTabPath(next) !== activeTabPath(current)
    ) {
      // This commits through the direct setter, on purpose: reconciling is not
      // a user action and must not set the touched flag. But it moves the
      // active tab exactly as mutateWb does, so it owes the same invalidation
      // — otherwise an in-flight DM navigation still passes its isCurrent()
      // check and lands its destination on top of the tab we just activated.
      invalidateDmNavigation(dmNavigationRequest);
    }
    // Activating a neighbour remounts the keyed inspector — that is an OPEN
    // (closeFileTab idiom). Without the mark, the inspector's mount measure
    // brackets whatever stale mark came before it.
    for (const groupId of groupsOpeningFiles) {
      rendererMarks.mark(fileOpenStartMark(groupId));
    }
    setWb((state) => pruneMissingRestoredTabs(state, closable, fileExists));
  }, [
    files,
    filesLoaded,
    listingsSettled,
    restoredTabPaths,
    dirtyPaths,
    wb.activeEditorGroup,
    focusedTabPath,
  ]);

  const reportShellError = useCallback((fallback: string, error: unknown) => {
    setShellError({
      message: error instanceof Error ? error.message : fallback,
      retry: null,
    });
  }, []);
  // What a failed snapshot lane owes the user, and `reportShellError` supplies
  // one third of it. It shows the cause and DROPS the fallback, so three lanes
  // that share one banner arrive as one backend sentence naming none of them —
  // and the user cannot tell whether sync status, agent runs or the try run
  // went stale. The lane says WHICH, the cause says why, and the control asks
  // again: the three parts an error owes (copy.md), in that order, so the lane
  // survives truncation.
  //
  // The retry matters most on the first load. A sibling that fails while the
  // page succeeds renders the timeline, which hides History's own Try again —
  // so without this the lane had no way back at all, and its value could sit
  // stale until unrelated workspace activity happened to refresh it.
  const reportLaneFailure = useCallback(
    (lane: string, error: unknown, retry: () => void) => {
      const cause = error instanceof Error ? error.message : null;
      setShellError({ message: cause ? `${lane} ${cause}` : lane, retry });
    },
    [],
  );

  // Quiet, self-dismissing status line for import/share-mount summaries
  // ("Imported 3 files into notes.") — informational, never the error banner.
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  const shellNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showShellNotice = useCallback((message: string) => {
    setShellNotice(message);
    if (shellNoticeTimer.current) clearTimeout(shellNoticeTimer.current);
    shellNoticeTimer.current = setTimeout(() => setShellNotice(null), 6000);
  }, []);
  useEffect(
    () => () => {
      if (shellNoticeTimer.current) clearTimeout(shellNoticeTimer.current);
    },
    [],
  );

  const refreshSites = useCallback(() => {
    setSitesRefreshKey((key) => key + 1);
    void refreshFiles().catch((error) =>
      reportShellError("Could not refresh workspace files.", error),
    );
  }, [refreshFiles, reportShellError]);

  // Workspace-engine alpha (PR 0M-4/0M-5): versions surface, ENGINE history
  // source, and the linked Chats rail all key off this one per-workspace
  // capability, read once from the existing settings IPC below — never a
  // second settings read.
  //
  // The answer is kept WITH the workspace it answered for, so "no answer yet"
  // and "answered off" are never the same state — a bare `false` cannot say
  // which, and the surfaces below must not state a capability from a read
  // that has not happened. A read for another workspace is discarded here
  // rather than retracted by an effect, so switching away and back cannot
  // leave the previous workspace's answer standing over a pending one.
  const [engineRead, setEngineRead] = useState<{
    workspaceId: string;
    enabled: boolean;
  } | null>(null);
  const engineReadForWorkspace =
    engineRead?.workspaceId === workspaceId ? engineRead : null;
  const engineEnabled = engineReadForWorkspace?.enabled ?? false;
  // A shared view has no engine history surface regardless of that read
  // (#540): it materializes no settings file, so the default flag reads ON —
  // but the share's open deliberately installed no capture, and every
  // engine-moments call could only error. Capability identity comes from
  // main's registry summary. This gates the HISTORY surface and, below, the
  // VERSIONS surface (#589) and CHATS (#615), for the same reason and from
  // the same fact.
  const isShareView = Boolean(props.workspace.shareView);
  // Engine history page state (flagged workspaces): newest-first moments,
  // the keyset cursor for older pages, and the monotonic latest order used
  // as the open-file refresh key.
  const [engineHistory, setEngineHistory] = useState<{
    moments: EngineMomentRecord[];
    nextBeforeMomentOrder: number | null;
    latestMomentOrder: number;
  } | null>(null);
  const [engineHistoryLoadingMore, setEngineHistoryLoadingMore] = useState(false);
  // Why there is no page. A null timeline is not "no changes": it is also a
  // first read still in flight, a read that FAILED, and a page dropped as
  // stale and asked again. "No changes yet" is an assertion about the
  // WORKSPACE, so only a read that answered may reach it (#593) — this says
  // whether the newest read answered at all.
  const [engineHistoryReadFailed, setEngineHistoryReadFailed] = useState(false);
  // The newest history refresh ISSUED. Only it may call the surface
  // unloadable: an older read failing while a newer one is still in flight
  // has settled nothing. Kept apart from the committed-page watermark on
  // purpose — a failure must not supersede the page lane, because an older
  // read that still succeeds is the only answer anyone has (#507).
  const newestEngineHistoryRefresh = useRef(0);
  // Liveness token for the engine history loads (bumped on unmount): a slow
  // response for one workspace must never repaint another.
  const engineHistoryToken = useRef(0);
  // The newest request whose answer is DISPLAYED — the same commit-time
  // watermark the file listing above uses, for the same reason. A request that
  // is merely in flight has answered nothing, and one that FAILS never will,
  // so superseding on ISSUE threw away the only answer there was and left the
  // timeline stale until some later event refreshed it. Only an answer older
  // than what is already displayed is dropped.
  const committedEngineHistoryToken = useRef(0);
  // A pagination in flight, or 0. Its page is fetched from a cursor into the
  // DISPLAYED timeline, so an older refresh must not reset the timeline under
  // it — the append would land against a cursor that no longer describes what
  // is on screen. Cleared when the pagination settles, so a FAILED one stops
  // holding anything back.
  const pendingEngineHistoryPage = useRef(0);
  // A refresh that was blocked by that pagination, held until it settles.
  // Blocked is not refuted: the pagination may FAIL, and then this is again
  // the only answer anyone has. Dropping it at resolve time would be the very
  // bug the watermark exists to fix, one interleaving over (#507).
  const blockedEngineHistoryRefresh = useRef<{
    token: number;
    activeVersionId: string;
    commit: () => void;
  } | null>(null);
  // The sync, agent, and try snapshots ride the refresh response but are NOT
  // the timeline: no pagination competes for them, so they apply as soon as
  // they arrive. Each is its OWN lane with its own watermark, because a local
  // write only ever knows about the lane it wrote — dismissing a review says
  // nothing about sync state, and rejecting all three would strand a status
  // bar that has no other source (the dismiss emits no activity event).
  //
  // Each lane owns its state, so a write that names no request cannot be
  // written at all (#636). The history page is not one of these: it carries
  // its own admission rules — version staleness, a pagination that may hold it
  // — and the refresh returns it, so it is judged where those rules live.
  const [syncStatus, syncStatusLane] = useSnapshotLane<SyncStatusResult | null>(
    engineHistoryToken,
    null,
  );
  const [agentActive, agentActiveLane] = useSnapshotLane(engineHistoryToken, false);
  // "Try it in a version" (PR 0N-2): the workspace's live try session —
  // running banner or the run's review card. Refreshed with history (the
  // manager pings the same workspace-activity channel on every transition).
  const [tryState, tryStateLane] = useSnapshotLane<TryInVersionRunState | null>(
    engineHistoryToken,
    null,
  );
  // The version the DISPLAYED timeline describes, so a pagination can prove
  // its page extends the same timeline it is appending to.
  const committedEngineVersionId = useRef<string | null>(null);
  // The newest authoritative statement of WHICH version is active, and the
  // request that carried it. The engine stamps every history answer with the
  // version it served, and a version-state change asks for it directly; both
  // are the same kind of fact, ordered by the same issue counter, so the newer
  // one wins. The active version is tracked here rather than inferred from the
  // displayed page because a user can switch versions before the FIRST page
  // commits — then there is no displayed version to name, and the old-version
  // answer used to paint over the version they had switched to.
  const activeEngineVersion = useRef<{ token: number; versionId: string | null }>({
    token: 0,
    versionId: null,
  });
  const noteActiveEngineVersion = useCallback((token: number, versionId: string) => {
    if (token > activeEngineVersion.current.token) {
      activeEngineVersion.current = { token, versionId };
    }
  }, []);
  // Staleness is one question: does this answer describe a version that a NEWER
  // statement has already replaced? An answer ISSUED after that statement can
  // never be stale — the engine served it after the switch — which is what
  // keeps a valid new-version refresh that raced the switch event.
  const engineHistoryAnswerIsStale = useCallback(
    (token: number, activeVersionId: string) =>
      activeVersionId !== activeEngineVersion.current.versionId &&
      token < activeEngineVersion.current.token,
    [],
  );
  // The retraction both version paths need. A version statement can arrive
  // AFTER the page it contradicts is already on screen, and #502's guard only
  // stops a bad answer from being ADMITTED — nothing takes back a page
  // admitted legitimately before the switch. A committed page the newest
  // statement contradicts describes a timeline nobody is on, so drop it and
  // let the surface say it does not know. Reports whether it dropped, because
  // the caller that has no refresh already running owes one. Returns false
  // after an unmount by construction: the committed watermark then sits at
  // the bumped issue counter, which no statement is newer than.
  const dropContradictedEngineHistory = useCallback(() => {
    if (
      committedEngineVersionId.current === null ||
      !engineHistoryAnswerIsStale(
        committedEngineHistoryToken.current,
        committedEngineVersionId.current,
      )
    ) {
      return false;
    }
    committedEngineVersionId.current = null;
    setEngineHistory(null);
    return true;
  }, [engineHistoryAnswerIsStale]);
  useEffect(
    () => () => {
      // Unmount invalidates every load in flight on the history page. Hygiene,
      // not a repaint guard: the shell is keyed by workspace, so a late
      // response has no mounted state to reach. It keeps the invalidation true
      // to what it claims, now that the issue counter alone no longer stops a
      // response from committing. The snapshot lanes invalidate themselves.
      engineHistoryToken.current += 1;
      committedEngineHistoryToken.current = engineHistoryToken.current;
      newestEngineHistoryRefresh.current = engineHistoryToken.current;
      blockedEngineHistoryRefresh.current = null;
    },
    [],
  );
  // Which surface the right-hand Chats panel shows (all chats vs the active
  // file's). Runtime-only — not persisted.
  const [chatsPanelTab, setChatsPanelTab] = useState<ChatsPanelTab>("all");
  const [searchChatTarget, setSearchChatTarget] = useState<{
    thread: ChatThreadRecord;
    focusMessageId?: string;
  } | null>(null);
  // The local writers on these lanes. Dismissing the review card clears it
  // here, and that IS the user acting: it supersedes whatever a request issued
  // earlier will eventually say.
  const onTryReviewDismissed = useCallback(() => {
    tryStateLane.set(null);
  }, [tryStateLane]);
  // Settings reports the agent lane two different ways, and only one of them
  // is the user acting. Starting or ending a run is a local write, newer than
  // every request in flight. Merely OBSERVING that the run changed under the
  // rendered label is not: that reading came from its own request, which may
  // have been issued BEFORE a refresh the shell is still waiting on — and
  // superseding on it would throw away the newer answer. A run observed alive
  // just before it ended would then leave the indicator running forever.
  //
  // So an observation is not written at all. It carries no request token, and
  // arrival order is not ordering: once each lane commits when its OWN read
  // lands, a refresh answer can commit BEFORE the observation arrives, and an
  // untimed write would then paint over an answer that is newer than it. The
  // observation asks this lane's own reader instead — one tokened read, judged
  // by the same rule as every other answer, and issued after the observation,
  // so it is the freshest thing available.
  const refreshAgentLane = useCallback(() => {
    const token = ++engineHistoryToken.current;
    agentActiveLane.settle(
      token,
      bridge().getAgentRunStatus({ workspaceId }),
      (agent) => agent.activeRun !== null,
      (error) =>
        reportLaneFailure("dohc could not refresh agent runs.", error, () =>
          refreshAgentLane(),
        ),
    );
  }, [agentActiveLane, reportLaneFailure, workspaceId]);
  const onSettingsAgentActiveChange = useCallback(
    ({ active, mutated }: { active: boolean; mutated: boolean }) => {
      if (!mutated) {
        refreshAgentLane();
        return;
      }
      agentActiveLane.set(active);
    },
    [agentActiveLane, refreshAgentLane],
  );

  const refreshHistory = useCallback(async () => {
    // Nothing to refresh before main's capture decision lands (#637). Any
    // workspace's activity event calls this, so "the open effect has
    // resolved" does not bound it — and in that window both answers below are
    // wrong. The engine branch would ask for moments main is about to refuse,
    // because a status that has not been decided reads as a recorder; the
    // other branch would commit that undecided status over the decided one
    // the open effect is about to publish. The open effect commits the
    // decision and the status it decided together, so nothing is lost by
    // waiting for it.
    if (captureDecidedRef.current !== workspaceId) return;
    // The engine fetch runs only when main's status agrees a recorder exists
    // (#542): after a failed capture build the renderer's own read still
    // says engine-on, and every listEngineMoments call would error.
    if (engineEnabled && !isShareView && !statusSaysNoRecorder(syncStatusLane.latest())) {
      // Latest-COMMITTED-wins: each request advances the token, and an answer
      // displays only if it is newer than the answer already displayed, so an
      // older response can never overwrite newer moments or move
      // latestMomentOrder backward (shared with loadMoreEngineHistory).
      const token = ++engineHistoryToken.current;
      newestEngineHistoryRefresh.current = token;
      // A read is on the way, so the surface does not know yet — which is a
      // different thing from knowing the last read failed. Saying so here is
      // also what makes the retry control show that it is working.
      setEngineHistoryReadFailed(false);
      // Four reads ride one refresh, and they answer four different
      // questions. One batch made every answer hostage to the worst of them:
      // a try-state failure discarded a history page the engine had already
      // served, and the timeline then said it could not load (#610). An
      // aggregate await is hostage to the SLOWEST of them the same way — a
      // sibling that never settles would hold a failed history read in
      // "Loading history..." forever, with no failure and no Try again.
      // So the reads are issued together and handled apart: each lane
      // commits its own answer when that answer arrives.
      //
      // The snapshots need no ordering against the page: nothing can block
      // them, and holding them for a later commit would republish a world the
      // user has already acted on — a dismissed review card, most visibly.
      // Each is handed whole to the lane rule, which judges both ways it can
      // settle.
      const pageRead = bridge().listEngineMoments({ workspaceId, limit: 200 });
      // Asking again IS this refresh: it re-reads all four, so the lane that
      // failed is read again. Same control the History surface offers for its
      // own read, and the same one the caller runs on any activity.
      const askAgain = () => {
        void refreshHistory().catch((error) =>
          reportShellError("Could not refresh history.", error),
        );
      };
      syncStatusLane.settle(
        token,
        bridge().getSyncStatus({ workspaceId }),
        (status) => status,
        (error) =>
          reportLaneFailure("dohc could not refresh sync status.", error, askAgain),
      );
      agentActiveLane.settle(
        token,
        bridge().getAgentRunStatus({ workspaceId }),
        (agent) => agent.activeRun !== null,
        (error) =>
          reportLaneFailure("dohc could not refresh agent runs.", error, askAgain),
      );
      tryStateLane.settle(
        token,
        bridge().getTryInVersionState({ workspaceId }),
        (trySession) => trySession.state,
        (error) =>
          reportLaneFailure(
            "dohc could not refresh this workspace's try run.",
            error,
            askAgain,
          ),
      );
      let page: Awaited<typeof pageRead>;
      try {
        page = await pageRead;
      } catch (error) {
        // A failure is an answer too — about why the surface is blank, not
        // about what the timeline holds. Only the newest read may give it:
        // an older one failing while a newer is still in flight has settled
        // nothing, and after unmount the counter belongs to no read at all.
        if (token === newestEngineHistoryRefresh.current) {
          setEngineHistoryReadFailed(true);
        }
        throw error;
      }
      if (token <= committedEngineHistoryToken.current) return;
      // An answer describing the version the user left is not late — it is
      // about somewhere else.
      if (engineHistoryAnswerIsStale(token, page.activeVersionId)) return;
      noteActiveEngineVersion(token, page.activeVersionId);
      const commit = () => {
        committedEngineHistoryToken.current = token;
        committedEngineVersionId.current = page.activeVersionId;
        // A refresh returns to the newest page; older pages reload on demand,
        // so any load-more it supersedes is over.
        setEngineHistoryLoadingMore(false);
        setEngineHistory({
          moments: page.moments,
          nextBeforeMomentOrder: page.nextBeforeMomentOrder,
          latestMomentOrder: page.latestMomentOrder,
        });
      };
      // Blocked by a newer pagination: hold this answer instead of throwing it
      // away, and let the pagination's settlement decide (keeping the newest
      // blocked answer, since an older one could never win afterwards).
      if (token < pendingEngineHistoryPage.current) {
        const held = blockedEngineHistoryRefresh.current;
        if (!held || token > held.token) {
          blockedEngineHistoryRefresh.current = {
            token,
            activeVersionId: page.activeVersionId,
            commit,
          };
        }
        return;
      }
      commit();
      return;
    }
    // Opted-out workspace (retirement Phase C): no history source exists —
    // only status and agent state refresh. They ride the same issue order as
    // the engine branch's reads: this refresh answers the very lanes the
    // settings panel and a second refresh also write, and an untimed write
    // ranked by arrival undid both — a run the user had just started, and a
    // newer status (#636).
    const token = ++engineHistoryToken.current;
    const [status, agent] = await Promise.all([
      bridge().getSyncStatus({ workspaceId }),
      bridge().getAgentRunStatus({ workspaceId }),
    ]);
    syncStatusLane.commit(token, status);
    agentActiveLane.commit(token, agent.activeRun !== null);
  }, [
    agentActiveLane,
    engineEnabled,
    isShareView,
    reportLaneFailure,
    reportShellError,
    syncStatusLane,
    tryStateLane,
    workspaceId,
  ]);

  const loadMoreEngineHistory = useCallback(async () => {
    const cursor = engineHistory?.nextBeforeMomentOrder;
    if (cursor === null || cursor === undefined || engineHistoryLoadingMore) return;
    // Same rule as refreshHistory, in both directions: overlapping responses
    // are ordered by which one is newer, never by which one was issued last,
    // so they can neither interleave into a mixed timeline nor discard each
    // other for merely existing.
    const token = ++engineHistoryToken.current;
    // The version this page belongs to: the one the DISPLAYED timeline shows,
    // because that is the timeline the cursor points into.
    const pageVersionId = committedEngineVersionId.current;
    pendingEngineHistoryPage.current = token;
    setEngineHistoryLoadingMore(true);
    try {
      const page = await bridge().listEngineMoments({
        workspaceId,
        limit: 200,
        beforeMomentOrder: cursor,
      });
      // The committed-answer rule, applied to this page as well: display it
      // unless a NEWER answer already took the timeline. Superseding on issue
      // here let a newer refresh that merely FAILED throw this page away.
      // Same two questions as the refresh, plus one an append owes: the page
      // must describe the SAME version as the timeline it extends.
      const stale = engineHistoryAnswerIsStale(token, page.activeVersionId);
      if (!stale) noteActiveEngineVersion(token, page.activeVersionId);
      if (
        token > committedEngineHistoryToken.current &&
        !stale &&
        page.activeVersionId === committedEngineVersionId.current
      ) {
        committedEngineHistoryToken.current = token;
        setEngineHistory((current) =>
          current
            ? {
                moments: [...current.moments, ...page.moments],
                nextBeforeMomentOrder: page.nextBeforeMomentOrder,
                latestMomentOrder: Math.max(
                  current.latestMomentOrder,
                  page.latestMomentOrder,
                ),
              }
            : current,
        );
      }
    } catch (error) {
      // Two ways this failure is about a timeline nobody is looking at: a
      // newer answer already replaced what the page was going to extend, or
      // the user left the version the page belongs to. A failure IS an answer
      // for the purposes of the version rule — it answers about somewhere
      // else — and the switch does not move the committed watermark, so
      // without this the user gets a banner for a timeline they have left.
      const forALeftVersion =
        pageVersionId !== null && engineHistoryAnswerIsStale(token, pageVersionId);
      if (token > committedEngineHistoryToken.current && !forALeftVersion) {
        reportShellError("Could not load earlier history.", error);
      }
    } finally {
      // Settlement, not success, releases what this pagination held: the
      // pending slot, the refresh it blocked, and the button. A pagination
      // superseded by a newer one releases nothing — that newer one owns all
      // three now, so nothing is left stuck either way. The held answer is
      // judged HERE, by the same two questions every answer faces, so a
      // version switch in between drops it and a merge that never changed the
      // version does not.
      if (pendingEngineHistoryPage.current === token) {
        pendingEngineHistoryPage.current = 0;
        const held = blockedEngineHistoryRefresh.current;
        blockedEngineHistoryRefresh.current = null;
        if (
          held &&
          held.token > committedEngineHistoryToken.current &&
          !engineHistoryAnswerIsStale(held.token, held.activeVersionId)
        ) {
          held.commit();
        }
        setEngineHistoryLoadingMore(false);
      }
    }
  }, [engineHistory, engineHistoryLoadingMore, reportShellError, workspaceId]);

  // Whether this workspace has engine-backed surfaces AT ALL — history,
  // versions and chats (PR 0M-4). Unflagged workspaces render none of them,
  // and neither does a shared view (#589, #615, #621): it materializes no
  // settings file, so the read below returns the default ON while its open
  // deliberately installed no capture. Both halves are synchronous registry
  // facts, so this value never waits on anything.
  const engineSurfacesExist = engineEnabled && !isShareView;
  // Whether main's capture will SERVE those surfaces. Main's status is the
  // single answer to "does anything record here", and it overrides the
  // renderer's own engine read: after a failed capture build that read still
  // says engine-on for a perfectly NORMAL workspace, and every version, chat
  // and moment call is refused (#620, #628, #637). It can only override it
  // once main has DECIDED, which is what `captureDecided` carries — a status
  // that has not been decided sits at its "nothing is wrong" defaults, and
  // reading those as an answer is how this gate was wrong twice.
  //
  // THE capture capability. Everything that calls through
  // `requireEngineCapture` reads this one value — the version selector, the
  // Try-in-version banner and review card, the shell's version fetch, the
  // persisted compare and moment-diff tabs, the Chats panel and tab, the
  // graph's chat mentions and the linked-mentions panel — so the fact is
  // decided once. A surface that re-derives it drifts, which is exactly how
  // the compare tab kept mounting after #614 gated the selector.
  //
  // BOTH reads, because a surface that states a capability must have both
  // answers. Main's open resolves immediately for a workspace it already
  // retains, so a healthy workspace re-entered mid-session reaches the
  // decision while the settings read is still in flight — `engineEnabled`
  // still holds its "no answer" false, and every branch below would state an
  // unavailability that main never reported (#637, codex r2).
  const captureDecided =
    captureDecidedFor === workspaceId && engineReadForWorkspace !== null;
  const captureAvailable =
    engineSurfacesExist && captureDecided && !statusSaysNoRecorder(syncStatus);
  // Bumped after a version switch/merge/conflict resolution so open editors
  // re-read their file content immediately (FileInspector refreshKey).
  const [versionEpoch, setVersionEpoch] = useState(0);
  // An unreadable settings file reads as opted out, so the workspace records
  // nothing. That must never be silent — but the notice says so from MAIN's
  // open-time read (syncStatus.settingsWarning), the read that decided
  // whether anything is recorded. This read only drives which engine
  // surfaces the shell offers (versions and chats).
  useEffect(() => {
    let cancelled = false;
    void bridge()
      .getWorkspaceSettings({ workspaceId })
      .then((result) => {
        if (cancelled) return;
        setEngineRead({
          workspaceId,
          enabled: result.settings.experimental.workspaceEngineAlpha,
        });
      })
      .catch(() => {
        // Settings unavailable reads as flag off — never a broken shell.
        // Capability only, fail-closed (#329): the surface hides, but what
        // the placeholder then SAYS comes from main's status. This failure
        // must never be translated into an asserted opt-out (#542).
        //
        // It is still an ANSWER. Recording it is what releases the surfaces
        // below from their load state; a failure held as "pending" would
        // leave a persisted tab spinning for the rest of the session.
        if (cancelled) return;
        setEngineRead({ workspaceId, enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  // Conflict review (0P-C): opened from the notice center's conflict notice.
  // Lists every open conflict — two machines editing apart, or a merge left
  // with "Finish later" — with the same side-by-side cards as the merge flow.
  const [conflictReviewOpen, setConflictReviewOpen] = useState(false);
  const onVersionWorkspaceStateChanged = useCallback(
    (activeVersionId?: string) => {
      setVersionEpoch((epoch) => epoch + 1);
      // A version switch changes WHICH timeline is true, and the boundary is
      // only worth anything BEFORE the answers it has to judge arrive.
      // Rejecting everything in flight by token was too blunt: main notifies
      // the renderer BEFORE the switch invoke resolves, so a perfectly valid
      // NEW-version refresh can be issued before this runs, and rejecting it
      // left the panel on the old version whenever the refresh below failed.
      // Naming the version instead fixes that — but a version this callback
      // has to AWAIT is not a boundary at all: an old answer landing first
      // reads a guard that knows nothing, commits, and the late lookup cannot
      // retract it.
      //
      // So the operation says which version it left the workspace on. Every
      // caller that moved the workspace knows: a switch names its target, a
      // create and a try name the version they forked into, and going back to
      // Main names Main. Nobody has to ask, and there is no window.
      //
      // Nothing is discarded here. This callback also runs for merges and
      // conflict resolutions that never changed the version at all, so a
      // refresh held behind a pagination is judged when that pagination
      // settles, not thrown away on the chance that a switch happened.
      const versionToken = ++engineHistoryToken.current;
      if (activeVersionId !== undefined) {
        noteActiveEngineVersion(versionToken, activeVersionId);
        // The page on screen belongs to the version the user just left, and
        // the refresh below is the only thing that would replace it — so a
        // refresh that FAILS used to leave the timeline naming a version
        // nobody is on (#594). Retract it here instead. A merge or a
        // conflict resolution names the version the page already describes,
        // so nothing is dropped for them.
        dropContradictedEngineHistory();
      } else if (
        // The capture gate again, off the MIRRORS for the same reason
        // refreshHistory uses them (#620): this callback also runs from the
        // conflict review dialog, which the notice center opens with no
        // version surface on screen. Not asking leaves the previous statement
        // standing — what the catch below already does. Same clauses as
        // `captureAvailable`, so the fetch cannot outlive the render gate.
        engineEnabled &&
        !isShareView &&
        captureDecidedRef.current === workspaceId &&
        !statusSaysNoRecorder(syncStatusLane.latest())
      ) {
        // Nobody could name it: the operation changed no version, or it failed
        // and left an unknown one active. Ask. This read is the only remaining
        // asynchronous boundary, and a failure leaves the previous statement
        // standing — which is not permanent blindness, because history answers
        // carry the active version too and the next refresh to succeed was
        // issued later.
        void bridge()
          .listWorkspaceVersions({ workspaceId })
          .then(({ activeVersionId: active }) => {
            noteActiveEngineVersion(versionToken, active);
            // A boundary that arrives after the answers it must judge is not
            // a boundary (#555): while this lookup was in flight, an answer
            // issued BEFORE it could commit against a guard that still named
            // the version the user left. So the committed page faces the
            // same staleness question every arriving answer faces, now that
            // the statement it was missing exists. This lookup settled long
            // after the refresh below ran, so a drop here owes its own
            // re-fetch — the named branch's refresh is already in flight and
            // owes nothing.
            if (dropContradictedEngineHistory()) {
              void refreshHistory().catch((error) =>
                reportShellError("Could not refresh history.", error),
              );
            }
          })
          .catch(() => undefined);
      }
      void refreshFiles().catch((error) =>
        reportShellError("Could not refresh workspace files.", error),
      );
      void refreshHistory().catch((error) =>
        reportShellError("Could not refresh history.", error),
      );
    },
    [
      dropContradictedEngineHistory,
      engineEnabled,
      isShareView,
      noteActiveEngineVersion,
      refreshFiles,
      refreshHistory,
      reportShellError,
      workspaceId,
    ],
  );
  // One import seam for the dialog flow AND the OS drag-in flow (the latter
  // passes the preload-resolved absolute paths; see the trust-delta note on
  // ImportWorkspaceFilesPayload). targetDir aims the import at a folder ("" /
  // absent = root) — the drop target, or the folder whose context menu ran
  // "Import Files…". Every import ends with a visible summary: what landed,
  // where, and how many sources were skipped — never a silent shrink.
  const importFiles = useCallback(
    async (droppedPaths?: string[], targetDir?: string) => {
      let outcome: { imported: string[]; skipped: number };
      try {
        outcome = await bridge().importWorkspaceFiles({
          workspaceId,
          ...(droppedPaths ? { droppedPaths } : {}),
          ...(targetDir ? { targetDir } : {}),
        });
      } catch (error) {
        reportShellError("Could not import files.", error);
        return;
      }
      const count = outcome.imported.length;
      if (count === 0 && outcome.skipped === 0) return; // cancelled dialog
      const skippedSuffix =
        outcome.skipped > 0 ? ` (${outcome.skipped} skipped)` : "";
      showShellNotice(
        count === 0
          ? `Nothing imported${skippedSuffix}.`
          : `Imported ${count} ${count === 1 ? "file" : "files"}${
              targetDir ? ` into ${targetDir}` : ""
            }${skippedSuffix}.`,
      );
      if (count === 0) return;
      try {
        await refreshFiles();
      } catch (error) {
        reportShellError("Files imported, but the explorer could not refresh.", error);
      }
    },
    [workspaceId, refreshFiles, reportShellError, showShellNotice],
  );


  // THE one way a file opens (tree click, quick-open, tab activation): marks
  // file-open-start — file views measure open latency from here — then opens
  // or re-activates the tab. The inspector mounts keyed by the active tab, so
  // every activation is a fresh read + measure. Mark ONLY when the open
  // actually changes something (activeTab moves or a tab is added): a no-op
  // click on the already-active row/tab/overflow item triggers no remount, so
  // marking would leave a stale file-open-start that corrupts the NEXT
  // measure. The transition is computed from wbRef (synced post-commit) and
  // the mark fires once, OUTSIDE the functional updater — updaters must stay
  // side-effect-free (StrictMode/concurrent replays would re-fire them).
  const openFile = useCallback(
    (
      path: string,
      target?: HeadingTarget,
      scrollTarget?: Omit<ScrollTarget, "path">,
    ) => {
      const targetGroupId = wbRef.current.activeEditorGroup;
      const requestSequence = invalidateDeferredFileOpen(targetGroupId);
      const isCurrentRequest = () =>
        fileOpenRequests.current.workspaceId === workspaceId &&
        fileOpenRequests.current.sequenceByGroup.get(targetGroupId) ===
          requestSequence;
      // A heading jump is a destination change mutateWb's tab check cannot
      // see: the file may already BE the active tab, and the user still went
      // somewhere new inside it.
      if (target) invalidateDmNavigation(dmNavigationRequest);
      // Heading jumps are one open command, never durable tab state. Every
      // ordinary explorer/tab open therefore clears a prior jump before the
      // file can become active again.
      const pendingHeading = pendingHeadingTargetForOpen(path, target);
      setHeadingTarget(
        pendingHeading ? { ...pendingHeading, groupId: targetGroupId } : null,
      );
      setSearchScrollTarget(
        scrollTarget ? { ...scrollTarget, path, groupId: targetGroupId } : null,
      );
      if (/\.(md|markdown)$/i.test(path)) preloadMarkdownEditor();
      const commitOpen = () => {
        if (!isCurrentRequest()) return;
        const current = wbRef.current;
        if (!current.editorGroups.some((group) => group.id === targetGroupId)) return;
        const next = openTab(current, path, targetGroupId);
        const targetAlreadyOwnsPath = current.editorGroups
          .find((group) => group.id === targetGroupId)
          ?.tabs.some((tab) => tab.path === path);
        if (
          next === current &&
          !targetAlreadyOwnsPath &&
          allTabs(current).length >= MAX_OPEN_TABS
        ) {
          showTabLimitError(allTabs(current).length, "open this file");
          return;
        }
        if (next !== current) {
          rendererMarks.mark(fileOpenStartMark(targetGroupId));
        }
        clearTabLimitError();
        // Every open also records recency (quick-open ranking, Phase E5.0).
        mutateWb((state) => {
          const opened = state === current ? next : openTab(state, path, targetGroupId);
          const rebasedTargetAlreadyOwnsPath = state.editorGroups
            .find((group) => group.id === targetGroupId)
            ?.tabs.some((tab) => tab.path === path);
          if (
            opened === state &&
            !rebasedTargetAlreadyOwnsPath &&
            allTabs(state).length >= MAX_OPEN_TABS
          ) {
            return state;
          }
          return recordRecentFile(opened, path);
        });
      };

      const targetGroup = wbRef.current.editorGroups.find(
        (group) => group.id === targetGroupId,
      );
      const targetAlreadyOwnsPath = targetGroup?.tabs.some(
        (tab) => tab.path === path,
      );
      const needsFlush =
        !targetAlreadyOwnsPath &&
        [...mountedEditorsRef.current.entries()].some(
          ([groupId, registration]) =>
            groupId !== targetGroupId &&
            registration.tab.path === path &&
            registration.flush,
        );
      if (!needsFlush) {
        commitOpen();
        return;
      }
      void flushStableDrafts(
        (groupId, tab) => groupId !== targetGroupId && tab.path === path,
      )
        .then(commitOpen)
        .catch((error) => {
          if (!isCurrentRequest()) return;
          reportShellError(
            "dohc could not save this file. The file did not open in this editor group.",
            error,
          );
        });
    },
    [
      flushStableDrafts,
      clearTabLimitError,
      invalidateDeferredFileOpen,
      mutateWb,
      reportShellError,
      showTabLimitError,
      workspaceId,
    ],
  );
  const openPathWithHeading = useCallback(
    (path: string, target?: string | HeadingTarget) => {
      openFile(
        path,
        typeof target === "string"
          ? { anchor: target, nonce: ++scrollNonce.current }
          : target,
      );
    },
    [openFile],
  );
  const openVirtualTab = useCallback(
    (path: string) => {
      const targetGroupId = wbRef.current.activeEditorGroup;
      invalidateDeferredFileOpen(targetGroupId);
      const current = wbRef.current;
      const next = openTab(current, path, targetGroupId);
      const targetAlreadyOwnsPath = current.editorGroups
        .find((group) => group.id === targetGroupId)
        ?.tabs.some((tab) => tab.path === path);
      if (
        next === current &&
        !targetAlreadyOwnsPath &&
        allTabs(current).length >= MAX_OPEN_TABS
      ) {
        showTabLimitError(allTabs(current).length, "open another tab");
        return;
      }
      clearTabLimitError();
      mutateWb((state) =>
        state === current ? next : openTab(state, path, targetGroupId),
      );
    },
    [
      clearTabLimitError,
      invalidateDeferredFileOpen,
      mutateWb,
      showTabLimitError,
    ],
  );
  const openVersionCompareTab = useCallback(
    (versionId: string) => {
      openVirtualTab(versionCompareTabPath(versionId));
    },
    [openVirtualTab],
  );
  const openGraphTab = useCallback(() => {
    openVirtualTab(GRAPH_TAB_PATH);
  }, [openVirtualTab]);
  const openHistoryTab = useCallback(() => {
    openVirtualTab(HISTORY_TAB_PATH);
  }, [openVirtualTab]);
  // The editor owns the live conversation while the right panel remains a
  // lightweight Slack-style navigator. The ref seeds editor remounts without
  // making draft keystrokes rerender the shell; selectedNav is only updated on
  // navigation so the panel can highlight the active destination.
  const chatsNav = useRef<ChatsNav | null>(null);
  const [selectedChatsNav, setSelectedChatsNav] = useState<ChatsNav | null>(null);
  const [chatsPageRevision, setChatsPageRevision] = useState(0);
  // The navigator's unread badges come from one fetch at its mount, and the
  // editor is what performs the reads — without this the panel keeps showing
  // counts the user already cleared until something remounts it.
  const [chatsReadRevision, setChatsReadRevision] = useState(0);
  const onChatsThreadRead = useCallback(() => {
    setChatsReadRevision((current) => current + 1);
  }, []);
  // THE one write of the chat destination: the ref the panel reads, the state
  // the navigator highlights, and the cancellation that choosing a different
  // conversation implies. Both writers below open-coded these two lines, which
  // is why the invalidation kept being missed one caller at a time — a chat
  // destination can only change here, so this is where the rule belongs.
  // Reports that stay on the same conversation change nothing and cancel
  // nothing.
  const setChatsDestination = useCallback((nav: ChatsNav) => {
    if (chatsNavigationChangesDestination(chatsNav.current, nav)) {
      invalidateDmNavigation(dmNavigationRequest);
    }
    chatsNav.current = nav;
    setSelectedChatsNav(nav);
  }, []);
  const onChatsNav = useCallback(
    (nav: ChatsNav) => {
      setChatsDestination(nav);
    },
    [setChatsDestination],
  );
  // The Chats PAGE's explicit clicks arrive here, with the same rule as
  // openChatsNavInTab: a user command cancels a pending DM lookup even when
  // it repeats the current destination — an exact-repeat backlink still
  // re-loads and re-scrolls, and the page it lands on must not be replaced by
  // a DM answering late. Only the passive onChatsNav report stays conditional.
  const onChatsNavCommand = useCallback(
    (nav: ChatsNav) => {
      invalidateDmNavigation(dmNavigationRequest);
      setChatsDestination(nav);
    },
    [setChatsDestination],
  );
  // Unsent drafts ride the same handoff: mirrored live (a ref write per
  // keystroke, no re-render) and seeded into the next mount, so expanding
  // or collapsing chats never discards what the user typed.
  const chatsDrafts = useRef<ChatsDrafts | null>(null);
  const onChatsDrafts = useCallback((drafts: ChatsDrafts) => {
    chatsDrafts.current = drafts;
  }, []);
  const openChatsTab = useCallback(() => {
    openVirtualTab(CHATS_TAB_PATH);
  }, [openVirtualTab]);
  const openChatsNavInTab = useCallback(
    (nav: ChatsNav) => {
      // Read before the write: both answers are about the destination the
      // panel is leaving.
      const shouldRemount = chatsNavigationRequiresRemount(chatsNav.current, nav);
      const leftConversation = chatsNavigationLeavesConversation(chatsNav.current, nav);
      // An explicit open is the user going somewhere, so it always cancels a
      // pending DM — even when the destination key is unchanged. Repeating a
      // backlink to the message you already focused is the case that proves
      // it: chatsNavigationRequiresRemount deliberately treats it as a new
      // jump, and the page it remounts must not be replaced by a DM answering
      // late. Only the panel's passive onChatsNav reports stay conditional;
      // they say where the view already is, and nobody commanded them.
      invalidateDmNavigation(dmNavigationRequest);
      setChatsDestination(nav);
      if (leftConversation) {
        // Drafts are scoped to the conversation they were typed in. Until the
        // draft store is keyed per channel/thread, never seed one into a
        // different destination.
        chatsDrafts.current = null;
      }
      if (shouldRemount) {
        setChatsPageRevision((current) => current + 1);
      }
      openVirtualTab(CHATS_TAB_PATH);
    },
    [openVirtualTab, setChatsDestination],
  );
  const openCanonicalDmInTab = useCallback(
    async (locator: DmChatLocator) => {
      const request = {
        workspaceId,
        sequence: dmNavigationRequest.current.sequence + 1,
      };
      dmNavigationRequest.current = request;
      await runCanonicalDmNavigation({
        locator,
        syncDms: () => bridge().syncDms({ workspaceId }),
        isCurrent: () =>
          dmNavigationRequest.current.workspaceId === request.workspaceId &&
          dmNavigationRequest.current.sequence === request.sequence,
        // Canonicalization failure deliberately clears any prior DM/thread
        // target. Merely reopening the Chats tab would preserve stale chatsNav.
        open: openChatsNavInTab,
      });
    },
    [openChatsNavInTab, workspaceId],
  );
  // The ONE way a chat thread lands in the Chats panel (search hits, file
  // mentions without channel metadata, and the Chats view "Files" grouping
  // all route here): hand the known thread to the panel's consume-once seam,
  // switch to "This file", and force the panel visible.
  const openChatThreadInPanel = useCallback(
    (
      thread: { id: string; title: string; createdAtMs: number; updatedAtMs: number },
      focusMessageId?: string,
    ) => {
      // The user picked a DIFFERENT chat destination. The panel is not the
      // editor, so no tab moves and the check in mutateWb cannot see this —
      // but a pending DM answering late would open the Chats TAB over the
      // thread they just chose.
      invalidateDmNavigation(dmNavigationRequest);
      setSearchChatTarget({
        thread: {
          id: thread.id,
          title: thread.title,
          createdAtMs: thread.createdAtMs,
          updatedAtMs: thread.updatedAtMs,
        },
        ...(focusMessageId ? { focusMessageId } : {}),
      });
      setChatsPanelTab("file");
      mutateWb((state) => ({ ...state, chatsVisible: true }));
    },
    [mutateWb],
  );
  const openChatMention = useCallback(
    (mention: ChatFileMentionRecord) => {
      const target = chatMentionOpenTarget(mention);
      if (target.surface === "file") {
        openChatThreadInPanel(target.thread, target.focusMessageId);
        return;
      }
      if (target.surface === "overview") {
        openChatsTab();
        return;
      }
      if (target.surface === "dm") {
        void openCanonicalDmInTab(target);
        return;
      }
      openChatsNavInTab(target.nav);
    },
    [openCanonicalDmInTab, openChatThreadInPanel, openChatsNavInTab, openChatsTab],
  );
  const openGraphChatThread = useCallback(
    (node: WorkspaceGraphResult["nodes"][number]) => {
      const target = graphChatOpenTarget(node);
      if (target.surface === "file") {
        openChatThreadInPanel(target.thread);
        return;
      }
      if (target.surface === "overview") {
        openChatsTab();
        return;
      }
      if (target.surface === "dm") {
        void openCanonicalDmInTab(target);
        return;
      }
      openChatsNavInTab(target.nav);
    },
    [openCanonicalDmInTab, openChatThreadInPanel, openChatsNavInTab, openChatsTab],
  );
  // Engine history diff (flagged workspaces): one tab per moment.
  const openMomentDiffTab = useCallback(
    (momentId: string) => {
      const targetGroupId = wbRef.current.activeEditorGroup;
      const requestSequence = invalidateDeferredFileOpen(targetGroupId);
      const isCurrentRequest = () =>
        fileOpenRequests.current.workspaceId === workspaceId &&
        fileOpenRequests.current.sequenceByGroup.get(targetGroupId) ===
          requestSequence;
      void flushActiveDraft()
        .then(() => {
          if (!isCurrentRequest()) return;
          const current = wbRef.current;
          if (!current.editorGroups.some((group) => group.id === targetGroupId)) {
            return;
          }
          mutateWb((state) =>
            openTab(state, momentDiffTabPath(momentId), targetGroupId),
          );
        })
        .catch((error) => {
          if (!isCurrentRequest()) return;
          reportShellError("Could not save the active draft before opening history.", error);
        });
    },
    [
      flushActiveDraft,
      invalidateDeferredFileOpen,
      mutateWb,
      reportShellError,
      workspaceId,
    ],
  );
  const refreshAfterHistoryRestore = useCallback(
    () => {
      void refreshFiles().catch((error) =>
        reportShellError("Could not refresh workspace files.", error),
      );
      void refreshHistory().catch((error) =>
        reportShellError("Could not refresh history.", error),
      );
    },
    [refreshFiles, refreshHistory, reportShellError],
  );
  const activateEditorTab = useCallback(
    (groupId: string, path: string) => {
      const current = wbRef.current;
      const group = current.editorGroups.find(
        (candidate) => candidate.id === groupId,
      );
      if (!group?.tabs.some((tab) => tab.path === path)) return;
      invalidateDeferredFileOpenForGroupChange(
        current.activeEditorGroup,
        groupId,
      );
      if (isVirtualTabPath(path)) {
        mutateWb((state) => activateTab(state, groupId, path));
        return;
      }
      setHeadingTarget(null);
      if (/\.(md|markdown)$/i.test(path)) preloadMarkdownEditor();
      if (group.activeTab !== path) {
        rendererMarks.mark(fileOpenStartMark(groupId));
      }
      mutateWb((state) =>
        recordRecentFile(activateTab(state, groupId, path), path),
      );
    },
    [invalidateDeferredFileOpenForGroupChange, mutateWb],
  );
  const focusWorkbenchEditorGroup = useCallback(
    (groupId: string) => {
      const current = wbRef.current;
      if (
        current.activeEditorGroup === groupId ||
        !current.editorGroups.some((group) => group.id === groupId)
      ) {
        return;
      }
      invalidateDeferredFileOpenForGroupChange(
        current.activeEditorGroup,
        groupId,
      );
      mutateWb((state) => focusEditorGroup(state, groupId));
    },
    [invalidateDeferredFileOpenForGroupChange, mutateWb],
  );

  // Chats view "Files" grouping cross-link: a file-linked Chat opens where
  // it lives — the file (when it still resolves) plus the panel on the
  // thread.
  const openFileChatInPanel = useCallback(
    (
      thread: { id: string; title: string; createdAtMs: number; updatedAtMs: number; path: string | null },
      focusMessageId?: string,
    ) => {
      openChatThreadInPanel(thread, focusMessageId);
      if (thread.path) openFile(thread.path);
    },
    [openChatThreadInPanel, openFile],
  );

  // Search-result click: open + land at the line (source mode this phase);
  // chat results open in the Chats panel instead.
  const openSearchResult = useCallback(
    (path: string, line: number, _column: number, entry?: SearchResultsEventEntry) => {
      if (entry?.surface === "chat" && entry.threadId) {
        const now = Date.now();
        openChatThreadInPanel({
          id: entry.threadId,
          title: entry.title ?? entry.threadId,
          createdAtMs: now,
          updatedAtMs: now,
        });
        return;
      }
      // Landing at a line is the same kind of destination change: openFile
      // below cannot see it, because the result may be in the file the user is
      // already reading.
      invalidateDmNavigation(dmNavigationRequest);
      openFile(path, undefined, {
        line,
        nonce: ++scrollNonce.current,
      });
    },
    [openChatThreadInPanel, openFile],
  );

  // Stable handlers (Tab/FileRow memo contract: a fresh closure here would
  // re-render the whole strip on every shell render, incl. each 800ms dirty
  // flip while typing). Capture the requested tab objects and their owners
  // before the flush: a reopened tab or a tab moved later must stay.
  const closeTabsAfterFlush = useCallback(
    (targets: ReadonlyArray<{ groupId: string; tab: WorkbenchTab }>) => {
      const requested = new Map(
        targets.map(({ groupId, tab }) => [tab, groupId] as const),
      );
      if (requested.size === 0) return;

      const closeRequestedTabs = (state: WorkbenchState): WorkbenchState => {
        let next = state;
        for (const group of state.editorGroups) {
          for (const tab of group.tabs) {
            if (requested.get(tab) !== group.id) continue;
            next = closeTab(next, group.id, tab.path);
            const liveGroup = next.editorGroups.find(
              (candidate) => candidate.id === group.id,
            );
            if (liveGroup?.tabs.length === 0 && next.editorGroups.length > 1) {
              next = closeEditorGroup(next, group.id);
            }
          }
        }
        return next;
      };
      const commitClose = () => {
        const current = wbRef.current;
        const next = closeRequestedTabs(current);
        for (const group of current.editorGroups) {
          const nextGroup = next.editorGroups.find(
            (candidate) => candidate.id === group.id,
          );
          if (nextGroup?.activeTab !== group.activeTab) {
            invalidateDeferredFileOpen(group.id);
          }
        }
        for (const groupId of groupsMountingNewDocument(current, next)) {
          rendererMarks.mark(fileOpenStartMark(groupId));
        }
        mutateWb(closeRequestedTabs);
      };
      const needsFlush = [...mountedEditorsRef.current.entries()].some(
        ([groupId, registration]) =>
          registration.flush && requested.get(registration.tab) === groupId,
      );
      if (!needsFlush) {
        commitClose();
        return;
      }

      // The active tab can change while a flush waits. If the new active tab
      // object was also in the original close request, flush its own mounted
      // editor before closing it. A reopened tab has a new object identity.
      void flushStableDrafts(
        (groupId, tab) => requested.get(tab) === groupId,
      )
        .then(commitClose)
        .catch((error) => {
          reportShellError(
            "Could not save the draft, so the tab stays open.",
            error,
          );
        });
    },
    [
      flushStableDrafts,
      invalidateDeferredFileOpen,
      mutateWb,
      reportShellError,
    ],
  );

  const closeFileTab = useCallback(
    (groupId: string, path: string) => {
      const group = wbRef.current.editorGroups.find(
        (candidate) => candidate.id === groupId,
      );
      const tab = group?.tabs.find((candidate) => candidate.path === path);
      if (tab) void closeTabsAfterFlush([{ groupId, tab }]);
    },
    [closeTabsAfterFlush],
  );

  const commitAfterTabFlush = useCallback(
    (
      groupId: string,
      tab: WorkbenchTab,
      failureMessage: string,
      commit: () => void,
    ) => {
      const registration = mountedEditorsRef.current.get(groupId);
      if (registration?.tab !== tab || !registration.flush) {
        commit();
        return;
      }
      void flushStableDrafts(
        (candidateGroupId, candidateTab) =>
          candidateGroupId === groupId && candidateTab === tab,
      )
        .then(commit)
        .catch((error) => reportShellError(failureMessage, error));
    },
    [flushStableDrafts, reportShellError],
  );

  const closeActiveTab = useCallback(() => {
    const current = wbRef.current;
    const group = activeGroup(current);
    const tab = group.tabs.find((candidate) => candidate.path === group.activeTab);
    if (tab) {
      void closeTabsAfterFlush([{ groupId: group.id, tab }]);
    } else if (current.editorGroups.length > 1) {
      mutateWb((state) => closeEditorGroup(state, group.id));
    }
  }, [closeTabsAfterFlush, mutateWb]);

  const closeAllTabs = useCallback(() => {
    void closeTabsAfterFlush(
      wbRef.current.editorGroups.flatMap((group) =>
        group.tabs.map((tab) => ({ groupId: group.id, tab })),
      ),
    );
  }, [closeTabsAfterFlush]);

  const closeOtherTabs = useCallback(
    (groupId: string, path: string) => {
      const current = wbRef.current;
      const group = current.editorGroups.find((candidate) => candidate.id === groupId);
      if (!group?.tabs.some((tab) => tab.path === path)) return;
      void closeTabsAfterFlush(
        group.tabs
          .filter((tab) => tab.path !== path)
          .map((tab) => ({ groupId, tab })),
      );
    },
    [closeTabsAfterFlush],
  );

  const moveFileTab = useCallback(
    (groupId: string, path: string, toIndex: number) => {
      mutateWb((state) =>
        moveTab(
          state,
          groupId,
          state.editorGroups
            .find((group) => group.id === groupId)
            ?.tabs.findIndex((tab) => tab.path === path) ?? -1,
          toIndex,
        ),
      );
    },
    [mutateWb],
  );

  const moveFileTabToGroup = useCallback(
    (
      sourceGroupId: string,
      targetGroupId: string,
      path: string,
      toIndex: number,
    ) => {
      if (sourceGroupId === targetGroupId) return;
      const sourceGroup = wbRef.current.editorGroups.find(
        (group) => group.id === sourceGroupId,
      );
      const tab = sourceGroup?.tabs.find((candidate) => candidate.path === path);
      if (!tab) return;
      const focus = editorFocus(wbRef.current);
      const requestSequencesAtIssue = new Map(
        fileOpenRequests.current.sequenceByGroup,
      );

      const commitMove = () => {
        const current = wbRef.current;
        const live = current.editorGroups
          .find((group) => group.id === sourceGroupId)
          ?.tabs.find((candidate) => candidate.path === path);
        if (
          live !== tab ||
          !current.editorGroups.some((group) => group.id === targetGroupId)
        ) {
          return;
        }
        const moveState = (state: WorkbenchState) =>
          moveTabToGroup(
            state,
            sourceGroupId,
            targetGroupId,
            path,
            toIndex,
            hasEditorFocus(state, focus) ? "target" : "preserve",
          );
        const next = moveState(current);
        if (next === current) return;
        invalidateDeferredFileOpensForTabTransition(
          current,
          next,
          requestSequencesAtIssue,
        );
        for (const groupId of groupsMountingNewDocument(current, next)) {
          const nextActiveTab = next.editorGroups.find(
            (group) => group.id === groupId,
          )?.activeTab;
          if (nextActiveTab === undefined || nextActiveTab === null) continue;
          const viewKind = classifyForView(nextActiveTab);
          if (viewKind === "markdown" || viewKind === "database") {
            rendererMarks.mark(fileOpenStartMark(groupId));
          }
        }
        mutateWb(moveState);
      };

      commitAfterTabFlush(
        sourceGroupId,
        tab,
        "dohc could not save this file. The tab stayed in its current editor group.",
        commitMove,
      );
    },
    [
      commitAfterTabFlush,
      invalidateDeferredFileOpensForTabTransition,
      mutateWb,
    ],
  );

  const showPathInExplorer = useCallback(
    (path: string) => {
      mutateWb((state) =>
        ancestorDirs(path).reduce<WorkbenchState>(
          (acc, dir) => setFolderExpanded(acc, dir, true),
          { ...state, activeView: "explorer", sidebarVisible: true },
        ),
      );
    },
    [mutateWb],
  );

  // Successful explorer moves/deletes re-project every path-keyed slice
  // (tabs, activeTab, pins, expansion) BEFORE the watcher refresh lands, so
  // a rename never leaves a dead tab pointing at the old path. If the remap
  // changes which inspector is mounted, that is an open — re-mark
  // file-open-start (closeFileTab idiom) so the next measure stays honest.
  const onExplorerPathsChanged = useCallback(
    (changes: PendingTreeChange[]) => {
      // Set-aside drafts key by path, so recovery follows the same projection
      // as tabs and pins (#579 review, P1) — a rename must not strand the
      // notice on the old path while the tab remaps to the new one.
      remapOrphanedDraftPaths(workspaceId, (path) =>
        projectTreePath(path, changes),
      );
      const current = wbRef.current;
      const next = remapWorkbenchPaths(current, (path) =>
        projectTreePath(path, changes),
      );
      for (const groupId of groupsMountingNewDocument(current, next)) {
        rendererMarks.mark(fileOpenStartMark(groupId));
      }
      mutateWb((state) =>
        remapWorkbenchPaths(state, (path) => projectTreePath(path, changes)),
      );
    },
    [mutateWb, workspaceId],
  );

  // Share mounts: the registry is loaded once at boot, so the shell owns a
  // LIVE copy of this workspace's mounts — reloaded after every mount /
  // unmount / refresh — otherwise the poll gate and unmount lookups would
  // run against a stale boot-time snapshot (gpt-5.6-sol P1).
  const [shareMounts, setShareMounts] = useState(
    props.workspace.shareMounts ?? [],
  );
  // Bumped whenever a share pull changed files: mounted content has no host
  // history, so the open-file refresh key needs its own signal or an open
  // mounted tab keeps showing pre-pull content (codex P2).
  const [mountContentEpoch, setMountContentEpoch] = useState(0);
  // Ref mirror so reloads diff against the CURRENT set without making the
  // state updater side-effectful (StrictMode replays updaters).
  const shareMountsRef = useRef(shareMounts);
  shareMountsRef.current = shareMounts;
  // Latest-wins token (cloudStatusToken/engineHistoryToken precedent): a
  // slower, earlier-started reload must never clobber a fresher one — a
  // stale registry snapshot could resurrect a just-removed mount or fire a
  // spurious delete-folder projection against a still-valid one.
  const shareMountsToken = useRef(0);
  const reloadShareMounts = useCallback(async () => {
    const token = ++shareMountsToken.current;
    try {
      const registry = await bridge().getWorkspaceRegistry();
      if (token !== shareMountsToken.current) return;
      const entry = registry.workspaces.find(
        (candidate) => candidate.workspaceId === workspaceId,
      );
      const next = entry?.shareMounts ?? [];
      // A mount that vanished (removed from Settings or another surface)
      // reprojects tabs/pins exactly like the Explorer unmount path — open
      // tabs under the deleted folder must not linger with stale content.
      const gone = shareMountsRef.current.filter(
        (mount) => !next.some((candidate) => candidate.shareId === mount.shareId),
      );
      if (gone.length > 0) {
        onExplorerPathsChanged(
          gone.map((mount) => ({
            id: `unmount-${mount.shareId}`,
            kind: "delete-folder" as const,
            path: `shared-with-me/${mount.label}`,
          })),
        );
      }
      setShareMounts(next);
    } catch {
      // Keep the last known set; the next reload corrects it.
    }
  }, [workspaceId, onExplorerPathsChanged]);

  // Share mounts: pull every mount's share once (quietly — offline or
  // signed-out refreshes are no-ops main-side). `announce` adds the visible
  // summary for the explicit "Refresh Share(s)" menu action.
  const refreshShareMounts = useCallback(
    async (announce = false) => {
      let results: Array<{
        label: string;
        status: "updated" | "unchanged" | "ended";
        changedPaths: number;
      }>;
      try {
        results = (await bridge().refreshShareMounts({ workspaceId })).results;
      } catch (error) {
        if (announce) reportShellError("Couldn't refresh shares.", error);
        return;
      }
      const changed = results.reduce((sum, row) => sum + row.changedPaths, 0);
      if (changed > 0) {
        setMountContentEpoch((epoch) => epoch + 1);
        await refreshFiles().catch(() => undefined);
      }
      if (results.some((row) => row.status === "ended")) void reloadShareMounts();
      if (announce) {
        const ended = results.filter((row) => row.status === "ended");
        showShellNotice(
          results.length === 0
            ? "No shares are added to this workspace."
            : `Shares refreshed — ${changed} ${changed === 1 ? "file" : "files"} updated${
                ended.length > 0
                  ? `; ${ended.map((row) => row.label).join(", ")} ended`
                  : ""
              }.`,
        );
      }
    },
    [workspaceId, refreshFiles, reportShellError, showShellNotice, reloadShareMounts],
  );

  // The workspace prop is DesktopRoot's boot-time registry snapshot — a
  // shell that remounts after workspace switching needs a fresh read or a
  // mount added/removed in the previous visit is invisible (codex P2).
  useEffect(() => {
    void reloadShareMounts();
  }, [reloadShareMounts]);

  // Mounts follow their shares while the workspace is open: one pull on
  // open, then a slow poll. Manual refresh stays available in the explorer
  // context menu.
  const mountCount = shareMounts.length;
  useEffect(() => {
    if (mountCount === 0) return;
    void refreshShareMounts();
    const timer = setInterval(() => void refreshShareMounts(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [mountCount, refreshShareMounts]);

  const unmountShare = useCallback(
    async (path: string) => {
      const label = path.split("/")[1] ?? "";
      const mount = shareMounts.find((m) => m.label === label);
      if (!mount) return;
      try {
        await bridge().unmountShare({ workspaceId, shareId: mount.shareId });
      } catch (error) {
        reportShellError("Couldn't remove the share.", error);
        return;
      }
      // Reproject tabs/pins exactly like a folder delete, then re-list.
      onExplorerPathsChanged([
        {
          id: `unmount-${mount.shareId}`,
          kind: "delete-folder",
          path: `shared-with-me/${label}`,
        },
      ]);
      await refreshFiles().catch(() => undefined);
      void reloadShareMounts();
      showShellNotice(`Removed ${label} from this workspace.`);
    },
    [
      workspaceId,
      shareMounts,
      onExplorerPathsChanged,
      refreshFiles,
      reportShellError,
      showShellNotice,
      reloadShareMounts,
    ],
  );

  // Reveal-then-create: the inline editbox lives in the explorer view, so
  // make that view visible first (never setView — re-selecting the active
  // view TOGGLES the panel).
  const requestExplorerCreate = useCallback(
    (kind: "file" | "folder") => {
      mutateWb((state) => ({ ...state, activeView: "explorer", sidebarVisible: true }));
      setCreateRequest((current) => ({ kind, id: (current?.id ?? 0) + 1 }));
    },
    [mutateWb],
  );

  const setExplorerFolderExpanded = useCallback(
    (path: string, expanded: boolean) =>
      mutateWb((state) => setFolderExpanded(state, path, expanded)),
    [mutateWb],
  );
  const toggleExplorerFolder = useCallback(
    (path: string) => mutateWb((state) => toggleFolderExpanded(state, path)),
    [mutateWb],
  );
  const toggleExplorerPin = useCallback(
    (path: string) => mutateWb((state) => togglePinned(state, path)),
    [mutateWb],
  );
  const collapseExplorerFolders = useCallback(() => {
    mutateWb((state) =>
      state.expandedFolders.length === 0
        ? state
        : { ...state, expandedFolders: [] },
    );
  }, [mutateWb]);
  const createUntitledTextFile = useCallback(async () => {
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId,
        relativePath: uniqueUntitledPath(files, folders, "txt"),
        initialText: "",
      });
      await refreshFiles();
      openFile(result.path);
    } catch (error) {
      reportShellError("Could not create an untitled text file.", error);
    }
  }, [files, folders, openFile, refreshFiles, reportShellError, workspaceId]);
  const createUntitledDrawing = useCallback(async () => {
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId,
        relativePath: uniqueUntitledPath(files, folders, "excalidraw"),
        // The engine's absent-head contract admits a new path only while its
        // artifact is empty. The scene session initializes its own Y.Doc;
        // DrawingView supplies portable JSON when the engine is unavailable.
        initialText: "",
      });
      await refreshFiles();
      openFile(result.path);
    } catch (error) {
      reportShellError("Could not create a drawing.", error);
    }
  }, [files, folders, openFile, refreshFiles, reportShellError, workspaceId]);
  const openHistoryView = useCallback(() => {
    mutateWb((state) => ({
      ...setView(state, "history"),
      sidebarVisible: true,
    }));
  }, [mutateWb]);
  const checkForDesktopUpdates = useCallback(async () => {
    try {
      const result = await bridge().checkForUpdates();
      if (!result.checked) {
        reportShellError("No update check was started.", new Error(result.state.message));
      }
    } catch (error) {
      reportShellError("Could not check for updates.", error);
    }
  }, [reportShellError]);
  const installDesktopUpdate = useCallback(async () => {
    try {
      // Through the guard (#579 review, r8 + r10): with set-aside drafts
      // present the recovery dialog opens INSTEAD of the one-shot install.
      const result = await requestGuardedUpdateInstall();
      if (result === null) return;
      if (!result.accepted) {
        reportShellError(
          "Could not install the update.",
          new Error(
            result.state.status === "error"
              ? result.state.message
              : "The restart request was not accepted.",
          ),
        );
      }
    } catch (error) {
      reportShellError("Could not install the update.", error);
    }
  }, [reportShellError]);

  const moveTabIntoNewGroup = useCallback(
    (groupId: string = wbRef.current.activeEditorGroup, path?: string) => {
      const current = wbRef.current;
      const group = current.editorGroups.find((candidate) => candidate.id === groupId);
      const tabPath = path ?? group?.activeTab;
      if (!group || !tabPath) return;
      const tab = group.tabs.find((candidate) => candidate.path === tabPath);
      if (!tab) return;
      const focus = editorFocus(current);
      const requestSequencesAtIssue = new Map(
        fileOpenRequests.current.sequenceByGroup,
      );
      // Mint outside mutateWb: that seam probes the updater before React calls
      // it, so generating inside would produce two IDs for one command.
      const newGroupId = crypto.randomUUID();
      const commitMove = () => {
        const current = wbRef.current;
        const live = current.editorGroups
          .find((candidate) => candidate.id === groupId)
          ?.tabs.find((candidate) => candidate.path === tabPath);
        if (live !== tab) return;
        const moveState = (state: WorkbenchState) =>
          moveTabToNewGroup(
            state,
            groupId,
            tabPath,
            newGroupId,
            hasEditorFocus(state, focus) ? "target" : "preserve",
          );
        const next = moveState(current);
        if (next === current) return;
        invalidateDeferredFileOpensForTabTransition(
          current,
          next,
          requestSequencesAtIssue,
        );
        for (const mountingGroupId of groupsMountingNewDocument(current, next)) {
          const nextActiveTab = next.editorGroups.find(
            (candidate) => candidate.id === mountingGroupId,
          )?.activeTab;
          if (nextActiveTab === undefined || nextActiveTab === null) continue;
          const viewKind = classifyForView(nextActiveTab);
          if (viewKind === "markdown" || viewKind === "database") {
            rendererMarks.mark(fileOpenStartMark(mountingGroupId));
          }
        }
        mutateWb(moveState);
      };
      commitAfterTabFlush(
        groupId,
        tab,
        "Could not save the draft, so the tab stays in this group.",
        commitMove,
      );
    },
    [
      commitAfterTabFlush,
      invalidateDeferredFileOpensForTabTransition,
      mutateWb,
    ],
  );

  const openEditorGroupRight = useCallback(
    (groupId: string = wbRef.current.activeEditorGroup) => {
      const group = wbRef.current.editorGroups.find(
        (candidate) => candidate.id === groupId,
      );
      const tab = group?.tabs.find(
        (candidate) => candidate.path === group.activeTab,
      );
      if (!group || !tab) return;
      if (isSingletonEditorTabPath(tab.path)) {
        showSingletonTabSplitError();
        return;
      }
      const focus = editorFocus(wbRef.current);
      const newGroupId = crypto.randomUUID();
      const requestSequencesAtIssue = new Map(
        fileOpenRequests.current.sequenceByGroup,
      );
      const commitSplit = () => {
        const current = wbRef.current;
        const liveGroup = current.editorGroups.find(
          (candidate) => candidate.id === groupId,
        );
        const liveTab = liveGroup?.tabs.find(
          (candidate) => candidate.path === liveGroup.activeTab,
        );
        if (liveTab !== tab) return;
        const splitState = (state: WorkbenchState) =>
          createEditorGroupRight(
            state,
            groupId,
            newGroupId,
            hasEditorFocus(state, focus) ? "target" : "preserve",
          );
        const next = splitState(current);
        if (next === current) {
          const openTabCount = allTabs(current).length;
          if (openTabCount >= MAX_OPEN_TABS) {
            showTabLimitError(openTabCount, "create an editor group");
          }
          return;
        }
        invalidateDeferredFileOpensForTabTransition(
          current,
          next,
          requestSequencesAtIssue,
        );
        const viewKind = classifyForView(tab.path);
        if (viewKind === "markdown" || viewKind === "database") {
          rendererMarks.mark(fileOpenStartMark(newGroupId));
        }
        clearEditorGroupRefusalError();
        mutateWb(splitState);
      };
      commitAfterTabFlush(
        groupId,
        tab,
        "dohc could not save this file. The editor group was not created.",
        commitSplit,
      );
    },
    [
      clearEditorGroupRefusalError,
      commitAfterTabFlush,
      invalidateDeferredFileOpensForTabTransition,
      mutateWb,
      showSingletonTabSplitError,
      showTabLimitError,
    ],
  );

  const closeGroupAfterFlush = useCallback(
    (groupId: string) => {
      if (wbRef.current.editorGroups.length === 1) return;
      const group = wbRef.current.editorGroups.find(
        (candidate) => candidate.id === groupId,
      );
      if (!group) return;
      if (group.tabs.length === 0) {
        mutateWb((state) => closeEditorGroup(state, groupId));
        return;
      }
      void closeTabsAfterFlush(group.tabs.map((tab) => ({ groupId, tab })));
    },
    [closeTabsAfterFlush, mutateWb],
  );

  const runWorkbenchMenuCommand = useCallback(
    (command: WorkbenchMenuCommand, path?: string, groupId?: string) => {
      const targetGroupId = groupId ?? wbRef.current.activeEditorGroup;
      if (command === "close-tab" && path) {
        closeFileTab(targetGroupId, path);
      } else if (command === "close-other-tabs" && path) {
        closeOtherTabs(targetGroupId, path);
      } else if (command === "move-tab-to-new-group") {
        moveTabIntoNewGroup(targetGroupId, path);
      } else if (command === "close-editor-group") {
        closeGroupAfterFlush(targetGroupId);
      } else if (command === "copy-path" && path && !isVirtualTabPath(path)) {
        void navigator.clipboard?.writeText(path);
      } else if (command === "show-in-explorer" && path && !isVirtualTabPath(path)) {
        showPathInExplorer(path);
      } else if (command === "open-history") {
        openHistoryView();
      } else if (command === "connect-cloud") {
        setCloudOpen(true);
      } else if (command === "settings") {
        openSettings();
      } else if (command === "check-updates") {
        void checkForDesktopUpdates();
      } else if (command === "install-update") {
        void installDesktopUpdate();
      } else if (command === "toggle-theme") {
        toggleTheme();
      }
    },
    [
      activeDocumentPath,
      closeGroupAfterFlush,
      closeFileTab,
      closeOtherTabs,
      checkForDesktopUpdates,
      installDesktopUpdate,
      openHistoryView,
      openSettings,
      moveTabIntoNewGroup,
      showPathInExplorer,
    ],
  );

  const showWorkbenchMenu = useCallback(
    async (
      context: "tab" | "editor" | "status",
      path?: string,
      groupId?: string,
    ) => {
      try {
        const command = await bridge().showWorkbenchMenu({
          workspaceId,
          context,
          ...(path ? { path } : {}),
          ...(groupId ? { groupId } : {}),
          ...(context === "tab"
            ? { canCloseEditorGroup: wbRef.current.editorGroups.length > 1 }
            : {}),
        });
        if (command) runWorkbenchMenuCommand(command, path, groupId);
      } catch (error) {
        reportShellError("Could not open the workbench menu.", error);
      }
    },
    [reportShellError, runWorkbenchMenuCommand, workspaceId],
  );

  // Performance marks (post-commit, so the rendered surface is included):
  // file tree populated, and shell interactive once status/history landed.
  // These live in the workbench ROOT — a view may unmount, this must not.
  useEffect(() => {
    if (files.length > 0) rendererMarks.markOnce("file-tree-loaded");
  }, [files]);
  useEffect(() => {
    if (!files.some((file) => /\.(md|markdown)$/i.test(file.path))) return;
    return scheduleMarkdownEditorPreload();
  }, [files]);
  useEffect(() => {
    if (syncStatus) rendererMarks.markOnce("workspace-shell-interactive");
  }, [syncStatus]);

  // Open the workspace (starts the file watcher in main), load the initial
  // file tree + history, and refresh everything whenever a settled batch is
  // recorded — the timeline and status stay live without polling.
  useEffect(() => {
    let cancelled = false;
    // The open carries a status, so it takes its place in the same issue order
    // as every other read of that lane. This effect re-runs when
    // refreshHistory's identity changes, and the second open used to write its
    // status untimed — leaving the lane's watermark where it was, so the first
    // run's refresh could still land its older status on top (#636).
    const token = ++engineHistoryToken.current;
    void (async () => {
      try {
        const status = await bridge().openWorkspace({ workspaceId });
        // Main awaits the capture build before it answers, so this is the
        // moment the decision exists — and the status committed beside it is
        // the first one that describes a decided workspace (#626). The two
        // commit together, so "decided" never runs ahead of what it decided.
        // Recorded per workspace, so a switch cannot inherit it, and never
        // retracted: this effect re-runs whenever refreshHistory's identity
        // changes, and retracting here would blink every version surface off
        // and on when the settings read lands.
        //
        // The lane may refuse this status, and the decision still stands: what
        // outranks it is a NEWER status, which describes a workspace at least
        // as decided as this one.
        if (!cancelled) {
          syncStatusLane.commit(token, status);
          setCaptureDecidedFor(workspaceId);
        }
        await refreshFiles();
        await refreshHistory();
      } catch (error) {
        if (!cancelled) reportShellError("Could not open this workspace.", error);
      }
    })();
    const unsubscribe = bridge().onWorkspaceActivity(() => {
      void refreshFiles().catch((error) =>
        reportShellError("Could not refresh workspace files.", error),
      );
      void refreshHistory().catch((error) =>
        reportShellError("Could not refresh history.", error),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId, refreshFiles, refreshHistory, reportShellError, syncStatusLane]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.metaKey && event.ctrlKey) return;
      if (event.defaultPrevented) return;
      if (event.repeat || event.isComposing) return;
      const key = event.key.toLowerCase();
      const secondarySidebarKey =
        event.altKey &&
        (key === "b" || (event.metaKey && event.code === "KeyB"));
      if (event.key === "," && !event.shiftKey && !event.altKey) {
        if (!hasBlockingModal()) {
          event.preventDefault();
          openSettings();
        }
        return;
      }
      if (
        key === "z" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const activeUndo = mountedEditorsRef.current.get(
          wbRef.current.activeEditorGroup,
        )?.undo;
        if (activeUndo?.acceptsEvent(event)) {
          event.preventDefault();
          void activeUndo.run().catch((error) =>
            reportShellError("Could not undo the last history restore.", error),
          );
        }
        return;
      }
      // This handler owns main-frame shortcuts. On Windows/Linux the menu only
      // displays them. On macOS it is the unhandled fallback, so preventing a
      // claimed keydown also prevents a duplicate menu command. Shift and Caps
      // Lock affect key casing, so routing uses modifiers and a normalized key.
      if (event.shiftKey && key !== "p") return;
      if (event.altKey && !secondarySidebarKey) return;
      if (key === "n") {
        event.preventDefault();
        setNewFileOpen(true);
      } else if (key === "k" || (key === "p" && event.shiftKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "p") {
        event.preventDefault();
        setQuickOpenOpen((open) => !open);
      } else if (secondarySidebarKey) {
        // CommandOrControl+Alt+B mirrors VS Code's secondary-sidebar toggle.
        // It is a no-op when the workspace has no Chats panel.
        if (engineSurfacesExist) {
          event.preventDefault();
          mutateWb(toggleChats);
        }
      } else if (key === "b") {
        event.preventDefault();
        mutateWb(toggleSidebar);
      } else if (key === "w") {
        // CommandOrControl+W closes the tab. Close Window keeps the separate
        // CommandOrControl+Shift+W native accelerator.
        event.preventDefault();
        closeActiveTab();
      } else if (key === "\\") {
        event.preventDefault();
        openEditorGroupRight();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeActiveTab,
    engineSurfacesExist,
    openEditorGroupRight,
    mutateWb,
    openSettings,
    reportShellError,
  ]);

  const openWorkspaceFolder = useCallback(async () => {
    try {
      const picked = await bridge().pickWorkspaceRoot();
      if (!picked) return;
      const attached = await bridge().attachWorkspaceFolder({ rootPath: picked });
      props.onSwitchWorkspace(attached);
    } catch (error) {
      reportShellError("Could not open that workspace folder.", error);
    }
  }, [props.onSwitchWorkspace, reportShellError]);

  // THE command registry: the palette renders it and the application menu
  // routes through it (onMenuCommand below) — one definition per action.
  const commands = useMemo<Command[]>(
    () => [
      {
        id: "new-file",
        label: "New file",
        run: () => setNewFileOpen(true),
      },
      {
        id: "new-drawing",
        label: "New drawing",
        run: () => void createUntitledDrawing(),
      },
      {
        id: "new-folder",
        label: "New folder",
        run: () => requestExplorerCreate("folder"),
      },
      {
        id: "quick-open",
        label: "Go to file",
        run: () => setQuickOpenOpen(true),
      },
      {
        id: "open-workspace",
        label: "Open workspace folder…",
        run: () => void openWorkspaceFolder(),
      },
      {
        id: "import-files",
        label: "Import files",
        run: () => void importFiles(),
      },
      {
        id: "export-workspace",
        label: "Export workspace as zip",
        run: () =>
          void bridge().exportWorkspaceZip({ workspaceId }).catch((error) =>
            reportShellError("Could not export this workspace.", error),
          ),
      },
      {
        id: "toggle-sidebar",
        label: "Toggle sidebar",
        run: () => mutateWb(toggleSidebar),
      },
      {
        id: "close-tab",
        label: "Close tab",
        run: closeActiveTab,
      },
      {
        id: "new-editor-group-right",
        label: "New editor group right",
        run: () => openEditorGroupRight(),
      },
      // Only offered while a markdown document is the active tab — on every
      // other tab the toggle has nothing to act on, so the palette hides it.
      ...(activeDocumentPath && classifyForView(activeDocumentPath) === "markdown"
        ? [
            {
              id: "toggle-markdown-source",
              label: "Toggle markdown source view",
              run: () =>
                mountedEditorsRef.current.get(wbRef.current.activeEditorGroup)
                  ?.sourceToggle?.(),
            },
          ]
        : []),
      // The Chats panel exists only for workspace-engine-flagged workspaces
      // that are not shared views — no surface, no command. A workspace whose
      // capture cannot serve chats keeps the command: the panel is still
      // there, stating what dohc cannot do (#628).
      ...(engineSurfacesExist
        ? [
            {
              id: "toggle-chats",
              label: "Toggle chats panel",
              run: () => mutateWb(toggleChats),
            },
          ]
        : []),
      ...VIEW_IDS.map((view) => ({
        id: `show-${view}`,
        label: `View: ${activityViewLabel(view)}`,
        run: () => mutateWb((state) => setView(state, view)),
      })),
      {
        id: "connect-cloud",
        label: "Connect dohc Cloud",
        run: () => setCloudOpen(true),
      },
      {
        id: "settings",
        label: "Settings",
        run: () => openSettings(),
      },
      {
        id: "settings-appearance",
        label: "Settings: Open Appearance",
        run: () => openSettings("appearance"),
      },
      {
        id: "settings-agents",
        label: "Settings: Open Agents & MCP",
        run: () => openSettings("agents"),
      },
      {
        id: "check-updates",
        label: "Check for updates",
        run: () => void checkForDesktopUpdates(),
      },
      {
        id: "install-update",
        label: "Update and restart",
        run: () => void installDesktopUpdate(),
      },
      {
        id: "toggle-theme",
        label: "Toggle light/dark theme",
        run: toggleTheme,
      },
    ],
    [
      activeDocumentPath,
      createUntitledDrawing,
      openWorkspaceFolder,
      closeActiveTab,
      importFiles,
      mutateWb,
      requestExplorerCreate,
      checkForDesktopUpdates,
      installDesktopUpdate,
      engineSurfacesExist,
      openEditorGroupRight,
      openSettings,
      reportShellError,
      workspaceId,
    ],
  );

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      if (command === "command-palette") setPaletteOpen(true);
      else commands.find((entry) => entry.id === command)?.run();
    });
  }, [commands]);

  // Read-only shared view (PR 18): the workspace was received through a
  // share grant. It refreshes on open and on demand, and every edit surface
  // is disabled with honest copy. Declared before the history timeline: the
  // shared-view placeholder's next step depends on whether the share is
  // still live (#540 — Refresh exists only while it is).
  const shareView = props.workspace.shareView ?? null;
  const [shareViewEnded, setShareViewEnded] = useState(!!shareView?.ended);
  const [shareRefreshing, setShareRefreshing] = useState(false);
  // Ops this share's pulls skipped, read from the RECORD, not from the last
  // refresh. The skip is durable — the cursor committed past those ops — so a
  // later quiet refresh must not clear the warning while the content is still
  // missing, and a restart must not either.
  //
  // The record is re-read after every refresh rather than taken from the boot
  // snapshot in props: the recorder writes DURING the pull, so a refusal that
  // happens while this shell is mounted would otherwise wait for a remount.
  // Latest-wins token, the same guard reloadShareMounts uses.
  const bootSkipped = props.workspace.shareView?.skippedOps ?? null;
  const [shareSkipped, setShareSkipped] = useState(
    hasUnacknowledgedShareSkips(bootSkipped) ? bootSkipped : null,
  );
  const shareSkippedToken = useRef(0);
  const reloadShareSkipped = useCallback(async () => {
    const token = ++shareSkippedToken.current;
    const registry = await bridge().getWorkspaceRegistry();
    if (token !== shareSkippedToken.current) return;
    const entry = registry.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    const skipped = entry?.shareView?.skippedOps ?? null;
    // Only what the user has not seen. Acknowledging hides the warning
    // without deleting the record, so this reads the marker rather than the
    // record's presence.
    setShareSkipped(hasUnacknowledgedShareSkips(skipped) ? skipped : null);
  }, [workspaceId]);
  const refreshShareView = useCallback(async () => {
    if (!shareView || shareViewEnded) return;
    setShareRefreshing(true);
    try {
      const outcome = await bridge().refreshSharedView({ workspaceId });
      if (outcome.status === "ended") {
        setShareViewEnded(true);
        return;
      }
      if (outcome.changedPaths > 0) {
        await refreshFiles();
        // Re-read open editors: the shared view's files changed on disk.
        setVersionEpoch((epoch) => epoch + 1);
      }
    } catch (error) {
      reportShellError("Couldn't refresh the shared view.", error);
    } finally {
      // AFTER the listing and after a FAILURE, deliberately. Refusals are
      // recorded page by page before each cursor commit, so a refresh that
      // died on a later page still left durable evidence behind — reading it
      // only on the success path would keep that invisible until a lucky
      // refresh or a remount. It runs after the listing because a stale file
      // list is what the user is looking at, and this read must not delay it.
      await reloadShareSkipped().catch(() => undefined);
      setShareRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareView?.shareId, shareViewEnded, workspaceId, reloadShareSkipped]);
  useEffect(() => {
    // One automatic refresh when a shared view opens; afterwards on demand.
    if (shareView && !shareViewEnded) void refreshShareView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // ONE history timeline element, rendered by the side panel's History view
  // and the history tab — the engine page state is root-owned (never a
  // second subscription). A workspace with no history source (retirement
  // Phase C removed the legacy recorder) gets a placeholder instead of an
  // empty list, and what that placeholder CLAIMS comes from main's status —
  // or, for a shared view, the registry capability and the share's live
  // state — never from the renderer's own capability read (#542).
  const historyOffCopy = historyOffPlaceholderCopy(
    syncStatus,
    shareView
      ? { ended: shareViewEnded, granterEmail: shareView.granterEmail }
      : null,
  );
  // The rail needs no capture-decision clause of its own, unlike the surfaces
  // that call on mount (#637). Only `refreshHistory` and the open effect
  // commit a status, and both now answer after the decision, so a null status
  // is exactly the undecided window — and it lands in the branch below with
  // no page to show, which is already a load state. Adding the clause here
  // would render the same thing from a second place.
  const historyTimeline =
    engineSurfacesExist && !statusSaysNoRecorder(syncStatus) ? (
    // The timeline renders only when a read ANSWERED (#593). Flattening a
    // null page into an empty list told the user a workspace with real
    // history had no changes, whenever a read was in flight or had failed.
    engineHistory ? (
      <EngineHistoryView
        moments={engineHistory.moments}
        hasMore={engineHistory.nextBeforeMomentOrder != null}
        loadingMore={engineHistoryLoadingMore}
        onLoadMore={() => void loadMoreEngineHistory()}
        onOpenMoment={openMomentDiffTab}
      />
    ) : engineHistoryReadFailed ? (
      // The same state its two siblings render — ChatsView and LinkedChats
      // both say a panel could not load beside a Try again — so it takes
      // their look, not the empty-state recipe next door. One line, and a
      // Next that works on this surface: the read this panel runs itself.
      <div
        data-testid="history-load-failed"
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <span className="text-xs text-danger">
          dohc could not load this workspace&apos;s history.
        </span>
        <button
          type="button"
          onClick={() =>
            void refreshHistory().catch((error) =>
              reportShellError("Could not refresh history.", error),
            )
          }
          className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      </div>
    ) : (
      <PanelLoading label="history" />
    )
  ) : (
    // One line, per the empty-state recipe (copy.md): what is missing plus
    // the next step this surface really has, chosen by the established cause.
    <div
      data-testid="history-off-placeholder"
      className="flex flex-1 items-center justify-center px-4 text-center"
    >
      <span className="text-sm text-muted">{historyOffCopy}</span>
    </div>
  );
  // Open-file refresh: history growth re-reads the active file. The floor
  // keeps the counter monotonic within the session even when the timeline is
  // dropped and re-fetched (#555) — a cache-buster that revisits a value can
  // suppress a needed re-read. Opted-out workspaces have no history growth
  // to react to. (Max-tracking a ref during render is idempotent, so a
  // repeated render commits the same value.)
  const historyRefreshFloor = useRef(0);
  historyRefreshFloor.current = Math.max(
    historyRefreshFloor.current,
    engineHistory ? engineHistory.latestMomentOrder + 1 : 0,
  );
  const historyRefreshCounter = engineEnabled ? historyRefreshFloor.current : 0;
  const graphKey = engineEnabled
    ? `${graphRefreshKey}\0${engineHistory?.latestMomentOrder ?? -1}`
    : graphRefreshKey;

  const explorerView = (
    <>
      <Explorer
        workspaceId={workspaceId}
        files={files}
        folders={folders}
        editorGroups={wb.editorGroups}
        activeEditorGroup={wb.activeEditorGroup}
        dirtyPaths={dirtyPaths}
        recoveryPaths={recoveryPaths}
        expandedFolders={wb.expandedFolders}
        pinned={wb.pinned}
        openEditorsHeight={wb.openEditorsHeight}
        onOpenEditorsHeightChange={(height) =>
          mutateWb((state) => setOpenEditorsHeight(state, height))
        }
        createRequest={createRequest}
        onOpenFile={openFile}
        onActivateTab={activateEditorTab}
        onCloseTab={closeFileTab}
        onCloseAllTabs={closeAllTabs}
        onNewUntitledTextFile={() => void createUntitledTextFile()}
        onCollapseFolders={collapseExplorerFolders}
        onSetFolderExpanded={setExplorerFolderExpanded}
        onToggleFolder={toggleExplorerFolder}
        onTogglePin={toggleExplorerPin}
        onBeginChanges={beginDraftOperation}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={(droppedPaths, targetDir) =>
          void importFiles(droppedPaths, targetDir)
        }
        onRefreshShareMounts={() => void refreshShareMounts(true)}
        onUnmountShare={(path) => void unmountShare(path)}
        onShare={(path) => setShareTarget({ path })}
        onRefresh={() =>
          void refreshFiles().catch((error) =>
            reportShellError("Could not refresh workspace files.", error),
          )
        }
        onNewFileDialog={() => setNewFileOpen(true)}
      />
    </>
  );

  // The editor is the one live conversation surface. It owns presence,
  // drafts, and navigation state.
  const dmWorkspaceOptions = props.workspaces
    .filter((workspace) => !workspace.shareView)
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      label: workspaceName(workspace),
    }));
  const chatsViewProps = {
    workspaceId,
    workspaces: dmWorkspaceOptions,
    initialNav: chatsNav.current ?? undefined,
    initialDrafts: chatsDrafts.current ?? undefined,
    onNavChange: onChatsNav,
    onNavCommand: onChatsNavCommand,
    onDraftsChange: onChatsDrafts,
    onThreadRead: onChatsThreadRead,
    onOpenFileChat: openFileChatInPanel,
    onOpenPath: openPathWithHeading,
    onError: (message: string) => setShellError({ message, retry: null }),
    mentionCandidates,
    workspaceFiles: files,
    addressedToMe,
    collaboration: chatCollaboration,
    agentSetup,
    onSetupAgent: () => openSettings("agents"),
  } as const;
  // The panel intentionally stays on the overview and only selects editor
  // destinations. While the Chats editor is active, disable its collaboration
  // transport so the navigator cannot create a duplicate presence lease.
  const chatsNavigatorProps = {
    workspaceId,
    workspaces: dmWorkspaceOptions,
    selectedNav: selectedChatsNav ?? undefined,
    readRevision: chatsReadRevision,
    onOpenInTab: openChatsNavInTab,
    onOpenFileChat: openFileChatInPanel,
    onOpenPath: openPathWithHeading,
    onError: (message: string) => setShellError({ message, retry: null }),
    mentionCandidates,
    workspaceFiles: files,
    addressedToMe,
    collaboration: wb.editorGroups.some((group) => isChatsTabPath(group.activeTab))
      ? null
      : chatCollaboration,
    agentSetup,
    onSetupAgent: () => openSettings("agents"),
  } as const;

  return (
    <div
      data-testid="workspace-shell"
      // Flips to "true" only once openWorkspace has resolved — which in main
      // awaits the file watcher's initial scan (workspaceActivity.open races
      // handle.ready). The shell element itself mounts immediately, so a test
      // that writes a file right after the shell appears would otherwise race
      // chokidar's ignoreInitial scan and have the write silently swallowed.
      // Waiting on this attribute is the deterministic "watcher is live" gate.
      data-ready={syncStatus ? "true" : "false"}
      className="app-chrome flex h-screen flex-col bg-bg text-ink"
    >
      <Titlebar
        workspace={props.workspace}
        workspaces={props.workspaces}
        onSwitchWorkspace={props.onSwitchWorkspace}
        onOpenShare={() => setOpenShareOpen(true)}
        onQuickOpen={() => setQuickOpenOpen(true)}
        primarySidebar={{
          visible: wb.sidebarVisible,
          onToggle: () => mutateWb(toggleSidebar),
        }}
        {...(engineSurfacesExist
          ? {
              chatsSidebar: {
                visible: wb.chatsVisible,
                onToggle: () => mutateWb(toggleChats),
              },
            }
          : {})}
      />
      {shellError ? (
        <div
          data-testid="workspace-shell-error"
          className="flex min-h-8 items-center gap-2 border-b border-line bg-danger/10 px-3 text-[12px] text-danger"
        >
          <span className="min-w-0 flex-1 truncate">{shellError.message}</span>
          {shellError.retry ? (
            <button
              type="button"
              data-testid="workspace-shell-error-retry"
              onClick={() => {
                const retry = shellError.retry;
                // Clearing first is what shows the control took: the read is
                // on its way, and a failure that is being retried is no longer
                // the newest thing this surface knows.
                setShellError(null);
                retry?.();
              }}
              className="h-6 shrink-0 cursor-pointer rounded border border-danger/40 px-2 text-[11px] hover:bg-danger/10"
            >
              Try again
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss workspace error"
            onClick={() => setShellError(null)}
            className="grid size-6 shrink-0 place-items-center rounded hover:bg-line/50"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}
      {shellNotice ? (
        <div
          data-testid="shell-notice"
          className="flex min-h-8 items-center gap-2 border-b border-line bg-panel-2 px-3 text-[12px] text-muted"
        >
          <span className="min-w-0 flex-1 truncate">{shellNotice}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setShellNotice(null)}
            className="grid size-6 shrink-0 place-items-center rounded hover:bg-line/50"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}
      {shareView ? (
        <div
          data-testid="shared-view-banner"
          data-ended={shareViewEnded || undefined}
          className={`flex min-h-8 items-center gap-2 border-b border-line px-3 text-[12px] ${
            shareViewEnded ? "bg-warning/10 text-warning" : "bg-panel-2 text-muted"
          }`}
        >
          <Eye size={12} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {shareViewEnded
              ? `This share was ended${shareView.granterEmail ? ` by ${shareView.granterEmail}` : ""}. Your copy stays readable but won't update anymore.`
              : `Shared view from ${shareView.granterEmail ?? "another dohc user"} — read-only. Ask ${shareView.granterEmail ?? "them"} for changes.`}
          </span>
          {shareSkipped
            ? shareSkipNoticeLines(shareSkipped, shareView.granterEmail).map(
                (line) => (
                  <span
                    key={line.kind}
                    data-testid="shared-view-refused"
                    data-kind={line.kind}
                    title={line.detail}
                    className="flex shrink-0 items-center gap-1.5 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
                  >
                    {line.text}
                    <button
                      type="button"
                      data-testid="shared-view-refused-dismiss"
                      onClick={() => {
                        const shown = shareSkipped;
                        setShareSkipped(null);
                        void bridge()
                          .dismissShareSkips({
                            workspaceId,
                            // The generation on screen. A refusal recorded
                            // since this render is NOT acknowledged by this
                            // click.
                            generation: shown.generation,
                          })
                          // Re-read either way: a stale acknowledgement
                          // clears nothing, and the newer warning must come
                          // back.
                          .then(async () => await reloadShareSkipped())
                          .catch((error: unknown) => {
                            setShareSkipped(shown);
                            reportShellError("Couldn't dismiss that notice.", error);
                          });
                      }}
                      className="shrink-0 rounded border border-warning/40 px-1 text-[10px] text-warning hover:bg-warning/20"
                    >
                      Dismiss
                    </button>
                  </span>
                ),
              )
            : null}
          {!shareViewEnded ? (
            <button
              type="button"
              data-testid="shared-view-refresh"
              disabled={shareRefreshing}
              onClick={() => void refreshShareView()}
              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-muted hover:text-ink disabled:opacity-50"
            >
              <RefreshCw
                size={11}
                aria-hidden
                className={shareRefreshing ? "animate-spin" : undefined}
              />
              {shareRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          activeView={wb.activeView}
          sidebarVisible={wb.sidebarVisible}
          hasConflict={syncStatus?.state === "conflict"}
          searchResultCount={
            search.model.totalMatches > 0 ? search.model.totalMatches : undefined
          }
          onSelectView={(view) => mutateWb((state) => setView(state, view))}
          onOpenCloud={() => setCloudOpen(true)}
          onOpenSettings={() => openSettings()}
        />

        {/* Side panel (Ctrl+B / activity bar toggle; hidden ⇒ unmounted) */}
        {wb.sidebarVisible ? (
          <SidePanel
            title={activityViewLabel(wb.activeView)}
            width={wb.sidebarWidth}
            onWidthChange={(width) => mutateWb((state) => setSidebarWidth(state, width))}
            actions={
              wb.activeView === "history" ? (
                <button
                  type="button"
                  data-testid="history-open-tab"
                  aria-label="Open history in tab"
                  title="Open history in tab"
                  onClick={openHistoryTab}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <Maximize2 size={13} aria-hidden />
                </button>
              ) : wb.activeView === "graph" ? (
                <button
                  type="button"
                  data-testid="graph-open-tab"
                  aria-label="Open graph in tab"
                  title="Open graph in tab"
                  onClick={openGraphTab}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <Maximize2 size={13} aria-hidden />
                </button>
              ) : wb.activeView === "sites" ? (
                <button
                  type="button"
                  data-testid="sites-refresh"
                  aria-label="Refresh sites"
                  title="Refresh sites"
                  onClick={refreshSites}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <RefreshCw size={13} aria-hidden />
                </button>
              ) : undefined
            }
          >
            {/* One island: a crash inside any panel view (or a failed lazy
                chunk under its Suspense) shows an inline error card here —
                the editor, tabs, and rail keep working. Switching views
                clears it. */}
            <ErrorBoundary scope="side-panel" resetKeys={[wb.activeView]}>
            {wb.activeView === "explorer" ? (
              explorerView
            ) : wb.activeView === "search" ? (
              <SearchView search={search} onOpenResult={openSearchResult} />
            ) : wb.activeView === "graph" ? (
              <Suspense fallback={<PanelLoading label="graph" />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={activeDocumentPath}
                  refreshKey={graphKey}
                  onOpenPath={openPathWithHeading}
                  onOpenChatThread={openGraphChatThread}
                  chatMentionsAvailable={captureAvailable}
                  variant="panel"
                />
              </Suspense>
            ) : wb.activeView === "sites" ? (
              <Suspense fallback={<PanelLoading label="sites" />}>
                <LazySitesView
                  workspaceId={workspaceId}
                  files={files}
                  refreshKey={sitesRefreshKey}
                  onOpenPath={openPathWithHeading}
                />
              </Suspense>
            ) : wb.activeView === "history" ? (
              historyTimeline
            ) : null}
            </ErrorBoundary>
          </SidePanel>
        ) : null}

        {/* Editor area: workspace-wide version controls above independently
            active editor groups. Each group can host any tab surface. */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {captureAvailable ? (
            <div className="flex h-9 shrink-0 items-center justify-end border-b border-line bg-panel-2 px-1.5">
                <VersionMenu
                  workspaceId={workspaceId}
                  activeTabDirty={anyTabDirty}
                  flushActiveDraft={flushActiveDraft}
                  onOpenCompare={openVersionCompareTab}
                  onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
                  onError={(message) => setShellError({ message, retry: null })}
                  {...(shareView
                    ? {}
                    : {
                        onShareVersion: (version: { id: string; name: string }) =>
                          setShareTarget({
                            versionId: version.id,
                            versionName: version.name,
                          }),
                      })}
                  // versionEpoch bumps whenever ANY surface changed version
                  // state (the 0N-2 review card switches back to Main outside
                  // this menu) — the selector re-reads instead of going stale.
                  refreshKey={versionEpoch}
                />
            </div>
          ) : null}
          {/* "Try it in a version" (PR 0N-2): honest run status while the
              agent works, then the review card when the run ends. Flagged
              workspaces only (tryState never exists otherwise). */}
          {captureAvailable && tryState?.status === "running" ? (
            <TryInVersionBanner task={tryState.task} versionName={tryState.versionName} />
          ) : null}
          {captureAvailable && tryState?.status === "review" ? (
            <TryInVersionReviewCard
              workspaceId={workspaceId}
              state={tryState}
              activeTabDirty={anyTabDirty}
              flushActiveDraft={flushActiveDraft}
              onOpenCompare={openVersionCompareTab}
              onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
              onDismissed={onTryReviewDismissed}
            />
          ) : null}
          <EditorGroupLayout
            groups={wb.editorGroups.map((editorGroup, groupIndex) => {
              const tabPath = editorGroup.activeTab;
              const tab = editorGroup.tabs.find(
                (candidate) => candidate.path === tabPath,
              );
              const editorCallbacks = tab
                ? callbacksForEditor(editorGroup.id, tab)
                : null;
              const groupDocumentPath = isVirtualTabPath(tabPath) ? null : tabPath;
              const groupSiteRoot = parseSiteTabPath(tabPath);
              const groupPluginPanel = parsePluginPanelTabPath(tabPath);
              const groupScrollTarget =
                searchScrollTarget?.groupId === editorGroup.id &&
                searchScrollTarget.path === tabPath
                  ? searchScrollTarget
                  : undefined;
              return {
                id: editorGroup.id,
                size: editorGroup.size,
                content: (
                  <>
                    <EditorTabs
                      groupId={editorGroup.id}
                      tabs={editorGroup.tabs}
                      activeTab={tabPath}
                      activeTabDirty={!!tabPath && dirtyPaths.has(tabPath)}
                      recoveryPaths={recoveryPaths}
                      groupNumber={groupIndex + 1}
                      onActivate={(path) => activateEditorTab(editorGroup.id, path)}
                      onClose={(path) => closeFileTab(editorGroup.id, path)}
                      onContextMenu={(path) =>
                        void showWorkbenchMenu("tab", path, editorGroup.id)
                      }
                      onMove={(path, toIndex) =>
                        moveFileTab(editorGroup.id, path, toIndex)
                      }
                      onMoveToGroup={(path, targetGroupId, toIndex) =>
                        moveFileTabToGroup(
                          editorGroup.id,
                          targetGroupId,
                          path,
                          toIndex,
                        )
                      }
                      onCreateGroupRight={() => openEditorGroupRight(editorGroup.id)}
                      {...(wb.editorGroups.length > 1
                        ? { onCloseGroup: () => closeGroupAfterFlush(editorGroup.id) }
                        : {})}
                    />
                    <div
                      className="flex min-h-0 flex-1 flex-col"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        void showWorkbenchMenu("editor", tabPath ?? undefined, editorGroup.id);
                      }}
                    >
            {/* The editor island: a document/tab view that throws (hostile
                markdown tripping the WYSIWYG parse, a failed editor chunk, a
                view bug) contains to this pane — tabs, explorer, and rail
                stay alive, and switching or closing the tab recovers. */}
            <ErrorBoundary
              scope="editor"
              resetKeys={[tabPath, workspaceId, versionEpoch]}
            >
            {isGraphTabPath(tabPath) ? (
              <Suspense fallback={<PanelLoading label="graph" />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={groupDocumentPath}
                  refreshKey={graphKey}
                  onOpenPath={openPathWithHeading}
                  onOpenChatThread={openGraphChatThread}
                  chatMentionsAvailable={captureAvailable}
                  variant="page"
                />
              </Suspense>
            ) : isHistoryTabPath(tabPath) ? (
              <div
                data-testid="history-page"
                className="flex min-h-0 flex-1 flex-col bg-bg"
              >
                {historyTimeline}
              </div>
            ) : isMomentDiffTabPath(tabPath) ? (
              // A persisted moment-diff tab reads THE capture capability,
              // like every other surface main's capture serves. Gating it on
              // the share fact alone left the failed-build cause open: the
              // page still mounted, called readEngineMoment and fell into its
              // own error state (#637).
              !captureAvailable ? (
                isShareView ? (
                  // A persisted moment-diff tab on a shared view (#621).
                  // Virtual tabs survive restore, so this tab outlives the
                  // History surface that opened it — and that surface no
                  // longer exists here (#540). The page would ask main for a
                  // moment a shared view has none of. It states the same
                  // capability the History placeholder states, and the tab
                  // stays closeable.
                  <div
                    data-testid="moment-diff-share-view"
                    className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                  >
                    A shared view records no history. Close this tab to go back
                    to the shared files.
                  </div>
                ) : !captureDecided ? (
                  // Main has not decided yet. The tab must not mount the page
                  // and must not state a capability either: neither read the
                  // shell has done proves anything about what main recorded
                  // (#542), so this window gets a load state, not a claim.
                  <PanelLoading label="history" />
                ) : (
                  // Main decided, and the answer was no recorder — or the
                  // renderer's own read failed, which asserts nothing. The
                  // History placeholder's line, chosen by the cause main
                  // established: this tab is a history surface, and one cause
                  // deserves one sentence wherever it is stated.
                  <div
                    data-testid="moment-diff-off"
                    className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                  >
                    {historyOffCopy}
                  </div>
                )
              ) : (
                <EngineMomentDiffPage
                  workspaceId={workspaceId}
                  tabPath={tabPath ?? ""}
                  onBeforeRestore={flushActiveDraft}
                  onOpenFile={openFile}
                  registerActiveUndo={editorCallbacks?.registerActiveUndo ?? (() => undefined)}
                  onRestored={refreshAfterHistoryRestore}
                />
              )
            ) : isHistoryDiffTabPath(tabPath) ? (
              // A persisted pre-flip tab (legacy change-set diff). The legacy
              // history store is retired; the tab stays closeable but renders
              // an honest note instead of a broken page.
              <div
                data-testid="legacy-history-diff-gone"
                className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-subtle"
              >
                This history diff came from the retired legacy history and is
                no longer available. Current history lives in the History rail.
              </div>
            ) : isVersionCompareTabPath(tabPath) ? (
              // A persisted compare tab reads THE version capability, like
              // every other version entry point. Gating it on the share fact
              // alone left the whole #620 cause open: on a workspace whose
              // capture build failed the page still mounted, called
              // listWorkspaceVersions and compareWorkspaceVersions, and said
              // "Could not compare with Main."
              !captureAvailable ? (
                isShareView ? (
                  // A persisted compare tab on a shared view (#589). The page
                  // asks main for the versions, and a shared view has none —
                  // the same refusal the selector used to raise as a danger
                  // banner. The tab stays closeable and states the capability.
                  <div
                    data-testid="version-compare-share-view"
                    className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                  >
                    A shared view has no versions to compare. Close this tab to
                    go back to the shared files.
                  </div>
                ) : !captureDecided ? (
                  // Main has not decided yet. The tab must not mount the page
                  // and must not state a capability either: neither read the
                  // shell has done proves anything about what main recorded
                  // (#542), so this window gets a load state, not a claim.
                  <PanelLoading label="versions" />
                ) : (
                  // Main decided, and the answer was no recorder — or the
                  // renderer's own read failed, which asserts nothing. One
                  // line, chosen by the cause main established, and never an
                  // assertion about what is on disk.
                  <div
                    data-testid="version-compare-off"
                    className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                  >
                    {versionCompareOffCopy(syncStatus)}
                  </div>
                )
              ) : (
                <VersionComparePage
                  // Remount per version AND per state change so the diff
                  // always reflects the latest disk/engine state.
                  key={`${tabPath}:${versionEpoch}`}
                  workspaceId={workspaceId}
                  versionId={parseVersionCompareTabPath(tabPath) ?? "main"}
                />
              )
            ) : isChatsTabPath(tabPath) ? (
              captureAvailable ? (
                <Suspense fallback={<PanelLoading label="Chats" />}>
                  <LazyChatsView
                    key={`${workspaceId}:${chatsPageRevision}`}
                    {...chatsViewProps}
                    variant="page"
                  />
                </Suspense>
              ) : isShareView ? (
                // A persisted Chats tab on a shared view (#615). The
                // neighbouring line blamed the Settings flag, and a share
                // never touched it: the share's open installs no capture, so
                // main refuses every Chats call. State the capability, and
                // name the next step the tab really has.
                <div
                  data-testid="chats-page-share-view"
                  className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                >
                  A shared view has no chats. Close this tab to go back to the
                  shared files.
                </div>
              ) : !captureDecided ? (
                // Main has not decided yet — a load state, not a claim (#542).
                <PanelLoading label="Chats" />
              ) : (
                // Main decided, and the answer was no capture: the engine flag
                // is off, the settings file is unreadable, or the capture
                // build failed. The line that used to stand here blamed the
                // flag for all three (#628).
                <div
                  data-testid="chats-page-off"
                  className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                >
                  {chatsOffCopy(syncStatus)}
                </div>
              )
            ) : isPluginPanelTabPath(tabPath) ? (
              groupPluginPanel ? (
                <Suspense fallback={<PanelLoading label="plugin panel" />}>
                  <LazyPluginPanelPage
                    workspaceId={workspaceId}
                    pluginId={groupPluginPanel.pluginId}
                    panelId={groupPluginPanel.panelId}
                  />
                </Suspense>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <span className="text-sm text-ink">Could not open plugin panel</span>
                  <button
                    type="button"
                    className="text-xs text-accent hover:underline"
                    onClick={() => {
                      if (tabPath) closeFileTab(editorGroup.id, tabPath);
                    }}
                  >
                    Close tab
                  </button>
                </div>
              )
            ) : isSiteTabPath(tabPath) ? (
              groupSiteRoot ? (
                <Suspense fallback={<PanelLoading label="site" />}>
                  <LazySitePreviewPage
                    workspaceId={workspaceId}
                    siteRoot={groupSiteRoot}
                    sharedView={!!shareView}
                    onOpenPath={openFile}
                    {...(shareView
                      ? {}
                      : { onShareSite: setShareTarget })}
                  />
                </Suspense>
              ) : (
                <InvalidSitePathFallback
                  activeTab={tabPath}
                  onClose={() => {
                    if (tabPath) closeFileTab(editorGroup.id, tabPath);
                  }}
                />
              )
            ) : tabPath && tab && editorCallbacks ? (
              <FileInspector
                key={tabPath}
                workspaceId={workspaceId}
                path={tabPath}
                fileOpenStartMark={fileOpenStartMark(editorGroup.id)}
                // History growth, version switches, AND share-mount pulls all
                // re-read the open file (every counter only ever increases).
                refreshKey={historyRefreshCounter + versionEpoch + mountContentEpoch}
                // G2-C-3: the engine editor re-binds to the new version's Y.Doc
                // lineage ONLY on an active-version change — versionEpoch alone,
                // NOT history growth (which must not churn the live session).
                engineVersionKey={versionEpoch}
                onOpenPath={openPathWithHeading}
                onOpenChatMention={openChatMention}
                // The linked-mentions panel asks main for chat mentions, which
                // is a Chats call like any other (#615) — same gate as the
                // panel, the tab and the graph's toggle.
                chatMentionsAvailable={captureAvailable}
                drawingCollaboration={chatCollaboration}
                scrollTarget={groupScrollTarget}
                headingTarget={
                  headingTarget?.groupId === editorGroup.id &&
                  headingTarget.path === tabPath
                    ? headingTarget.target
                    : undefined
                }
                onScrollConsumed={consumeSearchScrollTarget}
                onSaveStateChange={editorCallbacks.onSaveStateChange}
                registerDraftFlush={editorCallbacks.registerDraftFlush}
                registerSourceToggle={editorCallbacks.registerSourceToggle}
                autoFocus={wb.activeEditorGroup === editorGroup.id}
                knownMarkdownFiles={markdownWikilinkFiles}
                readOnly={!!shareView || isMountedSharePath(tabPath)}
                {...(shareView || isMountedSharePath(tabPath)
                  ? {}
                  : { onSharePath: (path: string) => setShareTarget({ path }) })}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                <DohcMark size={30} className="text-line" />
                <span className="text-sm text-muted">
                  Select a file, or create one
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setNewFileOpen(true)}
                    className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-panel hover:text-ink"
                  >
                    Ctrl N · new file
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-panel hover:text-ink"
                  >
                    Ctrl K · commands
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickOpenOpen(true)}
                    className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-panel hover:text-ink"
                  >
                    Ctrl P · go to file
                  </button>
                </div>
              </div>
            )}
            </ErrorBoundary>
                    </div>
                  </>
                ),
              };
            })}
            activeGroupId={wb.activeEditorGroup}
            onFocusGroup={focusWorkbenchEditorGroup}
            onResizeGroups={(leftGroupId, rightGroupId, leftSize) =>
              mutateWb((state) =>
                resizeEditorGroups(state, leftGroupId, rightGroupId, leftSize),
              )
            }
          />
        </main>

        {/* Chats panel — the right-hand secondary sidebar (flagged
            workspaces that are not shared views). Hidden entirely while
            collapsed; the titlebar Chats button, Ctrl+Alt+B, or the
            toggle-chats command bring it back. History lives in the left
            History view and the history tab — never here. */}
        {engineSurfacesExist && wb.chatsVisible ? (
          <ChatsPanel
            width={wb.chatsWidth}
            onWidthChange={(width) => mutateWb((state) => setChatsWidth(state, width))}
            onCollapse={() => mutateWb(toggleChats)}
            tab={chatsPanelTab}
            onTabChange={setChatsPanelTab}
            actions={
              captureAvailable &&
              chatsPanelTab === "all" &&
              !isChatsTabPath(focusedTabPath) ? (
                <button
                  type="button"
                  data-testid="chats-open-tab"
                  aria-label="Open chats in tab"
                  title="Open chats in tab"
                  onClick={openChatsTab}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <Maximize2 size={13} aria-hidden />
                </button>
              ) : undefined
            }
          >
            {/* Chats island: a crash in either panel view stays contained;
                switching panel mode or workspace tab clears the failure. */}
            <ErrorBoundary
              scope="rail"
              resetKeys={[chatsPanelTab, focusedTabPath]}
            >
              {!captureAvailable ? (
                // Main's capture cannot serve chats here, so mounting either
                // view below would issue calls it refuses and show the
                // refusal as an error (#628). Chats is a persistent sidebar
                // rather than a tab, so the panel stays where the user left
                // it — and states the fact, with the one next step that can
                // change it. Before the decision it states nothing (#542).
                !captureDecided ? (
                  <PanelLoading label="Chats" />
                ) : (
                  <div
                    data-testid="chats-panel-off"
                    className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                  >
                    {chatsOffCopy(syncStatus)}
                  </div>
                )
              ) : chatsPanelTab === "file" ? (
                <Suspense fallback={<PanelLoading label="Chats" />}>
                  <LazyLinkedChatsPanel
                    workspaceId={workspaceId}
                    filePath={activeDocumentPath}
                    initialThread={searchChatTarget?.thread ?? null}
                    initialFocusMessageId={searchChatTarget?.focusMessageId}
                    onInitialThreadConsumed={() => setSearchChatTarget(null)}
                    onOpenPath={openPathWithHeading}
                    onThreadRead={onChatsThreadRead}
                    onError={(message) => setShellError({ message, retry: null })}
                  />
                </Suspense>
              ) : (
                <Suspense fallback={<PanelLoading label="Chats" />}>
                  <LazyChatsView {...chatsNavigatorProps} />
                </Suspense>
              )}
            </ErrorBoundary>
          </ChatsPanel>
        ) : null}
      </div>

      <StatusBar
        workspaceId={workspaceId}
        workspaceName={workspaceName(props.workspace)}
        syncStatus={syncStatus}
        agentActive={agentActive}
        conflictSummaries={conflictSummaries}
        onConnectCloud={() => setCloudOpen(true)}
        onOpenHistory={openHistoryView}
        onOpenConflicts={() => setConflictReviewOpen(true)}
        onOpenSettings={() => openSettings()}
        onToggleTheme={toggleTheme}
        onContextMenu={() => void showWorkbenchMenu("status")}
        agentNotifications={agentNotifs.notifications}
        onDismissAgentNotification={agentNotifs.dismiss}
      />

      {/* A blocked agent run's consent asks (the retired Agent panel's one
          load-bearing interaction). Floats wherever the user already is —
          answering resumes the run. */}
      <AgentPermissionRequests
        workspaceId={workspaceId}
        runId={agentNotifs.pendingPermissionsRunId}
        requests={agentNotifs.pendingPermissions}
      />

      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {quickOpenOpen ? (
        <CommandPalette
          testId="quick-open"
          placeholder="Go to file…"
          ariaLabel="File"
          commands={files.map((file) => ({
            id: file.path,
            label: file.path,
            run: () => openFile(file.path),
          }))}
          // Quick-open ranking (E5.0): prefix > word-boundary > substring >
          // fuzzy; recent files boosted; pinned first. Pure function — the
          // command ids ARE the paths.
          rank={(query, commands) => {
            const byPath = new Map(commands.map((command) => [command.id, command]));
            return rankQuickOpenPaths(query, [...byPath.keys()], {
              recent: wb.recentFiles,
              pinned: wb.pinned,
            }).map((path) => byPath.get(path)!);
          }}
          onClose={() => setQuickOpenOpen(false)}
        />
      ) : null}
      {newFileOpen ? (
        <NewFileDialog
          workspaceId={props.workspace.workspaceId}
          onClose={() => setNewFileOpen(false)}
          onCreated={(path) => {
            setNewFileOpen(false);
            // Reveal the new file in the nested tree (expand its ancestors)
            // and open it — a file created into a collapsed folder must
            // never be invisible.
            mutateWb((state) =>
              ancestorDirs(path).reduce(
                (acc, dir) => setFolderExpanded(acc, dir, true),
                state,
              ),
            );
            openFile(path);
            void refreshFiles().catch((error) =>
              reportShellError("Could not refresh workspace files.", error),
            );
          }}
        />
      ) : null}
      {cloudOpen ? (
        <Overlay
          onClose={() => {
            setCloudOpen(false);
            // A sign-in/out inside the dialog changes the relay session —
            // refresh so Chats presence lights up (or goes dormant) at once.
            refreshCloudStatus();
          }}
        >
          <CloudLogin workspaceId={workspaceId} onConnected={refreshCloudStatus} />
        </Overlay>
      ) : null}
      {conflictReviewOpen ? (
        <ConflictReviewDialog
          workspaceId={workspaceId}
          onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
          onClose={() => setConflictReviewOpen(false)}
        />
      ) : null}
      {settingsSection ? (
        <Overlay onClose={closeSettings}>
          <DesktopSettings
            workspaceId={workspaceId}
            workspacePath={props.workspace.rootPath}
            sharedView={isShareView}
            // Main's own decision, not the renderer's settings read (#542):
            // only main knows whether a recorder exists for this session, and
            // a failed capture build is as recorder-less as the opt-out.
            sessionRecorderOn={
              syncStatus ? !statusSaysNoRecorder(syncStatus) : undefined
            }
            initialSection={settingsSection}
            onClose={closeSettings}
            onAgentActiveChange={onSettingsAgentActiveChange}
            onWorkspaceFilesChanged={() => {
              void reloadShareMounts();
              void refreshFiles().catch(() => undefined);
            }}
            onOpenCloud={() => {
              closeSettings();
              setCloudOpen(true);
            }}
          />
        </Overlay>
      ) : null}
      {shareTarget ? (
        <Overlay onClose={() => setShareTarget(null)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading share dialog...
              </div>
            }
          >
            <LazyRelayShareDialog
              workspaceId={workspaceId}
              target={shareTarget}
              onClose={() => setShareTarget(null)}
            />
          </Suspense>
        </Overlay>
      ) : null}
      {openShareOpen ? (
        <Overlay onClose={() => setOpenShareOpen(false)}>
          <OpenSharedView
            onWorkspaceReady={(workspace) => {
              setOpenShareOpen(false);
              props.onSwitchWorkspace(workspace);
            }}
            onBack={() => setOpenShareOpen(false)}
            {...(shareView
              ? {}
              : {
                  mountInto: {
                    workspaceId,
                    onMounted: (label: string) => {
                      setOpenShareOpen(false);
                      void reloadShareMounts();
                      void refreshFiles().catch(() => undefined);
                      setExplorerFolderExpanded("shared-with-me", true);
                      setExplorerFolderExpanded(`shared-with-me/${label}`, true);
                      showShellNotice(
                        `Added ${label} to shared-with-me — read-only, kept up to date.`,
                      );
                    },
                  },
                })}
          />
        </Overlay>
      ) : null}
    </div>
  );
}
