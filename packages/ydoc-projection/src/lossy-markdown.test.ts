import { expect, it } from 'vitest'
import commonmark from './fixtures/commonmark-edit-meaning.json'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import { isLossyMarkdown, sameMarkdownMeaning } from './lossy-markdown.js'

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
