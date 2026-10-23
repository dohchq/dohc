import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { serveFetchHandler } from '../../../../packages/service-http/src/index.ts';
import { yDocToMarkdown } from '../../../../packages/ydoc-projection/src/import-export.ts';
import { createLiveMarkdownRegistrationValidator } from '../../../../packages/ydoc-projection/src/liveDocumentValidation.ts';
import { createNamedLiveBrowserTransport } from '../../../../packages/ydoc-projection/src/namedLiveBrowserTransport.ts';
import { initializeRelayDeployment, openRelayDeployment } from '../../../../services/sync-relay/src/relayDeployment.ts';
import { createSyncRelayHandler } from '../../../../services/sync-relay/src/server.ts';
import { createDeviceControl } from '../../../../services/sync-relay/src/deviceControl.ts';
import { parseRelayDeviceDeliveryConfig } from '../../../../services/sync-relay/src/deviceLiveHostConfig.ts';
import { createDeviceControlBridge } from '../../../../services/share-web/src/deviceControlBridge.ts';
import { ensureLocalhostTls } from '../../../../services/share-web/src/testing/device-control/localhostTls.ts';
import { createNamedDesktopLive } from '../../../../services/sync-relay/src/namedDesktopLive.ts';
import { createNamedLiveRoutes } from '../../../../services/sync-relay/src/namedLiveRoutes.ts';
import { createLiveTickets } from '../../../../services/sync-relay/src/liveTickets.ts';
import { createLiveHostReports } from '../../../../services/sync-relay/src/namedLiveHostReports.ts';
import { createNamedFrameChanges } from '../../../../services/sync-relay/src/liveHostChanges.ts';
import { createLiveMembershipRegistry } from '../../../../services/sync-relay/src/liveMembership.ts';
import { createLiveConnectionAdmission } from '../../../../services/sync-relay/src/liveConnectionAdmission.ts';
import { selfHostLiveProfile } from '../../../../services/sync-relay/src/selfHostLiveProfile.ts';
import { createLiveValidationExecutor } from '../../../../services/sync-relay/src/liveValidation.ts';
import { PresenceHub } from '../../../../services/sync-relay/src/presence.ts';
import { createDeviceHostCredential } from '../../../../services/sync-relay/src/deviceHostCredential.ts';
import { parseHostEpoch } from '../../../../packages/live-session-contract/src/hostControl.ts';
import { OwnerKnownRefusals } from '../../../../packages/workspace-engine-client/src/ydoc/ownerYDocOutboxDrainer.ts';
// No product object-topic builder exists yet. PR 5 must move and import this
// definition for its Markdown caret binding; do not introduce a second format.
export const makePresenceObjectTopic = (value: {workspaceId: string; versionId: string; objectId: string}) => 'doc:' + JSON.stringify([value.workspaceId, value.versionId, value.objectId]);

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const RATES = { selectionHz: 20, typingHz: 5 };
export const PEER_EDIT = '\u25c7';

export function summarizePeerSchedule(times: number[], start: number, end: number) {
  const ticks = times.filter(time => time >= start && time <= end);
  const bounds = [start, ...ticks, end];
  return { ticks: ticks.length, maxGapMs: Math.max(...bounds.slice(1).map((time, index) => time - bounds[index]!)) };
}
const owner = 'presence-owner';
type Workspace = { workspaceId: string; rootPath: string };

