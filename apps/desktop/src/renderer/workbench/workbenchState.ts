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
  "apps",
  "agent",
  "history",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export interface WorkbenchState {
  activeView: ViewId;
  sidebarVisible: boolean;
  sidebarWidth: number;
  tabs: Array<{ path: string }>;
  activeTab: string | null;
  // The right-hand history rail (default ON — specs assert the timeline with
  // zero clicks). Independent of the left panel's History view.
  historyVisible: boolean;
}

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 240;
// Bounds the persisted payload (and the tab strip) — not a UX target.
export const MAX_OPEN_TABS = 100;

export function defaultWorkbenchState(): WorkbenchState {
  return {
    activeView: "explorer",
    sidebarVisible: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    tabs: [],
    activeTab: null,
    historyVisible: true,
  };
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

// Open (or re-activate) a file's tab. No duplicates; opening always
// activates. At the cap the oldest tab gives way rather than refusing.
export function openTab(state: WorkbenchState, path: string): WorkbenchState {
  const exists = state.tabs.some((tab) => tab.path === path);
  if (exists) {
    return state.activeTab === path ? state : { ...state, activeTab: path };
  }
  const tabs =
    state.tabs.length >= MAX_OPEN_TABS
      ? [...state.tabs.slice(1), { path }]
      : [...state.tabs, { path }];
  return { ...state, tabs, activeTab: path };
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
  };
}

function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

export function parseUiState(raw: unknown): WorkbenchState {
  const defaults = defaultWorkbenchState();
  if (typeof raw !== "object" || raw === null) return defaults;
  const value = raw as Record<string, unknown>;
  const paths = Array.isArray(value.tabs)
    ? [
        ...new Set(
          value.tabs.filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0 && path.length <= 4096,
          ),
        ),
      ].slice(0, MAX_OPEN_TABS)
    : [];
  const activeTab =
    typeof value.activeTab === "string" && paths.includes(value.activeTab)
      ? value.activeTab
      : (paths[0] ?? null);
  return {
    activeView: isViewId(value.activeView) ? value.activeView : defaults.activeView,
    sidebarVisible:
      typeof value.sidebarVisible === "boolean"
        ? value.sidebarVisible
        : defaults.sidebarVisible,
    sidebarWidth:
      typeof value.sidebarWidth === "number"
        ? clampSidebarWidth(value.sidebarWidth)
        : defaults.sidebarWidth,
    tabs: paths.map((path) => ({ path })),
    activeTab,
    historyVisible:
      typeof value.historyVisible === "boolean"
        ? value.historyVisible
        : defaults.historyVisible,
  };
}
