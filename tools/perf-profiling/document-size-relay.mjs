import { startGenerator } from './document-size-generator.mjs';
import { readReservationBounds } from './document-size-reservation.mjs';
import { startDocumentSocketProbe } from './document-size-sockets.mjs';
import { startDocumentNativeHost } from './document-size-native.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentValidationPool } from './document-size-pool.mjs';
import {
  documentFixture,
  MiB,
  sha256,
  STATE_MAX_BYTES,
  RELAY_CPU_BUDGET_MS,
  restoreReservation,
} from './document-size-fixtures.mjs';
import { documentStats } from './document-size-summary.mjs';

const SEED_WINDOW = 128;

// One row per SEED_WINDOW seeds: suffix, CPU median and wall time. Validation replays the whole
// suffix, so its cost only grows as seeding continues. After the cold first window, a median over the
// CPU budget means the longer timed suffix fails too.
export function seedWindow(updates, windows, wallMs) {
  if (updates.length < (windows.length + 1) * SEED_WINDOW) return null;
  const recent = updates.slice(-SEED_WINDOW);
  const cpuP50Ms = documentStats(recent.map((row) => row.cpuMs)).p50;
  return {
    validations: updates.length,
    maximumSuffixCount: Math.max(...recent.map((row) => row.suffixCount)),
    cpuP50Ms,
    wallMsPerValidation: wallMs / SEED_WINDOW,
    overBudget: windows.length >= 1 && cpuP50Ms > RELAY_CPU_BUDGET_MS.p50,
  };
}

