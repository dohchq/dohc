import { describe, it, expect } from 'vitest'
import { buildCommandPaletteEntries } from '../components/CommandPalette'
import { firePaletteCommand, firePaletteSkill } from '../lib/palette-fire'

const skills = [
  { path: '.skills/weekly-review.md', label: 'weekly-review' },
  { path: '.skills/invoice.md', label: 'invoice' },
]

const savedCommands = [
  { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
  { path: '.commands/log-hours.md', label: 'log-hours' },
]

function entries(log: string[] = []) {
  return buildCommandPaletteEntries({
    savedCommands,
    skills,
    onClose: () => log.push('close'),
    onFireCommand: (path) => log.push(`command:${path}`),
    onFireSkill: (path) => log.push(`skill:${path}`),
    onOpenSketch: () => log.push('sketch'),
  })
}

describe('CommandPalette entry behavior', () => {
  it('builds command entries before skills with stable ids, hints, and kinds', () => {
    expect(entries().map(({ id, title, hint, kind }) => ({
      id,
      title,
      hint,
      kind,
    }))).toEqual([
      {
        id: 'command..commands/draft-invoice.md',
        title: 'draft-invoice',
        hint: 'command · .commands/draft-invoice.md',
        kind: 'command',
      },
      {
        id: 'command..commands/log-hours.md',
        title: 'log-hours',
        hint: 'command · .commands/log-hours.md',
        kind: 'command',
      },
      {
        id: 'skill..skills/weekly-review.md',
        title: 'weekly-review',
        hint: 'skill · .skills/weekly-review.md',
        kind: 'skill',
      },
      {
        id: 'skill..skills/invoice.md',
        title: 'invoice',
        hint: 'skill · .skills/invoice.md',
        kind: 'skill',
      },
      {
        id: 'sys.insert-ascii-sketch',
        title: 'Insert ASCII sketch',
        hint: 'editor · ⌘⇧D',
        kind: undefined,
      },
    ])
  })

  it('command rows close the palette before firing the command channel', () => {
    const log: string[] = []
    entries(log).find((entry) => entry.id === 'command..commands/draft-invoice.md')?.run()
    expect(log).toEqual(['close', 'command:.commands/draft-invoice.md'])
  })

  it('skill rows close the palette before firing the skill channel', () => {
    const log: string[] = []
    entries(log).find((entry) => entry.id === 'skill..skills/invoice.md')?.run()
    expect(log).toEqual(['close', 'skill:.skills/invoice.md'])
  })

  it('system sketch entry closes the palette before dispatching the sketch action', () => {
    const log: string[] = []
    entries(log).find((entry) => entry.id === 'sys.insert-ascii-sketch')?.run()
    expect(log).toEqual(['close', 'sketch'])
  })
})

describe('palette fire route helpers', () => {
  it('skill fire opens chat, closes imports/exports, and stores pending skill path', () => {
    const log: string[] = []
    firePaletteSkill('.skills/invoice.md', {
      setChatOpen: (open) => log.push(`chat:${open}`),
      setSharingOpen: (open) => log.push(`sharing:${open}`),
      setPendingSkillFire: (path) => log.push(`skill:${path}`),
    })
    expect(log).toEqual([
      'chat:true',
      'sharing:false',
      'skill:.skills/invoice.md',
    ])
  })

  it('command fire opens chat, closes imports/exports, and stores pending command path', () => {
    const log: string[] = []
    firePaletteCommand('.commands/draft-invoice.md', {
      setChatOpen: (open) => log.push(`chat:${open}`),
      setSharingOpen: (open) => log.push(`sharing:${open}`),
      setPendingCommandFire: (path) => log.push(`command:${path}`),
    })
    expect(log).toEqual([
      'chat:true',
      'sharing:false',
      'command:.commands/draft-invoice.md',
    ])
  })
})
