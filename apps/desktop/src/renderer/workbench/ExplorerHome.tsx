import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Pin, Plus } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SitePackageInfo, WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { hasPrimaryModifier } from "../../shortcuts/shortcutRegistry";
import { RetryRow } from "../ui/controls";
import { isContextMenuKey, isDeleteKey } from "../ui/keys";
import { Menu, type MenuItem } from "../ui/Menu";
import { SkeletonRows } from "../ui/SkeletonRows";
import { AppMarks } from "./AppsSection";
import { CollectionsElsewhereRow, CollectionsRefusalRow, RANGE_KEYS, rangeBetween, type ExplorerProps, type RowDropPreview } from "./Explorer";
import {
  classifyFiles,
  collectionRows,
  fileRows,
  pageRows,
  pageTree,
  pinnedRows,
  FILES_SHOWN,
  type HomeLookup,
  type HomeRowModel,
  type HomeSectionId,
} from "./explorerHomeModel";
import { navigateTree, type FlatRow } from "./file-tree-nav";
import { NOT_VERSIONED, NOT_VERSIONED_TITLE, useNotVersionedMark } from "./notVersionedMarks";
import { TabGlyph } from "./tabGlyph";
import { parseTab, siteTabPath } from "./workbenchState";

// Home: the workspace by kind, as one keyboard list. Arrows move through
// every section, Left and Right fold a section or a folder, and Enter opens.
// Each row's menu is the Files menu for the same file or folder, so a
// rename, move or delete here is the same change Files makes. Rows select as
// Files' rows do, by their workspace path, so a page pinned and in Pages is
// one selected path.

const ROW_HEIGHT = 28;
const GLYPH_SIZE = 14;
const VIRTUALIZE_ABOVE = 200;
const OVERSCAN = 12;

export interface ExplorerHomeProps {
  explorer: ExplorerProps;
  // The listing with the Explorer's moves in flight already applied.
  files: readonly WorkspaceFileEntry[];
  fileByPath: ReadonlyMap<string, WorkspaceFileEntry>;
  folders: ReadonlySet<string>;
  activePath: string | null;
  scrollerRef: RefObject<HTMLElement | null>;
  // Changes whenever the Open editors section above Home changes height, so
  // the Pages window is measured again.
  aboveLayout: string;
  // The file or folder the Explorer is renaming, and its name field.
  editingPath: string | null;
  renderEditRow: (depth: number) => ReactNode;
  // The Explorer's selection: workspace paths.
  selection: ReadonlySet<string>;
  onSelect: (paths: ReadonlySet<string>) => void;
  // Opens the row's menu at the pointer.
  onMenu: (kind: "file" | "folder", path: string, at: { x: number; y: number }) => void;
  onRename: (path: string, isFolder: boolean) => void;
  onDelete: (paths: string[]) => void;
  // Switches to Files, with this path selected when it has one.
  onShowInFiles: (paths: readonly string[] | null) => void;
  drag: {
    start: (path: string, event: DragEvent) => void;
    over: (path: string, event: DragEvent) => void;
    drop: (path: string, event: DragEvent) => void;
    leave: () => void;
    end: () => void;
  };
  // How a drag over this path would land, while one is in progress.
  dropPreviewFor: (path: string) => RowDropPreview | null;
}

type Section = {
  id: HomeSectionId;
  label: string;
  count?: number;
  countLabel?: (count: number) => string;
  // More can load, so the count shows how many have loaded so far, with a "+".
  countMore?: boolean;
  rows: HomeRowModel[];
  // A last row that is not a file, such as Show all in Files.
  more?: { key: string; label: string; testId: string; onActivate: () => void };
  add?: { label: string; onClick: () => void };
  // The section's own actions, in a ⋯ beside its +.
  actions?: MenuItem[];
  // What the section shows before or after its rows.
  body?: ReactNode;
  after?: ReactNode;
  // The muted line a section with nothing in it shows under its header. It
  // is no stop in the keyboard list; the header's toggle reads it.
  empty?: string;
};

type NavItem = { sectionId: HomeSectionId; row?: HomeRowModel; more?: true };

const SECTION_TEST_IDS: Record<HomeSectionId, string> = {
  pinned: "explorer-pinned",
  pages: "explorer-pages",
  sketches: "explorer-sketches",
  collections: "explorer-collections",
  apps: "explorer-apps",
  other: "explorer-other-files",
};

const HEADER_BUTTON = "grid size-6 shrink-0 place-items-center rounded text-subtle group-hover:text-muted hover:bg-hover hover:text-ink";

