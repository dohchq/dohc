import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'
import { getDohcProseMirrorSchema, markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { requireEngineBinaryOrSkip } from '../../../apps/desktop/src/testing/engineBinary.js'
import { DOCUMENT_PROJECTION_LIMITS, startEngineProjection, type EngineProjection } from '../../../services/sync-relay/src/engineProjection.js'
import { encodeFrame } from '../../workspace-engine-client/src/daemon/engineClient.js'

// The relay derives a shared document's file with the engine's `ydoc.project`,
// which writes the bytes an owner device settles. The Yjs vectors are written
// here from desktop-style updates, with Markdown from that method; the yrs
// vectors are written by the Rust test, which asserts both files too
// (crates/dohc-engine-sync/tests/settle_parity.rs).
const fixtures = new URL('../../../crates/dohc-engine-sync/tests/settle-parity/', import.meta.url)
const yjsFixture = new URL('yjs.json', fixtures)
const yrsFixture = new URL('yrs.json', fixtures)
type Vector = { name: string; updates: string[]; markdown: string }

const engine = requireEngineBinaryOrSkip()
// The relay's own limits, with generous deadlines for a debug engine on a loaded machine.
const projection = engine.path === null ? undefined : await startEngineProjection({ ...DOCUMENT_PROJECTION_LIMITS,
  engineExecutable: engine.path, maxQueued: 1_024, maxQueuedBytes: 1024 * 1024 * 1024, deadlineMs: 120_000, connectTimeoutMs: 120_000 })
afterAll(() => projection?.close())
const TIMEOUT_MS = 300_000

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (update: string) => new Uint8Array(Buffer.from(update, 'base64'))
const project = (updates: Uint8Array[]): Promise<EngineProjection> => projection!.project({ contentKind: 'richdoc', updates })
async function markdownOf(updates: Uint8Array[]): Promise<string> {
  const result = await project(updates)
  if (result.kind !== 'projected') throw new Error(`${result.reason}: ${result.message}`)
  return result.content.toString('utf8')
}

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

// Source bound to the engine's own projection of the document, as any
// collaborator's crafted update can bind it.
async function witnessed(doc: Y.Doc, source: string): Promise<Y.Doc> {
  const canonical = await markdownOf([Y.encodeStateAsUpdate(doc)])
  const meta = doc.getMap('meta')
  meta.set('dohcMarkdownSource', source)
  meta.set('dohcMarkdownSourceSha256', hash(source))
  meta.set('dohcMarkdownSourceProjectionSha256', hash(canonical))
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

// YAML scalars that js-yaml and the engine's loader read differently. The Rust
// test imports the same files through the engine.
const YAML = {
  'non-finite': '---\nnan: .nan\ninf: .inf\nneg: -.inf\n---\n\nBody\n',
  'beyond-i64': '---\nbig: 9223372036854775808\nsmall: -9223372036854775809\n---\n\nBody\n',
  'negative-zero': '---\nzero: -0\nfloat: -0.0\n---\n\nBody\n',
  'explicit-int': '---\ntagged: !!int 7\noctal: !!int 0o7\n---\n\nBody\n',
  'separated-radix': '---\nhex: 0x_1F\nbin: 0b1010_1010\nsep: 1_000\n---\n\nBody\n',
}

async function yjsVectors(): Promise<Vector[]> {
  const vectors: Vector[] = []
  const add = async (name: string, updates: string[]) => {
    vectors.push({ name, updates, markdown: await markdownOf(updates.map(bytes)) })
  }
  await add('empty', lineage(markdownToYDoc('')))
  await add('rich', lineage(seed(RICH)))
  for (const [index, markdown] of LEXICAL.entries()) await add(`lexical-${index}`, lineage(seed(markdown)))
  await add('source-stale-after-edit', lineage(seed('# Shared\n\nStarting together.\n'), doc => editBody(doc, '# Shared\n\nStarting together, edited.')))
  await add('source-edit-then-revert', lineage(seed('# Shared\n\nStarting together.\n'),
    doc => editBody(doc, '# Shared\n\nStarting apart.'), doc => editBody(doc, '# Shared\n\nStarting together.')))
  await add('source-forged-active', lineage(seed('# Shared\n\nStarting together.\n'), doc => {
    doc.getMap('meta').set('dohcMarkdownSource', 'Foreign source')
    doc.getMap('meta').set('dohcMarkdownSourceSha256', hash('Foreign source'))
  }))
  await add('source-forged-stale', lineage(seed('# Shared\n\nStarting together.\n'), doc => {
    doc.getMap('meta').set('dohcMarkdownSource', 'Foreign source')
    doc.getMap('meta').set('dohcMarkdownSourceSha256', hash('Foreign source'))
    doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', hash('another projection'))
  }))
  await add('source-wrong-hash', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').set('dohcMarkdownSourceSha256', '0'.repeat(64))))
  await add('source-missing', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').delete('dohcMarkdownSource')))
  await add('source-wrong-type', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').set('dohcMarkdownSource', { text: 'source' })))
  await add('source-invalid-witness', lineage(seed('# Shared\n\nStarting together.\n'), doc => doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', 'not-a-digest')))
  await add('source-uppercase-witness', lineage(seed('# Shared\n\nStarting together.\n'), doc => {
    const meta = doc.getMap('meta')
    meta.set('dohcMarkdownSourceProjectionSha256', (meta.get('dohcMarkdownSourceProjectionSha256') as string).toUpperCase())
  }))
  await add('tagged', lineage(seed('---\npriority: !custom high\n---\n\nBody\n')))
  await add('tagged-crlf', lineage(seed('---\r\npriority: !custom high\r\n---\r\n\r\nBody\r\n\r\nNext\r\n')))
  await add('tagged-body-edit', lineage(seed('---\npriority: !custom high\n---\n\nBody\n'), doc => editBody(doc, 'Body, edited')))
  await add('tagged-frontmatter-edit', lineage(seed('---\npriority: !custom high\n---\n\nBody\n'), doc => doc.getMap('frontmatter').set('priority', 'low')))
  await add('crlf-one-line', lineage(seed('Hello\r\n')))
  await add('crlf-edit', lineage(seed('# Title\r\n\r\nFirst\r\n'), doc => editBody(doc, '# Title\n\nFirst\n\nSecond')))
  await add('frontmatter-edits', lineage(seed('---\ntitle: Plan\ntags:\n  - a\n---\n\nBody\n'),
    doc => doc.getMap('frontmatter').set('status', 'done'),
    doc => doc.getMap('frontmatter').set('count', 3),
    doc => doc.getMap('frontmatter').set('tags', ['a', 'b']),
    doc => doc.getMap('frontmatter').delete('title')))
  await add('rich-edits', lineage(seed(RICH),
    doc => editBody(doc, RICH.replace('- two', '- two\n- three').replace('- [ ] open task', '- [x] open task')),
    doc => editBody(doc, RICH.replace('Tail', 'New **tail** with `code`'))))
  await add('delete-everything', lineage(seed(RICH), doc => editBody(doc, '')))
  await add('typed-markdown-characters', lineage(seed('Plain\n'), doc => {
    // Typing characters that Markdown reads as syntax, with no input rule firing.
    const text = (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText
    text.insert(text.length, ' 5 * 3, _x_, `y`, [z](w), <b>, a\\b, ~~s~~, $m$, [[p]], | pipe')
    doc.getXmlFragment('body').push([new Y.XmlElement('paragraph')])
    ;((doc.getXmlFragment('body').get(1) as Y.XmlElement)).insert(0, [new Y.XmlText('# not a heading')])
    doc.getXmlFragment('body').push([new Y.XmlElement('paragraph')])
    ;((doc.getXmlFragment('body').get(2) as Y.XmlElement)).insert(0, [new Y.XmlText('- not a list, 1. nor this, > nor a quote')])
  }))
  await add('successor-epoch', lineage((() => {
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
    await add('concurrent-devices', updates.map(update => Buffer.from(update).toString('base64')))
  }
  for (const [name, markdown] of Object.entries(YAML)) await add(`yaml-${name}`, lineage(seed(markdown)))
  await add('yaml-nan-source-over-string', lineage(await witnessed(markdownToYDoc("---\na: '.nan'\n---\n\nBody\n"), '---\na: .nan\n---\n\nBody\n')))
  await add('yaml-octal-source-over-integer', lineage(await witnessed(markdownToYDoc('---\na: 7\n---\n\nBody\n'), '---\na: !!int 0o7\n---\n\nBody\n')))
  await add('meta-content-kind-ignored', lineage((() => {
    const doc = markdownToYDoc('A\r\n\r\nB\r\n')
    doc.getMap('meta').set('contentKind', 'plain-text')
    return doc
  })()))
  return vectors
}

const read = (url: URL) => JSON.parse(readFileSync(url, 'utf8')) as Vector[]

describe.skipIf(engine.missing)('the engine settle through the relay projection', () => {
  it('regenerates the committed Yjs vectors with the same Markdown', async () => {
    const fresh = await yjsVectors()
    if (process.env.DOHC_WRITE_SETTLE_PARITY_VECTORS === '1') {
      writeFileSync(yjsFixture, '[\n' + fresh.map(vector => JSON.stringify(vector)).join(',\n') + '\n]\n')
    }
    const committed = new Map(read(yjsFixture).map(vector => [vector.name, vector.markdown]))
    expect(fresh.map(vector => vector.name)).toEqual([...committed.keys()])
    for (const vector of fresh) expect(vector.markdown, vector.name).toBe(committed.get(vector.name))
  }, TIMEOUT_MS)

  it('matches the engine settle for every Yjs and yrs vector', async () => {
    for (const vector of [...read(yjsFixture), ...read(yrsFixture)]) {
      const result = await project(vector.updates.map(bytes))
      expect(result, vector.name).toMatchObject({ kind: 'projected', sha256: hash(vector.markdown) })
      if (result.kind === 'projected') expect(result.content.toString('utf8'), vector.name).toBe(vector.markdown)
    }
  }, TIMEOUT_MS)

  it('matches the engine projection for every shared bootstrap vector', async () => {
    const bootstrap = JSON.parse(readFileSync(new URL('../../../crates/dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json', import.meta.url), 'utf8')) as { name: string; bytes: number[]; markdown: string }[]
    for (const vector of bootstrap) {
      expect(await project([new Uint8Array(vector.bytes)]), vector.name).toMatchObject({ kind: 'projected', sha256: hash(vector.markdown) })
    }
  }, TIMEOUT_MS)

  it('keeps preserved source only while its witness names the current projection', () => {
    const vectors = new Map(read(yjsFixture).map(vector => [vector.name, vector.markdown]))
    expect(vectors.get('lexical-0')).toBe('# Shared\n\nStarting together.\n')
    expect(vectors.get('source-edit-then-revert')).toBe('# Shared\n\nStarting together.\n')
    for (const name of ['source-stale-after-edit', 'source-forged-active', 'source-forged-stale', 'source-wrong-hash',
      'source-missing', 'source-wrong-type', 'source-invalid-witness', 'source-uppercase-witness']) {
      expect(vectors.get(name), name).not.toMatch(/\n$|Foreign/)
    }
    // The engine's YAML loader decides: it reads `.nan` as the string the
    // document holds, and refuses `!!int 0o7`.
    expect(vectors.get('yaml-nan-source-over-string')).toBe('---\na: .nan\n---\n\nBody\n')
    expect(vectors.get('yaml-octal-source-over-integer')).toBe('---\na: 7\n---\n\nBody')
  })

  it('refuses a document above the live-editing limit', async () => {
    const doc = markdownToYDoc(`${'x'.repeat(2 * 1024 * 1024)}y`)
    try {
      expect(await project([Y.encodeStateAsUpdate(doc)])).toMatchObject({ kind: 'refused', reason: 'too-large' })
    } finally { doc.destroy() }
  }, TIMEOUT_MS)

  it.each([
    ['MAX_PROJECTION_NODES', () => Array.from({ length: 140_000 }, () => {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText('a')])
      return paragraph
    })],
    ['MAX_PROJECTION_DEPTH', () => {
      let node = new Y.XmlElement('paragraph')
      node.insert(0, [new Y.XmlText('deep')])
      for (let level = 0; level < 130; level += 1) {
        const quote = new Y.XmlElement('blockquote')
        quote.insert(0, [node])
        node = quote
      }
      return [node]
    }],
  ])('refuses a document past %s and names the budget', async (budget, body) => {
    const doc = new Y.Doc()
    try {
      doc.getXmlFragment('body').insert(0, body())
      const result = await project([Y.encodeStateAsUpdate(doc)])
      expect(result).toMatchObject({ kind: 'refused', reason: 'too-large', message: expect.stringContaining(budget) })
    } finally { doc.destroy() }
  }, TIMEOUT_MS)

  it('refuses active preserved source above the live-editing limit and ignores stale source', async () => {
    for (const stale of [false, true]) {
      const doc = markdownToYDoc('Body')
      try {
        const source = `Body${'\n'.repeat(2 * 1024 * 1024)}`
        const meta = doc.getMap('meta')
        meta.set('dohcMarkdownSource', source)
        meta.set('dohcMarkdownSourceSha256', hash(source))
        meta.set('dohcMarkdownSourceProjectionSha256', hash(stale ? 'older projection' : 'Body'))
        const result = await project([Y.encodeStateAsUpdate(doc)])
        if (stale) expect(result.kind === 'projected' && result.content.toString('utf8')).toBe('Body')
        else expect(result).toMatchObject({ kind: 'refused', reason: 'too-large' })
      } finally { doc.destroy() }
    }
  }, TIMEOUT_MS)

  it('exits when its host closes stdin, even in the middle of a projection', async () => {
    // Source bound to the document's own projection, which the engine checks
    // by folding it block by block: about three minutes of work in a debug
    // engine, longer than this test waits. A relay that dies closes stdin.
    const doc = markdownToYDoc('Body')
    const source = `a${'\n\na'.repeat(120_000)}`
    const meta = doc.getMap('meta')
    meta.set('dohcMarkdownSource', source)
    meta.set('dohcMarkdownSourceSha256', hash(source))
    meta.set('dohcMarkdownSourceProjectionSha256', hash('Body'))
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
    doc.destroy()
    const child = spawn(engine.require(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, DOHC_ENGINE_AUTH_TOKEN: 'shutdown-test' } })
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.stdout.resume()
    child.stderr.resume()
    const frame = (envelope: object) => encodeFrame(1, 0, Buffer.from(JSON.stringify(envelope)), 8 * 1024 * 1024)
    child.stdin.write(frame({ type: 'hello', protocolVersion: 2, authToken: 'shutdown-test', capabilities: [], lastSessionGeneration: null, maxFrameBytes: null }))
    child.stdin.write(frame({ type: 'request', id: 1, method: 'ydoc.project', workspace: null, deadlineMs: 1_000, idempotencyKey: null,
      params: { contentKind: 'richdoc', updatesBase64: [update] } }))
    child.stdin.end()
    await exited
  }, 60_000)
})
