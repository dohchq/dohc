import { createHash } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch, storeFolderAt, testStoreFolder } from "./testScratch";
import { createAutomationRunStore, EXPIRE_BATCH_RUNS, MAX_RUN_FILE_BYTES, RUN_PLAN_BUDGET_BYTES, type AutomationRunStore, type ClaimStanding, type ExpiringClaim, type StoredReach, type StoredRun } from "./automationRunStore";

const AUTOMATION = "collection:Tasks#bump";
// Thirty days after 1000, when runs that ended before 1000 expire.
const NOW = 30 * 24 * 60 * 60 * 1000 + 1000;
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

const setA = { kind: "set" as const, target: { recordId: "rec_a", collectionPath: "Tasks", path: "Tasks/a.md" }, fields: [{ field: "A", before: null, after: 1 }] };

function run(claimId: string, state: "done" | "failed" | null, atMs: number, settled = state === "done"): StoredRun {
  return {
    durableEffects: 0, version: 13, claimId, automationId: AUTOMATION, definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef",
    startedAtMs: atMs, finishedAtMs: state === null ? null : atMs, steps: [{ ordinal: 0, effects: [setA, setA] }],
    applied: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "__proto__", before: 1, after: 2 }] }],
    created: [], replans: [], undoRequests: [], undoCalls: [], undoCovers: [], readableFields: null, collections: [], rules: null, superseded: false, undo: null, undoKept: [], settled,
    outcome: state === null ? null : state === "done" ? { state } : { state, error: "No.", run: 1, step: 0 },
  };
}