// Read only after the package has closed. Use its CRDT, preserving block/client ids.
export function readPresenceDocuments(workspace: Workspace) {
  const db = new DatabaseSync(join(workspace.rootPath, '.dohc/engine/engine.db'), { readOnly: true });
  try {
    return ['small.md', 'large.md'].map(path => {
      const row = db.prepare('SELECT * FROM ydoc_docs WHERE workspace_id=? AND version_id=? AND path=?').get(workspace.workspaceId, 'main', path)!;
      assert.ok(row, 'Package must have opened ' + path + ' through the engine');
      const doc = new Y.Doc();
      try {
        const snapshot = db.prepare('SELECT up_to_seq, bytes FROM ydoc_snapshots JOIN binary_blobs ON sha256=snapshot_blob_sha256 WHERE workspace_id=? AND version_id=? AND object_id=? ORDER BY up_to_seq DESC LIMIT 1').get(workspace.workspaceId, 'main', row.object_id)!;
        assert.ok(snapshot, 'Canonical engine snapshot');
        Y.applyUpdate(doc, snapshot.bytes as Uint8Array);
        for (const update of db.prepare('SELECT bytes FROM ydoc_updates JOIN binary_blobs ON sha256=update_blob_sha256 WHERE workspace_id=? AND version_id=? AND object_id=? AND seq>? ORDER BY seq').all(workspace.workspaceId, 'main', row.object_id, snapshot.up_to_seq)) Y.applyUpdate(doc, update.bytes as Uint8Array);
        return { path, objectId: row.object_id as string, bytes: Y.encodeStateAsUpdate(doc), markdown: yDocToMarkdown(doc) };
      } finally { doc.destroy(); }
    });
  } finally { db.close(); }
}

export async function waitForPresence<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  for (;;) {
    signal.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    await delay(50, undefined, { signal });
  }
}

export async function finishPresencePeerSessions(
  sessions: Array<{ state(): { pendingUpdates: number; status: string } }>,
  close: () => Promise<void>,
  signal: AbortSignal,
) {
  let failure: unknown;
  try {
    await waitForPresence(() => {
      const states = sessions.map(session => session.state());
      const dead = states.find(state => state.status !== 'live');
      if (dead) throw new Error('Peer stopped during acknowledgement drain: ' + dead.status);
      return states.every(state => state.pendingUpdates === 0);
    }, Boolean, signal);
  } catch (error) { failure = error; throw error; }
  finally {
    try { await close(); }
    catch (error) { if (!failure) throw error; }
  }
}

export function presencePeerSchedulePass(peers: Array<{ selectionHz: number; typingHz: number; maxGapMs: number }>) {
  return peers.every(peer => peer.selectionHz >= 18 && peer.typingHz >= 4 && peer.maxGapMs <= 100);
}

