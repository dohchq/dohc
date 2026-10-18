import {createHash} from 'node:crypto'
import {expect, it} from 'vitest'
import * as Y from 'yjs'
import {createEngineMarkdownReader} from './engine-markdown-reader.js'
import {getDohcProseMirrorSchema, markdownToYDoc, yDocToMarkdown} from './import-export.js'
import {yXmlFragmentToProseMirrorRootNode} from 'y-prosemirror'
import {forgedSources} from './artifact-witness.fixture.js'
import rows from './engine-markdown-reader.fixture.json'
import {resolveMarkdownSource} from './artifact-markdown.js'

const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000}
const bytesReader = createEngineMarkdownReader(policy)
// Fixtures stay readable; production accepts bytes only.
const reader = {
  construct(input: Omit<Parameters<typeof bytesReader.construct>[0], 'source'> & {source: string}) {
    return bytesReader.construct({...input, source: new TextEncoder().encode(input.source)})
  },
  prove(input: Omit<Parameters<typeof bytesReader.prove>[0], 'source'> & {source: string}) {
    return bytesReader.prove({...input, source: new TextEncoder().encode(input.source)})
  },
}
const document = {workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage'}
const context = {document, currentPath: 'note.md'}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function bind(doc: Y.Doc, source: string) {
  const meta = doc.getMap('meta')
  meta.set('dohcMarkdownSource', source)
  meta.set('dohcMarkdownSourceSha256', sha(source))
  meta.set('dohcMarkdownSourceProjectionSha256', sha(yDocToMarkdown(doc)))
}
function tree(doc: Y.Doc) {return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('body'), getDohcProseMirrorSchema())}

it('owns source bytes before inspecting the checkpoint', () => {
  const base = markdownToYDoc('Earlier'), source = new TextEncoder().encode('- parent\n  - child\n')
  const expected = source.slice(), checkpoint = Y.encodeStateAsUpdate(base)
  try {
    const result = bytesReader.construct({...context, source, get checkpoint() {source.fill(120); return checkpoint}})
    expect(result.kind).toBe('accepted')
    if (result.kind === 'accepted') expect(result.sourceSha256).toBe(createHash('sha256').update(expected).digest('hex'))
  } finally {base.destroy()}
})

it('refuses a stale projection hash when source differs from canonical output', () => {
  const source = '* parent\n  * child\n', doc = markdownToYDoc(source)
  try {
    expect(source).not.toBe(yDocToMarkdown(doc))
    bind(doc, source)
    doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', sha('stale'))
    expect(reader.prove({...context, source, checkpoint: Y.encodeStateAsUpdate(doc)}).kind).toBe('refused')
  } finally {doc.destroy()}
})

it('reads source and checkpoint once and owns both before other input access', () => {
  const base = markdownToYDoc('Earlier'), source = new TextEncoder().encode('- parent\n  - child\n')
  const checkpoint = Y.encodeStateAsUpdate(base), expectedSha = createHash('sha256').update(source).digest('hex')
  let sourceReads = 0, checkpointReads = 0
  try {
    const result = bytesReader.construct({
      get source() {sourceReads++; return source},
      get checkpoint() {checkpointReads++; return checkpoint},
      get document() {source.fill(255); checkpoint.fill(255); return document},
      currentPath: context.currentPath,
    })
    expect(sourceReads).toBe(1); expect(checkpointReads).toBe(1)
    expect(result).toMatchObject({kind: 'accepted', sourceSha256: expectedSha})
  } finally {base.destroy()}
})

it('owns checkpoint bytes before reading document metadata', () => {
  const base = markdownToYDoc('Earlier'), checkpoint = Y.encodeStateAsUpdate(base)
  try {
    const result = bytesReader.construct({source: new TextEncoder().encode('- parent\n  - child\n'), checkpoint, currentPath: context.currentPath,
      get document() {checkpoint.fill(255); return document}})
    expect(result.kind).toBe('accepted')
  } finally {base.destroy()}
})

