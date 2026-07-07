import { describe, expect, it } from "vitest";
import { mergeMarkdown } from "./mergeMarkdown";

const BASE = "# Plan\n\nIntro paragraph.\n\n## Costs\n\nOld numbers.\n";

describe("mergeMarkdown (safe auto-merge)", () => {
  it("merges edits that touch different parts of the document", () => {
    const local = BASE.replace("Intro paragraph.", "Intro paragraph, expanded locally.");
    const remote = BASE.replace("Old numbers.", "New numbers from Maya.");
    const result = mergeMarkdown({ base: BASE, local, remote });
    expect(result.kind).toBe("merged");
    if (result.kind === "merged") {
      expect(result.content).toContain("expanded locally");
      expect(result.content).toContain("New numbers from Maya");
    }
  });

  it("returns the other side unchanged when only one side edited", () => {
    const remote = BASE.replace("Old numbers.", "Fresh numbers.");
    const sameLocal = mergeMarkdown({ base: BASE, local: BASE, remote });
    expect(sameLocal).toEqual({ kind: "merged", content: remote });
    const sameRemote = mergeMarkdown({ base: BASE, local: remote, remote: BASE });
    expect(sameRemote).toEqual({ kind: "merged", content: remote });
  });

  it("declares a conflict when both sides change the same line — never inventing content", () => {
    const local = BASE.replace("Old numbers.", "LOCAL numbers.");
    const remote = BASE.replace("Old numbers.", "REMOTE numbers.");
    const result = mergeMarkdown({ base: BASE, local, remote });
    expect(result.kind).toBe("conflict");
  });

  it("never inserts Git conflict markers in an automatic merge", () => {
    const local = BASE.replace("Intro paragraph.", "LOCAL intro.");
    const remote = BASE.replace("Old numbers.", "REMOTE numbers.");
    const merged = mergeMarkdown({ base: BASE, local, remote });
    expect(merged.kind).toBe("merged");
    if (merged.kind === "merged") {
      expect(merged.content).not.toMatch(/<<<<<<<|>>>>>>>|=======/);
    }
  });

  it("declares same-offset insertions a conflict instead of inventing an order", () => {
    const local = BASE.replace("## Costs", "LOCAL insert\n## Costs");
    const remote = BASE.replace("## Costs", "REMOTE insert\n## Costs");
    expect(mergeMarkdown({ base: BASE, local, remote })).toEqual({ kind: "conflict" });
  });

  it("conflicts when a local replacement shares a base offset with a remote insertion", () => {
    // Local REPLACES B at base offset 1; remote INSERTS a new line at the same
    // offset 1. Applying both blindly lets the stable sort reset the cursor
    // backwards and reintroduce the stale base line B — data loss. Must conflict.
    const result = mergeMarkdown({
      base: "A\nB\nC",
      local: "A\nLOCAL B\nC",
      remote: "A\nREMOTE INSERT\nB\nC",
    });
    expect(result).toEqual({ kind: "conflict" });
  });

  it("conflicts symmetrically when the insertion is local and the replacement remote", () => {
    const result = mergeMarkdown({
      base: "A\nB\nC",
      local: "A\nLOCAL INSERT\nB\nC",
      remote: "A\nREMOTE B\nC",
    });
    expect(result).toEqual({ kind: "conflict" });
  });
});
