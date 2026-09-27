import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { DatasetUndoRequest, RunWrite, StoredRun } from "./automationRunStore";
import type { CollectionAutomationUndone } from "./collectionAutomationUndo";
import { readDatasetRecord, send, type DatasetInvocation, type DatasetRunHost } from "./datasetAutomationRun";

// Undo for a dataset automation's run (AGENTS.md: every reversible change
// gets a way back). Like document Undo, each field the runs wrote goes back
// to what it held before their first write, and only while it still holds
// what their last write left, so an Undo that stops part way never leaves a
// field between two of the runs' writes. It is sent through the approved edit
// that last wrote the field, as the person who clicks Undo, at the version the
// runs left the record. A record someone changed since is refused as stale;
// then only fields that still hold what the runs wrote go back, and the rest
// keep the later change. A field any edit wrote that the rules do not mark
// reversible stays. Records the runs added stay: a dataset's rules decide
// whether a record can be deleted, and an automation does not.
//
// An action goes back through its reverse action, newest first, with the
// undo its own result carried, keyed by the commit it made so a retry
// replays what already went back. The first reverse the dataset refuses
// stops the Undo, since an older action's reverse may expect the state a
// newer one left. An action the rules give no reverse stays. Only a
// dataset whose operations someone wrote has actions, and only a generated
// one runs edits, so one run never mixes the two.

export const DATASET_UNDO_RULES_CHANGED = "Collection rules changed after this run, so dohc cannot undo it.";

/** The dataset host as an Undo uses it: the person's own invocations and the rules now. */
export interface DatasetUndoHost extends Pick<DatasetRunHost, "revision" | "resolves"> {
  /** Invokes an operation as the person who clicked Undo. */
  invokeAsOwner(input: DatasetInvocation): Promise<DatasetInvocationResult>;
}

type Edit = Extract<RunWrite, { kind: "dataset-edit" }>;
type Action = Extract<RunWrite, { kind: "dataset-action" }>;

/** The runs' writes, oldest first. */
function writesOf(runs: readonly StoredRun[]): RunWrite[] {
  return [...runs].sort((left, right) => left.startedAtMs - right.startedAtMs)
    .flatMap((run) => run.applied.flatMap((effect) => effect.writes));
}

function editsOf(runs: readonly StoredRun[]): Edit[] {
  return writesOf(runs).filter((write): write is Edit => write.kind === "dataset-edit");
}

function actionsOf(runs: readonly StoredRun[]): Action[] {
  return writesOf(runs).filter((write): write is Action => write.kind === "dataset-action");
}

/**
 * Whether the rules any of these runs' edits or actions ran under no longer
 * resolve, or now name another reverse for an action than the one it ran
 * with, so Undo must not start.
 */
export function datasetUndoRulesChanged(host: Pick<DatasetRunHost, "resolves" | "revision">, runs: readonly StoredRun[]): boolean {
  if ([...editsOf(runs), ...actionsOf(runs)].some((write) => !host.resolves(write.rules))) return true;
  return actionsOf(runs).some((action) => action.undo !== undefined && reverseOf(host, action)?.operationId !== action.reverseOperationId);
}

/** The reverse the rules name now for an action that ran, or undefined. */
function reverseOf(host: Pick<DatasetRunHost, "revision">, action: Action): DatasetOperation | undefined {
  const { definition } = host.revision(action.rules.datasetId);
  const forward = definition.operations.find((operation) => operation.operationId === action.operationId);
  return definition.operations.find((operation) => operation.name === forward?.reversedBy && operation.kind === "action");
}

interface FieldChange {
  fieldId: string;
  /** The value before the runs' first write, and after their last. */
  before: JsonValue;
  after: JsonValue;
  /** Every edit of the field is one the rules mark reversible. */
  reversible: boolean;
  /** The edit that wrote the field last, whose operation puts it back. */
  last: Edit;
}

