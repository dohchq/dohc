import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as projection from './import-export.js'
import { getDohcYDocFrontmatter, markdownToYDoc } from './import-export.js'
import * as ordered from './orderedLiveUpdateCut.js'
import { type OrderedLiveUpdateCutPolicy } from './orderedLiveUpdateCut.js'
import { createLiveMarkdownRegistrationValidator, type LiveMarkdownRegistrationEvidence } from './liveDocumentValidation.js'

const fixturePolicy: OrderedLiveUpdateCutPolicy = {
  maxStructVisits: 1_000_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
}

const document = { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage' }
const validate = createLiveMarkdownRegistrationValidator(fixturePolicy)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function input(checkpoint: Uint8Array = new Uint8Array([0, 0])) {
  return { document: { ...document }, currentPath: 'notes/example.md', checkpoint }
}
function encode(markdown: string, edit?: (doc: Y.Doc) => void): Uint8Array {
  const doc = markdownToYDoc(markdown)
  try { edit?.(doc); return Y.encodeStateAsUpdate(doc) }
  finally { doc.destroy() }
}
function accepted(checkpoint: Uint8Array): LiveMarkdownRegistrationEvidence {
  const result = validate(input(checkpoint))
  expect(result, JSON.stringify(result.kind === 'refused' ? result : { kind: result.kind })).toHaveProperty('kind', 'accepted')
  if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
  return result.evidence
}
function refused(checkpoint: Uint8Array, reason = 'invalid-schema') {
  const result = validate(input(checkpoint))
  expect(result.kind).toBe('refused')
  if (result.kind === 'refused') expect(result).toEqual({ kind: 'refused', reason, source: 'registration-input' })
}
afterEach(() => vi.restoreAllMocks())

it('canonical importer output with an isolated hostile key reaches registration validation', () => {
  const doc = markdownToYDoc('---\nnested:\n  __proto__: preserved\n---\n\nBody')
  try {
    expect(getDohcYDocFrontmatter(doc)).toEqual({ nested: { ['__proto__']: 'preserved' } })
    const checkpoint = Y.encodeStateAsUpdate(doc)
    expect(accepted(checkpoint).projectedMarkdown).toContain('__proto__: preserved')
  } finally { doc.destroy() }
})

describe('private policy construction', () => {
  it('owns distinct policies without rereading caller records', () => {
    const caller = { ...fixturePolicy }
    const generous = createLiveMarkdownRegistrationValidator(caller)
    const narrow = createLiveMarkdownRegistrationValidator({ ...fixturePolicy, maxStructVisits: 1 })
    caller.maxStructVisits = 1
    const call = input(encode('A **bold** paragraph'))
    expect(generous(call).kind).toBe('accepted')
    expect(narrow(call)).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'registration-input' })
  })
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1', undefined])('rejects policy value %s', value => {
    expect(() => createLiveMarkdownRegistrationValidator({ ...fixturePolicy, maxStructVisits: value } as OrderedLiveUpdateCutPolicy)).toThrow(TypeError)
  })
  it('rejects non-data, missing, inherited, hidden and extra fields without calling getters', () => {
    const getter = vi.fn(() => 100)
    const accessor = Object.defineProperty({ ...fixturePolicy }, 'maxStructVisits', { get: getter })
    const missing = { ...fixturePolicy } as Partial<OrderedLiveUpdateCutPolicy>
    Reflect.deleteProperty(missing, 'maxStructVisits')
    const hidden = Object.defineProperty({ ...fixturePolicy }, 'maxStructVisits', { enumerable: false })
    for (const value of [accessor, missing, hidden, Object.create(fixturePolicy), { ...fixturePolicy, extra: 1 }, { ...fixturePolicy, [Symbol()]: 1 }]) {
      expect(() => createLiveMarkdownRegistrationValidator(value as OrderedLiveUpdateCutPolicy)).toThrow(TypeError)
    }
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('call and byte ownership', () => {
  it('requires exact own enumerable data fields and canonical main Markdown paths', () => {
    const getter = vi.fn(() => document)
    const accessor = Object.defineProperty(input(), 'document', { get: getter })
    for (const call of [null, [], accessor, { ...input(), extra: true }, { ...input(), updates: [] },
      { ...input(), document: { ...document, extra: 1 } },
      { ...input(), document: { ...document, mainVersionId: 'branch' } },
      { ...input(), document: Object.create(document) },
      ...['a/../b.md', '/a.md', 'a\\b.md', 'a.txt', '../a.md', ' a.md '].map(currentPath => ({ ...input(), currentPath })),
    ]) expect(validate(call)).toEqual({ kind: 'refused', reason: 'invalid-input', source: 'call' })
    expect(getter).not.toHaveBeenCalled()
    expect(validate({ ...input(), currentPath: `${'a/'.repeat(520)}note.md` }).kind).toBe('accepted')
  })
  it('ignores hostile instance properties and snapshots the exact intrinsic view before copying', () => {
    const original = encode('Original bytes')
    const backing = new Uint8Array(original.length + 7)
    backing.set(original, 3)
    const checkpoint = backing.subarray(3, 3 + original.length)
    const hostile = vi.fn(() => { throw new Error('instance property read') })
    for (const key of ['buffer', 'byteOffset', 'byteLength', 'slice', 'subarray', Symbol.iterator]) {
      Object.defineProperty(checkpoint, key, { get: hostile })
    }
    const actual = ordered.validateRegistrationCutForProjection
    const spy = vi.spyOn(ordered, 'validateRegistrationCutForProjection').mockImplementation((cutInput, policy) => {
      expect(cutInput.checkpoint.buffer).toBe(backing.buffer)
      expect(cutInput.checkpoint.byteOffset).toBe(3)
      expect(cutInput.checkpoint === checkpoint).toBe(false)
      return actual(cutInput, policy)
    })
    const evidence = accepted(checkpoint)
    expect(evidence.checkpoint.bytes).toEqual(original)
    expect(evidence.checkpoint.updateDigest).toBe(hash(original))
    expect(spy).toHaveBeenCalledOnce()
    expect(hostile).not.toHaveBeenCalled()
  })
  it('rejects incompatible, empty, shared, resizable and detached views', () => {
    const detached = new Uint8Array([0, 0])
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    const resizable = Reflect.construct(ArrayBuffer, [2, { maxByteLength: 4 }]) as ArrayBuffer
    for (const checkpoint of [new Uint8Array(), new Int8Array([0, 0]), new DataView(new ArrayBuffer(2)),
      new Uint8Array(new SharedArrayBuffer(2)), new Uint8Array(resizable), detached, [0, 0], null,
    ]) expect(validate({ ...input(), checkpoint })).toEqual({ kind: 'refused', reason: 'invalid-input', source: 'registration-input' })
  })
  it('rejects trailing and truncated checkpoint bytes', () => {
    const bytes = encode('hello')
    refused(new Uint8Array([...bytes, 0]), 'invalid-update')
    refused(bytes.slice(0, -1), 'invalid-update')
  })
  it('owns evidence records, original bytes, ranges and each returned byte view', () => {
    const bytes = encode('Evidence')
    const call = input(bytes)
    const result = validate(call)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const evidence = result.evidence
    const original = bytes.slice()
    call.document.workspaceId = 'changed'
    bytes.fill(255)
    expect(evidence.document).toEqual(document)
    expect(evidence.checkpoint.bytes).toEqual(original)
    for (const record of [result, evidence, evidence.document, evidence.checkpoint, evidence.checkpoint.ranges, ...evidence.checkpoint.ranges]) expect(Object.isFrozen(record)).toBe(true)
    for (const read of [() => evidence.checkpoint.bytes, () => evidence.stateUpdate, () => evidence.stateVector]) {
      const before = read()
      read().fill(255)
      expect(read()).toEqual(before)
      expect(read()).not.toBe(read())
    }
    expect(evidence.version).toBe(1)
    expect(evidence.projectedMarkdownSha256).toBe(hash(new TextEncoder().encode(evidence.projectedMarkdown)))
    expect(evidence.stateUpdateSha256).toBe(hash(evidence.stateUpdate))
    expect(evidence.stateVectorSha256).toBe(hash(evidence.stateVector))
    expect(evidence.checkpoint.ranges.length).toBeGreaterThan(0)
    expect(Object.keys(evidence).sort()).toEqual(['version', 'document', 'currentPath', 'checkpoint', 'projectedMarkdown', 'projectedMarkdownSha256', 'projectedMarkdownByteLength', 'stateUpdate', 'stateUpdateSha256', 'stateUpdateByteLength', 'stateVector', 'stateVectorSha256'].sort())
  })
  it('keeps original noncanonical checkpoint identity separate from final encoding', () => {
    const bytes = new Uint8Array([0x80, 0, 0])
    const evidence = accepted(bytes)
    expect(evidence.checkpoint.bytes).toEqual(bytes)
    expect(evidence.stateUpdate).toEqual(new Uint8Array([0, 0]))
    expect(evidence.checkpoint.updateDigest).toBe(hash(bytes))
    expect(evidence.checkpoint.updateDigest).not.toBe(evidence.stateUpdateSha256)
  })
  it('retains real Item and GC ranges from the original checkpoint', () => {
    const checkpoint = encode('Removed paragraph\n\nRetained paragraph', doc => doc.getXmlFragment('body').delete(0, 1))
    const decoded = Y.decodeUpdate(checkpoint)
    expect(decoded.structs.some(struct => struct instanceof Y.GC)).toBe(true)
    expect(decoded.structs.some(struct => struct instanceof Y.Item)).toBe(true)
    const ranges = accepted(checkpoint).checkpoint.ranges
    for (const struct of decoded.structs) {
      expect(ranges.some(range => range.clientId === struct.id.client
        && range.startClock <= struct.id.clock
        && range.endClock >= struct.id.clock + struct.length)).toBe(true)
    }
  })
})

describe('public Markdown schema', () => {
  it.each(['', 'Hello **world**', '# Heading\n\n- item\n- other', '---\ntitle: Test\nlist: [1, true, null]\n---\n\nText', '---\nvalue: .nan\npos: .inf\nneg: -.inf\nzero: -0.0\n---\n\nText', 'first\r\n\r\nsecond'])('accepts canonical importer output %s', markdown => {
    const doc = markdownToYDoc(markdown)
    try { expect(accepted(Y.encodeStateAsUpdate(doc)).projectedMarkdown).toBe(projection.yDocToMarkdown(doc)) }
    finally { doc.destroy() }
  })
  it('accepts canonical zero seed and metadata-only empty documents', () => {
    expect(accepted(new Uint8Array([0, 0])).projectedMarkdown).toBe('')
    const doc = new Y.Doc()
    try {
      doc.getMap('meta').set('schemaVersion', 1)
      expect(accepted(Y.encodeStateAsUpdate(doc)).projectedMarkdown).toBe('')
    } finally { doc.destroy() }
  })
  it.each([['schemaVersion', undefined], ['schemaVersion', 2], ['dohcMarkdownCrlf', undefined], ['dohcMarkdownCrlf', false], ['unknown', true], ['dohcTaggedFrontmatterPrefix', '---\n'], ['dohcTaggedFrontmatterBaseline', '']])('rejects strict metadata %s = %s', (key, value) => {
    refused(encode('Text', doc => doc.getMap('meta').set(key as string, value)))
  })
  it('rejects absent version, stale tagged baseline and unobservable CRLF flags', () => {
    refused(encode('Text', doc => doc.getMap('meta').delete('schemaVersion')))
    refused(encode('Text', doc => {
      doc.getMap('meta').set('dohcTaggedFrontmatterPrefix', '---\nx: 1\n---\n\n')
      doc.getMap('meta').set('dohcTaggedFrontmatterBaseline', 'stale')
    }))
    refused(encode('Text', doc => doc.getMap('meta').set('dohcMarkdownCrlf', true)))
  })
  it.each([undefined, new Uint8Array([1]), new Y.Text('discarded'), new Y.Doc()])('rejects nonpublic frontmatter values %#', value => {
    refused(encode('Text', doc => doc.getMap('frontmatter').set('value', value)))
    if (value instanceof Y.Doc) value.destroy()
  })
  it('rejects bigint sentinel key collisions after unescaping', () => {
    refused(encode('Text', doc => {
      const map = new Y.Map<unknown>()
      map.set('$dohcBigInt', 'first')
      map.set('$$dohcBigInt', 'second')
      doc.getMap('frontmatter').set('value', map)
    }))
  })
  it('rejects topology-hidden keyed body and active unknown roots', () => {
    const keyed = new Y.Doc()
    try {
      keyed.getMap('body').set('hidden', 'value')
      keyed.getMap('meta').set('schemaVersion', 1)
      refused(Y.encodeStateAsUpdate(keyed))
    } finally { keyed.destroy() }
    refused(encode('Text', doc => doc.getMap('unknown').set('hidden', true)))
  })
  it('rejects invalid children, attributes and marks that the schema drops', () => {
    // y-prosemirror removes an unknown element in a transaction before failing.
    refused(encode('Text', doc => doc.getXmlFragment('body').insert(0, [new Y.XmlElement('unknown')])), 'projection-mutated')
    refused(encode('Text', doc => (doc.getXmlFragment('body').get(0) as Y.XmlElement).setAttribute('unknown', 'hidden')))
    refused(encode('Text', doc => ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).format(0, 1, { unknown: {} })), 'projection-mutated')
  })
  it('accepts full 2 MiB as one text run, and refuses one UTF-8 byte over', () => {
    const limit = 2 * 1024 * 1024
    expect(accepted(encode('x'.repeat(limit))).projectedMarkdownByteLength).toBe(limit)
    refused(encode('x'.repeat(limit + 1)), 'capacity-refused')
    expect(accepted(encode('é'.repeat(limit / 2))).projectedMarkdownByteLength).toBe(limit)
    refused(encode(`${'é'.repeat(limit / 2)}x`), 'capacity-refused')
  }, 60_000)
  it('accepts signed int64 shared values and escaped sentinel keys', () => {
    for (const markdown of [
      '---\nlarge: 9223372036854775807\nsmall: -9223372036854775808\n---\n\nText',
      '---\nnested:\n  constructor: preserved\n  $dohcBigInt: literal\n  $$dohcBigInt: also literal\n---\n\nText',
      '---\nvalue: !!str 123\n---\n\nText',
    ]) accepted(encode(markdown))
  })
  it('enforces public depth 128 independently of text length', () => {
    const fixture = (depth: number) => encode('', doc => {
      let value: unknown = 'leaf'
      for (let index = 0; index < depth; index++) value = { child: value }
      doc.getMap('frontmatter').set('nested', value)
    })
    accepted(fixture(128))
    refused(fixture(129), 'capacity-refused')
  })
  it('counts 262144 actual public nodes including containers and text runs', () => {
    const fixture = (nodes: number) => encode('Text', doc => {
      // Paragraph, XmlText, text run and array each contribute one node.
      doc.getMap('frontmatter').set('values', new Array(nodes - 4).fill(0))
    })
    accepted(fixture(262_144))
    refused(fixture(262_145), 'capacity-refused')
  }, 60_000)
})

describe('real scratch finalization', () => {
  function observe() {
    const actual = ordered.validateRegistrationCutForProjection
    let scratch: Y.Doc | undefined
    const events: string[] = []
    vi.spyOn(ordered, 'validateRegistrationCutForProjection').mockImplementation((...args) => {
      const result = actual(...args)
      if (result.kind === 'accepted') {
        scratch = result.cut.document
        const off = scratch.off.bind(scratch)
        vi.spyOn(scratch, 'off').mockImplementation((...offArgs) => {
          if (offArgs[0] === 'beforeTransaction') events.push('finalize')
          return off(...offArgs)
        })
        const destroy = scratch.destroy.bind(scratch)
        vi.spyOn(scratch, 'destroy').mockImplementation(() => { events.push('destroy'); destroy() })
      }
      return result
    })
    return { events, scratch: () => scratch }
  }
  it.each(['success', 'schema refusal', 'topology refusal', 'throw', 'transaction', 'destruction'])('finalizes exactly once after %s', mode => {
    const checkpoint = encode('Text', mode === 'schema refusal' ? doc => doc.getMap('meta').set('unknown', 1)
      : mode === 'topology refusal' ? doc => doc.getMap('unknown').set('hidden', 1) : undefined)
    const probe = observe()
    const original = projection.yDocToMarkdown
    const projector = vi.spyOn(projection, 'yDocToMarkdown').mockImplementation(doc => {
      expect(doc).toBe(probe.scratch())
      if (mode === 'throw') throw new Error('projection failed')
      if (mode === 'transaction') { doc.transact(() => {}); throw new Error('projection failed after mutation') }
      if (mode === 'destruction') { doc.destroy(); throw new Error('projection failed after destruction') }
      return original(doc)
    })
    const result = validate(input(checkpoint))
    if (mode === 'success') expect(result.kind).toBe('accepted')
    else expect(result).toEqual({ kind: 'refused', reason: ['transaction', 'destruction'].includes(mode) ? 'projection-mutated' : 'invalid-schema', source: 'registration-input' })
    expect(probe.events.filter(event => event === 'finalize')).toHaveLength(1)
    expect(probe.scratch()?.isDestroyed).toBe(true)
    if (mode !== 'destruction') expect(probe.events).toEqual(['finalize', 'destroy'])
    expect(projector).toHaveBeenCalledTimes(['schema refusal', 'topology refusal'].includes(mode) ? 0 : 1)
  })
  it('preserves real finalizer capacity refusal', () => {
    const checkpoint = encode('Text')
    let sawFinalizerCapacity = false
    for (let maxDecodedPayloadByteVisits = 1; maxDecodedPayloadByteVisits < 500; maxDecodedPayloadByteVisits++) {
      const policy = { ...fixturePolicy, maxDecodedPayloadByteVisits }
      const cut = ordered.validateRegistrationCutForProjection({ mode: 'registration', checkpoint }, policy)
      if (cut.kind === 'refused') continue
      let final
      try { final = cut.cut.finishAfterProjection() }
      finally { cut.cut.document.destroy() }
      if (final.kind !== 'refused' || final.reason !== 'capacity-refused') continue
      expect(createLiveMarkdownRegistrationValidator(policy)(input(checkpoint))).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'registration-input' })
      sawFinalizerCapacity = true
      break
    }
    expect(sawFinalizerCapacity).toBe(true)
  })
  it('finalizes after caller bytes change between validation and owned copying', () => {
    const checkpoint = encode('Text')
    const actual = ordered.validateRegistrationCutForProjection
    let scratch: Y.Doc | undefined
    let finalizerRemovals = 0
    vi.spyOn(ordered, 'validateRegistrationCutForProjection').mockImplementation((...args) => {
      const result = actual(...args)
      if (result.kind === 'accepted') {
        scratch = result.cut.document
        const off = scratch.off.bind(scratch)
        vi.spyOn(scratch, 'off').mockImplementation((...offArgs) => {
          if (offArgs[0] === 'beforeTransaction') finalizerRemovals++
          return off(...offArgs)
        })
        checkpoint.fill(0)
      }
      return result
    })
    refused(checkpoint, 'invalid-update')
    expect(finalizerRemovals).toBe(1)
    expect(scratch?.isDestroyed).toBe(true)
  })
  it('refuses content changes with an unchanged state vector and no transaction', () => {
    const checkpoint = encode('Text')
    const original = projection.yDocToMarkdown
    vi.spyOn(projection, 'yDocToMarkdown').mockImplementation(doc => {
      const vector = Y.encodeStateVector(doc)
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      const item = text._start!
      const content = item.content as Y.ContentString
      content.str = 'Next'
      expect(Y.encodeStateVector(doc)).toEqual(vector)
      return original(doc)
    })
    refused(checkpoint, 'projection-mutated')
  })
})

it('keeps the constructor and ordered policy outside package exports', async () => {
  const barrel = await import('./index.js')
  expect(barrel).not.toHaveProperty('createLiveMarkdownRegistrationValidator')
  expect(barrel).not.toHaveProperty('validateRegistrationCutForProjection')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.exports).toEqual({ '.': './src/index.ts', './image-src': './src/image-src.ts' })
})
