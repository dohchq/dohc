import { SectionLabel } from "../ui/controls";
import { basenameOf, dirnameOf } from "../path";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { DraftFlush } from "../useAutosavedTextDraft";
import { Overlay } from "../Overlay";
import { momentDiffName } from "./EditorTabs";
import { planDrop, type DragSource } from "./file-tree-dnd";
import { navigateTree, type FlatRow } from "./file-tree-nav";
import { withMarkdownDefault } from "./new-file-name";
import {
  applyPendingTreeMoves,
  pendingTreeMoveSettled,
  type PendingTreeChange,
} from "./file-tree-optimistic";
import { buildTree, type TreeNode } from "./path-tree";
import {
  type EditorGroup,
  clampOpenEditorsHeight,
  isCollectionTabPath,
  isChatsTabPath,
  chatTabDefaultTitle,
  isGraphTabPath,
  isHistoryTabPath,
  isMomentDiffTabPath,
  isPluginDetailsTabPath,
  isPluginPanelTabPath,
  isPluginWebAppTabPath,
  isSiteTabPath,
  isVersionCompareTabPath,
  isVirtualTabPath,
  parseCollectionTabPath,
  parsePluginDetailsTabPath,
  parsePluginPanelTabPath,
  parsePluginWebAppTabPath,
  parseSiteTabPath,
} from "./workbenchState";
import { useCommitOnRelease } from "./useCommitOnRelease";

// One Explorer disk operation, as the shell's onBeginChanges opens it.
// `settle` is the deferred draft settlement runChanges awaits before it
// projects paths. `release` ends the collection cell-edit pause the begin
// acquired; runChanges holds it until the successful paths are projected —
// a drain alone is not enough, because a cell edit accepted while
// moveWorkspacePath is pending would enqueue the path the move vacates.
export type TreeChangeOperation = {
  settle: DraftFlush;
  release: () => void;
};

// The explorer: a real nested tree over the flat (files, folders) lists with
// inline create/rename editboxes, optimistic pending ops (rollback on error),
// multi-select, drag-move, pins, keyboard nav (ported file-tree-nav), and the
// native context menu via the closed showExplorerMenu invoke. The explorer is
// never a privileged writer: every mutation is an IPC the watcher observes,
// so each op lands in history as an ordinary change set.

export interface ExplorerProps {
  workspaceId: string;
  files: WorkspaceFileEntry[];
  folders: string[];
  editorGroups: EditorGroup[];
  activeEditorGroup: string;
  dirtyPaths: ReadonlySet<string>;
  // Paths with a set-aside draft: marks Open Editors rows for every
  // tab, not only the active one.
  recoveryPaths: ReadonlySet<string>;
  /** Display names for virtual paths that cannot carry a useful file name. */
  tabLabels?: ReadonlyMap<string, string>;
  expandedFolders: string[];
  pinned: string[];
  // Max height of the Open Editors list (workbench state, persisted): the
  // list caps here and scrolls internally; the section's bottom-edge drag
  // handle previews locally and commits the final clamped height on release.
  openEditorsHeight: number;
  onOpenEditorsHeightChange: (height: number) => void;
  // Incrementing request to begin an inline create at the root (palette /
  // application-menu "New Folder" route).
  createRequest: { kind: "file" | "folder"; id: number } | null;
  onOpenFile: (path: string) => void;
  onActivateTab: (groupId: string, path: string) => void;
  onCloseTab: (groupId: string, path: string) => void;
  onCloseAllTabs: () => void;
  onNewUntitledTextFile: () => void;
  onCollapseFolders: () => void;
  onSetFolderExpanded: (path: string, expanded: boolean) => void;
  onToggleFolder: (path: string) => void;
  onTogglePin: (path: string) => void;
  // Folder paths the engine lists as collections. Clicking the row opens the
  // collection's views; the chevron still expands the folder in place, and
  // keyboard expand/collapse is untouched.
  collectionFolders: ReadonlySet<string>;
  onOpenCollection: (path: string) => void;
  // The shell flushes the stable active editor before disk changes and returns
  // a settlement that retains every editor mounted while those changes run.
  // A rejected begin (a flush failure, an unresolved collection write)
  // aborts the batch.
  onBeginChanges?: () => Promise<TreeChangeOperation>;
  // Successful moves/deletes re-project tabs/pins/expansion in the shell.
  onPathsChanged: (changes: PendingTreeChange[]) => void;
  // Import into targetDir ("" = root): the folder that was dropped on, or the
  // folder whose context menu ran "Import Files…". Main re-validates it.
  onImportFiles: (droppedPaths?: string[], targetDir?: string) => void;
  // Share mounts: refresh every mount in this workspace / remove the mount
  // that owns the given path (shared-with-me/<label>/…).
  // A share view's delete removes the projection of a moment, not a file the
  // workspace owns, so the confirmation must not promise a trash it has no
  // path to. The granter's copy is what the change can still be taken back
  // from, which is why the granter is named here rather than described.
  shareView: { granterEmail: string | null } | null;
  onRefreshShareMounts: () => void;
  onUnmountShare: (path: string) => void;
  // "Share…": offered by the main-owned context menu on synced,
  // non-shared-view workspaces; opens the shell's share dialog for the path.
  onShare: (path: string) => void;
  onRefresh: () => void;
  // Failed tree operations go to the shell's error toast and Notices row.
  onError: (message: string) => void;
  // "New Collection…" from the main-owned context menu: opens the shell's
  // new-collection dialog seeded with the folder that was right-clicked
  // ("" = root).
  onNewCollection: (targetDir: string) => void;
}

