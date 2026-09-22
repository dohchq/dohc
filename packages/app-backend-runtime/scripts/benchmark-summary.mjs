export function isExpectedOverload(label, failure) {
  if (!label.endsWith('/burst-100') || /deadline|timeout|timed out/i.test(`${failure.code ?? ''} ${failure.message ?? ''}`)) return false;
  return ['queue_full', 'worker_busy'].includes(failure.code)
    || /^(Dataset (?:workers are busy|host queue is full|operation queue is full)|The dataset worker queue (?:is full|byte limit is full))\b/.test(failure.message ?? '');
}

export function summarizeBenchmark(evidence) {
  const stages = evidence.stages ?? [];
  const metrics = stage => ({ label: stage.label, attempts: stage.attempts, successes: stage.count,
    p50: stage.p50, p95: stage.p95, p99: stage.p99, max: stage.max, elapsedMs: stage.elapsedMs,
    expectedOverloads: (stage.failures ?? []).filter(failure => isExpectedOverload(stage.label, failure)).length,
    unexpectedFailures: (stage.failures ?? []).filter(failure => !isExpectedOverload(stage.label, failure)),
    ...(stage.rowsAdded === undefined ? {} : { rowsAdded: stage.rowsAdded }) });
  const warm = stages.filter(stage => /\/warm-(read|write)\/[123]$/.test(stage.label)).map(metrics);
  const cold = stages.filter(stage => stage.label.endsWith('/cold-reopen')).map(metrics);
  const burst10 = stages.filter(stage => stage.label.endsWith('/burst-10')).map(metrics);
  const burst100 = stages.filter(stage => stage.label.endsWith('/burst-100')).map(metrics);
  const unexpected = stages.map(metrics).filter(stage => stage.unexpectedFailures.length);
  const observedMemory = (evidence.memory ?? []).filter(sample => Array.isArray(sample.processes) && sample.processes.length);
  const maxWorkerWorkingSetBytes = observedMemory.length ? Math.max(...observedMemory.map(sample => sample.workerWorkingSetBytes)) : null;
  const idleSamples = observedMemory.filter(sample => sample.label.endsWith('/after-idle')).map(sample => ({
    at: sample.at, label: sample.label, workerCount: sample.workers.length,
    workerWorkingSetBytes: sample.workerWorkingSetBytes, parentHeapUsedBytes: sample.parent?.heapUsed,
    parentExternalBytes: sample.parent?.external, parentRssBytes: sample.parent?.rss,
  }));
  const checks = {
    warmPerRound: warm.length === 12 && warm.every(stage => stage.successes === 200 && stage.p95 <= 50 && !stage.unexpectedFailures.length),
    coldPerFixture: cold.length === 2 && cold.every(stage => stage.attempts >= 30 && stage.successes === stage.attempts && stage.p95 <= 1000 && !stage.unexpectedFailures.length),
    tenSubmissionBursts: burst10.length === 2 && burst10.every(stage => stage.successes === 10 && stage.rowsAdded === 10 && stage.elapsedMs <= 1000 && !stage.unexpectedFailures.length),
    boundedHundredSubmissionBursts: burst100.length === 2 && burst100.every(stage => stage.attempts === 100 && stage.successes + stage.expectedOverloads === 100 && stage.rowsAdded === stage.successes && !stage.unexpectedFailures.length),
    oneHourSoak: evidence.soak?.requestedSeconds >= 3600 && evidence.soak?.actualSeconds >= evidence.soak.requestedSeconds
      && evidence.fixtures?.length >= 10 && stages.some(stage => stage.label.startsWith('soak/')),
    observedWorkerMemory: maxWorkerWorkingSetBytes === null ? null : maxWorkerWorkingSetBytes <= 512 * 1024 * 1024,
    idleWorkersReleased: idleSamples.length ? idleSamples.every(sample => sample.workerCount === 0 && sample.workerWorkingSetBytes === 0) : null,
  };
  const failures = stages.reduce((sum, stage) => sum + (stage.failures?.length ?? 0), 0);
  const workloadPassed = !(evidence.errors?.length) && unexpected.length === 0 && !(evidence.remainingOwnedPids?.length);
  return {
    scope: 'Local dataset host benchmark only; this does not pass the full campaign performance gate.',
    passed: workloadPassed && Object.values(checks).every(value => value === true),
    workloadPassed, checks, failures,
    unexpectedStages: unexpected.map(stage => ({ label: stage.label, failures: stage.unexpectedFailures })),
    errors: evidence.errors ?? [], warmRounds: warm, coldReopen: cold, burst10, burst100,
    memory: { maxObservedWorkerWorkingSetBytes: maxWorkerWorkingSetBytes, idleSamples,
      limitation: 'Stage-boundary samples cannot establish a process peak or exclude all retained-memory growth.' },
    unmeasured: ['Ordinary 4-core/8 GiB hardware', 'HTTP and controlled-LAN transport', 'Renderer responsiveness',
      'Attachments and public-link load', 'Broad text search and export effects', 'Separate queue waiting time', 'Continuous peak memory'],
  };
}