function SectionActions(props: { label: string; testId: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label={props.label}
      items={props.items}
      open={open}
      onOpenChange={setOpen}
      width={248}
      trigger={(trigger) => (
        <button {...trigger} type="button" data-testid={props.testId} aria-label={props.label} title={props.label} className={HEADER_BUTTON}>
          <MoreHorizontal size={13} aria-hidden />
        </button>
      )}
    />
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ExplorerHome(props: ExplorerHomeProps) {
  const { explorer, files, fileByPath, folders, activePath, scrollerRef } = props;
  const apps = explorer.apps;
  const appList = useMemo<readonly SitePackageInfo[]>(
    () => (apps?.state.status === "ready" ? apps.state.apps : []),
    [apps?.state],
  );
  const appTitles = useMemo(() => new Map(appList.map((app) => [app.root, app.title])), [appList]);
  const appByRoot = useMemo(() => new Map(appList.map((app) => [app.root, app])), [appList]);
  const expanded = useMemo(() => new Set(explorer.expandedFolders), [explorer.expandedFolders]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<HomeSectionId>>(new Set());
  const idBase = useId();

  const noFolders = useMemo(() => new Set<string>(), []);
  const kinds = useMemo(
    () => classifyFiles(files, explorer.collectionFolders, explorer.appFolders ?? noFolders, explorer.unclaimedDatasetFolders ?? noFolders),
    [files, explorer.collectionFolders, explorer.appFolders, explorer.unclaimedDatasetFolders, noFolders],
  );
  const tree = useMemo(() => pageTree(kinds.pages), [kinds.pages]);
  const pages = useMemo(() => pageRows(tree, expanded), [tree, expanded]);
  const sketches = useMemo(() => fileRows("sketches", kinds.sketches.shown, fileByPath), [kinds.sketches, fileByPath]);
  const others = useMemo(() => fileRows("other", kinds.others.shown, fileByPath), [kinds.others, fileByPath]);
  const dataCollections = explorer.dataCollections;
  const lookup = useMemo<HomeLookup>(
    () => ({
      files: fileByPath,
      folders,
      collectionFolders: explorer.collectionFolders,
      apps: appTitles,
      dataCollections: dataCollections ?? [],
    }),
    [appTitles, dataCollections, explorer.collectionFolders, fileByPath, folders],
  );
  const pinnedApps = apps?.pinnedApps;
  const pinned = useMemo(
    () => pinnedRows(pinnedApps ?? [], explorer.pinned, lookup),
    [explorer.pinned, lookup, pinnedApps],
  );
  const collections = useMemo(
    () => collectionRows(dataCollections ?? [], explorer.collectionFolders),
    [dataCollections, explorer.collectionFolders],
  );
  const appRows = useMemo<HomeRowModel[]>(
    () =>
      appList.map((app) => ({
        key: `apps:${app.root}`, section: "apps", parentKey: "apps", depth: 1, label: app.title,
        glyph: { glyph: "app", icon: undefined }, open: siteTabPath(app.root),
        menu: { path: app.root, kind: "folder" }, folder: false, expanded: false,
      })),
    [appList],
  );

  const refusal = explorer.collectionsRefusal ?? null;
  const showCollections =
    collections.length > 0 ||
    !!explorer.onIncludeArchivedCollections ||
    !!explorer.onRestoreCollection ||
    !!refusal ||
    !!explorer.collectionsElsewhere;
  // Pages, Collections and Apps always show in a workspace of your own, each
  // saying when it has nothing. A share view shows only the kinds it holds.
  const appsStatus = apps?.state.status;
  const appsShown = appsStatus === "failed" || appList.length > 0 || (!!apps && !explorer.shareView);
  const collectionActions: MenuItem[] = [];
  if (!refusal && explorer.onIncludeArchivedCollections) {
    const archived = explorer.includeArchivedCollections ?? false;
    collectionActions.push({
      id: "archived",
      label: "Show archived Collections",
      checked: archived,
      testId: "collections-show-archived",
      onSelect: () => explorer.onIncludeArchivedCollections?.(!archived),
    });
  }
  if (!refusal && explorer.onRestoreCollection && !explorer.shareView && !explorer.collectionsElsewhere) {
    collectionActions.push({ id: "restore", label: "Restore from recovery file…", testId: "collections-restore", onSelect: explorer.onRestoreCollection });
  }

  // A read on its way holds one row's height and says nothing, so the
  // sections under it stay put and no section claims to be empty too soon.
  const holdRow = <div aria-hidden className="h-7" />;
  const collectionsUnknown = refusal ? undefined : explorer.collectionsUnknown;
  const sections: Section[] = [];
  if (pinned.length > 0) sections.push({ id: "pinned", label: "Pinned", rows: pinned });
  if (pages.length > 0 || !explorer.shareView) {
    sections.push({
      id: "pages",
      label: "Pages",
      count: kinds.pages.length,
      countLabel: (count) => plural(count, "page", "pages"),
      rows: pages,
      add: { label: "New page", onClick: () => explorer.onNewPage("") },
      ...(pages.length === 0 ? { empty: "No pages yet." } : {}),
    });
  }
  if (sketches.length > 0) {
    sections.push({
      id: "sketches",
      label: "Sketches",
      count: kinds.sketches.count,
      countLabel: (count) => plural(count, "sketch", "sketches"),
      rows: sketches,
      ...(kinds.sketches.count > FILES_SHOWN
        ? { more: { key: "sketches:more", label: "Show all in Files", testId: "sketches-show-all", onActivate: () => props.onShowInFiles(null) } }
        : {}),
    });
  }
  if (showCollections) {
    const more = refusal ? undefined : explorer.onMoreDataCollections;
    sections.push({
      id: "collections",
      label: "Collections",
      count: refusal ? undefined : collections.length,
      countLabel: (count) => more ? `${count} or more Collections` : plural(count, "Collection", "Collections"),
      rows: refusal ? [] : collections,
      ...(more
        ? { countMore: true, more: { key: "collections:more", label: "Show more Collections", testId: "collections-more", onActivate: more } }
        : {}),
      ...(explorer.shareView ? {} : { add: { label: "New Collection", onClick: () => explorer.onNewCollection("") } }),
      ...(collectionActions.length > 0 ? { actions: collectionActions } : {}),
      body: refusal ? (
        <CollectionsRefusalRow refusal={refusal} onKeep={explorer.onKeepCollections} onRetry={explorer.onRetryCollections} />
      ) : collectionsUnknown === "failed" && explorer.onRetryCollections ? (
        <RetryRow testId="collections-failed" onRetry={explorer.onRetryCollections} />
      ) : collectionsUnknown ? holdRow : undefined,
      after: !refusal && explorer.collectionsElsewhere ? (
        <CollectionsElsewhereRow elsewhere={explorer.collectionsElsewhere} onKeep={explorer.onKeepCollections} />
      ) : undefined,
      ...(!refusal && !collectionsUnknown && !explorer.collectionsElsewhere && !explorer.onMoreDataCollections && collections.length === 0
        ? { empty: "No Collections yet." }
        : {}),
    });
  }
  if (appsShown) {
    sections.push({
      id: "apps",
      label: "Apps",
      count: appList.length,
      countLabel: (count) => plural(count, "app", "apps"),
      rows: appRows,
      ...(apps?.state.status === "failed" ? { body: <RetryRow testId="sites-failed" onRetry={apps.retry} /> } : {}),
      ...(appsStatus === "loading" ? { body: holdRow } : {}),
      ...(appsStatus === "ready" && appList.length === 0
        ? { empty: "No apps yet." }
        : {}),
    });
  }
  if (others.length > 0) {
    sections.push({
      id: "other",
      label: "Other files",
      count: kinds.others.count,
      countLabel: (count) => plural(count, "file", "files"),
      rows: others,
      ...(kinds.others.count > FILES_SHOWN
        ? { more: { key: "other:more", label: "Show all in Files", testId: "other-files-show-all", onActivate: () => props.onShowInFiles(null) } }
        : {}),
    });
  }

  // ---- one keyboard list over every section ----

  // Which sections are drawn, with their rows; the sections themselves are
  // rebuilt each render, so the list follows this key.
  const sectionsKey = sections.map((section) => `${section.id}${section.more ? "+" : ""}`).join(" ");
  const nav = useMemo(() => {
    const rows: FlatRow[] = [];
    const items = new Map<string, NavItem>();
    for (const section of sections) {
      const sectionKey = `section:${section.id}`;
      const open = !collapsed.has(section.id);
      rows.push({ fullPath: sectionKey, isFolder: true, isExpanded: open, depth: 0, parentPath: null });
      items.set(sectionKey, { sectionId: section.id });
      if (!open) continue;
      for (const row of section.rows) {
        rows.push({
          fullPath: row.key,
          isFolder: row.folder,
          isExpanded: row.expanded,
          depth: row.depth,
          parentPath: row.parentKey === section.id ? sectionKey : row.parentKey,
        });
        items.set(row.key, { sectionId: section.id, row });
      }
      if (section.more) {
        rows.push({ fullPath: section.more.key, isFolder: false, isExpanded: false, depth: 1, parentPath: sectionKey });
        items.set(section.more.key, { sectionId: section.id, more: true });
      }
    }
    return { rows, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, pages, sketches, collections, appRows, others, collapsed, sectionsKey]);

  // The workspace path of the row the active editor shows. An app or a
  // Collection opens a tab under another path, so Home looks its row up.
  const openRowPath = useMemo(() => {
    if (activePath === null) return null;
    for (const section of sections) {
      for (const row of section.rows) if (row.open === activePath && row.menu) return row.menu.path;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, pages, sketches, collections, appRows, others, sectionsKey, activePath]);

  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const selectedNoteId = useId();
  const tabbableKey = focusedKey && nav.items.has(focusedKey) ? focusedKey : (nav.rows[0]?.fullPath ?? null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const registerRef = useCallback((key: string, element: HTMLElement | null) => {
    if (element) rowRefs.current.set(key, element);
    else rowRefs.current.delete(key);
  }, []);

  // Pages is the one section with no bound, so only its rows are windowed.
  const pagesListRef = useRef<HTMLUListElement>(null);
  const pagesIndex = useMemo(() => new Map(pages.map((row, index) => [row.key, index])), [pages]);
  const windowed = pages.length > VIRTUALIZE_ABOVE && !collapsed.has("pages");
  const [range, setRange] = useState({ start: 0, end: VIRTUALIZE_ABOVE });
  const updateRange = useCallback(() => {
    if (!windowed) return;
    const scroller = scrollerRef.current;
    const list = pagesListRef.current;
    if (!scroller || !list) return;
    const top = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-top / ROW_HEIGHT));
    const visible = Math.ceil(scroller.clientHeight / ROW_HEIGHT);
    const next = {
      start: Math.max(0, Math.min(first, pages.length) - OVERSCAN),
      end: Math.min(pages.length, first + visible + OVERSCAN),
    };
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next));
  }, [pages.length, scrollerRef, windowed]);
  useLayoutEffect(updateRange, [updateRange, sectionsKey, collapsed, props.aboveLayout]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !windowed) return;
    scroller.addEventListener("scroll", updateRange, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateRange);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", updateRange);
      observer?.disconnect();
    };
  }, [scrollerRef, updateRange, windowed]);

  const focusKey = useCallback(
    (key: string) => {
      setFocusedKey(key);
      const element = rowRefs.current.get(key);
      if (element) {
        pendingFocus.current = null;
        element.focus();
        return;
      }
      pendingFocus.current = key;
      const index = pagesIndex.get(key);
      if (index !== undefined) {
        const start = Math.max(0, index - VIRTUALIZE_ABOVE / 2);
        setRange({ start, end: Math.min(pages.length, start + VIRTUALIZE_ABOVE) });
      }
    },
    [pages.length, pagesIndex],
  );
  // A row that was not mounted takes focus once it renders.
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const element = rowRefs.current.get(key);
    if (!element) return;
    pendingFocus.current = null;
    element.focus();
  });

  const toggleSection = useCallback((id: HomeSectionId, open?: boolean) => {
    setCollapsed((current) => {
      const isOpen = !current.has(id);
      if (open === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Where a Shift-click or Shift+arrow range starts: a row's key.
  const anchorKey = useRef<string | null>(null);
  // The workspace paths of the rows from one key to another, in order.
  const pathsBetween = (from: string, to: string): Set<string> => {
    const keys = rangeBetween(nav.rows.map((row) => row.fullPath), from, to) ?? [to];
    return new Set(keys.flatMap((key) => nav.items.get(key)?.row?.menu?.path ?? []));
  };

  // Rows keep one callback each across renders; they read the current props
  // through this ref.
  const live = useRef({ props, focusKey, pathsBetween });
  live.current = { props, focusKey, pathsBetween };

  // As in Files, a selection that is only the open row goes when another
  // editor becomes active. Files clears a file's own path; this also clears
  // the folder of an app or a Collection opened from its row.
  const shownOpenRow = useRef(openRowPath);
  useLayoutEffect(() => {
    const was = shownOpenRow.current;
    shownOpenRow.current = openRowPath;
    const { selection, onSelect } = live.current.props;
    if (was !== null && was !== openRowPath && selection.size === 1 && selection.has(was)) onSelect(new Set());
  }, [openRowPath]);

  const openRow = useCallback((row: HomeRowModel) => {
    const { explorer: current, onShowInFiles } = live.current.props;
    if (row.folder && row.menu) {
      current.onToggleFolder(row.menu.path);
      return;
    }
    if (row.open === null) {
      // A pinned folder that is no Collection or app opens in Files, and so do
      // the files to fix of a Collection that can't open.
      if (row.fix) onShowInFiles(row.fix);
      else if (row.menu) onShowInFiles([row.menu.path]);
      return;
    }
    const tab = parseTab(row.open);
    if (tab.kind === "collection" && tab.collectionPath !== null) current.onOpenCollection(tab.collectionPath);
    else if (tab.kind === "transactionalCollection") current.onOpenDataCollection?.(tab.datasetPath, tab.tableId);
    else current.onOpenFile(row.open);
  }, []);

  const onRowClick = useCallback(
    // With no event, as from a fix row's Show in Files, it is a plain click.
    (row: HomeRowModel, event?: MouseEvent) => {
      pendingFocus.current = null;
      setFocusedKey(row.key);
      const { props: current, pathsBetween: between } = live.current;
      const path = row.menu?.path;
      if (path !== undefined && event !== undefined && hasPrimaryModifier(event, window.dohcDesktop?.platform)) {
        const next = new Set(current.selection);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        current.onSelect(next);
        anchorKey.current = row.key;
        return;
      }
      if (path !== undefined && event?.shiftKey && anchorKey.current !== null) {
        current.onSelect(between(anchorKey.current, row.key));
        return;
      }
      current.onSelect(new Set(path !== undefined ? [path] : []));
      anchorKey.current = row.key;
      openRow(row);
    },
    [openRow],
  );
  const onChevronClick = useCallback((row: HomeRowModel, event: MouseEvent) => {
    event.stopPropagation();
    setFocusedKey(row.key);
    if (row.menu) live.current.props.explorer.onToggleFolder(row.menu.path);
  }, []);
  const onRowMenu = useCallback((row: HomeRowModel, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setFocusedKey(row.key);
    if (!row.menu) return;
    rowRefs.current.get(row.key)?.focus({ preventScroll: true });
    const current = live.current.props;
    // A row outside the selection is the selection while its menu acts.
    if (!current.selection.has(row.menu.path)) {
      current.onSelect(new Set([row.menu.path]));
      anchorKey.current = row.key;
    }
    current.onMenu(row.menu.kind, row.menu.path, { x: event.clientX, y: event.clientY });
  }, []);
  // A rename shows its name field in the row it started from, or else the
  // first row for that path.
  const editingPath = props.editingPath;
  const editKey = useMemo(() => {
    if (editingPath === null) return null;
    const started = focusedKey ? nav.items.get(focusedKey)?.row : undefined;
    if (started?.menu?.path === editingPath) return started.key;
    for (const [key, item] of nav.items) if (item.row?.menu?.path === editingPath) return key;
    return null;
    // The row it started from is the one focused when it began.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPath, nav]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (props.editingPath !== null) return;
    if (!(event.target as HTMLElement).closest("[data-home-key]")) return;
    const item = focusedKey ? nav.items.get(focusedKey) : undefined;
    const menu = item?.row?.menu;
    if (event.key === "Escape" && props.selection.size > 1) {
      event.preventDefault();
      event.stopPropagation();
      props.onSelect(new Set());
      return;
    }
    if (
      event.key.toLowerCase() === "a" &&
      hasPrimaryModifier(event, window.dohcDesktop?.platform) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      props.onSelect(new Set([...nav.items.values()].flatMap((entry) => entry.row?.menu?.path ?? [])));
      return;
    }
    if (menu && event.key === "F2") {
      event.preventDefault();
      props.onRename(menu.path, menu.kind === "folder");
      return;
    }
    // The selection, or the focused row alone when it is outside the
    // selection. From a heading, the selection.
    if (isDeleteKey(event) && (menu || props.selection.size > 0)) {
      event.preventDefault();
      props.onDelete(menu && !props.selection.has(menu.path) ? [menu.path] : [...props.selection]);
      return;
    }
    const action = navigateTree(nav.rows, focusedKey, event.key);
    if (!action) return;
    event.preventDefault();
    const acted = nav.items.get(action.path);
    if (!acted) return;
    const heading = !acted.row && !acted.more;
    switch (action.kind) {
      case "focus":
        if (event.shiftKey && RANGE_KEYS.has(event.key)) {
          const kept = anchorKey.current;
          const from = kept !== null && nav.items.has(kept) ? kept : (focusedKey ?? action.path);
          anchorKey.current = from;
          props.onSelect(pathsBetween(from, action.path));
        }
        focusKey(action.path);
        break;
      case "expand":
      case "collapse":
        if (heading) toggleSection(acted.sectionId, action.kind === "expand");
        else if (acted.row?.menu) explorer.onSetFolderExpanded(acted.row.menu.path, action.kind === "expand");
        break;
      case "toggle":
        if (heading) toggleSection(acted.sectionId);
        else if (acted.row) openRow(acted.row);
        break;
      case "open":
        if (acted.more) sections.find((section) => section.id === acted.sectionId)?.more?.onActivate();
        else if (acted.row) openRow(acted.row);
        break;
    }
  };

  // Add an app here… lands on the first app.
  const appsReveal = apps?.reveal ?? false;
  const onAppsRevealed = apps?.onRevealed;
  const appsSettled = apps ? apps.state.status !== "loading" : true;
  const firstAppKey = appRows[0]?.key ?? null;
  useEffect(() => {
    if (!appsReveal || !appsSettled) return;
    if (!appsShown) {
      onAppsRevealed?.();
      return;
    }
    if (collapsed.has("apps")) {
      toggleSection("apps", true);
      return;
    }
    live.current.focusKey(firstAppKey ?? "section:apps");
    onAppsRevealed?.();
  }, [appsReveal, appsSettled, appsShown, collapsed, firstAppKey, onAppsRevealed, toggleSection]);

  if (!explorer.listed) {
    return <SkeletonRows layout="list" className="mt-4 px-3 py-2" label="Loading files..." />;
  }

  // As in Files, the rows of a selection that is not just the open row take
  // the picked fill.
  const selectionIsOpenRow = openRowPath !== null && props.selection.size === 1 && props.selection.has(openRowPath);
  const renderRow = (row: HomeRowModel): ReactNode => {
    if (editKey === row.key) return props.renderEditRow(row.depth - 1);
    const common = {
      row,
      picked: !selectionIsOpenRow && row.menu !== null && props.selection.has(row.menu.path),
      selectedNoteId,
      active: row.open !== null && row.open === activePath,
      tabbable: tabbableKey === row.key,
      registerRef,
      onFocus: setFocusedKey,
      onClick: onRowClick,
      onChevronClick,
      onContextMenu: onRowMenu,
    };
    if (row.section === "apps") {
      const app = appByRoot.get(row.menu!.path)!;
      return (
        <HomeRow
          key={row.key}
          {...common}
          testId="sites-row"
          app={app}
          pinned={pinnedApps?.includes(app.root) ?? false}
          onSetPinned={apps?.onSetPinned}
        />
      );
    }
    if (row.section === "pages") {
      const preview = props.dropPreviewFor(row.menu!.path);
      return (
        <HomeRow key={row.key} {...common} chevronSlot dropKind={preview?.kind} dropRole={preview?.role} drag={props.drag} />
      );
    }
    return <HomeRow key={row.key} {...common} />;
  };

  const renderPages = (rows: HomeRowModel[]): ReactNode[] => {
    if (!windowed) return rows.map(renderRow);
    const mounted = new Set<number>();
    for (let index = range.start; index < Math.min(range.end, rows.length); index += 1) mounted.add(index);
    // The row that holds the tab stop or the name field stays mounted.
    for (const key of [tabbableKey, editKey]) {
      const index = key ? pagesIndex.get(key) : undefined;
      if (index !== undefined) mounted.add(index);
    }
    const out: ReactNode[] = [];
    let next = 0;
    for (const index of [...mounted].sort((a, b) => a - b)) {
      if (index > next) out.push(<li key={`space-${next}`} role="none" aria-hidden style={{ height: (index - next) * ROW_HEIGHT }} />);
      out.push(renderRow(rows[index]!));
      next = index + 1;
    }
    if (next < rows.length) out.push(<li key={`space-${next}`} role="none" aria-hidden style={{ height: (rows.length - next) * ROW_HEIGHT }} />);
    return out;
  };

  return (
    <div data-testid="explorer-home" onKeyDown={onKeyDown} className="mt-4 flex flex-col">
      {sections.map((section) => {
        const open = !collapsed.has(section.id);
        const sectionKey = `section:${section.id}`;
        const testId = SECTION_TEST_IDS[section.id];
        const emptyId = open && section.empty ? `${idBase}${section.id}-empty` : undefined;
        return (
          <section
            key={section.id}
            data-testid={section.id === "apps" ? "explorer-apps-section" : testId}
            aria-label={section.label}
            className="mt-4 first:mt-0"
          >
            <header data-testid={`${testId}-header`} className="group mx-1 flex h-6 items-center gap-1 rounded-md hover:bg-hover">
              <button
                type="button"
                ref={(element) => registerRef(sectionKey, element)}
                data-home-key={sectionKey}
                data-testid={`${testId}-toggle`}
                aria-expanded={open}
                aria-describedby={emptyId}
                tabIndex={tabbableKey === sectionKey ? 0 : -1}
                onFocus={() => setFocusedKey(sectionKey)}
                onClick={() => {
                  setFocusedKey(sectionKey);
                  toggleSection(section.id);
                }}
                className="dohc-focus-row flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left dohc-section-label group-hover:text-muted"
              >
                <span className="min-w-0 truncate">{section.label}</span>
                {section.count ? (
                  <span
                    data-testid={section.id === "apps" ? "sites-count" : undefined}
                    aria-label={section.countLabel?.(section.count)}
                    className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] leading-none text-subtle"
                  >
                    {section.count}{section.countMore ? "+" : null}
                  </span>
                ) : null}
                <ChevronRight size={11} aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
              </button>
              {section.actions ? (
                <SectionActions label={`${section.label} actions`} testId={`${testId}-actions`} items={section.actions} />
              ) : null}
              {section.add ? (
                <button
                  type="button"
                  data-testid={`${testId}-add`}
                  aria-label={section.add.label}
                  title={section.add.label}
                  onClick={section.add.onClick}
                  className={HEADER_BUTTON}
                >
                  <Plus size={13} aria-hidden />
                </button>
              ) : null}
            </header>
            {open ? (
              <>
                {section.body ? <div className="px-1">{section.body}</div> : null}
                {emptyId ? (
                  <p id={emptyId} data-testid={`${testId}-empty`} className="m-0 px-3 py-1.5 text-[12px] leading-4 text-muted">
                    {section.empty}
                  </p>
                ) : null}
                {section.rows.length > 0 || section.more ? (
                  <ul
                    ref={section.id === "pages" ? pagesListRef : undefined}
                    aria-label={section.label}
                    className="m-0 list-none p-0"
                  >
                    {section.id === "pages" ? renderPages(section.rows) : section.rows.map(renderRow)}
                    {section.more ? (
                      <li className="px-1">
                        <button
                          type="button"
                          ref={(element) => registerRef(section.more!.key, element)}
                          data-home-key={section.more.key}
                          data-testid={section.more.testId}
                          tabIndex={tabbableKey === section.more.key ? 0 : -1}
                          onFocus={() => setFocusedKey(section.more!.key)}
                          onClick={section.more.onActivate}
                          className="dohc-focus-row flex h-7 w-full items-center rounded-md px-2 text-left text-[12px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
                        >
                          {section.more.label}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                {section.after ? <div className="flex flex-col items-stretch px-1">{section.after}</div> : null}
              </>
            ) : null}
          </section>
        );
      })}
      {/* Describes a selected row, whose fill alone shows it to the eye. */}
      <span id={selectedNoteId} hidden>
        Selected
      </span>
    </div>
  );
}

function HomeGlyph({ row, tone }: { row: HomeRowModel; tone: string }) {
  if (row.glyph.glyph === "folder") {
    const Glyph = row.glyph.open ? FolderOpen : Folder;
    return <Glyph size={GLYPH_SIZE} aria-hidden className={`shrink-0 ${tone}`} />;
  }
  return <TabGlyph glyph={row.glyph.glyph} icon={row.glyph.icon} size={GLYPH_SIZE} className={tone} />;
}

// One Home row: its mark and name, then on hover or keyboard focus its pin
// and menu. Primitives and stable callbacks, so a focus change re-renders
// only the rows it touches. The pin and menu mount on the row's first hover
// or focus, which keeps a long Home's first paint to the rows themselves.
const HomeRow = memo(function HomeRow(props: {
  row: HomeRowModel;
  // In a selection an action would act on that is not just the open row.
  picked: boolean;
  // The hidden "Selected" that describes a picked row.
  selectedNoteId: string;
  active: boolean;
  tabbable: boolean;
  testId?: string;
  // An Apps row: the app's marks and its pin.
  app?: SitePackageInfo;
  pinned?: boolean;
  onSetPinned?: (appRoot: string, pinned: boolean) => void;
  chevronSlot?: boolean;
  dropKind?: RowDropPreview["kind"];
  dropRole?: RowDropPreview["role"];
  drag?: ExplorerHomeProps["drag"];
  registerRef: (key: string, element: HTMLElement | null) => void;
  onFocus: (key: string) => void;
  onClick: (row: HomeRowModel, event?: MouseEvent) => void;
  onChevronClick: (row: HomeRowModel, event: MouseEvent) => void;
  onContextMenu: (row: HomeRowModel, event: MouseEvent) => void;
}) {
  const { row, active, picked, app, drag } = props;
  const path = row.menu?.path;
  const onSetPinned = app ? props.onSetPinned : undefined;
  const pinned = props.pinned ?? false;
  const pinLabel = pinned ? "Unpin" : "Pin to sidebar";
  // As in Files, a file the active version does not track is dimmed and says so.
  const notVersioned = useNotVersionedMark(path ?? "", row.menu?.kind === "file");
  const fill = props.dropKind
    ? props.dropKind === "blocked"
      ? "bg-danger/10 text-danger"
      : props.dropRole === "target"
        ? "bg-success/16 text-ink"
        : "bg-line/35 text-ink"
    : picked
      ? `bg-(--dohc-selection) text-ink${active ? " font-medium" : ""}`
      : active
        ? "bg-selected font-medium text-ink"
        : notVersioned
          ? "text-subtle hover:bg-hover hover:text-muted"
          : "text-muted hover:bg-hover hover:text-ink";
  // An allowed drop target's glyph takes the success color.
  const glyphTone =
    props.dropKind && props.dropKind !== "blocked" && props.dropRole === "target"
      ? "text-success"
      : active || picked
        ? "text-ink"
        : "text-subtle";
  const trailing = (onSetPinned ? 1 : 0) + (row.menu || row.fix ? 1 : 0);
  const [reached, setReached] = useState(false);
  // How the menu of a Collection that can't open was opened, while it is open.
  const [fixMenu, setFixMenu] = useState<"pointer" | "keyboard" | null>(null);
  const rowButton = useRef<HTMLButtonElement | null>(null);
  const rowBox = useRef<HTMLDivElement | null>(null);
  const dragPath = drag && path ? path : null;
  // A cause takes its own line under the name, so the name never gives way to
  // it. The first line keeps the row's 28px, so the mark and ••• stay on it.
  const cause = row.unavailable ? row.detail : undefined;
  return (
    <li role="none" className="px-1">
      <div
        ref={rowBox}
        onPointerEnter={reached ? undefined : () => setReached(true)}
        className={`group relative flex items-center rounded-md transition-colors duration-75 ${cause ? "" : "h-7"} ${fill}`}
      >
        {/* As in Files, the open row in a picked selection gains a 2px ink edge. */}
        {!props.dropKind && picked && active ? (
          <span
            aria-hidden
            data-testid="home-row-open-edge"
            className="absolute bottom-1.5 left-0.5 top-1.5 w-0.5 rounded-full bg-ink"
          />
        ) : null}
        <button
          type="button"
          ref={(element) => {
            rowButton.current = element;
            props.registerRef(row.key, element);
          }}
          data-home-key={row.key}
          data-testid={props.testId ?? "home-row"}
          data-path={path}
          data-menu-kind={row.menu?.kind}
          // The Explorer leaves the Menu key and Shift+F10 to a row with its own menu.
          data-own-menu={row.fix ? "" : undefined}
          data-root={app?.root}
          data-section={row.section}
          aria-current={active ? "page" : undefined}
          aria-describedby={picked ? props.selectedNoteId : undefined}
          {...(row.folder ? { "aria-expanded": row.expanded } : {})}
          title={row.unavailable ?? (app ? app.root : notVersioned ? `${path}\n${NOT_VERSIONED}. ${NOT_VERSIONED_TITLE}` : path)}
          data-not-versioned={notVersioned ? "true" : undefined}
          aria-disabled={row.unavailable && !row.fix ? true : undefined}
          tabIndex={props.tabbable ? 0 : -1}
          draggable={dragPath !== null ? true : undefined}
          onFocus={() => {
            setReached(true);
            props.onFocus(row.key);
          }}
          onClick={(event) => props.onClick(row, event)}
          onKeyDown={row.fix ? (event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            setReached(true);
            setFixMenu("keyboard");
          } : undefined}
          onContextMenu={(event) => {
            props.onContextMenu(row, event);
            if (!row.fix) return;
            setReached(true);
            // The browser's own event after the Menu key keeps the keyboard's open.
            setFixMenu((current) => current ?? "pointer");
          }}
          onDragStart={dragPath !== null ? (event) => drag!.start(dragPath, event) : undefined}
          onDragOver={dragPath !== null ? (event) => drag!.over(dragPath, event) : undefined}
          onDrop={dragPath !== null ? (event) => drag!.drop(dragPath, event) : undefined}
          onDragLeave={drag?.leave}
          onDragEnd={drag?.end}
          style={{ paddingLeft: 8 + (row.depth - 1) * 20, paddingRight: 8 + trailing * 24 }}
          className={`dohc-focus-row min-w-0 flex-1 items-center rounded-md text-left text-[13px] ${
            cause
              ? `grid grid-rows-[28px_auto] gap-x-2 pb-1 ${props.chevronSlot ? "grid-cols-[auto_auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)]"}`
              : "flex h-full gap-2"
          } ${active || picked ? "bg-transparent" : ""}`}
        >
          {props.chevronSlot ? (
            row.folder ? (
              <span onClick={(event) => props.onChevronClick(row, event)} className="grid shrink-0 place-items-center">
                <ChevronRight size={12} aria-hidden className={`text-subtle transition-transform ${row.expanded ? "rotate-90" : ""}`} />
              </span>
            ) : (
              <span aria-hidden className="w-3 shrink-0" />
            )
          ) : null}
          <HomeGlyph row={row} tone={notVersioned && !props.dropKind ? `${glyphTone} opacity-60` : glyphTone} />
          {/* The folder hint gives way before the name; the title holds the whole path.
              A row with a cause keeps its sentence as the row's title, so its name has its own. */}
          <span title={cause ? row.label : undefined} className="min-w-0 flex-auto truncate">{row.label}</span>
          {row.detail ? (
            <span className={`min-w-0 truncate text-[12px] ${cause ? "col-[-2/-1] row-start-2 -mt-1 leading-4 text-warning" : "shrink-[999] text-subtle"}`}>{row.detail}</span>
          ) : null}
          {notVersioned && !cause ? (
            <span data-testid="home-row-not-versioned" className="shrink-0 text-[11px] text-subtle">{NOT_VERSIONED}</span>
          ) : null}
          {app ? <AppMarks app={app} /> : null}
        </button>
        {trailing > 0 && (reached || pinned) ? (
          <span className="absolute right-1 top-0.5 flex items-center">
            {onSetPinned ? (
              <button
                type="button"
                data-testid="sites-pin"
                aria-label={pinLabel}
                title={pinLabel}
                tabIndex={-1}
                onClick={() => onSetPinned(app!.root, !pinned)}
                className={`grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink ${
                  pinned ? "" : "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
                }`}
              >
                <Pin size={13} aria-hidden className={pinned ? "text-ink" : undefined} />
              </button>
            ) : null}
            {row.menu && reached ? (
              <button
                type="button"
                data-testid="home-row-menu"
                aria-label={`More actions for ${row.label}`}
                title="More actions"
                tabIndex={-1}
                onClick={(event) => props.onContextMenu(row, event)}
                className="grid size-6 place-items-center rounded text-subtle opacity-0 hover:bg-hover hover:text-ink group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
              >
                <MoreHorizontal size={13} aria-hidden />
              </button>
            ) : null}
            {row.fix && reached ? (
              <Menu
                label={`More actions for ${row.label}`}
                items={[{ id: "show-in-files", label: "Show in Files", testId: "home-row-show-in-files", onSelect: () => props.onClick(row) }]}
                open={fixMenu !== null}
                fromKeyboard={fixMenu === "keyboard"}
                // Under the cause line, so the list never covers what it acts on.
                anchor={cause ? rowBox : undefined}
                // Focus goes back to the row, where Home's arrows and Enter work, not to the •••.
                onOpenChange={(open) => {
                  setFixMenu(open ? "pointer" : null);
                  if (!open) rowButton.current?.focus();
                }}
                trigger={(trigger) => (
                  <button
                    {...trigger}
                    type="button"
                    data-testid="home-row-menu"
                    aria-label={`More actions for ${row.label}`}
                    title="More actions"
                    tabIndex={-1}
                    className="grid size-6 place-items-center rounded text-subtle opacity-0 hover:bg-hover hover:text-ink aria-expanded:opacity-100 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
                  >
                    <MoreHorizontal size={13} aria-hidden />
                  </button>
                )}
              />
            ) : null}
          </span>
        ) : null}
      </div>
    </li>
  );
});
