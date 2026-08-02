// Shared unified-diff building + rendering (extracted from the shell's
// history diff page so the versions compare surface renders diffs the exact
// same way). Pure functions plus one presentational component; no IPC.
//
// Both callers — the history diff page in DesktopWorkspaceShell and the
// versions compare page in WorkspaceVersions — run on the UI thread, so the
// bounds below are what keeps a hydrated 10 MiB body from freezing them.
// computeTextDiff does the work ONCE per pair of bodies (both callers memoize
// it); buildUnifiedDiffLines and the counts only read the result.

export type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

export type UnifiedDiffLine = {
  kind: DiffLine["kind"] | "note";
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

/// One pair of bodies, diffed. Everything expensive happened when this was
/// built.
export type TextDiff = {
  /// When set, the whole body is this one note and `lines` is empty.
  note: string | null;
  /// The diff lines that were built — never more than the display can show.
  lines: DiffLine[];
  /// Diff lines the display bound stopped us from building. Their count still
  /// reaches the reader, as the "more diff lines hidden" note.
  hiddenLines: number;
  /// Added and removed line totals for the WHOLE change, never truncated.
  /// null means neither side of the change holds text.
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
// so the cell count bounds MEMORY: 250,000 cells is 1 MB.
const HISTORY_LCS_DIFF_CELL_LIMIT = 250_000;

// Each of those cells compares two WHOLE LINES, so the TIME is the cell count
// times the line length — linear in body bytes, which the cell limit does not
// bound. This bounds it. Measured by unifiedDiff.measure.test.ts (Windows 11,
// Node 22, the same V8 the renderer runs on): worst-case LCS moves a steady
// 23-25 million work units per millisecond, and the largest healthy body
// measured — 499 lines of 2,000-character paragraphs, 2 MB across both sides —
// is 500 million units. Two billion units is four times that headroom and
// measured at 86 ms, inside an interactive frame budget. A 10 MiB body sits at
// 5.2 billion, so it degrades to the contiguous diff instead of costing the
// 1.9 seconds it used to cost, twice per render.
export const HISTORY_DIFF_WORK_LIMIT = 2_000_000_000;

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
  // This list is NOT bounded by the display: the LCS threads changes through
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

  // Texts that differ ONLY invisibly (final-newline presence or CRLF/LF line
  // endings) split into identical line arrays, which would render as
  // "No text changes" — a lie for an exact-text change. Name the change
  // honestly instead. Only when BOTH sides exist: undefined-vs-empty is a
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
  return compactUnifiedDiffLines(numbered, 3, diff.displayLimit, diff.hiddenLines);
}

// The shared diff-lines block (history diff page + versions compare page):
// old/new gutters, +/- marker, wrapped code text — never raw markers.
export function UnifiedDiffLines(props: {
  lines: UnifiedDiffLine[];
  testId?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      className="overflow-x-hidden py-1 font-mono text-[12px] leading-5"
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
            className="border-y border-line/70 bg-panel px-3 py-1.5 text-center text-[11px] text-subtle"
          >
            {line.text}
          </div>
        ) : (
          <div
            key={index}
            data-kind={line.kind}
            className={`grid min-w-0 grid-cols-[44px_44px_24px_minmax(0,1fr)] ${
              line.kind === "added"
                ? "bg-success/10 text-success"
                : line.kind === "removed"
                  ? "bg-danger/10 text-danger"
                  : "text-muted"
            }`}
          >
            <span
              aria-hidden
              className="select-none border-r border-line/60 px-2 text-right text-[11px] text-subtle"
            >
              {line.oldLineNumber ?? ""}
            </span>
            <span
              aria-hidden
              className="select-none border-r border-line/60 px-2 text-right text-[11px] text-subtle"
            >
              {line.newLineNumber ?? ""}
            </span>
            <span aria-hidden className="select-none text-center">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : ""}
            </span>
            <code className="min-w-0 whitespace-pre-wrap break-words pr-3 font-inherit text-inherit">
              {line.text.length > 0 ? line.text : " "}
            </code>
          </div>
        ),
      )}
    </div>
  );
}
