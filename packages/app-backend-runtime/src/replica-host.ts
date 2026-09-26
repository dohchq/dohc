import type { DatasetCursor, DatasetJournal, DatasetScope, JournalExportRecord } from "./journal.js";
import { equalRecoveryCursor, parseRecoveryCursor, parseRecoveryJournalRecord } from "./recovery-record.js";

export interface DatasetReplicaCapture {
  head: DatasetCursor;
  checkpoint: Extract<JournalExportRecord, { kind: "checkpoint" }>;
}
export interface DatasetReplicaPage {
  through: DatasetCursor;
  after: DatasetCursor;
  records: JournalExportRecord[];
}

/** These unfiltered committed bytes are available only to the workspace owner. */
export function createDatasetReplicaHost<Context>(options: {
  journal: DatasetJournal;
  owner(context: Context, scope: DatasetScope): unknown;
}) {
  function access(context: Context, scope: DatasetScope) {
    const token = JSON.stringify(options.owner(context, scope));
    return () => { if (JSON.stringify(options.owner(context, scope)) !== token) throw Error("Collection access changed. Reopen the workspace."); };
  }
  function scoped(scope: DatasetScope, raw: DatasetCursor) {
    const cursor = parseRecoveryCursor(raw);
    if (cursor.workspaceId !== scope.workspaceId || cursor.datasetId !== scope.datasetId) throw Error("This Collection copy belongs to another Collection.");
    return cursor;
  }
  return {
    replicaCapture(context: Context, scope: DatasetScope): DatasetReplicaCapture {
      const authorize = access(context, scope);
      const capture = options.journal.captureExport({ scope, authorize, capture: () => null });
      authorize();
      return { head: capture.cursor, checkpoint: capture.checkpoint };
    },
    replicaPage(context: Context, input: DatasetScope & { through: DatasetCursor; after: DatasetCursor; limit?: number }): DatasetReplicaPage {
      const authorize = access(context, input), through = scoped(input, input.through), after = scoped(input, input.after);
      const [previous] = options.journal.exportPage({ scope: input, through, afterRevision: after.revision - 1, limit: 1, authorize });
      if (!previous || !equalRecoveryCursor(previous.cursor, after)) throw Error("The Collection copy changed. Download it again.");
      const records = options.journal.exportPage({ scope: input, through, afterRevision: after.revision, limit: input.limit, authorize });
      authorize(); return { through, after, records };
    },
    replicaBlob(context: Context, input: DatasetScope & { record: JournalExportRecord; offset: number; length?: number }): Uint8Array {
      const authorize = access(context, input);
      scoped(input, input.record.cursor);
      const [record] = options.journal.exportPage({ scope: input, through: input.record.cursor, afterRevision: input.record.cursor.revision - 1, limit: 1, authorize });
      if (!record || JSON.stringify(parseRecoveryJournalRecord(record)) !== JSON.stringify(parseRecoveryJournalRecord(input.record))) throw Error("The Collection record changed.");
      const bytes = options.journal.exportBlob({ scope: input, record, offset: input.offset, length: input.length, authorize });
      authorize(); return bytes;
    },
  };
}
