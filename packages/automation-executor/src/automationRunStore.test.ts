import { appendFile, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch, metadataDirAt, testMetadataDir } from "./testScratch";
import { createAutomationRunStore, type StoredRun } from "./automationRunStore";

const AUTOMATION = "collection:Tasks#bump";

function run(claimId: string, state: "done" | "failed" | null, updatedAtMs: number, settled = state === "done"): StoredRun {
  return {
    version: 2, claimId, automationId: AUTOMATION, definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef",
    startedAtMs: updatedAtMs, updatedAtMs, plan: null,
    applied: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "__proto__", before: 1, after: 2 }] }],
    created: [], replans: [], undoRequests: [], readableFields: null, datasetId: null, superseded: false, undo: null, settled, compacted: false,
    outcome: state === null ? null : state === "done" ? { state } : { state, error: "No.", run: 1 },
  };
}

describe("the automation run store", () => {
  it("keeps each claim's runs under the workspace's metadata folder and reads them back as written", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = run("atc_one", null, 1);
    await store.save(saved);
    await store.save({ ...saved, definitionHash: "fedcba9876543210", keySeed: "fedcba9876543210-1" });
    const { runs, unreadable } = await store.runsOf(AUTOMATION, "atc_one");
    expect(unreadable).toBe(false);
    expect(runs).toHaveLength(2);
    // A field named __proto__ stays a field.
    expect(runs[0]!.applied[0]!.writes[0]).toMatchObject({ field: "__proto__", before: 1, after: 2 });
    await expect(store.runsOf(AUTOMATION, "atc_other")).resolves.toEqual({ runs: [], unreadable: false });
    // A dataset Undo's request is read back, and a whole save keeps it.
    const request = { datasetId: "d", tableId: "t", recordId: 7, operationId: "edit", version: 4, values: { status: "Open" } };
    await store.recordUndoRequest(saved, request);
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs.find((found) => found.keySeed === saved.keySeed)?.undoRequests).toEqual([request]);
    await store.save({ ...saved, undo: "done", undoRequests: [request] });
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs.find((found) => found.keySeed === saved.keySeed)?.undoRequests).toEqual([request]);
    await store.saveSubscriptions([{ automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] }]);
    await expect(store.readSubscriptions()).resolves.toEqual([
      { automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] },
    ]);
    await store.saveTimeouts(new Map([[AUTOMATION, 2]]));
    await expect(store.readTimeouts()).resolves.toEqual(new Map([[AUTOMATION, 2]]));
    expect(await readdir(join(root, ".dohc", "automations"))).toEqual(expect.arrayContaining(["runs", "subscriptions.json", "timeouts.json"]));
  });

  it("reads one fresh store from two places at once", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-automation-runs-"), testMetadataDir);
    const reads = await Promise.all([store.runsOf(AUTOMATION, "atc_one"), store.runsOf(AUTOMATION, "atc_two")]);
    expect(reads).toEqual([{ runs: [], unreadable: false }, { runs: [], unreadable: false }]);
  });

  it("reports a saved run it cannot read, so the claim never starts over as if it had none", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    await store.save(run("atc_one", null, 1));
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const [file] = await readdir(join(folder, automationFolder!));
    await writeFile(join(folder, automationFolder!, file!), "{ torn");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("drops the oldest settled runs, never a run a claim may still resume, and compacts failures history no longer shows", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
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

  it("keeps at most 100 compacted failures per automation", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    for (let index = 0; index < 105; index += 1) {
      await store.save({ ...run(`atc_old${String(index).padStart(3, "0")}`, "failed", index), compacted: true, applied: [] });
    }
    await store.prune(AUTOMATION, async () => new Set());
    const kept: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const claimId = `atc_old${String(index).padStart(3, "0")}`;
      if ((await store.runsOf(AUTOMATION, claimId)).runs.length > 0) kept.push(claimId);
    }
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe("atc_old005");
  });

  it("appends each effect after the plan, and a line a crash cut short counts as not recorded", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = { ...run("atc_one", null, 1), applied: [] };
    await store.save(saved);
    const effect = { ordinal: 0, writes: [{ kind: "field" as const, recordId: "rec_a", path: "Tasks/a.md", field: "A", before: null, after: 1 }] };
    await store.appendEffect(saved, effect);
    await store.recordCreated(saved, { ordinal: 1, recordId: "rec_b", path: "Log/b.md" });
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const progress = (await readdir(join(folder, automationFolder!))).find((file) => file.endsWith(".progress.jsonl"))!;
    await appendFile(join(folder, automationFolder!, progress), '{"kind":"effect","ordinal":2,"wri');
    const [read] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(read!.applied).toEqual([effect]);
    expect(read!.created).toEqual([{ ordinal: 1, recordId: "rec_b", path: "Log/b.md" }]);
    // The next effect starts on a line of its own.
    await store.appendEffect(saved, { ...effect, ordinal: 2 });
    const [again] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(again!.applied.map((entry) => entry.ordinal)).toEqual([0, 2]);
  });

  it("reads runs without making folders", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    await expect(store.runsOf(AUTOMATION, "atc_none")).resolves.toEqual({ runs: [], unreadable: false });
    await expect(readdir(join(root, ".dohc"))).rejects.toThrow();
  });

  it("keeps and finds runs where the host's metadata folder is, even outside the workspace", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const elsewhere = await createTestScratch("dohc-automation-metadata-");
    const store = createAutomationRunStore(root, metadataDirAt(() => join(elsewhere, "meta")));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: false });
    await expect(readdir(elsewhere)).resolves.toEqual([]);
    await store.save(run("atc_one", null, 1));
    const { runs, unreadable } = await store.runsOf(AUTOMATION, "atc_one");
    expect(unreadable).toBe(false);
    expect(runs.map((found) => found.claimId)).toEqual(["atc_one"]);
    expect(await readdir(join(elsewhere, "meta", "automations"))).toEqual(["runs"]);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("reports runs it cannot read when the host refuses its metadata folder", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const refused = metadataDirAt(() => { throw new Error("That folder is not a real folder inside this workspace."); });
    await expect(createAutomationRunStore(root, refused).runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("tells a missing reach file from one it cannot read", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    await expect(store.readReachVerdicts()).resolves.toEqual({ verdicts: [], unreadable: false });
    await writeFile(await store.reachVerdictsPath(), "{ torn");
    await expect(store.readReachVerdicts()).resolves.toEqual({ verdicts: [], unreadable: true });
  });

  it("reads a run in another format, a run without its progress, or a renamed run as unreadable", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = { ...run("atc_one", null, 1), applied: [] };
    await store.save(saved);
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const files = join(folder, automationFolder!);
    const header = (await readdir(files)).find((file) => file.endsWith(".json"))!;
    const progress = (await readdir(files)).find((file) => file.endsWith(".progress.jsonl"))!;
    const text = await readFile(join(files, header), "utf8");

    // An earlier format kept its progress inside the run.
    await writeFile(join(files, header), text.replace('"version":2', '"version":1'));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toMatchObject({ runs: [], unreadable: true });
    await writeFile(join(files, header), text);
    await rm(join(files, progress));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toMatchObject({ runs: [], unreadable: true });
    await writeFile(join(files, progress), "");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toMatchObject({ unreadable: false });
    await rename(join(files, header), join(files, header.replace(".json", "x.json")));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toMatchObject({ runs: [], unreadable: true });
  });

  it("reads an unusable runs folder as unreadable, not as empty history", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    await store.saveTimeouts(new Map());
    await writeFile(join(root, ".dohc", "automations", "runs"), "not a folder");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("keeps the newest record a step created", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = { ...run("atc_one", null, 1), applied: [] };
    await store.save(saved);
    await store.recordCreated(saved, { ordinal: 1, recordId: "rec_first", path: "Log/a.md" });
    await store.recordCreated(saved, { ordinal: 1, recordId: "rec_second", path: "Log/a.md" });
    const [read] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(read!.created).toEqual([{ ordinal: 1, recordId: "rec_second", path: "Log/a.md" }]);
  });
});
