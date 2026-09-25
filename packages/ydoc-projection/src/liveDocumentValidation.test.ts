import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror'
import { TableCell, TableHeader } from '@tiptap/extension-table'
import { getExtensionField } from '@tiptap/core'
import * as projection from './import-export.js'
import { getDohcYDocFrontmatter, markdownToYDoc } from './import-export.js'
import * as ordered from './orderedLiveUpdateCut.js'
import { type OrderedLiveUpdateCutPolicy } from './orderedLiveUpdateCut.js'
import { createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator, type LiveMarkdownRegistrationEvidence } from './liveDocumentValidation.js'

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
  const nodeAttributes: Record<string, string[]> = {
    wikilink: ['target', 'label'], inlineAtom: ['atomId', 'params', 'source'],
    callout: ['calloutType', 'title', 'fold'], mathInline: ['tex'], mathBlock: ['tex'],
    image: ['src', 'alt', 'title'], escapedPunctuation: ['value'], codeBlock: ['language'],
    heading: ['level'], orderedList: ['start', 'type'], taskItem: ['checked'],
    tableCell: ['colspan', 'rowspan', 'colwidth', 'align'],
    tableHeader: ['colspan', 'rowspan', 'colwidth', 'align'], tableRow: ['height'],
  }
  function nodeCheckpoint(name: string, attributes: Record<string, unknown>): Uint8Array {
    const schema = projection.getDohcProseMirrorSchema()
    const node = structuredClone(schema.nodes[name].create().toJSON())
    Object.assign(node.attrs, attributes)
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }
    if (['callout', 'taskItem', 'tableCell', 'tableHeader'].includes(name)) node.content = [paragraph]
    if (name === 'orderedList') node.content = [{ type: 'listItem', content: [paragraph] }]
    if (name === 'tableRow') node.content = [{ type: 'tableCell', content: [paragraph] }]
    if (name === 'heading' || name === 'codeBlock') node.content = [{ type: 'text', text: 'Text' }]
    let child = node
    if (schema.nodes[name].isInline) child = { type: 'paragraph', content: [node] }
    if (name === 'taskItem') child = { type: 'taskList', content: [node] }
    if (name === 'tableCell' || name === 'tableHeader') child = { type: 'table', content: [{ type: 'tableRow', content: [node] }] }
    if (name === 'tableRow') child = { type: 'table', content: [node] }
    return encode('', doc => prosemirrorJSONToYXmlFragment(schema, { type: 'doc', content: [child] }, doc.getXmlFragment('body')))
  }
  it('covers every current schema attribute explicitly', () => {
    const schema = projection.getDohcProseMirrorSchema()
    const inventory = (types: typeof schema.nodes | typeof schema.marks) => Object.fromEntries(Object.entries(types)
      .map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {})] as const)
      .filter(([, attrs]) => attrs.length > 0))
    expect(inventory(schema.nodes)).toEqual(nodeAttributes)
    expect(inventory(schema.marks)).toEqual({ link: ['href', 'target', 'rel', 'class', 'title'] })
  })
  it.each(Object.entries(nodeAttributes).flatMap(([name, keys]) => keys.map(key => [name, key])))('refuses malformed scalar %s.%s without coercion', (name, key) => {
    const malformed = name === 'taskItem' || ['level', 'start', 'colspan', 'rowspan', 'colwidth', 'height'].includes(key) ? 'wrong' : 5
    refused(nodeCheckpoint(name, { [key]: malformed }))
  })
  it.each(Object.keys(nodeAttributes))('accepts the supported %s defaults', name => {
    accepted(nodeCheckpoint(name, {}))
  })
  it.each([
    ['orderedList', 'start', NaN], ['orderedList', 'start', Infinity],
    ['tableRow', 'height', NaN], ['tableRow', 'height', Infinity],
    ['tableCell', 'colwidth', [80, -Infinity]], ['tableHeader', 'colwidth', [80, Infinity]],
    ['heading', 'level', 0], ['heading', 'level', 7],
  ] as const)('refuses decoded numeric value %s.%s = %s', (name, key, value) => {
    const checkpoint = nodeCheckpoint(name, { [key]: value })
    const decoded = new Y.Doc()
    try {
      Y.applyUpdate(decoded, checkpoint)
      const find = (fragment: Y.XmlFragment): Y.XmlElement | undefined => {
        for (const child of fragment.toArray()) {
          if (!(child instanceof Y.XmlElement)) continue
          if (child.nodeName === name) return child
          const nested = find(child)
          if (nested) return nested
        }
      }
      const attributes = find(decoded.getXmlFragment('body'))?.getAttributes() as Record<string, unknown> | undefined
      expect(attributes).toBeDefined()
      expect(attributes?.[key]).toEqual(value)
    } finally { decoded.destroy() }
    refused(checkpoint)
  })
  it.each([TableCell, TableHeader])('preserves the HTML parser no-width value from $name', extension => {
    const attributes = getExtensionField(extension, 'addAttributes', {
      name: extension.name, options: extension.options, storage: extension.storage,
    })!()
    const parse = attributes.colwidth.parseHTML!
    const element = { getAttribute: (name: string) => name === 'colwidth' ? '80,auto' : null }
    const widths = parse(element as HTMLElement)
    expect(widths[0]).toBe(80)
    expect(Number.isNaN(widths[1])).toBe(true)
    const checkpoint = nodeCheckpoint(extension.name, { colspan: 2, colwidth: widths })
    const evidence = accepted(checkpoint)
    expect(evidence.checkpoint.bytes).toEqual(checkpoint)
    const restored = new Y.Doc()
    try {
      Y.applyUpdate(restored, evidence.checkpoint.bytes)
      const cell = ((restored.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement
      const decodedWidths = (cell.getAttributes() as Record<string, unknown>).colwidth as number[]
      expect(decodedWidths[0]).toBe(80)
      expect(Number.isNaN(decodedWidths[1])).toBe(true)
    } finally { restored.destroy() }
    expect(evidence.projectedMarkdown).toBe(accepted(nodeCheckpoint(extension.name, { colspan: 2, colwidth: [80, 0] })).projectedMarkdown)
  })
  it.each([
    ['heading', { level: 6 }], ['orderedList', { start: 0 }], ['taskItem', { checked: true }],
    ['tableCell', { colspan: 2, rowspan: 2, colwidth: [120, 0], align: 'center' }],
    ['tableHeader', { colwidth: [80], align: 'right' }], ['tableRow', { height: 28.5 }],
    ['callout', { fold: '-' }], ['wikilink', { target: 'Page', label: null }],
  ] as const)('retains valid numeric, array, nullable and enum attributes in %s', (name, attributes) => {
    const checkpoint = nodeCheckpoint(name, attributes)
    expect(accepted(checkpoint).checkpoint.bytes).toEqual(checkpoint)
  })
  it.each(['href', 'target', 'rel', 'class', 'title'])('refuses malformed link %s values', key => {
    for (const value of [5, true, { nested: 'value' }, ['x']]) {
      refused(encode('[text](https://example.com)', doc => {
        const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
        const attrs = text.toDelta()[0].attributes!.link
        text.format(0, text.length, { link: { ...attrs, [key]: value } })
      }))
    }
  })
  it('preserves nullable link attributes and canonical frontmatter bigint', () => {
    const checkpoint = encode('---\ninteger: 9223372036854775807\n---\n\n[text](https://example.com)', doc => {
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      text.format(0, text.length, { link: { href: null, target: null, rel: null, class: null, title: null } })
    })
    const evidence = accepted(checkpoint)
    expect(evidence.projectedMarkdown).toContain('9223372036854775807')
    expect(evidence.projectedMarkdown).toContain('[text]()')
  })
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
  it.each(['Text', '**Text**', '[Text](https://example.com)'])('preserves empty XmlText after deleting all text from %s', markdown => {
    const doc = markdownToYDoc(markdown)
    doc.gc = false
    try {
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      text.delete(0, text.length)
      const checkpoint = Y.encodeStateAsUpdate(doc)
      const evidence = accepted(checkpoint)
      expect(evidence.projectedMarkdown).toBe('')
      expect(evidence.checkpoint.bytes).toEqual(checkpoint)
      expect(evidence.stateUpdate).toEqual(checkpoint)
      expect(accepted(evidence.stateUpdate).projectedMarkdown).toBe('')
      const reopened = new Y.Doc({ gc: false })
      try {
        Y.applyUpdate(reopened, evidence.stateUpdate)
        const paragraph = reopened.getXmlFragment('body').get(0) as Y.XmlElement
        expect(paragraph.length).toBe(1)
        expect(paragraph.get(0)).toBeInstanceOf(Y.XmlText)
        expect((paragraph.get(0) as Y.XmlText).toDelta()).toEqual([])
      } finally { reopened.destroy() }
    } finally { doc.destroy() }
  })
  it('validates nonempty embeds and format attributes beside empty XmlText', () => {
    for (const invalid of ['embed', 'link'] as const) {
      refused(encode('Text', doc => {
        const paragraph = doc.getXmlFragment('body').get(0) as Y.XmlElement
        const text = paragraph.get(0) as Y.XmlText
        paragraph.insert(0, [new Y.XmlText()])
        if (invalid === 'embed') text.insertEmbed(0, { hidden: 'value' })
        else text.format(0, text.length, { link: { href: 42 } })
      }))
    }
  })
  it.each(['image', 'mathBlock', 'bulletList', 'blockquote'])('rejects empty XmlText under %s where the schema forbids text', name => {
    const schema = projection.getDohcProseMirrorSchema()
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }
    const node = schema.nodes[name].create().toJSON()
    if (name === 'bulletList') node.content = [{ type: 'listItem', content: [paragraph] }]
    if (name === 'blockquote') node.content = [paragraph]
    const validCheckpoint = encode('', doc => {
      const body = doc.getXmlFragment('body')
      const child = schema.nodes[name].isInline ? { type: 'paragraph', content: [node] } : node
      prosemirrorJSONToYXmlFragment(schema, { type: 'doc', content: [child] }, body)
    })
    accepted(validCheckpoint)
    const doc = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(doc, validCheckpoint)
      const child = doc.getXmlFragment('body').get(0) as Y.XmlElement
      const parent = schema.nodes[name].isInline ? child.get(0) as Y.XmlElement : child
      parent.insert(0, [new Y.XmlText()])
      refused(Y.encodeStateAsUpdate(doc))
    } finally { doc.destroy() }
  })
  it('keeps invalid roots, nesting and attributes refused beside empty XmlText', () => {
    refused(encode('Text', doc => doc.getXmlFragment('body').insert(0, [new Y.XmlText()])))
    refused(encode('Text', doc => {
      const paragraph = doc.getXmlFragment('body').get(0) as Y.XmlElement
      const nested = new Y.XmlElement('paragraph')
      nested.insert(0, [new Y.XmlText()])
      paragraph.insert(0, [nested])
    }), 'projection-mutated')
    refused(encode('Text', doc => {
      const paragraph = doc.getXmlFragment('body').get(0) as Y.XmlElement
      const text = paragraph.get(0) as Y.XmlText
      text.delete(0, text.length)
      paragraph.setAttribute('unknown', 'hidden')
    }))
    refused(encode('Text', doc => {
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      text.delete(0, text.length)
      text.setAttribute('hidden', 'value')
    }))
  })
  it('counts empty XmlText toward the unchanged public node limit', () => {
    const fixture = (nodes: number) => encode('Text', doc => {
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      text.delete(0, text.length)
      // Paragraph, empty XmlText, and frontmatter array each consume one node.
      doc.getMap('frontmatter').set('values', new Array(nodes - 3).fill(0))
    })
    accepted(fixture(262_144))
    refused(fixture(262_145), 'capacity-refused')
  }, 60_000)
  it.each(['# Heading', '```\nCode\n```'])('preserves valid empty text after deleting %s', markdown => {
    const checkpoint = encode(markdown, doc => {
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      text.delete(0, text.length)
    })
    const evidence = accepted(checkpoint)
    expect(evidence.checkpoint.bytes).toEqual(checkpoint)
    expect(evidence.stateUpdate).toEqual(checkpoint)
    expect(accepted(evidence.stateUpdate).stateUpdate).toEqual(evidence.stateUpdate)
  })
  it('refuses excessive child count before malformed parent attributes', () => {
    const checkpoint = encode('# Text', doc => {
      // Two children, one node of headroom: refuse before the attribute check.
      doc.getMap('frontmatter').set('values', new Array(262_141).fill(0))
      const heading = doc.getXmlFragment('body').get(0) as Y.XmlElement
      heading.insert(1, [new Y.XmlText('x')])
      heading.setAttribute('level', 'hidden')
    })
    refused(checkpoint, 'capacity-refused')
  }, 60_000)
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
  it('preserves real finalizer capacity refusal over pending schema refusal', () => {
    const checkpoint = encode('Text', doc => doc.getMap('meta').set('unknown', 1))
    let sawFinalizerCapacity = false
    const projector = vi.spyOn(projection, 'yDocToMarkdown')
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
    expect(projector).not.toHaveBeenCalled()
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

it('keeps policy constructors outside root exports and pins explicit subpaths', async () => {
  const barrel = await import('./index.js')
  expect(barrel).not.toHaveProperty('createLiveMarkdownRegistrationValidator')
  expect(barrel).not.toHaveProperty('validateRegistrationCutForProjection')
  expect(barrel).not.toHaveProperty('createLiveMarkdownJournalValidator')
  expect(barrel).not.toHaveProperty('validateJournalCutForProjection')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.exports).toEqual({
    '.': './src/index.ts',
    './body-fragment': './src/body-fragment.ts',
    './browser-editor': './src/browser-editor.ts',
    './live-journal-validation': './src/live-journal-validation.ts',
    './image-src': './src/image-src.ts',
    './restore-proof': './src/liveRestoreProof.ts',
    './named-live-provider': './src/namedLiveProvider.ts',
    './named-live-browser-transport': './src/namedLiveBrowserTransport.ts',
  })
})


function journalFixture(edits: ((doc: Y.Doc) => void)[] = []) {
  const doc = markdownToYDoc('Text')
  try {
    const checkpoint = Y.encodeStateAsUpdate(doc)
    const updates = edits.map(edit => {
      const vector = Y.encodeStateVector(doc)
      edit(doc)
      return Y.encodeStateAsUpdate(doc, vector)
    })
    return { ...input(checkpoint), suffix: updates.slice(0, -1), candidate: updates.at(-1) ?? new Uint8Array([0, 0]) }
  } finally { doc.destroy() }
}
const journal = createLiveMarkdownJournalValidator(fixturePolicy)
const editText = (text: string) => (doc: Y.Doc) => {
  ((doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, text)
}
function observeJournalCuts() {
  const actual = ordered.validateJournalCutForProjection
  const scratches: { doc: Y.Doc; finalizations: number }[] = []
  const spy = vi.spyOn(ordered, 'validateJournalCutForProjection').mockImplementation((...args) => {
    const result = actual(...args)
    if (result.kind === 'accepted') {
      const entry = { doc: result.cut.document, finalizations: 0 }
      scratches.push(entry)
      const off = entry.doc.off.bind(entry.doc)
      vi.spyOn(entry.doc, 'off').mockImplementation((...args) => {
        if (args[0] === 'beforeTransaction') entry.finalizations++
        return off(...args)
      })
    }
    return result
  })
  return { spy, scratches }
}

describe('private journal evidence and ownership', () => {
  it('accepts deleting all text as a journal candidate, reopening, and continued editing', () => {
    const call = journalFixture([doc => {
      doc.gc = false
      const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      text.delete(0, text.length)
    }])
    const result = journal(call)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.evidence.projectedMarkdownByteLength).toBe(0)
    expect(result.evidence.projectedMarkdownSha256).toBe(hash(new Uint8Array()))
    const checkpoint = result.evidence.stateUpdate
    expect(accepted(checkpoint).projectedMarkdown).toBe('')
    const reopened = new Y.Doc({ gc: false })
    try {
      Y.applyUpdate(reopened, checkpoint)
      const text = (reopened.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
      expect(text).toBeInstanceOf(Y.XmlText)
      expect(text.toDelta()).toEqual([])
      const before = Y.encodeStateVector(reopened)
      text.insert(0, 'Continued')
      const candidate = Y.encodeStateAsUpdate(reopened, before)
      const continued = journal({ ...input(checkpoint), suffix: [], candidate })
      expect(continued.kind).toBe('accepted')
      if (continued.kind !== 'accepted') return
      expect(accepted(continued.evidence.stateUpdate).projectedMarkdown).toBe('Continued')
      const withDeletedPrefix = journal({ ...call, suffix: [call.candidate], candidate })
      expect(withDeletedPrefix.kind).toBe('accepted')
      if (withDeletedPrefix.kind === 'accepted') expect(withDeletedPrefix.evidence.stateUpdate).toEqual(continued.evidence.stateUpdate)
    } finally { reopened.destroy() }
  })
  it('retains checkpoint and candidate identities with reusable finalized state', () => {
    const call = journalFixture([editText('first '), editText('second ')])
    const result = journal(call)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const evidence = result.evidence
    expect(evidence.checkpointDigest).toBe(hash(call.checkpoint))
    expect(evidence.suffixDigests).toEqual(call.suffix.map(hash))
    expect(evidence.candidate.updateDigest).toBe(hash(call.candidate))
    expect(evidence.stateUpdateSha256).toBe(hash(evidence.stateUpdate))
    expect(evidence.stateUpdateByteLength).toBe(evidence.stateUpdate.byteLength)
    expect(evidence.stateUpdateSha256).not.toBe(evidence.checkpointDigest)
    const originalRanges = Y.decodeUpdate(call.candidate).structs.map(struct => ({ clientId: struct.id.client, startClock: struct.id.clock, endClock: struct.id.clock + struct.length }))
    expect(evidence.candidate.ranges).toEqual(originalRanges)
    const checkpointRanges = [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(call.checkpoint))]
      .map(([clientId, endClock]) => ({ clientId, startClock: 0, endClock }))
    expect(evidence.checkpointRanges).toEqual(checkpointRanges)
    const registered = createLiveMarkdownRegistrationValidator(fixturePolicy)(input(evidence.stateUpdate))
    expect(registered.kind).toBe('accepted')
    if (registered.kind === 'accepted') {
      expect(evidence.projectedMarkdownSha256).toBe(registered.evidence.projectedMarkdownSha256)
      expect(evidence.projectedMarkdownByteLength).toBe(registered.evidence.projectedMarkdownByteLength)
    }
    expect(Object.keys(evidence).sort()).toEqual(['version', 'document', 'currentPath', 'checkpointDigest', 'checkpointRanges', 'suffixDigests', 'candidate', 'projectedMarkdownSha256', 'projectedMarkdownByteLength', 'stateUpdate', 'stateUpdateSha256', 'stateUpdateByteLength'].sort())
    for (const record of [result, evidence, evidence.document, evidence.checkpointRanges, ...evidence.checkpointRanges, evidence.suffixDigests, evidence.candidate, evidence.candidate.ranges, ...evidence.candidate.ranges]) expect(Object.isFrozen(record)).toBe(true)
    const original = evidence.stateUpdate
    evidence.stateUpdate.fill(255)
    call.checkpoint.fill(255); call.suffix[0].fill(255); call.candidate.fill(255)
    call.document.workspaceId = 'changed'; call.currentPath = 'changed.md'
    expect(evidence.stateUpdate).toEqual(original)
    expect(evidence.stateUpdate).not.toBe(evidence.stateUpdate)
    expect(evidence.document).toEqual(document)
    expect(evidence.currentPath).toBe('notes/example.md')
  })

  it('keeps noncanonical original checkpoint digest separate from final encoding', () => {
    const checkpoint = new Uint8Array([0x80, 0, 0])
    const result = journal({ ...input(checkpoint), suffix: [], candidate: new Uint8Array([0, 0]) })
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.evidence.checkpointDigest).toBe(hash(checkpoint))
    expect(result.evidence.stateUpdate).toEqual(new Uint8Array([0, 0]))
    expect(result.evidence.stateUpdateSha256).not.toBe(result.evidence.checkpointDigest)
  })

  it('captures policy once and permits no per-call override', () => {
    const policy = { ...fixturePolicy }
    const validate = createLiveMarkdownJournalValidator(policy)
    policy.maxStructVisits = 1
    expect(validate(journalFixture()).kind).toBe('accepted')
    expect(validate({ ...journalFixture(), policy: fixturePolicy })).toEqual({ kind: 'refused', reason: 'invalid-input', source: 'call' })
    expect(() => createLiveMarkdownJournalValidator({ ...fixturePolicy, maxStructVisits: 0 })).toThrow(TypeError)
  })

  it('captures intrinsic byte views once without invoking hostile instance accessors', () => {
    const call = journalFixture([editText('one '), editText('two ')])
    const hostile = vi.fn(() => { throw new Error('read caller') })
    for (const bytes of [call.checkpoint, ...call.suffix, call.candidate]) {
      for (const key of ['buffer', 'byteOffset', 'byteLength', 'slice', 'subarray', Symbol.iterator]) Object.defineProperty(bytes, key, { get: hostile })
    }
    expect(journal(call).kind).toBe('accepted')
    expect(hostile).not.toHaveBeenCalled()
  })

  it('rejects descriptor, path, sparse and accessor suffix failures at call without reading getters', () => {
    const getter = vi.fn(() => new Uint8Array([0, 0]))
    const accessor = Object.defineProperty([new Uint8Array([0, 0])], '0', { get: getter })
    const hidden = Object.defineProperty([new Uint8Array([0, 0])], '0', { enumerable: false })
    const extra = Object.assign([], { extra: true })
    const call = journalFixture()
    for (const value of [null, [], { ...call, extra: 1 }, { ...call, currentPath: '../bad.md' },
      { ...call, document: { ...document, mainVersionId: 'branch' } },
      Object.defineProperty({ ...call }, 'candidate', { get: getter }),
      ...[new Array(1), accessor, hidden, extra, null, Object.create([])].map(suffix => ({ ...call, suffix })),
    ]) expect(journal(value)).toEqual({ kind: 'refused', reason: 'invalid-input', source: 'call' })
    expect(getter).not.toHaveBeenCalled()
    const excessive = new Array(4095)
    Object.defineProperty(excessive, '0', { get: getter })
    expect(journal({ ...call, suffix: excessive })).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'call' })
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['checkpoint', 'suffix', 'candidate'] as const)('classifies incompatible %s views as call failures', role => {
    const detached = new Uint8Array([0, 0])
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    const resizable = Reflect.construct(ArrayBuffer, [2, { maxByteLength: 4 }]) as ArrayBuffer
    for (const bytes of [detached, new Uint8Array(resizable), new Uint8Array(new SharedArrayBuffer(2)), new Int8Array([0, 0]), new Uint8Array(), null]) {
      const call = journalFixture()
      expect(journal({ ...call, [role]: role === 'suffix' ? [bytes] : bytes })).toEqual({ kind: 'refused', reason: 'invalid-input', source: 'call' })
    }
  })
})

