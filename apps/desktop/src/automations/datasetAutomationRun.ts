import { isDeepStrictEqual } from "node:util";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { JsonObject, JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetAutomationClaim } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetDefinition, DatasetOperation, DatasetRevision, DatasetTable } from "@dohc/security-contract/dataset";
import type { Automation } from "@dohc/workspace-contracts/automations";
import type { LocalDatasetAutomationContext, LocalDatasetInvocation } from "../workspaces/localDatasetHost";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import {
  definitionHash,
  evaluationRequest,
  MAX_FOUND_RECORDS,
  planRun,
  triggerMatches,
  type PlannedStep,
  type RunInputs,
  type RunRecord,
} from "./automationPlan";
import { checkAutomationReach, type ReachCollection, type ReachDatasetGrants, type ReachRoster } from "./automationReach";
import { RUN_PLAN_BUDGET_BYTES, type AutomationRunStore, type DatasetEffect, type DatasetReplan, type RunWrite, type StoredRun, type StoredStep } from "./automationRunStore";
import { DEADLINE_ERROR, newRun, savedRunOf, type CollectionAutomationRunOutcome } from "./collectionAutomationRun";
import { datasetEffectKey, datasetReachSteps, datasetRecordKey, datasetRunClaim, datasetStepsOf, type DatasetRecordId, type DatasetSteps } from "./datasetAutomationPlan";

// One run of one dataset claim, as runCollectionAutomation runs an engine
// claim: check reach, read through the dataset's approved reads, evaluate
// once, save the plan, then apply each effect through an approved edit or
// create, saving each as it lands.
//
// Each effect has its own idempotency key, so a resumed effect that already
// landed replays its receipt instead of landing twice. An edit carries the
// version its plan read. When someone changed the record since, the edit
// is refused as stale, and the run reads the record again: a field that
// already holds its planned value is done, a field still at its planned
// before value is sent again under a new key at the new version, and a
// field someone changed to anything else keeps their change.

export const RULES_CHANGED_ERROR = "Collection rules changed after this run started.";
export const ACCESS_NARROWED_ERROR = "Someone who edits this automation can no longer read a field it used, so dohc stopped the rest of this run.";
// A record that keeps changing under the run stops it rather than loop.
const MAX_REPLANS = 5;
// Reads keep no receipt, so they share one key.
const READ_KEY = "automation-read";

/** The dataset host as a run uses it. LocalDatasetHost's `automations` satisfies it. */
export interface DatasetRunHost {
  context(input: { automationId: string; claimId: string; depth: number }): LocalDatasetAutomationContext;
  invoke(context: LocalDatasetAutomationContext, input: LocalDatasetInvocation): Promise<DatasetInvocationResult>;
  revision(datasetId: string): DatasetRevision;
  generated(datasetId: string): boolean;
  resolves(reference: { datasetId: string; revision: number; revisionSha256: string }): boolean;
  dataGrants(datasetId: string): ReachDatasetGrants;
}

export interface DatasetAutomationRunDependencies {
  /** The dataset host; resolves null when it is not open. */
  withHost<T>(work: (host: DatasetRunHost) => T | Promise<T>): Promise<T | null>;
  evaluator: AutomationFormulaEvaluator;
  store: AutomationRunStore;
  nowMs(): number;
}

export interface DatasetAutomationRunInput {
  claim: DatasetAutomationClaim;
  automation: Automation;
  /** The Collection whose folder holds the dataset. */
  collection: ReachCollection;
  roster: Exclude<ReachRoster, { kind: "unknown" }>;
  /** Aborts at the run's deadline, or when the executor stops. Every invocation receives it. */
  signal: AbortSignal;
  /** Aborts when the executor stops: the run waits instead of failing. */
  stopped: AbortSignal;
}

