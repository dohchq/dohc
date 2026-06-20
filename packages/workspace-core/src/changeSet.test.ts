import { describe, expect, it } from "vitest";
import {
  addBoundaryCrossing,
  addFileChanges,
  createChangeSet,
  requiresReview,
  type BoundaryCrossing,
} from "./changeSet";
import { describeConflict } from "./conflicts";

const agentAuthor = {
  kind: "agent" as const,
  agentId: "codex-local",
  onBehalfOf: "user-1",
};

describe("change set grouping", () => {
  it("groups one agent run editing many files into a single change set", () => {
    const set = createChangeSet({
      kind: "agent-run",
      author: agentAuthor,
      summary: "Imported transactions and built ledger site",
    });
    const files = Array.from({ length: 18 }, (_, i) => ({
      path: `finance/sites/ledger/src/file-${i}.tsx`,
      operation: "write" as const,
    }));
    const grouped = addFileChanges(set, files);
    expect(grouped.files).toHaveLength(18);
    expect(grouped.kind).toBe("agent-run");
    expect(grouped.author).toEqual(agentAuthor);
  });
});

describe("review requirements", () => {
  it("does not require approval for normal allowed edits", () => {
    const set = addFileChanges(
      createChangeSet({
        kind: "user-edit",
        author: { kind: "user", userId: "user-1" },
        summary: "Edited notes",
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );
    expect(requiresReview(set)).toBe(false);
  });

  const crossings: BoundaryCrossing[] = [
    "public-share",
    "external-export",
    "permission-change",
    "bulk-delete",
    "site-publish",
    "private-to-shared",
    "unmergeable-overwrite",
  ];

  for (const crossing of crossings) {
    it(`requires review for boundary crossing: ${crossing}`, () => {
      const set = addBoundaryCrossing(
        createChangeSet({
          kind: "agent-run",
          author: agentAuthor,
          summary: "Crossed a boundary",
        }),
        crossing,
      );
      expect(requiresReview(set)).toBe(true);
      expect(set.boundaryCrossings).toContain(crossing);
    });
  }
});

describe("change provenance", () => {
  it("accepts provenance whose source matches the change set kind", () => {
    expect(() =>
      createChangeSet({
        kind: "history-restore",
        author: { kind: "user", userId: "user-1" },
        summary: "Restored a file",
        provenance: { source: "history-restore", restoreOfChangeSetId: "change-1" },
      }),
    ).not.toThrow();
  });

  it("rejects provenance whose source does not match the change set kind", () => {
    expect(() =>
      createChangeSet({
        kind: "history-restore",
        author: { kind: "user", userId: "user-1" },
        summary: "Restored a file",
        provenance: { source: "agent-run", agentRunId: "run-1" },
      }),
    ).toThrow(/does not match/);
  });
});

describe("conflict summaries", () => {
  it("produces a human-readable summary without Git conflict markers", () => {
    const summary = describeConflict({
      path: "notes/plan.md",
      localDescription: "you reworded the intro",
      remoteDescription: "Maya added a budget section",
    });
    expect(summary).toContain("notes/plan.md");
    expect(summary).toContain("you reworded the intro");
    expect(summary).toContain("Maya added a budget section");
    expect(summary).not.toMatch(/<{7}|>{7}|={7}/);
  });
});
