import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {afterAll, beforeAll, expect, it} from 'vitest'
import * as Y from 'yjs'
import {buildEngineReader} from '../scripts/build-engine-reader.mjs'
import { markdownToYDoc } from './import-export.js'
import rows from './engine-markdown-reader.fixture.json'

let directory: string, bundle: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dohc-reader-host-'))
  bundle = join(directory, 'reader.cjs')
  await buildEngineReader(directory)
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
async function start(entry = bundle, preload?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'dohc-reader-empty-'))
  const args = ['--permission', `--allow-fs-read=${bundle}`, '--max-old-space-size=512']
  if (entry !== bundle) args.push('--allow-fs-read=' + dirname(entry))
  if (preload) args.push(`--allow-fs-read=${preload}`, '--require', preload)
  const child = spawn(process.execPath, [...args, entry],
    {cwd, env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
  const closed = once(child, 'close')
  const diagnostics: Buffer[] = [], output: Buffer[] = []
  child.stderr.on('data', bytes => diagnostics.push(bytes))
  child.stdout.on('data', bytes => {output.push(bytes)})
  child.stdin.on('error', () => {})
  const iterator = child.stdout[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  async function exact(length: number) {
    while (pending.length < length) {
      const next = await iterator.next()
      if (next.done) throw new Error('Reader EOF: ' + Buffer.concat(diagnostics).toString())
      pending = Buffer.concat([pending, next.value])
    }
    const result = pending.subarray(0, length); pending = pending.subarray(length); return result
  }
  async function read() {
    const header = await exact(12)
    expect(header.subarray(0, 4).toString()).toBe('DOP1')
    return {type: header[4], flags: header[5], bytes: await exact(header.readUInt32LE(8))}
  }
  return {child, closed, read, diagnostics, output,
    async expectNoUnreadOutput() {
      child.stdin.end()
      const unread = [pending]; pending = Buffer.alloc(0)
      for (;;) {const next = await iterator.next(); if (next.done) break; unread.push(next.value)}
      await closed
      expect(Buffer.concat(unread).length).toBe(0)
    },
    async json() {const f = await read(); expect(f.type).toBe(1); return JSON.parse(f.bytes.toString())},
    async close() {
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.kill()
      await closed; await rm(cwd, {recursive: true, force: true})
    }}
}
async function hello(host: Awaited<ReturnType<typeof start>>) {
  host.child.stdin.write(control({id: 1, method: 'hello'}))
  return host.json()
}
const document = {workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage'}
function requestFrames(id: number, method: 'construct' | 'prove', source: Uint8Array, checkpoint: Uint8Array) {
  const frames = [control({id, method, document, currentPath: 'note.md', source: declared(source), checkpoint: declared(checkpoint)})]
  for (const [stream, bytes] of [[1, source], [2, checkpoint]] as const) {
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += 65536) {
      frames.push(blob(stream, bytes.subarray(offset, offset + 65536), offset + 65536 >= bytes.length))
    }
  }
  frames.push(control({id, end: true}))
  return frames
}
function request(child: ChildProcessWithoutNullStreams, id: number, method: 'construct' | 'prove', source: Uint8Array, checkpoint: Uint8Array) {
  child.stdin.write(Buffer.concat(requestFrames(id, method, source, checkpoint)))
}
async function success(host: Awaited<ReturnType<typeof start>>, id: number) {
  const result = await host.json(), chunks: Buffer[] = []
  expect(['constructed', 'proved'], JSON.stringify(result)).toContain(result.kind)
  expect(result.id).toBe(id); expect(result).not.toHaveProperty('strictJournal')
  for (;;) {
    const f = await host.read()
    expect(f.type).toBe(2); expect(f.bytes.readBigUInt64LE()).toBe(3n)
    expect(f.bytes.length - 8).toBeLessThanOrEqual(65536)
    chunks.push(f.bytes.subarray(8)); if (f.flags === 1) break
  }
  const delta = Buffer.concat(chunks)
  expect(declared(delta)).toEqual(result.delta)
  expect(await host.json()).toEqual({id, end: true})
  return {result, delta, chunkCount: chunks.length}
}

it.each([true])('constructs and proves a saved fixture; BOM=%s', async bom => {
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
    // A forged projection digest leaves a stale witness, which is ignored. The canonical
    // source still proves from the document; the BOM spelling needed the witness.
    base.getMap('meta').set('dohcMarkdownSourceProjectionSha256', hash(Buffer.from('forged')))
    request(host.child, 4, 'prove', source, Y.encodeStateAsUpdate(base))
    if (bom) expect(await host.json()).toMatchObject({id: 4, kind: 'refused'})
    else expect((await success(host, 4)).result.kind).toBe('proved')
    request(host.child, 5, 'construct', new Uint8Array([255]), Y.encodeStateAsUpdate(base))
    expect(await host.json()).toEqual({id: 5, kind: 'refused', reason: 'invalid-source'})
    await host.expectNoUnreadOutput()
  } finally {base.destroy(); await host.close()}
}, 30000)

type Host = Awaited<ReturnType<typeof start>>
async function rejection(host: Host, bytes: Buffer) {
  host.output.length = 0
  let rejectOutput!: (error: Error) => void
  const output = new Promise<never>((_, reject) => {rejectOutput = reject})
  const onOutput = () => rejectOutput(new Error('Response after invalid input'))
  host.child.stdout.once('data', onOutput)
  const deadline = AbortSignal.timeout(3000)
  const onTimeout = () => rejectOutput(new Error('Host did not reject invalid input with stdin open'))
  deadline.addEventListener('abort', onTimeout, {once: true})
  try {
    host.child.stdin.write(bytes)
    expect((await Promise.race([host.closed, output]))[0]).toBe(1)
    await host.expectNoUnreadOutput()
    expect(Buffer.concat(host.output).length).toBe(0)
    expect(Buffer.concat(host.diagnostics).toString()).toBe('')
  } finally {host.child.stdout.off('data', onOutput); deadline.removeEventListener('abort', onTimeout)}
}

it.each(['unknown-field', 'bad-magic', 'digest', 'blob-id', 'hello-first'])(
  'rejects %s with stdin open and no response', async mode => {
    const host = await start(), base = markdownToYDoc('Earlier')
    try {
      if (mode === 'hello-first') {
        await rejection(host, Buffer.concat(requestFrames(1, 'construct', Buffer.from('Body'), Y.encodeStateAsUpdate(base))))
        return
      }
      await hello(host)
      const source = Buffer.from('Body')
      const checkpoint = Y.encodeStateAsUpdate(base), frames = requestFrames(2, 'construct', source, checkpoint)
      const r = JSON.parse(frames[0]!.subarray(12).toString())
      if (mode === 'unknown-field') {r.extra = 'secret'; frames[0] = control(r)}
      if (mode === 'bad-magic') frames[0]![0] = 0
      if (mode === 'digest') {r.checkpoint.sha256 = '0'.repeat(64); frames[0] = control(r)}
      if (mode === 'blob-id') frames[1] = blob(9, source)
      await rejection(host, Buffer.concat(frames))
    } finally {base.destroy(); await host.close()}
  },
)

it.each(['request'])('EOF inside %s exits one', async stage => {
  const host = await start(), base = markdownToYDoc('Earlier')
  try {
    await hello(host); host.output.length = 0
    const frames = requestFrames(2, 'construct', Buffer.from('Body'), Y.encodeStateAsUpdate(base))
    const bytes = stage === 'header' ? frames[0]!.subarray(0, 6)
      : stage === 'control' ? frames[0]!.subarray(0, 16)
        : stage === 'blob' ? Buffer.concat([frames[0]!, frames[1]!.subarray(0, 22)]) : Buffer.concat(frames.slice(0, -1))
    host.child.stdin.end(bytes); expect((await host.closed)[0]).toBe(1)
    await host.expectNoUnreadOutput()
    expect(Buffer.concat(host.output).length).toBe(0)
    expect(Buffer.concat(host.diagnostics).length).toBe(0)
  } finally {base.destroy(); await host.close()}
})

it('ends the child on an allocation RangeError without sending a document verdict', async () => {
  const preload = join(directory, 'allocation-failure.cjs')
  await writeFile(preload, `const decode = TextDecoder.prototype.decode;
TextDecoder.prototype.decode = function(input, ...args) {
  if (input?.length === 19 && input[0] === 97) throw new RangeError('allocation failed');
  return Reflect.apply(decode, this, [input, ...args]);
};\n`)
  const host = await start(bundle, preload), base = markdownToYDoc('Earlier')
  try {
    await hello(host)
    request(host.child, 2, 'construct', Buffer.from('allocation tripwire'), Y.encodeStateAsUpdate(base))
    await expect(host.json()).rejects.toThrow('Reader EOF')
    expect((await host.closed)[0]).toBe(1)
    expect(Buffer.concat(host.diagnostics).length).toBe(0)
  } finally {base.destroy(); await host.close()}
})
it('chunks source and returned delta above 64 KiB', async () => {
  const host = await start(), base = markdownToYDoc('Earlier'), source = Buffer.from('a'.repeat(70000) + '\n')
  try {
    await hello(host); request(host.child, 2, 'construct', source, Y.encodeStateAsUpdate(base))
    const result = await success(host, 2)
    expect(result.delta.length).toBeGreaterThan(65536); expect(result.chunkCount).toBeGreaterThan(1)
    expect(result.result).toMatchObject({kind: 'constructed', sourceByteLength: source.length, sourceSha256: hash(source)})
    Y.applyUpdate(base, result.delta)
    request(host.child, 3, 'prove', source, Y.encodeStateAsUpdate(base))
    expect((await success(host, 3)).result.kind).toBe('proved')
    await host.expectNoUnreadOutput()
  } finally {base.destroy(); await host.close()}
})
it.each([true])('suppresses Yjs collision warnings; other console methods=%s', async emitConsole => {
  const preload = join(directory, 'collision-' + emitConsole + '.cjs')
  await writeFile(preload, "require('node:crypto').webcrypto.getRandomValues = array => array.fill(1234);\n"
    + (emitConsole ? "setImmediate(() => {for (const name of ['log','info','warn','error','debug','trace','dir','table']) console[name]('secret'); console.assert(false, 'secret');});" : ''))
  const host = await start(bundle, preload), base = markdownToYDoc('Earlier', {clientID: 1234})
  try {
    await hello(host)
    request(host.child, 2, 'construct', Buffer.from('Body'), Y.encodeStateAsUpdate(base))
    expect((await success(host, 2)).result.kind).toBe('constructed')
    host.child.stdin.end(); expect((await host.closed)[0]).toBe(0)
    await host.expectNoUnreadOutput()
    expect(Buffer.concat(host.diagnostics).length).toBe(0)
  } finally {base.destroy(); await host.close()}
})

it.runIf(process.platform === 'win32')('Windows permission flags deny outside reads and child processes', async () => {
  const code = "const fs=require('node:fs'),cp=require('node:child_process');"
    + "for(const f of [()=>fs.readFileSync(process.execPath),()=>cp.spawnSync(process.execPath,['-e','0'])]){"
    + "try{f();process.exit(42)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')process.exit(43)}}"
  const child = spawn(process.execPath, ['--permission', '--allow-fs-read=' + bundle, '-e', code], {env: {}, windowsHide: true, stdio: 'pipe'})
  expect((await once(child, 'close'))[0]).toBe(0)
})
