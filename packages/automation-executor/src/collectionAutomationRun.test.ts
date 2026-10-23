import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { afterAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord, CollectionSummary, CollectionValue } from "@dohc/workspace-contracts/collection";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore, type AutomationRunStore, type StoredRun, type UndoWrite } from "./automationRunStore";
import { undoCollectionAutomationRuns } from "./collectionAutomationUndo";
import { definitionHash } from "./automationPlan";
import {
  newRun,
  savedRunOf,
  rebaseRun,
  RECORD_NOT_FOUND,
  RULES_CHANGED_ERROR,
  runCollectionAutomation,
  type CollectionAutomationReads,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
  type CollectionRecordWrites,
} from "./collectionAutomationRun";
import { createTestScratch, testStoreFolder } from "./testScratch";
import { createAutomationTargets } from "./automationTargets";
import { MAX_FOUND_RECORDS } from "./automationPlan";
import { chatDirectoryOf } from "./automationChat";
import { undoAutomationRuns } from "./automationUndo";

// A document Collection's run against an in-memory engine: each step reads
// what the steps before it wrote, and a run that stops at any durable point
// finishes with the same writes, under the same keys, exactly once.

const shared = createAutomationFormulaEvaluator();
afterAll(async () => { await shared.close(); });

function automation(yaml: string): Automation {
  const [first, ...rest] = yaml.split("\n");
  const item = [`  - ${first}`, ...rest.map((line) => `    ${line}`)].join("\n");
  const parsed = parseAutomationsFile(`version: 1\nautomations:\n${item}\n`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error(`Not a valid automation: ${JSON.stringify(parsed)}`);
  return parsed.entries[0].automation;
}

type Doc = { id: string; path: string; collection: string; values: Record<string, JsonValue> };

class Crash extends Error {}

it("undoes an older run of the same claim after only the newer definition was restored", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 3})]);
  const write = (before: number, after: number) => ({kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before, after});
  const older = {...newRun(added(), definition, "run-x", 1), applied: [{ordinal: 0, writes: [write(1, 2)]}]};
  const newer = {...newRun(added(2), definition, "run-y", 2), applied: [{ordinal: 0, writes: [write(2, 3)]}]};
  await undoCollectionAutomationRuns(space.undo([]), [newer], new AbortController().signal);
  newer.undo = "done";
  await undoCollectionAutomationRuns(space.undo([]), [older, newer], new AbortController().signal);
  expect(space.records.get("rec_t")!.values.Count).toBe(1);
  expect(new Set(space.keys.keys()).size).toBe(2);
});

it("does not replay a completed field reversal after another claim's Undo and restart", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", { Count: 2 }), task("rec_other", { Count: 2 })]);
  const store = await scratchStore();
  const write = (recordId: string, before: number, after: number) => ({kind: "field" as const,
    recordId, path: `Tasks/${recordId}.md`, field: "Count", before, after});
  const older = {...newRun({...added(), claimId: "atc_old"}, definition, "old", 1),
    applied: [{ordinal: 0, writes: [write("rec_t", 2, 1)]}]};
  const newer: StoredRun = {...newRun(added(), definition, "new", 2), undo: "started" as const,
    steps: [{ordinal: 0, effects: [{kind: "set", target: {recordId: "rec_t", path: "Tasks/rec_t.md", collectionPath: "Tasks"}, fields: [{field: "Count", before: 1, after: 2}]}]}],
    applied: [{ordinal: 0, writes: [write("rec_t", 1, 2), write("rec_other", 1, 2)]}]};
  await store.save(newer);
  let blocked = true;
  const deps = {...space.undo([]),
    withReads: async <T>(work: (reads: CollectionAutomationReads) => Promise<T>) => space.undo([]).withReads(reads => work({...reads,
      getCollectionRecord: async input => {
        const result = await reads.getCollectionRecord(input);
        return {...result, record: {...result.record, conflicted: blocked && input.recordId === "rec_other"}};
      },
    })),

  };
  await expect(undoCollectionAutomationRuns(deps, [newer], new AbortController().signal)).rejects.toThrow("sync conflict");
  expect(space.records.get("rec_t")!.values.Count).toBe(1);
  await undoCollectionAutomationRuns(space.undo([]), [older], new AbortController().signal);
  expect(space.records.get("rec_t")!.values.Count).toBe(2);
  blocked = false;
  const recovered = (await store.runsOf(newer.automationId, newer.claimId)).runs;
  expect(recovered).toHaveLength(1);
  await undoCollectionAutomationRuns(deps, recovered, new AbortController().signal);
  expect(space.records.get("rec_t")!.values.Count).toBe(2);
  expect(space.records.get("rec_other")!.values.Count).toBe(1);
});

it.each(["started", "done"] as const)("retries a refused shared field without replaying a completed field on the same record (%s)", async undo => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2, Note: 2}}]");
  const space = workspace([task("rec_t", {Count: 2, Note: 2})]);
  const run = {...newRun(added(), definition, "mixed-reversal", 1), applied: [{ordinal: 0, writes: ["Count", "Note"].map(field =>
    ({kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field, before: 1, after: 2}))}]};
  const signal = new AbortController().signal;
  const base = space.undo([]);
  const reversed = await undoCollectionAutomationRuns({...base,
    withRecordWrites: <T>(signal: AbortSignal, work: (edit: CollectionRecordWrites) => Promise<T>) => base.withRecordWrites(signal, edit => work({...edit,
      setFields: async input => ({...await edit.setFields(input), sharedFileUpdates: {Note: {
        outboxId: "outbox", appendKey: `${input.idempotencyKeyPrefix}/Note`, nativeHeadSequence: 1,
        binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "rec_t", lineageClaimId: "a".repeat(64),
          currentPath: "Tasks/rec_t.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0},
      }}}),
    })),
  }, [run], signal);
  run.undo = undo;
  run.undoWrites = reversed.undoWrites;
  run.sharedSettlements = reversed.undoWrites.map(write => ({draft: write.draft, state: "not-accepted"}));
  // Another Undo changed Count; the shared host refused Note's reversal.
  space.records.get("rec_t")!.values = {Count: 2, Note: 2};
  await undoCollectionAutomationRuns(base, [run], signal);
  expect(space.records.get("rec_t")!.values).toEqual({Count: 2, Note: 1});
});

it.each([0, 1])("keeps the Undo key scope when only run %s saved completion before restart", async completed => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 3})]);
  const make = (seed: string, before: number, after: number): StoredRun => ({...newRun(added(), definition, seed, before),
    undo: "started", undoScope: "joint-undo", steps: [{ordinal: 0, effects: [{kind: "set", target: {recordId: "rec_t",
      path: "Tasks/rec_t.md", collectionPath: "Tasks"}, fields: [{field: "Count", before, after}]}]}],
    applied: [{ordinal: 0, writes: [{kind: "field", recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before, after}]}]});
  const runs = [make("run-x", 1, 2), make("run-y", 2, 3)];
  const signal = new AbortController().signal;
  await undoCollectionAutomationRuns(space.undo([]), runs, signal);
  expect(space.records.get("rec_t")!.values.Count).toBe(1);
  space.records.get("rec_t")!.values.Count = 3;
  runs[completed]!.undo = "done";
  const store = await scratchStore();
  for (const run of runs) await store.save(run);
  const recovered = (await store.runsOf(runs[0]!.automationId, runs[0]!.claimId)).runs;
  expect(recovered.every(run => run.undoScope === "joint-undo")).toBe(true);
  await undoCollectionAutomationRuns(space.undo([]), recovered, signal);
  expect(space.records.get("rec_t")!.values.Count).toBe(3);
});

it("leaves fields of a completed creation alone after the person restores it from trash", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 2})]);
  const done = {...newRun(added(), definition, "creation", 1), undo: "done" as const, undoScope: "joint",
    created: [{ordinal: 0, recordId: "rec_t", planned: "rec_t", path: "Tasks/rec_t.md"}],
    applied: [{ordinal: 0, writes: [{kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: null, after: 2}]}]};
  const active = {...newRun(added(), definition, "active", 2), undo: "started" as const, undoScope: "joint"};
  const result = await undoCollectionAutomationRuns(space.undo([]), [done, active], new AbortController().signal);
  expect(result.undone).toMatchObject({reverted: 0, removed: 0});
  expect(space.records.get("rec_t")!.values.Count).toBe(2);
});

it.each([true, false])("leaves a completed creation alone across the chain, restored from trash: %s", async restored => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace(restored ? [task("rec_t", {Count: 3})] : []);
  const done = {...newRun(added(), definition, "creation", 1), undo: "done" as const, undoScope: "joint",
    created: [{ordinal: 0, recordId: "rec_t", planned: "rec_t", path: "Tasks/rec_t.md"}],
    applied: [{ordinal: 0, writes: [{kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: null, after: 2}]}]};
  const active = {...newRun(added(), definition, "active", 2), undo: "started" as const, undoScope: "joint",
    applied: [{ordinal: 0, writes: [{kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: 2, after: 3}]}]};
  const result = await undoCollectionAutomationRuns(space.undo([]), [done, active], new AbortController().signal);
  expect(result.undone).toMatchObject({reverted: 0, removed: 0, missing: 0, changedSince: 0});
  if (restored) expect(space.records.get("rec_t")!.values.Count).toBe(3);
});

