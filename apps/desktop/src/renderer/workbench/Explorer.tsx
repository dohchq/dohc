import {
  ChevronRight,
  Database,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  Pin,
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
import { Overlay } from "../Overlay";
import { planDrop, type DragSource } from "./file-tree-dnd";
import { navigateTree, type FlatRow } from "./file-tree-nav";
import {
  applyPendingTreeMoves,
  parentDir,
  pendingTreeMoveSettled,
  type PendingTreeChange,
} from "./file-tree-optimistic";
import { buildTree, type TreeNode } from "./path-tree";

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
  expandedFolders: string[];
  pinned: string[];
  // Incrementing request to begin an inline create at the root (palette /
  // application-menu "New Folder" route).
  createRequest: { kind: "file" | "folder"; id: number } | null;
  onOpenFile: (path: string) => void;
  onSetFolderExpanded: (path: string, expanded: boolean) => void;
  onToggleFolder: (path: string) => void;
  onTogglePin: (path: string) => void;
  // Awaited BEFORE the disk ops of a change batch: the shell flushes the
  // active editor's unsaved draft. A rename of the open file would otherwise
  // unmount the inspector AFTER the path moved — its unmount flush writes to
  // the OLD path (ENOENT, swallowed) and keystrokes inside the autosave
  // window are silently lost. For deletes it means the trashed copy carries
  // the latest keystrokes too.
  onBeforeChanges?: () => Promise<void>;
  // Successful moves/deletes re-project tabs/pins/expansion in the shell.
  onPathsChanged: (changes: PendingTreeChange[]) => void;
  onImportFiles: (droppedPaths?: string[]) => void;
  onRefresh: () => void;
  onNewFileDialog: () => void;
}

type EditingState =
  | { mode: "create"; kind: "file" | "folder"; parentPath: string }
  | { mode: "rename"; path: string; isFolder: boolean };

type VisibleRow = FlatRow & { kind: WorkspaceFileEntry["kind"] | null };

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

// Typed-path semantics from the old FileTree: a plain name lands in the
// edit's folder; a typed path containing "/" wins and is root-relative.
function resolveTypedPath(value: string, contextDir: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.includes("/")) return trimmed;
  return contextDir ? `${contextDir}/${trimmed}` : trimmed;
}