type EditingState =
  | { mode: "create"; kind: "file" | "folder"; parentPath: string }
  | { mode: "rename"; path: string; isFolder: boolean };

type VisibleRow = FlatRow & {
  kind: WorkspaceFileEntry["kind"] | null;
  positionInSet: number;
  setSize: number;
  // The page's `icon` frontmatter emoji, shown in place of the file glyph.
  icon?: string;
};

type TreeRenderItem =
  | { kind: "row"; key: string; row: VisibleRow }
  | { kind: "edit"; key: "edit-row"; depth: number };

type VirtualRange = { start: number; end: number };

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

export function editorTitle(path: string, label?: string): string {
  if (isChatsTabPath(path)) return label ?? chatTabDefaultTitle(path);
  if (isGraphTabPath(path)) return "Graph";
  if (isCollectionTabPath(path)) {
    return basenameOf(parseCollectionTabPath(path) ?? "Collection");
  }
  if (isHistoryTabPath(path)) return "History";
  if (isMomentDiffTabPath(path)) {
    return momentDiffName(label);
  }
  if (isPluginPanelTabPath(path)) {
    return `Plugin: ${parsePluginPanelTabPath(path)?.panelId ?? "panel"}`;
  }
  if (isPluginWebAppTabPath(path)) {
    return `Plugin: ${parsePluginWebAppTabPath(path)?.webAppId ?? "app"}`;
  }
  if (isPluginDetailsTabPath(path)) {
    return `Plugin: ${parsePluginDetailsTabPath(path)?.pluginId ?? "details"}`;
  }
  if (isSiteTabPath(path)) return `App: ${parseSiteTabPath(path) ?? "preview"}`;
  if (isVersionCompareTabPath(path)) return "Compare with Main";
  return basenameOf(path);
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
const TREE_ROW_HEIGHT = 28;
const TREE_VIRTUALIZATION_THRESHOLD = 200;
const TREE_VIRTUAL_OVERSCAN = 12;
const TREE_INITIAL_WINDOW_SIZE = 64;

function viewportOpenEditorsCap(): number {
  return Math.round(window.innerHeight * OPEN_EDITORS_VIEWPORT_FRACTION);
}

function rangeAroundIndex(index: number, itemCount: number): VirtualRange {
  const halfWindow = Math.floor(TREE_INITIAL_WINDOW_SIZE / 2);
  const start = Math.max(0, Math.min(index - halfWindow, itemCount - TREE_INITIAL_WINDOW_SIZE));
  return { start, end: Math.min(itemCount, start + TREE_INITIAL_WINDOW_SIZE) };
}

// Memoized row: primitives + stable callbacks only, so a selection change
// re-renders the rows whose state changed, not the whole tree.
const TreeRow = memo(function TreeRow(props: {
  row: VisibleRow;
  // The engine lists this folder as a collection, so a row click opens its
  // views. Exposed as data-collection so tests can gate on the state before
  // clicking.
  collection: boolean;
  selected: boolean;
  active: boolean;
  focused: boolean;
  dropPreview: RowDropPreview | null;
  registerRef: (path: string, el: HTMLButtonElement | null) => void;
  onRowClick: (path: string, event: MouseEvent) => void;
  onRowChevronClick: (path: string, event: MouseEvent) => void;
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
        data-collection={props.collection ? "true" : undefined}
        data-drop-state={props.dropPreview?.kind}
        aria-level={row.depth + 1}
        aria-posinset={row.positionInSet}
        aria-setsize={row.setSize}
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
        // lighter fill (Delete/drag act on the selection — the visuals must
        // not collapse the two meanings), and the keyboard-FOCUSED row an
        // inset ring. The drag drop-target is a filled tint (list.drop-
        // Background style) — box-shadow/background only, never `outline`:
        // the base outline-none nulls --tw-outline-style later in the same
        // cascade layer, which made an outline-based highlight unrenderable.
        style={{ height: TREE_ROW_HEIGHT }}
        className={`relative flex w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] outline-none transition-colors duration-75 ${
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
            {/* Its own click target: on a collection folder the ROW opens the
                views, so the chevron is what still expands in place. A span,
                not a button — buttons cannot nest. */}
            <span
              data-testid="tree-row-chevron"
              onClick={(event) => props.onRowChevronClick(row.fullPath, event)}
              className="grid shrink-0 place-items-center"
            >
              <ChevronRight
                size={12}
                aria-hidden
                className={`shrink-0 text-subtle transition-transform ${row.isExpanded ? "rotate-90" : ""}`}
              />
            </span>
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
        <span className="min-w-0 flex-1 truncate">{basenameOf(row.fullPath)}</span>
      </button>
    </li>
  );
});

let editIdCounter = 0;
function nextChangeId(): string {
  editIdCounter += 1;
  return `pending-${editIdCounter}`;
}

// Memoized like TreeRow and for the same reason: the workspace shell re-renders
// on every lane commit, and with a stabilized prop set (the shell's side of the
// contract) the whole tree bails instead of reconciling per row.
export const Explorer = memo(function Explorer(props: ExplorerProps) {
  const {
    workspaceId,
    onRefresh,
    onError,
    onBeginChanges,
    onPathsChanged,
    onSetFolderExpanded,
    onToggleFolder,
    onOpenFile,
    onOpenCollection,
    onTogglePin,
  } = props;
  const activeTab =
    props.editorGroups.find((group) => group.id === props.activeEditorGroup)?.activeTab ??
    null;
  const openEditorCount = props.editorGroups.reduce(
    (count, group) => count + group.tabs.length,
    0,
  );
  const [pending, setPending] = useState<PendingTreeChange[]>([]);
  const [openEditorsExpanded, setOpenEditorsExpanded] = useState(true);
  const [viewportCap, setViewportCap] = useState(viewportOpenEditorsCap);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  // Row-callback mirrors, synced during render (idempotent, so a repeated
  // render commits the same value). The row callbacks read these instead of
  // depending on the state: a selection or anchor change re-renders only the
  // rows whose flags changed, not every row via new callback identities —
  // TreeRow's memo is only as good as the stability of what it is passed.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const anchorPathRef = useRef(anchorPath);
  anchorPathRef.current = anchorPath;
  // Same ref-mirror idiom: rows keep their memoized callbacks when the
  // collection set refreshes.
  const collectionFoldersRef = useRef(props.collectionFolders);
  collectionFoldersRef.current = props.collectionFolders;
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusPath = useRef<string | null>(null);
  const fileTreeRef = useRef<HTMLElement>(null);
  const workspaceTreeRef = useRef<HTMLUListElement>(null);
  const openEditorsListRef = useRef<HTMLUListElement>(null);
  const [virtualRange, setVirtualRange] = useState<VirtualRange>({
    start: 0,
    end: TREE_INITIAL_WINDOW_SIZE,
  });
  // Pointer position + cap at drag start — heights derive from the DELTA, not
  // from the list's edges: the list is max-height (shorter lists shrink to
  // fit), so the handle can sit above the cap and an edge-based height would
  // collapse the saved cap to the content height on the first move.
  const openEditorsDrag = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const openEditorsResize = useCommitOnRelease(
    props.onOpenEditorsHeightChange,
  );
  const openEditorsHeight = Math.min(
    openEditorsResize.previewValue ?? props.openEditorsHeight,
    viewportCap,
  );
  const editInputRef = useRef<HTMLInputElement>(null);
  // One commit per edit session: Enter/Escape unmount the input, whose blur
  // fires with a stale closure — without this latch the edit would commit
  // twice (and the second rename would fail on the now-missing source).
  const editDone = useRef(false);
  // Internal drag state: HTML5 DnD dataTransfer is unreadable during
  // dragover, so the dragged selection rides in a ref for the whole gesture.
  const dragSources = useRef<DragSource[] | null>(null);
  // Keep the actual drag-origin element mounted while Chromium owns the
  // gesture. A virtualized source that disappears during auto-scroll does not
  // receive dragend, which can otherwise leave a stale internal move armed.
  const [dragOriginPath, setDragOriginPath] = useState<string | null>(null);
  const hoverExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onResize = () => setViewportCap(viewportOpenEditorsCap());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Prune pending changes the authoritative refresh has confirmed.
  useEffect(() => {
    setPending((current) => {
      const next = current.filter(
        (change) => !pendingTreeMoveSettled(change, props.files, props.folders),
      );
      return next.length === current.length ? current : next;
    });
  }, [props.files, props.folders]);

  // The open-editors list caps its height and scrolls internally, so the
  // active row must be brought back into view whenever it changes — or moves:
  // editorGroups (reducer state, referentially stable between changes) is a
  // dependency because reordering or closing tabs shifts the active row
  // without changing activeTab (and shrinking the section can push it out).
  // Scroll the list directly (not scrollIntoView): the list and the file tree
  // share the sidebar's outer scroll container, and scrollIntoView would also
  // scroll that ancestor — yanking the user's tree scroll position on tab
  // switches.
  useEffect(() => {
    if (!activeTab || !openEditorsExpanded) return;
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
    activeTab,
    props.editorGroups,
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
      for (const [childIndex, child] of node.children.entries()) {
        const isFolder = child.file === null;
        const isExpanded = isFolder && expandedSet.has(child.fullPath);
        out.push({
          fullPath: child.fullPath,
          isFolder,
          isExpanded,
          depth,
          parentPath,
          kind: child.file?.kind ?? null,
          positionInSet: childIndex + 1,
          setSize: node.children.length,
          ...(child.file?.icon ? { icon: child.file.icon } : {}),
        });
        if (isFolder && isExpanded) walk(child, depth + 1, child.fullPath);
      }
    };
    walk(tree, 0, null);
    return out;
  }, [tree, expandedSet]);
  // Same mirror as selectionRef: rows already re-render when the tree changes
  // (their row objects are rebuilt), so nothing is lost by keeping them out of
  // the click callback's identity.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const renderItems = useMemo<TreeRenderItem[]>(() => {
    const items: TreeRenderItem[] = [];
    if (editing?.mode === "create" && editing.parentPath === "") {
      items.push({ kind: "edit", key: "edit-row", depth: 0 });
    }
    for (const row of rows) {
      if (editing?.mode === "rename" && editing.path === row.fullPath) {
        items.push({ kind: "edit", key: "edit-row", depth: row.depth });
      } else {
        items.push({ kind: "row", key: row.fullPath, row });
      }
      if (
        editing?.mode === "create" &&
        editing.parentPath !== "" &&
        editing.parentPath === row.fullPath
      ) {
        items.push({ kind: "edit", key: "edit-row", depth: row.depth + 1 });
      }
    }
    return items;
  }, [editing, rows]);

  const renderIndexByPath = useMemo(() => {
    const indexes = new Map<string, number>();
    for (const [index, item] of renderItems.entries()) {
      if (item.kind === "row") indexes.set(item.row.fullPath, index);
    }
    return indexes;
  }, [renderItems]);

  const virtualized = renderItems.length > TREE_VIRTUALIZATION_THRESHOLD;

  const updateVirtualRange = useCallback(() => {
    if (!virtualized) return;
    const container = fileTreeRef.current;
    const list = workspaceTreeRef.current;
    if (!container || !list) return;

    const containerRect = container.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const listTop = listRect.top - containerRect.top + container.scrollTop;
    const viewportTop = Math.max(0, container.scrollTop - listTop);
    const firstVisible = Math.min(
      renderItems.length - 1,
      Math.floor(viewportTop / TREE_ROW_HEIGHT),
    );
    const visibleCount = Math.max(
      1,
      Math.ceil(container.clientHeight / TREE_ROW_HEIGHT),
    );
    const next = {
      start: Math.max(0, firstVisible - TREE_VIRTUAL_OVERSCAN),
      end: Math.min(
        renderItems.length,
        firstVisible + visibleCount + TREE_VIRTUAL_OVERSCAN,
      ),
    };
    setVirtualRange((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  }, [renderItems.length, virtualized]);

  useLayoutEffect(() => {
    updateVirtualRange();
  }, [
    updateVirtualRange,
    filesExpanded,
    openEditorsExpanded,
    openEditorsHeight,
    openEditorCount,
    props.pinned.length,
  ]);

  useEffect(() => {
    const container = fileTreeRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVirtualRange);
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateVirtualRange]);

  const folderPathSet = useMemo(() => new Set(projected.folders), [projected]);

  const isFolderPath = useCallback(
    (path: string) => folderPathSet.has(path),
    [folderPathSet],
  );

  const registerRef = useCallback((path: string, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(path, el);
    else rowRefs.current.delete(path);
  }, []);

  const focusRow = useCallback(
    (path: string) => {
      setFocusedPath(path);
      const element = rowRefs.current.get(path);
      if (element) {
        pendingFocusPath.current = null;
        element.focus();
        return;
      }
      pendingFocusPath.current = path;
      const index = renderIndexByPath.get(path);
      if (index !== undefined) {
        setVirtualRange(rangeAroundIndex(index, renderItems.length));
      }
    },
    [renderIndexByPath, renderItems.length],
  );

  useLayoutEffect(() => {
    const path = pendingFocusPath.current;
    if (!path || path !== focusedPath) return;
    const element = rowRefs.current.get(path);
    if (!element) return;
    pendingFocusPath.current = null;
    element.focus();
  }, [focusedPath, virtualRange]);

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
      (activeTab && !isVirtualTabPath(activeTab) ? activeTab : null);
    if (!target) return "";
    return isFolderPath(target) ? target : dirnameOf(target);
  }, [activeTab, focusedPath, isFolderPath, selection]);

  const beginCreateAtFocus = useCallback(
    (kind: "file" | "folder") => {
      beginCreate(kind, creationParentPath());
    },
    [beginCreate, creationParentPath],
  );

  const beginRename = useCallback(
    (path: string, isFolder: boolean) => {
      setEditValue(basenameOf(path));
      editDone.current = false;
      setEditing({ mode: "rename", path, isFolder });
    },
    [],
  );

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
      // Land the stable active draft and drain queued collection writes
      // before paths move underneath them. The operation cannot preserve
      // text or values this begin rejected.
      let operation: TreeChangeOperation | null = null;
      try {
        operation = (await onBeginChanges?.()) ?? null;
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      try {
        setPending((current) => [...current, ...changes]);
        const succeeded: PendingTreeChange[] = [];
        for (const change of changes) {
          try {
            await run(change);
            succeeded.push(change);
          } catch (cause) {
            setPending((current) => current.filter((entry) => entry.id !== change.id));
            onError(cause instanceof Error ? cause.message : String(cause));
          }
        }
        const changedExistingPath = succeeded.some(
          (change) => change.kind !== "create-file" && change.kind !== "create-folder",
        );
        try {
          await operation?.settle(
            changedExistingPath ? { captureOnFailure: true } : undefined,
          );
        } catch (cause) {
          // The disk change already completed. Surface the settlement error,
          // then project the successful paths so the shell matches storage.
          onError(cause instanceof Error ? cause.message : String(cause));
        }
        if (succeeded.length > 0) onPathsChanged(succeeded);
        onRefresh();
      } finally {
        // Cell edits resume only after the successful paths are projected,
        // so nothing can enqueue against a path this operation just changed.
        operation?.release();
      }
    },
    [onBeginChanges, onError, onPathsChanged, onRefresh],
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
      const typed = resolveTypedPath(value, dirnameOf(path));
      // A file name without an extension means markdown here too, so
      // "hello.md" typed as "hello" stays put and "hello.m" becomes markdown.
      const toPath = typed && !isFolder ? withMarkdownDefault(typed) : typed;
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
      // New files are markdown unless an extension is typed.
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
            initialText: "",
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
          onError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [onError, workspaceId],
  );

  // ---- selection + clicks ----

  const selectSingle = useCallback((path: string) => {
    pendingFocusPath.current = null;
    setSelection(new Set([path]));
    setAnchorPath(path);
    setFocusedPath(path);
  }, []);

  const onRowClick = useCallback(
    (path: string, event: MouseEvent) => {
      pendingFocusPath.current = null;
      const rowList = rowsRef.current;
      const isFolder =
        rowList.find((row) => row.fullPath === path)?.isFolder ?? false;
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
      const anchor = anchorPathRef.current;
      if (event.shiftKey && anchor) {
        const order = rowList.map((row) => row.fullPath);
        const from = order.indexOf(anchor);
        const to = order.indexOf(path);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelection(new Set(order.slice(lo, hi + 1)));
          setFocusedPath(path);
          return;
        }
      }
      selectSingle(path);
      if (!isFolder) {
        onOpenFile(path);
      } else if (collectionFoldersRef.current.has(path)) {
        // A collection folder opens its views (docs/plans/collections.md
        // Phase 2). The chevron and arrow keys still expand it in place.
        onOpenCollection(path);
      } else {
        onToggleFolder(path);
      }
    },
    [selectSingle, onToggleFolder, onOpenFile, onOpenCollection],
  );

  const onRowChevronClick = useCallback(
    (path: string, event: MouseEvent) => {
      event.stopPropagation();
      onToggleFolder(path);
    },
    [onToggleFolder],
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
        kind === "root" ? "" : kind === "folder" ? (path ?? "") : dirnameOf(path ?? "");
      switch (command) {
        case "new-file":
          beginCreate("file", targetDir);
          break;
        case "new-folder":
          beginCreate("folder", targetDir);
          break;
        case "new-collection":
          props.onNewCollection(targetDir);
          break;
        case "rename":
          if (path) beginRename(path, kind === "folder");
          break;
        case "delete":
          if (path) {
            const selected = selectionRef.current;
            setConfirmDelete(selected.has(path) ? [...selected] : [path]);
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
      beginCreate,
      beginRename,
      onTogglePin,
      exportZip,
      props.onImportFiles,
      props.onShare,
      props.onRefreshShareMounts,
      props.onUnmountShare,
      props.onNewCollection,
    ],
  );

  const onRowContextMenu = useCallback(
    (path: string, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectionRef.current.has(path)) selectSingle(path);
      const isFolder = isFolderPath(path);
      void dispatchMenu(isFolder ? "folder" : "file", path, props.pinned.includes(path));
    },
    [selectSingle, isFolderPath, dispatchMenu, props.pinned],
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
      const selected = selectionRef.current;
      const paths = selected.has(path) ? [...selected] : [path];
      dragSources.current = paths.map((p) => ({
        path: p,
        kind: isFolderPath(p) ? "folder" : "file",
      }));
      setDragOriginPath(path);
      event.dataTransfer.effectAllowed = "move";
      // Some platforms require data for a drag to start.
      event.dataTransfer.setData("text/plain", paths.join("\n"));
    },
    [isFolderPath],
  );

  const clearDragPreview = useCallback(() => {
    setDropPreview(null);
    if (hoverExpandTimer.current) {
      clearTimeout(hoverExpandTimer.current);
      hoverExpandTimer.current = null;
    }
  }, []);

  const targetDirFor = useCallback(
    (path: string): string => (isFolderPath(path) ? path : dirnameOf(path)),
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
        setDragOriginPath(null);
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
    setDragOriginPath(null);
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
          if (collectionFoldersRef.current.has(action.path)) {
            onOpenCollection(action.path);
          } else {
            onToggleFolder(action.path);
          }
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
      onOpenCollection,
      selectSingle,
      onOpenFile,
    ],
  );

  // ---- render ----

  // The edit target keeps its species: a folder rename shows the folder icon
  // and its chevron (current expansion state) — the row must not morph into
  // a file for the duration of the edit.
  const isFolderEdit =
    editing?.mode === "create" ? editing.kind === "folder" : (editing?.isFolder ?? false);
  const folderEditExpanded =
    editing?.mode === "rename" && editing.isFolder && expandedSet.has(editing.path);

  const editRow = (depth: number): ReactNode => (
    <li role="none" key="edit-row">
      <div style={{ height: TREE_ROW_HEIGHT }} className="flex items-center gap-1.5 pr-2">
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

  // Keep the DOM proportional to the viewport. The full flattened row list
  // remains authoritative for keyboard navigation and range selection; only
  // its fixed-height presentation is windowed. A focused row stays mounted
  // outside the viewport so wheel scrolling never destroys the roving tab
  // stop or drops browser focus.
  const mountedIndexes = new Set<number>();
  const range = virtualized
    ? {
        start: Math.max(0, Math.min(virtualRange.start, renderItems.length)),
        end: Math.max(0, Math.min(virtualRange.end, renderItems.length)),
      }
    : { start: 0, end: renderItems.length };
  for (let index = range.start; index < range.end; index += 1) {
    mountedIndexes.add(index);
  }
  if (virtualized && focusedPath) {
    const focusedIndex = renderIndexByPath.get(focusedPath);
    if (focusedIndex !== undefined) mountedIndexes.add(focusedIndex);
  }
  if (virtualized && dragOriginPath) {
    const dragOriginIndex = renderIndexByPath.get(dragOriginPath);
    if (dragOriginIndex !== undefined) mountedIndexes.add(dragOriginIndex);
  }
  if (virtualized && editing) {
    const editIndex = renderItems.findIndex((item) => item.kind === "edit");
    if (editIndex !== -1) mountedIndexes.add(editIndex);
  }

  const renderedRows: ReactNode[] = [];
  let nextIndex = 0;
  for (const index of [...mountedIndexes].sort((left, right) => left - right)) {
    if (index > nextIndex) {
      renderedRows.push(
        <li
          key={`virtual-space-${nextIndex}-${index}`}
          role="none"
          aria-hidden
          style={{ height: (index - nextIndex) * TREE_ROW_HEIGHT }}
        />,
      );
    }
    const item = renderItems[index];
    if (!item) continue;
    if (item.kind === "edit") {
      renderedRows.push(editRow(item.depth));
    } else {
      const row = item.row;
      renderedRows.push(
        <TreeRow
          key={item.key}
          row={row}
          collection={row.isFolder && props.collectionFolders.has(row.fullPath)}
          selected={selection.has(row.fullPath)}
          active={activeTab === row.fullPath}
          focused={focusedPath === row.fullPath}
          dropPreview={dropPreviewForRow(row)}
          registerRef={registerRef}
          onRowClick={onRowClick}
          onRowChevronClick={onRowChevronClick}
          onRowContextMenu={onRowContextMenu}
          onRowDragStart={onRowDragStart}
          onRowDragOver={onRowDragOver}
          onRowDrop={onRowDrop}
          onRowDragLeave={onRowDragLeave}
          onRowDragEnd={onRowDragEnd}
        />,
      );
    }
    nextIndex = index + 1;
  }
  if (virtualized && nextIndex < renderItems.length) {
    renderedRows.push(
      <li
        key={`virtual-space-${nextIndex}-${renderItems.length}`}
        role="none"
        aria-hidden
        style={{ height: (renderItems.length - nextIndex) * TREE_ROW_HEIGHT }}
      />,
    );
  }

  const empty = rows.length === 0 && !editing;

  return (
    <>
      <nav
        ref={fileTreeRef}
        data-testid="file-tree"
        aria-label="Files"
        onKeyDown={onTreeKeyDown}
        onScroll={updateVirtualRange}
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
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left dohc-section-label group-hover:text-muted"
            >
              <ChevronRight
                size={11}
                aria-hidden
                className={`shrink-0 transition-transform ${openEditorsExpanded ? "rotate-90" : ""}`}
              />
              <span className="min-w-0 flex-1 truncate">Open Editors</span>
              {openEditorCount > 0 ? (
                <span
                  aria-label={`${openEditorCount} open editor${openEditorCount === 1 ? "" : "s"}`}
                  className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] leading-none text-subtle"
                >
                  {openEditorCount}
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
                disabled={openEditorCount === 0}
                onClick={props.onCloseAllTabs}
              >
                <X size={13} aria-hidden />
              </SectionActionButton>
            </div>
          </header>

          {openEditorsExpanded ? (
            openEditorCount > 0 ? (
              <ul
                ref={openEditorsListRef}
                data-testid="open-editors-list"
                // Bounded, internally scrolling list (VS Code-style Open
                // Editors pane). The cap is workbench state: the section's
                // bottom-edge handle resizes it and the value persists — the
                // render additionally bounds it to the viewport cap.
                style={{ maxHeight: openEditorsHeight }}
                className="m-0 list-none overflow-y-auto overscroll-contain p-0"
              >
                {props.editorGroups.map((group, groupIndex) => (
                  <li
                    key={group.id}
                    data-testid="open-editor-group"
                    data-group-id={group.id}
                  >
                    {props.editorGroups.length > 1 ? (
                      <SectionLabel as="div"
                        role="heading"
                        aria-level={3}
                        className="h-6 px-3 pt-1"
                      >
                        Group {groupIndex + 1}
                      </SectionLabel>
                    ) : null}
                    <ul
                      aria-label={
                        props.editorGroups.length > 1
                          ? `Group ${groupIndex + 1} open editors`
                          : undefined
                      }
                      className="m-0 list-none p-0"
                    >
                      {group.tabs.map((tab) => {
                        const active =
                          group.id === props.activeEditorGroup &&
                          group.activeTab === tab.path;
                        const dirty =
                          props.dirtyPaths.has(tab.path) ||
                          props.recoveryPaths.has(tab.path);
                        const title = editorTitle(
                          tab.path,
                          props.tabLabels?.get(tab.path),
                        );
                        return (
                          <li
                            key={`${group.id}:${tab.path}`}
                            data-testid="open-editor-row"
                            data-group-id={group.id}
                            data-path={tab.path}
                            data-active={active}
                            className={`group mx-1 flex h-7 items-center rounded-md transition-colors duration-75 ${
                              active
                                ? "bg-line text-ink"
                                : "text-muted hover:bg-line/50 hover:text-ink"
                            }`}
                          >
                            <button
                              type="button"
                              title={tab.path}
                              onClick={() => props.onActivateTab(group.id, tab.path)}
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
                                props.onCloseTab(group.id, tab.path);
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
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-3 py-1.5 text-[11px] text-subtle">
                No open editors
              </div>
            )
          ) : null}
          {openEditorsExpanded && openEditorCount > 0 ? (
            <div
              data-testid="open-editors-resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize open editors"
              onPointerDown={(event) => {
                // Left button only — a right/middle press must never start a
                // resize (SidePanel hardening).
                if (event.button !== 0) return;
                // Drag starts from the rendered cap — from an oversized
                // saved cap the drag would otherwise have a huge dead zone
                // before anything visibly moves.
                openEditorsDrag.current = {
                  startY: event.clientY,
                  startHeight: openEditorsHeight,
                };
                openEditorsResize.begin(event.pointerId, openEditorsHeight);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = openEditorsDrag.current;
                if (drag === null || !openEditorsResize.isActive(event.pointerId)) {
                  return;
                }
                openEditorsResize.update(
                  event.pointerId,
                  clampOpenEditorsHeight(
                    drag.startHeight + event.clientY - drag.startY,
                  ),
                  event.buttons,
                );
              }}
              onPointerUp={(event) => openEditorsResize.commit(event.pointerId)}
              onPointerCancel={(event) =>
                openEditorsResize.commit(event.pointerId)
              }
              onLostPointerCapture={(event) =>
                openEditorsResize.commit(event.pointerId)
              }
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
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left dohc-section-label group-hover:text-muted"
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
                  <SectionLabel as="header" className="flex h-6 items-center gap-1.5 px-3">
                    <Pin size={10} aria-hidden />
                    Pinned
                  </SectionLabel>
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
                          <span className="truncate">{basenameOf(path)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {empty ? (
                <button
                  type="button"
                  onClick={() => beginCreate("file", "")}
                  className="mx-3 mt-2 flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
                >
                  <FilePlus2 size={13} aria-hidden />
                  Create your first file
                </button>
              ) : (
                <ul
                  ref={workspaceTreeRef}
                  role="tree"
                  aria-label="Workspace files"
                  className="m-0 list-none p-0"
                >
                  {renderedRows}
                </ul>
              )}
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
                    ? basenameOf(confirmDelete[0]!)
                    : `${confirmDelete.length} items`}
                </span>
                ?
              </p>
              <p className="mb-0 mt-2 text-xs text-muted">
                {props.shareView
                  ? `${confirmDelete.length === 1 ? "It goes" : "They go"} from your copy now. There is no trash to restore ${
                      confirmDelete.length === 1 ? "it" : "them"
                    } from. ${
                      props.shareView.granterEmail ?? "The person who shared it"
                    } still ${confirmDelete.length === 1 ? "has it" : "has them"} until you send the change and they accept it. You can take the change back before then.`
                  : `${confirmDelete.length === 1 ? "It moves" : "They move"} to the system trash, or to this workspace's .dohc/trash folder whenever the system trash refuses, and can be restored from there.`}
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
});
