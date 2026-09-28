import { afterAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord, CollectionSummary, CollectionValue } from "@dohc/workspace-contracts/collection";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore, type AutomationRunStore, type StoredRun } from "./automationRunStore";
import { undoCollectionAutomationRuns } from "./collectionAutomationUndo";
import { definitionHash } from "./automationPlan";
import {
  newRun,
  rebaseRun,
  RECORD_NOT_FOUND,
  RULES_CHANGED_ERROR,
  runCollectionAutomation,
  type CollectionAutomationReads,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
  type CollectionRecordWrites,
} from "./collectionAutomationRun";
import { createTestScratch, testMetadataDir } from "./testScratch";
import { createAutomationTargets } from "./automationTargets";
import { MAX_FOUND_RECORDS } from "./automationPlan";

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
    setFields: ({ recordPath, fields, expectedBefore, idempotencyKeyPrefix }) => durable(async () => {
      const doc = [...records.values()].find((candidate) => candidate.path === recordPath);
      if (!doc) throw new Error(`${recordPath} is gone.`);
      const replaced: Record<string, unknown> = {};
      const kept: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        // A person's write, such as Undo's, carries no key.
        const key = idempotencyKeyPrefix === undefined ? null : `${idempotencyKeyPrefix}/${field}`;
        if (key !== null && keys.has(key)) {
          // A replay of a landed write: the engine answers it and writes nothing.
          if (JSON.stringify(keys.get(key)) !== JSON.stringify(value)) throw new Error(`The key ${key} came back with other content.`);
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
      withReads: async (work) => await work(reads),
      withRecordWrites: async (_signal, work) => await work(writes),
      // Each Collection's id is its name here; none moves unless a test moves it.
      collectionIdOf: (path) => (path === "Tasks" || path === "Log" ? path : null),
      collectionPathOf: (collectionId) => (collectionId === "Tasks" || collectionId === "Log" ? collectionId : null),
      targets: createAutomationTargets({
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
      chat: {
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
const scratchStore = async () => createAutomationRunStore(await createTestScratch("dohc-stepwise-"), testMetadataDir);

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
    const store = createAutomationRunStore(await createTestScratch("dohc-target-recheck-"), testMetadataDir);
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

  it("still refuses an approved dataset destination before reading records", async () => {
    const space = workspace([task("rec_t", {})]);
    const store = createAutomationRunStore(await createTestScratch("dohc-document-target-"), testMetadataDir);
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
    expect(outcome).toMatchObject({ kind: "failed", error: "Automations cannot use Log yet, because its records change only through its Collection actions." });
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
  }, 120_000);
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
    expect(undone).toMatchObject({ reverted: 1, changedSince: 0 });
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
      await expect(undoCollectionAutomationRuns(space.undo([]), [run], signal), `at ${count}`).resolves.toMatchObject({ reverted: 1, changedSince: 0 });
      expect(space.records.get("rec_t")!.values, `at ${count}`).toEqual({ Count: 1 });
    }
  });

  it("undoes an older run's unrecorded change after a newer run's recorded one", async () => {
    const definition = automation("id: chain\nname: Chain\nwhen: record-added\ndo: [{set: {Count: 3}}]");
    const target = { recordId: "rec_t", collectionPath: "Tasks", path: "Tasks/rec_t.md" };
    const base = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
    // The older run set 1 to 2 and stopped before recording it; a start-over then recorded 2 to 3.
    const older = { ...base, startedAtMs: 1, superseded: true, steps: [{ ordinal: 0, effects: [{ kind: "set" as const, target, fields: [{ field: "Count", before: 1, after: 2 }] }] }] };
    const newer = { ...base, keySeed: `${base.keySeed}-2`, startedAtMs: 2, outcome: { state: "done" as const },
      applied: [{ ordinal: 0, writes: [{ kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before: 2, after: 3 }] }] };
    const space = workspace([task("rec_t", { Count: 3 })]);
    await expect(undoCollectionAutomationRuns(space.undo([]), [newer, older], signal)).resolves.toMatchObject({ reverted: 1, changedSince: 0 });
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 1 });
  });

  it("keeps a person's change made after the runs, over every run's write, and goes on after an Undo that stopped", async () => {
    const definition = automation(["id: chain", "name: Chain", "when: record-added", "do: [{set: {Count: 3}}]"].join("\n"));
    const base = newRun(added(), definition, `${definitionHash(definition)}-1`, 1);
    const write = (before: JsonValue, after: JsonValue) => ({ kind: "field" as const, recordId: "rec_t", path: "Tasks/rec_t.md", field: "Count", before, after });
    // The older run set 1 to 2; someone set 10; a start-over set 10 to 3; then a person set 2.
    const older = { ...base, startedAtMs: 1, superseded: true, applied: [{ ordinal: 0, writes: [write(1, 2)] }] };
    const newer = { ...base, keySeed: `${base.keySeed}-2`, startedAtMs: 2, outcome: { state: "done" as const }, applied: [{ ordinal: 0, writes: [write(10, 3)] }] };
    const space = workspace([task("rec_t", { Count: 2 })]);
    await expect(undoCollectionAutomationRuns(space.undo([]), [newer, older], signal)).resolves.toMatchObject({ reverted: 0, changedSince: 1 });
    expect(space.records.get("rec_t")!.values).toEqual({ Count: 2 });
    // A person who sets a value a run's write passed through keeps it too.
    const third = { ...base, keySeed: `${base.keySeed}-3`, startedAtMs: 3, applied: [{ ordinal: 0, writes: [write(3, 4)] }] };
    const chained = { ...newer, applied: [{ ordinal: 0, writes: [write(2, 3)] }] };
    const passedThrough = workspace([task("rec_t", { Count: 2 })]);
    await expect(undoCollectionAutomationRuns(passedThrough.undo([]), [third, chained, older], signal)).resolves.toMatchObject({ reverted: 0, changedSince: 1 });
    expect(passedThrough.records.get("rec_t")!.values).toEqual({ Count: 2 });
    // Undo writes each field once, straight back, so one that stopped left it where it was or where it goes.
    const stopped = workspace([task("rec_t", { Count: 1 })]);
    await expect(undoCollectionAutomationRuns(stopped.undo([]), [third, chained, older], signal)).resolves.toMatchObject({ reverted: 0, changedSince: 0 });
    const whole = workspace([task("rec_t", { Count: 4 })]);
    await expect(undoCollectionAutomationRuns(whole.undo([]), [third, chained, older], signal)).resolves.toMatchObject({ reverted: 1, changedSince: 0 });
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
    await expect(undoCollectionAutomationRuns(space.undo(trashed), runs, signal)).resolves.toMatchObject({ removed: 1 });
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
