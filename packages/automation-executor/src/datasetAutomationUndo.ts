import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import { datasetFieldKey, type ReachCollection, type ReachRoster } from "./automationReach";
import type { DatasetUndoCall, DatasetUndoRequest, RunWrite, StoredRun } from "./automationRunStore";
import { unrecordedEffect } from "./automationStepRun";
import type { CollectionAutomationUndone } from "./collectionAutomationUndo";
import { datasetRecordKey, datasetUndoDeletes, type DatasetRecordId } from "./datasetAutomationPlan";
import { readDatasetRecord, send, type DatasetInvocation, type DatasetRunHost } from "./datasetAutomationRun";

// Undo for a dataset automation's run (AGENTS.md: every reversible change
// gets a way back). Like document Undo, each field the runs wrote goes back
// to what it held before their last unbroken chain of writes to it, and only
// while it still holds what that chain left, so an Undo that stops part way
// never leaves a field between two of the runs' writes. A write that found
// someone else's value starts the chain again, so their value is what comes
// back. The edit a stopped run may have landed without recording it counts,
// with the value before it as another value the chain may have left. It is sent through the approved edit
// that last wrote the field, as the person who clicks Undo, at the version the
// runs left the record. A record someone changed since is refused as stale;
// then only fields that still hold what the runs wrote go back, and the rest
// keep the later change. A field any edit wrote that the rules do not mark
// reversible stays.
//
// An action goes back through its reverse action, newest first, with the
// undo its own result carried, keyed by the commit it made. The first
// reverse the dataset refuses stops the Undo, since an older action's
// reverse may expect the state a newer one left. An action the rules give
// no reverse stays. Only a dataset whose operations someone wrote has
// actions, and only a generated one adds records or runs edits, so one run
// never mixes actions with the rest.
//
// A record the runs added is deleted first, through an approved delete its
// run's plan recorded that every editor can still use, at the version the
// runs left it. A record someone else wrote between two of the runs' writes,
// or since their last, stays; so does one no such delete reaches. The person
// first reads a preview, made from each added record as it is now, and
// chooses among several deletes there. Undo sends only the deletes of the
// preview they confirmed.
//
// Every reverse and delete is saved in one list before the first is sent, so
// an Undo that stops part way sends exactly the same requests again and
// replays the receipts of those that landed.

export const DATASET_UNDO_RULES_CHANGED = "Collection rules changed after this run, so dohc cannot undo it.";

/** The dataset host as an Undo uses it: the person's own invocations, the rules now, and their data grants. */
export interface DatasetUndoHost extends Pick<DatasetRunHost, "revision" | "resolves" | "dataGrants"> {
  /** Invokes an operation as the person who clicked Undo. */
  invokeAsOwner(input: DatasetInvocation): Promise<DatasetInvocationResult>;
}

/** Who can edit the runs' automation now, and its Collection as its saved automation id names it. */
export interface DatasetUndoReach {
  roster: ReachRoster;
  collection: ReachCollection;
}

type Edit = Extract<RunWrite, { kind: "dataset-edit" }>;
type Action = Extract<RunWrite, { kind: "dataset-action" }>;
type Rules = Edit["rules"];

/** The runs' writes, oldest first. */
function writesOf(runs: readonly StoredRun[]): RunWrite[] {
  return [...runs].sort((left, right) => left.startedAtMs - right.startedAtMs)
    .flatMap((run) => run.applied.flatMap((effect) => effect.writes));
}

/**
 * The runs' edits, oldest first. After each stopped run's recorded edits
 * comes the edit it may have landed without recording, marked not sure: as
 * last sent, at the version it was sent at, after any replan. `hidden` are
 * that edit's fields its run could not read, so the value before it is not
 * known.
 */