function FileKindIcon({ kind }: { kind: WorkspaceFileEntry["kind"] }) {
  if (kind === "database") return <Database size={13} aria-hidden className="shrink-0" />;
  if (kind === "app-source") return <LayoutGrid size={13} aria-hidden className="shrink-0" />;
  return <FileText size={13} aria-hidden className="shrink-0" />;
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

// Memoized row: primitives + stable callbacks only, so a selection change
// re-renders the rows whose state changed, not the whole tree.
const TreeRow = memo(function TreeRow(props: {
  row: VisibleRow;
  selected: boolean;
  active: boolean;
  focused: boolean;
  dropTarget: boolean;
  registerRef: (path: string, el: HTMLButtonElement | null) => void;
  onRowClick: (path: string, event: MouseEvent) => void;
  onRowContextMenu: (path: string, event: MouseEvent) => void;
  onRowDragStart: (path: string, event: DragEvent) => void;
  onRowDragOver: (path: string, event: DragEvent) => void;
  onRowDrop: (path: string, event: DragEvent) => void;
  onRowDragLeave: () => void;
}) {
  const { row } = props;
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        data-testid="tree-row"
        data-path={row.fullPath}
        data-kind={row.isFolder ? "folder" : "file"}
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
        // Three distinguishable read-outs (VS Code list semantics): the
        // ACTIVE-tab row keeps the strongest fill, selected-not-active rows a
        // lighter fill (Delete/drag act on the SELECTION — the visuals must
        // not collapse the two meanings), and the keyboard-FOCUSED row an
        // inset ring. The drag drop-target is a filled tint (list.drop-
        // Background style) — box-shadow/background only, NEVER `outline`:
        // the base outline-none nulls --tw-outline-style later in the same
        // cascade layer, which made an outline-based highlight unrenderable.
        className={`flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[13px] outline-none ${
          props.dropTarget
            ? "bg-line/70 text-ink"
            : props.active
              ? "bg-line text-ink"
              : props.selected
                ? "bg-line/60 text-ink"
                : "text-muted hover:bg-line/50 hover:text-ink"
        } ${props.focused ? "ring-1 ring-inset ring-ink/30" : ""}`}
      >
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
            <FileKindIcon kind={row.kind ?? "file"} />
          </>
        )}
        <span className="truncate">{leafOf(row.fullPath)}</span>
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
    onBeforeChanges,
    onPathsChanged,
    onSetFolderExpanded,
    onToggleFolder,
    onOpenFile,
    onTogglePin,
  } = props;
  const [pending, setPending] = useState<PendingTreeChange[]>([]);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const editInputRef = useRef<HTMLInputElement>(null);
  // One commit per edit session: Enter/Escape unmount the input, whose blur
  // fires with a STALE closure — without this latch the edit would commit
  // twice (and the second rename would fail on the now-missing source).
  const editDone = useRef(false);
  // Internal drag state: HTML5 DnD dataTransfer is unreadable during
  // dragover, so the dragged selection rides in a ref for the whole gesture.
  const dragSources = useRef<DragSource[] | null>(null);
  const hoverExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prune pending changes the authoritative refresh has confirmed.
  useEffect(() => {
    setPending((current) =>
      current.filter(
        (change) => !pendingTreeMoveSettled(change, props.files, props.folders),
      ),
    );
  }, [props.files, props.folders]);

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
      // Land any pending editor draft BEFORE paths move underneath it (see
      // onBeforeChanges). A failed flush must not block the op itself.
      await onBeforeChanges?.().catch(() => undefined);
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
      if (succeeded.length > 0) onPathsChanged(succeeded);
      onRefresh();
    },
    [onBeforeChanges, onPathsChanged, onRefresh],
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
      setSelection(new Set());
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
      const path = resolveTypedPath(value, parentPath);
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
          props.onImportFiles();
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

  const targetDirFor = useCallback(
    (path: string): string => (isFolderPath(path) ? path : parentDir(path)),
    [isFolderPath],
  );

  const onRowDragOver = useCallback(
    (path: string, event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = dragSources.current ? "move" : "copy";
      const dir = targetDirFor(path);
      setDropTarget((current) => (current === dir ? current : dir));
      // Auto-expand a collapsed folder under a hovering drag.
      if (isFolderPath(path) && !expandedSet.has(path)) {
        if (hoverExpandTimer.current) clearTimeout(hoverExpandTimer.current);
        hoverExpandTimer.current = setTimeout(() => {
          onSetFolderExpanded(path, true);
        }, 600);
      }
    },
    [targetDirFor, isFolderPath, expandedSet, onSetFolderExpanded],
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
      setDropTarget(null);
      if (hoverExpandTimer.current) clearTimeout(hoverExpandTimer.current);
      if (dragSources.current) {
        const sources = dragSources.current;
        dragSources.current = null;
        performMoves(sources, targetDir);
        return;
      }
      // OS drag-in: map dropped Files to absolute paths in the PRELOAD
      // (webUtils) and import through the picker-grade main-side path.
      const files = [...event.dataTransfer.files];
      if (files.length > 0) {
        const paths = bridge().getDroppedFilePaths(files);
        if (paths.length > 0) props.onImportFiles(paths);
      }
    },
    [performMoves, props.onImportFiles],
  );

  const onRowDrop = useCallback(
    (path: string, event: DragEvent) => handleDrop(targetDirFor(path), event),
    [handleDrop, targetDirFor],
  );

  const onContainerDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = dragSources.current ? "move" : "copy";
    setDropTarget((current) => (current === "" ? current : ""));
  }, []);

  const onContainerDrop = useCallback(
    (event: DragEvent) => handleDrop("", event),
    [handleDrop],
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
        dropTarget={dropTarget !== null && dropTarget !== "" && row.isFolder && dropTarget === row.fullPath}
        registerRef={registerRef}
        onRowClick={onRowClick}
        onRowContextMenu={onRowContextMenu}
        onRowDragStart={onRowDragStart}
        onRowDragOver={onRowDragOver}
        onRowDrop={onRowDrop}
        onRowDragLeave={onRowDragLeave}
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
        onDragLeave={() => setDropTarget(null)}
        onContextMenu={onContainerContextMenu}
        className={`min-h-0 flex-1 overflow-y-auto py-1 ${
          dropTarget === "" ? "outline outline-1 -outline-offset-2 outline-ink/30" : ""
        }`}
      >
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
                      <FileKindIcon
                        kind={
                          projected.files.find((file) => file.path === path)?.kind ??
                          "file"
                        }
                      />
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
