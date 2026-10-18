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

import {forgedSources} from './artifact-witness.fixture.js'
import {resolveMarkdownSource, createArtifactMarkdownProjector} from './artifact-markdown.js'
it.each(forgedSources)('keeps an engine-refused source inert: %s', text => {
 const doc=witnessed(text);const canonical=projection.yDocToMarkdown(doc);
 expect(resolveMarkdownSource(doc,canonical)).toEqual({kind:'verified',markdown:text});
 expect(output(doc)).toBe(canonical);expect(createArtifactMarkdownProjector()(doc)).toBe(canonical);doc.destroy();
})
it('reuses bounded proofs across fresh documents, after recomputing both content hashes',()=>{
 const project=createArtifactMarkdownProjector();const parse=vi.spyOn(projection,'markdownToYDoc');
 const a=witnessed();const b=witnessed();parse.mockClear();
 expect(project(a)).toBe(source);expect(project(b)).toBe(source);expect(parse).toHaveBeenCalledTimes(1);
 b.getMap('meta').set('dohcMarkdownSource','forged');expect(project(b)).toBe(projection.yDocToMarkdown(b));
 const c=witnessed();c.getMap('frontmatter').set('title','new');expect(project(c)).toBe(projection.yDocToMarkdown(c));
 a.destroy();b.destroy();c.destroy();
})

it('bounds content proofs to eight digest pairs',()=>{
 const project=createArtifactMarkdownProjector();
 for(let n=0;n<9;n++){const doc=witnessed(source+n);expect(project(doc)).toBe(source+n);doc.destroy();}
 const first=witnessed(source+'0');const parse=vi.spyOn(projection,'markdownToYDoc');expect(project(first)).toBe(source+'0');expect(parse).toHaveBeenCalledOnce();first.destroy();
})