function editsOf(runs: readonly StoredRun[]): Array<{ edit: Edit; sure: boolean; hidden: ReadonlySet<string> }> {
  return [...runs].sort((left, right) => left.startedAtMs - right.startedAtMs).flatMap((run) => {
    const recorded = run.applied.flatMap((effect) => effect.writes)
      .flatMap((write) => (write.kind === "dataset-edit" ? [{ edit: write, sure: true, hidden: new Set<string>() }] : []));
    const unrecorded = unrecordedEffect(run)?.effect;
    if (unrecorded?.kind !== "dataset-edit") return recorded;
    const replan = run.replans.filter((entry) => entry.effect === run.applied.length).at(-1);
    const { rules, operationId, tableId, target } = unrecorded;
    // As last sent: after its latest replan, at the version it was sent at.
    const sentAt = replan?.version ?? target.version;
    const maybe: Edit = { kind: "dataset-edit", rules, operationId, tableId, recordId: target.recordId,
      expectedVersion: sentAt, version: sentAt, fields: replan?.fields ?? unrecorded.fields };
    // Readable fields are named by dataset, table, and field.
    const readable = run.readableFields === null ? null : new Set(run.readableFields);
    const hidden = maybe.fields.map((field) => field.fieldId).filter((fieldId) => readable !== null && !readable.has(datasetFieldKey(rules.datasetId, tableId, fieldId)));
    return [...recorded, { edit: maybe, sure: false, hidden: new Set(hidden) }];
  });
}

function actionsOf(runs: readonly StoredRun[]): Action[] {
  return writesOf(runs).filter((write): write is Action => write.kind === "dataset-action");
}

/**
 * Whether the rules any of these runs' edits, added records, or actions ran
 * under no longer resolve, or now name another reverse for an action than
 * the one it ran with, so Undo must not start.
 */
export function datasetUndoRulesChanged(host: Pick<DatasetRunHost, "resolves" | "revision">, runs: readonly StoredRun[]): boolean {
  const ran = [...editsOf(runs).map(({ edit }) => edit), ...writesOf(runs).filter((write) => write.kind === "dataset-created" || write.kind === "dataset-action")];
  if (ran.some((write) => !host.resolves(write.rules))) return true;
  return actionsOf(runs).some((action) => action.undo !== undefined && reverseOf(host, action)?.operationId !== action.reverseOperationId);
}

/**
 * Why an Undo of these runs, every saved run of one claim, cannot go on:
 * a saved reverse whose action no saved run still records, as when run
 * history dropped that run. Null when every saved reverse has its action.
 */
export function datasetUndoLostRun(host: Pick<DatasetRunHost, "revision">, runs: readonly StoredRun[]): string | null {
  const actions = actionsOf(runs);
  for (const call of runs.flatMap((run) => run.undoCalls)) {
    if (call.kind !== "reverse" || actions.some((action) =>
      action.rules.datasetId === call.rules.datasetId && action.revision === call.revision && action.operationId === call.action)) continue;
    const label = host.revision(call.rules.datasetId).definition.operations.find((operation) => operation.operationId === call.action)?.label ?? "an action";
    return `dohc no longer has the run that ran ${label}, so it cannot finish this Undo. Undo what ${label} changed by hand.`;
  }
  return null;
}

/** The reverse the rules name now for an action that ran, or undefined. */
function reverseOf(host: Pick<DatasetRunHost, "revision">, action: Action): DatasetOperation | undefined {
  const { definition } = host.revision(action.rules.datasetId);
  const forward = definition.operations.find((operation) => operation.operationId === action.operationId);
  return definition.operations.find((operation) => operation.name === forward?.reversedBy && operation.kind === "action");
}

/** A record the runs added, as their writes left it. */
interface Addition {
  rules: Rules;
  tableId: string;
  recordId: DatasetRecordId;
  /** The version the runs' last write left it at. */
  version: number;
  /** The deletes its run's plan recorded. */
  deletes: readonly string[];
  /** Someone else wrote it between two of the runs' writes. */
  changed: boolean;
}

