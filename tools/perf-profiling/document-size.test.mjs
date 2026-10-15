import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { observeDocumentReplacement, engineHistoryBytes } from './packaged-document-size.mjs';
import { relativeBudget, soakChecks } from './document-size-summary.mjs';
import { startGenerator } from './document-size-generator.mjs';
import { spawnSync } from 'node:child_process';
import {
  DOCUMENT_SIZES,
  DOCUMENT_SHAPES,
  documentFixture,
  documentControlFiles,
  documentMatrix,
  MiB,
  restoreReservation,
} from './document-size-fixtures.mjs';
import { parseOptions } from './packaged-benchmark-options.mjs';
import { documentStats, summarizeDocumentSize } from './document-size-summary.mjs';
import { compareSummaries } from './compare-packaged-benchmark.mjs';
import { DocumentValidationPool } from './document-size-pool.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';

const args = [
  '--binary',
  'absent.exe',
  '--package-commit',
  'a'.repeat(40),
  '--output',
  'unused-evidence',
  '--label',
  'candidate',
  '--scenario',
  'document-size',
];
const bounds = {
  maxEvents: 64,
  headerBytes: 643576,
  reserveBytes: 8 * MiB,
  relayAggregateBytes: 40 * MiB,
  nativeAggregateBytes: 512 * MiB,
};
const stats = (value, count = 20) => ({ count, p50: value, p95: value, min: value, max: value });
const soak = (mib) => ({
  mib,
  shape: 'formatted-retained',
  editsPerMinute: 480,
  memory: [
    { elapsedMs: 600000, kinds: { renderer: { privateBytes: 300000000 } } },
    { elapsedMs: 3600000, kinds: { renderer: { privateBytes: 350000000 } } },
  ],
  compactions: [
    { retainedBytes: 100000, observedUpperBoundMs: 100 },
    { retainedBytes: 200000, observedUpperBoundMs: 100 },
  ],
});
export function passingDocumentSummary() {
  const settings = {
    scenario: 'document-size',
    documentMode: 'gate',
    documentMiB: [2, 5, 8, 10],
    runCount: 20,
    relaySessions: [1, 2, 4],
    updatesPerSecond: 8,
    churnEdits: 100000,
    soakMinutes: 60,
    keystrokes: 60,
  };
  const result = {
    status: 'complete',
    settings,
    diagnostic: false,
    freshEditableObservedMs: stats(500),
    restartEditableObservedMs: stats(500),
    documentSize: {
      metricsVersion: 2,
      missingPairs: 0,
      controls: { legacyOpenMs: stats(100, 40), linksOpenMs: stats(100, 40) },
      soakAttempts: [10, 8, 5, 2].map(soak),
      cases: {},
    },
  };
  for (const mib of DOCUMENT_SIZES)
    for (const shape of DOCUMENT_SHAPES) {
      const state = mib * MiB + 100000;
      const phase = () => ({
        runs: 40,
        failures: 0,
        firstContentMs: stats(100, 40),
        editReadyMs: stats(200, 40),
        firstKeyMs: stats(16, 40),
        typingMs: stats(16, 40 * 59),
        settleMs: stats(100, 40),
        engineCores: stats(0.25, 40),
        rate: stats(480, 40),
        exportVerified: 3,
        historyVerified: 3,
      });
      const relay = () => ({
        runs: 1,
        failures: 0,
        recoveryVerified: 1,
        longSuffixUpdates: 2000,
        rate: stats(8, 1),
        fixtureSha256: ['fixture-' + mib + shape],
        socketProbesVerified: 1,
        socketJoinMs: stats(100),
        socketApplyMs: stats(100),
        snapshotBytes: stats(state, 1),
        nativeJoinMs: stats(100),
        nativeSettleMs: stats(100),
        nativeRestoreMs: stats(100),
        nativeRestartVerified: 1,
        restoreVerified: 1,
        cpuMs: stats(20, 960),
        waitMs: stats(0, 960),
        slotMs: stats(30, 960),
        occupancy: stats(0.4, 1),
        oldGenerationPeakBytes: stats(100 * MiB, 1),
        privatePeakSampledBytes: stats(200 * MiB, 1),
        steadyBytesPerEdit: stats(100, 1),
        stateBytes: stats(state, 960),
        backlogGrowthMs: stats(0, 1),
        initialTransferPerDocumentBytes: stats(state, 1),
        largestStateBytes: state,
        reservation: restoreReservation(state, bounds),
        maximumNodes: 60000,
        maximumDepth: 3,
        checkpointCount: 1,
      });
      result.documentSize.cases[mib + '/' + shape] = {
        mib,
        shape,
        pairs: 40,
        repetitions: Array.from({ length: 40 }, (_, i) => i + 1),
        fixtureSha256: ['fixture-' + mib + shape],
        phases: { fresh: phase(), restart: phase() },
        peerPhases: Object.fromEntries(['peer', 'churn'].map((mode) => [mode, { ...phase(), verified: 40 }])),
        relay: Object.fromEntries(
          ['separate/1', 'separate/2', 'separate/4', 'shared/4'].map((label) => [label, relay()]),
        ),
        churn: [
          { structural: false, requiredBytes: state, pass: true },
          { structural: true, admission: { status: 'refused' } },
        ],
        churnedRelay: [
          ['separate', 1],
          ['separate', 4],
          ['shared', 4],
        ].map(([topology, sessions]) => ({
          topology,
          sessions,
          status: 'complete',
          churned: true,
          privatePeakSampledBytes: 200 * MiB,
          largestStateBytes: state,
          updates: Array.from({ length: 240 * sessions }, () => ({
            cpuMs: 20,
            waitMs: 0,
            slotMs: 30,
            oldGenerationBytes: 100 * MiB,
            sampledUsedHeapPeakBytes: 100 * MiB,
          })),
        })),
      };
    }
  return result;
}

