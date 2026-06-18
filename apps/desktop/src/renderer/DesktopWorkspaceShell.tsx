import {
  Bot,
  CheckCheck,
  Cloud,
  FilePlus2,
  FolderPlus,
  History,
  Maximize2,
  PanelRight,
  RefreshCw,
  User,
} from "lucide-react";
import {
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
  ChangeSetRecord,
  SyncStatusResult,
  WorkbenchMenuCommand,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
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
import { Overlay } from "./Overlay";
import { DesktopSettings } from "./settings/DesktopSettings";
import { Titlebar, workspaceName } from "./Titlebar";
import { toggleTheme } from "./theme";
import { ActivityBar, activityViewLabel } from "./workbench/ActivityBar";
import { EditorTabs } from "./workbench/EditorTabs";
import { Explorer } from "./workbench/Explorer";
import { projectTreePath, type PendingTreeChange } from "./workbench/file-tree-optimistic";
import { rankQuickOpenPaths } from "./workbench/quick-open-rank";
import { SidePanel } from "./workbench/SidePanel";
import { StatusBar } from "./workbench/StatusBar";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  activateTab,
  closeTab,
  clampHistoryWidth,
  defaultWorkbenchState,
  GRAPH_TAB_PATH,
  isGraphTabPath,
  moveTab,
  openTab,
  parseUiState,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  setCatchUpSeenAt,
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

const LazyShareDialog = lazy(() =>
  import("./ShareDialog").then((mod) => ({ default: mod.ShareDialog })),
);
const LazyImportExportDialog = lazy(() =>
  import("./ImportExportDialog").then((mod) => ({
    default: mod.ImportExportDialog,
  })),
);
const LazyWorkspaceManagementDialog = lazy(() =>
  import("./WorkspaceManagementDialog").then((mod) => ({
    default: mod.WorkspaceManagementDialog,
  })),
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
const LazyAppsView = lazy(() =>
  import("./workbench/AppsView").then((mod) => ({ default: mod.AppsView })),
);
const LazyAgentPanelView = lazy(() =>
  import("./AgentPanelView").then((mod) => ({ default: mod.AgentPanelView })),
);

type CatchUpState = {
  status: "loading" | "ready" | "error";
  lines: string[];
  latestRecordedAtMs: number | null;
  latestChangeSetId: string | null;
  latestHistoryIndex: number | null;
};

function describeConflictForCatchUp(path: string, conflictPath: string): string {
  return (
    `Both sides changed ${path}: your local version was kept, ` +
    `while ${conflictPath} stores the other version. Both versions are kept until you choose.`
  );
}

// Every folder above a path — expanded when a create/open must REVEAL it.
function ancestorDirs(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

// The timeline body, shared by the right history rail and the side panel's
// History view (both render the same root-owned changeSets — never a second
// subscription). The pinned history-timeline testid stays on the RAIL only.
function HistoryList({ changeSets }: { changeSets: ChangeSetRecord[] }) {
  if (changeSets.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <span className="text-xs text-muted">No changes yet</span>
        <span className="text-[11px] text-subtle">
          Edits — yours or your agent's — show up here as a timeline you can
          review.
        </span>
      </div>
    );
  }
  return (
    <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
      {changeSets.map((change) => (
        <li
          key={change.id}
          data-testid="change-set"
          className="flex flex-col gap-0.5 border-b border-line px-3 py-2"
        >
          <span className="flex items-center gap-1.5 text-[12px] text-ink">
            {change.author.kind === "agent" ? (
              <Bot size={12} aria-hidden className="shrink-0 text-subtle" />
            ) : (
              <User size={12} aria-hidden className="shrink-0 text-subtle" />
            )}
            <span className="truncate">{change.humanSummary}</span>
          </span>
          <span className="text-[10px] text-subtle">
            {change.fileCount} file{change.fileCount === 1 ? "" : "s"}
            {" · "}
            {change.kind}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CatchUpSummaryCard(props: {
  catchUp: CatchUpState;
  conflictSummaries: string[];
  onMarkCaughtUp: () => void;
}) {
  const hasLines = props.catchUp.lines.length > 0;
  const hasConflicts = props.conflictSummaries.length > 0;
  return (
    <section
      data-testid="catch-up-summary"
      data-state={props.catchUp.status}
      className="shrink-0 border-b border-line bg-panel px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Catch-up
        </span>
        <button
          type="button"
          data-testid="catch-up-mark-seen"
          disabled={!hasLines}
          onClick={props.onMarkCaughtUp}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          aria-label="Mark caught up"
          title="Mark caught up"
        >
          <CheckCheck size={13} aria-hidden />
        </button>
      </div>
      {props.catchUp.status === "loading" ? (
        <p className="mb-0 mt-1 text-[11px] text-subtle">Checking history…</p>
      ) : props.catchUp.status === "error" ? (
        <p className="mb-0 mt-1 text-[11px] text-danger">Catch-up unavailable.</p>
      ) : hasLines || hasConflicts ? (
        <div className="mt-1 space-y-2">
          {hasLines ? (
            <ul className="m-0 list-none space-y-1 p-0">
              {props.catchUp.lines.map((line, index) => (
                <li
                  key={`${index}:${line}`}
                  data-testid="catch-up-line"
                  className="text-[11px] leading-snug text-ink"
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          {hasConflicts ? (
            <ul className="m-0 list-none space-y-1 border-t border-line px-0 pb-0 pt-2">
              {props.conflictSummaries.map((line, index) => (
                <li
                  key={`${index}:${line}`}
                  data-testid="catch-up-conflict"
                  className="text-[11px] leading-snug text-danger"
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="mb-0 mt-1 text-[11px] text-subtle">You're caught up.</p>
      )}
    </section>
  );
}

function HistoryView(props: {
  changeSets: ChangeSetRecord[];
  catchUp: CatchUpState;
  conflictSummaries: string[];
  onMarkCaughtUp: () => void;
}) {
  const showCatchUp =
    props.changeSets.length > 0 ||
    props.catchUp.status !== "ready" ||
    props.conflictSummaries.length > 0;
  return (
    <>
      {showCatchUp ? (
        <CatchUpSummaryCard
          catchUp={props.catchUp}
          conflictSummaries={props.conflictSummaries}
          onMarkCaughtUp={props.onMarkCaughtUp}
        />
      ) : null}
      <HistoryList changeSets={props.changeSets} />
    </>
  );
}

function HistoryRail(props: {
  width: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  children: ReactNode;
}) {
  const railRef = useRef<HTMLElement>(null);
  const dragRight = useRef<number | null>(null);

  return (
    <aside
      ref={railRef}
      data-testid="history-timeline"
      aria-label="History"
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
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          History
        </span>
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

function readSelectedText(): string {
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type === "text")
  ) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return start === end ? "" : active.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? "";
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [catchUp, setCatchUp] = useState<CatchUpState>({
    status: "ready",
    lines: [],
    latestRecordedAtMs: null,
    latestChangeSetId: null,
    latestHistoryIndex: null,
  });
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [agentPanelRefreshKey, setAgentPanelRefreshKey] = useState(0);
  const [appsRefreshKey, setAppsRefreshKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [importExportPath, setImportExportPath] = useState<string | null>(null);
  const [importExportSelectionText, setImportExportSelectionText] = useState("");
  const [workspaceManagementOpen, setWorkspaceManagementOpen] = useState(false);
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

  const workspaceId = props.workspace.workspaceId;
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
          describeConflictForCatchUp(file.path.replace(/\.conflict$/, ""), file.path),
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
        changeSets[0]?.id ?? "none",
        String(changeSets.length),
        String(files.length),
        files.map((file) => file.path).join("\0"),
      ].join("\0"),
    [changeSets, files],
  );
  const activeDocumentPath = isGraphTabPath(wb.activeTab) ? null : wb.activeTab;

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

  const refreshApps = useCallback(() => {
    setAppsRefreshKey((key) => key + 1);
    void refreshFiles();
  }, [refreshFiles]);

  const refreshHistory = useCallback(async () => {
    const [history, status, agent] = await Promise.all([
      bridge().listChangeSets({ workspaceId }),
      bridge().getSyncStatus({ workspaceId }),
      bridge().getAgentRunStatus({ workspaceId }),
    ]);
    setChangeSets(history.changeSets);
    setSyncStatus(status);
    setAgentActive(agent.activeRun !== null);
    setHistoryLoaded(true);
  }, [workspaceId]);

  const catchUpRefreshKey = useMemo(
    () =>
      changeSets
        .map((change) => `${change.id}:${change.recordedAtMs}`)
        .join("\0"),
    [changeSets],
  );
  useEffect(() => {
    let cancelled = false;
    if (!historyLoaded) return;
    if (changeSets.length === 0) {
      setCatchUp({
        status: "ready",
        lines: [],
        latestRecordedAtMs: null,
        latestChangeSetId: null,
        latestHistoryIndex: null,
      });
      return;
    }
    setCatchUp((current) => ({ ...current, status: "loading" }));
    void bridge()
      .readCatchUpSummary({
        workspaceId,
        sinceMs: wb.lastCatchUpSeenAtMs,
        ...(wb.lastCatchUpSeenChangeSetId
          ? { sinceChangeSetId: wb.lastCatchUpSeenChangeSetId }
          : {}),
        ...(wb.lastCatchUpSeenHistoryIndex !== null
          ? { sinceHistoryIndex: wb.lastCatchUpSeenHistoryIndex }
          : {}),
      })
      .then((summary) => {
        if (cancelled) return;
        setCatchUp({
          status: "ready",
          lines: summary.lines,
          latestRecordedAtMs: summary.latestRecordedAtMs,
          latestChangeSetId: summary.latestChangeSetId,
          latestHistoryIndex: summary.latestHistoryIndex,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCatchUp((current) => ({ ...current, status: "error" }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    wb.lastCatchUpSeenAtMs,
    historyLoaded,
    changeSets.length,
    catchUpRefreshKey,
  ]);

  const markCaughtUp = useCallback(() => {
    const seenAt = catchUp.latestRecordedAtMs ?? Date.now();
    setCatchUp({
      status: "ready",
      lines: [],
      latestRecordedAtMs: seenAt,
      latestChangeSetId: catchUp.latestChangeSetId,
      latestHistoryIndex: catchUp.latestHistoryIndex,
    });
    mutateWb((state) =>
      setCatchUpSeenAt(
        state,
        seenAt,
        catchUp.latestChangeSetId,
        catchUp.latestHistoryIndex,
      ),
    );
  }, [
    catchUp.latestRecordedAtMs,
    catchUp.latestChangeSetId,
    catchUp.latestHistoryIndex,
    mutateWb,
  ]);

  // One import seam for the dialog flow AND the OS drag-in flow (the latter
  // passes the preload-resolved absolute paths; see the trust-delta note on
  // ImportWorkspaceFilesPayload).
  const importFiles = useCallback(
    async (droppedPaths?: string[]) => {
      await bridge().importWorkspaceFiles({
        workspaceId,
        ...(droppedPaths ? { droppedPaths } : {}),
      });
      await refreshFiles();
    },
    [workspaceId, refreshFiles],
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
  const activateEditorTab = useCallback(
    (path: string) => {
      if (isGraphTabPath(path)) {
        mutateWb((state) => activateTab(state, path));
        return;
      }
      openFile(path);
    },
    [mutateWb, openFile],
  );

  // Search-result click: open + land at the line (source mode this phase).
  const openSearchResult = useCallback(
    (path: string, line: number) => {
      setSearchScrollTarget({ path, line, nonce: ++scrollNonce.current });
      openFile(path);
    },
    [openFile],
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
        !isGraphTabPath(next.activeTab)
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
    if (next.activeTab !== null && !isGraphTabPath(next.activeTab)) {
      rendererMarks.mark("file-open-start");
    }
    mutateWb((state) => (state.activeTab ? closeTab(state, state.activeTab) : state));
  }, [mutateWb]);

  const closeOtherTabs = useCallback(
    (path: string) => {
      const current = wbRef.current;
      if (!current.tabs.some((tab) => tab.path === path)) return;
      if (current.activeTab !== path && !isGraphTabPath(path)) {
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
  const openHistoryView = useCallback(() => {
    mutateWb((state) => ({
      ...setView(state, "history"),
      sidebarVisible: true,
      historyVisible: true,
    }));
  }, [mutateWb]);
  const openAgentView = useCallback(() => {
    mutateWb((state) => ({ ...setView(state, "agent"), sidebarVisible: true }));
  }, [mutateWb]);
  const openImportExportDialog = useCallback((path?: string | null) => {
    const targetPath = path === undefined ? activeDocumentPath : path;
    const canUseSelection =
      targetPath !== null &&
      activeDocumentPath !== null &&
      targetPath === activeDocumentPath;
    setImportExportPath(targetPath && !isGraphTabPath(targetPath) ? targetPath : null);
    setImportExportSelectionText(canUseSelection ? readSelectedText() : "");
    setImportExportOpen(true);
  }, [activeDocumentPath]);

  const runWorkbenchMenuCommand = useCallback(
    (command: WorkbenchMenuCommand, path?: string) => {
      if (command === "close-tab" && path) {
        closeFileTab(path);
      } else if (command === "close-other-tabs" && path) {
        closeOtherTabs(path);
      } else if (command === "copy-path" && path && !isGraphTabPath(path)) {
        void navigator.clipboard?.writeText(path);
      } else if (command === "show-in-explorer" && path && !isGraphTabPath(path)) {
        showPathInExplorer(path);
      } else if (command === "import-export") {
        openImportExportDialog(
          path && !isGraphTabPath(path) ? path : activeDocumentPath,
        );
      } else if (command === "open-agent") {
        openAgentView();
      } else if (command === "open-history") {
        openHistoryView();
      } else if (command === "connect-cloud") {
        setCloudOpen(true);
      } else if (command === "settings") {
        setSettingsOpen(true);
      } else if (command === "toggle-theme") {
        toggleTheme();
      }
    },
    [
      activeDocumentPath,
      closeFileTab,
      closeOtherTabs,
      openAgentView,
      openHistoryView,
      openImportExportDialog,
      showPathInExplorer,
    ],
  );

  const showWorkbenchMenu = useCallback(
    async (context: "tab" | "editor" | "status", path?: string) => {
      const command = await bridge().showWorkbenchMenu({
        workspaceId,
        context,
        ...(path ? { path } : {}),
      });
      if (command) runWorkbenchMenuCommand(command, path);
    },
    [runWorkbenchMenuCommand, workspaceId],
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
      const status = await bridge().openWorkspace({ workspaceId });
      if (!cancelled) setSyncStatus(status);
      await refreshFiles();
      await refreshHistory();
    })();
    const unsubscribe = bridge().onWorkspaceActivity(() => {
      void refreshFiles();
      void refreshHistory();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId, refreshFiles, refreshHistory]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
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
  }, [closeActiveTab, mutateWb]);

  const openWorkspaceFolder = useCallback(async () => {
    const picked = await bridge().pickWorkspaceRoot();
    if (!picked) return;
    const attached = await bridge().attachWorkspaceFolder({ rootPath: picked });
    props.onSwitchWorkspace(attached);
  }, [props.onSwitchWorkspace]);

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
        id: "import-export",
        label: "Data fragments",
        run: openImportExportDialog,
      },
      {
        id: "import-files",
        label: "Import files",
        run: () => void importFiles(),
      },
      {
        id: "export-workspace",
        label: "Export workspace as zip",
        run: () => void bridge().exportWorkspaceZip({ workspaceId }),
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
        id: "manage-workspace",
        label: "Manage workspace members",
        run: () => setWorkspaceManagementOpen(true),
      },
      {
        id: "settings",
        label: "Settings: Agents & MCP",
        run: () => setSettingsOpen(true),
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
      openImportExportDialog,
      workspaceId,
    ],
  );

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      if (command === "command-palette") setPaletteOpen(true);
      else commands.find((entry) => entry.id === command)?.run();
    });
  }, [commands]);

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
        onSetFolderExpanded={setExplorerFolderExpanded}
        onToggleFolder={toggleExplorerFolder}
        onTogglePin={toggleExplorerPin}
        onBeforeChanges={flushActiveDraft}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={(droppedPaths) => void importFiles(droppedPaths)}
        onImportExport={openImportExportDialog}
        onRefresh={() => void refreshFiles()}
        onNewFileDialog={() => setNewFileOpen(true)}
      />

      <footer className="flex flex-col border-t border-line px-1 py-1">
        <button
          type="button"
          onClick={() => setNewFileOpen(true)}
          className="flex h-7 w-full items-center gap-1.5 rounded px-2 text-xs text-muted hover:bg-line/50 hover:text-ink"
        >
          <FilePlus2 size={13} aria-hidden />
          New file
          <kbd className="ml-auto font-mono text-[10px] text-subtle">
            Ctrl N
          </kbd>
        </button>
        <button
          type="button"
          data-testid="import-export-open"
          onMouseDown={(event) => {
            event.preventDefault();
            openImportExportDialog();
          }}
          onClick={() => openImportExportDialog()}
          className="flex h-7 w-full items-center gap-1.5 rounded px-2 text-xs text-muted hover:bg-line/50 hover:text-ink"
        >
          <Cloud size={13} aria-hidden />
          Data fragments
        </button>
      </footer>
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
        onQuickOpen={() => setQuickOpenOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          activeView={wb.activeView}
          sidebarVisible={wb.sidebarVisible}
          hasConflict={syncStatus?.state === "conflict"}
          agentActive={agentActive}
          searchResultCount={
            search.model.totalMatches > 0 ? search.model.totalMatches : undefined
          }
          onSelectView={(view) => mutateWb((state) => setView(state, view))}
          onOpenCloud={() => setCloudOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
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
                  data-testid="history-rail-toggle"
                  aria-label="Toggle history rail"
                  title="Toggle history rail"
                  onClick={() => mutateWb(toggleHistory)}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <PanelRight size={13} aria-hidden />
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
              ) : wb.activeView === "apps" ? (
                <button
                  type="button"
                  data-testid="apps-refresh"
                  aria-label="Refresh apps"
                  title="Refresh apps"
                  onClick={refreshApps}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                >
                  <RefreshCw size={13} aria-hidden />
                </button>
              ) : wb.activeView === "explorer" ? (
                <>
                  <button
                    type="button"
                    data-testid="explorer-new-file"
                    aria-label="New file"
                    title="New file"
                    onClick={() => requestExplorerCreate("file")}
                    className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                  >
                    <FilePlus2 size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    data-testid="explorer-new-folder"
                    aria-label="New folder"
                    title="New folder"
                    onClick={() => requestExplorerCreate("folder")}
                    className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
                  >
                    <FolderPlus size={13} aria-hidden />
                  </button>
                </>
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
                  refreshKey={graphRefreshKey}
                  onOpenPath={openFile}
                  variant="panel"
                />
              </Suspense>
            ) : wb.activeView === "apps" ? (
              <Suspense fallback={<PanelLoading label="apps" />}>
                <LazyAppsView
                  workspaceId={workspaceId}
                  files={files}
                  refreshKey={appsRefreshKey}
                  onOpenPath={openFile}
                />
              </Suspense>
            ) : wb.activeView === "history" ? (
              <HistoryView
                changeSets={changeSets}
                catchUp={catchUp}
                conflictSummaries={conflictSummaries}
                onMarkCaughtUp={markCaughtUp}
              />
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

        {/* Editor area: tab strip + the active tab's inspector */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <EditorTabs
            tabs={wb.tabs}
            activeTab={wb.activeTab}
            activeTabDirty={activeTabDirty}
            onActivate={activateEditorTab}
            onClose={closeFileTab}
            onContextMenu={(path) => void showWorkbenchMenu("tab", path)}
            onMove={moveFileTab}
          />
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
                  refreshKey={graphRefreshKey}
                  onOpenPath={openFile}
                  variant="page"
                />
              </Suspense>
            ) : wb.activeTab ? (
              <FileInspector
                key={wb.activeTab}
                workspaceId={workspaceId}
                path={wb.activeTab}
                refreshKey={changeSets.length}
                onOpenPath={openFile}
                scrollTarget={searchScrollTarget ?? undefined}
                onScrollConsumed={consumeScrollTarget}
                onSaveStateChange={onSaveStateChange}
                registerDraftFlush={registerDraftFlush}
                knownMarkdownFiles={markdownWikilinkFiles}
                onSharePath={setSharePath}
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
                    data-testid="empty-import-export"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      openImportExportDialog();
                    }}
                    onClick={() => openImportExportDialog()}
                    className="font-mono text-xs text-subtle hover:text-ink"
                  >
                    data fragments
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
          >
            <HistoryView
              changeSets={changeSets}
              catchUp={catchUp}
              conflictSummaries={conflictSummaries}
              onMarkCaughtUp={markCaughtUp}
            />
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
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
        onContextMenu={() => void showWorkbenchMenu("status")}
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
            void refreshFiles();
          }}
        />
      ) : null}
      {cloudOpen ? (
        <Overlay onClose={() => setCloudOpen(false)}>
          <CloudLogin
            workspaceId={workspaceId}
            onManageWorkspace={() => {
              setCloudOpen(false);
              setWorkspaceManagementOpen(true);
            }}
          />
        </Overlay>
      ) : null}
      {settingsOpen ? (
        <Overlay onClose={() => setSettingsOpen(false)}>
          <DesktopSettings
            workspaceId={workspaceId}
            workspacePath={props.workspace.rootPath}
            onClose={() => setSettingsOpen(false)}
            onAgentActiveChange={onSettingsAgentActiveChange}
          />
        </Overlay>
      ) : null}
      {sharePath ? (
        <Overlay onClose={() => setSharePath(null)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading share dialog...
              </div>
            }
          >
            <LazyShareDialog
              workspaceId={workspaceId}
              path={sharePath}
              onClose={() => setSharePath(null)}
            />
          </Suspense>
        </Overlay>
      ) : null}
      {importExportOpen ? (
        <Overlay onClose={() => setImportExportOpen(false)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading import/export panel...
              </div>
            }
          >
            <LazyImportExportDialog
              workspaceId={workspaceId}
              activePath={importExportPath}
              selectedText={importExportSelectionText}
              onImported={() => void refreshFiles()}
              onClose={() => setImportExportOpen(false)}
            />
          </Suspense>
        </Overlay>
      ) : null}
      {workspaceManagementOpen ? (
        <Overlay onClose={() => setWorkspaceManagementOpen(false)}>
          <Suspense
            fallback={
              <div className="rounded-md border border-line bg-panel px-4 py-3 text-xs text-subtle shadow-lg">
                Loading workspace members...
              </div>
            }
          >
            <LazyWorkspaceManagementDialog
              workspaceId={workspaceId}
              onClose={() => setWorkspaceManagementOpen(false)}
            />
          </Suspense>
        </Overlay>
      ) : null}
    </div>
  );
}