// Production storage, schema, authority, journal, checkpoint and worker handler. No fake validation evidence.
export async function runRelayCase(options) {
  const checkout = resolve(options.checkout),
    directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const require = createRequire(join(checkout, 'services/sync-relay/package.json'));
  const load = (path) => import(pathToFileURL(join(checkout, path)).href);
  const [Y, projection, checkpointModule, validationModule, hostModule, contextModule, deploymentModule, linkSecurity, policyModule] =
    await Promise.all([
      import(pathToFileURL(require.resolve('yjs').replace(/yjs\.cjs$/, 'yjs.mjs')).href),
      load('packages/ydoc-projection/src/import-export.ts'),
      load('services/sync-relay/src/storage/liveJournalCheckpoint.ts'),
      load('packages/ydoc-projection/src/liveDocumentValidation.ts'),
      load('packages/live-session-contract/src/hostControl.ts'),
      load('packages/live-session-contract/src/limits.ts'),
      load('services/sync-relay/src/relayDeployment.ts'),
      load('services/sync-relay/src/linkSecurity.ts'),
      load('packages/ydoc-projection/src/liveValidationPolicy.ts'),
    ]);
  // The relay's own validation limits, so a measurement follows the checkout it runs.
  const policy = policyModule.WORKER_LIVE_VALIDATION_POLICY;
  const generator = startGenerator(options);
  try {
    const generated = await generator.call('init', options);
    const baselineBytes = generated.bytes,
      projectionText = generated.text;
    const bounds = await readReservationBounds(checkout);
    const { nodes, depth } = generated;
    const fixture = { sha256: generated.fixtureSha256, bytes: generated.sourceBytes };
    const result = {
      mib: options.mib,
      shape: options.shape,
      topology: options.topology,
      sessions: options.sessions,
      structural: !!options.structural,
      fixtureSha256: fixture.sha256,
      sourceBytes: fixture.bytes,
      projectedBytes: Buffer.byteLength(projectionText),
      baselineStateBytes: baselineBytes.byteLength,
      initialStateSha256: sha256(baselineBytes),
      churned: !!options.baselinePath,
      nodes,
      depth,
      activeContentLimit: contextModule.LIVE_MARKDOWN_MAX_BYTES,
      updates: [],
      checkpoints: [],
      status: 'running',
      workerHardLimitMiB: 512,
      workerMetrics:
        'Per-thread CPU; boundary-sampled old V8 spaces/external memory; 25 ms parent-requested total used heap conservatively bounds old space. RSS belongs to the relay process. Short intra-update peaks can be missed.',
      reservation: restoreReservation(baselineBytes.byteLength, bounds),
      reservationBounds: bounds,
      generatorPid: generator.pid,
      process: { pid: process.pid, startedAt: new Date().toISOString() },
    };
    const configPath = join(directory, 'deployment.json');
    deploymentModule.initializeRelayDeployment({
      configPath,
      relayPath: join(directory, 'volume/relay.sqlite'),
      continuityDirectory: join(directory, 'continuity'),
    });
    const deployment = deploymentModule.openRelayDeployment(configPath);
    const storage = deployment.storage;
    const db = storage.db;
    const schema = db
      .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name')
      .all();
    result.schemaSha256 = sha256(JSON.stringify(schema));
    result.sqlite = Object.fromEntries(
      ['journal_mode', 'synchronous', 'foreign_keys', 'page_size'].map((key) => [
        key,
        db.prepare('PRAGMA ' + key).get(),
      ]),
    );
    const pool = new DocumentValidationPool(checkout, options.signal);
    const docs = [];
    let native, sockets;
    let host = {
      mode: options.engineBinary ? 'service' : 'device',
      hostId: 'host',
      hostEpoch: hostModule.parseHostEpoch(1),
      instanceId: 'instance',
      connectionId: 'connection',
    };
    const validate = validationModule.createLiveMarkdownRegistrationValidator(policy);
    let counter = 0;
    try {
      storage.tx(() =>
        db
          .prepare(
            "INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES ('workspace','owner',0)",
          )
          .run(),
      );
      storage.provisionLiveHostControl({ mode: host.mode, hostId: host.hostId, updatedAtMs: 1, guard() {} });
      if (options.engineBinary) {
        native = await startDocumentNativeHost(options, deployment);
        host = native.coordinate;
        result.native = native.result;
      } else storage.registerLiveHost({ ...host, updatedAtMs: 2, guard() {} });
      const documentCount = options.topology === 'shared' ? 1 : options.sessions;
      for (let index = 0; index < documentCount; index++) {
        const objectId = 'object-' + index,
          currentPath = 'docs/' + objectId + '.md';
        const document = {
          workspaceId: 'workspace',
          mainVersionId: 'main',
          objectId,
          lineageClaimId: sha256(baselineBytes),
        };
        const registration = validate({ document, currentPath, checkpoint: baselineBytes });
        if (registration.kind !== 'accepted') {
          result.status = 'refused';
          result.refusal = { door: 'relay-registration', ...registration };
          return result;
        }
        storage.putBlob({
          workspaceId: 'workspace',
          sha256: registration.evidence.projectedMarkdownSha256,
          content: Buffer.from(projectionText),
          createdAtMs: 2,
        });
        storage.appendLogBatch({
          workspaceId: 'workspace',
          originId: 'owner',
          ops: [
            {
              originSeq: index,
              opKind: 'moment.append',
              recordedAtMs: 2,
              payloadJson: JSON.stringify({
                objectId,
                momentId: 'moment-' + index,
                versionId: 'main',
                recordedAtMs: 2,
                operation: 'write',
                path: currentPath,
                payloadAfterPath: currentPath,
                payloadAfterBlobSha256: registration.evidence.projectedMarkdownSha256,
                payloadAfterContentKind: 'text',
                payloadAfterByteLength: registration.evidence.projectedMarkdownByteLength,
              }),
            },
          ],
        });
        const registered = storage.registerLiveDocumentBaseline({
          host,
          evidence: registration.evidence,
          baselineBytes,
          registeredAtMs: 10,
        });
        assert.equal(registered.kind, 'registered', JSON.stringify(registered));
        docs.push({ document, currentPath, queue: Promise.resolve() });
      }
      storage.tx(() =>
        db
          .prepare(
            "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)",
          )
          .run(JSON.stringify({ paths: ['docs'], versionId: null })),
      );
      storage.tx(() =>
        db.exec(
          "INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',4,'active',0,NULL,NULL)",
        ),
      );
      const now = Date.now();
      const credentials = {
        key: 'document-size-key-32-characters-long',
        capability: Buffer.alloc(32, 7).toString('base64url'),
        profile: Buffer.alloc(32, 8).toString('base64url'),
      };
      assert.equal(
        storage.createLinkGrant({
          grant: {
            grantId: 'link-grant',
            shareId: 'share',
            principalKind: 'link',
            principalUserId: null,
            principalEmail: null,
            access: 'edit',
            generation: 1,
            status: 'active',
            createdAtMs: now,
            revokedAtMs: null,
            parentGrantId: null,
          },
          credential: {
            credentialId: 'link-credential',
            grantId: 'link-grant',
            secretHash: linkSecurity.hashLinkBearer('benchmark-link-secret', 'document-size-key-32-characters-long'),
            generation: 1,
            mintedAtMs: now,
            retiredAtMs: null,
          },
        }),
        true,
      );
      assert.equal(
        storage.mintLinkSession({
          session: {
            sessionId: 'link-session',
            capabilityHash: linkSecurity.hashLinkBearer(credentials.capability, 'document-size-key-32-characters-long'),
            grantId: 'link-grant',
            generation: 1,
            mintedAtMs: now,
            expiresAtMs: now + linkSecurity.LINK_SESSION_TTL_MS,
          },
        }),
        true,
      );
      const actors = [
        { kind: 'owner', userId: 'owner', shareId: 'share' },
        { kind: 'named', grantId: 'grant', userId: 'reader' },
        {
          kind: 'link',
          sessionId: 'link-session',
          profileTokenHash: linkSecurity.hashLinkProfileSecret(
            credentials.profile,
            'document-size-key-32-characters-long',
          ),
          grantId: 'link-grant',
          workspaceId: 'workspace',
        },
      ];
      const { readLinkEnrollment, commitLinkEnrollment } = await load(
        'services/sync-relay/src/storage/linkEnrollment.ts',
      );
      storage.tx(() => {
        const enrollmentCredentials = {
          capabilityHash: linkSecurity.hashLinkBearer(credentials.capability, 'document-size-key-32-characters-long'),
          profileTokenHash: actors[2].profileTokenHash,
        };
        const enrollment = readLinkEnrollment(storage, enrollmentCredentials, now);
        assert.ok(enrollment);
        commitLinkEnrollment(storage, {
          ...enrollmentCredentials,
          enrollment,
          principalId: 'benchmark-link-principal',
          displayName: 'Benchmark link',
          createdAtMs: now,
          discussionRevision: Number(enrollment.authority.discussion_revision),
        });
      });
      result.doorAdmissions = { owner: 0, named: 0, link: 0 };
      const hydrate = async () => {
        for (let n = 0; n < docs.length; n++) {
          docs[n].doc?.destroy();
          docs[n].doc = new Y.Doc();
          Y.applyUpdate(docs[n].doc, await generator.call('state', { session: n }));
        }
      };
      const warmed = await Promise.all(
        docs.slice(0, 2).map((entry) =>
          pool.submit({
            kind: 'settlement',
            policy,
            input: { document: entry.document, currentPath: entry.currentPath, checkpoint: baselineBytes },
          }),
        ),
      );
      for (const warm of warmed) assert.equal(warm.result.kind, 'accepted');
      for (const entry of docs) {
        entry.doc?.destroy();
        delete entry.doc;
      }
      const updates = options.updates ?? 240;
      let started = performance.now();
      const usageBefore = process.resourceUsage();
      const privateSamples = [];
      let sampling;
      const samplePrivate = () =>
        (sampling ??= (async () => {
          if (process.platform === 'win32') {
            const { stdout } = await promisify(execFile)(
              'pwsh.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-File',
                fileURLToPath(new URL('./packaged-process-snapshot.ps1', import.meta.url)),
                '-AppProcessId',
                String(process.pid),
              ],
              { windowsHide: true, timeout: 30000 },
            );
            const sample = JSON.parse(stdout);
            privateSamples.push({
              elapsedMs: performance.now() - started,
              privateBytes: sample.processes.find((row) => row.pid === process.pid)?.privateBytes,
              samplerMs: sample.completedAtMs - sample.startedAtMs,
              processes: sample.processes,
            });
          }
        })().finally(() => {
          sampling = null;
        }));
      const update = async (entry, session, index) => {
        options.signal?.throwIfAborted();
        const actor = actors[index % actors.length];
        const updateBytes = await generator.call('edit', { session, index, shared: options.topology === 'shared' });
        const current = storage.resolveCurrentLiveDocumentBinding({ document: entry.document, actor });
        assert.equal(current.kind, 'current', JSON.stringify(current));
        const cutStart = performance.now(),
          cut = storage.readLiveUpdateJournalCut({ document: entry.document });
        assert.equal(cut.kind, 'cut', JSON.stringify(cut));
        const readMs = performance.now() - cutStart;
        const measured = await pool.submit({
          kind: 'journal',
          policy,
          input: {
            document: entry.document,
            currentPath: entry.currentPath,
            checkpoint: cut.cut.checkpoint.bytes,
            suffix: cut.cut.suffix.map((row) => row.bytes),
            candidate: updateBytes,
          },
        });
        if (measured.result.kind !== 'accepted')
          throw Error('Relay update refused: ' + JSON.stringify(measured.result));
        const commitStart = performance.now();
        const committed = storage.commitLiveUpdateJournal({
          host,
          actor,
          expectedAuthority: current.authority,
          metadata: {
            deliveryId: 'delivery-' + counter++,
            updateDigest: sha256(updateBytes),
            binding: current.binding,
          },
          cutToken: cut.cut,
          validation: measured.result,
          updateBytes,
          receivedAtMs: Date.now(),
        });
        assert.equal(committed.result.kind, 'accepted', JSON.stringify(committed.result));
        result.doorAdmissions[actor.kind]++;
        const commitMs = performance.now() - commitStart;
        const stateBytes = measured.result.evidence.stateUpdateByteLength;
        assert.ok(stateBytes <= STATE_MAX_BYTES, '20 MiB state ceiling');
        const row = {
          session,
          index,
          ...measured.metrics,
          waitMs: measured.waitMs,
          slotMs: measured.slotMs,
          readMs,
          commitMs,
          updateBytes: updateBytes.byteLength,
          stateBytes,
          suffixCount: cut.cut.suffixCount,
          suffixBytes: cut.cut.suffixBytes,
          scheduledLagMs: performance.now() - started - (index * 1000) / options.updatesPerSecond,
        };
        result.updates.push(row);
        if (
          checkpointModule.liveJournalCheckpointDue(
            cut.cut.suffixCount + 1,
            cut.cut.suffixBytes + updateBytes.byteLength,
          )
        )
          result.checkpoints.push(row);
      };
      // Real production validation and commits seed the long suffix, each document in order and the
      // documents across both workers. No measured samples or occupancy are mixed with this unpaced
      // preparation. Its windows calibrate the estimate, and a gate run stops seeding over budget.
      const seedCount = options.seedUpdates ?? 0;
      if (seedCount) {
        const seedStarted = performance.now(),
          windows = [];
        let seedFailure,
          overBudget,
          windowStarted = seedStarted;
        const afterSeed = () => {
          const window = seedWindow(result.updates, windows, performance.now() - windowStarted);
          if (!window) return;
          windows.push(window);
          windowStarted = performance.now();
          if (window.overBudget && !options.pilot) overBudget ??= window;
        };
        await Promise.all(
          docs.map(async (entry, session) => {
            for (let index = 0; index < seedCount && !seedFailure && !overBudget; index++)
              await update(entry, session, index).then(afterSeed, (error) => {
                seedFailure ??= error;
              });
          }),
        );
        if (seedFailure) throw seedFailure;
        result.seed = {
          updatesPerDocument: seedCount,
          validations: result.updates.length,
          elapsedMs: performance.now() - seedStarted,
          suffixCounts: docs.map(
            (entry) => storage.readLiveUpdateJournalCut({ document: entry.document }).cut.suffixCount,
          ),
          checkpointCount: result.checkpoints.length,
          windows,
          overBudget: overBudget ?? null,
        };
        result.updates = [];
        result.checkpoints = [];
        if (overBudget) {
          result.status = 'over-budget';
          return result;
        }
      }
      await samplePrivate();
      started = performance.now();
      pool.resetUsage();
      const sampler = setInterval(() => {
        void samplePrivate().catch((error) => {
          result.samplerError = String(error);
        });
      }, 5000);
      sampler.unref();
      try {
        const completions = await Promise.allSettled(
          Array.from({ length: options.sessions }, async (_, session) => {
            const entry = docs[options.topology === 'shared' ? 0 : session];
            for (let index = 0; index < updates; index++) {
              const due = started + (index * 1000) / options.updatesPerSecond;
              if (due > performance.now()) await delay(due - performance.now(), undefined, { signal: options.signal });
              // A shared document is ordered; separate documents compete for both worker slots.
              entry.queue = entry.queue.then(() => update(entry, session, index));
              void entry.queue.catch(() => {});
              if (performance.now() - due > 16000) throw Error('Offered relay load is more than 128 updates behind');
            }
            await entry.queue;
          }),
        );
        const drained = await Promise.allSettled(docs.map((entry) => entry.queue));
        const failure = [...completions, ...drained].find((row) => row.status === 'rejected');
        if (failure) throw failure.reason;
        result.elapsedMs = performance.now() - started;
        result.pool = pool.usage();
      } finally {
        clearInterval(sampler);
        await sampling;
        await samplePrivate();
        result.privateSamples = privateSamples;
      }
      result.updatePayloadBytesPerEdit =
        result.updates.reduce((n, row) => n + row.updateBytes, 0) / result.updates.length;
      result.writeOperations = process.resourceUsage().fsWrite - usageBefore.fsWrite; // OS operations, never bytes.
      result.achievedUpdatesPerSecondPerSession = (updates * 1000) / result.elapsedMs;
      result.processMemory = process.memoryUsage();
      result.privatePeakSampledBytes = privateSamples.length
        ? Math.max(...privateSamples.map((row) => row.privateBytes))
        : null;
      result.steadyBytesPerEdit = result.socketProbes?.length
        ? Math.max(...result.socketProbes.map((row) => row.steadyWireBytes))
        : null;
      result.initialTransferBytes = result.socketProbes?.reduce((n, row) => n + row.initialTransferBytes, 0) ?? null;
      result.initialTransferPerDocumentBytes = result.socketProbes?.length
        ? Math.max(...result.socketProbes.map((row) => row.initialTransferBytes))
        : null;
      result.largestStateBytes = Math.max(baselineBytes.byteLength, ...result.updates.map((row) => row.stateBytes));
      result.reservation = restoreReservation(result.largestStateBytes, bounds);
      // Reconstruct the committed cut in an independent Y.Doc; disk reopen is below.
      for (const entry of docs) {
        const cut = storage.readLiveUpdateJournalCut({ document: entry.document });
        assert.equal(cut.kind, 'cut');
        const recovered = new Y.Doc();
        Y.applyUpdate(recovered, cut.cut.checkpoint.bytes);
        for (const row of cut.cut.suffix) Y.applyUpdate(recovered, row.bytes);
        assert.equal(
          sha256(projection.yDocToMarkdown(recovered)),
          await generator.call('hash', { session: docs.indexOf(entry) }),
          'No lost relay edits',
        );
        recovered.destroy();
      }
      result.journalRecoveryVerified = true;
      // Proof clients allocate Y.Docs only after timed memory/rate samples finish.
      await hydrate();
      if (native) {
        result.nativeDrainMs = await native.apply(docs[0]);
        await native.join(docs, Y, projection);
        sockets = await startDocumentSocketProbe(options, storage, native, pool, projection, Y, credentials);
        result.socketProbes = sockets.probes;
        for (let n = 0; n < (options.socketRepeats ?? 5); n++) await sockets.run(docs[0], 'fresh');
        native.onRestart = async () => {
          for (let n = 0; n < (options.socketRepeats ?? 5); n++) await sockets.run(docs[0], 'restart');
        };
      }
      if (native) await native.finish(docs, Y, projection, sha256(baselineBytes), sha256(projectionText));
      result.initialTransferPerDocumentBytes = result.socketProbes?.length
        ? Math.max(...result.socketProbes.map((row) => row.initialTransferBytes))
        : null;
      result.steadyBytesPerEdit = result.socketProbes?.length
        ? Math.max(...result.socketProbes.map((row) => row.steadyWireBytes))
        : null;
      result.status = 'complete';
      return result;
    } catch (error) {
      result.status = 'failed';
      result.error = String(error?.stack ?? error);
      return result;
    } finally {
      for (const close of [() => sockets?.close(), () => pool.close(), () => native?.close()]) {
        try {
          await close();
        } catch (error) {
          result.status = 'failed';
          (result.cleanupErrors ??= []).push(String(error?.stack ?? error));
        }
      }
      for (const entry of docs) entry.doc?.destroy();
      result.databaseFilesBytes = await Promise.all(
        ['relay.sqlite', 'relay.sqlite-wal'].map((name) =>
          stat(join(directory, 'volume', name)).then(
            (row) => row.size,
            (error) => {
              if (error.code === 'ENOENT') return 0;
              throw error;
            },
          ),
        ),
      );
      storage.close();
      result.databaseBytes = (await stat(join(directory, 'volume/relay.sqlite'))).size;
      await writeFile(join(directory, 'relay-result.json'), JSON.stringify(result, null, 2) + '\n');
    }
  } finally {
    await generator.close();
  }
}

