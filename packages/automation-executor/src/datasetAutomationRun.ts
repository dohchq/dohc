import type { RunSource } from "./automationRecordBackend";
import { coordinateSourceRun } from "./automationStepRun";
import { isDeepStrictEqual } from "node:util";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type {
  JsonObject,
  JsonValue,
} from "@dohc/app-backend-runtime/automation";
import type { DatasetAutomationClaim } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetColumnFieldType, DatasetDefinition, DatasetOperation, DatasetRevision, DatasetTable } from "@dohc/security-contract/dataset";
import type { Automation } from "@dohc/workspace-contracts/automations";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { isNoticeLine, NOTICE_TARGET_FIELD_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import {
  codeRecordKey,
  codeStepOrdinals,
  definitionDigest,
  definitionHash,
  type CodeChange,
  type PlannedEffect,
  type RunClaim,
  type RunRecord,
} from "./automationPlan";
import { changedSincePressed } from "./automationButtons";

import {
  datasetFieldKey,
  type ReachCollection,
  type ReachDatasetGrants,
  type ReachRoster,
} from "./automationReach";
import type { DatasetEffect, DatasetReplan, RunWrite, StoredRun, StoredStep } from "./automationRunStore";
import {
  KEPT_CHANGING_ERROR,
  MAX_REREADS,
  unfinishedStep,
} from "./automationStepRun";
import {
  claimPerson,
  RULES_CHANGED_ERROR,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
} from "./collectionAutomationRun";
import {
  datasetButtonOf,
  datasetCodeOperation,
  datasetCodeTable,
  datasetEffectKey,
  datasetRecordKey,
  datasetRunClaim,
  datasetStepsOf,
  type DatasetRecordId,
  type DatasetRules,
  type DatasetSteps,
} from "./datasetAutomationPlan";

// One run of one dataset claim, as runCollectionAutomation runs an engine
// claim: check reach, then run the steps in order (automationStepRun.ts),
// each reading through the dataset's approved reads and landing each effect
// through an approved edit or create, saved as it lands. Posts, direct
// messages, wakes, and notices go out exactly as a document Collection's do.
//
// Each effect has its own idempotency key, so a resumed effect that already
// landed replays its receipt instead of landing twice. An edit carries the
// version its step read. When someone changed the record since, the edit
// is refused as stale, and the run reads the record again: a field that
// already holds its planned value is done, a field still at its planned
// before value is sent again under a new key at the new version, and a
// field someone changed to anything else keeps their change.
//
// A code step's changes land in the table the automation watches, or for a
// schedule or a Group message, which watch none, the dataset's only table,
// each through the approved edit or create the panel would pin for a step
// with its fields; code never runs an action. The step picks them once the
// code has run. Reach, and a presser's access, already counted every edit,
// create, and read on that table, and reach is checked again before each
// record effect lands. A record the code changes by id is read through an
// approved read that shows the fields it changes, which also reads it again
// when it is stale. Undo treats the code's changes as a Set fields or Add
// record step's: a field goes back only through a reversible edit, and an
// added record stays. On a dataset whose operations someone wrote, a code
// step reads only the record's id and changes no record; an action it feeds
// through an invoke step undoes as any action does.
//
// A due time or a Group message has no record: the engine claims it, as
// for a document Collection, and the run reads only what its Finds find.
// Formulas read `now` as the due time, and a Group message and its author
// as a document Collection's run does.
//
// A button press's run reads its record as it is now, and formulas see the
// person who pressed. It runs only the automation the press was checked
// against, from the button that was pressed, in the table it was pressed
// in. Its steps use the automation caller, as every run here does. The host
// holds that caller to the owner's approved operations, and this computer's
// datasets are its person's own, so the run never does more than the
// presser could.

export const ACCESS_NARROWED_ERROR = "Someone who edits this automation can no longer read a field it used, so dohc stopped the rest of this run.";
// Reads keep no receipt, so they share one key.
const READ_KEY = "automation-read";

/** The caller a dataset host gives one run: every invocation the run makes carries it. */
export interface DatasetAutomationContext { readonly automationId: string; readonly claimId: string; readonly depth: number; readonly person: string | null }

/** One invocation of an approved operation, as a run or an Undo sends it. */
export interface DatasetInvocation {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  operationId: string;
  input: JsonValue;
  idempotencyKey: string;
  signal?: AbortSignal;
}

/** The dataset host as a run uses it. LocalDatasetHost's `automations` satisfies it. */
export interface DatasetRunHost {
  /** The context a run's dataset calls go through, at `depth`, for `person`. */
  context(input: { automationId: string; claimId: string; depth: number; person: string | null }): DatasetAutomationContext;
  invoke(context: DatasetAutomationContext, input: DatasetInvocation): Promise<DatasetInvocationResult>;
  revision(datasetId: string): DatasetRevision;
  generated(datasetId: string): boolean;
  resolves(reference: { datasetId: string; revision: number; revisionSha256: string }): boolean;
  dataGrants(datasetId: string): ReachDatasetGrants;
}

export interface DatasetAutomationRunDependencies extends Pick<
  CollectionAutomationRunDependencies,
  "targets" | "evaluator" | "store" | "nowMs" | "personName" | "chat" | "postNotice" | "recipientVerdicts" | "readMessageBody" | "readCode"
>, Partial<Pick<CollectionAutomationRunDependencies, "withReads" | "withRecordWrites" | "collectionIdOf" | "collectionPathOf" | "checkReach">> {
  /** The dataset host; resolves null when it is not open. */
  withHost<T>(work: (host: DatasetRunHost) => T | Promise<T>): Promise<T | null>;
  /** Who can edit the workspace's Collections now, as last read, for the check before each record effect. */
  cachedRoster(): Promise<ReachRoster>;
}

/**
 * The person a dataset claim's run acts for: who pressed its button, or who
 * made the commit or had an agent or automation make it. Null for a link
 * visitor, and when nobody is known.
 */
export function datasetPerson(claim: Pick<DatasetAutomationClaim, "actor">): string | null {
  const { actor } = claim;
  return actor.kind === "link" ? null : actor.userId ?? null;
}

/** The person a run's writes are made for, so the changes they cause name them too. */
function runPerson(held: DatasetRunClaim): string | null {
  return held.source === "dataset" ? datasetPerson(held.claim) : claimPerson(held.claim);
}

/** The person who pressed the button a claim runs for, or null for a change. */
export function datasetPresser(claim: Pick<DatasetAutomationClaim, "fact" | "actor">): string | null {
  const { actor } = claim;
  return claim.fact?.kind === "button" && (actor.kind === "owner" || actor.kind === "named") ? actor.userId ?? null : null;
}

/**
 * The claim a dataset run runs: a record change or a press the dataset's
 * ledger claimed, or a due time or a Group message the engine claimed. An
 * engine claim names only its Collection, so it comes with the dataset the
 * Collection keeps.
 */
export type DatasetRunClaim =
  | { source: "dataset"; claim: DatasetAutomationClaim }
  | { source: "engine"; claim: AutomationClaim; datasetId: string };

export interface DatasetAutomationRunInput {
  held: DatasetRunClaim;
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
export function rowsOf(result: DatasetInvocationResult): Row[] {
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
export function datasetRunRecordOf(row: Row, datasetId: string, table: DatasetTable, readable: ReadonlySet<string>): RunRecord {
  const values: JsonObject = {};
  for (const field of table.fields) {
    // Formulas see only what every editor can read.
    if (Object.hasOwn(row.values, field.fieldId) && readable.has(datasetFieldKey(datasetId, table.tableId, field.fieldId))) values[field.name] = row.values[field.fieldId] ?? null;
  }
  return { id: String(row.id), key: row.id, path: datasetRecordKey(datasetId, table.tableId, row.id), values };
}

// What a field holds, as a Find's refusal names it, and the values its read
// compares it with. The read checks the rest, such as a select's options.
const FIELD_HOLDS: Partial<Record<DatasetColumnFieldType, { holds: string; accepts: (value: JsonValue) => boolean }>> = {
  number: { holds: "a number", accepts: (value) => typeof value === "number" && Number.isFinite(value) },
  checkbox: { holds: "true or false", accepts: (value) => typeof value === "boolean" },
  text: { holds: "text", accepts: (value) => typeof value === "string" },
  date: { holds: "a date", accepts: (value) => typeof value === "string" },
  url: { holds: "a link", accepts: (value) => typeof value === "string" },
  select: { holds: "a choice", accepts: (value) => typeof value === "string" },
};

function kindOfValue(value: JsonValue): string {
  if (value === null) return "nothing";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "number": return "a number";
    case "boolean": return "true or false";
    case "string": return "text";
    default: return "an object";
  }
}

/**
 * Why a Find's read would refuse the value a formula gave one of its
 * fields, or null. The Find then reads nothing, and the run fails only if
 * its branch runs.
 */
export function findValueProblem(ordinal: number, field: DatasetTable["fields"][number], value: JsonValue): string | null {
  if (field.type === "button") return null;
  const step = `The Find in step ${ordinal + 1}`;
  if (value === null) return field.required ? `${step} compares ${field.name}, which every record fills in, with nothing.` : null;
  const expected = FIELD_HOLDS[field.type];
  if (expected === undefined || expected.accepts(value)) return null;
  const hint = field.type === "number" && typeof value === "string" ? " Wrap the value in Number()." : "";
  return `${step} compares ${field.name}, ${expected.holds}, with ${kindOfValue(value)}.${hint}`;
}

/** One invocation as this run's automation, with the automation caller. */
async function invoke(
  host: DatasetRunHost,
  context: DatasetAutomationContext,
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
  context: DatasetAutomationContext,
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

/**
 * Whether a record is in the table of a button's automation now, read as the
 * owner through the read its runs find their record with.
 */
export async function datasetRecordExists(
  host: Pick<DatasetRunHost, "revision"> & { invokeAsOwner(input: DatasetInvocation): Promise<DatasetInvocationResult> },
  datasetId: string,
  automation: Automation,
  recordId: DatasetRecordId,
): Promise<boolean> {
  const approved = host.revision(datasetId);
  const { trigger } = datasetStepsOf(automation, { definition: approved.definition, generated: true, sourceCollection: approved.definition.schemaPath.slice(0, approved.definition.schemaPath.lastIndexOf("/")) });
  if (trigger?.read == null) return false;
  const rules = { datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
  return (await readDatasetRecord((operationId, input) => host.invokeAsOwner({ ...rules, operationId, input, idempotencyKey: READ_KEY }), trigger.read, trigger.table, recordId)) !== null;
}

const datasetIdOf = (held: DatasetRunClaim) => (held.source === "dataset" ? held.claim.datasetId : held.datasetId);

export async function runDatasetAutomation(
  dependencies: DatasetAutomationRunDependencies,
  input: DatasetAutomationRunInput,
): Promise<CollectionAutomationRunOutcome> {
  return coordinateSourceRun(dependencies, { ...input, claim: input.held.claim }, datasetSource(input));
}

/**
 * Why the approved rules cannot finish code steps' effects, or null: an
 * operation a change goes through is gone, or no approved read could show
 * an edited record again when it is stale. Reach already checked every
 * operation a code step can pick.
 */
export function codeStepProblem(automation: Automation, definition: DatasetDefinition, plan: readonly StoredStep[]): string | null {
  const code = codeStepOrdinals(automation);
  for (const { ordinal, effects } of plan) {
    if (!code.has(ordinal)) continue;
    for (const effect of effects) {
      if (effect.kind !== "dataset-edit" && effect.kind !== "dataset-create") continue;
      const table = definition.tables.find((candidate) => candidate.tableId === effect.tableId);
      if (table === undefined || !definition.operations.some((candidate) => candidate.operationId === effect.operationId)) return RULES_CHANGED_ERROR;
      // Reach and presses count only the operations of the table code uses
      // under these rules. A saved change to another table, such as the only
      // one before a second was added, would land unchecked.
      if (datasetCodeTable(automation, definition)?.tableId !== effect.tableId) return RULES_CHANGED_ERROR;
      if (effect.kind !== "dataset-edit") continue;
      // A stale edit reads its record again, so the read must exist before anything lands.
      const reader = datasetCodeOperation(definition, table, "read", effect.fields.map(({ field }) => field));
      if ("problem" in reader) return `The code in step ${ordinal + 1} changes records in ${table.name}. ${reader.problem}`;
    }
  }
  return null;
}

/** A record id the code wrote as text, as `table`'s primary key holds it, or null when it cannot be one. */
function datasetRecordIdOf(table: DatasetTable, text: string): DatasetRecordId | null {
  const key = table.fields.find((field) => field.type !== "button" && field.sqlColumn === table.primaryKey);
  if (key?.type !== "number") return text;
  const id = /^-?\d+$/u.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Checks each change a code step asked for against the table the automation
 * watches, then reads each record it changes, once, through a read that shows
 * every field the step changes on it. A record the step already read keeps
 * that snapshot and its version: the new read only adds the fields it shows,
 * and a record that changed in between makes the step read again. A record
 * that is not in the table is left out, and the step says so.
 */
async function codeRecords(
  input: DatasetAutomationRunInput,
  definition: DatasetDefinition,
  datasetRules: DatasetRules,
  changes: readonly CodeChange[],
  record: RunRecord | null,
  readable: ReadonlySet<string>,
  snapshots: ReadonlyMap<string, RunRecord>,
  read: (operation: DatasetOperation, table: DatasetTable, id: DatasetRecordId) => Promise<Row | null>,
  remember: (row: Row, table: DatasetTable) => RunRecord,
): Promise<{ records: Map<string, RunRecord> } | { outcome: CollectionAutomationRunOutcome }> {
  const { automation, collection, held } = input;
  const first = `The code in step ${changes[0]!.ordinal + 1}`;
  if (!datasetRules.generated) {
    // Only an action changes records on a dataset whose operations someone wrote.
    return { outcome: failed(`${first} changes records in ${definition.name}. Its operations were written or changed outside dohc, so only an action can change its records. Run one with an invoke step.`) };
  }
  const table = datasetCodeTable(automation, definition);
  if (table === undefined) {
    return { outcome: failed(`${first} changes records, and ${definition.name} has several tables, so dohc cannot tell which one. Start the automation from a change in one table.`) };
  }
  const datasetId = datasetIdOf(held);
  // Each record the code changes, with every field it changes there, and
  // each text the code named it by. The trigger record's `set` counts.
  const changed = new Map<string, { ordinal: number; texts: Set<string>; id: DatasetRecordId; fields: Set<string> }>();
  const add = (ordinal: number, id: DatasetRecordId, text: string | null, fields: JsonObject) => {
    const key = datasetRecordKey(datasetId, table.tableId, id);
    const entry = changed.get(key) ?? { ordinal, texts: new Set<string>(), id, fields: new Set<string>() };
    if (text !== null) entry.texts.add(text);
    for (const field of Object.keys(fields)) entry.fields.add(field);
    changed.set(key, entry);
  };
  for (const change of changes) {
    const step = `The code in step ${change.ordinal + 1}`;
    if (change.collection !== collection.path) {
      return { outcome: failed(`${step} changes records in ${change.collection}. Automations on ${definition.name} can use only its own records for now.`) };
    }
    const missing = Object.keys(change.fields).find((name) => !table.fields.some((field) => field.name === name && field.type !== "button"));
    if (missing !== undefined) return { outcome: failed(`${step} sets ${missing}, which is not a field in ${table.name}.`) };
    if (change.action === "add") continue;
    if (change.id === null) {
      // `set` without a trigger record fails when the step is planned.
      if (record?.key !== undefined) add(change.ordinal, record.key, null, change.fields);
      continue;
    }
    const id = datasetRecordIdOf(table, change.id);
    if (id === null) return { outcome: failed(`${step} changes record ${change.id}, which is not in ${table.name}.`) };
    add(change.ordinal, id, change.id, change.fields);
  }
  const records = new Map<string, RunRecord>();
  for (const [key, { ordinal, texts, id, fields }] of changed) {
    // A snapshot that already shows every field the code may see needs no second read.
    const earlier = snapshots.get(key);
    const unseen = [...fields].some((name) => readable.has(datasetFieldKey(definition.datasetId, table.tableId, table.fields.find((field) => field.name === name)!.fieldId)) && !Object.hasOwn(earlier?.values ?? {}, name));
    let snapshot = earlier;
    if (earlier === undefined || unseen) {
      const operation = datasetCodeOperation(definition, table, "read", [...fields]);
      if ("problem" in operation) return { outcome: failed(`The code in step ${ordinal + 1} changes records in ${table.name}. ${operation.problem}`) };
      const row = await read(operation, table, id);
      snapshot = row === null ? undefined : remember(row, table);
    }
    if (snapshot !== undefined) for (const text of texts) records.set(codeRecordKey(collection.path, text), snapshot);
  }
  return { records };
}

/**
 * Why a field-changed trigger cannot compare the new value, or null. A claim
 * leaves out a value too large for it, and a run that reads the record takes
 * the value from there instead. A run that cannot read the record must not
 * compare an absent value as if it were empty.
 */
export function unreadComparison(automation: Automation, claim: RunClaim): string | null {
  const trigger = automation.when;
  if (trigger.kind !== "field-changed" || trigger.to === null || claim.change.kind !== "changed") return null;
  const fact = claim.change.fields.find((candidate) => candidate.field === trigger.field);
  const truncated = fact === undefined ? claim.change.fieldsOmitted > 0 : fact.next !== null && "truncated" in fact.next;
  return truncated ? `The new value of ${trigger.field} is too large for dohc to compare without reading the record.` : null;
}

/**
 * A notice about a dataset record: it names the Collection, since the
 * record has no file, and the record by its id when that id fits a notice.
 */
function datasetNotice(effect: Extract<PlannedEffect, { kind: "notice" }>, collectionPath: string): Extract<PlannedEffect, { kind: "notice" }> {
  const { record, ...target } = effect.notice.target;
  const named = record !== undefined && isNoticeLine(record, NOTICE_TARGET_FIELD_MAX_CHARS) ? { record } : {};
  return { ...effect, notice: { ...effect.notice, target: { ...target, path: collectionPath, ...named } } };
}

/**
 * One step's document-shaped effects as effects through its operation, and
 * its messages and notices as planned. A code step's change goes through the
 * operation the panel would pin for it; or the step cannot run. Each edit
 * carries the version the step read its record at.
 */
export function datasetStepEffects(
  automation: Automation,
  ordinal: number,
  planned: readonly PlannedEffect[],
  steps: DatasetSteps,
  definition: DatasetDefinition,
  isCode: boolean,
  rules: Rules,
  versions: ReadonlyMap<string, { id: DatasetRecordId; version: number }>,
  collectionPath: string,
  /** The approved deletes an Undo may use on a record added to a table. */
  deletes: (tableId: string) => string[],
): StoredStep["effects"] | { problem: string } {
  const own: StoredStep["effects"] = [];
  for (const effect of planned) {
    const mapped = datasetEffect(effect);
    if ("problem" in mapped) return mapped;
    own.push(mapped);
  }
  return own;

  function datasetEffect(effect: PlannedEffect): StoredStep["effects"][number] | { problem: string } {
    if (effect.kind === "message" || effect.kind === "wake") return effect;
    if (effect.kind === "notice") return datasetNotice(effect, collectionPath);
    if (effect.kind === "invoke") {
      const { operation, table } = steps.steps.get(ordinal)!;
      return { kind: "dataset-action", rules, operationId: operation.operationId, tableId: table.tableId, input: effect.input };
    }
    let operation: DatasetOperation, table: DatasetTable;
    if (isCode) {
      const code = datasetCodeTable(automation, definition);
      if (code === undefined) return { problem: RULES_CHANGED_ERROR };
      table = code;
      const chosen = datasetCodeOperation(definition, table, effect.kind === "add" ? "create" : "edit", effect.fields.map(({ field }) => field));
      if ("problem" in chosen) return { problem: `The code in step ${ordinal + 1} changes records in ${table.name}. ${chosen.problem}` };
      operation = chosen;
    } else {
      ({ operation, table } = steps.steps.get(ordinal)!);
    }
    const fieldId = (name: string) => table.fields.find((field) => field.name === name)!.fieldId;
    if (effect.kind === "add") {
      return {
        kind: "dataset-create", rules, operationId: operation.operationId, tableId: table.tableId,
        values: effect.fields.map(({ field, value }) => ({ fieldId: fieldId(field), field, value })),
        deletes: deletes(table.tableId),
      };
    }
    const known = versions.get(effect.target.path);
    if (known === undefined) throw new Error("dohc lost track of a record this run read.");
    return {
      kind: "dataset-edit", rules, operationId: operation.operationId, tableId: table.tableId,
      target: { recordId: known.id, version: known.version },
      fields: effect.fields.map(({ field, before, after }) => ({ fieldId: fieldId(field), field, before, after })),
    };
  }
}

export async function applyDatasetEffect(
  context: {
    dependencies: DatasetAutomationRunDependencies;
    host: DatasetRunHost;
    context: DatasetAutomationContext;
    run: StoredRun;
    index: number;
    ordinal: number;
    /** The effect's place among its step's effects. */
    part: number;
    signal: AbortSignal;
    /** The rules reach checked for this run. */
    datasetRules: DatasetRules;
    reader?: DatasetOperation;
  },
  effect: DatasetEffect,
  automation: Automation,
): Promise<RunWrite[]> {
  const { dependencies, host, run, index, ordinal, part, signal } = context;
  const keyOf = (recordId: DatasetRecordId | null, replan: number) => datasetEffectKey(run.claimId, run.keySeed, ordinal, part, recordId, replan, effect.rules.datasetId !== run.rules?.datasetId ? { datasetId: effect.rules.datasetId, tableId: effect.tableId } : undefined);
  if (effect.kind === "dataset-action") {
    // One invocation per step. Its key and input are saved in the plan, so a
    // resumed run sends the same request, and a commit that landed before a
    // crash replays its receipt instead of running twice. A refusal commits
    // nothing, so Try again runs the action again under the same key.
    const action = context.datasetRules.definition.operations.find((operation) => operation.operationId === effect.operationId);
    const label = action?.label ?? "The action";
    const result = await send(() => invoke(host, context.context, effect.rules, effect.operationId, effect.input, keyOf(null, 0), signal));
    if ("refused" in result) throw new Error(`${label} refused this run: ${result.refused.message}`);
    // The host commits a reversible action only with its undo, so Undo can run the reverse.
    const landed = result.value.result;
    const undo = action?.reversedBy !== undefined && landed !== null && typeof landed === "object" && !Array.isArray(landed) ? landed.undo : undefined;
    const reverse = context.datasetRules.definition.operations.find((operation) => operation.name === action?.reversedBy && operation.kind === "action");
    return [{ kind: "dataset-action", rules: effect.rules, operationId: effect.operationId, tableId: effect.tableId, name: label, revision: result.value.revision,
      ...(undo === undefined || reverse === undefined ? {} : { undo, reverseOperationId: reverse.operationId }) }];
  }
  if (effect.kind === "dataset-create") {
    const values: JsonObject = Object.fromEntries(effect.values.map(({ fieldId, value }) => [fieldId, value]));
    const result = await send(() => invoke(host, context.context, effect.rules, effect.operationId, { values }, keyOf(null, 0), signal));
    if ("refused" in result) throw new Error(result.refused.message);
    const created = result.value.result;
    const id = created !== null && typeof created === "object" && !Array.isArray(created) ? created.id : undefined;
    const version = created !== null && typeof created === "object" && !Array.isArray(created) ? created.version : undefined;
    if ((typeof id !== "string" && typeof id !== "number") || typeof version !== "number") throw new Error("This Collection did not identify the record it added. Ask the owner to check its rules.");
    return [{ kind: "dataset-created", rules: effect.rules, operationId: effect.operationId, tableId: effect.tableId, recordId: id, version, deletes: effect.deletes }];
  }

  const { recordId } = effect.target;
  const latest = run.replans.filter((replan) => replan.effect === index).at(-1);
  let replan = latest?.replan ?? 0;
  let version = latest?.version ?? effect.target.version;
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
        kind: "dataset-edit", rules: effect.rules, operationId: effect.operationId, tableId: effect.tableId, recordId, expectedVersion: version, version: next,
        fields: fields.map((field) => ({ ...field, before: priorValues[field.fieldId] ?? null })),
      }];
    }
    if (result.refused.code === "not_found") {
      return [...kept, { kind: "dataset-skipped", datasetId: effect.rules.datasetId, tableId: effect.tableId, recordId, reason: "The record is no longer in the Collection." }];
    }
    if (result.refused.code !== "stale_record") throw new Error(result.refused.message);
    // Someone changed the record since the plan read it. Read it again.
    const table = context.datasetRules.definition.tables.find((candidate) => candidate.tableId === effect.tableId);
    if (table === undefined) throw new Error(RULES_CHANGED_ERROR);
    const code = codeStepOrdinals(automation).has(ordinal)
      ? datasetCodeOperation(context.datasetRules.definition, table, "read", effect.fields.map(({ field }) => field))
      : null;
    const reader = context.reader ?? (code === null ? datasetStepsOf(automation, context.datasetRules).rereads.get(ordinal) : "problem" in code ? undefined : code);
    if (reader === undefined) throw new Error(`${table.name} changed, and dohc has no approved read of it to check the record again.`);
    const row = await readRecord(host, context.context, effect.rules, reader, table, recordId, signal);
    if (row === null) return [...kept, { kind: "dataset-skipped", datasetId: effect.rules.datasetId, tableId: effect.tableId, recordId, reason: "The record is no longer in the Collection." }];
    const remaining: typeof fields = [];
    const found: RunWrite[] = [];
    for (const field of fields) {
      const current = row.values[field.fieldId] ?? null;
      if (isDeepStrictEqual(current, field.before) && !isDeepStrictEqual(current, field.after)) remaining.push(field);
      // It already holds the planned value, or someone gave it another:
      // either way it stays as it is.
      else found.push({ kind: "dataset-kept", datasetId: effect.rules.datasetId, tableId: effect.tableId, recordId, fieldId: field.fieldId, field: field.field, planned: field.after, current });
    }
    kept = [...kept, ...found];
    if (remaining.length === 0) return kept;
    // An edit whose record keeps changing under it stops the run rather than loop.
    if (replan >= MAX_REREADS) throw new Error(KEPT_CHANGING_ERROR);
    replan += 1;
    version = row.version;
    fields = remaining;
    const saved: DatasetReplan = { effect: index, replan, version, fields, kept };
    // Saved before it is sent, so a resume sends this key with this content.
    await dependencies.store.recordReplan(run, saved);
    run.replans.push(saved);
  }
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

function datasetSource(input: DatasetAutomationRunInput): RunSource {
  const { held, automation, collection } = input;
  const datasetId = datasetIdOf(held);
  return {
    kind: "dataset", datasetId, engineClaim: held.source === "engine" ? held.claim : null,
    personId: held.source === "dataset" ? datasetPerson(held.claim) : null,
    writeAuthorId: runPerson(held),
    decode(inventory, readable, resuming) {
      const { rules, steps } = inventory.datasets.get(collection.path)!;
      if ((held.source === "engine") !== (steps.trigger === null)) return { outcome: { kind: "skipped" } };
      if (held.source === "dataset") {
        const fact = held.claim.fact;
        if (fact === null) return { outcome: failed(held.claim.error ?? "This change cannot be read.") };
        if (fact.tableId !== steps.trigger?.table.tableId) return { outcome: { kind: "skipped" } };
        if (fact.kind === "button" && !resuming) {
          const button = datasetButtonOf(automation, rules.definition);
          if (button?.tableId !== fact.tableId || button.fieldId !== fact.fieldId || definitionDigest(automation) !== fact.definitionHash) {
            const name = rules.definition.tables.flatMap((table) => table.fields).find((field) => field.fieldId === fact.fieldId)?.name;
            return { outcome: failed(changedSincePressed(name ?? "This button")) };
          }
        }
      }
      const claim = held.source === "engine" ? { ...held.claim, collectionPath: collection.path }
        : datasetRunClaim(held.claim, collection.path, steps.trigger!.table, readable);
      const problem = rules.generated ? null : unreadComparison(automation, claim);
      return problem === null ? claim : { outcome: failed(problem) };
    },
    validate(inventory, run) {
      const unfinished = run === null ? null : unfinishedStep(run);
      const problem = unfinished === null ? null : codeStepProblem(automation, inventory.datasets.get(collection.path)!.rules.definition, [unfinished]);
      return problem === null ? null : failed(problem);
    },
    reads({ dataset, remember, snapshots }, inventory, readable) {
      const { rules, steps } = inventory.datasets.get(collection.path)!;
      const read = (operation: DatasetOperation, table: DatasetTable, id: DatasetRecordId) => dataset(collection.path, operation, table, id);
      const keep = (row: DatasetRow, table: DatasetTable) => remember(collection.path, row, table);
      return {
        async trigger() {
          const fact = held.source === "dataset" ? held.claim.fact : null;
          if (fact === null || fact.kind === "removed" || steps.trigger === null) return null;
          const { table, read: operation } = steps.trigger;
          if (operation === null) return rules.generated ? null
            : { id: String(fact.recordId), key: fact.recordId, path: datasetRecordKey(datasetId, table.tableId, fact.recordId), values: {} };
          const row = await read(operation, table, fact.recordId);
          return row === null ? null : keep(row, table);
        },
        codeRecords: (changes, { record }) => codeRecords(input, rules.definition, rules, changes, record, readable, snapshots, read, keep),
      };
    },
  };
}