describe('private journal refusal attribution and cleanup', () => {
  it.each(['checkpoint', 'suffix', 'candidate'] as const)('does not diagnose an input-stage %s refusal', role => {
    const call = journalFixture([editText('first '), editText('second ')])
    const probe = observeJournalCuts()
    const registration = vi.spyOn(ordered, 'validateRegistrationCutForProjection')
    expect(journal({ ...call, [role]: role === 'suffix' ? [new Uint8Array([0])] : new Uint8Array([0]) })).toEqual({
      kind: 'refused', reason: 'invalid-update', source: role === 'candidate' ? 'candidate' : 'admitted-cut',
    })
    expect(probe.spy).toHaveBeenCalledOnce()
    expect(registration).not.toHaveBeenCalled()
    expect(probe.scratches).toHaveLength(0)
  })

  it.each([false, true])('diagnoses a valid prefix once after final schema refusal, suffix=%s', withSuffix => {
    const edits = withSuffix ? [editText('prefix ')] : []
    const call = journalFixture([...edits, doc => doc.getMap('meta').set('unknown', 1)])
    const probe = observeJournalCuts()
    const registration = vi.spyOn(ordered, 'validateRegistrationCutForProjection')
    expect(journal(call)).toEqual({ kind: 'refused', reason: 'invalid-schema', source: 'final' })
    expect(probe.spy).toHaveBeenCalledTimes(withSuffix ? 2 : 1)
    expect(registration).toHaveBeenCalledTimes(withSuffix ? 0 : 1)
    for (const entry of probe.scratches) { expect(entry.finalizations).toBe(1); expect(entry.doc.isDestroyed).toBe(true) }
  })

  it.each([false, true])('diagnoses an invalid prefix once without recursion, suffix=%s', withSuffix => {
    const call = withSuffix
      ? journalFixture([doc => doc.getMap('meta').set('unknown', 1), editText('candidate ')])
      : { ...journalFixture(), checkpoint: encode('Text', doc => doc.getMap('meta').set('unknown', 1)) }
    const probe = observeJournalCuts()
    const registration = vi.spyOn(ordered, 'validateRegistrationCutForProjection')
    expect(journal(call)).toEqual({ kind: 'refused', reason: 'invalid-schema', source: 'admitted-cut' })
    expect(probe.spy).toHaveBeenCalledTimes(withSuffix ? 2 : 1)
    expect(registration).toHaveBeenCalledTimes(withSuffix ? 0 : 1)
    for (const entry of probe.scratches) { expect(entry.finalizations).toBe(1); expect(entry.doc.isDestroyed).toBe(true) }
  })

  it.each(['throw', 'transaction', 'destroy'] as const)('finalizes once on projection %s and never diagnoses mutation', action => {
    const probe = observeJournalCuts()
    const registration = vi.spyOn(ordered, 'validateRegistrationCutForProjection')
    const original = projection.yDocToMarkdown
    vi.spyOn(projection, 'yDocToMarkdown').mockImplementation(doc => {
      if (doc === probe.scratches[0]?.doc) {
        if (action === 'transaction') doc.transact(() => {})
        if (action === 'destroy') doc.destroy()
        throw new Error('projection failed')
      }
      return original(doc)
    })
    expect(journal(journalFixture())).toEqual({ kind: 'refused', reason: action === 'throw' ? 'invalid-schema' : 'projection-mutated', source: 'final' })
    expect(probe.spy).toHaveBeenCalledOnce()
    expect(registration).toHaveBeenCalledTimes(action === 'throw' ? 1 : 0)
    expect(probe.scratches[0].finalizations).toBe(1)
    expect(probe.scratches[0].doc.isDestroyed).toBe(true)
  })

  it('keeps admitted prefix capacity refusal and finalizer precedence', () => {
    const call = { ...journalFixture(), checkpoint: encode('Text', doc => doc.getMap('meta').set('unknown', 1)) }
    let witnessed = false
    for (let limit = 1; limit < 500; limit++) {
      const policy = { ...fixturePolicy, maxDecodedPayloadByteVisits: limit }
      const result = ordered.validateJournalCutForProjection({ mode: 'journal-candidate', checkpoint: call.checkpoint, suffix: [], candidate: call.candidate }, policy)
      if (result.kind === 'refused') continue
      const final = result.cut.finishAfterProjection()
      result.cut.document.destroy()
      if (final.kind !== 'refused' || final.reason !== 'capacity-refused') continue
      const prefix = createLiveMarkdownRegistrationValidator(policy)(input(call.checkpoint))
      if (prefix.kind !== 'refused' || prefix.reason !== 'capacity-refused') continue
      expect(createLiveMarkdownJournalValidator(policy)(call)).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'admitted-cut' })
      witnessed = true
      break
    }
    expect(witnessed).toBe(true)
  })
})


