import { DOCUMENT_SHAPES, DOCUMENT_SIZES, MiB, MIN_GATE_RUNS, OPEN_BUDGETS, STATE_MAX_BYTES, restoreReservation } from './document-size-fixtures.mjs';

export function documentStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? null,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, max: sorted.at(-1) ?? null };
}
const unique = values => [...new Set(values)];
const max = values => values.length && values.every(Number.isFinite) ? Math.max(...values) : null;
const cpuDelta = (row, kind) => {
  if (!row.before?.processes || !row.after?.processes) return null;
  const was = new Map(row.before.processes.map(p => [p.pid + ':' + p.createdAt, p]));
  const matches = row.after.processes.filter(p => kind === 'engine' && /dohc-workspace-engine/i.test(p.path ?? p.name ?? ''));
  if (!matches.length || matches.some(p => !was.has(p.pid + ':' + p.createdAt))) return null;
  return matches.reduce((n, p) => n + p.cpuMs - was.get(p.pid + ':' + p.createdAt).cpuMs, 0);
};
const engineWrites = row => {
  if (!row.before?.processes || !row.after?.processes) return null;
  const was = new Map(row.before.processes.map(p => [p.pid + ':' + p.createdAt, p]));
  const matches = row.after.processes.filter(p => /dohc-workspace-engine/i.test(p.path ?? p.name ?? ''));
  if (!matches.length || matches.some(p => !was.has(p.pid + ':' + p.createdAt))) return null;
  return matches.reduce((n, p) => n + p.writeBytes - was.get(p.pid + ':' + p.createdAt).writeBytes, 0);
};
export function summarizeDocumentSize(data) {
  if (data.settings?.scenario !== 'document-size') return null;
  const rows = data.runs.flatMap(run => run.documentSize ? [run.documentSize] : []);
  const result = { cases: {}, mode: data.settings.documentMode, metricsVersion: 1,
    missingPairs: data.runs.filter(run => !run.documentSize).length };
  for (const mib of data.settings.documentMiB ?? []) for (const shape of DOCUMENT_SHAPES) {
    const matching = rows.filter(row => row.mib === mib && row.shape === shape);
    const fixtureSha256 = unique(matching.flatMap(row => row.phases.map(phase => phase.fixtureSha256)));
    const item = { mib, shape, pairs: matching.length, repetitions: matching.map(row => row.repetition), fixtureSha256,
      legacyOpenMs: documentStats(matching.map(row => row.legacyOpen?.openObservedMs)), phases: {}, relay: {}, churn: matching.flatMap(row => row.relay?.churn ?? []), soaks: matching.flatMap(row => row.soak ? [row.soak] : []) };
    for (const phase of ['fresh', 'restart']) {
      const arms = matching.flatMap(row => row.phases.filter(value => value.phase === phase));
      item.phases[phase] = { runs: arms.length, failures: arms.filter(row => row.status !== 'complete').length,
        refusals: arms.filter(row => row.status === 'refused').map(row => row.refusal),
        firstContentMs: documentStats(arms.map(row => row.firstContentMs)), editReadyMs: documentStats(arms.map(row => row.editReadyMs)),
        firstKeyMs: documentStats(arms.map(row => row.samples[0]?.keyToFrameMs)),
        typingMs: documentStats(arms.flatMap(row => row.samples.slice(1).map(sample => sample.keyToFrameMs))),
        dispatchToTwoRafMs: documentStats(arms.flatMap(row => row.samples.map(sample => sample.dispatchToTwoRafMs))),
        settleMs: documentStats(arms.map(row => row.settleMs)),
        engineCores: documentStats(arms.map(row => { const delta = cpuDelta(row, 'engine'); return delta === null ? null : delta / row.elapsedMs; })),
        exportVerified: arms.filter(row => row.export?.complete && row.export.sha256 === row.durableSha256).length,
        historyVerified: arms.filter(row => row.historyRead?.afterSha256 === row.durableSha256 && row.historyCompare?.changed && row.historyRestore?.verified).length };
    }
    for (const topology of ['separate', 'shared']) for (const sessions of [1, 2, 4]) {
      const arms = matching.flatMap(row => row.relay?.cases ?? []).filter(row => row.topology === topology && row.sessions === sessions);
      const updates = arms.flatMap(row => row.updates);
      const requiredState = max([...arms.map(row => row.largestStateBytes), ...item.churn.filter(row => !row.structural).map(row => row.requiredBytes)]);
      const restorePayloadBytes = max(arms.map(row => row.native?.restorePayloadBytes));
      const reservation = Number.isFinite(requiredState) ? restoreReservation(restorePayloadBytes ?? requiredState) : null;
      item.relay[topology + '/' + sessions] = { runs: arms.length, failures: arms.filter(row => row.status !== 'complete').length,
        fixtureSha256: unique(arms.map(row => row.fixtureSha256)),
        cpuMs: documentStats(updates.map(row => row.cpuMs)), waitMs: documentStats(updates.map(row => row.waitMs)),
        slotMs: documentStats(updates.map(row => row.slotMs)), occupancy: documentStats(arms.map(row => row.pool?.occupancy)),
        oldGenerationPeakBytes: documentStats(arms.map(row => max(row.updates.map(update => max([update.oldGenerationBytes, update.sampledUsedHeapPeakBytes]))))),
        privatePeakSampledBytes: documentStats(arms.map(row => row.privatePeakSampledBytes)),
        updateBytes: documentStats(updates.map(row => row.updateBytes)), stateBytes: documentStats(updates.map(row => row.stateBytes)),
        snapshotBytes: documentStats(arms.flatMap(row => row.checkpoints.map(checkpoint => checkpoint.stateBytes))),
        largestStateBytes: requiredState, reservation,
        steadyBytesPerEdit: documentStats(arms.map(row => row.steadyBytesPerEdit)),
        initialTransferPerDocumentBytes: documentStats(arms.map(row => row.initialTransferPerDocumentBytes)),
        maximumNodes: max(arms.map(row => row.nodes)), maximumDepth: max(arms.map(row => row.depth)),
        nativeJoinMs: documentStats(arms.flatMap(row => row.native?.joins?.map(value => value.ms) ?? [])),
        nativeSettleMs: documentStats(arms.flatMap(row => row.native?.settlements?.map(value => value.ms) ?? [])),
        nativeRestoreMs: documentStats(arms.map(row => row.native?.restore?.verified ? row.native.restore.ms : null)),
        socketProbesVerified: arms.filter(row => ['fresh','restart'].every(phase => ['named','link'].every(kind => row.socketProbes?.some(probe => probe.kind === kind && probe.phase === phase && probe.verified)))).length,
        socketJoinMs: documentStats(arms.flatMap(row => row.socketProbes?.map(probe => probe.joinMs) ?? [])),
        socketApplyMs: documentStats(arms.flatMap(row => row.socketProbes?.map(probe => probe.applyMs) ?? [])),
        nativeRestartVerified: arms.filter(row => row.native?.restartVerified).length,
        actorAdmissions: { owner: arms.reduce((n,row) => n + (row.doorAdmissions?.owner ?? 0),0), named: arms.reduce((n,row) => n + (row.doorAdmissions?.named ?? 0),0), link: arms.reduce((n,row) => n + (row.doorAdmissions?.link ?? 0),0) },
        recoveryVerified: arms.filter(row => row.journalRecoveryVerified).length,
        checkpointCount: arms.reduce((n, row) => n + row.checkpoints.length, 0),
        backlogGrowthMs: documentStats(arms.map(row => row.updates.length ? Math.max(0, row.updates.at(-1).scheduledLagMs - row.updates[0].scheduledLagMs) : null)) };
    }
    item.churnedRelay = matching.flatMap(row => row.relay?.churnedCases ?? []);
    const soaks = item.soaks;
    item.memory10Bytes = documentStats(soaks.map(row => row.memory?.find(sample => sample.elapsedMs >= 10 * 60000)?.kinds?.renderer?.privateBytes));
    item.memory60Bytes = documentStats(soaks.map(row => row.memory?.find(sample => sample.elapsedMs >= 60 * 60000)?.kinds?.renderer?.privateBytes));
    item.soakMinutes = documentStats(soaks.map(row => row.elapsedMs / 60000));
    item.compactionMs = documentStats(soaks.flatMap(row => row.compactions?.map(value => value.observedUpperBoundMs) ?? []));
    item.retainedTrendBytesPerMinute = documentStats(soaks.map(row => {
      const buckets = new Map();
      for (const sample of row.compactions ?? []) { const minute = Math.floor(sample.elapsedMs / 60000); buckets.set(minute, Math.min(buckets.get(minute) ?? Infinity, sample.logicalBytes)); }
      const points = [...buckets].filter(([minute]) => minute >= 1);
      if (points.length < 2) return null;
      const xm = points.reduce((n,[x]) => n+x,0)/points.length, ym = points.reduce((n,[,y]) => n+y,0)/points.length;
      return points.reduce((n,[x,y]) => n+(x-xm)*(y-ym),0)/points.reduce((n,[x]) => n+(x-xm)**2,0);
    }));
    item.retainedGrowthBytes = documentStats(soaks.map(row => {
      if (row.compactions?.length < 2) return null;
      const first = row.compactions[0].logicalBytes;
      return Math.max(...row.compactions.map(sample => sample.logicalBytes - first));
    }));
    item.historyWriteBytesPerMinute = documentStats(soaks.map(row => {
      const bytes = engineWrites(row); return bytes === null ? null : bytes / (row.elapsedMs / 60000);
    }));
    result.cases[mib + '/' + shape] = item;
  }
  return result;
}

