import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { acquireProfilingSlot } from './admission.mjs';
import { run, pnpm } from '../../scripts/verification/process.mjs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const help = 'Usage: node tools/perf-profiling/live-authorship-sync.mjs --baseline-source <v1-journal.ts> [--output <directory>] [--updates 10000] [--warmup-updates 200] [--pairs 1]\nMeasures relay admission and its SQLite transaction. Ordered validation runs outside timing.';
if (args.includes('--help')) { console.log(help); process.exit(0); }
const values = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--baseline-source', '--output', '--updates', '--warmup-updates', '--pairs'].includes(args[index]) || !args[index + 1]) throw Error(help);
  if (Object.hasOwn(values, args[index])) throw Error('Duplicate argument ' + args[index]);
  values[args[index]] = args[index + 1];
}
if (!values['--baseline-source']) throw Error(help);
const integer = (key, fallback, minimum) => {
  const value = values[key] === undefined ? fallback : Number(values[key]);
  if (!Number.isSafeInteger(value) || value < minimum) throw Error('Invalid ' + key);
  return value;
};
const updates = integer('--updates', 10000, 1), warmupUpdates = integer('--warmup-updates', 200, 0), pairs = integer('--pairs', 1, 1);
const baselineSource = resolve(root, values['--baseline-source']);
const output = resolve(root, values['--output'] ?? '.agent-artifacts/live-authorship-admission-' + Date.now());
await mkdir(output, { recursive: false });
const slash = path => path.replaceAll('\\', '/');
const localImport = target => { const path = slash(relative(output, target)); return path.startsWith('.') ? path : './' + path; };
const journalPath = resolve(root, 'services/sync-relay/src/storage/liveUpdateJournal.ts');
const require = createRequire(resolve(root, 'services/sync-relay/package.json'));
const baseline = await readFile(baselineSource, 'utf8');
const rewritten = baseline.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (_match, start, target, end) =>
  start + localImport(resolve(dirname(journalPath), target)) + end)
  .replace(/(from\s+["'])(@dohc\/[^"']+)(["'])/g, (_match, start, target, end) =>
    start + localImport(require.resolve(target)) + end);
const sha = source => createHash('sha256').update(source).digest('hex');
const sources = { baselineSha256: sha(baseline), baselineRuntimeSha256: sha(rewritten), currentSha256: sha(await readFile(journalPath)),
  harnessSha256: sha(await readFile(resolve(root, 'tools/perf-profiling/live-authorship-sync.bench.ts'))), baselineSource: slash(relative(root, baselineSource)),
  readRevisionSha256: sha(await readFile(resolve(root, 'services/sync-relay/src/storage/readRevision.ts'))) };
const settings = { updates, warmupUpdates, pairs, resultPath: resolve(output, 'result.json'), sources };
const runDeadlineMs = Math.max(7200000, pairs * 7200000);
const runtimePath = resolve(output, 'baseline.runtime.ts'), testPath = resolve(output, 'admission.test.ts'), configPath = resolve(output, 'vitest.config.mjs');
await writeFile(runtimePath, rewritten);
await writeFile(testPath, `import { it } from 'vitest';
import { runAdmissionBenchmark, type JournalAdapter } from ${JSON.stringify(localImport(resolve(root, 'tools/perf-profiling/live-authorship-sync.bench.ts')))};
import * as before from './baseline.runtime.ts';
import * as after from ${JSON.stringify(localImport(journalPath))};
it('measures paired relay admission', async () => {
  await runAdmissionBenchmark(${JSON.stringify(settings)}, {
    before: { commit: before.commitLiveUpdateJournal, read: before.readLiveUpdateJournalCut } as JournalAdapter,
    after: { commit: after.commitLiveUpdateJournal, read: after.readLiveUpdateJournalCut },
  });
}, ${runDeadlineMs});
`);
const yjsModule = require.resolve('yjs').replace(/yjs\.cjs$/, 'yjs.mjs');
await writeFile(configPath, `export default { root: ${JSON.stringify(root)}, resolve: { alias: { yjs: ${JSON.stringify(yjsModule)} } }, test: { include: [${JSON.stringify(slash(relative(root, testPath)))}], fileParallelism: false, maxWorkers: 1 } };\n`);
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const startedAt = new Date().toISOString();
let lane;
await writeFile(resolve(output, 'process.json'), JSON.stringify({ ownerPid: process.pid, startedAt, state: 'admitting', settings }, null, 2) + '\n');
try {
  lane = acquireProfilingSlot(process.env, { metadata: { purpose: 'live authorship admission benchmark', checkout: root, phase: 'runtime build' } });
  await run(...pnpm(['--filter', '@dohc/app-backend-runtime', 'build']), { cwd: root, log: resolve(output, 'runtime-build.log'), timeoutMs: 300000, signal: lane.signal,
    onSpawn(child) { writeFileSync(resolve(output, 'runtime-build-process.json'), JSON.stringify({ pid: child.pid, ownerPid: process.pid, startedAt, output: 'packages/app-backend-runtime/dist' }, null, 2) + '\n'); } });
  if (sha(await readFile(journalPath)) !== sources.currentSha256 || sha(await readFile(resolve(root, 'tools/perf-profiling/live-authorship-sync.bench.ts'))) !== sources.harnessSha256)
    throw Error('Benchmark source changed during preparation. Restart the command.');
  lane.check();
  lane.update({ phase: 'measurement' });
  await run(process.execPath, [vitest, 'run', '--config', configPath], { cwd: root, log: resolve(output, 'benchmark.log'), timeoutMs: runDeadlineMs, signal: lane.signal,
    onSpawn(child) {
      writeFileSync(resolve(output, 'process.json'), JSON.stringify({ ownerPid: process.pid, pid: child.pid, startedAt, state: 'running',
        slot: lane?.name ?? null, executable: process.execPath, args: [vitest, 'run', '--config', configPath], settings }, null, 2) + '\n');
    } });
  if (sha(await readFile(journalPath)) !== sources.currentSha256 || sha(await readFile(resolve(root, 'tools/perf-profiling/live-authorship-sync.bench.ts'))) !== sources.harnessSha256)
    throw Error('Benchmark source changed during the measured run.');
  lane.check();
  const result = JSON.parse(await readFile(settings.resultPath, 'utf8'));
  await writeFile(settings.resultPath, JSON.stringify({ ...result, hostContext: lane.evidence }, null, 2) + '\n');
  console.log('Evidence: ' + resolve(output, 'result.json'));
} catch (error) {
  const failure = lane?.signal.reason ?? error;
  let measurements = {};
  try { measurements = JSON.parse(await readFile(settings.resultPath, 'utf8')); }
  catch (readError) { if (!(readError instanceof SyntaxError) && readError.code !== 'ENOENT') throw readError; }
  await writeFile(settings.resultPath, JSON.stringify({ ...measurements, status: 'failed', startedAt, settings,
    error: String(failure), hostContext: lane?.evidence ?? error.hostContext }, null, 2) + '\n');
  throw failure;
} finally {
  lane?.release();
  await Promise.all([
    ...(lane ? [writeFile(resolve(output, 'host-context.json'), JSON.stringify(lane.evidence, null, 2) + '\n')] : []),
    ...[runtimePath, testPath, configPath].map(path => rm(path, { force: true })),
  ]);
}
