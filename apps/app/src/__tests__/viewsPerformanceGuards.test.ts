import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_VIEW_BUNDLE_BYTES,
  MAX_VIEW_SOURCE_BYTES,
  MAX_VIEW_SOURCE_FILES,
} from '../views/buildViewBundle'
import { buildViewShell } from '../views/viewShell'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VIEWS_BACKEND_SRC = readFileSync(
  resolve(__dirname, '../../convex/views.ts'),
  'utf8',
)
const VIEW_DATA_SRC = readFileSync(
  resolve(__dirname, '../../convex/viewData.ts'),
  'utf8',
)
const RUNTIME_HOST_SRC = readFileSync(
  resolve(__dirname, '../views/ViewRuntimeHost.tsx'),
  'utf8',
)

describe('folder views performance and safety guards', () => {
  it('keeps hard caps aligned across discovery, source, bundle, and SDK rows', () => {
    expect(VIEWS_BACKEND_SRC).toContain('const VIEW_LIST_CAP = 500')
    expect(VIEWS_BACKEND_SRC).toContain('const ATOM_SCAN_CAP = 5000')
    expect(VIEWS_BACKEND_SRC).toContain('const SOURCE_FILE_CAP = 100')
    expect(VIEWS_BACKEND_SRC).toContain('const SOURCE_BYTE_CAP = 512 * 1024')
    expect(VIEW_DATA_SRC).toContain('const RESULT_ROW_CAP = 500')
    expect(MAX_VIEW_SOURCE_FILES).toBe(100)
    expect(MAX_VIEW_SOURCE_BYTES).toBe(512 * 1024)
    expect(MAX_VIEW_BUNDLE_BYTES).toBe(1024 * 1024)
  })

  it('warns view authors toward batched SDK reads', () => {
    const shell = buildViewShell({ title: 'Perf' })
    expect(shell).toContain('more than 50 SDK calls in one frame')
    expect(shell).toContain('batch with fields.query or sources.list')
  })

  it('surfaces startup timeout and local audit events for reviewed actions', () => {
    expect(RUNTIME_HOST_SRC).toContain('This view did not start.')
    expect(RUNTIME_HOST_SRC).toContain("new CustomEvent('dohc:view-action'")
    expect(RUNTIME_HOST_SRC).toContain("case 'dohc.agent.run'")
    expect(RUNTIME_HOST_SRC).toContain("case 'dohc.patch.propose'")
    expect(RUNTIME_HOST_SRC).toContain('write-not-granted')
    expect(RUNTIME_HOST_SRC).toContain('canWriteRequestedPath')
  })
})
