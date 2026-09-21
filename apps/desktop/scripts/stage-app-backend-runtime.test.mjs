import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { stageAppBackendRuntime, requireAppBackendRuntime } from './stage-app-backend-runtime.mjs';

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
  const child = await readFile(join(staged, 'child.mjs'));
  await writeFile(join(staged, 'child.mjs'), '// changed');
  await assert.rejects(requireAppBackendRuntime(staged), /resources changed/);
  await writeFile(join(staged, 'child.mjs'), child);
  const manifest = JSON.parse(await readFile(join(staged, 'manifest.json'), 'utf8'));
  const wasm = Object.keys(manifest.files).find(path => path.endsWith('.wasm'));
  await rm(join(staged, wasm));
  await assert.rejects(requireAppBackendRuntime(staged), /resources changed/);
});
