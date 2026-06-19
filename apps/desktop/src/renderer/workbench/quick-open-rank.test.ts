import { describe, expect, it } from "vitest";
import { quickOpenMatchTier, rankQuickOpenPaths } from "./quick-open-rank";

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
