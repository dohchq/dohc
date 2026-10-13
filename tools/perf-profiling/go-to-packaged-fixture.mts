import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSyncRelay } from "../../apps/desktop/e2e/helpers/syncRelay.ts";
import { RelayFilePeer } from "../../apps/desktop/src/testing/relayFilePeer.ts";
import { serializeCollectionSchema } from "../../apps/desktop/src/renderer/collections/schemaAuthoring.ts";
import { GO_TO_COUNTS } from "./go-to-index-fixture.mjs";
import type { DohcDesktopBridge as DesktopBridge } from "../../apps/desktop/src/ipc/bridgeContract.ts";

type FixtureMethod = 'listEngineMoments' | 'createWorkspaceFile' | 'listWorkspaceVersions' | 'createWorkspaceVersion' | 'switchWorkspaceVersion' | 'listChatChannels' | 'createChatChannel' | 'syncDms' | 'acceptDm' | 'listChatMessages' | 'mountShare' | 'listWorkspaceFiles' | 'listCollections' | 'listSites' | 'listChannelThreads';
type Call = <K extends FixtureMethod>(method: K, payload: Parameters<DesktopBridge[K]>[0]) => Promise<Awaited<ReturnType<DesktopBridge[K]>>>;
interface Workspace { workspaceId: string; rootPath: string }
interface FixtureOptions {
  workspace: Workspace;
  profile: string;
  runDir: string;
  files: number;
  signal: AbortSignal;
  call: Call;
  cli(args: string[]): Promise<string>;
  signIn(baseUrl: string, userId: string): Promise<Call>;
  waitForListing(files: number, folders: number): Promise<void>;
  commandCount(): Promise<number>;
  createApp(appRoot: string, title: string, agent: string): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }>;
}

export function assertGoToCounts(counts: Record<string, number>, files: number): void {
  for (const [kind, expected] of Object.entries({ ...GO_TO_COUNTS, files })) {
    assert.equal(counts[kind], expected, 'Go to fixture ' + kind);
  }
}

