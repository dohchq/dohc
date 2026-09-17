import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const stats = input => {
  const values = input.filter(Number.isFinite);
  return { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null };
};
export async function summarize(data, readLog = async () => '') {
  if (!Array.isArray(data.runs)) throw Error('Invalid benchmark receipt: runs must be an array');
  const startupEvidence = [];
  for (const run of data.runs) {
    for (const phase of ['fresh', 'restart']) {
      const startup = run[phase === 'fresh' ? 'freshStartup' : 'restartStartup'];
      if (!startup) continue;
      const log = await readLog(run.index, phase);
      const line = log.match(/\[desktop\] launch marks \(ms since process start\): ([^\r\n]+)/)?.[1] ?? null;
      const nativeMarks = line ? Object.fromEntries([...line.matchAll(/([a-z-]+) (\d+(?:\.\d+)?)/g)].map(m => [m[1], Number(m[2])])) : null;
      startupEvidence.push({ run: run.index, phase, nativeMarksMsSinceModuleEvaluation: nativeMarks,
        rendererPaintsMsSinceHarnessSpawn: startup.renderer?.paints?.map(p => ({ name: p.name, ms: startup.renderer.timeOrigin + p.startTime - startup.startedAt })) ?? [],
        observedEditableMs: startup.editablePaintObservedMs, windowControlObservedMs: startup.windowControlObservedMs,
        launchStages: startup.launchStages, v8MainLogs: startup.v8MainLogs });
    }
  }
  const summary = {
    label: data.label, status: data.status, packageCommit: data.packageCommit, asarSha256: data.asarSha256,
    engineCommit: data.engineCommit, engineSha256: data.engineSha256,
    diagnostic: Boolean(data.settings?.profileMain || data.settings?.profileRenderer),
    startupEvidence, settings: data.settings,
    freshEditableObservedMs: stats(data.runs.flatMap(r => r.freshStartup ? [r.freshStartup.editablePaintObservedMs] : [])),
    restartEditableObservedMs: stats(data.runs.flatMap(r => r.restartStartup ? [r.restartStartup.editablePaintObservedMs] : [])),
    startupWindowControlObservedMs: stats(data.runs.flatMap(r => [r.freshStartup, r.restartStartup].filter(Boolean).map(s => s.windowControlObservedMs).filter(Number.isFinite))),
    warmSwitchEditableObservedMs: stats(data.runs.flatMap(r => (r.switches ?? []).map(s => s.editablePaintObservedMs))),
    nativeSwitchPhasesMs: {}, switchLongTasks: {}, typing: {}, idle: [], limits: data.limits,
  };
  const switchRows = data.runs.flatMap(r => r.switches ?? []);
  for (const phase of new Set(switchRows.flatMap(s => Object.keys(s.phasesMs ?? {})))) {
    summary.nativeSwitchPhasesMs[phase] = stats(switchRows.map(s => s.phasesMs?.[phase]).filter(Number.isFinite));
  }
  const switchTasks = switchRows.flatMap(s => s.longTasks ?? []);
  summary.switchLongTasks = { count: switchTasks.length, totalMs: switchTasks.reduce((sum, task) => sum + task.duration, 0), durationMs: stats(switchTasks.map(task => task.duration)) };
  for (const name of ['small.md', 'large.md']) {
    const tasks = data.runs.flatMap(r => (r.typing ?? []).filter(t => t.name === name));
    const samples = tasks.flatMap(t => t.samples);
    summary.typing[name] = {
      openObservedMs: stats(tasks.map(t => t.openObservedMs)),
      editActivationObservedMs: stats(tasks.flatMap(t => t.editActivationObservedMs === null ? [] : [t.editActivationObservedMs])),
      inputCount: samples.length,
      modes: [...new Set(tasks.map(t => t.mode ?? 'unknown'))],
      eventTimingSupported: tasks.length ? tasks.every(t => t.supported) : null,
      eventTimingUnreportedCount: samples.filter(s => !Number.isFinite(s.inputToNextPaintMs)).length,
      inputToNextPaintReportedOnlyMs: stats(samples.map(s => s.inputToNextPaintMs)),
      dispatchToTwoRafObservedMs: stats(samples.map(s => s.dispatchToTwoRafMs)),
      longTaskCount: tasks.reduce((n, t) => n + t.longTasks.length, 0),
      longTaskTotalMs: tasks.reduce((n, t) => n + t.longTasks.reduce((sum, item) => sum + item.duration, 0), 0),
    };
  }
  for (const idle of data.runs.flatMap(r => r.idle ?? [])) {
    summary.idle.push({ state: idle.state, windowState: idle.windowState, domVisibility: idle.domVisibility, elapsedMs: idle.elapsedMs, cpuPercentOneLogicalCore: idle.cpuPercentOneLogicalCore,
      privateBytes: stats(idle.totals.map(t => t.privateBytes)), processCounts: [...new Set(idle.totals.map(t => t.processCount))],
      deltas: idle.deltas, contextSwitches: idle.contextSwitches, hardwareWakeups: idle.hardwareWakeups });
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directories = process.argv.slice(2);
  if (!directories.length || directories.some(value => value.startsWith('--'))) throw Error('Usage: node summarize-packaged-benchmark.mjs <result-directory> [...]');
  for (const directory of directories) {
    const dir = resolve(directory);
    const data = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    const summary = await summarize(data, async (run, phase) => {
      try { return await readFile(join(dir, `run-${run}`, `${phase}.log`), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    });
    await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  }
}
