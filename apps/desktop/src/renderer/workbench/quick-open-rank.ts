// Pure quick-open ranking (Phase E5.0 polish). Tier order is the plan's:
// prefix > word-boundary > substring > fuzzy subsequence; PINNED paths sort
// first overall, recent files are boosted within a tier (most recent wins),
// then shorter paths, then alphabetical. Case-insensitive throughout.

// Match-quality tiers, best first.
const TIER_BASENAME_PREFIX = 0;
const TIER_WORD_BOUNDARY = 1;
const TIER_SUBSTRING = 2;
const TIER_FUZZY = 3;

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// Word boundaries: the string start and any position after a separator
// (slash, dash, underscore, dot, space).
function startsAtWordBoundary(haystack: string, needle: string): boolean {
  if (haystack.startsWith(needle)) return true;
  for (let i = 1; i <= haystack.length - needle.length; i++) {
    if (!/[/\-_. ]/.test(haystack[i - 1])) continue;
    if (haystack.startsWith(needle, i)) return true;
  }
  return false;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

function quickOpenMatchTierLowercase(
  query: string,
  path: string,
  basename: string,
): number | null {
  if (query.length === 0) return TIER_SUBSTRING;
  if (basename.startsWith(query)) return TIER_BASENAME_PREFIX;
  if (startsAtWordBoundary(path, query)) return TIER_WORD_BOUNDARY;
  if (path.includes(query)) return TIER_SUBSTRING;
  if (isSubsequence(query, path)) return TIER_FUZZY;
  return null;
}

// The tier a path matches the query at, or null when it doesn't match.
// Exported for direct unit testing of the tier rules.
export function quickOpenMatchTier(query: string, path: string): number | null {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  return quickOpenMatchTierLowercase(q, p, basenameOf(p));
}

export interface QuickOpenContext {
  // Most recent first (workbench recentFiles).
  recent: readonly string[];
  pinned: readonly string[];
}

interface PreparedQuickOpenPath {
  path: string;
  lowercasePath: string;
  lowercaseBasename: string;
  pinnedRank: number;
  recentRank: number;
  sourceIndex: number;
}

interface ScoredQuickOpenPath {
  prepared: PreparedQuickOpenPath;
  tier: number;
}

// Build this index only when the file list, pins, or recent files change.
// Queries can then reuse every path-derived value.
export function prepareQuickOpenPaths(
  paths: readonly string[],
  context: QuickOpenContext,
): PreparedQuickOpenPath[] {
  const pinned = new Set(context.pinned);
  const recentRank = new Map(context.recent.map((path, index) => [path, index]));
  return paths.map((path, sourceIndex) => {
    const lowercasePath = path.toLowerCase();
    return {
      path,
      lowercasePath,
      lowercaseBasename: basenameOf(lowercasePath),
      pinnedRank: pinned.has(path) ? 0 : 1,
      recentRank: recentRank.get(path) ?? Number.MAX_SAFE_INTEGER,
      sourceIndex,
    };
  });
}

function compareCandidate(
  path: PreparedQuickOpenPath,
  tier: number,
  scored: ScoredQuickOpenPath,
): number {
  const other = scored.prepared;
  return (
    path.pinnedRank - other.pinnedRank ||
    tier - scored.tier ||
    path.recentRank - other.recentRank ||
    path.path.length - other.path.length ||
    (path.path < other.path ? -1 : path.path > other.path ? 1 : 0) ||
    // The previous full sort was stable. Equal paths therefore kept their
    // input order, which sourceIndex makes explicit for bounded selection.
    path.sourceIndex - other.sourceIndex
  );
}

function insertBounded(
  selected: ScoredQuickOpenPath[],
  path: PreparedQuickOpenPath,
  tier: number,
  limit: number,
): void {
  let low = 0;
  let high = selected.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareCandidate(path, tier, selected[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  selected.splice(low, 0, { prepared: path, tier });
  if (selected.length > limit) selected.pop();
}

// Rank a prepared index and retain at most `limit` paths. A finite limit uses
// bounded insertion, so a query never sorts the complete match set.
export function rankPreparedQuickOpenPaths(
  query: string,
  paths: readonly PreparedQuickOpenPath[],
  limit: number,
): string[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const lowercaseQuery = query.toLowerCase();
  const selected: ScoredQuickOpenPath[] = [];
  for (const path of paths) {
    const tier = quickOpenMatchTierLowercase(
      lowercaseQuery,
      path.lowercasePath,
      path.lowercaseBasename,
    );
    if (tier === null) continue;
    insertBounded(selected, path, tier, boundedLimit);
  }
  return selected.map((path) => path.prepared.path);
}

// Ranks `paths` for `query`. Non-matching paths are excluded. Sort key, in
// order: pinned first → match tier → recency rank (more recent first; the
// "recent files boosted" rule) → shorter path → alphabetical.
export function rankQuickOpenPaths(
  query: string,
  paths: readonly string[],
  context: QuickOpenContext,
): string[] {
  const prepared = prepareQuickOpenPaths(paths, context);
  return rankPreparedQuickOpenPaths(query, prepared, prepared.length);
}
