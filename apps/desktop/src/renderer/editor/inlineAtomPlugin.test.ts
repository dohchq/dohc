import { Plugin, PluginKey } from '@tiptap/pm/state'
import { describe, it, expect } from 'vitest'
import {
  computeAtomRanges,
  inlineAtomKey,
  makeInlineAtomPlugin,
  type PMDocLike,
  type PMNodeLike,
} from './inlineAtomPlugin'

// Offline test of the decoration RANGE logic (the offset-sensitive,
// previously-untested surface). No ProseMirror/jsdom — a hand-built
// doc whose `descendants` mirrors ProseMirror's (node, pos, parent).

type Entry = {
  text: string
  pos: number
  parent?: string // parent node type name
  mark?: string // a single mark name on the text node
}
function fakeDoc(entries: Entry[]): PMDocLike {
  return {
    descendants(cb) {
      for (const e of entries) {
        const node: PMNodeLike = {
          isText: true,
          text: e.text,
          marks: e.mark ? [{ type: { name: e.mark } }] : [],
          type: { name: 'text' },
        }
        const parent: PMNodeLike | null = e.parent
          ? { type: { name: e.parent } }
          : { type: { name: 'paragraph' } }
        cb(node, e.pos, parent)
      }
    },
  }
}

describe('computeAtomRanges — offsets', () => {
  it('maps atom offsets into absolute doc coordinates', () => {
    // "Logged {hours: 6}" with the text node starting at pos 5
    const r = computeAtomRanges(fakeDoc([{ text: 'Logged {hours: 6} ok', pos: 5 }]))
    expect(r).toEqual([{ from: 5 + 7, to: 5 + 17, kind: 'value' }])
  })

  it('handles multiple text nodes at different positions', () => {
    const r = computeAtomRanges(
      fakeDoc([
        { text: '{a: 1}', pos: 1 },
        { text: 'mid {b: 2} end', pos: 40 },
      ]),
    )
    expect(r).toEqual([
      { from: 1, to: 7, kind: 'value' },
      { from: 44, to: 50, kind: 'value' },
    ])
  })
})

describe('computeAtomRanges — code is verbatim (the bug Codex flagged)', () => {
  it('skips Tiptap inline-code mark (`inlineCode`)', () => {
    expect(
      computeAtomRanges(fakeDoc([{ text: '{hours: 6}', pos: 1, mark: 'inlineCode' }])),
    ).toEqual([])
  })
  it('also skips a `code` mark and spec.code marks', () => {
    expect(
      computeAtomRanges(fakeDoc([{ text: '{hours: 6}', pos: 1, mark: 'code' }])),
    ).toEqual([])
  })
  it('skips text inside a code_block / codeBlock parent', () => {
    expect(
      computeAtomRanges(fakeDoc([{ text: '{hours: 6}', pos: 1, parent: 'code_block' }])),
    ).toEqual([])
    expect(
      computeAtomRanges(fakeDoc([{ text: '{hours: 6}', pos: 1, parent: 'codeBlock' }])),
    ).toEqual([])
  })
  it('still decorates normal prose next to code', () => {
    const r = computeAtomRanges(
      fakeDoc([
        { text: '{a: 1}', pos: 1, mark: 'inlineCode' }, // skipped
        { text: '{b: 2}', pos: 20 }, // decorated
      ]),
    )
    expect(r).toEqual([{ from: 20, to: 26, kind: 'value' }])
  })

  it('retired expressions stay plain while value captures are decorated', () => {
    const r = computeAtomRanges(
      fakeDoc([
        { text: 'a {sum(log.*.billable)} b', pos: 1 },
        { text: '{hours: 6}', pos: 40 }, // v0 value → identical offsets
      ]),
    )
    expect(r).toEqual([{ from: 40, to: 50, kind: 'value' }])
  })
  it('an expression-like token stays plain — no range, no slop', () => {
    const r = computeAtomRanges(fakeDoc([{ text: 'x {sum(lo y', pos: 1 }]))
    expect(r).toEqual([])
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
