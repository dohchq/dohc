import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOCUMENT_SIZES, DOCUMENT_SHAPES, documentFixture, documentMatrix, MiB, restoreReservation } from './document-size-fixtures.mjs';
import { parseOptions } from './packaged-benchmark-options.mjs';
import { documentStats, summarizeDocumentSize } from './document-size-summary.mjs';
import { compareSummaries } from './compare-packaged-benchmark.mjs';
import { DocumentValidationPool } from './document-size-pool.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';

const args = ['--binary', 'absent.exe', '--package-commit', 'a'.repeat(40), '--output', 'unused-evidence', '--label', 'candidate', '--scenario', 'document-size'];
const stats = (value, count = 40) => ({ count, p50: value, p95: value, max: value });
export function passingDocumentSummary() {
  const settings = { scenario: 'document-size', documentMode: 'gate', documentMiB: [2, 5, 8, 10], runCount: 40,
    relaySessions: [1, 2, 4], updatesPerSecond: 8, churnEdits: 100000, soakMinutes: 60, keystrokes: 60 };
  const result = { status: 'complete', settings, diagnostic: false, freshEditableObservedMs: stats(500), restartEditableObservedMs: stats(500), documentSize: { missingPairs: 0, cases: {} } };
  for (const mib of DOCUMENT_SIZES) for (const shape of DOCUMENT_SHAPES) {
    const state = mib * MiB + 100000;
    const phase = () => ({ runs: 40, failures: 0, firstContentMs: stats(100), editReadyMs: stats(200),
      firstKeyMs: stats(16), typingMs: stats(16, 40 * 59), settleMs: stats(100), engineCores: stats(.25),
      exportVerified: 40, historyVerified: 40 });
    const relay = () => ({ runs: 40, failures: 0, recoveryVerified: 40, fixtureSha256: ['fixture-' + mib + shape],
      socketProbesVerified: 40, socketJoinMs: stats(100), socketApplyMs: stats(100), snapshotBytes: stats(state,1), nativeJoinMs: stats(100), nativeSettleMs: stats(100), nativeRestoreMs: stats(100), nativeRestartVerified: 40, actorAdmissions: { owner: 40, named: 40, link: 40 },
      cpuMs: stats(20, 2600), waitMs: stats(0, 2600), slotMs: stats(30, 2600), occupancy: stats(.4),
      oldGenerationPeakBytes: stats(100 * MiB), privatePeakSampledBytes: stats(200 * MiB),
      steadyBytesPerEdit: stats(100), stateBytes: stats(state), backlogGrowthMs: stats(0),
      initialTransferPerDocumentBytes: stats(state), largestStateBytes: state, reservation: restoreReservation(state),
      maximumNodes: 60000, maximumDepth: 3, checkpointCount: 1 });
    result.documentSize.cases[mib + '/' + shape] = { mib, shape, pairs: 40, repetitions: Array.from({ length: 40 }, (_, i) => i + 1),
      fixtureSha256: ['fixture-' + mib + shape], legacyOpenMs: stats(100), phases: { fresh: phase(), restart: phase() }, relay: Object.fromEntries(
        ['separate', 'shared'].flatMap(topology => [1, 2, 4].map(sessions => [topology + '/' + sessions, relay()]))),
      churn: [{ structural: false, requiredBytes: state, pass: true }, { structural: true, pass: false }],
      churnedRelay: ['separate','shared'].flatMap(topology => [1,2,4].map(sessions => ({topology, sessions, status: 'complete', churned: true,
        privatePeakSampledBytes: 200 * MiB, largestStateBytes: state, initialTransferPerDocumentBytes: state,
        socketProbes: Array.from({length:4}, () => ({verified:true})), native: {restartVerified: true, restore: {verified:true}, restorePayloadBytes: state},
        updates: Array.from({length:65}, () => ({cpuMs:20,waitMs:0,slotMs:30,nativeApplyMs:20,oldGenerationBytes:100*MiB,sampledUsedHeapPeakBytes:100*MiB}))}))),
      memory10Bytes: stats(300000000, 1), memory60Bytes: stats(350000000, 1), compactionMs: stats(100, 20),
      retainedTrendBytesPerMinute: stats(0,1), retainedGrowthBytes: stats(500000, 1), historyWriteBytesPerMinute: stats(10 * MiB, 1) };
  }
  return result;
}

