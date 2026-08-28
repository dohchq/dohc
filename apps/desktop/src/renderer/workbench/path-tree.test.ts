import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTree, type FileRow } from "./path-tree";

// Ported + slimmed with path-tree.ts: the sort rule is folders before
// leaves, then alphabetical (locale-aware). Empty folders STILL sort as
// folders (file === null decides, never children.length).

function row(path: string): FileRow {
  return { path, kind: "file" };
}

function generatedListing(seed: number): {
  files: FileRow[];
  folders: string[];
} {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const segments = [
    "alpha",
    "Beta",
    "docs",
    "team",
    "zeta",
    "readme.md",
    "notes.markdown",
    "x.conflict",
    "",
  ];
  const path = () => {
    const depth = 1 + (next() % 4);
    const generated = Array.from(
      { length: depth },
      () => segments[next() % segments.length]!,
    ).join("/");
    return generated || "empty";
  };

  const files: FileRow[] = [];
  const fileCount = 4 + (next() % 24);
  for (let index = 0; index < fileCount; index += 1) {
    const filePath =
      files.length > 0 && next() % 5 === 0
        ? files[next() % files.length]!.path
        : path();
    files.push({
      path: filePath,
      kind: next() % 4 === 0 ? "database" : "file",
      ...(next() % 3 === 0 ? { icon: `icon-${next() % 7}` } : {}),
    });
  }

  const folders: string[] = [];
  const folderCount = 2 + (next() % 16);
  for (let index = 0; index < folderCount; index += 1) {
    folders.push(
      folders.length > 0 && next() % 5 === 0
        ? folders[next() % folders.length]!
        : path(),
    );
  }
  return { files, folders };
}

describe("buildTree — sort order (folders → alphabetical)", () => {
  it("folders sort BEFORE leaves at every level", () => {
    const tree = buildTree([row("zeta.md"), row("alpha/inner.md")], ["alpha"]);
    expect(tree.children.map((c) => c.segment)).toEqual(["alpha", "zeta.md"]);
  });

  it("an EMPTY listed folder still sorts BEFORE a leaf at the same level", () => {
    const tree = buildTree([row("zeta.md")], ["alpha"]);
    expect(tree.children.map((c) => c.segment)).toEqual(["alpha", "zeta.md"]);
    const alpha = tree.children[0]!;
    expect(alpha.file).toBeNull();
    expect(alpha.children).toEqual([]);
  });

  it("nests files at their full path and keeps fullPath unique per node", () => {
    const tree = buildTree([
      row("team/anna.md"),
      row("team/ben.md"),
      row("readme.md"),
    ]);
    expect(tree.children.map((c) => c.fullPath)).toEqual(["team", "readme.md"]);
    const team = tree.children[0]!;
    expect(team.file).toBeNull();
    expect(team.children.map((c) => c.fullPath)).toEqual([
      "team/anna.md",
      "team/ben.md",
    ]);
    expect(team.children[0]!.file).toEqual({ path: "team/anna.md", kind: "file" });
  });

  it("a folder implied by a nested file and an explicit folder merge into one node", () => {
    const tree = buildTree([row("docs/a.md")], ["docs"]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.children.map((c) => c.segment)).toEqual(["a.md"]);
  });

  it("carries the file row (kind included) onto leaf nodes", () => {
    const tree = buildTree([{ path: "wallet.sqlite", kind: "database" }]);
    expect(tree.children[0]!.file?.kind).toBe("database");
  });

  it("sorts alphabetically within each tier", () => {
    const tree = buildTree(
      [row("b.md"), row("a.md")],
      ["zfolder", "afolder"],
    );
    expect(tree.children.map((c) => c.segment)).toEqual([
      "afolder",
      "zfolder",
      "a.md",
      "b.md",
    ]);
  });
});

describe("buildTree generated compatibility", () => {
  it("matches the legacy builder byte-for-byte across generated listings", () => {
    const digest = createHash("sha256");
    for (let seed = 1; seed <= 256; seed += 1) {
      const { files, folders } = generatedListing(seed);
      digest.update(JSON.stringify(buildTree(files, folders)));
      digest.update("\n");
    }

    expect(digest.digest("hex")).toBe(
      "9b6f1f296d782d16cceb5b42b33942f5a1cdd6d0d49685e81bfdad98183c001c",
    );
  });
});
