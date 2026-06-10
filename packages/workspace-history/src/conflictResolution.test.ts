import { describe, expect, it } from "vitest";
import {
  catchUpSummary,
  describeConflict,
  mergeMarkdown,
  resolveConflict,
  storeProposal,
  type FileConflict,
} from "./conflictResolution";
import type { HistoryRecord } from "./changeSetStore";

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

describe("catch-up summary (returning to a shared workspace)", () => {
  it("summarizes change sets since the user last looked, newest first, with attribution", () => {
    const records: HistoryRecord[] = [
      {
        id: "a",
        recordedAtMs: 100,
        kind: "user-edit",
        author: { kind: "user", userId: "maya" },
        summary: "Edited 2 files",
        files: [
          { path: "notes/plan.md", operation: "write" },
          { path: "notes/budget.md", operation: "write" },
        ],
        boundaryCrossings: [],
      },
      {
        id: "b",
        recordedAtMs: 200,
        kind: "agent-run",
        author: { kind: "agent", agentId: "codex", onBehalfOf: "maya" },
        summary: "Edited 1 file",
        files: [{ path: "finance/q3.md", operation: "write" }],
        boundaryCrossings: [],
      },
    ];
    const lines = catchUpSummary(records, 50);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/maya's agent/i);
    expect(lines[1]).toMatch(/maya/i);
    // Plain prose, no markers or jargon.
    for (const line of lines) expect(line).not.toMatch(/<<<<<<<|commit|sha/i);
  });

  it("is empty when nothing happened since", () => {
    expect(catchUpSummary([], 0)).toEqual([]);
  });
});
