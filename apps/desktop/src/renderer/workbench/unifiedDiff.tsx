// Shared unified-diff building + rendering (extracted from the shell's
// history diff page so the versions compare surface renders diffs the exact
// same way). Pure functions plus one presentational component; no IPC.
//
// Both callers — the history diff page in DesktopWorkspaceShell and the
// versions compare page in WorkspaceVersions — run on the UI thread, so the
// bounds below are what keeps a hydrated 10 MiB body from freezing them.
// computeTextDiff does the work once per pair of bodies (both callers memoize
// it); buildUnifiedDiffLines and the counts only read the result.

import type { ReactNode } from "react";

type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

/// A changed span of a line's text: [start, end) in UTF-16 units.
type WordRange = readonly [start: number, end: number];

export type UnifiedDiffLine = {
  kind: DiffLine["kind"] | "note";
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  /// The changed words of an added or removed line that pairs with a similar
  /// line on the other side. Absent when the whole line is the change.
  words?: readonly WordRange[];
};

/// One pair of bodies, diffed. Everything expensive happened when this was
/// built.
type TextDiff = {
  /// When set, the whole body is this one note and `lines` is empty.
  note: string | null;
  /// The diff lines that were built — never more than the display can show.
  lines: DiffLine[];
  /// Diff lines the display bound stopped us from building. Their count still
  /// reaches the reader, as the "more diff lines hidden" note.
  hiddenLines: number;
  /// Added and removed line totals for the whole diff, never cut by the
  /// display bound. A DEGRADED diff describes the span between the common
  /// prefix and the common suffix as one block, so its totals are that span,
  /// not the exact edit: two edits far apart read as one large block, the same
  /// way its lines do. null means neither side of the change holds text.
  counts: { added: number; removed: number } | null;
  /// The 1-based file line numbers the first entry of `lines` carries. The
  /// contiguous fallback starts partway down the file, so it does not start
  /// at line 1.
  firstOldLine: number;
  firstNewLine: number;
  /// The bodies were too big to compare line by line, so `lines` is the
  /// contiguous approximation: one removed block, then one added block.
  degraded: boolean;
  /// The most diff lines the display will show.
  displayLimit: number;
};

// The LCS table holds one Uint32Array cell per (before line, after line) pair,
// so the cell count bounds memory: 250,000 cells is 1 MB.
const HISTORY_LCS_DIFF_CELL_LIMIT = 250_000;

// Each of those cells compares two whole lines, so the time is the cell count
// times the line length, which the cell limit does not bound. This bounds it.
// Measured by unifiedDiff.measure.test.ts (Windows 11, Node 22, the renderer's
// V8): the largest body this limit admits (499 lines of 3,990 characters, 4 MB
// across both sides) costs 50 ms for a full pass. `.length` counts UTF-16
// code units, and a CJK comparison costs about twice an ASCII one of the same
// unit count, so the limit is halved to hold for either script. The largest
// healthy body measured (499 lines of 2,000-character paragraphs) is 500
// million units, so this is twice the healthy maximum; a 10 MiB body degrades
// to the contiguous diff.
export const HISTORY_DIFF_WORK_LIMIT = 1_000_000_000;

/// An upper bound on the characters the LCS inner loop must compare: one whole
/// line per cell. Cheap to compute, and the reason the cell limit alone never
/// saw the cost.
export function diffWorkEstimate(before: string[], after: string[]): number {
  const lineCount = before.length + after.length;
  if (lineCount === 0) return 0;
  let chars = 0;
  for (const line of before) chars += line.length;
  for (const line of after) chars += line.length;
  return ((before.length + 1) * (after.length + 1) * chars) / lineCount;
}

