// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  findSlashCommandMatch,
} from './AtomEditor'

describe('AtomEditor slash commands', () => {
  it('restores the core Notion-style command set', () => {
    expect(filterSlashCommands('').map((command) => command.id)).toEqual([
      'ascii-sketch',
      'wikilink',
      'heading-1',
      'heading-2',
      'heading-3',
      'bulleted-list',
      'numbered-list',
      'quote',
      'code-block',
      'divider',
      'table',
      'query-block',
    ])
  })

  it('filters commands by labels and aliases', () => {
    expect(filterSlashCommands('sketch').map((command) => command.id)).toEqual([
      'ascii-sketch',
    ])
    expect(filterSlashCommands('table').map((command) => command.id)).toEqual([
      'table',
    ])
    expect(filterSlashCommands('wiki').map((command) => command.id)).toEqual([
      'wikilink',
    ])
  })

  it('detects slash triggers at the tail of the current text block', () => {
    expect(findSlashCommandMatch('/as')).toEqual({ slashOffset: 0, query: 'as' })
    expect(findSlashCommandMatch('hello /link')).toEqual({
      slashOffset: 6,
      query: 'link',
    })
    expect(findSlashCommandMatch('hello /link now')).toBeNull()
  })
})
