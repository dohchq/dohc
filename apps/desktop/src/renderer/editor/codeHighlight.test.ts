import { describe, expect, it } from 'vitest'
import { Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import { getDohcProseMirrorSchema } from './import-export'
import { codeBlock, doc, paragraph } from './testDocs'
import {
  codeHighlightKey,
  computeCodeHighlightRanges,
  highlightSpans,
  makeCodeHighlightPlugin,
} from './codeHighlight'

// --- pure `highlightSpans` (no ProseMirror/jsdom involved) ---

describe('highlightSpans', () => {
  it('tokenizes a TypeScript snippet into keyword and string spans', () => {
    const spans = highlightSpans('typescript', 'const greeting = "hi";')
    const classNames = spans.map((s) => s.className)
    expect(classNames).toContain('hljs-keyword')
    expect(classNames).toContain('hljs-string')

    const keyword = spans.find((s) => s.className === 'hljs-keyword')!
    expect('const greeting = "hi";'.slice(keyword.start, keyword.end)).toBe('const')

    const string = spans.find((s) => s.className === 'hljs-string')!
    expect('const greeting = "hi";'.slice(string.start, string.end)).toBe('"hi"')
  })

  it('returns no spans for an unregistered/empty language', () => {
    expect(highlightSpans('', 'const x = 1;')).toEqual([])
    expect(highlightSpans('plain', 'const x = 1;')).toEqual([])
    expect(highlightSpans('not-a-real-language', 'const x = 1;')).toEqual([])
  })

  it('returns no spans for empty text', () => {
    expect(highlightSpans('typescript', '')).toEqual([])
  })

  it('maps tsx/jsx onto the typescript/javascript grammars', () => {
    const tsx = highlightSpans('tsx', 'const x = 1;')
    const jsx = highlightSpans('jsx', 'const x = 1;')
    expect(tsx.map((s) => s.className)).toContain('hljs-keyword')
    expect(jsx.map((s) => s.className)).toContain('hljs-keyword')
  })
})

// --- pure `computeCodeHighlightRanges` over real documents (testDocs.ts) ---

describe('computeCodeHighlightRanges', () => {
  it('maps highlight spans into absolute doc coordinates (content starts at pos + 1)', () => {
    // paragraph("ab") is nodeSize 4, so the code block sits at pos 4.
    const d = doc(paragraph('ab'), codeBlock('const x = 1;', 'typescript'))
    const ranges = computeCodeHighlightRanges(d, new WeakMap())
    expect(ranges.length).toBeGreaterThan(0)
    const keyword = ranges.find((r) => r.className === 'hljs-keyword')!
    // blockStart = pos + 1 = 5; "const" is the first 5 chars of the text.
    expect(keyword.from).toBe(5)
    expect(keyword.to).toBe(10)
  })

  it('produces no ranges for a plain-text block', () => {
    const d = doc(codeBlock('const x = 1;'))
    expect(computeCodeHighlightRanges(d, new WeakMap())).toEqual([])
  })

  it('produces no ranges for an unrecognized language', () => {
    const d = doc(codeBlock('DISPLAY "hi".', 'cobol'))
    expect(computeCodeHighlightRanges(d, new WeakMap())).toEqual([])
  })

  it('skips blocks over the 20k-char guard', () => {
    const hugeText = `const x = 1; ${'a'.repeat(20_000)}`
    expect(hugeText.length).toBeGreaterThan(20_000)
    const d = doc(codeBlock(hugeText, 'typescript'))
    expect(computeCodeHighlightRanges(d, new WeakMap())).toEqual([])
  })

  it('reuses cached spans for the same node object (only recomputes on identity change)', () => {
    const d = doc(codeBlock('const x = 1;', 'typescript'))
    const block = d.child(0)
    const cache = new WeakMap<PMNode, ReturnType<typeof highlightSpans>>()

    computeCodeHighlightRanges(d, cache)
    const cachedAfterFirstRun = cache.get(block)
    expect(cachedAfterFirstRun).toBeDefined()

    computeCodeHighlightRanges(d, cache)
    // Same node object -> same cached array reference, i.e. not recomputed.
    expect(cache.get(block)).toBe(cachedAfterFirstRun)
  })

  it('recomputes when the node identity changes (e.g. a language-attr edit)', () => {
    const cache = new WeakMap<PMNode, ReturnType<typeof highlightSpans>>()
    const first = doc(codeBlock('const x = 1;', 'typescript'))
    computeCodeHighlightRanges(first, cache)

    // A new node object (as ProseMirror produces on setNodeMarkup) with a
    // different language over the same text.
    const second = doc(codeBlock('const x = 1;', 'python'))
    const ranges = computeCodeHighlightRanges(second, cache)
    // "const" isn't a Python keyword, but "x" as a bare identifier and the
    // block itself should differ from the TS run — assert the language
    // actually changed the tokenization rather than reusing the ts cache.
    expect(ranges.map((r) => r.className)).not.toContain('hljs-keyword')
  })
})

// --- integration: real ProseMirror EditorState + schema, mirroring the
// setNodeMarkup transaction shape codeBlockChrome.tsx's language <select>
// dispatches on change ---

function stateWithCodeBlock(language: string, text: string): EditorState {
  const schema = getDohcProseMirrorSchema()
  const doc = PMNode.fromJSON(schema, {
    type: 'doc',
    content: [
      {
        type: 'codeBlock',
        attrs: { language },
        content: text.length > 0 ? [{ type: 'text', text }] : [],
      },
    ],
  })
  return EditorState.create({ doc, plugins: [makeCodeHighlightPlugin()] })
}

// `Decoration.inline(from, to, attrs)` renders `attrs` straight into the DOM
// but does not expose it back through the public `.spec` getter (`.spec` is
// a separate, unset 4th constructor argument) — so decoration content isn't
// introspectable from outside ProseMirror/view internals. `highlightSpans`
// already covers class-name correctness (above); these plugin-level checks
// instead confirm *presence* of decorations at the doc-coordinate ranges
// `highlightSpans` says should be highlighted, i.e. that the real plugin
// wiring (schema, node walk, blockStart math, caching) matches the pure
// range math.
function decorationCount(state: EditorState, from = 0, to = state.doc.content.size): number {
  const decorations = codeHighlightKey.getState(state) as DecorationSet
  return decorations.find(from, to).length
}

describe('makeCodeHighlightPlugin', () => {
  const TEXT = 'const greeting = "hi";'
  // blockPos 0 -> blockStart = 1 (content starts right after the node's own
  // open token), matching computeCodeHighlightRanges' `pos + 1` convention.
  const BLOCK_START = 1
  const expectedSpans = highlightSpans('typescript', TEXT)

  it('decorates a typescript code block with keyword/string spans', () => {
    const state = stateWithCodeBlock('typescript', TEXT)
    expect(expectedSpans.map((s) => s.className)).toEqual(
      expect.arrayContaining(['hljs-keyword', 'hljs-string']),
    )
    for (const span of expectedSpans) {
      expect(decorationCount(state, BLOCK_START + span.start, BLOCK_START + span.end)).toBeGreaterThan(0)
    }
  })

  it('does not decorate a plain-text code block', () => {
    const state = stateWithCodeBlock('', TEXT)
    expect(decorationCount(state)).toBe(0)
  })

  it('updates decorations when the language attribute changes via setNodeMarkup', () => {
    const state = stateWithCodeBlock('typescript', TEXT)
    expect(decorationCount(state)).toBeGreaterThan(0)

    // Same transaction shape as codeBlockChrome.tsx's language <select> commit().
    const blockPos = 0
    const current = state.doc.nodeAt(blockPos)!
    const tr = state.tr.setNodeMarkup(blockPos, undefined, {
      ...current.attrs,
      language: '',
    })
    const nextState = state.apply(tr)

    expect(decorationCount(nextState)).toBe(0)
  })

  it('skips a code block over the 20k-char guard', () => {
    const hugeText = `const x = 1; ${'a'.repeat(20_000)}`
    const state = stateWithCodeBlock('typescript', hugeText)
    expect(decorationCount(state)).toBe(0)
  })
})