function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export function splitDiffLines(text: string): string[] {
  const normalized = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type LineDiff = {
  lines: DiffLine[];
  hiddenLines: number;
  added: number;
  removed: number;
  firstOldLine: number;
  firstNewLine: number;
  degraded: boolean;
};

// Take at most `maxLines` of `source` onto `out`, and report what was left.
function pushBounded(
  out: DiffLine[],
  source: string[],
  kind: DiffLine["kind"],
  maxLines: number,
): number {
  const taken = Math.min(Math.max(0, maxLines - out.length), source.length);
  for (let index = 0; index < taken; index += 1) {
    out.push({ kind, text: source[index] });
  }
  return source.length - taken;
}

// The degraded shape: everything between the common prefix and the common
// suffix becomes one removed block followed by one added block. Compaction
// never drops any of that — it only drops context lines — so building more
// than the display shows is pure waste. A 10 MiB body of short lines used to
// build two million objects to render eight hundred.
function buildContiguousDiff(
  before: string[],
  after: string[],
  maxLines: number,
): LineDiff {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix + prefix < before.length &&
    suffix + prefix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = before.slice(Math.max(0, prefix - 2), prefix);
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const contextAfter = after.slice(after.length - suffix, after.length - suffix + 2);

  const lines: DiffLine[] = [];
  let hiddenLines = 0;
  hiddenLines += pushBounded(lines, contextBefore, "context", maxLines);
  hiddenLines += pushBounded(lines, removed, "removed", maxLines);
  hiddenLines += pushBounded(lines, added, "added", maxLines);
  hiddenLines += pushBounded(lines, contextAfter, "context", maxLines);

  const firstLine = prefix - contextBefore.length + 1;
  return {
    lines,
    hiddenLines,
    added: added.length,
    removed: removed.length,
    firstOldLine: firstLine,
    firstNewLine: firstLine,
    degraded: true,
  };
}

function countKinds(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}

function buildLineDiff(before: string[], after: string[], maxLines: number): LineDiff {
  // A create or a delete is already the degraded shape: one block, nothing to
  // interleave, and nothing for compaction to drop.
  if (before.length === 0 || after.length === 0) {
    const created = before.length === 0;
    const source = created ? after : before;
    const lines: DiffLine[] = [];
    const hiddenLines = pushBounded(
      lines,
      source,
      created ? "added" : "removed",
      maxLines,
    );
    return {
      lines,
      hiddenLines,
      added: created ? source.length : 0,
      removed: created ? 0 : source.length,
      firstOldLine: 1,
      firstNewLine: 1,
      degraded: false,
    };
  }

  const cellCount = (before.length + 1) * (after.length + 1);
  if (
    cellCount > HISTORY_LCS_DIFF_CELL_LIMIT ||
    diffWorkEstimate(before, after) > HISTORY_DIFF_WORK_LIMIT
  ) {
    return buildContiguousDiff(before, after, maxLines);
  }

  const columnCount = after.length + 1;
  const table = new Uint32Array(cellCount);
  const at = (beforeIndex: number, afterIndex: number) =>
    beforeIndex * columnCount + afterIndex;

  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      if (before[beforeIndex] === after[afterIndex]) {
        table[at(beforeIndex, afterIndex)] =
          table[at(beforeIndex + 1, afterIndex + 1)] + 1;
      } else {
        table[at(beforeIndex, afterIndex)] = Math.max(
          table[at(beforeIndex + 1, afterIndex)],
          table[at(beforeIndex, afterIndex + 1)],
        );
      }
    }
  }

  const lines: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      lines.push({ kind: "context", text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      table[at(beforeIndex + 1, afterIndex)] >=
      table[at(beforeIndex, afterIndex + 1)]
    ) {
      lines.push({ kind: "removed", text: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      lines.push({ kind: "added", text: after[afterIndex] });
      afterIndex += 1;
    }
  }

  while (beforeIndex < before.length) {
    lines.push({ kind: "removed", text: before[beforeIndex] });
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    lines.push({ kind: "added", text: after[afterIndex] });
    afterIndex += 1;
  }
  // This list is not bounded by the display: the LCS threads changes through
  // the whole body, so compaction still has context lines to drop between
  // them. Cutting the list here would change what the reader sees, not only
  // what we throw away. The cell limit already holds it under 250,000 lines.
  return {
    lines,
    hiddenLines: 0,
    ...countKinds(lines),
    firstOldLine: 1,
    firstNewLine: 1,
    degraded: false,
  };
}

function noteDiff(text: string, displayLimit: number): TextDiff {
  return {
    note: text,
    lines: [],
    hiddenLines: 0,
    counts: { added: 0, removed: 0 },
    firstOldLine: 1,
    firstNewLine: 1,
    degraded: false,
    displayLimit,
  };
}

/// Diff two bodies. This is the expensive call: make it once per pair of
/// bodies, then read the result as often as the render needs.
export function computeTextDiff(
  beforeText: string | undefined,
  afterText: string | undefined,
  displayLimit = 600,
): TextDiff {
  if (beforeText === undefined && afterText === undefined) {
    return { ...noteDiff("No text changes", displayLimit), counts: null };
  }
  if (beforeText === afterText) return noteDiff("No text changes", displayLimit);

  const before = splitDiffLines(beforeText ?? "");
  const after = splitDiffLines(afterText ?? "");

  // Texts that differ only invisibly (final-newline presence or CRLF/LF line
  // endings) split into identical line arrays, which would render as
  // "No text changes" — a lie for an exact-text change. Name the change
  // honestly instead. Only when both sides exist: undefined-vs-empty is a
  // create/delete of an empty file, not a line-ending change.
  if (beforeText !== undefined && afterText !== undefined && linesEqual(before, after)) {
    return noteDiff("Only line endings or the final newline changed", displayLimit);
  }

  // Four lines of headroom: the contiguous fallback adds at most two context
  // lines at each end, and compaction keeps every one of them.
  const diff = buildLineDiff(before, after, displayLimit + 4);
  return {
    note: null,
    lines: diff.lines,
    hiddenLines: diff.hiddenLines,
    counts: { added: diff.added, removed: diff.removed },
    firstOldLine: diff.firstOldLine,
    firstNewLine: diff.firstNewLine,
    degraded: diff.degraded,
    displayLimit,
  };
}

function note(text: string): UnifiedDiffLine {
  return { kind: "note", text, oldLineNumber: null, newLineNumber: null };
}

function compactUnifiedDiffLines(
  lines: UnifiedDiffLine[],
  contextRadius: number,
  limit: number,
  neverBuilt: number,
): UnifiedDiffLine[] {
  const changedIndexes = lines.flatMap((line, index) =>
    line.kind === "added" || line.kind === "removed" ? [index] : [],
  );
  if (changedIndexes.length === 0 && neverBuilt === 0) {
    return [note("No text changes")];
  }

  const keep = new Set<number>();
  for (const changedIndex of changedIndexes) {
    for (
      let index = Math.max(0, changedIndex - contextRadius);
      index <= Math.min(lines.length - 1, changedIndex + contextRadius);
      index += 1
    ) {
      keep.add(index);
    }
  }

  const out: UnifiedDiffLine[] = [];
  let hiddenCount = 0;
  const flushHidden = () => {
    if (hiddenCount === 0) return;
    out.push(note(`${hiddenCount} unchanged line${hiddenCount === 1 ? "" : "s"} hidden`));
    hiddenCount = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind === "context" && !keep.has(index)) {
      hiddenCount += 1;
      continue;
    }
    flushHidden();
    out.push(line);
  }
  flushHidden();

  const hidden = Math.max(0, out.length - limit) + neverBuilt;
  if (hidden === 0) return out;
  return [
    ...out.slice(0, limit),
    note(`${hidden} more diff line${hidden === 1 ? "" : "s"} hidden`),
  ];
}

