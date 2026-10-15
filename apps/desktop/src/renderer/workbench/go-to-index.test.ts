import { describe, expect, it, vi } from "vitest";
import { GoToIndex, isGoToPathQuery, prepareQuickOpenPaths, rankPreparedQuickOpenPaths, type GoToListing, type PreparedGoToRow } from "./quick-open-rank";
function update(index: GoToIndex, ...args: Parameters<GoToIndex["update"]>) {
  const run = index.update(...args);
  while (run && !run.step(() => 0)) { /* Drain preparation for ranking tests. */ }
}
const context = { pinned: [], recent: [] };
const listing = (paths: string[]): GoToListing => ({
  files: paths.map((path) => ({ path, kind: "file" })), folders: [],
  visibility: { status: "ready", rules: [] }, receivedRoots: [],
});
describe("Go to names", () => {
  it("prepares one new row for a rename and reuses the other 29,999 rows", () => {
    const index = new GoToIndex("workspace");
    const paths = Array.from({ length: 30_000 }, (_, n) => "src/file-" + n + ".ts");
    update(index, { listing: listing(paths) }, context);
    const previous = index.rows.slice();
    paths[123] = "src/renamed.ts";
    update(index, { listing: listing(paths) }, context);
    expect(index.lastPreparationCount).toBe(1);
    expect(index.rows[122]).toBe(previous[122]);
    expect(index.rows[124]).toBe(previous[124]);
    expect(index.query("renamed")[0].label).toBe("renamed.ts");
    expect(index.query("file-123.ts").some(row => row.path === "src/file-123.ts")).toBe(false);
  });
});

