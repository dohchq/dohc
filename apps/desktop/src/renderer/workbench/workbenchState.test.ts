import { describe, expect, it } from "vitest";
import {
  activateTab,
  clampHistoryWidth,
  clampSidebarWidth,
  closeTab,
  defaultWorkbenchState,
  HISTORY_DEFAULT_WIDTH,
  historyDiffTabPath,
  HISTORY_MAX_WIDTH,
  HISTORY_MIN_WIDTH,
  HISTORY_TAB_PATH,
  CHATS_TAB_PATH,
  isChatsTabPath,
  isHistoryDiffTabPath,
  isHistoryTabPath,
  isMomentDiffTabPath,
  momentDiffTabPath,
  parseMomentDiffTabPath,
  isVersionCompareTabPath,
  parseVersionCompareTabPath,
  versionCompareTabPath,
  isSiteTabPath,
  isVirtualTabPath,
  moveTab,
  openTab,
  parseHistoryDiffTabPath,
  parseSiteTabPath,
  parseUiState,
  serializeUiState,
  setSidebarWidth,
  setHistoryWidth,
  setView,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  toggleHistory,
  toggleSidebar,
  MAX_OPEN_TABS,
  MAX_EXPANDED_FOLDERS,
  MAX_PINNED_PATHS,
  MAX_RECENT_FILES,
  recordRecentFile,
  remapWorkbenchPaths,
  setFolderExpanded,
  siteTabPath,
  toggleFolderExpanded,
  togglePinned,
  type WorkbenchState,
} from "./workbenchState";

function withTabs(...paths: string[]): WorkbenchState {
  return paths.reduce(openTab, defaultWorkbenchState());
}