// Word marks are made only for the lines the page shows, so the display bound
// already caps how many pairs there are. This caps their size. Past this many
// characters across every paired line, the whole diff stays at line level:
// one 10 MiB line would otherwise cost its whole length to split into words.
// Measured on Windows 11 in Node 24: 602 marked lines of 240 characters add
// 3 ms to the page's diff, and 11 ms when they also spend all of
// WORD_DIFF_PAGE_CELLS below.
export const WORD_DIFF_CHAR_LIMIT = 200_000;

// Each pair compares only the words between its common start and end. Past
// this many cells (about 125 words and spaces a side), or once the page has
// spent its cells, that middle is marked as one change instead of word by
// word.
const WORD_DIFF_CELL_LIMIT = 16_000;
const WORD_DIFF_PAGE_CELLS = 1_000_000;

// A pair whose lines share less than half of the longer line is a rewrite:
// marking nearly every word would hide the few that stayed.
const WORD_DIFF_MIN_SHARED = 0.5;

// One token: a CJK character (those scripts put no spaces between words), a
// word, a run of whitespace, or any other single character.
const WORD_TOKEN =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{M}\p{N}_])+|\s+|[^]/gu;

// The changed tokens as ranges of `text`. Two changes one space apart read as
// one change, so "quick brown" -> "slow red" marks both words together.
function changedRanges(text: string, tokens: string[], changed: Uint8Array): WordRange[] {
  const ranges: [number, number][] = [];
  let offset = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const end = offset + tokens[index].length;
    if (changed[index] === 1) {
      const last = ranges[ranges.length - 1];
      if (last && (last[1] === offset || /^\s+$/.test(text.slice(last[1], offset)))) last[1] = end;
      else ranges.push([offset, end]);
    }
    offset = end;
  }
  return ranges;
}