test('document-size CLI defaults to the whole 40-pair matrix and rejects partial gates', () => {
  const options = parseOptions(args);
  assert.equal(options.runCount, 40); assert.equal(options.keystrokes, 60); assert.equal(options.soakMinutes, 60);
  assert.equal(documentMatrix(options).length, 16);
  for (const flags of [['--runs', '5'], ['--document-mib', '2,5,10'], ['--relay-sessions', '1,2'],
    ['--churn-edits', '99999'], ['--updates-per-second', '4'], ['--soak-minutes', '10']]) assert.throws(() => parseOptions([...args, ...flags]));
  assert.equal(parseOptions([...args, '--runs', '5', '--document-mode', 'pilot']).documentMode, 'pilot');
  for (const value of ['2,2', '2,3', 'NaN', '2,5,']) assert.throws(() => parseOptions([...args, '--document-mib', value]));
});

test('all fixtures have exact UTF-8 sizes, stable hashes, multilingual text and node headroom', () => {
  for (const mib of DOCUMENT_SIZES) for (const shape of DOCUMENT_SHAPES) {
    const value = documentFixture(mib, shape);
    assert.equal(Buffer.byteLength(value.text), mib * MiB);
    assert.equal(value.sha256, documentFixture(mib, shape).sha256);
    assert.match(value.text, /日本語/); assert.match(value.text, /مرحبا/);
    assert.ok(value.paragraphBytes >= 700);
    assert.ok(value.paragraphs * 7 < 131072, 'Conservative rich-node upper bound');
    assert.equal(value.retained, shape.endsWith('-retained'));
    assert.equal(value.text.includes('# retained source'), value.retained);
  }
  assert.ok(documentFixture(10, 'formatted', { structural: true }).paragraphBytes < 150);
});

test('restore reservation follows native header and String-vector bounds, with memory taking precedence', () => {
  const at20 = restoreReservation(20 * MiB);
  assert.equal(at20.relayBytes, 328 * MiB);
  assert.equal(at20.fitsCurrentRelay, false);
  assert.equal(at20.fitsNative, false);
  assert.ok(restoreReservation(10 * MiB).fitsNative);
});

test('40-run p95 is the third-slowest, while five-run p95 is the slowest', () => {
  assert.equal(documentStats([1, 2, 3, 4, 50]).p95, 50);
  assert.equal(documentStats(Array.from({ length: 40 }, (_, i) => i + 1)).p95, 38);
  assert.equal(documentStats([NaN, null]).count, 0);
});

test('document-size decision measures 8 MiB and selects one contiguous passing size', () => {
  const baseline = passingDocumentSummary(), candidate = passingDocumentSummary();
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 10);
  candidate.documentSize.cases['10/formatted'].phases.fresh.editReadyMs = stats(3000);
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 8);
  candidate.documentSize.cases['8/formatted'].memory60Bytes = stats(500000000, 1);
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 5);
  candidate.documentSize.cases['2/plain'].relay['separate/4'].failures = 1;
  assert.equal(compareSummaries(baseline, candidate).pass, false);
});

test('every required measurement fails closed when missing, including new-size metrics', () => {
  const baseline = passingDocumentSummary();
  for (const mutate of [
    value => { delete value.documentSize.cases['2/plain'].phases.restart; },
    value => { value.documentSize.cases['2/plain'].phases.fresh.firstContentMs.count = 0; },
    value => { delete value.documentSize.cases['2/plain'].relay['separate/4'].cpuMs; },
    value => { delete value.documentSize.cases['2/plain'].relay['separate/2'].privatePeakSampledBytes; },
    value => { value.documentSize.cases['2/plain'].churn = []; },
    value => { delete value.documentSize.cases['2/plain'].memory60Bytes; },
    value => { value.documentSize.cases['2/plain'].historyWriteBytesPerMinute.count = 0; },
    value => { value.documentSize.cases['2/plain'].compactionMs.count = 0; },
    value => { delete value.documentSize.cases['2/plain'].relay['separate/2'].nativeJoinMs; },
    value => { value.documentSize.cases['2/plain'].churnedRelay = []; },
    value => { delete value.documentSize.cases['2/plain'].relay['separate/1'].snapshotBytes; },
    value => { value.documentSize.cases['2/plain'].relay['separate/1'].checkpointCount = 0; },
    value => { value.documentSize.cases['2/plain'].relay['separate/2'].socketProbesVerified = 0; },
    value => { value.documentSize.cases['2/plain'].relay['separate/2'].cpuMs = stats(-1); },
    value => { value.documentSize.cases['2/plain'].retainedTrendBytesPerMinute = stats(1,1); },
  ]) {
    const candidate = passingDocumentSummary(); mutate(candidate);
    assert.equal(compareSummaries(baseline, candidate).pass, false);
  }
  const candidate = passingDocumentSummary();
  delete candidate.documentSize.cases['10/plain'].phases.fresh.editReadyMs;
  assert.equal(compareSummaries(baseline, candidate).selectedMiB, 8);
});

