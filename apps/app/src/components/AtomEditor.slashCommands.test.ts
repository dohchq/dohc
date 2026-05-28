// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  findSlashCommandMatch,
} from './AtomEditor'
import { resolveFloatingMenuPosition } from './floatingMenuPosition'

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

  it('positions the slash menu above the cursor near the viewport bottom', () => {
    const position = resolveFloatingMenuPosition({
      cursorRect: { left: 520, top: 728, bottom: 752 },
      viewportWidth: 1280,
      viewportHeight: 800,
    })

    expect(position.placement).toBe('above')
    expect(position.y).toBeGreaterThanOrEqual(12)
    expect(position.y + position.maxHeight).toBeLessThanOrEqual(722)
    expect(position.maxHeight).toBeLessThanOrEqual(320)
  })

  it('keeps the slash menu inside the horizontal viewport', () => {
    const position = resolveFloatingMenuPosition({
      cursorRect: { left: 1260, top: 120, bottom: 144 },
      viewportWidth: 1280,
      viewportHeight: 900,
    })

    expect(position.x).toBeLessThanOrEqual(948)
    expect(position.x).toBeGreaterThanOrEqual(12)
  })
})
