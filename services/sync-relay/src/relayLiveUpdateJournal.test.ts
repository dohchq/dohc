import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSyncRelayStorage } from './storage.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
const marker = 'live-update-journal-v1';
const journal = 'sync_relay_live_update_journal';
const provenance = 'sync_relay_live_update_struct_provenance';
const objects = [journal, provenance, 'idx_sync_relay_live_update_journal_document',
  'idx_sync_relay_live_update_journal_checkpoint', 'idx_sync_relay_live_update_struct_provenance_coverage',
  'idx_sync_relay_live_update_struct_provenance_journal'];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dohc-journal-schema-')); roots.push(root);
  const path = join(root, 'relay.sqlite'); openSyncRelayStorage(path).close();
  const raw = new DatabaseSync(path);
  const snapshot = () => ({ schema: raw.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
    markers: raw.prepare('SELECT * FROM sync_relay_migrations ORDER BY migration_id').all() });
  return { path, raw, snapshot };
}
it('creates all six journal objects and reopens without mutation', () => {
  const f = fixture();
  try {
    expect(f.raw.prepare('SELECT name FROM sqlite_schema WHERE name IN (?,?,?,?,?,?) ORDER BY name').all(...objects)
      .map(row => row.name)).toEqual([...objects].sort());
    expect(f.raw.prepare('SELECT completed_at_ms FROM sync_relay_migrations WHERE migration_id=?').get(marker))
      .toEqual({ completed_at_ms: expect.any(Number) });
    expect(f.raw.prepare(`PRAGMA foreign_key_list(${provenance})`).all()).toHaveLength(5);
    expect(f.raw.prepare(`PRAGMA foreign_key_list(${provenance})`).all().every(row => row.on_delete === 'CASCADE')).toBe(true);
    const before = f.snapshot(); openSyncRelayStorage(f.path).close(); expect(f.snapshot()).toEqual(before);
  } finally { f.raw.close(); }
});
it.each(objects)('refuses a missing marked reserved object %s without repair', name => {
  const f = fixture();
  try {
    f.raw.exec(`DROP ${name.startsWith('idx_') ? 'INDEX' : 'TABLE'} ${name}`);
    const before = f.snapshot(); expect(() => openSyncRelayStorage(f.path)).toThrow(/journal schema/);
    expect(f.snapshot()).toEqual(before);
  } finally { f.raw.close(); }
});
it.each(objects)('refuses an unmarked reserved name %s without adoption', name => {
  const f = fixture();
  try {
    f.raw.exec(`DROP TABLE ${provenance}; DROP TABLE ${journal}`);
    f.raw.prepare('DELETE FROM sync_relay_migrations WHERE migration_id=?').run(marker);
    f.raw.exec(`CREATE TABLE ${name}(sentinel TEXT)`);
    const before = f.snapshot(); expect(() => openSyncRelayStorage(f.path)).toThrow(/unmarked live update journal/);
    expect(f.snapshot()).toEqual(before);
  } finally { f.raw.close(); }
});
const personalMarker = 'live-update-journal-personal-v1';
const cuts = 'sync_relay_live_settlement_cuts';
const workspace = 'workspace';
const lineage = 'b'.repeat(64);
function append(raw: InstanceType<typeof DatabaseSync>, delivery: string, kind: string, principal: string, grant: string | null) {
  return raw.prepare(`INSERT INTO ${journal} (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
    current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,accepting_host_epoch,
    received_at_ms,update_bytes,relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes)
    VALUES (?,?,?,'main','object',?,'notes.md','["notes.md"]',0,?,?,?,?,1,1,?,'namespace',1,?,1)`)
    .run(delivery, 'a'.repeat(64), workspace, lineage, kind, principal, grant, grant === null ? null : 1, new Uint8Array([1]), 'c'.repeat(64))
    .lastInsertRowid;
}
it('admits a personal agent without a grant beside owner, named and link rows', () => {
  const f = fixture();
  try {
    f.raw.prepare('INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, 0)').run(workspace, 'owner');
    expect(() => append(f.raw, 'personal-grant', 'personal', 'p-agent', 'grant')).toThrow(/CHECK/);
    expect(() => append(f.raw, 'personal-other', 'personal', 'agent', null)).toThrow(/CHECK/);
    expect(() => append(f.raw, 'owner-grant', 'owner', 'owner', 'grant')).toThrow(/CHECK/);
    append(f.raw, 'personal', 'personal', 'p-agent', null);
    append(f.raw, 'owner', 'owner', 'owner', null);
    append(f.raw, 'named', 'named', 'reader', 'grant');
    append(f.raw, 'link', 'link', 'holder', 'grant');
    expect(f.raw.prepare(`SELECT delivery_id, principal_kind, grant_id FROM ${journal} ORDER BY journal_cursor`).all()).toEqual([
      { delivery_id: 'personal', principal_kind: 'personal', grant_id: null }, { delivery_id: 'owner', principal_kind: 'owner', grant_id: null },
      { delivery_id: 'named', principal_kind: 'named', grant_id: 'grant' }, { delivery_id: 'link', principal_kind: 'link', grant_id: 'grant' }]);
  } finally { f.raw.close(); }
});
it('rebuilds an older journal for personal agents and keeps its rows, dependents and next cursor', () => {
  const f = fixture();
  try {
    f.raw.prepare('INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, 0)').run(workspace, 'owner');
    append(f.raw, 'owner', 'owner', 'owner', null);
    const named = append(f.raw, 'named', 'named', 'reader', 'grant');
    const link = append(f.raw, 'link', 'link', 'holder', 'grant');
    f.raw.prepare(`INSERT INTO ${provenance} VALUES (?, 'main', 'object', ?, 7, 0, 3, ?)`).run(workspace, lineage, named);
    f.raw.prepare(`INSERT INTO ${cuts} VALUES (?, ?, ?, 1, 0)`).run(link, 'd'.repeat(64), 'e'.repeat(64));
    f.raw.prepare('UPDATE sqlite_sequence SET seq=seq+17 WHERE name=?').run(journal);
    // Restore the journal an older relay created, which refuses personal authority.
    const current = String(f.raw.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(journal)!.sql);
    const older = current.replace("'owner', 'personal', 'named', 'link'", "'owner', 'named', 'link'").replace(
      " OR (principal_kind = 'personal' AND substr(principal_id, 1, 2) = 'p-' AND grant_id IS NULL AND grant_generation IS NULL)", '');
    expect(older).not.toContain('personal');
    f.raw.enableDefensive(false); f.raw.exec('PRAGMA writable_schema=ON');
    f.raw.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(older, journal);
    f.raw.exec('PRAGMA writable_schema=OFF');
    f.raw.prepare('DELETE FROM sync_relay_migrations WHERE migration_id=?').run(personalMarker);
    const evidence = () => ({
      rows: [journal, provenance, cuts].map(table => f.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      usage: f.raw.prepare('SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?').get(workspace),
      sequence: f.raw.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(journal),
      dependents: f.raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND tbl_name IN (?,?,?) ORDER BY name")
        .all(journal, provenance, cuts),
      foreignKeys: [journal, provenance, cuts].map(table => f.raw.prepare(`PRAGMA foreign_key_list(${table})`).all()),
    });
    const before = evidence();
    openSyncRelayStorage(f.path).close();
    expect(evidence()).toEqual(before);
    expect(f.raw.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(journal)).toEqual({ sql: current });
    expect(f.raw.prepare('SELECT 1 AS marked FROM sync_relay_migrations WHERE migration_id=?').get(personalMarker)).toEqual({ marked: 1 });
    expect(f.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => append(f.raw, 'personal-grant', 'personal', 'p-agent', 'grant')).toThrow(/CHECK/);
    expect(append(f.raw, 'personal', 'personal', 'p-agent', null)).toBe(Number(before.sequence?.seq) + 1);
  } finally { f.raw.close(); }
});
it('refuses altered marked DDL even when columns still match', () => {
  const f = fixture();
  try {
    f.raw.enableDefensive(false); f.raw.exec('PRAGMA writable_schema=ON');
    f.raw.prepare("UPDATE sqlite_schema SET sql=replace(sql, 'BETWEEN 1 AND 512', 'BETWEEN 1 AND 513') WHERE name=?").run(journal);
    f.raw.exec('PRAGMA writable_schema=OFF');
    const before = f.snapshot(); expect(() => openSyncRelayStorage(f.path)).toThrow(/journal schema/);
    expect(f.snapshot()).toEqual(before);
  } finally { f.raw.close(); }
});