describe('journal real cut counterexamples and checkpoint feasibility', () => {
  it.each([false, true])('preserves a failed prefix reason after a different real final cut refusal, invalidPrefix=%s', invalidPrefix => {
    const doc = markdownToYDoc('Text')
    let call: ReturnType<typeof journalFixture>
    try {
      if (invalidPrefix) doc.getMap('meta').set('unknown', 1)
      const checkpoint = Y.encodeStateAsUpdate(doc)
      const vector = Y.encodeStateVector(doc)
      for (let index = 0; index < 32; index++) doc.getMap('frontmatter').set(`key${index}`, index)
      call = { ...input(checkpoint), suffix: [], candidate: Y.encodeStateAsUpdate(doc, vector) }
    } finally { doc.destroy() }
    const cutInput = { mode: 'journal-candidate' as const, checkpoint: call.checkpoint, suffix: [], candidate: call.candidate }
    const measured = ordered.validateJournalCutForProjection(cutInput, fixturePolicy)
    expect(measured.kind).toBe('accepted')
    if (measured.kind !== 'accepted') return
    const limit = measured.cut.usage.indexOperations - 1
    measured.cut.finishAfterProjection(); measured.cut.document.destroy()
    const policy = { ...fixturePolicy, maxIndexOperations: limit }
    const actual = ordered.validateJournalCutForProjection(cutInput, policy)
    expect(actual).toMatchObject({ kind: 'refused', reason: 'capacity-refused', stage: { kind: 'final' } })
    const prefix = createLiveMarkdownRegistrationValidator(policy)(input(call.checkpoint))
    expect(prefix.kind).toBe(invalidPrefix ? 'refused' : 'accepted')
    const probe = observeJournalCuts()
    const registration = vi.spyOn(ordered, 'validateRegistrationCutForProjection')
    expect(createLiveMarkdownJournalValidator(policy)(call)).toEqual({ kind: 'refused',
      reason: invalidPrefix ? 'invalid-schema' : 'capacity-refused', source: invalidPrefix ? 'admitted-cut' : 'final' })
    expect(probe.spy).toHaveBeenCalledOnce()
    expect(registration).toHaveBeenCalledOnce()
    expect(probe.scratches).toHaveLength(0)
  })

  it('keeps a diagnostic projection mutation as an integration failure without further diagnosis', () => {
    const call = journalFixture([editText('prefix '), doc => doc.getMap('meta').set('unknown', 1)])
    const probe = observeJournalCuts()
    const registration = vi.spyOn(ordered, 'validateRegistrationCutForProjection')
    vi.spyOn(projection, 'yDocToMarkdown').mockImplementation(doc => { doc.transact(() => {}); throw new Error('mutation') })
    expect(journal(call)).toEqual({ kind: 'refused', reason: 'projection-mutated', source: 'admitted-cut' })
    expect(probe.spy).toHaveBeenCalledTimes(2)
    expect(registration).not.toHaveBeenCalled()
    for (const entry of probe.scratches) { expect(entry.finalizations).toBe(1); expect(entry.doc.isDestroyed).toBe(true) }
  })

  it('retains candidate Item and GC ranges separately from admitted ranges', () => {
    const call = journalFixture([doc => {
      const paragraph = new Y.XmlElement('paragraph')
      const text = new Y.XmlText('removed')
      paragraph.push([text])
      const body = doc.getXmlFragment('body')
      body.push([paragraph])
      body.delete(body.length - 1, 1)
      doc.getMap('frontmatter').set('retained', true)
    }])
    const decoded = Y.decodeUpdate(call.candidate)
    expect(decoded.structs.some(struct => struct instanceof Y.GC)).toBe(true)
    expect(decoded.structs.some(struct => struct instanceof Y.Item)).toBe(true)
    const result = journal(call)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    for (const struct of decoded.structs) expect(result.evidence.candidate.ranges.some(range => range.clientId === struct.id.client
      && range.startClock <= struct.id.clock && range.endClock >= struct.id.clock + struct.length)).toBe(true)
    const prior = Y.decodeUpdate(call.checkpoint).structs
    for (const range of result.evidence.candidate.ranges) expect(prior.some(struct => struct.id.client === range.clientId
      && struct.id.clock < range.endClock && struct.id.clock + struct.length > range.startClock)).toBe(false)
  })

  it.each([0, 1, 5])('records finalized checkpoint revalidation under the exact measured work policy, suffix=%s', suffixCount => {
    const call = journalFixture(Array.from({ length: suffixCount + 1 }, (_, index) => editText(`${index} `)))
    const measured = ordered.validateJournalCutForProjection({ mode: 'journal-candidate', checkpoint: call.checkpoint, suffix: call.suffix, candidate: call.candidate }, fixturePolicy)
    expect(measured.kind).toBe('accepted')
    if (measured.kind !== 'accepted') return
    const final = measured.cut.finishAfterProjection()
    measured.cut.document.destroy()
    expect(final.kind).toBe('accepted')
    if (final.kind !== 'accepted') return
    const policy = {
      maxStructVisits: Math.max(1, final.usage.structVisits),
      maxValueNodeVisits: Math.max(1, final.usage.valueNodeVisits),
      maxDecodedPayloadByteVisits: Math.max(1, final.usage.decodedPayloadByteVisits),
      maxStructClientGroupVisits: Math.max(1, final.usage.structClientGroupVisits),
      maxDeleteClientGroupVisits: Math.max(1, final.usage.deleteClientGroupVisits),
      maxDeleteIntervalVisits: Math.max(1, final.usage.deleteIntervalVisits),
      maxIndexOperations: Math.max(1, final.usage.indexOperations),
    }
    const result = createLiveMarkdownJournalValidator(policy)(call)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const registration = createLiveMarkdownRegistrationValidator(policy)(input(result.evidence.stateUpdate))
    if (suffixCount <= 1) {
      expect(registration).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'registration-input' })
      expect(createLiveMarkdownJournalValidator(policy)({
        ...input(result.evidence.stateUpdate), suffix: [], candidate: new Uint8Array([0, 0]),
      })).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'admitted-cut' })
    } else expect(registration.kind).toBe('accepted')
  })

  it('applies the final public body limit and repaired attribute domains to journal cuts', () => {
    const oversized = encode('x'.repeat(2 * 1024 * 1024 + 1))
    expect(journal({ ...input(), suffix: [], candidate: oversized })).toEqual({ kind: 'refused', reason: 'capacity-refused', source: 'final' })
    const malformed = encode('Text', doc => (doc.getXmlFragment('body').get(0) as Y.XmlElement).setAttribute('unknown', 'value'))
    expect(journal({ ...input(), suffix: [], candidate: malformed })).toEqual({ kind: 'refused', reason: 'invalid-schema', source: 'final' })
  }, 60_000)
})


