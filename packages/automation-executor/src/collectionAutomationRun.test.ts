import { describe, expect, it } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { StoredRun } from "./automationRunStore";
import { newRun, rebaseRun } from "./collectionAutomationRun";

const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: bump\n    name: Bump\n    when: record-added\n    do: [{set: {Done: true}}]\n");
if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("Bump should read.");
const automation = parsed.entries[0].automation;

function savedRun(): StoredRun {
  return {
    ...newRun({ automationId: "collection:object-tasks#bump", claimId: "atc_1" }, automation, "hash-1", [
      { ordinal: 0, effects: [{ kind: "set", target: { recordId: "rec_a", collectionPath: "Tasks", path: "Tasks/a.md" }, fields: [] }] },
      { ordinal: 1, effects: [{ kind: "add", collectionPath: "Log", recordId: "rec_b", name: "b", fields: [] }] },
    ], 1),
    collections: [{ collectionId: "object-tasks", path: "Tasks" }, { collectionId: "object-log", path: "Log" }],
    applied: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "Count", before: 1, after: 2 }] }],
    created: [{ ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" }],
  };
}

describe("a saved run's Collections", () => {
  it("move with their ids: the plan, what landed, and the records it added", () => {
    const run = savedRun();
    const where = new Map([["object-tasks", "Trip/Tasks"], ["object-log", "Log"]]);
    expect(rebaseRun(run, (id) => where.get(id) ?? null)).toEqual({ moved: true, lost: false });
    expect(run.collections).toEqual([{ collectionId: "object-tasks", path: "Trip/Tasks" }, { collectionId: "object-log", path: "Log" }]);
    expect(run.plan?.[0]?.effects[0]).toMatchObject({ target: { collectionPath: "Trip/Tasks", path: "Trip/Tasks/a.md" } });
    expect(run.plan?.[1]?.effects[0]).toMatchObject({ collectionPath: "Log" });
    expect(run.applied[0]?.writes[0]).toMatchObject({ path: "Trip/Tasks/a.md" });
    expect(run.created[0]).toMatchObject({ path: "Log/b.md" });
    // Where they are already, nothing moves.
    expect(rebaseRun(run, (id) => where.get(id) ?? null)).toEqual({ moved: false, lost: false });
  });

  it("names a Collection that is gone, and leaves its paths", () => {
    const run = savedRun();
    expect(rebaseRun(run, (id) => (id === "object-tasks" ? "Tasks" : null))).toEqual({ moved: false, lost: true });
    expect(run.plan?.[1]?.effects[0]).toMatchObject({ collectionPath: "Log" });
  });
});
