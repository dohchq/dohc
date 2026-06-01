import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDohcClient } from '../views/virtualDohcSdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME_HOST_SRC = readFileSync(
  resolve(__dirname, '../views/ViewRuntimeHost.tsx'),
  'utf8',
)
const VIEW_DATA_TEST_SRC = readFileSync(
  resolve(__dirname, '../../convex/viewData.test.ts'),
  'utf8',
)
const SHARING_PANEL_SRC = readFileSync(
  resolve(__dirname, '../components/SharingPanel.tsx'),
  'utf8',
)

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

  it('routes view sharing reads through viewData and preserves consent tests', () => {
    expect(RUNTIME_HOST_SRC).toContain('api.viewData.listImports')
    expect(RUNTIME_HOST_SRC).toContain('api.viewData.listExports')
    expect(VIEW_DATA_TEST_SRC).toContain('confirmWithheldFor')
    expect(VIEW_DATA_TEST_SRC).toContain('removes revoked imports')
  })

  it('keeps the existing Imports / Exports panel as the canonical consent UI', () => {
    expect(SHARING_PANEL_SRC).toContain('api.windows.consentOverview')
    expect(SHARING_PANEL_SRC).toContain('Export these')
    expect(SHARING_PANEL_SRC).toContain('keep private')
    expect(SHARING_PANEL_SRC).toContain('Preview import')
  })
})