it.each(rows)('constructs and replays the desktop reading: $name', row => {
  const base = markdownToYDoc(row.earlier, {clientID: 1234})
  const checkpoint = Y.encodeStateAsUpdate(base)
  const result = reader.construct({...context, source: row.source, checkpoint})
  if (!row.accepted) expect(result).toEqual({kind: 'refused', reason: 'invalid-schema'})
  else {
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
    const replay = new Y.Doc({gc: false}), imported = markdownToYDoc(row.source)
    try {
      Y.applyUpdate(replay, checkpoint); Y.applyUpdate(replay, result.delta)
      expect(tree(replay).eq(tree(imported))).toBe(true)
      expect(replay.getMap('frontmatter').toJSON()).toEqual(imported.getMap('frontmatter').toJSON())
      expect(Y.decodeStateVector(result.stateVector).has(1234)).toBe(true)
      expect(Y.encodeStateVector(replay)).toEqual(result.stateVector)
      expect(result.canonical).toBe(yDocToMarkdown(imported))
      expect(result.sourceSha256).toBe(sha(row.source))
      expect(result.sourceByteLength).toBe(new TextEncoder().encode(row.source).length)
      expect(replay.getMap('meta').get('dohcMarkdownSource')).toBe(row.source)
      expect(replay.getMap('meta').get('dohcMarkdownSourceSha256')).toBe(sha(row.source))
      expect(replay.getMap('meta').get('dohcMarkdownSourceProjectionSha256')).toBe(sha(result.canonical))
      const proof = reader.prove({...context, source: row.source, checkpoint: Y.encodeStateAsUpdate(replay)})
      expect(proof).toMatchObject({kind: 'accepted', canonical: result.canonical,
        stateSha256: result.stateSha256, stateVector: result.stateVector})
    } finally {replay.destroy(); imported.destroy()}
  }
  expect(Y.encodeStateAsUpdate(base)).toEqual(checkpoint)
  base.destroy()
})

it.each(forgedSources)('requires the actual snapshot for the #2116 vector: %s', source => {
  const doc = markdownToYDoc(source)
  try {
    bind(doc, source)
    const checkpoint = Y.encodeStateAsUpdate(doc)
    expect(reader.prove({...context, source: 'The actual file', checkpoint}).kind).toBe('refused')
    // E may keep these bytes only when the engine actually holds this source.
    expect(reader.prove({...context, source, checkpoint}).kind).toBe('accepted')
    const base = markdownToYDoc('Earlier\n')
    try {expect(reader.construct({...context, source, checkpoint: Y.encodeStateAsUpdate(base)}).kind).toBe('accepted')}
    finally {base.destroy()}
  } finally {doc.destroy()}
})

it.each(['literal', 'href', 'title', 'target', 'rel', 'class', 'source digest', 'projection digest', 'partial', 'stale'])(
  'refuses a forged %s even with matching canonical spelling where possible', kind => {
    const source = '- **bold** and [label](https://example.com)\n  - child\n'
    const doc = markdownToYDoc(kind === 'literal' ? '- \\*\\*bold\\*\\* and [label](https://example.com)\n  - child\n' : source)
    try {
      if (['href', 'title', 'target', 'rel', 'class'].includes(kind)) {
        const first = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlElement
        const text = ((first.get(0) as Y.XmlElement).get(0) as Y.XmlText)
        expect(text.toString()).toContain('label')
        const at = text.toDelta().map((part: {insert: unknown}) => part.insert).join('').indexOf('label')
        expect(at).toBeGreaterThanOrEqual(0)
        text.format(at, 5, {link: {href: kind === 'href' ? 'https://other.example' : 'https://example.com',
          title: kind === 'title' ? 'foreign' : null, target: kind === 'target' ? '_blank' : null,
          rel: kind === 'rel' ? 'foreign' : null, class: kind === 'class' ? 'foreign' : null}})
      }
      bind(doc, source)
      if (kind === 'source digest') doc.getMap('meta').set('dohcMarkdownSourceSha256', '0'.repeat(64))
      if (kind === 'projection digest') doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', '0'.repeat(64))
      if (kind === 'partial') doc.getMap('meta').delete('dohcMarkdownSourceSha256')
      if (kind === 'stale') doc.getMap('frontmatter').set('title', 'Changed')
      expect(reader.prove({...context, source, checkpoint: Y.encodeStateAsUpdate(doc)}).kind).toBe('refused')
    } finally {doc.destroy()}
  },
)

