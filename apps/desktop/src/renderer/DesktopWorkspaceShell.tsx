import {
  Bot,
  Check,
  ChevronsUpDown,
  Cloud,
  Database,
  FilePlus2,
  FileText,
  History,
  Import,
  LayoutGrid,
  Settings,
  User,
} from "lucide-react";

const SYNC_LABEL: Record<SyncStatusResult["state"], string> = {
  synced: "Local · saved",
  syncing: "Saving…",
  "local-changes": "Local changes",
  conflict: "Conflict",
  "cloud-disconnected": "Cloud disconnected",
};

const SYNC_DOT: Record<SyncStatusResult["state"], string> = {
  synced: "bg-success",
  syncing: "bg-warning",
  "local-changes": "bg-warning",
  conflict: "bg-danger",
  "cloud-disconnected": "bg-subtle",
};
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChangeSetRecord,
  SyncStatusResult,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import { CommandPalette, type Command } from "./CommandPalette";
import { FileInspector } from "./FileInspector";
import { NewFileDialog } from "./NewFileDialog";
import { Overlay } from "./Overlay";
import { DesktopSettings } from "./settings/DesktopSettings";
import { toggleTheme } from "./theme";

export type Workspace = WorkspaceSummary;

function workspaceName(workspace: Workspace): string {
  return workspace.rootPath.split("/").pop() ?? "workspace";
}

function FileIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
  if (kind === "database") return <Database size={13} aria-hidden />;
  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden />;
  return <FileText size={13} aria-hidden />;
}

// Memoized so selecting a file only re-renders the two rows whose selected
// state changed, not the entire tree (onSelect takes the path, not a closure).
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
        className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
          props.selected ? "bg-panel text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <FileIcon kind={props.file.kind} />
        <span className="truncate">{props.file.path}</span>
      </button>
    </li>
  );
});

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workspaceId = props.workspace.workspaceId;

  const refreshFiles = useCallback(async () => {
    const result = await bridge().listWorkspaceFiles({ workspaceId });
    setFiles(result.files);
  }, [workspaceId]);

  const refreshHistory = useCallback(async () => {
    const [history, status] = await Promise.all([
      bridge().listChangeSets({ workspaceId }),
      bridge().getSyncStatus({ workspaceId }),
    ]);
    setChangeSets(history.changeSets);
    setSyncStatus(status);
  }, [workspaceId]);

  const importFiles = useCallback(async () => {
    await bridge().importWorkspaceFiles({ workspaceId });
    await refreshFiles();
  }, [workspaceId, refreshFiles]);

  const selectFile = useCallback((path: string) => setSelected(path), []);

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
      if (event.key === "n") {
        event.preventDefault();
        setNewFileOpen(true);
      } else if (event.key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "p") {
        event.preventDefault();
        setQuickOpenOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        id: "import-files",
        label: "Import files into workspace",
        run: () => void importFiles(),
      },
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
    [importFiles],
  );

  return (
    <div
      data-testid="workspace-shell"
      className="app-chrome flex h-screen flex-col bg-bg text-ink"
    >
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2">
          <header className="relative border-b border-line">
            <button
              type="button"
              data-testid="workspace-switcher"
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              onClick={() => setSwitcherOpen((open) => !open)}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-panel"
            >
              <span className="truncate text-[13px] font-semibold">
                {workspaceName(props.workspace)}
              </span>
              <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
            </button>
            {switcherOpen ? (
              <ul
                role="listbox"
                aria-label="Workspaces"
                className="absolute left-2 right-2 top-full z-20 mt-1 m-0 list-none rounded border border-line bg-panel p-1 shadow-md"
              >
                {props.workspaces.map((candidate) => (
                  <li key={candidate.workspaceId} role="option" aria-selected={candidate.workspaceId === props.workspace.workspaceId}>
                    <button
                      type="button"
                      onClick={() => {
                        setSwitcherOpen(false);
                        props.onSwitchWorkspace(candidate);
                      }}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-muted hover:text-ink"
                    >
                      {candidate.workspaceId === props.workspace.workspaceId ? (
                        <Check size={12} aria-hidden />
                      ) : (
                        <span className="w-3" aria-hidden />
                      )}
                      <span className="truncate">{workspaceName(candidate)}</span>
                      <span className="ml-auto text-[10px] uppercase text-subtle">
                        {candidate.kind}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </header>

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
                    selected={selected === file.path}
                    onSelect={selectFile}
                  />
                ))}
              </ul>
            )}
          </nav>

          <footer className="flex flex-col gap-1 border-t border-line px-3 py-1.5">
            <button
              type="button"
              onClick={() => setNewFileOpen(true)}
              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
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
              className="flex w-full items-center gap-1.5 text-xs text-muted hover:text-ink"
            >
              <Import size={13} aria-hidden />
              Import files
            </button>
          </footer>
        </aside>

        {/* Main area */}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {selected ? (
            <FileInspector
              workspaceId={workspaceId}
              path={selected}
              refreshKey={changeSets.length}
              onOpenPath={selectFile}
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
            settled change (yours or your agent's) lands here, newest first. */}
        <aside
          data-testid="history-timeline"
          aria-label="History"
          className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
        >
          <header className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[13px] font-semibold">
            <History size={14} aria-hidden />
            History
          </header>
          {changeSets.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
              <span className="text-xs text-muted">No changes yet</span>
              <span className="text-[11px] text-subtle">
                Edits — yours or your agent's — show up here as a timeline you
                can review.
              </span>
            </div>
          ) : (
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
          )}
        </aside>
      </div>

      {/* Status bar */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3">
        <span
          data-testid="sync-status"
          data-state={syncStatus?.state ?? "synced"}
          className="flex items-center gap-1.5 text-[11px] text-muted"
        >
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 rounded-full ${SYNC_DOT[syncStatus?.state ?? "synced"]}`}
          />
          {SYNC_LABEL[syncStatus?.state ?? "synced"]}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCloudOpen(true)}
            className="flex items-center gap-1.5 text-[11px] text-subtle hover:text-ink"
          >
            <Cloud size={12} aria-hidden />
            Connect dohc Cloud
          </button>
          <button
            type="button"
            data-testid="open-settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 text-[11px] text-subtle hover:text-ink"
          >
            <Settings size={12} aria-hidden />
            Settings
          </button>
        </div>
      </footer>

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
            run: () => setSelected(file.path),
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
