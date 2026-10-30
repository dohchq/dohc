import type { GraphNode } from "./workbench/graphData";
import { useTypingRecoveryNotices } from "./shell/useTypingRecoveryNotices";
import { isRefusalNoticeKind } from "../notices/refusalNoticeKind";
import { useFolderAppOffers } from "./offers/useFolderAppOffers";
import { withClosedEngineDocSession } from "./collab/engineDocLease";
import { CreationPartialError } from "@dohc/cli/creation";
import {shareSenderLabel} from "@dohc/security-contract/share-labels";
import { AgentSettingsProvider } from "./workbench/AgentBadge";
import { AgentColorContext, saveAgentColor } from "./workbench/AgentColorPicker";
import { EngineMomentDiffPage } from "./workbench/EngineMomentDiffPage";
import { StopAndRestoreDialog, useStopAndRestore } from "./StopAndRestoreDialog";
import { useRecordHistory } from "./collections/useRecordHistory";
import { matchShellShortcut, matchShellShortcutChord } from "../shortcuts/shortcutRegistry";
import { hasBlockingModal } from "./modalFocus";
import { SkeletonRows, SkeletonSlot } from "./ui/SkeletonRows";
import { isSharedWithMePath } from "@dohc/workspace-core/paths";
import { Bot, Check, ChevronRight, CircleHelp, Copy, Eye, RefreshCw, Search, Send, User, X } from "lucide-react";
import {
  Fragment,
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  CaptureFileHold,
  ResolveAutomationControlsResult,
  ChatFileMentionRecord,
  ChatThreadRecord,
  DesktopUserSettingsResult,
  EngineStoreRefusal,
  ImportWorkspaceFilesResult,
  MyShareChangeRow,
  RefreshSharedViewResult,
  RebuildEngineStoreResult,
  ShareAccess,
  ShareHandoffStatus,
  ShareProposalRow,
  SyncStatusResult,
  WorkbenchMenuCommand,
  WorkspaceFileEntry,
  WorkspaceActivityEvent,
  WorkspaceSummary,
  GetWorkspaceUiStateResult,
} from "../ipc/bridgeContract";
import {
  activityPathsAffectWorkspaceListing,
  isWorkspaceVisibilityPolicyPath,
  ENGINE_STORE_BACKUP_DIR,
  engineStoreRefusalRecovery,
  engineStoreRefusalSentence,
} from "../ipc/bridgeContract";
import { DROP_IMPORT_LIMITS, DROP_IMPORT_REFUSALS, isEditorMenuCommand } from "../ipc/channels";
import { isPathTaken, isPrivacyDenied, isRestorePolicyRefusal, readError, shouldRecheckShareAccess } from "../ipc/errorWords";
import { SyncedDeletionRevivalError } from "../workspaces/syncedDeletionRefusal";
import {
  formatSize,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../workspaces/workspaceEngineCaptureLimits";
import {
  hasUnacknowledgedShareSkips,
  shareSkipNoticeLines,
} from "./shareSkipNotice";
import { useChatEditorTabs } from "./shell/useChatEditorTabs";
import { LazyChatsView, LazyGraphView, LazySitePreviewPage } from "./shell/lazyViews";
import { ShellAboutRail, type AboutSearchHit } from "./shell/ShellAboutRail";
import { SIDE_PANEL_VIEWS } from "./shell/sidePanelViews";
import { ShellSidePanel } from "./shell/ShellSidePanel";
import { ShellTitlebar } from "./shell/ShellTitlebar";
import { useWorkspaceTrust } from "./useWorkspaceTrust";
import { RestrictedAgentsBand, TRUST_READ_FAILED_MESSAGE } from "./RestrictedMode";
import {
  chatMentionOpenTarget,
  graphChatOpenTarget,
  type DmChatLocator,
} from "./shell/chatOpenTarget";
import { runCanonicalDmNavigation } from "./shell/canonicalDmNavigation";
import {
  chatsOffCopy,
  fileObservationFailureCopy,
  historyOffPlaceholderCopy,
  versionCompareOffCopy,
} from "./shell/capabilityOffCopy";
import { useAgentSetup } from "./shell/useAgentSetup";
import { useAgentRunActive } from "./shell/agentRunState";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  agentMentionCandidates,
  listAgents,
  type DesktopUserSettings,
} from "../settings/userSettings";
import { useCrashReport } from "./shell/useCrashReport";
import { useAutomationHolds } from "./shell/useAutomationHolds";
import { CollectionFieldMarksProvider } from "./collections/collectionFieldMarks";
import { useCloudPresence } from "./shell/useCloudPresence";
import type { AccountDeletion } from "./shell/useAccountDeletion";
import type { ConnectionErrorReport } from "./shell/connectionNotices";
import { reportInstallationFailure, useInstallationNotices } from "./shell/installationNotices";
import type { CloudSettings } from "./settings/CloudSyncSettings";
import { useCollectionFolders } from "./shell/useCollectionFolders";
import { useShareMounts } from "./shell/useShareMounts";
import { useEditorRegistry } from "./shell/useEditorRegistry";
import { useSettingsFileNotices } from "./shell/useSettingsFileNotices";
import { useScheduleHostNotice } from "./shell/useScheduleHostNotice";
import { useCollectionCopiesLeftNotice } from "./shell/useCollectionCopiesLeftNotice";
import { useKeptCopyNotices } from "./shell/useKeptCopyNotices";
import { useCaptureRecoveryNotices } from "./shell/useCaptureRecoveryNotices";
import { useCaptureHoldNotices } from "./shell/useCaptureHoldNotices";
import { ShellErrorReporter, useShellError } from "./shell/useShellError";
import { useDocumentSaveNotices } from "./shell/useDocumentSaveNotices";
import { useReportsNotice } from "./shell/useReportsNotice";
import { useShareRemovalNotices } from "./shell/useShareRemovalNotices";
import { useChatDispatchNotices } from "./shell/useChatDispatchNotices";
import { useWorkspacePathOpenFailures } from "./shell/workspacePathOpenFailures";
import { useUsageRecordStops } from "./shell/usageRecordStops";
import { useSyncFailureNotice } from "./shell/useSyncFailureNotice";
import { useCollectionsWaitingNotice } from "./shell/useCollectionsWaitingNotice";
import { useKeptFilesNotice } from "./shell/useKeptFilesNotice";
import { useRetainedCopiesNotice } from "./shell/useRetainedCopiesNotice";
import { useSavedTabsReread } from "./shell/useSavedTabsReread";
import { useDriveLimitNotice } from "./shell/useDriveLimitNotice";
import { useNetworkShareNotice } from "./shell/useNetworkShareNotice";
import { fitImportMessage, importedPathDetails, importStopSentence, namedPaths } from "./shell/importStop";
import { importSkipLines } from "./shell/importSkips";
import { errorDetails, type ErrorDetailField } from "./shell/copyDetails";
import { shareCaptureNoticeState } from "../workspaces/shareCaptureNotice";
import { CopyButton } from "./ui/CopyButton";
import { TitlebarUpdateButton, UpdateStepLabel, updateStatusLine, useDesktopUpdate, useUpdateFailureNotices } from "./UpdateButton";
import { useTabTitles } from "./shell/useTabTitles";
import { useWorkspaceListing } from "./shell/useWorkspaceListing";
import { readNewestMomentOrder, useHistoryPage } from "./shell/useHistoryPage";
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
import {
  isCommandAvailable,
  paletteCommandRows,
  pinnedAppCommandId,
  type CommandContext,
  type CommandHandlers,
  type CommandId,
} from "./commands/commandRows";
import { QuickOpenPalette } from "./QuickOpenPalette";
import { FileInspector } from "./FileInspector";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { HeadingTarget, ScrollTarget } from "./MarkdownView";
import { preloadMarkdownEditor } from "./editor/LazyMarkdownEditor";
import { sendToFocusedEditor } from "./editor/editorMenuCommands";
import { NewFileDialog } from "./NewFileDialog";
import { NewPage, type NewPageFile } from "./NewPage";
import { displayFrontmatterValue, parseFrontmatter } from "./markdown/frontmatter";
import { registerPendingEditorDraft } from "./pendingEditorDrafts";
import { nextPagePath, pageFileStem } from "./workbench/new-file-name";
import { NewCollectionDialog } from "./collections/NewCollectionDialog";
import { type ShareViewRefresh, useShareDirectWrites } from "./shell/useShareDirectWrites";
import { useSharedViewAccess } from "./shell/useSharedViewAccess";
import { disposeAutomationButtons } from "./collections/useAutomationButtons";
import { ConnectedCollectionRecoveryRestore } from "./ConnectedCollectionRecoveryRestore";
import {
  abandonPendingCollectionFieldWrites,
  advanceCollectionWriteLineage,
  COLLECTION_WRITE_STALL_MS,
  collectionWriteFailures,
  remapCollectionFieldWritePaths,
  settleCollectionFieldWrites,
  setCollectionFieldWriteAccess,
  useCollectionWritesBlockingAdmission,
  useCollectionWriteLineage,
} from "./collections/recordFieldWrites";
import { LiveDocumentsDialog, type LiveDocumentStopAgain, type LiveDocumentStopResult } from "./LiveDocumentsDialog";
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
  IconButton,
  PrimaryButton,
  SecondaryButton,
} from "./ui/controls";
import { ActivityBar } from "./workbench/ActivityBar";
import { EditorTabs } from "./workbench/EditorTabs";
import { EditorGroupFrame } from "./workbench/tabRowActions";
import { EditorGroupLayout } from "./workbench/EditorGroupLayout";
import { EmptyEditorGroup } from "./workbench/EmptyEditorGroup";
import { Explorer } from "./workbench/Explorer";
import { hasApps, useApps, type ExplorerApps } from "./workbench/AppsSection";
import { projectTreePath, type PendingTreeChange } from "./workbench/file-tree-optimistic";
import {
  captureOrphanedDraft,
  loadLiveDraftRecovery,
  noteWorkspaceLabel,
  remapOrphanedDraftPaths,
  useOrphanedDraftPaths,
} from "./orphanedDrafts";
import { useFocusReturn, useFocusSurface } from "./ui/focusReturn";
import { countInput } from "./ui/inputCount";
import { CUSTOMIZE_TARGETS, CustomizeContext, type CustomizePart } from "./settings/customize";
import { NoticeCenter } from "./workbench/NoticeCenter";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { createActivityCoalescer } from "./workspaceActivityCoalescer";
import { AUTOMATION_NOT_HERE_NOTE, useSentNoticeProps, type NoticeShare, type OpenOnSwitch } from "./shell/useSentNoticeProps";
import type { AutomationFocus } from "./collections/AutomationsPanel";
import { serverHoldNoticesKey } from "./shell/sentNoticePlace";
import type { SentNotices } from "./shell/useSentNotices";
import { useVersionRounds } from "./shell/useVersionRounds";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  EngineHistoryView,
  fileMomentSteps,
  HistoryPaused,
  HistoryUpdating,
  isHistoryPaused,
  type HistoryCollections,
} from "./workbench/EngineHistory";
import { HistoryHiddenState } from "./workbench/HistoryPolicyStates";
import {
  ConflictReviewDialog,
  VersionComparePage,
  VersionMenu,
} from "./workbench/WorkspaceVersions";
import {
  ProposalReviewDialog,
  proposerName,
} from "./workbench/ProposalReviewDialog";
// Type-only: erased at compile time, so the ChatsView chunk stays lazy.
import type {
  ChatsInvitation,
  ChatsNav,
} from "./workbench/ChatsView";
import {
  parseTab,
  TAB_KINDS,
  activeGroup,
  activeTabPath,
  activateTab,
  adjacentTabPath,
  allTabs,
  closeTab,
  closeEditorGroup,
  createEditorGroupRight,
  focusEditorGroup,
  versionCompareTabPath,
  openMomentDiff,
  collectionTabPath,
  transactionalCollectionTabPath,
  defaultWorkbenchState,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  isViewId,
  MAX_OPEN_TABS,
  mergeSavedTabs,
  moveTab,
  moveTabToGroup,
  openTab,
  resizeEditorGroups,
  moveTabToNewGroup,
  newPageTabPath,
  replaceTab,
  appViewId,
  keepActiveViewAfterRailChange,
  keepActiveViewShown,
  parseAppViewId,
  sidebarViews,
  parseUiState,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  siteTabPath,
  setCollectionActiveView,
  setFolderExpanded,
  setExplorerMode,
  setOpenEditorsHeight,
  setView,
  showView,
  toggleAbout,
  toggleFolderExpanded,
  togglePinned,
  toggleSidebarOnRail,
  SHARING_VIEW_ID,
  type ActivityViewId,
  type EditorGroup,
  type ExplorerMode,
  type WorkbenchState,
  type WorkbenchTab,
} from "./workbench/workbenchState";
import type { AboutNotices } from "./workbench/About";
import type { AccessContext } from "./workbench/accessReason";
import type { SharingFocus } from "./workbench/SharingView";
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
      !TAB_KINDS[parseTab(after.activeTab).kind].virtual
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
const LazyRecordHistoryDialog = lazy(() =>
  import("./collections/RecordHistoryDialog").then((mod) => ({ default: mod.RecordHistoryDialog })),
);
const MARKDOWN_PRELOAD_IDLE_DELAY_MS = 150;

// How often an open workspace re-reads the share state only the relay knows:
// a recipient's mounts, and a granter's waiting changes. Slow on purpose —
// neither is urgent, and both cost a relay round trip per workspace.
const SHARE_RELAY_POLL_MS = 5 * 60 * 1000;

// The commands that still run under the opening cover.
const SETTINGS_COMMANDS: ReadonlySet<CommandId> = new Set(["settings", "settings-appearance", "settings-agents"]);

export const WORKBENCH_PERSIST_DELAY_MS = 500;
// How long after admission the opening cover says it waits for the saved tabs.
export const COVER_WAIT_LINES_MS = 5_000;

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

// A new page someone gave a title, an icon or a body. One that has none, or
// only blank space in its body, leaves nothing behind.
function typedNewPage(page: { draft: string; body: string }): boolean {
  const { meta } = parseFrontmatter(page.draft);
  return displayFrontmatterValue(meta.title) !== "" || displayFrontmatterValue(meta.icon) !== "" || page.body.trim() !== "";
}