describe("tabs", () => {
  it("openTab appends and activates; re-opening never duplicates", () => {
    const state = withTabs("a.md", "b.md", "a.md");
    expect(state.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(state.activeTab).toBe("a.md");
  });

  it("openTab of the already-active tab is a no-op (same reference)", () => {
    const state = withTabs("a.md");
    expect(openTab(state, "a.md")).toBe(state);
  });

  it("openTab at the cap drops the oldest tab instead of refusing", () => {
    let state = defaultWorkbenchState();
    for (let i = 0; i < MAX_OPEN_TABS; i++) state = openTab(state, `f${i}.md`);
    state = openTab(state, "new.md");
    expect(state.tabs).toHaveLength(MAX_OPEN_TABS);
    expect(state.tabs[0].path).toBe("f1.md");
    expect(state.activeTab).toBe("new.md");
  });

  it("openTab at the cap NEVER evicts the active tab (the only one that can hold a dirty draft)", () => {
    let state = defaultWorkbenchState();
    for (let i = 0; i < MAX_OPEN_TABS; i++) state = openTab(state, `f${i}.md`);
    // Make the OLDEST tab the active one — the naive evict-index-0 would
    // drop the exact tab whose mounted editor may hold an unsaved draft.
    state = activateTab(state, "f0.md");
    state = openTab(state, "new.md");
    expect(state.tabs).toHaveLength(MAX_OPEN_TABS);
    expect(state.tabs.some((tab) => tab.path === "f0.md")).toBe(true);
    // The oldest NON-active tab gave way instead.
    expect(state.tabs.some((tab) => tab.path === "f1.md")).toBe(false);
    expect(state.activeTab).toBe("new.md");
  });

  it("recognizes history as a virtual workbench tab", () => {
    expect(isHistoryTabPath(HISTORY_TAB_PATH)).toBe(true);
    expect(isVirtualTabPath(HISTORY_TAB_PATH)).toBe(true);
    expect(isVirtualTabPath("notes/today.md")).toBe(false);
  });

  it("recognizes chats as a virtual workbench tab", () => {
    expect(isChatsTabPath(CHATS_TAB_PATH)).toBe(true);
    expect(isChatsTabPath("dohc://chats/extra")).toBe(false);
    expect(isChatsTabPath(null)).toBe(false);
    expect(isVirtualTabPath(CHATS_TAB_PATH)).toBe(true);
  });

  it("recognizes history file diffs as virtual tabs with encoded file identity", () => {
    const path = historyDiffTabPath("change 1", "notes/today plan.md");
    expect(isHistoryDiffTabPath(path)).toBe(true);
    expect(isVirtualTabPath(path)).toBe(true);
    expect(parseHistoryDiffTabPath(path)).toEqual({
      changeSetId: "change 1",
      filePath: "notes/today plan.md",
    });
    expect(parseHistoryDiffTabPath("dohc://history-diff/change-only")).toBeNull();
    expect(parseHistoryDiffTabPath("notes/today.md")).toBeNull();
  });

  it("recognizes engine moment diffs as virtual tabs with encoded moment ids", () => {
    const path = momentDiffTabPath("moment id/with strange chars");
    expect(isMomentDiffTabPath(path)).toBe(true);
    expect(isVirtualTabPath(path)).toBe(true);
    expect(parseMomentDiffTabPath(path)).toBe("moment id/with strange chars");
    expect(parseMomentDiffTabPath("dohc://moment-diff/")).toBeNull();
    expect(parseMomentDiffTabPath("dohc://moment-diff/%ZZ")).toBeNull();
    expect(parseMomentDiffTabPath("notes/today.md")).toBeNull();
    expect(parseMomentDiffTabPath(null)).toBeNull();
  });

  it("recognizes version compare pages as virtual tabs with encoded version ids", () => {
    const path = versionCompareTabPath("version id/with strange chars");
    expect(isVersionCompareTabPath(path)).toBe(true);
    expect(isVirtualTabPath(path)).toBe(true);
    expect(parseVersionCompareTabPath(path)).toBe("version id/with strange chars");
    expect(parseVersionCompareTabPath("dohc://versions/compare/")).toBeNull();
    expect(parseVersionCompareTabPath("dohc://versions/compare/%ZZ")).toBeNull();
    expect(parseVersionCompareTabPath("notes/today.md")).toBeNull();
    expect(parseVersionCompareTabPath(null)).toBeNull();
  });

  it("recognizes site previews as virtual tabs with encoded site roots", () => {
    const path = siteTabPath("clients/acme website");
    expect(isSiteTabPath(path)).toBe(true);
    expect(isVirtualTabPath(path)).toBe(true);
    expect(parseSiteTabPath(path)).toBe("clients/acme website");
    expect(parseSiteTabPath("dohc://site/")).toBeNull();
    expect(parseSiteTabPath(null)).toBeNull();
    expect(parseSiteTabPath("not-a-site-path")).toBeNull();

    const reservedRoot = "clients/site/nested?view=main#summary";
    expect(parseSiteTabPath(siteTabPath(reservedRoot))).toBe(reservedRoot);
  });

  it("activateTab only activates an OPEN tab", () => {
    const state = withTabs("a.md", "b.md");
    expect(activateTab(state, "a.md").activeTab).toBe("a.md");
    expect(activateTab(state, "ghost.md")).toBe(state);
  });

  it("closing the active tab activates the neighbor that slid into its slot", () => {
    const state = activateTab(withTabs("a.md", "b.md", "c.md"), "b.md");
    const next = closeTab(state, "b.md");
    expect(next.tabs.map((tab) => tab.path)).toEqual(["a.md", "c.md"]);
    expect(next.activeTab).toBe("c.md");
  });

  it("closing the LAST active tab falls back to the new last tab, then null", () => {
    const last = withTabs("a.md", "b.md"); // active: b.md
    const afterLast = closeTab(last, "b.md");
    expect(afterLast.activeTab).toBe("a.md");
    expect(closeTab(afterLast, "a.md").activeTab).toBeNull();
  });

  it("closing an inactive tab keeps the active one", () => {
    const state = withTabs("a.md", "b.md", "c.md"); // active: c.md
    const next = closeTab(state, "a.md");
    expect(next.activeTab).toBe("c.md");
    expect(next.tabs.map((tab) => tab.path)).toEqual(["b.md", "c.md"]);
  });

  it("closing an unknown tab is a no-op (same reference)", () => {
    const state = withTabs("a.md");
    expect(closeTab(state, "ghost.md")).toBe(state);
  });

  it("moveTab reorders forward and backward without touching activation", () => {
    const state = withTabs("a.md", "b.md", "c.md"); // active: c.md
    const forward = moveTab(state, 0, 2);
    expect(forward.tabs.map((tab) => tab.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(forward.activeTab).toBe("c.md");
    const back = moveTab(forward, 2, 0);
    expect(back.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("moveTab clamps the target and no-ops invalid or same-slot moves (same reference)", () => {
    const state = withTabs("a.md", "b.md");
    expect(moveTab(state, 0, 99).tabs.map((tab) => tab.path)).toEqual(["b.md", "a.md"]);
    expect(moveTab(state, 0, -5)).toBe(state); // clamps to 0 === from
    expect(moveTab(state, -1, 1)).toBe(state); // unknown from (findIndex miss)
    expect(moveTab(state, 5, 0)).toBe(state);
    expect(moveTab(state, 1, 1)).toBe(state);
    expect(moveTab(state, 0.5, 1)).toBe(state);
  });
});

describe("views and panels", () => {
  it("setView switches the view and reveals a hidden panel", () => {
    const hidden = toggleSidebar(defaultWorkbenchState());
    const next = setView(hidden, "search");
    expect(next.activeView).toBe("search");
    expect(next.sidebarVisible).toBe(true);
  });

  it("re-selecting the active view toggles the panel (old collapse button)", () => {
    const state = defaultWorkbenchState();
    const collapsed = setView(state, "explorer");
    expect(collapsed.sidebarVisible).toBe(false);
    expect(setView(collapsed, "explorer").sidebarVisible).toBe(true);
  });

  it("toggleSidebar and toggleHistory flip independently", () => {
    const state = toggleSidebar(defaultWorkbenchState());
    expect(state.sidebarVisible).toBe(false);
    expect(state.historyVisible).toBe(true);
    expect(toggleHistory(state).historyVisible).toBe(false);
  });
});

describe("rail widths", () => {
  it("clamps sidebars into generous bounds and rounds; non-finite resets to the default", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(1200)).toBe(1200);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps history into the same generous resize range", () => {
    expect(clampHistoryWidth(10)).toBe(HISTORY_MIN_WIDTH);
    expect(clampHistoryWidth(9999)).toBe(HISTORY_MAX_WIDTH);
    expect(clampHistoryWidth(1200)).toBe(1200);
    expect(clampHistoryWidth(300.6)).toBe(301);
    expect(clampHistoryWidth(Number.NaN)).toBe(HISTORY_DEFAULT_WIDTH);
    expect(clampHistoryWidth(Number.POSITIVE_INFINITY)).toBe(HISTORY_DEFAULT_WIDTH);
  });

  it("setSidebarWidth stores the clamped width and no-ops on no change", () => {
    const state = defaultWorkbenchState();
    expect(setSidebarWidth(state, 320).sidebarWidth).toBe(320);
    expect(setSidebarWidth(state, SIDEBAR_DEFAULT_WIDTH)).toBe(state);
  });

  it("setHistoryWidth stores the clamped width and no-ops on no change", () => {
    const state = defaultWorkbenchState();
    expect(setHistoryWidth(state, 360).historyWidth).toBe(360);
    expect(setHistoryWidth(state, HISTORY_DEFAULT_WIDTH)).toBe(state);
  });
});

describe("ui-state persistence round-trip", () => {
  it("serialize → parse restores the workbench state", () => {
    let state = withTabs("notes/a.md", "notes/b.md");
    state = setView(state, "history");
    state = setSidebarWidth(state, 333);
    state = setHistoryWidth(state, 444);
    state = toggleHistory(state);
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("parse is tolerant: null/garbage/foreign shapes yield defaults", () => {
    expect(parseUiState(null)).toEqual(defaultWorkbenchState());
    expect(parseUiState("nonsense")).toEqual(defaultWorkbenchState());
    expect(parseUiState({ activeView: "evil", sidebarWidth: "wide" })).toEqual(
      defaultWorkbenchState(),
    );
  });

  it("parse clamps width, dedupes tabs, drops junk entries, bounds the count", () => {
    const state = parseUiState({
      sidebarWidth: 5,
      historyWidth: 9999,
      tabs: ["a.md", "a.md", 42, "", "b.md"],
      activeTab: "missing.md",
    });
    expect(state.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(state.historyWidth).toBe(HISTORY_MAX_WIDTH);
    expect(state.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    // An activeTab that no surviving tab carries falls back to the first tab.
    expect(state.activeTab).toBe("a.md");

    const oversized = parseUiState({
      tabs: Array.from({ length: MAX_OPEN_TABS + 50 }, (_, i) => `f${i}.md`),
    });
    expect(oversized.tabs).toHaveLength(MAX_OPEN_TABS);
  });

  it("parse reads only OWN fields — inherited (prototype) fields never become state", () => {
    // A crafted object inheriting every field from its prototype must parse
    // as if the fields were absent: pure defaults, no tabs.
    const inherited = parseUiState(
      Object.create({
        version: 1,
        activeView: "history",
        sidebarVisible: false,
        sidebarWidth: 480,
        tabs: ["evil.md"],
        activeTab: "evil.md",
        historyVisible: false,
      }),
    );
    expect(inherited).toEqual(defaultWorkbenchState());
  });

  it("parse stops collecting at the cap on huge adversarial arrays and keeps the FIRST valid entries", () => {
    // 100k entries, junk interleaved: the collector must stop once it has
    // MAX_OPEN_TABS valid unique paths (never filter/dedupe the whole array)
    // and keep the first valid entries in order.
    const huge: unknown[] = [];
    for (let i = 0; i < 100_000; i++) {
      huge.push(42, "", `f${i}.md`, `f${i}.md`);
    }
    const state = parseUiState({ tabs: huge, activeTab: "f0.md" });
    expect(state.tabs).toHaveLength(MAX_OPEN_TABS);
    expect(state.tabs[0].path).toBe("f0.md");
    expect(state.tabs[MAX_OPEN_TABS - 1].path).toBe(`f${MAX_OPEN_TABS - 1}.md`);
    expect(state.activeTab).toBe("f0.md");
  });
});

describe("explorer expansion + pins (Phase E3)", () => {
  it("toggleFolderExpanded flips membership; setFolderExpanded no-ops on no change", () => {
    let state = defaultWorkbenchState();
    state = toggleFolderExpanded(state, "notes");
    expect(state.expandedFolders).toEqual(["notes"]);
    expect(setFolderExpanded(state, "notes", true)).toBe(state);
    state = toggleFolderExpanded(state, "notes");
    expect(state.expandedFolders).toEqual([]);
    expect(setFolderExpanded(state, "notes", false)).toBe(state);
  });

  it("togglePinned flips membership and caps at the bound (oldest gives way)", () => {
    let state = defaultWorkbenchState();
    state = togglePinned(state, "a.md");
    state = togglePinned(state, "b.md");
    expect(state.pinned).toEqual(["a.md", "b.md"]);
    state = togglePinned(state, "a.md");
    expect(state.pinned).toEqual(["b.md"]);
    for (let i = 0; i < MAX_PINNED_PATHS + 5; i++) {
      state = togglePinned(state, `pin-${i}.md`);
    }
    expect(state.pinned).toHaveLength(MAX_PINNED_PATHS);
    expect(state.pinned[MAX_PINNED_PATHS - 1]).toBe(
      `pin-${MAX_PINNED_PATHS + 4}.md`,
    );
  });

  it("expansion caps at its bound the same way", () => {
    let state = defaultWorkbenchState();
    for (let i = 0; i < MAX_EXPANDED_FOLDERS + 3; i++) {
      state = setFolderExpanded(state, `dir-${i}`, true);
    }
    expect(state.expandedFolders).toHaveLength(MAX_EXPANDED_FOLDERS);
  });

  it("serialize → parse round-trips expansion and pins; old files parse to empty", () => {
    let state = withTabs("a.md");
    state = setFolderExpanded(state, "notes", true);
    state = togglePinned(state, "a.md");
    const restored = parseUiState(serializeUiState(state));
    expect(restored.expandedFolders).toEqual(["notes"]);
    expect(restored.pinned).toEqual(["a.md"]);
    // A pre-E3 ui-state.json (no explorer fields) parses to empty lists.
    const old = parseUiState({ version: 1, tabs: ["a.md"], activeTab: "a.md" });
    expect(old.expandedFolders).toEqual([]);
    expect(old.pinned).toEqual([]);
  });
});

describe("recent files (Phase E5.0 quick-open ranking)", () => {
  it("records most-recent-first with dedupe; re-opening the head no-ops", () => {
    let state = defaultWorkbenchState();
    state = recordRecentFile(state, "a.md");
    state = recordRecentFile(state, "b.md");
    expect(state.recentFiles).toEqual(["b.md", "a.md"]);
    state = recordRecentFile(state, "a.md");
    expect(state.recentFiles).toEqual(["a.md", "b.md"]);
    expect(recordRecentFile(state, "a.md")).toBe(state); // head re-open: same ref
  });

  it("caps at MAX_RECENT_FILES (oldest gives way)", () => {
    let state = defaultWorkbenchState();
    for (let i = 0; i < MAX_RECENT_FILES + 5; i++) {
      state = recordRecentFile(state, `f-${i}.md`);
    }
    expect(state.recentFiles).toHaveLength(MAX_RECENT_FILES);
    expect(state.recentFiles[0]).toBe(`f-${MAX_RECENT_FILES + 4}.md`);
  });

  it("round-trips through ui-state; old files parse to empty", () => {
    let state = withTabs("a.md");
    state = recordRecentFile(state, "a.md");
    expect(parseUiState(serializeUiState(state)).recentFiles).toEqual(["a.md"]);
    expect(
      parseUiState({ version: 1, tabs: ["a.md"], activeTab: "a.md" }).recentFiles,
    ).toEqual([]);
  });
});

describe("remapWorkbenchPaths (rename/move/delete projection)", () => {
  it("remaps tabs, the active tab, pins, and expansion through one projection", () => {
    let state = withTabs("team/anna.md", "readme.md");
    state = setFolderExpanded(state, "team", true);
    state = togglePinned(state, "team/anna.md");
    const remapped = remapWorkbenchPaths(state, (path) =>
      path === "team" ? "org/team" : path.startsWith("team/") ? `org/${path}` : path,
    );
    expect(remapped.tabs.map((tab) => tab.path)).toEqual([
      "org/team/anna.md",
      "readme.md",
    ]);
    expect(remapped.activeTab).toBe("readme.md");
    expect(remapped.expandedFolders).toEqual(["org/team"]);
    expect(remapped.pinned).toEqual(["org/team/anna.md"]);
  });

  it("a deleted active tab falls back to the last surviving tab; deletions drop pins", () => {
    let state = withTabs("a.md", "junk.md");
    state = togglePinned(state, "junk.md");
    const remapped = remapWorkbenchPaths(state, (path) =>
      path === "junk.md" ? null : path,
    );
    expect(remapped.tabs.map((tab) => tab.path)).toEqual(["a.md"]);
    expect(remapped.activeTab).toBe("a.md");
    expect(remapped.pinned).toEqual([]);
  });

  it("a move that collides two tabs onto one path dedupes them", () => {
    const state = withTabs("a.md", "b.md");
    const remapped = remapWorkbenchPaths(state, () => "same.md");
    expect(remapped.tabs.map((tab) => tab.path)).toEqual(["same.md"]);
    expect(remapped.activeTab).toBe("same.md");
  });
});
