import { Plugin, PluginKey } from '@tiptap/pm/state'
import { describe, it, expect } from 'vitest'
import {
  detectEmojiAutocomplete,
  detectCompleteEmojiShortcode,
  lookupEmoji,
  makeEmojiPlugin,
  emojiPluginKey,
} from './emojiTrigger'
import type { PMNodeLike, PMDocLike } from './inlineAtomPlugin'

// `:shortcode:` emoji trigger tests. Pure functions; no DOM. Mirrors
// mentionTrigger.test.ts's `detectMentionAutocomplete` test conventions
// and cursor-position convention (doc root offset is 1, so
// `nodeStart + text.length` puts the cursor right after the full text,
// i.e. the whole string is "typed so far").

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

describe('detectEmojiAutocomplete — :shortcode: picker trigger', () => {
  it('does NOT open after just one query character', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent(':s', paragraph()), 3)).toEqual({
      active: false,
    })
  })

  it('opens once the query reaches two characters (e.g. ":sm")', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent(':sm', paragraph()), 4)).toEqual({
      active: true,
      from: 1,
      query: 'sm',
    })
  })

  it('opens for an incomplete shortcode after whitespace', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent('see :smi', paragraph()), 9)).toEqual({
      active: true,
      from: 5,
      query: 'smi',
    })
  })

  it('does not open mid-word / mid-timestamp (e.g. "12:30")', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent('12:30', paragraph()), 6)).toEqual({
      active: false,
    })
  })

  it('does not open when ":" is preceded by other punctuation/text', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent('foo(:bar', paragraph()), 9)).toEqual({
      active: false,
    })
  })

  it('does not open inside fenced code blocks', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent(':nope', codeBlock()), 6)).toEqual({
      active: false,
    })
  })

  it('does not open inside inline code marks', () => {
    expect(
      detectEmojiAutocomplete(
        makeDocWithParent(':nope', paragraph(), [{ type: { name: 'inlineCode' } }]),
        6,
      ),
    ).toEqual({ active: false })
  })

  it('closes once a space follows the query (no longer trailing at cursor)', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent(':foo bar', paragraph()), 9)).toEqual({
      active: false,
    })
  })

  it('closes once the shortcode is closed with a second colon', () => {
    expect(detectEmojiAutocomplete(makeDocWithParent(':smile:', paragraph()), 8)).toEqual({
      active: false,
    })
  })

  it('makeEmojiPlugin builds a ProseMirror plugin keyed by emojiPluginKey', () => {
    const plugin = makeEmojiPlugin(() => {})
    expect(plugin).toBeInstanceOf(Plugin)
    expect(emojiPluginKey).toBeInstanceOf(PluginKey)
    expect(plugin.spec.key).toBe(emojiPluginKey)
  })
})

describe('detectCompleteEmojiShortcode — immediate-insert trigger', () => {
  it('detects a just-closed shortcode at the cursor', () => {
    expect(detectCompleteEmojiShortcode(makeDocWithParent(':smile:', paragraph()), 8)).toEqual({
      from: 1,
      to: 8,
      shortcode: 'smile',
    })
  })

  it('detects a just-closed shortcode after whitespace', () => {
    // "nice :fire: today" — nodeStart is 1 (doc root offset convention),
    // so the ":" at text index 5 sits at absolute pos 6, and the cursor
    // right after the closing ":" (text index 11) sits at absolute pos 12.
    expect(
      detectCompleteEmojiShortcode(makeDocWithParent('nice :fire: today', paragraph()), 12),
    ).toEqual({ from: 6, to: 12, shortcode: 'fire' })
  })

  it('returns null while the shortcode is still open (no closing colon yet)', () => {
    expect(detectCompleteEmojiShortcode(makeDocWithParent(':smile', paragraph()), 7)).toBeNull()
  })

  it('returns null for a single-character shortcode (below the 2-char minimum)', () => {
    expect(detectCompleteEmojiShortcode(makeDocWithParent(':s:', paragraph()), 4)).toBeNull()
  })

  it('returns null inside fenced code blocks', () => {
    expect(
      detectCompleteEmojiShortcode(makeDocWithParent(':smile:', codeBlock()), 8),
    ).toBeNull()
  })
})

describe('lookupEmoji — shortcode -> entry resolution', () => {
  it('resolves a known shortcode to its emoji character', () => {
    expect(lookupEmoji('smile')?.emoji).toBe('😄')
    expect(lookupEmoji('fire')?.emoji).toBe('🔥')
    expect(lookupEmoji('thumbsup')?.emoji).toBe('👍')
  })

  it('returns undefined for an unknown shortcode', () => {
    expect(lookupEmoji('definitely_not_a_real_shortcode')).toBeUndefined()
  })
})
