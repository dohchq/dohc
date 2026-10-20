import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './document-size-fixtures.mjs';

// Loopback transport, production HTTP/ticket/frame handlers and provider. Only the
// external account authority is fixture-owned; all share authority stays in storage.
export async function startDocumentSocketProbe(options, storage, native, pool, projection, Y, credentials) {
  const require = createRequire(join(options.checkout, 'services/sync-relay/package.json'));
  const load = (path) => import(pathToFileURL(join(options.checkout, path)).href);
  const [
    { serveFetchHandler },
    { createNamedLiveRoutes },
    { createLiveTickets },
    { createLiveHostReports },
    { createNamedLiveBrowserHttp },
    { createLinkLiveBrowserResolver },
    { createNamedLiveProvider },
    { selfHostLiveProfile },
  ] = await Promise.all([
    import(pathToFileURL(require.resolve('@dohc/service-http')).href),
    load('services/sync-relay/src/namedLiveRoutes.ts'),
    load('services/sync-relay/src/liveTickets.ts'),
    load('services/sync-relay/src/namedLiveHostReports.ts'),
    load('services/sync-relay/src/namedLiveBrowserHttp.ts'),
    load('services/sync-relay/src/linkLiveBrowserAuth.ts'),
    load('packages/ydoc-projection/src/namedLiveProvider.ts'),
    load('services/sync-relay/src/selfHostLiveProfile.ts'),
  ]);
  const { WebSocket } = require('ws'),
    profile = selfHostLiveProfile();
  const origin = 'https://document-size.invalid',
    host = 'relay.document-size.invalid';
  const exchangeKey = 'document-size-loopback-exchange-key-32';
  const captureNative = (binding, signal) => native.capture(binding, signal);
  const browser = createNamedLiveBrowserHttp({
    storage,
    publicOrigin: origin,
    exchangeKey,
    limits: profile.browserSessions,
    resolveActor: async (request, workspaceId) => {
      assert.equal(request.headers.get('cookie'), 'benchmark-account=reader');
      return { userId: 'reader', workspaceId };
    },
  });
  const tickets = createLiveTickets({
    storage,
    audience: origin,
    key: credentials.key,
    hostReports: createLiveHostReports({ storage, captureNative }),
  });
  const routes = Object.fromEntries(
    ['named', 'link'].map((kind) => [
      kind,
      createNamedLiveRoutes({
        kind,
        storage,
        publicOrigin: origin,
        exchangeKey,
        hosts: new Set([host]),
        limits: profile.namedLive.transport,
        frames: profile.frames,
        bounds: profile.namedLive.host,
        captureNative,
        tickets,
        sessions: kind === 'named' ? browser : createLinkLiveBrowserResolver({ storage, linkKey: credentials.key, publicEditRelease: { version: 1 } }),
        validate: async (input) => (await pool.submit({ kind: 'journal', policy: profile.validation, input })).result,
      }),
    ]),
  );
  const upgrades = new Set(),
    sockets = new Set();
  const server = serveFetchHandler({
    handler: (req) => {
      const path = new URL(req.url).pathname;
      return path.includes('named-sessions')
        ? browser(req)
        : path === '/sync/live/named-tickets'
          ? routes.named.handle(req)
          : routes.link.handle(req);
    },
    maxBodyBytes: () => profile.requests.maxRequestBytes,
    oversized: () => Response.json({}, { status: 413 }),
    failure: () => Response.json({}, { status: 500 }),
  });
  server.on('upgrade', (req, socket, head) => {
    const route = req.url?.startsWith('/sync/live/named?') ? routes.named : routes.link;
    const work = route.handleUpgrade(req, socket, head);
    upgrades.add(work);
    void work.finally(() => upgrades.delete(work));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const headers = (kind) => ({
    host,
    origin,
    'x-dohc-relay-exchange-key': exchangeKey,
    ...(kind === 'named'
      ? { cookie: 'benchmark-account=reader' }
      : {
          authorization: 'Bearer ' + credentials.capability,
          'x-dohc-link-profile-secret': credentials.profile,
        }),
  });
  const post = (path, body, kind) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          signal: options.signal,
          headers: { ...headers(kind), 'content-type': 'application/json' },
        },
        (response) => {
          const bytes = [];
          response.on('data', (value) => bytes.push(value));
          response.once('error', reject);
          response.once('end', () => {
            try {
              assert.equal(response.statusCode, 200, Buffer.concat(bytes).toString());
              resolve(JSON.parse(Buffer.concat(bytes).toString()));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once('error', reject);
      req.end(JSON.stringify(body));
    });
  const probes = [];
  return {
    probes,
    async run(entry, phase) {
      for (const kind of ['named', 'link']) {
        const started = performance.now();
        const { discriminator } =
          kind === 'named'
            ? await post('/sync/live/named-sessions', { grantId: 'grant' }, kind)
            : { discriminator: 'abcdefghijkl' };
        const ticket = await post(
          '/sync/live/' + kind + '-tickets',
          { discriminator, objectId: entry.document.objectId },
          kind,
        );
        const provider = createNamedLiveProvider(profile.editor.provider, { objectId: entry.document.objectId });
        const ws = new WebSocket(
          'ws://127.0.0.1:' + port + '/sync/live/' + kind + '?session=' + discriminator,
          ['dohc-live-v1', 'dohc-live-ticket.' + ticket.token],
          { headers: headers(kind), perMessageDeflate: false, handshakeTimeout: profile.editor.connectTimeoutMs },
        );
        sockets.add(ws);
        let route,
          inboundBytes = 0,
          outboundBytes = 0,
          receiving = Promise.resolve(),
          failure;
        const queued = [];
        ws.on('error', (error) => {
          failure = error;
        });
        ws.on('unexpected-response', (_req, response) => {
          failure = Error('Socket admission: ' + response.statusCode);
          response.resume();
          ws.terminate();
        });
        ws.on('message', (data) => {
          const bytes = Buffer.from(data);
          inboundBytes += bytes.byteLength;
          if (!route) queued.push(bytes);
          else receiving = receiving.then(() => route.receive(bytes));
          void receiving.catch((error) => {
            failure = error;
          });
        });
        const closed = once(ws, 'close').catch(() => {});
        const wait = (predicate) =>
          new Promise((resolve, reject) => {
            const signal = AbortSignal.any([options.signal, AbortSignal.timeout(profile.editor.connectTimeoutMs)]);
            let remove;
            const clean = () => {
              remove?.();
              signal.removeEventListener('abort', abort);
              ws.off('close', ended);
              ws.off('error', fail);
            };
            const check = () => {
              const state = provider.state();
              const error =
                failure ??
                (['quarantined', 'disconnected', 'closed'].includes(state.status)
                  ? Error('Provider ' + state.status + ': ' + state.reason)
                  : null);
              if (error) {
                clean();
                reject(error);
              } else if (predicate(state)) {
                clean();
                resolve();
              }
            };
            const abort = () => {
              clean();
              reject(signal.reason);
            };
            const fail = (error) => {
              clean();
              reject(error);
            };
            const ended = () => fail(failure ?? Error('Socket closed before proof completed'));
            remove = provider.subscribe(check);
            signal.addEventListener('abort', abort, { once: true });
            ws.once('close', ended);
            ws.once('error', fail);
            check();
          });
        try {
          await once(ws, 'open', { signal: options.signal });
          route = provider.connect({
            send: (bytes) =>
              new Promise((resolve, reject) => {
                outboundBytes += bytes.byteLength;
                ws.send(bytes, (error) => (error ? reject(error) : resolve()));
              }),
            close: () => ws.terminate(),
          });
          for (const bytes of queued) await route.receive(bytes);
          await wait((state) => state.status === 'live');
          assert.equal(sha256(projection.yDocToMarkdown(provider.doc)), sha256(projection.yDocToMarkdown(entry.doc)));
          const joinMs = performance.now() - started,
            initialTransferBytes = inboundBytes + outboundBytes;
          // A real provider edit must receive a durable native application ACK.
          const queue = [provider.body];
          let target;
          while (queue.length) {
            const node = queue.shift();
            if (node instanceof Y.XmlText && /[a-zA-Z]/.test(node.toString())) {
              target = node;
              break;
            }
            if (node.toArray) queue.push(...node.toArray().filter((value) => typeof value === 'object'));
          }
          assert.ok(target);
          const applyStarted = performance.now(),
            beforeAck = provider.state().lastApplied?.journalCursor;
          provider.doc.transact(() => {
            const at = target.toString().search(/[a-zA-Z]/);
            target.delete(at, 1);
            target.insert(at, 'n');
          });
          await wait(
            (state) => state.pendingUpdates === 0 && state.lastApplied && state.lastApplied.journalCursor !== beforeAck,
          );
          Y.applyUpdate(entry.doc, Y.encodeStateAsUpdate(provider.doc));
          probes.push({
            kind,
            phase,
            joinMs,
            applyMs: performance.now() - applyStarted,
            initialTransferBytes,
            inboundBytes,
            outboundBytes,
            steadyWireBytes: inboundBytes + outboundBytes - initialTransferBytes,
            verified: true,
          });
        } finally {
          provider.close();
          ws.terminate();
          await closed;
          await receiving.catch(() => {});
          await route?.settled();
          provider.doc.destroy();
          sockets.delete(ws);
        }
      }
    },
    async close() {
      for (const route of Object.values(routes)) route.close();
      for (const ws of sockets) ws.terminate();
      await Promise.allSettled([...upgrades]);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
