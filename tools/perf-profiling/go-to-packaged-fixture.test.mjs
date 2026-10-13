import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
const relayRequire = createRequire(new URL('../../services/sync-relay/package.json', import.meta.url));
const { tsImport } = relayRequire('tsx/esm/api');
const { spawnSyncRelay } = await tsImport('../../apps/desktop/e2e/helpers/syncRelay.ts', import.meta.url);
const { seedGoToPeers, assertGoToCounts } = await tsImport('./go-to-packaged-fixture.mts', import.meta.url);
import { GO_TO_COUNTS } from './go-to-index-fixture.mjs';

for (const files of [5000, 30000]) test('Go to receipts require every fixture kind at ' + files + ' files', () => {
  const counts = { ...GO_TO_COUNTS, files };
  assertGoToCounts(counts, files);
  for (const kind of ['files', 'folders', 'namedThreads', 'dms', 'people', 'agents', 'commands', 'pluginWebApps']) {
    assert.throws(() => assertGoToCounts({ ...counts, [kind]: counts[kind] + 1 }, files));
  }
});

test('the dedicated relay admits seven peer DMs, scoped agent claims and the mounted file grant', { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dohc-goto-fixture-'));
  let relay;
  try {
    relay = await spawnSyncRelay({ dbPath: join(scratch, 'relay.sqlite') });
    const seeded = await seedGoToPeers(relay.baseUrl, 'goto-owner', AbortSignal.timeout(120_000));
    assert.equal(seeded.admissions.length, 7);
    const accounts = new Set(), agents = new Set();
    for (const admission of seeded.admissions) {
      const response = await fetch(relay.baseUrl + '/sync/shares/' + admission.shareId + '/log?since=0', {
        headers: { authorization: 'Bearer test:goto-owner' }, signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      const { ops } = await response.json();
      const channel = ops.find(op => op.opKind === 'chat.channel.create');
      assert.ok(channel);
      assert.equal(channel.payload.kind, 'dm');
      assert.equal(channel.payload.wireId, admission.channelWireId);
      const messages = ops.filter(op => op.opKind === 'chat.message.append');
      assert.equal(messages.length, 3);
      for (const message of messages) {
        assert.equal(message.payload.authorUserId, admission.userId);
        accounts.add(message.payload.authorUserId);
        if (message.payload.authorKind === 'agent') agents.add(admission.userId + ':' + message.payload.authorDisplayName);
      }
      const refused = await fetch(relay.baseUrl + '/sync/shares/' + admission.shareId + '/log?since=0', {
        headers: { authorization: 'Bearer test:unadmitted' }, signal: AbortSignal.timeout(15_000),
      });
      assert.equal(refused.status, 404);
      await refused.arrayBuffer();
    }
    assert.equal(accounts.size, 7);
    assert.equal(agents.size, 14);
    const mount = await fetch(relay.baseUrl + '/sync/shares/' + seeded.mountedShareId + '/log?since=0', {
      headers: { authorization: 'Bearer test:goto-owner' }, signal: AbortSignal.timeout(15_000),
    });
    assert.equal(mount.status, 200);
    const mounted = await mount.json();
    assert.ok(mounted.ops.some(op => op.payload.payloadAfterPath === 'mounted.txt'));
  } finally {
    await relay?.stop();
    const owned = relative(resolve(tmpdir()), resolve(scratch));
    assert.ok(!isAbsolute(owned) && !owned.startsWith('..') && owned.startsWith('dohc-goto-fixture-'));
    await rm(scratch, { recursive: true, force: true });
  }
});
