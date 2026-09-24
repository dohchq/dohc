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
    superseded: false, settled, compacted: false,
    outcome: state === null ? null : state === "done" ? { state } : { state, error: "No.", run: 1 },
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

  it("drops the oldest settled runs, never a run a claim may still resume, and compacts failures history no longer shows", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root);
    for (let index = 0; index < 30; index += 1) await store.save(run(`atc_done${index}`, "done", index));
    // Done here, but the engine has not taken the settle yet.
    await store.save(run("atc_unsettled", "done", 50, false));
    for (let index = 0; index < 12; index += 1) await store.save(run(`atc_failed${index}`, "failed", 100 + index));
    await store.save(run("atc_running", null, 200));
    // Run history lists every claim but the two oldest failures.
    const listed = new Set(["atc_unsettled", "atc_running", ...Array.from({ length: 10 }, (_, index) => `atc_failed${index + 2}`)]);
    let listings = 0;
    await store.prune(AUTOMATION, async () => { listings += 1; return listed; });
    const kept = new Map<string, boolean>();
    for (const claimId of [
      ...Array.from({ length: 30 }, (_, index) => `atc_done${index}`),
      "atc_unsettled", "atc_running",
      ...Array.from({ length: 12 }, (_, index) => `atc_failed${index}`),
    ]) {
      const [saved] = (await store.runsOf(AUTOMATION, claimId)).runs;
      if (saved) kept.set(claimId, saved.compacted);
    }
    expect([...kept.keys()].filter((claimId) => claimId.startsWith("atc_done"))).toEqual(
      Array.from({ length: 20 }, (_, index) => `atc_done${index + 10}`),
    );
    expect(kept.get("atc_unsettled")).toBe(false);
    expect(kept.get("atc_running")).toBe(false);
    // Every failure stays, but only the ones history shows keep their progress.
    expect([...kept].filter(([claimId]) => claimId.startsWith("atc_failed"))).toEqual(
      Array.from({ length: 12 }, (_, index) => [`atc_failed${index}`, index < 2]),
    );
    // The folder is read again only once it grows by the history bound.
    await store.save(run("atc_done-next", "done", 300));
    await store.prune(AUTOMATION, async () => { listings += 1; return listed; });
    expect(listings).toBe(1);
  });
});
