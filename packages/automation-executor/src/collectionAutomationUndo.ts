import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { StoredRun } from "./automationRunStore";
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

/** What an Undo did, for the sentence its notice shows. */
export interface CollectionAutomationUndone {
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
function changesOf(runs: readonly StoredRun[]): { added: Map<string, string>; records: Map<string, RecordChanges> } {
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
    const unrecorded = unrecordedEffect(run)?.effect;
    if (unrecorded?.kind === "add" && !run.created.some((created) => created.planned === unrecorded.recordId)) {
      added.set(unrecorded.recordId, `${unrecorded.collectionPath}/${unrecorded.name}.md`);
    } else if (unrecorded?.kind === "set") {
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

/** Where the record with `recordId` is now, or null when it left the Collection. */
async function locate(
  dependencies: CollectionAutomationUndoDependencies,
  path: string,
  recordId: string,
): Promise<string | null> {
  const found = await dependencies.withReads(async (reads) => {
    try {
      const { record } = await reads.getCollectionRecord({ collectionPath: posix.dirname(path), recordId, historyLimit: 1 });
      return { path: record.path };
    } catch (error) {
      if (error instanceof Error && error.message === RECORD_NOT_FOUND) return { path: null };
      throw error;
    }
  });
  if (found === null) throw new Error("The workspace engine is not running.");
  return found.path;
}

/**
 * Undoes what these runs of one claim changed: each field goes back, in one
 * write, to what it held before the runs' last unbroken chain of writes to
 * it. Pass every run of the claim, those already undone too. Safe to run
 * again after it stops part way: a field already back is left alone, and an
 * added record already in the trash is not found again.
 */
export async function undoCollectionAutomationRuns(
  dependencies: CollectionAutomationUndoDependencies,
  runs: readonly StoredRun[],
  signal: AbortSignal,
): Promise<CollectionAutomationUndone> {
  // Each run's records are found where their Collections are now. A
  // Collection no longer here keeps its paths, where no record is found.
  const { added, records } = changesOf(runs.map((run) => {
    const moved = structuredClone(run);
    rebaseRun(moved, (collectionId) => dependencies.collectionPathOf(collectionId));
    return moved;
  }));
  const undone: CollectionAutomationUndone = {
    reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0,
  };
  for (const record of records.values()) {
    // A record the run added goes to the trash whole.
    if (added.has(record.recordId)) continue;
    const fields = [...record.fields].map(([field, writes]) => ({ field, ...wayBack(writes) })).filter(({ from }) => from.length > 0);
    if (fields.length === 0) continue;
    const path = await locate(dependencies, record.path, record.recordId);
    if (path === null) {
      undone.missing += fields.length;
      continue;
    }
    // Each field goes back only from a value the runs left it at: first the
    // likeliest, then, for a write the runs did not record, the value before it.
    let pending = fields.map((entry) => ({ ...entry, attempt: 0 }));
    while (pending.length > 0) {
      const result = await dependencies.withRecordWrites(signal, (edit) =>
        edit.setFields({
          recordPath: path,
          fields: Object.fromEntries(pending.map(({ field, to }) => [field, to])),
          expectedBefore: Object.fromEntries(pending.map(({ field, from, attempt }) => [field, from[attempt]])),
          author: PERSON,
        }),
      );
      undone.reverted += Object.keys(result.replaced).length;
      const next: typeof pending = [];
      for (const entry of pending) {
        if (!Object.hasOwn(result.kept, entry.field)) continue;
        const current = result.kept[entry.field] as JsonValue;
        // Already back, from an Undo that stopped part way.
        if (isDeepStrictEqual(current, entry.to)) continue;
        const again = entry.from.findIndex((candidate, index) => index > entry.attempt && isDeepStrictEqual(candidate, current));
        if (again >= 0) next.push({ ...entry, attempt: again });
        else undone.changedSince += 1;
      }
      pending = next;
    }
  }
  for (const [recordId, path] of added) {
    const current = await locate(dependencies, path, recordId);
    if (current === null) continue;
    await dependencies.trash(current);
    undone.removed += 1;
  }
  return undone;
}
