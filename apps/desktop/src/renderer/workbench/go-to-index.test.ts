import { describe, expect, it, vi } from "vitest";
import { GoToIndex, isGoToPathQuery, prepareQuickOpenPaths, rankPreparedQuickOpenPaths, type GoToListing } from "./quick-open-rank";
const context = { pinned: [], recent: [] };
const listing = (paths: string[]): GoToListing => ({
  files: paths.map((path) => ({ path, kind: "file" })), folders: [],
  visibility: { status: "ready", rules: [] }, receivedRoots: [],
});
describe("Go to names", () => {
  it("prepares one new row for a rename and reuses the other 29,999 rows", () => {
    const index = new GoToIndex("workspace");
    const paths = Array.from({ length: 30_000 }, (_, n) => "src/file-" + n + ".ts");
    index.update({ listing: listing(paths) }, context);
    const previous = index.rows.slice();
    paths[123] = "src/renamed.ts";
    index.update({ listing: listing(paths) }, context);
    expect(index.lastPreparationCount).toBe(1);
    expect(index.rows[122]).toBe(previous[122]);
    expect(index.rows[124]).toBe(previous[124]);
    expect(index.query("renamed")[0].label).toBe("renamed.ts");
    expect(index.query("file-123.ts").some(row => row.path === "src/file-123.ts")).toBe(false);
  });
});

const ids = (rows: ReturnType<GoToIndex["query"]>) => rows.map(row => row.id);
// Keep the full-sort oracle independent of the bounded production matcher.
function referenceMatchTier(query: string, path: string): number | null {
  const needle = query.toLowerCase(), haystack = path.toLowerCase();
  if (!needle) return 2;
  if (haystack.slice(haystack.lastIndexOf("/") + 1).startsWith(needle)) return 0;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if ((i === 0 || /[/\-_. ]/.test(haystack[i - 1])) && haystack.startsWith(needle, i)) return 1;
  }
  if (haystack.includes(needle)) return 2;
  let at = 0;
  for (const character of haystack) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return 3;
  }
  return null;
}

function fullSort(index: GoToIndex, query: string, limit = 50) {
  const pathQuery = isGoToPathQuery(query);
  return index.rows.map(row => {
    let tier = referenceMatchTier(query, row.path);
    if (row.kind === "app") {
      const titleTier = referenceMatchTier(query, row.label);
      if (titleTier !== null) tier = tier === null ? titleTier : Math.min(tier, titleTier);
    }
    return { row, tier };
  }).filter(candidate => candidate.tier !== null).sort((a, b) =>
    (pathQuery ? Number(a.row.kind !== "file") - Number(b.row.kind !== "file") : 0) ||
    a.row.pinnedRank - b.row.pinnedRank || a.tier! - b.tier! ||
    a.row.recentRank - b.row.recentRank || a.row.path.length - b.row.path.length ||
    (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0) || a.row.sourceIndex - b.row.sourceIndex
  ).slice(0, limit).map(candidate => candidate.row.id);
}