const ids = (rows: ReturnType<GoToIndex["query"]>) => rows.map(row => row.id);
// Keep the full-sort oracle independent of the bounded production matcher.
function referenceMatchTier(query: string, path: string, basename = path.slice(path.lastIndexOf("/") + 1)): number | null {
  const needle = query.toLowerCase(), haystack = path.toLowerCase();
  if (!needle) return 2;
  if (basename.toLowerCase().startsWith(needle)) return 0;
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
    let tier = referenceMatchTier(query, row.path, row.label);
    if (row.kind === "app") {
      const titleTier = referenceMatchTier(query, row.label, row.label);
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
  update(index, { listing: snapshot, collections: [{ path: "records", objectId: "records-id" }],
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
  update(index, { listing: snapshot }, context);
  const row = index.rows[0];
  const revision = index.revision;
  update(index, { listing: snapshot }, { ...context });
  expect(index.lastPreparationCount).toBe(0);
  expect(index.revision).toBe(revision);
  index.query("r"); index.query("re"); index.query("rep");
  expect(index.revision).toBe(revision);
  update(index, { apps: [{ root: "app", title: "Reports" }] });
  expect(index.lastPreparationCount).toBe(1);
  expect(index.rows[0]).toBe(row);
  update(index, {}, { pinned: ["b/report.md"], recent: [] });
  expect(index.lastPreparationCount).toBe(0);
  expect(index.query("report")[0].path).toBe("b/report.md");
});
it("matches a full scan for every prefix, backspace, replacement, and revision", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(Array.from({ length: 750 }, (_, n) => "src/" + (n % 2 ? "Release" : "report") + "_" + n + ".TS")),
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
  update(index, { versions: [{ id: "version", name: "Renamed" }] });
  expect(ids(index.query("re"))).toEqual(fullSort(index, "re"));
});
it("keeps the unseen 51st match so it can win the next prefix", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing([...Array.from({ length: 50 }, (_, n) => "ra" + n + ".txt"), "really-long.txt"]) });
  expect(index.query("r")).toHaveLength(50);
  expect(index.query("r").some(row => row.path === "really-long.txt")).toBe(false);
  expect(index.query("re")[0].path).toBe("really-long.txt");
  expect(index.lastScanCount).toBe(51);
});
it("scans only the current match set while narrowing and rescans after backspacing or replacing a prefix", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(["report.md", "result.md", "plain.txt"]) });
  index.query("r"); expect(index.lastScanCount).toBe(3);
  index.query("re"); expect(index.lastScanCount).toBe(2);
  index.query("r"); expect(index.lastScanCount).toBe(3);
  index.query("p"); expect(index.lastScanCount).toBe(3);
});
it("uses slash and known case-insensitive extensions to put files first", () => {
  for (const query of ["notes.MD", "docs/notes"]) {
    const index = new GoToIndex("workspace");
    update(index, { listing: listing(["docs/notes.md"]), versions: [{ id: "version", name: query }] }, { pinned: [query], recent: [] });
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
  update(index, { listing: listing(paths) }, ranking);
  for (const query of ["", "no", "note", "nte", "notes.md"]) {
    expect(index.query(query).map(row => row.path)).toEqual(rankPreparedQuickOpenPaths(query, prepareQuickOpenPaths([...new Set(paths)], ranking), 50));
  }
});
it("subtracts only host rule verdicts, leaving .env and mounted names findable after a policy edit", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing([".env", "private/budget.md", "shared-with-me/team/budget.md"]);
  snapshot.folders = ["private"];
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
  update(index, { listing: snapshot });
  expect(index.query(".env")[0].path).toBe(".env");
  expect(index.query("budget")).toHaveLength(2);
  update(index, { listing: { ...snapshot, visibility: { status: "ready", rules: [{ path: "private", visibility: "hidden" }, { path: "private/budget.md", visibility: "hidden" }, { path: "shared-with-me/team/budget.md", visibility: "hidden" }] } } });
  expect(index.query("budget").map(row => row.path)).toEqual(["shared-with-me/team/budget.md"]);
  expect(index.rows.some(row => row.path === "private")).toBe(false);
  expect(index.query(".env")[0].path).toBe(".env");
});
it("applies private pattern rules to every nested Go to path", () => {
  const index = new GoToIndex("workspace");
  const source = listing(["public.md", "private/secret.md", "private/deep/note.md"]);
  source.folders = ["private", "private/deep"];
  source.visibility.rules = [{ path: "private/**", visibility: "hidden" }];
  update(index, { listing: source });
  expect(index.query("public")).toHaveLength(1);
  expect(index.query("secret")).toEqual([]);
  expect(index.query("note")).toEqual([]);
});
it("honors a visible exception inside a hidden source pattern", () => {
  const index = new GoToIndex("workspace");
  const source = listing(["src/file-0.ts", "src/file-1.ts", "src/deep/file-2.ts"]);
  source.visibility.rules = [
    { path: "src/**", visibility: "hidden" },
    { path: "src/file-1.ts", visibility: "visible" },
  ];
  update(index, { listing: source });
  expect(index.query("file").map(row => row.path)).toEqual(["src/file-1.ts"]);
});
for (const status of ["degraded", "unavailable"] as const) {
  it("withholds every host path kind for a " + status + " policy and preserves mounted selectors", () => {
    const index = new GoToIndex("workspace");
    const snapshot = listing(["host.md", "shared-with-me/team/shared.md"]);
    snapshot.folders = ["host-folder", "host-records", "shared-with-me/team/folder"];
    snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
    update(index, { listing: { ...snapshot, visibility: { status, rules: [] } },
      collections: [{ path: "host-records", objectId: "host" }, { path: "shared-with-me/team/records", objectId: "shared" }],
      apps: [{ root: "host-app", title: "Host app" }, { root: "shared-with-me/team/app", title: "Shared app" }],
      versions: [{ id: "main", name: "Main" }], groups: [{ id: "general", name: "General", kind: "channel" }],
    });
    expect(index.rows.map(row => row.kind)).toEqual(["file", "folder", "collection", "app", "version", "group"]);
    expect(index.query("host")).toEqual([]);
    update(index, { listing: snapshot });
    expect(index.query("host")).toHaveLength(4);
    update(index, { listing: { ...snapshot, visibility: { status: "ready",
      rules: [{ path: "host.md", visibility: "hidden" }, { path: "host-folder", visibility: "hidden" }, { path: "host-records", visibility: "hidden" }, { path: "host-app", visibility: "hidden" }] } } });
    expect(index.query("host")).toEqual([]);
    // Selector narrowing and Remove/Leave arrive through the canonical listing.
    update(index, { listing: { ...snapshot, files: snapshot.files.slice(0, 1), receivedRoots: [] } });
    expect(index.query("shared.md")).toEqual([]);
  });
}
it("withholds path-backed names until a listing supplies ready rule verdicts", () => {
  const index = new GoToIndex("workspace");
  update(index, { apps: [{ root: "host-app", title: "Host app" }],
    collections: [{ path: "host-records", objectId: "host" }] });
  expect(index.query("host")).toEqual([]);
  update(index, { listing: listing([]) });
  expect(index.query("host")).toHaveLength(2);
});
it("compares fresh policy and mount contents before reapplying file verdicts", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["a.md", "b.md", "shared-with-me/team/shared.md"]);
  snapshot.visibility.rules = [{ path: "private", visibility: "hidden" }];
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
  update(index, { listing: snapshot });
  const previous = index.rows[0];
  const rules = [{ path: "private", visibility: "hidden" as const }];
  update(index, { listing: { ...snapshot, files: [...snapshot.files, { path: "new.md", kind: "file" }],
    visibility: { ...snapshot.visibility, rules },
    receivedRoots: snapshot.receivedRoots.map(root => ({ ...root })) } });
  expect(index.lastPreparationCount).toBe(1);
  expect(index.rows[0]).toBe(previous);
  expect(index.lastVisibilityCheckCount).toBe(1);
  update(index, { listing: { ...snapshot, visibility: { status: "ready", rules: [{ path: "a.md", visibility: "hidden" }] } } });
  expect(index.query("a.md").some(row => row.path === "a.md")).toBe(false);
  expect(index.query("b.md")).toHaveLength(1);
});
it("keeps ended-share copies marked ended and drops damaged copies", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["shared-with-me/team/report.md"]);
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: true, damaged: false }];
  update(index, { listing: snapshot });
  expect(index.query("report")[0].ended).toBe(true);
  update(index, { listing: { ...snapshot, receivedRoots: [{ ...snapshot.receivedRoots[0], damaged: true }] } });
  expect(index.query("report")).toEqual([]);
});
it("never indexes DM email-list names, agent channels, or fallback message titles", () => {
  const index = new GoToIndex("workspace");
  const records = [
    { id: "general", name: "General", kind: "channel" as const, bodySnippet: "private-message-sentinel" },
    { id: "dm", name: "private@example.test", kind: "dm" as const, peerLabel: "Peer" },
    { id: "agent", name: "Private agent", kind: "agent" as const },
  ];
  update(index, { groups: records });
  expect(index.rows.map(row => row.label)).toEqual(["General"]);
  for (const query of ["private-message-sentinel", "example.test", "Peer", "Private agent"]) expect(index.query(query)).toEqual([]);
});
it("starts empty after restart and accepts successful snapshots after a failed source read", () => {
  const index = new GoToIndex("workspace");
  update(index, { versions: [{ id: "main", name: "Main" }] });
  index.query("M");
  // A failed read has no committed replacement to pass to the index.
  update(index, {});
  expect(index.query("Main")).toHaveLength(1);
  update(index, { versions: [{ id: "new", name: "Next" }] });
  expect(index.query("Main")).toEqual([]);
  expect(new GoToIndex("workspace").query("")).toEqual([]);
});
it("handles a 30,000-file first keystroke and clears all old matches after a version replacement", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(Array.from({ length: 30_000 }, (_, n) => "src/report-" + n + ".ts")) });
  expect(index.query("r")).toHaveLength(50);
  expect(index.lastScanCount).toBe(30_000);
  update(index, { listing: listing(["next.md"]) });
  expect(index.query("re")).toEqual([]);
  expect(index.query("next")[0].path).toBe("next.md");
});

