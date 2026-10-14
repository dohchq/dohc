const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
};
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const PRESENCE_RULE = { minimumRuns: 5, floorMs: 2, capMs: 8 };
export const PRESENCE_DOCUMENTS = ['small.md', 'large.md'];
export const PRESENCE_ARMS = ['solo', 'peers'];

// Pool keystrokes inside each run. Keep those run percentiles separate across runs.
export function summarizePresence(runs) {
  return Object.fromEntries(PRESENCE_ARMS.map(arm => [arm, Object.fromEntries(PRESENCE_DOCUMENTS.map(name => [name,
    runs.map(run => {
      const task = run.presence?.[arm]?.find(task => task.name === name);
      const values = task?.samples.map(sample => sample.inputToNextPaintMs).filter(Number.isFinite) ?? [];
      return { run: run.index, count: values.length, keystrokes: task?.samples.length ?? 0,
        unreported: (task?.samples.length ?? 0) - values.length,
        p50: percentile(values, .5), p95: percentile(values, .95),
        longTasks: task?.longTasks?.length ?? null, supported: task?.supported ?? false,
        mode: task?.mode ?? null, workload: task?.workload ?? null };
    })
  ]))]));
}

export function comparePresence(baseline, candidate, settings) {
  const checks = [], problems = [];
  for (const arm of PRESENCE_ARMS) for (const name of PRESENCE_DOCUMENTS) {
    const metric = 'presence ' + arm + ' ' + name;
    const sides = [baseline?.[arm]?.[name] ?? [], candidate?.[arm]?.[name] ?? []];
    let valid = true;
    for (const [index, rows] of sides.entries()) {
      const side = index === 0 ? 'baseline' : 'candidate';
      if (rows.length < PRESENCE_RULE.minimumRuns) {
        problems.push(metric + ': ' + side + ' needs at least 5 runs.'); valid = false;
      }
      if (new Set(rows.map(row => row.run)).size !== rows.length) {
        problems.push(metric + ': duplicate ' + side + ' runs.'); valid = false;
      }
      for (const row of rows) {
        if (!row.supported || row.count !== settings.keystrokes || row.keystrokes !== settings.keystrokes ||
            !Number.isFinite(row.p50) || !Number.isFinite(row.p95) || row.mode !== 'rich') {
          problems.push(metric + ': missing ' + side + ' timing in run ' + row.run + '.'); valid = false;
        }
        if (row.longTasks !== 0) {
          problems.push(metric + ': ' + side + ' long tasks in run ' + row.run + '.'); valid = false;
        }
        if (arm === 'peers' && (!row.workload?.pass || row.workload.peers !== settings.presencePeers)) {
          problems.push(metric + ': incomplete ' + side + ' peer workload in run ' + row.run + '.'); valid = false;
        }
      }
    }
    for (const percentile of ['p50', 'p95']) {
      if (!valid) { checks.push({ metric: metric + ' ' + percentile, verdict: 'invalid' }); continue; }
      const before = sides[0].map(row => row[percentile]), after = sides[1].map(row => row[percentile]);
      const spreadMs = Math.max(...before) - Math.min(...before);
      const allowanceMs = Math.min(PRESENCE_RULE.capMs, Math.max(spreadMs, PRESENCE_RULE.floorMs));
      const baselineMedianMs = median(before), candidateMedianMs = median(after), limitMs = baselineMedianMs + allowanceMs;
      const verdict = candidateMedianMs <= limitMs ? 'pass' : 'regressed';
      checks.push({ metric: metric + ' ' + percentile, baselineMedianMs, candidateMedianMs, spreadMs, allowanceMs, limitMs, verdict });
      if (verdict !== 'pass') problems.push(metric + ' ' + percentile + ': regressed');
    }
  }
  return { pass: problems.length === 0, rule: PRESENCE_RULE, checks, problems };
}