const failed = (error: string, timedOut = false): CollectionAutomationRunOutcome => ({ kind: "failed", error, timedOut });
const stopped: CollectionAutomationRunOutcome = { kind: "wait", reason: "stopped" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Rules = { datasetId: string; revision: number; revisionSha256: string };
/** A record as a generated read returns it: its id, version, and values by field id. */
export type DatasetRow = { id: DatasetRecordId; version: number; values: Record<string, JsonValue> };
type Row = DatasetRow;

/** Rows from a generated read's result. */
function rowsOf(result: DatasetInvocationResult): Row[] {
  const value = result.result;
  const rows = value !== null && typeof value === "object" && !Array.isArray(value) ? value.rows : undefined;
  if (!Array.isArray(rows)) throw new Error("This Collection returned an invalid record list. Ask the owner to check its rules.");
  return rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("This Collection returned an invalid record list. Ask the owner to check its rules.");
    const { id, version, values } = row;
    if ((typeof id !== "string" && typeof id !== "number") || typeof version !== "number" ||
      values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("This Collection returned an invalid record list. Ask the owner to check its rules.");
    }
    return { id, version, values };
  });
}

/**
 * A row as planning reads it: values by field name, the id as text for
 * formulas, and the record's whole identity where a document has its path.
 */
function runRecordOf(row: Row, datasetId: string, table: DatasetTable, readable: ReadonlySet<string>): RunRecord {
  const values: JsonObject = {};
  for (const field of table.fields) {
    // Formulas see only what every editor can read.
    if (Object.hasOwn(row.values, field.fieldId) && readable.has(field.fieldId)) values[field.name] = row.values[field.fieldId] ?? null;
  }
  return { id: String(row.id), path: datasetRecordKey(datasetId, table.tableId, row.id), values };
}

