import { describe, expect, it } from "vitest";
import {
  addBoundaryCrossing,
  addFileChanges,
  createChangeSet,
  createLocalChangeAuthor,
  parseChangeAuthor,
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

describe("change authors", () => {
  it("normalizes local author labels and rejects empty labels", () => {
    expect(createLocalChangeAuthor(" Local file edit ")).toEqual({
      kind: "local",
      label: "Local file edit",
    });
    expect(() => createLocalChangeAuthor("  ")).toThrow(/non-empty/i);
  });

  it("parses persisted author values through the same runtime contract", () => {
    expect(parseChangeAuthor({ kind: "user", userId: "user-1" })).toEqual({
      kind: "user",
      userId: "user-1",
    });
    expect(
      parseChangeAuthor({
        kind: "agent",
        agentId: "codex-local",
        onBehalfOf: "user-1",
      }),
    ).toEqual({
      kind: "agent",
      agentId: "codex-local",
      onBehalfOf: "user-1",
    });
    expect(parseChangeAuthor({ kind: "local", label: " Local file edit " })).toEqual({
      kind: "local",
      label: "Local file edit",
    });
    expect(() => parseChangeAuthor({ kind: "local", label: "  " })).toThrow(/non-empty/i);
    expect(() => parseChangeAuthor({ kind: "user", userId: " user-1 " })).toThrow(/canonical/i);
    expect(() =>
      parseChangeAuthor({
        kind: "agent",
        agentId: " codex-local ",
        onBehalfOf: "user-1",
      }),
    ).toThrow(/canonical/i);
    expect(() => parseChangeAuthor({ kind: "agent", agentId: "codex-local" })).toThrow(
      /on-behalf-of/i,
    );
  });

  it("validates change set authors before storing them", () => {
    expect(() =>
      createChangeSet({
        kind: "user-edit",
        author: { kind: "user", userId: " user-1 " },
        summary: "Edited notes",
      }),
    ).toThrow(/canonical/i);
    expect(() =>
      createChangeSet({
        kind: "agent-run",
        author: { kind: "agent", agentId: "codex-local", onBehalfOf: " user-1 " },
        summary: "Agent edit",
      }),
    ).toThrow(/canonical/i);
    expect(
      createChangeSet({
        kind: "user-edit",
        author: { kind: "local", label: " Local file edit " } as never,
        summary: "External edit",
      }).author,
    ).toEqual({ kind: "local", label: "Local file edit" });
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
    const redoSet = createChangeSet({
      kind: "history-restore",
      author: { kind: "user", userId: "user-1" },
      summary: "Redid a restore",
      provenance: {
        source: "history-restore",
        restoreOfChangeSetId: "change-1",
        restoreDirection: "redo",
      },
    });
    expect(redoSet.provenance).toMatchObject({
      source: "history-restore",
      restoreOfChangeSetId: "change-1",
      restoreDirection: "redo",
    });
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
