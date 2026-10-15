import {
  DOCUMENT_SHAPES,
  DOCUMENT_SIZES,
  MiB,
  OPEN_BUDGETS,
  STATE_MAX_BYTES,
  restoreReservation,
  pairsForCase,
} from './document-size-fixtures.mjs';

export function documentStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? null,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
const unique = (values) => [...new Set(values)];
const max = (values) => (values.length && values.every(Number.isFinite) ? Math.max(...values) : null);
const cpuDelta = (row, kind) => {
  if (!row.before?.processes || !row.after?.processes) return null;
  const was = new Map(row.before.processes.map((p) => [p.pid + ':' + p.createdAt, p]));
  const matches = row.after.processes.filter(
    (p) => kind === 'engine' && /dohc-workspace-engine/i.test(p.path ?? p.name ?? ''),
  );
  if (!matches.length || matches.some((p) => !was.has(p.pid + ':' + p.createdAt))) return null;
  return matches.reduce((n, p) => n + p.cpuMs - was.get(p.pid + ':' + p.createdAt).cpuMs, 0);
};
const engineWrites = (row) => {
  if (!row.before?.processes || !row.after?.processes) return null;
  const was = new Map(row.before.processes.map((p) => [p.pid + ':' + p.createdAt, p]));
  const matches = row.after.processes.filter((p) => /dohc-workspace-engine/i.test(p.path ?? p.name ?? ''));
  if (!matches.length || matches.some((p) => !was.has(p.pid + ':' + p.createdAt))) return null;
  return matches.reduce((n, p) => n + p.writeBytes - was.get(p.pid + ':' + p.createdAt).writeBytes, 0);
};
export function summarizeDocumentSize(data) {
  if (data.settings?.scenario !== 'document-size') return null;
  const rows = data.runs.flatMap((run) => (run.documentSize ? [run.documentSize] : []));
  const result = {
    cases: {},
    mode: data.settings.documentMode,
    metricsVersion: 2,
    controls: Object.fromEntries(
      Object.entries(data.documentControls ?? {}).map(([key, values]) => [key, documentStats(values)]),
    ),
    soakAttempts: data.documentSoaks ?? [],
    missingPairs: data.runs.filter((run) => !run.documentSize).length,
  };
  for (const mib of data.settings.documentMiB ?? [])
    for (const shape of DOCUMENT_SHAPES) {
      const matching = rows.filter((row) => row.mib === mib && row.shape === shape);
      const fixtureSha256 = unique(matching.flatMap((row) => row.phases.map((phase) => phase.fixtureSha256)));
      const relayInput = data.documentRelays?.[mib + '/' + shape];
      const item = {
        mib,
        shape,
        requiredPairs: pairsForCase({ ...data.settings, label: data.label }, { mib, shape }),
        pairs: matching.length,
        repetitions: matching.map((row) => row.repetition),
        fixtureSha256,
        phases: {},
        relay: {},
        churn: relayInput?.churn ?? [],
        soaks: (data.documentSoaks ?? []).filter((row) => row.mib === mib && row.shape === shape),
      };
      for (const phase of ['fresh', 'restart']) {
        const arms = matching.flatMap((row) => row.phases.filter((value) => value.phase === phase));
        item.phases[phase] = {
          runs: arms.length,
          failures: arms.filter((row) => row.status !== 'complete').length,
          refusals: arms.filter((row) => row.status === 'refused').map((row) => row.refusal),
          firstContentMs: documentStats(arms.map((row) => row.firstContentMs)),
          editReadyMs: documentStats(arms.map((row) => row.editReadyMs)),
          firstKeyMs: documentStats(arms.map((row) => row.samples[0]?.keyToFrameMs)),
          typingMs: documentStats(arms.flatMap((row) => row.samples.slice(1).map((sample) => sample.keyToFrameMs))),
          dispatchToTwoRafMs: documentStats(
            arms.flatMap((row) => row.samples.map((sample) => sample.dispatchToTwoRafMs)),
          ),
          rate: documentStats(arms.map((row) => row.editsPerMinute)),
          editActivationMs: documentStats(arms.map((row) => row.editActivationMs)),
          settleMs: documentStats(arms.map((row) => row.settleMs)),
          engineCores: documentStats(
            arms.map((row) => {
              const delta = cpuDelta(row, 'engine');
              return delta === null ? null : ((delta / row.editingElapsedMs) * 480) / row.editsPerMinute;
            }),
          ),
          exportVerified: arms.filter((row) => row.export?.complete && row.export.sha256 === row.durableSha256).length,
          historyVerified: arms.filter(
            (row) =>
              row.historyRead?.afterSha256 === row.durableSha256 &&
              row.historyCompare?.changed &&
              row.historyRestore?.verified,
          ).length,
        };
      }
      item.peerPhases = Object.fromEntries(
        ['peer', 'churn'].map((mode) => {
          const arms = matching.flatMap((row) => row.phases.filter((phase) => phase.peerMode === mode));
          return [
            mode,
            {
              runs: arms.length,
              verified: arms.filter((row) => row.peer?.verified && (mode !== 'churn' || row.peer.churnEdits >= 100000))
                .length,
              firstContentMs: documentStats(arms.map((row) => row.firstContentMs)),
              editReadyMs: documentStats(arms.map((row) => row.editReadyMs)),
              firstKeyMs: documentStats(arms.map((row) => row.samples[0]?.keyToFrameMs)),
              typingMs: documentStats(arms.flatMap((row) => row.samples.slice(1).map((sample) => sample.keyToFrameMs))),
              rate: documentStats(arms.map((row) => row.editsPerMinute)),
            },
          ];
        }),
      );
      for (const topology of ['separate', 'shared'])
        for (const sessions of [1, 2, 4]) {
          const arms = (relayInput?.cases ?? []).filter(
            (row) => row.topology === topology && row.sessions === sessions,
          );
          const updates = arms.flatMap((row) => row.updates);
          const requiredState = max([
            ...arms.map((row) => row.largestStateBytes),
            ...item.churn.filter((row) => !row.structural).map((row) => row.requiredBytes),
          ]);
          const restorePayloadBytes = max(
            [...arms, ...(relayInput?.churnedCases ?? [])]
              .map((row) => row.native?.restorePayloadBytes)
              .filter(Number.isFinite),
          );
          const reservation = Number.isFinite(requiredState)
            ? arms[0]?.reservationBounds
              ? restoreReservation(Math.max(restorePayloadBytes ?? 0, requiredState), arms[0].reservationBounds)
              : null
            : null;
          item.relay[topology + '/' + sessions] = {
            runs: arms.length,
            failures: arms.filter((row) => row.status !== 'complete').length,
            fixtureSha256: unique(arms.map((row) => row.fixtureSha256)),
            rate: documentStats(arms.map((row) => row.achievedUpdatesPerSecondPerSession)),
            longSuffixUpdates: updates.filter((row) => row.suffixCount >= 3800).length,
            databaseBytes: documentStats(arms.map((row) => row.databaseBytes)),
            databaseAndWalBytes: documentStats(
              arms.map((row) => row.databaseFilesBytes?.reduce((n, value) => n + value, 0)),
            ),
            restoreVerified: arms.filter((row) => row.native?.restore?.verified).length,
            cpuMs: documentStats(updates.map((row) => row.cpuMs)),
            waitMs: documentStats(updates.map((row) => row.waitMs)),
            slotMs: documentStats(updates.map((row) => row.slotMs)),
            occupancy: documentStats(arms.map((row) => row.pool?.occupancy)),
            oldGenerationPeakBytes: documentStats(
              arms.map((row) =>
                max(row.updates.map((update) => max([update.oldGenerationBytes, update.sampledUsedHeapPeakBytes]))),
              ),
            ),
            privatePeakSampledBytes: documentStats(arms.map((row) => row.privatePeakSampledBytes)),
            updateBytes: documentStats(updates.map((row) => row.updateBytes)),
            stateBytes: documentStats(updates.map((row) => row.stateBytes)),
            snapshotBytes: documentStats(
              arms.flatMap((row) =>
                [...row.checkpoints, ...(row.checkpointProof ?? [])].map((checkpoint) => checkpoint.stateBytes),
              ),
            ),
            largestStateBytes: requiredState,
            reservation,
            steadyBytesPerEdit: documentStats(arms.map((row) => row.steadyBytesPerEdit)),
            initialTransferPerDocumentBytes: documentStats(arms.map((row) => row.initialTransferPerDocumentBytes)),
            maximumNodes: max(arms.map((row) => row.nodes)),
            maximumDepth: max(arms.map((row) => row.depth)),
            nativeDrainMs: documentStats(arms.map(row=>row.nativeDrainMs)),
        nativeJoinMs: documentStats(arms.flatMap((row) => row.native?.joins?.map((value) => value.ms) ?? [])),
            nativeSettleMs: documentStats(
              arms.flatMap((row) => row.native?.settlements?.map((value) => value.ms) ?? []),
            ),
            nativeRestoreMs: documentStats(
              arms.map((row) => (row.native?.restore?.verified ? row.native.restore.ms : null)),
            ),
            socketProbesVerified: arms.filter((row) =>
              ['fresh', 'restart'].every((phase) =>
                ['named', 'link'].every((kind) =>
                  row.socketProbes?.some((probe) => probe.kind === kind && probe.phase === phase && probe.verified),
                ),
              ),
            ).length,
            socketJoinMs: documentStats(arms.flatMap((row) => row.socketProbes?.map((probe) => probe.joinMs) ?? [])),
            socketApplyMs: documentStats(arms.flatMap((row) => row.socketProbes?.map((probe) => probe.applyMs) ?? [])),
            nativeRestartVerified: arms.filter((row) => row.native?.restartVerified).length,
            actorAdmissions: {
              owner: arms.reduce((n, row) => n + (row.doorAdmissions?.owner ?? 0), 0),
              named: arms.reduce((n, row) => n + (row.doorAdmissions?.named ?? 0), 0),
              link: arms.reduce((n, row) => n + (row.doorAdmissions?.link ?? 0), 0),
            },
            recoveryVerified: arms.filter((row) => row.journalRecoveryVerified).length,
            checkpointCount: arms.reduce(
              (n, row) => n + row.checkpoints.length + (row.checkpointProof?.length ?? 0),
              0,
            ),
            backlogGrowthMs: documentStats(
              arms.map((row) =>
                row.updates.length
                  ? Math.max(0, row.updates.at(-1).scheduledLagMs - row.updates[0].scheduledLagMs)
                  : null,
              ),
            ),
          };
        }
      item.churnedRelay = relayInput?.churnedCases ?? [];
      const soaks = item.soaks;
      item.sampledRendererPeakBytes = documentStats(
        soaks.flatMap((row) => row.memory?.map((sample) => sample.kinds?.renderer?.privateBytes) ?? []),
      );
      item.physicalHistoryPeakBytes = documentStats(
        soaks.flatMap((row) => row.history?.map((sample) => sample.physicalBytes) ?? []),
      );
      item.memory10Bytes = documentStats(
        soaks.map((row) => row.memory?.find((sample) => sample.elapsedMs >= 10 * 60000)?.kinds?.renderer?.privateBytes),
      );
      item.memory60Bytes = documentStats(
        soaks.map((row) => row.memory?.find((sample) => sample.elapsedMs >= 60 * 60000)?.kinds?.renderer?.privateBytes),
      );
      item.soakMinutes = documentStats(soaks.map((row) => row.elapsedMs / 60000));
      item.compactionMs = documentStats(
        soaks.flatMap((row) => row.compactions?.map((value) => value.observedUpperBoundMs) ?? []),
      );
      item.retainedTrendBytesPerMinute = documentStats(
        soaks.map((row) => {
          const buckets = new Map();
          for (const sample of row.compactions ?? []) {
            const minute = Math.floor(sample.elapsedMs / 60000);
            buckets.set(minute, Math.min(buckets.get(minute) ?? Infinity, sample.retainedBytes));
          }
          const points = [...buckets].filter(([minute]) => minute >= 1);
          if (points.length < 2) return null;
          const xm = points.reduce((n, [x]) => n + x, 0) / points.length,
            ym = points.reduce((n, [, y]) => n + y, 0) / points.length;
          return (
            points.reduce((n, [x, y]) => n + (x - xm) * (y - ym), 0) / points.reduce((n, [x]) => n + (x - xm) ** 2, 0)
          );
        }),
      );
      item.retainedGrowthBytes = documentStats(
        soaks.map((row) => {
          if (!row.compactions || row.compactions.length < 2) return null;
          const first = row.compactions[0].retainedBytes;
          return Math.max(...row.compactions.map((sample) => sample.retainedBytes - first));
        }),
      );
      item.historyWriteBytesPerMinute = documentStats(
        soaks.map((row) => {
          const bytes = engineWrites(row);
          return bytes === null ? null : (bytes / row.editCount) * 480;
        }),
      );
      result.cases[mib + '/' + shape] = item;
    }
  return result;
}

