import { describe, expect, it } from "vitest";
import type { TextFileSnapshot } from "@dohc/workspace-contracts/engine";
import {
  COMPARE_PAGE_TEXT_BYTE_BUDGET,
  compareEnginePaths,
  compareVersionFilesPage,
} from "./versionCompare";

// The paged whole-version comparison (#562). The store here is the two seams
// the pager reads: the differing-path listing, and per-path side reads.

interface FakeFile {
  path: string;
  status: "added" | "modified" | "deleted";
  binary?: boolean;
  current?: string;
  incoming?: string;
}

function storeOf(files: FakeFile[]) {
  const reads: Array<{ versionId: string; path: string }> = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const snapshot = (path: string, text: string): TextFileSnapshot => ({
    objectId: `object-${path}`,
    versionId: "irrelevant",
    path,
    text,
    updatedAtMs: 1,
    latestMomentId: `moment-${path}`,
    metadata: { origin: "local-file" },
  });
  return {
    reads,
    compareVersionFilesPage: async (input: { afterPath?: string }) => {
      const entries = files
        .filter(
          (file) =>
            input.afterPath === undefined || file.path > input.afterPath,
        )
        .map((file) => ({
          path: file.path,
          status: file.status,
          ...(file.binary ? { binary: true as const } : {}),
        }));
      return { entries, nextAfterPath: null };
    },
    readTextFile: async (input: { versionId: string; path: string }) => {
      reads.push({ versionId: input.versionId, path: input.path });
      const file = byPath.get(input.path);
      if (!file) return null;
      const text = input.versionId === "main" ? file.current : file.incoming;
      return text === undefined ? null : snapshot(input.path, text);
    },
  };
}

const INPUT = {
  workspaceId: "ws",
  sourceVersionId: "version-1",
  targetVersionId: "main",
} as const;

