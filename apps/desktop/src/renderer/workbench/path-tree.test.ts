import { describe, expect, it } from "vitest";
import { buildTree, type FileRow } from "./path-tree";

// Ported + slimmed with path-tree.ts: the sort rule is folders before
// leaves, then alphabetical (locale-aware). Empty folders STILL sort as
// folders (file === null decides, never children.length).

function row(path: string): FileRow {
  return { path, kind: "file" };
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