test('document-size gate uses bounded pair counts while refusing reduced workload lengths', () => {
  const options = parseOptions(args);
  assert.equal(options.runCount, 20);
  assert.equal(options.keystrokes, 60);
  assert.equal(options.soakMinutes, 60);
  assert.equal(documentMatrix(options).length, 16);
  for (const flags of [
    ['--runs', '5'],
    ['--document-mib', '2,5,10'],
    ['--relay-sessions', '1,2'],
    ['--churn-edits', '99999'],
    ['--updates-per-second', '4'],
    ['--soak-minutes', '10'],
  ])
    assert.throws(() => parseOptions([...args, ...flags]));
  assert.equal(parseOptions([...args, '--runs', '5', '--document-mode', 'pilot']).documentMode, 'pilot');
});

test('all fixtures have exact UTF-8 sizes, stable hashes, multilingual text and node headroom', () => {
  for (const mib of DOCUMENT_SIZES)
    for (const shape of DOCUMENT_SHAPES) {
      const value = documentFixture(mib, shape);
      assert.equal(Buffer.byteLength(value.text), mib * MiB);
      assert.equal(value.sha256, documentFixture(mib, shape).sha256);
      assert.match(value.text, /日本語/);
      assert.match(value.text, /مرحبا/);
      assert.ok(value.paragraphBytes >= 700);
      assert.ok(value.paragraphs * 7 < 131072, 'Conservative rich-node upper bound');
      assert.equal(value.retained, shape.endsWith('-retained'));
      assert.equal(value.text.includes('# retained source'), value.retained);
    }
  assert.ok(documentFixture(10, 'formatted', { structural: true }).paragraphBytes < 150);
});

test('restore reservation follows native header and String-vector bounds, with memory taking precedence', () => {
  const at20 = restoreReservation(20 * MiB, bounds);
  assert.equal(at20.relayBytes, 328 * MiB);
  assert.equal(at20.fitsCurrentRelay, false);
  assert.equal(at20.fitsNative, false);
  assert.ok(restoreReservation(10 * MiB, bounds).fitsNative);
});

test('40-run p95 is the third-slowest, while five-run p95 is the slowest', () => {
  assert.equal(documentStats([1, 2, 3, 4, 50]).p95, 50);
  assert.equal(documentStats(Array.from({ length: 40 }, (_, i) => i + 1)).p95, 38);
  assert.equal(documentStats([NaN, null]).count, 0);
});

test('document-size decision measures 8 MiB and selects one contiguous passing size', () => {
  const baseline = passingDocumentSummary(),
    candidate = passingDocumentSummary();
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 10);
  candidate.documentSize.cases['10/formatted'].phases.fresh.editReadyMs = stats(3000);
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 8);
  candidate.documentSize.soakAttempts.find((row) => row.mib === 8).memory[1].kinds.renderer.privateBytes = 500000000;
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 5);
  candidate.documentSize.cases['2/formatted-retained'].relay['separate/4'].failures = 1;
  assert.equal(compareSummaries(baseline, candidate).pass, false);
});