it('refuses literal markup even when the old string-only proof accepts it', () => {
  const source = '- **bold**\n  - child\n', doc = markdownToYDoc('- bold\n  - child\n')
  try {
    const item = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlElement
    const text = (item.get(0) as Y.XmlElement).get(0) as Y.XmlText
    text.delete(0, text.length); text.insert(0, '**bold**')
    bind(doc, source)
    expect(resolveMarkdownSource(doc, yDocToMarkdown(doc)).kind).toBe('verified')
    expect(reader.prove({...context, source, checkpoint: Y.encodeStateAsUpdate(doc)})).toMatchObject({kind: 'refused', reason: 'reading-mismatch'})
  } finally {doc.destroy()}
})

it('differentially checks generated block and inline combinations against desktop import', () => {
  const base = markdownToYDoc('Earlier')
  const checkpoint = Y.encodeStateAsUpdate(base)
  try {
    for (const marker of ['-', '*', '+', '1.', '1)', '- [x]', '- [ ]']) {
      for (const text of ['Plain prose.', '**bold**', '*italic*', '_italic_', '~~**bold**~~', '`Vec<T>`', '[[a & b]]', '[label](https://example.com)', 'a & b']) {
        const source = `${marker} ${text}\n    - child\n    - sibling\n\nParagraph ${text}\n`
        const result = reader.construct({...context, source, checkpoint})
        expect(result.kind, source).toBe('accepted')
        if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
        const replay = new Y.Doc(), imported = markdownToYDoc(source)
        try {
          Y.applyUpdate(replay, checkpoint); Y.applyUpdate(replay, result.delta)
          expect(tree(replay).eq(tree(imported)), source).toBe(true)
          expect(Y.encodeStateVector(replay)).toEqual(result.stateVector)
        } finally {replay.destroy(); imported.destroy()}
      }
    }
  } finally {base.destroy()}
})

it('updates frontmatter styles and values without losing the existing body lineage', () => {
  const base = markdownToYDoc('---\nz: old\nremove: yes\n---\n\n- a\n  - child\n')
  const source = '---\nz: "new"\na: 12\n---\n\n- a\n  - child\n\n'
  try {
    const checkpoint = Y.encodeStateAsUpdate(base), item = base.getXmlFragment('body').get(0)
    const result = reader.construct({...context, checkpoint, source})
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
    Y.applyUpdate(base, result.delta)
    expect(base.getXmlFragment('body').get(0)).toBe(item)
    expect(base.getMap('frontmatter').toJSON()).toEqual({z: 'new', a: 12})
    expect(reader.prove({...context, checkpoint: Y.encodeStateAsUpdate(base), source}).kind).toBe('accepted')
  } finally {base.destroy()}
})

it('checks bounds and well-formed source before decoding a checkpoint', () => {
  for (const source of [new Uint8Array(2 * 1024 * 1024 + 1), new Uint8Array([0xed, 0xa0, 0x80])]) {
    expect(bytesReader.construct({...context, checkpoint: new Uint8Array([255]), source})).toMatchObject({kind: 'refused', reason: 'invalid-source'})
  }
})

it('refuses malformed checkpoints and unknown public metadata', () => {
  expect(reader.construct({...context, checkpoint: new Uint8Array([255]), source: 'text'}).kind).toBe('refused')
  const doc = markdownToYDoc('- parent\n  - child\n')
  try {
    doc.getMap('meta').set('unrecognized', true)
    expect(reader.construct({...context, checkpoint: Y.encodeStateAsUpdate(doc), source: '- parent\n  - other\n'}))
      .toMatchObject({kind: 'refused', reason: 'journal-refused'})
  } finally {doc.destroy()}
})