// Every relative gate records its noise allowance. The measured p95-p50 spreads
// supplement the existing ten percent/one-frame floor, never replace absolute caps.
export function relativeBudget(baseline, candidate, percentile, margin) {
  const value = baseline?.[percentile];
  const spread = Math.max(0, (baseline?.p95 ?? 0) - (baseline?.p50 ?? 0));
  const allowance = Number.isFinite(value) ? Math.max((value * margin.percent) / 100, margin.floorMs, spread) : null;
  return {
    baseline: value,
    spreadMs: spread,
    marginMs: allowance,
    limit: Number.isFinite(allowance) ? value + allowance : null,
  };
}
export function soakChecks(row) {
  const memory = row.memory ?? [],
    compactions = row.compactions ?? [];
  const bytes = (minute) => memory.find((sample) => sample.elapsedMs >= minute * 60000)?.kinds?.renderer?.privateBytes;
  const retained = compactions.map((sample) => sample.retainedBytes);
  return {
    rate: row.editsPerMinute,
    memory10: bytes(10),
    memory60: bytes(60),
    peak: memory.length ? Math.max(...memory.map((sample) => sample.kinds?.renderer?.privateBytes ?? Infinity)) : null,
    compaction:
      compactions.length >= 2
        ? Math.max(
            ...compactions
              .filter((sample) => Number.isFinite(sample.observedUpperBoundMs))
              .map((sample) => sample.observedUpperBoundMs),
          )
        : null,
    retained:
      retained.length >= 2 && retained.every(Number.isFinite)
        ? Math.max(...retained.map((value) => value - retained[0]))
        : null,
  };
}
export function compareDocumentSize(baseline, candidate, margin, { includeSoak = true } = {}) {
  const cases = candidate.documentSize?.cases ?? {},
    before = baseline.documentSize?.cases ?? {},
    checks = [],
    problems = [],
    sizes = [];
  if (
    candidate.settings?.documentMode !== 'gate' ||
    candidate.documentSize?.missingPairs ||
    candidate.documentSize?.metricsVersion !== 2
  )
    problems.push('A complete version-2 gate receipt is required');
  if (JSON.stringify(candidate.settings?.documentMiB) !== JSON.stringify(DOCUMENT_SIZES))
    problems.push('All four sizes, including 8 MiB, must be measured');
  if (
    candidate.settings?.keystrokes < 60 ||
    candidate.settings?.churnEdits < 100000 ||
    candidate.settings?.updatesPerSecond !== 8
  )
    problems.push('60 keys, 100000 churn edits and 8 edits/s are required');
  const add = (key, metric, value, limit, present = Number.isFinite(value), detail = {}) => {
    const row = {
      key,
      metric,
      value,
      limit,
      ...detail,
      verdict:
        !present || !Number.isFinite(value) || !(limit >= 0)
          ? 'missing'
          : value < 0 || value > limit
            ? 'failed'
            : 'pass',
    };
    checks.push(row);
    return row.verdict === 'pass';
  };
  const stat = (key, label, stats, p, limit, min = 1) =>
    add(key, label + ' ' + p, stats?.[p], limit, stats?.count >= min);
  const relative = (key, label, stats, control, p, min = 1) => {
    const budget = relativeBudget(control, stats, p, margin);
    add(key, label + ' ' + p, stats?.[p], budget.limit, stats?.count >= min && control?.count >= min, budget);
  };
  for (const phase of ['fresh', 'restart'])
    relative(
      'control',
      phase + ' launch',
      candidate[phase + 'EditableObservedMs'],
      baseline[phase + 'EditableObservedMs'],
      'p50',
      10,
    );
  for (const p of ['p50', 'p95']) {
    stat(
      'control',
      '5000-paragraph open',
      candidate.documentSize?.controls?.legacyOpenMs,
      p,
      p === 'p50' ? 487 : 532,
      40,
    );
    relative(
      'control',
      '500-link open',
      candidate.documentSize?.controls?.linksOpenMs,
      baseline.documentSize?.controls?.linksOpenMs,
      p,
      40,
    );
  }
  for (const mib of DOCUMENT_SIZES) {
    const start = checks.length;
    for (const shape of DOCUMENT_SHAPES) {
      const key = mib + '/' + shape,
        item = cases[key],
        n = shape === 'formatted-retained' ? (mib === 2 ? 10 : 20) : 3;
      if (!item) {
        add(key, 'case', null, 0, false);
        continue;
      }
      add(
        key,
        'independent pairs',
        item.pairs,
        Infinity,
        item.pairs >= n && unique(item.repetitions).length === item.pairs,
      );
      add(key, 'single fixture', item.fixtureSha256?.length, 1, item.fixtureSha256?.length === 1);
      if (before[key] && JSON.stringify(before[key].fixtureSha256) !== JSON.stringify(item.fixtureSha256))
        add(key, 'matching fixture', null, 0, false);
      const control = (mib === 2 ? before : cases)['2/' + shape];
      if (item.pairs < 40 && needsDocumentExtension(item, control))
        add(key, 'near-budget extension to forty pairs', null, 0, false);
      for (const phase of ['fresh', 'restart']) {
        const arm = item.phases?.[phase],
          base = control?.phases?.[phase];
        add(key, phase + ' failures', arm?.failures, 0);
        add(key, phase + ' export proofs', arm?.exportVerified, Infinity, arm?.exportVerified >= 3);
        add(key, phase + ' history proofs', arm?.historyVerified, Infinity, arm?.historyVerified >= 3);
        for (const [metric, budget] of [
          ['firstContentMs', OPEN_BUDGETS[mib].firstContent],
          ['editReadyMs', OPEN_BUDGETS[mib].editReady],
        ])
          for (const [index, p] of ['p50', 'p95'].entries())
            stat(key, phase + ' ' + metric, arm?.[metric], p, budget[index], n);
        for (const metric of ['firstKeyMs', 'typingMs'])
          for (const p of ['p50', 'p95'])
            relative(key, phase + ' ' + metric, arm?.[metric], base?.[metric], p, metric === 'typingMs' ? 3 * 59 : 3);
        stat(key, phase + ' settle', arm?.settleMs, 'p95', 1000, n);
        stat(key, phase + ' normalized engine cores', arm?.engineCores, 'p95', 1, n);
        add(
          key,
          phase + ' achieved rate shortfall',
          Math.max(0, 480 - (arm?.rate?.min ?? 0)),
          24,
          arm?.rate?.count >= n,
        );
      }
      for (const mode of ['peer', 'churn']) {
        const arm = item.peerPhases?.[mode],
          base = control?.peerPhases?.[mode];
        add(key, mode + ' renderer proof', arm?.verified, Infinity, arm?.verified >= 3 && arm?.runs === arm?.verified);
        for (const metric of ['firstKeyMs', 'typingMs'])
          relative(key, mode + ' ' + metric, arm?.[metric], base?.[metric], 'p95', 3);
        if (mode === 'churn')
          for (const [metric, budget] of [
            ['firstContentMs', OPEN_BUDGETS[mib].firstContent],
            ['editReadyMs', OPEN_BUDGETS[mib].editReady],
          ])
            stat(key, 'churn ' + metric, arm?.[metric], 'p95', budget[1], 3);
        add(
          key,
          mode + ' achieved rate shortfall',
          Math.max(0, 480 - (arm?.rate?.min ?? 0)),
          24,
          arm?.rate?.count >= 3,
        );
      }
      const churn = item.churn?.find((row) => !row.structural);
      add(key, '100000-edit churn and 5 MiB headroom', churn?.pass ? 0 : 1, 0, !!churn);
      add(key, 'structural admission recorded', 0, 0, !!item.churn?.find((row) => row.structural)?.admission?.status);
      const full = shape === 'formatted-retained',
        primary = item.relay?.['separate/1'];
      const arms = full ? ['separate/1', 'separate/2', 'separate/4', 'shared/4'] : ['separate/4'];
      for (const label of arms) {
        const relay = item.relay?.[label],
          shared = label.startsWith('shared'),
          from = checks.length;
        add(key, label + ' failures', relay?.failures, 0, relay?.runs >= 1);
        if (full)
          add(key, label + ' long suffix samples', relay?.longSuffixUpdates, Infinity, relay?.longSuffixUpdates >= 100);
        add(
          key,
          label + ' recovered journal',
          relay?.recoveryVerified,
          Infinity,
          relay?.recoveryVerified === relay?.runs && relay?.runs > 0,
        );
        const count = 240 * Number(label.split('/')[1]);
        for (const [metric, p, limit, min] of [
          ['cpuMs', 'p50', 50, count],
          ['cpuMs', 'p95', 100, count],
          ['waitMs', 'p95', 100, count],
          ['slotMs', 'p95', 100, count],
          ['occupancy', 'max', 0.8, 1],
          ['backlogGrowthMs', 'max', 100, 1],
          ['oldGenerationPeakBytes', 'max', 384 * MiB, 1],
          ['privatePeakSampledBytes', 'max', 1024 * MiB, 1],
          ['stateBytes', 'max', STATE_MAX_BYTES, count],
        ])
          stat(key, label + ' ' + metric, relay?.[metric], p, limit, min);
        add(
          key,
          label + ' offered rate shortfall',
          Math.max(0, 8 - (relay?.rate?.min ?? 0)),
          0.4,
          relay?.rate?.count >= 1,
        );
        add(
          key,
          label + ' reservation plus relay private',
          primary?.reservation?.relayBytes + relay?.privatePeakSampledBytes?.max,
          1024 * MiB,
        );
        if (shared)
          for (const row of checks.slice(from))
            if (
              /cpuMs|waitMs|slotMs|occupancy|backlogGrowthMs|rate shortfall/.test(row.metric) &&
              row.verdict === 'failed'
            )
              row.verdict = 'reported';
      }
      {
        add(
          key,
          'native restart/restore proof',
          primary?.nativeRestartVerified,
          Infinity,
          primary?.nativeRestartVerified >= 1 && primary?.restoreVerified >= 1,
        );
        add(
          key,
          'named/link socket proof',
          primary?.socketProbesVerified,
          Infinity,
          primary?.socketProbesVerified >= 1,
        );
        stat(key, 'native join', primary?.nativeJoinMs, 'p95', 2000, full ? 20 : 6);
        stat(key, 'socket join', primary?.socketJoinMs, 'p95', 2000, full ? 20 : 12);
        stat(key, 'native settle', primary?.nativeSettleMs, 'p95', 1000);
        stat(key, 'steady framed bytes per edit', primary?.steadyBytesPerEdit, 'max', 2048);
        stat(
          key,
          'initial transfer',
          primary?.initialTransferPerDocumentBytes,
          'max',
          3 * primary?.largestStateBytes + 65536,
        );
        add(key, 'native restore reservation', primary?.reservation?.nativeBytes, 512 * MiB);
        if (full) {
          add(key, 'checkpoint proof', primary?.checkpointCount, Infinity, primary?.checkpointCount >= 1);
          stat(key, 'checkpoint state', primary?.snapshotBytes, 'max', STATE_MAX_BYTES);
        }
      }
      for (const row of item.churnedRelay ?? []) {
        const label = 'churned ' + row.topology + '/' + row.sessions;
        add(key, label + ' complete', row.status === 'complete' ? 0 : 1, 0);
        add(key, label + ' state', row.largestStateBytes, STATE_MAX_BYTES);
        add(
          key,
          label + ' worker heap',
          max(row.updates?.map((u) => max([u.oldGenerationBytes, u.sampledUsedHeapPeakBytes])) ?? []),
          384 * MiB,
        );
        add(key, label + ' relay private', row.privatePeakSampledBytes, 1024 * MiB);
        add(
          key,
          label + ' reservation plus relay private',
          primary?.reservation?.relayBytes + row.privatePeakSampledBytes,
          1024 * MiB,
        );
        if (row.topology === 'separate')
          for (const [metric, limit] of [
            ['cpuMs', 100],
            ['waitMs', 100],
            ['slotMs', 100],
          ])
            stat(
              key,
              label + ' ' + metric,
              documentStats(row.updates?.map((u) => u[metric]) ?? []),
              'p95',
              limit,
              240 * row.sessions,
            );
        if (row.native) {
          add(key, label + ' restore proof', row.native.restore?.verified ? 0 : 1, 0);
          const r = row.reservationBounds
            ? restoreReservation(row.native.restorePayloadBytes, row.reservationBounds)
            : null;
          add(key, label + ' native reservation', r?.nativeBytes, 512 * MiB);
          add(key, label + ' reservation plus memory', r?.relayBytes + row.privatePeakSampledBytes, 1024 * MiB);
        }
      }
      add(key, 'churned relay arms', item.churnedRelay?.length, Infinity, item.churnedRelay?.length >= (full ? 3 : 2));
    }
    sizes.push({ mib, pass: checks.slice(start).every((row) => ['pass', 'reported'].includes(row.verdict)) });
  }
  let selectedMiB = null;
  for (const size of sizes) {
    if (!size.pass) break;
    selectedMiB = size.mib;
  }
  const eligible = selectedMiB;
  if (includeSoak) {
    selectedMiB = null;
    for (const mib of DOCUMENT_SIZES.filter((size) => size <= eligible).reverse()) {
      const attempt = candidate.documentSize?.soakAttempts?.find((row) => row.mib === mib),
        value = attempt ? soakChecks(attempt) : {};
      if (!attempt) {
        add(String(mib), '60-minute soak', null, 0, false);
        break;
      }
      const start = checks.length;
      add(String(mib), 'soak achieved rate shortfall', Math.max(0, 480 - value.rate), 24);
      for (const [metric, limit] of [
        ['memory10', 435_000_000],
        ['memory60', 477_000_000],
        ['peak', 477_000_000],
        ['compaction', 1000],
        ['retained', 2 * MiB],
      ])
        add(String(mib), 'soak ' + metric, value[metric], limit);
      if (checks.slice(start).every((row) => row.verdict === 'pass')) {
        selectedMiB = mib;
        break;
      }
    }
  }
  if (problems.length || checks.some((row) => row.key === 'control' && row.verdict !== 'pass')) selectedMiB = null;
  return {
    pass: selectedMiB !== null,
    selectedMiB,
    eligibleMiB: eligible,
    sizes,
    problems,
    checks,
    decision:
      'Largest contiguous passing size, then largest such size passing the full soak. Missing evidence is inconclusive.',
  };
}

export function needsDocumentExtension(item, control = item, margin = { percent: 10, floorMs: 17 }) {
  if (!item || item.pairs >= 40) return false;
  return ['fresh', 'restart'].some((phase) =>
    ['firstContentMs', 'editReadyMs', 'firstKeyMs', 'typingMs'].some((metric) => {
      const budget = ['firstKeyMs', 'typingMs'].includes(metric)
          ? relativeBudget(control.phases?.[phase]?.[metric], item.phases?.[phase]?.[metric], 'p95', margin).limit
          : OPEN_BUDGETS[item.mib][metric === 'firstContentMs' ? 'firstContent' : 'editReady'][1],
        value = item.phases?.[phase]?.[metric]?.p95;
      return Number.isFinite(value) && value >= budget * 0.9 && value <= budget * 1.25;
    }),
  );
}