it("reuses rows through reordering, deletion, insertion, and duplicate paths", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(["a.md", "b.md", "c.md"]) });
  const original = new Map(index.rows.map(row => [row.path, row]));
  for (const paths of [["c.md", "a.md", "b.md"], ["c.md", "b.md"], ["c.md", "c.md", "b.md"]]) {
    update(index, { listing: listing(paths) });
    expect(index.lastPreparationCount).toBe(0);
    expect(index.rows.map(row => row.path)).toEqual([...new Set(paths)]);
    for (const row of index.rows) expect(row.target).toBe(original.get(row.path)?.target);
  }
  update(index, { listing: listing(["new.md", "c.md", "b.md"]) });
  expect(index.lastPreparationCount).toBe(1);
  expect(index.query("").map(row => row.path)).toEqual(["b.md", "c.md", "new.md"]);
});

it("applies share status and explicit rule verdicts to Collection and app names", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing([]);
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: true, damaged: false }];
  update(index, { listing: snapshot, collections: [{ path: "shared-with-me/team/records", objectId: "records" }],
    apps: [{ root: "shared-with-me/team/app", title: "Shared app" }, { root: "private", title: "Private app" }] });
  expect(index.query("Shared app")[0].ended).toBe(true);
  expect(index.query("records")[0].ended).toBe(true);
    update(index, { listing: { ...snapshot, visibility: { status: "ready", rules: [{ path: "private", visibility: "hidden" }, { path: "shared-with-me/team/records", visibility: "hidden" }] } } });
  expect(index.query("Private app")).toEqual([]);
  expect(index.query("records")).toHaveLength(1);
  update(index, { listing: { ...snapshot, receivedRoots: [{ ...snapshot.receivedRoots[0], damaged: true }] } });
  expect(index.query("Shared app")).toEqual([]);
  expect(index.query("records")).toEqual([]);
});

