import {createHash} from 'node:crypto'
import {createEngineMarkdownReader, type EngineMarkdownProof} from './engine-markdown-reader.js'
import type {LiveMarkdownRegistrationInput} from './liveDocumentValidation.js'
import {checkMarkdownWitness} from './lossy-markdown.js'

const CHUNK = 65536, UPDATE = 20 * 1024 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const reader = createEngineMarkdownReader({maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000})
function requireWire(ok: unknown): asserts ok {if (!ok) throw new Error('invalid-frame')}
function keys(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  requireWire(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)))
}
function declaration(value: unknown, limit: number): {length: number; sha256: string} {
  keys(value, ['length', 'sha256'])
  requireWire(Number.isSafeInteger(value.length) && Number(value.length) >= 0 && Number(value.length) <= limit
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256))
  return value as {length: number; sha256: string}
}
function frame(type: number, flags: number, data: Buffer) {
  const header = Buffer.alloc(12)
  header.write('DOP1'); header[4] = type; header[5] = flags; header.writeUInt32LE(data.length, 8)
  return Buffer.concat([header, data])
}
async function write(bytes: Buffer) {
  await new Promise<void>((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()))
}
async function control(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)); requireWire(bytes.length <= CHUNK)
  await write(frame(1, 0, bytes))
}
async function blob(id: number, bytes: Uint8Array) {
  for (let offset = 0; offset < Math.max(1, bytes.length); offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length), prefix = Buffer.alloc(8)
    prefix.writeBigUInt64LE(BigInt(id))
    await write(frame(2, Number(end === bytes.length), Buffer.concat([prefix, bytes.subarray(offset, end)])))
  }
}