describe("the automation run store", () => {
  it("reads an absent durableEffects as zero and rejects a mark beyond progress", async () => {
    const root = await createTestScratch("dohc-durable-mark-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("watermark", null, 1);
    await store.save(saved);
    const folder = join(root, ".dohc", "local", "automations", "runs", hashOf(AUTOMATION));
    const path = join(folder, (await readdir(folder))[0]!);
    const lines = (await readFile(path, "utf8")).split("\n");
    const header = JSON.parse(lines[0]!);
    delete header.durableEffects;
    lines[0] = JSON.stringify(header);
    await writeFile(path, lines.join("\n"));
    expect((await store.runsOf(AUTOMATION, saved.claimId)).runs[0]?.durableEffects).toBe(0);
    header.durableEffects = 2;
    lines[0] = JSON.stringify(header);
    await writeFile(path, lines.join("\n"));
    expect((await store.runsOf(AUTOMATION, saved.claimId)).unreadable).toBe(true);
  });

  it("refuses writes from a closed attachment", async () => {
    const root = await createTestScratch("dohc-restore-closed-");
    let current = true;
    const store = createAutomationRunStore(testStoreFolder(root), () => {if (!current) throw Error("closed");});
    await store.savePendingRestore({id: "R1", claims: []});
    current = false;
    await expect(store.removePendingRestore("R1")).rejects.toThrow("closed");
    await expect(store.savePendingRestore({id: "late", claims: []})).rejects.toThrow("closed");
    expect(await createAutomationRunStore(testStoreFolder(root)).pendingRestores()).toEqual([{id: "R1", claims: []}]);
  });
  it("merges current disk entries when an older attachment acknowledges a release", async () => {
    const root = await createTestScratch("dohc-restore-attachments-");
    const old = createAutomationRunStore(testStoreFolder(root));
    await old.savePendingRestore({id: "R1", claims: [], serverRelease: true});
    await old.pendingRestores();
    const current = createAutomationRunStore(testStoreFolder(root));
    await current.savePendingRestore({id: "R2", claims: ["B"]});
    await old.removePendingRestore("R1");
    expect(await createAutomationRunStore(testStoreFolder(root)).pendingRestores()).toEqual([{id: "R2", claims: ["B"]}]);
    await current.savePendingRestore({id: "R2", claims: ["B", "C"]});
    expect(await createAutomationRunStore(testStoreFolder(root)).pendingRestores()).toEqual([{id: "R2", claims: ["B", "C"]}]);
  });
  it("ignores late retention and session saves after offline dismissal", async () => {
    const root = await createTestScratch("dohc-restore-dismiss-race-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.savePendingRestore({id: "restore", claims: ["older"]});
    await store.savePendingRestore({id: "restore", serverRelease: true, claims: [], session: undefined});
    const late = {id: "restore", session: {grants: ["grant"], target: {kind: "person" as const, userId: "ana"},
      label: "Ana", definitions: [], filesUndone: false, receipts: [], result: {status: "waiting"}}};
    await store.savePendingRestore({id: "restore", claims: ["older"]});
    await store.savePendingRestore(late);
    expect(await store.pendingRestores()).toEqual([{id: "restore", serverRelease: true, claims: []}]);
    await store.removePendingRestore("restore");
    await store.savePendingRestore(late);
    expect(await store.pendingRestores()).toEqual([]);
  });
  it.each([false, true])("does not create a follow-up after its parent was dismissed, removed: %s", async removed => {
    const root = await createTestScratch("dohc-restore-follow-up-dismiss-");
    const old = createAutomationRunStore(testStoreFolder(root));
    const session = {grants: ["grant"], target: {kind: "person" as const, userId: "ana"},
      label: "Ana", definitions: [], filesUndone: false, receipts: [], result: {status: "waiting"}};
    await old.savePendingRestore({id: "parent", session});
    await old.pendingRestores();
    const current = createAutomationRunStore(testStoreFolder(root));
    await current.savePendingRestore({id: "parent", serverRelease: true, claims: [], session: undefined});
    if (removed) await current.removePendingRestore("parent");
    await old.savePendingRestore({id: "parent:next", session}, "parent");
    expect((await createAutomationRunStore(testStoreFolder(root)).pendingRestores()).some(entry => entry.id === "parent:next")).toBe(false);
  });
  it("keeps retained claims when the desktop saves only its restore session", async () => {
    const root = await createTestScratch("dohc-restore-session-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.save(run("older", "done", 1));
    await store.savePendingRestore({id: "restore", claims: ["older"]});
    await store.savePendingRestore({id: "restore", session: {grants: ["grant"], target: {kind: "person", userId: "ana"},
      label: "Ana", definitions: [], filesUndone: false, receipts: [], result: {status: "waiting"}}});
    const restarted = createAutomationRunStore(testStoreFolder(root));
    expect(await restarted.unfinishedUndos()).toEqual(new Set(["older"]));
    await restarted.expire(NOW, async () => "gone", null);
    expect((await restarted.runsOf(AUTOMATION, "older")).runs).toHaveLength(1);
  });
  it("bounds the restore journal across repeated whole session saves", async () => {
    const root = await createTestScratch("dohc-restore-bounded-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const entry = {id: "restore", claims: Array.from({length: 10000}, (_, i) => `claim-${i}`), session: {
      grants: ["grant"], target: {kind: "person" as const, userId: "ana"}, label: "Ana", definitions: [], filesUndone: false,
      receipts: Array.from({length: 2000}, (_, i) => ({path: `Tasks/${i}.md`, restoredMomentId: `moment-${i}`})), result: {status: "waiting"}}};
    for (let i = 0; i < 8; i++) await store.savePendingRestore(entry);
    const text = await readFile(join(root, ".dohc/local/automations/restoring.json"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect((await createAutomationRunStore(testStoreFolder(root)).pendingRestores())[0]).toEqual(entry);
  });
  it("appends restore and Undo receipts durably without repeating earlier receipts", async () => {
    const root = await createTestScratch("dohc-restore-lines-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.savePendingRestore({id: "restore", claims: [], session: {grants: ["grant"], target: {kind: "person", userId: "ana"},
      label: "Ana", definitions: [], filesUndone: false, receipts: [], result: {status: "waiting"}}});
    await store.recordRestoreReceipts("restore", Array.from({length: 20}, (_, index) => ({path: `Tasks/${index}.md`, restoredMomentId: `moment-${index}`})));
    await store.undoRestoreReceipts("restore", ["moment-0"]);
    const path = join(root, ".dohc", "local", "automations", "restoring.json");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines.filter(line => line.kind === "receipts")).toHaveLength(1);
    expect(lines.find(line => line.kind === "receipts")?.receipts).toHaveLength(20);
    await appendFile(path, '{"kind":"receipts"');
    const restarted = createAutomationRunStore(testStoreFolder(root));
    expect((await restarted.pendingRestores())[0]?.session?.receipts).toHaveLength(19);
    await restarted.recordRestoreReceipts("restore", [{path: "Tasks/last.md", restoredMomentId: "last"}]);
    expect((await createAutomationRunStore(testStoreFolder(root)).pendingRestores())[0]?.session?.receipts).toHaveLength(20);
    await restarted.removePendingRestore("restore");
    expect(await readFile(path, "utf8")).toBe("");
    expect(await createAutomationRunStore(testStoreFolder(root)).pendingRestores()).toEqual([]);
  });
  it("keeps restore intents across restart until their receipt or Undo is saved", async () => {
    const root = await createTestScratch("dohc-restore-intents-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.savePendingRestore({id: "restore", session: {grants: [], target: {kind: "person", userId: "ana"},
      label: "Ana", definitions: [], filesUndone: false, receipts: [], result: {status: "waiting"}}});
    await store.recordRestoreIntents("restore", ["original-1", "original-2"]);
    const restart = createAutomationRunStore(testStoreFolder(root));
    expect((await restart.pendingRestores())[0]?.session?.intents).toEqual(["original-1", "original-2"]);
    await restart.recordRestoreReceipts("restore", [{path: "one.txt", restoredMomentId: "restore-1"}], ["original-1"]);
    expect((await createAutomationRunStore(testStoreFolder(root)).pendingRestores())[0]?.session?.intents).toEqual(["original-2"]);
    await restart.undoRestoreReceipts("restore", ["restore-2"], ["original-2"]);
    expect((await createAutomationRunStore(testStoreFolder(root)).pendingRestores())[0]?.session?.intents).toEqual([]);
  });
  it("retains older claims needed by an unfinished restore across restart and expiry", async () => {
    const root = await createTestScratch("dohc-restore-retention-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.save({...run("atc_new", "done", 2), undo: "started"});
    await store.save(run("atc_old", "done", 1));
    await store.savePendingRestore({id: "restore", claims: ["atc_new", "atc_old"]});
    const restarted = createAutomationRunStore(testStoreFolder(root));
    expect(await restarted.unfinishedUndos()).toEqual(new Set(["atc_new", "atc_old"]));
    await restarted.expire(NOW, async () => "gone", null);
    expect((await restarted.runsOf(AUTOMATION, "atc_old")).runs).toHaveLength(1);
    await restarted.removePendingRestore("restore");
    await restarted.expire(NOW + 1, async () => "gone", null);
    expect((await restarted.runsOf(AUTOMATION, "atc_old")).runs).toHaveLength(0);
  });
  it("reserves header space when appends fill the progress budget", async () => {
    const root = await createTestScratch("dohc-automation-size-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("append-limit", null, 1);
    await store.save(saved);
    const folder = join(root, ".dohc", "local", "automations", "runs", hashOf(AUTOMATION));
    const path = join(folder, (await readdir(folder))[0]!);
    const before = await readFile(path, "utf8");
    const step = { ordinal: 1, effects: [], output: { kind: "code" as const, value: "" } };
    const bytes = MAX_RUN_FILE_BYTES - RUN_PLAN_BUDGET_BYTES - Buffer.byteLength(before) - Buffer.byteLength(JSON.stringify({ kind: "step", ...step }) + "\n");
    step.output.value = "x".repeat(bytes);
    await store.appendStep(saved, step);
    await expect(store.appendStep(saved, { ordinal: 2, effects: [] })).rejects.toThrow("too large");
    const state = { finishedAtMs: NOW, settled: true, outcome: { state: "failed" as const, error: "e".repeat(RUN_PLAN_BUDGET_BYTES - 2048), run: 1, step: 1 } };
    await store.updateState(saved, state);
    const loaded = (await createAutomationRunStore(testStoreFolder(root)).runsOf(AUTOMATION, saved.claimId)).runs[0]!;
    expect(loaded.finishedAtMs).toBe(NOW);
    expect(loaded.settled).toBe(true);
    expect(loaded.outcome).toEqual(state.outcome);
    expect(loaded.steps[1]?.output).toEqual(step.output);
    expect(Buffer.byteLength(await readFile(path, "utf8"))).toBeLessThanOrEqual(MAX_RUN_FILE_BYTES);
  });

  it("can expire a saved run with a full progress budget and a large header", async () => {
    const root = await createTestScratch("dohc-automation-size-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("save-limit", null, 1);
    saved.definitionHash = "h".repeat(RUN_PLAN_BUDGET_BYTES - 2048);
    saved.steps = [{ ordinal: 0, effects: [], output: { kind: "code", value: "" } }];
    saved.applied = [];
    const overhead = Buffer.byteLength(JSON.stringify({ kind: "step", ...saved.steps[0] }) + "\n");
    const bytes = MAX_RUN_FILE_BYTES - RUN_PLAN_BUDGET_BYTES - overhead;
    saved.steps[0]!.output = { kind: "code", value: "x".repeat(bytes) };
    await store.save(saved);
    const folder = join(root, ".dohc", "local", "automations", "runs", hashOf(AUTOMATION));
    const path = join(folder, (await readdir(folder))[0]!);
    const head = (await readFile(path, "utf8")).split("\n")[0]! + "\n";
    saved.definitionHash += "h".repeat(RUN_PLAN_BUDGET_BYTES - 32 - Buffer.byteLength(head));
    await store.save(saved);
    await expect(store.save({ ...saved, steps: [{ ...saved.steps[0]!, output: { kind: "code", value: "x".repeat(bytes + 1) } }] })).rejects.toThrow("too large");
    await createAutomationRunStore(testStoreFolder(root)).expire(NOW, async () => "gone", null);
    const result = await createAutomationRunStore(testStoreFolder(root)).runsOf(AUTOMATION, saved.claimId);
    expect(result.unreadable).toBe(false);
    expect(result.runs[0]?.finishedAtMs).toBe(NOW);
    expect(result.runs[0]?.steps[0]?.output).toEqual(saved.steps[0]!.output);
  });

  it("bounds the complete file, including its header, before replacing a readable run", async () => {
    const root = await createTestScratch("dohc-automation-size-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("bounded", "done", 1);
    await store.save(saved);
    const large = "x".repeat(MAX_RUN_FILE_BYTES / 2);
    await expect(store.save({ ...saved, definitionHash: large, steps: [{ ...saved.steps[0]!, output: { kind: "code", value: large } }] })).rejects.toThrow("too large");
    expect(await createAutomationRunStore(testStoreFolder(root)).runsOf(AUTOMATION, saved.claimId)).toEqual({ runs: [saved], unreadable: false });
  });
  it("retains terminal acceptance and reversal identities across restart and stale whole saves", async () => {
    const root = await createTestScratch("dohc-automation-settlement-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("settlement", "done", 1);
    const draft = {outboxId: "outbox", appendKey: "write/A", nativeHeadSequence: 3,
      binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
        currentPath: "Tasks/a.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 1}};
    await store.save(saved);
    const sharedSettlements = [{draft, state: "settled" as const}];
    await store.updateState(saved, {sharedSettlements});
    await store.save({...saved, sharedSettlements: [{draft, state: "not-accepted"}]});
    const undoWrites = [{recordId: "rec_a", field: "A", draft: {...draft, appendKey: "undo/A"}}];
    await store.recordUndoWrites(saved, undoWrites);
    const restarted = createAutomationRunStore(testStoreFolder(root));
    const loaded = (await restarted.runsOf(AUTOMATION, "settlement")).runs[0]!;
    expect(loaded).toMatchObject({sharedSettlements, undoWrites});
    await restarted.updateState(loaded, {sharedSettlements: [{draft: undoWrites[0]!.draft, state: "not-accepted"}]});
    expect((await restarted.runsOf(AUTOMATION, "settlement")).runs[0]?.sharedSettlements).toHaveLength(2);
  });
  it.each([11, 12])("saves version 13 and refuses version %s without a compatibility reader", async version => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.save({...run("atc_one", "done", 1), undoKept: [{recordId: "rec_a", field: "A", path: "Tasks/a.md", fieldName: "A", datasetRecordId: null}]});
    const folder = join(root, ".dohc", "local", "automations", "runs", hashOf(AUTOMATION));
    const path = join(folder, (await readdir(folder)).find(file => file.endsWith(".json"))!);
    const lines = (await readFile(path, "utf8")).split("\n");
    const header = JSON.parse(lines[0]!);
    expect(header.version).toBe(13);
    header.version = version;
    lines[0] = JSON.stringify(header);
    await writeFile(path, lines.join("\n"));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({runs: [], unreadable: true});
  });

  it("preserves timing on appended progress lines across restart and whole saves", async () => {
    const root = await createTestScratch("dohc-automation-timing-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("timed", null, 1);
    saved.steps[0] = { ...saved.steps[0]!, findMs: 12, planMs: 3 };
    saved.applied[0] = { ...saved.applied[0]!, writeMs: 15, writeCount: 1 };
    await store.save(saved);
    const step = { ordinal: 1, effects: [setA], findMs: 0, planMs: 4 };
    const effect = { ordinal: 1, writes: [], writeMs: 0, writeCount: 1 };
    await store.appendStep(saved, step);
    await store.appendEffect(saved, effect);
    const expected = { ...saved, steps: [...saved.steps, step], applied: [...saved.applied, effect] };
    const restarted = createAutomationRunStore(testStoreFolder(root));
    expect(await restarted.runsOf(AUTOMATION, "timed")).toEqual({ runs: [expected], unreadable: false });
    await restarted.save(expected);
    expect(await store.runsOf(AUTOMATION, "timed")).toEqual({ runs: [expected], unreadable: false });
  });
  it("keeps the structured circuit breaker outcome across restart and clears it after recovery", async () => {
    const root = await createTestScratch("dohc-automation-breaker-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const breaker = { automationId: AUTOMATION, claimId: "third-timeout", datasetInstance: null, reason: "consecutive-timeouts" as const, collectionPath: "Tasks", run: 1 };
    await store.recordCircuitBreaker(breaker);
    const restarted = createAutomationRunStore(testStoreFolder(root));
    expect(await restarted.readCircuitBreakers()).toEqual([breaker]);
    await restarted.clearCircuitBreaker(breaker);
    expect(await store.readCircuitBreakers()).toEqual([]);
  });

  it("keeps document and dataset circuit breaker outcomes in separate instances", async () => {
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-automation-breakers-")));
    const breaker = { automationId: AUTOMATION, claimId: "document-timeout", datasetInstance: null, reason: "consecutive-timeouts" as const, collectionPath: "Tasks", run: 1 };
    const dataset = { ...breaker, claimId: "dataset-timeout", datasetInstance: JSON.stringify(["dataset", "epoch"]) };
    await store.recordCircuitBreaker(breaker);
    await store.recordCircuitBreaker(dataset);
    expect(await store.readCircuitBreakers()).toEqual([breaker, dataset]);
    await store.clearCircuitBreaker(breaker);
    expect(await store.readCircuitBreakers()).toEqual([dataset]);
  });
  it.each([7, 8])("rejects v%s history without the required kept fields", async (version) => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("atc_one", "done", 1);
    await store.save(saved);
    const base = join(root, ".dohc", "local", "automations", "runs");
    const [folder] = await readdir(base);
    const files = await readdir(join(base, folder!));
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const path = join(base, folder!, file);
      const value = JSON.parse((await readFile(path, "utf8")).split("\n")[0]!);
      value.version = version;
      delete value.undoKept;
      await writeFile(path, JSON.stringify(value));
    }
    expect(await store.runsOf(AUTOMATION, "atc_one")).toEqual({ runs: [], unreadable: true });
  });

  it("preserves progress when saving kept fields in v9 history", async () => {
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-automation-runs-")));
    const saved = run("atc_one", "done", 1);
    await store.save(saved);
    const undoKept = [{ recordId: "rec_a", field: "__proto__", path: "Tasks/one.md", fieldName: "__proto__", datasetRecordId: null }];
    await store.updateState(saved, { undo: "done", undoKept });
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs).toEqual([{ ...saved, undo: "done", undoKept }]);
  });
  it("keeps the later run that superseded a server wake", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = run("old", "done", 1);
    saved.applied = [{ ordinal: 0, writes: [{ kind: "notice", noticeId: "wake", name: "Ice; agent wake superseded by a later run", supersededBy: "new/hash/0/wake" }] }];
    await store.save(saved);
    expect((await store.runsOf(AUTOMATION, "old")).runs).toEqual([saved]);
  });

  it("marks a superseded wake without overwriting newer step progress or Undo state", async () => {
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-automation-runs-")));
    const saved = run("old", "done", 1);
    saved.applied = [{ ordinal: 0, writes: [{ kind: "notice", noticeId: "wake", name: "Ice" }] }];
    await store.save(saved);
    const later = { ordinal: 1, writes: [{ kind: "field" as const, recordId: "rec_a", path: "Tasks/a.md", field: "A", before: null, after: 1 }] };
    await Promise.all([
      store.appendEffect(saved, later),
      store.updateState(saved, { undo: "started" }),
      store.supersedeWake(AUTOMATION, saved.claimId, saved.keySeed, "wake", "new"),
    ]);
    await store.supersedeWake(AUTOMATION, saved.claimId, saved.keySeed, "wake", "new");
    expect((await store.runsOf(AUTOMATION, "old")).runs).toEqual([{
      ...saved, undo: "started", applied: [{ ordinal: 0, writes: [{ kind: "notice", noticeId: "wake", name: "Ice; agent wake superseded by a later run", supersededBy: "new" }] }, later],
    }]);
    await expect(store.supersedeWake(AUTOMATION, "expired", saved.keySeed, "wake", "new")).resolves.toBeUndefined();
  });

  it("keeps each claim's runs under the workspace's metadata folder and reads them back as written", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
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
    // So are an Undo's reverses and deletes, saved together in one line, in order.
    const rules = { datasetId: "d", revision: 2, revisionSha256: "r" };
    const deletes = [
      { kind: "reverse" as const, rules, operationId: "release", action: "hold", revision: 9, input: { id: "a" }, idempotencyKey: "u.0" },
      { kind: "delete" as const, rules, tableId: "t", recordId: 7, operationId: "delete", expectedVersion: 1, idempotencyKey: "u.1" },
      { kind: "delete" as const, rules, tableId: "t", recordId: "8", operationId: "delete", expectedVersion: 3, idempotencyKey: "u.2" },
    ];
    await store.recordUndoCalls(saved, [saved.keySeed], deletes);
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs.find((found) => found.keySeed === saved.keySeed)).toMatchObject({ undoCalls: deletes, undoCovers: [saved.keySeed] });
    await store.save({ ...saved, undo: "done", undoRequests: [request], undoCalls: deletes, undoCovers: [saved.keySeed] });
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs.find((found) => found.keySeed === saved.keySeed))
      .toMatchObject({ undoRequests: [request], undoCalls: deletes, undoCovers: [saved.keySeed] });
    await store.saveSubscriptions([{ automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] }]);
    await expect(store.readSubscriptions()).resolves.toEqual([
      { automationId: AUTOMATION, path: "Tasks", kinds: ["changed"], fields: ["Status"] },
    ]);
    await store.saveTimeouts(new Map([[AUTOMATION, 2]]));
    await expect(store.readTimeouts()).resolves.toEqual(new Map([[AUTOMATION, 2]]));
    expect(await readdir(join(root, ".dohc", "local", "automations"))).toEqual(expect.arrayContaining(["runs", "subscriptions.json", "timeouts.json"]));
  });

  it("changes a run's settled and Undo state as it is saved now, so neither overwrites the other from an older copy", async () => {
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-automation-runs-")));
    // The settle and an Undo each read the run before the other writes.
    const read = run("atc_one", "done", 1, false);
    await store.save(read);
    const deletes = [{ kind: "delete" as const, rules: { datasetId: "d", revision: 2, revisionSha256: "r" }, tableId: "t", recordId: 7, operationId: "delete", expectedVersion: 1, idempotencyKey: "u.1" }];
    await store.updateState(read, { undo: "started" });
    // An Undo that started keeps its claim in run history, as a save that starts one does.
    await expect(store.unfinishedUndos()).resolves.toEqual(new Set(["atc_one"]));
    await store.recordUndoCalls(read, [read.keySeed], deletes);
    await store.updateState(read, { settled: true });
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs).toEqual([expect.objectContaining({ settled: true, undo: "started", undoCalls: deletes })]);
    await store.updateState(read, { undo: "done" });
    expect((await store.runsOf(AUTOMATION, "atc_one")).runs).toEqual([expect.objectContaining({ settled: true, undo: "done", undoCalls: deletes })]);
    await expect(store.updateState(run("atc_missing", "done", 1), { undo: "started" })).rejects.toThrow("could not read");
    // Asked at once, each reads the run inside the store's queue, after the other wrote.
    const other = run("atc_two", "done", 1, false);
    await store.save(other);
    await Promise.all([store.updateState(other, { undo: "started" }), store.updateState(other, { settled: true }), store.recordUndoCalls(other, [other.keySeed], deletes)]);
    expect((await store.runsOf(AUTOMATION, "atc_two")).runs).toEqual([expect.objectContaining({ settled: true, undo: "started", undoCalls: deletes })]);
  });

  it("reads one fresh store from two places at once", async () => {
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-automation-runs-")));
    const reads = await Promise.all([store.runsOf(AUTOMATION, "atc_one"), store.runsOf(AUTOMATION, "atc_two")]);
    expect(reads).toEqual([{ runs: [], unreadable: false }, { runs: [], unreadable: false }]);
  });

  it("reports a saved run it cannot read, so the claim never starts over as if it had none", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.save(run("atc_one", null, 1));
    const folder = join(root, ".dohc", "local", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const file = (await readdir(join(folder, automationFolder!))).find(name => name.endsWith(".json"));
    await writeFile(join(folder, automationFolder!, file!), "{ torn");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("expires a claim's runs once its last run ended before the window, reading only plan files, and keeps what may still run", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
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
    const folder = join(root, ".dohc", "local", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const files = await readdir(join(folder, automationFolder!));
    const fileOf = (claimId: string, suffix: string) => files.find((file) => file.endsWith(suffix) && file.startsWith(hashOf(claimId)))!;
    // Expiry reads the header without parsing even damaged progress.
    await appendFile(join(folder, automationFolder!, fileOf("atc_old", ".json")), "{ torn\n");
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
    await createAutomationRunStore(testStoreFolder(root)).expire(NOW + 2000, standing, null);
    expect(asked.sort()).toEqual(["atc_failed", "atc_running"]);
  });

  it("keeps unsupported formats and damaged headers until the development store is reset", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.save(run("atc_older", "done", 10));
    await store.save(run("atc_damaged", "done", 10));
    const folder = join(root, ".dohc", "local", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const files = await readdir(join(folder, automationFolder!));
    const planOf = (claimId: string) => join(folder, automationFolder!, files.find((file) => file.endsWith(".json") && file.startsWith(hashOf(claimId)))!);
    const text = await readFile(planOf("atc_older"), "utf8");
    await writeFile(planOf("atc_older"), text.replace('"version":13', '"version":9'));
    await writeFile(planOf("atc_damaged"), "{ torn");
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    await expect(store.expire(Date.now(), async () => "gone", null)).resolves.toBeNull();
    expect((await store.runsOf(AUTOMATION, "atc_older")).unreadable).toBe(true);
    await expect(createAutomationRunStore(testStoreFolder(root)).expire(later, async () => "gone", null)).resolves.toBeNull();
    await expect(store.runsOf(AUTOMATION, "atc_older")).resolves.toEqual({ runs: [], unreadable: true });
    expect((await store.runsOf(AUTOMATION, "atc_damaged")).unreadable).toBe(true);
  });

  it("leaves a claim whose plan file changed after expiry read it", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
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
    // The first batch stops inside the second automation's folder.
    const store = createAutomationRunStore(testStoreFolder(root), undefined, { expireBatchRuns: 4 });
    for (let index = 0; index < 3; index += 1) await store.save(run(`atc_a${index}`, "done", 10));
    const deleted = "collection:Gone#old";
    for (let index = 0; index < 3; index += 1) await store.save({ ...run(`atc_b${index}`, "done", 10), automationId: deleted });
    let batches = 0;
    for (let from: string | null = null; ; batches += 1) {
      from = await store.expire(NOW, async () => "gone", from);
      if (from === null) break;
    }
    expect(batches).toBe(1);
    await expect(readdir(join(root, ".dohc", "local", "automations", "runs"))).resolves.toEqual([]);
    // A workspace with no saved runs has nothing to expire, and gains no folder.
    const empty = await createTestScratch("dohc-automation-runs-");
    await expect(createAutomationRunStore(testStoreFolder(empty)).expire(1000, async () => "gone", null)).resolves.toBeNull();
    await expect(readdir(join(empty, ".dohc", "local"))).resolves.not.toContain("automations");
  });

  it("keeps a claim whose new run was saved between two batches of a pass", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root), undefined, { expireBatchRuns: 4 });
    for (let index = 0; index < 5; index += 1) await store.save(run(`atc_c${index}`, "done", 10));
    const from = await store.expire(NOW, async () => "gone", null);
    expect(from).not.toBeNull();
    let waiting: string | undefined;
    for (let index = 0; index < 5 && waiting === undefined; index += 1) {
      if ((await store.runsOf(AUTOMATION, `atc_c${index}`)).runs.length > 0) waiting = `atc_c${index}`;
    }
    // Tried again under a changed automation, it ran just now.
    const other = "fedcba9876543210";
    await store.save({ ...run(waiting!, "done", NOW), definitionHash: other, keySeed: other });
    await expect(store.expire(NOW, async () => "gone", from)).resolves.toBeNull();
    expect((await store.runsOf(AUTOMATION, waiting!)).runs).toHaveLength(2);
  });

  it("reads at most EXPIRE_BATCH_RUNS plan files in a batch unless told otherwise", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.save(run("atc_d0", "done", 10));
    const folder = join(root, ".dohc", "local", "automations", "runs", hashOf(AUTOMATION));
    const [saved] = await readdir(folder);
    const text = await readFile(join(folder, saved!), "utf8");
    // Plain copies of one saved run: a durable save each would cost seconds on a busy disk.
    await Promise.all(Array.from({ length: EXPIRE_BATCH_RUNS }, (_, index) => writeFile(
      join(folder, saved!.replace(hashOf("atc_d0"), hashOf(`atc_d${index + 1}`))),
      text.replace('"claimId":"atc_d0"', `"claimId":"atc_d${index + 1}"`),
    )));
    let asked = 0;
    await expect(store.expire(NOW, async () => { asked += 1; return "open"; }, null)).resolves.not.toBeNull();
    expect(asked).toBe(EXPIRE_BATCH_RUNS);
    for (const expireBatchRuns of [0, -1, 1.5]) expect(() => createAutomationRunStore(testStoreFolder(root), undefined, { expireBatchRuns })).toThrow(RangeError);
  });

  it("lists the claims whose Undo is unfinished until each of their runs is undone", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const first = { ...run("atc_undoing", "done", 0), undo: "started" as const };
    const second = { ...first, keySeed: "fedcba9876543210" };
    await store.save(first);
    await store.save(second);
    expect(await store.unfinishedUndos()).toEqual(new Set(["atc_undoing"]));
    // A second store reads what the first saved.
    await store.save({ ...first, undo: "done" });
    expect(await createAutomationRunStore(testStoreFolder(root)).unfinishedUndos()).toEqual(new Set(["atc_undoing"]));
    await store.save({ ...second, undo: "done" });
    expect(await store.unfinishedUndos()).toEqual(new Set());
    // An unreadable list counts nothing as finished.
    await writeFile(join(root, ".dohc", "local", "automations", "undoing.json"), "{");
    expect(await createAutomationRunStore(testStoreFolder(root)).unfinishedUndos()).toBeNull();
  });

  it("reads a Collection a step names with the step, until the run's state names it where it is now", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = { ...run("atc_one", null, 1), steps: [], applied: [] };
    await store.save(saved);
    await store.appendStep(saved, { ordinal: 0, effects: [setA], collections: [{ collectionId: "object-tasks", path: "Tasks" }] });
    const [read] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(read!.collections).toEqual([{ collectionId: "object-tasks", path: "Tasks" }]);
    // Once a move is saved, the state's path wins over the step's.
    await store.save({ ...read!, collections: [{ collectionId: "object-tasks", path: "Trip/Tasks" }] });
    const [moved] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(moved!.collections).toEqual([{ collectionId: "object-tasks", path: "Trip/Tasks" }]);
  });

  it("appends each step and effect after the run, and a line a crash cut short counts as not recorded", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = { ...run("atc_one", null, 1), steps: [], applied: [] };
    await store.save(saved);
    // A Find leaves the records it found; an If, the branch it took.
    const found = { ordinal: 0, effects: [], output: { kind: "find" as const, records: [{ id: "7", key: 7, path: "[\"d\",\"t\",7]" }] } };
    await store.appendStep(saved, found);
    await store.appendStep(saved, { ordinal: 2, effects: [setA, setA] });
    const effect = { ordinal: 0, writes: [{ kind: "field" as const, recordId: "rec_a", path: "Tasks/a.md", field: "A", before: null, after: 1 }] };
    await store.appendEffect(saved, effect);
    await store.recordCreated(saved, { ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" });
    const folder = join(root, ".dohc", "local", "automations", "runs");
    const [automationFolder] = await readdir(folder);
    const progress = (await readdir(join(folder, automationFolder!))).find((file) => file.endsWith(".json"))!;
    await appendFile(join(folder, automationFolder!, progress), '{"kind":"effect","ordinal":2,"wri');
    const [read] = (await createAutomationRunStore(testStoreFolder(root)).runsOf(AUTOMATION, "atc_one")).runs;
    expect(read!.steps).toEqual([found, { ordinal: 2, effects: [setA, setA] }]);
    expect(read!.applied).toEqual([effect]);
    expect(read!.created).toEqual([{ ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" }]);
    // The next effect starts on a line of its own.
    await store.appendEffect(saved, { ...effect, ordinal: 2 });
    const [again] = (await store.runsOf(AUTOMATION, "atc_one")).runs;
    expect(again!.applied.map((entry) => entry.ordinal)).toEqual([0, 2]);
    // An effect no saved step planned, or steps out of order, are not a run this store wrote.
    await store.appendEffect(saved, effect);
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toMatchObject({ runs: [], unreadable: true });
    const other = { ...run("atc_two", null, 1), steps: [{ ordinal: 3, effects: [] }, { ordinal: 1, effects: [] }], applied: [] };
    await store.save(other);
    await expect(store.runsOf(AUTOMATION, "atc_two")).resolves.toMatchObject({ runs: [], unreadable: true });
  });

  it("reads runs without making folders", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await expect(store.runsOf(AUTOMATION, "atc_none")).resolves.toEqual({ runs: [], unreadable: false });
    await expect(readdir(join(root, ".dohc"))).rejects.toThrow();
  });

  it("keeps and finds runs where the host's folder is, even outside the workspace", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const elsewhere = await createTestScratch("dohc-automation-metadata-");
    const store = createAutomationRunStore(storeFolderAt(join(elsewhere, "meta")));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: false });
    await expect(readdir(elsewhere)).resolves.toEqual([]);
    await store.save(run("atc_one", null, 1));
    const { runs, unreadable } = await store.runsOf(AUTOMATION, "atc_one");
    expect(unreadable).toBe(false);
    expect(runs.map((found) => found.claimId)).toEqual(["atc_one"]);
    expect(await readdir(join(elsewhere, "meta", "automations"))).toEqual(["runs"]);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("reports runs it cannot read when the host refuses its folder", async () => {
    const refuse = async (): Promise<never> => { throw new Error("That folder is not a real folder inside this workspace."); };
    await expect(createAutomationRunStore({ forWrite: refuse, read: refuse }).runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("tells a missing reach file from one it cannot read", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const none = { verdicts: [], hostRecord: 0, unproven: [], unprovenAll: false, unprovenPaths: [], unprovenFolders: [], pending: null, taken: null };
    await expect(store.readReachVerdicts()).resolves.toEqual({ ...none, unreadable: false, missing: true });
    await mkdir(join(root, ".dohc", "local", "automations"), { recursive: true });
    await writeFile(await store.reachVerdictsPath(), "{ torn");
    await expect(store.readReachVerdicts()).resolves.toEqual({ ...none, unreadable: true, missing: false });
  });

  it("keeps the verdicts with the host record they were taken at and the definitions still unproven", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const verdict = { automationId: AUTOMATION, definitionHash: "h1", step: "0", verdict: "held" as const, stoppedFor: null, seq: 3 };
    const reach = { verdicts: [verdict], hostRecord: 7, unproven: [JSON.stringify([AUTOMATION, "h1"])], unprovenAll: true, unprovenPaths: ["Unknown"], unprovenFolders: ["Tasks"], pending: 9, taken: 8 };
    await store.saveReachVerdicts(reach);
    await expect(store.readReachVerdicts()).resolves.toEqual({ ...reach, unreadable: false, missing: false });
  });

  it("persists a computed read hold with its operation label", async () => {
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-read-hold-")));
    const verdicts = [{ automationId: AUTOMATION, definitionHash: "h", step: "0", verdict: "held" as const,
      stoppedFor: "Ana", seq: 1, recipient: { id: JSON.stringify(["operation", "dataset", "read"]), name: "Budget: View invoices", action: "find" as const } }];
    const reach = { verdicts, hostRecord: 0, unproven: [], unprovenAll: false, unprovenFolders: [], unprovenPaths: [], pending: null, taken: null };
    await store.saveReachVerdicts(reach);
    expect(await store.readReachVerdicts()).toEqual({ ...reach, unreadable: false, missing: false });
  });

  it("fails closed on old unqualified reach keys", async () => {
    const root = await createTestScratch("dohc-reach-old-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await mkdir(join(root, ".dohc", "local", "automations"), { recursive: true });
    await writeFile(await store.reachVerdictsPath(), JSON.stringify({ version: 2, verdicts: [{
      automationId: AUTOMATION, definitionHash: "h", step: "operation:records.edit", verdict: "stopped", stoppedFor: "Ana", seq: 1,
    }] }));
    expect(await store.readReachVerdicts()).toEqual({ unreadable: true, missing: false, verdicts: [], hostRecord: 0, pending: null, taken: null, unproven: [], unprovenAll: false, unprovenPaths: [], unprovenFolders: [] });
  });

  it("rejects the old two-file layout, a partial header, and a renamed run", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = { ...run("atc_one", null, 1), applied: [] };
    await store.save(saved);
    const folder = join(root, ".dohc", "local", "automations", "runs", hashOf(AUTOMATION));
    const name = (await readdir(folder))[0]!;
    const path = join(folder, name);
    const text = await readFile(path, "utf8");
    const { kind: _kind, ...oldHeader } = JSON.parse(text.split("\n")[0]!);
    await writeFile(path, JSON.stringify(oldHeader) + "\n");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
    await writeFile(path, text.slice(0, text.indexOf("\n")));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
    await writeFile(path, text);
    await rename(path, join(folder, name.replace(".json", "x.json")));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("reads an unusable runs folder as unreadable, not as empty history", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.saveTimeouts(new Map());
    await writeFile(join(root, ".dohc", "local", "automations", "runs"), "not a folder");
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
  });

  it("keeps the newest record each planned record became, apart from the others a step created", async () => {
    const root = await createTestScratch("dohc-automation-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
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

// What the store saves decides what automations may do, so a file another
// user could have written reads as one dohc cannot read, which never allows
// more than no file.
describe("files the run store does not trust", () => {
  const reach: StoredReach = {
    verdicts: [{ automationId: AUTOMATION, definitionHash: "0123456789abcdef", step: "0", verdict: "allowed", stoppedFor: null, seq: 1 }],
    hostRecord: 4, unproven: [], unprovenAll: false, unprovenFolders: [], unprovenPaths: [], pending: null, taken: null,
  };
  const breaker = { automationId: AUTOMATION, claimId: "atc_one", datasetInstance: null, reason: "consecutive-timeouts" as const, collectionPath: "Tasks", run: 1 };
  const failure = { automationId: AUTOMATION, datasetInstance: null, claimId: "atc_one", generation: 1, open: true };
  const subscription = { automationId: AUTOMATION, path: "Tasks", kinds: ["changed" as const] };

  // Each file that changes what automations do, what it says when trusted,
  // and what it says when not: no reach, nothing switched on or off, no
  // Undo or Stop and restore treated as finished.
  const files: Array<[name: string, read: (store: AutomationRunStore) => Promise<unknown>, trusted: unknown, untrusted: unknown]> = [
    ["reach.json", (store) => store.readReachVerdicts(), { ...reach, unreadable: false, missing: false },
      { verdicts: [], hostRecord: 0, unproven: [], unprovenAll: false, unprovenFolders: [], unprovenPaths: [], pending: null, taken: null, unreadable: true, missing: false }],
    ["enabled.json", (store) => store.readEnabledAutomations(), new Map([["Tasks", ["bump"]]]), null],
    ["circuit-breakers.json", (store) => store.readCircuitBreakers(), [breaker], []],
    ["timeouts.json", (store) => store.readTimeouts(), new Map([[AUTOMATION, 2]]), new Map()],
    ["failures.json", (store) => store.readReportedFailures(), [failure], []],
    ["subscriptions.json", (store) => store.readSubscriptions(), [subscription], []],
    ["undoing.json", (store) => store.unfinishedUndos(), new Set(["atc_one", "atc_two"]), null],
    ["restoring.json", (store) => store.pendingRestores().catch((error: Error) => error.message), [{ id: "restore", claims: ["atc_two"] }],
      "dohc could not read unfinished Stop and restore progress. Reopen the workspace, then try again."],
  ];

  async function savedEverything() {
    const root = await createTestScratch("dohc-untrusted-runs-");
    const store = createAutomationRunStore(testStoreFolder(root));
    const saved = { ...run("atc_one", null, 1), undo: "started" as const };
    await store.save(saved);
    await store.saveReachVerdicts(reach);
    await store.saveEnabledAutomations(new Map([["Tasks", ["bump"]]]));
    await store.recordCircuitBreaker(breaker);
    await store.saveTimeouts(new Map([[AUTOMATION, 2]]));
    await store.saveReportedFailures([failure]);
    await store.saveSubscriptions([subscription]);
    await store.savePendingRestore({ id: "restore", claims: ["atc_two"] });
    const folder = join(root, ".dohc", "local", "automations");
    const runs = join(folder, "runs", hashOf(AUTOMATION));
    const runFile = join(runs, (await readdir(runs))[0]!);
    return { root, store, saved, folder, runFile };
  }

  // A second name elsewhere, or other users' write, lets another user change it.
  const untrust = {
    "writable by others": async (path: string) => chmod(path, 0o666),
    "hard-linked": async (path: string) => link(path, join(await createTestScratch("dohc-untrusted-link-"), "second")),
  };

  it.skipIf(process.platform === "win32").each(Object.keys(untrust))("reads each file %s as one it cannot read", async (how) => {
    const { root, folder } = await savedEverything();
    for (const [name, read, trusted, untrusted] of files) {
      expect(await read(createAutomationRunStore(testStoreFolder(root))), name).toEqual(trusted);
      await untrust[how as keyof typeof untrust](join(folder, name));
      expect(await read(createAutomationRunStore(testStoreFolder(root))), name).toEqual(untrusted);
    }
  });

  it.skipIf(process.platform === "win32").each(Object.keys(untrust))("neither reads nor adds to a saved run %s", async (how) => {
    const { root, saved, runFile } = await savedEverything();
    await untrust[how as keyof typeof untrust](runFile);
    const store = createAutomationRunStore(testStoreFolder(root));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
    await expect(store.appendStep(saved, { ordinal: 1, effects: [] })).rejects.toThrow("dohc could not read this run's saved changes in .dohc/local/automations.");
    await expect(store.updateState(saved, { undo: "done" })).rejects.toThrow("dohc could not read this run's saved changes in .dohc/local/automations.");
  });

  it.skipIf(process.platform === "win32")("reads nothing another user owns", async () => {
    const { root } = await savedEverything();
    const someoneElse = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      const store = createAutomationRunStore(testStoreFolder(root));
      for (const [name, read, , untrusted] of files) expect(await read(store), name).toEqual(untrusted);
      await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
    } finally {
      someoneElse.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("writes every file so only this user can change it, whatever the umask", async () => {
    const umask = process.umask(0);
    try {
      const { folder, runFile, store, saved } = await savedEverything();
      await store.appendStep(saved, { ordinal: 1, effects: [] });
      for (const path of [runFile, ...files.map(([name]) => join(folder, name))]) {
        const stats = await lstat(path);
        expect({ path, mode: stats.mode & 0o777, links: stats.nlink }).toEqual({ path, mode: 0o600, links: 1 });
      }
    } finally {
      process.umask(umask);
    }
  });

  it.skipIf(process.platform === "win32")("makes its folders so only this user can change them, and reads nothing in one others can write", async () => {
    const umask = process.umask(0);
    let made: Awaited<ReturnType<typeof savedEverything>>;
    try {
      made = await savedEverything();
    } finally {
      process.umask(umask);
    }
    const { root, folder, runFile, saved } = made;
    const runs = dirname(runFile);
    for (const path of [folder, join(folder, "runs"), runs]) {
      expect({ path, mode: (await lstat(path)).mode & 0o777 }).toEqual({ path, mode: 0o700 });
    }
    // Another user in the group could delete a run, and its claim would start over.
    await chmod(runs, 0o770);
    const store = createAutomationRunStore(testStoreFolder(root));
    await expect(store.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
    await expect(store.appendStep(saved, { ordinal: 1, effects: [] })).rejects.toThrow("must be a folder in this workspace that only you can change.");
    // Or delete the steps a person allowed, so a step that should wait for a current editor runs.
    await chmod(runs, 0o700);
    await chmod(folder, 0o707);
    for (const [name, read, , untrusted] of files) expect(await read(createAutomationRunStore(testStoreFolder(root))), name).toEqual(untrusted);
    await expect(store.saveReachVerdicts(reach)).rejects.toThrow("must be a folder in this workspace that only you can change.");
  });

  it.skipIf(process.platform === "win32")("replaces a reach file it does not trust when holds are reset", async () => {
    const { root, folder } = await savedEverything();
    await chmod(join(folder, "reach.json"), 0o666);
    const store = createAutomationRunStore(testStoreFolder(root));
    await store.saveReachVerdicts(reach);
    expect((await lstat(join(folder, "reach.json"))).mode & 0o777).toBe(0o600);
    await expect(store.readReachVerdicts()).resolves.toEqual({ ...reach, unreadable: false, missing: false });
  });
});
