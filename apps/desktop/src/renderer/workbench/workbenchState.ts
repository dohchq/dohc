// Pure workbench model (Phase E2): activity-bar view, side-panel visibility
// and width, open editor tabs, and the right-hand Chats panel. Pure like
// window/windowState.ts so every transition and the persistence round-trip
// are unit-tested without Electron. `dirty` is runtime-only (derived from the
// editor's save state) and never lives here or on disk.

import type { WorkspaceUiState } from "../../ipc/bridgeContract";

export const VIEW_IDS = [
  "explorer",
  "search",
  "graph",
  "sites",
  "history",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];
export const GRAPH_TAB_PATH = "dohc://graph";
export const HISTORY_TAB_PATH = "dohc://history";
// Chats expanded to a full editor tab (singleton, graph/history precedent).
export const CHATS_TAB_PATH = "dohc://chats";
export const HISTORY_DIFF_TAB_PREFIX = "dohc://history-diff/";
export const SITE_TAB_PREFIX = "dohc://site/";
export const VERSION_COMPARE_TAB_PREFIX = "dohc://versions/compare/";
// Engine moment diff (PR 0M-5): flagged workspaces open history diffs by
// MOMENT id, not legacy change-set id.
export const MOMENT_DIFF_TAB_PREFIX = "dohc://moment-diff/";

export function momentDiffTabPath(momentId: string): string {
  return `${MOMENT_DIFF_TAB_PREFIX}${encodeURIComponent(momentId)}`;
}

export function isMomentDiffTabPath(path: string | null): boolean {
  return typeof path === "string" && path.startsWith(MOMENT_DIFF_TAB_PREFIX);
}

export function parseMomentDiffTabPath(path: string | null): string | null {
  if (typeof path !== "string" || !isMomentDiffTabPath(path)) return null;
  try {
    const momentId = decodeURIComponent(path.slice(MOMENT_DIFF_TAB_PREFIX.length));
    return momentId.length > 0 ? momentId : null;
  } catch {
    return null;
  }
}

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

export function isChatsTabPath(path: string | null): boolean {
  return path === CHATS_TAB_PATH;
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
    isChatsTabPath(path) ||
    isHistoryDiffTabPath(path) ||
    isMomentDiffTabPath(path) ||
    isVersionCompareTabPath(path) ||
    isSiteTabPath(path)
  );
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

export interface WorkbenchState {
  activeView: ViewId;
  sidebarVisible: boolean;
  sidebarWidth: number;
  // Editor groups appear in horizontal visual order. A path can be open once
  // in each group, while each group owns its own active tab.
  editorGroups: EditorGroup[];
  activeEditorGroup: string;
  // The right-hand Chats panel (VS Code's secondary sidebar: toggleable,
  // resizable, hidden by default). Independent of the left panel entirely,
  // and only rendered for workspace-engine-flagged workspaces.
  chatsVisible: boolean;
  chatsWidth: number;
  // Max height of the explorer's Open Editors list (VS Code-style resizable
  // section): the list caps here and scrolls internally; shorter lists shrink
  // to fit.
  openEditorsHeight: number;
  // Explorer state (Phase E3), persisted with the rest: which folders are
  // expanded and which paths are pinned to the favorites section.
  expandedFolders: string[];
  pinned: string[];
  // Recently opened files (Phase E5.0), most recent FIRST, capped — boosts
  // quick-open ranking. Persisted with the rest of the ui-state.
  recentFiles: string[];
}

type EditorTransitionActivation = "target" | "preserve";

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 2400;
export const SIDEBAR_DEFAULT_WIDTH = 240;
export const CHATS_MIN_WIDTH = 240;
export const CHATS_MAX_WIDTH = 2400;
export const CHATS_DEFAULT_WIDTH = 320;
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
// Recent-files list for quick-open ranking (Phase E5.0).
export const MAX_RECENT_FILES = 20;

export function defaultWorkbenchState(): WorkbenchState {
  return {
    activeView: "explorer",
    sidebarVisible: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    editorGroups: [
      { id: DEFAULT_EDITOR_GROUP_ID, tabs: [], activeTab: null, size: 1 },
    ],
    activeEditorGroup: DEFAULT_EDITOR_GROUP_ID,
    chatsVisible: false,
    chatsWidth: CHATS_DEFAULT_WIDTH,
    openEditorsHeight: OPEN_EDITORS_DEFAULT_HEIGHT,
    expandedFolders: [],
    pinned: [],
    recentFiles: [],
  };
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function clampChatsWidth(width: number): number {
  if (!Number.isFinite(width)) return CHATS_DEFAULT_WIDTH;
  return Math.min(CHATS_MAX_WIDTH, Math.max(CHATS_MIN_WIDTH, Math.round(width)));
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
  if (isChatsTabPath(path)) {
    const existingGroup = state.editorGroups.find((group) =>
      group.tabs.some((tab) => tab.path === path),
    );
    if (existingGroup) return activateTab(state, existingGroup.id, path);
  }
  const target = state.editorGroups.find((group) => group.id === targetGroupId)
    ? targetGroupId
    : state.activeEditorGroup;
  if (findTabInGroup(state, target, path)) return activateTab(state, target, path);

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
    tabs: [...group.tabs, { path }],
    activeTab: path,
  }));
  return next.activeEditorGroup === target
    ? next
    : { ...next, activeEditorGroup: target };
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
  if (isChatsTabPath(requestedSource?.activeTab ?? null)) return state;
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
  const boundedLeftSize = Math.min(
    Math.max(leftSize, pairSize * 0.05),
    pairSize * 0.95,
  );
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

