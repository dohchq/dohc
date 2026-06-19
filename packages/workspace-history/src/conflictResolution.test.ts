import { describe, expect, it } from "vitest";
import {
  describeConflict,
  mergeMarkdown,
  resolveConflict,
  storeProposal,
  type FileConflict,
} from "./conflictResolution";

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

  it("never inserts Git conflict markers", () => {
    const local = BASE.replace("Old numbers.", "LOCAL.");
    const remote = BASE.replace("Old numbers.", "REMOTE.");
    const merged = mergeMarkdown({ base: BASE, local, remote });
    if (merged.kind === "merged") {
      expect(merged.content).not.toMatch(/<<<<<<<|>>>>>>>|=======/);
    }
    // And the conflict record path preserves both sides verbatim instead.
  });
});

describe("conflict records (both versions preserved, humans first)", () => {
  const conflict: FileConflict = {
    path: "notes/plan.md",
    localContent: "LOCAL",
    remoteContent: "REMOTE",
    localAuthor: "you",
    remoteAuthor: "Maya",
  };

  it("describes the conflict in plain language", () => {
    const summary = describeConflict(conflict);
    expect(summary).toMatch(/notes\/plan\.md/);
    expect(summary).toMatch(/you/i);
    expect(summary).toMatch(/Maya/);
    expect(summary).not.toMatch(/<<<<<<</);
  });

  it("stores an AI resolution proposal alongside the conflict", () => {
    const withProposal = storeProposal(conflict, {
      content: "MERGED BY AI",
      rationale: "Combined both edits; numbers from Maya, intro from you.",
    });
    expect(withProposal.proposal?.content).toBe("MERGED BY AI");
    expect(withProposal.proposal?.source).toBe("ai");
    // The original sides are still intact — a proposal never replaces them.
    expect(withProposal.localContent).toBe("LOCAL");
    expect(withProposal.remoteContent).toBe("REMOTE");
  });

  it("supports apply / keep-both / dismiss outcomes", () => {
    const withProposal = storeProposal(conflict, { content: "AI", rationale: "" });
    expect(resolveConflict(withProposal, "apply").resolution).toBe("applied");
    const kept = resolveConflict(conflict, "keep-both");
    expect(kept.resolution).toBe("kept-both");
    expect(resolveConflict(conflict, "dismiss").resolution).toBe("dismissed");
  });
});
