import { describe, expect, it } from "vitest";
import {
  activateTab,
  activeGroup,
  activeTabPath,
  allTabs,
  clampChatsWidth,
  clampOpenEditorsHeight,
  clampSidebarWidth,
  closeTab,
  closeEditorGroup,
  createEditorGroupRight,
  defaultWorkbenchState,
  DEFAULT_EDITOR_GROUP_ID,
  CHATS_DEFAULT_WIDTH,
  historyDiffTabPath,
  CHATS_MAX_WIDTH,
  CHATS_MIN_WIDTH,
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
  isPluginPanelTabPath,
  isVirtualTabPath,
  moveTab,
  openTab,
  parseHistoryDiffTabPath,
  parseSiteTabPath,
  parsePluginPanelTabPath,
  parseUiState,
  pruneMissingRestoredTabs,
  serializeUiState,
  setSidebarWidth,
  setChatsWidth,
  setOpenEditorsHeight,
  setView,
  OPEN_EDITORS_DEFAULT_HEIGHT,
  OPEN_EDITORS_MAX_HEIGHT,
  OPEN_EDITORS_MIN_HEIGHT,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  toggleChats,
  toggleSidebar,
  MAX_EDITOR_GROUPS,
  MAX_OPEN_TABS,
  MAX_EXPANDED_FOLDERS,
  MAX_PINNED_PATHS,
  MAX_RECENT_FILES,
  recordRecentFile,
  remapWorkbenchPaths,
  resizeEditorGroups,
  setFolderExpanded,
  siteTabPath,
  moveTabToGroup,
  pluginPanelTabPath,
  moveTabToNewGroup,
  focusEditorGroup,
  toggleFolderExpanded,
  togglePinned,
  type WorkbenchState,
} from "./workbenchState";

function withTabs(...paths: string[]): WorkbenchState {
  return paths.reduce((state, path) => openTab(state, path), defaultWorkbenchState());
}