it("withholds across recheck slices and publishes only the latest queued pattern policy", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 30_000 }, (_, n) => "src/file-" + n + ".ts"));
  update(index, { listing: source });
  const changed = { ...source, visibility: { status: "ready" as const, rules: [
    { path: "src/**", visibility: "hidden" as const },
    { path: "src/file-1.ts", visibility: "visible" as const },
  ] } };
  const first = index.update({ listing: changed });
  expect(index.query("file")).toEqual([]);
  let clock = 0;
  expect(first!.step(() => ++clock)).toBe(false);
  expect(index.query("file")).toEqual([]);
  const latest = index.update({ listing: { ...changed, visibility: { ...changed.visibility, rules: [{ path: "src/**", visibility: "hidden" }] } } });
  expect(first!.step(() => ++clock)).toBe(true);
  drain(latest);
  expect(index.query("file-1.ts")).toEqual([]);
  expect(index.lastVisibilityCheckCount).toBe(30_000);
});
it("does no visibility work for equal listing rules or ranking-only changes", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["one.md", "private/two.md"]);
  snapshot.visibility.rules = [{ path: "private/**", visibility: "hidden" }];
  update(index, { listing: snapshot, collections: [{ path: "private/crm", objectId: "crm" }], apps: [{ root: "app", title: "App" }] });
  const revision = index.revision;
  update(index, { listing: { ...snapshot, visibility: { ...snapshot.visibility, rules: snapshot.visibility.rules.map(rule => ({ ...rule })) } } });
  expect(index.lastVisibilityCheckCount).toBe(0);
  expect(index.revision).toBe(revision);
  update(index, {}, { pinned: ["one.md"], recent: [] });
  expect(index.lastVisibilityCheckCount).toBe(0);
  update(index, { collections: [{ path: "private/crm", objectId: "crm" }, { path: "private/new", objectId: "new" }] });
  expect(index.lastVisibilityCheckCount).toBe(1);
  expect(index.query("new")).toEqual([]);
});
it("reuses published verdicts after an unchanged policy save while withholding host names", () => {
  const index = new GoToIndex("workspace");
  const snapshot = listing(["public.md", "private/secret.md", "shared-with-me/team/shared.md"]);
  snapshot.visibility.rules = [{ path: "private/**", visibility: "hidden" }];
  snapshot.receivedRoots = [{ path: "shared-with-me/team", ended: false, damaged: false }];
  update(index, { listing: snapshot });
  const publicRow = index.query("public")[0];
  update(index, { listing: { ...snapshot, visibility: { status: "unavailable", rules: [] } } });
  expect(index.query("public")).toEqual([]);
  expect(index.query("shared.md")).toHaveLength(1);
  expect(index.lastVisibilityCheckCount).toBe(0);
  update(index, { listing: { ...snapshot, visibility: { ...snapshot.visibility,
    rules: snapshot.visibility.rules.map(rule => ({ ...rule })) } } });
  expect(index.lastVisibilityCheckCount).toBe(0);
  expect(index.query("public")[0]).toBe(publicRow);
  expect(index.query("secret")).toEqual([]);
});

