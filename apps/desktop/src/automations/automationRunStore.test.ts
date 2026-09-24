import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createAutomationRunStore, type StoredRun } from "./automationRunStore";

const AUTOMATION = "collection:Tasks#bump";

function run(claimId: string, outcome: StoredRun["outcome"], updatedAtMs: number): StoredRun {
  return {
    version: 1, claimId, automationId: AUTOMATION, definitionHash: "0123456789abcdef",
    startedAtMs: updatedAtMs, updatedAtMs, plan: null,
    done: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "__proto__", before: 1, after: 2 }] }],
    superseded: false, outcome,
  };
}

describe("the automation run store", () => {
  it("keeps each claim's runs under the workspace's metadata folder and reads them back as written", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root);
    const saved = run("atc_one", null, 1);
    await store.save(saved);
    await store.save({ ...saved, definitionHash: "fedcba9876543210" });
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toHaveLength(2);
    const [first] = await store.runsOf(AUTOMATION, "atc_one");
    // A field named __proto__ stays a field.
    expect(first!.done[0]!.writes[0]).toMatchObject({ field: "__proto__", before: 1, after: 2 });
    await expect(store.runsOf(AUTOMATION, "atc_other")).resolves.toEqual([]);
    await store.saveSubscriptions([{ automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] }]);
    await expect(store.readSubscriptions()).resolves.toEqual([
      { automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] },
    ]);
    expect(await readdir(join(root, ".dohc", "automations"))).toEqual(expect.arrayContaining(["runs", "subscriptions.json"]));
  });

  it("drops the oldest finished runs and keeps every run a Try again may still need", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root);
    for (let index = 0; index < 30; index += 1) await store.save(run(`atc_done${index}`, { state: "done" }, index));
    for (let index = 0; index < 12; index += 1) {
      await store.save(run(`atc_failed${index}`, { state: "failed", error: "No." }, 100 + index));
    }
    await store.prune(AUTOMATION);
    const kept = await store.list(AUTOMATION, 200);
    expect(kept.filter((entry) => entry.outcome?.state === "failed")).toHaveLength(12);
    expect(kept.filter((entry) => entry.outcome?.state === "done").map((entry) => entry.claimId))
      .toEqual(Array.from({ length: 20 }, (_, index) => `atc_done${29 - index}`));
  });
});