/** The records the runs added, by identity, oldest first. */
function additionsOf(runs: readonly StoredRun[]): Map<string, Addition> {
  const added = new Map<string, Addition>();
  for (const write of writesOf(runs)) {
    if (write.kind !== "dataset-created" && write.kind !== "dataset-edit") continue;
    const key = datasetRecordKey(write.rules.datasetId, write.tableId, write.recordId);
    if (write.kind === "dataset-created") {
      added.set(key, { rules: write.rules, tableId: write.tableId, recordId: write.recordId, version: write.version, deletes: write.deletes, changed: false });
      continue;
    }
    const addition = added.get(key);
    if (addition === undefined) continue;
    // An edit sent at another version than the last write left means someone wrote between them.
    if (write.expectedVersion !== addition.version) addition.changed = true;
    addition.version = write.version;
  }
  return added;
}

/** The deletes an Undo may use on an addition under `roster`: those its plan recorded that every editor can still use. */
function usableDeletes(host: DatasetUndoHost, roster: ReachRoster, collection: ReachCollection, addition: Addition): DatasetOperation[] {
  const { datasetId } = addition.rules;
  return datasetUndoDeletes(roster, collection, host.revision(datasetId).definition, addition.tableId, host.dataGrants(datasetId))
    .filter((operation) => addition.deletes.includes(operation.operationId));
}

/** Whether any record the runs added has a delete its plan recorded, so Undo needs to know who can edit. */
export function datasetUndoDeletesRecorded(runs: readonly StoredRun[]): boolean {
  return [...additionsOf(runs).values()].some((addition) => addition.deletes.length > 0);
}

/**
 * Added records in one table that the same approved deletes qualify for,
 * more than one, so the person chooses one by its label. `key` names the
 * table and those deletes.
 */
export interface DatasetUndoChoice {
  key: string;
  table: string;
  /** Added records the chosen delete would delete. */
  records: number;
  operations: Array<{ operationId: string; label: string }>;
}

/** What an Undo of dataset runs will do, for the person to read before it runs. */
export interface DatasetUndoPreview {
  /** Added records Undo will delete, unless someone changes them first. */
  deletes: number;
  /**
   * Added records Undo will try to delete that it could not read first,
   * because their table has no approved read. One someone changed stays.
   */
  unchecked: number;
  /** Added records that stay because no approved delete qualifies. */
  kept: number;
  /** Added records that stay because someone else changed them. */
  keptChanged: number;
  /** Added records already gone. */
  gone: number;
  /** Changed fields Undo puts back where no one changed them since. */
  reverts: number;
  /** Changed fields the rules do not let Undo put back. */
  irreversible: number;
  /** Actions Undo will run the reverse of. */
  reverses: number;
  /** Actions the rules give no reverse, whose changes stay. */
  actions: number;
  /** Where the person must choose a delete. */
  choices: DatasetUndoChoice[];
  /**
   * Names exactly this preview: which records it deletes, with which
   * deletes, at which versions, and which actions it reverses. A
   * confirmation carries it back, so Undo never sends what the person did
   * not read.
   */
  token: string;
}

/** The person's confirmation of a preview: its token, and one delete per choice. */
export interface DatasetUndoConfirmed {
  token: string;
  chosen: ReadonlyArray<{ key: string; operationId: string }>;
}

function choiceKey(addition: Addition, operations: readonly DatasetOperation[]): string {
  return JSON.stringify([addition.tableId, ...operations.map((operation) => operation.operationId).sort()]);
}

/**
 * An added record's version now, read as the person through an approved
 * read of its table: null when it is gone, undefined when the table has no
 * read. A refused read stops the Undo, which can be tried again.
 */
