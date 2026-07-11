import { Plugin, PluginKey } from '@tiptap/pm/state'
import { describe, it, expect } from 'vitest'
import {
  detectMentionAutocomplete,
  makeMentionPlugin,
  mentionPluginKey,
} from './mentionTrigger'
import type { PMNodeLike, PMDocLike } from './inlineAtomPlugin'

// @-mention trigger tests. Pure functions; no DOM. Mirrors
// wikilinkPlugin.test.ts's `detectAutocomplete` test conventions/helpers.
// Cursor position convention (matches wikilinkPlugin.test.ts): the doc
// root offset is 1, so `nodeStart + text.length` puts the cursor right
// after the full text (i.e. the whole string is "typed so far").

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

describe('detectMentionAutocomplete — @mention picker trigger', () => {
  it('opens right after typing "@" at the start of a block', () => {
    expect(detectMentionAutocomplete(makeDocWithParent('@x', paragraph()), 3)).toEqual({
      active: true,
      from: 1,
      query: 'x',
    })
  })

  it('opens for an incomplete mention after whitespace', () => {
    expect(detectMentionAutocomplete(makeDocWithParent('see @pla', paragraph()), 9)).toEqual({
      active: true,
      from: 5,
      query: 'pla',
    })
  })

  it('does not open mid-word (e.g. an email address)', () => {
    expect(
      detectMentionAutocomplete(makeDocWithParent('user@example', paragraph()), 13),
    ).toEqual({ active: false })
  })

  it('does not open when "@" is immediately preceded by other punctuation/text', () => {
    expect(detectMentionAutocomplete(makeDocWithParent('foo(@bar', paragraph()), 9)).toEqual({
      active: false,
    })
  })

  it('does not open inside fenced code blocks', () => {
    expect(detectMentionAutocomplete(makeDocWithParent('@nope', codeBlock()), 6)).toEqual({
      active: false,
    })
  })

  it('does not open inside inline code marks', () => {
    expect(
      detectMentionAutocomplete(
        makeDocWithParent('@nope', paragraph(), [{ type: { name: 'inlineCode' } }]),
        6,
      ),
    ).toEqual({ active: false })
  })

  it('reports an empty query for a bare trailing "@"', () => {
    expect(detectMentionAutocomplete(makeDocWithParent('hello @', paragraph()), 8)).toEqual({
      active: true,
      from: 7,
      query: '',
    })
  })

  it('closes once a space follows the query (no longer trailing at cursor)', () => {
    expect(detectMentionAutocomplete(makeDocWithParent('@foo bar', paragraph()), 9)).toEqual({
      active: false,
    })
  })

  it('makeMentionPlugin builds a ProseMirror plugin keyed by mentionPluginKey', () => {
    const plugin = makeMentionPlugin(() => {})
    expect(plugin).toBeInstanceOf(Plugin)
    expect(mentionPluginKey).toBeInstanceOf(PluginKey)
    expect(plugin.spec.key).toBe(mentionPluginKey)
  })
})
