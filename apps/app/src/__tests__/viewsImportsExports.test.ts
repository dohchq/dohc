import { describe, expect, it } from 'vitest'
import { createDohcClient } from '../views/virtualDohcSdk'

describe('views imports/exports integration', () => {
  it('exposes imports and exports through the same SDK bridge, not raw windows', async () => {
    const calls: Array<{ op: string; args: unknown }> = []
    const dohc = createDohcClient(async (op, args) => {
      calls.push({ op, args })
      return op === 'dohc.imports.list'
        ? { ok: true, rows: [{ kind: 'import', view: { billable: 12 } }] }
        : { ok: true, rows: [{ kind: 'export', grantees: ['ws_viewer'] }] }
    })

    await expect(dohc.imports.list()).resolves.toMatchObject({
      rows: [{ kind: 'import', view: { billable: 12 } }],
    })
    await expect(dohc.exports.list()).resolves.toMatchObject({
      rows: [{ kind: 'export', grantees: ['ws_viewer'] }],
    })
    expect(calls).toEqual([
      { op: 'dohc.imports.list', args: {} },
      { op: 'dohc.exports.list', args: {} },
    ])
  })

  it('only exposes read-side sharing helpers to views', () => {
    const dohc = createDohcClient(async () => ({ ok: true }))

    expect(Object.keys(dohc.imports)).toEqual(['list'])
    expect(Object.keys(dohc.exports)).toEqual(['list'])
    expect('grant' in dohc.exports).toBe(false)
    expect('revoke' in dohc.exports).toBe(false)
    expect('confirm' in dohc.exports).toBe(false)
  })
})
