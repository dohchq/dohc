import {DatabaseSync} from 'node:sqlite';
import {afterEach, expect, it, vi} from 'vitest';
import {startLiveJournalCheck} from './liveJournalCheck';
import {initializeSyncRelaySchema} from './schema';
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
    if (sql.includes('SELECT') && /FROM sync_relay_live_(?:document_baseline_ranges|update_struct_provenance)/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {const rows = all(...args); if (rows.length) counts.push(rows.length); return rows;};
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
        previousRow: {source: kind === 'baseline' ? 'baseline' : 'provenance', clientId: 91,
          startClock: kind === 'boundary' ? 127 : kind === 'baseline' ? 1 : 0,
          endClock: kind === 'boundary' ? 129 : kind === 'baseline' ? 2 : kind === 'overlap' ? 3 : 1,
          journalCursor: kind === 'baseline' ? null : kind === 'boundary' ? 128 : 1},
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

it.each(['ERR_OUT_OF_RANGE', undefined])('continues past an unreadable document and logs only its code or name (%s)', async code => {
  const db = fixture(1), report = vi.fn(), originalPrepare = db.prepare.bind(db);
  db.exec('UPDATE sync_relay_live_update_struct_provenance SET end_clock=3 WHERE start_clock=0');
  const second = [...key.slice(0, 2), 'second', key[3]];
  db.prepare('INSERT INTO sync_relay_live_documents VALUES(?,?,?,?)').run(...second);
  db.prepare('INSERT INTO sync_relay_live_document_baseline_ranges VALUES(?,?,?,?,?,?,?)').run(...second, -2, 0, 1);
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = originalPrepare(sql), all = statement.all.bind(statement);
    if (sql.includes('SELECT') && sql.includes('FROM sync_relay_live_update_struct_provenance')) {
      statement.all = (...args) => {
        if (args[2] === key[2]) throw Object.assign(new RangeError('private document content'), {code, errcode: '5'});
        return all(...args);
      };
    }
    return statement;
  });
  vi.useFakeTimers();
  const check = startLiveJournalCheck(db, report);
  try {
    await vi.advanceTimersByTimeAsync(1100);
    expect(report.mock.calls[0]).toEqual(['[sync-relay] live journal unreadable', {document, errorCode: code ?? 'RangeError'}]);
    expect(report.mock.calls[1]?.[0]).toBe('[sync-relay] live journal damaged');
    expect(report.mock.calls[1]?.[1].document.objectId).toBe('second');
    expect(JSON.stringify(report.mock.calls)).not.toContain('private document content');
    await vi.advanceTimersByTimeAsync(86_400_100);
    expect(report).toHaveBeenCalledTimes(3);
    expect(report.mock.calls[2]?.[0]).toBe('[sync-relay] live journal unreadable');
  } finally {check.close();}
});

it('retries a transient page-read failure on the next daily pass and reports damage once', async () => {
  const db = fixture(2), report = vi.fn(), originalPrepare = db.prepare.bind(db);
  const read = vi.fn();
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = originalPrepare(sql), all = statement.all.bind(statement);
    if (sql.includes('FROM sync_relay_live_update_struct_provenance')) statement.all = (...args) => {
      read();
      if (read.mock.calls.length === 1) throw Object.assign(new Error('busy'), {code: 'ERR_SQLITE_ERROR', errcode: 5});
      return all(...args);
    };
    return statement;
  });
  vi.useFakeTimers();
  const check = startLiveJournalCheck(db, report);
  try {
    await vi.advanceTimersByTimeAsync(1100);
    expect(read).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBe('[sync-relay] live journal unreadable');
    db.exec('UPDATE sync_relay_live_update_struct_provenance SET end_clock=3 WHERE start_clock=0');
    await vi.advanceTimersByTimeAsync(86_400_100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]?.[0]).toBe('[sync-relay] live journal damaged');
    expect(report.mock.calls[1]?.[1].document).toEqual(document);
    await vi.advanceTimersByTimeAsync(86_400_100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
  } finally {check.close();}
});

