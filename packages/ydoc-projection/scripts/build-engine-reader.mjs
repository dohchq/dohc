import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parse} from '@babel/parser';
import {build} from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const forbidden = new Set(['net', 'http', 'https', 'dns', 'child_process', 'worker_threads']);
const moduleName = specifier => specifier.replace(/^node:/, '').split('/')[0];
function checkSpecifier(specifier) {
  if (forbidden.has(moduleName(specifier))) throw new Error(`Reader import refused: ${specifier}`);
}

/** Inspect the final bundle too: a computed import cannot evade the resolver check. */
export function checkReaderBundle(code) {
  const ast = parse(code, {sourceType: 'unambiguous', createImportExpressions: true});
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    let source;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration'
      || node.type === 'ExportNamedDeclaration' || node.type === 'ImportExpression') source = node.source;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && ['require', '__require'].includes(node.callee.name)) source = node.arguments[0];
    if (source) {
      if (source.type !== 'StringLiteral') throw new Error('Computed reader imports are refused.');
      checkSpecifier(source.value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
}

/** Fixed entry point; destination belongs to preparation/tests, never to a document. */
export async function buildEngineReader(destination = join(packageRoot, 'dist/engine-reader')) {
  if (process.versions.node !== '24.16.0') throw new Error('Reader preparation requires pinned Node 24.16.0.');
  const result = await build({
    absWorkingDir: repoRoot, entryPoints: [join(packageRoot, 'src/engine-markdown-reader.ts')],
    outfile: 'reader.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs',
    write: false, metafile: true, logLevel: 'silent',
    plugins: [{name: 'fixed-reader-imports', setup(build) {
      build.onResolve({filter: /.*/}, args => {checkSpecifier(args.path); return undefined;});
    }}],
  });
  const output = result.outputFiles[0];
  checkReaderBundle(output.text);
  const sources = [];
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    sources.push({path: name.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(repoRoot, name)))});
  }
  const sourceHash = name => sources.find(source => source.path === `packages/ydoc-projection/src/${name}`)?.sha256;
  const identity = {
    version: 1, bundleSha256: hash(output.contents), sourcesSha256: hash(JSON.stringify(sources)),
    importerSha256: sourceHash('import-export.ts'), schemaSha256: sourceHash('dohc-markdown-extensions.ts'),
    lockSha256: hash(await readFile(join(repoRoot, 'pnpm-lock.yaml'))),
    runtime: {version: process.versions.node, platform: process.platform, arch: process.arch,
      sha256: hash(await readFile(process.execPath))},
  };
  const manifest = {...identity, buildSha256: hash(JSON.stringify(identity)), sources};
  await mkdir(destination, {recursive: true});
  await writeFile(join(destination, 'reader.cjs'), output.contents);
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = await buildEngineReader(process.argv[2] && resolve(process.argv[2]));
  console.log(JSON.stringify({buildSha256: manifest.buildSha256, bundleSha256: manifest.bundleSha256,
    destination: relative(repoRoot, process.argv[2] ?? join(packageRoot, 'dist/engine-reader'))}));
}
