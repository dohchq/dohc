import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize, harnessHashKeys } from './summarize-packaged-benchmark.mjs';

// Compare packages on the same host and harness. Collection open and typing gate on p95 within 10%
// or 17 ms, whichever is larger. Automation press-to-settled gates on p50 within 25% or 17 ms, with
// at least five runs per case on each side. Contention press-to-settled is reported; typing still gates.
// On this host, the same main package failed 10 of 24 p95 checks across two three-run passes.
// Finished-case medians agreed within 10% for 7 of 12 cases; at-cap Finds varied 24 to 36%, and
// press-to-settled while typing varied 45 to 47%. With few runs, p95 is the slowest run.
// Alternate baseline and candidate runs. --margin-percent, --automation-margin-percent and --floor-ms
// control the recorded margins. The 17 ms floor is a comparison tolerance, not a latency budget.
export const DEFAULT_MARGIN = { percent: 10, automationPercent: 25, floorMs: 17 };
export const DEFAULT_RESOURCES = { cpuPercentagePoints: null, memoryBytes: 0, idleCpuMax: null, memoryGrowthMaxBytes: null };
const MIN_AUTOMATION_RUNS = 5;
const MIN_STARTUP_RUNS = 5;
const COMPARABLE_SCENARIOS = ['full', 'startup', 'switches', 'small-tab', 'small-switch', 'collection'];

// Settings that change what a receipt measures. The limits may differ: they decide which cases are
// comparable, through each case's fixture digest.
const COMPARED_SETTINGS = ['scenario', 'runCount', 'keystrokes', 'fixtureFiles', 'records', 'idleSeconds', 'switches', 'soakMinutes', 'chatMessages', 'profileRenderer', 'profileMain'];

function resourceCheck(metric, unit, baseline, candidate, percent, floor) {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || baseline < 0 || candidate < 0) return { metric, unit, baseline, candidate, verdict: 'missing' };
  const limit = baseline + Math.max(Math.abs(baseline) * percent / 100, floor);
  return { metric, unit, baseline, candidate, limit, verdict: candidate > limit ? 'regressed' : 'pass' };
}

function requiredMetrics(summary) {
  const { scenario, runCount, switches, keystrokes } = summary.settings ?? {};
  const required = [];
  if (['full', 'startup'].includes(scenario)) required.push(['fresh startup', summary.freshEditableObservedMs, runCount], ['restart startup', summary.restartEditableObservedMs, runCount]);
  if (['full', 'switches'].includes(scenario)) required.push(['warm workspace activation', summary.warmSwitchEditableObservedMs, runCount * switches]);
  if (scenario === 'small-tab') required.push(['warm tab activation', summary.warmTabEditableObservedMs, runCount * switches]);
  if (scenario === 'small-switch') required.push(['initial and return workspace activation', summary.initialAndReturnSwitchEditableObservedMs, runCount * 2]);
  if (scenario === 'collection') required.push(['collection open to rows painted', summary.collection?.openToRowsPaintedMs, runCount]);
  for (const name of scenario === 'full' ? ['small.md', 'large.md'] : ['small-tab', 'small-switch', 'collection'].includes(scenario) ? ['small.md'] : []) {
    required.push([`typing ${name}`, summary.typing?.[name]?.dispatchToTwoRafObservedMs, runCount * keystrokes]);
  }
  return required;
}

function check(metric, baseline, candidate, margin, percentile = 'p95') {
  const field = percentile === 'p50' ? 'P50' : 'P95';
  const row = { metric, [`baseline${field}`]: baseline?.[percentile] ?? null, [`candidate${field}`]: candidate?.[percentile] ?? null };
  if (!baseline?.count && !candidate?.count) return { ...row, verdict: 'unmeasured' };
  if (!candidate?.count) return { ...row, verdict: 'missing' };
  if (!baseline?.count) return { ...row, verdict: 'new' };
  const limit = baseline[percentile] + Math.max(baseline[percentile] * margin.percent / 100, margin.floorMs);
  return { ...row, limit, verdict: candidate[percentile] > limit ? 'regressed' : 'pass' };
}

/**
 * The checks between two summaries, and whether the candidate passes. A regressed or missing
 * measurement fails, and so does a candidate case that failed its own checks. A case whose fixture
 * differs between the receipts, such as a Find at a different cap, is checked only within the
 * candidate. Unmeasured and new measurements neither pass nor fail the comparison.
 */
