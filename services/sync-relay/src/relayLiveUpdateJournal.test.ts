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