async function versionNow(host: DatasetUndoHost, addition: Addition, signal: AbortSignal): Promise<number | null | undefined> {
  const { definition } = host.revision(addition.rules.datasetId);
  const table = definition.tables.find((candidate) => candidate.tableId === addition.tableId);
  const read = definition.operations.find((operation) => operation.kind === "read" && operation.tableId === addition.tableId);
  if (table === undefined || read === undefined) return undefined;
  const row = await readDatasetRecord(async (operationId, input) => {
    const answered = await send(() => host.invokeAsOwner({ ...addition.rules, operationId, input, idempotencyKey: "automation-undo-read", signal }));
    if ("refused" in answered) throw new Error(answered.refused.message);
    return answered.value;
  }, read, table, addition.recordId);
  return row === null ? null : row.version;
}

/**
 * What Undo will do to these runs' dataset records, found before anything
 * is saved or sent, and the reverses and deletes it sends once the person
 * confirms it, in the order it sends them. Each added record is read as it
 * is now, so the preview says which stay because someone changed them since
 * the runs, and which are already gone. It plans the actions and added
 * records of `pending`, the runs this Undo has not finished; `runs` are
 * every run it reads, for the versions later writes left and the fields
 * that go back.
 */
export async function planDatasetUndo(
  host: DatasetUndoHost,
  reach: DatasetUndoReach,
  claimId: string,
  runs: readonly StoredRun[],
  pending: readonly StoredRun[],
  signal: AbortSignal,
): Promise<{ preview: DatasetUndoPreview; send(chosen: DatasetUndoConfirmed["chosen"]): DatasetUndoCall[] | null }> {
  const addedHere = new Set(writesOf(pending).flatMap((write) =>
    write.kind === "dataset-created" ? [datasetRecordKey(write.rules.datasetId, write.tableId, write.recordId)] : []));
  // Each action's reverse, newest commit first, by the revision each made: a clock can move back between two runs.
  const reverses: DatasetUndoCall[] = [];
  let actions = 0;
  const newestFirst = actionsOf(pending).sort((left, right) =>
    left.rules.datasetId === right.rules.datasetId ? right.revision - left.revision : left.rules.datasetId < right.rules.datasetId ? -1 : 1);
  for (const action of newestFirst) {
    const reverse = reverseOf(host, action);
    if (action.undo === undefined || reverse === undefined) {
      actions += 1;
      continue;
    }
    // The caller checked datasetUndoRulesChanged; rules that changed since run no other reverse.
    if (reverse.operationId !== action.reverseOperationId) throw new Error(DATASET_UNDO_RULES_CHANGED);
    reverses.push({
      kind: "reverse", rules: action.rules, operationId: reverse.operationId, action: action.operationId, revision: action.revision, input: action.undo,
      idempotencyKey: `u.${createHash("sha256").update(JSON.stringify(["dohc-action-undo-v1", claimId, action.rules.datasetId, action.revision, action.operationId])).digest("hex")}`,
    });
  }
  const deletes: Array<{ addition: Addition; operations: DatasetOperation[] }> = [];
  let kept = 0, keptChanged = 0, gone = 0, unchecked = 0;
  for (const [key, addition] of additionsOf(runs)) {
    if (!addedHere.has(key)) continue;
    const operations = usableDeletes(host, reach.roster, reach.collection, addition);
    if (addition.changed) {
      keptChanged += 1;
      continue;
    }
    if (operations.length === 0) {
      kept += 1;
      continue;
    }
    signal.throwIfAborted();
    const version = await versionNow(host, addition, signal);
    if (version === null) gone += 1;
    else if (version !== undefined && version !== addition.version) keptChanged += 1;
    else {
      // A record Undo could not read is still sent, at the version the runs left it, and stays when someone changed it.
      if (version === undefined) unchecked += 1;
      deletes.push({ addition, operations });
    }
  }
  const deleted = new Set(deletes.map(({ addition }) => datasetRecordKey(addition.rules.datasetId, addition.tableId, addition.recordId)));
  let reverts = 0, irreversible = 0;
  for (const record of changesOf(host, runs)) {
    if (deleted.has(datasetRecordKey(record.last.rules.datasetId, record.last.tableId, record.last.recordId))) continue;
    const changed = record.fields.filter((field) => field.after.length > 0);
    const table = host.revision(record.last.rules.datasetId).definition.tables.some((candidate) => candidate.tableId === record.last.tableId);
    const reversible = table ? changed.filter((field) => field.reversible).length : 0;
    reverts += reversible;
    irreversible += changed.length - reversible;
  }
  const choices = new Map<string, DatasetUndoChoice>();
  for (const { addition, operations } of deletes) {
    if (operations.length < 2) continue;
    const key = choiceKey(addition, operations);
    const choice = choices.get(key) ?? {
      key,
      table: host.revision(addition.rules.datasetId).definition.tables.find((table) => table.tableId === addition.tableId)?.name ?? "",
      records: 0,
      operations: operations.map(({ operationId, label }) => ({ operationId, label })),
    };
    choice.records += 1;
    choices.set(key, choice);
  }
  const body = {
    deletes: deletes.length - unchecked, unchecked, kept, keptChanged, gone, reverts, irreversible, reverses: reverses.length, actions,
    choices: [...choices.values()],
  };
  const scope = [reverses, deletes.map(({ addition, operations }) =>
    [addition.rules, addition.tableId, addition.recordId, addition.version, operations.map((operation) => operation.operationId)])];
  const token = createHash("sha256").update(JSON.stringify([body, scope])).digest("hex");
  return {
    preview: { ...body, token },
    // Every reverse, then each delete: the only one that qualifies, or the one the person chose. Null when a choice is missing.
    send(chosen) {
      const requests: DatasetUndoCall[] = [...reverses];
      for (const { addition, operations } of deletes) {
        const key = choiceKey(addition, operations);
        const picked = chosen.find((choice) => choice.key === key)?.operationId;
        const operation = operations.length === 1 ? operations[0] : operations.find((candidate) => candidate.operationId === picked);
        if (operation === undefined) return null;
        const input = { id: addition.recordId, expectedVersion: addition.version };
        requests.push({
          kind: "delete", rules: addition.rules, tableId: addition.tableId, recordId: addition.recordId, operationId: operation.operationId,
          expectedVersion: addition.version, idempotencyKey: undoKey(claimId, operation.operationId, input),
        });
      }
      return requests;
    },
  };
}

