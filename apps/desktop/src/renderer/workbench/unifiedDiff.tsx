// Shared unified-diff building + rendering (extracted from the shell's
// history diff page so the versions compare surface renders diffs the exact
// same way). Pure functions plus one presentational component; no IPC.

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

const HISTORY_LCS_DIFF_CELL_LIMIT = 250_000;

export function splitDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildContiguousDiff(before: string[], after: string[]): DiffLine[] {
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

  const out: DiffLine[] = [];
  const contextBefore = before.slice(Math.max(0, prefix - 2), prefix);
  for (const line of contextBefore) out.push({ kind: "context", text: line });

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  for (const line of removed) out.push({ kind: "removed", text: line });
  for (const line of added) out.push({ kind: "added", text: line });

  const contextAfter = after.slice(after.length - suffix, after.length - suffix + 2);
  for (const line of contextAfter) out.push({ kind: "context", text: line });
  return out;
}

export function buildLineDiff(before: string[], after: string[]): DiffLine[] {
  if (before.length === 0) {
    return after.map((text) => ({ kind: "added", text }));
  }
  if (after.length === 0) {
    return before.map((text) => ({ kind: "removed", text }));
  }

  const cellCount = (before.length + 1) * (after.length + 1);
  if (cellCount > HISTORY_LCS_DIFF_CELL_LIMIT) {
    return buildContiguousDiff(before, after);
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

  const out: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      out.push({ kind: "context", text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      table[at(beforeIndex + 1, afterIndex)] >=
      table[at(beforeIndex, afterIndex + 1)]
    ) {
      out.push({ kind: "removed", text: before[beforeIndex] });
      beforeIndex += 1;
    } else {
      out.push({ kind: "added", text: after[afterIndex] });
      afterIndex += 1;
    }
  }

  while (beforeIndex < before.length) {
    out.push({ kind: "removed", text: before[beforeIndex] });
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    out.push({ kind: "added", text: after[afterIndex] });
    afterIndex += 1;
  }
  return out;
}

function compactUnifiedDiffLines(
  lines: UnifiedDiffLine[],
  contextRadius = 2,
  limit = 80,
): UnifiedDiffLine[] {
  const changedIndexes = lines.flatMap((line, index) =>
    line.kind === "added" || line.kind === "removed" ? [index] : [],
  );
  if (changedIndexes.length === 0) {
    return [
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ];
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
    out.push({
      kind: "note",
      text: `${hiddenCount} unchanged line${hiddenCount === 1 ? "" : "s"} hidden`,
      oldLineNumber: null,
      newLineNumber: null,
    });
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

  if (out.length <= limit) return out;
  return [
    ...out.slice(0, limit),
    {
      kind: "note",
      text: `${out.length - limit} more diff line${
        out.length - limit === 1 ? "" : "s"
      } hidden`,
      oldLineNumber: null,
      newLineNumber: null,
    },
  ];
}

export function buildUnifiedDiffLines(
  beforeText: string | undefined,
  afterText: string | undefined,
  limit = 600,
): UnifiedDiffLine[] {
  const before = splitDiffLines(beforeText ?? "");
  const after = splitDiffLines(afterText ?? "");
  if (beforeText === afterText) {
    return [
      {
        kind: "note",
        text: "No text changes",
        oldLineNumber: null,
        newLineNumber: null,
      },
    ];
  }

  let oldLineNumber = 1;
  let newLineNumber = 1;
  const numbered = buildLineDiff(before, after).map<UnifiedDiffLine>((line) => {
    if (line.kind === "added") {
      const out = {
        ...line,
        oldLineNumber: null,
        newLineNumber,
      };
      newLineNumber += 1;
      return out;
    }
    if (line.kind === "removed") {
      const out = {
        ...line,
        oldLineNumber,
        newLineNumber: null,
      };
      oldLineNumber += 1;
      return out;
    }
    const out = {
      ...line,
      oldLineNumber,
      newLineNumber,
    };
    oldLineNumber += 1;
    newLineNumber += 1;
    return out;
  });
  return compactUnifiedDiffLines(numbered, 3, limit);
}

export function changedLineCounts(
  beforeText: string | undefined,
  afterText: string | undefined,
): { added: number; removed: number } | null {
  if (beforeText === undefined && afterText === undefined) return null;
  const before = splitDiffLines(beforeText ?? "");
  const after = splitDiffLines(afterText ?? "");
  if (beforeText === afterText) return { added: 0, removed: 0 };
  return buildLineDiff(before, after).reduce(
    (counts, line) => {
      if (line.kind === "added") counts.added += 1;
      if (line.kind === "removed") counts.removed += 1;
      return counts;
    },
    { added: 0, removed: 0 },
  );
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
        line.kind === "note" ? (
          <div
            key={`${index}:${line.text}`}
            data-kind={line.kind}
            className="border-y border-line/70 bg-panel px-3 py-1.5 text-center text-[11px] text-subtle"
          >
            {line.text}
          </div>
        ) : (
          <div
            key={`${index}:${line.kind}:${line.text}`}
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