export function compareDocumentSize(baseline, candidate, margin) {
  const cases = candidate.documentSize?.cases ?? {}, before = baseline.documentSize?.cases ?? {};
  const sizes = [], problems = [], checks = [];
  if (candidate.settings?.documentMode !== 'gate' || candidate.documentSize?.missingPairs) problems.push('Document-size gate needs a complete gate-mode receipt');
  if (JSON.stringify(candidate.settings?.documentMiB) !== JSON.stringify(DOCUMENT_SIZES)) problems.push('Document-size gate requires 2,5,8,10 MiB');
  for (const [field, minimum] of [['runCount',40],['keystrokes',60],['churnEdits',100000],['soakMinutes',60]]) {
    if (!Number.isSafeInteger(candidate.settings?.[field]) || candidate.settings[field] < minimum) problems.push('Document-size gate has insufficient ' + field);
  }
  if (candidate.settings?.updatesPerSecond !== 8 || JSON.stringify(candidate.settings?.relaySessions) !== '[1,2,4]') problems.push('Document-size gate requires 1/2/4 sessions at 8 updates/s');
  if (candidate.settings?.runCount < MIN_GATE_RUNS) problems.push('Document-size gate needs 40 fresh/restart pairs');
  const add = (key, metric, value, limit, present = Number.isFinite(value)) => {
    const row = { key, metric, value: present ? value : null, limit, verdict: !present || !Number.isFinite(value) || !(limit >= 0) ? 'missing' : (!/trend/.test(metric) && value < 0) || value > limit ? 'failed' : 'pass' };
    checks.push(row); return row.verdict === 'pass';
  };
  const statistic = (key, label, stats, percentile, limit, min = MIN_GATE_RUNS) =>
    add(key, label + ' ' + percentile, stats?.[percentile], limit, stats?.count >= min && Number.isFinite(stats[percentile]));
  for (const phase of ['fresh','restart']) {
    const metric = phase + 'EditableObservedMs';
    statistic('startup', phase + ' launch', candidate[metric], 'p50', baseline[metric]?.p50);
  }
  for (const mib of DOCUMENT_SIZES) {
    const start = checks.length;
    for (const shape of DOCUMENT_SHAPES) {
      const key = mib + '/' + shape, item = cases[key], control = before['2/' + shape];
      if (!item) { add(key, 'case', null, 0, false); continue; }
      add(key, 'independent pairs', item.pairs, Infinity, item.pairs >= MIN_GATE_RUNS && unique(item.repetitions).length === item.pairs);
      add(key, 'single fixture', item.fixtureSha256.length, 1, item.fixtureSha256.length === 1);
      if (before[key] && JSON.stringify(before[key].fixtureSha256) !== JSON.stringify(item.fixtureSha256)) add(key, 'matching baseline fixture', null, 0, false);
      statistic(key, '5000-paragraph open', item.legacyOpenMs, 'p50', 487);
      statistic(key, '5000-paragraph open', item.legacyOpenMs, 'p95', 532);
      for (const phase of ['fresh', 'restart']) {
        const arm = item.phases[phase], base = control?.phases[phase];
        add(key, phase + ' failures', arm?.failures, 0);
        add(key, phase + ' complete export', arm?.exportVerified, Infinity, arm?.exportVerified === item.pairs);
        add(key, phase + ' history read/compare/restore', arm?.historyVerified, Infinity, arm?.historyVerified === item.pairs);
        for (const [metric, budget] of [['firstContentMs', OPEN_BUDGETS[mib].firstContent], ['editReadyMs', OPEN_BUDGETS[mib].editReady]]) {
          statistic(key, phase + ' ' + metric, arm?.[metric], 'p50', budget[0]);
          statistic(key, phase + ' ' + metric, arm?.[metric], 'p95', budget[1]);
        }
        for (const metric of ['firstKeyMs', 'typingMs']) for (const percentile of ['p50', 'p95']) {
          const measured = base?.[metric]?.[percentile];
          const limit = mib === 2 && Number.isFinite(measured) ? measured + Math.max(measured * margin.percent / 100, margin.floorMs) : measured;
          statistic(key, phase + ' ' + metric, arm?.[metric], percentile, limit,
            metric === 'typingMs' ? MIN_GATE_RUNS * 59 : MIN_GATE_RUNS);
          if (!Number.isFinite(limit) || base?.[metric]?.count < MIN_GATE_RUNS) add(key, 'matching Pass A typing control', null, 0, false);
        }
        statistic(key, phase + ' settle', arm?.settleMs, 'p95', 1000);
        statistic(key, phase + ' engine cores', arm?.engineCores, 'p95', 1);
      }
      statistic(key, 'renderer private bytes at 10 minutes', item.memory10Bytes, 'max', 435_000_000, 1);
      statistic(key, 'renderer private bytes at 60 minutes', item.memory60Bytes, 'max', 477_000_000, 1);
      statistic(key, 'compaction observed upper bound', item.compactionMs, 'p95', 1000, 2);
      statistic(key, 'retained growth trend bytes/minute', item.retainedTrendBytesPerMinute, 'max', 0, 1);
      statistic(key, 'net retained growth after compaction', item.retainedGrowthBytes, 'max', 2 * MiB, 1);
      const churn = item.churn.filter(row => !row.structural);
      add(key, '100000-edit churn and 5 MiB headroom', churn[0]?.pass ? 0 : 1, 0, churn.length === 1);
      // Structural probes are reported separately; they never pass a byte-size arm by omission.
      add(key, 'structural churn probe recorded', 0, 0, item.churn.some(row => row.structural));
      const state = churn[0]?.requiredBytes;
      const writeLimit = Number.isFinite(state) ? (Math.ceil(480 / 64) + 1) * state + 2 * mib * MiB + 2 * MiB : null;
      statistic(key, 'history write volume per minute', item.historyWriteBytesPerMinute, 'max', writeLimit, 1);
      for (const topology of ['separate', 'shared']) for (const sessions of [1, 2, 4]) {
        const relay = item.relay[topology + '/' + sessions], label = topology + ' ' + sessions;
        const recordedAt = checks.length;
        add(key, label + ' relay runs', relay?.runs, Infinity, relay?.runs >= MIN_GATE_RUNS);
        add(key, label + ' relay failures', relay?.failures, 0);
        add(key, label + ' named/link socket proof', relay?.socketProbesVerified, Infinity, relay?.socketProbesVerified === item.pairs);
        statistic(key, label + ' socket join', relay?.socketJoinMs, 'p95', 2000);
        statistic(key, label + ' socket edit ACK', relay?.socketApplyMs, 'p95', 1000);
        statistic(key, label + ' native join', relay?.nativeJoinMs, 'p95', 2000);
        statistic(key, label + ' native settle', relay?.nativeSettleMs, 'p95', 1000);
        statistic(key, label + ' native restore', relay?.nativeRestoreMs, 'p95', 2000);
        add(key, label + ' native restart', relay?.nativeRestartVerified, Infinity, relay?.nativeRestartVerified === item.pairs);
        for (const actor of ['owner','named','link']) add(key, label + ' ' + actor + ' admission', relay?.actorAdmissions?.[actor], Infinity, relay?.actorAdmissions?.[actor] >= MIN_GATE_RUNS);
        add(key, label + ' recovered journal', relay?.recoveryVerified, Infinity, relay?.recoveryVerified === item.pairs);
        for (const [metric, percentile, limit] of [
          ['cpuMs', 'p50', 50], ['cpuMs', 'p95', 100], ['waitMs', 'p95', 100], ['slotMs', 'p95', 100],
          ['occupancy', 'max', .8], ['oldGenerationPeakBytes', 'max', 384 * MiB], ['privatePeakSampledBytes', 'max', 1024 * MiB],
          ['steadyBytesPerEdit', 'max', 2048], ['stateBytes', 'max', STATE_MAX_BYTES], ['backlogGrowthMs', 'p95', 100],
        ]) statistic(key, label + ' ' + metric, relay?.[metric], percentile, limit);
        if (topology === 'separate' && sessions === 1) {
          add(key, label + ' checkpoint probe', relay?.checkpointCount, Infinity, relay?.checkpointCount >= 1);
          statistic(key, label + ' checkpoint state', relay?.snapshotBytes, 'max', STATE_MAX_BYTES, 1);
        }
        add(key, label + ' validation nodes', relay?.maximumNodes, 131072);
        add(key, label + ' validation depth', relay?.maximumDepth, 128);
        const churned = item.churnedRelay?.find(row => row.topology === topology && row.sessions === sessions);
        add(key, label + ' churned-state replay', churned?.status === 'complete' ? 0 : 1, 0, churned?.churned && churned?.native?.restartVerified && churned?.native?.restore?.verified);
        for (const [metric, limit] of [['cpuMs',100],['waitMs',100],['slotMs',100],['nativeApplyMs',1000]]) statistic(key, label + ' churned ' + metric, documentStats(churned?.updates?.map(row => row[metric]) ?? []), 'p95', limit);
        add(key, label + ' churned socket proof', churned?.socketProbes?.filter(row => row.verified).length, Infinity, churned?.socketProbes?.filter(row => row.verified).length === 4);
        add(key, label + ' churned state bound', churned?.largestStateBytes, STATE_MAX_BYTES);
        add(key, label + ' churned worker heap', max(churned?.updates?.map(row => max([row.oldGenerationBytes, row.sampledUsedHeapPeakBytes])) ?? []), 384 * MiB);
        add(key, label + ' churned private memory', churned?.privatePeakSampledBytes, 1024 * MiB);
        const churnedReservation = Number.isFinite(churned?.native?.restorePayloadBytes) ? restoreReservation(churned.native.restorePayloadBytes) : null;
        add(key, label + ' churned native reservation', churnedReservation?.nativeBytes, 512 * MiB);
        add(key, label + ' churned relay reservation plus memory', churnedReservation?.relayBytes + churned?.privatePeakSampledBytes, 1024 * MiB);
        add(key, label + ' native restore reservation', relay?.reservation?.nativeBytes, 512 * MiB);
        add(key, label + ' relay restore reservation plus private bytes', relay?.reservation?.relayBytes + relay?.privatePeakSampledBytes?.max, 1024 * MiB);
        statistic(key, label + ' initial transfer', relay?.initialTransferPerDocumentBytes, 'max', 3 * relay?.largestStateBytes + 65536);
        add(key, label + ' churned initial transfer', churned?.initialTransferPerDocumentBytes, 3 * churned?.largestStateBytes + 65536);
        // Shared-document latency is diagnostic. Refusals, missing proofs and crashes still fail.
        if (topology === 'shared') for (const row of checks.slice(recordedAt)) {
          if (row.verdict === 'failed' && /cpuMs|waitMs|slotMs|occupancy|backlogGrowthMs|socket join|socket edit ACK|native join|native settle|native restore$|churned nativeApplyMs/.test(row.metric)) row.verdict = 'reported';
        }
      }
    }
    sizes.push({ mib, pass: checks.slice(start).every(row => row.verdict === 'pass' || row.verdict === 'reported') });
  }
  let selectedMiB = null;
  for (const size of sizes) { if (!size.pass) break; selectedMiB = size.mib; }
  if (problems.length || checks.some(row => row.key === 'startup' && row.verdict !== 'pass')) selectedMiB = null;
  return { pass: selectedMiB !== null, selectedMiB, sizes, problems, checks,
    decision: 'Largest passing tested size with every smaller size passing. 8 MiB is always measured. Structural probes remain a separate boundary.' };
}