// A new page's text as its file would hold it: the title and icon, then the
// body as it was typed.
function newPageText(page: { draft: string; body: string }): string {
  if (page.body === "") return page.draft;
  return page.draft === "" ? `${page.body}\n` : `${page.draft.replace(/\n+$/, "")}\n\n${page.body}\n`;
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
    "spelling-collision",
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
    } else if (reason === "spelling-collision") {
      const owner = one ? group[0]!.owner : undefined;
      lines.push(
        `dohc could not receive ${names}. ` +
          (owner === undefined
            ? "This machine treats each name as the same as another shared file's. Ask the person who shared the files to rename them."
            : `This machine treats ${names} and ${owner} as the same name. Ask the person who shared the files to rename one of them.`),
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

// Lists the drafts main keeps for the workspace again. A failed read files a
// notice whose Try again reads again.
function recoverLiveDrafts(
  workspaceId: string,
  isCurrent: () => boolean,
  report: (message: string, error: unknown, retry: () => void) => void,
): void {
  const recover = (): void => {
    void loadLiveDraftRecovery(workspaceId, isCurrent).catch((error: unknown) => {
      if (isCurrent()) report("dohc could not read set-aside edits.", error, recover);
    });
  };
  recover();
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  userSettings: DesktopUserSettingsResult | null;
  refreshWorkspaceRegistry: () => Promise<Workspace[]>;
  // A notice's Open passes what to open once the workspace is ready.
  onSwitchWorkspace: (workspace: Workspace, open?: OpenOnSwitch) => void;
  // May reject: the shell shows why, with a retry.
  onManageWorkspaces?: () => void | Promise<void>;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
  // Notices sent to this person, owned above the shell.
  sentNotices?: SentNotices;
  // The account deletion review, owned above the shell.
  accountDeletion: AccountDeletion;
  openOnReady?: OpenOnSwitch;
}) {
  const workspaceShareMounts = props.workspace.shareMounts ?? EMPTY_SHARE_MOUNTS;
  const {
    files,
    folders,
    fileIndex,
    filesRevalidated,
    listingsSettled,
    fileListingCommit,
    invalidateVisibility,
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
  // The part a Customize… command opened Settings for, if one did.
  const [settingsFocus, setSettingsFocus] = useState<CustomizePart | null>(null);
  // The owner's live-document list, holding the workspace it was opened for
  // rather than a bare flag. The render below only matches the current
  // workspace, so a switch cannot leave the previous workspace's list — or
  // mount a new workspace's — for even one paint.
  const [liveDocumentsWorkspaceId, setLiveDocumentsWorkspaceId] = useState<
    string | null
  >(null);
  // The document a notice opened the list for, so the list shows that row.
  const [liveDocumentsReveal, setLiveDocumentsReveal] = useState<string | null>(null);
  const openLiveDocuments = useCallback((id: string, reveal: string | null = null) => {
    setLiveDocumentsReveal(reveal);
    setLiveDocumentsWorkspaceId(id);
  }, []);
  // Relay-share dialog target: paths, or a version.
  const [shareTarget, setShareTarget] = useState<RelayShareTarget | null>(null);
  // The Open a share surface: empty, or for a share a notice named.
  const [openShare, setOpenShare] = useState<NoticeShare | "blank" | null>(null);
  const openSharePath = openShare && openShare !== "blank" ? openShare.path ?? undefined : undefined;
  const handoffStatus = props.handoffStatus ?? { status: "idle" as const };
  useEffect(() => {
    if (handoffStatus.status !== "idle") setOpenShare(null);
  }, [handoffStatus.status]);
  // Inline folder creates routed INTO the explorer (palette/menu).
  const [newFolderRequest, setNewFolderRequest] = useState<number | null>(null);
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
    (section: SettingsSectionId = DEFAULT_SETTINGS_SECTION) => {
      setSettingsFocus(null);
      setSettingsSection(section);
    },
    [],
  );
  const customize = useCallback((part: CustomizePart) => {
    setSettingsFocus(part);
    setSettingsSection(CUSTOMIZE_TARGETS[part].section);
  }, []);
  const openAgentSettings = useCallback(() => openSettings("agents"), [openSettings]);

  const workspaceId = props.workspace.workspaceId;
  const focusRoot = useRef<HTMLDivElement>(null);
  useFocusReturn(true, focusRoot, () => document.querySelector<HTMLElement>('[data-focus-surface="workspace"]'));
  useFocusSurface(focusRoot, () => null);
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

  // `openWorkspace` installs main's exact renderer session before it waits
  // for watcher readiness. Its response is the renderer's existing proof that
  // both happened; there is no separate admission IPC. Exact-session bootstrap
  // reads wait for that proof before they reach main. The local
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
  const { agentSetup } = useAgentSetup(
    workspaceId,
    props.userSettings,
    settingsSection,
    workspaceIsReady,
  );

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
  const retryWorkspaceOpen = () => {
    setWorkspaceOpenFailedFor(null);
    setWorkspaceOpenAttempt((attempt) => attempt + 1);
  };
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
    reportButtonError,
    reportShellFailure,
    reportShareCapture,
    clearKind,
    reportLaneFailure,
    reportSearchError,
    clearSearchError,
    reportSyncFailure,
    showSyncRefusals,
    clearSyncFailure,
    reportCollectionsWaiting,
    clearCollectionsWaiting,
    reportDriveLimit,
    reportNetworkShare,
    reportKeptFiles,
    reportImportSkips,
    showRetainedCopies,
    showSavedTabsNotice,
    reportRecoveryUnavailable,
    showTabLimitError,
    clearTabLimitError,
    showSingletonTabSplitError,
    clearEditorGroupRefusalError,
    showSettingsFileNotice,
    showSuccessNotice,
    showWarningNotice,
    showScheduleHostNotice,
    showReportsNotice,
    showKeptCopies,
    showKeptCopySaved,
    showOutsideCopies,
    showCaptureRecoveries,
    showCaptureHolds,
    showDirectWriteNotice,
    dismissShellError,
    retryShellError,
    runShellErrorAction,
    clearIdentity,
    privacySettingsAction,
    keepCollectionsHere,
  } = useShellError(workspaceId);
  const stopAndRestore = useStopAndRestore(workspaceId, {ready: workspaceIsReady && !props.workspace.shareView,
    onError: (fallback, error, retry, identity) => reportShellError(fallback, error, retry, undefined, identity)});
  useScheduleHostNotice({ workspaceId, ready: workspaceIsReady, show: showScheduleHostNotice, report: reportShellFailure });
  const reportCollectionCopiesLeft = useCallback((notice: { message: string; toast: boolean; retry: () => void }) =>
    reportShellFailure({ message: notice.message, retry: notice.retry, quiet: !notice.toast, kind: "collection-copies-left" }),
  [reportShellFailure]);
  const clearCollectionCopiesLeft = useCallback(() => clearKind("collection-copies-left"), [clearKind]);
  const collectionCopiesLeftNotice = useCollectionCopiesLeftNotice({ report: reportCollectionCopiesLeft, clear: clearCollectionCopiesLeft });
  useWorkspacePathOpenFailures(workspaceId, reportShellFailure);
  // The updater's state, for the title bar, the stopped workspace, the
  // palette, and the menus.
  const desktopUpdate = useDesktopUpdate(reportShellFailure);
  const clearUpdateFailure = useCallback(() => clearKind("update"), [clearKind]);
  useUpdateFailureNotices(desktopUpdate, workspaceId, reportShellFailure, clearUpdateFailure);
  const runDesktopUpdate = desktopUpdate.run;
  // The row or lane Settings search opened the Sharing view on.
  const [sharingFocus, setSharingFocus] = useState<SharingFocus | null>(null);
  const clearSharingFocus = useCallback(() => setSharingFocus(null), []);
  // Share removals from Chats, Sharing and the share dialog: one
  // notice with Undo, held here so it outlives the surface that removed the
  // access. Each removal and Undo counts, so an open Sharing view reads again.
  const [sharesRevision, sharesChanged] = useReducer((revision: number) => revision + 1, 0);
  const shareRemovals = useShareRemovalNotices({
    workspaceId,
    showSuccessNotice,
    reportShellFailure,
    onSharesChanged: sharesChanged,
  });
  // For surfaces that report a failure as one sentence, with the error that
  // caused it when they have one. One stable identity: ChatsView keys its
  // polls and subscriptions off onError, so a fresh arrow per shell render
  // tore them down and re-armed them every render.
  const reportFailureMessage = useCallback(
    (message: string, cause?: unknown, retry?: () => void, identity?: string) =>
      reportShellFailure({ message, cause, ...(retry ? { retry } : {}), ...(identity !== undefined ? { identity } : {}) }),
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
  // A Stop names the row's document. A Try again closes that document's
  // editors wherever they opened it, and no other document's at its old path.
  const stopLiveDocument = useCallback(
    async (id: string, path: string, objectId: string, again?: LiveDocumentStopAgain) => {
      let result: LiveDocumentStopResult = { keptEdits: "none" };
      await withClosedEngineDocSession(id, again ? { objectId: again.objectId } : { path }, async () => {
        result = await bridge().stopOwnerLiveDocument({ workspaceId: id, path, objectId, ...(again ? { again } : {}) });
      });
      return result;
    },
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
        openLiveDocuments(failedFor);
      });
    },
    [reportShellError, openLiveDocuments],
  );
  // Refused edits a Stop wrote into the file. Edits it kept stay in their
  // own notice, which the sync status carries.
  const liveDocumentStopped = useCallback(
    (path: string, keptEdits: "recovered" | "kept") => {
      if (keptEdits === "recovered") showSuccessNotice(`Live editing stopped for ${path}. dohc wrote your kept edits into the file.`);
    },
    [showSuccessNotice],
  );
  // Save recovery copy, from a notice or the Live documents dialog, of the
  // kept edits the row's incident names. Set once the shell can open the copy it wrote.
  const saveLiveRecoveryCopyRef = useRef<(id: string, path: string, incident?: string) => Promise<void>>(async () => undefined);
  const saveLiveRecoveryCopyFromDialog = useCallback((id: string, path: string, incident?: string) => saveLiveRecoveryCopyRef.current(id, path, incident), []);
  const readKeptEdits = useCallback(
    (id: string, objectId: string, incident: string) =>
      bridge().retryOwnerLiveQuarantine({ workspaceId: id, objectId, incident }),
    [],
  );

  const reportCloudStatusUnavailable = useCallback(
    (retry: () => void) => {
      const message = "dohc could not check this workspace's server connection.";
      reportShellError(message, new Error(message), retry);
    },
    [reportShellError],
  );
  const {
    chatCollaboration,
    refreshCloudStatus,
    readCloudStatusAgainIfBusy,
    workspaceSynced,
    cloudStatus,
    cloudStatusUnreadable,
  } = useCloudPresence(workspaceId, reportCloudStatusUnavailable, workspaceIsReady);
  const { start: startAccountDeletion, reviewing: reviewingAccountDeletion, attach: attachAccountDeletion } =
    props.accountDeletion;
  // Closing Settings reads the status again, as the old Cloud dialog did on
  // close. The page's own refresh after an enable covers only its own
  // change: another window's Try again can make main adopt this account's
  // saved session without announcing a session change, so this workspace's
  // paused status would otherwise outlive the cause.
  const settingsOpen = settingsSection !== null;
  const closeSettings = useCallback(() => {
    if (settingsOpen) refreshCloudStatus();
    setSettingsSection(null);
    setSettingsFocus(null);
  }, [refreshCloudStatus, settingsOpen]);
  const closeCloud = useCallback(() => {
    setCloudOpen(false);
    setCloudRetryServerUrl("");
    // A sign-in/out inside the dialog changes the relay session —
    // refresh so Chats presence lights up (or goes dormant) at once.
    refreshCloudStatus();
  }, [refreshCloudStatus]);
  // Connect server, wherever it is asked for. The account and the sync switch
  // are settings, so only a person known to be signed out gets the Cloud
  // dialog. A status still loading, or unreadable, opens Settings, which says
  // which it is.
  const cloudSignedOut = cloudStatus?.connected === false;
  const openCloud = useCallback(() => {
    if (cloudSignedOut) setCloudOpen(true);
    else openSettings("cloud");
  }, [cloudSignedOut, openSettings]);
  // A failure from the Cloud dialog or the Sync and sharing page. The notice
  // outlives both, so its Try again reopens the dialog with the address that
  // failed, or whichever of the two now applies, once the source has closed.
  // An open deletion review holds the account until it ends, so a Try again
  // then runs nothing and keeps its row: no sign-in, Disconnect, or new
  // review starts under it.
  const reportConnectionError = useCallback(
    (error: ConnectionErrorReport) => {
      reportShellFailure({
        message: error.message,
        cause: error.cause,
        retry: () => {
          if (reviewingAccountDeletion()) return false;
          if (error.retry?.()) return;
          if (error.serverUrl === null) return openCloud();
          setCloudRetryServerUrl(error.serverUrl);
          setCloudOpen(true);
        },
      });
    },
    [reviewingAccountDeletion, openCloud, reportShellFailure],
  );
  // After useShellError's, so this shell attaches with its notices started:
  // an answer to a delete sent from the previous workspace's shell reports here.
  useEffect(
    () =>
      attachAccountDeletion({
        cloudStatus,
        report: reportConnectionError,
        showSuccess: showSuccessNotice,
        showWarning: showWarningNotice,
        onEnded: refreshCloudStatus,
      }),
    [attachAccountDeletion, cloudStatus, refreshCloudStatus, reportConnectionError, showSuccessNotice, showWarningNotice],
  );
  // Unguarded by workspace: an installation-wide failure is news here.
  useInstallationNotices(reportConnectionError);
  const hasReceivedShares = workspaceShareMounts.length > 0;
  const cloudSettings = useMemo<CloudSettings>(() => {
    // The page answers after it closed too. Only this workspace's answers
    // reach its status and its notices.
    const forWorkspace = workspaceId;
    const current = () => workspaceIdRef.current === forWorkspace;
    return {
      status: cloudStatus,
      unreadable: cloudStatusUnreadable,
      onChanged: () => {
        if (current()) refreshCloudStatus();
      },
      onConnect: () => {
        closeSettings();
        setCloudOpen(true);
      },
      // An enable or a pause. The page holds the switch, signed in or out,
      // so a retry it can no longer run opens the page again.
      onError: (error) => {
        if (!current()) return;
        reportShellFailure({
          message: error.message,
          cause: error.cause,
          retry: () => {
            if (reviewingAccountDeletion()) return false;
            if (!error.retry?.()) openSettings("cloud");
          },
        });
      },
      onAccountError: reportInstallationFailure,
      hasReceivedShares,
      onDeleteAccount: startAccountDeletion,
    };
  }, [startAccountDeletion, reviewingAccountDeletion, closeSettings, cloudStatus, cloudStatusUnreadable, hasReceivedShares, openSettings, refreshCloudStatus, reportShellFailure, workspaceId]);
  // About's section reads report through this shell's notices, one row per
  // section and file. A repeat keeps an existing row's toast state only for
  // an unchanged message. A changed message, or a missing row, toasts again.
  const aboutNotices = useMemo<AboutNotices>(
    () => ({ report: (failure) => reportShellFailure({ ...failure, repeat: true }), clear: clearIdentity }),
    [clearIdentity, reportShellFailure],
  );
  // What can explain an Access answer that covers nothing. About derives the
  // cause for each file from these facts (accessReasonFor).
  const isShareView = props.workspace.shareView !== undefined;
  const cloudConnected = cloudStatus?.connected;
  const cloudWorkspaceSynced = cloudStatus?.workspaceSynced === true;
  const cloudWorkspaceSyncConnected = cloudStatus?.workspaceSyncConnected === true;
  const cloudServerUrl = cloudStatus?.workspaceServerUrl ?? null;
  // One Share dialog for every surface: the explorer row's "Share…", the
  // inspector header's share control, and About's Access.
  const onSharePath = useCallback((path: string) => {
    setShareTarget({ kind: "paths", paths: [path] });
  }, []);
  const sharing = shareTarget !== null;
  const accessContext = useMemo<AccessContext>(
    () => ({
      facts: {
        cloud: cloudConnected !== undefined ? {
          connected: cloudConnected,
          workspaceSynced: cloudWorkspaceSynced,
          workspaceSyncConnected: cloudWorkspaceSyncConnected,
        } : cloudStatusUnreadable ? "unreadable" : "checking",
        shareView: isShareView,
      },
      server: cloudServerUrl,
      openSyncSettings: () => openSettings("cloud"),
      connect: openCloud,
      share: onSharePath,
      sharing,
    }),
    [cloudConnected, cloudServerUrl, cloudStatusUnreadable, cloudWorkspaceSyncConnected, cloudWorkspaceSynced, isShareView, onSharePath, openCloud, openSettings, sharing],
  );

  // @-mention roster + agent notifications (Agent Notifications & Mentions).
  // The renderer has no identity source yet, so the user shows as "You" —
  // the same fallback main uses for local authorship.
  const LOCAL_USER_LABEL = "You";
  // Each agent that is on, by name: @ and its name's handle wakes it.
  const setupAgents = agentSetup?.agents;
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () => [
      ...agentMentionCandidates(setupAgents ?? []),
      { id: "user:you", kind: "user", handle: "you", label: LOCAL_USER_LABEL, description: "you" },
    ],
    [setupAgents],
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
    resolveMomentDiffPath,
  } = useTabTitles(workspaceId);
  const anyTabDirty = dirtyPaths.size > 0;
  const focusedTab = parseTab(focusedTabPath);
  const activeDocumentPath = TAB_KINDS[focusedTab?.kind ?? "removed"].virtual
    ? null
    : focusedTabPath;
  // The change open in the focused group, which the timeline marks.
  const openMomentId = focusedTab?.kind === "momentDiff" ? focusedTab.momentId : null;
  // Whether some tab holds what About covers, so its empty state says to
  // switch to that tab instead of to open one: any file, or a conversation
  // other than the focused one. A shared view has no conversations.
  const sharedView = props.workspace.shareView != null;
  const aboutTabOpen = useMemo(
    () => wb.editorGroups.some((group) => group.tabs.some((tab) => {
      const parsed = parseTab(tab.path);
      if (!TAB_KINDS[parsed.kind].virtual) return true;
      return !sharedView && tab.path !== focusedTabPath && parsed.kind === "chat" &&
        (parsed.target.kind === "channel" || parsed.target.kind === "dm");
    })),
    [focusedTabPath, sharedView, wb.editorGroups],
  );

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

  // Restore per-workspace workbench state from .dohc/local/ui-state.json. The shell
  // renders at once under the opening cover (launch budgets key off shell
  // visibility); the cover lifts in the commit that applies the stored state,
  // or the defaults when there is none or the read fails. The stored state
  // replaces whatever changed under the cover, and file opens wait for it, so
  // nothing done under the cover loses the saved tabs. Writes start once the
  // read answers. A failed read can't say what is saved, so after one, writes
  // wait for a later read to apply the saved tabs, and a default-state write
  // can never clobber the stored one.
  const uiStateLoaded = useRef(false);
  const restoredActiveFileSurface = useRef<{
    selectionGeneration: number;
    groupId: string;
    path: string;
  } | null>(null);
  const [restoredSurfaceCommit, setRestoredSurfaceCommit] = useState<{
    selectionGeneration: number;
    waitsForFile: boolean;
  } | null>(null);
  // Lift the opening cover in the same commit as the saved layout or defaults.
  // Admission and the saved-layout read never wait on this state.
  const workbenchRestored =
    restoredSurfaceCommit?.selectionGeneration === workspaceSelectionGeneration;
  // A file open waits for the saved layout. While the opening cover shows, a
  // command other than Settings does nothing and is not replayed. Settings
  // opens from every entry, as its shortcut does, and doesn't change the layout.
  const workbenchRestoredRef = useRef(false);
  const heldFileOpens = useRef<[string, HeadingTarget?, Omit<ScrollTarget, "path">?][]>([]);
  const openingCoverShown = useRef(false);
  // The tab paths the stored state restored — the only ones a file listing is
  // allowed to close. Empty until the load applies, and empty forever when
  // nothing was stored. STATE, not a ref: the reconciliation below reads it,
  // and the listing can win the race against this load, so it has to re-run
  // when the restore lands.
  const [restoredTabPaths, setRestoredTabPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // The one mutation seam for workbench state: every user-driven transition
  // routes through here. Loading stored state and restored-tab pruning are
  // the only other writers.
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
      writeWb(next);
    },
    [writeWb],
  );

  const sidebarSettings = props.userSettings?.settings.sidebar ?? DEFAULT_SIDEBAR_SETTINGS;
  // A shared view has chat per file, in About, and no workspace-wide listing,
  // so its rail offers no Chats.
  const railViews = useMemo(
    () => sidebarViews(sidebarSettings).filter((view) => !(isShareView && view === "chats")),
    [isShareView, sidebarSettings],
  );
  // A shared view restored with Chats selected shows the Explorer from its
  // first frame. The rail, the panel and its title read the shown view; the
  // write below then corrects the saved one, so the rail's own buttons act
  // on what the person sees.
  const restoredSharedChats = isShareView && wb.activeView === "chats";
  const shownView: ActivityViewId = restoredSharedChats ? "explorer" : wb.activeView;
  const shownWb = useMemo(
    () => (restoredSharedChats ? { ...wb, activeView: shownView } : wb),
    [restoredSharedChats, shownView, wb],
  );
  useEffect(() => {
    if (!restoredSharedChats) return;
    mutateWb((state) => (state.activeView === "chats" ? { ...state, activeView: "explorer" } : state));
  }, [mutateWb, restoredSharedChats]);
  const pinnedRoots = useMemo(
    () => pinnedAppsFor(props.userSettings?.settings, workspaceId),
    [props.userSettings, workspaceId],
  );
  const pinnedApps = usePinnedApps(workspaceId, pinnedRoots);
  const selectedAppRoot = parseAppViewId(wb.activeView);
  const selectedApp = pinnedApps.find((app) => app.root === selectedAppRoot) ?? null;
  // The panel's header names dohc's own view or the pinned app.
  const sidePanelTitle = isViewId(shownView)
    ? SIDE_PANEL_VIEWS[shownView].label
    : shownView === SHARING_VIEW_ID ? "Sharing" : selectedApp?.label ?? "App";

  // Every view on the rail, in its order: dohc's own, pinned apps, then
  // Sharing at the rail's foot.
  const railOrder = useMemo<readonly ActivityViewId[]>(
    () => [...railViews, ...pinnedRoots.map(appViewId), SHARING_VIEW_ID],
    [pinnedRoots, railViews],
  );
  const railOrderRef = useRef(railOrder);
  railOrderRef.current = railOrder;
  // When the person hides the selected view or unpins the selected app, the
  // selection moves to a view on the rail. Any other change to the rail,
  // such as hiding another view, reordering, or pinning, leaves it alone, and
  // so does a link or command that opens a hidden view. Once the settings
  // and the saved layout are in, a selection the rail does not show moves
  // once; before that it stands, so a restart keeps the view that was open.
  const railKey = railOrder.join("\0");
  const settingsLoaded = props.userSettings !== null;
  const previousRailRef = useRef<readonly ActivityViewId[] | null>(null);
  useEffect(() => {
    if (!settingsLoaded || !workbenchRestored) return;
    const previous = previousRailRef.current;
    const rail = railOrderRef.current;
    previousRailRef.current = rail;
    mutateWb((state) =>
      previous === null
        ? keepActiveViewShown(state, rail)
        : keepActiveViewAfterRailChange(state, previous, rail));
  }, [mutateWb, railKey, settingsLoaded, workbenchRestored]);
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
  const setAgentColor = useMemo(
    () => saveAgentColor(bridge(), workspaceId, reportShellError),
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

  // A failed read is read again once the workspace opens (useSavedTabsReread).
  const layoutReadStartedAt = useRef(0);
  const [layoutReadFailure, setLayoutReadFailure] = useState<{
    admission: typeof workspaceAdmission;
    startedAt: number;
  } | null>(null);
  useAsyncResponseEffect(
    async () => {
      await workspaceAdmission.promise;
      if (workspaceAdmission.superseded) {
        throw new DOMException("The workspace selection changed.", "AbortError");
      }
      layoutReadStartedAt.current = Date.now();
      return bridge().getWorkspaceUiState({ workspaceId });
    },
    {
      onSuccess: (stored) => {
        let restoredFileSurface: typeof restoredActiveFileSurface.current = null;
        if (stored) {
          const parsed = parseUiState(stored);
          const restoredGroup = activeGroup(parsed);
          if (
            restoredGroup.activeTab !== null &&
            !TAB_KINDS[parseTab(restoredGroup.activeTab).kind].virtual
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
      },
      onError: () => {
        restoredActiveFileSurface.current = null;
        setRestoredSurfaceCommit({
          selectionGeneration: workspaceSelectionGeneration,
          waitsForFile: false,
        });
        setLayoutReadFailure({
          admission: workspaceAdmission,
          startedAt: layoutReadStartedAt.current,
        });
      },
    },
    [workspaceAdmission, workspaceId, workspaceSelectionGeneration],
  );
  // The saved layout replaces the defaults, and tabs opened since stay open
  // beside the saved ones, the one in view still in view. A file open in both
  // keeps its saved place. Past the tab limit, saved tabs make room. Saving
  // starts, with what's shown when nothing was saved.
  const applySavedLayout = useCallback((stored: GetWorkspaceUiStateResult) => {
    const shown = wbRef.current;
    if (stored) {
      const saved = parseUiState(stored);
      writeWb(mergeSavedTabs(saved, shown));
      setRestoredTabPaths(new Set(allTabs(saved).map((tab) => tab.path)));
    } else {
      writeWb({ ...shown });
    }
    uiStateLoaded.current = true;
  }, [writeWb]);
  useSavedTabsReread({
    workspaceId,
    failed: layoutReadFailure?.admission === workspaceAdmission ? layoutReadFailure : null,
    tabsOpen: () => allTabs(wbRef.current).length > 0,
    apply: applySavedLayout,
    show: showSavedTabsNotice,
  });
  // The cover's lines for a saved layout that is slow to load.
  const [coverWaitedFor, setCoverWaitedFor] = useState<typeof workspaceAdmission | null>(null);
  useEffect(() => {
    if (!workspaceIsReady || workbenchRestored) return;
    const timer = setTimeout(() => setCoverWaitedFor(workspaceAdmission), COVER_WAIT_LINES_MS);
    return () => clearTimeout(timer);
  }, [workspaceAdmission, workspaceIsReady, workbenchRestored]);
  const coverWaits = workspaceIsReady && coverWaitedFor === workspaceAdmission;
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
  // the shell via key={workspaceId}). Gated on the read having answered so a
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
      // a user action. But it moves the active tab exactly as mutateWb does, so
      // it owes the same invalidation — otherwise an in-flight DM navigation
      // still passes its isCurrent() check and lands its destination on top of
      // the tab we just activated.
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
  // For a lookup that must not act on a version a later switch replaced.
  const versionEpochRef = useRef(versionEpoch);
  versionEpochRef.current = versionEpoch;
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

  // A shared view has no recorder: the share's open installs no capture, so
  // it records nothing and restores nothing. Capability identity comes from
  // main's registry summary. This gates the versions surface and collections,
  // and restore, from the same fact.
  const shareView = props.workspace.shareView ?? null;
  const shareViewRef = useRef(shareView);
  shareViewRef.current = shareView;
  const [needsReopenFor, setNeedsReopenFor] = useState<NonNullable<Workspace["shareView"]> | null>(null);
  const shareViewDamaged = !!shareView?.damaged || (!!shareView && needsReopenFor === shareView);
  // A registry update replaces this snapshot, including when access returns.
  const [endedFor, setEndedFor] = useState<NonNullable<Workspace["shareView"]> | null>(null);
  const shareViewEnded = !!shareView && (shareView.ended || endedFor === shareView);
  const [accessFor, setAccessFor] = useState<{ view: NonNullable<Workspace["shareView"]>; access: "view" | "comment" | "edit" } | null>(null);
  const shareAccess = accessFor?.view === shareView ? accessFor.access : shareView?.access;
  const shareViewWritable =
    !shareViewDamaged && !shareViewEnded && shareAccess === "edit";
  const shareViewEndedRef = useRef(shareViewEnded);
  shareViewEndedRef.current = shareViewEnded;
  const shareViewWritableRef = useRef(shareViewWritable);
  shareViewWritableRef.current = shareViewWritable;
  const shareHadEditRef = useRef(shareView?.access === "edit");
  if (shareViewWritable) shareHadEditRef.current = true;
  const shareReopenMessage = "This share must be reopened. Choose Forget in the workspace menu, then open the share code again. Forget keeps your files.";
  const shareWriteRefusal = shareViewEnded ? "Your access to this share ended."
    : shareViewDamaged ? !shareView?.recipientUserId || needsReopenFor === shareView ? shareReopenMessage
      : "dohc can't read what this share grants. Open the share again to restore it."
    : shareHadEditRef.current ? "Your access to this share changed. Ask for Edit access, then reopen the share."
    : "This share does not have Edit access.";
  const shareWriteRefusalRef = useRef(shareWriteRefusal);
  shareWriteRefusalRef.current = shareWriteRefusal;
  useEffect(() => {
    setCollectionFieldWriteAccess(workspaceId, shareView && !shareViewWritable ? shareWriteRefusal : null);
  }, [workspaceId, !!shareView, shareViewWritable, shareWriteRefusal]);
  // History reads are separate. A shared view reads the history its share
  // imported, list and detail only, from its own store.
  const historyReadable = (status: SyncStatusResult | null) =>
    shareView ? !status?.engineStoreRefused : !statusSaysNoRecorder(status);
  const shareViewReadsCollections = !!shareView && !shareViewDamaged;
  // Owner live documents require this workspace's server connection.
  const liveDocumentsAvailable = !shareView && workspaceSynced;
  const { collectionFolders, refreshCollections, datasets, refreshDatasets, nextDataset, loadMoreDatasets, includeArchived, setIncludeArchived, collectionsRefusal, collectionsElsewhere, collectionsListed } = useCollectionFolders(
    workspaceId,
    workspaceIsReady,
    !!shareView,
    shareViewReadsCollections,
    shareViewEnded,
  );
  const folderApps = useFolderAppOffers({
    workspaceId,
    enabled: workspaceIsReady && !shareViewEnded,
    expandedFolders: wb.expandedFolders,
    activePath: wb.editorGroups.find((group) => group.id === wb.activeEditorGroup)?.activeTab ?? null,
    onError: (folder, error, retry, quiet) => reportShellFailure({
      message: `dohc could not read the folder ${folder}.`,
      cause: error,
      retry,
      identity: `folder-app:${folder}`,
      quiet,
    }),
  });
  const workspaceApps = useApps(workspaceId, listingsSettled, aboutNotices, workspaceIsReady && !shareViewEnded);
  // Every app folder: the listed apps, and any read before the list arrives.
  const appFolders = useMemo(() => {
    const folders = new Set(folderApps.keys());
    const listed = workspaceApps.state;
    if (listed.status === "ready" && listed.workspaceId === workspaceId) for (const app of listed.apps) folders.add(app.root);
    return folders;
  }, [folderApps, workspaceApps.state, workspaceId]);
  // The app folder of each entry file, so a file view shows Run.
  const appEntries = useMemo(() => {
    const entries = new Map<string, string>();
    for (const app of folderApps.values()) if (app.run?.entryPath) entries.set(app.run.entryPath, app.run.path);
    return entries;
  }, [folderApps]);
  useEffect(() => {
    if (!workspaceIsReady || shareViewEnded) return;
    const refresh = () => {
      if (workspaceAdmission.superseded || shareViewEndedRef.current) return;
      void refreshDatasets().catch(error => {
        if (!workspaceAdmission.superseded && !shareViewEndedRef.current) reportShellError("Could not read Collections.", error, refresh);
      });
    };
    refresh();
  }, [workspaceIsReady, workspaceAdmission, shareViewEnded, refreshDatasets, reportShellError]);
  // Reads the Collections list again, as Try again beside a list that could not be read.
  const retryCollectionsList = useCallback(() => {
    void refreshDatasets().catch(error => {
      if (!workspaceAdmission.superseded) reportShellError("Could not read Collections.", error);
    });
  }, [refreshDatasets, reportShellError, workspaceAdmission]);
  // Keeps Collections no computer keeps yet on this one, then reads the list, and runs `then`, such as a tab's own read.
  const keepCollectionsWithList = useCallback((then?: () => void) => {
    keepCollectionsHere(() => { retryCollectionsList(); then?.(); });
  }, [keepCollectionsHere, retryCollectionsList]);
  // One issue counter for every engine read the shell orders: the history
  // page, the status lanes, the workspace open, the agent observation, and
  // the version callbacks. Bumped on unmount, so a slow response for one
  // workspace can never repaint another.
  const engineHistoryToken = useRef(0);
  const markHistoryReady = useCallback(
    () => markCurrentSwitchPhase("history-ready"),
    [markCurrentSwitchPhase],
  );
  // The history page owns its admission rules: version staleness, a
  // pagination that may hold a refresh, and the updating retry ladder. The
  // shell issues its tokens and reports its failures.
  const {
    page: engineHistory,
    loadingMore: engineHistoryLoadingMore,
    readState: engineHistoryReadState,
    policyError: engineHistoryPolicyError,
    refresh: refreshHistoryPage,
    supersede: supersedeHistoryPage,
    loadMore: loadMoreEngineHistory,
    observeVersion: observeEngineVersion,
  } = useHistoryPage(engineHistoryToken, workspaceId, markHistoryReady, !!shareView);
  // Each loaded change's older and newer change to the same file, for the
  // diff page's steps. One pass per History answer.
  const momentSteps = useMemo(() => fileMomentSteps(engineHistory?.entries ?? []), [engineHistory]);
  // The sync snapshot rides the refresh response but is not the timeline: no
  // pagination competes for it, so it applies as soon as it arrives, in its
  // own lane with its own watermark.
  //
  // Each lane owns its state, so a write that names no request cannot be
  // written at all. The history page is not one of these: it carries
  // its own admission rules, so it is judged where those rules live.
  const [syncStatus, syncStatusLane] = useSnapshotLane<SyncStatusResult | null>(
    engineHistoryToken,
    null,
  );
  const shownStopFailures=useRef(new Map<string,string>());
  useEffect(() => {
    if (captureDecidedFor!==workspaceId || syncStatus===null) return;
    const failures=syncStatus.ownerLiveStopFailures ?? [];
    const identities=new Set(failures.map(failure => `owner-stop:${workspaceId}:${failure.path}`));
    for (const identity of shownStopFailures.current.keys()) {
      if (identity.startsWith(`owner-stop:${workspaceId}:`) && !identities.has(identity)) {
        shownStopFailures.current.delete(identity);clearIdentity(identity);
      }
    }
    for (const failure of failures) {
      const identity=`owner-stop:${workspaceId}:${failure.path}`;
      if (shownStopFailures.current.get(identity)===failure.detail) continue;
      shownStopFailures.current.set(identity,failure.detail);
      const retry=() => {void withClosedEngineDocSession(workspaceId,{path:failure.path},async ()=>{await bridge().stopOwnerLiveDocument({workspaceId,path:failure.path});}).catch(error => {
        if (!workspaceAdmission.superseded) reportShellError("dohc could not stop live editing.",error,retry,undefined,identity);
      });};
      reportShellFailure({message:`dohc could not stop live editing for "${failure.path}".`,details:[["Reason",failure.detail]],retry,identity});
    }
  },[captureDecidedFor,syncStatus,workspaceId,workspaceAdmission,reportShellError,reportShellFailure,clearIdentity]);
  // One notice per document whose edits the server refused, once per
  // incident and recovery step: a refusal after a Try again is a new
  // incident. Dismissing the row hides it and leaves the edits kept. While a
  // Try again or a Stop waits, the row stays quiet. Save recovery copy is on
  // every row, including one whose Stop took the edits but could not write them.
  const shownQuarantines=useRef({workspaceId,shown:new Map<string,string>()});
  useEffect(() => {
    if (captureDecidedFor!==workspaceId || syncStatus===null) return;
    if (shownQuarantines.current.workspaceId!==workspaceId) shownQuarantines.current={workspaceId,shown:new Map()};
    const shown=shownQuarantines.current.shown;
    // An earlier Stop's edits keep their own row beside the document's current queue.
    const identityOf=(row:{objectId:string;recovery:string;incident:string;saveOnly?:true}) =>
      `owner-live-quarantine:${workspaceId}:${row.objectId}${row.saveOnly ? `:${row.incident}` : row.recovery==="not-written" || row.recovery==="cannot-write" ? ":release" : ""}`;
    const rows=syncStatus.ownerLiveQuarantines ?? [];
    const listed=new Set(rows.map(identityOf));
    for (const identity of [...shown.keys()]) {
      if (!listed.has(identity)) {shown.delete(identity);clearIdentity(identity);}
    }
    for (const row of rows) {
      const identity=identityOf(row), incident=`${row.recovery}${row.earlier ? " earlier" : ""}\n${row.incident}`;
      if (shown.get(identity)===incident) continue;
      shown.set(identity,incident);
      const onServer=row.storedOn==="server";
      const details:ReadonlyArray<ErrorDetailField>=[["File",row.path,row.path.length],["Kept on",onServer ? "The server" : "This computer"],["Reason",row.reason],["Incident",row.incident]];
      const open={label:"Open Live documents",run:() => openLiveDocuments(workspaceId,row.path)};
      // The engine refused to read the queue: Try again reads it again. Save needs what it could not read.
      if (row.recovery==="unreadable") {
        const read=() => {
          bridge().retryOwnerLiveQuarantine({workspaceId,objectId:row.objectId,incident:row.incident}).catch((error: unknown) => {
            if (workspaceIdRef.current!==workspaceId || workspaceAdmission.superseded) return;
            reportShellError(`dohc could not read the edits it kept for ${row.path}.`,error,read,undefined,identity);
          });
        };
        reportShellFailure({title:`Live editing paused for ${row.path}`,
          message:"dohc kept edits on this computer but could not read them.",details,retry:read,action:open,identity});
        continue;
      }
      const save={label:"Save recovery copy",run:() => {void saveLiveRecoveryCopyRef.current(workspaceId,row.path,row.incident);},additional:[open]};
      if (row.saveOnly) {
        reportShellFailure({title:`Edits not written to ${row.path}`,
          message:"dohc kept your unsent edits, but could not write them to your file. Save a recovery copy to get them back.",details,action:save,identity});
        continue;
      }
      // A Stop runs again for this row's document: it finishes a waiting Stop, or writes the file a finished one could not.
      // Its editors close wherever the document is now, since a record keeps the path it had.
      const again=row.recovery==="not-written" || row.recovery==="stopping" ? {objectId:row.objectId,recovery:row.recovery} : undefined;
      const stopAgain=() => {
        let result:LiveDocumentStopResult={keptEdits:"none"};
        void withClosedEngineDocSession(workspaceId,again ? {objectId:again.objectId} : {path:row.path},async () => {result=await bridge().stopOwnerLiveDocument({workspaceId,path:row.path,...(again ? {again} : {})});})
          .then(() => {if (workspaceIdRef.current===workspaceId && result.keptEdits==="recovered") liveDocumentStopped(row.path,"recovered");},
            (error: unknown) => {
              if (workspaceIdRef.current!==workspaceId || workspaceAdmission.superseded) return;
              reportShellError(`dohc could not stop live editing for ${row.path}.`,error,stopAgain,undefined,identity);
            });
      };
      // An earlier Stop's edits: the document may be live again, so the row names only the edits.
      if (row.recovery==="not-written") {
        reportShellFailure({title:`Edits not written to ${row.path}`,
          message:"When live editing stopped, dohc kept your unsent edits but could not write them to your file. Save a recovery copy to get them back.",details,retry:stopAgain,action:save,identity});
        continue;
      }
      if (row.recovery==="cannot-write") {
        reportShellFailure({title:`Edits not written to ${row.path}`,
          message:"When live editing stopped, dohc kept your unsent edits but can't finish writing them to your file. Save a recovery copy to get them back.",details,action:save,identity});
        continue;
      }
      if (row.recovery==="stopped-kept") {
        reportShellFailure({title:`Live editing stopped for ${row.path}`,
          message:"dohc kept your unsent edits, but could not write them to your file. Save a recovery copy to get them back.",details,action:save,identity});
        continue;
      }
      if (row.recovery==="stopping") {
        reportShellFailure({title:`Stopping live editing for ${row.path}`,tone:"warning",quiet:true,
          message:"dohc is waiting for the server to stop live editing. Your unsent edits stay on this computer.",details,retry:stopAgain,action:save,identity});
        continue;
      }
      if (row.recovery==="retrying") {
        reportShellFailure({title:`Trying again for ${row.path}`,tone:"warning",quiet:true,
          message:"dohc is sending your kept edits to the server once more.",details,action:save,identity});
        continue;
      }
      // Try again cannot reach an earlier copy of the workspace, so the row offers only Save.
      if (row.earlier && row.recovery==="paused") {
        reportShellFailure({title:`Live editing paused for ${row.path}`,
          message:"The server could not accept your edits. It kept them in an earlier copy of this workspace. Save a recovery copy to get them back.",
          details,action:save,identity});
        continue;
      }
      const retry=() => {
        bridge().retryOwnerLiveQuarantine({workspaceId,objectId:row.objectId,incident:row.incident}).catch((error: unknown) => {
          // A slow answer for a workspace this window left repaints nothing.
          if (workspaceIdRef.current!==workspaceId || workspaceAdmission.superseded) return;
          reportShellError(`dohc could not try again to send your edits to ${row.path}.`,error,retry,undefined,identity);
        });
      };
      // The server keeps them, and the owner saved a recovery copy, maybe on another computer: the row stays quiet.
      // Try again still cannot reach an earlier copy of the workspace.
      if (row.recovery==="copied") {
        reportShellFailure({title:`Live editing paused for ${row.path}`,tone:"warning",quiet:true,
          message:"The server could not accept your edits. A recovery copy of them is saved, so the server may now release them.",
          details,...(row.earlier ? {} : {retry}),action:save,identity});
        continue;
      }
      reportShellFailure({title:`Live editing paused for ${row.path}`,
        message:`The server could not accept your edits. dohc kept them ${onServer ? "on the server" : "on this computer"}. Save a recovery copy to get them back.`,
        details,retry,action:save,identity});
    }
  },[captureDecidedFor,syncStatus,workspaceId,workspaceAdmission,reportShellError,reportShellFailure,clearIdentity,openLiveDocuments,liveDocumentStopped]);
  const refreshShareViewRef = useRef<(trigger?: "manual" | "background" | "press-burst") => Promise<ShareViewRefresh>>(async () => "current");
  const shareRefreshFlight = useRef<{ admission: typeof workspaceAdmission; promise: Promise<ShareViewRefresh>; trigger: "manual" | "background" | "press-burst"; followUp?: Promise<ShareViewRefresh> } | null>(null);
  const checkShareAccess = useSharedViewAccess({
    workspaceId,
    enabled: workspaceIsReady && !!shareView && !shareViewDamaged && !shareViewEnded,
    admission: workspaceAdmission,
    relayFailed: captureDecidedFor !== workspaceId || syncStatus === null ? undefined : !!syncStatus.syncFailure,
    pull: async pressBurst => await refreshShareViewRef.current(pressBurst ? "press-burst" : "background") === "changed",
    onPersistentFailure: error => reportShellError("Couldn't refresh the shared view.", error,
      () => { if (!workspaceAdmission.superseded) void refreshShareViewRef.current(); }),
    onVerified: result => {
      if (!shareView) return;
      if (result.status === "ended" || result.status === "needs-reopen" || result.access && result.access !== "edit") {
        const message = result.status === "ended" ? "Your access to this share ended."
          : result.status === "needs-reopen" ? shareReopenMessage
          : shareHadEditRef.current ? "Your access to this share changed. Ask for Edit access, then reopen the share."
          : "This share does not have Edit access.";
        shareViewEndedRef.current = result.status === "ended";
        shareViewWritableRef.current = false;
        shareWriteRefusalRef.current = message;
        setCollectionFieldWriteAccess(workspaceId, message);
      }
      if (result.status === "needs-reopen") setNeedsReopenFor(shareView);
      else if (result.status === "ended") setEndedFor(shareView);
      else if (result.access && result.access !== shareAccess) setAccessFor({ view: shareView, access: result.access });
      if (result.status === "ended" || result.access && result.access !== shareAccess) {
        void props.refreshWorkspaceRegistry().catch(() => undefined);
      }
    },
  });
  useEffect(() => {
    if (shareView) reportShareCapture(shareView.shareId ?? "damaged", shareView.unsavedPaths, shareView.unconfirmedChanges, shareView.ended === true);
  }, [shareView?.shareId, shareView?.unsavedPaths, shareView?.unconfirmedChanges, shareView?.ended, reportShareCapture]);
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
  // The title bar dot and the Agent running notice follow main's run slot.
  const agentActive = useAgentRunActive(workspaceId, workspaceIsReady, (error, retry) =>
    reportLaneFailure("dohc could not refresh agent runs.", error, retry),
  );
  // Restricted Mode in the title bar. A shared view never runs app code, so it
  // shows none.
  const workspaceTrust = useWorkspaceTrust(workspaceId, workspaceIsReady && !shareView, (error, retry) =>
    reportShellError(TRUST_READ_FAILED_MESSAGE, error, retry));
  const { requestTrust: requestWorkspaceTrust } = workspaceTrust;
  const trustWorkspace = useCallback(async (automatic?: true) => {
    try {
      await requestWorkspaceTrust(automatic);
    } catch (error) {
      reportShellError("dohc could not trust this workspace.", error, () => void trustWorkspace());
    }
  }, [reportShellError, requestWorkspaceTrust]);
  // A send that asks an agent Restricted Mode holds opens main's dialog, only
  // for the workspace this shell still shows.
  const trustForHeldAgent = useCallback((forWorkspaceId: string) => {
    if (forWorkspaceId === workspaceId) void trustWorkspace(true);
  }, [trustWorkspace, workspaceId]);
  // The engine's newest file moment, whatever the History page holds: 50
  // newer Collection changes, or a moment that arrived with an old date,
  // can keep a changed file off the first page.
  const [latestMomentOrder, latestMomentLane] = useSnapshotLane(engineHistoryToken, -1);
  // The refresh whose read of that moment may still retry.
  const latestMomentRequest = useRef(0);
  // A file's chat waiting in About, named for the tab it belongs to. It ends
  // when focus leaves that tab, whether or not About is open to show it.
  const [searchChatTarget, setSearchChatTarget] = useState<AboutSearchHit | null>(null);
  const focusedTabRef = useRef(focusedTabPath);
  focusedTabRef.current = focusedTabPath;
  useEffect(() => {
    setSearchChatTarget((target) => (target === null || target.tab === focusedTabPath ? target : null));
  }, [focusedTabPath]);
  const onSearchHitRead = useCallback(() => {
    setSearchChatTarget((target) => (target === null || target.read ? target : { ...target, read: true }));
  }, []);
  // About's file panel stopped showing the hit it read: Back, a switch, or
  // About closing. A newer hit it has not read stays.
  const onSearchHitClosed = useCallback(() => {
    setSearchChatTarget((target) => (target?.read ? null : target));
  }, []);
  const reportSettingsFailure = useCallback(
    (message: string, cause?: unknown, retry?: () => Promise<void>, details?: ReadonlyArray<ErrorDetailField>, identity?: string) => {
      if (workspaceAdmission.superseded || workspaceIdRef.current !== workspaceId) return;
      reportShellFailure({ message, cause, ...(details ? { details } : {}), ...(identity !== undefined ? { identity } : {}), retry: retry ? () => {
        if (workspaceAdmission.superseded || workspaceIdRef.current !== workspaceId) return;
        void retry();
      } : null });
    },
    [workspaceAdmission, workspaceId, reportShellFailure],
  );
  const showSettingsNotice = useCallback(
    (message: string, undo?: () => void) => {
      if (workspaceAdmission.superseded || workspaceIdRef.current !== workspaceId) return;
      showSuccessNotice(message, undo);
    },
    [workspaceAdmission, workspaceId, showSuccessNotice],
  );
  useUsageRecordStops(reportSettingsFailure);

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
    // says engine-on, and every History read would error.
    const token = ++engineHistoryToken.current;
    if (historyReadable(syncStatusLane.latest())) {
      // Three reads ride one refresh, and they answer three different
      // questions. One batch made every answer hostage to the worst of them:
      // a sibling's failure discarded a history page the engine had already
      // served, and the timeline then said it could not load. An
      // aggregate await is hostage to the slowest of them the same way — a
      // sibling that never settles would hold a failed history read in
      // "Loading history..." forever, with no failure and no Try again.
      // So the reads are issued together and handled apart: each lane
      // commits its own answer when that answer arrives. The page read goes
      // out first, and only its own failure is this refresh's failure.
      //
      // The snapshots need no ordering against the page: nothing can block
      // them. Each is handed whole to the lane rule, which judges both ways it
      // can settle.
      const pageRead = refreshHistoryPage(token);
      // Asking again IS this refresh: it re-reads all three, so the lane that
      // failed is read again. Same control the History surface offers for its
      // own read, and the same one the caller runs on any activity.
      const askAgain = () => {
        void refreshHistory().catch((error) =>
          reportShellError("Could not refresh history.", error),
        );
      };
      // Whether an open file changed, read apart from the page, which can
      // succeed while this fails. A shared view re-reads no open file.
      latestMomentRequest.current = token;
      if (!shareView) latestMomentLane.settle(
        token,
        readNewestMomentOrder(
          workspaceId,
          () => latestMomentRequest.current === token && !workspaceAdmission.superseded,
          () => syncStatusLane.latest()?.historyCaptureFailed === true,
        ),
        (order) => order ?? latestMomentLane.latest(),
        (error) =>
          reportLaneFailure("dohc could not check whether open files changed.", error, askAgain),
      );
      syncStatusLane.settle(
        token,
        bridge().getSyncStatus({ workspaceId }),
        (status) => status,
        (error) =>
          reportLaneFailure("dohc could not refresh sync status.", error, askAgain),
      );
      return pageRead;
    }
    // No history source exists: only status refreshes. It rides the same
    // issue order as the engine branch's reads: a second refresh also writes
    // this lane, and an untimed write ranked by arrival undid a newer status.
    // The page reads this refresh supersedes still learn of it, so their
    // failures stay quiet and their retries stop.
    supersedeHistoryPage(token);
    const statusRead = bridge().getSyncStatus({ workspaceId });
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
    await statusRead.then(() => markHistoryReady(), () => undefined);
  }, [
    latestMomentLane,
    !!shareView,
    markHistoryReady,
    refreshHistoryPage,
    reportLaneFailure,
    reportShellError,
    supersedeHistoryPage,
    syncStatusLane,
    workspaceAdmission,
    workspaceId,
  ]);

  // Whether this workspace has engine-backed surfaces at all: history and
  // versions. A shared view renders neither: its open deliberately installed
  // no capture. A registry fact, so this value never waits on anything.
  //
  // Chats is the exception. A share view still installs no capture, so
  // history and versions stay gone, but main answers chat from the SHARE
  // scope instead of a capture, so About opens everywhere. The Chats view
  // does not: the per-file surface answers for a file the share already
  // served, and a workspace-wide listing would be a superset to filter
  // (decision 5, and the shape that produced #627).
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
  // shell's version fetch, the persisted compare and moment-diff tabs, the
  // Chats view, About and tab, the graph's chat mentions and the
  // linked-mentions panel — so the fact is
  // decided once. A surface that re-derives it drifts, which is exactly how
  // the compare tab kept mounting after #614 gated the selector.
  //
  const captureDecided = captureDecidedFor === workspaceId;
  const captureAvailable =
    !shareView && captureDecided && !statusSaysNoRecorder(syncStatus);
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
      // create names the version it forked into, and going back to Main names
      // Main. Nobody has to ask, and there is no window.
      //
      // Nothing is discarded here. This callback also runs for merges and
      // conflict resolutions that never changed the version at all, so a
      // refresh held behind a pagination is judged when that pagination
      // settles, not thrown away on the chance that a switch happened.
      const versionToken = ++engineHistoryToken.current;
      if (activeVersionId !== undefined) {
        // The page on screen belongs to the version the user just left, and
        // the refresh below is the only thing that would replace it — so a
        // refresh that fails used to leave the timeline naming a version
        // nobody is on. The observation retracts it instead. A merge or a
        // conflict resolution names the version the page already describes,
        // so nothing is dropped for them.
        observeEngineVersion(versionToken, activeVersionId);
      } else if (
        // The capture gate again, off the mirrors for the same reason
        // refreshHistory uses them: this callback also runs from the
        // conflict review dialog, which the notice center opens with no
        // version surface on screen. Not asking leaves the previous statement
        // standing — what the catch below already does. Same clauses as
        // `captureAvailable`, so the fetch cannot outlive the render gate.
        !shareView &&
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
            // A boundary that arrives after the answers it must judge is not
            // a boundary: while this lookup was in flight, an answer
            // issued before it could commit against a guard that still named
            // the version the user left. So the committed page faces the
            // same staleness question every arriving answer faces, now that
            // the statement it was missing exists. This lookup settled long
            // after the refresh below ran, so a drop here owes its own
            // re-fetch — the named branch's refresh is already in flight and
            // owes nothing.
            if (observeEngineVersion(versionToken, active)) {
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
      !!shareView,
      observeEngineVersion,
      refreshFiles,
      refreshHistory,
      reportShellError,
      workspaceId,
    ],
  );
  useVersionRounds(workspaceId, beginLineageOperation, onVersionWorkspaceStateChanged);
  // The Explorer selects these paths once their rows render. The newest
  // request wins, so a slow import cannot take the selection back.
  const [explorerReveal, setExplorerReveal] = useState<{ workspaceId: string; paths: readonly string[] } | null>(null);
  const clearExplorerReveal = useCallback(() => setExplorerReveal(null), []);
  const revealRequest = useRef(0);
  // Set once refreshShareView exists below; a failed import's Try again
  // calls it.
  // One import seam for the dialog flow and the OS drag-in flow (the latter
  // passes the preload-resolved absolute paths; see the trust-delta note on
  // ImportWorkspaceFilesPayload). targetDir aims the import at a folder ("" /
  // absent = root) — the drop target, or the folder whose context menu ran
  // "Import Files…". Every import shows what landed, where, and how many
  // sources were skipped — never a silent shrink.
  // Where the import began. An Explorer import selects what landed in the
  // Explorer. The palette and the start surface may show no Explorer, so a
  // notice says what landed.
  const importFiles = useCallback(
    async (from: "explorer" | "palette" | "start-surface", droppedPaths?: string[], targetDir?: string) => {
      const reveal = from === "explorer" ? ++revealRequest.current : 0;
      // Try again on a failed import refreshes the shared view first, since
      // some files may have landed, then asks for files for the same folder.
      // Try again already removed the row, so a refresh that leaves the view
      // stale (damaged, failed, or overtaken by another refresh) says why
      // nothing opened.
      const retry = () => {
        void refreshShareViewRef.current().then((refresh) => {
          if (refresh === "current") {
            void importFiles(from, undefined, targetDir);
            return;
          }
          reportShellFailure({
            message:
              "dohc did not start the import. Refresh the shared view before you import the files that are still missing.",
            kind: "import-files",
          });
        });
      };
      // The contract refuses more dropped items, so say why before asking.
      if (droppedPaths && droppedPaths.length > DROP_IMPORT_LIMITS.items) {
        reportShellFailure({ message: `Could not import files. ${DROP_IMPORT_REFUSALS.items}`, kind: "import-files" });
        return;
      }
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
      const folders = outcome.folders ?? [];
      const skippedSuffix =
        outcome.skipped > 0 ? ` (${outcome.skipped} skipped)` : "";
      // A stopped import's notice is about the stop, and Copy names the skips.
      const skipDetails = importSkipLines(outcome.skipped, outcome.skippedSources ?? []).details;
      // The first copy failed, so nothing landed.
      if (outcome.stop && !outcome.interrupted) {
        reportShellFailure({
          message: fitImportMessage(`Could not import files${skippedSuffix}. `, importStopSentence(outcome.stop), ""),
          details: [...(outcome.stop.detail ? [["Cause", outcome.stop.detail] as const] : []), ...skipDetails],
          retry,
          kind: "import-files",
        });
        return;
      }
      if (outcome.interrupted) {
        // Importing the same files again would land second copies under
        // collision names, so name what already landed. Folders that landed
        // with no file in them would take a second name too.
        const stopSentence = outcome.stop ? ` ${importStopSentence(outcome.stop)}` : "";
        reportShellFailure({
          message:
            count > 0
              ? fitImportMessage(
                  `Imported ${namedPaths(outcome.imported)} before the import stopped.`,
                  stopSentence,
                  " Import only the files that are still missing.",
                )
              : folders.length > 0
                ? fitImportMessage(
                    `Created ${folders.length} ${folders.length === 1 ? "folder" : "folders"} before the import stopped.`,
                    stopSentence,
                    " Delete the empty folders before you import again.",
                  )
                : "The import stopped before dohc could confirm any files. Refresh the shared view before you try again.",
          // The message names at most two files; the report names them all.
          details: [
            ...(outcome.stop?.detail ? [["Cause", outcome.stop.detail] as const] : []),
            ...importedPathDetails(outcome.imported),
            ...skipDetails,
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
      const skipped = outcome.skipped;
      if (count === 0 && folders.length === 0 && skipped === 0) return; // cancelled dialog
      // Each skip names its file and why. The same sources would be skipped
      // again, so there is nothing to try again.
      const reportSkips = (title: string) =>
        reportImportSkips({ title, ...importSkipLines(skipped, outcome.skippedSources ?? []) });
      const notImported = `${skipped} ${skipped === 1 ? "file wasn't" : "files weren't"} imported`;
      if (count === 0 && folders.length === 0) {
        reportSkips(notImported);
        return;
      }
      // The Explorer shows what landed, so its message is only the skip.
      if (from === "explorer") {
        if (skipped > 0) reportSkips(notImported);
        else clearKind("import-files");
      } else {
        // The palette's dialog picks files, never folders.
        const landed = `Imported ${count} ${count === 1 ? "file" : "files"}${targetDir ? ` into ${targetDir}` : ""}.`;
        if (skipped > 0) reportSkips(`${landed} ${skipped} ${skipped === 1 ? "wasn't" : "weren't"} imported.`);
        else showSuccessNotice(landed, undefined, "import-files");
      }
      try {
        await refreshFiles();
      } catch (error) {
        reportShellError("Files imported, but the explorer could not refresh.", error);
        return;
      }
      if (from !== "explorer" || workspaceIdRef.current !== workspaceId || revealRequest.current !== reveal) return;
      // The target folder opens, and what landed in it is selected: each new
      // file, and each new folder that holds the rest.
      mutateWb((state) =>
        (targetDir ? [...ancestorDirs(targetDir), targetDir] : []).reduce<WorkbenchState>(
          (acc, dir) => setFolderExpanded(acc, dir, true),
          state,
        ),
      );
      const prefix = targetDir ? `${targetDir}/` : "";
      const items = [...new Set([
        ...folders,
        ...outcome.imported.map((path) => prefix + path.slice(prefix.length).split("/")[0]),
      ])];
      if (items.length > 0) setExplorerReveal({ workspaceId, paths: items });
    },
    [workspaceId, refreshFiles, reportShellError, reportShellFailure, reportImportSkips, showSuccessNotice, clearKind, mutateWb],
  );
  const importFromExplorer = useCallback(
    (droppedPaths?: string[], targetDir?: string) => void importFiles("explorer", droppedPaths, targetDir),
    [importFiles],
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
      if (!workbenchRestoredRef.current) {
        heldFileOpens.current.push([path, target, scrollTarget]);
        return;
      }
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
  // Set here, not in render, so a file open that lands before this runs still
  // waits behind the held ones.
  useEffect(() => {
    workbenchRestoredRef.current = workbenchRestored;
    if (!workbenchRestored) return;
    for (const held of heldFileOpens.current.splice(0)) openFile(...held);
  }, [openFile, workbenchRestored]);
  // Main writes the copy next to the file and keeps the queue; a slow answer
  // for a workspace this window left paints nothing. One save per file runs
  // at a time, and asking again while it runs waits for it.
  const recoverySaves = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    saveLiveRecoveryCopyRef.current = (id, path, incident) => {
      const key = `${id}\n${path}\n${incident ?? ""}`, running = recoverySaves.current.get(key);
      if (running) return running;
      const saving = bridge().saveOwnerLiveRecoveryCopy({ workspaceId: id, path, ...(incident === undefined ? {} : { incident }) }).then((saved) => {
        if (workspaceIdRef.current !== id) return;
        const opened = saved.copyPath ?? saved.packagePath;
        const slash = saved.packagePath.lastIndexOf("/");
        const folder = slash < 0 ? "the workspace folder" : saved.packagePath.slice(0, slash);
        const kept = saved.keptEdits === "copied" ? " The server may now release your kept edits."
          : saved.keptEdits === "kept" ? ` Your kept edits stay ${saved.storedOn === "server" ? "on the server" : "on this computer"}.` : "";
        showSuccessNotice(saved.copyPath
          ? `Saved a recovery copy of ${path} in ${folder}.${kept}`
          : `Saved your kept edits for ${path} as a recovery package in ${folder}. dohc could not make a readable copy.${kept}`,
        undefined, undefined, { label: "Open", run: () => { if (workspaceIdRef.current === id) openFile(opened); } });
      }, (error: unknown) => {
        if (workspaceIdRef.current !== id) return;
        reportShellError(`dohc could not save a recovery copy of ${path}.`, error, () => { void saveLiveRecoveryCopyRef.current(id, path, incident); });
      }).finally(() => recoverySaves.current.delete(key));
      recoverySaves.current.set(key, saving);
      return saving;
    };
  }, [openFile, showSuccessNotice, reportShellError]);
  const reportKeptCopyFailure = useCallback(
    (message: string, retry: () => void) => reportShellFailure({ message, retry }),
    [reportShellFailure],
  );
  const refreshKeptCopies = useKeptCopyNotices({
    workspaceId,
    workspaceIsReady: workspaceIsReady && !shareView,
    show: showKeptCopies,
    showSaved: showKeptCopySaved,
    reportShellError,
    reportFailure: reportKeptCopyFailure,
    openFile,
  });
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
  const failedSaves = useDocumentSaveNotices({ workspaceId, report: reportShellFailure, clear: clearIdentity, open: openPathWithHeading });
  // A document too large for live editing. The folder holds only the active
  // version's files, so it opens only when the refusal names that version;
  // otherwise the notice names the version to switch to. The path comes from
  // the newest status once the lookup answers, so a rename still lands on it
  // and a refusal that has cleared opens nothing. A newer open, a version
  // change, or another workspace drops the answer.
  const openSharingDeclined = useCallback(
    (versionId: string, objectId: string) => {
      const declinedNow = () =>
        syncStatusLane
          .latest()
          ?.sharingDeclined?.find((entry) =>
            entry.versionId === versionId && entry.objectId === objectId,
          );
      const open = (): void => {
        if (!declinedNow()) return;
        const targetGroupId = wbRef.current.activeEditorGroup;
        const requestSequence = invalidateDeferredFileOpen(targetGroupId);
        const epoch = versionEpochRef.current;
        const isCurrentRequest = () =>
          fileOpenRequests.current.workspaceId === workspaceId &&
          fileOpenRequests.current.sequenceByGroup.get(targetGroupId) ===
            requestSequence &&
          versionEpochRef.current === epoch;
        void bridge()
          .listWorkspaceVersions({ workspaceId })
          .then(({ versions, activeVersionId }) => {
            if (!isCurrentRequest()) return;
            const declined = declinedNow();
            if (!declined) return;
            if (declined.versionId === activeVersionId) {
              openFile(declined.path);
              return;
            }
            const version = versions.find(({ id }) => id === declined.versionId);
            reportShellFailure({
              message: version
                ? `"${declined.path}" is in the version "${version.name}". Switch to that version to open it.`
                : `"${declined.path}" is not in the version you have open.`,
              details: [
                ["File", declined.path],
                ["Version id", declined.versionId],
                ["Active version id", activeVersionId],
              ],
            });
          })
          .catch((error: unknown) => {
            if (!isCurrentRequest()) return;
            reportShellFailure({
              message: "dohc could not open this document.",
              cause: error,
              retry: open,
            });
          });
      };
      open();
    },
    [
      invalidateDeferredFileOpen,
      openFile,
      reportShellFailure,
      syncStatusLane,
      workspaceId,
    ],
  );
  // Opens an app of this workspace in its tab, as Apps does.
  const openAppTab = useCallback(
    (siteRoot: string) => openPathWithHeading(siteTabPath(siteRoot)),
    [openPathWithHeading],
  );
  const openVirtualTab = useCallback(
    (path: string, recent = false) => {
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
      mutateWb(() => (recent ? recordRecentFile(next, path) : next));
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
      openVirtualTab(collectionTabPath(path), true);
    },
    [openVirtualTab],
  );
  // Open automation, from a notice: the automation's Collection opens with
  // the ⚡ panel on its runs, at the run it names, or on its switch when it
  // was switched off. The page takes the ask once and clears it; the
  // counter keeps rising after a clear, so each ask is new to the panel.
  const [automationFocus, setAutomationFocus] = useState<(AutomationFocus & { collectionPath: string }) | null>(null);
  const automationFocusSeq = useRef(0);
  // Each Open rises: only the latest one, still wanted in this workspace,
  // moves the window once main answers.
  const automationOpens = useRef(0);
  // Main finds the Collection by its id, so a Collection that moved still
  // opens. Resolves to a sentence for the notice's row when it cannot open.
  const openAutomation = useCallback(
    // `name` is how the asker already names the automation, for the panel's title before its file is read.
    async (automationId: string, run: string | null, name: string | null = null, controls = false, signal?: AbortSignal): Promise<string | null> => {
      const owner = workspaceId;
      const request = ++automationOpens.current;
      const found = await bridge().findAutomationCollection({ workspaceId: owner, automationId });
      if (workspaceIdRef.current !== owner || automationOpens.current !== request || signal?.aborted) return null;
      if (found.status !== "found") return AUTOMATION_NOT_HERE_NOTE;
      openCollectionTab(found.collectionPath);
      automationFocusSeq.current += 1;
      setAutomationFocus({
        collectionPath: found.collectionPath,
        automationId,
        run,
        controls,
        name,
        seq: automationFocusSeq.current,
      });
      return null;
    },
    [openCollectionTab, workspaceId],
  );
  // Through a share, main finds the automation in the automations.yaml there.
  // Where this window does not show that Collection, the file opens instead.
  const collectionFoldersRef = useRef(collectionFolders);
  collectionFoldersRef.current = collectionFolders;
  const openNoticeAutomation = useCallback(
    (automationId: string, run: string | null, signal: AbortSignal) => openAutomation(automationId, run, null, false, signal),
    [openAutomation],
  );
  const openAutomationControls = useCallback(
    async (automationId: string, { sharedFile, signal }: { sharedFile?: string | undefined; signal?: AbortSignal } = {}): Promise<string | null> => {
      if (sharedFile === undefined) return openAutomation(automationId, null, null, true, signal);
      const owner = workspaceId;
      const request = ++automationOpens.current;
      // A lookup that fails still leaves the file, which holds the switch.
      const found = await bridge().resolveAutomationControls({ workspaceId: owner, path: sharedFile, automationId })
        .catch((): ResolveAutomationControlsResult => ({ status: "missing" }));
      if (workspaceIdRef.current !== owner || automationOpens.current !== request || signal?.aborted) return null;
      const shown = found.status === "found" &&
        (shareView ? shareViewWritable : collectionFoldersRef.current.has(found.collectionPath));
      if (!shown) {
        openFile(sharedFile);
        return null;
      }
      openCollectionTab(found.collectionPath);
      automationFocusSeq.current += 1;
      setAutomationFocus({
        collectionPath: found.collectionPath, automationId: found.automation, run: null, controls: true, name: null, seq: automationFocusSeq.current,
      });
      return null;
    },
    [!!shareView, openAutomation, openCollectionTab, openFile, shareViewWritable, workspaceId],
  );
  // The chat list lives in the left side panel's Chats view.
  const openChatsNavigator = useCallback(() => {
    mutateWb((state) => showView(state, "chats"));
  }, [mutateWb]);
  // A notice's Open shows Chats at the invitation it names.
  const [revealedInvitation, setRevealedInvitation] = useState<ChatsInvitation | null>(null);
  const openChatsInvitation = useCallback((invitation: ChatsInvitation) => {
    setRevealedInvitation(invitation);
    openChatsNavigator();
  }, [openChatsNavigator]);
  const clearRevealedInvitation = useCallback(() => setRevealedInvitation(null), []);
  // Read once: the shell remounts for each workspace. It opens once the saved
  // layout applies, so the layout cannot replace it.
  const openOnReady = useRef(props.openOnReady);
  useEffect(() => {
    const open = openOnReady.current;
    if (!workbenchRestored || open === undefined) return;
    openOnReady.current = undefined;
    if (typeof open === "string") {
      openFile(open);
      return;
    }
    if ("chatsInvitation" in open) {
      openChatsInvitation(open.chatsInvitation);
      return;
    }
    const openSwitch = () => {
      void openAutomationControls(open.automationControls, { sharedFile: open.sharedFile }).then(
        (note) => {
          if (note !== null) reportShellError(note, new Error(note), openSwitch);
        },
        (error: unknown) => reportShellError("dohc could not open this automation.", error, openSwitch),
      );
    };
    openSwitch();
  }, [openAutomationControls, openChatsInvitation, openFile, reportShellError, workbenchRestored]);
  // Files the OS opened with dohc. Main sends each once this window has opened
  // this workspace, and they open in order when the workspace is ready.
  const [openedFromOs, setOpenedFromOs] = useState<readonly string[]>([]);
  useEffect(() => bridge().onWorkspaceActivated((next, file) => {
    if (file !== undefined && next.workspaceId === workspaceId) setOpenedFromOs((files) => [...files, file]);
  }), [workspaceId]);
  useEffect(() => {
    if (!workspaceIsReady || openedFromOs.length === 0) return;
    setOpenedFromOs([]);
    for (const path of openedFromOs) openFile(path);
  }, [openFile, openedFromOs, workspaceIsReady]);
  const clearAutomationFocus = useCallback(() => setAutomationFocus(null), []);
  const recordHistory = useRecordHistory(workspaceId, { reportShellError, clearKind, openAutomationRun: openAutomation });
  // A Collection page's errors and notices, which can answer after this
  // window has left their workspace. Those are dropped, never shown in the
  // next workspace.
  const collectionReports = useMemo(() => {
    const owner = workspaceId;
    return {
      onError: (fallback: string, error: unknown, retry?: (() => void) | null, identity?: string) => {
        if (workspaceIdRef.current === owner) reportShellError(fallback, error, retry ?? null, undefined, identity);
      },
      onSettled: (identity: string) => {
        if (workspaceIdRef.current === owner) clearIdentity(identity);
      },
      onNotice: (message: string, undo?: () => void) => {
        if (workspaceIdRef.current === owner) showSuccessNotice(message, undo);
      },
    };
  }, [workspaceId, reportShellError, clearIdentity, showSuccessNotice]);
  const openDataCollection = useCallback(
    (datasetPath: string, tableId: string) => {
      openVirtualTab(transactionalCollectionTabPath(datasetPath, tableId), true);
    },
    [openVirtualTab],
  );
  // A History timeline row opens its Collection on that Collection's
  // History. The ask names the tab instance the row opened, in the focused
  // group: the same Collection in another group is another instance, and a
  // closed instance never returns. Its page takes the ask once and clears it.
  const [collectionHistoryTab, setCollectionHistoryTab] = useState<WorkbenchTab | null>(null);
  const openCollectionHistory = useCallback((datasetPath: string, tableId: string) => {
    const path = transactionalCollectionTabPath(datasetPath, tableId);
    openVirtualTab(path);
    const { editorGroups, activeEditorGroup } = wbRef.current;
    const group = editorGroups.find((candidate) => candidate.id === activeEditorGroup);
    setCollectionHistoryTab(group?.tabs.find((tab) => tab.path === path) ?? null);
  }, [openVirtualTab]);
  const clearCollectionHistory = useCallback(() => setCollectionHistoryTab(null), []);
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
  const chatPaths = useMemo(() => allTabs(wb).map((tab) => tab.path).filter((path) => parseTab(path).kind === "chat"), [wb.editorGroups]);
  const settingsAgents = useMemo(() => props.userSettings ? listAgents(props.userSettings.settings) : [], [props.userSettings]);
  const chatEditors = useChatEditorTabs({
    workspaceId, onOpen: openVirtualTab, onNavigate: cancelDmNavigation,
    paths: chatPaths,
    activePaths: wb.editorGroups.flatMap((group) => group.activeTab ? [group.activeTab] : []),
    enabled: captureAvailable,
    agents: settingsAgents,
  });
  const selectedChatsNav = focusedTabPath && (parseTab(focusedTabPath)?.kind === "chat")
    ? chatEditors.get(focusedTabPath).nav : undefined;
  const dataCollections = useMemo(() => datasets.flatMap(dataset => dataset.tables.map(table => ({ datasetId: dataset.datasetId, datasetPath: dataset.datasetPath, tableId: table.tableId, name: table.name, archived: dataset.archived }))), [datasets]);
  // The Collections History can name, with their operations' labels, each
  // opening its History on its first table.
  const historyCollections = useMemo<HistoryCollections>(() => new Map(datasets.map(dataset => {
    const path = dataset.datasetPath, table = dataset.tables[0];
    return [dataset.datasetId, {
      name: dataset.name,
      operationLabels: new Map(dataset.operations.map(operation => [operation.name, operation.label])),
      ...(path !== null && table ? { openHistory: () => openCollectionHistory(path, table.tableId) } : {}),
    }];
  })), [datasets, openCollectionHistory]);
  // A new page's tab says its title as it is typed (New pages, below).
  const [newPageTitles, setNewPageTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const tabLabels = useMemo(() => new Map([...knownTabLabels, ...chatEditors.titles, ...newPageTitles,
    ...dataCollections.flatMap(table => table.datasetPath === null ? [] : [[transactionalCollectionTabPath(table.datasetPath, table.tableId), table.name] as const]),
  ]), [knownTabLabels, chatEditors.titles, newPageTitles, dataCollections]);
  const fileEntries = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
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
  useChatDispatchNotices(
    workspaceId, workspaceIsReady, reportShellFailure, clearKind, clearIdentity,
    () => void trustWorkspace(),
    (nav) => { openChatsNavInTab(nav); },
  );
  const customizeContext = useMemo(() => ({ customize }), [customize]);
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
  // The one way a file's chat thread lands in About (search hits, file
  // mentions without channel metadata, and the Chats view "Files" grouping
  // all route here): hand the known thread to About's consume-once seam and
  // force the rail visible.
  // The hit belongs to the focused tab, or to the file tab the caller is
  // opening for it.
  const openChatThreadInPanel = useCallback(
    (
      thread: { id: string; title: string; createdAtMs: number; updatedAtMs: number },
      focusMessageId?: string,
      tab: string | null = focusedTabRef.current,
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
        tab,
        read: false,
      });
      mutateWb((state) => ({ ...state, aboutVisible: true }));
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
    (node: GraphNode) => {
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
  // Engine history diff: one diff tab per group, pointed at each moment.
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
          mutateWb((state) => openMomentDiff(state, momentId, targetGroupId));
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
  const openHistoryView = useCallback(() => {
    mutateWb((state) => ({
      ...setView(state, "history"),
      sidebarVisible: true,
    }));
  }, [mutateWb]);
  // Open History shows the timeline with the recovery change open beside it.
  const openCaptureRecovery = useCallback(
    (momentId: string, path: string) => {
      openHistoryView();
      openMomentDiffTab(momentId, path);
    },
    [openHistoryView, openMomentDiffTab],
  );
  const captureRecoveries = useCaptureRecoveryNotices({
    workspaceId,
    workspaceIsReady: workspaceIsReady && !shareView,
    show: showCaptureRecoveries,
    reportShellError,
    openRecovery: openCaptureRecovery,
  });
  const [heldEvent, setHeldEvent] = useState<{ admission: typeof workspaceAdmission; files: CaptureFileHold[] } | null>(null);
  const heldFiles = heldEvent?.admission === workspaceAdmission ? heldEvent.files : syncStatus?.heldFiles;
  const retryHeldCapture = useCaptureHoldNotices({ workspaceId, heldFiles,
    show: showCaptureHolds, reportShellError, reportShellFailure });
  useEffect(() => {
    return bridge().onCaptureHolds(event => {
      if (event.workspaceId !== workspaceId || workspaceAdmission.superseded) return;
      setHeldEvent(current => workspaceAdmission.superseded ? current : { admission: workspaceAdmission, files: event.heldFiles });
    });
  }, [workspaceId, workspaceAdmission]);
  // Restore resolves this change's notice, including a Copy fallback that
  // the engine no longer lists.
  const onHistoryRestored = useCallback((momentId?: string) => {
    if (momentId) captureRecoveries.restored(momentId);
    refreshAfterHistoryRestore();
    void captureRecoveries.refresh();
  }, [captureRecoveries, refreshAfterHistoryRestore]);
  // One row per file in Notices: a newer failure for the file replaces it. A
  // shared live file's refusal goes to its kept typing's row instead, which
  // then says to replace the file's text with the kept version. A refusal by
  // History's rules takes the sentence as its title and the rules' words as
  // its body, so the clamp never hides what to fix.
  const reportRestoreError = useCallback(
    (fallback: string, error: unknown, retry: () => void, identity: string, path: string) => {
      if (captureRecoveries.restoreRefused(path, error)) return;
      if (readError(error).refusal === "synced-deletion") error = new SyncedDeletionRevivalError(path, { cause: error }, true);
      const { words } = readError(error);
      if (words && isRestorePolicyRefusal(error)) {
        reportShellFailure({ title: fallback.replace(/\.$/u, ""), message: words, cause: error, retry, identity });
      } else reportShellError(fallback, error, retry, undefined, identity);
    },
    [captureRecoveries, reportShellError, reportShellFailure],
  );
  // Try again on a failed restore opens the change's tab, and that page
  // restores again once a fresh read allows it, with its Undo restore after.
  const [restoreRequest, setRestoreRequest] = useState<{ workspaceId: string; momentId: string } | null>(null);
  const reopenRestore = useCallback(
    (momentId: string, path: string) => {
      setRestoreRequest({ workspaceId, momentId });
      openMomentDiffTab(momentId, path);
    },
    [openMomentDiffTab, workspaceId],
  );
  const takeRestoreRequest = useCallback(() => setRestoreRequest(null), []);
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
      if (TAB_KINDS[parseTab(path).kind].virtual) {
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
      openChatThreadInPanel(thread, focusMessageId, thread.path ?? undefined);
      if (thread.path) openFile(thread.path);
    },
    [openChatThreadInPanel, openFile],
  );

  // Open a file and land at a line: a search result, or a link in About.
  const openPathAtLine = useCallback(
    (path: string, line: number) => {
      // Landing at a line is a destination change openFile cannot see: the
      // line may be in the file the user is already reading.
      invalidateDmNavigation(dmNavigationRequest);
      openFile(path, undefined, {
        line,
        nonce: ++scrollNonce.current,
      });
    },
    [openFile],
  );

  // Search-result click: open + land at the line (source mode this phase);
  // chat results open in About instead.
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
      openPathAtLine(path, line);
    },
    [openChatThreadInPanel, openPathAtLine],
  );

  // New pages. A page's title and icon wait here, as frontmatter, until the
  // person leaves the title. Its tab then becomes its file's, and the file
  // keeps the page's host while that tab is open, so the editor that opens
  // under it takes the keystrokes the page held (NewPage).
  const newPageDrafts = useRef(new Map<string, { draft: string; body: string; writing: Promise<string | null> | null }>());
  const [bornPages, setBornPages] = useState<ReadonlyMap<string, { id: string; handedOff: boolean }>>(() => new Map());
  // A created page's title, icon and body wait here, by its file, until its
  // editor takes them, with the text its file or recovery already holds. A
  // page that unmounts first gets them back when it mounts again.
  const bornDrafts = useRef(new Map<string, { draft: string; body: string; held: string }>());
  // Text no editor has taken goes to recovery, where its file shows it,
  // unless the file or recovery already holds it. The page stays, so what is
  // typed after goes the same way.
  const keepBornDraft = useCallback((path: string) => {
    const born = bornDrafts.current.get(path);
    if (!born) return;
    const text = newPageText(born);
    if (text === born.held) return;
    captureOrphanedDraft(workspaceId, path, text);
    born.held = text;
  }, [workspaceId]);
  const retireBornDraft = useCallback((path: string) => {
    keepBornDraft(path);
    bornDrafts.current.delete(path);
  }, [keepBornDraft]);
  const openNewPage = useCallback(
    (folder: string) => {
      const path = newPageTabPath(crypto.randomUUID(), folder);
      newPageDrafts.current.set(path, { draft: "", body: "", writing: null });
      openVirtualTab(path);
    },
    [openVirtualTab],
  );
  // The tab follows the title without holding up the keystroke.
  const newPageDraftChanged = useCallback((tabPath: string, draft: string) => {
    const pending = newPageDrafts.current.get(tabPath);
    if (pending) pending.draft = draft;
    const title = displayFrontmatterValue(parseFrontmatter(draft).meta.title);
    startTransition(() =>
      setNewPageTitles((titles) => (titles.get(tabPath) ?? "") === title ? titles : new Map(titles).set(tabPath, title)));
  }, []);
  // A closed page's draft, title and host go with its tab, and a created
  // page's tab is its file's.
  useEffect(() => {
    const open = new Set(allTabs(wb).map((tab) => tab.path));
    for (const [path, page] of newPageDrafts.current) {
      if (!open.has(path) && !page.writing) newPageDrafts.current.delete(path);
    }
    for (const path of [...bornDrafts.current.keys()]) {
      if (!open.has(path)) retireBornDraft(path);
    }
    const keepOpen = <T,>(pages: ReadonlyMap<string, T>) =>
      [...pages.keys()].every((path) => open.has(path)) ? pages : new Map([...pages].filter(([path]) => open.has(path)));
    setBornPages(keepOpen);
    setNewPageTitles(keepOpen);
  }, [retireBornDraft, wb]);
  // Writes a new page's file, named from its title, and gives its path, or
  // null if it was not written. An opened file starts empty, so its live
  // session opens at once, and its editor takes the title and body from the
  // page; a closed one starts with the title, icon and body. A name another
  // file took first moves on to the next number.
  const writeNewPage = useCallback(
    (tabPath: string, open: boolean): Promise<string | null> => {
      const page = parseTab(tabPath);
      const pending = newPageDrafts.current.get(tabPath);
      if (page.kind !== "newPage" || !pending) return Promise.resolve(null);
      if (pending.writing) return pending.writing;
      const selection = workspaceSelection.current;
      const title = displayFrontmatterValue(parseFrontmatter(pending.draft).meta.title);
      const stem = pageFileStem(title, bridge().platform);
      const occupied = new Set([...files.map((file) => file.path), ...folders].map((path) => path.toLowerCase()));
      const initialText = open ? "" : newPageText(pending);
      const create = async (): Promise<string> => {
        for (;;) {
          const relativePath = nextPagePath(page.folder, stem, occupied, bridge().platform);
          try {
            return (await bridge().createWorkspaceFile({ workspaceId, relativePath, initialText, exclusive: true })).path;
          } catch (error) {
            if (!isPathTaken(error)) throw error;
            occupied.add(relativePath.toLowerCase());
          }
        }
      };
      pending.writing = create().then(
        (path) => {
          if (workspaceSelection.current !== selection) return null;
          newPageDrafts.current.delete(tabPath);
          if (open) {
            bornDrafts.current.set(path, { draft: pending.draft, body: pending.body, held: initialText });
            setBornPages((pages) => new Map(pages).set(path, { id: page.id, handedOff: false }));
            mutateWb((state) =>
              replaceTab(ancestorDirs(path).reduce((next, dir) => setFolderExpanded(next, dir, true), state), tabPath, path));
          }
          void refreshFiles();
          return path;
        },
        (error: unknown) => {
          pending.writing = null;
          if (workspaceSelection.current !== selection) return null;
          reportShellError("Could not create the page.", error, () => void writeNewPage(tabPath, open));
          return null;
        },
      );
      return pending.writing;
    },
    [files, folders, mutateWb, refreshFiles, reportShellError, workspaceId],
  );
  const pageHandedOff = useCallback((path: string, taken: boolean) => {
    if (taken) bornDrafts.current.delete(path);
    else retireBornDraft(path);
    setBornPages((pages) => {
      const page = pages.get(path);
      return page && !page.handedOff ? new Map(pages).set(path, { ...page, handedOff: true }) : pages;
    });
  }, [retireBornDraft]);
  // A typed page not yet created is written when the app quits, the window
  // closes or the workspace switches, as closing its tab writes it, and its
  // tab becomes its file's in case the quit stops. A page that cannot be
  // written stops the quit, and its error says why. What a created page
  // holds that its editor has not taken goes to recovery, and the page stays
  // in case the quit stops.
  const keepBornDrafts = useRef<() => void>(() => undefined);
  keepBornDrafts.current = () => {
    for (const path of bornDrafts.current.keys()) keepBornDraft(path);
  };
  const writeTypedPages = useRef<() => Promise<void>>(async () => undefined);
  writeTypedPages.current = async () => {
    const pages = [...newPageDrafts.current].filter(([, page]) => typedNewPage(page)).map(([path]) => path);
    const written = await Promise.all(pages.map((path) => writeNewPage(path, false)));
    mutateWb((state) => pages.reduce((next, tabPath, index) => {
      const path = written[index];
      return path ? replaceTab(next, tabPath, path) : next;
    }, state));
    keepBornDrafts.current();
    if (written.includes(null)) throw new Error("Could not create the page.");
  };
  useEffect(() => registerPendingEditorDraft(
    () =>
      [...newPageDrafts.current.values()].some(typedNewPage) ||
      [...bornDrafts.current.values()].some((page) => newPageText(page) !== page.held),
    () => writeTypedPages.current(),
    () => keepBornDrafts.current(),
  ), []);

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
      const closeAfterFlush = () => {
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
      };
      // A typed new page is written as it closes, and stays open if it
      // cannot be. An untouched one leaves nothing. A page whose file was
      // already being created for its editor has become that file's tab,
      // which closes in its place.
      const typedPages = [...requested.keys()].filter((tab) => {
        const page = newPageDrafts.current.get(tab.path);
        return page !== undefined && typedNewPage(page);
      });
      if (typedPages.length === 0) {
        closeAfterFlush();
        return;
      }
      void Promise.all(typedPages.map((tab) => writeNewPage(tab.path, false))).then((written) => {
        typedPages.forEach((tab, index) => {
          const groupId = requested.get(tab)!;
          const tabs = wbRef.current.editorGroups.find((candidate) => candidate.id === groupId)?.tabs ?? [];
          const path = written[index];
          if (path && tabs.includes(tab)) return;
          requested.delete(tab);
          const fileTab = path ? tabs.find((candidate) => candidate.path === path) : undefined;
          if (fileTab) requested.set(fileTab, groupId);
        });
        if (requested.size > 0) closeAfterFlush();
      });
    },
    [
      flushStableDrafts,
      hasDrafts,
      invalidateDeferredFileOpen,
      mutateWb,
      reportShellError,
      writeNewPage,
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

  // Every tab showing a file, in every group, as an import's Undo closes them.
  const closePathTabs = useCallback(
    (path: string) => {
      void closeTabsAfterFlush(wbRef.current.editorGroups.flatMap((group) =>
        group.tabs.filter((tab) => tab.path === path).map((tab) => ({ groupId: group.id, tab }))));
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
    } else if (group.tabs.length === 0 && bridge().platform === "darwin") {
      // With nothing left to close, macOS closes the window.
      void bridge().closeThisWindow().catch((error) =>
        reportShellError("Could not close this window.", error));
    }
  }, [closeTabsAfterFlush, mutateWb, reportShellError]);

  // ⌃Tab and its alternates cycle through the focused group's tabs.
  const showAdjacentTab = useCallback(
    (step: 1 | -1) => {
      const group = activeGroup(wbRef.current);
      const path = adjacentTabPath(group, step);
      if (path !== null) activateEditorTab(group.id, path);
    },
    [activateEditorTab],
  );

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
          const viewKind = fileKindForPath(nextActiveTab).displayKind;
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
    (path: string, expandPath = false) => {
      mutateWb((state) =>
        [...ancestorDirs(path), ...(expandPath ? [path] : [])].reduce<WorkbenchState>(
          (acc, dir) => setFolderExpanded(acc, dir, true),
          { ...state, activeView: "explorer", sidebarVisible: true },
        ),
      );
      revealRequest.current += 1;
      setExplorerReveal({ workspaceId, paths: [path] });
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
    shareMounts,
    mountCount,
    mountContentEpoch,
    reloadShareMounts,
    refreshShareMounts,
    unmountShare,
    onMountsChanged,
  } = useShareMounts(
    workspaceId,
    workspaceShareMounts,
    props.refreshWorkspaceRegistry,
    onExplorerPathsChanged,
    refreshFiles,
    reportShellError,
    showSuccessNotice,
  );

  // Reveal-then-create: the inline editbox lives in the explorer's Files
  // tree, so make it visible first (never setView — re-selecting the active
  // view toggles the panel).
  const requestExplorerFolder = useCallback(() => {
    mutateWb((state) => setExplorerMode({ ...state, activeView: "explorer", sidebarVisible: true }, "files"));
    setNewFolderRequest((current) => (current ?? 0) + 1);
  }, [mutateWb]);

  const setExplorerFolderExpanded = useCallback(
    (path: string, expanded: boolean) =>
      mutateWb((state) => setFolderExpanded(state, path, expanded)),
    [mutateWb],
  );
  const toggleExplorerFolder = useCallback(
    (path: string) => mutateWb((state) => toggleFolderExpanded(state, path)),
    [mutateWb],
  );
  // An app folder's pin is its sidebar pin, kept in the settings file.
  // Anything else is pinned in Home, in the workspace's ui-state.
  const toggleExplorerPin = useCallback(
    (path: string) => {
      if (appFolders.has(path)) void setAppPinned(path, !pinnedRoots.includes(path));
      else mutateWb((state) => togglePinned(state, path));
    },
    [appFolders, mutateWb, pinnedRoots, setAppPinned],
  );
  const setExplorerModeInWb = useCallback(
    (mode: ExplorerMode) => mutateWb((state) => setExplorerMode(state, mode)),
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

  // Human and agent creation share the same record identity and recovery path.
  const pendingRecordPaths = useRef(new Set<string>());
  const createCollectionRecord = useCallback(
    async (collectionPath: string) => {
      const prefix = `${collectionPath}/`;
      const scopedFiles = files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
      const scopedFolders = folders
        .filter((folder) => folder.startsWith(prefix))
        .map((folder) => folder.slice(prefix.length));
      scopedFolders.push(...[...pendingRecordPaths.current].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length)));
      const selection = workspaceSelection.current;
      const name = uniqueUntitledPath(scopedFiles, scopedFolders, "md").slice(0, -3);
      const reservedPath = `${collectionPath}/${name}.md`;
      pendingRecordPaths.current.add(reservedPath);
      const execute = async (recordId?: string): Promise<void> => {
        if (workspaceSelection.current !== selection) return;
        if (shareView && !shareViewWritableRef.current) {
          const message = shareWriteRefusalRef.current;
          reportShellError(message, new Error(message));
          return;
        }
        try {
          const result = await bridge().createCollectionRecord({ workspaceId, collectionPath, name, recordId });
          if (workspaceSelection.current !== selection) return;
          if ("kind" in result) {
            reportShellError("dohc could not finish this record.", new CreationPartialError(result),
              result.retry.mode === "resume" ? () => void execute(result.retry.recordId) : null);
            return;
          }
          await refreshFiles();
          if (workspaceSelection.current !== selection) return;
          if (result.delivery === "refused") {
            if (shareView) await checkShareAccess();
            if (workspaceSelection.current !== selection) return;
            const restricted = shareView && !shareViewWritableRef.current;
            const reason = restricted ? shareWriteRefusalRef.current : result.reason ?? "The sync relay did not accept this record.";
            reportShellError(reason, new Error(reason), restricted ? null : () => void createCollectionRecord(collectionPath));
          }
          openFile(result.path);
        } catch (error) {
          if (shareView && shouldRecheckShareAccess(error)) await checkShareAccess();
          if (workspaceSelection.current !== selection) return;
          if (shareView && !shareViewWritableRef.current) {
            const message = shareWriteRefusalRef.current;
            reportShellError(message, new Error(message));
          } else reportShellError("Could not create a record.", error);
        }
      };
      try { await execute(); }
      finally { pendingRecordPaths.current.delete(reservedPath); }
    },
    [files, folders, openFile, refreshFiles, reportShellError, workspaceId, !!shareView],
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
  // Add an app here… opens the Explorer with its Apps section open and its
  // first row focused. The request belongs to one workspace, like a reveal.
  const [appsReveal, setAppsReveal] = useState<string | null>(null);
  const clearAppsReveal = useCallback(() => setAppsReveal(null), []);
  const showAppsInExplorer = useCallback(() => {
    mutateWb((state) => setExplorerMode(showView(state, "explorer"), "home"));
    setAppsReveal(workspaceId);
  }, [mutateWb, workspaceId]);
  const explorerApps = useMemo<ExplorerApps>(
    () => ({
      ...workspaceApps,
      pinnedApps: pinnedRoots,
      onSetPinned: setAppPinned,
      reveal: appsReveal === workspaceId,
      onRevealed: clearAppsReveal,
    }),
    [appsReveal, clearAppsReveal, pinnedRoots, setAppPinned, workspaceApps, workspaceId],
  );
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
  const onExplorerRefresh = useCallback(() => {
    void refreshFiles().catch((error) =>
      reportShellError("Could not refresh workspace files.", error),
    );
  }, [refreshFiles, reportShellError]);

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
          const viewKind = fileKindForPath(nextActiveTab).displayKind;
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
      if (TAB_KINDS[parseTab(tab.path).kind].singleton) {
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
        const viewKind = fileKindForPath(tab.path).displayKind;
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
      } else if (command === "copy-path" && path && !TAB_KINDS[parseTab(path).kind].virtual) {
        void navigator.clipboard?.writeText(path);
      } else if (command === "show-in-explorer" && path) {
        const tab = parseTab(path);
        const appRoot = tab.kind === "site" ? tab.siteRoot : null;
        if (appRoot !== null) showPathInExplorer(appRoot, true);
        else if (!TAB_KINDS[tab.kind].virtual) showPathInExplorer(path);
      } else if (command === "open-history") {
        openHistoryView();
      } else if (command === "connect-cloud") {
        openCloud();
      } else if (command === "settings") {
        openSettings();
      } else if (command === "check-updates") {
        void runDesktopUpdate("check");
      } else if (command === "install-update") {
        void runDesktopUpdate("install");
      } else if (command === "toggle-theme") {
        toggleTheme();
      }
    },
    [
      closeGroupAfterFlush,
      closeFileTab,
      closeOtherTabs,
      runDesktopUpdate,
      openCloud,
      openHistoryView,
      openSettings,
      moveTabIntoNewGroup,
      showPathInExplorer,
    ],
  );

  const showWorkbenchMenu = useCallback(
    async (
      context: "tab" | "status",
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
      recoverLiveDrafts(workspaceId, () => !cancelled && !workspaceAdmission.superseded, reportShellError);
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

  // Main also sets drafts aside while the workspace is open, such as the text
  // of a file deleted outside dohc, and removes them once a save writes it.
  useEffect(() => {
    let current = true;
    const unsubscribe = bridge().onLiveDraftRecoveryChanged((event) => {
      if (event.workspaceId === workspaceId) {
        recoverLiveDrafts(workspaceId, () => current && !workspaceAdmission.superseded, reportShellError);
      }
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [workspaceId, workspaceAdmission, reportShellError]);

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
          (error) => {
            if (!workspaceAdmission.superseded) reportShellError("Could not refresh workspace files.", error);
          },
        );
      }
      void refreshHistory().catch((error) => {
        if (!workspaceAdmission.superseded) reportShellError("Could not refresh history.", error);
      });
      readCloudStatusAgainIfBusy();
      if (!shareView || shareViewReadsCollections) void refreshCollections();
      if (!shareView) {
        void refreshDatasets().catch(error => {
          if (!workspaceAdmission.superseded) reportShellError("Could not read Collections.", error);
        });
        void refreshKeptCopies();
        // Capture records kept typing in the batch that took the outside text.
        void captureRecoveries.refresh();
      }
    });
    const unsubscribe = bridge().onWorkspaceActivity(
      (event: WorkspaceActivityEvent) => {
        const paths =
          event.workspaceId === workspaceId ? event.paths : undefined;
        if (event.workspaceId === workspaceId &&
          (!paths?.length || paths.some(path => isWorkspaceVisibilityPolicyPath(path, bridge().platform)))) invalidateVisibility();
        if (event.workspaceId === workspaceId && event.pathSetChanged === false &&
          (!paths?.length || activityPathsAffectWorkspaceListing(paths, bridge().platform))) {
          if (filesRefreshMode !== "full") filesRefreshMode = "cached";
        } else if (!paths?.length) {
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
    workspaceAdmission,
    refreshFiles,
    refreshHistory,
    reportShellError,
    !!shareView,
    shareViewReadsCollections,
    refreshCollections,
    refreshDatasets,
    refreshKeptCopies,
    captureRecoveries,
    hasCommittedListing,
    invalidateVisibility,
    readCloudStatusAgainIfBusy,
  ]);

  const openWorkspaceFolder = useCallback(async function openWorkspaceFolder() {
    try {
      const picked = await bridge().pickWorkspaceRoot();
      if (!picked) return;
      const attached = await bridge().attachWorkspaceFolder({ rootPath: picked });
      props.onSwitchWorkspace(attached);
    } catch (error) {
      reportShellError("Could not open that workspace folder.", error, () => void openWorkspaceFolder());
    }
  }, [props.onSwitchWorkspace, reportShellError]);

  // The file Share… shares: the active editor's, wherever it draws Share file.
  const activeSharePath =
    activeDocumentPath && !shareView && !isMountedSharePath(activeDocumentPath)
      ? activeDocumentPath
      : null;
  // The command registry: the palette renders it and the application menu
  // routes through it (onMenuCommand below) — one definition per action.
  const commandContext = useMemo<CommandContext>(
    () => ({
      // A damaged marker's grant cannot be read, so it names no level.
      // These are the renderer's latest access facts, so until the registry the
      // Explorer menu reads catches up, the two menus can differ either way.
      shareView: isShareView
        ? { access: shareViewDamaged ? null : shareAccess ?? null, ended: shareViewEnded }
        : null,
      activeDocumentKind: activeDocumentPath ? fileKindForPath(activeDocumentPath).displayKind : null,
      activeDocumentShareable: activeSharePath !== null,
      pinnedApps,
      updateStatus: desktopUpdate.state?.status ?? null,
    }),
    [isShareView, shareViewDamaged, shareAccess, shareViewEnded, activeDocumentPath, activeSharePath, pinnedApps, desktopUpdate.state?.status],
  );
  const commandHandlers = useMemo<CommandHandlers>(
    () => ({
      "new-file": () => openNewPage(""),
      "new-file-at-path": () => setNewFileOpen(true),
      "new-drawing": () => void createUntitledDrawing(),
      "new-folder": requestExplorerFolder,
      "new-collection": () => setNewCollectionFolder(""),
      "quick-open": () => setQuickOpenOpen(true),
      "open-workspace": () => void openWorkspaceFolder(),
      "import-files": () => void importFiles("palette"),
      "export-workspace": () =>
        void bridge().exportWorkspaceZip({ workspaceId }).catch((error) =>
          reportShellError("Could not export this workspace.", error),
        ),
      "toggle-sidebar": toggleSidePanel,
      "close-tab": closeActiveTab,
      "next-tab": () => showAdjacentTab(1),
      "previous-tab": () => showAdjacentTab(-1),
      "new-editor-group-right": () => openEditorGroupRight(),
      "toggle-markdown-source": () => toggleSource(wbRef.current.activeEditorGroup),
      "share-file": () => {
        if (activeSharePath) onSharePath(activeSharePath);
      },
      "toggle-about": () => mutateWb(toggleAbout),
      "show-explorer": () => mutateWb((state) => showView(state, "explorer")),
      "show-chats": () => mutateWb((state) => showView(state, "chats")),
      "show-search": () => mutateWb((state) => showView(state, "search")),
      "show-graph": () => mutateWb((state) => showView(state, "graph")),
      "show-history": () => mutateWb((state) => showView(state, "history")),
      "connect-cloud": openCloud,
      "settings": () => openSettings(),
      "settings-appearance": () => openSettings("appearance"),
      "settings-agents": () => openSettings("agents"),
      "check-updates": () => void runDesktopUpdate("check"),
      "download-update": () => void runDesktopUpdate("download"),
      "install-update": () => void runDesktopUpdate("install"),
      "toggle-theme": toggleTheme,
      "zoom-in": () =>
        void bridge().stepWindowZoom({ step: "in" }).catch((error) =>
          reportShellError("Could not change the window zoom.", error),
        ),
      "zoom-out": () =>
        void bridge().stepWindowZoom({ step: "out" }).catch((error) =>
          reportShellError("Could not change the window zoom.", error),
        ),
      "zoom-reset": () =>
        void bridge().stepWindowZoom({ step: "reset" }).catch((error) =>
          reportShellError("Could not change the window zoom.", error),
        ),
      ...Object.fromEntries(pinnedApps.map((app) => [
        pinnedAppCommandId(app.root),
        () => mutateWb((state) => showView(state, appViewId(app.root))),
      ] as const)),
    }),
    [
      commandContext,
      activeSharePath,
      onSharePath,
      toggleSidePanel,
      createUntitledDrawing,
      openWorkspaceFolder,
      closeActiveTab,
      showAdjacentTab,
      importFiles,
      mutateWb,
      openNewPage,
      requestExplorerFolder,
      runDesktopUpdate,
      openCloud,
      openEditorGroupRight,
      openSettings,
      reportShellError,
      toggleSource,
      workspaceId,
    ],
  );
  const runCommand = useCallback((id: CommandId) => {
    if (!openingCoverShown.current || SETTINGS_COMMANDS.has(id)) commandHandlers[id]();
  }, [commandHandlers]);
  const commands = useMemo<Command[]>(
    () => paletteCommandRows(commandContext).map((row) => ({ ...row, run: () => runCommand(row.id) })),
    [commandContext, runCommand],
  );
  // The start surface's tiles: each kind's existing create action, where the
  // workspace allows it. An app is a folder, so it needs folder creation.
  const startActions = useMemo(
    () => ({
      ...(isCommandAvailable("new-file", commandContext) ? { markdown: commandHandlers["new-file"] } : {}),
      ...(isCommandAvailable("new-collection", commandContext) ? { collection: commandHandlers["new-collection"] } : {}),
      ...(isCommandAvailable("new-drawing", commandContext) ? { drawing: createUntitledDrawing } : {}),
      ...(isCommandAvailable("new-folder", commandContext) ? { app: createFirstApp } : {}),
    }),
    [commandContext, commandHandlers, createUntitledDrawing, createFirstApp],
  );
  // Files dropped on the start surface land at the workspace root.
  const importDroppedFiles = useCallback((dropped: File[]) => {
    const paths = bridge().getDroppedFilePaths(dropped);
    if (paths.length > 0) void importFiles("start-surface", paths);
  }, [importFiles]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A stopped workspace answers no workspace shortcut.
      if (storeUpdateRequiredRef.current) return;
      const platform = bridge().platform;
      // Typing matches no chord, so a keystroke never pays for the page-wide
      // modal query, which grows with a long note's elements.
      const chord = matchShellShortcutChord(event, platform);
      if (!chord) return;
      const blockingModal = hasBlockingModal();
      const command = blockingModal ? chord : matchShellShortcut(event, platform);
      if (!command) return;
      // A modal owns the keyboard while it is visible. Native/main-owned
      // shortcuts such as Close Window and zoom never reach this listener,
      // so they continue to work over a modal.
      if (blockingModal) {
        // Consume the chord before macOS can route it through the menu.
        // Text inputs keep native undo.
        if (command !== "history-restore-undo" && platform === "darwin") event.preventDefault();
        return;
      }
      if (command === "settings") {
        event.preventDefault();
        openSettings();
        return;
      }
      if (command === "history-restore-undo") {
        const activeUndo = undoForEditor(wbRef.current.activeEditorGroup);
        if (activeUndo?.acceptsEvent(event)) {
          event.preventDefault();
          void activeUndo.run().catch((error) =>
            reportShellError("Could not undo the last history restore.", error),
          );
        }
        return;
      }
      // Editors see the key first. preventDefault keeps the macOS native
      // fallback from dispatching the same command a second time.
      event.preventDefault();
      if (command === "command-palette") setPaletteOpen((open) => !open);
      else if (command === "quick-open") setQuickOpenOpen((open) => !open);
      else if (isCommandAvailable(command, commandContext)) runCommand(command);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    commandContext,
    runCommand,
    openSettings,
    reportShellError,
    undoForEditor,
  ]);

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      countInput();
      // App-menu commands originate outside the modal; only keydown is guarded.
      if (isEditorMenuCommand(command)) sendToFocusedEditor(command);
      else if (command === "command-palette") setPaletteOpen(true);
      else if (isCommandAvailable(command, commandContext)) runCommand(command);
    });
  }, [commandContext, runCommand]);

  // Received workspaces refresh on open and on demand; ended copies stay local.
  // The relay-derived generic chat fact selects the Comment banner's next
  // step. It does not grant a desktop write: every received share's Chats are
  // read-only in Phase 3 because the store cannot prove per-row delivery.
  const shareViewHasIndependentChat =
    !shareViewDamaged &&
    !shareViewEnded &&
    shareAccess === "comment" &&
    shareView?.genericChatWritable === true;
  const shareGranterName = shareSenderLabel(shareView?.sharerName, shareView?.granterEmail);
  const shareBannerText = !shareView
    ? ""
    : shareViewEnded
      ? `This share was ended${shareView.granterEmail ? ` by ${shareView.granterEmail}` : ""}. Your copy stays readable but won't update anymore.`
      : shareViewDamaged
        ? !shareView.recipientUserId || needsReopenFor === shareView
          ? "This share must be reopened. Choose Forget in the workspace menu, then open the share code again. Forget keeps your files."
          : "dohc can't read what this share grants. Open the share again to restore it."
        : shareViewWritable
          ? `Shared view from ${shareGranterName}. Markdown edits save to the live host. Other file changes need their acceptance.`
          : shareViewHasIndependentChat
            ? `Shared view from ${shareGranterName}. Files and Chats are read-only here. Ask ${shareGranterName} where to continue the conversation.`
            : shareAccess === "comment"
              ? `Shared view from ${shareGranterName}. Files are read-only here. Continue commenting in the browser where you opened the link.`
              : `Shared view from ${shareGranterName} — read-only. Ask ${shareView.granterEmail ?? "them"} for changes.`;
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
    if (workspaceAdmission.superseded) return;
    const token = ++shareSkippedToken.current;
    const workspaces = await props.refreshWorkspaceRegistry();
    if (workspaceAdmission.superseded || token !== shareSkippedToken.current) return;
    const entry = workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    const skipped = entry?.shareView?.skippedOps ?? null;
    // Only what the user has not seen. Acknowledging hides the warning
    // without deleting the record, so this reads the marker rather than the
    // record's presence.
    setShareSkipped(hasUnacknowledgedShareSkips(skipped) ? skipped : null);
  }, [props.refreshWorkspaceRegistry, workspaceId, workspaceAdmission]);
  const {
    automationHolds, automationHoldsUnreadable, allowAutomationHold, resetAutomationHolds, revealAutomationHolds,
    automationStops, dismissAutomationStops,
  } = useAutomationHolds(
    workspaceId,
    workspaceIsReady,
    reportShellError,
    serverHoldNoticesKey(props.sentNotices?.notices, workspaceId),
  );
  const crashReportNotice = useCrashReport({
    reportError: reportShellError,
    showSuccess: showSuccessNotice,
  });
  // The person learns about reports before any leaves. The notice is about
  // this computer, not the workspace, so any open window shows it.
  const reportsNoticeRow = shellErrors.find((error) => error.kind === "reports");
  const reportsNoticeShown = useReportsNotice({
    workspaceId,
    privacy: props.userSettings?.settings.privacy ?? null,
    notice: reportsNoticeRow?.reports ? { id: reportsNoticeRow.id, reports: reportsNoticeRow.reports } : null,
    show: (reports) => showReportsNotice(reports, () => openSettings("privacy")),
  });

  const refreshShareView = useCallback((trigger: "manual" | "background" | "press-burst" = "manual"): Promise<ShareViewRefresh> => {
    const active = shareRefreshFlight.current;
    if (active?.admission === workspaceAdmission) {
      if (trigger !== active.trigger) {
        active.followUp ??= active.promise.catch(() => "stale" as const).then(() =>
          workspaceAdmission.superseded ? "stale" : refreshShareViewRef.current(trigger));
        return active.followUp;
      }
      return active.promise;
    }
    const refresh = async (): Promise<ShareViewRefresh> => {
      const background = trigger !== "manual";
      if (!shareView) return "current";
      if (!workspaceIsReady || workspaceAdmission.superseded || shareViewDamaged) return "stale";
      if (shareViewEnded) return "ended";
      const token = ++shareRefreshToken.current;
      const isCurrent = () => !workspaceAdmission.superseded && token === shareRefreshToken.current;
      let readShareRecords = !background;
      let probeFailure = false;
      if (!background) setShareRefreshing(true);
      const repaintAfterChange = async () => {
        await refreshFiles();
        if (!isCurrent()) return;
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
        const outcome = await bridge().refreshSharedView({ workspaceId, trigger });
        if (!isCurrent()) return "stale";
        readShareRecords = !outcome.probed;
        if ((!background && !outcome.ok) || outcome.ok && outcome.refusedOps > 0) void checkShareAccess();
        if (!outcome.ok) {
          probeFailure = outcome.probed === true;
          if (outcome.changedPaths > 0) await bestEffortRepaint();
          if (!isCurrent()) return "stale";
          if (background) throw Object.assign(new Error(outcome.errorMessage), { errorKind: outcome.errorKind });
          reportShellError(
            "Couldn't refresh the shared view.",
            new Error(`Couldn't refresh the shared view. ${outcome.errorMessage}`),
          );
          return "stale";
        }
        if (outcome.probed) return "current";
        if (outcome.collisionRecordQuarantined) {
          reportShellFailure({
            message:
              "dohc could not read this share's collision record, so it set the record aside. A refresh may overwrite local files that collided.",
          });
        }
        if (outcome.status === "ended") {
          shareViewEndedRef.current = true;
          shareViewWritableRef.current = false;
          shareWriteRefusalRef.current = "Your access to this share ended.";
          setCollectionFieldWriteAccess(workspaceId, shareWriteRefusalRef.current);
          setShareExclusions({ workspaceId, paths: [] });
          setEndedFor(shareViewRef.current);
        } else {
          setShareExclusions({ workspaceId, paths: outcome.unjournalablePaths });
        }
        if (outcome.changedPaths > 0) {
          await repaintAfterChange();
        }
        if (!isCurrent()) return "stale";
        return outcome.status === "ended" ? "ended" : background && outcome.changedPaths > 0 ? "changed" : "current";
      } catch (error) {
        if (!isCurrent()) return "stale";
        if (background) {
          readShareRecords = false;
          if (probeFailure) throw error;
        }
        if (!background) void checkShareAccess();
        // A store only a newer dohc opens stops the whole workspace, and the
        // stop state already says so. A toast would repeat it.
        const status = await bridge()
          .getSyncStatus({ workspaceId })
          .catch(() => null);
        if (!isCurrent()) return "stale";
        if (
          status?.engineStoreRefused != null &&
          engineStoreRefusalRecovery(status.engineStoreRefused) === "update"
        ) {
          return "stale";
        }
        if (background) throw error;
        reportShellError("Couldn't refresh the shared view.", error);
        return "stale";
      } finally {
        // After the listing and after a FAILURE, deliberately. Refusals are
        // recorded page by page before each cursor commit, so a refresh that
        // died on a later page still left durable evidence behind — reading it
        // only on the success path would keep that invisible until a lucky
        // refresh or a remount. Start this after the listing, but do not let a
        // slow registry read keep the Refresh control disabled.
        if (isCurrent()) {
          if (!background) {
            setShareRefreshing(false);
          }
          if (readShareRecords) void reloadShareSkipped().catch(() => undefined);
        }
      }
    };
    const promise = refresh().finally(() => {
      if (shareRefreshFlight.current?.promise === promise) shareRefreshFlight.current = null;
    });
    shareRefreshFlight.current = { admission: workspaceAdmission, promise, trigger };
    return promise;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareView, shareViewEnded, shareViewDamaged, workspaceId, workspaceIsReady, workspaceAdmission, reloadShareSkipped]);
  refreshShareViewRef.current = refreshShareView;
  const refreshAfterLiveReadOnly = useCallback(() => void refreshShareViewRef.current(), []);

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
    // Main refuses the read until it has opened the view in this window.
    if (!shareView || !workspaceIsReady) return;
    void reloadMyShareChanges().catch(() => undefined);
  }, [!!shareView, workspaceIsReady, reloadMyShareChanges]);
  // Read at call time: a direct-write notice keeps the callback it was shown
  // with, and one shown before readiness must still send after it.
  const workspaceIsReadyRef = useRef(workspaceIsReady);
  workspaceIsReadyRef.current = workspaceIsReady;
  const sendShareChanges = useCallback(async () => {
    if (workspaceAdmission.superseded) return;
    if (!shareViewWritableRef.current) {
      const message = shareWriteRefusalRef.current;
      reportShellError(message, new Error(message));
      return;
    }
    // Readiness takes a fresh list token, so a submit started before it could
    // never clear its own Sending state.
    if (!workspaceIsReadyRef.current) return;
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
        if (workspaceAdmission.superseded || token !== myShareChangeToken.current) return;
        setVersionEpoch((epoch) => epoch + 1);
      } catch (repaintError) {
        console.error("[desktop] repaint after send changes failed:", repaintError);
      }
    };
    try {
      const result = await bridge().submitShareChanges({ workspaceId });
      if (workspaceAdmission.superseded || token !== myShareChangeToken.current) return;
      if (!result.ok) {
        if (result.capturedLocalChanges > 0) await bestEffortRepaint();
        if (workspaceAdmission.superseded || token !== myShareChangeToken.current) return;
        reportShellError(
          "Couldn't send your changes.",
          new Error(result.errorMessage),
        );
        return;
      }
      if (result.capturedLocalChanges > 0) await bestEffortRepaint();
      if (workspaceAdmission.superseded || token !== myShareChangeToken.current) return;
      setShareChangesEmpty(result.submitted === 0);
      setShareChangesSkipped(
        result.skippedOutsideShare > 0 || result.morePending
          ? {
              outsideShare: result.skippedOutsideShare,
              morePending: result.morePending,
            }
          : null,
      );
      if (!workspaceAdmission.superseded) void checkShareAccess.pull();
      owned = await reloadMyShareChanges();
    } catch (error) {
      if (workspaceAdmission.superseded) return;
      void checkShareAccess();
      reportShellError("Couldn't send your changes.", error);
    } finally {
      if (!workspaceAdmission.superseded && owned === myShareChangeToken.current) setShareChangesSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, workspaceAdmission, reloadMyShareChanges]);
  useShareDirectWrites({
    workspaceId,
    sharedView: !!shareView,
    enabled: shareViewWritable,
    ready: workspaceIsReady,
    ownerName: shareGranterName,
    refreshShareView,
    checkShareAccess: async () => {
      if (shareViewEnded) return "ended";
      if (shareAccess && shareAccess !== "edit") return "changed";
      const result = await checkShareAccess();
      return result.status === "unverified" || result.status === "needs-reopen" ? "stale" : result.status === "current" && result.access !== "edit" ? "changed" : result.status;
    },
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
  const pollsShareProposals = !shareView;
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
    openAutomation: openNoticeAutomation,
    openAutomationControls,
    openChat: openChatsNavInTab,
    openChatsInvitation,
    onSwitchWorkspace: props.onSwitchWorkspace,
    onOpenShare: setOpenShare,
    reportShellError,
    clearShellError: clearIdentity,
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
  const historyOffCopy = historyOffPlaceholderCopy(syncStatus);
  // History stopped recording, so the panel says so in place of taking in changes.
  const historyPaused = isHistoryPaused(syncStatus);
  // The rail needs no capture-decision clause of its own, unlike the surfaces
  // that call on mount. Only `refreshHistory` and the open effect
  // commit a status, and both now answer after the decision, so a null status
  // is exactly the undecided window — and it lands in the branch below with
  // no page to show, which is already a load state. Adding the clause here
  // would render the same thing from a second place.
  const historyTimeline =
    historyReadable(syncStatus) ? (
    // The timeline renders only when a read ANSWERED. Flattening a
    // null page into an empty list told the user a workspace with real
    // history had no changes, whenever a read was in flight or had failed.
    engineHistory ? (
      <EngineHistoryView
        entries={engineHistory.entries}
        hasMore={engineHistory.nextCursor != null}
        loadingMore={engineHistoryLoadingMore}
        onLoadMore={() =>
          void loadMoreEngineHistory().catch((error) =>
            reportShellError("Could not load earlier history.", error),
          )
        }
        onOpenMoment={openMomentDiffTab}
        openMomentId={openMomentId}
        unavailableSources={engineHistory.unavailableSources}
        omittedSources={engineHistory.omittedSources}
        collections={historyCollections}
        onRetry={() =>
          void refreshHistory().catch((error) =>
            reportShellError("Could not refresh history.", error),
          )
        }
        paused={historyPaused}
      />
    ) : engineHistoryReadState === "failed" && engineHistoryPolicyError ? (
      <HistoryHiddenState
        testId="history-policy-hidden"
        result={engineHistoryPolicyError}
        onRetry={() =>
          void refreshHistory().catch((error) =>
            reportShellError("Could not refresh history.", error),
          )
        }
      />
    ) : engineHistoryReadState === "updating" ? (
      // The next capture's activity reads again, so the line asks nothing.
      // It sits where the first row will, so the rows arrive under it.
      <div className="shrink-0 px-3">
        {historyPaused ? <HistoryPaused testId="history-paused" className="h-7" /> : <HistoryUpdating testId="history-updating" className="h-7" />}
      </div>
    ) : engineHistoryReadState === "failed" ? (
      // The same state its two siblings render — ChatsView and LinkedChats
      // both say a panel could not load beside a Try again — so it takes
      // their look, not the empty-state recipe next door. One line, and a
      // Next that works on this surface: the read this panel runs itself.
      <div
        data-testid="history-load-failed"
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <span className="text-xs text-danger">
          dohc could not load this workspace's history.
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
      <SkeletonRows layout="panel" label="Loading history..." />
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
    latestMomentOrder + 1,
  );
  const historyRefreshCounter = shareView ? 0 : historyRefreshFloor.current;
  const graphKey = shareView
    ? graphRefreshKey
    : `${graphRefreshKey}\0${latestMomentOrder}`;

  const explorerView = (
    <>
      <Explorer
        workspaceId={workspaceId}
        mode={wb.explorerMode}
        onModeChange={setExplorerModeInWb}
        listed={fileListingCommit !== null}
        recentFiles={wb.recentFiles}
        files={files}
        folders={folders}
        editorGroups={wb.editorGroups}
        activeEditorGroup={wb.activeEditorGroup}
        dirtyPaths={dirtyPaths}
        recoveryPaths={recoveryPaths}
        tabLabels={tabLabels}
        tabGlyphs={chatEditors.glyphs}
        expandedFolders={wb.expandedFolders}
        pinned={wb.pinned}
        openEditorsHeight={wb.openEditorsHeight}
        onOpenEditorsHeightChange={onOpenEditorsHeightChange}
        newFolderRequest={newFolderRequest}
        onNewPage={openNewPage}
        revealPaths={explorerReveal?.workspaceId === workspaceId ? explorerReveal.paths : null}
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
        appFolders={appFolders}
        onOpenCollection={openCollectionTab}
        apps={explorerApps}
        dataCollections={dataCollections}
        includeArchivedCollections={includeArchived}
        onIncludeArchivedCollections={shareView || !collectionsListed ? undefined : setIncludeArchived}
        onOpenDataCollection={openDataCollection}
        onMoreDataCollections={nextDataset ? onMoreDataCollections : undefined}
        onRestoreCollection={!shareView && props.workspace.mode !== "cloud-only" && workspaceIsReady && collectionsListed ? onRestoreCollection : undefined}
        collectionsRefusal={collectionsRefusal}
        collectionsElsewhere={collectionsElsewhere}
        onKeepCollections={keepCollectionsWithList}
        onRetryCollections={retryCollectionsList}
        onBeginChanges={beginDraftOperation}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={importFromExplorer}
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
    shareRemovals,
    mentionCandidates,
    workspaceFiles: files,
    collaboration: chatCollaboration,
    agentSetup,
    onSetupAgent: openAgentSettings,
    userSettings: props.userSettings?.settings ?? null,
    onSaveUserSettings: saveUserSettingsFromChats,
    workspacePath: props.workspace.rootPath,
    onAgentWaitsForTrust: trustForHeldAgent,
  } as const;
  // The Chats view intentionally stays on the overview and only selects editor
  // destinations. Active chat pages own the live conversations: disable the
  // navigator's collaboration transport so it cannot
  // create a duplicate presence lease, and suspend its polls so one open
  // conversation does not double every chat read (D2#6). The page's landed
  // reads still reach the navigator through their local-thread and DM
  // revisions.
  const chatsTabIsLive = wb.editorGroups.some((group) =>
    (parseTab(group.activeTab)?.kind === "chat"),
  );
  // The Chats view is a navigator, like the Explorer: it lists Home, the groups,
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
    shareRemovals,
    mentionCandidates,
    workspaceFiles: files,
    collaboration: null,
    suspendPolling: chatsTabIsLive,
    ...(revealedInvitation === null ? {} : { revealInvitation: revealedInvitation, onInvitationRevealed: clearRevealedInvitation }),
    agentSetup,
    onSetupAgent: openAgentSettings,
    userSettings: props.userSettings?.settings ?? null,
    onSaveUserSettings: saveUserSettingsFromChats,
    workspacePath: props.workspace.rootPath,
    onAgentWaitsForTrust: trustForHeldAgent,
  } as const;
  // Chats shows that Restricted Mode holds this workspace's agent back.
  const agentsRestricted = workspaceTrust.trusted === false && agentSetup?.workspaceId === workspaceId &&
    agentSetup.runnerConfigured && agentSetup.runnerEnabled;

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

  const storeUpdateState = desktopUpdate.state;
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
        ...(error.stays ? { stays: true } : {}),
        message: error.message,
        ...(error.title ? { title: error.title } : {}),
        ...(error.lastLine ? { lastLine: error.lastLine } : {}),
        ...(error.command ? { command: error.command } : {}),
        ...(error.kind === "share-capture" ? { filePaths: error.details?.map(detail => String(detail[1])) ?? [], copyLabel: "Copy file paths" } : {}),
        details: error.kind === "share-capture" ? (error.details ?? []).map(detail => String(detail[1])).join("\n") : errorDetails([
          [error.tone ? "Notice" : "Error", error.message],
          ...(error.title ? [["Title", error.title] as const] : []),
          ...(error.details ?? []),
          ...reportFacts(),
        ]),
        atMs: error.atMs,
        canRetry: error.retry !== null,
        ...(error.action ? { actionLabel: error.action.label } : {}),
        ...(error.action?.additional ? { additionalActionLabels: error.action.additional.map(action => action.label) } : {}),
        seen: error.seen,
        ...(error.read ? { read: true } : {}),
        ...(error.noDismiss ? { noDismiss: true } : {}),
      })),
    [shellErrors, reportFacts],
  );
  // What Copy details copies, shown on request so a person can read what
  // they are about to paste. One string for both, so they never differ.
  const [storeDetailsOpen, setStoreDetailsOpen] = useState(false);
  // A switch leaves the other workspace's disclosure behind.
  useEffect(() => {
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
  // A stopped store or a failed open shows in place of the opening cover.
  openingCoverShown.current = !workbenchRestored && !storeUpdateRequired && (workspaceIsReady || !workspaceOpenFailure);
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
  const openSyncSettings = useCallback(() => openSettings("cloud"), [openSettings]);
  const reportCollectionsWaitingRetryFailure = useCallback(
    (message: string, error: unknown, retry: () => void) =>
      reportShellError(message, error, retry, undefined, "collections-waiting-retry"),
    [reportShellError],
  );
  const collectionsWaitingNotice = useCollectionsWaitingNotice({
    workspaceId,
    waiting: syncStatus === null ? undefined : (syncStatus.collectionsWaitingForSync ?? null),
    retryCloudSync: retryCloudSyncCommand,
    openSyncSettings,
    report: reportCollectionsWaiting,
    reportRetryFailure: reportCollectionsWaitingRetryFailure,
    clear: clearCollectionsWaiting,
  });
  const filedObservationFailure = useRef<SyncStatusResult["fileObservationFailure"]>(undefined);
  const observationFailure = syncStatus?.fileObservationFailure;
  const retryFileObservationRef = useRef<() => void>(() => {});
  const retryFileObservation = useCallback(() => {
    const askedFor = workspaceIdRef.current;
    void bridge().retryFileObservation({ workspaceId: askedFor }).then(status => {
      if (workspaceAdmission.superseded || workspaceIdRef.current !== askedFor) return;
      if (status.fileObservationFailure) {
        reportShellFailure({ message: fileObservationFailureCopy(status.fileObservationFailure), identity: "file-observation",
          retry: () => retryFileObservationRef.current() });
      } else {
        clearIdentity("file-observation");
      }
    }, error => {
      if (workspaceAdmission.superseded || workspaceIdRef.current !== askedFor) return;
      reportShellFailure({ message: fileObservationFailureCopy(observationFailure ?? "read-failed"), cause: error,
        identity: "file-observation", retry: () => retryFileObservationRef.current() });
    });
  }, [workspaceAdmission, observationFailure, reportShellFailure, clearIdentity]);
  retryFileObservationRef.current = retryFileObservation;
  useEffect(() => {
    if (syncStatus === null) return;
    if (filedObservationFailure.current === observationFailure) return;
    filedObservationFailure.current = observationFailure;
    if (observationFailure) {
      reportShellFailure({ message: fileObservationFailureCopy(observationFailure), identity: "file-observation",
        retry: () => retryFileObservationRef.current() });
    } else {
      clearIdentity("file-observation");
    }
  }, [syncStatus, observationFailure, reportShellFailure, clearIdentity]);
  // Reading a refusal's row stores its read mark. Closing its toast alone
  // doesn't, so an unread one toasts again the next time dohc starts.
  const readWorkspaceError = useCallback((id: string) => {
    const refusal = props.sentNotices?.notices.find(notice => notice.noticeId === id && isRefusalNoticeKind(notice.kind));
    if (!refusal) return;
    const askedFor = workspaceId;
    void props.sentNotices!.read([refusal]).catch(error => {
      if (workspaceIdRef.current === askedFor) reportShellError("dohc could not mark this Notice read.", error);
    });
  }, [props.sentNotices, workspaceId, reportShellError]);
  useEffect(() => {
    showSyncRefusals((props.sentNotices?.notices ?? []).filter(notice =>
      isRefusalNoticeKind(notice.kind) && notice.workspaceId === workspaceId), syncFailureNotice.retry, openFile, openHistoryView, readWorkspaceError);
  }, [props.sentNotices?.notices, workspaceId, showSyncRefusals, syncFailureNotice.retry, openFile, openHistoryView, readWorkspaceError]);
  // The notes whose change dohc holds, for their band.
  const heldNotes = useMemo(() => new Set((props.sentNotices?.notices ?? []).flatMap(notice =>
    notice.kind === "markdown-write-held" && notice.workspaceId === workspaceId && notice.target?.path ? [notice.target.path] : [])),
  [props.sentNotices?.notices, workspaceId]);
  const driveLimitNotice = useDriveLimitNotice({
    workspaceId,
    unavailable: syncStatus?.atomicPlacementUnavailable === true,
    report: reportDriveLimit,
  });
  const networkShareNotice = useNetworkShareNotice({
    workspaceId,
    onNetworkShare: syncStatus?.onNetworkShare === true,
    platform: bridge().platform,
    report: reportNetworkShare,
  });
  const revealRecoveryWorkspace = useCallback(() => {
    const askedFor = workspaceId;
    void bridge().revealWorkspaceFolder({ workspaceId: askedFor, recoveryCopies: true }).catch((error) => {
      if (workspaceIdRef.current !== askedFor) return;
      reportShellError("Could not show the recovery folder.", error);
    });
  }, [workspaceId, reportShellError]);
  const retryFileRecovery = useCallback(() => {
    const askedFor = workspaceId;
    if (workspaceIdRef.current !== askedFor) return;
    void bridge().retryFileRecovery({ workspaceId: askedFor }).then(() => {
      if (workspaceIdRef.current !== askedFor) return;
      reportRecoveryUnavailable(false, () => undefined, revealRecoveryWorkspace);
    }).catch((error) => {
      if (workspaceIdRef.current !== askedFor) return;
      reportShellError("dohc could not retry file recovery.", error, retryFileRecovery, "file-recovery-unavailable");
    });
  }, [workspaceId, reportRecoveryUnavailable, revealRecoveryWorkspace, reportShellError]);
  useEffect(() => {
    if (syncStatus?.recoveryUnavailable === undefined) return;
    reportRecoveryUnavailable(syncStatus.recoveryUnavailable, retryFileRecovery, revealRecoveryWorkspace);
  }, [syncStatus?.recoveryUnavailable, reportRecoveryUnavailable, retryFileRecovery, revealRecoveryWorkspace]);
  const typingRecoveryConfirmation = useTypingRecoveryNotices({workspaceId, ready: workspaceIsReady, openHistory: openHistoryView, importedRecovery: captureRecoveries.imported, reportShellFailure, showSuccessNotice, showWarningNotice, clearKind, clearIdentity});
  useEffect(() => {
    if (syncStatus?.outsideWriteCopies === undefined) return;
    showOutsideCopies(syncStatus.outsideWriteCopies, openFile);
  }, [syncStatus?.outsideWriteCopies, showOutsideCopies, openFile]);
  const shownCopyReadError = useRef<string | null>(null);
  useEffect(() => {
    if (syncStatus?.outsideWriteCopyReadError === undefined) return;
    const error = syncStatus.outsideWriteCopyReadError;
    if (error === shownCopyReadError.current) return;
    shownCopyReadError.current = error;
    const identity = "outside-copy-records";
    if (error === null) { clearIdentity(identity); return; }
    reportShellFailure({
      identity, kind: "outside-copy-read", title: "dohc could not list every kept copy",
      message: "To find a copy that isn't listed, look beside its file for (kept copy) in the name.",
      details: [["Cause", error]], retry: () => void refreshKeptCopies(),
    });
  }, [syncStatus?.outsideWriteCopyReadError, reportShellFailure, clearIdentity, refreshKeptCopies]);
  const keptFilesNotice = useKeptFilesNotice({
    workspaceId,
    paths: syncStatus?.keptFiles?.filter(([path]) => !path),
    report: reportKeptFiles,
    openFolder: revealRecoveryWorkspace,
  });
  const retainedCopiesDialog = useRetainedCopiesNotice({
    workspaceId,
    workspaceName: workspaceName(props.workspace),
    summary: syncStatus?.retainedCopies,
    show: showRetainedCopies,
    showDone: showSuccessNotice,
    report: reportShellFailure,
    reportError: reportShellError,
  });
  // Keep each notice kind's dismissal state across remounts.
  const dismissWorkspaceError = useCallback(
    (id: string) => {
      const notice = shellErrors.find((error) => error.id === id);
      const kind = notice?.kind;
      if (notice?.identity?.startsWith("stop-and-restore:") && !notice.identity.startsWith("stop-and-restore:recovery:")) {
        const askedFor = workspaceId;
        void stopAndRestore.dismiss(notice.identity).then(dismissed => {
          if (dismissed && workspaceIdRef.current === askedFor) dismissShellError(id);
        }).catch(error => {
          if (workspaceIdRef.current === askedFor) reportShellError("dohc could not dismiss this Notice.", error,
            () => dismissWorkspaceError(id));
        });
        return;
      }
      if (kind === "cloud-sync") syncFailureNotice.noteDismissed();
      if (kind === "collections-waiting") collectionsWaitingNotice.noteDismissed();
      if (kind === "drive-no-atomic-placement") driveLimitNotice.noteDismissed();
      if (kind === "network-share") networkShareNotice.noteDismissed();
      if (kind === "kept-files") keptFilesNotice.noteDismissed();
      if (kind === "collection-copies-left") collectionCopiesLeftNotice.noteDismissed();
      if (kind === "share-capture" && shareView?.shareId) {
        const askedFor = workspaceId;
        const state = shareCaptureNoticeState(shareView.unsavedPaths, shareView.unconfirmedChanges, shareView.ended === true);
        void bridge().dismissShareCaptureNotice({ workspaceId: askedFor, shareId: shareView.shareId, key: state.key }).then(() => {
          if (workspaceIdRef.current === askedFor) dismissShellError(id);
        }).catch(error => {
          if (workspaceIdRef.current === askedFor) reportShellError("dohc couldn't dismiss this Notice. Try dismissing it again in Notices.", error);
        });
        return;
      }
      const refusal = props.sentNotices?.notices.find(notice => notice.noticeId === id && isRefusalNoticeKind(notice.kind));
      if (refusal) {
        const askedFor = workspaceId;
        void props.sentNotices!.dismiss(refusal).catch(error => {
          if (workspaceIdRef.current === askedFor) reportShellError("dohc could not dismiss this Notice.", error);
        });
      } else dismissShellError(id);
    },
    [dismissShellError, driveLimitNotice, networkShareNotice, keptFilesNotice, collectionCopiesLeftNotice, shellErrors, shareView, syncFailureNotice, collectionsWaitingNotice, props.sentNotices, workspaceId, reportShellError, stopAndRestore],
  );
  return (
    <AgentSettingsProvider settings={props.userSettings?.settings ?? null}>
    <AgentColorContext.Provider value={setAgentColor}>
    <CustomizeContext.Provider value={customizeContext}>
    <CollectionFieldMarksProvider workspaceId={workspaceId}>
    <ShellErrorReporter.Provider value={reportShellFailure}>
    <div
      data-testid="workspace-shell"
      ref={focusRoot}
      tabIndex={-1}
      data-focus-surface="workspace"
      // Open waits for the engine's observation baseline. The shell mounts
      // earlier, so external writers wait for this attribute before editing.
      data-ready={workspaceIsReady ? "true" : "false"}
      className="app-chrome relative flex h-screen flex-col bg-bg text-ink"
    >
      <ShellTitlebar
        update={<TitlebarUpdateButton update={desktopUpdate} />}
        workspace={props.workspace}
        workspaces={props.workspaces}
        onSwitchWorkspace={props.onSwitchWorkspace}
        onManageWorkspaces={props.onManageWorkspaces}
        manageWorkspaces={manageWorkspaces}
        setOpenShare={setOpenShare}
        setQuickOpenOpen={setQuickOpenOpen}
        syncStatus={syncStatus}
        failedSaves={failedSaves}
        showWorkbenchMenu={showWorkbenchMenu}
        agentActive={agentActive}
        restrictedMode={workspaceTrust.trusted === false ? {
          asking: workspaceTrust.asking,
          onTrust: () => void trustWorkspace(),
        } : undefined}
        wb={wb}
        toggleSidePanel={toggleSidePanel}
        mutateWb={mutateWb}
        version={captureAvailable ? (
          <VersionMenu
            workspaceId={workspaceId}
            // Out of the workbench, so it waits for the workspace the way
            // the inert workbench does.
            disabled={!workspaceIsReady || storeUpdateRequired}
            activeTabDirty={anyTabDirty}
            beginLineageOperation={beginLineageOperation}
            onOpenCompare={openVersionCompareTab}
            onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
            onError={reportFailureMessage}
            clearError={clearIdentity}
            onConflictError={reportShellError}
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
            // versionEpoch bumps whenever version state changed outside
            // this menu, so the selector re-reads instead of going stale.
            refreshKey={versionEpoch}
          />
        ) : undefined}
      />
      {shareView ? (
        <div
          data-testid="shared-view-banner"
          data-ended={shareViewEnded || undefined}
          className={`flex min-h-8 items-center gap-2 border-b border-line px-3 text-[12px] ${
            shareViewEnded ? "bg-warning/10 text-warning" : "bg-panel text-muted"
          }`}
        >
          <Eye size={12} aria-hidden className="shrink-0" />
          {shareView.subjectName && <span className="max-w-64 truncate font-medium">{shareView.subjectName}</span>}
          {shareView.granterEmail && <span className="shrink-0 font-mono text-[11px]">{shareView.granterEmail}</span>}
          {" "}
          <span className="min-w-0 flex-1 truncate" title={shareBannerText}>
            {shareBannerText}
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
          {shareViewWritable ? (
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
                disabled={shareChangesSubmitting || !workspaceIsReady}
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
              disabled={shareRefreshing || !workspaceIsReady}
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
          activeView={shownView}
          pinnedApps={pinnedApps}
          onPinnedAppMenu={(appRoot) => void showPinnedAppMenu(appRoot)}
          sidebarVisible={wb.sidebarVisible}
          hasConflict={syncStatus?.state === "conflict"}
          searchResultCount={
            search.model.totalMatches > 0 ? search.model.totalMatches : undefined
          }
          onSelectView={(view) => mutateWb((state) => setView(state, view))}
          onOpenSettings={() => openSettings()}
          viewsDisabled={!workbenchRestored || storeUpdateRequired}
          notices={
            <NoticeCenter
              workspaceId={workspaceId}
              syncStatus={syncStatus}
              failedSaves={failedSaves}
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
              workspaceErrors={workspaceErrors}
              onRetryWorkspaceError={retryShellError}
              onWorkspaceErrorAction={runShellErrorAction}
              onHideWorkspaceError={hideShellError}
              onReadWorkspaceError={readWorkspaceError}
              onDismissWorkspaceError={dismissWorkspaceError}
              onWorkspaceErrorShown={reportsNoticeShown}
              onRetryLiveDelivery={retryLiveDelivery}
              onOpenSharingDeclined={openSharingDeclined}
              {...(shareView
                ? {}
                : {
                    onOpenLiveDocuments: () => openLiveDocuments(workspaceId),
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
          inert={!workbenchRestored || storeUpdateRequired ? true : undefined}
          className="flex min-w-0 flex-1"
        >

        {/* Side panel (Ctrl+B / activity bar toggle; hidden ⇒ unmounted) */}
        {wb.sidebarVisible ? (
          <ShellSidePanel
            customize={customize}
            wb={shownWb}
            mutateWb={mutateWb}
            sidePanelTitle={sidePanelTitle}
            openHistoryTab={openHistoryTab}
            openGraphTab={openGraphTab}
            openChatsTab={openChatsTab}
            showAppsInExplorer={hasApps(workspaceApps) ? showAppsInExplorer : null}
            explorerView={explorerView}
            search={search}
            openSearchResult={openSearchResult}
            workspaceId={workspaceId}
            activeDocumentPath={activeDocumentPath}
            focusedTabPath={focusedTabPath}
            graphKey={graphKey}
            openPathWithHeading={openPathWithHeading}
            openGraphChatThread={openGraphChatThread}
            captureAvailable={captureAvailable}
            captureDecided={captureDecided}
            syncStatus={syncStatus}
            chatsNavigatorProps={chatsNavigatorProps}
            setAppPinned={setAppPinned}
            shareView={shareView}
            historyTimeline={historyTimeline}
            sharing={{
              workspaceId,
              shareView: isShareView,
              context: accessContext,
              notices: aboutNotices,
              conflictCount: syncStatus?.state === "conflict" ? (syncStatus.conflictCount ?? 0) : null,
              onReviewConflicts: () => setConflictReviewOpen(true),
              proposals: shareProposals,
              onReviewChanges: setReviewProposalId,
              mounts: shareMounts,
              onMountsChanged,
              onUnmount: unmountShare,
              shareRemovals,
              sharesRevision,
              reportError: reportShellError,
              focus: sharingFocus,
              onFocused: clearSharingFocus,
            }}
            selectedAppRoot={selectedAppRoot}
            openAppTab={openAppTab}
            reportShellError={reportShellError}
            setShareTarget={setShareTarget}
          />
        ) : null}

        {/* Editor area: independently active editor groups. Each group can
            host any tab surface, and its tab row carries the open
            document's actions. */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <EditorGroupLayout
            groups={wb.editorGroups.map((editorGroup, groupIndex) => {
              const tabPath = editorGroup.activeTab;
              const tab = editorGroup.tabs.find(
                (candidate) => candidate.path === tabPath,
              );
              const editorCallbacks = tab
                ? callbacksForEditor(editorGroup.id, tab)
                : null;
              const groupTab = parseTab(tabPath);
              const groupSiteRoot = groupTab?.kind === "site" ? groupTab.siteRoot : null;
              const groupCollectionPath = groupTab?.kind === "collection" ? groupTab.collectionPath : null;
              const groupScrollTarget =
                searchScrollTarget?.groupId === editorGroup.id &&
                searchScrollTarget.path === tabPath
                  ? searchScrollTarget
                  : undefined;
              return {
                id: editorGroup.id,
                size: editorGroup.size,
                content: (
                  <EditorGroupFrame tabs={(actionsRef) => (
                    <EditorTabs
                      actionsRef={actionsRef}
                      groupId={editorGroup.id}
                      tabs={editorGroup.tabs}
                      activeTab={tabPath}
                      activeTabDirty={!!tabPath && dirtyPaths.has(tabPath)}
                      tabLabels={tabLabels}
                      tabGlyphs={chatEditors.glyphs}
                      files={fileEntries}
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
                  )}>
                    <div className="flex min-h-0 flex-1 flex-col">
            {/* The editor island: a document/tab view that throws (hostile
                markdown tripping the WYSIWYG parse, a failed editor chunk, a
                view bug) contains to this pane — tabs, explorer, and rail
                stay alive, and switching or closing the tab recovers. */}
            <ErrorBoundary
              scope="editor"
              resetKeys={[tabPath, workspaceId, versionEpoch]}
            >
            {(() => {
              switch (groupTab?.kind) {
                case "graph": return (
              <Suspense fallback={<SkeletonRows layout="panel" label="Loading graph..." />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={activeDocumentPath}
                  refreshKey={graphKey}
                  onOpenPath={openPathWithHeading}
                  onOpenChatThread={openGraphChatThread}
                  chatMentionsAvailable={captureAvailable}
                  variant="page"
                  onError={reportShellError}
                />
              </Suspense>
            );
                case "history": return (
              <div
                data-testid="history-page"
                className="flex min-h-0 flex-1 flex-col bg-bg"
              >
                {historyTimeline}
              </div>
            );
                case "momentDiff": return (
              // A persisted moment-diff tab reads the capture capability,
              // like every other surface main's capture serves. Gating it on
              // the share fact alone left the failed-build cause open: the
              // page still mounted, called readEngineMoment and fell into its
              // own error state.
              // A shared view opens a moment its share imported, read-only.
              !(shareView ? captureDecided && historyReadable(syncStatus) : captureAvailable) ? (
                !captureDecided ? (
                  // Main has not decided yet. The tab must not mount the page
                  // and must not state a capability either: neither read the
                  // shell has done proves anything about what main recorded,
                  // so this window gets a load state, not a claim.
                  <SkeletonRows layout="panel" label="Loading history..." />
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
                  readOnly={!!shareView}
                  onBeforeRestore={beginLineageOperation}
                  onOpenFile={openFile}
                  onPathResolved={resolveMomentDiffPath}
                  registerActiveUndo={editorCallbacks?.registerActiveUndo ?? (() => undefined)}
                  onRestored={onHistoryRestored}
                  onStopAndRestore={stopAndRestore.open}
                  onError={reportRestoreError}
                  onSettled={clearIdentity}
                  historyAnswer={engineHistory ?? engineHistoryPolicyError}
                  onReopenRestore={reopenRestore}
                  restoreRequested={
                    restoreRequest?.workspaceId === workspaceId &&
                    restoreRequest.momentId === groupTab.momentId
                  }
                  onRestoreRequestTaken={takeRestoreRequest}
                  steps={groupTab.momentId === null ? undefined : momentSteps.get(groupTab.momentId)}
                  onOpenMoment={openMomentDiffTab}
                />
              )
            );
                case "versionCompare": return (
              // A persisted compare tab reads the version capability, like
              // every other version entry point. Gating it on the share fact
              // alone left the whole #620 cause open: on a workspace whose
              // capture build failed the page still mounted, called
              // listWorkspaceVersions and compareWorkspaceVersions, and said
              // "Could not compare with Main."
              !captureAvailable ? (
                shareView ? (
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
                  <SkeletonRows layout="panel" label="Loading versions..." />
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
                  versionId={groupTab.versionId ?? "main"}
                />
              )
            );
                case "chat": return (
              // Each loading state of the tab puts its lines at the top, so
              // each one takes over from the last without blinking.
              <SkeletonSlot>{captureAvailable ? (
                <div className="flex min-h-0 flex-1 flex-col">
                {agentsRestricted ? (
                  <RestrictedAgentsBand asking={workspaceTrust.asking} onTrust={() => void trustWorkspace()} />
                ) : null}
                <Suspense fallback={<SkeletonRows inSlot layout="panel" label="Loading Chats..." />}>
                  <LazyChatsView
                    key={`${workspaceId}:${tabPath}:${chatEditors.get(groupTab.path).generation}:${chatEditors.get(groupTab.path).revision}`}
                    {...chatsViewProps}
                    onNavChange={chatEditors.get(groupTab.path).onNavChange}
                    onNavCommand={chatEditors.get(groupTab.path).onNavCommand}
                    onDraftsChange={chatEditors.get(groupTab.path).onDraftsChange}
                    initialNav={chatEditors.get(groupTab.path).nav}
                    initialDrafts={chatEditors.get(groupTab.path).drafts}
                    editorTabPath={groupTab.path}
                    onOpenInTab={openChatsNavInTab}
                    variant="page"
                  />
                </Suspense>
                </div>
              ) : shareView ? (
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
                <SkeletonRows inSlot layout="panel" label="Loading Chats..." />
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
              )}</SkeletonSlot>
            );
                case "site": return (
              groupSiteRoot ? (
                <Suspense fallback={<SkeletonRows layout="panel" label="Loading app..." />}>
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
            );
                case "transactionalCollection": return (
              // The view opens its Collection at the same place its fallback
              // stands, so those lines take over without blinking.
              <SkeletonSlot>
              <Suspense fallback={<SkeletonRows inSlot layout="panel" label="Loading collection..." />}>
                <LazyTransactionalCollection key={`${workspaceId}:${tabPath}`} workspaceId={workspaceId}
                  datasetPath={groupTab.datasetPath} tableId={groupTab.tableId}
                  onOpenFile={(path) => openFile(path)}
                  onOpenScheduleSettings={() => openSettings("advanced")}
                  owner={!shareView}
                  onLifecycleChanged={() => { void refreshDatasets().catch(error => reportShellError("Could not refresh Collections.", error)); }}
                  onError={collectionReports.onError}
                  onKeepCollections={keepCollectionsWithList}
                  onSettled={collectionReports.onSettled}
                  onNotice={collectionReports.onNotice}
                  historyRequested={collectionHistoryTab !== null && tab === collectionHistoryTab}
                  onHistoryShown={clearCollectionHistory}
                  onFormCreated={appRoot => {
                    void refreshFiles().catch(error => reportShellError("Could not refresh workspace files.", error));
                    openVirtualTab(siteTabPath(appRoot));
                  }} />
              </Suspense>
              </SkeletonSlot>
            );
                case "collection": return (
              groupCollectionPath ? (
                <SkeletonSlot>
                <Suspense fallback={<SkeletonRows inSlot layout="panel" label="Loading collection..." />}>
                  <LazyCollectionPage
                    key={`${tabPath}:${collectionLineage}`}
                    workspaceId={workspaceId}
                    collectionPath={groupCollectionPath}
                    readOnly={(!!shareView && !shareViewWritable) || isMountedSharePath(groupCollectionPath)}
                    accessEnded={shareViewEnded}
                    writeRefusal={shareView ? shareWriteRefusal : undefined}
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
                </SkeletonSlot>
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
            );
                case "newPage": return (
              <NewPage
                key={groupTab.id}
                draft={newPageDrafts.current.get(groupTab.path)?.draft ?? ""}
                onDraftChange={(draft) => newPageDraftChanged(groupTab.path, draft)}
                body={newPageDrafts.current.get(groupTab.path)?.body ?? ""}
                onBodyChange={(body) => {
                  const pending = newPageDrafts.current.get(groupTab.path);
                  if (pending) pending.body = body;
                }}
                onLeaveTitle={() => void writeNewPage(groupTab.path, true)}
                file={null}
                handedOff={false}
                onHandedOff={() => undefined}
              />
            );
                case "removed":
                case undefined:
                case "file": {
                  // A new page's file renders inside the page's host until the
                  // tab closes, so the switch from page to file keeps it.
                  const born = tabPath ? bornPages.get(tabPath) : undefined;
                  const fileView: NewPageFile = (onEditorReady) => tabPath && tab && editorCallbacks ? (
              <FileInspector
                key={tabPath}
                onEditorReady={onEditorReady}
                workspaceId={workspaceId}
                path={tabPath}
                changeHeld={heldNotes.has(tabPath)}
                fileOpenStartMark={fileOpenStartMark(editorGroup.id)}
                // History growth, version switches, and share-mount pulls all
                // re-read the open file (every counter only ever increases).
                refreshKey={historyRefreshCounter + versionEpoch + mountContentEpoch}
                // G2-C-3: the engine editor re-binds to the new version's Y.Doc
                // lineage only on an active-version change — versionEpoch alone,
                // not history growth (which must not churn the live session).
                engineVersionKey={versionEpoch}
                onOpenPath={openPathWithHeading}
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
                // A document in an Edit share view that turns read-only may
                // mean the owner ended access. The refresh asks the relay, and
                // only the relay says so.
                onLiveReadOnly={shareViewWritable ? refreshAfterLiveReadOnly : undefined}
                surfaceKey={editorGroup.id}
                onSurfaceReady={onRestoredFileSurfaceReady}
                registerDraftFlush={editorCallbacks.registerDraftFlush}
                registerSourceToggle={editorCallbacks.registerSourceToggle}
                autoFocus={wb.activeEditorGroup === editorGroup.id}
                knownMarkdownFiles={markdownWikilinkFiles}
                appFolder={appEntries.get(tabPath) ?? null}
                onRunApp={openAppTab}
                onButtonError={reportButtonError}
                onButtonNotice={showSuccessNotice}
                onClosePath={closePathTabs}
                onOpenRecordHistory={recordHistory.open}
                accessEnded={shareViewEnded}
                captureHeld={heldFiles?.some(file => file.workspaceId === workspaceId && file.path === tabPath) ?? false}
                onRetryHeldCapture={retryHeldCapture}
                readOnly={
                  (!!shareView && !shareViewWritable) ||
                  isMountedSharePath(tabPath)
                }
                receivedShare={!!shareView || isMountedSharePath(tabPath)}
                {...(shareView || isMountedSharePath(tabPath)
                  ? {}
                  : { onSharePath })}
              />
            ) : (
              <EmptyEditorGroup
                platform={bridge().platform}
                create={startActions}
                recent={wb.recentFiles}
                files={fileListingCommit ? files : null}
                onOpen={openFile}
                onDropFiles={isCommandAvailable("import-files", commandContext) ? importDroppedFiles : undefined}
              />
            );
                  return born && tabPath ? (
              <NewPage
                key={born.id}
                draft={bornDrafts.current.get(tabPath)?.draft ?? ""}
                onDraftChange={(draft) => {
                  const page = bornDrafts.current.get(tabPath);
                  if (page) page.draft = draft;
                }}
                body={bornDrafts.current.get(tabPath)?.body ?? ""}
                onBodyChange={(body) => {
                  const page = bornDrafts.current.get(tabPath);
                  if (page) page.body = body;
                }}
                onLeaveTitle={() => undefined}
                file={fileView}
                handedOff={born.handedOff}
                onHandedOff={(taken) => pageHandedOff(tabPath, taken)}
              />
            ) : fileView(undefined);
                }
              }
              const unhandled: never = groupTab;
              return unhandled;
            })()}
            </ErrorBoundary>
                    </div>
                  </EditorGroupFrame>
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

        {/* About rail — the right-hand secondary sidebar (every workspace,
            shared views included). Hidden entirely while collapsed; the
            titlebar About button, Ctrl+Alt+B, or the toggle-about command
            bring it back. The chat list lives in the left Chats view. */}
        {wb.aboutVisible ? (
          <ShellAboutRail
            wb={wb}
            mutateWb={mutateWb}
            captureAvailable={captureAvailable}
            captureDecided={captureDecided}
            focusedTabPath={focusedTabPath}
            syncStatus={syncStatus}
            workspaceId={workspaceId}
            activeDocumentPath={activeDocumentPath}
            aboutTabOpen={aboutTabOpen}
            shareView={shareView}
            searchChatTarget={searchChatTarget}
            onSearchHitRead={onSearchHitRead}
            onSearchHitClosed={onSearchHitClosed}
            openPathWithHeading={openPathWithHeading}
            onChatsThreadRead={onChatsThreadRead}
            reportFailureMessage={reportFailureMessage}
            onAgentWaitsForTrust={trustForHeldAgent}
            historyRevision={historyRefreshCounter}
              openMoment={openMomentDiffTab}
            openHistory={openHistoryView}
            linksRevision={historyRefreshCounter + versionEpoch + mountContentEpoch}
            openPathAtLine={openPathAtLine}
            openChatMention={openChatMention}
            aboutNotices={aboutNotices}
            accessContext={accessContext}
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
            {/* One button for every step: Check, Update, then Restart to update. */}
            {desktopUpdate.step ? (
              <PrimaryButton
                autoFocus
                data-testid="workspace-update-step"
                disabled={desktopUpdate.step.action === null}
                onClick={() => {
                  const action = desktopUpdate.step?.action;
                  if (action) void runDesktopUpdate(action);
                }}
                className="inline-flex items-center gap-1.5"
              >
                {desktopUpdate.step.Icon ? <desktopUpdate.step.Icon size={14} aria-hidden /> : null}
                <UpdateStepLabel step={desktopUpdate.step} />
              </PrimaryButton>
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
            {storeUpdateState ? updateStatusLine(storeUpdateState) : null}
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
                <CopyButton
                  testId="workspace-update-copy-details"
                  label="Copy"
                  pinName
                  iconOnly
                  getText={() => storeDetailsText}
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
            {isPrivacyDenied(workspaceOpenFailure.message) ? (
              <>
                <PrimaryButton onClick={privacySettingsAction.run}>
                  {privacySettingsAction.label}
                </PrimaryButton>
                <SecondaryButton onClick={retryWorkspaceOpen}>Try again</SecondaryButton>
              </>
            ) : (
              <PrimaryButton onClick={retryWorkspaceOpen}>Try again</PrimaryButton>
            )}
            <CopyButton
              label="Copy details"
              pinName
              getText={() =>
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
      ) : !workbenchRestored ? (
        <div
          data-testid="workspace-preparing"
          role="status"
          aria-live="polite"
          className="absolute left-12 right-0 bottom-0 top-10 z-10 flex flex-col items-center justify-center gap-2 bg-bg px-6 text-center"
        >
          <RefreshCw size={16} aria-hidden className="animate-spin text-subtle" />
          <p className="text-sm font-medium text-ink">Preparing this workspace</p>
          {/* The check is over while the saved layout loads, and a load that
              takes a while says what it waits for and the way out. Lines are
              hidden, not removed, in slots as tall as their tallest text, so
              the heading does not move. */}
          <div className="grid text-xs text-muted">
            <p className={`col-start-1 row-start-1 ${workspaceIsReady ? "invisible" : ""}`}>
              dohc is checking your existing files before editing starts.
            </p>
            <p className={`col-start-1 row-start-1 ${coverWaits ? "" : "invisible"}`}>
              dohc is still waiting for this workspace to open, so it can bring back your saved tabs.
            </p>
          </div>
          <p className={`text-xs text-muted ${coverWaits ? "" : "invisible"}`}>
            Choose another workspace from the title bar.
          </p>
        </div>
      ) : null}

      {typingRecoveryConfirmation}
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
      {recoveryWorkspaceId === workspaceId && !shareView && props.workspace.mode !== "cloud-only" && workspaceIsReady ? (
        <ConnectedCollectionRecoveryRestore workspaceId={workspaceId} onError={reportShellError}
          onClose={() => setRecoveryWorkspaceId(null)}
          onRestored={(datasetPath, tableId) => {
            if (workspaceIdRef.current !== workspaceId) return;
            openVirtualTab(transactionalCollectionTabPath(datasetPath, tableId));
            showSuccessNotice("Restored the Collection. Sharing stays off.");
            void refreshDatasets().catch(error => {
              if (workspaceIdRef.current === workspaceId) reportShellError("Could not refresh Collections.", error);
            });
            void refreshFiles().catch(error => {
              if (workspaceIdRef.current === workspaceId) reportShellError("Could not refresh workspace files.", error);
            });
          }} />
      ) : null}
      {newCollectionFolder !== null && (!shareView || shareViewWritable) ? (
        <NewCollectionDialog
          workspaceId={props.workspace.workspaceId}
          documentsOnly={!!shareView}
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
              openVirtualTab(transactionalCollectionTabPath(ref.datasetPath, ref.tableId));
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
        <Overlay onClose={closeCloud}>
          {/* Once signed in, what is left is settings: the account and the
              sync switch. A session the dialog finds goes there too. */}
          <CloudLogin
            handOffSession
            onClose={closeCloud}
            onConnected={() => {
              setCloudOpen(false);
              setCloudRetryServerUrl("");
              refreshCloudStatus();
              openSettings("cloud");
            }}
            onConnectionError={reportConnectionError}
            initialServerUrl={cloudRetryServerUrl}
          />
        </Overlay>
      ) : null}
      {conflictReviewOpen ? (
        <ConflictReviewDialog
          workspaceId={workspaceId}
          onError={reportShellError}
          beginLineageOperation={beginLineageOperation}
          onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
          onClose={() => setConflictReviewOpen(false)}
        />
      ) : null}
      {stopAndRestore.session ? (
        <StopAndRestoreDialog
          key={stopAndRestore.session.key}
          workspaceId={workspaceId}
          target={stopAndRestore.session.target}
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
          onOpenCollection={(path) => {
            stopAndRestore.close();
            openCollectionTab(path);
          }}
          onError={(fallback, error, retry, identity) => reportShellError(fallback, error, retry, undefined, identity)}
          onSettled={clearIdentity}
        />
      ) : null}
      {recordHistory.session ? (
        <Suspense fallback={null}>
          <LazyRecordHistoryDialog
            key={recordHistory.session.key}
            workspaceId={workspaceId}
            collectionPath={recordHistory.session.target.collectionPath}
            recordId={recordHistory.session.target.recordId}
            recordName={recordHistory.session.target.recordName}
            until={recordHistory.session.until}
            onClose={recordHistory.close}
            onOpenRun={recordHistory.openRun}
            onFailed={recordHistory.failed}
            onRead={recordHistory.read}
            onRunsUnchecked={recordHistory.runsUnchecked}
            onRunsChecked={recordHistory.runsChecked}
          />
        </Suspense>
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
        // A finished pop keeps no transform, so an agent row's fixed ⋯ menu
        // places itself against the window. `!` outranks the unlayered class.
        <Overlay onClose={closeSettings} panelProps={{ className: "dohc-pop-in [animation-fill-mode:backwards]!" }}>
          <LazyDesktopSettings
            workspaceIsReady={workspaceIsReady}
            workspaceOpenFailed={!!workspaceOpenFailure}
            onError={reportSettingsFailure}
            onClearError={clearIdentity}
            onNotice={showSettingsNotice}
            onWorkspaceSettingsRead={onWorkspaceSettingsRead}
            workspaceId={workspaceId}
            workspacePath={props.workspace.rootPath}
            sharedView={!!shareView}
            // Main's own decision, not the renderer's settings read:
            // only main knows whether a recorder exists for this session, and
            // a failed capture build leaves none.
            sessionRecorderOn={
              syncStatus ? !statusSaysNoRecorder(syncStatus) : undefined
            }
            initialSection={settingsSection}
            {...(settingsFocus ? { focus: CUSTOMIZE_TARGETS[settingsFocus] } : {})}
            onClose={closeSettings}
            cloud={cloudSettings}
            onOpenSharing={(target) => {
              closeSettings();
              setSharingFocus(target);
              mutateWb((state) => ({ ...state, activeView: SHARING_VIEW_ID, sidebarVisible: true }));
            }}
            {...(liveDocumentsAvailable
              ? {
                  onOpenLiveDocuments: () => {
                    closeSettings();
                    openLiveDocuments(workspaceId);
                  },
                }
              : {})}
          />
        </Overlay>
      ) : null}
      {liveDocumentsWorkspaceId === workspaceId && !shareView ? (
        <LiveDocumentsDialog
          workspaceId={workspaceId}
          load={loadLiveDocuments}
          stop={stopLiveDocument}
          resume={resumeLiveDocument}
          loadRefusals={loadLiveRefusals}
          retryRefusal={retryLiveShare}
          onError={reportLiveDocumentsError}
          onStopped={liveDocumentStopped}
          saveRecoveryCopy={saveLiveRecoveryCopyFromDialog}
          readKeptEdits={readKeptEdits}
          {...(liveDocumentsReveal === null ? {} : { reveal: liveDocumentsReveal })}
          onClose={() => setLiveDocumentsWorkspaceId(null)}
        />
      ) : null}
      {shareTarget ? (
        <Overlay onClose={() => setShareTarget(null)}>
          <Suspense
            fallback={
              // The share dialog's own card and X, so the dialog lands in its place.
              <div className="relative">
                <SkeletonRows
                  label="Loading share dialog..."
                  className="dohc-elevated w-105 rounded-xl border border-line bg-panel p-5"
                />
                <IconButton
                  aria-label="Close"
                  onClick={() => setShareTarget(null)}
                  className="absolute right-5 top-5"
                >
                  <X size={13} aria-hidden />
                </IconButton>
              </div>
            }
          >
            <LazyRelayShareDialog
              workspaceId={workspaceId}
              target={shareTarget}
              onClose={() => setShareTarget(null)}
              shareRemovals={shareRemovals}
              accessContext={accessContext}
              server={cloudStatus?.workspaceServerUrl ?? null}
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
            ownWorkspace={props.workspaces.some((candidate) => candidate.shareView === undefined)}
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
              // A share opened as its own workspace can show an automation's switch.
              props.onSwitchWorkspace(workspace, (openShare !== "blank" ? openShare.controls : undefined) ?? openSharePath);
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
      {retainedCopiesDialog}
    </div>
    </ShellErrorReporter.Provider>
    </CollectionFieldMarksProvider>
    </CustomizeContext.Provider>
    </AgentColorContext.Provider>
    </AgentSettingsProvider>
  );
}
