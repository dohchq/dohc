import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { getDohcProseMirrorSchema, markdownToYDoc, serializeRichdocBody, yDocToMarkdown } from './import-export.js'
import { createLiveMarkdownJournalValidator } from './liveDocumentValidation.js'

interface Body { type: string; tag?: string; attrs?: Record<string, unknown>; children?: Body[]; delta?: Array<{ insert: string; attributes?: Record<string, unknown> }> }
interface Case { source: string; canonical: string; body: Body; builders: Array<{ nativeBase64: string; witness: Array<string | null> }> }
const cases = JSON.parse(readFileSync(new URL('../../../tools/rust-engine-program/nested1b-allowlist-witnesses.json', import.meta.url), 'utf8')) as Case[]

const desktopFoldSources = [
  '- [link](https://example.com)\n  - child',
  '- a < b\n  - child',
  '- &amp;\n  - child',
  '- parent\n\n  > quote\n\n  - child',
  '- parent\n\n  | h |\n  | --- |\n  | v |\n\n  - child',
  '- parent\n\n  # heading\n\n  - child',
  '- a\n  ---',
].map(body => `---\nstatus: todo\n---\n${body}`)
it('replays desktop seeds used by native frontmatter-only folds', () => {
  const path = new URL('../../../tools/rust-engine-program/nested1b-desktop-folds.json', import.meta.url)
  if (process.env.DOHC_EXPORT_DESKTOP_FOLDS) {
    writeFileSync(path, JSON.stringify(desktopFoldSources.map(source => {
      const doc = markdownToYDoc(source, { reading: 'source' })
      try { return { source, desktopBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') } }
      finally { doc.destroy() }
    })))
  }
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<{ source: string; desktopBase64: string }>
  expect(rows.map(row => row.source)).toEqual(desktopFoldSources)
  for (const row of rows) {
    const imported = markdownToYDoc(row.source, { reading: 'source' })
    const replay = new Y.Doc()
    try {
      Y.applyUpdate(replay, Buffer.from(row.desktopBase64, 'base64'))
      expect(fromXml(replay.getXmlFragment('body'))).toEqual(fromXml(imported.getXmlFragment('body')))
      expect(yDocToMarkdown(replay)).toBe(yDocToMarkdown(imported))
    } finally { imported.destroy(); replay.destroy() }
  }
})

// Compare both production builders with a fresh desktop import. Defaults
// and empty text nodes have no semantic effect, but child order does.
function normalized(node: Body): unknown {
  if (node.type === 'xmlText') return { delta: (node.delta ?? []).filter(run => run.insert !== '').map(run => ({
    insert: run.insert, attributes: Object.fromEntries(Object.entries(run.attributes ?? {}).filter(([, value]) => value != null)),
  })) }
  const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key, value]) =>
    value !== null && value !== undefined && !(key === 'start' && value === 1) && !(key === 'checked' && value === false)))
  return { tag: node.tag ?? 'body', attrs, children: (node.children ?? []).filter(child =>
    child.type !== 'xmlText' || child.delta?.some(run => run.insert !== '')).map(normalized) }
}
function fromXml(node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook): Body {
  if (node instanceof Y.XmlHook) throw new Error('Unexpected XML hook in a Source import')
  if (node instanceof Y.XmlText) return { type: 'xmlText', delta: node.toDelta() }
  return { type: node instanceof Y.XmlElement ? 'element' : 'xmlFragment',
    ...(node instanceof Y.XmlElement ? { tag: node.nodeName, attrs: node.getAttributes() } : {}),
    children: node.toArray().map(child => fromXml(child)) }
}
// Native MdBlock stores inline Markdown as text; the desktop stores marks.
// Compare that spelling through the existing serializer at each leaf, without
// reparsing whole lists (which would hide sibling-list grouping differences).
function blockTree(node: JSONContent): unknown {
  const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key, value]) =>
    value != null && !(key === 'start' && value === 1) && !(key === 'checked' && value === false)))
  return { type: node.type, attrs, ...(node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock'
    ? { markdown: serializeRichdocBody({ type: 'doc', content: [node] }) }
    : { children: (node.content ?? []).map(blockTree) }) }
}
function tree(doc: Y.Doc): unknown {
  return blockTree(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('body'), getDohcProseMirrorSchema()).toJSON())
}
const policy = {
  maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000,
}
const validate = createLiveMarkdownJournalValidator(policy)
const document = { workspaceId: 'workspace', mainVersionId: 'main', objectId: 'object', lineageClaimId: 'lineage' }

