import { createHash } from "node:crypto";
import { appendFile, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch, metadataDirAt, testMetadataDir } from "./testScratch";
import { createAutomationRunStore, type ClaimStanding, type ExpiringClaim, type StoredRun } from "./automationRunStore";

const AUTOMATION = "collection:Tasks#bump";
// Thirty days after 1000, when runs that ended before 1000 expire.
const NOW = 30 * 24 * 60 * 60 * 1000 + 1000;
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

function run(claimId: string, state: "done" | "failed" | null, atMs: number, settled = state === "done"): StoredRun {
  return {
    version: 4, claimId, automationId: AUTOMATION, definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef",
    startedAtMs: atMs, finishedAtMs: state === null ? null : atMs, plan: null,
    applied: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "__proto__", before: 1, after: 2 }] }],
    created: [], replans: [], undoRequests: [], readableFields: null, collections: [], datasetId: null, superseded: false, undo: null, settled,
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

  it("expires a claim's runs once its last run ended before the window, reading only plan files, and keeps what may still run", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const other = "fedcba9876543210";
    await store.save(run("atc_old", "done", 10));
    await store.save(run("atc_recent", "done", 2000));
    // An Undo leaves when the run ended, so an undone run leaves on time.
    await store.save({ ...run("atc_undone", "done", 10), undo: "done" });
    await store.save({ ...run("atc_undoing", "done", 10), undo: "started" });
    // A claim's runs leave together, when the last of them ended.
    await store.save({ ...run("atc_split", "failed", 10), superseded: true });
    await store.save({ ...run("atc_split", "done", 2000), definitionHash: other, keySeed: other });
    await store.save(run("atc_failed", "failed", 10));
    await store.save(run("atc_failed_gone", "failed", 10));
    // A run that has not ended stays while its claim goes on, and ends now once it will not.
    await store.save(run("atc_running", null, 10));
    await store.save(run("atc_ended", null, 10));
    await store.save(run("atc_unsettled", "done", 10, false));
    await store.save(run("atc_torn", "done", 10));
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const files = await readdir(join(folder, automationFolder!));
    const fileOf = (claimId: string, suffix: string) => files.find((file) => file.endsWith(suffix) && file.startsWith(hashOf(claimId)))!;
    // Its progress is never read, so damage there changes nothing.
    await writeFile(join(folder, automationFolder!, fileOf("atc_old", ".progress.jsonl")), "{ torn");
    // A plan file that cannot be read keeps its claim.
    await writeFile(join(folder, automationFolder!, fileOf("atc_torn", ".json")), "{ torn");
    const asked: string[] = [];
    const standings = new Map<string, ClaimStanding>([["atc_failed", "settled"], ["atc_running", "open"], ["atc_ended", "settled"]]);
    const standing = async (claim: ExpiringClaim) => {
      asked.push(claim.claimId);
      return standings.get(claim.claimId) ?? "gone";
    };
    await expect(store.expire(NOW, standing, null)).resolves.toBeNull();
    expect(asked.sort()).toEqual(["atc_ended", "atc_failed", "atc_failed_gone", "atc_old", "atc_running", "atc_undone", "atc_unsettled"]);
    const left: string[] = [];
    for (const claimId of ["atc_old", "atc_recent", "atc_undone", "atc_undoing", "atc_split", "atc_failed", "atc_failed_gone", "atc_running", "atc_ended", "atc_unsettled", "atc_torn"]) {
      const { runs } = await store.runsOf(AUTOMATION, claimId);
      if (runs.length > 0) left.push(`${claimId}:${runs.length}`);
    }
    expect(left).toEqual(["atc_recent:1", "atc_undoing:1", "atc_split:2", "atc_failed:1", "atc_running:1", "atc_ended:1"]);
    expect((await store.runsOf(AUTOMATION, "atc_running")).runs[0]!.finishedAtMs).toBeNull();
    // Its 30 days start from the pass that found its claim over, and the rest of it is as saved.
    const [ended] = (await store.runsOf(AUTOMATION, "atc_ended")).runs;
    expect(ended).toEqual({ ...run("atc_ended", null, 10), finishedAtMs: NOW });
    expect((await store.runsOf(AUTOMATION, "atc_torn")).unreadable).toBe(true);

    // For a day after a full read, a pass asks only about the claims it asks about every time, as a new store does,
    // though atc_recent's 30 days end a second after that read.
    asked.length = 0;
    await createAutomationRunStore(root, testMetadataDir).expire(NOW + 2000, standing, null);
    expect(asked.sort()).toEqual(["atc_failed", "atc_running"]);
  });

  it("expires a plan file in an earlier format 30 days after it last changed, and keeps one that names no claim", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    await store.save(run("atc_older", "done", 10));
    await store.save(run("atc_damaged", "done", 10));
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const files = await readdir(join(folder, automationFolder!));
    const planOf = (claimId: string) => join(folder, automationFolder!, files.find((file) => file.endsWith(".json") && file.startsWith(hashOf(claimId)))!);
    const text = await readFile(planOf("atc_older"), "utf8");
    await writeFile(planOf("atc_older"), text.replace('"version":4', '"version":3'));
    await writeFile(planOf("atc_damaged"), "{ torn");
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    await expect(store.expire(Date.now(), async () => "gone", null)).resolves.toBeNull();
    expect((await store.runsOf(AUTOMATION, "atc_older")).unreadable).toBe(true);
    await expect(createAutomationRunStore(root, testMetadataDir).expire(later, async () => "gone", null)).resolves.toBeNull();
    await expect(store.runsOf(AUTOMATION, "atc_older")).resolves.toEqual({ runs: [], unreadable: false });
    expect((await store.runsOf(AUTOMATION, "atc_damaged")).unreadable).toBe(true);
  });

  it("leaves a claim whose plan file changed after expiry read it", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = run("atc_changing", "done", 10);
    await store.save(saved);
    // An Undo starts while expiry asks the ledgers about the claim.
    await store.expire(NOW, async () => {
      await store.save({ ...saved, undo: "started" });
      return "gone";
    }, null);
    expect((await store.runsOf(AUTOMATION, "atc_changing")).runs).toHaveLength(1);
  });

  it("expires in batches that go on where the last stopped, and leaves no folder once an automation's runs are gone", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    for (let index = 0; index < 150; index += 1) await store.save(run(`atc_a${index}`, "done", 10));
    const deleted = "collection:Gone#old";
    for (let index = 0; index < 150; index += 1) await store.save({ ...run(`atc_b${index}`, "done", 10), automationId: deleted });
    let batches = 0;
    for (let from: string | null = null; ; batches += 1) {
      from = await store.expire(NOW, async () => "gone", from);
      if (from === null) break;
    }
    expect(batches).toBe(1);
    await expect(readdir(join(root, ".dohc", "automations", "runs"))).resolves.toEqual([]);
    // A workspace with no saved runs has nothing to expire, and gains no folder.
    const empty = await createTestScratch("dohc-automation-runs-");
    await expect(createAutomationRunStore(empty, testMetadataDir).expire(1000, async () => "gone", null)).resolves.toBeNull();
    await expect(readdir(await testMetadataDir(empty))).resolves.not.toContain("automations");
  });

  it("keeps a claim whose new run was saved between two batches of a pass", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    for (let index = 0; index < 250; index += 1) await store.save(run(`atc_c${index}`, "done", 10));
    const from = await store.expire(NOW, async () => "gone", null);
    expect(from).not.toBeNull();
    let waiting: string | undefined;
    for (let index = 0; index < 250 && waiting === undefined; index += 1) {
      if ((await store.runsOf(AUTOMATION, `atc_c${index}`)).runs.length > 0) waiting = `atc_c${index}`;
    }
    // Tried again under a changed automation, it ran just now.
    const other = "fedcba9876543210";
    await store.save({ ...run(waiting!, "done", NOW), definitionHash: other, keySeed: other });
    await expect(store.expire(NOW, async () => "gone", from)).resolves.toBeNull();
    expect((await store.runsOf(AUTOMATION, waiting!)).runs).toHaveLength(2);
  });

  it("lists the claims whose Undo is unfinished until each of their runs is undone", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const first = { ...run("atc_undoing", "done", 0), undo: "started" as const };
    const second = { ...first, keySeed: "fedcba9876543210" };
    await store.save(first);
    await store.save(second);
    expect(await store.unfinishedUndos()).toEqual(new Set(["atc_undoing"]));
    // A second store reads what the first saved.
    await store.save({ ...first, undo: "done" });
    expect(await createAutomationRunStore(root, testMetadataDir).unfinishedUndos()).toEqual(new Set(["atc_undoing"]));
    await store.save({ ...second, undo: "done" });
    expect(await store.unfinishedUndos()).toEqual(new Set());
    // An unreadable list counts nothing as finished.
    await writeFile(join(await testMetadataDir(root), "automations", "undoing.json"), "{");
    expect(await createAutomationRunStore(root, testMetadataDir).unfinishedUndos()).toBeNull();
  });

  it("appends each effect after the plan, and a line a crash cut short counts as not recorded", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = { ...run("atc_one", null, 1), applied: [] };
    await store.save(saved);
    const effect = { ordinal: 0, writes: [{ kind: "field" as const, recordId: "rec_a", path: "Tasks/a.md", field: "A", before: null, after: 1 }] };
    await store.appendEffect(saved, effect);
    await store.recordCreated(saved, { ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" });
    const folder = join(root, ".dohc", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const progress = (await readdir(join(folder, automationFolder!))).find((file) => file.endsWith(".progress.jsonl"))!;
    await appendFile(join(folder, automationFolder!, progress), '{"kind":"effect","ordinal":2,"wri');
    const [read] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(read!.applied).toEqual([effect]);
    expect(read!.created).toEqual([{ ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" }]);
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
    await writeFile(join(files, header), text.replace('"version":4', '"version":3'));
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

  it("keeps the newest record each planned record became, apart from the others a step created", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(root, testMetadataDir);
    const saved = { ...run("atc_one", null, 1), applied: [] };
    await store.save(saved);
    await store.recordCreated(saved, { ordinal: 1, planned: "rec_a", recordId: "rec_first", path: "Log/a.md" });
    await store.recordCreated(saved, { ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" });
    await store.recordCreated(saved, { ordinal: 1, planned: "rec_a", recordId: "rec_second", path: "Log/a.md" });
    const [read] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(read!.created).toEqual([
      { ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" },
      { ordinal: 1, planned: "rec_a", recordId: "rec_second", path: "Log/a.md" },
    ]);
  });
});
