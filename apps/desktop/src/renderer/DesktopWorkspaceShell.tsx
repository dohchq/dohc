import {
  Bot,
  FilePlus2,
  FolderPlus,
  Import,
  PanelRight,
  User,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeSetRecord,
  SyncStatusResult,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import { CommandPalette, type Command } from "./CommandPalette";
import { FileInspector, type ScrollTarget } from "./FileInspector";
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
import { SearchView } from "./workbench/SearchView";
import { SidePanel } from "./workbench/SidePanel";
import { StatusBar } from "./workbench/StatusBar";
import { useWorkspaceSearch } from "./workbench/useWorkspaceSearch";
import {
  closeTab,
  defaultWorkbenchState,
  moveTab,
  openTab,
  parseUiState,
  recordRecentFile,
  remapWorkbenchPaths,
  serializeUiState,
  setFolderExpanded,
  setSidebarWidth,
  setView,
  toggleFolderExpanded,
  toggleHistory,
  togglePinned,
  toggleSidebar,
  VIEW_IDS,
  type ViewId,
  type WorkbenchState,
} from "./workbench/workbenchState";

export type Workspace = WorkspaceSummary;

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

// Designed empty states for the views whose real content lands later in this
// plan (graph/apps E5, agent E6) — the rail itself is the seam. Search
// graduated to its real view in E5.0 (SearchView).
const EMPTY_VIEW_COPY: Partial<Record<ViewId, { title: string; body: string }>> = {
  graph: {
    title: "Graph is on its way",
    body: "How your files connect, drawn as a map — later in this plan.",
  },
  apps: {
    title: "Apps panel is on its way",
    body: "Your workspace apps get a dedicated home later in this plan.",
  },
  agent: {
    title: "Agent panel is on its way",
    body: "Start and review agent sessions from here later in this plan.",
  },
};

function EmptyView({ view }: { view: ViewId }) {
  const copy = EMPTY_VIEW_COPY[view];
  if (!copy) return null;
  return (
    <div
      data-testid="view-empty-state"
      className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
    >
      <span className="text-xs text-muted">{copy.title}</span>
      <span className="text-[11px] text-subtle">{copy.body}</span>
    </div>
  );
}

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // Content search (Phase E5.0). The model lives HERE, not in the Search
  // view, so results — and the activity-bar count badge — survive switching
  // views while the panel unmounts.
  const search = useWorkspaceSearch(workspaceId);

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

  const refreshHistory = useCallback(async () => {
    const [history, status, agent] = await Promise.all([
      bridge().listChangeSets({ workspaceId }),
      bridge().getSyncStatus({ workspaceId }),
      bridge().getAgentRunStatus({ workspaceId }),
    ]);
    setChangeSets(history.changeSets);
    setSyncStatus(status);
    setAgentActive(agent.activeRun !== null);
  }, [workspaceId]);

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
      if (openTab(wbRef.current, path) !== wbRef.current) {
        rendererMarks.mark("file-open-start");
      }
      // Every open also records recency (quick-open ranking, Phase E5.0).
      mutateWb((state) => recordRecentFile(openTab(state, path), path));
    },
    [mutateWb],
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
      if (next.activeTab !== current.activeTab && next.activeTab !== null) {
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
    if (next.activeTab !== null) rendererMarks.mark("file-open-start");
    mutateWb((state) => (state.activeTab ? closeTab(state, state.activeTab) : state));
  }, [mutateWb]);

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

  // Performance marks (post-commit, so the rendered surface is included):
  // file tree populated, and shell interactive once status/history landed.
  // These live in the workbench ROOT — a view may unmount, this must not.
  useEffect(() => {
    if (files.length > 0) rendererMarks.markOnce("file-tree-loaded");
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
        id: "import-files",
        label: "Import files into workspace",
        run: () => void importFiles(),
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
    [importFiles, openWorkspaceFolder, closeActiveTab, mutateWb, requestExplorerCreate],
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
        expandedFolders={wb.expandedFolders}
        pinned={wb.pinned}
        createRequest={createRequest}
        onOpenFile={openFile}
        onSetFolderExpanded={setExplorerFolderExpanded}
        onToggleFolder={toggleExplorerFolder}
        onTogglePin={toggleExplorerPin}
        onBeforeChanges={flushActiveDraft}
        onPathsChanged={onExplorerPathsChanged}
        onImportFiles={(droppedPaths) => void importFiles(droppedPaths)}
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
          onClick={() => void importFiles()}
          className="flex h-7 w-full items-center gap-1.5 rounded px-2 text-xs text-muted hover:bg-line/50 hover:text-ink"
        >
          <Import size={13} aria-hidden />
          Import files
        </button>
      </footer>
    </>
  );

  return (
    <div
      data-testid="workspace-shell"
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
              <SearchView search={search} onOpenResult={openSearchResult} />
            ) : wb.activeView === "history" ? (
              <HistoryList changeSets={changeSets} />
            ) : (
              <EmptyView view={wb.activeView} />
            )}
          </SidePanel>
        ) : null}

        {/* Editor area: tab strip + the active tab's inspector */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <EditorTabs
            tabs={wb.tabs}
            activeTab={wb.activeTab}
            activeTabDirty={activeTabDirty}
            onActivate={openFile}
            onClose={closeFileTab}
            onMove={moveFileTab}
          />
          {wb.activeTab ? (
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
        </main>

        {/* History timeline — the "git log for everyday people". Every
            settled change (yours or your agent's) lands here, newest first.
            Default-visible right rail (specs assert it with zero clicks);
            toggleable via the toggle-history command. */}
        {wb.historyVisible ? (
          <aside
            data-testid="history-timeline"
            aria-label="History"
            className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
          >
            {/* Same header grammar + h-9 band as the side panel: the two
                peer chrome surfaces speak one language and their hairlines
                meet the tab strip's on the same pixel row. */}
            <header className="flex h-9 shrink-0 items-center border-b border-line px-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                History
              </span>
            </header>
            <HistoryList changeSets={changeSets} />
          </aside>
        ) : null}
      </div>

      <StatusBar
        workspaceName={workspaceName(props.workspace)}
        syncStatus={syncStatus}
        agentActive={agentActive}
        onConnectCloud={() => setCloudOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={toggleTheme}
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
          <CloudLogin workspaceId={workspaceId} />
        </Overlay>
      ) : null}
      {settingsOpen ? (
        <Overlay onClose={() => setSettingsOpen(false)}>
          <DesktopSettings
            workspaceId={workspaceId}
            workspacePath={props.workspace.rootPath}
            onClose={() => setSettingsOpen(false)}
          />
        </Overlay>
      ) : null}
    </div>
  );
}