it("can undo a later edit of a restored creation in a different Undo scope", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 3})]);
  const done = {...newRun(added(), definition, "creation", 1), undo: "done" as const, undoScope: "earlier",
    created: [{ordinal: 0, recordId: "rec_t", planned: "rec_t", path: "Tasks/rec_t.md"}]};
  const active = {...newRun(added(), definition, "later", 2), undo: "started" as const, undoScope: "later",
    applied: [{ordinal: 0, writes: [{kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: 2, after: 3}]}]};
  expect((await undoCollectionAutomationRuns(space.undo([]), [done, active], new AbortController().signal)).undone).toMatchObject({reverted: 1, missing: 0});
  expect(space.records.get("rec_t")!.values.Count).toBe(2);
});

it("keeps the chain target after the older run alone saved Undo completion", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 1})]);
  const runs = [1, 2].map(before => ({...newRun(added(), definition, `chain-${before}`, before),
    undo: before === 1 ? "done" as const : "started" as const, undoScope: "joint-undo",
    applied: [{ordinal: 0, writes: [{kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before, after: before + 1}]}]}));
  const result = await undoCollectionAutomationRuns(space.undo([]), runs, new AbortController().signal);
  expect(result.keptFields).toEqual([]);
  expect(result.undone.changedSince).toBe(0);
  expect(space.records.get("rec_t")!.values.Count).toBe(1);
});

it.each(["later-group", "receipt-save"])("recovers shared Undo receipts after %s fails", async fault => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 2, Note: 2})]);
  const runs = ["Count", "Note"].map((field, index) => ({...newRun(added(), definition, `receipt-${index}`, index),
    undo: "started" as const, undoScope: `scope-${index}`, applied: [{ordinal: 0, writes: [{kind: "field" as const,
      recordId: "rec_t", path: "Tasks/rec_t.md", field, before: 1, after: 2}]}]}));
  const signal = new AbortController().signal;
  const base = space.undo([]);
  let failed = false;
  const receipts = new Map<string, UndoWrite["draft"]>();
  const dependencies = {...base, recordReversal: async () => {if (!failed && fault === "receipt-save") {failed = true; throw Error("Receipt save stopped");}},
    withRecordWrites: async <T>(abort: AbortSignal, work: (writes: CollectionRecordWrites) => Promise<T>) => base.withRecordWrites(abort, writes => work({...writes,
      setFields: async input => {
        if (!failed && fault === "later-group" && Object.hasOwn(input.fields, "Note")) {failed = true; throw Error("Later group stopped");}
        const result = await writes.setFields(input);
        const updates: Record<string, UndoWrite["draft"]> = {};
        for (const field of Object.keys(input.fields)) {
          const key = `${input.idempotencyKeyPrefix}/${field}`;
          if (Object.hasOwn(result.replaced, field)) receipts.set(key, {outboxId: "outbox", appendKey: key, nativeHeadSequence: 1,
            binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "Tasks/rec_t.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 1}});
          const receipt = receipts.get(key); if(receipt) updates[field] = receipt;
        }
        return {...result, sharedFileUpdates: updates};
      }}))};
  await expect(undoCollectionAutomationRuns(dependencies, runs, signal)).rejects.toThrow("stopped");
  const retried = await undoCollectionAutomationRuns(dependencies, runs, signal);
  expect(retried.undoWrites.map(write => write.field).sort()).toEqual(["Count", "Note"]);
});
it("describes an unfinished Undo without claiming the run was undone", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const store = await scratchStore();
  await store.save({...newRun(added(), definition, "partial", 1), undo: "started"});
  expect(await savedRunOf(store, added(), definition)).toMatchObject({outcome: {
    error: "dohc has not finished undoing this run.",
  }});
});

it("stops before the next record reversal when the engine journal fails", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]");
  const space = workspace([task("rec_t", {Count: 2}), task("rec_other", {Count: 2})]);
  const run = {...newRun(added(), definition, "progress", 1), applied: [{ordinal: 0, writes: ["rec_t", "rec_other"].map(recordId =>
    ({kind: "field" as const, recordId, path: `Tasks/${recordId}.md`, field: "Count", before: 1, after: 2}))}]};
  await expect(undoCollectionAutomationRuns({...space.undo([]), withRecordWrites: async () => {throw new Error("Disk full");}},
    [run], new AbortController().signal)).rejects.toThrow("Disk full");
  expect(space.records.get("rec_t")!.values.Count).toBe(2);
  expect(space.records.get("rec_other")!.values.Count).toBe(2);
});

it("records a refused field write as a failed run without completed writes", async () => {
  const space = workspace([task("rec_t", {})]);
  const store = await scratchStore();
  const dependencies = space.dependencies(store);
  dependencies.withRecordWrites = async () => { throw new Error("The engine refused this write."); };
  const signal = new AbortController().signal;
  await expect(runCollectionAutomation(dependencies, {claim: added(), automation: automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Note: saved}}]"),
    collection: {path: "Tasks", name: "Tasks"}, roster: {kind: "owner", ownerUserId: null, grants: []}, signal, stopped: signal}))
    .resolves.toMatchObject({kind: "failed", error: "The engine refused this write."});
  expect((await store.runsOf("collection:Tasks#chain", "atc_one")).runs[0]?.applied).toEqual([]);
});

it("resumes a busy field write without failing the run or duplicating it", async () => {
  const space = workspace([task("rec_t", {})]);
  const store = await scratchStore();
  const dependencies = space.dependencies(store);
  const writes = dependencies.withRecordWrites;
  const reads = dependencies.withReads;
  const input = {claim: added(), automation: automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Note: saved}}]"),
    collection: {path: "Tasks", name: "Tasks"}, roster: {kind: "owner" as const, ownerUserId: null, grants: []},
    signal: new AbortController().signal, stopped: new AbortController().signal};
  const busy = () => new DaemonRefusalError({code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff"}, undefined);
  dependencies.withReads = async () => { throw busy(); };
  await expect(runCollectionAutomation(dependencies, input)).resolves.toEqual({kind: "wait", reason: "busy"});
  dependencies.withReads = reads;
  dependencies.withRecordWrites = async () => { throw busy(); };
  await expect(runCollectionAutomation(dependencies, input)).resolves.toEqual({kind: "wait", reason: "busy"});
  const pending = (await store.runsOf("collection:Tasks#chain", "atc_one")).runs[0]!;
  expect(pending.applied).toEqual([]);
  expect(pending.outcome).toBeNull();
  dependencies.withRecordWrites = writes;
  await expect(runCollectionAutomation(dependencies, input)).resolves.toMatchObject({kind: "done"});
  expect((await store.runsOf("collection:Tasks#chain", "atc_one")).runs[0]!.applied).toHaveLength(1);
});

type Fault = { at: number; when: "before" | "mid" | "after" };

/**
 * A workspace's Collections in memory. `fault` stops the process at one
 * durable point: before it, after it, or for a whole save, midway, once the
 * run's progress is written and before its state is. Every write after it
 * throws, as if nothing ran after the crash. `files` are code files by path.
 */
