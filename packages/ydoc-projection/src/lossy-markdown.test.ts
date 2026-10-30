import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import commonmark from './fixtures/commonmark-edit-meaning.json'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { isLossyDocument, isLossyDocumentState, isLossyMarkdown, isLossyMarkdownCached, lossyNoteRefusal, sameMarkdownMeaning, unreadNoteRefusal, witnessKeepsMeaning } from './lossy-markdown.js'

// The 646 CommonMark 0.31.2 examples the desktop can open, each with the
// Markdown the engine wrote for it after an edit, on main at `writtenAt`.
// Regenerate it when the import learns a form.
it('flags every CommonMark example whose meaning an edit would change', () => {
  const changed = commonmark.examples.filter(example => !sameMarkdownMeaning(example.markdown, example.written))
  const misses = changed
    .filter(example => !isLossyMarkdown(example.markdown))
    .map(example => example.example)
  const extra = commonmark.examples
    .filter(example => !changed.includes(example) && isLossyMarkdown(example.markdown))
    .map(example => example.example)
  expect(commonmark.examples).toHaveLength(646)
  // 273 by marked's raw HTML. Examples 226, 241 and 645 differ only by spaces
  // after a paragraph's last word, which CommonMark's own HTML strips.
  expect(changed).toHaveLength(270)
  expect(misses).toEqual([])
  // Example 353, `` `foo`bar` ``, differs only in a code span marked reads
  // two ways. Flagging more would open ordinary notes read-only.
  expect(extra.length).toBeLessThanOrEqual(1)
})

it.each([
  ['a raw HTML block', '# Notes\n\n<details>\n<summary>More</summary>\n\nHidden.\n</details>\n'],
  ['a link reference definition', 'See [the docs][docs].\n\n[docs]: https://example.com/docs "Docs"\n'],
  ['an image with a root-relative path', '![logo](/docs/logo.png)\n'],
  ['code indented under a list item', '1. Run this:\n\n       pnpm install\n\n2. Done\n'],
])('flags %s', (_, markdown) => {
  expect(isLossyMarkdown(markdown)).toBe(true)
})

it('does not flag a note dohc wrote, with or without its final newline', () => {
  const written = yDocToMarkdown(markdownToYDoc('# Plan\n\n- [ ] Book flights\n- [x] Pick dates\n\n**Budget:** $1,200\n'))
  expect(isLossyMarkdown(written)).toBe(false)
  expect(isLossyMarkdown(`${written}\n`)).toBe(false)
  expect(isLossyMarkdown(`${written.replaceAll('\n', '\r\n')}\r\n`)).toBe(false)
})

it('does not flag a respelling that keeps the meaning', () => {
  expect(isLossyMarkdown('Title\n=====\n\n* one\n* two\n\n_emphasis_\n')).toBe(false)
})

it('does not flag spaces after the last words of a note', () => {
  expect(isLossyMarkdown('# Plan\n\nLast words \n')).toBe(false)
  expect(isLossyMarkdown('# Plan \n')).toBe(false)
})

it('flags a note the editor cannot import', () => {
  expect(isLossyMarkdown('- a\n - b\n  - c\n   - d\n    - e\n')).toBe(true)
})

it('remembers a verdict by the digest it was given', () => {
  expect(isLossyMarkdownCached('digest-a', '<details>\n\nHidden.\n</details>\n')).toBe(true)
  // The same digest answers from memory, whatever text comes with it.
  expect(isLossyMarkdownCached('digest-a', 'Plain text.\n')).toBe(true)
  expect(isLossyMarkdownCached('digest-b', 'Plain text.\n')).toBe(false)
})

it('names the note and the way forward when it refuses', () => {
  expect(lossyNoteRefusal('notes/readme.md')).toBe(
    "dohc can't change notes/readme.md without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.",
  )
})

// A note's live document as the desktop seeds it: the import, and a witness
// of the file's bytes when they differ from its canonical Markdown.
function seeded(source: string): Y.Doc {
  const doc = markdownToYDoc(source)
  const canonical = yDocToMarkdown(doc)
  if (canonical !== source) {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    doc.getMap('meta').set('dohcMarkdownSource', source)
    doc.getMap('meta').set('dohcMarkdownSourceSha256', sha(source))
    doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', sha(canonical))
  }
  return doc
}

it('judges a live note by the file its witness records', () => {
  expect(isLossyDocument(seeded('See [the docs][docs].\n\n[docs]: https://example.com/docs\n'), null)).toBe(true)
  expect(isLossyDocument(seeded('Title\n=====\n\n* one\n'), null)).toBe(false)
  expect(isLossyDocument(seeded('# Plan\n\nText.'), null)).toBe(false)
})

it('still needs consent after an edit while the head holds the unsafe source', () => {
  const doc = seeded('<details>\n\nHidden.\n</details>\n')
  const source = doc.getMap('meta').get('dohcMarkdownSourceSha256') as string
  expect(isLossyDocument(doc, source)).toBe(true)
  doc.getMap('frontmatter').set('status', 'done')
  expect(isLossyDocument(doc, source)).toBe(true)
  expect(isLossyDocument(doc, null)).toBe(true)
  expect(isLossyDocument(doc, 'converted-head')).toBe(false)
})

it('judges a session state as its live note', () => {
  const lossy = seeded('<details>\n\nHidden.\n</details>\n')
  const plain = seeded('# Plan\n\nText.')
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(lossy), null)).toBe(true)
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(plain), null)).toBe(false)
})

it('settles a session by its witness when the source keeps its meaning, edited or not', () => {
  const respelled = seeded('Title\n=====\n\n* one\n')
  expect(witnessKeepsMeaning(respelled)).toBe(true)
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(respelled), null)).toBe(false)
  respelled.getMap('frontmatter').set('status', 'done')
  expect(witnessKeepsMeaning(respelled)).toBe(true)
  expect(witnessKeepsMeaning(seeded('# Plan\n\nText.'))).toBe(true)
})

it('checks the whole session when its witness records a lossy source, or a projection the import no longer gives', () => {
  const lossy = seeded('<details>\n\nHidden.\n</details>\n')
  expect(witnessKeepsMeaning(lossy)).toBe(false)
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(lossy), null)).toBe(true)
  lossy.getMap('frontmatter').set('status', 'done')
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(lossy), null)).toBe(true)
  const reopened = new Y.Doc()
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(lossy))
  expect(isLossyDocument(reopened, null)).toBe(true)
  expect(isLossyDocument(reopened, 'converted-head')).toBe(false)
  const older = seeded('Title\n=====\n\n* one\n')
  older.getMap('meta').set('dohcMarkdownSourceProjectionSha256', '0'.repeat(64))
  expect(witnessKeepsMeaning(older)).toBe(false)
  const partial = seeded('Title\n=====\n\n* one\n')
  partial.getMap('meta').delete('dohcMarkdownSourceProjectionSha256')
  expect(witnessKeepsMeaning(partial)).toBe(false)
  const mismatched = seeded('Title\n=====\n\n* one\n')
  mismatched.getMap('meta').set('dohcMarkdownSource', 'Title\n=====\n\n* two\n')
  expect(witnessKeepsMeaning(mismatched)).toBe(false)
})

it('names the note when it could not be read to check', () => {
  expect(unreadNoteRefusal('notes/readme.md')).toBe("dohc couldn't read notes/readme.md to check it, so nothing changed. Try again.")
})