// Offline CRDT churn is separate from admitted-update timing. Encode every 1024 edits,
// then binary-refine the first crossing from the saved predecessor. Production compaction
// remains at 64; offline encoding cadence does not change the admitted workload.
export async function measureChurn(options) {
  const require = createRequire(join(options.checkout, 'services/sync-relay/package.json'));
  const Y = await import(pathToFileURL(require.resolve('yjs').replace(/yjs\.cjs$/, 'yjs.mjs')).href);
  const projection = await import(
    pathToFileURL(join(options.checkout, 'packages/ydoc-projection/src/import-export.ts')).href
  );
  const fixture = documentFixture(options.mib, options.shape, { structural: options.structural ?? false });
  const doc = projection.markdownToYDoc(fixture.text, { clientID: 101 });
  const text = (() => {
    const queue = [doc.getXmlFragment('body')];
    while (queue.length) {
      const node = queue.shift();
      if (node instanceof Y.XmlText && node.length > 8) return node;
      if (node.toArray) queue.push(...node.toArray().filter((value) => typeof value === 'object'));
    }
    throw Error('No churn text');
  })();
  const initialBytes = Y.encodeStateAsUpdate(doc).byteLength;
  const samples = [{ edits: 0, stateBytes: initialBytes }];
  let firstOverEdit = initialBytes > STATE_MAX_BYTES ? 0 : null,
    checkpoint = Y.encodeStateAsUpdate(doc);
  const maximum = options.maxEdits ?? Math.max(options.churnEdits, 1_000_000);
  let requiredBytes = null,
    nodeCount = 0;
  const edit = (target, n) => {
    target.doc.clientID = 1000 + (n % 8);
    target.doc.transact(() => {
      target.delete(0, 1);
      target.insert(0, n % 2 ? 'q' : 'x');
    });
  };
  try {
    for (let n = 1; n <= maximum && firstOverEdit === null; n++) {
      options.signal?.throwIfAborted();
      edit(text, n);
      if (n % 1024 === 0 || n === options.churnEdits || n === maximum) {
        const bytes = Y.encodeStateAsUpdate(doc);
        assert.ok(bytes.byteLength >= samples.at(-1).stateBytes, 'The fixed churn fixture must grow monotonically');
        samples.push({ edits: n, stateBytes: bytes.byteLength });
        if (n === options.churnEdits) {
          requiredBytes = bytes.byteLength;
          if (options.directory)
            await writeFile(join(options.directory, 'churn-state-' + !!options.structural + '.bin'), bytes);
        }
        if (bytes.byteLength > STATE_MAX_BYTES) {
          const previous = samples.at(-2).edits;
          const stateAt = (end) => {
            const prior = new Y.Doc();
            Y.applyUpdate(prior, checkpoint);
            try {
              const queue = [prior.getXmlFragment('body')];
              let target;
              while (queue.length) {
                const node = queue.shift();
                if (node instanceof Y.XmlText && node.length > 8) {
                  target = node;
                  break;
                }
                if (node.toArray) queue.push(...node.toArray().filter((value) => typeof value === 'object'));
              }
              for (let step = previous + 1; step <= end; step++) edit(target, step);
              return Y.encodeStateAsUpdate(prior).byteLength;
            } finally {
              prior.destroy();
            }
          };
          let low = previous + 1,
            high = n;
          while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (stateAt(mid) > STATE_MAX_BYTES) high = mid;
            else low = mid + 1;
          }
          firstOverEdit = low;
          assert.ok(stateAt(low) > STATE_MAX_BYTES && (low === 1 || stateAt(low - 1) <= STATE_MAX_BYTES));
        }
        checkpoint = bytes;
      }
    }
    const walk = (node) => {
      nodeCount++;
      if (node.toArray) for (const child of node.toArray()) if (typeof child === 'object') walk(child);
    };
    walk(doc.getXmlFragment('body'));
    return {
      mib: options.mib,
      shape: options.shape,
      structural: !!options.structural,
      fixtureSha256: fixture.sha256,
      initialBytes,
      initialHeadroomBytes: STATE_MAX_BYTES - initialBytes,
      requiredEdits: options.churnEdits,
      requiredBytes,
      firstOverEdit,
      testedThroughEdits: samples.at(-1).edits,
      crossingCensored: firstOverEdit === null,
      nodeCount,
      samples,
      pass: initialBytes <= STATE_MAX_BYTES - 5 * MiB && requiredBytes !== null && requiredBytes <= STATE_MAX_BYTES,
    };
  } finally {
    doc.destroy();
  }
}
