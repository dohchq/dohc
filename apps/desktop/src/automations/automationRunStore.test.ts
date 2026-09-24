import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createAutomationRunStore, type StoredRun } from "./automationRunStore";

const AUTOMATION = "collection:Tasks#bump";

function run(claimId: string, state: "done" | "failed" | null, updatedAtMs: number, settled = state === "done"): StoredRun {
  return {
    version: 1, claimId, automationId: AUTOMATION, definitionHash: "0123456789abcdef",
    startedAtMs: updatedAtMs, updatedAtMs, plan: null,
    applied: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "__proto__", before: 1, after: 2 }] }],
    superseded: false, settled,
    outcome: state === null ? null : state === "done" ? { state } : { state, error: "No." },
  };
}

describe("the automation run store", () => {
  it("keeps each claim's runs under the workspace's metadata folder and reads them back as written", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root);
    const saved = run("atc_one", null, 1);
    await store.save(saved);
    await store.save({ ...saved, definitionHash: "fedcba9876543210" });
    const { runs, unreadable } = await store.runsOf(AUTOMATION, "atc_one");
    expect(unreadable).toBe(false);
    expect(runs).toHaveLength(2);
    // A field named __proto__ stays a field.
    expect(runs[0]!.applied[0]!.writes[0]).toMatchObject({ field: "__proto__", before: 1, after: 2 });
    await expect(store.runsOf(AUTOMATION, "atc_other")).resolves.toEqual({ runs: [], unreadable: false });
    await store.saveSubscriptions([{ automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] }]);
    await expect(store.readSubscriptions()).resolves.toEqual([
      { automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] },
    ]);
    await store.saveTimeouts(new Map([[AUTOMATION, 2]]));
    await expect(store.readTimeouts()).resolves.toEqual(new Map([[AUTOMATION, 2]]));
    expect(await readdir(join(root, ".dohc", "automations"))).toEqual(expect.arrayContaining(["runs", "subscriptions.json", "timeouts.json"]));
  });

  it("reports a saved run it cannot read, so the claim never starts over as if it had none", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root);
    await store.save(run("atc_one", null, 1));
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const [file] = await readdir(join(folder, automationFolder!));
    await writeFile(join(folder, automationFolder!, file!), "{ torn");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("drops the oldest settled runs and never a run a claim may still resume", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root);
    for (let index = 0; index < 30; index += 1) await store.save(run(`atc_done${index}`, "done", index));
    // Done here, but the engine has not taken the settle yet.
    await store.save(run("atc_unsettled", "done", 50, false));
    for (let index = 0; index < 12; index += 1) await store.save(run(`atc_failed${index}`, "failed", 100 + index));
    await store.save(run("atc_running", null, 200));
    await store.prune(AUTOMATION);
    const kept = new Set<string>();
    for (const claimId of [
      ...Array.from({ length: 30 }, (_, index) => `atc_done${index}`),
      "atc_unsettled", "atc_running",
      ...Array.from({ length: 12 }, (_, index) => `atc_failed${index}`),
    ]) {
      if ((await store.runsOf(AUTOMATION, claimId)).runs.length > 0) kept.add(claimId);
    }
    expect([...kept].filter((claimId) => claimId.startsWith("atc_done"))).toEqual(
      Array.from({ length: 20 }, (_, index) => `atc_done${index + 10}`),
    );
    expect(kept).toContain("atc_unsettled");
    expect(kept).toContain("atc_running");
    expect([...kept].filter((claimId) => claimId.startsWith("atc_failed"))).toHaveLength(12);
  });
});