async function relayRequest(baseUrl: string, signal: AbortSignal, user: string, path: string, body?: object) {
    const response = await fetch(baseUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer test:' + user, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const value = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, path + ': ' + JSON.stringify(value));
    return value;
}

export async function seedGoToPeers(baseUrl: string, owner: string, signal: AbortSignal) {
  const request = (user: string, path: string, body?: object) => relayRequest(baseUrl, signal, user, path, body);
    const admissions: Array<{ userId: string; shareId: string; channelWireId: string }> = [];
    let mountedShareId = '';
    for (let n = 1; n <= GO_TO_COUNTS.dms; n++) {
      signal.throwIfAborted();
      const user = 'goto-peer-' + n;
      const peerWorkspace = 'goto-peer-workspace-' + n;
      const identity = { replicationEpoch: randomUUID(), streamIdentity: randomUUID() };
      const wireId = randomUUID(), threadId = randomUUID();
      await request(user, '/sync/workspaces', { workspaceId: peerWorkspace, ...identity });
      const now = Date.now();
      const rows = [
        { opKind: 'chat.channel.create', payload: { channelId: wireId, wireId, name: owner + '@dohc.test', slug: 'dm-' + n, kind: 'dm', createdAtMs: now } },
        { opKind: 'chat.thread.create', payload: { threadId, title: '', channelSlug: 'dm-' + n, channelWireId: wireId, createdAtMs: now + 1 } },
        ...['human', 'agent', 'agent'].map((kind, i) => ({ opKind: 'chat.message.append', payload: {
          messageId: randomUUID(), threadId, authorKind: kind, authorUserId: user,
          authorDisplayName: i === 0 ? user : 'Fixture agent ' + i,
          authorOwnerDisplayName: user, body: 'Fixture DM message ' + i, createdAtMs: now + 2 + i,
        } })),
      ];
      await request(user, '/sync/' + peerWorkspace + '/log', { ...identity, originId: 'goto-peer-chat-' + n,
        ops: rows.map((row, originSeq) => ({ ...row, originSeq, recordedAtMs: now + originSeq })) });
      const grant = await request(user, '/sync/' + peerWorkspace + '/shares', {
        recipientEmail: owner + '@dohc.test', channelWireId: wireId, access: 'read-write',
      });
      assert.equal(typeof grant.shareId, 'string');
      admissions.push({ userId: user, shareId: grant.shareId as string, channelWireId: wireId });
      if (n === 1) {
        const peer = new RelayFilePeer({ baseUrl: baseUrl, token: 'test:' + user, workspaceId: peerWorkspace,
          originId: 'goto-peer-files', identity });
        await peer.writeText('mounted.txt', 'Mounted Go to fixture.\n');
        const shared = await request(user, '/sync/' + peerWorkspace + '/shares', {
          recipientEmail: owner + '@dohc.test', paths: ['mounted.txt'], access: 'view',
        });
        assert.equal(typeof shared.shareId, 'string');
        mountedShareId = shared.shareId as string;
      }
    }
  return { admissions, mountedShareId };
}

// Provisioning is outside every timed palette sample. It uses the same source
// generators, CLI socket, preload operations, and relay admission as ordinary work.
export async function provisionGoToFixture(options: FixtureOptions) {
  const started = performance.now();
  const { workspace, runDir } = options;
  const relay = await spawnSyncRelay({ dbPath: join(runDir, 'go-to-relay.sqlite') });
  const claims = new Set<string>();
  const owners = new Set<string>();
  let call = options.call;
  const request = (user: string, path: string, body?: object) => relayRequest(relay.baseUrl, options.signal, user, path, body);
  const authored = async (label: string) => {
    const text = await readFile(join(workspace.rootPath, 'small.md'), 'utf8');
    const value = JSON.parse(await options.cli(['--json', 'document', 'edit', 'small.md', '--agent', label,
      '--text', text + '\nFixture authorship ' + label + '.\n'])) as { ok: boolean };
    assert.equal(value.ok, true, 'CLI authored document');
  };
  // Read the committed authorship, rather than making a renderer installation identity.
  const localClaims = async () => {
    const result = await call('listEngineMoments', { workspaceId: workspace.workspaceId, limit: 500 });
    assert.ok('moments' in result, 'Authorship capture must have settled before fixture admission');
    for (const moment of result.moments) for (const author of moment.authors ?? []) {
      if (author.kind === 'agent' && author.agentId.startsWith('Fixture agent ') && author.onBehalfOf) {
        owners.add(author.onBehalfOf);
        claims.add(author.onBehalfOf + ':' + author.agentId);
      }
    }
  };
  try {
    for (const label of ['Fixture agent 1', 'Fixture agent 2']) await authored(label);
    await localClaims();
    assert.equal(owners.size, 1, 'Signed-out installation authorship');
    assert.equal(claims.size, 2, 'Installation agent claims');
    const owner = 'goto-owner';
    await request(owner, '/sync/workspaces', { workspaceId: workspace.workspaceId });
    call = await options.signIn(relay.baseUrl, owner);
    for (const label of ['Fixture agent 1', 'Fixture agent 2']) await authored(label);
    await localClaims();
    assert.equal(owners.size, 2, 'Installation and account authorship');
    assert.equal(claims.size, 4, 'Account agent claims');

    // Co-locating each app and Collection keeps their generated source folders
    // within the specified 50-folder workload. No generated sources are omitted.
    const generatedFiles: string[] = [];
    for (let n = 0; n < GO_TO_COUNTS.apps; n++) {
      options.signal.throwIfAborted();
      const path = 'work-' + String(n).padStart(2, '0');
      const app = await options.createApp(path, 'Fixture app ' + n, 'Fixture agent 1');
      if (!app.ok) throw Error('App source generator: ' + app.reason);
      generatedFiles.push(...app.files);
      const collectionPath = path + '/collection.yaml';
      await call('createWorkspaceFile', { workspaceId: workspace.workspaceId, relativePath: collectionPath,
        initialText: serializeCollectionSchema({ name: 'Fixture Collection ' + n, description: null,
          fields: [{ name: 'Name', type: 'text' }], views: [] }) });
      generatedFiles.push(collectionPath);
    }
    const initialVersions = await call('listWorkspaceVersions', { workspaceId: workspace.workspaceId });
    assert.equal(initialVersions.versions.length, 1);
    const main = initialVersions.versions[0]!;
    assert.equal(main.name, 'Main');
    for (let n = 1; n < GO_TO_COUNTS.versions; n++) {
      options.signal.throwIfAborted();
      await call('createWorkspaceVersion', { workspaceId: workspace.workspaceId, name: 'Fixture version ' + n });
    }
    await call('switchWorkspaceVersion', { workspaceId: workspace.workspaceId, versionId: main.id });
    const initialChannels = await call('listChatChannels', { workspaceId: workspace.workspaceId });
    assert.equal(initialChannels.channels.filter(channel => channel.kind === 'channel').length, 1);
    const general = initialChannels.channels.find(channel => channel.slug === 'general');
    assert.ok(general, 'Default general Group');
    for (let n = 1; n < GO_TO_COUNTS.groups; n++) {
      options.signal.throwIfAborted();
      await call('createChatChannel', { workspaceId: workspace.workspaceId, name: 'Fixture Group ' + n, type: 'posts' });
    }
    const threads: string[] = [];
    for (let n = 0; n < GO_TO_COUNTS.namedThreads; n++) {
      options.signal.throwIfAborted();
      const post = JSON.parse(await options.cli(['--json', 'chat', 'post', 'general', '--title', 'Fixture thread ' + n,
        'Explicit-title benchmark post ' + n])) as { threadId: string };
      assert.equal(typeof post.threadId, 'string');
      threads.push(post.threadId);
    }
    assert.equal(new Set(threads).size, GO_TO_COUNTS.namedThreads);

    const { admissions, mountedShareId } = await seedGoToPeers(relay.baseUrl, owner, options.signal);
    const pending = await call('syncDms', { workspaceId: workspace.workspaceId });
    assert.equal(pending.failed, false);
    assert.equal(pending.pending.length, GO_TO_COUNTS.dms);
    for (const admission of admissions) {
      assert.ok(pending.pending.some(row => row.shareId === admission.shareId));
      const accepted = await call('acceptDm', { workspaceId: workspace.workspaceId, shareId: admission.shareId });
      assert.equal(accepted.dm.connected, true);
      assert.equal(accepted.dm.channelWireId, admission.channelWireId);
      assert.ok(accepted.dm.threadId);
      const messages = await call('listChatMessages', { workspaceId: workspace.workspaceId, threadId: accepted.dm.threadId! });
      assert.equal(messages.messages.length, 3, 'Admitted DM messages');
      for (const message of messages.messages) {
        assert.equal(message.authorUserId, admission.userId, 'Relay-verified account authorship');
        owners.add(message.authorUserId!);
        if (message.authorKind === 'agent') claims.add(message.authorUserId + ':' + message.authorDisplayName);
      }
    }
    const mount = await call('mountShare', { workspaceId: workspace.workspaceId,
      shareCode: 'dohc-share:' + mountedShareId + ':' + relay.baseUrl });
    assert.notEqual(mount.mount.status, 'damaged');
    assert.notEqual(mount.mount.status, 'ended');
    const beforeFiles = await call('listWorkspaceFiles', { workspaceId: workspace.workspaceId });
    const remaining = options.files - beforeFiles.files.length;
    assert.ok(remaining > 4242, 'Go to workload needs its fixture-004242 target');
    for (let n = 0; n < 7; n++) await mkdir(join(workspace.rootPath, 'src/module-' + n), { recursive: true });
    for (let begin = 0; begin < remaining; begin += 32) {
      options.signal.throwIfAborted();
      await Promise.all(Array.from({ length: Math.min(32, remaining - begin) }, (_, offset) => {
        const n = begin + offset;
        const path = 'src/module-' + n % 7 + '/fixture-' + String(n).padStart(6, '0') + (n % 3 === 0 && n !== 4242 ? '.ts' : '.txt');
        return writeFile(join(workspace.rootPath, path), 'Go to fixture ' + n + '.\n');
      }));
    }
    await options.waitForListing(options.files, GO_TO_COUNTS.folders);
    const listing = await call('listWorkspaceFiles', { workspaceId: workspace.workspaceId });
    const collections = await call('listCollections', { workspaceId: workspace.workspaceId });
    const apps = await call('listSites', { workspaceId: workspace.workspaceId });
    const versions = await call('listWorkspaceVersions', { workspaceId: workspace.workspaceId });
    const channels = await call('listChatChannels', { workspaceId: workspace.workspaceId });
    const namedThreads = await call('listChannelThreads', { workspaceId: workspace.workspaceId, channelId: general.id });
    const dms = await call('syncDms', { workspaceId: workspace.workspaceId });
    assert.equal(dms.pending.length, 0);
    assert.equal(dms.failed, false);
    const counts = { files: listing.files.length, folders: listing.folders?.length ?? 0,
      collections: collections.collections.length, apps: apps.sites.length, versions: versions.versions.length,
      groups: channels.channels.filter(channel => channel.kind === 'channel').length,
      namedThreads: namedThreads.threads.length, dms: dms.dms.length, people: owners.size, agents: claims.size,
      commands: await options.commandCount(), pluginWebApps: 0 };
    assertGoToCounts(counts, options.files);
    const digest = createHash('sha256');
    for (const file of [...listing.files].sort((a, b) => a.path.localeCompare(b.path))) {
      digest.update(file.path + '\0').update(await readFile(join(workspace.rootPath, file.path))).update('\0');
    }
    const receipt = { counts, provisioningObservedMs: performance.now() - started, contentSha256: digest.digest('hex'), generatedFiles, threads, admissions,
      owners: [...owners].sort(), agentClaims: [...claims].sort(), mountedShareId,
      relay: { baseUrl: relay.baseUrl, dbPath: relay.dbPath },
      identities: 'test-relay accounts admitted through grants, DM acceptance and authored rows; no renderer identity injection',
      timing: 'all provisioning and receipts precede palette timing' };
    await writeFile(join(runDir, 'go-to-fixture.json'), JSON.stringify(receipt, null, 2));
    return { receipt, stop: () => relay.stop() };
  } catch (error) {
    await relay.stop();
    throw error;
  }
}
