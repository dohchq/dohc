import { AgentSettingsProvider } from "./workbench/AgentBadge";
import { EngineMomentDiffPage } from "./workbench/EngineMomentDiffPage";
import { StopAndRestoreDialog, useStopAndRestore } from "./StopAndRestoreDialog";
import { hasBlockingModal } from "./modalFocus";
import { PanelLoading } from "./workbench/PanelLoading";
import { isSharedWithMePath } from "@dohc/workspace-core/paths";
import { Bot, Check, ChevronRight, CircleHelp, Copy, Eye, RefreshCw, Search, Send, User } from "lucide-react";
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChatFileMentionRecord,
  ChatThreadRecord,
  DesktopUserSettingsResult,
  EngineMomentRecord,
  EngineStoreRefusal,
  ImportWorkspaceFilesResult,
  ListEngineMomentsResult,
  MyShareChangeRow,
  RefreshSharedViewResult,
  RebuildEngineStoreResult,
  ShareAccess,
  ShareHandoffStatus,
  ShareProposalRow,
  SyncStatusResult,
  TryInVersionRunState,
  WorkbenchMenuCommand,
  WorkspaceGraphResult,
  WorkspaceFileEntry,
  WorkspaceActivityEvent,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
import {
  activityPathsAffectWorkspaceListing,
  ENGINE_STORE_BACKUP_DIR,
  engineStoreRefusalRecovery,
  engineStoreRefusalSentence,
} from "../ipc/bridgeContract";
import { readError } from "../ipc/errorWords";
import {
  formatSize,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../workspaces/workspaceEngineCaptureLimits";
import { DohcMark } from "@dohc/brand";
import {
  hasUnacknowledgedShareSkips,
  shareSkipNoticeLines,
} from "./shareSkipNotice";
import { useChatEditorTabs } from "./shell/useChatEditorTabs";
import { LazyChatsView, LazyGraphView, LazySitePreviewPage } from "./shell/lazyViews";
import { ShellChatsPanel } from "./shell/ShellChatsPanel";
import { ShellSidePanel } from "./shell/ShellSidePanel";
import { ShellTitlebar } from "./shell/ShellTitlebar";
import {
  chatMentionOpenTarget,
  graphChatOpenTarget,
  type DmChatLocator,
} from "./shell/chatOpenTarget";
import { runCanonicalDmNavigation } from "./shell/canonicalDmNavigation";
import {
  chatsOffCopy,
  historyOffPlaceholderCopy,
  versionCompareOffCopy,
} from "./shell/capabilityOffCopy";
import { useAgentSetup } from "./shell/useAgentSetup";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  type DesktopUserSettings,
} from "../settings/userSettings";
import { useCrashReport } from "./shell/useCrashReport";
import { useAutomationHolds } from "./shell/useAutomationHolds";
import { CollectionFieldMarksProvider } from "./collections/collectionFieldMarks";
import { useCloudPresence } from "./shell/useCloudPresence";
import type { ConnectionErrorReport } from "./shell/connectionNotices";
import { useCollectionFolders } from "./shell/useCollectionFolders";
import { useShareMounts } from "./shell/useShareMounts";
import { useEditorRegistry } from "./shell/useEditorRegistry";
import { useSettingsFileNotices } from "./shell/useSettingsFileNotices";
import { useShellError } from "./shell/useShellError";
import { useChatDispatchNotices } from "./shell/useChatDispatchNotices";
import { useSyncFailureNotice } from "./shell/useSyncFailureNotice";
import { fitImportMessage, importedPathDetails, importStopSentence, namedPaths } from "./shell/importStop";
import { CopyDetailsButton, errorDetails } from "./shell/copyDetails";
import { useDesktopUpdateStateFeed } from "./useDesktopUpdateStateFeed";
import { useTabTitles } from "./shell/useTabTitles";
import { useWorkspaceListing } from "./shell/useWorkspaceListing";
import type { SearchResultsEventEntry } from "../ipc/bridgeContract";
import {
  fileOpenStartMark,
  rendererMarks,
  type SwitchCompletionPhase,
  type SwitchPhaseDetails,
} from "../performance/rendererMarks";
import { bridge } from "./bridge";
import { useAsyncResponseEffect } from "./useAsyncResponseEffect";
import type { RelayShareTarget } from "./RelayShareDialog";
import { useSnapshotLane } from "./snapshotLane";
import { CloudLogin } from "./CloudLogin";
import { ErrorBoundary } from "./ErrorBoundary";
import { ExternalLinkConfirm } from "./ExternalLinkConfirm";
import { CommandPalette, type Command } from "./CommandPalette";
import { QuickOpenPalette } from "./QuickOpenPalette";
import {
  classifyForView,
  FileInspector,
} from "./FileInspector";
import {
  preloadMarkdownEditor,
  type HeadingTarget,
  type ScrollTarget,
} from "./MarkdownView";
import { NewFileDialog } from "./NewFileDialog";
import { NewCollectionDialog } from "./collections/NewCollectionDialog";
import { type ShareViewRefresh, useShareDirectWrites } from "./shell/useShareDirectWrites";
import { disposeAutomationButtons } from "./collections/useAutomationButtons";
import { ConnectedCollectionRecoveryRestore } from "./ConnectedCollectionRecoveryRestore";
import {
  abandonPendingCollectionFieldWrites,
  advanceCollectionWriteLineage,
  COLLECTION_WRITE_STALL_MS,
  collectionWriteFailures,
  remapCollectionFieldWritePaths,
  settleCollectionFieldWrites,
  useCollectionWritesBlockingAdmission,
  useCollectionWriteLineage,
} from "./collections/recordFieldWrites";
import { LiveDocumentsDialog } from "./LiveDocumentsDialog";
import { OpenSharedView } from "./OpenSharedView";
import { Overlay } from "./Overlay";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import {
  DEFAULT_SETTINGS_SECTION,
  type SettingsSectionId,
} from "./settings/settingsRegistry";
import { LazyDesktopSettings } from "./settings/LazyDesktopSettings";
import { workspaceName } from "./Titlebar";
import { toggleTheme } from "./theme";
import {
  PrimaryButton,
  SecondaryButton,
} from "./ui/controls";
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
import { collectionAutomationOf, NoticeCenter } from "./workbench/NoticeCenter";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { createActivityCoalescer } from "./workspaceActivityCoalescer";
import { useSentNoticeProps, type NoticeShare } from "./shell/useSentNoticeProps";
import type { SentNotices } from "./shell/useSentNotices";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  EngineHistoryView,
} from "./workbench/EngineHistory";
import {
  ConflictReviewDialog,
  VersionComparePage,
  VersionMenu,
} from "./workbench/WorkspaceVersions";
import {
  ProposalReviewDialog,
  proposerName,
} from "./workbench/ProposalReviewDialog";
import {
  TryInVersionBanner,
  TryInVersionReviewCard,
} from "./workbench/TryInVersion";
// Type-only: erased at compile time, so the ChatsView chunk stays lazy.
import type {
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
  isVersionCompareTabPath,
  parseVersionCompareTabPath,
  versionCompareTabPath,
  isMomentDiffTabPath,
  momentDiffTabPath,
  collectionTabPath,
  transactionalCollectionTabPath,
  parseTransactionalCollectionTabPath,
  isCollectionTabPath,
  parseCollectionTabPath,
  defaultWorkbenchState,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  isChatsTabPath,
  isGraphTabPath,
  isHistoryTabPath,
  isSingletonEditorTabPath,
  isSiteTabPath,
  isViewId,
  isVirtualTabPath,
  MAX_OPEN_TABS,
  moveTab,
  moveTabToGroup,
  openTab,
  resizeEditorGroups,
  moveTabToNewGroup,
  appViewId,
  keepActiveViewAfterRailChange,
  keepActiveViewShown,
  parseAppViewId,
  sidebarViews,
  parseSiteTabPath,
  parseUiState,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  siteTabPath,
  setCollectionActiveView,
  setFolderExpanded,
  setOpenEditorsHeight,
  setView,
  toggleChats,
  toggleFolderExpanded,
  togglePinned,
  toggleSidebarOnRail,
  VIEW_IDS,
  type ActivityViewId,
  type EditorGroup,
  type WorkbenchState,
  type WorkbenchTab,
} from "./workbench/workbenchState";
import type { ChatsPanelTab } from "./workbench/ChatsPanel";
import { usePinnedApps } from "./workbench/pinnedApps";
import { pinnedAppsFor } from "../settings/pinnedApps";
import { ipcErrorMessage } from "./ipcError";
import { createFirstAppFiles } from "./workbench/createFirstApp";

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
const EMPTY_SHARE_MOUNTS: NonNullable<Workspace["shareMounts"]> = [];

const LazyRelayShareDialog = lazy(() =>
  import("./RelayShareDialog").then((mod) => ({ default: mod.RelayShareDialog })),
);
const MARKDOWN_PRELOAD_IDLE_DELAY_MS = 150;
// A history read already spent one second in the daemon's capture-flush
// ladder before it can answer `updating`. Four renderer retries give that
// flush another 1.85 seconds of breathing room without leaving the panel in
// an unbounded spinner. After this ladder, the inline Try again remains.
const HISTORY_UPDATING_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

function waitForHistoryRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

// How often an open workspace re-reads the share state only the relay knows:
// a recipient's mounts, and a granter's waiting changes. Slow on purpose —
// neither is urgent, and both cost a relay round trip per workspace.
const SHARE_RELAY_POLL_MS = 5 * 60 * 1000;

export const WORKBENCH_PERSIST_DELAY_MS = 500;

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
const LazyCollectionPage = lazy(() =>
  import("./CollectionPage").then((mod) => ({ default: mod.CollectionPage })),
);
const LazyTransactionalCollection = lazy(() =>
  import("./ConnectedTransactionalCollection").then(mod => ({ default: mod.ConnectedTransactionalCollection })),
);

// Every folder above a path — expanded when a create/open must reveal it.
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
      detail: "active tab matched site tab format but groupSiteRoot parsed to null",
    });
    onClose();
  }, [activeTab, onClose]);

  return null;
}

type UnjournalableSharePath = Extract<
  RefreshSharedViewResult,
  { ok: true }
>["unjournalablePaths"][number];

function namedUnjournalablePaths(paths: readonly UnjournalableSharePath[]): string {
  const named = paths.slice(0, 3).map((entry) => entry.path).join(", ");
  return paths.length > 3 ? `${named}, and ${paths.length - 3} more` : named;
}

