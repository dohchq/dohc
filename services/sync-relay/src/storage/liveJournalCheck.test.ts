import {DatabaseSync} from 'node:sqlite';
import {afterEach, expect, it, vi} from 'vitest';
import {startLiveJournalCheck} from './liveJournalCheck';
import type {SqliteDb} from './types';

const key = ['workspace', 'main', 'object', 'a'.repeat(64)];
const document = {workspaceId: key[0], mainVersionId: key[1], objectId: key[2], lineageClaimId: key[3]};
const databases: DatabaseSync[] = [];
afterEach(() => {vi.useRealTimers(); for (const db of databases.splice(0)) db.close();});

function fixture(rows = 0) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  // Only the columns the cold reader uses; the integration test uses the real relay schema.
  db.exec(`CREATE TABLE sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id,
    PRIMARY KEY(workspace_id,main_version_id,object_id,lineage_claim_id));
    CREATE TABLE sync_relay_live_update_journal(journal_cursor INTEGER PRIMARY KEY,workspace_id,main_version_id,object_id,lineage_claim_id);
    CREATE TABLE sync_relay_live_update_struct_provenance(workspace_id,main_version_id,object_id,lineage_claim_id,
    client_id,start_clock,end_clock,journal_cursor,PRIMARY KEY(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock));
    CREATE TABLE sync_relay_live_document_baseline_ranges(workspace_id,main_version_id,object_id,lineage_claim_id,
    client_id,start_clock,end_clock,PRIMARY KEY(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock));`);
  db.prepare('INSERT INTO sync_relay_live_documents VALUES(?,?,?,?)').run(...key);
  const journal = db.prepare('INSERT INTO sync_relay_live_update_journal VALUES(?,?,?,?,?)');
  const range = db.prepare('INSERT INTO sync_relay_live_update_struct_provenance VALUES(?,?,?,?,?,?,?,?)');
  for (let i = 0; i < rows; i++) {
    journal.run(i + 1, ...key); range.run(...key, 91, i, i + 1, i + 1);
  }
  return db as unknown as SqliteDb;
}

it('reports clean journals silently, yields between bounded pages and documents, and cancels pending work', async () => {
  const db = fixture(1024), report = vi.fn();
  db.prepare('INSERT INTO sync_relay_live_documents VALUES(?,?,?,?)').run(...key.slice(0, 2), 'second', key[3]);
  const originalPrepare = db.prepare.bind(db), counts: number[] = [];
  const prepare = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = originalPrepare(sql);
    if (sql.includes('UNION ALL')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {const rows = all(...args); counts.push(rows.length); return rows;};
    }
    return statement;
  });
  vi.useFakeTimers();
  const check = startLiveJournalCheck(db, report);
  expect(prepare).not.toHaveBeenCalled(); // Starting the service does no database work.
  await vi.advanceTimersToNextTimerAsync();
  const reads = prepare.mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  expect(counts).toEqual([128]);
  const sql = prepare.mock.calls.find(([sql]) => sql.includes('UNION ALL'))![0];
  const args = [...key, -1, -1, -1, -1, -1];
  const plan = originalPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args, ...args).map(row => row.detail).join('; ');
  expect(plan).toMatch(/SEARCH b /);
  expect(plan).toMatch(/SEARCH p /);
  expect(plan).not.toMatch(/SCAN (?:b|p) /);
  expect(vi.getTimerCount()).toBe(1); // More slices are pending after the first turn.
  let requestRan = false;
  setTimeout(() => {requestRan = true;}, 0);
  await vi.advanceTimersToNextTimerAsync();
  expect(requestRan).toBe(true);
  expect(report).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1024);
  expect(Math.max(...counts)).toBe(128);
  expect(report).not.toHaveBeenCalled();
  expect(prepare.mock.calls.some(([sql]) => sql.includes('LIMIT 1'))).toBe(true);
  // Next day's pass starts, then close interrupts it between pages.
  await vi.advanceTimersToNextTimerAsync();
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1024 + 128);
  check.close();
  const atClose = prepare.mock.calls.length, pagesAtClose = counts.length;
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(prepare).toHaveBeenCalledTimes(atClose);
  expect(counts).toHaveLength(pagesAtClose);
  expect(vi.getTimerCount()).toBe(0);
  expect(report).not.toHaveBeenCalled();
});

it.each(['overlap', 'adjacency', 'parent', 'baseline', 'boundary'])(
  'reports the first bad %s row without content and only once across scheduled passes', async kind => {
    const db = fixture(256), report = vi.fn();
    if (kind === 'overlap') db.exec('UPDATE sync_relay_live_update_struct_provenance SET end_clock=3 WHERE start_clock=0');
    if (kind === 'adjacency') db.exec('UPDATE sync_relay_live_update_struct_provenance SET journal_cursor=1 WHERE start_clock=1');
    if (kind === 'parent') db.exec("UPDATE sync_relay_live_update_journal SET workspace_id='wrong' WHERE journal_cursor=2");
    if (kind === 'baseline') db.prepare('INSERT INTO sync_relay_live_document_baseline_ranges VALUES(?,?,?,?,?,?,?)').run(...key, 91, 1, 2);
    if (kind === 'boundary') db.exec('UPDATE sync_relay_live_update_struct_provenance SET end_clock=129 WHERE start_clock=127');
    vi.useFakeTimers();
    const check = startLiveJournalCheck(db, report);
    try {
      await vi.advanceTimersByTimeAsync(1100);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]).toEqual(['[sync-relay] live journal damaged', {
        document, firstBadRow: {source: 'provenance', clientId: 91, startClock: kind === 'boundary' ? 128 : 1,
          endClock: kind === 'boundary' ? 129 : 2,
          journalCursor: kind === 'adjacency' ? 1 : kind === 'boundary' ? 129 : 2},
      }]);
      await vi.advanceTimersByTimeAsync(86_400_100);
      expect(report).toHaveBeenCalledTimes(1);
      check.close();
      const restarted = startLiveJournalCheck(db, report);
      try {
        await vi.advanceTimersByTimeAsync(1100);
        expect(report).toHaveBeenCalledTimes(2);
      } finally {restarted.close();}
    } finally {check.close();}
  },
);

it('cancels before the delayed first pass', async () => {
  const db = fixture(256), prepare = vi.spyOn(db, 'prepare');
  vi.useFakeTimers();
  startLiveJournalCheck(db).close();
  await vi.advanceTimersByTimeAsync(100_000_000);
  expect(prepare).not.toHaveBeenCalled();
});
