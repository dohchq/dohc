const COUNTERS = ['cpuMs', 'readBytes', 'writeBytes', 'otherBytes', 'readOperations', 'writeOperations', 'otherOperations'];
const emptyDeltas = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
const validCounter = value => Number.isFinite(value) && value >= 0;

function snapshotProcesses(snapshot) {
  const identities = new Map(), problems = [];
  if (!Array.isArray(snapshot?.processes) || !snapshot.processes.length) return { identities, problems: ['Missing process identities'] };
  for (const process of snapshot.processes) {
    if (!Number.isSafeInteger(process?.pid) || process.pid < 1 || typeof process.createdAt !== 'string' || !process.createdAt) {
      problems.push('Invalid process identity'); continue;
    }
    const identity = `${process.pid}:${process.createdAt}`;
    if (identities.has(identity)) problems.push(`Duplicate process identity: ${identity}`);
    identities.set(identity, process);
    if (!validCounter(process.cpuMs)) problems.push(`Invalid CPU counter: ${identity}`);
  }
  return { identities, problems };
}

/** Partial counter deltas remain diagnostic; only complete observed intervals produce a CPU budget reading. */
export function accountIdle(samples) {
  const deltas = emptyDeltas(), intervals = [];
  const snapshots = Array.isArray(samples) ? samples : [];
  for (let index = 1; index < snapshots.length; index++) {
    const before = snapshotProcesses(snapshots[index - 1]), after = snapshotProcesses(snapshots[index]);
    const beforeAtMs = snapshots[index - 1]?.completedAtMs, afterAtMs = snapshots[index]?.completedAtMs;
    const elapsedMs = Number.isFinite(beforeAtMs) && Number.isFinite(afterAtMs) ? afterAtMs - beforeAtMs : null;
    const added = [...after.identities.keys()].filter(identity => !before.identities.has(identity));
    const removed = [...before.identities.keys()].filter(identity => !after.identities.has(identity));
    const problems = [...before.problems, ...after.problems];
    if (!Number.isFinite(elapsedMs) || !(elapsedMs > 0)) problems.push('Invalid elapsed interval');
    if (added.length) problems.push('Process identities added');
    if (removed.length) problems.push('Process identities removed');
    const delta = emptyDeltas(), counters = [];
    for (const identity of new Set([...before.identities.keys(), ...after.identities.keys()])) {
      const previous = before.identities.get(identity), current = after.identities.get(identity);
      const beforeCpuMs = previous?.cpuMs ?? null, afterCpuMs = current?.cpuMs ?? null;
      const cpuMs = previous && current && validCounter(beforeCpuMs) && validCounter(afterCpuMs) && afterCpuMs >= beforeCpuMs
        ? afterCpuMs - beforeCpuMs : null;
      counters.push({ identity, beforeCpuMs, afterCpuMs, cpuMs });
      if (!previous || !current) continue;
      if (validCounter(beforeCpuMs) && validCounter(afterCpuMs) && afterCpuMs < beforeCpuMs) problems.push(`CPU counter decreased: ${identity}`);
      for (const key of COUNTERS) {
        if (validCounter(previous[key]) && validCounter(current[key]) && current[key] >= previous[key]) delta[key] += current[key] - previous[key];
      }
    }
    for (const key of COUNTERS) deltas[key] += delta[key];
    intervals.push({ beforeAtMs, afterAtMs, elapsedMs, identities: { before: [...before.identities.keys()], after: [...after.identities.keys()] },
      added, removed, counters, deltas: delta, complete: problems.length === 0, problems });
  }
  const first = snapshots[0]?.completedAtMs, last = snapshots.at(-1)?.completedAtMs;
  const elapsedMs = Number.isFinite(first) && Number.isFinite(last) ? last - first : null;
  const problems = intervals.flatMap(interval => interval.problems);
  if (!intervals.length) problems.push('Missing measured intervals');
  if (intervals.length && (!Number.isFinite(elapsedMs) || !(elapsedMs > 0))) problems.push('Invalid measured window');
  if (!validCounter(deltas.cpuMs)) problems.push('Invalid aggregate CPU counter');
  const cpuCoverage = { complete: problems.length === 0, intervalCount: intervals.length, problems };
  return { elapsedMs, deltas, intervals, cpuCoverage,
    cpuPercentOneLogicalCore: cpuCoverage.complete ? 100 * deltas.cpuMs / elapsedMs : null };
}