test('required measurements fail closed; relative gates have spread and frame margins', () => {
  const baseline = passingDocumentSummary();
  const candidate = passingDocumentSummary();
  candidate.freshEditableObservedMs = stats(510);
  candidate.documentSize.cases['10/formatted'].phases.fresh.typingMs = stats(25, 2360);
  const comparison = compareSummaries(baseline, candidate);
  assert.equal(comparison.selectedMiB, 10);
  assert.ok(comparison.checks.filter((row) => row.marginMs !== undefined).every((row) => row.marginMs >= 17));
  candidate.documentSize.cases['10/formatted'].phases.fresh.typingMs = stats(60, 2360);
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 8);
  for (const mutate of [
    (v) => {
      delete v.documentSize.cases['2/plain'].phases.restart;
    },
    (v) => {
      delete v.documentSize.cases['2/formatted-retained'].relay['separate/4'].cpuMs;
    },
    (v) => {
      v.documentSize.cases['2/plain'].churn = [];
    },
    (v) => {
      v.documentSize.cases['2/plain'].peerPhases.peer.verified = 0;
    },
    (v) => {
      v.documentSize.cases['2/plain'].phases.fresh.rate.min = 400;
    },
    (v) => {
      v.documentSize.cases['2/formatted-retained'].relay['separate/2'].longSuffixUpdates = 0;
    },
  ]) {
    const value = passingDocumentSummary();
    mutate(value);
    assert.equal(compareSummaries(baseline, value).pass, false);
  }
});
test('incomplete receipts and duplicated pairs cannot select a size', () => {
  for (const mutate of [
    (v) => {
      v.settings.documentMode = 'pilot';
    },
    (v) => {
      v.documentSize.cases['2/plain'].repetitions[39] = 1;
    },
    (v) => {
      v.documentSize.cases['2/plain'].fixtureSha256 = ['different'];
    },
    (v) => {
      v.documentSize.metricsVersion = 1;
    },
  ]) {
    const value = passingDocumentSummary();
    mutate(value);
    assert.equal(compareSummaries(passingDocumentSummary(), value).pass, false);
  }
});

test('summary retains refusals and does not invent typing, relay, memory or export data', async () => {
  const data = {
    status: 'complete',
    settings: { ...passingDocumentSummary().settings, documentMiB: [2] },
    runs: [
      {
        documentSize: {
          mib: 2,
          shape: 'plain',
          repetition: 1,
          phases: [
            {
              phase: 'fresh',
              fixtureSha256: 'a',
              status: 'refused',
              refusal: 'too large',
              samples: [],
              firstContentMs: 50,
            },
          ],
        },
      },
    ],
  };
  const item = (await summarize(data)).documentSize.cases['2/plain'];
  assert.deepEqual(item.phases.fresh.refusals, ['too large']);
  assert.equal(item.phases.fresh.typingMs.count, 0);
  assert.equal(item.relay['separate/4'].cpuMs.count, 0);
  assert.equal(item.memory60Bytes.count, 0);
  assert.equal(compareSummaries(passingDocumentSummary(), await summarize(data)).pass, false);
});

