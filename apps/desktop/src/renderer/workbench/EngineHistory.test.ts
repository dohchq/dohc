import { describe, expect, it } from "vitest";
import type { EngineMomentRecord } from "../../ipc/bridgeContract";
import {
  engineMomentSummary,
  engineOriginLabel,
  groupEngineMoments,
} from "./EngineHistory";
import { chatAuthorLabel } from "./LinkedChats";

function moment(overrides: Partial<EngineMomentRecord> & { id: string }): EngineMomentRecord {
  return {
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    momentOrder: 0,
    ...overrides,
  };
}

describe("engineMomentSummary", () => {
  it("prefers the moment's real engine summary", () => {
    expect(
      engineMomentSummary(
        moment({ id: "m1", summary: "Merged version Draft into Main" }),
      ),
    ).toBe("Merged version Draft into Main");
    expect(
      engineMomentSummary(moment({ id: "m2", summary: "Reconciled offline edits" })),
    ).toBe("Reconciled offline edits");
  });

  it("falls back to calm product copy from the operation", () => {
    expect(engineMomentSummary(moment({ id: "m1" }))).toBe("Edited plan.md");
    expect(
      engineMomentSummary(moment({ id: "m2", operation: "delete" })),
    ).toBe("Deleted plan.md");
  });
});

describe("engineOriginLabel", () => {
  it("maps every origin to a product label", () => {
    expect(engineOriginLabel("local-file")).toBe("Local file edit");
    expect(engineOriginLabel("restore")).toBe("Restore");
    expect(engineOriginLabel("sync")).toBe("Sync");
    expect(engineOriginLabel("api")).toBe("dohc");
    expect(engineOriginLabel("unknown")).toBe("Unknown source");
  });
});

describe("groupEngineMoments", () => {
  it("groups consecutive moments sharing a correlationId into one entry", () => {
    const groups = groupEngineMoments([
      moment({
        id: "m3",
        path: "b.md",
        momentOrder: 3,
        summary: "Reconciled offline edits",
        correlationId: "reconcile-1",
      }),
      moment({
        id: "m2",
        path: "a.md",
        momentOrder: 2,
        summary: "Reconciled offline edits",
        correlationId: "reconcile-1",
      }),
      moment({ id: "m1", momentOrder: 1 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].summary).toBe("Reconciled offline edits");
    expect(groups[0].moments.map((entry) => entry.path)).toEqual(["b.md", "a.md"]);
    expect(groups[1].moments.map((entry) => entry.id)).toEqual(["m1"]);
  });

  it("keeps NON-consecutive repeats of a correlationId apart and singletons single", () => {
    const groups = groupEngineMoments([
      moment({ id: "m4", momentOrder: 4, correlationId: "merge-1", summary: "Merged version X into Main" }),
      moment({ id: "m3", momentOrder: 3 }),
      moment({ id: "m2", momentOrder: 2, correlationId: "merge-1", summary: "Merged version X into Main" }),
      moment({ id: "m1", momentOrder: 1 }),
    ]);
    expect(groups.map((group) => group.moments.length)).toEqual([1, 1, 1, 1]);
  });

  it("never merges uncorrelated neighbours", () => {
    const groups = groupEngineMoments([
      moment({ id: "m2", momentOrder: 2 }),
      moment({ id: "m1", momentOrder: 1 }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("chatAuthorLabel", () => {
  it("shows human authors by their display name", () => {
    expect(
      chatAuthorLabel({ authorKind: "human", authorDisplayName: "You" }),
    ).toBe("You");
    expect(
      chatAuthorLabel({
        authorKind: "human",
        authorDisplayName: "iestyndevera@gmail.com",
      }),
    ).toBe("iestyndevera@gmail.com");
  });

  it("shows agent-authored messages as \"<User Name>'s agent\"", () => {
    expect(
      chatAuthorLabel({ authorKind: "agent", authorDisplayName: "Ice de Vera" }),
    ).toBe("Ice de Vera's agent");
  });
});
