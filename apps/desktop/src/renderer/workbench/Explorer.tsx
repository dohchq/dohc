import {
  ChevronsUp,
  ChevronRight,
  Database,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  Globe2,
  LayoutGrid,
  Pin,
  RefreshCw,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { DraftFlush } from "../FileInspector";
import { Overlay } from "../Overlay";
import { planDrop, type DragSource } from "./file-tree-dnd";
import { navigateTree, type FlatRow } from "./file-tree-nav";
import { withMarkdownDefault } from "./new-file-name";
import {
  applyPendingTreeMoves,
  parentDir,
  pendingTreeMoveSettled,
  type PendingTreeChange,
} from "./file-tree-optimistic";
import { buildTree, type TreeNode } from "./path-tree";
import {
  clampOpenEditorsHeight,
  isGraphTabPath,
  isHistoryDiffTabPath,
  isHistoryTabPath,
  isSiteTabPath,
  isVersionCompareTabPath,
  isVirtualTabPath,
  parseHistoryDiffTabPath,
  parseSiteTabPath,
} from "./workbenchState";

// The explorer: a real nested tree over the flat (files, folders) lists with
// inline create/rename editboxes, optimistic pending ops (rollback on error),
// multi-select, drag-move, pins, keyboard nav (ported file-tree-nav), and the
// native context menu via the closed showExplorerMenu invoke. The explorer is
// NEVER a privileged writer: every mutation is an IPC the watcher observes,
// so each op lands in history as an ordinary change set.

export interface ExplorerProps {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  folders: string[];
  activeTab: string | null;
  openTabs: Array<{ path: string }>;
  dirtyTab: string | null;
  // Paths with a set-aside draft (#567): marks Open Editors rows for every
  // tab, not only the active one (#579 review, r4).
  recoveryPaths: ReadonlySet<string>;
  expandedFolders: string[];
  pinned: string[];
  // Max height of the Open Editors list (workbench state, persisted): the
  // list caps here and scrolls internally; the section's bottom-edge drag
  // handle streams clamped heights up (SidePanel width precedent).
  openEditorsHeight: number;
  onOpenEditorsHeightChange: (height: number) => void;
  // Incrementing request to begin an inline create at the root (palette /
  // application-menu "New Folder" route).
  createRequest: { kind: "file" | "folder"; id: number } | null;
  onOpenFile: (path: string) => void;
  onActivateTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseAllTabs: () => void;
  onNewUntitledTextFile: () => void;
  onCollapseFolders: () => void;
  onSetFolderExpanded: (path: string, expanded: boolean) => void;
  onToggleFolder: (path: string) => void;
  onTogglePin: (path: string) => void;
  // The shell flushes the stable active editor before disk changes and returns
  // a settlement that retains every editor mounted while those changes run.
  // A rejected initial flush aborts the batch.
  onBeginChanges?: () => Promise<DraftFlush>;
  // Successful moves/deletes re-project tabs/pins/expansion in the shell.
  onPathsChanged: (changes: PendingTreeChange[]) => void;
  // Import into targetDir ("" = root): the folder that was dropped on, or the
  // folder whose context menu ran "Import Files…". Main re-validates it.
  onImportFiles: (droppedPaths?: string[], targetDir?: string) => void;
  // Share mounts: refresh every mount in this workspace / remove the mount
  // that owns the given path (shared-with-me/<label>/…).
  onRefreshShareMounts: () => void;
  onUnmountShare: (path: string) => void;
  // "Share…" (PR 18): offered by the main-owned context menu on synced,
  // non-shared-view workspaces; opens the shell's share dialog for the path.
  onShare: (path: string) => void;
  onRefresh: () => void;
  onNewFileDialog: () => void;
}

type EditingState =
  | { mode: "create"; kind: "file" | "folder"; parentPath: string }
  | { mode: "rename"; path: string; isFolder: boolean };

type VisibleRow = FlatRow & {
  kind: WorkspaceFileEntry["kind"] | null;
  // The page's `icon` frontmatter emoji, shown in place of the file glyph.
  icon?: string;
};

// A page emoji stands in for the generic file glyph when the file's
// frontmatter carries one (Notion-style). Sized to sit on the same baseline
// as the 13px lucide glyphs it replaces.
function PageIconGlyph({ icon }: { icon: string }) {
  return (
    <span
      aria-hidden
      className="grid size-[13px] shrink-0 place-items-center text-[12px] leading-none"
    >
      {icon}
    </span>
  );
}

type DropPreview = {
  targetPath: string | null;
  targetDir: string;
  kind: "move" | "copy" | "blocked";
  targetIsFolder: boolean;
};

type RowDropPreview = {
  kind: DropPreview["kind"];
  role: "target" | "contained";
};

function leafOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

function externalDragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

// Typed-path semantics from the old FileTree: a plain name lands in the
// edit's folder; a typed path containing "/" wins and is root-relative.
function resolveTypedPath(value: string, contextDir: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.includes("/")) return trimmed;
  return contextDir ? `${contextDir}/${trimmed}` : trimmed;
}

function FileKindIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
  if (kind === "database") return <Database size={13} aria-hidden className="shrink-0" />;
  return <FileText size={13} aria-hidden className="shrink-0" />;
}

export function editorTitle(path: string): string {
  if (isGraphTabPath(path)) return "Graph";
  if (isHistoryTabPath(path)) return "History";
  if (isHistoryDiffTabPath(path)) {
    const parsed = parseHistoryDiffTabPath(path);
    return `Diff: ${leafOf(parsed?.filePath ?? "file")}`;
  }
  if (isSiteTabPath(path)) return `Site: ${parseSiteTabPath(path) ?? "preview"}`;
  if (isVersionCompareTabPath(path)) return "Compare with Main";
  return leafOf(path);
}

