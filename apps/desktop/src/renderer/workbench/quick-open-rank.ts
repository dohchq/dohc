// Pure quick-open ranking (Phase E5.0 polish). Tier order is the plan's:
// prefix > word-boundary > substring > fuzzy subsequence; PINNED paths sort
// first overall, RECENT files are boosted within a tier (most recent wins),
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

// The tier a path matches the query at, or null when it doesn't match.
// Exported for direct unit testing of the tier rules.
export function quickOpenMatchTier(query: string, path: string): number | null {
  const q = query.toLowerCase();
  if (q.length === 0) return TIER_SUBSTRING;
  const p = path.toLowerCase();
  if (basenameOf(p).startsWith(q)) return TIER_BASENAME_PREFIX;
  if (startsAtWordBoundary(p, q)) return TIER_WORD_BOUNDARY;
  if (p.includes(q)) return TIER_SUBSTRING;
  if (isSubsequence(q, p)) return TIER_FUZZY;
  return null;
}

export interface QuickOpenContext {
  // Most recent FIRST (workbench recentFiles).
  recent: string[];
  pinned: string[];
}

// Ranks `paths` for `query`. Non-matching paths are excluded. Sort key, in
// order: pinned first → match tier → recency rank (more recent first; the
// "recent files boosted" rule) → shorter path → alphabetical.
export function rankQuickOpenPaths(
  query: string,
  paths: readonly string[],
  context: QuickOpenContext,
): string[] {
  const pinned = new Set(context.pinned);
  const recentRank = new Map(context.recent.map((path, index) => [path, index]));
  const scored: Array<{ path: string; pinned: number; tier: number; recent: number }> = [];
  for (const path of paths) {
    const tier = quickOpenMatchTier(query, path);
    if (tier === null) continue;
    scored.push({
      path,
      pinned: pinned.has(path) ? 0 : 1,
      tier,
      recent: recentRank.get(path) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  scored.sort(
    (a, b) =>
      a.pinned - b.pinned ||
      a.tier - b.tier ||
      a.recent - b.recent ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return scored.map((s) => s.path);
}
