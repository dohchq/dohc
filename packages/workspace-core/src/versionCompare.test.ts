import { describe, expect, it } from "vitest";
import type { TextFileSnapshot } from "@dohc/workspace-contracts/engine";
import {
  COMPARE_PAGE_TEXT_BYTE_BUDGET,
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

function storeOf(
  files: FakeFile[],
  options?: { deltaNextAfterPath?: string | null },
) {
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
      return { entries, nextAfterPath: options?.deltaNextAfterPath ?? null };
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

  it("carries the delta listing's own continuation when the budget is not hit", async () => {
    const store = storeOf(
      [{ path: "a.md", status: "modified", current: "1", incoming: "2" }],
      { deltaNextAfterPath: "a.md" },
    );
    const page = await compareVersionFilesPage(store, INPUT);
    expect(page.nextAfterPath).toBe("a.md");
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

  it("fits a representative healthy comparison in one page (measured)", async () => {
    // Measured evidence for COMPARE_PAGE_TEXT_BYTE_BUDGET (AGENTS.md:
    // "Measure limits that reject work"): the budget never rejects — it
    // pages — but the healthy case should not page at all. A working
    // feature-branch comparison of 40 markdown files, both sides ~2.5 KiB
    // (the shape of this repo's own docs), hydrates ~200 KiB: inside the
    // 256 KiB budget, one page, no "Show more".
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
