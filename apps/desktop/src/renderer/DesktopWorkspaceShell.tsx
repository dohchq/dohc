import {
  Bot,
  Database,
  FilePlus2,
  FileText,
  Import,
  LayoutGrid,
  PanelRight,
  User,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { FileInspector } from "./FileInspector";
import { NewFileDialog } from "./NewFileDialog";
import { Overlay } from "./Overlay";
import { DesktopSettings } from "./settings/DesktopSettings";
import { Titlebar, workspaceName } from "./Titlebar";
import { toggleTheme } from "./theme";
import { ActivityBar, activityViewLabel } from "./workbench/ActivityBar";
import { EditorTabs } from "./workbench/EditorTabs";
import { SidePanel } from "./workbench/SidePanel";
import { StatusBar } from "./workbench/StatusBar";
import {
  closeTab,
  defaultWorkbenchState,
  moveTab,
  openTab,
  parseUiState,
  serializeUiState,
  setSidebarWidth,
  setView,
  toggleHistory,
  toggleSidebar,
  VIEW_IDS,
  type ViewId,
  type WorkbenchState,
} from "./workbench/workbenchState";

export type Workspace = WorkspaceSummary;

function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
  if (kind === "database") return <Database size={13} aria-hidden />;
  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
  return <FileText size={13} aria-hidden />;
}

// Memoized so selecting a file only re-renders the two rows whose selected
// state changed, not the entire tree (onSelect takes the path, not a closure).
// 28px rows (h-7), VS Code density: hover is a gray tint, active a darker one.
const FileRow = memo(function FileRow(props: {
  file: WorkspaceFileEntry;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onSelect(props.file.path)}
        className={`flex h-7 w-full items-center gap-1.5 px-3 text-left text-[13px] ${
          props.selected
            ? "bg-line text-ink"
            : "text-muted hover:bg-line/50 hover:text-ink"
        }`}
      >
        <FileIcon kind={props.file.kind} />
        <span className="truncate">{props.file.path}</span>
      </button>
    </li>
  );
});

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
// plan (search E5.0, graph/apps E5, agent E6) — the rail itself is the seam.
const EMPTY_VIEW_COPY: Partial<Record<ViewId, { title: string; body: string }>> = {
  search: {
    title: "Search is on its way",
    body: "Fast full-text search across this workspace lands later in this plan.",
  },
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
  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const workspaceId = props.workspace.workspaceId;

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

  const importFiles = useCallback(async () => {
    await bridge().importWorkspaceFiles({ workspaceId });
    await refreshFiles();
  }, [workspaceId, refreshFiles]);

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
      mutateWb((state) => openTab(state, path));
    },
    [mutateWb],
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
    [importFiles, openWorkspaceFolder, closeActiveTab, mutateWb],
  );

  useEffect(() => {
    return bridge().onMenuCommand((command) => {
      if (command === "command-palette") setPaletteOpen(true);
      // Until E3's real folder creation lands, New Folder opens the new-file
      // dialog (a nested path like notes/today.md creates its folders).
      else if (command === "new-folder") setNewFileOpen(true);
      else commands.find((entry) => entry.id === command)?.run();
    });
  }, [commands]);

  const explorerView = (
    <>
      <nav
        data-testid="file-tree"
        aria-label="Files"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {files.length === 0 ? (
          <button
            type="button"
            onClick={() => setNewFileOpen(true)}
            className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
          >
            <FilePlus2 size={13} aria-hidden />
            Create your first file
          </button>
        ) : (
          <ul className="m-0 list-none p-0">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={wb.activeTab === file.path}
                onSelect={openFile}
              />
            ))}
          </ul>
        )}
      </nav>

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
              ) : undefined
            }
          >
            {wb.activeView === "explorer" ? (
              explorerView
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
              onSaveStateChange={onSaveStateChange}
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
          onClose={() => setQuickOpenOpen(false)}
        />
      ) : null}
      {newFileOpen ? (
        <NewFileDialog
          workspaceId={props.workspace.workspaceId}
          onClose={() => setNewFileOpen(false)}
          onCreated={() => {
            setNewFileOpen(false);
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