export function toggleChats(state: WorkbenchState): WorkbenchState {
  return { ...state, chatsVisible: !state.chatsVisible };
}

export function setSidebarWidth(state: WorkbenchState, width: number): WorkbenchState {
  const clamped = clampSidebarWidth(width);
  return clamped === state.sidebarWidth ? state : { ...state, sidebarWidth: clamped };
}

export function setChatsWidth(state: WorkbenchState, width: number): WorkbenchState {
  const clamped = clampChatsWidth(width);
  return clamped === state.chatsWidth ? state : { ...state, chatsWidth: clamped };
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

// Rename/move/delete remap: every path-keyed slice re-projects through one
// projection. Tab collisions are removed within each group.
export function remapWorkbenchPaths(
  state: WorkbenchState,
  project: (path: string) => string | null,
): WorkbenchState {
  const projected = new Map<string, string | null>();
  const editorGroups = state.editorGroups.map((group) => {
    const seen = new Set<string>();
    const tabs: WorkbenchTab[] = [];
    for (const tab of group.tabs) {
      const next = project(tab.path);
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
  return {
    ...state,
    editorGroups,
    expandedFolders: remapList(state.expandedFolders),
    pinned: remapList(state.pinned),
    recentFiles: remapList(state.recentFiles),
  };
}

// Restored tabs can outlive their files: a version rollback, an external
// delete, or a share pull changes the tree without an explorer op, so
// remapWorkbenchPaths never sees it and Open Editors keeps offering a path
// that is gone.
//
// Scoped to `restoredPaths` — the tabs that came from stored ui-state. Their
// files all existed when the app started, so any listing that omits one is
// reporting a real deletion, and the check can safely re-run on EVERY listing
// (a shared workspace lists twice on open: once at mount, once after the pull
// lands). A tab opened this session is never in the set, so a listing that
// raced its create can never close it.
//
// Tabs only: pinned paths, expanded folders and recent files include FOLDERS,
// which no file listing carries. Virtual tabs (dohc://graph, chats, a moment
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
        isVirtualTabPath(tab.path) ||
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
// serialize produces the zod-validated wire shape; parse is TOLERANT — a
// missing, corrupt, or foreign-shaped value yields defaults, field by field,
// never an error (windowState precedent).
export function serializeUiState(state: WorkbenchState): WorkspaceUiState {
  const editorGroups = normalizeEditorGroupSizes(state.editorGroups);
  return {
    version: 2,
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
    chatsVisible: state.chatsVisible,
    chatsWidth: clampChatsWidth(state.chatsWidth),
    openEditorsHeight: clampOpenEditorsHeight(state.openEditorsHeight),
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
  // Version 2 replaces the flat tab contract. Earlier versions reset instead
  // of being migrated or accepted through aliases.
  if (own("version") !== 2) return defaults;
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
  const discardedActiveChatsGroups = new Set<string>();
  let chatsOwnerGroupId: string | null = null;
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
      const rawActiveTab = groupOwn("activeTab");
      let discardedChats = false;
      if (Array.isArray(rawTabs)) {
        for (const tab of rawTabs) {
          if (tabCount >= MAX_OPEN_TABS) break;
          if (
            typeof tab !== "string" ||
            tab.length === 0 ||
            tab.length > 4096 ||
            tabPaths.has(tab)
          ) {
            continue;
          }
          if (tab === CHATS_TAB_PATH && chatsOwnerGroupId !== null) {
            discardedChats = true;
            continue;
          }
          tabPaths.add(tab);
          if (tab === CHATS_TAB_PATH) chatsOwnerGroupId = id;
          tabCount += 1;
          tabs.push({ path: tab });
        }
      }
      if (
        discardedChats &&
        rawActiveTab === CHATS_TAB_PATH &&
        chatsOwnerGroupId !== null
      ) {
        discardedActiveChatsGroups.add(id);
      }
      const activeTab =
        typeof rawActiveTab === "string" &&
        tabs.some((tab) => tab.path === rawActiveTab)
          ? rawActiveTab
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
  if (
    discardedActiveChatsGroups.has(activeEditorGroup) &&
    chatsOwnerGroupId !== null
  ) {
    activeEditorGroup = chatsOwnerGroupId;
    normalizedGroups = normalizedGroups.map((group) =>
      group.id === chatsOwnerGroupId && group.activeTab !== CHATS_TAB_PATH
        ? { ...group, activeTab: CHATS_TAB_PATH }
        : group,
    );
  }
  const rawView = own("activeView");
  const rawSidebarVisible = own("sidebarVisible");
  const rawSidebarWidth = own("sidebarWidth");
  const rawChatsVisible = own("chatsVisible");
  const rawChatsWidth = own("chatsWidth");
  const rawOpenEditorsHeight = own("openEditorsHeight");
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
    editorGroups: normalizedGroups,
    activeEditorGroup,
    chatsVisible:
      typeof rawChatsVisible === "boolean"
        ? rawChatsVisible
        : defaults.chatsVisible,
    chatsWidth:
      typeof rawChatsWidth === "number"
        ? clampChatsWidth(rawChatsWidth)
        : defaults.chatsWidth,
    openEditorsHeight:
      typeof rawOpenEditorsHeight === "number"
        ? clampOpenEditorsHeight(rawOpenEditorsHeight)
        : defaults.openEditorsHeight,
    expandedFolders: collectPaths(own("expandedFolders"), MAX_EXPANDED_FOLDERS),
    pinned: collectPaths(own("pinned"), MAX_PINNED_PATHS),
    recentFiles: collectPaths(own("recentFiles"), MAX_RECENT_FILES),
  };
}