const drain = (run: ReturnType<GoToIndex["update"]>) => { while (run && !run.step(() => 0)) {} };
it("withholds unsafe partial revisions across every source pass", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(["previous.md"]) });
  const revision = index.revision;
  const source = listing(Array.from({ length: 200 }, (_, n) => "docs/report-" + n + ".ts"));
  source.folders = Array.from({ length: 100 }, (_, n) => "folder-" + n);
  source.visibility.rules = source.folders.map(path => ({ path, visibility: "hidden" as const }));
  const run = index.update({ listing: source,
    collections: Array.from({ length: 100 }, (_, n) => ({ path: "collection-" + n, objectId: String(n) })),
    apps: Array.from({ length: 100 }, (_, n) => ({ root: "app-" + n, title: "App " + n })),
    versions: Array.from({ length: 100 }, (_, n) => ({ id: String(n), name: "Version " + n })),
    groups: Array.from({ length: 100 }, (_, n) => ({ id: String(n), name: "Excluded " + n, kind: "dm" as const })),
  }, { pinned: source.folders, recent: source.files.map(file => file.path) });
  let time = 0, slices = 0;
  const clock = () => { time += .25; return time; };
  let done = false;
  while (!done) {
    expect(index.preparing).toBe(true);
    expect(index.query("previous")).toEqual([]);
    expect(index.rows).toEqual([]);
    expect(index.revision).toBe(revision);
    done = run!.step(clock);
    slices += 1;
  }
  expect(slices).toBeGreaterThan(1);
  expect(index.preparing).toBe(false);
  expect(index.query("report")).toHaveLength(50);
  expect(index.query("Excluded")).toEqual([]);
});
it("rebuilds verdicts and every subset after superseding a partially applied revision", () => {
  const index = new GoToIndex("workspace");
  const first = listing(["a.md", "b.md", ...Array.from({ length: 2_000 }, (_, n) => "other/file-" + n + ".ts")]);
  update(index, { listing: first, versions: [{ id: "main", name: "Main" }] });
  const hidden = { ...first, visibility: { status: "ready" as const, rules: [{ path: "a.md", visibility: "hidden" as const }] } };
  const old = index.update({ listing: hidden, versions: [{ id: "old", name: "Old" }] });
  let time = 0;
  const clock = () => { time += 1; return time; };
  // Enter the listing pass, mutate a row, then stop before publication.
  for (let i = 0; i < 3; i++) expect(old!.step(clock)).toBe(false);
  const latest = index.update({ listing: first, versions: [{ id: "latest", name: "Latest" }] });
  expect(old!.step(clock)).toBe(true);
  drain(latest);
  expect(index.query("a.md")).toHaveLength(1);
  expect(index.query("Old")).toEqual([]);
  expect(index.query("Latest")).toHaveLength(1);
  expect(index.revision).toBe(2);
});
it("keeps every prefix equivalent through mask collisions, Unicode, and app-title-only matches", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(["docs/alpha.md", "symbols/!.txt", "symbols/}!.txt", "symbols/Z.txt", "docs/Été.md", "資料/計画.md", "emoji/😀.md", "emoji/ab😀cd.txt", "emoji/a😀b.txt"]),
    apps: [{ root: "tools/app", title: "Zebra planner" }],
  });
  // '!' and '}' share a mask bit; the full matcher must reject false positives.
  for (const word of ["zebra", "z.txt", "zz", "}!", "Été", "計画", "😀", "a😀b", "docs/alpha.md", ".tsx"]) {
    for (let n = 0; n <= word.length; n++) {
      const query = word.slice(0, n);
      expect(ids(index.query(query)), query).toEqual(fullSort(index, query));
    }
  }
});

it("does not cache empty preparing answers when an unchanged snapshot completes", () => {
  const index = new GoToIndex("workspace");
  const source = { listing: listing(["report.md"]) };
  update(index, source);
  const revision = index.revision;
  const run = index.update(source);
  expect(run).toBeNull();
  expect(index.query("r")[0].path).toBe("report.md");
  drain(run);
  expect(index.revision).toBe(revision);
  expect(index.query("re")[0].path).toBe("report.md");
});

it("deduplicates file paths on initial sliced preparation", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing(["a.md", "a.md", "b.md"]) });
  expect(index.rows.map(row => row.path)).toEqual(["a.md", "b.md"]);
  expect(index.lastPreparationCount).toBe(2);
});

it("keeps the last record for duplicate app roots and version IDs", () => {
  const index = new GoToIndex("workspace");
  const app = { root: "tools/app", title: "Latest app" };
  const version = { id: "main", name: "Latest version" };
  update(index, { listing: listing([]), apps: [{ ...app, title: "Old app" }, app],
    versions: [{ ...version, name: "Old version" }, version] });
  expect(index.query("Latest app")[0].record).toBe(app);
  expect(index.query("Latest version")[0].record).toBe(version);
  expect(index.query("Old")).toEqual([]);
});