interface FieldChange {
  fieldId: string;
  /** The value the field goes back to: before the runs' last unbroken chain of writes to it. */
  before: JsonValue;
  /** Each value the chain may have left, likeliest first. */
  after: JsonValue[];
  /** Every edit of the chain is one the rules mark reversible. */
  reversible: boolean;
  /** The edit that wrote the field last, whose operation puts it back. */
  last: Edit;
  /** That edit surely landed. */
  sure: boolean;
}

/** One edit of one field. `known` is false when its run could not read the value before it. */
type FieldWrite = { before: JsonValue; after: JsonValue; sure: boolean; known: boolean; reversible: boolean; edit: Edit };

/** How one field goes back, as document Undo's wayBack works it out. */
function fieldChange(fieldId: string, writes: readonly FieldWrite[]): FieldChange {
  const last = writes.at(-1)!;
  let value = last.before;
  let reversible = last.reversible;
  // A value before an edit its run could not read is not known, so the
  // chain stops there and the field stays.
  let known = last.known;
  for (let index = writes.length - 2; known && index >= 0; index -= 1) {
    const earlier = writes[index]!;
    if (isDeepStrictEqual(earlier.after, value)) {
      value = earlier.before;
      reversible &&= earlier.reversible;
      known = earlier.known;
    } else if (!earlier.sure && earlier.known && isDeepStrictEqual(earlier.before, value)) {
      // An unrecorded edit the next one did not find never landed.
      continue;
    } else {
      break;
    }
  }
  const after = last.sure ? [last.after] : [last.after, last.before];
  if (!known) return { fieldId, before: value, after, reversible: false, last: last.edit, sure: last.sure };
  return { fieldId, before: value, after: after.filter((candidate) => !isDeepStrictEqual(candidate, value)), reversible, last: last.edit, sure: last.sure };
}

