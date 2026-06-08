import { beforeEach, describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useQuery } from 'convex/react'
import { getFunctionName } from 'convex/server'
import {
  buildCommandPaletteEntries,
  CommandPalette,
} from '../components/CommandPalette'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { firePaletteCommand, firePaletteSkill } from '../lib/palette-fire'

vi.mock('convex/react', () => ({ useQuery: vi.fn() }))
vi.mock('../lib/active-workspace', () => ({ useActiveWorkspaceId: vi.fn() }))

const useQueryMock = vi.mocked(useQuery as any)
const useActiveWorkspaceIdMock = vi.mocked(useActiveWorkspaceId)

const skills = [
  { path: '.skills/weekly-review.md', label: 'weekly-review' },
  { path: '.skills/invoice.md', label: 'invoice' },
]

const savedCommands = [
  { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
  { path: '.commands/log-hours.md', label: 'log-hours' },
]

beforeEach(() => {
  useQueryMock.mockReset()
  useActiveWorkspaceIdMock.mockReset()
})

function entries(log: string[] = []) {
  return buildCommandPaletteEntries({
    savedCommands,
    skills,
    views: [],
    onClose: () => log.push('close'),
    onFireCommand: (path) => log.push(`command:${path}`),
    onFireSkill: (path) => log.push(`skill:${path}`),
    onOpenView: (packageRoot) => log.push(`view:${packageRoot}`),
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

  it('app entries open rendered apps and edit source through normal atom paths', () => {
    const log: string[] = []
    const palette = buildCommandPaletteEntries({
      savedCommands: [],
      skills: [],
      views: [
        {
          packageRoot: 'clients/acme/.apps/overview',
          title: 'Overview',
          entryPath: 'clients/acme/.apps/overview/src/App.tsx',
          scopePath: 'clients/acme',
        },
      ],
      onClose: () => log.push('close'),
      onFireCommand: () => {},
      onFireSkill: () => {},
      onOpenView: (packageRoot) => log.push(`view:${packageRoot}`),
      onPromptAgent: () => {},
      onOpenAtom: (path) => log.push(`open:${path}`),
      onOpenSketch: () => {},
    })

    expect(palette.map(({ id, title, hint, kind }) => ({
      id,
      title,
      hint,
      kind,
    }))).toEqual([
      {
        id: 'app.clients/acme/.apps/overview',
        title: 'Open app: Overview',
        hint: 'app · clients/acme',
        kind: 'view',
      },
      {
        id: 'app-source.clients/acme/.apps/overview',
        title: 'Open app source: Overview',
        hint: 'app source · clients/acme/.apps/overview/src/App.tsx',
        kind: 'view',
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

    palette[0]?.run()
    palette[1]?.run()
    expect(log).toEqual([
      'close',
      'view:clients/acme/.apps/overview',
      'close',
      'open:clients/acme/.apps/overview/src/App.tsx',
    ])
  })
})

describe('CommandPalette workspace wiring', () => {
  it('skips workspace queries while the palette is closed', () => {
    const calls: { name: string; args: unknown }[] = []
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock.mockImplementation((ref: unknown, args: unknown) => {
      calls.push({ name: getFunctionName(ref as never), args })
      return undefined
    })

    const html = renderToStaticMarkup(
      createElement(CommandPalette, {
        open: false,
        onClose: () => {},
        onFireSkill: () => {},
        onFireCommand: () => {},
        onPromptAgent: () => {},
        onOpenAtom: () => {},
        onOpenView: () => {},
      }),
    )

    expect(html).toBe('')
    expect(calls).toEqual(
      expect.arrayContaining([
        { name: 'skills:list', args: 'skip' },
        { name: 'skills:listCommands', args: 'skip' },
        { name: 'apps:list', args: 'skip' },
      ]),
    )
  })

  it('queries skills and commands in the active workspace', () => {
    const calls: { name: string; args: unknown }[] = []
    useActiveWorkspaceIdMock.mockReturnValue('ws_active')
    useQueryMock.mockImplementation((ref: unknown, args: unknown) => {
      const name = getFunctionName(ref as never)
      const activeWorkspaceId =
        typeof args === 'object' && args !== null
          ? (args as { activeWorkspaceId?: unknown }).activeWorkspaceId
          : undefined
      calls.push({ name, args })
      if (activeWorkspaceId !== 'ws_active') return []
      if (name === 'skills:list') {
        return [{ path: '.skills/active.md', label: 'active-skill' }]
      }
      if (name === 'skills:listCommands') {
        return [{ path: '.commands/active.md', label: 'active-command' }]
      }
      if (name === 'apps:list') {
        return {
          apps: [
            {
              packageRoot: '.apps/home',
              title: 'Home',
              entryPath: '.apps/home/src/App.tsx',
              scopePath: '',
            },
          ],
          truncated: false,
        }
      }
      return { apps: [], truncated: false }
    })

    const html = renderToStaticMarkup(
      createElement(CommandPalette, {
        open: true,
        onClose: () => {},
        onFireSkill: () => {},
        onFireCommand: () => {},
        onPromptAgent: () => {},
        onOpenAtom: () => {},
        onOpenView: () => {},
      }),
    )

    expect(calls).toEqual(
      expect.arrayContaining([
        { name: 'skills:list', args: { activeWorkspaceId: 'ws_active' } },
        {
          name: 'skills:listCommands',
          args: { activeWorkspaceId: 'ws_active' },
        },
        { name: 'apps:list', args: { activeWorkspaceId: 'ws_active' } },
      ]),
    )
    expect(
      calls.every(
        (call) =>
          typeof call.args === 'object' &&
          call.args !== null &&
          (call.args as { activeWorkspaceId?: unknown }).activeWorkspaceId ===
            'ws_active',
      ),
    ).toBe(true)
    expect(html).toContain('active-command')
    expect(html).toContain('active-skill')
    expect(html).toContain('Open app: Home')
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