/** One invocation as this run's automation, with the owner caller. */
async function invoke(
  host: DatasetRunHost,
  context: LocalDatasetAutomationContext,
  rules: Rules,
  operationId: string,
  input: JsonValue,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<DatasetInvocationResult> {
  if (!host.resolves(rules)) throw new Error(RULES_CHANGED_ERROR);
  return await host.invoke(context, { ...rules, operationId, input, idempotencyKey, signal });
}

/**
 * One record by its id, through a generated read, or null when it is gone.
 * A read that shows the primary key filters on it. Otherwise the read pages
 * by (sort value, id) in primary key order, from a cursor just before the id:
 * a whole number's predecessor, or for text the smallest id, "\u0000", which
 * starts the first page itself.
 */
function readRecord(
  host: DatasetRunHost,
  context: LocalDatasetAutomationContext,
  rules: Rules,
  read: DatasetOperation,
  table: DatasetTable,
  recordId: DatasetRecordId,
  signal: AbortSignal,
): Promise<DatasetRow | null> {
  return readDatasetRecord((operationId, input) => invoke(host, context, rules, operationId, input, READ_KEY, signal), read, table, recordId);
}

/** One record by its id through `call`, as readRecord describes. */
export async function readDatasetRecord(
  call: (operationId: string, input: JsonObject) => Promise<DatasetInvocationResult>,
  read: DatasetOperation,
  table: DatasetTable,
  recordId: DatasetRecordId,
): Promise<DatasetRow | null> {
  const key = table.fields.find((field) => field.type !== "button" && field.sqlColumn === table.primaryKey)!;
  const input: JsonObject = read.fieldIds.includes(key.fieldId) ? { limit: 1, filters: [{ fieldId: key.fieldId, value: recordId }] }
    : typeof recordId === "number" ? { limit: 1, after: { id: recordId, value: recordId - 1 } }
    : recordId === "\u0000" ? { limit: 1 }
    : { limit: 1, after: { id: "\u0000", value: recordId } };
  const [row] = rowsOf(await call(read.operationId, input));
  return row !== undefined && row.id === recordId ? row : null;
}

export async function runDatasetAutomation(
  dependencies: DatasetAutomationRunDependencies,
  input: DatasetAutomationRunInput,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, automation, collection, roster } = input;
  const saved = await savedRunOf(dependencies.store, claim, automation);
  if ("outcome" in saved) return saved.outcome;

  // Reach (ADR 0012) against the rules and data grants now, before anything
  // is read: each operation the automation can call stops the run when an
  // editor lacks it, and each field its formulas may see is hidden when an
  // editor cannot read it. The run plans and reads again under the rules
  // this checked, so an approval landing meanwhile cannot bring in a read
  // reach never saw.
  const checked = await dependencies.withHost((host) => {
    const approved = host.revision(claim.datasetId);
    return { approved, steps: datasetReachSteps(automation, collection, approved.definition, host.dataGrants(claim.datasetId)) };
  });
  if (checked === null) return { kind: "wait", reason: "engine" };
  const { approved, steps } = checked;
  const readable = new Set<string>();
  const verdicts = checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps });
  for (const [index, verdict] of verdicts.entries()) {
    const step = steps[index]!;
    if (step.kind === "dataset-field") {
      if (verdict.allowed) readable.add(step.field.fieldId);
    } else if (!verdict.allowed) {
      return failed(verdict.reason);
    }
  }

  let run = saved.current?.plan ? saved.current : null;
  // A plan's formulas saw only the fields readable when it was made. Once an
  // editor can no longer read one of them, its effects not yet sent stop;
  // what already landed stays.
  if (run !== null && (run.readableFields ?? []).some((fieldId) => !readable.has(fieldId))) return failed(ACCESS_NARROWED_ERROR);
  const keySeed = `${definitionHash(automation)}-${claim.run}`;
  if (run === null) {
    let planned: Awaited<ReturnType<typeof plan>>;
    try {
      planned = await plan(dependencies, input, keySeed, readable, approved);
    } catch (error) {
      return input.stopped.aborted ? stopped : failed(errorText(error));
    }
    if (input.stopped.aborted) return stopped;
    if (planned.kind === "stop") return planned.outcome;
    run = { ...newRun(claim, automation, keySeed, planned.steps, dependencies.nowMs()), readableFields: [...readable].sort() };
    // Every effect's record, with every field planned, must fit what the
    // store reads back.
    if (Buffer.byteLength(JSON.stringify(run)) * 2 > RUN_PLAN_BUDGET_BYTES) {
      return failed("This run would change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations.");
    }
    await dependencies.store.save(run);
  }
  const outcome = await applyPlan(dependencies, input, run, approved.definition);
  if (outcome.kind === "wait") return outcome;
  if (outcome.kind === "failed") {
    run.outcome = { state: "failed", error: outcome.error, run: claim.run };
  } else {
    run.outcome = { state: "done" };
    run.plan = null;
  }
  run.updatedAtMs = dependencies.nowMs();
  await dependencies.store.save(run);
  return outcome;
}

