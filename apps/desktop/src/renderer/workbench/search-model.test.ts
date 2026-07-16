import { describe, expect, it } from "vitest";
import type { SearchResultsEvent, SearchResultsEventEntry } from "../../ipc/channels";
import {
  applyBatch,
  beginSearch,
  GROUP_PREVIEW_ROWS,
  groupVisibleEntries,
  idleSearchModel,
  moveSearchSelection,
  PREVIEW_LEAD_CONTEXT_CHARS,
  PREVIEW_LEAD_TRIM_THRESHOLD,
  visibleFlatEntries,
  windowPreviewForRow,
} from "./search-model";

function entry(path: string, line = 1): SearchResultsEventEntry {
  return { path, line, column: 1, preview: `match in ${path}:${line}`, matchStart: 0, matchEnd: 5 };
}

function batch(overrides: Partial<SearchResultsEvent>): SearchResultsEvent {
  return { searchId: "s1", entries: [], done: false, limitHit: false, ...overrides };
}

describe("applyBatch", () => {
  it("groups streamed entries by file in arrival order", () => {
    let model = beginSearch("s1");
    model = applyBatch(model, batch({ entries: [entry("a.md", 1), entry("b.md", 2)] }));
    model = applyBatch(model, batch({ entries: [entry("a.md", 9)], done: true }));
    expect(model.groups.map((g) => g.path)).toEqual(["a.md", "b.md"]);
    expect(model.groups[0].entries.map((e) => e.line)).toEqual([1, 9]);
    expect(model.totalMatches).toBe(3);
    expect(model.status).toBe("complete");
  });

  it("DROPS stale batches: a superseded search's stragglers never corrupt results", () => {
    let model = beginSearch("s2");
    const stale = applyBatch(model, batch({ searchId: "s1", entries: [entry("old.md")] }));
    expect(stale).toBe(model); // same reference — identity says "ignored"
    model = applyBatch(model, batch({ searchId: "s2", entries: [entry("new.md")] }));
    expect(model.groups.map((g) => g.path)).toEqual(["new.md"]);
    // A stale DONE batch must not complete the new search either.
    expect(applyBatch(model, batch({ searchId: "s1", done: true })).status).toBe("searching");
  });

  it("ignores batches while idle and after completion", () => {
    const idle = idleSearchModel();
    expect(applyBatch(idle, batch({ entries: [entry("a.md")] }))).toBe(idle);
    let model = beginSearch("s1");
    model = applyBatch(model, batch({ done: true }));
    expect(applyBatch(model, batch({ entries: [entry("late.md")] }))).toBe(model);
  });

  it("keeps UNTOUCHED group references stable across batches (memo contract)", () => {
    let model = beginSearch("s1");
    model = applyBatch(model, batch({ entries: [entry("a.md"), entry("b.md")] }));
    const [a1, b1] = model.groups;
    model = applyBatch(model, batch({ entries: [entry("b.md", 7)] }));
    expect(model.groups[0]).toBe(a1); // untouched: same reference
    expect(model.groups[1]).not.toBe(b1); // touched: cloned
    expect(b1.entries).toHaveLength(1); // previous render's array unmutated
  });

  it("latches limitHit once any batch flags it", () => {
    let model = beginSearch("s1");
    model = applyBatch(model, batch({ entries: [entry("a.md")], limitHit: true }));
    model = applyBatch(model, batch({ done: true }));
    expect(model.limitHit).toBe(true);
  });

  it("carries a fail-closed notice and keeps it once set", () => {
    let model = beginSearch("s1");
    expect(model.notice).toBeNull();
    model = applyBatch(
      model,
      batch({ entries: [], done: true, notice: "Search paused: policy error" }),
    );
    expect(model.notice).toBe("Search paused: policy error");
    // beginSearch clears it for the next run.
    expect(beginSearch("s2").notice).toBeNull();
  });

  it("beginSearch resets prior results", () => {
    let model = beginSearch("s1");
    model = applyBatch(model, batch({ entries: [entry("a.md")] }));
    const fresh = beginSearch("s2");
    expect(fresh.groups).toEqual([]);
    expect(fresh.totalMatches).toBe(0);
    expect(fresh.status).toBe("searching");
  });
});

