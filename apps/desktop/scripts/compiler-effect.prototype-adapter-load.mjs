// Isolated production-adapter import cost in Electron's own Node runtime.
// This excludes dohc startup and the UI action that lazily loads the adapter.
import electron from 'electron';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const evidence = process.argv[2];
const results = [];
for (let pair = 0; pair < 12; pair++) {
  for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const adapterUrl = pathToFileURL(join(evidence, `${variant}-adapter.prototype.mjs`));
    const script = `const beforeHeap=process.memoryUsage().heapUsed;const before=performance.now();await import(${JSON.stringify(adapterUrl.href)});console.log(JSON.stringify({milliseconds:performance.now()-before,heapDeltaBytes:process.memoryUsage().heapUsed-beforeHeap,node:process.version,electron:process.versions.electron}));`;
    const value = JSON.parse(execFileSync(electron, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }));
    results.push({ pair, variant, ...value });
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { executable: electron, executableSha256: createHash('sha256').update(await readFile(electron)).digest('hex'), results, medians: Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, { milliseconds: median(results.filter(x => x.variant === variant).map(x => x.milliseconds)), heapDeltaBytes: median(results.filter(x => x.variant === variant).map(x => x.heapDeltaBytes)) }])) };
await writeFile(join(evidence, 'adapter-import-measurements.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ executable: report.executable, node: results[0].node, electron: results[0].electron, medians: report.medians }, null, 2));