async function plan(
  dependencies: DatasetAutomationRunDependencies,
  input: DatasetAutomationRunInput,
  keySeed: string,
  readable: ReadonlySet<string>,
  approved: DatasetRevision,
): Promise<{ kind: "plan"; steps: StoredStep[] } | { kind: "stop"; outcome: CollectionAutomationRunOutcome }> {
  const { claim, automation, collection, signal } = input;
  const stop = (outcome: CollectionAutomationRunOutcome) => ({ kind: "stop" as const, outcome });
  const read = await dependencies.withHost(async (host) => {
    if (!host.generated(claim.datasetId)) {
      throw new Error(`${approved.definition.name}'s operations were written or changed outside dohc, so automations cannot use them yet.`);
    }
    const steps = datasetStepsOf(automation, approved.definition);
    const rules: Rules = { datasetId: claim.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
    const context = host.context({ automationId: claim.automationId, claimId: claim.claimId, depth: claim.depth + 1 });
    // Each record the plan read, by identity, with the version it read.
    const versions = new Map<string, { id: DatasetRecordId; version: number }>();
    const remember = (row: Row, table: DatasetTable) => {
      versions.set(datasetRecordKey(rules.datasetId, table.tableId, row.id), { id: row.id, version: row.version });
      return runRecordOf(row, rules.datasetId, table, readable);
    };
    let record: RunRecord | null = null;
    if (steps.triggerRead !== null && claim.fact !== null && claim.fact.kind !== "removed") {
      const row = await readRecord(host, context, rules, steps.triggerRead, steps.table, claim.fact.recordId, signal);
      // The record was removed before its automation ran.
      if (row === null) return { removed: true } as const;
      record = remember(row, steps.table);
    }
    const found = new Map<number, RunRecord[]>();
    const truncatedFinds = new Set<number>();
    for (const [ordinal, filters] of steps.finds) {
      const { operation, table } = steps.steps.get(ordinal)!;
      const fieldId = (name: string) => table.fields.find((field) => field.name === name)!.fieldId;
      const query = {
        limit: MAX_FOUND_RECORDS,
        filters: filters.map(({ field, value }) => ({
          fieldId: fieldId(field),
          value: value.kind === "literal" ? value.value : (record?.values[value.field] ?? null),
        })),
      };
      const result = await invoke(host, context, rules, operation.operationId, query, READ_KEY, signal);
      const rows = rowsOf(result);
      const page = result.result;
      if (page !== null && typeof page === "object" && !Array.isArray(page) && page.nextCursor != null) {
        // The planner refuses this Find only if its branch runs. Never bind a partial page.
        truncatedFinds.add(ordinal);
      } else {
        found.set(ordinal, rows.map((row) => remember(row, table)));
      }
    }
    return { removed: false, record, found, truncatedFinds, steps, rules, versions } as const;
  });
  if (read === null) return stop({ kind: "wait", reason: "engine" });
  if (read.removed) return stop({ kind: "skipped" });
  const inputs: RunInputs = { person: null, message: null, chat: null, automation, claim: datasetRunClaim(claim, collection.path, read.steps.table, readable), record: read.record, found: read.found, truncatedFinds: read.truncatedFinds };
  if (!triggerMatches(inputs)) return stop({ kind: "skipped" });
  const request = evaluationRequest(inputs, claim.createdAtMs);
  const results = request.formulas.length === 0 ? [] : await dependencies.evaluator.evaluate(claim.automationId, request.scope, request.formulas);
  if (results === "busy") return stop({ kind: "wait", reason: "busy" });
  const planned = planRun(inputs, request, results, { claimId: claim.claimId, hash: keySeed });
  if (planned.kind === "skip") return stop({ kind: "skipped" });
  if (planned.kind === "failed") return stop(failed(planned.error, planned.timedOut));
  return { kind: "plan", steps: datasetEffects(planned.steps, read.steps, read.rules, read.versions) };
}

/** The document-shaped plan as effects through the steps' operations. */
function datasetEffects(
  planned: readonly PlannedStep[],
  steps: DatasetSteps,
  rules: Rules,
  versions: ReadonlyMap<string, { id: DatasetRecordId; version: number }>,
): StoredStep[] {
  return planned.map(({ ordinal, effects }) => {
    const { operation, table } = steps.steps.get(ordinal)!;
    const fieldId = (name: string) => table.fields.find((field) => field.name === name)!.fieldId;
    return {
      ordinal,
      effects: effects.map((effect): DatasetEffect => {
        if (effect.kind === "add") {
          return {
            kind: "dataset-create", rules, operationId: operation.operationId, tableId: table.tableId,
            values: effect.fields.map(({ field, value }) => ({ fieldId: fieldId(field), field, value })),
          };
        }
        if (effect.kind !== "set") throw new Error("This Collection's automations cannot send chat messages. Remove chat steps from the automation.");
        let target: Extract<DatasetEffect, { kind: "dataset-edit" }>["target"];
        if ("addedBy" in effect.target) {
          target = { addedBy: effect.target.addedBy };
        } else {
          const known = versions.get(effect.target.path);
          if (known === undefined) throw new Error("dohc lost track of a record this run read.");
          target = { recordId: known.id, version: known.version };
        }
        return {
          kind: "dataset-edit", rules, operationId: operation.operationId, tableId: table.tableId, target,
          fields: effect.fields.map(({ field, before, after }) => ({ fieldId: fieldId(field), field, before, after })),
        };
      }),
    };
  });
}

async function applyPlan(
  dependencies: DatasetAutomationRunDependencies,
  input: DatasetAutomationRunInput,
  run: StoredRun,
  definition: DatasetDefinition,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, signal, automation } = input;
  const effects = (run.plan ?? []).flatMap((step) => step.effects.map((effect) => ({ ordinal: step.ordinal, effect })));
  const firstUnrecorded = run.applied.length;
  const outcome = await dependencies.withHost(async (host): Promise<CollectionAutomationRunOutcome> => {
    const context = host.context({ automationId: claim.automationId, claimId: claim.claimId, depth: claim.depth + 1 });
    for (let index = firstUnrecorded; index < effects.length; index += 1) {
      if (input.stopped.aborted) return stopped;
      if (signal.aborted) return failed(DEADLINE_ERROR, true);
      const { ordinal, effect } = effects[index]!;
      if (effect.kind !== "dataset-edit" && effect.kind !== "dataset-create") return failed("This automation's saved steps do not match this Collection. Ask the owner to check the automation.");
      let writes: RunWrite[];
      try {
        writes = await applyEffect({ dependencies, host, context, run, index, ordinal, signal, definition }, effect, automation);
      } catch (error) {
        if (input.stopped.aborted) return stopped;
        return signal.aborted ? failed(DEADLINE_ERROR, true) : failed(errorText(error));
      }
      const applied = { ordinal, writes };
      await dependencies.store.appendEffect(run, applied);
      run.applied.push(applied);
      run.updatedAtMs = dependencies.nowMs();
    }
    return { kind: "done" };
  });
  return outcome ?? (input.stopped.aborted ? stopped : { kind: "wait", reason: "engine" });
}

