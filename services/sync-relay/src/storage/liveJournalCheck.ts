import type {SqliteDb} from './types';
import {assertJournalCoveragePair, journalCoverageRange} from './liveUpdateJournal';

const documentColumns = 'workspace_id,main_version_id,object_id,lineage_claim_id';
const documentWhere = 'workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?';
const day = 86_400_000;

function* checkPass(db: SqliteDb, reported: Set<string>, report: typeof console.error): Generator<void> {
  const documents = db.prepare(`SELECT ${documentColumns} FROM sync_relay_live_documents
    WHERE (${documentColumns})>(?,?,?,?) ORDER BY ${documentColumns} LIMIT 1`);
  // Each arm seeks through its existing coverage index. Equal keys put baseline first.
  const page = db.prepare(`SELECT b.client_id,b.start_clock,b.end_clock,NULL AS journal_cursor,0 AS source,
      b.workspace_id AS parent_workspace,b.main_version_id AS parent_version,
      b.object_id AS parent_object,b.lineage_claim_id AS parent_lineage
    FROM sync_relay_live_document_baseline_ranges b WHERE ${documentWhere}
      AND (client_id,start_clock)>=(?,?) AND (client_id,start_clock,0)>(?,?,?)
    UNION ALL
    SELECT p.client_id,p.start_clock,p.end_clock,p.journal_cursor,1 AS source,
      j.workspace_id,j.main_version_id,j.object_id,j.lineage_claim_id
    FROM sync_relay_live_update_struct_provenance p
    LEFT JOIN sync_relay_live_update_journal j ON j.journal_cursor=p.journal_cursor
    WHERE p.workspace_id=? AND p.main_version_id=? AND p.object_id=? AND p.lineage_claim_id=?
      AND (p.client_id,p.start_clock)>=(?,?) AND (p.client_id,p.start_clock,1)>(?,?,?)
    ORDER BY client_id,start_clock,source LIMIT 128`);
  let key: unknown[] = ['', '', '', ''];
  for (let raw; (raw = documents.get(...key));) {
    key = [raw.workspace_id, raw.main_version_id, raw.object_id, raw.lineage_claim_id];
    const identity = JSON.stringify(key);
    if (!reported.has(identity)) {
      const document = {workspaceId: String(key[0]), mainVersionId: String(key[1]),
        objectId: String(key[2]), lineageClaimId: String(key[3])};
      let previous: ReturnType<typeof journalCoverageRange> | undefined;
      let after: unknown[] = [-1, -1, -1];
      let damaged = false;
      do {
        const args = [...key, after[0], after[1], ...after];
        const rows = page.all(...args, ...args);
        for (const row of rows) {
          try {
            const range = journalCoverageRange(document, row);
            if (previous) assertJournalCoveragePair(previous, range);
            previous = range;
          } catch {
            reported.add(identity); damaged = true;
            const number = (value: unknown) => typeof value === 'number' ? value : null;
            report('[sync-relay] live journal damaged', {document, firstBadRow: {
              source: row.source === 0 ? 'baseline' : 'provenance', clientId: number(row.client_id),
              startClock: number(row.start_clock), endClock: number(row.end_clock), journalCursor: number(row.journal_cursor),
            }});
            break;
          }
        }
        if (damaged || rows.length < 128) break;
        const last = rows.at(-1)!;
        after = [last.client_id, last.start_clock, last.source];
        yield;
      } while (true);
    }
    yield;
  }
}

export function startLiveJournalCheck(db: SqliteDb, report = console.error) {
  const reported = new Set<string>();
  let pass: Generator<void> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {timer = setTimeout(step, delay); timer.unref();};
  const step = () => {
    try {
      pass ??= checkPass(db, reported, report);
      if (!pass.next().done) {schedule(1); return;}
    } catch {
      report('[sync-relay] live journal check failed');
    }
    pass = undefined;
    schedule(day);
  };
  // Give startup a turn; daily passes bound detection delay without frequent history reads.
  schedule(1000);
  return {close() {clearTimeout(timer); pass?.return(undefined); pass = undefined;}};
}
