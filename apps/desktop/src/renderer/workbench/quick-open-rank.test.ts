import { describe, expect, it } from "vitest";
import {
  prepareQuickOpenPaths,
  quickOpenMatchTier,
  rankPreparedQuickOpenPaths,
  rankQuickOpenPaths,
  type QuickOpenContext,
} from "./quick-open-rank";

const noContext = { recent: [], pinned: [] };

describe("quickOpenMatchTier", () => {
  it("orders the tiers: basename prefix < word boundary < substring < fuzzy", () => {
    const prefix = quickOpenMatchTier("note", "docs/notes.md")!;
    const boundary = quickOpenMatchTier("note", "docs/meeting-notes.md")!;
    const substring = quickOpenMatchTier("note", "docs/keynotes.md")!;
    const fuzzy = quickOpenMatchTier("nte", "docs/notes.md")!;
    expect(prefix).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(substring);
    expect(substring).toBeLessThan(fuzzy);
  });

  it("matches case-insensitively and treats /-_. and space as word boundaries", () => {
    expect(quickOpenMatchTier("NOTE", "docs/Notes.md")).toBe(
      quickOpenMatchTier("note", "docs/notes.md"),
    );
    for (const path of ["a/x-note.md", "a/x_note.md", "a/x.note.md", "a/x note.md", "a/note/y.md"]) {
      expect(quickOpenMatchTier("note", path), path).toBe(1);
    }
  });

  it("returns null for a non-match (not even a subsequence)", () => {
    expect(quickOpenMatchTier("zzz", "docs/notes.md")).toBeNull();
  });
});

describe("rankQuickOpenPaths", () => {
  it("ranks prefix over word-boundary over substring over fuzzy", () => {
    const ranked = rankQuickOpenPaths(
      "note",
      ["docs/keynotes.md", "docs/meeting-notes.md", "docs/notes.md", "nat/omega-thing-e.md"],
      noContext,
    );
    expect(ranked).toEqual([
      "docs/notes.md",
      "docs/meeting-notes.md",
      "docs/keynotes.md",
      "nat/omega-thing-e.md",
    ]);
  });

  it("puts pinned paths first regardless of tier", () => {
    const ranked = rankQuickOpenPaths("note", ["notes.md", "old/keynotes.md"], {
      recent: [],
      pinned: ["old/keynotes.md"],
    });
    expect(ranked[0]).toBe("old/keynotes.md");
  });

  it("boosts recent files within a tier, most recent first", () => {
    const paths = ["a/note-c.md", "a/note-b.md", "a/note-a.md"];
    const ranked = rankQuickOpenPaths("note", paths, {
      recent: ["a/note-b.md", "a/note-c.md"],
      pinned: [],
    });
    expect(ranked).toEqual(["a/note-b.md", "a/note-c.md", "a/note-a.md"]);
  });

  it("recency never beats a better tier", () => {
    const ranked = rankQuickOpenPaths("note", ["notes.md", "docs/keynotes.md"], {
      recent: ["docs/keynotes.md"],
      pinned: [],
    });
    expect(ranked).toEqual(["notes.md", "docs/keynotes.md"]);
  });

  it("ties break by shorter path then alphabetical; non-matches drop", () => {
    // Both notes.md basenames are tier 0 (basename prefix) — shorter path
    // first; the boundary matches (a-/b-notes.md) follow alphabetically.
    const ranked = rankQuickOpenPaths(
      "note",
      ["deep/dir/notes.md", "notes.md", "b-notes.md", "a-notes.md", "zzz.md"],
      noContext,
    );
    expect(ranked).toEqual(["notes.md", "deep/dir/notes.md", "a-notes.md", "b-notes.md"]);
  });

  it("empty query keeps everything (pinned, then recent, then the rest)", () => {
    const ranked = rankQuickOpenPaths("", ["c.md", "b.md", "a.md"], {
      recent: ["b.md"],
      pinned: ["c.md"],
    });
    expect(ranked).toEqual(["c.md", "b.md", "a.md"]);
  });
});

function legacyBasenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function legacyStartsAtWordBoundary(haystack: string, needle: string): boolean {
  if (haystack.startsWith(needle)) return true;
  for (let index = 1; index <= haystack.length - needle.length; index += 1) {
    if (!/[/\-_. ]/.test(haystack[index - 1])) continue;
    if (haystack.startsWith(needle, index)) return true;
  }
  return false;
}

function legacyIsSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const character of haystack) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

function legacyQuickOpenMatchTier(query: string, path: string): number | null {
  const lowercaseQuery = query.toLowerCase();
  if (lowercaseQuery.length === 0) return 2;
  const lowercasePath = path.toLowerCase();
  if (legacyBasenameOf(lowercasePath).startsWith(lowercaseQuery)) return 0;
  if (legacyStartsAtWordBoundary(lowercasePath, lowercaseQuery)) return 1;
  if (lowercasePath.includes(lowercaseQuery)) return 2;
  if (legacyIsSubsequence(lowercaseQuery, lowercasePath)) return 3;
  return null;
}

function legacyRankQuickOpenPaths(
  query: string,
  paths: readonly string[],
  context: QuickOpenContext,
): string[] {
  const pinned = new Set(context.pinned);
  const recentRank = new Map(context.recent.map((path, index) => [path, index]));
  const scored: Array<{ path: string; pinned: number; tier: number; recent: number }> = [];
  for (const path of paths) {
    const tier = legacyQuickOpenMatchTier(query, path);
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
  return scored.map((score) => score.path);
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomItem<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function generatedPath(random: () => number, index: number): string {
  const words = ["alpha", "Beta", "notes", "meeting", "Report", "delta", "xray"];
  const separators = ["-", "_", ".", " "];
  const directories = Array.from({ length: Math.floor(random() * 4) }, () =>
    randomItem(random, words),
  );
  const basename = `${randomItem(random, words)}${randomItem(random, separators)}${randomItem(
    random,
    words,
  )}-${index}.${randomItem(random, ["md", "txt", "json"])}`;
  return [...directories, basename].join("/");
}

describe("incremental quick-open ranking", () => {
  it("matches the legacy full sort across generated workspaces and queries", () => {
    const random = seededRandom(0x51a7c0de);
    for (let workspaceIndex = 0; workspaceIndex < 200; workspaceIndex += 1) {
      const paths: string[] = [];
      const fileCount = Math.floor(random() * 121);
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
        const duplicate = paths.length > 0 && random() < 0.1;
        paths.push(
          duplicate
            ? randomItem(random, paths)
            : generatedPath(random, workspaceIndex * 1_000 + fileIndex),
        );
      }

      const historyEntry = () =>
        paths.length > 0 && random() < 0.9
          ? randomItem(random, paths)
          : generatedPath(random, workspaceIndex + 1_000_000);
      const context = {
        pinned: Array.from({ length: Math.floor(random() * 12) }, historyEntry),
        recent: Array.from({ length: Math.floor(random() * 24) }, historyEntry),
      };
      const sample = paths.length > 0 ? randomItem(random, paths) : "notes.md";
      const lowercaseSample = sample.toLowerCase();
      const queries = [
        "",
        randomItem(random, ["note", "REPORT", "beta", "x_r", "a p"]),
        lowercaseSample.slice(0, Math.min(5, lowercaseSample.length)),
        [...lowercaseSample].filter((_, index) => index % 3 === 0).slice(0, 5).join(""),
        `missing-${workspaceIndex}`,
      ];
      const prepared = prepareQuickOpenPaths(paths, context);

      for (const query of queries) {
        const message = `workspace ${workspaceIndex}, query ${JSON.stringify(query)}`;
        const legacy = legacyRankQuickOpenPaths(query, paths, context);
        expect(rankQuickOpenPaths(query, paths, context), message).toEqual(legacy);
        expect(rankPreparedQuickOpenPaths(query, prepared, 50), message).toEqual(
          legacy.slice(0, 50),
        );
      }
    }
  });
});