describe("tabs", () => {
  it("starts with one focused empty editor group", () => {
    const state = defaultWorkbenchState();
    expect(state.editorGroups).toEqual([
      { id: DEFAULT_EDITOR_GROUP_ID, tabs: [], activeTab: null, size: 1 },
    ]);
    expect(activeGroup(state).id).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(activeTabPath(state)).toBeNull();
  });

  it("openTab appends and activates; re-opening never duplicates", () => {
    const state = withTabs("a.md", "b.md", "a.md");
    expect(allTabs(state).map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(activeTabPath(state)).toBe("a.md");
  });

  it("openTab of the already-active tab is a no-op (same reference)", () => {
    const state = withTabs("a.md");
    expect(openTab(state, "a.md")).toBe(state);
  });

  it("openTab at the cap drops the oldest tab instead of refusing", () => {
    let state = defaultWorkbenchState();
    for (let i = 0; i < MAX_OPEN_TABS; i++) state = openTab(state, `f${i}.md`);
    state = openTab(state, "new.md");
    expect(allTabs(state)).toHaveLength(MAX_OPEN_TABS);
    expect(allTabs(state)[0].path).toBe("f1.md");
    expect(activeTabPath(state)).toBe("new.md");
  });

  it("openTab at the cap NEVER evicts the active tab (the only one that can hold a dirty draft)", () => {
    let state = defaultWorkbenchState();
    for (let i = 0; i < MAX_OPEN_TABS; i++) state = openTab(state, `f${i}.md`);
    // Make the OLDEST tab the active one — the naive evict-index-0 would
    // drop the exact tab whose mounted editor may hold an unsaved draft.
    state = activateTab(state, DEFAULT_EDITOR_GROUP_ID, "f0.md");
    state = openTab(state, "new.md");
    expect(allTabs(state)).toHaveLength(MAX_OPEN_TABS);
    expect(allTabs(state).some((tab) => tab.path === "f0.md")).toBe(true);
    // The oldest NON-active tab gave way instead.
    expect(allTabs(state).some((tab) => tab.path === "f1.md")).toBe(false);
    expect(activeTabPath(state)).toBe("new.md");
  });

  it("never evicts an active tab from any editor group", () => {
    let state = withTabs("left-active.md", "move-right.md");
    state = moveTabToNewGroup(state, DEFAULT_EDITOR_GROUP_ID, "move-right.md", "right");
    for (let i = 0; allTabs(state).length < MAX_OPEN_TABS; i++) {
      state = openTab(state, `f${i}.md`, DEFAULT_EDITOR_GROUP_ID);
    }
    state = activateTab(state, DEFAULT_EDITOR_GROUP_ID, "left-active.md");
    state = openTab(state, "new.md", DEFAULT_EDITOR_GROUP_ID);
    expect(allTabs(state).some((tab) => tab.path === "left-active.md")).toBe(true);
    expect(allTabs(state).some((tab) => tab.path === "move-right.md")).toBe(true);
    expect(activeTabPath(state)).toBe("new.md");
  });

  it("splits a tab right, focuses the new group, and normalizes both sizes", () => {
    const original = withTabs("a.md", "b.md");
    const moved = original.editorGroups[0].tabs[1];
    const state = moveTabToNewGroup(original, DEFAULT_EDITOR_GROUP_ID, "b.md", "right");
    expect(state.editorGroups.map((group) => group.id)).toEqual([
      DEFAULT_EDITOR_GROUP_ID,
      "right",
    ]);
    expect(state.editorGroups.map((group) => group.size)).toEqual([0.5, 0.5]);
    expect(state.editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["a.md"]);
    expect(state.editorGroups[1].tabs[0]).toBe(moved);
    expect(state.activeEditorGroup).toBe("right");
    expect(activeTabPath(state)).toBe("b.md");
  });

  it("copies the active tab into a focused group right without hiding the source", () => {
    const original = withTabs("a.md");
    const state = createEditorGroupRight(
      original,
      DEFAULT_EDITOR_GROUP_ID,
      "right",
    );
    expect(state.editorGroups.map((group) => group.id)).toEqual([
      DEFAULT_EDITOR_GROUP_ID,
      "right",
    ]);
    expect(state.editorGroups[0].activeTab).toBe("a.md");
    expect(state.editorGroups[1]).toMatchObject({
      tabs: [{ path: "a.md" }],
      activeTab: "a.md",
    });
    expect(state.editorGroups[1].tabs[0]).not.toBe(
      original.editorGroups[0].tabs[0],
    );
    expect(state.activeEditorGroup).toBe("right");
  });

  it("keeps the current tab focused when a delayed split completes", () => {
    const original: WorkbenchState = {
      ...defaultWorkbenchState(),
      editorGroups: [
        { id: "left", tabs: [{ path: "a.md" }], activeTab: "a.md", size: 0.5 },
        { id: "right", tabs: [{ path: "b.md" }], activeTab: "b.md", size: 0.5 },
      ],
      activeEditorGroup: "right",
    };

    const state = createEditorGroupRight(original, "left", "split", "preserve");

    expect(state.editorGroups.map((group) => group.id)).toEqual([
      "left",
      "split",
      "right",
    ]);
    expect(state.activeEditorGroup).toBe("right");
    expect(activeTabPath(state)).toBe("b.md");
  });

  it("keeps the current tab focused when a delayed move creates a group", () => {
    const original = withTabs("a.md", "b.md");

    const state = moveTabToNewGroup(
      original,
      DEFAULT_EDITOR_GROUP_ID,
      "a.md",
      "right",
      "preserve",
    );

    expect(state.editorGroups[0].activeTab).toBe("b.md");
    expect(state.activeEditorGroup).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(state.editorGroups[1].tabs.map((tab) => tab.path)).toEqual(["a.md"]);
  });

  it("keeps a delayed move within the group cap when an empty group gained focus", () => {
    const editorGroups = Array.from(
      { length: MAX_OPEN_TABS },
      (_, index) => ({
        id: `group-${index}`,
        tabs: [{ path: `file-${index}.md` }],
        activeTab: `file-${index}.md`,
        size: 1 / MAX_EDITOR_GROUPS,
      }),
    );
    const state: WorkbenchState = {
      ...defaultWorkbenchState(),
      editorGroups: [
        ...editorGroups,
        {
          id: "focused-empty",
          tabs: [],
          activeTab: null,
          size: 1 / MAX_EDITOR_GROUPS,
        },
      ],
      activeEditorGroup: "focused-empty",
    };

    const moved = moveTabToNewGroup(
      state,
      "group-0",
      "file-0.md",
      "delayed-split",
      "preserve",
    );

    expect(moved.editorGroups).toHaveLength(MAX_EDITOR_GROUPS);
    expect(moved.editorGroups.some((group) => group.id === "group-0")).toBe(
      false,
    );
    expect(
      moved.editorGroups.find((group) => group.id === "delayed-split"),
    ).toMatchObject({
      tabs: [{ path: "file-0.md" }],
      activeTab: "file-0.md",
    });
    expect(allTabs(moved)).toHaveLength(MAX_OPEN_TABS);
    expect(new Set(allTabs(moved).map((tab) => tab.path))).toEqual(
      new Set(
        Array.from(
          { length: MAX_OPEN_TABS },
          (_, index) => `file-${index}.md`,
        ),
      ),
    );
    expect(moved.activeEditorGroup).toBe("focused-empty");
    expect(activeTabPath(moved)).toBeNull();
    expect(
      moved.editorGroups.reduce((sum, group) => sum + group.size, 0),
    ).toBeCloseTo(1);
    expect(serializeUiState(moved).editorGroups).toHaveLength(
      MAX_EDITOR_GROUPS,
    );
  });

  it("keeps the destination tab focused when a delayed cross-group move completes", () => {
    const original: WorkbenchState = {
      ...defaultWorkbenchState(),
      editorGroups: [
        { id: "left", tabs: [{ path: "a.md" }], activeTab: "a.md", size: 0.5 },
        {
          id: "right",
          tabs: [{ path: "b.md" }, { path: "c.md" }],
          activeTab: "c.md",
          size: 0.5,
        },
      ],
      activeEditorGroup: "right",
    };

    const state = moveTabToGroup(
      original,
      "left",
      "right",
      "a.md",
      0,
      "preserve",
    );

    expect(state.editorGroups[1].tabs.map((tab) => tab.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
    expect(state.editorGroups[1].activeTab).toBe("c.md");
    expect(state.activeEditorGroup).toBe("right");
    expect(state.editorGroups[0].tabs).toEqual([]);
  });

  it("keeps Chats in its existing editor group", () => {
    let state = withTabs(CHATS_TAB_PATH, "a.md");
    state = moveTabToNewGroup(
      state,
      DEFAULT_EDITOR_GROUP_ID,
      "a.md",
      "right",
    );

    state = openTab(state, CHATS_TAB_PATH, "right");

    expect(
      allTabs(state).filter((tab) => tab.path === CHATS_TAB_PATH),
    ).toHaveLength(1);
    expect(state.activeEditorGroup).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(activeTabPath(state)).toBe(CHATS_TAB_PATH);
    expect(
      createEditorGroupRight(
        state,
        DEFAULT_EDITOR_GROUP_ID,
        "split",
      ),
    ).toBe(state);
  });

  it.each([
    ["site preview", siteTabPath("client-portal")],
    ["plugin panel", pluginPanelTabPath("hello-plugin", "main")],
  ])("keeps a process-owning %s in its existing editor group", (_label, path) => {
    let state = withTabs(path, "a.md");
    state = moveTabToNewGroup(
      state,
      DEFAULT_EDITOR_GROUP_ID,
      "a.md",
      "right",
    );

    state = openTab(state, path, "right");

    expect(allTabs(state).filter((tab) => tab.path === path)).toHaveLength(1);
    expect(state.activeEditorGroup).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(activeTabPath(state)).toBe(path);
    expect(
      createEditorGroupRight(
        state,
        DEFAULT_EDITOR_GROUP_ID,
        "split",
      ),
    ).toBe(state);
  });

  it("repeated single-tab splits replace the obsolete empty drop target", () => {
    let state = moveTabToNewGroup(
      withTabs("a.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "a.md",
      "right-1",
    );
    expect(state.editorGroups.map((group) => group.id)).toEqual([
      DEFAULT_EDITOR_GROUP_ID,
      "right-1",
    ]);

    state = moveTabToNewGroup(state, "right-1", "a.md", "right-2");
    expect(state.editorGroups.map((group) => group.id)).toEqual([
      "right-1",
      "right-2",
    ]);
    expect(state.editorGroups.filter((group) => group.tabs.length === 0)).toHaveLength(1);
    expect(state.editorGroups.reduce((sum, group) => sum + group.size, 0)).toBe(1);
  });

  it("opens the same path once per group and focuses the requested group", () => {
    let state = moveTabToNewGroup(
      withTabs("a.md", "b.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "b.md",
      "right",
    );
    state = focusEditorGroup(state, DEFAULT_EDITOR_GROUP_ID);
    state = openTab(state, "b.md");
    expect(allTabs(state).filter((tab) => tab.path === "b.md")).toHaveLength(2);
    expect(state.editorGroups[0].tabs.map((tab) => tab.path)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(state.editorGroups[1].tabs.map((tab) => tab.path)).toEqual(["b.md"]);
    expect(state.activeEditorGroup).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(openTab(state, "b.md")).toBe(state);
  });

  it("evicts an inactive tab instance even when its path is active elsewhere", () => {
    const editorGroups = Array.from({ length: MAX_OPEN_TABS / 2 }, (_, index) => ({
      id: `group-${index}`,
      tabs: [
        { path: `file-${index}.md` },
        { path: `file-${(index + 1) % (MAX_OPEN_TABS / 2)}.md` },
      ],
      activeTab: `file-${index}.md`,
      size: 2 / MAX_OPEN_TABS,
    }));
    const state: WorkbenchState = {
      ...defaultWorkbenchState(),
      editorGroups,
      activeEditorGroup: "group-0",
    };
    const next = openTab(state, "new.md", "group-0");
    expect(allTabs(next)).toHaveLength(MAX_OPEN_TABS);
    expect(next.editorGroups[0].tabs.map((tab) => tab.path)).toEqual([
      "file-0.md",
      "new.md",
    ]);
    expect(next.editorGroups[1].activeTab).toBe("file-1.md");
  });

  it("splits at the tab cap by evicting the oldest inactive tab instance", () => {
    let state = defaultWorkbenchState();
    for (let index = 0; index < MAX_OPEN_TABS; index++) {
      state = openTab(state, `file-${index}.md`);
    }
    const active = state.editorGroups[0].tabs.at(-1)!;
    const split = createEditorGroupRight(
      state,
      DEFAULT_EDITOR_GROUP_ID,
      "right",
    );
    expect(allTabs(split)).toHaveLength(MAX_OPEN_TABS);
    expect(split.editorGroups[0].tabs.some((tab) => tab.path === "file-0.md")).toBe(
      false,
    );
    expect(split.editorGroups[1].tabs[0].path).toBe(active.path);
    expect(split.editorGroups[1].tabs[0]).not.toBe(active);
  });

  it("moves a tab between groups, repairs focus, and inserts at the drop slot", () => {
    let state = withTabs("a.md", "b.md", "c.md", "d.md");
    state = moveTabToNewGroup(
      state,
      DEFAULT_EDITOR_GROUP_ID,
      "d.md",
      "right",
    );
    state = activateTab(state, DEFAULT_EDITOR_GROUP_ID, "b.md");
    const moved = state.editorGroups[0].tabs[1];
    const next = moveTabToGroup(
      state,
      DEFAULT_EDITOR_GROUP_ID,
      "right",
      "b.md",
      0,
    );
    expect(next.editorGroups[0].tabs.map((tab) => tab.path)).toEqual([
      "a.md",
      "c.md",
    ]);
    expect(next.editorGroups[0].activeTab).toBe("c.md");
    expect(next.editorGroups[1].tabs.map((tab) => tab.path)).toEqual([
      "b.md",
      "d.md",
    ]);
    expect(next.editorGroups[1].tabs[0]).toBe(moved);
    expect(next.editorGroups[1].activeTab).toBe("b.md");
    expect(next.activeEditorGroup).toBe("right");
  });

  it("moves onto an existing destination copy without duplicating it", () => {
    const split = createEditorGroupRight(
      withTabs("a.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "right",
    );
    const destination = split.editorGroups[1].tabs[0];
    const next = moveTabToGroup(
      split,
      DEFAULT_EDITOR_GROUP_ID,
      "right",
      "a.md",
      1,
    );
    expect(next.editorGroups[0]).toMatchObject({ tabs: [], activeTab: null });
    expect(next.editorGroups[1].tabs).toEqual([destination]);
    expect(next.activeEditorGroup).toBe("right");
  });

  it("resizes adjacent groups without changing their combined size", () => {
    const state = moveTabToNewGroup(
      withTabs("a.md", "b.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "b.md",
      "right",
    );
    const resized = resizeEditorGroups(state, DEFAULT_EDITOR_GROUP_ID, "right", 0.3);
    expect(resized.editorGroups.map((group) => group.size)).toEqual([0.3, 0.7]);
    expect(resizeEditorGroups(state, "right", DEFAULT_EDITOR_GROUP_ID, 0.3)).toBe(state);
    expect(
      resizeEditorGroups(state, DEFAULT_EDITOR_GROUP_ID, "right", 0).editorGroups.map(
        (group) => group.size,
      ),
    ).toEqual([0.05, 0.95]);
  });

  it("closes a group, normalizes survivors, and never removes the last group", () => {
    const state = moveTabToNewGroup(
      withTabs("a.md", "b.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "b.md",
      "right",
    );
    const closed = closeEditorGroup(state, "right");
    expect(closed.editorGroups).toHaveLength(1);
    expect(closed.editorGroups[0].size).toBe(1);
    expect(closed.activeEditorGroup).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(closeEditorGroup(closed, DEFAULT_EDITOR_GROUP_ID)).toBe(closed);
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

  it("recognizes plugin panels as virtual tabs with two encoded identities", () => {
    const path = pluginPanelTabPath("@dohc/acme plugin", "reports/main");
    expect(path).toBe(
      "dohc://plugin-panel/%40dohc%2Facme%20plugin/reports%2Fmain",
    );
    expect(isPluginPanelTabPath(path)).toBe(true);
    expect(isVirtualTabPath(path)).toBe(true);
    expect(parsePluginPanelTabPath(path)).toEqual({
      pluginId: "@dohc/acme plugin",
      panelId: "reports/main",
    });
  });

  it("rejects malformed or empty plugin panel tab paths", () => {
    for (const path of [
      "dohc://plugin-panel/",
      "dohc://plugin-panel/plugin-only",
      "dohc://plugin-panel//panel",
      "dohc://plugin-panel/plugin/",
      "dohc://plugin-panel/plugin/panel/extra",
      "dohc://plugin-panel/%ZZ/panel",
      "not-a-plugin-panel-path",
    ]) {
      expect(parsePluginPanelTabPath(path)).toBeNull();
    }
    expect(parsePluginPanelTabPath(null)).toBeNull();
  });

  it("activateTab only activates an OPEN tab", () => {
    const state = withTabs("a.md", "b.md");
    expect(activateTab(state, DEFAULT_EDITOR_GROUP_ID, "a.md").editorGroups[0].activeTab).toBe("a.md");
    expect(activateTab(state, DEFAULT_EDITOR_GROUP_ID, "ghost.md")).toBe(state);
  });

  it("closing the active tab activates the neighbor that slid into its slot", () => {
    const state = activateTab(withTabs("a.md", "b.md", "c.md"), DEFAULT_EDITOR_GROUP_ID, "b.md");
    const next = closeTab(state, DEFAULT_EDITOR_GROUP_ID, "b.md");
    expect(next.editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["a.md", "c.md"]);
    expect(next.editorGroups[0].activeTab).toBe("c.md");
  });

  it("closing the LAST active tab falls back to the new last tab, then null", () => {
    const last = withTabs("a.md", "b.md"); // active: b.md
    const afterLast = closeTab(last, DEFAULT_EDITOR_GROUP_ID, "b.md");
    expect(activeTabPath(afterLast)).toBe("a.md");
    expect(activeTabPath(closeTab(afterLast, DEFAULT_EDITOR_GROUP_ID, "a.md"))).toBeNull();
  });

  it("closing an inactive tab keeps the active one", () => {
    const state = withTabs("a.md", "b.md", "c.md"); // active: c.md
    const next = closeTab(state, DEFAULT_EDITOR_GROUP_ID, "a.md");
    expect(activeTabPath(next)).toBe("c.md");
    expect(next.editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["b.md", "c.md"]);
  });

  it("closing an unknown tab is a no-op (same reference)", () => {
    const state = withTabs("a.md");
    expect(closeTab(state, DEFAULT_EDITOR_GROUP_ID, "ghost.md")).toBe(state);
  });

  it("moveTab reorders forward and backward without touching activation", () => {
    const state = withTabs("a.md", "b.md", "c.md"); // active: c.md
    const forward = moveTab(state, DEFAULT_EDITOR_GROUP_ID, 0, 2);
    expect(forward.editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(activeTabPath(forward)).toBe("c.md");
    const back = moveTab(forward, DEFAULT_EDITOR_GROUP_ID, 2, 0);
    expect(back.editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("moveTab clamps the target and no-ops invalid or same-slot moves (same reference)", () => {
    const state = withTabs("a.md", "b.md");
    expect(moveTab(state, DEFAULT_EDITOR_GROUP_ID, 0, 99).editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["b.md", "a.md"]);
    expect(moveTab(state, DEFAULT_EDITOR_GROUP_ID, 0, -5)).toBe(state); // clamps to 0 === from
    expect(moveTab(state, DEFAULT_EDITOR_GROUP_ID, -1, 1)).toBe(state);
    expect(moveTab(state, DEFAULT_EDITOR_GROUP_ID, 5, 0)).toBe(state);
    expect(moveTab(state, DEFAULT_EDITOR_GROUP_ID, 1, 1)).toBe(state);
    expect(moveTab(state, DEFAULT_EDITOR_GROUP_ID, 0.5, 1)).toBe(state);
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

  it("toggleSidebar and toggleChats flip independently", () => {
    const state = toggleSidebar(defaultWorkbenchState());
    expect(state.sidebarVisible).toBe(false);
    // The Chats panel is HIDDEN by default (VS Code secondary-sidebar
    // grammar) — unlike the old always-on history rail.
    expect(state.chatsVisible).toBe(false);
    expect(toggleChats(state).chatsVisible).toBe(true);
    expect(toggleChats(state).sidebarVisible).toBe(false);
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

  it("clamps the chats panel into the same generous resize range", () => {
    expect(clampChatsWidth(10)).toBe(CHATS_MIN_WIDTH);
    expect(clampChatsWidth(9999)).toBe(CHATS_MAX_WIDTH);
    expect(clampChatsWidth(1200)).toBe(1200);
    expect(clampChatsWidth(300.6)).toBe(301);
    expect(clampChatsWidth(Number.NaN)).toBe(CHATS_DEFAULT_WIDTH);
    expect(clampChatsWidth(Number.POSITIVE_INFINITY)).toBe(CHATS_DEFAULT_WIDTH);
  });

  it("setSidebarWidth stores the clamped width and no-ops on no change", () => {
    const state = defaultWorkbenchState();
    expect(setSidebarWidth(state, 320).sidebarWidth).toBe(320);
    expect(setSidebarWidth(state, SIDEBAR_DEFAULT_WIDTH)).toBe(state);
  });

  it("setChatsWidth stores the clamped width and no-ops on no change", () => {
    const state = defaultWorkbenchState();
    expect(setChatsWidth(state, 360).chatsWidth).toBe(360);
    expect(setChatsWidth(state, CHATS_DEFAULT_WIDTH)).toBe(state);
  });

  it("clamps the open-editors height into bounds and rounds; non-finite resets to the default", () => {
    expect(clampOpenEditorsHeight(10)).toBe(OPEN_EDITORS_MIN_HEIGHT);
    expect(clampOpenEditorsHeight(9999)).toBe(OPEN_EDITORS_MAX_HEIGHT);
    expect(clampOpenEditorsHeight(300)).toBe(300);
    expect(clampOpenEditorsHeight(300.6)).toBe(301);
    expect(clampOpenEditorsHeight(Number.NaN)).toBe(OPEN_EDITORS_DEFAULT_HEIGHT);
    expect(clampOpenEditorsHeight(Number.POSITIVE_INFINITY)).toBe(
      OPEN_EDITORS_DEFAULT_HEIGHT,
    );
  });

  it("setOpenEditorsHeight stores the clamped height and no-ops on no change", () => {
    const state = defaultWorkbenchState();
    expect(setOpenEditorsHeight(state, 300).openEditorsHeight).toBe(300);
    expect(setOpenEditorsHeight(state, OPEN_EDITORS_DEFAULT_HEIGHT)).toBe(state);
  });
});

describe("ui-state persistence round-trip", () => {
  it("serialize → parse restores the workbench state", () => {
    let state = withTabs("notes/a.md", "notes/b.md");
    state = moveTabToNewGroup(state, DEFAULT_EDITOR_GROUP_ID, "notes/b.md", "right");
    state = openTab(state, "notes/a.md", "right");
    state = resizeEditorGroups(state, DEFAULT_EDITOR_GROUP_ID, "right", 0.35);
    state = setView(state, "history");
    state = setSidebarWidth(state, 333);
    state = setChatsWidth(state, 444);
    state = setOpenEditorsHeight(state, 210);
    state = toggleChats(state);
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("does not migrate or alias the version-1 flat-tab contract", () => {
    expect(
      parseUiState({ version: 1, tabs: ["a.md"], activeTab: "a.md" }),
    ).toEqual(defaultWorkbenchState());
  });

  it("a version-2 file without openEditorsHeight falls back to the default", () => {
    const raw = {
      version: 2,
      editorGroups: [
        { id: "primary", tabs: ["a.md"], activeTab: "a.md", size: 1 },
      ],
      activeEditorGroup: "primary",
    };
    expect(parseUiState(raw).openEditorsHeight).toBe(OPEN_EDITORS_DEFAULT_HEIGHT);
    expect(parseUiState({ ...raw, openEditorsHeight: 7 }).openEditorsHeight).toBe(
      OPEN_EDITORS_MIN_HEIGHT,
    );
    expect(parseUiState({ ...raw, openEditorsHeight: "tall" }).openEditorsHeight).toBe(
      OPEN_EDITORS_DEFAULT_HEIGHT,
    );
  });

  it("parse is tolerant: null/garbage/foreign shapes yield defaults", () => {
    expect(parseUiState(null)).toEqual(defaultWorkbenchState());
    expect(parseUiState("nonsense")).toEqual(defaultWorkbenchState());
    expect(parseUiState({ activeView: "evil", sidebarWidth: "wide" })).toEqual(
      defaultWorkbenchState(),
    );
  });

  it("repairs groups field by field and normalizes positive sizes", () => {
    const state = parseUiState({
      version: 2,
      sidebarWidth: 5,
      chatsWidth: 9999,
      editorGroups: [
        {
          id: "left",
          tabs: ["a.md", "a.md", 42, "", "b.md"],
          activeTab: "missing.md",
          size: 3,
        },
        {
          id: "right",
          tabs: ["b.md", "c.md"],
          activeTab: "c.md",
          size: -1,
        },
        { id: "left", tabs: ["ignored.md"], activeTab: "ignored.md", size: 1 },
      ],
      activeEditorGroup: "missing",
    });
    expect(state.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(state.chatsWidth).toBe(CHATS_MAX_WIDTH);
    expect(state.editorGroups.map((group) => group.id)).toEqual(["left", "right"]);
    expect(state.editorGroups[0].tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(state.editorGroups[0].activeTab).toBe("a.md");
    expect(state.editorGroups[1].tabs.map((tab) => tab.path)).toEqual([
      "b.md",
      "c.md",
    ]);
    expect(state.editorGroups[1].activeTab).toBe("c.md");
    expect(state.editorGroups.map((group) => group.size)).toEqual([0.75, 0.25]);
    expect(state.activeEditorGroup).toBe("left");
  });

  it("keeps the first restored Chats owner and repairs duplicate Chats focus", () => {
    const state = parseUiState({
      version: 2,
      editorGroups: [
        {
          id: "left",
          tabs: [CHATS_TAB_PATH, "shared.md"],
          activeTab: "shared.md",
          size: 0.5,
        },
        {
          id: "right",
          tabs: ["shared.md", CHATS_TAB_PATH, "right.md"],
          activeTab: CHATS_TAB_PATH,
          size: 0.5,
        },
      ],
      activeEditorGroup: "right",
    });

    expect(state.editorGroups[0].tabs.map((tab) => tab.path)).toEqual([
      CHATS_TAB_PATH,
      "shared.md",
    ]);
    expect(state.editorGroups[0].activeTab).toBe(CHATS_TAB_PATH);
    expect(state.editorGroups[1].tabs.map((tab) => tab.path)).toEqual([
      "shared.md",
      "right.md",
    ]);
    expect(state.editorGroups[1].activeTab).toBe("shared.md");
    expect(state.activeEditorGroup).toBe("left");
    expect(
      allTabs(state).filter((tab) => tab.path === CHATS_TAB_PATH),
    ).toHaveLength(1);
  });

  it.each([
    ["site preview", siteTabPath("client-portal")],
    ["plugin panel", pluginPanelTabPath("hello-plugin", "main")],
  ])("keeps the first restored %s owner", (_label, path) => {
    const state = parseUiState({
      version: 2,
      editorGroups: [
        {
          id: "left",
          tabs: [path, "left.md"],
          activeTab: "left.md",
          size: 0.5,
        },
        {
          id: "right",
          tabs: [path, "right.md"],
          activeTab: path,
          size: 0.5,
        },
      ],
      activeEditorGroup: "right",
    });

    expect(allTabs(state).filter((tab) => tab.path === path)).toHaveLength(1);
    expect(state.activeEditorGroup).toBe("left");
    expect(state.editorGroups[0].activeTab).toBe(path);
    expect(state.editorGroups[1].activeTab).toBe("right.md");
  });

  it("does not charge discarded duplicate Chats entries against the tab cap", () => {
    const realFiles = Array.from(
      { length: MAX_OPEN_TABS - 1 },
      (_, index) => `file-${index}.md`,
    );
    const state = parseUiState({
      version: 2,
      editorGroups: [
        {
          id: "left",
          tabs: [CHATS_TAB_PATH],
          activeTab: CHATS_TAB_PATH,
          size: 0.5,
        },
        {
          id: "right",
          tabs: [CHATS_TAB_PATH, ...realFiles],
          activeTab: realFiles[0],
          size: 0.5,
        },
      ],
      activeEditorGroup: "right",
    });

    expect(allTabs(state)).toHaveLength(MAX_OPEN_TABS);
    expect(state.editorGroups[1].tabs.at(-1)?.path).toBe(realFiles.at(-1));
  });

  it("parse reads only OWN fields — inherited (prototype) fields never become state", () => {
    // A crafted object inheriting every field from its prototype must parse
    // as if the fields were absent: pure defaults, no tabs.
    const inherited = parseUiState(
      Object.create({
        version: 2,
        activeView: "history",
        sidebarVisible: false,
        sidebarWidth: 480,
        editorGroups: [
          { id: "evil", tabs: ["evil.md"], activeTab: "evil.md", size: 1 },
        ],
        activeEditorGroup: "evil",
        chatsVisible: true,
      }),
    );
    expect(inherited).toEqual(defaultWorkbenchState());
  });

  it("parse stops collecting tabs at the total cap across adversarial groups", () => {
    // 100k entries, junk interleaved: the collector must stop once it has
    // MAX_OPEN_TABS valid group-local paths (never filter/dedupe the whole array)
    // and keep the first valid entries in order.
    const huge: unknown[] = [];
    for (let i = 0; i < 100_000; i++) {
      huge.push(42, "", `f${i}.md`, `f${i}.md`);
    }
    const state = parseUiState({
      version: 2,
      editorGroups: [
        { id: "left", tabs: huge, activeTab: "f0.md", size: 1 },
        { id: "right", tabs: ["too-late.md"], activeTab: "too-late.md", size: 1 },
      ],
      activeEditorGroup: "left",
    });
    expect(allTabs(state)).toHaveLength(MAX_OPEN_TABS);
    expect(allTabs(state)[0].path).toBe("f0.md");
    expect(allTabs(state)[MAX_OPEN_TABS - 1].path).toBe(
      `f${MAX_OPEN_TABS - 1}.md`,
    );
    expect(activeTabPath(state)).toBe("f0.md");
  });

  it("parse caps editor groups and repairs focus beyond the retained prefix", () => {
    const rawGroups = Array.from(
      { length: MAX_EDITOR_GROUPS + 1 },
      (_, index) => ({
        id: `group-${index}`,
        tabs: [],
        activeTab: null,
        size: 1,
      }),
    );
    const state = parseUiState({
      version: 2,
      editorGroups: rawGroups,
      activeEditorGroup: rawGroups[MAX_EDITOR_GROUPS].id,
    });

    expect(state.editorGroups).toHaveLength(MAX_EDITOR_GROUPS);
    expect(state.editorGroups.at(-1)?.id).toBe(
      `group-${MAX_EDITOR_GROUPS - 1}`,
    );
    expect(state.activeEditorGroup).toBe("group-0");
  });

  it("parse never reads editor-group entries after the raw-entry cap", () => {
    const rawGroups = Array<unknown>(MAX_EDITOR_GROUPS + 1).fill(null);
    Object.defineProperty(rawGroups, MAX_EDITOR_GROUPS, {
      get: () => {
        throw new Error("read past editor-group cap");
      },
    });

    expect(
      parseUiState({
        version: 2,
        editorGroups: rawGroups,
        activeEditorGroup: "missing",
      }),
    ).toEqual(defaultWorkbenchState());
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
  it("remaps every editor group and repairs each active tab", () => {
    let state = moveTabToNewGroup(
      withTabs("left.md", "right.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "right.md",
      "right",
    );
    state = openTab(state, "right-second.md", "right");
    const remapped = remapWorkbenchPaths(state, (path) =>
      path === "left.md"
        ? "left-renamed.md"
        : path === "right-second.md"
          ? null
          : path,
    );
    expect(remapped.editorGroups[0].tabs[0].path).toBe("left-renamed.md");
    expect(remapped.editorGroups[0].activeTab).toBe("left-renamed.md");
    expect(remapped.editorGroups[1].tabs.map((tab) => tab.path)).toEqual([
      "right.md",
    ]);
    expect(remapped.editorGroups[1].activeTab).toBe("right.md");
  });

  it("remaps tabs, the active tab, pins, and expansion through one projection", () => {
    let state = withTabs("team/anna.md", "readme.md");
    state = setFolderExpanded(state, "team", true);
    state = togglePinned(state, "team/anna.md");
    const remapped = remapWorkbenchPaths(state, (path) =>
      path === "team" ? "org/team" : path.startsWith("team/") ? `org/${path}` : path,
    );
    expect(allTabs(remapped).map((tab) => tab.path)).toEqual([
      "org/team/anna.md",
      "readme.md",
    ]);
    expect(activeTabPath(remapped)).toBe("readme.md");
    expect(remapped.expandedFolders).toEqual(["org/team"]);
    expect(remapped.pinned).toEqual(["org/team/anna.md"]);
  });

  it("a deleted active tab falls back to the last surviving tab; deletions drop pins", () => {
    let state = withTabs("a.md", "junk.md");
    state = togglePinned(state, "junk.md");
    const remapped = remapWorkbenchPaths(state, (path) =>
      path === "junk.md" ? null : path,
    );
    expect(allTabs(remapped).map((tab) => tab.path)).toEqual(["a.md"]);
    expect(activeTabPath(remapped)).toBe("a.md");
    expect(remapped.pinned).toEqual([]);
  });

  it("a move that collides two tabs onto one path dedupes them", () => {
    const state = withTabs("a.md", "b.md");
    const remapped = remapWorkbenchPaths(state, () => "same.md");
    expect(allTabs(remapped).map((tab) => tab.path)).toEqual(["same.md"]);
    expect(activeTabPath(remapped)).toBe("same.md");
  });

  it("keeps the same remapped path open once in each group", () => {
    const state = createEditorGroupRight(
      withTabs("a.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "right",
    );
    const remapped = remapWorkbenchPaths(state, () => "renamed.md");
    expect(
      remapped.editorGroups.map((group) => group.tabs.map((tab) => tab.path)),
    ).toEqual([["renamed.md"], ["renamed.md"]]);
    expect(remapped.editorGroups.map((group) => group.activeTab)).toEqual([
      "renamed.md",
      "renamed.md",
    ]);
  });
});

describe("pruneMissingRestoredTabs (restored tabs whose file is gone)", () => {
  const restored = (...paths: string[]): ReadonlySet<string> => new Set(paths);

  it("drops the tab for a path the workspace no longer has", () => {
    const state = withTabs("a.md", "assets/alpha-renamed.png");
    const pruned = pruneMissingRestoredTabs(
      state,
      restored("a.md", "assets/alpha-renamed.png"),
      (path) => path === "a.md",
    );
    expect(allTabs(pruned).map((tab) => tab.path)).toEqual(["a.md"]);
    expect(activeTabPath(pruned)).toBe("a.md");
  });

  it("prunes every editor group and repairs each group activation", () => {
    let state = moveTabToNewGroup(
      withTabs("left.md", "right.md"),
      DEFAULT_EDITOR_GROUP_ID,
      "right.md",
      "right",
    );
    state = openTab(state, "right-survivor.md", "right");
    const pruned = pruneMissingRestoredTabs(
      state,
      restored("left.md", "right.md", "right-survivor.md"),
      (path) => path === "right-survivor.md",
    );
    expect(pruned.editorGroups[0].tabs).toEqual([]);
    expect(pruned.editorGroups[0].activeTab).toBeNull();
    expect(pruned.editorGroups[1].tabs.map((tab) => tab.path)).toEqual([
      "right-survivor.md",
    ]);
    expect(pruned.editorGroups[1].activeTab).toBe("right-survivor.md");
  });

  it("keeps every tab whose file is still listed (same reference)", () => {
    const state = withTabs("a.md", "b.md");
    expect(pruneMissingRestoredTabs(state, restored("a.md", "b.md"), () => true)).toBe(
      state,
    );
  });

  // The whole point of the scoping: a listing that raced a create omits the
  // new file, and must not be allowed to close the tab the user just opened.
  it("never touches a tab opened this session, whatever the listing says", () => {
    const state = withTabs("restored.md", "opened-now.md");
    const pruned = pruneMissingRestoredTabs(
      state,
      restored("restored.md"),
      () => false,
    );
    expect(allTabs(pruned).map((tab) => tab.path)).toEqual(["opened-now.md"]);
    expect(activeTabPath(pruned)).toBe("opened-now.md");
  });

  it("prunes nothing when no tab was restored", () => {
    const state = withTabs("a.md", "b.md");
    expect(pruneMissingRestoredTabs(state, restored(), () => false)).toBe(state);
  });

  it("keeps virtual tabs, which have no file to look up", () => {
    const state = withTabs(CHATS_TAB_PATH, HISTORY_TAB_PATH, "a.md");
    const pruned = pruneMissingRestoredTabs(
      state,
      restored(CHATS_TAB_PATH, HISTORY_TAB_PATH, "a.md"),
      () => false,
    );
    expect(allTabs(pruned).map((tab) => tab.path)).toEqual([
      CHATS_TAB_PATH,
      HISTORY_TAB_PATH,
    ]);
    expect(activeTabPath(pruned)).toBe(HISTORY_TAB_PATH);
  });

  it("leaves pins, expansion, and recents alone — those name FOLDERS too", () => {
    let state = withTabs("a.md");
    state = setFolderExpanded(state, "assets", true);
    state = togglePinned(state, "assets");
    state = recordRecentFile(state, "a.md");
    const pruned = pruneMissingRestoredTabs(
      state,
      restored("a.md"),
      (path) => path === "a.md",
    );
    expect(pruned.expandedFolders).toEqual(["assets"]);
    expect(pruned.pinned).toEqual(["assets"]);
    expect(pruned.recentFiles).toEqual(["a.md"]);
  });

  it("a pruned active tab hands over to the last survivor; an empty result nulls it", () => {
    const state = withTabs("a.md", "b.md", "gone.md");
    const all = restored("a.md", "b.md", "gone.md");
    expect(
      activeTabPath(pruneMissingRestoredTabs(state, all, (path) => path !== "gone.md")),
    ).toBe("b.md");
    const empty = pruneMissingRestoredTabs(state, all, () => false);
    expect(allTabs(empty)).toEqual([]);
    expect(activeTabPath(empty)).toBeNull();
  });
});
