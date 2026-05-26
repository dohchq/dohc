import { describe, it, expect } from 'vitest'
import { computeWikilinkRanges, detectAutocomplete } from './wikilinkPlugin'
import type { PMDocLike, PMNodeLike } from './inlineAtomPlugin'

// D4.8 — wikilink decoration regex tests. Pure function; no DOM.

function textNode(text: string): PMNodeLike {
  return {
    isText: true,
    text,
    marks: [],
    type: { name: 'text' },
  }
}

function paragraph(): PMNodeLike {
  return {
    type: { name: 'paragraph' },
  }
}

function codeBlock(): PMNodeLike {
  return {
    type: { name: 'code_block', spec: { code: true } },
  }
}

/** Build a minimal PMDocLike that walks the given text-and-position
 *  pairs in order. Position is the running offset; each text node
 *  contributes text.length to the offset. */
function makeDoc(nodes: Array<{ text: string; isCode?: boolean }>): PMDocLike {
  return {
    descendants(cb) {
      let pos = 1 // PM doc starts at position 1 inside the root.
      for (const n of nodes) {
        const node: PMNodeLike = {
          isText: true,
          text: n.text,
          marks: n.isCode
            ? [{ type: { name: 'inlineCode' } }]
            : [],
          type: { name: 'text' },
        }
        cb(node, pos, null)
        pos += n.text.length
      }
    },
  }
}

function makeDocWithParent(
  text: string,
  parent: PMNodeLike | null,
  marks: PMNodeLike['marks'] = [],
): PMDocLike {
  return {
    descendants(cb) {
      cb(
        {
          isText: true,
          text,
          marks,
          type: { name: 'text' },
        },
        1,
        parent,
      )
    },
  }
}

describe('computeWikilinkRanges — wikilink decoration scanner', () => {
  it('finds bare [[path]] in plain text', () => {
    const doc = makeDoc([{ text: 'see [[playground/a]] here' }])
    const r = computeWikilinkRanges(doc)
    expect(r).toHaveLength(1)
    expect(r[0]?.target).toBe('playground/a')
  })

  it('finds Tiptap-escaped \\[\\[path]] form', () => {
    const doc = makeDoc([{ text: 'see \\[\\[playground/a]] here' }])
    const r = computeWikilinkRanges(doc)
    expect(r).toHaveLength(1)
    expect(r[0]?.target).toBe('playground/a')
  })

  it('strips the .md suffix from the resolved target', () => {
    const doc = makeDoc([{ text: '[[notes/a.md]]' }])
    const r = computeWikilinkRanges(doc)
    expect(r[0]?.target).toBe('notes/a')
  })

  it('finds multiple wikilinks in one text node', () => {
    const doc = makeDoc([
      { text: 'see [[a]] and \\[\\[b]] and [[c/d]]' },
    ])
    const r = computeWikilinkRanges(doc)
    expect(r.map((x) => x.target)).toEqual(['a', 'b', 'c/d'])
  })

  it('skips text inside inline-code marks', () => {
    const doc = makeDoc([{ text: '[[no]]', isCode: true }])
    expect(computeWikilinkRanges(doc)).toHaveLength(0)
  })

  it('returns absolute doc offsets that span the entire `[[...]]` (including escapes)', () => {
    // 'x \[\[a]] y' — the wikilink occupies positions 2..9 within
    // the text (length 7). pos starts at 1 (doc root offset).
    const doc = makeDoc([{ text: 'x \\[\\[a]] y' }])
    const r = computeWikilinkRanges(doc)
    expect(r).toHaveLength(1)
    expect(r[0]?.to! - r[0]?.from!).toBe('\\[\\[a]]'.length)
  })

  it('ignores partial matches (a single bracket, etc.)', () => {
    const doc = makeDoc([{ text: '[notlink] [a[ ]]b' }])
    expect(computeWikilinkRanges(doc)).toHaveLength(0)
  })

  it('does not match across newlines (paths are single-segment-ish)', () => {
    const doc = makeDoc([{ text: '[[a\nb]]' }])
    expect(computeWikilinkRanges(doc)).toHaveLength(0)
  })
})

describe('detectAutocomplete — wikilink picker trigger', () => {
  it('opens for an incomplete wikilink in plain text', () => {
    expect(detectAutocomplete(makeDocWithParent('see [[pla', paragraph()), 10)).toEqual({
      active: true,
      from: 5,
      query: 'pla',
    })
  })

  it('does not open inside fenced code blocks', () => {
    expect(detectAutocomplete(makeDocWithParent('[[nope', codeBlock()), 7)).toEqual({
      active: false,
    })
  })

  it('does not open inside inline code marks', () => {
    expect(
      detectAutocomplete(
        makeDocWithParent('[[nope', paragraph(), [
          { type: { name: 'inlineCode' } },
        ]),
        7,
      ),
    ).toEqual({ active: false })
  })
})
