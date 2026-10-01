// Throwaway paired Windows measurements; source import timing is not app startup.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const baseline = new URL('../src/workspaces/compilerProcessSupervisor.prototype-baseline.ts', import.meta.url);
const candidate = new URL('../src/workspaces/compilerProcessSupervisor.ts', import.meta.url);
const evidence = process.argv[2];
if (!evidence) throw new Error('Supply the evidence directory.');
const directory = await mkdtemp(join(tmpdir(), 'dohc-effect-compiler-measure-'));
const bounds = { timeoutMs: 20000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 4096, maxOutputBytes: 4096, maxErrorBytes: 8192 };
const results = { node: process.version, platform: process.platform, bounds, pairedRoundtrip: [], freshSourceImport: [], bundles: {} };
try {
  const workerPath = join(directory, 'worker.mjs');
  await writeFile(workerPath, "for await(const chunk of process.stdin)process.stdout.write(chunk);");
  const modules = { baseline: await import(baseline.href), candidate: await import(candidate.href) };
  for (let pair = 0; pair < 8; pair++) {
    for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const started = performance.now();
      const output = await modules[variant].runOwnedCompilerProcess({ nodeExecutable: process.execPath, workerPath }, { input: Buffer.from('paired compiler input'), bounds });
      if (Buffer.from(output.stdout).toString() !== 'paired compiler input') throw new Error('Roundtrip mismatch.');
      results.pairedRoundtrip.push({ pair, variant, milliseconds: performance.now() - started });
    }
  }
  for (let pair = 0; pair < 8; pair++) {
    for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const moduleUrl = variant === 'candidate' ? candidate : baseline;
      const script = `const before=performance.now();await import(${JSON.stringify(moduleUrl.href)});console.log(JSON.stringify({milliseconds:performance.now()-before,heapBytes:process.memoryUsage().heapUsed}));`;
      const value = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true }));
      results.freshSourceImport.push({ pair, variant, ...value });
    }
  }
  for (const variant of ['baseline', 'candidate']) {
    const output = fileURLToPath(new URL(`../../../.agent-artifacts/effect-compiler/bundles/${variant}`, import.meta.url));
    const files = [];
    for (const name of await readdir(output)) {
      if (!name.endsWith('.js')) continue;
      const bytes = await readFile(join(output, name));
      files.push({ name, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length, brotliBytes: brotliCompressSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    results.bundles[variant] = { files, rawBytes: files.reduce((sum, f) => sum + f.rawBytes, 0), gzipBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0), brotliBytes: files.reduce((sum, f) => sum + f.brotliBytes, 0) };
  }
  for (const variant of ['baseline', 'candidate']) {
    const source = await readFile(variant === 'candidate' ? candidate : baseline, 'utf8');
    results[`${variant}Source`] = { lines: source.trimEnd().split('\n').length, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') };
  }
  await writeFile(join(evidence, 'measurements.json'), JSON.stringify(results, null, 2));
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ bundles: Object.fromEntries(Object.entries(results.bundles).map(([k, { files, ...totals }]) => [k, totals])), roundtripMedianMs: Object.fromEntries(['baseline', 'candidate'].map(v => [v, median(results.pairedRoundtrip.filter(x => x.variant === v && x.pair > 0).map(x => x.milliseconds))])), importMedianMs: Object.fromEntries(['baseline', 'candidate'].map(v => [v, median(results.freshSourceImport.filter(x => x.variant === v).map(x => x.milliseconds))])), baselineSource: results.baselineSource, candidateSource: results.candidateSource }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