/** Per record, the runs' last edit of it and each field they wrote. */
function changesOf(host: DatasetUndoHost, runs: readonly StoredRun[]): Array<{ last: Edit; fields: FieldChange[] }> {
  const records = new Map<string, { last: Edit; fields: Map<string, FieldChange> }>();
  for (const edit of editsOf(runs)) {
    const operation = host.revision(edit.rules.datasetId).definition.operations
      .find((candidate) => candidate.operationId === edit.operationId);
    const key = JSON.stringify([edit.rules.datasetId, edit.tableId, edit.recordId]);
    const record = records.get(key) ?? { last: edit, fields: new Map<string, FieldChange>() };
    record.last = edit;
    for (const field of edit.fields) {
      const earlier = record.fields.get(field.fieldId);
      record.fields.set(field.fieldId, {
        fieldId: field.fieldId,
        before: earlier ? earlier.before : field.before,
        after: field.after,
        reversible: operation?.reversible === true && (earlier?.reversible ?? true),
        last: edit,
      });
    }
    records.set(key, record);
  }
  return [...records.values()].map(({ last, fields }) => ({ last, fields: [...fields.values()] }));
}

// The same content always gets the same key, so a second Undo of a record
// that already went back replays its receipt, and no key carries other content.
function undoKey(claimId: string, operationId: string, input: JsonObject): string {
  return `u.${createHash("sha256").update(JSON.stringify([claimId, operationId, input])).digest("hex")}`;
}

/**
 * Undoes what these runs of one claim changed in a dataset, so each field
 * goes back to what it held before their first write. The caller checks
 * datasetUndoRulesChanged first; an edit whose rules changed since is
 * refused by the host. `saveRequest` saves a request durably before it is
 * sent again at a record's new version; the runs carry what it saved.
 */
export async function undoDatasetAutomationRuns(
  host: DatasetUndoHost,
  claimId: string,
  runs: readonly StoredRun[],
  saveRequest: (request: DatasetUndoRequest) => Promise<void>,
  signal: AbortSignal,
): Promise<CollectionAutomationUndone> {
  const saved = runs.flatMap((run) => run.undoRequests);
  const undone: CollectionAutomationUndone = {
    reverted: 0, removed: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0,
    kept: writesOf(runs).filter((write) => write.kind === "dataset-created").length,
  };
  // Newest commit first, by the revision each made: a clock can move back between two runs.
  const newestFirst = actionsOf(runs).sort((left, right) =>
    left.rules.datasetId === right.rules.datasetId ? right.revision - left.revision : left.rules.datasetId < right.rules.datasetId ? -1 : 1);
  for (const action of newestFirst) {
    signal.throwIfAborted();
    const reverse = reverseOf(host, action);
    if (action.undo === undefined || reverse === undefined) {
      undone.actions += 1;
      continue;
    }
    // The caller checked datasetUndoRulesChanged; rules that changed since run no other reverse.
    if (reverse.operationId !== action.reverseOperationId) throw new Error(DATASET_UNDO_RULES_CHANGED);
    const idempotencyKey = `u.${createHash("sha256").update(JSON.stringify(["dohc-action-undo-v1", claimId, action.rules.datasetId, action.revision, action.operationId])).digest("hex")}`;
    const result = await send(() => host.invokeAsOwner({ ...action.rules, operationId: reverse.operationId, input: action.undo!, idempotencyKey, signal }));
    if ("refused" in result) throw new Error(`${action.name} was not undone. ${reverse.label} refused: ${result.refused.message}`);
    undone.actionsReversed += 1;
  }
  for (const record of changesOf(host, runs)) {
    const changed = record.fields.filter((field) => !isDeepStrictEqual(field.before, field.after));
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
      for (let attempt = 0; fields.length > 0; attempt += 1) {
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
        if (result.refused.code !== "stale_record" || attempt > 0) throw new Error(result.refused.message);
        // Someone changed the record since the run: only fields still holding
        // what the run wrote go back.
        const read = definition.operations
          .filter((candidate) => candidate.kind === "read" && candidate.tableId === table.tableId && fields.every((field) => candidate.fieldIds.includes(field.fieldId)))
          .sort((left, right) => left.fieldIds.length - right.fieldIds.length)[0];
        if (read === undefined) throw new Error(`${table.name} changed, and dohc has no approved read of it to check the record again.`);
        const row = await readDatasetRecord(async (readId, readInput) => {
          const answered = await call(readId, readInput, "automation-undo-read");
          if ("refused" in answered) throw new Error(answered.refused.message);
          return answered.value;
        }, read, table, record.last.recordId);
        if (row === null) {
          undone.missing += fields.length;
          break;
        }
        const still = fields.filter((field) => isDeepStrictEqual(row.values[field.fieldId] ?? null, field.after));
        undone.changedSince += fields.length - still.length;
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
