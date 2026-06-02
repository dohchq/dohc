import { describe, expect, it } from 'vitest'
import {
  buildViewBundle,
  MAX_VIEW_BUNDLE_BYTES,
  MAX_VIEW_SOURCE_BYTES,
  MAX_VIEW_SOURCE_FILES,
} from '../views/buildViewBundle.server'
import {
  canWriteRequestedPath,
  viewActionDetail,
  viewWorkspaceArgs,
  VIEW_ACTION_EVENT,
  VIEW_START_TIMEOUT_MS,
} from '../views/ViewRuntimeHost'
import { buildViewShell } from '../views/viewShell'

describe('folder views performance and safety guards', () => {
  it('enforces source file count and UTF-8 byte caps during bundling', async () => {
    const tooManyFiles = Array.from({ length: MAX_VIEW_SOURCE_FILES + 1 }, (_, i) => ({
      relativePath: `src/${i}.ts`,
      body: `export const value${i} = ${i}`,
    }))
    tooManyFiles.push({ relativePath: 'src/App.tsx', body: 'console.log(1)' })

    await expect(buildViewBundle({
      entry: 'src/App.tsx',
      files: tooManyFiles,
    })).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'too-many-files' }],
    })

    await expect(buildViewBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: '💥'.repeat(Math.floor(MAX_VIEW_SOURCE_BYTES / 4) + 1),
        },
      ],
    })).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'source-too-large' }],
    })
  })

  it('warns view authors toward batched SDK reads in the runtime shell', () => {
    const shell = buildViewShell({ title: 'Perf' })
    expect(shell).toContain('more than 50 SDK calls in one frame')
    expect(shell).toContain('batch with fields.query or sources.list')
  })

  it('keeps reviewed write actions scoped and locally auditable', () => {
    expect(canWriteRequestedPath('clients/acme', ['clients/acme/tasks.md'], 'tasks.md')).toBe(true)
    expect(canWriteRequestedPath('clients/acme', ['clients/acme/tasks.md'], '../other.md')).toBe(false)
    expect(canWriteRequestedPath('clients/acme', [], 'tasks.md')).toBe(false)

    expect(VIEW_ACTION_EVENT).toBe('dohc:view-action')
    expect(VIEW_START_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
    expect(viewActionDetail('.views/home', 'dohc.patch.propose', 'tasks.md')).toMatchObject({
      packageRoot: '.views/home',
      operation: 'dohc.patch.propose',
      target: 'tasks.md',
    })
  })

  it('omits personal workspace args instead of sending explicit undefined', () => {
    expect(viewWorkspaceArgs(undefined)).toEqual({})
    expect(viewWorkspaceArgs('ws_active')).toEqual({ activeWorkspaceId: 'ws_active' })
  })

  it('keeps the bundle output budget explicit for the runtime frame', () => {
    expect(MAX_VIEW_BUNDLE_BYTES).toBeGreaterThan(MAX_VIEW_SOURCE_BYTES)
  })
})