function OpenEditorIcon(props: { path: string; kind: WorkspaceFileEntry["kind"] | null }) {
  if (isVirtualTabPath(props.path)) {
    if (isSiteTabPath(props.path)) {
      return <Globe2 size={13} aria-hidden className="shrink-0" />;
    }
    return <LayoutGrid size={13} aria-hidden className="shrink-0" />;
  }
  return <FileKindIcon kind={props.kind ?? "file"} />;
}

function SectionActionButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid size-6 shrink-0 place-items-center rounded text-subtle group-hover:text-muted hover:bg-line/50 hover:text-ink disabled:pointer-events-none disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}

// Depth indent with guide lines (one per ancestor level).
function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="ml-[7px] h-7 w-[9px] shrink-0 border-l border-line/60"
        />
      ))}
    </>
  );
}

// The rendered Open Editors cap is additionally bounded to a fraction of the
// viewport: a height saved in a tall window must never push the Files section
// and the resize handle below the fold of a shorter one (the list is its own
// overscroll-contained scroller — wheel scrolling would trap inside it).
const OPEN_EDITORS_VIEWPORT_FRACTION = 0.6;
function viewportOpenEditorsCap(): number {
  return Math.round(window.innerHeight * OPEN_EDITORS_VIEWPORT_FRACTION);
}

// Memoized row: primitives + stable callbacks only, so a selection change
// re-renders the rows whose state changed, not the whole tree.
const TreeRow = memo(function TreeRow(props: {
  row: VisibleRow;
  selected: boolean;
  active: boolean;
  focused: boolean;
  dropPreview: RowDropPreview | null;
  registerRef: (path: string, el: HTMLButtonElement | null) => void;
  onRowClick: (path: string, event: MouseEvent) => void;
  onRowContextMenu: (path: string, event: MouseEvent) => void;
  onRowDragStart: (path: string, event: DragEvent) => void;
  onRowDragOver: (path: string, event: DragEvent) => void;
  onRowDrop: (path: string, event: DragEvent) => void;
  onRowDragLeave: () => void;
  onRowDragEnd: () => void;
}) {
  const { row } = props;
  const dropClass =
    props.dropPreview?.kind === "blocked"
      ? props.dropPreview.role === "target"
        ? "bg-danger/10 text-danger ring-1 ring-inset ring-danger/30"
        : "bg-danger/5 text-danger"
      : props.dropPreview
        ? props.dropPreview.role === "target"
          ? "bg-line/80 text-ink ring-1 ring-inset ring-ink/25"
          : "bg-line/35 text-ink"
        : "";
  return (
    <li role="none" className="px-1">
      <button
        type="button"
        role="treeitem"
        data-testid="tree-row"
        data-path={row.fullPath}
        data-kind={row.isFolder ? "folder" : "file"}
        data-drop-state={props.dropPreview?.kind}
        aria-level={row.depth + 1}
        aria-selected={props.selected}
        {...(row.isFolder ? { "aria-expanded": row.isExpanded } : {})}
        tabIndex={props.focused ? 0 : -1}
        ref={(el) => props.registerRef(row.fullPath, el)}
        draggable
        onClick={(event) => props.onRowClick(row.fullPath, event)}
        onContextMenu={(event) => props.onRowContextMenu(row.fullPath, event)}
        onDragStart={(event) => props.onRowDragStart(row.fullPath, event)}
        onDragOver={(event) => props.onRowDragOver(row.fullPath, event)}
        onDrop={(event) => props.onRowDrop(row.fullPath, event)}
        onDragLeave={props.onRowDragLeave}
        onDragEnd={props.onRowDragEnd}
        // Three distinguishable read-outs (VS Code list semantics): the
        // ACTIVE-tab row keeps the strongest fill, selected-not-active rows a
        // lighter fill (Delete/drag act on the SELECTION — the visuals must
        // not collapse the two meanings), and the keyboard-FOCUSED row an
        // inset ring. The drag drop-target is a filled tint (list.drop-
        // Background style) — box-shadow/background only, NEVER `outline`:
        // the base outline-none nulls --tw-outline-style later in the same
        // cascade layer, which made an outline-based highlight unrenderable.
        className={`relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] outline-none transition-colors duration-75 ${
          props.dropPreview
            ? dropClass
            : props.active
              ? "bg-line text-ink"
              : props.selected
                ? "bg-line/60 text-ink"
                : "text-muted hover:bg-line/50 hover:text-ink"
        } ${props.focused ? "ring-1 ring-inset ring-ink/30" : ""}`}
      >
        {props.dropPreview ? (
          <span
            aria-hidden
            className={`absolute bottom-1 left-0 top-1 w-0.5 rounded-full ${
              props.dropPreview.role === "target"
                ? props.dropPreview.kind === "blocked"
                  ? "bg-danger"
                  : "bg-ink"
                : "bg-transparent"
            }`}
          />
        ) : null}
        <span aria-hidden className="w-1 shrink-0" />
        <IndentGuides depth={row.depth} />
        {row.isFolder ? (
          <>
            <ChevronRight
              size={12}
              aria-hidden
              className={`shrink-0 text-subtle transition-transform ${row.isExpanded ? "rotate-90" : ""}`}
            />
            {row.isExpanded ? (
              <FolderOpen size={13} aria-hidden className="shrink-0" />
            ) : (
              <Folder size={13} aria-hidden className="shrink-0" />
            )}
          </>
        ) : (
          <>
            <span aria-hidden className="w-3 shrink-0" />
            {row.icon ? (
              <PageIconGlyph icon={row.icon} />
            ) : (
              <FileKindIcon kind={row.kind ?? "file"} />
            )}
          </>
        )}
        <span className="min-w-0 flex-1 truncate">{leafOf(row.fullPath)}</span>
      </button>
    </li>
  );
});

let editIdCounter = 0;
function nextChangeId(): string {
  editIdCounter += 1;
  return `pending-${editIdCounter}`;
}

