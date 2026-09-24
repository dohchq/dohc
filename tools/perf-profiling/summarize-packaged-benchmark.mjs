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
        launchStages: startup.launchStages, rendererReadiness: startup.rendererReadiness, v8MainLogs: startup.v8MainLogs });
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
  Object.assign(summary, surfaceSummaries(data.runs));
  return summary;
}

// Each section is null when its scenario did not run. Durations start at the renderer's
// receipt of the trusted keydown or mousedown and end two animation frames after the DOM predicate.
function surfaceSummaries(runs) {
  const of = key => runs.flatMap(run => run[key] ? [run[key]] : []);
  const unique = values => [...new Set(values.filter(value => value !== undefined))];
  const trend = values => {
    const finite = values.filter(Number.isFinite);
    return finite.length ? { first: finite[0], last: finite.at(-1), max: Math.max(...finite), delta: finite.at(-1) - finite[0] } : null;
  };
  const goTo = of('goTo'), palette = of('commandPalette'), searches = of('search').flat(), chats = of('chatHistory'), collections = of('collection'), soaks = of('soak');
  return {
    goTo: goTo.length ? {
      query: unique(goTo.map(g => g.query)),
      coldOpenToEditableInputPaintedMs: stats(goTo.map(g => g.cold.keydownToPaintedMs)),
      warmOpenToEditableInputPaintedMs: stats(goTo.map(g => g.warm.keydownToPaintedMs)),
      // Each keystroke ends when the input echoes the prefix and the first ranked row contains it in
      // order. The other rows are not checked, so this is not a full re-ranking time.
      keystrokeToFirstMatchPaintedMs: stats(goTo.flatMap(g => g.keystrokes.map(k => k.keydownToPaintedMs))),
      lastKeystrokeToFirstMatchPaintedMs: stats(goTo.map(g => g.keystrokes.at(-1)?.keydownToPaintedMs)),
      finalOptionCounts: unique(goTo.map(g => g.keystrokes.at(-1)?.optionCount)), finalFirstOptions: unique(goTo.map(g => g.firstOption)),
      entranceAnimating: unique(goTo.flatMap(g => [g.cold.observed?.entranceAnimating, g.warm.observed?.entranceAnimating])),
      openMatchedIn: unique(goTo.flatMap(g => [g.cold.observed?.matchedIn, g.warm.observed?.matchedIn])),
    } : null,
    commandPalette: palette.length ? {
      coldOpenToFirstRowPaintedMs: stats(palette.map(p => p.cold.keydownToPaintedMs)),
      warmOpenToFirstRowPaintedMs: stats(palette.map(p => p.warm.keydownToPaintedMs)),
      optionCounts: unique(palette.map(p => p.cold.optionCount)),
      entranceAnimating: unique(palette.flatMap(p => [p.cold.observed?.entranceAnimating, p.warm.observed?.entranceAnimating])),
      openMatchedIn: unique(palette.flatMap(p => [p.cold.observed?.matchedIn, p.warm.observed?.matchedIn])),
    } : null,
    search: searches.length ? Object.fromEntries(unique(searches.map(s => s.query)).map(query => {
      const rows = searches.filter(s => s.query === query);
      return [query, {
        openToInputPaintedMs: stats(rows.map(s => s.open?.clickToPaintedMs)),
        submitToFirstResultPaintedMs: stats(rows.map(s => s.submitToFirstResultMs)),
        submitToSettledPaintedMs: stats(rows.map(s => s.submitToSettledMs)),
        debounceFiredBeforeSubmitCount: rows.filter(s => s.debounceFiredBeforeSubmit).length, sawUpdatingCount: rows.filter(s => s.sawUpdating).length,
        summaries: unique(rows.map(s => s.summary)), limitHit: unique(rows.map(s => s.limitHit)), rowsRendered: unique(rows.map(s => s.rowsRendered)),
      }];
    })) : null,
    chatHistory: chats.length ? {
      messages: unique(chats.map(c => c.seed.messages)),
      seedingObservedMs: stats(chats.map(c => c.seed.seedingObservedMs)),
      channelOpenToPostsPaintedMs: stats(chats.map(c => c.channelOpen.clickToPostsPaintedMs)),
      threadOpenToFirstCommentPaintedMs: stats(chats.map(c => c.threadOpen.clickToFirstCommentPaintedMs)),
      threadOpenToAllCommentsPaintedMs: stats(chats.map(c => c.threadOpen.clickToAllCommentsPaintedMs)),
      allCommentsUnobservedCount: chats.filter(c => !Number.isFinite(c.threadOpen.clickToAllCommentsPaintedMs)).length,
      commentRowsRendered: unique(chats.map(c => c.threadOpen.commentRowsRendered)),
    } : null,
    collection: collections.length ? {
      records: unique(collections.map(c => c.records)),
      indexedWaitObservedMs: stats(collections.map(c => c.indexedWaitObservedMs)),
      openToRowsPaintedMs: stats(collections.map(c => c.clickToRowsPaintedMs)),
      rowsRendered: unique(collections.map(c => c.rowsRendered)), loadedRecords: unique(collections.map(c => c.loadedRecords)),
    } : null,
    soak: soaks.length ? soaks.map(soak => ({
      minutes: soak.minutes, searchQuery: soak.searchQuery ?? null, cycles: soak.cycles.length, elapsedMs: soak.elapsedMs, cycleDurationMs: stats(soak.cycles.map(c => c.durationMs)),
      kinds: Object.fromEntries(unique(soak.samples.flatMap(s => Object.keys(s.kinds))).map(kind => [kind, {
        processCounts: unique(soak.samples.map(s => s.kinds[kind]?.count ?? 0)),
        workingSetBytes: trend(soak.samples.map(s => s.kinds[kind]?.workingSetBytes)),
        privateBytes: trend(soak.samples.map(s => s.kinds[kind]?.privateBytes)),
      }])),
    })) : null,
  };
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
