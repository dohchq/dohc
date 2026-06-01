import { describe, expect, it } from 'vitest'
import { createDohcClient, VIRTUAL_DOHC_SDK } from './virtualDohcSdk'

describe('virtual @dohc/view SDK', () => {
  it('maps framework-neutral SDK calls to bridge operations', async () => {
    const calls: Array<{ op: string; args: unknown }> = []
    const dohc = createDohcClient(async (op, args) => {
      calls.push({ op, args })
      return { ok: true }
    })

    await dohc.sources.list({ source: '.' })
    await dohc.atom.get({ path: 'tasks.md' })
    await dohc.fields.query({ keys: ['status'] })
    await dohc.imports.list()
    await dohc.exports.list()
    await dohc.source.open({ path: 'tasks.md' })
    await dohc.agent.run({ prompt: 'Draft update.', sources: ['tasks.md'] })
    await dohc.patch.propose({
      path: 'tasks.md',
      summary: 'Mark done',
      patch: { kind: 'frontmatter', set: { status: 'done' } },
    })

    expect(calls).toEqual([
      { op: 'dohc.sources.list', args: { source: '.' } },
      { op: 'dohc.atom.get', args: { path: 'tasks.md' } },
      { op: 'dohc.fields.query', args: { keys: ['status'] } },
      { op: 'dohc.imports.list', args: {} },
      { op: 'dohc.exports.list', args: {} },
      { op: 'dohc.source.open', args: { path: 'tasks.md' } },
      { op: 'dohc.agent.run', args: { prompt: 'Draft update.', sources: ['tasks.md'] } },
      {
        op: 'dohc.patch.propose',
        args: {
          path: 'tasks.md',
          summary: 'Mark done',
          patch: { kind: 'frontmatter', set: { status: 'done' } },
        },
      },
    ])
  })

  it('preserves concurrent responses by returning each bridge promise', async () => {
    const dohc = createDohcClient((op, args) =>
      Promise.resolve({ op, args }),
    )

    await expect(Promise.all([
      dohc.atom.get({ path: 'a.md' }),
      dohc.atom.get({ path: 'b.md' }),
    ])).resolves.toEqual([
      { op: 'dohc.atom.get', args: { path: 'a.md' } },
      { op: 'dohc.atom.get', args: { path: 'b.md' } },
    ])
  })

  it('lets bridge errors become normal Error objects', async () => {
    const dohc = createDohcClient(async () => {
      throw new Error('Nope.')
    })

    await expect(dohc.sources.list()).rejects.toThrow('Nope.')
  })

  it('ships a React-friendly virtual module source', () => {
    expect(VIRTUAL_DOHC_SDK).toContain('export const dohc')
    expect(VIRTUAL_DOHC_SDK).toContain('useDohcQuery')
    expect(VIRTUAL_DOHC_SDK).toContain('window.dohc')
  })
})