export function Explorer(props: ExplorerProps) {
  const {
    workspaceId,
    onRefresh,
    onBeginChanges,
    onPathsChanged,
    onSetFolderExpanded,
    onToggleFolder,
    onOpenFile,
    onTogglePin,
  } = props;
  const [pending, setPending] = useState<PendingTreeChange[]>([]);
  const [openEditorsExpanded, setOpenEditorsExpanded] = useState(true);
  const [viewportCap, setViewportCap] = useState(viewportOpenEditorsCap);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const openEditorsListRef = useRef<HTMLUListElement>(null);
  // Pointer position + cap at drag start — heights derive from the DELTA, not
  // from the list's edges: the list is max-height (shorter lists shrink to
  // fit), so the handle can sit ABOVE the cap and an edge-based height would
  // collapse the saved cap to the content height on the first move.
  const openEditorsDrag = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const editInputRef = useRef<HTMLInputElement>(null);
  // One commit per edit session: Enter/Escape unmount the input, whose blur
  // fires with a STALE closure — without this latch the edit would commit
  // twice (and the second rename would fail on the now-missing source).
  const editDone = useRef(false);
  // Internal drag state: HTML5 DnD dataTransfer is unreadable during
  // dragover, so the dragged selection rides in a ref for the whole gesture.
  const dragSources = useRef<DragSource[] | null>(null);
  const hoverExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onResize = () => setViewportCap(viewportOpenEditorsCap());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Prune pending changes the authoritative refresh has confirmed.
  useEffect(() => {
    setPending((current) =>
      current.filter(
        (change) => !pendingTreeMoveSettled(change, props.files, props.folders),
      ),
    );
  }, [props.files, props.folders]);

  // The open-editors list caps its height and scrolls internally, so the
  // active row must be brought back into view whenever it changes — or moves:
  // openTabs (reducer state, referentially stable between changes) is a
  // dependency because reordering or closing tabs shifts the active row
  // without changing activeTab (and shrinking the section can push it out).
  // Scroll the list directly (not scrollIntoView): the list and the file tree
  // share the sidebar's outer scroll container, and scrollIntoView would also
  // scroll that ancestor — yanking the user's tree scroll position on tab
  // switches.
  useEffect(() => {
    if (!props.activeTab || !openEditorsExpanded) return;
    const list = openEditorsListRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop += rowRect.top - listRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }, [
    props.activeTab,
    props.openTabs,
    openEditorsExpanded,
    props.openEditorsHeight,
    viewportCap,
  ]);

  // A drag abandoned mid-hover must not expand a folder after unmount.
  useEffect(
    () => () => {
      if (hoverExpandTimer.current) clearTimeout(hoverExpandTimer.current);
    },
    [],
  );

  const projected = useMemo(
    () => applyPendingTreeMoves(props.files, props.folders, pending),
    [props.files, props.folders, pending],
  );

  const fileByPath = useMemo(() => {
    const map = new Map<string, WorkspaceFileEntry>();
    for (const file of projected.files) map.set(file.path, file);
    return map;
  }, [projected.files]);

  // Same icon rule as TreeRow (a page icon when set, otherwise the kind glyph),
  // driven by the memoized lookup so pinned rows don't rescan projected.files.
  function fileGlyph(path: string) {
    const file = fileByPath.get(path);
    return file?.icon ? (
      <PageIconGlyph icon={file.icon} />
    ) : (
      <FileKindIcon kind={file?.kind ?? "file"} />
    );
  }

  const expandedSet = useMemo(
    () => new Set(props.expandedFolders),
    [props.expandedFolders],
  );

  const tree = useMemo(
    () => buildTree(projected.files, projected.folders),
    [projected],
  );

  const rows = useMemo(() => {
    const out: VisibleRow[] = [];
    const walk = (node: TreeNode, depth: number, parentPath: string | null) => {
      for (const child of node.children) {
        const isFolder = child.file === null;
        const isExpanded = isFolder && expandedSet.has(child.fullPath);
        out.push({
          fullPath: child.fullPath,
          isFolder,
          isExpanded,
          depth,
          parentPath,
          kind: child.file?.kind ?? null,
          ...(child.file?.icon ? { icon: child.file.icon } : {}),
        });
        if (isFolder && isExpanded) walk(child, depth + 1, child.fullPath);
      }
    };
    walk(tree, 0, null);
    return out;
  }, [tree, expandedSet]);

  const folderPathSet = useMemo(() => new Set(projected.folders), [projected]);

  const isFolderPath = useCallback(
    (path: string) => folderPathSet.has(path),
    [folderPathSet],
  );

  const registerRef = useCallback((path: string, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(path, el);
    else rowRefs.current.delete(path);
  }, []);

  const focusRow = useCallback((path: string) => {
    setFocusedPath(path);
    rowRefs.current.get(path)?.focus();
  }, []);

  const beginCreate = useCallback(
    (kind: "file" | "folder", parentPath: string) => {
      // beginPending auto-expands the target dir (old FileTree behavior) so
      // the editbox is actually visible.
      setFilesExpanded(true);
      if (parentPath) {
        for (const ancestor of [...ancestorsOf(parentPath), parentPath]) {
          onSetFolderExpanded(ancestor, true);
        }
      }
      setEditValue("");
      editDone.current = false;
      setEditing({ mode: "create", kind, parentPath });
    },
    [onSetFolderExpanded],
  );

  const creationParentPath = useCallback(() => {
    const selectedPath = selection.size === 1 ? [...selection][0] : null;
    const target =
      focusedPath ??
      selectedPath ??
    (props.activeTab && !isVirtualTabPath(props.activeTab) ? props.activeTab : null);
    if (!target) return "";
    return isFolderPath(target) ? target : parentDir(target);
  }, [focusedPath, isFolderPath, props.activeTab, selection]);

  const beginCreateAtFocus = useCallback(
    (kind: "file" | "folder") => {
      beginCreate(kind, creationParentPath());
    },
    [beginCreate, creationParentPath],
  );

  const beginRename = useCallback((path: string, isFolder: boolean) => {
    setEditValue(leafOf(path));
    editDone.current = false;
    setEditing({ mode: "rename", path, isFolder });
  }, []);

  useEffect(() => {
    if (props.createRequest) beginCreate(props.createRequest.kind, "");
    // Re-arm on each request id; the id is the dependency on purpose.
  }, [props.createRequest, beginCreate]);

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
      if (editing.mode === "rename" && !editing.isFolder) {
        // Select the basename, not the extension (rename ergonomics).
        const dot = editValue.lastIndexOf(".");
        editInputRef.current?.setSelectionRange(0, dot > 0 ? dot : editValue.length);
      } else {
        editInputRef.current?.select();
      }
    }
    // Only when the editing TARGET changes — not per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Optimistic op runner: stage pending changes, run the IPCs, roll back the
  // failures (with a visible error), re-project shell paths for successes,
  // and refresh — the watcher refresh then confirms and prunes.
  const runChanges = useCallback(
    async (
      changes: PendingTreeChange[],
      run: (change: PendingTreeChange) => Promise<unknown>,
    ) => {
      if (changes.length === 0) return;
      setOpError(null);
      // Land the stable active draft before paths move underneath it. The
      // operation cannot preserve text that this initial flush rejected.
      let settleDrafts: DraftFlush | null = null;
      try {
        settleDrafts = (await onBeginChanges?.()) ?? null;
      } catch (cause) {
        setOpError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      setPending((current) => [...current, ...changes]);
      const succeeded: PendingTreeChange[] = [];
      for (const change of changes) {
        try {
          await run(change);
          succeeded.push(change);
        } catch (cause) {
          setPending((current) => current.filter((entry) => entry.id !== change.id));
          setOpError(cause instanceof Error ? cause.message : String(cause));
        }
      }
      const changedExistingPath = succeeded.some(
        (change) => change.kind !== "create-file" && change.kind !== "create-folder",
      );
      try {
        await settleDrafts?.(
          changedExistingPath ? { captureOnFailure: true } : undefined,
        );
      } catch (cause) {
        // The disk change already completed. Surface the settlement error,
        // then project the successful paths so the shell matches storage.
        setOpError(cause instanceof Error ? cause.message : String(cause));
      }
      if (succeeded.length > 0) onPathsChanged(succeeded);
      onRefresh();
    },
    [onBeginChanges, onPathsChanged, onRefresh],
  );

  const performMoves = useCallback(
    (sources: DragSource[], targetDir: string) => {
      const changes: PendingTreeChange[] = [];
      for (const source of sources) {
        const action = planDrop(source, { parentDir: targetDir });
        if (action.kind === "noop") continue;
        changes.push({
          id: nextChangeId(),
          kind: source.kind,
          fromPath: action.fromPath,
          toPath: action.toPath,
        });
      }
      if (changes.length > 0) setSelection(new Set());
      void runChanges(changes, (change) =>
        change.kind === "file" || change.kind === "folder"
          ? bridge().moveWorkspacePath({
              workspaceId,
              fromPath: change.fromPath,
              toPath: change.toPath,
            })
          : Promise.resolve(),
      );
    },
    [runChanges, workspaceId],
  );

  const commitRename = useCallback(
    (path: string, isFolder: boolean, value: string) => {
      const toPath = resolveTypedPath(value, parentDir(path));
      setEditing(null);
      if (!toPath || toPath === path) return;
      void runChanges(
        [
          {
            id: nextChangeId(),
            kind: isFolder ? "folder" : "file",
            fromPath: path,
            toPath,
          },
        ],
        () => bridge().moveWorkspacePath({ workspaceId, fromPath: path, toPath }),
      );
    },
    [runChanges, workspaceId],
  );

  const commitCreate = useCallback(
    (kind: "file" | "folder", parentPath: string, value: string) => {
      const typed = resolveTypedPath(value, parentPath);
      // New files are markdown unless an extension is typed. Renames
      // (commitRename) stay literal so extensions can be changed on purpose.
      const path = kind === "file" && typed ? withMarkdownDefault(typed) : typed;
      setEditing(null);
      if (!path) return;
      const change: PendingTreeChange = {
        id: nextChangeId(),
        kind: kind === "file" ? "create-file" : "create-folder",
        path,
      };
      for (const ancestor of ancestorsOf(path)) onSetFolderExpanded(ancestor, true);
      if (kind === "folder") onSetFolderExpanded(path, true);
      void runChanges([change], async () => {
        if (kind === "file") {
          const result = await bridge().createWorkspaceFile({
            workspaceId,
            relativePath: path,
          });
          onOpenFile(result.path);
        } else {
          await bridge().createWorkspaceFolder({ workspaceId, relativePath: path });
        }
      });
    },
    [runChanges, workspaceId, onOpenFile, onSetFolderExpanded],
  );

  const performDeletes = useCallback(
    (paths: string[]) => {
      // A selected child inside a selected folder is covered by the folder.
      const tops = paths.filter(
        (path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)),
      );
      const changes: PendingTreeChange[] = tops.map((path) => ({
        id: nextChangeId(),
        kind: isFolderPath(path) ? "delete-folder" : "delete-file",
        path,
      }));
      setSelection(new Set());
      void runChanges(changes, (change) =>
        "path" in change
          ? bridge().deleteWorkspacePath({ workspaceId, relativePath: change.path })
          : Promise.resolve(),
      );
    },
    [runChanges, workspaceId, isFolderPath],
  );

  const exportZip = useCallback(
    (relativePath?: string) => {
      void bridge()
        .exportWorkspaceZip({ workspaceId, relativePath })
        .catch((cause) =>
          setOpError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [workspaceId],
  );

  // ---- selection + clicks ----

  const selectSingle = useCallback((path: string) => {
    setSelection(new Set([path]));
    setAnchorPath(path);
    setFocusedPath(path);
  }, []);

  const onRowClick = useCallback(
    (path: string, event: MouseEvent) => {
      const isFolder = rows.find((row) => row.fullPath === path)?.isFolder ?? false;
      if (event.ctrlKey || event.metaKey) {
        setSelection((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        setAnchorPath(path);
        setFocusedPath(path);
        return;
      }
      if (event.shiftKey && anchorPath) {
        const order = rows.map((row) => row.fullPath);
        const from = order.indexOf(anchorPath);
        const to = order.indexOf(path);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelection(new Set(order.slice(lo, hi + 1)));
          setFocusedPath(path);
          return;
        }
      }
      selectSingle(path);
      if (isFolder) onToggleFolder(path);
      else onOpenFile(path);
    },
    [rows, anchorPath, selectSingle, onToggleFolder, onOpenFile],
  );

  // ---- context menu (native, main-owned over the closed tuple) ----

  const dispatchMenu = useCallback(
    async (
      kind: "file" | "folder" | "root",
      path: string | undefined,
      pinnedRow: boolean,
    ) => {
      const command = await bridge().showExplorerMenu({
        workspaceId,
        ...(path !== undefined ? { path } : {}),
        kind,
        pinned: pinnedRow,
      });
      if (command === null) return;
      const targetDir =
        kind === "root" ? "" : kind === "folder" ? (path ?? "") : parentDir(path ?? "");
      switch (command) {
        case "new-file":
          beginCreate("file", targetDir);
          break;
        case "new-folder":
          beginCreate("folder", targetDir);
          break;
        case "rename":
          if (path) beginRename(path, kind === "folder");
          break;
        case "delete":
          if (path) {
            setConfirmDelete(selection.has(path) ? [...selection] : [path]);
          }
          break;
        case "pin":
        case "unpin":
          if (path) onTogglePin(path);
          break;
        case "export-zip":
          exportZip(kind === "root" ? undefined : path);
          break;
        case "import-files":
          props.onImportFiles(undefined, targetDir);
          break;
        case "share":
          if (path) props.onShare(path);
          break;
        case "refresh-share-mount":
          props.onRefreshShareMounts();
          break;
        case "unmount-share":
          if (path) props.onUnmountShare(path);
          break;
        case "open-externally":
          // Main performed the containment-checked reveal already.
          break;
      }
    },
    [
      workspaceId,
      selection,
      beginCreate,
      beginRename,
      onTogglePin,
      exportZip,
      props.onImportFiles,
      props.onShare,
      props.onRefreshShareMounts,
      props.onUnmountShare,
    ],
  );

  const onRowContextMenu = useCallback(
    (path: string, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selection.has(path)) selectSingle(path);
      const isFolder = isFolderPath(path);
      void dispatchMenu(isFolder ? "folder" : "file", path, props.pinned.includes(path));
    },
    [selection, selectSingle, isFolderPath, dispatchMenu, props.pinned],
  );

  const onContainerContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      void dispatchMenu("root", undefined, false);
    },
    [dispatchMenu],
  );

  // ---- drag and drop ----

  const onRowDragStart = useCallback(
    (path: string, event: DragEvent) => {
      const paths = selection.has(path) ? [...selection] : [path];
      dragSources.current = paths.map((p) => ({
        path: p,
        kind: isFolderPath(p) ? "folder" : "file",
      }));
      event.dataTransfer.effectAllowed = "move";
      // Some platforms require data for a drag to start.
      event.dataTransfer.setData("text/plain", paths.join("\n"));
    },
    [selection, isFolderPath],
  );

  const clearDragPreview = useCallback(() => {
    setDropPreview(null);
    if (hoverExpandTimer.current) {
      clearTimeout(hoverExpandTimer.current);
      hoverExpandTimer.current = null;
    }
  }, []);

  const targetDirFor = useCallback(
    (path: string): string => (isFolderPath(path) ? path : parentDir(path)),
    [isFolderPath],
  );

  const previewForDrop = useCallback(
    (
      event: DragEvent,
      targetPath: string | null,
      targetDir: string,
      targetIsFolder: boolean,
    ): DropPreview | null => {
      const sources = dragSources.current;
      if (sources) {
        const actions = sources.map((source) => planDrop(source, { parentDir: targetDir }));
        const moveCount = actions.filter((action) => action.kind !== "noop").length;
        const kind: DropPreview["kind"] = moveCount > 0 ? "move" : "blocked";
        return {
          targetPath,
          targetDir,
          kind,
          targetIsFolder,
        };
      }

      if (!externalDragHasFiles(event)) return null;
      return {
        targetPath,
        targetDir,
        kind: "copy",
        targetIsFolder,
      };
    },
    [],
  );

  const showDropPreview = useCallback((preview: DropPreview | null) => {
    setDropPreview((current) =>
      current?.targetPath === preview?.targetPath &&
      current?.targetDir === preview?.targetDir &&
      current?.kind === preview?.kind &&
      current?.targetIsFolder === preview?.targetIsFolder
        ? current
        : preview,
    );
  }, []);

  const onRowDragOver = useCallback(
    (path: string, event: DragEvent) => {
      event.stopPropagation();
      const dir = targetDirFor(path);
      const preview = previewForDrop(event, path, dir, isFolderPath(path));
      if (!preview) {
        event.dataTransfer.dropEffect = "none";
        showDropPreview(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect =
        preview.kind === "blocked" ? "none" : preview.kind === "copy" ? "copy" : "move";
      showDropPreview(preview);
      // Auto-expand a collapsed folder under a hovering drag.
      if (preview.kind !== "blocked" && isFolderPath(path) && !expandedSet.has(path)) {
        if (hoverExpandTimer.current) clearTimeout(hoverExpandTimer.current);
        hoverExpandTimer.current = setTimeout(() => {
          onSetFolderExpanded(path, true);
        }, 600);
      }
    },
    [
      targetDirFor,
      previewForDrop,
      isFolderPath,
      showDropPreview,
      expandedSet,
      onSetFolderExpanded,
    ],
  );

  const onRowDragLeave = useCallback(() => {
    if (hoverExpandTimer.current) {
      clearTimeout(hoverExpandTimer.current);
      hoverExpandTimer.current = null;
    }
  }, []);

  const handleDrop = useCallback(
    (targetDir: string, event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearDragPreview();
      if (dragSources.current) {
        const sources = dragSources.current;
        dragSources.current = null;
        performMoves(sources, targetDir);
        return;
      }
      // OS drag-in: map dropped Files to absolute paths in the PRELOAD
      // (webUtils) and import through the picker-grade main-side path.
      // Files land where they were dropped (targetDir), not the root.
      const files = [...event.dataTransfer.files];
      if (files.length > 0) {
        const paths = bridge().getDroppedFilePaths(files);
        if (paths.length > 0) props.onImportFiles(paths, targetDir);
      }
    },
    [clearDragPreview, performMoves, props.onImportFiles],
  );

  const onRowDrop = useCallback(
    (path: string, event: DragEvent) => handleDrop(targetDirFor(path), event),
    [handleDrop, targetDirFor],
  );

  const onRowDragEnd = useCallback(() => {
    dragSources.current = null;
    clearDragPreview();
  }, [clearDragPreview]);

  const onContainerDragOver = useCallback(
    (event: DragEvent) => {
      const preview = previewForDrop(event, null, "", false);
      if (!preview) {
        event.dataTransfer.dropEffect = "none";
        showDropPreview(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect =
        preview.kind === "blocked" ? "none" : preview.kind === "copy" ? "copy" : "move";
      showDropPreview(preview);
    },
    [previewForDrop, showDropPreview],
  );

  const onContainerDrop = useCallback(
    (event: DragEvent) => handleDrop("", event),
    [handleDrop],
  );

  const onContainerDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      clearDragPreview();
    },
    [clearDragPreview],
  );

  // ---- keyboard ----

  const onTreeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (editing) return;
      if (event.key === "F2") {
        event.preventDefault();
        const target = focusedPath ?? [...selection][0];
        if (target) beginRename(target, isFolderPath(target));
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        const targets = selection.size > 0 ? [...selection] : focusedPath ? [focusedPath] : [];
        if (targets.length > 0) setConfirmDelete(targets);
        return;
      }
      const action = navigateTree(rows, focusedPath, event.key);
      if (!action) return;
      event.preventDefault();
      switch (action.kind) {
        case "focus":
          focusRow(action.path);
          break;
        case "expand":
          onSetFolderExpanded(action.path, true);
          break;
        case "collapse":
          onSetFolderExpanded(action.path, false);
          break;
        case "toggle":
          onToggleFolder(action.path);
          break;
        case "open":
          selectSingle(action.path);
          onOpenFile(action.path);
          break;
      }
    },
    [
      editing,
      rows,
      focusedPath,
      selection,
      beginRename,
      isFolderPath,
      focusRow,
      onSetFolderExpanded,
      onToggleFolder,
      selectSingle,
      onOpenFile,
    ],
  );

  // ---- render ----

  // The edit target keeps its species: a folder rename shows the folder icon
  // AND its chevron (current expansion state) — the row must not morph into
  // a file for the duration of the edit.
  const isFolderEdit =
    editing?.mode === "create" ? editing.kind === "folder" : (editing?.isFolder ?? false);
  const folderEditExpanded =
    editing?.mode === "rename" && editing.isFolder && expandedSet.has(editing.path);

  const editRow = (depth: number): ReactNode => (
    <li role="none" key="edit-row">
      <div className="flex h-7 items-center gap-1.5 pr-2">
        <span aria-hidden className="w-1 shrink-0" />
        <IndentGuides depth={depth} />
        {editing?.mode === "rename" && editing.isFolder ? (
          <ChevronRight
            size={12}
            aria-hidden
            className={`shrink-0 text-subtle transition-transform ${folderEditExpanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span aria-hidden className="w-3 shrink-0" />
        )}
        {isFolderEdit ? (
          folderEditExpanded ? (
            <FolderOpen size={13} aria-hidden className="shrink-0 text-muted" />
          ) : (
            <Folder size={13} aria-hidden className="shrink-0 text-muted" />
          )
        ) : (
          <FileText size={13} aria-hidden className="shrink-0 text-muted" />
        )}
        <input
          spellCheck={false}
          ref={editInputRef}
          type="text"
          data-testid="tree-edit-input"
          aria-label={
            editing?.mode === "rename"
              ? "New name"
              : editing?.kind === "folder"
                ? "New folder name"
                : "New file name"
          }
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") finishEdit(false);
            else if (event.key === "Enter") finishEdit(true);
            event.stopPropagation();
          }}
          onBlur={() => finishEdit(true)}
          // The name keeps the row's exact type (13px sans, square) — F2
          // must not morph the label into a web-input pill — and the strong
          // border IS the focus affordance (the input is focused while open;
          // VS Code's rename input signals the same way with focusBorder).
          className="min-w-0 flex-1 rounded-sm border border-ink/50 bg-bg px-1 py-0.5 text-[13px] text-ink outline-none"
        />
      </div>
    </li>
  );

  function finishEdit(commit: boolean): void {
    if (editDone.current || !editing) return;
    editDone.current = true;
    if (!commit || editValue.trim() === "") {
      setEditing(null);
      return;
    }
    if (editing.mode === "create") {
      commitCreate(editing.kind, editing.parentPath, editValue);
    } else {
      commitRename(editing.path, editing.isFolder, editValue);
    }
  }

  // Insert the create-editbox right under its parent folder row (or at the
  // top for a root create); a rename-editbox replaces its row in place.
  const renderedRows: ReactNode[] = [];
  const rootDropPreview = dropPreview?.targetPath === null ? dropPreview : null;
  const dropPreviewForRow = (row: VisibleRow): RowDropPreview | null => {
    if (!dropPreview || dropPreview.targetPath === null) return null;
    if (dropPreview.targetPath === row.fullPath) {
      return { kind: dropPreview.kind, role: "target" };
    }
    if (
      dropPreview.targetIsFolder &&
      row.fullPath.startsWith(`${dropPreview.targetPath}/`)
    ) {
      return { kind: dropPreview.kind, role: "contained" };
    }
    return null;
  };
  if (editing?.mode === "create" && editing.parentPath === "") {
    renderedRows.push(editRow(0));
  }
  for (const row of rows) {
    if (editing?.mode === "rename" && editing.path === row.fullPath) {
      renderedRows.push(editRow(row.depth));
      continue;
    }
    renderedRows.push(
      <TreeRow
        key={row.fullPath}
        row={row}
        selected={selection.has(row.fullPath)}
        active={props.activeTab === row.fullPath}
        focused={focusedPath === row.fullPath}
        dropPreview={dropPreviewForRow(row)}
        registerRef={registerRef}
        onRowClick={onRowClick}
        onRowContextMenu={onRowContextMenu}
        onRowDragStart={onRowDragStart}
        onRowDragOver={onRowDragOver}
        onRowDrop={onRowDrop}
        onRowDragLeave={onRowDragLeave}
        onRowDragEnd={onRowDragEnd}
      />,
    );
    if (
      editing?.mode === "create" &&
      editing.parentPath !== "" &&
      editing.parentPath === row.fullPath
    ) {
      renderedRows.push(editRow(row.depth + 1));
    }
  }

  const empty = rows.length === 0 && !editing;

  return (
    <>
      <nav
        data-testid="file-tree"
        aria-label="Files"
        onKeyDown={onTreeKeyDown}
        onDragOver={onContainerDragOver}
        onDrop={onContainerDrop}
        onDragLeave={onContainerDragLeave}
        onContextMenu={onContainerContextMenu}
        className={`min-h-0 flex-1 overflow-y-auto py-1 ${
          rootDropPreview
            ? `outline outline-1 -outline-offset-2 ${
                rootDropPreview.kind === "blocked" ? "outline-danger/30" : "outline-ink/30"
              }`
            : ""
        }`}
      >
        <section
          data-testid="open-editors-section"
          aria-label="Open editors"
          className="relative mb-1 border-b border-line pb-1"
        >
          <header
            data-testid="open-editors-header"
            className="group flex h-6 items-center gap-1 pr-1 hover:bg-line/40"
          >
            <button
              type="button"
              data-testid="open-editors-toggle"
              aria-expanded={openEditorsExpanded}
              onClick={() => setOpenEditorsExpanded((expanded) => !expanded)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-[10px] font-semibold uppercase tracking-wide text-subtle group-hover:text-muted"
            >
              <ChevronRight
                size={11}
                aria-hidden
                className={`shrink-0 transition-transform ${openEditorsExpanded ? "rotate-90" : ""}`}
              />
              <span className="min-w-0 flex-1 truncate">Open Editors</span>
              {props.openTabs.length > 0 ? (
                <span
                  aria-label={`${props.openTabs.length} open editor${props.openTabs.length === 1 ? "" : "s"}`}
                  className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] leading-none text-subtle"
                >
                  {props.openTabs.length}
                </span>
              ) : null}
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              <SectionActionButton
                label="New untitled text file"
                onClick={props.onNewUntitledTextFile}
              >
                <FilePlus2 size={13} aria-hidden />
              </SectionActionButton>
              <SectionActionButton
                label="Close all editors"
                disabled={props.openTabs.length === 0}
                onClick={props.onCloseAllTabs}
              >
                <X size={13} aria-hidden />
              </SectionActionButton>
            </div>
          </header>

          {openEditorsExpanded ? (
            props.openTabs.length > 0 ? (
              <ul
                ref={openEditorsListRef}
                data-testid="open-editors-list"
                // Bounded, internally scrolling list (VS Code-style Open
                // Editors pane). The cap is workbench state: the section's
                // bottom-edge handle resizes it and the value persists — the
                // render additionally bounds it to the viewport cap.
                style={{ maxHeight: Math.min(props.openEditorsHeight, viewportCap) }}
                className="m-0 list-none overflow-y-auto overscroll-contain p-0"
              >
                {props.openTabs.map((tab) => {
                  const active = props.activeTab === tab.path;
                  const dirty =
                    props.dirtyTab === tab.path ||
                    props.recoveryPaths.has(tab.path);
                  const title = editorTitle(tab.path);
                  return (
                    <li
                      key={tab.path}
                      data-testid="open-editor-row"
                      data-path={tab.path}
                      data-active={active}
                      className={`group mx-1 flex h-7 items-center rounded-md transition-colors duration-75 ${
                        active ? "bg-line text-ink" : "text-muted hover:bg-line/50 hover:text-ink"
                      }`}
                    >
                      <button
                        type="button"
                        title={tab.path}
                        onClick={() => props.onActivateTab(tab.path)}
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-0 pl-8 pr-2 text-left text-[13px] outline-none"
                      >
                        <OpenEditorIcon
                          path={tab.path}
                          kind={fileByPath.get(tab.path)?.kind ?? null}
                        />
                        <span className="min-w-0 flex-1 truncate">{title}</span>
                        {dirty ? (
                          <span
                            data-testid="open-editor-dirty"
                            aria-label="Unsaved changes"
                            className="size-1.5 shrink-0 rounded-full bg-muted"
                          />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        data-testid="open-editor-close"
                        aria-label={`Close ${title}`}
                        title={`Close ${title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onCloseTab(tab.path);
                        }}
                        className={`mr-1 grid size-6 shrink-0 place-items-center rounded text-subtle hover:bg-line hover:text-ink focus:opacity-100 ${
                          active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        }`}
                      >
                        <X size={13} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="px-3 py-1.5 text-[11px] text-subtle">
                No open editors
              </div>
            )
          ) : null}
          {openEditorsExpanded && props.openTabs.length > 0 ? (
            <div
              data-testid="open-editors-resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize open editors"
              onPointerDown={(event) => {
                // Left button only — a right/middle press must never start a
                // resize (SidePanel hardening).
                if (event.button !== 0) return;
                // Drag starts from the RENDERED cap — from an oversized
                // saved cap the drag would otherwise have a huge dead zone
                // before anything visibly moves.
                openEditorsDrag.current = {
                  startY: event.clientY,
                  startHeight: Math.min(props.openEditorsHeight, viewportCap),
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = openEditorsDrag.current;
                if (drag === null) return;
                // If the release was missed (capture lost outside the
                // window), a buttons-up move must end the drag — or plain
                // hovering would keep resizing and persist bogus heights.
                if ((event.buttons & 1) === 0) {
                  openEditorsDrag.current = null;
                  return;
                }
                props.onOpenEditorsHeightChange(
                  clampOpenEditorsHeight(
                    drag.startHeight + event.clientY - drag.startY,
                  ),
                );
              }}
              onPointerUp={() => {
                openEditorsDrag.current = null;
              }}
              onPointerCancel={() => {
                openEditorsDrag.current = null;
              }}
              onLostPointerCapture={() => {
                openEditorsDrag.current = null;
              }}
              className="absolute -bottom-1 left-0 z-10 h-2 w-full cursor-row-resize bg-transparent transition-colors hover:bg-line/80"
            />
          ) : null}
        </section>

        <section data-testid="explorer-files-section" aria-label="Files">
          <header
            data-testid="explorer-files-header"
            className="group flex h-6 items-center gap-1 pr-1 hover:bg-line/40"
          >
            <button
              type="button"
              data-testid="explorer-files-toggle"
              aria-expanded={filesExpanded}
              onClick={() => setFilesExpanded((expanded) => !expanded)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-[10px] font-semibold uppercase tracking-wide text-subtle group-hover:text-muted"
            >
              <ChevronRight
                size={11}
                aria-hidden
                className={`shrink-0 transition-transform ${filesExpanded ? "rotate-90" : ""}`}
              />
              <span className="min-w-0 flex-1 truncate">Files</span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              <SectionActionButton label="New file" onClick={() => beginCreateAtFocus("file")}>
                <FilePlus2 size={13} aria-hidden />
              </SectionActionButton>
              <SectionActionButton
                label="New folder"
                onClick={() => beginCreateAtFocus("folder")}
              >
                <FolderPlus size={13} aria-hidden />
              </SectionActionButton>
              <SectionActionButton label="Refresh explorer" onClick={props.onRefresh}>
                <RefreshCw size={13} aria-hidden />
              </SectionActionButton>
              <SectionActionButton
                label="Collapse folders in explorer"
                onClick={props.onCollapseFolders}
              >
                <ChevronsUp size={13} aria-hidden />
              </SectionActionButton>
            </div>
          </header>

          {filesExpanded ? (
            <>
              {props.pinned.length > 0 ? (
                <section
                  data-testid="explorer-pinned"
                  aria-label="Pinned"
                  className="mb-1 border-b border-line pb-1"
                >
                  <header className="flex h-6 items-center gap-1.5 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
                    <Pin size={10} aria-hidden />
                    Pinned
                  </header>
                  <ul className="m-0 list-none p-0">
                    {props.pinned.map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          data-testid="pinned-row"
                          data-path={path}
                          onClick={() =>
                            isFolderPath(path)
                              ? onSetFolderExpanded(path, true)
                              : onOpenFile(path)
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void dispatchMenu(
                              isFolderPath(path) ? "folder" : "file",
                              path,
                              true,
                            );
                          }}
                          className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-[13px] text-muted hover:bg-line/50 hover:text-ink"
                        >
                          {isFolderPath(path) ? (
                            <Folder size={13} aria-hidden className="shrink-0" />
                          ) : (
                            fileGlyph(path)
                          )}
                          <span className="truncate">{leafOf(path)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {empty ? (
                <button
                  type="button"
                  onClick={props.onNewFileDialog}
                  className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
                >
                  <FilePlus2 size={13} aria-hidden />
                  Create your first file
                </button>
              ) : (
                <ul role="tree" aria-label="Workspace files" className="m-0 list-none p-0">
                  {renderedRows}
                </ul>
              )}

              {opError ? (
                <p
                  data-testid="explorer-error"
                  role="alert"
                  className="mx-3 mt-2 text-[11px] text-danger"
                >
                  {opError}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      </nav>

      {confirmDelete ? (
        <Overlay onClose={() => setConfirmDelete(null)}>
          <div
            data-testid="delete-confirm"
            className="flex max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
          >
            <div className="min-h-0 overflow-auto p-4">
              <p className="m-0 text-sm text-ink">
                Delete{" "}
                <span className="break-all font-medium">
                  {confirmDelete.length === 1
                    ? leafOf(confirmDelete[0]!)
                    : `${confirmDelete.length} items`}
                </span>
                ?
              </p>
              <p className="mb-0 mt-2 text-xs text-muted">
                It moves to the system trash — or to this workspace's .dohc/trash
                folder on drives without one — and can be restored from there.
              </p>
              {confirmDelete.length > 1 ? (
                <ul className="m-0 mt-3 max-h-36 list-none overflow-auto rounded border border-line bg-bg p-0">
                  {confirmDelete.map((path) => (
                    <li
                      key={path}
                      className="border-b border-line px-2 py-1 font-mono text-[11px] text-muted last:border-b-0"
                    >
                      <span className="break-all">{path}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="rounded border border-line px-3 py-1 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-delete"
                onClick={() => {
                  performDeletes(confirmDelete);
                  setConfirmDelete(null);
                }}
                className="rounded bg-danger px-3 py-1 text-xs text-white"
              >
                Delete
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </>
  );
}
