import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { LocalDatasetInvocation } from "../workspaces/localDatasetHost";
import type { DatasetUndoRequest, RunWrite, StoredRun } from "./automationRunStore";
import type { CollectionAutomationUndone } from "./collectionAutomationUndo";
import { readDatasetRecord, send, type DatasetRunHost } from "./datasetAutomationRun";

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

export const DATASET_UNDO_RULES_CHANGED = "Collection rules changed after this run, so dohc cannot undo it.";

/** The dataset host as an Undo uses it: the person's own invocations and the rules now. */
export interface DatasetUndoHost extends Pick<DatasetRunHost, "revision" | "resolves"> {
  /** Invokes an operation as the person who clicked Undo. */
  invokeAsOwner(input: LocalDatasetInvocation): Promise<DatasetInvocationResult>;
}

type Edit = Extract<RunWrite, { kind: "dataset-edit" }>;

/** The runs' writes, oldest first. */
function writesOf(runs: readonly StoredRun[]): RunWrite[] {
  return [...runs].sort((left, right) => left.startedAtMs - right.startedAtMs)
    .flatMap((run) => run.applied.flatMap((effect) => effect.writes));
}

function editsOf(runs: readonly StoredRun[]): Edit[] {
  return writesOf(runs).filter((write): write is Edit => write.kind === "dataset-edit");
}

/** Whether the rules any of these runs' edits ran under no longer resolve, so Undo must not start. */
export function datasetUndoRulesChanged(host: Pick<DatasetRunHost, "resolves">, runs: readonly StoredRun[]): boolean {
  return editsOf(runs).some((edit) => !host.resolves(edit.rules));
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
    reverted: 0, removed: 0, changedSince: 0, missing: 0, irreversible: 0,
    kept: writesOf(runs).filter((write) => write.kind === "dataset-created").length,
  };
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
