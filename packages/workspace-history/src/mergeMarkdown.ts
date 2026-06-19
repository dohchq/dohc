// Conflict handling for everyday people (plan Phase 10): safe markdown edits
// merge silently; anything ambiguous preserves BOTH versions verbatim and
// describes the situation in prose. Git conflict markers never appear — an AI
// proposal can sit alongside the conflict, but only a human applies it.
//
// This module is BROWSER-SAFE on purpose (no node: imports): the desktop
// renderer's live-collab reconcile imports it via the package's
// "./mergeMarkdown" subpath. Importing the package barrel from a renderer
// would drag changeSetStore's node:fs into the dev module graph (no
// tree-shaking in dev) and blank the window at load.

export type MergeResult =
  | { kind: "merged"; content: string }
  | { kind: "conflict" };

// Three-way line merge, deliberately conservative: each side's changes apply
// only when the other side left that region of the BASE untouched. Anything
// overlapping is a conflict — silent loss is never acceptable, so we'd rather
// surface a conflict than guess.
export function mergeMarkdown(input: {
  base: string;
  local: string;
  remote: string;
}): MergeResult {
  const { base, local, remote } = input;
  if (local === remote) return { kind: "merged", content: local };
  if (local === base) return { kind: "merged", content: remote };
  if (remote === base) return { kind: "merged", content: local };

  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  // Human-scale documents only: the DP alignment is quadratic, so very large
  // files skip straight to "conflict" (both versions preserved) rather than
  // risking a slow or wrong merge.
  const MAX_MERGE_LINES = 2000;
  if (
    baseLines.length > MAX_MERGE_LINES ||
    localLines.length > MAX_MERGE_LINES ||
    remoteLines.length > MAX_MERGE_LINES
  ) {
    return { kind: "conflict" };
  }

  const localHunks = diffHunks(baseLines, localLines);
  const remoteHunks = diffHunks(baseLines, remoteLines);

  // Hunks from the two sides may apply independently only when their BASE
  // ranges don't overlap; any overlap is contested.
  for (const l of localHunks) {
    for (const r of remoteHunks) {
      if (l.baseStart < r.baseEnd && r.baseStart < l.baseEnd) {
        return { kind: "conflict" };
      }
    }
  }

  const all = [...localHunks.map((h) => ({ ...h, side: "local" as const })), ...remoteHunks.map((h) => ({ ...h, side: "remote" as const }))]
    .sort((a, b) => a.baseStart - b.baseStart);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of all) {
    out.push(...baseLines.slice(cursor, hunk.baseStart));
    out.push(...hunk.replacement);
    cursor = hunk.baseEnd;
  }
  out.push(...baseLines.slice(cursor));
  return { kind: "merged", content: out.join("\n") };
}

interface Hunk {
  baseStart: number;
  baseEnd: number; // exclusive
  replacement: string[];
}

// LCS-aligned replacement hunks: regions of BASE replaced by regions of SIDE.
function diffHunks(base: string[], side: string[]): Hunk[] {
  const n = base.length;
  const m = side.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = base[i] === side[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let pendingStart = -1;
  let pendingReplacement: string[] = [];
  const flush = (baseEnd: number) => {
    if (pendingStart >= 0) {
      hunks.push({ baseStart: pendingStart, baseEnd, replacement: pendingReplacement });
      pendingStart = -1;
      pendingReplacement = [];
    }
  };
  while (i < n && j < m) {
    if (base[i] === side[j]) {
      flush(i);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      if (pendingStart < 0) pendingStart = i;
      i++; // base line removed
    } else {
      if (pendingStart < 0) pendingStart = i;
      pendingReplacement.push(side[j]);
      j++; // side line added
    }
  }
  if (i < n || j < m) {
    if (pendingStart < 0) pendingStart = i;
    pendingReplacement.push(...side.slice(j));
    hunks.push({ baseStart: pendingStart, baseEnd: n, replacement: pendingReplacement });
  } else {
    flush(i);
  }
  return hunks;
}
