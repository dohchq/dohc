import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { acquireVerificationSlot } from '../rust-engine-program/build-slot.mjs';
import { run, pnpm } from '../../scripts/verification/process.mjs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const help = 'Usage: node tools/perf-profiling/live-authorship-sync.mjs --baseline-source <v1-journal.ts> [--output <directory>] [--updates 10000] [--warmup-updates 200] [--pairs 1] [--profile true]\nMeasures relay admission and its SQLite transaction. Ordered validation runs outside timing.';
if (args.includes('--help')) { console.log(help); process.exit(0); }
const values = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--baseline-source', '--output', '--updates', '--warmup-updates', '--pairs', '--profile'].includes(args[index]) || !args[index + 1]) throw Error(help);
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
const profile = values['--profile'] === 'true';
if (values['--profile'] !== undefined && !profile) throw Error('--profile accepts true');
const settings = { updates, warmupUpdates, pairs, profile, resultPath: resolve(output, 'result.json'), sources };
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
await writeFile(configPath, `${profile ? `import { admissionProfilePlugin } from ${JSON.stringify(localImport(resolve(root, 'tools/perf-profiling/live-authorship-profile.mjs')))};\n` : ''}export default { ${profile ? 'plugins: [admissionProfilePlugin()],' : ''}root: ${JSON.stringify(root)}, resolve: { alias: { yjs: ${JSON.stringify(yjsModule)} } }, test: { include: [${JSON.stringify(slash(relative(root, testPath)))}], fileParallelism: false, maxWorkers: 1 } };\n`);
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const startedAt = new Date().toISOString();
let lane;
await writeFile(resolve(output, 'process.json'), JSON.stringify({ ownerPid: process.pid, startedAt, state: 'queued', settings }, null, 2) + '\n');
try {
  lane = await acquireVerificationSlot();
  await run(...pnpm(['--filter', '@dohc/app-backend-runtime', 'build']), { cwd: root, log: resolve(output, 'runtime-build.log'), timeoutMs: 300000,
    onSpawn(child) { writeFileSync(resolve(output, 'runtime-build-process.json'), JSON.stringify({ pid: child.pid, ownerPid: process.pid, startedAt, output: 'packages/app-backend-runtime/dist' }, null, 2) + '\n'); } });
  if (sha(await readFile(journalPath)) !== sources.currentSha256 || sha(await readFile(resolve(root, 'tools/perf-profiling/live-authorship-sync.bench.ts'))) !== sources.harnessSha256)
    throw Error('Benchmark source changed while waiting for the verification slot. Restart the command.');
  await run(process.execPath, [vitest, 'run', '--config', configPath], { cwd: root, log: resolve(output, 'benchmark.log'), timeoutMs: runDeadlineMs,
    onSpawn(child) {
      writeFileSync(resolve(output, 'process.json'), JSON.stringify({ ownerPid: process.pid, pid: child.pid, startedAt, state: 'running',
        slot: lane?.name ?? null, executable: process.execPath, args: [vitest, 'run', '--config', configPath], settings }, null, 2) + '\n');
    } });
  if (sha(await readFile(journalPath)) !== sources.currentSha256 || sha(await readFile(resolve(root, 'tools/perf-profiling/live-authorship-sync.bench.ts'))) !== sources.harnessSha256)
    throw Error('Benchmark source changed during the measured run.');
  console.log('Evidence: ' + resolve(output, 'result.json'));
} catch (error) {
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ status: 'failed', startedAt, settings, error: String(error) }, null, 2) + '\n');
  throw error;
} finally {
  lane?.release();
  await Promise.all([runtimePath, testPath, configPath].map(path => rm(path, { force: true })));
}
