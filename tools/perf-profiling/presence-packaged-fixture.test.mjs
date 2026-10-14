import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:https';
const require = createRequire(new URL('../../services/sync-relay/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { createPresenceFixture, readPresenceDocuments } = await tsImport('../../apps/desktop/e2e/helpers/presenceBenchmark.ts', import.meta.url);

test('dry fixture reads canonical snapshots, prepares the desktop host, serves TLS, and closes its listeners', { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dohc-presence-fixture-'));
  const workspace = { workspaceId: 'presence-dry', rootPath: join(scratch, 'workspace') }, profile = join(scratch, 'profile');
  let fixture;
  try {
    await mkdir(join(workspace.rootPath, '.dohc/engine'), { recursive: true }); await mkdir(profile);
    await writeFile(join(profile, 'dohc-workspaces.json'), JSON.stringify({ version: 1, workspaces: [workspace] }));
    const db = new DatabaseSync(join(workspace.rootPath, '.dohc/engine/engine.db'));
    try {
      db.exec('CREATE TABLE ydoc_docs(workspace_id TEXT, version_id TEXT, object_id TEXT, path TEXT); CREATE TABLE binary_blobs(sha256 TEXT, bytes BLOB); CREATE TABLE ydoc_snapshots(workspace_id TEXT, version_id TEXT, object_id TEXT, up_to_seq INTEGER, snapshot_blob_sha256 TEXT); CREATE TABLE ydoc_updates(workspace_id TEXT, version_id TEXT, object_id TEXT, seq INTEGER, update_blob_sha256 TEXT)');
      for (const name of ['small.md', 'large.md']) {
        // A real Yjs body containing one paragraph and its text, serialized once.
        const bytes = Buffer.from('AQOmy87xCAAHAQRib2R5AwlwYXJhZ3JhcGgHAKbLzvEIAAYEAKbLzvEIAQ9QYXJhZ3JhcGggemVyby4A', 'base64');
        db.prepare('INSERT INTO ydoc_docs VALUES (?,?,?,?)').run(workspace.workspaceId, 'main', name, name);
        db.prepare('INSERT INTO binary_blobs VALUES (?,?)').run(name, bytes);
        db.prepare('INSERT INTO ydoc_snapshots VALUES (?,?,?,?,?)').run(workspace.workspaceId, 'main', name, 0, name);
      }
    } finally { db.close(); }
    assert.equal(readPresenceDocuments(workspace).length, 2);
    fixture = await createPresenceFixture({ workspace, profile, runDir: scratch, signal: AbortSignal.timeout(120_000) });
    const config = JSON.parse(await readFile(fixture.environment.DOHC_DESKTOP_OWNER_HOST_CONFIG, 'utf8'));
    assert.equal(config.workspaceIds[0], workspace.workspaceId);
    assert.equal(new URL(config.url).protocol, 'wss:'); assert.equal(new URL(config.url).hostname, 'localhost'); assert.equal(new URL(config.url).pathname, '/api/device-control');
    assert.deepEqual(JSON.parse(await readFile(config.nativeConfigPath, 'utf8')).ingress.maxUploads, 4);
    const ca = await readFile(fixture.environment.NODE_EXTRA_CA_CERTS);
    const response = await new Promise((resolve, reject) => {
      const req = request(fixture.receipt.baseUrl + '/sync/shares', { ca, signal: AbortSignal.timeout(30_000), headers: { authorization: 'Bearer test:presence-owner' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(response.status, 200);
    await fixture.stop(); fixture = null;
  } finally {
    await fixture?.stop();
    const owned = relative(resolve(tmpdir()), resolve(scratch));
    assert.ok(!isAbsolute(owned) && !owned.startsWith('..') && owned.startsWith('dohc-presence-fixture-'));
    await rm(scratch, { recursive: true, force: true });
  }
});
