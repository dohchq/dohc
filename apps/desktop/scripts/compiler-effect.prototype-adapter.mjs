// Use the exact production adapter build options from stage-app-compiler.mjs.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.argv[2];
const variants = {};
for (const variant of ['baseline', 'candidate']) {
  const output = join(evidence, `${variant}-adapter.prototype.mjs`);
  await build({
    entryPoints: [join(sourceRoot, 'src/workspaces/closedAppCompilerProcess.ts')],
    outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['esbuild'], logLevel: 'silent',
    ...(variant === 'baseline' ? { plugins: [{ name: 'prototype-baseline', setup(builder) {
      builder.onResolve({ filter: /\/compilerProcessSupervisor\.ts$/ }, () => ({ path: join(sourceRoot, 'src/workspaces/compilerProcessSupervisor.prototype-baseline.ts') }));
    } }] } : {}),
  });
  const bytes = await readFile(output);
  variants[variant] = { rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(join(evidence, 'adapter-bundle-measurements.json'), JSON.stringify(variants, null, 2));
console.log(JSON.stringify(variants, null, 2));