/**
 * Per record, the runs' last edit of it, whether that edit surely landed, and
 * how each field they wrote goes back.
 */
function changesOf(host: Pick<DatasetUndoHost, "revision">, runs: readonly StoredRun[]): Array<{ last: Edit; sure: boolean; fields: FieldChange[] }> {
  const records = new Map<string, { last: Edit; sure: boolean; fields: Map<string, FieldWrite[]> }>();
  for (const { edit, sure, hidden } of editsOf(runs)) {
    const operation = host.revision(edit.rules.datasetId).definition.operations
      .find((candidate) => candidate.operationId === edit.operationId);
    const key = datasetRecordKey(edit.rules.datasetId, edit.tableId, edit.recordId);
    const record = records.get(key) ?? { last: edit, sure, fields: new Map<string, FieldWrite[]>() };
    record.last = edit;
    record.sure = sure;
    for (const field of edit.fields) {
      // A field whose value before the edit its run could not read cannot go back to it.
      const write = { before: field.before, after: field.after, sure, known: !hidden.has(field.fieldId), reversible: operation?.reversible === true, edit };
      record.fields.set(field.fieldId, [...(record.fields.get(field.fieldId) ?? []), write]);
    }
    records.set(key, record);
  }
  return [...records.values()].map(({ last, sure, fields }) => ({ last, sure, fields: [...fields].map(([fieldId, writes]) => fieldChange(fieldId, writes)) }));
}

// The same content always gets the same key, so a second Undo of a record
// that already went back replays its receipt, and no key carries other content.
function undoKey(claimId: string, operationId: string, input: JsonObject): string {
  return `u.${createHash("sha256").update(JSON.stringify([claimId, operationId, input])).digest("hex")}`;
}

/**
 * Undoes what these runs of one claim changed in a dataset: first each
 * action its saved reverse reaches, then each added record its saved delete
 * reaches, then each field back to what it held before their first write.
 * The caller checks datasetUndoRulesChanged first, and saves the reverses
 * and deletes before this sends them; an edit whose rules changed since is
 * refused by the host. `saveRequest` saves a request
 * durably before it is sent again at a record's new version; the runs carry
 * what it saved.
 */
