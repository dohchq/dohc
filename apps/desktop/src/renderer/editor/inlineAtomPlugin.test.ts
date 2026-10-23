import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import { describe, it, expect } from 'vitest'
import { codeBlock, codeMarkText, doc, paragraph, randomEdit, seededRandom } from './testDocs'
import {
  computeAtomRanges,
  inlineAtomKey,
  makeInlineAtomPlugin,
} from './inlineAtomPlugin'

// Range logic over real ProseMirror documents built through the shared dohc
// schema (testDocs.ts). Positions below are hand-computed from node sizes:
// a paragraph is text length + 2, and a block's text starts one position
// after the block itself.

// A CommonMark-style schema carrying the *other* code spellings pmHelpers
// must recognize: a `code_block` node name, an `inlineCode` mark name, and
// a mark whose spec sets `code: true` under a different name.
const commonmark = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    code_block: { group: 'block', content: 'text*', code: true },
    text: { group: 'inline' },
  },
  marks: {
    inlineCode: {},
    verbatim: { code: true },
  },
})

describe('computeAtomRanges — offsets', () => {
  it('maps atom offsets into absolute doc coordinates', () => {
    // paragraph("abc") is nodeSize 5, so the second paragraph's text node
    // starts at pos 6; the atom sits at text indices 7..17.
    const d = doc(paragraph('abc'), paragraph('Logged {hours: 6} ok'))
    expect(computeAtomRanges(d)).toEqual([{ from: 6 + 7, to: 6 + 17, kind: 'value' }])
  })

  it('handles multiple text nodes at different positions', () => {
    // '{a: 1}' occupies 1..7; its paragraph is nodeSize 8, so the second
    // paragraph's text starts at 9 with its atom at indices 4..10.
    const d = doc(paragraph('{a: 1}'), paragraph('mid {b: 2} end'))
    expect(computeAtomRanges(d)).toEqual([
      { from: 1, to: 7, kind: 'value' },
      { from: 13, to: 19, kind: 'value' },
    ])
  })
})

describe('computeAtomRanges — code is verbatim', () => {
  it('skips text carrying the dohc schema inline-code mark', () => {
    expect(computeAtomRanges(doc(paragraph(codeMarkText('{hours: 6}'))))).toEqual([])
  })
  it('also skips an `inlineCode`-named mark and a spec.code mark', () => {
    const inlineCode = commonmark.text('{hours: 6}', [commonmark.marks.inlineCode.create()])
    expect(
      computeAtomRanges(
        commonmark.node('doc', null, [commonmark.node('paragraph', null, inlineCode)]),
      ),
    ).toEqual([])
    const verbatim = commonmark.text('{hours: 6}', [commonmark.marks.verbatim.create()])
    expect(
      computeAtomRanges(
        commonmark.node('doc', null, [commonmark.node('paragraph', null, verbatim)]),
      ),
    ).toEqual([])
  })
  it('skips text inside a code_block / codeBlock parent', () => {
    expect(
      computeAtomRanges(
        commonmark.node('doc', null, [
          commonmark.node('code_block', null, commonmark.text('{hours: 6}')),
        ]),
      ),
    ).toEqual([])
    expect(computeAtomRanges(doc(codeBlock('{hours: 6}')))).toEqual([])
  })
  it('still decorates normal prose next to code', () => {
    // The code-marked paragraph is skipped; the second paragraph's text
    // starts at 9 (first paragraph nodeSize 8) and is decorated.
    const d = doc(paragraph(codeMarkText('{a: 1}')), paragraph('{b: 2}'))
    expect(computeAtomRanges(d)).toEqual([{ from: 9, to: 15, kind: 'value' }])
  })

  it('retired expressions stay plain while value captures are decorated', () => {
    // First paragraph text is 25 chars (nodeSize 27), so the value capture
    // in the second paragraph spans 28..38 — identical width to v0.
    const d = doc(paragraph('a {sum(log.*.billable)} b'), paragraph('{hours: 6}'))
    expect(computeAtomRanges(d)).toEqual([{ from: 28, to: 38, kind: 'value' }])
  })
  it('an expression-like token stays plain — no range, no slop', () => {
    expect(computeAtomRanges(doc(paragraph('x {sum(lo y')))).toEqual([])
  })

  it('makeInlineAtomPlugin builds a ProseMirror plugin keyed by inlineAtomKey', () => {
    // Smoke test of the editor-facing factory: it constructs lazily (state.init
    // only runs once added to an EditorState), so we can build it without a DOM.
    const plugin = makeInlineAtomPlugin()
    expect(plugin).toBeInstanceOf(Plugin)
    expect(inlineAtomKey).toBeInstanceOf(PluginKey)
    expect(plugin.spec.key).toBe(inlineAtomKey)
  })
})

describe('makeInlineAtomPlugin — edits', () => {
  it('matches a full scan after every edit while rescanning only changed blocks', () => {
    const random = seededRandom(2522)
    let state = EditorState.create({
      doc: doc(
        paragraph('Logged {hours: 6} today'),
        paragraph('plain text'),
        codeBlock('{hours: 1}'),
        paragraph('{done: true} and {left: 2}'),
      ),
      plugins: [makeInlineAtomPlugin()],
    })
    for (let step = 0; step < 400; step += 1) {
      state = state.apply(randomEdit(state, random, ['{', '}', 'n', ': ', '7', ' ', '{x: 1}']))
      const shown = (inlineAtomKey.getState(state) as DecorationSet)
        .find()
        .map((decoration) => ({ from: decoration.from, to: decoration.to }))
        .sort((a, b) => a.from - b.from)
      expect(shown, `step ${step}`).toEqual(
        computeAtomRanges(state.doc).map(({ from, to }) => ({ from, to })),
      )
    }
  })
})
