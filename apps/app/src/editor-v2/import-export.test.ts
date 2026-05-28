import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyDohcYDocUpdate,
  encodeDohcYDocUpdate,
  getDohcYDocBodyJSON,
  getDohcYDocBodyType,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  markdownToYDoc,
  roundTripMarkdown,
  yDocToMarkdown,
} from './import-export'

const corpusDir = fileURLToPath(
  new URL('../../../../tests/fixtures/markdown-corpus/', import.meta.url),
)

const corpusFiles = readdirSync(corpusDir)
  .filter((file) => file.endsWith('.md'))
  .sort()

const readCorpus = (file: string) => readFileSync(join(corpusDir, file), 'utf8')

type TiptapJsonNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: TiptapJsonNode[]
}

const collectNodeTypes = (node: TiptapJsonNode): string[] => [
  ...(node.type ? [node.type] : []),
  ...(node.content?.flatMap((child) => collectNodeTypes(child)) ?? []),
]

const findNodeType = (
  node: TiptapJsonNode,
  type: string,
): TiptapJsonNode | null => {
  if (node.type === type) return node
  for (const child of node.content ?? []) {
    const match = findNodeType(child, type)
    if (match) return match
  }
  return null
}

describe('v2 markdown import/export foundation', () => {
  it('stores frontmatter outside the editable body and exports it back', () => {
    const input = readCorpus('frontmatter.md')
    const doc = markdownToYDoc(input)

    expect(getDohcYDocBodyType(doc)).toBe('Y.XmlFragment')
    expect(getDohcYDocMeta(doc)).toMatchObject({ schemaVersion: 1 })
    expect(getDohcYDocFrontmatter(doc)).toMatchObject({
      title: 'Phase 0: Offline-first',
      tags: ['dohc', 'v2'],
      pinned: true,
      count: 3,
    })

    const exported = yDocToMarkdown(doc)
    expect(exported).toContain("title: 'Phase 0: Offline-first'")
    expect(exported).toContain('# Body After Frontmatter')
    expect(getDohcYDocFrontmatter(markdownToYDoc(exported))).toMatchObject(
      getDohcYDocFrontmatter(doc),
    )
  })

  it('exports frontmatter in a stable key order', () => {
    const input = [
      '---',
      'zeta: last',
      'title: Stable',
      'id: atom_1',
      'alpha: first',
      'icon: sparkle',
      '---',
      '',
      '# Ordered',
    ].join('\n')

    const exported = yDocToMarkdown(markdownToYDoc(input))

    expect(exported).toMatch(
      /^---\nid: atom_1\ntitle: Stable\nicon: sparkle\nalpha: first\nzeta: last\n---/,
    )
  })

  it.each(corpusFiles)('round-trips %s idempotently', (file) => {
    const input = readCorpus(file)

    const once = roundTripMarkdown(input)
    const twice = roundTripMarkdown(once)

    expect(twice).toBe(once)
  })

  it('preserves dohc custom markdown syntax through the foundation pass', () => {
    const input = [
      readCorpus('wikilinks.md'),
      readCorpus('inline-atoms-formulas.md'),
      readCorpus('math-code-query.md'),
    ].join('\n\n')

    const output = roundTripMarkdown(input)

    expect(output).toContain('[[Project Alpha]]')
    expect(output).toContain('{{atom:atom_123')
    expect(output).toContain('{{formula:sum revenue')
    expect(output).toContain('```dohc-query')
    expect(output).toContain('[[not a wikilink inside code]]')
  })

  it('keeps malformed frontmatter visible instead of dropping it', () => {
    const input = [
      '---',
      'id: atom_1',
      'bad: [unclosed',
      '---',
      '# Body',
    ].join('\n')

    const output = roundTripMarkdown(input)

    expect(output).toContain('id: atom_1')
    expect(output).toContain('bad: [unclosed')
    expect(output).toContain('# Body')
  })

  it('imports query and dohc-query fences with info strings as query blocks', () => {
    const doc = markdownToYDoc(
      [
        '```query render="text"',
        'tasks.list("open")',
        '```',
        '',
        '```dohc-query theme="dark"',
        'tasks.list("closed")',
        '```',
      ].join('\n'),
    )

    const body = getDohcYDocBodyJSON(doc)
    const output = yDocToMarkdown(doc)
    const firstQuery = findNodeType(body, 'queryBlock')

    expect(collectNodeTypes(body).filter((type) => type === 'queryBlock')).toHaveLength(
      2,
    )
    expect(firstQuery?.attrs?.info).toBe('render="text"')
    expect(output).toContain('```dohc-query render="text"')
    expect(output).toContain('```dohc-query theme="dark"')
  })

  it('preserves escaped wikilink delimiters in targets and labels', () => {
    const input = String.raw`# Escaped Wikilinks

Escaped: [[Research\|AI\] notes|label \| with pipe]]`

    const output = roundTripMarkdown(input)

    expect(output).toContain(
      String.raw`[[Research\|AI\] notes|label \| with pipe]]`,
    )
  })

  it('imports dohc custom syntax as first-class Tiptap nodes', () => {
    const doc = markdownToYDoc(
      [
        readCorpus('wikilinks.md'),
        readCorpus('inline-atoms-formulas.md'),
        readCorpus('math-code-query.md'),
      ].join('\n\n'),
    )

    const nodeTypes = collectNodeTypes(getDohcYDocBodyJSON(doc))

    expect(nodeTypes).toContain('wikilink')
    expect(nodeTypes).toContain('inlineAtom')
    expect(nodeTypes).toContain('formula')
    expect(nodeTypes).toContain('queryBlock')
  })

  it('encodes update bytes that hydrate a fresh Y.Doc', () => {
    const doc = markdownToYDoc(readCorpus('lists-tables.md'))
    const update = encodeDohcYDocUpdate(doc)
    const hydrated = applyDohcYDocUpdate(update)

    expect(update.byteLength).toBeGreaterThan(0)
    expect(getDohcYDocBodyType(hydrated)).toBe('Y.XmlFragment')
    expect(yDocToMarkdown(hydrated)).toBe(yDocToMarkdown(doc))
  })
})
