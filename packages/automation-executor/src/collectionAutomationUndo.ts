import { receiptRuns, type AutomationSetBatches } from "./automationSetBatches";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { StoredRun, UndoKeptField, UndoWrite } from "./automationRunStore";
import { sharedFileUpdateKey, sharedReversalsOf } from "./automationRunStore";
import { unrecordedEffect } from "./automationStepRun";
import { rebaseRun, type CollectionAutomationReads, type CollectionRecordWrites } from "./collectionAutomationRun";

// Undo for one run of a Collection automation (AGENTS.md: every reversible
// change gets a way back). A field goes back to what it held before the run
// only while it still holds what the run wrote, so a later change by anyone
// stays. Records the run added move to the workspace trash, where the person
// can restore them. The writes are the person's own edits, recorded as any
// hand edit from this computer is.

const RECORD_NOT_FOUND = "collection-record-not-found";
const PERSON: ChangeAuthor = { kind: "user", userId: "local" };

/** A record with a sync conflict, which the engine will not let Undo write until someone resolves it. */
class RecordConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} has a sync conflict. Resolve the conflict, then try again.`);
  }
}

/** What an Undo did, for the sentence its notice shows. */
export interface CollectionAutomationUndone {
  sharedReversals?: Array<UndoWrite & { state: "pending" | "not-accepted" }>;
  /** Fields written back to their value before the run. */
  reverted: number;
  /** Records the run added, moved to the trash. */
  removed: number;
  /** Records the run added to a dataset, deleted through an approved delete. The dataset keeps no trash. */
  deleted: number;
  /** Records the run added to a dataset that stay, because no approved delete every editor can use qualifies. */
  kept: number;
  /** Records the run added to a dataset that stay, because someone else changed them. */
  keptChanged: number;
  /** Records the run added to a dataset that were already gone. */
  gone: number;
  /** Fields someone changed after the run, left as they are. */
  changedSince: number;
  /** Fields on records that are no longer in their Collection. */
  missing: number;
  /** Fields a dataset edit changed whose rules do not let it be undone. */
  irreversible: number;
  /** Dataset actions the runs ran whose rules give no reverse. Their changes stay. */
  actions: number;
  /** Dataset actions their reverse actions undid. */
  actionsReversed: number;
}

export interface CollectionAutomationUndoDependencies {
  lookupBatch?: AutomationSetBatches["lookup"];
  recordReversal?(write: UndoWrite): Promise<void>;
  /** Engine reads; resolves null when the engine is unavailable. */
  withReads<T>(work: (reads: CollectionAutomationReads) => Promise<T>): Promise<T | null>;
  withRecordWrites<T>(signal: AbortSignal, work: (writes: CollectionRecordWrites) => Promise<T>): Promise<T>;
  /** Moves a file to the trash the way a person's delete does. */
  trash(path: string): Promise<void>;
  /** Where the document Collection with this id is now, or null when this workspace has none. */
  collectionPathOf(collectionId: string): string | null;
}

/** One write of one field, oldest first; `sure` is false for one a stopped run may have made without recording it. */
type FieldWrite = { before: JsonValue; after: JsonValue; sure: boolean };

interface RecordChanges {
  recordId: string;
  /** Where the runs last wrote the record. Records live directly in their Collection's folder. */
  path: string;
  /** Each field's writes by the runs, oldest first. */
  fields: Map<string, FieldWrite[]>;
}

/**
 * What the runs changed, oldest first: the records they added, and each
 * field they wrote. That includes the effect a stopped run may have landed
 * without recording it. A record such an effect may have added is among
 * `added`, and is found only if it exists.
 */
export function documentUndoChanges(runs: readonly StoredRun[]): { added: Map<string, string>; records: Map<string, RecordChanges> } {
  const added = new Map<string, string>();
  const records = new Map<string, RecordChanges>();
  const wrote = (recordId: string, path: string, field: string, write: FieldWrite) => {
    const record = records.get(recordId) ?? { recordId, path, fields: new Map<string, FieldWrite[]>() };
    record.path = path;
    record.fields.set(field, [...(record.fields.get(field) ?? []), write]);
    records.set(recordId, record);
  };
  for (const run of [...runs].sort((left, right) => left.startedAtMs - right.startedAtMs)) {
    // A record is listed as created before its fields are written, so one a
    // run stopped after creating is still found.
    for (const created of run.created) added.set(created.recordId, created.path);
    for (const { writes } of run.applied) {
      for (const write of writes) {
        if (write.kind === "created") added.set(write.recordId, write.path);
        if (write.kind === "field") wrote(write.recordId, write.path, write.field, { before: write.before, after: write.after, sure: true });
      }
    }
    const position = unrecordedEffect(run);
    const unrecorded = position?.effect;
    if (unrecorded?.kind === "add" && !run.created.some((created) => created.planned === unrecorded.recordId)) {
      added.set(unrecorded.recordId, `${unrecorded.collectionPath}/${unrecorded.name}.md`);
    } else if (unrecorded?.kind === "set" && !run.steps.some(step => step.ordinal === position?.ordinal && step.batches?.some(batch =>
      !batch.abandoned && batch.part <= position.part && position.part < batch.part + batch.count))) {
      for (const { field, before, after } of unrecorded.fields) wrote(unrecorded.target.recordId, unrecorded.target.path, field, { before, after, sure: false });
    }
  }
  return { added, records };
}

/**
 * How one field goes back: to what it held before the runs' last unbroken
 * chain of writes, from each value the chain may have left it at. A write
 * that found someone else's value starts the chain again, so Undo puts back
 * theirs. A write the runs did not record may not have landed, so the chain
 * may end at its before value too. Undo writes the field once, from what the
 * chain left straight to that value, so an Undo that stops part way leaves
 * each field where it was or where it goes.
 */
function wayBack(writes: readonly FieldWrite[]): { to: JsonValue; from: JsonValue[] } {
  const last = writes.at(-1)!;
  const from = last.sure ? [last.after] : [last.after, last.before];
  let value = last.before;
  for (let index = writes.length - 2; index >= 0; index -= 1) {
    const earlier = writes[index]!;
    if (isDeepStrictEqual(earlier.after, value)) value = earlier.before;
    // An unrecorded write the next one did not find never landed.
    else if (!earlier.sure && isDeepStrictEqual(earlier.before, value)) continue;
    else break;
  }
  return { to: value, from: from.filter((candidate) => !isDeepStrictEqual(candidate, value)) };
}

/** Where the record with `recordId` is now and whether it has a sync conflict, or null when it left the Collection. */
async function locate(
  dependencies: CollectionAutomationUndoDependencies,
  path: string,
  recordId: string,
): Promise<{ path: string; conflicted: boolean } | null> {
  const found = await dependencies.withReads(async (reads) => {
    try {
      const { record } = await reads.getCollectionRecord({ collectionPath: posix.dirname(path), recordId, historyLimit: 1 });
      return { record: { path: record.path, conflicted: record.conflicted } };
    } catch (error) {
      if (error instanceof Error && error.message === RECORD_NOT_FOUND) return { record: null };
      throw error;
    }
  });
  if (found === null) throw new Error("The workspace engine is not running.");
  return found.record;
}

/**
 * Undoes what these runs of one claim changed: each field goes back, in one
 * write, to what it held before the runs' last unbroken chain of writes to
 * it. Pass every run of the claim, those already undone too. Safe to run
 * again after it stops part way: a field already back is left alone, and an
 * added record already in the trash is not found again.
 * `only` retries fields kept by an earlier Undo.
 */
export async function undoCollectionAutomationRuns(
  dependencies: CollectionAutomationUndoDependencies,
  runs: readonly StoredRun[],
  signal: AbortSignal,
  only?: ReadonlyArray<{ recordId: string; field: string }>,
  onlyRecordId?: string,
  prepared?: ReturnType<typeof documentUndoChanges>,
): Promise<{ undone: CollectionAutomationUndone; keptFields: UndoKeptField[]; undoWrites: UndoWrite[] }> {
  if (!prepared) runs = await receiptRuns(runs, dependencies.lookupBatch);
  // Each run's records are found where their Collections are now. A
  // Collection no longer here keeps its paths, where no record is found.
  const { added, records } = prepared ?? documentUndoChanges(runs.map((run) => {
    const moved = structuredClone(run);
    rebaseRun(moved, (collectionId) => dependencies.collectionPathOf(collectionId));
    return moved;
  }));
  const undone: CollectionAutomationUndone = {
    reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0,
  };
  const keptFields: UndoKeptField[] = [];
  const undoWrites = [...new Map(runs.flatMap(run => run.undoWrites ?? []).map(write =>
    [JSON.stringify([write.recordId, write.field]), write])).values()]
    .filter(write => onlyRecordId === undefined || write.recordId === onlyRecordId);
  const refusedReversals = sharedReversalsOf(runs).filter(write => write.state === "not-accepted");
  const refusedFields = new Set(refusedReversals.map(write => JSON.stringify([write.recordId, write.field])));
  const recordedFields = new Set(undoWrites.map(write => JSON.stringify([write.recordId, write.field])));
  const tried = only ? new Set(only.map(({ recordId, field }) => JSON.stringify([recordId, field]))) : null;
  for (const record of records.values()) {
    if (onlyRecordId !== undefined && record.recordId !== onlyRecordId) continue;
    // A record the run added goes to the trash whole.
    if (added.has(record.recordId) && tried === null) continue;
    const fields = [...record.fields].map(([field, writes]) => ({ field, ...wayBack(writes) })).filter(({ field, from }) => {
      const key = JSON.stringify([record.recordId, field]);
      return from.length > 0 && (tried === null || tried.has(key)) &&
        (!recordedFields.has(key) || refusedFields.has(key));
    });
    if (fields.length === 0) continue;
    const found = await locate(dependencies, record.path, record.recordId);
    if (found === null) {
      undone.missing += fields.length;
      continue;
    }
    // The engine refuses to open a record with a sync conflict.
    if (found.conflicted) throw new RecordConflictError(found.path);
    const path = found.path;
    // Each field goes back only from a value the runs left it at: first the
    // likeliest, then, for a write the runs did not record, the value before it.
    let pending = fields.map((entry) => ({ ...entry, attempt: 0 }));
    while (pending.length > 0) {
      let result: Awaited<ReturnType<CollectionRecordWrites["setFields"]>>;
      try {
        result = await dependencies.withRecordWrites(signal, (edit) =>
          edit.setFields({
            recordPath: path,
            fields: Object.fromEntries(pending.map(({ field, to }) => [field, to])),
            expectedBefore: Object.fromEntries(pending.map(({ field, from, attempt }) => [field, from[attempt]])),
            idempotencyKeyPrefix: `automation-undo/${createHash("sha256").update(JSON.stringify([
              runs.map(run => JSON.stringify([run.automationId, run.claimId, run.keySeed])).sort(), record.recordId,
              refusedReversals.filter(write => write.recordId === record.recordId)
                .map(write => JSON.stringify([write.field, sharedFileUpdateKey(write.draft)])).sort(),
            ])).digest("hex")}`,
            author: PERSON,
          }),
        );
      } catch (error) {
        // A conflict that opened since the read above: the engine refuses
        // without naming it, so read the record again to say what to do.
        const now = await locate(dependencies, path, record.recordId).catch(() => null);
        if (now?.conflicted) throw new RecordConflictError(now.path);
        throw error;
      }
      for (const field of new Set([...Object.keys(result.replaced), ...Object.keys(result.sharedFileUpdates ?? {})])) {
        const draft = result.sharedFileUpdates?.[field];
        if (!draft && Object.hasOwn(result.replaced, field)) undone.reverted += 1;
        const prior = undoWrites.findIndex(write => write.recordId === record.recordId && write.field === field);
        if (prior >= 0) undoWrites.splice(prior, 1);
        if (draft) {
          const write = { recordId: record.recordId, field, draft };
          await dependencies.recordReversal?.(write);
          undoWrites.push(write);
        }
      }
      const next: typeof pending = [];
      for (const entry of pending) {
        if (!Object.hasOwn(result.kept, entry.field)) continue;
        const current = result.kept[entry.field] as JsonValue;
        // Already back, from an Undo that stopped part way.
        if (isDeepStrictEqual(current, entry.to)) continue;
        const again = entry.from.findIndex((candidate, index) => index > entry.attempt && isDeepStrictEqual(candidate, current));
        if (again >= 0) next.push({ ...entry, attempt: again });
        else {
          undone.changedSince += 1;
          // Document field names are also their identity; datasets use separate field ids.
          keptFields.push({ recordId: record.recordId, field: entry.field, path, fieldName: entry.field, datasetRecordId: null });
        }
      }
      pending = next;
    }
  }
  if (tried !== null) return { undone, keptFields, undoWrites };
  for (const [recordId, path] of added) {
    if (onlyRecordId !== undefined && recordId !== onlyRecordId) continue;
    const current = await locate(dependencies, path, recordId);
    if (current === null) continue;
    await dependencies.trash(current.path);
    undone.removed += 1;
  }
  return { undone, keptFields, undoWrites };
}
