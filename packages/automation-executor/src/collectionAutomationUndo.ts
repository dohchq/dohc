import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { StoredRun } from "./automationRunStore";
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
  /** Records the run added to a dataset. They stay: the dataset's rules decide what can be deleted. */
  kept: number;
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

interface RecordChanges {
  recordId: string;
  /** Where the run last wrote the record. Records live directly in their Collection's folder. */
  path: string;
  /** Per field, the value before the run's first write and after its last. */
  fields: Map<string, { before: JsonValue; after: JsonValue }>;
}

/** What the runs changed, oldest first: the records they added and each field they wrote. */
function changesOf(runs: readonly StoredRun[]): { added: Map<string, string>; records: Map<string, RecordChanges> } {
  const added = new Map<string, string>();
  const records = new Map<string, RecordChanges>();
  for (const run of [...runs].sort((left, right) => left.startedAtMs - right.startedAtMs)) {
    // A record is listed as created before its fields are written, so one a
    // run stopped after creating is still found.
    for (const created of run.created) added.set(created.recordId, created.path);
    for (const { writes } of run.applied) {
      for (const write of writes) {
        if (write.kind === "created") added.set(write.recordId, write.path);
        if (write.kind !== "field") continue;
        const record = records.get(write.recordId) ?? { recordId: write.recordId, path: write.path, fields: new Map() };
        record.path = write.path;
        const earlier = record.fields.get(write.field);
        record.fields.set(write.field, { before: earlier ? earlier.before : write.before, after: write.after });
        records.set(write.recordId, record);
      }
    }
  }
  return { added, records };
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
 * Undoes what these runs of one claim changed, oldest first, so each field
 * goes back to what it held before the first run. Safe to run again after
 * it stops part way: a field already back where it was is left alone, and
 * an added record already in the trash is not found again.
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
  const undone: CollectionAutomationUndone = { reverted: 0, removed: 0, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 };
  for (const record of records.values()) {
    // A record the run added goes to the trash whole.
    if (added.has(record.recordId)) continue;
    const fields = [...record.fields].filter(([, { before, after }]) => !isDeepStrictEqual(before, after));
    if (fields.length === 0) continue;
    const path = await locate(dependencies, record.path, record.recordId);
    if (path === null) {
      undone.missing += fields.length;
      continue;
    }
    const result = await dependencies.withRecordWrites(signal, (edit) =>
      edit.setFields({
        recordPath: path,
        fields: Object.fromEntries(fields.map(([field, { before }]) => [field, before])),
        // Only a field that still holds what the run wrote goes back.
        expectedBefore: Object.fromEntries(fields.map(([field, { after }]) => [field, after])),
        author: PERSON,
      }),
    );
    undone.reverted += Object.keys(result.replaced).length;
    undone.changedSince += Object.keys(result.kept).length;
  }
  for (const [recordId, path] of added) {
    const current = await locate(dependencies, path, recordId);
    if (current === null) continue;
    await dependencies.trash(current);
    undone.removed += 1;
  }
  return undone;
}