/** Only the fixed executable entry runs the pipe host; importing the adapter has no process side effects. */
export async function runEngineMarkdownHost() {
  for (const name of Object.getOwnPropertyNames(console)) {
    if (typeof Reflect.get(console, name) === 'function') Reflect.set(console, name, () => {})
  }
  const iterator = process.stdin[Symbol.asyncIterator]()
  const cleanEof = Symbol()
  let pending = Buffer.alloc(0), cursor = 0, previous = 0
  async function exact(length: number, allowEof = false): Promise<Buffer> {
    const output = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      if (cursor === pending.length) {
        const next = await iterator.next()
        if (next.done && allowEof && offset === 0) throw cleanEof
        requireWire(!next.done)
        pending = next.value; cursor = 0
      }
      const count = Math.min(length - offset, pending.length - cursor)
      pending.copy(output, offset, cursor, cursor + count); offset += count; cursor += count
    }
    return output
  }
  async function readFrame(allowEof = false) {
    const h = await exact(12, allowEof), type = h[4], flags = h[5]!, length = h.readUInt32LE(8)
    requireWire(h.subarray(0, 4).toString() === 'DOP1' && h.readUInt16LE(6) === 0
      && ((type === 1 && flags === 0 && length <= CHUNK)
        || (type === 2 && flags <= 1 && length >= 8 && length <= CHUNK + 8)))
    return {type, flags, data: await exact(length)}
  }
  async function readControl(allowEof = false): Promise<Record<string, unknown>> {
    const f = await readFrame(allowEof); requireWire(f.type === 1)
    const text = new TextDecoder('utf-8', {fatal: true}).decode(f.data)
    const value: unknown = JSON.parse(text)
    requireWire(value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  }
  async function readBlob(id: number, declared: ReturnType<typeof declaration>) {
    // The length and digest syntax were bounded before this allocation.
    const bytes = Buffer.alloc(declared.length)
    let offset = 0
    for (;;) {
      const f = await readFrame(), count = f.data.length - 8
      requireWire(f.type === 2 && f.data.readBigUInt64LE() === BigInt(id)
        && offset + count <= bytes.length && (count > 0 || bytes.length === 0))
      f.data.copy(bytes, offset, 8); offset += count
      if (f.flags === 1) break
      requireWire(offset < bytes.length)
    }
    requireWire(offset === bytes.length && sha(bytes) === declared.sha256)
    return bytes
  }
  try {
    for (;;) {
      const r = await readControl(true), id = r.id
      requireWire(previous !== 0 || r.method === 'hello')
      requireWire(Number.isSafeInteger(id) && Number(id) === previous + 1); previous = Number(id)
      if (r.method === 'hello') {
        keys(r, ['id', 'method']); requireWire(id === 1)
        await control({id, kind: 'hello', protocolVersion: 1, schemaVersion: 1,
          runtime: {version: process.versions.node, platform: process.platform, arch: process.arch,
            unicode: process.versions.unicode, icu: process.versions.icu}})
        continue
      }
      if (r.method === 'check-markdown-witness') {
        keys(r, ['id', 'method', 'source', 'sourceSha256', 'projectionSha256'])
        requireWire(typeof r.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sourceSha256)
          && typeof r.projectionSha256 === 'string' && /^[a-f0-9]{64}$/.test(r.projectionSha256))
        const declared = declaration(r.source, 2 * 1024 * 1024)
        requireWire(declared.sha256 === r.sourceSha256)
        const source = await readBlob(1, declared)
        const finish = await readControl(); keys(finish, ['id', 'end'])
        requireWire(finish.id === id && finish.end === true)
        const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(source)
        await control({id, kind: 'witness-checked', sourceSha256: r.sourceSha256,
          projectionSha256: r.projectionSha256,
          keepsMeaning: checkMarkdownWitness(text, r.sourceSha256, r.projectionSha256)})
        continue
      }
      keys(r, ['id', 'method', 'document', 'currentPath', 'source', 'checkpoint'])
      requireWire(r.method === 'construct' || r.method === 'construct-fold' || r.method === 'prove')
      keys(r.document, ['workspaceId', 'mainVersionId', 'objectId', 'lineageClaimId'])
      requireWire(Object.values(r.document).every(v => typeof v === 'string' && v.length > 0)
        && typeof r.currentPath === 'string')
      const sourceDeclaration = declaration(r.source, 2 * 1024 * 1024), checkpointDeclaration = declaration(r.checkpoint, UPDATE)
      const source = await readBlob(1, sourceDeclaration), checkpoint = await readBlob(2, checkpointDeclaration)
      // An explicit end control catches surplus chunks before running the parser.
      const finish = await readControl(); keys(finish, ['id', 'end'])
      requireWire(finish.id === id && finish.end === true)
      const input = {document: r.document as unknown as LiveMarkdownRegistrationInput['document'],
        currentPath: r.currentPath, source, checkpoint}
      async function respond(result: EngineMarkdownProof, delta: Uint8Array) {
        if (result.kind === 'refused') return control({id, ...result})
        requireWire(result.sourceSha256 === sourceDeclaration.sha256 && result.sourceByteLength === sourceDeclaration.length)
        await control({id, kind: result.kind === 'expired' ? 'expired' : r.method !== 'prove' ? 'constructed' : 'proved', sourceSha256: result.sourceSha256,
          sourceByteLength: result.sourceByteLength, projectionSha256: result.projectionSha256,
          stateSha256: result.stateSha256,
          delta: {length: delta.length, sha256: sha(delta)}})
        await blob(3, delta); await control({id, end: true})
      }
      if (r.method !== 'prove') {
        const result = reader.construct({...input, nativeFold: r.method === 'construct-fold'})
        if (result.kind === 'accepted') requireWire(result.delta instanceof Uint8Array)
        await respond(result, result.kind === 'accepted' ? result.delta : new Uint8Array())
      } else await respond(reader.prove(input), new Uint8Array())
    }
  } catch (error) {
    if (error === cleanEof) return
    // Never print parser errors, source, paths, or Yjs values.
    process.exitCode = 1
    process.stdin.destroy()
  }
}
