import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { stageAppBackendRuntime, requireAppBackendRuntime } from './stage-app-backend-runtime.mjs';
import { createInstalledDatasetCompiler } from '../src/workspaces/installedDatasetCompiler.ts';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { getFileMatchers, copyFiles } = builderRequire('app-builder-lib/out/fileMatcher.js');

test('packaging preserves the relocated child and Wasm closure and rejects resource drift', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dohc-app-runtime-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await stageAppBackendRuntime({ destination: join(source, 'resources/app-backend-runtime') });
  const config = load(await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
  const extraResources = config.extraResources.filter(entry => entry.from.startsWith('resources/app-backend-runtime'));
  const resources = join(root, 'package/resources');
  await copyFiles(getFileMatchers({ extraResources }, 'extraResources', resources, {
    defaultSrc: source, globalOutDir: resources, customBuildOptions: {}, macroExpander: value => value,
  }));
  await rm(source, { recursive: true, force: true });
  const staged = join(resources, 'app-backend-runtime');
  await requireAppBackendRuntime(staged);
  if (process.platform === 'win32' && process.arch === 'x64') {
    const binaryDirectory = join(resources, 'app-compiler/node_modules/@esbuild/win32-x64');
    await mkdir(binaryDirectory, { recursive: true });
    const compilerRequire = createRequire(require.resolve('esbuild'));
    await cp(compilerRequire.resolve('@esbuild/win32-x64/esbuild.exe'), join(binaryDirectory, 'esbuild.exe'));
    const compile = await createInstalledDatasetCompiler(resources);
    const source = 'type Value=number;globalThis.operations={read(){const value:Value=42;return {value};}};';
    assert.match(await compile(source, 'data/operations.ts', new AbortController().signal), /value = 42/);
  }
  const compilerBytes = await readFile(join(staged, 'dataset-compiler.mjs'));
  await rm(join(staged, 'dataset-compiler.mjs'));
  await assert.rejects(requireAppBackendRuntime(staged), /resources changed/);
  await writeFile(join(staged, 'dataset-compiler.mjs'), compilerBytes);
  await cp(new URL('../../../packages/app-backend-runtime/dist/index.mjs', import.meta.url), join(root, 'client.mjs'));
  const { createAppBackendRuntime } = await import(pathToFileURL(join(root, 'client.mjs')).href);
  const runtime = createAppBackendRuntime({ entryPath: join(staged, 'child.mjs') });
  const tables = ['items'], schemaSql = 'CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);';
  const database = await runtime.initializeAppDatabase({ tables, schemaSql });
  const result = await runtime.evaluateAppOperation({ database, tables, caller: { kind: 'owner' }, operation: 'insert',
    source: `globalThis.operations={insert(ctx){ctx.db.execute('INSERT INTO items VALUES (?, ?)', [ctx.requestId, 42]);return ctx.db.query('SELECT * FROM items');}}`,
    input: {}, requestId: 'relocated', nowMs: 1 });
  assert.deepEqual(result.result, [{ id: 'relocated', value: 42 }]);
  assert.ok(result.changeset.byteLength);
  await cp(new URL('../../../packages/app-backend-runtime/dist/persistent.mjs', import.meta.url), join(root, 'persistent-client.mjs'));
  const { openPersistentAppBackend } = await import(pathToFileURL(join(root, 'persistent-client.mjs')).href);
  const directory = join(root, 'worker');
  await mkdir(directory);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const cursor = { revision: 0, digest: hash('initial') };
  const worker = await openPersistentAppBackend({ directory, tables, schemaSql, cursor,
    scope: { workspaceId: 'workspace', datasetId: 'dataset', hostEpoch: 'epoch', approvedRevisionHash: hash(schemaSql) } },
    { entryPath: join(staged, 'persistent-child.mjs') });
  try {
    const input = { expected: cursor, caller: { kind: 'owner' }, operation: 'insert',
      source: `globalThis.operations={insert(ctx){ctx.db.execute('INSERT INTO items VALUES (?, ?)', [ctx.requestId, 42]);return ctx.db.query('SELECT * FROM items');}}`,
      input: {}, requestId: 'persistent-relocated', nowMs: 1 };
    const prepared = await worker.prepare(input);
    const next = await worker.finalize({ proposalId: prepared.proposalId, previousDigest: cursor.digest,
      revision: 1, digest: hash('event'), changesetSha256: prepared.changesetSha256 });
    const read = await worker.prepare({ ...input, expected: next, readOnly: true,
      source: `globalThis.operations={insert(ctx){return ctx.db.query('SELECT * FROM items');}}` });
    assert.deepEqual(read.result, [{ id: 'persistent-relocated', value: 42 }]);
  } finally { await worker.close(); }
  const persistentChild = await readFile(join(staged, 'persistent-child.mjs'));
  await writeFile(join(staged, 'persistent-child.mjs'), '// changed');
  await assert.rejects(requireAppBackendRuntime(staged), /resources changed/);
  await writeFile(join(staged, 'persistent-child.mjs'), persistentChild);
  const child = await readFile(join(staged, 'child.mjs'));
  await writeFile(join(staged, 'child.mjs'), '// changed');
  await assert.rejects(requireAppBackendRuntime(staged), /resources changed/);
  await writeFile(join(staged, 'child.mjs'), child);
  const manifest = JSON.parse(await readFile(join(staged, 'manifest.json'), 'utf8'));
  const wasm = Object.keys(manifest.files).find(path => path.endsWith('.wasm'));
  await rm(join(staged, wasm));
  await assert.rejects(requireAppBackendRuntime(staged), /resources changed/);
});
