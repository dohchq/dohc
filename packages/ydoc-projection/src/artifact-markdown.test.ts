import {createHash} from 'node:crypto'
import {afterEach, expect, it, vi} from 'vitest'
import * as Y from 'yjs'
import * as projection from './import-export.js'
import * as artifact from './index.js'

const source = '---\nzebra: last\ntitle: "Outside"\nalpha: first\n---\n\n- one\n- two\n\n'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function witnessed(text = source) {
  const doc = projection.markdownToYDoc(text)
  const meta = doc.getMap('meta')
  meta.set('dohcMarkdownSource', text)
  meta.set('dohcMarkdownSourceSha256', sha(text))
  meta.set('dohcMarkdownSourceProjectionSha256', sha(projection.yDocToMarkdown(doc)))
  return doc
}
const output = artifact.yDocToArtifactMarkdown
afterEach(() => vi.restoreAllMocks())

it('returns settled artifact bytes including frontmatter order and trailing newlines', () => {
  const doc = witnessed()
  expect(projection.yDocToMarkdown(doc)).not.toBe(source)
  expect(output(doc)).toBe(source)
  doc.destroy()
})

it.each(['missing', 'partial', 'bad source digest', 'forged source', 'stale'])(
  'returns canonical output without trusting a %s witness', kind => {
    const doc = witnessed()
    const meta = doc.getMap('meta')
    if (kind === 'missing') for (const key of [...meta.keys()]) if (key.startsWith('dohcMarkdownSource')) meta.delete(key)
    if (kind === 'partial') meta.delete('dohcMarkdownSourceSha256')
    if (kind === 'bad source digest') meta.set('dohcMarkdownSourceSha256', '0'.repeat(64))
    if (kind === 'forged source') {
      meta.set('dohcMarkdownSource', 'Foreign text')
      meta.set('dohcMarkdownSourceSha256', sha('Foreign text'))
    }
    if (kind === 'stale') doc.getMap('frontmatter').set('title', 'Changed')
    expect(output(doc)).toBe(projection.yDocToMarkdown(doc))
    doc.destroy()
  },
)

it('memoizes both answers by source text, both hashes and current canonical hash', () => {
  const doc = witnessed()
  const parse = vi.spyOn(projection, 'markdownToYDoc')
  expect(output(doc)).toBe(source)
  expect(output(doc)).toBe(source)
  expect(parse).toHaveBeenCalledTimes(1)
  doc.getMap('meta').set('dohcMarkdownSource', 'Forged')
  expect(output(doc)).toBe(projection.yDocToMarkdown(doc))
  expect(parse).toHaveBeenCalledTimes(1)
  doc.destroy()
})

it('does not import absent or stale witnesses or change canonical serialization', () => {
  const doc = witnessed()
  doc.getMap('frontmatter').set('title', 'Edited')
  const parse = vi.spyOn(projection, 'markdownToYDoc')
  const canonical = projection.yDocToMarkdown(doc)
  expect(output(doc)).toBe(canonical)
  expect(projection.yDocToMarkdown(doc)).toBe(canonical)
  expect(parse).not.toHaveBeenCalled()
  doc.destroy()
})