describe("compareVersionFilesPage", () => {
  it("hydrates the sides each status has, and none it does not", async () => {
    const store = storeOf([
      { path: "a.md", status: "added", incoming: "new\n" },
      { path: "b.md", status: "deleted", current: "old\n" },
      { path: "c.md", status: "modified", current: "left\n", incoming: "right\n" },
      { path: "d.png", status: "modified", binary: true },
    ]);
    const page = await compareVersionFilesPage(store, INPUT);
    expect(page).toEqual({
      files: [
        { path: "a.md", status: "added", incomingText: "new\n" },
        { path: "b.md", status: "deleted", currentText: "old\n" },
        { path: "c.md", status: "modified", currentText: "left\n", incomingText: "right\n" },
        { path: "d.png", status: "modified", binary: true },
      ],
      nextAfterPath: null,
    });
    // An added path never reads the target side, a deleted path never reads
    // the source side, and a binary row reads nothing.
    expect(store.reads).toEqual([
      { versionId: "version-1", path: "a.md" },
      { versionId: "main", path: "b.md" },
      { versionId: "main", path: "c.md" },
      { versionId: "version-1", path: "c.md" },
    ]);
  });

  it("cuts the page after the row that crosses the byte budget", async () => {
    // Three rows of 40 KiB against a 100 KiB budget: the second row crosses
    // 100 KiB at 160 KiB hydrated, so the third row moves to the next page.
    const side = "x".repeat(40 * 1024);
    const store = storeOf([
      { path: "a.md", status: "modified", current: side, incoming: side },
      { path: "b.md", status: "modified", current: side, incoming: side },
      { path: "c.md", status: "modified", current: side, incoming: side },
    ]);
    const page = await compareVersionFilesPage(store, {
      ...INPUT,
      byteBudget: 100 * 1024,
    });
    expect(page.files.map((file) => file.path)).toEqual(["a.md", "b.md"]);
    expect(page.nextAfterPath).toBe("b.md");
    // The cut also stops HYDRATION: c.md's sides are never read.
    expect(
      store.reads.filter((read) => read.path === "c.md"),
    ).toHaveLength(0);

    // The continuation reaches the rest, without loss or duplication.
    const rest = await compareVersionFilesPage(store, {
      ...INPUT,
      byteBudget: 100 * 1024,
      afterPath: page.nextAfterPath!,
    });
    expect(rest.files.map((file) => file.path)).toEqual(["c.md"]);
    expect(rest.nextAfterPath).toBeNull();
  });

  it("always ships at least one row, however large (progress, not rejection)", async () => {
    const huge = "y".repeat(COMPARE_PAGE_TEXT_BYTE_BUDGET * 4);
    const store = storeOf([
      { path: "big.md", status: "modified", current: huge, incoming: huge },
      { path: "next.md", status: "modified", current: "small", incoming: "small" },
    ]);
    const page = await compareVersionFilesPage(store, INPUT);
    expect(page.files.map((file) => file.path)).toEqual(["big.md"]);
    expect(page.files[0]!.currentText).toBe(huge);
    expect(page.nextAfterPath).toBe("big.md");
  });

  it("keeps a continuation only when something differs past it", async () => {
    // The listing's cursor is not a promise of more rows: a window that ends
    // exactly on its row limit hands one back regardless. The pager peeks —
    // metadata only — and keeps the cursor only over a real successor. The
    // peeked window is re-fetched by the next page.
    const calls: Array<string | undefined> = [];
    const pages = new Map<string | undefined, {
      entries: Array<{ path: string; status: "modified" }>;
      nextAfterPath: string | null;
    }>([
      [
        undefined,
        { entries: [{ path: "a.md", status: "modified" }], nextAfterPath: "a.md" },
      ],
      [
        "a.md",
        { entries: [{ path: "b.md", status: "modified" }], nextAfterPath: null },
      ],
    ]);
    const store = {
      compareVersionFilesPage: async (input: { afterPath?: string }) => {
        calls.push(input.afterPath);
        return pages.get(input.afterPath)!;
      },
      readTextFile: async (input: { versionId: string; path: string }) =>
        ({
          objectId: `object-${input.path}`,
          versionId: input.versionId,
          path: input.path,
          text: "body",
          updatedAtMs: 1,
          latestMomentId: `moment-${input.path}`,
          metadata: { origin: "local-file" as const },
        }) satisfies TextFileSnapshot,
    };
    const page = await compareVersionFilesPage(store, INPUT);
    expect(page.files.map((file) => file.path)).toEqual(["a.md"]);
    expect(page.nextAfterPath).toBe("a.md");
    // The peek cost one extra metadata call at a true page boundary.
    expect(calls).toEqual([undefined, "a.md"]);

    const rest = await compareVersionFilesPage(store, {
      ...INPUT,
      afterPath: "a.md",
    });
    expect(rest.files.map((file) => file.path)).toEqual(["b.md"]);
    expect(rest.nextAfterPath).toBeNull();
  });

  it("drops a continuation with nothing differing behind it", async () => {
    // An exactly-full window's cursor with only identical paths behind it
    // used to reach the surface, which then said "more than N" over a Show
    // more that appended nothing.
    const pages = new Map<string | undefined, {
      entries: Array<{ path: string; status: "modified" }>;
      nextAfterPath: string | null;
    }>([
      [
        undefined,
        { entries: [{ path: "a.md", status: "modified" }], nextAfterPath: "a.md" },
      ],
      ["a.md", { entries: [], nextAfterPath: "m.md" }],
      ["m.md", { entries: [], nextAfterPath: null }],
    ]);
    const store = {
      compareVersionFilesPage: async (input: { afterPath?: string }) =>
        pages.get(input.afterPath)!,
      readTextFile: async (input: { versionId: string; path: string }) =>
        ({
          objectId: `object-${input.path}`,
          versionId: input.versionId,
          path: input.path,
          text: "body",
          updatedAtMs: 1,
          latestMomentId: `moment-${input.path}`,
          metadata: { origin: "local-file" as const },
        }) satisfies TextFileSnapshot,
    };
    const page = await compareVersionFilesPage(store, INPUT);
    expect(page.files.map((file) => file.path)).toEqual(["a.md"]);
    // MUTATION: drop the lookahead -> "a.md" comes back and the surface
    // claims more files than exist.
    expect(page.nextAfterPath).toBeNull();
  });

  it("counts the budget in UTF-8 bytes, not UTF-16 code units", async () => {
    // 30k CJK characters are 30k code units but 90 KiB of UTF-8. Two sides
    // put the first row at 180 KiB — over a 150 KiB budget — so a code-unit
    // count (60k < 153.6k) would let the second row onto the page.
    const cjk = "漢".repeat(30 * 1024);
    const store = storeOf([
      { path: "a.md", status: "modified", current: cjk, incoming: cjk },
      { path: "b.md", status: "modified", current: "small", incoming: "small" },
    ]);
    const page = await compareVersionFilesPage(store, {
      ...INPUT,
      byteBudget: 150 * 1024,
    });
    expect(page.files.map((file) => file.path)).toEqual(["a.md"]);
    expect(page.nextAfterPath).toBe("a.md");
  });

  it("walks through an all-identical window instead of returning an empty page", async () => {
    // The listing may answer a window in which nothing differed: empty
    // entries WITH a continuation. An empty page with a continuation would
    // read as "no differences" on the surface and hide everything past it.
    const calls: Array<string | undefined> = [];
    const store = {
      compareVersionFilesPage: async (input: { afterPath?: string }) => {
        calls.push(input.afterPath);
        return input.afterPath === undefined
          ? { entries: [], nextAfterPath: "m.md" }
          : {
              entries: [{ path: "z.md", status: "modified" as const }],
              nextAfterPath: null,
            };
      },
      readTextFile: async (input: { versionId: string; path: string }) =>
        ({
          objectId: "object-z",
          versionId: input.versionId,
          path: input.path,
          text: input.versionId === "main" ? "left" : "right",
          updatedAtMs: 1,
          latestMomentId: "moment-z",
          metadata: { origin: "local-file" as const },
        }) satisfies TextFileSnapshot,
    };
    const page = await compareVersionFilesPage(store, INPUT);
    // MUTATION: return the empty first window -> files [] with a
    // continuation, and z.md is unreachable from the surface.
    expect(page.files.map((file) => file.path)).toEqual(["z.md"]);
    expect(page.nextAfterPath).toBeNull();
    expect(calls).toEqual([undefined, "m.md"]);
  });

  it("fits a representative healthy comparison in one page", async () => {
    // The budget never rejects — it pages — so AGENTS.md's measure-first
    // rule does not bind it. What this pins is the healthy SHAPE: a working
    // comparison of 40 markdown files, both sides ~2.5 KiB (the shape of
    // this repo's own docs), hydrates ~200 KiB — inside the 256 KiB budget,
    // one page, no "Show more". Shrinking the budget under the ordinary case
    // fails here first.
    const side = "m".repeat(2_560);
    const files: FakeFile[] = Array.from({ length: 40 }, (_, index) => ({
      path: `docs/note-${String(index).padStart(2, "0")}.md`,
      status: "modified" as const,
      current: side,
      incoming: `${side}!`,
    }));
    const hydratedBytes = files.length * (side.length * 2 + 1);
    expect(hydratedBytes).toBeLessThan(COMPARE_PAGE_TEXT_BYTE_BUDGET);
    const page = await compareVersionFilesPage(storeOf(files), INPUT);
    expect(page.files).toHaveLength(40);
    expect(page.nextAfterPath).toBeNull();
  });
});

describe("compareEnginePaths", () => {
  it("orders paths the way the engine does: code points, not UTF-16 units", () => {
    // U+E000 is one UTF-16 unit (0xE000); U+10000 is a surrogate pair
    // starting 0xD800. UTF-16 comparison puts the pair FIRST; the engine
    // (SQLite BINARY = UTF-8 bytes = code points) puts it LAST. A cursor
    // comparison made the UTF-16 way drops or duplicates the row at a page
    // boundary.
    const bmp = ".env";
    const astral = "\u{10000}.env";
    expect(astral < bmp).toBe(true); // the UTF-16 lie this exists to avoid
    expect(compareEnginePaths(bmp, astral)).toBeLessThan(0);
    expect(compareEnginePaths(astral, bmp)).toBeGreaterThan(0);
    expect(compareEnginePaths("a.md", "a.md")).toBe(0);
    expect(compareEnginePaths("a", "a.md")).toBeLessThan(0);
  });
});
