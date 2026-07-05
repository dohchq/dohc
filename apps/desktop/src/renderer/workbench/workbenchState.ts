// Pure workbench model (Phase E2): activity-bar view, side-panel visibility
// and width, open editor tabs, and the history rail. Pure like
// window/windowState.ts so every transition and the persistence round-trip
// are unit-tested without Electron. `dirty` is runtime-only (derived from the
// editor's save state) and never lives here or on disk.

import type { WorkspaceUiState } from "../../ipc/bridgeContract";

export const VIEW_IDS = [
  "explorer",
  "search",
  "graph",
  "sites",
  "agent",
  "history",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];
export const GRAPH_TAB_PATH = "dohc://graph";
export const HISTORY_TAB_PATH = "dohc://history";
export const HISTORY_DIFF_TAB_PREFIX = "dohc://history-diff/";
export const SITE_TAB_PREFIX = "dohc://site/";
export const VERSION_COMPARE_TAB_PREFIX = "dohc://versions/compare/";

export function historyDiffTabPath(changeSetId: string, filePath: string): string {
  return `${HISTORY_DIFF_TAB_PREFIX}${encodeURIComponent(
    changeSetId,
  )}?file=${encodeURIComponent(filePath)}`;
}

export function siteTabPath(siteRoot: string): string {
  return `${SITE_TAB_PREFIX}${encodeURIComponent(siteRoot)}`;
}

export function isGraphTabPath(path: string | null): boolean {
  return path === GRAPH_TAB_PATH;
}

export function isHistoryTabPath(path: string | null): boolean {
  return path === HISTORY_TAB_PATH;
}

export function isHistoryDiffTabPath(path: string | null): boolean {
  return typeof path === "string" && path.startsWith(HISTORY_DIFF_TAB_PREFIX);
}

export function isSiteTabPath(path: string | null): boolean {
  return typeof path === "string" && path.startsWith(SITE_TAB_PREFIX);
}

export function parseSiteTabPath(path: string | null): string | null {
  if (typeof path !== "string" || !isSiteTabPath(path)) return null;
  try {
    const siteRoot = decodeURIComponent(path.slice(SITE_TAB_PREFIX.length));
    return siteRoot.length > 0 ? siteRoot : null;
  } catch {
    return null;
  }
}

export function parseHistoryDiffTabPath(
  path: string | null,
): { changeSetId: string; filePath: string } | null {
  if (typeof path !== "string" || !path.startsWith(HISTORY_DIFF_TAB_PREFIX)) {
    return null;
  }
  const suffix = path.slice(HISTORY_DIFF_TAB_PREFIX.length);
  const separator = suffix.indexOf("?file=");
  if (separator <= 0) return null;
  try {
    const changeSetId = decodeURIComponent(suffix.slice(0, separator));
    const filePath = decodeURIComponent(suffix.slice(separator + "?file=".length));
    return changeSetId.length > 0 && filePath.length > 0
      ? { changeSetId, filePath }
      : null;
  } catch {
    return null;
  }
}

// Versions compare page (PR 0M-4): one tab per compared version, keyed by
// the version id so re-comparing re-activates instead of duplicating.
export function versionCompareTabPath(versionId: string): string {
  return `${VERSION_COMPARE_TAB_PREFIX}${encodeURIComponent(versionId)}`;
}

export function isVersionCompareTabPath(path: string | null): boolean {
  return typeof path === "string" && path.startsWith(VERSION_COMPARE_TAB_PREFIX);
}

export function parseVersionCompareTabPath(path: string | null): string | null {
  if (typeof path !== "string" || !isVersionCompareTabPath(path)) return null;
  try {
    const versionId = decodeURIComponent(path.slice(VERSION_COMPARE_TAB_PREFIX.length));
    return versionId.length > 0 ? versionId : null;
  } catch {
    return null;
  }
}

export function isVirtualTabPath(path: string | null): boolean {
  return (
    isGraphTabPath(path) ||
    isHistoryTabPath(path) ||
    isHistoryDiffTabPath(path) ||
    isVersionCompareTabPath(path) ||
    isSiteTabPath(path)
  );
}