function workspace(docs: readonly Doc[], fault: Fault | null = null, files = new Map<string, string>()) {
  const records = new Map(docs.map((doc) => [doc.id, structuredClone(doc)]));
  const metadataReads: string[] = [];
  // Each idempotency key the engine took, with what it wrote.
  const keys = new Map<string, JsonValue>();
  let events = 0;
  let dead = false;
  const durable = async <T>(work: () => Promise<T>, torn?: () => Promise<unknown>): Promise<T> => {
    if (dead) throw new Crash("The process stopped.");
    events += 1;
    if (fault?.at === events && fault.when === "before") { dead = true; throw new Crash("Stopped before."); }
    if (fault?.at === events && fault.when === "mid" && torn) { await torn(); dead = true; throw new Crash("Stopped midway."); }
    const result = await work();
    if (fault?.at === events && fault.when !== "before") { dead = true; throw new Crash("Stopped after."); }
    return result;
  };
  // What the last whole save said of the run's outcome, which a save cut short leaves in place.
  let savedOutcome: StoredRun["outcome"] = null;
  // Runs once, after the first record read that follows a Find.
  let afterFind: (() => void) | null = null;
  let found = false;
  const hooks = { afterFindRead: (change: () => void) => { afterFind = change; } };
  const summary = (path: string): CollectionSummary => ({ path, objectId: path, status: "valid", reasons: [] });
  const asRecord = (doc: Doc): CollectionRecord => ({
    id: doc.id, path: doc.path, conflicted: false,
    values: Object.entries(doc.values).map(([field, value]) => ({ field, value: value as CollectionValue, validation: { status: "untyped" }, resolvedRelations: [] })),
  });
  const reads: CollectionAutomationReads = {
    async getCollectionRecord({ collectionPath, recordId }) {
      const doc = records.get(recordId);
      if (!doc || doc.collection !== collectionPath) throw new Error(RECORD_NOT_FOUND);
      const answer = { collection: summary(collectionPath), record: asRecord(doc), history: [], nextBeforeHistoryId: null };
      if (found && afterFind) {
        afterFind();
        afterFind = null;
      }
      return answer;
    },
    async queryCollectionRecords({ collectionPath, filter, limit = 50 }) {
      found = true;
      const matched = [...records.values()].filter((doc) => doc.collection === collectionPath && (!filter ||
        (filter.operator === "equals" ? JSON.stringify(doc.values[filter.field] ?? null) === JSON.stringify(filter.value) : false)));
      const page = matched.slice(0, limit);
      const last = page.at(-1);
      return {
        collection: summary(collectionPath), records: page.map(asRecord), groups: null,
        nextCursor: matched.length > limit && last ? { sortValues: [], recordPath: last.path, recordId: last.id } : null,
      };
    },
  };
  const writes: CollectionRecordWrites = {
    setFields: ({ recordPath, fields, expectedBefore, idempotencyKeyPrefix, preserveCompletedFields }) => durable(async () => {
      const doc = [...records.values()].find((candidate) => candidate.path === recordPath);
      if (!doc) throw new Error(`${recordPath} is gone.`);
      const replaced: Record<string, unknown> = {};
      const kept: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        const key = idempotencyKeyPrefix === undefined ? null : `${idempotencyKeyPrefix}/${field}`;
        if (key !== null && keys.has(key)) {
          // A replay of a landed write: the engine answers it and writes nothing.
          if (!preserveCompletedFields && JSON.stringify(keys.get(key)) !== JSON.stringify(value)) throw new Error(`The key ${key} came back with other content.`);
          continue;
        }
        const current = doc.values[field] ?? null;
        if (expectedBefore && Object.hasOwn(expectedBefore, field) && JSON.stringify(current) !== JSON.stringify(expectedBefore[field])) {
          kept[field] = current;
          continue;
        }
        if (key !== null) keys.set(key, value as JsonValue);
        if (JSON.stringify(current) === JSON.stringify(value)) continue;
        replaced[field] = current;
        doc.values[field] = value as JsonValue;
      }
      return { replaced, kept };
    }),
    create: ({ collectionPath, name, recordId }) => durable(async () => {
      const existing = records.get(recordId);
      if (existing) return { path: existing.path, recordId };
      const doc = { id: recordId, path: `${collectionPath}/${name}.md`, collection: collectionPath, values: {} };
      records.set(recordId, doc);
      return { path: doc.path, recordId };
    }),
  };
  const guard = (store: AutomationRunStore): AutomationRunStore => ({
    ...store,
    save: (run) => durable(async () => {
      await store.save(run);
      savedOutcome = structuredClone(run.outcome);
    }, () => store.save({ ...run, outcome: savedOutcome })),
    appendStep: (run, step) => durable(() => store.appendStep(run, step)),
    appendEffect: (run, applied) => durable(() => store.appendEffect(run, applied)),
    recordCreated: (run, created) => durable(() => store.recordCreated(run, created)),
  });
  return {
    records,
    keys,
    files,
    metadataReads,
    hooks,
    events: () => events,
    restart: () => { dead = false; },
    /** Undo as a person's, with this workspace's reads and writes; `trashed` collects what it trashes. */
    undo: (trashed: string[]) => ({
      withReads: async <T>(work: (value: CollectionAutomationReads) => Promise<T>) => await work(reads),
      withRecordWrites: async <T>(_signal: AbortSignal, work: (value: CollectionRecordWrites) => Promise<T>) => await work(writes),
      collectionPathOf: (collectionId: string) => (collectionId === "Tasks" || collectionId === "Log" ? collectionId : null),
      trash: async (path: string) => {
        trashed.push(path);
        for (const [id, doc] of records) if (doc.path === path) records.delete(id);
      },
    }),
    dependencies: (store: AutomationRunStore): CollectionAutomationRunDependencies => ({
      makeDurable: async () => {},
      isButtonField: async () => true,
      withReads: async (work) => await work(reads),
      withRecordWrites: async (_signal, work) => await work(writes),
      // Each Collection's id is its name here; none moves unless a test moves it.
      collectionIdOf: (path) => (path === "Tasks" || path === "Log" ? path : null),
      collectionPathOf: (collectionId) => (collectionId === "Tasks" || collectionId === "Log" ? collectionId : null),
      targets: createAutomationTargets({
        revisionOf: () => 0,
        isCollection: (path) => path === "Tasks" || path === "Log",
        readText: async (path) => { metadataReads.push(path); return null; },
        readSchemaFields: async (path) => { metadataReads.push(`${path}/collection.yaml`); return null; },
        withHost: async () => null,
      }),
      readCode: async (path) => (files.has(path) ? { text: files.get(path)!, truncated: false } : null),
      personName: () => "Ice",
      evaluator: shared.forWorkspace("workspace"),
      store: guard(store),
      nowMs: () => 1_000,
      chat: { hasMessage: async () => false,
        directory: async () => { throw new Error("This automation sends no messages."); },
        write: async () => { throw new Error("This automation sends no messages."); },
      },
      postNotice: async () => { throw new Error("This automation notifies nobody."); },
      readMessageBody: async () => null,
      recipientVerdicts: async () => [],
    }),
  };
}

const added = (run = 1): AutomationClaim => ({
  claimId: "atc_one",
  automationId: "collection:Tasks#chain",
  trigger: { historyId: 1 },
  recordId: "rec_t",
  collectionPath: "Tasks",
  depth: 0,
  change: { kind: "added", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
  state: "running", attempts: 1, run, createdAtMs: 1_000, updatedAtMs: 0,
});

const task = (id: string, values: Record<string, JsonValue>): Doc => ({ id, path: `Tasks/${id}.md`, collection: "Tasks", values });

/**
 * Runs the claim to its end, starting it again after each crash, as the
 * engine hands a crashed claim out again under the same run.
 */
const scratchStore = async () => createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-stepwise-")));

it("Undo reverses confirmed fields and finds an unconfirmed creation only if it exists", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {A: 1}}]");
  const space = workspace([task("rec_t", { A: 1 }), task("lost", { A: 1 })]);
  const run = newRun(added(), definition, "key", 1);
  run.outcome = { state: "failed", error: "refused", run: 1, step: 1 };
  run.durableEffects = 1;
  run.applied = [
    { ordinal: 0, writes: [{ kind: "field", recordId: "rec_t", path: "Tasks/rec_t.md", field: "A", before: 0, after: 1 }] },
    { ordinal: 1, writes: [{ kind: "created", recordId: "lost", path: "Tasks/lost.md" }] },
  ];
  run.created = [{ ordinal: 1, planned: "lost", recordId: "lost", path: "Tasks/lost.md" }];
  const trashed: string[] = [];
  const result = await undoAutomationRuns(space.undo(trashed), null, { path: "Tasks", name: "Tasks" },
    async () => ({ kind: "owner", ownerUserId: null, grants: [] }), "atc_one", [run], async () => {}, new AbortController().signal);
  expect(result.undone.reverted).toBe(1);
  expect(result.undone.removed).toBe(1);
  expect(space.records.get("rec_t")?.values.A).toBe(0);
  expect(trashed).toEqual(["Tasks/lost.md"]);
});

it.each(["document", "shared"] as const)("%s Undo includes all ten crash receipts after replay stops at effect 3", async kind => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {A: 1}}]");
  for (const current of [3, 10, 99]) {
    const space = workspace([task("rec_t", { A: current })]);
    const run = newRun(added(), definition, "crash", 1);
    run.durableEffects = 3;
    run.outcome = { state: "failed", error: "reach refused", run: 1, step: 3 };
    run.applied = Array.from({ length: 10 }, (_, index) => ({ ordinal: index, writes: [{ kind: "field" as const,
      recordId: "rec_t", path: "Tasks/rec_t.md", field: "A", before: index, after: index + 1 }] }));
    const result = kind === "document" ? await undoCollectionAutomationRuns(space.undo([]), [run], new AbortController().signal)
      : await undoAutomationRuns(space.undo([]), null, { path: "Tasks", name: "Tasks" },
        async () => ({ kind: "owner", ownerUserId: null, grants: [] }), "atc_one", [run], async () => {}, new AbortController().signal);
    expect(result.undone.reverted).toBe(current === 99 ? 0 : 1);
    expect(space.records.get("rec_t")!.values.A).toBe(current === 99 ? 99 : 0);
  }
});

it.each(["document", "shared"] as const)("%s Undo restores all ten retained writes after an actual resume fails at effect 3", async kind => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [" +
    Array.from({ length: 10 }, (_, index) => `{set: {F${index}: 1}}`).join(", ") + "]");
  const values = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`F${index}`, 1]));
  const space = workspace([task("rec_t", values)]), store = await scratchStore();
  const run = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
  run.steps = Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, effects: [{ kind: "set" as const,
    target: { recordId: "rec_t", path: "Tasks/rec_t.md", collectionPath: "Tasks" }, fields: [{ field: `F${ordinal}`, before: 0, after: 1 }] }] }));
  run.applied = run.steps.map(step => ({ ordinal: step.ordinal, writes: [{ kind: "field" as const, recordId: "rec_t",
    path: "Tasks/rec_t.md", field: `F${step.ordinal}`, before: 0, after: 1 }] }));
  await store.save(run);
  const deps = space.dependencies(store);
  // The WAL retained these writes and their idempotency keys after the crash.
  const retained: CollectionRecordWrites = { create: async () => { throw Error("unexpected creation"); },
    setFields: async () => ({ replaced: {}, kept: {} }) };
  let replayed = 0;
  deps.withRecordWrites = async (signal, work) => {
    if (replayed++ === 3) throw Error("reach refused");
    return work(retained);
  };
  const signal = new AbortController().signal;
  expect(await runCollectionAutomation(deps, { claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
    roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal })).toMatchObject({ kind: "failed", error: "reach refused" });
  const saved = (await store.runsOf(added().automationId, added().claimId)).runs[0]!;
  expect(saved.durableEffects).toBe(3);
  expect(saved.applied).toHaveLength(10);
  const result = kind === "document" ? await undoCollectionAutomationRuns(space.undo([]), [saved], signal)
    : await undoAutomationRuns(space.undo([]), null, { path: "Tasks", name: "Tasks" },
      async () => ({ kind: "owner", ownerUserId: null, grants: [] }), "atc_one", [saved], async () => {}, signal);
  expect(result.undone.reverted).toBe(10);
  expect(space.records.get("rec_t")!.values).toEqual(Object.fromEntries(Object.keys(values).map(field => [field, 0])));
});