const inlineDesktopProbes = [
  ['- see https://example.com\n  - child\n', 'link', '[https://example.com](https://example.com)'],
  ['- www.example.com\n  - child\n', 'link', '[www.example.com](http://www.example.com)'],
  ['- mail a@b.co\n  - child\n', 'link', '[a@b.co](mailto:a@b.co)'],
  ['- _note_\n  - child\n', 'italic', '*note*'],
  ['- __note__\n  - child\n', 'bold', '**note**'],
  ['- ``code``\n  - child', 'code', '`code`'],
  ['- ` x `\n  - child', 'code', '`x`'],
  ['- a  \n  b\n  - child', 'hardBreak', 'a  \n  b'],
  ['- a\\\n  b\n  - child', 'hardBreak', 'a  \n  b'],
  ['- `   `\n  - child', 'code', '`   `'],
  ['- ==a=b==\n  - child', 'highlight', '==a\\=b=='],
  ['- ++underline++\n  - child', 'underline', '++underline++'],
  ['- parent\n\n  ```c\\+\\+\n  code\n  ```\n  - child', 'codeBlock', '```c++'],
  ['- `Vec<T>`\n  - child', 'code', 'Vec<T>'],
  ['- run `a -> b`\n  - child', 'code', 'a -> b'],
  ['- `a && b`\n  - child', 'code', 'a && b'],
  ['- $x > 0$\n  - child', 'mathInline', '$x > 0$'],
  ['- $a < b$\n  - child', 'mathInline', '$a < b$'],
  ['- see [[Tom & Jerry]]\n  - child', 'wikilink', '[[Tom & Jerry]]'],
  ['- [[Meeting notes]]\n  - follow-up', 'wikilink', '[[Meeting notes]]'],
  ['- ![](shot.png)\n  - caption', 'image', '![](shot.png)'],
  ['- parent\n  [[Meeting notes]]\n  - child', 'wikilink', '[[Meeting notes]]'],
  ['- parent\n  ![](shot.png)\n  - child', 'image', '![](shot.png)'],
  ['- [x] [[Meeting notes]]\n  - child', 'wikilink', '[[Meeting notes]]'],
  ['- [ ] ![](shot.png)\n  - child', 'image', '![](shot.png)'],
  ['- {{atom:example name=Tom&Jerry}}\n  - child', 'inlineAtom', '{{atom:example name=Tom&Jerry}}'],
  ['- {{atom:example}}\n  - child', 'inlineAtom', '{{atom:example}}'],
  ['- $x$\n  - child', 'mathInline', '$x$'],
] as const

it('holds inline constructs on both native builders and probes desktop nodes and serialized spellings', () => {
  for (const [source, type, spelling] of inlineDesktopProbes) {
    const row = cases.find(row => row.source === source)
    expect(row, source).toMatchObject({ held: true, builders: [] })
    const doc = markdownToYDoc(source, { reading: 'source' })
    try {
      const body = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('body'), getDohcProseMirrorSchema()).toJSON()
      expect(JSON.stringify(body), source).toContain(`"type":"${type}"`)
      expect(yDocToMarkdown(doc), source).toContain(spelling)
    } finally { doc.destroy() }
  }
})

it('accepts the positive inline alphabet and Tiptap spellings at their edges', () => {
  for (const [source, mark] of [
    ['- Café 中文 ١٢٣ . , ; : ! ? \' " ( ) - / *\n  - child', null],
    ['- **bold**\n  - child', 'bold'],
    ['- *italic*\n  - child', 'italic'],
    ['- ~~strike~~\n  - child', 'strike'],
    ['- `code`\n  - child', 'code'],
    ['- `*plain* / : -`\n  - child', 'code'],
    ['- a  \n  - child', null],
  ] as const) {
    const row = cases.find(row => row.source === source)
    expect(row?.builders, source).toHaveLength(2)
    const doc = markdownToYDoc(source, { reading: 'source' })
    try {
      expect(yDocToMarkdown(doc), source).toBe(source)
      if (mark) {
        const body = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('body'), getDohcProseMirrorSchema()).toJSON()
        expect(JSON.stringify(body), source).toContain(`"type":"${mark}"`)
      }
    } finally { doc.destroy() }
  }
})

it('compares production successor and relation seed trees and witnesses with desktop imports', () => {
  expect(cases.length).toBeGreaterThan(2000)
  for (const row of cases) for (const builder of row.builders) {
    const imported = markdownToYDoc(row.source, { reading: 'source' })
    const native = new Y.Doc()
    try {
      Y.applyUpdate(native, Buffer.from(builder.nativeBase64, 'base64'))
      expect(tree(imported), row.source).toEqual(tree(native))
      expect(normalized(fromXml(native.getXmlFragment('body'))), row.source).toEqual(normalized(row.body))
      expect(['dohcMarkdownSource', 'dohcMarkdownSourceSha256', 'dohcMarkdownSourceProjectionSha256']
        .map(key => native.getMap('meta').get(key) ?? null), row.source).toEqual(builder.witness)
      expect(yDocToMarkdown(imported), row.source).toBe(row.canonical)
      expect(yDocToMarkdown(native), row.source).toBe(row.canonical)
      // Successors carry a private lineage epoch. The public journal schema
      // excludes it; keep the production body and all witness fields intact.
      native.getMap('meta').delete('dohcLineageEpoch')
      const checkpoint = Y.encodeStateAsUpdate(native)
      expect(validate({ document, currentPath: 'notes.md', checkpoint, suffix: [], candidate: Y.encodeStateAsUpdate(native) }), row.source)
        .toMatchObject({ kind: 'accepted', evidence: {
          projectedMarkdownSha256: createHash('sha256').update(row.source).digest('hex'),
          projectedMarkdownByteLength: Buffer.byteLength(row.source),
        } })
    } finally { imported.destroy(); native.destroy() }
  }
}, 60_000)

it('refuses a forged nested witness even when both claimed digests are fresh', () => {
  const row = cases.find(row => row.source.startsWith('- parent\n  - child'))!
  const checkpoint = Buffer.from(row.builders[0]!.nativeBase64, 'base64')
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, checkpoint)
    doc.getMap('meta').delete('dohcLineageEpoch')
    const publicCheckpoint = Y.encodeStateAsUpdate(doc)
    const before = Y.encodeStateVector(doc)
    const forged = '- forged parent\n  - forged child'
    doc.getMap('meta').set('dohcMarkdownSource', forged)
    doc.getMap('meta').set('dohcMarkdownSourceSha256', createHash('sha256').update(forged).digest('hex'))
    doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', createHash('sha256').update(row.canonical).digest('hex'))
    expect(validate({ document, currentPath: 'notes.md', checkpoint: publicCheckpoint, suffix: [], candidate: Y.encodeStateAsUpdate(doc, before) }))
      .toMatchObject({ kind: 'refused' })
  } finally { doc.destroy() }
})