it("keeps the last complete revision throughout rename and recent-list preparation", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 2_000 }, (_, n) => "docs/report-" + n + ".ts"));
  update(index, { listing: source });
  const before = ids(index.query("report"));
  const next = { ...source, files: source.files.map((file, n) => n === 123 ? { ...file, path: "docs/renamed.ts" } : file) };
  const rename = index.update({ listing: next });
  expect(ids(index.query("report"))).toEqual(before);
  let ticks = 0;
  while (!rename!.step(() => ++ticks)) expect(ids(index.query("report"))).toEqual(before);
  const renamed = ids(index.query("report"));
  const recent = index.update({}, { pinned: [], recent: ["docs/report-1999.ts"] });
  expect(ids(index.query("report"))).toEqual(renamed);
  while (!recent!.step(() => ++ticks)) expect(ids(index.query("report"))).toEqual(renamed);
  expect(index.query("report")[0].path).toBe("docs/report-1999.ts");
});
it("starts no run for unchanged source or context contents", () => {
  const index = new GoToIndex("workspace");
  const source = listing(["report.md"]);
  const ranking = { pinned: ["report.md"], recent: ["report.md"] };
  update(index, { listing: source }, ranking);
  const revision = index.revision;
  expect(index.update({ listing: { ...source, files: source.files.map(file => ({ ...file })) } },
    { pinned: [...ranking.pinned], recent: [...ranking.recent] })).toBeNull();
  expect(index.preparing).toBe(false);
  expect(index.query("report")).toHaveLength(1);
  expect(index.revision).toBe(revision);
});
it("never exposes a cancelled run that would unhide a row", () => {
  const index = new GoToIndex("workspace");
  const source = listing(["private/budget.md", ...Array.from({ length: 2_000 }, (_, n) => "other/file-" + n + ".ts")]);
  const hidden = { ...source, visibility: { status: "ready" as const, rules: [{ path: "private/budget.md", visibility: "hidden" as const }] } };
  update(index, { listing: hidden });
  const unhide = index.update({ listing: source });
  let ticks = 0;
  expect(unhide!.step(() => ++ticks)).toBe(false);
  expect(index.query("budget")).toEqual([]);
  const latest = index.update({ listing: hidden });
  expect(unhide!.step(() => ++ticks)).toBe(true);
  expect(index.query("budget")).toEqual([]);
  while (!latest!.step(() => ++ticks)) expect(index.query("budget")).toEqual([]);
  expect(index.query("budget")).toEqual([]);
  update(index, { listing: { ...hidden, files: hidden.files.map((file, n) => n === 500 ? { ...file, path: "other/renamed.ts" } : file) } });
  expect(index.query("budget")).toEqual([]);
});
it.each(["visible", "includedRevision"] as const)("budgets collection and old-order work independently through %s reads", property => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 3_000 }, (_, n) => "docs/report-" + n + ".ts"));
  update(index, { listing: source });
  let time = 0;
  // Instrument work independently of the loop's yield or operation counter.
  const workRows = (index as unknown as { completeRows: PreparedGoToRow[] }).completeRows;
  for (const row of workRows) {
    let value = row[property];
    Object.defineProperty(row, property, { get: () => { time += .002; return value; }, set: next => { value = next; }, enumerable: true });
    const path = row.path;
    Object.defineProperty(row, "path", { get: () => { time += .00005; return path; }, enumerable: true });
  }
  const changed = { ...source, files: source.files.map((file, n) => n === 100 ? { ...file, path: "zz/renamed.ts" } : file).reverse() };
  const run = index.update({ listing: changed });
  let slices = 0, done = false;
  while (!done) {
    const start = time;
    done = run!.step(() => time);
    expect(time - start).toBeLessThanOrEqual(4);
    slices += 1;
  }
  expect(slices).toBeGreaterThan(1);
  expect(index.query("renamed")[0].path).toBe("zz/renamed.ts");
});

it("discards unpublished file entries when rebuilding after interruption", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 2_000 }, (_, n) => "docs/file-" + n + ".md"));
  update(index, { listing: source });
  const added = { ...source, files: [{ path: "unpublished.md", kind: "file" as const }, ...source.files] };
  const run = index.update({ listing: added });
  let ticks = 0;
  expect(run!.step(() => ++ticks)).toBe(false);
  drain(index.update({ listing: source }));
  expect(index.query("unpublished")).toEqual([]);
  update(index, { listing: added });
  // An entry from a cancelled run is not a retained prepared row.
  expect(index.lastPreparationCount).toBe(1);
  expect(index.query("unpublished")).toHaveLength(1);
});

