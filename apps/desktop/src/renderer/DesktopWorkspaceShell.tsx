import {
  Bot,
  CircleHelp,
  ExternalLink,
  Eye,
  FileArchive,
  FileText,
  History,
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
  ChatThreadRecord,
  CloudStatusResult,
  EngineMomentDetailRecord,
  EngineMomentRecord,
  SyncStatusResult,
  TryInVersionRunState,
  WorkbenchMenuCommand,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
import { buildChatCollaboration } from "./collab/chatCollaboration";
import type { SearchResultsEventEntry } from "../ipc/channels";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import { CommandPalette, type Command } from "./CommandPalette";
import {
  FileInspector,
  preloadMarkdownEditor,
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
import { ActivityBar, activityViewLabel } from "./workbench/ActivityBar";
import { EditorTabs } from "./workbench/EditorTabs";
import { Explorer } from "./workbench/Explorer";
import { projectTreePath, type PendingTreeChange } from "./workbench/file-tree-optimistic";
import { rankQuickOpenPaths } from "./workbench/quick-open-rank";
import { SidePanel } from "./workbench/SidePanel";
import { StatusBar } from "./workbench/StatusBar";
import type { AgentNotification } from "./workbench/agentNotifications";
import type { MentionCandidate } from "./workbench/mentions";
import { useAgentNotifications } from "./workbench/useAgentNotifications";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  UnifiedDiffLines,
  buildUnifiedDiffLines,
  changedLineCounts,
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
import {
  activateTab,
  closeTab,
  clampHistoryWidth,
  isVersionCompareTabPath,
  parseVersionCompareTabPath,
  versionCompareTabPath,
  isMomentDiffTabPath,
  momentDiffTabPath,
  parseMomentDiffTabPath,
  defaultWorkbenchState,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  isGraphTabPath,
  isHistoryDiffTabPath,
  isHistoryTabPath,
  isSiteTabPath,
  isVirtualTabPath,
  moveTab,
  openTab,
  parseHistoryDiffTabPath,
  parseSiteTabPath,
  parseUiState,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  setFolderExpanded,
  setHistoryWidth,
  setSidebarWidth,
  setView,
  toggleFolderExpanded,
  toggleHistory,
  togglePinned,
  toggleSidebar,
  VIEW_IDS,
  type WorkbenchState,
} from "./workbench/workbenchState";

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
const LazySearchView = lazy(() =>
  import("./workbench/SearchView").then((mod) => ({ default: mod.SearchView })),
);
const LazyGraphView = lazy(() =>
  import("./workbench/GraphView").then((mod) => ({ default: mod.GraphView })),
);
const LazySitesView = lazy(() =>
  import("./workbench/SitesView").then((mod) => ({ default: mod.SitesView })),
);
const LazySitePreviewPage = lazy(() =>
  import("./SitePreviewPage").then((mod) => ({ default: mod.SitePreviewPage })),
);
const LazyAgentPanelView = lazy(() =>
  import("./AgentPanelView").then((mod) => ({ default: mod.AgentPanelView })),
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

function uniqueUntitledTextPath(
  files: WorkspaceFileEntry[],
  folders: string[],
): string {
  const occupied = new Set([...files.map((file) => file.path), ...folders]);
  if (!occupied.has("Untitled.txt")) return "Untitled.txt";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `Untitled ${index}.txt`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `Untitled ${Date.now()}.txt`;
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

// Engine history diff page (PR 0M-5, flagged workspaces): one MOMENT's
// before/after through the shared unified-diff rendering, with engine-routed
// restore. Restore returns the file to its state BEFORE this moment and
// records a forward "Restored <file>" moment; undo restores to before THAT
// moment — history is never rewritten.
function EngineMomentDiffPage({
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
  if (!moment) {
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
  const isBinary = moment.contentKind === "binary";
  const before = isProtected || isBinary ? undefined : (moment.beforeText ?? undefined);
  const after = isProtected || isBinary ? undefined : (moment.afterText ?? undefined);
  const counts = isProtected || isBinary ? null : changedLineCounts(before, after);
  // A null beforeText with beforeBinary set means the file EXISTED as binary
  // before this moment (a binary->text transition), not that this change
  // created it — restore brings the bytes back instead of removing the file.
  const createdFile =
    !isProtected && !isBinary && moment.beforeText === null && moment.beforeBinary === undefined;
  const restoreDetail = createdFile
    ? "This change created the file, so restoring removes it from the folder. It stays in history and you can undo."
    : isProtected
      ? "The protected file will be returned to how it was before this change. Its contents stay encrypted and are never shown."
      : isBinary
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
  const diffLines: UnifiedDiffLine[] = buildUnifiedDiffLines(before, after, 800);

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
          <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
            History diff
          </span>
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
            ) : isBinary ? (
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
          ) : isBinary ? (
            <div
              data-testid="engine-diff-binary"
              className="flex flex-col items-center gap-1 px-4 py-10 text-center"
            >
              <FileArchive size={16} aria-hidden className="text-subtle" />
              <span className="text-sm text-muted">Binary contents</span>
              <span className="text-xs text-subtle">
                {moment.byteLength ?? 0} bytes are versioned byte-for-byte and
                are not shown in text diffs.
              </span>
            </div>
          ) : (
            <UnifiedDiffLines lines={diffLines} testId="engine-diff-lines" />
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
                className="h-8 cursor-pointer rounded bg-ink px-3 text-xs font-semibold text-bg hover:opacity-90"
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

function HistoryRail(props: {
  width: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  // Flagged workspaces swap the static "History" label for the
  // History/Chats tab pair; the rail element (and its pinned testid) is the
  // same either way.
  header?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const railRef = useRef<HTMLElement>(null);
  const dragRight = useRef<number | null>(null);

  return (
    <aside
      ref={railRef}
      data-testid="history-timeline"
      aria-label={props.ariaLabel ?? "History"}
      className="relative flex shrink-0 flex-col border-l border-line bg-panel-2"
      style={{ width: props.width }}
    >
      <div
        data-testid="history-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize history"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragRight.current =
            railRef.current?.getBoundingClientRect().right ?? window.innerWidth;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRight.current === null) return;
          if ((event.buttons & 1) === 0) {
            dragRight.current = null;
            return;
          }
          props.onWidthChange(clampHistoryWidth(dragRight.current - event.clientX));
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
        {props.header ?? (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            History
          </span>
        )}
        <button
          type="button"
          data-testid="history-collapse"
          aria-label="Collapse history"
          title="Collapse history"
          onClick={props.onCollapse}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <PanelRight size={13} aria-hidden />
        </button>
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
  const [folders, setFolders] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
  // MU-C5 presence: the signed-in relay session, if any. Drives whether Chats
  // gets a live presence transport (connected + relayUrl) or stays dormant.
  const [cloudStatus, setCloudStatus] = useState<CloudStatusResult | null>(null);
  // Stable per-session client id so this device's own presence entry is
  // identifiable and filtered out of "others". Lazily minted ONCE — a fresh id
  // per render would churn the presence channel.
  const [presenceClientId] = useState(() => crypto.randomUUID());
  const [agentActive, setAgentActive] = useState(false);
  const [agentPanelRefreshKey, setAgentPanelRefreshKey] = useState(0);
  const [sitesRefreshKey, setSitesRefreshKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  // Relay-share dialog target (PR 18): a path (file/folder) or a version.
  const [shareTarget, setShareTarget] = useState<{
    path?: string;
    versionId?: string;
    versionName?: string;
  } | null>(null);
  const [openShareOpen, setOpenShareOpen] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  // Inline-create requests routed INTO the explorer (palette/menu/header).
  const [createRequest, setCreateRequest] = useState<{
    kind: "file" | "folder";
    id: number;
  } | null>(null);
  const [wb, setWb] = useState<WorkbenchState>(defaultWorkbenchState);

  // Runtime-only dirty flag for the ACTIVE tab (the one mounted inspector
  // reports its markdown save state) — never persisted.
  const [activeTabDirty, setActiveTabDirty] = useState(false);
  const onSaveStateChange = useCallback(
    (state: "saved" | "saving" | "error") => setActiveTabDirty(state !== "saved"),
    [],
  );
  useEffect(() => {
    setActiveTabDirty(false);
  }, [wb.activeTab]);
  const onSettingsAgentActiveChange = useCallback((active: boolean) => {
    setAgentActive(active);
    setAgentPanelRefreshKey((key) => key + 1);
  }, []);
  const openSettings = useCallback(
    (section: SettingsSectionId = DEFAULT_SETTINGS_SECTION) => setSettingsSection(section),
    [],
  );
  const closeSettings = useCallback(() => setSettingsSection(null), []);

  // Imperative flush for the active editor's unsaved draft (registered by
  // the mounted MarkdownView). Explorer ops await it BEFORE their disk ops:
  // a rename of the open file otherwise remounts the keyed inspector after
  // the path moved, and its unmount flush writes to the renamed-away OLD
  // path — ENOENT, swallowed, keystrokes inside the autosave window lost.
  const draftFlushRef = useRef<(() => Promise<void>) | null>(null);
  const registerDraftFlush = useCallback(
    (flush: (() => Promise<void>) | null) => {
      draftFlushRef.current = flush;
    },
    [],
  );
  const flushActiveDraft = useCallback(async () => {
    await draftFlushRef.current?.();
  }, []);
  const activeUndoRef = useRef<ActiveUndoHandler | null>(null);
  const registerActiveUndo = useCallback((handler: ActiveUndoHandler | null) => {
    activeUndoRef.current = handler;
  }, []);

  const workspaceId = props.workspace.workspaceId;
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
  const activeDocumentPath = isVirtualTabPath(wb.activeTab) ? null : wb.activeTab;
  const activeSiteRoot = parseSiteTabPath(wb.activeTab);

  // A clicked search result: open the file AND land at the line. The target
  // is consumed (cleared) by the inspector once a mounted view applied it.
  const [searchScrollTarget, setSearchScrollTarget] = useState<ScrollTarget | null>(
    null,
  );
  const scrollNonce = useRef(0);
  const consumeScrollTarget = useCallback(() => setSearchScrollTarget(null), []);

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
  const wbRef = useRef(wb);

  // THE one mutation seam for workbench state: every user-driven transition
  // routes through here so the touched flag is set before React even queues
  // the update. Loading stored state is the only setWb that bypasses this.
  const mutateWb = useCallback(
    (updater: (state: WorkbenchState) => WorkbenchState) => {
      userTouchedWb.current = true;
      setWb(updater);
    },
    [],
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

  const refreshFiles = useCallback(async () => {
    const result = await bridge().listWorkspaceFiles({ workspaceId });
    setFiles(result.files);
    setFolders(result.folders ?? []);
  }, [workspaceId]);

  const reportShellError = useCallback((fallback: string, error: unknown) => {
    setShellError(error instanceof Error ? error.message : fallback);
  }, []);

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
  const [engineEnabled, setEngineEnabled] = useState(false);
  // Engine history page state (flagged workspaces): newest-first moments,
  // the keyset cursor for older pages, and the monotonic latest order used
  // as the open-file refresh key.
  const [engineHistory, setEngineHistory] = useState<{
    moments: EngineMomentRecord[];
    nextBeforeMomentOrder: number | null;
    latestMomentOrder: number;
  } | null>(null);
  const [engineHistoryLoadingMore, setEngineHistoryLoadingMore] = useState(false);
  // Liveness token for the engine history loads (bumped on unmount): a slow
  // response for one workspace must never repaint another.
  const engineHistoryToken = useRef(0);
  useEffect(
    () => () => {
      engineHistoryToken.current += 1;
    },
    [],
  );
  // Right rail content for flagged workspaces: History timeline or the
  // active file's Chats. Runtime-only — not persisted.
  const [railView, setRailView] = useState<"history" | "chats">("history");
  const [searchChatThread, setSearchChatThread] = useState<ChatThreadRecord | null>(null);
  // "Try it in a version" (PR 0N-2): the workspace's live try session —
  // running banner or the run's review card. Refreshed with history (the
  // manager pings the same workspace-activity channel on every transition).
  const [tryState, setTryState] = useState<TryInVersionRunState | null>(null);

  const refreshHistory = useCallback(async () => {
    if (engineEnabled) {
      // Latest-wins: each request ADVANCES the token, so an older slower
      // response can never overwrite newer moments or move
      // latestMomentOrder backward (shared with loadMoreEngineHistory).
      const token = ++engineHistoryToken.current;
      const [page, status, agent, trySession] = await Promise.all([
        bridge().listEngineMoments({ workspaceId, limit: 200 }),
        bridge().getSyncStatus({ workspaceId }),
        bridge().getAgentRunStatus({ workspaceId }),
        bridge().getTryInVersionState({ workspaceId }),
      ]);
      if (token !== engineHistoryToken.current) return;
      // A refresh returns to the newest page; older pages reload on demand.
      // It also supersedes any in-flight load-more, whose finally can no
      // longer clear the flag (its token is stale now).
      setEngineHistoryLoadingMore(false);
      setEngineHistory({
        moments: page.moments,
        nextBeforeMomentOrder: page.nextBeforeMomentOrder,
        latestMomentOrder: page.latestMomentOrder,
      });
      setSyncStatus(status);
      setAgentActive(agent.activeRun !== null);
      setTryState(trySession.state);
      return;
    }
    // Opted-out workspace (retirement Phase C): no history source exists —
    // only status and agent state refresh.
    const [status, agent] = await Promise.all([
      bridge().getSyncStatus({ workspaceId }),
      bridge().getAgentRunStatus({ workspaceId }),
    ]);
    setSyncStatus(status);
    setAgentActive(agent.activeRun !== null);
  }, [engineEnabled, workspaceId]);

  const loadMoreEngineHistory = useCallback(async () => {
    const cursor = engineHistory?.nextBeforeMomentOrder;
    if (cursor === null || cursor === undefined || engineHistoryLoadingMore) return;
    // Latest-wins with refreshHistory: advancing the token means a refresh
    // started after this pagination supersedes it (and vice versa), so
    // overlapping responses can never interleave into a mixed timeline.
    const token = ++engineHistoryToken.current;
    setEngineHistoryLoadingMore(true);
    try {
      const page = await bridge().listEngineMoments({
        workspaceId,
        limit: 200,
        beforeMomentOrder: cursor,
      });
      if (token !== engineHistoryToken.current) return;
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
    } catch (error) {
      if (token !== engineHistoryToken.current) return;
      reportShellError("Could not load earlier history.", error);
    } finally {
      if (token === engineHistoryToken.current) setEngineHistoryLoadingMore(false);
    }
  }, [engineHistory, engineHistoryLoadingMore, reportShellError, workspaceId]);

  // Named versions (PR 0M-4): the surface exists only for workspaces with the
  // workspace-engine alpha flag on — unflagged workspaces render nothing.
  const versionsEnabled = engineEnabled;
  const setVersionsEnabled = setEngineEnabled;
  // Bumped after a version switch/merge/conflict resolution so open editors
  // re-read their file content immediately (FileInspector refreshKey).
  const [versionEpoch, setVersionEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setVersionsEnabled(false);
    void bridge()
      .getWorkspaceSettings({ workspaceId })
      .then((result) => {
        if (cancelled) return;
        setVersionsEnabled(result.settings.experimental.workspaceEngineAlpha);
        // A persisted "chats" view from a previously flagged session must
        // not strand an unflagged workspace on an empty panel. Raw setWb:
        // this is a correction, not a user touch — it must not block the
        // stored ui-state merge-on-load.
        if (!result.settings.experimental.workspaceEngineAlpha) {
          setWb((state) =>
            state.activeView === "chats"
              ? { ...state, activeView: "explorer" }
              : state,
          );
        }
      })
      .catch(() => {
        // Settings unavailable reads as flag off — never a broken shell.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  // Conflict review (0P-C): opened from the notice center's conflict notice.
  // Lists every open conflict — two machines editing apart, or a merge left
  // with "Finish later" — with the same side-by-side cards as the merge flow.
  const [conflictReviewOpen, setConflictReviewOpen] = useState(false);
  const onVersionWorkspaceStateChanged = useCallback(() => {
    setVersionEpoch((epoch) => epoch + 1);
    void refreshFiles().catch((error) =>
      reportShellError("Could not refresh workspace files.", error),
    );
    void refreshHistory().catch((error) =>
      reportShellError("Could not refresh history.", error),
    );
  }, [refreshFiles, refreshHistory, reportShellError]);
  const openVersionCompareTab = useCallback(
    (versionId: string) => {
      mutateWb((state) => openTab(state, versionCompareTabPath(versionId)));
    },
    [mutateWb],
  );

  // One import seam for the dialog flow AND the OS drag-in flow (the latter
  // passes the preload-resolved absolute paths; see the trust-delta note on
  // ImportWorkspaceFilesPayload).
  const importFiles = useCallback(
    async (droppedPaths?: string[]) => {
      try {
        await bridge().importWorkspaceFiles({
          workspaceId,
          ...(droppedPaths ? { droppedPaths } : {}),
        });
      } catch (error) {
        reportShellError("Could not import files.", error);
        return;
      }
      try {
        await refreshFiles();
      } catch (error) {
        reportShellError("Files imported, but the explorer could not refresh.", error);
      }
    },
    [workspaceId, refreshFiles, reportShellError],
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
    (path: string) => {
      if (/\.(md|markdown)$/i.test(path)) preloadMarkdownEditor();
      if (openTab(wbRef.current, path) !== wbRef.current) {
        rendererMarks.mark("file-open-start");
      }
      // Every open also records recency (quick-open ranking, Phase E5.0).
      mutateWb((state) => recordRecentFile(openTab(state, path), path));
    },
    [mutateWb],
  );
  const openGraphTab = useCallback(() => {
    mutateWb((state) => openTab(state, GRAPH_TAB_PATH));
  }, [mutateWb]);
  const openHistoryTab = useCallback(() => {
    mutateWb((state) => openTab(state, HISTORY_TAB_PATH));
  }, [mutateWb]);
  // Engine history diff (flagged workspaces): one tab per moment.
  const openMomentDiffTab = useCallback(
    (momentId: string) => {
      void flushActiveDraft()
        .then(() => {
          mutateWb((state) => openTab(state, momentDiffTabPath(momentId)));
        })
        .catch((error) => {
          reportShellError("Could not save the active draft before opening history.", error);
        });
    },
    [flushActiveDraft, mutateWb, reportShellError],
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
    (path: string) => {
      if (isVirtualTabPath(path)) {
        mutateWb((state) => activateTab(state, path));
        return;
      }
      openFile(path);
    },
    [mutateWb, openFile],
  );

  // The ONE way a chat thread lands in the rail (search hits and the Chats
  // view "Files" grouping both route here): hand the thread to the rail's
  // consume-once initialThread seam, switch to the Chats tab, and force the
  // rail visible.
  const openChatThreadInRail = useCallback(
    (thread: { id: string; title: string; createdAtMs: number; updatedAtMs: number }) => {
      setSearchChatThread({
        id: thread.id,
        title: thread.title,
        createdAtMs: thread.createdAtMs,
        updatedAtMs: thread.updatedAtMs,
      });
      setRailView("chats");
      mutateWb((state) => ({ ...state, historyVisible: true }));
    },
    [mutateWb],
  );

  // Chats view "Files" grouping cross-link: a file-linked Chat opens where
  // it lives — the file (when it still resolves) plus the rail on the thread.
  const openFileChatInRail = useCallback(
    (thread: { id: string; title: string; createdAtMs: number; updatedAtMs: number; path: string | null }) => {
      openChatThreadInRail(thread);
      if (thread.path) openFile(thread.path);
    },
    [openChatThreadInRail, openFile],
  );

  // Search-result click: open + land at the line (source mode this phase);
  // chat results open in the rail instead.
  const openSearchResult = useCallback(
    (path: string, line: number, _column: number, entry?: SearchResultsEventEntry) => {
      if (entry?.surface === "chat" && entry.threadId) {
        const now = Date.now();
        openChatThreadInRail({
          id: entry.threadId,
          title: entry.title ?? entry.threadId,
          createdAtMs: now,
          updatedAtMs: now,
        });
        return;
      }
      setSearchScrollTarget({ path, line, nonce: ++scrollNonce.current });
      openFile(path);
    },
    [openChatThreadInRail, openFile],
  );

  // Stable handlers (Tab/FileRow memo contract: a fresh closure here would
  // re-render the whole strip on every shell render, incl. each 800ms dirty
  // flip while typing). Closing the ACTIVE tab activates its neighbor, which
  // remounts the keyed inspector — that is an OPEN, so re-mark
  // file-open-start or the view's mount measure would bracket the stale mark
  // the last explicit open left (garbage open-latency telemetry). Like
  // openFile, the transition is read from wbRef and marked before setState.
  const closeFileTab = useCallback(
    (path: string) => {
      const current = wbRef.current;
      const next = closeTab(current, path);
      if (
        next.activeTab !== current.activeTab &&
        next.activeTab !== null &&
        !isVirtualTabPath(next.activeTab)
      ) {
        rendererMarks.mark("file-open-start");
      }
      mutateWb((state) => closeTab(state, path));
    },
    [mutateWb],
  );

  const closeActiveTab = useCallback(() => {
    const current = wbRef.current;
    if (!current.activeTab) return;
    const next = closeTab(current, current.activeTab);
    if (next.activeTab !== null && !isVirtualTabPath(next.activeTab)) {
      rendererMarks.mark("file-open-start");
    }
    mutateWb((state) => (state.activeTab ? closeTab(state, state.activeTab) : state));
  }, [mutateWb]);

  const closeAllTabs = useCallback(() => {
    mutateWb((state) =>
      state.tabs.length === 0 && state.activeTab === null
        ? state
        : { ...state, tabs: [], activeTab: null },
    );
  }, [mutateWb]);

  const closeOtherTabs = useCallback(
    (path: string) => {
      const current = wbRef.current;
      if (!current.tabs.some((tab) => tab.path === path)) return;
      if (current.activeTab !== path && !isVirtualTabPath(path)) {
        rendererMarks.mark("file-open-start");
      }
      mutateWb((state) => {
        if (!state.tabs.some((tab) => tab.path === path)) return state;
        if (state.tabs.length === 1 && state.activeTab === path) return state;
        return { ...state, tabs: [{ path }], activeTab: path };
      });
    },
    [mutateWb],
  );

  const moveFileTab = useCallback(
    (path: string, toIndex: number) => {
      mutateWb((state) =>
        moveTab(
          state,
          state.tabs.findIndex((tab) => tab.path === path),
          toIndex,
        ),
      );
    },
    [mutateWb],
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
      const current = wbRef.current;
      const next = remapWorkbenchPaths(current, (path) =>
        projectTreePath(path, changes),
      );
      if (next.activeTab !== current.activeTab && next.activeTab !== null) {
        rendererMarks.mark("file-open-start");
      }
      mutateWb((state) =>
        remapWorkbenchPaths(state, (path) => projectTreePath(path, changes)),
      );
    },
    [mutateWb],
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
        relativePath: uniqueUntitledTextPath(files, folders),
      });
      await refreshFiles();
      openFile(result.path);
    } catch (error) {
      reportShellError("Could not create an untitled text file.", error);
    }
  }, [files, folders, openFile, refreshFiles, reportShellError, workspaceId]);
  const openHistoryView = useCallback(() => {
    mutateWb((state) => ({
      ...setView(state, "history"),
      sidebarVisible: true,
      historyVisible: true,
    }));
  }, [mutateWb]);
  const openAgentView = useCallback(() => {
    // Opening the Agent panel means the user is now looking at the run, so
    // its finished/error/ask notices auto-clear.
    agentNotifs.clearForCurrentWorkspace();
    mutateWb((state) => ({ ...setView(state, "agent"), sidebarVisible: true }));
  }, [agentNotifs, mutateWb]);

  // A NoticeCenter / inbox item was opened: land on the run and clear it.
  // openAgentView() clears every notice for this workspace, so opening the run
  // is the single, obvious clear — there is no per-thread clear because the
  // agent session isn't tied to a specific chat thread (see agentNotifications).
  const openAgentNotification = useCallback(
    (_notification: AgentNotification) => {
      openAgentView();
    },
    [openAgentView],
  );

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
      const result = await bridge().installUpdate();
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

  const runWorkbenchMenuCommand = useCallback(
    (command: WorkbenchMenuCommand, path?: string) => {
      if (command === "close-tab" && path) {
        closeFileTab(path);
      } else if (command === "close-other-tabs" && path) {
        closeOtherTabs(path);
      } else if (command === "copy-path" && path && !isVirtualTabPath(path)) {
        void navigator.clipboard?.writeText(path);
      } else if (command === "show-in-explorer" && path && !isVirtualTabPath(path)) {
        showPathInExplorer(path);
      } else if (command === "open-agent") {
        openAgentView();
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
      closeFileTab,
      closeOtherTabs,
      checkForDesktopUpdates,
      installDesktopUpdate,
      openAgentView,
      openHistoryView,
      openSettings,
      showPathInExplorer,
    ],
  );

  const showWorkbenchMenu = useCallback(
    async (context: "tab" | "editor" | "status", path?: string) => {
      try {
        const command = await bridge().showWorkbenchMenu({
          workspaceId,
          context,
          ...(path ? { path } : {}),
        });
        if (command) runWorkbenchMenuCommand(command, path);
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
    void (async () => {
      try {
        const status = await bridge().openWorkspace({ workspaceId });
        if (!cancelled) setSyncStatus(status);
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
  }, [workspaceId, refreshFiles, refreshHistory, reportShellError]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === "," && !event.shiftKey && !event.altKey) {
        if (!hasBlockingModal()) {
          event.preventDefault();
          openSettings();
        }
        return;
      }
      if (
        event.key.toLowerCase() === "z" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const activeUndo = activeUndoRef.current;
        if (activeUndo?.acceptsEvent(event)) {
          event.preventDefault();
          void activeUndo.run().catch((error) =>
            reportShellError("Could not undo the last history restore.", error),
          );
        }
        return;
      }
      // The application menu DISPLAYS these accelerators but does not
      // register them (registerAccelerator: false) — this handler is the one
      // owner of the keystrokes. Shift+P is "P" (uppercase) in event.key.
      if (event.key === "n") {
        event.preventDefault();
        setNewFileOpen(true);
      } else if (event.key === "k" || (event.shiftKey && event.key === "P")) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "p") {
        event.preventDefault();
        setQuickOpenOpen((open) => !open);
      } else if (event.key === "b") {
        event.preventDefault();
        mutateWb(toggleSidebar);
      } else if (event.key === "w") {
        // Ctrl+W closes the TAB (the menu's Close Window moved to
        // Ctrl+Shift+W so the close role can't swallow this keystroke).
        event.preventDefault();
        closeActiveTab();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeActiveTab, mutateWb, openSettings, reportShellError]);

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
        id: "toggle-history",
        label: "Toggle history rail",
        run: () => mutateWb(toggleHistory),
      },
      ...VIEW_IDS.filter((view) => view !== "chats" || versionsEnabled).map(
        (view) => ({
          id: `show-${view}`,
          label: `View: ${activityViewLabel(view)}`,
          run: () => mutateWb((state) => setView(state, view)),
        }),
      ),
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
      openWorkspaceFolder,
      closeActiveTab,
      importFiles,
      mutateWb,
      requestExplorerCreate,
      checkForDesktopUpdates,
      installDesktopUpdate,
      openSettings,
      reportShellError,
      versionsEnabled,
      workspaceId,
    ],
  );

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      if (command === "command-palette") setPaletteOpen(true);
      else commands.find((entry) => entry.id === command)?.run();
    });
  }, [commands]);

  // ONE history timeline element, rendered by the side panel's History view,
  // the history tab, and the right rail — the engine page state is
  // root-owned (never a second subscription). An opted-out workspace has NO
  // history source (retirement Phase C removed the legacy recorder), so the
  // timeline honestly says history is off instead of showing an empty list.
  const historyTimeline = engineEnabled ? (
    <EngineHistoryView
      moments={engineHistory?.moments ?? []}
      hasMore={engineHistory?.nextBeforeMomentOrder != null}
      loadingMore={engineHistoryLoadingMore}
      onLoadMore={() => void loadMoreEngineHistory()}
      onOpenMoment={openMomentDiffTab}
    />
  ) : (
    <div
      data-testid="history-off-placeholder"
      className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
    >
      <span className="text-xs text-muted">History is off for this workspace</span>
      <span className="text-[11px] text-subtle">
        The workspace engine is turned off in Settings → Advanced, so changes
        are not being recorded. Turn it on and reopen the workspace to record
        history again.
      </span>
    </div>
  );
  // Open-file refresh: history growth re-reads the active file (the counter
  // only ever increases within a session). Opted-out workspaces have no
  // history growth to react to.
  const historyRefreshCounter = engineEnabled
    ? (engineHistory ? engineHistory.latestMomentOrder + 1 : 0)
    : 0;
  const graphKey = engineEnabled
    ? `${graphRefreshKey}\0${engineHistory?.latestMomentOrder ?? -1}`
    : graphRefreshKey;

  // Read-only shared view (PR 18): the workspace was received through a
  // share grant. It refreshes on open and on demand, and every edit surface
  // is disabled with honest copy.
  const shareView = props.workspace.shareView ?? null;
  const [shareViewEnded, setShareViewEnded] = useState(!!shareView?.ended);
  const [shareRefreshing, setShareRefreshing] = useState(false);
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
      setShareRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareView?.shareId, shareViewEnded, workspaceId]);
  useEffect(() => {
    // One automatic refresh when a shared view opens; afterwards on demand.
    if (shareView && !shareViewEnded) void refreshShareView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const explorerView = (
    <>
      <Explorer
        workspaceId={workspaceId}
        files={files}
        folders={folders}
        activeTab={wb.activeTab}
        openTabs={wb.tabs}
        dirtyTab={activeTabDirty ? wb.activeTab : null}
        expandedFolders={wb.expandedFolders}
        pinned={wb.pinned}
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
        onBeforeChanges={flushActiveDraft}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={(droppedPaths) => void importFiles(droppedPaths)}
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
      />
      {shellError ? (
        <div
          data-testid="workspace-shell-error"
          className="flex min-h-8 items-center gap-2 border-b border-line bg-danger/10 px-3 text-[12px] text-danger"
        >
          <span className="min-w-0 flex-1 truncate">{shellError}</span>
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
          agentActive={agentActive}
          chatsEnabled={versionsEnabled}
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
                <>
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
                  <button
                    type="button"
                    data-testid="history-rail-toggle"
                    aria-label="Toggle history rail"
                    title="Toggle history rail"
                    onClick={() => mutateWb(toggleHistory)}
                    className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                  >
                    <PanelRight size={13} aria-hidden />
                  </button>
                </>
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
            {wb.activeView === "explorer" ? (
              explorerView
            ) : wb.activeView === "search" ? (
              <Suspense fallback={<PanelLoading label="search" />}>
                <LazySearchView search={search} onOpenResult={openSearchResult} />
              </Suspense>
            ) : wb.activeView === "graph" ? (
              <Suspense fallback={<PanelLoading label="graph" />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={activeDocumentPath}
                  refreshKey={graphKey}
                  onOpenPath={openFile}
                  variant="panel"
                />
              </Suspense>
            ) : wb.activeView === "sites" ? (
              <Suspense fallback={<PanelLoading label="sites" />}>
                <LazySitesView
                  workspaceId={workspaceId}
                  files={files}
                  refreshKey={sitesRefreshKey}
                  onOpenPath={openFile}
                />
              </Suspense>
            ) : wb.activeView === "chats" ? (
              versionsEnabled ? (
                <Suspense fallback={<PanelLoading label="Chats" />}>
                  <LazyChatsView
                    workspaceId={workspaceId}
                    onOpenFileChat={openFileChatInRail}
                    onError={(message) => setShellError(message)}
                    mentionCandidates={mentionCandidates}
                    addressedToMe={addressedToMe}
                    onOpenAddressed={openAgentNotification}
                    collaboration={chatCollaboration}
                  />
                </Suspense>
              ) : (
                // Transient: the settings load corrects activeView moments
                // later; never a blank panel meanwhile.
                <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-subtle">
                  Chats aren't enabled for this workspace.
                </div>
              )
            ) : wb.activeView === "history" ? (
              historyTimeline
            ) : wb.activeView === "agent" ? (
              <Suspense fallback={<PanelLoading label="agent" />}>
                <LazyAgentPanelView
                  workspaceId={workspaceId}
                  refreshKey={agentPanelRefreshKey}
                  onAgentActiveChange={setAgentActive}
                />
              </Suspense>
            ) : null}
          </SidePanel>
        ) : null}

        {/* Editor area: tab strip + the active tab's inspector. When the
            workspace-engine alpha flag is on, the version selector shares the
            tab-strip band (right side); unflagged workspaces render the strip
            exactly as before. */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {versionsEnabled ? (
            <div className="flex shrink-0 bg-panel-2">
              <div
                className={`min-w-0 flex-1 ${
                  wb.tabs.length === 0 ? "border-b border-line" : ""
                }`}
              >
                <EditorTabs
                  tabs={wb.tabs}
                  activeTab={wb.activeTab}
                  activeTabDirty={activeTabDirty}
                  onActivate={activateEditorTab}
                  onClose={closeFileTab}
                  onContextMenu={(path) => void showWorkbenchMenu("tab", path)}
                  onMove={moveFileTab}
                />
              </div>
              <div className="flex h-9 shrink-0 items-center border-b border-l border-line pl-1 pr-1.5">
                <VersionMenu
                  workspaceId={workspaceId}
                  activeTabDirty={activeTabDirty}
                  flushActiveDraft={flushActiveDraft}
                  onOpenCompare={openVersionCompareTab}
                  onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
                  onError={(message) => setShellError(message)}
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
            </div>
          ) : (
            <EditorTabs
              tabs={wb.tabs}
              activeTab={wb.activeTab}
              activeTabDirty={activeTabDirty}
              onActivate={activateEditorTab}
              onClose={closeFileTab}
              onContextMenu={(path) => void showWorkbenchMenu("tab", path)}
              onMove={moveFileTab}
            />
          )}
          {/* "Try it in a version" (PR 0N-2): honest run status while the
              agent works, then the review card when the run ends. Flagged
              workspaces only (tryState never exists otherwise). */}
          {versionsEnabled && tryState?.status === "running" ? (
            <TryInVersionBanner
              task={tryState.task}
              versionName={tryState.versionName}
              onWatch={() =>
                mutateWb((state) => ({ ...setView(state, "agent"), sidebarVisible: true }))
              }
            />
          ) : null}
          {versionsEnabled && tryState?.status === "review" ? (
            <TryInVersionReviewCard
              workspaceId={workspaceId}
              state={tryState}
              activeTabDirty={activeTabDirty}
              flushActiveDraft={flushActiveDraft}
              onOpenCompare={openVersionCompareTab}
              onWorkspaceStateChanged={onVersionWorkspaceStateChanged}
              onDismissed={() => setTryState(null)}
            />
          ) : null}
          <div
            className="flex min-h-0 flex-1 flex-col"
            onContextMenu={(event) => {
              event.preventDefault();
              void showWorkbenchMenu("editor");
            }}
          >
            {isGraphTabPath(wb.activeTab) ? (
              <Suspense fallback={<PanelLoading label="graph" />}>
                <LazyGraphView
                  workspaceId={workspaceId}
                  activePath={activeDocumentPath}
                  refreshKey={graphKey}
                  onOpenPath={openFile}
                  variant="page"
                />
              </Suspense>
            ) : isHistoryTabPath(wb.activeTab) ? (
              <div
                data-testid="history-page"
                className="flex min-h-0 flex-1 flex-col bg-bg"
              >
                {historyTimeline}
              </div>
            ) : isMomentDiffTabPath(wb.activeTab) ? (
              <EngineMomentDiffPage
                workspaceId={workspaceId}
                tabPath={wb.activeTab ?? ""}
                onBeforeRestore={flushActiveDraft}
                onOpenFile={openFile}
                registerActiveUndo={registerActiveUndo}
                onRestored={refreshAfterHistoryRestore}
              />
            ) : isHistoryDiffTabPath(wb.activeTab) ? (
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
            ) : isVersionCompareTabPath(wb.activeTab) ? (
              <VersionComparePage
                // Remount per version AND per state change so the diff always
                // reflects the latest disk/engine state.
                key={`${wb.activeTab}:${versionEpoch}`}
                workspaceId={workspaceId}
                versionId={parseVersionCompareTabPath(wb.activeTab) ?? "main"}
              />
            ) : isSiteTabPath(wb.activeTab) ? (
              activeSiteRoot ? (
                <Suspense fallback={<PanelLoading label="site" />}>
                  <LazySitePreviewPage
                    workspaceId={workspaceId}
                    siteRoot={activeSiteRoot}
                  />
                </Suspense>
              ) : (
                <InvalidSitePathFallback
                  activeTab={wb.activeTab}
                  onClose={closeActiveTab}
                />
              )
            ) : wb.activeTab ? (
              <FileInspector
                key={wb.activeTab}
                workspaceId={workspaceId}
                path={wb.activeTab}
                // History growth AND version switches both re-read the open
                // file (both counters only ever increase).
                refreshKey={historyRefreshCounter + versionEpoch}
                // G2-C-3: the engine editor re-binds to the new version's Y.Doc
                // lineage ONLY on an active-version change — versionEpoch alone,
                // NOT history growth (which must not churn the live session).
                engineVersionKey={versionEpoch}
                onOpenPath={openFile}
                scrollTarget={searchScrollTarget ?? undefined}
                onScrollConsumed={consumeScrollTarget}
                onSaveStateChange={onSaveStateChange}
                registerDraftFlush={registerDraftFlush}
                knownMarkdownFiles={markdownWikilinkFiles}
                readOnly={!!shareView}
                {...(shareView
                  ? {}
                  : { onSharePath: (path: string) => setShareTarget({ path }) })}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <span className="text-sm text-muted">
                  Select a file, or create one
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setNewFileOpen(true)}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    Ctrl N · new file
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    Ctrl K · commands
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickOpenOpen(true)}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    Ctrl P · go to file
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* History timeline — the "git log for everyday people". Every
            settled change (yours or your agent's) lands here, newest first.
            Default-visible right rail (specs assert it with zero clicks);
            toggleable via the toggle-history command. */}
        {wb.historyVisible ? (
          <HistoryRail
            width={wb.historyWidth}
            onWidthChange={(width) => mutateWb((state) => setHistoryWidth(state, width))}
            onCollapse={() => mutateWb(toggleHistory)}
            ariaLabel={engineEnabled && railView === "chats" ? "Chats" : "History"}
            header={
              engineEnabled ? (
                <div className="flex items-center gap-0.5">
                  {(
                    [
                      ["history", "History"],
                      ["chats", "Chats"],
                    ] as const
                  ).map(([view, label]) => (
                    <button
                      key={view}
                      type="button"
                      data-testid={`rail-tab-${view}`}
                      aria-pressed={railView === view}
                      onClick={() => setRailView(view)}
                      className={`h-6 rounded px-2 text-[11px] font-semibold uppercase tracking-wide ${
                        railView === view
                          ? "bg-line/60 text-ink"
                          : "text-muted hover:bg-line/40 hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
          >
            {engineEnabled && railView === "chats" ? (
              <Suspense fallback={<PanelLoading label="Chats" />}>
                <LazyLinkedChatsPanel
                  workspaceId={workspaceId}
                  filePath={activeDocumentPath}
                  initialThread={searchChatThread}
                  onInitialThreadConsumed={() => setSearchChatThread(null)}
                  onError={(message) => setShellError(message)}
                />
              </Suspense>
            ) : (
              historyTimeline
            )}
          </HistoryRail>
        ) : (
          <aside
            aria-label="History collapsed"
            className="flex w-9 shrink-0 justify-center border-l border-line bg-panel-2 pt-2"
          >
            <button
              type="button"
              data-testid="history-restore"
              aria-label="Restore history"
              title="Restore history"
              onClick={() => mutateWb(toggleHistory)}
              className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
            >
              <History size={13} aria-hidden />
            </button>
          </aside>
        )}
      </div>

      <StatusBar
        workspaceName={workspaceName(props.workspace)}
        syncStatus={syncStatus}
        agentActive={agentActive}
        conflictSummaries={conflictSummaries}
        onConnectCloud={() => setCloudOpen(true)}
        onOpenAgent={openAgentView}
        onOpenHistory={openHistoryView}
        onOpenConflicts={() => setConflictReviewOpen(true)}
        onDismissSyncReview={() =>
          void bridge()
            .dismissSyncReviewNotice({ workspaceId: props.workspace.workspaceId })
            .catch(() => undefined)
        }
        onOpenSettings={() => openSettings()}
        onToggleTheme={toggleTheme}
        onContextMenu={() => void showWorkbenchMenu("status")}
        agentNotifications={agentNotifs.notifications}
        onOpenAgentNotification={openAgentNotification}
        onDismissAgentNotification={agentNotifs.dismiss}
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
            initialSection={settingsSection}
            onClose={closeSettings}
            onAgentActiveChange={onSettingsAgentActiveChange}
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
          />
        </Overlay>
      ) : null}
    </div>
  );
}