it.each(["document", "shared"] as const)("%s Undo keeps a teammate's intermediate value after a later confirmed write", async kind => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {A: Done}}]");
  for (const current of ["Doing", "Done"]) {
    const space = workspace([task("rec_t", { A: current })]);
    const earlier = newRun(added(), definition, "earlier", 1);
    earlier.applied = [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_t", path: "Tasks/rec_t.md", field: "A", before: "Todo", after: "Doing" }] }];
    const later = newRun(added(), definition, "later", 2);
    later.durableEffects = 1;
    later.applied = [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_t", path: "Tasks/rec_t.md", field: "A", before: "Doing", after: "Done" }] }];
    const signal = new AbortController().signal;
    const result = kind === "document" ? await undoCollectionAutomationRuns(space.undo([]), [earlier, later], signal)
      : await undoAutomationRuns(space.undo([]), null, { path: "Tasks", name: "Tasks" },
        async () => ({ kind: "owner", ownerUserId: null, grants: [] }), "atc_one", [earlier, later], async () => {}, signal);
    expect(result.undone.reverted).toBe(current === "Done" ? 1 : 0);
    expect(space.records.get("rec_t")!.values.A).toBe(current === "Done" ? "Todo" : "Doing");
  }
});

it("an early preparation refusal leaves crash receipts available to Undo without claiming confirmation", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {A: 1}}]");
  const space = workspace([task("rec_t", { A: 10 })]), store = await scratchStore();
  const run = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
  run.applied = Array.from({ length: 10 }, (_, index) => ({ ordinal: index, writes: [{ kind: "field" as const,
    recordId: "rec_t", path: "Tasks/rec_t.md", field: "A", before: index, after: index + 1 }] }));
  run.steps = run.applied.map((entry, index) => ({ ordinal: entry.ordinal, effects: [{ kind: "set" as const,
    target: { recordId: "rec_t", path: "Tasks/rec_t.md", collectionPath: "Tasks" }, fields: [{ field: "A", before: index, after: index + 1 }] }] }));
  await store.save(run);
  const deps = space.dependencies(store);
  deps.checkPresser = async () => { throw Error("reach refused"); };
  const signal = new AbortController().signal;
  expect(await runCollectionAutomation(deps, { claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
    roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal })).toMatchObject({ kind: "failed" });
  const saved = (await store.runsOf(added().automationId, added().claimId)).runs[0]!;
  expect(saved.durableEffects).toBe(0);
  expect((await undoCollectionAutomationRuns(space.undo([]), [saved], signal)).undone.reverted).toBe(1);
  expect(space.records.get("rec_t")!.values.A).toBe(0);
});

it("refuses a Button claim before writing when its field is no longer a Button", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: {button: Finish}\ndo: [{set: {A: 1}}]");
  const claim: AutomationClaim = { ...added(), change: { ...added().change, kind: "button", onBehalfOf: "presser" } };
  const space = workspace([task("rec_t", { A: 0 })]), store = await scratchStore();
  const checks: string[] = [];
  const deps = Object.assign(space.dependencies(store), { isButtonField: async (path: string, field: string) => {
    checks.push(`${path}/${field}`);
    return false;
  } });
  const signal = new AbortController().signal;
  const outcome = await runCollectionAutomation(deps, { claim, automation: definition, collection: { path: "Tasks", name: "Tasks" },
    roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal });
  expect({ outcome, values: space.records.get("rec_t")!.values, writes: space.keys.size }).toEqual({
    outcome: { kind: "failed", error: "Finish changed after it was pressed. Press it again.", timedOut: false },
    values: { A: 0 }, writes: 0,
  });
  expect(checks).toEqual(["Tasks/Finish"]);
  expect((await store.runsOf(claim.automationId, claim.claimId)).runs).toEqual([]);
});

it("continues a Button run with a saved step after its field stops being a Button", async () => {
  const definition = automation("id: chain\nname: Chain\nwhen: {button: Finish}\ndo: [{set: {A: 1}}, {set: {B: 2}}]");
  const claim: AutomationClaim = { ...added(), change: { ...added().change, kind: "button", onBehalfOf: "presser" } };
  const space = workspace([task("rec_t", { A: 1, B: 0 })]), store = await scratchStore();
  const run = newRun(claim, definition, `${definitionHash(definition)}-1`, 1);
  run.steps = [{ ordinal: 0, effects: [{ kind: "set", target: { recordId: "rec_t", path: "Tasks/rec_t.md", collectionPath: "Tasks" },
    fields: [{ field: "A", before: 0, after: 1 }] }] }];
  run.applied = [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_t", path: "Tasks/rec_t.md", field: "A", before: 0, after: 1 }] }];
  run.durableEffects = 1;
  await store.save(run);
  let checks = 0;
  const deps = Object.assign(space.dependencies(store), { isButtonField: async () => { checks++; return false; } });
  const signal = new AbortController().signal;
  expect(await runCollectionAutomation(deps, { claim, automation: definition, collection: { path: "Tasks", name: "Tasks" },
    roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal })).toEqual({ kind: "done" });
  expect(space.records.get("rec_t")!.values).toEqual({ A: 1, B: 2 });
  expect(checks).toBe(0);
});

it.each([true, false])("replays only recorded messages when the roster and direct-message membership changed, recorded=%s", async recorded => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{direct-message: Hello, to: [friend]}]");
  const space = workspace([task("rec_t", {})]), store = await scratchStore();
  const run = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
  run.steps = [{ ordinal: 0, effects: [{ kind: "message", effectId: "effect", messageId: "message", threadId: "thread", body: "Hello", name: "Friend",
    to: { kind: "direct-message", userId: "friend", threadId: "thread" }, channelWireId: "dm", byFormula: false }] }];
  run.applied = [{ ordinal: 0, writes: [{ kind: "message", messageId: "message", name: "Friend" }] }];
  await store.save(run);
  const roster = { kind: "owner" as const, ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: null,
    files: { paths: ["Tasks"], versionId: null, access: "edit" as const }, channel: null }] };
  const dependencies = space.dependencies(store);
  const sent: string[] = [];
  dependencies.chat = { hasMessage: async messageId => recorded && messageId === "message", directory: async () => chatDirectoryOf([], roster), write: async (_signal, effect) => { sent.push(effect.effectId); } };
  const signal = new AbortController().signal;
  const outcome = await runCollectionAutomation(dependencies, { claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" }, roster, signal, stopped: signal });
  expect(outcome.kind).toBe(recorded ? "done" : "failed");
  expect(sent).toEqual([]);
});

it.each([false, true])("checks membership before a lost message is sent and avoids duplicate fresh directory reads, resumed=%s", async resumed => {
  const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{direct-message: Hello, to: [friend]}]");
  const space = workspace([task("rec_t", {})]), store = await scratchStore();
  if (resumed) {
    const run = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
    run.steps = [{ ordinal: 0, effects: [{ kind: "message", effectId: "effect", messageId: "message", threadId: "thread", body: "Hello", name: "Ice",
      to: { kind: "direct-message", userId: "friend", threadId: "thread" }, channelWireId: "dm", byFormula: false }] }];
    run.applied = [{ ordinal: 0, writes: [{ kind: "message", messageId: "message", name: "Ice" }] }];
    await store.save(run);
  }
  const roster = { kind: "owner" as const, ownerUserId: "owner", grants: [{ grantId: "friend", recipientUserId: "friend", recipientEmail: null,
    files: null, channel: { wireId: "dm", canPost: true } }] };
  let directories = 0;
  const sent: string[] = [], dependencies = space.dependencies(store);
  dependencies.chat = { hasMessage: async () => false, directory: async () => {
    directories++;
    return chatDirectoryOf([{ id: "dm", wireId: "dm", name: "Ice", slug: "ice", kind: "dm", type: "chat", runningThreadId: "thread" }], roster);
  }, write: async (_signal, effect) => { sent.push(effect.messageId); } };
  const signal = new AbortController().signal;
  expect(await runCollectionAutomation(dependencies, { claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
    roster, signal, stopped: signal })).toMatchObject({ kind: "done" });
  expect(sent).toHaveLength(1);
  expect(directories).toBe(2);
});

it("holds an unsent resumed post that now needs Allow, but never reauthorizes an existing message", async () => {
  for (const exists of [false, true]) {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{post: Hello, group: Trip}]");
    const space = workspace([task("rec_t", {})]), store = await scratchStore();
    const run = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
    run.steps = [{ ordinal: 0, effects: [{ kind: "message", effectId: "effect", messageId: "message", threadId: "thread", body: "Hello", name: "Trip",
      to: { kind: "group", channelId: "trip", lane: "posts" }, channelWireId: "trip", byFormula: false }] }];
    run.applied = [{ ordinal: 0, writes: [{ kind: "message", messageId: "message", name: "Trip" }] }];
    await store.save(run);
    const deps = space.dependencies(store);
    let sends = 0, postChecks = 0;
    deps.chat = { hasMessage: async () => exists, directory: async () => chatDirectoryOf([], { kind: "owner", ownerUserId: null, grants: [] }),
      write: async () => { sends++; } };
    deps.checkReach = async reach => { if (reach.some(step => step.kind === "post")) { postChecks++; return true; } return false; };
    const signal = new AbortController().signal;
    expect(await runCollectionAutomation(deps, { claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal })).toMatchObject(exists ? { kind: "done" } : { kind: "wait", reason: "held" });
    expect(sends).toBe(0);
    expect(postChecks).toBe(exists ? 0 : 1);
  }
});