it('journal refuses keyed body topology that the generic cut accepts', () => {
  const doc = new Y.Doc({ gc: false })
  doc.getMap('body').set('hidden', 'value')
  doc.getMap('meta').set('schemaVersion', 1)
  const candidate = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  const call = { ...input(), suffix: [], candidate }
  const generic = ordered.validateOrderedLiveUpdateCut({ mode: 'journal-candidate', checkpoint: call.checkpoint, suffix: [], candidate }, fixturePolicy)
  expect(generic.kind).toBe('accepted')
  if (generic.kind === 'accepted') { expect(generic.cut.finishAfterProjection().kind).toBe('accepted'); generic.cut.document.destroy() }
  expect(journal(call)).toEqual({ kind: 'refused', reason: 'invalid-schema', source: 'final' })
})

it('never projects a preserved source that holds text the document lacks', () => {
  const table = '| a | b |\n|---|---|\n| c | d |\n'
  const codeTable = '| `a|b` | c |\n|---|---|---|\n| x | `y|z` |\n'
  const digest = (text: string) => hash(new TextEncoder().encode(text))
  for (const [document, source] of [
    [table, '| a | b |\n|---|---|\n| c | d | hidden |\n'],
    [table, 'a | b\n--- | ---\nc | d | hidden\n'],
    // A header with a pipe inside a code span makes the importer read the
    // table from the raw text, where the row's code span splits too.
    [codeTable, '| `a|b` | c |\n|---|---|---|\n| x | `y|z` | hidden |\n'],
    // An unused link reference definition.
    ['Hello\n', 'Hello\n\n[x]: https://h.example "hidden"\n'],
    // A link with no text.
    ['Hello\n', 'Hello[](https://h.example "hidden")\n'],
    // A second definition of the same label.
    ['[x]: https://a.example\n', '[x]: https://a.example\n[x]: https://b.example "hidden"\n'],
  ]) {
    const canonical = projection.yDocToMarkdown(markdownToYDoc(document))
    const result = validate(input(encode(document, doc => {
      doc.getMap('meta').set('dohcMarkdownSource', source)
      doc.getMap('meta').set('dohcMarkdownSourceSha256', digest(source))
      doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', digest(canonical))
    })))
    expect(result.kind === 'accepted' ? result.evidence.projectedMarkdown : canonical, source).toBe(canonical)
  }
})