export async function undoDatasetAutomationRuns(
  host: DatasetUndoHost,
  collection: ReachCollection,
  /** Who can edit now, read again before each delete; it throws when dohc cannot tell. */
  rosterNow: () => Promise<ReachRoster>,
  claimId: string,
  runs: readonly StoredRun[],
  saveRequest: (request: DatasetUndoRequest) => Promise<void>,
  signal: AbortSignal,
): Promise<CollectionAutomationUndone> {
  const saved = runs.flatMap((run) => run.undoRequests);
  // Each call once, though two saved lists may hold it: the same content has the same key.
  const calls = [...new Map(runs.flatMap((run) => run.undoCalls).map((call) => [call.idempotencyKey, call])).values()];
  const undone: CollectionAutomationUndone = {
    reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0,
  };
  // Each action of these runs goes back through the reverse saved for it,
  // newest commit first across every saved list. One with none, which its
  // rules gave no reverse, stays. A saved list can also hold the reverse of
  // an action in a run this Undo leaves out, as Stop and restore leaves out
  // other definitions' runs; that reverse waits for an Undo of its run. The
  // caller checked datasetUndoLostRun, so no saved reverse lacks its run.
  const ranBy = (call: Extract<DatasetUndoCall, { kind: "reverse" }>) => actionsOf(runs).find((action) =>
    action.rules.datasetId === call.rules.datasetId && action.revision === call.revision && action.operationId === call.action);
  const reverses = calls
    .flatMap((call) => {
      if (call.kind !== "reverse") return [];
      const action = ranBy(call);
      return action === undefined ? [] : [{ call, action }];
    })
    .sort((left, right) => left.call.rules.datasetId === right.call.rules.datasetId
      ? right.call.revision - left.call.revision
      : left.call.rules.datasetId < right.call.rules.datasetId ? -1 : 1);
  const reversed = new Set(reverses.map(({ action }) => action));
  undone.actions = actionsOf(runs).filter((action) => !reversed.has(action)).length;
  for (const { call, action } of reverses) {
    signal.throwIfAborted();
    const reverse = reverseOf(host, action);
    // The caller checked datasetUndoRulesChanged; rules that changed since run no other reverse.
    if (reverse?.operationId !== call.operationId || call.operationId !== action.reverseOperationId || !host.resolves(call.rules)) {
      throw new Error(DATASET_UNDO_RULES_CHANGED);
    }
    const result = await send(() => host.invokeAsOwner({ ...call.rules, operationId: call.operationId, input: call.input, idempotencyKey: call.idempotencyKey, signal }));
    if ("refused" in result) throw new Error(`${action.name} was not undone. ${reverse.label} refused: ${result.refused.message}`);
    undone.actionsReversed += 1;
  }
  // Records deleted or already gone, whose fields need nothing more.
  const removed = new Set<string>();
  for (const [key, addition] of additionsOf(runs)) {
    const request = calls.find((candidate): candidate is Extract<DatasetUndoCall, { kind: "delete" }> =>
      candidate.kind === "delete" && datasetRecordKey(candidate.rules.datasetId, candidate.tableId, candidate.recordId) === key);
    signal.throwIfAborted();
    if (request === undefined) {
      // No delete was saved for it: none qualified, or the preview found it changed or gone.
      if (addition.changed) undone.keptChanged += 1;
      else if (addition.deletes.length === 0 || usableDeletes(host, await rosterNow(), collection, addition).length === 0) undone.kept += 1;
      else {
        const version = await versionNow(host, addition, signal);
        undone[version === null ? "gone" : version !== undefined && version !== addition.version ? "keptChanged" : "kept"] += 1;
      }
      continue;
    }
    // Just before it is sent, the delete must still be one every editor can
    // use, under rules that still resolve, as a run checks each record effect.
    const usable = usableDeletes(host, await rosterNow(), collection, addition);
    if (!host.resolves(request.rules) || !usable.some((operation) => operation.operationId === request.operationId)) {
      undone.kept += 1;
      continue;
    }
    const result = await send(() => host.invokeAsOwner({
      ...request.rules, operationId: request.operationId, input: { id: request.recordId, expectedVersion: request.expectedVersion },
      idempotencyKey: request.idempotencyKey, signal,
    }));
    if (!("refused" in result)) {
      undone.deleted += 1;
      removed.add(key);
    } else if (result.refused.code === "not_found") {
      undone.gone += 1;
      removed.add(key);
    } else if (result.refused.code === "stale_record") {
      // Someone changed it since the runs' last write: it stays, and its fields go back below where they can.
      undone.keptChanged += 1;
    } else {
      throw new Error(result.refused.message);
    }
  }
  for (const record of changesOf(host, runs)) {
    if (removed.has(datasetRecordKey(record.last.rules.datasetId, record.last.tableId, record.last.recordId))) continue;
    const changed = record.fields.filter((field) => field.after.length > 0);
    const { definition } = host.revision(record.last.rules.datasetId);
    const table = definition.tables.find((candidate) => candidate.tableId === record.last.tableId);
    const reversible = table === undefined ? [] : changed.filter((field) => field.reversible);
    undone.irreversible += changed.length - reversible.length;
    if (table === undefined) continue;
    // One edit per operation that last wrote some of the record's fields.
    // After the first, the record's version has moved, so the next is
    // refused as stale and reads the record again.
    const byOperation = new Map<string, FieldChange[]>();
    for (const field of reversible) byOperation.set(field.last.operationId, [...(byOperation.get(field.last.operationId) ?? []), field]);
    for (const [operationId, group] of byOperation) {
      signal.throwIfAborted();
      const { rules } = group[0]!.last;
      const call = (called: string, input: JsonObject, idempotencyKey: string) =>
        send(() => host.invokeAsOwner({ ...rules, operationId: called, input, idempotencyKey, signal }));
      const { datasetId } = rules, { tableId, recordId } = record.last;
      // An Undo that stopped part way may have sent this edit again at a newer
      // version. Its last such request goes first: if it landed, it replays,
      // so what it put back is neither written again nor read as changed since.
      const resent = saved.filter((request) => request.datasetId === datasetId && request.tableId === tableId &&
        request.recordId === recordId && request.operationId === operationId).at(-1);
      if (resent !== undefined) {
        const input = { id: recordId, expectedVersion: resent.version, values: resent.values };
        const result = await call(operationId, input, undoKey(claimId, operationId, input));
        const sent = Object.keys(resent.values).length;
        if (!("refused" in result)) {
          undone.reverted += sent;
          undone.changedSince += group.length - sent;
          continue;
        }
        if (result.refused.code !== "stale_record" && result.refused.code !== "not_found") throw new Error(result.refused.message);
      }
      let fields = group;
      let version = record.last.version;
      // An edit that may not have landed, the record's newest or any field's
      // last, leaves the record's version saying nothing about the fields: the
      // record is read first.
      let unread = record.sure && group.every((field) => field.sure);
      const unreadAtStart = unread;
      let checked = false;
      while (fields.length > 0) {
        if (unread) {
          const input = { id: record.last.recordId, expectedVersion: version, values: Object.fromEntries(fields.map((field) => [field.fieldId, field.before])) };
          const result = await call(operationId, input, undoKey(claimId, operationId, input));
          if (!("refused" in result)) {
            undone.reverted += fields.length;
            break;
          }
          if (result.refused.code === "not_found") {
            undone.missing += fields.length;
            break;
          }
          if (result.refused.code !== "stale_record" || checked) throw new Error(result.refused.message);
        }
        unread = true;
        checked = true;
        // The record may have changed since the run: only fields still
        // holding what the runs may have left go back.
        const read = definition.operations
          .filter((candidate) => candidate.kind === "read" && candidate.tableId === table.tableId && fields.every((field) => candidate.fieldIds.includes(field.fieldId)))
          .sort((left, right) => left.fieldIds.length - right.fieldIds.length)[0];
        if (read === undefined) {
          // Fields an edit that may not have landed wrote cannot be checked, so they stay.
          if (!unreadAtStart) {
            undone.irreversible += fields.length;
            break;
          }
          throw new Error(`${table.name} changed, and dohc has no approved read of it to check the record again.`);
        }
        const row = await readDatasetRecord(async (readId, readInput) => {
          const answered = await call(readId, readInput, "automation-undo-read");
          if ("refused" in answered) throw new Error(answered.refused.message);
          return answered.value;
        }, read, table, record.last.recordId);
        if (row === null) {
          undone.missing += fields.length;
          break;
        }
        const holds = (field: FieldChange, value: JsonValue) => isDeepStrictEqual(row.values[field.fieldId] ?? null, value);
        const still = fields.filter((field) => field.after.some((after) => holds(field, after)));
        // A field already back, from an Undo that stopped part way or an edit that never landed, is neither.
        undone.changedSince += fields.filter((field) => !still.includes(field) && !holds(field, field.before)).length;
        fields = still;
        version = row.version;
        if (fields.length > 0) {
          await saveRequest({ datasetId, tableId, recordId, operationId, version, values: Object.fromEntries(fields.map((field) => [field.fieldId, field.before])) });
        }
      }
    }
  }
  return undone;
}
