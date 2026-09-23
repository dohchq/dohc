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
    ...(stage.rowsAdded === undefined ? {} : { rowsAdded: stage.rowsAdded }),
    preDispatch:stage.preDispatch,prepareReply:stage.prepareReply,transactions:stage.transactions,exports:stage.exports });
  const warm = stages.filter(stage => /\/warm-(read|write)\/[123]$/.test(stage.label)).map(metrics);
  const cold = stages.filter(stage => stage.label.endsWith('/cold-reopen')).map(metrics);
  const burst10 = stages.filter(stage => stage.label.endsWith('/burst-10')).map(metrics);
  const burst100 = stages.filter(stage => stage.label.endsWith('/burst-100')).map(metrics);
  const diagnostics=stages.filter(stage=>/\/(late-page|broad-text-search|export)$/.test(stage.label)).map(metrics);
  const unexpected = stages.map(metrics).filter(stage => stage.unexpectedFailures.length);
  const observedMemory = (evidence.memory ?? []).filter(sample => Array.isArray(sample.processes) && sample.processes.length);
  const memoryValues=observedMemory.map(sample=>sample.workerWorkingSetBytes);
  if(evidence.memorySampling?.samples>0)memoryValues.push(evidence.memorySampling.maxSampledWorkerWorkingSetBytes);
  const maxWorkerWorkingSetBytes = memoryValues.length ? Math.max(...memoryValues) : null;
  const idleSamples = observedMemory.filter(sample => sample.label.endsWith('/after-idle')).map(sample => ({
    at: sample.at, label: sample.label, workerCount: sample.workers.length,
    workerWorkingSetBytes: sample.workerWorkingSetBytes, parentHeapUsedBytes: sample.parent?.heapUsed,
    parentExternalBytes: sample.parent?.external, parentRssBytes: sample.parent?.rss,
  }));
  const growth=key=>{const values=idleSamples.map(sample=>sample[key]).filter(Number.isFinite);return{samples:values.length,first:values[0]??null,last:values.at(-1)??null,delta:values.length?values.at(-1)-values[0]:null,strictlyIncreasing:values.length>=3?values.every((value,index)=>index===0||value>values[index-1]):null};};
  const checks = {
    warmPerRound: warm.length === 12 && warm.every(stage => stage.successes === 200 && stage.p95 <= 50 && !stage.unexpectedFailures.length),
    coldPerFixture: cold.length === 2 && cold.every(stage => stage.attempts >= 30 && stage.successes === stage.attempts && stage.p95 <= 1000 && !stage.unexpectedFailures.length),
    tenSubmissionBursts: burst10.length === 2 && burst10.every(stage => stage.successes === 10 && stage.rowsAdded === 10 && stage.elapsedMs <= 1000 && !stage.unexpectedFailures.length),
    boundedHundredSubmissionBursts: burst100.length === 2 && burst100.every(stage => stage.attempts === 100 && stage.successes + stage.expectedOverloads === 100 && stage.rowsAdded === stage.successes && !stage.unexpectedFailures.length),
    oneHourSoak: evidence.soak?.requestedSeconds >= 3600 && evidence.soak?.actualSeconds >= evidence.soak.requestedSeconds
      && evidence.fixtures?.length >= 10 && stages.some(stage => stage.label.startsWith('soak/')),
    observedWorkerMemory: maxWorkerWorkingSetBytes === null ? null : maxWorkerWorkingSetBytes <= 512 * 1024 * 1024,
    idleWorkersReleased: idleSamples.length ? idleSamples.every(sample => sample.workerCount === 0 && sample.workerWorkingSetBytes === 0)
      && evidence.idleDrains?.length===idleSamples.length&&evidence.idleDrains.every(drain=>drain.passed&&drain.observedMs<=drain.deadlineMs) : null,
    diagnosticsCompleted:diagnostics.length===6&&diagnostics.every(stage=>stage.successes===stage.attempts&&!stage.unexpectedFailures.length),
  };
  const failures = stages.reduce((sum, stage) => sum + (stage.failures?.length ?? 0), 0);
  const workloadPassed = !(evidence.errors?.length) && unexpected.length === 0 && !(evidence.remainingOwnedPids?.length);
  return {
    scope: 'Local dataset host benchmark only; this does not pass the full campaign performance gate.',
    passed: workloadPassed && Object.values(checks).every(value => value === true),
    workloadPassed, checks, failures,
    unexpectedStages: unexpected.map(stage => ({ label: stage.label, failures: stage.unexpectedFailures })),
    errors: evidence.errors ?? [], warmRounds: warm, coldReopen: cold, burst10, burst100,diagnostics,
    memory: { maxObservedWorkerWorkingSetBytes: maxWorkerWorkingSetBytes, idleSamples,
      idleDrains:evidence.idleDrains??[],fixedIdleObservations:(evidence.memory??[]).filter(sample=>sample.label.endsWith('/idle-31s')),
      sampling:evidence.memorySampling,idleGrowth:{parentHeap: growth('parentHeapUsedBytes'),parentExternal:growth('parentExternalBytes'),parentRss:growth('parentRssBytes')},
      limitation: '250ms samples can miss simultaneous aggregate peaks. Per-process kernel peaks apply only to observed worker lifetimes and cannot be summed into an aggregate peak. Idle deltas are observations, not a leak verdict.' },
    unmeasured: ['Ordinary 4-core/8 GiB hardware', 'HTTP and controlled-LAN transport', 'Renderer responsiveness',
      'Attachments and public-link load', 'Concurrent export effects on ordinary reads', 'Isolated queue waiting time', 'Exact simultaneous aggregate peak memory'],
  };
}
