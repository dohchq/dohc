import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePresence, comparePresence } from './packaged-presence.mjs';
import { compareSummaries } from './compare-packaged-benchmark.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';
import { parseOptions } from './packaged-benchmark-options.mjs';
const settings = { scenario: 'presence', runCount: 5, keystrokes: 3, presencePeers: 2 };
const task = (name, value) => ({ name, mode: 'rich', supported: true, samples: [value, value, value].map(inputToNextPaintMs => ({ inputToNextPaintMs })), longTasks: [], workload: { pass: true, peers: 2 } });
const receipt = values => ({ status: 'complete', settings, runs: values.map((value, index) => ({ index: index + 1, presence: Object.fromEntries(['solo', 'peers'].map(arm => [arm, ['small.md', 'large.md'].map(name => task(name, value))])) })) });
const compare = (before, after) => comparePresence(summarizePresence(before.runs), summarizePresence(after.runs), settings);

test('presence defaults to five runs and requires two to eight peers', () => {
  const args = ['--binary', 'app.exe', '--package-commit', 'a'.repeat(40), '--output', 'out', '--label', 'baseline', '--scenario', 'presence'];
  assert.equal(parseOptions(args).runCount, 5);
  assert.equal(parseOptions(args).presencePeers, 2);
  assert.equal(parseOptions([...args, '--presence-peers', '4']).presencePeers, 4);
  assert.throws(() => parseOptions([...args, '--runs', '4']), /at least 5/);
  for (const peers of ['1', '9']) assert.throws(() => parseOptions([...args, '--presence-peers', peers]));
  assert.throws(() => parseOptions([...args.slice(0, -2), '--presence-peers', '2']), /requires --scenario presence/);
});

test('each run pools its keystrokes before percentiles are compared', () => {
  const data = receipt([16, 16, 24, 32, 40]);
  data.runs[0].presence.solo[0].samples = [8, 16, 80].map(inputToNextPaintMs => ({ inputToNextPaintMs }));
  const rows = summarizePresence(data.runs).solo['small.md'];
  assert.equal(rows[0].p50, 16); assert.equal(rows[0].p95, 80);
  assert.equal(rows.length, 5); assert.equal(rows[0].count, 3);
});

test('the two millisecond spread floor includes the boundary and rejects growth beyond it', () => {
  const before = receipt([16, 16, 16, 16, 16]);
  const at = compare(before, receipt([18, 18, 18, 18, 18]));
  assert.equal(at.pass, true); assert.equal(at.checks.length, 8);
  assert.ok(at.checks.every(row => row.allowanceMs === 2 && row.limitMs === 18));
  assert.equal(compare(before, receipt([18.01, 18.01, 18.01, 18.01, 18.01])).pass, false);
});

test('spread is capped at eight milliseconds', () => {
  const before = receipt([8, 16, 16, 24, 40]);
  const at = compare(before, receipt([24, 24, 24, 24, 24]));
  assert.equal(at.pass, true); assert.ok(at.checks.every(row => row.spreadMs === 32 && row.allowanceMs === 8));
  assert.equal(compare(before, receipt([24.01, 24.01, 24.01, 24.01, 24.01])).pass, false);
});

test('comparison uses the median of run percentiles rather than the worst run', () => {
  const result = compare(receipt([16, 17, 18, 19, 20]), receipt([18, 19, 20, 21, 200]));
  assert.equal(result.pass, true);
  assert.ok(result.checks.every(row => row.baselineMedianMs === 18 && row.candidateMedianMs === 20 && row.allowanceMs === 4));
});

for (const arm of ['solo', 'peers']) test(arm + ' p95 gates independently of p50', () => {
  const after = receipt([16, 16, 16, 16, 16]);
  for (const run of after.runs) run.presence[arm][1].samples[2].inputToNextPaintMs = 32;
  const result = compare(receipt([16, 16, 16, 16, 16]), after);
  assert.equal(result.pass, false);
  assert.equal(result.checks.find(row => row.metric === 'presence ' + arm + ' large.md p50').verdict, 'pass');
  assert.equal(result.checks.find(row => row.metric === 'presence ' + arm + ' large.md p95').verdict, 'regressed');
});

for (const side of ['baseline', 'candidate']) test('a long task in ' + side + ' fails the comparison', () => {
  const before = receipt([16, 16, 16, 16, 16]), after = receipt([16, 16, 16, 16, 16]);
  (side === 'baseline' ? before : after).runs[2].presence.solo[0].longTasks.push({ duration: 51 });
  const result = compare(before, after);
  assert.equal(result.pass, false); assert.match(result.problems.join(' '), /long tasks/);
});

for (const side of ['baseline', 'candidate']) test('fewer than five ' + side + ' runs refuses a timing verdict', () => {
  const before = receipt([16, 16, 16, 16, 16]), after = receipt([16, 16, 16, 16, 16]);
  (side === 'baseline' ? before : after).runs.pop();
  const result = compare(before, after);
  assert.equal(result.pass, false); assert.ok(result.checks.every(row => row.verdict === 'invalid'));
  assert.match(result.problems.join(' '), /at least 5/);
});

for (const change of [
  row => row.presence.peers.pop(),
  row => row.presence.peers[0].workload.pass = false,
  row => row.presence.peers[0].samples[0].inputToNextPaintMs = null,
  row => row.presence.solo[0].mode = 'source',
]) test('incomplete measurements and peer workloads fail closed', () => {
  const after = receipt([16, 16, 16, 16, 16]); change(after.runs[0]);
  assert.equal(compare(receipt([16, 16, 16, 16, 16]), after).pass, false);
});

test('the existing summarizer and comparator route presence through the fixed rule', async () => {
  const before = await summarize(receipt([16, 16, 16, 16, 16]));
  const after = await summarize(receipt([19, 19, 19, 19, 19]));
  assert.equal(compareSummaries(before, after, { floorMs: 1000 }).pass, false);
  assert.equal(compareSummaries(before, before).pass, true);
  after.settings = { ...settings, presencePeers: 3 };
  assert.equal(compareSummaries(before, after).pass, false);
});