function shareUnjournalableNotice(
  paths: readonly UnjournalableSharePath[],
): string {
  const groups = new Map<
    UnjournalableSharePath["reason"],
    UnjournalableSharePath[]
  >();
  for (const path of paths) {
    const group = groups.get(path.reason) ?? [];
    group.push(path);
    groups.set(path.reason, group);
  }
  const lines: string[] = [];
  for (const reason of [
    "oversized-text",
    "oversized-binary",
    "non-utf8",
    "non-file-replacement",
    "local-collision",
    "unreadable",
  ] as const) {
    const group = groups.get(reason);
    if (!group || group.length === 0) continue;
    const names = namedUnjournalablePaths(group);
    const one = group.length === 1;
    if (reason === "oversized-text") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "This file is" : "These files are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_TEXT_BYTES)} text limit. ` +
          `Make ${one ? "the file" : "the files"} smaller, then refresh.`,
      );
    } else if (reason === "oversized-binary") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "This file is" : "These files are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_BINARY_BYTES)} binary limit. ` +
          `Make ${one ? "the file" : "the files"} smaller, then refresh.`,
      );
    } else if (reason === "non-utf8") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "This file is" : "These files are"} not readable as text. ` +
          `Save ${one ? "the file" : "the files"} as UTF-8 text, then refresh.`,
      );
    } else if (reason === "non-file-replacement") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "A folder or another entry replaces this file" : "Folders or other entries replace these files"}. ` +
          `Restore ${one ? "the file" : "the files"} or move ${one ? "the conflicting entry" : "the conflicting entries"}, then refresh.`,
      );
    } else if (reason === "local-collision") {
      lines.push(
        `dohc could not receive ${names}. ` +
          `${one ? "A file from this machine already uses this path" : "Files from this machine already use these paths"}. ` +
          `Move or remove ${one ? "the file" : "the files"}, then refresh.`,
      );
    } else {
      lines.push(
        `dohc could not read ${names}. ` +
          `Close anything using ${one ? "the file" : "the files"}, or wait, then refresh.`,
      );
    }
  }
  return lines.join(" ");
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  userSettings: DesktopUserSettingsResult | null;
  refreshWorkspaceRegistry: () => Promise<Workspace[]>;
  // A notice's Open passes the file to open once the workspace is ready.
  onSwitchWorkspace: (workspace: Workspace, openPath?: string) => void;
  // May reject: the shell shows why, with a retry.
  onManageWorkspaces?: () => void | Promise<void>;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
  // Notices sent to this person, owned above the shell.
  sentNotices?: SentNotices;
  openPathOnReady?: string;
}) {
  const workspaceShareMounts = props.workspace.shareMounts ?? EMPTY_SHARE_MOUNTS;
  const {
    files,
    folders,
    fileIndex,
    filesRevalidated,
    listingsSettled,
    fileListingCommit,
    refreshFiles,
    hasCommittedListing,
    prepareRestoredTabPruning,
  } = useWorkspaceListing(props.workspace.workspaceId);
  // Main's single answer to "does anything record here": when the
  // open-time decision produced no recorder (a shared view or a failed
  // capture build), every engine-history call can only error.
  const statusSaysNoRecorder = (status: SyncStatusResult | null) =>
    Boolean(
      status?.historyShareView ||
        status?.historyRecordingUnavailable ||
        status?.engineStoreRefused,
    );
  // Whether main's capture decision for this workspace has landed. The
  // surfaces that call on mount need it, and no reading of the status can
  // supply it:
  //
  // - `statusSaysNoRecorder(null)` is false, so a missing status reads as a
  //   recorder (the first fix attempt).
  // - Main registers the workspace's activity entry before it awaits the
  //   capture build, with the recorder fields at their "nothing is wrong"
  //   defaults (`workspaceActivity.ts`). So a present status reads as a
  //   recorder too, while the build is still running.
  //
  // Both are the same mistake: a default read as an answer. `openWorkspace`
  // resolving is the answer, and it is the only one available here — main
  // awaits the capture build before it returns, and `getSyncStatus` does not
  // await anything at all (its handler reads the entry as it stands).
  const [captureDecidedFor, setCaptureDecidedForState] = useState<string | null>(null);
  // Mirror of the same fact, for the callbacks that must consult it without
  // recreating `refreshHistory`. The workspace-open effect is owned by the
  // renderer selection alone, so a settings-driven callback change cannot
  // open the workspace again.
  const captureDecidedRef = useRef<string | null>(null);
  const setCaptureDecidedFor = useCallback((decidedFor: string) => {
    captureDecidedRef.current = decidedFor;
    setCaptureDecidedForState(decidedFor);
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  // The New collection dialog: null = closed, otherwise the folder to
  // create inside ("" = workspace root).
  const [newCollectionFolder, setNewCollectionFolder] = useState<string | null>(
    null,
  );
  const [recoveryWorkspaceId, setRecoveryWorkspaceId] = useState<string | null>(null);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  // The address a failed attempt used. Only set when a notice's Try again has
  // to reopen the connection dialog, and cleared when that dialog closes.
  const [cloudRetryServerUrl, setCloudRetryServerUrl] = useState("");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  // The owner's live-document list, holding the workspace it was opened for
  // rather than a bare flag. The render below only matches the current
  // workspace, so a switch cannot leave the previous workspace's list — or
  // mount a new workspace's — for even one paint.
  const [liveDocumentsWorkspaceId, setLiveDocumentsWorkspaceId] = useState<
    string | null
  >(null);
  // Relay-share dialog target: paths, or a version.
  const [shareTarget, setShareTarget] = useState<RelayShareTarget | null>(null);
  // The Open a share surface: empty, or for a share a notice named.
  const [openShare, setOpenShare] = useState<NoticeShare | "blank" | null>(null);
  const openSharePath = openShare && openShare !== "blank" ? openShare.path ?? undefined : undefined;
  const handoffStatus = props.handoffStatus ?? { status: "idle" as const };
  useEffect(() => {
    if (handoffStatus.status !== "idle") setOpenShare(null);
  }, [handoffStatus.status]);
  // Inline-create requests routed INTO the explorer (palette/menu/header).
  const [createRequest, setCreateRequest] = useState<{
    kind: "file" | "folder";
    id: number;
  } | null>(null);
  const [wb, setWbState] = useState<WorkbenchState>(defaultWorkbenchState);
  // wbRef holds the newest workbench, set with each write rather than after
  // commit. Handlers read it to choose what to act on, and a keydown can
  // arrive between a commit and React's passive effects.
  const wbRef = useRef(wb);
  const writeWb = useCallback((next: WorkbenchState) => {
    wbRef.current = next;
    setWbState(next);
  }, []);

  const openSettings = useCallback(
    (section: SettingsSectionId = DEFAULT_SETTINGS_SECTION) => setSettingsSection(section),
    [],
  );
  const closeSettings = useCallback(() => setSettingsSection(null), []);

  const { agentSetup, readAgentStatusForHistory } = useAgentSetup(
    props.workspace.workspaceId,
    props.userSettings,
    settingsSection,
  );

  const workspaceId = props.workspace.workspaceId;
  // Read by callbacks that outlive a render: the global key handler and a
  // slow update check must not act for a workspace this window has left.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const storeUpdateRequiredRef = useRef(false);
  const openTabs = useMemo(() => allTabs(wb), [wb.editorGroups]);
  const {
    callbacksForEditor,
    dirtyPaths,
    hasDrafts,
    flushStableDrafts,
    undoForEditor,
    toggleSource,
    beginLineageOperation,
    beginDraftOperation,
  } = useEditorRegistry(workspaceId, openTabs);
  const flushActiveDraft = useCallback(() => flushStableDrafts(), [flushStableDrafts]);
  const collectionLineage = useCollectionWriteLineage(workspaceId);
  const stopAndRestore = useStopAndRestore(workspaceId);

  // `openWorkspace` installs main's exact renderer session before it waits
  // for watcher readiness. Its response is the renderer's existing proof that
  // both happened; there is no separate admission IPC. Exact-session bootstrap
  // reads that lose the admission race retry after that proof. The local
  // generation also keeps an A -> B -> A prop sequence from reusing A's earlier
  // proof (DesktopRoot normally gives each workspace a fresh keyed shell).
  const workspaceSelection = useRef({ workspaceId, generation: 0 });
  if (workspaceSelection.current.workspaceId !== workspaceId) {
    workspaceSelection.current = {
      workspaceId,
      generation: workspaceSelection.current.generation + 1,
    };
  }
  const workspaceSelectionGeneration = workspaceSelection.current.generation;
  const switchTimelineToken = useRef<
    ReturnType<typeof rendererMarks.startSwitch> | null
  >(null);
  // Passive effects run after the new keyed shell commits. Starting here
  // excludes abandoned renders while still preceding every async readiness
  // effect declared below.
  useEffect(() => {
    switchTimelineToken.current = rendererMarks.startSwitch(
      workspaceSelectionGeneration,
    );
  }, [workspaceSelectionGeneration]);
  const markCurrentSwitchPhase = useCallback(
    (phase: SwitchCompletionPhase, details?: SwitchPhaseDetails) => {
      const token = switchTimelineToken.current;
      if (
        token === null ||
        token.selectionGeneration !== workspaceSelectionGeneration
      ) {
        return false;
      }
      return rendererMarks.markSwitchPhase(token, phase, details);
    },
    [workspaceSelectionGeneration],
  );
  const workspaceReadyGate = useRef<{
    workspaceId: string;
    selectionGeneration: number;
    promise: Promise<void>;
    resolve: () => void;
    superseded: boolean;
  } | null>(null);
  if (
    workspaceReadyGate.current?.workspaceId !== workspaceId ||
    workspaceReadyGate.current.selectionGeneration !== workspaceSelectionGeneration
  ) {
    if (workspaceReadyGate.current) {
      workspaceReadyGate.current.superseded = true;
      workspaceReadyGate.current.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    workspaceReadyGate.current = {
      workspaceId,
      selectionGeneration: workspaceSelectionGeneration,
      promise,
      resolve,
      superseded: false,
    };
  }
  const workspaceAdmission = workspaceReadyGate.current!;
  useEffect(
    () => () => {
      workspaceAdmission.superseded = true;
      workspaceAdmission.resolve();
    },
    [workspaceAdmission],
  );
  const [workspaceReadyFor, setWorkspaceReadyFor] = useState<{
    workspaceId: string;
    selectionGeneration: number;
  } | null>(null);
  const workspaceIsReady =
    workspaceReadyFor?.workspaceId === workspaceId &&
    workspaceReadyFor.selectionGeneration === workspaceSelectionGeneration;
  const [workspaceOpenFailedFor, setWorkspaceOpenFailedFor] = useState<{
    workspaceId: string;
    selectionGeneration: number;
    message: string;
    // The error as it arrived, for Copy details.
    cause?: string;
    // Admission stopped on pending writes or retained failures from another
    // workspace. Resolving the last blocker retries the open without a click.
    blockedOnCollectionWrites?: boolean;
  } | null>(null);
  const [workspaceOpenAttempt, setWorkspaceOpenAttempt] = useState(0);
  const workspaceOpenFailure =
    workspaceOpenFailedFor?.workspaceId === workspaceId &&
    workspaceOpenFailedFor.selectionGeneration === workspaceSelectionGeneration
      ? workspaceOpenFailedFor
      : null;
  // Admission must wait for ANOTHER workspace's accepted writes: they still
  // need that workspace's renderer session, which `openWorkspace` revokes.
  // This workspace's own failures never block its admission.
  const admissionBlockedOnWrites = useCollectionWritesBlockingAdmission(workspaceId);
  useEffect(() => {
    if (!workspaceOpenFailure?.blockedOnCollectionWrites) return;
    if (admissionBlockedOnWrites) return;
    // Pending saves, schema mutations, and retained failures have all cleared.
    setWorkspaceOpenFailedFor(null);
    setWorkspaceOpenAttempt((attempt) => attempt + 1);
  }, [admissionBlockedOnWrites, workspaceOpenFailure]);
  // Set-aside recovery markers: every path holding a draft marks its
  // tab and Open Editors row — inactive tabs included, because the store is
  // knowable for all of them. Deliberately not part of
  // activeTabDirty, which drives save-first machinery that cannot save these.
  // The store outlives tabs and version switches, so no
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
  const {
    shellErrors,
    hideShellError,
    reportShellError,
    reportShellFailure,
    clearKind,
    reportLaneFailure,
    reportSearchError,
    clearSearchError,
    reportSyncFailure,
    clearSyncFailure,
    showTabLimitError,
    clearTabLimitError,
    showSingletonTabSplitError,
    clearEditorGroupRefusalError,
    showSettingsFileNotice,
    showSuccessNotice,
    showDirectWriteNotice,
    dismissShellError,
    retryShellError,
    runShellErrorAction,
  } = useShellError(workspaceId);
  useChatDispatchNotices(workspaceId, workspaceIsReady, reportShellFailure, clearKind);
  // For surfaces that report a failure as one sentence, with the error that
  // caused it when they have one. One stable identity: ChatsView keys its
  // polls and subscriptions off onError, so a fresh arrow per shell render
  // tore them down and re-armed them every render.
  const reportFailureMessage = useCallback(
    (message: string, cause?: unknown) => reportShellFailure({ message, cause }),
    [reportShellFailure],
  );
  // The workspace's Button runs report through this shell's toasts, so they go with it.
  useEffect(() => () => disposeAutomationButtons(workspaceId), [workspaceId]);
  const onWorkspaceSettingsRead = useSettingsFileNotices({
    workspaceId,
    workspaceIsReady,
    userSettings: props.userSettings,
    show: showSettingsFileNotice,
    reportError: reportFailureMessage,
  });

  // A connection failure from any panel that embeds CloudLogin. The notice
  // outlives the panel, so its Try again reopens the connection dialog with
  // the address that failed when the panel it came from has closed.
  const reportConnectionError = useCallback(
    (error: ConnectionErrorReport) => {
      reportShellFailure({
        message: error.message,
        cause: error.cause,
        retry: () => {
          if (error.retry?.()) return;
          setCloudRetryServerUrl(error.serverUrl ?? "");
          setCloudOpen(true);
        },
      });
    },
    [reportShellFailure],
  );

  // The live-document dialog's own reads and actions, straight through to
  // main. The dialog passes the workspace it asked for, so a response can
  // never be attributed to another one.
  const loadLiveDocuments = useCallback(
    (id: string, retiredAfter?: string) =>
      bridge().listOwnerLiveDocuments({
        workspaceId: id,
        ...(retiredAfter === undefined ? {} : { retiredAfter }),
      }),
    [],
  );
  const stopLiveDocument = useCallback(
    (id: string, path: string) =>
      bridge().stopOwnerLiveDocument({ workspaceId: id, path }),
    [],
  );
  const resumeLiveDocument = useCallback(
    (id: string, path: string) =>
      bridge().resumeOwnerLiveDocument({ workspaceId: id, path }),
    [],
  );
  // The dialog maps refusal codes to app-owned copy and filters diagnostics.
  const loadLiveRefusals = useCallback(async (id: string, after?: string) => {
    const page = await bridge().listOwnerLiveRefusals({
      workspaceId: id,
      ...(after === undefined ? {} : { after }),
    });
    return {
      refusals: page.refusals,
      nextCursor: page.nextCursor,
    };
  }, []);
  const retryLiveShare = useCallback(
    (id: string, shareId: string) =>
      bridge().retryOwnerLiveShare({ workspaceId: id, shareId }),
    [],
  );
  // A refused read or action becomes the shell's own notice, which outlives
  // the dialog. Its Try again runs the dialog's retry while the dialog is
  // open, and reopens the dialog once it is not — but only for the workspace
  // the failure belonged to.
  const reportLiveDocumentsError = useCallback(
    (message: string, error: unknown, retry: () => boolean) => {
      const failedFor = workspaceIdRef.current;
      reportShellError(message, error, () => {
        if (workspaceIdRef.current !== failedFor) return;
        if (retry()) return;
        setLiveDocumentsWorkspaceId(failedFor);
      });
    },
    [reportShellError],
  );

  const reportCloudStatusUnavailable = useCallback(
    (retry: () => void) => {
      const message = "dohc could not check this workspace's server connection.";
      reportShellError(message, new Error(message), retry);
    },
    [reportShellError],
  );
  const { chatCollaboration, refreshCloudStatus, workspaceSynced } =
    useCloudPresence(workspaceId, reportCloudStatusUnavailable);

  // @-mention roster + agent notifications (Agent Notifications & Mentions).
  // The renderer has no identity source yet, so the user shows as "You" —
  // the same fallback main uses for local authorship.
  const LOCAL_USER_LABEL = "You";
  const localAgentName = props.userSettings?.settings.profile.agentName ?? "Your agent";
  const localAgentEnabled = Boolean(agentSetup?.runnerEnabled || agentSetup?.mcpEnabled);
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () => [
      ...(localAgentEnabled
        ? [{
            id: "agent:default",
            kind: "agent" as const,
            handle: "agent",
            label: localAgentName,
            description: "your agent",
          }]
        : []),
      { id: "user:you", kind: "user", handle: "you", label: LOCAL_USER_LABEL, description: "you" },
    ],
    [localAgentEnabled, localAgentName],
  );
  useEffect(() => {
    return scheduleMarkdownEditorPreload();
  }, [workspaceId]);
  const {
    markdownWikilinkFiles,
    conflictSummaries,
    hasMarkdownPath,
    graphRefreshKey,
  } = fileIndex;

  const focusedGroup = activeGroup(wb);
  const focusedTabPath = activeTabPath(wb);
  const {
    tabLabels: knownTabLabels,
    rememberMomentDiffPath,
  } = useTabTitles(workspaceId);
  const anyTabDirty = dirtyPaths.size > 0;
  const activeDocumentPath = isVirtualTabPath(focusedTabPath)
    ? null
    : focusedTabPath;

  // A clicked search result: open the file and land at the line. The target
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
  // state merges when the IPC resolves: it applies only if the user touched
  // nothing in the meantime — a pre-load user action wins (and gets an
  // immediate write, since wb may never change again to arm the debounced
  // one). The touched flag is a ref set synchronously inside every workbench
  // mutation (mutateWb below): comparing committed state against defaults
  // would race React's commit — a queued-but-uncommitted user action would
  // read as "untouched" and the stored state would clobber it. Writes stay
  // off until the load settles so a default-state write can never clobber
  // the stored one.
  const uiStateLoaded = useRef(false);
  const userTouchedWb = useRef(false);
  const restoredActiveFileSurface = useRef<{
    selectionGeneration: number;
    groupId: string;
    path: string;
  } | null>(null);
  const [restoredSurfaceCommit, setRestoredSurfaceCommit] = useState<{
    selectionGeneration: number;
    waitsForFile: boolean;
  } | null>(null);
  // The tab paths the stored state restored — the only ones a file listing is
  // allowed to close. Empty until the load applies, and empty forever when the
  // user acted first and the stored tabs were discarded. STATE, not a ref: the
  // reconciliation below reads it, and the listing can win the race against
  // this load, so it has to re-run when the restore lands.
  const [restoredTabPaths, setRestoredTabPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // The one mutation seam for workbench state: every user-driven transition
  // routes through here so the touched flag is set before React even queues
  // the update. Loading stored state and restored-tab pruning are the only
  // other writers.
  const mutateWb = useCallback(
    (updater: (state: WorkbenchState) => WorkbenchState) => {
      // A pending canonical DM navigation loses to a DESTINATION change, not
      // to every workbench write. Most writes here are not one: a panel resize
      // commits its final size, and the share-mount poll reaches this seam with
      // no user involved at all — cancelling on those would silently discard a
      // DM the user had just clicked.
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
      writeWb(next);
    },
    [writeWb],
  );

  const sidebarSettings = props.userSettings?.settings.sidebar ?? DEFAULT_SIDEBAR_SETTINGS;
  const railViews = useMemo(() => sidebarViews(sidebarSettings), [sidebarSettings]);
  const pinnedRoots = useMemo(
    () => pinnedAppsFor(props.userSettings?.settings, workspaceId),
    [props.userSettings, workspaceId],
  );
  const pinnedApps = usePinnedApps(workspaceId, pinnedRoots);
  const selectedAppRoot = parseAppViewId(wb.activeView);
  const selectedApp = pinnedApps.find((app) => app.root === selectedAppRoot) ?? null;
  // The panel's header names dohc's own view or the pinned app.
  const sidePanelTitle = isViewId(wb.activeView)
    ? activityViewLabel(wb.activeView)
    : selectedApp?.label ?? "App";

  // Every view on the rail, in its order: dohc's own, then pinned apps.
  const railOrder = useMemo<readonly ActivityViewId[]>(
    () => [...railViews, ...pinnedRoots.map(appViewId)],
    [pinnedRoots, railViews],
  );
  const railOrderRef = useRef(railOrder);
  railOrderRef.current = railOrder;
  // When the person hides the selected view or unpins the selected app, the
  // selection moves to a view on the rail. Any other change to the rail,
  // such as hiding another view, reordering, or pinning, leaves it alone, and
  // so does a link or command that opens a hidden view. When the settings
  // first arrive, a selection the rail does not show moves once; before that
  // it stands, so a restart keeps the view that was open.
  const railKey = railOrder.join("\0");
  const settingsLoaded = props.userSettings !== null;
  const previousRailRef = useRef<readonly ActivityViewId[] | null>(null);
  useEffect(() => {
    if (!settingsLoaded) return;
    const previous = previousRailRef.current;
    const rail = railOrderRef.current;
    previousRailRef.current = rail;
    mutateWb((state) =>
      previous === null
        ? keepActiveViewShown(state, rail)
        : keepActiveViewAfterRailChange(state, previous, rail));
  }, [mutateWb, railKey, settingsLoaded]);
  // Toggling the side panel open shows a view on the rail, never a hidden one.
  const toggleSidePanel = useCallback(
    () => mutateWb((state) => toggleSidebarOnRail(state, railOrderRef.current)),
    [mutateWb],
  );

  // A pin is a personal setting. Main applies each pin to the file as it is
  // now, so two quick pins both land; the root hears the save through the
  // settings broadcast, and the sidebar follows.
  const setAppPinned = useCallback(
    async (appRoot: string, pinned: boolean): Promise<void> => {
      try {
        await bridge().setAppPinned({ workspaceId, appRoot, pinned });
      } catch (error) {
        reportShellError(
          pinned ? "dohc could not pin this app." : "dohc could not unpin this app.",
          new Error(ipcErrorMessage(error)),
          () => void setAppPinned(appRoot, pinned),
        );
      }
    },
    [reportShellError, workspaceId],
  );
  const showPinnedAppMenu = useCallback(
    async (appRoot: string) => {
      try {
        const command = await bridge().showWorkbenchMenu({
          workspaceId,
          context: "pinned-app",
          path: appRoot,
        });
        if (command === "unpin-app") await setAppPinned(appRoot, false);
      } catch (error) {
        reportShellError("Could not open the workbench menu.", error);
      }
    },
    [reportShellError, setAppPinned, workspaceId],
  );

  useAsyncResponseEffect(
    async () => {
      try {
        return await bridge().getWorkspaceUiState({ workspaceId });
      } catch (error) {
        await workspaceAdmission.promise;
        if (workspaceAdmission.superseded) throw error;
        return bridge().getWorkspaceUiState({ workspaceId });
      }
    },
    {
      onSuccess: (stored) => {
        let restoredFileSurface: typeof restoredActiveFileSurface.current = null;
        if (stored && !userTouchedWb.current) {
          const parsed = parseUiState(stored);
          const restoredGroup = activeGroup(parsed);
          if (
            restoredGroup.activeTab !== null &&
            !isVirtualTabPath(restoredGroup.activeTab)
          ) {
            restoredFileSurface = {
              selectionGeneration: workspaceSelectionGeneration,
              groupId: restoredGroup.id,
              path: restoredGroup.activeTab,
            };
          }
          // Order matters: writeWb (which sets wbRef), THEN enable flushes — a
          // beforeunload between "loaded" and the restored state's commit
          // must flush the restored state, never the stale default.
          writeWb(parsed);
          setRestoredTabPaths(new Set(allTabs(parsed).map((tab) => tab.path)));
        }
        restoredActiveFileSurface.current = restoredFileSurface;
        setRestoredSurfaceCommit({
          selectionGeneration: workspaceSelectionGeneration,
          waitsForFile: restoredFileSurface !== null,
        });
        uiStateLoaded.current = true;
        if (userTouchedWb.current) {
          void bridge()
            .setWorkspaceUiState({ workspaceId, state: serializeUiState(wbRef.current) })
            .catch(() => undefined);
        }
      },
      onError: () => {
        restoredActiveFileSurface.current = null;
        setRestoredSurfaceCommit({
          selectionGeneration: workspaceSelectionGeneration,
          waitsForFile: false,
        });
        uiStateLoaded.current = true;
      },
    },
    [workspaceAdmission, workspaceId, workspaceSelectionGeneration],
  );
  useEffect(() => {
    if (
      restoredSurfaceCommit?.selectionGeneration !==
        workspaceSelectionGeneration ||
      restoredSurfaceCommit.waitsForFile
    ) {
      return;
    }
    markCurrentSwitchPhase("restored-active-surface-ready");
  }, [
    markCurrentSwitchPhase,
    restoredSurfaceCommit,
    workspaceSelectionGeneration,
  ]);
  const onRestoredFileSurfaceReady = useCallback(
    (path: string, groupId: string) => {
      const target = restoredActiveFileSurface.current;
      if (
        target?.selectionGeneration !== workspaceSelectionGeneration ||
        target.groupId !== groupId ||
        target.path !== path
      ) {
        return;
      }
      if (markCurrentSwitchPhase("restored-active-surface-ready")) {
        restoredActiveFileSurface.current = null;
      }
    },
    [markCurrentSwitchPhase, workspaceSelectionGeneration],
  );

  // Debounced persist (500ms): tabs, view, panel visibility/width, rail.
  useEffect(() => {
    if (!uiStateLoaded.current) return;
    const timer = setTimeout(() => {
      void bridge()
        .setWorkspaceUiState({ workspaceId, state: serializeUiState(wb) })
        .catch(() => undefined);
    }, WORKBENCH_PERSIST_DELAY_MS);
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

  // The close warning for set-aside drafts lives above the error boundary
  // (RecoveryCloseGuard in main.tsx) — a guard here would
  // unmount with a crashed shell and the crash screen's reload would destroy
  // the drafts unannounced.

  // Keep a restored tab only while the workspace still lists its file. A
  // rollback, an external delete, or a share pull changes the tree without an
  // explorer op, so nothing remaps the stored tabs and Open Editors keeps a
  // dead path across restarts.
  //
  // Every listing is checked, not just the first. A shared workspace lists
  // twice on open — once at mount, once after refreshShareView pulls the
  // changed paths — and consuming whichever landed first would either miss a
  // remote delete or judge the tabs against a pre-pull snapshot. Only the
  // restored paths are eligible (see pruneMissingRestoredTabs), so a listing
  // that raced a create can never close a tab opened this session.
  //
  // Both inputs are dependencies because either can arrive first: a listing
  // that beats the ui-state load finds nothing restored yet, and the restore
  // is what has to re-run the check.
  useEffect(() => {
    const prune = prepareRestoredTabPruning(restoredTabPaths, dirtyPaths);
    if (prune === null) return;
    const current = wbRef.current;
    const next = prune(current);
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
    // Activating a neighbour remounts the keyed inspector — that is an open
    // (closeFileTab idiom). Without the mark, the inspector's mount measure
    // brackets whatever stale mark came before it.
    for (const groupId of groupsOpeningFiles) {
      rendererMarks.mark(fileOpenStartMark(groupId));
    }
    writeWb(next);
  }, [
    prepareRestoredTabPruning,
    listingsSettled,
    restoredTabPaths,
    dirtyPaths,
    wb.activeEditorGroup,
    focusedTabPath,
  ]);

  const search = useWorkspaceSearch(
    workspaceId,
    reportSearchError,
    clearSearchError,
  );

  // The result keeps the move outcome visible even when reopening fails.
  const [engineRebuild, setEngineRebuild] = useState<
    | { phase: "confirm"; refusal: EngineStoreRefusal }
    | { phase: "moving"; refusal: EngineStoreRefusal }
    | { phase: "complete"; result: RebuildEngineStoreResult }
    | null
  >(null);
  // Bumped after an engine version operation or a main-process live-session
  // retirement so mounted editors release their old session before reopening.
  const [versionEpoch, setVersionEpoch] = useState(0);
  const engineRebuildReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const engineRebuildOpen = engineRebuild !== null;
  useEffect(() => {
    if (engineRebuildOpen) return;
    engineRebuildReturnFocusRef.current?.focus();
    engineRebuildReturnFocusRef.current = null;
  }, [engineRebuildOpen]);
  // Workspace-scoped guard (AGENTS.md): a slow response for workspace A must
  // never repaint workspace B. Switching workspaces closes the dialog and
  // invalidates any in-flight move's answer.
  const engineRebuildToken = useRef(0);
  const engineRebuildWorkspaceIdRef = useRef(workspaceId);
  if (engineRebuildWorkspaceIdRef.current !== workspaceId) {
    engineRebuildWorkspaceIdRef.current = workspaceId;
    engineRebuildToken.current += 1;
    if (engineRebuild !== null) setEngineRebuild(null);
  }
  const confirmEngineRebuild = useCallback(
    async (refusal: EngineStoreRefusal) => {
      const token = engineRebuildToken.current;
      setEngineRebuild({ phase: "moving", refusal });
      try {
        const result = await bridge().rebuildEngineStore({ workspaceId });
        if (engineRebuildToken.current !== token) return;
        setEngineRebuild({ phase: "complete", result });
      } catch (error) {
        if (engineRebuildToken.current !== token) return;
        setEngineRebuild(null);
        reportShellError(
          "dohc could not move this workspace's data store.",
          error,
        );
      }
    },
    [workspaceId, reportShellError],
  );


  const { onManageWorkspaces } = props;
  const manageWorkspaces = useCallback(() => {
    void Promise.resolve()
      .then(() => onManageWorkspaces?.())
      .catch((error: unknown) =>
        reportShellError("Couldn't open the workspace manager.", error, manageWorkspaces),
      );
  }, [onManageWorkspaces, reportShellError]);

  const refreshSites = useCallback(() => {
    // refreshFiles's own settle bumps listingsSettled, which AppsView
    // already keys its refetch off of (as filesSettledRevision) — nothing
    // else needs to signal that refresh separately.
    void refreshFiles().catch((error) =>
      reportShellError("Could not refresh workspace files.", error),
    );
  }, [refreshFiles, reportShellError]);

  // A shared view has no engine history surface: the share's open installs
  // no capture, and every engine-moments call could only error. Capability
  // identity comes from main's registry summary. This gates the history
  // surface and, below, the versions surface and collections, from the same
  // fact.
  const isShareView = Boolean(props.workspace.shareView);
  // An Edit share view reads and makes document Collections (ADR 0013).
  const shareViewEditsCollections =
    props.workspace.shareView?.access === "edit" &&
    !props.workspace.shareView.damaged &&
    !props.workspace.shareView.ended;
  // Owner live documents require this workspace's server connection.
  const liveDocumentsAvailable = !isShareView && workspaceSynced;
  const { collectionFolders, refreshCollections, datasets, refreshDatasets, nextDataset, loadMoreDatasets, includeArchived, setIncludeArchived } = useCollectionFolders(
    workspaceId,
    workspaceIsReady,
    isShareView,
    shareViewEditsCollections,
  );
  useEffect(() => {
    if (!workspaceIsReady) return;
    void refreshDatasets().catch(error => reportShellError("Could not read Collections.", error, () => { void refreshDatasets(); }));
  }, [workspaceIsReady, refreshDatasets, reportShellError]);
  // Engine history page state: newest-first moments,
  // the keyset cursor for older pages, and the monotonic latest order used
  // as the open-file refresh key.
  const [engineHistory, setEngineHistory] = useState<{
    moments: EngineMomentRecord[];
    nextBeforeMomentOrder: number | null;
    latestMomentOrder: number;
    protectedTruncated: boolean;
  } | null>(null);
  const [engineHistoryLoadingMore, setEngineHistoryLoadingMore] = useState(false);
  // Why there is no page. A null timeline is not "no changes": it is also a
  // first read still in flight, a read that failed, and a page dropped as
  // stale and asked again. "No changes yet" is an assertion about the
  // WORKSPACE, so only a read that answered may reach it — this says
  // whether the newest read answered at all.
  const [engineHistoryReadState, setEngineHistoryReadState] = useState<
    "loading" | "failed" | "updating"
  >("loading");
  // The newest history refresh ISSUED. Only it may call the surface
  // unloadable: an older read failing while a newer one is still in flight
  // has settled nothing. Kept apart from the committed-page watermark on
  // purpose — a failure must not supersede the page lane, because an older
  // read that still succeeds is the only answer anyone has.
  const newestHistoryRefresh = useRef(0);
  // Liveness token for the engine history loads (bumped on unmount): a slow
  // response for one workspace must never repaint another.
  const engineHistoryToken = useRef(0);
  // The newest request whose answer is displayed — the same commit-time
  // watermark the file listing above uses, for the same reason. A request that
  // is merely in flight has answered nothing, and one that fails never will,
  // so superseding on ISSUE threw away the only answer there was and left the
  // timeline stale until some later event refreshed it. Only an answer older
  // than what is already displayed is dropped.
  const committedEngineHistoryToken = useRef(0);
  // A pagination in flight, or 0. Its page is fetched from a cursor into the
  // displayed timeline, so an older refresh must not reset the timeline under
  // it — the append would land against a cursor that no longer describes what
  // is on screen. Cleared when the pagination settles, so a failed one stops
  // holding anything back.
  const pendingEngineHistoryPage = useRef(0);
  // A refresh that was blocked by that pagination, held until it settles.
  // Blocked is not refuted: the pagination may fail, and then this is again
  // the only answer anyone has. Dropping it at resolve time would be the very
  // bug the watermark exists to fix, one interleaving over.
  const blockedEngineHistoryRefresh = useRef<{
    token: number;
    activeVersionId: string;
    commit: () => void;
  } | null>(null);
  // The sync, agent, and try snapshots ride the refresh response but are not
  // the timeline: no pagination competes for them, so they apply as soon as
  // they arrive. Each is its own lane with its own watermark, because a local
  // write only ever knows about the lane it wrote — dismissing a review says
  // nothing about sync state, and rejecting all three would strand a status
  // bar that has no other source (the dismiss emits no activity event).
  //
  // Each lane owns its state, so a write that names no request cannot be
  // written at all. The history page is not one of these: it carries
  // its own admission rules — version staleness, a pagination that may hold it
  // — and the refresh returns it, so it is judged where those rules live.
  const [syncStatus, syncStatusLane] = useSnapshotLane<SyncStatusResult | null>(
    engineHistoryToken,
    null,
  );
  const liveSessionsGenerationRef = useRef<{
    workspaceId: string;
    generation: number | null;
  }>({ workspaceId, generation: null });
  if (liveSessionsGenerationRef.current.workspaceId !== workspaceId) {
    liveSessionsGenerationRef.current = { workspaceId, generation: null };
  }
  useEffect(() => {
    if (captureDecidedFor !== workspaceId || syncStatus === null) return;
    const next = syncStatus.liveSessionsGeneration;
    const previous = liveSessionsGenerationRef.current.generation;
    liveSessionsGenerationRef.current.generation = next;
    if (previous !== null && previous !== next) {
      setVersionEpoch((epoch) => epoch + 1);
    }
  }, [captureDecidedFor, syncStatus, workspaceId]);
  const [agentActive, agentActiveLane] = useSnapshotLane(engineHistoryToken, false);
  // "Try it in a version" (PR 0N-2): the workspace's live try session —
  // running banner or the run's review card. Refreshed with history (the
  // manager pings the same workspace-activity channel on every transition).
  const [tryState, tryStateLane] = useSnapshotLane<TryInVersionRunState | null>(
    engineHistoryToken,
    null,
  );
  // The version the displayed timeline describes, so a pagination can prove
  // its page extends the same timeline it is appending to.
  const committedEngineVersionId = useRef<string | null>(null);
  // The newest authoritative statement of which version is active, and the
  // request that carried it. The engine stamps every history answer with the
  // version it served, and a version-state change asks for it directly; both
  // are the same kind of fact, ordered by the same issue counter, so the newer
  // one wins. The active version is tracked here rather than inferred from the
  // displayed page because a user can switch versions before the first page
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
  // Staleness is one question: does this answer describe a version that a newer
  // statement has already replaced? An answer issued after that statement can
  // never be stale — the engine served it after the switch — which is what
  // keeps a valid new-version refresh that raced the switch event.
  const engineHistoryAnswerIsStale = useCallback(
    (token: number, activeVersionId: string) =>
      activeVersionId !== activeEngineVersion.current.versionId &&
      token < activeEngineVersion.current.token,
    [],
  );
  // The retraction both version paths need. A version statement can arrive
  // after the page it contradicts is already on screen, and the guard only
  // stops a bad answer from being admitted — nothing takes back a page
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
      newestHistoryRefresh.current = engineHistoryToken.current;
      blockedEngineHistoryRefresh.current = null;
    },
    [],
  );
  // Which surface the right-hand Chats panel shows (all chats vs the active
  // file's). Runtime-only — not persisted.
  const [chatsPanelTab, setChatsPanelTab] = useState<ChatsPanelTab>("all");
  // A shared view offers the "This file" tab only, so the panel
  // opens there whatever the runtime state carried in from another workspace.
  const chatsPanelActiveTab: ChatsPanelTab = isShareView ? "file" : chatsPanelTab;
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
  // every request in flight. Merely observing that the run changed under the
  // rendered label is not: that reading came from its own request, which may
  // have been issued before a refresh the shell is still waiting on — and
  // superseding on it would throw away the newer answer. A run observed alive
  // just before it ended would then leave the indicator running forever.
  //
  // So an observation is not written at all. It carries no request token, and
  // arrival order is not ordering: once each lane commits when its own read
  // lands, a refresh answer can commit before the observation arrives, and an
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
    // Nothing to refresh before main's capture decision lands. Any
    // workspace's activity event calls this, so "the open effect has
    // resolved" does not bound it — and in that window both answers below are
    // wrong. The engine branch would ask for moments main is about to refuse,
    // because a status that has not been decided reads as a recorder; the
    // other branch would commit that undecided status over the decided one
    // the open effect is about to publish. The open effect commits the
    // decision and the status it decided together, so nothing is lost by
    // waiting for it.
    if (captureDecidedRef.current !== workspaceId) return;
    // The engine fetch runs only when main's status agrees a recorder exists:
    // after a failed capture build the renderer's own read still
    // says engine-on, and every listEngineMoments call would error.
    const token = ++engineHistoryToken.current;
    newestHistoryRefresh.current = token;
    if (!isShareView && !statusSaysNoRecorder(syncStatusLane.latest())) {
      // Latest-COMMITTED-wins: each request advances the token, and an answer
      // displays only if it is newer than the answer already displayed, so an
      // older response can never overwrite newer moments or move
      // latestMomentOrder backward (shared with loadMoreEngineHistory).
      // A read is on the way, so the surface does not know yet — which is a
      // different thing from knowing the last read failed. Saying so here is
      // also what makes the retry control show that it is working.
      setEngineHistoryReadState("loading");
      // Four reads ride one refresh, and they answer four different
      // questions. One batch made every answer hostage to the worst of them:
      // a try-state failure discarded a history page the engine had already
      // served, and the timeline then said it could not load. An
      // aggregate await is hostage to the slowest of them the same way — a
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
      const pageRead = (async () => {
        for (
          let attempt = 0;
          attempt <= HISTORY_UPDATING_RETRY_DELAYS_MS.length;
          attempt += 1
        ) {
          const response = await bridge().listEngineMoments({
            workspaceId,
            limit: 200,
          });
          if (!("status" in response)) return response;
          if (
            attempt === HISTORY_UPDATING_RETRY_DELAYS_MS.length ||
            token !== newestHistoryRefresh.current
          ) {
            return response;
          }
          await waitForHistoryRetry(HISTORY_UPDATING_RETRY_DELAYS_MS[attempt]!);
          if (token !== newestHistoryRefresh.current) return response;
        }
        // The loop's inclusive bound always returns on its final attempt.
        throw new Error("History retry ladder ended without an answer.");
      })();
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
        readAgentStatusForHistory(),
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
      let response: Awaited<typeof pageRead>;
      try {
        response = await pageRead;
      } catch (error) {
        // A failure is an answer too — about why the surface is blank, not
        // about what the timeline holds. Only the newest read may give it:
        // an older one failing while a newer is still in flight has settled
        // nothing, and after unmount the counter belongs to no read at all.
        if (token !== newestHistoryRefresh.current) return;
        setEngineHistoryReadState("failed");
        throw error;
      }
      if ("status" in response) {
        if (token === newestHistoryRefresh.current) {
          setEngineHistoryReadState("updating");
        }
        return "waiting" as const;
      }
      const page: ListEngineMomentsResult = response;
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
          protectedTruncated: page.protectedTruncated,
        });
        // Readiness belongs to the page that actually commits. A newer
        // activity refresh can beat the workspace-open refresh; marking only
        // the caller's promise then left the profiler waiting even though the
        // current History page was already visible.
        markCurrentSwitchPhase("history-ready");
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
      return "ready" as const;
    }
    // No history source exists: only status and agent state refresh. They ride the same issue order as
    // the engine branch's reads: this refresh answers the very lanes the
    // settings panel and a second refresh also write, and an untimed write
    // ranked by arrival undid both — a run the user had just started, and a
    // newer status.
    const statusRead = bridge().getSyncStatus({ workspaceId });
    const agentRead = readAgentStatusForHistory();
    const askAgain = () => {
      void refreshHistory().catch((error) =>
        reportShellError("Could not refresh history.", error),
      );
    };
    syncStatusLane.settle(
      token,
      statusRead,
      (status) => status,
      (error) =>
        reportLaneFailure("dohc could not refresh sync status.", error, askAgain),
    );
    agentActiveLane.settle(
      token,
      agentRead,
      (agent) => agent.activeRun !== null,
      (error) =>
        reportLaneFailure("dohc could not refresh agent runs.", error, askAgain),
    );
    const settled = await Promise.allSettled([statusRead, agentRead]);
    if (settled.some((lane) => lane.status === "fulfilled")) {
      markCurrentSwitchPhase("history-ready");
    }
    return "ready" as const;
  }, [
    agentActiveLane,
    isShareView,
    markCurrentSwitchPhase,
    readAgentStatusForHistory,
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
    // The version this page belongs to: the one the displayed timeline shows,
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
      // The displayed page remains the honest last answer while capture is
      // settling. Releasing the loading button below gives the user a bounded
      // retry; this expected progress result is never a global error.
      if ("status" in page) return;
      // The committed-answer rule, applied to this page as well: display it
      // unless a newer answer already took the timeline. Superseding on issue
      // here let a newer refresh that merely failed throw this page away.
      // Same two questions as the refresh, plus one an append owes: the page
      // must describe the same version as the timeline it extends.
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
                protectedTruncated:
                  current.protectedTruncated || page.protectedTruncated,
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
      // judged here, by the same two questions every answer faces, so a
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

  // Whether this workspace has engine-backed surfaces at all: history and
  // versions. A shared view renders neither: its open deliberately installed
  // no capture. A registry fact, so this value never waits on anything.
  //
  // Chats is the exception. A share view still installs no capture, so
  // history and versions stay gone, but main answers chat from the SHARE
  // scope instead of a capture, so the Chats panel opens everywhere. Only
  // its "This file" tab there: the per-file surface answers for a file the
  // share already served, and a workspace-wide listing would be a superset
  // to filter (decision 5, and the shape that produced #627).
  // Whether main's capture will SERVE those surfaces. Main's status is the
  // single answer to "does anything record here": after a failed capture
  // build every version, chat and moment call is refused. It can only
  // answer once main has decided, which is what `captureDecided` carries. A
  // status that has not been decided sits at its "nothing is wrong"
  // defaults, and reading those as an answer is how this gate was wrong
  // twice.
  //
  // The capture capability. Everything that calls through
  // `requireEngineCapture` reads this one value — the version selector, the
  // Try-in-version banner and review card, the shell's version fetch, the
  // persisted compare and moment-diff tabs, the Chats panel and tab, the
  // graph's chat mentions and the linked-mentions panel — so the fact is
  // decided once. A surface that re-derives it drifts, which is exactly how
  // the compare tab kept mounting after #614 gated the selector.
  //
  const captureDecided = captureDecidedFor === workspaceId;
  const captureAvailable =
    !isShareView && captureDecided && !statusSaysNoRecorder(syncStatus);
  useEffect(() => {
    if (!workspaceIsReady) return;
    void refreshHistory().catch((error) =>
      reportShellError("Could not refresh history.", error),
    );
  }, [refreshHistory, reportShellError, workspaceIsReady]);
  // Conflict review (0P-C): opened from the notice center's conflict notice.
  // Lists every open conflict — two machines editing apart, or a merge left
  // with "Finish later" — with the same side-by-side cards as the merge flow.
  const [conflictReviewOpen, setConflictReviewOpen] = useState(false);
  const onVersionWorkspaceStateChanged = useCallback(
    (activeVersionId?: string, lineageChanged = true) => {
      if (lineageChanged) {
        advanceCollectionWriteLineage(workspaceId);
      }
      setVersionEpoch((epoch) => epoch + 1);
      // A version switch changes which timeline is true, and the boundary is
      // only worth anything before the answers it has to judge arrive.
      // Rejecting everything in flight by token was too blunt: main notifies
      // the renderer before the switch invoke resolves, so a perfectly valid
      // NEW-version refresh can be issued before this runs, and rejecting it
      // left the panel on the old version whenever the refresh below failed.
      // Naming the version instead fixes that — but a version this callback
      // has to await is not a boundary at all: an old answer landing first
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
        // refresh that fails used to leave the timeline naming a version
        // nobody is on. Retract it here instead. A merge or a
        // conflict resolution names the version the page already describes,
        // so nothing is dropped for them.
        dropContradictedEngineHistory();
      } else if (
        // The capture gate again, off the mirrors for the same reason
        // refreshHistory uses them: this callback also runs from the
        // conflict review dialog, which the notice center opens with no
        // version surface on screen. Not asking leaves the previous statement
        // standing — what the catch below already does. Same clauses as
        // `captureAvailable`, so the fetch cannot outlive the render gate.
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
            // a boundary: while this lookup was in flight, an answer
            // issued before it could commit against a guard that still named
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
      isShareView,
      noteActiveEngineVersion,
      refreshFiles,
      refreshHistory,
      reportShellError,
      workspaceId,
    ],
  );
  // Set once refreshShareView exists below; a failed import's Try again
  // calls it.
  const refreshShareViewRef = useRef<() => Promise<ShareViewRefresh>>(async () => "current");
  // One import seam for the dialog flow and the OS drag-in flow (the latter
  // passes the preload-resolved absolute paths; see the trust-delta note on
  // ImportWorkspaceFilesPayload). targetDir aims the import at a folder ("" /
  // absent = root) — the drop target, or the folder whose context menu ran
  // "Import Files…". Every import ends with a visible summary: what landed,
  // where, and how many sources were skipped — never a silent shrink.
  const importFiles = useCallback(
    async (droppedPaths?: string[], targetDir?: string) => {
      // Try again on a failed import refreshes the shared view first, since
      // some files may have landed, then asks for files for the same folder.
      // Try again already removed the row, so a refresh that leaves the view
      // stale (damaged, failed, or overtaken by another refresh) says why
      // nothing opened.
      const retry = () => {
        void refreshShareViewRef.current().then((refresh) => {
          if (refresh === "current") {
            void importFiles(undefined, targetDir);
            return;
          }
          reportShellFailure({
            message:
              "dohc did not start the import. Refresh the shared view before you import the files that are still missing.",
            kind: "import-files",
          });
        });
      };
      let outcome: ImportWorkspaceFilesResult;
      try {
        outcome = await bridge().importWorkspaceFiles({
          workspaceId,
          ...(droppedPaths ? { droppedPaths } : {}),
          ...(targetDir ? { targetDir } : {}),
        });
      } catch (error) {
        reportShellError("Could not import files.", error, retry, "import-files");
        return;
      }
      const count = outcome.imported.length;
      const skippedSuffix =
        outcome.skipped > 0 ? ` (${outcome.skipped} skipped)` : "";
      // The first copy failed, so nothing landed.
      if (outcome.stop && !outcome.interrupted) {
        reportShellFailure({
          message: fitImportMessage(`Could not import files${skippedSuffix}. `, importStopSentence(outcome.stop), ""),
          details: outcome.stop.detail ? [["Cause", outcome.stop.detail]] : [],
          retry,
          kind: "import-files",
        });
        return;
      }
      if (outcome.interrupted) {
        // Importing the same files again would land second copies under
        // collision names, so name what already landed.
        reportShellFailure({
          message:
            count === 0
              ? "The import stopped before dohc could confirm any files. Refresh the shared view before you try again."
              : fitImportMessage(
                  `Imported ${namedPaths(outcome.imported)} before the import stopped.`,
                  outcome.stop ? ` ${importStopSentence(outcome.stop)}` : "",
                  " Import only the files that are still missing.",
                ),
          // The message names at most two files; the report names them all.
          details: [
            ...(outcome.stop?.detail ? [["Cause", outcome.stop.detail] as const] : []),
            ...importedPathDetails(outcome.imported),
          ],
          retry,
          kind: "import-files",
        });
        try {
          await refreshFiles();
        } catch (error) {
          reportShellError(
            "The import stopped, and the Explorer could not refresh.",
            error,
          );
        }
        return;
      }
      if (count === 0 && outcome.skipped === 0) return; // cancelled dialog
      // Every file was skipped for its name or kind; the same files would be
      // skipped again, so there is nothing to try again.
      if (count === 0) {
        reportShellFailure({ message: `Nothing imported${skippedSuffix}.`, kind: "import-files" });
        return;
      }
      showSuccessNotice(
        `Imported ${count} ${count === 1 ? "file" : "files"}${
          targetDir ? ` into ${targetDir}` : ""
        }${skippedSuffix}.`,
        undefined,
        "import-files",
      );
      try {
        await refreshFiles();
      } catch (error) {
        reportShellError("Files imported, but the explorer could not refresh.", error);
      }
    },
    [workspaceId, refreshFiles, reportShellError, reportShellFailure, showSuccessNotice],
  );

  // The one way a file opens (tree click, quick-open, tab activation): marks
  // file-open-start — file views measure open latency from here — then opens
  // or re-activates the tab. The inspector mounts keyed by the active tab, so
  // every activation is a fresh read + measure. Mark only when the open
  // actually changes something (activeTab moves or a tab is added): a no-op
  // click on the already-active row/tab/overflow item triggers no remount, so
  // marking would leave a stale file-open-start that corrupts the next
  // measure. The transition is computed from wbRef, and the mark fires once,
  // outside the updater.
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
        mutateWb(() => recordRecentFile(next, path));
      };

      const targetGroup = wbRef.current.editorGroups.find(
        (group) => group.id === targetGroupId,
      );
      const targetAlreadyOwnsPath = targetGroup?.tabs.some(
        (tab) => tab.path === path,
      );
      const needsFlush =
        !targetAlreadyOwnsPath &&
        hasDrafts(
          (groupId, tab) => groupId !== targetGroupId && tab.path === path,
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
      hasDrafts,
      clearTabLimitError,
      invalidateDeferredFileOpen,
      mutateWb,
      reportShellError,
      showTabLimitError,
      workspaceId,
    ],
  );
  // Read once: the shell remounts for each workspace.
  const openPathOnReady = useRef(props.openPathOnReady);
  useEffect(() => {
    const path = openPathOnReady.current;
    if (!workspaceIsReady || path === undefined) return;
    openPathOnReady.current = undefined;
    openFile(path);
  }, [openFile, workspaceIsReady]);
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
  // Opens an app of this workspace in its tab, as Apps does.
  const openAppTab = useCallback(
    (siteRoot: string) => openPathWithHeading(siteTabPath(siteRoot)),
    [openPathWithHeading],
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
      mutateWb(() => next);
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
  // A collection folder opens as its views: one tab per collection,
  // keyed by the folder path, through the same virtual-tab path as every
  // other dohc surface — MAX_OPEN_TABS refusal included.
  const openCollectionTab = useCallback(
    (path: string) => {
      openVirtualTab(collectionTabPath(path));
    },
    [openVirtualTab],
  );
  // Open automation, from a notice: the automation's Collection opens with
  // the ⚡ panel on its runs. The page takes the ask once and clears it; the
  // counter keeps rising after a clear, so each ask is new to the panel.
  const [automationFocus, setAutomationFocus] = useState<
    { collectionPath: string; automationId: string; seq: number } | null
  >(null);
  const automationFocusSeq = useRef(0);
  const openAutomation = useCallback(
    (automationId: string) => {
      const target = collectionAutomationOf(automationId);
      if (!target) return;
      openCollectionTab(target.collection);
      automationFocusSeq.current += 1;
      setAutomationFocus({
        collectionPath: target.collection,
        automationId,
        seq: automationFocusSeq.current,
      });
    },
    [openCollectionTab],
  );
  const clearAutomationFocus = useCallback(() => setAutomationFocus(null), []);
  // A Collection page's errors and notices, which can answer after this
  // window has left their workspace. Those are dropped, never shown in the
  // next workspace.
  const collectionReports = useMemo(() => {
    const owner = workspaceId;
    return {
      onError: (fallback: string, error: unknown, retry?: (() => void) | null) => {
        if (workspaceIdRef.current === owner) reportShellError(fallback, error, retry ?? null);
      },
      onNotice: (message: string, undo?: () => void) => {
        if (workspaceIdRef.current === owner) showSuccessNotice(message, undo);
      },
    };
  }, [workspaceId, reportShellError, showSuccessNotice]);
  const openDataCollection = useCallback(
    (datasetId: string, tableId: string) => {
      openVirtualTab(transactionalCollectionTabPath(datasetId, tableId));
    },
    [openVirtualTab],
  );
  const onMoreDataCollections = useCallback(() => {
    void loadMoreDatasets().catch(error => reportShellError("Could not read Collections.", error));
  }, [loadMoreDatasets, reportShellError]);
  const onRestoreCollection = useCallback(() => {
    setRecoveryWorkspaceId(workspaceId);
  }, [workspaceId]);
  const openGraphTab = useCallback(() => {
    openVirtualTab(GRAPH_TAB_PATH);
  }, [openVirtualTab]);
  const openHistoryTab = useCallback(() => {
    openVirtualTab(HISTORY_TAB_PATH);
  }, [openVirtualTab]);
  const cancelDmNavigation = useCallback(() => invalidateDmNavigation(dmNavigationRequest), []);
  const chatPaths = useMemo(() => allTabs(wb).map((tab) => tab.path).filter(isChatsTabPath), [wb.editorGroups]);
  const chatEditors = useChatEditorTabs({
    workspaceId, onOpen: openVirtualTab, onNavigate: cancelDmNavigation,
    paths: chatPaths,
    activePaths: wb.editorGroups.flatMap((group) => group.activeTab ? [group.activeTab] : []),
    enabled: captureAvailable,
    agentName: agentSetup?.agentName,
  });
  const selectedChatsNav = focusedTabPath && isChatsTabPath(focusedTabPath)
    ? chatEditors.get(focusedTabPath).nav : undefined;
  const dataCollections = useMemo(() => datasets.flatMap(dataset => dataset.tables.map(table => ({ datasetId: dataset.datasetId, tableId: table.tableId, name: table.name, archived: dataset.archived }))), [datasets]);
  const tabLabels = useMemo(() => new Map([...knownTabLabels, ...chatEditors.titles,
    ...dataCollections.map(table => [transactionalCollectionTabPath(table.datasetId, table.tableId), table.name] as const),
  ]), [knownTabLabels, chatEditors.titles, dataCollections]);
  const openChatsNavigator = useCallback(() => {
    mutateWb((state) => ({ ...state, chatsVisible: true }));
    setChatsPanelTab("all");
  }, [mutateWb]);
  // The navigator's unread badges come from one fetch at its mount, and the
  // editor is what performs the reads — without this the panel keeps showing
  // counts the user already cleared until something remounts it.
  const [chatsReadRevision, setChatsReadRevision] = useState(0);
  const [chatsThreadRevision, setChatsThreadRevision] = useState(0);
  const [chatsDmReadRevision, setChatsDmReadRevision] = useState(0);
  const onChatsThreadRead = useCallback(() => {
    setChatsReadRevision((current) => current + 1);
  }, []);
  const onChatsDmRead = useCallback(() => {
    setChatsDmReadRevision((current) => current + 1);
  }, []);
  const onChatsThreadStarted = useCallback(() => {
    setChatsThreadRevision((current) => current + 1);
  }, []);
  const openChatsNavInTab = chatEditors.open;
  const openChatsTab = useCallback(() => {
    openChatsNavInTab({ level: "feed" });
  }, [openChatsNavInTab]);
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
        open: openChatsNavInTab,
        onUnavailable: (error) => reportShellError(
          "Could not open this conversation.", error, () => void openCanonicalDmInTab(locator),
        ),
      });
    },
    [openChatsNavInTab, reportShellError, workspaceId],
  );
  // The one way a chat thread lands in the Chats panel (search hits, file
  // mentions without channel metadata, and the Chats view "Files" grouping
  // all route here): hand the known thread to the panel's consume-once seam,
  // switch to "This file", and force the panel visible.
  const openChatThreadInPanel = useCallback(
    (
      thread: { id: string; title: string; createdAtMs: number; updatedAtMs: number },
      focusMessageId?: string,
    ) => {
      // The user picked a different chat destination. The panel is not the
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
  // Engine history diff: one tab per moment.
  const openMomentDiffTab = useCallback(
    (momentId: string, filePath: string) => {
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
          rememberMomentDiffPath(momentId, filePath);
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
      rememberMomentDiffPath,
      reportShellError,
      workspaceId,
    ],
  );
  const refreshAfterHistoryRestore = useCallback(
    () => {
      advanceCollectionWriteLineage(workspaceId);
      void refreshFiles().catch((error) =>
        reportShellError("Could not refresh workspace files.", error),
      );
      void refreshHistory().catch((error) =>
        reportShellError("Could not refresh history.", error),
      );
    },
    [refreshFiles, refreshHistory, reportShellError, workspaceId],
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
      const needsFlush = hasDrafts(
        (groupId, tab) => requested.get(tab) === groupId,
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
      hasDrafts,
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
      if (
        !hasDrafts(
          (candidateGroupId, candidateTab) =>
            candidateGroupId === groupId && candidateTab === tab,
        )
      ) {
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
    [flushStableDrafts, hasDrafts, reportShellError],
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

  // The Explorer selects and focuses this path once its row renders.
  const [explorerReveal, setExplorerReveal] = useState<{ workspaceId: string; path: string } | null>(null);
  const clearExplorerReveal = useCallback(() => setExplorerReveal(null), []);
  const showPathInExplorer = useCallback(
    (path: string, expandPath = false) => {
      mutateWb((state) =>
        [...ancestorDirs(path), ...(expandPath ? [path] : [])].reduce<WorkbenchState>(
          (acc, dir) => setFolderExpanded(acc, dir, true),
          { ...state, activeView: "explorer", sidebarVisible: true },
        ),
      );
      setExplorerReveal({ workspaceId, path });
    },
    [mutateWb, workspaceId],
  );

  // Successful explorer moves/deletes re-project every path-keyed slice
  // (tabs, activeTab, pins, expansion) before the watcher refresh lands, so
  // a rename never leaves a dead tab pointing at the old path. If the remap
  // changes which inspector is mounted, that is an open — re-mark
  // file-open-start (closeFileTab idiom) so the next measure stays honest.
  const onExplorerPathsChanged = useCallback(
    (changes: PendingTreeChange[]) => {
      // Set-aside drafts key by path, so recovery follows the same projection
      // as tabs and pins — a rename must not strand the
      // notice on the old path while the tab remaps to the new one.
      remapOrphanedDraftPaths(workspaceId, (path) =>
        projectTreePath(path, changes),
      );
      // Collection writes key their record and collection by path too. This
      // runs while the operation still holds the cell-edit pause, so a
      // retained write's retry targets the record where the move put it. A
      // deleted path keeps the write at its original path, where the retry
      // fails and the value stays retained for the user to discard.
      remapCollectionFieldWritePaths(workspaceId, (path) =>
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

  const {
    mountCount,
    mountContentEpoch,
    reloadShareMounts,
    refreshShareMounts,
    unmountShare,
    onSettingsFilesChanged,
  } = useShareMounts(
    workspaceId,
    workspaceShareMounts,
    props.refreshWorkspaceRegistry,
    onExplorerPathsChanged,
    refreshFiles,
    reportShellError,
    showSuccessNotice,
  );

  // Reveal-then-create: the inline editbox lives in the explorer view, so
  // make that view visible first (never setView — re-selecting the active
  // view toggles the panel).
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
  // New record (Phase 2 collections): an ordinary markdown file inside the
  // collection folder, created through the same IPC every explorer create
  // takes; the engine adopts it and mints the record id. The untitled name is
  // unique within the collection folder, not the root.
  const createCollectionRecord = useCallback(
    async (collectionPath: string) => {
      const prefix = `${collectionPath}/`;
      const scopedFiles = files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
      const scopedFolders = folders
        .filter((folder) => folder.startsWith(prefix))
        .map((folder) => folder.slice(prefix.length));
      try {
        const result = await bridge().createWorkspaceFile({
          workspaceId,
          relativePath: `${collectionPath}/${uniqueUntitledPath(scopedFiles, scopedFolders, "md")}`,
          initialText: "",
        });
        await refreshFiles();
        openFile(result.path);
      } catch (error) {
        reportShellError("Could not create a record.", error);
      }
    },
    [files, folders, openFile, refreshFiles, reportShellError, workspaceId],
  );
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
  const createFirstApp = useCallback(async () => {
    try {
      const { root } = await createFirstAppFiles({
        workspaceId,
        files,
        folders,
        mutations: bridge(),
      });
      try {
        await refreshFiles();
      } catch (error) {
        reportShellError(
          "The app was created, but the workspace could not refresh.",
          error,
        );
        return;
      }
      openVirtualTab(siteTabPath(root));
    } catch (error) {
      reportShellError("Could not create the app.", error);
      await refreshFiles().catch(() => undefined);
    }
  }, [
    files,
    folders,
    openVirtualTab,
    refreshFiles,
    reportShellError,
    workspaceId,
  ]);
  // Stable identities for the memoized explorer and inspector (D2#2/#5).
  // Inline arrows here handed every shell render a fresh prop set, which
  // re-rendered every TreeRow and re-ran FileInspector for renders that
  // changed nothing they show.
  const onOpenEditorsHeightChange = useCallback(
    (height: number) => mutateWb((state) => setOpenEditorsHeight(state, height)),
    [mutateWb],
  );
  const onExplorerRefreshShareMounts = useCallback(() => {
    void refreshShareMounts(true);
  }, [refreshShareMounts]);
  // One share entry point for both surfaces: the explorer row's "Share…" and
  // the inspector header's share control open the same dialog.
  const onSharePath = useCallback((path: string) => {
    setShareTarget({ kind: "paths", paths: [path] });
  }, []);
  const onExplorerRefresh = useCallback(() => {
    void refreshFiles().catch((error) =>
      reportShellError("Could not refresh workspace files.", error),
    );
  }, [refreshFiles, reportShellError]);
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
      // Through the guard: with set-aside drafts
      // present the recovery dialog opens instead of the one-shot install.
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
      // Mint outside moveState: commitMove calls it to plan the move and again
      // through mutateWb, so minting inside would produce two IDs for one command.
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
      } else if (command === "show-in-explorer" && path) {
        const appRoot = parseSiteTabPath(path);
        if (appRoot !== null) showPathInExplorer(appRoot, true);
        else if (!isVirtualTabPath(path)) showPathInExplorer(path);
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

  const showTabContextMenu = useCallback(
    (groupId: string, path: string) => {
      void showWorkbenchMenu("tab", path, groupId);
    },
    [showWorkbenchMenu],
  );

  // Performance marks (post-commit, so the rendered surface is included):
  // file tree populated, and shell interactive once status/history landed.
  // These live in the workbench ROOT — a view may unmount, this must not.
  useEffect(() => {
    if (files.length > 0) rendererMarks.markOnce("file-tree-loaded");
  }, [files]);
  useEffect(() => {
    if (fileListingCommit === null) return;
    markCurrentSwitchPhase("files-painted", {
      listingSource: fileListingCommit.listingSource,
    });
  }, [fileListingCommit, markCurrentSwitchPhase]);
  useEffect(() => {
    if (!filesRevalidated) return;
    markCurrentSwitchPhase("files-revalidated");
  }, [filesRevalidated, markCurrentSwitchPhase]);
  useEffect(() => {
    if (!hasMarkdownPath) return;
    return scheduleMarkdownEditorPreload();
  }, [files, hasMarkdownPath]);
  useEffect(() => {
    if (syncStatus) rendererMarks.markOnce("workspace-shell-interactive");
  }, [syncStatus]);

  // Open the workspace for this renderer selection. Main admits the exact
  // session before watcher readiness, then returns the capture decision and
  // status once the workspace is ready. A failed attempt runs again only when
  // the user asks the error banner to retry it.
  useEffect(() => {
    let cancelled = false;
    // The open carries a status, so it takes its place in the same issue order
    // as every other read of that lane.
    const token = ++engineHistoryToken.current;
    void (async () => {
      // Admission revokes the PREVIOUS workspace's renderer session, and a
      // queued collection cell write still needs it to open its record
      // (engineYDocSessionIpc rejects opens for a non-current workspace).
      // Those accepted writes land first; this workspace's own writes are
      // untouched by its admission and do not hold it up.
      const settled = await settleCollectionFieldWrites(workspaceId, {
        stallMs: COLLECTION_WRITE_STALL_MS,
      });
      if (cancelled) return;
      if (settled.stalled) {
        // Unapplied input from other workspaces becomes retained failures.
        // Applied writes remain owned until the engine confirms their save.
        abandonPendingCollectionFieldWrites(
          "dohc could not finish saving this change. Retry it, or discard the unsaved change.",
          workspaceId,
        );
      }
      if (settled.stalled || settled.failed > 0) {
        // Admission would strand these writes' retries. The failure surface
        // shows blocked instead of a spinner, and resolving the failures
        // (or Try again) reruns this effect.
        const retainedFailures = collectionWriteFailures().filter(
          (failure) => failure.workspaceId !== workspaceId,
        ).length;
        setWorkspaceOpenFailedFor({
          workspaceId,
          selectionGeneration: workspaceSelectionGeneration,
          message:
            retainedFailures === 0
              ? "dohc has not confirmed this save yet. Keep dohc open until saving finishes."
              : retainedFailures === 1
                ? "A collection change in another workspace has not saved. Retry or discard it to continue."
                : "Collection changes in another workspace have not saved. Retry or discard them to continue.",
          blockedOnCollectionWrites: true,
        });
        return;
      }
      let status: SyncStatusResult;
      try {
        status = await bridge().openWorkspace({ workspaceId });
      } catch (error) {
        if (!cancelled) {
          const { words, cause } = readError(error);
          setWorkspaceOpenFailedFor({
            workspaceId,
            selectionGeneration: workspaceSelectionGeneration,
            message: words ?? "dohc could not open this workspace.",
            ...(cause ? { cause } : {}),
          });
        }
        return;
      }
      if (cancelled) return;
      markCurrentSwitchPhase("session-admitted");
      // Main answers after the safe startup boundary: either a complete
      // baseline or a proven large fresh import. This is the moment the
      // decision exists, and the status committed beside it is the first one
      // that describes that decided workspace. The two commit
      // together, so "decided" never runs ahead of what it decided.
      // The lane may refuse this status, and the decision still stands: what
      // outranks it is a newer status, which describes a workspace at least
      // as decided as this one.
      syncStatusLane.commit(token, status);
      setCaptureDecidedFor(workspaceId);
      workspaceAdmission.resolve();
      setWorkspaceReadyFor({
        workspaceId,
        selectionGeneration: workspaceSelectionGeneration,
      });
      setWorkspaceOpenFailedFor(null);

      const refreshInitialFiles = async () => {
        const paintedCachedListing = await refreshFiles({ allowCached: true });
        if (cancelled || !paintedCachedListing) return;
        await refreshFiles();
      };
      const reportInitialFilesFailure = (error: unknown) => {
        if (!cancelled) {
          reportShellError("Could not refresh workspace files.", error, () => {
            void refreshInitialFiles().catch(reportInitialFilesFailure);
          });
        }
      };
      void refreshInitialFiles().catch(reportInitialFilesFailure);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    workspaceSelectionGeneration,
    workspaceOpenAttempt,
    markCurrentSwitchPhase,
    refreshFiles,
    reportShellError,
    setCaptureDecidedFor,
    syncStatusLane,
    workspaceAdmission,
  ]);

  // Once open has established watcher readiness, refresh everything whenever
  // a settled batch is recorded. The timeline and status stay live without
  // polling. Callback identity changes may replace this subscription, but can
  // never reopen the workspace.
  useEffect(() => {
    if (!workspaceIsReady) return;
    // Trailing-edge coalescing (D2#8): main emits one activity event per
    // settled batch, and a burst (an import, an agent writing many files)
    // used to issue a listing + four history reads per event. One refresh
    // after the burst quiets answers them all — refreshFiles's committed-
    // request watermark and refreshHistory's tokened lanes are latest-wins,
    // so the coalesced (newest) refresh can never lose to a dropped one.
    // A pending timer cleared by this effect's cleanup is not a lost refresh
    // either: every re-run's body above refreshes both surfaces itself.
    // Path detail scopes only the file listing. A complete listing also feeds
    // empty folders, icons, wikilinks, and graph keys, so a named visible path
    // still asks main for one complete result. Main can coalesce that walk
    // across windows after it invalidates the workspace's cached listing.
    // Paths hidden by the lister cannot change any of those structures, so an
    // all-hidden window skips the file IPC once a listing has committed.
    // History always refreshes: capture outcomes and deletes/retirements are
    // not distinguishable from path strings alone.
    //
    // The collections list rides the same cadence: one cheap index read per
    // quieted burst, latest-wins inside refreshCollections.
    let filesRefreshMode: "skip" | "cached" | "full" = "skip";
    const coalescer = createActivityCoalescer(() => {
      const mode = filesRefreshMode;
      filesRefreshMode = "skip";
      if (mode !== "skip" || !hasCommittedListing()) {
        void refreshFiles(mode === "full" ? {} : { allowCached: true }).catch(
          (error) =>
            reportShellError("Could not refresh workspace files.", error),
        );
      }
      void refreshHistory().catch((error) =>
        reportShellError("Could not refresh history.", error),
      );
      if (!isShareView || shareViewEditsCollections) void refreshCollections();
      if (!isShareView) {
        void refreshDatasets().catch(error => reportShellError("Could not read Collections.", error));
      }
    });
    const unsubscribe = bridge().onWorkspaceActivity(
      (event: WorkspaceActivityEvent) => {
        const paths =
          event.workspaceId === workspaceId ? event.paths : undefined;
        if (!paths?.length) {
          filesRefreshMode = "full";
        } else if (
          filesRefreshMode !== "full" &&
          activityPathsAffectWorkspaceListing(paths, bridge().platform)
        ) {
          filesRefreshMode = "cached";
        }
        coalescer.schedule();
      },
    );
    return () => {
      coalescer.cancel();
      unsubscribe();
    };
  }, [
    workspaceId,
    workspaceIsReady,
    refreshFiles,
    refreshHistory,
    reportShellError,
    isShareView,
    refreshCollections,
    refreshDatasets,
    hasCommittedListing,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A stopped workspace answers no workspace shortcut.
      if (storeUpdateRequiredRef.current) return;
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
        const activeUndo = undoForEditor(wbRef.current.activeEditorGroup);
        if (activeUndo?.acceptsEvent(event)) {
          event.preventDefault();
          void activeUndo.run().catch((error) =>
            reportShellError("Could not undo the last history restore.", error),
          );
        }
        return;
      }
      // Zoom chords are deliberately absent here: they are native menu
      // accelerators (applicationMenu.ts), so they work on windows that
      // never mount this shell.
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
        event.preventDefault();
        mutateWb(toggleChats);
      } else if (key === "b") {
        event.preventDefault();
        toggleSidePanel();
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
    openEditorGroupRight,
    mutateWb,
    openSettings,
    reportShellError,
    toggleSidePanel,
    undoForEditor,
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

  // The command registry: the palette renders it and the application menu
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
      // Creating a collection writes collection.yaml and immediately opens
      // an engine-backed surface. Shared views therefore get neither the
      // application-menu action nor the palette entry.
      ...(props.workspace.shareView && !shareViewEditsCollections
        ? []
        : [
            {
              id: "new-collection",
              label: "New collection",
              run: () => setNewCollectionFolder(""),
            },
          ]),
      {
        id: "quick-open",
        label: "Go to",
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
        run: toggleSidePanel,
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
              run: () => toggleSource(wbRef.current.activeEditorGroup),
            },
          ]
        : []),
      // Every workspace has the Chats panel, shared views included. A
      // workspace whose capture cannot serve chats keeps the command: the
      // panel is still there, stating what dohc cannot do.
      {
        id: "toggle-chats",
        label: "Toggle chats panel",
        run: () => mutateWb(toggleChats),
      },
      // Every view of dohc's, hidden from the rail or not: a command opens it.
      ...VIEW_IDS.map((view) => ({
        id: `show-${view}`,
        label: `View: ${activityViewLabel(view)}`,
        run: () => mutateWb((state) => setView(state, view)),
      })),
      ...pinnedApps.map((app) => ({
        id: `show-${appViewId(app.root)}`,
        label: `View: ${app.label}`,
        run: () => mutateWb((state) => setView(state, appViewId(app.root))),
      })),
      {
        id: "connect-cloud",
        label: "Connect server",
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
      {
        id: "zoom-in",
        label: "Zoom in",
        run: () =>
          void bridge().stepWindowZoom({ step: "in" }).catch((error) =>
            reportShellError("Could not change the window zoom.", error),
          ),
      },
      {
        id: "zoom-out",
        label: "Zoom out",
        run: () =>
          void bridge().stepWindowZoom({ step: "out" }).catch((error) =>
            reportShellError("Could not change the window zoom.", error),
          ),
      },
      {
        id: "zoom-reset",
        label: "Reset zoom",
        run: () =>
          void bridge().stepWindowZoom({ step: "reset" }).catch((error) =>
            reportShellError("Could not change the window zoom.", error),
          ),
      },
    ],
    [
      activeDocumentPath,
      pinnedApps,
      toggleSidePanel,
      createUntitledDrawing,
      openWorkspaceFolder,
      closeActiveTab,
      importFiles,
      mutateWb,
      requestExplorerCreate,
      checkForDesktopUpdates,
      installDesktopUpdate,
      openEditorGroupRight,
      openSettings,
      reportShellError,
      toggleSource,
      workspaceId,
      props.workspace.shareView,
    ],
  );

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      if (command === "command-palette") setPaletteOpen(true);
      else commands.find((entry) => entry.id === command)?.run();
    });
  }, [commands]);

  // Received workspaces refresh on open and on demand. Live, undamaged Edit grants
  // allow document changes for submission; Chats remain read-only.
  // The history placeholder uses the share's live state to offer Refresh.
  const shareView = props.workspace.shareView ?? null;
  // The stored grant could not be read. The marker still stands — a
  // share view must never present as an ordinary workspace — but there is no
  // grant to pull with, so the refresh is skipped rather than failed, and the
  // banner says so instead of showing a level nobody can read.
  const shareViewDamaged = !!shareView?.damaged;
  // The relay-derived generic chat fact selects the Comment banner's next
  // step. It does not grant a desktop write: every received share's Chats are
  // read-only in Phase 3 because the store cannot prove per-row delivery.
  const [shareViewEnded, setShareViewEnded] = useState(!!shareView?.ended);
  const shareViewHasIndependentChat =
    !shareViewDamaged &&
    !shareViewEnded &&
    shareView?.access === "comment" &&
    shareView?.genericChatWritable === true;
  // Whether this share grants DOCUMENT writes, read the same way
  // and for the same reason: positive recognition only, so `view`, an absent
  // level, and a damaged grant all stay read-only. An ended share grants
  // nothing either — its recipient can no longer send anything back, so an
  // editable copy would be a dead end the banner has already closed.
  //
  // Edit does not write the granter's files. It writes the recipient's own
  // copy, which the recipient then sends for the granter to accept.
  const shareViewDocumentsWritable =
    !shareViewDamaged && !shareViewEnded && shareView?.access === "edit";
  const shareGranterName = shareView?.granterEmail ?? "another dohc user";
  const [shareRefreshing, setShareRefreshing] = useState(false);
  const [shareExclusions, setShareExclusions] = useState<{
    workspaceId: string;
    paths: UnjournalableSharePath[];
  } | null>(null);
  const shareExcludedPaths =
    shareExclusions?.workspaceId === workspaceId ? shareExclusions.paths : [];
  const shareRefreshToken = useRef(0);
  // Ops this share's pulls skipped, read from the RECORD, not from the last
  // refresh. The skip is durable — the cursor committed past those ops — so a
  // later quiet refresh must not clear the warning while the content is still
  // missing, and a restart must not either.
  //
  // The record is re-read after every refresh rather than taken from the boot
  // snapshot in props: the recorder writes during the pull, so a refusal that
  // happens while this shell is mounted would otherwise wait for a remount.
  // Latest-wins token, the same guard reloadShareMounts uses.
  const bootSkipped = props.workspace.shareView?.skippedOps ?? null;
  const [shareSkipped, setShareSkipped] = useState(
    hasUnacknowledgedShareSkips(bootSkipped) ? bootSkipped : null,
  );
  const shareSkippedToken = useRef(0);
  const reloadShareSkipped = useCallback(async () => {
    const token = ++shareSkippedToken.current;
    const workspaces = await props.refreshWorkspaceRegistry();
    if (token !== shareSkippedToken.current) return;
    const entry = workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    const skipped = entry?.shareView?.skippedOps ?? null;
    // Only what the user has not seen. Acknowledging hides the warning
    // without deleting the record, so this reads the marker rather than the
    // record's presence.
    setShareSkipped(hasUnacknowledgedShareSkips(skipped) ? skipped : null);
  }, [props.refreshWorkspaceRegistry, workspaceId]);
  const {
    automationHolds, automationHoldsUnreadable, allowAutomationHold, resetAutomationHolds, revealAutomationHolds,
    automationStops, dismissAutomationStops,
  } = useAutomationHolds(
    workspaceId,
    workspaceIsReady,
    reportShellError,
  );
  const crashReportNotice = useCrashReport({
    reportError: reportShellError,
    showSuccess: showSuccessNotice,
  });

  const refreshShareView = useCallback(async (): Promise<ShareViewRefresh> => {
    if (!shareView) return "current";
    if (shareViewDamaged) return "stale";
    const token = ++shareRefreshToken.current;
    setShareRefreshing(true);
    const repaintAfterChange = async () => {
      await refreshFiles();
      setVersionEpoch((epoch) => epoch + 1);
    };
    const bestEffortRepaint = async () => {
      try {
        await repaintAfterChange();
      } catch (repaintError) {
        console.error(
          "[desktop] repaint after shared-view refresh failed:",
          repaintError,
        );
      }
    };
    try {
      const outcome = await bridge().refreshSharedView({ workspaceId });
      if (token !== shareRefreshToken.current) return "stale";
      if (!outcome.ok) {
        if (outcome.changedPaths > 0) await bestEffortRepaint();
        if (token !== shareRefreshToken.current) return "stale";
        reportShellError(
          "Couldn't refresh the shared view.",
          new Error(`Couldn't refresh the shared view. ${outcome.errorMessage}`),
        );
        return "stale";
      }
      if (outcome.collisionRecordQuarantined) {
        reportShellFailure({
          message:
            "dohc could not read this share's collision record, so it set the record aside. A refresh may overwrite local files that collided.",
        });
      }
      if (outcome.status === "ended") {
        setShareExclusions({ workspaceId, paths: [] });
        setShareViewEnded(true);
      } else {
        setShareExclusions({ workspaceId, paths: outcome.unjournalablePaths });
      }
      if (outcome.changedPaths > 0) {
        await repaintAfterChange();
      }
      return outcome.status === "ended" ? "ended" : "current";
    } catch (error) {
      // A store only a newer dohc opens stops the whole workspace, and the
      // stop state already says so. A toast would repeat it.
      const status = await bridge()
        .getSyncStatus({ workspaceId })
        .catch(() => null);
      if (
        status?.engineStoreRefused != null &&
        engineStoreRefusalRecovery(status.engineStoreRefused) === "update"
      ) {
        return "stale";
      }
      reportShellError("Couldn't refresh the shared view.", error);
      return "stale";
    } finally {
      // After the listing and after a FAILURE, deliberately. Refusals are
      // recorded page by page before each cursor commit, so a refresh that
      // died on a later page still left durable evidence behind — reading it
      // only on the success path would keep that invisible until a lucky
      // refresh or a remount. Start this after the listing, but do not let a
      // slow registry read keep the Refresh control disabled.
      if (token === shareRefreshToken.current) setShareRefreshing(false);
      void reloadShareSkipped().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareView?.shareId, shareViewEnded, workspaceId, reloadShareSkipped]);
  refreshShareViewRef.current = refreshShareView;
  useEffect(() => {
    // One automatic refresh when a shared view opens; afterwards on demand.
    if (workspaceIsReady && shareView && !shareViewEnded && !shareViewDamaged) {
      void refreshShareView();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, workspaceIsReady]);

  // ---- The recipient's own submitted changes ----
  // A submission exists only from Send changes: there is no draft at the
  // relay, so this reads what was sent, never what is unsent.
  const [myShareChange, setMyShareChange] = useState<MyShareChangeRow | null>(null);
  const [shareChangesSubmitting, setShareChangesSubmitting] = useState(false);
  // Set by a submit that found nothing to send. Cleared by the next submit,
  // so the line never outlives the click it answers.
  const [shareChangesEmpty, setShareChangesEmpty] = useState(false);
  // What the last submit left behind: files an edit put outside the shared
  // paths, and whether the bound held changes back for the next submit. Null
  // when the last submit took everything, which is the ordinary case.
  const [shareChangesSkipped, setShareChangesSkipped] = useState<{
    outsideShare: number;
    morePending: boolean;
  } | null>(null);
  // Latest-wins token, the same guard reloadShareSkipped uses: an answer for
  // one workspace must never repaint another.
  const myShareChangeToken = useRef(0);
  // Returns the token IT took. A caller that reloads mid-flight has to know
  // that number: this read advances the shared counter, so a caller still
  // comparing the token it started with would find it stale and skip its own
  // cleanup for ever.
  const reloadMyShareChanges = useCallback(async (): Promise<number> => {
    const token = ++myShareChangeToken.current;
    const result = await bridge().listMyShareChanges({ workspaceId });
    if (token !== myShareChangeToken.current) return token;
    // The newest submission is the one the surface speaks for; older ones are
    // settled history the granter's side already accounts for.
    setMyShareChange(
      result.proposals.reduce<MyShareChangeRow | null>(
        (newest, candidate) =>
          newest !== null && newest.createdAtMs >= candidate.createdAtMs
            ? newest
            : candidate,
        null,
      ),
    );
    return token;
  }, [workspaceId]);
  useEffect(() => {
    setMyShareChange(null);
    setShareChangesEmpty(false);
    setShareChangesSkipped(null);
    // Read for any share view, not only one that can still send: changes
    // already sent stay withdrawable after a downgrade, and a surface that
    // stopped reading them would hide the only way back.
    if (!isShareView) return;
    void reloadMyShareChanges().catch(() => undefined);
  }, [isShareView, reloadMyShareChanges]);
  const sendShareChanges = useCallback(async () => {
    const token = myShareChangeToken.current;
    // The newest token this call owns. The reload below takes a fresh one, and
    // the cleanup has to compare against that — comparing against the token
    // this call started with finds it stale every time and leaves the control
    // reading "Sending…" for ever.
    let owned = token;
    setShareChangesSubmitting(true);
    const bestEffortRepaint = async () => {
      try {
        await refreshFiles();
        setVersionEpoch((epoch) => epoch + 1);
      } catch (repaintError) {
        console.error("[desktop] repaint after send changes failed:", repaintError);
      }
    };
    try {
      const result = await bridge().submitShareChanges({ workspaceId });
      if (token !== myShareChangeToken.current) return;
      if (!result.ok) {
        if (result.capturedLocalChanges > 0) await bestEffortRepaint();
        reportShellError(
          "Couldn't send your changes.",
          new Error(result.errorMessage),
        );
        return;
      }
      if (result.capturedLocalChanges > 0) await bestEffortRepaint();
      setShareChangesEmpty(result.submitted === 0);
      setShareChangesSkipped(
        result.skippedOutsideShare > 0 || result.morePending
          ? {
              outsideShare: result.skippedOutsideShare,
              morePending: result.morePending,
            }
          : null,
      );
      owned = await reloadMyShareChanges();
    } catch (error) {
      reportShellError("Couldn't send your changes.", error);
    } finally {
      if (owned === myShareChangeToken.current) setShareChangesSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, reloadMyShareChanges]);
  useShareDirectWrites({
    workspaceId,
    enabled: shareViewDocumentsWritable,
    ownerName: shareGranterName,
    refreshShareView,
    sendShareChanges,
    showNotice: showDirectWriteNotice,
  });
  const withdrawShareChanges = useCallback(
    async (proposalId: string) => {
      const token = myShareChangeToken.current;
      let owned = token;
      setShareChangesSubmitting(true);
      try {
        await bridge().withdrawShareChanges({ workspaceId, proposalId });
        if (token !== myShareChangeToken.current) return;
        // Taking the changes back retires what the last submit reported about
        // them. Leaving those lines up would describe a submission that is no
        // longer out there.
        setShareChangesEmpty(false);
        setShareChangesSkipped(null);
        owned = await reloadMyShareChanges();
      } catch (error) {
        reportShellError("Couldn't take your changes back.", error);
      } finally {
        if (owned === myShareChangeToken.current) setShareChangesSubmitting(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [workspaceId, reloadMyShareChanges],
  );

  // ---- The granter's side of the same lane ----
  // Changes recipients sent to this workspace. One notice per submission, and
  // the review dialog each notice opens.
  const [shareProposals, setShareProposals] = useState<readonly ShareProposalRow[]>([]);
  const [reviewProposalId, setReviewProposalId] = useState<string | null>(null);
  const shareProposalsToken = useRef(0);
  const reloadShareProposals = useCallback(async () => {
    const token = ++shareProposalsToken.current;
    const result = await bridge().listShareProposals({ workspaceId });
    if (token !== shareProposalsToken.current) return;
    setShareProposals(result.proposals);
  }, [workspaceId]);
  useEffect(() => {
    setShareProposals([]);
    setReviewProposalId(null);
  }, [workspaceId]);

  // Relay-side share state follows its shares while the workspace is open:
  // one pull on open, then a slow poll. Manual refresh stays available in the
  // explorer context menu.
  //
  // Both sides of a share ride this one cadence. A recipient's mounts change
  // when the granter changes them, and a granter's waiting changes arrive at
  // the relay — and neither reaches this machine as workspace activity,
  // because a proposal is deliberately not in anyone's log. A
  // timer of its own would poll the same relay twice on two schedules.
  //
  // A share view holds someone else's files, so it is never the granter who
  // decides about them.
  const pollsShareMounts = mountCount > 0;
  const pollsShareProposals = !isShareView;
  useEffect(() => {
    if (!workspaceIsReady || (!pollsShareMounts && !pollsShareProposals)) return;
    const pull = () => {
      if (pollsShareMounts) void refreshShareMounts();
      if (pollsShareProposals) void reloadShareProposals().catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, SHARE_RELAY_POLL_MS);
    return () => clearInterval(timer);
  }, [
    pollsShareMounts,
    pollsShareProposals,
    refreshShareMounts,
    reloadShareProposals,
    workspaceIsReady,
  ]);
  const { retryDialog: sentNoticeRetryDialog, ...sentNoticeProps } = useSentNoticeProps({
    sentNotices: props.sentNotices,
    workspaceId,
    workspaces: props.workspaces,
    openFile,
    openAutomation,
    onSwitchWorkspace: props.onSwitchWorkspace,
    onOpenShare: setOpenShare,
    reportShellError,
  });
  const shareChangeNotices = useMemo(
    () =>
      shareProposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        sender: proposerName(proposal),
      })),
    [shareProposals],
  );

  // One history timeline element, rendered by the side panel's History view
  // and the history tab — the engine page state is root-owned (never a
  // second subscription). A workspace with no history source (retirement
  // Phase C removed the legacy recorder) gets a placeholder instead of an
  // empty list, and what that placeholder claims comes from main's status —
  // or, for a shared view, the registry capability and the share's live
  // state — never from the renderer's own capability read.
  const historyOffCopy = historyOffPlaceholderCopy(
    syncStatus,
    shareView
      ? { ended: shareViewEnded, granterEmail: shareView.granterEmail }
      : null,
  );
  // The rail needs no capture-decision clause of its own, unlike the surfaces
  // that call on mount. Only `refreshHistory` and the open effect
  // commit a status, and both now answer after the decision, so a null status
  // is exactly the undecided window — and it lands in the branch below with
  // no page to show, which is already a load state. Adding the clause here
  // would render the same thing from a second place.
  const historyTimeline =
    !isShareView && !statusSaysNoRecorder(syncStatus) ? (
    // The timeline renders only when a read ANSWERED. Flattening a
    // null page into an empty list told the user a workspace with real
    // history had no changes, whenever a read was in flight or had failed.
    engineHistory ? (
      <EngineHistoryView
        moments={engineHistory.moments}
        hasMore={engineHistory.nextBeforeMomentOrder != null}
        loadingMore={engineHistoryLoadingMore}
        protectedTruncated={engineHistory.protectedTruncated}
        onLoadMore={() => void loadMoreEngineHistory()}
        onOpenMoment={openMomentDiffTab}
      />
    ) : engineHistoryReadState === "failed" ||
      engineHistoryReadState === "updating" ? (
      // The same state its two siblings render — ChatsView and LinkedChats
      // both say a panel could not load beside a Try again — so it takes
      // their look, not the empty-state recipe next door. One line, and a
      // Next that works on this surface: the read this panel runs itself.
      <div
        data-testid={
          engineHistoryReadState === "updating"
            ? "history-updating"
            : "history-load-failed"
        }
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <span
          className={
            engineHistoryReadState === "updating"
              ? "text-xs text-muted"
              : "text-xs text-danger"
          }
        >
          {engineHistoryReadState === "updating"
            ? "Recent changes are still being added to History."
            : "dohc could not load this workspace's history."}
        </span>
        <button
          type="button"
          onClick={() =>
            void refreshHistory().catch((error) =>
              reportShellError("Could not refresh history.", error),
            )
          }
          className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
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
  // dropped and re-fetched — a cache-buster that revisits a value can
  // suppress a needed re-read. A shared view has no history growth to
  // react to. (Max-tracking a ref during render is idempotent, so a
  // repeated render commits the same value.)
  const historyRefreshFloor = useRef(0);
  historyRefreshFloor.current = Math.max(
    historyRefreshFloor.current,
    engineHistory ? engineHistory.latestMomentOrder + 1 : 0,
  );
  const historyRefreshCounter = isShareView ? 0 : historyRefreshFloor.current;
  const graphKey = isShareView
    ? graphRefreshKey
    : `${graphRefreshKey}\0${engineHistory?.latestMomentOrder ?? -1}`;

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
        tabLabels={tabLabels}
        expandedFolders={wb.expandedFolders}
        pinned={wb.pinned}
        openEditorsHeight={wb.openEditorsHeight}
        onOpenEditorsHeightChange={onOpenEditorsHeightChange}
        createRequest={createRequest}
        revealPath={explorerReveal?.workspaceId === workspaceId ? explorerReveal.path : null}
        onRevealed={clearExplorerReveal}
        onOpenFile={openFile}
        onActivateTab={activateEditorTab}
        onCloseTab={closeFileTab}
        onCloseAllTabs={closeAllTabs}
        onNewUntitledTextFile={createUntitledTextFile}
        onCollapseFolders={collapseExplorerFolders}
        onSetFolderExpanded={setExplorerFolderExpanded}
        onToggleFolder={toggleExplorerFolder}
        onTogglePin={toggleExplorerPin}
        collectionFolders={collectionFolders}
        onOpenCollection={openCollectionTab}
        dataCollections={dataCollections}
        includeArchivedCollections={includeArchived}
        onIncludeArchivedCollections={isShareView ? undefined : setIncludeArchived}
        onOpenDataCollection={openDataCollection}
        onMoreDataCollections={nextDataset ? onMoreDataCollections : undefined}
        onRestoreCollection={!isShareView && props.workspace.mode !== "cloud-only" && workspaceIsReady ? onRestoreCollection : undefined}
        onBeginChanges={beginDraftOperation}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={importFiles}
        shareView={shareView}
        onRefreshShareMounts={onExplorerRefreshShareMounts}
        onUnmountShare={unmountShare}
        onShare={onSharePath}
        onRefresh={onExplorerRefresh}
        onError={reportFailureMessage}
        onNewCollection={setNewCollectionFolder}
      />
    </>
  );

  // The editor is the one live conversation surface. It owns presence,
  // drafts, and navigation state.
  const dmWorkspaceOptions = useMemo(
    () =>
      props.workspaces
        .filter((workspace) => !workspace.shareView)
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          label: workspaceName(workspace),
        })),
    [props.workspaces],
  );
  const openAgentSettings = useCallback(
    () => openSettings("agents"),
    [openSettings],
  );
  // The add-agent form writes the same settings file the dialog does. The
  // root hears the write through the settings-changed broadcast and the
  // agent setup summary follows.
  const saveUserSettingsFromChats = useCallback(
    async (settings: DesktopUserSettings, base: DesktopUserSettings) => {
      await bridge().setUserSettings({ settings, base });
    },
    [],
  );
  const chatsViewProps = {
    workspaceId,
    workspaces: dmWorkspaceOptions,
    onOpenNavigator: openChatsNavigator,
    onThreadRead: onChatsThreadRead,
    onThreadStarted: onChatsThreadStarted,
    onDmRead: onChatsDmRead,
    onOpenFileChat: openFileChatInPanel,
    onOpenPath: openPathWithHeading,
    onError: reportFailureMessage,
    mentionCandidates,
    workspaceFiles: files,
    collaboration: chatCollaboration,
    agentSetup,
    onSetupAgent: openAgentSettings,
    userSettings: props.userSettings?.settings ?? null,
    onSaveUserSettings: saveUserSettingsFromChats,
    workspacePath: props.workspace.rootPath,
  } as const;
  // The panel intentionally stays on the overview and only selects editor
  // destinations. Active chat pages own the live conversations: disable the
  // navigator's collaboration transport so it cannot
  // create a duplicate presence lease, and suspend its polls so one open
  // conversation does not double every chat read (D2#6). The page's landed
  // reads still reach the navigator through their local-thread and DM
  // revisions.
  const chatsTabIsLive = wb.editorGroups.some((group) =>
    isChatsTabPath(group.activeTab),
  );
  // The panel is a navigator, like the Explorer: it lists Home, the groups,
  // people and agents, and every click opens that conversation's editor tab.
  // It never shows a conversation itself, so it holds no presence lease
  // and never seeds or reports a destination.
  const chatsNavigatorProps = {
    workspaceId,
    workspaces: dmWorkspaceOptions,
    selectedNav: selectedChatsNav ?? undefined,
    readRevision: chatsReadRevision,
    threadRevision: chatsThreadRevision,
    dmReadRevision: chatsDmReadRevision,
    onOpenInTab: openChatsNavInTab,
    onOpenFileChat: openFileChatInPanel,
    onOpenPath: openPathWithHeading,
    onError: reportFailureMessage,
    mentionCandidates,
    workspaceFiles: files,
    collaboration: null,
    suspendPolling: chatsTabIsLive,
    agentSetup,
    onSetupAgent: openAgentSettings,
    userSettings: props.userSettings?.settings ?? null,
    onSaveUserSettings: saveUserSettingsFromChats,
    workspacePath: props.workspace.rootPath,
  } as const;

  // `openPath` is the file a notice named, inside the share.
  function handleMountedShare(label: string, access: ShareAccess | null, openPath?: string) {
    setOpenShare(null);
    void reloadShareMounts();
    void refreshFiles()
      .catch(() => undefined)
      .then(() => {
        if (openPath) openFile(`shared-with-me/${label}/${openPath}`);
      });
    setExplorerFolderExpanded("shared-with-me", true);
    setExplorerFolderExpanded(`shared-with-me/${label}`, true);
    // A mount is read-only whatever the grant allows. Open a share defaults
    // an Edit grant to Open separately; a person who chose Add is told how
    // to reach the access they have.
    showSuccessNotice(
      access === "edit"
        ? `Added ${label} to shared-with-me. Its files are read-only in this workspace. To use your Edit access, choose Open a share, then Open separately.`
        : `Added ${label} to shared-with-me. Its files are read-only and stay up to date.`,
    );
  }

  // The updater's state, shown under Check for updates and followed live,
  // so a download reaches "ready" without another click. The shell banner
  // sits under this overlay, so an answer reported there would never be
  // seen; a line that is always there also means the check moves nothing.
  const { updateState: storeUpdateState, acceptUpdateResult: acceptStoreUpdateResult } =
    useDesktopUpdateStateFeed();
  const [storeUpdateCheckError, setStoreUpdateCheckError] = useState<string | null>(null);
  // One request at a time: the feed says "checking" only after main answers,
  // so a second click before that would send the request twice.
  const [storeUpdateCheckPending, setStoreUpdateCheckPending] = useState(false);
  // One confirmation for every Restart: the stop state, the update notice,
  // and the update toast. Restarting closes the app, so it is asked once.
  const [restartPrompt, setRestartPrompt] = useState<"closed" | "open" | "restarting">("closed");
  const openRestartPrompt = useCallback(() => setRestartPrompt("open"), []);
  const appVersion = storeUpdateState?.currentVersion
    ? storeUpdateState.channel
      ? `${storeUpdateState.currentVersion} (${storeUpdateState.channel})`
      : storeUpdateState.currentVersion
    : null;
  // Facts a person can paste into a report. The version comes from the
  // updater's state; a bridge without it leaves the line out.
  const reportFacts = useCallback(
    (): ReadonlyArray<readonly [string, string | null | undefined]> => [
      ["Workspace", workspaceName(props.workspace)],
      ["Folder", props.workspace.rootPath],
      ["dohc", appVersion],
      ["Platform", bridge().platform],
      ["Time", new Date().toISOString()],
    ],
    [appVersion, props.workspace],
  );
  // Errors as the notice center shows them: the message, whether it can be
  // asked again, and the report Copy puts on the clipboard.
  const workspaceErrors = useMemo(
    () =>
      shellErrors.map((error) => ({
        id: error.id,
        ...(error.tone ? { tone: error.tone } : {}),
        message: error.message,
        details: errorDetails([
          [error.tone === "success" ? "Notice" : "Error", error.message],
          ...(error.details ?? []),
          ...reportFacts(),
        ]),
        atMs: error.atMs,
        canRetry: error.retry !== null,
        ...(error.action ? { actionLabel: error.action.label } : {}),
        seen: error.seen,
      })),
    [shellErrors, reportFacts],
  );
  // What Copy details copies, shown on request so a person can read what
  // they are about to paste. One string for both, so they never differ.
  const [storeDetailsOpen, setStoreDetailsOpen] = useState(false);
  // A switch leaves the other workspace's answer and disclosure behind.
  useEffect(() => {
    setStoreUpdateCheckError(null);
    setStoreDetailsOpen(false);
  }, [workspaceId]);
  // A store this build could not migrate, or one a newer build migrated, is
  // intact. Nothing in this workspace can run against it, so the workspace
  // stops here until a build that opens it. Other workspaces keep their own
  // stores.
  const storeUpdateRefusal =
    syncStatus?.engineStoreRefused != null &&
    engineStoreRefusalRecovery(syncStatus.engineStoreRefused) === "update"
      ? syncStatus.engineStoreRefused
      : null;
  const storeUpdateRequired = storeUpdateRefusal !== null;
  storeUpdateRequiredRef.current = storeUpdateRequired;
  const storeDetailFields = useMemo(
    (): ReadonlyArray<readonly [string, string | null | undefined]> => [
      ["Problem", storeUpdateRefusal && engineStoreRefusalSentence(storeUpdateRefusal)],
      ["Code", storeUpdateRefusal],
      ["Engine", syncStatus?.engineStoreRefusedDetail],
      ["Workspace id", props.workspace.workspaceId],
      ["Data store", `${props.workspace.rootPath}/.dohc/engine`],
      ...reportFacts(),
    ],
    [storeUpdateRefusal, syncStatus?.engineStoreRefusedDetail, props.workspace, reportFacts],
  );
  const storeDetailsText = useMemo(
    () => errorDetails(storeDetailFields),
    [storeDetailFields],
  );
  // Dialogs float above the stop state and could still write to the
  // stopped workspace. A stop closes them; a running workspace is unchanged.
  useEffect(() => {
    if (!storeUpdateRequired) return;
    setNewFileOpen(false);
    setNewCollectionFolder(null);
    setRecoveryWorkspaceId(null);
    setQuickOpenOpen(false);
    setPaletteOpen(false);
    setShareTarget(null);
    setOpenShare(null);
    setLiveDocumentsWorkspaceId(null);
  }, [storeUpdateRequired]);
  const checkForStoreUpdate = useCallback(async () => {
    // Workspace-scoped guard (AGENTS.md): a slow answer for workspace A must
    // never repaint workspace B. The updater feed itself is app-wide; only
    // this window's failure line is per workspace.
    const askedFor = workspaceId;
    setStoreUpdateCheckError(null);
    setStoreUpdateCheckPending(true);
    try {
      const result = await bridge().checkForUpdates();
      if (workspaceIdRef.current !== askedFor) return;
      acceptStoreUpdateResult(result.state);
    } catch {
      if (workspaceIdRef.current !== askedFor) return;
      setStoreUpdateCheckError("Could not check for updates.");
    } finally {
      setStoreUpdateCheckPending(false);
    }
  }, [acceptStoreUpdateResult, workspaceId]);
  // The live-delivery retry is main's own command, not a repaint: nothing
  // here decides that delivery recovered. Main reports that by pushing a new
  // status, so an accepted command needs no follow-up read. A refusal becomes
  // a notice offering the same command again — for the workspace that asked.
  const retryLiveDeliveryRef = useRef<() => void>(() => undefined);
  const retryLiveDelivery = useCallback(() => {
    const askedFor = workspaceIdRef.current;
    void bridge()
      .retryOwnerLiveDelivery({ workspaceId: askedFor })
      .catch((error: unknown) => {
        if (workspaceIdRef.current !== askedFor) return;
        reportShellError(
          "dohc could not retry live editing for this workspace.",
          error,
          () => {
            if (workspaceIdRef.current !== askedFor) return;
            retryLiveDeliveryRef.current();
          },
        );
      });
  }, [reportShellError]);
  retryLiveDeliveryRef.current = retryLiveDelivery;
  const retryCloudSyncCommand = useCallback(
    (askedFor: string, reason: "person" | "reconnect") =>
      bridge().retryCloudSync({ workspaceId: askedFor, reason }),
    [],
  );
  const syncFailureNotice = useSyncFailureNotice({
    workspaceId,
    failure: syncStatus === null ? undefined : (syncStatus.syncFailure ?? null),
    retryCloudSync: retryCloudSyncCommand,
    report: reportSyncFailure,
    clear: clearSyncFailure,
  });
  // A dismissed sync failure stays dismissed until it ends, across remounts.
  const dismissWorkspaceError = useCallback(
    (id: string) => {
      if (shellErrors.find((error) => error.id === id)?.kind === "cloud-sync") {
        syncFailureNotice.noteDismissed();
      }
      dismissShellError(id);
    },
    [dismissShellError, shellErrors, syncFailureNotice],
  );
  return (
    <AgentSettingsProvider settings={props.userSettings?.settings ?? null}>
    <CollectionFieldMarksProvider workspaceId={workspaceId}>
    <div
      data-testid="workspace-shell"
      // Flips to "true" only once openWorkspace has resolved — which in main
      // awaits the file watcher's initial scan (workspaceActivity.open races
      // handle.ready). The shell element itself mounts immediately, so a test
      // that writes a file right after the shell appears would otherwise race
      // chokidar's ignoreInitial scan and have the write silently swallowed.
      // Waiting on this attribute is the deterministic "watcher is live" gate.
      data-ready={workspaceIsReady ? "true" : "false"}
      className="app-chrome relative flex h-screen flex-col bg-bg text-ink"
    >
      <ShellTitlebar
        workspace={props.workspace}
        workspaces={props.workspaces}
        onSwitchWorkspace={props.onSwitchWorkspace}
        onManageWorkspaces={props.onManageWorkspaces}
        manageWorkspaces={manageWorkspaces}
        setOpenShare={setOpenShare}
        setQuickOpenOpen={setQuickOpenOpen}
        syncStatus={syncStatus}
        showWorkbenchMenu={showWorkbenchMenu}
        agentActive={agentActive}
        wb={wb}
        toggleSidePanel={toggleSidePanel}
        mutateWb={mutateWb}
      />
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
              : shareViewDamaged
                ? "dohc can't read what this share grants. Open the share again to restore it."
                : shareViewDocumentsWritable
                  ? `Shared view from ${shareGranterName}. Markdown edits save to the live host. Other file changes need their acceptance.`
                  : shareViewHasIndependentChat
                    ? `Shared view from ${shareGranterName}. Files and Chats are read-only here. Ask ${shareGranterName} where to continue the conversation.`
                    : shareView.access === "comment"
                      ? `Shared view from ${shareGranterName}. Files are read-only here. Continue commenting in the browser where you opened the link.`
                    : `Shared view from ${shareGranterName} — read-only. Ask ${shareView.granterEmail ?? "them"} for changes.`}
          </span>
          {shareExcludedPaths.length > 0 ? (
            <span
              data-testid="shared-view-excluded"
              title={shareExcludedPaths.map((entry) => entry.path).join("\n")}
              className="flex min-w-0 max-w-[280px] shrink items-center gap-1.5 truncate rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
            >
              {shareUnjournalableNotice(shareExcludedPaths)}
            </span>
          ) : null}
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
                            // since this render is not acknowledged by this
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
          {/* Changes already sent, and the way to take them back (#646
              PR3a). Deliberately not behind the level: a granter can narrow
              the share while changes wait, and a reverse path a downgrade
              removes is not a reverse path — it would strand work in front of
              someone who may never answer it. The relay agrees; withdraw asks
              for membership, not for edit. */}
          <>
              {myShareChange && myShareChange.state !== "withdrawn" ? (
                <span
                  data-testid="share-changes-state"
                  data-state={myShareChange.state}
                  className="flex min-w-0 items-center gap-1.5 text-[11px]"
                >
                  <span className="min-w-0 truncate">
                    {myShareChange.state === "open"
                      ? `Sent to ${shareGranterName} for review.`
                      : myShareChange.state === "accepted"
                        ? `${shareGranterName} accepted your changes.`
                        : // Declined owes a Next, and this one works right
                          // here: the editor and the send control both stay.
                          `${shareGranterName} declined your changes. Your copy still has them. Edit again and send new changes.`}
                  </span>
                  {myShareChange.state === "open" ? (
                    <>
                      <span
                        data-testid="share-changes-count"
                        className="shrink-0 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted"
                      >
                        {myShareChange.files === 1
                          ? "1 file"
                          : `${myShareChange.files} files`}
                      </span>
                      {/* Submitting is reversible, so the reverse path is
                          visible for as long as it exists. */}
                      <button
                        type="button"
                        data-testid="share-changes-withdraw"
                        disabled={shareChangesSubmitting}
                        onClick={() =>
                          void withdrawShareChanges(myShareChange.proposalId)
                        }
                        className="shrink-0 rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-muted hover:text-ink disabled:opacity-50"
                      >
                        Withdraw
                      </button>
                    </>
                  ) : null}
                </span>
              ) : null}
          </>
          {/* Sending. Edit level only, and only while the share is live: an
              ended or damaged grant carries no way to send, so offering one
              would be an affordance the grant does not have. */}
          {shareViewDocumentsWritable ? (
            <>
              {shareChangesEmpty ? (
                <span
                  data-testid="share-changes-empty"
                  className="min-w-0 truncate text-[11px]"
                >
                  You have no changes to send yet.
                </span>
              ) : null}
              {/* What the submit did not take. Both are things the recipient
                  would otherwise discover by their work simply not arriving. */}
              {shareChangesSkipped !== null ? (
                <span
                  data-testid="share-changes-skipped"
                  data-skipped={shareChangesSkipped.outsideShare || undefined}
                  data-more-pending={shareChangesSkipped.morePending || undefined}
                  className="min-w-0 truncate text-[11px] text-warning"
                >
                  {/* Both facts, when both are true. An either/or line drops
                      "more pending" exactly when a submit was largest — the
                      case the count exists to report. */}
                  {[
                    shareChangesSkipped.outsideShare === 0
                      ? null
                      : shareChangesSkipped.outsideShare === 1
                        ? "1 file wasn't sent — it's not part of this share."
                        : `${shareChangesSkipped.outsideShare} files weren't sent — they're not part of this share.`,
                    shareChangesSkipped.morePending
                      ? "More changes are waiting. Send again to send the rest."
                      : null,
                  ]
                    .filter((line) => line !== null)
                    .join(" ")}
                </span>
              ) : null}
              <button
                type="button"
                data-testid="share-changes-send"
                disabled={shareChangesSubmitting}
                onClick={() => void sendShareChanges()}
                className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-muted hover:text-ink disabled:opacity-50"
              >
                <Send size={11} aria-hidden />
                {shareChangesSubmitting ? "Sending…" : "Send changes"}
              </button>
            </>
          ) : null}
          {!shareViewEnded && !shareViewDamaged ? (
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
          views={railViews}
          activeView={wb.activeView}
          pinnedApps={pinnedApps}
          onPinnedAppMenu={(appRoot) => void showPinnedAppMenu(appRoot)}
          sidebarVisible={wb.sidebarVisible}
          hasConflict={syncStatus?.state === "conflict"}
          searchResultCount={
            search.model.totalMatches > 0 ? search.model.totalMatches : undefined
          }
          onSelectView={(view) => mutateWb((state) => setView(state, view))}
          onOpenCloud={() => setCloudOpen(true)}
          onOpenSettings={() => openSettings()}
          viewsDisabled={!workspaceIsReady || storeUpdateRequired}
          notices={
            <NoticeCenter
              workspaceId={workspaceId}
              syncStatus={syncStatus}
              agentActive={agentActive}
              conflictSummaries={conflictSummaries}
              onOpenHistory={openHistoryView}
              onOpenConflicts={() => setConflictReviewOpen(true)}
              onRefreshShareView={() => void refreshShareView()}
              shareChangeNotices={shareChangeNotices}
              onReviewShareChanges={setReviewProposalId}
              onOpenSettings={() => openSettings()}
              onRebuildEngineStore={(returnFocus) => {
                const refusal = syncStatus?.engineStoreRefused;
                if (!refusal || engineStoreRefusalRecovery(refusal) !== "rebuild") return;
                engineRebuildReturnFocusRef.current = returnFocus;
                setEngineRebuild({ phase: "confirm", refusal });
              }}
              onRestartToUpdate={openRestartPrompt}
              workspaceErrors={workspaceErrors}
              onRetryWorkspaceError={retryShellError}
              onWorkspaceErrorAction={runShellErrorAction}
              onHideWorkspaceError={hideShellError}
              onDismissWorkspaceError={dismissWorkspaceError}
              onRetryLiveDelivery={retryLiveDelivery}
              {...(isShareView
                ? {}
                : {
                    onOpenLiveDocuments: () => setLiveDocumentsWorkspaceId(workspaceId),
                  })}
              {...crashReportNotice}
              automationHolds={automationHolds}
              onAllowAutomationHold={allowAutomationHold}
              automationHoldsUnreadable={automationHoldsUnreadable}
              onResetAutomationHolds={resetAutomationHolds}
              onRevealAutomationHolds={revealAutomationHolds}
              {...sentNoticeProps}
              automationStops={automationStops}
              onDismissAutomationStops={dismissAutomationStops}
            />
          }
        />
        <div
          data-testid="workspace-workbench"
          inert={!workspaceIsReady || storeUpdateRequired ? true : undefined}
          className="flex min-w-0 flex-1"
        >

        {/* Side panel (Ctrl+B / activity bar toggle; hidden ⇒ unmounted) */}
        {wb.sidebarVisible ? (
          <ShellSidePanel
            wb={wb}
            mutateWb={mutateWb}
            sidePanelTitle={sidePanelTitle}
            openHistoryTab={openHistoryTab}
            openGraphTab={openGraphTab}
            refreshSites={refreshSites}
            explorerView={explorerView}
            search={search}
            openSearchResult={openSearchResult}
            workspaceId={workspaceId}
            activeDocumentPath={activeDocumentPath}
            graphKey={graphKey}
            openPathWithHeading={openPathWithHeading}
            openGraphChatThread={openGraphChatThread}
            captureAvailable={captureAvailable}
            pinnedRoots={pinnedRoots}
            setAppPinned={setAppPinned}
            listingsSettled={listingsSettled}
            createFirstApp={createFirstApp}
            shareView={shareView}
            historyTimeline={historyTimeline}
            selectedAppRoot={selectedAppRoot}
            openAppTab={openAppTab}
            reportShellError={reportShellError}
            setShareTarget={setShareTarget}
          />
        ) : null}

        {/* Editor area: workspace-wide version controls above independently
            active editor groups. Each group can host any tab surface. */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {captureAvailable ? (
            <div className="flex h-9 shrink-0 items-center justify-end border-b border-line bg-panel-2 px-1.5">
                <VersionMenu
                  workspaceId={workspaceId}
                  activeTabDirty={anyTabDirty}
                  beginLineageOperation={beginLineageOperation}
                  onOpenCompare={openVersionCompareTab}
                  onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
                  onError={reportFailureMessage}
                  {...(shareView
                    ? {}
                    : {
                        onShareVersion: (version: { id: string; name: string }) =>
                          setShareTarget({
                            kind: "version",
                            versionId: version.id,
                            versionName: version.name,
                          }),
                      })}
                  // versionEpoch bumps whenever any surface changed version
                  // state (the 0N-2 review card switches back to Main outside
                  // this menu) — the selector re-reads instead of going stale.
                  refreshKey={versionEpoch}
                />
            </div>
          ) : null}
          {/* "Try it in a version" (PR 0N-2): honest run status while the
              agent works, then the review card when the run ends. Never a
              shared view (tryState never exists there). */}
          {captureAvailable && tryState?.status === "running" ? (
            <TryInVersionBanner task={tryState.task} versionName={tryState.versionName} />
          ) : null}
          {captureAvailable && tryState?.status === "review" ? (
            <TryInVersionReviewCard
              workspaceId={workspaceId}
              state={tryState}
              activeTabDirty={anyTabDirty}
              beginLineageOperation={beginLineageOperation}
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
              const groupSiteRoot = parseSiteTabPath(tabPath);
              const groupCollectionPath = parseCollectionTabPath(tabPath);
              const groupDataCollection = parseTransactionalCollectionTabPath(tabPath);
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
                      tabLabels={tabLabels}
                      recoveryPaths={recoveryPaths}
                      groupNumber={groupIndex + 1}
                      onActivate={activateEditorTab}
                      onClose={closeFileTab}
                      onContextMenu={showTabContextMenu}
                      onMove={moveFileTab}
                      onMoveToGroup={moveFileTabToGroup}
                      onCreateGroupRight={openEditorGroupRight}
                      {...(wb.editorGroups.length > 1
                        ? { onCloseGroup: closeGroupAfterFlush }
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
                  activePath={activeDocumentPath}
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
              // A persisted moment-diff tab reads the capture capability,
              // like every other surface main's capture serves. Gating it on
              // the share fact alone left the failed-build cause open: the
              // page still mounted, called readEngineMoment and fell into its
              // own error state.
              !captureAvailable ? (
                isShareView ? (
                  // A persisted moment-diff tab on a shared view.
                  // Virtual tabs survive restore, so this tab outlives the
                  // History surface that opened it — and that surface no
                  // longer exists here. The page would ask main for a
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
                  // shell has done proves anything about what main recorded,
                  // so this window gets a load state, not a claim.
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
                  onBeforeRestore={beginLineageOperation}
                  onOpenFile={openFile}
                  onPathResolved={rememberMomentDiffPath}
                  registerActiveUndo={editorCallbacks?.registerActiveUndo ?? (() => undefined)}
                  onRestored={refreshAfterHistoryRestore}
                  onStopAndRestore={stopAndRestore.open}
                />
              )
            ) : isVersionCompareTabPath(tabPath) ? (
              // A persisted compare tab reads the version capability, like
              // every other version entry point. Gating it on the share fact
              // alone left the whole #620 cause open: on a workspace whose
              // capture build failed the page still mounted, called
              // listWorkspaceVersions and compareWorkspaceVersions, and said
              // "Could not compare with Main."
              !captureAvailable ? (
                isShareView ? (
                  // A persisted compare tab on a shared view. The page
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
                  // shell has done proves anything about what main recorded,
                  // so this window gets a load state, not a claim.
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
                  // Remount per version and per state change so the diff
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
                    key={`${workspaceId}:${tabPath}:${chatEditors.get(tabPath).generation}:${chatEditors.get(tabPath).revision}`}
                    {...chatsViewProps}
                    onNavChange={chatEditors.get(tabPath).onNavChange}
                    onNavCommand={chatEditors.get(tabPath).onNavCommand}
                    onDraftsChange={chatEditors.get(tabPath).onDraftsChange}
                    initialNav={chatEditors.get(tabPath).nav}
                    initialDrafts={chatEditors.get(tabPath).drafts}
                    editorTabPath={tabPath}
                    onOpenInTab={openChatsNavInTab}
                    variant="page"
                  />
                </Suspense>
              ) : isShareView ? (
                // A persisted Chats tab on a shared view. The
                // neighbouring line blamed the Settings flag, and a share
                // never touched it. #646 PR2 changed what is true here: a
                // shared view has chat now, per file, and this tab is the
                // workspace-wide listing it still does not get — so the copy
                // states the capability the reader does have and points at
                // the surface that answers.
                <div
                  data-testid="chats-page-share-view"
                  className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                >
                  A shared view lists no chats. Open a shared file to chat
                  about it.
                </div>
              ) : !captureDecided ? (
                // Main has not decided yet — a load state, not a claim.
                <PanelLoading label="Chats" />
              ) : (
                // Main decided, and the answer was no capture: the engine flag
                // is off, the settings file is unreadable, or the capture
                // build failed. The line that used to stand here blamed the
                // flag for all three.
                <div
                  data-testid="chats-page-off"
                  className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
                >
                  {chatsOffCopy(syncStatus)}
                </div>
              )
            ) : isSiteTabPath(tabPath) ? (
              groupSiteRoot ? (
                <Suspense fallback={<PanelLoading label="app" />}>
                  <LazySitePreviewPage
                    workspaceId={workspaceId}
                    reportError={reportShellError}
                    onOpenApp={openAppTab}
                    siteRoot={groupSiteRoot}
                    onShowSource={() => showPathInExplorer(groupSiteRoot, true)}
                    sharedView={!!shareView}
                    onShareSite={(target) =>
                      setShareTarget({ kind: "paths", paths: target.paths, label: target.label })
                    }
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
            ) : groupDataCollection ? (
              <Suspense fallback={<PanelLoading label="collection" />}>
                <LazyTransactionalCollection key={`${workspaceId}:${tabPath}`} workspaceId={workspaceId}
                  datasetId={groupDataCollection.datasetId} tableId={groupDataCollection.tableId}
                  onOpenFile={(path) => openFile(path)}
                  onOpenScheduleSettings={() => openSettings("advanced")}
                  owner={!isShareView}
                  onLifecycleChanged={() => { void refreshDatasets().catch(error => reportShellError("Could not refresh Collections.", error)); }}
                  onError={collectionReports.onError}
                  onNotice={collectionReports.onNotice}
                  onFormCreated={appRoot => {
                    void refreshFiles().catch(error => reportShellError("Could not refresh workspace files.", error));
                    openVirtualTab(siteTabPath(appRoot));
                  }} />
              </Suspense>
            ) : isCollectionTabPath(tabPath) ? (
              groupCollectionPath ? (
                <Suspense fallback={<PanelLoading label="collection" />}>
                  <LazyCollectionPage
                    key={`${tabPath}:${collectionLineage}`}
                    workspaceId={workspaceId}
                    collectionPath={groupCollectionPath}
                    activeViewName={wb.collectionViews[groupCollectionPath] ?? null}
                    onActiveViewChange={(viewName) =>
                      mutateWb((state) =>
                        setCollectionActiveView(state, groupCollectionPath, viewName),
                      )
                    }
                    onNewRecord={createCollectionRecord}
                    onOpenRecord={openFile}
                    onOpenFile={(path) => openFile(path)}
                    onOpenScheduleSettings={() => openSettings("advanced")}
                    onError={collectionReports.onError}
                    onNotice={collectionReports.onNotice}
                    automationFocus={
                      automationFocus?.collectionPath === groupCollectionPath ? automationFocus : null
                    }
                    onAutomationFocused={clearAutomationFocus}
                  />
                </Suspense>
              ) : (
                // A persisted tab whose path names no collection folder
                // (hand-edited or truncated state). Closeable, never a crash.
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <span className="text-sm text-ink">
                    dohc could not open this collection
                  </span>
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
            ) : tabPath && tab && editorCallbacks ? (
              <FileInspector
                key={tabPath}
                workspaceId={workspaceId}
                path={tabPath}
                fileOpenStartMark={fileOpenStartMark(editorGroup.id)}
                // History growth, version switches, and share-mount pulls all
                // re-read the open file (every counter only ever increases).
                refreshKey={historyRefreshCounter + versionEpoch + mountContentEpoch}
                // G2-C-3: the engine editor re-binds to the new version's Y.Doc
                // lineage only on an active-version change — versionEpoch alone,
                // not history growth (which must not churn the live session).
                engineVersionKey={versionEpoch}
                onOpenPath={openPathWithHeading}
                onOpenChatMention={openChatMention}
                // The linked-mentions panel asks main for chat mentions, which
                // is a Chats call like any other — same gate as the
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
                surfaceKey={editorGroup.id}
                onSurfaceReady={onRestoredFileSurfaceReady}
                registerDraftFlush={editorCallbacks.registerDraftFlush}
                registerSourceToggle={editorCallbacks.registerSourceToggle}
                autoFocus={wb.activeEditorGroup === editorGroup.id}
                knownMarkdownFiles={markdownWikilinkFiles}
                onButtonError={reportShellError}
                onButtonNotice={showSuccessNotice}
                readOnly={
                  (!!shareView && !shareViewDocumentsWritable) ||
                  isMountedSharePath(tabPath)
                }
                {...(shareView || isMountedSharePath(tabPath)
                  ? {}
                  : { onSharePath })}
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
                    className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-hover hover:text-ink"
                  >
                    Ctrl N · new file
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-hover hover:text-ink"
                  >
                    Ctrl K · commands
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickOpenOpen(true)}
                    className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-hover hover:text-ink"
                  >
                    Ctrl P · go to
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

        {/* Chats panel — the right-hand secondary sidebar (every
            workspace; shared views with their file tab only). Hidden
            entirely while collapsed; the titlebar Chats button, Ctrl+Alt+B,
            or the toggle-chats command bring it back. History lives in the
            left History view and the history tab — never here. */}
        {wb.chatsVisible ? (
          <ShellChatsPanel
            wb={wb}
            mutateWb={mutateWb}
            isShareView={isShareView}
            chatsPanelActiveTab={chatsPanelActiveTab}
            setChatsPanelTab={setChatsPanelTab}
            captureAvailable={captureAvailable}
            captureDecided={captureDecided}
            focusedTabPath={focusedTabPath}
            openChatsTab={openChatsTab}
            syncStatus={syncStatus}
            workspaceId={workspaceId}
            activeDocumentPath={activeDocumentPath}
            shareView={shareView}
            searchChatTarget={searchChatTarget}
            setSearchChatTarget={setSearchChatTarget}
            openPathWithHeading={openPathWithHeading}
            onChatsThreadRead={onChatsThreadRead}
            reportFailureMessage={reportFailureMessage}
            chatsNavigatorProps={chatsNavigatorProps}
          />
        ) : null}
        </div>
      </div>
      {storeUpdateRefusal !== null ? (
        <div
          data-testid="workspace-update-required"
          role="alert"
          className="absolute left-12 right-0 bottom-0 top-10 z-10 grid grid-rows-[1fr_auto_1fr] justify-items-center overflow-y-auto bg-bg px-6 text-center"
        >
          {/* The middle row holds what everyone reads. It is centered by the
              two equal rows around it, so opening the technical details in
              the bottom row moves nothing above. */}
          <div className="row-start-2 flex flex-col items-center gap-5">
          <div className="flex max-w-md select-text cursor-text flex-col items-center gap-3">
            <p className="dohc-section-label m-0 text-danger">Workspace stopped</p>
            <h2 className="m-0 text-xl font-semibold leading-tight tracking-tight text-ink">
              This version of dohc can't open this workspace
            </h2>
            <div className="space-y-1">
              <p className="m-0 text-[13px] leading-relaxed text-muted">
                {engineStoreRefusalSentence(storeUpdateRefusal)} Your files are
                unchanged.
              </p>
              <p className="m-0 text-[13px] leading-relaxed text-muted">
                Update dohc to continue, or keep working in another workspace.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <PrimaryButton
              autoFocus
              disabled={
                storeUpdateCheckPending ||
                storeUpdateState?.status === "checking" ||
                storeUpdateState?.canCheck === false
              }
              onClick={() => void checkForStoreUpdate()}
            >
              {storeUpdateCheckPending || storeUpdateState?.status === "checking"
                ? "Checking"
                : "Check for updates"}
            </PrimaryButton>
            {storeUpdateState?.canInstall ? (
              <SecondaryButton onClick={openRestartPrompt}>
                <RefreshCw size={12} aria-hidden />
                Restart to update
              </SecondaryButton>
            ) : null}
            {props.onManageWorkspaces ? (
              <SecondaryButton onClick={manageWorkspaces}>
                Open another workspace
              </SecondaryButton>
            ) : null}
          </div>
          <p
            data-testid="workspace-update-check-result"
            role="status"
            className="m-0 -mt-2 min-h-4 max-w-sm select-text cursor-text text-[12px] text-subtle"
          >
            {storeUpdateCheckError ?? storeUpdateState?.message}
          </p>
          <button
            type="button"
            aria-expanded={storeDetailsOpen}
            onClick={() => setStoreDetailsOpen((open) => !open)}
            className="flex items-center gap-1 rounded text-[12px] text-subtle transition-colors hover:text-ink"
          >
            <ChevronRight
              size={12}
              strokeWidth={1.9}
              aria-hidden
              className={`transition-transform duration-100 ${storeDetailsOpen ? "rotate-90" : ""}`}
            />
            {storeDetailsOpen ? "Hide technical details" : "Show technical details"}
          </button>
          </div>
          <div className="row-start-3 flex w-full max-w-md flex-col items-center gap-4 self-start pt-5">
          {storeDetailsOpen ? (
            <section
              data-testid="workspace-update-details"
              aria-label="Technical details"
              className="w-full max-w-md rounded-lg border border-line bg-panel text-left"
            >
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                <span className="dohc-section-label">Technical details</span>
                <CopyDetailsButton
                  data-testid="workspace-update-copy-details"
                  label="Copy"
                  iconOnly
                  details={() => storeDetailsText}
                  onError={(error) =>
                    reportShellError("Could not copy the details.", error)
                  }
                />
              </div>
              <dl className="m-0 grid select-text cursor-text grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-3 py-2.5 text-[12px] leading-snug">
                {storeDetailFields.map(([label, value]) =>
                  value ? (
                    <Fragment key={label}>
                      <dt className="text-subtle">{label}</dt>
                      <dd className="m-0 break-words text-ink">{value}</dd>
                    </Fragment>
                  ) : null,
                )}
              </dl>
            </section>
          ) : null}
          </div>
        </div>
      ) : !workspaceIsReady && workspaceOpenFailure ? (
        <div
          data-testid="workspace-open-failed"
          role="alert"
          className="absolute left-12 right-0 bottom-0 top-10 z-10 flex flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        >
          <div className="max-w-md select-text cursor-text space-y-1.5">
            <p className="text-sm font-medium text-ink">Couldn’t open this workspace</p>
            <p className="text-xs text-muted">{workspaceOpenFailure.message}</p>
            <p className="text-xs text-muted">Choose another workspace from the title bar.</p>
          </div>
          <div className="flex items-center gap-2">
            <PrimaryButton
              onClick={() => {
                setWorkspaceOpenFailedFor(null);
                setWorkspaceOpenAttempt((attempt) => attempt + 1);
              }}
            >
              Try again
            </PrimaryButton>
            <CopyDetailsButton
              details={() =>
                errorDetails([
                  ["Error", "Couldn't open this workspace"],
                  ["Detail", workspaceOpenFailure.message],
                  ["Cause", workspaceOpenFailure.cause],
                  ...reportFacts(),
                ])
              }
            />
          </div>
        </div>
      ) : !workspaceIsReady ? (
        <div
          data-testid="workspace-preparing"
          role="status"
          aria-live="polite"
          className="absolute left-12 right-0 bottom-0 top-10 z-10 flex flex-col items-center justify-center gap-2 bg-bg px-6 text-center"
        >
          <RefreshCw size={16} aria-hidden className="animate-spin text-subtle" />
          <p className="text-sm font-medium text-ink">Preparing this workspace</p>
          <p className="text-xs text-muted">
            dohc is checking your existing files before editing starts.
          </p>
        </div>
      ) : null}

      {restartPrompt !== "closed" ? (
        <Overlay
          onClose={() => {
            if (restartPrompt === "open") setRestartPrompt("closed");
          }}
          panelProps={{
            "data-testid": "restart-to-update-dialog",
            role: "dialog",
            "aria-modal": true,
            "aria-labelledby": "restart-to-update-title",
          }}
        >
          <div className="dohc-elevated flex w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-panel">
            <div className="p-4">
              <p id="restart-to-update-title" className="m-0 text-sm text-ink">
                Restart dohc to apply the update?
              </p>
              <p className="mb-0 mt-2 text-xs text-muted">
                {storeUpdateState?.version
                  ? `Update ${storeUpdateState.version} is downloaded. `
                  : ""}
                dohc closes and opens again on the new version. Your files are
                saved.
              </p>
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
              <SecondaryButton
                autoFocus
                disabled={restartPrompt === "restarting"}
                onClick={() => setRestartPrompt("closed")}
              >
                Not now
              </SecondaryButton>
              <PrimaryButton
                data-testid="restart-to-update-confirm"
                disabled={restartPrompt === "restarting"}
                onClick={() => {
                  setRestartPrompt("restarting");
                  void installDesktopUpdate().finally(() =>
                    setRestartPrompt("closed"),
                  );
                }}
              >
                {restartPrompt === "restarting" ? "Restarting" : "Restart now"}
              </PrimaryButton>
            </div>
          </div>
        </Overlay>
      ) : null}

      {sentNoticeRetryDialog}

      {engineRebuild ? (
        <Overlay
          onClose={() => {
            if (engineRebuild.phase !== "moving") setEngineRebuild(null);
          }}
          panelProps={{
            "data-testid": "engine-rebuild-dialog",
            role: "dialog",
            "aria-modal": true,
            "aria-labelledby": "engine-rebuild-title",
          }}
        >
          <div className="dohc-elevated flex w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-panel">
            <div className="p-4">
              {engineRebuild.phase === "complete" &&
              engineRebuild.result.outcome === "moved" ? (
                <>
                  <p
                    id="engine-rebuild-title"
                    className="m-0 text-sm text-ink"
                  >
                    Data store moved
                  </p>
                  <p className="mb-0 mt-2 text-xs text-muted">
                    The old data store is at{" "}
                    <span className="font-mono">{ENGINE_STORE_BACKUP_DIR}</span>.
                    {engineRebuild.result.reopenFailed
                      ? ` ${engineRebuild.result.reopenFailed}`
                      : " dohc is rebuilding history from your files."}
                  </p>
                </>
              ) : engineRebuild.phase === "complete" ? (
                <>
                  <p
                    id="engine-rebuild-title"
                    className="m-0 text-sm text-ink"
                  >
                    dohc did not move the data store
                  </p>
                  <p className="mb-0 mt-2 text-xs text-muted">
                    A file or folder already exists at{" "}
                    <span className="font-mono">{ENGINE_STORE_BACKUP_DIR}</span>.
                    Move it away, then try again.
                  </p>
                  {engineRebuild.result.reopenFailed ? (
                    <p className="mb-0 mt-2 text-xs text-muted">
                      {engineRebuild.result.reopenFailed}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p
                    id="engine-rebuild-title"
                    className="m-0 text-sm text-ink"
                  >
                    Move the old data store aside and rebuild?
                  </p>
                  <p className="mb-0 mt-2 text-xs text-muted">
                    {engineStoreRefusalSentence(engineRebuild.refusal)} dohc
                    moves it to{" "}
                    <span className="font-mono">{ENGINE_STORE_BACKUP_DIR}</span>{" "}
                    and rebuilds history from your files.
                  </p>
                  <p className="mb-0 mt-2 text-xs text-muted">
                    The old data store stays in the backup location. History
                    and chats stored only there will not appear in the rebuilt
                    workspace. Your workspace files stay in place.
                  </p>
                </>
              )}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
              {engineRebuild.phase === "confirm" ||
              engineRebuild.phase === "moving" ? (
                <>
                  <SecondaryButton
                    autoFocus
                    disabled={engineRebuild.phase === "moving"}
                    onClick={() => setEngineRebuild(null)}
                  >
                    Cancel
                  </SecondaryButton>
                  <PrimaryButton
                    data-testid="engine-rebuild-confirm"
                    disabled={engineRebuild.phase === "moving"}
                    onClick={() =>
                      void confirmEngineRebuild(engineRebuild.refusal)
                    }
                  >
                    {engineRebuild.phase === "moving"
                      ? "Moving"
                      : "Move and rebuild"}
                  </PrimaryButton>
                </>
              ) : (
                // Force a mount so autoFocus runs instead of reusing Cancel.
                <SecondaryButton
                  key="engine-rebuild-result"
                  autoFocus
                  onClick={() => setEngineRebuild(null)}
                >
                  {engineRebuild.result.outcome === "moved"
                    ? "Done"
                    : "Close"}
                </SecondaryButton>
              )}
            </div>
          </div>
        </Overlay>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {quickOpenOpen ? (
        <QuickOpenPalette
          files={files}
          recent={wb.recentFiles}
          pinned={wb.pinned}
          onOpenPath={openFile}
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
      {recoveryWorkspaceId === workspaceId && !isShareView && props.workspace.mode !== "cloud-only" && workspaceIsReady ? (
        <ConnectedCollectionRecoveryRestore workspaceId={workspaceId} onError={reportShellError}
          onClose={() => setRecoveryWorkspaceId(null)}
          onRestored={(datasetId, tableId) => {
            if (workspaceIdRef.current !== workspaceId) return;
            openVirtualTab(transactionalCollectionTabPath(datasetId, tableId));
            showSuccessNotice("Restored the Collection. Sharing stays off.");
            void refreshDatasets().catch(error => {
              if (workspaceIdRef.current === workspaceId) reportShellError("Could not refresh Collections.", error);
            });
            void refreshFiles().catch(error => {
              if (workspaceIdRef.current === workspaceId) reportShellError("Could not refresh workspace files.", error);
            });
          }} />
      ) : null}
      {newCollectionFolder !== null && (!isShareView || shareViewEditsCollections) ? (
        <NewCollectionDialog
          workspaceId={props.workspace.workspaceId}
          documentsOnly={isShareView}
          {...(newCollectionFolder !== ""
            ? { initialFolder: newCollectionFolder }
            : {})}
          onClose={() => setNewCollectionFolder(null)}
          onError={reportShellError}
          onCreated={(ref) => {
            setNewCollectionFolder(null);
            if (ref.kind === "transactional") {
              void refreshDatasets().catch(error => reportShellError("Could not read Collections.", error));
              void refreshFiles().catch(error => reportShellError("Could not refresh workspace files.", error));
              openVirtualTab(transactionalCollectionTabPath(ref.datasetId, ref.tableId));
              return;
            }
            const path = ref.path;
            // Reveal the new collection folder in the tree and open its
            // views. The engine adopts the folder from the schema write;
            // refreshCollections routes Explorer clicks to the tab.
            mutateWb((state) =>
              ancestorDirs(path).reduce(
                (acc, dir) => setFolderExpanded(acc, dir, true),
                state,
              ),
            );
            void refreshCollections();
            void refreshFiles().catch((error) =>
              reportShellError("Could not refresh workspace files.", error),
            );
            openCollectionTab(path);
          }}
        />
      ) : null}
      {cloudOpen ? (
        <Overlay
          onClose={() => {
            setCloudOpen(false);
            setCloudRetryServerUrl("");
            // A sign-in/out inside the dialog changes the relay session —
            // refresh so Chats presence lights up (or goes dormant) at once.
            refreshCloudStatus();
          }}
        >
          <CloudLogin
            workspaceId={workspaceId}
            onConnected={refreshCloudStatus}
            onConnectionError={reportConnectionError}
            initialServerUrl={cloudRetryServerUrl}
          />
        </Overlay>
      ) : null}
      {conflictReviewOpen ? (
        <ConflictReviewDialog
          workspaceId={workspaceId}
          beginLineageOperation={beginLineageOperation}
          onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
          onClose={() => setConflictReviewOpen(false)}
        />
      ) : null}
      {stopAndRestore.session ? (
        <StopAndRestoreDialog
          key={stopAndRestore.session.key}
          workspaceId={workspaceId}
          person={stopAndRestore.session.person}
          start={stopAndRestore.session.start}
          receipts={stopAndRestore.receipts}
          onRetry={stopAndRestore.retry}
          onClose={stopAndRestore.close}
          onBeforeRestore={beginLineageOperation}
          onRestored={refreshAfterHistoryRestore}
          onOpenFile={(path) => {
            stopAndRestore.close();
            openFile(path);
          }}
          onError={reportShellError}
        />
      ) : null}
      {reviewProposalId ? (
        <ProposalReviewDialog
          workspaceId={workspaceId}
          proposalId={reviewProposalId}
          onSettled={() => void reloadShareProposals().catch(() => undefined)}
          onClose={() => setReviewProposalId(null)}
        />
      ) : null}
      {settingsSection ? (
        <Overlay onClose={closeSettings}>
          <LazyDesktopSettings
            onError={reportFailureMessage}
            onWorkspaceSettingsRead={onWorkspaceSettingsRead}
            workspaceId={workspaceId}
            workspacePath={props.workspace.rootPath}
            sharedView={isShareView}
            // Main's own decision, not the renderer's settings read:
            // only main knows whether a recorder exists for this session, and
            // a failed capture build leaves none.
            sessionRecorderOn={
              syncStatus ? !statusSaysNoRecorder(syncStatus) : undefined
            }
            initialSection={settingsSection}
            onClose={closeSettings}
            onAgentActiveChange={onSettingsAgentActiveChange}
            onWorkspaceFilesChanged={onSettingsFilesChanged}
            onOpenCloud={() => {
              closeSettings();
              setCloudOpen(true);
            }}
            {...(liveDocumentsAvailable
              ? {
                  onOpenLiveDocuments: () => {
                    closeSettings();
                    setLiveDocumentsWorkspaceId(workspaceId);
                  },
                }
              : {})}
          />
        </Overlay>
      ) : null}
      {liveDocumentsWorkspaceId === workspaceId && !isShareView ? (
        <LiveDocumentsDialog
          workspaceId={workspaceId}
          load={loadLiveDocuments}
          stop={stopLiveDocument}
          resume={resumeLiveDocument}
          loadRefusals={loadLiveRefusals}
          retryRefusal={retryLiveShare}
          onError={reportLiveDocumentsError}
          onClose={() => setLiveDocumentsWorkspaceId(null)}
        />
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
      {handoffStatus.status !== "idle" ? (
        <Overlay onClose={() => props.onDismissShareHandoff?.()}>
          <ShareHandoffSurface
            status={handoffStatus}
            onWorkspaceReady={props.onSwitchWorkspace}
            onBack={() => props.onDismissShareHandoff?.()}
            onOpened={() => props.onShareHandoffOpened?.()}
            onConnectionError={reportConnectionError}
            {...(shareView
              ? {}
              : {
                  mountInto: {
                    workspaceId,
                    onMounted: handleMountedShare,
                  },
                })}
          />
        </Overlay>
      ) : openShare ? (
        <Overlay onClose={() => setOpenShare(null)}>
          <OpenSharedView
            key={openShare === "blank" ? "blank" : openShare.resolvedShare.shareId}
            {...(openShare === "blank"
              ? {}
              : {
                  resolvedShare: openShare.resolvedShare,
                  liveEditing: openShare.liveEditing,
                })}
            onWorkspaceReady={(workspace) => {
              setOpenShare(null);
              props.onSwitchWorkspace(workspace, openSharePath);
            }}
            onBack={() => setOpenShare(null)}
            onConnectionError={reportConnectionError}
            {...(shareView
              ? {}
              : {
                  mountInto: {
                    workspaceId,
                    onMounted: (label: string, access: ShareAccess | null) => handleMountedShare(label, access, openSharePath),
                  },
                })}
          />
        </Overlay>
      ) : null}
      <ExternalLinkConfirm workspaceId={workspaceId} />
    </div>
    </CollectionFieldMarksProvider>
    </AgentSettingsProvider>
  );
}
