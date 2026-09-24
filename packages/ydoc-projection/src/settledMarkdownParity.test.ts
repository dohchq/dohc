import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'
import { getDohcProseMirrorSchema, markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { createSettledMarkdownProjector } from './liveDocumentValidation.js'

// The engine settle (`project_ydoc_with_store`) writes these bytes. Yjs vectors
// are written here; yrs vectors are written by the Rust test that asserts both
// files (crates/dohc-engine-sync/tests/settle_parity.rs).
const fixtures = new URL('../../../crates/dohc-engine-sync/tests/settle-parity/', import.meta.url)
const yjsFixture = new URL('yjs.json', fixtures)
const yrsFixture = new URL('yrs.json', fixtures)
type Vector = { name: string; updates: string[]; markdown: string }

const project = createSettledMarkdownProjector({
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000,
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (update: string) => new Uint8Array(Buffer.from(update, 'base64'))

// What the desktop seeds for a file it opens (ydocLiveAdapter): the parsed
// document, plus the file's exact bytes when they differ from its projection.
function seed(markdown: string): Y.Doc {
  const doc = markdownToYDoc(markdown)
  const projection = yDocToMarkdown(doc)
  if (projection !== markdown) {
    const meta = doc.getMap('meta')
    meta.set('dohcMarkdownSource', markdown)
    meta.set('dohcMarkdownSourceSha256', hash(markdown))
    meta.set('dohcMarkdownSourceProjectionSha256', hash(projection))
  }
  return doc
}

// The editor binding applies each editor state to the Y.Doc with updateYFragment.
function editBody(doc: Y.Doc, markdown: string): void {
  const target = markdownToYDoc(markdown)
  try {
    const node = yXmlFragmentToProseMirrorRootNode(target.getXmlFragment('body'), getDohcProseMirrorSchema())
    updateYFragment(doc, doc.getXmlFragment('body'), node, { mapping: new Map(), isOMark: new Map() })
  } finally { target.destroy() }
}

function lineage(base: Y.Doc, ...edits: ((doc: Y.Doc) => void)[]): string[] {
  const updates = [Y.encodeStateAsUpdate(base)]
  base.on('update', (update: Uint8Array) => updates.push(update))
  for (const edit of edits) base.transact(() => edit(base))
  base.destroy()
  return updates.map(update => Buffer.from(update).toString('base64'))
}

const RICH = [
  '# Plan',
  '',
  'Some **bold**, _italic_, `code`, ~~gone~~ and a [link](https://example.com "Title").',
  '',
  '- one',
  '  - nested',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] open task',
  '- [x] done task',
  '',
  '> quoted',
  '',
  '> [!note] Callout title',
  '> Callout body',
  '',
  '```ts',
  'const value = 1',
  '```',
  '',
  '| Left | Right |',
  '| :--- | ---: |',
  '| a | b |',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  'Inline $y$ math, a [[Wiki Page|label]] and ![alt](image.png).',
  '',
  '---',
  '',
  'Tail 🦀 世界.',
].join('\n')

// Lexical variants: exact bytes differ from the projection, so the source is kept.
const LEXICAL = [
  '# Shared\n\nStarting together.\n',
  'Some *emphasis* and __strong__ text.\n',
  '* star bullet\n* another\n',
  '+ plus bullet\n',
  '1) paren item\n2) next\n',
  'Setext heading\n==============\n\nBody\n',
  '~~~\nfenced\n~~~\n',
  'Line with hard break  \nnext line\n',
  '***\n',
  'Trailing spaces   \n\n\nExtra blank lines\n',
  'Left | Right\n--- | ---\na | b\n',
  '<https://example.com>\n',
  'Escaped \\* star\n',
  '---\ntitle: Plan\n---\nBody without a blank line\n',
  '---\ntitle:   spaced\n---\n\nBody\n',
  'CRLF *variant*\r\n\r\nSecond\r\n',
  '    indented code\n',
  '# Heading #\n',
  '- [X] capital task\n',
  'Paragraph one\n\n\n\nParagraph two\n',
  '# Title\n\nBody\n\n\n',
  '\n\n# Leading blank lines\n',
  '---\ntitle: "Quoted"\n---\n\nBody\n',
  '---\ntags: [a, b]\n---\n\nBody\n',
  '---\ncount: 007\nratio: 1.50\nflag: yes\nempty:\n---\n\nBody\n',
  '---\ntitle: Only frontmatter\n---\n',
  '---\r\ntitle: CRLF\r\n---\r\n\r\nBody\r\n',
  '- [ ] a\n- [x] b\n\n1. one\n2. two\n\n3. three\n',
  '> quote\n>\n> more\n',
  '```js\ncode\n```\n\n\n',
  '<!-- dohc:table row-heights=1:84 -->\n| a | b |\n| --- | --- |\n| c | d |\n',
  'Line one\nLine two\n',
  '# **Bold** title   \n',
  'Text with <angle> & ampersand\n',
  '| not | annotated |\n| --- | --- |\n| x | y |\n',
  '---\npriority: !custom high\n---\n\n\n\nBody\n',
  '---\n---\n\nEmpty frontmatter\n',
  '---\nunclosed: frontmatter\n\nBody\n',
]

function yjsVectors(): Vector[] {
  const vectors: Vector[] = []
  const add = (name: string, updates: string[]) => {
    const result = project({ checkpoint: bytes(updates[0]!), updates: updates.slice(1).map(bytes) })
    if (result.kind !== 'projected') throw new Error(`${name}: ${result.reason}`)
    vectors.push({ name, updates, markdown: result.markdown })
  }
  add('empty', lineage(markdownToYDoc('')))
  add('rich', lineage(seed(RICH)))
  LEXICAL.forEach((markdown, index) => add(`lexical-${index}`, lineage(seed(markdown))))
  add('source-stale-after-edit', lineage(seed('# Shared\n\nStarting together.\n'), doc => editBody(doc, '# Shared\n\nStarting together, edited.')))
  add('source-edit-then-revert', lineage(seed('# Shared\n\nStarting together.\n'),
    doc => editBody(doc, '# Shared\n\nStarting apart.'), doc => editBody(doc, '# Shared\n\nStarting together.')))
  add('source-forged-active', lineage(seed('# Shared\n\nStarting together.\n'), doc => {
    doc.getMap('meta').set('dohcMarkdownSource', 'Foreign source')
    doc.getMap('meta').set('dohcMarkdownSourceSha256', hash('Foreign source'))
  }))
  add('source-forged-stale', lineage(seed('# Shared\n\nStarting together.\n'), doc => {
    doc.getMap('meta').set('dohcMarkdownSource', 'Foreign source')
    doc.getMap('meta').set('dohcMarkdownSourceSha256', hash('Foreign source'))
    doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', hash('another projection'))
  }))
  add('source-wrong-hash', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').set('dohcMarkdownSourceSha256', '0'.repeat(64))))
  add('source-missing', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').delete('dohcMarkdownSource')))
  add('source-wrong-type', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').set('dohcMarkdownSource', { text: 'source' })))
  add('source-invalid-witness', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', 'not-a-digest')))
  add('source-uppercase-witness', lineage(seed('# Shared\n\nStarting together.\n'), doc => {
    const meta = doc.getMap('meta')
    meta.set('dohcMarkdownSourceProjectionSha256', (meta.get('dohcMarkdownSourceProjectionSha256') as string).toUpperCase())
  }))
  add('tagged', lineage(seed('---\npriority: !custom high\n---\n\nBody\n')))
  add('tagged-crlf', lineage(seed('---\r\npriority: !custom high\r\n---\r\n\r\nBody\r\n\r\nNext\r\n')))
  add('tagged-body-edit', lineage(seed('---\npriority: !custom high\n---\n\nBody\n'), doc => editBody(doc, 'Body, edited')))
  add('tagged-frontmatter-edit', lineage(seed('---\npriority: !custom high\n---\n\nBody\n'), doc => doc.getMap('frontmatter').set('priority', 'low')))
  add('crlf-one-line', lineage(seed('Hello\r\n')))
  add('crlf-edit', lineage(seed('# Title\r\n\r\nFirst\r\n'), doc => editBody(doc, '# Title\n\nFirst\n\nSecond')))
  add('frontmatter-edits', lineage(seed('---\ntitle: Plan\ntags:\n  - a\n---\n\nBody\n'),
    doc => doc.getMap('frontmatter').set('status', 'done'),
    doc => doc.getMap('frontmatter').set('count', 3),
    doc => doc.getMap('frontmatter').set('tags', ['a', 'b']),
    doc => doc.getMap('frontmatter').delete('title')))
  add('rich-edits', lineage(seed(RICH),
    doc => editBody(doc, RICH.replace('- two', '- two\n- three').replace('- [ ] open task', '- [x] open task')),
    doc => editBody(doc, RICH.replace('Tail', 'New **tail** with `code`'))))
  add('delete-everything', lineage(seed(RICH), doc => editBody(doc, '')))
  add('typed-markdown-characters', lineage(seed('Plain\n'), doc => {
    // Typing characters that Markdown reads as syntax, with no input rule firing.
    const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
    text.insert(text.length, ' 5 * 3, _x_, `y`, [z](w), <b>, a\\b, ~~s~~, $m$, [[p]], | pipe')
    doc.getXmlFragment('body').push([new Y.XmlElement('paragraph')])
    ;((doc.getXmlFragment('body').get(1) as Y.XmlElement)).insert(0, [new Y.XmlText('# not a heading')])
    doc.getXmlFragment('body').push([new Y.XmlElement('paragraph')])
    ;((doc.getXmlFragment('body').get(2) as Y.XmlElement)).insert(0, [new Y.XmlText('- not a list, 1. nor this, > nor a quote')])
  }))
  add('successor-epoch', lineage((() => {
    const doc = markdownToYDoc('# Resolved\n\nChosen text')
    doc.getMap('meta').set('dohcLineageEpoch', 'epoch-tag')
    return doc
  })(), doc => editBody(doc, '# Resolved\n\nChosen text, edited')))
  {
    // Two devices edit from the same base; the relay holds both deltas in arrival order.
    const base = seed('# Trip\n\nDay one.\n')
    const baseUpdate = Y.encodeStateAsUpdate(base)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, baseUpdate)
    // Fixed client ids keep the merge order of the two edits stable across regenerations.
    base.clientID = 1
    peer.clientID = 2
    const updates = [baseUpdate]
    base.on('update', (update: Uint8Array) => updates.push(update))
    peer.on('update', (update: Uint8Array) => updates.push(update))
    editBody(base, '# Trip\n\nDay one, by the sea.')
    editBody(peer, '# Trip\n\nDay one.\n\nDay two, in the hills.')
    base.destroy(); peer.destroy()
    add('concurrent-devices', updates.map(update => Buffer.from(update).toString('base64')))
  }
  return vectors
}

const read = (url: URL) => JSON.parse(readFileSync(url, 'utf8')) as Vector[]
if (process.env.DOHC_WRITE_SETTLE_PARITY_VECTORS === '1') {
  writeFileSync(yjsFixture, '[\n' + yjsVectors().map(vector => JSON.stringify(vector)).join(',\n') + '\n]\n')
}

describe('settled Markdown projection', () => {
  it('regenerates the committed Yjs vectors with the same Markdown', () => {
    const committed = new Map(read(yjsFixture).map(vector => [vector.name, vector.markdown]))
    const fresh = yjsVectors()
    expect(fresh.map(vector => vector.name)).toEqual([...committed.keys()])
    for (const vector of fresh) expect(vector.markdown, vector.name).toBe(committed.get(vector.name))
  })

  it.each([...read(yjsFixture), ...read(yrsFixture)])('matches the engine settle for $name', vector => {
    const [checkpoint, ...updates] = vector.updates.map(bytes)
    const result = project({ checkpoint: checkpoint!, updates })
    expect(result).toMatchObject({ kind: 'projected', markdown: vector.markdown,
      markdownSha256: hash(vector.markdown), markdownByteLength: Buffer.byteLength(vector.markdown) })
    if (result.kind !== 'projected') return
    const merged = project({ checkpoint: result.state, updates: [] })
    expect(merged).toMatchObject({ kind: 'projected', markdown: vector.markdown })
  })

  it('matches the engine projection for every shared bootstrap vector', () => {
    const bootstrap = JSON.parse(readFileSync(new URL('../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json', import.meta.url), 'utf8')) as { name: string; bytes: number[]; markdown: string }[]
    for (const vector of bootstrap) {
      expect(project({ checkpoint: new Uint8Array(vector.bytes), updates: [] }), vector.name)
        .toMatchObject({ kind: 'projected', markdown: vector.markdown })
    }
  })

  it('keeps preserved source only while its witness names the current projection', () => {
    const vectors = new Map(read(yjsFixture).map(vector => [vector.name, vector.markdown]))
    expect(vectors.get('lexical-0')).toBe('# Shared\n\nStarting together.\n')
    expect(vectors.get('source-edit-then-revert')).toBe('# Shared\n\nStarting together.\n')
    for (const name of ['source-stale-after-edit', 'source-forged-active', 'source-forged-stale', 'source-wrong-hash',
      'source-missing', 'source-wrong-type', 'source-invalid-witness', 'source-uppercase-witness']) {
      expect(vectors.get(name), name).not.toMatch(/\n$|Foreign/)
    }
  })

  it('refuses a document above the live-editing limit', () => {
    const doc = markdownToYDoc(`${'x'.repeat(2 * 1024 * 1024)}y`)
    try {
      expect(project({ checkpoint: Y.encodeStateAsUpdate(doc), updates: [] })).toEqual({ kind: 'refused', reason: 'capacity-refused' })
    } finally { doc.destroy() }
  })

  it('refuses active preserved source above the live-editing limit and ignores stale source', () => {
    for (const stale of [false, true]) {
      const doc = markdownToYDoc('Body')
      try {
        const source = `Body${'\n'.repeat(2 * 1024 * 1024)}`
        const meta = doc.getMap('meta')
        meta.set('dohcMarkdownSource', source)
        meta.set('dohcMarkdownSourceSha256', hash(source))
        meta.set('dohcMarkdownSourceProjectionSha256', hash(stale ? 'older projection' : 'Body'))
        expect(project({ checkpoint: Y.encodeStateAsUpdate(doc), updates: [] })).toMatchObject(
          stale ? { kind: 'projected', markdown: 'Body' } : { kind: 'refused', reason: 'capacity-refused' })
      } finally { doc.destroy() }
    }
  })

  it('refuses metadata that changes the TypeScript projection but not the engine one', () => {
    const doc = markdownToYDoc('A\r\n\r\nB\r\n')
    try {
      doc.getMap('meta').set('contentKind', 'plain-text')
      expect(project({ checkpoint: Y.encodeStateAsUpdate(doc), updates: [] })).toEqual({ kind: 'refused', reason: 'invalid-schema' })
    } finally { doc.destroy() }
  })
})
