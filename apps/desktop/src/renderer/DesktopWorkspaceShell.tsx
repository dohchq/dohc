import {
  Bot,
  Check,
  ChevronsUpDown,
  Cloud,
  Database,
  FilePlus2,
  FileText,
  Import,
  LayoutGrid,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { CommandPalette, type Command } from "./CommandPalette";
import { NewFileDialog } from "./NewFileDialog";
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

export function DesktopWorkspaceShell(props: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);

  const importFiles = useCallback(async () => {
    await bridge().importWorkspaceFiles({
      workspaceId: props.workspace.workspaceId,
    });
    const result = await bridge().listWorkspaceFiles({
      workspaceId: props.workspace.workspaceId,
    });
    setFiles(result.files);
  }, [props.workspace.workspaceId]);

  const refreshFiles = useCallback(async () => {
    const result = await bridge().listWorkspaceFiles({
      workspaceId: props.workspace.workspaceId,
    });
    setFiles(result.files);
  }, [props.workspace.workspaceId]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

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
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(file.path)}
                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
                        selected === file.path
                          ? "bg-panel text-ink"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      <FileIcon kind={file.kind} />
                      <span className="truncate">{file.path}</span>
                    </button>
                  </li>
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
        <main className="flex min-w-0 flex-1 items-center justify-center bg-bg">
          {selected ? (
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono text-[13px] text-ink">{selected}</span>
              <span className="text-xs text-subtle">
                File editing arrives with the editor surface.
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
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

        {/* Agent activity panel */}
        <aside
          data-testid="agent-panel"
          aria-label="Agent activity"
          className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
        >
          <header className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[13px] font-semibold">
            <Bot size={14} aria-hidden />
            Agent activity
          </header>
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
            <span className="text-xs text-muted">No agent runs yet</span>
            <span className="text-[11px] text-subtle">
              Point Codex or Claude Code at this folder — changes show up here
              as a timeline.
            </span>
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3">
        <span
          data-testid="sync-status"
          className="flex items-center gap-1.5 text-[11px] text-muted"
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-success"
          />
          Local · saved
        </span>
        <button
          type="button"
          onClick={() => setCloudOpen(true)}
          className="flex items-center gap-1.5 text-[11px] text-subtle hover:text-ink"
        >
          <Cloud size={12} aria-hidden />
          Connect dohc Cloud
        </button>
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
        <div
          className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
          onClick={() => setCloudOpen(false)}
        >
          <div
            data-testid="cloud-sync-panel"
            className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
              <Cloud size={14} aria-hidden />
              dohc Cloud
            </h2>
            <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
              Cloud sync brings sharing, backup, and team workspaces. It
              arrives with dohc Cloud accounts — this workspace stays fully
              functional locally, and you can connect it then without moving
              anything.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