/**
 * Each record's version after the edits and creates this run recorded, by
 * id. An effect that wrote nothing leaves its record's version unknown; the
 * next edit then meets a stale record and reads it again.
 */
function latestVersions(run: StoredRun): Map<string, number> {
  const versions = new Map<string, number>();
  for (const { writes } of run.applied) {
    for (const write of writes) {
      if (write.kind === "dataset-edit" || write.kind === "dataset-created") {
        versions.set(datasetRecordKey(write.rules.datasetId, write.tableId, write.recordId), write.version);
      }
    }
  }
  return versions;
}

async function applyEffect(
  context: {
    dependencies: DatasetAutomationRunDependencies;
    host: DatasetRunHost;
    context: LocalDatasetAutomationContext;
    run: StoredRun;
    index: number;
    ordinal: number;
    signal: AbortSignal;
    /** The rules reach checked for this run. */
    definition: DatasetDefinition;
  },
  effect: DatasetEffect,
  automation: Automation,
): Promise<RunWrite[]> {
  const { dependencies, host, run, index, ordinal, signal } = context;
  const keyOf = (recordId: DatasetRecordId | null, replan: number) => datasetEffectKey(run.claimId, run.keySeed, ordinal, recordId, replan);
  if (effect.kind === "dataset-create") {
    const values: JsonObject = Object.fromEntries(effect.values.map(({ fieldId, value }) => [fieldId, value]));
    const result = await send(() => invoke(host, context.context, effect.rules, effect.operationId, { values }, keyOf(null, 0), signal));
    if ("refused" in result) throw new Error(result.refused.message);
    const created = result.value.result;
    const id = created !== null && typeof created === "object" && !Array.isArray(created) ? created.id : undefined;
    const version = created !== null && typeof created === "object" && !Array.isArray(created) ? created.version : undefined;
    if ((typeof id !== "string" && typeof id !== "number") || typeof version !== "number") throw new Error("This Collection did not identify the record it added. Ask the owner to check its rules.");
    return [{ kind: "dataset-created", rules: effect.rules, operationId: effect.operationId, tableId: effect.tableId, recordId: id, version }];
  }

  const recordId = "addedBy" in effect.target ? addedRecord(run, effect.target.addedBy) : effect.target.recordId;
  if (recordId === null) throw new Error("dohc cannot find the record an earlier step added.");
  const versions = latestVersions(run);
  const latest = run.replans.filter((replan) => replan.effect === index).at(-1);
  let replan = latest?.replan ?? 0;
  let version = latest?.version ?? versions.get(datasetRecordKey(effect.rules.datasetId, effect.tableId, recordId)) ?? ("version" in effect.target ? effect.target.version : 1);
  let fields = latest?.fields ?? effect.fields;
  let kept: RunWrite[] = latest?.kept ?? [];
  for (;;) {
    const values: JsonObject = Object.fromEntries(fields.map(({ fieldId, after }) => [fieldId, after]));
    const result = await send(() => invoke(host, context.context, effect.rules, effect.operationId,
      { id: recordId, expectedVersion: version, values }, keyOf(recordId, replan), signal));
    if (!("refused" in result)) {
      const landed = result.value.result;
      const prior = landed !== null && typeof landed === "object" && !Array.isArray(landed) ? landed.priorValues : undefined;
      const next = landed !== null && typeof landed === "object" && !Array.isArray(landed) ? landed.version : undefined;
      if (typeof next !== "number") throw new Error("This Collection did not return the updated record's version. Ask the owner to check its rules.");
      const priorValues = prior !== null && typeof prior === "object" && !Array.isArray(prior) ? prior : {};
      return [...kept, {
        kind: "dataset-edit", rules: effect.rules, operationId: effect.operationId, tableId: effect.tableId, recordId, version: next,
        fields: fields.map((field) => ({ ...field, before: priorValues[field.fieldId] ?? null })),
      }];
    }
    if (result.refused.code === "not_found") {
      return [...kept, { kind: "dataset-skipped", recordId, reason: "The record is no longer in the Collection." }];
    }
    if (result.refused.code !== "stale_record") throw new Error(result.refused.message);
    // Someone changed the record since the plan read it. Read it again.
    const steps = datasetStepsOf(automation, context.definition);
    const reader = steps.rereads.get(ordinal);
    const table = steps.steps.get(ordinal)!.table;
    if (reader === undefined) throw new Error(`${table.name} changed, and dohc has no approved read of it to check the record again.`);
    const row = await readRecord(host, context.context, effect.rules, reader, table, recordId, signal);
    if (row === null) return [...kept, { kind: "dataset-skipped", recordId, reason: "The record is no longer in the Collection." }];
    const remaining: typeof fields = [];
    const found: RunWrite[] = [];
    for (const field of fields) {
      const current = row.values[field.fieldId] ?? null;
      if (isDeepStrictEqual(current, field.before) && !isDeepStrictEqual(current, field.after)) remaining.push(field);
      // It already holds the planned value, or someone gave it another:
      // either way it stays as it is.
      else found.push({ kind: "dataset-kept", recordId, fieldId: field.fieldId, field: field.field, planned: field.after, current });
    }
    kept = [...kept, ...found];
    if (remaining.length === 0) return kept;
    if (replan >= MAX_REPLANS) throw new Error("The record kept changing while this automation ran. Try again.");
    replan += 1;
    version = row.version;
    fields = remaining;
    const saved: DatasetReplan = { effect: index, replan, version, fields, kept };
    // Saved before it is sent, so a resume sends this key with this content.
    await dependencies.store.recordReplan(run, saved);
    run.replans.push(saved);
  }
}

/** The record an add-record step created, from what the run recorded. */
function addedRecord(run: StoredRun, ordinal: number): DatasetRecordId | null {
  for (const applied of run.applied) {
    if (applied.ordinal !== ordinal) continue;
    for (const write of applied.writes) if (write.kind === "dataset-created") return write.recordId;
  }
  return null;
}

/** An invocation's result, or the refusal an operation answered with. */
export async function send(call: () => Promise<DatasetInvocationResult>): Promise<{ value: DatasetInvocationResult } | { refused: { code: string; message: string } }> {
  try {
    return { value: await call() };
  } catch (error) {
    if (isAppBackendRuntimeError(error)) return { refused: error.refusal };
    throw error;
  }
}