async function runToEnd(
  space: ReturnType<typeof workspace>,
  definition: Automation,
  onCrash: () => void = () => undefined,
  store?: AutomationRunStore,
): Promise<CollectionAutomationRunOutcome> {
  store ??= await scratchStore();
  const signal = new AbortController().signal;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const outcome = await runCollectionAutomation(space.dependencies(store), {
        claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
        roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
      });
      if (outcome.kind !== "wait") return outcome;
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      onCrash();
    }
    space.restart();
  }
  throw new Error("The run never ended.");
}

const valuesOf = (space: ReturnType<typeof workspace>) =>
  Object.fromEntries([...space.records.values()].map((doc) => [doc.collection === "Log" ? "log" : doc.id, doc.values]));

function timedDependencies(space: ReturnType<typeof workspace>, store: AutomationRunStore): CollectionAutomationRunDependencies {
  const base = space.dependencies(store);
  let now = 1_000;
  return {
    ...base,
    nowMs: () => now,
    withReads: (work) => base.withReads((reads) => work({
      ...reads,
      getCollectionRecord: async (input) => { now += 3; return reads.getCollectionRecord(input); },
      queryCollectionRecords: async (input) => { now += 11; return reads.queryCollectionRecords(input); },
    })),
    withRecordWrites: (signal, work) => base.withRecordWrites(signal, (writes) => work({
      ...writes,
      setFields: async (input) => { now += 17; return writes.setFields(input); },
    })),
    evaluator: {
      ...base.evaluator,
      evaluate: async (...args) => { now += 7; return base.evaluator.evaluate(...args); },
    },
    store: {
      ...base.store,
      save: async (run) => { now += 100; await base.store.save(run); },
      appendStep: async (run, step) => { now += 100; await base.store.appendStep(run, step); },
      appendEffect: async (run, effect) => { now += 100; await base.store.appendEffect(run, effect); },
    },
  };
}

describe("run stage timing", () => {
  it("saves read, Find, formula and effect times without counting journal saves", async () => {
    const definition = automation('id: chain\nname: Chain\nwhen: record-added\ndo:\n  - find: record.Project == trigger.record.Project + ""\n    as: team\n  - set: {Count: "=record.Count + 1", Twice: "=record.Count * 2"}\n    records: team');
    const space = workspace([task("rec_t", { Project: "A", Count: 1 }), task("rec_o", { Project: "A", Count: 2 })]);
    const store = await scratchStore();
    const signal = new AbortController().signal;
    await expect(runCollectionAutomation(timedDependencies(space, store), {
      claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    })).resolves.toEqual({ kind: "done" });
    const [run] = (await store.runsOf("collection:Tasks#chain", "atc_one")).runs;
    expect(run!.steps.map(({ ordinal, findMs, planMs }) => ({ ordinal, findMs, planMs }))).toEqual([
      { ordinal: 0, findMs: 14, planMs: 7 }, { ordinal: 1, findMs: 6, planMs: 7 },
    ]);
    expect(run!.applied.map(({ writeMs, writeCount, writes }) => ({ writeMs, writeCount, fields: writes.length }))).toEqual([
      { writeMs: 20, writeCount: 1, fields: 2 }, { writeMs: 20, writeCount: 1, fields: 2 },
    ]);
    expect(run!.steps.map(({ appendMs, appendCount }) => ({ appendMs, appendCount }))).toEqual([
      { appendMs: 0, appendCount: 0 }, { appendMs: 200, appendCount: 2 },
    ]);
    // Two effect applications, plus the existing initial and final saves.
    expect(space.events()).toBe(6);
  });

  it("leaves timing missing when a Find refuses before saving a plan", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{find: 'true', as: all}, {set: {Count: 1}, records: all}]");
    const space = workspace(Array.from({ length: MAX_FOUND_RECORDS + 1 }, (_, index) => task(index === 0 ? "rec_t" : `rec_${index}`, {})));
    const store = await scratchStore();
    const signal = new AbortController().signal;
    await expect(runCollectionAutomation(timedDependencies(space, store), {
      claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    })).resolves.toMatchObject({ kind: "failed", error: expect.stringContaining("The Find in step 1 matched more than") });
    expect(await store.runsOf("collection:Tasks#chain", "atc_one")).toEqual({ runs: [], unreadable: false });
    expect(space.events()).toBe(0);
  });

  it("leaves append timing missing after a crash loses a durable effect's measurement", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{find: 'true', as: all}, {set: {Count: 1}, records: all}]");
    const space = workspace([task("rec_t", {}), task("rec_o", {})]);
    const store = await scratchStore();
    const signal = new AbortController().signal;
    const input = { claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner" as const, ownerUserId: null, grants: [] }, signal, stopped: signal };
    const dependencies = timedDependencies(space, store);
    const appendEffect = dependencies.store.appendEffect;
    dependencies.store.appendEffect = async (run, effect) => {
      await appendEffect(run, effect);
      throw new Crash();
    };
    await expect(runCollectionAutomation(dependencies, input)).rejects.toThrow(Crash);
    await expect(runCollectionAutomation(timedDependencies(space, store), input)).resolves.toEqual({ kind: "done" });
    const [run] = (await store.runsOf("collection:Tasks#chain", "atc_one")).runs;
    expect(run!.applied).toHaveLength(2);
    expect(run!.steps[1]!.appendMs).toBeUndefined();
    expect(run!.steps[1]!.appendCount).toBeUndefined();
  });

  it("keeps saved stage times when a later step exceeds the write limit", async () => {
    const fields = Array.from({ length: 5 }, (_, index) => `F${index}: 1`).join(", ");
    const definition = automation(`id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Early: 1}}, {find: 'true', as: all}, {set: {${fields}}, records: all}]`);
    const space = workspace(Array.from({ length: 45 }, (_, index) => task(index === 0 ? "rec_t" : `rec_${index}`, {})));
    const store = await scratchStore();
    const signal = new AbortController().signal;
    await expect(runCollectionAutomation(timedDependencies(space, store), {
      claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    })).resolves.toMatchObject({ kind: "failed", error: expect.stringContaining("more than 200 fields") });
    const [run] = (await store.runsOf("collection:Tasks#chain", "atc_one")).runs;
    expect(run!.steps.map(({ ordinal, findMs, planMs }) => ({ ordinal, findMs, planMs }))).toEqual([
      { ordinal: 0, findMs: 3, planMs: 0 }, { ordinal: 1, findMs: 14, planMs: 0 },
    ]);
    expect(run!.applied).toMatchObject([{ ordinal: 0, writeMs: 20, writeCount: 1 }]);
    expect(space.records.get("rec_1")!.values).toEqual({});
    expect(space.events()).toBe(5);
  });
});