function rangeLength(ranges: readonly WordRange[]): number {
  let length = 0;
  for (const [start, end] of ranges) length += end - start;
  return length;
}

/// The changed words of one removed line and the added line it pairs with, or
/// null when they share too little for word marks to help. A word-by-word
/// comparison spends its cells from `budget`.
export function changedWords(
  before: string,
  after: string,
  budget: { cells: number } = { cells: WORD_DIFF_CELL_LIMIT },
): { before: WordRange[]; after: WordRange[] } | null {
  const a = before.match(WORD_TOKEN) ?? [];
  const b = after.match(WORD_TOKEN) ?? [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix + prefix < a.length &&
    suffix + prefix < b.length &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const aChanged = new Uint8Array(a.length);
  const bChanged = new Uint8Array(b.length);
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const columns = bEnd - prefix + 1;
  const cells = (aEnd - prefix + 1) * columns;
  if (cells > Math.min(WORD_DIFF_CELL_LIMIT, budget.cells)) {
    aChanged.fill(1, prefix, aEnd);
    bChanged.fill(1, prefix, bEnd);
  } else {
    budget.cells -= cells;
    // The same longest-common-subsequence walk as the line diff, over words.
    // Each word becomes a number first, so a cell compares two integers.
    const ids = new Map<string, number>();
    const idOf = (token: string) => {
      let id = ids.get(token);
      if (id === undefined) ids.set(token, (id = ids.size));
      return id;
    };
    const rows = aEnd - prefix;
    const cols = bEnd - prefix;
    const aIds = Int32Array.from({ length: rows }, (_, i) => idOf(a[prefix + i]));
    const bIds = Int32Array.from({ length: cols }, (_, j) => idOf(b[prefix + j]));
    const table = new Uint16Array((rows + 1) * columns);
    for (let i = rows - 1; i >= 0; i -= 1) {
      const row = i * columns;
      const below = row + columns;
      const id = aIds[i];
      for (let j = cols - 1; j >= 0; j -= 1) {
        if (id === bIds[j]) {
          table[row + j] = table[below + j + 1] + 1;
        } else {
          const down = table[below + j];
          const right = table[row + j + 1];
          table[row + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (aIds[i] === bIds[j]) {
        i += 1;
        j += 1;
      } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
        aChanged[prefix + i] = 1;
        i += 1;
      } else {
        bChanged[prefix + j] = 1;
        j += 1;
      }
    }
    aChanged.fill(1, prefix + i, aEnd);
    bChanged.fill(1, prefix + j, bEnd);
  }
  const beforeRanges = changedRanges(before, a, aChanged);
  const afterRanges = changedRanges(after, b, bChanged);
  const shared = Math.min(
    before.length - rangeLength(beforeRanges),
    after.length - rangeLength(afterRanges),
  );
  if (shared < WORD_DIFF_MIN_SHARED * Math.max(before.length, after.length)) return null;
  return { before: beforeRanges, after: afterRanges };
}

// Pairs each change block's removed and added lines in order, and marks their
// changed words. All or nothing: past WORD_DIFF_CHAR_LIMIT no line is marked,
// so a page never mixes the two levels.
function markChangedWords(lines: UnifiedDiffLine[]): UnifiedDiffLine[] {
  const pairs: [number, number][] = [];
  let chars = 0;
  let index = 0;
  while (index < lines.length) {
    const removed: number[] = [];
    const added: number[] = [];
    while (index < lines.length && (lines[index].kind === "removed" || lines[index].kind === "added")) {
      (lines[index].kind === "removed" ? removed : added).push(index);
      index += 1;
    }
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
      chars += lines[removed[pair]].text.length + lines[added[pair]].text.length;
      if (chars > WORD_DIFF_CHAR_LIMIT) return lines;
      pairs.push([removed[pair], added[pair]]);
    }
    if (removed.length === 0 && added.length === 0) index += 1;
  }
  if (pairs.length === 0) return lines;
  const marked = lines.slice();
  const budget = { cells: WORD_DIFF_PAGE_CELLS };
  for (const [removedIndex, addedIndex] of pairs) {
    const words = changedWords(lines[removedIndex].text, lines[addedIndex].text, budget);
    if (!words) continue;
    marked[removedIndex] = { ...lines[removedIndex], words: words.before };
    marked[addedIndex] = { ...lines[addedIndex], words: words.after };
  }
  return marked;
}

export function buildUnifiedDiffLines(diff: TextDiff): UnifiedDiffLine[] {
  if (diff.note !== null) return [note(diff.note)];

  let oldLineNumber = diff.firstOldLine;
  let newLineNumber = diff.firstNewLine;
  const numbered = diff.lines.map<UnifiedDiffLine>((line) => {
    if (line.kind === "added") {
      const out = { ...line, oldLineNumber: null, newLineNumber };
      newLineNumber += 1;
      return out;
    }
    if (line.kind === "removed") {
      const out = { ...line, oldLineNumber, newLineNumber: null };
      oldLineNumber += 1;
      return out;
    }
    const out = { ...line, oldLineNumber, newLineNumber };
    oldLineNumber += 1;
    newLineNumber += 1;
    return out;
  });
  return markChangedWords(
    compactUnifiedDiffLines(numbered, 3, diff.displayLimit, diff.hiddenLines),
  );
}

// A changed line's text, with its changed words inside <ins> or <del>, which
// screen readers announce as an insertion or a deletion.
function LineText({ line }: { line: UnifiedDiffLine }) {
  if (line.text.length === 0) return " ";
  if (!line.words || line.words.length === 0) return line.text;
  const Mark = line.kind === "added" ? "ins" : "del";
  const fill = line.kind === "added" ? "bg-success/30" : "bg-danger/30";
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const [start, end] of line.words) {
    if (start > offset) parts.push(line.text.slice(offset, start));
    parts.push(
      <Mark key={start} className={`rounded-xs no-underline ${fill}`}>
        {line.text.slice(start, end)}
      </Mark>,
    );
    offset = end;
  }
  if (offset < line.text.length) parts.push(line.text.slice(offset));
  return parts;
}

// The shared diff-lines block (history diff page, versions compare page,
// proposal review): old/new gutters, then the text. A changed line is tinted
// with a bar at its edge, and its number sits in only one gutter, so the
// change reads without color too.
export function UnifiedDiffLines(props: {
  lines: UnifiedDiffLine[];
  testId?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      className="overflow-x-hidden py-2 font-mono text-[12px] leading-5"
    >
      {props.lines.map((line, index) =>
        // Keyed by position alone. The list is rebuilt whole whenever the diff
        // changes, and a key that interpolates the line text copies every
        // rendered body into a string for React to hash — up to the whole
        // file, for one 10 MiB line.
        line.kind === "note" ? (
          <div
            key={index}
            data-kind={line.kind}
            className="mx-4 my-0.5 flex min-h-6 items-center rounded-md px-2 font-sans text-[11px] text-subtle"
          >
            {line.text}
          </div>
        ) : (
          <div
            key={index}
            data-kind={line.kind}
            className={`grid min-w-0 grid-cols-[40px_40px_minmax(0,1fr)] pl-3.5 ${
              line.kind === "added"
                ? "bg-success/8 text-ink shadow-[inset_2px_0_0_var(--color-success)]"
                : line.kind === "removed"
                  ? "bg-danger/8 text-ink shadow-[inset_2px_0_0_var(--color-danger)]"
                  : "text-muted"
            }`}
          >
            <span aria-hidden className="select-none pr-3 text-right text-[11px] text-subtle">
              {line.oldLineNumber ?? ""}
            </span>
            <span aria-hidden className="select-none pr-3 text-right text-[11px] text-subtle">
              {line.newLineNumber ?? ""}
            </span>
            <code className="min-w-0 whitespace-pre-wrap break-words pl-2.5 pr-3 font-inherit text-inherit">
              {line.kind === "context" ? null : (
                <span className="sr-only select-none">
                  {line.kind === "added" ? "Added: " : "Removed: "}
                </span>
              )}
              <LineText line={line} />
            </code>
          </div>
        ),
      )}
    </div>
  );
}

/// The five cells of the bar beside a diff's counts: one per line while the
/// change is five lines or fewer, else shared in proportion, with at least
/// one cell for each side that has lines.
export function diffStatCells(added: number, removed: number): ("added" | "removed" | "none")[] {
  const total = added + removed;
  let addedCells = added;
  let removedCells = removed;
  if (total > 5) {
    addedCells = Math.round((added / total) * 5);
    if (added > 0) addedCells = Math.max(1, addedCells);
    if (removed > 0) addedCells = Math.min(4, addedCells);
    removedCells = 5 - addedCells;
  }
  return Array.from({ length: 5 }, (_, cell) =>
    cell < addedCells ? "added" : cell < addedCells + removedCells ? "removed" : "none",
  );
}

/// A diff's size in lines: `+2 −2` and the bar. Screen readers hear the
/// counts in words instead.
export function DiffCounts(props: {
  counts: { added: number; removed: number };
  testId?: string;
}) {
  const { added, removed } = props.counts;
  return (
    <span data-testid={props.testId} className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
      <span className="sr-only">
        {added} {added === 1 ? "line" : "lines"} added, {removed} {removed === 1 ? "line" : "lines"} removed
      </span>
      <span aria-hidden className="text-success">+{added}</span>
      <span aria-hidden className="text-danger">−{removed}</span>
      <span aria-hidden className="flex gap-0.5">
        {diffStatCells(added, removed).map((cell, index) => (
          <span
            key={index}
            className={`size-[7px] rounded-xs ${
              cell === "added" ? "bg-success" : cell === "removed" ? "bg-danger" : "bg-line"
            }`}
          />
        ))}
      </span>
    </span>
  );
}