it("indexes all six kinds, keeps source references and workspace locators, and uses kind records", () => {
  const index = new GoToIndex("workspace");
  const app = { root: "trip", title: "Trip planner" };
  const snapshot = listing(["notes.md", "data.sqlite", "src/main.rs"]);
  snapshot.folders = ["empty", "records"];
  index.update({ listing: snapshot, collections: [{ path: "records", objectId: "records-id" }],
    apps: [app], versions: [{ id: "main", name: "Main" }], groups: [{ id: "general", name: "General", kind: "channel" }],
  });
  expect(index.rows.map(row => row.kind)).toEqual(["file", "file", "file", "folder", "collection", "app", "version", "group"]);
  expect(index.query("planner")[0].record).toBe(app);
  expect(index.query("planner")[0].target).toEqual({ workspaceId: "workspace", kind: "app", path: "trip" });
  expect(index.query("main.rs")[0].glyphId).toBe("file-code");
  expect(index.query("sqlite")[0].glyphId).toBe("database");
});
it("prepares only changed subsets, never prepares on query, and resets narrowing on a ranking-context update", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["a/report.md", "b/report.md"]);
  index.update({ listing: snapshot }, context);
  const row = index.rows[0];
  const revision = index.revision;
  index.update({ listing: snapshot }, { ...context });
  expect(index.lastPreparationCount).toBe(0);
  expect(index.revision).toBe(revision);
  index.query("r"); index.query("re"); index.query("rep");
  expect(index.revision).toBe(revision);
  index.update({ apps: [{ root: "app", title: "Reports" }] });
  expect(index.lastPreparationCount).toBe(1);
  expect(index.rows[0]).toBe(row);
  index.update({}, { pinned: ["b/report.md"], recent: [] });
  expect(index.lastPreparationCount).toBe(0);
  expect(index.query("report")[0].path).toBe("b/report.md");
});
it("matches a full scan for every prefix, backspace, replacement, and revision", () => {
  const index = new GoToIndex("workspace");
  index.update({ listing: listing(Array.from({ length: 750 }, (_, n) => "src/" + (n % 2 ? "Release" : "report") + "_" + n + ".TS")),
    apps: [{ root: "tools/app", title: "Release reports" }],
    versions: [{ id: "version", name: "Release" }],
  }, { pinned: ["src/report_2.TS"], recent: ["src/Release_5.TS"] });
  for (const word of ["report", "Release", "src/", "report_2.TS", "re", "", "missing"]) {
    for (let n = 0; n <= word.length; n++) {
      const query = word.slice(0, n);
      expect(ids(index.query(query)), query).toEqual(fullSort(index, query));
    }
    for (let n = word.length; n >= 0; n--) {
      const query = word.slice(0, n);
      expect(ids(index.query(query)), query).toEqual(fullSort(index, query));
    }
  }
  index.update({ versions: [{ id: "version", name: "Renamed" }] });
  expect(ids(index.query("re"))).toEqual(fullSort(index, "re"));
});
it("keeps the unseen 51st match so it can win the next prefix", () => {
  const index = new GoToIndex("workspace");
  index.update({ listing: listing([...Array.from({ length: 50 }, (_, n) => "ra" + n + ".txt"), "really-long.txt"]) });
  expect(index.query("r")).toHaveLength(50);
  expect(index.query("r").some(row => row.path === "really-long.txt")).toBe(false);
  expect(index.query("re")[0].path).toBe("really-long.txt");
  expect(index.lastScanCount).toBe(51);
});
it("scans only the current match set while narrowing and rescans after backspacing or replacing a prefix", () => {
  const index = new GoToIndex("workspace");
  index.update({ listing: listing(["report.md", "result.md", "plain.txt"]) });
  index.query("r"); expect(index.lastScanCount).toBe(3);
  index.query("re"); expect(index.lastScanCount).toBe(2);
  index.query("r"); expect(index.lastScanCount).toBe(3);
  index.query("p"); expect(index.lastScanCount).toBe(3);
});
it("uses slash and known case-insensitive extensions to put files first", () => {
  for (const query of ["notes.MD", "docs/notes"]) {
    const index = new GoToIndex("workspace");
    index.update({ listing: listing(["docs/notes.md"]), versions: [{ id: "version", name: query }] }, { pinned: [query], recent: [] });
    expect(index.query(query)[0].kind).toBe("file");
  }
  expect(isGoToPathQuery("Release")).toBe(false);
  expect(isGoToPathQuery("notes.unknown")).toBe(false);
  expect(isGoToPathQuery("src/main.RS")).toBe(true);
});
it("keeps the existing file-only tier, pin, recency, tie, and duplicate semantics", () => {
  const paths = ["z/notes.md", "notes.md", "old/keynotes.md", "notes.md", "a/notes.md"];
  const ranking = { pinned: ["old/keynotes.md"], recent: ["a/notes.md"] };
  const index = new GoToIndex("workspace");
  index.update({ listing: listing(paths) }, ranking);
  for (const query of ["", "no", "note", "nte", "notes.md"]) {
    expect(index.query(query).map(row => row.path)).toEqual(rankPreparedQuickOpenPaths(query, prepareQuickOpenPaths([...new Set(paths)], ranking), 50));
  }
});
it("subtracts only host rule verdicts, leaving .env and mounted names findable after a policy edit", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing([".env", "private/budget.md", "shared-with-me/team/budget.md"]);
  snapshot.folders = ["private"];
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
  index.update({ listing: snapshot });
  expect(index.query(".env")[0].path).toBe(".env");
  expect(index.query("budget")).toHaveLength(2);
  index.update({ listing: { ...snapshot, visibility: { status: "ready", rules: [{ path: "private", visibility: "hidden" }, { path: "private/budget.md", visibility: "hidden" }, { path: "shared-with-me/team/budget.md", visibility: "hidden" }] } } });
  expect(index.query("budget").map(row => row.path)).toEqual(["shared-with-me/team/budget.md"]);
  expect(index.rows.some(row => row.path === "private")).toBe(false);
  expect(index.query(".env")[0].path).toBe(".env");
});
for (const status of ["degraded", "unavailable"] as const) {
  it("withholds every host path kind for a " + status + " policy and preserves mounted selectors", () => {
    const index = new GoToIndex("workspace");
    const snapshot = listing(["host.md", "shared-with-me/team/shared.md"]);
    snapshot.folders = ["host-folder", "host-records", "shared-with-me/team/folder"];
    snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
    index.update({ listing: { ...snapshot, visibility: { status, rules: [] } },
      collections: [{ path: "host-records", objectId: "host" }, { path: "shared-with-me/team/records", objectId: "shared" }],
      apps: [{ root: "host-app", title: "Host app" }, { root: "shared-with-me/team/app", title: "Shared app" }],
      versions: [{ id: "main", name: "Main" }], groups: [{ id: "general", name: "General", kind: "channel" }],
    });
    expect(index.rows.map(row => row.kind)).toEqual(["file", "folder", "collection", "app", "version", "group"]);
    expect(index.query("host")).toEqual([]);
    index.update({ listing: snapshot });
    expect(index.query("host")).toHaveLength(4);
    index.update({ listing: { ...snapshot, visibility: { status: "ready",
      rules: [{ path: "host.md", visibility: "hidden" }, { path: "host-folder", visibility: "hidden" }, { path: "host-records", visibility: "hidden" }, { path: "host-app", visibility: "hidden" }] } } });
    expect(index.query("host")).toEqual([]);
    // Selector narrowing and Remove/Leave arrive through the canonical listing.
    index.update({ listing: { ...snapshot, files: snapshot.files.slice(0, 1), receivedRoots: [] } });
    expect(index.query("shared.md")).toEqual([]);
  });
}
it("withholds path-backed names until a listing supplies ready rule verdicts", () => {
  const index = new GoToIndex("workspace");
  index.update({ apps: [{ root: "host-app", title: "Host app" }],
    collections: [{ path: "host-records", objectId: "host" }] });
  expect(index.query("host")).toEqual([]);
  index.update({ listing: listing([]) });
  expect(index.query("host")).toHaveLength(2);
});
it("compares fresh policy and mount contents before reapplying file verdicts", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["a.md", "b.md", "shared-with-me/team/shared.md"]);
  snapshot.visibility.rules = [{ path: "private", visibility: "hidden" }];
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
  index.update({ listing: snapshot });
  const previous = index.rows[0];
  const rules = [{ path: "private", visibility: "hidden" as const }];
  index.update({ listing: { ...snapshot, files: [...snapshot.files, { path: "new.md", kind: "file" }],
    visibility: { ...snapshot.visibility, rules },
    receivedRoots: snapshot.receivedRoots.map(root => ({ ...root })) } });
  expect(index.lastPreparationCount).toBe(1);
  expect(index.rows[0]).toBe(previous);
  expect(index.lastVisibilityCheckCount).toBe(1);
  index.update({ listing: { ...snapshot, visibility: { status: "ready", rules: [{ path: "a.md", visibility: "hidden" }] } } });
  expect(index.query("a.md").some(row => row.path === "a.md")).toBe(false);
  expect(index.query("b.md")).toHaveLength(1);
});
it("keeps ended-share copies marked ended and drops damaged copies", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["shared-with-me/team/report.md"]);
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: true, damaged: false }];
  index.update({ listing: snapshot });
  expect(index.query("report")[0].ended).toBe(true);
  index.update({ listing: { ...snapshot, receivedRoots: [{ ...snapshot.receivedRoots[0], damaged: true }] } });
  expect(index.query("report")).toEqual([]);
});
it("never indexes DM email-list names, agent channels, or fallback message titles", () => {
  const index = new GoToIndex("workspace");
  const records = [
    { id: "general", name: "General", kind: "channel" as const, bodySnippet: "private-message-sentinel" },
    { id: "dm", name: "private@example.test", kind: "dm" as const, peerLabel: "Peer" },
    { id: "agent", name: "Private agent", kind: "agent" as const },
  ];
  index.update({ groups: records });
  expect(index.rows.map(row => row.label)).toEqual(["General"]);
  for (const query of ["private-message-sentinel", "example.test", "Peer", "Private agent"]) expect(index.query(query)).toEqual([]);
});
it("starts empty after restart and accepts successful snapshots after a failed source read", () => {
  const index = new GoToIndex("workspace");
  index.update({ versions: [{ id: "main", name: "Main" }] });
  index.query("M");
  // A failed read has no committed replacement to pass to the index.
  index.update({});
  expect(index.query("Main")).toHaveLength(1);
  index.update({ versions: [{ id: "new", name: "Next" }] });
  expect(index.query("Main")).toEqual([]);
  expect(new GoToIndex("workspace").query("")).toEqual([]);
});
it("handles a 30,000-file first keystroke and clears all old matches after a version replacement", () => {
  const index = new GoToIndex("workspace");
  index.update({ listing: listing(Array.from({ length: 30_000 }, (_, n) => "src/report-" + n + ".ts")) });
  expect(index.query("r")).toHaveLength(50);
  expect(index.lastScanCount).toBe(30_000);
  index.update({ listing: listing(["next.md"]) });
  expect(index.query("re")).toEqual([]);
  expect(index.query("next")[0].path).toBe("next.md");
});

