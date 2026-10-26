import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorkspaceUiState } from "../../ipc/bridgeContract";
import { editorTabTestId } from "../../testPins";
import { allTabs, parseTab, parseUiState, pruneMissingRestoredTabs, serializeUiState, TAB_KINDS, tabPath } from "./workbenchState";

const dataset = "tab://data-collection/data%2Fdataset.json/123e4567-e89b-42d3-a456-426614174002";
const rows = [
  ["file", "notes/旅.md", ["旅.md", "notes/旅.md", "旅.md"], ["旅.md", "notes/旅.md", "旅.md"]],
  ["graph", "tab://graph", ["Graph", "Workspace graph", "Graph"], ["Graph", "Workspace graph", "Graph"]],
  ["history", "tab://history", ["History", "Workspace history", "History"], ["History", "Workspace history", "History"]],
  ["chat", "tab://chats", ["Home", "Home", "Home"], ["folder/Label", "folder/Label", "folder/Label"]],
  ["chat", "tab://chats/new", ["New message", "New message", "New message"], ["folder/Label", "folder/Label", "folder/Label"]],
  ["chat", "tab://chats/channel/team%2Fone", ["Chat", "Chat", "Chat"], ["folder/Label", "folder/Label", "folder/Label"]],
  ["chat", "tab://chats/dm/person%20one", ["Chat", "Chat", "Chat"], ["folder/Label", "folder/Label", "folder/Label"]],
  ["site", "tab://app/apps%2Ftrip", ["trip", "apps/trip", "trip"], ["trip", "apps/trip", "trip"]],
  ["momentDiff", "tab://moment-diff/moment%20one", ["History change", "History change", "History change"], ["Diff: Label", "History diff: folder/Label", "Diff: Label"]],
  ["versionCompare", "tab://versions/compare/try%2Fone", ["Compare with Main", "Compare this Version with Main", "Compare with Main"], ["Compare with Main", "Compare this Version with Main", "Compare with Main"]],
  ["collection", "tab://collection/notes%2F%E6%97%85", ["notes%2F%E6%97%85", "tab://collection/notes%2F%E6%97%85", "旅"], ["notes%2F%E6%97%85", "tab://collection/notes%2F%E6%97%85", "旅"]],
  ["transactionalCollection", dataset, ["Collection", "Collection", "Collection"], ["folder/Label", "Collection: folder/Label", "folder/Label"]],
] as const;

it("classifies a removed navigation address without treating it as a file", () => {
  expect(parseTab("tab://retired/x")).toEqual({ kind: "removed", path: "tab://retired/x" });
});