export interface WorkbenchState {
  activeView: ViewId;
  sidebarVisible: boolean;
  sidebarWidth: number;
  tabs: Array<{ path: string }>;
  activeTab: string | null;
  // The right-hand history rail (default ON — specs assert the timeline with
  // zero clicks). Independent of the left panel's History view.
  historyVisible: boolean;
  historyWidth: number;
  // Explorer state (Phase E3), persisted with the rest: which folders are
  // expanded and which paths are pinned to the favorites section.
  expandedFolders: string[];
  pinned: string[];
  // Recently opened files (Phase E5.0), most recent FIRST, capped — boosts
  // quick-open ranking. Persisted with the rest of the ui-state.
  recentFiles: string[];
}

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 2400;
export const SIDEBAR_DEFAULT_WIDTH = 240;
export const HISTORY_MIN_WIDTH = 180;
export const HISTORY_MAX_WIDTH = 2400;
export const HISTORY_DEFAULT_WIDTH = 280;
// Bounds the persisted payload (and the tab strip) — not a UX target.
export const MAX_OPEN_TABS = 100;
// Bounds the persisted explorer state the same way (oldest entries give way).
export const MAX_EXPANDED_FOLDERS = 500;
export const MAX_PINNED_PATHS = 100;
// Recent-files list for quick-open ranking (Phase E5.0).
export const MAX_RECENT_FILES = 20;