describe("a stepwise run", () => {
  it("resolves each destination once while ten later steps reread a full Find", async () => {
    const space = workspace([task("rec_t", {}), ...Array.from({ length: MAX_FOUND_RECORDS }, (_, index) => ({
      id: `log_${index}`, path: `Log/${index}.md`, collection: "Log", values: { Count: index },
    }))]);
    const plan = automation("id: chain\nname: Chain\nwhen: record-added\ndo:\n  - find: 'true'\n    collection: Log\n    as: found\n" +
      Array.from({ length: 10 }, () => "  - run: 'return { output: ctx.found.length };'").join("\n"));
    await expect(runToEnd(space, plan)).resolves.toEqual({ kind: "done" });
    expect(space.metadataReads.sort()).toEqual(["Log/collection.yaml", "Log/dataset.json", "Tasks/collection.yaml", "Tasks/dataset.json"]);
  });

  it("rechecks a destination at effect time after caching its planning resolution", async () => {
    const space = workspace([task("rec_t", { Count: 1 })]);
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-target-recheck-")));
    const dependencies = space.dependencies(store);
    let resolutions = 0;
    const signal = new AbortController().signal;
    const outcome = await runCollectionAutomation({ ...dependencies, targets: { resolve: async (path) => {
      resolutions += 1;
      return resolutions === 1 ? await dependencies.targets.resolve(path)
        : { kind: "problem", code: "descriptor-mismatch", problem: "The destination was replaced." };
    } } }, {
      claim: added(), automation: automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}]"),
      collection: { path: "Tasks", name: "Tasks" }, roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    });
    expect(outcome).toMatchObject({ kind: "failed", error: "The destination was replaced." });
    expect(resolutions).toBe(2);
    expect(space.records.get("rec_t")!.values.Count).toBe(1);
  });

  it("refuses a dataset destination with no approved operation before reading records", async () => {
    const space = workspace([task("rec_t", {})]);
    const store = createAutomationRunStore(testStoreFolder(await createTestScratch("dohc-document-target-")));
    const dependencies = space.dependencies(store);
    const definition = automation("id: donate\nname: Donate\nwhen: record-added\ndo:\n  - add-record: {Amount: 5}\n    collection: Log");
    const signal = new AbortController().signal;
    const outcome = await runCollectionAutomation({ ...dependencies,
      withReads: async () => { throw new Error("Must not read records"); },
      targets: { resolve: async (path) => path === "Log" ? {
        kind: "dataset", collection: { path: "Log", name: "Log" }, generated: true, grants: { workspaceId: "workspace", grants: [] },
        approved: { datasetId: "log", revision: 1, revisionSha256: "a".repeat(64), definitionSha256: "b".repeat(64), schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64),
          definition: { formatVersion: 1, datasetId: "log", name: "Log", schemaPath: "Log/schema.sql", operationsPath: "Log/operations.ts", tables: [], operations: [] } },
      } : await dependencies.targets.resolve(path) },
    }, {
      claim: { ...added(), automationId: "collection:Tasks#donate" }, automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    });
    expect(outcome).toMatchObject({ kind: "failed", error: "Log has no approved way to add records with Amount." });
    expect(space.keys.size).toBe(0);
  });

  it("gives each step what the steps before it wrote, and a Set on found records their values as it starts", async () => {
    const definition = automation([
      "id: chain", "name: Chain", "when: record-added", "do:",
      "  - set: {Count: '=record.Count + 1'}",
      "  - set: {Twice: '=record.Count * 2'}",
      "  - find: record.Project == trigger.record.Project", "    as: team",
      "  - set: {Count: '=record.Count + 10'}", "    records: team",
      "  - set: {Counts: '=team.map((member) => member.Count).join(\",\")'}",
    ].join("\n"));
    const space = workspace([task("rec_t", { Project: "A", Count: 1 }), task("rec_o", { Project: "A", Count: 5 }), task("rec_x", { Project: "B", Count: 0 })]);
    await expect(runToEnd(space, definition)).resolves.toEqual({ kind: "done" });
    expect(valuesOf(space)).toEqual({
      rec_t: { Project: "A", Count: 12, Twice: 4, Counts: "12,15" },
      rec_o: { Project: "A", Count: 15 },
      rec_x: { Project: "B", Count: 0 },
    });
  });

  it("finds the records earlier steps moved into a Find's condition, and not those they moved out", async () => {
    const definition = automation([
      "id: chain", "name: Chain", "when: record-added", "do:",
      "  - set: {Status: Doing}",
      "  - find: record.Status == \"Doing\"", "    as: doing",
      "  - set: {Status: Done}", "    records: doing",
      "  - find: record.Status == \"Doing\"", "    as: still",
      "  - set: {Moved: '=doing.length', Left: '=still.length'}",
    ].join("\n"));
    const space = workspace([task("rec_t", { Status: "Todo" }), task("rec_o", { Status: "Doing" })]);
    await expect(runToEnd(space, definition)).resolves.toEqual({ kind: "done" });
    expect(valuesOf(space)).toEqual({ rec_t: { Status: "Done", Moved: 2, Left: 0 }, rec_o: { Status: "Done" } });
  });

  it("gives later steps an added record's id and fields, and a later Find finds it", async () => {
    const definition = automation([
      "id: chain", "name: Chain", "when: record-added", "do:",
      "  - add-record: {Title: Hello, Owner: '=record.Owner'}", "    collection: Log", "    as: note",
      "  - set: {Note: '=note.Title + \" \" + note.Owner', NoteId: '=note.id'}",
      "  - set: {Seen: true}", "    records: note",
      "  - find: record.Seen == true", "    collection: Log", "    as: seen",
      "  - set: {Found: '=seen.length'}",
    ].join("\n"));
    const space = workspace([task("rec_t", { Owner: "ana" })]);
    await expect(runToEnd(space, definition)).resolves.toEqual({ kind: "done" });
    const log = [...space.records.values()].find((doc) => doc.collection === "Log")!;
    expect(log.values).toEqual({ Title: "Hello", Owner: "ana", Seen: true });
    expect(space.records.get("rec_t")!.values).toEqual({ Owner: "ana", Note: "Hello ana", NoteId: log.id, Found: 1 });
  });

  it("runs only the branch each condition takes, reading what the steps before it wrote", async () => {
    const definition = automation([
      "id: chain", "name: Chain", "when: record-added", "do:",
      "  - set: {Count: 7}",
      "  - if: record.Count > 5", "    do:",
      "      - if: record.Count > 6", "        do: [{set: {Size: huge}}]", "        otherwise: [{set: {Size: big}}]",
      "    otherwise: [{set: {Size: small}}]",
    ].join("\n"));
    const space = workspace([task("rec_t", { Count: 1 })]);
    await expect(runToEnd(space, definition)).resolves.toEqual({ kind: "done" });
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 7, Size: "huge" });
  });

  it("fails clearly when a step reads a result a later step makes, or one from a branch that did not run, after the steps before it landed", async () => {
    const forward = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {A: 1}}, {set: {X: '=later.length'}}, {find: 'true', as: later}]");
    const space = workspace([task("rec_t", {})]);
    const store = await scratchStore();
    await expect(runToEnd(space, forward, undefined, store)).resolves.toEqual({
      kind: "failed", error: 'The formula for "X" in step 2 failed. ReferenceError: later is step 3\'s result, and step 3 comes after step 2.', timedOut: false,
    });
    // What landed before the failure stays, and the run names the step it failed at.
    expect(space.records.get("rec_t")!.values).toEqual({ A: 1 });
    expect((await store.runsOf("collection:Tasks#chain", "atc_one")).runs[0]?.outcome).toMatchObject({ state: "failed", step: 1 });
    const untaken = automation("id: chain\nname: Chain\nwhen: record-added\ndo:\n  - if: 'false'\n    do: [{find: 'true', as: found}]\n  - set: {X: '=found.length'}");
    await expect(runToEnd(workspace([task("rec_t", {})]), untaken)).resolves.toEqual({
      kind: "failed", error: 'The formula for "X" in step 3 failed. ReferenceError: found is step 2\'s result, and step 2 did not run.', timedOut: false,
    });
  });

  it("fails code that reads a result a later step makes, instead of reading nothing", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{run: 'return { set: { X: ctx.later ?? 0 } }'}, {find: 'true', as: later}]");
    await expect(runToEnd(workspace([task("rec_t", {})]), definition)).resolves.toEqual({
      kind: "failed", error: "The code in step 1 failed. ReferenceError: later is step 2's result, and step 2 comes after step 1.", timedOut: false,
    });
  });

  it("reads one version of a record in one step, however many ways the step reads it", async () => {
    const definition = automation([
      "id: chain", "name: Chain", "when: record-added", "do:",
      "  - find: record.Project == \"A\"", "    as: team",
      "  - set: {Seen: '=trigger.record.Count + \"/\" + team[0].Count'}",
    ].join("\n"));
    const space = workspace([task("rec_t", { Project: "A", Count: 5 })]);
    // Someone changes the record just after the second step read it as the trigger record.
    space.hooks.afterFindRead(() => { space.records.get("rec_t")!.values.Count = 6; });
    await expect(runToEnd(space, definition)).resolves.toEqual({ kind: "done" });
    expect(space.records.get("rec_t")!.values).toMatchObject({ Seen: "5/5" });
  });

  it("keeps a change someone made after a step read the record, so a write that lands proves what it replaced", async () => {
    const definition = automation([
      "id: chain", "name: Chain", "when: record-added", "do:",
      "  - find: record.Project == \"A\"", "    as: team",
      "  - set: {Count: '=record.Count + 1'}",
    ].join("\n"));
    const space = workspace([task("rec_t", { Project: "A", Count: 1 })]);
    const store = await scratchStore();
    // Someone sets Count just after the second step read the record.
    space.hooks.afterFindRead(() => { space.records.get("rec_t")!.values.Count = 10; });
    await expect(runToEnd(space, definition, undefined, store)).resolves.toEqual({ kind: "done" });
    expect(space.records.get("rec_t")!.values.Count).toBe(10);
    const [run] = (await store.runsOf("collection:Tasks#chain", "atc_one")).runs;
    expect(run!.applied.flatMap(({ writes }) => writes)).toEqual([
      { kind: "kept", recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", planned: 2, current: 10 },
    ]);
  });

  it("checks Only if once, so a step that changes what it reads never skips the rest of the run", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\nif: record.Status != \"Done\"\ndo: [{set: {Status: Done}}, {set: {After: '=record.Status'}}]");
    const space = workspace([task("rec_t", { Status: "Todo" })]);
    await expect(runToEnd(space, definition)).resolves.toEqual({ kind: "done" });
    expect(space.records.get("rec_t")!.values).toEqual({ Status: "Done", After: "Done" });
  });

  it("refuses a step over the run's field limit before it writes, and keeps what earlier steps wrote", async () => {
    const fields = Array.from({ length: 5 }, (_, index) => `F${index}: 1`).join(", ");
    const definition = automation(`id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Early: 1}}, {find: 'true', as: all}, {set: {${fields}}, records: all}]`);
    const space = workspace(Array.from({ length: 45 }, (_, index) => task(index === 0 ? "rec_t" : `rec_${index}`, {})));
    await expect(runToEnd(space, definition)).resolves.toEqual({
      kind: "failed", error: "Step 3 would make this run change more than 200 fields. Narrow its Find steps, or split it into smaller automations.", timedOut: false,
    });
    expect(space.records.get("rec_t")!.values).toEqual({ Early: 1 });
    expect(space.records.get("rec_1")!.values).toEqual({});
  });
});