describe("typed tab parity with the persisted ids and surface strings on main", () => {
  it.each(rows)("round-trips %s at %s", (kind, path) => {
    const tab = parseTab(path);
    expect(tab.kind).toBe(kind);
    expect(tabPath(tab)).toBe(path);
    expect(TAB_KINDS[tab.kind].singleton).toBe(kind === "chat" || kind === "site");
  });
  it.each(rows)("keeps all three titles for %s at %s", (_kind, path, without, withLabel) => {
    const tab = parseTab(path);
    const rules = TAB_KINDS[tab.kind];
    expect([rules.title(tab), rules.tooltip(tab), rules.explorerTitle(tab)]).toEqual(without);
    expect([rules.title(tab, "folder/Label"), rules.tooltip(tab, "folder/Label"), rules.explorerTitle(tab, "folder/Label")]).toEqual(withLabel);
  });
  it.each(rows)("keeps the selector for %s at %s", (kind, path) => {
    expect(editorTabTestId(path)).toBe(kind === "file" ? `tab-${path}` : `tab-dohc://${path.slice(6)}`);
  });
  it("keeps empty labels and a diff label with no basename", () => {
    for (const path of ["tab://chats", dataset]) {
      const tab = parseTab(path), rules = TAB_KINDS[tab.kind];
      expect(rules.title(tab, "")).toBe("");
      expect(rules.explorerTitle(tab, "")).toBe("");
      expect(rules.tooltip(tab, "")).toBe(path === dataset ? "Collection" : "");
    }
    const diff = parseTab("tab://moment-diff/x");
    expect(TAB_KINDS.momentDiff.title(diff, "folder/")).toBe("History change");
    expect(TAB_KINDS.momentDiff.tooltip(diff, "folder/")).toBe("History diff: folder/");
  });
  it.each([2, 3])("round-trips every surviving id from the v%s fixture", version => {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/ui-state-v${version}.json`, import.meta.url), "utf8"));
    const state = parseUiState(fixture);
    for (const { path } of allTabs(state)) expect(tabPath(parseTab(path))).toBe(path);
    expect(allTabs(state).some(tab => tab.path === "notes/dohc://example.md")).toBe(true);
    expect(serializeUiState(state).version).toBe(3);
    expect(allTabs(state).every(tab => Object.keys(tab).join() === "path")).toBe(true);
  });
  it("drops reserved retired ids and keeps a file containing the old scheme", () => {
    const state = parseUiState({ version: 3, editorGroups: [{ id: "main", size: 1, tabs: ["tab://retired/x", "dohc://graph", "notes/dohc://example.md"], activeTab: "tab://retired/x" }], activeEditorGroup: "main" });
    expect(allTabs(state)).toEqual([{ path: "notes/dohc://example.md" }]);
    expect(state.editorGroups[0].activeTab).toBe("notes/dohc://example.md");
  });
  it.each(["tab://app/", "tab://app/%ZZ", "tab://collection/", "tab://collection/%ZZ", "tab://moment-diff/", "tab://moment-diff/%ZZ", "tab://versions/compare/", "tab://versions/compare/%ZZ"])("keeps the recognized malformed kind and selector of %s", path => {
    const tab = parseTab(path);
    expect(TAB_KINDS[tab.kind].virtual).toBe(true);
    expect(tabPath(tab)).toBe(path);
    expect(editorTabTestId(path)).toBe(`tab-dohc://${path.slice(6)}`);
  });
  it.each(["tab://chats/dm/%ZZ", "tab://data-collection/bad/bad", "tab://retired/x", "dohc://graph"])("never treats unrecognized %s as a file", path => {
    expect(parseTab(path).kind).toBe("removed");
    expect(editorTabTestId(path)).toBe(`tab-${path}`);
  });
  it("prunes restored files but retains every virtual kind and current-session file", () => {
    const paths = rows.map(row => row[1]);
    const state = parseUiState({ version: 3, editorGroups: [{ id: "main", size: 1, tabs: [...paths, "new.md"], activeTab: "notes/旅.md" }], activeEditorGroup: "main" });
    const pruned = pruneMissingRestoredTabs(state, new Set(paths), () => false);
    expect(allTabs(pruned).map(tab => tab.path)).toEqual([...paths.filter(path => path !== "notes/旅.md"), "new.md"]);
  });
});

describe("main keeps its exact singleton refusals", () => {
  function issues(left: string, right?: string) {
    const state = serializeUiState(parseUiState({ version: 3 }));
    const groups = right === undefined
      ? [{ id: "left", tabs: [left], activeTab: left, size: 1 }]
      : [{ id: "left", tabs: [left], activeTab: left, size: 0.5 }, { id: "right", tabs: [right], activeTab: right, size: 0.5 }];
    const result = WorkspaceUiState.safeParse({ ...state, editorGroups: groups, activeEditorGroup: "left" });
    return result.success ? [] : result.error.issues.map(issue => ({ path: issue.path, message: issue.message }));
  }
  it.each(["tab://app/%61pps%2Ftrip", "tab://app/", "tab://app/%ZZ", "tab://chats/channel/%74eam"])("refuses noncanonical singleton %s", path => {
    expect(issues(path)).toEqual([{ path: ["editorGroups", 0, "tabs", 0], message: "Process-owning preview tab paths must use canonical encoding." }]);
  });
  it.each([
    ["tab://chats", "Each chat can be open in only one editor group."],
    ["tab://chats/new", "Each chat can be open in only one editor group."],
    ["tab://chats/channel/team", "Each chat can be open in only one editor group."],
    ["tab://chats/dm/person", "Each chat can be open in only one editor group."],
    ["tab://app/apps%2Ftrip", "An app preview can be open in only one editor group."],
  ])("refuses duplicate %s", (path, message) => {
    expect(issues(path, path)).toEqual([{ path: ["editorGroups", 1, "tabs", 0], message }]);
  });
  it("keeps both refusals for a noncanonical app duplicate", () => {
    expect(issues("tab://app/apps%2Ftrip", "tab://app/%61pps%2Ftrip")).toEqual([
      { path: ["editorGroups", 1, "tabs", 0], message: "Process-owning preview tab paths must use canonical encoding." },
      { path: ["editorGroups", 1, "tabs", 0], message: "An app preview can be open in only one editor group." },
    ]);
  });
  it.each(["tab://graph", "tab://history", "tab://retired/x", "tab://chats/invalid"])("does not add main refusals to %s", path => {
    expect(issues(path, path)).toEqual([]);
  });
});
