// Pure workbench model: activity-bar view, side-panel visibility
// and width, open editor tabs, and the right-hand About rail. Pure like
// window/windowState.ts so every transition and the persistence round-trip
// are unit-tested without Electron. `dirty` is runtime-only (derived from the
// editor's save state) and never lives here or on disk.

import { basenameOf } from "../path";
import { parseDatasetPath } from "@dohc/security-contract/dataset";
import type { FileDisplayKind } from "@dohc/workspace-contracts/kinds";
import type { WorkspaceUiState } from "../../ipc/bridgeContract";
import type { SidebarSettings } from "../../settings/userSettings";
import type { ObjectKind } from "../ui/KindGlyph";

export const VIEW_IDS = [
  "explorer",
  "chats",
  "search",
  "graph",
  "history",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

// An app pinned to the sidebar, named by its folder, percent-encoded like
// every path in a view or tab id.
export const APP_VIEW_ID_PREFIX = "app-view:";
export type AppViewId = `${typeof APP_VIEW_ID_PREFIX}${string}`;
// Sharing sits at the foot of the rail, so the person cannot hide or reorder it.
export const SHARING_VIEW_ID = "sharing";
export type ActivityViewId = ViewId | AppViewId | typeof SHARING_VIEW_ID;

export function appViewId(appRoot: string): AppViewId {
  return `${APP_VIEW_ID_PREFIX}${encodeURIComponent(appRoot)}`;
}

export function parseAppViewId(value: string): string | null {
  if (!value.startsWith(APP_VIEW_ID_PREFIX)) return null;
  try {
    const appRoot = decodeURIComponent(value.slice(APP_VIEW_ID_PREFIX.length));
    return appRoot.length > 0 ? appRoot : null;
  } catch {
    return null;
  }
}

/** dohc's own views the sidebar shows, in the person's order. */
export function sidebarViews(
  sidebar: Pick<SidebarSettings, "order" | "hidden">,
): ViewId[] {
  return [...new Set([...sidebar.order, ...VIEW_IDS])].filter(
    (view) => !sidebar.hidden.includes(view),
  );
}

export function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

function isActivityViewId(value: unknown): value is ActivityViewId {
  if (typeof value !== "string") return false;
  return (
    isViewId(value) ||
    value === SHARING_VIEW_ID ||
    parseAppViewId(value) !== null
  );
}

/**
 * Whether the sidebar shows the selected view. `rail` is every view the
 * sidebar shows, in its order.
 */
export function isActiveViewShown(
  activeView: ActivityViewId,
  rail: readonly ActivityViewId[],
): boolean {
  return rail.includes(activeView);
}

/**
 * Moves the selection off a view the person just took off the rail: one of
 * dohc's views they hid, or an app they unpinned. The first view on the rail
 * takes its place, and with none the side panel closes. A view that a link or
 * command opens stays open even when the rail hides it; only a change to the
 * rail runs this.
 */
export function keepActiveViewShown(
  state: WorkbenchState,
  rail: readonly ActivityViewId[],
): WorkbenchState {
  if (isActiveViewShown(state.activeView, rail)) return state;
  const [first] = rail;
  if (first !== undefined) return { ...state, activeView: first };
  return state.sidebarVisible ? { ...state, sidebarVisible: false } : state;
}

/**
 * Moves the selection only when the rail change removed the selected entry
 * itself: the person hid the selected view or unpinned the selected app.
 * Hiding another view, reordering, or pinning leaves it alone, and so does a
 * change while a view the rail never showed is open.
 */
export function keepActiveViewAfterRailChange(
  state: WorkbenchState,
  previousRail: readonly ActivityViewId[],
  rail: readonly ActivityViewId[],
): WorkbenchState {
  return previousRail.includes(state.activeView) && !rail.includes(state.activeView)
    ? keepActiveViewShown(state, rail)
    : state;
}

/**
 * Opens or closes the side panel. Opening shows the selected view when the
 * rail shows it, and otherwise the first view on the rail; with an empty
 * rail nothing opens.
 */
export function toggleSidebarOnRail(
  state: WorkbenchState,
  rail: readonly ActivityViewId[],
): WorkbenchState {
  if (state.sidebarVisible) return { ...state, sidebarVisible: false };
  const opened = keepActiveViewShown({ ...state, sidebarVisible: true }, rail);
  return opened.sidebarVisible ? opened : state;
}
// Reserved for dohc's own tabs. A workspace file path is never spelled this
// way, so a persisted tab carrying it is always one of the kinds below.
const INTERNAL_TAB_SCHEME = "tab://";
const V2_TAB_SCHEME = "dohc://";
export const GRAPH_TAB_PATH = "tab://graph";
export const HISTORY_TAB_PATH = "tab://history";
// Home and each conversation have their own workspace-scoped tab identity.
export const CHATS_TAB_PATH = "tab://chats";
const APP_TAB_PREFIX = "tab://app/";
const VERSION_COMPARE_TAB_PREFIX = "tab://versions/compare/";
// Engine moment diff (PR 0M-5): history diffs open by MOMENT id, not
// legacy change-set id. The id alone is the tab identity: it
// is contract-bounded, while a percent-encoded valid workspace path can
// exceed the UI-state path bound. The moment record supplies its display path.
const MOMENT_DIFF_TAB_PREFIX = "tab://moment-diff/";
// A collection folder opened as its views (Phase 2 collections). Keyed by
// the folder path, so reopening re-activates instead of duplicating.
const COLLECTION_TAB_PREFIX = "tab://collection/";
const DATA_COLLECTION_TAB_PREFIX = "tab://data-collection/";
// A page whose file does not exist yet: its title has focus and nothing is on
// disk until the person leaves the title. The id tells two new pages apart;
// the folder is where its file will go. It never restores.
const NEW_PAGE_TAB_PREFIX = "tab://new-page/";

export function newPageTabPath(id: string, folder: string): string {
  return `${NEW_PAGE_TAB_PREFIX}${encodeURIComponent(id)}/${encodeURIComponent(folder)}`;
}

export function transactionalCollectionTabPath(datasetPath: string, tableId: string): string {
  return `${DATA_COLLECTION_TAB_PREFIX}${encodeURIComponent(datasetPath)}/${encodeURIComponent(tableId)}`;
}

export function collectionTabPath(collectionPath: string): string {
  return `${COLLECTION_TAB_PREFIX}${encodeURIComponent(collectionPath)}`;
}

export function momentDiffTabPath(momentId: string): string {
  return `${MOMENT_DIFF_TAB_PREFIX}${encodeURIComponent(momentId)}`;
}

export function siteTabPath(siteRoot: string): string {
  return `${APP_TAB_PREFIX}${encodeURIComponent(siteRoot)}`;
}

export type ChatTabTarget =
  | { kind: "home" }
  | { kind: "new" }
  | { kind: "channel" | "dm"; id: string };

export function chatTabPath(target: ChatTabTarget): string {
  if (target.kind === "home") return CHATS_TAB_PATH;
  if (target.kind === "new") return `${CHATS_TAB_PATH}/new`;
  return `${CHATS_TAB_PATH}/${target.kind}/${encodeURIComponent(target.id)}`;
}

// Versions compare page (PR 0M-4): one tab per compared version, keyed by
// the version id so re-comparing re-activates instead of duplicating.
export function versionCompareTabPath(versionId: string): string {
  return `${VERSION_COMPARE_TAB_PREFIX}${encodeURIComponent(versionId)}`;
}

// A navigation address carries no authority. Malformed recognized ids retain
// their kind so the existing closeable fallback can render; unknown schemes drop.
export type ParsedTab = { path: string } & (
  | { kind: "file" }
  | { kind: "removed" }
  | { kind: "graph" }
  | { kind: "history" }
  | { kind: "chat"; target: ChatTabTarget }
  | { kind: "site"; siteRoot: string | null }
  | { kind: "momentDiff"; momentId: string | null }
  | { kind: "versionCompare"; versionId: string | null }
  | { kind: "collection"; collectionPath: string | null }
  | { kind: "transactionalCollection"; datasetPath: string; tableId: string }
  | { kind: "newPage"; id: string; folder: string }
);
const TABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function decodedTabField(value: string): string | null {
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}
export function parseTab(path: string): ParsedTab;
export function parseTab(path: string | null): ParsedTab | null;
export function parseTab(path: string | null): ParsedTab | null {
  if (path === null) return null;
  if (!path.startsWith(INTERNAL_TAB_SCHEME)) {
    return { kind: path.startsWith(V2_TAB_SCHEME) ? "removed" : "file", path };
  }
  if (path === GRAPH_TAB_PATH) return { kind: "graph", path };
  if (path === HISTORY_TAB_PATH) return { kind: "history", path };
  if (path === CHATS_TAB_PATH) return { kind: "chat", path, target: { kind: "home" } };
  if (path === CHATS_TAB_PATH + "/new") return { kind: "chat", path, target: { kind: "new" } };
  if (path.startsWith(CHATS_TAB_PATH + "/")) {
    const parts = path.slice(CHATS_TAB_PATH.length + 1).split("/");
    const id = parts.length === 2 ? decodedTabField(parts[1]!) : null;
    if (id && (parts[0] === "channel" || parts[0] === "dm")) {
      return { kind: "chat", path, target: { kind: parts[0], id } };
    }
  }
  if (path.startsWith(APP_TAB_PREFIX)) return { kind: "site", path, siteRoot: decodedTabField(path.slice(APP_TAB_PREFIX.length)) };
  if (path.startsWith(MOMENT_DIFF_TAB_PREFIX)) return { kind: "momentDiff", path, momentId: decodedTabField(path.slice(MOMENT_DIFF_TAB_PREFIX.length)) };
  if (path.startsWith(VERSION_COMPARE_TAB_PREFIX)) return { kind: "versionCompare", path, versionId: decodedTabField(path.slice(VERSION_COMPARE_TAB_PREFIX.length)) };
  if (path.startsWith(COLLECTION_TAB_PREFIX)) return { kind: "collection", path, collectionPath: decodedTabField(path.slice(COLLECTION_TAB_PREFIX.length)) };
  if (path.startsWith(DATA_COLLECTION_TAB_PREFIX)) {
    const parts = path.slice(DATA_COLLECTION_TAB_PREFIX.length).split("/");
    if (parts.length === 2 && TABLE_ID.test(parts[1]!)) {
      try { return { kind: "transactionalCollection", path, datasetPath: parseDatasetPath(decodeURIComponent(parts[0]!)), tableId: parts[1]! }; } catch { /* Removed below. */ }
    }
  }
  if (path.startsWith(NEW_PAGE_TAB_PREFIX)) {
    const parts = path.slice(NEW_PAGE_TAB_PREFIX.length).split("/");
    const id = parts.length === 2 ? decodedTabField(parts[0]!) : null;
    // The workspace root is the empty folder.
    const folder = parts.length === 2 ? (parts[1] === "" ? "" : decodedTabField(parts[1]!)) : null;
    if (id !== null && folder !== null) return { kind: "newPage", path, id, folder };
  }
  return { kind: "removed", path };
}
export function tabPath(tab: ParsedTab): string {
  switch (tab.kind) {
    case "chat": return chatTabPath(tab.target);
    case "site": return tab.siteRoot === null ? tab.path : siteTabPath(tab.siteRoot);
    case "momentDiff": return tab.momentId === null ? tab.path : momentDiffTabPath(tab.momentId);
    case "versionCompare": return tab.versionId === null ? tab.path : versionCompareTabPath(tab.versionId);
    case "collection": return tab.collectionPath === null ? tab.path : collectionTabPath(tab.collectionPath);
    case "transactionalCollection": return transactionalCollectionTabPath(tab.datasetPath, tab.tableId);
    case "graph": return GRAPH_TAB_PATH;
    case "history": return HISTORY_TAB_PATH;
    case "file": case "removed": case "newPage": return tab.path;
  }
}
type TabTitle = (tab: ParsedTab, label?: string) => string;
// The object or file kind a tab shows, for its glyph. Null for a file, whose
// glyph comes from the listing: its kind and page icon.
type TabGlyphRule = (tab: ParsedTab) => ObjectKind | FileDisplayKind | null;
type TabRules = { virtual: boolean; singleton: boolean; title: TabTitle; tooltip: TabTitle; explorerTitle: TabTitle; glyph: TabGlyphRule };
const fileTitles = {
  title: (tab: ParsedTab) => basenameOf(tab.path),
  tooltip: (tab: ParsedTab) => tab.path,
  explorerTitle: (tab: ParsedTab) => basenameOf(tab.path),
};
const chatGlyph: TabGlyphRule =(tab) => tab.kind === "chat" && tab.target.kind === "channel" ? "group" : "chat";
const chatTitle: TabTitle = (tab, label) => {
  if (label !== undefined) return label;
  if (tab.kind !== "chat") return "Chat";
  return tab.target.kind === "home" ? "Home" : tab.target.kind === "new" ? "New message" : "Chat";
};
const diffTitle: TabTitle = (_tab, label) => {
  const name = label === undefined ? undefined : basenameOf(label);
  return name ? `Diff: ${name}` : "History change";
};
const collectionTitle: TabTitle = (_tab, label) => label ?? "Collection";
// The app's title once its page reads it, and until then its folder, as typed. A folder that cannot be decoded keeps
// its address. The tooltip names the folder.
const appTitle: TabTitle = (tab, label) => label ?? basenameOf(tab.kind === "site" && tab.siteRoot !== null ? tab.siteRoot : tab.path);
const collectionFolder = (tab: ParsedTab) => tab.kind === "collection" ? tab.collectionPath ?? "Collection" : "Collection";
export const TAB_KINDS: Record<ParsedTab["kind"], TabRules> = {
  file: {
    virtual: false,
    singleton: false,
    ...fileTitles,
    glyph: () => null,
  },
  removed: {
    virtual: false,
    singleton: false,
    ...fileTitles,
    glyph: () => null,
  },
  graph: {
    virtual: true,
    singleton: false,
    title: () => "Graph",
    tooltip: () => "Workspace graph",
    explorerTitle: () => "Graph",
    glyph: () => "graph",
  },
  history: {
    virtual: true,
    singleton: false,
    title: () => "History",
    tooltip: () => "Workspace history",
    explorerTitle: () => "History",
    glyph: () => "history",
  },
  chat: {
    virtual: true,
    singleton: true,
    title: chatTitle,
    tooltip: chatTitle,
    explorerTitle: chatTitle,
    glyph: chatGlyph,
  },
  site: {
    virtual: true,
    singleton: true,
    title: appTitle,
    tooltip: tab => tab.kind === "site" && tab.siteRoot !== null ? tab.siteRoot : tab.path,
    explorerTitle: appTitle,
    glyph: () => "app",
  },
  momentDiff: {
    virtual: true,
    singleton: false,
    title: diffTitle,
    tooltip: (_tab, label) => label ? `History diff: ${label}` : "History change",
    explorerTitle: diffTitle,
    glyph: () => "change",
  },
  versionCompare: {
    virtual: true,
    singleton: false,
    title: () => "Compare with Main",
    tooltip: () => "Compare this Version with Main",
    explorerTitle: () => "Compare with Main",
    glyph: () => "compare",
  },
  collection: {
    virtual: true,
    singleton: false,
    title: tab => basenameOf(collectionFolder(tab)),
    tooltip: collectionFolder,
    explorerTitle: tab => basenameOf(collectionFolder(tab)),
    glyph: () => "collection",
  },
  transactionalCollection: {
    virtual: true,
    singleton: false,
    title: collectionTitle,
    tooltip: (_tab, label) => label ? `Collection: ${label}` : "Collection",
    explorerTitle: collectionTitle,
    glyph: () => "collection",
  },
  newPage: {
    virtual: true,
    singleton: false,
    title: (_tab, label) => label || "Untitled",
    tooltip: () => "New page",
    explorerTitle: (_tab, label) => label || "Untitled",
    glyph: () => "markdown",
  },
};
export function singletonTabIdentity(tab: ParsedTab | null): string | null {
  if (tab === null || !TAB_KINDS[tab.kind].singleton) return null;
  if (tab.kind === "site" && tab.siteRoot === null) return null;
  return tabPath(tab);
}

export interface WorkbenchTab {
  path: string;
}

export interface EditorGroup {
  id: string;
  tabs: WorkbenchTab[];
  activeTab: string | null;
  // Normalized flex weight. All group sizes are positive and sum to one.
  size: number;
}

export const EXPLORER_MODES = ["home", "files"] as const;
export type ExplorerMode = (typeof EXPLORER_MODES)[number];

export interface WorkbenchState {
  activeView: ActivityViewId;
  sidebarVisible: boolean;
  sidebarWidth: number;
  // Editor groups appear in horizontal visual order. A path can be open once
  // in each group, while each group owns its own active tab.
  editorGroups: EditorGroup[];
  activeEditorGroup: string;
  // The right-hand About rail (VS Code's secondary sidebar: toggleable,
  // resizable, hidden by default). Independent of the left panel entirely.
  aboutVisible: boolean;
  aboutWidth: number;
  // Max height of the explorer's Open Editors list (VS Code-style resizable
  // section): the list caps here and scrolls internally; shorter lists shrink
  // to fit.
  openEditorsHeight: number;
  // Explorer state, persisted with the rest: which folders are
  // expanded and which paths are pinned to the favorites section.
  expandedFolders: string[];
  pinned: string[];
  // Recently opened files, most recent first, capped — boosts
  // quick-open ranking. Persisted with the rest of the ui-state.
  recentFiles: string[];
  // The Explorer's view: Home groups the workspace by kind, Files is the
  // folder tree. Saved per workspace with the rest of the ui-state.
  explorerMode: ExplorerMode;
  // Which view each collection tab shows, keyed by the collection's folder
  // path (Phase 2 collections). Per-user local state: closing the tab or
  // restarting the app must not reset the open view.
  collectionViews: Record<string, string>;
}

type EditorTransitionActivation = "target" | "preserve";

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 2400;
export const SIDEBAR_DEFAULT_WIDTH = 240;
export const ABOUT_MIN_WIDTH = 240;
export const ABOUT_MAX_WIDTH = 2400;
export const ABOUT_DEFAULT_WIDTH = 320;
// Open-editors rows are 28px (h-7). The default shows 4.5 rows — the half row
// at the cutoff signals there is more to scroll; the min keeps two rows
// grabbable and the max is generous (tall portrait monitors) like the rails.
export const OPEN_EDITORS_MIN_HEIGHT = 56;
export const OPEN_EDITORS_MAX_HEIGHT = 2400;
export const OPEN_EDITORS_DEFAULT_HEIGHT = 126;
// Bounds the persisted payload (and the tab strip) — not a UX target.
export const MAX_OPEN_TABS = 100;
// The global tab cap bounds non-empty groups. The model can retain one extra
// empty destination while a tab is moved or a split is created.
export const MAX_EDITOR_GROUPS = MAX_OPEN_TABS + 1;
export const MAX_EDITOR_GROUP_ID_CHARS = 128;
export const DEFAULT_EDITOR_GROUP_ID = "primary";
// Bounds the persisted explorer state the same way (oldest entries give way).
export const MAX_EXPANDED_FOLDERS = 500;
export const MAX_PINNED_PATHS = 100;
// Recent-files list for quick-open ranking.
export const MAX_RECENT_FILES = 20;
// Bounds the persisted collection-view map (pinned precedent: a payload
// bound, not a UX target — at the bound the oldest entry gives way).
export const MAX_COLLECTION_VIEWS = 100;

export function defaultWorkbenchState(): WorkbenchState {
  return {
    activeView: "explorer",
    sidebarVisible: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    editorGroups: [
      { id: DEFAULT_EDITOR_GROUP_ID, tabs: [], activeTab: null, size: 1 },
    ],
    activeEditorGroup: DEFAULT_EDITOR_GROUP_ID,
    aboutVisible: false,
    aboutWidth: ABOUT_DEFAULT_WIDTH,
    openEditorsHeight: OPEN_EDITORS_DEFAULT_HEIGHT,
    expandedFolders: [],
    pinned: [],
    recentFiles: [],
    explorerMode: "home",
    collectionViews: {},
  };
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function clampAboutWidth(width: number): number {
  if (!Number.isFinite(width)) return ABOUT_DEFAULT_WIDTH;
  return Math.min(ABOUT_MAX_WIDTH, Math.max(ABOUT_MIN_WIDTH, Math.round(width)));
}

export function clampOpenEditorsHeight(height: number): number {
  if (!Number.isFinite(height)) return OPEN_EDITORS_DEFAULT_HEIGHT;
  return Math.min(
    OPEN_EDITORS_MAX_HEIGHT,
    Math.max(OPEN_EDITORS_MIN_HEIGHT, Math.round(height)),
  );
}

export function activeGroup(state: WorkbenchState): EditorGroup {
  return (
    state.editorGroups.find((group) => group.id === state.activeEditorGroup) ??
    state.editorGroups[0]
  );
}

export function activeTabPath(state: WorkbenchState): string | null {
  return activeGroup(state).activeTab;
}

export function allTabs(state: WorkbenchState): WorkbenchTab[] {
  return state.editorGroups.flatMap((group) => group.tabs);
}

function findTabInGroup(
  state: WorkbenchState,
  groupId: string,
  path: string,
): WorkbenchTab | null {
  return (
    state.editorGroups
      .find((group) => group.id === groupId)
      ?.tabs.find((tab) => tab.path === path) ?? null
  );
}

function replaceGroup(
  state: WorkbenchState,
  groupId: string,
  replace: (group: EditorGroup) => EditorGroup,
): WorkbenchState {
  const index = state.editorGroups.findIndex((group) => group.id === groupId);
  if (index === -1) return state;
  const group = state.editorGroups[index];
  const next = replace(group);
  if (next === group) return state;
  const editorGroups = [...state.editorGroups];
  editorGroups[index] = next;
  return { ...state, editorGroups };
}

function detachTabFromGroup(
  group: EditorGroup,
  path: string,
): { group: EditorGroup; tab: WorkbenchTab } | null {
  const index = group.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return null;
  const tab = group.tabs[index];
  const tabs = group.tabs.filter((candidate) => candidate !== tab);
  const activeTab =
    group.activeTab === path
      ? ((tabs[index] ?? tabs[index - 1])?.path ?? null)
      : group.activeTab;
  return { group: { ...group, tabs, activeTab }, tab };
}

function normalizeEditorGroupSizes(groups: EditorGroup[]): EditorGroup[] {
  const weights = groups.map((group) =>
    Number.isFinite(group.size) && group.size > 0 ? group.size : 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return groups.map((group, index) => {
    const size = weights[index] / total;
    return group.size === size ? group : { ...group, size };
  });
}

// Make room for one tab instance without unmounting any active editor. Tab
// identity matters here: the same path can be active in several groups.
function evictFirstInactiveTab(state: WorkbenchState): WorkbenchState | null {
  for (const group of state.editorGroups) {
    const evicted = group.tabs.find((tab) => tab.path !== group.activeTab);
    if (!evicted) continue;
    return replaceGroup(state, group.id, (current) => ({
      ...current,
      tabs: current.tabs.filter((tab) => tab !== evicted),
    }));
  }
  return null;
}

// Closes saved tabs, first group first, until `count` more fit under the cap:
// inactive tabs, then a second copy of a file open in two groups, then the
// tab a group shows. A path in `keep` stays open in one group.
function makeRoomForTabs(state: WorkbenchState, count: number, keep: ReadonlySet<string>): WorkbenchState {
  let excess = allTabs(state).length + count - MAX_OPEN_TABS;
  if (excess <= 0) return state;
  const copies = new Map<string, number>();
  for (const tab of allTabs(state)) copies.set(tab.path, (copies.get(tab.path) ?? 0) + 1);
  const closable: ((group: EditorGroup, path: string) => boolean)[] = [
    (group, path) => path !== group.activeTab && !keep.has(path),
    (group, path) => path !== group.activeTab && copies.get(path)! > 1,
    (_group, path) => copies.get(path)! > 1 || !keep.has(path),
  ];
  let next = state;
  for (const canClose of closable) {
    for (const { id } of state.editorGroups) {
      const group = () => next.editorGroups.find((candidate) => candidate.id === id)!;
      for (const { path } of group().tabs) {
        if (excess === 0) return next;
        if (!canClose(group(), path)) continue;
        next = closeTab(next, id, path);
        copies.set(path, copies.get(path)! - 1);
        excess -= 1;
      }
    }
  }
  return next;
}

// The saved layout with every tab open in `shown` beside it, the one in view
// still in view. A file open in both keeps its saved place. An app open in
// `shown` stays in its group, because moving it reloads the app. Past the tab
// limit, saved tabs close to make room, so no tab in `shown` closes.
export function mergeSavedTabs(saved: WorkbenchState, shown: WorkbenchState): WorkbenchState {
  const holder = (state: WorkbenchState, path: string) =>
    state.editorGroups.find((group) => group.tabs.some((tab) => tab.path === path))?.id;
  const shownPaths = new Set(allTabs(shown).map((tab) => tab.path));
  const appGroups = new Map<string, string>();
  for (const group of shown.editorGroups) {
    if (!saved.editorGroups.some((candidate) => candidate.id === group.id)) continue;
    for (const { path } of group.tabs) if (parseTab(path).kind === "site") appGroups.set(path, group.id);
  }
  let next = saved;
  for (const [path, groupId] of appGroups) {
    const savedGroup = holder(next, path);
    if (savedGroup !== undefined && savedGroup !== groupId) next = closeTab(next, savedGroup, path);
  }
  const adding = [...shownPaths].filter((path) => !holder(next, path)).length;
  next = makeRoomForTabs(next, adding, shownPaths);
  for (const path of shownPaths) {
    if (!holder(next, path)) next = openTab(next, path, appGroups.get(path));
  }
  const active = activeTabPath(shown);
  return active === null ? next : openTab(next, active, holder(next, active));
}

export function focusEditorGroup(
  state: WorkbenchState,
  groupId: string,
): WorkbenchState {
  if (
    state.activeEditorGroup === groupId ||
    !state.editorGroups.some((group) => group.id === groupId)
  ) {
    return state;
  }
  return { ...state, activeEditorGroup: groupId };
}

// Open or reactivate a tab in the requested group, or in the focused group.
// A path is unique within a group and can be open in several groups.
export function openTab(
  state: WorkbenchState,
  path: string,
  targetGroupId: string = state.activeEditorGroup,
): WorkbenchState {
  const parsed = parseTab(path);
  const singletonPath = singletonTabIdentity(parsed);
  if (TAB_KINDS[parsed.kind].singleton && singletonPath === null) return state;
  const openedPath = singletonPath ?? path;
  if (singletonPath !== null) {
    const existingGroup = state.editorGroups.find((group) =>
      group.tabs.some(
        (tab) => singletonTabIdentity(parseTab(tab.path)) === singletonPath,
      ),
    );
    const existingTab = existingGroup?.tabs.find(
      (tab) => singletonTabIdentity(parseTab(tab.path)) === singletonPath,
    );
    if (existingGroup && existingTab) {
      return activateTab(state, existingGroup.id, existingTab.path);
    }
  }
  const target = state.editorGroups.find((group) => group.id === targetGroupId)
    ? targetGroupId
    : state.activeEditorGroup;
  if (findTabInGroup(state, target, openedPath)) {
    return activateTab(state, target, openedPath);
  }

  let next = state;
  if (allTabs(state).length >= MAX_OPEN_TABS) {
    // Every tab can be active only when every group owns one. The cap still
    // wins, but no mounted editor is evicted.
    const evicted = evictFirstInactiveTab(state);
    if (!evicted) return state;
    next = evicted;
  }
  next = replaceGroup(next, target, (group) => ({
    ...group,
    tabs: [...group.tabs, { path: openedPath }],
    activeTab: openedPath,
  }));
  return next.activeEditorGroup === target
    ? next
    : { ...next, activeEditorGroup: target };
}

// History opens one diff tab per group and points it at each change the
// person opens, so walking back through changes does not fill the tab strip.
// A change already open in the group is activated where it is.
export function openMomentDiff(
  state: WorkbenchState,
  momentId: string,
  targetGroupId: string = state.activeEditorGroup,
): WorkbenchState {
  const path = momentDiffTabPath(momentId);
  const group = state.editorGroups.find((candidate) => candidate.id === targetGroupId);
  if (!group || group.tabs.some((tab) => tab.path === path)) return openTab(state, path, targetGroupId);
  // The active tab when it is a diff, else the group's first diff tab.
  const reused = [group.activeTab, ...group.tabs.map((tab) => tab.path)]
    .find((tabPath) => tabPath !== null && parseTab(tabPath).kind === "momentDiff");
  if (!reused) return openTab(state, path, targetGroupId);
  return focusEditorGroup(
    replaceGroup(state, group.id, (current) => ({
      ...current,
      tabs: current.tabs.map((tab) => (tab.path === reused ? { path } : tab)),
      activeTab: path,
    })),
    group.id,
  );
}

// A new page's tab becomes its file's tab where it stands, active if it was.
// A group that already shows the file keeps that tab instead.
export function replaceTab(
  state: WorkbenchState,
  from: string,
  to: string,
): WorkbenchState {
  let changed = false;
  const editorGroups = state.editorGroups.map((group) => {
    if (!group.tabs.some((tab) => tab.path === from)) return group;
    changed = true;
    const shown = group.tabs.some((tab) => tab.path === to);
    return {
      ...group,
      tabs: shown
        ? group.tabs.filter((tab) => tab.path !== from)
        : group.tabs.map((tab) => (tab.path === from ? { path: to } : tab)),
      activeTab: group.activeTab === from ? to : group.activeTab,
    };
  });
  return changed ? { ...state, editorGroups } : state;
}

export function activateTab(
  state: WorkbenchState,
  groupId: string,
  path: string,
): WorkbenchState {
  const group = state.editorGroups.find((candidate) => candidate.id === groupId);
  if (!group?.tabs.some((tab) => tab.path === path)) return state;
  if (group.activeTab === path && state.activeEditorGroup === groupId) return state;
  const next =
    group.activeTab === path
      ? state
      : replaceGroup(state, groupId, (current) => ({ ...current, activeTab: path }));
  return next.activeEditorGroup === groupId
    ? next
    : { ...next, activeEditorGroup: groupId };
}

// The tab after or before the group's active tab, wrapping at the ends.
export function adjacentTabPath(group: EditorGroup, step: 1 | -1): string | null {
  const { tabs } = group;
  const index = tabs.findIndex((tab) => tab.path === group.activeTab);
  // With no active tab, next is the first tab and previous the last.
  const from = index === -1 && step === -1 ? 0 : index;
  return tabs[(from + step + tabs.length) % tabs.length]?.path ?? null;
}

// Close a tab. When the group's active tab closes, the tab that enters its
// slot takes over, or the new last tab does.
export function closeTab(
  state: WorkbenchState,
  groupId: string,
  path: string,
): WorkbenchState {
  return replaceGroup(
    state,
    groupId,
    (group) => detachTabFromGroup(group, path)?.group ?? group,
  );
}

// Reorder one group's tabs. The target index clamps into that group.
export function moveTab(
  state: WorkbenchState,
  groupId: string,
  from: number,
  to: number,
): WorkbenchState {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return state;
  return replaceGroup(state, groupId, (group) => {
    if (from < 0 || from >= group.tabs.length) return group;
    const bounded = Math.min(Math.max(to, 0), group.tabs.length - 1);
    if (bounded === from) return group;
    const tabs = [...group.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(bounded, 0, moved);
    return { ...group, tabs };
  });
}

// Move one tab instance between existing groups. A destination that already
// has the same path keeps its own instance and the source copy closes.
export function moveTabToGroup(
  state: WorkbenchState,
  sourceGroupId: string,
  targetGroupId: string,
  path: string,
  toIndex: number,
  activation: EditorTransitionActivation = "target",
): WorkbenchState {
  if (!Number.isInteger(toIndex)) return state;
  const source = state.editorGroups.find((group) => group.id === sourceGroupId);
  const target = state.editorGroups.find((group) => group.id === targetGroupId);
  if (!source || !target || source === target) return state;

  const detached = detachTabFromGroup(source, path);
  if (!detached) return state;
  const existingTarget = target.tabs.find((candidate) => candidate.path === path);
  const targetTabs = [...target.tabs];
  if (!existingTarget) {
    const bounded = Math.min(
      Math.max(toIndex, 0),
      targetTabs.length,
    );
    targetTabs.splice(bounded, 0, detached.tab);
  }
  const editorGroups = state.editorGroups.map((group) => {
    if (group.id === sourceGroupId) {
      return detached.group;
    }
    if (group.id === targetGroupId) {
      return {
        ...group,
        tabs: targetTabs,
        activeTab:
          activation === "target" || group.activeTab === null
            ? path
            : group.activeTab,
      };
    }
    return group;
  });
  return {
    ...state,
    editorGroups,
    activeEditorGroup:
      activation === "target" ? targetGroupId : state.activeEditorGroup,
  };
}

export function moveTabToNewGroup(
  state: WorkbenchState,
  sourceGroupId: string,
  path: string,
  newGroupId: string,
  activation: EditorTransitionActivation = "target",
): WorkbenchState {
  if (
    newGroupId.length === 0 ||
    newGroupId.length > MAX_EDITOR_GROUP_ID_CHARS ||
    state.editorGroups.some((group) => group.id === newGroupId)
  ) {
    return state;
  }
  // A single-tab split leaves one useful empty drop target. Before another
  // split, remove older empty placeholders so healthy use never grows toward
  // an arbitrary group-count rejection. The 256 KiB UI-state file bound is
  // the actual persisted-payload limit.
  const baseGroups = normalizeEditorGroupSizes(
    state.editorGroups.filter(
      (group) =>
        group.id === sourceGroupId ||
        group.tabs.length > 0 ||
        (activation === "preserve" && group.id === state.activeEditorGroup),
    ),
  );
  const sourceIndex = baseGroups.findIndex(
    (group) => group.id === sourceGroupId,
  );
  if (sourceIndex === -1) return state;
  const source = baseGroups[sourceIndex];
  const detached = detachTabFromGroup(source, path);
  if (!detached) return state;
  if (baseGroups.length >= MAX_EDITOR_GROUPS) {
    // At the cap, the only valid extra group is the focused empty placeholder
    // retained above. Moving the sole tab out of its source can replace that
    // source in place, so the requested group is created without discarding
    // the user's newer empty-group focus or exceeding the persisted contract.
    if (
      baseGroups.length !== MAX_EDITOR_GROUPS ||
      detached.group.tabs.length > 0
    ) {
      return state;
    }
    const editorGroups = [...baseGroups];
    editorGroups[sourceIndex] = {
      id: newGroupId,
      tabs: [detached.tab],
      activeTab: path,
      size: source.size,
    };
    return {
      ...state,
      editorGroups,
      activeEditorGroup:
        activation === "target" ? newGroupId : state.activeEditorGroup,
    };
  }
  const splitSize = source.size / 2;
  const editorGroups = [...baseGroups];
  editorGroups.splice(
    sourceIndex,
    1,
    { ...detached.group, size: splitSize },
    { id: newGroupId, tabs: [detached.tab], activeTab: path, size: splitSize },
  );
  return {
    ...state,
    editorGroups,
    activeEditorGroup:
      activation === "target" ? newGroupId : state.activeEditorGroup,
  };
}

export function createEditorGroupRight(
  state: WorkbenchState,
  sourceGroupId: string,
  newGroupId: string,
  activation: EditorTransitionActivation = "target",
): WorkbenchState {
  if (
    newGroupId.length === 0 ||
    newGroupId.length > MAX_EDITOR_GROUP_ID_CHARS ||
    state.editorGroups.some((group) => group.id === newGroupId)
  ) {
    return state;
  }
  const requestedSource = state.editorGroups.find(
    (group) => group.id === sourceGroupId,
  );
  if (TAB_KINDS[parseTab(requestedSource?.activeTab ?? null)?.kind ?? "removed"].singleton) return state;
  let base: WorkbenchState = {
    ...state,
    editorGroups: normalizeEditorGroupSizes(
      state.editorGroups.filter(
        (group) =>
          group.id === sourceGroupId ||
          group.tabs.length > 0 ||
          (activation === "preserve" && group.id === state.activeEditorGroup),
      ),
    ),
  };
  if (allTabs(base).length >= MAX_OPEN_TABS) {
    const evicted = evictFirstInactiveTab(base);
    if (!evicted) return state;
    base = evicted;
  }
  const sourceIndex = base.editorGroups.findIndex(
    (group) => group.id === sourceGroupId,
  );
  const source = base.editorGroups[sourceIndex];
  const activeTab = source?.tabs.find((tab) => tab.path === source.activeTab);
  // An empty focused group is already the destination for the next open.
  if (!source || !activeTab) return state;
  const splitSize = source.size / 2;
  const editorGroups = [...base.editorGroups];
  editorGroups.splice(
    sourceIndex,
    1,
    { ...source, size: splitSize },
    {
      id: newGroupId,
      tabs: [{ path: activeTab.path }],
      activeTab: activeTab.path,
      size: splitSize,
    },
  );
  return {
    ...state,
    editorGroups,
    activeEditorGroup:
      activation === "target" ? newGroupId : state.activeEditorGroup,
  };
}

// Resize an adjacent pair. `leftSize` is the left group's normalized size;
// the right group receives the pair's remaining size.
export function clampEditorGroupPairLeftSize(
  pairSize: number,
  leftSize: number,
): number {
  return Math.min(Math.max(leftSize, pairSize * 0.05), pairSize * 0.95);
}

export function resizeEditorGroups(
  state: WorkbenchState,
  leftGroupId: string,
  rightGroupId: string,
  leftSize: number,
): WorkbenchState {
  const leftIndex = state.editorGroups.findIndex((group) => group.id === leftGroupId);
  if (leftIndex === -1 || state.editorGroups[leftIndex + 1]?.id !== rightGroupId) {
    return state;
  }
  const pairSize =
    state.editorGroups[leftIndex].size + state.editorGroups[leftIndex + 1].size;
  if (!Number.isFinite(leftSize)) return state;
  const boundedLeftSize = clampEditorGroupPairLeftSize(pairSize, leftSize);
  const editorGroups = [...state.editorGroups];
  editorGroups[leftIndex] = { ...editorGroups[leftIndex], size: boundedLeftSize };
  editorGroups[leftIndex + 1] = {
    ...editorGroups[leftIndex + 1],
    size: pairSize - boundedLeftSize,
  };
  return { ...state, editorGroups };
}

export function closeEditorGroup(
  state: WorkbenchState,
  groupId: string,
): WorkbenchState {
  if (state.editorGroups.length === 1) return state;
  const index = state.editorGroups.findIndex((group) => group.id === groupId);
  if (index === -1) return state;
  const editorGroups = normalizeEditorGroupSizes(
    state.editorGroups.filter((group) => group.id !== groupId),
  );
  const activeEditorGroup =
    state.activeEditorGroup === groupId
      ? (editorGroups[index] ?? editorGroups[index - 1]).id
      : state.activeEditorGroup;
  return { ...state, editorGroups, activeEditorGroup };
}

// Selecting the already-active view toggles the panel (the old explicit
// collapse button); any other view switches and reveals the panel.
export function setView(
  state: WorkbenchState,
  view: ActivityViewId,
): WorkbenchState {
  if (view === state.activeView) {
    return { ...state, sidebarVisible: !state.sidebarVisible };
  }
  return { ...state, activeView: view, sidebarVisible: true };
}

// A command that names a view shows it and never hides it; only the rail's
// own button toggles.
export function showView(
  state: WorkbenchState,
  view: ActivityViewId,
): WorkbenchState {
  return state.activeView === view && state.sidebarVisible
    ? state
    : { ...state, activeView: view, sidebarVisible: true };
}

export function toggleSidebar(state: WorkbenchState): WorkbenchState {
  return { ...state, sidebarVisible: !state.sidebarVisible };
}

export function toggleAbout(state: WorkbenchState): WorkbenchState {
  return { ...state, aboutVisible: !state.aboutVisible };
}

export function setSidebarWidth(state: WorkbenchState, width: number): WorkbenchState {
  const clamped = clampSidebarWidth(width);
  return clamped === state.sidebarWidth ? state : { ...state, sidebarWidth: clamped };
}

export function setExplorerMode(state: WorkbenchState, mode: ExplorerMode): WorkbenchState {
  return mode === state.explorerMode ? state : { ...state, explorerMode: mode };
}

export function setAboutWidth(state: WorkbenchState, width: number): WorkbenchState {
  const clamped = clampAboutWidth(width);
  return clamped === state.aboutWidth ? state : { ...state, aboutWidth: clamped };
}

export function setOpenEditorsHeight(
  state: WorkbenchState,
  height: number,
): WorkbenchState {
  const clamped = clampOpenEditorsHeight(height);
  return clamped === state.openEditorsHeight
    ? state
    : { ...state, openEditorsHeight: clamped };
}

// Capped append: at the bound the oldest entry gives way (openTab precedent)
// — never a refusal the user would have to understand.
function appendCapped(list: string[], path: string, cap: number): string[] {
  const next = [...list, path];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function setFolderExpanded(
  state: WorkbenchState,
  path: string,
  expanded: boolean,
): WorkbenchState {
  const has = state.expandedFolders.includes(path);
  if (expanded === has) return state;
  return {
    ...state,
    expandedFolders: expanded
      ? appendCapped(state.expandedFolders, path, MAX_EXPANDED_FOLDERS)
      : state.expandedFolders.filter((folder) => folder !== path),
  };
}

export function toggleFolderExpanded(
  state: WorkbenchState,
  path: string,
): WorkbenchState {
  return setFolderExpanded(state, path, !state.expandedFolders.includes(path));
}

// Records a file open for quick-open recency ranking: most recent first,
// deduped, capped at MAX_RECENT_FILES (oldest gives way). Re-opening the
// already-most-recent file is a no-op (same reference).
export function recordRecentFile(state: WorkbenchState, path: string): WorkbenchState {
  if (state.recentFiles[0] === path) return state;
  const recentFiles = [
    path,
    ...state.recentFiles.filter((recent) => recent !== path),
  ].slice(0, MAX_RECENT_FILES);
  return { ...state, recentFiles };
}

// Remembers which view a collection tab shows, per collection path. null
// clears the entry (the view was deleted); the next open falls back to the
// schema's first view. At the bound the map's oldest entry gives way
// (appendCapped precedent; string-key insertion order is exact enough for a
// payload bound).
export function setCollectionActiveView(
  state: WorkbenchState,
  collectionPath: string,
  viewName: string | null,
): WorkbenchState {
  if (viewName === null) {
    if (!Object.hasOwn(state.collectionViews, collectionPath)) return state;
    const collectionViews = { ...state.collectionViews };
    delete collectionViews[collectionPath];
    return { ...state, collectionViews };
  }
  if (state.collectionViews[collectionPath] === viewName) return state;
  const collectionViews = {
    ...state.collectionViews,
    [collectionPath]: viewName,
  };
  const paths = Object.keys(collectionViews);
  if (paths.length > MAX_COLLECTION_VIEWS) delete collectionViews[paths[0]];
  return { ...state, collectionViews };
}

export function togglePinned(state: WorkbenchState, path: string): WorkbenchState {
  return {
    ...state,
    pinned: state.pinned.includes(path)
      ? state.pinned.filter((pin) => pin !== path)
      : appendCapped(state.pinned, path, MAX_PINNED_PATHS),
  };
}

// Rename/move/delete remap: every path-keyed slice re-projects through one
// projection. Tab collisions are removed within each group.
//
// The projection speaks filesystem paths. A collection tab encodes its folder
// path behind tab://collection/, so the tab projects the DECODED folder and
// re-encodes the result — projecting the tab path itself matches no rename,
// and the tab would keep naming the folder the move vacated.
export function remapWorkbenchPaths(
  state: WorkbenchState,
  project: (path: string) => string | null,
): WorkbenchState {
  const projectTab = (path: string): string | null => {
    const tab = parseTab(path);
    const collectionPath = tab.kind === "collection" ? tab.collectionPath : null;
    if (collectionPath === null) return project(path);
    const next = project(collectionPath);
    if (next === null) return null;
    return next === collectionPath ? path : collectionTabPath(next);
  };
  const projected = new Map<string, string | null>();
  const editorGroups = state.editorGroups.map((group) => {
    const seen = new Set<string>();
    const tabs: WorkbenchTab[] = [];
    for (const tab of group.tabs) {
      const next = projectTab(tab.path);
      projected.set(tab.path, next);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      tabs.push(next === tab.path ? tab : { path: next });
    }
    const projectedActive =
      group.activeTab === null ? null : (projected.get(group.activeTab) ?? null);
    const activeTab =
      projectedActive !== null && tabs.some((tab) => tab.path === projectedActive)
        ? projectedActive
        : (tabs[tabs.length - 1]?.path ?? null);
    return { ...group, tabs, activeTab };
  });
  const remapList = (list: string[]): string[] => {
    const out: string[] = [];
    for (const path of list) {
      const next = project(path);
      if (next !== null && !out.includes(next)) out.push(next);
    }
    return out;
  };
  const collectionViews: Record<string, string> = {};
  for (const [path, view] of Object.entries(state.collectionViews)) {
    const next = project(path);
    if (next !== null && !Object.hasOwn(collectionViews, next)) {
      collectionViews[next] = view;
    }
  }
  return {
    ...state,
    editorGroups,
    expandedFolders: remapList(state.expandedFolders),
    pinned: remapList(state.pinned),
    recentFiles: remapList(state.recentFiles),
    collectionViews,
  };
}

// Restored tabs can outlive their files: a version rollback, an external
// delete, or a share pull changes the tree without an explorer op, so
// remapWorkbenchPaths never sees it and Open Editors keeps offering a path
// that is gone.
//
// Scoped to `restoredPaths` — the tabs that came from stored ui-state. Their
// files all existed when the app started, so any listing that omits one is
// reporting a real deletion, and the check can safely re-run on every listing
// (a shared workspace lists twice on open: once at mount, once after the pull
// lands). A tab opened this session is never in the set, so a listing that
// raced its create can never close it.
//
// Tabs only: pinned paths, expanded folders and recent files include folders,
// which no file listing carries. Virtual tabs (tab://graph, chats, a moment
// diff) have no file and always survive.
export function pruneMissingRestoredTabs(
  state: WorkbenchState,
  restoredPaths: ReadonlySet<string>,
  fileExists: (path: string) => boolean,
): WorkbenchState {
  let changed = false;
  const editorGroups = state.editorGroups.map((group) => {
    const tabs = group.tabs.filter(
      (tab) =>
        !restoredPaths.has(tab.path) ||
        TAB_KINDS[parseTab(tab.path).kind].virtual ||
        fileExists(tab.path),
    );
    if (tabs.length === group.tabs.length) return group;
    changed = true;
    const activeTab =
      group.activeTab !== null && tabs.some((tab) => tab.path === group.activeTab)
        ? group.activeTab
        : (tabs[tabs.length - 1]?.path ?? null);
    return { ...group, tabs, activeTab };
  });
  return changed ? { ...state, editorGroups } : state;
}

// Persistence (.dohc/ui-state.json via the narrow get/set IPC pair).
// serialize produces the zod-validated wire shape; parse is tolerant — a
// missing, corrupt, or foreign-shaped value yields defaults, field by field,
// never an error (windowState precedent).
export function serializeUiState(state: WorkbenchState): WorkspaceUiState {
  const editorGroups = normalizeEditorGroupSizes(state.editorGroups);
  return {
    version: 3,
    activeView: state.activeView,
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: clampSidebarWidth(state.sidebarWidth),
    editorGroups: editorGroups.map((group) => ({
      id: group.id,
      tabs: group.tabs.map((tab) => tab.path),
      activeTab: group.activeTab,
      size: group.size,
    })),
    activeEditorGroup: state.activeEditorGroup,
    aboutVisible: state.aboutVisible,
    aboutWidth: clampAboutWidth(state.aboutWidth),
    openEditorsHeight: clampOpenEditorsHeight(state.openEditorsHeight),
    expandedFolders: state.expandedFolders,
    pinned: state.pinned,
    recentFiles: state.recentFiles,
    explorerMode: state.explorerMode,
    collectionViews: state.collectionViews,
  };
}

export function parseUiState(raw: unknown): WorkbenchState {
  const defaults = defaultWorkbenchState();
  if (typeof raw !== "object" || raw === null) return defaults;
  const value = raw as Record<string, unknown>;
  // Adversarial boundary: read only own fields (a polluted prototype must not
  // inject state) and collect tab paths with a loop that stops once the cap
  // is reached — never materialize/filter a huge foreign array first.
  const own = (key: string): unknown =>
    Object.hasOwn(value, key) ? value[key] : undefined;
  const version = own("version");
  if (version !== 2 && version !== 3) return defaults;
  // Version 2 shared the public URL scheme. Rewrite tab references before
  // validation and deduplication; file paths and other settings stay intact.
  const migrateTabPath = (path: unknown): unknown =>
    version === 2 && typeof path === "string" && path.length <= 4096 && path.startsWith(V2_TAB_SCHEME)
      ? `${INTERNAL_TAB_SCHEME}${path.slice(V2_TAB_SCHEME.length)}`
      : path;
  // Bounded path-list collector (tabs, expandedFolders, pinned): stops once
  // the cap is reached — never materialize/filter a huge foreign array first.
  const collectPaths = (raw: unknown, cap: number): string[] => {
    const out: string[] = [];
    if (!Array.isArray(raw)) return out;
    const seen = new Set<string>();
    for (const entry of raw) {
      if (out.length >= cap) break;
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 4096) {
        continue;
      }
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  };
  const editorGroups: EditorGroup[] = [];
  const groupIds = new Set<string>();
  const singletonOwnerGroups = new Map<string, string>();
  const discardedActiveSingletons = new Map<string, string>();
  let tabCount = 0;
  const rawGroups = own("editorGroups");
  if (Array.isArray(rawGroups)) {
    for (
      let groupIndex = 0;
      groupIndex < Math.min(rawGroups.length, MAX_EDITOR_GROUPS);
      groupIndex++
    ) {
      const entry = rawGroups[groupIndex];
      if (typeof entry !== "object" || entry === null) continue;
      const group = entry as Record<string, unknown>;
      const groupOwn = (key: string): unknown =>
        Object.hasOwn(group, key) ? group[key] : undefined;
      const id = groupOwn("id");
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > MAX_EDITOR_GROUP_ID_CHARS ||
        groupIds.has(id)
      ) {
        continue;
      }
      groupIds.add(id);
      const tabs: WorkbenchTab[] = [];
      const tabPaths = new Set<string>();
      const rawTabs = groupOwn("tabs");
      const rawActiveTab = migrateTabPath(groupOwn("activeTab"));
      const parsedActiveTab = typeof rawActiveTab === "string" ? parseTab(rawActiveTab) : null;
      const normalizedActiveTab = parsedActiveTab
        ? (singletonTabIdentity(parsedActiveTab) ??
          (TAB_KINDS[parsedActiveTab.kind].singleton ? null : parsedActiveTab.path))
        : null;
      if (Array.isArray(rawTabs)) {
        for (const rawTab of rawTabs) {
          if (tabCount >= MAX_OPEN_TABS) break;
          const tab = migrateTabPath(rawTab);
          if (
            typeof tab !== "string" ||
            tab.length === 0 ||
            tab.length > 4096
          ) {
            continue;
          }
          const parsedTab = parseTab(tab);
          // Removed surfaces never restore as workspace file paths, and a new
          // page that was never written has nothing to restore.
          if (parsedTab.kind === "removed" || parsedTab.kind === "newPage") continue;
          const canonicalSingleton = singletonTabIdentity(parsedTab);
          if (TAB_KINDS[parsedTab.kind].singleton && canonicalSingleton === null) {
            continue;
          }
          const tabPath = canonicalSingleton ?? tab;
          if (tabPaths.has(tabPath)) continue;
          const singletonOwner = canonicalSingleton !== null
            ? singletonOwnerGroups.get(tabPath)
            : undefined;
          if (singletonOwner !== undefined) {
            if (normalizedActiveTab === tabPath) {
              discardedActiveSingletons.set(id, tabPath);
            }
            continue;
          }
          tabPaths.add(tabPath);
          if (canonicalSingleton !== null) singletonOwnerGroups.set(tabPath, id);
          tabCount += 1;
          tabs.push({ path: tabPath });
        }
      }
      const activeTab =
        normalizedActiveTab !== null &&
        tabs.some((tab) => tab.path === normalizedActiveTab)
          ? normalizedActiveTab
          : (tabs[0]?.path ?? null);
      const rawSize = groupOwn("size");
      const size =
        typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize > 0
          ? rawSize
          : 1;
      editorGroups.push({ id, tabs, activeTab, size });
    }
  }
  if (editorGroups.length === 0) {
    editorGroups.push(defaults.editorGroups[0]);
    groupIds.add(defaults.editorGroups[0].id);
  }
  let normalizedGroups = normalizeEditorGroupSizes(editorGroups);
  const rawActiveEditorGroup = own("activeEditorGroup");
  let activeEditorGroup =
    typeof rawActiveEditorGroup === "string" && groupIds.has(rawActiveEditorGroup)
      ? rawActiveEditorGroup
      : normalizedGroups[0].id;
  const discardedActiveSingleton = discardedActiveSingletons.get(activeEditorGroup);
  const singletonOwnerGroup = discardedActiveSingleton
    ? singletonOwnerGroups.get(discardedActiveSingleton)
    : undefined;
  if (discardedActiveSingleton && singletonOwnerGroup) {
    activeEditorGroup = singletonOwnerGroup;
    normalizedGroups = normalizedGroups.map((group) =>
      group.id === singletonOwnerGroup &&
      group.activeTab !== discardedActiveSingleton
        ? { ...group, activeTab: discardedActiveSingleton }
        : group,
    );
  }
  const rawView = own("activeView");
  const rawSidebarVisible = own("sidebarVisible");
  const rawSidebarWidth = own("sidebarWidth");
  // A file saved before the About rail names its fields chatsVisible and
  // chatsWidth. Nothing reads them, so the rail opens closed at its default
  // width and the rest of the file restores as saved.
  const rawAboutVisible = own("aboutVisible");
  const rawAboutWidth = own("aboutWidth");
  const rawOpenEditorsHeight = own("openEditorsHeight");
  return {
    activeView: isActivityViewId(rawView) ? rawView : defaults.activeView,
    sidebarVisible:
      typeof rawSidebarVisible === "boolean"
        ? rawSidebarVisible
        : defaults.sidebarVisible,
    sidebarWidth:
      typeof rawSidebarWidth === "number"
        ? clampSidebarWidth(rawSidebarWidth)
        : defaults.sidebarWidth,
    editorGroups: normalizedGroups,
    activeEditorGroup,
    aboutVisible:
      typeof rawAboutVisible === "boolean"
        ? rawAboutVisible
        : defaults.aboutVisible,
    aboutWidth:
      typeof rawAboutWidth === "number"
        ? clampAboutWidth(rawAboutWidth)
        : defaults.aboutWidth,
    openEditorsHeight:
      typeof rawOpenEditorsHeight === "number"
        ? clampOpenEditorsHeight(rawOpenEditorsHeight)
        : defaults.openEditorsHeight,
    expandedFolders: collectPaths(own("expandedFolders"), MAX_EXPANDED_FOLDERS),
    pinned: collectPaths(own("pinned"), MAX_PINNED_PATHS),
    recentFiles: collectPaths(own("recentFiles"), MAX_RECENT_FILES),
    explorerMode: EXPLORER_MODES.find((mode) => mode === own("explorerMode")) ?? defaults.explorerMode,
    collectionViews: collectCollectionViews(own("collectionViews")),
  };
}

// Bounded map collector for parseUiState, the collectPaths posture applied to
// a record: own string entries only, both sides bounded, stop at the cap.
function collectCollectionViews(raw: unknown): Record<string, string> {
  // Prototype-free: a collection folder named "__proto__" is an own key in
  // the file, and assigning it into a plain object would not keep it.
  const out: Record<string, string> = Object.create(null);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  let collected = 0;
  for (const path in record) {
    if (collected >= MAX_COLLECTION_VIEWS) break;
    if (!Object.hasOwn(record, path)) continue;
    const view = record[path];
    if (path.length === 0 || path.length > 4096) continue;
    if (typeof view !== "string" || view.length === 0 || view.length > 4096) {
      continue;
    }
    out[path] = view;
    collected += 1;
  }
  return out;
}