it("keeps answering when a safe rename supersedes another safe rename", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 3_000 }, (_, n) => "docs/file-" + n + ".ts"));
  update(index, { listing: source });
  const before = ids(index.query("file"));
  const first = { ...source, files: source.files.map((file, n) => n === 200 ? { ...file, path: "docs/first.ts" } : file) };
  const run = index.update({ listing: first });
  let ticks = 0;
  expect(run!.step(() => ++ticks)).toBe(false);
  const second = { ...first, files: first.files.map((file, n) => n === 300 ? { ...file, path: "docs/second.ts" } : file) };
  const latest = index.update({ listing: second });
  expect(ids(index.query("file"))).toEqual(before);
  while (!latest!.step(() => ++ticks)) expect(ids(index.query("file"))).toEqual(before);
  expect(index.query("first")).toHaveLength(1);
  expect(index.query("second")).toHaveLength(1);
});
it("keeps published row fields unchanged throughout preparation", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 2_000 }, (_, n) => "docs/file-" + n + ".ts"));
  update(index, { listing: source });
  const row = index.query("file-0.ts")[0];
  const fields = { record: row.record, glyphId: row.glyphId, pinnedRank: row.pinnedRank, recentRank: row.recentRank };
  const assertFields = () => expect({ record: row.record, glyphId: row.glyphId, pinnedRank: row.pinnedRank, recentRank: row.recentRank }).toEqual(fields);
  let ticks = 0;
  const ranking = index.update({}, { pinned: [row.path], recent: [row.path] });
  while (!ranking!.step(() => ++ticks)) assertFields();
  assertFields();
  const ranked = index.query("file-0.ts")[0];
  expect(ranked.pinnedRank).toBe(0);
  const oldRecord = ranked.record, oldGlyph = ranked.glyphId;
  const next = { ...source, files: source.files.map((file, n) => n === 0 ? { ...file, kind: "database" as const } : file) };
  const change = index.update({ listing: next });
  while (!change!.step(() => ++ticks)) { expect(ranked.record).toBe(oldRecord); expect(ranked.glyphId).toBe(oldGlyph); }
  expect(index.query("file-0.ts")[0].record).toBe(next.files[0]);
});
it("filters removed non-file entries before publication without losing retained matches", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 2_000 }, (_, n) => "docs/file-" + n + ".ts"));
  update(index, { listing: source, collections: [{ path: "records", objectId: "records" }], apps: [{ root: "planner", title: "Planner" }], versions: [{ id: "main", name: "Main" }], groups: Array.from({ length: 70 }, (_, n) => ({ id: String(n), name: "Channel " + n, kind: "channel" as const })) });
  expect(index.query("Channel")).toHaveLength(50);
  const run = index.update({ collections: [], apps: [], versions: [], groups: [{ id: "69", name: "Channel 69", kind: "channel" }] });
  expect(index.query("Channel").map(row => row.id)).toEqual(["group:69"]);
  for (const word of ["records", "Planner", "Main"]) expect(index.query(word)).toEqual([]);
  expect(index.query("file")).toHaveLength(50);
  drain(run);
});

it("does not let an abandoned removal view discard cached match indices", () => {
  const index = new GoToIndex("workspace");
  update(index, { groups: Array.from({ length: 70 }, (_, n) => ({ id: String(n), name: "Channel " + n, kind: "channel" as const })) });
  const removed = index.removedKeys({ groups: [] });
  expect(index.query("Channel", 50, removed)).toEqual([]);
  expect(index.query("Channel")).toHaveLength(50);
  expect(index.query("Channel 69").map(row => row.id)).toEqual(["group:69"]);
});