describe("a stepwise run that stops", () => {
  const definition = automation([
    "id: chain", "name: Chain", "when: record-added", "do:",
    "  - set: {Count: '=record.Count + 1'}",
    "  - add-record: {Title: '=\"Log \" + record.Count'}", "    collection: Log", "    as: log",
    "  - set: {Note: '=log.Title'}", "    records: log",
    "  - find: record.Project == trigger.record.Project", "    as: team",
    "  - set: {Seen: '=record.Count'}", "    records: team",
    "  - if: team.length > 1", "    do: [{set: {Big: true}}]",
  ].join("\n"));
  const docs = [task("rec_t", { Project: "A", Count: 1 }), task("rec_o", { Project: "A", Count: 5 }), task("rec_x", { Project: "B", Count: 0 })];

  it("lands a saved code step's changes and output after its file is gone", async () => {
    const code = "return { records: [{ action: 'change', collection: 'Tasks', id: 'rec_a', fields: { X: 1 } }, { action: 'change', collection: 'Tasks', id: 'rec_b', fields: { X: 2 } }], output: 7 };";
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{run-file: two.js, as: out}, {set: {Out: '=out'}}]");
    // The run stops once the code step is saved and its first change landed.
    const space = workspace([task("rec_t", {}), task("rec_a", {}), task("rec_b", {})], { at: 2, when: "after" }, new Map([["Tasks/two.js", code]]));
    await expect(runToEnd(space, definition, () => space.files.clear())).resolves.toEqual({ kind: "done" });
    expect(valuesOf(space)).toEqual({ rec_t: { Out: 7 }, rec_a: { X: 1 }, rec_b: { X: 2 } });
  });

  it("finishes with the same writes under the same keys, once, whichever durable point it stopped at", async () => {
    const clean = workspace(docs);
    await expect(runToEnd(clean, definition)).resolves.toEqual({ kind: "done" });
    const expected = valuesOf(clean);
    expect(expected).toMatchObject({ rec_t: { Count: 2, Seen: 2, Big: true }, rec_o: { Seen: 5 }, log: { Title: "Log 2", Note: "Log 2" } });
    const points = clean.events();
    expect(points).toBeGreaterThan(8);
    for (let at = 1; at <= points; at += 1) {
      for (const when of ["before", "mid", "after"] as const) {
        const space = workspace(docs, { at, when });
        await expect(runToEnd(space, definition), `${when} ${at}`).resolves.toEqual({ kind: "done" });
        // One increment, one added record, and each key wrote what the clean run's did.
        expect(valuesOf(space), `${when} ${at}`).toEqual(expected);
        expect([...space.records.values()].filter((doc) => doc.collection === "Log"), `${when} ${at}`).toHaveLength(1);
        expect(space.keys, `${when} ${at}`).toEqual(clean.keys);
      }
    }
    // 300s: it replays the whole run three ways at every durable point. On a
    // Windows host running three verification lanes it passed 120s, 2026-10-18.
  }, 300_000);
});

describe("a run and its Undo", () => {
  const signal = new AbortController().signal;

  it("never goes on as document writes once its Collection no longer keeps a dataset", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {A: 1}}]");
    const space = workspace([task("rec_t", {})]);
    const store = await scratchStore();
    await store.save({ ...newRun(added(), definition, `${definitionHash(definition)}-1`, 1), rules: { datasetId: "d", revision: 1, revisionSha256: "r" } });
    await expect(runToEnd(space, definition, undefined, store)).resolves.toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(space.records.get("rec_t")!.values).toEqual({});
  });

  it("undoes the change a run made just before it stopped, before recording it", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: '=record.Count + 1'}}, {set: {Seen: true}}]");
    // The step is saved, then its write lands, then the run stops before recording it.
    const space = workspace([task("rec_t", { Count: 1 })], { at: 2, when: "after" });
    const store = await scratchStore();
    await expect(runCollectionAutomation(space.dependencies(store), {
      claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    })).rejects.toThrow(Crash);
    space.restart();
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 2 });
    const { runs } = await store.runsOf("collection:Tasks#chain", "atc_one");
    expect(runs[0]!.applied).toEqual([]);
    const undone = await undoCollectionAutomationRuns(space.undo([]), runs, signal);
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 1 });
    expect(undone).toMatchObject({ undone: { reverted: 1, changedSince: 0 } });
  });

  it("undoes a recorded change whether or not the next change, which the run saved but did not record, landed", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}, {set: {Count: 3}}]");
    const write = { kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: 1, after: 2 };
    const target = { recordId: "rec_t", collectionPath: "Tasks", path: "Tasks/rec_t.md" };
    const run = {
      ...newRun(added(), definition, `${definitionHash(definition)}-1`, 1),
      steps: [
        { ordinal: 0, effects: [{ kind: "set" as const, target, fields: [{ field: "Count", before: 1, after: 2 }] }] },
        { ordinal: 1, effects: [{ kind: "set" as const, target, fields: [{ field: "Count", before: 2, after: 3 }] }] },
      ],
      applied: [{ ordinal: 0, writes: [write] }],
    };
    for (const count of [2, 3]) {
      const space = workspace([task("rec_t", { Count: count })]);
      await expect(undoCollectionAutomationRuns(space.undo([]), [run], signal), `at ${count}`).resolves.toMatchObject({ undone: { reverted: 1, changedSince: 0 } });
      expect(space.records.get("rec_t")!.values, `at ${count}`).toEqual({ Count: 1 });
    }
  });

  it("undoes an older run's unrecorded change after a newer run's recorded one", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 3}}]");
    const target = { recordId: "rec_t", collectionPath: "Tasks", path: "Tasks/rec_t.md" };
    const base = { ...newRun(added(), definition, `${definitionHash(definition)}-1`, 1), durableEffects: 1 };
    // The older run set 1 to 2 and stopped before recording it; a start-over then recorded 2 to 3.
    const older = { ...base, startedAtMs: 1, superseded: true, steps: [{ ordinal: 0, effects: [{ kind: "set" as const, target, fields: [{ field: "Count", before: 1, after: 2 }] }] }] };
    const newer = { ...base, keySeed: `${base.keySeed}-2`, startedAtMs: 2, outcome: { state: "done" as const },
      applied: [{ ordinal: 0, writes: [{ kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: 2, after: 3 }] }] };
    const space = workspace([task("rec_t", { Count: 3 })]);
    await expect(undoCollectionAutomationRuns(space.undo([]), [newer, older], signal)).resolves.toMatchObject({ undone: { reverted: 1, changedSince: 0 } });
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 1 });
  });

  it("keeps a person's change made after the runs, over every run's write, and goes on after an Undo that stopped", async () => {
    const definition = automation(["id: chain", "name: Chain", "when: record-added", "do: [{set: {Count: 3}}]"].join("\n"));
    const base = { ...newRun(added(), definition, `${definitionHash(definition)}-1`, 1), durableEffects: 1 };
    const write = (before: JsonValue, after: JsonValue) => ({ kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before, after });
    // The older run set 1 to 2; someone set 10; a start-over set 10 to 3; then a person set 2.
    const older = { ...base, startedAtMs: 1, superseded: true, applied: [{ ordinal: 0, writes: [write(1, 2)] }] };
    const newer = { ...base, keySeed: `${base.keySeed}-2`, startedAtMs: 2, outcome: { state: "done" as const }, applied: [{ ordinal: 0, writes: [write(10, 3)] }] };
    const space = workspace([task("rec_t", { Count: 2 })]);
    await expect(undoCollectionAutomationRuns(space.undo([]), [newer, older], signal)).resolves.toMatchObject({ undone: { reverted: 0, changedSince: 1 } });
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 2 });
    // A person who sets a value a run's write passed through keeps it too.
    const third = { ...base, keySeed: `${base.keySeed}-3`, startedAtMs: 3, applied: [{ ordinal: 0, writes: [write(3, 4)] }] };
    const chained = { ...newer, applied: [{ ordinal: 0, writes: [write(2, 3)] }] };
    const passedThrough = workspace([task("rec_t", { Count: 2 })]);
    await expect(undoCollectionAutomationRuns(passedThrough.undo([]), [third, chained, older], signal)).resolves.toMatchObject({ undone: { reverted: 0, changedSince: 1 } });
    expect(passedThrough.records.get("rec_t")!.values).toEqual({ Count: 2 });
    // Undo writes each field once, straight back, so one that stopped left it where it was or where it goes.
    const stopped = workspace([task("rec_t", { Count: 1 })]);
    await expect(undoCollectionAutomationRuns(stopped.undo([]), [third, chained, older], signal)).resolves.toMatchObject({ undone: { reverted: 0, changedSince: 0 } });
    const whole = workspace([task("rec_t", { Count: 4 })]);
    await expect(undoCollectionAutomationRuns(whole.undo([]), [third, chained, older], signal)).resolves.toMatchObject({ undone: { reverted: 1, changedSince: 0 } });
    expect(whole.records.get("rec_t")!.values).toEqual({ Count: 1 });
  });

  it("trashes a record a run added just before it stopped, before recording it", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{add-record: {Title: Hi}, collection: Log}]");
    // The step is saved, then the record is added, then the run stops before recording it.
    const space = workspace([task("rec_t", {})], { at: 2, when: "after" });
    const store = await scratchStore();
    await expect(runCollectionAutomation(space.dependencies(store), {
      claim: added(), automation: definition, collection: { path: "Tasks", name: "Tasks" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal,
    })).rejects.toThrow(Crash);
    space.restart();
    const { runs } = await store.runsOf("collection:Tasks#chain", "atc_one");
    expect(runs[0]!.created).toEqual([]);
    const trashed: string[] = [];
    await expect(undoCollectionAutomationRuns(space.undo(trashed), runs, signal)).resolves.toMatchObject({ undone: { removed: 1 } });
    expect(trashed).toEqual([expect.stringMatching(/^Log\/chain-/u)]);
  });

  it("puts back a person's change made between two steps that set the same field, not what the field held first", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 2}}, {set: {Count: 11}}]");
    const space = workspace([task("rec_t", { Count: 11 })]);
    const write = (before: JsonValue, after: JsonValue) => ({ kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before, after });
    const run = {
      ...newRun(added(), definition, `${definitionHash(definition)}-1`, 1),
      outcome: { state: "done" as const },
      // Step 1 set 1 to 2; a person then set 10; step 2 set 10 to 11.
      applied: [{ ordinal: 0, writes: [write(1, 2)] }, { ordinal: 1, writes: [write(10, 11)] }],
    };
    await undoCollectionAutomationRuns(space.undo([]), [run], signal);
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 10 });
  });
});

