import { describe, expect, it } from "vitest";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { indexFileListing } from "./file-listing-index";

describe("indexFileListing", () => {
  it("derives every listing index in one ordered pass", () => {
    const files: WorkspaceFileEntry[] = [
      { path: "docs/Guide.MD", kind: "file" },
      { path: "cache.markdown", kind: "database" },
      ...Array.from({ length: 6 }, (_, index) => ({
        path: `conflict-${index + 1}.conflict`,
        kind: "file" as const,
      })),
      { path: "plain.txt", kind: "file" },
    ];

    const indexed = indexFileListing(files);

    expect(indexed.markdownWikilinkFiles).toEqual([
      { path: "docs/Guide.MD", title: "Guide", fileId: null },
    ]);
    expect(indexed.conflictSummaries).toEqual(
      Array.from(
        { length: 5 },
        (_, index) =>
          `conflict-${index + 1} has a sync conflict (conflict-${index + 1}.conflict)`,
      ),
    );
    expect(indexed.presentPaths).toEqual(new Set(files.map((file) => file.path)));
    expect(indexed.hasMarkdownPath).toBe(true);
    expect(indexed.graphRefreshKey).toBe(
      [String(files.length), ...files.map((file) => file.path)].join("\0"),
    );
  });

  it("keeps the graph key content-based for distinct equivalent listings", () => {
    const files: WorkspaceFileEntry[] = [
      { path: "a.md", kind: "file" },
      { path: "b.md", kind: "file" },
    ];

    const first = indexFileListing(files).graphRefreshKey;
    const equivalent = indexFileListing(files.map((file) => ({ ...file })))
      .graphRefreshKey;
    const reordered = indexFileListing([...files].reverse()).graphRefreshKey;

    expect(first).toBe(equivalent);
    expect(first).not.toBe(reordered);
    expect(indexFileListing([]).graphRefreshKey).toBe("0\0");
  });
});
