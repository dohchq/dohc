// Pure content-search result model (Phase E5.0). Streamed batches fold into
// grouped-by-file results; everything here is unit-testable without React or
// Electron. The renderer NEVER re-executes the pattern: highlighting comes
// only from each entry's matchStart/matchEnd offsets.

import type {
  SearchResultsEvent,
  SearchResultsEventEntry,
} from "../../ipc/channels";

export interface SearchGroup {
  path: string;
  entries: SearchResultsEventEntry[];
}

export interface SearchModel {
  // The id of the search these results belong to; batches with any other id
  // are STALE (a superseded search's stragglers) and must be dropped.
  searchId: string | null;
  status: "idle" | "searching" | "complete";
  limitHit: boolean;
  groups: SearchGroup[];
  totalMatches: number;
  // Set when a batch carries a fail-closed/degraded notice (e.g. a broken
  // workspace policy file paused search): the panel shows it so an empty
  // result is explained, never silently blank.
  notice: string | null;
}

export function idleSearchModel(): SearchModel {
  return {
    searchId: null,
    status: "idle",
    limitHit: false,
    groups: [],
    totalMatches: 0,
    notice: null,
  };
}

export function beginSearch(searchId: string): SearchModel {
  return {
    searchId,
    status: "searching",
    limitHit: false,
    groups: [],
    totalMatches: 0,
    notice: null,
  };
}

// Folds one streamed batch into the model. Stale batches (searchId mismatch,
// including batches arriving while idle) return the SAME model reference —
// the caller can use identity to skip work. Entries append grouped by file in
// arrival order; only TOUCHED groups are cloned so memoized group components
// skip re-rendering on every later batch.
export function applyBatch(model: SearchModel, batch: SearchResultsEvent): SearchModel {
  if (model.searchId === null || batch.searchId !== model.searchId) return model;
  if (model.status === "complete") return model;
  let groups = model.groups;
  if (batch.entries.length > 0) {
    groups = [...model.groups];
    const indexByPath = new Map(groups.map((group, index) => [group.path, index]));
    const touched = new Set<number>();
    for (const entry of batch.entries) {
      let index = indexByPath.get(entry.path);
      if (index === undefined) {
        index = groups.length;
        groups.push({ path: entry.path, entries: [] });
        indexByPath.set(entry.path, index);
        touched.add(index);
      } else if (!touched.has(index)) {
        // First touch this batch: clone so the previous render's array stays
        // immutable (memo identity for untouched groups is preserved).
        groups[index] = { ...groups[index], entries: [...groups[index].entries] };
        touched.add(index);
      }
      groups[index].entries.push(entry);
    }
  }
  return {
    searchId: model.searchId,
    status: batch.done ? "complete" : "searching",
    limitHit: model.limitHit || batch.limitHit,
    groups,
    totalMatches: model.totalMatches + batch.entries.length,
    // A later batch without a notice never clears an earlier one for the same
    // search (the pause reason persists until the search is re-run).
    notice: batch.notice ?? model.notice,
  };
}

export interface FlatSearchEntry {
  path: string;
  entry: SearchResultsEventEntry;
  groupIndex: number;
  entryIndex: number;
}

// Rendered-row bound per group (performance, not policy): a short query on
// prose can put hundreds of matches in ONE file, and committing them all in
// one render is a keystroke-budget long task. Groups over the bound render a
// "show more" affordance; expanding is per group.
export const GROUP_PREVIEW_ROWS = 20;

// Rendered-GROUP bound (same budget): a query matching once per file across
// thousands of files would otherwise mount thousands of group headers while
// batches stream in. The view renders the first window of groups and a
// "show more files" tail extends it; the MODEL always holds everything (the
// summary and cap notice count the full result set).
export const GROUP_WINDOW_STEP = 100;

// The entries a group actually SHOWS: all of them when expanded (or small),
// the first GROUP_PREVIEW_ROWS otherwise.
export function groupVisibleEntries(
  group: SearchGroup,
  showAll: boolean,
): SearchResultsEventEntry[] {
  return showAll || group.entries.length <= GROUP_PREVIEW_ROWS
    ? group.entries
    : group.entries.slice(0, GROUP_PREVIEW_ROWS);
}

// The keyboard-navigation order: every VISIBLE entry in arrival order —
// collapsed groups contribute nothing, truncated groups contribute their
// preview window. What you see is exactly what you step through.
export function visibleFlatEntries(
  groups: SearchGroup[],
  collapsed: ReadonlySet<string>,
  showAllGroups: ReadonlySet<string>,
): FlatSearchEntry[] {
  const flat: FlatSearchEntry[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (collapsed.has(group.path)) continue;
    const visible = groupVisibleEntries(group, showAllGroups.has(group.path));
    for (let entryIndex = 0; entryIndex < visible.length; entryIndex++) {
      flat.push({ path: group.path, entry: visible[entryIndex], groupIndex, entryIndex });
    }
  }
  return flat;
}

// --- Preview lead-trim (the rendered row truncates at its END) ---
//
// Result rows render in a ~210px panel that fits roughly 28 monospace
// characters before CSS end-truncation. A match starting deeper than that
// would be ENTIRELY invisible in its own result row — the engine's preview
// windowing only kicks in past 250 chars and deliberately leaves ~83 chars
// of lead-in. So the RENDERER windows again: when the match starts past the
// threshold, trim the lead to a few context chars, prepend a literal
// ellipsis, and shift the offsets by the trim (still offset-based — the
// pattern never re-executes here).

// Matches starting at or before this column render untrimmed.
export const PREVIEW_LEAD_TRIM_THRESHOLD = 24;
// Context characters kept immediately before the match after a trim.
export const PREVIEW_LEAD_CONTEXT_CHARS = 8;

export interface WindowedPreview {
  text: string;
  matchStart: number;
  matchEnd: number;
  // True when the lead was trimmed (the renderer prepends an ellipsis).
  leadTrimmed: boolean;
}

export function windowPreviewForRow(entry: {
  preview: string;
  matchStart: number;
  matchEnd: number;
}): WindowedPreview {
  if (entry.matchStart <= PREVIEW_LEAD_TRIM_THRESHOLD) {
    return {
      text: entry.preview,
      matchStart: entry.matchStart,
      matchEnd: entry.matchEnd,
      leadTrimmed: false,
    };
  }
  const trim = entry.matchStart - PREVIEW_LEAD_CONTEXT_CHARS;
  return {
    text: entry.preview.slice(trim),
    matchStart: PREVIEW_LEAD_CONTEXT_CHARS,
    matchEnd: entry.matchEnd - trim,
    leadTrimmed: true,
  };
}

// Wrap-around selection move (CommandPalette semantics). -1 means "nothing
// selected": the first ArrowDown lands on 0, the first ArrowUp on the last.
export function moveSearchSelection(current: number, delta: number, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}
