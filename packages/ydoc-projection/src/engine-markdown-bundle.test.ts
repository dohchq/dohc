import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {expect, it} from 'vitest'
import {buildEngineReader, checkReaderBundle} from '../scripts/build-engine-reader.mjs'
import * as Y from 'yjs'
import {markdownToYDoc} from './import-export.js'

it.each(['net', 'http', 'https', 'dns', 'child_process', 'worker_threads', 'http2', 'tls', 'dgram', 'cluster', 'inspector', 'module', 'vm', 'wasi', 'fs', 'os'])(
  'rejects direct, node and subpath imports of %s', name => {
    for (const specifier of [name, `node:${name}`, `node:${name}/promises`]) {
      expect(() => checkReaderBundle(`import ${JSON.stringify(specifier)}`)).toThrow('Reader import refused')
      expect(() => checkReaderBundle(`require(${JSON.stringify(specifier)})`)).toThrow('Reader import refused')
      expect(() => checkReaderBundle(`import(${JSON.stringify(specifier)})`)).toThrow('Reader import refused')
    }
  },
)
it('rejects computed imports', () => {
  expect(() => checkReaderBundle('import(variable)')).toThrow('Computed reader imports')
  expect(() => checkReaderBundle('require(variable)')).toThrow('Computed reader imports')
})
it('builds a complete fixed bundle with reproducible source/runtime identity', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'dohc-reader-'))
  try {
    const manifest = await buildEngineReader(destination)
    const code = await readFile(join(destination, 'reader.cjs'))
    expect(code.toString().split('\n')[0]).toBe('"use strict";')
    expect(checkReaderBundle(code.toString())).toEqual(['node:crypto'])
    expect(manifest.bundleSha256).toBe(createHash('sha256').update(code).digest('hex'))
    expect(manifest.importerSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.schemaSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.runtime.unicode).toBe(process.versions.unicode)
    expect(manifest.runtime.icu).toBe(process.versions.icu)
    expect(manifest.runtime.sha256).toBe(createHash('sha256').update(await readFile(process.execPath)).digest('hex'))
    expect(await buildEngineReader(destination)).toEqual(manifest)
    // The CJS closure must work without any node_modules alongside it.
    const log = console.log
    const bundle = createRequire(import.meta.url)(join(destination, 'reader.cjs'))
    expect(console.log).toBe(log)
    const base = markdownToYDoc('Earlier')
    const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
      maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000}
    try {
      expect(bundle.createEngineMarkdownReader(policy).construct({source: new TextEncoder().encode('- parent\n  - child\n'), checkpoint: Y.encodeStateAsUpdate(base),
        document: {workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage'}, currentPath: 'note.md'}).kind).toBe('accepted')
    } finally {base.destroy()}
  } finally {await rm(destination, {recursive: true, force: true})}
})

it.each([
  'const load = require; load("node:crypto")', '(0, require)("node:crypto")',
  'module.require("node:crypto")', 'require.resolve("node:crypto")',
  'process.getBuiltinModule("crypto")', 'process["getBuiltinModule"]("crypto")',
  'process?.getBuiltinModule("crypto")', 'process[`binding`]("tcp_wrap")',
  'const {require: load} = module; load("node:crypto")',
  'x.createRequire("file:///reader.js")', 'process.binding("tcp_wrap")',
  'process._linkedBinding("x")', 'process.dlopen(x, "x.node")',
  'require("node:crypto", other)', 'require()', '__require(variable)',
])('rejects loader escape: %s', code => {
  expect(() => checkReaderBundle(code)).toThrow()
})

it('allows only literal crypto imports in the finished bundle', () => {
  for (const specifier of ['crypto', 'node:crypto']) {
    expect(() => checkReaderBundle(`require(${JSON.stringify(specifier)})`)).not.toThrow()
    expect(() => checkReaderBundle(`import ${JSON.stringify(specifier)}`)).not.toThrow()
  }
  expect(() => checkReaderBundle('require("node:crypto/webcrypto")')).toThrow()
  expect(() => checkReaderBundle('require("some-package")')).toThrow()
})
