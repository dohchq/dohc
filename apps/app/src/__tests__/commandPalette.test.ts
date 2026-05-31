import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCommandPaletteEntries } from '../components/CommandPalette'
import { firePaletteCommand, firePaletteSkill } from '../lib/palette-fire'

const __dirname = dirname(fileURLToPath(import.meta.url))
const COMMAND_PALETTE_SRC = readFileSync(
  resolve(__dirname, '../components/CommandPalette.tsx'),
  'utf8',
)

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
    onPromptAgent: (prompt) => log.push(`prompt:${prompt}`),
    onOpenAtom: (path) => log.push(`open:${path}`),
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
        kind: 'system',
      },
      {
        id: 'sys.create-skill',
        title: 'Create reusable skill',
        hint: 'agent · save a process',
        kind: 'system',
      },
      {
        id: 'sys.create-command',
        title: 'Create slash command',
        hint: 'agent · save a shortcut',
        kind: 'system',
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

  it('skill and command creation entries route through agent prompts', () => {
    const log: string[] = []
    entries(log).find((entry) => entry.id === 'sys.create-skill')?.run()
    entries(log).find((entry) => entry.id === 'sys.create-command')?.run()
    expect(log).toEqual([
      'close',
      expect.stringContaining('prompt:Help me turn'),
      'close',
      expect.stringContaining('prompt:Help me create'),
    ])
  })

  it('saved command and skill entries expose their editable atom path', () => {
    expect(
      entries()
        .filter((entry) => entry.kind === 'command' || entry.kind === 'skill')
        .map(({ editPath }) => editPath),
    ).toEqual([
      '.commands/draft-invoice.md',
      '.commands/log-hours.md',
      '.skills/weekly-review.md',
      '.skills/invoice.md',
    ])
  })

  it('saved command and skill edit actions close the palette and open the source atom', () => {
    const log: string[] = []
    entries(log).find((entry) => entry.id === 'skill..skills/invoice.md')?.edit?.()
    expect(log).toEqual(['close', 'open:.skills/invoice.md'])
  })
})

describe('CommandPalette workspace wiring', () => {
  it('queries skills and commands in the active workspace', () => {
    expect(COMMAND_PALETTE_SRC).toMatch(/useActiveWorkspaceId/)
    expect(COMMAND_PALETTE_SRC).toMatch(
      /api\.skills\.list,\s*\{\s*activeWorkspaceId\s*\}/,
    )
    expect(COMMAND_PALETTE_SRC).toMatch(
      /api\.skills\.listCommands,\s*\{\s*activeWorkspaceId\s*\}/,
    )
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
