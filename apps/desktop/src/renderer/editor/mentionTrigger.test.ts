import { Plugin, PluginKey } from '@tiptap/pm/state'
import { describe, it, expect } from 'vitest'
import {
  detectMentionAutocomplete,
  makeMentionPlugin,
  mentionPluginKey,
} from './mentionTrigger'
import { codeBlock, codeMarkText, doc, paragraph } from './testDocs'

// @-mention trigger tests over real ProseMirror documents (testDocs.ts).
// Cursor position convention (matches wikilinkPlugin.test.ts): a block's
// text starts at pos 1, so `1 + text.length` puts the cursor right after
// the full text (i.e. the whole string is "typed so far").

describe('detectMentionAutocomplete — @mention picker trigger', () => {
  it('opens right after typing "@" at the start of a block', () => {
    expect(detectMentionAutocomplete(doc(paragraph('@x')), 3)).toEqual({
      active: true,
      from: 1,
      query: 'x',
    })
  })

  it('opens for an incomplete mention after whitespace', () => {
    expect(detectMentionAutocomplete(doc(paragraph('see @pla')), 9)).toEqual({
      active: true,
      from: 5,
      query: 'pla',
    })
  })

  it('does not open mid-word (e.g. an email address)', () => {
    expect(detectMentionAutocomplete(doc(paragraph('user@example')), 13)).toEqual({
      active: false,
    })
  })

  it('does not open when "@" is immediately preceded by other punctuation/text', () => {
    expect(detectMentionAutocomplete(doc(paragraph('foo(@bar')), 9)).toEqual({
      active: false,
    })
  })

  it('does not open inside fenced code blocks', () => {
    expect(detectMentionAutocomplete(doc(codeBlock('@nope')), 6)).toEqual({
      active: false,
    })
  })

  it('does not open inside inline code marks', () => {
    expect(detectMentionAutocomplete(doc(paragraph(codeMarkText('@nope'))), 6)).toEqual({
      active: false,
    })
  })

  it('reports an empty query for a bare trailing "@"', () => {
    expect(detectMentionAutocomplete(doc(paragraph('hello @')), 8)).toEqual({
      active: true,
      from: 7,
      query: '',
    })
  })

  it('closes once a space follows the query (no longer trailing at cursor)', () => {
    expect(detectMentionAutocomplete(doc(paragraph('@foo bar')), 9)).toEqual({
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
