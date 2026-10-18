import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, expect, it} from 'vitest'
import * as Y from 'yjs'
import {buildEngineReader} from '../scripts/build-engine-reader.mjs'
import {markdownToYDoc} from './import-export.js'
import rows from './engine-markdown-reader.fixture.json'

let directory: string, bundle: string, manifest: Awaited<ReturnType<typeof buildEngineReader>>
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dohc-reader-host-'))
  bundle = join(directory, 'reader.cjs')
  manifest = await buildEngineReader(directory)
}, 30000)
afterAll(async () => {await rm(directory, {recursive: true, force: true})})
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const declared = (bytes: Uint8Array) => ({length: bytes.length, sha256: hash(bytes)})
function frame(type: number, flags: number, bytes: Uint8Array) {
  const header = Buffer.alloc(12)
  header.write('DOP1'); header[4] = type; header[5] = flags; header.writeUInt32LE(bytes.length, 8)
  return Buffer.concat([header, bytes])
}
const control = (value: unknown) => frame(1, 0, Buffer.from(JSON.stringify(value)))
function blob(stream: number, bytes: Uint8Array, fin = true) {
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(stream))
  return frame(2, Number(fin), Buffer.concat([prefix, bytes]))
}
async function start() {
  const cwd = await mkdtemp(join(tmpdir(), 'dohc-reader-empty-'))
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${bundle}`, '--max-old-space-size=256', bundle],
    {cwd, env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
  const closed = once(child, 'close')
  const diagnostics: Buffer[] = []
  child.stderr.on('data', bytes => diagnostics.push(bytes))
  child.stdin.on('error', () => {})
  const iterator = child.stdout[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  async function exact(length: number) {
    while (pending.length < length) {
      const next = await iterator.next()
      if (next.done) throw new Error('Reader EOF')
      pending = Buffer.concat([pending, next.value])
    }
    const result = pending.subarray(0, length); pending = pending.subarray(length); return result
  }
  async function read() {
    const header = await exact(12)
    expect(header.subarray(0, 4).toString()).toBe('DOP1')
    return {type: header[4], flags: header[5], bytes: await exact(header.readUInt32LE(8))}
  }
  return {child, closed, read, diagnostics,
    async json() {const f = await read(); expect(f.type).toBe(1); return JSON.parse(f.bytes.toString())},
    async close() {child.kill(); await closed; await rm(cwd, {recursive: true, force: true})}}
}
async function hello(host: Awaited<ReturnType<typeof start>>) {
  host.child.stdin.write(control({id: 1, method: 'hello'}))
  return host.json()
}
const document = {workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage'}
function request(child: ChildProcessWithoutNullStreams, id: number, method: 'construct' | 'prove', source: Uint8Array, checkpoint: Uint8Array) {
  child.stdin.write(control({id, method, document, currentPath: 'note.md', source: declared(source), checkpoint: declared(checkpoint)}))
  for (const [stream, bytes] of [[1, source], [2, checkpoint]] as const) {
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += 65536) {
      child.stdin.write(blob(stream, bytes.subarray(offset, offset + 65536), offset + 65536 >= bytes.length))
    }
  }
  child.stdin.write(control({id, end: true}))
}
async function success(host: Awaited<ReturnType<typeof start>>, id: number) {
  const result = await host.json(), chunks: Buffer[] = []
  expect(result.id).toBe(id); expect(result.strictJournal).toBe(true)
  for (;;) {
    const f = await host.read()
    expect(f.type).toBe(2); expect(f.bytes.readBigUInt64LE()).toBe(3n)
    chunks.push(f.bytes.subarray(8)); if (f.flags === 1) break
  }
  const delta = Buffer.concat(chunks)
  expect(declared(delta)).toEqual(result.delta)
  expect(await host.json()).toEqual({id, end: true})
  return {result, delta}
}

it('hello binds the embedded build and actual Node, Unicode and ICU', async () => {
  const host = await start()
  try {
    const {bundleSha256: _, sources: __, ...identity} = manifest
    expect(await hello(host)).toEqual({id: 1, kind: 'hello', protocolVersion: 1, schemaVersion: 1, identity,
      runtime: {version: process.versions.node, platform: process.platform, arch: process.arch,
        unicode: process.versions.unicode, icu: process.versions.icu}})
  } finally {await host.close()}
})
it.each([false, true])('constructs and proves a saved fixture; BOM=%s', async bom => {
  const host = await start(), row = rows.find(row => row.accepted)!, base = markdownToYDoc(row.earlier)
  const source = new TextEncoder().encode((bom ? '\ufeff' : '') + row.source)
  try {
    await hello(host)
    request(host.child, 2, 'construct', source, Y.encodeStateAsUpdate(base))
    const first = await success(host, 2)
    expect(first.result.kind).toBe('constructed')
    expect(first.result.sourceSha256).toBe(hash(source)); expect(first.result.sourceByteLength).toBe(source.length)
    Y.applyUpdate(base, first.delta)
    request(host.child, 3, 'prove', source, Y.encodeStateAsUpdate(base))
    const second = await success(host, 3)
    expect(second.result.kind).toBe('proved'); expect(second.delta.length).toBe(0)
    expect(second.result.sourceSha256).toBe(hash(source)); expect(second.result.sourceByteLength).toBe(source.length)
    base.getMap('meta').set('dohcMarkdownSourceProjectionSha256', hash(Buffer.from('forged')))
    request(host.child, 4, 'prove', source, Y.encodeStateAsUpdate(base))
    expect(await host.json()).toMatchObject({id: 4, kind: 'refused'})
    request(host.child, 5, 'construct', new Uint8Array([255]), Y.encodeStateAsUpdate(base))
    expect(await host.json()).toEqual({id: 5, kind: 'refused', reason: 'invalid-source'})
  } finally {base.destroy(); await host.close()}
}, 30000)

it.each(['unknown-field', 'wrong-id', 'method', 'oversize', 'bad-magic', 'truncated-control', 'surplus', 'truncated-blob', 'digest', 'length', 'blob-id', 'blob-size'])(
  'fails closed on %s without diagnostics', async mode => {
    const host = await start()
    try {
      if (mode === 'unknown-field') host.child.stdin.end(control({id: 1, method: 'hello', source: 'secret'}))
      else if (mode === 'wrong-id') host.child.stdin.end(control({id: 2, method: 'hello'}))
      else if (mode === 'method') host.child.stdin.end(control({id: 1, method: 'eval'}))
      else if (mode === 'oversize') {
        const f = control({}); f.writeUInt32LE(65537, 8); host.child.stdin.end(f.subarray(0, 12))
      } else if (mode === 'bad-magic') {const f = control({}); f[0] = 0; host.child.stdin.end(f)}
      else if (mode === 'truncated-control') host.child.stdin.end(control({id: 1, method: 'hello'}).subarray(0, 16))
      else {
        await hello(host)
        const source = Buffer.from('secret'), checkpoint = Buffer.from([0, 0])
        const declaration = mode === 'length' ? {length: 2 ** 32, sha256: hash(source)} : declared(source)
        host.child.stdin.write(control({id: 2, method: 'prove', document, currentPath: 'secret', source: declaration, checkpoint: declared(checkpoint)}))
        if (mode === 'truncated-blob') host.child.stdin.end(blob(1, source.subarray(0, 2), false))
        else if (mode === 'digest') host.child.stdin.end(blob(1, Buffer.from('SECRET')))
        else if (mode === 'blob-id') host.child.stdin.end(blob(9, source))
        else if (mode === 'blob-size') host.child.stdin.end(blob(1, Buffer.alloc(65537)))
        else {
          host.child.stdin.write(blob(1, source)); host.child.stdin.write(blob(2, checkpoint))
          host.child.stdin.end(blob(2, checkpoint))
        }
      }
      const [code] = await host.closed
      expect(code).toBe(1); expect(Buffer.concat(host.diagnostics).toString()).toBe('')
    } finally {await host.close()}
  }, 10000,
)
it('exits when stdin closes after hello', async () => {
  const host = await start()
  try {await hello(host); host.child.stdin.end(); await host.closed}
  finally {await host.close()}
})

it('Windows permission flags deny outside reads and child processes', async () => {
  if (process.platform !== 'win32') return
  const code = `const fs=require('node:fs'), cp=require('node:child_process');
    for(const f of [()=>fs.readFileSync(process.execPath),()=>cp.spawnSync(process.execPath,['-e','0'])]) {
      try {f(); process.exit(42)} catch(e) {if(e.code!=='ERR_ACCESS_DENIED') process.exit(43)}
    }`
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${bundle}`, '-e', code], {env: {}, windowsHide: true, stdio: 'pipe'})
  expect((await once(child, 'close'))[0]).toBe(0)
})
