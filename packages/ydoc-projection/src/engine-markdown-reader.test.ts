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
const reader = createEngineMarkdownReader(policy)
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
  for (const source of ['x'.repeat(2 * 1024 * 1024 + 1), '\ud800']) {
    expect(reader.construct({...context, checkpoint: new Uint8Array([255]), source})).toMatchObject({kind: 'refused', reason: 'invalid-source'})
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