describe("visibleFlatEntries", () => {
  const none = new Set<string>();
  const groups = [
    { path: "a.md", entries: [entry("a.md", 1), entry("a.md", 2)] },
    { path: "b.md", entries: [entry("b.md", 3)] },
  ];

  it("flattens expanded groups in order", () => {
    const flat = visibleFlatEntries(groups, none, none);
    expect(flat.map((f) => `${f.path}:${f.entry.line}`)).toEqual(["a.md:1", "a.md:2", "b.md:3"]);
    expect(flat[1]).toMatchObject({ groupIndex: 0, entryIndex: 1 });
  });

  it("skips collapsed groups — keyboard nav steps through what is visible", () => {
    const flat = visibleFlatEntries(groups, new Set(["a.md"]), none);
    expect(flat.map((f) => f.path)).toEqual(["b.md"]);
  });

  it("truncates large groups to the preview window until shown-all (long-task bound)", () => {
    const big = {
      path: "big.md",
      entries: Array.from({ length: GROUP_PREVIEW_ROWS + 30 }, (_, i) => entry("big.md", i + 1)),
    };
    expect(groupVisibleEntries(big, false)).toHaveLength(GROUP_PREVIEW_ROWS);
    expect(groupVisibleEntries(big, true)).toHaveLength(GROUP_PREVIEW_ROWS + 30);
    // Small groups never truncate (no pointless "show 0 more").
    expect(groupVisibleEntries(groups[0], false)).toHaveLength(2);
    expect(visibleFlatEntries([big], none, none)).toHaveLength(GROUP_PREVIEW_ROWS);
    expect(visibleFlatEntries([big], none, new Set(["big.md"]))).toHaveLength(
      GROUP_PREVIEW_ROWS + 30,
    );
  });
});

describe("windowPreviewForRow (lead-trim so the match survives end-truncation)", () => {
  it("leaves shallow matches untouched", () => {
    const shallow = { preview: "hello needle world", matchStart: 6, matchEnd: 12 };
    expect(windowPreviewForRow(shallow)).toEqual({
      text: "hello needle world",
      matchStart: 6,
      matchEnd: 12,
      leadTrimmed: false,
    });
    // Exactly at the threshold is still untrimmed.
    const at = {
      preview: `${"x".repeat(PREVIEW_LEAD_TRIM_THRESHOLD)}needle tail`,
      matchStart: PREVIEW_LEAD_TRIM_THRESHOLD,
      matchEnd: PREVIEW_LEAD_TRIM_THRESHOLD + 6,
    };
    expect(windowPreviewForRow(at).leadTrimmed).toBe(false);
  });

  it("trims the lead of a deep-column match so the rendered window CONTAINS the match", () => {
    // Regression (codex E5.0 review, P1): a match past the visible row width
    // was clipped to invisibility by CSS end-truncation — e.g. the
    // 'jumptargettoken' E2E row rendered as 'line number 5 carries the …'.
    const preview = "line number 5 carries the jumptargettoken here";
    const windowed = windowPreviewForRow({ preview, matchStart: 26, matchEnd: 41 });
    expect(windowed.leadTrimmed).toBe(true);
    expect(windowed.matchStart).toBe(PREVIEW_LEAD_CONTEXT_CHARS);
    // The mark substring is intact in the rendered window, near its start.
    expect(windowed.text.slice(windowed.matchStart, windowed.matchEnd)).toBe(
      "jumptargettoken",
    );
    expect(windowed.text).toBe("ies the jumptargettoken here");
  });

  it("keeps offsets honest for very deep matches (offset math only, no regex)", () => {
    const preview = `${"a".repeat(200)}NEEDLE${"b".repeat(20)}`;
    const windowed = windowPreviewForRow({ preview, matchStart: 200, matchEnd: 206 });
    expect(windowed.text.slice(windowed.matchStart, windowed.matchEnd)).toBe("NEEDLE");
    expect(windowed.matchStart).toBe(PREVIEW_LEAD_CONTEXT_CHARS);
    expect(windowed.matchEnd - windowed.matchStart).toBe(6);
  });
});

describe("moveSearchSelection", () => {
  it("enters the list from -1: down lands on first, up on last", () => {
    expect(moveSearchSelection(-1, 1, 5)).toBe(0);
    expect(moveSearchSelection(-1, -1, 5)).toBe(4);
  });

  it("wraps both directions and handles empty lists", () => {
    expect(moveSearchSelection(4, 1, 5)).toBe(0);
    expect(moveSearchSelection(0, -1, 5)).toBe(4);
    expect(moveSearchSelection(2, 1, 5)).toBe(3);
    expect(moveSearchSelection(0, 1, 0)).toBe(-1);
  });
});
