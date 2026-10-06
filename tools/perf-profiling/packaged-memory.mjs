import { aggregateByKind, classifyProcess } from './packaged-surfaces.mjs';

export function memorySample(snapshot, appPid, switchIndex) {
  return { switchIndex, ...aggregateByKind(snapshot, appPid),
    processes: snapshot.processes.map(process => ({ pid: process.pid, createdAt: process.createdAt,
      kind: classifyProcess(process, appPid), privateBytes: process.privateBytes, workingSetBytes: process.workingSetBytes })) };
}

export async function recordSwitches({ count, activate, sample, result, checkpoint, signal }) {
  result.switches = [];
  result.switchMemory = { samples: [await sample(0)] };
  for (let index = 1; index <= count; index++) {
    signal?.throwIfAborted();
    result.switches.push(await activate(index % 2));
    result.switchMemory.samples.push(await sample(index));
    await checkpoint();
  }
}

const median = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const slope = samples => {
  const x = samples.map(sample => sample.switchIndex), y = samples.map(sample => sample.value);
  const meanX = x.reduce((a, b) => a + b, 0) / x.length, meanY = y.reduce((a, b) => a + b, 0) / y.length;
  return x.reduce((total, value, index) => total + (value - meanX) * (y[index] - meanY), 0) /
    x.reduce((total, value) => total + (value - meanX) ** 2, 0);
};

// Late windows describe growth during this run. They do not establish leak freedom.
export function summarizeSwitchMemory(memory, expectedSwitches) {
  const samples = memory?.samples ?? [];
  const complete = Number.isSafeInteger(expectedSwitches) && expectedSwitches > 0 && samples.length === expectedSwitches + 1 && samples.every((sample, index) =>
    sample.switchIndex === index && Number.isFinite(sample.completedAtMs) &&
    (index === 0 || sample.completedAtMs > samples[index - 1].completedAtMs) &&
    Array.isArray(sample.processes) && sample.processes.length > 0 &&
    ['main', 'engine', 'renderer'].every(kind => sample.processes.some(process => process.kind === kind)) &&
    new Set(sample.processes.map(process => `${process.pid}:${process.createdAt}`)).size === sample.processes.length &&
    sample.processes.every(process => Number.isSafeInteger(process.pid) && typeof process.createdAt === 'string' && process.createdAt.length > 0 &&
      Number.isFinite(process.privateBytes) && process.privateBytes >= 0 && Number.isFinite(process.workingSetBytes) && process.workingSetBytes >= 0));
  const kinds = [...new Set(samples.flatMap(sample => (sample.processes ?? []).map(process => process.kind)))];
  const tail = samples.slice(-40);
  const result = { expectedSwitches, samples: samples.length, complete, plateauMeasured: complete && expectedSwitches >= 100, kinds: {} };
  for (const kind of kinds) {
    const rows = samples.map(sample => ({ switchIndex: sample.switchIndex,
      processes: (sample.processes ?? []).filter(process => process.kind === kind) }));
    const identities = rows.map(row => row.processes.map(process => `${process.pid}:${process.createdAt}`).sort().join('|'));
    const tailIdentities = identities.slice(-40);
    const identityChanges = identities.slice(1).filter((identity, index) => identity !== identities[index]).length;
    const identityScope = ['main', 'engine', 'renderer', 'gpu'].includes(kind) ? 'whole-run' : 'last-40-switches';
    const churn = identityScope === 'whole-run' ? identityChanges > 0 : new Set(tailIdentities).size > 1;
    const metrics = {};
    for (const field of ['privateBytes', 'workingSetBytes']) {
      const values = rows.map(row => row.processes.reduce((total, process) => total + process[field], 0));
      const measured = result.plateauMeasured && !churn;
      const previousMedian = measured ? median(values.slice(-40, -20)) : null;
      const lastMedian = measured ? median(values.slice(-20)) : null;
      metrics[field] = { first: values[0] ?? null, last: values.at(-1) ?? null,
        max: values.length ? Math.max(...values) : null, previousMedian, lastMedian,
        lateGrowthBytes: measured ? lastMedian - previousMedian : null,
        tailSlopeBytesPerSwitch: measured ? slope(tail.map((sample, index) => ({ switchIndex: sample.switchIndex, value: values[values.length - 40 + index] }))) : null };
    }
    result.kinds[kind] = { processCounts: [...new Set(rows.map(row => row.processes.length))], churn, identityScope,
      identityChanges, ...metrics };
  }
  return result;
}