export async function createPresenceFixture(options: { workspace: Workspace; profile: string; runDir: string; signal: AbortSignal }) {
  const { workspace, runDir, signal } = options;
  const profile = selfHostLiveProfile(), documents = readPresenceDocuments(workspace);
  // The relay deployment refuses a path that resolves elsewhere, such as one under macOS /tmp.
  const privateDir = join(realpathSync(runDir), 'presence'); await mkdir(privateDir);
  const configPath = join(privateDir, 'deployment.json');
  initializeRelayDeployment({ configPath, relayPath: join(privateDir, 'data', 'relay.sqlite'), continuityDirectory: join(privateDir, 'continuity') });
  const deployment = openRelayDeployment(configPath, { liveTickets: { ...profile.namedLive.tickets, now: Date.now } });
  const { storage, history } = deployment;
  const closes: Array<() => void | Promise<void>> = [() => storage.close()];
  const stop = async () => { const failures = []; for (const close of closes.splice(0).reverse()) try { await close(); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError(failures, 'Presence fixture cleanup'); };
  try {
    assert.equal(storage.claimWorkspace({ workspaceId: workspace.workspaceId, ownerUserId: owner, createdAtMs: Date.now() }), 'created');
    const credential = createDeviceHostCredential('presence-desktop', parseHostEpoch(1));
    assert.ok(storage.provisionDeviceHostCredential({ credential, updatedAtMs: Date.now() }).ok);
    const controlLimits = { maxConnections: 4, maxHeaderBytes: 8192, maxCredentialBytes: 4096, maxPayloadBytes: 4096, maxPendingBytes: 4_000_000, maxFragments: 16, maxBufferedChunks: 128, handshakeTimeoutMs: 30_000, heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 30_000, closeTimeoutMs: 1000 };
    const validator = createLiveValidationExecutor();
    closes.push(() => validator.close());
    const validate = validator.validator(profile.validation);
    const exchangeKey = randomUUID() + randomUUID();
    const changes = createNamedFrameChanges(profile.namedLive.maxListeners);
    const internal = createServer(); internal.listen(0, '127.0.0.1'); await once(internal, 'listening');
    closes.push(() => new Promise<void>(done => internal.close(() => done())));
    const internalHost = '127.0.0.1:' + (internal.address() as { port: number }).port;
    const ownerShareId = randomUUID();
    storage.createShare({ share: { shareId: ownerShareId, workspaceId: workspace.workspaceId, granterUserId: owner, selectorJson: JSON.stringify({ paths: documents.map(doc => doc.path), versionId: null }), createdAtMs: Date.now() },
      grant: { grantId: randomUUID(), shareId: ownerShareId, principalKind: 'user', principalUserId: 'presence-seed-peer', principalEmail: null, access: 'edit', generation: 1, status: 'active', createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null } });
    const control = createDeviceControl({ storage, hosts: new Set([internalHost]), relayExchangeKey: exchangeKey, limits: controlLimits,
      delivery: { history, frameChanges: changes, ownerAdmission: { trustedAccount: async accountId => ({accountId, name: accountId}), shares: new Map([[workspace.workspaceId, ownerShareId]]), maxEntriesPerDrain: 128, maxBytesPerDrain: 4 * 1024 * 1024, refusals: new OwnerKnownRefusals(), validate: validate }, config: parseRelayDeviceDeliveryConfig({ version: 1, workspaceIds: [workspace.workspaceId], maxQueuedBytes: 8_000_000, maxActiveDrains: 2,
        client: { aggregateBytes: profile.nativeClient.aggregateBytes, maxUploads: 4, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000, maxFrameBytes: 1_048_576 } }, controlLimits) } });
    closes.push(() => control.close()); internal.on('upgrade', control.handleUpgrade);
    const tls = await ensureLocalhostTls(), ca = readFileSync(tls.certificate);
    const server = httpsServer({ cert: ca, key: readFileSync(tls.key) }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    closes.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
    const host = 'localhost:' + (server.address() as { port: number }).port, baseUrl = 'https://' + host;
    const bridge = createDeviceControlBridge({ publicHosts: new Set([host]), relayUrl: 'http://' + internalHost, relayExchangeKey: exchangeKey, limits: controlLimits,
      admission: { capacity: 16, refillPerSecond: 4, maxKeys: 16 }, trustedProxies: new Set() });
    closes.push(() => bridge.close());
    const resolveActor = async (request: Request, workspaceId: string) => {
      const userId = /^Bearer test:([a-zA-Z0-9-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!userId) throw new Error('Fixture authentication required');
      return { userId, workspaceId };
    };
    const presence = new PresenceHub();
    closes.push(() => presence.dispose());
    const application = createSyncRelayHandler({ storage, resolveActor, presence, lookupUserDisplayName: user => user });
    const captureNative = (binding: Parameters<typeof control.captureNative>[0], requestSignal: AbortSignal) => control.captureNative(binding, requestSignal);
    const tickets = createLiveTickets({ storage, audience: baseUrl, key: exchangeKey, hostReports: createLiveHostReports({ storage, captureNative }) });
    const admission = createNamedDesktopLive({ storage, resolveActor, publicOrigin: baseUrl, hosts: new Set([host]), limits: profile.browserSessions, editorLimits: profile.editor,
      tickets, changes, readinessLimits: profile.desktopReadiness });
    const live = createNamedLiveRoutes({ kind: 'named', desktopBearer: true, storage, hosts: new Set([host]), publicOrigin: baseUrl, exchangeKey,
      limits: profile.namedLive.transport, frames: profile.frames, bounds: profile.namedLive.host, validate: validate,
      sessions: admission, tickets, captureNative, membership: createLiveMembershipRegistry({ maxSessions: 32, maxMembers: 32, maxSnapshotBytes: 65536 }, storage.readLiveAuthority.bind(storage)), admission: createLiveConnectionAdmission(), lookupUserDisplayName: user => user });
    closes.push(() => live.close());
    const http = serveFetchHandler({ handler: request => new URL(request.url).pathname.startsWith('/sync/live/desktop-') ? admission.handle(request) : application(request),
      maxBodyBytes: () => 4 * 1024 * 1024, oversized: () => new Response(null, { status: 413 }), failure: () => new Response(null, { status: 500 }) });
    server.on('request', (request, response) => http.emit('request', request, response));
    server.on('upgrade', (request, socket, head) => { if (request.url?.startsWith('/api/device-control')) bridge.handleUpgrade(request, socket, head); else if (request.url?.startsWith('/sync/live/desktop?')) void live.handleUpgrade(request, socket, head); else socket.destroy(); });
    const credentialPath = join(privateDir, 'credential.json'), nativeConfigPath = join(privateDir, 'native.json'), ownerHostConfig = join(privateDir, 'desktop.json');
    await writeFile(credentialPath, JSON.stringify(credential));
    await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
    await writeFile(ownerHostConfig, JSON.stringify({ version: 1, nativeConfigPath, credentialPath, url: baseUrl.replace('https:', 'wss:') + '/api/device-control', workspaceIds: [workspace.workspaceId], reconnectDelayMs: 1000, control: controlLimits,
      transport: { aggregateBytes: profile.nativeClient.aggregateBytes, maxAdoptionBytes: profile.nativeIngress.maxAdoptionBytes, maxAdoptionEvents: profile.nativeIngress.maxAdoptionEvents, maxFrameBytes: 1_048_576, maxQueuedBytes: 8_000_000, maxRegistrations: 64, maxUploads: 4, requestDeadlineMs: 30_000, sync: { maxClientVectorBytes: 128 * 1024, maxOutputBytes: 4 * 1024 * 1024 } } }));
    const registryPath = join(options.profile, 'dohc-workspaces.json'), registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.workspaces.find((row: Workspace) => row.workspaceId === workspace.workspaceId).remote = { serverUrl: baseUrl, ownerUserId: owner };
    await writeFile(registryPath, JSON.stringify(registry));
    await writeFile(join(options.profile, 'dohc-cloud.json'), JSON.stringify({ version: 1, serverUrl: baseUrl, relayUrl: baseUrl, userId: owner, email: owner + '@dohc.test', token: 'plain:test:' + owner }));
    const request = async (user: string, path: string, body: unknown) => {
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        const req = httpsRequest(baseUrl + path, { ca, method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { authorization: 'Bearer test:' + user, 'content-type': 'application/json' } }, res => {
          const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(path + ': HTTP ' + res.statusCode + ' ' + Buffer.concat(chunks))));
        }); req.on('error', reject); req.end(JSON.stringify(body));
      });
      return JSON.parse(bytes.toString());
    };
    const receipt = { baseUrl, hostMode: 'device', ownerHostConfig, documents: documents.map(({ path, objectId }) => ({ path, objectId })), rates: RATES };
    return { receipt, environment: { DOHC_DESKTOP_OWNER_HOST_CONFIG: ownerHostConfig, NODE_EXTRA_CA_CERTS: tls.certificate }, stop,
      async register() {
        const hostState = await waitForPresence(() => storage.getLiveHostControl(), value => value?.admissionState === 'open', signal);
        assert.ok(hostState);
        for (const [index, doc] of documents.entries()) {
          const sha = hash(Buffer.from(doc.markdown));
          storage.putBlob({ workspaceId: workspace.workspaceId, sha256: sha, content: Buffer.from(doc.markdown), createdAtMs: Date.now() });
          storage.appendLogBatch({ workspaceId: workspace.workspaceId, originId: 'presence-seed', ops: [{ originSeq: index, opKind: 'moment.append', recordedAtMs: Date.now(), payloadJson: JSON.stringify({ objectId: doc.objectId, momentId: 'presence-' + index, versionId: 'main', recordedAtMs: Date.now(), operation: 'write', path: doc.path, payloadAfterPath: doc.path, payloadAfterBlobSha256: sha, payloadAfterContentKind: 'text', payloadAfterByteLength: Buffer.byteLength(doc.markdown) }) }] });
          const validation = createLiveMarkdownRegistrationValidator(profile.validation)({ document: { workspaceId: workspace.workspaceId, mainVersionId: 'main', objectId: doc.objectId, lineageClaimId: hash(doc.bytes) }, currentPath: doc.path, checkpoint: doc.bytes });
          assert.equal(validation.kind, 'accepted'); if (validation.kind !== 'accepted') throw new Error('Invalid document baseline');
          const registered = storage.registerLiveDocumentBaseline({ host: { mode: 'device', hostId: credential.hostId, hostEpoch: credential.hostEpoch, instanceId: credential.instanceId, connectionId: hostState.registeredConnectionId! }, evidence: validation.evidence, baselineBytes: doc.bytes, registeredAtMs: Date.now() });
          assert.equal(registered.kind, 'registered');
        }
      },
      async activate(path: string) {
        const doc = documents.find(doc => doc.path === path)!;
        const binding = { workspaceId: workspace.workspaceId, mainVersionId: 'main', objectId: doc.objectId, lineageClaimId: hash(doc.bytes), currentPath: path, selectorPaths: [path], restoreFenceGeneration: 1 };
        await waitForPresence(async () => { try { await control.captureNative(binding, signal); return true; } catch (error) { if (signal.aborted) throw error; return false; } }, Boolean, signal);
      },
      async peers(path: string, count: number) {
        const doc = documents.find(doc => doc.path === path)!;
        const peers: Array<{ manager: ReturnType<typeof createNamedLiveBrowserTransport>; session: ReturnType<ReturnType<typeof createNamedLiveBrowserTransport>['select']>; awareness: Awareness; shareId: string; user: string; clientId: string; selections: number; edits: number }> = [];
        const sockets = new Set<WebSocket>();
        let running = false, failure: unknown, loop: Promise<void> | undefined, closed = false, startedAt = 0;
        const ticks: Array<{ time: number; peer: number; edited: boolean }> = [];
        let result: Promise<{ peers: number; pass: boolean; elapsedMs: number; maxGapMs: number; rates: typeof RATES;
          peerCounts: Array<{ selections: number; edits: number; windowEdits: number; selectionHz: number; typingHz: number; maxGapMs: number }> }> | undefined;
        const close = async () => {
          if (closed) return;
          closed = true; running = false; await loop;
          const failures = [];
          for (const peer of peers) {
            try {
              await request(peer.user, '/sync/shares/' + peer.shareId + '/presence?topic=' + encodeURIComponent(makePresenceObjectTopic({ workspaceId: workspace.workspaceId, versionId: 'main', objectId: doc.objectId })), { clientId: peer.clientId, leave: true });
            } catch (error) { failures.push(error); }
            finally { peer.awareness.destroy(); peer.manager.close(); }
          }
          await Promise.all([...sockets].map(socket => new Promise<void>(done => {
            if (socket.readyState === WebSocket.CLOSED) { done(); return; }
            socket.once('close', () => done()); socket.terminate();
          })));
          if (failures.length) throw new AggregateError(failures, 'Presence peers did not leave cleanly');
        };
        closes.push(close);
        for (let index = 0; index < count; index++) {
          const user = 'presence-peer-' + index, shareId = randomUUID();
          storage.createShare({ share: { shareId, workspaceId: workspace.workspaceId, granterUserId: owner, selectorJson: JSON.stringify({ paths: [path], versionId: null }), createdAtMs: Date.now() },
            grant: { grantId: randomUUID(), shareId, principalKind: 'user', principalUserId: user, principalEmail: null, access: 'edit', generation: 1, status: 'active', createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null } });
          const opened = await request(user, '/sync/live/desktop-open', { shareId, path });
          const selection = { accountId: user, workspaceId: opened.workspaceId, grantId: opened.grantId, objectId: opened.objectId };
          const manager = createNamedLiveBrowserTransport({ publicOrigin: baseUrl, limits: profile.editor, recordingContext: () => ({ kind: 'account', accountId: user }),
            authorize: async () => ({ ticketToken: opened.ticket.token, discriminator: opened.discriminator, websocketUrl: baseUrl.replace('https:', 'wss:') + '/sync/live/desktop?session=' + opened.discriminator }),
            openSocket: (url, protocols) => {
              const socket = new WebSocket(url, protocols, { ca, headers: { authorization: 'Bearer test:' + user }, perMessageDeflate: false });
              sockets.add(socket); socket.once('close', () => sockets.delete(socket));
              return socket as unknown as globalThis.WebSocket;
            } });
          const session = manager.select(selection);
          const peer = { manager, session, awareness: new Awareness(session.doc), shareId, user, clientId: randomUUID(), selections: 0, edits: 0 }; peers.push(peer);
          await session.reconnect(); await waitForPresence(() => session.state().status, value => { if (['closed', 'disconnected', 'quarantined'].includes(value)) throw new Error('Peer failed to join: ' + value); return value === 'live'; }, signal);
        }
        const topic = encodeURIComponent(makePresenceObjectTopic({ workspaceId: workspace.workspaceId, versionId: 'main', objectId: doc.objectId }));
        const tick = async (prime = false) => {
          for (const [index, peer] of peers.entries()) {
            if (!prime && !running) break;
            assert.equal(peer.session.state().status, 'live');
            const block = peer.session.doc.getXmlFragment('body').get(0) as Y.XmlElement, text = block.get(0) as Y.XmlText;
            assert.ok(text instanceof Y.XmlText, 'First paragraph text');
            const edited = !prime && peer.selections % 4 === 0;
            if (edited) { peer.session.edit(() => text.insert(text.length, PEER_EDIT)); peer.edits++; }
            const cursor = { anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, peer.selections % (text.length + 1))), head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, peer.selections % (text.length + 1))) };
            peer.awareness.setLocalState({ cursor });
            await request(peer.user, '/sync/shares/' + peer.shareId + '/presence?topic=' + topic, { clientId: peer.clientId, state: { yc: peer.awareness.clientID, update: Buffer.from(encodeAwarenessUpdate(peer.awareness, [peer.awareness.clientID])).toString('base64') } }); peer.selections++;
            if (!prime) ticks.push({ time: performance.now(), peer: index, edited });
          }
        };
        await tick(true);
        return { start() {
          running = true; startedAt = performance.now();
          for (const peer of peers) { peer.selections = 0; peer.edits = 0; }
          loop = (async () => {
            while (running) {
              // Set each deadline from now. A late tick never triggers catch-up bursts.
              const next = performance.now() + 50;
              await tick();
              if (running) await delay(Math.max(0, next - performance.now()), undefined, { signal });
            }
          })().catch(error => { failure = error; running = false; });
        },
          stop() { running = false; },
          finish(window?: { start: number; end: number }) {
            result ??= (async () => {
              running = false;
              await loop;
              if (failure) { await close(); throw failure; }
              await finishPresencePeerSessions(peers.map(peer => peer.session), close, signal);
              const start = window?.start ?? startedAt, end = window?.end ?? start;
              const elapsedMs = end - start;
              const peerCounts = peers.map((peer, index) => {
                const during = ticks.filter(tick => tick.peer === index && tick.time >= start && tick.time <= end);
                const schedule = summarizePeerSchedule(during.map(tick => tick.time), start, end);
                return { selections: during.length, edits: peer.edits, windowEdits: during.filter(tick => tick.edited).length,
                  selectionHz: during.length * 1000 / elapsedMs, typingHz: during.filter(tick => tick.edited).length * 1000 / elapsedMs,
                  maxGapMs: schedule.maxGapMs };
              });
              return { peers: count, pass: elapsedMs > 0 && presencePeerSchedulePass(peerCounts),
                peerCounts, elapsedMs, maxGapMs: Math.max(...peerCounts.map(peer => peer.maxGapMs)), rates: RATES };
            })();
            return result;
          } };
      } };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Presence fixture setup and cleanup failed'); }
    throw error;
  }
}