it.each(['- parent\n  - child\n', '---\nz: "kept"\na: one\n---\n\n- parent\n  - child\n', '---\r\na: one\r\n---\r\n\r\nBody\r\n'])('construct is idempotent for %j', source => {
  const base = markdownToYDoc('Earlier')
  try {
    const first = reader.construct({...context, source, checkpoint: Y.encodeStateAsUpdate(base)})
    expect(first.kind).toBe('accepted')
    if (first.kind !== 'accepted') throw new Error(JSON.stringify(first))
    Y.applyUpdate(base, first.delta)
    const second = reader.construct({...context, source, checkpoint: Y.encodeStateAsUpdate(base)})
    expect(second.kind).toBe('accepted')
    if (second.kind !== 'accepted') throw new Error(JSON.stringify(second))
    const decoded = Y.decodeUpdate(second.delta)
    expect(decoded.structs).toHaveLength(0)
    expect(decoded.ds.clients.size).toBe(0)
  } finally {base.destroy()}
})

it('records only changed source-item keys, and only for kept frontmatter', () => {
  const source = '---\nz: "kept"\na: old\n---\n\nBody', base = markdownToYDoc(source)
  try {
    const prefix = 'dohcFrontmatterSourceItem:'
    const oldItem = base.getMap('meta')._map.get(prefix + 'z')!.id
    const result = reader.construct({...context, source: source.replace('a: old', 'a: new'), checkpoint: Y.encodeStateAsUpdate(base)})
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
    Y.applyUpdate(base, result.delta)
    expect(base.getMap('meta')._map.get(prefix + 'z')!.id).toEqual(oldItem)
    const canonical = reader.construct({...context, source: '---\na: new\nz: kept\n---\n\nBody', checkpoint: Y.encodeStateAsUpdate(base)})
    expect(canonical.kind).toBe('accepted')
    if (canonical.kind !== 'accepted') throw new Error(JSON.stringify(canonical))
    Y.applyUpdate(base, canonical.delta)
    expect([...base.getMap('meta').keys()].filter(key => key.startsWith(prefix))).toEqual([])
  } finally {base.destroy()}
})

it.each(['A\n\nC', 'A\n\nB changed\n\nC'])('preserves the boundary block identities for %j', source => {
  const base = markdownToYDoc('A\n\nB\n\nC')
  try {
    const body = base.getXmlFragment('body'), [a, b, c] = body.toArray()
    const result = reader.construct({...context, source, checkpoint: Y.encodeStateAsUpdate(base)})
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
    Y.applyUpdate(base, result.delta)
    expect(body.get(0)).toBe(a)
    expect(body.get(body.length - 1)).toBe(c)
    if (body.length === 2) expect(b!._item!.deleted).toBe(true)
    else expect((body.get(1) as Y.XmlElement).toString()).toContain('B changed')
  } finally {base.destroy()}
})

it('never seeds a missing lineage', () => {
  const empty = new Y.Doc(), missing = markdownToYDoc('Earlier')
  missing.getMap('meta').delete('schemaVersion')
  try {
    for (const doc of [empty, missing]) {
      expect(reader.construct({...context, source: 'Body', checkpoint: Y.encodeStateAsUpdate(doc)}))
        .toEqual({kind: 'refused', reason: 'invalid-schema'})
    }
  } finally {empty.destroy(); missing.destroy()}
})

it('binds UTF-8 bytes without stripping a BOM or replacing invalid input', () => {
  const base = markdownToYDoc('Earlier'), rawReader = createEngineMarkdownReader(policy)
  try {
    const checkpoint = Y.encodeStateAsUpdate(base), source = new TextEncoder().encode('\ufeff- parent\n  - child\n')
    const result = rawReader.construct({...context, source: source, checkpoint})
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') throw new Error(JSON.stringify(result))
    expect(result.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'))
    Y.applyUpdate(base, result.delta)
    expect(base.getMap('meta').get('dohcMarkdownSource')).toBe(new TextDecoder('utf-8', {ignoreBOM: true}).decode(source))
    expect(rawReader.prove({...context, source: source, checkpoint: Y.encodeStateAsUpdate(base)}).kind).toBe('accepted')
    for (const invalid of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xed, 0xa0, 0x80])]) {
      expect(rawReader.construct({...context, source: invalid, checkpoint})).toEqual({kind: 'refused', reason: 'invalid-source'})
      expect(rawReader.prove({...context, source: invalid, checkpoint})).toEqual({kind: 'refused', reason: 'invalid-source'})
    }
  } finally {base.destroy()}
})