it.each(['page', 'document-list'])('keeps distinct numeric SQLite codes for %s failures', async kind => {
  const db = fixture(1), report = vi.fn(), originalPrepare = db.prepare.bind(db);
  const faults = [5, 11].map(errcode => Object.assign(new Error('private content'), {code: 'ERR_SQLITE_ERROR', errcode}));
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (kind === 'document-list') throw faults.shift();
    const statement = originalPrepare(sql);
    if (sql.includes('FROM sync_relay_live_update_struct_provenance')) statement.all = () => {throw faults.shift();};
    return statement;
  });
  vi.useFakeTimers();
  const check = startLiveJournalCheck(db, report);
  try {
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(86_400_100);
    const label = kind === 'page' ? '[sync-relay] live journal unreadable' : '[sync-relay] live journal check failed';
    expect(report.mock.calls).toEqual([5, 11].map(errcode => [label, {
      ...(kind === 'page' ? {document} : {}), errorCode: 'ERR_SQLITE_ERROR', errcode,
    }]));
    expect(JSON.stringify(report.mock.calls)).not.toContain('private content');
  } finally {check.close();}
});

it('reports the code of a document-list failure without its message', async () => {
  const db = fixture(), report = vi.fn();
  vi.spyOn(db, 'prepare').mockImplementation(() => {throw Object.assign(new Error('private content'), {code: 'SQLITE_CORRUPT'});});
  vi.useFakeTimers();
  const check = startLiveJournalCheck(db, report);
  try {
    await vi.advanceTimersByTimeAsync(1100);
    expect(report).toHaveBeenCalledExactlyOnceWith('[sync-relay] live journal check failed', {errorCode: 'SQLITE_CORRUPT'});
  } finally {check.close();}
});

it.each(['baseline', 'provenance'])('reads invalid values below the old first-page sentinel (%s)', async source => {
  const db = fixture(1), report = vi.fn();
  if (source === 'baseline') db.prepare('INSERT INTO sync_relay_live_document_baseline_ranges VALUES(?,?,?,?,?,?,?)').run(...key, -2, 0, 1);
  else db.exec('UPDATE sync_relay_live_update_struct_provenance SET client_id=-2');
  vi.useFakeTimers();
  const check = startLiveJournalCheck(db, report);
  try {
    await vi.advanceTimersByTimeAsync(1100);
    expect(report).toHaveBeenCalledExactlyOnceWith('[sync-relay] live journal damaged', {document,
      firstBadRow: {source, clientId: -2, startClock: 0, endClock: 1, journalCursor: source === 'baseline' ? null : 1},
      previousRow: undefined});
  } finally {check.close();}
});

it('seeks late pages on both real coverage indexes without a temporary order-by tree', async () => {
  const db = fixture(1024), originalPrepare = db.prepare.bind(db);
  const real = new DatabaseSync(':memory:'); databases.push(real);
  initializeSyncRelaySchema(real as unknown as SqliteDb);
  const plans = new Map<string, string[]>();
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = originalPrepare(sql), all = statement.all.bind(statement);
    if (sql.includes('SELECT') && /FROM sync_relay_live_(?:document_baseline_ranges|update_struct_provenance)/.test(sql)) {
      statement.all = (...args) => {
        const details = real.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]).map(row => String(row.detail));
        expect(details.join('; ')).not.toContain('USE TEMP B-TREE FOR');
        if (args.length > key.length * 2) plans.set(sql, details);
        return all(...args);
      };
    }
    return statement;
  });
  vi.useFakeTimers();
  const report = vi.fn(), check = startLiveJournalCheck(db, report);
  try {
    await vi.advanceTimersByTimeAsync(1100);
    expect(report).not.toHaveBeenCalled();
    for (const alias of ['b', 'p']) {
      const matching = [...plans.values()].filter(details => details.some(detail => detail.includes(`SEARCH ${alias} `)));
      expect(matching.length).toBeGreaterThan(0);
      for (const details of matching) {
        expect(details.find(detail => detail.startsWith(`SEARCH ${alias} `))).toMatch(/\(client_id,start_clock\)>\(\?,\?\)/);
        expect(details.join('; ')).not.toContain('USE TEMP B-TREE FOR');
      }
    }
  } finally {check.close();}
});

it('cancels before the delayed first pass', async () => {
  const db = fixture(256), prepare = vi.spyOn(db, 'prepare');
  vi.useFakeTimers();
  startLiveJournalCheck(db).close();
  await vi.advanceTimersByTimeAsync(100_000_000);
  expect(prepare).not.toHaveBeenCalled();
});