it("reuses every unchanged row when creating and deleting near the source start", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 3_000 }, (_, n) => "docs/file-" + n + ".ts"));
  update(index, { listing: source });
  const previous = new Map(index.rows.map(row => [row.path, row]));
  const created = { ...source, files: [{ path: "docs/created.ts", kind: "file" as const }, ...source.files.map(file => ({ ...file }))] };
  update(index, { listing: created });
  for (const row of index.rows) if (previous.has(row.path)) expect(row).toBe(previous.get(row.path));
  update(index, { listing: { ...created, files: created.files.slice(1) } });
  for (const row of index.rows) expect(row).toBe(previous.get(row.path));
  const old = index.rows[100];
  update(index, {}, { pinned: [old.path], recent: [old.path] });
  expect(old.pinnedRank).toBe(1);
  expect(index.rows[100]).not.toBe(old);
  expect(index.rows[101]).toBe(previous.get(index.rows[101].path));
});
it("caches filtered rows by published revision and removed set", () => {
  const index = new GoToIndex("workspace");
  update(index, { groups: [{ id: "removed", name: "Removed", kind: "channel" }, { id: "kept", name: "Kept", kind: "channel" }] });
  const removed = index.removedKeys({ groups: [{ id: "kept", name: "Kept", kind: "channel" }] });
  const rows = index.rowsWithout(removed);
  expect(rows.map(row => row.id)).toEqual(["group:kept"]);
  expect(index.rowsWithout(removed)).toBe(rows);
  expect(index.rowsWithout(new Set(["group:kept"])).map(row => row.id)).toEqual(["group:removed"]);
  update(index, { groups: [{ id: "kept", name: "Renamed", kind: "channel" }] });
  expect(index.rowsWithout(removed)).not.toBe(rows);
  expect(index.rowsWithout(removed)[0].label).toBe("Renamed");
});
it("keeps requested removals when every non-file source is undefined during reload", () => {
  const index = new GoToIndex("workspace");
  update(index, { listing: listing([]), groups: [{ id: "x", name: "Channel X", kind: "channel" }], collections: [{ path: "records", objectId: "records" }], apps: [{ root: "planner", title: "Planner" }], versions: [{ id: "main", name: "Main" }] });
  const run = index.update({ groups: [], collections: [], apps: [], versions: [] });
  const removed = index.removedKeys({ groups: undefined, collections: undefined, apps: undefined, versions: undefined });
  for (const word of ["Channel", "records", "Planner", "Main"]) expect(index.query(word, 50, removed)).toEqual([]);
  drain(run);
});
it("reorders only the changed rows after superseding a safe rename", () => {
  const index = new GoToIndex("workspace");
  const source = listing(Array.from({ length: 3_000 }, (_, n) => "docs/file-" + n + ".ts"));
  update(index, { listing: source });
  const first = { ...source, files: source.files.map((file, n) => n === 200 ? { ...file, path: "docs/first.ts" } : file) };
  const obsolete = index.update({ listing: first });
  let ticks = 0;
  expect(obsolete!.step(() => ++ticks)).toBe(false);
  const second = { ...first, files: first.files.map((file, n) => n === 300 ? { ...file, path: "docs/second.ts" } : file) };
  update(index, { listing: second });
  expect(index.lastReorderedCount).toBe(2);
  expect(index.query("first")).toHaveLength(1);
  expect(index.query("second")).toHaveLength(1);
});


it("reorders only the created row near the top and none after deletion", () => {
  const index = new GoToIndex("workspace");
  const first = listing(Array.from({ length: 2_000 }, (_, n) => "src/file-" + n + ".ts"));
  update(index, { listing: first });
  const created = { ...first, files: [first.files[0], { path: "src/new.ts", kind: "file" as const }, ...first.files.slice(1)] };
  update(index, { listing: created });
  expect(index.lastReorderedCount).toBe(1);
  expect(ids(index.query(""))).toEqual(fullSort(index, ""));
  update(index, { listing: first });
  expect(index.lastReorderedCount).toBe(0);
  expect(ids(index.query(""))).toEqual(fullSort(index, ""));
});
it("looks up each unchanged file only once during a rename", () => {
  const index = new GoToIndex("workspace");
  const first = listing(Array.from({ length: 2_000 }, (_, n) => "src/file-" + n + ".ts"));
  update(index, { listing: first });
  const get = vi.spyOn(Map.prototype, "get");
  update(index, { listing: { ...first, files: first.files.map((file, n) => n === 1 ? { ...file, path: "src/new.ts" } : file) } });
  const calls = get.mock.calls.slice(), maps = get.mock.contexts.slice();
  get.mockRestore();
  const fileMap = maps.find(map => map instanceof Map && (map.get(first.files[0].path) as PreparedGoToRow | undefined)?.kind === "file");
  const fileLookups = calls.filter((_, n) => maps[n] === fileMap);
  expect(fileMap).toBeDefined();
  expect(fileLookups.length).toBeLessThanOrEqual(first.files.length + 2);
  expect(index.query("new")[0].path).toBe("src/new.ts");
});
it("keeps pins and recency made while host visibility is degraded", () => {
  const index = new GoToIndex("workspace");
  const ready = listing(["a/report.md", "b/report.md", "c/report.md"]);
  update(index, { listing: ready });
  const old = index.query("report");
  update(index, { listing: { ...ready, visibility: { status: "degraded", rules: [] } } });
  update(index, {}, { pinned: ["c/report.md"], recent: ["b/report.md"] });
  expect(index.query("report")).toEqual([]);
  update(index, { listing: ready });
  expect(index.query("report").map(row => row.path)).toEqual(["c/report.md", "b/report.md", "a/report.md"]);
  expect(ids(index.query("report"))).toEqual(fullSort(index, "report"));
  expect(old.every(row => row.pinnedRank === 1 && row.recentRank === Number.MAX_SAFE_INTEGER)).toBe(true);
});