it("reuses rows through reordering, deletion, insertion, and duplicate paths", () => {
  const index = new GoToIndex("workspace");
  index.update({ listing: listing(["a.md", "b.md", "c.md"]) });
  const original = new Map(index.rows.map(row => [row.path, row]));
  for (const paths of [["c.md", "a.md", "b.md"], ["c.md", "b.md"], ["c.md", "c.md", "b.md"]]) {
    index.update({ listing: listing(paths) });
    expect(index.lastPreparationCount).toBe(0);
    expect(index.rows.map(row => row.path)).toEqual([...new Set(paths)]);
    for (const row of index.rows) expect(row).toBe(original.get(row.path));
  }
  index.update({ listing: listing(["new.md", "c.md", "b.md"]) });
  expect(index.lastPreparationCount).toBe(1);
  expect(index.query("").map(row => row.path)).toEqual(["b.md", "c.md", "new.md"]);
});

it("applies share status and explicit rule verdicts to Collection and app names", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing([]);
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: true, damaged: false }];
  index.update({ listing: snapshot, collections: [{ path: "shared-with-me/team/records", objectId: "records" }],
    apps: [{ root: "shared-with-me/team/app", title: "Shared app" }, { root: "private", title: "Private app" }] });
  expect(index.query("Shared app")[0].ended).toBe(true);
  expect(index.query("records")[0].ended).toBe(true);
  index.update({ listing: { ...snapshot, visibility: { status: "ready", rules: [{ path: "private", visibility: "hidden" }, { path: "shared-with-me/team/records", visibility: "hidden" }] } } });
  expect(index.query("Private app")).toEqual([]);
  expect(index.query("records")).toHaveLength(1);
  index.update({ listing: { ...snapshot, receivedRoots: [{ ...snapshot.receivedRoots[0], damaged: true }] } });
  expect(index.query("Shared app")).toEqual([]);
  expect(index.query("records")).toEqual([]);
});

 it("does no visibility work for equal listing/rules or ranking-only changes", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["one.md", "private/two.md"]);
  snapshot.visibility.rules = [{ path: "private/**", visibility: "hidden" }];
  index.update({ listing: snapshot, collections: [{ path: "private/crm", objectId: "crm" }], apps: [{ root: "app", title: "App" }] });
  const revision = index.revision;
  index.update({ listing: { ...snapshot, visibility: { ...snapshot.visibility, rules: snapshot.visibility.rules.map(rule => ({ ...rule })) } } });
  expect(index.lastVisibilityCheckCount).toBe(0);
  expect(index.revision).toBe(revision);
  index.update({}, { pinned: ["one.md"], recent: [] });
  expect(index.lastVisibilityCheckCount).toBe(0);
  index.update({ collections: [{ path: "private/crm", objectId: "crm" }, { path: "private/new", objectId: "new" }] });
  expect(index.lastVisibilityCheckCount).toBe(1);
  expect(index.query("new")).toEqual([]);
 });