export function defaultWorkbenchState(): WorkbenchState {
  return {
    activeView: "explorer",
    sidebarVisible: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    tabs: [],
    activeTab: null,
    historyVisible: true,
    historyWidth: HISTORY_DEFAULT_WIDTH,
    expandedFolders: [],
    pinned: [],
    recentFiles: [],
  };
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function clampHistoryWidth(width: number): number {
  if (!Number.isFinite(width)) return HISTORY_DEFAULT_WIDTH;
  return Math.min(HISTORY_MAX_WIDTH, Math.max(HISTORY_MIN_WIDTH, Math.round(width)));
}

// Open (or re-activate) a file's tab. No duplicates; opening always
// activates. At the cap the oldest tab gives way rather than refusing — but
// NEVER the active tab: it is the only tab that can hold an unsaved editor
// draft (the mounted inspector), so evicting it could race the unmount flush.
// The oldest non-active tab is always safe to drop.
export function openTab(state: WorkbenchState, path: string): WorkbenchState {
  const exists = state.tabs.some((tab) => tab.path === path);
  if (exists) {
    return state.activeTab === path ? state : { ...state, activeTab: path };
  }
  if (state.tabs.length >= MAX_OPEN_TABS) {
    const evict = state.tabs.findIndex((tab) => tab.path !== state.activeTab);
    const tabs = state.tabs.filter((_, index) => index !== (evict === -1 ? 0 : evict));
    return { ...state, tabs: [...tabs, { path }], activeTab: path };
  }
  return { ...state, tabs: [...state.tabs, { path }], activeTab: path };
}

export function activateTab(state: WorkbenchState, path: string): WorkbenchState {
  if (state.activeTab === path || !state.tabs.some((tab) => tab.path === path)) {
    return state;
  }
  return { ...state, activeTab: path };
}

// Close a tab. When the ACTIVE tab closes, its neighbor takes over
// (VS Code rule: the tab that slid into the closed slot, else the new last).
export function closeTab(state: WorkbenchState, path: string): WorkbenchState {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  const activeTab =
    state.activeTab === path
      ? ((tabs[index] ?? tabs[index - 1])?.path ?? null)
      : state.activeTab;
  return { ...state, tabs, activeTab };
}

// Reorder (drag): move the tab at `from` to `to`. `to` clamps into range;
// an unknown `from` or a same-slot move is a no-op (same reference).
export function moveTab(state: WorkbenchState, from: number, to: number): WorkbenchState {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return state;
  if (from < 0 || from >= state.tabs.length) return state;
  const bounded = Math.min(Math.max(to, 0), state.tabs.length - 1);
  if (bounded === from) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(bounded, 0, moved);
  return { ...state, tabs };
}

// Selecting the already-active view toggles the panel (the old explicit
// collapse button); any other view switches AND reveals the panel.
export function setView(state: WorkbenchState, view: ViewId): WorkbenchState {
  if (view === state.activeView) {
    return { ...state, sidebarVisible: !state.sidebarVisible };
  }
  return { ...state, activeView: view, sidebarVisible: true };
}

export function toggleSidebar(state: WorkbenchState): WorkbenchState {
  return { ...state, sidebarVisible: !state.sidebarVisible };
}

export function toggleHistory(state: WorkbenchState): WorkbenchState {
  return { ...state, historyVisible: !state.historyVisible };
}

export function setSidebarWidth(state: WorkbenchState, width: number): WorkbenchState {
  const clamped = clampSidebarWidth(width);
  return clamped === state.sidebarWidth ? state : { ...state, sidebarWidth: clamped };
}

export function setHistoryWidth(state: WorkbenchState, width: number): WorkbenchState {
  const clamped = clampHistoryWidth(width);
  return clamped === state.historyWidth ? state : { ...state, historyWidth: clamped };
}

// Capped append: at the bound the OLDEST entry gives way (openTab precedent)
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

// Records a file open for quick-open recency ranking: most recent FIRST,
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

export function togglePinned(state: WorkbenchState, path: string): WorkbenchState {
  return {
    ...state,
    pinned: state.pinned.includes(path)
      ? state.pinned.filter((pin) => pin !== path)
      : appendCapped(state.pinned, path, MAX_PINNED_PATHS),
  };
}

// Rename/move/delete remap: every path-keyed slice (tabs, activeTab, pins,
// expansion) re-projects through ONE projection so a successful move never
// leaves dead tabs pointing at the old path or orphan pins. `project`
// returns the new path, the same path (untouched), or null (deleted).
export function remapWorkbenchPaths(
  state: WorkbenchState,
  project: (path: string) => string | null,
): WorkbenchState {
  const seen = new Set<string>();
  const tabs: Array<{ path: string }> = [];
  for (const tab of state.tabs) {
    const next = project(tab.path);
    if (next === null || seen.has(next)) continue;
    seen.add(next);
    tabs.push(next === tab.path ? tab : { path: next });
  }
  const projectedActive = state.activeTab === null ? null : project(state.activeTab);
  const activeTab =
    projectedActive !== null && seen.has(projectedActive)
      ? projectedActive
      : (tabs[tabs.length - 1]?.path ?? null);
  const remapList = (list: string[]): string[] => {
    const out: string[] = [];
    for (const path of list) {
      const next = project(path);
      if (next !== null && !out.includes(next)) out.push(next);
    }
    return out;
  };
  return {
    ...state,
    tabs,
    activeTab,
    expandedFolders: remapList(state.expandedFolders),
    pinned: remapList(state.pinned),
    recentFiles: remapList(state.recentFiles),
  };
}

// Persistence (.dohc/ui-state.json via the narrow get/set IPC pair).
// serialize produces the zod-validated wire shape; parse is TOLERANT — a
// missing, corrupt, or foreign-shaped value yields defaults, field by field,
// never an error (windowState precedent).
export function serializeUiState(state: WorkbenchState): WorkspaceUiState {
  return {
    version: 1,
    activeView: state.activeView,
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: clampSidebarWidth(state.sidebarWidth),
    tabs: state.tabs.map((tab) => tab.path),
    activeTab: state.activeTab,
    historyVisible: state.historyVisible,
    historyWidth: clampHistoryWidth(state.historyWidth),
    expandedFolders: state.expandedFolders,
    pinned: state.pinned,
    recentFiles: state.recentFiles,
  };
}

function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

export function parseUiState(raw: unknown): WorkbenchState {
  const defaults = defaultWorkbenchState();
  if (typeof raw !== "object" || raw === null) return defaults;
  const value = raw as Record<string, unknown>;
  // Adversarial boundary: read only OWN fields (a polluted prototype must not
  // inject state) and collect tab paths with a loop that STOPS once the cap
  // is reached — never materialize/filter a huge foreign array first.
  const own = (key: string): unknown =>
    Object.hasOwn(value, key) ? value[key] : undefined;
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
  const paths = collectPaths(own("tabs"), MAX_OPEN_TABS);
  const rawActiveTab = own("activeTab");
  const activeTab =
    typeof rawActiveTab === "string" && paths.includes(rawActiveTab)
      ? rawActiveTab
      : (paths[0] ?? null);
  const rawView = own("activeView");
  const rawSidebarVisible = own("sidebarVisible");
  const rawSidebarWidth = own("sidebarWidth");
  const rawHistoryVisible = own("historyVisible");
  const rawHistoryWidth = own("historyWidth");
  return {
    activeView: isViewId(rawView) ? rawView : defaults.activeView,
    sidebarVisible:
      typeof rawSidebarVisible === "boolean"
        ? rawSidebarVisible
        : defaults.sidebarVisible,
    sidebarWidth:
      typeof rawSidebarWidth === "number"
        ? clampSidebarWidth(rawSidebarWidth)
        : defaults.sidebarWidth,
    tabs: paths.map((path) => ({ path })),
    activeTab,
    historyVisible:
      typeof rawHistoryVisible === "boolean"
        ? rawHistoryVisible
        : defaults.historyVisible,
    historyWidth:
      typeof rawHistoryWidth === "number"
        ? clampHistoryWidth(rawHistoryWidth)
        : defaults.historyWidth,
    expandedFolders: collectPaths(own("expandedFolders"), MAX_EXPANDED_FOLDERS),
    pinned: collectPaths(own("pinned"), MAX_PINNED_PATHS),
    recentFiles: collectPaths(own("recentFiles"), MAX_RECENT_FILES),
  };
}