test('dry-run writes an attributable plan and launches no binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dohc-document-size-dry-'));
  try {
    const output = join(directory, 'plan');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./packaged-benchmark.mjs', import.meta.url)),
        ...args,
        '--document-mib',
        '2',
        '--document-mode',
        'dry-run',
      ].map((value, index, all) => (all[index - 1] === '--output' ? output : value)),
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(await readFile(join(output, 'document-size-plan.json'), 'utf8'));
    assert.equal(plan.diagnostic, true);
    assert.equal(plan.matrix.length, 4);
  } finally {
    const owned = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(!isAbsolute(owned) && !owned.startsWith('..') && owned.startsWith('dohc-document-size-dry-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared-document latency is reported, while separate-document latency gates', () => {
  const baseline = passingDocumentSummary(),
    candidate = passingDocumentSummary();
  candidate.documentSize.cases['2/formatted-retained'].relay['shared/4'].cpuMs = stats(1000, 2600);
  const result = compareSummaries(baseline, candidate);
  assert.equal(result.pass, true);
  assert.ok(result.checks.some((row) => row.metric === 'shared/4 cpuMs p95' && row.verdict === 'reported'));
  candidate.documentSize.cases['2/plain'].relay['separate/4'].cpuMs = stats(1000, 2600);
  assert.equal(compareSummaries(baseline, candidate).pass, false);
});

test('real worker pool preserves capacity, measures the shipping handler and closes all workers', async () => {
  const pool = new DocumentValidationPool(
    fileURLToPath(new URL('../../', import.meta.url)),
    AbortSignal.timeout(60000),
  );
  try {
    const policy = {
      maxStructVisits: 1000,
      maxValueNodeVisits: 1000,
      maxDecodedPayloadByteVisits: 1000,
      maxStructClientGroupVisits: 1000,
      maxDeleteClientGroupVisits: 1000,
      maxDeleteIntervalVisits: 1000,
      maxIndexOperations: 1000,
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => pool.submit({ kind: 'settlement', policy, input: {} })),
    );
    assert.ok(results.every((row) => row.result.kind === 'refused'));
    assert.ok(results.every((row) => row.metrics.heapSamples >= 1 && row.metrics.sampledUsedHeapPeakBytes > 0));
    assert.equal(pool.usage().peakBusy, 2);
  } finally {
    await pool.close();
  }
  await assert.rejects(pool.submit({}), /closed/);
});

test('closing the real worker pool settles active and waiting submissions', async () => {
  const pool = new DocumentValidationPool(resolve('.'), AbortSignal.timeout(60000));
  const pending = Array.from({ length: 4 }, () => pool.submit({ kind: 'settlement', policy: {}, input: {} }));
  const outcomes = Promise.allSettled(pending);
  await pool.close();
  assert.ok((await outcomes).every((row) => row.status === 'rejected'));
});

test('typing includes key queue delay and the task after frame rendering', async () => {
  let now = 100;
  const events = new Map();
  class Channel {
    constructor() {
      this.port1 = { close() {} };
      this.port2 = {
        close() {},
        postMessage: () => {
          now = 140;
          queueMicrotask(() => this.port1.onmessage());
        },
      };
    }
  }
  const context = vm.createContext({
    window: {
      addEventListener: (name, fn) => events.set(name, fn),
      removeEventListener: (name) => events.delete(name),
    },
    performance: { now: () => now },
    MessageChannel: Channel,
    setTimeout,
    clearTimeout,
    cancelAnimationFrame() {},
    requestAnimationFrame: (fn) => {
      now = 110;
      queueMicrotask(fn);
      return 1;
    },
  });
  const pending = vm.runInContext('(' + observeDocumentReplacement.toString() + ')()', context);
  events.get('keydown')({ key: 'x', timeStamp: 10, isTrusted: true });
  events.get('input')({ isTrusted: true });
  const sample = await pending;
  assert.equal(sample.keyToFrameMs, 130);
  assert.equal(sample.triggerTrusted, true);
});
test('retained overhead and post-compaction gate ignore healthy current-state growth', () => {
  const row = soak(2);
  row.compactions[0].logicalBytes = 2 * MiB;
  row.compactions[1].logicalBytes = 3 * MiB;
  assert.equal(soakChecks(row).retained, 100000);
  const value = passingDocumentSummary();
  value.documentSize.soakAttempts = [row];
  value.documentSize.cases['5/plain'].phases.fresh.failures = 1;
  assert.equal(compareSummaries(passingDocumentSummary(), value).selectedMiB, 2);
  row.compactions[1].retainedBytes = 4 * MiB;
  assert.equal(compareSummaries(passingDocumentSummary(), value).pass, false);
});
test('comparison margins include measured control spread without hiding candidate spread', () => {
  const control = { count: 40, p50: 16, p95: 40 };
  assert.equal(relativeBudget(control, stats(16), 'p95', { percent: 10, floorMs: 17 }).marginMs, 24);
  assert.equal(relativeBudget(stats(16), { p50: 16, p95: 100 }, 'p95', { percent: 10, floorMs: 17 }).limit, 33);
});
test('fixture Y.Docs live outside the relay process and shared peers have independent client IDs', async () => {
  const generator = startGenerator({ checkout: fileURLToPath(new URL('../../', import.meta.url)) });
  try {
    assert.notEqual(generator.pid, process.pid);
    const initial = await generator.call('init', {
      checkout: fileURLToPath(new URL('../../', import.meta.url)),
      mib: 2,
      shape: 'plain',
      sessions: 2,
    });
    assert.equal(initial.sourceBytes, 2 * MiB);
    const a = await generator.call('edit', { session: 0, index: 0, shared: true }),
      b = await generator.call('edit', { session: 1, index: 1, shared: true });
    assert.notDeepEqual(a, b);
    assert.equal(await generator.call('hash', { session: 0 }), await generator.call('hash', { session: 1 }));
  } finally {
    await generator.close();
  }
});
test('production checkpoint predicate covers both count and 20 MiB suffix-byte boundaries', async () => {
  const { tsImport } = createRequire(
    join(fileURLToPath(new URL('../../', import.meta.url)), 'services/sync-relay/package.json'),
  )('tsx/esm/api');
  const { liveJournalCheckpointDue } = await tsImport(
    '../../services/sync-relay/src/storage/liveJournalCheckpoint.ts',
    import.meta.url,
  );
  assert.equal(liveJournalCheckpointDue(4094, 20 * MiB - 1), false);
  assert.equal(liveJournalCheckpointDue(4095, 10), true);
  assert.equal(liveJournalCheckpointDue(4, 20 * MiB), true);
});

test('history probes exclude the current head snapshot and preserve physical bytes', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(join(tmpdir(), 'dohc-history-probe-'));
  try {
    await mkdir(join(directory, '.dohc/engine'), { recursive: true });
    const db = new DatabaseSync(join(directory, '.dohc/engine/engine.db'));
    db.exec(
      "CREATE TABLE binary_blobs(sha256 TEXT,byte_length INTEGER); CREATE TABLE ydoc_docs(workspace_id TEXT,version_id TEXT,object_id TEXT,head_update_seq INTEGER,head_snapshot_seq INTEGER); CREATE TABLE ydoc_updates(update_blob_sha256 TEXT); CREATE TABLE ydoc_snapshots(workspace_id TEXT,version_id TEXT,object_id TEXT,up_to_seq INTEGER,snapshot_blob_sha256 TEXT,state_vector_blob_sha256 TEXT); INSERT INTO binary_blobs VALUES ('head',2097152),('vector',100),('old',1024); INSERT INTO ydoc_docs VALUES ('w','main','o',64,64); INSERT INTO ydoc_snapshots VALUES ('w','main','o',64,'head','vector'),('w','main','o',0,'old','vector');",
    );
    const first = await engineHistoryBytes({ rootPath: directory });
    db.exec("UPDATE binary_blobs SET byte_length=4194304 WHERE sha256='head'");
    const later = await engineHistoryBytes({ rootPath: directory });
    db.close();
    assert.equal(first.retainedBytes, 1024);
    assert.equal(later.retainedBytes, 1024);
    assert.ok(later.logicalBytes > first.logicalBytes);
    assert.ok(later.physicalBytes > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('missing compactions produce missing history evidence without throwing', () => {
  const data = {
    settings: { ...passingDocumentSummary().settings, documentMiB: [2] },
    runs: [],
    documentSoaks: [{ mib: 2, shape: 'plain', memory: [] }],
  };
  assert.equal(summarizeDocumentSize(data).cases['2/plain'].retainedGrowthBytes.count, 0);
});

test('linked open control keeps 5000 paragraphs and 500 distinct existing local targets', () => {
  const files = documentControlFiles(),
    body = files[0].text;
  assert.equal(files.length, 501);
  assert.equal((body.match(/Paragraph /g) ?? []).length, 5000);
  const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.equal(links.length, 500);
  assert.equal(new Set(links).size, 500);
  assert.ok(links.every((link) => files.some((file) => file.name === link)));
});

test('document-size campaign has 106 candidate pairs and 65 baseline/refusal pairs', () => {
  const options = parseOptions(args);
  assert.equal(
    documentMatrix(options).reduce((n, row) => n + row.plannedPairs, 0),
    106,
  );
  const baseline = parseOptions(args.map((value, index, all) => (all[index - 1] === '--label' ? 'baseline' : value)));
  assert.equal(
    documentMatrix(baseline).reduce((n, row) => n + row.plannedPairs, 0),
    65,
  );
});
test('existing soak receipts can still compare different durations', () => {
  const before = { status: 'complete', settings: { scenario: 'soak', soakMinutes: 10 } },
    after = { status: 'complete', settings: { scenario: 'soak', soakMinutes: 60 } };
  assert.equal(compareSummaries(before, after).pass, true);
});
