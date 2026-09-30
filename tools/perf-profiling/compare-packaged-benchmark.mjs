import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize } from './summarize-packaged-benchmark.mjs';

// Compares a candidate package's receipt with a baseline's from the same host and harness, and fails
// on a regression. A p95 regresses when it exceeds the baseline's p95 by more than 10%, or by more than
// 17 ms when 10% is smaller. The floor is one 60 Hz frame: every renderer timing here ends at an
// animation-frame callback, so a smaller difference is within frame quantization. 10% is a starting
// point until baseline-against-baseline runs measure the host's own spread; with three runs, p95 is the
// slowest run, so one slow run on a busy host can exceed it. Pass --margin-percent and --floor-ms to
// change both; the comparison records the margin it used.
export const DEFAULT_MARGIN = { percent: 10, floorMs: 17 };

// Settings that change what a receipt measures. The limits may differ: they decide which cases are
// comparable, through each case's fixture digest.
const COMPARED_SETTINGS = ['scenario', 'runCount', 'keystrokes', 'fixtureFiles', 'records', 'idleSeconds', 'switches', 'profileRenderer', 'profileMain'];

function check(metric, baseline, candidate, margin) {
  const row = { metric, baselineP95: baseline?.p95 ?? null, candidateP95: candidate?.p95 ?? null };
  if (!baseline?.count && !candidate?.count) return { ...row, verdict: 'unmeasured' };
  if (!candidate?.count) return { ...row, verdict: 'missing' };
  if (!baseline?.count) return { ...row, verdict: 'new' };
  const limit = baseline.p95 + Math.max(baseline.p95 * margin.percent / 100, margin.floorMs);
  return { ...row, limit, verdict: candidate.p95 > limit ? 'regressed' : 'pass' };
}

/**
 * The checks between two summaries, and whether the candidate passes. A regressed or missing
 * measurement fails, and so does a candidate case that failed its own checks. A case whose fixture
 * differs between the receipts, such as a Find at a different cap, is checked only within the
 * candidate. Unmeasured and new measurements neither pass nor fail the comparison.
 */
export function compareSummaries(baseline, candidate, margin = DEFAULT_MARGIN) {
  const problems = [];
  for (const [label, summary] of [['baseline', baseline], ['candidate', candidate]]) {
    if (summary.status !== 'complete') problems.push(`The ${label} receipt is ${summary.status}, not complete.`);
  }
  for (const key of COMPARED_SETTINGS) {
    if (JSON.stringify(baseline.settings?.[key]) !== JSON.stringify(candidate.settings?.[key])) problems.push(`The receipts differ in ${key}.`);
  }
  if (baseline.diagnostic || candidate.diagnostic) problems.push('A profiled receipt cannot serve as a performance comparison.');
  const checks = [];
  if (baseline.collection || candidate.collection) checks.push(check('collection open to rows painted', baseline.collection?.openToRowsPaintedMs, candidate.collection?.openToRowsPaintedMs, margin));
  for (const name of Object.keys(candidate.typing ?? {})) {
    checks.push(check(`typing ${name} dispatch to two frames`, baseline.typing?.[name]?.dispatchToTwoRafObservedMs, candidate.typing[name].dispatchToTwoRafObservedMs, margin));
  }
  const cases = [];
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
      checks.push(check(`${kind} ${name} press to settled`, was.triggerToSettledPaintedMs, is.triggerToSettledPaintedMs, margin));
      if (was.typingDuringRun || is.typingDuringRun) {
        checks.push(check(`${kind} ${name} typing during the run`, was.typingDuringRun?.dispatchToTwoRafObservedMs, is.typingDuringRun?.dispatchToTwoRafObservedMs, margin));
      }
    }
  }
  for (const row of checks) if (row.verdict === 'regressed' || row.verdict === 'missing') problems.push(`${row.metric}: ${row.verdict}`);
  return { pass: problems.length === 0, margin, problems, checks, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const directories = [], margin = { ...DEFAULT_MARGIN };
  for (let index = 0; index < args.length; index++) {
    const flag = { '--margin-percent': 'percent', '--floor-ms': 'floorMs' }[args[index]];
    if (!flag) { directories.push(args[index]); continue; }
    margin[flag] = Number(args[++index]);
    if (!Number.isFinite(margin[flag]) || margin[flag] < 0) throw Error(`${args[index - 1]} needs a number of at least 0`);
  }
  if (directories.length !== 2 || directories.some(value => value.startsWith('--'))) {
    throw Error('Usage: node compare-packaged-benchmark.mjs <baseline-directory> <candidate-directory> [--margin-percent 10] [--floor-ms 17]');
  }
  const [baseline, candidate] = await Promise.all(directories.map(async directory => summarize(JSON.parse(await readFile(join(resolve(directory), 'result.json'), 'utf8')))));
  const comparison = { baseline: resolve(directories[0]), candidate: resolve(directories[1]), ...compareSummaries(baseline, candidate, margin) };
  await writeFile(join(resolve(directories[1]), 'comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(JSON.stringify(comparison, null, 2));
  if (!comparison.pass) process.exitCode = 1;
}