test('pilot, duplicate pairs, unmatched fixtures and unmatched settings never gate', () => {
  const baseline = passingDocumentSummary();
  for (const mutate of [
    value => { value.settings.documentMode = 'pilot'; },
    value => { value.settings.runCount = 5; },
    value => { value.settings.relaySessions = [1, 2]; },
    value => { value.documentSize.cases['2/plain'].repetitions[39] = 1; },
    value => { value.documentSize.cases['2/plain'].fixtureSha256 = ['different']; },
    value => { value.documentSize.cases['2/plain'].relay['separate/4'].runs = 5; },
  ]) {
    const candidate = passingDocumentSummary(); mutate(candidate);
    assert.equal(compareSummaries(baseline, candidate).pass, false);
  }
});

test('summary retains refusals and does not invent typing, relay, memory or export data', async () => {
  const data = { status: 'complete', settings: { ...passingDocumentSummary().settings, documentMiB: [2] }, runs: [
    { documentSize: { mib: 2, shape: 'plain', repetition: 1, phases: [
      { phase: 'fresh', fixtureSha256: 'a', status: 'refused', refusal: 'too large', samples: [], firstContentMs: 50 },
    ] } },
  ] };
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
    const result = spawnSync(process.execPath, ['tools/perf-profiling/packaged-benchmark.mjs',
      ...args, '--document-mib', '2', '--document-mode', 'dry-run',
    ].map((value, index, all) => all[index - 1] === '--output' ? output : value), { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(await readFile(join(output, 'document-size-plan.json'), 'utf8'));
    assert.equal(plan.diagnostic, true); assert.equal(plan.matrix.length, 4);
  } finally {
    const owned = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(!isAbsolute(owned) && !owned.startsWith('..') && owned.startsWith('dohc-document-size-dry-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared-document latency is reported, while separate-document latency gates', () => {
  const baseline = passingDocumentSummary(), candidate = passingDocumentSummary();
  candidate.documentSize.cases['2/plain'].relay['shared/4'].cpuMs = stats(1000,2600);
  const result = compareSummaries(baseline,candidate);
  assert.equal(result.pass,true);
  assert.ok(result.checks.some(row => row.metric === 'shared 4 cpuMs p95' && row.verdict === 'reported'));
  candidate.documentSize.cases['2/plain'].relay['separate/4'].cpuMs = stats(1000,2600);
  assert.equal(compareSummaries(baseline,candidate).pass,false);
});

test('real worker pool preserves capacity, measures the shipping handler and closes all workers', async () => {
  const pool = new DocumentValidationPool(resolve('.'), AbortSignal.timeout(60000));
  try {
    const policy = {maxStructVisits:1000,maxValueNodeVisits:1000,maxDecodedPayloadByteVisits:1000,maxStructClientGroupVisits:1000,maxDeleteClientGroupVisits:1000,maxDeleteIntervalVisits:1000,maxIndexOperations:1000};
    const results = await Promise.all(Array.from({length:4}, () => pool.submit({kind:'settlement',policy,input:{}})));
    assert.ok(results.every(row => row.result.kind === 'refused'));
    assert.ok(results.every(row => row.metrics.heapSamples >= 1 && row.metrics.sampledUsedHeapPeakBytes > 0));
    assert.equal(pool.usage().peakBusy,2);
  } finally { await pool.close(); }
  await assert.rejects(pool.submit({}), /closed/);
});

test('closing the real worker pool settles active and waiting submissions', async () => {
  const pool = new DocumentValidationPool(resolve('.'), AbortSignal.timeout(60000));
  const pending = Array.from({length:4}, () => pool.submit({kind:'settlement',policy:{},input:{}}));
  const outcomes = Promise.allSettled(pending);
  await pool.close();
  assert.ok((await outcomes).every(row => row.status === 'rejected'));
});
