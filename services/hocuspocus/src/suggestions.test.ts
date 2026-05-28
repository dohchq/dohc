import { describe, expect, it } from 'vitest'
import { markdownToYDoc, yDocToMarkdown } from './import-export.js'
import {
  applyAnchoredReplacement,
  createAnchorsForText,
} from './suggestions.js'

describe('Y.RelativePosition suggestions', () => {
  it('keeps anchors attached to intended text after inserts before the range', () => {
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const hello = createAnchorsForText(doc, 'Hello')
    const world = createAnchorsForText(doc, 'world')

    expect(hello).not.toBeNull()
    expect(world).not.toBeNull()

    expect(
      applyAnchoredReplacement(doc, {
        anchorStart: hello!.anchorStart,
        anchorEnd: hello!.anchorEnd,
        replacement: 'Hello brave',
        expectedText: 'Hello',
      }),
    ).toEqual({ ok: true })

    expect(
      applyAnchoredReplacement(doc, {
        anchorStart: world!.anchorStart,
        anchorEnd: world!.anchorEnd,
        replacement: 'earth',
        expectedText: 'world',
      }),
    ).toEqual({ ok: true })

    expect(yDocToMarkdown(doc)).toContain('Hello brave earth.')
  })

  it('returns stale-intent when the resolved text changed', () => {
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const world = createAnchorsForText(doc, 'world')
    expect(world).not.toBeNull()

    expect(
      applyAnchoredReplacement(doc, {
        anchorStart: world!.anchorStart,
        anchorEnd: world!.anchorEnd,
        replacement: 'planet',
        expectedText: 'world',
      }),
    ).toEqual({ ok: true })

    expect(
      applyAnchoredReplacement(doc, {
        anchorStart: world!.anchorStart,
        anchorEnd: world!.anchorEnd,
        replacement: 'earth',
        expectedText: 'world',
      }),
    ).toEqual({
      ok: false,
      reason: 'stale-intent',
      actualText: 'planet',
    })
  })

  it('returns needs-review when surrounding context still matches changed text', () => {
    const doc = markdownToYDoc('---\nid: atom_1\n---\nHello world.')
    const world = createAnchorsForText(doc, 'world')
    expect(world).not.toBeNull()

    expect(
      applyAnchoredReplacement(doc, {
        anchorStart: world!.anchorStart,
        anchorEnd: world!.anchorEnd,
        replacement: 'w0rld',
        expectedText: 'world',
      }),
    ).toEqual({ ok: true })

    expect(
      applyAnchoredReplacement(doc, {
        anchorStart: world!.anchorStart,
        anchorEnd: world!.anchorEnd,
        replacement: 'earth',
        expectedText: 'world',
        expectedPrefix: 'Hello ',
        expectedSuffix: '.',
      }),
    ).toEqual({
      ok: false,
      reason: 'needs-review',
      actualText: 'w0rld',
    })
  })
})