export function compareSummaries(baseline, candidate, margin = DEFAULT_MARGIN, resources = DEFAULT_RESOURCES) {
  margin = { ...DEFAULT_MARGIN, ...margin };
  resources = { ...DEFAULT_RESOURCES, ...resources };
  for (const [key, value] of Object.entries(resources)) if (value !== null && (!Number.isFinite(value) || value < 0)) throw Error(`${key} must be a number of at least 0`);
  const problems = [];
  if (!COMPARABLE_SCENARIOS.includes(candidate.settings?.scenario)) problems.push(`Scenario ${candidate.settings?.scenario} is not comparable: no gated metrics are implemented.`);
  if (resources.idleCpuMax !== null && candidate.settings?.scenario !== 'full') problems.push('The absolute idle CPU budget requires the full scenario.');
  if (resources.memoryGrowthMaxBytes !== null && candidate.settings?.scenario !== 'switches') problems.push('The absolute memory-growth budget requires the switches scenario.');
  for (const [label, summary] of [['baseline', baseline], ['candidate', candidate]]) {
    if (summary.status !== 'complete') problems.push(`The ${label} receipt is ${summary.status}, not complete.`);
    if (summary.settings?.scenario === 'startup' && summary.settings.runCount < MIN_STARTUP_RUNS) problems.push(`The ${label} startup-only comparison needs at least ${MIN_STARTUP_RUNS} runs; recorded ${summary.settings.runCount}.`);
  }
  for (const key of COMPARED_SETTINGS) {
    if (JSON.stringify(baseline.settings?.[key]) !== JSON.stringify(candidate.settings?.[key])) problems.push(`The receipts differ in ${key}.`);
  }
  if (baseline.diagnostic || candidate.diagnostic) problems.push('A profiled receipt cannot serve as a performance comparison.');
  {
    for (const [label, summary] of [['baseline', baseline], ['candidate', candidate]]) {
      if (summary.measurementVersion !== 2) problems.push(`The ${label} receipt needs measurement version 2.`);
      if (summary.runs !== summary.settings?.runCount) problems.push(`The ${label} receipt has ${summary.runs ?? 0} runs; expected ${summary.settings?.runCount}.`);
      if (!['hostname', 'arch', 'release', 'cpuModel'].every(key => typeof summary.host?.[key] === 'string' && summary.host[key].length > 0) ||
        !Number.isSafeInteger(summary.host?.logicalProcessors) || summary.host.logicalProcessors < 1 ||
        !(summary.host?.totalMemoryBytes > 0) || !summary.node || !summary.platform) problems.push(`The ${label} receipt has no complete host identity.`);
      for (const key of harnessHashKeys(summary.settings?.scenario)) if (!/^[a-f\d]{64}$/i.test(summary.harnessHashes?.[key] ?? '')) problems.push(`The ${label} receipt has no ${key}.`);
      if (!Array.isArray(summary.fixtureHashes) || summary.fixtureHashes.length !== summary.settings?.runCount || summary.fixtureHashes.some(run => !run || run.length !== 2 || run.some(fixture => !/^[a-f\d]{64}$/i.test(fixture.digest ?? '')))) problems.push(`The ${label} receipt has incomplete fixture digests.`);
    }
    for (const key of ['host', 'node', 'platform', 'harnessHashes', 'fixtureHashes']) {
      if (JSON.stringify(baseline[key]) !== JSON.stringify(candidate[key])) problems.push(`The receipts differ in ${key}.`);
    }
  }
  for (const [label, summary] of [['baseline', baseline], ['candidate', candidate]]) {
    for (const [metric, values, expected] of requiredMetrics(summary)) {
      if (!Number.isSafeInteger(expected) || expected < 1 || values?.count !== expected) problems.push(`The ${label} ${metric} has ${values?.count ?? 0} samples; expected ${expected}.`);
    }
  }
  const fewestRuns = summary => {
    const counts = ['document', 'dataset'].flatMap(kind => Object.values(summary.collectionAutomations?.[kind] ?? {}).map(item => item.runs));
    return counts.length ? Math.min(...counts) : null;
  };
  const baselineRuns = fewestRuns(baseline), candidateRuns = fewestRuns(candidate);
  if ([baselineRuns, candidateRuns].some(count => count !== null && count < MIN_AUTOMATION_RUNS)) {
    problems.push(`Automation cases need at least ${MIN_AUTOMATION_RUNS} runs on each side; the fewest recorded are baseline: ${baselineRuns ?? 'no cases'}, candidate: ${candidateRuns ?? 'no cases'}.`);
  }
  const checks = [];
  for (const [metric, , expected] of requiredMetrics(candidate).filter(([metric]) => !metric.startsWith('typing '))) {
    const before = requiredMetrics(baseline).find(([name]) => name === metric)?.[1];
    const after = requiredMetrics(candidate).find(([name]) => name === metric)?.[1];
    const row = before?.count === expected && after?.count === expected ? check(metric, before, after, margin) : { metric, verdict: 'missing' };
    if (metric.endsWith('startup') && row.verdict !== 'missing' && expected < MIN_STARTUP_RUNS) row.verdict = 'insufficient-runs';
    checks.push(row);
  }
  for (const name of Object.keys(candidate.typing ?? {})) {
    checks.push(check(`typing ${name} dispatch to two frames`, baseline.typing?.[name]?.dispatchToTwoRafObservedMs, candidate.typing[name].dispatchToTwoRafObservedMs, margin));
  }
  const cases = [];
  const absoluteChecks = [];
  if (candidate.settings?.scenario === 'full') {
    for (const state of ['visible', 'minimized']) {
      const rows = [baseline, candidate].map(summary => (summary.idle ?? []).filter(idle => idle.state === state));
      for (const [index, label] of ['baseline', 'candidate'].entries()) {
        if (rows[index].length !== 1 || !rows[index].every(idle => {
          const quiet = idle.quiet;
          return idle.elapsedMs >= candidate.settings.idleSeconds * 1000 &&
            quiet && quiet.kinds === null && quiet.intervals === 3 && quiet.intervalMs >= 1000 && quiet.share === .05 &&
            quiet.evidence?.length >= 3 && quiet.evidence.slice(-3).every(interval => interval.elapsedMs >= 1000 && Number.isFinite(interval.busyShare) && interval.busyShare >= 0 && interval.busyShare < quiet.share);
        })) {
          problems.push(`The ${label} ${state} idle measurement has no complete settled window.`);
        }
      }
      const readings = rows.map(windows => windows.length === 1 && Number.isFinite(windows[0].cpuPercentOneLogicalCore) && windows[0].cpuPercentOneLogicalCore >= 0
        ? windows[0].cpuPercentOneLogicalCore : null);
      const cpu = resourceCheck(`${state} idle CPU`, 'percent of one logical core', readings[0], readings[1], margin.percent, resources.cpuPercentagePoints ?? 0);
      if (resources.cpuPercentagePoints === null && cpu.verdict !== 'missing') { cpu.verdict = 'reported'; delete cpu.limit; }
      checks.push(cpu);
      if (resources.idleCpuMax !== null) absoluteChecks.push({ metric: `${state} idle CPU`, unit: 'percent of one logical core', candidate: readings[1],
        limit: resources.idleCpuMax, verdict: Number.isFinite(readings[1]) ? readings[1] <= resources.idleCpuMax ? 'pass' : 'over-budget' : 'missing' });
    }
  }
  if (candidate.settings?.scenario === 'switches') {
    for (const [label, summary] of [['baseline', baseline], ['candidate', candidate]]) {
      if (summary.switchMemory?.length !== summary.settings.runCount || summary.switchMemory.some(memory => !memory.complete)) problems.push(`The ${label} switch memory samples are incomplete.`);
    }
    if (candidate.settings.switches >= 100) {
      const kinds = new Set([baseline, candidate].flatMap(summary => (summary.switchMemory ?? []).flatMap(memory => Object.keys(memory.kinds))));
      for (const kind of kinds) {
        const readings = [baseline, candidate].map(summary => (summary.switchMemory ?? []).map(memory => memory.kinds[kind] ??
          (memory.complete && memory.plateauMeasured ? { churn: false, privateBytes: { lastMedian: 0, lateGrowthBytes: 0, tailSlopeBytesPerSwitch: 0 } } : null)));
        if (readings.some(rows => rows.length !== candidate.settings.runCount || rows.some(row => !row || row.churn || !Number.isFinite(row.privateBytes.lastMedian)))) {
          if (resources.memoryGrowthMaxBytes !== null) problems.push(`The absolute memory-growth budget cannot evaluate ${kind}: incomplete samples or process replacement.`);
          checks.push({ metric: `${kind} late private bytes`, unit: 'bytes', verdict: 'missing' }); continue;
        }
        checks.push(resourceCheck(`${kind} late private bytes`, 'bytes', Math.max(...readings[0].map(row => row.privateBytes.lastMedian)), Math.max(...readings[1].map(row => row.privateBytes.lastMedian)), margin.percent, resources.memoryBytes));
        if (resources.memoryGrowthMaxBytes !== null) {
          const growth = Math.max(...readings[1].map(row => Math.max(0, row.privateBytes.lateGrowthBytes, row.privateBytes.tailSlopeBytesPerSwitch * 20)));
          absoluteChecks.push({ metric: `${kind} late private-byte growth`, unit: 'bytes over 20 switches', candidate: growth,
            limit: resources.memoryGrowthMaxBytes, verdict: growth <= resources.memoryGrowthMaxBytes ? 'pass' : 'over-budget' });
        }
      }
    } else if (resources.memoryGrowthMaxBytes !== null) {
      problems.push('The absolute memory-growth budget requires at least 100 switches per run.');
    }
  }
  for (const kind of ['document', 'dataset']) {
    const before = baseline.collectionAutomations?.[kind] ?? {}, after = candidate.collectionAutomations?.[kind] ?? {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const was = before[name], is = after[name];
      if (!is) { checks.push({ metric: `${kind} ${name}`, verdict: 'missing' }); continue; }
      if (is.failures > 0) problems.push(`The candidate's ${kind} ${name} case failed its checks in ${is.failures} of ${is.runs} runs.`);
      // A receipt without one digest per case cannot say whether the case measured the same work.
      const digests = [was, is].filter(Boolean).map(summary => summary.fixtureSha256);
      if (digests.some(digest => digest.length !== 1)) { problems.push(`The ${kind} ${name} case has no single fixture digest in both receipts.`); continue; }
      const comparable = was !== undefined && was.fixtureSha256[0] === is.fixtureSha256[0];
      cases.push({ kind, name, compared: comparable, outcomes: is.outcomes });
      if (!comparable) continue;
      const settled = check(`${kind} ${name} press to settled`, was.triggerToSettledPaintedMs, is.triggerToSettledPaintedMs,
        { percent: margin.automationPercent, floorMs: margin.floorMs }, 'p50');
      if (settled.verdict === 'pass' || settled.verdict === 'regressed') {
        if (is.contention) settled.verdict = 'reported';
        else if (was.runs < MIN_AUTOMATION_RUNS || is.runs < MIN_AUTOMATION_RUNS) settled.verdict = 'insufficient-runs';
      }
      checks.push(settled);
      if (was.typingDuringRun || is.typingDuringRun) {
        checks.push(check(`${kind} ${name} typing during the run`, was.typingDuringRun?.dispatchToTwoRafObservedMs, is.typingDuringRun?.dispatchToTwoRafObservedMs, margin));
      }
    }
  }
  for (const row of checks) if (row.verdict === 'regressed' || row.verdict === 'missing') problems.push(`${row.metric}: ${row.verdict}`);
  for (const row of absoluteChecks) if (row.verdict !== 'pass') problems.push(`${row.metric}: ${row.verdict}`);
  return { pass: problems.length === 0, margin, resources, absoluteChecks, absoluteBudgetsConfigured: resources.idleCpuMax !== null || resources.memoryGrowthMaxBytes !== null, problems, checks, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const directories = [], margin = { ...DEFAULT_MARGIN }, resources = { ...DEFAULT_RESOURCES };
  for (let index = 0; index < args.length; index++) {
    const resource = { '--cpu-percentage-point-floor': 'cpuPercentagePoints', '--memory-byte-floor': 'memoryBytes', '--idle-cpu-max': 'idleCpuMax', '--memory-growth-max-bytes': 'memoryGrowthMaxBytes' }[args[index]];
    const flag = resource ?? { '--margin-percent': 'percent', '--automation-margin-percent': 'automationPercent', '--floor-ms': 'floorMs' }[args[index]];
    if (!flag) { directories.push(args[index]); continue; }
    const target = resource ? resources : margin;
    target[flag] = Number(args[++index]);
    if (!Number.isFinite(target[flag]) || target[flag] < 0) throw Error(`${args[index - 1]} needs a number of at least 0`);
  }
  if (directories.length !== 2 || directories.some(value => value.startsWith('--'))) {
    throw Error('Usage: node compare-packaged-benchmark.mjs <baseline-directory> <candidate-directory> [--margin-percent 10] [--automation-margin-percent 25] [--floor-ms 17] [--cpu-percentage-point-floor <calibrated percentage points>] [--memory-byte-floor 0] [--idle-cpu-max <percent of one core>] [--memory-growth-max-bytes <bytes>]');
  }
  const [baseline, candidate] = await Promise.all(directories.map(async directory => summarize(JSON.parse(await readFile(join(resolve(directory), 'result.json'), 'utf8')))));
  const comparison = { baseline: resolve(directories[0]), candidate: resolve(directories[1]), ...compareSummaries(baseline, candidate, margin, resources) };
  await writeFile(join(resolve(directories[1]), 'comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(JSON.stringify(comparison, null, 2));
  if (!comparison.pass) process.exitCode = 1;
}