describe("a saved run's Collections", () => {
  function savedRun(): StoredRun {
    const definition = automation(["id: bump", "name: Bump", "when: record-added", "do: [{set: {Done: true}}]"].join("\n"));
    return {
      ...newRun({ automationId: "collection:object-tasks#bump", claimId: "atc_1" }, definition, "hash-1", 1),
      steps: [
        { ordinal: 0, effects: [{ kind: "set", target: { recordId: "rec_a", collectionPath: "Tasks", path: "Tasks/a.md" }, fields: [] }] },
        { ordinal: 1, effects: [{ kind: "add", collectionPath: "Log", recordId: "rec_b", name: "b", fields: [] }] },
        { ordinal: 2, effects: [], output: { kind: "find", records: [{ id: "rec_c", path: "Tasks/c.md" }] } },
      ],
      collections: [{ collectionId: "object-tasks", path: "Tasks" }, { collectionId: "object-log", path: "Log" }],
      applied: [{ ordinal: 0, writes: [{ kind: "field", recordId: "rec_a", path: "Tasks/a.md", field: "Count", before: 1, after: 2 }] }],
      created: [{ ordinal: 1, planned: "rec_b", recordId: "rec_b", path: "Log/b.md" }],
    };
  }

  it("move with their ids: the saved steps, what landed, and the records it added", () => {
    const run = savedRun();
    const where = new Map([["object-tasks", "Trip/Tasks"], ["object-log", "Log"]]);
    expect(rebaseRun(run, (id) => where.get(id) ?? null)).toEqual({ moved: true, lost: false });
    expect(run.collections).toEqual([{ collectionId: "object-tasks", path: "Trip/Tasks" }, { collectionId: "object-log", path: "Log" }]);
    expect(run.steps[0]?.effects[0]).toMatchObject({ target: { collectionPath: "Trip/Tasks", path: "Trip/Tasks/a.md" } });
    expect(run.steps[1]?.effects[0]).toMatchObject({ collectionPath: "Log" });
    expect(run.steps[2]?.output).toEqual({ kind: "find", records: [{ id: "rec_c", path: "Trip/Tasks/c.md" }] });
    expect(run.applied[0]?.writes[0]).toMatchObject({ path: "Trip/Tasks/a.md" });
    expect(run.created[0]).toMatchObject({ path: "Log/b.md" });
    // Where they are already, nothing moves.
    expect(rebaseRun(run, (id) => where.get(id) ?? null)).toEqual({ moved: false, lost: false });
  });

  it("names a Collection that is gone, and leaves its paths", () => {
    const run = savedRun();
    expect(rebaseRun(run, (id) => (id === "object-tasks" ? "Tasks" : null))).toEqual({ moved: false, lost: true });
    expect(run.steps[1]?.effects[0]).toMatchObject({ collectionPath: "Log" });
  });

  it("names each Collection a step writes as the run saves the step", async () => {
    const definition = automation(["id: chain", "name: Chain", "when: record-added", "do: [{set: {A: 1}}, {add-record: {Title: Hi}, collection: Log}]"].join("\n"));
    const store = await scratchStore();
    await expect(runToEnd(workspace([task("rec_t", {})]), definition, undefined, store)).resolves.toEqual({ kind: "done" });
    const [run] = (await store.runsOf("collection:Tasks#chain", "atc_one")).runs;
    expect(run!.collections).toEqual([{ collectionId: "Tasks", path: "Tasks" }, { collectionId: "Log", path: "Log" }]);
    expect(run!.finishedAtMs).toBe(1_000);
  });
});


it("skips the engine barrier when planned fields already hold their value", async () => {
  const space = workspace([task("rec_t", { Note: "saved" })]);
  const store = await scratchStore();
  const dependencies = space.dependencies(store);
  let barriers = 0;
  dependencies.makeDurable = async () => { barriers++; };
  const signal = new AbortController().signal;
  await expect(runCollectionAutomation(dependencies, { claim: added(),
    automation: automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Note: saved}}]"),
    collection: { path: "Tasks", name: "Tasks" }, roster: {kind: "owner", ownerUserId: null, grants: []}, signal, stopped: signal }))
    .resolves.toEqual({ kind: "done" });
  expect(barriers).toBe(0);
});

// Exercise the actual coordinator, so saved completion also proves replay exclusion.
describe("automation usage", () => {
  const cases = [
    { id: "collection.record.edit", steps: "[{set: {Count: 2}}, {set: {Count: 3}}]" },
    { id: "collection.record.create", steps: "[{add-record: {Title: One}, collection: Log}, {add-record: {Title: Two}, collection: Log}]" },
    { id: "chat.post", steps: "[{post: Hello, group: Trip}, {post: Again, group: Trip}]" },
    { id: "chat.reply", steps: "[{direct-message: Hello, to: [friend]}, {direct-message: Again, to: [friend]}]" },
  ];
  it.each(cases)("counts $id once after success, excluding refusal, failure and completed replay", async ({ id, steps }) => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: " + steps);
    const space = workspace([task("rec_t", { Count: 1 })]), store = await scratchStore();
    const roster = { kind: "owner" as const, ownerUserId: "owner", grants: [{ grantId: "friend", recipientUserId: "friend", recipientEmail: null,
      files: null, channel: { wireId: "dm", canPost: true } }] };
    const dependencies = space.dependencies(store);
    const calls: Array<{ capabilityId: string; door: string }> = [];
    const observed = { ...dependencies, onUsageSuccess: (pair: { capabilityId: string; door: string }) => { calls.push(pair); } };
    let problem: string | null = "refused";
    observed.withRecordWrites = async (signal, work) => {
      if (problem) throw Error(problem);
      return dependencies.withRecordWrites(signal, work);
    };
    observed.chat = { hasMessage: async () => false,
      directory: async () => chatDirectoryOf([
        { id: "trip", wireId: "trip", name: "Trip", slug: "trip", kind: "channel", type: "posts", runningThreadId: null },
        { id: "dm", wireId: "dm", name: "Friend", slug: "friend", kind: "dm", type: "chat", runningThreadId: "thread" },
      ], roster), write: async () => { if (problem) throw Error(problem); } };
    const signal = new AbortController().signal;
    const run = (attempt: number) => runCollectionAutomation(observed, { claim: added(attempt), automation: definition,
      collection: { path: "Tasks", name: "Tasks" }, roster, signal, stopped: signal });
    expect(await run(1)).toMatchObject({ kind: "failed" });
    expect(calls).toEqual([]);
    problem = "write failed";
    expect(await run(2)).toMatchObject({ kind: "failed" });
    expect(calls).toEqual([]);
    problem = null;
    expect(await run(3)).toEqual({ kind: "done" });
    expect(calls).toEqual([{ capabilityId: id, door: "automation" }]);
    // Restarted dispatcher sees the saved outcome instead of invoking an action.
    expect(await run(3)).toEqual({ kind: "done" });
    expect(await run(4)).toEqual({ kind: "done" });
    expect(calls).toEqual([{ capabilityId: id, door: "automation" }]);
  });

  it("does not count Find, unchanged fields, or a partial run, but counts a later completed change", async () => {
    const space = workspace([task("rec_t", { Count: 1 })]), store = await scratchStore();
    const calls: Array<{ capabilityId: string; door: string }> = [];
    const dependencies = { ...space.dependencies(store), onUsageSuccess: (pair: { capabilityId: string; door: string }) => { calls.push(pair); } };
    const signal = new AbortController().signal;
    const run = (steps: string, claimId: string) => runCollectionAutomation(dependencies, {
      claim: { ...added(), claimId }, automation: automation("id: chain\nname: Chain\nwhen: record-added\ndo: " + steps),
      collection: { path: "Tasks", name: "Tasks" }, roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: signal });
    expect(await run("[{find: 'true', collection: Tasks, as: found}, {set: {Count: 1}}]", "unchanged")).toEqual({ kind: "done" });
    expect(calls).toEqual([]);
    expect(await run("[{set: {Count: 2}}, {run-file: absent.js}]", "partial")).toMatchObject({ kind: "failed" });
    expect(calls).toEqual([]);
    expect(await run("[{set: {Count: 3}}]", "success")).toEqual({ kind: "done" });
    expect(calls).toEqual([{ capabilityId: "collection.record.edit", door: "automation" }]);
  });
});
